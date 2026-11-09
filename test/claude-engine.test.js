// The Claude Code engine (src/ai/providers/claude-code.js, design 4.7): buildQueryOptions() per provider, and run()'s
// event flow with the SDK's query() stubbed (what the real CLI does against a fake API is test/claude-gateway.test.js).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-claude-engine-"));
process.env.TARSEE_STATE_DIR = path.join(tmp, "state");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");

const { buildQueryOptions, run, apiKeySourceRefusal, approveKeyInHome, API_KEY_SOURCES, AUTH_EXPIRED_MESSAGE, BUNDLED_SKILLS_DIR, isAuthFailure } = await import("../src/ai/providers/claude-code.js");
const { PROVIDERS } = await import("../src/ai/provider-registry.js");
const { CredentialError } = await import("../src/ai/engine-env.js");
const { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } = await import("@anthropic-ai/claude-agent-sdk");

const CANARY = {
  ANTHROPIC_API_KEY: "sk-ant-api03-canary-server-anthropic-0000",
  ANTHROPIC_BASE_URL: "https://canary.invalid",
  ANTHROPIC_AUTH_TOKEN: "sk-test-canary-server-auth-token",
  OPENROUTER_API_KEY: "sk-or-v1-canaryserveropenrouter00",
  DEEPSEEK_API_KEY: "sk-canaryserverdeepseek000000",
  OPENAI_API_KEY: "sk-proj-canary-server-openai-000000",
  CLAUDE_CODE_SESSIONS_OAUTH_TOKEN: "sk-test-canary-sessions",
  CLAUDE_CODE_GATEWAY_TOKEN: "sk-test-canary-gateway-token",
  ENCRYPTION_KEY: "canary-encryption",
};
const KEYS = {
  anthropic: "sk-ant-api03-test-key-anthropic-AAAAAAAAAAAA",
  deepseek: "sk-testdeepseekkey000000000001",
  openrouter: "sk-or-v1-testopenrouterkey0001",
};
const serverEnv = (extra = {}) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...CANARY, ...extra });
const resolveModel = (m) => ({ fable: "claude-fable-test", opus: "claude-opus-test", sonnet: "claude-sonnet-test", haiku: "claude-haiku-test" })[m] || m;

let n = 0;
function dirs() {
  n += 1;
  const stateDir = path.join(tmp, `s${n}`);
  const homeDir = path.join(tmp, `h${n}`);
  const cwd = path.join(tmp, `w${n}`);
  for (const d of [stateDir, homeDir, cwd]) fs.mkdirSync(d, { recursive: true });
  return { stateDir, homeDir, cwd };
}

function build(provider, opts = {}, deps = {}) {
  const d = dirs();
  return buildQueryOptions(provider, { cwd: d.cwd, ...opts }, { env: serverEnv(), stateDir: d.stateDir, homeDir: d.homeDir, resolveModel, timezone: "UTC", ...deps });
}

function noCanaries(env, label) {
  const text = JSON.stringify(env);
  for (const [name, value] of Object.entries(CANARY)) assert.ok(!text.includes(value), `${label}: ${name}'s value leaked into the engine's environment`);
}

