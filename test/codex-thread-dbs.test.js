// Codex keeps a second copy of every thread in sqlite databases in its home (state_5.sqlite's threads row, with the
// person's first words; thread_history_1.sqlite's turns and items, with every message and command output; and a few
// smaller ones). It never removes them, so the daily sweep does (lib/codex-thread-dbs.js, called by
// lib/retention.js): the rows of a thread whose rollout is gone and that nothing has touched since the cutoff. A thread
// whose rollout is still there (where its row says, or anywhere else in the home), and a thread touched since the
// cutoff (one mid-turn, or one Codex registered before writing its rollout), always stay. These databases are built
// here in the shape the pinned codex 0.167.0 writes; test/retention-codex.test.js runs the real binary.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { pruneCodexThreadDbs } from "../src/lib/codex-thread-dbs.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-codex-dbs-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-09T03:00:00Z");
const ID = {
  gone: "01a1c080-0000-7000-8000-00000000000a",
  kept: "01a1c080-0000-7000-8000-00000000000b",
  moved: "01a1c080-0000-7000-8000-00000000000c",
  fresh: "01a1c080-0000-7000-8000-00000000000d",
  archived: "01a1c080-0000-7000-8000-00000000000e",
  child: "01a1c080-0000-7000-8000-00000000000f",
};

function sqlite(file, sql) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(sql);
  return db;
}

let n = 0;
/** A Codex home with the databases 0.167 keeps, a thread row per `threads` entry and rows in every table. */
function makeHome(threads, { stateColumns = "updated_at_ms INTEGER" } = {}) {
  const home = path.join(tmp, `home-${++n}`);
  fs.mkdirSync(home, { recursive: true });
  const state = sqlite(path.join(home, "state_5.sqlite"), `
    CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, ${stateColumns},
      first_user_message TEXT, attached_thread_parent_id TEXT);
    CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY(thread_id, position), FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE thread_read_receipts (thread_id TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL);
    CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO thread_sections VALUES ('s1', 'kept: no thread column');
  `);
  const history = sqlite(path.join(home, "thread_history_1.sqlite"), `
    CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL);
    CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id));
    CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, item_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, item_id));
  `);
  const logs = sqlite(path.join(home, "logs_2.sqlite"), `
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, feedback_log_body TEXT, thread_id TEXT);
  `);
  for (const t of threads) {
    const at = NOW - t.ageDays * DAY;
    const rollout = path.join(home, "sessions", "2026", "10", "01", `rollout-2026-10-01T00-00-00-${t.id}.jsonl`);
    if (t.rollout) {
      const where = t.rollout === "archived" ? path.join(home, "archived_sessions", path.basename(rollout)) : rollout;
      fs.mkdirSync(path.dirname(where), { recursive: true });
      fs.writeFileSync(where, "{}\n");
    }
    const recorded = t.rollout === "moved" ? path.join(tmp, "an-old-place", path.basename(rollout)) : rollout;
    if (stateColumns.includes("updated_at_ms")) {
      state.prepare("INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, first_user_message) VALUES (?, ?, ?, ?, ?)").run(t.id, recorded, Math.floor(at / 1000), at, `the person's words in ${t.id}`);
    } else {
      state.prepare("INSERT INTO threads (id, rollout_path, updated_at, first_user_message) VALUES (?, ?, ?, ?)").run(t.id, recorded, Math.floor(at / 1000), `the person's words in ${t.id}`);
    }
    state.prepare("INSERT INTO thread_dynamic_tools VALUES (?, 0, 'tool')").run(t.id);
    state.prepare("INSERT INTO thread_read_receipts VALUES (?, 'r1')").run(t.id);
    history.prepare("INSERT INTO thread_turns VALUES (?, 't1', 'completed')").run(t.id);
    for (const item of ["user", "agent", "command"]) history.prepare("INSERT INTO thread_items VALUES (?, 't1', ?, ?)").run(t.id, item, JSON.stringify({ text: `${item} in ${t.id}` }));
    logs.prepare("INSERT INTO logs (ts, feedback_log_body, thread_id) VALUES (?, 'log', ?)").run(at, t.id);
  }
  // A sub-agent thread the removed one spawned, and one spawned by a kept thread.
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'done')").run(ID.gone, ID.child);
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'done')").run(ID.kept, "01a1c080-0000-7000-8000-000000000010");
  for (const db of [state, history, logs]) db.close();
  return home;
}

