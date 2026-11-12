//! Port of `src/lib/discord-admin.js`: Discord server admin for the agent (tarsee_discord_admin): list, make and edit
//! channels, and make webhooks, done by Tarsee's own logged-in Discord connection (the Discord channel's `admin`).
//! The agent never handles the bot token: without this tool it would pull DISCORD_BOT_TOKEN from the vault and call
//! Discord's REST API from Bash, which Claude Code's auto mode rightly blocks as a credential leak, and which writes
//! the token into the session transcript.
//!
//! Nothing here deletes: no channel, webhook or role is ever removed (clearing one permission overwrite on a channel
//! is the only removal). Deleting stays a thing the owner does by hand.
//!
//! A webhook URL is a secret (anyone with it can post as the webhook): it goes into the vault under a key name and
//! the result shows only a masked form, unless `reveal: true` is passed.
//!
//! Every call returns a plain-English string (never fails) and logs one line: the action, the server, the channel,
//! never a secret.
//!
//! The Node version worked on the `discord.js` client of the running bot. Here the connection is the
//! [`DiscordClient`] trait: exactly what this tool asks of Discord (servers, channels and their permission
//! overwrites, members, making and editing channels, making and listing webhooks, the bot's own user and picture),
//! in plain structs. The Discord channel (package H2, over `serenity`) implements it over the real connection; what
//! `discord.js` worked out for this file (the bot's permissions in a channel, the merge of an overwrite edit) is
//! spelled out on each method, with [`member_permissions`], [`member_channel_permissions`],
//! [`role_channel_permissions`] and [`apply_overwrite_set`] doing that arithmetic as `discord.js` did it.

use std::sync::LazyLock;

use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;

use crate::app::App;
use crate::lib::key_vault;
use crate::middleware::auth::JS_WHITESPACE;
use crate::util::js::number_to_string as js_number_to_string;
use crate::util::js::trim as js_trim;
use crate::util::js::{truthy, utf16_len, utf16_tail, utf16_truncate};

pub const ACTIONS: [&str; 5] = [
    "list_channels",
    "create_channel",
    "edit_channel",
    "create_webhook",
    "list_webhooks",
];
const WRITES: [&str; 3] = ["create_channel", "edit_channel", "create_webhook"];

// ---------------------------------------------------------------- Discord's numbers

/// Discord's channel types (`discord.js` `ChannelType`).
pub mod channel_type {
    pub const GUILD_TEXT: u8 = 0;
    pub const DM: u8 = 1;
    pub const GUILD_VOICE: u8 = 2;
    pub const GROUP_DM: u8 = 3;
    pub const GUILD_CATEGORY: u8 = 4;
    pub const GUILD_ANNOUNCEMENT: u8 = 5;
    pub const ANNOUNCEMENT_THREAD: u8 = 10;
    pub const PUBLIC_THREAD: u8 = 11;
    pub const PRIVATE_THREAD: u8 = 12;
    pub const GUILD_STAGE_VOICE: u8 = 13;
    pub const GUILD_DIRECTORY: u8 = 14;
    pub const GUILD_FORUM: u8 = 15;
    pub const GUILD_MEDIA: u8 = 16;
}
use channel_type::*;

/// The permissions this file names (`discord.js` `PermissionFlagsBits`). [`PERMISSION_FLAGS`] has all of them.
pub mod perm {
    pub const ADMINISTRATOR: u64 = 1 << 3;
    pub const MANAGE_CHANNELS: u64 = 1 << 4;
    pub const ADD_REACTIONS: u64 = 1 << 6;
    pub const VIEW_CHANNEL: u64 = 1 << 10;
    pub const SEND_MESSAGES: u64 = 1 << 11;
    pub const EMBED_LINKS: u64 = 1 << 14;
    pub const ATTACH_FILES: u64 = 1 << 15;
    pub const READ_MESSAGE_HISTORY: u64 = 1 << 16;
    pub const MENTION_EVERYONE: u64 = 1 << 17;
    pub const CONNECT: u64 = 1 << 20;
    pub const SPEAK: u64 = 1 << 21;
    pub const MANAGE_ROLES: u64 = 1 << 28;
    pub const MANAGE_WEBHOOKS: u64 = 1 << 29;
    pub const SEND_MESSAGES_IN_THREADS: u64 = 1 << 38;
}
use perm::*;

/// `discord.js` `PermissionFlagsBits`, every name in its order. Two names share a bit: `ManageEmojisAndStickers` is
/// the old name of `ManageGuildExpressions`.
pub const PERMISSION_FLAGS: &[(&str, u64)] = &[
    ("CreateInstantInvite", 1 << 0),
    ("KickMembers", 1 << 1),
    ("BanMembers", 1 << 2),
    ("Administrator", 1 << 3),
    ("ManageChannels", 1 << 4),
    ("ManageGuild", 1 << 5),
    ("AddReactions", 1 << 6),
    ("ViewAuditLog", 1 << 7),
    ("PrioritySpeaker", 1 << 8),
    ("Stream", 1 << 9),
    ("ViewChannel", 1 << 10),
    ("SendMessages", 1 << 11),
    ("SendTTSMessages", 1 << 12),
    ("ManageMessages", 1 << 13),
    ("EmbedLinks", 1 << 14),
    ("AttachFiles", 1 << 15),
    ("ReadMessageHistory", 1 << 16),
    ("MentionEveryone", 1 << 17),
    ("UseExternalEmojis", 1 << 18),
    ("ViewGuildInsights", 1 << 19),
    ("Connect", 1 << 20),
    ("Speak", 1 << 21),
    ("MuteMembers", 1 << 22),
    ("DeafenMembers", 1 << 23),
    ("MoveMembers", 1 << 24),
    ("UseVAD", 1 << 25),
    ("ChangeNickname", 1 << 26),
    ("ManageNicknames", 1 << 27),
    ("ManageRoles", 1 << 28),
    ("ManageWebhooks", 1 << 29),
    ("ManageEmojisAndStickers", 1 << 30),
    ("ManageGuildExpressions", 1 << 30),
    ("UseApplicationCommands", 1 << 31),
    ("RequestToSpeak", 1 << 32),
    ("ManageEvents", 1 << 33),
    ("ManageThreads", 1 << 34),
    ("CreatePublicThreads", 1 << 35),
    ("CreatePrivateThreads", 1 << 36),
    ("UseExternalStickers", 1 << 37),
    ("SendMessagesInThreads", 1 << 38),
    ("UseEmbeddedActivities", 1 << 39),
    ("ModerateMembers", 1 << 40),
    ("ViewCreatorMonetizationAnalytics", 1 << 41),
    ("UseSoundboard", 1 << 42),
    ("CreateGuildExpressions", 1 << 43),
    ("CreateEvents", 1 << 44),
    ("UseExternalSounds", 1 << 45),
    ("SendVoiceMessages", 1 << 46),
    ("SetVoiceChannelStatus", 1 << 48),
    ("SendPolls", 1 << 49),
    ("UseExternalApps", 1 << 50),
    ("PinMessages", 1 << 51),
    ("BypassSlowmode", 1 << 52),
];

/// Every permission at once (`PermissionsBitField.All`).
pub const ALL_PERMISSIONS: u64 = {
    let mut all = 0;
    let mut i = 0;
    while i < PERMISSION_FLAGS.len() {
        all |= PERMISSION_FLAGS[i].1;
        i += 1;
    }
    all
};

/// `permissions.has(bit)` as `discord.js` answers it: Administrator has everything.
pub fn has_permission(permissions: u64, bit: u64) -> bool {
    permissions & ADMINISTRATOR == ADMINISTRATOR || permissions & bit == bit
}

/// Each bit with its name, in the order the names first appear; a bit with two names takes the later one
/// (`new Map(Object.entries(P).map(([name, bit]) => [bit, name]))`).
static FLAG_NAME: LazyLock<Vec<(u64, &'static str)>> = LazyLock::new(|| {
    let mut names: Vec<(u64, &'static str)> = Vec::new();
    for &(name, bit) in PERMISSION_FLAGS {
        match names.iter_mut().find(|(b, _)| *b == bit) {
            Some(entry) => entry.1 = name,
            None => names.push((bit, name)),
        }
    }
    names
});

fn flag_name(bit: u64) -> Option<&'static str> {
    FLAG_NAME.iter().find(|(b, _)| *b == bit).map(|(_, name)| *name)
}

const PERM_ALIASES: &[(&str, &str)] = &[
    ("view", "ViewChannel"),
    ("see", "ViewChannel"),
    ("send", "SendMessages"),
    ("write", "SendMessages"),
    ("history", "ReadMessageHistory"),
    ("readhistory", "ReadMessageHistory"),
    ("react", "AddReactions"),
    ("reactions", "AddReactions"),
    ("attach", "AttachFiles"),
    ("files", "AttachFiles"),
    ("embed", "EmbedLinks"),
    ("embeds", "EmbedLinks"),
    ("links", "EmbedLinks"),
    ("managechannel", "ManageChannels"),
    ("managepermissions", "ManageRoles"),
    ("threads", "SendMessagesInThreads"),
    ("mentioneveryone", "MentionEveryone"),
];

