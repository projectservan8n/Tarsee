/**
 * Security audit utility for Tarsee.
 * Checks for common security issues and misconfigurations.
 */

import fs from "node:fs";
import { isEncryptionEnabled } from "./vault.js";
import { claudeHomes } from "./claude-transcript.js";

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

  // Check Claude auth — look for the credentials file, not an env var.
  // A single hardcoded path is unreliable here: the Dockerfile sets no USER and
  // `gosu node` does not rewrite HOME, so credentials may sit under
  // /home/node/.claude, under $HOME, or directly on the volume. Probe all of
  // them (the same candidate list the transcript resolver uses) instead of
  // guessing — otherwise an authenticated deployment reports itself logged out.
  const credHomes = process.env.CLAUDE_CODE_HOME
    ? [process.env.CLAUDE_CODE_HOME]
    : claudeHomes();
  const hasCreds = credHomes.some((h) => {
    try { return fs.existsSync(`${h}/.credentials.json`); } catch { return false; }
  });
  if (!hasCreds) {
    issues.push({ severity: "warning", message: "No Claude credentials found. Run 'claude login' in the web terminal.", fix: "Open Terminal and run: claude login" });
  }

  // Check NODE_ENV
  if (process.env.NODE_ENV !== "production") {
    issues.push({ severity: "info", message: "NODE_ENV is not 'production'. Some security features may be relaxed.", fix: "Set NODE_ENV=production" });
  }

  // All good
  if (issues.length === 0) {
    issues.push({ severity: "info", message: "All security checks passed.", fix: "" });
  }

  return {
    passed: issues.every(i => i.severity === "info"),
    issues,
    summary: {
      critical: issues.filter((i) => i.severity === "critical").length,
      warning: issues.filter((i) => i.severity === "warning").length,
      info: issues.filter((i) => i.severity === "info").length,
    },
  };
}
