//! The channel manager as the rest of Tarsee sees it, and what one channel must be for the manager to hold it.
//!
//! In Node, `ChannelManager` (`channels/manager.js`) was made in `server.js` and handed around: `app.set(
//! "channelManager", m)`, `setToolsChannelManager(m)`, `setCronChannelManager(m)`, `setHeartbeatChannelManager(m)`,
//! and as `channelManager` in tool contexts. The tools, the routes, channel health, the credential inventory and
//! self-heal called it; the channels imported the turn layer, which imported the tools: a circle. Here everything
//! outside `channels/` reaches the manager through [`channel_manager`], which gives the [`ChannelApi`] stored in the
//! `App`. `channels/manager.rs` (package H3) implements it; tests install `testkit::FakeChannels`.
//!
//! [`Channel`] is the common shape of the five bots (`createTelegramBot`, `createDiscordBot`, `createSlackBot`,
//! `createWhatsAppBot`, `createEmailBot` each returned such an object): packages H1 and H2 implement it, and H3's
//! manager holds them as `Arc<dyn Channel>`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::app::App;

// --- Shared types ------------------------------------------------------------------------------------------------

/// Where in a chat a message or file goes: the Node `opts` of `sendMessage` and `sendFile`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendOptions {
    /// A Telegram forum topic's id, or a Slack thread's `ts`. The other channels ignore it.
    pub thread_id: Option<String>,
}

impl SendOptions {
    pub fn thread(thread_id: Option<String>) -> Self {
        SendOptions { thread_id }
    }
}

/// How a channel is started: the Node `opts` of `start` and `restart`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StartOptions {
    /// Telegram only: deliver the updates that queued up while the poller was wedged instead of dropping them
    /// (`lib/channel-health.js` relaunching a boot-wedged poller).
    pub deliver_pending: bool,
}

/// A channel's state, as `getStatus()` and the manager's entries say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelState {
    /// Being started (or restarted): the bot is not up yet.
    Starting,
    /// Connected.
    Running,
    /// Its last start failed; `error` says why.
    Error,
    /// Set up and enabled in Settings, but the manager is not running it.
    Stopped,
    /// Not set up, or switched off.
    NotConfigured,
}

impl ChannelState {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelState::Starting => "starting",
            ChannelState::Running => "running",
            ChannelState::Error => "error",
            ChannelState::Stopped => "stopped",
            ChannelState::NotConfigured => "not_configured",
        }
    }
}

/// One channel in `getStatus()`'s answer.
///
/// A channel the manager holds (starting, running or failed) is `{ status, error, identity, inviteUrl, warning }`,
/// each of the four `null` when there is none. One it does not hold is `{ status }` alone ("stopped" or
/// "not_configured"). `GET /api/admin/status` sends this to the page as it is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChannelStatus {
    pub status: ChannelState,
    /// `None` for a channel the manager does not hold.
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub held: Option<HeldChannelStatus>,
}

impl<'de> Deserialize<'de> for ChannelStatus {
    /// Held when the object has any of the four fields beside `status`, as the Node object did.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let mut fields = serde_json::Map::<String, Value>::deserialize(deserializer)?;
        let status = fields
            .remove("status")
            .ok_or_else(|| D::Error::missing_field("status"))?;
        let status = ChannelState::deserialize(status).map_err(D::Error::custom)?;
        let held = if ["error", "identity", "inviteUrl", "warning"]
            .iter()
            .any(|name| fields.contains_key(*name))
        {
            Some(HeldChannelStatus::deserialize(Value::Object(fields)).map_err(D::Error::custom)?)
        } else {
            None
        };
        Ok(ChannelStatus { status, held })
    }
}

