// --- AI Provider Definitions ---
export const AI_PROVIDERS = Object.freeze({
  "claude-code": {
    id: "claude-code",
    name: "Claude Code (Agent)",
    envKey: null,
    defaultModel: "claude-sonnet-4-6",
    baseUrl: null,
    noKeyRequired: true,
  },
});

// --- Size Limits ---
export const LIMITS = Object.freeze({
  JSON_BODY_MAX: "1mb",
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
