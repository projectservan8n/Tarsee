// tarsee_discord_admin (src/lib/discord-admin.js): channels and webhooks done by Tarsee's own logged-in bot, so the
// agent never needs DISCORD_BOT_TOKEN in a command. Discord is never reached: the client is a stand-in (or a real
// discord.js Client that never logs in, with its REST calls stubbed), and the vault is a stand-in or a temporary one.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelType, Client, ClientUser, GatewayIntentBits, OverwriteType, PermissionFlagsBits as P } from "discord.js";

// Keep every module that reads config away from the real state dir, vault and DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-discord-admin-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.ENCRYPTION_KEY = "discord-admin-test-encryption-key-0123456789";
const { discordAdmin, resolveGuild, ACTIONS, permFlag, maskWebhookUrl, keyNameFrom } = await import("../src/lib/discord-admin.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "../src/lib/discord-admin.js"), "utf8");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const G = "200000000000000001", G2 = "200000000000000002";
const BOT = "300000000000000001", SAM = "300000000000000002", ALEX = "300000000000000003";
const OPS = "400000000000000001", MODS = "400000000000000002";
const CAT = "500000000000000001", PROD = "500000000000000002", GEN = "500000000000000003", VOICE = "500000000000000004";
const OTHER = "500000000000000009", NEW = "500000000000000099", HOOK = "600000000000000001", THREAD = "500000000000000050", DM = "500000000000000060";
const TOKEN = "wh-token-SECRET-0123456789abcdefWXYZ";
const GO = "Alex in #client-prod: make #client-alerts and a webhook for the watchdog";

const perms = (bits = [], admin = false) => ({ has: (b) => admin || bits.includes(b) });

/** A Discord the tool can talk to: one server (or two), its channels, roles and members, with every call recorded. */
function world({ botPerms = null, twoServers = false, createError = null, hookError = null } = {}) {
  const calls = [];
  const allChannels = new Map();
  const guild = { id: G, name: "Acme Server" };
  const everyone = { id: G, name: "@everyone" };
  guild.roles = { everyone, cache: new Map([[G, everyone], [OPS, { id: OPS, name: "Ops" }], [MODS, { id: MODS, name: "Mods" }]]) };
  const me = { id: BOT, permissions: botPerms ? perms(botPerms) : perms([], true) };
  const members = new Map([[BOT, me], [SAM, { id: SAM, displayName: "Sam", user: { username: "sam_k" } }], [ALEX, { id: ALEX, displayName: "Alex", user: { username: "alex" } }]]);
  guild.members = { me, cache: new Map([[BOT, me]]), fetch: async (id) => { const m = members.get(id); if (!m) throw Object.assign(new Error("Unknown Member"), { code: 10007 }); return m; } };
  const chans = new Map();
  const hooks = [{ id: "600000000000000005", name: "Old Hook", type: 1, token: "old-SECRET-token", url: "https://discord.com/api/webhooks/600000000000000005/old-SECRET-token", owner: { username: "alex" }, channelId: PROD }];

  function mk(g, { id, name, type, parentId = null, position = 0, overwrites = [], hidden = false, thread = false }) {
    const ch = {
      id, name, type, guild: g, parentId, position,
      get parent() { return allChannels.get(this.parentId) || null; },
      isThread: () => thread,
      permissionOverwrites: {
        cache: new Map(overwrites.map((o) => [o.id, { id: o.id, type: o.type, allow: { bitfield: o.allow ?? 0n }, deny: { bitfield: o.deny ?? 0n } }])),
        edit: async (target, set, opts) => { calls.push({ op: "overwrite.set", channel: id, target, set, opts }); },
        delete: async (target) => { calls.push({ op: "overwrite.clear", channel: id, target }); },
      },
      permissionsFor: (who) => (who === g.roles?.everyone ? perms(hidden ? [] : [P.ViewChannel]) : me.permissions),
      edit: async (opts) => { calls.push({ op: "channel.edit", channel: id, opts }); if (opts.name) ch.name = opts.name; return ch; },
      setPosition: async (pos) => { calls.push({ op: "channel.setPosition", channel: id, pos }); },
      fetchWebhooks: async () => new Map(hooks.filter((h) => h.channelId === id).map((h) => [h.id, h])),
      createWebhook: async ({ name: hookName, avatar, reason }) => {
        calls.push({ op: "webhook.create", channel: id, name: hookName, avatar, reason });
        if (hookError) throw hookError;
        return { id: HOOK, token: TOKEN, name: hookName, url: `https://discord.com/api/v10/webhooks/${HOOK}/${TOKEN}` };
      },
      delete: async () => { calls.push({ op: "DELETE channel", channel: id }); },
    };
    if (type === ChannelType.GuildCategory || thread) { delete ch.fetchWebhooks; delete ch.createWebhook; }
    allChannels.set(id, ch);
    if (g.channels) g.channels.cache.set(id, ch);
    return ch;
  }
  guild.channels = {
    cache: chans,
    create: async (opts) => {
      calls.push({ op: "channel.create", opts });
      if (createError) throw createError;
      return mk(guild, { id: NEW, name: opts.name, type: opts.type, parentId: opts.parent ?? null, position: 9 });
    },
    delete: async () => { calls.push({ op: "DELETE guild channel" }); },
  };
  mk(guild, { id: CAT, name: "Clients", type: ChannelType.GuildCategory, hidden: true, overwrites: [{ id: G, type: OverwriteType.Role, deny: P.ViewChannel }, { id: OPS, type: OverwriteType.Role, allow: P.ViewChannel }] });
  mk(guild, { id: PROD, name: "client-prod", type: ChannelType.GuildText, parentId: CAT, position: 0, hidden: true, overwrites: [{ id: G, type: OverwriteType.Role, deny: P.ViewChannel }, { id: MODS, type: OverwriteType.Role, allow: P.ViewChannel | P.SendMessages }] });
  mk(guild, { id: GEN, name: "general", type: ChannelType.GuildText, position: 0 });
  mk(guild, { id: VOICE, name: "Standup", type: ChannelType.GuildVoice, position: 1 });
  mk(guild, { id: THREAD, name: "deploy notes", type: ChannelType.PublicThread, parentId: PROD, thread: true });
  allChannels.set(DM, { id: DM, type: ChannelType.DM, guild: null, isThread: () => false });

  const guilds = new Map([[G, guild]]);
  if (twoServers) {
    const g2 = { id: G2, name: "Side Project" };
    const ev2 = { id: G2, name: "@everyone" };
    g2.roles = { everyone: ev2, cache: new Map([[G2, ev2]]) };
    g2.members = { me, cache: new Map([[BOT, me]]), fetch: async () => { throw new Error("Unknown Member"); } };
    g2.channels = { cache: new Map(), create: async () => { calls.push({ op: "channel.create (wrong server)" }); } };
    mk(g2, { id: OTHER, name: "lobby", type: ChannelType.GuildText });
    guilds.set(G2, g2);
  }
  const client = {
    user: { id: BOT, displayAvatarURL: () => "https://cdn.discordapp.com/avatars/bot.png" },
    isReady: () => true,
    guilds: { cache: guilds, fetch: async () => { throw Object.assign(new Error("Unknown Guild"), { code: 10004 }); } },
    channels: { cache: allChannels, fetch: async () => { throw Object.assign(new Error("Unknown Channel"), { code: 10003 }); } },
  };
  return { client, guild, calls, writes: () => calls.filter((c) => !c.op.startsWith("DELETE")) };
}

function fakeVault(existing = []) {
  const keys = new Map(existing.map((k) => [k, { value: "old-value", description: "old" }]));
  return { keys, hasKey: (k) => keys.has(k), setKey: (k, value, description) => { keys.set(k, { value, description }); return { name: k }; } };
}

/** Runs the tool with the log lines kept, so a test can check they carry no secret. */
async function run(w, args, vault = fakeVault()) {
  const lines = [];
  const out = await discordAdmin(args, { client: w.client, vault, log: (l) => lines.push(l) });
  return { out, lines, vault };
}

const overwriteFor = (list, id) => list.find((o) => o.id === id);
const has = (list, bit) => (Array.isArray(list) ? list.includes(bit) : (BigInt(list ?? 0) & bit) === bit);

describe("which server: guild_id, a channel in it, or the only one", () => {
  it("with one server and no ids, it is that server", async () => {
    const w = world();
    assert.equal((await resolveGuild(w.client, {})).id, G);
    const { out } = await run(w, { action: "list_channels" });
    assert.match(out, /^Server "Acme Server" \(server id 200000000000000001\)/);
  });

  it("a channel id (the one the agent is answering in, even a thread) picks its server when the bot is in two", async () => {
    const w = world({ twoServers: true });
    assert.equal((await resolveGuild(w.client, { channel_id: PROD })).id, G);
    assert.equal((await resolveGuild(w.client, { channel_id: THREAD })).id, G);
    assert.equal((await resolveGuild(w.client, { channel_id: `<#${OTHER}>` })).id, G2);
    assert.equal((await resolveGuild(w.client, { guild_id: G2, channel_id: PROD })).id, G2, "guild_id wins");
    assert.equal((await resolveGuild(w.client, { parent_id: CAT })).id, G, "a category id given for the new channel works too");
  });

  it("two servers and nothing to tell them apart: it asks, naming both, and does nothing", async () => {
    const w = world({ twoServers: true });
    const { out } = await run(w, { action: "create_channel", name: "x", approved_by: GO });
    assert.match(out, /error: The bot is in 2 servers, so say which: pass guild_id, or channel_id/);
    assert.match(out, /Acme Server \(200000000000000001\), Side Project \(200000000000000002\)/);
    assert.equal(w.calls.length, 0);
  });

  it("an unknown server, an unknown channel, a DM and a bad id each say so plainly", async () => {
    const w = world();
    assert.match((await run(w, { action: "list_channels", guild_id: "999999999999999999" })).out, /not in a server with id 999999999999999999\. Servers the bot is in: Acme Server/);
    assert.match((await run(w, { action: "list_channels", channel_id: "999999999999999998" })).out, /No channel with id 999999999999999998/);
    assert.match((await run(w, { action: "list_channels", channel_id: DM })).out, /is a direct message, not a channel in a server/);
    assert.match((await run(w, { action: "list_channels", channel_id: "general" })).out, /is not a Discord channel id/);
  });
});

describe("list_channels", () => {
  it("every channel with its id, type, category, position and whether it is private; threads left out", async () => {
    const w = world();
    const { out } = await run(w, { action: "list_channels", channel_id: PROD });
    const lines = out.split("\n");
    assert.match(lines[0], /4 channels\. The bot has: Manage Channels yes, Manage Permissions \(Manage Roles\) yes, Manage Webhooks yes\./);
    assert.ok(lines.includes("Not in a category:"));
    assert.ok(lines.includes(`  #general (id ${GEN}): text, position 0, public`), out);
    assert.ok(lines.includes(`  Standup (id ${VOICE}): voice, position 1, public`), out);
    assert.ok(lines.includes(`Category Clients (id ${CAT}): category, position 0, private`), out);
    assert.ok(lines.includes(`  #client-prod (id ${PROD}): text, position 0, private`), out);
    assert.ok(!out.includes(THREAD), "threads are not channels to manage here");
    assert.equal(w.calls.length, 0);
  });

  it("needs no go (approved_by)", async () => {
    const { out } = await run(world(), { action: "list_channels" });
    assert.doesNotMatch(out, /error/);
  });
});

describe("create_channel", () => {
  it("private: hidden from @everyone, and the bot, the listed users and roles let in", async () => {
    const w = world();
    const { out } = await run(w, { action: "create_channel", channel_id: PROD, name: "Client Alerts", parent_id: CAT, private: true, allow_user_ids: [SAM, `<@${ALEX}>`], allow_role_ids: [OPS], topic: "Watchdog alerts", approved_by: GO });
    const create = w.calls.find((c) => c.op === "channel.create");
    assert.ok(create, out);
    const o = create.opts;
    assert.equal(o.name, "client-alerts");
    assert.equal(o.type, ChannelType.GuildText);
    assert.equal(o.parent, CAT);
    assert.equal(o.topic, "Watchdog alerts");
    assert.match(o.reason, /Go from: Alex in #client-prod/);
    const ow = o.permissionOverwrites;
    assert.deepEqual(overwriteFor(ow, G), { id: G, type: OverwriteType.Role, deny: [P.ViewChannel] });
    for (const [id, type] of [[BOT, OverwriteType.Member], [SAM, OverwriteType.Member], [ALEX, OverwriteType.Member], [OPS, OverwriteType.Role]]) {
      const x = overwriteFor(ow, id);
      assert.ok(x, `overwrite for ${id}`);
      assert.equal(x.type, type);
      for (const bit of [P.ViewChannel, P.SendMessages, P.ReadMessageHistory]) assert.ok(has(x.allow, bit), `${id} may ${bit}`);
      assert.ok(!has(x.allow, P.Connect), "no voice permissions on a text channel");
    }
    assert.equal(ow.length, 5);
    assert.match(out, new RegExp(`^Made #client-alerts \\(text channel\\) in the server "Acme Server"`));
    assert.match(out, new RegExp(`id: ${NEW}`));
    assert.match(out, /who can see it: private: only the bot, Sam, Alex, @Ops, and anyone with Administrator, can see it/);
    assert.match(out, new RegExp(`link: https://discord.com/channels/${G}/${NEW}`));
    assert.match(out, new RegExp(`<#${NEW}>`));
  });

  it("a voice channel gets voice access, and only what the bot holds itself is handed out", async () => {
    const w = world({ botPerms: [P.ManageChannels, P.ViewChannel, P.Connect, P.SendMessages] });
    await run(w, { action: "create_channel", name: "War Room", type: "voice", private: true, allow_user_ids: [SAM], approved_by: GO });
    const ow = w.calls.find((c) => c.op === "channel.create").opts.permissionOverwrites;
    assert.equal(w.calls.find((c) => c.op === "channel.create").opts.type, ChannelType.GuildVoice);
    assert.deepEqual(overwriteFor(ow, SAM).allow, [P.ViewChannel, P.Connect, P.SendMessages]);
    assert.deepEqual(overwriteFor(ow, BOT).allow, [P.ViewChannel, P.Connect, P.SendMessages]);
  });

  it("a user who is not in the server, or a role that does not exist, stops it before anything is made", async () => {
    const w = world();
    assert.match((await run(w, { action: "create_channel", name: "x", private: true, allow_user_ids: ["399999999999999999"], approved_by: GO })).out, /user 399999999999999999 is not a member of the server "Acme Server".*Nothing was made/);
    assert.match((await run(w, { action: "create_channel", name: "x", private: true, allow_role_ids: ["499999999999999999"], approved_by: GO })).out, /no role with id 499999999999999999/);
    assert.match((await run(w, { action: "create_channel", name: "x", private: true, allow_role_ids: [G], approved_by: GO })).out, /that is @everyone/);
    assert.match((await run(w, { action: "create_channel", name: "x", allow_user_ids: [SAM], approved_by: GO })).out, /go with private: true/);
    assert.equal(w.calls.length, 0);
  });

  it("copy_permissions_from gives it exactly another channel's overwrites (the bot kept in when that one is hidden)", async () => {
    const w = world();
    const { out } = await run(w, { action: "create_channel", name: "client-alerts", copy_permissions_from: PROD, approved_by: GO });
    const ow = w.calls.find((c) => c.op === "channel.create").opts.permissionOverwrites;
    assert.deepEqual(overwriteFor(ow, G), { id: G, type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel });
    assert.deepEqual(overwriteFor(ow, MODS), { id: MODS, type: OverwriteType.Role, allow: P.ViewChannel | P.SendMessages, deny: 0n });
    assert.equal(overwriteFor(ow, BOT).type, OverwriteType.Member);
    assert.ok(has(overwriteFor(ow, BOT).allow, P.ViewChannel));
    assert.equal(ow.length, 3);
    assert.match(out, /who can see it: the same access as #client-prod \(copied\), which is private/);
  });

  it("copy and private together is refused; with neither, a channel in a category takes the category's access", async () => {
    const w = world();
    assert.match((await run(w, { action: "create_channel", name: "x", copy_permissions_from: PROD, private: true, approved_by: GO })).out, /Pick one: copy_permissions_from .* or private/);
    assert.equal(w.calls.length, 0);
    const { out } = await run(w, { action: "create_channel", name: "x", parent_id: CAT, approved_by: GO });
    const o = w.calls.find((c) => c.op === "channel.create").opts;
    assert.deepEqual(o.permissionOverwrites.map((x) => x.id).sort(), [G, OPS].sort());
    assert.match(out, /the same access as its category Clients \(synced\), which is private/);
  });

  it("outside any category with no privacy asked: no overwrites, public", async () => {
    const w = world();
    const { out } = await run(w, { action: "create_channel", name: "Lobby Chat", approved_by: GO });
    const o = w.calls.find((c) => c.op === "channel.create").opts;
    assert.equal(o.permissionOverwrites, undefined);
    assert.equal(o.parent, undefined);
    assert.equal(o.name, "lobby-chat");
    assert.match(out, /who can see it: public/);
  });

  it("near_channel_id puts it in that channel's category, right after it (or before)", async () => {
    const w = world();
    const { out } = await run(w, { action: "create_channel", name: "client-alerts", near_channel_id: PROD, approved_by: GO });
    assert.equal(w.calls.find((c) => c.op === "channel.create").opts.parent, CAT);
    assert.deepEqual(w.calls.find((c) => c.op === "channel.setPosition"), { op: "channel.setPosition", channel: NEW, pos: 1 });
    assert.match(out, /placed after #client-prod/);
    const w2 = world();
    await run(w2, { action: "create_channel", name: "x", near_channel_id: VOICE, place: "before", approved_by: GO });
    assert.equal(w2.calls.find((c) => c.op === "channel.setPosition").pos, 1);
  });

  it("bad input is refused before anything is made", async () => {
    const w = world();
    assert.match((await run(w, { action: "create_channel", approved_by: GO })).out, /name is required/);
    assert.match((await run(w, { action: "create_channel", name: "x", type: "forum", approved_by: GO })).out, /text, voice or category/);
    assert.match((await run(w, { action: "create_channel", name: "x", parent_id: GEN, approved_by: GO })).out, /is #general, not a category/);
    assert.match((await run(w, { action: "create_channel", name: "x", type: "voice", topic: "t", approved_by: GO })).out, /topic is only for text channels/);
    assert.match((await run(world({ twoServers: true }), { action: "create_channel", guild_id: G, name: "x", copy_permissions_from: OTHER, approved_by: GO })).out, /is not in the server "Acme Server"/);
    assert.equal(w.calls.length, 0);
  });
});

describe("approved_by: a change needs someone's go", () => {
  for (const action of ["create_channel", "edit_channel", "create_webhook"]) {
    it(`${action} without it does nothing and says to ask`, async () => {
      const w = world();
      const { out } = await run(w, { action, name: "x", channel_id: GEN, save_as_key: "X_HOOK" });
      assert.match(out, /needs approved_by: who gave the go.*If nobody has said go for this exact change, ask first\. Nothing was done\./);
      assert.equal(w.calls.length, 0);
    });
  }
});

describe("create_webhook: the URL goes to the vault, never into the result", () => {
  it("saves the full URL under save_as_key with which channel and why, and returns the id, the key and a masked URL", async () => {
    const w = world();
    const vault = fakeVault();
    const { out, lines } = await run(w, { action: "create_webhook", channel_id: GEN, name: "Uptime Watchdog", save_as_key: "UPTIME_WATCHDOG_WEBHOOK", purpose: "uptime watchdog alerts", approved_by: GO }, vault);
    const saved = vault.keys.get("UPTIME_WATCHDOG_WEBHOOK");
    assert.equal(saved.value, `https://discord.com/api/webhooks/${HOOK}/${TOKEN}`);
    assert.match(saved.description, /#general \(channel 500000000000000003\) in the server Acme Server/);
    assert.match(saved.description, /Purpose: uptime watchdog alerts\./);
    assert.ok(!out.includes(TOKEN), "the token is not in the result");
    assert.ok(!/webhooks\/\d+\/[A-Za-z0-9-]{8,}/.test(out), "no full URL in the result");
    assert.match(out, new RegExp(`webhook id: ${HOOK}`));
    assert.match(out, /URL saved in the vault as UPTIME_WATCHDOG_WEBHOOK \(masked: https:\/\/discord\.com\/api\/webhooks\/600000000000000001\/\*\*\*\*WXYZ\)/);
    assert.match(out, /never paste it into a chat/);
    for (const l of lines) assert.ok(!l.includes(TOKEN), `log line has no token: ${l}`);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[discord-admin\] create_webhook guild="Acme Server" \(200000000000000001\) channel=#general \(500000000000000003\) ok/);
    const made = w.calls.find((c) => c.op === "webhook.create");
    assert.equal(made.name, "Uptime Watchdog");
    assert.equal(made.avatar, undefined);
  });

  it("with no save_as_key it is still saved, under DISCORD_WEBHOOK_<CHANNEL>", async () => {
    const w = world();
    w.client.channels.cache.get(GEN).name = "client-alerts";
    const vault = fakeVault();
    const { out } = await run(w, { action: "create_webhook", channel_id: GEN, name: "Watchdog", approved_by: GO }, vault);
    assert.ok(vault.keys.has("DISCORD_WEBHOOK_CLIENT_ALERTS"), out);
    assert.match(out, /saved in the vault as DISCORD_WEBHOOK_CLIENT_ALERTS/);
    assert.ok(!out.includes(TOKEN));
  });

  it("a key that is already there is never replaced unless overwrite_key, and then no webhook is made either", async () => {
    const w = world();
    const vault = fakeVault(["UPTIME_WATCHDOG_WEBHOOK"]);
    const { out } = await run(w, { action: "create_webhook", channel_id: GEN, name: "Watchdog", save_as_key: "UPTIME_WATCHDOG_WEBHOOK", approved_by: GO }, vault);
    assert.match(out, /already has a key named UPTIME_WATCHDOG_WEBHOOK.*No webhook was made/);
    assert.equal(vault.keys.get("UPTIME_WATCHDOG_WEBHOOK").value, "old-value");
    assert.equal(w.calls.length, 0);
    await run(w, { action: "create_webhook", channel_id: GEN, name: "Watchdog", save_as_key: "uptime watchdog webhook", overwrite_key: true, approved_by: GO }, vault);
    assert.match(vault.keys.get("UPTIME_WATCHDOG_WEBHOOK").value, new RegExp(TOKEN));
  });

  it("reveal: true is the only way the full URL comes back (and it is still saved)", async () => {
    const vault = fakeVault();
    const { out } = await run(world(), { action: "create_webhook", channel_id: GEN, name: "Watchdog", save_as_key: "W_HOOK", reveal: true, use_bot_avatar: true, approved_by: GO }, vault);
    assert.ok(out.includes(`https://discord.com/api/webhooks/${HOOK}/${TOKEN}`));
    assert.match(out, /do not post it in chat/);
    assert.ok(vault.keys.has("W_HOOK"));
  });

  it("the bot's picture when asked; a thread, a category or a DM is refused", async () => {
    const w = world();
    await run(w, { action: "create_webhook", channel_id: GEN, name: "Watchdog", save_as_key: "W_HOOK", use_bot_avatar: true, approved_by: GO });
    assert.equal(w.calls.find((c) => c.op === "webhook.create").avatar, "https://cdn.discordapp.com/avatars/bot.png");
    const w2 = world();
    assert.match((await run(w2, { action: "create_webhook", channel_id: THREAD, name: "W", approved_by: GO })).out, /is a thread\. Webhooks belong to its parent channel #client-prod/);
    assert.match((await run(w2, { action: "create_webhook", channel_id: CAT, name: "W", approved_by: GO })).out, /category channel, which cannot have webhooks/);
    assert.match((await run(w2, { action: "create_webhook", channel_id: DM, name: "W", approved_by: GO })).out, /direct message/);
    assert.match((await run(w2, { action: "create_webhook", channel_id: GEN, name: "Discord Bot", approved_by: GO })).out, /does not allow "clyde" or "discord"/);
    assert.match((await run(w2, { action: "create_webhook", channel_id: GEN, name: "W", save_as_key: "!!!", approved_by: GO })).out, /not a usable key name/);
    assert.equal(w2.calls.length, 0);
  });

  it("a vault that cannot be written says the webhook exists, and still does not show the URL", async () => {
    const vault = { hasKey: () => false, setKey: () => { throw new Error("disk full"); } };
    const { out } = await run(world(), { action: "create_webhook", channel_id: GEN, name: "Watchdog", save_as_key: "W_HOOK", approved_by: GO }, vault);
    assert.match(out, /The webhook 600000000000000001 was made in #general, but saving its URL to the vault failed \(disk full\)\. The URL was not shown\./);
    assert.ok(!out.includes(TOKEN));
  });
});

describe("list_webhooks", () => {
  it("names and ids only: no token, no URL", async () => {
    const { out } = await run(world(), { action: "list_webhooks", channel_id: PROD });
    assert.match(out, /- Old Hook \(webhook id 600000000000000005\), incoming, made by alex/);
    assert.ok(!out.includes("old-SECRET-token"));
    assert.ok(!out.includes("/api/webhooks/"));
    assert.match((await run(world(), { action: "list_webhooks", channel_id: GEN })).out, /has no webhooks/);
  });
});

describe("edit_channel", () => {
  it("rename, topic and a move to a category in one edit", async () => {
    const w = world();
    const { out } = await run(w, { action: "edit_channel", channel_id: GEN, name: "Team Chat", topic: "Say hi", parent_id: CAT, sync_with_category: true, approved_by: GO });
    const e = w.calls.find((c) => c.op === "channel.edit");
    assert.equal(e.opts.name, "team-chat");
    assert.equal(e.opts.topic, "Say hi");
    assert.equal(e.opts.parent, CAT);
    assert.equal(e.opts.lockPermissions, true);
    assert.match(out, /- renamed from general to team-chat/);
    assert.match(out, /- moved to the category Clients/);
    assert.match(out, /- access synced with its category/);
  });

  it("parent_id none takes it out of its category", async () => {
    const w = world();
    await run(w, { action: "edit_channel", channel_id: PROD, parent_id: "none", approved_by: GO });
    assert.equal(w.calls.find((c) => c.op === "channel.edit").opts.parent, null);
  });

  it("permission overwrites for a user and a role: allow, deny, reset, and clear", async () => {
    const w = world();
    const { out } = await run(w, {
      action: "edit_channel", channel_id: PROD, approved_by: GO, permissions: [
        { target: SAM, allow: ["view", "SendMessages", "read_message_history"] },
        { target: `<@&${OPS}>`, deny: ["send"], reset: ["View Channel"] },
        { target: MODS, clear: true },
      ],
    });
    const sets = w.calls.filter((c) => c.op === "overwrite.set");
    assert.deepEqual(sets[0], { op: "overwrite.set", channel: PROD, target: SAM, set: { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, opts: sets[0].opts });
    assert.equal(sets[0].opts.type, OverwriteType.Member);
    assert.deepEqual(sets[1].set, { SendMessages: false, ViewChannel: null });
    assert.equal(sets[1].opts.type, OverwriteType.Role);
    assert.deepEqual(w.calls.find((c) => c.op === "overwrite.clear"), { op: "overwrite.clear", channel: PROD, target: MODS });
    assert.match(out, /- Sam: allowed View Channel, Send Messages, Read Message History/);
    assert.match(out, /- @Ops: denied Send Messages; reset View Channel to the default/);
    assert.match(out, /- removed the permission overwrite for @Mods/);
    assert.ok(!w.calls.some((c) => c.op === "channel.edit"), "no channel edit when only access changes");
  });

  it("private: true hides it from @everyone and keeps the bot and the listed people in", async () => {
    const w = world();
    await run(w, { action: "edit_channel", channel_id: GEN, private: true, allow_user_ids: [SAM], approved_by: GO });
    const sets = w.calls.filter((c) => c.op === "overwrite.set");
    assert.deepEqual(sets.find((s) => s.target === G).set, { ViewChannel: false });
    assert.equal(sets.find((s) => s.target === BOT).set.ViewChannel, true);
    assert.equal(sets.find((s) => s.target === SAM).set.ViewChannel, true);
  });

  it("denying @everyone the view by hand also keeps the bot in", async () => {
    const w = world();
    await run(w, { action: "edit_channel", channel_id: GEN, permissions: [{ target: "everyone", deny: ["view"] }], approved_by: GO });
    const sets = w.calls.filter((c) => c.op === "overwrite.set");
    assert.equal(sets.length, 2);
    assert.equal(sets.find((s) => s.target === BOT).set.ViewChannel, true);
  });

  it("unknown permissions, Administrator, unknown targets and empty edits are refused before anything changes", async () => {
    const w = world();
    assert.match((await run(w, { action: "edit_channel", channel_id: GEN, permissions: [{ target: SAM, allow: ["fly"] }], approved_by: GO })).out, /"fly" is not a Discord permission/);
    assert.match((await run(w, { action: "edit_channel", channel_id: GEN, permissions: [{ target: SAM, allow: ["Administrator"] }], approved_by: GO })).out, /Administrator is a server-wide role permission/);
    assert.match((await run(w, { action: "edit_channel", channel_id: GEN, permissions: [{ target: "399999999999999999", allow: ["view"] }], approved_by: GO })).out, /No role or member with id 399999999999999999/);
    assert.match((await run(w, { action: "edit_channel", channel_id: GEN, approved_by: GO })).out, /Nothing to change/);
    assert.match((await run(w, { action: "edit_channel", channel_id: THREAD, name: "x", approved_by: GO })).out, /is a thread/);
    assert.match((await run(w, { action: "edit_channel", approved_by: GO })).out, /channel_id is required/);
    assert.equal(w.calls.length, 0);
  });
});

describe("a permission the bot does not have: plain English, which one and where", () => {
  it("no Manage Channels: create_channel is refused before Discord is asked", async () => {
    const w = world({ botPerms: [P.ViewChannel, P.SendMessages, P.ManageWebhooks] });
    const { out, lines } = await run(w, { action: "create_channel", name: "client-alerts", approved_by: GO });
    assert.match(out, /^discord_admin create_channel error: the bot is missing the Manage Channels permission in the server "Acme Server" \(server id 200000000000000001\), so it cannot make channels\. Ask the owner to give the bot's role that permission/);
    assert.equal(w.calls.length, 0);
    assert.match(lines[0], /create_channel guild="Acme Server" .* failed: the bot is missing the Manage Channels/);
  });

  it("no Manage Webhooks: create_webhook is refused and nothing goes in the vault", async () => {
    const w = world({ botPerms: [P.ViewChannel, P.ManageChannels] });
    const vault = fakeVault();
    const { out } = await run(w, { action: "create_webhook", channel_id: GEN, name: "W", save_as_key: "W_HOOK", approved_by: GO }, vault);
    assert.match(out, /missing the Manage Webhooks permission in #general in the server "Acme Server"/);
    assert.equal(vault.keys.size, 0);
    assert.equal(w.calls.length, 0);
    assert.match((await run(w, { action: "list_webhooks", channel_id: GEN })).out, /missing the Manage Webhooks permission/);
  });

  it("no Manage Roles: access changes are refused", async () => {
    const w = world({ botPerms: [P.ViewChannel, P.ManageChannels] });
    const { out } = await run(w, { action: "edit_channel", channel_id: GEN, permissions: [{ target: SAM, allow: ["view"] }], approved_by: GO });
    assert.match(out, /missing the Manage Permissions \(Manage Roles\) permission in #general/);
    assert.equal(w.calls.length, 0);
  });

  it("when Discord itself says Missing Permissions (50013), the error names the permission and the server", async () => {
    const w = world({ createError: Object.assign(new Error("Missing Permissions"), { code: 50013, status: 403 }) });
    const { out } = await run(w, { action: "create_channel", name: "client-alerts", approved_by: GO });
    assert.match(out, /Discord refused: the bot is missing a permission it needs in the server "Acme Server" \(server id 200000000000000001\) \(Manage Channels\)\. Discord said: "Missing Permissions"\./);
    const w2 = world({ hookError: Object.assign(new Error("Missing Permissions"), { code: 50013 }) });
    assert.match((await run(w2, { action: "create_webhook", channel_id: GEN, name: "W", save_as_key: "W_HOOK", approved_by: GO })).out, /missing a permission it needs in #general in the server "Acme Server" .*\(Manage Webhooks\)/);
    const w3 = world({ hookError: Object.assign(new Error("Maximum number of webhooks reached (15)"), { code: 30007 }) });
    assert.match((await run(w3, { action: "create_webhook", channel_id: GEN, name: "W", save_as_key: "W_HOOK", approved_by: GO })).out, /already has the most webhooks Discord allows/);
  });
});

describe("unknown actions and no delete paths", () => {
  it("anything not in the list is refused, deletes by name included, and nothing is called", async () => {
    for (const action of ["delete_channel", "delete_webhook", "remove_channel", "purge", "", undefined, "LIST_CHANNELS"]) {
      const w = world();
      const { out } = await run(w, { action, channel_id: GEN, approved_by: GO });
      assert.match(out, /Unknown action/, String(action));
      assert.match(out, /never deletes anything: deleting a channel or a webhook is something the owner does by hand/);
      assert.equal(w.calls.length, 0, String(action));
    }
  });

  it("the actions are the five, none of them a delete", () => {
    assert.deepEqual([...ACTIONS], ["list_channels", "create_channel", "edit_channel", "create_webhook", "list_webhooks"]);
    for (const a of ACTIONS) assert.doesNotMatch(a, /delete|remove|purge|prune|kick|ban/);
  });

  it("the module never calls a delete, except clearing one permission overwrite", () => {
    const deletes = SRC.match(/\.\s*delete\s*\(/g) || [];
    const overwriteClears = SRC.match(/permissionOverwrites\.delete\(/g) || [];
    assert.equal(deletes.length, overwriteClears.length, "every .delete( is permissionOverwrites.delete(");
    assert.equal(overwriteClears.length, 1);
    assert.doesNotMatch(SRC, /deleteKey|bulkDelete|\.prune\(|\.kick\(|\.ban\(/);
  });

  it("every action run end to end leaves no delete behind", async () => {
    const w = world();
    await run(w, { action: "list_channels" });
    await run(w, { action: "create_channel", name: "a", private: true, approved_by: GO });
    await run(w, { action: "edit_channel", channel_id: GEN, name: "b", permissions: [{ target: SAM, allow: ["view"] }], approved_by: GO });
    await run(w, { action: "create_webhook", channel_id: GEN, name: "c", save_as_key: "C_HOOK", approved_by: GO });
    await run(w, { action: "list_webhooks", channel_id: GEN });
    assert.ok(w.calls.length >= 4);
    assert.ok(!w.calls.some((c) => c.op.startsWith("DELETE")));
  });

  it("not connected: nothing is done", async () => {
    const w = world();
    w.client.isReady = () => false;
    assert.match((await run(w, { action: "list_channels" })).out, /Discord is not connected right now/);
  });
});

describe("helpers and wording", () => {
  it("permission names in any case, with short aliases", () => {
    assert.equal(permFlag("ViewChannel"), P.ViewChannel);
    assert.equal(permFlag("view_channel"), P.ViewChannel);
    assert.equal(permFlag("View Channel"), P.ViewChannel);
    assert.equal(permFlag("view"), P.ViewChannel);
    assert.equal(permFlag("history"), P.ReadMessageHistory);
    assert.equal(permFlag("manage_webhooks"), P.ManageWebhooks);
    assert.equal(permFlag("nope"), null);
  });

  it("key names and masked URLs", () => {
    assert.equal(keyNameFrom("uptime watchdog-webhook"), "UPTIME_WATCHDOG_WEBHOOK");
    assert.equal(keyNameFrom("DISCORD_WEBHOOK_" + "x".repeat(100)).length, 64);
    assert.equal(maskWebhookUrl("1", "abcdefgh1234"), "https://discord.com/api/webhooks/1/****1234");
  });

  it("no em dash in anything a person reads", () => {
    assert.ok(!SRC.includes("\u2014"), "src/lib/discord-admin.js");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real discord.js Client (never logged in), with its REST calls stubbed: what would go to Discord.

function realClient({ botRolePerms = P.ManageChannels | P.ManageWebhooks | P.ViewChannel | P.SendMessages | P.ReadMessageHistory, refuse = null } = {}) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const sent = [];
  client.rest.request = async () => { throw new Error("no network in tests"); };
  client.rest.get = client.rest.delete = async (route) => { sent.push(["unexpected", route]); throw new Error("no network in tests"); };
  client.rest.post = async (route, opts) => {
    sent.push(["post", route, opts?.body]);
    if (refuse) throw refuse;
    if (route === `/guilds/${G}/channels`) return { id: NEW, guild_id: G, type: opts.body.type, name: opts.body.name, parent_id: opts.body.parent_id ?? null, position: 5, permission_overwrites: opts.body.permission_overwrites || [] };
    if (route.endsWith("/webhooks")) return { id: HOOK, token: TOKEN, type: 1, name: opts.body.name, channel_id: route.split("/")[2], guild_id: G };
    throw new Error(`unexpected route ${route}`);
  };
  client.rest.patch = async (route, opts) => { sent.push(["patch", route, opts?.body]); };
  client.rest.put = async (route, opts) => { sent.push(["put", route, opts?.body]); };
  client.user = new ClientUser(client, { id: BOT, username: "tarsee", discriminator: "0", bot: true, avatar: null });
  client.isReady = () => true;
  const role = (id, name, permissions, position) => ({ id, name, permissions: String(permissions), position, color: 0, hoist: false, managed: false, mentionable: false });
  const joined = new Date().toISOString();
  client.guilds._add({
    id: G, name: "Acme Server", owner_id: ALEX,
    roles: [role(G, "@everyone", P.ViewChannel | P.SendMessages, 0), role(OPS, "Ops", 0n, 1), role("400000000000000009", "Tarsee", botRolePerms, 2)],
    channels: [
      { id: CAT, type: ChannelType.GuildCategory, name: "Clients", position: 0, permission_overwrites: [] },
      { id: PROD, type: ChannelType.GuildText, name: "client-prod", parent_id: CAT, position: 0, permission_overwrites: [{ id: G, type: 0, allow: "0", deny: String(P.ViewChannel) }, { id: OPS, type: 0, allow: String(P.ViewChannel), deny: "0" }] },
    ],
    members: [
      { user: { id: BOT, username: "tarsee", bot: true }, roles: ["400000000000000009"], joined_at: joined },
      { user: { id: SAM, username: "sam_k" }, roles: [], joined_at: joined },
    ],
  });
  return { client, sent };
}

describe("with the real discord.js client (REST stubbed): what Discord would be sent", () => {
  it("a private channel goes up with @everyone denied and the bot, the user and the role allowed", async () => {
    const { client, sent } = realClient();
    const out = await discordAdmin({ action: "create_channel", channel_id: PROD, name: "client-alerts", near_channel_id: PROD, private: true, allow_user_ids: [SAM], allow_role_ids: [OPS], approved_by: GO }, { client, vault: fakeVault(), log: () => {} });
    assert.match(out, /^Made #client-alerts \(text channel\)/, out);
    const [verb, route, body] = sent[0];
    assert.equal(verb, "post");
    assert.equal(route, `/guilds/${G}/channels`);
    assert.equal(body.parent_id, CAT);
    const ow = Object.fromEntries(body.permission_overwrites.map((o) => [o.id, o]));
    assert.deepEqual(ow[G], { id: G, type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) });
    const access = String(P.ViewChannel | P.SendMessages | P.ReadMessageHistory);   // what the bot's role holds of the text set
    assert.deepEqual(ow[BOT], { id: BOT, type: OverwriteType.Member, allow: access, deny: "0" });
    assert.deepEqual(ow[SAM], { id: SAM, type: OverwriteType.Member, allow: access, deny: "0" });
    assert.deepEqual(ow[OPS], { id: OPS, type: OverwriteType.Role, allow: access, deny: "0" });
    // Then the positions of that category's channels, the new one right after #client-prod.
    assert.deepEqual(sent[1], ["patch", `/guilds/${G}/channels`, [{ id: PROD, position: 0 }, { id: NEW, position: 1 }]]);
    assert.ok(!sent.some(([v]) => v === "unexpected"));
  });

  it("a webhook: the URL lands in the vault and only the masked one in the result", async () => {
    const { client, sent } = realClient();
    const vault = fakeVault();
    const out = await discordAdmin({ action: "create_webhook", channel_id: PROD, name: "Uptime Watchdog", save_as_key: "UPTIME_WATCHDOG_WEBHOOK", approved_by: GO }, { client, vault, log: () => {} });
    assert.deepEqual(sent[0], ["post", `/channels/${PROD}/webhooks`, { name: "Uptime Watchdog", avatar: null }]);   // (discord.js sends null for no picture)
    assert.equal(vault.keys.get("UPTIME_WATCHDOG_WEBHOOK").value, `https://discord.com/api/webhooks/${HOOK}/${TOKEN}`);
    assert.ok(!out.includes(TOKEN));
  });

  it("the real permission math refuses what the bot's role lacks (Manage Roles for access changes)", async () => {
    const { client, sent } = realClient();
    const out = await discordAdmin({ action: "edit_channel", channel_id: PROD, permissions: [{ target: SAM, allow: ["view"] }], approved_by: GO }, { client, log: () => {} });
    assert.match(out, /missing the Manage Permissions \(Manage Roles\) permission in #client-prod in the server "Acme Server"/);
    assert.equal(sent.length, 0);
  });

  it("a refusal from Discord reads as plain English", async () => {
    const { client } = realClient({ refuse: Object.assign(new Error("Missing Permissions"), { code: 50013, status: 403 }) });
    const out = await discordAdmin({ action: "create_channel", channel_id: PROD, name: "x", copy_permissions_from: PROD, approved_by: GO }, { client, vault: fakeVault(), log: () => {} });
    assert.match(out, /Discord refused: the bot is missing a permission it needs in the server "Acme Server" \(server id 200000000000000001\) \(Manage Channels\)\./);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real vault (a temporary one), the tool switch, and the MCP server in front.

describe("the default vault is the real one (here a temporary one)", () => {
  it("create_webhook with no vault given saves through lib/key-vault.js setKey, encrypted at rest", async () => {
    const out = await discordAdmin({ action: "create_webhook", channel_id: GEN, name: "Watchdog", save_as_key: "TMP_TEST_WEBHOOK", purpose: "a test", approved_by: GO }, { client: world().client, log: () => {} });
    assert.match(out, /saved in the vault as TMP_TEST_WEBHOOK/, out);
    const { getKey, listKeys } = await import("../src/lib/key-vault.js");
    assert.equal(getKey("TMP_TEST_WEBHOOK"), `https://discord.com/api/webhooks/${HOOK}/${TOKEN}`);
    assert.match(listKeys().find((k) => k.name === "TMP_TEST_WEBHOOK").description, /#general .* Purpose: a test\./);
    const file = path.join(tmp, "data", "vault.json");
    assert.ok(fs.existsSync(file), "the temporary vault file");
    assert.ok(!fs.readFileSync(file, "utf8").includes(TOKEN), "the token is encrypted on disk");
  });
});

describe("tools.js: discord_admin goes to the running Discord bot", () => {
  it("hands the input to bot.admin and returns its text", async () => {
    const { executeTool } = await import("../src/lib/tools.js");
    let got = null;
    const ctx = { channelManager: { channels: new Map([["discord", { bot: { admin: async (a) => { got = a; return "admin says hi"; } } }]]) } };
    assert.equal(await executeTool("discord_admin", { action: "list_channels", channel_id: GEN }, ctx), "admin says hi");
    assert.deepEqual(got, { action: "list_channels", channel_id: GEN });
  });

  it("with no Discord running, it says so and changes nothing", async () => {
    const { executeTool } = await import("../src/lib/tools.js");
    assert.match(await executeTool("discord_admin", { action: "list_channels" }, { channelManager: { channels: new Map() } }), /Discord channel is not running.*Nothing was changed/);
  });
});

describe("the MCP server offers tarsee_discord_admin and runs it through the tool switch", () => {
  it("lists the tool with its five actions and the right words, and a call reaches the running bot as discord_admin", async () => {
    const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
    const got = [];
    const ctx = { channelManager: { channels: new Map([["discord", { bot: { admin: async (a) => { got.push(a); return "admin ran"; } } }]]) } };
    const server = createTarseeMcp(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new McpClient({ name: "test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.instance.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      const { tools } = await mcp.listTools();
      const tool = tools.find((t) => t.name === "tarsee_discord_admin");
      assert.ok(tool, "tarsee_discord_admin is offered");
      assert.deepEqual(tool.inputSchema.properties.action.enum, [...ACTIONS]);
      assert.ok(tool.inputSchema.required?.includes("action"));
      const words = tool.description + JSON.stringify(tool.inputSchema);
      assert.ok(!words.includes("\u2014"), "no em dash in what the agent reads");
      assert.match(tool.description, /the owner/, "owner-neutral wording");
      assert.match(tool.description, /never pull DISCORD_BOT_TOKEN/);
      assert.match(tool.description, /approval rules in your instructions/);
      assert.match(tool.description, /create_webhook needs the owner's go/);
      assert.match(tool.description, /approved_by/);
      assert.match(tool.description, /never for anything that goes into a chat/);
      assert.match(tool.description, /NOTHING HERE DELETES/);
      const res = await mcp.callTool({ name: "tarsee_discord_admin", arguments: { action: "list_channels", channel_id: GEN } });
      assert.equal(res.content[0].text, "admin ran");
      assert.deepEqual(got.at(-1), { action: "list_channels", channel_id: GEN });
      const bad = await mcp.callTool({ name: "tarsee_discord_admin", arguments: { action: "delete_channel", channel_id: GEN } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
      assert.ok(bad.isError, "a delete action does not pass the schema");
      assert.equal(got.length, 1, "and never reaches the bot");
    } finally {
      await mcp.close();
    }
  });
});

describe("the agent is told: tool list, default workspace files, redaction", () => {
  it("the turn's tool list names it, and a new workspace's AGENTS.md and TOOLS.md carry the rules", () => {
    const provider = fs.readFileSync(path.join(here, "../src/ai/providers/claude-code.js"), "utf8");
    assert.match(provider, /\*\*discord_admin\*\*\(action, \.\.\.\)/);
    for (const file of ["../src/workspace-defaults/TOOLS.md", "../src/config/env.js"]) {
      const text = fs.readFileSync(path.join(here, file), "utf8");
      assert.match(text, /## Discord admin \(channels, webhooks\)/, file);
      assert.match(text, /never pull DISCORD_BOT_TOKEN from the vault/, file);
    }
    for (const file of ["../src/workspace-defaults/AGENTS.md", "../src/config/env.js"]) {
      const text = fs.readFileSync(path.join(here, file), "utf8");
      assert.match(text, /## Approvals/, file);
      assert.match(text, /## Keys: check the vault every time/, file);
    }
  });

  it("a webhook URL in a log line or the tool timeline keeps its id and loses its token", async () => {
    const { redactSecrets } = await import("../src/lib/redact.js");
    assert.equal(redactSecrets(`saved https://discord.com/api/webhooks/${HOOK}/${TOKEN}`), `saved https://discord.com/api/webhooks/${HOOK}/[REDACTED]`);
  });
});
