// /api/ai (src/routes/ai.js, design 4.14 and Phase 5): the provider cards, keys, Test, Verify, the default AI,
// "API keys only", and ChatGPT's device-code sign-in. Every network call goes through a stubbed fetch that records
// where it went, so the tests prove each key only ever travels to its own provider's host, and every Codex call
// (sign-in, the account's model list) is a stub. Every key here is an obvious fake.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-ai-routes-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);
const CLEARED = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_KEY",
  "TARSEE_LOCAL_AI_URL", "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_HOME",
  "CODEX_HOME",
];
for (const name of CLEARED) delete process.env[name];

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { AuditLog } = await import("../src/db/audit.js");
const { createAiRouter } = await import("../src/routes/ai.js");
const { isEncrypted } = await import("../src/lib/vault.js");
const { modelsFor, catalogModels, setCatalogModels } = await import("../src/ai/provider-registry.js");

const KEYS = {
  anthropic: "sk-ant-api03-test-canary-Anth5Rz9",
  openai: "sk-test-canary-Openai7Wx2",
  openrouter: "sk-or-v1-testcanaryRouter9Q",
  deepseek: "sk-testcanaryDeepseek3Kp",
  local: "test-canary-Local8Mn",
};
const ALL_KEYS = Object.values(KEYS);

const emptyClaudeHome = fs.mkdtempSync(path.join(tmp, "claude-empty-"));

// --- A stubbed network --------------------------------------------------------------------------------------------

const calls = [];
let responders = [];
/** Answer requests whose URL starts with `prefix`: a {status, json} object, a function of (url, init), or an Error to throw. */
function respond(prefix, answer) { responders.unshift({ prefix, answer }); }
async function fakeFetch(url, init = {}) {
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ url: String(url), method: init.method || "GET", headers });
  const hit = responders.find((r) => String(url).startsWith(r.prefix));
  if (!hit) throw new TypeError(`fetch failed: no stub for ${url}`);
  let a = typeof hit.answer === "function" ? await hit.answer(String(url), init) : hit.answer;
  if (a instanceof Error) throw a;
  return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
}

// --- ChatGPT stubs ------------------------------------------------------------------------------------------------

