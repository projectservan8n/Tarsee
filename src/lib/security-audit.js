/**
 * Security audit utility for Tarsee.
 * Checks for common security issues and misconfigurations.
 *
 * For the AI providers (design 4.15) it checks:
 *  - the default AI's credential is there (a key, the Claude sign-in, the ChatGPT sign-in, Local AI's address)
 *  - the ChatGPT sign-in file (auth.json) and the credential homes are readable by their owner only
 *  - the key homes hold no sign-in and no /login key, so neither can reach another provider's host
 *  - no .env in a Codex home (Codex loads it into its own environment)
 *  - saved keys aren't encrypted with a key that lives only in a file on the same volume
 *
 * Synchronous (the admin route answers with its result as it is); it never makes a network call and never shows a
 * key. deps (all optional) let tests point it at a scratch state folder: env, stateDir, platform, stat, exists,
 * readFile, claudeHomes, codexHome, isShipped.
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { isEncryptionEnabled } from "./vault.js";
import { homeIsolationRefusal } from "../ai/engine-env.js";
import { activeTarget, credentialPresence, codexHomeFor, savedKeyProviders } from "../ai/provider-status.js";

/** The key homes that must hold only their provider's key (design 4.5 R1). */
const KEY_HOMES = [".claude-home-anthropic", ".claude-home-deepseek", ".claude-home-openrouter", ".codex-home-keys"];

/** Where entrypoint.sh keeps the encryption key it generates when ENCRYPTION_KEY isn't set. */
const VOLUME_KEY_FILE = "/data/tarsee/.encryption-key";

/**
 * True when ENCRYPTION_KEY is the one entrypoint.sh generated and keeps in a file on the volume: then a copy of the
 * volume alone opens every saved key.
 */
export function encryptionKeyOnVolume({ stateDir = config.STATE_DIR, env = process.env, readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const key = String(env?.ENCRYPTION_KEY ?? "").trim();
  if (!key) return false;
  for (const file of [...new Set([path.join(stateDir, ".encryption-key"), VOLUME_KEY_FILE])]) {
    let onDisk;
    try { onDisk = String(readFile(file)).trim(); } catch { continue; }
    if (onDisk && onDisk === key) return true;
  }
  return false;
}

export function runAudit(settingsStore, deps = {}) {
  const {
    env = process.env,
    stateDir = config.STATE_DIR,
    platform = process.platform,
    exists = fs.existsSync,
    stat = (p) => fs.statSync(p),
    readFile = (p) => fs.readFileSync(p, "utf8"),
  } = deps;
  const issues = [];

  // Check encryption
  if (!isEncryptionEnabled()) {
    issues.push({ id: "encryption", severity: "critical", message: "ENCRYPTION_KEY not set. Credentials stored in plaintext.", fix: "Set ENCRYPTION_KEY env var (openssl rand -hex 32)" });
  }

  // Check default/missing password
  if (!env.SETUP_PASSWORD) {
    issues.push({ id: "setup-password", severity: "warning", message: "No SETUP_PASSWORD set. Anyone can access the UI.", fix: "Set SETUP_PASSWORD env var" });
  }

  // The default AI's credential. For the Claude plan that is the credentials file `claude auth login` leaves (probed in
  // every place it may be: HOME is unreliable in this container) or CLAUDE_CODE_OAUTH_TOKEN; for a key provider its
  // key; for the ChatGPT plan Codex's auth.json; for Local AI its address and model.
  try {
    const active = activeTarget(settingsStore, { env, isShipped: deps.isShipped });
    const cred = credentialPresence(active.provider, {
      store: settingsStore, env, stateDir, exists, claudeHomes: deps.claudeHomes, codexHome: deps.codexHome,
    });
    if (!cred.ready) {
      issues.push({ id: "ai-credential", severity: "warning", message: `Your default AI (${active.label}) isn't connected: ${cred.detail}`, fix: cred.fix || "Open Settings > AI." });
    }
  } catch (err) {
    issues.push({ id: "ai-credential", severity: "warning", message: `Tarsee couldn't check the default AI's credential: ${err.message}`, fix: "Open Settings > AI." });
  }

  // The credential homes and the ChatGPT sign-in file: owner-only. File modes mean nothing on Windows.
  if (platform !== "win32") {
    const codexHome = deps.codexHome || codexHomeFor(stateDir);
    const authFile = path.join(codexHome, "auth.json");
    if (exists(authFile)) {
      try {
        if ((stat(authFile).mode & 0o077) !== 0) {
          issues.push({ id: "codex-auth-mode", severity: "warning", message: `${authFile} (the ChatGPT sign-in) can be read by other users on this server.`, fix: `chmod 600 ${authFile}` });
        }
      } catch { /* gone between the two calls */ }
    }
    for (const dir of [codexHome, ...KEY_HOMES.map((h) => path.join(stateDir, h))]) {
      if (!exists(dir)) continue;
      try {
        if ((stat(dir).mode & 0o077) !== 0) {
          issues.push({ id: "credential-home-mode", severity: "warning", message: `${dir} (an AI's credential folder) can be read by other users on this server.`, fix: `chmod 700 ${dir}` });
        }
      } catch { /* gone between the two calls */ }
    }
  }

  // The key homes hold only their provider's key: a sign-in file or a /login key there could reach another host.
  for (const home of KEY_HOMES.map((h) => path.join(stateDir, h))) {
    const refusal = homeIsolationRefusal(home, { exists, readFile });
    if (refusal) {
      issues.push({ id: "key-home-isolation", severity: "critical", message: refusal.message, fix: `Delete ${refusal.file} (or remove its primaryApiKey entry).` });
    }
  }

  // A .env in a Codex home: Codex loads it into its own environment, so a proxy or certificate file there could see
  // an AI's key and traffic. Only its presence is checked; it is never read.
  for (const home of [...new Set([deps.codexHome || codexHomeFor(stateDir), path.join(stateDir, ".codex-home-keys")])]) {
    const dotenv = path.join(home, ".env");
    if (!exists(dotenv)) continue;
    issues.push({
      id: "codex-dotenv",
      severity: "critical",
      message: `${dotenv} is loaded by Codex into its own environment, so a proxy or certificate file there could see an AI's key and traffic; Tarsee won't start Codex while it is there.`,
      fix: `Set it aside in Settings > AI, or delete ${dotenv}.`,
    });
  }

  // Saved keys encrypted with a key kept only in a file on the same volume.
  try {
    if (isEncryptionEnabled() && savedKeyProviders(settingsStore).length && encryptionKeyOnVolume({ stateDir, env, readFile })) {
      issues.push({
        id: "encryption-key-on-volume",
        severity: "warning",
        message: "Your saved AI keys are encrypted with a key kept in a file on the same volume, so a copy of the volume alone opens them.",
        fix: "Add ENCRYPTION_KEY as a Railway variable with the same value as the .encryption-key file (so saved keys still open), then delete that file.",
      });
    }
  } catch { /* no settings database */ }

  // Check NODE_ENV
  if (env.NODE_ENV !== "production") {
    issues.push({ id: "node-env", severity: "info", message: "NODE_ENV is not 'production'. Some security features may be relaxed.", fix: "Set NODE_ENV=production" });
  }

  // All good
  if (issues.length === 0) {
    issues.push({ id: "ok", severity: "info", message: "All security checks passed.", fix: "" });
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
