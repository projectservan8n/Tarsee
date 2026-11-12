//! Stubbed chat commands: stands in for `lib/commands.rs` behind `lib::command_api::process_command`. It records
//! every message it was asked about, with the context, and answers by command name.
//!
//! ```ignore
//! let t = test_app();
//! let commands = FakeCommands::install(&t.app);
//! commands.respond("help", "Here is what I can do.");
//! commands.respond("checkpoint", "__PLAYBOOK__\nSave a checkpoint now.");
//! commands.respond_with("cron", |call| Ok(if call.ctx.owner || call.ctx.platform.as_deref() == Some("web") {
//!     CommandResult::handled("No scheduled tasks yet.")
//! } else {
//!     CommandResult::handled("Only the owner can use /cron")
//! }));
//! // ... deliver "/cron list" to the channel under test ...
//! assert_eq!(commands.calls()[0].ctx.platform.as_deref(), Some("telegram"));
//! assert!(commands.calls()[0].ctx.channel_manager.is_none());   // only the web chat's POST /send hands it over
//! ```
//!
//! It finds the command the way the real one does: the first word after the slash, in lower case. A message with no
//! leading slash, or a command nothing was scripted for, is `{ handled: false }` (an ordinary message for the AI),
//! which is what `lib/commands.js` answers for a name it does not know.

use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;

use crate::app::App;
use crate::lib::command_api::{CommandContext, CommandHandler, CommandInfo, CommandResult, install_command_handler};

/// One message the fake commands were asked about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandCall {
    /// The whole message, as it was typed: "/cron list".
    pub message: String,
    /// The command's name: "cron" ("" for a message with no leading slash).
    pub name: String,
    /// What came after the name, trimmed: "list".
    pub args: String,
    pub ctx: CommandContext,
}

type Responder = Arc<dyn Fn(&CommandCall) -> anyhow::Result<CommandResult> + Send + Sync>;

#[derive(Default)]
pub struct FakeCommands {
    /// Newest first.
    responders: Mutex<Vec<(String, Responder)>>,
    list: Mutex<Vec<CommandInfo>>,
    calls: Mutex<Vec<CommandCall>>,
}

impl FakeCommands {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// A new one, installed as the app's command handler.
    pub fn install(app: &App) -> Arc<Self> {
        let commands = Self::new();
        install_command_handler(app, commands.clone());
        commands
    }

    /// Answers the command `name` (without the slash) with this response, handled. The newest answer for a name
    /// wins.
    pub fn respond(&self, name: impl Into<String>, response: impl Into<String>) {
        let response = response.into();
        self.respond_with(name, move |_| Ok(CommandResult::handled(response.clone())));
    }

    /// Answers the command `name` with what `responder` returns for the call: a result, or the failure of a
    /// handler that threw.
    pub fn respond_with(
        &self,
        name: impl Into<String>,
        responder: impl Fn(&CommandCall) -> anyhow::Result<CommandResult> + Send + Sync + 'static,
    ) {
        self.responders
            .lock()
            .insert(0, (name.into().to_lowercase(), Arc::new(responder)));
    }

    /// Sets what `get_command_list` gives.
    pub fn set_list(&self, list: Vec<CommandInfo>) {
        *self.list.lock() = list;
    }

    /// Every message it was asked about so far, oldest first.
    pub fn calls(&self) -> Vec<CommandCall> {
        self.calls.lock().clone()
    }

    /// Forgets the recorded calls; the answers stay.
    pub fn clear_calls(&self) {
        self.calls.lock().clear();
    }
}

#[async_trait]
impl CommandHandler for FakeCommands {
    async fn process_command(&self, _app: &App, message: &str, ctx: &CommandContext) -> anyhow::Result<CommandResult> {
        // (`message.slice(1).split(/s+/)`: a space right after the slash leaves the name empty.)
        let (name, args) = match message.strip_prefix('/') {
            Some(rest) => {
                let mut words = rest.split_whitespace();
                let name = if rest.starts_with(char::is_whitespace) {
                    String::new()
                } else {
                    words.next().unwrap_or("").to_lowercase()
                };
                (name, words.collect::<Vec<_>>().join(" "))
            }
            None => (String::new(), String::new()),
        };
        let call = CommandCall {
            message: message.to_string(),
            name: name.clone(),
            args,
            ctx: ctx.clone(),
        };
        self.calls.lock().push(call.clone());
        if !message.starts_with('/') {
            return Ok(CommandResult::not_handled());
        }
        let responder = self
            .responders
            .lock()
            .iter()
            .find(|(command, _)| *command == name)
            .map(|(_, responder)| responder.clone());
        match responder {
            Some(responder) => responder(&call),
            None => Ok(CommandResult::not_handled()),
        }
    }

