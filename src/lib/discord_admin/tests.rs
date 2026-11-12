// test/discord-admin.test.js: channels and webhooks done by Tarsee's own logged-in bot, so the agent never needs
// DISCORD_BOT_TOKEN in a command. Discord is never reached: the connection is a stand-in (with permissions either as
// the Node test's stand-in gave them, or worked out from roles and overwrites as the discord.js client did), and the
// vault is a stand-in or a temporary one.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::testkit::{TestApp, test_app, test_app_with_env};

const G: &str = "200000000000000001";
const G2: &str = "200000000000000002";
const BOT: &str = "300000000000000001";
const SAM: &str = "300000000000000002";
const ALEX: &str = "300000000000000003";
const OPS: &str = "400000000000000001";
const MODS: &str = "400000000000000002";
const CAT: &str = "500000000000000001";
const PROD: &str = "500000000000000002";
const GEN: &str = "500000000000000003";
const VOICE: &str = "500000000000000004";
const OTHER: &str = "500000000000000009";
const NEW: &str = "500000000000000099";
const HOOK: &str = "600000000000000001";
const THREAD: &str = "500000000000000050";
const DM_ID: &str = "500000000000000060";
const TARSEE_ROLE: &str = "400000000000000009";
const TOKEN: &str = "wh-token-SECRET-0123456789abcdefWXYZ";
const GO: &str = "Alex in #client-prod: make #client-alerts and a webhook for the watchdog";
const AVATAR: &str = "https://cdn.discordapp.com/avatars/bot.png";

/// An overwrite edit as the stand-in saw it: the target, its kind and the flags set.
type OverwriteSet = (String, OverwriteKind, Vec<(u64, Option<bool>)>);

/// What the tool asked Discord to do, in order.
#[derive(Debug, Clone, PartialEq)]
enum Call {
    Create(NewChannel),
    Edit(String, ChannelEdit),
    SetPosition(String, i64),
    OverwriteSet {
        channel: String,
        target: String,
        kind: OverwriteKind,
        set: Vec<(u64, Option<bool>)>,
    },
    OverwriteClear {
        channel: String,
        target: String,
    },
    WebhookCreate(String, NewWebhook),
}

#[derive(Default)]
struct Opts {
    /// The bot's permissions, single bits; `None`: Administrator.
    bot_perms: Option<Vec<u64>>,
    two_servers: bool,
    create_error: Option<DiscordError>,
    hook_error: Option<DiscordError>,
}

/// A Discord the tool can talk to: one server (or two), its channels, roles and members, with every call recorded.
struct World {
    guilds: Vec<Guild>,
    channels: Mutex<Vec<Channel>>,
    /// (server, member): who `guild.members.fetch` finds.
    members: Vec<(String, Member)>,
    hooks: Vec<(String, Webhook)>,
    calls: Mutex<Vec<Call>>,
    ready: AtomicBool,
    bot_perms: u64,
    create_error: Option<DiscordError>,
    hook_error: Option<DiscordError>,
}

fn channel(id: &str, name: &str, kind: u8, guild: Option<&str>, parent: Option<&str>, position: i64) -> Channel {
    Channel {
        id: id.into(),
        name: name.into(),
        kind,
        guild_id: guild.map(str::to_string),
        parent_id: parent.map(str::to_string),
        position: Some(position),
        overwrites: Vec::new(),
        bot_permissions: None,
        everyone_permissions: None,
    }
}

fn ow(id: &str, kind: OverwriteKind, allow: u64, deny: u64) -> Overwrite {
    Overwrite {
        id: id.into(),
        kind,
        allow,
        deny,
    }
}

fn member(id: &str, display: Option<&str>, username: Option<&str>) -> Member {
    Member {
        id: id.into(),
        display_name: display.map(str::to_string),
        username: username.map(str::to_string),
    }
}

fn world(opts: Opts) -> World {
    let bot_perms = match &opts.bot_perms {
        Some(bits) => bits.iter().fold(0, |all, b| all | b),
        None => ADMINISTRATOR,
    };
    let role = |id: &str, name: &str| Role {
        id: id.into(),
        name: name.into(),
    };
    let mut guilds = vec![Guild {
        id: G.into(),
        name: "Acme Server".into(),
        roles: vec![role(G, "@everyone"), role(OPS, "Ops"), role(MODS, "Mods")],
        bot_permissions: Some(bot_perms),
    }];
    // As the Node stand-in answered `permissionsFor`: @everyone sees a channel unless it is hidden, the bot has its
    // server permissions everywhere.
    let seen = |mut c: Channel, hidden: bool| {
        c.everyone_permissions = Some(if hidden { 0 } else { VIEW_CHANNEL });
        c.bot_permissions = Some(bot_perms);
        c
    };
    let mut cat = channel(CAT, "Clients", GUILD_CATEGORY, Some(G), None, 0);
    cat.overwrites = vec![
        ow(G, OverwriteKind::Role, 0, VIEW_CHANNEL),
        ow(OPS, OverwriteKind::Role, VIEW_CHANNEL, 0),
    ];
    let mut prod = channel(PROD, "client-prod", GUILD_TEXT, Some(G), Some(CAT), 0);
    prod.overwrites = vec![
        ow(G, OverwriteKind::Role, 0, VIEW_CHANNEL),
        ow(MODS, OverwriteKind::Role, VIEW_CHANNEL | SEND_MESSAGES, 0),
    ];
    let mut channels = vec![
        seen(cat, true),
        seen(prod, true),
        seen(channel(GEN, "general", GUILD_TEXT, Some(G), None, 0), false),
        seen(channel(VOICE, "Standup", GUILD_VOICE, Some(G), None, 1), false),
        seen(
            channel(THREAD, "deploy notes", PUBLIC_THREAD, Some(G), Some(PROD), 0),
            false,
        ),
        Channel {
            position: None,
            ..channel(DM_ID, "", DM, None, None, 0)
        },
    ];
    let mut members = vec![
        (G.to_string(), member(BOT, None, None)),
        (G.to_string(), member(SAM, Some("Sam"), Some("sam_k"))),
        (G.to_string(), member(ALEX, Some("Alex"), Some("alex"))),
    ];
    if opts.two_servers {
        guilds.push(Guild {
            id: G2.into(),
            name: "Side Project".into(),
            roles: vec![role(G2, "@everyone")],
            bot_permissions: Some(bot_perms),
        });
        channels.push(seen(channel(OTHER, "lobby", GUILD_TEXT, Some(G2), None, 0), false));
        members.push((G2.to_string(), member(BOT, None, None)));
    }
    World {
        guilds,
        channels: Mutex::new(channels),
        members,
        hooks: vec![(
            PROD.to_string(),
            Webhook {
                id: "600000000000000005".into(),
                name: Some("Old Hook".into()),
                kind: 1,
                owner_username: Some("alex".into()),
            },
        )],
        calls: Mutex::new(Vec::new()),
        ready: AtomicBool::new(true),
        bot_perms,
        create_error: opts.create_error,
        hook_error: opts.hook_error,
    }
}

impl World {
    fn calls(&self) -> Vec<Call> {
        self.calls.lock().clone()
    }

    fn record(&self, call: Call) {
        self.calls.lock().push(call);
    }

    fn rename(&self, id: &str, name: &str) {
        if let Some(c) = self.channels.lock().iter_mut().find(|c| c.id == id) {
            c.name = name.into();
        }
    }

    fn created(&self) -> NewChannel {
        self.calls()
            .into_iter()
            .find_map(|c| match c {
                Call::Create(request) => Some(request),
                _ => None,
            })
            .expect("a channel.create call")
    }

    fn overwrite_sets(&self) -> Vec<OverwriteSet> {
        self.calls()
            .into_iter()
            .filter_map(|c| match c {
                Call::OverwriteSet { target, kind, set, .. } => Some((target, kind, set)),
                _ => None,
            })
            .collect()
    }
}

#[async_trait]
impl DiscordClient for World {
    fn user(&self) -> Option<BotUser> {
        Some(BotUser {
            id: BOT.into(),
            avatar_url: Some(AVATAR.into()),
        })
    }

    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    fn guilds(&self) -> Vec<Guild> {
        self.guilds.clone()
    }

    async fn fetch_guild(&self, id: &str) -> Option<Guild> {
        // Not in the cache: the fetch fails ("Unknown Guild").
        self.guilds.iter().find(|g| g.id == id).cloned()
    }

    async fn fetch_channel(&self, id: &str) -> Option<Channel> {
        self.channels.lock().iter().find(|c| c.id == id).cloned()
    }

    fn guild_channels(&self, guild_id: &str) -> Vec<Channel> {
        self.channels
            .lock()
            .iter()
            .filter(|c| c.guild_id.as_deref() == Some(guild_id))
            .cloned()
            .collect()
    }

    async fn fetch_member(&self, guild_id: &str, user_id: &str) -> Option<Member> {
        self.members
            .iter()
            .find(|(g, m)| g == guild_id && m.id == user_id)
            .map(|(_, m)| m.clone())
    }

    async fn create_channel(&self, guild_id: &str, request: NewChannel) -> Result<Channel, DiscordError> {
        self.record(Call::Create(request.clone()));
        if let Some(err) = &self.create_error {
            return Err(err.clone());
        }
        let mut made = channel(
            NEW,
            &request.name,
            request.kind,
            Some(guild_id),
            request.parent_id.as_deref(),
            9,
        );
        made.everyone_permissions = Some(VIEW_CHANNEL);
        made.bot_permissions = Some(self.bot_perms);
        self.channels.lock().push(made.clone());
        Ok(made)
    }

