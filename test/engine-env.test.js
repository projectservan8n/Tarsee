// Credential isolation for the agent engines (src/ai/engine-env.js, design 4.5 R1 to R10): each provider's turn gets
// exactly its own credential and nothing else. The server's environment here is full of canaries (every credential,
// Claude sign-in variable, Tarsee secret and Railway provider key a host might have set), and the vault offers a
// CODEX_API_KEY next to a benign SCRIPT_KEY. No canary may reach any engine, except the operator's Claude sign-in
// variables on the Claude plan. Also: the test-only base-URL seam is inert outside NODE_ENV=test and off loopback, a
// missing key refuses the turn, the per-provider homes, the settings-file guards for both engines, and that the
// module agrees with the provider registry. The matrix runs on the registry's real entries, so the two can't drift
// apart unnoticed; hand-made entries appear only where a test needs a provider the registry doesn't have. Every key
// and token here is an obvious fake.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_ENV_RE, TARSEE_SECRETS, PROVIDER_KEY_NAMES, PLAN_SIGN_IN_NAMES, CredentialError, isAuthEnvName, baseEnv,
  finalizeEnv, claudeEnvFor, codexEnvFor, homeFor, homeKeyFor, ensureHome, homeIsolationRefusal, settingsFilesFor,
  settingsFileGuard, settingSourcesFor, hostFor, testBaseUrl, codexConfigFilesFor, codexConfigGuard,
} from "../src/ai/engine-env.js";
import { agentVaultEnv, AGENT_ENV_KEEP_OUT } from "../src/ai/agent-env.js";
import { PROVIDERS, PROVIDER_IDS } from "../src/ai/provider-registry.js";

const P = PROVIDERS;
const PRO = "deepseek-v4-pro";
const FLASH = "deepseek-flash";
const ENGINES = ["claude-code", "codex"];

// The operator's Claude sign-in variables: `claude setup-token`'s token, or a refresh-token login with its scopes
// and client id. They go back on the Claude plan, and nowhere else.
const PLAN_NAMES = ["CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_TOKEN"];

// Every credential a host might have set, each with a value that names it.
const CANARY_NAMES = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY",
  "OPENAI_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "ENCRYPTION_KEY", "SETUP_PASSWORD", "TARSEE_API_TOKEN",
  "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY",
  // and the rest of what R2 strips
  "TARSEE_LOCAL_AI_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_USE_VERTEX", "CODEX_HOME",
  "CODEX_ACCESS_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "TARSEE_PROVIDER_KEY", "TARSEE_CHATGPT_ACCESS_TOKEN",
  "TARSEE_MCP_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS",
  // the Claude sign-in and host variables the pinned CLI reads besides CLAUDE_CODE_OAUTH_TOKEN
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_LOCAL_OAUTH_API_BASE", "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  "CLAUDE_TRUSTED_DEVICE_TOKEN", "CLAUDE_SESSION_INGRESS_TOKEN_FILE", "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
];
const canary = (name) => `sk-test-canary-${name}`;
const BENIGN = { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/node", TARSEE_TIMEZONE: "UTC", LANG: "C.UTF-8" };
const serverEnv = (extra = {}) => ({ ...BENIGN, ...Object.fromEntries(CANARY_NAMES.map((n) => [n, canary(n)])), ...extra });
const VAULT = { CODEX_API_KEY: "sk-test-canary-vault-CODEX_API_KEY", SCRIPT_KEY: "script-key-from-the-vault" };

const STATE = path.join(os.tmpdir(), "tarsee-engine-env-state");
const KEYS = {
  anthropic: "sk-test-own-anthropic-key", deepseek: "sk-test-own-deepseek-key", openrouter: "sk-or-v1-test-own-openrouter-key",
  openai: "sk-test-own-openai-key", local: "sk-test-own-local-key",
};
const MCP = "mcp-test-token-0123456789";

// What counts as a credential-shaped variable for the exactness checks: deliberately wider than AUTH_ENV_RE, so a
// pin, a header or a config dir that appears unasked is caught too.
const CRED_SHAPED = /^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|OPENROUTER_|DEEPSEEK_|AWS_|ENCRYPTION_KEY$|SETUP_PASSWORD$|TARSEE_(PROVIDER_KEY|MCP_TOKEN|CHATGPT_ACCESS_TOKEN|API_TOKEN|LOCAL_AI_KEY)$)/;
const credOf = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => CRED_SHAPED.test(k)).sort(([a], [b]) => a.localeCompare(b)));
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const canaryValues = (env) => Object.entries(env).filter(([, v]) => String(v).includes("canary")).map(([k]) => k).sort();
const planCanaries = () => sorted(Object.fromEntries(PLAN_NAMES.map((n) => [n, canary(n)])));

const cc = (id, opts = {}) => claudeEnvFor(P[id], { env: serverEnv(), vaultEnv: VAULT, costSaver: {}, stateDir: STATE, key: KEYS[id], ...opts });
const cx = (id, opts = {}) => codexEnvFor(P[id], { env: serverEnv(), vaultEnv: VAULT, stateDir: STATE, key: KEYS[id], mcpToken: MCP, ...opts });

