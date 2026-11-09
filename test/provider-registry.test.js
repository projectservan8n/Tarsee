import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDERS,
  PROVIDER_IDS,
  getProvider,
  normalizeProviderId,
  isShipped,
  shippedProviders,
  activeProviderId,
  keysOnly,
  keysOnlyLocked,
  resolveModelFor,
  engineFor,
  contextTokensFor,
  effortsFor,
  capsFor,
  priceFor,
  isDeepSeekPeak,
  vendorFor,
  checkKeySlot,
  setCatalogModels,
  catalogModels,
  AI_PROVIDERS as REGISTRY_AI_PROVIDERS,
} from "../src/ai/provider-registry.js";
import * as registry from "../src/ai/provider-registry.js";
import { AI_PROVIDERS, getRecommendedModel, CLAUDE_MODELS } from "../src/config/constants.js";
import { EFFORT_IDS } from "../src/lib/model-picker.js";
import { vendorFor as sessionVendorFor } from "../src/ai/session-handle.js";

// The provider registry (design 4.3) is the one table every later phase reads:
// which AIs exist, which one is active, which engine runs a model, what a tier
// word means on each provider and what a turn costs. Phase 0 ships it with
// only the Claude plan switched on, so nothing a person can do selects any of
// the others yet.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = (values = {}) => ({ get: (k) => (k in values ? values[k] : null) });
const NO_ENV = {};

const ALL_IDS = ["claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local"];
const NON_CLAUDE = ["deepseek", "chatgpt", "openai", "local"];
const TIER_WORDS = ["fable", "opus", "sonnet", "haiku", "top", "mid", "small"];

afterEach(() => {
  setCatalogModels("chatgpt-models", []);
  setCatalogModels("openrouter", []);
  setCatalogModels("local-models", []);
  setCatalogModels("openai-models", []);
});

describe("provider registry: entries", () => {
  it("has exactly the seven public ids", () => {
    assert.deepEqual([...PROVIDER_IDS].sort(), [...ALL_IDS].sort());
    assert.deepEqual(Object.keys(PROVIDERS).sort(), [...ALL_IDS].sort());
  });

  it("gives every entry the shape in design 4.3", () => {
    const keys = ["id", "storageId", "label", "kind", "shipped", "engines", "envKey", "keyPattern", "wrongSlot",
      "keyHelpUrl", "consoleUrl", "baseUrl", "catalog", "models", "tiers", "defaultModel", "backgroundModel",
      "testProbe", "balanceProbe", "errorHints"];
    for (const id of ALL_IDS) {
      const p = PROVIDERS[id];
      for (const k of keys) assert.ok(k in p, `${id} is missing ${k}`);
      assert.equal(p.id, id);
      assert.ok(["subscription", "key", "local"].includes(p.kind), `${id} kind`);
      assert.ok(p.engines.length >= 1 && p.engines.every((e) => e === "claude-code" || e === "codex"), `${id} engines`);
      assert.ok(Array.isArray(p.models), `${id} models`);
      assert.ok(Array.isArray(p.wrongSlot), `${id} wrongSlot`);
      assert.ok(["claude", "static", "openrouter", "openai-models", "chatgpt-models", "local-models"].includes(p.catalog), `${id} catalog`);
    }
  });

  it("ships only the Claude plan in Phase 0", () => {
    assert.deepEqual(ALL_IDS.filter((id) => PROVIDERS[id].shipped), ["claude"]);
    assert.deepEqual(shippedProviders().map((p) => p.id), ["claude"]);
    assert.equal(isShipped("claude"), true);
    assert.equal(isShipped("claude-code"), true);
    for (const id of ALL_IDS.filter((x) => x !== "claude")) assert.equal(isShipped(id), false, id);
    assert.equal(isShipped("nope"), false);
  });

  it("keeps the Claude plan's storage id, and every other provider stores under its own id", () => {
    assert.equal(PROVIDERS.claude.storageId, "claude-code");
    for (const id of ALL_IDS.filter((x) => x !== "claude")) assert.equal(PROVIDERS[id].storageId, id);
  });

  it("puts each provider on the engines and key slots the matrix names", () => {
    assert.deepEqual(PROVIDERS.claude.engines, ["claude-code"]);
    assert.deepEqual(PROVIDERS.anthropic.engines, ["claude-code"]);
    assert.deepEqual(PROVIDERS.chatgpt.engines, ["codex"]);
    assert.deepEqual(PROVIDERS.openai.engines, ["codex"]);
    assert.deepEqual(PROVIDERS.local.engines, ["codex"]);
    assert.deepEqual(PROVIDERS.deepseek.engines, ["claude-code", "codex"]);
    assert.deepEqual(PROVIDERS.openrouter.engines, ["claude-code", "codex"]);
    assert.equal(PROVIDERS.claude.envKey, null);
    assert.equal(PROVIDERS.chatgpt.envKey, null);
    assert.equal(PROVIDERS.anthropic.envKey, "ANTHROPIC_API_KEY");
    assert.equal(PROVIDERS.openai.envKey, "OPENAI_API_KEY");
    assert.equal(PROVIDERS.openrouter.envKey, "OPENROUTER_API_KEY");
    assert.equal(PROVIDERS.deepseek.envKey, "DEEPSEEK_API_KEY");
    assert.equal(PROVIDERS.local.envKey, "TARSEE_LOCAL_AI_KEY");
  });

  it("is frozen, so nothing at runtime can point a key at another host", () => {
    assert.ok(Object.isFrozen(PROVIDERS));
    for (const id of ALL_IDS) {
      assert.ok(Object.isFrozen(PROVIDERS[id]), id);
      assert.ok(Object.isFrozen(PROVIDERS[id].baseUrl), `${id}.baseUrl`);
    }
    assert.throws(() => { "use strict"; PROVIDERS.deepseek.baseUrl["claude-code"] = "https://evil.example"; });
    assert.equal(PROVIDERS.deepseek.baseUrl["claude-code"], "https://api.deepseek.com/anthropic");
  });
});

