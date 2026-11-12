//! How the agent's tools are called from outside `lib/tools.rs`.
//!
//! The Node code imported `executeTool` from `lib/tools.js` wherever a tool had to run: the MCP server
//! (`ai/tarsee-mcp.js`, one call per tool), a scheduled task's direct action (`lib/cron.js`), `/send` in a chat
//! (`lib/commands.js`) and a voice call's handoff (`lib/voice-call.js`). `lib/tools.js` in turn imported most of
//! those, in a circle. Here the call goes through this module instead: [`execute_tool`] hands it to the
//! [`ToolExecutor`] stored in the `App`, which `lib/tools.rs` (package S3) installs at boot and a test replaces with
//! `testkit::FakeTools`.
//!
//! ```ignore
//! let said = execute_tool(&app, "send_message", json!({"channel": "telegram", "message": "Done"}), &ctx).await;
//! ```

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app::App;

/// What a tool gives back: the text the model reads. Always text, never a failure: a tool that fails, is refused by
/// Settings > Tool Permissions or does not exist says so in words ("Tool error (exec): ...", "Refused by security
/// policy: ...", "Unknown tool: ...").
pub type ToolOutput = String;

/// The context a tool call runs in: the Node `toolCtx` / `ctx` object, without what now comes from the `App`.
///
/// The Node object also carried `db`, `settingsStore`, `channelManager` and `auditLog`. Those are the app's own
/// (`app.db()`, the settings store, `channels::api::channel_manager(app)`, the audit log), so a turn's tools reach the
/// same ones whoever started the turn. That is what `setToolsChannelManager` did for the channel manager: a Telegram
/// turn built its context without one and still had to reach Telegram (`executeTool` fell back to the app's).
///
/// This holds for a tool context only. A chat command, the system prompt and the diagnostics have the channel
/// manager only when their own caller handed it over: `lib::command_api::CommandContext::channel_manager`, and
/// `docs/rust-port/INTERFACES.md`, "Rules for all of them".
///
/// The turn layer (`ai/turn.rs`) reads the conversation from here too: the chat's pick, its session, the live
/// timeline and Stop all go by `conversation_id`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolContext {
    /// The chat the turn runs in. `None` for work with no chat of its own: a scheduled task, the heartbeat,
    /// BOOT.md, a subagent, ACP, a Verify probe.
    pub conversation_id: Option<String>,
    /// The stored message this turn answers: its pictures and files are kept with it (`lib/sent-files.js`,
    /// `ai/media.js`).
    pub message_id: Option<String>,
    /// True for a turn from the dashboard (the web chat and its WebSocket): a file the agent hands over
    /// (`send_file` to "web") goes to the chat on screen, whatever channel that chat belongs to.
    pub dashboard: bool,
    /// What started unattended work: "cron" (a scheduled task or a webhook), "heartbeat", "boot", or "background".
    /// `schedule_task` refuses in it, so background work never schedules more. The turn layer sets it from the
    /// turn's `live_source` when `background` is on; a scheduled task's direct action sets "cron" itself.
    pub background: Option<String>,
    /// The channel a call came in on, for Tool Permissions' per-channel rules and the audit log's actor
    /// (`checkToolPolicy`). No caller sets it today.
    pub channel: Option<String>,
    /// The turn's id on the live timeline. The Codex tools' grant adds it (`ai/turn.js`: `{ ...toolCtx, turnId,
    /// provider }`); it names the folder long tool results are saved in (`ai/mcp-http.js`).
    pub turn_id: Option<String>,
    /// The AI the turn runs on, added by the Codex tools' grant with `turn_id`.
    pub provider: Option<String>,
    /// True on the turns of a Verify probe (`ai/verify-model.js` `toolCtxFor`), which also carry no conversation
    /// and no message. Nothing reads it today.
    pub verify: bool,
}

impl ToolContext {
    /// A context for a chat: `{ conversationId }`.
    pub fn for_conversation(conversation_id: impl Into<String>) -> Self {
        ToolContext {
            conversation_id: Some(conversation_id.into()),
            ..Default::default()
        }
    }
}

/// What runs a tool: `lib/tools.js` `executeTool(toolName, toolInput, ctx)`, with Tool Permissions and the audit
/// log applied. Package S3 implements it in `lib/tools.rs`.
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Runs the tool `name` (the name without the MCP prefix: "send_message", not "tarsee_send_message") with its
    /// arguments, and gives back what the model reads.
    async fn execute_tool(&self, app: &App, name: &str, args: Value, ctx: &ToolContext) -> ToolOutput;
}

