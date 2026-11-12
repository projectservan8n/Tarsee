//! Port of `src/lib/codex-thread-dbs.js`: the second copy Codex keeps of every thread, kept tidy.
//!
//! Besides its rollout file (`ai/codex_rollouts.rs`), the pinned Codex (0.167) writes every thread into sqlite
//! databases in its home: state_5.sqlite's threads row (with the person's first words and the turn's context), and
//! thread_history_1.sqlite's turns and items (every message, and every command with its output), plus smaller ones.
//! Codex never removes these rows itself, so once retention has pruned a thread's rollout its words would stay in the
//! home for good. `lib/retention.rs` calls [`prune_codex_thread_dbs`] right after the rollouts, with the same cutoff.
//!
//! Only a thread whose rollout is gone (not where its row says, and not anywhere else in the home) AND whose row
//! nothing has touched since the cutoff is removed: a thread mid-turn, or one Codex registered before writing its
//! rollout, is always newer than that. The threads rows go last, once every other database is done, so a database
//! that fails (busy, or changed) leaves them for the next sweep to try again.
//!
//! Like the JS (better-sqlite3), every call here is synchronous and may wait on Codex's locks for seconds: run it off
//! the async runtime (`spawn_blocking`).

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::anyhow;
use regex::Regex;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::ai::codex_rollouts::is_rollout_name;
use crate::lib::run_cmd::node_error_message;

const STATE_DB: &str = "state_5.sqlite";
/// The other databases with rows per thread. A missing one is skipped.
const THREAD_DBS: [&str; 5] = [
    "thread_history_1.sqlite",
    "goals_1.sqlite",
    "queue_1.sqlite",
    "memories_1.sqlite",
    "logs_2.sqlite",
];
/// The columns that name a thread, in any table of those databases.
const THREAD_COLUMNS: [&str; 3] = ["thread_id", "parent_thread_id", "child_thread_id"];

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").expect("a uuid pattern")
});
static ROLLOUT_UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
        .expect("a rollout uuid pattern")
});

/// One entry of a folder, as the sweep looks at it (`readdirSync(dir, { withFileTypes: true })`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirItem {
    pub name: String,
    pub is_file: bool,
    pub is_dir: bool,
}

/// Lists a folder. The default reads the real one; a test stands in a folder that can't be read.
pub type ReadDirFn = Arc<dyn Fn(&Path) -> io::Result<Vec<DirItem>> + Send + Sync>;

/// Called with a database's file name, or with a warning's text.
pub type NameFn = Arc<dyn Fn(&str) + Send + Sync>;

/// The sweep's seams, for tests (the JS tests mocked `fs.readdirSync`, `console.warn` and `Database.prototype.exec`).
#[derive(Clone, Default)]
pub struct ThreadDbsDeps {
    /// Lists a folder of rollouts (default: the file system). An error with a message of its own is reported as it
    /// is; an operating-system error in Node's words.
    pub read_dir: Option<ReadDirFn>,
    /// Called with a database's file name just before it is rebuilt (VACUUM).
    pub before_rebuild: Option<NameFn>,
    /// Where warnings go (default: the log, as `console.warn`).
    pub warn: Option<NameFn>,
}

impl ThreadDbsDeps {
    fn warn(&self, text: &str) {
        match &self.warn {
            Some(warn) => warn(text),
            None => log::warn!("{text}"),
        }
    }
}

/// What [`prune_codex_thread_dbs`] sweeps.
#[derive(Clone)]
pub struct PruneThreadDbsOpts {
    /// The Codex homes; an empty path is skipped, and a home given twice is swept once.
    pub homes: Vec<PathBuf>,
    /// Default 30.
    pub max_age_days: f64,
    /// Now, in ms since the epoch (`Date.now()`).
    pub now: i64,
    pub deps: ThreadDbsDeps,
}

impl Default for PruneThreadDbsOpts {
    fn default() -> Self {
        PruneThreadDbsOpts {
            homes: Vec::new(),
            max_age_days: 30.0,
            now: crate::util::js::now_ms(),
            deps: ThreadDbsDeps::default(),
        }
    }
}