    async fn edit_channel(&self, channel_id: &str, request: ChannelEdit) -> Result<Option<Channel>, DiscordError> {
        self.record(Call::Edit(channel_id.into(), request.clone()));
        if let Some(name) = &request.name {
            self.rename(channel_id, name);
        }
        Ok(self.channels.lock().iter().find(|c| c.id == channel_id).cloned())
    }

    async fn set_channel_position(&self, channel_id: &str, position: i64, _reason: &str) -> Result<(), DiscordError> {
        self.record(Call::SetPosition(channel_id.into(), position));
        Ok(())
    }

    async fn edit_permission_overwrite(
        &self,
        channel_id: &str,
        target_id: &str,
        kind: OverwriteKind,
        set: &[(u64, Option<bool>)],
        _reason: &str,
    ) -> Result<(), DiscordError> {
        self.record(Call::OverwriteSet {
            channel: channel_id.into(),
            target: target_id.into(),
            kind,
            set: set.to_vec(),
        });
        Ok(())
    }

    async fn delete_permission_overwrite(
        &self,
        channel_id: &str,
        target_id: &str,
        _reason: &str,
    ) -> Result<(), DiscordError> {
        self.record(Call::OverwriteClear {
            channel: channel_id.into(),
            target: target_id.into(),
        });
        Ok(())
    }

    async fn fetch_webhooks(&self, channel_id: &str) -> Result<Vec<Webhook>, DiscordError> {
        Ok(self
            .hooks
            .iter()
            .filter(|(c, _)| c == channel_id)
            .map(|(_, h)| h.clone())
            .collect())
    }

    async fn create_webhook(&self, channel_id: &str, request: NewWebhook) -> Result<CreatedWebhook, DiscordError> {
        self.record(Call::WebhookCreate(channel_id.into(), request));
        if let Some(err) = &self.hook_error {
            return Err(err.clone());
        }
        Ok(CreatedWebhook {
            id: HOOK.into(),
            token: Some(TOKEN.into()),
        })
    }
}

/// A vault stand-in: the keys it holds, with their values and descriptions.
#[derive(Default)]
struct FakeVault {
    keys: Mutex<BTreeMap<String, (String, String)>>,
}

impl FakeVault {
    fn with(existing: &[&str]) -> Self {
        let vault = FakeVault::default();
        for k in existing {
            vault
                .keys
                .lock()
                .insert(k.to_string(), ("old-value".into(), "old".into()));
        }
        vault
    }

    fn get(&self, key: &str) -> Option<(String, String)> {
        self.keys.lock().get(key).cloned()
    }
}

impl WebhookVault for FakeVault {
    fn has_key(&self, name: &str) -> bool {
        self.keys.lock().contains_key(name)
    }

    fn set_key(&self, name: &str, value: &str, description: &str) -> anyhow::Result<()> {
        self.keys.lock().insert(name.into(), (value.into(), description.into()));
        Ok(())
    }
}

struct Ran {
    out: String,
    lines: Vec<String>,
}

/// Runs the tool with the log lines kept, so a test can check they carry no secret.
async fn run_with(t: &TestApp, w: &World, args: Value, vault: &dyn WebhookVault) -> Ran {
    let lines = Mutex::new(Vec::new());
    let log = |line: &str| lines.lock().push(line.to_string());
    let out = discord_admin(
        &t.app,
        &args,
        DiscordAdminDeps {
            client: w,
            vault: Some(vault),
            log: Some(&log),
        },
    )
    .await;
    Ran {
        out,
        lines: lines.into_inner(),
    }
}

async fn run(t: &TestApp, w: &World, args: Value) -> Ran {
    run_with(t, w, args, &FakeVault::default()).await
}

fn overwrite_for<'o>(list: &'o [Overwrite], id: &str) -> &'o Overwrite {
    list.iter()
        .find(|o| o.id == id)
        .unwrap_or_else(|| panic!("an overwrite for {id}"))
}

#[track_caller]
fn assert_match(text: &str, pattern: &str) {
    let re = Regex::new(pattern).expect("a test pattern");
    assert!(re.is_match(text), "/{pattern}/ does not match:\n{text}");
}

// ---------------------------------------------------------------- which server

#[tokio::test]
async fn with_one_server_and_no_ids_it_is_that_server() {
    let t = test_app();
    let w = world(Opts::default());
    assert_eq!(resolve_guild(&w, &json!({})).await.unwrap().id, G);
    let ran = run(&t, &w, json!({"action": "list_channels"})).await;
    assert_match(&ran.out, r#"^Server "Acme Server" \(server id 200000000000000001\)"#);
}

#[tokio::test]
async fn a_channel_id_even_a_thread_picks_its_server_when_the_bot_is_in_two() {
    let w = world(Opts {
        two_servers: true,
        ..Default::default()
    });
    assert_eq!(resolve_guild(&w, &json!({"channel_id": PROD})).await.unwrap().id, G);
    assert_eq!(resolve_guild(&w, &json!({"channel_id": THREAD})).await.unwrap().id, G);
    assert_eq!(
        resolve_guild(&w, &json!({"channel_id": format!("<#{OTHER}>")}))
            .await
            .unwrap()
            .id,
        G2
    );
    assert_eq!(
        resolve_guild(&w, &json!({"guild_id": G2, "channel_id": PROD}))
            .await
            .unwrap()
            .id,
        G2,
        "guild_id wins"
    );
    assert_eq!(
        resolve_guild(&w, &json!({"parent_id": CAT})).await.unwrap().id,
        G,
        "a category id given for the new channel works too"
    );
}

#[tokio::test]
async fn two_servers_and_nothing_to_tell_them_apart_it_asks_naming_both_and_does_nothing() {
    let t = test_app();
    let w = world(Opts {
        two_servers: true,
        ..Default::default()
    });
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "x", "approved_by": GO}),
    )
    .await;
    assert_match(
        &ran.out,
        r"error: The bot is in 2 servers, so say which: pass guild_id, or channel_id",
    );
    assert_match(
        &ran.out,
        r"Acme Server \(200000000000000001\), Side Project \(200000000000000002\)",
    );
    assert!(w.calls().is_empty());
}

#[tokio::test]
async fn an_unknown_server_an_unknown_channel_a_dm_and_a_bad_id_each_say_so_plainly() {
    let t = test_app();
    let w = world(Opts::default());
    let out = |args: Value| {
        let (t, w) = (&t, &w);
        async move { run(t, w, args).await.out }
    };
    assert_match(
        &out(json!({"action": "list_channels", "guild_id": "999999999999999999"})).await,
        r"not in a server with id 999999999999999999\. Servers the bot is in: Acme Server",
    );
    assert_match(
        &out(json!({"action": "list_channels", "channel_id": "999999999999999998"})).await,
        r"No channel with id 999999999999999998",
    );
    assert_match(
        &out(json!({"action": "list_channels", "channel_id": DM_ID})).await,
        r"is a direct message, not a channel in a server",
    );
    assert_match(
        &out(json!({"action": "list_channels", "channel_id": "general"})).await,
        r"is not a Discord channel id",
    );
}

// ---------------------------------------------------------------- list_channels

#[tokio::test]
async fn every_channel_with_its_id_type_category_position_and_whether_it_is_private_threads_left_out() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(&t, &w, json!({"action": "list_channels", "channel_id": PROD})).await;
    let lines: Vec<&str> = ran.out.split('\n').collect();
    assert_match(
        lines[0],
        r"4 channels\. The bot has: Manage Channels yes, Manage Permissions \(Manage Roles\) yes, Manage Webhooks yes\.",
    );
    assert!(lines.contains(&"Not in a category:"));
    for want in [
        format!("  #general (id {GEN}): text, position 0, public"),
        format!("  Standup (id {VOICE}): voice, position 1, public"),
        format!("Category Clients (id {CAT}): category, position 0, private"),
        format!("  #client-prod (id {PROD}): text, position 0, private"),
    ] {
        assert!(lines.contains(&want.as_str()), "{want}\n{}", ran.out);
    }
    assert!(!ran.out.contains(THREAD), "threads are not channels to manage here");
    assert!(w.calls().is_empty());
    // The whole answer, in its order.
    assert_eq!(
        ran.out,
        [
            "Server \"Acme Server\" (server id 200000000000000001): 4 channels. The bot has: Manage Channels yes, Manage Permissions (Manage Roles) yes, Manage Webhooks yes.",
            "Not in a category:",
            "  #general (id 500000000000000003): text, position 0, public",
            "  Standup (id 500000000000000004): voice, position 1, public",
            "Category Clients (id 500000000000000001): category, position 0, private",
            "  #client-prod (id 500000000000000002): text, position 0, private",
        ]
        .join("\n")
    );
}

#[tokio::test]
async fn list_channels_needs_no_go() {
    let t = test_app();
    let ran = run(&t, &world(Opts::default()), json!({"action": "list_channels"})).await;
    assert!(!ran.out.contains("error"), "{}", ran.out);
}

// ---------------------------------------------------------------- create_channel