describe("provider registry: base URLs are code constants", () => {
  it("sends DeepSeek and OpenRouter to their documented hosts per engine", () => {
    assert.deepEqual({ ...PROVIDERS.deepseek.baseUrl }, { "claude-code": "https://api.deepseek.com/anthropic", codex: "https://api.deepseek.com" });
    assert.deepEqual({ ...PROVIDERS.openrouter.baseUrl }, { "claude-code": "https://openrouter.ai/api", codex: "https://openrouter.ai/api/v1" });
  });

  it("names the Anthropic and OpenAI API hosts too, so no key is left to an engine's default host", () => {
    assert.deepEqual({ ...PROVIDERS.anthropic.baseUrl }, { "claude-code": "https://api.anthropic.com" });
    assert.deepEqual({ ...PROVIDERS.openai.baseUrl }, { codex: "https://api.openai.com/v1" });
  });

  it("gives the sign-in plans no host (the engine signs in to its own), and Local AI no constant at all", () => {
    for (const id of ["claude", "chatgpt", "local"]) assert.deepEqual({ ...PROVIDERS[id].baseUrl }, {}, id);
  });

  it("has a host for every key provider on every engine it runs on", () => {
    for (const id of ALL_IDS) {
      if (PROVIDERS[id].kind !== "key") continue;
      for (const engine of PROVIDERS[id].engines) assert.ok(PROVIDERS[id].baseUrl[engine], `${id}/${engine}`);
    }
  });

  it("has no host helper of its own: engine-env's hostFor (with the test seam and Local AI's address) is the one way", () => {
    assert.equal(registry.baseUrlFor, undefined);
  });

  it("only ever uses https", () => {
    for (const id of ALL_IDS) {
      for (const url of Object.values(PROVIDERS[id].baseUrl)) assert.match(url, /^https:\/\//, id);
    }
  });
});

describe("getProvider / normalizeProviderId", () => {
  it("accepts every public id and the claude-code alias", () => {
    for (const id of ALL_IDS) assert.equal(getProvider(id)?.id, id);
    assert.equal(getProvider("claude-code"), PROVIDERS.claude);
    assert.equal(normalizeProviderId("claude-code"), "claude");
    assert.equal(normalizeProviderId(" DeepSeek "), "deepseek");
  });

  it("returns null for anything else", () => {
    for (const bad of [undefined, null, "", "  ", "codex", "gemini", "claude-codex", "__proto__", "constructor", "toString"]) {
      assert.equal(getProvider(bad), null, String(bad));
      assert.equal(normalizeProviderId(bad), null, String(bad));
    }
  });
});

describe("activeProviderId", () => {
  it("is the Claude plan when nothing is set", () => {
    assert.equal(activeProviderId(store(), { env: NO_ENV }), "claude");
    assert.equal(activeProviderId(null, { env: NO_ENV }), "claude");
  });

  it("reads today's stored value claude-code as the Claude plan", () => {
    assert.equal(activeProviderId(store({ "ai.activeProvider": "claude-code" }), { env: NO_ENV }), "claude");
  });

  it("takes TARSEE_AI_PROVIDER when Settings has none", () => {
    assert.equal(activeProviderId(store(), { env: { TARSEE_AI_PROVIDER: "claude" } }), "claude");
    assert.equal(activeProviderId(store(), { env: { TARSEE_AI_PROVIDER: "claude-code" } }), "claude");
  });

  it("falls back to the Claude plan for a provider that is not shipped yet", () => {
    for (const id of ALL_IDS.filter((x) => x !== "claude")) {
      assert.equal(activeProviderId(store({ "ai.activeProvider": id }), { env: NO_ENV }), "claude", `setting ${id}`);
      assert.equal(activeProviderId(store(), { env: { TARSEE_AI_PROVIDER: id } }), "claude", `env ${id}`);
    }
    assert.equal(activeProviderId(store({ "ai.activeProvider": "gemini" }), { env: NO_ENV }), "claude");
  });

  it("never picks a provider because its key happens to be in the environment", () => {
    const env = {
      OPENROUTER_API_KEY: "sk-or-v1-test-canary-0000",
      OPENAI_API_KEY: "sk-test-canary-openai-0000",
      DEEPSEEK_API_KEY: "sk-test-canary-deepseek-0000",
      ANTHROPIC_API_KEY: "sk-ant-api03-test-canary-0000",
      TARSEE_LOCAL_AI_URL: "http://127.0.0.1:11434/v1",
    };
    assert.equal(activeProviderId(store(), { env }), "claude");
    // Even with every provider shipped, key presence alone never chooses one.
    assert.equal(activeProviderId(store(), { env, isShipped: () => true }), "claude");
  });

  it("prefers the Settings value over TARSEE_AI_PROVIDER once both name shipped providers", () => {
    const all = () => true;
    assert.equal(activeProviderId(store({ "ai.activeProvider": "deepseek" }), { env: { TARSEE_AI_PROVIDER: "openai" }, isShipped: all }), "deepseek");
    assert.equal(activeProviderId(store(), { env: { TARSEE_AI_PROVIDER: "openai" }, isShipped: all }), "openai");
  });

  it("reads process.env when no env is passed", () => {
    const before = process.env.TARSEE_AI_PROVIDER;
    process.env.TARSEE_AI_PROVIDER = "deepseek";
    try { assert.equal(activeProviderId(store()), "claude"); }
    finally { if (before === undefined) delete process.env.TARSEE_AI_PROVIDER; else process.env.TARSEE_AI_PROVIDER = before; }
  });

  it("survives a store that throws", () => {
    const broken = { get() { throw new Error("database is closed"); } };
    assert.equal(activeProviderId(broken, { env: NO_ENV }), "claude");
  });
});

describe("keysOnly", () => {
  it("is off by default", () => {
    assert.equal(keysOnly(store(), { env: NO_ENV }), false);
    assert.equal(keysOnly(null, { env: NO_ENV }), false);
    assert.equal(keysOnlyLocked(NO_ENV), false);
  });

  it("follows the ai.keysOnly setting", () => {
    for (const on of [true, "true", "1", 1]) assert.equal(keysOnly(store({ "ai.keysOnly": on }), { env: NO_ENV }), true, String(on));
    for (const off of [false, "false", "0", 0, null, ""]) assert.equal(keysOnly(store({ "ai.keysOnly": off }), { env: NO_ENV }), false, String(off));
  });

  it("is locked on by TARSEE_KEYS_ONLY=1 whatever the setting says", () => {
    assert.equal(keysOnly(store({ "ai.keysOnly": false }), { env: { TARSEE_KEYS_ONLY: "1" } }), true);
    assert.equal(keysOnlyLocked({ TARSEE_KEYS_ONLY: "1" }), true);
    assert.equal(keysOnlyLocked({ TARSEE_KEYS_ONLY: "0" }), false);
    assert.equal(keysOnly(store({ "ai.keysOnly": false }), { env: { TARSEE_KEYS_ONLY: "0" } }), false);
  });
});

describe("resolveModelFor", () => {
  const nasty = [undefined, null, "", "   ", ...TIER_WORDS, "OPUS", "claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5",
    "claude-fable-5-1", "claude-opus-9-9", "Claude-Opus-5", "claude-sonnet-5[1m]", "claude-code", "claude", "claude-",
    "anthropic/claude-sonnet-5", "~anthropic/claude-sonnet-latest", "random-model", "gpt-6.1-sol", "deepseek-flash"];

  it("never returns a claude-* id for deepseek, chatgpt, openai or local", () => {
    const check = (label) => {
      for (const id of NON_CLAUDE) {
        for (const m of nasty) {
          const out = resolveModelFor(id, m);
          assert.ok(out === null || (typeof out === "string" && !/^claude-/i.test(out)), `${label} ${id} ${m} -> ${out}`);
        }
      }
    };
    check("no catalogs:");
    // A runtime list that itself carries a claude-looking id still can't leak one.
    setCatalogModels("chatgpt-models", [{ id: "claude-sonnet-5", tier: "sonnet" }, { id: "gpt-6-luna", tier: "haiku", default: true }]);
    setCatalogModels("local-models", [{ id: "claude-distill:7b" }]);
    check("hostile catalogs:");
  });

  it("maps every tier word on DeepSeek", () => {
    const want = { fable: "deepseek-v4-pro", opus: "deepseek-v4-pro", top: "deepseek-v4-pro",
      sonnet: "deepseek-flash", mid: "deepseek-flash", haiku: "deepseek-flash", small: "deepseek-flash" };
    for (const [t, m] of Object.entries(want)) assert.equal(resolveModelFor("deepseek", t), m, t);
  });

  it("maps every tier word on the OpenAI key", () => {
    const want = { fable: "gpt-6-astra", opus: "gpt-6-astra", top: "gpt-6-astra",
      sonnet: "gpt-6.1-sol", mid: "gpt-6.1-sol", haiku: "gpt-6-luna", small: "gpt-6-luna" };
    for (const [t, m] of Object.entries(want)) assert.equal(resolveModelFor("openai", t), m, t);
  });

  it("keeps the Claude tier words as today's always-latest aliases", () => {
    for (const id of ["claude", "anthropic", "claude-code"]) {
      for (const t of ["fable", "opus", "sonnet", "haiku"]) assert.equal(resolveModelFor(id, t), t, `${id} ${t}`);
      assert.equal(resolveModelFor(id, "top"), "opus");
      assert.equal(resolveModelFor(id, "mid"), "sonnet");
      assert.equal(resolveModelFor(id, "small"), "haiku");
    }
  });

  it("maps every tier word on OpenRouter to the latest-Anthropic slugs", () => {
    assert.equal(resolveModelFor("openrouter", "opus"), "~anthropic/claude-opus-latest");
    assert.equal(resolveModelFor("openrouter", "fable"), "~anthropic/claude-opus-latest");
    assert.equal(resolveModelFor("openrouter", "sonnet"), "~anthropic/claude-sonnet-latest");
    assert.equal(resolveModelFor("openrouter", "haiku"), "~anthropic/claude-haiku-latest");
    assert.equal(resolveModelFor("openrouter", "small"), "~anthropic/claude-haiku-latest");
  });

  it("lets the owner's OpenRouter and Local tier maps win", () => {
    const s = store({ "ai.openrouter.tiers": { haiku: "deepseek/deepseek-chat:free" } });
    assert.equal(resolveModelFor("openrouter", "haiku", s), "deepseek/deepseek-chat:free");
    assert.equal(resolveModelFor("openrouter", "sonnet", s), "~anthropic/claude-sonnet-latest");
    const l = store({ "ai.local.model": "qwen3:32b", "ai.local.tiers": JSON.stringify({ haiku: "qwen3:4b" }) });
    assert.equal(resolveModelFor("local", "haiku", l), "qwen3:4b");
    assert.equal(resolveModelFor("local", "opus", l), "qwen3:32b");
  });

  it("maps every tier on Local AI to the chosen model", () => {
    const s = store({ "ai.local.model": "llama3.1:8b" });
    for (const t of TIER_WORDS) assert.equal(resolveModelFor("local", t, s), "llama3.1:8b", t);
    assert.equal(resolveModelFor("local", "", s), "llama3.1:8b");
    // No chosen model: the first one the server lists.
    setCatalogModels("local-models", [{ id: "mistral:7b" }, { id: "phi4:14b" }]);
    for (const t of TIER_WORDS) assert.equal(resolveModelFor("local", t), "mistral:7b", t);
  });

  it("has no ChatGPT model of its own: tiers come from the account's live list, else Codex chooses", () => {
    assert.deepEqual(PROVIDERS.chatgpt.models, []);
    assert.equal(PROVIDERS.chatgpt.defaultModel, null);
    assert.equal(PROVIDERS.chatgpt.backgroundModel, null);
    for (const t of TIER_WORDS) assert.equal(resolveModelFor("chatgpt", t), null, t);
    assert.equal(resolveModelFor("chatgpt", ""), null);
    assert.equal(resolveModelFor("chatgpt", "gpt-6.1-sol"), null, "without the account's list, no model is named at all");
    // A free account that only lists the small model: every tier steps to it.
    setCatalogModels("chatgpt-models", [{ id: "gpt-6-luna", tier: "haiku" }]);
    for (const t of TIER_WORDS) assert.equal(resolveModelFor("chatgpt", t), "gpt-6-luna", t);
    // A bigger account: each tier steps down to the best the account lists.
    setCatalogModels("chatgpt-models", [{ id: "gpt-6.1-sol", tier: "sonnet", default: true }, { id: "gpt-6-luna", tier: "haiku" }]);
    assert.equal(resolveModelFor("chatgpt", "opus"), "gpt-6.1-sol");
    assert.equal(resolveModelFor("chatgpt", "fable"), "gpt-6.1-sol");
    assert.equal(resolveModelFor("chatgpt", "haiku"), "gpt-6-luna");
    assert.equal(resolveModelFor("chatgpt", ""), "gpt-6.1-sol");
    assert.equal(resolveModelFor("chatgpt", "gpt-6-astra"), "gpt-6.1-sol", "a model the account does not list falls back to its default");
  });

  it("maps a claude-* id on a non-Claude provider through its tier", () => {
    assert.equal(resolveModelFor("deepseek", "claude-opus-5"), "deepseek-v4-pro");
    assert.equal(resolveModelFor("deepseek", "claude-fable-5-1"), "deepseek-v4-pro");
    assert.equal(resolveModelFor("deepseek", "claude-haiku-4-5"), "deepseek-flash");
    assert.equal(resolveModelFor("openai", "claude-sonnet-5[1m]"), "gpt-6.1-sol");
    assert.equal(resolveModelFor("openrouter", "claude-haiku-4-5"), "~anthropic/claude-haiku-latest");
  });

  it("falls back to the provider's default for an unknown id", () => {
    assert.equal(resolveModelFor("deepseek", "gpt-4o"), "deepseek-flash");
    assert.equal(resolveModelFor("deepseek", undefined), "deepseek-flash");
    assert.equal(resolveModelFor("openai", "deepseek-flash"), "gpt-6.1-sol");
    assert.equal(resolveModelFor("claude", "gpt-6.1-sol"), getRecommendedModel());
    assert.equal(resolveModelFor("claude", ""), getRecommendedModel());
    assert.equal(resolveModelFor("openrouter", ""), "~anthropic/claude-sonnet-latest");
  });

  it("keeps known ids, and drops the [1m] suffix the engine adds itself", () => {
    assert.equal(resolveModelFor("deepseek", "deepseek-flash"), "deepseek-flash");
    assert.equal(resolveModelFor("deepseek", "deepseek-v4-pro[1m]"), "deepseek-v4-pro");
    assert.equal(resolveModelFor("openai", "gpt-5.5"), "gpt-5.5");
  });

  it("reads a tier word with Claude Code's [1m] suffix as that tier", () => {
    // The Claude providers pass it through as today ("opus[1m]" is a Claude Code alias); the rest map the tier.
    for (const id of ["claude", "anthropic", "claude-code"]) {
      for (const t of ["fable", "opus", "sonnet", "haiku"]) {
        assert.equal(resolveModelFor(id, `${t}[1m]`), `${t}[1m]`, `${id} ${t}[1m]`);
        assert.equal(resolveModelFor(id, `${t.toUpperCase()}[1M]`), `${t}[1m]`, `${id} ${t.toUpperCase()}[1M]`);
      }
      assert.equal(resolveModelFor(id, "top[1m]"), "opus[1m]");
    }
    assert.equal(resolveModelFor("deepseek", "opus[1m]"), "deepseek-v4-pro");
    assert.equal(resolveModelFor("deepseek", "fable[1m]"), "deepseek-v4-pro");
    assert.equal(resolveModelFor("deepseek", "sonnet[1m]"), "deepseek-flash");
    assert.equal(resolveModelFor("openrouter", "opus[1m]"), "~anthropic/claude-opus-latest");
    assert.equal(resolveModelFor("openrouter", "sonnet[1m]"), "~anthropic/claude-sonnet-latest");
    assert.equal(resolveModelFor("openrouter", "fable[1m]"), "~anthropic/claude-opus-latest");
    assert.equal(resolveModelFor("openai", "haiku[1m]"), "gpt-6-luna");
  });

  it("keeps Claude ids as today: pinned rows, newer catalog ids, and partial names", () => {
    assert.equal(resolveModelFor("claude", "claude-opus-4-6"), "claude-opus-4-6");
    assert.equal(resolveModelFor("claude", "claude-opus-5-5"), "claude-opus-5-5", "a release only Claude Code's catalog lists yet");
    assert.equal(resolveModelFor("claude", "opus-4-6"), "claude-opus-4-6");
    assert.equal(resolveModelFor("claude-code", "claude-sonnet-5[1m]"), "claude-sonnet-5[1m]");
  });

  it("passes OpenRouter slugs through, colons and all", () => {
    assert.equal(resolveModelFor("openrouter", "deepseek/deepseek-chat:free"), "deepseek/deepseek-chat:free");
    assert.equal(resolveModelFor("openrouter", "anthropic/claude-sonnet-5"), "anthropic/claude-sonnet-5");
  });

  it("drops an OpenRouter slug its loaded catalog does not list, unless the owner verified it", () => {
    setCatalogModels("openrouter", [{ id: "anthropic/claude-sonnet-5" }, { id: "deepseek/deepseek-chat:free" }]);
    assert.equal(resolveModelFor("openrouter", "nobody/never-heard-of"), "~anthropic/claude-sonnet-latest");
    const s = store({ "ai.openrouter.verified": { "nobody/never-heard-of": { engine: "codex", at: "2026-11-09" } } });
    assert.equal(resolveModelFor("openrouter", "nobody/never-heard-of", s), "nobody/never-heard-of");
  });

  it("returns null for a provider that does not exist", () => {
    assert.equal(resolveModelFor("gemini", "sonnet"), null);
  });
});

describe("engineFor", () => {
  it("runs the Claude providers on Claude Code and the OpenAI-style ones on Codex", () => {
    assert.equal(engineFor("claude", "sonnet"), "claude-code");
    assert.equal(engineFor("claude-code", "sonnet"), "claude-code");
    assert.equal(engineFor("anthropic", "opus"), "claude-code");
    assert.equal(engineFor("chatgpt", "gpt-6-luna"), "codex");
    assert.equal(engineFor("openai", "gpt-6.1-sol"), "codex");
    assert.equal(engineFor("local", "llama3.1:8b"), "codex");
  });

  it("runs DeepSeek on Claude Code unless verification picked Codex", () => {
    assert.equal(engineFor("deepseek", "deepseek-flash"), "claude-code");
    const s = store({ "ai.deepseek.verified": JSON.stringify({ "deepseek-v4-pro": { engine: "codex", at: "2026-11-09" } }) });
    assert.equal(engineFor("deepseek", "deepseek-v4-pro", s), "codex");
    assert.equal(engineFor("deepseek", "deepseek-v4-pro[1m]", s), "codex");
    assert.equal(engineFor("deepseek", "deepseek-flash", s), "claude-code");
  });

  it("routes OpenRouter by maker, and needs verification for every other maker", () => {
    assert.equal(engineFor("openrouter", "anthropic/claude-sonnet-5"), "claude-code");
    assert.equal(engineFor("openrouter", "~anthropic/claude-sonnet-latest"), "claude-code");
    assert.equal(engineFor("openrouter", "openai/gpt-6.1-sol"), "codex");
    assert.equal(engineFor("openrouter", "~openai/gpt-latest"), "codex");
    assert.equal(engineFor("openrouter", "meta-llama/llama-4-maverick"), null);
    assert.equal(engineFor("openrouter", "deepseek/deepseek-chat:free"), null);
    const s = store({ "ai.openrouter.verified": { "meta-llama/llama-4-maverick": { engine: "claude-code" } } });
    assert.equal(engineFor("openrouter", "meta-llama/llama-4-maverick", s), "claude-code");
  });

  it("ignores a verified entry naming an engine the provider does not have", () => {
    const s = store({ "ai.openrouter.verified": { "x-ai/grok-5": { engine: "gemini-cli" } }, "ai.deepseek.verified": "not json" });
    assert.equal(engineFor("openrouter", "x-ai/grok-5", s), null);
    assert.equal(engineFor("deepseek", "deepseek-flash", s), "claude-code");
  });

  it("returns null for a provider that does not exist", () => {
    assert.equal(engineFor("gemini", "x"), null);
  });
});

describe("contextTokensFor", () => {
  it("reads today's Claude table (unknown ids count as 1M, as the context meter does)", () => {
    assert.equal(contextTokensFor("claude", "sonnet"), 1_000_000);
    assert.equal(contextTokensFor("claude", "haiku"), 200_000);
    assert.equal(contextTokensFor("claude", "claude-haiku-4-5"), 200_000);
    assert.equal(contextTokensFor("anthropic", "claude-opus-5"), 1_000_000);
    assert.equal(contextTokensFor("claude", "claude-opus-5-5"), 1_000_000);
  });

  it("gives both DeepSeek models a 1M window", () => {
    assert.equal(contextTokensFor("deepseek", "deepseek-flash"), 1_000_000);
    assert.equal(contextTokensFor("deepseek", "deepseek-v4-pro[1m]"), 1_000_000);
  });

  it("uses the Local AI card's context, 128K by default", () => {
    assert.equal(contextTokensFor("local", "llama3.1:8b"), 128_000);
    assert.equal(contextTokensFor("local", "llama3.1:8b", store({ "ai.local.context": 32768 })), 32768);
    assert.equal(contextTokensFor("local", "llama3.1:8b", store({ "ai.local.context": "65536" })), 65536);
  });

  it("uses a runtime catalog's context where there is one", () => {
    setCatalogModels("openrouter", [{ id: "deepseek/deepseek-chat:free", context: 163_840 }]);
    assert.equal(contextTokensFor("openrouter", "deepseek/deepseek-chat:free"), 163_840);
    assert.ok(contextTokensFor("openrouter", "unknown/model") > 0);
    assert.ok(contextTokensFor("chatgpt", null) > 0);
    assert.ok(contextTokensFor("openai", "gpt-6.1-sol") > 0);
  });
});

describe("effortsFor", () => {
  it("offers Claude's five levels on the Claude providers", () => {
    assert.deepEqual(effortsFor("claude", "sonnet"), EFFORT_IDS);
    assert.deepEqual(effortsFor("anthropic", "claude-opus-5"), EFFORT_IDS);
  });

  it("offers low, high and max on DeepSeek", () => {
    assert.deepEqual(effortsFor("deepseek", "deepseek-flash"), ["low", "high", "max"]);
    assert.deepEqual(effortsFor("deepseek", "deepseek-v4-pro"), ["low", "high", "max"]);
  });

  it("offers Claude levels on OpenRouter anthropic/*, and only what verification passed elsewhere", () => {
    assert.deepEqual(effortsFor("openrouter", "anthropic/claude-sonnet-5"), EFFORT_IDS);
    assert.deepEqual(effortsFor("openrouter", "~anthropic/claude-sonnet-latest"), EFFORT_IDS);
    assert.deepEqual(effortsFor("openrouter", "meta-llama/llama-4-maverick"), []);
    const s = store({ "ai.openrouter.verified": { "meta-llama/llama-4-maverick": { engine: "codex", efforts: ["low", "high"] } } });
    assert.deepEqual(effortsFor("openrouter", "meta-llama/llama-4-maverick", s), ["low", "high"]);
  });

  it("only lists effort ids Tarsee knows", () => {
    for (const id of ALL_IDS) {
      for (const m of [null, "sonnet", "deepseek-flash", "gpt-6.1-sol", "gpt-5.5"]) {
        for (const e of effortsFor(id, m)) assert.ok(EFFORT_IDS.includes(e), `${id} ${m} ${e}`);
      }
    }
  });
});

describe("capsFor", () => {
  it("gives the Claude providers everything, with a native budget", () => {
    const want = { vision: true, pdf: true, thinkingSummaries: true, nativeBudget: true, streaming: true };
    assert.deepEqual(capsFor("claude", "sonnet"), want);
    assert.deepEqual(capsFor("anthropic", "claude-opus-5"), want);
  });

  it("knows DeepSeek has no PDFs, and v4-pro no images", () => {
    assert.deepEqual(capsFor("deepseek", "deepseek-flash"), { vision: true, pdf: false, thinkingSummaries: false, nativeBudget: false, streaming: true });
    assert.deepEqual(capsFor("deepseek", "deepseek-v4-pro"), { vision: false, pdf: false, thinkingSummaries: false, nativeBudget: false, streaming: true });
  });

  it("says Codex-run models reply a message at a time and take no PDFs", () => {
    for (const [id, m] of [["openai", "gpt-6.1-sol"], ["chatgpt", null], ["local", "llama3.1:8b"], ["openrouter", "openai/gpt-6.1-sol"]]) {
      const c = capsFor(id, m);
      assert.equal(c.streaming, false, id);
      assert.equal(c.pdf, false, id);
      assert.equal(c.nativeBudget, false, id);
    }
    const s = store({ "ai.deepseek.verified": { "deepseek-flash": { engine: "codex" } } });
    assert.equal(capsFor("deepseek", "deepseek-flash", s).streaming, false);
  });

  it("gives OpenRouter anthropic/* native PDFs, and takes vision from the catalog", () => {
    assert.equal(capsFor("openrouter", "anthropic/claude-sonnet-5").pdf, true);
    assert.equal(capsFor("openrouter", "anthropic/claude-sonnet-5").streaming, true);
    setCatalogModels("openrouter", [{ id: "qwen/qwen3-vl", vision: true }, { id: "qwen/qwen3-coder", vision: false }]);
    assert.equal(capsFor("openrouter", "qwen/qwen3-vl").vision, true);
    assert.equal(capsFor("openrouter", "qwen/qwen3-coder").vision, false);
    assert.equal(capsFor("openrouter", "qwen/qwen3-coder").pdf, false);
  });

  it("returns null for a provider that does not exist", () => {
    assert.equal(capsFor("gemini", "x"), null);
  });
});

describe("priceFor", () => {
  // 2026-11-09 is a Monday; 2026-11-14 a Saturday; 2026-11-15 a Sunday; 2026-11-13 a Friday.
  const at = (d, h, m = 0) => new Date(Date.UTC(2026, 10, d, h, m));

  it("charges nothing per token on the plans, and leaves the Anthropic key's cost to the engine", () => {
    assert.equal(priceFor("claude", "sonnet", at(9, 2)), null);
    assert.equal(priceFor("chatgpt", "gpt-6-luna", at(9, 2)), null);
    assert.equal(priceFor("anthropic", "claude-opus-5", at(9, 2)), null);
  });

  it("knows DeepSeek's peak window: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday", () => {
    const peak = [at(9, 1), at(9, 2, 30), at(9, 3, 59), at(9, 6), at(9, 9, 59), at(13, 7), at(10, 1)];
    const off = [at(9, 0, 59), at(9, 4), at(9, 5, 59), at(9, 10), at(9, 23), at(14, 2), at(15, 8), at(14, 7)];
    for (const t of peak) assert.equal(isDeepSeekPeak(t), true, t.toISOString());
    for (const t of off) assert.equal(isDeepSeekPeak(t), false, t.toISOString());
  });

  it("halves DeepSeek's rates off-peak", () => {
    for (const m of ["deepseek-flash", "deepseek-v4-pro"]) {
      const p = priceFor("deepseek", m, at(9, 2));
      const o = priceFor("deepseek", m, at(9, 12));
      assert.equal(p.peak, true, m);
      assert.equal(o.peak, false, m);
      for (const k of ["in", "out", "cacheRead", "cacheWrite"]) {
        assert.ok(p[k] > 0, `${m} ${k}`);
        assert.equal(o[k], p[k] / 2, `${m} ${k}`);
      }
    }
  });

  it("prices DeepSeek Flash at about $0.15 per million tokens in, the cheapest", () => {
    assert.equal(priceFor("deepseek", "deepseek-flash", at(9, 2)).in, 0.15);
    assert.ok(priceFor("deepseek", "deepseek-v4-pro", at(9, 2)).in > 0.15);
    assert.equal(priceFor("deepseek", "deepseek-flash[1m]", at(9, 2)).in, 0.15);
  });

  it("prices the OpenAI table, and reads OpenRouter's from its catalog", () => {
    for (const m of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.5"]) {
      const p = priceFor("openai", m, at(9, 2));
      assert.ok(p && p.in > 0 && p.out > 0, m);
      assert.equal(p.peak, null, m);
    }
    assert.equal(priceFor("openrouter", "anthropic/claude-sonnet-5", at(9, 2)), null);
    setCatalogModels("openrouter", [{ id: "anthropic/claude-sonnet-5", price: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 } }]);
    assert.deepEqual(priceFor("openrouter", "anthropic/claude-sonnet-5", at(9, 2)), { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75, peak: null });
  });

  it("makes Local AI free unless the card sets a price", () => {
    assert.deepEqual(priceFor("local", "llama3.1:8b", at(9, 2)), { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, peak: null });
    const s = store({ "ai.local.price": { in: 0.1, out: 0.2 } });
    assert.deepEqual(priceFor("local", "llama3.1:8b", at(9, 2), s), { in: 0.1, out: 0.2, cacheRead: 0.1, cacheWrite: 0.1, peak: null });
  });

  it("defaults to now", () => {
    const p = priceFor("deepseek", "deepseek-flash");
    assert.equal(p.peak, isDeepSeekPeak(new Date()));
  });

  it("reads a missing moment (null, as a running turn's end time is) as now, never as 1970", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: at(9, 2) });
    assert.equal(isDeepSeekPeak(null), true);
    assert.equal(isDeepSeekPeak(undefined), true);
    assert.deepEqual(priceFor("deepseek", "deepseek-flash", null), priceFor("deepseek", "deepseek-flash", at(9, 2)));
    assert.equal(priceFor("deepseek", "deepseek-flash", null).peak, true);
    t.mock.timers.setTime(at(9, 12).getTime());
    assert.equal(priceFor("deepseek", "deepseek-flash", null).peak, false);
  });

  it("takes a moment as a Date or as milliseconds (Date.now(), the stored timestamps)", () => {
    assert.equal(isDeepSeekPeak(at(9, 2).getTime()), true);
    assert.equal(isDeepSeekPeak(at(9, 12).getTime()), false);
    assert.equal(isDeepSeekPeak(at(9, 2).toISOString()), true);
  });
});

