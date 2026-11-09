/**
 * codex.js: the Codex engine (design 4.8). It runs a turn on the ChatGPT plan, an OpenAI key, OpenRouter's openai/*
 * models (and any other OpenRouter model verified on Codex), DeepSeek's alternative engine and Local AI, through the
 * pinned @openai/codex-sdk, which starts the pinned codex binary for each turn (`codex exec --experimental-json`).
 * Codex runs its own tool loop (its shell, apply_patch, and Tarsee's 27 tools over the loopback MCP endpoint,
 * mcp-http.js), so a turn never ends waiting for its caller to run a tool.
 *
 *   run(opts)   an async generator of Tarsee's events (text, thinking, tool_use, tool_result, usage, step, error and
 *               exactly one done), for turn.js runTurn. opts: { target: {provider|providerId, model, effort}, messages,
 *               systemPrompt | systemParts {stable, volatile}, signal, toolCtx, sessionHandle | sessionId,
 *               onSessionHandle | onSessionId, maxTurns, thinkingSummaries, media, mcpGrant {url, token}, turnId, cwd,
 *               deps (tests) }. maxBudgetUsd is never passed to Codex: the turn layer's budget guard applies.
 *
 * Before anything starts:
 *   - the options (providers/codex-options.js): this provider's credential only, hosts from engine-env hostFor(), the
 *     tools' grant (opts.mcpGrant from the turn layer, else one made here and revoked when the turn ends)
 *   - R1: the home exists (mode 0700) and a key home holds no sign-in file; R5's Codex counterpart:
 *     codexConfigGuard() on <home>/config.toml, <home>/.env (refused whatever it holds: Codex loads it into its own
 *     environment) and <workspace>/.codex/config.toml, the only files Codex loads with the project root search off
 *     (project_root_markers=[]). Either refuses the turn; both are checked again right before codex starts.
 *   - the program: TARSEE_CODEX_BIN when set (a program that is there; on Windows not a .cmd launcher, which the SDK
 *     can't start), else the SDK's own pinned binary. A wrong one refuses the turn in plain words.
 *   - resuming: the stored handle resumes only the same provider, home and maker (session-handle.js). A thread whose
 *     instructions changed (session.<conv>.instrHash: Codex keeps a resumed thread's first instructions, checked
 *     against the pinned binary) or whose rollout grew past TARSEE_SESSION_JSONL_MAX_MB is not resumed: the turn
 *     reports a recoverable session failure before starting anything, and the turn layer starts it fresh with the
 *     chat handed over. The thread's usage total so far is read from its rollout (however far back its last one is),
 *     because Codex reports a resumed thread's running total (codex-events.js); when it can't be read, the turn's usage
 *     isn't counted rather than the earlier turns' counted again.
 *   - ChatGPT plan only: while $CODEX_HOME/auth.json's last_refresh is 7 days old or more (Codex refreshes the sign-in
 *     at about 8), turns start one at a time, each holding the gate until the model first answers (30 s at most), so
 *     two turns never refresh the same sign-in at once.
 * The instructions: Codex's preamble (preamble.js), the workspace's CLAUDE.md (Codex reads AGENTS.md, not that) and the
 * stable part of the system prompt, as developer_instructions; the volatile part (today's log, the checkpoint, the
 * credential inventory) goes in front of each turn's input in a <turn-context> block, so new and resumed threads see
 * the same. Pictures go as local_image files in a private temp folder, removed when the turn ends.
 *
 * Limits: maxTurns counts the tools a turn starts; past it the engine stops Codex and ends with error_max_turns.
 * A key provider's 401, 402, 403 or 404 ends the turn at once (Codex would retry it five times); the ChatGPT plan's
 * 401 is left to Codex, which refreshes its sign-in on one.
 *
 * Stop: the signal stops codex (the SDK kills it). On Windows Codex's own job object takes everything it started with
 * it (checked against the pinned binary). Elsewhere a command Codex started in its own session can outlive it, so
 * every turn's environment carries TARSEE_CODEX_TURN=<random>, inherited by everything it starts, and Stop also kills
 * every process that carries this turn's mark (sweepTurnProcesses). Stop yields done{aborted}, once, and no error.
 *
 * Usage: Codex reports it only at turn.completed. A turn that ends any other way (Stop, the turn limit, a failure
 * after some model calls) still paid for every response it got, so its share of the thread's running total is read
 * from the rollout and given before its done.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import config from "../../config/env.js";
import { WORKSPACE_FILE_MAX_BYTES, truncateContent } from "../../lib/workspace-files.js";
import { CODEX_IMAGE_DIR } from "../../lib/turn-leftovers.js";
import { catalogModels, contextTokensFor, getProvider, normalizeProviderId } from "../provider-registry.js";
import {
  CODEX, CredentialError, baseEnv, codexConfigFilesFor, codexConfigGuard, ensureHome, homeIsolationRefusal,
} from "../engine-env.js";
import { classifyEngineError } from "../engine-errors.js";
import { format as formatHandle, parse as parseHandle, sessionFor } from "../session-handle.js";
import { resolveCodexBin } from "../codex-cli.js";
import { buildCodexOptions } from "./codex-options.js";
import { createCodexEventState, finishCodexEvents, mapCodexEvent, usageEvents } from "./codex-events.js";

/** Tarsee's bundled skills, the same folder Claude Code's turns get. */
const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/** A ChatGPT sign-in this old (or older) is about to be refreshed by Codex: turns start one at a time. */
export const REFRESH_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long one turn may hold the ChatGPT start gate. */
export const DEVICE_GATE_MAX_MS = 30_000;
/** Where a turn's pictures go (one private folder per turn inside it; the boot sweep knows it too). */
const IMAGE_DIR = CODEX_IMAGE_DIR;
/** A key provider's answers that retrying won't change. */
const FAIL_FAST_STATUSES = new Set([401, 402, 403, 404]);
/** How much of a rollout is read at a time, back from its end, for its usage total. */
const ROLLOUT_CHUNK_BYTES = 512 * 1024;
/** A rollout bigger than this many MB (TARSEE_SESSION_JSONL_MAX_MB) isn't resumed, and no read of one goes further back. */
const ROLLOUT_CAP_MB = 8;
const DEFAULT_MAX_TURNS = 50;
const TURN_MARK = "TARSEE_CODEX_TURN";
/** How long a finished turn waits for codex to exit by itself before it is stopped. */
const DRAIN_MS = 10_000;
const DRAINED = Symbol("drained");

