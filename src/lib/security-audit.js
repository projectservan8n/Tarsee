/**
 * Security audit utility for Tarsee.
 * Checks for common security issues and misconfigurations.
 */

import fs from "node:fs";
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

  // Check Claude auth — look for credentials file, not env var
  const homeDir = process.env.CLAUDE_CODE_HOME || "/data/tarsee/.claude-code-home";
  const credPath = `${homeDir}/.credentials.json`;
  if (!fs.existsSync(credPath)) {
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
