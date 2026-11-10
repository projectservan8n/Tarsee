// Three chat commands (src/lib/commands.js) that said one thing and did another:
//  - /stop stops the reply running in the chat it was sent in, on every channel and the dashboard, the way the chat's
//    Stop button does (POST /api/chat/stop, through stopTurns in ai/turn.js). It used to wait for an abortController
//    that no caller ever passed, so it only ever said "Nothing is currently generating."
//  - ...and it arrives while the reply runs. Telegram and email take one message at a time, and used to read the next
//    one only once the reply ended: a /stop came too late to stop anything. Now /stop (and /help and /version, which
//    change nothing) is read and answered at once, while any other message still waits its turn. Typed in the
//    dashboard's chat, /stop also cancels what the dashboard sent that waits behind the reply, as its Stop button does,
//    and with the Live view off it is sent at once instead of waiting in the tab's queue behind the reply.
//  - /theme sent from Telegram, Discord, Slack, WhatsApp or email answers in plain words: a theme is how the dashboard
//    looks, so it is picked there. Only the dashboard's chat gets the __SET_THEME__ marker its page reads.
//  - Settings > Automation > Session Reset's "Manual" option names a command that exists and starts a fresh session
//    (it named /reset, which isn't a command).
// The AI is a scripted engine (test/fakes/fake-engine.js) that waits until it is stopped: no real key is used.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-commands-fixes-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const live = await import("../src/lib/live-bus.js");
const { registerEngine, configureTurns, runTurn, stopTurns } = await import("../src/ai/turn.js");
const { processCommand, getCommandList } = await import("../src/lib/commands.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

const CHANNELS = ["telegram", "discord", "slack", "whatsapp", "email"];
const THEMES = ["warm-charcoal", "noir", "solarized-light", "jarvis-blue"];

let engine;
let restore;

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** Resolves to what the promise gave, or to "still running" after ms: a turn /stop missed must fail the test, not hang it. */
function within(promise, ms = 3000) {
  return Promise.race([promise, new Promise((r) => { const t = setTimeout(() => r("still running"), ms); t.unref?.(); })]);
}

/** A command as a channel sends it: the chat's conversation, its platform, never the owner. */
const command = (text, { conversationId = null, platform } = {}) =>
  processCommand(text, { settingsStore: settings, convStore: convs, conversationId, platform, owner: false, db });

/** Start a turn in a conversation, as a channel does (ai/turn.js through ai/router.js); resolves to its events when it ends. */
async function startTurn(conversationId, source) {
  const calls = engine.calls.length;
  const events = [];
  const stream = runTurn({
    messages: [{ role: "user", content: "write me a long essay" }],
    toolCtx: { db, settingsStore: settings, conversationId },
    liveSource: source,
  });
  const ended = (async () => { for await (const e of stream) events.push(e); return events; })();
  assert.ok(await until(() => engine.calls.length > calls), "the turn began");
  return ended;
}

beforeEach(() => {
  restore?.();
  restore = configureTurns({ recordUsage: () => {}, grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "t", revoke() {} }) });
  engine = createFakeEngine([[{ type: "text", content: "Half an ans" }, { type: "wait" }]]);
  registerEngine("claude-code", engine);
});