const GATEWAY_FLAGS = {
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", CLAUDE_CODE_ATTRIBUTION_HEADER: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

describe("engine-env canary matrix: exactly the provider's own credential, on every path", () => {
  it("claude plan: every ANTHROPIC_* stripped; the operator's Claude sign-in variables go back, nothing else", () => {
    assert.deepEqual([...PLAN_SIGN_IN_NAMES].sort(), PLAN_NAMES);
    const env = cc("claude", { key: undefined });
    assert.deepEqual(credOf(env), planCanaries());
    assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_")), []);
    assert.equal(env.SCRIPT_KEY, VAULT.SCRIPT_KEY);
  });

  it("claude plan: no sign-in variable when the operator didn't set one, even when the vault offers it", () => {
    const unset = Object.fromEntries(PLAN_NAMES.map((n) => [n, undefined]));
    const env = claudeEnvFor(P.claude, {
      env: serverEnv(unset), costSaver: {}, stateDir: STATE,
      vaultEnv: {
        ...VAULT, CLAUDE_CODE_OAUTH_TOKEN: "sk-test-canary-vault-oauth", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "sk-test-canary-vault-refresh",
        ANTHROPIC_API_KEY: "sk-test-canary-vault-ant",
      },
    });
    assert.deepEqual(credOf(env), {});
    assert.deepEqual(canaryValues(env), []);
    assert.equal(env.SCRIPT_KEY, VAULT.SCRIPT_KEY);
  });

  it("claude plan: a refresh-token login (refresh token, scopes, client id) goes back as the operator set it", () => {
    const login = {
      CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "sk-test-canary-refresh",
      CLAUDE_CODE_OAUTH_SCOPES: "user:inference user:profile", CLAUDE_CODE_OAUTH_CLIENT_ID: undefined,
    };
    const env = claudeEnvFor(P.claude, { env: serverEnv(login), costSaver: {}, stateDir: STATE });
    assert.deepEqual(credOf(env), {
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "sk-test-canary-refresh", CLAUDE_CODE_OAUTH_SCOPES: "user:inference user:profile",
    });
  });

  it("claude plan: its id or the storage id claude-code is the same provider", () => {
    for (const id of ["claude", "claude-code"]) {
      assert.deepEqual(credOf(claudeEnvFor(id, { env: serverEnv(), costSaver: {} })), planCanaries(), id);
      assert.deepEqual(credOf(claudeEnvFor({ id }, { env: serverEnv(), costSaver: {} })), planCanaries(), `{id: ${id}}`);
    }
  });

  it("anthropic: its own home and its own key, nothing else", () => {
    const env = cc("anthropic");
    assert.deepEqual(credOf(env), sorted({
      CLAUDE_CONFIG_DIR: path.join(STATE, ".claude-home-anthropic"), ANTHROPIC_API_KEY: KEYS.anthropic,
    }));
  });

  it("deepseek on Claude Code: own home, constant host, own key as the bearer token, every model pinned to its own ids", () => {
    const env = cc("deepseek");
    assert.deepEqual(credOf(env), sorted({
      CLAUDE_CONFIG_DIR: path.join(STATE, ".claude-home-deepseek"),
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: KEYS.deepseek, ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: `${FLASH}[1m]`, ANTHROPIC_DEFAULT_OPUS_MODEL: `${PRO}[1m]`, ANTHROPIC_DEFAULT_SONNET_MODEL: `${FLASH}[1m]`,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: `${FLASH}[1m]`, ANTHROPIC_DEFAULT_FABLE_MODEL: `${PRO}[1m]`, ANTHROPIC_SMALL_FAST_MODEL: `${FLASH}[1m]`,
      CLAUDE_CODE_SUBAGENT_MODEL: `${FLASH}[1m]`, ...GATEWAY_FLAGS,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    }));
  });

  it("deepseek on Claude Code: the turn's model is the main pin, with or without the [1m] the design sends", () => {
    for (const model of [PRO, `${PRO}[1m]`, `${PRO}[1M]`]) {
      const env = cc("deepseek", { model });
      assert.equal(env.ANTHROPIC_MODEL, `${PRO}[1m]`, model);
      assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, `${PRO}[1m]`, model);
      assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, `${PRO}[1m]`, `${model}: the tier pins say the same as the main pin`);
      assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, `${FLASH}[1m]`, model);
      assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000", `${model}: the context pins are kept`);
      assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000", model);
    }
  });

  it("openrouter on Claude Code: own home, constant host, own key, own pins, the title header", () => {
    const env = cc("openrouter", { contextTokens: 200_000 });
    assert.deepEqual(credOf(env), sorted({
      CLAUDE_CONFIG_DIR: path.join(STATE, ".claude-home-openrouter"),
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: KEYS.openrouter, ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "~anthropic/claude-sonnet-latest", ANTHROPIC_DEFAULT_OPUS_MODEL: "~anthropic/claude-opus-latest",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "~anthropic/claude-sonnet-latest", ANTHROPIC_DEFAULT_HAIKU_MODEL: "~anthropic/claude-haiku-latest",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "~anthropic/claude-opus-latest", ANTHROPIC_SMALL_FAST_MODEL: "~anthropic/claude-haiku-latest",
      CLAUDE_CODE_SUBAGENT_MODEL: "~anthropic/claude-sonnet-latest", ...GATEWAY_FLAGS,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      ANTHROPIC_CUSTOM_HEADERS: "X-OpenRouter-Title: Tarsee",
    }));
  });

  it("openrouter on Claude Code: a 1M model's pin carries [1m], and so does every pin naming the same model", () => {
    const env = cc("openrouter", { contextTokens: 1_000_000 });
    assert.equal(env.ANTHROPIC_MODEL, "~anthropic/claude-sonnet-latest[1m]");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "~anthropic/claude-sonnet-latest[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "~anthropic/claude-sonnet-latest[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "~anthropic/claude-opus-latest", "a model whose window isn't known gets no suffix");
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
  });

  it("openrouter on Claude Code: the owner's title and referer go in as headers, and can't inject another header", () => {
    const env = cc("openrouter", { appTitle: "My Bot\r\nX-Evil: 1", referer: "https://example.test/\nX-Evil: 2" });
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "X-OpenRouter-Title: My Bot X-Evil: 1\nHTTP-Referer: https://example.test/ X-Evil: 2");
  });

  it("chatgpt (device sign-in) on Codex: its own home and the MCP token, nothing else", () => {
    const env = cx("chatgpt", { key: undefined });
    assert.deepEqual(credOf(env), sorted({ CODEX_HOME: path.join(STATE, ".codex-home"), TARSEE_MCP_TOKEN: MCP }));
  });

  it("openai on Codex: the key home and the MCP token; the key itself goes only through the SDK's apiKey", () => {
    const env = cx("openai");
    assert.deepEqual(credOf(env), sorted({ CODEX_HOME: path.join(STATE, ".codex-home-keys"), TARSEE_MCP_TOKEN: MCP }));
    assert.ok(!Object.values(env).includes(KEYS.openai), "the openai key is nowhere in the environment");
  });

  for (const id of ["openrouter", "deepseek", "local"]) {
    it(`${id} on Codex: the key home, the MCP token and its own key as TARSEE_PROVIDER_KEY`, () => {
      const env = cx(id);
      assert.deepEqual(credOf(env), sorted({
        CODEX_HOME: path.join(STATE, ".codex-home-keys"), TARSEE_MCP_TOKEN: MCP, TARSEE_PROVIDER_KEY: KEYS[id],
      }));
    });
  }

  it("local on Codex without a key: no TARSEE_PROVIDER_KEY at all (its key is optional)", () => {
    const env = cx("local", { key: undefined });
    assert.deepEqual(credOf(env), sorted({ CODEX_HOME: path.join(STATE, ".codex-home-keys"), TARSEE_MCP_TOKEN: MCP }));
  });

  const PATHS = [
    ["claude", "claude-code"], ["anthropic", "claude-code"], ["deepseek", "claude-code"], ["openrouter", "claude-code"],
    ["chatgpt", "codex"], ["openai", "codex"], ["openrouter", "codex"], ["deepseek", "codex"], ["local", "codex"],
  ];
  const build = (id, engine, opts = {}) => (engine === "claude-code" ? cc(id, opts) : cx(id, opts));

  it("the matrix covers every provider on every engine it runs on", () => {
    const want = PROVIDER_IDS.flatMap((id) => P[id].engines.map((engine) => `${id}/${engine}`)).sort();
    assert.deepEqual(PATHS.map(([id, engine]) => `${id}/${engine}`).sort(), want);
  });

  it("on every path: the vault's SCRIPT_KEY passes, no canary passes (but the operator's sign-in on the plan)", () => {
    for (const [id, engine] of PATHS) {
      const env = build(id, engine);
      assert.equal(env.SCRIPT_KEY, VAULT.SCRIPT_KEY, `${id}/${engine}`);
      const leaked = canaryValues(env);
      assert.deepEqual(leaked, id === "claude" ? PLAN_NAMES : [], `${id}/${engine}`);
      assert.equal(env.TARSEE_TIMEZONE, "UTC", `${id}/${engine}: benign variables pass`);
      assert.equal(env.PATH, BENIGN.PATH, `${id}/${engine}: benign variables pass`);
    }
  });

  it("on every path: the Tarsee secrets and the Railway provider keys never pass", () => {
    for (const [id, engine] of PATHS) {
      const env = build(id, engine);
      for (const name of TARSEE_SECRETS) assert.ok(!(name in env), `${id}/${engine}: ${name}`);
      for (const name of PROVIDER_KEY_NAMES) assert.ok(!(name in env), `${id}/${engine}: ${name}`);
    }
  });

  it("on every path: the provider's key appears at most once, and a base URL never without its own token", () => {
    for (const seam of [false, true]) {
      for (const [id, engine] of PATHS) {
        const extra = seam ? { NODE_ENV: "test", [`TARSEE_TEST_BASE_URL_${id.toUpperCase()}`]: "http://127.0.0.1:4555/fake" } : {};
        const env = build(id, engine, { env: serverEnv(extra) });
        const where = `${id}/${engine}${seam ? " (seam)" : ""}`;
        if (KEYS[id]) assert.ok(Object.values(env).filter((v) => v === KEYS[id]).length <= 1, where);
        assert.ok(!("OPENAI_BASE_URL" in env), `${where}: OPENAI_BASE_URL`);
        assert.ok(!("CLAUDE_CODE_API_BASE_URL" in env), `${where}: CLAUDE_CODE_API_BASE_URL`);
        if ("ANTHROPIC_BASE_URL" in env) {
          const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
          assert.equal(token, KEYS[id], `${where}: the base URL comes with the provider's own key`);
          assert.ok(!String(env.ANTHROPIC_BASE_URL).includes("canary"), where);
        }
      }
    }
  });

  it("a missing or blank key refuses the turn (R4), naming the provider, and never falls back to another credential", () => {
    const keyed = [["anthropic", "claude-code"], ["deepseek", "claude-code"], ["openrouter", "claude-code"],
      ["openai", "codex"], ["openrouter", "codex"], ["deepseek", "codex"]];
    for (const [id, engine] of keyed) {
      for (const key of [undefined, null, "", "   "]) {
        assert.throws(() => build(id, engine, { key }), (err) => err instanceof CredentialError && err.code === "needs-key" && err.provider === id, `${id}/${engine} key=${JSON.stringify(key)}`);
      }
    }
  });

  it("a key with a line break or NUL in it is refused, not sent", () => {
    assert.throws(() => cc("deepseek", { key: "sk-test-a\nb" }), (err) => err.code === "bad-key");
    assert.throws(() => cx("openrouter", { key: "sk-test-a\0b" }), (err) => err.code === "bad-key");
  });

  it("a key pasted into the wrong slot is refused on every path (the registry entry's wrongSlot)", () => {
    assert.throws(() => cc("anthropic", { key: "sk-ant-oat01-test-fake" }), (err) => err.code === "bad-key");
    for (const id of ["openrouter", "deepseek", "local"]) {
      assert.throws(() => cx(id, { key: "sk-ant-api03-test-fake" }), (err) => err.code === "bad-key", id);
    }
    assert.throws(() => cc("deepseek", { key: "sk-or-v1-test-fake" }), (err) => err.code === "bad-key");
  });

  it("a provider on an engine it can't run on is refused", () => {
    assert.throws(() => cc("openai"), (err) => err.code === "wrong-engine");
    assert.throws(() => cc("chatgpt"), (err) => err.code === "wrong-engine");
    assert.throws(() => cc("local"), (err) => err.code === "wrong-engine");
    assert.throws(() => cx("claude"), (err) => err.code === "wrong-engine");
    assert.throws(() => cx("anthropic"), (err) => err.code === "wrong-engine");
  });

  it("a gateway pin can never be a claude-* id (it would go to the wrong host)", () => {
    assert.throws(() => cc("deepseek", { model: "claude-sonnet-4-5" }), (err) => err.code === "bad-model");
    assert.throws(() => cc("deepseek", { tiers: { haiku: "claude-haiku-4-5" } }), (err) => err.code === "bad-model");
  });

  it("a Codex turn without its MCP token is refused", () => {
    assert.throws(() => cx("openai", { mcpToken: undefined }), (err) => err instanceof CredentialError && err.code === "needs-mcp-token");
  });

  it("the cost savers go on Claude Code turns only", () => {
    const claude = claudeEnvFor(P.claude, { env: { PATH: "/bin" } });
    assert.equal(claude.BASH_MAX_OUTPUT_LENGTH, "8000");
    assert.equal(claude.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "180000");
    const codex = codexEnvFor(P.openai, { env: { PATH: "/bin" }, stateDir: STATE, key: KEYS.openai, mcpToken: MCP });
    assert.ok(!("BASH_MAX_OUTPUT_LENGTH" in codex));
    assert.ok(!("CLAUDE_CODE_AUTO_COMPACT_WINDOW" in codex));
  });

  it("a gateway's compact window never exceeds the model's context", () => {
    const env = claudeEnvFor(P.openrouter, { env: { PATH: "/bin" }, stateDir: STATE, key: KEYS.openrouter, contextTokens: 200_000 });
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "180000");
    const small = claudeEnvFor(P.openrouter, { env: { PATH: "/bin" }, stateDir: STATE, key: KEYS.openrouter, contextTokens: 128_000 });
    assert.equal(small.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "128000");
    assert.equal(small.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "128000");
  });
});