#[tokio::test]
async fn private_hidden_from_everyone_and_the_bot_the_listed_users_and_roles_let_in() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "channel_id": PROD, "name": "Client Alerts", "parent_id": CAT, "private": true,
               "allow_user_ids": [SAM, format!("<@{ALEX}>")], "allow_role_ids": [OPS], "topic": "Watchdog alerts", "approved_by": GO}),
    )
    .await;
    let o = w.created();
    assert_eq!(o.name, "client-alerts");
    assert_eq!(o.kind, GUILD_TEXT);
    assert_eq!(o.parent_id.as_deref(), Some(CAT));
    assert_eq!(o.topic.as_deref(), Some("Watchdog alerts"));
    assert_match(&o.reason, r"Go from: Alex in #client-prod");
    let list = o.permission_overwrites.expect("overwrites");
    assert_eq!(*overwrite_for(&list, G), ow(G, OverwriteKind::Role, 0, VIEW_CHANNEL));
    for (id, kind) in [
        (BOT, OverwriteKind::Member),
        (SAM, OverwriteKind::Member),
        (ALEX, OverwriteKind::Member),
        (OPS, OverwriteKind::Role),
    ] {
        let x = overwrite_for(&list, id);
        assert_eq!(x.kind, kind, "{id}");
        for bit in [VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY] {
            assert!(x.allow & bit == bit, "{id} may {bit}");
        }
        assert!(x.allow & CONNECT == 0, "no voice permissions on a text channel");
    }
    assert_eq!(list.len(), 5);
    assert_match(
        &ran.out,
        r#"^Made #client-alerts \(text channel\) in the server "Acme Server""#,
    );
    assert!(ran.out.contains(&format!("id: {NEW}")));
    assert!(
        ran.out.contains(
            "who can see it: private: only the bot, Sam, Alex, @Ops, and anyone with Administrator, can see it"
        )
    );
    assert!(
        ran.out
            .contains(&format!("link: https://discord.com/channels/{G}/{NEW}"))
    );
    assert!(ran.out.contains(&format!("<#{NEW}>")));
    assert_eq!(
        ran.out,
        [
            "Made #client-alerts (text channel) in the server \"Acme Server\" (server id 200000000000000001)."
                .to_string(),
            format!("id: {NEW}"),
            format!("category: Clients (id {CAT})"),
            "who can see it: private: only the bot, Sam, Alex, @Ops, and anyone with Administrator, can see it"
                .to_string(),
            format!("link: https://discord.com/channels/{G}/{NEW}"),
            format!("mention it in chat as <#{NEW}>"),
        ]
        .join("\n")
    );
}

#[tokio::test]
async fn a_voice_channel_gets_voice_access_and_only_what_the_bot_holds_itself_is_handed_out() {
    let t = test_app();
    let w = world(Opts {
        bot_perms: Some(vec![MANAGE_CHANNELS, VIEW_CHANNEL, CONNECT, SEND_MESSAGES]),
        ..Default::default()
    });
    run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "War Room", "type": "voice", "private": true, "allow_user_ids": [SAM], "approved_by": GO}),
    )
    .await;
    let o = w.created();
    assert_eq!(o.kind, GUILD_VOICE);
    let list = o.permission_overwrites.unwrap();
    assert_eq!(overwrite_for(&list, SAM).allow, VIEW_CHANNEL | CONNECT | SEND_MESSAGES);
    assert_eq!(overwrite_for(&list, BOT).allow, VIEW_CHANNEL | CONNECT | SEND_MESSAGES);
}

#[tokio::test]
async fn a_user_who_is_not_in_the_server_or_a_role_that_does_not_exist_stops_it_before_anything_is_made() {
    let t = test_app();
    let w = world(Opts::default());
    let base = |extra: Value| {
        let mut args = json!({"action": "create_channel", "name": "x", "approved_by": GO});
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        args
    };
    assert_match(
        &run(
            &t,
            &w,
            base(json!({"private": true, "allow_user_ids": ["399999999999999999"]})),
        )
        .await
        .out,
        r#"user 399999999999999999 is not a member of the server "Acme Server".*Nothing was made"#,
    );
    assert_match(
        &run(
            &t,
            &w,
            base(json!({"private": true, "allow_role_ids": ["499999999999999999"]})),
        )
        .await
        .out,
        r"no role with id 499999999999999999",
    );
    assert_match(
        &run(&t, &w, base(json!({"private": true, "allow_role_ids": [G]})))
            .await
            .out,
        r"that is @everyone",
    );
    assert_match(
        &run(&t, &w, base(json!({"allow_user_ids": [SAM]}))).await.out,
        r"go with private: true",
    );
    assert!(w.calls().is_empty());
}

#[tokio::test]
async fn copy_permissions_from_gives_it_exactly_another_channels_overwrites_with_the_bot_kept_in() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "client-alerts", "copy_permissions_from": PROD, "approved_by": GO}),
    )
    .await;
    let list = w.created().permission_overwrites.unwrap();
    assert_eq!(*overwrite_for(&list, G), ow(G, OverwriteKind::Role, 0, VIEW_CHANNEL));
    assert_eq!(
        *overwrite_for(&list, MODS),
        ow(MODS, OverwriteKind::Role, VIEW_CHANNEL | SEND_MESSAGES, 0)
    );
    assert_eq!(overwrite_for(&list, BOT).kind, OverwriteKind::Member);
    assert!(overwrite_for(&list, BOT).allow & VIEW_CHANNEL != 0);
    assert_eq!(list.len(), 3);
    assert!(
        ran.out
            .contains("who can see it: the same access as #client-prod (copied), which is private")
    );
}

#[tokio::test]
async fn copy_and_private_together_is_refused_with_neither_a_channel_in_a_category_takes_the_categorys_access() {
    let t = test_app();
    let w = world(Opts::default());
    assert_match(
        &run(
            &t,
            &w,
            json!({"action": "create_channel", "name": "x", "copy_permissions_from": PROD, "private": true, "approved_by": GO}),
        )
        .await
        .out,
        r"Pick one: copy_permissions_from .* or private",
    );
    assert!(w.calls().is_empty());
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "x", "parent_id": CAT, "approved_by": GO}),
    )
    .await;
    let mut ids: Vec<String> = w
        .created()
        .permission_overwrites
        .unwrap()
        .into_iter()
        .map(|o| o.id)
        .collect();
    ids.sort();
    assert_eq!(ids, [G, OPS]);
    assert!(
        ran.out
            .contains("the same access as its category Clients (synced), which is private")
    );
}

#[tokio::test]
async fn outside_any_category_with_no_privacy_asked_no_overwrites_public() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "Lobby Chat", "approved_by": GO}),
    )
    .await;
    let o = w.created();
    assert_eq!(o.permission_overwrites, None);
    assert_eq!(o.parent_id, None);
    assert_eq!(o.name, "lobby-chat");
    assert!(ran.out.contains("who can see it: public"));
}

#[tokio::test]
async fn near_channel_id_puts_it_in_that_channels_category_right_after_it_or_before() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "client-alerts", "near_channel_id": PROD, "approved_by": GO}),
    )
    .await;
    assert_eq!(w.created().parent_id.as_deref(), Some(CAT));
    assert!(w.calls().contains(&Call::SetPosition(NEW.into(), 1)));
    assert!(ran.out.contains("placed after #client-prod"));
    let w2 = world(Opts::default());
    run(
        &t,
        &w2,
        json!({"action": "create_channel", "name": "x", "near_channel_id": VOICE, "place": "before", "approved_by": GO}),
    )
    .await;
    assert!(w2.calls().contains(&Call::SetPosition(NEW.into(), 1)));
}

#[tokio::test]
async fn bad_input_is_refused_before_anything_is_made() {
    let t = test_app();
    let w = world(Opts::default());
    let out = |args: Value| {
        let (t, w) = (&t, &w);
        async move { run(t, w, args).await.out }
    };
    assert_match(
        &out(json!({"action": "create_channel", "approved_by": GO})).await,
        r"name is required",
    );
    assert_match(
        &out(json!({"action": "create_channel", "name": "x", "type": "forum", "approved_by": GO})).await,
        r"text, voice or category",
    );
    assert_match(
        &out(json!({"action": "create_channel", "name": "x", "parent_id": GEN, "approved_by": GO})).await,
        r"is #general, not a category",
    );
    assert_match(
        &out(json!({"action": "create_channel", "name": "x", "type": "voice", "topic": "t", "approved_by": GO})).await,
        r"topic is only for text channels",
    );
    let two = world(Opts {
        two_servers: true,
        ..Default::default()
    });
    assert_match(
        &run(
            &t,
            &two,
            json!({"action": "create_channel", "guild_id": G, "name": "x", "copy_permissions_from": OTHER, "approved_by": GO}),
        )
        .await
        .out,
        r#"is not in the server "Acme Server""#,
    );
    assert!(w.calls().is_empty());
}

// ---------------------------------------------------------------- approved_by

async fn without_a_go_it_does_nothing(action: &str) {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(
        &t,
        &w,
        json!({"action": action, "name": "x", "channel_id": GEN, "save_as_key": "X_HOOK"}),
    )
    .await;
    assert_match(
        &ran.out,
        r"needs approved_by: who gave the go.*If nobody has said go for this exact change, ask first\. Nothing was done\.",
    );
    assert!(w.calls().is_empty());
}

#[tokio::test]
async fn create_channel_without_it_does_nothing_and_says_to_ask() {
    without_a_go_it_does_nothing("create_channel").await;
}

#[tokio::test]
async fn edit_channel_without_it_does_nothing_and_says_to_ask() {
    without_a_go_it_does_nothing("edit_channel").await;
}

#[tokio::test]
async fn create_webhook_without_it_does_nothing_and_says_to_ask() {
    without_a_go_it_does_nothing("create_webhook").await;
}

// ---------------------------------------------------------------- create_webhook

