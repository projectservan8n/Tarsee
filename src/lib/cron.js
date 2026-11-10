import cron from "node-cron";
import { buildSystemPromptParts } from "./build-system-prompt.js";
import { chatStream } from "../ai/router.js";
import { appendDailyLog } from "./workspace-files.js";
import { resolveModelAlias, isKnownModel, BACKGROUND_DEFAULTS } from "../config/constants.js";
import { runBackgroundTurn, resolveBackgroundModel, overBudgetWarning } from "./background-turn.js";
import config from "../config/env.js";
import { z } from "zod";
import { getToolDefinitions } from "./tools.js";
import { createTarseeMcp } from "../ai/tarsee-mcp.js";
import { getAllKeysDecrypted, serverOnlyName, serverOnlyNameLoose, serverOnlyValues } from "./key-vault.js";
import { PROVIDER_IDS, getProvider } from "../ai/provider-registry.js";
import { redactSecrets } from "./redact.js";
import { getSecurityManager } from "./security-manager.js";

/**
 * Cron job scheduler — run AI tasks on a schedule.
 *
 * Job spec stored in settings DB as JSON array: "cron.jobs"
 * Each job: { id, schedule, prompt, channel, enabled, createdBy, awaitingOwner?, conversationId?, name?, action?, once? }
 *
 * - schedule: standard cron expression (e.g. "0 9 * * *" = 9 AM daily)
 * - prompt: the message to send to the AI
 * - channel: which channel to deliver to (default: "web:default")
 * - enabled: boolean
 * - createdBy: "owner" (the Settings form, /cron add, /briefing) or "ai" (the schedule_task tool, in a chat). Tasks
 *   saved before this was kept have none.
 * - awaitingOwner: true while a task the AI made waits for the owner's OK. Such a task is saved switched off and
 *   only the owner switches it on (Settings > Automation > Scheduled tasks, PATCH /api/settings/cron/:id,
 *   /cron on <id>): each run of a task that asks the AI is a paid turn nobody asked for at the time, so the owner
 *   decides. conversationId: the chat the AI made it in.
 *
 * A task that asks the AI (no `action`) has no seconds field and runs at most once every MIN_PROMPT_GAP_MINUTES
 * (promptScheduleProblem), checked when it is made: tasks saved before the rule keep running as they are. A run still
 * going when the task's next time comes is skipped, not stacked, even when the task's timer was made again meanwhile
 * (runScheduled). A failed run is tried again unless the owner paused, switched off or deleted that task meanwhile
 * (ownerLetItGoOn): its timer made again for another reason doesn't stop it.
 *
 * Every saved task has its own id, never used before by another (newJobId); two saved by an older version with one id
 * are told apart when the scheduler starts (giveEachTaskItsOwnId). No schedule reaches node-cron before
 * unsafeScheduleProblem has passed it: node-cron hangs on some.
 */

let _db = null;
let _settingsStore = null;

/**
 * Zero-token complexity heuristic for a cron PROMPT. Costs NOTHING (pure
 * keyword match) — the whole point is to keep crons cheap. Returns a tier
 * ("opus"/"sonnet") only when the prompt clearly warrants more than the cheap
 * floor; otherwise null → the Haiku floor handles it. An explicit `job.model`
 * ALWAYS overrides this. Gated by the `cron.autoTier` setting (default on).
 */
function autoTierForPrompt(prompt) {
  const p = String(prompt || "").toLowerCase();
  if (!p.trim()) return null;
  // Hard / ambiguous engineering & investigation → Opus.
  if (/\b(refactor|re-?architect|root[\s-]?cause|debug why|investigate why|figure out why|audit the|migrate|rewrite|redesign)\b/.test(p)) return "opus";
  // Real agent work that must land correctly → Sonnet.
  if (/\b(push|deploy|commit|open (a )?pr|pull request|apply (the )?plan|implement|scaffold|edit the code|write (the )?code|create the (app|site|page|feature|tool)|run the deploy|fix the)\b/.test(p)) return "sonnet";
  return null;
}

/**
 * Resolve the model a cron job runs on. Priority (cheapest-first floor):
 *   1. Explicit per-job tier `job.model` — always wins.
 *   2. Zero-token complexity heuristic on the prompt (if `cron.autoTier` on).
 *   3. `cron.defaultModel` floor (Haiku — keeps crons ~free).
 *   4. Global active-provider model.
 *
 * Without this every scheduled job ran on the globally-recommended model,
 * which is Opus — so a trivial daily reminder cost an Opus turn.
 */
function resolveCronModel(job) {
  let pick = job.model;
  if (!pick) {
    const autoTier = _settingsStore?.get("cron.autoTier");
    if (autoTier !== false && autoTier !== "false") {
      pick = autoTierForPrompt(job.prompt);
    }
  }
  // The floor. `cron.defaultModel` is a user override that nothing writes by
  // default, and the old fallback after it was `activeProvider.model` — the
  // global Opus alias. So the "Haiku floor keeps crons ~free" contract in the
  // comment above was never in force: every trivial reminder ran top-tier.
  // Fall back to the shared cheap background floor instead of the interactive
  // default, which is what the docs always claimed happened.
  pick = pick || _settingsStore?.get("cron.defaultModel");
  // A tier word, a model of the default AI or a provider:model ref; a name it doesn't offer is logged and the floor
  // runs (background-turn.js).
  return resolveBackgroundModel(pick, null, _settingsStore);
}
let _convStore = null;
let _channelManager = null;
const activeJobs = new Map(); // id → cron.ScheduledTask
const jobState = new Map();   // id → { lastRun, lastStatus, lastError, consecutiveErrors }
const runsGoing = new Map();  // id → how many runs of it are going right now (the "Running" state)
const runInProgress = new Set(); // ids of tasks whose scheduled run is going: a time that comes meanwhile is skipped
/**
 * id → how many times the owner has paused or switched off that task. A failed run waiting to retry stops when this
 * changed since the run began, even if the owner switched the task on again since (ownerLetItGoOn). A timer made again
 * for another reason (startCronScheduler, which /briefing off calls) doesn't change it.
 */
const ownerStops = new Map();

const JOB_TIMEOUT_MS = BACKGROUND_DEFAULTS.TIMEOUT_MS; // hard wall-clock cap per job
const MAX_CONSECUTIVE_ERRORS = 5; // Auto-disable after this many failures
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;

/** The closest two runs of a task that asks the AI may be, in minutes. Each run is a paid turn on the AI. */
export const MIN_PROMPT_GAP_MINUTES = 15;
const DAY_MINUTES = 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Days in the Gregorian calendar's 400-year cycle: after it, every date falls on the same weekday again. */
const CYCLE_DAYS = 146_097;

/**
 * Why a task that asks the AI can't have this schedule, in words for the owner or the model; null when it can.
 * Five parts (minute hour day month weekday: node-cron reads a sixth, in front, as seconds), and no two runs closer
 * than MIN_PROMPT_GAP_MINUTES. Direct-action tasks (no AI) don't come here.
 *
 * The gap comes from the clock times node-cron itself reads in the expression (its own parse, so "59-0" or "5/15"
 * mean here what they mean to it), not from walking its next-run dates: node-cron 4.2.1's walker jumps years ahead
 * on a weekday it doesn't match, and a schedule that crowds its runs onto one day in four years ("* * 29 2 *") would
 * hide from any short walk. Every day a task fires, it fires at the same clock times (its hours times its minutes),
 * so the shortest gap is the shortest between those times or, when two days in a row can both fire, the one from a
 * day's last time to the next day's first. That is clock time, as node-cron fires: the night the clocks change can
 * bring two runs closer once.
 */
