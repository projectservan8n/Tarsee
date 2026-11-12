//! Port of `src/hooks/command-logger.js`: the built-in hook that logs every tool run to the daily log.

use serde_json::Value;

use crate::app::{App, WeakApp};
use crate::lib::hooks::{HookOptions, HookRegistry};
use crate::lib::workspace_files::append_daily_log;
use crate::lib::workspace_files::jstext::{js_json_stringify, js_string};
use crate::util::js::utf16_truncate;

pub const NAME: &str = "command-logger";
pub const EVENTS: &[&str] = &["tool:after_execute"];

/// Writes `[tool] <name>(<input, 80 characters>) → <result, 100 characters>` to the daily log. Best effort: nothing
/// is written when the event has no `input` (the JS could not cut the missing JSON and gave up), and a write that
/// fails is ignored.
pub fn handler(app: &App, data: &Value) {
    let Some(input) = data.get("input") else { return };
    let preview = match data.get("result") {
        Some(Value::String(result)) => utf16_truncate(result, 100),
        _ => String::new(),
    };
    let line = format!(
        "[tool] {}({}) → {preview}",
        js_string(data.get("toolName")),
        utf16_truncate(&js_json_stringify(input), 80)
    );
    let _ = append_daily_log(app, &line);
}

/// Registers the hook for its events.
pub fn register(app: &App, registry: &HookRegistry) {
    for event in EVENTS {
        let weak: WeakApp = app.downgrade();
        registry.register(
            event,
            move |data| {
                let weak = weak.clone();
                async move {
                    if let Some(app) = weak.upgrade() {
                        handler(&app, &data);
                    }
                    Ok(Value::Null)
                }
            },
            HookOptions::named(NAME).source("builtin"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::test_app_with_env;
    use serde_json::json;

    fn todays_log(t: &crate::testkit::TestApp) -> String {
        let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
        std::fs::read_to_string(t.config().workspace_dir.join("memory").join(format!("{day}.md")))
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn each_tool_run_is_one_line_in_the_daily_log() {
        let t = test_app_with_env([("TZ", "UTC")]);
        let registry = HookRegistry::new();
        register(&t, &registry);
        let results = registry
            .emit(
                "tool:after_execute",
                json!({"toolName": "web_search", "input": {"query": "x".repeat(100)}, "result": "r".repeat(150)}),
            )
            .await;
        assert_eq!(results[0].error, None);
        let log = todays_log(&t);
        let line = log.lines().last().unwrap();
        let expected = format!(
            "] [tool] web_search({}) → {}",
            &format!("{{\"query\":\"{}\"}}", "x".repeat(100))[..80],
            "r".repeat(100)
        );
        assert!(line.ends_with(&expected), "{line}");
        assert!(line.starts_with("- ["));
    }

    #[test]
    fn without_an_input_nothing_is_written_and_odd_values_print_as_javascript_did() {
        let t = test_app_with_env([("TZ", "UTC")]);
        handler(&t, &json!({"toolName": "x", "result": "ok"}));
        assert_eq!(todays_log(&t), "");
        handler(&t, &json!({"input": null, "result": 5}));
        assert!(todays_log(&t).ends_with("] [tool] undefined(null) → \n"));
    }
}
