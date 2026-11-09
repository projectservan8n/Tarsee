// Stop mid-reply in the web chat (routes/chat.js) and the dashboard's WebSocket chat (channels/websocket.js): the
// turn layer ends a stopped turn with one done{aborted}, and the done sent to the tab that pressed Stop says so
// (stopReason "stopped", as a queued turn taken out of the queue already does), so that tab shows the reply as
// stopped rather than finished. A reply that finishes says "end_turn". Engines are scripted (test/fakes/fake-engine.js).
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import WebSocket from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-chat-stop-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";
const API_TOKEN = "test-canary-api-token-stop-0000";
process.env.TARSEE_API_TOKEN = API_TOKEN;

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const live = await import("../src/lib/live-bus.js");
const { registerEngine, configureTurns } = await import("../src/ai/turn.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

let engine;
let restore;
let server;
let base;

const sse = (raw) => raw.split("\n\n").filter(Boolean).map((chunk) => {
  const ev = /^event: (.+)$/m.exec(chunk)?.[1];
  const data = /^data: (.+)$/m.exec(chunk)?.[1];
  return { event: ev, data: data ? JSON.parse(data) : null };
});
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  const { chatRouter } = await import("../src/routes/chat.js");
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.set("db", db);
  app.set("settingsStore", settings);
  app.use("/api/chat", chatRouter);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}/api/chat`;
});
beforeEach(() => {
  restore?.();
  restore = configureTurns({ recordUsage: () => {}, grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "t", revoke() {} }) });
});
after(() => {
  restore?.();
  registerEngine("claude-code", null);
  registerEngine("codex", null);
  server?.closeAllConnections?.();
  server?.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the web chat's done says how the reply ended", () => {
  it("Stop mid-reply: one done, with stopReason \"stopped\", and the partial reply is kept", async () => {
    engine = createFakeEngine([[{ type: "text", content: "Half an ans" }, { type: "wait" }]]);
    registerEngine("claude-code", engine);
    const conv = convs.create({ title: "web" }).id;
    const sending = post("/send", { conversationId: conv, message: "write me a long essay" }).then((r) => r.text());
    assert.ok(await until(() => engine.calls.length === 1), "the turn began");
    await new Promise((r) => setTimeout(r, 50));
    const stop = await (await post("/stop", { conversationId: conv })).json();
    assert.equal(stop.stopped, true);
    const events = sse(await sending);
    const dones = events.filter((e) => e.event === "done");
    assert.equal(dones.length, 1, events.map((e) => e.event).join(", "));
    assert.equal(dones[0].data.stopReason, "stopped");
    assert.equal(dones[0].data.conversationId, conv);
    assert.ok(!events.some((e) => e.event === "error"), "a stop is not an error");
    const saved = convs.getMessages(conv).filter((m) => m.role === "assistant");
    assert.equal(saved.length, 1);
    assert.match(saved[0].content, /Half an ans/);
  });

  it("a reply that finishes: stopReason \"end_turn\"", async () => {
    engine = createFakeEngine([[{ type: "text", content: "All done." }, { type: "done", stopReason: "end_turn" }]]);
    registerEngine("claude-code", engine);
    const conv = convs.create({ title: "web" }).id;
    const events = sse(await (await post("/send", { conversationId: conv, message: "hi" })).text());
    const dones = events.filter((e) => e.event === "done");
    assert.equal(dones.length, 1);
    assert.equal(dones[0].data.stopReason, "end_turn");
    assert.ok(dones[0].data.model, "the model that ran, as before");
  });
});

describe("the dashboard's WebSocket chat: its done says how the reply ended", () => {
  let wsServer;
  let port;
  before(async () => {
    const { setupWebSocket } = await import("../src/channels/websocket.js");
    wsServer = http.createServer();
    setupWebSocket(wsServer, db, { get: () => null });
    await new Promise((r) => wsServer.listen(0, "127.0.0.1", r));
    port = wsServer.address().port;
  });
  after(() => {
    wsServer?.closeAllConnections?.();
    wsServer?.close();
  });

  /** Open a socket, send one chat message, run during(ws, got) while it runs; what came back. */
  async function chatOverSocket(payload, during = null) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${API_TOKEN}`);
    const got = [];
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    try {
      await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
      assert.ok(await until(() => got.some((m) => m.type === "auth_ok")));
      ws.send(JSON.stringify({ type: "chat", ...payload }));
      if (during) await during(ws, got);
      assert.ok(await until(() => got.some((m) => m.type === "done")), JSON.stringify(got));
      return got;
    } finally {
      ws.terminate();
    }
  }

  it("Stop mid-reply: one done, with stopReason \"stopped\"", async () => {
    engine = createFakeEngine([[{ type: "text", content: "Half an ans" }, { type: "wait" }]]);
    registerEngine("claude-code", engine);
    const conv = convs.create({ title: "web" }).id;
    const got = await chatOverSocket({ conversationId: conv, message: "write me a long essay" }, async (ws, seen) => {
      assert.ok(await until(() => seen.some((m) => m.type === "text")), "the reply began");
      ws.send(JSON.stringify({ type: "stop" }));
    });
    const dones = got.filter((m) => m.type === "done");
    assert.equal(dones.length, 1, got.map((m) => m.type).join(", "));
    assert.equal(dones[0].stopReason, "stopped");
    assert.ok(!got.some((m) => m.type === "error"), "a stop is not an error");
  });

  it("a reply that finishes: stopReason \"end_turn\"", async () => {
    engine = createFakeEngine([[{ type: "text", content: "All done." }, { type: "done", stopReason: "end_turn" }]]);
    registerEngine("claude-code", engine);
    const conv = convs.create({ title: "web" }).id;
    const got = await chatOverSocket({ conversationId: conv, message: "hi" });
    const dones = got.filter((m) => m.type === "done");
    assert.equal(dones.length, 1);
    assert.equal(dones[0].stopReason, "end_turn");
  });
});