// --- Dependencies (tests replace them through opts.deps) -----------------------------------------------------------

const DEFAULT_DEPS = {
  /** The Codex SDK's class (loaded on first use). */
  Codex: null,
  /** A grant for Tarsee's tools when the turn layer didn't pass one: {url, token, revoke()}. */
  grantTurn: async (ctx, o) => (await import("../mcp-http.js")).grantTurn(ctx, o),
  /** The vault's keys for scripts (agent-env.js), compared against the stripped environment. */
  vaultEnv: async (env, toolCtx) => {
    const { agentVaultEnv } = await import("../agent-env.js");
    const { getSecurityManager } = await import("../../lib/security-manager.js");
    return agentVaultEnv({
      env: baseEnv(env),
      denied: () => { try { return getSecurityManager(toolCtx?.settingsStore).getToolPermission("get_key") === "always_deny"; } catch { return false; } },
    });
  },
  /** Codex's preamble (preamble.js). */
  preamble: async (cwd) => (await import("../preamble.js")).buildPreamble({ engine: CODEX, cwd }),
  /** The ChatGPT account's live model list (codex-models.js fills the registry's runtime catalog). */
  accountModels: () => catalogModels("chatgpt-models"),
  /** Kill what a stopped turn started (see sweepTurnProcesses). */
  sweep: (mark) => sweepTurnProcesses(mark),
};

async function codexClass(deps) {
  if (deps.Codex) return deps.Codex;
  return (await import("@openai/codex-sdk")).Codex;
}

// --- Helpers -------------------------------------------------------------------------------------------------------

function readSetting(store, key) {
  try { return store?.get?.(key) ?? null; } catch { return null; }
}

function nonEmpty(v) {
  const s = v == null ? "" : String(v).trim();
  return s || null;
}

/** The provider's key: encrypted Settings, then its Railway variable (getKeyWithSource), else the environment. */
function keyFor(entry, store, env) {
  if (!entry.envKey) return null;
  try {
    if (typeof store?.getKeyWithSource === "function") {
      const k = store.getKeyWithSource(entry.storageId).key;
      if (k) return k;
    }
  } catch { /* fall back to the environment */ }
  return nonEmpty(env[entry.envKey]);
}

/** The text of the turn's prompt: the last user message's words. */
function promptText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n\n");
    return String(m.content ?? "");
  }
  return "";
}

/** The image blocks to send: the adapted media the turn layer passed, else the prompt's own. */
function imageBlocks(opts) {
  const fromMedia = Array.isArray(opts.media) ? opts.media : null;
  const list = fromMedia ?? (() => {
    const last = [...(opts.messages || [])].reverse().find((m) => m?.role === "user");
    return Array.isArray(last?.content) ? last.content : [];
  })();
  return list.filter((b) => b?.type === "image" && typeof b?.source?.data === "string" && b.source.data);
}