/// Remove, from each Codex home's databases, every row of the threads whose rollout is gone and that are older than
/// `max_age_days`. Returns how many threads went; never fails (a home that fails is logged and left for the next
/// sweep).
pub fn prune_codex_thread_dbs(opts: &PruneThreadDbsOpts) -> usize {
    let cutoff = opts.now as f64 - opts.max_age_days * 86_400_000.0;
    let mut removed = 0;
    let mut seen = BTreeSet::new();
    for home in &opts.homes {
        if home.as_os_str().is_empty() || !seen.insert(home.clone()) {
            continue;
        }
        match prune_home(home, cutoff, &opts.deps) {
            Ok(gone) => removed += gone,
            Err(err) => opts.deps.warn(&format!(
                "[retention] Codex thread rows in {} not pruned: {err}",
                base_name(home)
            )),
        }
    }
    removed
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The databases in a home an earlier sweep couldn't rebuild, in the order they were noted (a JS `Set`).
#[derive(Debug, Default)]
struct Pending(Vec<String>);

impl Pending {
    fn has(&self, name: &str) -> bool {
        self.0.iter().any(|n| n == name)
    }

    fn add(&mut self, name: &str) {
        if !self.has(name) {
            self.0.push(name.to_string());
        }
    }

    fn delete(&mut self, name: &str) {
        self.0.retain(|n| n != name);
    }
}

fn prune_home(home: &Path, cutoff: f64, deps: &ThreadDbsDeps) -> anyhow::Result<usize> {
    let state_path = home.join(STATE_DB);
    if !state_path.exists() {
        return Ok(0);
    }
    let mut pending = read_pending(home);
    let result = prune_home_dbs(home, &state_path, cutoff, &mut pending, deps);
    // `finally`: what is left to rebuild is noted whatever happened above.
    write_pending(home, &pending, deps);
    result
}

fn prune_home_dbs(
    home: &Path,
    state_path: &Path,
    cutoff: f64,
    pending: &mut Pending,
    deps: &ThreadDbsDeps,
) -> anyhow::Result<usize> {
    let ids = with_db(state_path, |db| gone_threads(db, home, cutoff, deps))?;
    // Delete, then rebuild each database that lost rows (or whose rebuild an earlier sweep didn't finish). The
    // rebuild is noted in the home BEFORE the delete, so a sweep stopped dead in between (the server killed
    // mid-VACUUM) leaves it to the next sweep, which would otherwise find nothing to delete there and never rebuild it.
    for name in THREAD_DBS {
        let file = home.join(name);
        if !file.exists() {
            pending.delete(name);
            continue;
        }
        if !ids.is_empty() {
            with_db(&file, |db| clear(home, name, db, &ids, false, pending, deps))?;
        } else if pending.has(name) {
            with_db(&file, |db| {
                rebuild(db, name, pending, deps);
                Ok(())
            })?;
        }
    }
    if ids.is_empty() {
        if pending.has(STATE_DB) {
            with_db(state_path, |db| {
                rebuild(db, STATE_DB, pending, deps);
                Ok(())
            })?;
        }
        return Ok(0);
    }
    with_db(state_path, |db| {
        clear(home, STATE_DB, db, &ids, true, pending, deps).map(|r| r.gone)
    })
}

/// Note the rebuild, delete the threads' rows, then rebuild (or forget the note when nothing went and no earlier
/// rebuild is owed).
fn clear(
    home: &Path,
    name: &str,
    db: &Connection,
    ids: &[String],
    threads: bool,
    pending: &mut Pending,
    deps: &ThreadDbsDeps,
) -> anyhow::Result<Deleted> {
    let was = pending.has(name);
    pending.add(name);
    write_pending(home, pending, deps);
    let deleted = delete_rows(db, ids, threads)?;
    if deleted.changed > 0 || was {
        rebuild(db, name, pending, deps);
    } else {
        pending.delete(name);
    }
    Ok(deleted)
}

/// Rebuild a database after rows went, so no copy of them is left in its free space, then write it all into the file
/// and empty the write-ahead log. Deleting with secure_delete wipes only the rows as they are now; Codex writes
/// without it, so the older copies of a row it rewrote at another size, or moved when a page split, stay in a page's
/// free space until the file is rebuilt. While Codex is reading the database the rebuild can't be written out; the
/// name is then kept in the home's pending file and the next sweep finishes it, whether or not any thread is due by
/// then.
fn rebuild(db: &Connection, name: &str, pending: &mut Pending, deps: &ThreadDbsDeps) {
    if let Some(hook) = &deps.before_rebuild {
        hook(name);
    }
    let rebuilt = (|| -> anyhow::Result<()> {
        db.execute_batch("VACUUM")?;
        let busy: i64 = db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;
        if busy != 0 {
            return Err(anyhow!("Codex is reading it"));
        }
        Ok(())
    })();
    match rebuilt {
        Ok(()) => pending.delete(name),
        Err(err) => {
            pending.add(name);
            deps.warn(&format!(
                "[retention] Codex {name} isn't rebuilt yet ({err}); the next sweep finishes it"
            ));
        }
    }
}

/// The databases in this home an earlier sweep couldn't rebuild (a small JSON list in the home).
const PENDING_FILE: &str = ".tarsee-vacuum-pending";

fn read_pending(home: &Path) -> Pending {
    let mut pending = Pending::default();
    let Ok(text) = std::fs::read(home.join(PENDING_FILE)) else {
        return pending;
    };
    if let Ok(serde_json::Value::Array(list)) = serde_json::from_slice::<serde_json::Value>(&text) {
        for name in list.iter().filter_map(serde_json::Value::as_str) {
            if name == STATE_DB || THREAD_DBS.contains(&name) {
                pending.add(name);
            }
        }
    }
    pending
}

fn write_pending(home: &Path, pending: &Pending, deps: &ThreadDbsDeps) {
    let file = home.join(PENDING_FILE);
    let written = if pending.0.is_empty() {
        match std::fs::remove_file(&file) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other.map_err(|err| node_error_message(&err, "rm", &file)),
        }
    } else {
        let text = serde_json::to_string(&pending.0).unwrap_or_else(|_| "[]".into());
        std::fs::write(&file, text).map_err(|err| node_error_message(&err, "open", &file))
    };
    if let Err(message) = written {
        deps.warn(&format!(
            "[retention] Codex {}: couldn't note what is left to rebuild: {message}",
            base_name(home)
        ));
    }
}