// What people let into a private channel (and the bot itself) may do there, by channel type.
const TEXT_ACCESS: [u64; 6] = [
    VIEW_CHANNEL,
    SEND_MESSAGES,
    READ_MESSAGE_HISTORY,
    EMBED_LINKS,
    ATTACH_FILES,
    ADD_REACTIONS,
];
const VOICE_ACCESS: [u64; 5] = [VIEW_CHANNEL, CONNECT, SPEAK, SEND_MESSAGES, READ_MESSAGE_HISTORY];
const CATEGORY_ACCESS: [u64; 8] = [
    VIEW_CHANNEL,
    SEND_MESSAGES,
    READ_MESSAGE_HISTORY,
    EMBED_LINKS,
    ATTACH_FILES,
    ADD_REACTIONS,
    CONNECT,
    SPEAK,
];

fn access_for(kind: u8) -> &'static [u64] {
    match kind {
        GUILD_TEXT => &TEXT_ACCESS,
        GUILD_VOICE => &VOICE_ACCESS,
        GUILD_CATEGORY => &CATEGORY_ACCESS,
        _ => &TEXT_ACCESS,
    }
}

static SNOWFLAKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{15,25}$").expect("the snowflake pattern"));
static KEY_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]{1,63}$").expect("the key name pattern"));

fn type_of(key: &str) -> Option<u8> {
    match key {
        "text" => Some(GUILD_TEXT),
        "voice" => Some(GUILD_VOICE),
        "category" => Some(GUILD_CATEGORY),
        _ => None,
    }
}

fn type_label(kind: u8) -> Option<&'static str> {
    match kind {
        GUILD_TEXT => Some("text"),
        GUILD_VOICE => Some("voice"),
        GUILD_CATEGORY => Some("category"),
        GUILD_ANNOUNCEMENT => Some("announcement"),
        GUILD_STAGE_VOICE => Some("stage"),
        GUILD_FORUM => Some("forum"),
        GUILD_MEDIA => Some("media"),
        _ => None,
    }
}

fn voice_like(kind: u8) -> bool {
    kind == GUILD_VOICE || kind == GUILD_STAGE_VOICE
}

/// `channel.isThread()`.
fn is_thread(kind: u8) -> bool {
    matches!(kind, ANNOUNCEMENT_THREAD | PUBLIC_THREAD | PRIVATE_THREAD)
}

/// Whether `discord.js` gave a channel of this type `fetchWebhooks` and `createWebhook`: text, announcement, voice,
/// stage, forum and media channels (not categories, directories, threads or DMs).
fn can_have_webhooks(kind: u8) -> bool {
    matches!(
        kind,
        GUILD_TEXT | GUILD_ANNOUNCEMENT | GUILD_VOICE | GUILD_STAGE_VOICE | GUILD_FORUM | GUILD_MEDIA
    )
}

// ---------------------------------------------------------------- what this tool asks of Discord

/// Whose permission overwrite it is (`discord.js` `OverwriteType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverwriteKind {
    Role = 0,
    Member = 1,
}

/// One permission overwrite on a channel: the allowed and denied bits for a role or a member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overwrite {
    pub id: String,
    pub kind: OverwriteKind,
    pub allow: u64,
    pub deny: u64,
}

/// A server's role (`guild.roles.cache`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Role {
    pub id: String,
    pub name: String,
}

/// A server the bot is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guild {
    pub id: String,
    pub name: String,
    /// `guild.roles.cache`: every role, @everyone (whose id is the server's) included.
    pub roles: Vec<Role>,
    /// `guild.members.me?.permissions`: the bot's own permissions in the server ([`member_permissions`]), `None` when
    /// the connection does not know the bot's member.
    pub bot_permissions: Option<u64>,
}

/// A channel of a server, or a direct message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Channel {
    pub id: String,
    /// Empty for a direct message.
    pub name: String,
    /// One of [`channel_type`].
    pub kind: u8,
    /// The server it is in; `None` for a direct message.
    pub guild_id: Option<String>,
    /// The category it is in (a thread: its channel).
    pub parent_id: Option<String>,
    /// `None` when it has none (the JS `position ?? 0`).
    pub position: Option<i64>,
    /// `permissionOverwrites.cache`.
    pub overwrites: Vec<Overwrite>,
    /// `channel.permissionsFor(guild.members.me)`: the bot's permissions here ([`member_channel_permissions`]; a
    /// thread: its channel's). `None` when the bot's member is not known.
    pub bot_permissions: Option<u64>,
    /// `channel.permissionsFor(guild.roles.everyone)`: what @everyone may do here ([`role_channel_permissions`]; a
    /// thread: its channel's). `None` when it cannot be worked out (a direct message).
    pub everyone_permissions: Option<u64>,
}

/// A member of a server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub id: String,
    /// `member.displayName`: the server nickname, else the user's display name, else the username.
    pub display_name: Option<String>,
    /// `member.user.username`.
    pub username: Option<String>,
}

/// The bot's own user (`client.user`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotUser {
    pub id: String,
    /// `client.user.displayAvatarURL({ extension: "png", size: 256 })`.
    pub avatar_url: Option<String>,
}

/// A webhook as `channel.fetchWebhooks()` lists it. Its token is never asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Webhook {
    pub id: String,
    /// Discord lets a webhook have no name.
    pub name: Option<String>,
    /// 1 incoming, 2 channel follower, 3 application.
    pub kind: u8,
    /// `webhook.owner?.username`: who made it.
    pub owner_username: Option<String>,
}

/// What `channel.createWebhook()` gave back. Without a token there is no URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedWebhook {
    pub id: String,
    pub token: Option<String>,
}

/// `guild.channels.create({ name, type, parent, topic, permissionOverwrites, reason })`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewChannel {
    pub name: String,
    /// One of [`channel_type`].
    pub kind: u8,
    /// `parent`: the category to put it in.
    pub parent_id: Option<String>,
    pub topic: Option<String>,
    /// `None`: no overwrites at all (Discord then syncs nothing and the channel is public).
    pub permission_overwrites: Option<Vec<Overwrite>>,
    /// For the server's audit log.
    pub reason: String,
}

/// `channel.edit({ name, topic, parent, lockPermissions, reason })`. A field that is `None` is not sent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChannelEdit {
    pub name: Option<String>,
    pub topic: Option<String>,
    /// `Some(None)` takes it out of its category (`parent: null`); `Some(Some(id))` moves it into that one.
    pub parent: Option<Option<String>>,
    /// `lockPermissions: true`: the channel's overwrites become those of its category. `discord.js` sent both
    /// `lock_permissions` and the overwrites themselves: the new category's when `parent` names one, else the
    /// current category's.
    pub lock_permissions: bool,
    pub reason: String,
}

/// `channel.createWebhook({ name, avatar, reason })`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWebhook {
    pub name: String,
    /// The picture's URL (the bot's own, [`BotUser::avatar_url`]); `discord.js` downloaded it and sent the image
    /// itself. `None`: no picture (`avatar: null`).
    pub avatar: Option<String>,
    pub reason: String,
}

/// A refusal or failure from Discord (`DiscordAPIError`): its JSON error code (50013 Missing Permissions, ...) when
/// there is one, and its message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct DiscordError {
    pub code: Option<i64>,
    pub message: String,
}

impl DiscordError {
    pub fn new(code: Option<i64>, message: impl Into<String>) -> Self {
        DiscordError {
            code,
            message: message.into(),
        }
    }
}

/// What this tool needs from the logged-in Discord connection. The Node version used the `discord.js` client; each
/// method names the call it stands for. Reads that `discord.js` answered from its cache first and then fetched
/// (`cache.get(id) ?? await fetch(id).catch(() => null)`) answer `None` when neither has it.
#[async_trait]
pub trait DiscordClient: Send + Sync {
    /// `client.user`: the bot's own user, `None` before it has logged in.
    fn user(&self) -> Option<BotUser>;

    /// `client.isReady()`.
    fn is_ready(&self) -> bool;

    /// `client.guilds.cache`: the servers the bot is in, in the cache's order.
    fn guilds(&self) -> Vec<Guild>;

    /// `client.guilds.cache.get(id) ?? await client.guilds.fetch(id)`.
    async fn fetch_guild(&self, id: &str) -> Option<Guild>;

    /// `client.channels.cache.get(id) ?? await client.channels.fetch(id)`.
    async fn fetch_channel(&self, id: &str) -> Option<Channel>;

    /// `guild.channels.cache`: every channel of the server the connection holds, threads included.
    fn guild_channels(&self, guild_id: &str) -> Vec<Channel>;

    /// `guild.members.cache.get(id) ?? await guild.members.fetch(id)`.
    async fn fetch_member(&self, guild_id: &str, user_id: &str) -> Option<Member>;

    /// `guild.channels.create(...)`: the channel made.
    async fn create_channel(&self, guild_id: &str, request: NewChannel) -> Result<Channel, DiscordError>;

    /// `channel.edit(...)`: the channel as it is now, when Discord sent it back.
    async fn edit_channel(&self, channel_id: &str, request: ChannelEdit) -> Result<Option<Channel>, DiscordError>;

    /// `channel.setPosition(position, { reason })`. `discord.js` took the channel's sorted group in the server
    /// (`guild._sortedChannels(channel)`), moved the channel to `position` in it, numbered the group from 0 and sent
    /// all of it (`PATCH /guilds/{id}/channels`).
    async fn set_channel_position(&self, channel_id: &str, position: i64, reason: &str) -> Result<(), DiscordError>;

    /// `channel.permissionOverwrites.edit(target, set, { type, reason })`. `set` is the JS object of flag to
    /// true (allow), false (deny) or null (back to the default), in its key order; `discord.js` applied it to the
    /// target's overwrite already on the channel ([`apply_overwrite_set`]) and sent the result.
    async fn edit_permission_overwrite(
        &self,
        channel_id: &str,
        target_id: &str,
        kind: OverwriteKind,
        set: &[(u64, Option<bool>)],
        reason: &str,
    ) -> Result<(), DiscordError>;

