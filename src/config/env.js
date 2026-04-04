import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Port ---
const PORT = Number.parseInt(process.env.PORT ?? process.env.TARSEE_PORT ?? "3000", 10);

// --- Directories ---
// Auto-detect Railway volume at /data — use it if available, else fall back to ~/.tarsee
function resolveStateDir() {
  if (process.env.TARSEE_STATE_DIR?.trim()) return process.env.TARSEE_STATE_DIR.trim();
  // Railway: check if /data exists (volume mount point)
  if (process.env.RAILWAY_PROJECT_ID) {
    try {
      // Check if /data directory exists at all (stat, not access — permissions may differ)
      const stat = fs.statSync("/data");
      if (stat.isDirectory()) {
        // Try to create our subdirectory to confirm writability
        fs.mkdirSync("/data/tarsee", { recursive: true });
        return "/data/tarsee";
      }
    } catch {
      // /data doesn't exist or isn't accessible — volume not mounted
      console.warn("[tarsee] /data not accessible — using ephemeral storage");
    }
  }
  return path.join(os.homedir(), ".tarsee");
}
const STATE_DIR = resolveStateDir();
const WORKSPACE_DIR = process.env.TARSEE_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");
const DATA_DIR = process.env.TARSEE_DATA_DIR?.trim() || path.join(STATE_DIR, "data");

// Ensure directories exist
const SKILLS_DIR = path.join(WORKSPACE_DIR, "skills");
const MEMORY_DIR = path.join(WORKSPACE_DIR, "memory");
for (const dir of [STATE_DIR, WORKSPACE_DIR, DATA_DIR, SKILLS_DIR, MEMORY_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort — may fail in read-only containers before volume mount
  }
}

// Create default workspace identity files on first boot
const DEFAULT_FILES = {
  "SOUL.md": `# Soul & Personality

You are Tarsee, a helpful AI assistant.
Be concise, direct, and helpful. Adapt your communication style to match the user.

<!-- Edit this file to change your bot's personality and behavior -->
`,
  "USER.md": `# About the User

<!-- Preferences and info about your human go here -->
<!-- This gets injected into every conversation so the bot knows you -->
`,
  "MEMORY.md": `# Long-Term Memory

<!-- Curated memories are stored here -->
<!-- Use /remember in chat or edit this file directly -->
`,
  "AGENTS.md": `# Agent Rules & Conventions

<!-- Define rules, workspace conventions, and how the agent should behave -->
<!-- This is always injected into the system prompt -->
`,
  "IDENTITY.md": `# Identity

- **Name:** Tarsee
- **Emoji:** 🐒
- **Creature:** Tarsier
- **Vibe:** Sees everything, forgets nothing

<!-- Metadata about the agent — parsed as key-value pairs -->
`,
  "TOOLS.md": `# Tools & Capabilities

<!-- Available tools, local setup notes, capabilities -->
<!-- This is injected into the system prompt so the bot knows what it can do -->
`,
  "HEARTBEAT.md": `# Heartbeat Tasks

<!-- Periodic tasks the bot checks every ~30 minutes -->
<!-- Leave empty to skip heartbeat runs (saves tokens) -->
<!-- Use HEARTBEAT_OK as response to suppress output -->
`,
  "BOOT.md": `# Boot Checklist

<!-- Runs once on every server restart -->
<!-- Leave empty to skip boot runs -->
`,
};

for (const [filename, defaultContent] of Object.entries(DEFAULT_FILES)) {
  const filePath = path.join(WORKSPACE_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, defaultContent, { encoding: "utf8", mode: 0o600 });
      console.log(`[config] Created default ${filename}`);
    }
  } catch {
    // best-effort
  }
}

// Log volume mount status (Railway uses /data)
const isVolumeMounted = STATE_DIR.startsWith("/data");

if (process.env.RAILWAY_PROJECT_ID) {
  if (isVolumeMounted) {
    console.log("[config] Railway volume mounted at /data — data will persist across deploys");
  } else {
    console.warn("[config] WARNING: Railway volume NOT mounted! Data will be LOST on redeploy.");
    console.warn("[config] Go to Railway dashboard → your service → Settings → Add Volume → mount path: /data");
  }
}

// --- Auth ---
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim() || null;

// --- API Token ---
// Stable token for REST/WS API authentication. Persisted to disk if not in env.
function resolveApiToken() {
  const envTok = process.env.TARSEE_API_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "api.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // no existing token
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn("[config] Could not persist API token:", err.message);
  }
  return generated;
}

const API_TOKEN = resolveApiToken();

// --- Encryption key for SQLite secrets ---
// If not set, secrets are stored in plaintext (acceptable for dev, not for prod)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY?.trim() || null;

// --- Database path ---
const DB_PATH = path.join(DATA_DIR, "tarsee.db");

// --- Claude Code CLI Configuration ---
const CLAUDE_CLI_MODE = process.env.CLAUDE_CLI_MODE?.trim() || "sdk"; // "sdk" or "direct-api"
const CLAUDE_WORKSPACE_DIR = process.env.CLAUDE_WORKSPACE_DIR?.trim() || WORKSPACE_DIR;
const CLAUDE_DEFAULT_MODEL = process.env.CLAUDE_DEFAULT_MODEL?.trim() || "claude-sonnet-4-6";
const CLAUDE_SESSION_DIR = process.env.CLAUDE_SESSION_DIR?.trim() || path.join(DATA_DIR, ".claude-code", "sessions");

// Ensure Claude session directory exists
try {
  fs.mkdirSync(CLAUDE_SESSION_DIR, { recursive: true, mode: 0o700 });
} catch {
  // best-effort
}

// --- Frozen config export ---
const config = Object.freeze({
  PORT,
  STATE_DIR,
  WORKSPACE_DIR,
  DATA_DIR,
  DB_PATH,
  SETUP_PASSWORD,
  API_TOKEN,
  ENCRYPTION_KEY,
  NODE_ENV: process.env.NODE_ENV || "development",
  IS_RAILWAY: !!process.env.RAILWAY_PROJECT_ID,

  // Claude Code CLI
  CLAUDE_CLI_MODE,
  CLAUDE_WORKSPACE_DIR,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_SESSION_DIR,
});

export default config;
