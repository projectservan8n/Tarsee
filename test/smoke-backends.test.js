// scripts/smoke-backends.mjs (design 4.11 and Phase 7): Verify's four-step probe on every AI whose credentials are in
// the environment, printed as a table (or JSON for the shipped verified list).
//   - Keys are read only from environment variables (the real run uses a scratch database, so no saved key is used).
//   - A key never appears in the output, even when a provider's error message carries it.
//   - Nothing is recorded: the probe runs with record: false.
// The verify function is injected here; every key is an obvious fake.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { main, parseArgs, planRuns } = await import("../scripts/smoke-backends.mjs");

const KEYS = {
  DEEPSEEK_API_KEY: "sk-testcanarydeepseek0001smoke",
  OPENROUTER_API_KEY: "sk-or-v1-testcanary0001smokeOR",
  OPENAI_API_KEY: "sk-test-canary-openai-0001smoke",
  ANTHROPIC_API_KEY: "sk-ant-api03-test-canary-0001smoke",
};

function capture() {
  const out = { stdout: "", stderr: "" };
  return { out, write: (s) => { out.stdout += s; }, writeErr: (s) => { out.stderr += s; } };
}

/** A verify that passes everything except the providers in `fail`, whose error message carries `leak`. */
function fakeVerify({ fail = {}, calls = [] } = {}) {
  return async (provider, model, deps) => {
    calls.push({ provider, model, deps });
    const steps = ["reply", "tool", "shell", "resume"];
    if (fail[provider]) {
      return {
        ok: false, provider, model, engine: null, efforts: [], code: "auth",
        error: `Your key was rejected: Incorrect API key provided: ${fail[provider]} (Authorization: Bearer ${fail[provider]})`,
        checks: { reply: false, tool: null, shell: null, resume: null },
        steps: steps.map((step, i) => ({ step, ok: i === 0 ? false : null, ms: 0 })),
        attempts: [{ engine: "claude-code", ok: false, checks: [] }],
      };
    }
    return {
      ok: true, provider, model, engine: provider === "openai" ? "codex" : "claude-code", efforts: ["low", "high"],
      engineVersion: "2.1.319",
      checks: { reply: true, tool: true, shell: true, resume: true },
      steps: steps.map((step) => ({ step, ok: true, ms: 1200 })),
      attempts: [{ engine: "claude-code", ok: true, checks: [] }],
      entry: { engine: "claude-code", at: "2026-11-09T12:00:00.000Z", engineVersion: "2.1.319", efforts: ["low", "high"] },
    };
  };
}

describe("smoke-backends: what it runs", () => {
  it("reads providers and models from the command line, model ids with colons included", () => {
    const a = parseArgs(["deepseek", "openrouter:google/gemma-4-31b-it:free", "--json", "--engines=codex", "--no-efforts"]);
    assert.deepEqual(a.targets, [{ provider: "deepseek", model: null }, { provider: "openrouter", model: "google/gemma-4-31b-it:free" }]);
    assert.equal(a.json, true);
    assert.deepEqual(a.engines, ["codex"]);
    assert.equal(a.efforts, false);
    assert.throws(() => parseArgs(["gemini"]), /gemini/);
    assert.throws(() => parseArgs(["--nope"]), /--nope/);
  });

  it("runs every provider whose credential is in the environment, and only those", () => {
    const runs = planRuns({ targets: [], env: { DEEPSEEK_API_KEY: KEYS.DEEPSEEK_API_KEY, OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY, PATH: "/usr/bin" } });
    assert.deepEqual(runs.map((r) => [r.provider, r.credential]), [["openrouter", "env:OPENROUTER_API_KEY"], ["deepseek", "env:DEEPSEEK_API_KEY"]]);
    assert.ok(!JSON.stringify(runs).includes(KEYS.DEEPSEEK_API_KEY));
  });

  it("picks each provider's default model, never a hard-coded ChatGPT one", () => {
    const runs = planRuns({ targets: [{ provider: "deepseek", model: null }, { provider: "chatgpt", model: null }, { provider: "openrouter", model: null }], env: { DEEPSEEK_API_KEY: "x", OPENROUTER_API_KEY: "y" } });
    assert.equal(runs.find((r) => r.provider === "deepseek").model, "deepseek-flash");
    assert.equal(runs.find((r) => r.provider === "openrouter").model, "~anthropic/claude-sonnet-latest");
    assert.equal(runs.find((r) => r.provider === "chatgpt").model, null);
    assert.equal(runs.find((r) => r.provider === "chatgpt").credential, "sign-in");
  });

  it("names a provider it was asked for but has no credential for, instead of running it", () => {
    const runs = planRuns({ targets: [{ provider: "openai", model: null }, { provider: "local", model: "llama3.1:8b" }], env: {} });
    assert.match(runs[0].skip, /OPENAI_API_KEY/);
    assert.match(runs[1].skip, /TARSEE_LOCAL_AI_URL/);
  });

  it("runs the Claude plan when its sign-in variable is set, or when asked", () => {
    assert.deepEqual(planRuns({ targets: [], env: { CLAUDE_CODE_OAUTH_TOKEN: "test-canary-oauth" } }).map((r) => r.provider), ["claude"]);
    assert.equal(planRuns({ targets: [{ provider: "claude", model: null }], env: {} })[0].credential, "sign-in");
  });
});

