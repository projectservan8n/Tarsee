//! A stand-in channel manager and stand-in channels: what the Node tests built by hand
//! (`{ getStatus: () => ({...}), sendMessage: async (...) => sent.push(...), channels: new Map([["email", { bot }]]) }`).
//!
//! [`FakeChannels`] is the app's channel manager (`channels::api::ChannelApi`): it records every call, answers
//! `get_status` and `channel` from what the test set, and fails where the test says. [`FakeChannel`] is one bot
//! (`channels::api::Channel`), for the calls that go to a bot itself (Discord's `admin`, email's `send_new`,
//! WhatsApp's `handle_inbound`, a bot's `health`), and for the real manager's own tests.
//!
//! ```ignore
//! let t = test_app();
//! let channels = FakeChannels::install(&t.app);
//! channels.set_status("telegram", ChannelStatus::running(Some("@test_bot")));
//! let email = Arc::new(FakeChannel::new().without_files().with_send_new(SentEmail { message_id: Some("<m1@x>".into()), attachment_count: 1 }));
//! channels.set_channel("email", email.clone());
//! channels.respond_with(|call| match call {
//!     ChannelCall::Restart { kind, .. } if kind == "slack" => Err(anyhow::anyhow!("slack is not configured or not enabled")),
//!     _ => Ok(()),
//! });
//! // ... run the code under test ...
//! assert_eq!(channels.calls(), [ChannelCall::SendMessage { kind: "telegram".into(), chat_id: "42".into(), message: "Done".into(), opts: SendOptions::default() }]);
//! assert_eq!(email.calls().len(), 1);
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;

use crate::app::App;
use crate::channels::api::{
    Channel, ChannelApi, ChannelEntry, ChannelHealth, ChannelState, ChannelStatus, ChannelStatuses, HeldChannelStatus,
    NewEmail, SendOptions, SentEmail, StartOptions, Unsupported, install_channel_manager,
};

// --- The manager -------------------------------------------------------------------------------------------------

/// One call the fake manager was asked to make.
#[derive(Debug, Clone, PartialEq)]
pub enum ChannelCall {
    StartAll,
    Start {
        kind: String,
        config: Value,
        opts: StartOptions,
    },
    Stop {
        kind: String,
    },
    StopAll,
    Restart {
        kind: String,
        opts: StartOptions,
    },
    SendMessage {
        kind: String,
        chat_id: String,
        message: String,
        opts: SendOptions,
    },
    SendFile {
        kind: String,
        chat_id: String,
        file_path: PathBuf,
        caption: Option<String>,
        opts: SendOptions,
    },
}

type Verdict = Arc<dyn Fn(&ChannelCall) -> anyhow::Result<()> + Send + Sync>;

/// The stand-in channel manager. Every call succeeds unless [`FakeChannels::respond_with`] says otherwise.
#[derive(Default)]
pub struct FakeChannels {
    calls: Mutex<Vec<ChannelCall>>,
    statuses: Mutex<ChannelStatuses>,
    entries: Mutex<Vec<(String, ChannelEntry)>>,
    verdict: Mutex<Option<Verdict>>,
}

impl FakeChannels {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// A new one, installed as the app's channel manager.
    pub fn install(app: &App) -> Arc<Self> {
        let channels = Self::new();
        install_channel_manager(app, channels.clone());
        channels
    }

    /// Sets what `get_status` says of one channel.
    pub fn set_status(&self, kind: impl Into<String>, status: ChannelStatus) {
        self.statuses.lock().set(kind, status);
    }

    /// Holds a running bot under `kind`: `channel(kind)` gives it, and `get_status` says "running" with the bot's
    /// identity, invite link and warning (unless `set_status` says something else for it).
    pub fn set_channel(&self, kind: impl Into<String>, bot: Arc<dyn Channel>) {
        let kind = kind.into();
        self.set_entry(ChannelEntry {
            bot: Some(bot),
            kind,
            status: ChannelState::Running,
            error: None,
        });
    }

    /// Holds this entry as it is under its `kind` (one whose start failed, one still starting).
    pub fn set_entry(&self, entry: ChannelEntry) {
        let mut entries = self.entries.lock();
        match entries.iter_mut().find(|(kind, _)| *kind == entry.kind) {
            Some(held) => held.1 = entry,
            None => entries.push((entry.kind.clone(), entry)),
        }
    }

    /// Forgets the entry held under `kind`.
    pub fn remove_channel(&self, kind: &str) {
        self.entries.lock().retain(|(held, _)| held != kind);
    }

