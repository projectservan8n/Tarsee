//! The database: one SQLite file, opened once and shared (`better-sqlite3` in the Node version).
//!
//! [`Db`] is a cheap handle to the one connection. Like `better-sqlite3`, every call is synchronous and short:
//!
//! ```ignore
//! let titles: Vec<String> = db.with(|conn| {
//!     let mut stmt = conn.prepare_cached("SELECT title FROM conversations ORDER BY updated_at DESC")?;
//!     stmt.query_map([], |row| row.get(0))?.collect()
//! })?;
//! ```
//!
//! `with` may be called again from inside a `with` on the same thread (a store method calling another store
//! method), as the JS did freely. Never keep the closure waiting on anything slow, and never `.await` inside it:
//! every other user of the database waits meanwhile.
//!
//! For code that handled rows as plain objects (`stmt.get()`, `stmt.all()`), [`get`], [`all`] and [`run`] give
//! JSON objects keyed by column name.

pub mod audit;
pub mod conversations;
pub mod memory;
pub mod settings;
pub mod sqlite;
pub mod usage_schema;

use std::cell::RefCell;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::ReentrantMutex;
use rusqlite::Connection;
use rusqlite::types::{Value as SqlValue, ValueRef};
use serde_json::{Map, Value};

/// A row as a JSON object keyed by column name, in column order.
pub type Row = Map<String, Value>;

/// What a write changed (`stmt.run()`'s result).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunResult {
    pub changes: usize,
    pub last_insert_rowid: i64,
}

/// A shared handle to the open database.
#[derive(Clone)]
pub struct Db {
    conn: Arc<ReentrantMutex<RefCell<Option<Connection>>>>,
}

static SAVEPOINT: AtomicU64 = AtomicU64::new(0);

impl Db {
    /// Opens (creating it and its folder if needed) and migrates the database at `path`: `initDb(dbPath)`.
    pub fn open(path: &Path) -> anyhow::Result<Db> {
        Ok(Db::from_connection(sqlite::init_db(path)?))
    }

    /// A migrated database that lives in memory, for tests that need no file.
    pub fn open_in_memory() -> anyhow::Result<Db> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        sqlite::migrate(&conn, None)?;
        Ok(Db::from_connection(conn))
    }

    /// Wraps a connection as it is: no pragmas, no migrations.
    pub fn from_connection(conn: Connection) -> Db {
        Db {
            conn: Arc::new(ReentrantMutex::new(RefCell::new(Some(conn)))),
        }
    }

    /// Runs `f` with the connection. Panics if the database was closed: nothing may use it after shutdown.
    pub fn with<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        let guard = self.conn.lock();
        let slot = guard.borrow();
        let conn = slot.as_ref().expect("the database is closed");
        f(conn)
    }

    /// Runs `f` in a transaction: committed when it returns `Ok`, rolled back when it returns `Err`. Inside another
    /// transaction it becomes a savepoint, as `db.transaction(fn)` did in `better-sqlite3`.
    pub fn transaction<R, E>(&self, f: impl FnOnce(&Connection) -> Result<R, E>) -> Result<R, E>
    where
        E: From<rusqlite::Error>,
    {
        self.with(|conn| {
            if conn.is_autocommit() {
                conn.execute_batch("BEGIN")?;
                match f(conn) {
                    Ok(value) => {
                        conn.execute_batch("COMMIT")?;
                        Ok(value)
                    }
                    Err(err) => {
                        // The failure being reported is the one that matters; a failed rollback changes nothing.
                        let _ = conn.execute_batch("ROLLBACK");
                        Err(err)
                    }
                }
            } else {
                let name = format!("tarsee_sp_{}", SAVEPOINT.fetch_add(1, Ordering::Relaxed));
                conn.execute_batch(&format!("SAVEPOINT {name}"))?;
                match f(conn) {
                    Ok(value) => {
                        conn.execute_batch(&format!("RELEASE {name}"))?;
                        Ok(value)
                    }
                    Err(err) => {
                        let _ = conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
                        Err(err)
                    }
                }
            }
        })
    }

    /// Closes the connection (`db.close()`). Every handle shares it, so all of them are closed. Returns false when
    /// it was already closed or is in use on this thread right now.
    pub fn close(&self) -> bool {
        let guard = self.conn.lock();
        let Ok(mut slot) = guard.try_borrow_mut() else {
            return false;
        };
        slot.take().is_some()
    }

    pub fn is_open(&self) -> bool {
        let guard = self.conn.lock();
        guard.try_borrow().map(|slot| slot.is_some()).unwrap_or(true)
    }
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db").field("open", &self.is_open()).finish()
    }
}

/// Every row of a query as JSON objects (`db.prepare(sql).all(...params)`).
pub fn all(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let names: Vec<String> = stmt.column_names().map(String::from).collect();
    let mut rows = stmt.query(params)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut object = Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            object.insert(name.clone(), json_from_sql(row.get_ref(i)?));
        }
        out.push(object);
    }
    Ok(out)
}

