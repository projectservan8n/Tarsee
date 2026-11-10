// Voice calls, the server's side (src/lib/voice-call.js, src/routes/voice-call.js): what a call's message is, the
// call's own chat ("Calls with <name>"), the deep ask on the call AI's top tier, and the hang-up handoff: hung up
// while the AI was still working, its answer goes to the channel chosen in Settings > Voice > Calls (Off by default)
// through the send_message tool. The browser's side is test/call-browser.test.js.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-voice-call-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const live = await import("../src/lib/live-bus.js");
const { configureTurns } = await import("../src/ai/turn.js");
const call = await import("../src/lib/voice-call.js");
const { callRouter } = await import("../src/routes/voice-call.js");

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const DEEPSEEK_KEY = "sk-testcanarydeepseek0000000000";

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** A channel manager with these channels running, recording what it sends. */
function channels(running = ["telegram"]) {
  const sent = [];
  return {
    sent,
    getStatus: () => Object.fromEntries(["telegram", "discord", "slack", "whatsapp"].map((id) => [id, { status: running.includes(id) ? "running" : "stopped" }])),
    async sendMessage(type, chatId, message, opts) { sent.push({ type, chatId, message, threadId: opts?.threadId ?? null }); },
  };
}

const timeline = (text) => JSON.stringify({ __timeline: true, items: [{ type: "tool", name: "Bash", status: "done" }, { type: "text", text }], text });

beforeEach(() => {
  for (const prefix of ["call.", "identity.", "channel_conv.", "ai.", "session."]) for (const { key } of settings.getByPrefix(prefix)) settings.delete(key);
});

describe("a call's message", () => {
  it("is marked [call]; the mark comes off", () => {
    assert.deepEqual(call.callTurn("[call] what's on today?"), { isCall: true, text: "what's on today?" });
    assert.deepEqual(call.callTurn("what's on today?"), { isCall: false, text: "what's on today?" });
    assert.deepEqual(call.callTurn("[call]"), { isCall: true, text: "" });
    assert.deepEqual(call.callTurn(undefined), { isCall: false, text: "" });
  });

  it("the AI is told every word is spoken, in words that name no one", () => {
    assert.match(call.CALL_HINT, /voice call/i);
    assert.match(call.CALL_HINT, /read aloud/);
    assert.match(call.CALL_TURN_REMINDER, /spoken sentences/);
    for (const text of [call.CALL_HINT, call.CALL_TURN_REMINDER]) assert.doesNotMatch(text, /\b(nico|tony|telegram|opus)\b/i);
  });
});

describe("the call's chat", () => {
  it("is made once, named after the name in Settings > Identity (Tarsee when none is set)", () => {
    const first = call.callConversation({ settingsStore: settings, convStore: convs });
    assert.equal(first.created, true);
    assert.equal(first.title, "Calls with Tarsee");
    assert.equal(convs.get(first.id).title, "Calls with Tarsee");
    assert.equal(settings.get(`channel_conv.${call.CALL_CHANNEL_KEY}`), first.id);
    const again = call.callConversation({ settingsStore: settings, convStore: convs });
    assert.equal(again.id, first.id);
    assert.equal(again.created, false);

    settings.set("identity.name", "Atlas");
    const renamed = call.callConversation({ settingsStore: settings, convStore: convs });
    assert.equal(renamed.id, first.id);
    assert.equal(convs.get(first.id).title, "Calls with Atlas", "a new name in Settings names the chat again");

    convs.updateTitle(first.id, "Morning calls");
    assert.equal(call.callConversation({ settingsStore: settings, convStore: convs }).title, "Morning calls", "a name the owner gave it stays");
  });

  it("a blank name is no name", () => {
    settings.set("identity.name", "   ");
    assert.equal(call.botNameOf(settings), "Tarsee");
    assert.equal(call.callTitle(""), "Calls with Tarsee");
  });
});

