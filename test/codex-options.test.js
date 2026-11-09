// The Codex engine's options (src/ai/providers/codex-options.js, design 4.8 and R1/R2/R3/R7): for each provider a Codex
// turn runs on, buildCodexOptions() gives the child's environment, the --config overrides, the SDK's apiKey and the
// thread options. Every key, token and secret here is an obvious fake, and the server's environment is full of
// canaries: none may reach the config, the command line or (beyond the provider's own credential) the environment.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  buildCodexOptions, codexEffort, codexModelFor, capInstructions, instructionsLimit, configArgs, MCP_TOOL_TIMEOUT_SEC,
} from "../src/ai/providers/codex-options.js";
import { PROVIDERS } from "../src/ai/provider-registry.js";
import { buildPreamble } from "../src/ai/preamble.js";
import { CredentialError, CODEX_SHELL_EXCLUDED, CODEX_CONFIG_ALLOWED, codexChatgptTestHosts, codexConfigGuard } from "../src/ai/engine-env.js";

const STATE = path.join(os.tmpdir(), "tarsee-codex-options-state");
const WS = path.join(os.tmpdir(), "tarsee-codex-options-ws");
const MCP = { url: "http://127.0.0.1:45678/mcp", token: "mcp-test-token-0123456789abcdef" };
const KEYS = {
  openai: "sk-test-canary-own-openai-key",
  openrouter: "sk-or-v1-testcanaryownopenrouterkey",
  deepseek: "sk-testcanaryowndeepseekkey0001",
  local: "sk-test-canary-own-local-key",
};
const CANARIES = {
  OPENAI_API_KEY: "sk-test-canary-railway-openai", OPENROUTER_API_KEY: "sk-or-v1-testcanaryrailway",
  DEEPSEEK_API_KEY: "sk-testcanaryrailwaydeepseek", TARSEE_LOCAL_AI_KEY: "sk-test-canary-railway-local",
  CODEX_API_KEY: "sk-test-canary-codex-api-key", CODEX_HOME: "/canary/home", CODEX_ACCESS_TOKEN: "sk-test-canary-access",
  OPENAI_BASE_URL: "http://canary.invalid/v1", ANTHROPIC_API_KEY: "sk-ant-api03-testcanary", ENCRYPTION_KEY: "sk-test-canary-enc",
  TARSEE_PROVIDER_KEY: "sk-test-canary-provider-key", TARSEE_MCP_TOKEN: "sk-test-canary-mcp",
  TARSEE_CHATGPT_ACCESS_TOKEN: "sk-test-canary-chatgpt",
};
const SERVER = { PATH: "/usr/bin", HOME: "/home/node", LANG: "C.UTF-8", ...CANARIES };
const VAULT = { SCRIPT_KEY: "script-key-from-the-vault" };

const build = (id, target = {}, ctx = {}) => buildCodexOptions(
  { providerId: id, engine: "codex", ...target },
  { env: SERVER, vaultEnv: VAULT, stateDir: STATE, workspace: WS, mcp: MCP, key: KEYS[id], developerInstructions: "You are Tarsee.", localUrl: id === "local" ? "http://ollama.railway.internal:11434/v1" : undefined, ...ctx },
);