#[tokio::test]
async fn saves_the_full_url_under_save_as_key_and_returns_the_id_the_key_and_a_masked_url() {
    let t = test_app();
    let w = world(Opts::default());
    let vault = FakeVault::default();
    let ran = run_with(
        &t,
        &w,
        json!({"action": "create_webhook", "channel_id": GEN, "name": "Uptime Watchdog", "save_as_key": "UPTIME_WATCHDOG_WEBHOOK",
               "purpose": "uptime watchdog alerts", "approved_by": GO}),
        &vault,
    )
    .await;
    let (value, description) = vault.get("UPTIME_WATCHDOG_WEBHOOK").expect("saved");
    assert_eq!(value, format!("https://discord.com/api/webhooks/{HOOK}/{TOKEN}"));
    assert_match(
        &description,
        r"#general \(channel 500000000000000003\) in the server Acme Server",
    );
    assert_match(&description, r"Purpose: uptime watchdog alerts\.");
    assert!(!ran.out.contains(TOKEN), "the token is not in the result");
    assert!(
        !Regex::new(r"webhooks/[0-9]+/[A-Za-z0-9-]{8,}")
            .unwrap()
            .is_match(&ran.out),
        "no full URL in the result"
    );
    assert!(ran.out.contains(&format!("webhook id: {HOOK}")));
    assert!(ran.out.contains(
        "URL saved in the vault as UPTIME_WATCHDOG_WEBHOOK (masked: https://discord.com/api/webhooks/600000000000000001/****WXYZ)"
    ));
    assert!(ran.out.contains("never paste it into a chat"));
    for line in &ran.lines {
        assert!(!line.contains(TOKEN), "log line has no token: {line}");
    }
    assert_eq!(ran.lines.len(), 1);
    assert_match(
        &ran.lines[0],
        r#"\[discord-admin\] create_webhook guild="Acme Server" \(200000000000000001\) channel=#general \(500000000000000003\) ok"#,
    );
    match &w.calls()[..] {
        [Call::WebhookCreate(channel, made)] => {
            assert_eq!(channel, GEN);
            assert_eq!(made.name, "Uptime Watchdog");
            assert_eq!(made.avatar, None);
            assert_eq!(made.reason, format!("Done by the Tarsee agent. Go from: {GO}"));
        }
        calls => panic!("{calls:?}"),
    }
    assert_eq!(
        ran.out,
        [
            "Made the webhook \"Uptime Watchdog\" in #general (id 500000000000000003), server \"Acme Server\" (server id 200000000000000001).",
            "webhook id: 600000000000000001",
            "URL saved in the vault as UPTIME_WATCHDOG_WEBHOOK (masked: https://discord.com/api/webhooks/600000000000000001/****WXYZ).",
            "The URL is a secret: never paste it into a chat, a commit or a command line. Use it from the vault by key name.",
        ]
        .join("\n")
    );
    assert_eq!(
        description,
        "Discord webhook URL \"Uptime Watchdog\" for #general (channel 500000000000000003) in the server Acme Server (200000000000000001), webhook 600000000000000001. Purpose: uptime watchdog alerts. Secret: anyone with it can post there."
    );
}

#[tokio::test]
async fn with_no_save_as_key_it_is_still_saved_under_discord_webhook_channel() {
    let t = test_app();
    let w = world(Opts::default());
    w.rename(GEN, "client-alerts");
    let vault = FakeVault::default();
    let ran = run_with(
        &t,
        &w,
        json!({"action": "create_webhook", "channel_id": GEN, "name": "Watchdog", "approved_by": GO}),
        &vault,
    )
    .await;
    assert!(vault.has_key("DISCORD_WEBHOOK_CLIENT_ALERTS"), "{}", ran.out);
    assert!(ran.out.contains(
        "saved in the vault as DISCORD_WEBHOOK_CLIENT_ALERTS (masked: https://discord.com/api/webhooks/600000000000000001/****WXYZ). (No save_as_key was given, so that name was picked.)"
    ));
    assert!(!ran.out.contains(TOKEN));
}

#[tokio::test]
async fn a_key_that_is_already_there_is_never_replaced_unless_overwrite_key_and_then_no_webhook_is_made_either() {
    let t = test_app();
    let w = world(Opts::default());
    let vault = FakeVault::with(&["UPTIME_WATCHDOG_WEBHOOK"]);
    let ran = run_with(
        &t,
        &w,
        json!({"action": "create_webhook", "channel_id": GEN, "name": "Watchdog", "save_as_key": "UPTIME_WATCHDOG_WEBHOOK", "approved_by": GO}),
        &vault,
    )
    .await;
    assert_match(
        &ran.out,
        r"already has a key named UPTIME_WATCHDOG_WEBHOOK.*No webhook was made",
    );
    assert_eq!(vault.get("UPTIME_WATCHDOG_WEBHOOK").unwrap().0, "old-value");
    assert!(w.calls().is_empty());
    run_with(
        &t,
        &w,
        json!({"action": "create_webhook", "channel_id": GEN, "name": "Watchdog", "save_as_key": "uptime watchdog webhook",
               "overwrite_key": true, "approved_by": GO}),
        &vault,
    )
    .await;
    assert!(vault.get("UPTIME_WATCHDOG_WEBHOOK").unwrap().0.contains(TOKEN));
}

#[tokio::test]
async fn reveal_true_is_the_only_way_the_full_url_comes_back_and_it_is_still_saved() {
    let t = test_app();
    let vault = FakeVault::default();
    let ran = run_with(
        &t,
        &world(Opts::default()),
        json!({"action": "create_webhook", "channel_id": GEN, "name": "Watchdog", "save_as_key": "W_HOOK", "reveal": true,
               "use_bot_avatar": true, "approved_by": GO}),
        &vault,
    )
    .await;
    assert!(
        ran.out
            .contains(&format!("https://discord.com/api/webhooks/{HOOK}/{TOKEN}"))
    );
    assert!(ran.out.contains("do not post it in chat"));
    assert!(vault.has_key("W_HOOK"));
}

#[tokio::test]
async fn the_bots_picture_when_asked_a_thread_a_category_or_a_dm_is_refused() {
    let t = test_app();
    let w = world(Opts::default());
    run(
        &t,
        &w,
        json!({"action": "create_webhook", "channel_id": GEN, "name": "Watchdog", "save_as_key": "W_HOOK", "use_bot_avatar": true, "approved_by": GO}),
    )
    .await;
    match &w.calls()[..] {
        [Call::WebhookCreate(_, made)] => assert_eq!(made.avatar.as_deref(), Some(AVATAR)),
        calls => panic!("{calls:?}"),
    }
    let w2 = world(Opts::default());
    let out = |args: Value| {
        let (t, w2) = (&t, &w2);
        async move { run(t, w2, args).await.out }
    };
    assert_match(
        &out(json!({"action": "create_webhook", "channel_id": THREAD, "name": "W", "approved_by": GO})).await,
        r"is a thread\. Webhooks belong to its parent channel #client-prod",
    );
    assert_match(
        &out(json!({"action": "create_webhook", "channel_id": CAT, "name": "W", "approved_by": GO})).await,
        r"category channel, which cannot have webhooks",
    );
    assert_match(
        &out(json!({"action": "create_webhook", "channel_id": DM_ID, "name": "W", "approved_by": GO})).await,
        r"direct message",
    );
    assert_match(
        &out(json!({"action": "create_webhook", "channel_id": GEN, "name": "Discord Bot", "approved_by": GO})).await,
        r#"does not allow "clyde" or "discord""#,
    );
    assert_match(
        &out(json!({"action": "create_webhook", "channel_id": GEN, "name": "W", "save_as_key": "!!!", "approved_by": GO})).await,
        r"not a usable key name",
    );
    assert!(w2.calls().is_empty());
}

struct BrokenVault;

impl WebhookVault for BrokenVault {
    fn has_key(&self, _name: &str) -> bool {
        false
    }

    fn set_key(&self, _name: &str, _value: &str, _description: &str) -> anyhow::Result<()> {
        anyhow::bail!("disk full")
    }
}

#[tokio::test]
async fn a_vault_that_cannot_be_written_says_the_webhook_exists_and_still_does_not_show_the_url() {
    let t = test_app();
    let ran = run_with(
        &t,
        &world(Opts::default()),
        json!({"action": "create_webhook", "channel_id": GEN, "name": "Watchdog", "save_as_key": "W_HOOK", "approved_by": GO}),
        &BrokenVault,
    )
    .await;
    assert_match(
        &ran.out,
        r"The webhook 600000000000000001 was made in #general, but saving its URL to the vault failed \(disk full\)\. The URL was not shown\.",
    );
    assert!(!ran.out.contains(TOKEN));
}

// ---------------------------------------------------------------- list_webhooks

#[tokio::test]
async fn list_webhooks_names_and_ids_only_no_token_no_url() {
    let t = test_app();
    let ran = run(
        &t,
        &world(Opts::default()),
        json!({"action": "list_webhooks", "channel_id": PROD}),
    )
    .await;
    assert_eq!(
        ran.out,
        "Webhooks in #client-prod (id 500000000000000002), server \"Acme Server\" (server id 200000000000000001). URLs are secrets and are not listed:\n- Old Hook (webhook id 600000000000000005), incoming, made by alex"
    );
    assert!(!ran.out.contains("old-SECRET-token"));
    assert!(!ran.out.contains("/api/webhooks/"));
    assert_match(
        &run(
            &t,
            &world(Opts::default()),
            json!({"action": "list_webhooks", "channel_id": GEN}),
        )
        .await
        .out,
        r"has no webhooks",
    );
}

// ---------------------------------------------------------------- edit_channel

