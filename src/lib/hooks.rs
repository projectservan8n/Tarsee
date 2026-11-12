//! Port of `src/lib/hooks.js`: the event-driven hook system. Handlers register for lifecycle events and run, in
//! priority order, when one is emitted.
//!
//! The JS registry was a module singleton (`hookRegistry`); here it is a service in the [`App`]
//! ([`HookRegistry::of`]). A handler is an async Rust closure that takes the event's data and returns a value: the
//! built-in hooks (`src/hooks/`) and the workspace's program hooks (`lib/hook_loader.rs`) are both registered as one.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::app::App;

/// A registered handler: the event's data in, its result out.
pub type HookHandler = Arc<dyn Fn(Value) -> BoxFuture<'static, anyhow::Result<Value>> + Send + Sync>;

/// The events Tarsee emits.
pub const HOOK_EVENTS: &[&str] = &[
    "message:received",
    "message:before_send",
    "message:after_send",
    "tool:before_execute",
    "tool:after_execute",
    "session:start",
    "session:end",
    "boot:ready",
    "heartbeat:tick",
    "memory:saved",
    "agent:spawned",
];

/// How long one handler may take before it is given up on (and, being a future, dropped).
pub const HOOK_TIMEOUT: Duration = Duration::from_secs(5);

/// `register`'s options: `{ name = "anonymous", priority = 10, source = "code" }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookOptions {
    pub name: String,
    /// Lower runs first.
    pub priority: i64,
    /// Where the hook came from: "builtin", "workspace" or "code".
    pub source: String,
}

impl Default for HookOptions {
    fn default() -> Self {
        HookOptions {
            name: "anonymous".into(),
            priority: 10,
            source: "code".into(),
        }
    }
}

impl HookOptions {
    pub fn named(name: impl Into<String>) -> Self {
        HookOptions {
            name: name.into(),
            ..Self::default()
        }
    }

    pub fn source(mut self, source: impl Into<String>) -> Self {
        self.source = source.into();
        self
    }

    pub fn priority(mut self, priority: i64) -> Self {
        self.priority = priority;
        self
    }
}

#[derive(Clone)]
struct Registered {
    name: String,
    handler: HookHandler,
    priority: i64,
    source: String,
}

/// What one handler gave for an emitted event: `{ name, result }` or `{ name, error }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HookResult {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One registration, as `list()` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookInfo {
    pub event: String,
    pub name: String,
    pub priority: i64,
    pub source: String,
}

/// The registry: event -> handlers, in the order the events were first registered.
pub struct HookRegistry {
    hooks: Mutex<Vec<(String, Vec<Registered>)>>,
    timeout: Duration,
}

impl Default for HookRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl HookRegistry {
    pub fn new() -> Self {
        Self::with_timeout(HOOK_TIMEOUT)
    }

    /// A registry whose handlers get `timeout` instead of 5 seconds (tests).
    pub fn with_timeout(timeout: Duration) -> Self {
        HookRegistry {
            hooks: Mutex::new(Vec::new()),
            timeout,
        }
    }

    /// The app's registry (`hookRegistry`), made on first use.
    pub fn of(app: &App) -> Arc<HookRegistry> {
        app.get_or_init(HookRegistry::new)
    }

    /// Registers a handler for an event, keeping the event's handlers in priority order (a stable sort, so equal
    /// priorities keep their registration order).
    pub fn register<F, Fut>(&self, event: &str, handler: F, options: HookOptions)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = anyhow::Result<Value>> + Send + 'static,
    {
        let handler: HookHandler = Arc::new(move |data| Box::pin(handler(data)));
        self.register_handler(event, handler, options);
    }

    /// [`register`](Self::register) for a handler already boxed.
    pub fn register_handler(&self, event: &str, handler: HookHandler, options: HookOptions) {
        {
            let mut hooks = self.hooks.lock();
            let index = match hooks.iter().position(|(e, _)| e == event) {
                Some(index) => index,
                None => {
                    hooks.push((event.to_string(), Vec::new()));
                    hooks.len() - 1
                }
            };
            let handlers = &mut hooks[index].1;
            handlers.push(Registered {
                name: options.name.clone(),
                handler,
                priority: options.priority,
                source: options.source,
            });
            handlers.sort_by_key(|h| h.priority);
        }
        log::info!("[hooks] registered: {} on {event}", options.name);
    }

    /// Runs every handler of `event` in turn, each with up to the timeout (5 seconds), and returns what each gave. A
    /// handler that fails or runs out of time is logged and its error recorded; the others still run.
    pub async fn emit(&self, event: &str, data: Value) -> Vec<HookResult> {
        let handlers: Vec<Registered> = self
            .hooks
            .lock()
            .iter()
            .find(|(e, _)| e == event)
            .map(|(_, list)| list.clone())
            .unwrap_or_default();
        let mut results = Vec::with_capacity(handlers.len());
        for h in handlers {
            let outcome = match tokio::time::timeout(self.timeout, (h.handler)(data.clone())).await {
                Ok(Ok(result)) => Ok(result),
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err("Hook timeout".to_string()),
            };
            match outcome {
                Ok(result) => results.push(HookResult {
                    name: h.name,
                    result: Some(result),
                    error: None,
                }),
                Err(message) => {
                    log::warn!("[hooks] {} error on {event}: {message}", h.name);
                    results.push(HookResult {
                        name: h.name,
                        result: None,
                        error: Some(message),
                    });
                }
            }
        }
        results
    }

