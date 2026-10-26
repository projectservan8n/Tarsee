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
 * Which Claude home. Inside the Docker image HOME is /root while the real
 * configuration lives at /home/node/.claude (a symlink to the volume), so this
 * reads the workspace's project folder under EVERY candidate root that
 * lib/claude-transcript.js knows (projectsRoots), folding duplicates that are
 * the same folder through a symlink.
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
import { projectsRoots, slugifyCwd } from "./claude-transcript.js";
import { USAGE_SCHEMA } from "../db/usage-schema.js";

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
 * The folders Claude Code keeps the workspace's sessions in: the workspace's
 * project folder under every Claude home root that exists, each real folder
 * once. Two slug spellings are tried, Tarsee's own (lib/claude-transcript.js)
 * and "every character that is not a letter or digit becomes -", because Claude
 * Code has changed its rule between versions.
 */
export function projectDirs(cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd()) {
  const slugs = [...new Set([slugifyCwd(cwd), String(cwd).replace(/[^a-zA-Z0-9]/g, "-")])];
  const seen = new Set();
  const out = [];
  for (const root of projectsRoots()) {
    for (const slug of slugs) {
      const dir = path.join(root, slug);
      let real;
      try { real = fs.realpathSync(dir); } catch { continue; }   // not there
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(dir);
    }
  }
  return out;
}

// ------------------------------------------------------------------ days in the configured timezone

const zoneFormats = new Map();

/** How far a timezone is ahead of UTC at a moment, in ms (UTC+8 is 28_800_000; an unknown zone counts as UTC). */
export function zoneOffsetMs(ms, timeZone = config.TIMEZONE) {
  let f = zoneFormats.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      });
    } catch { return 0; }
    zoneFormats.set(timeZone, f);
  }
  const v = {};
  for (const p of f.formatToParts(new Date(ms))) v[p.type] = Number(p.value);
  const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The local date of a moment, "2026-10-26". */
export function localDay(ms, timeZone = config.TIMEZONE) {
  return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(0, 10);
}

/** The local midnight that began the day a moment falls in (right across daylight-saving changes). */
export function localMidnight(now = Date.now(), timeZone = config.TIMEZONE) {
  const local = now + zoneOffsetMs(now, timeZone);
  const midnight = local - (((local % DAY) + DAY) % DAY);
  // The offset at midnight can differ from the offset now (a clock change in between): ask again there.
  return midnight - zoneOffsetMs(midnight - zoneOffsetMs(now, timeZone), timeZone);
}

