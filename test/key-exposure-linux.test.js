// What an AI's key is exposed to on a Linux server (design 4.5 R7, R10; docs/providers.md "Tools on every AI").
// Both engines keep the key out of the environment of the commands the agent runs: Claude Code runs host-managed
// (CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) and Codex filters its shell's environment (shell_environment_policy), and
// test/claude-gateway.test.js and test/codex-engine.test.js check that with `env`. That is not a wall. On Linux those
// commands run as the same user as the engine that holds the key, so the engine's own /proc/<pid>/environ still has
// it. These tests run the REAL engines (the bundled Claude Code CLI, the pinned codex binary) against loopback fakes,
// have the agent's shell read its ancestors' environ, and assert the key IS there while its own environment is clean.
// If real isolation is added one day (a separate user, or a sandbox with its own process namespace and Tarsee's data
// folder masked), they fail: then revisit what the owner is told (docs/providers.md, README.md, the deploy files, the
// cards in routes/ai.js and js/provider-guides-core.js), which says a command the agent runs can still read the key.
// Linux only: there is no /proc to read elsewhere. Every key and token is an obvious fake; nothing leaves the machine.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINUX = process.platform === "linux" ? false : "Linux only: the agent's shell reads /proc/<pid>/environ";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-key-exposure-"));
process.env.TARSEE_STATE_DIR = path.join(tmp, "state");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a child may hold a file a moment */ } });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The credential names either engine is started with; the probe prints only these from each ancestor. */
const NAMES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "TARSEE_PROVIDER_KEY", "CODEX_API_KEY", "TARSEE_MCP_TOKEN"];
/**
 * The agent's command: every ancestor's environ (the engine's first), only the credential lines, each marked with its
 * pid; then how many of those names its own environment has. POSIX sh, so it runs under either engine's shell.
 */
const PROBE = [
  `p=$PPID; while [ -n "$p" ] && [ "$p" -gt 1 ]; do`,
  `tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -a -E '^(${NAMES.join("|")})=' | sed "s/^/ANCESTOR $p: /";`,
  `p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null); done;`,
  `echo "OWN: $(env | grep -c -E '^(${NAMES.join("|")})=')"`,
].join(" ");