export function promptScheduleProblem(schedule) {
  const text = String(schedule ?? "").trim();
  const rule = `Tasks that ask the AI run at most once every ${MIN_PROMPT_GAP_MINUTES} minutes, since each run is paid for`;
  const parts = text ? text.split(/\s+/).length : 0;
  if (parts === 6) return `"${text}" has a seconds part. ${rule}: use 5 parts (minute hour day month weekday), like "0 9 * * *" for 9 AM every day.`;
  if (parts !== 5) return `"${text}" has ${parts} parts. ${rule}: use 5 (minute hour day month weekday), like "0 9 * * *" for 9 AM every day.`;
  const unsafe = unsafeScheduleProblem(text);
  if (unsafe) return unsafe;
  if (!cron.validate(text)) return `Invalid cron schedule: ${text}`;
  const gap = closestRuns(text);
  if (gap >= MIN_PROMPT_GAP_MINUTES) return null;
  return `"${text}" runs ${gap === 1 ? "1 minute" : `${gap} minutes`} apart. ${rule}: "*/${MIN_PROMPT_GAP_MINUTES} * * * *" is the most often.`;
}

/** The longest schedule Tarsee hands node-cron. A real one is 5 short parts; the cap keeps unsafeScheduleProblem quick. */
const MAX_SCHEDULE_LENGTH = 1000;
/** No part of a schedule holds more numbers than this: seconds and minutes go from 0 to 59. */
const MOST_NUMBERS_IN_A_PART = 60;
/** node-cron's names, which it turns into numbers in this order: full names first, then short ones. */
const MONTH_NAMES = [
  ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
];
const WEEKDAY_NAMES = [
  ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
];
/** What node-cron puts for the first "*" of each part: seconds, minutes, hours, days, months, weekdays. */
const STAR_RANGES = ["0-59", "0-59", "0-23", "1-31", "1-12", "0-6"];

/**
 * Why node-cron can't be handed this schedule at all, in plain words for the owner or the model; null when it can
 * (whether node-cron takes it is then cron.validate's call). Nothing here calls cron.validate or cron.schedule before
 * this has passed the schedule.
 *
 * node-cron 4.2.1 reads a schedule by writing out every number of each range ("1-5", and the "0-59" a "*" stands for)
 * one step at a time, before it checks anything. A step of 0 ("*\/0") never moves on, so that never ends: it fills the
 * memory until the server falls over. A range of billions ("0-99999999999") does much the same. In the weekday part
 * it first turns the first "7" it finds into "0" (both mean Sunday) and day names into numbers ("sun" is 0), so "*\/7",
 * "0-6/7" or "*\/sun" there become a step of 0 too. This reads the schedule as node-cron does, step by step
 * (pattern/convertion in node-cron), but counts the numbers of a range before writing them out, so it can't hang. A
 * step under 1 is refused wherever it is: node-cron reads "5/0" as 5, and "*\/-1" as every minute, never what was meant.
 */
export function unsafeScheduleProblem(schedule) {
  if (typeof schedule !== "string") return `A schedule is written as text, like "0 9 * * *" for 9 AM every day.`;
  const text = schedule.trim();
  if (schedule.length > MAX_SCHEDULE_LENGTH) {
    return `That schedule is ${schedule.length} characters long, far too long for one: a schedule is 5 short parts, like "0 9 * * *" for 9 AM every day.`;
  }
  const parts = schedule.replace(/\s{2,}/g, " ").trim().split(" ");
  const written = [...parts];
  if (parts.length === 5) parts.unshift("0");
  // node-cron stops at the missing month part, before it writes out any range, and just says no.
  if (parts.length < 6) return null;
  const weekdayAsWritten = parts[5];
  parts[4] = numbersForNames(parts[4], MONTH_NAMES, 1);
  parts[5] = numbersForNames(parts[5].replace("7", "0"), WEEKDAY_NAMES, 0);
  STAR_RANGES.forEach((range, i) => { parts[i] = parts[i].replace("*", range); });

  for (let i = 0; i < parts.length; i++) {
    const step = stepUnder1(parts[i]);
    if (step === null) continue;
    if (i === 5 && stepUnder1(weekdayAsWritten) === null) return weekdayStepOf0(text, written, parts[5]);
    return `"${text}" has a step of ${step}: the number after "/" is how far to move on each time, so it must be 1 or more, like "*/15" in the minute part for every 15 minutes.`;
  }
  for (const part of parts) {
    const range = rangeTooBig(part);
    if (range) {
      return `"${text}" has the range "${range}", far bigger than any part of a schedule can be: minutes go up to 59, hours to 23, days to 31, months to 12 and weekdays to 7.`;
    }
  }
  return null;
}

/** The days of the week by their number to the scheduler, for the owner to read. */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Why a weekday part with no step under 1 as written ("*\/7", "1-5/7", "*\/sun") still works out to a step of 0, in
 * words that fit what was written. node-cron reads the part's first 7 as 0 and day names as numbers, so the step that
 * became 0 was a 7 (7, 70...) or Sunday's name. Counting 7 days or more on from the first day goes past the end of the
 * week, so a step of 7 means that day alone: the message names it ("1-5/7" is Mondays only, "*\/7" Sundays only) and
 * gives the schedule to write instead. `written`: the schedule's parts as written; `read`: its weekday part as
 * node-cron reads it.
 */
function weekdayStepOf0(text, written, read) {
  const at = written.length === 5 ? 4 : 5;
  const part = written[at];
  const where = `"${text}": in the weekday part "${part}"`;
  const pieces = part.split(",");
  const readPieces = read.split(",");
  const k = readPieces.length === pieces.length ? readPieces.findIndex((p) => stepUnder1(p) !== null) : -1;
  const piece = pieces[k] ?? "";
  const slash = piece.indexOf("/");
  const [from, step] = slash < 0 ? ["", ""] : [piece.slice(0, slash), piece.slice(slash + 1)];

  if (/^[a-z]+$/i.test(step)) {
    return `${where}, the step "${step}" is a day's name, Sunday, which the scheduler reads as day 0, so it works out to a step of 0. The number after "/" is how many days to move on each time, so it must be 1 or more, like "1-5/2" for Monday, Wednesday and Friday.`;
  }
  const first = from === "*" ? "0" : from.split("-")[0];
  let day = /^(\d+|[a-z]+)$/i.test(first) ? Number(numbersForNames(first, WEEKDAY_NAMES, 0)) : NaN;
  if (day === 7) day = 0;
  if (/^\d+$/.test(step) && Number.isInteger(day) && day >= 0 && day <= 6) {
    const instead = [...written];
    instead[at] = pieces.map((p, i) => (i === k ? first : p)).join(",");
    const suggestion = instead.join(" ");
    // Offered only when it is one Tarsee takes itself: another piece with a step of 7 ("1-5/7,*/7") would be refused too.
    if (unsafeScheduleProblem(suggestion) === null && cron.validate(suggestion)) {
      return `${where}, the scheduler reads the first 7 as 0 (7 and 0 both mean Sunday), so "${piece}" works out to a step of 0. A step must be 1 or more. Counting ${step} days on from ${DAY_NAMES[day]} goes past the end of the week, so "${piece}" means ${DAY_NAMES[day]}s only: write "${suggestion}".`;
    }
  }
  return `${where}, the scheduler reads the first 7 as 0 and day names as numbers (7, 0 and "sun" all mean Sunday, day 0), so it works out to a step of 0. A step must be 1 or more, like "1-5/2" for Monday, Wednesday and Friday.`;
}

