/**
 * Token usage: what every model call cost in tokens, summed per turn, per job,
 * per chat and per day, read from Claude Code's own session transcripts.
 *
 * Where the numbers come from. The Agent SDK runs Claude Code, which writes each
 * session to a transcript (<claude home>/projects/<workspace slug>/<session>.jsonl,
 * and <session>/subagents/agent-<id>.jsonl for the agents it starts). Every model
 * call appears there as an assistant line carrying the call's usage: input, cache
 * read, cache write and output tokens. Newer Claude Code versions also write an
 * api-request line the moment a request goes out, so a call's generation time
 * runs from that line to its last content block; versions that do not write it
 * use the line before the call (the prompt or the tool result it answers) as
 * the start instead.
 *
 * Which Claude home. Every provider that runs on Claude Code keeps its sessions
 * in its own home (the Claude plan's ~/.claude; <state>/.claude-home-<id> for an
 * Anthropic key, DeepSeek and OpenRouter), so this reads the workspace's project
 * folder under EVERY home lib/claude-transcript.js knows (projectsRootsByProvider),
 * folding duplicates that are the same folder through a symlink, and tags each
 * call with the provider whose home it was in. Inside the Docker image HOME is
 * /root while the plan's configuration lives at /home/node/.claude (a symlink to
 * the volume), which is why the plan has several candidate roots.
 *
 * Engines without Claude transcripts (Codex) report a turn's usage once, at its
 * end: the turn layer hands it to recordDirect(), which puts it on its turn at
 * once. A Claude Code turn is never recorded that way (its transcript is the
 * record), so nothing is counted twice.
 *
 * Cost (design 4.13). Each transcript call is priced at its own moment from the
 * provider's price table (ai/spend.js priceUsage: DeepSeek's peak hours, "est."),
 * except where nothing is billed per token: the plans (null, "Included in plan")
 * and an Anthropic key, whose exact cost the engine reports on turn_end
 * (costUsd). A turn's cost is its calls' sum when they are priced, else the
 * engine's figure; plans never get one. Days, the monthly cap (ai/spend.js) and
 * the page add up turns once and calls that are in no turn once.
 *
 * What a turn and a job are. A turn is one run of the agent in a conversation:
 * the turn_start and turn_end events of the live timeline (lib/live-bus.js,
 * conversation_events). A session belongs to a conversation by, in order: the
 * session id its turn_end names, the conversation's claude_session_id, a cron's
 * "[Cron Job: <id>" header, or the turn whose prompt was typed into it. Each of
 * the session's calls goes to the turn running at the time (or, for work that
 * goes on after the turn ended, such as an agent reporting back, the last turn
 * before it; an agent's calls all go to the turn that started it). A job is a run
 * of turns in one conversation with no more than JOB_GAP_MS idle between them; a
 * cron run, the heartbeat and the boot checklist are always jobs of their own.
 * Jobs can be renamed and merged with the one before (setting usage.jobs).
 *
 * Speed. Output tk/s is output tokens over the time the calls spent generating
 * them; total tk/s is every token the calls processed (input, cache reads and
 * writes, output) over the same time. Calls that run side by side (agents) each
 * count their own time.
 *
 * Cheap to keep up to date: each transcript is read once, from where the last
 * read stopped (its byte offset is stored, and survives restarts), a megabyte at
 * a time with pauses so the server stays responsive, and only the lines that
 * matter are parsed. Calls, turns and their sums live in the database (migration
 * 010), so the page reads sums, never a transcript. The first read only goes back
 * BACKFILL_DAYS; older rows are dropped after RETENTION_DAYS.
 *
 * Days and hours are counted in the configured timezone (config.TIMEZONE, from
 * TARSEE_TIMEZONE or the host's zone).
 */
import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { projectsRootsByProvider, slugifyCwd } from "./claude-transcript.js";
import { USAGE_SCHEMA } from "../db/usage-schema.js";
import { ensureUsageColumns } from "../db/sqlite.js";
import { SettingsStore } from "../db/settings.js";
import { zoneOffsetMs, localDay, localMidnight, dayStarts } from "./local-time.js";
import { PROVIDER_IDS, engineFor, getProvider, modelsFor, normalizeProviderId } from "../ai/provider-registry.js";
import { untag } from "../ai/session-handle.js";
import { costSource, priceUsage, spendBetween, tokensOf } from "../ai/spend.js";

/** Days and hours in the configured timezone (lib/local-time.js), as this module has always exported them. */
export { zoneOffsetMs, localDay, localMidnight, dayStarts };

const H = 3_600_000;
const DAY = 24 * H;
/** How far back the first read of the transcripts goes (by each file's last change). */
export const BACKFILL_DAYS = Math.max(1, Number(process.env.TARSEE_USAGE_BACKFILL_DAYS) || 14);
/** Calls and turns older than this are deleted, so the tables do not grow forever. */
export const RETENTION_DAYS = Math.max(BACKFILL_DAYS, Number(process.env.TARSEE_USAGE_RETENTION_DAYS) || 90);
const CHUNK = 1 << 20;                 // read 1 MB at a time
const SLICE_MS = 25;                   // then let the event loop breathe
const MAX_GEN_MS = 20 * 60_000;        // a "generation time" longer than this is a gap in the record, not a call
const MAX_TPS = 1500;                  // faster than this, the start we have is not the call's (a line written while it ran)
export const JOB_GAP_MS = 45 * 60_000; // idle this long and the next turn is a new job
const BACKGROUND_MS = 12 * H;          // work after a turn ended still belongs to it up to this long
const PROMPT_KEEP_MS = 21 * DAY;       // typed prompts only identify new sessions: three weeks of them is plenty

// ------------------------------------------------------------------ where the transcripts are

/**
 * The folders Claude Code keeps the workspace's sessions in, each with the
 * provider whose home it is in: [{ dir, provider }], the workspace's project
 * folder under every Claude home root that exists, each real folder once. Two
 * slug spellings are tried, Tarsee's own (lib/claude-transcript.js) and "every
 * character that is not a letter or digit becomes -", because Claude Code has
 * changed its rule between versions. opts: stateDir, homeDir, env (where the
 * homes are; lib/claude-transcript.js providerHomes).
 */
export function projectDirsByProvider(cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd(), opts = {}) {
  const slugs = [...new Set([slugifyCwd(cwd), String(cwd).replace(/[^a-zA-Z0-9]/g, "-")])];
  const seen = new Set();
  const out = [];
  for (const { provider, root } of projectsRootsByProvider(opts)) {
    for (const slug of slugs) {
      const dir = path.join(root, slug);
      let real;
      try { real = fs.realpathSync(dir); } catch { continue; }   // not there
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ dir, provider });
    }
  }
  return out;
}

/** The same folders without their providers. */
export function projectDirs(cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd(), opts = {}) {
  return projectDirsByProvider(cwd, opts).map((d) => d.dir);
}

// ------------------------------------------------------------------ reading a transcript

/** What a file's reader carries from one read to the next. */
export function newReadState() { return { reqs: {}, prevTs: 0 }; }

const TS_RE = /"timestamp":"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/;
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

/** A typed prompt's words for matching: one space between words. */
export function promptKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Transcript lines into model calls and typed prompts. Lines that are neither are
 * not parsed; only their timestamp is read (it stands in for when the next call
 * went out, in transcripts without api-request lines).
 *   state: newReadState(), carried between reads of the same file.
 * Returns { calls: [{ id, model, effort, startedAt, endedAt, input, cacheRead, cacheWrite, output }],
 *           prompts: [{ at, head, tail }] }. A call written over several lines (one per content
 * block) comes once, with its last block's time.
 */
export function parseTranscriptLines(lines, state = newReadState()) {
  const calls = new Map();
  const prompts = [];
  for (const line of lines) {
    if (!line || line.length < 20) continue;
    const isReq = line.startsWith('{"type":"api-request"');
    const isCall = !isReq && line.includes('"type":"assistant"') && line.includes('"usage":{');
    const isPrompt = !isReq && !isCall && line.includes('"role":"user","content":"');
    if (!isReq && !isCall && !isPrompt) {
      // A tool's result goes back to the model at once: the next call starts about then. Other lines
      // (an agent's progress, the harness's notes) can be written while a call is still running: not a start.
      if (line.includes('"type":"user"')) {
        const m = TS_RE.exec(line);
        if (m) state.prevTs = Date.parse(m[1]) || state.prevTs;
      }
      continue;
    }
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const at = Date.parse(d.timestamp || "") || 0;
    if (isReq) {
      if (d.id && at) {
        state.reqs[d.id] = { at, effort: d.params?.output_config?.effort || null };
        const keys = Object.keys(state.reqs);
        if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete state.reqs[k];
      }
      if (at) state.prevTs = at;
      continue;
    }
    if (isCall) {
      const m = d.message || {};
      const u = m.usage || {};
      const model = String(m.model || "");
      // "<synthetic>" messages are written by Claude Code itself, not by a model call.
      if (!m.id || !at || model.startsWith("<")) { if (at) state.prevTs = at; continue; }
      const input = num(u.input_tokens), cacheRead = num(u.cache_read_input_tokens), cacheWrite = num(u.cache_creation_input_tokens), output = num(u.output_tokens);
      if (!(input + cacheRead + cacheWrite + output)) { state.prevTs = at; continue; }
      const req = d.requestRef ? state.reqs[d.requestRef] : null;
      const startedAt = req?.at || state.prevTs || null;
      const prev = calls.get(m.id);
      calls.set(m.id, prev ? {
        ...prev,
        startedAt: prev.startedAt && startedAt ? Math.min(prev.startedAt, startedAt) : (prev.startedAt || startedAt),
        endedAt: Math.max(prev.endedAt, at),
        input: Math.max(prev.input, input), cacheRead: Math.max(prev.cacheRead, cacheRead),
        cacheWrite: Math.max(prev.cacheWrite, cacheWrite), output: Math.max(prev.output, output),
      } : {
        id: m.id, model, effort: (typeof d.effort === "string" && d.effort) || req?.effort || null,
        startedAt, endedAt: at, input, cacheRead, cacheWrite, output,
      });
      state.prevTs = at;
      continue;
    }
    // A prompt: what a person (or a channel, for them) typed. Not the harness's own notes.
    if (at) state.prevTs = at;
    const c = d.message?.content;
    if (typeof c !== "string" || d.isMeta) continue;
    const kind = d.origin?.kind;
    if (kind && kind !== "human") continue;
    if (/^\s*</.test(c)) continue;   // <command-name>, <task-notification>, <local-command-stdout>
    const text = promptKey(c);
    if (text) prompts.push({ at, head: text.slice(0, 400), tail: text.length > 400 ? text.slice(-1500) : "" });
  }
  return { calls: [...calls.values()], prompts };
}

