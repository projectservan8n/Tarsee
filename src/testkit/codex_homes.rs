//! Codex homes with the sqlite databases the pinned codex 0.167.0 keeps (state_5.sqlite's threads row with the
//! person's first words, thread_history_1.sqlite's turns and items, logs_2.sqlite), built the way
//! test/codex-thread-dbs.test.js built them, for the tests of `lib/codex_thread_dbs.rs` (unit and integration).

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, params};

pub const DAY: i64 = 86_400_000;
/// `Date.parse("2026-11-09T03:00:00Z")`.
pub const NOW: i64 = 1_794_193_200_000;

pub const GONE: &str = "01a1c080-0000-7000-8000-00000000000a";
pub const KEPT: &str = "01a1c080-0000-7000-8000-00000000000b";
pub const MOVED: &str = "01a1c080-0000-7000-8000-00000000000c";
pub const FRESH: &str = "01a1c080-0000-7000-8000-00000000000d";
pub const ARCHIVED: &str = "01a1c080-0000-7000-8000-00000000000e";
pub const CHILD: &str = "01a1c080-0000-7000-8000-00000000000f";
/// A sub-agent thread a kept thread spawned.
pub const KEPT_CHILD: &str = "01a1c080-0000-7000-8000-000000000010";

/// Where a thread's rollout is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rollout {
    /// Nowhere.
    None,
    /// Where its row says.
    Here,
    /// In the home, but its row names another place.
    Moved,
    /// In archived_sessions/.
    Archived,
}

#[derive(Debug, Clone, Copy)]
pub struct Thread {
    pub id: &'static str,
    pub age_days: i64,
    pub rollout: Rollout,
}

/// The JS STANDARD set: one gone, one kept, one moved, one fresh, one archived.
pub fn standard() -> Vec<Thread> {
    vec![
        Thread {
            id: GONE,
            age_days: 40,
            rollout: Rollout::None,
        },
        Thread {
            id: KEPT,
            age_days: 40,
            rollout: Rollout::Here,
        },
        Thread {
            id: MOVED,
            age_days: 40,
            rollout: Rollout::Moved,
        },
        Thread {
            id: FRESH,
            age_days: 1,
            rollout: Rollout::None,
        },
        Thread {
            id: ARCHIVED,
            age_days: 40,
            rollout: Rollout::Archived,
        },
    ]
}

/// The standard ids, sorted.
pub fn standard_ids() -> Vec<String> {
    let mut ids: Vec<String> = standard().iter().map(|t| t.id.to_string()).collect();
    ids.sort();
    ids
}

fn sqlite(file: &Path, sql: &str) -> Connection {
    let db = Connection::open(file).expect("a test database");
    db.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))
        .expect("WAL mode");
    db.execute_batch(sql).expect("the test schema");
    db
}

/// A Codex home `<root>/<name>` with the databases 0.167 keeps, a thread row per entry of `threads` and rows in
/// every table. `state_columns` is the threads table's time column ("updated_at_ms INTEGER" as Codex has it).
pub fn make_home(root: &Path, name: &str, threads: &[Thread], state_columns: &str) -> PathBuf {
    let home = root.join(name);
    std::fs::create_dir_all(&home).unwrap();
    let state = sqlite(
        &home.join("state_5.sqlite"),
        &format!(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL);
             CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, {state_columns},
               first_user_message TEXT, attached_thread_parent_id TEXT);
             CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
               PRIMARY KEY(thread_id, position), FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE);
             CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
             CREATE TABLE thread_read_receipts (thread_id TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL);
             CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
             INSERT INTO thread_sections VALUES ('s1', 'kept: no thread column');"
        ),
    );
    let history = sqlite(
        &home.join("thread_history_1.sqlite"),
        "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL);
         CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id));
         CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, item_json TEXT NOT NULL,
           PRIMARY KEY (thread_id, turn_id, item_id));",
    );
    let logs = sqlite(
        &home.join("logs_2.sqlite"),
        "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, feedback_log_body TEXT, thread_id TEXT);",
    );
    for t in threads {
        let at = NOW - t.age_days * DAY;
        let file_name = format!("rollout-2026-10-01T00-00-00-{}.jsonl", t.id);
        let rollout = home
            .join("sessions")
            .join("2026")
            .join("10")
            .join("01")
            .join(&file_name);
        if t.rollout != Rollout::None {
            let place = if t.rollout == Rollout::Archived {
                home.join("archived_sessions").join(&file_name)
            } else {
                rollout.clone()
            };
            std::fs::create_dir_all(place.parent().unwrap()).unwrap();
            std::fs::write(&place, "{}\n").unwrap();
        }
        let recorded = if t.rollout == Rollout::Moved {
            root.join("an-old-place").join(&file_name)
        } else {
            rollout
        };
        let recorded = recorded.to_string_lossy().into_owned();
        let words = format!("the person's words in {}", t.id);
        if state_columns.contains("updated_at_ms") {
            state
                .execute(
                    "INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, first_user_message) VALUES (?, ?, ?, ?, ?)",
                    params![t.id, recorded, at.div_euclid(1000), at, words],
                )
                .unwrap();
        } else {
            state
                .execute(
                    "INSERT INTO threads (id, rollout_path, updated_at, first_user_message) VALUES (?, ?, ?, ?)",
                    params![t.id, recorded, at.div_euclid(1000), words],
                )
                .unwrap();
        }
        state
            .execute("INSERT INTO thread_dynamic_tools VALUES (?, 0, 'tool')", [t.id])
            .unwrap();
        state
            .execute("INSERT INTO thread_read_receipts VALUES (?, 'r1')", [t.id])
            .unwrap();
        history
            .execute("INSERT INTO thread_turns VALUES (?, 't1', 'completed')", [t.id])
            .unwrap();
        for item in ["user", "agent", "command"] {
            let json = serde_json::json!({ "text": format!("{item} in {}", t.id) }).to_string();
            history
                .execute(
                    "INSERT INTO thread_items VALUES (?, 't1', ?, ?)",
                    params![t.id, item, json],
                )
                .unwrap();
        }
        logs.execute(
            "INSERT INTO logs (ts, feedback_log_body, thread_id) VALUES (?, 'log', ?)",
            params![at, t.id],
        )
        .unwrap();
    }
    // A sub-agent thread the removed one spawned, and one spawned by a kept thread.
    state
        .execute("INSERT INTO thread_spawn_edges VALUES (?, ?, 'done')", [GONE, CHILD])
        .unwrap();
    state
        .execute(
            "INSERT INTO thread_spawn_edges VALUES (?, ?, 'done')",
            [KEPT, KEPT_CHILD],
        )
        .unwrap();
    home
}