/** Every string anywhere in a value. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

describe("buildCodexOptions: per provider", () => {
  it("openai: the key only as the SDK's apiKey (CODEX_API_KEY in the child), OpenAI's host named explicitly, API login only", () => {
    const o = build("openai", { model: "gpt-6.1-sol" });
    assert.equal(o.apiKey, KEYS.openai);
    assert.equal(o.env.CODEX_HOME, path.join(STATE, ".codex-home-keys"));
    assert.equal(o.env.TARSEE_MCP_TOKEN, MCP.token);
    assert.equal(o.env.CODEX_API_KEY, undefined, "the SDK adds CODEX_API_KEY itself, from apiKey");
    assert.equal(o.config.forced_login_method, "api");
    assert.equal(o.config.openai_base_url, "https://api.openai.com/v1");
    assert.equal(o.config.model_provider, undefined);
    assert.equal(o.config.model_providers, undefined);
    assert.equal(o.threadOptions.model, "gpt-6.1-sol");
  });

  it("chatgpt: Codex's own sign-in in .codex-home, no key at all, ChatGPT login only, no host of Tarsee's", () => {
    const o = build("chatgpt", {}, { accountModels: [] });
    assert.equal(o.apiKey, undefined);
    assert.equal(o.env.CODEX_HOME, path.join(STATE, ".codex-home"));
    assert.equal(o.env.TARSEE_PROVIDER_KEY, undefined);
    assert.equal(o.config.forced_login_method, "chatgpt");
    assert.equal(o.config.openai_base_url, undefined);
    assert.equal(o.config.chatgpt_base_url, undefined);
    assert.equal(o.config.model_provider, undefined);
  });

  it("openrouter: a custom Responses provider on OpenRouter's host, the key as TARSEE_PROVIDER_KEY, the attribution header", () => {
    const o = build("openrouter", { model: "openai/gpt-6.1-sol" }, { appTitle: "My Tarsee", referer: "https://example.com" });
    assert.equal(o.apiKey, undefined);
    assert.equal(o.env.TARSEE_PROVIDER_KEY, KEYS.openrouter);
    assert.equal(o.env.OPENROUTER_API_KEY, undefined);
    assert.equal(o.config.model_provider, "tarsee_openrouter");
    assert.deepEqual(o.config.model_providers.tarsee_openrouter, {
      name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", env_key: "TARSEE_PROVIDER_KEY", wire_api: "responses",
      http_headers: { "X-OpenRouter-Title": "My Tarsee", "HTTP-Referer": "https://example.com" },
    });
    assert.equal(o.config.forced_login_method, "api");
    assert.equal(o.threadOptions.model, "openai/gpt-6.1-sol");
    // The default title, and no referer unless the owner set one.
    assert.deepEqual(build("openrouter", { model: "openai/x" }).config.model_providers.tarsee_openrouter.http_headers, { "X-OpenRouter-Title": "Tarsee" });
  });

  it("deepseek (the alternative engine): DeepSeek's Responses host, the key as TARSEE_PROVIDER_KEY", () => {
    const o = build("deepseek", { model: "deepseek-flash" });
    assert.equal(o.env.TARSEE_PROVIDER_KEY, KEYS.deepseek);
    assert.equal(o.config.model_provider, "tarsee_deepseek");
    assert.equal(o.config.model_providers.tarsee_deepseek.base_url, "https://api.deepseek.com");
    assert.equal(o.config.model_providers.tarsee_deepseek.wire_api, "responses");
    assert.equal(o.config.model_providers.tarsee_deepseek.env_key, "TARSEE_PROVIDER_KEY");
    assert.equal(o.config.forced_login_method, "api");
    assert.equal(o.threadOptions.model, "deepseek-flash");
  });

  it("local: the owner's server address, its key only when it has one, and the card's context window", () => {
    const o = build("local", { model: "llama3.1:8b" }, { contextTokens: 32_000 });
    const p = o.config.model_providers.tarsee_local;
    assert.equal(o.config.model_provider, "tarsee_local");
    assert.equal(p.base_url, "http://ollama.railway.internal:11434/v1");
    assert.equal(p.env_key, "TARSEE_PROVIDER_KEY");
    assert.equal(o.env.TARSEE_PROVIDER_KEY, KEYS.local);
    assert.equal(o.config.model_context_window, 32_000);
    // A server that sends its headers and then nothing (a wedged GPU, a model too big for its memory): Codex waits 5
    // minutes per try, so one retry, not five, gives up in about 10 minutes and lets the backup model answer.
    assert.equal(p.stream_max_retries, 1);
    assert.equal(p.stream_idle_timeout_ms, undefined, "Codex's own 5 minutes: a slow local model still answers");
    for (const id of ["openrouter", "deepseek"]) assert.equal(build(id, { model: id === "openrouter" ? "openai/x" : "deepseek-flash" }).config.model_providers[`tarsee_${id}`].stream_max_retries, undefined, id);
    const keyless = build("local", { model: "llama3.1:8b" }, { key: null });
    assert.equal(keyless.config.model_providers.tarsee_local.env_key, undefined);
    assert.equal(keyless.env.TARSEE_PROVIDER_KEY, undefined);
  });

  it("refuses before anything starts: a missing key, Local AI without an address, a provider Codex doesn't run", () => {
    for (const id of ["openai", "openrouter", "deepseek"]) {
      assert.throws(() => build(id, {}, { key: "" }), (e) => e instanceof CredentialError && e.code === "needs-key", id);
    }
    assert.throws(() => build("local", {}, { localUrl: "" }), (e) => e instanceof CredentialError && e.code === "needs-setup");
    assert.throws(() => build("anthropic"), (e) => e instanceof CredentialError && e.code === "wrong-engine");
    assert.throws(() => build("claude"), (e) => e instanceof CredentialError && e.code === "wrong-engine");
    assert.throws(() => build("nope"), /provider/i);
    assert.throws(() => build("openai", {}, { mcp: null }), (e) => e instanceof CredentialError && e.code === "needs-mcp-token");
    assert.throws(() => build("openai", {}, { workspace: "" }), TypeError);
  });
});

describe("buildCodexOptions: what every Codex turn gets", () => {
  const ALL = ["chatgpt", "openai", "openrouter", "deepseek", "local"];

  it("full access, no approvals, the workspace, no git check, no web search, the skills folder", () => {
    for (const id of ALL) {
      const t = build(id, { model: "m" }, { skillsDir: "/app/skills" }).threadOptions;
      assert.equal(t.sandboxMode, "danger-full-access", id);
      assert.equal(t.approvalPolicy, "never", id);
      assert.equal(t.workingDirectory, WS, id);
      assert.equal(t.skipGitRepoCheck, true, id);
      assert.equal(t.webSearchMode, "disabled", id);
      assert.equal(t.networkAccessEnabled, true, id);
      assert.deepEqual(t.additionalDirectories, ["/app/skills"], id);
    }
  });

  it("Tarsee's tools as a streamable-HTTP MCP server: the grant's url, the token by env name, tool calls approved", () => {
    for (const id of ALL) {
      const m = build(id).config.mcp_servers;
      assert.deepEqual(Object.keys(m), ["tarsee"], id);
      assert.equal(m.tarsee.url, MCP.url, id);
      assert.equal(m.tarsee.bearer_token_env_var, "TARSEE_MCP_TOKEN", id);
      assert.equal(m.tarsee.default_tools_approval_mode, "approve", id);
      assert.equal(m.tarsee.required, true, id);
      assert.ok(m.tarsee.tool_timeout_sec >= 180 && m.tarsee.tool_timeout_sec === MCP_TOOL_TIMEOUT_SEC, id);
      assert.ok(m.tarsee.startup_timeout_sec > 0, id);
    }
  });

  it("the shell inherits everything (vault keys reach scripts) except the engine's own credentials (R7)", () => {
    assert.deepEqual([...CODEX_SHELL_EXCLUDED].sort(), ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "TARSEE_CHATGPT_ACCESS_TOKEN", "TARSEE_MCP_TOKEN", "TARSEE_PROVIDER_KEY"]);
    for (const id of ALL) {
      const p = build(id).config.shell_environment_policy;
      assert.equal(p.inherit, "all", id);
      assert.equal(p.ignore_default_excludes, true, id);
      assert.deepEqual(p.filters, Object.fromEntries(CODEX_SHELL_EXCLUDED.map((n) => [n, "exclude"])), id);
    }
  });

  it("the fixed settings: instructions, no AGENTS.md, no history file, sign-in kept in a file, no update check", () => {
    for (const id of ALL) {
      const c = build(id).config;
      assert.equal(c.developer_instructions, "You are Tarsee.", id);
      assert.equal(c.project_doc_max_bytes, 0, id);
      assert.deepEqual(c.history, { persistence: "none" }, id);
      assert.equal(c.cli_auth_credentials_store, "file", id);
      assert.equal(c.check_for_update_on_startup, false, id);
      assert.equal(c.tool_output_token_limit, 3000, id);
      // ChatGPT's apps, plugins, extra agents and goals stay off: Tarsee's own tools do those jobs. Hooks too: a hook is
      // a program Codex would run with the turn's whole environment, the engine's own key included.
      for (const f of ["apps", "plugins", "multi_agent", "goals", "hooks"]) assert.equal(c.features[f], false, `${id} ${f}`);
      // No project root above the workspace: Codex would otherwise load a .codex/config.toml from every folder between
      // the nearest git root and the workspace (an mcp_servers entry there gets the turn's key), and the guard reads
      // only the workspace's own.
      assert.deepEqual(c.project_root_markers, [], id);
      assert.ok(configArgs(c).includes("project_root_markers=[]"), id);
    }
  });

  it("thinking summaries only when asked, and the compact limit is the smaller of the window setting and 85% of the context", () => {
    assert.equal(build("openai").config.model_reasoning_summary, "none");
    assert.equal(build("openai", {}, { thinkingSummaries: true }).config.model_reasoning_summary, "concise");
    assert.equal(build("openai", {}, { contextTokens: 400_000, compactWindow: 180_000 }).config.model_auto_compact_token_limit, 180_000);
    assert.equal(build("local", {}, { contextTokens: 32_000, compactWindow: 180_000 }).config.model_auto_compact_token_limit, 27_200);
  });

  it("the environment: no canary from the server's environment, the vault's keys, the turn's mark", () => {
    for (const id of ALL) {
      const o = build(id, {}, { turnMark: "turn-mark-1" });
      for (const [name, value] of Object.entries(CANARIES)) {
        const own = (name === "TARSEE_MCP_TOKEN" && o.env[name] === MCP.token) || (name === "TARSEE_PROVIDER_KEY" && o.env[name] === KEYS[id]) || (name === "CODEX_HOME" && o.env[name] !== value);
        if (!own) assert.equal(o.env[name], undefined, `${id}: ${name}`);
        assert.ok(!Object.values(o.env).includes(value), `${id}: the value of ${name}`);
      }
      assert.equal(o.env.SCRIPT_KEY, "script-key-from-the-vault", id);
      assert.equal(o.env.TARSEE_CODEX_TURN, "turn-mark-1", id);
    }
  });

  it("no secret in the config or on the command line, for any provider", () => {
    const secrets = [...Object.values(KEYS), MCP.token, ...Object.values(CANARIES)];
    for (const id of ALL) {
      const o = build(id, { model: "m", effort: "high" });
      const argv = configArgs(o.config).join("\n") + "\n" + strings(o.threadOptions).join("\n");
      for (const s of secrets) assert.ok(!argv.includes(s), `${id}: ${s.slice(0, 24)}… on the command line`);
      assert.ok(!strings(o.config).some((v) => secrets.includes(v)), id);
    }
  });

  it("configArgs flattens the config the way the SDK does (dotted keys, TOML values)", () => {
    const args = configArgs({ a: { b: "x", c: 2 }, d: [true, "y"], e: {} });
    assert.deepEqual(args, ["a.b=\"x\"", "a.c=2", "d=[true, \"y\"]", "e={}"]);
  });
});

describe("models and effort", () => {
  it("chatgpt names only a model the account's live list has, its default included; none when the list is missing or lacks it", () => {
    const list = [{ id: "gpt-6-luna", default: true, efforts: ["low", "medium"] }, { id: "gpt-6-luna-mini", efforts: ["low"] }];
    assert.equal(codexModelFor("chatgpt", "gpt-6-luna-mini", { accountModels: list }), "gpt-6-luna-mini");
    // The account's default is named too: left out, a `model` in the home's config.toml (the Terminal's /model writes
    // one there, and the guard allows it) would run instead of the one Tarsee shows and records.
    assert.equal(codexModelFor("chatgpt", "gpt-6-luna", { accountModels: list }), "gpt-6-luna");
    assert.equal(codexModelFor("chatgpt", "default", { accountModels: list }), undefined);
    assert.equal(codexModelFor("chatgpt", "gpt-6.1-sol", { accountModels: list }), undefined, "not on this account's list");
    assert.equal(codexModelFor("chatgpt", "gpt-6-luna-mini", { accountModels: [] }), undefined, "no live list: Codex's own default");
    assert.equal(codexModelFor("chatgpt", "gpt-6-luna-mini", {}), undefined, "no list at all: Codex's own default");
    assert.equal(codexModelFor("chatgpt", "", { accountModels: list }), undefined);
    assert.equal(build("chatgpt", { model: "gpt-6-luna-mini" }, { accountModels: list }).threadOptions.model, "gpt-6-luna-mini");
    assert.equal(build("chatgpt", { model: "gpt-6-luna" }, { accountModels: list }).threadOptions.model, "gpt-6-luna");
    // ...and the default's own efforts apply: a level it doesn't take is not sent.
    assert.equal(build("chatgpt", { model: "gpt-6-luna", effort: "high" }, { accountModels: list }).threadOptions.modelReasoningEffort, undefined);
    assert.equal(build("chatgpt", { model: "gpt-6-luna", effort: "medium" }, { accountModels: list }).threadOptions.modelReasoningEffort, "medium");
  });

  it("every other provider passes its model through, and none at all means Codex's default", () => {
    assert.equal(codexModelFor("openai", "gpt-6.1-sol"), "gpt-6.1-sol");
    assert.equal(codexModelFor("local", "llama3.1:8b"), "llama3.1:8b");
    assert.equal(codexModelFor("openai", "default"), undefined);
    assert.equal(codexModelFor("openai", null), undefined);
  });

  it("effort: Tarsee's levels go through, anything else is dropped, and a model's own list is respected", () => {
    for (const e of ["low", "medium", "high", "xhigh", "max"]) assert.equal(codexEffort(e), e);
    assert.equal(codexEffort("turbo"), undefined);
    assert.equal(codexEffort(undefined), undefined);
    assert.equal(codexEffort("max", ["low", "medium"]), undefined);
    assert.equal(codexEffort("low", ["low", "medium"]), "low");
    const list = [{ id: "gpt-6-luna-mini", efforts: ["low"] }];
    assert.equal(build("chatgpt", { model: "gpt-6-luna-mini", effort: "high" }, { accountModels: list }).threadOptions.modelReasoningEffort, undefined);
    assert.equal(build("chatgpt", { model: "gpt-6-luna-mini", effort: "low" }, { accountModels: list }).threadOptions.modelReasoningEffort, "low");
    assert.equal(build("openai", { model: "gpt-6.1-sol", effort: "xhigh" }).threadOptions.modelReasoningEffort, "xhigh");
  });
});

describe("developer instructions", () => {
  it("fit under the per-argument limit: 24 KB on Windows, 96 KB elsewhere", () => {
    assert.equal(instructionsLimit("win32"), 24 * 1024);
    assert.equal(instructionsLimit("linux"), 96 * 1024);
  });

  it("an oversized prompt loses its saved memories first, then its middle, never the preamble or the end, never a surrogate half", () => {
    // The instructions as a Codex turn builds them (codex.js): the preamble, the workspace CLAUDE.md, then the stable
    // part (workspace files, the database's quick memories, skills, the conversation's prompt, the channel hint).
    const preamble = buildPreamble({ engine: "codex", cwd: "/data/tarsee/workspace", timezone: "UTC" });
    const claudeMd = "## Workspace instructions (CLAUDE.md)\n\n" + "Keep the workspace tidy and log what you do.\n".repeat(150);
    const files = "<!-- SOUL.md -->\n" + "I am calm and precise, and I say so when I don't know.\n".repeat(150);
    const memories = "\n\nAdditional quick memories (shortened; search memory for the full note):\n"
      + Array.from({ length: 300 }, (_, i) => `- [fact] remembered fact number ${i} about the owner's projects`).join("\n");
    const skills = "\n\n## Skills\n- pdf: make PDF files\n- browser: browse the web";
    const conversationPrompt = "\n\nThis conversation's own prompt: answer in French.";
    const channelHint = "\n\nYou are talking on Telegram. Send a file with send_file, as an attachment.";
    const stable = files + memories + skills + conversationPrompt + channelHint;
    const text = [preamble, claudeMd, stable].join("\n\n");
    const limit = 24 * 1024;
    assert.ok(Buffer.byteLength(text) > limit, "the fixture is over the Windows limit");

    const fit = capInstructions(text, limit);
    assert.ok(Buffer.byteLength(fit) <= limit, `${Buffer.byteLength(fit)} bytes`);
    assert.ok(fit.startsWith(preamble), "the whole preamble survives");
    assert.ok(fit.includes("## Memory\nUse remember for durable facts."), "and its memory-tool instructions");
    assert.ok(fit.includes("Additional quick memories"), "the memories' heading stays");
    assert.ok(fit.includes("remembered fact number 0 ") && !fit.includes("remembered fact number 299 "), "the saved memories are trimmed first");
    assert.ok(fit.includes("## Skills") && fit.includes(conversationPrompt.trim()) && fit.endsWith(channelHint.trim()), "the end survives");
    assert.ok(fit.includes(claudeMd.slice(0, 200)), "the workspace instructions too, when trimming the memories is enough");

    // Not enough even without the memories: the middle goes (the workspace files), and both ends stay.
    const huge = [preamble, claudeMd, files.repeat(6) + memories + skills + conversationPrompt + channelHint].join("\n\n");
    const cut = capInstructions(huge, limit);
    assert.ok(Buffer.byteLength(cut) <= limit, `${Buffer.byteLength(cut)} bytes`);
    assert.ok(cut.startsWith(preamble), "the preamble survives");
    assert.ok(cut.endsWith(channelHint.trim()) && cut.includes(conversationPrompt.trim()), "the conversation's prompt and the channel hint survive");
    assert.match(cut, /trimmed to fit/);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(capInstructions("😀".repeat(5000) + "end", 1001)), "never half a character");

    const plain = capInstructions("x".repeat(10_000) + "😀", 1000);
    assert.ok(Buffer.byteLength(plain) <= 1000);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(plain));
    assert.equal(capInstructions("short", 1000), "short");
    assert.equal(capInstructions("a\uD800b", 1000), "ab", "lone surrogates are stripped");
  });

  it("build applies the platform's limit", () => {
    const big = "y".repeat(40 * 1024);
    assert.ok(Buffer.byteLength(build("openai", {}, { developerInstructions: big, platform: "win32" }).config.developer_instructions) <= 24 * 1024);
    assert.equal(build("openai", {}, { developerInstructions: big, platform: "linux" }).config.developer_instructions.length, big.length);
  });
});

describe("the test-only ChatGPT hosts and the config allowlist", () => {
  it("ChatGPT's hosts move only in tests, only to loopback", () => {
    assert.equal(codexChatgptTestHosts({ TARSEE_TEST_BASE_URL_CHATGPT: "http://127.0.0.1:9" }), null, "not without NODE_ENV=test");
    assert.equal(codexChatgptTestHosts({ NODE_ENV: "test", TARSEE_TEST_BASE_URL_CHATGPT: "http://canary.invalid" }), null);
    assert.deepEqual(codexChatgptTestHosts({ NODE_ENV: "test", TARSEE_TEST_BASE_URL_CHATGPT: "http://127.0.0.1:9/" }), {
      chatgpt_base_url: "http://127.0.0.1:9/backend-api/", openai_base_url: "http://127.0.0.1:9/backend-api/codex",
    });
    const o = build("chatgpt", {}, { env: { ...SERVER, NODE_ENV: "test", TARSEE_TEST_BASE_URL_CHATGPT: "http://127.0.0.1:9" } });
    assert.equal(o.config.chatgpt_base_url, "http://127.0.0.1:9/backend-api/");
    assert.equal(o.config.openai_base_url, "http://127.0.0.1:9/backend-api/codex");
  });

  it("the guard reads a trusted folder however Codex spells it, and still refuses a root name hidden by escapes", () => {
    const guard = (text) => codexConfigGuard(["config.toml"], { readFile: () => text });
    // What Codex writes when a folder is trusted from the Terminal: a literal string, or (a path with a ' in it, which
    // can't be one) a basic string with its backslashes escaped.
    assert.equal(guard("[projects.'C:\\Users\\owner\\workspace']\ntrust_level = \"trusted\"\n").ok, true);
    assert.equal(guard("[projects.\"C:\\\\Users\\\\O'Neil\\\\workspace\"]\ntrust_level = \"trusted\"\n").ok, true);
    assert.equal(guard("[projects.\"/data/a \\\"quoted\\\" name\"]\ntrust_level = \"trusted\"\n").ok, true);
    assert.equal(guard("[projects.\"/data/workspace\"]\ntrust_level = \"trusted\"\n").ok, true);
    // An escape in the root name could spell any name: refused, unread.
    for (const text of ["\"openai_base_u\\u0072l\" = \"http://x.invalid\"\n", "[\"mcp_serv\\u0065rs\".leak]\ncommand = \"node\"\n"]) {
      const r = guard(text);
      assert.equal(r.ok, false, text);
      assert.equal(r.files[0].unreadable, true, text);
    }
    // A string that never closes, or an escape at the end of the line: unread.
    for (const text of ["[projects.\"C:\\\\x]\n", "[projects.\"C:\\\"]\n"]) assert.equal(guard(text).ok, false, text);
    // A root entry after a trusted folder's table is still a root entry only in TOML's eyes when there is no table:
    // after a [table] line, keys belong to that table (so this one is harmless and passes).
    assert.equal(guard("model = \"m\"\n[projects.\"C:\\\\a\"]\ntrust_level = \"trusted\"\n").ok, true);
    assert.equal(guard("openai_base_url = \"http://x.invalid\"\n[projects.\"C:\\\\a\"]\ntrust_level = \"trusted\"\n").ok, false);
  });

  it("the allowlist has what Codex writes itself (the Windows sandbox choice, features, personality) and nothing that moves traffic", () => {
    for (const k of ["windows", "features", "personality", "tui", "projects", "notice", "model", "model_reasoning_effort"]) assert.ok(CODEX_CONFIG_ALLOWED.includes(k), k);
    for (const k of ["openai_base_url", "chatgpt_base_url", "model_provider", "model_providers", "profile", "profiles", "mcp_servers", "notify", "plugins", "network", "shell_environment_policy", "otel", "analytics"]) {
      assert.ok(!CODEX_CONFIG_ALLOWED.includes(k), k);
    }
  });
});