    /// `channel.permissionOverwrites.delete(target, reason)`: the one removal this tool makes.
    async fn delete_permission_overwrite(
        &self,
        channel_id: &str,
        target_id: &str,
        reason: &str,
    ) -> Result<(), DiscordError>;

    /// `channel.fetchWebhooks()`.
    async fn fetch_webhooks(&self, channel_id: &str) -> Result<Vec<Webhook>, DiscordError>;

    /// `channel.createWebhook(...)`.
    async fn create_webhook(&self, channel_id: &str, request: NewWebhook) -> Result<CreatedWebhook, DiscordError>;
}

// ---------------------------------------------------------------- the permission arithmetic of discord.js

/// `GuildMember.permissions`: everything for the server's owner, else the union of the member's roles' permissions
/// (@everyone's included).
pub fn member_permissions(is_owner: bool, role_permissions: &[u64]) -> u64 {
    if is_owner {
        return ALL_PERMISSIONS;
    }
    role_permissions.iter().fold(0, |all, p| all | p)
}

/// `GuildChannel.permissionsFor(member)` (`memberPermissions(member, true)`): everything for the owner or an
/// Administrator; else the member's roles' permissions, then the channel's @everyone overwrite, the overwrites of
/// the member's roles, and the member's own, each taking away its deny and adding its allow. `role_ids` are the
/// member's roles (@everyone's id, the server's, may be among them), `role_permissions` their permissions.
pub fn member_channel_permissions(
    guild_id: &str,
    member_id: &str,
    is_owner: bool,
    role_ids: &[&str],
    role_permissions: &[u64],
    overwrites: &[Overwrite],
) -> u64 {
    if is_owner {
        return ALL_PERMISSIONS;
    }
    let mut permissions = role_permissions.iter().fold(0, |all, p| all | p);
    if has_permission(permissions, ADMINISTRATOR) {
        return ALL_PERMISSIONS;
    }
    let mut everyone = None;
    let mut roles = Vec::new();
    let mut member = None;
    for overwrite in overwrites {
        if overwrite.id == guild_id {
            everyone = Some(overwrite);
        } else if role_ids.contains(&overwrite.id.as_str()) {
            roles.push(overwrite);
        } else if overwrite.id == member_id {
            member = Some(overwrite);
        }
    }
    if let Some(o) = everyone {
        permissions = (permissions & !o.deny) | o.allow;
    }
    let role_deny = roles.iter().fold(0, |all, o| all | o.deny);
    let role_allow = roles.iter().fold(0, |all, o| all | o.allow);
    permissions = (permissions & !role_deny) | role_allow;
    if let Some(o) = member {
        permissions = (permissions & !o.deny) | o.allow;
    }
    permissions
}

/// `GuildChannel.permissionsFor(role)` (`rolePermissions(role, true)`): everything for an Administrator role; else
/// the role's and @everyone's permissions, then the channel's @everyone overwrite and the role's own.
pub fn role_channel_permissions(
    guild_id: &str,
    role_id: &str,
    role_permissions: u64,
    everyone_permissions: u64,
    overwrites: &[Overwrite],
) -> u64 {
    if has_permission(role_permissions, ADMINISTRATOR) {
        return ALL_PERMISSIONS;
    }
    let mut permissions = role_permissions | everyone_permissions;
    if let Some(o) = overwrites.iter().find(|o| o.id == guild_id) {
        permissions = (permissions & !o.deny) | o.allow;
    }
    if let Some(o) = overwrites.iter().find(|o| o.id == role_id) {
        permissions = (permissions & !o.deny) | o.allow;
    }
    permissions
}

/// `PermissionOverwrites.resolveOverwriteOptions(set, existing)`: the overwrite a target ends up with when `set` is
/// applied to the one it has (`(0, 0)` for none). Returns `(allow, deny)`.
pub fn apply_overwrite_set(existing: Option<&Overwrite>, set: &[(u64, Option<bool>)]) -> (u64, u64) {
    let (mut allow, mut deny) = existing.map(|o| (o.allow, o.deny)).unwrap_or((0, 0));
    for &(bit, value) in set {
        match value {
            Some(true) => {
                allow |= bit;
                deny &= !bit;
            }
            Some(false) => {
                allow &= !bit;
                deny |= bit;
            }
            None => {
                allow &= !bit;
                deny &= !bit;
            }
        }
    }
    (allow, deny)
}

// ---------------------------------------------------------------- the vault

/// Where a webhook's URL is saved: the key vault (`lib/key-vault.js`), or a stand-in in tests.
pub trait WebhookVault: Send + Sync {
    fn has_key(&self, name: &str) -> bool;
    fn set_key(&self, name: &str, value: &str, description: &str) -> anyhow::Result<()>;
}

/// The app's key vault.
pub struct AppVault<'a>(pub &'a App);

impl WebhookVault for AppVault<'_> {
    fn has_key(&self, name: &str) -> bool {
        key_vault::has_key(self.0, name)
    }

    fn set_key(&self, name: &str, value: &str, description: &str) -> anyhow::Result<()> {
        key_vault::set_key(self.0, name, value, Some(description)).map(|_| ())
    }
}

// ---------------------------------------------------------------- helpers people read

static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new("([a-z])([A-Z])").expect("the camel case pattern"));

/// "ManageChannels" as Discord's settings show it: "Manage Channels".
pub fn perm_label(bit: u64) -> String {
    if bit == MANAGE_ROLES {
        return "Manage Permissions (Manage Roles)".to_string();
    }
    let name = flag_name(bit).map(str::to_string).unwrap_or_else(|| bit.to_string());
    CAMEL.replace_all(&name, "$1 $2").into_owned()
}

static PERM_SEPARATORS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{JS_WHITESPACE}|[_-]")).expect("the permission separators"));

/// A permission by its Discord name in any case ("ViewChannel", "view_channel", "View Channel") or a short alias
/// ("view", "send").
pub fn perm_flag(name: &str) -> Option<u64> {
    let key = PERM_SEPARATORS.replace_all(&name.to_lowercase(), "").into_owned();
    if key.is_empty() {
        return None;
    }
    if let Some((_, flag)) = PERM_ALIASES.iter().find(|(alias, _)| *alias == key) {
        return PERMISSION_FLAGS.iter().find(|(n, _)| n == flag).map(|(_, bit)| *bit);
    }
    PERMISSION_FLAGS
        .iter()
        .find(|(n, _)| n.to_lowercase() == key)
        .map(|(_, bit)| *bit)
}

/// A webhook URL with its token hidden: the id stays, so a person can tell which webhook it is.
pub fn mask_webhook_url(id: &str, token: &str) -> String {
    format!("https://discord.com/api/webhooks/{id}/****{}", utf16_tail(token, 4))
}

static NOT_KEY_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^A-Z0-9]+").expect("the key characters"));

/// The same key name the vault would want from a free-form one: "uptime watchdog webhook" becomes
/// UPTIME_WATCHDOG_WEBHOOK.
pub fn key_name_from(raw: &str) -> String {
    let upper = js_trim(raw).to_uppercase();
    let joined = NOT_KEY_CHARS.replace_all(&upper, "_");
    let mut name = joined.trim_matches('_').to_string();
    if name.starts_with(|c: char| c.is_ascii_digit()) {
        name.insert_str(0, "K_");
    }
    // Only capitals, digits and underscores are left, so 64 characters are 64 bytes.
    name.truncate(64);
    name.trim_end_matches('_').to_string()
}

// ---------------------------------------------------------------- JavaScript's reading of values

/// `String(value)` for a JSON value.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        // An array prints its items joined by commas, null as nothing.
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `${value}` in a template, where a missing field is `undefined`.
pub(crate) fn js_template(value: Option<&Value>) -> String {
    value.map(js_string).unwrap_or_else(|| "undefined".to_string())
}

/// `String(value ?? "")`.
pub(crate) fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

/// A field of the tool's input, the JS `args.field` (`None` is `undefined`).
fn arg<'a>(args: &'a Value, field: &str) -> Option<&'a Value> {
    args.get(field)
}

/// `if (args.field)`.
fn is_set(args: &Value, field: &str) -> bool {
    arg(args, field).is_some_and(truthy)
}

/// `Array.isArray(args.field) ? args.field : []`.
fn list_of<'a>(args: &'a Value, field: &str) -> &'a [Value] {
    match arg(args, field) {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

static WHITESPACE_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{JS_WHITESPACE}+")).expect("the whitespace pattern"));

/// `String(s).replace(/\s+/g, " ").trim()`.
pub(crate) fn one_line(text: &str) -> String {
    js_trim(&WHITESPACE_RUN.replace_all(text, " ")).to_string()
}

/// `text.replace(/^<prefix|>$/g, "")` for the mention prefixes: the longest of `prefixes` that starts the text, and
/// one `>` at its end.
fn strip_mention(text: &str, prefixes: &[&str]) -> String {
    let mut rest = text;
    if let Some(prefix) = prefixes.iter().find(|p| rest.starts_with(**p)) {
        rest = &rest[prefix.len()..];
    }
    rest.strip_suffix('>').unwrap_or(rest).to_string()
}

// ---------------------------------------------------------------- the tool

/// How [`discord_admin`] reaches Discord, the vault and the log.
pub struct DiscordAdminDeps<'a> {
    /// The logged-in connection.
    pub client: &'a dyn DiscordClient,
    /// Where a webhook URL is saved. `None`: the app's key vault.
    pub vault: Option<&'a dyn WebhookVault>,
    /// One line per action. `None`: `log::info!` (the JS `console.log`).
    pub log: Option<&'a (dyn Fn(&str) + Send + Sync)>,
}