/// The rest of a held channel's status.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HeldChannelStatus {
    /// Why its last start failed.
    pub error: Option<String>,
    /// Who it connected as ("@tarsee_bot", "tarsee#0001", "@tarsee in Acme", "+447700900123 (Tarsee)", the
    /// mailbox's address), for "Connected as ...". Only while running.
    pub identity: Option<String>,
    /// Discord's link to add the bot to a server. Only while running.
    pub invite_url: Option<String>,
    /// Running, but something could not be checked (WhatsApp: the token). Only while running.
    pub warning: Option<String>,
}

impl ChannelStatus {
    /// `{ status }` for a channel the manager does not hold.
    pub fn bare(status: ChannelState) -> Self {
        ChannelStatus { status, held: None }
    }

    /// `{ status: "running", error: null, identity, inviteUrl: null, warning: null }`.
    pub fn running(identity: Option<&str>) -> Self {
        ChannelStatus {
            status: ChannelState::Running,
            held: Some(HeldChannelStatus {
                identity: identity.map(str::to_string),
                ..Default::default()
            }),
        }
    }

    /// `{ status: "error", error, identity: null, inviteUrl: null, warning: null }`.
    pub fn failed(error: impl Into<String>) -> Self {
        ChannelStatus {
            status: ChannelState::Error,
            held: Some(HeldChannelStatus {
                error: Some(error.into()),
                ..Default::default()
            }),
        }
    }

    /// `s.error`, whether the channel is held or not.
    pub fn error(&self) -> Option<&str> {
        self.held.as_ref().and_then(|held| held.error.as_deref())
    }

    /// `s.status === "running"`.
    pub fn is_running(&self) -> bool {
        self.status == ChannelState::Running
    }
}

/// `getStatus()`'s answer: every channel's status by its type, in the manager's order (the channels it holds, in
/// the order they were started; then "discord", "telegram", "whatsapp", "slack" for those it does not; then
/// "email"). It serialises as the JSON object the Node code returned, in that order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChannelStatuses(pub Vec<(String, ChannelStatus)>);

impl ChannelStatuses {
    pub fn new() -> Self {
        Self::default()
    }

    /// `status[type]`.
    pub fn get(&self, kind: &str) -> Option<&ChannelStatus> {
        self.0.iter().find(|(name, _)| name == kind).map(|(_, status)| status)
    }

    /// Sets a channel's status, in place when it is already listed, else at the end.
    pub fn set(&mut self, kind: impl Into<String>, status: ChannelStatus) {
        let kind = kind.into();
        match self.0.iter_mut().find(|(name, _)| *name == kind) {
            Some(entry) => entry.1 = status,
            None => self.0.push((kind, status)),
        }
    }

    /// `Object.entries(status)`.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &ChannelStatus)> {
        self.0.iter().map(|(name, status)| (name.as_str(), status))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for ChannelStatuses {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (kind, status) in &self.0 {
            map.serialize_entry(kind, status)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for ChannelStatuses {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InOrder;
        impl<'de> Visitor<'de> for InOrder {
            type Value = ChannelStatuses;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of channel statuses by channel type")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ChannelStatuses, A::Error> {
                let mut out = Vec::new();
                while let Some(entry) = map.next_entry::<String, ChannelStatus>()? {
                    out.push(entry);
                }
                Ok(ChannelStatuses(out))
            }
        }
        deserializer.deserialize_map(InOrder)
    }
}

// --- One channel -------------------------------------------------------------------------------------------------

/// A channel has no such ability: the Node bot object lacked the function (`!channel?.bot?.sendFile`). The manager
/// turns it into its own words ("Channel email is not running or does not support file attachments"). Find it with
/// `err.is::<Unsupported>()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("this channel does not support {0}")]
pub struct Unsupported(pub &'static str);

/// What a channel's own check of its connection says: the Node `bot.health()`, which Telegram and Slack have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelHealth {
    /// `{ updatesReceived, handlerActive, lastUpdateAt }`.
    Telegram {
        /// 0 means the poller has pulled nothing since launch (a boot-race wedge: safe to relaunch).
        updates_received: u64,
        /// Above 0 means a turn is being handled right now: the poll loop is busy, not stuck.
        handler_active: u64,
        /// When the last update came, in milliseconds since 1970; 0 before the first.
        last_update_at: i64,
    },
    /// `{ connected, downForMs }`.
    Slack {
        connected: bool,
        /// How long the Socket Mode connection has been down; 0 while it is up.
        down_for_ms: u64,
    },
}

/// A mail to send that starts or continues a thread: the Node `bot.sendNew(opts)` of the email channel
/// (`tarsee_send_email_thread`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewEmail {
    /// The address, a comma-separated list of them, or an array: as the tool was given it.
    pub to: Value,
    /// The same for copies; `Value::Null` for none.
    pub cc: Value,
    pub subject: String,
    pub body: String,
    /// The Message-ID to thread under.
    pub in_reply_to: Option<String>,
    /// Files to attach, as paths on disk.
    pub attachments: Vec<PathBuf>,
}