after(() => {
  restore?.();
  registerEngine("claude-code", null);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── /stop ─────────────────────────────────────────────────────────────────────

describe("/stop stops the reply running in the chat it was sent in", () => {
  for (const platform of [...CHANNELS, "web"]) {
    it(`sent from ${platform}: the running turn ends, and the reply says it stopped`, async () => {
      const conv = convs.create({ title: platform }).id;
      const ended = startTurn(conv, platform);
      try {
        const r = await command("/stop", { conversationId: conv, platform });
        assert.equal(r.handled, true);
        assert.match(r.response, /^Stopped/);
        const events = await within(ended);
        assert.notEqual(events, "still running", "/stop left the turn running");
        assert.equal(events.filter((e) => e.type === "done").at(-1)?.stopReason, "aborted");
      } finally {
        stopTurns(conv);
        await ended;
      }
    });
  }

  it("a reply running in another chat keeps going", async () => {
    const busy = convs.create({ title: "busy" }).id;
    const other = convs.create({ title: "other" }).id;
    const ended = startTurn(busy, "telegram");
    try {
      const r = await command("/stop", { conversationId: other, platform: "telegram" });
      assert.match(r.response, /Nothing is running in this chat/);
      assert.equal(await within(ended, 200), "still running", "a /stop in another chat stopped this one");
    } finally {
      stopTurns(busy);
      await ended;
    }
  });

  it("with nothing running it says so plainly", async () => {
    const conv = convs.create({ title: "quiet" }).id;
    for (const platform of [...CHANNELS, "web"]) {
      const r = await command("/stop", { conversationId: conv, platform });
      assert.equal(r.handled, true);
      assert.equal(r.response, "Nothing is running in this chat, so there's nothing to stop.");
    }
    // A chat that has no conversation yet (its very first message) has nothing running either.
    assert.equal((await command("/stop", { platform: "telegram" })).response, "Nothing is running in this chat, so there's nothing to stop.");
  });

  it("Slack's /tarsee stop, which comes from no thread, says where /stop goes", async () => {
    const r = await command("/stop", { platform: "slack" });
    assert.match(r.response, /thread/);
    assert.doesNotMatch(r.response, /Stopped/);
  });

  it("typed in the dashboard's chat (POST /api/chat/send) while a reply runs: that reply stops", async () => {
    const { chatRouter } = await import("../src/routes/chat.js");
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.set("db", db);
    app.set("settingsStore", settings);
    app.use("/api/chat", chatRouter);
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/chat`;
    const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const conv = convs.create({ title: "web" }).id;
    try {
      const sending = post("/send", { conversationId: conv, message: "write me a long essay" }).then((r) => r.text());
      assert.ok(await until(() => engine.calls.length === 1), "the reply began");
      const answer = await (await post("/send", { conversationId: conv, message: "/stop" })).json();
      assert.equal(answer.command, true);
      assert.match(answer.response, /^Stopped/);
      const raw = await within(sending);
      assert.notEqual(raw, "still running", "/stop left the reply running");
      const done = raw.split("\n\n").filter((c) => /^event: done$/m.test(c)).map((c) => JSON.parse(/^data: (.+)$/m.exec(c)[1]));
      assert.equal(done.length, 1);
      assert.equal(done[0].stopReason, "stopped", "the page shows the reply as stopped, as its Stop button does");
    } finally {
      stopTurns(conv);
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("on a channel end to end (Discord): a /stop sent while the reply runs ends it", async () => {
    const { createDiscordBot } = await import("../src/channels/discord.js");
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
    const replies = [];
    const dm = (content) => ({
      id: `m-${Math.random()}`,
      author: { bot: false, id: "U42", username: "sam" },
      guild: null,
      channel: { id: "DM-STOP", isThread: () => false, sendTyping: async () => {}, messages: { fetch: async () => null } },
      content,
      attachments: new Map(),
      mentions: { has: () => false },
      reference: null,
      reactions: { cache: new Map() },
      react: async () => {},
      reply: async (text) => {
        const sent = { text, edits: [], edit: async (t) => { sent.edits.push(t); return sent; }, delete: async () => {} };
        replies.push(sent);
        return sent;
      },
    });
    const bot = await createDiscordBot({ token: "test-discord-token-not-real" }, db, { Client: FakeDiscordClient });
    try {
      FakeDiscordClient.last.emit("messageCreate", dm("write me a long essay"));
      assert.ok(await until(() => engine.calls.length === 1), "the reply began");
      const conv = settings.get("channel_conv.discord:DM-STOP");
      assert.ok(conv);
      assert.ok(await until(() => live.activeTurnFor(conv)), "the reply is running");
      FakeDiscordClient.last.emit("messageCreate", dm("/stop"));
      assert.ok(await until(() => replies.some((r) => /^Stopped/.test(r.text))), `the /stop answer: ${JSON.stringify(replies.map((r) => r.text))}`);
      assert.ok(await until(() => live.activeTurnFor(conv) == null, 3000), "the reply is no longer running");
    } finally {
      stopTurns(settings.get("channel_conv.discord:DM-STOP"));
      await bot.stop?.();
    }
  });
});

// ── /stop arrives while the reply runs, where messages are taken one at a time ──

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STOPPED = "Stopped the reply in this chat.";

/** Two scripts for the AI: the first reply runs until it is stopped, the next one answers at once. */
function stoppableThenAnswers(answer) {
  engine = createFakeEngine([
    [{ type: "text", content: "Half an ans" }, { type: "wait" }],
    [{ type: "text", content: answer }, { type: "done", stopReason: "end_turn" }],
  ]);
  registerEngine("claude-code", engine);
}

/**
 * A Telegram Bot API on 127.0.0.1 that the real bot (Telegraf) long-polls: it keeps what it is sent, and hands out the
 * updates a test queues, each once, as soon as the bot next asks.
 */
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
      // A long poll, kept short: it answers as soon as there is an update, else after 100 ms with none.
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
  /** A person's message: in a private chat with them, or with `group`, in a group whose id is chatId. */
  api.send = (chatId, text, { from = 42, group = false } = {}) => {
    api.pending.push({
      update_id: api.nextUpdate++,
      message: {
        message_id: api.nextMessage++,
        date: 0,
        chat: group ? { id: chatId, type: "group", title: "The group" } : { id: chatId, type: "private", first_name: "Sam" },
        from: { id: from, is_bot: false, first_name: "Sam" },
        text,
      },
    });
  };
  /** All the bot has said in a chat: the messages it sent and what it edited them to, in order. */
  api.said = (chatId) => api.calls
    .filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && c.fields.chat_id === chatId)
    .map((c) => c.fields.text);
  api.close = () => { server.closeAllConnections?.(); server.close(); };
  return api;
}

describe("/stop on Telegram, which takes a chat's messages one at a time (the real bot, a Bot API on 127.0.0.1)", () => {
  let api;
  let bot;
  const chats = new Set();
  before(async () => {
    api = await fakeBotApi();
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    bot = await createTelegramBot({ token: "123456:test-token-not-real" }, db, { apiRoot: api.url });
  });
  after(async () => {
    await bot?.stop?.();
    api?.close();
  });
  afterEach(async () => {
    // Nothing of one test runs into the next: every reply in its chats is stopped until the bot has nothing left.
    const idle = await until(() => {
      for (const id of chats) { const c = convOf(id); if (c) stopTurns(c); }
      return api.pending.length === 0 && bot.health().handlerActive === 0;
    }, 8000);
    chats.clear();
    settings.delete("allowlist.telegram");
    assert.ok(idle, "the bot finished what it was given");
  });

  const convOf = (chatId) => settings.get(`channel_conv.telegram:${chatId}`);
  /** Start a reply in a chat and wait until it is running: its conversation. */
  async function startReply(chatId, { group = false } = {}) {
    chats.add(chatId);
    const calls = engine.calls.length;
    api.send(chatId, group ? "@test_bot write me a long essay" : "write me a long essay", { group });
    assert.ok(await until(() => engine.calls.length > calls), "the reply began");
    assert.ok(await until(() => convOf(chatId) && live.activeTurnFor(convOf(chatId))), "the reply is running");
    return convOf(chatId);
  }

  it("a /stop sent while the reply runs is read at once and ends that reply", async () => {
    const conv = await startReply(901);
    const sentAt = Date.now();
    api.send(901, "/stop");
    assert.ok(await until(() => api.said(901).includes(STOPPED), 2000), `answered within 2 s, while the reply ran: ${JSON.stringify(api.said(901))}`);
    assert.ok(await until(() => !live.activeTurnFor(conv), 2000), "the reply ended");
    assert.ok(Date.now() - sentAt < 2500, `it took ${Date.now() - sentAt} ms`);
  });

  it("in a group, /stop@bot (as Telegram's command menu sends it there) does the same", async () => {
    const conv = await startReply(-1001, { group: true });
    api.send(-1001, "/stop@test_bot", { group: true });
    assert.ok(await until(() => api.said(-1001).includes(STOPPED), 2000), JSON.stringify(api.said(-1001)));
    assert.ok(await until(() => !live.activeTurnFor(conv), 2000), "the reply ended");
  });

  it("any other message sent while the reply runs waits its turn, and is answered once the reply is over", async () => {
    stoppableThenAnswers("Tea is fine.");
    const conv = await startReply(902);
    api.send(902, "and what about tea?");
    await sleep(500);
    assert.equal(engine.calls.length, 1, "no second reply runs alongside the first");
    assert.ok(!convs.getRecentMessages(conv, 20).some((m) => /tea/.test(m.content)), "nor is the message put in the chat ahead of the reply");
    api.send(902, "/stop");
    assert.ok(await until(() => api.said(902).includes(STOPPED), 2000), "the /stop is answered");
    assert.ok(await until(() => engine.calls.length === 2), "then the waiting message has its turn");
    assert.match(engine.calls[1].prompt, /what about tea/);
    assert.ok(await until(() => api.said(902).includes("Tea is fine.")), JSON.stringify(api.said(902)));
  });

  it("only /stop, /help and /version are answered at once: a command that changes the chat (/new) waits its turn", async () => {
    const conv = await startReply(903);
    api.send(903, "/new");
    api.send(903, "/help");
    assert.ok(await until(() => api.said(903).some((t) => /Tarsee Commands/.test(t)), 2000), "/help is answered while the reply runs");
    assert.ok(!api.said(903).some((t) => /Conversation cleared/.test(t)), "/new has not run");
    assert.ok(convs.messageCount(conv) > 0, "the chat still has its messages");
    api.send(903, "/version");
    assert.ok(await until(() => api.said(903).some((t) => /Tarsee<\/b> v/.test(t)), 2000), "/version is answered while the reply runs");
    api.send(903, "/stop");
    assert.ok(await until(() => api.said(903).includes(STOPPED), 2000));
    assert.ok(await until(() => api.said(903).some((t) => /Conversation cleared/.test(t))), "/new runs once the reply is over");
    const said = api.said(903);
    assert.ok(said.indexOf(STOPPED) < said.findIndex((t) => /Conversation cleared/.test(t)));
  });

  it("the allowlist still holds for what is answered at once: a chat not on it gets nothing", async () => {
    settings.set("allowlist.telegram", ["904"]);
    const conv = await startReply(904);
    chats.add(905);
    api.send(905, "/help");
    api.send(905, "/stop");
    api.send(904, "/help");
    assert.ok(await until(() => api.said(904).some((t) => /Tarsee Commands/.test(t)), 2000), "the listed chat is answered");
    await sleep(300);
    assert.deepEqual(api.said(905), [], "the chat off the allowlist is ignored");
    assert.ok(live.activeTurnFor(conv), "and its /stop stopped nothing");
  });
});

/** Stands in for imapflow's ImapFlow, mailbox lock and all: one holder at a time, the next waits for release(). */
class LockingImap extends EventEmitter {
  static inbox = [];
  static last = null;
  constructor(options) {
    super();
    this.options = options;
    this.usable = false;
    this.lockTail = Promise.resolve();
    LockingImap.last = this;
  }
  async connect() { this.usable = true; }
  async getMailboxLock() {
    const ahead = this.lockTail;
    let release;
    this.lockTail = new Promise((r) => { release = r; });
    await ahead;
    return { release: () => release() };
  }
  idle() { return new Promise(() => {}); }
  async search() { return LockingImap.inbox.filter((m) => !m.seen).map((m) => m.uid); }
  async download(uid) { return { content: Buffer.from(LockingImap.inbox.find((m) => m.uid === uid).raw) }; }
  async messageFlagsAdd({ uid }) { const m = LockingImap.inbox.find((x) => x.uid === uid); if (m) m.seen = true; }
  async logout() { this.usable = false; }
  close() { this.usable = false; }
}

describe("/stop by email, where mail is handled one at a time (the real channel, an IMAP stand-in with imapflow's lock)", () => {
  const EMAIL = {
    enabled: true,
    tarseeEmailAddress: "tarsee@example.com",
    imap: { host: "127.0.0.1", port: 1, user: "tarsee@example.com", password: "test-password-not-real" },
    smtp: { host: "127.0.0.1", port: 1, user: "tarsee@example.com", password: "test-password-not-real" },
    allowlistFromAddresses: ["sam@example.com"],
  };
  let bot;
  let smtp;
  let uid = 0;
  const threads = [];
  const mailed = () => smtp.sent.map((m) => String(m.text).trim());
  const convOf = (messageId) => settings.get(`channel_conv.email:${messageId}`);

  /** A mail from the allowlisted sender arrives; `thread`: the Message-ID of the mail it answers. Its Message-ID. */
  function arrives(body, { subject = "Essay", thread = null } = {}) {
    const n = ++uid;
    const id = `<mail-${n}@example.com>`;
    LockingImap.inbox.push({
      uid: n,
      seen: false,
      raw: [
        "From: Sam <sam@example.com>", "To: tarsee@example.com", `Subject: ${thread ? "Re: " : ""}${subject}`, `Message-ID: ${id}`,
        ...(thread ? [`In-Reply-To: ${thread}`, `References: ${thread}`] : []),
        "Date: Mon, 09 Nov 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", body, "",
      ].join("\r\n"),
    });
    if (!thread) threads.push(id);
    LockingImap.last.emit("exists");
    return id;
  }

  beforeEach(async () => {
    LockingImap.inbox = [];
    threads.length = 0;
    smtp = { sent: [], async verify() { return true; }, async sendMail(m) { this.sent.push(m); return { messageId: `<sent-${this.sent.length}@test>` }; }, close() {} };
    const { createEmailBot } = await import("../src/channels/email.js");
    bot = await createEmailBot(EMAIL, db, { ImapFlow: LockingImap, smtpTransport: smtp });
  });
  afterEach(async () => {
    const idle = await until(() => {
      for (const id of threads) { const c = convOf(id); if (c) stopTurns(c); }
      return LockingImap.inbox.every((m) => m.seen);
    }, 8000);
    await bot.stop();
    assert.ok(idle, "every mail was handled and marked seen");
  });

  it("a /stop mailed in the thread while its reply is written is read at once and ends that reply", async () => {
    const first = arrives("@tarsee write me a long essay");
    assert.ok(await until(() => engine.calls.length === 1), "the reply began");
    const conv = convOf(first);
    assert.ok(conv && await until(() => live.activeTurnFor(conv)), "the reply is running");
    const sentAt = Date.now();
    arrives("/stop @tarsee", { thread: first });
    assert.ok(await until(() => mailed().includes(STOPPED), 2000), `answered within 2 s, while the reply ran: ${JSON.stringify(mailed())}`);
    assert.ok(await until(() => !live.activeTurnFor(conv), 2000), "the reply ended");
    assert.ok(Date.now() - sentAt < 2500, `it took ${Date.now() - sentAt} ms`);
    assert.ok(await until(() => mailed().includes("Half an ans")), "what the reply had written by then is still mailed");
  });

  it("any other mail that comes while the reply is written waits its turn, and is answered once, after it", async () => {
    stoppableThenAnswers("Tea is fine.");
    const first = arrives("@tarsee write me a long essay");
    assert.ok(await until(() => convOf(first) && live.activeTurnFor(convOf(first))), "the reply is running");
    const second = arrives("@tarsee and what about tea?", { subject: "Tea" });
    await sleep(500);
    assert.equal(engine.calls.length, 1, "no second reply runs alongside the first");
    assert.equal(convOf(second), null, "nor is the mail taken into a chat yet");
    arrives("/stop @tarsee", { thread: first });
    assert.ok(await until(() => mailed().includes(STOPPED), 2000), "the /stop is answered");
    assert.ok(await until(() => mailed().includes("Tea is fine.")), `then the waiting mail is answered: ${JSON.stringify(mailed())}`);
    assert.equal(engine.calls.length, 2);
    assert.match(engine.calls[1].prompt, /what about tea/);
    assert.ok(await until(() => LockingImap.inbox.every((m) => m.seen)), "each mail is marked seen once handled");
    // A later look at the inbox takes nothing again.
    const sent = smtp.sent.length;
    LockingImap.last.emit("exists");
    await sleep(200);
    assert.equal(smtp.sent.length, sent, "no mail is answered twice");
    assert.equal(engine.calls.length, 2);
  });
});

/** The dashboard's chat routes (routes/chat.js) on 127.0.0.1: post(path, body) and close(). */
async function dashboardChat() {
  const { chatRouter } = await import("../src/routes/chat.js");
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.set("db", db);
  app.set("settingsStore", settings);
  app.use("/api/chat", chatRouter);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/chat`;
  return {
    post: (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}
const doneEvents = (raw) => raw.split("\n\n").filter((c) => /^event: done$/m.test(c)).map((c) => JSON.parse(/^data: (.+)$/m.exec(c)[1]));

describe("/stop typed in the dashboard's chat", () => {
  it("also cancels what the dashboard sent that waits behind the reply, as the Stop button does", async () => {
    const { queueDepth } = await import("../src/lib/conversation-lock.js");
    const chat = await dashboardChat();
    const conv = convs.create({ title: "web queue" }).id;
    try {
      const first = chat.post("/send", { conversationId: conv, message: "write me a long essay" }).then((r) => r.text());
      assert.ok(await until(() => engine.calls.length === 1), "the reply began");
      const second = chat.post("/send", { conversationId: conv, message: "and what about tea?" }).then((r) => r.text());
      assert.ok(await until(() => queueDepth(conv) === 2), "the second message waits behind the reply");
      const answer = await (await chat.post("/send", { conversationId: conv, message: "/stop" })).json();
      assert.equal(answer.response, STOPPED);
      const raws = await within(Promise.all([first, second]));
      assert.notEqual(raws, "still running", "/stop left something running");
      for (const raw of raws) assert.equal(doneEvents(raw).at(-1)?.stopReason, "stopped", raw);
      await sleep(200);
      assert.equal(engine.calls.length, 1, "the message that waited behind the reply never ran");
    } finally {
      stopTurns(conv);
      chat.close();
    }
  });

  it("with nothing waiting it stops the reply alone, and a message sent after it runs as usual", async () => {
    stoppableThenAnswers("Tea is fine.");
    const chat = await dashboardChat();
    const conv = convs.create({ title: "web after" }).id;
    try {
      const first = chat.post("/send", { conversationId: conv, message: "write me a long essay" }).then((r) => r.text());
      assert.ok(await until(() => engine.calls.length === 1), "the reply began");
      assert.equal((await (await chat.post("/send", { conversationId: conv, message: "/stop" })).json()).response, STOPPED);
      assert.notEqual(await within(first), "still running");
      const after = await within(chat.post("/send", { conversationId: conv, message: "and what about tea?" }).then((r) => r.text()));
      assert.notEqual(after, "still running");
      assert.equal(engine.calls.length, 2, "the message after the /stop ran");
      assert.match(after, /Tea is fine\./);
    } finally {
      stopTurns(conv);
      chat.close();
    }
  });
});

describe("/stop typed while a reply streams, with the dashboard's Live view off (a real browser)", () => {
  // The page from src/public, with localStorage tarsee_live_off=1. /api/chat/send is a small server that streams the
  // first reply until a /stop comes; every other /api call gets a stand-in answer. Runs on Playwright's own Chromium,
  // else an installed Chrome or Edge; skipped where there is none (npx playwright install chromium).
  let browser = null;
  let server;
  let origin;
  const sends = [];
  let streaming = null;
  before(async () => {
    try {
      const { chromium } = await import("playwright");
      for (const opts of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
        try { browser = await chromium.launch(opts); break; } catch { /* the next one */ }
      }
    } catch { browser = null; }
    if (!browser) return;
    const app = express();
    app.use(express.json());
    app.post("/api/chat/send", (req, res) => {
      const message = req.body?.message;
      sends.push({ message, whileStreaming: !!streaming });
      if (message === "/stop") {
        const reply = streaming;
        streaming = null;
        res.json({ command: true, response: STOPPED, conversationId: "conv-live-off" });
        reply?.end(`event: done\ndata: ${JSON.stringify({ conversationId: "conv-live-off", stopReason: "stopped" })}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      streaming = res;
    });
    app.use(express.static(fileURLToPath(new URL("../src/public/", import.meta.url))));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    streaming?.end();
    await browser?.close();
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  });

  /** Stand-in answers for what the page asks on its way up (as test/diagram-click.test.js gives them). */
  function standIn(route) {
    const p = new URL(route.request().url()).pathname;
    const json = (data) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    if (p === "/api/chat/send") return route.continue();
    if (p === "/api/auth/status") return json({ authenticated: true, needsPassword: true });
    if (p === "/api/auth/api-token") return json({ apiToken: null });
    if (p === "/api/settings/setup-status") return json({ needsSetup: false, needsPersonality: false, botName: "Tarsee", provider: "claude-code", hasKey: true });
    if (p === "/api/settings") return json({ settings: [] });
    if (p === "/api/skills") return json({ skills: [] });
    if (p.startsWith("/api/chat/channels")) return json({ channels: [] });
    return json({});
  }

  it("goes at once, while the reply still streams, instead of waiting in the tab's queue behind it", async (t) => {
    if (!browser) return t.skip("no Chromium, Chrome or Edge for Playwright");
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      await context.addInitScript(() => { try { localStorage.setItem("tarsee_live_off", "1"); } catch { /* none */ } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.route((url) => !url.href.startsWith(`${origin}/`), (route) => route.abort());
      await page.route(`${origin}/api/**`, standIn);
      await page.route(`${origin}/js/sw-register.js`, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
      await page.routeWebSocket(/.*/, () => {});
      await page.goto(`${origin}/`);
      const input = page.locator("#messageInput");
      await input.waitFor();
      // eslint-disable-next-line no-undef -- runs in the page
      assert.equal(await page.evaluate(() => Chat.liveOn()), false, "the Live view is off");

      await input.fill("write me a long essay");
      await input.press("Enter");
      // eslint-disable-next-line no-undef -- runs in the page
      assert.ok(await until(() => page.evaluate(() => Chat.isStreaming)), "the reply streams");
      await input.fill("/stop");
      await input.press("Enter");
      assert.ok(await until(() => sends.some((s) => s.message === "/stop"), 1500), `sent at once: ${JSON.stringify(sends)}`);
      assert.equal(sends.find((s) => s.message === "/stop").whileStreaming, true, "while the reply was still streaming");
      await page.locator(".message.assistant", { hasText: STOPPED }).waitFor({ timeout: 3000 });
      // eslint-disable-next-line no-undef -- runs in the page
      assert.equal(await page.evaluate(() => Chat.messageQueue.length), 0, "nothing left in the tab's queue");
      // eslint-disable-next-line no-undef -- runs in the page
      assert.ok(await until(() => page.evaluate(() => !Chat.isStreaming)), "the stopped reply ends");
      assert.deepEqual(sends.map((s) => s.message), ["write me a long essay", "/stop"], "and nothing more is sent");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

// ── /theme ────────────────────────────────────────────────────────────────────

describe("/theme", () => {
  it("in the dashboard's chat it keeps the marker the page switches the theme by", async () => {
    for (const platform of ["web", "api"]) {
      const r = await command("/theme noir", { platform });
      assert.equal(r.response, "__SET_THEME__:noir|Theme set to **noir**.");
    }
    assert.equal(settings.get("ui.theme"), "noir");
    const list = (await command("/theme", { platform: "web" })).response;
    for (const t of THEMES) assert.ok(list.includes(t), `${t} is listed`);
  });

  for (const platform of CHANNELS) {
    it(`sent from ${platform}: plain words, saying it's a dashboard setting and naming the themes`, async () => {
      settings.set("ui.theme", "warm-charcoal");
      for (const text of ["/theme noir", "/theme", "/theme list", "/theme nonsense"]) {
        const r = await command(text, { platform });
        assert.equal(r.handled, true);
        assert.doesNotMatch(r.response, /__/, `${text} on ${platform} carries a marker: ${r.response}`);
        assert.match(r.response, /dashboard/);
        assert.match(r.response, /Settings > Appearance/);
        for (const t of THEMES) assert.ok(r.response.includes(t), `${text} on ${platform} names ${t}`);
      }
      assert.equal(settings.get("ui.theme"), "warm-charcoal", "nothing is switched from a channel");
    });
  }
});

// ── Session Reset's "Manual" option ───────────────────────────────────────────

describe("Settings > Automation > Session Reset: the Manual option names a real command", () => {
  const html = fs.readFileSync(new URL("../src/public/index.html", import.meta.url), "utf8");
  const option = /<option value="manual">([^<]*)<\/option>/.exec(html)?.[1] || "";
  const named = [...option.matchAll(/\/([a-z][a-z-]*)/g)].map((m) => m[1]);

  it("names at least one command, and each one exists", () => {
    assert.ok(option, "the Manual option is there");
    assert.ok(named.length > 0, `it names a command: "${option}"`);
    const commands = new Set(getCommandList().map((c) => c.name));
    for (const name of named) assert.ok(commands.has(name), `/${name} is a command (the option says "${option}")`);
  });

  it("each command it names starts the chat on a fresh session", async () => {
    for (const name of named) {
      const conv = convs.create({ title: `reset ${name}` }).id;
      convs.addMessage(conv, { role: "user", content: "hello" });
      convs.addMessage(conv, { role: "assistant", content: "hi there" });
      convs.setSessionHandle(conv, "raw-session-before");
      const r = await command(`/${name}`, { conversationId: conv, platform: "telegram" });
      assert.equal(r.handled, true);
      assert.equal(convs.getSessionHandle(conv), null, `/${name} leaves no session to resume`);
      assert.equal(convs.messageCount(conv), 0, `/${name} empties the chat`);
      assert.ok(settings.get(`session.${conv}.clearedAt`), `/${name} records when, so the next session's handoff leaves the old messages out`);
    }
  });
});