describe("smoke-backends: the output", () => {
  it("prints one row per provider and never a key, even one an error message carries", async () => {
    const io = capture();
    const calls = [];
    const env = { ...KEYS };
    const code = await main({ argv: [], env, verify: fakeVerify({ fail: { openrouter: KEYS.OPENROUTER_API_KEY }, calls }), ...io });
    assert.equal(code, 1, "one provider failed");
    const all = io.out.stdout + io.out.stderr;
    for (const key of Object.values(KEYS)) assert.ok(!all.includes(key), `a key leaked: ${key.slice(0, 8)}...`);
    for (const id of ["anthropic", "openai", "openrouter", "deepseek"]) assert.match(io.out.stdout, new RegExp(`\\b${id}\\b`));
    assert.doesNotMatch(io.out.stdout, /\bchatgpt\b/);
    assert.match(io.out.stdout, /FAIL/);
    assert.match(io.out.stdout, /low,high/);
    // The probe runs without recording anything.
    assert.ok(calls.every((c) => c.deps.record === false));
  });

  it("prints JSON for the shipped verified list with --json, still without keys", async () => {
    const io = capture();
    const code = await main({ argv: ["deepseek", "openrouter:z-ai/glm-5.3", "--json"], env: { ...KEYS }, verify: fakeVerify({ fail: { deepseek: KEYS.DEEPSEEK_API_KEY } }), ...io });
    assert.equal(code, 1);
    const rows = JSON.parse(io.out.stdout);
    assert.deepEqual(rows.map((r) => [r.provider, r.model, r.ok]), [["deepseek", "deepseek-flash", false], ["openrouter", "z-ai/glm-5.3", true]]);
    assert.deepEqual(rows[1].checks, { reply: true, tool: true, shell: true, resume: true });
    assert.equal(rows[1].engineVersion, "2.1.319");
    assert.ok(!io.out.stdout.includes(KEYS.DEEPSEEK_API_KEY));
    assert.ok(!io.out.stderr.includes(KEYS.DEEPSEEK_API_KEY));
  });

  it("passes the engine order and the no-efforts switch through to the probe", async () => {
    const calls = [];
    await main({ argv: ["deepseek", "--engines=codex", "--no-efforts"], env: { ...KEYS }, verify: fakeVerify({ calls }), ...capture() });
    assert.deepEqual(calls[0].deps.engines, ["codex"]);
    assert.deepEqual(calls[0].deps.efforts, []);
  });

  it("exits 0 when everything passed, and 2 with the variable names when there is nothing to run", async () => {
    assert.equal(await main({ argv: ["deepseek"], env: { ...KEYS }, verify: fakeVerify(), ...capture() }), 0);
    const io = capture();
    assert.equal(await main({ argv: [], env: { PATH: "/usr/bin" }, verify: fakeVerify(), ...io }), 2);
    assert.match(io.out.stderr, /DEEPSEEK_API_KEY/);
    assert.match(io.out.stderr, /OPENROUTER_API_KEY/);
  });
});
