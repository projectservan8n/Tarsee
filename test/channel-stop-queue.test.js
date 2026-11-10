// What a channel that stops needs from a chat's queue of turns (lib/conversation-lock.js): it takes its messages still
// waiting behind another reply out of the queue at once (opts.onWaiting hands it takeOut), so the dashboard stops
// showing them as "Queued" with a Stop that does nothing, and a turn taken out (that way or by its Stop) is ahead of
// nobody: the next message to wait is told only the replies really ahead of it. Telegram's stop uses it end to end
// (test/commands-fixes.test.js, "stopping the Telegram channel"). And on Discord and WhatsApp, a message taken out of
// the queue by the Stop on its "Queued" line stops showing "typing" (it went on until the channel stopped).
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-channel-stop-queue-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.ENCRYPTION_KEY = "test-key-for-unit-tests-only-32chars!";
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { createDiscordBot } = await import("../src/channels/discord.js");
const { createWhatsAppBot } = await import("../src/channels/whatsapp.js");
const live = await import("../src/lib/live-bus.js");
const { withConversationTurn, removeQueuedTurn, queueDepth, QUEUE_REMOVED, _resetConversationLocks } = await import("../src/lib/conversation-lock.js");

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

beforeEach(() => _resetConversationLocks());
after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A turn running in conversation `conv` until release() is called. */
function running(conv) {
  const reply = Promise.withResolvers();
  const ended = withConversationTurn(conv, () => reply.promise);
  return { ended, release: async () => { reply.resolve(); await ended; } };
}

describe("taking a waiting turn out of the queue (opts.onWaiting)", () => {
  it("it never runs, its \"Queued\" line ends at once, and the turn behind it runs once the reply ahead ends", async () => {
    const ahead = running("c-1");
    let takeOut = null;
    let removedSaid = 0;
    let ran = false;
    const waiting = withConversationTurn("c-1", async () => { ran = true; }, {
      live: { source: "telegram", prompt: "hello", onRemoved: () => { removedSaid++; } },
      onWaiting: (t) => { takeOut = t; },
    });
    assert.equal(typeof takeOut, "function", "a turn that has to wait is handed takeOut");
    const [line] = live.queuedTurnList("c-1");
    assert.ok(line, "it shows as queued");
    assert.equal(takeOut(), true);
    assert.equal(live.queuedTurnList("c-1").length, 0, "its \"Queued\" line ends at once, not once the reply ahead ends");
    assert.equal(removedSaid, 1, "the caller hears it was taken out");
    assert.equal(takeOut(), false, "twice does nothing");
    assert.equal(removeQueuedTurn(line.turnId, "c-1"), false, "nor can its Stop take it out again");
    let nextRan = false;
    const next = withConversationTurn("c-1", async () => { nextRan = true; return "answered"; });
    await ahead.release();
    assert.equal(await waiting, QUEUE_REMOVED);
    assert.equal(await next, "answered");
    assert.equal(ran, false, "the turn taken out never ran");
    assert.equal(nextRan, true);
    assert.equal(removedSaid, 1);
  });

  it("works the same for a turn not shown on the live timeline", async () => {
    const ahead = running("c-2");
    let takeOut = null;
    let ran = false;
    const waiting = withConversationTurn("c-2", async () => { ran = true; }, { onWaiting: (t) => { takeOut = t; } });
    assert.equal(takeOut(), true);
    await ahead.release();
    assert.equal(await waiting, QUEUE_REMOVED);
    assert.equal(ran, false);
  });

  it("does nothing once the turn has begun: a reply already running ends as it would have", async () => {
    const ahead = running("c-3");
    let takeOut = null;
    const reply = Promise.withResolvers();
    const waiting = withConversationTurn("c-3", () => reply.promise, { onWaiting: (t) => { takeOut = t; } });
    await ahead.release();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(takeOut(), false, "its slot has come");
    reply.resolve("done");
    assert.equal(await waiting, "done");
  });

  it("is not offered to a turn that runs at once", async () => {
    let offered = false;
    assert.equal(await withConversationTurn("c-4", async () => "now", { onWaiting: () => { offered = true; } }), "now");
    assert.equal(offered, false);
  });
});