#[tokio::test]
async fn rename_topic_and_a_move_to_a_category_in_one_edit() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(
        &t,
        &w,
        json!({"action": "edit_channel", "channel_id": GEN, "name": "Team Chat", "topic": "Say hi", "parent_id": CAT,
               "sync_with_category": true, "approved_by": GO}),
    )
    .await;
    let edit = w
        .calls()
        .into_iter()
        .find_map(|c| match c {
            Call::Edit(_, e) => Some(e),
            _ => None,
        })
        .expect("an edit");
    assert_eq!(edit.name.as_deref(), Some("team-chat"));
    assert_eq!(edit.topic.as_deref(), Some("Say hi"));
    assert_eq!(edit.parent, Some(Some(CAT.to_string())));
    assert!(edit.lock_permissions);
    assert_eq!(
        ran.out,
        [
            "Edited #team-chat (id 500000000000000003) in the server \"Acme Server\" (server id 200000000000000001):",
            "- renamed from general to team-chat",
            "- topic set",
            "- moved to the category Clients",
            "- access synced with its category",
            "link: https://discord.com/channels/200000000000000001/500000000000000003",
        ]
        .join("\n")
    );
}

#[tokio::test]
async fn parent_id_none_takes_it_out_of_its_category() {
    let t = test_app();
    let w = world(Opts::default());
    run(
        &t,
        &w,
        json!({"action": "edit_channel", "channel_id": PROD, "parent_id": "none", "approved_by": GO}),
    )
    .await;
    let edit = w.calls().into_iter().find_map(|c| match c {
        Call::Edit(_, e) => Some(e),
        _ => None,
    });
    assert_eq!(edit.unwrap().parent, Some(None));
}

#[tokio::test]
async fn permission_overwrites_for_a_user_and_a_role_allow_deny_reset_and_clear() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(
        &t,
        &w,
        json!({"action": "edit_channel", "channel_id": PROD, "approved_by": GO, "permissions": [
            {"target": SAM, "allow": ["view", "SendMessages", "read_message_history"]},
            {"target": format!("<@&{OPS}>"), "deny": ["send"], "reset": ["View Channel"]},
            {"target": MODS, "clear": true},
        ]}),
    )
    .await;
    let sets = w.overwrite_sets();
    assert_eq!(
        sets[0],
        (
            SAM.to_string(),
            OverwriteKind::Member,
            vec![
                (VIEW_CHANNEL, Some(true)),
                (SEND_MESSAGES, Some(true)),
                (READ_MESSAGE_HISTORY, Some(true))
            ]
        )
    );
    assert_eq!(
        sets[1],
        (
            OPS.to_string(),
            OverwriteKind::Role,
            vec![(SEND_MESSAGES, Some(false)), (VIEW_CHANNEL, None)]
        )
    );
    assert!(w.calls().contains(&Call::OverwriteClear {
        channel: PROD.into(),
        target: MODS.into()
    }));
    assert!(
        ran.out
            .contains("- Sam: allowed View Channel, Send Messages, Read Message History")
    );
    assert!(
        ran.out
            .contains("- @Ops: denied Send Messages; reset View Channel to the default")
    );
    assert!(ran.out.contains("- removed the permission overwrite for @Mods"));
    assert!(
        !w.calls().iter().any(|c| matches!(c, Call::Edit(..))),
        "no channel edit when only access changes"
    );
}

#[tokio::test]
async fn private_true_hides_it_from_everyone_and_keeps_the_bot_and_the_listed_people_in() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(
        &t,
        &w,
        json!({"action": "edit_channel", "channel_id": GEN, "private": true, "allow_user_ids": [SAM], "approved_by": GO}),
    )
    .await;
    let sets = w.overwrite_sets();
    let set_of = |id: &str| {
        sets.iter()
            .find(|(t, _, _)| t == id)
            .map(|(_, _, s)| s.clone())
            .unwrap()
    };
    assert_eq!(set_of(G), vec![(VIEW_CHANNEL, Some(false))]);
    assert!(set_of(BOT).contains(&(VIEW_CHANNEL, Some(true))));
    assert!(set_of(SAM).contains(&(VIEW_CHANNEL, Some(true))));
    // Node's answer for the same edit.
    assert_eq!(
        ran.out,
        [
            "Edited #general (id 500000000000000003) in the server \"Acme Server\" (server id 200000000000000001):",
            "- @everyone: denied View Channel",
            "- the bot: allowed View Channel, Send Messages, Read Message History, Embed Links, Attach Files, Add Reactions",
            "- Sam: allowed View Channel, Send Messages, Read Message History, Embed Links, Attach Files, Add Reactions",
            "link: https://discord.com/channels/200000000000000001/500000000000000003",
        ]
        .join("\n")
    );
}

#[tokio::test]
async fn denying_everyone_the_view_by_hand_also_keeps_the_bot_in() {
    let t = test_app();
    let w = world(Opts::default());
    run(
        &t,
        &w,
        json!({"action": "edit_channel", "channel_id": GEN, "permissions": [{"target": "everyone", "deny": ["view"]}], "approved_by": GO}),
    )
    .await;
    let sets = w.overwrite_sets();
    assert_eq!(sets.len(), 2);
    let bot = sets.iter().find(|(t, _, _)| t == BOT).unwrap();
    assert!(bot.2.contains(&(VIEW_CHANNEL, Some(true))));
}

#[tokio::test]
async fn unknown_permissions_administrator_unknown_targets_and_empty_edits_are_refused_before_anything_changes() {
    let t = test_app();
    let w = world(Opts::default());
    let out = |args: Value| {
        let (t, w) = (&t, &w);
        async move { run(t, w, args).await.out }
    };
    assert_match(
        &out(json!({"action": "edit_channel", "channel_id": GEN, "permissions": [{"target": SAM, "allow": ["fly"]}], "approved_by": GO})).await,
        r#""fly" is not a Discord permission"#,
    );
    assert_match(
        &out(json!({"action": "edit_channel", "channel_id": GEN, "permissions": [{"target": SAM, "allow": ["Administrator"]}], "approved_by": GO})).await,
        r"Administrator is a server-wide role permission",
    );
    assert_match(
        &out(json!({"action": "edit_channel", "channel_id": GEN, "permissions": [{"target": "399999999999999999", "allow": ["view"]}], "approved_by": GO})).await,
        r"No role or member with id 399999999999999999",
    );
    assert_match(
        &out(json!({"action": "edit_channel", "channel_id": GEN, "approved_by": GO})).await,
        r"Nothing to change",
    );
    assert_match(
        &out(json!({"action": "edit_channel", "channel_id": THREAD, "name": "x", "approved_by": GO})).await,
        r"is a thread",
    );
    assert_match(
        &out(json!({"action": "edit_channel", "approved_by": GO})).await,
        r"channel_id is required",
    );
    assert!(w.calls().is_empty());
}

// ---------------------------------------------------------------- a permission the bot does not have

#[tokio::test]
async fn no_manage_channels_create_channel_is_refused_before_discord_is_asked() {
    let t = test_app();
    let w = world(Opts {
        bot_perms: Some(vec![VIEW_CHANNEL, SEND_MESSAGES, MANAGE_WEBHOOKS]),
        ..Default::default()
    });
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "client-alerts", "approved_by": GO}),
    )
    .await;
    assert_match(
        &ran.out,
        r#"^discord_admin create_channel error: the bot is missing the Manage Channels permission in the server "Acme Server" \(server id 200000000000000001\), so it cannot make channels\. Ask the owner to give the bot's role that permission"#,
    );
    assert!(w.calls().is_empty());
    assert_match(
        &ran.lines[0],
        r#"create_channel guild="Acme Server" .* failed: the bot is missing the Manage Channels"#,
    );
}

#[tokio::test]
async fn no_manage_webhooks_create_webhook_is_refused_and_nothing_goes_in_the_vault() {
    let t = test_app();
    let w = world(Opts {
        bot_perms: Some(vec![VIEW_CHANNEL, MANAGE_CHANNELS]),
        ..Default::default()
    });
    let vault = FakeVault::default();
    let ran = run_with(
        &t,
        &w,
        json!({"action": "create_webhook", "channel_id": GEN, "name": "W", "save_as_key": "W_HOOK", "approved_by": GO}),
        &vault,
    )
    .await;
    assert_match(
        &ran.out,
        r#"missing the Manage Webhooks permission in #general in the server "Acme Server""#,
    );
    assert!(vault.keys.lock().is_empty());
    assert!(w.calls().is_empty());
    assert_match(
        &run(&t, &w, json!({"action": "list_webhooks", "channel_id": GEN}))
            .await
            .out,
        r"missing the Manage Webhooks permission",
    );
}

#[tokio::test]
async fn no_manage_roles_access_changes_are_refused() {
    let t = test_app();
    let w = world(Opts {
        bot_perms: Some(vec![VIEW_CHANNEL, MANAGE_CHANNELS]),
        ..Default::default()
    });
    let ran = run(
        &t,
        &w,
        json!({"action": "edit_channel", "channel_id": GEN, "permissions": [{"target": SAM, "allow": ["view"]}], "approved_by": GO}),
    )
    .await;
    assert_match(
        &ran.out,
        r"missing the Manage Permissions \(Manage Roles\) permission in #general",
    );
    assert!(w.calls().is_empty());
}

