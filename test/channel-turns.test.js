// Each channel hands a person's message to the turn layer once and shows what comes back. This file covers Telegram,
// WhatsApp, Discord and email; Slack's own harness is slack-bot.test.js. The engines run their own tool loops now, so
// a channel never calls the AI again by itself. That covers a turn that "ended on a tool" (an engine fault the turn
// layer reports) and an error still marked recoverable (the turn layer retries those once, itself). Email used to
// call again for as long as a turn ended on "tool_use", mailing one answer up to 15 times over. When a voice note
// can't be transcribed, the person is told what to set up instead of "Failed to process voice message". The channels
// talk to stand-ins on 127.0.0.1 (a Bot API, WHAPI, a Discord client, an IMAP inbox and an SMTP transport), and the
// AI is a scripted stream.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-channel-turns-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-key-for-unit-tests-only-32chars!";
delete process.env.TARSEE_AI_PROVIDER;
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { transcribeAudio, __setForTests: setStt } = await import("../src/voice/stt-handler.js");
const { createTelegramBot } = await import("../src/channels/telegram.js");
const { createWhatsAppBot } = await import("../src/channels/whatsapp.js");
const { createDiscordBot } = await import("../src/channels/discord.js");
const { createEmailBot } = await import("../src/channels/email.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

// ── the AI ──────────────────────────────────────────────────────────────────

/** The stream every channel is given: it records each call and plays the script the test set. */
const model = { calls: [], script: () => [] };
async function* modelStream(opts) {
  model.calls.push(opts);
  for (const ev of model.script(opts)) yield ev;
}

/** The turn layer's first event: which AI this turn runs on. */
const ROUTE = { type: "route", provider: "deepseek", engine: "claude-code", model: "deepseek-v4-flash", label: "DeepSeek Flash", providerLabel: "DeepSeek API key", effort: null };
/** An engine that broke its contract: the turn "ends on a tool", waiting for its caller to run it. */
const endsOnTool = () => [
  ROUTE,
  { type: "text", content: "Let me look. " },
  { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls" } },
  { type: "done", stopReason: "tool_use" },
];
/** An error that still carries the recoverable flag: the turn layer's to retry, never the channel's. */
const SESSION_LOST = "The session could not be resumed.";
const recoverableError = () => [
  ROUTE,
  { type: "error", message: SESSION_LOST, recoverable: true },
  { type: "done", stopReason: "error" },
];
const answer = (text) => () => [ROUTE, { type: "text", content: text }, { type: "usage", usage: { input_tokens: 12, output_tokens: 3 } }, { type: "done", stopReason: "end_turn" }];

/** What transcription says when nothing can transcribe (local faster-whisper not installed, the paid API off). */
const NO_STT = { available: () => false, transcribe: async () => { throw new Error("local transcriber was called"); } };
let sttMessage = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** The saved assistant replies of a conversation, oldest first, with the provider and model they were stored with. */
function replies(convId) {
  return db.prepare("SELECT content, provider, model FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY rowid").all(convId);
}

/** Every option the channels pass must be one the turn layer reads: no tool list, no forced provider or model. */
function assertTurnOptions(opts, source) {
  assert.equal(opts.liveSource, source);
  assert.equal("tools" in opts, false, "no tool definitions: the engines bring their own tools");
  assert.equal("executeTool" in opts, false);
  assert.equal(opts.provider, undefined, "the turn layer picks the AI (the chat's own pick, else the default)");
  assert.equal(opts.model, undefined);
  assert.ok(opts.toolCtx?.conversationId, "the conversation, for the chat's pick, its session and the Stop button");
  // The prompt in its two parts, so Codex keeps the stable part as its thread's instructions and a new daily-log line
  // or checkpoint doesn't start the channel's thread over (design 4.6 g and 4.8).
  assert.equal(opts.systemPrompt, undefined, "the prompt goes in its two parts, not as one string");
  assert.equal(typeof opts.systemParts?.stable, "string");
  assert.equal(typeof opts.systemParts?.volatile, "string");
  assert.ok(opts.systemParts.stable.length > 0, "the stable part holds the workspace files and the channel hint");
}

before(async () => {
  setStt({ local: NO_STT });
  try {
    await transcribeAudio(Buffer.from("x"), "en", { settingsStore: settings });
  } catch (err) {
    sttMessage = err.message;
  }
  setStt();
  assert.match(String(sttMessage), /Speech-to-text is unavailable/, "the message a voice note gets when nothing can transcribe");
});

beforeEach(() => {
  model.calls.length = 0;
  model.script = answer("Hello.");
  settings.set("ai.activeProvider", "claude-code");
  setStt();
});

after(() => {
  setStt();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Telegram ────────────────────────────────────────────────────────────────

describe("Telegram", () => {
  const calls = [];
  const pending = [];
  let server;
  let bot;
  let updateId = 1;
  let messageId = 100;

  /** A message from a person in their own chat with the bot (chat ids keep each test's conversation apart). */
  function send(chatId, message) {
    pending.push({ update_id: updateId++, message: { message_id: messageId++, date: 0, chat: { id: chatId, type: "private" }, from: { id: 42, is_bot: false, first_name: "Sam" }, ...message } });
  }
  const sentTo = (chatId) => calls.filter((c) => c.method === "sendMessage" && c.fields.chat_id === chatId).map((c) => c.fields.text);
  const editsIn = (chatId) => calls.filter((c) => c.method === "editMessageText" && c.fields.chat_id === chatId).map((c) => c.fields.text);
  const convOf = (chatId) => settings.get(`channel_conv.telegram:${chatId}`);

  before(async () => {
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (req.url.startsWith("/file/")) {
        res.writeHead(200, { "content-type": "audio/ogg" });
        res.end(Buffer.from("OggS not really a voice note"));
        return;
      }
      const method = req.url.split("/").pop();
      const body = Buffer.concat(chunks).toString("utf8");
      const fields = body && /json/.test(req.headers["content-type"] || "") ? JSON.parse(body) : {};
      calls.push({ method, fields });
      let result = true;
      if (method === "getMe") result = { id: 1, is_bot: true, first_name: "Test", username: "test_bot" };
      else if (method === "getUpdates") {
        await new Promise((r) => setTimeout(r, 40));
        result = pending.splice(0);
      } else if (method === "sendMessage") result = { message_id: 5000 + calls.length, date: 0, chat: { id: fields.chat_id, type: "private" }, text: fields.text };
      else if (method === "editMessageText") result = { message_id: Number(fields.message_id), date: 0, chat: { id: fields.chat_id, type: "private" }, text: fields.text };
      else if (method === "getFile") result = { file_id: fields.file_id, file_unique_id: `u-${fields.file_id}`, file_size: 28, file_path: `voice/${fields.file_id}.oga` };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    bot = await createTelegramBot({ token: "123:test" }, db, { apiRoot: `http://127.0.0.1:${server.address().port}`, chatStream: modelStream });
  });

  after(async () => {
    await bot?.stop();
    server?.closeAllConnections?.();
    server?.close();
  });

  it("calls the AI once for a turn that ends on a tool, and never runs the tool itself", async () => {
    model.script = endsOnTool;
    send(701, { text: "list my files" });
    await until(() => convOf(701) && replies(convOf(701)).length, "the reply to be saved");
    await settle();
    assert.equal(model.calls.length, 1, "one call: the engines run their own tool loops");
    assertTurnOptions(model.calls[0], "telegram");
    assert.ok(sentTo(701).some((t) => /⚙️ Running command…/.test(t)), "the tool's status line still shows");
    assert.ok(editsIn(701).some((t) => /Let me look\./.test(t)), "the words still stream");
  });

  it("shows a recoverable error instead of calling again, naming the AI, never Claude Code", async () => {
    model.script = recoverableError;
    send(702, { text: "hello" });
    const said = await until(() => sentTo(702).find((t) => t.includes(SESSION_LOST)), "the error to reach the person");
    await settle();
    assert.equal(model.calls.length, 1, "the turn layer already retried; the channel does not");
    assert.match(said, /DeepSeek Flash/, "the AI's name, from the route event");
    assert.doesNotMatch(sentTo(702).join("\n"), /Claude Code/);
  });

  it("hands the message to the turn layer even with no AI chosen (the turn layer says what to set up)", async () => {
    settings.delete("ai.activeProvider");
    model.script = () => [{ type: "text", content: "Tarsee isn't connected to an AI yet: open Settings > AI." }, { type: "error", message: "Tarsee isn't connected to an AI yet: open Settings > AI.", subtype: "not-ready" }, { type: "done", stopReason: "not-ready" }];
    send(703, { text: "hi" });
    await until(() => editsIn(703).some((t) => /isn't connected to an AI yet/.test(t)), "the turn layer's answer");
    await settle();
    assert.equal(model.calls.length, 1);
    assert.ok(!sentTo(703).some((t) => /No AI provider configured/.test(t)), "no second opinion from the channel");
    assert.ok(!sentTo(703).some((t) => /⚠️/.test(t)), "the refusal is said once, not again as an error");
  });

  it("stores the AI and model the turn ran on, from the route event", async () => {
    model.script = answer("Fine, thanks.");
    send(704, { text: "how are you?" });
    await until(() => convOf(704) && replies(convOf(704)).length, "the reply to be saved");
    const [saved] = replies(convOf(704));
    assert.deepEqual([saved.content, saved.provider, saved.model], ["Fine, thanks.", "deepseek", "deepseek-v4-flash"]);
  });

  it("a voice note that can't be transcribed gets what to set up, and the AI is not called", async () => {
    setStt({ local: NO_STT });
    send(705, { voice: { file_id: "voice-1", file_unique_id: "uv1", duration: 2, mime_type: "audio/ogg", file_size: 28 } });
    const said = await until(() => sentTo(705)[0], "the reply");
    assert.equal(said, sttMessage);
    await settle(200);
    assert.equal(model.calls.length, 0);
  });

  it("so does a video note", async () => {
    setStt({ local: NO_STT });
    send(706, { video_note: { file_id: "vnote-1", file_unique_id: "uvn1", duration: 3, length: 240, file_size: 28 } });
    const said = await until(() => sentTo(706)[0], "the reply");
    assert.equal(said, sttMessage);
    await settle(200);
    assert.equal(model.calls.length, 0);
  });

  // Scheduled tasks are paid turns that run with nobody asking, so only the owner manages them (lib/commands.js).
  it("only the owner manages scheduled tasks: their own user id on the allowlist, not just their chat's", async () => {
    settings.set("allowlist.telegram", ["711"]);   // the chat is let in; the person in it (user 42) isn't listed
    try {
      send(711, { text: "/cron list" });
      const said = await until(() => sentTo(711)[0], "the refusal");
      assert.match(said, /Only the owner/);
      assert.match(said, /Telegram user ID/);
      settings.set("allowlist.telegram", ["711", "42"]);
      send(711, { text: "/cron list" });
      assert.match(await until(() => sentTo(711)[1], "the owner's answer"), /No scheduled tasks/);
      assert.equal(model.calls.length, 0, "a command never reaches the AI");
    } finally {
      settings.delete("allowlist.telegram");
    }
  });

  it("with no allowlist anyone can talk to the bot, so nobody there counts as the owner", async () => {
    send(712, { text: "/cron list" });
    assert.match(await until(() => sentTo(712)[0], "the refusal"), /Only the owner/);
  });
});

// ── WhatsApp ────────────────────────────────────────────────────────────────

describe("WhatsApp", () => {
  const sent = [];
  let server;
  let bot;
  const CHAT = "447700900123@s.whatsapp.net";
  const texts = () => sent.filter((s) => s.path === "/messages/text").map((s) => s.body.body);
  const convOf = () => settings.get(`channel_conv.whatsapp:${CHAT}`);
  let msgNo = 0;
  const inbound = (msg) => bot.handleInbound({ messages: [{ id: `wamid-${++msgNo}`, chat_id: CHAT, from_name: "Sam", from_me: false, ...msg }] });

  before(async () => {
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.url.startsWith("/media/")) {
        res.writeHead(200, { "content-type": "audio/ogg" });
        res.end(Buffer.from("OggS not really a voice note"));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/health") {
        res.end(JSON.stringify({ status: { text: "AUTH" }, user: { id: "447700900001", name: "Tarsee" } }));
        return;
      }
      sent.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : {} });
      res.end(JSON.stringify({ sent: true, message: { id: `out-${sent.length}` } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    bot = await createWhatsAppBot(
      { token: "test-whapi-token-not-real", baseUrl: `http://127.0.0.1:${server.address().port}` },
      db,
      { healthTimeoutMs: 2000, chatStream: modelStream },
    );
  });

  beforeEach(() => { sent.length = 0; });

  after(async () => {
    await bot?.stop();
    server?.closeAllConnections?.();
    server?.close();
  });

  it("calls the AI once for a turn that ends on a tool", async () => {
    model.script = endsOnTool;
    await inbound({ type: "text", text: { body: "list my files" } });
    assert.equal(model.calls.length, 1);
    assertTurnOptions(model.calls[0], "whatsapp");
    assert.deepEqual(texts(), ["Let me look."]);
  });

  it("shows a recoverable error instead of calling again, naming the AI, never Claude Code", async () => {
    model.script = recoverableError;
    await inbound({ type: "text", text: { body: "hello" } });
    assert.equal(model.calls.length, 1);
    const said = texts().join("\n");
    assert.ok(said.includes(SESSION_LOST), said);
    assert.match(said, /DeepSeek Flash/);
    assert.doesNotMatch(said, /Claude Code/);
  });

  it("hands the message to the turn layer even with no AI chosen, and stores the AI the turn ran on", async () => {
    settings.delete("ai.activeProvider");
    model.script = answer("Hi Sam.");
    await inbound({ type: "text", text: { body: "hi" } });
    assert.equal(model.calls.length, 1);
    assert.deepEqual(texts(), ["Hi Sam."]);
    const saved = replies(convOf()).at(-1);
    assert.deepEqual([saved.content, saved.provider, saved.model], ["Hi Sam.", "deepseek", "deepseek-v4-flash"]);
  });

  it("a voice note that can't be transcribed gets what to set up, and the AI is not called", async () => {
    setStt({ local: NO_STT });
    await inbound({ type: "voice", voice: { id: "voice-77", mime_type: "audio/ogg; codecs=opus" } });
    assert.deepEqual(texts(), [sttMessage]);
    assert.equal(model.calls.length, 0);
  });

  it("only the owner manages scheduled tasks: their number on the allowlist (with none, anyone can write in)", async () => {
    await inbound({ type: "text", text: { body: "/cron list" } });
    assert.match(texts().join("\n"), /Only the owner/);
    settings.set("allowlist.whatsapp", ["+44 7700 900123"]);
    try {
      sent.length = 0;
      await inbound({ type: "text", text: { body: "/cron list" } });
      assert.match(texts().join("\n"), /No scheduled tasks/);
      assert.equal(model.calls.length, 0);
    } finally {
      settings.delete("allowlist.whatsapp");
    }
  });
});

// ── Discord ─────────────────────────────────────────────────────────────────

/** Stands in for discord.js's Client: the bot's handlers attach to it and the test emits messages at it. */
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

/** A DM to the bot, recording what it replies (and each reply's later edits). */
function discordDM({ content = "", attachments = [] } = {}) {
  const replies = [];
  const message = {
    id: `m-${Math.random()}`,
    author: { bot: false, id: "U42", username: "sam" },
    guild: null,
    channel: { id: "DM-42", isThread: () => false, sendTyping: async () => {}, messages: { fetch: async () => null } },
    content,
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    mentions: { has: () => false },
    reference: null,
    reactions: { cache: new Map() },
    react: async () => {},
    reply: async (text) => {
      const sent = { text, edits: [], edit: async (t) => { sent.edits.push(t); return sent; }, delete: async () => {} };
      replies.push(sent);
      return sent;
    },
  };
  /** Everything the person can see: each reply as last edited. */
  const shown = () => replies.map((r) => r.edits.at(-1) ?? r.text);
  return { message, replies, shown };
}

describe("Discord", () => {
  let server;
  let bot;
  let base;
  const convOf = () => settings.get("channel_conv.discord:DM-42");

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "audio/ogg" });
      res.end(Buffer.from("OggS not really a voice message"));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    bot = await createDiscordBot({ token: "test-discord-token-not-real" }, db, { Client: FakeDiscordClient, chatStream: modelStream });
  });

  after(async () => {
    await bot?.stop();
    server?.closeAllConnections?.();
    server?.close();
  });

  const deliver = (dm) => FakeDiscordClient.last.emit("messageCreate", dm.message);

  it("calls the AI once for a turn that ends on a tool", async () => {
    model.script = endsOnTool;
    const before = convOf() ? replies(convOf()).length : 0;
    const dm = discordDM({ content: "list my files" });
    deliver(dm);
    await until(() => convOf() && replies(convOf()).length > before, "the reply to be saved");
    await settle();
    assert.equal(model.calls.length, 1);
    assertTurnOptions(model.calls[0], "discord");
    assert.ok(dm.shown().some((t) => /⚙️ \*Running command…\*/.test(t)), `the tool's status line: ${dm.shown().join(" | ")}`);
    assert.ok(dm.shown().some((t) => /Let me look\./.test(t)));
  });

  it("shows a recoverable error instead of calling again, naming the AI, never Claude Code", async () => {
    model.script = recoverableError;
    const dm = discordDM({ content: "hello" });
    deliver(dm);
    const said = await until(() => dm.shown().find((t) => t.includes(SESSION_LOST)), "the error to reach the person");
    await settle();
    assert.equal(model.calls.length, 1);
    assert.match(said, /DeepSeek Flash/);
    assert.doesNotMatch(dm.shown().join("\n"), /Claude Code/);
  });

  it("stores the AI and model the turn ran on, with no AI chosen", async () => {
    settings.delete("ai.activeProvider");
    model.script = answer("Hey.");
    const dm = discordDM({ content: "hey" });
    deliver(dm);
    await until(() => dm.shown().includes("Hey."), "the answer");
    await until(() => replies(convOf()).at(-1)?.content === "Hey.", "the reply to be saved");
    const saved = replies(convOf()).at(-1);
    assert.deepEqual([saved.provider, saved.model], ["deepseek", "deepseek-v4-flash"]);
  });

  it("a voice message that can't be transcribed gets what to set up, and the AI is not called", async () => {
    setStt({ local: NO_STT });
    const dm = discordDM({ attachments: [{ url: `${base}/voice-message.ogg`, contentType: "audio/ogg", name: "voice-message.ogg" }] });
    deliver(dm);
    const said = await until(() => dm.shown()[0], "the reply");
    assert.equal(said, sttMessage);
    await settle(200);
    assert.equal(model.calls.length, 0);
    assert.equal(dm.replies.length, 1);
  });

  it("with words besides the voice message: says what to set up, then answers the words", async () => {
    setStt({ local: NO_STT });
    model.script = answer("Answering your words.");
    const dm = discordDM({ content: "also, what time is it?", attachments: [{ url: `${base}/voice-message.ogg`, contentType: "audio/ogg", name: "voice-message.ogg" }] });
    deliver(dm);
    await until(() => dm.shown().includes("Answering your words."), "the answer");
    assert.equal(dm.shown()[0], sttMessage);
    assert.equal(model.calls.length, 1);
  });

  it("only the owner manages scheduled tasks: their own user id on the allowlist, not just a channel's", async () => {
    let dm = discordDM({ content: "/cron list" });
    deliver(dm);
    assert.match(await until(() => dm.shown()[0], "the refusal (no allowlist: anyone can DM the bot)"), /Only the owner/);
    settings.set("allowlist.discord", ["U42"]);
    try {
      dm = discordDM({ content: "/cron list" });
      deliver(dm);
      assert.match(await until(() => dm.shown()[0], "the owner's answer"), /No scheduled tasks/);

      // A server channel that is let in: someone in it who isn't listed by their own id is not the owner.
      settings.set("allowlist.discord", ["chan-1"]);
      const inServer = discordDM({ content: "<@999> /cron list" });
      inServer.message.guild = { id: "G1" };
      inServer.message.channel = { ...inServer.message.channel, id: "chan-1" };
      inServer.message.mentions = { has: () => true };
      deliver(inServer);
      const said = await until(() => inServer.shown()[0], "the refusal in the server");
      assert.match(said, /Only the owner/);
      assert.match(said, /Discord user ID/);
      assert.equal(model.calls.length, 0);
    } finally {
      settings.delete("allowlist.discord");
    }
  });
});

// ── Email ───────────────────────────────────────────────────────────────────

/** Stands in for imapflow's ImapFlow: an INBOX of raw messages, each marked seen once fetched. */
class FakeImap extends EventEmitter {
  static inbox = [];
  constructor(options) {
    super();
    this.options = options;
    this.usable = false;
  }
  async connect() { this.usable = true; }
  async getMailboxLock() { return { release() {} }; }
  idle() { return new Promise(() => {}); }
  async search() { return FakeImap.inbox.filter((m) => !m.seen).map((m) => m.uid); }
  async download(uid) { return { content: Buffer.from(FakeImap.inbox.find((m) => m.uid === uid).raw) }; }
  async messageFlagsAdd({ uid }) { const m = FakeImap.inbox.find((x) => x.uid === uid); if (m) m.seen = true; }
  async logout() { this.usable = false; }
  close() { this.usable = false; }
}

/** A nodemailer transport that keeps what it is asked to send. */
function fakeSmtp() {
  return { sent: [], async verify() { return true; }, async sendMail(mail) { this.sent.push(mail); return { messageId: `<sent-${this.sent.length}@test>` }; }, close() {} };
}

let mailNo = 0;
/** A mail from an allowlisted sender that @mentions Tarsee, so a reply is expected. */
function mention(body) {
  const n = ++mailNo;
  FakeImap.inbox.push({
    uid: n,
    seen: false,
    raw: [
      "From: Sam <sam@example.com>",
      "To: tarsee@example.com",
      `Subject: Question ${n}`,
      `Message-ID: <question-${n}@example.com>`,
      "Date: Mon, 09 Nov 2026 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `@tarsee ${body}`,
      "",
    ].join("\r\n"),
  });
  return n;
}

const EMAIL_CONFIG = {
  enabled: true,
  tarseeEmailAddress: "tarsee@example.com",
  imap: { host: "127.0.0.1", port: 1, user: "tarsee@example.com", password: "test-password-not-real" },
  smtp: { host: "127.0.0.1", port: 1, user: "tarsee@example.com", password: "test-password-not-real" },
  allowlistFromAddresses: ["sam@example.com"],
  // These mails carry no Authentication-Results line, as from a server that checks nothing: the owner's "trust the
  // From line" lets them in, set for this exact mailbox (who really sent a mail is test/email-sender-check.test.js).
  senderCheck: { imapHost: "127.0.0.1", imapUser: "tarsee@example.com", trustFromLine: true },
};

describe("email", () => {
  /** A fresh mailbox bot: its first pass over the inbox answers what is unseen, before createEmailBot returns. */
  async function answerInbox() {
    const smtp = fakeSmtp();
    const bot = await createEmailBot(EMAIL_CONFIG, db, { chatStream: modelStream, ImapFlow: FakeImap, smtpTransport: smtp });
    await bot.stop();
    return smtp;
  }
  const convOfMail = (n) => db.prepare("SELECT id FROM conversations WHERE title = ?").get(`Email: Question ${n}`)?.id;

  it("does not loop: a turn that ends on a tool is answered with one call and one mail", async () => {
    model.script = endsOnTool;
    const n = mention("list my files");
    const smtp = await answerInbox();
    assert.equal(model.calls.length, 1, "one call, not one per 'tool_use' round (it used to be up to 15)");
    assertTurnOptions(model.calls[0], "email");
    assert.equal(smtp.sent.length, 1);
    assert.equal(smtp.sent[0].text.trim(), "Let me look.", "the answer once, not repeated per round");
    assert.equal(replies(convOfMail(n)).length, 1);
  });

  it("an error the AI reports is mailed in plain words (naming the AI), not as '(no response)', with no second call", async () => {
    model.script = recoverableError;
    mention("hello");
    const smtp = await answerInbox();
    assert.equal(model.calls.length, 1);
    assert.equal(smtp.sent.length, 1);
    const body = smtp.sent[0].text;
    assert.ok(body.includes(SESSION_LOST), body);
    assert.match(body, /DeepSeek Flash/);
    assert.doesNotMatch(body, /\(no response\)|Claude Code/);
  });

  it("hands the mail to the turn layer even with no AI chosen, and stores the AI the turn ran on", async () => {
    settings.delete("ai.activeProvider");
    model.script = answer("Here are the numbers.");
    const n = mention("this week's numbers?");
    const smtp = await answerInbox();
    assert.equal(model.calls.length, 1);
    assert.equal(smtp.sent[0].text.trim(), "Here are the numbers.");
    assert.ok(!smtp.sent.some((m) => /No AI provider/.test(m.text)));
    const [saved] = replies(convOfMail(n));
    assert.deepEqual([saved.provider, saved.model], ["deepseek", "deepseek-v4-flash"]);
    assert.ok(model.calls[0].toolCtx.messageId, "the turn knows which message it answers");
  });

  it("scheduled tasks can't be managed by email, even from an allowlisted address (a From line is easy to fake)", async () => {
    const n = ++mailNo;
    FakeImap.inbox.push({
      uid: n,
      seen: false,
      raw: [
        "From: Sam <sam@example.com>", "To: tarsee@example.com", `Subject: Question ${n}`, `Message-ID: <question-${n}@example.com>`,
        "Date: Mon, 09 Nov 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "/cron list @tarsee", "",
      ].join("\r\n"),
    });
    const smtp = await answerInbox();
    assert.equal(model.calls.length, 0);
    assert.equal(smtp.sent.length, 1);
    assert.match(smtp.sent[0].text, /Only the owner/);
    assert.match(smtp.sent[0].text, /can't be done by email/);
  });
});