/// The ids of the threads past the cutoff whose rollout is nowhere in the home.
fn gone_threads(db: &Connection, home: &Path, cutoff: f64, deps: &ThreadDbsDeps) -> anyhow::Result<Vec<String>> {
    let cols = columns_of(db, "threads")?;
    if !["id", "rollout_path", "updated_at_ms"]
        .iter()
        .all(|c| cols.contains(*c))
    {
        deps.warn("[retention] Codex state_5 schema changed; thread rows not pruned");
        return Ok(Vec::new());
    }
    let touched = if cols.contains("updated_at") {
        "COALESCE(updated_at_ms, updated_at * 1000)"
    } else {
        "updated_at_ms"
    };
    let mut stmt = db.prepare(&format!("SELECT id, rollout_path FROM threads WHERE {touched} < ?"))?;
    let mut rows = stmt.query([cutoff])?;
    let mut old: Vec<(Option<String>, Option<String>)> = Vec::new();
    while let Some(row) = rows.next()? {
        old.push((text_of(row.get_ref(0)?), text_of(row.get_ref(1)?)));
    }
    if old.is_empty() {
        return Ok(Vec::new());
    }
    let rollouts = rollouts_in(home, deps)?;
    let has_rollout = |id: &str| {
        if UUID.is_match(id) {
            rollouts.ids.contains(&id.to_lowercase())
        } else {
            let suffix = format!("-{id}.jsonl");
            rollouts.names.iter().any(|n| n.ends_with(&suffix))
        }
    };
    Ok(old
        .into_iter()
        .filter_map(|(id, rollout_path)| {
            let id = id.filter(|id| !id.is_empty())?;
            let rollout_there = rollout_path.is_some_and(|p| !p.is_empty() && Path::new(&p).exists());
            (!rollout_there && !has_rollout(&id)).then_some(id)
        })
        .collect())
}

/// A text column's value; anything else is `None` (the JS `typeof r.id === "string"`).
fn text_of(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        _ => None,
    }
}

struct Rollouts {
    names: Vec<String>,
    ids: BTreeSet<String>,
}

fn real_read_dir(dir: &Path) -> io::Result<Vec<DirItem>> {
    let mut items = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        items.push(DirItem {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_file: kind.is_file(),
            is_dir: kind.is_dir(),
        });
    }
    Ok(items)
}

