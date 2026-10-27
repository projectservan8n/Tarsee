/**
 * Discord server admin for the agent (tarsee_discord_admin): list, make and edit
 * channels, and make webhooks, done by Tarsee's own logged-in discord.js client
 * (src/channels/discord.js `admin`). The agent never handles the bot token:
 * without this tool it would pull DISCORD_BOT_TOKEN from the vault and call
 * Discord's REST API from Bash, which Claude Code's auto mode rightly blocks as
 * a credential leak, and which writes the token into the session transcript.
 *
 * Nothing here deletes: no channel, webhook or role is ever removed (clearing
 * one permission overwrite on a channel is the only removal). Deleting stays a
 * thing the owner does by hand.
 *
 * A webhook URL is a secret (anyone with it can post as the webhook): it goes
 * into the vault under a key name and the result shows only a masked form,
 * unless `reveal: true` is passed.
 *
 * Every call returns a plain-English string (never throws) and logs one line:
 * the action, the server, the channel, never a secret.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";

export const ACTIONS = Object.freeze(["list_channels", "create_channel", "edit_channel", "create_webhook", "list_webhooks"]);
const WRITES = new Set(["create_channel", "edit_channel", "create_webhook"]);

const P = PermissionFlagsBits;
const SNOWFLAKE = /^\d{15,25}$/;
const KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

const TYPE_OF = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory };
const TYPE_NAME = new Map([
  [ChannelType.GuildText, "text"], [ChannelType.GuildVoice, "voice"], [ChannelType.GuildCategory, "category"],
  [ChannelType.GuildAnnouncement, "announcement"], [ChannelType.GuildStageVoice, "stage"],
  [ChannelType.GuildForum, "forum"], [ChannelType.GuildMedia, "media"],
]);
const VOICE_LIKE = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

// What people let into a private channel (and the bot itself) may do there, by channel type.
const TEXT_ACCESS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.AddReactions];
const VOICE_ACCESS = [P.ViewChannel, P.Connect, P.Speak, P.SendMessages, P.ReadMessageHistory];
const ACCESS = {
  [ChannelType.GuildText]: TEXT_ACCESS,
  [ChannelType.GuildVoice]: VOICE_ACCESS,
  [ChannelType.GuildCategory]: [...new Set([...TEXT_ACCESS, ...VOICE_ACCESS])],
};

const FLAG_NAME = new Map(Object.entries(P).map(([name, bit]) => [bit, name]));
const PERM_LOOKUP = new Map(Object.keys(P).map((name) => [name.toLowerCase(), P[name]]));
const PERM_ALIASES = {
  view: "ViewChannel", see: "ViewChannel", send: "SendMessages", write: "SendMessages", history: "ReadMessageHistory",
  readhistory: "ReadMessageHistory", react: "AddReactions", reactions: "AddReactions", attach: "AttachFiles",
  files: "AttachFiles", embed: "EmbedLinks", embeds: "EmbedLinks", links: "EmbedLinks", managechannel: "ManageChannels",
  managepermissions: "ManageRoles", threads: "SendMessagesInThreads", mentioneveryone: "MentionEveryone",
};

/** "ManageChannels" as Discord's settings show it: "Manage Channels". */
export function permLabel(bit) {
  if (bit === P.ManageRoles) return "Manage Permissions (Manage Roles)";
  return (FLAG_NAME.get(bit) || String(bit)).replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** A permission by its Discord name in any case ("ViewChannel", "view_channel", "View Channel") or a short alias ("view", "send"). */
export function permFlag(name) {
  const key = String(name ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (!key) return null;
  if (PERM_ALIASES[key]) return P[PERM_ALIASES[key]];
  return PERM_LOOKUP.get(key) ?? null;
}

/** A webhook URL with its token hidden: the id stays, so a person can tell which webhook it is. */
export function maskWebhookUrl(id, token) {
  return `https://discord.com/api/webhooks/${id}/****${String(token || "").slice(-4)}`;
}

/** The same key name the vault would want from a free-form one: "uptime watchdog webhook" becomes UPTIME_WATCHDOG_WEBHOOK. */
export function keyNameFrom(raw) {
  return String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "K_$1").slice(0, 64).replace(/_+$/, "");
}

class AdminError extends Error {}
const fail = (msg) => { throw new AdminError(msg); };

/**
 * @param {object} args the tool's input (see the tarsee_discord_admin schema in src/ai/tarsee-mcp.js)
 * @param {object} deps
 * @param {import("discord.js").Client} deps.client the logged-in client
 * @param {{ hasKey: Function, setKey: Function }} [deps.vault] defaults to lib/key-vault.js
 * @param {Function} [deps.log] one line per action (console.log)
 * @returns {Promise<string>}
 */
export async function discordAdmin(args = {}, { client, vault = null, log = (line) => console.log(line) } = {}) {
  const action = String(args?.action ?? "");
  const note = { guild: null, channel: null, handsOut: [] };
  const logLine = (outcome) => {
    const g = note.guild ? `"${note.guild.name}" (${note.guild.id})` : "-";
    const c = note.channel ? `#${note.channel.name} (${note.channel.id})` : "-";
    try { log(`[discord-admin] ${action || "(no action)"} guild=${g} channel=${c} ${outcome}`); } catch { /* logging never fails a call */ }
  };
  try {
    if (!ACTIONS.includes(action)) {
      fail(`Unknown action "${action}". This tool does: ${ACTIONS.join(", ")}. It never deletes anything: deleting a channel or a webhook is something the owner does by hand in Discord.`);
    }
    if (!client?.user || (typeof client.isReady === "function" && !client.isReady())) {
      fail("Discord is not connected right now, so nothing was done. Try again in a minute.");
    }
    if (WRITES.has(action) && !String(args.approved_by ?? "").trim()) {
      fail(`${action} changes a Discord server, so it needs approved_by: who gave the go and for what, e.g. "the owner in #general: make #alerts and a webhook". If nobody has said go for this exact change, ask first. Nothing was done.`);
    }
    const run = { list_channels: listChannels, create_channel: createChannel, edit_channel: editChannel, create_webhook: createWebhook, list_webhooks: listWebhooks }[action];
    const out = await run(args, { client, vault, note });
    logLine("ok");
    return out;
  } catch (err) {
    const text = err instanceof AdminError ? err.message : discordErrorText(err, action, note);
    logLine(`failed: ${oneLine(text).slice(0, 200)}`);
    return `discord_admin ${action || ""} error: ${text}`.replace(/ {2}/g, " ");
  }
}

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();
const reasonOf = (args) => `Done by the Tarsee agent. Go from: ${oneLine(args.approved_by)}`.slice(0, 500);
const guildLabel = (g) => `"${g.name}" (server id ${g.id})`;
const where = (note) => note.channel ? `#${note.channel.name} in the server ${guildLabel(note.guild)}` : note.guild ? `the server ${guildLabel(note.guild)}` : "that server";

/** What a refusal from Discord means, in plain words. */
function discordErrorText(err, action, note) {
  const code = Number(err?.code);
  const need = {
    create_channel: [P.ManageChannels], edit_channel: [P.ManageChannels, P.ManageRoles],
    create_webhook: [P.ManageWebhooks], list_webhooks: [P.ManageWebhooks], list_channels: [P.ViewChannel],
  }[action] || [];
  if (code === 50013) {
    // Discord also refuses access that hands out a permission the bot does not have itself.
    const beyond = note.guild && note.handsOut?.length ? missingPerms(note.guild, null, note.handsOut) : [];
    const also = beyond.length ? ` The access being set also hands out ${beyond.map(permLabel).join(", ")}, which the bot's role does not have, and Discord only lets a bot hand out permissions it has itself.` : "";
    return `Discord refused: the bot is missing a permission it needs in ${where(note)} (${need.map(permLabel).join(" and ") || "see Discord's message"}).${also} Discord said: "${err.message}". Ask the owner to give the bot's role that permission (Server Settings > Roles), or to do this by hand. Nothing more was changed.`;
  }
  if (code === 50001) return `Discord refused: the bot cannot see ${where(note)} (Missing Access). Discord said: "${err.message}".`;
  if (code === 10003) return `Discord says there is no such channel (or the bot cannot see it). Check the channel id.`;
  if (code === 10004) return `Discord says the bot is not in that server. Check the guild id.`;
  if (code === 30007) return `That channel already has the most webhooks Discord allows (15). Reuse one (list_webhooks shows them) or ask the owner to remove an old one.`;
  if (code === 30013) return `The server already has the most channels Discord allows (500).`;
  if (code === 50035) return `Discord did not accept the values: "${err.message}".`;
  return `Discord said: "${err?.message || String(err)}"${code ? ` (code ${code})` : ""}.`;
}

/** The bot's own permissions it lacks in a channel (or the whole server), from what the client knows; Discord still has the last word. */
function missingPerms(guild, channel, bits) {
  const me = guild.members?.me;
  if (!me) return [];
  const perms = channel ? channel.permissionsFor?.(me) : me.permissions;
  if (!perms?.has) return [];
  return bits.filter((b) => !perms.has(b));
}

function requirePerms(guild, channel, bits, what) {
  const lack = missingPerms(guild, channel, bits);
  if (lack.length) {
    const place = channel ? `#${channel.name} in the server ${guildLabel(guild)}` : `the server ${guildLabel(guild)}`;
    fail(`the bot is missing the ${lack.map(permLabel).join(" and ")} permission in ${place}, so it cannot ${what}. Ask the owner to give the bot's role that permission (Server Settings > Roles), or to do it by hand. Nothing was changed.`);
  }
}

async function fetchChannel(client, id, label = "channel_id") {
  const want = String(id ?? "").replace(/^<#|>$/g, "").trim();
  if (!SNOWFLAKE.test(want)) fail(`${label} "${id}" is not a Discord channel id (a long number; the channel mention <#123...> works too).`);
  const ch = client.channels.cache.get(want) ?? await client.channels.fetch(want).catch(() => null);
  if (!ch) fail(`No channel with id ${want} that the bot can see (${label}).`);
  return ch;
}

/**
 * The server: guild_id, else the server of the first channel id given (channel_id, e.g. the one you are answering in,
 * then parent_id, near_channel_id, copy_permissions_from), else the only server the bot is in.
 */
export async function resolveGuild(client, args = {}) {
  if (args.guild_id) {
    const id = String(args.guild_id).trim();
    if (!SNOWFLAKE.test(id)) fail(`guild_id "${args.guild_id}" is not a Discord server id.`);
    const g = client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null);
    if (!g) fail(`The bot is not in a server with id ${id}. ${serversList(client)}`);
    return g;
  }
  for (const field of ["channel_id", "parent_id", "near_channel_id", "copy_permissions_from"]) {
    const v = args[field];
    if (!v || v === "none") continue;
    const ch = await fetchChannel(client, v, field);
    if (!ch.guild) fail(`${field} ${ch.id} is a direct message, not a channel in a server.`);
    return ch.guild;
  }
  const all = [...client.guilds.cache.values()];
  if (all.length === 1) return all[0];
  if (!all.length) fail("The bot is not in any Discord server.");
  fail(`The bot is in ${all.length} servers, so say which: pass guild_id, or channel_id of any channel in it (the one you are answering in works). ${serversList(client)}`);
}

function serversList(client) {
  const all = [...client.guilds.cache.values()];
  return all.length ? `Servers the bot is in: ${all.map((g) => `${g.name} (${g.id})`).join(", ")}.` : "";
}

const typeName = (ch) => TYPE_NAME.get(ch.type) || `type ${ch.type}`;
const everyoneOf = (guild) => guild.roles.everyone;
function isPrivate(ch) {
  try { return !ch.permissionsFor(everyoneOf(ch.guild)).has(P.ViewChannel); } catch { return false; }
}
const jumpLink = (guild, ch) => `https://discord.com/channels/${guild.id}/${ch.id}`;
function sameGuild(guild, ch, field) {
  if (ch.guild?.id !== guild.id) fail(`${field} ${ch.id} is not in the server ${guildLabel(guild)}.`);
}

// ---------------------------------------------------------------- list_channels

async function listChannels(args, { client, note }) {
  const guild = await resolveGuild(client, args);
  note.guild = guild;
  const chans = [...guild.channels.cache.values()].filter((c) => !c.isThread?.());
  const byPos = (a, b) => (VOICE_LIKE.has(a.type) - VOICE_LIKE.has(b.type)) || (a.position ?? 0) - (b.position ?? 0);
  const me = guild.members?.me;
  const line = (c, indent) => {
    const bits = [typeName(c), `position ${c.position ?? 0}`, isPrivate(c) ? "private" : "public"];
    if (me && c.permissionsFor && !c.permissionsFor(me)?.has?.(P.ViewChannel)) bits.push("the bot cannot see it");
    return `${indent}${c.type === ChannelType.GuildCategory ? "Category " : VOICE_LIKE.has(c.type) ? "" : "#"}${c.name} (id ${c.id}): ${bits.join(", ")}`;
  };
  const cats = chans.filter((c) => c.type === ChannelType.GuildCategory).sort(byPos);
  const top = chans.filter((c) => c.type !== ChannelType.GuildCategory && !c.parentId).sort(byPos);
  const can = [P.ManageChannels, P.ManageRoles, P.ManageWebhooks].map((b) => `${permLabel(b)} ${missingPerms(guild, null, [b]).length ? "no" : "yes"}`);
  const out = [`Server ${guildLabel(guild)}: ${chans.length} channels. The bot has: ${can.join(", ")}.`];
  if (top.length) out.push("Not in a category:", ...top.map((c) => line(c, "  ")));
  for (const cat of cats) {
    out.push(line(cat, ""));
    const kids = chans.filter((c) => c.parentId === cat.id).sort(byPos);
    out.push(...(kids.length ? kids.map((c) => line(c, "  ")) : ["  (empty)"]));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- create_channel

function cleanName(raw, type) {
  let name = String(raw ?? "").trim().replace(/^#/, "");
  if (type === ChannelType.GuildText) name = name.toLowerCase().replace(/\s+/g, "-");
  if (!name) fail("name is required: the new channel's name, e.g. alerts.");
  if (name.length > 100) fail("name is too long: Discord allows 100 characters.");
  return name;
}

async function memberOf(guild, id) {
  return guild.members.cache.get(id) ?? await guild.members.fetch(id).catch(() => null);
}

/** Overwrites for a private channel: hidden from @everyone; the bot, the users and the roles listed may see it and use it. */
async function privateOverwrites(guild, client, type, userIds = [], roleIds = []) {
  const want = ACCESS[type] || TEXT_ACCESS;
  // Only what the bot has itself (Discord refuses to hand out more).
  const grant = want.filter((b) => !missingPerms(guild, null, [b]).length);
  const overwrites = [{ id: everyoneOf(guild).id, type: OverwriteType.Role, deny: [P.ViewChannel] }];
  overwrites.push({ id: client.user.id, type: OverwriteType.Member, allow: grant });
  const users = [], roles = [];
  for (const raw of userIds) {
    const id = String(raw).replace(/^<@!?|>$/g, "").trim();
    if (!SNOWFLAKE.test(id)) fail(`allow_user_ids: "${raw}" is not a Discord user id.`);
    if (id === client.user.id) continue;
    const m = await memberOf(guild, id);
    if (!m) fail(`allow_user_ids: user ${id} is not a member of the server ${guildLabel(guild)}. Nothing was made.`);
    overwrites.push({ id, type: OverwriteType.Member, allow: grant });
    users.push(m.displayName || m.user?.username || id);
  }
  for (const raw of roleIds) {
    const id = String(raw).replace(/^<@&|>$/g, "").trim();
    if (!SNOWFLAKE.test(id)) fail(`allow_role_ids: "${raw}" is not a Discord role id.`);
    const r = guild.roles.cache.get(id);
    if (!r) fail(`allow_role_ids: there is no role with id ${id} in the server ${guildLabel(guild)}. Nothing was made.`);
    if (id === everyoneOf(guild).id) fail("allow_role_ids: that is @everyone, which would make the channel public. Leave private off instead.");
    overwrites.push({ id, type: OverwriteType.Role, allow: grant });
    roles.push(`@${r.name}`);
  }
  const who = ["the bot", ...users, ...roles].join(", ");
  return { overwrites, privacy: `private: only ${who}, and anyone with Administrator, can see it` };
}

function copyOverwrites(source) {
  return [...source.permissionOverwrites.cache.values()].map((o) => ({
    id: o.id, type: o.type, allow: o.allow?.bitfield ?? 0n, deny: o.deny?.bitfield ?? 0n,
  }));
}

/** The bot keeps access when the overwrites would hide the channel from @everyone. */
function keepBotAccess(guild, client, overwrites, type) {
  const everyoneDenies = overwrites.some((o) => o.id === everyoneOf(guild).id && (BigInt(bitsOf(o.deny)) & P.ViewChannel));
  if (!everyoneDenies || overwrites.some((o) => o.id === client.user.id)) return overwrites;
  const grant = (ACCESS[type] || TEXT_ACCESS).filter((b) => !missingPerms(guild, null, [b]).length);
  return [...overwrites, { id: client.user.id, type: OverwriteType.Member, allow: grant }];
}

/** Each single permission in an overwrite list's allow and deny. */
function handedOut(overwrites = []) {
  const all = overwrites.reduce((acc, o) => acc | bitsOf(o.allow) | bitsOf(o.deny), 0n);
  return [...FLAG_NAME.keys()].filter((b) => all & b);
}

function bitsOf(v) {
  if (Array.isArray(v)) return v.reduce((a, b) => a | BigInt(b), 0n);
  if (v == null) return 0n;
  return BigInt(v);
}

async function createChannel(args, { client, note }) {
  const guild = await resolveGuild(client, args);
  note.guild = guild;
  const typeKey = String(args.type || "text").toLowerCase();
  const type = TYPE_OF[typeKey];
  if (type == null) fail(`type "${args.type}" is not one this tool makes: text, voice or category.`);
  const name = cleanName(args.name, type);

  let parent = null;
  if (args.parent_id && args.parent_id !== "none") {
    if (type === ChannelType.GuildCategory) fail("A category cannot go inside another category: leave parent_id out.");
    parent = await fetchChannel(client, args.parent_id, "parent_id");
    sameGuild(guild, parent, "parent_id");
    if (parent.type !== ChannelType.GuildCategory) fail(`parent_id ${parent.id} is #${parent.name}, not a category.`);
  }
  let near = null;
  if (args.near_channel_id) {
    near = await fetchChannel(client, args.near_channel_id, "near_channel_id");
    sameGuild(guild, near, "near_channel_id");
    if (!parent && type !== ChannelType.GuildCategory) {
      if (near.type === ChannelType.GuildCategory) { parent = near; near = null; }
      else if (near.parent) parent = near.parent;
    }
  }
  if (args.topic && type !== ChannelType.GuildText) fail("topic is only for text channels.");

  const userIds = Array.isArray(args.allow_user_ids) ? args.allow_user_ids : [];
  const roleIds = Array.isArray(args.allow_role_ids) ? args.allow_role_ids : [];
  if (args.copy_permissions_from && args.private) fail("Pick one: copy_permissions_from (the same access as another channel) or private (only the people you list). Nothing was made.");
  if ((userIds.length || roleIds.length) && !args.private) fail("allow_user_ids and allow_role_ids go with private: true. Nothing was made.");

  requirePerms(guild, parent, [P.ManageChannels], "make channels");

  let overwrites, privacy;
  if (args.copy_permissions_from) {
    const src = await fetchChannel(client, args.copy_permissions_from, "copy_permissions_from");
    sameGuild(guild, src, "copy_permissions_from");
    overwrites = keepBotAccess(guild, client, copyOverwrites(src), type);
    privacy = `the same access as #${src.name} (copied)${isPrivate(src) ? ", which is private" : ""}`;
  } else if (args.private) {
    ({ overwrites, privacy } = await privateOverwrites(guild, client, type, userIds, roleIds));
  } else if (parent) {
    overwrites = copyOverwrites(parent);
    privacy = `the same access as its category ${parent.name} (synced)${isPrivate(parent) ? ", which is private" : ""}`;
  } else {
    overwrites = undefined;
    privacy = "public: everyone in the server can see it, as the server's roles allow";
  }

  note.handsOut = handedOut(overwrites);
  const created = await guild.channels.create({
    name, type,
    parent: parent?.id,
    topic: args.topic ? String(args.topic).slice(0, 1024) : undefined,
    permissionOverwrites: overwrites,
    reason: reasonOf(args),
  });
  note.channel = created;

  const extras = [];
  if (near) {
    const after = String(args.place || "after").toLowerCase() !== "before";
    try {
      await created.setPosition(Math.max(0, (near.position ?? 0) + (after ? 1 : 0)), { reason: reasonOf(args) });
      extras.push(`placed ${after ? "after" : "before"} #${near.name}`);
    } catch (err) {
      extras.push(`made, but it could not be moved next to #${near.name} (${discordErrorText(err, "edit_channel", note)})`);
    }
  }
  const label = type === ChannelType.GuildCategory ? `the category ${created.name}` : `${type === ChannelType.GuildText ? "#" : ""}${created.name} (${typeKey} channel)`;
  return [
    `Made ${label} in the server ${guildLabel(guild)}.`,
    `id: ${created.id}`,
    parent ? `category: ${parent.name} (id ${parent.id})` : null,
    `who can see it: ${privacy}`,
    ...extras,
    `link: ${jumpLink(guild, created)}`,
    type === ChannelType.GuildCategory ? null : `mention it in chat as <#${created.id}>`,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- edit_channel

async function targetOf(guild, raw, rawType) {
  const t = String(raw ?? "").trim();
  if (/^@?everyone$/i.test(t)) return { id: everyoneOf(guild).id, type: OverwriteType.Role, label: "@everyone" };
  const id = t.replace(/^<@[!&]?|>$/g, "");
  if (!SNOWFLAKE.test(id)) fail(`permissions target "${raw}" is not a user id, a role id or "everyone".`);
  const kind = String(rawType || "").toLowerCase();
  if (kind !== "user" && guild.roles.cache.get(id)) {
    const r = guild.roles.cache.get(id);
    return { id, type: OverwriteType.Role, label: id === everyoneOf(guild).id ? "@everyone" : `@${r.name}` };
  }
  if (kind === "role") fail(`There is no role with id ${id} in the server ${guildLabel(guild)}.`);
  const m = await memberOf(guild, id);
  if (!m) fail(`No role or member with id ${id} in the server ${guildLabel(guild)}.`);
  return { id, type: OverwriteType.Member, label: m.displayName || m.user?.username || id };
}

function flagsFrom(list, field) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const bit = permFlag(raw);
    if (bit == null) fail(`${field}: "${raw}" is not a Discord permission. Use names like ViewChannel, SendMessages, ReadMessageHistory, ManageMessages, Connect, Speak (or view, send, history).`);
    if (bit === P.Administrator) fail(`${field}: Administrator is a server-wide role permission, not one a channel can set.`);
    out.push(bit);
  }
  return out;
}

async function editChannel(args, { client, note }) {
  if (!args.channel_id) fail("channel_id is required: the channel to edit.");
  const ch = await fetchChannel(client, args.channel_id);
  if (!ch.guild) fail(`channel ${ch.id} is a direct message, not a server channel.`);
  if (ch.isThread?.()) fail(`${ch.id} is a thread. This edits channels and categories; edit its parent #${ch.parent?.name || ch.parentId} instead.`);
  const guild = ch.guild;
  note.guild = guild; note.channel = ch;
  if (args.guild_id && String(args.guild_id) !== guild.id) fail(`channel ${ch.id} is not in the server ${args.guild_id}.`);

  const changes = [];
  const edit = { reason: reasonOf(args) };
  if (args.name != null && args.name !== "") { edit.name = cleanName(args.name, ch.type); changes.push(`renamed to ${edit.name}`); }
  if (args.topic != null) {
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) fail("topic is only for text channels.");
    edit.topic = String(args.topic).slice(0, 1024);
    changes.push(edit.topic ? "topic set" : "topic cleared");
  }
  if (args.parent_id) {
    if (ch.type === ChannelType.GuildCategory) fail("A category cannot go inside another category.");
    if (args.parent_id === "none") { edit.parent = null; changes.push("taken out of its category"); }
    else {
      const parent = await fetchChannel(client, args.parent_id, "parent_id");
      sameGuild(guild, parent, "parent_id");
      if (parent.type !== ChannelType.GuildCategory) fail(`parent_id ${parent.id} is #${parent.name}, not a category.`);
      edit.parent = parent.id;
      changes.push(`moved to the category ${parent.name}`);
    }
  }
  if (args.sync_with_category) {
    if (!ch.parentId && !edit.parent) fail("sync_with_category needs the channel to be in a category.");
    edit.lockPermissions = true;
    changes.push("access synced with its category");
  }

  // Permission overwrites: each entry sets (allow / deny), resets to the default (reset) or removes (clear) one.
  const perms = [];
  for (const p of Array.isArray(args.permissions) ? args.permissions : []) {
    const target = await targetOf(guild, p?.target, p?.target_type);
    const allow = flagsFrom(p.allow, "allow"), deny = flagsFrom(p.deny, "deny"), reset = flagsFrom(p.reset, "reset");
    if (!p.clear && !allow.length && !deny.length && !reset.length) fail(`permissions for ${target.label}: give allow, deny, reset or clear: true.`);
    perms.push({ target, allow, deny, reset, clear: !!p.clear });
  }
  if (args.private != null) {
    const userIds = Array.isArray(args.allow_user_ids) ? args.allow_user_ids : [];
    const roleIds = Array.isArray(args.allow_role_ids) ? args.allow_role_ids : [];
    if (args.private) {
      const { overwrites } = await privateOverwrites(guild, client, ch.type, userIds, roleIds);
      for (const o of overwrites) {
        const isEveryone = o.id === everyoneOf(guild).id;
        const label = isEveryone ? "@everyone" : o.id === client.user.id ? "the bot" : guild.roles.cache.get(o.id) ? `@${guild.roles.cache.get(o.id).name}` : ((await memberOf(guild, o.id))?.displayName || o.id);
        perms.push({ target: { id: o.id, type: o.type, label }, allow: o.allow || [], deny: o.deny || [], reset: [], clear: false });
      }
    } else {
      if (userIds.length || roleIds.length) fail("allow_user_ids and allow_role_ids go with private: true.");
      perms.push({ target: { id: everyoneOf(guild).id, type: OverwriteType.Role, label: "@everyone" }, allow: [], deny: [], reset: [P.ViewChannel], clear: false });
    }
  } else if (Array.isArray(args.allow_user_ids) || Array.isArray(args.allow_role_ids)) {
    fail("allow_user_ids and allow_role_ids go with private: true (or use permissions).");
  }
  // Hiding the channel from @everyone keeps the bot in.
  if (perms.some((p) => p.target.id === everyoneOf(guild).id && p.deny.includes(P.ViewChannel)) && !perms.some((p) => p.target.id === client.user.id)) {
    const grant = (ACCESS[ch.type] || TEXT_ACCESS).filter((b) => !missingPerms(guild, null, [b]).length);
    perms.push({ target: { id: client.user.id, type: OverwriteType.Member, label: "the bot" }, allow: grant, deny: [], reset: [], clear: false });
  }

  if (!changes.length && !perms.length) fail("Nothing to change: give name, topic, parent_id, sync_with_category, private or permissions.");
  note.handsOut = handedOut(perms.map((p) => ({ allow: p.allow, deny: p.deny })));
  if (changes.length) requirePerms(guild, ch, [P.ManageChannels], "edit this channel");
  if (perms.length) requirePerms(guild, ch, [P.ManageRoles], "change who can see or do what in this channel");

  const done = [];
  if (changes.length) {
    const before = ch.name;
    const updated = await ch.edit(edit);
    note.channel = updated || ch;
    done.push(...changes.map((c) => (c.startsWith("renamed") ? `renamed from ${before} to ${edit.name}` : c)));
  }
  for (const p of perms) {
    const opts = { type: p.target.type, reason: reasonOf(args) };
    if (p.clear) {
      await ch.permissionOverwrites.delete(p.target.id, reasonOf(args));
      done.push(`removed the permission overwrite for ${p.target.label}`);
      continue;
    }
    const set = {};
    for (const b of p.allow) set[FLAG_NAME.get(b)] = true;
    for (const b of p.deny) set[FLAG_NAME.get(b)] = false;
    for (const b of p.reset) set[FLAG_NAME.get(b)] = null;
    await ch.permissionOverwrites.edit(p.target.id, set, opts);
    const parts = [];
    if (p.allow.length) parts.push(`allowed ${p.allow.map(permLabel).join(", ")}`);
    if (p.deny.length) parts.push(`denied ${p.deny.map(permLabel).join(", ")}`);
    if (p.reset.length) parts.push(`reset ${p.reset.map(permLabel).join(", ")} to the default`);
    done.push(`${p.target.label}: ${parts.join("; ")}`);
  }
  const now = note.channel;
  return [
    `Edited ${ch.type === ChannelType.GuildCategory ? "the category " : "#"}${now.name} (id ${ch.id}) in the server ${guildLabel(guild)}:`,
    ...done.map((d) => `- ${d}`),
    `link: ${jumpLink(guild, ch)}`,
  ].join("\n");
}

// ---------------------------------------------------------------- webhooks

async function webhookChannel(client, args, note) {
  if (!args.channel_id) fail("channel_id is required: the channel the webhook posts into.");
  const ch = await fetchChannel(client, args.channel_id);
  if (!ch.guild) fail(`channel ${ch.id} is a direct message: webhooks live in server channels.`);
  note.guild = ch.guild; note.channel = ch;
  if (ch.isThread?.()) fail(`${ch.id} is a thread. Webhooks belong to its parent channel #${ch.parent?.name || ch.parentId}: make it there (a script can post into the thread with ?thread_id=${ch.id} on the webhook URL).`);
  if (typeof ch.fetchWebhooks !== "function" || typeof ch.createWebhook !== "function") fail(`#${ch.name} is a ${typeName(ch)} channel, which cannot have webhooks.`);
  return ch;
}

async function listWebhooks(args, { client, note }) {
  const ch = await webhookChannel(client, args, note);
  requirePerms(ch.guild, ch, [P.ManageWebhooks], "see this channel's webhooks");
  const hooks = [...(await ch.fetchWebhooks()).values()];
  if (!hooks.length) return `#${ch.name} (id ${ch.id}) in the server ${guildLabel(ch.guild)} has no webhooks.`;
  const kind = { 1: "incoming", 2: "channel follower", 3: "application" };
  const lines = hooks.map((h) => `- ${h.name} (webhook id ${h.id}), ${kind[h.type] || "webhook"}${h.owner?.username ? `, made by ${h.owner.username}` : ""}`);
  return [`Webhooks in #${ch.name} (id ${ch.id}), server ${guildLabel(ch.guild)}. URLs are secrets and are not listed:`, ...lines].join("\n");
}

async function createWebhook(args, { client, vault, note }) {
  const ch = await webhookChannel(client, args, note);
  const guild = ch.guild;
  const name = String(args.name ?? "").trim();
  if (!name) fail("name is required: the webhook's name, which its posts show, e.g. Uptime Watchdog.");
  if (name.length > 80) fail("name is too long: Discord allows 80 characters.");
  if (/clyde|discord/i.test(name)) fail(`Discord does not allow "clyde" or "discord" in a webhook name.`);

  const keyName = keyNameFrom(args.save_as_key || `DISCORD_WEBHOOK_${ch.name}`);
  if (!KEY_NAME.test(keyName)) fail(`save_as_key "${args.save_as_key}" is not a usable key name (capitals, digits and underscores, e.g. UPTIME_WATCHDOG_WEBHOOK).`);
  const v = vault || await import("./key-vault.js");
  if (v.hasKey(keyName) && !args.overwrite_key) {
    fail(`The vault already has a key named ${keyName}. Pick another save_as_key, or pass overwrite_key: true if replacing it is what was asked. No webhook was made.`);
  }
  requirePerms(guild, ch, [P.ManageWebhooks], "make webhooks here");

  const avatar = args.use_bot_avatar ? client.user.displayAvatarURL?.({ extension: "png", size: 256 }) : undefined;
  const hook = await ch.createWebhook({ name, avatar, reason: reasonOf(args) });
  if (!hook?.id || !hook?.token) fail(`Discord made a webhook but sent back no token, so there is no URL to save (webhook id ${hook?.id || "unknown"}).`);
  const url = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
  const masked = maskWebhookUrl(hook.id, hook.token);
  const purpose = oneLine(args.purpose || "");
  const description = `Discord webhook URL "${name}" for #${ch.name} (channel ${ch.id}) in the server ${guild.name} (${guild.id}), webhook ${hook.id}.${purpose ? ` Purpose: ${purpose}.` : ""} Secret: anyone with it can post there.`;
  try {
    v.setKey(keyName, url, description);
  } catch (err) {
    fail(`The webhook ${hook.id} was made in #${ch.name}, but saving its URL to the vault failed (${err.message}). The URL was not shown. Try create_webhook again with another save_as_key, or the owner can copy it from Discord (channel settings > Integrations > Webhooks).`);
  }
  const out = [
    `Made the webhook "${name}" in #${ch.name} (id ${ch.id}), server ${guildLabel(guild)}.`,
    `webhook id: ${hook.id}`,
    `URL saved in the vault as ${keyName} (masked: ${masked}).${args.save_as_key ? "" : " (No save_as_key was given, so that name was picked.)"}`,
    "The URL is a secret: never paste it into a chat, a commit or a command line. Use it from the vault by key name.",
  ];
  if (args.reveal) out.push(`Full URL (reveal was asked; it is a secret, do not post it in chat): ${url}`);
  return out.join("\n");
}