describe("the call's chat in the sidebar (public/js/chat-core.js)", () => {
  it("has a group of its own, Calls, after the channels, and keeps its name", async () => {
    await import("../src/public/js/chat-core.js");
    const C = globalThis.ChatCore;
    const at = new Date().toISOString().replace("T", " ").slice(0, 19);
    const groups = C.groupChats([
      { key: "call:default", platform: "call", title: "Calls with Atlas", conversationId: "c1", updatedAt: at },
      { key: "slack:C1:thread:1", platform: "slack", title: "#general", conversationId: "c2", updatedAt: at },
    ], { now: Date.now() });
    const ids = groups.map((g) => g.id);
    assert.ok(ids.indexOf("call") > ids.indexOf("slack"), JSON.stringify(ids));
    const calls = groups.find((g) => g.id === "call");
    assert.equal(calls.label, "Calls");
    assert.deepEqual(calls.rows.map((r) => r.name), ["Calls with Atlas"]);
  });
});

describe("a reply's words", () => {
  it("timeline JSON gives its text; tool-call markup comes out", () => {
    assert.equal(call.replyWords(timeline("Two meetings today.")), "Two meetings today.");
    assert.equal(call.replyWords('{"__timeline":true,"items":[],"text":""}'), "");
    assert.equal(call.replyWords("Done.<tool_call>{\"name\":\"x\"}</tool_call>"), "Done.");
    assert.equal(call.replyWords('{"__timeline":true, broken'), "");
  });
});

