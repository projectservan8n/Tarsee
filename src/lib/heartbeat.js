import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { getHeartbeatContext, appendDailyLog } from "./workspace-files.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { chatStream } from "../ai/router.js";

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
    let fullResponse = "";
    const toolCtx = { db: _db, settingsStore: _settingsStore, conversationId: null };
    const stream = chatStream({
      provider: activeProvider.provider,
      model: activeProvider.model,
      messages,
      systemPrompt,
      toolCtx,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        fullResponse += event.content;
      } else if (event.type === "done") {
        break;
      }
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
  }
}

/**
 * Start the heartbeat timer.
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {number} [opts.intervalMs=1800000] - Interval in ms (default 30 min)
 */
export function startHeartbeat({ db, settingsStore, intervalMs = 30 * 60 * 1000 }) {
  _db = db;
  _settingsStore = settingsStore;

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
