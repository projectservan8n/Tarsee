//! Helpers for tests. Not used by the running server.
//!
//! - [`test_app`] gives a whole [`App`] in a temporary folder of its own: its own configuration, environment and
//!   database, and an HTTP client ([`FakeFetch`]) that refuses every request no test has stubbed, so a test can
//!   never reach the network or another test's state.
//! - [`FakeFetch`] is the stubbed `fetch` the Node tests built by hand: it answers by URL prefix and records every
//!   request.
//! - [`http`] calls an axum `Router` directly, without a socket.
//!
//! Stand-ins for the programs Tarsee starts (claude, codex, python, piper) are in the `tarsee-testbin` binary
//! (`testbin/`), which integration tests (`tests/it/`) find through `support::testbin()`.

pub mod fake_fetch;
pub mod http;
pub mod memory_settings;

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;

pub use fake_fetch::{Answer, FakeFetch, FetchCall};
pub use memory_settings::MemorySettings;

use crate::app::App;
use crate::config::Config;
use crate::db::Db;
use crate::env::Env;

/// A new empty temporary folder, removed when the returned value is dropped. It is made under `TARSEE_TEST_TMP`
/// when that is set (`.cargo/config.toml` points it into `target/`), else the system temp folder.
pub fn tmp_dir() -> TempDir {
    // The one read of the real environment outside `main`: where tests may write.
    let base = std::env::var_os("TARSEE_TEST_TMP").map(PathBuf::from);
    match base {
        Some(base) => {
            std::fs::create_dir_all(&base).expect("the test temp folder could not be made");
            tempfile::Builder::new()
                .prefix("t-")
                .tempdir_in(base)
                .expect("a temporary folder could not be made")
        }
        None => tempfile::Builder::new()
            .prefix("tarsee-test-")
            .tempdir()
            .expect("a temporary folder could not be made"),
    }
}

/// An [`App`] for one test, with everything it owns. Use it as an `App` (`t.config()`, `t.set(...)`) or pass
/// `t.app.clone()` where an owned `App` is wanted.
pub struct TestApp {
    pub app: App,
    /// The app's HTTP client: stub answers on it, read what was sent from it.
    pub fetch: Arc<FakeFetch>,
    /// The app's state folder (`TARSEE_STATE_DIR`). Removed when the `TestApp` is dropped.
    pub dir: TempDir,
}

impl TestApp {
    /// The state folder.
    pub fn path(&self) -> &Path {
        self.dir.path()
    }
}

impl Deref for TestApp {
    type Target = App;
    fn deref(&self) -> &App {
        &self.app
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        // Closing first lets the folder be removed even if something still holds a handle to the database
        // (Windows cannot delete an open file).
        self.app.db().close();
    }
}

/// A test app with the default test environment: state under a new temporary folder, the home folder inside it
/// (so nothing reads the real one), the timezone UTC, and nothing else set.
pub fn test_app() -> TestApp {
    test_app_with_env(std::iter::empty::<(&str, &str)>())
}

/// A test app whose environment also has `extra` (which wins over the defaults).
pub fn test_app_with_env<K: Into<String>, V: Into<String>>(extra: impl IntoIterator<Item = (K, V)>) -> TestApp {
    let dir = tmp_dir();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).expect("the test home folder could not be made");
    let env = Env::from_pairs([
        ("TARSEE_STATE_DIR", dir.path().to_string_lossy().to_string()),
        ("HOME", home.to_string_lossy().to_string()),
        ("USERPROFILE", home.to_string_lossy().to_string()),
        ("TARSEE_TIMEZONE", "UTC".to_string()),
    ]);
    for (name, value) in extra {
        env.set(name, value);
    }
    let config = Config::load(&env);
    let db = Db::open(&config.db_path).expect("the test database could not be opened");
    let fetch = FakeFetch::new();
    let app = App::with_fetch(config, env, db, fetch.clone());
    TestApp { app, fetch, dir }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_test_app_has_its_own_folder_database_and_environment() {
        let a = test_app();
        let b = test_app_with_env([("ENCRYPTION_KEY", "k"), ("TARSEE_TIMEZONE", "Asia/Manila")]);
        assert_ne!(a.path(), b.path());
        assert!(a.config().db_path.starts_with(a.path()));
        assert!(a.config().db_path.exists());
        assert_eq!(a.config().timezone, "UTC");
        assert_eq!(b.config().timezone, "Asia/Manila");
        assert_eq!(a.config().encryption_key, None);
        assert_eq!(b.config().encryption_key.as_deref(), Some("k"));
        a.env().set("ONLY_A", "1");
        assert_eq!(b.env().get("ONLY_A"), None);
        a.db()
            .with(|c| c.execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", []))
            .unwrap();
        let in_b: i64 = b
            .db()
            .with(|c| c.query_row("SELECT count(*) FROM settings", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(in_b, 0);
    }

    #[test]
    fn the_folder_is_removed_when_the_test_app_is_dropped_even_with_a_database_handle_left() {
        let t = test_app();
        let path = t.path().to_path_buf();
        let leaked_handle = t.db().clone();
        drop(t);
        assert!(!path.exists());
        assert!(!leaked_handle.is_open());
    }

    #[tokio::test]
    async fn the_network_is_refused_unless_stubbed() {
        use crate::net::fetch::FetchRequest;
        let t = test_app();
        let err = t
            .app
            .fetch()
            .fetch(FetchRequest::get("https://example.com/"))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "fetch failed: no stub for https://example.com/");
    }
}