/** A part with node-cron's names turned into its numbers: each name, in the order given, becomes its place plus `first`. */
function numbersForNames(part, lists, first) {
  let read = part;
  for (const names of lists) names.forEach((name, i) => { read = read.replace(new RegExp(name, "gi"), String(i + first)); });
  return read;
}

/** The first step under 1 in a part ("/0", "/-1"; node-cron reads a step's digits, so "/0.5" is "/0"), else null. */
function stepUnder1(part) {
  for (const [, digits] of part.matchAll(/\/(-?\d+)/g)) {
    const step = parseInt(digits, 10);
    if (step < 1) return step === 0 ? 0 : step;   // -0 is a step of 0
  }
  return null;
}

/**
 * The first range in a part that node-cron couldn't write out (more numbers than a part holds, a number too big to
 * count up to, or a step under 1), else null. Ranges are taken one at a time as node-cron takes them, each written out
 * in its place, since that can make the next one.
 */
function rangeTooBig(part) {
  const RANGE = /(\d+)-(\d+)(\/(\d+)|)/;
  let read = part;
  // Each turn takes the one "-" of a range away, so this ends.
  for (let m = RANGE.exec(read); m; m = RANGE.exec(read)) {
    const step = parseInt(m[4] || "1", 10);
    const [first, last] = [parseInt(m[1], 10), parseInt(m[2], 10)].sort((a, b) => a - b);
    if (!(step >= 1) || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return m[0];
    if (Math.floor((last - first) / step) + 1 > MOST_NUMBERS_IN_A_PART) return m[0];
    const numbers = [];
    for (let n = first; n <= last; n += step) numbers.push(n);
    read = read.replace(new RegExp(m[0], "i"), numbers.join());
  }
  return null;
}

/**
 * The closest two runs of a 5-part schedule come, in minutes, when that is under MIN_PROMPT_GAP_MINUTES; else
 * MIN_PROMPT_GAP_MINUTES or more (Infinity for a schedule that never fires twice in a day or on two days in a row).
 */
function closestRuns(schedule) {
  const [, minutes, hours, days, months, weekdays] = cronFields(schedule);
  const mins = numbersIn(minutes, 0, 59);
  const times = numbersIn(hours, 0, 23).flatMap((h) => mins.map((m) => h * 60 + m));
  if (!times.length) return Infinity;
  let gap = Infinity;
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
  const overnight = DAY_MINUTES - times[times.length - 1] + times[0];
  if (overnight < Math.min(gap, MIN_PROMPT_GAP_MINUTES) && twoDaysInARow(numbersIn(days, 1, 31), numbersIn(months, 1, 12), numbersIn(weekdays, 0, 6))) {
    gap = overnight;
  }
  return gap;
}

/** node-cron's own reading of an expression: [seconds, minutes, hours, days, months, weekdays], each a list of numbers. */
function cronFields(schedule) {
  // createTask builds the task without starting it; destroy() takes it out of node-cron's list of tasks again.
  const task = cron.createTask(schedule, () => {});
  try {
    const fields = task.timeMatcher?.expressions;
    if (!Array.isArray(fields) || fields.length !== 6 || !fields.every(Array.isArray)) {
      throw new Error(`Tarsee couldn't read the times in the schedule "${schedule}"`);
    }
    return fields;
  } finally {
    task.destroy();
  }
}

/** The whole numbers in a field from lo to hi, once each, smallest first. */
function numbersIn(list, lo, hi) {
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n >= lo && n <= hi))].sort((a, b) => a - b);
}

/**
 * Whether two days in a row can both fire: a day matches when its date, month and weekday all do, as node-cron
 * matches them. One 400-year cycle of the calendar holds every case, so it is checked day by day (a few hundredths of
 * a second, and only for a schedule with times either side of midnight).
 */
function twoDaysInARow(days, months, weekdays) {
  const d = new Set(days);
  const m = new Set(months);
  const w = new Set(weekdays);
  const fires = (t) => {
    const day = new Date(t);
    return d.has(day.getUTCDate()) && m.has(day.getUTCMonth() + 1) && w.has(day.getUTCDay());
  };
  const start = Date.UTC(2000, 0, 1);
  let before = fires(start);
  for (let i = 1; i <= CYCLE_DAYS; i++) {
    const now = fires(start + i * DAY_MS);
    if (before && now) return true;
    before = now;
  }
  return false;
}

/** Whether a saved task should have a timer: switched on, and not waiting for the owner's OK. */
function shouldRun(job) {
  return !!job.enabled && !job.awaitingOwner;
}

/** Count a run of a task as going while fn runs (the "Running" state in Settings and /cron list). */
async function tracked(id, fn) {
  runsGoing.set(id, (runsGoing.get(id) || 0) + 1);
  try {
    return await fn();
  } finally {
    const left = (runsGoing.get(id) || 1) - 1;
    if (left > 0) runsGoing.set(id, left);
    else runsGoing.delete(id);
  }
}

/**
 * Initialize the cron system.
 */
export function initCron({ db, settingsStore, convStore, channelManager }) {
  _db = db;
  _settingsStore = settingsStore;
  _convStore = convStore;
  if (channelManager) _channelManager = channelManager;
}

/**
 * Set channel manager (can be called after init if manager starts later).
 */
export function setCronChannelManager(channelManager) {
  _channelManager = channelManager;
}

/**
 * Load and start all enabled cron jobs (at boot, and whenever every timer is made again). A task waiting for the
 * owner's OK gets no timer. Saved tasks that share an id get their own first (giveEachTaskItsOwnId), while no timer is
 * left to point at the wrong one. A task that can't be scheduled is logged and skipped: the others still start, and so
 * does Tarsee.
 */
export function startCronScheduler() {
  stopCronScheduler();
  const jobs = loadCronJobs();
  if (giveEachTaskItsOwnId(jobs)) saveCronJobs(jobs);

  for (const job of jobs) {
    if (!shouldRun(job)) continue;
    try {
      scheduleJob(job);
    } catch (err) {
      console.warn(`[cron] Task ${job.id} gets no timer: ${err.message}`);
    }
  }

  console.log(`[cron] Started ${activeJobs.size} job(s)`);
}

/**
 * Older versions made a task's id from "cron_" and the first 12 letters of its name, and never checked it was free,
 * so an install can hold two saved tasks with one id. Then only one of them kept a timer, while both showed as on,
 * and Pause or Delete took the wrong one's timer. The first keeps the id; each later one gets a new one (the old id and
 * a time stamp). Changes the list in place; true when it changed anything, for the caller to save it once.
 */
function giveEachTaskItsOwnId(jobs) {
  const seen = new Set();
  let changed = false;
  for (const job of jobs) {
    if (seen.has(job.id)) {
      const old = job.id;
      job.id = uniqueId(jobs, typeof old === "string" && old ? old : "cron");
      console.warn(`[cron] Two saved tasks had the id ${old}: the later one is now ${job.id}`);
      changed = true;
    }
    seen.add(job.id);
  }
  return changed;
}

/**
 * Stop all running cron jobs. A run already going finishes.
 */
export function stopCronScheduler() {
  for (const [, task] of activeJobs) {
    task.destroy();
  }
  activeJobs.clear();
}

/**
 * Schedule a single job.
 */
