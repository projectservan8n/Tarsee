//! How chat commands (`/clear`, `/model`, `/cron list`, ...) are run from the channels and the routes.
//!
//! Every channel and the web chat imported three things from `lib/commands.js`: `processCommand(message, ctx)`,
//! `extractPlaybookPrompt(cmdResult)` and `getCommandList()`. `lib/commands.js` in turn imported the tools, the
//! scheduled tasks and the model catalogue, which lead back to the channels. Here the three go through this module:
//! [`process_command`] and [`get_command_list`] hand the call to the [`CommandHandler`] stored in the `App`, which
//! `lib/commands.rs` (package K1) installs at boot and a test replaces with `testkit::FakeCommands`.
//! [`extract_playbook_prompt`] only reads a result, so it lives here whole.
//!
//! ```ignore
//! if text.starts_with('/') {
//!     let result = process_command(&app, &text, &CommandContext { platform: Some("telegram".into()), owner, conversation_id }).await?;
//!     if result.handled {
//!         match extract_playbook_prompt(&result).filter(|playbook| !playbook.is_empty()) {
//!             Some(playbook) => ai_prompt_override = Some(playbook),          // the AI gets the playbook as the user's turn
//!             None => return reply(result.response.unwrap_or_default()).await, // the command's own answer
//!         }
//!     }
//! }
//! ```

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::app::App;

/// What a caller says about where a command came from: the Node `ctx` of `processCommand`, without what now comes
/// from the `App`.
///
/// The Node object also carried `settingsStore`, `convStore`, `db` and `channelManager` (all the app's own now).
/// `lib/commands.js` reads four more that no caller in `src/` passes: `clearConversation` and `abortController`
/// (hooks nobody supplies), and `ai` and `autoSummarize` (its own tests' seams). Those stay inside
/// `lib/commands.rs`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommandContext {
    /// The chat the command was typed in. `None` when there is none yet (a Slack slash command, a first message).
    pub conversation_id: Option<String>,
    /// Where it was typed: "web" (the dashboard, signed in: the owner), "api" (the API token alone), "telegram",
    /// "discord", "slack", "whatsapp" or "email". `None`: a caller that does not say.
    pub platform: Option<String>,
    /// A chat platform's own word that the sender is the owner: their own user id (on WhatsApp, their number) is
    /// on that platform's allowlist. The owner's commands (`/cron`, `/briefing`, `/webhook`) need it, or the
    /// dashboard. Email never says it: a From address is easy to fake.
    pub owner: bool,
}

/// What a command gave back: `{ handled, response? }`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    /// False for a message that is not a command (no leading slash, or a name Tarsee does not know): it is an
    /// ordinary message for the AI.
    #[serde(default)]
    pub handled: bool,
    /// The command's answer, to show as it is; or a playbook (see [`extract_playbook_prompt`]). Left out when the
    /// message was not handled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
}

impl CommandResult {
    /// `{ handled: false }`.
    pub fn not_handled() -> Self {
        CommandResult::default()
    }

    /// `{ handled: true, response }`.
    pub fn handled(response: impl Into<String>) -> Self {
        CommandResult {
            handled: true,
            response: Some(response.into()),
        }
    }
}

/// One command in `getCommandList()`'s answer: `{ name, description, usage, category }`. `GET /api/chat/commands`
/// sends the list to the page as it is, and Telegram registers it as the bot's command menu.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandInfo {
    /// The command's name, without the slash: "clear".
    pub name: String,
    pub description: String,
    /// How it is typed: "/model [provider] [model]".
    pub usage: String,
    /// The palette's group: "Context", "Model", "Appearance", "Automation", "Comms", "Tools", "Help" or "Other".
    pub category: String,
}

/// What runs chat commands: `lib/commands.js`. Package K1 implements it in `lib/commands.rs`.
#[async_trait]
pub trait CommandHandler: Send + Sync {
    /// `processCommand(message, ctx)`: runs the message when it is a command Tarsee knows. `Err` is the command's
    /// handler throwing; the Node callers let that reach their own `catch`.
    async fn process_command(&self, app: &App, message: &str, ctx: &CommandContext) -> anyhow::Result<CommandResult>;

    /// `getCommandList()`: every command, in the order they are defined.
    fn get_command_list(&self) -> Vec<CommandInfo>;
}

/// The command handler the app holds (a service).
pub struct InstalledCommandHandler(pub Arc<dyn CommandHandler>);