describe("the hang-up handoff", () => {
  it("sends the next reply's words (not its saved JSON) to the chosen channel, once", async () => {
    const conv = convs.create({ title: "Calls with Tarsee" }).id;
    const sent = [];
    assert.equal(call.startHandoff({ conversationId: conv, channel: "telegram", send: async (ch, text) => { sent.push({ ch, text }); return { ok: true }; } }), true);
    assert.equal(call.handoffPending(conv), true);
    convs.addMessage(conv, { role: "assistant", content: timeline("You have two meetings today.") });
    assert.ok(await until(() => sent.length === 1));
    assert.deepEqual(sent[0], { ch: "telegram", text: "From our call:\n\nYou have two meetings today." });
    assert.equal(call.handoffPending(conv), false);
    convs.addMessage(conv, { role: "assistant", content: "A later reply." });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1, "only the answer it was waiting for");
  });

  it("skips the person's own words, other chats' replies and a reply with no words yet", async () => {
    const conv = convs.create({ title: "Calls with Tarsee" }).id;
    const other = convs.create({ title: "elsewhere" }).id;
    const sent = [];
    call.startHandoff({ conversationId: conv, channel: "discord", send: async (ch, text) => { sent.push(text); return { ok: true }; } });
    convs.addMessage(conv, { role: "user", content: "and the weather?" });
    convs.addMessage(other, { role: "assistant", content: "Not this one." });
    convs.addMessage(conv, { role: "assistant", content: '{"__timeline":true,"items":[{"type":"tool","name":"Bash"}],"text":""}' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(sent, []);
    assert.equal(call.handoffPending(conv), true, "still waiting for the words");
    convs.addMessage(conv, { role: "assistant", content: "Sunny." });
    assert.ok(await until(() => sent.length === 1));
    assert.equal(sent[0], "From our call:\n\nSunny.");
  });

  it("two things said before the hang-up: both answers go", async () => {
    const conv = convs.create({ title: "Calls with Tarsee" }).id;
    const sent = [];
    call.startHandoff({ conversationId: conv, channel: "telegram", send: async (ch, text) => { sent.push(text); return { ok: true }; } });
    // The second message waits behind the first (lib/conversation-lock.js puts it on the timeline as queued).
    live.publish(conv, "turn_queued", { source: "web" }, { turnId: "t-second" });
    convs.addMessage(conv, { role: "assistant", content: "First answer." });
    assert.ok(await until(() => sent.length === 1));
    assert.equal(call.handoffPending(conv), true, "the second answer is still to come");
    live.publish(conv, "turn_start", { source: "web" }, { turnId: "t-second" });
    live.publish(conv, "turn_end", { stopReason: "end_turn" }, { turnId: "t-second" });
    convs.addMessage(conv, { role: "assistant", content: "Second answer." });
    assert.ok(await until(() => sent.length === 2));
    assert.deepEqual(sent, ["From our call:\n\nFirst answer.", "From our call:\n\nSecond answer."]);
    assert.equal(call.handoffPending(conv), false);
  });

  it("a new call cancels it, and so does the end of its window", async () => {
    const conv = convs.create({ title: "Calls with Tarsee" }).id;
    const sent = [];
    const send = async (ch, text) => { sent.push(text); return { ok: true }; };
    call.startHandoff({ conversationId: conv, channel: "telegram", send });
    call.cancelHandoff(conv);
    assert.equal(call.handoffPending(conv), false);
    convs.addMessage(conv, { role: "assistant", content: "Heard on the new call." });
    call.startHandoff({ conversationId: conv, channel: "telegram", send, windowMs: 30 });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(call.handoffPending(conv), false, "the window ran out");
    convs.addMessage(conv, { role: "assistant", content: "Too late." });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(sent, []);
  });

  it("Tarsee's send path: the send_message tool, to the channel's latest chat; a failure is said, not thrown", async () => {
    const mgr = channels(["telegram"]);
    const old = convs.create({ title: "old" }).id;
    const recent = convs.create({ title: "recent" }).id;
    settings.set("channel_conv.telegram:111", old);
    settings.set("channel_conv.telegram:222", recent);
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m-old', ?, 'user', 'hi', 1000)").run(old);
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m-new', ?, 'user', 'hi', 9000)").run(recent);
    const send = call.sendThroughChannel({ db, settingsStore: settings, channelManager: mgr });
    const r = await send("telegram", "From our call:\n\nDone.");
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(mgr.sent, [{ type: "telegram", chatId: "222", message: "From our call:\n\nDone.", threadId: null }]);
    const none = await send("discord", "x");
    assert.equal(none.ok, false);
    assert.match(none.detail, /discord/i);
  });
});

describe("Settings > Voice > Calls: where the answer goes", () => {
  it("lists the connected channels, Off by default; a chosen one that isn't connected stays listed", () => {
    const mgr = channels(["telegram", "slack"]);
    assert.deepEqual(call.handoffChoices({ settingsStore: settings, channelManager: mgr }), {
      channel: null,
      choices: [{ id: "telegram", label: "Telegram", connected: true }, { id: "slack", label: "Slack", connected: true }],
    });
    assert.equal(call.handoffTarget({ settingsStore: settings, channelManager: mgr }), null, "Off: the answer stays in the call's chat");
    settings.set(call.HANDOFF_SETTING, "discord");
    assert.deepEqual(call.handoffChoices({ settingsStore: settings, channelManager: mgr }).choices.map((c) => `${c.id}:${c.connected}`), ["telegram:true", "discord:false", "slack:true"]);
    assert.equal(call.handoffTarget({ settingsStore: settings, channelManager: mgr }), null, "chosen but not connected: nowhere to send it");
    settings.set(call.HANDOFF_SETTING, "slack");
    assert.deepEqual(call.handoffTarget({ settingsStore: settings, channelManager: mgr }), { channel: "slack", label: "Slack" });
    settings.set(call.HANDOFF_SETTING, "email");
    assert.equal(call.handoffChoices({ settingsStore: settings, channelManager: mgr }).channel, null, "not a channel an answer can go to");
  });
});

describe("the deep ask: the call AI's top tier, only when it has one", () => {
  let restore;
  before(() => { restore = configureTurns({ chatgptModels: async () => {}, localModels: async () => {} }); });
  after(() => restore?.());

  it("DeepSeek runs Flash and has Pro on top", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const conv = convs.create({ title: "Calls with Tarsee" }).id;
    const deep = await call.deepAsk({ settingsStore: settings, conversationId: conv });
    assert.equal(deep?.model, "top");
    assert.match(deep.label, /pro/i);
  });

  it("a chat already on its top model, or an AI with no tiers (the ChatGPT plan), has none", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const conv = convs.create({ title: "Calls with Tarsee" }).id;
    settings.set(`session.${conv}.provider`, "deepseek");
    settings.set(`session.${conv}.model`, "deepseek:deepseek-v4-pro");
    assert.equal(await call.deepAsk({ settingsStore: settings, conversationId: conv }), null);

    for (const { key } of settings.getByPrefix("ai.")) settings.delete(key);
    settings.set("ai.activeProvider", "chatgpt");
    const plain = convs.create({ title: "Calls with Tarsee" }).id;
    assert.equal(await call.deepAsk({ settingsStore: settings, conversationId: plain }), null);
  });
});

