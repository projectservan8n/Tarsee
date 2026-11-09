// Codex keeps a second copy of every thread in sqlite databases in its home (state_5.sqlite's threads row, with the
// person's first words; thread_history_1.sqlite's turns and items, with every message and command output; and a few
// smaller ones). It never removes them, so the daily sweep does (lib/codex-thread-dbs.js, called by
// lib/retention.js): the rows of a thread whose rollout is gone and that nothing has touched since the cutoff. A thread
// whose rollout is still there (where its row says, or anywhere else in the home), and a thread touched since the
// cutoff (one mid-turn, or one Codex registered before writing its rollout), always stay. These databases are built
// here in the shape the pinned codex 0.167.0 writes; test/retention-codex.test.js runs the real binary.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0, "nothing more the second time");
  });

  it("the removed thread's words leave the disk, even while Codex has its databases open", () => {
    const home = makeHome(STANDARD);
    // A running Codex keeps its databases open between turns. Then closing the sweep's own connection doesn't
    // checkpoint and remove the write-ahead log (only the last connection's close does), so the sweep has to empty it
    // itself; and a deleted row's bytes stay in the file's free space unless they are overwritten.
    const codex = ["state_5.sqlite", "thread_history_1.sqlite"].map((file) => {
      const db = new Database(path.join(home, file));
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master").get();
      return db;
    });
    try {
      assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 1);
      const words = [`the person's words in ${ID.gone}`, `user in ${ID.gone}`, `agent in ${ID.gone}`, `command in ${ID.gone}`];
      for (const file of ["state_5.sqlite", "thread_history_1.sqlite"]) {
        const wal = path.join(home, `${file}-wal`);
        assert.ok(fs.existsSync(wal), `${file}: the log is still there while Codex has the database open`);
        assert.equal(fs.statSync(wal).size, 0, `${file}: the write-ahead log is emptied`);
        const bytes = fs.readFileSync(path.join(home, file)).toString("latin1");
        for (const w of words) assert.ok(!bytes.includes(w), `${file}: "${w}" is still in the database file`);
      }
      // What stays is still there, and Codex still reads it.
      assert.equal(codex[0].prepare("SELECT first_user_message AS m FROM threads WHERE id = ?").get(ID.kept).m, `the person's words in ${ID.kept}`);
      assert.equal(codex[0].prepare("SELECT COUNT(*) AS c FROM threads WHERE id = ?").get(ID.gone).c, 0);
    } finally {
      for (const db of codex) db.close();
    }
  });

  // Codex writes its databases without secure_delete. A row it rewrote at another size, or moved when a page split as
  // a chat grew, leaves its old copy in a page's free space, where deleting the row now doesn't reach it. So after the
  // delete the sweep rebuilds the file (VACUUM), which keeps no free space with old copies in it.
  const grow = (home) => {
    const history = new Database(path.join(home, "thread_history_1.sqlite"));
    const state = new Database(path.join(home, "state_5.sqlite"));
    const add = history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?)");
    // Two chats taking turns, so their rows share pages and the pages split as they grow.
    for (let i = 0; i < 150; i++) {
      for (const id of [ID.gone, ID.kept]) add.run(id, `t${i}`, `item-${i}`, JSON.stringify({ text: `${id === ID.gone ? "GONE-WORDS" : "KEPT-WORDS"} turn ${i} ${"w".repeat(260)}` }));
    }
    // And the chat's first row rewritten as it grew, as Codex updates a thread's title and preview.
    const upd = state.prepare("UPDATE threads SET first_user_message = ? WHERE id = ?");
    for (let i = 1; i <= 3; i++) upd.run(`GONE-WORDS first message, take ${i} ${"x".repeat(80 * i)}`, ID.gone);
    history.close();
    state.close();
  };
  const leftIn = (home, word) => fs.readdirSync(home)
    .filter((f) => /\.sqlite(-wal)?$/.test(f))
    .filter((f) => fs.readFileSync(path.join(home, f)).toString("latin1").includes(word));

  it("words Codex's own rewrites left in free space go too: the file is rebuilt after the delete", () => {
    const home = makeHome(STANDARD);
    grow(home);
    assert.ok(leftIn(home, "GONE-WORDS").length, "the fixture has the words on disk to begin with");
    // A running Codex keeps them open between turns.
    const codex = ["state_5.sqlite", "thread_history_1.sqlite"].map((f) => new Database(path.join(home, f)));
    try {
      assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 1);
      assert.deepEqual(leftIn(home, "GONE-WORDS"), [], "no copy of the removed chat's words in any database or log");
      assert.equal(codex[1].prepare("SELECT COUNT(*) AS c FROM thread_items WHERE thread_id = ?").get(ID.kept).c, 153, "the kept chat's rows are all there");
      assert.ok(leftIn(home, "KEPT-WORDS").includes("thread_history_1.sqlite"));
      assert.equal(fs.existsSync(path.join(home, ".tarsee-vacuum-pending")), false);
    } finally {
      for (const db of codex) db.close();
    }
  });

  it("a rebuild that can't finish while Codex is reading is done on the next sweep, even with nothing new to remove", (t) => {
    const home = makeHome(STANDARD);
    grow(home);
    const warn = t.mock.method(console, "warn", () => {});
    // The running Codex holds its history open the whole time (one read, so it really holds the log), so closing a
    // connection never writes the log into the file by itself: only a sweep's rebuild can clear the words.
    const codex = new Database(path.join(home, "thread_history_1.sqlite"));
    codex.prepare("SELECT COUNT(*) AS c FROM thread_turns").get();
    try {
      // Codex mid-read on its history: the delete goes through, the rebuild can't be written out yet.
      const reader = new Database(path.join(home, "thread_history_1.sqlite"));
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) AS c FROM thread_items").get();
      try {
        assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 1);
      } finally {
        reader.exec("COMMIT");
        reader.close();
      }
      assert.equal(threadIds(home).includes(ID.gone), false, "the rows went");
      const pending = JSON.parse(fs.readFileSync(path.join(home, ".tarsee-vacuum-pending"), "utf8"));
      assert.deepEqual(pending, ["thread_history_1.sqlite"], "and the sweep remembers the file it couldn't rebuild");
      assert.ok(warn.mock.calls.some((c) => /thread_history_1\.sqlite.*next sweep/.test(String(c.arguments[0]))), "and says so");
      assert.ok(leftIn(home, "GONE-WORDS").length, "the words are still on disk until a sweep rebuilds the file");

      // The next sweep: no chat is due, but the rebuild left over is done.
      assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0);
      assert.deepEqual(leftIn(home, "GONE-WORDS"), []);
      assert.equal(fs.existsSync(path.join(home, ".tarsee-vacuum-pending")), false, "nothing is left to do");
      assert.equal(codex.prepare("SELECT COUNT(*) AS c FROM thread_items WHERE thread_id = ?").get(ID.kept).c, 153, "Codex still reads what stays");
    } finally {
      codex.close();
    }
  });

  /** Run a sweep in a child process that dies (process.exit runs no finally) the moment `dbName`'s rebuild starts. */
  const killedSweep = (home, dbName) => {
    const script = path.join(tmp, `killed-sweep-${++n}.mjs`);
    const mod = new URL("../src/lib/codex-thread-dbs.js", import.meta.url).href;
    const sqliteMod = import.meta.resolve("better-sqlite3");
    fs.writeFileSync(script, [
      `import Database from ${JSON.stringify(sqliteMod)};`,
      `import { pruneCodexThreadDbs } from ${JSON.stringify(mod)};`,
      "const exec = Database.prototype.exec;",
      "Database.prototype.exec = function (sql) {",
      `  if (/VACUUM/i.test(sql) && this.name.endsWith(${JSON.stringify(dbName)})) process.exit(137);`,
      "  return exec.call(this, sql);",
      "};",
      `pruneCodexThreadDbs({ homes: [${JSON.stringify(home)}], maxAgeDays: 30, now: ${NOW} });`,
    ].join("\n"));
    return spawnSync(process.execPath, [script], { encoding: "utf8" });
  };
  /** A Codex that keeps its databases open (one read each, so it holds the log): nothing but a rebuild clears words. */
  const runningCodex = (home) => ["state_5.sqlite", "thread_history_1.sqlite"].map((f) => {
    const db = new Database(path.join(home, f));
    db.prepare("SELECT COUNT(*) AS c FROM sqlite_master").get();
    return db;
  });

  it("a sweep stopped dead in the middle of the history's rebuild (the server killed) leaves it noted, and the next sweep does it", () => {
    const home = makeHome(STANDARD);
    grow(home);
    const codex = runningCodex(home);
    try {
      const r = killedSweep(home, "thread_history_1.sqlite");
      assert.equal(r.status, 137, `the sweep was stopped dead: ${r.stderr}`);
      assert.equal(threadIds(home).includes(ID.gone), true, "state_5 goes last, so its rows wait for the next sweep");
      const pending = JSON.parse(fs.readFileSync(path.join(home, ".tarsee-vacuum-pending"), "utf8"));
      assert.ok(pending.includes("thread_history_1.sqlite"), "the history's rebuild was noted before it started");
      assert.ok(leftIn(home, "GONE-WORDS").length, "the words are still on disk");

      assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 1);
      assert.deepEqual(leftIn(home, "GONE-WORDS"), [], "the next sweep removes what is left and rebuilds the file");
      assert.equal(fs.existsSync(path.join(home, ".tarsee-vacuum-pending")), false);
    } finally {
      for (const db of codex) db.close();
    }
  });

  it("stopped dead in state_5's rebuild, after its rows went: the next sweep, with no chat due, still rebuilds it", () => {
    const home = makeHome(STANDARD);
    grow(home);
    const codex = runningCodex(home);
    try {
      const r = killedSweep(home, "state_5.sqlite");
      assert.equal(r.status, 137, `the sweep was stopped dead: ${r.stderr}`);
      assert.equal(threadIds(home).includes(ID.gone), false, "state_5's rows went before its rebuild started");
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".tarsee-vacuum-pending"), "utf8")), ["state_5.sqlite"],
        "the history was rebuilt; state_5's rebuild is the one noted");
      assert.ok(leftIn(home, "GONE-WORDS").includes("state_5.sqlite"), "the person's first words are still in state_5");

      assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0, "no chat is due any more");
      assert.deepEqual(leftIn(home, "GONE-WORDS"), [], "yet state_5 is rebuilt, and the words are gone");
      assert.equal(fs.existsSync(path.join(home, ".tarsee-vacuum-pending")), false);
      assert.equal(codex[0].prepare("SELECT first_user_message AS m FROM threads WHERE id = ?").get(ID.kept).m, `the person's words in ${ID.kept}`);
    } finally {
      for (const db of codex) db.close();
    }
  });

  it("a sweep that removes rows only rebuilds the databases that lost some", (t) => {
    const home = makeHome(STANDARD);
    const goals = new Database(path.join(home, "goals_1.sqlite"));
    goals.exec("CREATE TABLE goals (id TEXT PRIMARY KEY, thread_id TEXT, text TEXT); INSERT INTO goals VALUES ('g1', 'someone-else', 'kept')");
    goals.close();
    const vacuumed = [];
    const exec = Database.prototype.exec;
    t.mock.method(Database.prototype, "exec", function (sql) {
      if (/VACUUM/i.test(sql)) vacuumed.push(path.basename(this.name));
      return exec.call(this, sql);
    });
    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 1);
    assert.deepEqual(vacuumed.sort(), ["logs_2.sqlite", "state_5.sqlite", "thread_history_1.sqlite"], "goals_1 had none of the thread's rows");
    assert.equal(fs.existsSync(path.join(home, ".tarsee-vacuum-pending")), false);
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

  // A sessions folder that can't be read would make every old thread look as if its rollout were gone (and an
  // unreadable parent folder makes fs.existsSync say false for a rollout that is there), so the sweep removes nothing.
  it("a sessions folder that can't be read: nothing is taken for gone, and it says why", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const home = makeHome(STANDARD);
    const sessions = path.join(home, "sessions");
    const readdirSync = fs.readdirSync.bind(fs);
    t.mock.method(fs, "readdirSync", (dir, ...rest) => {
      const p = path.resolve(String(dir));
      if (p === sessions || p.startsWith(sessions + path.sep)) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), { code: "EACCES" });
      }
      return readdirSync(dir, ...rest);
    });
    assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0);
    assert.deepEqual(threadIds(home), STANDARD.map((s) => s.id).sort(), "every thread stays");
    assert.deepEqual(itemThreads(home), STANDARD.map((s) => s.id).sort(), "and every message");
    assert.ok(warn.mock.calls.some((c) => /\[retention\].*EACCES/.test(String(c.arguments[0]))), "the reason is logged");
  });

  it("the same with the folder's permissions really taken away (Linux and macOS, not as root)", {
    skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs a system where a folder can be made unreadable" : false,
  }, (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const home = makeHome(STANDARD);
    const sessions = path.join(home, "sessions");
    fs.chmodSync(sessions, 0o000);
    try {
      assert.equal(pruneCodexThreadDbs({ homes: [home], maxAgeDays: 30, now: NOW }), 0);
    } finally {
      fs.chmodSync(sessions, 0o755);
    }
    assert.deepEqual(threadIds(home), STANDARD.map((s) => s.id).sort(), "every thread stays, the one whose rollout is there too");
    assert.ok(warn.mock.calls.some((c) => /\[retention\].*EACCES/.test(String(c.arguments[0]))), "the reason is logged");
  });

  it("a home with no databases, or none at all, is fine", () => {
    const empty = path.join(tmp, "empty-home");
    fs.mkdirSync(empty, { recursive: true });
    assert.equal(pruneCodexThreadDbs({ homes: [empty, path.join(tmp, "no-such-home"), null], maxAgeDays: 30, now: NOW }), 0);
  });
});
