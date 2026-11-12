//! A settings store that lives in memory: the plain `{ get(key) { ... } }` object the Node tests passed where a
//! function only needed to read and write settings.

use std::collections::BTreeMap;

use parking_lot::Mutex;
use serde_json::Value;

use crate::db::settings::Settings;

#[derive(Default)]
pub struct MemorySettings {
    values: Mutex<BTreeMap<String, Value>>,
}

impl MemorySettings {
    pub fn new() -> Self {
        Self::default()
    }

    /// A store that already holds these settings.
    pub fn from_pairs<K: Into<String>>(pairs: impl IntoIterator<Item = (K, Value)>) -> Self {
        MemorySettings {
            values: Mutex::new(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect()),
        }
    }

    /// Every setting now, by key.
    pub fn snapshot(&self) -> BTreeMap<String, Value> {
        self.values.lock().clone()
    }
}

impl Settings for MemorySettings {
    fn get(&self, key: &str) -> Option<Value> {
        self.values.lock().get(key).cloned()
    }

    fn set(&self, key: &str, value: Value) -> anyhow::Result<()> {
        self.values.lock().insert(key.to_string(), value);
        Ok(())
    }

    fn delete(&self, key: &str) -> bool {
        self.values.lock().remove(key).is_some()
    }

    fn get_by_prefix(&self, prefix: &str) -> Vec<(String, Value)> {
        self.values
            .lock()
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn it_reads_writes_deletes_and_lists_by_prefix() {
        let store = MemorySettings::from_pairs([("ai.b", json!(2)), ("ai.a", json!("one")), ("voice.x", json!(true))]);
        assert_eq!(store.get("ai.a"), Some(json!("one")));
        assert_eq!(store.get("missing"), None);
        assert_eq!(
            store.get_by_prefix("ai."),
            vec![("ai.a".to_string(), json!("one")), ("ai.b".to_string(), json!(2))]
        );
        store.set("ai.c", json!({"k": 1})).unwrap();
        assert!(store.delete("ai.a"));
        assert!(!store.delete("ai.a"));
        assert_eq!(store.snapshot().len(), 3);
    }

    #[test]
    fn get_string_is_for_text_settings_only() {
        let store = MemorySettings::from_pairs([("name", json!("Tarsee")), ("blank", json!("")), ("n", json!(5))]);
        let store: &dyn Settings = &store;
        assert_eq!(store.get_string("name").as_deref(), Some("Tarsee"));
        assert_eq!(store.get_string("blank"), None);
        assert_eq!(store.get_string("n"), None);
        assert_eq!(store.get_string("missing"), None);
    }
}