describe("a provider is passed as its registry entry, never a bare id (the entry carries its hosts and key checks)", () => {
  it("a key provider's id string is refused by every builder, before a key is looked at", () => {
    const opts = { env: serverEnv(), costSaver: {}, stateDir: STATE, mcpToken: MCP, key: "sk-ant-api03-test-fake" };
    for (const id of ["anthropic", "deepseek", "openrouter"]) assert.throws(() => claudeEnvFor(id, opts), TypeError, id);
    for (const id of ["openai", "openrouter", "deepseek", "local", "chatgpt"]) assert.throws(() => codexEnvFor(id, opts), TypeError, id);
    for (const id of ["openrouter", "deepseek", "openai", "local"]) {
      for (const engine of ENGINES) assert.throws(() => hostFor(id, engine, { env: {} }), TypeError, `${id}/${engine}`);
    }
  });

  it("the plan's id (or storage id) is the one string accepted: there's nothing in its entry to check", () => {
    assert.equal(hostFor("claude", "claude-code", { env: {} }), null);
    assert.equal(hostFor("claude-code", "claude-code", { env: {} }), null);
    assert.doesNotThrow(() => claudeEnvFor("claude-code", { env: serverEnv(), costSaver: {} }));
  });

  it("an object without an id is refused", () => {
    assert.throws(() => claudeEnvFor({}, { env: {} }), TypeError);
    assert.throws(() => codexEnvFor(null, { env: {}, mcpToken: MCP }), TypeError);
  });
});