/// Every rollout file in the home (sessions/YYYY/MM/DD and archived_sessions), by name and by the thread id it ends
/// with. A folder that can't be read fails, so no thread is taken for gone because of it.
fn rollouts_in(home: &Path, deps: &ThreadDbsDeps) -> anyhow::Result<Rollouts> {
    fn walk(dir: &Path, depth: u32, deps: &ThreadDbsDeps, names: &mut Vec<String>) -> anyhow::Result<()> {
        let listed = match &deps.read_dir {
            Some(read_dir) => read_dir(dir),
            None => real_read_dir(dir),
        };
        let entries = match listed {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => {
                // An error that carries its own words keeps them; an operating-system one gets Node's.
                let message = if err.raw_os_error().is_none() && err.get_ref().is_some() {
                    err.to_string()
                } else {
                    node_error_message(&err, "scandir", dir)
                };
                return Err(anyhow!(message));
            }
        };
        for entry in entries {
            if entry.is_file && is_rollout_name(&entry.name) {
                names.push(entry.name);
            } else if entry.is_dir && depth > 0 {
                walk(&dir.join(&entry.name), depth - 1, deps, names)?;
            }
        }
        Ok(())
    }
    let mut names = Vec::new();
    walk(&home.join("sessions"), 3, deps, &mut names)?;
    walk(&home.join("archived_sessions"), 3, deps, &mut names)?;
    let ids = names
        .iter()
        .filter_map(|n| ROLLOUT_UUID.captures(n).map(|c| c[1].to_lowercase()))
        .collect();
    Ok(Rollouts { names, ids })
}

/// What [`delete_rows`] removed: the threads rows (`gone`) and every row in all (`changed`).
struct Deleted {
    gone: usize,
    changed: usize,
}

/// Delete the threads' rows from every table with a thread column, in one transaction (and the threads rows
/// themselves, in state_5).
///
/// The person's words must leave the disk, not just the tables: secure_delete overwrites the deleted rows' bytes, so
/// the log frames this writes don't carry them, and [`rebuild`] (run after, when anything went) clears the older
/// copies Codex itself left in free space, writes everything into the file and empties the log, which a running Codex
/// holding the database open would otherwise keep.
fn delete_rows(db: &Connection, ids: &[String], threads: bool) -> anyhow::Result<Deleted> {
    let tables: Vec<String> = {
        let mut stmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        names
            .into_iter()
            .filter(|t| !t.starts_with("sqlite_") && !t.starts_with("_sqlx_"))
            .collect()
    };
    db.execute_batch("PRAGMA secure_delete = ON")?;
    let tx = db.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS tarsee_gone_threads (id TEXT PRIMARY KEY);
         DELETE FROM temp.tarsee_gone_threads;",
    )?;
    {
        let mut add = tx.prepare("INSERT OR IGNORE INTO temp.tarsee_gone_threads (id) VALUES (?)")?;
        for id in ids {
            add.execute([id])?;
        }
    }
    let mut changed = 0;
    for table in &tables {
        let cols = columns_of(&tx, table)?;
        for column in THREAD_COLUMNS {
            if cols.contains(column) {
                changed += tx.execute(
                    &format!(
                        "DELETE FROM main.\"{}\" WHERE \"{column}\" IN (SELECT id FROM temp.tarsee_gone_threads)",
                        table.replace('"', "\"\"")
                    ),
                    [],
                )?;
            }
        }
    }
    let mut gone = 0;
    if threads {
        gone = tx.execute(
            "DELETE FROM main.threads WHERE id IN (SELECT id FROM temp.tarsee_gone_threads)",
            [],
        )?;
        changed += gone;
    }
    tx.execute_batch("DELETE FROM temp.tarsee_gone_threads")?;
    tx.commit()?;
    Ok(Deleted { gone, changed })
}

fn columns_of(db: &Connection, table: &str) -> rusqlite::Result<BTreeSet<String>> {
    let mut stmt = db.prepare("SELECT name FROM pragma_table_info(?)")?;
    stmt.query_map([table], |r| r.get::<_, String>(0))?.collect()
}

/// Open a Codex database (waiting up to 5 s while Codex holds it), run `f`, and always close it.
fn with_db<T>(file: &Path, f: impl FnOnce(&Connection) -> anyhow::Result<T>) -> anyhow::Result<T> {
    let db = Connection::open_with_flags(
        file,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_millis(5000))?;
    let result = f(&db);
    drop(db);
    result
}

#[cfg(test)]
mod tests;