    fn get_command_list(&self) -> Vec<CommandInfo> {
        self.list.lock().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::api::{ChannelStatus, channel_manager};
    use crate::lib::command_api::{extract_playbook_prompt, get_command_list, process_command};
    use crate::testkit::{FakeChannels, test_app};

    fn from(platform: &str, owner: bool) -> CommandContext {
        CommandContext {
            conversation_id: Some("conv-1".into()),
            platform: Some(platform.into()),
            owner,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn it_answers_by_command_name_and_records_the_message_and_its_context() {
        let t = test_app();
        let commands = FakeCommands::install(&t.app);
        commands.respond("help", "Here is what I can do.");

        let result = process_command(&t.app, "/HELP me  please", &from("telegram", false))
            .await
            .unwrap();
        assert_eq!(result, CommandResult::handled("Here is what I can do."));
        assert_eq!(
            commands.calls(),
            [CommandCall {
                message: "/HELP me  please".into(),
                name: "help".into(),
                args: "me please".into(),
                ctx: from("telegram", false),
            }]
        );
        commands.clear_calls();
        assert!(commands.calls().is_empty());
    }

    /// `lib/commands.js` `processCommand`, run in Node: `{ handled: false }` for words, for an empty message and
    /// for a command it does not know.
    #[tokio::test]
    async fn words_and_commands_nothing_was_scripted_for_are_not_handled() {
        let t = test_app();
        let commands = FakeCommands::install(&t.app);
        commands.respond("help", "x");
        for message in ["hello", "", "/nosuchcommand", "/", "help", "/ help"] {
            assert_eq!(
                process_command(&t.app, message, &CommandContext::default())
                    .await
                    .unwrap(),
                CommandResult::not_handled(),
                "{message:?}"
            );
        }
        assert_eq!(commands.calls().len(), 6, "each one was asked about");
        assert_eq!(commands.calls()[0].name, "");
    }

    #[tokio::test]
    async fn a_responder_sees_who_asked_and_can_fail_as_a_handler_that_threw() {
        let t = test_app();
        let commands = FakeCommands::install(&t.app);
        commands.respond("cron", "old answer");
        commands.respond_with("cron", |call| {
            Ok(if call.ctx.owner || call.ctx.platform.as_deref() == Some("web") {
                CommandResult::handled(format!("No scheduled tasks yet. ({})", call.args))
            } else {
                CommandResult::handled("Only the owner can use /cron")
            })
        });
        commands.respond_with("boom", |_| Err(anyhow::anyhow!("the handler threw")));

        let ask = |ctx: CommandContext| {
            let app = t.app.clone();
            async move {
                process_command(&app, "/cron list", &ctx)
                    .await
                    .unwrap()
                    .response
                    .unwrap()
            }
        };
        assert_eq!(ask(from("telegram", false)).await, "Only the owner can use /cron");
        assert_eq!(ask(from("telegram", true)).await, "No scheduled tasks yet. (list)");
        assert_eq!(ask(from("web", false)).await, "No scheduled tasks yet. (list)");
        assert_eq!(
            process_command(&t.app, "/boom", &CommandContext::default())
                .await
                .unwrap_err()
                .to_string(),
            "the handler threw"
        );
    }

    /// What a test of a caller asserts: the web chat's `POST /send` hands the channel manager over, a chat channel
    /// and the WebSocket do not (`routes/chat.js` against `channels/*.js`).
    #[tokio::test]
    async fn the_recorded_context_says_whether_the_caller_handed_over_the_channel_manager() {
        let t = test_app();
        let commands = FakeCommands::install(&t.app);
        commands.respond_with("status", |call| {
            Ok(CommandResult::handled(match &call.ctx.channel_manager {
                Some(manager) => format!("{} channels", manager.get_status().len()),
                None => "no channels line".to_string(),
            }))
        });
        let channels = FakeChannels::install(&t.app);
        channels.set_status("telegram", ChannelStatus::running(Some("@test_bot")));

        let from_a_channel = from("telegram", true);
        let from_the_web_chat = from("web", false).with_channel_manager(channel_manager(&t.app));
        let said = |ctx: CommandContext| {
            let app = t.app.clone();
            async move { process_command(&app, "/status", &ctx).await.unwrap().response.unwrap() }
        };
        assert_eq!(said(from_a_channel).await, "no channels line");
        assert_eq!(said(from_the_web_chat).await, "1 channels");

        let calls = commands.calls();
        assert!(calls[0].ctx.channel_manager.is_none());
        assert!(calls[1].ctx.channel_manager.is_some());
        assert_ne!(calls[0].ctx, calls[1].ctx);
    }

    #[tokio::test]
    async fn a_scripted_playbook_comes_out_as_one() {
        let t = test_app();
        let commands = FakeCommands::install(&t.app);
        commands.respond("checkpoint", "__PLAYBOOK__\nSave a checkpoint now.");
        let result = process_command(&t.app, "/checkpoint", &from("web", false))
            .await
            .unwrap();
        assert_eq!(
            extract_playbook_prompt(&result).as_deref(),
            Some("Save a checkpoint now.")
        );
    }

    #[test]
    fn the_command_list_is_what_the_test_set() {
        let t = test_app();
        let commands = FakeCommands::install(&t.app);
        assert!(get_command_list(&t.app).is_empty());
        let help = CommandInfo {
            name: "help".into(),
            description: "Show available commands".into(),
            usage: "/help".into(),
            category: "Help".into(),
        };
        commands.set_list(vec![help.clone()]);
        assert_eq!(get_command_list(&t.app), [help]);
    }
}