describe("buildQueryOptions: the Claude plan", () => {
  it("today's behaviour, made explicit: every setting source, the plan's sign-in only, no key", () => {
    const b = build("claude", { model: "opus", maxBudgetUsd: 0.5, thinkingSummaries: true, effort: "xhigh" }, { env: serverEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-plan-token" }) });
    assert.equal(b.providerId, "claude");
    assert.deepEqual(b.options.settingSources, ["user", "project", "local"]);
    assert.equal(b.options.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-test-plan-token");
    assert.equal(b.options.env.CLAUDE_CONFIG_DIR, undefined, "the plan keeps its own ~/.claude");
    for (const k of Object.keys(b.options.env)) assert.ok(!k.startsWith("ANTHROPIC_"), `${k} reached the plan`);
    noCanaries(b.options.env, "claude");
    assert.equal(b.options.model, "claude-opus-test");
    assert.equal(b.options.fallbackModel, "claude-sonnet-test,claude-haiku-test");
    assert.equal(b.options.maxBudgetUsd, 0.5, "the SDK keeps the plan's dollar ceiling itself");
    assert.deepEqual(b.options.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(b.options.effort, "xhigh");
    assert.equal(b.cost, "plan");
    assert.deepEqual(b.apiKeySources, ["none", "oauth"]);
  });

  it("the same tools, permissions and MCP rules on every provider", () => {
    for (const id of ["claude", "anthropic", "deepseek", "openrouter"]) {
      const b = build(id, { key: KEYS[id], mcpServer: { name: "tarsee-stub" } });
      assert.deepEqual(b.options.tools, ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "mcp__tarsee__*"], id);
      assert.deepEqual(b.options.allowedTools, b.options.tools, id);
      assert.equal(b.options.permissionMode, "bypassPermissions", id);
      assert.equal(b.options.allowDangerouslySkipPermissions, true, id);
      assert.equal(b.options.strictMcpConfig, id !== "claude", id === "claude" ? "the plan keeps the owner's own MCP servers (.mcp.json, plugins), as before" : `${id}: only Tarsee's own MCP servers`);
      assert.deepEqual(b.options.mcpServers, { tarsee: { name: "tarsee-stub" } }, id);
      assert.deepEqual(b.options.additionalDirectories, [BUNDLED_SKILLS_DIR], id);
      assert.equal(b.options.includePartialMessages, true, id);
      assert.equal(b.options.maxTurns, 50, id);
    }
  });

  it("the system prompt is Tarsee's preamble then the caller's, rendered fresh every request (never snapshotted)", () => {
    const b = build("claude", { systemPrompt: "You are helpful.\uD800" });
    assert.equal(b.options.systemPrompt.type, "custom");
    assert.equal(b.options.systemPrompt.snapshot, false);
    assert.match(b.options.systemPrompt.prompt, /^You ARE Tarsee/);
    assert.match(b.options.systemPrompt.prompt, /\n\nYou are helpful\.$/, "a lone surrogate is stripped");
    const parts = build("deepseek", { key: KEYS.deepseek, systemParts: { stable: "STABLE", volatile: "VOLATILE" } });
    const p = parts.options.systemPrompt.prompt;
    assert.ok(Array.isArray(p));
    assert.equal(p.length, 3);
    assert.match(p[0], /^You ARE Tarsee[\s\S]*\n\nSTABLE$/);
    assert.equal(p[1], SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    assert.equal(p[2], "VOLATILE");
  });

  it("resume and the abort controller pass through", () => {
    const ac = new AbortController();
    const b = build("claude", { resume: "raw-session-1", abortController: ac });
    assert.equal(b.options.resume, "raw-session-1");
    assert.equal(b.options.abortController, ac);
  });
});

describe("buildQueryOptions: the Anthropic key", () => {
  it("its own home, its key, only the project's settings, the exact cost and the SDK's own budget", () => {
    const d = dirs();
    const b = buildQueryOptions("anthropic", { key: KEYS.anthropic, model: "sonnet", maxBudgetUsd: 2, thinkingSummaries: true, cwd: d.cwd }, { env: serverEnv(), stateDir: d.stateDir, homeDir: d.homeDir, resolveModel });
    assert.equal(b.options.env.CLAUDE_CONFIG_DIR, path.join(d.stateDir, ".claude-home-anthropic"));
    assert.equal(b.home, b.options.env.CLAUDE_CONFIG_DIR);
    assert.equal(b.options.env.ANTHROPIC_API_KEY, KEYS.anthropic);
    assert.equal(b.options.env.ANTHROPIC_BASE_URL, undefined, "Claude Code's own host, never one from the server's env");
    assert.equal(b.options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    noCanaries(b.options.env, "anthropic");
    assert.deepEqual(b.options.settingSources, ["project"]);
    assert.deepEqual(b.settingsFiles, [path.join(b.home, "settings.json"), path.join(d.cwd, ".claude", "settings.json")]);
    assert.equal(b.options.model, "claude-sonnet-test");
    assert.equal(b.options.fallbackModel, "claude-haiku-test");
    assert.equal(b.options.maxBudgetUsd, 2);
    assert.ok(b.options.thinking);
    assert.equal(b.cost, "exact");
    assert.deepEqual(b.apiKeySources, ["ANTHROPIC_API_KEY"]);
  });

  it("no key refuses the turn (R4); a Claude sign-in token in the slot is the wrong key", () => {
    assert.throws(() => build("anthropic", {}), (e) => e instanceof CredentialError && e.code === "needs-key");
    assert.throws(() => build("anthropic", { key: "sk-ant-oat01-a-sign-in-token" }), (e) => e instanceof CredentialError && e.code === "bad-key");
  });
});

describe("buildQueryOptions: the gateways", () => {
  it("DeepSeek: its host and bearer key, every model pinned to its own ids with [1m], betas and extras off", () => {
    const b = build("deepseek", { key: KEYS.deepseek, model: "deepseek-flash", maxBudgetUsd: 1, thinkingSummaries: true, effort: "high" });
    const e = b.options.env;
    assert.equal(e.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(e.ANTHROPIC_AUTH_TOKEN, KEYS.deepseek);
    assert.equal(e.ANTHROPIC_API_KEY, "");
    for (const pin of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
      assert.match(e[pin], /^deepseek-(flash|v4-pro)\[1m\]$/, pin);
    }
    assert.equal(e.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
    assert.equal(e.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(e.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
    noCanaries(e, "deepseek");
    assert.equal(b.options.model, "deepseek-flash[1m]");
    assert.equal(b.options.fallbackModel, undefined, "Flash has nothing below it");
    assert.equal(b.options.maxBudgetUsd, undefined, "the SDK can't price DeepSeek: Tarsee's own guard keeps the ceiling");
    assert.equal(b.options.thinking, undefined, "no thinking summaries until confirmed on the gateway");
    assert.equal(b.options.effort, "high");
    assert.deepEqual(b.options.settingSources, ["project"]);
    assert.equal(b.cost, "estimate");
  });

  it("DeepSeek Pro falls back to Flash; an effort DeepSeek doesn't take is left out", () => {
    const b = build("deepseek", { key: KEYS.deepseek, model: "deepseek-v4-pro[1m]", effort: "medium" });
    assert.equal(b.options.model, "deepseek-v4-pro[1m]");
    assert.equal(b.options.fallbackModel, "deepseek-flash[1m]");
    assert.equal(b.options.effort, undefined);
  });

  it("OpenRouter: its host, the title header, the slug as is, no fallback", () => {
    const b = build("openrouter", { key: KEYS.openrouter, model: "~anthropic/claude-sonnet-latest", effort: "high", appTitle: "My Agent" });
    const e = b.options.env;
    assert.equal(e.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
    assert.equal(e.ANTHROPIC_AUTH_TOKEN, KEYS.openrouter);
    assert.equal(e.ANTHROPIC_API_KEY, "");
    assert.equal(e.ANTHROPIC_CUSTOM_HEADERS, "X-OpenRouter-Title: My Agent");
    noCanaries(e, "openrouter");
    assert.equal(b.options.model, "~anthropic/claude-sonnet-latest");
    assert.equal(b.options.fallbackModel, undefined);
    assert.equal(b.options.effort, "high", "Claude's efforts on anthropic/*");
    const d = build("openrouter", { key: KEYS.openrouter });
    assert.equal(d.options.env.ANTHROPIC_CUSTOM_HEADERS, "X-OpenRouter-Title: Tarsee");
  });

  it("every key and gateway provider runs host-managed (settings files can't move it, its key stays out of the shell's environment); the plan doesn't", () => {
    for (const id of ["anthropic", "deepseek", "openrouter"]) {
      assert.equal(build(id, { key: KEYS[id] }).options.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1", id);
    }
    const plan = build("claude", {}, { env: serverEnv({ CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1", CLAUDE_CODE_HOST_AUTH_ENV_VAR: "X" }) });
    assert.equal(plan.options.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, undefined, "the server's own value is stripped too");
    assert.equal(plan.options.env.CLAUDE_CODE_HOST_AUTH_ENV_VAR, undefined);
  });

  it("the gateways refuse a missing key and a key from another provider's slot", () => {
    assert.throws(() => build("deepseek", {}), (e) => e.code === "needs-key");
    assert.throws(() => build("openrouter", { key: KEYS.anthropic }), (e) => e.code === "bad-key");
  });

  it("a Codex-only provider is not this engine's", () => {
    assert.throws(() => build("chatgpt", {}), (e) => e instanceof CredentialError && e.code === "wrong-engine");
    assert.throws(() => build("openai", { key: "sk-proj-x" }), (e) => e.code === "wrong-engine");
  });
});

describe("R6: apiKeySourceRefusal", () => {
  it("allows only the credential Tarsee set up, per provider", () => {
    assert.deepEqual(API_KEY_SOURCES.claude, ["none", "oauth"]);
    assert.equal(apiKeySourceRefusal("claude", "none"), null);
    assert.equal(apiKeySourceRefusal("claude-code", "oauth"), null);
    assert.equal(apiKeySourceRefusal("anthropic", "ANTHROPIC_API_KEY"), null);
    assert.equal(apiKeySourceRefusal("deepseek", "none"), null);
    assert.equal(apiKeySourceRefusal("openrouter", "none"), null);
  });

  it("refuses a /login key or a helper anywhere, a key on the plan, and a key provider without its key", () => {
    for (const id of ["anthropic", "deepseek", "openrouter", "claude"]) {
      assert.equal(apiKeySourceRefusal(id, "/login managed key")?.code, "credential-isolation", id);
      assert.equal(apiKeySourceRefusal(id, "apiKeyHelper")?.code, "credential-isolation", id);
    }
    assert.match(apiKeySourceRefusal("claude", "ANTHROPIC_API_KEY").message, /Claude plan's sign-in/);
    assert.match(apiKeySourceRefusal("anthropic", "none").message, /fall back to a sign-in/);
    assert.match(apiKeySourceRefusal("deepseek", "/login managed key").message, /Terminal \/login/);
  });
});

describe("approveKeyInHome", () => {
  it("records the key's approval (its last 20 characters) where the CLI reads it, keeping the rest", () => {
    const home = fs.mkdtempSync(path.join(tmp, "approve-"));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 3, customApiKeyResponses: { approved: ["old-approval"], rejected: [KEYS.anthropic.slice(-20)] } }));
    const file = approveKeyInHome(home, `  ${KEYS.anthropic} `);
    assert.equal(file, path.join(home, ".claude.json"));
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(json.numStartups, 3);
    assert.deepEqual(json.customApiKeyResponses.approved, ["old-approval", KEYS.anthropic.slice(-20)]);
    assert.deepEqual(json.customApiKeyResponses.rejected, []);
    assert.equal(JSON.stringify(json).includes(KEYS.anthropic), false, "only the marker, never the key");
  });

  it("writes .config.json when the CLI reads that one", () => {
    const home = fs.mkdtempSync(path.join(tmp, "approve-"));
    fs.writeFileSync(path.join(home, ".config.json"), "{}");
    assert.equal(approveKeyInHome(home, KEYS.anthropic), path.join(home, ".config.json"));
    assert.equal(fs.existsSync(path.join(home, ".claude.json")), false);
  });
});

// --- run() with query() stubbed ------------------------------------------------------------------------------------

const WAIT = Symbol("wait for abort");
const THROW = (message) => ({ [THROW_KEY]: message });
const THROW_KEY = Symbol("throw");

/** A stand-in for the SDK's query(): yields a script of SDK messages; WAIT holds until the turn's abortController fires. */
function fakeQuery(script) {
  const calls = [];
  const q = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const list = typeof script === "function" ? script(options) : script;
    return (async function* () {
      for (const m of list) {
        if (m === WAIT) {
          await new Promise((resolve) => {
            if (options.abortController?.signal.aborted) resolve();
            else options.abortController?.signal.addEventListener("abort", resolve, { once: true });
          });
          throw Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" });
        }
        if (m && m[THROW_KEY]) throw new Error(m[THROW_KEY]);
        if (options.abortController?.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        yield m;
      }
    })();
  };
  q.calls = calls;
  return q;
}

const init = (apiKeySource = "none", extra = {}) => ({ type: "system", subtype: "init", apiKeySource, session_id: "sess-1", mcp_servers: [{ name: "tarsee", status: "connected" }], ...extra });
const delta = (text) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const assistant = (content, extra = {}) => ({ type: "assistant", parent_tool_use_id: null, message: { content }, ...extra });
const userResult = (id, text, isError = false) => ({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
const result = (extra = {}) => ({ type: "result", subtype: "success", is_error: false, result: "", session_id: "sess-1", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, total_cost_usd: 0.0123, modelUsage: {}, ...extra });
const msgStart = (id, usage) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id, usage } } });
const msgDelta = (usage) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage } });

/** Run the engine and collect its events. */
async function collect(opts) {
  const events = [];
  for await (const e of run(opts)) events.push(e);
  return events;
}

function runOpts(providerId, query, extra = {}) {
  const d = dirs();
  return {
    target: { providerId, model: extra.model },
    messages: [{ role: "user", content: extra.prompt || "hello there" }],
    systemPrompt: "SYS",
    ...extra,
    deps: {
      query,
      env: serverEnv(),
      stateDir: d.stateDir,
      homeDir: d.homeDir,
      cwd: d.cwd,
      key: KEYS[providerId],
      mcpServer: null,
      vaultEnv: {},
      resolveModel,
      isTranscriptOverCap: () => false,
      ...(extra.deps || {}),
    },
  };
}

const kinds = (events) => events.map((e) => e.type);
const dones = (events) => events.filter((e) => e.type === "done");
const textOf = (events) => events.filter((e) => e.type === "text").map((e) => e.content).join("");

describe("run(): the event flow", () => {
  it("text: streamed words, the session reported once, usage, then done end_turn", async () => {
    const q = fakeQuery([init(), delta("Hel"), delta("lo"), assistant([{ type: "text", text: "Hello" }]), result({ result: "Hello" })]);
    const sessions = [];
    const events = await collect(runOpts("claude", q, { onSessionHandle: (s) => sessions.push(s) }));
    assert.equal(textOf(events), "Hello", "the full assistant message isn't repeated after streaming");
    assert.deepEqual(sessions, ["sess-1"]);
    const usage = events.find((e) => e.type === "usage");
    assert.deepEqual(usage.usage, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });
    assert.equal(usage.costUsd, undefined, "the plan's usage is included in the plan");
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "end_turn" }]);
    assert.equal(events.at(-1).type, "done");
    assert.equal(q.calls[0].prompt, "hello there");
  });

  it("a tool round: tool_use, its live steps, the tool_result, and never stopReason tool_use", async () => {
    const q = fakeQuery([
      init(),
      assistant([{ type: "tool_use", id: "tu1", name: "mcp__tarsee__tarsee_datetime", input: {} }]),
      userResult("tu1", "2026-11-09 10:00"),
      delta("It is ten."),
      result(),
    ]);
    const events = await collect(runOpts("deepseek", q));
    const tu = events.find((e) => e.type === "tool_use");
    assert.deepEqual(tu, { type: "tool_use", id: "tu1", name: "mcp__tarsee__tarsee_datetime", input: {} });
    assert.deepEqual(events.find((e) => e.type === "tool_result"), { type: "tool_result", id: "tu1", ok: true, result: "2026-11-09 10:00" });
    const steps = events.filter((e) => e.type === "step").map((e) => e.kind);
    assert.ok(steps.includes("tool_start") && steps.includes("tool_end"), steps.join(","));
    assert.ok(kinds(events).indexOf("tool_use") < kinds(events).indexOf("tool_result"));
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "end_turn" }]);
  });

  it("a subagent's own tool calls stay inside its step", async () => {
    const q = fakeQuery([init(), assistant([{ type: "tool_use", id: "inner", name: "Bash", input: { command: "ls" } }], { parent_tool_use_id: "task-1" }), result()]);
    const events = await collect(runOpts("claude", q));
    assert.equal(events.filter((e) => e.type === "tool_use").length, 0);
  });

  it("the SDK's stops: turn limit, spend ceiling, an execution error", async () => {
    let events = await collect(runOpts("claude", fakeQuery([init(), result({ subtype: "error_max_turns", num_turns: 50, errors: [] })])));
    assert.equal(events.find((e) => e.type === "error").subtype, "error_max_turns");
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "max_turns" }]);
    events = await collect(runOpts("anthropic", fakeQuery([init("ANTHROPIC_API_KEY"), result({ subtype: "error_max_budget_usd", errors: [] })])));
    assert.equal(events.find((e) => e.type === "error").subtype, "error_max_budget_usd");
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "budget" }]);
    events = await collect(runOpts("claude", fakeQuery([init(), result({ subtype: "error_during_execution", errors: ["boom"] })])));
    assert.match(events.find((e) => e.type === "error").message, /boom/);
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "error" }]);
  });

  it("the plan's sign-in running out: the fix as text plus an error event, one done, even though the SDK then throws", async () => {
    const q = fakeQuery([
      init(),
      assistant([{ type: "text", text: "Not logged in · Please run /login" }], { error: "authentication_failed" }),
      result({ is_error: true, result: "Not logged in · Please run /login" }),
      THROW("Claude Code returned an error result: Not logged in · Please run /login"),
    ]);
    const events = await collect(runOpts("claude", q));
    assert.equal(textOf(events), AUTH_EXPIRED_MESSAGE);
    const err = events.find((e) => e.type === "error");
    assert.equal(err.code, "expired");
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "auth-expired" }]);
    assert.ok(!textOf(events).includes("Not logged in"), "the CLI's words are not the reply");
  });

  it("a gateway's 401 names the gateway's key, not Claude's sign-in", async () => {
    const q = fakeQuery([init(), assistant([{ type: "text", text: "Not logged in · Please run /login" }], { error: "authentication_failed" }), result({ is_error: true, result: "Not logged in · Please run /login" }), THROW("Claude Code returned an error result")]);
    const events = await collect(runOpts("deepseek", q));
    assert.match(textOf(events), /DeepSeek key was rejected/);
    assert.doesNotMatch(textOf(events), /claude auth login|claude login/);
    assert.equal(events.find((e) => e.type === "error").code, "auth");
    assert.equal(events.find((e) => e.type === "error").state, "error");
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "auth-expired" }]);
  });

  it("402: out of credit as an error (no text, so the turn layer can still fall back), never shown as the answer", async () => {
    const q = fakeQuery([init(), assistant([{ type: "text", text: "API Error: 402 Insufficient Balance" }], { error: "unknown" }), result({ is_error: true, result: "API Error: 402 Insufficient Balance" }), THROW("Claude Code returned an error result: API Error: 402 Insufficient Balance")]);
    const events = await collect(runOpts("deepseek", q));
    assert.equal(textOf(events), "");
    const err = events.find((e) => e.type === "error");
    assert.equal(err.code, "billing");
    assert.equal(err.status, 402);
    assert.equal(err.state, "out-of-credit", "the failure flag the turn layer writes");
    assert.match(err.message, /DeepSeek balance is empty/);
    assert.equal(err.recoverable, false);
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "error" }]);
  });

  it("a failed session resume is recoverable", async () => {
    const q = fakeQuery([init(), result({ is_error: true, result: "API Error: 400 diagnostics.previous_message_id: must be the id from a prior message" })]);
    const events = await collect(runOpts("claude", q));
    const err = events.find((e) => e.type === "error");
    assert.equal(err.recoverable, true);
    assert.equal(textOf(events), "");
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "error" }]);
  });

  it("a crash is an error and one done; no messages at all is an error too", async () => {
    let events = await collect(runOpts("claude", fakeQuery([init(), THROW("spawn failed")])));
    assert.match(events.find((e) => e.type === "error").message, /spawn failed/);
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "error" }]);
    events = await collect(runOpts("claude", fakeQuery([])));
    assert.match(events.find((e) => e.type === "error").message, /no response/);
    assert.equal(dones(events).length, 1);
  });

  it("Stop mid-stream: done aborted, once, and no error", async () => {
    const ac = new AbortController();
    const q = fakeQuery([init(), delta("partial "), WAIT]);
    const events = [];
    for await (const e of run(runOpts("openrouter", q, { signal: ac.signal }))) {
      events.push(e);
      if (e.type === "text") ac.abort();
    }
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "aborted" }]);
    assert.equal(events.filter((e) => e.type === "error").length, 0);
    assert.equal(q.calls[0].options.abortController.signal.aborted, true, "the CLI was told to stop");
  });

  it("a caller that stops reading stops the CLI", async () => {
    const q = fakeQuery([init(), delta("a"), WAIT]);
    for await (const e of run(runOpts("claude", q))) if (e.type === "text") break;
    assert.equal(q.calls[0].options.abortController.signal.aborted, true);
  });
});

