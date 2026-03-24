import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Initializes the SQLite database with schema migrations.
 * @param {string} dbPath - Path to the SQLite database file
 * @returns {Database.Database}
 */
export function initDb(dbPath) {
  // Ensure parent directory exists before opening DB
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // Performance tuning for production use
  db.pragma("journal_mode = WAL");        // Write-Ahead Logging for concurrent reads
  db.pragma("synchronous = NORMAL");      // Good balance of safety + speed
  db.pragma("cache_size = -8000");        // 8MB cache
  db.pragma("busy_timeout = 5000");       // 5s retry on lock
  db.pragma("foreign_keys = ON");

  // Run migrations
  migrate(db);

  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.prepare("SELECT name FROM migrations").all().map((r) => r.name)
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO migrations (name) VALUES (?)").run(m.name);
    })();
    console.log(`[db] applied migration: ${m.name}`);
  }
}

const MIGRATIONS = [
  {
    name: "001_initial",
    sql: `
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
    `,
  },
  {
    name: "002_audit_log",
    sql: `
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
    `,
  },
  {
    name: "003_bot_memory",
    sql: `
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
    `,
  },
  {
    name: "004_vector_memory",
    sql: `
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
    `,
  },
  {
    name: "005_compaction_cache",
    sql: `
      CREATE TABLE IF NOT EXISTS compaction_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        start_msg_idx INTEGER NOT NULL,
        end_msg_idx INTEGER NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_conv ON compaction_cache(conversation_id);
    `,
  },
];