function scheduleJob(job) {
  // Checked before node-cron sees it: a task saved with a schedule node-cron hangs on would otherwise stop the boot.
  const unsafe = unsafeScheduleProblem(job.schedule);
  if (unsafe || !cron.validate(job.schedule)) {
    console.warn(`[cron] Task ${job.id} gets no timer: ${unsafe || `invalid schedule ${job.schedule}`}`);
    return;
  }
  // Never two timers for one task: the second would be one nothing could stop.
  unscheduleJob(job.id);

  // Interpret the expression in the agent's configured zone, not the
  // container's. Railway containers run UTC, so "0 8 * * *" fired at 8am UTC
  // — the middle of the night for most operators — while the scheduling tool
  // told the model to write local times. Passing `timezone` makes the two
  // agree. `config.TIMEZONE` is validated at boot, so node-cron cannot throw
  // on a bogus zone here.
  //
  // The callback returns the run, retries included, so node-cron knows when it ends: its runner awaits what the
  // callback returns, and with noOverlap a time that comes while the run is still going is skipped. The callback used
  // to return nothing, so every tick started another paid run on top of the last. noOverlap knows only this timer,
  // though: runScheduled covers a run that an earlier timer of the task started.
  const timer = cron.schedule(job.schedule, () => runScheduled(job, timer), { timezone: config.TIMEZONE, noOverlap: true });

  activeJobs.set(job.id, timer);
}

/** Stop a task's timer, if it has one (a run already going finishes). */
function unscheduleJob(id) {
  const task = activeJobs.get(id);
  if (!task) return;
  task.destroy();
  activeJobs.delete(id);
}

/**
 * One time of a task coming, from its timer: the run node-cron waits on.
 *
 * Skipped, and logged, while a run of the task is still going: a scheduled one (runInProgress), even one an earlier
 * timer of the task started (switching a task off and on, or startCronScheduler, makes a new timer, and node-cron's
 * noOverlap knows only its own), or one the owner started by hand. Otherwise two paid runs of one task would overlap.
 *
 * A time from a timer that is no longer the task's starts nothing. Once started, the run, retries included, stops only
 * when the owner paused, switched off or deleted that task (even if they switched it on again since): a timer made
 * again for another reason, as /briefing off does to every timer, doesn't stop it (ownerLetItGoOn). A one-time task
 * goes once its run ends, unless the owner stopped the run: a paused one stays, paused, for them to switch on or
 * delete.
 */
function runScheduled(job, timer) {
  if (activeJobs.get(job.id) !== timer) return undefined;
  if (runInProgress.has(job.id) || runsGoing.has(job.id)) {
    console.log(`[cron] Task "${job.id}" is still running from an earlier time: this time is skipped`);
    return undefined;
  }
  runInProgress.add(job.id);
  return runCronJobWithRetry(job, { stillOn: ownerLetItGoOn(job.id) }).then((result) => {
    // Auto-delete one-time jobs after they fire
    if (job.once && !result?.stoppedByOwner) {
      console.log(`[cron] One-time job "${job.id}" completed, removing`);
      removeCronJob(job.id);
    }
  }).catch((err) => {
    console.error(`[cron] Job ${job.id} fatal error:`, err.message);
  }).finally(() => {
    runInProgress.delete(job.id);
  });
}

/**
 * For a run of task `id` starting now: whether it may go on. True while the task is still saved and on, and the owner
 * hasn't paused or switched it off since (ownerStops), even if they switched it on again. Nothing else counts: its
 * timer made again (startCronScheduler, as /briefing off does to every timer) leaves the run going.
 */
function ownerLetItGoOn(id) {
  const stopsAtStart = ownerStops.get(id) || 0;
  return () => {
    if ((ownerStops.get(id) || 0) !== stopsAtStart) return false;
    const saved = loadCronJobs().find((j) => j.id === id);
    return !!saved && shouldRun(saved);
  };
}

/**
 * Run a cron job with retry and timeout. opts.stillOn: asked before each retry; false (the owner paused, switched off
 * or deleted the task meanwhile, even if they switched it on again: ownerLetItGoOn) ends it there, so a paused run
 * never starts another paid try. The result then says stoppedByOwner.
 */
export function runCronJobWithRetry(job, opts = {}) {
  return tracked(job.id, () => runWithRetry(job, opts));
}

async function runWithRetry(job, { stillOn = null } = {}) {
  // Check if auto-disabled from too many errors
  const state = jobState.get(job.id) || { consecutiveErrors: 0 };
  if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.warn(`[cron] Job "${job.id}" auto-disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Last: ${state.lastError}`);
    return { error: "Auto-disabled" };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await runCronJob(job);

    if (!result.error) {
      // Success — reset error counter. A job that finished over its spending limit is still a success (its work is
      // done, and running it again would spend more), but its status and push say so.
      const status = result.warning ? "over-budget" : "ok";
      jobState.set(job.id, { lastRun: Date.now(), lastStatus: status, lastError: result.warning || null, consecutiveErrors: 0 });
      // Fire a push notification so the user knows the job finished even
      // if they're not watching the app. Best-effort — failures don't
      // affect the job result.
      notifyJobComplete(job, status, result.warning || null).catch(() => {});
      return result;
    }

    // Failure
    state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
    state.lastRun = Date.now();
    state.lastStatus = "error";
    state.lastError = result.error;
    jobState.set(job.id, state);

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * (attempt + 1);
      console.warn(`[cron] Job "${job.id}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms: ${result.error}`);
      await new Promise((r) => setTimeout(r, delay));
      if (stillOn && !stillOn()) {
        console.log(`[cron] Job "${job.id}" was paused or deleted: no more retries`);
        return { ...result, stoppedByOwner: true };
      }
    } else {
      console.error(`[cron] Job "${job.id}" failed after ${MAX_RETRIES + 1} attempts: ${result.error}`);
      // Push only on FINAL failure, not on intermediate retries.
      notifyJobComplete(job, "error", result.error).catch(() => {});
    }
  }
}

/**
 * Fire a Web Push notification for a cron-job status transition.
 * Skips if push module isn't initialized yet (boot race) or if there
 * are no subscriptions. Title/body kept short so iOS/Android don't
 * truncate awkwardly.
 */
async function notifyJobComplete(job, status, errMsg = null) {
  try {
    const { sendPush } = await import("./push.js");
    const name = job.name || job.id || "cron";
    if (status === "ok") {
      await sendPush({
        title: `Tarsee · ${name}`,
        body: "Job finished.",
        tag: `cron-${job.id}`,
        url: "/",
      });
    } else if (status === "over-budget") {
      await sendPush({
        title: `Tarsee · ${name} went over its spending limit`,
        body: (errMsg || "").slice(0, 140),
        tag: `cron-${job.id}`,
        url: "/",
      });
    } else {
      await sendPush({
        title: `Tarsee · ${name} failed`,
        body: (errMsg || "").slice(0, 140),
        tag: `cron-${job.id}-error`,
        url: "/",
      });
    }
  } catch { /* push not wired or no subscriptions — silently ignore */ }
}

/**
 * Run a cron job — either execute a direct action or send prompt to AI.
 */
export function runCronJob(job) {
  return tracked(job.id, () => runOnce(job));
}