/// The first row of a query as a JSON object, or `None` (`db.prepare(sql).get(...params)`).
pub fn get(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> rusqlite::Result<Option<Row>> {
    Ok(all(conn, sql, params)?.into_iter().next())
}

/// Runs a write (`db.prepare(sql).run(...params)`).
pub fn run(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> rusqlite::Result<RunResult> {
    let changes = conn.prepare_cached(sql)?.execute(params)?;
    Ok(RunResult {
        changes,
        last_insert_rowid: conn.last_insert_rowid(),
    })
}

/// A column value as JSON. A blob becomes an array of its bytes; read blobs with a typed query instead.
pub fn json_from_sql(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Array(b.iter().map(|byte| Value::from(*byte)).collect()),
    }
}

/// A JSON value as a bound parameter, the way `better-sqlite3` bound JS values: null, numbers and strings as
/// themselves, true/false as 1/0, and anything else as its JSON text.
pub fn sql_from_json(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// Bound parameters from JSON values: `db::all(conn, sql, db::json_params(&[json!(id), json!(limit)]))`.
pub fn json_params(values: &[Value]) -> rusqlite::ParamsFromIter<Vec<SqlValue>> {
    rusqlite::params_from_iter(values.iter().map(sql_from_json).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().unwrap());
        db.with(|c| c.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB)"))
            .unwrap();
        db
    }

    #[test]
    fn run_get_and_all_work_like_better_sqlite3() {
        let db = scratch();
        let done = db
            .with(|c| {
                run(
                    c,
                    "INSERT INTO t (name, score) VALUES (?, ?)",
                    rusqlite::params!["a", 1.5],
                )
            })
            .unwrap();
        assert_eq!(
            done,
            RunResult {
                changes: 1,
                last_insert_rowid: 1
            }
        );
        db.with(|c| run(c, "INSERT INTO t (name) VALUES (?)", ["b"])).unwrap();

        let rows = db
            .with(|c| all(c, "SELECT id, name, score, data FROM t ORDER BY id", []))
            .unwrap();
        assert_eq!(
            Value::Object(rows[0].clone()),
            json!({"id": 1, "name": "a", "score": 1.5, "data": null})
        );
        assert_eq!(rows[1]["score"], Value::Null);
        assert_eq!(rows[0].keys().collect::<Vec<_>>(), ["id", "name", "score", "data"]);

        let one = db.with(|c| get(c, "SELECT name FROM t WHERE id = ?", [2])).unwrap();
        assert_eq!(one.unwrap()["name"], "b");
        assert!(
            db.with(|c| get(c, "SELECT name FROM t WHERE id = ?", [9]))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn json_values_bind_the_way_javascript_values_did() {
        let db = scratch();
        let params = [json!("n"), json!(2), json!(true), json!({"k": [1]})];
        db.with(|c| {
            run(
                c,
                "INSERT INTO t (name, id, score, data) VALUES (?, ?, ?, ?)",
                json_params(&params),
            )
        })
        .unwrap();
        let row = db
            .with(|c| get(c, "SELECT id, score, typeof(data) AS kind, data FROM t", []))
            .unwrap()
            .unwrap();
        assert_eq!(row["id"], 2);
        assert_eq!(row["score"], 1.0);
        assert_eq!(row["kind"], "text");
        assert_eq!(row["data"], "{\"k\":[1]}");
    }

    #[test]
    fn with_can_be_entered_again_on_the_same_thread() {
        let db = scratch();
        let count: i64 = db.with(|outer| {
            outer.execute("INSERT INTO t (name) VALUES ('x')", []).unwrap();
            db.with(|inner| inner.query_row("SELECT count(*) FROM t", [], |r| r.get(0)))
                .unwrap()
        });
        assert_eq!(count, 1);
    }

    #[test]
    fn a_transaction_commits_on_ok_and_rolls_back_on_err() {
        let db = scratch();
        db.transaction(|c| run(c, "INSERT INTO t (name) VALUES ('kept')", []))
            .unwrap();
        let failed: Result<(), rusqlite::Error> = db.transaction(|c| {
            run(c, "INSERT INTO t (name) VALUES ('lost')", [])?;
            Err(rusqlite::Error::InvalidQuery)
        });
        assert!(failed.is_err());
        let names = db.with(|c| all(c, "SELECT name FROM t", [])).unwrap();
        assert_eq!(names.len(), 1);
        assert_eq!(names[0]["name"], "kept");
    }

    #[test]
    fn a_nested_transaction_is_a_savepoint() {
        let db = scratch();
        db.transaction::<_, rusqlite::Error>(|c| {
            run(c, "INSERT INTO t (name) VALUES ('outer')", [])?;
            let inner: Result<(), rusqlite::Error> = db.transaction(|c| {
                run(c, "INSERT INTO t (name) VALUES ('inner')", [])?;
                Err(rusqlite::Error::InvalidQuery)
            });
            assert!(inner.is_err());
            Ok(())
        })
        .unwrap();
        let names = db.with(|c| all(c, "SELECT name FROM t", [])).unwrap();
        assert_eq!(names.len(), 1);
        assert_eq!(names[0]["name"], "outer");
    }

    #[test]
    fn close_closes_every_handle() {
        let db = scratch();
        let other = db.clone();
        assert!(db.is_open());
        assert!(db.close());
        assert!(!other.is_open());
        assert!(!other.close());
    }

    #[test]
    fn close_is_refused_while_the_connection_is_in_use() {
        let db = scratch();
        let refused = db.with(|_conn| !db.close());
        assert!(refused);
        assert!(db.is_open());
    }
}