impl<'a> DiscordAdminDeps<'a> {
    pub fn new(client: &'a dyn DiscordClient) -> Self {
        DiscordAdminDeps {
            client,
            vault: None,
            log: None,
        }
    }
}

/// Why an action stopped: the tool's own refusal (the JS `AdminError`), or Discord's.
enum Failure {
    Admin(String),
    Discord(DiscordError),
}

impl From<DiscordError> for Failure {
    fn from(err: DiscordError) -> Self {
        Failure::Discord(err)
    }
}

type Step<T> = Result<T, Failure>;

fn fail<T>(message: impl Into<String>) -> Step<T> {
    Err(Failure::Admin(message.into()))
}

/// What the log line and the error texts know about where the action got to.
#[derive(Default)]
struct Note {
    guild: Option<Guild>,
    channel: Option<Channel>,
    hands_out: Vec<u64>,
}

struct Ctx<'a> {
    args: &'a Value,
    client: &'a dyn DiscordClient,
    /// The bot's own user id (`client.user.id`).
    bot_id: String,
    bot_avatar: Option<String>,
}

/// Runs the tool: `args` is its input (see the tarsee_discord_admin schema in `ai/tarsee_mcp.rs`). Always answers
/// with text.
pub async fn discord_admin(app: &App, args: &Value, deps: DiscordAdminDeps<'_>) -> String {
    let action = js_string_or_empty(arg(args, "action"));
    let mut note = Note::default();
    let app_vault = AppVault(app);
    let vault: &dyn WebhookVault = deps.vault.unwrap_or(&app_vault);

    let result = run(args, &action, deps.client, vault, &mut note).await;
    let (outcome, answer) = match result {
        Ok(out) => ("ok".to_string(), out),
        Err(failure) => {
            let text = match failure {
                Failure::Admin(message) => message,
                Failure::Discord(err) => discord_error_text(&err, &action, &note),
            };
            let outcome = format!("failed: {}", utf16_truncate(&one_line(&text), 200));
            let shown = if action.is_empty() { "" } else { action.as_str() };
            (
                outcome,
                format!("discord_admin {shown} error: {text}").replace("  ", " "),
            )
        }
    };
    let guild = note
        .guild
        .as_ref()
        .map(|g| format!("\"{}\" ({})", g.name, g.id))
        .unwrap_or_else(|| "-".to_string());
    let channel = note
        .channel
        .as_ref()
        .map(|c| format!("#{} ({})", c.name, c.id))
        .unwrap_or_else(|| "-".to_string());
    let shown = if action.is_empty() {
        "(no action)"
    } else {
        action.as_str()
    };
    let line = format!("[discord-admin] {shown} guild={guild} channel={channel} {outcome}");
    match deps.log {
        Some(log) => log(&line),
        None => log::info!("{line}"),
    }
    answer
}

async fn run(
    args: &Value,
    action: &str,
    client: &dyn DiscordClient,
    vault: &dyn WebhookVault,
    note: &mut Note,
) -> Step<String> {
    if !ACTIONS.contains(&action) {
        return fail(format!(
            "Unknown action \"{action}\". This tool does: {}. It never deletes anything: deleting a channel or a webhook is something the owner does by hand in Discord.",
            ACTIONS.join(", ")
        ));
    }
    let user = match client.user() {
        Some(user) if client.is_ready() => user,
        _ => return fail("Discord is not connected right now, so nothing was done. Try again in a minute."),
    };
    if WRITES.contains(&action) && js_trim(&js_string_or_empty(arg(args, "approved_by"))).is_empty() {
        return fail(format!(
            "{action} changes a Discord server, so it needs approved_by: who gave the go and for what, e.g. \"the owner in #general: make #alerts and a webhook\". If nobody has said go for this exact change, ask first. Nothing was done."
        ));
    }
    let ctx = Ctx {
        args,
        client,
        bot_id: user.id,
        bot_avatar: user.avatar_url,
    };
    match action {
        "list_channels" => list_channels(&ctx, note).await,
        "create_channel" => create_channel(&ctx, note).await,
        "edit_channel" => edit_channel(&ctx, note).await,
        "create_webhook" => create_webhook(&ctx, vault, note).await,
        _ => list_webhooks(&ctx, note).await,
    }
}

fn reason_of(args: &Value) -> String {
    let go = one_line(&js_template(arg(args, "approved_by")));
    utf16_truncate(&format!("Done by the Tarsee agent. Go from: {go}"), 500)
}

fn guild_label(guild: &Guild) -> String {
    format!("\"{}\" (server id {})", guild.name, guild.id)
}

fn where_of(note: &Note) -> String {
    match (&note.channel, &note.guild) {
        (Some(channel), Some(guild)) => format!("#{} in the server {}", channel.name, guild_label(guild)),
        (_, Some(guild)) => format!("the server {}", guild_label(guild)),
        _ => "that server".to_string(),
    }
}

/// What a refusal from Discord means, in plain words.
fn discord_error_text(err: &DiscordError, action: &str, note: &Note) -> String {
    let code = err.code.unwrap_or(0);
    let need: &[u64] = match action {
        "create_channel" => &[MANAGE_CHANNELS],
        "edit_channel" => &[MANAGE_CHANNELS, MANAGE_ROLES],
        "create_webhook" | "list_webhooks" => &[MANAGE_WEBHOOKS],
        "list_channels" => &[VIEW_CHANNEL],
        _ => &[],
    };
    match code {
        50013 => {
            // Discord also refuses access that hands out a permission the bot does not have itself.
            let beyond = match &note.guild {
                Some(guild) if !note.hands_out.is_empty() => missing_perms(guild, None, &note.hands_out),
                _ => Vec::new(),
            };
            let also = if beyond.is_empty() {
                String::new()
            } else {
                format!(
                    " The access being set also hands out {}, which the bot's role does not have, and Discord only lets a bot hand out permissions it has itself.",
                    labels(&beyond, ", ")
                )
            };
            let needed = if need.is_empty() {
                "see Discord's message".to_string()
            } else {
                labels(need, " and ")
            };
            format!(
                "Discord refused: the bot is missing a permission it needs in {} ({needed}).{also} Discord said: \"{}\". Ask the owner to give the bot's role that permission (Server Settings > Roles), or to do this by hand. Nothing more was changed.",
                where_of(note),
                err.message
            )
        }
        50001 => format!(
            "Discord refused: the bot cannot see {} (Missing Access). Discord said: \"{}\".",
            where_of(note),
            err.message
        ),
        10003 => "Discord says there is no such channel (or the bot cannot see it). Check the channel id.".to_string(),
        10004 => "Discord says the bot is not in that server. Check the guild id.".to_string(),
        30007 => "That channel already has the most webhooks Discord allows (15). Reuse one (list_webhooks shows them) or ask the owner to remove an old one.".to_string(),
        30013 => "The server already has the most channels Discord allows (500).".to_string(),
        50035 => format!("Discord did not accept the values: \"{}\".", err.message),
        _ => {
            let message = if err.message.is_empty() { "Error" } else { err.message.as_str() };
            let code = if code != 0 { format!(" (code {code})") } else { String::new() };
            format!("Discord said: \"{message}\"{code}.")
        }
    }
}

fn labels(bits: &[u64], separator: &str) -> String {
    bits.iter().map(|b| perm_label(*b)).collect::<Vec<_>>().join(separator)
}

/// The bot's own permissions it lacks in a channel (or the whole server), from what the connection knows; Discord
/// still has the last word.
fn missing_perms(guild: &Guild, channel: Option<&Channel>, bits: &[u64]) -> Vec<u64> {
    let Some(me) = guild.bot_permissions else {
        return Vec::new();
    };
    let permissions = match channel {
        Some(channel) => channel.bot_permissions,
        None => Some(me),
    };
    let Some(permissions) = permissions else {
        return Vec::new();
    };
    bits.iter()
        .copied()
        .filter(|b| !has_permission(permissions, *b))
        .collect()
}

fn require_perms(guild: &Guild, channel: Option<&Channel>, bits: &[u64], what: &str) -> Step<()> {
    let lack = missing_perms(guild, channel, bits);
    if lack.is_empty() {
        return Ok(());
    }
    let place = match channel {
        Some(channel) => format!("#{} in the server {}", channel.name, guild_label(guild)),
        None => format!("the server {}", guild_label(guild)),
    };
    fail(format!(
        "the bot is missing the {} permission in {place}, so it cannot {what}. Ask the owner to give the bot's role that permission (Server Settings > Roles), or to do it by hand. Nothing was changed.",
        labels(&lack, " and ")
    ))
}

async fn fetch_channel(client: &dyn DiscordClient, raw: Option<&Value>, label: &str) -> Step<Channel> {
    let want = js_trim(&strip_mention(&js_string_or_empty(raw), &["<#"])).to_string();
    if !SNOWFLAKE.is_match(&want) {
        return fail(format!(
            "{label} \"{}\" is not a Discord channel id (a long number; the channel mention <#123...> works too).",
            js_template(raw)
        ));
    }
    match client.fetch_channel(&want).await {
        Some(channel) => Ok(channel),
        None => fail(format!("No channel with id {want} that the bot can see ({label}).")),
    }
}