describe("run(): R6, the apiKeySource guard, both directions", () => {
  it("a gateway reporting a /login key is stopped before anything else", async () => {
    const q = fakeQuery([init("/login managed key"), delta("should never show"), result()]);
    const events = await collect(runOpts("deepseek", q));
    const err = events.find((e) => e.type === "error");
    assert.equal(err.code, "credential-isolation");
    assert.equal(textOf(events), "");
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "error" }]);
    assert.equal(q.calls[0].options.abortController.signal.aborted, true);
  });

  it("the plan reporting an API key (metered billing) is stopped; the Anthropic key without its key is stopped", async () => {
    let events = await collect(runOpts("claude", fakeQuery([init("ANTHROPIC_API_KEY"), result()])));
    assert.equal(events.find((e) => e.type === "error").code, "credential-isolation");
    events = await collect(runOpts("anthropic", fakeQuery([init("none"), result()])));
    assert.equal(events.find((e) => e.type === "error").code, "credential-isolation");
    events = await collect(runOpts("anthropic", fakeQuery([init("ANTHROPIC_API_KEY"), result()])));
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "end_turn" }]);
  });
});

describe("run(): refusals before anything starts (R1, R4, R5)", () => {
  it("a key from the Railway variable is used (and only as this provider's own credential)", async () => {
    const q = fakeQuery([init(), result()]);
    await collect(runOpts("deepseek", q, { deps: { key: undefined } }));
    assert.equal(q.calls[0].options.env.ANTHROPIC_AUTH_TOKEN, CANARY.DEEPSEEK_API_KEY);
    assert.equal(q.calls[0].options.env.DEEPSEEK_API_KEY, undefined, "never by its Railway name");
  });

  it("no key: refused, the CLI never started", async () => {
    const q = fakeQuery([init(), result()]);
    const events = await collect(runOpts("deepseek", q, { deps: { key: undefined, env: { PATH: process.env.PATH } } }));
    assert.equal(q.calls.length, 0);
    const err = events.find((e) => e.type === "error");
    assert.equal(err.code, "needs-key");
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "error" }]);
  });

  it("R1: a key home holding the claude.ai sign-in or a /login key is refused", async () => {
    for (const [file, body] of [[".credentials.json", "{}"], [".claude.json", JSON.stringify({ primaryApiKey: "sk-ant-api03-planted-login-key" })]]) {
      const q = fakeQuery([init(), result()]);
      const opts = runOpts("openrouter", q);
      const home = path.join(opts.deps.stateDir, ".claude-home-openrouter");
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, file), body);
      const events = await collect(opts);
      assert.equal(q.calls.length, 0, file);
      assert.equal(events.find((e) => e.type === "error").code, "credential-isolation", file);
    }
  });

  it("R5: a settings file that would set a credential is refused, on the plan (home and local) and on a key provider", async () => {
    const cases = [
      ["claude", (o) => path.join(o.deps.homeDir, ".claude", "settings.json"), { env: { ANTHROPIC_API_KEY: "x" } }],
      ["claude", (o) => path.join(o.deps.cwd, ".claude", "settings.local.json"), { env: { ANTHROPIC_BASE_URL: "http://x" } }],
      ["anthropic", (o) => path.join(o.deps.stateDir, ".claude-home-anthropic", "settings.json"), { apiKeyHelper: "echo key" }],
      ["deepseek", (o) => path.join(o.deps.cwd, ".claude", "settings.json"), { env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }],
    ];
    for (const [id, where, body] of cases) {
      const q = fakeQuery([init(), result()]);
      const opts = runOpts(id, q);
      const file = where(opts);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
      const events = await collect(opts);
      assert.equal(q.calls.length, 0, `${id}: ${file}`);
      const err = events.find((e) => e.type === "error");
      assert.equal(err.code, "credential-isolation", file);
      assert.ok(err.message.includes(file), "the refusal names the file");
    }
  });

  it("a settings file the provider doesn't load is not its business", async () => {
    const q = fakeQuery([init("ANTHROPIC_API_KEY"), result()]);
    const opts = runOpts("anthropic", q);
    const file = path.join(opts.deps.cwd, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://x" } }));
    const events = await collect(opts);
    assert.equal(q.calls.length, 1);
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "end_turn" }]);
  });

  it("the Anthropic key's home records the key's approval before the CLI starts", async () => {
    const q = fakeQuery([init("ANTHROPIC_API_KEY"), result()]);
    const opts = runOpts("anthropic", q);
    await collect(opts);
    const json = JSON.parse(fs.readFileSync(path.join(opts.deps.stateDir, ".claude-home-anthropic", ".claude.json"), "utf8"));
    assert.deepEqual(json.customApiKeyResponses.approved, [KEYS.anthropic.slice(-20)]);
  });

  it("a provider this engine doesn't run is an error and one done", async () => {
    const q = fakeQuery([init(), result()]);
    const events = await collect(runOpts("chatgpt", q));
    assert.equal(q.calls.length, 0);
    assert.equal(events.find((e) => e.type === "error").code, "wrong-engine");
    assert.equal(dones(events).length, 1);
  });
});

