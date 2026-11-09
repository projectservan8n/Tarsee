// The model lists a turn reads before it names a model (src/ai/turn.js resolveTarget and the backup model, design A2
// and 4.11). Two providers' lists live only in memory and are empty after every restart until something reads them:
//  - the ChatGPT account's own models (Codex's live list): a chosen ChatGPT model must not be dropped for Codex's
//    default after a redeploy just because nobody opened the dashboard's picker yet;
//  - Local AI's models (its server's /models): an install set up only through Railway variables, with no model
//    named, must not be refused as "no model chosen" after every restart.
// Engines are scripted (test/fakes/fake-engine.js); the Local AI server is a loopback stub. Every key is a fake.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-turn-lists-"));
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
const live = await import("../src/lib/live-bus.js");
const { runTurn, resolveTarget, registerEngine, configureTurns } = await import("../src/ai/turn.js");
const { setCatalogModels, catalogModels } = await import("../src/ai/provider-registry.js");
const { forgetLocalModelsRead } = await import("../src/ai/provider-models.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
const settings = new SettingsStore(db);
const DEEPSEEK_KEY = "sk-testcanarydeepseek0000000000";
const ACCOUNT = [
  { id: "gpt-6-luna", label: "GPT-6 Luna", default: true, efforts: ["low", "medium", "high"] },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
];

async function collect(gen) {
  const out = [];
  for await (const evt of gen) out.push(evt);
  return out;
}
const user = (content) => ({ role: "user", content });
const ctx = () => ({ db, settingsStore: settings, conversationId: null });
const ok = (text = "Done.") => [{ type: "text", content: text }, { type: "done", stopReason: "end_turn" }];

let restore = null;
let listReads = 0;
const engines = {};
function useEngines({ claude = [ok()], codex = [ok()] } = {}) {
  engines.claude = createFakeEngine(claude);
  engines.codex = createFakeEngine(codex);
  registerEngine("claude-code", engines.claude);
  registerEngine("codex", engines.codex);
}
/** The seams, with the ChatGPT sign-in counted as there and the account's list read by `lister` (counted). */
function seams(lister = async () => setCatalogModels("chatgpt-models", ACCOUNT), extra = {}) {
  restore?.();
  listReads = 0;
  restore = configureTurns({
    grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "test-mcp-token", revoke() {} }),
    recordUsage: () => {},
    chatgptModels: async () => { listReads++; return lister(); },
    providerStatus: async (id, store) => {
      if (id === "chatgpt") return { state: "ready" };
      const { providerStatus } = await import("../src/ai/provider-status.js");
      return providerStatus(id, { store, ignoreFlags: true });
    },
    ...extra,
  });
}

beforeEach(() => {
  for (const prefix of ["ai.", "session."]) for (const { key } of settings.getByPrefix(prefix)) settings.delete(key);
  setCatalogModels("chatgpt-models", []);
  setCatalogModels("local-models", []);
  forgetLocalModelsRead();
  delete process.env.TARSEE_LOCAL_AI_URL;
  delete process.env.TARSEE_AI_MODEL;
  seams();
  useEngines();
});

