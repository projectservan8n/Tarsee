import { Router } from "express";
import { SettingsStore } from "../db/settings.js";
import { AI_PROVIDERS } from "../config/constants.js";
import { getAvailableProviders } from "../ai/router.js";
import { readWorkspaceFile, writeWorkspaceFile, hasBootstrapFile, deleteBootstrapFile } from "../lib/workspace-files.js";

export const settingsRouter = Router();

let settingsStore = null;

settingsRouter.use((req, _res, next) => {
  if (!settingsStore) settingsStore = new SettingsStore(req.app.get("db"));
  next();
});

/**
 * GET /api/settings
 * Get all settings (redacted API keys).
 */
settingsRouter.get("/", (_req, res) => {
  const all = settingsStore.all();

  // Redact API keys — show only last 4 chars
  const redacted = all.map((s) => {
    if (s.key.endsWith(".apiKey") && typeof s.value === "string" && s.value.length > 4) {
      return { ...s, value: "***" + s.value.slice(-4) };
    }
    return s;
  });

  res.json({ settings: redacted });
});

/**
 * GET /api/settings/providers
 * Get AI provider list with configuration status.
 */
settingsRouter.get("/providers", (_req, res) => {
  res.json({ providers: getAvailableProviders(settingsStore) });
});

/**
 * POST /api/settings/provider
 * Configure an AI provider.
 * Body: { provider, model?, apiKey?, baseUrl? }
 */
settingsRouter.post("/provider", (req, res) => {
  const { provider, model, apiKey, baseUrl } = req.body || {};

  if (!provider || !AI_PROVIDERS[provider]) {
    if (provider !== "custom") {
      return res.status(400).json({ error: "Invalid provider. Valid: " + Object.keys(AI_PROVIDERS).join(", ") });
    }
  }

  settingsStore.setActiveProvider(provider, { model, apiKey, baseUrl });

  res.json({ ok: true, provider, model: model || AI_PROVIDERS[provider]?.defaultModel });
});

/**
 * POST /api/settings/channel
 * Configure a messaging channel.
 * Body: { type: "discord"|"telegram"|"slack", token, appToken?, enabled, ...opts }
 */
settingsRouter.post("/channel", (req, res) => {
  const { type, token, appToken, enabled, ...opts } = req.body || {};

  if (!["discord", "telegram", "slack"].includes(type)) {
    return res.status(400).json({ error: "Invalid channel type. Valid: discord, telegram, slack" });
  }

  if (enabled && !token) {
    return res.status(400).json({ error: "Token is required to enable a channel" });
  }

  settingsStore.set(`channel.${type}`, {
    enabled: !!enabled,
    token: token || null,
    appToken: appToken || null,
    ...opts,
  });

  res.json({ ok: true, type, enabled: !!enabled });
});

/**
 * GET /api/settings/setup-status
 * Check if first-time setup is needed.
 */
settingsRouter.get("/setup-status", (_req, res) => {
  const provider = settingsStore.get("ai.activeProvider");
  const botName = settingsStore.get("identity.name");
  const hasKey = provider
    ? !!settingsStore.get(`ai.${provider}.apiKey`)
    : false;
  // Also check env vars — if ANTHROPIC_API_KEY etc is set, provider may work without UI config
  const envConfigured = !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.OPENROUTER_API_KEY
  );
  res.json({
    needsSetup: !provider && !envConfigured,
    needsPersonality: !botName,
    botName: botName || "OpusClaw",
    provider: provider || null,
    hasKey: hasKey || envConfigured,
  });
});

/**
 * GET /api/settings/workspace-file
 * Read a workspace identity file (SOUL.md, USER.md, MEMORY.md).
 * Query: ?name=SOUL.md
 */
const ALLOWED_WORKSPACE_FILES = [
  "SOUL.md", "USER.md", "MEMORY.md",
  "AGENTS.md", "IDENTITY.md", "TOOLS.md",
  "HEARTBEAT.md", "BOOT.md", "BOOTSTRAP.md",
];

settingsRouter.get("/workspace-file", (req, res) => {
  const name = req.query.name;
  if (!name || !ALLOWED_WORKSPACE_FILES.includes(name)) {
    return res.status(400).json({ error: `Invalid file. Allowed: ${ALLOWED_WORKSPACE_FILES.join(", ")}` });
  }
  const content = readWorkspaceFile(name);
  res.json({ name, content });
});

/**
 * PUT /api/settings/workspace-file
 * Write a workspace identity file.
 * Body: { name, content }
 */
settingsRouter.put("/workspace-file", (req, res) => {
  const { name, content } = req.body || {};
  if (!name || !ALLOWED_WORKSPACE_FILES.includes(name)) {
    return res.status(400).json({ error: `Invalid file. Allowed: ${ALLOWED_WORKSPACE_FILES.join(", ")}` });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ error: "Content must be a string" });
  }
  writeWorkspaceFile(name, content);
  res.json({ ok: true, name });
});

/**
 * POST /api/settings/general
 * Update general settings.
 * Body: { key, value }
 */
settingsRouter.post("/general", (req, res) => {
  const { key, value } = req.body || {};

  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "Key is required" });
  }

  // Prevent overwriting protected keys
  const protectedPrefixes = ["ai.", "channel."];
  if (protectedPrefixes.some((p) => key.startsWith(p))) {
    return res.status(400).json({ error: "Use the dedicated endpoint for provider/channel settings" });
  }

  settingsStore.set(key, value);
  res.json({ ok: true });
});

/**
 * GET /api/settings/bootstrap-status
 * Check if BOOTSTRAP.md exists (first-run detection).
 */
settingsRouter.get("/bootstrap-status", (_req, res) => {
  res.json({ hasBootstrap: hasBootstrapFile() });
});

/**
 * DELETE /api/settings/bootstrap
 * Delete BOOTSTRAP.md after first-run setup is complete.
 */
settingsRouter.delete("/bootstrap", (_req, res) => {
  deleteBootstrapFile();
  res.json({ ok: true });
});