/**
 * The workspace's CLAUDE.md, which Codex doesn't read itself, as a section of the instructions: capped like every
 * other workspace file in the prompt (its middle cut out past WORKSPACE_FILE_MAX_BYTES), so a long one can't push the
 * rest past the command line's limit.
 */
function workspaceInstructions(workspace) {
  try {
    const text = fs.readFileSync(path.join(workspace, "CLAUDE.md"), "utf8").replace(/^\uFEFF/, "").trim();
    return text ? `## Workspace instructions (CLAUDE.md)\n\n${truncateContent(text, WORKSPACE_FILE_MAX_BYTES, "CLAUDE.md")}` : "";
  } catch {
    return "";
  }
}

export function instructionsHash(text) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 32);
}

/** The <turn-context> block in front of a turn's input: what changes from turn to turn. */
export function withTurnContext(volatile, text) {
  const v = String(volatile ?? "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").trim();
  if (!v) return text;
  return `<turn-context>\n${v.replace(/<\/turn-context>/gi, "</turn-context_>")}\n</turn-context>\n\n${text}`;
}

const FAIL_STATUS_RE = /\bstatus (\d{3})\b/i;

/**
 * The thread to resume, or null to start one: a stored handle resumes only this provider's own thread in this home
 * (session-handle.js), even with its raw id passed beside it (the turn layer passes both); a raw id passed alone is one
 * the caller already checked.
 */
function threadToResume(opts, where) {
  const handle = nonEmpty(opts.sessionHandle);
  if (handle) return sessionFor(handle, where);
  const id = nonEmpty(opts.sessionId);
  if (!id) return null;
  return parseHandle(id)?.tagged ? sessionFor(id, where) : id;
}

/**
 * The codex the SDK starts: TARSEE_CODEX_BIN when it is set (checked here, so a wrong one reads plainly), else
 * undefined for the SDK's own pinned binary (which also puts its helper programs, rg among them, on the turn's PATH).
 * On Windows it must be the program itself: the SDK starts it with no shell, and Node won't start a .cmd or .bat
 * file (an npm launcher) without one. Throws CredentialError needs-setup.
 */
function codexOverride(chosen, platform, providerId) {
  const p = nonEmpty(chosen);
  if (!p) return undefined;
  if (platform === "win32" && /\.(cmd|bat)$/i.test(p)) {
    throw new CredentialError("needs-setup", `TARSEE_CODEX_BIN names ${path.basename(p)}, a launcher script. On Windows it must name the Codex program itself (codex.exe), or be left unset to use the one Tarsee installs.`, providerId);
  }
  try {
    return resolveCodexBin({ codexBin: p });
  } catch {
    throw new CredentialError("needs-setup", `TARSEE_CODEX_BIN names ${p}, and there's no program there. Point it at the codex program, or leave it unset to use the one Tarsee installs.`, providerId);
  }
}

// --- Rollouts ------------------------------------------------------------------------------------------------------

