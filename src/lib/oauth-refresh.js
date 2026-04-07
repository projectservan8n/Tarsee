/**
 * Claude OAuth Token Auto-Refresh
 *
 * Refreshes the Claude subscription OAuth token before it expires.
 * Uses the refreshToken to get a new accessToken from Anthropic's OAuth endpoint.
 * Writes refreshed credentials back to disk so the Agent SDK picks them up.
 */

import fs from "node:fs";
import path from "node:path";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_BUFFER_MS = 60 * 60 * 1000;  // Refresh 1 hour before expiry (aggressive — prevents Mac from refreshing first)
const CHECK_INTERVAL_MS = 5 * 60 * 1000;  // Check every 5 minutes
const DEFAULT_EXPIRES_IN = 28800;          // 8 hours default if not in response

let refreshTimer = null;

/**
 * Get the credentials file path.
 */
function getCredentialsPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "/home/node", ".claude");
  return path.join(configDir, ".credentials.json");
}

/**
 * Read current credentials from disk.
 */
function readCredentials() {
  try {
    const raw = fs.readFileSync(getCredentialsPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write credentials to ALL locations the CLI might read from.
 */
function writeCredentials(creds) {
  const credJson = JSON.stringify(creds);

  // Primary: CLAUDE_CONFIG_DIR
  const credPath = getCredentialsPath();
  try {
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, credJson, { mode: 0o600 });
  } catch (err) {
    console.error("[oauth] Failed to write to", credPath, err.message);
  }

  // Fallback: ~/.claude
  const homeCredPath = path.join(process.env.HOME || "/home/node", ".claude", ".credentials.json");
  if (credPath !== homeCredPath) {
    try {
      fs.mkdirSync(path.dirname(homeCredPath), { recursive: true });
      fs.writeFileSync(homeCredPath, credJson, { mode: 0o600 });
    } catch { /* best effort */ }
  }

  // Update env vars in-memory
  process.env.CLAUDE_OAUTH_CREDENTIALS = credJson;

  // Set CLAUDE_CODE_OAUTH_TOKEN so the Agent SDK reads it from env
  // instead of the credentials file (avoids conflict with Mac's VS Code)
  const parsed = JSON.parse(credJson);
  if (parsed.claudeAiOauth?.accessToken) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = parsed.claudeAiOauth.accessToken;
  }
}

/**
 * Refresh the OAuth access token using the refresh token.
 */
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error(`No access_token in refresh response: ${JSON.stringify(data)}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || DEFAULT_EXPIRES_IN,
  };
}

/**
 * Check if token needs refresh and do it.
 */
async function checkAndRefresh() {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth) {
    return;
  }

  const oauth = creds.claudeAiOauth;
  const now = Date.now();
  const expiresAt = oauth.expiresAt || 0;

  // Always set CLAUDE_CODE_OAUTH_TOKEN from current access token
  if (oauth.accessToken) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = oauth.accessToken;
  }

  // Check if token is expired or expiring soon
  if (now < expiresAt - REFRESH_BUFFER_MS) {
    const minsLeft = Math.round((expiresAt - now) / 60000);
    console.log(`[oauth] Token valid for ${minsLeft} more minutes`);
    return;
  }

  if (!oauth.refreshToken) {
    console.error("[oauth] Token expired and no refresh token available");
    return;
  }

  console.log("[oauth] Token expired or expiring soon, refreshing...");

  try {
    const result = await refreshAccessToken(oauth.refreshToken);

    // Update credentials with new tokens
    creds.claudeAiOauth.accessToken = result.accessToken;
    creds.claudeAiOauth.refreshToken = result.refreshToken;
    creds.claudeAiOauth.expiresAt = now + (result.expiresIn * 1000);

    writeCredentials(creds);
    console.log(`[oauth] Token refreshed! New expiry: ${new Date(creds.claudeAiOauth.expiresAt).toISOString()}`);
  } catch (err) {
    console.error("[oauth] Token refresh failed:", err.message);
    // If refresh token is invalid, log instructions
    if (err.message.includes("invalid_grant") || err.message.includes("not found")) {
      console.error("[oauth] Refresh token is invalid. Update CLAUDE_OAUTH_CREDENTIALS env var with fresh credentials from: security find-generic-password -s 'Claude Code-credentials' -w");
    }
  }
}

/**
 * Start the auto-refresh loop.
 */
export function startOAuthRefresh() {
  // Initial check
  checkAndRefresh().catch((err) => {
    console.error("[oauth] Initial refresh check failed:", err.message);
  });

  // Periodic check
  refreshTimer = setInterval(() => {
    checkAndRefresh().catch((err) => {
      console.error("[oauth] Refresh check failed:", err.message);
    });
  }, CHECK_INTERVAL_MS);
  refreshTimer.unref();

  console.log("[oauth] Auto-refresh started (checking every 5 minutes)");
}

/**
 * Stop the auto-refresh loop.
 */
export function stopOAuthRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
