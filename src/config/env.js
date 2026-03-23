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
for (const dir of [STATE_DIR, WORKSPACE_DIR, DATA_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort — may fail in read-only containers before volume mount
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