describe("run(): cost and the turn budget", () => {
  it("the Anthropic key: the SDK's exact total_cost_usd", async () => {
    const events = await collect(runOpts("anthropic", fakeQuery([init("ANTHROPIC_API_KEY"), result({ total_cost_usd: 0.4321 })])));
    assert.equal(events.find((e) => e.type === "usage").costUsd, 0.4321);
    assert.equal(events.find((e) => e.type === "usage").costExact, true, "the provider's own figure");
  });

  it("DeepSeek: the price table over every model's tokens (subagents included), never the SDK's guess", async () => {
    const modelUsage = { "deepseek-flash[1m]": { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 99 } };
    const events = await collect(runOpts("deepseek", fakeQuery([init(), result({ total_cost_usd: 99, modelUsage })])));
    const cost = events.find((e) => e.type === "usage").costUsd;
    assert.ok(cost === 0.3 || cost === 0.15, `a million input tokens of Flash at peak or off-peak, got ${cost}`);
    assert.equal(events.find((e) => e.type === "usage").costExact, undefined, "a price-table estimate");
  });

  it("OpenRouter: its own streamed usage.cost, summed over the turn", async () => {
    const q = fakeQuery([init(), msgStart("m1", { input_tokens: 5 }), msgDelta({ output_tokens: 3, cost: 0.002 }), msgStart("m2", { input_tokens: 5 }), msgDelta({ output_tokens: 3, cost: 0.0035 }), result({ total_cost_usd: 99 })]);
    const events = await collect(runOpts("openrouter", q));
    assert.equal(events.find((e) => e.type === "usage").costUsd, 0.0055);
    assert.equal(events.find((e) => e.type === "usage").costExact, true, "OpenRouter's own figure");
  });

  it("OpenRouter's tier pins follow the registry's tiers, and only name models that run on Claude Code", async () => {
    const { setCatalogModels } = await import("../src/ai/provider-registry.js");
    setCatalogModels("openrouter", [
      { id: "google/gemini-3-pro", price: { in: 2, out: 12 } },
      { id: "google/gemini-3-flash", price: { in: 0.3, out: 2.5 } },
      { id: "google/gemini-3-ultra", price: { in: 10, out: 40 } },
    ]);
    try {
      const values = {
        "ai.openrouter.model": "google/gemini-3-pro",
        // Ultra runs on Claude Code; Flash passed Verify on Codex only, so Claude Code can't be handed it.
        "ai.openrouter.verified": JSON.stringify({ "google/gemini-3-pro": { engine: "claude-code" }, "google/gemini-3-ultra": { engine: "claude-code" }, "google/gemini-3-flash": { engine: "codex" } }),
      };
      const store = { get: (k) => values[k] ?? null };
      const q = fakeQuery([init(), result()]);
      await collect(runOpts("openrouter", q, { model: "google/gemini-3-pro", deps: { store } }));
      const e = q.calls[0].options.env;
      assert.equal(e.ANTHROPIC_MODEL, "google/gemini-3-pro");
      assert.equal(e.ANTHROPIC_DEFAULT_OPUS_MODEL, "google/gemini-3-ultra", "the maker's dearest verified model");
      assert.equal(e.ANTHROPIC_DEFAULT_FABLE_MODEL, "google/gemini-3-ultra");
      assert.equal(e.ANTHROPIC_DEFAULT_SONNET_MODEL, "google/gemini-3-pro");
      assert.equal(e.ANTHROPIC_DEFAULT_HAIKU_MODEL, "google/gemini-3-pro", "Flash runs on Codex only: the turn's own model instead");
      assert.equal(e.ANTHROPIC_SMALL_FAST_MODEL, "google/gemini-3-pro");
      for (const v of Object.values(e)) assert.doesNotMatch(String(v), /~anthropic\//, "no Claude behind the owner's back");
      // With no default of another maker, today's pins.
      const plain = fakeQuery([init(), result()]);
      await collect(runOpts("openrouter", plain, { model: "~anthropic/claude-sonnet-latest", deps: { store: { get: () => null } } }));
      assert.equal(plain.calls[0].options.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "~anthropic/claude-haiku-latest");
      assert.equal(plain.calls[0].options.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "~anthropic/claude-opus-latest");
    } finally {
      setCatalogModels("openrouter", []);
    }
  });

  it("a gateway turn over its ceiling is stopped by Tarsee's own guard", async () => {
    const q = fakeQuery([init(), msgStart("m1", { input_tokens: 2_000_000 }), msgDelta({ output_tokens: 10 }), WAIT]);
    const events = await collect(runOpts("deepseek", q, { maxBudgetUsd: 0.01 }));
    const err = events.find((e) => e.type === "error");
    assert.equal(err.subtype, "error_max_budget_usd");
    assert.match(err.message, /spending limit/);
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "budget" }]);
    assert.equal(q.calls[0].options.abortController.signal.aborted, true);
  });

  it("OpenRouter's reported cost trips the guard", async () => {
    const q = fakeQuery([init(), msgStart("m1", { input_tokens: 1 }), msgDelta({ output_tokens: 1, cost: 0.5 }), WAIT]);
    const events = await collect(runOpts("openrouter", q, { maxBudgetUsd: 0.25 }));
    assert.deepEqual(dones(events), [{ type: "done", stopReason: "budget" }]);
  });
});

