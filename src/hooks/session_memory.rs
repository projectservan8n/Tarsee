//! Port of `src/hooks/session-memory.js`: the built-in hook that notes a long conversation's end in the daily log.

use serde_json::Value;

use crate::app::{App, WeakApp};
use crate::lib::hooks::{HookOptions, HookRegistry};
use crate::lib::workspace_files::append_daily_log;
use crate::lib::workspace_files::jstext::{js_string, js_to_number};
use crate::util::js::truthy;

pub const NAME: &str = "session-memory";
pub const EVENTS: &[&str] = &["session:end"];

/// `data.messageCount > 5`, as JavaScript compares: the value made a number (text read as `Number` reads it, so
/// "0x10" is 16 and "inf" is NaN; an array or object through its text; true is 1, null 0).
fn more_than_five(count: Option<&Value>) -> bool {
    let n = match count {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Null) => 0.0,
        None => f64::NAN,
        Some(Value::String(s)) => js_to_number(s),
        other => js_to_number(&js_string(other)),
    };
    n > 5.0
}

/// Writes `[session] Ended conversation "<title>" (<n> messages)` to the daily log for a conversation of more than
/// five messages. Best effort.
pub fn handler(app: &App, data: &Value) {
    let count = data.get("messageCount");
    if !more_than_five(count) {
        return;
    }
    let title = data
        .get("title")
        .filter(|t| truthy(t))
        .map(|t| js_string(Some(t)))
        .unwrap_or_else(|| "untitled".into());
    let _ = append_daily_log(
        app,
        &format!(
            "[session] Ended conversation \"{title}\" ({} messages)",
            js_string(count)
        ),
    );
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
    async fn only_conversations_of_more_than_five_messages_are_noted() {
        let t = test_app_with_env([("TZ", "UTC")]);
        let registry = HookRegistry::new();
        register(&t, &registry);
        registry
            .emit("session:end", json!({"title": "Short", "messageCount": 5}))
            .await;
        assert_eq!(todays_log(&t), "");
        registry
            .emit("session:end", json!({"title": "Taxes", "messageCount": 6}))
            .await;
        assert!(todays_log(&t).ends_with("] [session] Ended conversation \"Taxes\" (6 messages)\n"));
        handler(&t, &json!({"messageCount": "12"}));
        assert!(todays_log(&t).ends_with("] [session] Ended conversation \"untitled\" (12 messages)\n"));
        handler(&t, &json!({"messageCount": true}));
        handler(&t, &json!({"title": "x"}));
        assert_eq!(todays_log(&t).matches("[session]").count(), 2);
    }

    #[test]
    fn a_count_given_as_text_compares_as_javascript_compares_it() {
        // `value > 5` in JavaScript, checked against Node.
        for (count, more) in [
            (json!("0x10"), true),
            (json!("inf"), false),
            (json!("infinity"), false),
            (json!("Infinity"), true),
            (json!(" 12 "), true),
            (json!("5"), false),
            (json!(""), false),
            (json!([6]), true),
            (json!({"a": 9}), false),
            (json!(true), false),
            (json!(null), false),
            (json!(5.5), true),
        ] {
            assert_eq!(more_than_five(Some(&count)), more, "{count}");
        }
        assert!(!more_than_five(None));
    }
}