describe("vendorFor", () => {
  it("is the maker on OpenRouter and the provider id elsewhere", () => {
    assert.equal(vendorFor("openrouter", "~anthropic/claude-sonnet-latest"), "anthropic");
    assert.equal(vendorFor("openrouter", "deepseek/deepseek-chat:free"), "deepseek");
    assert.equal(vendorFor("deepseek", "deepseek-flash"), "deepseek");
    assert.equal(vendorFor("claude-code", "sonnet"), "claude");
  });

  it("is a name a session handle can carry: lower case, only letters, digits, dot, dash and underscore", () => {
    assert.equal(vendorFor("openrouter", "Open AI/gpt-6"), "openai");
    assert.equal(vendorFor("openrouter", "a+b/c"), "ab");
    assert.equal(vendorFor("openrouter", "auto"), "openrouter");
    assert.equal(vendorFor("openrouter", "+++/x"), "openrouter");
    assert.equal(vendorFor("nobody", "x"), null);
  });

  it("is the very function session handles use (one maker rule, not two)", () => {
    assert.equal(sessionVendorFor, vendorFor);
  });
});

describe("checkKeySlot", () => {
  it("catches a Claude sign-in token pasted as an API key", () => {
    const r = checkKeySlot("anthropic", "sk-ant-oat01-test-canary-0000");
    assert.equal(r.ok, false);
    assert.match(r.message, /sign-in token/i);
  });

  it("catches keys pasted into another provider's slot", () => {
    assert.match(checkKeySlot("openai", "sk-ant-api03-test-canary-0000").message, /Anthropic key/);
    assert.match(checkKeySlot("openai", "sk-or-v1-testcanary0000").message, /OpenRouter/);
    assert.match(checkKeySlot("deepseek", "sk-or-v1-testcanary0000").message, /OpenRouter/);
    assert.match(checkKeySlot("anthropic", "sk-or-v1-testcanary0000").message, /OpenRouter/);
    assert.match(checkKeySlot("openrouter", "sk-ant-api03-test-canary-0000").message, /Anthropic key/);
  });

  it("accepts each provider's own key shape", () => {
    assert.equal(checkKeySlot("anthropic", "sk-ant-api03-test-canary-0000").ok, true);
    assert.equal(checkKeySlot("openrouter", "sk-or-v1-testcanary0000").ok, true);
    assert.equal(checkKeySlot("openai", "sk-proj-test-canary-00000000").ok, true);
    assert.equal(checkKeySlot("deepseek", "sk-testcanary0000000000000000").ok, true);
    assert.equal(checkKeySlot("local", "anything-at-all").ok, true);
  });

  it("refuses an empty key and a provider that takes none", () => {
    assert.equal(checkKeySlot("deepseek", "  ").ok, false);
    assert.equal(checkKeySlot("claude", "sk-ant-api03-test-canary-0000").ok, false);
    assert.equal(checkKeySlot("gemini", "x").ok, false);
  });
});