/** The local calendar day a UUIDv7 thread id was made on (its first 48 bits are Unix milliseconds), or null. */
function threadDay(threadId) {
  const hex = String(threadId).replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return null;
  const ms = parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * A thread's rollout file in a Codex home ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl), or null.
 * The day folder comes from the thread id (the day before and after too, for time zones); a full walk is the fallback.
 */
export function findRollout(home, threadId, { fsImpl = fs } = {}) {
  const id = String(threadId ?? "").trim();
  if (!id || /[\\/]/.test(id)) return null;
  const suffix = `-${id}.jsonl`;
  const roots = [path.join(home, "sessions"), path.join(home, "archived_sessions")];
  const inDir = (dir) => {
    try { const f = fsImpl.readdirSync(dir).find((n) => n.endsWith(suffix)); return f ? path.join(dir, f) : null; } catch { return null; }
  };
  const day = threadDay(id);
  if (day) {
    for (const delta of [0, -1, 1]) {
      const d = new Date(day.getTime() + delta * 86_400_000);
      const hit = inDir(path.join(roots[0], String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
      if (hit) return hit;
    }
  }
  const walk = (dir, depth) => {
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(suffix)) return path.join(dir, e.name);
    }
    if (depth <= 0) return null;
    for (const e of entries) if (e.isDirectory()) { const hit = walk(path.join(dir, e.name), depth - 1); if (hit) return hit; }
    return null;
  };
  for (const root of roots) { const hit = walk(root, 3); if (hit) return hit; }
  return null;
}

const TOTAL_KEY = Buffer.from("total_token_usage");

/** The usage total on one rollout line (a token_count event's), or null. */
function lineTotal(line) {
  if (!line.length || line.indexOf(TOTAL_KEY) < 0) return null;
  try {
    const total = JSON.parse(line.toString("utf8"))?.payload?.info?.total_token_usage;
    return total && typeof total === "object" ? total : null;
  } catch {
    return null; // a line still being written
  }
}

/**
 * The thread's running usage total as its rollout last recorded it (its last token_count event). The file is read back
 * from its end a piece at a time (chunkBytes) until a line with a total turns up, so a long line after it can't hide
 * it: Codex keeps a picture inline as one base64 line, and a picture turn stopped (or failed) before any answer leaves
 * nothing after that line. The answer is
 *   the total  the last one recorded
 *   "none"     the whole file was read and no line has one: the thread hasn't spent anything yet
 *   null       it can't tell: the file couldn't be read, or any total is further back than maxBytes from the end (the
 *              rollout size cap, so the read stays bounded)
 */
export function rolloutUsageTotal(file, { fsImpl = fs, maxBytes = ROLLOUT_CAP_MB * 1024 * 1024, chunkBytes = ROLLOUT_CHUNK_BYTES } = {}) {
  let fd;
  try {
    fd = fsImpl.openSync(file, "r");
    const size = fsImpl.fstatSync(fd).size;
    const floor = Math.max(0, size - Math.max(0, Number(maxBytes) || 0));
    const step = Math.max(1, Math.floor(Number(chunkBytes)) || ROLLOUT_CHUNK_BYTES);
    // The pieces of the line the read is in the middle of, in order: its start is in a piece not read yet.
    let rest = [];
    for (let end = size; end > floor;) {
      const start = Math.max(floor, end - step);
      const buf = Buffer.alloc(end - start);
      for (let got = 0; got < buf.length;) {
        const n = fsImpl.readSync(fd, buf, got, buf.length - got, start + got);
        if (!(n > 0)) return null; // the file got shorter while it was read
        got += n;
      }
      let stop = buf.length;
      for (let nl = buf.lastIndexOf(0x0a, stop - 1); nl >= 0; nl = nl > 0 ? buf.lastIndexOf(0x0a, nl - 1) : -1) {
        const total = lineTotal(rest.length ? Buffer.concat([buf.subarray(nl + 1, stop), ...rest]) : buf.subarray(nl + 1, stop));
        if (total) return total;
        rest = [];
        stop = nl;
      }
      rest.unshift(buf.subarray(0, stop));
      end = start;
    }
    // Short of the file's start, the line the read stopped in is cut, and a total may be further back still.
    if (floor > 0) return null;
    return lineTotal(Buffer.concat(rest)) || "none";
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }
  }
}

/**
 * What a turn that ended without turn.completed spent (Stop, the idle watchdog, a timeout, the turn limit, a failure
 * after some model calls): Codex reports no usage then, but every response it got was billed and is in the thread's
 * running total in its rollout. The usage event and step for this turn's share, or none when nothing new was spent,
 * or when the thread's total before this turn isn't known (state.baselineKnown: the whole running total would count
 * the earlier turns as this one).
 */
function rolloutUsageEvents(state, home, threadId, { maxBytes } = {}) {
  if (!state.baselineKnown) return [];
  const file = threadId ? findRollout(home, threadId) : null;
  const total = file ? rolloutUsageTotal(file, { maxBytes }) : null;
  if (!total || total === "none") return [];
  const events = usageEvents(state, total);
  const u = events[0].usage;
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens > 0 ? events : [];
}

// (Pruning old rollouts lives in ../codex-rollouts.js, so lib/retention.js needn't load this engine.)
export { pruneCodexRollouts } from "../codex-rollouts.js";

// --- The ChatGPT start gate ------------------------------------------------------------------------------------------

const gates = new Map();

