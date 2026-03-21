// --- AI Provider Definitions ---
export const AI_PROVIDERS = Object.freeze({
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6-20250514",
    baseUrl: "https://api.anthropic.com",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    baseUrl: "https://api.openai.com",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4-5",
    baseUrl: "https://openrouter.ai/api",
  },
  custom: {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    envKey: "CUSTOM_API_KEY",
    defaultModel: "",
    baseUrl: "",
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