/** What the probe printed: the ancestors' credential lines and the count in the shell's own environment. */
function parseProbe(out) {
  const ancestors = [...String(out).matchAll(/ANCESTOR (\d+): ([A-Z_]+)=([^\r\n"\\]*)/g)].map((m) => ({ pid: Number(m[1]), name: m[2], value: m[3] }));
  const own = /OWN: (\d+)/.exec(String(out));
  return { ancestors, own: own ? Number(own[1]) : null };
}

// --- Claude Code -----------------------------------------------------------------------------------------------------

const SDK_PKG = path.join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
function cliInstalled() {
  try {
    const pkg = JSON.parse(fs.readFileSync(SDK_PKG, "utf8"));
    return Object.keys(pkg.optionalDependencies || {}).some((dep) => fs.existsSync(path.join(ROOT, "node_modules", dep, "claude")));
  } catch { return false; }
}
const CLAUDE_SKIP = LINUX || (cliInstalled() ? false : "the Agent SDK's bundled Claude Code CLI isn't installed here");

const CLAUDE_KEYS = {
  openrouter: "sk-or-v1-testcanaryexposureopenrouter01",
  anthropic: "sk-ant-api03-test-canary-exposure-anthropic-AAAAAAAA",
};
const CLAUDE_KEY_NAME = { openrouter: "ANTHROPIC_AUTH_TOKEN", anthropic: "ANTHROPIC_API_KEY" };

describe("Claude Code on Linux: a command the agent runs can still read the key from the engine's process", { skip: CLAUDE_SKIP, timeout: 300_000 }, () => {
  let fake;
  let lib;
  before(async () => {
    lib = {
      ...(await import("../src/ai/providers/claude-code.js")),
      ...(await import("./fixtures/fake-anthropic.js")),
    };
    fake = await lib.startFakeAnthropic();
  });
  after(async () => { await fake?.close(); });

  let n = 0;
  async function probeTurn(providerId) {
    n += 1;
    const stateDir = path.join(tmp, `cc-state${n}`);
    const homeDir = path.join(tmp, `cc-home${n}`);
    const cwd = path.join(tmp, `cc-ws${n}`);
    for (const d of [stateDir, homeDir, cwd]) fs.mkdirSync(d, { recursive: true });
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|https?_proxy$|all_proxy$|no_proxy$)/i.test(k)) delete env[k];
    Object.assign(env, { NODE_ENV: "test", CLAUDE_CODE_MAX_RETRIES: "0", HOME: homeDir, [`TARSEE_TEST_BASE_URL_${providerId.toUpperCase()}`]: fake.url });
    fake.requests.length = 0;
    fake.script = (req) => (lib.hasToolResult(req.body)
      ? { text: "done" }
      : { toolUse: { id: "toolu_exposure_1", name: "Bash", input: { command: PROBE, description: "read the ancestors' environment" } } });
    const events = [];
    for await (const e of lib.run({
      target: { providerId },
      messages: [{ role: "user", content: "check the environment" }],
      systemPrompt: "You are a test.",
      deps: { env, stateDir, homeDir, cwd, key: CLAUDE_KEYS[providerId], mcpServer: null, vaultEnv: {} },
    })) events.push(e);
    assert.deepEqual(events.filter((e) => e.type === "done"), [{ type: "done", stopReason: "end_turn" }], JSON.stringify(events.filter((e) => e.type === "error")));
    const second = fake.messages().find((r) => lib.hasToolResult(r.body));
    assert.ok(second, "the command's output came back to the model");
    const block = lib.lastUserBlocks(second.body).find((b) => b.type === "tool_result");
    const out = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    assert.ok(!block.is_error, out.slice(0, 300));
    return parseProbe(out);
  }

  for (const providerId of ["openrouter", "anthropic"]) {
    it(`${providerId}: the shell's own environment has no key, but ${CLAUDE_KEY_NAME[providerId]} is in an ancestor's /proc environ`, async () => {
      const { ancestors, own } = await probeTurn(providerId);
      assert.equal(own, 0, "host-managed keeps the key out of the shell's own environment");
      const hit = ancestors.find((a) => a.name === CLAUDE_KEY_NAME[providerId] && a.value === CLAUDE_KEYS[providerId]);
      assert.ok(hit, `the key is no longer readable from an ancestor: real isolation? Revisit the docs and cards. Saw: ${JSON.stringify(ancestors.map((a) => [a.pid, a.name]))}`);
    });
  }
});

// --- Codex -----------------------------------------------------------------------------------------------------------

const CODEX_KEYS = { openai: "sk-test-canary-exposure-openai-0001", openrouter: "sk-or-v1-testcanaryexposurecodex0001" };
const CODEX_KEY_NAME = { openai: "CODEX_API_KEY", openrouter: "TARSEE_PROVIDER_KEY" };
const MCP_TOKEN = "sk-test-canary-exposure-mcp-token-0001";

describe("Codex on Linux: a command the agent runs can still read the key and the MCP token from codex's process", { skip: LINUX, timeout: 240_000 }, () => {
  let fake;
  let mcp;
  let lib;
  let handler = () => ({ text: "ok" });
  before(async () => {
    lib = {
      ...(await import("../src/ai/providers/codex.js")),
      ...(await import("./fixtures/fake-responses.js")),
      ...(await import("./fixtures/mcp-stub.js")),
    };
    fake = await lib.startFakeResponses({ handler: (body, info) => handler(body, info) });
    mcp = await lib.startMcpStub({ token: MCP_TOKEN });
  });
  after(async () => { await fake?.close(); await mcp?.close(); });

  let n = 0;
  async function probeTurn(provider) {
    n += 1;
    const state = path.join(tmp, `cx-state${n}`);
    const ws = path.join(tmp, `cx-ws${n}`);
    const home = path.join(tmp, `cx-home${n}`);
    for (const d of [state, ws, home]) fs.mkdirSync(d, { recursive: true });
    const m = new Map();
    const store = {
      get: (k) => (m.has(k) ? m.get(k) : null),
      set: (k, v) => { m.set(k, v); },
      delete: (k) => { m.delete(k); },
      getKeyWithSource: (id) => ({ key: CODEX_KEYS[id] ?? null, source: CODEX_KEYS[id] ? "settings" : null }),
    };
    const keep = ["PATH", "LANG", "TMPDIR", "TARSEE_CODEX_BIN"];
    const env = {
      ...Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]])),
      HOME: home, NODE_ENV: "test", TARSEE_TEST_BASE_URL_OPENAI: fake.url, TARSEE_TEST_BASE_URL_OPENROUTER: fake.url,
    };
    let seen = null;
    handler = (body, { index }) => {
      if (index === 0) return { calls: [{ name: "exec_command", arguments: { cmd: PROBE } }] };
      seen = lib.functionOutputs(body).map(lib.outputText).join("\n");
      return { text: "done" };
    };
    fake.reset();
    const out = [];
    for await (const e of lib.run({
      target: { provider, model: provider === "openrouter" ? "openai/gpt-5.5" : "gpt-5.5" },
      messages: [{ role: "user", content: "check the environment" }],
      systemParts: { stable: "You are Tarsee, under test.", volatile: "Today is a test day." },
      toolCtx: { settingsStore: store, conversationId: `conv-exposure-${n}` },
      mcpGrant: { url: mcp.url, token: MCP_TOKEN },
      turnId: `exposure-${provider}`,
      deps: { env, stateDir: state, workspace: ws, vaultEnv: async () => ({}), accountModels: () => [] },
    })) out.push(e);
    assert.deepEqual(out.filter((e) => e.type === "done"), [{ type: "done", stopReason: "end_turn" }], JSON.stringify(out.filter((e) => e.type === "error")));
    assert.ok(seen, "the command's output came back to the model");
    return parseProbe(seen);
  }

  for (const provider of ["openrouter", "openai"]) {
    it(`${provider}: the shell's own environment has no key or token, but ${CODEX_KEY_NAME[provider]} and TARSEE_MCP_TOKEN are in an ancestor's /proc environ`, async () => {
      const { ancestors, own } = await probeTurn(provider);
      assert.equal(own, 0, "shell_environment_policy keeps them out of the shell's own environment");
      const has = (name, value) => ancestors.some((a) => a.name === name && a.value === value);
      const saw = JSON.stringify(ancestors.map((a) => [a.pid, a.name]));
      assert.ok(has(CODEX_KEY_NAME[provider], CODEX_KEYS[provider]), `the key is no longer readable from an ancestor: real isolation? Revisit the docs and cards. Saw: ${saw}`);
      assert.ok(has("TARSEE_MCP_TOKEN", MCP_TOKEN), `the MCP token is no longer readable from an ancestor. Saw: ${saw}`);
    });
  }
});
