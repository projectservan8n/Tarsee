/**
 * verify-model.js: the one-click Verify for a model with no tested path yet (design 4.11, decision 2).
 *
 * A picker lists a model only once a tool-using test turn has passed on its engine. For a model Tarsee doesn't ship as
 * verified (an OpenRouter model from a maker other than Anthropic or OpenAI, a DeepSeek model on another engine, a
 * Local AI model), the owner runs this on their own key. It runs four turns through the engine-neutral turn layer
 * (turn.js runTurn, injectable as deps.runner), on one engine at a time:
 *
 *   1. reply    a plain reply that must carry a code word it was given
 *   2. tool     a call to Tarsee's tarsee_datetime tool: a real tool_use and its successful result
 *   3. shell    a shell command whose output (a marker) must come back in the command's own result, so a model that
 *               only repeats the marker from the prompt doesn't pass
 *   4. resume   a second turn on the same session, sending only the new question, that must recall the code word
 *
 * Engines are tried in order: Claude Code first, then Codex (verifyEngines). A rejected key, an empty balance or a turn
 * the turn layer refuses stops at once: another engine wouldn't change it and would only spend more. The first engine
 * to pass is recorded with the effort levels that worked (each candidate level is tried on one short reply) in
 * ai.<id>.verified = { <model>: { engine, at, engineVersion, checks, efforts } }, which the registry reads (engineFor,
 * effortsFor). A failed re-check leaves an earlier result alone.
 *
 * The turns run in a scratch folder under STATE_DIR/verify/, removed afterwards. The run is single-flight per provider
 * and limited per hour (createVerifyLimiter). estimateVerifyCost() gives the cost to show before it starts.
 * scripts/smoke-backends.mjs runs the same probe per provider (with record: false).
 *
 * What it asks of the turn layer (each runner call): { provider, model, engine, effort, verify: true, messages,
 * systemPrompt, sessionId, sessionHandle, onSessionId, onSessionHandle, cwd, signal, maxTurns, maxBudgetUsd, toolCtx,
 * store, liveDisabled: true }. verify: true means: run on `engine` as given (one the provider runs on), don't refuse the
 * model as unverified, pass `effort` through unclamped, and add no handoff (only the session carries context).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getProvider, modelsFor, priceFor } from "./provider-registry.js";
import { catalogEnginesFor, catalogModel } from "../lib/openrouter-catalog.js";
import { EFFORT_IDS } from "../lib/model-picker.js";

export const VERIFY_STEPS = Object.freeze(["reply", "tool", "shell", "resume"]);

const CLAUDE_CODE = "claude-code";
const CODEX = "codex";

const VERIFY_SYSTEM_PROMPT = "You are being checked by Tarsee, an assistant app, to see whether you can work as its assistant. "
  + "Follow each instruction exactly, use a tool when you are asked to, and keep every reply short.";

/** Per turn: a small tool loop is all any check needs, and a ceiling well above what one check costs. */
const MAX_TURNS = 6;
const MAX_BUDGET_USD = 0.5;
const STEP_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Problems with the account or the turn layer, not the engine: trying another engine wouldn't help. The turn layer's
 * refusals (subtype) and the engines' error kinds (code, engine-errors.js); "model" and "session" are not here: a model
 * one engine's endpoint doesn't have may still run on the other.
 */
const STOP_CODES = new Set([
  "auth", "expired", "wrong-key", "billing", "rate", "unavailable", "not-ready", "blocked-keys-only", "spend-cap",
  "needs-key", "needs-setup", "needs-sign-in", "sign-in-expired", "credential-isolation", "bad-key", "bad-model",
  "needs-verification", "not-supported",
]);

/** Providers that never take a claude-* model id. */
const NO_CLAUDE_IDS = new Set(["deepseek", "chatgpt", "openai", "local"]);

const DETAIL = {
  reply: "It didn't reply with the code word it was given.",
  tool: "It didn't use Tarsee's tools when asked.",
  toolFailed: "It called Tarsee's tool, but the call failed.",
  shell: "It didn't run the shell command when asked.",
  resume: "It didn't remember the earlier message when the conversation was continued.",
  noSession: "It didn't hand back a session to continue, so the conversation couldn't be picked up again.",
  skipped: "Not run: an earlier check failed.",
};

