// Verify (src/ai/verify-model.js), design 4.11 "Verify", decision 2 and Phase 4.
// Before a model with no tested path can be picked, the owner runs Verify on their own key: four turns through the
// engine-neutral turn layer (runTurn), each on the engine being tried:
//   1. a plain reply (it must say a code word it was given)
//   2. a call to Tarsee's tarsee_datetime tool (a real tool_use and its result)
//   3. a shell command (a real Bash call whose output carries a marker)
//   4. a resumed turn that recalls the code word from turn 1 (only the session can carry it)
// Engines are tried in order (Claude Code first, then Codex), the first to pass is recorded with the effort levels
// that worked: ai.<id>.verified = { model: { engine, at, engineVersion, checks, efforts } }.
// The runner here is a fake engine with real per-session memory, so the resume check can only pass on a real resume.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliInstalled, envWithoutProxy } from "./fixtures/claude-cli.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-verify-model-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const registry = await import("../src/ai/provider-registry.js");
const catalog = await import("../src/lib/openrouter-catalog.js");
const {
  verifyModel, verifyEngines, estimateVerifyCost, needsRecheck, engineVersion, createVerifyLimiter, VERIFY_STEPS,
} = await import("../src/ai/verify-model.js");
const { EFFORT_IDS } = await import("../src/lib/model-picker.js");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "openrouter-models.json"), "utf8"));
const NOW = Date.UTC(2026, 10, 9, 12, 0);
const VERSIONS = { "claude-code": "2.1.319", codex: "0.167.0" };

let dbn = 0;
const dbs = [];
function freshStore() {
  const db = initDb(path.join(tmp, "data", `verify-${++dbn}.db`));
  dbs.push(db);
  return new SettingsStore(db);
}

/**
 * A fake engine per engine name. `behaviors[engine]`:
 *   reply, tools, shell, resume   what the model does when asked (default all true)
 *   efforts                       the effort levels the provider accepts (others get a 400)
 *   fatal                         { subtype, message, stopReason }: every turn fails this way
 *   routeEngine                   the engine the route event claims (a turn layer that ignores the asked engine)
 *   hang                          never answer (and ignore the stop signal)
 * Sessions remember the code word they were told; a handle from another engine never resumes.
 */
