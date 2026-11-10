// providerStatus(id, deps) (src/ai/provider-status.js, design 4.3 and 4.14): one answer per provider to "can this AI
// answer right now, and if not, what does the owner do?", read from Settings, the environment, the sign-in files and
// the failure flags the engines write. It never makes a network call (the balances it shows come from the 10-minute
// cache the Test and the provider cards fill), and it never hands out a key: only where it came from and its last 4
// characters. Also the one boot line ("[ai] default=... engine=... key=... state"). Every key here is an obvious fake.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-provider-status-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);

// Nothing from the machine running the tests may decide a result: a developer's own keys and sign-ins are cleared.
const CLEARED = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_KEY",
  "TARSEE_LOCAL_AI_URL", "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_HOME",
  "CODEX_HOME",
];
for (const name of CLEARED) delete process.env[name];

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const status = await import("../src/ai/provider-status.js");
const { providerStatus, credentialPresence, aiBootLine, activeTarget, PROVIDER_STATES, BALANCE_TTL_MS, saveBalance } = status;
const { PROVIDER_IDS } = await import("../src/ai/provider-registry.js");

const KEYS = {
  anthropic: "sk-ant-api03-test-canary-Anth5Rz9",
  openai: "sk-test-canary-Openai7Wx2",
  openrouter: "sk-or-v1-testcanaryRouter9Q",
  deepseek: "sk-testcanaryDeepseek3Kp",
  local: "test-canary-Local8Mn",
};