/// `channel.guild`: the server a channel is in, `None` for a direct message.
async fn guild_of(client: &dyn DiscordClient, channel: &Channel) -> Option<Guild> {
    let id = channel.guild_id.as_deref()?;
    match client.guilds().into_iter().find(|g| g.id == id) {
        Some(guild) => Some(guild),
        None => client.fetch_guild(id).await,
    }
}

/// `channel.parent`: its category (a thread's: its channel), from what the connection holds.
fn parent_of(client: &dyn DiscordClient, channel: &Channel) -> Option<Channel> {
    let (guild_id, parent_id) = (channel.guild_id.as_deref()?, channel.parent_id.as_deref()?);
    client.guild_channels(guild_id).into_iter().find(|c| c.id == parent_id)
}

/// The server: guild_id, else the server of the first channel id given (channel_id, e.g. the one you are answering
/// in, then parent_id, near_channel_id, copy_permissions_from), else the only server the bot is in. The error is
/// the text the tool would answer with.
pub async fn resolve_guild(client: &dyn DiscordClient, args: &Value) -> Result<Guild, String> {
    match resolve_guild_step(client, args).await {
        Ok(guild) => Ok(guild),
        Err(Failure::Admin(message)) => Err(message),
        Err(Failure::Discord(err)) => Err(err.message),
    }
}

async fn resolve_guild_step(client: &dyn DiscordClient, args: &Value) -> Step<Guild> {
    if is_set(args, "guild_id") {
        let raw = arg(args, "guild_id");
        let id = js_trim(&js_template(raw)).to_string();
        if !SNOWFLAKE.is_match(&id) {
            return fail(format!("guild_id \"{}\" is not a Discord server id.", js_template(raw)));
        }
        return match client.fetch_guild(&id).await {
            Some(guild) => Ok(guild),
            None => fail(format!(
                "The bot is not in a server with id {id}. {}",
                servers_list(client)
            )),
        };
    }
    for field in ["channel_id", "parent_id", "near_channel_id", "copy_permissions_from"] {
        let value = arg(args, field);
        if !value.is_some_and(truthy) || value == Some(&Value::String("none".into())) {
            continue;
        }
        let channel = fetch_channel(client, value, field).await?;
        return match guild_of(client, &channel).await {
            Some(guild) => Ok(guild),
            None => fail(format!(
                "{field} {} is a direct message, not a channel in a server.",
                channel.id
            )),
        };
    }
    let mut all = client.guilds();
    if all.len() == 1 {
        return Ok(all.remove(0));
    }
    if all.is_empty() {
        return fail("The bot is not in any Discord server.");
    }
    fail(format!(
        "The bot is in {} servers, so say which: pass guild_id, or channel_id of any channel in it (the one you are answering in works). {}",
        all.len(),
        servers_list(client)
    ))
}

fn servers_list(client: &dyn DiscordClient) -> String {
    let all = client.guilds();
    if all.is_empty() {
        return String::new();
    }
    let names = all
        .iter()
        .map(|g| format!("{} ({})", g.name, g.id))
        .collect::<Vec<_>>()
        .join(", ");
    format!("Servers the bot is in: {names}.")
}

fn type_name(channel: &Channel) -> String {
    type_label(channel.kind)
        .map(str::to_string)
        .unwrap_or_else(|| format!("type {}", channel.kind))
}

/// `guild.roles.everyone.id`: @everyone's role has the server's id.
fn everyone_id(guild: &Guild) -> &str {
    &guild.id
}

fn is_private(channel: &Channel) -> bool {
    channel
        .everyone_permissions
        .is_some_and(|p| !has_permission(p, VIEW_CHANNEL))
}

fn jump_link(guild: &Guild, channel: &Channel) -> String {
    format!("https://discord.com/channels/{}/{}", guild.id, channel.id)
}

fn same_guild(guild: &Guild, channel: &Channel, field: &str) -> Step<()> {
    if channel.guild_id.as_deref() != Some(guild.id.as_str()) {
        return fail(format!(
            "{field} {} is not in the server {}.",
            channel.id,
            guild_label(guild)
        ));
    }
    Ok(())
}

fn role<'g>(guild: &'g Guild, id: &str) -> Option<&'g Role> {
    guild.roles.iter().find(|r| r.id == id)
}

// ---------------------------------------------------------------- list_channels

async fn list_channels(ctx: &Ctx<'_>, note: &mut Note) -> Step<String> {
    let guild = resolve_guild_step(ctx.client, ctx.args).await?;
    note.guild = Some(guild.clone());
    let chans: Vec<Channel> = ctx
        .client
        .guild_channels(&guild.id)
        .into_iter()
        .filter(|c| !is_thread(c.kind))
        .collect();
    let by_pos = |a: &&Channel, b: &&Channel| {
        (voice_like(a.kind) as i8, a.position.unwrap_or(0)).cmp(&(voice_like(b.kind) as i8, b.position.unwrap_or(0)))
    };
    let me = guild.bot_permissions.is_some();
    let line = |c: &Channel, indent: &str| {
        let mut bits = vec![
            type_name(c),
            format!("position {}", c.position.unwrap_or(0)),
            if is_private(c) { "private" } else { "public" }.to_string(),
        ];
        if me && !c.bot_permissions.is_some_and(|p| has_permission(p, VIEW_CHANNEL)) {
            bits.push("the bot cannot see it".to_string());
        }
        let prefix = if c.kind == GUILD_CATEGORY {
            "Category "
        } else if voice_like(c.kind) {
            ""
        } else {
            "#"
        };
        format!("{indent}{prefix}{} (id {}): {}", c.name, c.id, bits.join(", "))
    };
    let mut cats: Vec<&Channel> = chans.iter().filter(|c| c.kind == GUILD_CATEGORY).collect();
    cats.sort_by(by_pos);
    let mut top: Vec<&Channel> = chans
        .iter()
        .filter(|c| c.kind != GUILD_CATEGORY && c.parent_id.as_deref().is_none_or(str::is_empty))
        .collect();
    top.sort_by(by_pos);
    let can = [MANAGE_CHANNELS, MANAGE_ROLES, MANAGE_WEBHOOKS]
        .iter()
        .map(|b| {
            let lacks = !missing_perms(&guild, None, &[*b]).is_empty();
            format!("{} {}", perm_label(*b), if lacks { "no" } else { "yes" })
        })
        .collect::<Vec<_>>();
    let mut out = vec![format!(
        "Server {}: {} channels. The bot has: {}.",
        guild_label(&guild),
        chans.len(),
        can.join(", ")
    )];
    if !top.is_empty() {
        out.push("Not in a category:".to_string());
        out.extend(top.iter().map(|c| line(c, "  ")));
    }
    for cat in cats {
        out.push(line(cat, ""));
        let mut kids: Vec<&Channel> = chans
            .iter()
            .filter(|c| c.parent_id.as_deref() == Some(cat.id.as_str()))
            .collect();
        kids.sort_by(by_pos);
        if kids.is_empty() {
            out.push("  (empty)".to_string());
        } else {
            out.extend(kids.iter().map(|c| line(c, "  ")));
        }
    }
    Ok(out.join("\n"))
}

// ---------------------------------------------------------------- create_channel

static WHITESPACE_TO_DASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{JS_WHITESPACE}+")).expect("the whitespace pattern"));

fn clean_name(raw: Option<&Value>, kind: u8) -> Step<String> {
    let trimmed = js_trim(&js_string_or_empty(raw)).to_string();
    let mut name = trimmed.strip_prefix('#').unwrap_or(&trimmed).to_string();
    if kind == GUILD_TEXT {
        name = WHITESPACE_TO_DASH.replace_all(&name.to_lowercase(), "-").into_owned();
    }
    if name.is_empty() {
        return fail("name is required: the new channel's name, e.g. alerts.");
    }
    if utf16_len(&name) > 100 {
        return fail("name is too long: Discord allows 100 characters.");
    }
    Ok(name)
}

/// One overwrite as this file builds it: the single permissions, in order, so the result can name them.
#[derive(Debug, Clone)]
struct OverwriteSpec {
    id: String,
    kind: OverwriteKind,
    allow: Vec<u64>,
    deny: Vec<u64>,
}

impl OverwriteSpec {
    fn bits(&self) -> Overwrite {
        Overwrite {
            id: self.id.clone(),
            kind: self.kind,
            allow: self.allow.iter().fold(0, |all, b| all | b),
            deny: self.deny.iter().fold(0, |all, b| all | b),
        }
    }
}

/// What the bot (and the people let in) may do in a private channel of this type: only what the bot has itself
/// (Discord refuses to hand out more).
fn grant_for(guild: &Guild, kind: u8) -> Vec<u64> {
    access_for(kind)
        .iter()
        .copied()
        .filter(|b| missing_perms(guild, None, &[*b]).is_empty())
        .collect()
}

