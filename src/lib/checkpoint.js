/**
 * Checkpoint — explicit session handoff across container wipes.
 *
 * Complements the automatic boot-context.js:
 *   boot-context  = lightweight, automatic, last 3 conversations * 300 chars
 *   checkpoint    = detailed, user-initiated via /checkpoint before a known
 *                   restart or redeploy
 *
 * Flow:
 *   1. User runs /checkpoint during an active session.
 *   2. Claude writes a detailed handoff to workspace/CHECKPOINT.md
 *      (using its existing tarsee_write_file / Write tool).
 *   3. User restarts Tarsee (Railway redeploy wipes container).
 *   4. On the next session's first message, buildSystemPrompt injects
 *      CHECKPOINT.md content as "Handoff from previous instance" and
 *      this module ARCHIVES the file to memory/checkpoints/<ts>.md so
 *      the same checkpoint isn't re-played forever.
 *
 * The archive ensures exactly-once delivery — Claude sees the handoff
 * on the very first message after restart, then the file moves out of
 * the active path and into timestamped memory.
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";

const CHECKPOINT_PATH = path.join(config.WORKSPACE_DIR, "CHECKPOINT.md");
const ARCHIVE_DIR = path.join(config.WORKSPACE_DIR, "memory", "checkpoints");

/**
 * Returns true if a live checkpoint is waiting to be consumed.
 */
export function hasCheckpoint() {
  try { return fs.existsSync(CHECKPOINT_PATH); } catch { return false; }
}

/**
 * Read the checkpoint body without consuming it. Used for /checkpoint
 * status checks where the user wants to preview without clearing.
 */
export function peekCheckpoint() {
  try {
    if (!fs.existsSync(CHECKPOINT_PATH)) return null;
    return fs.readFileSync(CHECKPOINT_PATH, "utf8");
  } catch { return null; }
}

/**
 * Read the checkpoint and move it to memory/checkpoints/<timestamp>.md
 * atomically. Returns the body on success, null if no checkpoint exists.
 *
 * Called by buildSystemPrompt on the first message of a new session so
 * the handoff is surfaced exactly once.
 */
export function readAndArchiveCheckpoint() {
  try {
    if (!fs.existsSync(CHECKPOINT_PATH)) return null;

    const body = fs.readFileSync(CHECKPOINT_PATH, "utf8");

    try {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archivePath = path.join(ARCHIVE_DIR, `${stamp}.md`);
      // rename is atomic on the same filesystem — covers the common case
      fs.renameSync(CHECKPOINT_PATH, archivePath);
      console.log(`[checkpoint] consumed and archived → ${archivePath}`);
    } catch (err) {
      // Fallback: delete the source so we don't re-inject on every new
      // session. Lose the archive but keep exactly-once semantics.
      console.warn("[checkpoint] archive move failed, deleting:", err.message);
      try { fs.unlinkSync(CHECKPOINT_PATH); } catch { /* swallow */ }
    }

    return body;
  } catch (err) {
    console.warn("[checkpoint] read error:", err.message);
    return null;
  }
}

/**
 * List the N most recent archived checkpoints — useful for audit / UI.
 */
export function listRecentCheckpoints(limit = 10) {
  try {
    if (!fs.existsSync(ARCHIVE_DIR)) return [];
    const entries = fs.readdirSync(ARCHIVE_DIR)
      .filter((n) => n.endsWith(".md"))
      .map((name) => {
        const full = path.join(ARCHIVE_DIR, name);
        const stat = fs.statSync(full);
        return { name, path: full, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    return entries;
  } catch { return []; }
}

/**
 * Where the user (and Claude) should write checkpoint content to.
 * Exported so /checkpoint's playbook text can reference a stable path.
 */
export const CHECKPOINT_FILE_PATH = CHECKPOINT_PATH;
