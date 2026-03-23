import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Port ---
const PORT = Number.parseInt(process.env.PORT ?? process.env.OPUSCLAW_PORT ?? "3000", 10);

// --- Directories ---
const STATE_DIR = process.env.OPUSCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".opusclaw");
const WORKSPACE_DIR = process.env.OPUSCLAW_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");
const DATA_DIR = process.env.OPUSCLAW_DATA_DIR?.trim() || path.join(STATE_DIR, "data");

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

You are OpusClaw, a helpful AI assistant.
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

- **Name:** OpusClaw
- **Emoji:** 🦞
- **Creature:** Lobster
- **Vibe:** Helpful and sharp

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
const isVolumeMounted = (() => {
  try {
    // Check if /data exists and is writable (Railway volume mount point)
    if (STATE_DIR.startsWith("/data")) {
      fs.accessSync("/data", fs.constants.W_OK);
      return true;
    }
    return false;
  } catch {
    return false;
  }
})();

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
  const envTok = process.env.OPUSCLAW_API_TOKEN?.trim();
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
const DB_PATH = path.join(DATA_DIR, "opusclaw.db");

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
});

export default config;