/// Overwrites for a private channel: hidden from @everyone; the bot, the users and the roles listed may see it and
/// use it. Also gives the "who can see it" words.
async fn private_overwrites(
    ctx: &Ctx<'_>,
    guild: &Guild,
    kind: u8,
    user_ids: &[Value],
    role_ids: &[Value],
) -> Step<(Vec<OverwriteSpec>, String)> {
    let grant = grant_for(guild, kind);
    let mut overwrites = vec![
        OverwriteSpec {
            id: everyone_id(guild).to_string(),
            kind: OverwriteKind::Role,
            allow: Vec::new(),
            deny: vec![VIEW_CHANNEL],
        },
        OverwriteSpec {
            id: ctx.bot_id.clone(),
            kind: OverwriteKind::Member,
            allow: grant.clone(),
            deny: Vec::new(),
        },
    ];
    let mut users = Vec::new();
    let mut roles = Vec::new();
    for raw in user_ids {
        let id = js_trim(&strip_mention(&js_string(raw), &["<@!", "<@"])).to_string();
        if !SNOWFLAKE.is_match(&id) {
            return fail(format!(
                "allow_user_ids: \"{}\" is not a Discord user id.",
                js_string(raw)
            ));
        }
        if id == ctx.bot_id {
            continue;
        }
        let Some(member) = ctx.client.fetch_member(&guild.id, &id).await else {
            return fail(format!(
                "allow_user_ids: user {id} is not a member of the server {}. Nothing was made.",
                guild_label(guild)
            ));
        };
        overwrites.push(OverwriteSpec {
            id: id.clone(),
            kind: OverwriteKind::Member,
            allow: grant.clone(),
            deny: Vec::new(),
        });
        users.push(member_label(&member, &id));
    }
    for raw in role_ids {
        let id = js_trim(&strip_mention(&js_string(raw), &["<@&"])).to_string();
        if !SNOWFLAKE.is_match(&id) {
            return fail(format!(
                "allow_role_ids: \"{}\" is not a Discord role id.",
                js_string(raw)
            ));
        }
        let Some(found) = role(guild, &id) else {
            return fail(format!(
                "allow_role_ids: there is no role with id {id} in the server {}. Nothing was made.",
                guild_label(guild)
            ));
        };
        if id == everyone_id(guild) {
            return fail(
                "allow_role_ids: that is @everyone, which would make the channel public. Leave private off instead.",
            );
        }
        roles.push(format!("@{}", found.name));
        overwrites.push(OverwriteSpec {
            id,
            kind: OverwriteKind::Role,
            allow: grant.clone(),
            deny: Vec::new(),
        });
    }
    let who = std::iter::once("the bot".to_string())
        .chain(users)
        .chain(roles)
        .collect::<Vec<_>>()
        .join(", ");
    Ok((
        overwrites,
        format!("private: only {who}, and anyone with Administrator, can see it"),
    ))
}

/// `m.displayName || m.user?.username || id`.
fn member_label(member: &Member, id: &str) -> String {
    [&member.display_name, &member.username]
        .into_iter()
        .flatten()
        .find(|n| !n.is_empty())
        .cloned()
        .unwrap_or_else(|| id.to_string())
}

/// The bot keeps access when the overwrites would hide the channel from @everyone.
fn keep_bot_access(ctx: &Ctx<'_>, guild: &Guild, mut overwrites: Vec<Overwrite>, kind: u8) -> Vec<Overwrite> {
    let everyone_denies = overwrites
        .iter()
        .any(|o| o.id == everyone_id(guild) && o.deny & VIEW_CHANNEL != 0);
    if !everyone_denies || overwrites.iter().any(|o| o.id == ctx.bot_id) {
        return overwrites;
    }
    overwrites.push(Overwrite {
        id: ctx.bot_id.clone(),
        kind: OverwriteKind::Member,
        allow: grant_for(guild, kind).iter().fold(0, |all, b| all | b),
        deny: 0,
    });
    overwrites
}

/// Each single permission in an overwrite list's allow and deny.
fn handed_out(overwrites: &[Overwrite]) -> Vec<u64> {
    let all = overwrites.iter().fold(0, |acc, o| acc | o.allow | o.deny);
    FLAG_NAME.iter().map(|(bit, _)| *bit).filter(|b| all & b != 0).collect()
}

async fn create_channel(ctx: &Ctx<'_>, note: &mut Note) -> Step<String> {
    let args = ctx.args;
    let guild = resolve_guild_step(ctx.client, args).await?;
    note.guild = Some(guild.clone());
    let type_key = if is_set(args, "type") {
        js_template(arg(args, "type")).to_lowercase()
    } else {
        "text".to_string()
    };
    let Some(kind) = type_of(&type_key) else {
        return fail(format!(
            "type \"{}\" is not one this tool makes: text, voice or category.",
            js_template(arg(args, "type"))
        ));
    };
    let name = clean_name(arg(args, "name"), kind)?;

    let mut parent: Option<Channel> = None;
    if is_set(args, "parent_id") && arg(args, "parent_id") != Some(&Value::String("none".into())) {
        if kind == GUILD_CATEGORY {
            return fail("A category cannot go inside another category: leave parent_id out.");
        }
        let found = fetch_channel(ctx.client, arg(args, "parent_id"), "parent_id").await?;
        same_guild(&guild, &found, "parent_id")?;
        if found.kind != GUILD_CATEGORY {
            return fail(format!("parent_id {} is #{}, not a category.", found.id, found.name));
        }
        parent = Some(found);
    }
    let mut near: Option<Channel> = None;
    if is_set(args, "near_channel_id") {
        let found = fetch_channel(ctx.client, arg(args, "near_channel_id"), "near_channel_id").await?;
        same_guild(&guild, &found, "near_channel_id")?;
        if parent.is_none() && kind != GUILD_CATEGORY {
            if found.kind == GUILD_CATEGORY {
                parent = Some(found);
            } else {
                parent = parent_of(ctx.client, &found);
                near = Some(found);
            }
        } else {
            near = Some(found);
        }
    }
    if is_set(args, "topic") && kind != GUILD_TEXT {
        return fail("topic is only for text channels.");
    }

    let user_ids = list_of(args, "allow_user_ids");
    let role_ids = list_of(args, "allow_role_ids");
    if is_set(args, "copy_permissions_from") && is_set(args, "private") {
        return fail(
            "Pick one: copy_permissions_from (the same access as another channel) or private (only the people you list). Nothing was made.",
        );
    }
    if (!user_ids.is_empty() || !role_ids.is_empty()) && !is_set(args, "private") {
        return fail("allow_user_ids and allow_role_ids go with private: true. Nothing was made.");
    }

    require_perms(&guild, parent.as_ref(), &[MANAGE_CHANNELS], "make channels")?;

    let (overwrites, privacy): (Option<Vec<Overwrite>>, String) = if is_set(args, "copy_permissions_from") {
        let src = fetch_channel(ctx.client, arg(args, "copy_permissions_from"), "copy_permissions_from").await?;
        same_guild(&guild, &src, "copy_permissions_from")?;
        let copied = keep_bot_access(ctx, &guild, src.overwrites.clone(), kind);
        let which = if is_private(&src) { ", which is private" } else { "" };
        (
            Some(copied),
            format!("the same access as #{} (copied){which}", src.name),
        )
    } else if is_set(args, "private") {
        let (specs, privacy) = private_overwrites(ctx, &guild, kind, user_ids, role_ids).await?;
        (Some(specs.iter().map(OverwriteSpec::bits).collect()), privacy)
    } else if let Some(parent) = &parent {
        let which = if is_private(parent) { ", which is private" } else { "" };
        (
            Some(parent.overwrites.clone()),
            format!("the same access as its category {} (synced){which}", parent.name),
        )
    } else {
        (
            None,
            "public: everyone in the server can see it, as the server's roles allow".to_string(),
        )
    };

    note.hands_out = handed_out(overwrites.as_deref().unwrap_or(&[]));
    let topic = if is_set(args, "topic") {
        Some(utf16_truncate(&js_template(arg(args, "topic")), 1024))
    } else {
        None
    };
    let created = ctx
        .client
        .create_channel(
            &guild.id,
            NewChannel {
                name,
                kind,
                parent_id: parent.as_ref().map(|p| p.id.clone()),
                topic,
                permission_overwrites: overwrites,
                reason: reason_of(args),
            },
        )
        .await?;
    note.channel = Some(created.clone());

    let mut extras = Vec::new();
    if let Some(near) = &near {
        let place = if is_set(args, "place") {
            js_template(arg(args, "place"))
        } else {
            "after".to_string()
        };
        let after = place.to_lowercase() != "before";
        let position = (near.position.unwrap_or(0) + if after { 1 } else { 0 }).max(0);
        match ctx
            .client
            .set_channel_position(&created.id, position, &reason_of(args))
            .await
        {
            Ok(()) => extras.push(format!(
                "placed {} #{}",
                if after { "after" } else { "before" },
                near.name
            )),
            Err(err) => extras.push(format!(
                "made, but it could not be moved next to #{} ({})",
                near.name,
                discord_error_text(&err, "edit_channel", note)
            )),
        }
    }
    let label = if kind == GUILD_CATEGORY {
        format!("the category {}", created.name)
    } else {
        format!(
            "{}{} ({type_key} channel)",
            if kind == GUILD_TEXT { "#" } else { "" },
            created.name
        )
    };
    let mut out = vec![
        format!("Made {label} in the server {}.", guild_label(&guild)),
        format!("id: {}", created.id),
    ];
    if let Some(parent) = &parent {
        out.push(format!("category: {} (id {})", parent.name, parent.id));
    }
    out.push(format!("who can see it: {privacy}"));
    out.extend(extras);
    out.push(format!("link: {}", jump_link(&guild, &created)));
    if kind != GUILD_CATEGORY {
        out.push(format!("mention it in chat as <#{}>", created.id));
    }
    Ok(out.join("\n"))
}

// ---------------------------------------------------------------- edit_channel

struct Target {
    id: String,
    kind: OverwriteKind,
    label: String,
}

struct PermChange {
    target: Target,
    allow: Vec<u64>,
    deny: Vec<u64>,
    reset: Vec<u64>,
    clear: bool,
}