/// What `bot.sendNew` gave back: `{ messageId, attachmentCount }`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SentEmail {
    pub message_id: Option<String>,
    pub attachment_count: usize,
}

/// One running channel: the object each `create<Name>Bot(config, db, opts)` returned.
///
/// Every bot stops and sends messages. The rest is there on some and not on others, as in Node; a method a channel
/// does not have keeps its default here, which answers "none" or fails with [`Unsupported`].
///
/// | | Telegram | Discord | Slack | WhatsApp | Email |
/// |---|---|---|---|---|---|
/// | `stop`, `send_message`, `identity` | yes | yes | yes | yes | yes |
/// | `send_file` | yes | yes | yes | yes | no |
/// | `health` | yes | no | yes | no | no |
/// | `invite_url`, `admin` | no | yes | no | no | no |
/// | `warning`, `handle_inbound` | no | no | no | yes | no |
/// | `send_new` | no | no | no | no | yes |
///
/// A channel's constructor is its own (`channels/telegram.rs` and the rest): it takes the app, the stored
/// `channel.<type>` setting and the manager's [`StartOptions`], and gives `anyhow::Result<Arc<dyn Channel>>`. A
/// credential the platform refused is `lib/channel_errors.rs`'s error, which the manager does not retry.
#[async_trait]
pub trait Channel: Send + Sync {
    /// Disconnects. The manager logs a failure and forgets the channel all the same.
    async fn stop(&self) -> anyhow::Result<()>;

    /// Sends a message to a chat (outbound push): the platform's own chat or channel id; for email, the address or
    /// a comma-separated list of them.
    async fn send_message(&self, chat_id: &str, text: &str, opts: &SendOptions) -> anyhow::Result<()>;

    /// Sends a file from disk as a real attachment (the `send_file` tool), with the words that go with it.
    async fn send_file(
        &self,
        _chat_id: &str,
        _file_path: &Path,
        _caption: Option<&str>,
        _opts: &SendOptions,
    ) -> anyhow::Result<()> {
        Err(Unsupported("sendFile").into())
    }

    /// Who it connected as, for Settings > Channels; `None` until the platform has said.
    fn identity(&self) -> Option<String> {
        None
    }

    /// Discord: the link that adds this bot to a server.
    fn invite_url(&self) -> Option<String> {
        None
    }

    /// WhatsApp: why the token could not be checked at startup (Settings shows it in place of "Connected").
    fn warning(&self) -> Option<String> {
        None
    }

    /// Telegram and Slack: the state of the connection, for `lib/channel_health.rs`. `None` for a channel that has
    /// no such check.
    fn health(&self) -> Option<ChannelHealth> {
        None
    }

    /// Discord: `tarsee_discord_admin` (`lib/discord-admin.js`), done by the logged-in bot. Gives the tool's answer.
    async fn admin(&self, _args: Value) -> anyhow::Result<String> {
        Err(Unsupported("admin").into())
    }

