//! The application context.
//!
//! The Node version kept its shared state in module-level singletons (`initLiveBus(db)`, `setToolsChannelManager(m)`,
//! `app.set("settingsStore", s)`), which only worked because each test file ran in its own process. Here that state
//! hangs off one [`App`] value that is passed to whatever needs it, so two tests in one process never share state.
//!
//! An `App` always has the configuration, the environment, the database and the HTTP client. Everything else is a
//! *service*: a value of any type, stored once and looked up by its type.
//!
//! ```ignore
//! app.set(LiveBus::new(app.db().clone()));      // at boot (or in a test)
//! let bus = app.expect::<LiveBus>();            // wherever it is needed
//! ```
//!
//! A service that needs the app back keeps a [`WeakApp`], never an `App`: an `App` inside a service inside the same
//! `App` would never be freed.

use std::any::{Any, TypeId, type_name};
use std::collections::HashMap;
use std::sync::{Arc, Weak};

use parking_lot::RwLock;

use crate::config::Config;
use crate::db::Db;
use crate::env::Env;
use crate::net::fetch::{Fetch, ReqwestFetch};

type Service = Arc<dyn Any + Send + Sync>;

/// A cheap handle (an `Arc`) to the running application. Clone it freely.
#[derive(Clone)]
pub struct App {
    inner: Arc<Inner>,
}

struct Inner {
    config: Config,
    env: Env,
    db: Db,
    fetch: RwLock<Arc<dyn Fetch>>,
    services: RwLock<HashMap<TypeId, Service>>,
}

impl App {
    /// An app with the real HTTP client. Tests use `testkit::test_app()`, whose client refuses every request that
    /// has no stub.
    pub fn new(config: Config, env: Env, db: Db) -> Self {
        Self::with_fetch(config, env, db, Arc::new(ReqwestFetch::new()))
    }

    pub fn with_fetch(config: Config, env: Env, db: Db, fetch: Arc<dyn Fetch>) -> Self {
        App {
            inner: Arc::new(Inner {
                config,
                env,
                db,
                fetch: RwLock::new(fetch),
                services: RwLock::new(HashMap::new()),
            }),
        }
    }

    /// The frozen configuration (`config/env.js`'s default export).
    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    /// The environment variables Tarsee reads and hands to the programs it starts (`process.env`).
    pub fn env(&self) -> &Env {
        &self.inner.env
    }

    pub fn db(&self) -> &Db {
        &self.inner.db
    }

    /// The HTTP client every outgoing request goes through (the Node version's `fetch`, which tests stubbed).
    pub fn fetch(&self) -> Arc<dyn Fetch> {
        self.inner.fetch.read().clone()
    }

    pub fn set_fetch(&self, fetch: Arc<dyn Fetch>) {
        *self.inner.fetch.write() = fetch;
    }

    /// Stores a service, replacing one of the same type, and returns the shared handle to it.
    pub fn set<T: Any + Send + Sync>(&self, service: T) -> Arc<T> {
        self.set_arc(Arc::new(service))
    }

    pub fn set_arc<T: Any + Send + Sync>(&self, service: Arc<T>) -> Arc<T> {
        self.inner.services.write().insert(TypeId::of::<T>(), service.clone());
        service
    }

    /// The service of this type, if one was stored.
    pub fn get<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        let found = self.inner.services.read().get(&TypeId::of::<T>()).cloned()?;
        found.downcast::<T>().ok()
    }

    /// The service of this type. Panics, naming the type, when it was never stored: that is a wiring mistake at
    /// boot, never a condition to handle at run time.
    pub fn expect<T: Any + Send + Sync>(&self) -> Arc<T> {
        self.get::<T>()
            .unwrap_or_else(|| panic!("service {} was never stored in the App", type_name::<T>()))
    }

    /// The service of this type, made and stored now if it is not there yet. `init` runs outside every lock, so it
    /// may use the app itself; if two callers race, the first one stored wins and both get it.
    pub fn get_or_init<T: Any + Send + Sync>(&self, init: impl FnOnce() -> T) -> Arc<T> {
        if let Some(found) = self.get::<T>() {
            return found;
        }
        let made = Arc::new(init());
        let mut services = self.inner.services.write();
        if let Some(existing) = services.get(&TypeId::of::<T>()).cloned()
            && let Ok(existing) = existing.downcast::<T>()
        {
            return existing;
        }
        services.insert(TypeId::of::<T>(), made.clone());
        made
    }

    /// Takes a service out (a test swapping one, or shutdown).
    pub fn remove<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        let found = self.inner.services.write().remove(&TypeId::of::<T>())?;
        found.downcast::<T>().ok()
    }

    pub fn has<T: Any + Send + Sync>(&self) -> bool {
        self.inner.services.read().contains_key(&TypeId::of::<T>())
    }

    /// A handle that does not keep the app alive, for services stored in it.
    pub fn downgrade(&self) -> WeakApp {
        WeakApp {
            inner: Arc::downgrade(&self.inner),
        }
    }
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App")
            .field("state_dir", &self.inner.config.state_dir)
            .finish_non_exhaustive()
    }
}

/// An [`App`] handle that does not keep it alive.
#[derive(Clone)]
pub struct WeakApp {
    inner: Weak<Inner>,
}

impl WeakApp {
    /// The app, unless it has shut down.
    pub fn upgrade(&self) -> Option<App> {
        self.inner.upgrade().map(|inner| App { inner })
    }
}

#[cfg(test)]
mod tests {
    use crate::testkit::test_app;

    struct Counter(u32);
    struct Other;

    #[test]
    fn a_service_is_stored_and_found_by_its_type() {
        let t = test_app();
        assert!(t.app.get::<Counter>().is_none());
        t.app.set(Counter(7));
        assert_eq!(t.app.expect::<Counter>().0, 7);
        assert!(t.app.get::<Other>().is_none());
        assert!(t.app.has::<Counter>());
    }

    #[test]
    fn set_replaces_and_remove_takes_out() {
        let t = test_app();
        t.app.set(Counter(1));
        t.app.set(Counter(2));
        assert_eq!(t.app.expect::<Counter>().0, 2);
        assert_eq!(t.app.remove::<Counter>().map(|c| c.0), Some(2));
        assert!(t.app.get::<Counter>().is_none());
    }

    #[test]
    fn get_or_init_makes_it_once_and_may_use_the_app() {
        let t = test_app();
        let app = t.app.clone();
        let first = t.app.get_or_init(|| Counter(if app.has::<Other>() { 1 } else { 5 }));
        let second = t.app.get_or_init(|| Counter(9));
        assert_eq!(first.0, 5);
        assert_eq!(second.0, 5);
    }

    #[test]
    fn a_weak_handle_does_not_keep_the_app_alive() {
        let t = test_app();
        let weak = t.app.downgrade();
        assert!(weak.upgrade().is_some());
        drop(t);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    #[should_panic(expected = "was never stored")]
    fn expect_names_the_missing_service() {
        let t = test_app();
        let _ = t.app.expect::<Other>();
    }
}
