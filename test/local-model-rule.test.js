// Local AI's one rule for "verify first" (design 4.11): the model chosen on the Local AI card (ai.local.model, or the
// TARSEE_AI_MODEL variable while Local AI is the default AI, exactly as the turn layer reads it) runs at once; any
// other Local AI model must be verified before a chat's model menu or /model can pick it. The card and the wizard
// still list every model the server has (needsVerification stays false), and each row says whether the composer's
// menu takes it (inMenu), so the card can offer Verify on that row without changing the chosen model.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-local-rule-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);
const CLEARED = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_KEY",
  "TARSEE_LOCAL_AI_URL", "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_HOME",
];
for (const name of CLEARED) delete process.env[name];

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { checkModel, modelChoices, getModelGroups } = await import("../src/lib/model-catalog.js");
const { setCatalogModels } = await import("../src/ai/provider-registry.js");
const { createAiRouter } = await import("../src/routes/ai.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const store = new SettingsStore(db);
const LOCAL_URL = "http://local-ai.test:11434/v1";
const RAILWAY = { TARSEE_AI_PROVIDER: "local", TARSEE_LOCAL_AI_URL: LOCAL_URL, TARSEE_AI_MODEL: "qwen3" };
const verifiedEntry = { engine: "codex", at: "2026-11-09T00:00:00.000Z", engineVersion: null, efforts: [], checks: null };

function reset() {
  for (const name of CLEARED) delete process.env[name];
  db.prepare("DELETE FROM settings").run();
  setCatalogModels("local-models", [{ id: "qwen3" }, { id: "llama3" }]);
}
after(() => { setCatalogModels("local-models", []); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const selectable = (choices) => Object.fromEntries(choices.map((c) => [c.id, c.selectable]));

describe("the composer's menu and /model (lib/model-catalog.js)", () => {
  beforeEach(reset);

  it("the model chosen on the card runs at once; any other must be verified first", () => {
    store.set("ai.activeProvider", "local");
    store.set("ai.local.model", "qwen3");
    assert.deepEqual(selectable(modelChoices("local", store)), { qwen3: true, llama3: false });
    assert.equal(checkModel("local", "qwen3", store).ok, true);
    const r = checkModel("local", "llama3", store);
    assert.equal(r.ok, false);
    assert.equal(r.verify, true);
    store.set("ai.local.verified", { llama3: verifiedEntry });
    assert.equal(checkModel("local", "llama3", store).ok, true, "verified on its own row");
  });

  it("a Railway-only setup: TARSEE_AI_MODEL is the chosen model while Local AI is the default AI", () => {
    Object.assign(process.env, RAILWAY);
    const r = checkModel("local", "qwen3", store);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.model, "qwen3");
    assert.deepEqual(selectable(modelChoices("local", store)), { qwen3: true, llama3: false });
    assert.equal(checkModel("local", "llama3", store).ok, false);
  });

  it("TARSEE_AI_MODEL as a ref naming Local AI counts too; one naming another AI doesn't", () => {
    Object.assign(process.env, RAILWAY, { TARSEE_AI_MODEL: "local:qwen3" });
    assert.equal(checkModel("local", "qwen3", store).ok, true);
    process.env.TARSEE_AI_MODEL = "deepseek:deepseek-flash";
    assert.equal(checkModel("local", "qwen3", store).ok, false);
  });

  it("TARSEE_AI_MODEL doesn't count while another AI is the default, nor over the card's own choice", () => {
    Object.assign(process.env, RAILWAY);
    store.set("ai.activeProvider", "deepseek");   // the setting wins over TARSEE_AI_PROVIDER, as in the turn layer
    assert.equal(checkModel("local", "qwen3", store).ok, false);
    store.set("ai.activeProvider", "local");
    store.set("ai.local.model", "llama3");
    assert.deepEqual(selectable(modelChoices("local", store)), { qwen3: false, llama3: true });
  });

  it("the composer's groups take the env they are given", async () => {
    const statusFor = async (id) => (id === "local" ? { state: "ready" } : { state: "needs-key" });
    const { groups } = await getModelGroups({ store, env: { ...RAILWAY }, statusFor });
    const local = groups.find((g) => g.provider === "local");
    assert.ok(local, JSON.stringify(groups.map((g) => g.provider)));
    const entries = local.sections.flatMap((s) => s.entries);
    assert.equal(entries.find((e) => e.id === "qwen3")?.selectable, true, "the chosen model is in the menu");
    assert.equal(entries.find((e) => e.id === "llama3")?.selectable, false, "Verify to use");
  });
});

describe("GET /api/ai/models/local (the card and the wizard)", () => {
  let server;
  let base;
  let env = {};
  before(async () => {
    const app = express();
    app.use(express.json());
    app.set("db", db);
    app.set("settingsStore", store);
    const fakeFetch = async (url) => {
      if (!String(url).startsWith("http://local-ai.test:11434/")) throw new TypeError(`fetch failed: no stub for ${url}`);
      return new Response(JSON.stringify({ data: [{ id: "qwen3" }, { id: "llama3" }, { id: "mistral" }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    app.use("/api/ai", createAiRouter({
      fetch: fakeFetch,
      stateDir: tmp,
      get env() { return env; },
      claudeHomes: () => [],
      loginStatus: async () => ({ signedIn: false }),
      rateLimits: { test: { max: 1000 }, verify: { max: 1000 }, login: { max: 1000 } },
    }));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api/ai`;
  });
  after(() => server?.close());
  beforeEach(() => { reset(); env = {}; });

  it("lists every model the server has, and says which ones the composer's menu takes", async () => {
    store.set("ai.activeProvider", "local");
    store.set("ai.local.baseUrl", LOCAL_URL);
    store.set("ai.local.model", "qwen3");
    store.set("ai.local.verified", { mistral: verifiedEntry });
    const res = await fetch(`${base}/models/local`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const rows = Object.fromEntries(body.models.map((m) => [m.id, m]));
    assert.deepEqual(Object.keys(rows).sort(), ["llama3", "mistral", "qwen3"]);
    for (const m of body.models) assert.equal(m.needsVerification, false, `${m.id}: the card and the wizard list every model`);
    assert.equal(rows.qwen3.inMenu, true, "the card's model");
    assert.equal(rows.mistral.inMenu, true, "verified");
    assert.equal(rows.mistral.verified, true);
    assert.equal(rows.llama3.inMenu, false, "needs Verify on its row first");
  });

  it("follows the route's env: TARSEE_AI_MODEL while Local AI is the default", async () => {
    env = { ...RAILWAY };
    const res = await fetch(`${base}/models/local`);
    assert.equal(res.status, 200);
    const rows = Object.fromEntries((await res.json()).models.map((m) => [m.id, m]));
    assert.equal(rows.qwen3.inMenu, true);
    assert.equal(rows.llama3.inMenu, false);
  });
});