    /// Email: starts or continues a thread.
    async fn send_new(&self, _mail: NewEmail) -> anyhow::Result<SentEmail> {
        Err(Unsupported("sendNew").into())
    }

    /// WhatsApp: a webhook delivery from WHAPI (`routes/whapi.js`), handled as incoming messages.
    async fn handle_inbound(&self, _payload: Value) -> anyhow::Result<()> {
        Err(Unsupported("handleInbound").into())
    }
}

/// One entry of the manager's `channels` map: `{ bot, type, status, error? }`.
#[derive(Clone)]
pub struct ChannelEntry {
    /// The running bot; `None` while it starts and after a start that failed.
    pub bot: Option<Arc<dyn Channel>>,
    /// The channel's type: "telegram", "discord", "slack", "whatsapp", "email".
    pub kind: String,
    /// `Starting`, `Running` or `Error`.
    pub status: ChannelState,
    /// With `Error`: why the start failed.
    pub error: Option<String>,
}

impl std::fmt::Debug for ChannelEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChannelEntry")
            .field("bot", &self.bot.is_some())
            .field("kind", &self.kind)
            .field("status", &self.status)
            .field("error", &self.error)
            .finish()
    }
}

// --- The manager -------------------------------------------------------------------------------------------------

/// The part of `ChannelManager` that code outside `channels/` calls.
///
/// `kind` is the channel's type everywhere: "telegram", "discord", "slack", "whatsapp" or "email". Failures carry
/// the manager's own words (`err.to_string()` is the Node `err.message`): "telegram is not configured or not
/// enabled", "Channel discord is not running or does not support outbound messages".
#[async_trait]
pub trait ChannelApi: Send + Sync {
    /// Starts every channel that is set up and enabled, side by side, retrying the ones that fail for a passing
    /// reason (`server.js` at boot).
    async fn start_all(&self) -> anyhow::Result<()>;

    /// Starts one channel with this configuration (the stored `channel.<kind>` setting), stopping the running one
    /// first (`routes/whapi.js` starting WhatsApp on its first webhook).
    async fn start(&self, kind: &str, config: Value, opts: StartOptions) -> anyhow::Result<()>;

    /// Stops one channel. One that is not running is left alone (and one that failed to start is forgotten).
    async fn stop(&self, kind: &str) -> anyhow::Result<()>;

    /// Stops every channel, without waiting for them (`server.js` on shutdown).
    fn stop_all(&self);

    /// Starts one channel again from its stored configuration. Fails when it is not set up or not enabled.
    async fn restart(&self, kind: &str, opts: StartOptions) -> anyhow::Result<()>;

    /// Sends an outbound message through a running channel.
    async fn send_message(&self, kind: &str, chat_id: &str, message: &str, opts: SendOptions) -> anyhow::Result<()>;

    /// Sends a file as a real attachment through a running channel.
    async fn send_file(
        &self,
        kind: &str,
        chat_id: &str,
        file_path: &Path,
        caption: Option<&str>,
        opts: SendOptions,
    ) -> anyhow::Result<()>;

    /// Every channel's status.
    fn get_status(&self) -> ChannelStatuses;

    /// The manager's entry for one channel (the Node `channels.get(kind)`): `None` when it holds none.
    fn channel(&self, kind: &str) -> Option<ChannelEntry>;
}

/// The channel manager the app holds (a service).
pub struct InstalledChannelManager(pub Arc<dyn ChannelApi>);

/// Stores the app's channel manager, replacing any there was: the Node `app.set("channelManager", m)` and the
/// `set...ChannelManager(m)` calls in one. `server.rs` does this at boot with `channels/manager.rs`'s; a test installs
/// `testkit::FakeChannels`.
pub fn install_channel_manager(app: &App, manager: Arc<dyn ChannelApi>) {
    app.set(InstalledChannelManager(manager));
}