#[tokio::test]
async fn when_discord_itself_says_missing_permissions_50013_the_error_names_the_permission_and_the_server() {
    let t = test_app();
    let w = world(Opts {
        create_error: Some(DiscordError::new(Some(50013), "Missing Permissions")),
        ..Default::default()
    });
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "client-alerts", "approved_by": GO}),
    )
    .await;
    assert_match(
        &ran.out,
        r#"Discord refused: the bot is missing a permission it needs in the server "Acme Server" \(server id 200000000000000001\) \(Manage Channels\)\. Discord said: "Missing Permissions"\."#,
    );
    let w2 = world(Opts {
        hook_error: Some(DiscordError::new(Some(50013), "Missing Permissions")),
        ..Default::default()
    });
    assert_match(
        &run(
            &t,
            &w2,
            json!({"action": "create_webhook", "channel_id": GEN, "name": "W", "save_as_key": "W_HOOK", "approved_by": GO}),
        )
        .await
        .out,
        r#"missing a permission it needs in #general in the server "Acme Server" .*\(Manage Webhooks\)"#,
    );
    let w3 = world(Opts {
        hook_error: Some(DiscordError::new(
            Some(30007),
            "Maximum number of webhooks reached (15)",
        )),
        ..Default::default()
    });
    assert_match(
        &run(
            &t,
            &w3,
            json!({"action": "create_webhook", "channel_id": GEN, "name": "W", "save_as_key": "W_HOOK", "approved_by": GO}),
        )
        .await
        .out,
        r"already has the most webhooks Discord allows",
    );
}

// ---------------------------------------------------------------- unknown actions and no delete paths

#[tokio::test]
async fn anything_not_in_the_list_is_refused_deletes_by_name_included_and_nothing_is_called() {
    let t = test_app();
    for action in [
        Some("delete_channel"),
        Some("delete_webhook"),
        Some("remove_channel"),
        Some("purge"),
        Some(""),
        None,
        Some("LIST_CHANNELS"),
    ] {
        let w = world(Opts::default());
        let mut args = json!({"channel_id": GEN, "approved_by": GO});
        if let Some(action) = action {
            args["action"] = json!(action);
        }
        let ran = run(&t, &w, args).await;
        assert_match(&ran.out, r"Unknown action");
        assert_match(
            &ran.out,
            r"never deletes anything: deleting a channel or a webhook is something the owner does by hand",
        );
        assert!(w.calls().is_empty(), "{action:?}");
    }
}

#[test]
fn the_actions_are_the_five_none_of_them_a_delete() {
    assert_eq!(
        ACTIONS,
        [
            "list_channels",
            "create_channel",
            "edit_channel",
            "create_webhook",
            "list_webhooks"
        ]
    );
    let deleting = Regex::new("delete|remove|purge|prune|kick|ban").unwrap();
    for action in ACTIONS {
        assert!(!deleting.is_match(action), "{action}");
    }
}

/// The module's code, without its comments and its tests.
fn source_code() -> String {
    let src = include_str!("../discord_admin.rs");
    let code = src.split("#[cfg(test)]").next().unwrap();
    code.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_module_never_calls_a_delete_except_clearing_one_permission_overwrite() {
    let code = source_code();
    let deletes = Regex::new(r"\.\s*delete[A-Za-z_]*\s*\(")
        .unwrap()
        .find_iter(&code)
        .count();
    let overwrite_clears = code.matches(".delete_permission_overwrite(").count();
    assert_eq!(
        deletes, overwrite_clears,
        "every delete call is delete_permission_overwrite"
    );
    assert_eq!(overwrite_clears, 1);
    assert!(
        !Regex::new(r"delete_key|bulk_delete|\.prune\(|\.kick\(|\.ban\(")
            .unwrap()
            .is_match(&code)
    );
    // The trait itself has no other way to remove anything.
    let trait_methods = Regex::new(r"async fn (delete|remove)[A-Za-z_]*").unwrap();
    assert_eq!(
        trait_methods.find_iter(&code).map(|m| m.as_str()).collect::<Vec<_>>(),
        ["async fn delete_permission_overwrite"]
    );
}

#[tokio::test]
async fn every_action_run_end_to_end_leaves_no_delete_behind() {
    let t = test_app();
    let w = world(Opts::default());
    run(&t, &w, json!({"action": "list_channels"})).await;
    run(
        &t,
        &w,
        json!({"action": "create_channel", "name": "a", "private": true, "approved_by": GO}),
    )
    .await;
    run(
        &t,
        &w,
        json!({"action": "edit_channel", "channel_id": GEN, "name": "b", "permissions": [{"target": SAM, "allow": ["view"]}], "approved_by": GO}),
    )
    .await;
    run(
        &t,
        &w,
        json!({"action": "create_webhook", "channel_id": GEN, "name": "c", "save_as_key": "C_HOOK", "approved_by": GO}),
    )
    .await;
    run(&t, &w, json!({"action": "list_webhooks", "channel_id": GEN})).await;
    let calls = w.calls();
    assert!(calls.len() >= 4, "{calls:?}");
    assert!(!calls.iter().any(|c| matches!(c, Call::OverwriteClear { .. })));
}

#[tokio::test]
async fn not_connected_nothing_is_done() {
    let t = test_app();
    let w = world(Opts::default());
    w.ready.store(false, Ordering::SeqCst);
    assert_match(
        &run(&t, &w, json!({"action": "list_channels"})).await.out,
        r"Discord is not connected right now",
    );
    assert!(w.calls().is_empty());
}

// ---------------------------------------------------------------- helpers and wording

#[test]
fn permission_names_in_any_case_with_short_aliases() {
    assert_eq!(perm_flag("ViewChannel"), Some(VIEW_CHANNEL));
    assert_eq!(perm_flag("view_channel"), Some(VIEW_CHANNEL));
    assert_eq!(perm_flag("View Channel"), Some(VIEW_CHANNEL));
    assert_eq!(perm_flag("view"), Some(VIEW_CHANNEL));
    assert_eq!(perm_flag("history"), Some(READ_MESSAGE_HISTORY));
    assert_eq!(perm_flag("manage_webhooks"), Some(MANAGE_WEBHOOKS));
    assert_eq!(perm_flag("nope"), None);
}

#[test]
fn key_names_and_masked_urls() {
    assert_eq!(key_name_from("uptime watchdog-webhook"), "UPTIME_WATCHDOG_WEBHOOK");
    assert_eq!(key_name_from(&format!("DISCORD_WEBHOOK_{}", "x".repeat(100))).len(), 64);
    assert_eq!(
        mask_webhook_url("1", "abcdefgh1234"),
        "https://discord.com/api/webhooks/1/****1234"
    );
}

#[test]
fn no_em_dash_in_anything_a_person_reads() {
    assert!(!include_str!("../discord_admin.rs").contains('\u{2014}'));
}

// ---------------------------------------------------------------- the permissions as discord.js worked them out

/// The Node test's real `discord.js` client, never logged in: a server whose @everyone may view and send, an Ops
/// role, and the bot's role with `bot_role_perms`; #client-prod hidden from @everyone and open to Ops. The bot's
/// permissions are worked out from these as `discord.js` did.
fn real_world(bot_role_perms: u64, refuse: Option<DiscordError>) -> World {
    let everyone = VIEW_CHANNEL | SEND_MESSAGES;
    let bot_roles = [G, TARSEE_ROLE];
    let bot_role_values = [everyone, bot_role_perms];
    let guild_perms = member_permissions(false, &bot_role_values);
    let mut cat = channel(CAT, "Clients", GUILD_CATEGORY, Some(G), None, 0);
    let mut prod = channel(PROD, "client-prod", GUILD_TEXT, Some(G), Some(CAT), 0);
    prod.overwrites = vec![
        ow(G, OverwriteKind::Role, 0, VIEW_CHANNEL),
        ow(OPS, OverwriteKind::Role, VIEW_CHANNEL, 0),
    ];
    for c in [&mut cat, &mut prod] {
        c.bot_permissions = Some(member_channel_permissions(
            G,
            BOT,
            false,
            &bot_roles,
            &bot_role_values,
            &c.overwrites,
        ));
        c.everyone_permissions = Some(role_channel_permissions(G, G, everyone, everyone, &c.overwrites));
    }
    let role = |id: &str, name: &str| Role {
        id: id.into(),
        name: name.into(),
    };
    World {
        guilds: vec![Guild {
            id: G.into(),
            name: "Acme Server".into(),
            roles: vec![role(G, "@everyone"), role(OPS, "Ops"), role(TARSEE_ROLE, "Tarsee")],
            bot_permissions: Some(guild_perms),
        }],
        channels: Mutex::new(vec![cat, prod]),
        members: vec![
            (G.to_string(), member(BOT, Some("tarsee"), Some("tarsee"))),
            (G.to_string(), member(SAM, Some("sam_k"), Some("sam_k"))),
        ],
        hooks: Vec::new(),
        calls: Mutex::new(Vec::new()),
        ready: AtomicBool::new(true),
        bot_perms: guild_perms,
        create_error: refuse.clone(),
        hook_error: refuse,
    }
}

const REAL_BOT_ROLE: u64 = MANAGE_CHANNELS | MANAGE_WEBHOOKS | VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;

#[tokio::test]
async fn a_private_channel_goes_up_with_everyone_denied_and_the_bot_the_user_and_the_role_allowed() {
    let t = test_app();
    let w = real_world(REAL_BOT_ROLE, None);
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "channel_id": PROD, "name": "client-alerts", "near_channel_id": PROD, "private": true,
               "allow_user_ids": [SAM], "allow_role_ids": [OPS], "approved_by": GO}),
    )
    .await;
    assert_match(&ran.out, r"^Made #client-alerts \(text channel\)");
    let o = w.created();
    assert_eq!(o.parent_id.as_deref(), Some(CAT));
    let list = o.permission_overwrites.unwrap();
    // What the bot's role holds of the text set.
    let access = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;
    assert_eq!(*overwrite_for(&list, G), ow(G, OverwriteKind::Role, 0, VIEW_CHANNEL));
    assert_eq!(*overwrite_for(&list, BOT), ow(BOT, OverwriteKind::Member, access, 0));
    assert_eq!(*overwrite_for(&list, SAM), ow(SAM, OverwriteKind::Member, access, 0));
    assert_eq!(*overwrite_for(&list, OPS), ow(OPS, OverwriteKind::Role, access, 0));
    // Then the new channel goes right after #client-prod (discord.js renumbered that category's channels from it:
    // package H2's part).
    assert_eq!(w.calls()[1], Call::SetPosition(NEW.into(), 1));
}