    /// Decides how every call from now on ends: `Ok(())`, or the failure the manager would give. The call is
    /// recorded first either way.
    pub fn respond_with(&self, verdict: impl Fn(&ChannelCall) -> anyhow::Result<()> + Send + Sync + 'static) {
        *self.verdict.lock() = Some(Arc::new(verdict));
    }

    /// Every call so far, oldest first.
    pub fn calls(&self) -> Vec<ChannelCall> {
        self.calls.lock().clone()
    }

    /// Forgets the recorded calls.
    pub fn clear_calls(&self) {
        self.calls.lock().clear();
    }

    fn record(&self, call: ChannelCall) -> anyhow::Result<()> {
        self.calls.lock().push(call.clone());
        let verdict = self.verdict.lock().clone();
        match verdict {
            Some(verdict) => verdict(&call),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl ChannelApi for FakeChannels {
    async fn start_all(&self) -> anyhow::Result<()> {
        self.record(ChannelCall::StartAll)
    }

    async fn start(&self, kind: &str, config: Value, opts: StartOptions) -> anyhow::Result<()> {
        self.record(ChannelCall::Start {
            kind: kind.to_string(),
            config,
            opts,
        })
    }

    async fn stop(&self, kind: &str) -> anyhow::Result<()> {
        self.record(ChannelCall::Stop { kind: kind.to_string() })
    }

    fn stop_all(&self) {
        let _ = self.record(ChannelCall::StopAll);
    }

    async fn restart(&self, kind: &str, opts: StartOptions) -> anyhow::Result<()> {
        self.record(ChannelCall::Restart {
            kind: kind.to_string(),
            opts,
        })
    }

    async fn send_message(&self, kind: &str, chat_id: &str, message: &str, opts: SendOptions) -> anyhow::Result<()> {
        self.record(ChannelCall::SendMessage {
            kind: kind.to_string(),
            chat_id: chat_id.to_string(),
            message: message.to_string(),
            opts,
        })
    }

    async fn send_file(
        &self,
        kind: &str,
        chat_id: &str,
        file_path: &Path,
        caption: Option<&str>,
        opts: SendOptions,
    ) -> anyhow::Result<()> {
        self.record(ChannelCall::SendFile {
            kind: kind.to_string(),
            chat_id: chat_id.to_string(),
            file_path: file_path.to_path_buf(),
            caption: caption.map(str::to_string),
            opts,
        })
    }

    /// The statuses the test set, in the order it set them; then, for each held entry it set none for, the status
    /// the real manager works out of an entry.
    fn get_status(&self) -> ChannelStatuses {
        let mut statuses = self.statuses.lock().clone();
        for (kind, entry) in self.entries.lock().iter() {
            if statuses.get(kind).is_some() {
                continue;
            }
            let bot = entry.bot.as_ref().filter(|_| entry.status == ChannelState::Running);
            statuses.set(
                kind.clone(),
                ChannelStatus {
                    status: entry.status,
                    held: Some(HeldChannelStatus {
                        error: entry.error.clone(),
                        identity: bot.and_then(|bot| bot.identity()),
                        invite_url: bot.and_then(|bot| bot.invite_url()),
                        warning: bot.and_then(|bot| bot.warning()),
                    }),
                },
            );
        }
        statuses
    }

    fn channel(&self, kind: &str) -> Option<ChannelEntry> {
        self.entries
            .lock()
            .iter()
            .find(|(held, _)| held == kind)
            .map(|(_, entry)| entry.clone())
    }
}

// --- One channel -------------------------------------------------------------------------------------------------

/// One call a fake bot was asked to make.
#[derive(Debug, Clone, PartialEq)]
pub enum BotCall {
    Stop,
    SendMessage {
        chat_id: String,
        text: String,
        opts: SendOptions,
    },
    SendFile {
        chat_id: String,
        file_path: PathBuf,
        caption: Option<String>,
        opts: SendOptions,
    },
    Admin(Value),
    SendNew(NewEmail),
    HandleInbound(Value),
}

/// A stand-in bot. As made by [`FakeChannel::new`] it stops, sends messages and sends files, like Telegram's; the
/// `with_...` and `without_...` methods shape it into any of the five.
#[derive(Default)]
pub struct FakeChannel {
    identity: Option<String>,
    invite_url: Option<String>,
    warning: Option<String>,
    health: Mutex<Option<ChannelHealth>>,
    no_files: bool,
    admin: Option<String>,
    send_new: Option<SentEmail>,
    inbound: bool,
    failure: Mutex<Option<String>>,
    calls: Mutex<Vec<BotCall>>,
}

impl FakeChannel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Who it says it connected as.
    pub fn with_identity(mut self, identity: impl Into<String>) -> Self {
        self.identity = Some(identity.into());
        self
    }

    /// Discord: its link to add the bot to a server.
    pub fn with_invite_url(mut self, url: impl Into<String>) -> Self {
        self.invite_url = Some(url.into());
        self
    }

    /// WhatsApp: its warning that the token could not be checked.
    pub fn with_warning(mut self, warning: impl Into<String>) -> Self {
        self.warning = Some(warning.into());
        self
    }

    /// Telegram and Slack: what `health()` says (change it later with [`FakeChannel::set_health`]).
    pub fn with_health(self, health: ChannelHealth) -> Self {
        *self.health.lock() = Some(health);
        self
    }

    /// Email: no `send_file`.
    pub fn without_files(mut self) -> Self {
        self.no_files = true;
        self
    }

    /// Discord: `admin(args)` answers this.
    pub fn with_admin(mut self, answer: impl Into<String>) -> Self {
        self.admin = Some(answer.into());
        self
    }

    /// Email: `send_new(mail)` answers this.
    pub fn with_send_new(mut self, sent: SentEmail) -> Self {
        self.send_new = Some(sent);
        self
    }

    /// WhatsApp: `handle_inbound(payload)` is there.
    pub fn with_inbound(mut self) -> Self {
        self.inbound = true;
        self
    }

    pub fn set_health(&self, health: Option<ChannelHealth>) {
        *self.health.lock() = health;
    }

    /// Makes every call from now on fail with this message (`None`: succeed again). Calls are still recorded.
    pub fn fail_with(&self, message: Option<&str>) {
        *self.failure.lock() = message.map(str::to_string);
    }

    /// Every call so far, oldest first.
    pub fn calls(&self) -> Vec<BotCall> {
        self.calls.lock().clone()
    }

    fn record(&self, call: BotCall) -> anyhow::Result<()> {
        self.calls.lock().push(call);
        match self.failure.lock().as_deref() {
            Some(message) => Err(anyhow::anyhow!(message.to_string())),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl Channel for FakeChannel {
    async fn stop(&self) -> anyhow::Result<()> {
        self.record(BotCall::Stop)
    }

    async fn send_message(&self, chat_id: &str, text: &str, opts: &SendOptions) -> anyhow::Result<()> {
        self.record(BotCall::SendMessage {
            chat_id: chat_id.to_string(),
            text: text.to_string(),
            opts: opts.clone(),
        })
    }

    async fn send_file(
        &self,
        chat_id: &str,
        file_path: &Path,
        caption: Option<&str>,
        opts: &SendOptions,
    ) -> anyhow::Result<()> {
        if self.no_files {
            return Err(Unsupported("sendFile").into());
        }
        self.record(BotCall::SendFile {
            chat_id: chat_id.to_string(),
            file_path: file_path.to_path_buf(),
            caption: caption.map(str::to_string),
            opts: opts.clone(),
        })
    }

    fn identity(&self) -> Option<String> {
        self.identity.clone()
    }

    fn invite_url(&self) -> Option<String> {
        self.invite_url.clone()
    }

    fn warning(&self) -> Option<String> {
        self.warning.clone()
    }

    fn health(&self) -> Option<ChannelHealth> {
        *self.health.lock()
    }

    async fn admin(&self, args: Value) -> anyhow::Result<String> {
        let Some(answer) = self.admin.clone() else {
            return Err(Unsupported("admin").into());
        };
        self.record(BotCall::Admin(args))?;
        Ok(answer)
    }

    async fn send_new(&self, mail: NewEmail) -> anyhow::Result<SentEmail> {
        let Some(sent) = self.send_new.clone() else {
            return Err(Unsupported("sendNew").into());
        };
        self.record(BotCall::SendNew(mail))?;
        Ok(sent)
    }

    async fn handle_inbound(&self, payload: Value) -> anyhow::Result<()> {
        if !self.inbound {
            return Err(Unsupported("handleInbound").into());
        }
        self.record(BotCall::HandleInbound(payload))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::channels::api::channel_manager;
    use crate::testkit::test_app;

    #[tokio::test]
    async fn the_manager_records_every_call_and_each_succeeds() {
        let t = test_app();
        let channels = FakeChannels::install(&t.app);
        let manager = channel_manager(&t.app).expect("installed");

        manager.start_all().await.unwrap();
        manager
            .start("whatsapp", json!({"enabled": true}), StartOptions::default())
            .await
            .unwrap();
        manager
            .restart("telegram", StartOptions { deliver_pending: true })
            .await
            .unwrap();
        manager.stop("email").await.unwrap();
        manager
            .send_message("telegram", "42", "Done", SendOptions::thread(Some("7".into())))
            .await
            .unwrap();
        manager
            .send_file(
                "slack",
                "C1",
                Path::new("report.pdf"),
                Some("The report"),
                SendOptions::default(),
            )
            .await
            .unwrap();
        manager.stop_all();

        assert_eq!(
            channels.calls(),
            [
                ChannelCall::StartAll,
                ChannelCall::Start {
                    kind: "whatsapp".into(),
                    config: json!({"enabled": true}),
                    opts: StartOptions::default()
                },
                ChannelCall::Restart {
                    kind: "telegram".into(),
                    opts: StartOptions { deliver_pending: true }
                },
                ChannelCall::Stop { kind: "email".into() },
                ChannelCall::SendMessage {
                    kind: "telegram".into(),
                    chat_id: "42".into(),
                    message: "Done".into(),
                    opts: SendOptions {
                        thread_id: Some("7".into())
                    }
                },
                ChannelCall::SendFile {
                    kind: "slack".into(),
                    chat_id: "C1".into(),
                    file_path: PathBuf::from("report.pdf"),
                    caption: Some("The report".into()),
                    opts: SendOptions::default()
                },
                ChannelCall::StopAll,
            ]
        );
        channels.clear_calls();
        assert!(channels.calls().is_empty());
    }

    #[tokio::test]
    async fn a_test_decides_which_calls_fail_and_they_are_recorded_all_the_same() {
        let t = test_app();
        let channels = FakeChannels::install(&t.app);
        channels.respond_with(|call| match call {
            ChannelCall::Restart { kind, .. } if kind == "slack" => {
                Err(anyhow::anyhow!("slack is not configured or not enabled"))
            }
            ChannelCall::SendMessage { kind, .. } => Err(anyhow::anyhow!(
                "Channel {kind} is not running or does not support outbound messages"
            )),
            _ => Ok(()),
        });
        let manager = channel_manager(&t.app).unwrap();
        assert_eq!(
            manager
                .restart("slack", StartOptions::default())
                .await
                .unwrap_err()
                .to_string(),
            "slack is not configured or not enabled"
        );
        manager.restart("telegram", StartOptions::default()).await.unwrap();
        assert_eq!(
            manager
                .send_message("discord", "1", "hi", SendOptions::default())
                .await
                .unwrap_err()
                .to_string(),
            "Channel discord is not running or does not support outbound messages"
        );
        assert_eq!(channels.calls().len(), 3);
    }

    #[test]
    fn status_is_what_the_test_set_then_what_the_held_entries_say() {
        let channels = FakeChannels::new();
        assert!(channels.get_status().is_empty());
        channels.set_status("telegram", ChannelStatus::bare(ChannelState::Running));
        channels.set_status("discord", ChannelStatus::bare(ChannelState::Stopped));
        channels.set_channel(
            "whatsapp",
            Arc::new(
                FakeChannel::new()
                    .with_identity("+447700900123 (Tarsee)")
                    .with_warning("Saved, but couldn't check the token"),
            ),
        );
        channels.set_entry(ChannelEntry {
            bot: None,
            kind: "slack".into(),
            status: ChannelState::Error,
            error: Some("Slack refused the bot token.".into()),
        });
        // A bot still held while its channel restarts: not the one connecting, so nothing of it is shown.
        channels.set_entry(ChannelEntry {
            bot: Some(Arc::new(FakeChannel::new().with_identity("old@example.com"))),
            kind: "email".into(),
            status: ChannelState::Starting,
            error: None,
        });
        assert_eq!(
            serde_json::to_value(channels.get_status()).unwrap(),
            json!({
                "telegram": {"status": "running"},
                "discord": {"status": "stopped"},
                "whatsapp": {"status": "running", "error": null, "identity": "+447700900123 (Tarsee)", "inviteUrl": null, "warning": "Saved, but couldn't check the token"},
                "slack": {"status": "error", "error": "Slack refused the bot token.", "identity": null, "inviteUrl": null, "warning": null},
                "email": {"status": "starting", "error": null, "identity": null, "inviteUrl": null, "warning": null},
            })
        );
        // What the test set for a held channel wins.
        channels.set_status("slack", ChannelStatus::bare(ChannelState::NotConfigured));
        assert_eq!(
            channels.get_status().get("slack").unwrap().status,
            ChannelState::NotConfigured
        );
    }

    #[tokio::test]
    async fn an_entry_gives_its_bot_and_is_replaced_or_forgotten() {
        let channels = FakeChannels::new();
        assert!(channels.channel("discord").is_none());
        let bot = Arc::new(FakeChannel::new().with_admin("admin says hi"));
        channels.set_channel("discord", bot.clone());
        let entry = channels.channel("discord").unwrap();
        assert_eq!(
            (entry.kind.as_str(), entry.status, entry.error.clone()),
            ("discord", ChannelState::Running, None)
        );
        assert_eq!(
            entry
                .bot
                .unwrap()
                .admin(json!({"action": "list_channels"}))
                .await
                .unwrap(),
            "admin says hi"
        );
        assert_eq!(bot.calls(), [BotCall::Admin(json!({"action": "list_channels"}))]);

        channels.set_entry(ChannelEntry {
            bot: None,
            kind: "discord".into(),
            status: ChannelState::Error,
            error: Some("login failed".into()),
        });
        let failed = channels.channel("discord").unwrap();
        assert!(failed.bot.is_none());
        assert_eq!(failed.error.as_deref(), Some("login failed"));
        channels.remove_channel("discord");
        assert!(channels.channel("discord").is_none());
    }

    #[tokio::test]
    async fn a_bot_has_what_it_was_given_and_nothing_else() {
        let telegram = FakeChannel::new()
            .with_identity("@test_bot")
            .with_health(ChannelHealth::Telegram {
                updates_received: 0,
                handler_active: 0,
                last_update_at: 0,
            });
        assert_eq!(telegram.identity().as_deref(), Some("@test_bot"));
        assert!(matches!(
            telegram.health(),
            Some(ChannelHealth::Telegram {
                updates_received: 0,
                ..
            })
        ));
        telegram.set_health(Some(ChannelHealth::Telegram {
            updates_received: 3,
            handler_active: 1,
            last_update_at: 1_794_472_200_123,
        }));
        assert!(matches!(
            telegram.health(),
            Some(ChannelHealth::Telegram {
                updates_received: 3,
                ..
            })
        ));
        telegram
            .send_message("42", "hi", &SendOptions::thread(Some("7".into())))
            .await
            .unwrap();
        telegram
            .send_file("42", Path::new("a.txt"), None, &SendOptions::default())
            .await
            .unwrap();
        telegram.stop().await.unwrap();
        assert_eq!(telegram.calls().len(), 3);
        assert!(telegram.admin(json!({})).await.unwrap_err().is::<Unsupported>());
        assert!(
            telegram
                .send_new(NewEmail::default())
                .await
                .unwrap_err()
                .is::<Unsupported>()
        );
        assert!(
            telegram
                .handle_inbound(json!({}))
                .await
                .unwrap_err()
                .is::<Unsupported>()
        );
        assert_eq!(telegram.calls().len(), 3, "what it does not have is not recorded");

        let email = FakeChannel::new().without_files().with_send_new(SentEmail {
            message_id: Some("<m1@x>".into()),
            attachment_count: 2,
        });
        assert!(
            email
                .send_file("a@b.c", Path::new("a.txt"), None, &SendOptions::default())
                .await
                .unwrap_err()
                .is::<Unsupported>()
        );
        let mail = NewEmail {
            to: json!("sam@example.com"),
            subject: "Hi".into(),
            body: "Hello".into(),
            attachments: vec![PathBuf::from("a.txt"), PathBuf::from("b.txt")],
            ..Default::default()
        };
        assert_eq!(email.send_new(mail.clone()).await.unwrap().attachment_count, 2);
        assert_eq!(email.calls(), [BotCall::SendNew(mail)]);

        let whatsapp = FakeChannel::new().with_inbound().with_invite_url("unused");
        whatsapp.handle_inbound(json!({"messages": []})).await.unwrap();
        assert_eq!(whatsapp.calls(), [BotCall::HandleInbound(json!({"messages": []}))]);
        assert_eq!(whatsapp.invite_url().as_deref(), Some("unused"));
    }

    #[tokio::test]
    async fn a_bot_can_be_made_to_fail_and_to_work_again() {
        let bot = FakeChannel::new();
        bot.fail_with(Some("sendFile: file not found at /x"));
        let err = bot.send_message("1", "hi", &SendOptions::default()).await.unwrap_err();
        assert_eq!(err.to_string(), "sendFile: file not found at /x");
        assert!(bot.stop().await.is_err());
        bot.fail_with(None);
        bot.send_message("1", "hi", &SendOptions::default()).await.unwrap();
        assert_eq!(bot.calls().len(), 3);
    }
}
