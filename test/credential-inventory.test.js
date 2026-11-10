// The credential inventory (lib/credential-inventory.js) goes into the agent's system prompt so it knows what it can
// reach without a tool call. Its "AI providers ready" list reads the same readiness Settings > AI shows
// (ai/provider-status.js credentialPresence): a plan is ready only once it is signed in, Local AI once it has an
// address, a key provider once it has its key. It names each AI by its public id and never carries a key.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-cred-inventory-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
const CLEARED = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY", "TARSEE_KEYS_ONLY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_HOME"];
for (const k of CLEARED) delete process.env[k];
// No Claude sign-in from this machine's own home.
process.env.HOME = path.join(tmp, "home");
process.env.USERPROFILE = path.join(tmp, "home");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { getCredentialInventory, renderInventoryPromptSection } = await import("../src/lib/credential-inventory.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const store = new SettingsStore(db);
const DEEPSEEK_KEY = "sk-testcanarydeepseek0000000000";
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => {
  for (const k of CLEARED) delete process.env[k];
  for (const { key } of store.getByPrefix("ai.")) store.delete(key);
});

const ready = () => getCredentialInventory({ settingsStore: store }).providers.filter((p) => p.configured).map((p) => p.id);

describe("the credential inventory's AI providers", () => {
  it("nothing set up: no AI is ready (a plan isn't ready just because it needs no key)", () => {
    assert.deepEqual(ready(), []);
    assert.doesNotMatch(renderInventoryPromptSection(getCredentialInventory({ settingsStore: store })), /AI providers ready/);
  });

  it("each AI once it can answer: a key, a sign-in, a server address", () => {
    store.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";
    process.env.TARSEE_LOCAL_AI_URL = "http://127.0.0.1:11434/v1";
    store.set("ai.local.model", "qwen3:8b");
    fs.mkdirSync(path.join(tmp, ".codex-home"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex-home", "auth.json"), "{}");
    try {
      assert.deepEqual(ready().sort(), ["chatgpt", "claude", "deepseek", "local"]);
      const inv = getCredentialInventory({ settingsStore: store });
      const ds = inv.providers.find((p) => p.id === "deepseek");
      assert.equal(ds.source, "db");
      assert.equal(ds.model, "deepseek-flash");
      assert.equal(inv.providers.find((p) => p.id === "claude").source, "sign-in");
      const text = renderInventoryPromptSection(inv);
      assert.match(text, /- deepseek \(deepseek-flash\) — configured via db/);
      assert.match(text, /- claude .*— signed in/);
      assert.ok(!text.includes(DEEPSEEK_KEY) && !text.includes("test-canary-claude-oauth-token"), "never a key");
    } finally {
      fs.rmSync(path.join(tmp, ".codex-home"), { recursive: true, force: true });
    }
  });

  it("a key from the environment says so; API keys only takes the plans out", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-testcanaryrouter00000";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";
    store.set("ai.keysOnly", true);
    const inv = getCredentialInventory({ settingsStore: store });
    assert.deepEqual(inv.providers.filter((p) => p.configured).map((p) => p.id), ["openrouter"]);
    assert.equal(inv.providers.find((p) => p.id === "openrouter").source, "env");
  });
});
