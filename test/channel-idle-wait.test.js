// A channel's idle watchdog (Telegram, Discord, Slack, WhatsApp) gives up on a turn that goes TARSEE_CHANNEL_IDLE_ABORT_MS with
// no word from the AI, and says so ("... stopped responding (N min idle)"). Its clock starts when the turn starts. A
// message can first wait behind another reply in its chat's conversation (one sent from the dashboard, say, which can
// run for many minutes): it used to start the clock before that wait, so a message that waited longer than the idle
// limit was given up on before its turn began, and the AI was called with a signal already aborted. Now it is answered
// once the reply ahead of it ends. The idle limit is 300 ms here and checked every 25 ms (20 minutes and every 15 s in
// use). The real bots talk to stand-ins on 127.0.0.1 (a Bot API, a Discord client, Slack's Web API and Socket Mode,
// WHAPI); the AI is a scripted stream.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-channel-idle-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-key-for-unit-tests-only-32chars!";
process.env.TARSEE_CHANNEL_IDLE_ABORT_MS = "300";
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const IDLE_MS = 300;
const IDLE_CHECK_MS = 25;

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const live = await import("../src/lib/live-bus.js");
const { withConversationTurn } = await import("../src/lib/conversation-lock.js");
const { createTelegramBot } = await import("../src/channels/telegram.js");
const { createDiscordBot } = await import("../src/channels/discord.js");
const { createSlackBot } = await import("../src/channels/slack.js");
const { createWhatsAppBot } = await import("../src/channels/whatsapp.js");

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(10);
  }
  return false;
}

// ── the AI ──────────────────────────────────────────────────────────────────

const ROUTE = { type: "route", provider: "deepseek", engine: "claude-code", model: "deepseek-v4-flash", label: "DeepSeek Flash", providerLabel: "DeepSeek API key", effort: null };
const ANSWER = "Here is your answer.";
const IDLE_NOTE = /stopped responding/;

/**
 * The stream every channel is given. Each call is recorded with whether its signal was already aborted when the AI was
 * asked. model.silent: the AI says nothing more after the route until the turn is given up on; else it answers after
 * a moment (a third of the idle limit), or says nothing if the turn was given up on by then, as an engine would.
 */
const model = { calls: [], silent: false, waiting: new Set() };
async function* modelStream(opts) {
  const call = { abortedAtStart: opts.signal?.aborted === true, abortedLater: false };
  model.calls.push(call);
  yield ROUTE;
  if (model.silent) {
    await new Promise((r) => {
      if (opts.signal.aborted) return r();
      model.waiting.add(r);
      opts.signal.addEventListener("abort", () => { call.abortedLater = true; r(); }, { once: true });
    });
    return;
  }
  await sleep(IDLE_MS / 3);
  if (opts.signal?.aborted) return;
  yield { type: "text", content: ANSWER };
  yield { type: "done", stopReason: "end_turn" };
}

beforeEach(() => {
  model.calls = [];
  model.silent = false;
});

/** A failing test leaves no silent turn behind: each ends, so the bots can be stopped and their stand-ins closed. */
function endSilentTurns() {
  for (const r of model.waiting) r();
  model.waiting.clear();
}

/** Hold a conversation the way a reply from the dashboard does: release() ends that reply. */
function holdConversation(convId) {
  let release;
  const ended = withConversationTurn(convId, () => new Promise((r) => { release = r; }), { live: { source: "web", prompt: "a long reply" } });
  return async () => { release(); await ended; };
}

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Telegram ────────────────────────────────────────────────────────────────