#[tokio::test]
async fn a_webhook_the_url_lands_in_the_vault_and_only_the_masked_one_in_the_result() {
    let t = test_app();
    let w = real_world(REAL_BOT_ROLE, None);
    let vault = FakeVault::default();
    let ran = run_with(
        &t,
        &w,
        json!({"action": "create_webhook", "channel_id": PROD, "name": "Uptime Watchdog", "save_as_key": "UPTIME_WATCHDOG_WEBHOOK", "approved_by": GO}),
        &vault,
    )
    .await;
    assert_eq!(
        w.calls(),
        [Call::WebhookCreate(
            PROD.into(),
            NewWebhook {
                name: "Uptime Watchdog".into(),
                avatar: None,
                reason: format!("Done by the Tarsee agent. Go from: {GO}"),
            }
        )]
    );
    assert_eq!(
        vault.get("UPTIME_WATCHDOG_WEBHOOK").unwrap().0,
        format!("https://discord.com/api/webhooks/{HOOK}/{TOKEN}")
    );
    assert!(!ran.out.contains(TOKEN));
}

#[tokio::test]
async fn the_real_permission_math_refuses_what_the_bots_role_lacks_manage_roles_for_access_changes() {
    let t = test_app();
    let w = real_world(REAL_BOT_ROLE, None);
    let ran = run(
        &t,
        &w,
        json!({"action": "edit_channel", "channel_id": PROD, "permissions": [{"target": SAM, "allow": ["view"]}], "approved_by": GO}),
    )
    .await;
    assert_match(
        &ran.out,
        r#"missing the Manage Permissions \(Manage Roles\) permission in #client-prod in the server "Acme Server""#,
    );
    assert!(w.calls().is_empty());
}

#[tokio::test]
async fn a_refusal_from_discord_reads_as_plain_english() {
    let t = test_app();
    let w = real_world(
        REAL_BOT_ROLE,
        Some(DiscordError::new(Some(50013), "Missing Permissions")),
    );
    let ran = run(
        &t,
        &w,
        json!({"action": "create_channel", "channel_id": PROD, "name": "x", "copy_permissions_from": PROD, "approved_by": GO}),
    )
    .await;
    assert_match(
        &ran.out,
        r#"Discord refused: the bot is missing a permission it needs in the server "Acme Server" \(server id 200000000000000001\) \(Manage Channels\)\."#,
    );
}

#[test]
fn the_permissions_are_worked_out_as_discord_js_did() {
    let overwrites = vec![
        ow(G, OverwriteKind::Role, 0, VIEW_CHANNEL),
        ow(OPS, OverwriteKind::Role, VIEW_CHANNEL, 0),
        ow(SAM, OverwriteKind::Member, ATTACH_FILES, SEND_MESSAGES),
    ];
    let everyone = VIEW_CHANNEL | SEND_MESSAGES;
    // @everyone denied the view; Ops's own overwrite gives it back; Sam's member overwrite comes last.
    assert_eq!(
        member_channel_permissions(G, SAM, false, &[G], &[everyone], &overwrites),
        ATTACH_FILES
    );
    assert_eq!(
        member_channel_permissions(G, SAM, false, &[G, OPS], &[everyone, 0], &overwrites),
        VIEW_CHANNEL | ATTACH_FILES
    );
    assert_eq!(
        member_channel_permissions(G, SAM, true, &[G], &[everyone], &overwrites),
        ALL_PERMISSIONS
    );
    assert_eq!(
        member_channel_permissions(G, SAM, false, &[G], &[everyone | ADMINISTRATOR], &overwrites),
        ALL_PERMISSIONS
    );
    assert_eq!(
        role_channel_permissions(G, G, everyone, everyone, &overwrites),
        SEND_MESSAGES
    );
    assert_eq!(
        role_channel_permissions(G, OPS, 0, everyone, &overwrites),
        VIEW_CHANNEL | SEND_MESSAGES
    );
    assert_eq!(
        member_permissions(false, &[everyone, MANAGE_ROLES]),
        everyone | MANAGE_ROLES
    );
    assert_eq!(member_permissions(true, &[]), ALL_PERMISSIONS);
    assert!(has_permission(ADMINISTRATOR, MANAGE_WEBHOOKS));
    assert!(!has_permission(VIEW_CHANNEL, MANAGE_WEBHOOKS));
    // An edit on an overwrite that is there: true allows, false denies, null clears; later keys win.
    let had = ow(SAM, OverwriteKind::Member, VIEW_CHANNEL | CONNECT, SPEAK);
    assert_eq!(
        apply_overwrite_set(
            Some(&had),
            &[(SEND_MESSAGES, Some(true)), (VIEW_CHANNEL, Some(false)), (SPEAK, None)]
        ),
        (CONNECT | SEND_MESSAGES, VIEW_CHANNEL)
    );
    assert_eq!(
        apply_overwrite_set(None, &[(VIEW_CHANNEL, Some(true))]),
        (VIEW_CHANNEL, 0)
    );
}

#[test]
fn every_permission_name_and_label_matches_discord_js() {
    // `Object.entries(PermissionFlagsBits)` printed by Node: 53 names, 52 bits.
    assert_eq!(PERMISSION_FLAGS.len(), 53);
    assert_eq!(FLAG_NAME.len(), 52);
    assert_eq!(flag_name(1 << 30), Some("ManageGuildExpressions"));
    assert_eq!(perm_flag("ManageEmojisAndStickers"), Some(1 << 30));
    assert_eq!(perm_flag("manage-guild-expressions"), Some(1 << 30));
    assert_eq!(perm_flag("BYPASSSLOWMODE"), Some(1 << 52));
    assert_eq!(perm_flag("threads"), Some(SEND_MESSAGES_IN_THREADS));
    assert_eq!(perm_flag("mention\u{3000}everyone"), Some(MENTION_EVERYONE));
    assert_eq!(perm_flag(""), None);
    assert_eq!(perm_flag(" _- "), None);
    assert_eq!(perm_label(MANAGE_ROLES), "Manage Permissions (Manage Roles)");
    assert_eq!(perm_label(1 << 25), "Use VAD");
    assert_eq!(perm_label(1 << 12), "Send TTSMessages");
    assert_eq!(perm_label(1 << 30), "Manage Guild Expressions");
    assert_eq!(perm_label(1 << 47), "140737488355328");
    assert_eq!(ALL_PERMISSIONS.count_ones(), 52);
}

#[test]
fn key_names_from_awkward_text() {
    // Node's own answers for the same inputs.
    assert_eq!(key_name_from("  9lives  "), "K_9LIVES");
    assert_eq!(key_name_from("__a__b__"), "A_B");
    assert_eq!(key_name_from("straße hook"), "STRASSE_HOOK");
    assert_eq!(key_name_from("日本"), "");
    assert_eq!(key_name_from("\u{FEFF}x y\u{FEFF}"), "X_Y");
    assert_eq!(key_name_from(&format!("{}_tail", "a".repeat(63))), "A".repeat(63));
    assert_eq!(mask_webhook_url("7", ""), "https://discord.com/api/webhooks/7/****");
    assert_eq!(
        mask_webhook_url("7", "ab🐒"),
        "https://discord.com/api/webhooks/7/****ab🐒"
    );
}

// ---------------------------------------------------------------- the real vault, the agent's words, redaction

#[tokio::test]
async fn create_webhook_with_no_vault_given_saves_through_the_key_vault_encrypted_at_rest() {
    let t = test_app_with_env([("ENCRYPTION_KEY", "discord-admin-test-encryption-key-0123456789")]);
    let w = world(Opts::default());
    let lines = Mutex::new(Vec::new());
    let log = |line: &str| lines.lock().push(line.to_string());
    let out = discord_admin(
        &t.app,
        &json!({"action": "create_webhook", "channel_id": GEN, "name": "Watchdog", "save_as_key": "TMP_TEST_WEBHOOK",
                "purpose": "a test", "approved_by": GO}),
        DiscordAdminDeps {
            client: &w,
            vault: None,
            log: Some(&log),
        },
    )
    .await;
    assert!(out.contains("saved in the vault as TMP_TEST_WEBHOOK"), "{out}");
    assert_eq!(
        key_vault::get_key(&t.app, "TMP_TEST_WEBHOOK").unwrap().as_deref(),
        Some(format!("https://discord.com/api/webhooks/{HOOK}/{TOKEN}").as_str())
    );
    let listed = key_vault::list_keys(&t.app);
    let info = listed.iter().find(|k| k.name == "TMP_TEST_WEBHOOK").unwrap();
    assert_match(&info.description, r"#general .* Purpose: a test\.");
    let file = t.path().join("data").join("vault.json");
    assert!(file.exists(), "the temporary vault file");
    assert!(
        !std::fs::read_to_string(&file).unwrap().contains(TOKEN),
        "the token is encrypted on disk"
    );
}

