import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { getHeartbeatContext, appendDailyLog } from "./workspace-files.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { runBackgroundTurn, resolveBackgroundModel } from "./background-turn.js";

/**
 * Heartbeat system — periodically runs HEARTBEAT.md tasks through the AI.
 *
 * - Default interval: 30 minutes
 * - Skips if HEARTBEAT.md is empty (zero API cost)
 * - HEARTBEAT_OK response token = suppress output (save noise)
 * - State tracked in memory/heartbeat-state.json
 */

const STATE_FILE = path.join(config.WORKSPACE_DIR, "memory", "heartbeat-state.json");
let heartbeatTimer = null;
let _db = null;
let _settingsStore = null;
let _channelManager = null;
/** True while a heartbeat turn is in flight. See the overlap guard below. */
let running = false;

/**
 * Load heartbeat state from disk.
 */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastRun: null, runCount: 0, lastResult: null };
  }
}

/**
 * Save heartbeat state to disk.
 */
function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Run a single heartbeat cycle.
 * @param {string} [reason="scheduled"] - Why this heartbeat was triggered
 * @returns {Promise<{skipped: boolean, response?: string}>}
 */
export async function runHeartbeat(reason = "scheduled") {
  // Overlap guard. The timer fired every 30 minutes regardless of whether the
  // previous run had finished, so a heartbeat that wedged (or simply took
  // longer than the interval) stacked concurrent model turns on top of each
  // other, each holding its own Claude Code subprocess, until the container
  // ran out of memory. One at a time, always.
  if (running) {
    console.warn(`[heartbeat] previous run still in flight — skipping this ${reason} tick`);
    return { skipped: true, reason: "Previous heartbeat still running" };
  }

  const heartbeatContent = getHeartbeatContext();

  if (!heartbeatContent) {
    return { skipped: true, reason: "HEARTBEAT.md is empty" };
  }

  if (!_settingsStore || !_db) {
    return { skipped: true, reason: "Not initialized" };
  }

  const activeProvider = _settingsStore.getActiveProvider();
  if (!activeProvider?.ready || !activeProvider?.provider) {
    return { skipped: true, reason: "No AI provider configured" };
  }

  const now = new Date().toISOString();
  console.log(`[heartbeat] Running (reason: ${reason})...`);
  running = true;

  // Build a lightweight system prompt with workspace context
  const systemPrompt = buildSystemPrompt({
    settingsStore: _settingsStore,
    db: _db,
    conversationId: null,
    messageCount: 0,
    conversationPrompt: null,
    channelHint: "This is a periodic heartbeat check. Review the HEARTBEAT.md tasks and respond with your findings. If everything is OK and there's nothing to report, respond with just: HEARTBEAT_OK",
  });

  const messages = [
    {
      role: "user",
      content: `[Heartbeat — ${now}]\n\n${heartbeatContent}`,
    },
  ];

  try {
    // Channel manager included so the heartbeat can actually reach Telegram
    // and Discord. Without it, a HEARTBEAT.md task that says "message me if X"
    // ran the model, decided to notify, called the tool, and silently failed.
    const toolCtx = {
      db: _db,
      settingsStore: _settingsStore,
      conversationId: null,
      channelManager: _channelManager,
    };
    // Cheap model by default. This is a poll that answers "nothing to report"
    // the overwhelming majority of the time, and it fires every 30 minutes
    // forever — running it on the interactive top-tier default was the most
    // expensive idle loop in the product. `heartbeat.model` raises it.
    const { text: fullResponse, error } = await runBackgroundTurn({
      label: "heartbeat",
      model: resolveBackgroundModel(_settingsStore.get("heartbeat.model")),
      messages,
      systemPrompt,
      toolCtx,
    });

    if (error) {
      const state = loadState();
      state.lastRun = now;
      state.lastResult = `Error: ${error}`;
      saveState(state);
      return { skipped: false, error };
    }

    const isSuppressed = fullResponse.trim() === "HEARTBEAT_OK";

    // Update state
    const state = loadState();
    state.lastRun = now;
    state.runCount = (state.runCount || 0) + 1;
    state.lastResult = isSuppressed ? "OK (suppressed)" : fullResponse.slice(0, 500);
    saveState(state);

    // Log to daily log
    if (!isSuppressed) {
      appendDailyLog(`[heartbeat] ${fullResponse.slice(0, 200)}`);
      console.log(`[heartbeat] Response: ${fullResponse.slice(0, 200)}`);
    } else {
      console.log("[heartbeat] OK (suppressed)");
    }

    return { skipped: false, suppressed: isSuppressed, response: fullResponse };
  } catch (err) {
    console.error("[heartbeat] Error:", err.message);
    const state = loadState();
    state.lastRun = now;
    state.lastResult = `Error: ${err.message}`;
    saveState(state);
    return { skipped: false, error: err.message };
  } finally {
    // Must clear on every exit path, or one thrown heartbeat wedges the guard
    // and the agent never runs another one for the life of the process.
    running = false;
  }
}

/**
 * Start the heartbeat timer.
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {object} [opts.channelManager] - so heartbeat tasks can message channels
 * @param {number} [opts.intervalMs=1800000] - Interval in ms (default 30 min)
 */
export function startHeartbeat({ db, settingsStore, channelManager = null, intervalMs = 30 * 60 * 1000 }) {
  _db = db;
  _settingsStore = settingsStore;
  if (channelManager) _channelManager = channelManager;

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  console.log(`[heartbeat] Started (interval: ${Math.round(intervalMs / 60000)}min)`);

  heartbeatTimer = setInterval(() => {
    runHeartbeat("scheduled").catch((err) => {
      console.error("[heartbeat] Unhandled error:", err.message);
    });
  }, intervalMs);
}

/**
 * Stop the heartbeat timer.
 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log("[heartbeat] Stopped");
  }
}

/**
 * Get heartbeat status for /heartbeat command and API.
 * @returns {object}
 */
export function getHeartbeatStatus() {
  const state = loadState();
  return {
    running: !!heartbeatTimer,
    ...state,
  };
}

/**
 * Give the heartbeat a channel manager after the fact.
 *
 * Channels start asynchronously and after the heartbeat timer, so wiring this
 * at construction time is not possible. Without it, `tarsee_send_message` from
 * a heartbeat task had no transport and failed silently.
 */
export function setHeartbeatChannelManager(channelManager) {
  _channelManager = channelManager;
}