after(() => {
  restore?.();
  registerEngine("claude-code", null);
  registerEngine("codex", null);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the ChatGPT account's models after a restart", () => {
  it("a chosen ChatGPT model is kept: the account's list is read first, once", async () => {
    settings.set("ai.chatgpt.model", "gpt-6.1-sol");
    const { target } = await resolveTarget({ provider: "chatgpt", toolCtx: ctx() }, settings);
    assert.equal(target.model, "gpt-6.1-sol");
    assert.equal(target.engine, "codex");
    assert.equal(listReads, 1);
    await resolveTarget({ provider: "chatgpt", toolCtx: ctx() }, settings);
    assert.equal(listReads, 1, "a list that is there isn't read again");
  });

  it("with nothing chosen, the account's own default is named (so a model in Codex's config file can't run in its place)", async () => {
    const events = await collect(runTurn({ provider: "chatgpt", messages: [user("hi")], toolCtx: ctx() }));
    assert.equal(events[0].type, "route");
    assert.equal(events[0].model, "gpt-6-luna");
    assert.equal(engines.codex.calls[0].target.model, "gpt-6-luna");
    assert.equal(events.at(-1).stopReason, "end_turn");
  });

  it("a list that can't be read leaves the model to Codex, and the turn still runs", async () => {
    seams(async () => { throw new Error("codex app-server timed out"); });
    settings.set("ai.chatgpt.model", "gpt-6.1-sol");
    const events = await collect(runTurn({ provider: "chatgpt", messages: [user("hi")], toolCtx: ctx() }));
    assert.equal(listReads, 1);
    assert.equal(events[0].model, null, "never a model the account may not have");
    assert.equal(events.at(-1).stopReason, "end_turn");
  });

  it("with \"API keys only\" on, the turn is refused without starting Codex to read the account's list", async () => {
    settings.set("ai.keysOnly", true);
    settings.set("ai.chatgpt.model", "gpt-6.1-sol");
    const events = await collect(runTurn({ provider: "chatgpt", messages: [user("hi")], toolCtx: ctx() }));
    assert.equal(listReads, 0, "the ChatGPT sign-in is never used, not even to list its models");
    assert.equal(events.at(-1).stopReason, "blocked-keys-only");
    assert.equal(engines.codex.calls.length, 0);
  });

  it("other providers never read it", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    await collect(runTurn({ provider: "deepseek", messages: [user("hi")], toolCtx: ctx() }));
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctx() }));
    assert.equal(listReads, 0);
  });

  it("the backup model on ChatGPT names its model too", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    settings.set("ai.backupModel", "chatgpt:gpt-6.1-sol");
    useEngines({ claude: [[{ type: "error", message: "out of credit", code: "billing" }, { type: "done", stopReason: "error" }]], codex: [ok("From the backup.")] });
    const events = await collect(runTurn({ provider: "deepseek", messages: [user("hi")], toolCtx: ctx() }));
    const routes = events.filter((e) => e.type === "route");
    assert.equal(routes.length, 2);
    assert.equal(routes[1].provider, "chatgpt");
    assert.equal(routes[1].model, "gpt-6.1-sol");
    assert.equal(engines.codex.calls[0].target.model, "gpt-6.1-sol");
    assert.equal(catalogModels("chatgpt-models").length, 2);
  });
});

describe("Local AI set up only through Railway variables, after a restart", () => {
  function localServer(models) {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)),
    })));
  }

  it("with no model named, the first turn reads the server's list and runs on its first model instead of refusing", async () => {
    const server = await localServer(["llama3.1:8b", "qwen3"]);
    try {
      process.env.TARSEE_LOCAL_AI_URL = server.url;
      const events = await collect(runTurn({ provider: "local", messages: [user("hi")], toolCtx: ctx() }));
      assert.equal(events.filter((e) => e.type === "error").length, 0, JSON.stringify(events));
      assert.equal(events[0].model, "llama3.1:8b");
      assert.equal(engines.codex.calls[0].target.model, "llama3.1:8b");
      assert.deepEqual(server.requests, ["/v1/models"]);
      await collect(runTurn({ provider: "local", messages: [user("again")], toolCtx: ctx() }));
      assert.equal(server.requests.length, 1, "read once");
    } finally {
      await server.close();
    }
  });

  it("a model named (TARSEE_AI_MODEL) needs no read; a server that can't be reached is refused with both ways to fix it", async () => {
    const server = await localServer(["llama3.1:8b"]);
    try {
      process.env.TARSEE_LOCAL_AI_URL = server.url;
      process.env.TARSEE_AI_PROVIDER = "local";
      process.env.TARSEE_AI_MODEL = "qwen3";
      const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctx() }));
      assert.equal(events[0].model, "qwen3");
      assert.equal(server.requests.length, 0);
    } finally {
      delete process.env.TARSEE_AI_PROVIDER;
      await server.close();
    }
    delete process.env.TARSEE_AI_MODEL;
    process.env.TARSEE_LOCAL_AI_URL = "http://127.0.0.1:9/v1";
    const refused = await collect(runTurn({ provider: "local", messages: [user("hi")], toolCtx: ctx() }));
    assert.equal(refused.at(-1).stopReason, "not-ready");
    assert.match(refused[0].content, /no model chosen/);
    assert.match(refused[0].content, /TARSEE_AI_MODEL/);
    assert.equal(engines.codex.calls.length, 1, "the refused turn never started");
  });
});