/// The executor the app holds (a service).
pub struct InstalledToolExecutor(pub Arc<dyn ToolExecutor>);

/// Stores the app's tool executor, replacing any there was. `lib/tools.rs` does this at boot; a test installs
/// `testkit::FakeTools`.
pub fn install_tool_executor(app: &App, executor: Arc<dyn ToolExecutor>) {
    app.set(InstalledToolExecutor(executor));
}

/// The app's tool executor, if one was installed.
pub fn tool_executor(app: &App) -> Option<Arc<dyn ToolExecutor>> {
    app.get::<InstalledToolExecutor>().map(|installed| installed.0.clone())
}

/// What [`execute_tool`] answers when no executor was installed.
pub const TOOLS_NOT_INSTALLED: &str = "Tarsee's tools are not installed in this app.";

/// Runs one of the agent's tools: the Node `executeTool(toolName, toolInput, ctx)`.
///
/// With no executor installed it answers the way a failing tool does, in words:
/// `Tool error (<name>): Tarsee's tools are not installed in this app.`
pub async fn execute_tool(app: &App, name: &str, args: Value, ctx: &ToolContext) -> ToolOutput {
    match tool_executor(app) {
        Some(executor) => executor.execute_tool(app, name, args, ctx).await,
        None => format!("Tool error ({name}): {TOOLS_NOT_INSTALLED}"),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testkit::test_app;

    struct Shout;

    #[async_trait]
    impl ToolExecutor for Shout {
        async fn execute_tool(&self, _app: &App, name: &str, args: Value, ctx: &ToolContext) -> ToolOutput {
            format!(
                "{name} {} in {}",
                args["text"].as_str().unwrap_or("").to_uppercase(),
                ctx.conversation_id.as_deref().unwrap_or("no chat")
            )
        }
    }

    #[tokio::test]
    async fn with_nothing_installed_a_tool_says_so_in_words() {
        let t = test_app();
        assert!(tool_executor(&t.app).is_none());
        let said = execute_tool(&t.app, "send_message", json!({}), &ToolContext::default()).await;
        assert_eq!(
            said,
            "Tool error (send_message): Tarsee's tools are not installed in this app."
        );
    }

    #[tokio::test]
    async fn a_call_goes_to_the_installed_executor_with_its_arguments_and_context() {
        let t = test_app();
        install_tool_executor(&t.app, Arc::new(Shout));
        let ctx = ToolContext::for_conversation("conv-1");
        assert_eq!(
            execute_tool(&t.app, "echo", json!({"text": "hi"}), &ctx).await,
            "echo HI in conv-1"
        );
        assert_eq!(
            execute_tool(&t.app, "echo", json!({"text": "hi"}), &ToolContext::default()).await,
            "echo HI in no chat"
        );
    }

    #[tokio::test]
    async fn each_app_has_its_own_executor() {
        let a = test_app();
        let b = test_app();
        install_tool_executor(&a.app, Arc::new(Shout));
        assert!(tool_executor(&a.app).is_some());
        assert!(tool_executor(&b.app).is_none());
    }

    /// The Node tool context's own keys (`routes/chat.js`: `{ db, settingsStore, conversationId, channelManager,
    /// dashboard: true, messageId }`; the Codex grant adds `turnId` and `provider`; `ai/turn.js` adds
    /// `background`; `ai/verify-model.js` adds `verify`), without the four the `App` now holds.
    #[test]
    fn the_context_reads_and_writes_the_node_keys() {
        let ctx: ToolContext = serde_json::from_value(json!({
            "conversationId": "c1", "messageId": "m1", "dashboard": true, "background": "cron",
            "turnId": "t1", "provider": "openai", "verify": true
        }))
        .unwrap();
        assert_eq!(ctx.conversation_id.as_deref(), Some("c1"));
        assert_eq!(ctx.message_id.as_deref(), Some("m1"));
        assert!(ctx.dashboard);
        assert_eq!(ctx.background.as_deref(), Some("cron"));
        assert_eq!(ctx.turn_id.as_deref(), Some("t1"));
        assert_eq!(ctx.provider.as_deref(), Some("openai"));
        assert!(ctx.verify);
        assert_eq!(ctx.channel, None);
        assert_eq!(
            serde_json::to_value(ToolContext::for_conversation("c1")).unwrap(),
            json!({
                "conversationId": "c1", "messageId": null, "dashboard": false, "background": null,
                "channel": null, "turnId": null, "provider": null, "verify": false
            })
        );
        assert_eq!(
            serde_json::from_value::<ToolContext>(json!({})).unwrap(),
            ToolContext::default()
        );
    }
}