describe("hostFor: where a provider's turn goes, always a code constant (R3)", () => {
  it("gives each key provider its constant on each engine it runs on", () => {
    assert.equal(hostFor(P.deepseek, "claude-code", { env: {} }), "https://api.deepseek.com/anthropic");
    assert.equal(hostFor(P.deepseek, "codex", { env: {} }), "https://api.deepseek.com");
    assert.equal(hostFor(P.openrouter, "claude-code", { env: {} }), "https://openrouter.ai/api");
    assert.equal(hostFor(P.openrouter, "codex", { env: {} }), "https://openrouter.ai/api/v1");
    assert.equal(hostFor(P.anthropic, "claude-code", { env: {} }), "https://api.anthropic.com");
    assert.equal(hostFor(P.openai, "codex", { env: {} }), "https://api.openai.com/v1", "OpenAI's host is named, not left to Codex's default");
  });

  it("the sign-in plans have no host of Tarsee's: the engine's own sign-in host, and no key goes with it", () => {
    assert.equal(hostFor(P.claude, "claude-code", { env: {} }), null);
    assert.equal(hostFor(P.chatgpt, "codex", { env: {} }), null);
  });

  it("refuses a key provider whose entry has no host for the engine, instead of falling back to the engine's default", () => {
    const noCodexHost = { ...P.deepseek, baseUrl: { "claude-code": "https://api.deepseek.com/anthropic" } };
    assert.throws(() => hostFor(noCodexHost, "codex", { env: {} }), (err) => err instanceof CredentialError && err.code === "wrong-engine" && err.provider === "deepseek");
    const noClaudeCodeHost = { ...P.deepseek, baseUrl: { codex: "https://api.deepseek.com" } };
    assert.throws(() => claudeEnvFor(noClaudeCodeHost, { env: {}, stateDir: STATE, key: KEYS.deepseek, costSaver: {} }), (err) => err.code === "wrong-engine");
    assert.throws(() => hostFor({ id: "openrouter" }, "claude-code", { env: {} }), (err) => err.code === "wrong-engine");
    assert.throws(() => hostFor(P.openai, "claude-code", { env: {} }), (err) => err.code === "wrong-engine", "openai doesn't run on Claude Code");
  });

  it("Local AI's host is the owner's setting: an http(s) URL without credentials in it, or the turn waits for setup", () => {
    assert.equal(hostFor(P.local, "codex", { env: {}, localUrl: " http://192.168.1.20:11434/v1 " }), "http://192.168.1.20:11434/v1");
    assert.equal(hostFor(P.local, "codex", { env: {}, localUrl: "https://ai.example.test/v1" }), "https://ai.example.test/v1");
    for (const localUrl of [undefined, "", "   ", "ftp://192.168.1.20", "http://user:pw@192.168.1.20", "not a url", "file:///etc/passwd"]) {
      assert.throws(() => hostFor(P.local, "codex", { env: {}, localUrl }), (err) => err instanceof CredentialError && err.code === "needs-setup", String(localUrl));
    }
  });

  it("the test seam stands in for any keyed provider's host in tests, never for a sign-in plan's", () => {
    const env = (id) => ({ NODE_ENV: "test", [`TARSEE_TEST_BASE_URL_${id.toUpperCase()}`]: "http://127.0.0.1:4555/fake" });
    assert.equal(hostFor(P.openai, "codex", { env: env("openai") }), "http://127.0.0.1:4555/fake");
    assert.equal(hostFor(P.local, "codex", { env: env("local") }), "http://127.0.0.1:4555/fake");
    assert.equal(hostFor(P.claude, "claude-code", { env: env("claude") }), null);
    assert.equal(hostFor(P.chatgpt, "codex", { env: env("chatgpt") }), null);
  });
});

describe("finalizeEnv (R2: strip, merge, strip again, then add)", () => {
  it("a vault entry can't re-add a credential, the credential block always wins, and nothing undefined is passed", () => {
    const env = finalizeEnv({
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test-canary-env", ENCRYPTION_KEY: "sk-test-canary-enc", GONE: undefined },
      vaultEnv: { ANTHROPIC_BASE_URL: "http://canary.invalid", CODEX_API_KEY: "sk-test-canary-vault", SCRIPT_KEY: "ok" },
      extraEnv: { BASH_MAX_OUTPUT_LENGTH: "8000" },
      credentials: { ANTHROPIC_API_KEY: "sk-test-own" },
    });
    assert.deepEqual(env, { PATH: "/bin", SCRIPT_KEY: "ok", BASH_MAX_OUTPUT_LENGTH: "8000", ANTHROPIC_API_KEY: "sk-test-own" });
  });

  it("baseEnv is what the vault compares against: a vault key named like a stripped Railway key still reaches scripts", () => {
    const server = { PATH: "/bin", OPENAI_API_KEY: "sk-test-canary-railway", ENCRYPTION_KEY: "sk-test-canary-enc" };
    assert.deepEqual(baseEnv(server), { PATH: "/bin" });
    const vault = { OPENAI_API_KEY: "sk-test-vault-for-scripts" };
    const vaultEnv = agentVaultEnv({ get: (n) => vault[n], list: () => Object.keys(vault), env: baseEnv(server) });
    const env = codexEnvFor(P.chatgpt, { env: server, vaultEnv, stateDir: STATE, mcpToken: MCP });
    assert.equal(env.OPENAI_API_KEY, "sk-test-vault-for-scripts");
    assert.deepEqual(canaryValues(env), []);
  });

  it("strips credential names in any case (Windows environment names are case-insensitive)", () => {
    const env = finalizeEnv({ env: { anthropic_api_key: "sk-test-canary-lower", Codex_Home: "x", claude_code_oauth_refresh_token: "y", Path: "C:\\bin" } });
    assert.deepEqual(env, { Path: "C:\\bin" });
  });

  it("AUTH_ENV_RE covers the design's list and every Claude sign-in or host variable the pinned CLI reads", () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_FOO", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENAI_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK",
      "TARSEE_PROVIDER_KEY", "TARSEE_CHATGPT_ACCESS_TOKEN", "TARSEE_MCP_TOKEN",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_LOCAL_OAUTH_API_BASE",
      "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE", "CLAUDE_TRUSTED_DEVICE_TOKEN",
      "CLAUDE_SESSION_INGRESS_TOKEN_FILE", "CLAUDE_BG_AUTH_SNAPSHOT_PATH", "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR"]) {
      assert.ok(AUTH_ENV_RE.test(name), name);
      assert.ok(isAuthEnvName(name.toLowerCase()), name.toLowerCase());
    }
    for (const name of ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
      "OPENAI_API_KEY", "PATH", "SCRIPT_KEY", "MY_FILE_DESCRIPTOR"]) {
      assert.ok(!AUTH_ENV_RE.test(name), name);
    }
  });
});