/// Stores the app's command handler, replacing any there was. `lib/commands.rs` does this at boot; a test installs
/// `testkit::FakeCommands`.
pub fn install_command_handler(app: &App, handler: Arc<dyn CommandHandler>) {
    app.set(InstalledCommandHandler(handler));
}

/// The app's command handler, if one was installed.
pub fn command_handler(app: &App) -> Option<Arc<dyn CommandHandler>> {
    app.get::<InstalledCommandHandler>()
        .map(|installed| installed.0.clone())
}

/// The failure [`process_command`] gives when no handler was installed.
pub const COMMANDS_NOT_INSTALLED: &str = "Tarsee's chat commands are not installed in this app.";

/// Processes a potential command message: the Node `processCommand(message, ctx)`.
///
/// With no handler installed this fails with [`COMMANDS_NOT_INSTALLED`], whatever the message is: a caller that
/// treated the message as "not a command" would hand `/cron list` to the AI as words.
pub async fn process_command(app: &App, message: &str, ctx: &CommandContext) -> anyhow::Result<CommandResult> {
    match command_handler(app) {
        Some(handler) => handler.process_command(app, message, ctx).await,
        None => Err(anyhow::anyhow!(COMMANDS_NOT_INSTALLED)),
    }
}

/// The list of commands, for the page's palette and Telegram's menu: the Node `getCommandList()`. Empty with no
/// handler installed.
pub fn get_command_list(app: &App) -> Vec<CommandInfo> {
    match command_handler(app) {
        Some(handler) => handler.get_command_list(),
        None => Vec::new(),
    }
}

/// What a playbook's response starts with.
pub const PLAYBOOK_PREFIX: &str = "__PLAYBOOK__\n";

