import cron from "node-cron";
import { buildSystemPromptParts } from "./build-system-prompt.js";
import { chatStream } from "../ai/router.js";
import { appendDailyLog } from "./workspace-files.js";
import { resolveModelAlias, isKnownModel, BACKGROUND_DEFAULTS } from "../config/constants.js";
import { runBackgroundTurn, resolveBackgroundModel, overBudgetWarning } from "./background-turn.js";
import config from "../config/env.js";

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
 * going when the task's next time comes is skipped, not stacked (scheduleJob, noOverlap).
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
  if (!cron.validate(text)) return `Invalid cron schedule: ${text}`;
  const gap = closestRuns(text);
  if (gap >= MIN_PROMPT_GAP_MINUTES) return null;
  return `"${text}" runs ${gap === 1 ? "1 minute" : `${gap} minutes`} apart. ${rule}: "*/${MIN_PROMPT_GAP_MINUTES} * * * *" is the most often.`;
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
 * Load and start all enabled cron jobs. A task waiting for the owner's OK gets no timer.
 */
export function startCronScheduler() {
  stopCronScheduler();
  const jobs = loadCronJobs();

  for (const job of jobs) {
    if (!shouldRun(job)) continue;
    scheduleJob(job);
  }

  console.log(`[cron] Started ${activeJobs.size} job(s)`);
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
  if (!cron.validate(job.schedule)) {
    console.warn(`[cron] Invalid schedule for job ${job.id}: ${job.schedule}`);
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
  // to return nothing, so every tick started another paid run on top of the last.
  const task = cron.schedule(job.schedule, () => runScheduled(job), { timezone: config.TIMEZONE, noOverlap: true });

  activeJobs.set(job.id, task);
}

/** Stop a task's timer, if it has one (a run already going finishes). */
function unscheduleJob(id) {
  const task = activeJobs.get(id);
  if (!task) return;
  task.destroy();
  activeJobs.delete(id);
}

/** One scheduled run of a task: the promise node-cron waits on. A task paused meanwhile gets no more retries. */
function runScheduled(job) {
  return runCronJobWithRetry(job, { stillOn: () => activeJobs.has(job.id) }).then(() => {
    // Auto-delete one-time jobs after they fire
    if (job.once) {
      console.log(`[cron] One-time job "${job.id}" completed, removing`);
      removeCronJob(job.id);
    }
  }).catch((err) => {
    console.error(`[cron] Job ${job.id} fatal error:`, err.message);
  });
}

/**
 * Run a cron job with retry and timeout. opts.stillOn: asked before each retry; false (the owner paused or deleted the
 * task meanwhile) ends it there, so a paused task never starts another paid run.
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
        return result;
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
  if (job.action?.tool) {
    console.log(`[cron] Running direct action "${job.id}": ${job.action.tool}(${JSON.stringify(job.action.args).slice(0, 100)})`);
    try {
      const { executeTool } = await import("./tools.js");
      // Background work, as a prompt task's turn is (ai/turn.js): schedule_task refuses in it, so a task never makes tasks.
      const toolCtx = { db: _db, settingsStore: _settingsStore, conversationId: null, channelManager: _channelManager, background: "cron" };
      const result = await executeTool(job.action.tool, job.action.args || {}, toolCtx);
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
 * Load cron jobs from settings DB.
 */
export function loadCronJobs() {
  if (!_settingsStore) return [];
  try {
    const raw = _settingsStore.get("cron.jobs");
    if (!raw) return [];
    const jobs = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(jobs) ? jobs : [];
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

/**
 * Add a new cron job.
 *
 * createdBy says who made it. "owner" (the Settings form, /cron add, /briefing: the owner typed or clicked it) saves
 * it as asked, switched on unless enabled is false. Anything else, the AI's schedule_task tool above all, saves it
 * switched off and waiting for the owner's OK (awaitingOwner), with no timer until the owner switches it on: a caller
 * that doesn't say the owner made a task never starts paid runs. conversationId: the chat the AI made it in.
 *
 * A task that asks the AI (no action) must pass promptScheduleProblem. A direct action can't be schedule_task.
 */
export function addCronJob({ schedule, prompt, channel = "web:default", enabled = true, name, action, once = false, createdBy = "ai", conversationId = null }) {
  if (typeof schedule !== "string" || !cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }
  if (action?.tool === "schedule_task") {
    throw new Error("A task can't schedule more tasks: only the owner sets up scheduled tasks.");
  }
  if (!action?.tool) {
    const problem = promptScheduleProblem(schedule);
    if (problem) throw new Error(problem);
  }

  const byOwner = createdBy === "owner";
  const jobs = loadCronJobs();
  const id = newJobId(jobs, name);
  const newJob = { id, schedule, prompt: prompt || "", channel, enabled: byOwner ? enabled !== false : false, createdBy: byOwner ? "owner" : "ai" };
  if (!byOwner) newJob.awaitingOwner = true;
  if (!byOwner && conversationId) newJob.conversationId = conversationId;
  if (action) newJob.action = action;
  if (name) newJob.name = name;
  if (once) newJob.once = true;
  jobs.push(newJob);
  saveCronJobs(jobs);

  // Reset error state and start immediately if enabled
  jobState.delete(id);
  if (shouldRun(newJob)) scheduleJob(newJob);

  return newJob;
}

/** A task id from its name (cron_<letters and digits>), else from the time; with _2, _3... when it is taken. */
function newJobId(jobs, name) {
  const slug = name ? String(name).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) : "";
  const base = slug ? `cron_${slug}` : `cron_${Date.now().toString(36)}`;
  let id = base;
  for (let n = 2; jobs.some((j) => j.id === id); n++) id = `${base}_${n}`;
  return id;
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

  return true;
}

/**
 * Get cron status with runtime state. Each task also says:
 *   state       "running" (a run is going now), "waiting" (the AI made it; it waits for the owner's OK), "on", "off"
 *   scheduled   whether it has a timer
 *   running     whether a run is going now
 */
export function getCronStatus() {
  const jobs = loadCronJobs();
  return {
    totalJobs: jobs.length,
    activeJobs: activeJobs.size,
    jobs: jobs.map((j) => {
      const state = jobState.get(j.id);
      const running = (runsGoing.get(j.id) || 0) > 0;
      return {
        ...j,
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