describe("the routes (/api/call)", () => {
  let server;
  let base;
  let mgr;
  before(async () => {
    mgr = channels(["telegram"]);
    const app = express();
    app.use(express.json());
    app.set("db", db);
    app.set("settingsStore", settings);
    app.set("channelManager", mgr);
    app.use("/api/call", callRouter);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api/call`;
  });
  after(() => { server?.closeAllConnections?.(); server?.close(); });
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const put = (p, body) => fetch(`${base}${p}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

  it("POST /start: the call's chat and name, the same chat every time, and an answer still waiting is heard now", async () => {
    settings.set("identity.name", "Atlas");
    const a = await (await post("/start")).json();
    assert.equal(a.title, "Calls with Atlas");
    assert.equal(a.botName, "Atlas");
    assert.equal(a.handoff, null, "Off by default");
    assert.ok(a.conversationId);
    call.startHandoff({ conversationId: a.conversationId, channel: "telegram", send: async () => ({ ok: true }) });
    const b = await (await post("/start")).json();
    assert.equal(b.conversationId, a.conversationId);
    assert.equal(call.handoffPending(a.conversationId), false, "a new call: the answer will be heard, not sent");
  });

  it("GET and PUT /settings: Off, a connected channel, and nothing else", async () => {
    assert.deepEqual(await (await fetch(`${base}/settings`)).json(), { channel: null, choices: [{ id: "telegram", label: "Telegram", connected: true }] });
    const ok = await (await put("/settings", { channel: "telegram" })).json();
    assert.equal(ok.channel, "telegram");
    assert.equal(settings.get(call.HANDOFF_SETTING), "telegram");
    const bad = await put("/settings", { channel: "email" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Off/);
    assert.equal((await (await put("/settings", { channel: "" })).json()).channel, null);
    assert.equal(settings.get(call.HANDOFF_SETTING) ?? null, null, "Off is no setting at all");
  });

  it("POST /handoff: Off leaves the answer in the call's chat; a chosen channel gets it through the send path", async () => {
    const { conversationId } = await (await post("/start")).json();
    const off = await (await post("/handoff", { conversationId })).json();
    assert.deepEqual(off, { ok: false, channel: null, label: null, reason: "off" });
    assert.equal(call.handoffPending(conversationId), false);

    settings.set(call.HANDOFF_SETTING, "discord");
    assert.equal((await (await post("/handoff", { conversationId })).json()).reason, "Discord isn't connected");

    settings.set(call.HANDOFF_SETTING, "telegram");
    settings.set("channel_conv.telegram:555", convs.create({ title: "tg" }).id);
    const on = await (await post("/handoff", { conversationId })).json();
    assert.deepEqual(on, { ok: true, channel: "telegram", label: "Telegram" });
    convs.addMessage(conversationId, { role: "assistant", content: timeline("All three invoices are paid.") });
    assert.ok(await until(() => mgr.sent.length === 1), JSON.stringify(mgr.sent));
    assert.deepEqual(mgr.sent[0], { type: "telegram", chatId: "555", message: "From our call:\n\nAll three invoices are paid.", threadId: null });

    assert.equal((await post("/handoff", { conversationId: "nope" })).status, 404);
  });
});