let dbn = 0;
const opened = [];
function freshStore() {
  const db = initDb(path.join(tmp, `status-${++dbn}.db`));
  opened.push(db);
  return new SettingsStore(db);
}
after(() => { for (const db of opened) db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** A claude home with no sign-in, so the machine's own ~/.claude never counts. */
const emptyClaudeHome = fs.mkdtempSync(path.join(tmp, "claude-empty-"));
const signedInClaudeHome = fs.mkdtempSync(path.join(tmp, "claude-signed-"));
fs.writeFileSync(path.join(signedInClaudeHome, ".credentials.json"), "{\"claudeAiOauth\":{\"accessToken\":\"test-canary\"}}");

function deps(store, extra = {}) {
  return {
    store,
    env: {},
    stateDir: tmp,
    claudeHomes: () => [emptyClaudeHome],
    loginStatus: async () => ({ signedIn: false }),
    ...extra,
  };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

/** Nothing in a status may carry a key, whole or in part beyond its last 4 characters. */
function assertNoKey(value, key) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(key), `the key leaked: ${text}`);
  assert.ok(!text.includes(key.slice(0, -4)), `most of the key leaked: ${text}`);
}

describe("providerStatus: every provider has an answer", () => {
  it("every provider id gives one of the eight states, with a plain detail", async () => {
    const store = freshStore();
    for (const id of PROVIDER_IDS) {
      const s = await providerStatus(id, deps(store));
      assert.ok(PROVIDER_STATES.includes(s.state), `${id}: ${s.state}`);
      assert.equal(s.id, id);
      assert.equal(typeof s.label, "string");
      assert.equal(typeof s.detail, "string");
      assert.ok(s.detail.length > 0, id);
      assert.equal(s.ready, s.state === "ready");
    }
  });

  it("an unknown provider is an error, not a throw", async () => {
    const s = await providerStatus("gemini", deps(freshStore()));
    assert.equal(s.state, "error");
    assert.match(s.detail, /doesn't know/i);
  });

  it("the Claude plan's storage id is the same provider", async () => {
    const s = await providerStatus("claude-code", deps(freshStore()));
    assert.equal(s.id, "claude");
  });
});

describe("key providers", () => {
  beforeEach(() => { for (const name of CLEARED) delete process.env[name]; });

  for (const [id, envKey] of [["anthropic", "ANTHROPIC_API_KEY"], ["openai", "OPENAI_API_KEY"], ["openrouter", "OPENROUTER_API_KEY"], ["deepseek", "DEEPSEEK_API_KEY"]]) {
    it(`${id}: no key is needs-key, naming the Railway variable; a saved key is ready and shows only its last 4`, async () => {
      const store = freshStore();
      const none = await providerStatus(id, deps(store));
      assert.equal(none.state, "needs-key");
      assert.match(none.fix, new RegExp(envKey));
      assert.equal(none.keySource, null);

      store.set(`ai.${id}.apiKey`, KEYS[id]);
      const saved = await providerStatus(id, deps(store));
      assert.equal(saved.state, "ready", saved.detail);
      assert.equal(saved.keySource, "settings");
      assert.equal(saved.keyHint, `…${KEYS[id].slice(-4)}`);
      assert.match(saved.keySourceText, /Saved in Tarsee \(encrypted\)/);
      assertNoKey(saved, KEYS[id]);
    });

    it(`${id}: a key from the Railway variable says so`, async () => {
      const store = freshStore();
      await withEnv({ [envKey]: KEYS[id] }, async () => {
        const s = await providerStatus(id, deps(store));
        assert.equal(s.state, "ready", s.detail);
        assert.equal(s.keySource, `env:${envKey}`);
        assert.equal(s.keySourceText, `Railway variable ${envKey}`);
        assertNoKey(s, KEYS[id]);
      });
    });
  }

  it("a key in the wrong slot is an error that says whose key it is (a Claude sign-in token as the Anthropic key)", async () => {
    const store = freshStore();
    await withEnv({ ANTHROPIC_API_KEY: "sk-ant-oat01-test-canary-SignIn4Tk" }, async () => {
      const s = await providerStatus("anthropic", deps(store));
      assert.equal(s.state, "error");
      assert.match(s.detail, /Claude sign-in token/);
      assert.match(s.fix, /ANTHROPIC_API_KEY/);
      assertNoKey(s, "sk-ant-oat01-test-canary-SignIn4Tk");
    });
  });

  it("an OpenRouter key saved as the DeepSeek key is an error naming OpenRouter", async () => {
    const store = freshStore();
    store.set("ai.deepseek.apiKey", KEYS.openrouter);
    const s = await providerStatus("deepseek", deps(store));
    assert.equal(s.state, "error");
    assert.match(s.detail, /OpenRouter key/);
  });

  it("the engines' failure flag: a rejected key is an error, an empty balance is out-of-credit", async () => {
    const store = freshStore();
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    store.set("ai.deepseek.status", { state: "auth", at: new Date().toISOString(), detail: "401 from the gateway" });
    let s = await providerStatus("deepseek", deps(store));
    assert.equal(s.state, "error");
    assert.match(s.detail, /DeepSeek key was rejected/);
    store.set("ai.deepseek.status", { state: "billing", at: new Date().toISOString() });
    s = await providerStatus("deepseek", deps(store));
    assert.equal(s.state, "out-of-credit");
    assert.match(s.fix, /platform\.deepseek\.com/);
    // The values the turn layer writes (turn.js writeFailureFlag) and engine-errors' failureStateFor.
    store.set("ai.deepseek.status", { state: "out-of-credit", at: new Date().toISOString() });
    assert.equal((await providerStatus("deepseek", deps(store))).state, "out-of-credit");
    store.set("ai.deepseek.status", { state: "error", at: new Date().toISOString(), detail: "The key was turned down." });
    s = await providerStatus("deepseek", deps(store));
    assert.equal(s.state, "error");
    assert.match(s.detail, /turned down/);
    store.set("ai.deepseek.status", { state: "needs-key", at: new Date().toISOString() });
    assert.equal((await providerStatus("deepseek", deps(store))).state, "ready", "a flag that disagrees with the facts (the key is there) doesn't count");
    assert.equal((await providerStatus("deepseek", deps(store, { ignoreFlags: true }))).state, "ready");
    store.delete("ai.deepseek.status");
    s = await providerStatus("deepseek", deps(store));
    assert.equal(s.state, "ready");
  });

  it("a fresh cached balance shows on the card, and an empty one is out-of-credit; a stale or another key's is ignored", async () => {
    const store = freshStore();
    store.set("ai.openrouter.apiKey", KEYS.openrouter);
    const hint = `…${KEYS.openrouter.slice(-4)}`;
    const now = Date.now();
    saveBalance(store, "openrouter", { kind: "limit", currency: "USD", remaining: 1.8, limit: 2, empty: false, text: "Spending limit left $1.80 of $2.00" }, { now, keyHint: hint });
    let s = await providerStatus("openrouter", deps(store, { now: () => now }));
    assert.equal(s.state, "ready");
    assert.equal(s.balance.text, "Spending limit left $1.80 of $2.00");

    saveBalance(store, "openrouter", { kind: "limit", currency: "USD", remaining: 0, limit: 2, empty: true, text: "Spending limit left $0.00 of $2.00" }, { now, keyHint: hint });
    s = await providerStatus("openrouter", deps(store, { now: () => now }));
    assert.equal(s.state, "out-of-credit");
    assert.match(s.fix, /openrouter\.ai\/settings\/keys/);

    s = await providerStatus("openrouter", deps(store, { now: () => now + BALANCE_TTL_MS + 1 }));
    assert.equal(s.state, "ready", "a stale balance no longer decides");
    assert.equal(s.balance, null);

    saveBalance(store, "openrouter", { kind: "limit", currency: "USD", remaining: 0, limit: 2, empty: true, text: "x" }, { now, keyHint: "…zzzz" });
    s = await providerStatus("openrouter", deps(store, { now: () => now }));
    assert.equal(s.state, "ready", "a balance read for another key doesn't count");
  });
});

describe("the Claude plan", () => {
  beforeEach(() => { for (const name of CLEARED) delete process.env[name]; });

  it("no sign-in is needs-sign-in, with claude auth login and the Railway variable as fixes", async () => {
    const s = await providerStatus("claude", deps(freshStore()));
    assert.equal(s.state, "needs-sign-in");
    assert.match(s.fix, /claude auth login/);
    // The pinned CLI has no top-level `login` (it would open a chat), and the card's only button is Check.
    assert.doesNotMatch(s.fix, /claude login/);
    assert.match(s.fix, /click Check/);
    assert.doesNotMatch(s.fix, /press Test/i);
    assert.match(s.fix, /CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("a .credentials.json in a Claude home is ready", async () => {
    const s = await providerStatus("claude", deps(freshStore(), { claudeHomes: () => [emptyClaudeHome, signedInClaudeHome] }));
    assert.equal(s.state, "ready", s.detail);
    assert.equal(s.keySource, "sign-in");
  });

  it("CLAUDE_CODE_OAUTH_TOKEN in the environment is ready, shown by name and last 4 only", async () => {
    const token = "sk-ant-oat01-test-canary-Railway7Qz";
    const s = await providerStatus("claude", deps(freshStore(), { env: { CLAUDE_CODE_OAUTH_TOKEN: token } }));
    assert.equal(s.state, "ready");
    assert.equal(s.keySource, "env:CLAUDE_CODE_OAUTH_TOKEN");
    assert.equal(s.keyHint, `…${token.slice(-4)}`);
    assertNoKey(s, token);
  });

  it("a refresh-token login counts as signed in too", async () => {
    const s = await providerStatus("claude", deps(freshStore(), { env: { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "test-canary-refresh-Rf3", CLAUDE_CODE_OAUTH_SCOPES: "user:inference" } }));
    assert.equal(s.state, "ready");
  });

  it("an expired sign-in flag is sign-in-expired", async () => {
    const store = freshStore();
    store.set("ai.claude.status", { state: "auth-expired", at: new Date().toISOString() });
    const s = await providerStatus("claude", deps(store, { claudeHomes: () => [signedInClaudeHome] }));
    assert.equal(s.state, "sign-in-expired");
    assert.match(s.fix, /claude auth login/);
    assert.doesNotMatch(`${s.detail} ${s.fix}`, /claude login/);
    assert.equal(`${s.detail} ${s.fix}`.split("claude auth login").length, 2, "the command is said once, not in the detail too");
  });

  it("API keys only blocks it, and says how to turn that off (or that a Railway variable locks it)", async () => {
    const store = freshStore();
    store.set("ai.keysOnly", true);
    let s = await providerStatus("claude", deps(store, { claudeHomes: () => [signedInClaudeHome] }));
    assert.equal(s.state, "blocked-keys-only");
    assert.match(s.fix, /Settings > AI/);
    s = await providerStatus("claude", deps(freshStore(), { env: { TARSEE_KEYS_ONLY: "1" }, claudeHomes: () => [signedInClaudeHome] }));
    assert.equal(s.state, "blocked-keys-only");
    assert.match(s.fix, /TARSEE_KEYS_ONLY/);
  });
});

describe("the ChatGPT plan", () => {
  it("reads Codex's own sign-in through loginStatus, in the .codex-home under the state folder", async () => {
    const seen = [];
    const s = await providerStatus("chatgpt", deps(freshStore(), {
      loginStatus: async (opts) => { seen.push(opts); return { signedIn: true, email: "owner@example.com", plan: "free" }; },
    }));
    assert.equal(s.state, "ready");
    assert.equal(s.account, "owner@example.com (Free)");
    assert.equal(seen[0].codexHome, path.join(tmp, ".codex-home"));
  });

  it("not signed in is needs-sign-in; an expired sign-in is sign-in-expired", async () => {
    let s = await providerStatus("chatgpt", deps(freshStore()));
    assert.equal(s.state, "needs-sign-in");
    assert.match(s.fix, /Settings > AI/);
    assert.match(s.fix, /codex login --device-auth/);
    s = await providerStatus("chatgpt", deps(freshStore(), { loginStatus: async () => ({ signedIn: true, expired: true }) }));
    assert.equal(s.state, "sign-in-expired");
    assert.equal(`${s.detail} ${s.fix}`.split("codex login --device-auth").length, 2, "the command is said once, not in the detail too");
    // The ChatGPT card's only button is Check, like the Claude plan's.
    const flagged = freshStore();
    flagged.set("ai.chatgpt.status", { state: "error", at: new Date().toISOString() });
    s = await providerStatus("chatgpt", deps(flagged, { loginStatus: async () => ({ signedIn: true, method: "chatgpt" }) }));
    assert.equal(s.state, "error");
    assert.match(s.fix, /Click Check/);
    assert.doesNotMatch(s.fix, /Press Test/);
  });

  it("an API-key login, or some other kind, in the ChatGPT sign-in folder is not a ChatGPT sign-in", async () => {
    let s = await providerStatus("chatgpt", deps(freshStore(), { loginStatus: async () => ({ signedIn: true, authMode: "apikey" }) }));
    assert.equal(s.state, "needs-sign-in");
    s = await providerStatus("chatgpt", deps(freshStore(), { loginStatus: async () => ({ signedIn: true, method: "api" }) }));
    assert.equal(s.state, "needs-sign-in");
    s = await providerStatus("chatgpt", deps(freshStore(), { loginStatus: async () => ({ signedIn: true, method: "other" }) }));
    assert.equal(s.state, "needs-sign-in");
    assert.match(s.detail, /some other way/);
    s = await providerStatus("chatgpt", deps(freshStore(), { loginStatus: async () => ({ signedIn: true, method: "chatgpt", email: "owner@example.com" }) }));
    assert.equal(s.state, "ready");
  });

  it("the cards read the sign-in file without starting Codex; Test asks Codex itself", async () => {
    const seen = [];
    const loginStatus = async (opts) => { seen.push(opts); return { signedIn: true, method: "chatgpt" }; };
    await providerStatus("chatgpt", deps(freshStore(), { loginStatus }));
    assert.equal(seen[0].cli, false);
    await providerStatus("chatgpt", deps(freshStore(), { loginStatus, loginCli: true }));
    assert.equal(seen[1].cli, true);
  });

  it("a sign-in check that throws is an error, not a crash", async () => {
    const s = await providerStatus("chatgpt", deps(freshStore(), { loginStatus: async () => { throw new Error("codex missing"); } }));
    assert.equal(s.state, "error");
    assert.match(s.detail, /codex missing/);
  });

  it("API keys only blocks it", async () => {
    const store = freshStore();
    store.set("ai.keysOnly", "true");
    const s = await providerStatus("chatgpt", deps(store, { loginStatus: async () => ({ signedIn: true }) }));
    assert.equal(s.state, "blocked-keys-only");
  });
});

describe("Local AI", () => {
  beforeEach(() => { for (const name of CLEARED) delete process.env[name]; });

  it("no address is needs-setup; an address that isn't plain http(s) is needs-setup too", async () => {
    const store = freshStore();
    let s = await providerStatus("local", deps(store));
    assert.equal(s.state, "needs-setup");
    assert.match(s.fix, /TARSEE_LOCAL_AI_URL/);
    store.set("ai.local.baseUrl", "ftp://192.168.1.20/v1");
    s = await providerStatus("local", deps(store));
    assert.equal(s.state, "needs-setup");
    store.set("ai.local.baseUrl", "http://user:pass@192.168.1.20/v1");
    s = await providerStatus("local", deps(store));
    assert.equal(s.state, "needs-setup");
  });

  it("an address without a chosen model is needs-setup; with one it is ready, with no key needed", async () => {
    const store = freshStore();
    store.set("ai.local.baseUrl", "http://192.168.1.20:11434/v1");
    let s = await providerStatus("local", deps(store));
    assert.equal(s.state, "needs-setup");
    assert.match(s.detail, /model/i);
    store.set("ai.local.model", "qwen3:8b");
    s = await providerStatus("local", deps(store));
    assert.equal(s.state, "ready", s.detail);
    assert.match(s.detail, /192\.168\.1\.20/);
  });

  it("TARSEE_LOCAL_AI_URL and TARSEE_AI_MODEL set it up from Railway alone", async () => {
    const s = await providerStatus("local", deps(freshStore(), { env: { TARSEE_LOCAL_AI_URL: "http://ollama.railway.internal:11434/v1", TARSEE_AI_PROVIDER: "local", TARSEE_AI_MODEL: "llama3.3" } }));
    assert.equal(s.state, "ready", s.detail);
  });

  it("another provider's key in the Local AI slot is an error (it would go to a host the owner typed)", async () => {
    const store = freshStore();
    store.set("ai.local.baseUrl", "http://192.168.1.20:11434/v1");
    store.set("ai.local.model", "qwen3:8b");
    store.set("ai.local.apiKey", KEYS.openrouter);
    const s = await providerStatus("local", deps(store));
    assert.equal(s.state, "error");
    assertNoKey(s, KEYS.openrouter);
  });
});

describe("credentialPresence (synchronous, for the security audit)", () => {
  it("answers without the network or Codex: key presence, the claude sign-in file, the ChatGPT auth.json", () => {
    const store = freshStore();
    assert.equal(credentialPresence("deepseek", deps(store)).state, "needs-key");
    store.set("ai.deepseek.apiKey", KEYS.deepseek);
    assert.equal(credentialPresence("deepseek", deps(store)).state, "ready");
    assert.equal(credentialPresence("claude", deps(store)).state, "needs-sign-in");
    const codexHome = fs.mkdtempSync(path.join(tmp, "codex-home-"));
    assert.equal(credentialPresence("chatgpt", deps(store, { codexHome })).state, "needs-sign-in");
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    assert.equal(credentialPresence("chatgpt", deps(store, { codexHome })).state, "ready");
  });
});

describe("activeTarget and the boot line", () => {
  beforeEach(() => { for (const name of CLEARED) delete process.env[name]; });
  const allShipped = () => true;

  it("names the default provider, model, engine, where its key came from (last 4 only) and its state", async () => {
    const store = freshStore();
    store.set("ai.activeProvider", "deepseek");
    await withEnv({ DEEPSEEK_API_KEY: KEYS.deepseek }, async () => {
      const line = await aiBootLine(deps(store, { isShipped: allShipped }));
      assert.equal(line, `[ai] default=deepseek:deepseek-flash engine=claude-code key=env:DEEPSEEK_API_KEY (…${KEYS.deepseek.slice(-4)}) ready`);
      assertNoKey(line, KEYS.deepseek);
    });
  });

  it("TARSEE_AI_PROVIDER and TARSEE_AI_MODEL pick the default when Settings has none", () => {
    const t = activeTarget(freshStore(), { env: { TARSEE_AI_PROVIDER: "deepseek", TARSEE_AI_MODEL: "deepseek-v4-pro" }, isShipped: allShipped });
    assert.deepEqual({ provider: t.provider, model: t.model, engine: t.engine, chosenBy: t.chosenBy },
      { provider: "deepseek", model: "deepseek-v4-pro", engine: "claude-code", chosenBy: "env" });
  });

  it("nothing chosen is the Claude plan; not signed in says so and what to do", async () => {
    const line = await aiBootLine(deps(freshStore()));
    assert.match(line, /^\[ai\] default=claude:\S+ engine=claude-code key=none needs-sign-in/);
    assert.match(line, /claude auth login/);
  });

  it("an ANTHROPIC_API_KEY left in the environment while the Claude plan is the default is called out as unused", async () => {
    const line = await aiBootLine(deps(freshStore(), { env: { ANTHROPIC_API_KEY: KEYS.anthropic }, claudeHomes: () => [signedInClaudeHome] }));
    assert.match(line, /ready/);
    assert.match(line, /ANTHROPIC_API_KEY is set but not used/);
    assertNoKey(line, KEYS.anthropic);
  });
});