describe("runtime catalogs", () => {
  it("start empty, and only take the names the registry uses", () => {
    assert.deepEqual(catalogModels("chatgpt-models"), []);
    assert.throws(() => setCatalogModels("claude", [{ id: "x" }]));
    assert.throws(() => setCatalogModels("nope", []));
  });

  it("keeps a frozen copy, skipping entries without an id", () => {
    const list = [{ id: "a" }, { label: "no id" }, null, { id: "b", context: 4096 }];
    setCatalogModels("local-models", list);
    const got = catalogModels("local-models");
    assert.deepEqual(got.map((m) => m.id), ["a", "b"]);
    assert.ok(Object.isFrozen(got));
    list.push({ id: "c" });
    assert.equal(catalogModels("local-models").length, 2);
  });

  it("narrows the OpenAI table to what the key lists, once the live list is in", () => {
    assert.ok(PROVIDERS.openai.models.length >= 4);
    setCatalogModels("openai-models", [{ id: "gpt-6-luna" }, { id: "gpt-5.5" }, { id: "whisper-1" }]);
    assert.equal(resolveModelFor("openai", "gpt-6-astra"), "gpt-6-luna", "the default steps down to what the key can use");
    assert.equal(resolveModelFor("openai", "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveModelFor("openai", "whisper-1"), "gpt-6-luna", "not a chat model in the table");
  });
});

describe("Claude catalog", () => {
  it("is today's model table", () => {
    assert.deepEqual(PROVIDERS.claude.models.map((m) => m.id), CLAUDE_MODELS.map((m) => m.id));
    assert.deepEqual(PROVIDERS.anthropic.models.map((m) => m.id), CLAUDE_MODELS.map((m) => m.id));
    assert.equal(PROVIDERS.claude.defaultModel, getRecommendedModel());
    assert.equal(PROVIDERS.claude.backgroundModel, "haiku");
    assert.equal(PROVIDERS.claude.catalog, "claude");
  });
});

describe("AI_PROVIDERS compatibility view (config/constants.js)", () => {
  it("still has exactly today's claude-code entry and nothing unshipped", () => {
    assert.deepEqual(Object.keys(AI_PROVIDERS), ["claude-code"]);
    assert.deepEqual({ ...AI_PROVIDERS["claude-code"] }, {
      id: "claude-code",
      name: "Claude Code (Agent)",
      envKey: null,
      defaultModel: getRecommendedModel(),
      baseUrl: null,
      noKeyRequired: true,
    });
    assert.deepEqual(Object.keys(AI_PROVIDERS["claude-code"]), ["id", "name", "envKey", "defaultModel", "baseUrl", "noKeyRequired"]);
    for (const id of ["claude", "anthropic", "openai", "openrouter", "deepseek", "local", "chatgpt"]) assert.equal(AI_PROVIDERS[id], undefined, id);
    assert.ok(Object.isFrozen(AI_PROVIDERS));
  });

  it("is the view the registry builds from its shipped providers, not a table of its own", () => {
    assert.equal(AI_PROVIDERS, REGISTRY_AI_PROVIDERS);
  });

  it("keeps defaultModel a live getter on the recommended model", () => {
    const d = Object.getOwnPropertyDescriptor(AI_PROVIDERS["claude-code"], "defaultModel");
    assert.equal(typeof d.get, "function");
  });

  it("keeps the router's provider list as it was", async () => {
    const { getAvailableProviders } = await import("../src/ai/router.js");
    assert.deepEqual(getAvailableProviders(), [{ id: "claude-code", name: "Claude Code (Agent)", configured: true, defaultModel: getRecommendedModel() }]);
  });
});

describe("import order", () => {
  // constants.js and the registry import each other. Whichever is loaded
  // first, nothing may read the other before it has run.
  const run = (code) => execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf8" }).trim();

  it("works when the registry is loaded first", () => {
    const out = run(`import { PROVIDERS } from "./src/ai/provider-registry.js"; import { AI_PROVIDERS } from "./src/config/constants.js"; console.log(Object.keys(AI_PROVIDERS).join(), PROVIDERS.claude.defaultModel, PROVIDERS.claude.models.length > 0);`);
    assert.equal(out, "claude-code sonnet true");
  });

  it("works when constants.js is loaded first", () => {
    const out = run(`import { AI_PROVIDERS } from "./src/config/constants.js"; import { PROVIDERS } from "./src/ai/provider-registry.js"; console.log(Object.keys(AI_PROVIDERS).join(), AI_PROVIDERS["claude-code"].defaultModel, PROVIDERS.claude.models.length > 0);`);
    assert.equal(out, "claude-code sonnet true");
  });

  it("works when model-ref.js is loaded first", () => {
    const out = run(`import { parseModelRef } from "./src/ai/model-ref.js"; console.log(JSON.stringify(parseModelRef("claude-code:sonnet")));`);
    assert.equal(out, '{"provider":"claude","model":"sonnet"}');
  });
});