/// Opens one of the home's databases read-only.
pub fn open_read_only(home: &Path, file: &str) -> Connection {
    Connection::open_with_flags(home.join(file), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

/// The first column of every row, as text.
pub fn column(home: &Path, file: &str, sql: &str, args: &[&str]) -> Vec<String> {
    let db = open_read_only(home, file);
    let mut stmt = db.prepare(sql).unwrap();
    stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        r.get::<_, rusqlite::types::Value>(0)
    })
    .unwrap()
    .map(|v| match v.unwrap() {
        rusqlite::types::Value::Text(t) => t,
        rusqlite::types::Value::Integer(i) => i.to_string(),
        other => format!("{other:?}"),
    })
    .collect()
}

/// The ids in state_5's threads table, sorted.
pub fn thread_ids(home: &Path) -> Vec<String> {
    column(home, "state_5.sqlite", "SELECT id FROM threads ORDER BY id", &[])
}

/// The threads that still have items in thread_history_1, sorted.
pub fn item_threads(home: &Path) -> Vec<String> {
    let mut ids = column(
        home,
        "thread_history_1.sqlite",
        "SELECT thread_id FROM thread_items",
        &[],
    );
    ids.sort();
    ids.dedup();
    ids
}

/// Two chats taking turns, so their rows share pages and the pages split as they grow, and the gone chat's first
/// row rewritten as it grew, as Codex updates a thread's title and preview.
pub fn grow(home: &Path) {
    let history = Connection::open(home.join("thread_history_1.sqlite")).unwrap();
    let state = Connection::open(home.join("state_5.sqlite")).unwrap();
    for i in 0..150 {
        for id in [GONE, KEPT] {
            let words = if id == GONE { "GONE-WORDS" } else { "KEPT-WORDS" };
            let json = serde_json::json!({ "text": format!("{words} turn {i} {}", "w".repeat(260)) }).to_string();
            history
                .execute(
                    "INSERT INTO thread_items VALUES (?, ?, ?, ?)",
                    params![id, format!("t{i}"), format!("item-{i}"), json],
                )
                .unwrap();
        }
    }
    for i in 1..=3 {
        state
            .execute(
                "UPDATE threads SET first_user_message = ? WHERE id = ?",
                params![
                    format!("GONE-WORDS first message, take {i} {}", "x".repeat(80 * i)),
                    GONE
                ],
            )
            .unwrap();
    }
}

/// The home's database and log files that still hold `word` anywhere in their bytes.
pub fn left_in(home: &Path, word: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(home)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".sqlite") || n.ends_with(".sqlite-wal"))
        .filter(|n| {
            let bytes = std::fs::read(home.join(n)).unwrap_or_default();
            bytes.windows(word.len()).any(|w| w == word.as_bytes())
        })
        .collect();
    names.sort();
    names
}

/// A running Codex: its databases open, one read each, so it holds the log and only a rebuild clears words.
pub fn running_codex(home: &Path) -> Vec<Connection> {
    ["state_5.sqlite", "thread_history_1.sqlite"]
        .iter()
        .map(|f| {
            let db = Connection::open(home.join(f)).unwrap();
            db.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
                .unwrap();
            db
        })
        .collect()
}
