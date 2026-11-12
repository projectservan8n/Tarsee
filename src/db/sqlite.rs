//! Port of `src/db/sqlite.js`: opening the database and its schema migrations.
//!
//! The migration names and SQL are the Node version's, statement for statement, so a database made by either
//! version opens in the other.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use rusqlite::Connection;

use super::usage_schema::USAGE_SCHEMA;

/// Opens the database file (creating its folder first), tunes it and runs the migrations: `initDb(dbPath)`.
pub fn init_db(db_path: &Path) -> anyhow::Result<Connection> {
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(db_path)?;

    // Performance tuning for production use.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = -8000;
         PRAGMA foreign_keys = ON;",
    )?;
    conn.busy_timeout(Duration::from_millis(5000))?;

    migrate(&conn, None)?;
    Ok(conn)
}

/// A schema change: plain SQL, or a function for what plain SQL cannot guard (a column added only when missing).
enum Step {
    Sql(&'static str),
    Up(fn(&Connection) -> anyhow::Result<()>),
}

struct Migration {
    name: &'static str,
    step: Step,
}

/// Applies every migration not yet recorded in the migrations table, in order. `through` stops after the named
/// migration (tests use it to build a database the way an older install has it).
pub fn migrate(conn: &Connection, through: Option<&str>) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (
           id INTEGER PRIMARY KEY,
           name TEXT NOT NULL UNIQUE,
           applied_at TEXT NOT NULL DEFAULT (datetime('now'))
         )",
    )?;

    let applied: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("SELECT name FROM migrations")?;
        stmt.query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<_, _>>()?
    };

    for m in MIGRATIONS {
        if !applied.contains(m.name) {
            let tx = conn.unchecked_transaction()?;
            match &m.step {
                Step::Sql(sql) => tx.execute_batch(sql)?,
                Step::Up(up) => up(&tx)?,
            }
            tx.execute("INSERT INTO migrations (name) VALUES (?)", [m.name])?;
            tx.commit()?;
            log::info!("[db] applied migration: {}", m.name);
        }
        if through == Some(m.name) {
            break;
        }
    }
    Ok(())
}

/// The names of every migration, in the order they run.
pub fn migration_names() -> Vec<&'static str> {
    MIGRATIONS.iter().map(|m| m.name).collect()
}

static IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap());
/// A column type with optional constraints and a plain default: "TEXT", "REAL NOT NULL DEFAULT 0", "TEXT DEFAULT 'x'".
static COLUMN_DDL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_ ().,'-]*$").unwrap());

fn quoted(text: &str) -> String {
    serde_json::Value::String(text.to_string()).to_string()
}

/// Adds a column to a table unless it is already there, so a migration that adds columns can run on any database
/// (fresh, upgraded, made some other way) and run twice. SQLite has no ADD COLUMN IF NOT EXISTS; this asks
/// `pragma_table_info` first. The names go into the ALTER as text, so only plain identifiers are accepted.
///
/// Returns true if the column was added, false if it was already there.
pub fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> anyhow::Result<bool> {
    if !IDENTIFIER.is_match(table) {
        anyhow::bail!("ensureColumn: not a table name: {}", quoted(table));
    }
    if !IDENTIFIER.is_match(column) {
        anyhow::bail!("ensureColumn: not a column name: {}", quoted(column));
    }
    if !COLUMN_DDL.is_match(ddl) || ddl.contains("--") || ddl.contains(';') {
        anyhow::bail!("ensureColumn: not a column type (ddl): {}", quoted(ddl));
    }
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?)")?;
        stmt.query_map([table], |row| row.get::<_, String>(0))?
            .collect::<Result<_, _>>()?
    };
    if existing.is_empty() {
        anyhow::bail!("ensureColumn: no table named {table}");
    }
    if existing.iter().any(|c| c.eq_ignore_ascii_case(column)) {
        return Ok(false);
    }
    conn.execute_batch(&format!("ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {ddl}"))?;
    Ok(true)
}