describe("the engine-env tables agree with the provider registry", () => {
  it("every provider's key variable is stripped from every engine's environment", () => {
    for (const id of PROVIDER_IDS) {
      const name = P[id].envKey;
      if (!name) continue;
      assert.ok(isAuthEnvName(name) || PROVIDER_KEY_NAMES.includes(name), `${id}'s ${name} would reach every other provider's agent`);
      for (const [other, engine] of [["claude", "claude-code"], ["chatgpt", "codex"]]) {
        const env = other === "claude" ? claudeEnvFor(P.claude, { env: { [name]: "sk-test-canary" }, costSaver: {} })
          : codexEnvFor(P.chatgpt, { env: { [name]: "sk-test-canary" }, stateDir: STATE, mcpToken: MCP });
        assert.ok(!(name in env), `${name} reached ${other}/${engine}`);
      }
    }
  });

  it("a provider has a home exactly on the engines the registry says it runs on", () => {
    for (const id of PROVIDER_IDS) {
      for (const alias of new Set([id, P[id].storageId])) {
        for (const engine of ENGINES) {
          assert.equal(homeKeyFor(alias, engine) !== null, P[id].engines.includes(engine), `${alias}/${engine}`);
        }
      }
    }
  });

  it("every keyed provider has an https host on every engine it runs on", () => {
    for (const id of PROVIDER_IDS) {
      if (P[id].kind !== "key") continue;
      for (const engine of P[id].engines) assert.match(hostFor(P[id], engine, { env: {} }), /^https:\/\//, `${id}/${engine}`);
    }
  });
});

describe("the test-only base-URL seam", () => {
  const seam = (env) => testBaseUrl("deepseek", env);
  it("is honored only when NODE_ENV is test and the host is loopback", () => {
    assert.equal(seam({ NODE_ENV: "test", TARSEE_TEST_BASE_URL_DEEPSEEK: "http://127.0.0.1:4555/anthropic" }), "http://127.0.0.1:4555/anthropic");
    assert.equal(seam({ NODE_ENV: "test", TARSEE_TEST_BASE_URL_DEEPSEEK: "http://localhost:4555" }), "http://localhost:4555");
    assert.equal(seam({ NODE_ENV: "test", TARSEE_TEST_BASE_URL_DEEPSEEK: "http://[::1]:4555/x" }), "http://[::1]:4555/x");
  });

  it("is inert in production, in development and with NODE_ENV unset", () => {
    for (const NODE_ENV of ["production", "development", undefined, "TEST", " test"]) {
      assert.equal(seam({ NODE_ENV, TARSEE_TEST_BASE_URL_DEEPSEEK: "http://127.0.0.1:4555" }), null, String(NODE_ENV));
      const env = claudeEnvFor(P.deepseek, {
        env: { NODE_ENV, TARSEE_TEST_BASE_URL_DEEPSEEK: "http://127.0.0.1:4555" }, costSaver: {}, stateDir: STATE, key: KEYS.deepseek,
      });
      assert.equal(env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic", String(NODE_ENV));
    }
  });

  it("is ignored for any host off loopback, credentials in the URL, or a non-http scheme", () => {
    for (const url of ["http://example.com", "http://127.0.0.1.evil.test", "http://0.0.0.0:4555", "http://10.0.0.1",
      "http://user:pw@127.0.0.1:4555", "file:///etc/passwd", "ftp://127.0.0.1", "not a url"]) {
      assert.equal(seam({ NODE_ENV: "test", TARSEE_TEST_BASE_URL_DEEPSEEK: url }), null, url);
    }
  });

  it("points a gateway at the fake in tests, with its own key", () => {
    const env = claudeEnvFor(P.deepseek, {
      env: serverEnv({ NODE_ENV: "test", TARSEE_TEST_BASE_URL_DEEPSEEK: "http://127.0.0.1:4555/anthropic" }),
      costSaver: {}, stateDir: STATE, key: KEYS.deepseek,
    });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4555/anthropic");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEYS.deepseek);
  });

  it("the Claude plan never gets a base URL, seam or not", () => {
    const env = claudeEnvFor(P.claude, {
      env: serverEnv({ NODE_ENV: "test", TARSEE_TEST_BASE_URL_CLAUDE: "http://127.0.0.1:4555" }), costSaver: {},
    });
    assert.ok(!("ANTHROPIC_BASE_URL" in env));
    assert.equal(hostFor(P.claude, "claude-code", { env: { NODE_ENV: "test", TARSEE_TEST_BASE_URL_CLAUDE: "http://127.0.0.1:1" } }), null);
  });
});

describe("R8: the vault never puts Codex settings or Tarsee's own secrets in the agent's environment", () => {
  const vault = {
    CODEX_API_KEY: "sk-test-canary-1", CODEX_HOME: "/evil", OPENAI_BASE_URL: "http://canary.invalid",
    ENCRYPTION_KEY: "sk-test-canary-2", SETUP_PASSWORD: "sk-test-canary-3", SCRIPT_KEY: "ok", OPENAI_API_KEY: "sk-test-script",
  };
  it("keeps CODEX_*, OPENAI_BASE_URL, ENCRYPTION_KEY and SETUP_PASSWORD out; the rest still reach scripts", () => {
    const env = agentVaultEnv({ get: (n) => vault[n], list: () => Object.keys(vault), env: {} });
    assert.deepEqual(env, { SCRIPT_KEY: "ok", OPENAI_API_KEY: "sk-test-script" });
    assert.ok(AGENT_ENV_KEEP_OUT.test("CODEX_ANYTHING"));
  });
});

describe("R1: one credential home per provider and engine", () => {
  it("homeFor names each home", () => {
    assert.equal(homeFor("claude", "claude-code", { homeDir: "/home/node" }), path.join("/home/node", ".claude"));
    assert.equal(homeFor("claude-code", "claude-code", { homeDir: "/home/node" }), path.join("/home/node", ".claude"));
    for (const id of ["anthropic", "deepseek", "openrouter"]) {
      assert.equal(homeFor(id, "claude-code", { stateDir: STATE }), path.join(STATE, `.claude-home-${id}`));
    }
    assert.equal(homeFor("chatgpt", "codex", { stateDir: STATE }), path.join(STATE, ".codex-home"));
    for (const id of ["openai", "openrouter", "deepseek", "local"]) {
      assert.equal(homeFor(id, "codex", { stateDir: STATE }), path.join(STATE, ".codex-home-keys"));
    }
  });

  it("a key home needs the caller's state folder (config.STATE_DIR): there is no default to guess wrong on Railway", () => {
    for (const [id, engine] of [["deepseek", "claude-code"], ["anthropic", "claude-code"], ["chatgpt", "codex"], ["openai", "codex"]]) {
      assert.throws(() => homeFor(id, engine), TypeError, `${id}/${engine}`);
      assert.throws(() => homeFor(id, engine, { stateDir: "  " }), TypeError, `${id}/${engine} blank`);
      assert.throws(() => homeFor(id, engine, { env: { TARSEE_STATE_DIR: "/data/tarsee" } }), TypeError, `${id}/${engine}: TARSEE_STATE_DIR is not a default`);
    }
    assert.throws(() => claudeEnvFor(P.deepseek, { env: { PATH: "/bin" }, key: KEYS.deepseek }), TypeError);
    assert.throws(() => codexEnvFor(P.chatgpt, { env: { PATH: "/bin" }, mcpToken: MCP }), TypeError);
    // An explicit home is enough, and the plan's home is the user's own .claude.
    assert.equal(claudeEnvFor(P.deepseek, { env: { PATH: "/bin" }, key: KEYS.deepseek, home: "/x/.claude-home-deepseek" }).CLAUDE_CONFIG_DIR, "/x/.claude-home-deepseek");
    assert.doesNotThrow(() => claudeEnvFor(P.claude, { env: { PATH: "/bin" } }));
    assert.equal(homeFor("claude", "claude-code", { homeDir: "/home/node" }), path.join("/home/node", ".claude"));
  });

  it("homeFor refuses a provider on an engine it doesn't run on", () => {
    for (const [id, engine] of [["claude", "codex"], ["anthropic", "codex"], ["openai", "claude-code"], ["chatgpt", "claude-code"],
      ["local", "claude-code"], ["nobody", "codex"], ["deepseek", "other"]]) {
      assert.throws(() => homeFor(id, engine, { stateDir: STATE }), (err) => err.code === "wrong-engine", `${id}/${engine}`);
    }
  });

  it("homeKeyFor: cc on Claude Code, cxd for the ChatGPT sign-in home, cx for the key home", () => {
    assert.equal(homeKeyFor("deepseek", "claude-code"), "cc");
    assert.equal(homeKeyFor("claude", "claude-code"), "cc");
    assert.equal(homeKeyFor("chatgpt", "codex"), "cxd");
    assert.equal(homeKeyFor("openai", "codex"), "cx");
    assert.equal(homeKeyFor("openrouter", "codex"), "cx");
    assert.equal(homeKeyFor("openai", "claude-code"), null);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-engine-env-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("ensureHome creates the folder (and its parents) owner-only, and is idempotent", () => {
    const dir = path.join(tmp, "state", ".claude-home-deepseek");
    assert.equal(ensureHome(dir), dir);
    assert.ok(fs.statSync(dir).isDirectory());
    ensureHome(dir);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      fs.chmodSync(dir, 0o755);
      ensureHome(dir);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "an existing folder is tightened");
    }
  });

  const mk = (name, files = {}) => {
    const dir = path.join(tmp, "homes", name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
    return dir;
  };

  it("a key home holding a sign-in file refuses the turn; the sign-in homes may hold theirs", () => {
    const bad1 = homeIsolationRefusal(mk(".claude-home-deepseek", { ".credentials.json": "{\"fake\":true}" }));
    assert.equal(bad1?.code, "credential-isolation");
    assert.equal(bad1.file, path.join(tmp, "homes", ".claude-home-deepseek", ".credentials.json"));
    assert.equal(homeIsolationRefusal(mk(".codex-home-keys", { "auth.json": "{\"fake\":true}" }))?.code, "credential-isolation");
    assert.equal(homeIsolationRefusal(mk(".claude-home-openrouter")), null);
    assert.equal(homeIsolationRefusal(mk(".claude-code-home", { ".credentials.json": "{}" })), null);
    assert.equal(homeIsolationRefusal(mk(".codex-home", { "auth.json": "{}" })), null);
    assert.equal(homeIsolationRefusal(path.join(tmp, "homes", "missing", ".claude-home-anthropic")), null);
  });

  it("the refusal also holds for a home at another path when the provider and engine say it's a key home", () => {
    const dir = mk("custom-home", { ".credentials.json": "{}", "auth.json": "{}" });
    assert.equal(homeIsolationRefusal(dir, { providerId: "anthropic", engine: "claude-code" })?.code, "credential-isolation");
    assert.equal(homeIsolationRefusal(dir, { providerId: "openai", engine: "codex" })?.code, "credential-isolation");
    assert.equal(homeIsolationRefusal(dir, { providerId: "claude", engine: "claude-code" }), null);
    assert.equal(homeIsolationRefusal(dir, { providerId: "chatgpt", engine: "codex" }), null);
  });

  it("a Claude key home whose global config holds a /login Console key (primaryApiKey) refuses the turn", () => {
    // The CLI writes .claude.json in CLAUDE_CONFIG_DIR on every run; only a stored key in it is a problem. A Terminal
    // `/login` with CLAUDE_CONFIG_DIR pointed at a key home would save one, and on a gateway turn (ANTHROPIC_API_KEY
    // empty) the CLI would send it as x-api-key to the gateway's host.
    const withKey = JSON.stringify({ numStartups: 3, primaryApiKey: "sk-ant-api03-test-canary-login" });
    const bad = homeIsolationRefusal(mk(".claude-home-deepseek-login", { ".claude.json": withKey }));
    assert.equal(bad?.code, "credential-isolation");
    assert.equal(bad.file, path.join(tmp, "homes", ".claude-home-deepseek-login", ".claude.json"));
    assert.ok(!bad.message.includes("canary"), "the key is never echoed");
    // The legacy name the CLI reads first when it's there.
    assert.equal(homeIsolationRefusal(mk(".claude-home-openrouter-legacy", { ".config.json": withKey }))?.code, "credential-isolation");
    // A file the CLI wrote half-way (not JSON) still can't hide a key.
    assert.equal(homeIsolationRefusal(mk(".claude-home-anthropic-torn", { ".claude.json": "{\"primaryApiKey\": \"sk-ant-api03-test-x\", " }))?.code, "credential-isolation");
    // The everyday file, an account's metadata, or an emptied key are fine.
    assert.equal(homeIsolationRefusal(mk(".claude-home-deepseek-ok", { ".claude.json": JSON.stringify({ numStartups: 3, oauthAccount: { emailAddress: "a@example.test" }, primaryApiKey: "" }) })), null);
    assert.equal(homeIsolationRefusal(mk("plan-home", { ".claude.json": withKey }), { providerId: "claude", engine: "claude-code" }), null, "the plan's own home is R6's business");
    assert.equal(homeIsolationRefusal(mk("custom-key-home", { ".claude.json": withKey }), { providerId: "deepseek", engine: "claude-code" })?.code, "credential-isolation");
  });
});

describe("R5: settingSources and the settings-file guard", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-settings-guard-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, ".claude-home-deepseek");
  const ws = path.join(tmp, "workspace");
  const write = (file, json) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json)); };

  it("settingSourcesFor: the plan keeps today's sources; every other provider loads the project only", () => {
    assert.deepEqual(settingSourcesFor("claude"), ["user", "project", "local"]);
    assert.deepEqual(settingSourcesFor("claude-code"), ["user", "project", "local"]);
    for (const id of ["anthropic", "deepseek", "openrouter"]) assert.deepEqual(settingSourcesFor(id), ["project"]);
  });

  it("settingsFilesFor lists the home's settings.json always, then each workspace file the sources load", () => {
    assert.deepEqual(settingsFilesFor(["project"], { home, workspace: ws }), [
      path.join(home, "settings.json"), path.join(ws, ".claude", "settings.json"),
    ]);
    assert.deepEqual(settingsFilesFor(["user", "project", "local"], { home, workspace: ws }), [
      path.join(home, "settings.json"), path.join(ws, ".claude", "settings.json"), path.join(ws, ".claude", "settings.local.json"),
    ]);
  });

  it("passes when the files are missing or hold no credential", () => {
    const files = settingsFilesFor(["user", "project", "local"], { home, workspace: ws });
    assert.deepEqual(settingsFileGuard(files), { ok: true, files: [] });
    write(path.join(ws, ".claude", "settings.json"), { env: { BASH_MAX_OUTPUT_LENGTH: "9000" }, permissions: { allow: [] } });
    assert.equal(settingsFileGuard(files).ok, true);
  });

  it("refuses a credential env entry in the home settings.json, naming the file and only the bad entries", () => {
    const file = path.join(home, "settings.json");
    write(file, { env: { ANTHROPIC_BASE_URL: "http://canary.invalid", FOO: "bar", anthropic_api_key: "sk-test-canary" } });
    const res = settingsFileGuard(settingsFilesFor(["project"], { home, workspace: ws }));
    assert.equal(res.ok, false);
    assert.deepEqual(res.files, [{ file, entries: ["env.ANTHROPIC_BASE_URL", "env.anthropic_api_key"] }]);
    assert.ok(res.message.includes(file));
    assert.ok(!res.message.includes("canary"), "values are never echoed");
    fs.rmSync(file);
  });

  it("refuses the Claude sign-in and host variables the pinned CLI reads, in any case", () => {
    const file = path.join(home, "settings.json");
    write(file, { env: {
      CLAUDE_CODE_API_BASE_URL: "http://canary.invalid", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "sk-test-canary",
      CLAUDE_CODE_CUSTOM_OAUTH_URL: "http://canary.invalid", claude_trusted_device_token: "sk-test-canary", OK_ONE: "1",
    } });
    const res = settingsFileGuard([file]);
    assert.equal(res.ok, false);
    assert.deepEqual(res.files, [{ file, entries: [
      "env.CLAUDE_CODE_API_BASE_URL", "env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "env.CLAUDE_CODE_CUSTOM_OAUTH_URL", "env.claude_trusted_device_token",
    ] }]);
    fs.rmSync(file);
  });

  it("refuses apiKeyHelper in the workspace settings.local.json", () => {
    const file = path.join(ws, ".claude", "settings.local.json");
    write(file, { apiKeyHelper: "/bin/echo sk-test-canary" });
    const res = settingsFileGuard(settingsFilesFor(["user", "project", "local"], { home, workspace: ws }));
    assert.equal(res.ok, false);
    assert.deepEqual(res.files, [{ file, entries: ["apiKeyHelper"] }]);
    fs.rmSync(file);
  });

  it("refuses a settings file it can't read as JSON (fail closed), and reads one with a byte-order mark", () => {
    const file = path.join(home, "settings.json");
    write(file, "{ not json");
    const res = settingsFileGuard([file]);
    assert.equal(res.ok, false);
    assert.deepEqual(res.files, [{ file, entries: [], unreadable: true }]);
    write(file, "\uFEFF" + JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }));
    assert.deepEqual(settingsFileGuard([file]).files, [{ file, entries: ["env.CLAUDE_CODE_USE_BEDROCK"] }]);
    fs.rmSync(file);
  });
});