describe("a turn taken out of the queue is ahead of nobody", () => {
  for (const [how, takeOutOf] of [
    ["by the caller (a channel that stops)", (w) => w.takeOut()],
    ["by the Stop on its \"Queued\" line (removeQueuedTurn)", (w) => removeQueuedTurn(w.turnId, "c-5")],
  ]) {
    it(`taken out ${how}: the next one to wait is told only the reply really ahead of it`, async () => {
      const ahead = running("c-5");
      const w = {};
      const before = live.queuedTurnList("c-5").length;
      const first = withConversationTurn("c-5", async () => "first", {
        live: { source: "telegram", prompt: "first" },
        onWaiting: (t) => { w.takeOut = t; },
      });
      w.turnId = live.queuedTurnList("c-5")[before]?.turnId;
      assert.equal(queueDepth("c-5"), 2);
      assert.equal(takeOutOf(w), true);
      assert.equal(queueDepth("c-5"), 1, "only the reply running is left");
      const told = [];
      const second = withConversationTurn("c-5", async () => "second", { onQueued: (n) => told.push(n) });
      assert.deepEqual(told, [1], "1 ahead (\"yours is next\"), not 2");
      await ahead.release();
      assert.equal(await first, QUEUE_REMOVED);
      assert.equal(await second, "second");
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(queueDepth("c-5"), 0, "and the conversation's state is cleared once it is idle");
    });
  }

  it("with several waiting, each one taken out comes off the count of those behind it", async () => {
    const ahead = running("c-6");
    const takeOuts = [];
    const told = [];
    const opts = () => ({ onQueued: (n) => told.push(n), onWaiting: (t) => takeOuts.push(t) });
    const a = withConversationTurn("c-6", async () => "a", opts());
    const b = withConversationTurn("c-6", async () => "b", opts());
    takeOuts[0]();
    const c = withConversationTurn("c-6", async () => "c", opts());
    assert.deepEqual(told, [1, 2, 2], "c waits behind the reply running and b, not a");
    await ahead.release();
    assert.deepEqual(await Promise.all([a, b, c]), [QUEUE_REMOVED, "b", "c"]);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(queueDepth("c-6"), 0);
  });

  it("a turn that comes just as the reply ahead ends, with only a turn taken out left before it, is not told it is queued", async () => {
    // A taken-out turn's own slot comes a moment after the reply ahead of it ends. A turn that comes in that moment
    // (a few steps after that reply's promise settles) has nothing really ahead of it: no "⏳ Queued (0 ahead)." and no
    // "Queued" line.
    for (let steps = 0; steps < 8; steps++) {
      _resetConversationLocks();
      const ahead = running("c-7");
      let takeOut;
      const removedOne = withConversationTurn("c-7", async () => "never", { live: { source: "telegram", prompt: "a" }, onWaiting: (t) => { takeOut = t; } });
      assert.equal(takeOut(), true);
      const told = [];
      let lines = null;
      let late = null;
      let p = ahead.ended;
      for (let i = 0; i < steps; i++) p = p.then(() => {});
      const came = p.then(() => {
        late = withConversationTurn("c-7", async () => "late", { live: { source: "telegram", prompt: "b" }, onQueued: (n) => told.push(n) });
        lines = live.queuedTurnList("c-7").length;
      });
      await ahead.release();
      await came;
      assert.equal(await late, "late");
      assert.equal(await removedOne, QUEUE_REMOVED);
      assert.ok(!told.includes(0), `${steps} steps after: told ${JSON.stringify(told)}`);
      assert.equal(lines, told.length, `${steps} steps after: a "Queued" line only when it really waits`);
    }
  });
});

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