// --- Which engines, which efforts ---

/**
 * The engines to try a model on, in order:
 *   claude, anthropic          Claude Code
 *   chatgpt, openai, local     Codex
 *   deepseek                   Claude Code (DeepSeek documents it), then Codex
 *   openrouter                 anthropic/* on Claude Code, openai/* on Codex; any other maker Claude Code then Codex,
 *                              leaving out an engine whose endpoint OpenRouter says the model doesn't have
 * opts.engines narrows (and orders) the list.
 */
export function verifyEngines(providerId, model, { engines } = {}) {
  const p = getProvider(providerId);
  if (!p) return [];
  const id = bareModel(model);
  let list = [...p.engines];
  if (p.id === "openrouter") {
    const maker = makerOf(id);
    if (maker === "anthropic") list = [CLAUDE_CODE];
    else if (maker === "openai") list = [CODEX];
    else {
      const allowed = catalogEnginesFor(id);
      if (allowed) list = list.filter((e) => allowed.includes(e));
    }
  }
  if (Array.isArray(engines)) return engines.filter((e, i) => list.includes(e) && engines.indexOf(e) === i);
  return list;
}

/** The effort levels worth trying on a model (Tarsee's ids, lowest first). */
function candidateEfforts(p, id, deps = {}) {
  if (Array.isArray(deps.efforts)) return EFFORT_IDS.filter((e) => deps.efforts.includes(e));
  if (p.catalog === "claude") return [...EFFORT_IDS];
  if (p.id === "openrouter") {
    if (makerOf(id) === "anthropic") return [...EFFORT_IDS];
    const row = catalogModel(id);
    return row?.reasoning ? EFFORT_IDS.filter((e) => row.reasoning.efforts.includes(e)) : [];
  }
  const row = modelsFor(p.id).find((m) => m.id === id);
  return Array.isArray(row?.efforts) ? EFFORT_IDS.filter((e) => row.efforts.includes(e)) : [];
}

// --- Engine versions ---

const require = createRequire(import.meta.url);
const versionCache = new Map();

/** The installed engine's version: Claude Code's bundled CLI (the Agent SDK's claudeCodeVersion) or the Codex binary. */
export function engineVersion(engine) {
  if (versionCache.has(engine)) return versionCache.get(engine);
  let v = null;
  try {
    if (engine === CLAUDE_CODE) {
      const pkg = packageJsonOf("@anthropic-ai/claude-agent-sdk");
      v = pkg?.claudeCodeVersion || pkg?.version || null;
    } else if (engine === CODEX) {
      try { v = require("@openai/codex/package.json").version || null; } catch { v = packageJsonOf("@openai/codex-sdk")?.version || null; }
    }
  } catch { v = null; }
  versionCache.set(engine, v);
  return v;
}

