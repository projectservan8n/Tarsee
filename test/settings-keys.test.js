// Provider keys in the settings store (src/db/settings.js), design 4.4, 4.5 R9 and the Phase 0 "db/settings.js" item.
//   - A provider key in the environment never picks the active provider: only the owner's choice does.
//   - getKeyWithSource(id) says where a key came from (encrypted Settings first, then the environment) and shows only
//     its last 4 characters; quotes and whitespace that Railway sometimes adds are trimmed.
//   - Key writes and deletes are audited; reading a key (every turn) is not, and nothing prints a key.
//   - The boot fixup deletes the placeholder apiKey "subscription" the old setup wizard saved for the Claude plan,
//     even when it is stored encrypted, and nothing else.
// Every key here is an obvious fake.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-settings-keys-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
// A test-only encryption key, so values really are encrypted at rest here.
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { AuditLog } = await import("../src/db/audit.js");
const { AI_PROVIDERS } = await import("../src/config/constants.js");
const { PROVIDERS } = await import("../src/ai/provider-registry.js");
const { encrypt, isEncrypted } = await import("../src/lib/vault.js");

/** The environment variables a provider key could arrive in (Railway), each given a fake key. */
const ENV_CANARIES = {
  OPENROUTER_API_KEY: "sk-or-v1-test-canary-Envr0uter9Q",
  OPENAI_API_KEY: "sk-test-canary-EnvOpenai7Wx",
  DEEPSEEK_API_KEY: "sk-test-canary-EnvDeepseek3Kp",
  ANTHROPIC_API_KEY: "sk-ant-api03-test-canary-EnvAnth5Rz",
  TARSEE_LOCAL_AI_KEY: "test-canary-EnvLocal8Mn",
};
for (const def of Object.values(AI_PROVIDERS)) {
  if (def.envKey && !(def.envKey in ENV_CANARIES)) ENV_CANARIES[def.envKey] = `sk-test-canary-${def.envKey}`;
}

let dbn = 0;
const opened = [];
/** A fresh database, its audit log and a store (with or without the audit log handed in). */
function fresh({ withAudit = true } = {}) {
  const db = initDb(path.join(tmp, `settings-${++dbn}.db`));
  opened.push(db);
  const auditLog = new AuditLog(db);
  const store = new SettingsStore(db, withAudit ? auditLog : undefined);
  const audits = () => db.prepare("SELECT action, target, actor, detail FROM audit_log ORDER BY id").all();
  const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  const putRaw = (key, value) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  return { db, store, auditLog, audits, raw, putRaw };
}