// ------------------------------------------------------------------ sessions, turns, calls

/** Every cron run's prompt opens with "[Cron Job: <id> — <time>]" (lib/cron.js): the cron's live id. */
export function cronOfPrompt(head) {
  const m = /^\[Cron Job: ([\w.-]{1,80})\b/.exec(String(head || ""));
  return m ? `cron:${m[1]}` : null;
}

/** A turn's prompt as it was typed: what to look for in a session's prompts. */
function turnNeedle(prompt) {
  return promptKey(prompt).slice(0, 80);
}

/**
 * Whose session is this, from the prompts typed in it: the conversation whose
 * turns those prompts were. The turn starts before the prompt is written, a queue
 * can hold it a while, and the prompt begins with the turn's words (or ends with
 * them after a context preamble). Short prompts ("Go") only count when the times
 * are close.
 *   prompts [{ at, head, tail }], turns [{ conversationId, startedAt, prompt }]
 * Returns a conversation id or null.
 */
export function matchSession(prompts, turns) {
  const votes = new Map();
  for (const p of prompts) {
    const cron = cronOfPrompt(p.head);
    if (cron) { votes.set(cron, (votes.get(cron) || 0) + 10); continue; }
    for (const t of turns) {
      const lag = p.at - t.startedAt;
      if (lag < -15_000 || lag > 6 * H) continue;
      const needle = turnNeedle(t.prompt);
      if (needle.length < 4) continue;
      if (needle.length < 24 && Math.abs(lag) > 3 * 60_000) continue;
      if (!(p.head.startsWith(needle) || p.head.includes(needle) || (p.tail && p.tail.includes(needle)))) continue;
      votes.set(t.conversationId, (votes.get(t.conversationId) || 0) + (needle.length >= 24 ? 2 : 1));
      break;
    }
  }
  let best = null, score = 0;
  for (const [id, v] of votes) if (v > score) { best = id; score = v; }
  return best;
}

/**
 * The turn a call at `at` belongs to, of one conversation's turns (oldest first,
 * { turnId, startedAt, endedAt }): the first one running then (turns queue, so
 * the older one is the one working), else the last one before it, if that ended
 * no more than BACKGROUND_MS before (work it left running).
 */
export function pickTurn(turns, at, now = Date.now()) {
  let before = null;
  for (const t of turns) {
    if (t.startedAt - 2000 > at) break;
    const end = t.endedAt || now;
    if (at <= end + 2000) return t;
    before = t;
  }
  if (before && at - (before.endedAt || now) <= BACKGROUND_MS) return before;
  return null;
}

// ------------------------------------------------------------------ sums and speed

export const EMPTY = Object.freeze({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, genMs: 0, genOut: 0, genTokens: 0 });

/** Add sums together. */
export function addSums(a, b) {
  const out = { ...EMPTY, ...a };
  for (const k of Object.keys(EMPTY)) out[k] = (out[k] || 0) + (Number(b?.[k]) || 0);
  return out;
}

/**
 * The figures a person reads, from sums: the total, the cache share, and speed.
 *   total      every token the calls processed
 *   cacheShare the part of it that was cache reads (0..1)
 *   outTps     output tokens a second of generation
 *   totalTps   all tokens a second of generation
 */
export function figures(s = EMPTY) {
  const total = (s.input || 0) + (s.cacheRead || 0) + (s.cacheWrite || 0) + (s.output || 0);
  const sec = (s.genMs || 0) / 1000;
  return {
    calls: s.calls || 0, input: s.input || 0, cacheRead: s.cacheRead || 0, cacheWrite: s.cacheWrite || 0, output: s.output || 0,
    total, cacheShare: total ? Math.round(((s.cacheRead || 0) / total) * 1000) / 1000 : 0,
    genMs: s.genMs || 0,
    outTps: sec >= 0.5 ? Math.round(((s.genOut || 0) / sec) * 10) / 10 : null,
    totalTps: sec >= 0.5 ? Math.round(((s.genTokens || 0) / sec) * 10) / 10 : null,
  };
}

/** One call's sums (its generation time only counts when it is believable). */
export function callSums(c) {
  const gen = c.startedAt && c.endedAt ? c.endedAt - c.startedAt : 0;
  const ok = gen > 0 && gen <= MAX_GEN_MS && c.output <= gen * (MAX_TPS / 1000);
  const all = c.input + c.cacheRead + c.cacheWrite + c.output;
  return { calls: 1, input: c.input, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, output: c.output, genMs: ok ? gen : 0, genOut: ok ? c.output : 0, genTokens: ok ? all : 0 };
}

const CLAUDE_ID_RE = /^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?/;
const capital = (w) => `${w[0].toUpperCase()}${w.slice(1)}`;
/** A row whose model was never named: the engine ran its own default (the ChatGPT plan before its list is read). */
const DEFAULT_MODEL_LABEL = "Default model";

/**
 * A model id as people read it. Claude's ids: "claude-<family>-<major>-<minor>[-<date>]" -> "<Family> <major>.<minor>"
 * (also inside OpenRouter's "anthropic/…" slugs, and "…-latest" as "<Family> (latest)"). Every other id by the label
 * its provider's card shows (the registry; `provider` first, then every other), else the id itself.
 */
export function modelLabel(id, provider = null) {
  const raw = String(id || "").trim();
  if (!raw) return "Unknown";
  const bare = raw.replace(/\[1m\]$/i, "");
  const claudeId = bare.replace(/^~?anthropic\//i, "");
  const latest = /^claude-([a-z]+)-latest$/i.exec(claudeId);
  if (latest) return `${capital(latest[1].toLowerCase())} (latest)`;
  const m = CLAUDE_ID_RE.exec(claudeId);
  if (m) return `${capital(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  for (const pid of new Set([normalizeProviderId(provider), ...PROVIDER_IDS].filter(Boolean))) {
    const hit = modelsFor(pid).find((x) => x.id === bare);
    if (hit?.label && hit.label !== hit.id) return hit.label;
  }
  return raw;
}

/** A stored provider id as its public id; rows from before migration 012 (null) are the Claude plan's. */
export function providerOf(stored) {
  return normalizeProviderId(stored) || "claude";
}

/** How a provider is named on the page ("Claude plan", "DeepSeek"). */
export function providerLabel(id) {
  return getProvider(id)?.label || String(id || "Unknown");
}

/**
 * What a cost figure is, for a set of providers that did the work and whether any cost was recorded:
 *   "exact"    an engine-reported cost (an Anthropic key)
 *   "est"      a price-table estimate in it (DeepSeek, OpenAI, OpenRouter, a priced Local AI)
 *   "unknown"  metered work with no price known
 *   "plan"     only plans: "Included in plan"
 *   "free"     only a Local AI with no price
 *   null       nothing at all
 */
export function costNoteOf(providers, hasCost, store = null) {
  const kinds = new Set([...providers].map((p) => costSource(providerOf(p), store)));
  if (kinds.has("estimate")) return hasCost ? "est" : "unknown";
  if (kinds.has("exact")) return hasCost ? "exact" : "unknown";
  if (kinds.has("plan")) return "plan";
  if (kinds.has("free")) return "free";
  return null;
}

const finiteCost = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
/** A moment as ms: a number, a Date or a date string; null for nothing readable. */
function toMs(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}
const cents = (x) => Math.round(x * 1e9) / 1e9;
const isPlanProvider = (id) => getProvider(providerOf(id))?.kind === "subscription";

/** SQL that keeps one provider's rows ("" for all). Only a known provider id (lower-case letters) is ever inlined. */
function providerSql(provider, col = "provider") {
  const id = provider ? normalizeProviderId(provider) : null;
  return id ? ` AND COALESCE(${col}, 'claude') = '${id}'` : "";
}

/** The channels a turn can come from (the providers' liveSource), as the page names them. */
const CHANNEL_LABELS = {
  web: "Web", telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp", slack: "Slack", email: "Email",
  cron: "Crons", heartbeat: "Heartbeat", boot: "Boot checklist", api: "API",
};

/** Where a turn came from. Background jobs are known by their live id even without a source. */
export function channelOf(source, conversationId = "") {
  const id = String(conversationId || "");
  if (id.startsWith("cron:")) return "Crons";
  if (id === "heartbeat") return "Heartbeat";
  if (id === "boot") return "Boot checklist";
  return CHANNEL_LABELS[source] || "Other";
}

/** A background job's live id (lib/background-turn.js): its runs never join into one job. */
const isBackground = (conv) => String(conv || "").startsWith("cron:") || conv === "heartbeat" || conv === "boot";

/**
 * A message as a turn's or a job's name: without a "[sender]: " tag, without the
 * message it replies to ("[Replying to someone: "…"]", up to its last closing),
 * without a cron's header, one line, short.
 */
export function promptTitle(prompt) {
  let s = promptKey(prompt);
  s = s.replace(/^\[[^\]]{1,40}\]:\s*/, "");                                  // "[alice]: "
  if (/^\[Replying to [^:]{1,40}: "/.test(s)) {
    const close = s.lastIndexOf('"]');
    const after = close > 0 ? s.slice(close + 2).trim() : "";
    // Nothing after the quote (a reply to one's own message): the quoted words are the ask.
    s = after || s.replace(/^\[Replying to [^:]{1,40}: "/, "").replace(/"\]\s*$/, "");
  }
  s = s.replace(/^\[Cron Job: ([\w.-]+)[^\]]*\]\s*/, "");
  s = s.replace(/^\[\d+ files? attached[\s\S]*$/, "").trim();
  return s.length > 90 ? `${s.slice(0, 89).trimEnd()}…` : s;
}

// ------------------------------------------------------------------ jobs

/**
 * Turns into jobs. turns: [{ turnId, conversationId, source, startedAt, endedAt, lastCallAt, prompt, sums }]
 * (any order). A conversation's turns are one job while the gap between one's end
 * (or its last call, if work went on) and the next one's start is under the gap;
 * a background run (cron, heartbeat, boot) is a job of its own.
 * overrides: { names: { key: name }, merges: { key: keyOfTheJobBefore } } (a job's
 * key is its first turn's id).
 */
export function groupJobs(turns, overrides = {}, { gapMs = JOB_GAP_MS, now = Date.now() } = {}) {
  const merges = overrides?.merges || {};
  const names = overrides?.names || {};
  const byConv = new Map();
  for (const t of turns) {
    if (!byConv.has(t.conversationId)) byConv.set(t.conversationId, []);
    byConv.get(t.conversationId).push(t);
  }
  const jobs = [];
  for (const [conv, list] of byConv) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    const solo = isBackground(conv);
    let job = null;
    let activeUntil = 0;
    const mine = [];
    for (const t of list) {
      const end = Math.max(t.endedAt || now, t.lastCallAt || 0);
      if (!job || solo || t.startedAt - activeUntil > gapMs) {
        job = { key: t.turnId, conversationId: conv, turns: [] };
        mine.push(job);
        activeUntil = 0;
      }
      job.turns.push(t);
      activeUntil = Math.max(activeUntil, end);
    }
    // Merges someone asked for: a job joins the one before it in the same chat.
    for (let i = mine.length - 1; i > 0; i--) {
      if (merges[mine[i].key] && mine.slice(0, i).some((j) => j.key === merges[mine[i].key])) {
        const into = mine.find((j) => j.key === merges[mine[i].key]);
        into.turns.push(...mine[i].turns);
        into.mergedKeys = [...(into.mergedKeys || []), mine[i].key, ...(mine[i].mergedKeys || [])];
        mine.splice(i, 1);
      }
    }
    jobs.push(...mine);
  }
  return jobs.map((j) => {
    j.turns.sort((a, b) => a.startedAt - b.startedAt);
    const first = j.turns[0];
    const last = j.turns.at(-1);
    const sums = j.turns.reduce((acc, t) => addSums(acc, t.sums), EMPTY);
    const models = new Map();
    for (const t of j.turns) if (t.model) models.set(t.model, (models.get(t.model) || 0) + (t.sums?.output || 0) + 1);
    const efforts = new Map();
    for (const t of j.turns) if (t.effort) efforts.set(t.effort, (efforts.get(t.effort) || 0) + 1);
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const endedAt = j.turns.some((t) => !t.endedAt) ? null : Math.max(...j.turns.map((t) => Math.max(t.endedAt || 0, t.lastCallAt || 0)));
    const providers = [...new Set(j.turns.map((t) => t.provider).filter(Boolean))];
    const costs = j.turns.map((t) => finiteCost(t.costUsd)).filter((v) => v != null);
    return {
      key: j.key,
      conversationId: j.conversationId,
      source: first.source || null,
      channel: channelOf(first.source, j.conversationId),
      name: names[j.key] || null,
      title: names[j.key] || first.title || promptTitle(first.prompt) || "Untitled",
      startedAt: first.startedAt,
      endedAt,
      lastTurnAt: last.startedAt,
      running: endedAt == null,
      turns: j.turns.length,
      turnIds: j.turns.map((t) => t.turnId),
      merged: !!merges[j.key] || !!j.mergedKeys?.length,
      mergedKeys: j.mergedKeys || [],
      models: top(models),
      effort: top(efforts)[0] || null,
      providers,
      providerLabels: providers.map(providerLabel),
      costUsd: costs.length ? cents(costs.reduce((a, b) => a + b, 0)) : null,
      costNote: costs.length && j.turns.every((t) => finiteCost(t.costUsd) == null || t.costNote === "exact") ? "exact" : costNoteOf(providers, costs.length > 0),
      ...figures(sums),
    };
  });
}

// ------------------------------------------------------------------ the index (database)

const GEN_OK = `g > 0 AND g <= ${MAX_GEN_MS} AND output <= g * ${MAX_TPS / 1000}`;   // a believable generation time (callSums)
const SUM_SQL = `COUNT(*) AS calls, COALESCE(SUM(input),0) AS input, COALESCE(SUM(cache_read),0) AS cacheRead,
  COALESCE(SUM(cache_write),0) AS cacheWrite, COALESCE(SUM(output),0) AS output,
  COALESCE(SUM(CASE WHEN ${GEN_OK} THEN g ELSE 0 END),0) AS genMs,
  COALESCE(SUM(CASE WHEN ${GEN_OK} THEN output ELSE 0 END),0) AS genOut,
  COALESCE(SUM(CASE WHEN ${GEN_OK} THEN input + cache_read + cache_write + output ELSE 0 END),0) AS genTokens`;
const CALLS = `(SELECT *, ended_at - started_at AS g FROM usage_calls)`;

const turnSums = (r) => ({ calls: r.calls, input: r.input, cacheRead: r.cache_read, cacheWrite: r.cache_write, output: r.output, genMs: r.gen_ms, genOut: r.gen_out, genTokens: r.gen_tokens });

export class UsageIndex {
  /**
   * db: the Tarsee database.
   * dirs: the transcript folders to read, each a path (the Claude plan's) or { dir, provider } (default:
   *   projectDirsByProvider(), looked up again on each read, because Claude Code only makes the folder on the
   *   first session).
   * backfillDays: how far back the first read goes (by a file's last change).
   * timeZone: the zone days and hours are counted in.
   * store: the settings store prices are read with (Local AI's own price); default: the database's settings.
   */
  constructor(db, { dirs = null, backfillDays = BACKFILL_DAYS, retentionDays = RETENTION_DAYS, now = () => Date.now(), timeZone = config.TIMEZONE, store = null } = {}) {
    this.db = db;
    this.dirs = dirs == null ? null : [].concat(dirs).map((d) => (typeof d === "string" ? { dir: d, provider: "claude" } : { dir: d.dir, provider: providerOf(d.provider) }));
    this._store = store;
    this.backfillDays = backfillDays;
    this.retentionDays = Math.max(backfillDays, retentionDays);
    this.now = now;
    this.timeZone = timeZone || "UTC";
    this.running = null;
    this.lastRefreshAt = 0;
    this.lastAsked = new Map();   // conversation -> the last message a person sent there (syncTurns)
    this.queuedAsked = new Map(); // turn id -> { at, asked }: a queued turn's message, kept until it begins (syncTurns)
    this.progress = { files: 0, done: 0, bytesLeft: 0, firstPass: true };
    db.exec(USAGE_SCHEMA);
    // The provider, engine and cost columns (migration 012), added only where missing: a database made some other
    // way gets them here, and migration 012 then finds them in place instead of adding them twice.
    ensureUsageColumns(db);
    this.q = {
      meta: db.prepare("SELECT value FROM usage_meta WHERE key = ?"),
      setMeta: db.prepare("INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      file: db.prepare("SELECT * FROM usage_files WHERE path = ?"),
      putFile: db.prepare(`INSERT INTO usage_files (path, session_id, agent_id, offset, size, mtime_ms, state) VALUES (@path, @session_id, @agent_id, @offset, @size, @mtime_ms, @state)
        ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtime_ms = excluded.mtime_ms, state = excluded.state`),
      // A call can be written over several lines and several reads: keep the widest span and the largest counts.
      // (Its cost is worked out again from those counts before it is placed: priceCalls.)
      putCall: db.prepare(`INSERT INTO usage_calls (id, session_id, agent_id, model, effort, started_at, ended_at, input, cache_read, cache_write, output, conversation_id, provider, engine)
        VALUES (@id, @session_id, @agent_id, @model, @effort, @startedAt, @endedAt, @input, @cacheRead, @cacheWrite, @output, (SELECT conversation_id FROM usage_sessions WHERE session_id = @session_id), @provider, @engine)
        ON CONFLICT(id) DO UPDATE SET
          started_at = CASE WHEN usage_calls.started_at IS NULL THEN excluded.started_at WHEN excluded.started_at IS NULL THEN usage_calls.started_at ELSE MIN(usage_calls.started_at, excluded.started_at) END,
          ended_at = MAX(usage_calls.ended_at, excluded.ended_at), input = MAX(usage_calls.input, excluded.input),
          cache_read = MAX(usage_calls.cache_read, excluded.cache_read), cache_write = MAX(usage_calls.cache_write, excluded.cache_write),
          output = MAX(usage_calls.output, excluded.output), placed = 0,
          provider = COALESCE(usage_calls.provider, excluded.provider), engine = COALESCE(usage_calls.engine, excluded.engine)`),
      putPrompt: db.prepare("INSERT OR IGNORE INTO usage_prompts (session_id, at, head, tail) VALUES (?, ?, ?, ?)"),
      // A turn can be begun by recordDirect before its turn_start is read: the turn_start then fills in what it knows.
      putTurn: db.prepare(`INSERT INTO usage_turns (turn_id, conversation_id, source, model, effort, prompt, title, started_at, provider, engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET conversation_id = excluded.conversation_id, source = COALESCE(excluded.source, usage_turns.source),
          model = COALESCE(excluded.model, usage_turns.model), effort = COALESCE(excluded.effort, usage_turns.effort),
          prompt = COALESCE(excluded.prompt, usage_turns.prompt), title = COALESCE(excluded.title, usage_turns.title), started_at = excluded.started_at,
          provider = COALESCE(excluded.provider, usage_turns.provider), engine = COALESCE(excluded.engine, usage_turns.engine)`),
      // turn_end names who answered: the turn's own AI, or the backup model's when that answered instead (turn_start
      // named the chat's AI before the backup was chosen). An older turn_end that names none keeps turn_start's.
      endTurn: db.prepare(`UPDATE usage_turns SET ended_at = ?, stop_reason = ?, session_id = COALESCE(?, session_id),
        provider = COALESCE(?, provider), engine = COALESCE(?, engine) WHERE turn_id = ?`),
      turnProvider: db.prepare("SELECT provider FROM usage_turns WHERE turn_id = ?"),
      // The engine's own figure for a turn (turn_end costUsd), unless its calls are priced: their sum is then its cost.
      setReported: db.prepare(`UPDATE usage_turns SET cost_usd = ? WHERE turn_id = ?
        AND NOT EXISTS (SELECT 1 FROM usage_calls WHERE turn_id = ? AND cost_usd IS NOT NULL)`),
      // The provider's own figure (turn_end costExact: an Anthropic key's total, OpenRouter's usage.cost) stands, even
      // over the calls' sum at the catalog's prices.
      setExact: db.prepare("UPDATE usage_turns SET cost_usd = ?, cost_exact = 1 WHERE turn_id = ?"),
      // A reply is saved a moment after its turn ends: the turn that just ended takes it, else the one still running.
      msgTurn: db.prepare(`SELECT turn_id FROM usage_turns WHERE conversation_id = ? AND message_id IS NULL AND started_at <= ?
        AND (ended_at IS NULL OR ? - ended_at BETWEEN -5000 AND 120000) ORDER BY ended_at IS NULL, ended_at DESC, started_at DESC LIMIT 1`),
      setMsg: db.prepare("UPDATE usage_turns SET message_id = ? WHERE turn_id = ?"),
    };
  }

  meta(key, fallback = null) {
    try { const r = this.q.meta.get(key); return r ? JSON.parse(r.value) : fallback; } catch { return fallback; }
  }

  /** The settings store prices are read with: the one given, else the database's own (null for a bare test database). */
  settings() {
    if (this._store === null) {
      try { this._store = new SettingsStore(this.db); } catch { this._store = false; }
    }
    return this._store || null;
  }
  setMeta(key, value) { this.q.setMeta.run(key, JSON.stringify(value)); }

  /**
   * Bring everything up to date. One at a time: a call while a read runs gets that read's promise,
   * and one more read follows it (so a turn that ended meanwhile is not left for the next minute).
   */
  refresh() {
    if (this.running) { this.again = true; return this.running; }
    this.again = false;
    this.running = (async () => {
      try {
        this.syncTurns();
        await this.readTranscripts();
        this.syncTurns();
        this.priceCalls();
        this.mapSessions();
        this.placeCalls();
        this.prune();
        this.lastRefreshAt = this.now();
      } catch (err) {
        console.warn(`[usage] refresh failed: ${err.message}`);
      } finally {
        this.running = null;
        if (this.again) setImmediate(() => this.refresh());
      }
    })();
    return this.running;
  }

  /** Old prompts, calls and turns out (indexed deletes: cheap). */
  prune() {
    const now = this.now();
    this.db.prepare("DELETE FROM usage_prompts WHERE at < ?").run(now - PROMPT_KEEP_MS);
    const cut = now - this.retentionDays * DAY;
    this.db.prepare("DELETE FROM usage_calls WHERE ended_at < ?").run(cut);
    this.db.prepare("DELETE FROM usage_turns WHERE started_at < ?").run(cut);
  }

  /** New turn_start, turn_end and message events since the last look, into usage_turns. */
  syncTurns() {
    let last = this.meta("lastSeq", 0);
    const rows = this.db.prepare(`SELECT seq, conversation_id, turn_id, type, payload, created_at FROM conversation_events
      WHERE seq > ? AND type IN ('turn_queued', 'turn_start', 'turn_end', 'message') ORDER BY seq ASC LIMIT 20000`);
    for (;;) {
      let batch;
      try { batch = rows.all(last); } catch { return; }   // no events table (a bare test database)
      if (!batch.length) break;
      this.db.transaction(() => {
        for (const r of batch) {
          last = r.seq;
          let p = {};
          try { p = JSON.parse(r.payload || "{}"); } catch { /* {} */ }
          if (r.type === "message" && p.role === "user") {
            // The whole message the next turn answers (the turn's own copy stops at 300 characters): its name.
            this.lastAsked.set(r.conversation_id, { at: r.created_at, text: String(p.content || "").slice(0, 4000) });
          } else if (r.type === "turn_queued" && r.turn_id) {
            // It begins (turn_start) once the turn ahead is done, maybe minutes and messages later: the message it
            // answers is the one just before it was queued.
            this.queuedAsked.set(r.turn_id, { at: r.created_at, asked: this.lastAsked.get(r.conversation_id) || null });
          } else if (r.type === "turn_start" && r.turn_id) {
            const q = this.queuedAsked.get(r.turn_id);
            this.queuedAsked.delete(r.turn_id);
            const asked = q ? q.asked : this.lastAsked.get(r.conversation_id);
            const ref = q ? q.at : r.created_at;
            const words = asked && ref - asked.at <= 120_000 && ref >= asked.at - 5000 ? asked.text : p.prompt;
            // provider, engine: who ran it (the turn layer names them; a turn from before that is the Claude plan's).
            this.q.putTurn.run(r.turn_id, r.conversation_id, p.source || null, p.model || null, p.effort || null, String(p.prompt || "").slice(0, 300),
              promptTitle(words) || promptTitle(p.prompt) || null, r.created_at, normalizeProviderId(p.provider), typeof p.engine === "string" ? p.engine : null);
          } else if (r.type === "turn_end" && r.turn_id) {
            this.queuedAsked.delete(r.turn_id);   // (taken out of the queue: it never began)
            // sessionId: the session the turn ran in, raw or as a stored handle (untagged: transcripts are named by the raw id).
            this.q.endTurn.run(r.created_at, p.stopReason || null, untag(p.sessionId) || null, normalizeProviderId(p.provider), typeof p.engine === "string" ? p.engine : null, r.turn_id);
            // Its sums again, under the AI that answered: calls already placed while turn_start's AI was named (a
            // read mid-turn, recordDirect's Codex call) were summed as that AI's, a plan's at no cost. A turn with no
            // calls yet keeps the cost it has; the calls placed later sum it again.
            this.resumTurns([r.turn_id]);
            // costUsd: the engine's figure (an Anthropic key's exact total). A plan's turn never gets one.
            const reported = finiteCost(p.costUsd);
            if (reported != null && !isPlanProvider(this.q.turnProvider.get(r.turn_id)?.provider)) {
              if (p.costExact === true) this.q.setExact.run(reported, r.turn_id);
              else this.q.setReported.run(reported, r.turn_id, r.turn_id);
            }
          } else if (r.type === "message" && p.role === "assistant" && p.id) {
            const t = this.q.msgTurn.get(r.conversation_id, r.created_at, r.created_at);
            if (t) this.q.setMsg.run(p.id, t.turn_id);
          }
        }
        this.setMeta("lastSeq", last);
      })();
      if (batch.length < 20000) break;
    }
  }

  /** Every transcript file: [{ path, sessionId, agentId, provider }] (provider: whose Claude Code home it is in). */
  listFiles() {
    const out = [];
    for (const { dir, provider } of this.dirs || projectDirsByProvider()) {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of names) {
        if (e.isFile() && e.name.endsWith(".jsonl")) out.push({ path: path.join(dir, e.name), sessionId: e.name.slice(0, -6), agentId: null, provider });
        else if (e.isDirectory()) {
          const sub = path.join(dir, e.name, "subagents");
          let agents = [];
          try { agents = fs.readdirSync(sub); } catch { continue; }
          for (const a of agents) {
            const m = /^agent-([\w-]+)\.jsonl$/.exec(a);
            if (m) out.push({ path: path.join(sub, a), sessionId: e.name, agentId: m[1], provider });
          }
        }
      }
    }
    return out;
  }

  /** Read what each transcript gained since the last read, a slice at a time. */
  async readTranscripts() {
    const files = this.listFiles();
    const since = this.now() - this.backfillDays * DAY;
    const todo = [];
    let bytes = 0;
    for (const f of files) {
      let st;
      try { st = fs.statSync(f.path); } catch { continue; }
      const known = this.q.file.get(f.path);
      if (!known) {
        // Older than the backfill: start at its end (only what it gains from now on is read).
        if (st.mtimeMs < since) { this.q.putFile.run({ path: f.path, session_id: f.sessionId, agent_id: f.agentId, offset: st.size, size: st.size, mtime_ms: Math.round(st.mtimeMs), state: null }); continue; }
        todo.push({ ...f, offset: 0, size: st.size, mtimeMs: st.mtimeMs, state: newReadState() });
        bytes += st.size;
        continue;
      }
      if (st.size === known.offset) continue;
      let state = newReadState();
      try { state = { ...state, ...JSON.parse(known.state || "{}") }; } catch { /* fresh */ }
      const offset = st.size < known.offset ? 0 : known.offset;   // rewritten: read again from the top (calls are kept by id, so nothing counts twice)
      todo.push({ ...f, offset, size: st.size, mtimeMs: st.mtimeMs, state });
      bytes += st.size - offset;
    }
    this.progress = { files: todo.length, done: 0, bytesLeft: bytes, firstPass: !this.meta("backfilled", false) };
    let sliceStart = Date.now();
    for (const f of todo) {
      await this.readFile(f, async () => {
        if (Date.now() - sliceStart > SLICE_MS) { await new Promise((r) => setImmediate(r)); sliceStart = Date.now(); }
      });
      this.progress.done += 1;
    }
    if (!this.meta("backfilled", false)) this.setMeta("backfilled", true);
    this.progress.firstPass = false;
  }

  /** Read one file from its offset to the size it had when listed, committing the offset after each chunk. */
  async readFile(f, breathe) {
    let fd;
    try { fd = fs.openSync(f.path, "r"); } catch { return; }
    try {
      let pos = f.offset;
      let partial = "";
      const end = f.size;
      while (pos < end) {
        const len = Math.min(CHUNK, end - pos);
        const buf = Buffer.allocUnsafe(len);
        const got = fs.readSync(fd, buf, 0, len, pos);
        if (got <= 0) break;
        const text = partial + buf.toString("utf8", 0, got);
        const cut = text.lastIndexOf("\n");
        pos += got;
        if (cut < 0) { partial = text; continue; }
        // A line still being written stays for the next read: the offset stops at the last newline.
        partial = text.slice(cut + 1);
        const { calls, prompts } = parseTranscriptLines(text.slice(0, cut).split("\n"), f.state);
        const offset = pos - Buffer.byteLength(partial, "utf8");
        this.db.transaction(() => {
          for (const c of calls) this.q.putCall.run({ ...c, session_id: f.sessionId, agent_id: f.agentId, provider: f.provider || "claude", engine: "claude-code" });
          for (const p of prompts) this.q.putPrompt.run(f.sessionId, p.at, p.head, p.tail || null);
          this.q.putFile.run({ path: f.path, session_id: f.sessionId, agent_id: f.agentId, offset, size: f.size, mtime_ms: Math.round(f.mtimeMs), state: JSON.stringify(f.state) });
        })();
        this.progress.bytesLeft = Math.max(0, this.progress.bytesLeft - got);
        await breathe();
      }
    } finally {
      try { fs.closeSync(fd); } catch { /* closed */ }
    }
  }

  /**
   * Price each call read since the last placement, at its own moment, from its counts as they now stand (a call
   * written over several reads is priced once it is whole). A plan's calls, and an Anthropic key's (its engine
   * reports the exact cost on the turn), stay null.
   */
  priceCalls() {
    const rows = this.db.prepare(`SELECT id, provider, model, ended_at AS endedAt, input, cache_read AS cacheRead, cache_write AS cacheWrite, output
      FROM usage_calls WHERE placed = 0`).all();
    if (!rows.length) return;
    const store = this.settings();
    const set = this.db.prepare("UPDATE usage_calls SET cost_usd = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const r of rows) set.run(priceUsage(providerOf(r.provider), r.model, r, r.endedAt, store), r.id);
    })();
  }

  /** Give each session with new calls its conversation, when it can be known. */
  mapSessions() {
    const sessions = this.db.prepare(`SELECT c.session_id AS id, s.conversation_id AS conv
      FROM usage_calls c LEFT JOIN usage_sessions s ON s.session_id = c.session_id
      WHERE c.placed = 0 GROUP BY c.session_id`).all();
    // A session a turn has just named (its turn_end), whose calls were read before anyone knew whose they were.
    const named = this.db.prepare(`SELECT DISTINCT t.session_id AS id FROM usage_turns t LEFT JOIN usage_sessions s ON s.session_id = t.session_id
      WHERE t.session_id IS NOT NULL AND s.conversation_id IS NULL`).all();
    for (const n of named) if (!sessions.some((s) => s.id === n.id)) sessions.push({ id: n.id, conv: null });
    if (!sessions.length) return;
    // The stored session is a handle (ai/session-handle.js): "deepseek/cc/deepseek:<id>" for every provider but the
    // plan, whose ids stay bare. Transcripts are named by the raw id.
    const byClaude = new Map();
    try {
      for (const r of this.db.prepare("SELECT id, claude_session_id AS sid FROM conversations WHERE claude_session_id IS NOT NULL").all()) {
        const raw = untag(r.sid);
        if (raw) byClaude.set(raw, r.id);
      }
    } catch { /* no conversations table */ }
    const byTurnEnd = new Map(this.db.prepare("SELECT session_id AS sid, conversation_id AS conv FROM usage_turns WHERE session_id IS NOT NULL").all().map((r) => [r.sid, r.conv]));
    const promptsOf = this.db.prepare("SELECT at, head, tail FROM usage_prompts WHERE session_id = ? ORDER BY at LIMIT 400");
    const turnsNear = this.db.prepare("SELECT conversation_id AS conversationId, started_at AS startedAt, prompt FROM usage_turns WHERE started_at BETWEEN ? AND ? ORDER BY started_at DESC");
    const put = this.db.prepare(`INSERT INTO usage_sessions (session_id, conversation_id, how, checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET conversation_id = excluded.conversation_id, how = excluded.how, checked_at = excluded.checked_at`);
    const stamp = this.db.prepare("UPDATE usage_calls SET conversation_id = ?, placed = 0 WHERE session_id = ? AND (placed = 0 OR conversation_id IS NULL)");
    const now = this.now();
    this.db.transaction(() => {
      for (const s of sessions) {
        let conv = s.conv || null, how = null;
        if (!conv) {
          if (byTurnEnd.has(s.id)) { conv = byTurnEnd.get(s.id); how = "turn"; }
          else if (byClaude.has(s.id)) { conv = byClaude.get(s.id); how = "conversation"; }
          else {
            const prompts = promptsOf.all(s.id);
            if (prompts.length) {
              const turns = turnsNear.all(prompts[0].at - 6 * H, prompts.at(-1).at + 60_000);
              conv = matchSession(prompts, turns);
              how = conv ? (conv.startsWith("cron:") ? "cron" : "prompt") : null;
            }
          }
          put.run(s.id, conv, how || (conv ? "known" : "none"), now);
        }
        if (conv) stamp.run(conv, s.id);
      }
    })();
  }

  /** Each new call to its turn, and the sums of the turns that changed. */
  placeCalls() {
    const convs = this.db.prepare("SELECT DISTINCT conversation_id AS id FROM usage_calls WHERE placed = 0 AND conversation_id IS NOT NULL").all().map((r) => r.id);
    const turnsOf = this.db.prepare("SELECT turn_id AS turnId, started_at AS startedAt, ended_at AS endedAt FROM usage_turns WHERE conversation_id = ? ORDER BY started_at ASC");
    const callsOf = this.db.prepare("SELECT id, agent_id AS agentId, started_at AS startedAt, ended_at AS endedAt FROM usage_calls WHERE placed = 0 AND conversation_id = ?");
    const agentStart = this.db.prepare("SELECT MIN(COALESCE(started_at, ended_at)) AS at FROM usage_calls WHERE session_id = (SELECT session_id FROM usage_calls WHERE id = ?) AND agent_id = ?");
    const setTurn = this.db.prepare("UPDATE usage_calls SET turn_id = ?, placed = 1 WHERE id = ?");
    const dirty = new Set();
    const now = this.now();
    this.db.transaction(() => {
      for (const conv of convs) {
        const turns = turnsOf.all(conv);
        const agentTurn = new Map();
        for (const c of callsOf.all(conv)) {
          let t;
          if (c.agentId) {
            // An agent's calls all go to the turn that started it, however long it ran.
            if (!agentTurn.has(c.agentId)) agentTurn.set(c.agentId, pickTurn(turns, agentStart.get(c.id, c.agentId)?.at ?? c.endedAt, now));
            t = agentTurn.get(c.agentId);
          } else t = pickTurn(turns, c.startedAt || c.endedAt, now);
          setTurn.run(t?.turnId || null, c.id);
          if (t) dirty.add(t.turnId);
        }
      }
      // Calls of sessions no conversation claims: counted in the totals, in no turn.
      this.db.prepare("UPDATE usage_calls SET placed = 1 WHERE placed = 0 AND conversation_id IS NULL AND session_id IN (SELECT session_id FROM usage_sessions WHERE conversation_id IS NULL)").run();
      this.resumTurns(dirty);
    })();
  }

  /**
   * Each turn's sums from the calls placed in it: tokens, timing, its main model and effort, who ran it (the turn's
   * own provider and engine, else its calls'), and its cost (the calls' sum when they are priced, else the engine's
   * figure already on it; never any for a plan).
   */
  resumTurns(turnIds) {
    if (!this.q.agg) {
      this.q.agg = this.db.prepare(`SELECT ${SUM_SQL}, MIN(COALESCE(started_at, ended_at)) AS firstAt, MAX(ended_at) AS lastAt FROM ${CALLS} WHERE turn_id = ?`);
      this.q.top = this.db.prepare("SELECT model, effort, SUM(output) + COUNT(*) AS w FROM usage_calls WHERE turn_id = ? AND agent_id IS NULL GROUP BY model, effort ORDER BY w DESC LIMIT 1");
      this.q.who = this.db.prepare(`SELECT provider, engine FROM usage_calls WHERE turn_id = ? AND provider IS NOT NULL
        GROUP BY provider, engine ORDER BY SUM(output) + COUNT(*) DESC LIMIT 1`);
      this.q.callCost = this.db.prepare("SELECT SUM(cost_usd) AS usd FROM usage_calls WHERE turn_id = ? AND cost_usd IS NOT NULL");
      this.q.save = this.db.prepare(`UPDATE usage_turns SET calls = @calls, input = @input, cache_read = @cacheRead, cache_write = @cacheWrite, output = @output,
        gen_ms = @genMs, gen_out = @genOut, gen_tokens = @genTokens, first_call_at = @firstAt, last_call_at = @lastAt, call_model = @model, call_effort = @effort,
        provider = COALESCE(provider, @provider), engine = COALESCE(engine, @engine),
        cost_usd = CASE WHEN @plan = 1 THEN NULL WHEN cost_exact = 1 THEN cost_usd WHEN @cost IS NOT NULL THEN @cost ELSE cost_usd END WHERE turn_id = @turnId`);
    }
    for (const turnId of turnIds) {
      const s = this.q.agg.get(turnId);
      const m = this.q.top.get(turnId) || {};
      const who = this.q.who.get(turnId) || {};
      const provider = this.q.turnProvider.get(turnId)?.provider || who.provider || null;
      const cost = this.q.callCost.get(turnId)?.usd;
      this.q.save.run({
        ...s, model: m.model || null, effort: m.effort || null, turnId,
        provider: who.provider || null, engine: who.engine || null,
        plan: isPlanProvider(provider) ? 1 : 0, cost: cost == null ? null : cents(cost),
      });
    }
  }

  /**
   * A turn from an engine that keeps no Claude Code transcript (Codex), recorded once, at its end, directly on its
   * turn (design 4.13). turn:
   *   turnId, conversationId     the live turn and its conversation (required)
   *   provider, engine, model, effort
   *   threadId or sessionId      the engine's session (a stored handle is untagged)
   *   startedAt, endedAt         ms (or anything Date takes); endedAt defaults to now
   *   usage                      { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost? }
   *                              (input_tokens WITHOUT the cache reads), or input, output, cacheRead, cacheWrite on turn
   *   costUsd                    a cost the engine or provider reported; else the provider's price table
   *   id                         default "<engine>:<threadId>:<turnId>"
   * The call goes in already placed and the turn's sums are worked out again, so recording the same turn twice
   * replaces it. Its start time is not kept: a Codex turn's time includes its tools, so no speed is made up.
   * A Claude Code turn is refused ({ recorded: false, reason: "transcript" }): its transcript is the record.
   * A plan's turn records its tokens and no cost. Returns { recorded, id, costUsd } or { recorded: false, reason }.
   */
  recordDirect(turn = {}) {
    const provider = normalizeProviderId(turn.provider);
    if (!provider) return { recorded: false, reason: "provider" };
    const model = typeof turn.model === "string" && turn.model.trim() ? turn.model.trim() : null;
    const engine = typeof turn.engine === "string" && turn.engine ? turn.engine : engineFor(provider, model, this.settings());
    if (!engine || engine === "claude-code") return { recorded: false, reason: "transcript" };
    const turnId = typeof turn.turnId === "string" ? turn.turnId.trim() : "";
    if (!turnId) return { recorded: false, reason: "turn" };
    // The turn's turn_start may not have been read yet: read the timeline first, so the call lands on a full turn.
    this.syncTurns();
    // A known turn keeps its own conversation (a background job's live id, "cron:<id>"), whatever chat the caller
    // names; an unknown one needs the caller's.
    const known = this.db.prepare("SELECT conversation_id AS conv FROM usage_turns WHERE turn_id = ?").get(turnId)?.conv || null;
    const conversationId = known || (typeof turn.conversationId === "string" ? turn.conversationId.trim() : "");
    if (!conversationId) return { recorded: false, reason: "turn" };
    const t = tokensOf(turn.usage || turn);
    if (!(t.input + t.output + t.cacheRead + t.cacheWrite)) return { recorded: false, reason: "empty" };
    const endedAt = toMs(turn.endedAt) ?? this.now();
    const startedAt = toMs(turn.startedAt) ?? endedAt;
    const thread = untag(turn.threadId) || untag(turn.sessionId) || null;
    const sessionId = thread || `direct:${turnId}`;
    const id = typeof turn.id === "string" && turn.id ? turn.id : `${engine}:${thread || "none"}:${turnId}`;
    const plan = getProvider(provider).kind === "subscription";
    const reported = finiteCost(turn.costUsd);
    const cost = plan ? null : (reported ?? priceUsage(provider, model, { ...t, cost: turn.usage?.cost ?? turn.usage?.costUsd }, endedAt, this.settings()));
    const effort = typeof turn.effort === "string" && turn.effort ? turn.effort : null;
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO usage_turns (turn_id, conversation_id, model, effort, started_at, provider, engine) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(turnId, conversationId, model, effort, startedAt, provider, engine);
      this.db.prepare(`INSERT INTO usage_calls (id, session_id, agent_id, model, effort, started_at, ended_at, input, cache_read, cache_write, output,
          conversation_id, turn_id, placed, provider, engine, cost_usd)
        VALUES (@id, @sessionId, NULL, @model, @effort, NULL, @endedAt, @input, @cacheRead, @cacheWrite, @output, @conversationId, @turnId, 1, @provider, @engine, @cost)
        ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, model = excluded.model, effort = excluded.effort, ended_at = excluded.ended_at,
          input = excluded.input, cache_read = excluded.cache_read, cache_write = excluded.cache_write, output = excluded.output,
          conversation_id = excluded.conversation_id, turn_id = excluded.turn_id, placed = 1, provider = excluded.provider, engine = excluded.engine,
          cost_usd = excluded.cost_usd`)
        .run({ id, sessionId, model, effort, endedAt, ...t, conversationId, turnId, provider, engine, cost: cost == null ? null : cents(cost) });
      this.resumTurns([turnId]);
    })();
    return { recorded: true, id, costUsd: cost == null ? null : cents(cost) };
  }

  // ------------------------------------------------------------------ reading the sums

  /** Sums of every call that ended in [from, to). where: more SQL conditions (providerSql). */
  sumsBetween(from, to = Number.MAX_SAFE_INTEGER, where = "", ...args) {
    return this.db.prepare(`SELECT ${SUM_SQL} FROM ${CALLS} WHERE ended_at >= ? AND ended_at < ? ${where}`).get(from, to, ...args);
  }

  /** The providers that did work in [from, to) (by their calls), as public ids. */
  providersBetween(from, to = Number.MAX_SAFE_INTEGER, provider = null) {
    const rows = this.db.prepare(`SELECT DISTINCT COALESCE(provider, 'claude') AS p FROM usage_calls WHERE ended_at >= ? AND ended_at < ? ${providerSql(provider)}`).all(from, to);
    return new Set(rows.map((r) => providerOf(r.p)));
  }

  /**
   * What the work in [from, to) cost: { costUsd, costNote } (ai/spend.js spendBetween: each turn once, calls in no
   * turn once; costNoteOf for the note). costUsd is null when nothing priced was done.
   */
  spendOf(from, to = Number.MAX_SAFE_INTEGER, provider = null) {
    const s = spendBetween(this.db, from, to, { provider });
    const priced = Object.keys(s.byProvider);
    const present = this.providersBetween(from, to, provider);
    for (const p of priced) present.add(p);
    const exact = priced.length > 0 && this.estimatedBetween(from, to, provider) === 0;
    return { costUsd: priced.length ? s.totalUsd : null, costNote: exact ? "exact" : costNoteOf(present, priced.length > 0, this.settings()) };
  }

  /**
   * How many priced turns (and calls in no turn) in [from, to) carry an estimate rather than the provider's own
   * figure: none means the total is exact. The same rows spendBetween adds up.
   */
  estimatedBetween(from, to = Number.MAX_SAFE_INTEGER, provider = null) {
    const pf = providerSql(provider);
    return this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM usage_turns WHERE cost_usd IS NOT NULL AND COALESCE(cost_exact, 0) = 0
          AND COALESCE(ended_at, last_call_at, started_at) >= ? AND COALESCE(ended_at, last_call_at, started_at) < ? ${pf})
      + (SELECT COUNT(*) FROM usage_calls WHERE cost_usd IS NOT NULL AND turn_id IS NULL AND ended_at >= ? AND ended_at < ? ${pf}) AS n`)
      .get(from, to, from, to).n;
  }

  /** Turns as groupJobs takes them, started in [from, to); provider: only that provider's turns. */
  turnsBetween(from, to = Number.MAX_SAFE_INTEGER, conversationId = null, provider = null) {
    const rows = this.db.prepare(`SELECT * FROM usage_turns WHERE started_at >= ? AND started_at < ? ${conversationId ? "AND conversation_id = ?" : ""} ${providerSql(provider)} ORDER BY started_at`)
      .all(...[from, to, ...(conversationId ? [conversationId] : [])]);
    return rows.map((r) => this.turnRow(r));
  }

  turnRow(r) {
    const provider = providerOf(r.provider);
    const costUsd = isPlanProvider(provider) ? null : finiteCost(r.cost_usd);
    return {
      turnId: r.turn_id, conversationId: r.conversation_id, source: r.source, prompt: r.prompt, title: r.title || null,
      startedAt: r.started_at, endedAt: r.ended_at, lastCallAt: r.last_call_at, firstCallAt: r.first_call_at,
      model: r.call_model ? modelLabel(r.call_model, provider) : null, modelId: r.call_model || null,   // (no calls: no model to name)
      effort: r.call_effort || r.effort || null,
      provider, providerLabel: providerLabel(provider), engine: r.engine || (provider === "claude" ? "claude-code" : null),
      costUsd, costNote: costUsd != null && r.cost_exact === 1 ? "exact" : costNoteOf([provider], costUsd != null, this.settings()),
      messageId: r.message_id || null, stopReason: r.stop_reason || null, sums: turnSums(r),
    };
  }

  /** A turn as the page shows it: its figures, how long it took, who ran it and what it cost. */
  turnView(t, now = this.now()) {
    return {
      turnId: t.turnId, conversationId: t.conversationId, messageId: t.messageId, source: t.source,
      title: t.title || promptTitle(t.prompt), startedAt: t.startedAt, endedAt: t.endedAt, running: !t.endedAt,
      ms: Math.max(t.endedAt || now, t.lastCallAt || 0) - t.startedAt, model: t.model, modelId: t.modelId ?? null, effort: t.effort,
      provider: t.provider ?? null, providerLabel: t.providerLabel ?? null, engine: t.engine ?? null,
      costUsd: t.costUsd ?? null, costNote: t.costNote ?? null, ...figures(t.sums),
    };
  }

  /** Conversation titles, for names the page cannot work out itself (background jobs have no conversation row). */
  titles(ids) {
    const out = {};
    const q = this.db.prepare("SELECT title FROM conversations WHERE id = ?");
    for (const id of ids) {
      if (!id) continue;
      if (id.startsWith("cron:")) { out[id] = `Cron · ${id.slice(5).replace(/^cron_/, "")}`; continue; }   // (as the sidebar names it)
      if (id === "heartbeat") { out[id] = "Heartbeat"; continue; }
      if (id === "boot") { out[id] = "Boot checklist"; continue; }
      try { out[id] = q.get(id)?.title || null; } catch { out[id] = null; }
    }
    return out;
  }

  /** Jobs with a turn in [from, to), newest first. provider: only that provider's turns. */
  jobs({ from, to = Number.MAX_SAFE_INTEGER, conversationId = null, overrides = {}, now = this.now(), provider = null } = {}) {
    // A job that began before `from` still shows whole: its earlier turns come with it (up to a day back).
    const turns = this.turnsBetween(from - DAY, to, conversationId, provider);
    return groupJobs(turns, overrides, { now })
      .filter((j) => (j.endedAt ?? now) >= from && j.startedAt < to)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * The overview page's numbers. windows: { fiveHour: { usedPct, resetsAt }, sevenDay: { … } } when
   * something reads the plan's own limits; null here, so the windows are simply the last 5 hours and
   * the last 7 days. provider: only that provider's work (`providers` still lists every one that did any
   * this week, for the filter). Every total carries costUsd and costNote (costNoteOf).
   */
  overview({ windows = null, overrides = {}, now = this.now(), provider = null } = {}) {
    const tz = this.timeZone;
    const only = provider ? normalizeProviderId(provider) : null;
    const pf = providerSql(only);
    const today = localMidnight(now, tz);
    const week = now - 7 * DAY;
    const fig = (s) => figures(s);
    const out = {
      at: now,
      timeZone: tz,
      provider: only,
      today: { ...fig(this.sumsBetween(today, Number.MAX_SAFE_INTEGER, pf)), ...this.spendOf(today, Number.MAX_SAFE_INTEGER, only) },
      week: { ...fig(this.sumsBetween(week, Number.MAX_SAFE_INTEGER, pf)), ...this.spendOf(week, Number.MAX_SAFE_INTEGER, only) },
      windows: {},
    };
    const fiveFrom = windows?.fiveHour?.resetsAt && !windows.fiveHour.expired ? windows.fiveHour.resetsAt - 5 * H : now - 5 * H;
    const weekFrom = windows?.sevenDay?.resetsAt && !windows.sevenDay.expired ? windows.sevenDay.resetsAt - 7 * DAY : week;
    out.windows.fiveHour = { from: fiveFrom, resetsAt: windows?.fiveHour?.expired ? null : windows?.fiveHour?.resetsAt || null, usedPct: windows?.fiveHour?.expired ? 0 : windows?.fiveHour?.usedPct ?? null, ...fig(this.sumsBetween(fiveFrom, Number.MAX_SAFE_INTEGER, pf)), ...this.spendOf(fiveFrom, Number.MAX_SAFE_INTEGER, only) };
    out.windows.sevenDay = { from: weekFrom, resetsAt: windows?.sevenDay?.expired ? null : windows?.sevenDay?.resetsAt || null, usedPct: windows?.sevenDay?.expired ? 0 : windows?.sevenDay?.usedPct ?? null, ...fig(this.sumsBetween(weekFrom, Number.MAX_SAFE_INTEGER, pf)), ...this.spendOf(weekFrom, Number.MAX_SAFE_INTEGER, only) };

    // Who did the work this week, for the filter (every provider, whatever the filter).
    const seen = new Set(this.providersBetween(week));
    for (const p of Object.keys(spendBetween(this.db, week).byProvider)) seen.add(p);
    out.providers = PROVIDER_IDS.filter((id) => seen.has(id)).map((id) => ({ id, label: providerLabel(id), kind: getProvider(id).kind }));

    // By provider: tokens from the calls, spend from the turns (and calls in no turn).
    const store = this.settings();
    const provSpend = spendBetween(this.db, week, Number.MAX_SAFE_INTEGER, { provider: only }).byProvider;
    const provSums = new Map();
    for (const r of this.db.prepare(`SELECT COALESCE(provider, 'claude') AS p, ${SUM_SQL} FROM ${CALLS} WHERE ended_at >= ? ${pf} GROUP BY COALESCE(provider, 'claude')`).all(week)) {
      const id = providerOf(r.p);
      provSums.set(id, addSums(provSums.get(id), r));
    }
    for (const id of Object.keys(provSpend)) if (!provSums.has(id)) provSums.set(id, EMPTY);
    out.byProvider = [...provSums].map(([id, s]) => {
      const usd = provSpend[id] ?? null;
      const exact = usd != null && this.estimatedBetween(week, Number.MAX_SAFE_INTEGER, id) === 0;
      return { provider: id, label: providerLabel(id), kind: getProvider(id)?.kind || null, costUsd: usd, costNote: exact ? "exact" : costNoteOf([id], usd != null, store), ...fig(s) };
    }).sort((a, b) => b.total - a.total);

    // By model, within its provider ("DeepSeek Flash" on DeepSeek), with what its turns cost.
    const models = new Map();
    const keyOf = (p, label) => `${p}\u0000${label}`;
    for (const r of this.db.prepare(`SELECT COALESCE(provider, 'claude') AS p, model, ${SUM_SQL} FROM ${CALLS} WHERE ended_at >= ? ${pf} GROUP BY COALESCE(provider, 'claude'), model`).all(week)) {
      const p = providerOf(r.p);
      const label = r.model ? modelLabel(r.model, p) : DEFAULT_MODEL_LABEL;
      const k = keyOf(p, label);
      const m = models.get(k) || { provider: p, model: label, modelId: r.model || null, sums: EMPTY, usd: null };
      m.sums = addSums(m.sums, r);
      models.set(k, m);
    }
    const modelCost = this.db.prepare(`SELECT p, m, SUM(c) AS usd, SUM(e) AS est FROM (
        SELECT COALESCE(provider, 'claude') AS p, COALESCE(call_model, model) AS m, cost_usd AS c, 1 - COALESCE(cost_exact, 0) AS e FROM usage_turns
          WHERE cost_usd IS NOT NULL AND COALESCE(ended_at, last_call_at, started_at) >= ? ${pf}
        UNION ALL
        SELECT COALESCE(provider, 'claude') AS p, model AS m, cost_usd AS c, 1 AS e FROM usage_calls
          WHERE cost_usd IS NOT NULL AND turn_id IS NULL AND ended_at >= ? ${pf}
      ) GROUP BY p, m`).all(week, week);
    for (const r of modelCost) {
      const p = providerOf(r.p);
      if (isPlanProvider(p)) continue;
      const label = r.m ? modelLabel(r.m, p) : DEFAULT_MODEL_LABEL;
      const k = keyOf(p, label);
      const m = models.get(k) || { provider: p, model: label, modelId: r.m || null, sums: EMPTY, usd: null };
      m.usd = cents((m.usd || 0) + (Number(r.usd) || 0));
      m.est = (m.est || 0) + (Number(r.est) || 0);
      models.set(k, m);
    }
    out.byModel = [...models.values()].map((m) => ({
      model: m.model, modelId: m.modelId, provider: m.provider, providerLabel: providerLabel(m.provider),
      costUsd: m.usd, costNote: m.usd != null && m.est === 0 ? "exact" : costNoteOf([m.provider], m.usd != null, store), ...fig(m.sums),
    })).sort((a, b) => b.total - a.total);

    const chan = this.db.prepare(`SELECT conversation_id AS conv, source, ${SUM_SQL} FROM (
        SELECT c.*, c.ended_at - c.started_at AS g, t.source AS source FROM usage_calls c LEFT JOIN usage_turns t ON t.turn_id = c.turn_id WHERE c.ended_at >= ? ${providerSql(only, "c.provider")}
      ) GROUP BY conversation_id, source`).all(week);
    const byChannel = new Map();
    const byChat = new Map();
    for (const r of chan) {
      const label = r.conv ? channelOf(r.source || this.sourceOf(r.conv), r.conv) : "Not in a chat";
      byChannel.set(label, addSums(byChannel.get(label), r));
      const key = r.conv || "";
      byChat.set(key, addSums(byChat.get(key), r));
    }
    out.byChannel = [...byChannel].map(([channel, s]) => ({ channel, ...fig(s) })).sort((a, b) => b.total - a.total);
    const titles = this.titles([...byChat.keys()]);
    out.byChat = [...byChat].map(([id, s]) => ({ conversationId: id || null, title: id ? titles[id] || null : "Not in a chat", ...fig(s) }))
      .sort((a, b) => b.total - a.total).slice(0, 10);

    const jobs = this.jobs({ from: week, overrides, now, provider: only });
    out.jobsThisWeek = jobs.length;
    out.heaviest = [...jobs].sort((a, b) => b.total - a.total).slice(0, 6);
    const jt = this.titles([...new Set(out.heaviest.map((j) => j.conversationId))]);
    for (const j of out.heaviest) j.chatTitle = jt[j.conversationId] || null;

    // Speed: the week's average, and its fastest call with enough output to mean something.
    const peak = this.db.prepare(`SELECT model, provider, output, ended_at - started_at AS g, ended_at AS at FROM usage_calls
      WHERE ended_at >= ? AND started_at IS NOT NULL AND output >= 500 AND ended_at - started_at BETWEEN 1000 AND ${MAX_GEN_MS}
        AND output <= (ended_at - started_at) * ${MAX_TPS / 1000} ${pf}
      ORDER BY output * 1.0 / (ended_at - started_at) DESC LIMIT 1`).get(week);
    out.speed = {
      outTps: out.week.outTps, totalTps: out.week.totalTps,
      peak: peak ? { outTps: Math.round((peak.output / (peak.g / 1000)) * 10) / 10, model: modelLabel(peak.model, providerOf(peak.provider)), output: peak.output, at: peak.at } : null,
      byModel: out.byModel.filter((m) => m.outTps != null).map((m) => ({ model: m.model, provider: m.provider, outTps: m.outTps })),
    };

    // Each local day of the last 14 (from midnight to midnight, so a day with a clock change is 23 or 25 hours),
    // with what it cost, and each local hour of the last 24.
    const starts = dayStarts(now, 14, tz);
    out.days = starts.map((from, i) => {
      const to = starts[i + 1] ?? Number.MAX_SAFE_INTEGER;
      return { day: localDay(from + H, tz), from, ...fig(this.sumsBetween(from, to, pf)), ...this.spendOf(from, to, only) };
    });
    const off = zoneOffsetMs(now, tz);
    const hour0 = Math.floor((now + off) / H) * H - off - 23 * H;   // (a zone half an hour off UTC has its hours on the half hour)
    const hourRows = this.db.prepare(`SELECT CAST((ended_at - ?) / ${H} AS INTEGER) AS h, ${SUM_SQL} FROM ${CALLS} WHERE ended_at >= ? ${pf} GROUP BY h`).all(hour0, hour0);
    out.hours = Array.from({ length: 24 }, (_, i) => ({ from: hour0 + i * H, ...fig(hourRows.find((x) => x.h === i) || EMPTY) }));
    out.progress = this.status();
    return out;
  }

  /** The source a conversation's turns most often came from. */
  sourceOf(conv) {
    try { return this.db.prepare("SELECT source FROM usage_turns WHERE conversation_id = ? AND source IS NOT NULL GROUP BY source ORDER BY COUNT(*) DESC LIMIT 1").get(conv)?.source || null; } catch { return null; }
  }

  /** A chat's running total (with what it cost) and each of its turns (keyed by the reply they ended in). */
  chat(conversationId, { now = this.now() } = {}) {
    const total = figures(this.db.prepare(`SELECT ${SUM_SQL} FROM ${CALLS} WHERE conversation_id = ?`).get(conversationId));
    const first = this.db.prepare("SELECT MIN(ended_at) AS at FROM usage_calls WHERE conversation_id = ?").get(conversationId)?.at || null;
    const turns = this.turnsBetween(0, Number.MAX_SAFE_INTEGER, conversationId).map((t) => this.turnView(t, now));
    const providers = new Set(turns.map((t) => t.provider).filter(Boolean));
    for (const r of this.db.prepare("SELECT DISTINCT COALESCE(provider, 'claude') AS p FROM usage_calls WHERE conversation_id = ?").all(conversationId)) providers.add(providerOf(r.p));
    const cost = this.db.prepare(`SELECT SUM(c) AS usd, COUNT(*) AS n, SUM(e) AS est FROM (
        SELECT cost_usd AS c, 1 - COALESCE(cost_exact, 0) AS e FROM usage_turns WHERE conversation_id = ? AND cost_usd IS NOT NULL
        UNION ALL SELECT cost_usd AS c, 1 AS e FROM usage_calls WHERE conversation_id = ? AND turn_id IS NULL AND cost_usd IS NOT NULL)`).get(conversationId, conversationId);
    total.costUsd = cost?.n ? cents(Number(cost.usd) || 0) : null;
    total.costNote = cost?.n && !cost.est ? "exact" : costNoteOf(providers, !!cost?.n, this.settings());
    return { conversationId, timeZone: this.timeZone, total, since: first, turns: turns.length, byMessage: Object.fromEntries(turns.filter((t) => t.messageId).map((t) => [t.messageId, t])), recent: turns.slice(-60) };
  }

  /** One turn. */
  turn(turnId) {
    const r = this.db.prepare("SELECT * FROM usage_turns WHERE turn_id = ?").get(turnId);
    return r ? this.turnView(this.turnRow(r)) : null;
  }

  /** How far the reading is. */
  status() {
    return { reading: !!this.running, firstPass: this.progress.firstPass, filesLeft: Math.max(0, this.progress.files - this.progress.done), bytesLeft: this.progress.bytesLeft, lastRefreshAt: this.lastRefreshAt };
  }
}

// ------------------------------------------------------------------ the one the server runs

let _index = null;

/** The server's index (made on first use). */
export function usageIndex(db) {
  if (!_index && db) _index = new UsageIndex(db);
  return _index;
}

/**
 * Keep the index fresh: a read a minute, and one shortly after each turn ends
 * (so the reply's line has its numbers). The first read waits a little, so it
 * does not compete with the rest of the boot. onEvent: live-bus onEvent.
 * Returns a function that stops it.
 */
export function startTokenUsage(db, { onEvent = null, everyMs = 60_000, firstAfterMs = 20_000 } = {}) {
  const index = usageIndex(db);
  let soon = null;
  const later = (ms) => { clearTimeout(soon); soon = setTimeout(() => index.refresh(), ms); soon.unref?.(); };
  later(firstAfterMs);
  const timer = setInterval(() => index.refresh(), everyMs);
  timer.unref?.();
  const off = onEvent ? onEvent((evt) => { if (evt?.type === "turn_end") later(1500); }) : null;
  return () => { clearInterval(timer); clearTimeout(soon); off?.(); };
}

/**
 * Record a turn from an engine without Claude Code transcripts (Codex) on the server's index, at the turn's end
 * (UsageIndex#recordDirect: turn's fields and what it returns). db: the database, for when the index has not been
 * made yet. Never throws: usage is bookkeeping, and must not fail the turn it describes.
 */
export function recordDirect(turn, db = null) {
  const index = usageIndex(db);
  if (!index) return { recorded: false, reason: "no-index" };
  try {
    return index.recordDirect(turn);
  } catch (err) {
    console.warn(`[usage] could not record a turn's usage: ${err.message}`);
    return { recorded: false, reason: "error", error: err.message };
  }
}

/** Tests only: use this index as the server's. */
export function __setUsageIndex(index) { _index = index; }
