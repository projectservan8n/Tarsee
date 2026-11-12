//! Port of `src/db/settings.js`: the key-value settings store. The store itself is not ported yet: work package S1
//! (docs/rust-port/PLAN.md). What is here already is the [`Settings`] trait, which everything below the store uses.

use serde_json::Value;

/// The settings store, as the code that only reads and writes settings sees it.
///
/// The Node code handed the store itself around and called `store.get(key)` on it, and its tests often passed a
/// plain object with a `get` instead. This trait is that: [`SettingsStore`](self) (package S1) implements it over
/// the database, and `testkit::MemorySettings` implements it over a map. Take `&dyn Settings` wherever the Node
/// function took `store`, `settings` or `settingsStore` and used only these calls.
pub trait Settings: Send + Sync {
    /// The setting's value, or `None` when it is not set (the JS `null`). Stored JSON comes back parsed, a stored
    /// plain string as a string, and secrets decrypted.
    fn get(&self, key: &str) -> Option<Value>;

    /// Saves a value (`store.set(key, value)`). Secrets are encrypted at rest by the real store.
    fn set(&self, key: &str, value: Value) -> anyhow::Result<()>;

    /// Deletes a setting; true if there was one.
    fn delete(&self, key: &str) -> bool;

    /// Every setting whose key starts with `prefix`, ordered by key, values as [`get`](Self::get) gives them.
    fn get_by_prefix(&self, prefix: &str) -> Vec<(String, Value)>;

    /// The value when it is a string (not empty), else `None`: the common `store.get(key) || null` on a text setting.
    fn get_string(&self, key: &str) -> Option<String> {
        match self.get(key) {
            Some(Value::String(text)) if !text.is_empty() => Some(text),
            _ => None,
        }
    }
}