describe("Discord: a message taken out of the queue by the Stop on its \"Queued\" line", () => {
  it("stops showing \"typing\" at once, though the reply ahead of it still runs, and never runs", async () => {
    const asked = [];
    async function* model(opts) { asked.push(opts); yield { type: "done", stopReason: "end_turn" }; }
    // Every timer the bot starts is kept, so one left running can be ended after the test: else it would keep this
    // test's process open for good.
    const timers = new Set();
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (...args) => { const t = realSetInterval(...args); timers.add(t); return t; };
    const bot = await createDiscordBot({ token: "test-discord-token-not-real" }, db, { Client: FakeDiscordClient, chatStream: model, typingEveryMs: 20 });
    const typing = [];
    const conv = convs.create({ title: "busy" }).id;
    settings.set("channel_conv.discord:DM-Q1", conv);
    const ahead = running(conv);
    try {
      FakeDiscordClient.last.emit("messageCreate", {
        id: "m-1",
        author: { bot: false, id: "U42", username: "sam" },
        guild: null,
        channel: { id: "DM-Q1", isThread: () => false, sendTyping: async () => { typing.push(Date.now()); }, messages: { fetch: async () => null } },
        content: "never mind this one",
        attachments: new Map(),
        mentions: { has: () => false },
        reference: null,
        reactions: { cache: new Map() },
        react: async () => {},
        reply: async (text) => ({ text, edit: async () => {}, delete: async () => {} }),
      });
      assert.ok(await until(() => live.queuedTurnList(conv).length === 1 && typing.length >= 3), "it waits behind that reply, showing \"typing\"");
      assert.equal(removeQueuedTurn(live.queuedTurnList(conv)[0].turnId, conv), true, "the Stop on its line takes it out");
      await sleep(50);
      const at = typing.length;
      await sleep(300);
      assert.equal(typing.length, at, "no more \"typing\" for it");
      await ahead.release();
      await sleep(200);
      assert.equal(typing.length, at, "nor after the reply ahead ends");
      assert.equal(asked.length, 0, "it never ran");
    } finally {
      globalThis.setInterval = realSetInterval;
      await ahead.release();
      await bot.stop();
      for (const t of timers) clearInterval(t);
    }
  });
});

describe("WhatsApp: a message taken out of the queue by the Stop on its \"Queued\" line", () => {
  it("stops showing \"typing\" at once, though the reply ahead of it still runs, and never runs", async () => {
    const CHAT = "447700900126@s.whatsapp.net";
    const presence = [];
    const server = http.createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/health") {
        res.end(JSON.stringify({ status: { text: "AUTH" }, user: { id: "447700900001", name: "Tarsee" } }));
        return;
      }
      if (req.url.startsWith("/presences/")) presence.push(Date.now());
      res.end(JSON.stringify({ sent: true, message: { id: "out-1" } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const asked = [];
    async function* model(opts) { asked.push(opts); yield { type: "done", stopReason: "end_turn" }; }
    const bot = await createWhatsAppBot(
      { token: "test-whapi-token-not-real", baseUrl: `http://127.0.0.1:${server.address().port}` },
      db,
      { healthTimeoutMs: 2000, chatStream: model, typingEveryMs: 20 },
    );
    const conv = convs.create({ title: "busy" }).id;
    settings.set(`channel_conv.whatsapp:${CHAT}`, conv);
    const ahead = running(conv);
    try {
      const handled = bot.handleInbound({ messages: [{ id: "wamid-q1", chat_id: CHAT, from_name: "Sam", from_me: false, type: "text", text: { body: "never mind this one" } }] });
      assert.ok(await until(() => live.queuedTurnList(conv).length === 1 && presence.length >= 3), "it waits behind that reply, showing \"typing\"");
      assert.equal(removeQueuedTurn(live.queuedTurnList(conv)[0].turnId, conv), true, "the Stop on its line takes it out");
      await sleep(50);
      const at = presence.length;
      await sleep(300);
      assert.equal(presence.length, at, "no more \"typing\" for it");
      await ahead.release();
      await handled;
      await sleep(100);
      assert.equal(presence.length, at, "nor after the reply ahead ends");
      assert.equal(asked.length, 0, "it never ran");
    } finally {
      await ahead.release();
      await bot.stop();
      server.closeAllConnections?.();
      server.close();
    }
  });
});