async function runOnce(job) {
  if (!_settingsStore || !_db) {
    return { error: "Not initialized" };
  }

  const now = new Date().toISOString();

  // --- Direct action: execute tool immediately without AI ---
  // Checked again before every run, as when it was saved (checkDirectAction): one saved by an older version, or changed
  // where it is saved, runs only if it fits, and then exactly as checked.
  if (job.action != null) {
    const secrets = secretsNow();
    const checked = checkDirectAction(job.action, { secrets });
    if (checked.problem) {
      console.warn(`[cron] Direct action "${job.id}" not run: ${checked.problem}`);
      return { error: `Not run: ${checked.problem}` };
    }
    // The log isn't where the owner decides, so it keeps what looks like a key out (lib/redact.js), and stays short.
    const shown = shownDirectAction(checked.action, { secrets });
    console.log(`[cron] Running direct action "${job.id}": ${shown.tool}(${redactSecrets(JSON.stringify(shown.args)).slice(0, 200)})`);
    try {
      const { executeTool } = await import("./tools.js");
      // Background work, as a prompt task's turn is (ai/turn.js): schedule_task refuses in it, so a task never makes tasks.
      const toolCtx = { db: _db, settingsStore: _settingsStore, conversationId: null, channelManager: _channelManager, background: "cron" };
      const result = await executeTool(checked.action.tool, checked.action.args, toolCtx);
      console.log(`[cron] Direct action "${job.id}" completed: ${result.slice(0, 100)}`);
      appendDailyLog(`[cron:${job.id}] ${result.slice(0, 200)}`);

      // Also save to channel conversation
      const channelKey = job.channel || "web:default";
      const convId = _settingsStore.get(`channel_conv.${channelKey}`);
      if (convId && _convStore) {
        _convStore.addMessage(convId, { role: "assistant", content: `**[Cron: ${job.id}]** ${result}` });
      }
      return { response: result };
    } catch (err) {
      console.error(`[cron] Direct action "${job.id}" failed:`, err.message);
      return { error: err.message };
    }
  }

  // --- AI prompt: a turn on the default AI (the turn layer picks it, and says plainly when it can't run) ---
  console.log(`[cron] Running AI job "${job.id}": ${(job.prompt || "").slice(0, 80)}...`);

  const systemParts = buildSystemPromptParts({
    settingsStore: _settingsStore,
    db: _db,
    conversationId: null,
    messageCount: 0,
    conversationPrompt: null,
    channelHint: `This is a scheduled cron job (${job.id}). Execute the task immediately. If the task asks you to send a message to a channel, use tarsee_send_message. Do NOT just describe what you would do — actually do it.`,
  });

  const messages = [
    {
      role: "user",
      content: `[Cron Job: ${job.id} — ${now}]\n\n${job.prompt}`,
    },
  ];

  // Resolve the model ONCE up front (see resolveCronModel): explicit per-job
  // tier → zero-token complexity heuristic → cheap floor → provider default.
  const jobModel = resolveCronModel(job);
  console.log(`[cron] Job "${job.id}" model → ${jobModel}`);

  const toolCtx = { db: _db, settingsStore: _settingsStore, conversationId: null, channelManager: _channelManager };
  const { text: fullResponse, error, provider: ranProvider, model: ranModel, overBudget } = await runBackgroundTurn({
    label: `cron:${job.id}`,
    liveId: `cron:${job.id}`,
    liveSource: "cron",
    model: jobModel,
    messages,
    systemParts,
    toolCtx,
    timeoutMs: JOB_TIMEOUT_MS,
  });

  // A stream `error` event used to be logged and then fall through to the
  // success path, so an expired credential or a turn-limit stop was recorded
  // as a completed job that happened to say nothing. Surface it instead: the
  // retry ladder and the auto-disable counter both key off this.
  if (error) {
    return { error };
  }

  // Finished, but over its spending limit (a Codex AI's cost is known only at the end): the reply stands, and says so.
  const warning = overBudgetWarning(overBudget);

  // Deliver to channel conversation
  const channelKey = job.channel || "web:default";
  const convId = _settingsStore.get(`channel_conv.${channelKey}`);

  if (convId && _convStore) {
    _convStore.addMessage(convId, {
      role: "assistant",
      content: `**[Cron: ${job.id}]**\n\n${fullResponse}${warning ? `\n\n_${warning}_` : ""}`,
      provider: ranProvider,
      model: ranModel || jobModel,
    });
  }

  appendDailyLog(`[cron:${job.id}] ${fullResponse.slice(0, 200)}${warning ? ` (${warning})` : ""}`);
  return warning ? { response: fullResponse, warning } : { response: fullResponse };
}

/**
 * Load cron jobs from settings DB. An entry that isn't a task at all (not an object) is left out, so it can't stop
 * the boot or the list.
 */
export function loadCronJobs() {
  if (!_settingsStore) return [];
  try {
    const raw = _settingsStore.get("cron.jobs");
    if (!raw) return [];
    const jobs = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(jobs) ? jobs.filter((j) => j && typeof j === "object" && !Array.isArray(j)) : [];
  } catch {
    return [];
  }
}

/**
 * Save cron jobs to settings DB.
 */
function saveCronJobs(jobs) {
  if (!_settingsStore) return;
  _settingsStore.set("cron.jobs", JSON.stringify(jobs));
}

// --- A direct action's args -----------------------------------------------------------------------------------------

/*
 * A task's direct action is { tool, args }: a tool lib/tools.js runs (executeTool) with no AI. Its args are checked
 * against that tool's own inputs when the task is saved (addCronJob) and again before every run (runOnce), and what
 * doesn't fit is refused. They used to go through unchecked, so a paused "Refresh Stripe key" task could run set_key
 * with the name ["RAILWAY_API_TOKEN"], a list, which JavaScript turns into "RAILWAY_API_TOKEN" as a property name, past
 * the check on Tarsee's own keys. A tool's inputs are lib/tools.js's definition of it, the names executeTool reads
 * (remember takes fact, not the MCP tool's content), else, for a tool only the MCP server has, its shape there
 * (ai/tarsee-mcp.js, whose handlers pass those args through unchanged). Only the inputs named there are taken, so what
 * the owner sees is all that runs. Besides fitting:
 *   - get_key never runs as one: its answer, a key's value, would be written to the daily log and the chat;
 *   - set_key, delete_key and discord_admin's save_as_key never name one of Tarsee's own keys (key-vault.js
 *     SERVER_ONLY_KEYS), not even for a first save: nobody is in a chat to have given it (the vault holds every
 *     writer to that too: key-vault.js serverOnlyWriteRefusal);
 *   - the args never hold a secret (secretProblem): a vault value, which the task names instead, or one of Tarsee's
 *     own tokens.
 * /cron list and Settings' task list show the tool and its args whole (shownDirectAction): only set_key's value and a
 * mailbox password are masked (MASKED_INPUTS), never anything picked by a value or a name the AI chose.
 */

let inputsByTool = null;

/** Each tool's inputs (JSON Schema), by the name executeTool runs it under, read once. */
function toolInputs() {
  if (inputsByTool) return inputsByTool;
  const map = new Map();
  try {
    for (const t of createTarseeMcp({}, { quiet: true, toolsOnly: true })) {
      if (typeof t?.name !== "string" || !t.name.startsWith("tarsee_")) continue;
      try { map.set(t.name.slice("tarsee_".length), z.toJSONSchema(z.object(t.inputSchema))); } catch { /* none in JSON: lib/tools.js's, if it has one */ }
    }
  } catch (err) {
    console.warn(`[cron] the MCP tools' inputs could not be read: ${err.message}`);
  }
  for (const d of getToolDefinitions()) map.set(d.name, d.input_schema);
  inputsByTool = map;
  return map;
}

/** The inputs (JSON Schema) a direct action of `tool` is checked against, or null when no tool has that name. */
export function directActionInputs(tool) {
  return typeof tool === "string" ? toolInputs().get(tool) ?? null : null;
}