function rows(home, file, sql, ...args) {
  const db = new Database(path.join(home, file), { readonly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
const threadIds = (home) => rows(home, "state_5.sqlite", "SELECT id FROM threads ORDER BY id").map((r) => r.id);
const itemThreads = (home) => [...new Set(rows(home, "thread_history_1.sqlite", "SELECT thread_id FROM thread_items").map((r) => r.thread_id))].sort();

const STANDARD = [
  { id: ID.gone, ageDays: 40, rollout: null },
  { id: ID.kept, ageDays: 40, rollout: "here" },
  { id: ID.moved, ageDays: 40, rollout: "moved" },
  { id: ID.fresh, ageDays: 1, rollout: null },
  { id: ID.archived, ageDays: 40, rollout: "archived" },
];

describe("Codex's thread databases in the daily sweep", () => {
  it("removes every row of a thread whose rollout is gone and that is past the cutoff, in every database", () => {
    const home = makeHome(STANDARD);
    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 1);

    const left = [ID.kept, ID.moved, ID.fresh, ID.archived].sort();
    assert.deepEqual(threadIds(home), left);
    assert.deepEqual(itemThreads(home), left, "its messages and command output are gone");
    for (const [file, table] of [["state_5.sqlite", "thread_dynamic_tools"], ["state_5.sqlite", "thread_read_receipts"], ["thread_history_1.sqlite", "thread_turns"], ["logs_2.sqlite", "logs"]]) {
      assert.deepEqual(rows(home, file, `SELECT thread_id FROM ${table} WHERE thread_id = ?`, ID.gone), [], `${file} ${table}`);
      assert.equal(rows(home, file, `SELECT thread_id FROM ${table}`).length, left.length, `${file} ${table}: the others stay`);
    }
    assert.deepEqual(rows(home, "state_5.sqlite", "SELECT child_thread_id FROM thread_spawn_edges").map((r) => r.child_thread_id), ["01a1c080-0000-7000-8000-000000000010"], "an edge from the removed thread goes; a kept thread's stays");
    assert.equal(rows(home, "state_5.sqlite", "SELECT COUNT(*) AS c FROM thread_sections")[0].c, 1, "a table with no thread column is untouched");
    assert.equal(rows(home, "state_5.sqlite", "SELECT COUNT(*) AS c FROM _sqlx_migrations")[0].c, 0);
    for (const file of ["state_5.sqlite", "thread_history_1.sqlite", "logs_2.sqlite"]) {
      const wal = path.join(home, `${file}-wal`);
      assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, `${file}: the write-ahead log is emptied`);
    }

    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0, "nothing more the second time");
  });

  it("removes nothing at a cutoff the threads haven't reached", () => {
    const home = makeHome(STANDARD);
    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 60, now: NOW }), 0);
    assert.equal(threadIds(home).length, STANDARD.length);
  });

  it("a thread just registered, with no rollout yet, stays (the age guard)", () => {
    const home = makeHome([{ id: ID.fresh, ageDays: 0, rollout: null }]);
    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0);
    assert.deepEqual(threadIds(home), [ID.fresh]);
  });

  it("a thread id that isn't a UUID is matched to its rollout by name too", () => {
    const home = makeHome([{ id: "thread-with-rollout", ageDays: 40, rollout: "here" }, { id: "thread-without", ageDays: 40, rollout: null }]);
    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 1);
    assert.deepEqual(threadIds(home), ["thread-with-rollout"]);
  });

  it("a database that fails keeps the threads rows, so the next sweep tries again", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const home = makeHome(STANDARD);
    const history = path.join(home, "thread_history_1.sqlite");
    for (const f of [history, `${history}-wal`, `${history}-shm`]) fs.rmSync(f, { force: true });
    fs.writeFileSync(history, "this is not a database, but it is far longer than a sqlite header would be ".repeat(4));

    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0);
    assert.ok(threadIds(home).includes(ID.gone), "the threads row stays");
    assert.ok(warn.mock.calls.some((c) => /\[retention\]/.test(String(c.arguments[0]))), "the failure is logged");

    fs.rmSync(history, { force: true });
    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 1, "the next sweep removes it");
    assert.ok(!threadIds(home).includes(ID.gone));
  });

  it("a threads table Codex changed is left alone, with a plain log line", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const home = makeHome([{ id: ID.gone, ageDays: 40, rollout: null }], { stateColumns: "last_seen INTEGER" });
    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0);
    assert.deepEqual(threadIds(home), [ID.gone]);
    assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes("[retention] Codex state_5 schema changed; thread rows not pruned")));
  });

  it("a home with no databases, or none at all, is fine", () => {
    const empty = path.join(tmp, "empty-home");
    fs.mkdirSync(empty, { recursive: true });
    assert.equal(pruneCodexThreadDbs({ homes: [empty, path.join(tmp, "no-such-home"), null], maxAgeDays: 30, now: NOW }), 0);
  });
});