/** Runs fn with every provider env variable set to its fake, then puts the environment back. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}
const NO_PROVIDER_ENV = Object.fromEntries(Object.keys(ENV_CANARIES).map((k) => [k, null]));

/** Everything printed to the console while fn runs. */
async function captureConsole(fn) {
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const saved = Object.fromEntries(methods.map((m) => [m, console[m]]));
  const out = [];
  for (const m of methods) console[m] = (...args) => { out.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  try { await fn(); } finally { for (const m of methods) console[m] = saved[m]; }
  return out.join("\n");
}

/** Fails if `text` holds any part of `key` beyond its last 4 characters. */
function assertNoKeyText(text, key, where) {
  assert.ok(!text.includes(key.slice(0, 4)), `${where}: the start of a key was printed:\n${text}`);
  for (let i = 0; i + 5 <= key.length; i++) {
    const piece = key.slice(i, i + 5);
    assert.ok(!text.includes(piece), `${where}: "${piece}" of a key was printed:\n${text}`);
  }
}

after(() => {
  for (const db of opened) db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Phase 0 ships only the Claude plan, which has no key variable, so the old key-presence auto-detect could not fire
// here even if it came back: test/settings-ship-all.test.js runs the same checks with every provider shipped.
describe("the active provider is the owner's choice, never the environment's", () => {
  it("with no provider chosen, provider keys in the environment do not pick one", () => {
    const { store } = fresh();
    withEnv(ENV_CANARIES, () => {
      assert.equal(store.get("ai.activeProvider"), null);
      assert.equal(store.getActiveProvider(), null, "a key in the environment chose the provider");
    });
  });

  it("OPENROUTER_API_KEY or OPENAI_API_KEY in the environment never changes the chosen provider or hands it their key", () => {
    const { store } = fresh();
    store.setActiveProvider("claude-code");
    for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]) {
      withEnv({ ...NO_PROVIDER_ENV, [name]: ENV_CANARIES[name] }, () => {
        const active = store.getActiveProvider();
        assert.equal(active.provider, "claude-code", `${name} changed the provider`);
        assert.equal(active.apiKey, null, `${name} reached the Claude plan`);
        assert.equal(active.ready, true);
      });
    }
    withEnv(ENV_CANARIES, () => {
      const active = store.getActiveProvider();
      assert.equal(active.provider, "claude-code");
      assert.equal(active.apiKey, null, "a provider key in the environment reached the Claude plan");
    });
  });

  it("setActiveProvider(null) clears the choice", () => {
    const { store, raw } = fresh();
    store.setActiveProvider("claude-code");
    assert.equal(store.get("ai.activeProvider"), "claude-code");
    store.setActiveProvider(null);
    assert.equal(raw("ai.activeProvider"), null, "null was saved as a value instead of clearing the choice");
    withEnv(ENV_CANARIES, () => assert.equal(store.getActiveProvider(), null));
    store.setActiveProvider(null); // nothing to clear: still fine
    assert.equal(store.get("ai.activeProvider"), null);
  });

  it("reading the active provider on every turn writes no audit row and prints nothing", async () => {
    const { store, audits } = fresh();
    const key = "sk-test-canary-TurnRead4Qz8Lw2";
    store.setActiveProvider("anthropic", { apiKey: key });
    const rowsBefore = audits().length;
    const printed = await captureConsole(() => {
      for (let i = 0; i < 3; i++) assert.equal(store.getActiveProvider().apiKey, key);
    });
    assert.equal(printed, "", `reading the provider printed:\n${printed}`);
    assert.deepEqual(audits().slice(rowsBefore), [], "reading a key wrote an audit row");
  });
});

describe("getKeyWithSource: where a provider's key comes from", () => {
  beforeEach(() => { for (const k of Object.keys(ENV_CANARIES)) delete process.env[k]; });

  it("encrypted Settings first, then the environment; quotes and whitespace are trimmed", () => {
    const { store, raw } = fresh();
    const saved = "sk-or-v1-test-canary-Saved6Hj2";
    store.set("ai.openrouter.apiKey", `  "${saved}"\n`);
    assert.ok(isEncrypted(raw("ai.openrouter.apiKey")), "the key is not encrypted at rest");
    withEnv({ OPENROUTER_API_KEY: ENV_CANARIES.OPENROUTER_API_KEY }, () => {
      assert.deepEqual(store.getKeyWithSource("openrouter"), { key: saved, source: "settings", hint: "…6Hj2" });
      store.delete("ai.openrouter.apiKey");
      assert.deepEqual(store.getKeyWithSource("openrouter"), {
        key: ENV_CANARIES.OPENROUTER_API_KEY, source: "env:OPENROUTER_API_KEY", hint: "…er9Q",
      });
    });
  });

  it("an environment value wrapped in quotes and spaces (as Railway sometimes stores it) is trimmed", () => {
    const { store } = fresh();
    const key = "sk-test-canary-Quoted5Tb1";
    withEnv({ OPENAI_API_KEY: ` '${key}' \n` }, () => {
      assert.deepEqual(store.getKeyWithSource("openai"), { key, source: "env:OPENAI_API_KEY", hint: "…5Tb1" });
      assert.equal(store.getApiKey("openai"), key, "getApiKey (voice) no longer matches");
    });
  });

  it("no key anywhere: key, source and hint are null", () => {
    const { store } = fresh();
    assert.deepEqual(store.getKeyWithSource("deepseek"), { key: null, source: null, hint: null });
    assert.deepEqual(store.getKeyWithSource(null), { key: null, source: null, hint: null });
    assert.equal(store.getApiKey("deepseek"), null);
  });

  it("a blank saved value does not hide the environment's key", () => {
    const { store } = fresh();
    store.set("ai.deepseek.apiKey", "   ");
    withEnv({ DEEPSEEK_API_KEY: ENV_CANARIES.DEEPSEEK_API_KEY }, () => {
      assert.equal(store.getKeyWithSource("deepseek").source, "env:DEEPSEEK_API_KEY");
    });
  });

  it("each provider reads its own variable; Local AI's is TARSEE_LOCAL_AI_KEY", () => {
    const { store } = fresh();
    withEnv(ENV_CANARIES, () => {
      assert.equal(store.getKeyWithSource("anthropic").source, "env:ANTHROPIC_API_KEY");
      assert.equal(store.getKeyWithSource("deepseek").source, "env:DEEPSEEK_API_KEY");
      assert.equal(store.getKeyWithSource("openai").source, "env:OPENAI_API_KEY");
      assert.equal(store.getKeyWithSource("openrouter").source, "env:OPENROUTER_API_KEY");
      assert.deepEqual(store.getKeyWithSource("local"), { key: ENV_CANARIES.TARSEE_LOCAL_AI_KEY, source: "env:TARSEE_LOCAL_AI_KEY", hint: "…l8Mn" });
      assert.equal(store.getKeyWithSource("local", { envName: "SOME_OTHER_NAME" }).source, null, "an explicit env name is the only one read");
    });
  });

  it("the plan providers take no key from the environment", () => {
    const { store } = fresh();
    withEnv({ ...ENV_CANARIES, CLAUDE_API_KEY: "sk-test-canary-Stray1Cl", CHATGPT_API_KEY: "sk-test-canary-Stray2Cg" }, () => {
      for (const id of ["claude-code", "claude", "chatgpt"]) {
        assert.deepEqual(store.getKeyWithSource(id), { key: null, source: null, hint: null }, id);
      }
    });
  });

  it("the registry names each provider's variable and slot, whatever the id's spelling or alias", () => {
    const { store } = fresh();
    const none = { key: null, source: null, hint: null };
    // Variables a key must never come from: a plan's or Local AI's id with _API_KEY on the end.
    const stray = {
      CLAUDE_API_KEY: "sk-test-canary-Stray1Cl", CLAUDE_CODE_API_KEY: "sk-test-canary-Stray3Cc",
      CHATGPT_API_KEY: "sk-test-canary-Stray2Cg", LOCAL_API_KEY: "sk-test-canary-Stray4Lo",
    };
    withEnv({ ...ENV_CANARIES, ...stray }, () => {
      for (const p of Object.values(PROVIDERS)) {
        for (const spelling of new Set([p.id, p.storageId, p.id.toUpperCase(), p.storageId.toUpperCase()])) {
          const got = store.getKeyWithSource(spelling);
          if (p.kind === "subscription") assert.deepEqual(got, none, `${spelling} is a sign-in plan`);
          else assert.equal(got.source, `env:${p.envKey}`, `${spelling} reads ${p.envKey}`);
        }
      }
      // A saved key is found, and cleared, in the provider's own slot whatever the spelling.
      store.set("ai.openrouter.apiKey", "sk-or-v1-test-canary-Slot7Kq2");
      assert.deepEqual(store.getKeyWithSource("OpenRouter"), { key: "sk-or-v1-test-canary-Slot7Kq2", source: "settings", hint: "…7Kq2" });
      assert.equal(store.clearKey("OPENROUTER"), true);
      assert.equal(store.getKeyWithSource("openrouter").source, "env:OPENROUTER_API_KEY");
    });
    // A key the registry doesn't know (Voice's ElevenLabs) is still <ID>_API_KEY.
    withEnv({ ELEVENLABS_API_KEY: "sk-test-canary-Eleven5Lb" }, () => {
      assert.equal(store.getKeyWithSource("elevenlabs").source, "env:ELEVENLABS_API_KEY");
    });
  });

  it("the hint never shows more than the last 4 characters", () => {
    const { store } = fresh();
    store.set("ai.openai.apiKey", "abc123");
    assert.equal(store.getKeyWithSource("openai").hint, "…");
    store.set("ai.openai.apiKey", "sk-test-canary-Hint0Ab9");
    assert.equal(store.getKeyWithSource("openai").hint, "…0Ab9");
  });
});

describe("clearKey", () => {
  beforeEach(() => { for (const k of Object.keys(ENV_CANARIES)) delete process.env[k]; });

  it("deletes the saved key, so the environment's (if any) applies; clearing twice or clearing null is harmless", () => {
    const { store, raw } = fresh();
    store.set("ai.deepseek.apiKey", "sk-test-canary-Clear7Dk3");
    assert.equal(store.clearKey("deepseek"), true);
    assert.equal(raw("ai.deepseek.apiKey"), null);
    assert.equal(store.clearKey("deepseek"), false);
    assert.equal(store.clearKey(null), false);
    assert.equal(store.clearKey(undefined), false);
    withEnv({ DEEPSEEK_API_KEY: ENV_CANARIES.DEEPSEEK_API_KEY }, () => {
      assert.equal(store.getKeyWithSource("deepseek").source, "env:DEEPSEEK_API_KEY");
    });
  });
});

describe("audit: key writes and deletes, never reads", () => {
  for (const withAudit of [true, false]) {
    it(`${withAudit ? "a store given the audit log" : "a store made without one (as most routes make it)"} audits a write and a delete, never a read, and no row holds key text`, () => {
      const { store, audits } = fresh({ withAudit });
      const key = "sk-test-canary-Audit3Vn6Pq";
      store.set("ai.openrouter.apiKey", key, { actor: "owner", ip: "127.0.0.1" });
      store.getKeyWithSource("openrouter");
      store.getApiKey("openrouter");
      store.setActiveProvider("openrouter");
      store.getActiveProvider();
      store.clearKey("openrouter", { actor: "owner" });
      const rows = audits();
      assert.deepEqual(rows.map((r) => [r.action, r.target]), [
        ["credential.write", "ai.openrouter.apiKey"],
        ["credential.delete", "ai.openrouter.apiKey"],
      ]);
      assert.equal(rows[0].actor, "owner");
      assertNoKeyText(JSON.stringify(rows), key, "audit_log");
    });
  }
});

describe("no key text in console output", () => {
  it("saving, reading, clearing, the boot fixup and the boot key report print no key beyond its last 4 characters", async () => {
    const { store } = fresh();
    const key = "sk-test-canary-Console9Xf4Mz";
    const elevenKey = "sk-test-canary-Ev2Lk7WdQ";
    const envKey = "sk-or-v1-test-canary-EnvLog5Rt8";
    const printed = await captureConsole(() => withEnv({ ...NO_PROVIDER_ENV, OPENROUTER_API_KEY: envKey }, () => {
      store.setActiveProvider("anthropic", { apiKey: key, model: "claude-test-1" });
      store.set("ai.elevenlabs.apiKey", elevenKey);
      store.getActiveProvider();
      store.getKeyWithSource("anthropic");
      store.getKeyWithSource("openrouter");
      store.getApiKey("anthropic");
      store.removeFakeSubscriptionKey();
      store.logKeyStatus();
      store.clearKey("anthropic");
    }));
    assertNoKeyText(printed, key, "console");
    assertNoKeyText(printed, elevenKey, "console");
    assertNoKeyText(printed, envKey, "console");
  });
});

describe("boot fixup: the old setup wizard's placeholder Claude key", () => {
  const SLOT = "ai.claude-code.apiKey";

  it("deletes the plaintext placeholder; running again changes nothing", () => {
    const { store, raw, putRaw, audits } = fresh();
    putRaw(SLOT, "subscription");
    assert.deepEqual(store.removeFakeSubscriptionKey(), { removed: true });
    assert.equal(raw(SLOT), null);
    assert.ok(store.get("fixups.fakeSubscriptionKeyRemovedAt"), "the fixup left no record");
    assert.ok(audits().some((r) => r.action === "credential.delete" && r.target === SLOT), "the removal was not audited");
    const rows = audits().length;
    assert.deepEqual(store.removeFakeSubscriptionKey(), { removed: false });
    assert.equal(audits().length, rows, "the second run wrote another audit row");
  });

  it("deletes the placeholder when it is stored encrypted (what Settings does once ENCRYPTION_KEY is set)", () => {
    const { store, raw } = fresh();
    store.set(SLOT, "subscription");
    assert.ok(isEncrypted(raw(SLOT)), "precondition: the placeholder is encrypted at rest");
    assert.deepEqual(store.removeFakeSubscriptionKey(), { removed: true });
    assert.equal(raw(SLOT), null);
    assert.deepEqual(store.removeFakeSubscriptionKey(), { removed: false });
  });

  it("deletes the JSON-quoted form of the same literal", () => {
    const { store, raw, putRaw } = fresh();
    putRaw(SLOT, encrypt(JSON.stringify("subscription")));
    assert.deepEqual(store.removeFakeSubscriptionKey(), { removed: true });
    assert.equal(raw(SLOT), null);
  });

  it("deletes only that literal, only in the Claude plan's slot", () => {
    const { store, raw, putRaw } = fresh();
    const others = {
      "ai.openai.apiKey": "subscription",
      "ai.anthropic.apiKey": "sk-test-canary-Keep1Aa2",
      "ai.claude-code.model": "subscription",
      "ai.activeProvider": "claude-code",
    };
    for (const [k, v] of Object.entries(others)) store.set(k, v);
    for (const v of ["Subscription", " subscription", "subscriptions", "sk-ant-oat01-test-canary-Keep3Bb4", ""]) {
      putRaw(SLOT, v === "" ? v : encrypt(v));
      const before = raw(SLOT);
      assert.deepEqual(store.removeFakeSubscriptionKey(), { removed: false }, JSON.stringify(v));
      assert.equal(raw(SLOT), before, `${JSON.stringify(v)} was changed`);
    }
    for (const [k, v] of Object.entries(others)) assert.equal(store.get(k), v, `${k} was touched`);
  });

  it("leaves a value it cannot decrypt (ENCRYPTION_KEY changed) where it is, without throwing", async () => {
    const { store, raw, putRaw } = fresh();
    const unreadable = "enc:v1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAA==:AAAA";
    putRaw(SLOT, unreadable);
    let result;
    await captureConsole(() => { result = store.removeFakeSubscriptionKey(); });
    assert.deepEqual(result, { removed: false });
    assert.equal(raw(SLOT), unreadable);
  });

  it("the old wizard's request no longer saves the placeholder", () => {
    const { store, raw } = fresh();
    store.setActiveProvider("claude-code", { apiKey: "subscription" });
    assert.equal(store.get("ai.activeProvider"), "claude-code");
    assert.equal(raw(SLOT), null, "the placeholder was saved again");
  });
});