/** A package's package.json, found by walking up from its entry point (the packages don't export the file). */
function packageJsonOf(name) {
  let dir = path.dirname(fileURLToPath(import.meta.resolve(name)));
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      if (json.name === name) return json;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Whether a verified result was made on another version of its engine than the one installed now ("re-check" hint). */
export function needsRecheck(entry, { engineVersion: versionOf = engineVersion } = {}) {
  if (!entry || typeof entry !== "object" || !entry.engine || !entry.engineVersion) return false;
  const now = versionOf(entry.engine);
  return !!now && now !== entry.engineVersion;
}

// --- Cost and limits ---

/** Roughly what one check turn sends: the engine's own instructions and tool list dominate it. */
const TURN_INPUT_TOKENS = 20_000;
const TURN_FRESH_TOKENS = 2_000;
const TURN_OUTPUT_TOKENS = 300;

/**
 * What a Verify run is likely to cost, to show before it starts: { usd, turns, label }. usd is null on a plan
 * ("Included in plan") or when the model's price is unknown. The model calls are: the reply and resume checks one
 * each, the tool and shell checks two each (the call and the answer), and one per effort level tried, each on a fresh
 * session. A session's first call writes the cache; later calls mostly read it.
 */
export function estimateVerifyCost(providerId, model, { at = new Date(), store = null, efforts } = {}) {
  const p = getProvider(providerId);
  if (!p) return { usd: null, turns: 0, label: "Cost unknown" };
  const id = bareModel(model);
  const probes = candidateEfforts(p, id, { efforts }).length;
  const turns = VERIFY_STEPS.length + probes;
  if (p.kind === "subscription") return { usd: null, turns, label: "Included in plan" };
  const price = id ? priceFor(p.id, id, at, store) : null;
  if (!price) return { usd: null, turns, label: "Cost unknown" };
  const calls = 6 + probes;
  const sessions = 1 + probes;
  const perMillion = (tokens, rate) => (tokens * rate) / 1_000_000;
  const usd = perMillion(sessions * TURN_INPUT_TOKENS, price.cacheWrite)
    + (calls - sessions) * (perMillion(TURN_INPUT_TOKENS - TURN_FRESH_TOKENS, price.cacheRead) + perMillion(TURN_FRESH_TOKENS, price.in))
    + perMillion(calls * TURN_OUTPUT_TOKENS, price.out);
  const rounded = Math.round(usd * 10_000) / 10_000;
  let label;
  if (rounded === 0) label = "Free";
  else if (rounded < 0.005) label = "less than $0.01 (est.)";
  else label = `about $${rounded.toFixed(2)} (est.)`;
  return { usd: rounded, turns, label };
}

/**
 * One check at a time per provider, and at most `max` started per `windowMs` (default 6 an hour): a check spends real
 * money on the owner's key. acquire(id) gives { ok: true, release() } or { ok: false, code: "busy"|"rate-limited", error }.
 */
export function createVerifyLimiter({ max = 6, windowMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const running = new Set();
  const started = new Map();
  return {
    acquire(id, label = id) {
      if (running.has(id)) return { ok: false, code: "busy", error: `A check of ${label} is already running. Wait for it to finish.` };
      const t = now();
      const recent = (started.get(id) || []).filter((s) => t - s < windowMs);
      if (recent.length >= max) {
        const mins = Math.max(1, Math.ceil((windowMs - (t - recent[0])) / 60_000));
        return { ok: false, code: "rate-limited", error: `${label} has been checked ${recent.length} times recently. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.` };
      }
      recent.push(t);
      started.set(id, recent);
      running.add(id);
      let released = false;
      return { ok: true, release() { if (!released) { released = true; running.delete(id); } } };
    },
  };
}

const defaultLimiter = createVerifyLimiter();

// --- The run ---

/**
 * Verify a model on a provider. deps:
 *   runner       the turn layer (default: turn.js runTurn)
 *   store        SettingsStore: where the result is recorded (and what the registry reads)
 *   record       false to record nothing (default true when a store is given)
 *   stateDir     Tarsee's state folder (default config.STATE_DIR); the scratch folder goes under <stateDir>/verify/
 *   engines      narrow or order the engines tried
 *   efforts      the effort levels to try (default: what the model lists)
 *   toolCtx      the tool context handed to the turns (no conversation)
 *   signal       cancels the run
 *   stepTimeoutMs  per turn (default 3 minutes)
 *   onProgress   ({ engine, step, state: "running"|"passed"|"failed", detail?, effort? }) as it goes
 *   limiter      createVerifyLimiter() instance; null for none (default: 6 an hour per provider)
 *   now, engineVersion   for tests
 * Returns { ok, provider, model, engine, engineVersion, checks, steps, efforts, attempts, recorded, entry, message,
 * code?, error? }:
 *   checks     { reply, tool, shell, resume }: true passed, false failed, null not run (the engine that passed, else
 *              the last one tried). The same shape is recorded in ai.<id>.verified.
 *   steps      [{ step, ok, ms, detail? }]: the same checks with timings and, for a failed or skipped one, why
 *   attempts   [{ engine, ok, checks, steps, code?, error? }]: every engine tried, in order
 *   entry      what was (or would have been) recorded: { engine, at, engineVersion, checks, efforts }; null on failure
 * On failure `error` is the plain-language reason and `code` one of: unknown-provider, no-model, no-engine, busy,
 * rate-limited, not-available, aborted, failed, or the account's or turn layer's own (auth, billing, rate, not-ready,
 * needs-verification, engine-not-forced...).
 */
export async function verifyModel(providerId, model, deps = {}) {
  const p = getProvider(providerId);
  if (!p) return refusal(null, model, "unknown-provider", "Tarsee doesn't know that AI.");
  const id = bareModel(model);
  // The ChatGPT plan may be checked on the account's default model (the smoke script); nothing is recorded for it.
  if (!id && p.id !== "chatgpt") return refusal(p.id, id, "no-model", "Choose a model to check first.");
  if (id && NO_CLAUDE_IDS.has(p.id) && /^claude-/i.test(id)) {
    return refusal(p.id, id, "no-model", `${p.label} doesn't serve Claude models; choose one of its own.`);
  }
  const engines = verifyEngines(p.id, id, { engines: deps.engines });
  if (!engines.length) {
    return refusal(p.id, id, "no-engine", `${modelLabel(p, id)} can't run on either of Tarsee's engines: OpenRouter lists no chat endpoint Tarsee speaks for it.`);
  }

  const limiter = deps.limiter === undefined ? defaultLimiter : deps.limiter;
  const slot = limiter ? limiter.acquire(p.id, p.label) : { ok: true, release() {} };
  if (!slot.ok) return refusal(p.id, id, slot.code, slot.error);

  let workspace = null;
  try {
    let runner = deps.runner;
    if (!runner) {
      try { runner = (await import("./turn.js")).runTurn; } catch { runner = null; }
      if (typeof runner !== "function") return refusal(p.id, id, "not-available", "Tarsee's turn layer isn't available, so the check can't run.");
    }
    const stateDir = deps.stateDir || (await import("../config/env.js")).default.STATE_DIR;
    const root = path.join(stateDir, "verify");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    workspace = fs.mkdtempSync(path.join(root, `${p.id}-`));

    const ctx = {
      p, id, runner, deps, workspace,
      label: modelLabel(p, id),
      signal: deps.signal || null,
      stepTimeoutMs: deps.stepTimeoutMs ?? STEP_TIMEOUT_MS,
      progress: typeof deps.onProgress === "function" ? deps.onProgress : () => {},
    };
    const attempts = [];
    for (const engine of engines) {
      const attempt = await runEngine(ctx, engine);
      attempts.push(attempt);
      if (attempt.ok) {
        const efforts = await probeEfforts(ctx, engine, attempt);
        if (ctx.signal?.aborted) return finish(ctx, attempts, { code: "aborted", error: "The check was stopped." });
        return succeed(ctx, engine, attempt, efforts, attempts);
      }
      if (attempt.stop) return finish(ctx, attempts, { code: attempt.code, error: attempt.error });
    }
    const last = attempts.at(-1);
    const why = last.steps.find((c) => c.ok === false)?.detail || last.error || "It didn't pass.";
    return finish(ctx, attempts, { code: "failed", error: `${ctx.label} didn't pass the check. ${why}` });
  } finally {
    slot.release();
    if (workspace && !deps.keepWorkspace) {
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** The four checks on one engine, on one session. Stops at the first that fails. */
async function runEngine(ctx, engine) {
  const cwd = path.join(ctx.workspace, engine);
  fs.mkdirSync(cwd, { recursive: true });
  const word = codeWord("CODE");
  const marker = codeWord("TARSEE-OK");
  let handle = null;
  const steps = [];
  const out = { engine, ok: false, steps, word, handle: null };

  for (const step of VERIFY_STEPS) {
    if (ctx.signal?.aborted) {
      fillSkipped(steps);
      return { ...out, checks: checkMap(steps), stop: true, code: "aborted", error: "The check was stopped." };
    }
    if (step === "resume" && !handle) {
      steps.push({ step, ok: false, ms: 0, detail: DETAIL.noSession });
      ctx.progress({ engine, step, state: "failed", detail: DETAIL.noSession });
      break;
    }
    ctx.progress({ engine, step, state: "running" });
    const prompt = promptFor(step, { word, marker });
    const res = await runTurnOnce(ctx, engine, { prompt, sessionId: step === "reply" ? null : handle, cwd });
    if (res.handle) handle = res.handle;
    const verdict = judge(step, res, { word, marker, engine, provider: ctx.p.id });
    steps.push({ step, ok: verdict.ok, ms: res.ms, ...(verdict.ok ? {} : { detail: verdict.detail }) });
    ctx.progress({ engine, step, state: verdict.ok ? "passed" : "failed", ...(verdict.ok ? {} : { detail: verdict.detail }) });
    if (verdict.stop) {
      fillSkipped(steps);
      return { ...out, checks: checkMap(steps), stop: true, code: verdict.code, error: verdict.detail };
    }
    if (!verdict.ok) break;
  }
  fillSkipped(steps);
  out.handle = handle;
  out.checks = checkMap(steps);
  out.ok = steps.length === VERIFY_STEPS.length && steps.every((c) => c.ok === true);
  return out;
}

/** After the checks pass: each candidate effort level on one short reply, on a fresh session. */
async function probeEfforts(ctx, engine, attempt) {
  const passed = [];
  const cwd = path.join(ctx.workspace, engine);
  for (const effort of candidateEfforts(ctx.p, ctx.id, ctx.deps)) {
    if (ctx.signal?.aborted) break;
    ctx.progress({ engine, step: "effort", effort, state: "running" });
    const word = codeWord("CODE");
    const res = await runTurnOnce(ctx, engine, { prompt: `Reply with this code word and nothing else: ${word}`, sessionId: null, cwd, effort });
    const verdict = judge("reply", res, { word, engine, provider: ctx.p.id });
    ctx.progress({ engine, step: "effort", effort, state: verdict.ok ? "passed" : "failed", ...(verdict.ok ? {} : { detail: verdict.detail }) });
    if (verdict.ok) passed.push(effort);
    else if (verdict.stop) break;
  }
  return passed;
}

function promptFor(step, { word, marker }) {
  switch (step) {
    case "reply":
      return `Remember this code word for later: ${word}. Reply with the code word and nothing else.`;
    case "tool":
      return "Call the tarsee_datetime tool (it is on the tarsee MCP server) to get today's date, then reply with just the year it gives you.";
    case "shell":
      return `Run this exact shell command and reply with its output: echo ${marker}`;
    case "resume":
      return "What was the code word I gave you at the start of this conversation? Reply with just the code word.";
    default:
      throw new Error(`unknown step ${step}`);
  }
}

/** Whether a turn passed its check: { ok, detail?, stop?, code? }. stop means trying another engine is pointless. */
function judge(step, res, { word, marker, engine, provider }) {
  if (res.aborted) return { ok: false, stop: true, code: "aborted", detail: "The check was stopped." };
  if (res.timedOut) return { ok: false, detail: res.timeoutDetail };
  // The turn must run where it was asked to: this provider, this engine. A backup model answering, or the turn layer
  // picking its own engine, would make a pass meaningless.
  const elsewhere = res.routes.find((r) => r.backup || (r.provider && r.provider !== provider) || (r.engine && r.engine !== engine));
  if (elsewhere) {
    const detail = elsewhere.backup || (elsewhere.provider && elsewhere.provider !== provider)
      ? "The backup model answered instead of the model being checked, so the result couldn't be trusted. Try again, or switch the backup model off while you verify."
      : `Tarsee ran the check on another engine than the one being tested (${elsewhere.engine}, not ${engine}), so the result couldn't be trusted.`;
    return { ok: false, stop: true, code: "engine-not-forced", detail };
  }
  const stopCode = (e) => [e.subtype, e.code].find((c) => STOP_CODES.has(c)) || null;
  const stopError = res.errors.find((e) => stopCode(e));
  if (stopError || res.done?.stopReason === "auth-expired") {
    const code = stopError ? stopCode(stopError) : "auth";
    const detail = stopError?.message || res.errors[0]?.message || "The AI turned the request down.";
    return { ok: false, stop: true, code: code === "auth-expired" ? "auth" : code, detail };
  }
  if (res.errors.length) return { ok: false, detail: res.errors[0].message || "The AI answered with an error." };
  if (res.done?.stopReason !== "end_turn") return { ok: false, detail: `The turn ended early (${res.done?.stopReason || "no answer"}).` };

  if (step === "reply") return includesWord(res.text, word) ? { ok: true } : { ok: false, detail: DETAIL.reply };
  if (step === "resume") return includesWord(res.text, word) ? { ok: true } : { ok: false, detail: DETAIL.resume };
  if (step === "tool") {
    const calls = res.toolUses.filter((t) => /(^|__)tarsee_datetime$/.test(String(t.name || "")));
    if (!calls.length) return { ok: false, detail: DETAIL.tool };
    return calls.some((t) => res.toolResults.get(t.id) && res.toolResults.get(t.id).ok !== false) ? { ok: true } : { ok: false, detail: DETAIL.toolFailed };
  }
  if (step === "shell") {
    const runs = res.toolUses.filter((t) => t.name === "Bash");
    const ran = runs.some((t) => {
      const r = res.toolResults.get(t.id);
      return r && r.ok !== false && resultText(r.result).includes(marker);
    });
    return ran ? { ok: true } : { ok: false, detail: DETAIL.shell };
  }
  return { ok: false, detail: "Unknown check." };
}

const STOPPED = Symbol("stopped");

/** One turn through the runner; collects what came back. Never throws, never waits past the step's time. */
async function runTurnOnce(ctx, engine, { prompt, sessionId, cwd, effort }) {
  const started = Date.now();
  const res = { text: "", toolUses: [], toolResults: new Map(), errors: [], done: null, routes: [], handle: null, ms: 0 };
  // A plain timer, not AbortSignal.timeout(): that one doesn't keep the process alive, so a turn that never answers
  // would end a script's run silently instead of timing out.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ctx.stepTimeoutMs);
  const timeout = deadline.signal;
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const remember = (h) => { if (typeof h === "string" && h.trim()) res.handle = h; };
  const opts = {
    provider: ctx.p.id,
    model: ctx.id || undefined,
    engine,
    effort: effort || undefined,
    verify: true,
    messages: [{ role: "user", content: prompt }],
    systemPrompt: VERIFY_SYSTEM_PROMPT,
    sessionId: sessionId || null,
    sessionHandle: sessionId || null,
    onSessionId: remember,
    onSessionHandle: remember,
    cwd,
    signal,
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    toolCtx: toolCtxFor(ctx.deps),
    store: ctx.deps.store || undefined,
    liveDisabled: true,
    thinkingSummaries: false,
  };

  const stopped = new Promise((resolve) => {
    if (signal.aborted) resolve(STOPPED);
    else signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });
  let it = null;
  let early = false;
  try {
    it = ctx.runner(opts)[Symbol.asyncIterator]();
    for (;;) {
      const next = it.next();
      next.catch(() => {});
      const r = await Promise.race([next, stopped]);
      if (r === STOPPED) { early = true; break; }
      if (r.done) break;
      take(res, r.value);
    }
  } catch (err) {
    res.errors.push({ message: `The turn failed: ${err?.message || err}` });
  } finally {
    clearTimeout(timer);
    if (early && it?.return) {
      try { Promise.resolve(it.return()).catch(() => {}); } catch { /* it is gone either way */ }
    }
  }
  res.ms = Date.now() - started;
  if (early || signal.aborted) {
    if (ctx.signal?.aborted) res.aborted = true;
    else if (timeout.aborted) {
      res.timedOut = true;
      const secs = Math.round(ctx.stepTimeoutMs / 1000);
      res.timeoutDetail = secs >= 1 ? `It took too long to answer (over ${secs} seconds).` : "It took too long to answer.";
    }
  }
  return res;
}

/**
 * The tool context for a check turn: the caller's, with the settings store where the turn layer reads it, and never a
 * conversation or message (a check must not touch any chat's session, timeline or files).
 */
function toolCtxFor(deps) {
  const { conversationId: _c, messageId: _m, ...rest } = deps.toolCtx || {};
  const store = rest.settingsStore || deps.store || null;
  return { ...(store ? { settingsStore: store } : {}), ...(rest.db || store?.db ? { db: rest.db || store.db } : {}), ...rest, verify: true };
}

function take(res, ev) {
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "route": res.routes.push(ev); break;
    case "text": res.text += typeof ev.content === "string" ? ev.content : ""; break;
    case "tool_use": res.toolUses.push(ev); break;
    case "tool_result": if (ev.id != null) res.toolResults.set(ev.id, ev); break;
    case "error": res.errors.push(ev); break;
    case "done": res.done = ev; break;
    default: break;
  }
}

function fillSkipped(steps) {
  for (const step of VERIFY_STEPS) {
    if (!steps.some((c) => c.step === step)) steps.push({ step, ok: null, ms: 0, detail: DETAIL.skipped });
  }
}

/** { reply, tool, shell, resume }: true passed, false failed, null not run. The shape recorded in ai.<id>.verified. */
function checkMap(steps) {
  return Object.fromEntries(VERIFY_STEPS.map((step) => [step, steps.find((c) => c.step === step)?.ok ?? null]));
}

function succeed(ctx, engine, attempt, efforts, attempts) {
  const { p, id, deps } = ctx;
  const at = (typeof deps.now === "function" ? deps.now() : new Date());
  const versionOf = typeof deps.engineVersion === "function" ? deps.engineVersion : engineVersion;
  const entry = {
    engine,
    at: (at instanceof Date ? at : new Date(at)).toISOString(),
    engineVersion: versionOf(engine) ?? null,
    checks: Object.fromEntries(VERIFY_STEPS.map((step) => [step, attempt.checks[step] === true])),
    efforts,
  };
  const shouldRecord = !!deps.store && deps.record !== false && !!id;
  let recorded = false;
  if (shouldRecord) recorded = recordVerified(deps.store, p.id, id, entry);
  return {
    ok: true,
    provider: p.id,
    model: id || null,
    engine,
    engineVersion: entry.engineVersion,
    checks: entry.checks,
    steps: attempt.steps,
    efforts,
    attempts: attempts.map(summary),
    recorded,
    entry,
    message: `${ctx.label} passed every check: it replied, used Tarsee's tools, ran a command and remembered the conversation.`,
  };
}

function finish(ctx, attempts, { code, error }) {
  const last = attempts.at(-1);
  return {
    ok: false,
    provider: ctx.p.id,
    model: ctx.id || null,
    engine: null,
    engineVersion: null,
    checks: last ? last.checks : checkMap([]),
    steps: last ? last.steps : [],
    efforts: [],
    attempts: attempts.map(summary),
    recorded: false,
    entry: null,
    code,
    error,
    message: error,
  };
}

function summary(a) {
  return { engine: a.engine, ok: a.ok, checks: a.checks, steps: a.steps, ...(a.code ? { code: a.code } : {}), ...(a.error ? { error: a.error } : {}) };
}

function refusal(provider, model, code, error) {
  return { ok: false, provider, model: bareModel(model) || null, engine: null, engineVersion: null, checks: checkMap([]), steps: [], efforts: [], attempts: [], recorded: false, entry: null, code, error, message: error };
}

/** Add one result to ai.<id>.verified, keeping the owner's other results. Returns whether it was saved. */
export function recordVerified(store, providerId, model, entry) {
  const p = getProvider(providerId);
  const id = bareModel(model);
  if (!p || !id || !store?.set) return false;
  const key = `ai.${p.id}.verified`;
  let current;
  try { current = store.get(key); } catch { current = null; }
  if (typeof current === "string") { try { current = JSON.parse(current); } catch { current = null; } }
  const next = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  next[id] = entry;
  try {
    store.set(key, next);
    return true;
  } catch (err) {
    console.warn(`[verify] couldn't save the result for ${p.id}:${id}: ${err.message}`);
    return false;
  }
}

function modelLabel(p, id) {
  if (!id) return `${p.label}'s default model`;
  if (p.id === "openrouter") return catalogModel(id)?.label || id;
  return modelsFor(p.id).find((m) => m.id === id)?.label || id;
}

/** A word the model can't guess: PREFIX-<6 random hex digits>. */
function codeWord(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function includesWord(text, word) {
  return String(text || "").toUpperCase().includes(String(word).toUpperCase());
}

function resultText(r) {
  if (typeof r === "string") return r;
  try { return JSON.stringify(r ?? ""); } catch { return ""; }
}

function bareModel(model) {
  return typeof model === "string" ? model.trim().replace(/\[1m\]$/i, "") : "";
}

function makerOf(id) {
  const s = String(id || "").replace(/^~/, "");
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i).toLowerCase() : null;
}
