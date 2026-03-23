/**
 * Session reset system — automatic conversation rotation.
 *
 * Modes:
 *   - "manual" (default) — only reset via /reset command
 *   - "daily" — reset at a configured hour (0-23)
 *   - "idle" — reset after N minutes of inactivity
 *
 * Config (in settings DB):
 *   - session.reset.mode: "manual" | "daily" | "idle"
 *   - session.reset.atHour: 0-23 (for daily mode)
 *   - session.reset.idleMinutes: number (for idle mode)
 */

let checkTimer = null;
let _db = null;
let _settingsStore = null;
let _convStore = null;
let lastActivityTime = Date.now();

/**
 * Track activity (called on every message).
 */
export function trackActivity() {
  lastActivityTime = Date.now();
}

/**
 * Reset sessions for all channels — creates new conversations.
 * @returns {number} Number of channels reset
 */
function resetAllChannels() {
  if (!_settingsStore || !_convStore) return 0;

  const channelSettings = _settingsStore.getByPrefix("channel_conv.");
  let count = 0;

  for (const { key, value: convId } of channelSettings) {
    const channelKey = key.replace("channel_conv.", "");
    const existingConv = _convStore.get(convId);
    if (!existingConv) continue;

    // Check if conversation has any messages (don't reset empty ones)
    const msgCount = _convStore.messageCount(convId);
    if (msgCount === 0) continue;

    // Create a new conversation for this channel
    const newConv = _convStore.create({
      title: channelKey === "web:default" ? "Web Chat" : channelKey,
    });
    _settingsStore.set(`channel_conv.${channelKey}`, newConv.id);
    count++;
  }

  if (count > 0) {
    console.log(`[session-reset] Reset ${count} channel(s)`);
  }

  return count;
}

/**
 * Check if a reset is needed based on current mode.
 */
function checkReset() {
  if (!_settingsStore) return;

  const mode = _settingsStore.get("session.reset.mode") || "manual";

  if (mode === "daily") {
    const atHour = Number(_settingsStore.get("session.reset.atHour")) || 0;
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Trigger within the first minute of the configured hour
    if (currentHour === atHour && currentMinute === 0) {
      console.log(`[session-reset] Daily reset at hour ${atHour}`);
      resetAllChannels();
    }
  } else if (mode === "idle") {
    const idleMinutes = Number(_settingsStore.get("session.reset.idleMinutes")) || 60;
    const elapsed = (Date.now() - lastActivityTime) / 60000;

    if (elapsed >= idleMinutes) {
      console.log(`[session-reset] Idle reset after ${Math.round(elapsed)} minutes`);
      resetAllChannels();
      lastActivityTime = Date.now(); // Prevent repeated resets
    }
  }
  // "manual" mode — do nothing, handled by /reset command
}

/**
 * Start the session reset checker (runs every minute).
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {import('../db/conversations.js').ConversationStore} opts.convStore
 */
export function startSessionReset({ db, settingsStore, convStore }) {
  _db = db;
  _settingsStore = settingsStore;
  _convStore = convStore;

  if (checkTimer) clearInterval(checkTimer);

  checkTimer = setInterval(checkReset, 60_000); // Check every minute
  console.log("[session-reset] Started (checking every 60s)");
}

/**
 * Stop the session reset checker.
 */
export function stopSessionReset() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
    console.log("[session-reset] Stopped");
  }
}

/**
 * Get current session reset config.
 * @returns {object}
 */
export function getSessionResetConfig() {
  if (!_settingsStore) return { mode: "manual" };

  return {
    mode: _settingsStore.get("session.reset.mode") || "manual",
    atHour: Number(_settingsStore.get("session.reset.atHour")) || 0,
    idleMinutes: Number(_settingsStore.get("session.reset.idleMinutes")) || 60,
    lastActivity: new Date(lastActivityTime).toISOString(),
  };
}
