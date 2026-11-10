// Readiness (design 4.14 "Readiness consumers" and Phase 5): every place that asks "is an AI connected?" reads the
// same providerStatus().
//   - /api/settings/setup-status: a fresh install needs setup; Railway variables alone (TARSEE_AI_PROVIDER plus a
//     key, or the Claude plan's CLAUDE_CODE_OAUTH_TOKEN) skip it; the old fake "subscription" key and the
//     CLAUDE_OAUTH_CREDENTIALS check are gone.
//   - POST /api/settings/provider: the old wizard's route, a thin shim over the same checks.
//   - self-heal checkProvider (the doctor) per provider, and /healthz/deep: 503 while the default AI isn't ready.
//   - /healthz is unchanged and never depends on the AI (Railway's deploy health check).
// Every key here is an obvious fake.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-readiness-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);
const CLEARED = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_KEY",
  "TARSEE_LOCAL_AI_URL", "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_HOME",
  "CLAUDE_OAUTH_CREDENTIALS", "CODEX_HOME",
];
for (const name of CLEARED) delete process.env[name];

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { healthRouter } = await import("../src/routes/health.js");
const { checkProvider, runDiagnostics } = await import("../src/lib/self-heal.js");
const { isEncrypted } = await import("../src/lib/vault.js");
const { setCatalogModels } = await import("../src/ai/provider-registry.js");
const { forgetLocalModelsRead } = await import("../src/ai/provider-models.js");

const KEYS = {
  deepseek: "sk-testcanaryDeepseek3Kp",
  openrouter: "sk-or-v1-testcanaryRouter9Q",
};

const db = initDb(path.join(tmp, "tarsee.db"));
const store = new SettingsStore(db);
const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
let server;
let base;
// Whether the caller counts as signed in: what sessionAuth (middleware/auth.js) puts on req.auth before the health
// routes run in server.js.
let signedIn = false;

before(async () => {
  const app = express();
  app.use(express.json());
  app.set("db", db);
  app.set("settingsStore", store);
  app.use((req, _res, next) => {
    req.auth = signedIn ? { authenticated: true, method: "session" } : { authenticated: false, method: null };
    next();
  });
  app.use(healthRouter);
  app.use("/api/settings", settingsRouter);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function reset() {
  for (const name of CLEARED) delete process.env[name];
  db.prepare("DELETE FROM settings").run();
  signedIn = false;
}

async function call(method, p, body) {
  const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  for (const k of Object.values(KEYS)) assert.ok(!text.includes(k) && !text.includes(k.slice(0, -4)), `${p} answered with a key: ${text}`);
  return { status: res.status, body: JSON.parse(text) };
}

describe("GET /api/settings/setup-status", () => {
  beforeEach(reset);

  it("a fresh install needs setup", async () => {
    const { body } = await call("GET", "/api/settings/setup-status");
    assert.equal(body.needsSetup, true);
    assert.equal(body.hasKey, false);
    assert.equal(body.provider, null);
    assert.ok(body.ai && typeof body.ai.state === "string", JSON.stringify(body));
  });

  it("Railway variables alone (TARSEE_AI_PROVIDER plus the key) skip setup, and say which variable", async () => {
    process.env.TARSEE_AI_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = KEYS.deepseek;
    const { body } = await call("GET", "/api/settings/setup-status");
    assert.equal(body.needsSetup, false);
    assert.equal(body.hasKey, true);
    assert.equal(body.provider, "deepseek");
    assert.equal(body.ai.state, "ready");
    assert.equal(body.ai.chosenBy, "env");
    assert.deepEqual(body.railway.find((r) => r.id === "deepseek"), { id: "deepseek", label: "DeepSeek", envKey: "DEEPSEEK_API_KEY" });
  });

  it("TARSEE_AI_PROVIDER without its key still needs setup, saying what's missing", async () => {
    process.env.TARSEE_AI_PROVIDER = "deepseek";
    const { body } = await call("GET", "/api/settings/setup-status");
    assert.equal(body.needsSetup, true);
    assert.equal(body.ai.provider, "deepseek");
    assert.equal(body.ai.state, "needs-key");
    assert.match(body.ai.fix, /DEEPSEEK_API_KEY/);
  });

  it("the Claude plan's CLAUDE_CODE_OAUTH_TOKEN alone skips setup; the old CLAUDE_OAUTH_CREDENTIALS doesn't", async () => {
    process.env.CLAUDE_OAUTH_CREDENTIALS = "{\"test\":\"canary\"}";
    let { body } = await call("GET", "/api/settings/setup-status");
    assert.equal(body.needsSetup, true, "the old variable no longer counts");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test-canary-Railway7Qz";
    ({ body } = await call("GET", "/api/settings/setup-status"));
    assert.equal(body.needsSetup, false);
    assert.equal(body.provider, "claude");
    assert.ok(!JSON.stringify(body).includes("sk-ant-oat01-test-canary-Railway7Qz"));
  });

  it("Local AI through Railway variables with no model named: its models are read first, so setup is skipped", async () => {
    // TARSEE_LOCAL_AI_URL alone (no TARSEE_AI_MODEL): Local AI runs on the first model its server lists, but that list
    // lives only in memory, so right after a restart it looked "not set up" and the wizard came back.
    const http = await import("node:http");
    const requests = [];
    const local = http.createServer((req, res) => {
      requests.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "llama3.1:8b" }] }));
    });
    await new Promise((r) => local.listen(0, "127.0.0.1", r));
    try {
      setCatalogModels("local-models", []);
      forgetLocalModelsRead();
      process.env.TARSEE_AI_PROVIDER = "local";
      process.env.TARSEE_LOCAL_AI_URL = `http://127.0.0.1:${local.address().port}/v1`;
      const { body } = await call("GET", "/api/settings/setup-status");
      assert.equal(body.ai.state, "ready", JSON.stringify(body.ai));
      assert.equal(body.needsSetup, false);
      assert.equal(body.provider, "local");
      assert.deepEqual(requests, ["/v1/models"]);
    } finally {
      setCatalogModels("local-models", []);
      forgetLocalModelsRead();
      local.closeAllConnections?.();
      await new Promise((r) => local.close(r));
    }
  });

  it("an AI the owner chose in the wizard or Settings means setup is done", async () => {
    store.set("ai.activeProvider", "claude-code");
    const { body } = await call("GET", "/api/settings/setup-status");
    assert.equal(body.needsSetup, false);
    assert.equal(body.hasKey, true);
    assert.equal(body.provider, "claude");
  });

  it("still reports the personality and bot name as before", async () => {
    store.set("identity.name", "Pip");
    const { body } = await call("GET", "/api/settings/setup-status");
    assert.equal(body.botName, "Pip");
    assert.equal(body.needsPersonality, false);
  });
});

