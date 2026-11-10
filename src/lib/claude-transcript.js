/**
 * Claude Code transcript (.jsonl) locator + size helpers.
 *
 * Claude Code persists each session's full transcript to
 *   <claude home>/projects/<slugified-cwd>/<session-id>.jsonl
 * and re-reads it on every `resume`. That file — not our own `messages`
 * table — is what actually refills the model's context window each turn,
 * so it is the real driver of context bloat and bloat-induced hangs.
 *
 * Which claude home. Every provider that runs on Claude Code has its own
 * (design 4.5 R1, ai/engine-env.js homeFor):
 *   the Claude plan                     ~/.claude (on Railway entrypoint.sh
 *                                       symlinks /home/node/.claude to the
 *                                       volume, /data/tarsee/.claude-code-home)
 *   anthropic, deepseek, openrouter     <state dir>/.claude-home-<id>
 * Those homes are named here explicitly. CLAUDE_CONFIG_DIR is not read: every
 * turn strips it from the engine's environment (AUTH_ENV_RE), so the plan's
 * sessions never land there, and a key home is set per turn, never globally.
 *
 * A stored session handle ("deepseek/cc/deepseek:<id>", ai/session-handle.js)
 * names its provider, so its transcript is looked up in that provider's home
 * only; a bare id is the plan's, or any home's when no provider is known.
 * Codex sessions have no Claude transcript.
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
import { CLAUDE_CODE, homeFor } from "../ai/engine-env.js";
import { PROVIDER_IDS, PROVIDERS, normalizeProviderId } from "../ai/provider-registry.js";
import { parse as parseHandle } from "../ai/session-handle.js";

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

/** The providers with a Claude Code home of their own: every one that runs on Claude Code except the plan. */
const KEY_HOME_PROVIDERS = PROVIDER_IDS.filter((id) => id !== "claude" && PROVIDERS[id].engines.includes(CLAUDE_CODE));

/**
 * Every Claude Code home, each with the provider whose sessions it holds, the
 * plan's first: [{ provider, home }].
 *
 * The plan has a LIST of candidates, not one path: inside this container HOME
 * is not what you would expect. The Dockerfile declares no USER, so the
 * ENTRYPOINT runs as root with HOME=/root, and `gosu node` drops the uid
 * WITHOUT rewriting HOME. Meanwhile entrypoint.sh symlinks /home/node/.claude
 * to the persistent volume at /data/tarsee/.claude-code-home. So
 * os.homedir()/$HOME can point at /root while the real transcripts live under
 * /home/node — or directly on the volume. Rather than bet on one of those,
 * probe all of them. The key homes are where engine-env.js puts them, under
 * the state folder.
 *
 * opts: stateDir (default config.STATE_DIR), homeDir (default os.homedir()),
 * env (default process.env: HOME and TARSEE_STATE_DIR).
 */
export function providerHomes({ stateDir = config.STATE_DIR, homeDir = null, env = process.env } = {}) {
  const home = homeDir || (() => { try { return os.homedir(); } catch { return null; } })();
  const plan = [
    env?.HOME && path.join(env.HOME, ".claude"),
    "/home/node/.claude",
    home && path.join(home, ".claude"),
    env?.TARSEE_STATE_DIR && path.join(env.TARSEE_STATE_DIR, ".claude-code-home"),
    stateDir && path.join(stateDir, ".claude-code-home"),
  ].filter(Boolean).map((h) => ({ provider: "claude", home: h }));
  const keys = stateDir ? KEY_HOME_PROVIDERS.map((id) => ({ provider: id, home: homeFor(id, CLAUDE_CODE, { stateDir }) })) : [];
  const seen = new Set();
  return [...plan, ...keys].filter((h) => {
    const k = path.resolve(h.home);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every home's transcript store: [{ provider, root }] where root is <home>/projects. */
export function projectsRootsByProvider(opts = {}) {
  return providerHomes(opts).map((h) => ({ provider: h.provider, root: path.join(h.home, "projects") }));
}

/**
 * The Claude plan's transcript roots (<home>/projects), most specific first.
 * The key providers' homes are in projectsRootsByProvider().
 */
export function projectsRoots(opts = {}) {
  return projectsRootsByProvider(opts).filter((r) => r.provider === "claude").map((r) => r.root);
}

/**
 * The Claude plan's candidate home directories (the `.claude` dirs themselves,
 * not their `projects/` subdir): where its sign-in and model catalog live.
 * Never a key provider's home.
 */
export function claudeHomes(opts = {}) {
  return projectsRoots(opts).map((r) => path.dirname(r));
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
 * Where to look for a session: { rawId, roots } from a stored handle or a raw
 * id. A tagged handle names its provider (a Codex one has no transcript: no
 * roots); a bare id with opts.provider is that provider's; a bare id without
 * one is looked for in every home, the plan's first.
 */
function placeSession(sessionId, opts = {}) {
  const parsed = parseHandle(String(sessionId ?? ""));
  // (A raw id is a file name here: nothing with a path separator in it.)
  if (!parsed || /[\\/]/.test(parsed.rawId)) return { rawId: null, roots: [] };
  if (parsed.tagged && parsed.engine !== CLAUDE_CODE) return { rawId: parsed.rawId, roots: [] };
  const provider = normalizeProviderId(parsed.tagged ? parsed.provider : opts.provider);
  const all = projectsRootsByProvider(opts);
  const roots = provider ? all.filter((r) => r.provider === provider) : all;
  return { rawId: parsed.rawId, roots: roots.map((r) => r.root) };
}

/**
 * Absolute path to a session's transcript, or null if it cannot be found.
 * sessionId: a stored handle or a raw id (see placeSession). opts: provider
 * (for a raw id), stateDir, homeDir, env (providerHomes).
 * Tries the slug first, then falls back to scanning every project dir —
 * the scan keeps this working if Claude Code changes its slug rule.
 */
export function transcriptPath(sessionId, opts = {}) {
  if (!sessionId) return null;
  const { rawId, roots } = placeSession(sessionId, opts);
  if (!rawId) return null;
  const file = `${rawId}.jsonl`;
  const slug = slugifyCwd(config.CLAUDE_WORKSPACE_DIR || process.cwd());

  for (const root of roots) {
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

/** Transcript size in MB (1 decimal), or null when there is no transcript. opts: as transcriptPath's. */
export function transcriptSizeMB(sessionId, opts = {}) {
  const p = transcriptPath(sessionId, opts);
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
export function isTranscriptOverCap(sessionId, capMB = SESSION_JSONL_MAX_MB, opts = {}) {
  const mb = transcriptSizeMB(sessionId, opts);
  return mb != null && mb > capMB;
}
