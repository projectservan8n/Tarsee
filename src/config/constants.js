// --- Claude Model Registry ---
// Single source of truth for every Claude model Tarsee exposes. Adding a
// new model = one entry here. The Settings dropdown, /model command,
// default fallback, and auto-routing all read from this registry — no
// more updating six files every time Anthropic ships a new version.
//
// Fields:
//   id           — canonical API model ID used in every request
//   displayName  — what shows in the Settings dropdown
//   tier         — opus | sonnet | haiku (used by /model aliases + routing)
//   context      — human-readable context window size for the UI hint
//   recommended  — exactly one entry should be true; used as the default
//                  when no DB setting or env var is configured
//   released     — YYYY-MM; used to pick "latest" when a tier has multiple
//                  models (newest wins). Alias rows omit it on purpose.
//   alias        — true for the bare tier names. Claude Code resolves these
//                  to the newest model in that tier at request time, so the
//                  default never goes stale when Anthropic ships a release.
//
// WHY ALIASES ARE FIRST: this registry previously pinned Opus 4.7 as the
// default. Opus 4.8 and Opus 5 shipped after that and the pin never moved,
// so every session silently ran two releases behind. Pointing the default at
// an alias makes that class of bug impossible — pinned rows below remain for
// anyone who needs a reproducible, frozen model.
export const CLAUDE_MODELS = Object.freeze([
  // Aliases — always the latest model in that tier. Zero maintenance; the
  // default lives here. Verified: the Claude Code CLI documents `--model` as
  // accepting "an alias for the latest model (e.g. 'fable', 'opus', or
  // 'sonnet')", and the Agent SDK forwards `model` to it verbatim.
  { id: "opus",              displayName: "Opus · latest",     tier: "opus",   context: "1M",   recommended: true,  alias: true },
  { id: "sonnet",            displayName: "Sonnet · latest",   tier: "sonnet", context: "1M",   recommended: false, alias: true },
  { id: "haiku",             displayName: "Haiku · latest",    tier: "haiku",  context: "200K", recommended: false, alias: true },
  { id: "fable",             displayName: "Fable · latest",    tier: "fable",  context: "1M",   recommended: false, alias: true },

  // Pinned versions — opt in for reproducibility. Add a row when you want a
  // NEW pin; you never need to touch these just to get the latest model.
  { id: "claude-fable-5",    displayName: "Claude Fable 5",    tier: "fable",  context: "1M",   recommended: false, released: "2026-05" },
  { id: "claude-opus-5",     displayName: "Claude Opus 5",     tier: "opus",   context: "1M",   recommended: false, released: "2026-04" },
  { id: "claude-opus-4-8",   displayName: "Claude Opus 4.8",   tier: "opus",   context: "1M",   recommended: false, released: "2026-02" },
  { id: "claude-opus-4-7",   displayName: "Claude Opus 4.7",   tier: "opus",   context: "1M",   recommended: false, released: "2026-01" },
  { id: "claude-opus-4-6",   displayName: "Claude Opus 4.6",   tier: "opus",   context: "1M",   recommended: false, released: "2025-10" },
  { id: "claude-sonnet-5",   displayName: "Claude Sonnet 5",   tier: "sonnet", context: "1M",   recommended: false, released: "2026-04" },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", tier: "sonnet", context: "1M",   recommended: false, released: "2025-10" },
  { id: "claude-haiku-4-5",  displayName: "Claude Haiku 4.5",  tier: "haiku",  context: "200K", recommended: false, released: "2025-10" },
]);

/** Flatten to id-keyed map for O(1) lookups. */
export const CLAUDE_MODELS_BY_ID = Object.freeze(
  Object.fromEntries(CLAUDE_MODELS.map((m) => [m.id, m]))
);

/** The default model when nothing else is configured. */
export function getRecommendedModel() {
  return (CLAUDE_MODELS.find((m) => m.recommended) || CLAUDE_MODELS[0]).id;
}

/**
 * Resolve a tier shorthand (opus / sonnet / haiku) or a partial match
 * to a concrete model ID. Returns the newest model in that tier so
 * "/model opus" always picks the latest Opus without code changes when
 * a new one ships.
 */
export function resolveModelAlias(alias) {
  if (!alias) return null;
  const a = String(alias).toLowerCase().trim();

  // Exact match first — if the user typed a full ID, honor it.
  if (CLAUDE_MODELS_BY_ID[a]) return a;

  // Tier shorthand → newest in that tier
  const tierMatches = CLAUDE_MODELS
    .filter((m) => m.tier === a)
    .sort((x, y) => (y.released || "").localeCompare(x.released || ""));
  if (tierMatches.length) return tierMatches[0].id;

  // Substring match (e.g. "opus-4-6" → "claude-opus-4-6")
  const sub = CLAUDE_MODELS.find((m) => m.id.includes(a));
  return sub ? sub.id : null;
}

/** All model IDs that are known, for allowlist checks. */
export function isKnownModel(id) {
  return !!CLAUDE_MODELS_BY_ID[id];
}

// --- AI Provider Definitions ---
export const AI_PROVIDERS = Object.freeze({
  "claude-code": {
    id: "claude-code",
    name: "Claude Code (Agent)",
    envKey: null,
    // Lazy getter so defaultModel always tracks the registry's recommended entry.
    get defaultModel() { return getRecommendedModel(); },
    baseUrl: null,
    noKeyRequired: true,
  },
});

// --- Size Limits ---
export const LIMITS = Object.freeze({
  JSON_BODY_MAX: "50mb",
  CMD_OUTPUT_MAX_BYTES: 512 * 1024,         // 512KB
  FILE_READ_MAX_BYTES: 2 * 1024 * 1024,     // 2MB
  UPLOAD_MAX_BYTES: 50 * 1024 * 1024,        // 50MB per file
  VOICE_SAMPLE_MAX_BYTES: 25 * 1024 * 1024,  // 25MB audio sample
  MAX_CONVERSATION_TITLE: 200,
  MAX_MESSAGE_LENGTH: 100_000,                // 100K chars
  RATE_LIMIT_AUTH_MAX: 10,                    // attempts per window
  RATE_LIMIT_AUTH_WINDOW_MS: 60_000,          // 1 minute
});

// --- WebSocket Close Codes ---
export const WS_CODES = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  AUTH_FAILED: 4001,
  RATE_LIMITED: 4029,
});