#[test]
fn the_turns_tool_list_names_it_and_a_new_workspaces_agents_md_and_tools_md_carry_the_rules() {
    let preamble = crate::ai::preamble::build_preamble(None, "/workspace", "UTC");
    assert!(preamble.contains("**discord_admin**(action, ...)"));
    let default = |name: &str| {
        crate::config::env::DEFAULT_FILES
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, text)| text.to_string())
            .unwrap()
    };
    let shipped = |name: &str| {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join("workspace-defaults")
                .join(name),
        )
        .unwrap()
    };
    for (what, text) in [
        ("TOOLS.md", shipped("TOOLS.md")),
        ("defaults TOOLS.md", default("TOOLS.md")),
    ] {
        assert!(text.contains("## Discord admin (channels, webhooks)"), "{what}");
        assert!(text.contains("never pull DISCORD_BOT_TOKEN from the vault"), "{what}");
    }
    for (what, text) in [
        ("AGENTS.md", shipped("AGENTS.md")),
        ("defaults AGENTS.md", default("AGENTS.md")),
    ] {
        assert!(text.contains("## Approvals"), "{what}");
        assert!(text.contains("## Keys: check the vault every time"), "{what}");
    }
}

#[test]
fn a_webhook_url_in_a_log_line_or_the_tool_timeline_keeps_its_id_and_loses_its_token() {
    assert_eq!(
        crate::lib::redact::redact_secrets(&format!("saved https://discord.com/api/webhooks/{HOOK}/{TOKEN}")),
        format!("saved https://discord.com/api/webhooks/{HOOK}/[REDACTED]")
    );
}

// ---------------------------------------------------------------- what the Node tests left out

#[tokio::test]
async fn the_log_line_names_the_action_server_and_channel_and_never_a_secret() {
    let t = test_app();
    let w = world(Opts::default());
    let ran = run(&t, &w, json!({"action": "nope"})).await;
    assert_eq!(
        ran.lines,
        // Cut at 200 characters.
        [
            "[discord-admin] nope guild=- channel=- failed: Unknown action \"nope\". This tool does: list_channels, create_channel, edit_channel, create_webhook, list_webhooks. It never deletes anything: deleting a channel or a webhook is something the owner doe"
        ]
    );
    let ran = run(&t, &w, json!({})).await;
    assert!(ran.lines[0].starts_with("[discord-admin] (no action) guild=- channel=- failed: Unknown action \"\"."));
    // An empty action leaves a double space, which the answer closes up.
    assert!(
        ran.out.starts_with("discord_admin error: Unknown action \"\"."),
        "{}",
        ran.out
    );
    // Logged by default with log::info!.
    let logs = crate::testkit::CapturedLogs::start();
    discord_admin(&t.app, &json!({"action": "list_channels"}), DiscordAdminDeps::new(&w)).await;
    assert_eq!(
        logs.infos(),
        ["[discord-admin] list_channels guild=\"Acme Server\" (200000000000000001) channel=- ok"]
    );
}

#[tokio::test]
async fn other_refusals_from_discord_in_plain_words() {
    let note = Note {
        guild: Some(world(Opts::default()).guilds[0].clone()),
        channel: None,
        hands_out: vec![MANAGE_ROLES, VIEW_CHANNEL],
    };
    let text = |code: Option<i64>, message: &str, action: &str| {
        discord_error_text(&DiscordError::new(code, message), action, &note)
    };
    assert_eq!(
        text(Some(50001), "Missing Access", "list_channels"),
        "Discord refused: the bot cannot see the server \"Acme Server\" (server id 200000000000000001) (Missing Access). Discord said: \"Missing Access\"."
    );
    assert!(text(Some(10003), "", "x").starts_with("Discord says there is no such channel"));
    assert!(text(Some(10004), "", "x").starts_with("Discord says the bot is not in that server"));
    assert_eq!(
        text(Some(30013), "", "x"),
        "The server already has the most channels Discord allows (500)."
    );
    assert_eq!(
        text(Some(50035), "Invalid Form Body", "x"),
        "Discord did not accept the values: \"Invalid Form Body\"."
    );
    assert_eq!(text(Some(40060), "Odd", "x"), "Discord said: \"Odd\" (code 40060).");
    assert_eq!(text(None, "socket hang up", "x"), "Discord said: \"socket hang up\".");
    assert_eq!(text(None, "", "x"), "Discord said: \"Error\".");
    // Handing out what the bot itself lacks (here it has everything, so nothing is named).
    assert!(!text(Some(50013), "Missing Permissions", "edit_channel").contains("also hands out"));
    let poor = Note {
        guild: Some(Guild {
            bot_permissions: Some(VIEW_CHANNEL),
            ..note.guild.clone().unwrap()
        }),
        ..note
    };
    assert_eq!(
        discord_error_text(
            &DiscordError::new(Some(50013), "Missing Permissions"),
            "edit_channel",
            &poor
        ),
        "Discord refused: the bot is missing a permission it needs in the server \"Acme Server\" (server id 200000000000000001) (Manage Channels and Manage Permissions (Manage Roles)). The access being set also hands out Manage Permissions (Manage Roles), which the bot's role does not have, and Discord only lets a bot hand out permissions it has itself. Discord said: \"Missing Permissions\". Ask the owner to give the bot's role that permission (Server Settings > Roles), or to do this by hand. Nothing more was changed."
    );
}

#[tokio::test]
async fn a_failed_move_next_to_another_channel_still_reports_the_channel_made() {
    struct NoMove(World);
    #[async_trait]
    impl DiscordClient for NoMove {
        fn user(&self) -> Option<BotUser> {
            self.0.user()
        }
        fn is_ready(&self) -> bool {
            true
        }
        fn guilds(&self) -> Vec<Guild> {
            self.0.guilds()
        }
        async fn fetch_guild(&self, id: &str) -> Option<Guild> {
            self.0.fetch_guild(id).await
        }
        async fn fetch_channel(&self, id: &str) -> Option<Channel> {
            self.0.fetch_channel(id).await
        }
        fn guild_channels(&self, guild_id: &str) -> Vec<Channel> {
            self.0.guild_channels(guild_id)
        }
        async fn fetch_member(&self, guild_id: &str, user_id: &str) -> Option<Member> {
            self.0.fetch_member(guild_id, user_id).await
        }
        async fn create_channel(&self, guild_id: &str, request: NewChannel) -> Result<Channel, DiscordError> {
            self.0.create_channel(guild_id, request).await
        }
        async fn edit_channel(&self, id: &str, request: ChannelEdit) -> Result<Option<Channel>, DiscordError> {
            self.0.edit_channel(id, request).await
        }
        async fn set_channel_position(&self, _: &str, _: i64, _: &str) -> Result<(), DiscordError> {
            Err(DiscordError::new(Some(50013), "Missing Permissions"))
        }
        async fn edit_permission_overwrite(
            &self,
            _: &str,
            _: &str,
            _: OverwriteKind,
            _: &[(u64, Option<bool>)],
            _: &str,
        ) -> Result<(), DiscordError> {
            Ok(())
        }
        async fn delete_permission_overwrite(&self, _: &str, _: &str, _: &str) -> Result<(), DiscordError> {
            Ok(())
        }
        async fn fetch_webhooks(&self, _: &str) -> Result<Vec<Webhook>, DiscordError> {
            Ok(Vec::new())
        }
        async fn create_webhook(&self, _: &str, _: NewWebhook) -> Result<CreatedWebhook, DiscordError> {
            Err(DiscordError::new(None, "no"))
        }
    }
    let t = test_app();
    let client = NoMove(world(Opts::default()));
    let lines = Mutex::new(Vec::new());
    let log = |line: &str| lines.lock().push(line.to_string());
    let out = discord_admin(
        &t.app,
        &json!({"action": "create_channel", "name": "late", "near_channel_id": GEN, "approved_by": GO}),
        DiscordAdminDeps {
            client: &client,
            vault: None,
            log: Some(&log),
        },
    )
    .await;
    assert_eq!(
        out,
        [
            "Made #late (text channel) in the server \"Acme Server\" (server id 200000000000000001).",
            "id: 500000000000000099",
            "who can see it: public: everyone in the server can see it, as the server's roles allow",
            "made, but it could not be moved next to #general (Discord refused: the bot is missing a permission it needs in #late in the server \"Acme Server\" (server id 200000000000000001) (Manage Channels and Manage Permissions (Manage Roles)). Discord said: \"Missing Permissions\". Ask the owner to give the bot's role that permission (Server Settings > Roles), or to do this by hand. Nothing more was changed.)",
            "link: https://discord.com/channels/200000000000000001/500000000000000099",
            "mention it in chat as <#500000000000000099>",
        ]
        .join("\n")
    );
    assert!(lines.lock()[0].ends_with("channel=#late (500000000000000099) ok"));
}

#[tokio::test]
async fn voice_channels_come_after_text_channels_whatever_their_position() {
    let t = test_app();
    let w = world(Opts::default());
    for c in w.channels.lock().iter_mut() {
        match c.id.as_str() {
            VOICE => c.position = Some(0),
            GEN => c.position = Some(3),
            _ => {}
        }
    }
    let ran = run(&t, &w, json!({"action": "list_channels"})).await;
    // Node's answer for the same server.
    assert_eq!(
        ran.out,
        [
            "Server \"Acme Server\" (server id 200000000000000001): 4 channels. The bot has: Manage Channels yes, Manage Permissions (Manage Roles) yes, Manage Webhooks yes.",
            "Not in a category:",
            "  #general (id 500000000000000003): text, position 3, public",
            "  Standup (id 500000000000000004): voice, position 0, public",
            "Category Clients (id 500000000000000001): category, position 0, private",
            "  #client-prod (id 500000000000000002): text, position 0, private",
        ]
        .join("\n")
    );
}