/** Whether the ChatGPT sign-in in this home is due a refresh (last_refresh 7 days old or more, or unreadable). */
export function refreshStale(home, { now = Date.now(), readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  let auth;
  try { auth = JSON.parse(String(readFile(path.join(home, "auth.json"))).replace(/^\uFEFF/, "")); } catch { return false; }
  const at = Date.parse(auth?.last_refresh ?? "");
  return !Number.isFinite(at) || now - at >= REFRESH_STALE_MS;
}

/**
 * Wait for this home's start gate when its sign-in is due a refresh; resolves to release(). Fresh sign-ins pass
 * straight through. A turn that waited checks again: the turn before it may have refreshed the sign-in. A turn
 * stopped while it waits (signal) leaves the queue at once; the turns behind it still wait for the ones ahead.
 */
export async function acquireDeviceGate(home, { maxMs = DEVICE_GATE_MAX_MS, stale = (h) => refreshStale(h), signal = null } = {}) {
  if (!stale(home)) return () => {};
  const before = gates.get(home) || Promise.resolve();
  let free;
  const mine = new Promise((r) => { free = r; });
  const tail = before.then(() => mine);
  gates.set(home, tail);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    free();
    tail.then(() => { if (gates.get(home) === tail) gates.delete(home); });
  };
  let timer = null;
  if (signal) {
    let onAbort;
    const stopped = new Promise((r) => { onAbort = () => r(true); });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const gaveUp = await Promise.race([before.then(() => false), stopped]);
    signal.removeEventListener("abort", onAbort);
    // Its own place is let go now; the next one's wait still chains on `before` (tail), so the order holds.
    if (gaveUp) { release(); return () => {}; }
  } else {
    await before;
  }
  if (!stale(home)) { release(); return () => {}; }
  timer = setTimeout(release, maxMs);
  timer.unref?.();
  return release;
}

// --- Stop: everything the turn started -------------------------------------------------------------------------------

/**
 * Kill every process that carries this turn's mark (TARSEE_CODEX_TURN=<mark> in its environment): codex and whatever
 * it started, however far down and whatever session or process group it moved to. Linux reads /proc/<pid>/environ
 * (only this user's processes are readable); macOS asks ps for environments. Windows does nothing here: Codex's job
 * object already ends everything with it. Returns the pids it signalled.
 */