/** A Telegram Bot API on 127.0.0.1 the real bot long-polls: api.send(chat, text) queues a message, api.said(chat) is what it was told. */
async function fakeBotApi() {
  const api = { calls: [], pending: [], nextUpdate: 1, nextMessage: 100 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const method = req.url.split("/").pop();
    const raw = Buffer.concat(chunks).toString("utf8");
    const fields = raw && /json/.test(req.headers["content-type"] || "") ? JSON.parse(raw) : {};
    api.calls.push({ method, fields });
    let result = true;
    if (method === "getMe") result = { id: 1, is_bot: true, first_name: "Tarsee", username: "test_bot" };
    else if (method === "getUpdates") {
      for (let i = 0; i < 10 && api.pending.length === 0; i++) await sleep(10);
      result = api.pending.splice(0);
    } else if (method === "sendMessage" || method === "editMessageText") {
      result = { message_id: Number(fields.message_id) || 5000 + api.calls.length, date: 0, chat: { id: fields.chat_id, type: "private" }, text: fields.text };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${server.address().port}`;
  api.send = (chatId, text) => {
    api.pending.push({
      update_id: api.nextUpdate++,
      message: {
        message_id: api.nextMessage++, date: 0,
        chat: { id: chatId, type: "private", first_name: "Sam" },
        from: { id: 42, is_bot: false, first_name: "Sam" },
        text,
      },
    });
  };
  api.said = (chatId) => api.calls
    .filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && c.fields.chat_id === chatId)
    .map((c) => c.fields.text);
  api.close = () => { server.closeAllConnections?.(); server.close(); };
  return api;
}

describe("Telegram: the idle clock starts when the turn starts", () => {
  let api;
  let bot;
  before(async () => {
    api = await fakeBotApi();
    bot = await createTelegramBot({ token: "123456:test-token-not-real" }, db, { apiRoot: api.url, chatStream: modelStream, idleCheckEveryMs: IDLE_CHECK_MS });
  });
  after(async () => {
    endSilentTurns();
    await sleep(100);
    await bot?.stop();
    api?.close();
  });

  it("a message that waits behind another reply longer than the idle limit is answered once that reply ends", async () => {
    const conv = convs.create({ title: "busy" }).id;
    settings.set("channel_conv.telegram:801", conv);
    const release = holdConversation(conv);
    try {
      api.send(801, "a question that waits");
      assert.ok(await until(() => api.said(801).some((t) => /Still working/.test(t))), "it waits behind that reply");
      await sleep(IDLE_MS * 3);
      assert.equal(model.calls.length, 0, "the AI is not asked while it waits");
    } finally {
      await release();
    }
    assert.ok(await until(() => api.said(801).includes(ANSWER)), `it is answered: ${JSON.stringify(api.said(801))}`);
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0].abortedAtStart, false, "the AI was asked with a live signal, not one already given up on");
    assert.ok(!api.said(801).some((t) => IDLE_NOTE.test(t)), `no idle note: ${JSON.stringify(api.said(801))}`);
  });

  it("...and a turn the AI goes silent in for longer than the idle limit is still given up on, with the idle note", async () => {
    model.silent = true;
    api.send(802, "a question the AI never answers");
    assert.ok(await until(() => api.said(802).some((t) => IDLE_NOTE.test(t)), 3000), `the idle note: ${JSON.stringify(api.said(802))}`);
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0].abortedAtStart, false);
    assert.equal(model.calls[0].abortedLater, true, "the watchdog aborted the turn");
  });
});

// ── Discord ─────────────────────────────────────────────────────────────────

class FakeDiscordClient extends EventEmitter {
  static last = null;
  constructor(options) {
    super();
    this.options = options;
    this.user = { id: "999", tag: "tarsee#0001", username: "tarsee" };
    this.channels = { fetch: async () => null };
    FakeDiscordClient.last = this;
  }
  async login() { return "logged in"; }
  async destroy() {}
}

/** A DM to the bot in Discord channel `channelId`; what the bot answers (replies, and what it edits them to) goes in `said`. */
function discordDm(channelId, content, said) {
  return {
    id: `m-${Math.random()}`,
    author: { bot: false, id: "U42", username: "sam" },
    guild: null,
    channel: { id: channelId, isThread: () => false, sendTyping: async () => {}, messages: { fetch: async () => null } },
    content,
    attachments: new Map(),
    mentions: { has: () => false },
    reference: null,
    reactions: { cache: new Map() },
    react: async () => {},
    reply: async (text) => {
      said.push(text);
      const sent = { text, edit: async (t) => { said.push(t); return sent; }, delete: async () => {} };
      return sent;
    },
  };
}

describe("Discord: the idle clock starts when the turn starts", () => {
  let bot;
  before(async () => {
    bot = await createDiscordBot({ token: "test-discord-token-not-real" }, db, { Client: FakeDiscordClient, chatStream: modelStream, idleCheckEveryMs: IDLE_CHECK_MS });
  });
  after(async () => {
    endSilentTurns();
    await sleep(100);
    await bot?.stop();
  });

  it("a message that waits behind another reply longer than the idle limit is answered once that reply ends", async () => {
    const said = [];
    const conv = convs.create({ title: "busy" }).id;
    settings.set("channel_conv.discord:DM-IDLE-1", conv);
    const release = holdConversation(conv);
    try {
      FakeDiscordClient.last.emit("messageCreate", discordDm("DM-IDLE-1", "a question that waits", said));
      assert.ok(await until(() => said.some((t) => /Still working/.test(t))), "it waits behind that reply");
      await sleep(IDLE_MS * 3);
      assert.equal(model.calls.length, 0, "the AI is not asked while it waits");
    } finally {
      await release();
    }
    assert.ok(await until(() => said.includes(ANSWER)), `it is answered: ${JSON.stringify(said)}`);
    assert.equal(model.calls[0].abortedAtStart, false, "the AI was asked with a live signal, not one already given up on");
    assert.ok(!said.some((t) => IDLE_NOTE.test(t)), `no idle note: ${JSON.stringify(said)}`);
  });

  it("...and a turn the AI goes silent in for longer than the idle limit is still given up on, with the idle note", async () => {
    model.silent = true;
    const said = [];
    FakeDiscordClient.last.emit("messageCreate", discordDm("DM-IDLE-2", "a question the AI never answers", said));
    assert.ok(await until(() => said.some((t) => IDLE_NOTE.test(t)), 3000), `the idle note: ${JSON.stringify(said)}`);
    assert.equal(model.calls[0].abortedAtStart, false);
    assert.equal(model.calls[0].abortedLater, true, "the watchdog aborted the turn");
  });
});

// ── Slack ───────────────────────────────────────────────────────────────────

/** Slack's Web API and Socket Mode on 127.0.0.1, enough for a DM to be answered: slack.said(from), every word posted or streamed since call `from`. */
async function fakeSlack() {
  const slack = { calls: [], socket: null, ts: 1000, envelopes: 0 };
  const handlers = {
    "auth.test": () => ({ ok: true, user_id: "UBOT", team_id: "T1", bot_id: "BBOT", user: "tarsee", team: "Test Team" }),
    "apps.connections.open": () => ({ ok: true, url: `ws://127.0.0.1:${slack.port}/link` }),
    "users.info": ({ user }) => ({ ok: true, user: { id: user, name: String(user).toLowerCase(), profile: { display_name: "Sam", real_name: "Sam" } } }),
    "chat.postMessage": ({ channel }) => ({ ok: true, ts: `${++slack.ts}.000100`, channel }),
    "chat.startStream": () => ({ ok: true, ts: `${++slack.ts}.000100` }),
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const method = req.url.slice("/api/".length).split("?")[0];
      let args = {};
      if (/json/.test(req.headers["content-type"] || "")) args = JSON.parse(body || "{}");
      else for (const [k, v] of new URLSearchParams(body)) args[k] = /^[[{]/.test(v) ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v;
      slack.calls.push([method, args]);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handlers[method] ? handlers[method](args) : { ok: true }));
    });
  });
  const wss = new WebSocketServer({ server, path: "/link" });
  wss.on("connection", (ws) => {
    slack.socket = ws;
    ws.send(JSON.stringify({ type: "hello", num_connections: 1, debug_info: { host: "test" }, connection_info: { app_id: "A1" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  slack.port = server.address().port;
  /** A person's DM in channel D1, thread `ts`. */
  slack.dm = (ts, text) => {
    const id = `env-${++slack.envelopes}`;
    slack.socket.send(JSON.stringify({
      envelope_id: id, type: "events_api", accepts_response_payload: false, retry_attempt: 0, retry_reason: "",
      payload: {
        token: "x", team_id: "T1", api_app_id: "A1", type: "event_callback", event_id: `Ev${slack.envelopes}`, event_time: 1,
        event: { type: "message", channel: "D1", channel_type: "im", user: "U1", user_team: "T1", text, ts },
        authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
      },
    }));
  };
  slack.said = (from = 0) => slack.calls.slice(from).flatMap(([, a]) => [
    ...(typeof a.markdown_text === "string" ? [a.markdown_text] : []),
    ...(typeof a.text === "string" ? [a.text] : []),
    ...(Array.isArray(a.chunks) ? a.chunks.filter((c) => c.type === "markdown_text").map((c) => c.text) : []),
  ]);
  slack.close = () => { wss.close(); server.closeAllConnections?.(); server.close(); };
  return slack;
}

describe("Slack: the idle clock starts when the turn starts", () => {
  let slack;
  let bot;
  before(async () => {
    slack = await fakeSlack();
    bot = await createSlackBot(
      { enabled: true, token: "xoxb-test", appToken: "xapp-test" },
      db,
      { slackApiUrl: `http://127.0.0.1:${slack.port}/api/`, chatStream: modelStream, idleCheckEveryMs: IDLE_CHECK_MS },
    );
    assert.ok(await until(() => slack.socket), "the Socket Mode connection");
  });
  after(async () => {
    endSilentTurns();
    await sleep(200);
    await bot?.stop().catch(() => {});
    slack?.close();
  });

  it("a message that waits behind another reply longer than the idle limit is answered once that reply ends", async () => {
    const conv = convs.create({ title: "busy" }).id;
    settings.set("channel_conv.slack:D1:thread:810.000100", conv);
    const from = slack.calls.length;
    const release = holdConversation(conv);
    try {
      slack.dm("810.000100", "a question that waits");
      assert.ok(await until(() => slack.said(from).some((t) => /Still working/.test(t))), `it waits behind that reply: ${JSON.stringify(slack.said(from))}`);
      await sleep(IDLE_MS * 3);
      assert.equal(model.calls.length, 0, "the AI is not asked while it waits");
    } finally {
      await release();
    }
    assert.ok(await until(() => slack.said(from).join("").includes(ANSWER)), `it is answered: ${JSON.stringify(slack.said(from))}`);
    assert.equal(model.calls[0].abortedAtStart, false, "the AI was asked with a live signal, not one already given up on");
    assert.ok(!slack.said(from).some((t) => IDLE_NOTE.test(t)), `no idle note: ${JSON.stringify(slack.said(from))}`);
  });

  it("...and a turn the AI goes silent in for longer than the idle limit is still given up on, with the idle note", async () => {
    model.silent = true;
    const from = slack.calls.length;
    slack.dm("811.000100", "a question the AI never answers");
    assert.ok(await until(() => slack.said(from).some((t) => IDLE_NOTE.test(t)), 3000), `the idle note: ${JSON.stringify(slack.said(from))}`);
    assert.equal(model.calls[0].abortedAtStart, false);
    assert.equal(model.calls[0].abortedLater, true, "the watchdog aborted the turn");
  });
});

// ── WhatsApp ────────────────────────────────────────────────────────────────

describe("WhatsApp: the idle clock starts when the turn starts", () => {
  const CHAT = "447700900124@s.whatsapp.net";
  const sent = [];
  let server;
  let bot;
  let msgNo = 0;
  const said = () => sent.filter((x) => x.path === "/messages/text").map((x) => x.body.body);
  const inbound = (chat, body) => bot.handleInbound({ messages: [{ id: `wamid-idle-${++msgNo}`, chat_id: chat, from_name: "Sam", from_me: false, type: "text", text: { body } }] });
  before(async () => {
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/health") {
        res.end(JSON.stringify({ status: { text: "AUTH" }, user: { id: "447700900001", name: "Tarsee" } }));
        return;
      }
      sent.push({ path: req.url, body: raw ? JSON.parse(raw) : {} });
      res.end(JSON.stringify({ sent: true, message: { id: `out-${sent.length}` } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    bot = await createWhatsAppBot(
      { token: "test-whapi-token-not-real", baseUrl: `http://127.0.0.1:${server.address().port}` },
      db,
      { healthTimeoutMs: 2000, chatStream: modelStream, idleCheckEveryMs: IDLE_CHECK_MS },
    );
  });
  after(async () => {
    endSilentTurns();
    await sleep(100);
    await bot?.stop();
    server?.closeAllConnections?.();
    server?.close();
  });

  it("a message that waits behind another reply longer than the idle limit is answered once that reply ends", async () => {
    const conv = convs.create({ title: "busy" }).id;
    settings.set(`channel_conv.whatsapp:${CHAT}`, conv);
    const release = holdConversation(conv);
    let handled;
    try {
      handled = inbound(CHAT, "a question that waits");
      assert.ok(await until(() => live.queuedTurnList(conv).some((t) => t.source === "whatsapp")), "it waits behind that reply");
      await sleep(IDLE_MS * 3);
      assert.equal(model.calls.length, 0, "the AI is not asked while it waits");
    } finally {
      await release();
    }
    await handled;
    assert.deepEqual(said(), [ANSWER], "it is answered, with no idle note");
    assert.equal(model.calls[0].abortedAtStart, false, "the AI was asked with a live signal, not one already given up on");
  });

  it("...and a turn the AI goes silent in for longer than the idle limit is still given up on, with the idle note", async () => {
    model.silent = true;
    const from = sent.length;
    await inbound("447700900125@s.whatsapp.net", "a question the AI never answers");
    const note = sent.slice(from).filter((x) => x.path === "/messages/text").map((x) => x.body.body);
    assert.ok(note.some((t) => IDLE_NOTE.test(t)), `the idle note: ${JSON.stringify(note)}`);
    assert.equal(model.calls[0].abortedAtStart, false);
    assert.equal(model.calls[0].abortedLater, true, "the watchdog aborted the turn");
  });
});