describe("POST /api/settings/provider (the old wizard's route)", () => {
  beforeEach(reset);

  it("takes the public ids and the Claude plan's storage id, and ignores the old wizard's placeholder key", async () => {
    let r = await call("POST", "/api/settings/provider", { provider: "claude-code", apiKey: "subscription" });
    assert.equal(r.status, 200);
    assert.equal(store.get("ai.activeProvider"), "claude-code");
    assert.equal(raw("ai.claude-code.apiKey"), null);
    r = await call("POST", "/api/settings/provider", { provider: "claude", model: "sonnet" });
    assert.equal(r.status, 200);
    assert.equal(store.get("ai.activeProvider"), "claude-code");
    assert.equal(store.get("ai.claude-code.model"), "sonnet");
  });

  it("saves a key provider's key encrypted, checked like Settings > AI does", async () => {
    let r = await call("POST", "/api/settings/provider", { provider: "deepseek", apiKey: KEYS.openrouter });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /OpenRouter key/);
    assert.equal(store.get("ai.activeProvider"), null, "nothing of a refused request is saved");
    r = await call("POST", "/api/settings/provider", { provider: "deepseek", apiKey: KEYS.deepseek });
    assert.equal(r.status, 200);
    assert.equal(store.get("ai.activeProvider"), "deepseek");
    assert.ok(isEncrypted(raw("ai.deepseek.apiKey")));
  });

  it("refuses an unknown provider, a key for a plan, and a base URL", async () => {
    assert.equal((await call("POST", "/api/settings/provider", { provider: "gemini" })).status, 400);
    assert.equal((await call("POST", "/api/settings/provider", { provider: "claude", apiKey: "sk-ant-api03-test-canary-Anth5Rz9" })).status, 400);
    const r = await call("POST", "/api/settings/provider", { provider: "deepseek", baseUrl: "http://canary.invalid" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /base URL/i);
  });
});