/// The columns migration 012 adds to the usage tables (`lib/token_usage.rs`), design 4.13:
///   provider  the provider that ran the call or turn (claude-code, anthropic, openrouter, ...); null on rows from
///             before 012 (all Claude plan)
///   engine    the agent engine that ran it (claude-code or codex)
///   cost_usd  what it cost in US dollars, exact or estimated; null when unknown or included in a plan
///   cost_exact (turns only) the turn's cost_usd is the provider's own figure (an Anthropic key's total,
///             OpenRouter's usage.cost)
pub const USAGE_COLUMNS: &[(&str, &[(&str, &str)])] = &[
    (
        "usage_calls",
        &[("provider", "TEXT"), ("engine", "TEXT"), ("cost_usd", "REAL")],
    ),
    (
        "usage_turns",
        &[
            ("provider", "TEXT"),
            ("engine", "TEXT"),
            ("cost_usd", "REAL"),
            ("cost_exact", "INTEGER"),
        ],
    ),
];

/// Adds [`USAGE_COLUMNS`] to the usage tables where they are missing. Run by migration 012 and by the usage index
/// right after it re-runs the usage schema, so a fresh database, an upgraded one and one made some other way (a
/// test) all have them.
pub fn ensure_usage_columns(conn: &Connection) -> anyhow::Result<()> {
    for (table, columns) in USAGE_COLUMNS {
        for (column, ddl) in *columns {
            ensure_column(conn, table, column, ddl)?;
        }
    }
    Ok(())
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        name: "001_initial",
        step: Step::Sql(
            "
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New conversation',
        provider TEXT,
        model TEXT,
        system_prompt TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        tokens_in INTEGER,
        tokens_out INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE voice_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        data BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      );
    ",
        ),
    },
    Migration {
        name: "002_audit_log",
        step: Step::Sql(
            "
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        target TEXT,
        actor TEXT NOT NULL DEFAULT 'system',
        ip TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
      CREATE INDEX idx_audit_log_action ON audit_log(action);
      CREATE INDEX idx_audit_log_target ON audit_log(target);
    ",
        ),
    },
    Migration {
        name: "003_bot_memory",
        step: Step::Sql(
            "
      CREATE TABLE bot_memory (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL DEFAULT 'preference',
        content TEXT NOT NULL,
        source_conversation_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_bot_memory_category ON bot_memory(category);
      CREATE INDEX idx_bot_memory_created ON bot_memory(created_at DESC);
    ",
        ),
    },
    Migration {
        name: "004_vector_memory",
        step: Step::Sql(
            "
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        embedding BLOB NOT NULL,
        provider TEXT NOT NULL DEFAULT 'unknown',
        model TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (memory_id) REFERENCES bot_memory(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_memory ON memory_vectors(memory_id);
      CREATE TABLE IF NOT EXISTS embedding_cache (
        hash TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    ",
        ),
    },
    Migration {
        name: "005_compaction_cache",
        step: Step::Sql(
            "
      CREATE TABLE IF NOT EXISTS compaction_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        start_msg_idx INTEGER NOT NULL,
        end_msg_idx INTEGER NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_conv ON compaction_cache(conversation_id);
    ",
        ),
    },
    Migration {
        name: "006_claude_session_id",
        step: Step::Sql(
            "
      -- Add claude_session_id column to conversations table
      -- This stores the Claude Code CLI session ID for resuming sessions
      ALTER TABLE conversations ADD COLUMN claude_session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_conversations_claude_session ON conversations(claude_session_id);
    ",
        ),
    },
    Migration {
        name: "007_agent_tasks",
        step: Step::Sql(
            "
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        name TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        model TEXT,
        result TEXT,
        error TEXT,
        tools_used INTEGER DEFAULT 0,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
    ",
        ),
    },
    Migration {
        name: "008_fts_search",
        step: Step::Sql(
            "
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid'
      );

      -- Populate FTS index with existing messages
      INSERT OR IGNORE INTO messages_fts(rowid, content)
        SELECT rowid, content FROM messages;

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    ",
        ),
    },
    // Live timeline: every message, turn start/end and tool step for every conversation and channel, with a
    // sequence number that is NEVER reused (AUTOINCREMENT), so a device can always resume from "the last seq I
    // saw", across reconnects and restarts. Feeds the realtime dashboard (lib/live_bus.rs). Pruned to 14 days.
    Migration {
        name: "009_conversation_events",
        step: Step::Sql(
            "
      CREATE TABLE IF NOT EXISTS conversation_events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        turn_id         TEXT,
        type            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_events_conv ON conversation_events (conversation_id, seq);
      CREATE INDEX IF NOT EXISTS idx_conv_events_time ON conversation_events (created_at);
      -- live.subscribe rebuilds the turn in progress by turn_id.
      CREATE INDEX IF NOT EXISTS idx_conv_events_turn ON conversation_events (turn_id);
    ",
        ),
    },
    // Token usage (lib/token_usage.rs): the model calls read from Claude Code's session transcripts, and each
    // turn's sums, so the Usage page and the line under each reply read sums from here instead of parsing
    // transcripts.
    Migration {
        name: "010_token_usage",
        step: Step::Sql(USAGE_SCHEMA),
    },
    // The files of a chat (lib/chat_files.rs): what the agent sent into it (send_file, files it emailed) and what
    // people sent in that the channels kept no note of (the dashboard's own uploads, pictures). Kept with the
    // conversation, so the dashboard's chat shows them after a reload and on every device, in their place:
    //   message_id        the message it came with (a person's files)
    //   after_message_id  the conversation's latest message when it came: it goes just after that one
    //   turn_id           the turn at work in this conversation when the agent sent it (it shows on that turn's reply)
    Migration {
        name: "011_chat_files",
        step: Step::Sql(
            "
      CREATE TABLE IF NOT EXISTS chat_files (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id  TEXT NOT NULL,
        direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        message_id       TEXT,
        after_message_id TEXT,
        turn_id          TEXT,
        name             TEXT NOT NULL,
        size             INTEGER NOT NULL DEFAULT 0,
        path             TEXT NOT NULL,
        caption          TEXT,
        via              TEXT,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_files_conv ON chat_files (conversation_id, id);
      CREATE INDEX IF NOT EXISTS idx_chat_files_message ON chat_files (message_id);
    ",
        ),
    },
    // Which provider and engine ran each model call and turn, and what it cost (USAGE_COLUMNS above), for the Usage
    // page's provider column, spend totals and the monthly cap. Guarded column adds, so it runs on a database a
    // usage index already gave the columns, and twice. Session handles keep living in
    // conversations.claude_session_id (the Claude plan's stay bare; other providers' are tagged), so conversations
    // gets no new column.
    Migration {
        name: "012_ai_usage_columns",
        step: Step::Up(ensure_usage_columns),
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::tmp_dir;

    fn names(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        stmt.query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?)").unwrap();
        stmt.query_map([table], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn init_db_creates_the_folder_and_applies_every_migration_in_order() {
        let dir = tmp_dir();
        let path = dir.path().join("nested").join("deeper").join("tarsee.db");
        let conn = init_db(&path).unwrap();
        assert!(path.exists());
        assert_eq!(
            names(&conn, "SELECT name FROM migrations ORDER BY id"),
            migration_names()
        );
        assert_eq!(migration_names().len(), 12);
        assert_eq!(migration_names()[0], "001_initial");
        assert_eq!(migration_names()[11], "012_ai_usage_columns");
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        let foreign_keys: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn every_table_the_node_version_made_is_there() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn, None).unwrap();
        let tables = names(
            &conn,
            "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name",
        );
        for expected in [
            "agent_tasks",
            "api_tokens",
            "audit_log",
            "bot_memory",
            "chat_files",
            "compaction_cache",
            "conversation_events",
            "conversations",
            "embedding_cache",
            "memory_vectors",
            "messages",
            "messages_fts",
            "migrations",
            "settings",
            "usage_calls",
            "usage_files",
            "usage_meta",
            "usage_prompts",
            "usage_sessions",
            "usage_turns",
            "voice_profiles",
        ] {
            assert!(tables.iter().any(|t| t == expected), "missing table {expected}");
        }
        assert!(columns(&conn, "conversations").contains(&"claude_session_id".to_string()));
        for column in ["provider", "engine", "cost_usd"] {
            assert!(
                columns(&conn, "usage_calls").contains(&column.to_string()),
                "usage_calls.{column}"
            );
        }
        assert!(columns(&conn, "usage_turns").contains(&"cost_exact".to_string()));
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn, None).unwrap();
        migrate(&conn, None).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 12);
    }

    #[test]
    fn through_stops_after_the_named_migration_and_a_later_run_finishes() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn, Some("011_chat_files")).unwrap();
        assert_eq!(names(&conn, "SELECT name FROM migrations ORDER BY id").len(), 11);
        assert!(!columns(&conn, "usage_calls").contains(&"provider".to_string()));
        migrate(&conn, None).unwrap();
        assert!(columns(&conn, "usage_calls").contains(&"provider".to_string()));
    }

    #[test]
    fn the_full_text_index_follows_inserts_updates_and_deletes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate(&conn, None).unwrap();
        conn.execute("INSERT INTO conversations (id) VALUES ('c1')", [])
            .unwrap();
        conn.execute("INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'the tarsier sees everything')", []).unwrap();
        let hits = |q: &str| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?",
                [q],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(hits("tarsier"), 1);
        conn.execute("UPDATE messages SET content = 'the owl sleeps' WHERE id = 'm1'", [])
            .unwrap();
        assert_eq!(hits("tarsier"), 0);
        assert_eq!(hits("owl"), 1);
        conn.execute("DELETE FROM conversations WHERE id = 'c1'", []).unwrap();
        assert_eq!(hits("owl"), 0);
    }

    #[test]
    fn ensure_column_adds_once_and_refuses_anything_but_plain_names() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (a TEXT)").unwrap();
        assert!(ensure_column(&conn, "t", "b", "REAL NOT NULL DEFAULT 0").unwrap());
        assert!(!ensure_column(&conn, "t", "B", "REAL").unwrap());
        assert_eq!(columns(&conn, "t"), ["a", "b"]);

        let message = |r: anyhow::Result<bool>| r.unwrap_err().to_string();
        assert_eq!(
            message(ensure_column(&conn, "t; DROP TABLE t", "c", "TEXT")),
            "ensureColumn: not a table name: \"t; DROP TABLE t\""
        );
        assert_eq!(
            message(ensure_column(&conn, "t", "c d", "TEXT")),
            "ensureColumn: not a column name: \"c d\""
        );
        assert_eq!(
            message(ensure_column(&conn, "t", "c", "TEXT; DROP TABLE t")),
            "ensureColumn: not a column type (ddl): \"TEXT; DROP TABLE t\""
        );
        assert_eq!(
            message(ensure_column(&conn, "t", "c", "TEXT -- x")),
            "ensureColumn: not a column type (ddl): \"TEXT -- x\""
        );
        assert_eq!(
            message(ensure_column(&conn, "missing", "c", "TEXT")),
            "ensureColumn: no table named missing"
        );
    }

    #[test]
    fn ensure_usage_columns_can_run_twice() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(USAGE_SCHEMA).unwrap();
        ensure_usage_columns(&conn).unwrap();
        ensure_usage_columns(&conn).unwrap();
        assert!(columns(&conn, "usage_turns").contains(&"cost_exact".to_string()));
    }
}