/// The app's channel manager, or `None` when there is none (yet): the Node code tolerated that everywhere
/// (`channelManager?.getStatus() || {}`, "channel manager unavailable", "Channel manager not initialized"), and so
/// do its callers here.
pub fn channel_manager(app: &App) -> Option<Arc<dyn ChannelApi>> {
    app.get::<InstalledChannelManager>()
        .map(|installed| installed.0.clone())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testkit::test_app;

    #[test]
    fn with_nothing_installed_there_is_no_channel_manager() {
        let t = test_app();
        assert!(channel_manager(&t.app).is_none());
    }

    /// What `channels/manager.js` `getStatus()` returned in Node: Telegram and Discord running, Slack's start failed,
    /// email starting, WhatsApp set up but not held; then nothing set up at all; then WhatsApp running with a
    /// warning.
    const NODE_STATUS: &str = r#"{"telegram":{"status":"running","error":null,"identity":"@test_bot","inviteUrl":null,"warning":null},"slack":{"status":"error","error":"Slack refused the bot token. Copy it again.","identity":null,"inviteUrl":null,"warning":null},"discord":{"status":"running","error":null,"identity":"tarsee#0001","inviteUrl":"https://discord.com/oauth2/authorize?client_id=1","warning":null},"email":{"status":"starting","error":null,"identity":null,"inviteUrl":null,"warning":null},"whatsapp":{"status":"stopped"}}"#;
    const NODE_STATUS_NOTHING: &str = r#"{"discord":{"status":"not_configured"},"telegram":{"status":"not_configured"},"whatsapp":{"status":"not_configured"},"slack":{"status":"not_configured"},"email":{"status":"not_configured"}}"#;
    const NODE_STATUS_WARNING: &str = r#"{"whatsapp":{"status":"running","error":null,"identity":null,"inviteUrl":null,"warning":"Saved, but couldn't check the token with WHAPI (no answer in time)."},"discord":{"status":"not_configured"},"telegram":{"status":"not_configured"},"slack":{"status":"not_configured"},"email":{"status":"not_configured"}}"#;

    #[test]
    fn statuses_serialise_as_the_node_object_in_the_managers_order() {
        let mut statuses = ChannelStatuses::new();
        statuses.set("telegram", ChannelStatus::running(Some("@test_bot")));
        statuses.set(
            "slack",
            ChannelStatus::failed("Slack refused the bot token. Copy it again."),
        );
        statuses.set(
            "discord",
            ChannelStatus {
                status: ChannelState::Running,
                held: Some(HeldChannelStatus {
                    identity: Some("tarsee#0001".into()),
                    invite_url: Some("https://discord.com/oauth2/authorize?client_id=1".into()),
                    ..Default::default()
                }),
            },
        );
        statuses.set(
            "email",
            ChannelStatus {
                status: ChannelState::Starting,
                held: Some(HeldChannelStatus::default()),
            },
        );
        statuses.set("whatsapp", ChannelStatus::bare(ChannelState::Stopped));
        assert_eq!(serde_json::to_string(&statuses).unwrap(), NODE_STATUS);

        let back: ChannelStatuses = serde_json::from_str(NODE_STATUS).unwrap();
        assert_eq!(back, statuses);
        assert_eq!(
            back.iter().map(|(kind, _)| kind).collect::<Vec<_>>(),
            ["telegram", "slack", "discord", "email", "whatsapp"]
        );
        assert!(back.get("telegram").unwrap().is_running());
        assert_eq!(
            back.get("slack").unwrap().error(),
            Some("Slack refused the bot token. Copy it again.")
        );
        assert_eq!(
            back.get("whatsapp").unwrap().held,
            None,
            "a channel the manager does not hold has only its status"
        );
        assert_eq!(back.get("whatsapp").unwrap().error(), None);
        assert!(back.get("matrix").is_none());
        assert_eq!(serde_json::to_value(ChannelStatuses::new()).unwrap(), json!({}));
    }

    #[test]
    fn every_status_node_gave_reads_and_writes_back_the_same() {
        for node in [NODE_STATUS, NODE_STATUS_NOTHING, NODE_STATUS_WARNING] {
            let statuses: ChannelStatuses = serde_json::from_str(node).unwrap();
            assert_eq!(serde_json::to_string(&statuses).unwrap(), node);
        }
        let nothing: ChannelStatuses = serde_json::from_str(NODE_STATUS_NOTHING).unwrap();
        assert_eq!(nothing.len(), 5);
        assert!(
            nothing
                .iter()
                .all(|(_, s)| s.status == ChannelState::NotConfigured && s.held.is_none())
        );
        let warned: ChannelStatuses = serde_json::from_str(NODE_STATUS_WARNING).unwrap();
        let held = warned.get("whatsapp").unwrap().held.as_ref().unwrap();
        assert_eq!(held.identity, None);
        assert!(
            held.warning
                .as_deref()
                .unwrap()
                .starts_with("Saved, but couldn't check the token")
        );
    }

    #[test]
    fn a_held_channel_writes_all_four_fields_and_a_starting_one_has_none_yet() {
        let starting = ChannelStatus {
            status: ChannelState::Starting,
            held: Some(HeldChannelStatus::default()),
        };
        assert_eq!(
            serde_json::to_value(&starting).unwrap(),
            json!({"status": "starting", "error": null, "identity": null, "inviteUrl": null, "warning": null})
        );
        let discord = ChannelStatus {
            status: ChannelState::Running,
            held: Some(HeldChannelStatus {
                identity: Some("tarsee#0001".into()),
                invite_url: Some("https://discord.com/oauth2/authorize?client_id=1".into()),
                ..Default::default()
            }),
        };
        assert_eq!(
            serde_json::to_value(&discord).unwrap(),
            json!({"status": "running", "error": null, "identity": "tarsee#0001",
                   "inviteUrl": "https://discord.com/oauth2/authorize?client_id=1", "warning": null})
        );
        assert_eq!(
            serde_json::from_value::<ChannelStatus>(serde_json::to_value(&discord).unwrap()).unwrap(),
            discord
        );
        for (state, word) in [
            (ChannelState::Starting, "starting"),
            (ChannelState::Running, "running"),
            (ChannelState::Error, "error"),
            (ChannelState::Stopped, "stopped"),
            (ChannelState::NotConfigured, "not_configured"),
        ] {
            assert_eq!(state.as_str(), word);
            assert_eq!(serde_json::to_value(state).unwrap(), json!(word));
        }
    }

    /// A bot with only what every channel has: the email channel's shape, less `send_new`.
    struct Plain;

    #[async_trait]
    impl Channel for Plain {
        async fn stop(&self) -> anyhow::Result<()> {
            Ok(())
        }
        async fn send_message(&self, _chat_id: &str, _text: &str, _opts: &SendOptions) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn what_a_channel_does_not_have_answers_none_or_unsupported() {
        let bot: Arc<dyn Channel> = Arc::new(Plain);
        assert_eq!(bot.identity(), None);
        assert_eq!(bot.invite_url(), None);
        assert_eq!(bot.warning(), None);
        assert_eq!(bot.health(), None);
        bot.send_message("1", "hi", &SendOptions::default()).await.unwrap();

        let err = bot
            .send_file("1", Path::new("a.txt"), None, &SendOptions::default())
            .await
            .unwrap_err();
        assert!(err.is::<Unsupported>());
        assert_eq!(err.to_string(), "this channel does not support sendFile");
        assert_eq!(
            bot.admin(json!({})).await.unwrap_err().downcast_ref::<Unsupported>(),
            Some(&Unsupported("admin"))
        );
        assert!(bot.send_new(NewEmail::default()).await.unwrap_err().is::<Unsupported>());
        assert!(bot.handle_inbound(json!({})).await.unwrap_err().is::<Unsupported>());
    }
}