/// A handful of commands (`/checkpoint`, `/ultrareview`, `/email check`, ...) return a playbook instead of a plain
/// reply: a string prefixed with "__PLAYBOOK__\n" that the caller should feed to the AI as the user's turn, not
/// echo back. Channels forget to check this and end up sending the entire playbook back to the user as a message.
/// This helper centralises the check + prefix stripping.
///
/// Returns the stripped playbook body, or `None` if the result is a normal command response. The body can be empty
/// (a response that is the prefix alone): the Node callers asked `if (playbook)`, so they treat that as no playbook.
pub fn extract_playbook_prompt(result: &CommandResult) -> Option<String> {
    if !result.handled {
        return None;
    }
    result
        .response
        .as_deref()?
        .strip_prefix(PLAYBOOK_PREFIX)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testkit::test_app;

    /// Knows one command, `/hello`, and refuses `/cron` to anyone but the owner.
    struct Tiny;

    #[async_trait]
    impl CommandHandler for Tiny {
        async fn process_command(
            &self,
            _app: &App,
            message: &str,
            ctx: &CommandContext,
        ) -> anyhow::Result<CommandResult> {
            Ok(match message {
                "/hello" => {
                    CommandResult::handled(format!("Hello from {}", ctx.platform.as_deref().unwrap_or("nowhere")))
                }
                "/cron" if ctx.platform.as_deref() == Some("web") || ctx.owner => {
                    CommandResult::handled("No scheduled tasks yet.")
                }
                "/cron" => CommandResult::handled("Only the owner can use /cron"),
                "/boom" => anyhow::bail!("the handler threw"),
                _ => CommandResult::not_handled(),
            })
        }

        fn get_command_list(&self) -> Vec<CommandInfo> {
            vec![CommandInfo {
                name: "hello".into(),
                description: "Say hello".into(),
                usage: "/hello".into(),
                category: "Other".into(),
            }]
        }
    }

    #[tokio::test]
    async fn with_nothing_installed_a_command_fails_and_the_list_is_empty() {
        let t = test_app();
        assert!(command_handler(&t.app).is_none());
        let err = process_command(&t.app, "/cron list", &CommandContext::default())
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Tarsee's chat commands are not installed in this app.");
        // An ordinary message too: with nothing to ask, nothing is assumed.
        assert!(
            process_command(&t.app, "hello", &CommandContext::default())
                .await
                .is_err()
        );
        assert_eq!(get_command_list(&t.app), Vec::new());
    }

    #[tokio::test]
    async fn a_command_goes_to_the_installed_handler_with_its_context() {
        let t = test_app();
        install_command_handler(&t.app, Arc::new(Tiny));
        let telegram = CommandContext {
            platform: Some("telegram".into()),
            ..Default::default()
        };
        assert_eq!(
            process_command(&t.app, "/hello", &telegram).await.unwrap(),
            CommandResult::handled("Hello from telegram")
        );
        assert_eq!(
            process_command(&t.app, "/cron", &telegram)
                .await
                .unwrap()
                .response
                .as_deref(),
            Some("Only the owner can use /cron")
        );
        let owner = CommandContext {
            owner: true,
            ..telegram.clone()
        };
        assert_eq!(
            process_command(&t.app, "/cron", &owner)
                .await
                .unwrap()
                .response
                .as_deref(),
            Some("No scheduled tasks yet.")
        );
        assert_eq!(
            process_command(&t.app, "just words", &telegram).await.unwrap(),
            CommandResult::not_handled()
        );
        assert_eq!(
            process_command(&t.app, "/boom", &telegram)
                .await
                .unwrap_err()
                .to_string(),
            "the handler threw"
        );
        assert_eq!(get_command_list(&t.app)[0].name, "hello");
    }

    /// The results `lib/commands.js` `processCommand` returned in Node: a message that is no command, and one of
    /// the owner's commands from someone else.
    #[test]
    fn a_result_is_the_node_object() {
        assert_eq!(
            serde_json::to_string(&CommandResult::not_handled()).unwrap(),
            r#"{"handled":false}"#
        );
        let refused = r#"{"handled":true,"response":"Only the owner can use /cron: scheduled tasks run the AI with nobody asking at the time, and each run can cost money. That can't be done by email, since a sender's address is easy to fake. Use Settings > Automation > Scheduled tasks on the dashboard, or this command in the dashboard's chat."}"#;
        let result: CommandResult = serde_json::from_str(refused).unwrap();
        assert!(result.handled);
        assert!(
            result
                .response
                .as_deref()
                .unwrap()
                .starts_with("Only the owner can use /cron")
        );
        assert_eq!(serde_json::to_string(&result).unwrap(), refused);
        assert_eq!(
            serde_json::from_value::<CommandResult>(json!({"handled": false})).unwrap(),
            CommandResult::not_handled()
        );
    }

    /// The first two entries `lib/commands.js` `getCommandList()` returned in Node.
    #[test]
    fn a_command_in_the_list_is_the_node_object() {
        let node = r#"[{"name":"help","description":"Show available commands","usage":"/help","category":"Help"},{"name":"clear","description":"Start a new conversation (saves a summary first)","usage":"/clear","category":"Context"}]"#;
        let list: Vec<CommandInfo> = serde_json::from_str(node).unwrap();
        assert_eq!((list[1].name.as_str(), list[1].category.as_str()), ("clear", "Context"));
        assert_eq!(serde_json::to_string(&list).unwrap(), node);
    }

    /// `lib/commands.js` `extractPlaybookPrompt`, case by case as Node answered.
    #[test]
    fn a_playbook_is_taken_out_of_a_handled_result_only() {
        assert_eq!(extract_playbook_prompt(&CommandResult::handled("Hello")), None);
        assert_eq!(
            extract_playbook_prompt(&CommandResult::handled("__PLAYBOOK__\nDo the thing.\nThen stop.")).as_deref(),
            Some("Do the thing.\nThen stop.")
        );
        let not_handled = CommandResult {
            handled: false,
            response: Some("__PLAYBOOK__\nx".into()),
        };
        assert_eq!(extract_playbook_prompt(&not_handled), None);
        let no_response = CommandResult {
            handled: true,
            response: None,
        };
        assert_eq!(extract_playbook_prompt(&no_response), None);
        assert_eq!(
            extract_playbook_prompt(&CommandResult::handled("__PLAYBOOK__\n")).as_deref(),
            Some("")
        );
        assert_eq!(extract_playbook_prompt(&CommandResult::handled("__PLAYBOOK__ x")), None);
    }

    /// The contexts the channels and the web chat build (`channels/*.js`, `routes/chat.js`).
    #[test]
    fn the_context_reads_the_node_keys_and_says_nothing_by_default() {
        let ctx: CommandContext =
            serde_json::from_value(json!({"conversationId": "c1", "platform": "discord", "owner": true})).unwrap();
        assert_eq!(
            ctx,
            CommandContext {
                conversation_id: Some("c1".into()),
                platform: Some("discord".into()),
                owner: true
            }
        );
        let silent = CommandContext::default();
        assert_eq!(
            (silent.conversation_id, silent.platform, silent.owner),
            (None, None, false)
        );
    }
}
