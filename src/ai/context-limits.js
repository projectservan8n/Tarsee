/**
 * context-limits.js: how big the agent's Claude Code context may get before
 * the CLI summarizes it (auto-compact).
 *
 * Every model call re-reads the whole context from cache, and cache reads count
 * toward the Claude subscription's usage limit. On a long agentic job measured
 * on TarseeMacOS (824 calls), a 300k window compacted at about 268k and the
 * context averaged 174k a call. At 180k the CLI compacts at about 148k: the
 * average falls to about 117k, the extra compactions add back about 11k a call,
 * so cache reads drop by roughly a quarter. Recent turns stay verbatim through
 * a compaction, so the session carries on.
 *
 * TARSEE_COMPACT_WINDOW overrides it: a token count ("250000" or "150k"), or
 * "off" for the CLI's own choice (the model's full window). The CLI accepts
 * 100k to 1M, and never more than the model's own window.
 */
export const DEFAULT_COMPACT_WINDOW = 180_000;
export const MIN_COMPACT_WINDOW = 100_000;
export const MAX_COMPACT_WINDOW = 1_000_000;

/** The env each Claude Code process gets for its auto-compact window ({} for the CLI's default). */
export function compactWindowEnv(raw = process.env.TARSEE_COMPACT_WINDOW) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "off") return {};
  let n = Number(v.replace(/k$/, "")) * (v.endsWith("k") ? 1000 : 1);
  if (!v || !Number.isFinite(n) || n <= 0) n = DEFAULT_COMPACT_WINDOW;
  n = Math.round(Math.min(MAX_COMPACT_WINDOW, Math.max(MIN_COMPACT_WINDOW, n)));
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(n) };
}

/**
 * Most characters of a Bash command's output the agent's context keeps
 * (BASH_MAX_OUTPUT_LENGTH, which the CLI reads): past it the CLI saves the
 * whole output to a file and the agent gets a short preview plus the path.
 * The CLI's own default is 30000. Every output stays in the context, re-read on
 * each later call until a compaction; on that same measured job, 23 outputs
 * over 8000 characters added about 88KB. TARSEE_BASH_OUTPUT_MAX_CHARS
 * overrides it; a BASH_MAX_OUTPUT_LENGTH already set is kept when it is unset.
 */
export const DEFAULT_BASH_OUTPUT_MAX_CHARS = 8000;

export function bashOutputEnv(env = process.env) {
  const own = Number(env.TARSEE_BASH_OUTPUT_MAX_CHARS);
  if (Number.isFinite(own) && own > 0) return { BASH_MAX_OUTPUT_LENGTH: String(Math.round(own)) };
  if (env.BASH_MAX_OUTPUT_LENGTH) return {};
  return { BASH_MAX_OUTPUT_LENGTH: String(DEFAULT_BASH_OUTPUT_MAX_CHARS) };
}

/** What every Claude Code process the provider starts gets on top of the server's own environment. */
export function costSaverEnv(env = process.env) {
  return { ...compactWindowEnv(env.TARSEE_COMPACT_WINDOW), ...bashOutputEnv(env) };
}
