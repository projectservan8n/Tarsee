// "A provider key in the environment never picks the active provider" (design 4.3 and the Phase 0 settings test),
// with every provider shipped: AI_PROVIDERS holds DeepSeek, OpenRouter, OpenAI and the rest with their key variables,
// so the old key-presence auto-detect (a loop over AI_PROVIDERS reading process.env[def.envKey]) would fire if it came
// back, and getActiveProvider() must still answer only with the owner's choice. Every key here is an obvious fake.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-settings-ship-all-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { AI_PROVIDERS } = await import("../src/config/constants.js");
const { PROVIDERS } = await import("../src/ai/provider-registry.js");

const db = initDb(path.join(tmp, "tarsee.db"));
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** Every provider's key variable, each given a fake key. */
const CANARIES = Object.fromEntries(Object.values(PROVIDERS).filter((p) => p.envKey).map((p) => [p.envKey, `sk-test-canary-${p.envKey}`]));

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe("with every provider shipped, the environment still never picks the active provider", () => {
  it("every provider is shipped and in AI_PROVIDERS, most with a key variable", () => {
    assert.deepEqual(Object.keys(AI_PROVIDERS).sort(), Object.values(PROVIDERS).map((p) => p.storageId).sort());
    assert.ok(Object.keys(CANARIES).length >= 5, JSON.stringify(Object.keys(CANARIES)));
  });

  it("no provider chosen: every provider's key in the environment, and still no provider", () => {
    const store = new SettingsStore(db);
    store.setActiveProvider(null);
    withEnv(CANARIES, () => assert.equal(store.getActiveProvider(), null, "a key in the environment chose the provider"));
  });

  it("the Claude plan chosen: it stays the provider, and no key reaches it", () => {
    const store = new SettingsStore(db);
    store.setActiveProvider("claude-code");
    withEnv(CANARIES, () => {
      const active = store.getActiveProvider();
      assert.equal(active.provider, "claude-code");
      assert.equal(active.apiKey, null);
    });
  });

  it("DeepSeek chosen: it stays DeepSeek with its own key, whatever else is in the environment", () => {
    const store = new SettingsStore(db);
    store.setActiveProvider("deepseek");
    withEnv(CANARIES, () => {
      const active = store.getActiveProvider();
      assert.equal(active.provider, "deepseek");
      assert.equal(active.apiKey, CANARIES.DEEPSEEK_API_KEY);
    });
  });
});