function fakeEngines(behaviors = {}) {
  const sessions = new Map();
  const calls = [];
  let n = 0;
  async function* runner(opts) {
    calls.push(opts);
    const engine = opts.engine;
    const b = { reply: true, tools: true, shell: true, resume: true, efforts: [], ...(behaviors[engine] || {}) };
    if (b.hang) { await new Promise(() => {}); return; }
    yield { type: "route", provider: opts.provider, engine: b.routeEngine ?? engine, model: opts.model, label: "Fake", effort: opts.effort ?? null };
    if (b.backup) yield { type: "route", provider: "anthropic", engine: "claude-code", model: "claude-haiku-5", label: "Claude Haiku", backup: true };
    if (b.fatal) {
      yield { type: "text", content: b.fatal.message };
      yield { type: "error", message: b.fatal.message, ...(b.fatal.subtype ? { subtype: b.fatal.subtype } : {}), ...(b.fatal.code ? { code: b.fatal.code } : {}) };
      yield { type: "done", stopReason: b.fatal.stopReason || "error" };
      return;
    }
    if (opts.effort && !b.efforts.includes(opts.effort)) {
      yield { type: "error", message: `400: reasoning effort "${opts.effort}" is not supported`, subtype: "model" };
      yield { type: "done", stopReason: "error" };
      return;
    }
    const asked = opts.sessionId ?? null;
    let session = asked ? sessions.get(asked) : null;
    if (session && session.engine !== engine) session = null;
    if (!session || !b.resume) {
      const handle = `${opts.provider}/${engine === "codex" ? "cx" : "cc"}/fake:raw-${++n}`;
      session = { engine, handle, word: null };
      sessions.set(handle, session);
    }
    opts.onSessionId?.(session.handle);

    const prompt = String(opts.messages.at(-1).content);
    const id = `tu-${++n}`;
    if (/tarsee_datetime/.test(prompt)) {
      if (b.tools) {
        yield { type: "tool_use", id, name: "mcp__tarsee__tarsee_datetime", input: { format: "date" } };
        yield { type: "tool_result", id, ok: true, result: "Monday, 9 November 2026" };
        yield { type: "text", content: "2026" };
      } else {
        yield { type: "text", content: "I can't use tools, but it is probably 2026." };
      }
    } else if (/\becho\s+(\S+)/.test(prompt)) {
      const marker = /\becho\s+(\S+)/.exec(prompt)[1].replace(/[`'".]+$/, "");
      if (b.shell) {
        yield { type: "tool_use", id, name: "Bash", input: { command: `echo ${marker}` } };
        yield { type: "tool_result", id, ok: true, result: `${marker}\n` };
      }
      // A model that doesn't run it can still repeat the marker from the prompt: that must not pass.
      yield { type: "text", content: marker };
    } else if (/code word I gave you/i.test(prompt)) {
      yield { type: "text", content: session.word ? `The code word was ${session.word}.` : "I don't know of any code word." };
    } else {
      const m = /code word[^:]*:\s*([A-Za-z0-9-]+)/i.exec(prompt);
      if (m) session.word = m[1];
      yield { type: "text", content: b.reply && m ? m[1] : "Hello there!" };
    }
    yield { type: "usage", usage: { input_tokens: 1200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    yield { type: "done", stopReason: "end_turn" };
  }
  return { runner, calls, sessions };
}

function baseDeps(extra = {}) {
  return {
    stateDir: tmp,
    limiter: null,
    engineVersion: (e) => VERSIONS[e],
    now: () => new Date(NOW),
    ...extra,
  };
}

const stepOf = (steps, step) => steps.find((c) => c.step === step);

beforeEach(() => {
  catalog.__resetForTests();
  registry.setCatalogModels("openrouter", []);
});

after(() => {
  for (const db of dbs) try { db.close(); } catch { /* closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("verifyModel: the four checks", () => {
  it("has the four steps in order", () => {
    assert.deepEqual(VERIFY_STEPS, ["reply", "tool", "shell", "resume"]);
  });

  it("passes DeepSeek on Claude Code and records the engine, its version, the checks and the efforts that worked", async () => {
    const store = freshStore();
    const fake = fakeEngines({ "claude-code": { efforts: ["low", "max"] } });
    const r = await verifyModel("deepseek", "deepseek-v4-pro[1m]", baseDeps({ runner: fake.runner, store }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.provider, "deepseek");
    assert.equal(r.model, "deepseek-v4-pro");
    assert.equal(r.engine, "claude-code");
    assert.deepEqual(r.checks, { reply: true, tool: true, shell: true, resume: true });
    assert.deepEqual(r.steps.map((c) => c.step), ["reply", "tool", "shell", "resume"]);
    assert.ok(r.steps.every((c) => c.ok === true && typeof c.ms === "number"));
    assert.equal(r.engineVersion, "2.1.319");
    // DeepSeek lists low, high and max; the provider took two of them.
    assert.deepEqual(r.efforts, ["low", "max"]);
    assert.equal(r.attempts.length, 1);
    assert.equal(r.recorded, true);
    assert.match(r.message, /DeepSeek Pro/);

    const saved = store.get("ai.deepseek.verified");
    assert.deepEqual(saved["deepseek-v4-pro"], {
      engine: "claude-code", at: new Date(NOW).toISOString(), engineVersion: "2.1.319",
      checks: { reply: true, tool: true, shell: true, resume: true }, efforts: ["low", "max"],
    });
    assert.equal(registry.engineFor("deepseek", "deepseek-v4-pro", store), "claude-code");
    assert.deepEqual(registry.effortsFor("deepseek", "deepseek-v4-pro", store), ["low", "max"]);
    assert.ok(fake.calls.every((c) => c.engine === "claude-code"), "Codex is not tried once Claude Code passed");
  });

  it("falls to Codex when Claude Code fails the tool step, and records Codex", async () => {
    catalog.__setModelsForTests(catalog.parseOpenRouterModels(FIXTURE, { now: NOW }));
    const store = freshStore();
    const fake = fakeEngines({ "claude-code": { tools: false }, codex: { efforts: ["low", "high"] } });
    const r = await verifyModel("openrouter", "qwen/qwen3.8-flash", baseDeps({ runner: fake.runner, store }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.engine, "codex");
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0].engine, "claude-code");
    assert.equal(r.attempts[0].ok, false);
    assert.deepEqual(r.attempts[0].checks, { reply: true, tool: false, shell: null, resume: null });
    assert.match(stepOf(r.attempts[0].steps, "tool").detail, /tools/i);
    assert.match(stepOf(r.attempts[0].steps, "shell").detail, /earlier check/i);
    assert.equal(r.attempts[1].engine, "codex");
    assert.deepEqual(r.checks, { reply: true, tool: true, shell: true, resume: true });
    assert.equal(r.engineVersion, "0.167.0");
    // The catalog's levels for it are low, medium and high; the provider took low and high on Codex.
    assert.deepEqual(r.efforts, ["low", "high"]);

    const saved = store.get("ai.openrouter.verified")["qwen/qwen3.8-flash"];
    assert.equal(saved.engine, "codex");
    assert.equal(saved.engineVersion, "0.167.0");
    assert.deepEqual(saved.efforts, ["low", "high"]);
    assert.equal(registry.engineFor("openrouter", "qwen/qwen3.8-flash", store), "codex");

    // Codex started on a fresh session: never Claude Code's.
    const firstCodex = fake.calls.find((c) => c.engine === "codex");
    assert.equal(firstCodex.sessionId ?? null, null);
  });

  it("fails a model that only repeats the shell marker without running the command", async () => {
    const store = freshStore();
    const fake = fakeEngines({ "claude-code": { shell: false }, codex: { shell: false } });
    const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "failed");
    assert.deepEqual(r.attempts.map((a) => a.engine), ["claude-code", "codex"]);
    assert.deepEqual(r.checks, { reply: true, tool: true, shell: false, resume: null });
    assert.equal(r.engineVersion, null);
    assert.match(r.error, /command/i);
    assert.equal(r.recorded, false);
    assert.equal(store.get("ai.deepseek.verified"), null);
  });

  it("needs a real resumed session to pass the last check", async () => {
    const fake = fakeEngines({ "claude-code": { resume: false } });
    const r = await verifyModel("anthropic", "claude-sonnet-5", baseDeps({ runner: fake.runner, store: freshStore() }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.checks, { reply: true, tool: true, shell: true, resume: false });
    assert.match(stepOf(r.steps, "resume").detail, /remember/i);
    // The resumed turn asked for the session the earlier turns ran on, and sent only the new message.
    const last = fake.calls.at(-1);
    assert.ok(last.sessionId, "the last check resumes a session");
    assert.equal(last.messages.length, 1);
  });

  it("stops at once on a rejected key: the other engine is not tried", async () => {
    const message = "Your DeepSeek key was rejected. Update it in Settings > AI or the Railway variable DEEPSEEK_API_KEY.";
    const fake = fakeEngines({ "claude-code": { fatal: { subtype: "auth", message, stopReason: "auth-expired" } } });
    const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store: freshStore() }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "auth");
    assert.equal(r.error, message);
    assert.equal(r.attempts.length, 1);
    assert.ok(fake.calls.every((c) => c.engine === "claude-code"));
    assert.equal(fake.calls.length, 1, "nothing more is spent after the first refusal");
  });

  it("reads the engine's own error kind too (an empty balance, an expired sign-in) and stops there", async () => {
    for (const [code, expected] of [["billing", "billing"], ["expired", "expired"], ["wrong-key", "wrong-key"]]) {
      const fake = fakeEngines({ "claude-code": { fatal: { code, message: `stopped: ${code}` } } });
      const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store: freshStore() }));
      assert.equal(r.code, expected, code);
      assert.equal(fake.calls.length, 1, code);
    }
    // A model the provider doesn't have on this engine is worth trying on the next one.
    const fake = fakeEngines({ "claude-code": { fatal: { code: "model", subtype: "error", message: "unknown model" } } });
    const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store: freshStore(), efforts: [] }));
    assert.equal(r.ok, true);
    assert.equal(r.engine, "codex");
  });

  it("stops when the turn layer refuses an unverified model or runs another engine than asked", async () => {
    const refused = fakeEngines({ "claude-code": { fatal: { subtype: "needs-verification", message: "This model hasn't been verified yet." } } });
    const a = await verifyModel("openrouter", "google/gemini-4-argon", baseDeps({ runner: refused.runner, store: freshStore() }));
    assert.equal(a.ok, false);
    assert.equal(a.code, "needs-verification");
    assert.equal(a.attempts.length, 1);

    const backedUp = fakeEngines({ "claude-code": { backup: true } });
    const c = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: backedUp.runner, store: freshStore() }));
    assert.equal(c.ok, false, "a pass earned by the backup model is no pass");
    assert.equal(c.code, "engine-not-forced");
    assert.match(c.error, /backup/i);

    const wrong = fakeEngines({ codex: { routeEngine: "claude-code" } });
    const b = await verifyModel("openai", "gpt-6-luna", baseDeps({ runner: wrong.runner, store: freshStore() }));
    assert.equal(b.ok, false);
    assert.equal(b.code, "engine-not-forced");
    assert.equal(wrong.calls.length, 1);
  });

  it("keeps an earlier result when a re-check fails", async () => {
    const store = freshStore();
    const earlier = { engine: "codex", at: "2026-10-01T00:00:00.000Z", engineVersion: "0.160.0", checks: { reply: true, tool: true, shell: true, resume: true }, efforts: [] };
    store.set("ai.openrouter.verified", { "z-ai/glm-5.3": earlier });
    const fake = fakeEngines({ "claude-code": { tools: false }, codex: { tools: false } });
    const r = await verifyModel("openrouter", "z-ai/glm-5.3", baseDeps({ runner: fake.runner, store }));
    assert.equal(r.ok, false);
    assert.deepEqual(store.get("ai.openrouter.verified")["z-ai/glm-5.3"], earlier);
  });

  it("adds to the owner's earlier results instead of replacing them", async () => {
    const store = freshStore();
    store.set("ai.deepseek.verified", { "deepseek-flash": { engine: "claude-code", at: "2026-10-01T00:00:00.000Z", engineVersion: "2.1.300", efforts: ["low"] } });
    const fake = fakeEngines({ "claude-code": { efforts: ["high"] } });
    await verifyModel("deepseek", "deepseek-v4-pro", baseDeps({ runner: fake.runner, store }));
    assert.deepEqual(Object.keys(store.get("ai.deepseek.verified")).sort(), ["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("records nothing when asked not to (the smoke script)", async () => {
    const store = freshStore();
    const fake = fakeEngines();
    const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store, record: false }));
    assert.equal(r.ok, true);
    assert.equal(r.recorded, false);
    assert.equal(store.get("ai.deepseek.verified"), null);
  });
});

describe("verifyModel: how each turn is asked for", () => {
  it("runs every turn as a verification on the engine being tried, with a short prompt and no conversation", async () => {
    const fake = fakeEngines({ "claude-code": { efforts: ["high"] } });
    const store = freshStore();
    await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store }));
    assert.ok(fake.calls.length >= 4);
    for (const c of fake.calls) {
      assert.equal(c.verify, true);
      assert.equal(c.provider, "deepseek");
      assert.equal(c.model, "deepseek-flash");
      assert.equal(c.engine, "claude-code");
      assert.equal(c.liveDisabled, true);
      assert.equal(c.conversationId, undefined);
      assert.ok(typeof c.systemPrompt === "string" && c.systemPrompt.length > 0 && c.systemPrompt.length < 2000);
      assert.ok(c.maxTurns > 0 && c.maxTurns <= 10);
      assert.ok(c.maxBudgetUsd > 0 && c.maxBudgetUsd <= 1);
      assert.equal(c.messages.length, 1);
      assert.equal(c.messages[0].role, "user");
      assert.ok(c.signal instanceof AbortSignal);
      assert.equal(c.toolCtx.settingsStore, store, "the turn layer reads Settings from toolCtx.settingsStore");
      assert.equal(c.toolCtx.conversationId, undefined);
    }
    // The four checks send no effort; each effort probe sends its own on a fresh session.
    const checks = fake.calls.slice(0, 4);
    assert.ok(checks.every((c) => c.effort == null));
    const probes = fake.calls.slice(4);
    assert.deepEqual(probes.map((c) => c.effort), ["low", "high", "max"]);
    assert.ok(probes.every((c) => (c.sessionId ?? null) === null));
  });

  it("runs in a scratch folder under STATE_DIR/verify and removes it afterwards", async () => {
    const fake = fakeEngines();
    await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store: freshStore() }));
    const cwd = fake.calls[0].cwd;
    assert.ok(cwd.startsWith(path.join(tmp, "verify") + path.sep), cwd);
    assert.equal(fs.existsSync(cwd), false);
  });

  it("gives up on a turn that never answers and says so", async () => {
    const fake = fakeEngines({ "claude-code": { hang: true }, codex: { hang: true } });
    const started = Date.now();
    const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store: freshStore(), stepTimeoutMs: 40 }));
    assert.ok(Date.now() - started < 5000);
    assert.equal(r.ok, false);
    assert.match(r.steps[0].detail, /too long/i);
  });

  it("stops when the owner cancels", async () => {
    const ctrl = new AbortController();
    const fake = fakeEngines();
    const runner = async function* (opts) {
      if (fake.calls.length === 1) ctrl.abort();
      yield* fake.runner(opts);
    };
    const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner, store: freshStore(), signal: ctrl.signal }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "aborted");
  });

  it("reports each step as it goes", async () => {
    const seen = [];
    const fake = fakeEngines();
    await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, store: freshStore(), efforts: [], onProgress: (p) => seen.push(`${p.engine}:${p.step}:${p.state}`) }));
    assert.deepEqual(seen, [
      "claude-code:reply:running", "claude-code:reply:passed",
      "claude-code:tool:running", "claude-code:tool:passed",
      "claude-code:shell:running", "claude-code:shell:passed",
      "claude-code:resume:running", "claude-code:resume:passed",
    ]);
  });
});

describe("verifyModel: what can be verified, and where", () => {
  it("refuses an unknown AI or a missing model", async () => {
    const fake = fakeEngines();
    assert.equal((await verifyModel("gemini", "x", baseDeps({ runner: fake.runner }))).code, "unknown-provider");
    assert.equal((await verifyModel("deepseek", "  ", baseDeps({ runner: fake.runner }))).code, "no-model");
    assert.equal((await verifyModel("deepseek", "claude-sonnet-5", baseDeps({ runner: fake.runner }))).code, "no-model");
    assert.equal(fake.calls.length, 0);
  });

  it("tries the engines in the design's order", () => {
    catalog.__setModelsForTests([
      ...catalog.parseOpenRouterModels(FIXTURE, { now: NOW }),
      { id: "only/responses", label: "Only Responses", vendor: "only", context: 100000, vision: false, pdf: false, price: null, free: false, reasoning: null, engines: ["codex"], aliasOf: null, retires: null },
    ]);
    assert.deepEqual(verifyEngines("deepseek", "deepseek-flash"), ["claude-code", "codex"]);
    assert.deepEqual(verifyEngines("openrouter", "anthropic/claude-sonnet-5.5"), ["claude-code"]);
    assert.deepEqual(verifyEngines("openrouter", "~anthropic/claude-sonnet-latest"), ["claude-code"]);
    assert.deepEqual(verifyEngines("openrouter", "openai/gpt-6.1-sol"), ["codex"]);
    assert.deepEqual(verifyEngines("openrouter", "google/gemini-4-argon"), ["claude-code", "codex"]);
    assert.deepEqual(verifyEngines("openrouter", "only/responses"), ["codex"]);
    assert.deepEqual(verifyEngines("openrouter", "not/listed-yet"), ["claude-code", "codex"]);
    assert.deepEqual(verifyEngines("openai", "gpt-6-luna"), ["codex"]);
    assert.deepEqual(verifyEngines("local", "llama3.1:8b"), ["codex"]);
    assert.deepEqual(verifyEngines("claude", "sonnet"), ["claude-code"]);
    assert.deepEqual(verifyEngines("deepseek", "deepseek-flash", { engines: ["codex"] }), ["codex"]);
    assert.deepEqual(verifyEngines("nope", "x"), []);
  });
});

describe("verify: limits, cost and re-checks", () => {
  it("runs one check at a time per AI, and a few per hour", async () => {
    let t = 0;
    const limiter = createVerifyLimiter({ max: 2, windowMs: 1000, now: () => t });
    let release;
    const gate = new Promise((r) => { release = r; });
    const fake = fakeEngines();
    const slow = async function* (opts) { await gate; yield* fake.runner(opts); };
    const first = verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: slow, limiter, store: freshStore(), efforts: [] }));
    const busy = await verifyModel("deepseek", "deepseek-v4-pro", baseDeps({ runner: fake.runner, limiter, store: freshStore() }));
    assert.equal(busy.code, "busy");
    // Another AI isn't held up.
    const other = await verifyModel("openai", "gpt-6-luna", baseDeps({ runner: fake.runner, limiter, store: freshStore(), efforts: [] }));
    assert.equal(other.ok, true);
    release();
    assert.equal((await first).ok, true);
    assert.equal((await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, limiter, store: freshStore(), efforts: [] }))).ok, true);
    const third = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, limiter, store: freshStore(), efforts: [] }));
    assert.equal(third.code, "rate-limited");
    t = 1001;
    assert.equal((await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: fake.runner, limiter, store: freshStore(), efforts: [] }))).ok, true);
  });

  it("estimates the cost before it runs: a few cents on a cheap model, nothing on a plan", () => {
    const at = new Date(Date.UTC(2026, 10, 9, 2));
    const ds = estimateVerifyCost("deepseek", "deepseek-flash", { at });
    assert.ok(ds.usd > 0 && ds.usd < 0.25, String(ds.usd));
    assert.match(ds.label, /^about \$\d+\.\d+ \(est\.\)$/);
    assert.equal(ds.turns, 4 + 3);
    assert.deepEqual(estimateVerifyCost("claude", "sonnet"), { usd: null, turns: 4 + EFFORT_IDS.length, label: "Included in plan" });
    assert.equal(estimateVerifyCost("chatgpt", null).label, "Included in plan");
    assert.equal(estimateVerifyCost("local", "llama3.1:8b").usd, 0);
    catalog.__setModelsForTests(catalog.parseOpenRouterModels(FIXTURE, { now: NOW }));
    const sonnet = estimateVerifyCost("openrouter", "~anthropic/claude-sonnet-latest", { at });
    assert.ok(sonnet.usd > ds.usd);
    assert.equal(estimateVerifyCost("openrouter", "not/listed").usd, null);
    assert.equal(estimateVerifyCost("openrouter", "not/listed").label, "Cost unknown");
  });

  it("knows the installed engine versions and when a result needs a re-check", () => {
    assert.match(engineVersion("claude-code"), /^\d+\.\d+\.\d+/);
    assert.match(engineVersion("codex"), /^\d+\.\d+\.\d+/);
    assert.equal(engineVersion("gemini-cli"), null);
    const deps = { engineVersion: (e) => VERSIONS[e] };
    assert.equal(needsRecheck({ engine: "codex", engineVersion: "0.160.0" }, deps), true);
    assert.equal(needsRecheck({ engine: "codex", engineVersion: "0.167.0" }, deps), false);
    assert.equal(needsRecheck({ engine: "codex" }, deps), false);
    assert.equal(needsRecheck(null, deps), false);
  });
});

// The same probe through the REAL Claude Code engine (src/ai/providers/claude-code.js run(), the bundled CLI) against
// a loopback Anthropic Messages server (test/fixtures/fake-anthropic.js) standing in for DeepSeek's /anthropic
// endpoint. The fake "model" calls Tarsee's tool and Bash when asked, and answers the resume question only from the
// conversation history the CLI sends it, so the resume check passes only on a real resumed session.
describe("verifyModel: on the real Claude Code engine against a fake gateway", { skip: cliInstalled() ? false : "the Agent SDK's bundled Claude Code CLI isn't installed here" }, () => {
  const KEY = "sk-testcanarydeepseek0001verifycli";
  let fake;
  let run;
  let fakeAnthropic;

  before(async () => {
    fakeAnthropic = await import("./fixtures/fake-anthropic.js");
    ({ run } = await import("../src/ai/providers/claude-code.js"));
    fake = await fakeAnthropic.startFakeAnthropic();
  });
  after(() => fake?.close());

  const strip = (t) => String(t || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const blocksText = (blocks) => (Array.isArray(blocks) ? blocks : []).filter((b) => b?.type === "text").map((b) => strip(b.text)).join("\n");
  const historyText = (body) => (body.messages || []).map((m) => (typeof m.content === "string" ? strip(m.content) : blocksText(m.content))).join("\n");

  /** A model that does what it is asked (or, with tools: false, never calls a tool). */
  function model({ tools = true } = {}) {
    return (req) => {
      const body = req.body || {};
      if (fakeAnthropic.hasToolResult(body)) {
        const tr = fakeAnthropic.lastUserBlocks(body).find((b) => b.type === "tool_result");
        const out = typeof tr.content === "string" ? tr.content : (tr.content || []).map((c) => c.text || "").join("");
        return { text: out.trim().split(/\s+/).at(-1) || "done" };
      }
      const last = blocksText(fakeAnthropic.lastUserBlocks(body));
      if (/tarsee_datetime/.test(last)) {
        return tools ? { toolUse: { name: "mcp__tarsee__tarsee_datetime", input: { format: "date" } } } : { text: "I would rather not use tools." };
      }
      const echo = /\becho\s+(\S+)/.exec(last);
      if (echo) return tools ? { toolUse: { name: "Bash", input: { command: `echo ${echo[1]}`, description: "Print the marker" } } } : { text: echo[1] };
      if (/code word I gave you/i.test(last)) {
        const m = /code word for later:\s*([A-Za-z0-9-]+)/.exec(historyText(body));
        return { text: m ? m[1] : "I don't know of any code word." };
      }
      const w = /code word[^:]*:\s*([A-Za-z0-9-]+)/i.exec(last);
      return { text: w ? w[1] : "ok" };
    };
  }

  /**
   * verify's runner opts -> the engine's run(), aimed at the fake through the test-only base-URL seam. This machine's
   * environment minus any proxy: engine-env passes proxy settings on, and a proxy can't reach this loopback fake.
   */
  function engineRunner({ keepSession = true } = {}) {
    const env = { ...envWithoutProxy(process.env), NODE_ENV: "test", TARSEE_TEST_BASE_URL_DEEPSEEK: `${fake.url}/anthropic` };
    return (opts) => run({
      target: { provider: opts.provider, model: opts.model, engine: opts.engine, effort: opts.effort },
      messages: opts.messages,
      systemPrompt: opts.systemPrompt,
      signal: opts.signal,
      toolCtx: {},
      sessionHandle: keepSession ? opts.sessionHandle : null,
      onSessionHandle: opts.onSessionHandle,
      maxTurns: opts.maxTurns,
      deps: { env, key: KEY, cwd: opts.cwd, stateDir: tmp, homeDir: tmp },
    });
  }

  it("passes DeepSeek on Claude Code: a real tool call, a real shell command and a real resumed session", { timeout: 120_000 }, async () => {
    fake.requests.length = 0;
    fake.script = model();
    const store = freshStore();
    const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: engineRunner(), store, engines: ["claude-code"], efforts: ["high"] }));
    assert.equal(r.ok, true, `${r.code}: ${r.error}`);
    assert.equal(r.engine, "claude-code");
    assert.deepEqual(r.checks, { reply: true, tool: true, shell: true, resume: true });
    assert.deepEqual(r.efforts, ["high"]);
    assert.equal(store.get("ai.deepseek.verified")["deepseek-flash"].engine, "claude-code");
    const calls = fake.messages();
    // reply, tool (call + answer), shell (call + answer), resume, one effort probe
    assert.ok(calls.length >= 7, `${calls.length} model calls`);
    for (const c of calls) {
      assert.equal(c.headers.authorization, `Bearer ${KEY}`);
      assert.match(String(c.body?.model), /^deepseek-flash/);
    }
  });

  it("a real resume is needed: a session that isn't picked up again fails the last check", { timeout: 120_000 }, async () => {
    fake.script = model();
    const r = await verifyModel("deepseek", "deepseek-flash", baseDeps({ runner: engineRunner({ keepSession: false }), store: freshStore(), engines: ["claude-code"], efforts: [] }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.checks, { reply: true, tool: true, shell: true, resume: false });
  });

  it("falls to Codex when the model won't call Tarsee's tool on Claude Code", { timeout: 120_000 }, async () => {
    fake.script = model({ tools: false });
    const codex = fakeEngines({ codex: { efforts: ["low", "high"] } });
    const real = engineRunner();
    const runner = (opts) => (opts.engine === "codex" ? codex.runner(opts) : real(opts));
    const store = freshStore();
    const r = await verifyModel("deepseek", "deepseek-v4-pro", baseDeps({ runner, store }));
    assert.equal(r.ok, true, `${r.code}: ${r.error}`);
    assert.equal(r.engine, "codex");
    assert.deepEqual(r.attempts[0].checks, { reply: true, tool: false, shell: null, resume: null });
    assert.deepEqual(r.efforts, ["low", "high"]);
    assert.deepEqual(store.get("ai.deepseek.verified")["deepseek-v4-pro"].efforts, ["low", "high"]);
    assert.equal(registry.engineFor("deepseek", "deepseek-v4-pro", store), "codex");
  });
});