let login = { signedIn: false };
const deviceLogins = [];
function startDeviceLogin(opts) {
  let resolveDone;
  let rejectDone;
  const done = new Promise((r, j) => { resolveDone = r; rejectDone = j; });
  const entry = { opts, cancelled: false, resolveDone, rejectDone };
  entry.handle = {
    url: "https://auth.openai.com/codex/device",
    code: `ABCD-${1000 + deviceLogins.length}`,
    expiresAt: Date.now() + 15 * 60 * 1000,
    done,
    cancel: () => { entry.cancelled = true; resolveDone({ ok: false, error: "cancelled" }); },
  };
  deviceLogins.push(entry);
  return Promise.resolve(entry.handle);
}
const accountModels = [{ id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high"], default: true }];
const listCalls = [];
async function listAccountModels(opts) { listCalls.push(opts); return accountModels; }
const logoutCalls = [];
async function logout(opts) {
  logoutCalls.push(opts);
  fs.rmSync(path.join(opts.codexHome, "auth.json"), { force: true });
  return { ok: true };
}
const verifyCalls = [];
let verifyAnswer = { ok: true, engine: "claude-code", checks: { reply: true, tool: true, shell: true, resume: true }, efforts: ["low", "high"] };
async function verifyModel(providerId, model, deps) { verifyCalls.push({ providerId, model, deps }); return verifyAnswer; }

// --- The app ------------------------------------------------------------------------------------------------------

const db = initDb(path.join(tmp, "tarsee.db"));
const store = new SettingsStore(db, new AuditLog(db));
const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
const servers = [];

async function serve(deps = {}) {
  const app = express();
  app.use(express.json());
  app.set("db", db);
  app.set("settingsStore", store);
  app.use("/api/ai", createAiRouter({
    fetch: fakeFetch,
    stateDir: tmp,
    claudeHomes: () => [emptyClaudeHome],
    loginStatus: async () => login,
    startDeviceLogin,
    logout,
    listAccountModels,
    verifyModel,
    rateLimits: { test: { max: 1000 }, verify: { max: 1000 }, login: { max: 1000 } },
    ...deps,
  }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    for (const k of ALL_KEYS) assert.ok(!text.includes(k) && !text.includes(k.slice(0, -4)), `${method} ${p} answered with a key: ${text}`);
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
}

let api;
before(async () => { api = await serve(); });
after(() => { for (const s of servers) s.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function reset() {
  for (const name of CLEARED) delete process.env[name];
  db.prepare("DELETE FROM settings").run();
  calls.length = 0;
  responders = [];
  login = { signedIn: false };
  verifyAnswer = { ok: true, engine: "claude-code", checks: { reply: true, tool: true, shell: true, resume: true }, efforts: ["low", "high"] };
  verifyCalls.length = 0;
  listCalls.length = 0;
  setCatalogModels("chatgpt-models", []);
  setCatalogModels("local-models", []);
  setCatalogModels("openai-models", []);
}

const card = (body, id) => body.providers.find((c) => c.id === id);

// --- GET /providers -----------------------------------------------------------------------------------------------

describe("GET /providers: one card per provider", () => {
  beforeEach(reset);

  it("lists all seven with their state, the default AI and the keys-only switch", async () => {
    const { status, body } = await api("GET", "/providers");
    assert.equal(status, 200);
    assert.deepEqual(body.providers.map((c) => c.id), ["claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local"]);
    for (const c of body.providers) {
      for (const field of ["label", "kind", "shipped", "state", "detail", "keySource", "keyHint"]) assert.ok(field in c, `${c.id}.${field}`);
    }
    assert.equal(card(body, "deepseek").state, "needs-key");
    assert.equal(card(body, "deepseek").envKey, "DEEPSEEK_API_KEY");
    assert.equal(card(body, "claude").state, "needs-sign-in");
    assert.equal(card(body, "local").state, "needs-setup");
    assert.equal(body.active.provider, "claude");
    assert.equal(card(body, "claude").active, true);
    assert.deepEqual(body.keysOnly, { on: false, locked: false });
    // A command the agent runs can still read a key on Linux (design A9): every card that takes one says so.
    for (const id of ["anthropic", "openai", "openrouter", "deepseek", "local"]) {
      assert.ok(card(body, id).notes.some((n) => /can still read this key/i.test(n)), `${id}: ${JSON.stringify(card(body, id).notes)}`);
    }
  });

  it("says what API-key AIs have cost this month next to the cap (ai.spendCap.monthlyUsd), plans not counted", async () => {
    const { recordDirect } = await import("../src/lib/token-usage.js");
    db.prepare("INSERT OR IGNORE INTO conversations (id, title) VALUES (?, ?)").run("convSpend", "spend");
    const r = recordDirect({ turnId: "tSpend", conversationId: "convSpend", provider: "openai", engine: "codex", model: "gpt-6-luna", endedAt: Date.now(), costUsd: 1.25, input: 10, output: 10 }, db);
    assert.equal(r.recorded, true, JSON.stringify(r));
    recordDirect({ turnId: "tPlan", conversationId: "convSpend", provider: "chatgpt", engine: "codex", endedAt: Date.now(), costUsd: 9, input: 10, output: 10 }, db);
    let { body } = await api("GET", "/providers");
    assert.equal(body.spend.monthUsd, 1.25);
    assert.equal(body.spend.costNote, "est", "OpenAI's cost is Tarsee's estimate from the price table");
    assert.equal(body.spend.capUsd, null, "no cap set");
    store.set("ai.spendCap.monthlyUsd", "$20");
    ({ body } = await api("GET", "/providers"));
    assert.equal(body.spend.capUsd, 20);
    db.prepare("DELETE FROM usage_calls").run();
    db.prepare("DELETE FROM usage_turns").run();
  });

  it("the month's spend is labelled exact only when every priced turn is a cost the provider reported", async () => {
    const at = Date.now();
    const turn = db.prepare("INSERT INTO usage_turns (turn_id, conversation_id, provider, engine, model, started_at, ended_at, cost_usd, cost_exact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    try {
      turn.run("tExact", "verify:tExact", "anthropic", "claude-code", "claude-sonnet-5-5", at - 1000, at, 0.42, 1);
      let { body } = await api("GET", "/providers");
      assert.equal(body.spend.monthUsd, 0.42);
      assert.equal(body.spend.costNote, "exact", "Anthropic's own total_cost_usd");
      turn.run("tEst", "verify:tEst", "deepseek", "claude-code", "deepseek-flash", at - 1000, at, 0.01, 0);
      ({ body } = await api("GET", "/providers"));
      assert.equal(body.spend.costNote, "est", "one estimated turn makes the month an estimate");
      db.prepare("DELETE FROM usage_turns").run();
      ({ body } = await api("GET", "/providers"));
      assert.equal(body.spend.monthUsd, 0);
      assert.equal(body.spend.costNote, "exact", "nothing spent: nothing estimated");
    } finally {
      db.prepare("DELETE FROM usage_calls").run();
      db.prepare("DELETE FROM usage_turns").run();
    }
  });

  it("a saved key shows where it lives and its last 4 characters, never the key", async () => {
    store.set("ai.anthropic.apiKey", KEYS.anthropic);
    process.env.OPENAI_API_KEY = KEYS.openai;
    const { body } = await api("GET", "/providers");
    const a = card(body, "anthropic");
    assert.equal(a.state, "ready");
    assert.equal(a.keySource, "settings");
    assert.equal(a.keyHint, `…${KEYS.anthropic.slice(-4)}`);
    assert.equal(a.keySourceText, "Saved in Tarsee (encrypted)");
    const o = card(body, "openai");
    assert.equal(o.keySource, "env:OPENAI_API_KEY");
    assert.equal(o.keySourceText, "Railway variable OPENAI_API_KEY");
  });

  it("OpenRouter's and DeepSeek's balances are read once and cached for 10 minutes", async () => {
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    respond("https://openrouter.ai/api/v1/key", { json: { data: { label: "sk-or-v1-tes...r9Q", limit: 2, limit_remaining: 1.8, usage: 0.2, usage_daily: 0.05, usage_monthly: 0.2, is_free_tier: false } } });
    respond("https://api.deepseek.com/user/balance", { json: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0.00", topped_up_balance: "4.20" }] } });
    let { body } = await api("GET", "/providers");
    assert.equal(card(body, "openrouter").balance.text, "Spending limit left $1.80 of $2.00");
    assert.equal(card(body, "deepseek").balance.text, "Balance $4.20");
    assert.ok(!JSON.stringify(body).includes("sk-or-v1-tes"), "OpenRouter's key label (part of the key) is never passed on");
    const first = calls.length;
    assert.equal(first, 2);
    const or = calls.find((c) => c.url.startsWith("https://openrouter.ai/"));
    assert.equal(or.headers.authorization, `Bearer ${KEYS.openrouter}`);
    const ds = calls.find((c) => c.url.startsWith("https://api.deepseek.com/"));
    assert.equal(ds.headers.authorization, `Bearer ${KEYS.deepseek}`);
    ({ body } = await api("GET", "/providers"));
    assert.equal(calls.length, first, "the second look used the cache");
    assert.equal(card(body, "openrouter").balance.text, "Spending limit left $1.80 of $2.00");
  });

  it("an empty DeepSeek balance makes the card out-of-credit", async () => {
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    respond("https://api.deepseek.com/user/balance", { json: { is_available: false, balance_infos: [{ currency: "USD", total_balance: "0.00" }] } });
    const { body } = await api("GET", "/providers");
    assert.equal(card(body, "deepseek").state, "out-of-credit");
  });

  it("warns when ANTHROPIC_API_KEY is set but the Claude plan is the default, offering the switch", async () => {
    process.env.ANTHROPIC_API_KEY = KEYS.anthropic;
    const { body } = await api("GET", "/providers");
    const banner = body.banners.find((b) => b.id === "anthropic-key-ignored");
    assert.ok(banner, JSON.stringify(body.banners));
    assert.equal(banner.action.provider, "anthropic");
  });
});

// --- Keys ---------------------------------------------------------------------------------------------------------

describe("PUT /keys/:id and DELETE /keys/:id", () => {
  beforeEach(reset);

  const wrongSlots = [
    ["anthropic", "sk-ant-oat01-test-canary-SignIn4Tk", /Claude sign-in token/],
    ["deepseek", KEYS.openrouter, /OpenRouter key/],
    ["openai", KEYS.anthropic, /Anthropic key/],
    ["openrouter", "sk-proj-test-canary-Proj6Yh2a", /OpenAI key/],
    ["deepseek", "not-a-key", /doesn't look like a DeepSeek key/],
  ];
  for (const [id, key, message] of wrongSlots) {
    it(`refuses a wrong key for ${id} with a helpful message (${message}) and saves nothing`, async () => {
      const { status, body } = await api("PUT", `/keys/${id}`, { apiKey: key });
      assert.equal(status, 400);
      assert.match(body.error, message);
      assert.ok(!body.error.includes(key), "the message doesn't repeat the key");
      assert.equal(raw(`ai.${id}.apiKey`), null);
    });
  }

  it("a plan takes no key; an unknown provider is 404; a key with a line break is refused", async () => {
    assert.equal((await api("PUT", "/keys/claude", { apiKey: KEYS.anthropic })).status, 400);
    assert.equal((await api("PUT", "/keys/chatgpt", { apiKey: KEYS.openai })).status, 400);
    assert.equal((await api("PUT", "/keys/gemini", { apiKey: "x" })).status, 404);
    const r = await api("PUT", "/keys/deepseek", { apiKey: `${KEYS.deepseek}\nX-Other: 1` });
    assert.equal(r.status, 400);
  });

  it("saves a good key encrypted, answers with its last 4 only, audits the write and clears old failure flags", async () => {
    store.set("ai.deepseek.status", { state: "auth", at: new Date().toISOString() });
    store.set("cache.deepseek.balance", { at: Date.now(), keyHint: "…zzzz", empty: true, text: "x" });
    const { status, body } = await api("PUT", "/keys/deepseek", { apiKey: `  "${KEYS.deepseek}"  ` });
    assert.equal(status, 200);
    assert.equal(body.keySource, "settings");
    assert.equal(body.keyHint, `…${KEYS.deepseek.slice(-4)}`);
    assert.equal(body.status.state, "ready");
    const stored = raw("ai.deepseek.apiKey");
    assert.ok(isEncrypted(stored), "stored encrypted");
    assert.ok(!stored.includes(KEYS.deepseek));
    assert.equal(store.get("ai.deepseek.apiKey"), KEYS.deepseek, "quotes and spaces trimmed");
    assert.equal(raw("ai.deepseek.status"), null);
    assert.equal(raw("cache.deepseek.balance"), null);
    const audit = db.prepare("SELECT action, target, actor FROM audit_log WHERE target = 'ai.deepseek.apiKey' ORDER BY id DESC").get();
    assert.deepEqual({ ...audit }, { action: "credential.write", target: "ai.deepseek.apiKey", actor: "user" });
  });

  it("Local AI takes any key that isn't another provider's", async () => {
    assert.equal((await api("PUT", "/keys/local", { apiKey: KEYS.local })).status, 200);
    assert.equal((await api("PUT", "/keys/local", { apiKey: KEYS.openrouter })).status, 400);
  });

  it("DELETE removes the saved key; a Railway variable then applies again", async () => {
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    process.env.OPENROUTER_API_KEY = "sk-or-v1-testcanaryRailwayE5";
    const { status, body } = await api("DELETE", "/keys/openrouter");
    assert.equal(status, 200);
    assert.equal(body.removed, true);
    assert.equal(raw("ai.openrouter.apiKey"), null);
    assert.equal(body.status.keySource, "env:OPENROUTER_API_KEY");
    assert.ok(!JSON.stringify(body).includes("sk-or-v1-testcanaryRailway"));
  });
});

// --- Test ---------------------------------------------------------------------------------------------------------

describe("POST /test/:id: a cheap live check per provider", () => {
  beforeEach(reset);

  it("OpenRouter: GET /api/v1/key with the key, showing the spending limit; a rejected key flags the card", async () => {
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    respond("https://openrouter.ai/api/v1/key", { json: { data: { limit: 2, limit_remaining: 1.8, usage: 0.2 } } });
    let { body } = await api("POST", "/test/openrouter");
    assert.equal(body.ok, true);
    assert.equal(body.state, "ready");
    assert.equal(body.message, "Key works · Spending limit left $1.80 of $2.00");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/key");
    assert.equal(calls[0].headers.authorization, `Bearer ${KEYS.openrouter}`);

    respond("https://openrouter.ai/api/v1/key", { status: 401, json: { error: { message: "No auth credentials found", code: 401 } } });
    ({ body } = await api("POST", "/test/openrouter"));
    assert.equal(body.ok, false);
    assert.equal(body.state, "error");
    assert.match(body.message, /rejected/);
    assert.equal(card((await api("GET", "/providers")).body, "openrouter").state, "error", "the card shows it");
  });

  it("OpenRouter: a used-up spending limit is out-of-credit, even though the key works", async () => {
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    respond("https://openrouter.ai/api/v1/key", { json: { data: { limit: 2, limit_remaining: 0, usage: 2 } } });
    const { body } = await api("POST", "/test/openrouter");
    assert.equal(body.ok, false);
    assert.equal(body.state, "out-of-credit");
    assert.match(body.message, /openrouter\.ai\/settings\/keys/);
    assert.equal(store.get("ai.openrouter.status").state, "out-of-credit", "flagged as the turn layer flags it");
  });

  it("DeepSeek: GET /user/balance, showing the balance; an empty balance is out-of-credit", async () => {
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    respond("https://api.deepseek.com/user/balance", { json: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20" }] } });
    let { body } = await api("POST", "/test/deepseek");
    assert.equal(body.ok, true);
    assert.equal(body.message, "Key works · Balance $4.20");
    assert.equal(body.balance.total, 4.2);
    respond("https://api.deepseek.com/user/balance", { json: { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] } });
    ({ body } = await api("POST", "/test/deepseek"));
    assert.equal(body.ok, false);
    assert.equal(body.state, "out-of-credit");
    assert.match(body.message, /Top up/);
  });

  it("OpenAI: GET /v1/models with the key; 401 is rejected; 429 insufficient_quota is out-of-credit", async () => {
    store.set("ai.openai.apiKey", KEYS.openai);
    respond("https://api.openai.com/v1/models", { json: { object: "list", data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] } });
    let { body } = await api("POST", "/test/openai");
    assert.equal(body.ok, true);
    assert.match(body.message, /^Key works/);
    assert.equal(calls.at(-1).headers.authorization, `Bearer ${KEYS.openai}`);
    respond("https://api.openai.com/v1/models", { status: 401, json: { error: { message: "Incorrect API key provided: sk-test-****7Wx2", code: "invalid_api_key" } } });
    ({ body } = await api("POST", "/test/openai"));
    assert.equal(body.ok, false);
    assert.match(body.message, /OpenAI key was rejected/);
    respond("https://api.openai.com/v1/models", { status: 429, json: { error: { message: "You exceeded your current quota", code: "insufficient_quota" } } });
    ({ body } = await api("POST", "/test/openai"));
    assert.equal(body.state, "out-of-credit");
  });

  it("Anthropic: GET /v1/models with x-api-key and the API version header", async () => {
    store.set("ai.anthropic.apiKey", KEYS.anthropic);
    respond("https://api.anthropic.com/v1/models", { json: { data: [{ type: "model", id: "claude-x" }], has_more: false } });
    const { body } = await api("POST", "/test/anthropic");
    assert.equal(body.ok, true);
    assert.equal(calls[0].headers["x-api-key"], KEYS.anthropic);
    assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(calls[0].headers.authorization, undefined);
  });

  it("Local AI: GET {url}/models, listing what the server has; an unreachable server says so; no address is needs-setup", async () => {
    let { body } = await api("POST", "/test/local");
    assert.equal(body.ok, false);
    assert.equal(body.state, "needs-setup");
    store.set("ai.local.baseUrl", "http://192.168.1.20:11434/v1/");
    store.set("ai.local.apiKey", KEYS.local);
    respond("http://192.168.1.20:11434/v1/models", { json: { object: "list", data: [{ id: "qwen3:8b" }, { id: "llama3.3" }] } });
    ({ body } = await api("POST", "/test/local"));
    assert.equal(body.ok, true);
    assert.deepEqual(body.models, ["qwen3:8b", "llama3.3"]);
    assert.equal(calls.at(-1).url, "http://192.168.1.20:11434/v1/models");
    assert.equal(calls.at(-1).headers.authorization, `Bearer ${KEYS.local}`);
    assert.deepEqual(modelsFor("local").map((m) => m.id), ["qwen3:8b", "llama3.3"], "the server's list fills Local AI's catalog");
    respond("http://192.168.1.20:11434/v1/models", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    ({ body } = await api("POST", "/test/local"));
    assert.equal(body.ok, false);
    assert.equal(body.message, "Can't reach your Local AI at http://192.168.1.20:11434/v1/.");
  });

  it("ChatGPT: Codex's own sign-in status, no network", async () => {
    let { body } = await api("POST", "/test/chatgpt");
    assert.equal(body.ok, false);
    assert.equal(body.state, "needs-sign-in");
    login = { signedIn: true, email: "owner@example.com", plan: "free" };
    ({ body } = await api("POST", "/test/chatgpt"));
    assert.equal(body.ok, true);
    assert.equal(body.message, "Signed in as owner@example.com (Free).");
    assert.equal(calls.length, 0);
  });

  it("Claude plan: the sign-in, no network", async () => {
    let { body } = await api("POST", "/test/claude");
    assert.equal(body.ok, false);
    assert.match(body.message, /claude auth login/);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test-canary-Railway7Qz";
    ({ body } = await api("POST", "/test/claude"));
    assert.equal(body.ok, true);
    assert.equal(calls.length, 0);
  });

  it("tests a pasted key before it is saved, without saving it", async () => {
    respond("https://api.deepseek.com/user/balance", { json: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "1.00" }] } });
    const { body } = await api("POST", "/test/deepseek", { apiKey: KEYS.deepseek });
    assert.equal(body.ok, true);
    assert.equal(calls[0].headers.authorization, `Bearer ${KEYS.deepseek}`);
    assert.equal(raw("ai.deepseek.apiKey"), null);
    const wrong = await api("POST", "/test/deepseek", { apiKey: KEYS.openrouter });
    assert.equal(wrong.status, 400);
    assert.equal(calls.length, 1, "a wrong-slot key is never sent anywhere");
  });

  it("a network failure is an answer, not a crash; a key provider with no key is needs-key", async () => {
    let { body } = await api("POST", "/test/openai");
    assert.equal(body.ok, false);
    assert.equal(body.state, "needs-key");
    store.set("ai.openai.apiKey", KEYS.openai);
    respond("https://api.openai.com/", new TypeError("fetch failed"));
    ({ body } = await api("POST", "/test/openai"));
    assert.equal(body.ok, false);
    assert.match(body.message, /couldn't reach/i);
  });

  it("is rate-limited to 6 a minute", async () => {
    const limited = await serve({ rateLimits: {} });
    respond("https://api.deepseek.com/user/balance", { json: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "1.00" }] } });
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    for (let i = 0; i < 6; i++) assert.equal((await limited("POST", "/test/deepseek")).status, 200, `try ${i + 1}`);
    const r = await limited("POST", "/test/deepseek");
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.match(r.body.error, /wait/i);
  });
});

// --- The default AI and API keys only -----------------------------------------------------------------------------

describe("PUT /active and PUT /keys-only", () => {
  beforeEach(reset);

  it("sets a ready provider and its model as the default; the Claude plan is stored under its storage id", async () => {
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    let r = await api("PUT", "/active", { provider: "deepseek", model: "deepseek-v4-pro" });
    assert.equal(r.status, 200);
    assert.equal(store.get("ai.activeProvider"), "deepseek");
    assert.equal(store.get("ai.deepseek.model"), "deepseek-v4-pro");
    assert.equal((await api("GET", "/providers")).body.active.provider, "deepseek");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test-canary-Railway7Qz";
    r = await api("PUT", "/active", { provider: "claude", model: "sonnet" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.get("ai.activeProvider"), "claude-code");
    assert.equal(store.get("ai.claude-code.model"), "sonnet");
  });

  it("refuses an unknown provider, one that isn't ready (with the fix), and a model the provider doesn't have", async () => {
    assert.equal((await api("PUT", "/active", { provider: "gemini" })).status, 404);
    let r = await api("PUT", "/active", { provider: "deepseek" });
    assert.equal(r.status, 409);
    assert.equal(r.body.state, "needs-key");
    assert.match(r.body.fix, /DEEPSEEK_API_KEY/);
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    r = await api("PUT", "/active", { provider: "deepseek", model: "gpt-6.1-sol" });
    assert.equal(r.status, 400);
    assert.equal(store.get("ai.activeProvider"), null);
  });

  it("an OpenRouter model from a maker Tarsee hasn't verified must be verified first", async () => {
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    let r = await api("PUT", "/active", { provider: "openrouter", model: "qwen/qwen3-coder" });
    assert.equal(r.status, 409);
    assert.equal(r.body.state, "needs-verification");
    assert.match(r.body.error, /Verify/);
    r = await api("PUT", "/active", { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it("refuses a provider that isn't switched on in this version", async () => {
    const only = await serve({ isShipped: (id) => id === "claude" });
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    const r = await only("PUT", "/active", { provider: "deepseek" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /isn't available/);
    assert.equal((await only("PUT", "/keys/deepseek", { apiKey: KEYS.deepseek })).status, 400);
    const cards = (await only("GET", "/providers")).body.providers;
    assert.equal(cards.find((c) => c.id === "deepseek").shipped, false);
  });

  it("API keys only blocks the plan cards and refuses a plan as the default", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test-canary-Railway7Qz";
    login = { signedIn: true };
    let r = await api("PUT", "/keys-only", { on: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.keysOnly, { on: true, locked: false });
    assert.equal(r.body.activeBlocked, true, "the default (the Claude plan) is now blocked, and the answer says so");
    assert.match(r.body.message, /default/);
    const { body } = await api("GET", "/providers");
    assert.equal(card(body, "claude").state, "blocked-keys-only");
    assert.equal(card(body, "chatgpt").state, "blocked-keys-only");
    r = await api("PUT", "/active", { provider: "claude" });
    assert.equal(r.status, 409);
    assert.equal(r.body.state, "blocked-keys-only");
    r = await api("PUT", "/keys-only", { on: false });
    assert.equal(r.body.keysOnly.on, false);
    assert.equal(card((await api("GET", "/providers")).body, "claude").state, "ready");
  });

  it("TARSEE_KEYS_ONLY=1 locks the switch on", async () => {
    process.env.TARSEE_KEYS_ONLY = "1";
    const r = await api("PUT", "/keys-only", { on: false });
    assert.equal(r.status, 423);
    assert.match(r.body.error, /TARSEE_KEYS_ONLY/);
    assert.deepEqual((await api("GET", "/providers")).body.keysOnly, { on: true, locked: true });
  });
});

// --- Provider settings and models ---------------------------------------------------------------------------------

describe("PUT /providers/:id and GET /models/:id", () => {
  beforeEach(reset);

  it("Local AI: its address, model and context; only plain http(s) addresses", async () => {
    let r = await api("PUT", "/providers/local", { baseUrl: "http://192.168.1.20:11434/v1", model: "qwen3:8b", context: 32768 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.get("ai.local.baseUrl"), "http://192.168.1.20:11434/v1");
    assert.equal(store.get("ai.local.model"), "qwen3:8b");
    assert.equal(Number(store.get("ai.local.context")), 32768);
    assert.equal(r.body.card.state, "ready");
    assert.equal((await api("PUT", "/providers/local", { baseUrl: "file:///etc/passwd" })).status, 400);
    assert.equal((await api("PUT", "/providers/local", { baseUrl: "http://user:pass@host/v1" })).status, 400);
    assert.equal((await api("PUT", "/providers/local", { context: -5 })).status, 400);
  });

  it("a Railway address with a password in it is never shown on the card", async () => {
    process.env.TARSEE_LOCAL_AI_URL = "http://admin:test-canary-pw9@192.168.1.20:11434/v1";
    const { body } = await api("GET", "/providers");
    const local = card(body, "local");
    assert.equal(local.state, "needs-setup");
    assert.ok(!JSON.stringify(body).includes("test-canary-pw9"), JSON.stringify(local));
    assert.equal(local.settings.baseUrl, "http://192.168.1.20:11434/v1");
  });

  it("no other provider takes an address", async () => {
    const r = await api("PUT", "/providers/deepseek", { baseUrl: "https://api.deepseek.example/anthropic" });
    assert.equal(r.status, 400);
    assert.equal(raw("ai.deepseek.baseUrl"), null);
  });

  it("default and background models are checked against the provider", async () => {
    let r = await api("PUT", "/providers/deepseek", { model: "deepseek-v4-pro", backgroundModel: "deepseek-flash" });
    assert.equal(r.status, 200);
    assert.equal(store.get("ai.deepseek.model"), "deepseek-v4-pro");
    assert.equal(store.get("ai.deepseek.backgroundModel"), "deepseek-flash");
    r = await api("PUT", "/providers/deepseek", { model: "claude-sonnet-4-5" });
    assert.equal(r.status, 400);
    r = await api("PUT", "/providers/deepseek", { backgroundModel: null });
    assert.equal(r.status, 200);
    assert.equal(store.get("ai.deepseek.backgroundModel"), null);
  });

  it("OpenRouter's attribution title is one short line", async () => {
    assert.equal((await api("PUT", "/providers/openrouter", { appTitle: "My Assistant" })).status, 200);
    assert.equal(store.get("ai.openrouter.appTitle"), "My Assistant");
    assert.equal((await api("PUT", "/providers/openrouter", { appTitle: "a\nX-Evil: 1" })).status, 400);
  });

  it("GET /models/chatgpt asks Codex for the signed-in account's own list (never a fixed one) and fills the catalog", async () => {
    login = { signedIn: true };
    const { status, body } = await api("GET", "/models/chatgpt");
    assert.equal(status, 200);
    assert.deepEqual(body.models.map((m) => m.id), ["gpt-6-luna"]);
    assert.equal(listCalls[0].codexHome, path.join(tmp, ".codex-home"));
    assert.ok(!Object.keys(listCalls[0].env).some((k) => /^(ENCRYPTION_KEY|SETUP_PASSWORD|ANTHROPIC_|OPENAI_API_KEY)/.test(k)), "Codex gets no Tarsee secret or key");
    assert.equal(listCalls[0].env.CODEX_HOME, path.join(tmp, ".codex-home"));
    assert.deepEqual(catalogModels("chatgpt-models").map((m) => m.id), ["gpt-6-luna"]);
  });

  it("GET /models/chatgpt when the account's list can't be read: no model is named, and the answer says Codex picks", async () => {
    login = { signedIn: true, method: "chatgpt" };
    const own = await serve({ listAccountModels: async () => [] });
    const { status, body } = await own("GET", "/models/chatgpt");
    assert.equal(status, 200);
    assert.deepEqual(body.models, []);
    assert.equal(body.defaultModel, null);
    assert.match(body.note, /default model/);
  });

  it("GET /models/openrouter fills OpenRouter's list when it is empty (no key sent); Verify's cost and a re-check hint per model", async () => {
    const { __resetForTests } = await import("../src/lib/openrouter-catalog.js");
    __resetForTests();
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    store.set("ai.openrouter.verified", { "qwen/qwen3-coder": { engine: "codex", at: "2026-01-01T00:00:00Z", engineVersion: "0.0.1", efforts: ["low"] } });
    const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/openrouter-models.json", import.meta.url), "utf8"));
    respond("https://openrouter.ai/api/v1/models", { json: recorded });
    const { status, body } = await api("GET", "/models/openrouter");
    assert.equal(status, 200);
    const asked = calls.filter((c) => c.url.startsWith("https://openrouter.ai/api/v1/models"));
    assert.equal(asked.length, 1, "the public list was read");
    assert.ok(!asked[0].headers.authorization, "OpenRouter's public list is read without the key");
    const row = (id) => body.models.find((m) => m.id === id);
    assert.ok(row("anthropic/claude-sonnet-5.5"), "the list is filled from OpenRouter's");
    assert.equal(row("anthropic/claude-sonnet-5.5").needsVerification, false);
    assert.equal(row("anthropic/claude-sonnet-5.5").verifyCost, null, "nothing to verify");
    const llama = row("meta-llama/llama-4-maverick");
    assert.equal(llama.needsVerification, true);
    assert.match(llama.verifyCost, /^(about \$\d+\.\d\d|less than \$0\.01) \(est\.\)$/, "what a check costs, before it runs");
    assert.equal(row("qwen/qwen3-coder").verified, true);
    assert.equal(row("qwen/qwen3-coder").recheck, true, "verified on another version of its engine: check it again");
    assert.equal(llama.recheck, false);
    __resetForTests();
  });

  it("GET /models/openai: the table's models, and one the owner verified on the card, which can then be the default", async () => {
    store.set("ai.openai.apiKey", KEYS.openai);
    store.set("ai.openai.verified", { "gpt-7-mini": { engine: "codex", at: "2026-11-08T00:00:00Z", engineVersion: "0.167.0", efforts: ["low", "medium"] } });
    respond("https://api.openai.com/", { json: { object: "list", data: [{ id: "gpt-6.1-sol" }, { id: "gpt-7-mini" }, { id: "gpt-7-nano" }] } });
    const { status, body } = await api("GET", "/models/openai");
    assert.equal(status, 200);
    const mini = body.models.find((m) => m.id === "gpt-7-mini");
    assert.ok(mini, JSON.stringify(body.models.map((m) => m.id)));
    assert.equal(mini.verified, true);
    assert.equal(mini.needsVerification, false);
    assert.equal(mini.inMenu, true);
    assert.deepEqual(mini.efforts, ["low", "medium"]);
    assert.ok(!body.models.some((m) => m.id === "gpt-7-nano"), "an unverified id the key lists stays off the card (Verify a model id first)");
    const r = await api("PUT", "/providers/openai", { model: "gpt-7-mini" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.get("ai.openai.model"), "gpt-7-mini");
    assert.equal((await api("PUT", "/providers/openai", { model: "gpt-7-nano" })).status, 400, "not before it is verified");
  });

  it("GET /models/deepseek checks the table against DeepSeek's own list with the key, and names a model Tarsee doesn't know yet", async () => {
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    respond("https://api.deepseek.com/models", { json: { object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v5-preview" }] } });
    const { status, body } = await api("GET", "/models/deepseek");
    assert.equal(status, 200);
    const asked = calls.filter((c) => c.url === "https://api.deepseek.com/models");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].headers.authorization, `Bearer ${KEYS.deepseek}`, "the key goes to DeepSeek's own host only");
    assert.ok(calls.every((c) => c.url.startsWith("https://api.deepseek.com/")), "and nowhere else");
    assert.equal(body.models.find((m) => m.id === "deepseek-flash").confirmed, true);
    assert.equal(body.models.find((m) => m.id === "deepseek-v4-pro").confirmed, false);
    assert.match(body.note, /deepseek-v5-preview/);
    assert.match(body.note, /DeepSeek Pro/, "a model the key doesn't list is named");

    calls.length = 0;
    responders = [];
    respond("https://api.deepseek.com/models", { status: 500, json: {} });
    const down = await api("GET", "/models/deepseek");
    assert.equal(down.status, 200, "the table still answers when DeepSeek's list can't be read");
    assert.deepEqual(down.body.models.map((m) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);
    assert.equal(down.body.models[0].confirmed, null);
  });

  it("GET /models/chatgpt when nobody is signed in is a plain refusal", async () => {
    const r = await api("GET", "/models/chatgpt");
    assert.equal(r.status, 409);
    assert.equal(listCalls.length, 0);
  });
});

// --- Verify -------------------------------------------------------------------------------------------------------

describe("POST /verify/:id", () => {
  beforeEach(reset);

  it("runs the 4-step check and records the engine and efforts that passed, so the model can then be chosen", async () => {
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    verifyAnswer = { ok: true, engine: "codex", checks: { reply: true, tool: true, shell: true, resume: true }, efforts: ["low", "high"] };
    const { status, body } = await api("POST", "/verify/openrouter", { model: "qwen/qwen3-coder" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.efforts, ["low", "high"]);
    assert.equal(verifyCalls[0].providerId, "openrouter");
    assert.equal(verifyCalls[0].model, "qwen/qwen3-coder");
    assert.equal(verifyCalls[0].deps.store, store);
    const verified = store.get("ai.openrouter.verified");
    assert.equal(verified["qwen/qwen3-coder"].engine, "codex");
    assert.deepEqual(verified["qwen/qwen3-coder"].efforts, ["low", "high"]);
    const r = await api("PUT", "/active", { provider: "openrouter", model: "qwen/qwen3-coder" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it("a model that fails is an answer with what failed; nothing is recorded", async () => {
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    verifyAnswer = { ok: false, engine: null, checks: { reply: true, tool: false }, efforts: [], error: "It couldn't use Tarsee's tools." };
    const { status, body } = await api("POST", "/verify/openrouter", { model: "someone/tiny-model" });
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(body.error, /tools/);
    assert.equal(store.get("ai.openrouter.verified"), null);
  });

  it("a result verify-model already recorded is left as it saved it; its own rate limit is a 429", async () => {
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    const entry = { engine: "codex", at: "2026-11-09T00:00:00.000Z", engineVersion: "0.167.0", efforts: ["high"], checks: [{ step: "reply", ok: true }] };
    store.set("ai.openrouter.verified", { "qwen/qwen3-coder": entry });
    verifyAnswer = { ok: true, engine: "codex", checks: [{ step: "reply", ok: true, ms: 10 }], efforts: ["high"], recorded: true, entry, message: "Qwen3 Coder passed." };
    let r = await api("POST", "/verify/openrouter", { model: "qwen/qwen3-coder" });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.message, "Qwen3 Coder passed.");
    assert.deepEqual(r.body.checks, [{ step: "reply", ok: true, ms: 10 }]);
    assert.deepEqual(store.get("ai.openrouter.verified")["qwen/qwen3-coder"], entry);
    verifyAnswer = { ok: false, code: "rate-limited", error: "You've checked six OpenRouter models this hour. Try again later.", checks: [], efforts: [] };
    r = await api("POST", "/verify/openrouter", { model: "qwen/qwen3-coder" });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /this hour/);
  });

  it("needs a model and a ready provider", async () => {
    assert.equal((await api("POST", "/verify/openrouter", {})).status, 400);
    const r = await api("POST", "/verify/openrouter", { model: "qwen/qwen3-coder" });
    assert.equal(r.status, 409);
    assert.equal(verifyCalls.length, 0);
  });

  it("is rate-limited", async () => {
    const limited = await serve({ rateLimits: {} });
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    let last;
    for (let i = 0; i < 4; i++) last = await limited("POST", "/verify/openrouter", { model: "qwen/qwen3-coder" });
    assert.equal(last.status, 429);
  });
});

// --- ChatGPT device sign-in ---------------------------------------------------------------------------------------

describe("ChatGPT sign-in (Codex's device code)", () => {
  beforeEach(reset);

  it("start shows the link and code, one login at a time; poll reports waiting, then signed in", async () => {
    const own = await serve();
    const before = deviceLogins.length;
    let r = await own("POST", "/chatgpt/login");
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "waiting");
    assert.equal(r.body.url, "https://auth.openai.com/codex/device");
    assert.match(r.body.code, /^ABCD-/);
    assert.ok(Date.parse(r.body.expiresAt) > Date.now());
    const entry = deviceLogins.at(-1);
    assert.equal(entry.opts.codexHome, path.join(tmp, ".codex-home"));
    assert.ok(fs.statSync(entry.opts.codexHome).isDirectory(), "the sign-in folder exists before Codex writes to it");
    const again = await own("POST", "/chatgpt/login");
    assert.equal(again.body.code, r.body.code);
    assert.equal(deviceLogins.length, before + 1, "a second press shows the same code");

    assert.equal((await own("GET", "/chatgpt/login")).body.state, "waiting");
    login = { signedIn: true, email: "owner@example.com", plan: "free" };
    entry.resolveDone({ ok: true });
    await new Promise((r2) => setTimeout(r2, 20));
    r = await own("GET", "/chatgpt/login");
    assert.equal(r.body.state, "done");
    assert.equal(r.body.account, "owner@example.com (Free)");
    assert.equal(store.get("ai.chatgpt.method"), "device");
    assert.deepEqual(catalogModels("chatgpt-models").map((m) => m.id), ["gpt-6-luna"], "the account's own models are read after sign-in");
  });

  it("a failed sign-in reports why; cancel stops it", async () => {
    const own = await serve();
    await own("POST", "/chatgpt/login");
    deviceLogins.at(-1).resolveDone({ ok: false, error: "Device sign-in is turned off for this account." });
    await new Promise((r) => setTimeout(r, 20));
    let r = await own("GET", "/chatgpt/login");
    assert.equal(r.body.state, "failed");
    assert.match(r.body.error, /turned off/);
    assert.ok(!/^ABCD-/.test(String(r.body.code ?? "")), "a finished sign-in never shows its device code again");
    // The sign-in crashing (its promise rejects) is a failure too, and its device code goes with it.
    await own("POST", "/chatgpt/login");
    deviceLogins.at(-1).rejectDone(new Error("codex exited unexpectedly"));
    await new Promise((r2) => setTimeout(r2, 20));
    r = await own("GET", "/chatgpt/login");
    assert.equal(r.body.state, "failed");
    assert.match(r.body.error, /exited unexpectedly/);
    assert.equal(r.body.code, undefined, "no device code in a failed view");
    await own("POST", "/chatgpt/login");
    const entry = deviceLogins.at(-1);
    r = await own("DELETE", "/chatgpt/login");
    assert.equal(r.status, 200);
    assert.equal(entry.cancelled, true);
    assert.equal((await own("GET", "/chatgpt/login")).body.state, "idle");
  });

  it("Codex's own time-out reports expired; a sign-in that can't start says why", async () => {
    const own = await serve();
    await own("POST", "/chatgpt/login");
    deviceLogins.at(-1).resolveDone({ ok: false, code: "timeout", error: "The sign-in code ran out before you finished." });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await own("GET", "/chatgpt/login")).body.state, "expired");
    const refusing = await serve({
      startDeviceLogin: async () => { throw Object.assign(new Error("Turn on device code sign-in in ChatGPT: Settings → Security"), { code: "device-code-disabled" }); },
    });
    const r = await refusing("POST", "/chatgpt/login");
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "device-code-disabled");
    assert.match(r.body.error, /Settings → Security/);
    assert.equal((await refusing("GET", "/chatgpt/login")).body.state, "idle");
  });

  it("an expired code reports expired", async () => {
    let clock = Date.now();
    const own = await serve({ now: () => clock });
    await own("POST", "/chatgpt/login");
    const entry = deviceLogins.at(-1);
    clock += 16 * 60 * 1000;
    const r = await own("GET", "/chatgpt/login");
    assert.equal(r.body.state, "expired");
    assert.equal(r.body.code, undefined, "an expired code isn't shown any more");
    assert.equal(entry.cancelled, true, "the login process is stopped");
  });

  it("API keys only refuses a plan sign-in", async () => {
    store.set("ai.keysOnly", true);
    const r = await api("POST", "/chatgpt/login");
    assert.equal(r.status, 409);
  });

  it("sign-out removes Codex's sign-in file and forgets the account's models", async () => {
    const home = path.join(tmp, ".codex-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "auth.json"), "{\"tokens\":{\"refresh_token\":\"test-canary\"}}");
    store.set("ai.chatgpt.method", "device");
    setCatalogModels("chatgpt-models", accountModels);
    const r = await api("POST", "/chatgpt/logout");
    assert.equal(r.status, 200);
    assert.equal(logoutCalls.at(-1).codexHome, home, "Codex's own logout ran on the ChatGPT home");
    assert.equal(fs.existsSync(path.join(home, "auth.json")), false);
    assert.equal(store.get("ai.chatgpt.method"), null);
    assert.equal(catalogModels("chatgpt-models").length, 0);
  });

  it("a sign-out Codex couldn't finish says so", async () => {
    const own = await serve({ logout: async () => ({ ok: false, error: "Couldn't remove the saved ChatGPT sign-in (EBUSY)." }) });
    const r = await own("POST", "/chatgpt/logout");
    assert.equal(r.status, 500);
    assert.match(r.body.error, /EBUSY/);
  });
});
