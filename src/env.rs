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
///
/// On Windows a variable's name matches whatever its case, as in the system itself and in Node's `process.env`
/// there: the search path is usually named `Path`, and `env.get("PATH")` must still find it. The names keep the
/// case they were set with, so [`snapshot`](Env::snapshot) hands a program the names the system gave.
#[derive(Clone)]
pub struct Env {
    vars: Arc<RwLock<BTreeMap<String, String>>>,
    ignore_case: bool,
}

impl Default for Env {
    fn default() -> Self {
        Env {
            vars: Arc::default(),
            ignore_case: cfg!(windows),
        }
    }
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
        let env = Env::default();
        for (name, value) in pairs {
            env.set(name, value);
        }
        env
    }

    /// Whether names match whatever their case: true on Windows, false elsewhere. A test sets it to check both
    /// behaviours on one system.
    pub fn with_case_insensitive_names(mut self, on: bool) -> Self {
        self.ignore_case = on;
        self
    }

    /// The name this variable is stored under: the name itself, or on Windows a name that differs only in case.
    fn stored_name(&self, vars: &BTreeMap<String, String>, name: &str) -> Option<String> {
        if vars.contains_key(name) {
            return Some(name.to_string());
        }
        if !self.ignore_case {
            return None;
        }
        vars.keys().find(|key| key.eq_ignore_ascii_case(name)).cloned()
    }

    /// The variable's value, exactly as set (`process.env.NAME`).
    pub fn get(&self, name: &str) -> Option<String> {
        let vars = self.vars.read();
        let stored = self.stored_name(&vars, name)?;
        vars.get(&stored).cloned()
    }

    /// The value with surrounding whitespace removed, or `None` when it is unset or blank
    /// (`process.env.NAME?.trim() || null`).
    pub fn trimmed(&self, name: &str) -> Option<String> {
        let value = self.get(name)?;
        let value = crate::util::js::trim(&value);
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    }

    /// Whether the variable is set to anything but the empty string (`!!process.env.NAME`).
    pub fn is_set(&self, name: &str) -> bool {
        self.get(name).is_some_and(|v| !v.is_empty())
    }

    /// Sets a variable. On Windows a variable already there under another case keeps its name and takes the value.
    pub fn set(&self, name: impl Into<String>, value: impl Into<String>) {
        let name = name.into();
        let mut vars = self.vars.write();
        let stored = self.stored_name(&vars, &name).unwrap_or(name);
        vars.insert(stored, value.into());
    }

    pub fn remove(&self, name: &str) -> Option<String> {
        let mut vars = self.vars.write();
        let stored = self.stored_name(&vars, name)?;
        vars.remove(&stored)
    }

    /// A copy of every variable now, sorted by name (`{ ...process.env }`).
    pub fn snapshot(&self) -> BTreeMap<String, String> {
        self.vars.read().clone()
    }

    /// A separate environment with the same variables: changing one does not change the other.
    pub fn fork(&self) -> Self {
        Self::from_pairs(self.snapshot()).with_case_insensitive_names(self.ignore_case)
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
    fn on_windows_a_name_matches_whatever_its_case_and_keeps_the_case_it_was_set_with() {
        let env = Env::new().with_case_insensitive_names(true);
        env.set("Path", "C:\\bin");
        assert_eq!(env.get("PATH").as_deref(), Some("C:\\bin"));
        assert_eq!(env.get("path").as_deref(), Some("C:\\bin"));
        assert!(env.is_set("PATH"));
        env.set("PATH", "D:\\tools");
        assert_eq!(
            env.snapshot().into_iter().collect::<Vec<_>>(),
            vec![("Path".to_string(), "D:\\tools".to_string())]
        );
        assert_eq!(env.fork().get("pAtH").as_deref(), Some("D:\\tools"));
        assert_eq!(env.remove("PATH").as_deref(), Some("D:\\tools"));
        assert!(env.is_empty());
    }

    #[test]
    fn elsewhere_a_name_matches_only_in_its_own_case() {
        let env = Env::new().with_case_insensitive_names(false);
        env.set("Path", "a");
        assert_eq!(env.get("PATH"), None);
        env.set("PATH", "b");
        assert_eq!(env.len(), 2);
        assert_eq!(env.remove("path"), None);
    }

    #[test]
    fn trimmed_removes_what_javascript_trim_removes() {
        let env = Env::from_pairs([("BOM", "\u{FEFF} x \u{FEFF}"), ("NEL", "\u{0085}x\u{0085}")]);
        assert_eq!(env.trimmed("BOM").as_deref(), Some("x"));
        assert_eq!(env.trimmed("NEL").as_deref(), Some("\u{0085}x\u{0085}"));
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