describe("Codex's config.toml guard (R5's counterpart for Codex)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-codex-guard-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, ".codex-home-keys");
  const ws = path.join(tmp, "workspace");
  const file = path.join(home, "config.toml");
  const guard = (text) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, text);
    try { return codexConfigGuard([file]); } finally { fs.rmSync(file); }
  };

  it("codexConfigFilesFor lists the home's config.toml and .env, then the workspace's project config", () => {
    assert.deepEqual(codexConfigFilesFor({ home, workspace: ws }), [path.join(home, "config.toml"), path.join(home, ".env"), path.join(ws, ".codex", "config.toml")]);
    assert.deepEqual(codexConfigFilesFor({ home }), [path.join(home, "config.toml"), path.join(home, ".env")]);
  });

  it("refuses a .env in the Codex home whatever it holds, even empty: Codex loads it into its own environment", () => {
    const dotenv = path.join(home, ".env");
    fs.mkdirSync(home, { recursive: true });
    try {
      for (const text of ["HTTP_PROXY=http://127.0.0.1:47812\n", "SSL_CERT_FILE=/tmp/attacker-ca.pem\n", "# nothing yet\n", ""]) {
        fs.writeFileSync(dotenv, text);
        const res = codexConfigGuard(codexConfigFilesFor({ home, workspace: ws }));
        assert.equal(res.ok, false, JSON.stringify(text));
        assert.deepEqual(res.files, [{ file: dotenv, entries: [], unreadable: true, dotenv: true }], JSON.stringify(text));
        assert.ok(res.message.includes(dotenv));
        assert.match(res.message, /into its own environment/);
        assert.match(res.message, /set the file aside/);
        assert.ok(!/127\.0\.0\.1|attacker/.test(res.message), "values are never echoed");
      }
      // A folder or a link by that name counts too: Codex would read through it.
      fs.rmSync(dotenv);
      fs.mkdirSync(dotenv);
      assert.equal(codexConfigGuard(codexConfigFilesFor({ home })).ok, false);
      fs.rmSync(dotenv, { recursive: true });
      // Beside a refused config.toml, both are named.
      fs.writeFileSync(dotenv, "HTTPS_PROXY=http://127.0.0.1:1\n");
      fs.writeFileSync(file, "openai_base_url = \"http://canary.invalid\"\n");
      const both = codexConfigGuard(codexConfigFilesFor({ home }));
      assert.deepEqual(both.files.map((f) => f.file), [file, dotenv]);
      assert.match(both.message, /openai_base_url/);
      assert.match(both.message, /into its own environment/);
    } finally {
      fs.rmSync(dotenv, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    }
    // Only the home's own .env loads: one in the workspace is not Codex's.
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, ".env"), "HTTP_PROXY=http://127.0.0.1:47812\n");
    try {
      assert.deepEqual(codexConfigGuard(codexConfigFilesFor({ home, workspace: ws })), { ok: true, files: [] });
    } finally {
      fs.rmSync(path.join(ws, ".env"), { force: true });
    }
  });

  it("passes when the files are missing", () => {
    assert.deepEqual(codexConfigGuard(codexConfigFilesFor({ home, workspace: ws })), { ok: true, files: [] });
  });

  it("passes the seeded config and what Codex itself writes there (project trust, notices, model choice)", () => {
    const seeded = [
      "\uFEFF# Seeded by Tarsee: no secrets here.",
      "cli_auth_credentials_store = \"file\"",
      "check_for_update_on_startup = false",
      "forced_login_method = \"api\"   # the key homes",
      "model = \"gpt-6.1-sol\"",
      "model_reasoning_effort = 'high'",
      "",
      "[projects.'C:\\Users\\owner\\workspace']",
      "trust_level = \"trusted\"",
      "[projects.\"/data/tarsee/workspace\"]",
      "trust_level = \"trusted\"",
      "[notice]",
      "hide_full_access_warning = true",
      "[tui]",
      "notifications = true",
    ].join("\r\n");
    assert.deepEqual(guard(seeded), { ok: true, files: [] });
  });

  it("refuses anything that could send a key elsewhere or run a program that sees it, naming the entry, never its value", () => {
    const cases = {
      openai_base_url: "openai_base_url = \"http://127.0.0.1:47812/v1\"",
      chatgpt_base_url: "chatgpt_base_url = \"http://canary.invalid\"",
      model_provider: "model_provider = \"attacker\"",
      model_providers: "[model_providers.deepseek]\nbase_url = \"http://canary.invalid\"\nenv_key = \"TARSEE_PROVIDER_KEY\"",
      profile: "profile = \"evil\"",
      profiles: "[[ profiles . evil ]]\nmodel_provider = \"x\"",
      mcp_servers: "[mcp_servers.leak]\ncommand = \"node\"\nenv_vars = [\"TARSEE_PROVIDER_KEY\"]",
      notify: "notify = [\"node\", \"leak.js\"]",
      experimental_bearer_token: "experimental_bearer_token = \"sk-test-canary\"",
    };
    for (const [name, text] of Object.entries(cases)) {
      const res = guard(`check_for_update_on_startup = false\n${text}\n`);
      assert.equal(res.ok, false, name);
      assert.deepEqual(res.files, [{ file, entries: [name] }], name);
      assert.ok(res.message.includes(file), name);
      assert.ok(!/canary|127\.0\.0\.1|leak/.test(res.message), `${name}: values are never echoed`);
    }
  });

  it("sees a root entry however TOML spells it: dotted, quoted, spaced, as a table or an inline table", () => {
    for (const text of ["mcp_servers.leak.command = \"node\"", "\"mcp_servers\".leak = { command = \"node\" }",
      "'mcp_servers' . leak . command = \"x\"", "[ \"mcp_servers\" . leak ]", "mcp_servers = { leak = { command = \"node\" } }",
      "  mcp_servers.leak.command=\"node\"  # indented"]) {
      assert.deepEqual(guard(text).files, [{ file, entries: ["mcp_servers"] }], text);
    }
  });

  it("refuses any root entry it doesn't know (a newer Codex's plugins, network proxy, hooks...): fail closed", () => {
    assert.deepEqual(guard("[plugins.x]\nenabled = true\n[network]\nproxy_url = \"http://x\"").files, [{ file, entries: ["plugins", "network"] }]);
  });

  it("refuses a file it can't read safely: multi-line strings, continued values, escapes in keys, bad headers", () => {
    for (const text of ["model = \"\"\"\nx\n\"\"\"", "model = '''\nx\n'''", "notify = [\n  \"node\",\n]",
      "\"mcp\\u005Fservers\" = 1", "[projects]]", "[projects", "= 1", "just words"]) {
      const res = guard(text);
      assert.equal(res.ok, false, text);
      assert.equal(res.files[0].unreadable, true, text);
    }
  });

  it("a key under an allowed table belongs to that table, not the root", () => {
    assert.equal(guard("[projects.\"/w\"]\ntrust_level = \"trusted\"\nnotify = true").ok, true);
  });

  it("checks the workspace's project config too", () => {
    const projectFile = path.join(ws, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, "openai_base_url = \"http://canary.invalid\"\n");
    const res = codexConfigGuard(codexConfigFilesFor({ home, workspace: ws }));
    assert.deepEqual(res.files, [{ file: projectFile, entries: ["openai_base_url"] }]);
    fs.rmSync(projectFile);
  });
});
