// The first RAILWAY_API_TOKEN (src/lib/key-vault.js SERVER_ONLY_KEYS) is saved by the owner only: in Settings > Keys,
// or by set_key in a turn of the dashboard's chat sent with the owner's live sign-in. Never from a chat bot, email or
// the API, whoever sent the message, and never from background work.
// The reviewer's case: set_key took any turn with a conversation as allowed, so with no token yet, an email from anyone
// (with the email channel's own tool context) saved an attacker's token, and tarsee_railway then worked on their
// account. A group member on Telegram, Discord, Slack or WhatsApp could do the same, and so could a script holding the
// API token (which the AI's shell can read): a heartbeat could call /api/v1/chat/completions and save one itself.
// Now the dashboard's chat says so in its tool context (ownerSignedIn, from the live sign-in, as the owner's commands
// /cron, /briefing and /webhook decide it), and the vault takes a first save from set_key only with it. Every other
// tool context Tarsee builds (each chat bot's, email's, the API's, the call's, background work's) never says so, and
// the refusal tells the AI to ask the owner to save it in Settings > Keys.
// The chat route and the WebSocket run for real behind the real sign-in and token checks, with a scripted engine
// (test/fakes/fake-engine.js) that calls tarsee_set_key through Tarsee's own MCP server with the turn's context.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import WebSocket from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-owner-turn-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "4".repeat(40);
for (const name of ["RAILWAY_API_TOKEN", "TARSEE_AGENT_ENV_KEYS", "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
process.env.CLAUDE_CODE_OAUTH_TOKEN = ["test", "canary", "claude", "oauth", "owner-turn"].join("-");
const API_TOKEN = ["test", "canary", "api", "token", "owner-turn-0000"].join("-");
process.env.TARSEE_API_TOKEN = API_TOKEN;

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const live = await import("../src/lib/live-bus.js");
const { sessionAuth, requireAuth, createSession, destroySession, initSessionStore } = await import("../src/middleware/auth.js");
const { registerEngine, configureTurns } = await import("../src/ai/turn.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
const { executeTool } = await import("../src/lib/tools.js");
const vault = await import("../src/lib/key-vault.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
initSessionStore(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);
const VAULT_FILE = path.join(tmp, "data", "vault.json");
const TOKEN = ["rw", "test", "canary", "owner", "0000-1111-2222"].join("-");
const ASK_THE_OWNER = /Ask the owner to save it in Settings > Keys\./;

const quiet = async (fn) => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};

/** What tarsee_set_key answers with this tool context, through Tarsee's own MCP server, as an engine calls it. */
async function setKeyThroughMcp(ctx) {
  const server = createTarseeMcp(ctx, { quiet: true });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
  try {
    const res = await quiet(() => client.callTool({ name: "tarsee_set_key", arguments: { key: "RAILWAY_API_TOKEN", value: TOKEN } }));
    return { error: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
  } finally {
    await client.close();
  }
}

/** The engine: each turn calls tarsee_set_key with the turn's tool context, as the AI would, and says what came back. */
let answers = [];
const engine = createFakeEngine((opts) => setKeyThroughMcp(opts.toolCtx).then((got) => {
  answers.push({ ctx: opts.toolCtx, ...got });
  return [{ type: "text", content: got.error ? "Couldn't save it." : "Saved." }, { type: "done", stopReason: "end_turn" }];
}));

let server;
let base;
let port;
let restore;
before(async () => {
  const { chatRouter } = await import("../src/routes/chat.js");
  const { setupWebSocket } = await import("../src/channels/websocket.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.set("db", db);
  app.set("settingsStore", settings);
  // As src/server.js has them: who is asking (the token or the sign-in), then the router behind its check.
  app.use(sessionAuth);
  app.use("/api/chat", requireAuth, chatRouter);
  server = http.createServer(app);
  setupWebSocket(server, db, app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  restore = configureTurns({ recordUsage: () => {}, grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "t", revoke() {} }) });
  registerEngine("claude-code", engine);
});
beforeEach(() => {
  answers = [];
  try { fs.rmSync(VAULT_FILE, { force: true }); } catch { /* none yet */ }
  delete process.env.RAILWAY_API_TOKEN;
});
after(async () => {
  restore?.();
  registerEngine("claude-code", null);
  server?.closeAllConnections?.();
  await new Promise((r) => (server ? server.close(r) : r()));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a temp folder left behind */ }
});

/** A message to the dashboard's chat route (POST /api/chat/send), with a sign-in's cookie and/or the API token. */
async function sendOverHttp({ sessionId, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) headers.Cookie = `tarsee_session=${sessionId}`;
  if (token) headers.Authorization = `Bearer ${token}`;
  const conv = convs.create({ title: "web" }).id;
  const res = await fetch(`${base}/api/chat/send`, { method: "POST", headers, body: JSON.stringify({ conversationId: conv, message: "Here is my Railway token, save it" }) });
  assert.equal(res.status, 200, await res.clone().text());
  await res.text();
  assert.equal(answers.length, 1, "the turn ran once");
  return answers[0];
}

/** The same message over the dashboard's WebSocket, opened with a sign-in's cookie or the API token. */
async function sendOverSocket({ sessionId, token } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`, sessionId ? { headers: { Cookie: `tarsee_session=${sessionId}` } } : {});
  const got = [];
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); }
    return false;
  };
  try {
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    assert.ok(await until(() => got.some((m) => m.type === "auth_ok")), JSON.stringify(got));
    const conv = convs.create({ title: "web" }).id;
    ws.send(JSON.stringify({ type: "chat", conversationId: conv, message: "Here is my Railway token, save it" }));
    assert.ok(await until(() => got.some((m) => m.type === "done")), JSON.stringify(got));
  } finally {
    ws.terminate();
  }
  assert.equal(answers.length, 1, "the turn ran once");
  return answers[0];
}

describe("the dashboard's chat: the first save only with the owner's live sign-in", () => {
  it("over HTTP, signed in: saved, and the turn's context says the owner is signed in", async () => {
    const got = await sendOverHttp({ sessionId: createSession("127.0.0.1"), token: API_TOKEN });
    assert.equal(got.error, false, got.text);
    assert.match(got.text, /^Key "RAILWAY_API_TOKEN" saved securely/);
    assert.equal(got.ctx.ownerSignedIn, true);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
  });

  it("over HTTP with the API token alone, or a sign-in that has ended: refused, and the AI is told to ask the owner", async () => {
    const ended = createSession("127.0.0.1");
    destroySession(ended);
    for (const who of [{ token: API_TOKEN }, { token: API_TOKEN, sessionId: ended }]) {
      answers = [];
      const got = await sendOverHttp(who);
      assert.equal(got.error, true, got.text);
      assert.match(got.text, /RAILWAY_API_TOKEN wasn't saved/);
      assert.match(got.text, ASK_THE_OWNER);
      assert.ok(!got.text.includes(TOKEN));
      assert.notEqual(got.ctx.ownerSignedIn, true);
    }
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), null);
  });

  it("over the WebSocket: saved with the sign-in's cookie, refused with ?token= alone", async () => {
    const refused = await sendOverSocket({ token: API_TOKEN });
    assert.equal(refused.error, true, refused.text);
    assert.match(refused.text, ASK_THE_OWNER);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), null);
    answers = [];
    const saved = await sendOverSocket({ sessionId: createSession("127.0.0.1") });
    assert.equal(saved.error, false, saved.text);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Every tool context Tarsee builds, as its own source writes it: only the dashboard's two say the owner is signed in,
// each from the live sign-in, and set_key refuses a first save with any of the others.

const SRC = new URL("../src/", import.meta.url);
/** Each `const toolCtx = { ... }` in src, by file: its text, and its keys. */
function toolContexts() {
  const out = [];
  for (const f of fs.readdirSync(SRC, { recursive: true }).filter((p) => p.endsWith(".js") && !p.startsWith("public"))) {
    const file = f.split(path.sep).join("/");
    const src = fs.readFileSync(new URL(file, SRC), "utf8");
    for (const m of src.matchAll(/const toolCtx = \{/g)) {
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === "{") depth++;
        else if (src[end] === "}" && --depth === 0) break;
      }
      const body = src.slice(m.index + m[0].length, end).replace(/\/\/[^\n]*/g, "");
      assert.ok(!body.includes("..."), `${file}: a spread in a tool context: read it by hand`);
      const keys = body.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
        const [key, ...value] = p.split(":");
        return [key.trim(), value.join(":").trim()];
      });
      out.push({ file, body, keys });
    }
  }
  return out;
}
/** The context built from those keys: a chat for conversationId, the literals as written, a stand-in for the rest. */
function ctxOf(keys) {
  const ctx = {};
  for (const [key, value] of keys) {
    if (key === "conversationId") ctx[key] = "test-chat-0001";
    else if (value === "true" || value === "false") ctx[key] = value === "true";
    else if (/^"[^"]*"$/.test(value)) ctx[key] = value.slice(1, -1);
    else if (value === "null") ctx[key] = null;
    else ctx[key] = {};
  }
  return ctx;
}

describe("every tool context Tarsee builds", () => {
  const all = toolContexts();

  it("each channel's is found: Telegram, Discord, Slack, WhatsApp, email, the API, the dashboard's two", () => {
    const files = new Set(all.map((c) => c.file));
    for (const f of ["channels/telegram.js", "channels/discord.js", "channels/slack.js", "channels/whatsapp.js", "channels/email.js", "routes/external-api.js", "routes/chat.js", "channels/websocket.js"]) {
      assert.ok(files.has(f), `${f}: ${[...files].join(", ")}`);
    }
  });

  it("only the dashboard's two say the owner is signed in, and each from the live sign-in", () => {
    const saying = all.filter((c) => c.keys.some(([k]) => k === "ownerSignedIn"));
    assert.deepEqual(saying.map((c) => c.file).sort(), ["channels/websocket.js", "routes/chat.js"]);
    const valueOf = (file) => saying.find((c) => c.file === file).keys.find(([k]) => k === "ownerSignedIn")[1];
    assert.equal(valueOf("routes/chat.js"), "!!liveSessionId(req)");
    assert.equal(valueOf("channels/websocket.js"), "isLiveSession(ws._signInId)");
  });

  it("with any other one, set_key refuses the first save, and says to ask the owner", async () => {
    const others = all.filter((c) => !c.keys.some(([k]) => k === "ownerSignedIn"));
    assert.ok(others.length >= 8, `${others.length} found`);
    for (const { file, keys } of others) {
      const ctx = ctxOf(keys);
      const out = await quiet(() => executeTool("set_key", { name: "RAILWAY_API_TOKEN", value: TOKEN }, ctx));
      assert.match(out, /^set_key refused: RAILWAY_API_TOKEN wasn't saved/, `${file}: ${out}`);
      assert.match(out, ASK_THE_OWNER, `${file}: ${out}`);
      assert.ok(!out.includes(TOKEN));
      const mcp = await setKeyThroughMcp(ctx);
      assert.equal(mcp.error, true, `${file}: ${mcp.text}`);
    }
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), null);
  });

  it("the owner's mark doesn't let background work save it", async () => {
    for (const background of ["cron", "heartbeat", "boot"]) {
      const out = await quiet(() => executeTool("set_key", { name: "RAILWAY_API_TOKEN", value: TOKEN }, { conversationId: "c-1", dashboard: true, ownerSignedIn: true, background }));
      assert.match(out, /background work .* never saves Tarsee's own keys/, out);
    }
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), null);
  });
});
