// "API keys only" promises that no plan sign-in is ever used. Reading the ChatGPT account's model list starts
// `codex app-server` in the plan's home, which sends the plan's sign-in to ChatGPT's backend, so with keys-only on
// (the ai.keysOnly setting, or TARSEE_KEYS_ONLY=1) /api/ai (src/routes/ai.js) never reads it either: not for a model
// change on the ChatGPT card (PUT /providers/chatgpt, which a script or a Settings tab left open can still send),
// not for its model list, and not when a device sign-in started before keys-only was switched on finishes later.
// lib/model-catalog.js's own reader has the same rule (test/chatgpt-list-keys-only.test.js). Every Codex call here is
// a stub that counts.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-ai-keys-only-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
const CLEARED = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_KEY",
  "TARSEE_LOCAL_AI_URL", "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_HOME", "CODEX_HOME",
];
for (const name of CLEARED) delete process.env[name];

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { createAiRouter } = await import("../src/routes/ai.js");
const { setCatalogModels, catalogModels } = await import("../src/ai/provider-registry.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const store = new SettingsStore(db);
const emptyClaudeHome = fs.mkdtempSync(path.join(tmp, "claude-empty-"));

/** Every time Codex would have been started for the account's model list. */
const listCalls = [];
const listAccountModels = async (opts) => {
  listCalls.push(opts);
  return [{ id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium"], default: true }];
};
const deviceLogins = [];
function startDeviceLogin() {
  let settle;
  const done = new Promise((r) => { settle = r; });
  deviceLogins.push({ finish: (r) => settle(r) });
  return Promise.resolve({ url: "https://auth.openai.com/codex/device", code: "ABCD-0001", expiresAt: Date.now() + 15 * 60 * 1000, done, cancel: () => settle({ ok: false, error: "cancelled" }) });
}

const servers = [];
async function serve(deps = {}) {
  const app = express();
  app.use(express.json());
  app.set("db", db);
  app.set("settingsStore", store);
  app.use("/api/ai", createAiRouter({
    stateDir: tmp,
    claudeHomes: () => [emptyClaudeHome],
    loginStatus: async () => ({ signedIn: true, method: "chatgpt", email: "you@example.com", plan: "plus" }),
    startDeviceLogin,
    logout: async () => ({ ok: true }),
    listAccountModels,
    fetch: async (url) => { throw new TypeError(`fetch failed: nothing answers ${url} in this test`); },
    rateLimits: { test: { max: 1000 }, verify: { max: 1000 }, login: { max: 1000 } },
    ...deps,
  }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

let api;
let locked;
before(async () => {
  api = await serve();
  locked = await serve({ env: { TARSEE_KEYS_ONLY: "1" } });
});
after(() => {
  for (const s of servers) s.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.prepare("DELETE FROM settings").run();
  listCalls.length = 0;
  // After a restart with keys-only on the catalog is always empty (the boot read is skipped), so a model check would
  // have to read the list.
  setCatalogModels("chatgpt-models", []);
});

const KEYS_ONLY_WAYS = [
  ["keys-only switched on in Settings", () => { store.set("ai.keysOnly", true); return api; }],
  ["keys-only locked on by TARSEE_KEYS_ONLY=1", () => locked],
];

describe("API keys only: the ChatGPT card's model never starts Codex", () => {
  for (const [way, on] of KEYS_ONLY_WAYS) {
    it(`${way}: PUT /providers/chatgpt with a model or a background model is refused, and the list isn't read`, async () => {
      const call = on();
      for (const body of [{ model: "gpt-6-luna" }, { backgroundModel: "gpt-6-luna" }]) {
        const r = await call("PUT", "/providers/chatgpt", body);
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body.state, "blocked-keys-only");
        assert.match(r.body.error, /API keys only/);
      }
      assert.equal(listCalls.length, 0, "Codex was never started for the account's list");
      assert.equal(store.get("ai.chatgpt.model"), null);
      assert.equal(store.get("ai.chatgpt.backgroundModel"), null);
      assert.deepEqual(catalogModels("chatgpt-models"), []);
    });

    it(`${way}: the ChatGPT card's model can still be cleared, and its list isn't read for it`, async () => {
      const call = on();
      store.set("ai.chatgpt.model", "gpt-6-luna");
      const r = await call("PUT", "/providers/chatgpt", { model: null });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(store.get("ai.chatgpt.model"), null);
      assert.equal(listCalls.length, 0);
    });

    it(`${way}: GET /models/chatgpt is refused without reading the list`, async () => {
      const r = await on()("GET", "/models/chatgpt");
      assert.equal(r.status, 409);
      assert.equal(r.body.state, "blocked-keys-only");
      assert.equal(listCalls.length, 0);
    });
  }

  it("a Claude plan model needs no list, so it can still be chosen with keys-only on", async () => {
    store.set("ai.keysOnly", true);
    const r = await api("PUT", "/providers/claude", { model: "sonnet" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.get("ai.claude-code.model"), "sonnet");
    assert.equal(listCalls.length, 0);
  });

  it("a device sign-in started before keys-only was switched on doesn't read the list when it finishes", async () => {
    let r = await api("POST", "/chatgpt/login");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "waiting");
    r = await api("PUT", "/keys-only", { on: true });
    assert.equal(r.status, 200);
    deviceLogins.at(-1).finish({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(listCalls.length, 0, "Codex was never started for the account's list");
    assert.deepEqual(catalogModels("chatgpt-models"), []);
  });

  it("with keys-only off it reads the list as before: for a model change, and when a sign-in finishes", async () => {
    let r = await api("PUT", "/providers/chatgpt", { model: "gpt-6-luna" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.get("ai.chatgpt.model"), "gpt-6-luna");
    assert.equal(listCalls.length, 1);

    setCatalogModels("chatgpt-models", []);
    r = await api("POST", "/chatgpt/login");
    assert.equal(r.body.state, "waiting");
    deviceLogins.at(-1).finish({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(listCalls.length, 2, "read once the sign-in finished");
    assert.deepEqual(catalogModels("chatgpt-models").map((m) => m.id), ["gpt-6-luna"]);
  });
});
