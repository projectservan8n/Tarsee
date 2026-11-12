//! Stubbed agent tools: stands in for `lib/tools.rs` behind `lib::tool_api::execute_tool`. It records every call (the
//! tool's name, its arguments and its context) and answers by tool name.
//!
//! ```ignore
//! let t = test_app();
//! let tools = FakeTools::install(&t.app);
//! tools.respond("send_message", "Message sent to telegram (chat 42): Done");
//! tools.respond_with("schedule_task", |call| match &call.ctx.background {
//!     Some(by) => format!("schedule_task refused: {by}"),
//!     None => "Scheduled.".into(),
//! });
//! // ... run the code under test ...
//! let calls = tools.calls();
//! assert_eq!(calls[0].args["channel"], "telegram");
//! assert_eq!(calls[0].ctx.background.as_deref(), Some("cron"));
//! ```
//!
//! A tool nothing was scripted for answers what the real one says for a name it does not know:
//! `Unknown tool: <name>`.

use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;

use crate::app::App;
use crate::lib::tool_api::{ToolContext, ToolExecutor, ToolOutput, install_tool_executor};

/// One call the fake tools were asked to run.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    /// The tool's name, without the MCP prefix: "send_message".
    pub name: String,
    pub args: Value,
    pub ctx: ToolContext,
}

type Responder = Arc<dyn Fn(&ToolCall) -> ToolOutput + Send + Sync>;

#[derive(Default)]
pub struct FakeTools {
    /// Newest first.
    responders: Mutex<Vec<(String, Responder)>>,
    calls: Mutex<Vec<ToolCall>>,
}

impl FakeTools {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// A new one, installed as the app's tool executor.
    pub fn install(app: &App) -> Arc<Self> {
        let tools = Self::new();
        install_tool_executor(app, tools.clone());
        tools
    }

    /// Answers every call of the tool `name` with this text. The newest answer for a name wins.
    pub fn respond(&self, name: impl Into<String>, output: impl Into<String>) {
        let output = output.into();
        self.respond_with(name, move |_| output.clone());
    }

    /// Answers every call of the tool `name` with what `responder` returns for it.
    pub fn respond_with(
        &self,
        name: impl Into<String>,
        responder: impl Fn(&ToolCall) -> ToolOutput + Send + Sync + 'static,
    ) {
        self.responders.lock().insert(0, (name.into(), Arc::new(responder)));
    }

    /// Every call so far, oldest first.
    pub fn calls(&self) -> Vec<ToolCall> {
        self.calls.lock().clone()
    }

    /// The calls of one tool.
    pub fn calls_to(&self, name: &str) -> Vec<ToolCall> {
        self.calls
            .lock()
            .iter()
            .filter(|call| call.name == name)
            .cloned()
            .collect()
    }

    /// Forgets the recorded calls; the answers stay.
    pub fn clear_calls(&self) {
        self.calls.lock().clear();
    }
}

#[async_trait]
impl ToolExecutor for FakeTools {
    async fn execute_tool(&self, _app: &App, name: &str, args: Value, ctx: &ToolContext) -> ToolOutput {
        let call = ToolCall {
            name: name.to_string(),
            args,
            ctx: ctx.clone(),
        };
        self.calls.lock().push(call.clone());
        let responder = self
            .responders
            .lock()
            .iter()
            .find(|(tool, _)| tool == name)
            .map(|(_, responder)| responder.clone());
        match responder {
            Some(responder) => responder(&call),
            None => format!("Unknown tool: {name}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::lib::tool_api::execute_tool;
    use crate::testkit::test_app;

    #[tokio::test]
    async fn it_answers_by_tool_name_and_records_every_call() {
        let t = test_app();
        let tools = FakeTools::install(&t.app);
        tools.respond("send_message", "Message sent to telegram (chat 42): Done");

        let ctx = ToolContext {
            background: Some("cron".into()),
            ..ToolContext::for_conversation("conv-1")
        };
        let said = execute_tool(
            &t.app,
            "send_message",
            json!({"channel": "telegram", "message": "Done"}),
            &ctx,
        )
        .await;
        assert_eq!(said, "Message sent to telegram (chat 42): Done");
        execute_tool(&t.app, "datetime", json!({}), &ToolContext::default()).await;

        let calls = tools.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "send_message");
        assert_eq!(calls[0].args, json!({"channel": "telegram", "message": "Done"}));
        assert_eq!(calls[0].ctx, ctx);
        assert_eq!(tools.calls_to("datetime").len(), 1);
        assert!(tools.calls_to("exec").is_empty());
        tools.clear_calls();
        assert!(tools.calls().is_empty());
    }

    /// `lib/tools.js` `executeTool`'s own answer for a name it does not know.
    #[tokio::test]
    async fn a_tool_nothing_was_scripted_for_is_unknown() {
        let t = test_app();
        let tools = FakeTools::install(&t.app);
        assert_eq!(
            execute_tool(&t.app, "nope", json!({}), &ToolContext::default()).await,
            "Unknown tool: nope"
        );
        assert_eq!(tools.calls().len(), 1, "it is recorded all the same");
    }

    #[tokio::test]
    async fn a_responder_sees_the_call_and_the_newest_answer_wins() {
        let t = test_app();
        let tools = FakeTools::install(&t.app);
        tools.respond("schedule_task", "Scheduled.");
        tools.respond_with("schedule_task", |call| match &call.ctx.background {
            Some(by) => format!("schedule_task refused: {by} asked for {}", call.args["name"]),
            None => "Scheduled, paused.".into(),
        });
        let from_cron = ToolContext {
            background: Some("cron".into()),
            ..Default::default()
        };
        assert_eq!(
            execute_tool(&t.app, "schedule_task", json!({"name": "Again"}), &from_cron).await,
            "schedule_task refused: cron asked for \"Again\""
        );
        assert_eq!(
            execute_tool(&t.app, "schedule_task", json!({}), &ToolContext::default()).await,
            "Scheduled, paused."
        );
    }
}