const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A value's kind, in words. */
function kindOf(v) {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "string") return "text";
  if (typeof v === "number") return "a number";
  if (typeof v === "boolean") return "true or false";
  return plainObject(v) ? "an object" : `a ${typeof v}`;
}

/** A value as a refusal names it: text quoted (cut), anything else by its kind. */
const shownGiven = (v) => (typeof v === "string" ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : kindOf(v));

/** A tool's name as a refusal shows it: as it is when it is a plain name, else quoted. */
const toolWord = (tool) => (/^[A-Za-z0-9_]{1,64}$/.test(tool) ? tool : JSON.stringify(String(tool).slice(0, 64)));

const TYPE_WORDS = { string: "text", number: "a number", integer: "a whole number", boolean: "true or false", array: "a list", object: "an object", null: "null" };

/** What a schema takes, in words: "text", "a list of text", "text or a list of text", one of "a", "b". */
function takesWords(schema) {
  if (!plainObject(schema)) return "anything";
  const alts = schema.anyOf || schema.oneOf;
  if (Array.isArray(alts)) return alts.map(takesWords).join(" or ");
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const types = schema.type === undefined ? (schema.properties ? ["object"] : []) : [].concat(schema.type);
  if (!types.length) return "anything";
  return types.map((t) => {
    if (t === "array" && plainObject(schema.items) && takesWords(schema.items) !== "anything") return `a list of ${takesWords(schema.items)}`;
    return TYPE_WORDS[t] || t;
  }).join(" or ");
}

/** Whether value is of the schema's type (no type: anything). */
function typeMatches(schema, value) {
  const types = schema.type === undefined ? (schema.properties ? ["object"] : null) : [].concat(schema.type);
  if (!types) return true;
  return types.some((t) => {
    if (t === "string") return typeof value === "string";
    if (t === "number") return typeof value === "number" && Number.isFinite(value);
    if (t === "integer") return Number.isInteger(value);
    if (t === "boolean") return typeof value === "boolean";
    if (t === "array") return Array.isArray(value);
    if (t === "object") return plainObject(value);
    return t === "null" && value === null;
  });
}

/** Why value doesn't fit schema (where: its path, like imap.port), or null. JSON Schema as lib/tools.js and zod write it. */
function fitProblem(schema, value, where) {
  if (!plainObject(schema)) return null;
  const alts = schema.anyOf || schema.oneOf;
  if (Array.isArray(alts)) {
    if (alts.some((s) => fitProblem(s, value, where) === null)) return null;
    // A list given where a list of text is one of the forms: that form's own problem, which names the item.
    const ofKind = alts.filter((s) => plainObject(s) && typeMatches(s, value));
    if (ofKind.length === 1) return fitProblem(ofKind[0], value, where);
    return `${where} must be ${takesWords(schema)}, not ${kindOf(value)}`;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.some((e) => e === value) ? null : `${where} must be ${takesWords(schema)}, not ${shownGiven(value)}`;
  }
  if (schema.const !== undefined && value !== schema.const) return `${where} must be ${JSON.stringify(schema.const)}, not ${shownGiven(value)}`;
  if (!typeMatches(schema, value)) return `${where} must be ${takesWords(schema)}, not ${kindOf(value)}`;
  if (Array.isArray(value)) {
    if (!plainObject(schema.items)) return null;
    for (let i = 0; i < value.length; i++) {
      const problem = fitProblem(schema.items, value[i], `${where}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  return plainObject(value) ? objectProblem(schema, value, where) : null;
}

/**
 * Why an object doesn't fit: an input the inputs don't name, one of the wrong kind, or a required one missing (in that
 * order, so remember given content says content isn't one of its inputs, before fact is missing).
 */
function objectProblem(schema, value, where) {
  const props = plainObject(schema.properties) ? schema.properties : null;
  const at = (k) => (where ? `${where}.${k}` : k);
  const given = givenProblem(schema, props, value, at);
  if (given) return given;
  for (const k of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.hasOwn(value, k)) return `${at(k)} is required`;
  }
  return null;
}

/** objectProblem's first part: each input given, against what the inputs say of it. */
function givenProblem(schema, props, value, at) {
  for (const [k, v] of Object.entries(value)) {
    if (props && Object.hasOwn(props, k)) {
      const problem = fitProblem(props[k], v, at(k));
      if (problem) return problem;
      continue;
    }
    const extra = schema.additionalProperties;
    if (plainObject(extra)) {
      const problem = fitProblem(extra, v, at(k));
      if (problem) return problem;
      continue;
    }
    // An object whose inputs name nothing (web_fetch's headers) takes any; one that names them takes only those.
    if (extra === true || (!props && extra === undefined)) continue;
    return `${at(k)} isn't one of its inputs`;
  }
  return null;
}

/** "set_key takes name (text, required), value (text, required), description (text)." */
function usageOf(tool, schema) {
  const props = plainObject(schema?.properties) ? Object.entries(schema.properties) : [];
  if (!props.length) return `${toolWord(tool)} takes no args.`;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return `${toolWord(tool)} takes ${props.map(([k, s]) => `${k} (${takesWords(s)}${required.has(k) ? ", required" : ""})`).join(", ")}.`;
}

/**
 * A direct action, checked: { action: { tool, args } } (args as plain data, exactly what is saved and run), or
 * { problem }, a refusal in plain words that starts in lower case. See the block comment above for the rules.
 * secrets: secretsNow(), read once by a caller checking many; read now when not given.
 */
export function checkDirectAction(action, { secrets = null } = {}) {
  if (!plainObject(action) || typeof action.tool !== "string" || !action.tool || Object.keys(action).some((k) => k !== "tool" && k !== "args")) {
    return { problem: `an action is { tool, args }: the name of the tool to run and an object of its args, like {"tool":"send_message","args":{"channel":"web","message":"Hello"}}.` };
  }
  const { tool } = action;
  const schema = directActionInputs(tool);
  if (!schema) return { problem: `there is no tool named ${toolWord(tool)} for a scheduled task to run.` };
  if (tool === "get_key") {
    return { problem: "get_key never runs as a scheduled action: its answer, a key's value, would be written to the daily log and the chat in plain text. A script reads a key from its environment by the key's name instead." };
  }
  let args;
  try {
    args = action.args === undefined ? {} : JSON.parse(JSON.stringify(action.args));
  } catch {
    return { problem: `the action's args are plain data (text, numbers, true or false, lists and objects). ${usageOf(tool, schema)}` };
  }
  if (!plainObject(args)) return { problem: `the action's args are an object of ${toolWord(tool)}'s inputs, not ${kindOf(args)}. ${usageOf(tool, schema)}` };
  const misfit = objectProblem(schema, args, "");
  if (misfit) return { problem: `the action's args don't fit ${toolWord(tool)}: ${misfit}. ${usageOf(tool, schema)}` };
  // A key's name as each tool takes it: set_key and delete_key trim it and match any case; discord_admin makes one of
  // its save_as_key (lib/discord-admin.js keyNameFrom), which serverOnlyNameLoose matches.
  const own = (tool === "set_key" || tool === "delete_key") ? serverOnlyName(args.name)
    : tool === "discord_admin" ? serverOnlyNameLoose(args.save_as_key) : null;
  if (own) return { problem: `a scheduled action never writes ${own}: it is Tarsee's own key, and only the owner replaces or deletes it, in Settings > Keys.` };
  const held = secretProblem(tool, args, secrets ?? secretsNow());
  if (held) return { problem: held };
  return { action: { tool, args } };
}

// --- The secrets a direct action never carries ------------------------------------------------------------------------

/** Text shorter than this, trimmed, isn't taken for a secret (as key-vault.js serverOnlyValues). */
const SECRET_MIN = 8;

/**
 * The inputs, by tool and path, whose whole job is to hold a secret: the only ones /cron list and Settings mask, and
 * the only place a direct action's args may carry a vault value (a key saved again, a mailbox password the owner keeps
 * in the vault). Each is only kept as a key's value or used to sign in, never run, so masking it hides nothing a task
 * runs. Anything else the AI writes is shown whole, whatever its name says: a name it picks, like a header's, hides
 * nothing.
 */
export const MASKED_INPUTS = Object.freeze({
  set_key: Object.freeze(["value"]),
  configure_email_channel: Object.freeze(["imap.password", "smtp.password"]),
});
const isMasked = (tool, where) => Object.hasOwn(MASKED_INPUTS, tool) && MASKED_INPUTS[tool].includes(where);

/** Whether the owner has denied get_key in Tool Permissions: then the AI can't read the vault's values. */
function getKeyDenied() {
  try { return getSecurityManager(_settingsStore).getToolPermission("get_key") === "always_deny"; } catch { return false; }
}

/**
 * The secrets a direct action's args are checked against, read now: a check made later (before a run) reads them
 * again, so a key saved since the task was counts.
 *   own    Tarsee's own tokens, each with its name: the Railway token, in the vault or where Tarsee runs, and any key
 *          holding a copy (key-vault.js serverOnlyValues); each AI provider's key (Anthropic, OpenAI, OpenRouter,
 *          DeepSeek), set where it runs or saved in Settings > AI, and the Claude plan's CLAUDE_CODE_OAUTH_TOKEN; the
 *          API token Tarsee made itself (api.token). Never in a task's args, masked input or not: with one, a task
 *          would reach Railway or a provider past every limit of Tarsee's own tools.
 *   vault  the values get_key returns, each with the names of the keys holding it: a task names the key instead.
 * Each refusal tells the AI that its text holds the secret, so only secrets it can't guess are checked: values it can
 * read anyway (none while get_key is denied), and tokens a service or Tarsee issued at random. Never SETUP_PASSWORD or
 * a mailbox password, which someone chose, nor ENCRYPTION_KEY, a TARSEE_API_TOKEN or a Local AI key, which the owner
 * may have: a refusal would confirm a guess, as many guesses a call as a task's args hold. With nothing masked by
 * value, nothing hides behind them.
 */
function secretsNow() {
  const own = new Map();
  const add = (v, label) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length >= SECRET_MIN && !own.has(s)) own.set(s, label);
  };
  try { for (const [v, name] of serverOnlyValues()) add(v, name); } catch { /* the vault can't be read */ }
  for (const id of PROVIDER_IDS) {
    const p = getProvider(id);
    if (p?.kind !== "key" || !p.envKey) continue;   // a sign-in plan has no key; Local AI's may be any word typed
    add(process.env[p.envKey], p.envKey);
    try { add(_settingsStore?.getKeyWithSource?.(id, { envName: null })?.key, `${p.envKey}, saved in Settings > AI`); } catch { /* settings can't be read */ }
  }
  add(process.env.CLAUDE_CODE_OAUTH_TOKEN, "CLAUDE_CODE_OAUTH_TOKEN");
  if (!String(process.env.TARSEE_API_TOKEN ?? "").trim()) add(config.API_TOKEN, "the API token Tarsee made, api.token");
  const vault = new Map();
  if (getKeyDenied()) return { own, vault };
  let keys = {};
  try { keys = getAllKeysDecrypted(); } catch { /* the vault can't be read */ }
  for (const [name, v] of Object.entries(keys)) {
    const s = typeof v === "string" ? v.trim() : "";
    // get_key never returns Tarsee's own keys nor a copy of one: those are `own`.
    if (s.length < SECRET_MIN || own.has(s) || serverOnlyName(name)) continue;
    if (!vault.has(s)) vault.set(s, []);
    vault.get(s).push(name);
  }
  return { own, vault };
}