describe("Local AI's one rule at the turn layer (the composer's menu and /model have it too)", () => {
  const LOCAL = "http://127.0.0.1:9/v1";
  const conv = "conv-local-rule";
  const inChat = () => ({ db, settingsStore: settings, conversationId: conv });
  beforeEach(() => {
    settings.set("ai.activeProvider", "local");
    settings.set("ai.local.baseUrl", LOCAL);
    setCatalogModels("local-models", [{ id: "llama3" }, { id: "qwen3" }, { id: "mistral" }]);
  });

  it("a chat's pick saved while it was the card's model, once the card moved on and it isn't verified, is refused", async () => {
    settings.set("ai.local.model", "qwen3");
    settings.set(`session.${conv}.provider`, "local");
    settings.set(`session.${conv}.model`, "local:llama3");
    const refused = await collect(runTurn({ messages: [user("hi")], toolCtx: inChat() }));
    assert.equal(refused.at(-1).stopReason, "needs-verification", JSON.stringify(refused));
    assert.match(refused.map((e) => e.content || e.message || "").join(" "), /llama3[\s\S]*hasn't been verified yet[\s\S]*Settings > AI/);
    assert.equal(engines.codex.calls.length, 0, "the turn never started");

    settings.set("ai.local.verified", { llama3: { engine: "codex", at: "2026-11-09T00:00:00.000Z", efforts: [] } });
    const ran = await collect(runTurn({ messages: [user("hi")], toolCtx: inChat() }));
    assert.equal(ran.filter((e) => e.type === "error").length, 0, JSON.stringify(ran));
    assert.equal(engines.codex.calls.at(-1).target.model, "llama3", "verified: it runs");
  });

  it("the card's model, its background model and, with none named, the first one the server lists still run unverified", async () => {
    settings.set("ai.local.model", "qwen3");
    settings.set("ai.local.backgroundModel", "mistral");
    for (const [opts, want] of [[{}, "qwen3"], [{ model: "local:qwen3" }, "qwen3"], [{ background: true }, "mistral"]]) {
      const out = await collect(runTurn({ messages: [user("hi")], toolCtx: ctx(), ...opts }));
      assert.equal(out.filter((e) => e.type === "error").length, 0, `${JSON.stringify(opts)}: ${JSON.stringify(out)}`);
      assert.equal(engines.codex.calls.at(-1).target.model, want);
    }
    settings.delete("ai.local.model");
    settings.delete("ai.local.backgroundModel");
    const out = await collect(runTurn({ messages: [user("hi")], toolCtx: ctx() }));
    assert.equal(out.filter((e) => e.type === "error").length, 0, JSON.stringify(out));
    assert.equal(engines.codex.calls.at(-1).target.model, "llama3", "nothing named: the server's first model");
    const bg = await collect(runTurn({ messages: [user("hi")], toolCtx: ctx(), background: true }));
    assert.equal(bg.filter((e) => e.type === "error").length, 0, JSON.stringify(bg));
  });
});

describe("a plan's sign-in that ran out, with no words from the engine", () => {
  it("says where to fix it", async () => {
    useEngines({ claude: [[{ type: "done", stopReason: "auth-expired" }]] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctx() }));
    const err = events.find((e) => e.type === "error");
    assert.match(err.message, /Claude's sign-in has expired/);
    assert.match(err.message, /Settings > AI/);
  });
});
