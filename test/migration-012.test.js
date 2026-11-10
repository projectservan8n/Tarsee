// Migration 012_ai_usage_columns (src/db/sqlite.js), design 4.13 and the Phase 0 "Migration 012" item: provider,
// engine and cost_usd on usage_calls and usage_turns, added by a guarded ensureColumn so it can run twice. The
// UsageIndex constructor (src/lib/token-usage.js) re-runs the usage schema on whatever database it opens and adds the
// same columns, so a fresh database, an existing one and one made some other way (a test's bare database) all end up
// with them and none ever hits a duplicate-column error. Session handles stay in conversations.claude_session_id
// (design 4.10), so conversations get no new column.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-migration-012-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb, migrate, ensureColumn, ensureUsageColumns } = await import("../src/db/sqlite.js");
const { UsageIndex } = await import("../src/lib/token-usage.js");

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const MIGRATION = "012_ai_usage_columns";
const NEW_COLUMNS = { provider: "TEXT", engine: "TEXT", cost_usd: "REAL" };
const USAGE_TABLES = ["usage_calls", "usage_turns"];

let n = 0;
const file = (name) => path.join(tmp, `${++n}-${name}.db`);

/** column name -> declared type */
function columns(db, table) {
  return Object.fromEntries(db.prepare("SELECT name, type FROM pragma_table_info(?)").all(table).map((c) => [c.name, c.type]));
}

function assertNewColumns(db, where) {
  for (const table of USAGE_TABLES) {
    const cols = columns(db, table);
    for (const [col, type] of Object.entries(NEW_COLUMNS)) {
      assert.equal(cols[col], type, `${where}: ${table}.${col} should be ${type}, columns are ${Object.keys(cols).join(", ")}`);
    }
  }
}

function applied(db) {
  return db.prepare("SELECT name FROM migrations ORDER BY id").all().map((r) => r.name);
}

/** A database as an install made before 012 has it: migrations 001 to 011, with rows in it. */
function existingDatabase(p) {
  const db = new Database(p);
  db.pragma("foreign_keys = ON");
  migrate(db, { through: "011_chat_files" });
  db.prepare("INSERT INTO conversations (id, title, claude_session_id) VALUES (?, ?, ?)").run("conv-1", "Old chat", "3f2a-raw-session-id");
  db.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)").run("msg-1", "conv-1", "user", "hello");
  db.prepare(`INSERT INTO usage_calls (id, session_id, model, ended_at, input, output, conversation_id)
    VALUES ('call-1', '3f2a-raw-session-id', 'claude-test-1', 1000, 10, 20, 'conv-1')`).run();
  db.prepare(`INSERT INTO usage_turns (turn_id, conversation_id, model, started_at, calls, input, output)
    VALUES ('turn-1', 'conv-1', 'claude-test-1', 900, 1, 10, 20)`).run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('ai.activeProvider', 'claude-code')").run();
  return db;
}

