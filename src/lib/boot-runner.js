import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import config from "../config/env.js";
import { getBootContext, hasBootstrapFile, appendDailyLog } from "./workspace-files.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { runBackgroundTurn, resolveBackgroundModel } from "./background-turn.js";
import { BACKGROUND_DEFAULTS } from "../config/constants.js";

/**
 * Marker recording which build last ran the boot checklist.
 *
 * BOOT.md used to run a full model turn on EVERY process start with no
 * dedupe. That is once per deploy if all goes well — but a container that
 * crash-loops restarts every few seconds, and each restart paid for another
 * turn. An unattended crash loop overnight could burn a subscription with
 * nobody watching. Keyed by commit SHA plus a hash of the file, so a real
 * deploy or an edit to BOOT.md runs it again and a bare restart does not.
 */
const BOOT_MARKER = path.join(config.STATE_DIR, ".boot-checklist-ran");

function bootFingerprint(content) {
  const build = process.env.TARSEE_COMMIT_SHA || "dev";
  return `${build}:${crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

function alreadyRanThisBuild(fingerprint) {
  try {
    return fs.readFileSync(BOOT_MARKER, "utf8").trim() === fingerprint;
  } catch {
    return false;
  }
}

function recordRun(fingerprint) {
  try {
    fs.mkdirSync(path.dirname(BOOT_MARKER), { recursive: true });
    fs.writeFileSync(BOOT_MARKER, fingerprint, "utf8");
  } catch (err) {
    // Not fatal, but say so: without the marker every restart pays again.
    console.warn("[boot] could not write boot marker:", err.message);
  }
}

/**
 * Boot runner — executes BOOT.md as a one-shot AI task on every server restart.
 * Skips if BOOT.md is empty or no AI provider is configured.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {object} [opts.channelManager] - lets BOOT.md tasks message channels
 * @returns {Promise<{skipped: boolean, response?: string, error?: string}>}
 */
export async function runBootChecklist({ db, settingsStore, channelManager = null }) {
  const bootContent = getBootContext();

  if (!bootContent) {
    console.log("[boot] BOOT.md is empty, skipping boot checklist");
    return { skipped: true, reason: "BOOT.md is empty" };
  }

  const activeProvider = settingsStore.getActiveProvider();
  if (!activeProvider?.ready || !activeProvider?.provider) {
    console.log("[boot] No AI provider configured, skipping boot checklist");
    return { skipped: true, reason: "No AI provider configured" };
  }

  // Once per build, not once per process start. See BOOT_MARKER above.
  const fingerprint = bootFingerprint(bootContent);
  if (alreadyRanThisBuild(fingerprint)) {
    console.log("[boot] checklist already ran for this build — skipping (restart, not a deploy)");
    return { skipped: true, reason: "Already ran for this build" };
  }
  recordRun(fingerprint);

  console.log("[boot] Running boot checklist...");

  const systemPrompt = buildSystemPrompt({
    settingsStore,
    db,
    conversationId: null,
    messageCount: 0,
    conversationPrompt: null,
    channelHint: "This is a server boot checklist. The server just restarted. Execute the tasks in BOOT.md and report results.",
  });

  const now = new Date().toISOString();
  const messages = [
    {
      role: "user",
      content: `[Server Boot — ${now}]\n\n${bootContent}`,
    },
  ];

  const toolCtx = { db, settingsStore, conversationId: null, channelManager };
  const { text: fullResponse, error } = await runBackgroundTurn({
    label: "boot",
    // Cheap by default; `boot.model` raises it for a checklist that needs it.
    model: resolveBackgroundModel(settingsStore.get("boot.model")),
    messages,
    systemPrompt,
    toolCtx,
    timeoutMs: BACKGROUND_DEFAULTS.BOOT_TIMEOUT_MS,
  });

  if (error) {
    console.error("[boot] checklist failed:", error);
    return { skipped: false, error };
  }

  appendDailyLog(`[boot] ${fullResponse.slice(0, 200)}`);
  return { skipped: false, response: fullResponse };
}

/**
 * Check if this is a first-run scenario (BOOTSTRAP.md exists).
 * Used by the frontend to decide whether to run bootstrap interview.
 */
export function isFirstRun() {
  return hasBootstrapFile();
}
