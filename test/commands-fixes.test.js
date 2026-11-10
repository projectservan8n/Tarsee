// Three chat commands (src/lib/commands.js) that said one thing and did another:
//  - /stop stops the reply running in the chat it was sent in, on every channel and the dashboard, the way the chat's
//    Stop button does (POST /api/chat/stop, through stopTurns in ai/turn.js). It used to wait for an abortController
//    that no caller ever passed, so it only ever said "Nothing is currently generating."
//  - /theme sent from Telegram, Discord, Slack, WhatsApp or email answers in plain words: a theme is how the dashboard
//    looks, so it is picked there. Only the dashboard's chat gets the __SET_THEME__ marker its page reads.
//  - Settings > Automation > Session Reset's "Manual" option names a command that exists and starts a fresh session
//    (it named /reset, which isn't a command).
// The AI is a scripted engine (test/fakes/fake-engine.js) that waits until it is stopped: no real key is used.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