static EVERYONE_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^@?(?i-u:everyone)$").expect("the everyone pattern"));

async fn target_of(ctx: &Ctx<'_>, guild: &Guild, raw: Option<&Value>, raw_type: Option<&Value>) -> Step<Target> {
    let t = js_trim(&js_string_or_empty(raw)).to_string();
    if EVERYONE_WORD.is_match(&t) {
        return Ok(Target {
            id: everyone_id(guild).to_string(),
            kind: OverwriteKind::Role,
            label: "@everyone".to_string(),
        });
    }
    let id = strip_mention(&t, &["<@!", "<@&", "<@"]);
    if !SNOWFLAKE.is_match(&id) {
        return fail(format!(
            "permissions target \"{}\" is not a user id, a role id or \"everyone\".",
            js_template(raw)
        ));
    }
    let kind = if raw_type.is_some_and(truthy) {
        js_template(raw_type).to_lowercase()
    } else {
        String::new()
    };
    if kind != "user"
        && let Some(found) = role(guild, &id)
    {
        let label = if id == everyone_id(guild) {
            "@everyone".to_string()
        } else {
            format!("@{}", found.name)
        };
        return Ok(Target {
            id,
            kind: OverwriteKind::Role,
            label,
        });
    }
    if kind == "role" {
        return fail(format!(
            "There is no role with id {id} in the server {}.",
            guild_label(guild)
        ));
    }
    let Some(member) = ctx.client.fetch_member(&guild.id, &id).await else {
        return fail(format!(
            "No role or member with id {id} in the server {}.",
            guild_label(guild)
        ));
    };
    let label = member_label(&member, &id);
    Ok(Target {
        id,
        kind: OverwriteKind::Member,
        label,
    })
}

fn flags_from(list: Option<&Value>, field: &str) -> Step<Vec<u64>> {
    let items: &[Value] = match list {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let mut out = Vec::new();
    for raw in items {
        let Some(bit) = perm_flag(&js_string_or_empty(Some(raw))) else {
            return fail(format!(
                "{field}: \"{}\" is not a Discord permission. Use names like ViewChannel, SendMessages, ReadMessageHistory, ManageMessages, Connect, Speak (or view, send, history).",
                js_string(raw)
            ));
        };
        if bit == ADMINISTRATOR {
            return fail(format!(
                "{field}: Administrator is a server-wide role permission, not one a channel can set."
            ));
        }
        out.push(bit);
    }
    Ok(out)
}

async fn edit_channel(ctx: &Ctx<'_>, note: &mut Note) -> Step<String> {
    let args = ctx.args;
    if !is_set(args, "channel_id") {
        return fail("channel_id is required: the channel to edit.");
    }
    let ch = fetch_channel(ctx.client, arg(args, "channel_id"), "channel_id").await?;
    let Some(guild) = guild_of(ctx.client, &ch).await else {
        return fail(format!("channel {} is a direct message, not a server channel.", ch.id));
    };
    if is_thread(ch.kind) {
        let parent = parent_of(ctx.client, &ch)
            .map(|p| p.name)
            .filter(|n| !n.is_empty())
            .or_else(|| ch.parent_id.clone())
            .unwrap_or_else(|| "undefined".to_string());
        return fail(format!(
            "{} is a thread. This edits channels and categories; edit its parent #{parent} instead.",
            ch.id
        ));
    }
    note.guild = Some(guild.clone());
    note.channel = Some(ch.clone());
    if is_set(args, "guild_id") && js_template(arg(args, "guild_id")) != guild.id {
        return fail(format!(
            "channel {} is not in the server {}.",
            ch.id,
            js_template(arg(args, "guild_id"))
        ));
    }

    let mut changes: Vec<String> = Vec::new();
    let mut edit = ChannelEdit {
        reason: reason_of(args),
        ..Default::default()
    };
    if let Some(raw) = arg(args, "name").filter(|v| !v.is_null() && v.as_str() != Some("")) {
        let name = clean_name(Some(raw), ch.kind)?;
        changes.push(format!("renamed to {name}"));
        edit.name = Some(name);
    }
    if let Some(raw) = arg(args, "topic").filter(|v| !v.is_null()) {
        if ch.kind != GUILD_TEXT && ch.kind != GUILD_ANNOUNCEMENT {
            return fail("topic is only for text channels.");
        }
        let topic = utf16_truncate(&js_string(raw), 1024);
        changes.push(if topic.is_empty() { "topic cleared" } else { "topic set" }.to_string());
        edit.topic = Some(topic);
    }
    if is_set(args, "parent_id") {
        if ch.kind == GUILD_CATEGORY {
            return fail("A category cannot go inside another category.");
        }
        if arg(args, "parent_id") == Some(&Value::String("none".into())) {
            edit.parent = Some(None);
            changes.push("taken out of its category".to_string());
        } else {
            let parent = fetch_channel(ctx.client, arg(args, "parent_id"), "parent_id").await?;
            same_guild(&guild, &parent, "parent_id")?;
            if parent.kind != GUILD_CATEGORY {
                return fail(format!("parent_id {} is #{}, not a category.", parent.id, parent.name));
            }
            changes.push(format!("moved to the category {}", parent.name));
            edit.parent = Some(Some(parent.id));
        }
    }
    if is_set(args, "sync_with_category") {
        let has_parent = ch.parent_id.as_deref().is_some_and(|p| !p.is_empty());
        let moving_in = matches!(&edit.parent, Some(Some(id)) if !id.is_empty());
        if !has_parent && !moving_in {
            return fail("sync_with_category needs the channel to be in a category.");
        }
        edit.lock_permissions = true;
        changes.push("access synced with its category".to_string());
    }

    // Permission overwrites: each entry sets (allow / deny), resets to the default (reset) or removes (clear) one.
    let mut perms: Vec<PermChange> = Vec::new();
    for p in list_of(args, "permissions") {
        let target = target_of(ctx, &guild, p.get("target"), p.get("target_type")).await?;
        let allow = flags_from(p.get("allow"), "allow")?;
        let deny = flags_from(p.get("deny"), "deny")?;
        let reset = flags_from(p.get("reset"), "reset")?;
        let clear = p.get("clear").is_some_and(truthy);
        if !clear && allow.is_empty() && deny.is_empty() && reset.is_empty() {
            return fail(format!(
                "permissions for {}: give allow, deny, reset or clear: true.",
                target.label
            ));
        }
        perms.push(PermChange {
            target,
            allow,
            deny,
            reset,
            clear,
        });
    }
    if arg(args, "private").is_some_and(|v| !v.is_null()) {
        let user_ids = list_of(args, "allow_user_ids");
        let role_ids = list_of(args, "allow_role_ids");
        if is_set(args, "private") {
            let (overwrites, _) = private_overwrites(ctx, &guild, ch.kind, user_ids, role_ids).await?;
            for o in overwrites {
                let label = if o.id == everyone_id(&guild) {
                    "@everyone".to_string()
                } else if o.id == ctx.bot_id {
                    "the bot".to_string()
                } else if let Some(found) = role(&guild, &o.id) {
                    format!("@{}", found.name)
                } else {
                    ctx.client
                        .fetch_member(&guild.id, &o.id)
                        .await
                        .and_then(|m| m.display_name)
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| o.id.clone())
                };
                perms.push(PermChange {
                    target: Target {
                        id: o.id,
                        kind: o.kind,
                        label,
                    },
                    allow: o.allow,
                    deny: o.deny,
                    reset: Vec::new(),
                    clear: false,
                });
            }
        } else {
            if !user_ids.is_empty() || !role_ids.is_empty() {
                return fail("allow_user_ids and allow_role_ids go with private: true.");
            }
            perms.push(PermChange {
                target: Target {
                    id: everyone_id(&guild).to_string(),
                    kind: OverwriteKind::Role,
                    label: "@everyone".to_string(),
                },
                allow: Vec::new(),
                deny: Vec::new(),
                reset: vec![VIEW_CHANNEL],
                clear: false,
            });
        }
    } else if matches!(arg(args, "allow_user_ids"), Some(Value::Array(_)))
        || matches!(arg(args, "allow_role_ids"), Some(Value::Array(_)))
    {
        return fail("allow_user_ids and allow_role_ids go with private: true (or use permissions).");
    }
    // Hiding the channel from @everyone keeps the bot in.
    if perms
        .iter()
        .any(|p| p.target.id == everyone_id(&guild) && p.deny.contains(&VIEW_CHANNEL))
        && !perms.iter().any(|p| p.target.id == ctx.bot_id)
    {
        perms.push(PermChange {
            target: Target {
                id: ctx.bot_id.clone(),
                kind: OverwriteKind::Member,
                label: "the bot".to_string(),
            },
            allow: grant_for(&guild, ch.kind),
            deny: Vec::new(),
            reset: Vec::new(),
            clear: false,
        });
    }

    if changes.is_empty() && perms.is_empty() {
        return fail("Nothing to change: give name, topic, parent_id, sync_with_category, private or permissions.");
    }
    note.hands_out = handed_out(
        &perms
            .iter()
            .map(|p| Overwrite {
                id: p.target.id.clone(),
                kind: p.target.kind,
                allow: p.allow.iter().fold(0, |all, b| all | b),
                deny: p.deny.iter().fold(0, |all, b| all | b),
            })
            .collect::<Vec<_>>(),
    );
    if !changes.is_empty() {
        require_perms(&guild, Some(&ch), &[MANAGE_CHANNELS], "edit this channel")?;
    }
    if !perms.is_empty() {
        require_perms(
            &guild,
            Some(&ch),
            &[MANAGE_ROLES],
            "change who can see or do what in this channel",
        )?;
    }

    let mut done: Vec<String> = Vec::new();
    if !changes.is_empty() {
        let before = ch.name.clone();
        let new_name = edit.name.clone().unwrap_or_else(|| "undefined".to_string());
        if let Some(updated) = ctx.client.edit_channel(&ch.id, edit).await? {
            note.channel = Some(updated);
        }
        done.extend(changes.into_iter().map(|c| {
            if c.starts_with("renamed") {
                format!("renamed from {before} to {new_name}")
            } else {
                c
            }
        }));
    }
    for p in &perms {
        let reason = reason_of(args);
        if p.clear {
            ctx.client
                .delete_permission_overwrite(&ch.id, &p.target.id, &reason)
                .await?;
            done.push(format!("removed the permission overwrite for {}", p.target.label));
            continue;
        }
        // A JS object: a flag set twice keeps its first place and its last value.
        let mut set: Vec<(u64, Option<bool>)> = Vec::new();
        let mut put = |bit: u64, value: Option<bool>| match set.iter_mut().find(|(b, _)| *b == bit) {
            Some(entry) => entry.1 = value,
            None => set.push((bit, value)),
        };
        p.allow.iter().for_each(|b| put(*b, Some(true)));
        p.deny.iter().for_each(|b| put(*b, Some(false)));
        p.reset.iter().for_each(|b| put(*b, None));
        ctx.client
            .edit_permission_overwrite(&ch.id, &p.target.id, p.target.kind, &set, &reason)
            .await?;
        let mut parts = Vec::new();
        if !p.allow.is_empty() {
            parts.push(format!("allowed {}", labels(&p.allow, ", ")));
        }
        if !p.deny.is_empty() {
            parts.push(format!("denied {}", labels(&p.deny, ", ")));
        }
        if !p.reset.is_empty() {
            parts.push(format!("reset {} to the default", labels(&p.reset, ", ")));
        }
        done.push(format!("{}: {}", p.target.label, parts.join("; ")));
    }
    let now_name = note.channel.as_ref().map(|c| c.name.clone()).unwrap_or_default();
    let mut out = vec![format!(
        "Edited {}{now_name} (id {}) in the server {}:",
        if ch.kind == GUILD_CATEGORY {
            "the category "
        } else {
            "#"
        },
        ch.id,
        guild_label(&guild)
    )];
    out.extend(done.iter().map(|d| format!("- {d}")));
    out.push(format!("link: {}", jump_link(&guild, &ch)));
    Ok(out.join("\n"))
}

