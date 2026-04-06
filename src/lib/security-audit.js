/**
 * Security audit utility for Tarsee.
 * Checks for common security issues and misconfigurations.
 */

import { isEncryptionEnabled } from "./vault.js";

export function runAudit(settingsStore) {
  const issues = [];

  // Check encryption
  if (!isEncryptionEnabled()) {
    issues.push({ severity: "critical", message: "ENCRYPTION_KEY not set. Credentials stored in plaintext.", fix: "Set ENCRYPTION_KEY env var (openssl rand -hex 32)" });
  }

  // Check default/missing password
  if (!process.env.SETUP_PASSWORD) {
    issues.push({ severity: "warning", message: "No SETUP_PASSWORD set. Anyone can access the UI.", fix: "Set SETUP_PASSWORD env var" });
  }

  // Check OAuth credentials
  if (!process.env.CLAUDE_OAUTH_CREDENTIALS) {
    issues.push({ severity: "info", message: "No CLAUDE_OAUTH_CREDENTIALS env var set. Claude Code auth relies on cached credentials.", fix: "Set CLAUDE_OAUTH_CREDENTIALS for reliable auth" });
  }

  // Check channel tokens
  const channels = ["discord", "telegram", "slack"];
  for (const c of channels) {
    const config = settingsStore?.get?.(`channel.${c}`);
    if (config?.token && !config.token.startsWith("enc:")) {
      issues.push({ severity: "warning", message: `${c} token stored unencrypted.`, fix: "Set ENCRYPTION_KEY to auto-encrypt" });
    }
  }

  // Check NODE_ENV
  if (process.env.NODE_ENV !== "production") {
    issues.push({ severity: "info", message: "NODE_ENV is not 'production'. Some security features may be relaxed.", fix: "Set NODE_ENV=production" });
  }

  // Check exposed ports
  if (process.env.PORT === "80" || process.env.PORT === "443") {
    issues.push({ severity: "info", message: `Running on port ${process.env.PORT}. Ensure TLS termination is configured.`, fix: "Use a reverse proxy (nginx, Caddy) for TLS" });
  }

  return {
    passed: issues.filter((i) => i.severity === "info").length === issues.length,
    issues,
    summary: {
      critical: issues.filter((i) => i.severity === "critical").length,
      warning: issues.filter((i) => i.severity === "warning").length,
      info: issues.filter((i) => i.severity === "info").length,
    },
  };
}
