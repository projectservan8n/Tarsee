//! The environment variables, as a value.
//!
//! The Node version read and wrote `process.env` from everywhere. Reading the real process environment from code
//! under test makes tests depend on the machine and on each other, so the process environment is read exactly once,
//! in `main`, into an [`Env`]. Everything else takes an `Env` (usually `app.env()`), and tests build their own.
//!
//! Rule for the whole crate: `std::env::var` appears only in `main.rs` and here.

use std::collections::BTreeMap;
use std::sync::Arc;

use parking_lot::RwLock;

/// A shared, changeable set of environment variables. Cloning shares the same set.
#[derive(Clone, Default)]
pub struct Env {
    vars: Arc<RwLock<BTreeMap<String, String>>>,
}

impl Env {
    /// An empty environment.
    pub fn new() -> Self {
        Self::default()
    }

    /// The real process environment, read once. Variables that are not valid Unicode are left out.
    pub fn from_process() -> Self {
        Self::from_pairs(std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))))
    }

    pub fn from_pairs<K: Into<String>, V: Into<String>>(pairs: impl IntoIterator<Item = (K, V)>) -> Self {
        let vars = pairs.into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        Env {
            vars: Arc::new(RwLock::new(vars)),
        }
    }

    /// The variable's value, exactly as set (`process.env.NAME`).
    pub fn get(&self, name: &str) -> Option<String> {
        self.vars.read().get(name).cloned()
    }

    /// The value with surrounding whitespace removed, or `None` when it is unset or blank
    /// (`process.env.NAME?.trim() || null`).
    pub fn trimmed(&self, name: &str) -> Option<String> {
        let value = self.get(name)?;
        let value = value.trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    }

    /// Whether the variable is set to anything but the empty string (`!!process.env.NAME`).
    pub fn is_set(&self, name: &str) -> bool {
        self.vars.read().get(name).is_some_and(|v| !v.is_empty())
    }

    pub fn set(&self, name: impl Into<String>, value: impl Into<String>) {
        self.vars.write().insert(name.into(), value.into());
    }

    pub fn remove(&self, name: &str) -> Option<String> {
        self.vars.write().remove(name)
    }

    /// A copy of every variable now, sorted by name (`{ ...process.env }`).
    pub fn snapshot(&self) -> BTreeMap<String, String> {
        self.vars.read().clone()
    }

    /// A separate environment with the same variables: changing one does not change the other.
    pub fn fork(&self) -> Self {
        Self::from_pairs(self.snapshot())
    }

    pub fn len(&self) -> usize {
        self.vars.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.vars.read().is_empty()
    }
}

impl std::fmt::Debug for Env {
    /// Names only: values are often secrets.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set().entries(self.vars.read().keys()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_trimmed_and_is_set_follow_the_javascript_idioms() {
        let env = Env::from_pairs([("A", " x "), ("BLANK", "   "), ("EMPTY", "")]);
        assert_eq!(env.get("A").as_deref(), Some(" x "));
        assert_eq!(env.trimmed("A").as_deref(), Some("x"));
        assert_eq!(env.trimmed("BLANK"), None);
        assert_eq!(env.trimmed("MISSING"), None);
        assert!(env.is_set("A"));
        assert!(env.is_set("BLANK"));
        assert!(!env.is_set("EMPTY"));
        assert!(!env.is_set("MISSING"));
    }

    #[test]
    fn clones_share_and_forks_do_not() {
        let env = Env::new();
        let shared = env.clone();
        let fork = env.fork();
        env.set("K", "1");
        assert_eq!(shared.get("K").as_deref(), Some("1"));
        assert_eq!(fork.get("K"), None);
        assert_eq!(env.remove("K").as_deref(), Some("1"));
        assert!(shared.is_empty());
    }

    #[test]
    fn debug_shows_names_never_values() {
        let env = Env::from_pairs([("SECRET_KEY", "hunter2")]);
        let shown = format!("{env:?}");
        assert!(shown.contains("SECRET_KEY"));
        assert!(!shown.contains("hunter2"));
    }
}