// ---------------------------------------------------------------- webhooks

async fn webhook_channel(ctx: &Ctx<'_>, note: &mut Note) -> Step<(Channel, Guild)> {
    if !is_set(ctx.args, "channel_id") {
        return fail("channel_id is required: the channel the webhook posts into.");
    }
    let ch = fetch_channel(ctx.client, arg(ctx.args, "channel_id"), "channel_id").await?;
    let Some(guild) = guild_of(ctx.client, &ch).await else {
        return fail(format!(
            "channel {} is a direct message: webhooks live in server channels.",
            ch.id
        ));
    };
    note.guild = Some(guild.clone());
    note.channel = Some(ch.clone());
    if is_thread(ch.kind) {
        let parent = parent_of(ctx.client, &ch)
            .map(|p| p.name)
            .filter(|n| !n.is_empty())
            .or_else(|| ch.parent_id.clone())
            .unwrap_or_else(|| "undefined".to_string());
        return fail(format!(
            "{} is a thread. Webhooks belong to its parent channel #{parent}: make it there (a script can post into the thread with ?thread_id={} on the webhook URL).",
            ch.id, ch.id
        ));
    }
    if !can_have_webhooks(ch.kind) {
        return fail(format!(
            "#{} is a {} channel, which cannot have webhooks.",
            ch.name,
            type_name(&ch)
        ));
    }
    Ok((ch, guild))
}

async fn list_webhooks(ctx: &Ctx<'_>, note: &mut Note) -> Step<String> {
    let (ch, guild) = webhook_channel(ctx, note).await?;
    require_perms(&guild, Some(&ch), &[MANAGE_WEBHOOKS], "see this channel's webhooks")?;
    let hooks = ctx.client.fetch_webhooks(&ch.id).await?;
    if hooks.is_empty() {
        return Ok(format!(
            "#{} (id {}) in the server {} has no webhooks.",
            ch.name,
            ch.id,
            guild_label(&guild)
        ));
    }
    let mut out = vec![format!(
        "Webhooks in #{} (id {}), server {}. URLs are secrets and are not listed:",
        ch.name,
        ch.id,
        guild_label(&guild)
    )];
    for h in &hooks {
        let kind = match h.kind {
            1 => "incoming",
            2 => "channel follower",
            3 => "application",
            _ => "webhook",
        };
        let by = match h.owner_username.as_deref() {
            Some(name) if !name.is_empty() => format!(", made by {name}"),
            _ => String::new(),
        };
        let name = h.name.clone().unwrap_or_else(|| "null".to_string());
        out.push(format!("- {name} (webhook id {}), {kind}{by}", h.id));
    }
    Ok(out.join("\n"))
}

async fn create_webhook(ctx: &Ctx<'_>, vault: &dyn WebhookVault, note: &mut Note) -> Step<String> {
    let args = ctx.args;
    let (ch, guild) = webhook_channel(ctx, note).await?;
    let name = js_trim(&js_string_or_empty(arg(args, "name"))).to_string();
    if name.is_empty() {
        return fail("name is required: the webhook's name, which its posts show, e.g. Uptime Watchdog.");
    }
    if utf16_len(&name) > 80 {
        return fail("name is too long: Discord allows 80 characters.");
    }
    // `/clyde|discord/i`: JavaScript folds case for ASCII letters only here.
    let folded = name.to_ascii_lowercase();
    if folded.contains("clyde") || folded.contains("discord") {
        return fail("Discord does not allow \"clyde\" or \"discord\" in a webhook name.");
    }

    let key_name = if is_set(args, "save_as_key") {
        key_name_from(&js_template(arg(args, "save_as_key")))
    } else {
        key_name_from(&format!("DISCORD_WEBHOOK_{}", ch.name))
    };
    if !KEY_NAME.is_match(&key_name) {
        return fail(format!(
            "save_as_key \"{}\" is not a usable key name (capitals, digits and underscores, e.g. UPTIME_WATCHDOG_WEBHOOK).",
            js_template(arg(args, "save_as_key"))
        ));
    }
    if vault.has_key(&key_name) && !is_set(args, "overwrite_key") {
        return fail(format!(
            "The vault already has a key named {key_name}. Pick another save_as_key, or pass overwrite_key: true if replacing it is what was asked. No webhook was made."
        ));
    }
    require_perms(&guild, Some(&ch), &[MANAGE_WEBHOOKS], "make webhooks here")?;

    let avatar = if is_set(args, "use_bot_avatar") {
        ctx.bot_avatar.clone()
    } else {
        None
    };
    let hook = ctx
        .client
        .create_webhook(
            &ch.id,
            NewWebhook {
                name: name.clone(),
                avatar,
                reason: reason_of(args),
            },
        )
        .await?;
    let token = match hook.token.as_deref() {
        Some(token) if !hook.id.is_empty() && !token.is_empty() => token.to_string(),
        _ => {
            let id = if hook.id.is_empty() {
                "unknown"
            } else {
                hook.id.as_str()
            };
            return fail(format!(
                "Discord made a webhook but sent back no token, so there is no URL to save (webhook id {id})."
            ));
        }
    };
    let url = format!("https://discord.com/api/webhooks/{}/{token}", hook.id);
    let masked = mask_webhook_url(&hook.id, &token);
    let purpose = if is_set(args, "purpose") {
        one_line(&js_template(arg(args, "purpose")))
    } else {
        String::new()
    };
    let purpose_text = if purpose.is_empty() {
        String::new()
    } else {
        format!(" Purpose: {purpose}.")
    };
    let description = format!(
        "Discord webhook URL \"{name}\" for #{} (channel {}) in the server {} ({}), webhook {}.{purpose_text} Secret: anyone with it can post there.",
        ch.name, ch.id, guild.name, guild.id, hook.id
    );
    if let Err(err) = vault.set_key(&key_name, &url, &description) {
        return fail(format!(
            "The webhook {} was made in #{}, but saving its URL to the vault failed ({err}). The URL was not shown. Try create_webhook again with another save_as_key, or the owner can copy it from Discord (channel settings > Integrations > Webhooks).",
            hook.id, ch.name
        ));
    }
    let picked = if is_set(args, "save_as_key") {
        ""
    } else {
        " (No save_as_key was given, so that name was picked.)"
    };
    let mut out = vec![
        format!(
            "Made the webhook \"{name}\" in #{} (id {}), server {}.",
            ch.name,
            ch.id,
            guild_label(&guild)
        ),
        format!("webhook id: {}", hook.id),
        format!("URL saved in the vault as {key_name} (masked: {masked}).{picked}"),
        "The URL is a secret: never paste it into a chat, a commit or a command line. Use it from the vault by key name."
            .to_string(),
    ];
    if is_set(args, "reveal") {
        out.push(format!(
            "Full URL (reveal was asked; it is a secret, do not post it in chat): {url}"
        ));
    }
    Ok(out.join("\n"))
}

#[cfg(test)]
mod tests;