/** The local midnights that began each of the last `n` days, oldest first (today last). */
export function dayStarts(now = Date.now(), n = 14, timeZone = config.TIMEZONE) {
  const today = localMidnight(now, timeZone);
  const out = [];
  // Noon of each earlier day (so a 23- or 25-hour day does not slip into its neighbour), back to its midnight.
  for (let i = n - 1; i >= 0; i--) out.push(i ? localMidnight(today - i * DAY + 12 * H, timeZone) : today);
  return out;
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

/** A model id as people read it: "claude-<family>-<major>-<minor>[-<date>]" -> "<Family> <major>.<minor>". */
export function modelLabel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(String(id || ""));
  if (!m) return String(id || "Unknown");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** The channels a turn can come from (the providers' liveSource), as the page names them. */
const CHANNEL_LABELS = {
  web: "Web", telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp", email: "Email",
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
   * dirs: the transcript folders to read (default: projectDirs(), looked up again on each read,
   *   because Claude Code only makes the folder on the first session).
   * backfillDays: how far back the first read goes (by a file's last change).
   * timeZone: the zone days and hours are counted in.
   */
  constructor(db, { dirs = null, backfillDays = BACKFILL_DAYS, retentionDays = RETENTION_DAYS, now = () => Date.now(), timeZone = config.TIMEZONE } = {}) {
    this.db = db;
    this.dirs = dirs == null ? null : [].concat(dirs);
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
    this.q = {
      meta: db.prepare("SELECT value FROM usage_meta WHERE key = ?"),
      setMeta: db.prepare("INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      file: db.prepare("SELECT * FROM usage_files WHERE path = ?"),
      putFile: db.prepare(`INSERT INTO usage_files (path, session_id, agent_id, offset, size, mtime_ms, state) VALUES (@path, @session_id, @agent_id, @offset, @size, @mtime_ms, @state)
        ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtime_ms = excluded.mtime_ms, state = excluded.state`),
      // A call can be written over several lines and several reads: keep the widest span and the largest counts.
      putCall: db.prepare(`INSERT INTO usage_calls (id, session_id, agent_id, model, effort, started_at, ended_at, input, cache_read, cache_write, output, conversation_id)
        VALUES (@id, @session_id, @agent_id, @model, @effort, @startedAt, @endedAt, @input, @cacheRead, @cacheWrite, @output, (SELECT conversation_id FROM usage_sessions WHERE session_id = @session_id))
        ON CONFLICT(id) DO UPDATE SET
          started_at = CASE WHEN usage_calls.started_at IS NULL THEN excluded.started_at WHEN excluded.started_at IS NULL THEN usage_calls.started_at ELSE MIN(usage_calls.started_at, excluded.started_at) END,
          ended_at = MAX(usage_calls.ended_at, excluded.ended_at), input = MAX(usage_calls.input, excluded.input),
          cache_read = MAX(usage_calls.cache_read, excluded.cache_read), cache_write = MAX(usage_calls.cache_write, excluded.cache_write),
          output = MAX(usage_calls.output, excluded.output), placed = 0`),
      putPrompt: db.prepare("INSERT OR IGNORE INTO usage_prompts (session_id, at, head, tail) VALUES (?, ?, ?, ?)"),
      putTurn: db.prepare(`INSERT OR IGNORE INTO usage_turns (turn_id, conversation_id, source, model, effort, prompt, title, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      endTurn: db.prepare("UPDATE usage_turns SET ended_at = ?, stop_reason = ?, session_id = COALESCE(?, session_id) WHERE turn_id = ?"),
      // A reply is saved a moment after its turn ends: the turn that just ended takes it, else the one still running.
      msgTurn: db.prepare(`SELECT turn_id FROM usage_turns WHERE conversation_id = ? AND message_id IS NULL AND started_at <= ?
        AND (ended_at IS NULL OR ? - ended_at BETWEEN -5000 AND 120000) ORDER BY ended_at IS NULL, ended_at DESC, started_at DESC LIMIT 1`),
      setMsg: db.prepare("UPDATE usage_turns SET message_id = ? WHERE turn_id = ?"),
    };
  }

  meta(key, fallback = null) {
    try { const r = this.q.meta.get(key); return r ? JSON.parse(r.value) : fallback; } catch { return fallback; }
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
            this.q.putTurn.run(r.turn_id, r.conversation_id, p.source || null, p.model || null, p.effort || null, String(p.prompt || "").slice(0, 300), promptTitle(words) || promptTitle(p.prompt) || null, r.created_at);
          } else if (r.type === "turn_end" && r.turn_id) {
            this.queuedAsked.delete(r.turn_id);   // (taken out of the queue: it never began)
            // sessionId: the Claude Code session the turn ran in (src/ai/providers/claude-code.js).
            this.q.endTurn.run(r.created_at, p.stopReason || null, p.sessionId || null, r.turn_id);
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

  /** Every transcript file: [{ path, sessionId, agentId }]. */
  listFiles() {
    const out = [];
    for (const dir of this.dirs || projectDirs()) {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of names) {
        if (e.isFile() && e.name.endsWith(".jsonl")) out.push({ path: path.join(dir, e.name), sessionId: e.name.slice(0, -6), agentId: null });
        else if (e.isDirectory()) {
          const sub = path.join(dir, e.name, "subagents");
          let agents = [];
          try { agents = fs.readdirSync(sub); } catch { continue; }
          for (const a of agents) {
            const m = /^agent-([\w-]+)\.jsonl$/.exec(a);
            if (m) out.push({ path: path.join(sub, a), sessionId: e.name, agentId: m[1] });
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
          for (const c of calls) this.q.putCall.run({ ...c, session_id: f.sessionId, agent_id: f.agentId });
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
    const byClaude = new Map();
    try { for (const r of this.db.prepare("SELECT id, claude_session_id AS sid FROM conversations WHERE claude_session_id IS NOT NULL").all()) byClaude.set(r.sid, r.id); } catch { /* no conversations table */ }
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
      const agg = this.db.prepare(`SELECT ${SUM_SQL}, MIN(COALESCE(started_at, ended_at)) AS firstAt, MAX(ended_at) AS lastAt FROM ${CALLS} WHERE turn_id = ?`);
      const top = this.db.prepare("SELECT model, effort, SUM(output) + COUNT(*) AS w FROM usage_calls WHERE turn_id = ? AND agent_id IS NULL GROUP BY model, effort ORDER BY w DESC LIMIT 1");
      const save = this.db.prepare(`UPDATE usage_turns SET calls = @calls, input = @input, cache_read = @cacheRead, cache_write = @cacheWrite, output = @output,
        gen_ms = @genMs, gen_out = @genOut, gen_tokens = @genTokens, first_call_at = @firstAt, last_call_at = @lastAt, call_model = @model, call_effort = @effort WHERE turn_id = @turnId`);
      for (const turnId of dirty) {
        const s = agg.get(turnId);
        const m = top.get(turnId) || {};
        save.run({ ...s, model: m.model || null, effort: m.effort || null, turnId });
      }
    })();
  }

  // ------------------------------------------------------------------ reading the sums

  /** Sums of every call that ended in [from, to). */
  sumsBetween(from, to = Number.MAX_SAFE_INTEGER, where = "", ...args) {
    return this.db.prepare(`SELECT ${SUM_SQL} FROM ${CALLS} WHERE ended_at >= ? AND ended_at < ? ${where}`).get(from, to, ...args);
  }

  /** Turns as groupJobs takes them, started in [from, to). */
  turnsBetween(from, to = Number.MAX_SAFE_INTEGER, conversationId = null) {
    const rows = this.db.prepare(`SELECT * FROM usage_turns WHERE started_at >= ? AND started_at < ? ${conversationId ? "AND conversation_id = ?" : ""} ORDER BY started_at`)
      .all(...[from, to, ...(conversationId ? [conversationId] : [])]);
    return rows.map((r) => this.turnRow(r));
  }

  turnRow(r) {
    return {
      turnId: r.turn_id, conversationId: r.conversation_id, source: r.source, prompt: r.prompt, title: r.title || null,
      startedAt: r.started_at, endedAt: r.ended_at, lastCallAt: r.last_call_at, firstCallAt: r.first_call_at,
      model: r.call_model ? modelLabel(r.call_model) : null, effort: r.call_effort || r.effort || null,   // (no calls: no model to name)
      messageId: r.message_id || null, stopReason: r.stop_reason || null, sums: turnSums(r),
    };
  }

  /** A turn as the page shows it: its figures and how long it took. */
  turnView(t, now = this.now()) {
    return {
      turnId: t.turnId, conversationId: t.conversationId, messageId: t.messageId, source: t.source,
      title: t.title || promptTitle(t.prompt), startedAt: t.startedAt, endedAt: t.endedAt, running: !t.endedAt,
      ms: Math.max(t.endedAt || now, t.lastCallAt || 0) - t.startedAt, model: t.model, effort: t.effort, ...figures(t.sums),
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

  /** Jobs with a turn in [from, to), newest first. */
  jobs({ from, to = Number.MAX_SAFE_INTEGER, conversationId = null, overrides = {}, now = this.now() } = {}) {
    // A job that began before `from` still shows whole: its earlier turns come with it (up to a day back).
    const turns = this.turnsBetween(from - DAY, to, conversationId);
    return groupJobs(turns, overrides, { now })
      .filter((j) => (j.endedAt ?? now) >= from && j.startedAt < to)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * The overview page's numbers. windows: { fiveHour: { usedPct, resetsAt }, sevenDay: { … } } when
   * something reads the plan's own limits; null here, so the windows are simply the last 5 hours and
   * the last 7 days.
   */
  overview({ windows = null, overrides = {}, now = this.now() } = {}) {
    const tz = this.timeZone;
    const today = localMidnight(now, tz);
    const week = now - 7 * DAY;
    const fig = (s) => figures(s);
    const out = {
      at: now,
      timeZone: tz,
      today: fig(this.sumsBetween(today)),
      week: fig(this.sumsBetween(week)),
      windows: {},
    };
    const fiveFrom = windows?.fiveHour?.resetsAt && !windows.fiveHour.expired ? windows.fiveHour.resetsAt - 5 * H : now - 5 * H;
    const weekFrom = windows?.sevenDay?.resetsAt && !windows.sevenDay.expired ? windows.sevenDay.resetsAt - 7 * DAY : week;
    out.windows.fiveHour = { from: fiveFrom, resetsAt: windows?.fiveHour?.expired ? null : windows?.fiveHour?.resetsAt || null, usedPct: windows?.fiveHour?.expired ? 0 : windows?.fiveHour?.usedPct ?? null, ...fig(this.sumsBetween(fiveFrom)) };
    out.windows.sevenDay = { from: weekFrom, resetsAt: windows?.sevenDay?.expired ? null : windows?.sevenDay?.resetsAt || null, usedPct: windows?.sevenDay?.expired ? 0 : windows?.sevenDay?.usedPct ?? null, ...fig(this.sumsBetween(weekFrom)) };

    const models = new Map();
    for (const r of this.db.prepare(`SELECT model, ${SUM_SQL} FROM ${CALLS} WHERE ended_at >= ? GROUP BY model`).all(week)) {
      const label = modelLabel(r.model);
      models.set(label, addSums(models.get(label), r));
    }
    out.byModel = [...models].map(([model, s]) => ({ model, ...fig(s) })).sort((a, b) => b.total - a.total);
    const chan = this.db.prepare(`SELECT conversation_id AS conv, source, ${SUM_SQL} FROM (
        SELECT c.*, c.ended_at - c.started_at AS g, t.source AS source FROM usage_calls c LEFT JOIN usage_turns t ON t.turn_id = c.turn_id WHERE c.ended_at >= ?
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

    const jobs = this.jobs({ from: week, overrides, now });
    out.jobsThisWeek = jobs.length;
    out.heaviest = [...jobs].sort((a, b) => b.total - a.total).slice(0, 6);
    const jt = this.titles([...new Set(out.heaviest.map((j) => j.conversationId))]);
    for (const j of out.heaviest) j.chatTitle = jt[j.conversationId] || null;

    // Speed: the week's average, and its fastest call with enough output to mean something.
    const peak = this.db.prepare(`SELECT model, output, ended_at - started_at AS g, ended_at AS at FROM usage_calls
      WHERE ended_at >= ? AND started_at IS NOT NULL AND output >= 500 AND ended_at - started_at BETWEEN 1000 AND ${MAX_GEN_MS}
        AND output <= (ended_at - started_at) * ${MAX_TPS / 1000}
      ORDER BY output * 1.0 / (ended_at - started_at) DESC LIMIT 1`).get(week);
    out.speed = {
      outTps: out.week.outTps, totalTps: out.week.totalTps,
      peak: peak ? { outTps: Math.round((peak.output / (peak.g / 1000)) * 10) / 10, model: modelLabel(peak.model), output: peak.output, at: peak.at } : null,
      byModel: out.byModel.filter((m) => m.outTps != null).map((m) => ({ model: m.model, outTps: m.outTps })),
    };

    // Each local day of the last 14 (from midnight to midnight, so a day with a clock change is 23 or 25 hours),
    // and each local hour of the last 24.
    const starts = dayStarts(now, 14, tz);
    out.days = starts.map((from, i) => ({ day: localDay(from + H, tz), from, ...fig(this.sumsBetween(from, starts[i + 1] ?? Number.MAX_SAFE_INTEGER)) }));
    const off = zoneOffsetMs(now, tz);
    const hour0 = Math.floor((now + off) / H) * H - off - 23 * H;   // (a zone half an hour off UTC has its hours on the half hour)
    const hourRows = this.db.prepare(`SELECT CAST((ended_at - ?) / ${H} AS INTEGER) AS h, ${SUM_SQL} FROM ${CALLS} WHERE ended_at >= ? GROUP BY h`).all(hour0, hour0);
    out.hours = Array.from({ length: 24 }, (_, i) => ({ from: hour0 + i * H, ...fig(hourRows.find((x) => x.h === i) || EMPTY) }));
    out.progress = this.status();
    return out;
  }

  /** The source a conversation's turns most often came from. */
  sourceOf(conv) {
    try { return this.db.prepare("SELECT source FROM usage_turns WHERE conversation_id = ? AND source IS NOT NULL GROUP BY source ORDER BY COUNT(*) DESC LIMIT 1").get(conv)?.source || null; } catch { return null; }
  }

  /** A chat's running total and each of its turns (keyed by the reply they ended in). */
  chat(conversationId, { now = this.now() } = {}) {
    const total = figures(this.db.prepare(`SELECT ${SUM_SQL} FROM ${CALLS} WHERE conversation_id = ?`).get(conversationId));
    const first = this.db.prepare("SELECT MIN(ended_at) AS at FROM usage_calls WHERE conversation_id = ?").get(conversationId)?.at || null;
    const turns = this.turnsBetween(0, Number.MAX_SAFE_INTEGER, conversationId).map((t) => this.turnView(t, now));
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

/** Tests only: use this index as the server's. */
export function __setUsageIndex(index) { _index = index; }
