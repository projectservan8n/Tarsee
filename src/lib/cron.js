import cron from "node-cron";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { chatStream } from "../ai/router.js";
import { appendDailyLog } from "./workspace-files.js";

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
let _convStore = null;
const activeJobs = new Map(); // id → cron.ScheduledTask

/**
 * Initialize the cron system.
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {import('../db/conversations.js').ConversationStore} opts.convStore
 */
export function initCron({ db, settingsStore, convStore }) {
  _db = db;
  _settingsStore = settingsStore;
  _convStore = convStore;
}

/**
 * Load and start all enabled cron jobs.
 */
export function startCronScheduler() {
  stopCronScheduler(); // Clear any existing
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
  for (const [id, task] of activeJobs) {
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
    runCronJob(job).catch((err) => {
      console.error(`[cron] Job ${job.id} error:`, err.message);
    });
  });

  activeJobs.set(job.id, task);
}

/**
 * Run a cron job — send prompt to AI and deliver response.
 * @param {object} job
 * @returns {Promise<{response?: string, error?: string}>}
 */
export async function runCronJob(job) {
  if (!_settingsStore || !_db) {
    return { error: "Not initialized" };
  }

  const activeProvider = _settingsStore.getActiveProvider();
  if (!activeProvider?.apiKey || !activeProvider?.provider) {
    return { error: "No AI provider configured" };
  }

  const now = new Date().toISOString();
  console.log(`[cron] Running job "${job.id}": ${job.prompt.slice(0, 80)}...`);

  const systemPrompt = buildSystemPrompt({
    settingsStore: _settingsStore,
    db: _db,
    conversationId: null,
    messageCount: 0,
    conversationPrompt: null,
    channelHint: `This is a scheduled cron job (${job.id}). Execute the task and report results.`,
  });

  const messages = [
    {
      role: "user",
      content: `[Cron Job: ${job.id} — ${now}]\n\n${job.prompt}`,
    },
  ];

  try {
    let fullResponse = "";
    const stream = chatStream({
      provider: activeProvider.provider,
      model: activeProvider.model,
      apiKey: activeProvider.apiKey,
      baseUrl: activeProvider.baseUrl,
      messages,
      systemPrompt,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        fullResponse += event.content;
      } else if (event.type === "done") {
        break;
      }
    }

    // Deliver to channel conversation
    const channelKey = job.channel || "web:default";
    let convId = _settingsStore.get(`channel_conv.${channelKey}`);

    if (convId && _convStore) {
      _convStore.addMessage(convId, {
        role: "assistant",
        content: `**[Cron: ${job.id}]**\n\n${fullResponse}`,
        provider: activeProvider.provider,
        model: activeProvider.model,
      });
    }

    appendDailyLog(`[cron:${job.id}] ${fullResponse.slice(0, 200)}`);
    console.log(`[cron] Job "${job.id}" completed: ${fullResponse.slice(0, 100)}`);
    return { response: fullResponse };
  } catch (err) {
    console.error(`[cron] Job "${job.id}" failed:`, err.message);
    return { error: err.message };
  }
}

/**
 * Load cron jobs from settings DB.
 * @returns {Array<{id: string, schedule: string, prompt: string, channel: string, enabled: boolean}>}
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
 * @param {Array} jobs
 */
function saveCronJobs(jobs) {
  if (!_settingsStore) return;
  _settingsStore.set("cron.jobs", JSON.stringify(jobs));
}

/**
 * Add a new cron job.
 * @param {object} job - { schedule, prompt, channel?, enabled? }
 * @returns {object} The created job
 */
export function addCronJob({ schedule, prompt, channel = "web:default", enabled = true }) {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }

  const jobs = loadCronJobs();
  const id = `cron_${Date.now().toString(36)}`;
  const newJob = { id, schedule, prompt, channel, enabled };
  jobs.push(newJob);
  saveCronJobs(jobs);

  // Start immediately if enabled
  if (enabled) scheduleJob(newJob);

  return newJob;
}

/**
 * Remove a cron job by ID.
 * @param {string} id
 * @returns {boolean}
 */
export function removeCronJob(id) {
  const jobs = loadCronJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;

  jobs.splice(idx, 1);
  saveCronJobs(jobs);

  // Stop if running
  const task = activeJobs.get(id);
  if (task) {
    task.stop();
    activeJobs.delete(id);
  }

  return true;
}

/**
 * Get cron status.
 */
export function getCronStatus() {
  const jobs = loadCronJobs();
  return {
    totalJobs: jobs.length,
    activeJobs: activeJobs.size,
    jobs: jobs.map((j) => ({
      ...j,
      running: activeJobs.has(j.id),
    })),
  };
}