export function sweepTurnProcesses(mark, { platform = process.platform, procDir = "/proc", fsImpl = fs, kill = (pid, sig) => process.kill(pid, sig), selfPid = process.pid, ps = null } = {}) {
  if (!mark || platform === "win32") return [];
  const needle = Buffer.from(`${TURN_MARK}=${mark}`);
  const hits = [];
  const carries = (buf) => {
    let at = buf.indexOf(needle);
    while (at >= 0) {
      const before = at === 0 || buf[at - 1] === 0;
      const end = at + needle.length;
      if (before && (end === buf.length || buf[end] === 0)) return true;
      at = buf.indexOf(needle, at + 1);
    }
    return false;
  };
  let scanned = false;
  try {
    for (const name of fsImpl.readdirSync(procDir)) {
      if (!/^\d+$/.test(name)) continue;
      scanned = true;
      const pid = Number(name);
      if (pid === selfPid) continue;
      let buf;
      try { buf = fsImpl.readFileSync(path.join(procDir, name, "environ")); } catch { continue; }
      if (carries(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))) hits.push(pid);
    }
  } catch { scanned = false; }
  if (!scanned && platform === "darwin") {
    try {
      const out = ps ? ps() : execFileSync("ps", ["-axeww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      for (const line of String(out).split("\n")) {
        const m = /^\s*(\d+)\s(.*)$/.exec(line);
        if (!m || Number(m[1]) === selfPid) continue;
        if (new RegExp(`(^|\\s)${TURN_MARK}=${mark}(\\s|$)`).test(m[2])) hits.push(Number(m[1]));
      }
    } catch { /* ps unavailable: nothing more to do */ }
  }
  for (const pid of hits) { try { kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  return hits;
}

// --- The turn ------------------------------------------------------------------------------------------------------

/** A turn that can't start: one text, one error, one done. */
function* refusal(providerId, err) {
  const code = err?.code || "unknown";
  const c = classifyEngineError(providerId, CODEX, { code, message: err?.message || String(err) });
  const message = c.message || err?.message || "This AI can't start the turn.";
  yield { type: "text", content: message };
  yield { type: "error", message, code: c.kind, subtype: c.kind, recoverable: false };
  yield { type: "done", stopReason: "error" };
}

/**
 * R1 and R5's Codex counterpart, as a CredentialError credential-isolation, or null: a sign-in file in a key home
 * (homeIsolationRefusal), or a file Codex would load that could move its traffic (codexConfigGuard: the home's
 * config.toml and .env, the workspace's .codex/config.toml).
 */
function unsafeHome(home, workspace, providerId) {
  const isolation = homeIsolationRefusal(home, { providerId, engine: CODEX });
  if (isolation) return new CredentialError("credential-isolation", isolation.message, providerId);
  const guard = codexConfigGuard(codexConfigFilesFor({ home, workspace }));
  if (!guard.ok) return new CredentialError("credential-isolation", guard.message, providerId);
  return null;
}

/** A stored thread that won't be resumed: the turn layer starts fresh and hands the chat over. */
function* startFresh(why) {
  yield { type: "error", message: why, code: "session", subtype: "session", recoverable: true };
  yield { type: "done", stopReason: "error" };
}

export async function* run(opts = {}) {
  const deps = { ...DEFAULT_DEPS, ...(opts.deps || {}) };
  const env = deps.env ?? process.env;
  const target = opts.target || {};
  const providerId = normalizeProviderId(target.providerId ?? target.provider ?? opts.provider);
  const entry = providerId ? getProvider(providerId) : null;
  if (!entry || !entry.engines.includes(CODEX)) {
    yield* refusal(providerId || "openai", new CredentialError("wrong-engine", `${entry?.label || providerId || "That AI"} doesn't run on Codex.`, providerId));
    return;
  }
  const model = nonEmpty(target.model ?? opts.model);
  const effort = nonEmpty(target.effort ?? opts.effort);
  const toolCtx = opts.toolCtx || {};
  const store = toolCtx.settingsStore || deps.store || null;
  const conv = toolCtx.conversationId || null;
  const workspace = nonEmpty(opts.cwd) || nonEmpty(deps.workspace) || config.CLAUDE_WORKSPACE_DIR || process.cwd();
  const stateDir = deps.stateDir || config.STATE_DIR;
  const turnId = nonEmpty(opts.turnId) || crypto.randomBytes(6).toString("hex");
  const mark = crypto.randomBytes(12).toString("hex");
  const localUrl = providerId === "local" ? (nonEmpty(readSetting(store, "ai.local.baseUrl")) || nonEmpty(env.TARSEE_LOCAL_AI_URL)) : null;

  let grant = null;
  let ownGrant = false;
  let images = null;
  let releaseGate = () => {};
  let ac = null;
  let streamEnded = false;
  let it = null;
  let stopWhy = null;
  let failFast = null;
  const onAbort = () => { stopWhy ||= "user"; ac?.abort(); };
  const live = { ac: null, mark, images: null, sweep: deps.sweep };
  trackLive(live);

  try {
    // The tools' grant: the turn layer's, else one of our own (revoked in finally).
    grant = opts.mcpGrant?.url ? opts.mcpGrant : null;
    if (!grant) {
      try {
        grant = await deps.grantTurn({ ...toolCtx, turnId, provider: providerId }, { turnId, signal: opts.signal });
        ownGrant = true;
      } catch (err) {
        yield* refusal(providerId, new CredentialError("needs-mcp-token", `Tarsee's tools couldn't be opened for this turn: ${err?.message || err}`, providerId));
        return;
      }
    }

    // The instructions and the options. Any CredentialError here refuses the turn before anything starts (R4).
    const stable = opts.systemParts && typeof opts.systemParts === "object" ? String(opts.systemParts.stable ?? "") : String(opts.systemPrompt ?? "");
    const volatile = opts.systemParts && typeof opts.systemParts === "object" ? String(opts.systemParts.volatile ?? "") : "";
    let preamble = "";
    try { preamble = await deps.preamble(workspace); } catch (err) { console.warn(`[codex] the preamble couldn't be built: ${err?.message || err}`); }
    const developerInstructions = [preamble, workspaceInstructions(workspace), stable].map((s) => String(s || "").trim()).filter(Boolean).join("\n\n");

    let o;
    let codexPath;
    try {
      o = buildCodexOptions({ providerId, model, effort }, {
        env,
        vaultEnv: await deps.vaultEnv(env, toolCtx),
        key: keyFor(entry, store, env),
        stateDir,
        home: deps.home,
        workspace,
        mcp: { url: grant.url, token: grant.token },
        developerInstructions,
        localUrl,
        appTitle: readSetting(store, "ai.openrouter.appTitle"),
        referer: readSetting(store, "ai.openrouter.referer"),
        contextTokens: contextTokensFor(providerId, model, store),
        thinkingSummaries: !!opts.thinkingSummaries,
        accountModels: providerId === "chatgpt" ? deps.accountModels() : undefined,
        skillsDir: fs.existsSync(SKILLS_DIR) ? SKILLS_DIR : undefined,
        turnMark: mark,
        platform: deps.platform,
      });
      codexPath = codexOverride(deps.codexPath ?? env.TARSEE_CODEX_BIN, deps.platform || process.platform, providerId);
    } catch (err) {
      if (err instanceof CredentialError) { yield* refusal(providerId, err); return; }
      throw err;
    }

    // R1 and R5's Codex counterpart: the home, nothing in it that isn't this provider's, no config that moves traffic
    // (checked again right before codex starts: see unsafeHome).
    try { ensureHome(o.home); } catch (err) { yield* refusal(providerId, new CredentialError("needs-setup", `Codex's folder ${o.home} couldn't be made: ${err.message}`, providerId)); return; }
    const unsafe = unsafeHome(o.home, workspace, providerId);
    if (unsafe) { yield* refusal(providerId, unsafe); return; }

    // Resume, or start fresh.
    const where = { provider: providerId, engine: CODEX, model };
    const raw = threadToResume(opts, where);
    const hash = instructionsHash(o.config.developer_instructions);
    const hashKey = conv ? `session.${conv}.instrHash` : null;
    const capMb = Number(env.TARSEE_SESSION_JSONL_MAX_MB) || ROLLOUT_CAP_MB;
    const capBytes = capMb * 1024 * 1024;
    let baseline = null;
    // Whether the thread's total before this turn is known: a new thread's is nothing; a resumed one's is its rollout's
    // last total, or nothing when the whole rollout has none. Without it, no usage is given for the turn: the total
    // read at its end, and Codex's own at turn.completed, are the whole thread's, and would count earlier turns again.
    let baselineKnown = !raw;
    if (raw) {
      if (hashKey && store && readSetting(store, hashKey) !== hash) {
        yield* startFresh("This chat's Codex session was started with other instructions, so a fresh one starts with the conversation handed over.");
        return;
      }
      const rollout = findRollout(o.home, raw);
      if (rollout) {
        let mb = 0;
        try { mb = fs.statSync(rollout).size / (1024 * 1024); } catch { /* gone: Codex says so */ }
        if (mb > capMb) {
          console.warn(`[codex] thread ${raw} rollout ${mb.toFixed(1)}MB > ${capMb}MB cap: starting fresh instead of resuming it`);
          yield* startFresh(`This chat's Codex session grew past ${capMb} MB, so a fresh one starts with the conversation handed over.`);
          return;
        }
        const before = rolloutUsageTotal(rollout, { maxBytes: capBytes });
        baseline = before && before !== "none" ? before : null;
        baselineKnown = before !== null;
      }
      if (!baselineKnown) console.warn(`[codex] thread ${raw}: its usage so far couldn't be read from its rollout, so this turn's usage isn't counted (Codex's total would count the thread's earlier turns again)`);
    }

    // The prompt: the turn's context, then the person's words (the turn layer already put the handoff and the queued
    // note in front of them), and any pictures as files.
    const text = withTurnContext(volatile, promptText(opts.messages));
    const pictures = imageBlocks(opts);
    if (pictures.length) {
      const { writeLocalImages } = await import("../media.js");
      images = writeLocalImages(pictures, { dir: IMAGE_DIR });
      live.images = images;
    }
    const input = images?.inputs?.length ? [{ type: "text", text }, ...images.inputs] : text;

    if (providerId === "chatgpt") releaseGate = await (deps.acquireGate || acquireDeviceGate)(o.home, { signal: opts.signal });
    if (opts.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
    // Again, now that nothing more waits: the ChatGPT gate can wait for another chat's turn, long enough for that
    // turn's agent to plant a .env or a config entry in the home both turns share.
    const late = unsafeHome(o.home, workspace, providerId);
    if (late) { yield* refusal(providerId, late); return; }

    const Codex = await codexClass(deps);
    const codex = new Codex({ env: o.env, config: o.config, ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(codexPath ? { codexPathOverride: codexPath } : {}) });
    const thread = raw ? codex.resumeThread(raw, o.threadOptions) : codex.startThread(o.threadOptions);

    ac = new AbortController();
    live.ac = ac;
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const maxTurns = Number(opts.maxTurns) > 0 ? Math.floor(Number(opts.maxTurns)) : DEFAULT_MAX_TURNS;
    const state = createCodexEventState({ providerId, model, baseline, baselineKnown, localUrl });
    console.log(`[codex] turn ${turnId}: ${providerId}${o.threadOptions.model ? ` ${o.threadOptions.model}` : " (Codex's default model)"}, ${raw ? `resuming ${raw}` : "new thread"}, ${pictures.length} picture(s)`);

    let thrown = null;
    let held = null;
    let turnStarted = false;
    try {
      const { events } = await thread.runStreamed(input, { signal: ac.signal });
      it = events[Symbol.asyncIterator]();
      for (;;) {
        // Once the turn is over, its done waits for codex to exit on its own (it is still writing the thread's rollout,
        // which the next turn resumes from), for DRAIN_MS at most.
        const next = it.next();
        let r;
        if (held) {
          next.catch(() => {});
          r = await Promise.race([next, new Promise((resolve) => { const t = setTimeout(() => resolve(DRAINED), DRAIN_MS); t.unref?.(); })]);
          if (r === DRAINED) break;
        } else {
          r = await next;
        }
        if (r.done) { streamEnded = true; break; }
        const ev = r.value;
        if (ev?.type === "thread.started" && ev.thread_id) {
          reportSession(opts, where, ev.thread_id);
          if (!raw && hashKey && store) { try { store.set(hashKey, hash); } catch (err) { console.warn(`[codex] the instructions' hash couldn't be stored: ${err?.message || err}`); } }
        } else if (ev?.type === "turn.started") {
          turnStarted = true;
        } else if (turnStarted && ev?.type !== "error") {
          // The model has answered (or the turn failed): the sign-in is settled, so the next ChatGPT turn may start.
          releaseGate();
        }
        for (const out of mapCodexEvent(ev, state)) {
          if (out.type === "done") held = out;
          else yield out;
        }
        if (held) continue;
        if (state.toolCount > maxTurns) { stopWhy = "max_turns"; ac.abort(); break; }
        if (ev?.type === "error" && providerId !== "chatgpt") {
          const st = Number(FAIL_STATUS_RE.exec(String(ev.message || ""))?.[1]);
          if (FAIL_FAST_STATUSES.has(st)) { failFast = String(ev.message).replace(/^Reconnecting\.\.\.\s*\d+\s*\/\s*\d+\s*\(([\s\S]*)\)\s*$/, "$1"); stopWhy = "fail-fast"; ac.abort(); break; }
        }
      }
    } catch (err) {
      thrown = err;
      streamEnded = true;
    }
    releaseGate();
    // A turn that ended any way but turn.completed: what it spent comes from the rollout, before the done (the turn
    // layer stops reading at the done). A held done has waited for codex to finish writing it.
    const spent = () => rolloutUsageEvents(state, o.home, state.threadId || raw, { maxBytes: capBytes });
    if (held) {
      if (held.stopReason !== "end_turn") yield* spent();
      yield held;
      return;
    }

    if (!state.done) {
      const end = stopWhy === "max_turns" ? finishCodexEvents(state, { maxTurns })
        : stopWhy === "fail-fast" ? finishCodexEvents(state, { error: new Error(failFast) })
          : stopWhy === "user" || opts.signal?.aborted ? finishCodexEvents(state, { aborted: true })
            : finishCodexEvents(state, { error: thrown });
      const done = end.pop();
      yield* end;
      yield* spent();
      if (done) yield done;
    }
  } finally {
    LIVE_TURNS.delete(live);
    opts.signal?.removeEventListener?.("abort", onAbort);
    releaseGate();
    const stopped = !!stopWhy || (ac && !streamEnded);
    if (ac && !streamEnded) {
      ac.abort();
      try { await it?.return?.(); } catch { /* the SDK closing up after a stop changes nothing */ }
    }
    if (stopped) {
      // codex is gone (the SDK killed it); whatever it started that outlived it goes too.
      try {
        const pids = deps.sweep(mark);
        if (pids?.length) console.log(`[codex] stopped ${pids.length} process(es) the turn left running`);
      } catch (err) { console.warn(`[codex] stopping the turn's processes failed: ${err?.message || err}`); }
    }
    images?.cleanup?.();
    if (ownGrant) { try { await grant?.revoke?.(); } catch { /* the grant expires on its own */ } }
  }
}

/**
 * The turns running now, for the process's exit: a server that exits mid-turn (the SIGTERM handler of a redeploy, or
 * Ctrl+C, calls process.exit) runs no finally block, so codex and what it started would outlive it and the turn's
 * pictures would stay in the system's temp folder. On exit each turn's codex is stopped (the SDK kills it on abort),
 * the processes carrying its mark are swept, and its pictures are removed. All of it is synchronous, as an exit
 * handler must be. (lib/turn-leftovers.js sweeps at boot what a crash left.)
 */
const LIVE_TURNS = new Set();
let exitHooked = false;
function trackLive(turn) {
  LIVE_TURNS.add(turn);
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const t of LIVE_TURNS) {
      try { t.ac?.abort(); } catch { /* exiting */ }
      try { t.sweep?.(t.mark); } catch { /* exiting */ }
      try { t.images?.cleanup?.(); } catch { /* exiting */ }
    }
  });
}

/** Store the thread's handle: onSessionHandle (the turn layer's), else onSessionId, each called once. */
function reportSession(opts, where, threadId) {
  let handle;
  try { handle = formatHandle(where, threadId); } catch (err) { console.warn(`[codex] thread ${String(threadId).slice(0, 40)} can't be stored: ${err.message}`); return; }
  const fns = [...new Set([opts.onSessionHandle, opts.onSessionId].filter((f) => typeof f === "function"))];
  for (const fn of fns) { try { fn(handle); } catch (err) { console.warn(`[codex] storing the session failed: ${err?.message || err}`); } }
}