describe("the doctor and /healthz/deep", () => {
  beforeEach(reset);

  it("checkProvider: the default AI ready is ok, naming where its key lives by its last 4 only", async () => {
    store.set("ai.activeProvider", "deepseek");
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    const r = await checkProvider(store);
    assert.equal(r.check, "ai_provider");
    assert.equal(r.status, "ok");
    assert.equal(r.provider, "deepseek");
    assert.match(r.detail, /DeepSeek/);
    assert.ok(r.detail.includes(`…${KEYS.deepseek.slice(-4)}`), r.detail);
    assert.ok(!r.detail.includes(KEYS.deepseek.slice(0, -4)));
  });

  it("checkProvider: not ready is an error with what to do; it checks any provider asked for", async () => {
    store.set("ai.activeProvider", "deepseek");
    let r = await checkProvider(store);
    assert.equal(r.status, "error");
    assert.equal(r.state, "needs-key");
    assert.match(r.detail, /DEEPSEEK_API_KEY/);
    r = await checkProvider(store, { providerId: "openrouter" });
    assert.equal(r.provider, "openrouter");
    assert.equal(r.state, "needs-key");
  });

  it("the doctor warns about a connected AI that isn't the default but has stopped working", async () => {
    store.set("ai.activeProvider", "deepseek");
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    store.set("ai.openrouter.status", { state: "auth", at: new Date().toISOString() });
    const checks = await runDiagnostics({ db, settingsStore: store });
    const other = checks.find((c) => c.check === "ai_provider_openrouter");
    assert.ok(other, JSON.stringify(checks.map((c) => c.check)));
    assert.equal(other.status, "warn");
    assert.ok(!checks.some((c) => c.check === "ai_provider_anthropic"), "a provider nobody connected isn't a problem");
  });

  it("/healthz/deep is 503 while the default AI isn't ready, and 200 once it is", async () => {
    store.set("ai.activeProvider", "deepseek");
    let r = await call("GET", "/healthz/deep");
    assert.equal(r.status, 503);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.ai.provider, "deepseek");
    assert.equal(r.body.ai.state, "needs-key");
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    r = await call("GET", "/healthz/deep");
    assert.equal(r.body.ai.state, "ready");
    assert.equal(r.body.ai.ready, true);
    signedIn = true;   // (only a signed-in caller gets the checks that would explain a failure here)
    const why = await call("GET", "/healthz/deep");
    assert.equal(r.status, 200, JSON.stringify(why.body.checks.filter((c) => c.status === "error")));
  });

  it("/healthz/deep without signing in: the 503/200 signal and the default AI's id and state, nothing more", async () => {
    // Local AI is the default, at an internal address, with no model chosen; another AI's key was turned down.
    store.set("ai.activeProvider", "local");
    store.set("ai.local.baseUrl", "http://ollama.railway.internal:11434/v1");
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    store.set("ai.openrouter.status", { state: "auth", at: new Date().toISOString() });
    const res = await fetch(`${base}/healthz/deep`);
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.ok(!text.includes("railway.internal"), `the Local AI's address: ${text}`);
    assert.ok(!text.includes("ai_provider_"), `the other AIs' checks: ${text}`);
    assert.ok(!/OpenRouter/i.test(text), `which other AIs are connected: ${text}`);
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ["ai", "ok", "service", "uptime"]);
    assert.equal(body.ok, false);
    assert.deepEqual(body.ai, { provider: "local", state: "needs-setup", ready: false });
  });

  it("/healthz/deep signed in (a session or the API token): the whole report", async () => {
    store.set("ai.activeProvider", "local");
    store.set("ai.local.baseUrl", "http://ollama.railway.internal:11434/v1");
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    store.set("ai.openrouter.status", { state: "auth", at: new Date().toISOString() });
    signedIn = true;
    const r = await call("GET", "/healthz/deep");
    assert.equal(r.status, 503);
    assert.equal(r.body.ai.provider, "local");
    assert.equal(r.body.ai.state, "needs-setup");
    assert.equal(r.body.ai.ready, false);
    assert.match(r.body.ai.detail, /railway\.internal/, "what to fix, for the owner");
    assert.ok(Array.isArray(r.body.checks));
    assert.ok(r.body.checks.some((c) => c.check === "ai_provider_openrouter"), JSON.stringify(r.body.checks.map((c) => c.check)));
    assert.ok(r.body.errors && typeof r.body.errors === "object");
  });

  it("/healthz is unchanged and answers 200 whether or not any AI is connected", async () => {
    store.set("ai.activeProvider", "deepseek");
    const r = await call("GET", "/healthz");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ["ok", "service", "version", "uptime", "memory", "stateDir", "volumeMounted"]);
    assert.equal(r.body.ok, true);
  });
});