describe("migration 012: provider, engine and cost_usd on the usage tables", () => {
  it("a fresh database gets the columns and records the migration", () => {
    const db = initDb(file("fresh"));
    try {
      assertNewColumns(db, "fresh database");
      assert.ok(applied(db).includes(MIGRATION), `${MIGRATION} not recorded: ${applied(db).join(", ")}`);
      assert.equal(applied(db).at(-1), MIGRATION, "012 should be the newest migration");
    } finally { db.close(); }
  });

  it("runs twice on a fresh database without error", () => {
    const p = file("fresh-twice");
    initDb(p).close();
    for (let run = 0; run < 2; run++) {
      // Forget that 012 ran, so its body really runs again on columns that already exist.
      const db = new Database(p);
      db.prepare("DELETE FROM migrations WHERE name = ?").run(MIGRATION);
      db.close();
      const again = initDb(p);
      try {
        assertNewColumns(again, `fresh database, run ${run + 2}`);
        assert.equal(applied(again).filter((m) => m === MIGRATION).length, 1);
      } finally { again.close(); }
    }
  });

  it("upgrades a copy of an existing database (twice) and keeps its rows; the original is untouched", () => {
    const original = file("existing");
    existingDatabase(original).close();
    const copy = file("existing-copy");
    fs.copyFileSync(original, copy);

    let db = initDb(copy);
    try {
      assertNewColumns(db, "existing database");
      assert.ok(applied(db).includes(MIGRATION));
    } finally { db.close(); }

    // And again, with 012's record removed so its body runs on the upgraded copy.
    const raw = new Database(copy);
    raw.prepare("DELETE FROM migrations WHERE name = ?").run(MIGRATION);
    raw.close();
    db = initDb(copy);
    try {
      assertNewColumns(db, "existing database, second run");
      const call = db.prepare("SELECT * FROM usage_calls WHERE id = 'call-1'").get();
      assert.equal(call.input, 10);
      assert.equal(call.output, 20);
      assert.equal(call.provider, null);
      assert.equal(call.engine, null);
      assert.equal(call.cost_usd, null, "an old call has no cost (unknown, or included in a plan)");
      const turn = db.prepare("SELECT * FROM usage_turns WHERE turn_id = 'turn-1'").get();
      assert.equal(turn.calls, 1);
      assert.equal(turn.provider, null);
      assert.equal(turn.cost_usd, null);
      // The session handle keeps living in the existing column (design 4.10).
      assert.equal(db.prepare("SELECT claude_session_id FROM conversations WHERE id = 'conv-1'").get().claude_session_id, "3f2a-raw-session-id");
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages").get().c, 1);
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'ai.activeProvider'").get().value, "claude-code");
    } finally { db.close(); }

    const orig = new Database(original, { readonly: true });
    try {
      assert.equal(columns(orig, "usage_calls").provider, undefined, "the original database was changed");
    } finally { orig.close(); }
  });

  it("an existing database a UsageIndex opened first (columns already added) still migrates without a duplicate-column error", () => {
    const p = file("usage-index-first");
    const db = existingDatabase(p);
    new UsageIndex(db, { dirs: [] });
    assertNewColumns(db, "after UsageIndex");
    db.close();
    const upgraded = initDb(p);
    try {
      assertNewColumns(upgraded, "after migration");
      assert.ok(applied(upgraded).includes(MIGRATION));
    } finally { upgraded.close(); }
  });
});

describe("the UsageIndex constructor adds the columns to whatever database it opens", () => {
  it("a bare database (as a test makes one), opened twice", () => {
    const db = new Database(":memory:");
    try {
      new UsageIndex(db, { dirs: [] });
      assertNewColumns(db, "bare database");
      new UsageIndex(db, { dirs: [] });
      assertNewColumns(db, "bare database, second open");
    } finally { db.close(); }
  });

  it("a migrated database: nothing to add, nothing breaks", () => {
    const db = initDb(file("migrated-index"));
    try {
      new UsageIndex(db, { dirs: [] });
      assertNewColumns(db, "migrated database");
    } finally { db.close(); }
  });
});

describe("ensureColumn(db, table, column, ddl)", () => {
  it("adds a missing column once and says whether it did", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
      db.prepare("INSERT INTO t (id) VALUES ('a')").run();
      assert.equal(ensureColumn(db, "t", "note", "TEXT"), true);
      assert.equal(ensureColumn(db, "t", "note", "TEXT"), false);
      assert.equal(ensureColumn(db, "t", "score", "REAL NOT NULL DEFAULT 0"), true);
      assert.deepEqual(columns(db, "t"), { id: "TEXT", note: "TEXT", score: "REAL" });
      assert.equal(db.prepare("SELECT score FROM t").get().score, 0);
    } finally { db.close(); }
  });

  it("refuses a table that does not exist and names that are not plain identifiers", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE t (id TEXT)");
      assert.throws(() => ensureColumn(db, "missing", "c", "TEXT"), /missing/);
      assert.throws(() => ensureColumn(db, "t; DROP TABLE t", "c", "TEXT"), /table/i);
      assert.throws(() => ensureColumn(db, "t", "c TEXT; DROP TABLE t; --", "TEXT"), /column/i);
      assert.throws(() => ensureColumn(db, "t", "c", "TEXT; DROP TABLE t"), /ddl|type/i);
      assert.deepEqual(columns(db, "t"), { id: "TEXT" });
    } finally { db.close(); }
  });

  it("ensureUsageColumns is safe to run any number of times", () => {
    const db = initDb(file("ensure-usage"));
    try {
      for (let i = 0; i < 3; i++) ensureUsageColumns(db);
      assertNewColumns(db, "after three runs");
    } finally { db.close(); }
  });
});