    /// Removes every handler of that name, from every event. An event left with none is still listed by
    /// [`get_events`](Self::get_events).
    pub fn unregister(&self, name: &str) {
        for (_, handlers) in self.hooks.lock().iter_mut() {
            handlers.retain(|h| h.name != name);
        }
    }

    /// Every registration, event by event.
    pub fn list(&self) -> Vec<HookInfo> {
        self.hooks
            .lock()
            .iter()
            .flat_map(|(event, handlers)| {
                handlers.iter().map(move |h| HookInfo {
                    event: event.clone(),
                    name: h.name.clone(),
                    priority: h.priority,
                    source: h.source.clone(),
                })
            })
            .collect()
    }

    /// The events anything was ever registered for.
    pub fn get_events(&self) -> Vec<String> {
        self.hooks.lock().iter().map(|(e, _)| e.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{CapturedLogs, test_app};
    use serde_json::json;

    #[tokio::test]
    async fn handlers_run_in_priority_order_and_each_result_is_kept() {
        let registry = HookRegistry::new();
        let logs = CapturedLogs::start();
        registry.register(
            "message:received",
            |data| async move { Ok(json!({"saw": data["text"]})) },
            HookOptions::named("second").priority(10),
        );
        registry.register(
            "message:received",
            |_| async { Ok(json!("first")) },
            HookOptions::named("first").priority(1),
        );
        registry.register(
            "message:received",
            |_| async { Ok(json!("third")) },
            HookOptions::named("third"),
        );
        registry.register("message:received", |_| async { anyhow::bail!("boom") }, HookOptions::default());
        let results = registry.emit("message:received", json!({"text": "hi"})).await;
        assert_eq!(
            serde_json::to_value(&results).unwrap(),
            json!([
                {"name": "first", "result": "first"},
                {"name": "second", "result": {"saw": "hi"}},
                {"name": "third", "result": "third"},
                {"name": "anonymous", "error": "boom"},
            ])
        );
        assert_eq!(
            logs.infos(),
            [
                "[hooks] registered: second on message:received",
                "[hooks] registered: first on message:received",
                "[hooks] registered: third on message:received",
                "[hooks] registered: anonymous on message:received",
            ]
        );
        assert_eq!(logs.warnings(), ["[hooks] anonymous error on message:received: boom"]);
        assert!(registry.emit("session:start", json!({})).await.is_empty());
    }

    #[tokio::test]
    async fn a_handler_that_takes_too_long_times_out_and_the_rest_still_run() {
        let registry = HookRegistry::with_timeout(Duration::from_millis(50));
        registry.register(
            "boot:ready",
            |_| async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(Value::Null)
            },
            HookOptions::named("slow"),
        );
        registry.register("boot:ready", |_| async { Ok(json!(1)) }, HookOptions::named("quick"));
        let results = registry.emit("boot:ready", json!({})).await;
        assert_eq!(results[0].error.as_deref(), Some("Hook timeout"));
        assert_eq!(results[1].result, Some(json!(1)));
        assert_eq!(HookRegistry::new().timeout, Duration::from_secs(5));
    }

    #[tokio::test]
    async fn unregister_list_and_events() {
        let registry = HookRegistry::new();
        let ok = |_| async { Ok(Value::Null) };
        registry.register("a", ok, HookOptions::named("x").source("workspace"));
        registry.register("b", ok, HookOptions::named("y").priority(3));
        registry.register("b", ok, HookOptions::named("x"));
        assert_eq!(
            serde_json::to_value(registry.list()).unwrap(),
            json!([
                {"event": "a", "name": "x", "priority": 10, "source": "workspace"},
                {"event": "b", "name": "y", "priority": 3, "source": "code"},
                {"event": "b", "name": "x", "priority": 10, "source": "code"},
            ])
        );
        registry.unregister("x");
        assert_eq!(registry.list().len(), 1);
        assert_eq!(registry.get_events(), ["a", "b"]);
        assert!(registry.emit("a", json!({})).await.is_empty());
    }

    #[test]
    fn the_app_has_one_registry() {
        let t = test_app();
        HookRegistry::of(&t).register("boot:ready", |_| async { Ok(Value::Null) }, HookOptions::default());
        assert_eq!(HookRegistry::of(&t).list().len(), 1);
        assert_eq!(HOOK_EVENTS.len(), 11);
        assert!(HOOK_EVENTS.contains(&"tool:after_execute"));
    }
}
