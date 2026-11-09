/**
 * codex-thread-dbs.js: the second copy Codex keeps of every thread, kept tidy.
 *
 * Besides its rollout file (ai/codex-rollouts.js), the pinned Codex (0.167) writes every thread into sqlite databases
 * in its home: state_5.sqlite's threads row (with the person's first words and the turn's context), and
 * thread_history_1.sqlite's turns and items (every message, and every command with its output), plus smaller ones.
 * Codex never removes these rows itself, so once retention has pruned a thread's rollout its words would stay in the
 * home for good. lib/retention.js calls pruneCodexThreadDbs right after the rollouts, with the same cutoff.
 *
 * Only a thread whose rollout is gone (not where its row says, and not anywhere else in the home) AND whose row
 * nothing has touched since the cutoff is removed: a thread mid-turn, or one Codex registered before writing its
 * rollout, is always newer than that. The threads rows go last, once every other database is done, so a database
 * that fails (busy, or changed) leaves them for the next sweep to try again.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const STATE_DB = "state_5.sqlite";
/** The other databases with rows per thread. A missing one is skipped. */
const THREAD_DBS = ["thread_history_1.sqlite", "goals_1.sqlite", "queue_1.sqlite", "memories_1.sqlite", "logs_2.sqlite"];
/** The columns that name a thread, in any table of those databases. */
const THREAD_COLUMNS = ["thread_id", "parent_thread_id", "child_thread_id"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const ROLLOUT_UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Remove, from each Codex home's databases, every row of the threads whose rollout is gone and that are older than
 * maxAgeDays. Returns how many threads went; never throws (a home that fails is logged and left for the next sweep).
 */
export function pruneCodexThreadDbs({ homes = [], maxAgeDays = 30, now = Date.now() } = {}) {
  const cutoff = now - maxAgeDays * 86_400_000;
  let removed = 0;
  for (const home of new Set(homes.filter(Boolean))) {
    try {
      removed += pruneHome(home, cutoff);
    } catch (err) {
      console.warn(`[retention] Codex thread rows in ${path.basename(home)} not pruned: ${err?.message || err}`);
    }
  }
  return removed;
}

function pruneHome(home, cutoff) {
  const statePath = path.join(home, STATE_DB);
  if (!fs.existsSync(statePath)) return 0;
  const ids = withDb(statePath, (db) => goneThreads(db, home, cutoff));
  if (!ids.length) return 0;
  for (const name of THREAD_DBS) {
    const file = path.join(home, name);
    if (fs.existsSync(file)) withDb(file, (db) => deleteRows(db, ids));
  }
  return withDb(statePath, (db) => deleteRows(db, ids, { threads: true }));
}

/** The ids of the threads past the cutoff whose rollout is nowhere in the home. */
function goneThreads(db, home, cutoff) {
  const cols = columnsOf(db, "threads");
  if (!["id", "rollout_path", "updated_at_ms"].every((c) => cols.has(c))) {
    console.warn("[retention] Codex state_5 schema changed; thread rows not pruned");
    return [];
  }
  const touched = cols.has("updated_at") ? "COALESCE(updated_at_ms, updated_at * 1000)" : "updated_at_ms";
  const old = db.prepare(`SELECT id, rollout_path FROM threads WHERE ${touched} < ?`).all(cutoff);
  if (!old.length) return [];
  const rollouts = rolloutsIn(home);
  const hasRollout = (id) => (UUID_RE.test(id) ? rollouts.ids.has(id.toLowerCase()) : rollouts.names.some((n) => n.endsWith(`-${id}.jsonl`)));
  return old
    .filter((r) => typeof r.id === "string" && r.id && !(r.rollout_path && fs.existsSync(r.rollout_path)) && !hasRollout(r.id))
    .map((r) => r.id);
}

/**
 * Every rollout file in the home (sessions/YYYY/MM/DD and archived_sessions), by name and by the thread id it ends
 * with. A folder that can't be read throws, so no thread is taken for gone because of it.
 */
function rolloutsIn(home) {
  const names = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      if (e.isFile() && ROLLOUT_RE.test(e.name)) names.push(e.name);
      else if (e.isDirectory() && depth > 0) walk(path.join(dir, e.name), depth - 1);
    }
  };
  walk(path.join(home, "sessions"), 3);
  walk(path.join(home, "archived_sessions"), 3);
  const ids = new Set();
  for (const n of names) {
    const m = ROLLOUT_UUID_RE.exec(n);
    if (m) ids.add(m[1].toLowerCase());
  }
  return { names, ids };
}

/**
 * Delete the threads' rows from every table with a thread column, in one transaction (and the threads rows
 * themselves, in state_5), then empty the write-ahead log. Returns how many threads rows went.
 */
function deleteRows(db, ids, { threads = false } = {}) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((r) => r.name)
    .filter((t) => !t.startsWith("sqlite_") && !t.startsWith("_sqlx_"));
  let gone = 0;
  db.transaction(() => {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS tarsee_gone_threads (id TEXT PRIMARY KEY)");
    db.exec("DELETE FROM temp.tarsee_gone_threads");
    const add = db.prepare("INSERT OR IGNORE INTO temp.tarsee_gone_threads (id) VALUES (?)");
    for (const id of ids) add.run(id);
    for (const t of tables) {
      const cols = columnsOf(db, t);
      for (const c of THREAD_COLUMNS) {
        if (cols.has(c)) db.prepare(`DELETE FROM main."${t.replace(/"/g, '""')}" WHERE "${c}" IN (SELECT id FROM temp.tarsee_gone_threads)`).run();
      }
    }
    if (threads) gone = db.prepare("DELETE FROM main.threads WHERE id IN (SELECT id FROM temp.tarsee_gone_threads)").run().changes;
    db.exec("DELETE FROM temp.tarsee_gone_threads");
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");
  return gone;
}

function columnsOf(db, table) {
  return new Set(db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((c) => c.name));
}

/** Open a Codex database (waiting up to 5 s while Codex holds it), run fn, and always close it. */
function withDb(file, fn) {
  const db = new Database(file, { timeout: 5000, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
