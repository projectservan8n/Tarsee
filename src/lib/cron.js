import cron from "node-cron";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { chatStream } from "../ai/router.js";
import { appendDailyLog } from "./workspace-files.js";
import { resolveModelAlias, isKnownModel } from "../config/constants.js";

/**
 * Cron job scheduler — run AI tasks on a schedule.
 *
 * Job spec stored in settings DB as JSON array: "cron.jobs"
 * Each job: { id, schedule, prompt, channel, enabled }
 *
 * - schedule: standard cron expression (e.g. "0 9 * * *" = 9 AM daily)
 * - prompt: the message to send to the AI
 * - channel: which channel to deliver to (default: "web:default")
 * - enabled: boolean
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
function resolveCronModel(job, activeProvider) {
  let pick = job.model;
  if (!pick) {
    const autoTier = _settingsStore?.get("cron.autoTier");
    if (autoTier !== false && autoTier !== "false") {
      pick = autoTierForPrompt(job.prompt);
    }
  }
  pick = pick || _settingsStore?.get("cron.defaultModel") || activeProvider?.model;
  return resolveModelAlias(pick) || pick;
}
let _convStore = null;
let _channelManager = null;
const activeJobs = new Map(); // id → cron.ScheduledTask
const jobState = new Map();   // id → { lastRun, lastStatus, lastError, consecutiveErrors }

const JOB_TIMEOUT_MS = 120_000; // 2 minutes max per job
const MAX_CONSECUTIVE_ERRORS = 5; // Auto-disable after this many failures
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;

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
 * Load and start all enabled cron jobs.
 */
export function startCronScheduler() {
  stopCronScheduler();
  const jobs = loadCronJobs();

  for (const job of jobs) {
    if (!job.enabled) continue;
    scheduleJob(job);
  }

  console.log(`[cron] Started ${activeJobs.size} job(s)`);
}

/**
 * Stop all running cron jobs.
 */
export function stopCronScheduler() {
  for (const [, task] of activeJobs) {
    task.stop();
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

  const task = cron.schedule(job.schedule, () => {
    runCronJobWithRetry(job).then(() => {
      // Auto-delete one-time jobs after they fire
      if (job.once) {
        console.log(`[cron] One-time job "${job.id}" completed, removing`);
        removeCronJob(job.id);
      }
    }).catch((err) => {
      console.error(`[cron] Job ${job.id} fatal error:`, err.message);
    });
  });

  activeJobs.set(job.id, task);
}

/**
 * Run a cron job with retry and timeout.
 */
async function runCronJobWithRetry(job) {
  // Check if auto-disabled from too many errors
  const state = jobState.get(job.id) || { consecutiveErrors: 0 };
  if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.warn(`[cron] Job "${job.id}" auto-disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Last: ${state.lastError}`);
    return { error: "Auto-disabled" };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await runCronJob(job);

    if (!result.error) {
      // Success — reset error counter
      jobState.set(job.id, { lastRun: Date.now(), lastStatus: "ok", lastError: null, consecutiveErrors: 0 });
      // Fire a push notification so the user knows the job finished even
      // if they're not watching the app. Best-effort — failures don't
      // affect the job result.
      notifyJobComplete(job, "ok").catch(() => {});
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
export async function runCronJob(job) {
  if (!_settingsStore || !_db) {
    return { error: "Not initialized" };
  }

  const now = new Date().toISOString();

  // --- Direct action: execute tool immediately without AI ---
  if (job.action?.tool) {
    console.log(`[cron] Running direct action "${job.id}": ${job.action.tool}(${JSON.stringify(job.action.args).slice(0, 100)})`);
    try {
      const { executeTool } = await import("./tools.js");
      const toolCtx = { db: _db, settingsStore: _settingsStore, conversationId: null, channelManager: _channelManager };
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

  // --- AI prompt: send to Claude Code ---
  const activeProvider = _settingsStore.getActiveProvider();
  if (!activeProvider?.ready || !activeProvider?.provider) {
    return { error: "No AI provider configured" };
  }

  console.log(`[cron] Running AI job "${job.id}": ${(job.prompt || "").slice(0, 80)}...`);

  const systemPrompt = buildSystemPrompt({
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
  const jobModel = resolveCronModel(job, activeProvider);
  console.log(`[cron] Job "${job.id}" model → ${jobModel}`);

  // Timeout protection
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);

  try {
    let fullResponse = "";
    const toolCtx = { db: _db, settingsStore: _settingsStore, conversationId: null, channelManager: _channelManager };
    const stream = chatStream({
      provider: activeProvider.provider,
      model: jobModel,
      apiKey: activeProvider.apiKey,
      baseUrl: activeProvider.baseUrl,
      messages,
      systemPrompt,
      toolCtx,
      signal: controller.signal,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        fullResponse += event.content;
      } else if (event.type === "error") {
        console.error(`[cron] Job "${job.id}" stream error:`, event.message);
      } else if (event.type === "done") {
        break;
      }
    }

    clearTimeout(timeout);

    // Deliver to channel conversation
    const channelKey = job.channel || "web:default";
    const convId = _settingsStore.get(`channel_conv.${channelKey}`);

    if (convId && _convStore) {
      _convStore.addMessage(convId, {
        role: "assistant",
        content: `**[Cron: ${job.id}]**\n\n${fullResponse}`,
        provider: activeProvider.provider,
        model: jobModel,
      });
    }

    appendDailyLog(`[cron:${job.id}] ${fullResponse.slice(0, 200)}`);
    console.log(`[cron] Job "${job.id}" completed: ${fullResponse.slice(0, 100)}`);
    return { response: fullResponse };
  } catch (err) {
    clearTimeout(timeout);
    const errMsg = err.name === "AbortError" ? `Timed out after ${JOB_TIMEOUT_MS / 1000}s` : err.message;
    console.error(`[cron] Job "${job.id}" failed:`, errMsg);
    return { error: errMsg };
  }
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
 */
export function addCronJob({ schedule, prompt, channel = "web:default", enabled = true, name, action, once = false }) {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }

  const jobs = loadCronJobs();
  const id = name ? `cron_${name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}` : `cron_${Date.now().toString(36)}`;
  const newJob = { id, schedule, prompt: prompt || "", channel, enabled };
  if (action) newJob.action = action;
  if (name) newJob.name = name;
  if (once) newJob.once = true;
  jobs.push(newJob);
  saveCronJobs(jobs);

  // Reset error state and start immediately if enabled
  jobState.delete(id);
  if (enabled) scheduleJob(newJob);

  return newJob;
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

  const task = activeJobs.get(id);
  if (task) {
    task.stop();
    activeJobs.delete(id);
  }
  jobState.delete(id);

  return true;
}

/**
 * Get cron status with runtime state.
 */
export function getCronStatus() {
  const jobs = loadCronJobs();
  return {
    totalJobs: jobs.length,
    activeJobs: activeJobs.size,
    jobs: jobs.map((j) => {
      const state = jobState.get(j.id);
      return {
        ...j,
        running: activeJobs.has(j.id),
        lastRun: state?.lastRun ? new Date(state.lastRun).toISOString() : null,
        lastStatus: state?.lastStatus || null,
        lastError: state?.lastError || null,
        consecutiveErrors: state?.consecutiveErrors || 0,
        autoDisabled: (state?.consecutiveErrors || 0) >= MAX_CONSECUTIVE_ERRORS,
      };
    }),
  };
}