describe("run(): media, sessions", () => {
  it("adapted media goes in as content blocks with the adapted words", async () => {
    const q = fakeQuery([init(), result()]);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    await collect(runOpts("claude", q, { media: { media: [image], text: "What is this?" } }));
    const prompt = q.calls[0].prompt;
    assert.equal(typeof prompt[Symbol.asyncIterator], "function");
    const first = (await prompt.next()).value;
    assert.deepEqual(first.message.content, [image, { type: "text", text: "What is this?" }]);
  });

  it("resumes only this provider's session; a transcript past the cap starts fresh", async () => {
    let q = fakeQuery([init(), result()]);
    await collect(runOpts("deepseek", q, { model: "deepseek-flash", sessionHandle: "deepseek/cc/deepseek:raw-ds-1" }));
    assert.equal(q.calls[0].options.resume, "raw-ds-1");
    q = fakeQuery([init(), result()]);
    await collect(runOpts("deepseek", q, { sessionHandle: "openrouter/cc/anthropic:raw-or-1" }));
    assert.equal(q.calls[0].options.resume, undefined);
    q = fakeQuery([init(), result()]);
    await collect(runOpts("claude", q, { sessionHandle: "plain-raw-id" }));
    assert.equal(q.calls[0].options.resume, "plain-raw-id");
    q = fakeQuery([init(), result()]);
    await collect(runOpts("claude", q, { sessionHandle: "plain-raw-id", deps: { isTranscriptOverCap: () => true, transcriptSizeMB: () => 99 } }));
    assert.equal(q.calls[0].options.resume, undefined);
  });

  it("a caller's own workspace (verification's scratch folder) is where the turn runs, and where R5 looks", async () => {
    const scratch = fs.mkdtempSync(path.join(tmp, "verify-"));
    let q = fakeQuery([init(), result()]);
    await collect(runOpts("deepseek", q, { cwd: scratch }));
    assert.equal(q.calls[0].options.cwd, scratch);
    fs.mkdirSync(path.join(scratch, ".claude"));
    fs.writeFileSync(path.join(scratch, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "echo x" }));
    q = fakeQuery([init(), result()]);
    const events = await collect(runOpts("deepseek", q, { cwd: scratch }));
    assert.equal(q.calls.length, 0);
    assert.equal(events.find((e) => e.type === "error").code, "credential-isolation");
  });

  it("the raw id the turn layer chose wins over the stored handle; null starts fresh", async () => {
    let q = fakeQuery([init(), result()]);
    await collect(runOpts("deepseek", q, { sessionHandle: "deepseek/cc/deepseek:raw-ds-1", sessionId: null }));
    assert.equal(q.calls[0].options.resume, undefined, "a fresh session on purpose (a retry, a reset) is kept fresh");
    q = fakeQuery([init(), result()]);
    await collect(runOpts("deepseek", q, { sessionHandle: "deepseek/cc/deepseek:raw-ds-1", sessionId: "raw-ds-1" }));
    assert.equal(q.calls[0].options.resume, "raw-ds-1");
  });
});

describe("isAuthFailure (kept for callers)", () => {
  it("knows the 0.3.319 CLI's 'Not logged in' as well", () => {
    assert.equal(isAuthFailure("Not logged in · Please run /login"), true);
    assert.equal(isAuthFailure("Here's how to log in to your router."), false);
  });
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });
before(() => {});
