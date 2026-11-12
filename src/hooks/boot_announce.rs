//! Port of `src/hooks/boot-announce.js`: the built-in hook that says, once everything has started, that Tarsee is
//! ready.

use serde_json::Value;

use crate::app::App;
use crate::lib::hooks::{HookOptions, HookRegistry};

pub const NAME: &str = "boot-announce";
pub const EVENTS: &[&str] = &["boot:ready"];

pub async fn handler(_data: Value) -> anyhow::Result<Value> {
    log::info!("[hooks] Tarsee is fully initialized and ready.");
    Ok(Value::Null)
}

/// Registers the hook for its events.
pub fn register(_app: &App, registry: &HookRegistry) {
    for event in EVENTS {
        registry.register(event, handler, HookOptions::named(NAME).source("builtin"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{CapturedLogs, test_app};

    #[tokio::test]
    async fn it_announces_the_boot() {
        let t = test_app();
        let registry = HookRegistry::new();
        register(&t, &registry);
        let logs = CapturedLogs::start();
        let results = registry.emit("boot:ready", serde_json::json!({})).await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "boot-announce");
        assert_eq!(logs.infos(), ["[hooks] Tarsee is fully initialized and ready."]);
    }
}