/** "key A", "keys A and B". */
const keyWords = (names) => (names.length === 1 ? `key ${names[0]}` : `keys ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
/** Where in the args, as a refusal says it, never too long (an object's name is the AI's). */
const shownWhere = (where) => (where.length > 80 ? `${where.slice(0, 80)}...` : where);

/** Every text in args, with where it is (as fitProblem names it: command, imap.password, to[1]); names in an object too. */
function textsIn(value, where, out = []) {
  if (typeof value === "string") out.push({ text: value, where, name: false });
  else if (Array.isArray(value)) value.forEach((v, i) => textsIn(v, `${where}[${i}]`, out));
  else if (plainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push({ text: k, where: where ? `a name in ${where}` : "a name in the args", name: true });
      textsIn(v, where ? `${where}.${k}` : k, out);
    }
  }
  return out;
}

/** Why a direct action's args may not hold what they hold (secretsNow), or null. */
function secretProblem(tool, args, { own, vault }) {
  for (const { text, where, name } of textsIn(args, "")) {
    for (const [v, label] of own) {
      if (text.includes(v)) return `the action's args hold one of Tarsee's own secrets (${label}), in ${shownWhere(where)}. A scheduled task never carries one, not even as set_key's value or a mailbox password: Tarsee's own tools use it, and nothing else does.`;
    }
    if (!name && isMasked(tool, where)) continue;
    for (const [v, keys] of vault) {
      if (text.includes(v)) return `the action's args hold the value of the vault ${keyWords(keys)}, in ${shownWhere(where)}. What a task runs is shown to the owner whole, so its args never carry a key's value: name the vault key instead (a command reads it from its environment, as $${keys[0]}).`;
    }
  }
  return null;
}

// --- What a direct action runs, as the owner sees it ------------------------------------------------------------------

const SECRET_SHOWN = "[secret, not shown]";

/** A masked input as it is shown: "[secret, not shown]", naming the vault key it is (or holds) when get_key returns one. */
function maskedWords(text, vault) {
  const equal = [];
  const within = [];
  for (const [v, keys] of vault) {
    if (text.trim() === v) equal.push(...keys);
    else if (text.includes(v)) within.push(...keys);
  }
  if (equal.length) return `[secret, not shown: the value of the vault ${keyWords(equal)}]`;
  if (within.length) return `[secret, not shown: holds the value of the vault ${keyWords(within)}]`;
  return SECRET_SHOWN;
}

/** args with each masked input's text masked (MASKED_INPUTS); everything else as it is, whatever its kind. */
function maskInputs(tool, value, where, vault) {
  if (typeof value === "string") return isMasked(tool, where) ? maskedWords(value, vault) : value;
  if (Array.isArray(value)) return value.map((v, i) => maskInputs(tool, v, `${where}[${i}]`, vault));
  // fromEntries makes each name an entry of its own, "__proto__" too, as JSON.parse did.
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskInputs(tool, v, where ? `${where}.${k}` : k, vault)]));
  return value;
}

/**
 * What a direct action runs, as /cron list, Settings' task list (getCronStatus: actionShown) and the server's log show
 * it: { tool, args }, with every text whole and only MASKED_INPUTS masked. Shown for any action, even one that no
 * longer fits (one saved by an older version, args that aren't an object included), so the owner sees what they would
 * switch on. How it is written out (the JSON, with what would look blank escaped) is js/cron-core.js argsText's, on
 * both ends. secrets: secretsNow(), read once by a caller showing many.
 */
export function shownDirectAction(action, { secrets = null } = {}) {
  const { vault } = secrets ?? secretsNow();
  const tool = typeof action?.tool === "string" ? action.tool : kindOf(action?.tool);
  let args;
  try { args = action?.args === undefined ? {} : JSON.parse(JSON.stringify(action.args)); } catch { args = kindOf(action?.args); }
  return { tool, args: maskInputs(tool, args === undefined ? {} : args, "", vault) };
}

/** shownDirectAction, and why it won't run as it is (checkDirectAction's problem), or null: Settings says so. */
function actionShownOf(action, secrets) {
  return { ...shownDirectAction(action, { secrets }), problem: checkDirectAction(action, { secrets }).problem || null };
}

/**
 * Add a new cron job.
 *
 * createdBy says who made it. "owner" (the Settings form, /cron add, /briefing: the owner typed or clicked it) saves
 * it as asked, switched on unless enabled is false. Anything else, the AI's schedule_task tool above all, saves it
 * switched off and waiting for the owner's OK (awaitingOwner), with no timer until the owner switches it on: a caller
 * that doesn't say the owner made a task never starts paid runs. conversationId: the chat the AI made it in.
 *
 * A task that asks the AI (no action) must pass promptScheduleProblem. A direct action can't be schedule_task, and
 * must pass checkDirectAction: it is saved as exactly the { tool, args } that check passed. Any schedule must pass
 * unsafeScheduleProblem before node-cron sees it.
 *
 * id: a fixed id the caller finds its own task by later (the morning briefing's cron_briefingam), taken only when no
 * saved task has it. Otherwise the task gets a new one (newJobId).
 */
export function addCronJob({ schedule, prompt, channel = "web:default", enabled = true, name, action, once = false, createdBy = "ai", conversationId = null, id: fixedId = null }) {
  if (typeof schedule !== "string") throw new Error(`Invalid cron schedule: ${schedule}`);
  const unsafe = unsafeScheduleProblem(schedule);
  if (unsafe) throw new Error(unsafe);
  if (!cron.validate(schedule)) throw new Error(`Invalid cron schedule: ${schedule}`);
  if (action?.tool === "schedule_task") {
    throw new Error("A task can't schedule more tasks: only the owner sets up scheduled tasks.");
  }
  let direct = null;
  if (action != null) {
    const checked = checkDirectAction(action);
    if (checked.problem) throw new Error(`${checked.problem} Nothing was saved.`);
    direct = checked.action;
  }
  if (!direct) {
    const problem = promptScheduleProblem(schedule);
    if (problem) throw new Error(problem);
  }

  const byOwner = createdBy === "owner";
  const jobs = loadCronJobs();
  const id = typeof fixedId === "string" && fixedId && !jobs.some((j) => j.id === fixedId) ? fixedId : newJobId(jobs, name);
  const newJob = { id, schedule, prompt: prompt || "", channel, enabled: byOwner ? enabled !== false : false, createdBy: byOwner ? "owner" : "ai" };
  if (!byOwner) newJob.awaitingOwner = true;
  if (!byOwner && conversationId) newJob.conversationId = conversationId;
  if (direct) newJob.action = direct;
  if (name) newJob.name = name;
  if (once) newJob.once = true;
  jobs.push(newJob);
  saveCronJobs(jobs);

  // Reset error state and start immediately if enabled
  jobState.delete(id);
  if (shouldRun(newJob)) scheduleJob(newJob);

  return newJob;
}

/**
 * A new task's id: cron_ and the first 12 letters and digits of its name, then a time stamp (cron_dailyreport_mhs0k2x1).
 * The stamp means an id freed by a deleted or one-time task never goes to a different one: its runs, Pause and Delete,
 * and its use in the token counts all go by the id.
 */
function newJobId(jobs, name) {
  const slug = name ? String(name).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) : "";
  return uniqueId(jobs, slug ? `cron_${slug}` : "cron");
}

/** base_<time stamp>, taken by no task in jobs. */
function uniqueId(jobs, base) {
  const taken = new Set(jobs.map((j) => j.id));
  let id;
  do id = `${base}_${timeStamp()}`; while (taken.has(id));
  return id;
}

let lastStamp = 0;
/** The time in milliseconds, in letters and digits; never the same twice in a run of Tarsee, even within a millisecond. */
function timeStamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp.toString(36);
}

/**
 * Switch a task on or off: the owner's call (PATCH /api/settings/cron/:id, /cron on|off <id>, the Switch on and
 * Pause buttons in Settings > Automation > Scheduled tasks). Switching on is the owner's OK: a waiting task's mark
 * goes (and stays gone), its failure count starts again, and it gets its timer. Off stops the timer; a run already
 * going finishes. Returns the saved task, or null when there is no task with that id.
 */
export function setCronJobEnabled(id, enabled) {
  const jobs = loadCronJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  job.enabled = !!enabled;
  if (job.enabled) delete job.awaitingOwner;
  // Paused or switched off: a failed run of it waiting to retry stops there (ownerLetItGoOn), even if it is switched on again.
  if (!job.enabled) ownerStops.set(id, (ownerStops.get(id) || 0) + 1);
  saveCronJobs(jobs);

  unscheduleJob(id);
  if (shouldRun(job)) {
    jobState.delete(id);
    scheduleJob(job);
  }
  return job;
}

/**
 * Remove a cron job by ID.
 */
export function removeCronJob(id) {
  const jobs = loadCronJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;

  jobs.splice(idx, 1);
  saveCronJobs(jobs);

  unscheduleJob(id);
  jobState.delete(id);
  // Deleting is a stop too, counted, never forgotten: /briefing off then on saves the briefing again under its fixed id,
  // and a run of the deleted one still waiting to retry must not go on as if the new one were its own (ownerLetItGoOn).
  ownerStops.set(id, (ownerStops.get(id) || 0) + 1);

  return true;
}

/**
 * Get cron status with runtime state. Each task also says:
 *   state       "running" (a run is going now), "waiting" (the AI made it; it waits for the owner's OK), "on", "off"
 *   scheduled   whether it has a timer
 *   running     whether a run is going now
 *   actionShown for a task that runs a tool directly: { tool, args, problem } to show: the args whole, only set_key's
 *               value and a mailbox password masked (shownDirectAction), and why it won't run as it is, or null.
 *               action stays as saved, for the Switch on check (routes/settings.js sameAsSeen).
 */
export function getCronStatus() {
  const jobs = loadCronJobs();
  let secrets = null;   // read once, and only when a task runs a tool directly
  return {
    totalJobs: jobs.length,
    activeJobs: activeJobs.size,
    jobs: jobs.map((j) => {
      const state = jobState.get(j.id);
      const running = (runsGoing.get(j.id) || 0) > 0;
      const shown = j.action != null ? { actionShown: actionShownOf(j.action, (secrets ??= secretsNow())) } : {};
      return {
        ...j,
        ...shown,
        createdBy: j.createdBy || null,
        awaitingOwner: !!j.awaitingOwner,
        state: running ? "running" : j.awaitingOwner ? "waiting" : j.enabled ? "on" : "off",
        scheduled: activeJobs.has(j.id),
        running,
        lastRun: state?.lastRun ? new Date(state.lastRun).toISOString() : null,
        lastStatus: state?.lastStatus || null,
        lastError: state?.lastError || null,
        consecutiveErrors: state?.consecutiveErrors || 0,
        autoDisabled: (state?.consecutiveErrors || 0) >= MAX_CONSECUTIVE_ERRORS,
      };
    }),
  };
}
