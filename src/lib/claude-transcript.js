/**
 * Claude Code transcript (.jsonl) locator + size helpers.
 *
 * Claude Code persists each session's full transcript to
 *   $HOME/.claude/projects/<slugified-cwd>/<session-id>.jsonl
 * and re-reads it on every `resume`. That file — not our own `messages`
 * table — is what actually refills the model's context window each turn,
 * so it is the real driver of context bloat and bloat-induced hangs.
 *
 * On Railway, entrypoint.sh symlinks /home/node/.claude to the persistent
 * volume (/data/tarsee/.claude-code-home), so os.homedir() resolves through
 * the symlink correctly and no Railway-specific path is needed here.
 *
 * The slug replaces path separators, whitespace and dots with "-"
 * (verified against real ~/.claude/projects entries). Because that rule has
 * changed across Claude Code versions, we fall back to scanning the projects
 * directory for the session file rather than trusting the slug blindly.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import config from "../config/env.js";

/** Bytes-per-MB, so the intent is obvious at the call sites. */
const MB = 1048576;

/**
 * Default cap before a session is considered too bloated to resume.
 *
 * The Mac build uses 3 MB, but its default model has a 200k window. This
 * build's default (the `opus` alias) has a 1M window, so 3 MB would abandon
 * sessions that are still perfectly healthy. 8 MB is the equivalent headroom.
 */
export const SESSION_JSONL_MAX_MB =
  Number(process.env.TARSEE_SESSION_JSONL_MAX_MB) || 8;

/**
 * Candidate roots for Claude Code's per-project transcript store, most
 * specific first.
 *
 * Why a LIST and not one path: inside this container HOME is not what you
 * would expect. The Dockerfile declares no USER, so the ENTRYPOINT runs as
 * root with HOME=/root, and `gosu node` drops the uid WITHOUT rewriting HOME.
 * Meanwhile entrypoint.sh symlinks /home/node/.claude to the persistent volume
 * at /data/tarsee/.claude-code-home. So os.homedir()/$HOME can point at /root
 * while the real transcripts live under /home/node — or directly on the volume.
 * Rather than bet on one of those, probe all of them.
 */
export function projectsRoots() {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR,
    process.env.HOME && path.join(process.env.HOME, ".claude"),
    "/home/node/.claude",
    (() => { try { return path.join(os.homedir(), ".claude"); } catch { return null; } })(),
    process.env.TARSEE_STATE_DIR && path.join(process.env.TARSEE_STATE_DIR, ".claude-code-home"),
  ].filter(Boolean);

  const seen = new Set();
  const roots = [];
  for (const c of candidates) {
    const root = path.join(c, "projects");
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

/**
 * Candidate Claude home directories (the `.claude` dirs themselves, not their
 * `projects/` subdir). Same reasoning as projectsRoots(): HOME is unreliable in
 * this container, so probe rather than assume.
 */
export function claudeHomes() {
  return projectsRoots().map((r) => path.dirname(r));
}

/** First candidate root that actually exists on disk (or the first candidate). */
export function projectsRoot() {
  const roots = projectsRoots();
  return roots.find((r) => { try { return fs.existsSync(r); } catch { return false; } }) || roots[0];
}

/** Slugify a working directory the way Claude Code names its project dirs. */
export function slugifyCwd(dir) {
  return String(dir).replace(/[\s/.]+/g, "-");
}

/**
 * Absolute path to a session's transcript, or null if it cannot be found.
 * Tries the slug first, then falls back to scanning every project dir —
 * the scan keeps this working if Claude Code changes its slug rule.
 */
export function transcriptPath(sessionId) {
  if (!sessionId) return null;
  const file = `${sessionId}.jsonl`;
  const slug = slugifyCwd(config.CLAUDE_WORKSPACE_DIR || process.cwd());

  for (const root of projectsRoots()) {
    // Fast path: the slug we expect.
    const direct = path.join(root, slug, file);
    try { if (fs.existsSync(direct)) return direct; } catch { /* unreadable root */ }

    // Fallback: scan the project dirs. Keeps working if Claude Code changes
    // its slug rule, which it has done before.
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name, file);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* root does not exist yet */ }
  }
  return null;
}

/** Transcript size in MB (1 decimal), or null when there is no transcript. */
export function transcriptSizeMB(sessionId) {
  const p = transcriptPath(sessionId);
  if (!p) return null;
  try {
    return +(fs.statSync(p).size / MB).toFixed(1);
  } catch {
    return null;
  }
}

/**
 * True when a session's transcript has grown past the cap and should be
 * abandoned rather than resumed. Returns false when there is no transcript
 * (nothing to reset) so a brand-new session is never flagged.
 */
export function isTranscriptOverCap(sessionId, capMB = SESSION_JSONL_MAX_MB) {
  const mb = transcriptSizeMB(sessionId);
  return mb != null && mb > capMB;
}
