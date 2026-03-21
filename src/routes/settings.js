import { Router } from "express";
import { SettingsStore } from "../db/settings.js";
import { AI_PROVIDERS } from "../config/constants.js";
import { getAvailableProviders } from "../ai/router.js";

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
