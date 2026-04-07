import { Router } from "express";
import { SettingsStore } from "../db/settings.js";
import { AI_PROVIDERS } from "../config/constants.js";
import { getAvailableProviders } from "../ai/router.js";
import { readWorkspaceFile, writeWorkspaceFile, hasBootstrapFile, deleteBootstrapFile } from "../lib/workspace-files.js";
import { initTTSEngine } from "../voice/engine-registry.js";

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
  res.json({ providers: getAvailableProviders() });
});

/**
 * POST /api/settings/provider
 * Configure an AI provider.
 * Body: { provider, model?, apiKey?, baseUrl? }
 */
settingsRouter.post("/provider", (req, res) => {
  const { provider, model, apiKey, baseUrl } = req.body || {};

  if (!provider || !AI_PROVIDERS[provider]) {
    return res.status(400).json({ error: "Invalid provider. Valid: " + Object.keys(AI_PROVIDERS).join(", ") });
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

  // Auto-start/restart the channel immediately
  const channelManager = req.app.get("channelManager");
  if (channelManager && enabled && token) {
    channelManager.restart(type).catch((err) => {
      console.warn(`[channels] auto-start ${type} failed:`, err.message);
    });
  } else if (channelManager && !enabled) {
    channelManager.stop(type).catch(() => {});
  }

  res.json({ ok: true, type, enabled: !!enabled });
});

/**
 * GET /api/settings/setup-status
 * Check if first-time setup is needed.
 */
settingsRouter.get("/setup-status", (req, res) => {
  const provider = settingsStore.get("ai.activeProvider");
  const botName = settingsStore.get("identity.name");
  const hasKey = provider === "claude-code"; // Claude Code uses subscription auth, no API key
  // Claude Code is configured if CLAUDE_OAUTH_CREDENTIALS env var is set
  const envConfigured = !!process.env.CLAUDE_OAUTH_CREDENTIALS;
  // Personality is "done" if bot name was set, OR if SOUL.md/systemPrompt exist,
  // OR if setup was explicitly completed, OR if conversations already exist (not first-time)
  const setupCompleted = !!settingsStore.get("setup.completed");
  const db = req.app.get("db");
  const hasConversations = db ? (db.prepare("SELECT COUNT(*) as c FROM conversations").get()?.c || 0) > 0 : false;
  const hasPersonality = !!botName || !!settingsStore.get("identity.systemPrompt") || setupCompleted || hasConversations;
  res.json({
    needsSetup: !provider && !envConfigured,
    needsPersonality: !hasPersonality,
    botName: botName || "Tarsee",
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

  // Hot-reload: re-init TTS engine when voice settings change (no restart needed)
  if (key.startsWith("voice.")) {
    initTTSEngine(settingsStore).catch((err) => {
      console.warn("[settings] TTS hot-reload failed:", err.message);
    });
  }

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

/**
 * GET /api/settings/session-reset
 * Get session reset configuration.
 */
settingsRouter.get("/session-reset", (_req, res) => {
  res.json({
    mode: settingsStore.get("session.reset.mode") || "manual",
    atHour: Number(settingsStore.get("session.reset.atHour")) || 0,
    idleMinutes: Number(settingsStore.get("session.reset.idleMinutes")) || 60,
  });
});

/**
 * POST /api/settings/session-reset
 * Update session reset configuration.
 * Body: { mode, atHour?, idleMinutes? }
 */
settingsRouter.post("/session-reset", (req, res) => {
  const { mode, atHour, idleMinutes } = req.body || {};

  if (mode && !["manual", "daily", "idle"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode. Valid: manual, daily, idle" });
  }

  if (mode) settingsStore.set("session.reset.mode", mode);
  if (atHour !== undefined) settingsStore.set("session.reset.atHour", String(Math.max(0, Math.min(23, Number(atHour) || 0))));
  if (idleMinutes !== undefined) settingsStore.set("session.reset.idleMinutes", String(Math.max(5, Number(idleMinutes) || 60)));

  res.json({ ok: true });
});

/**
 * GET /api/settings/cron
 * List all cron jobs.
 */
settingsRouter.get("/cron", async (_req, res) => {
  try {
    const { getCronStatus } = await import("../lib/cron.js");
    res.json(getCronStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/settings/cron
 * Add a new cron job.
 * Body: { schedule, prompt, channel?, enabled? }
 */
settingsRouter.post("/cron", async (req, res) => {
  const { schedule, prompt, channel, enabled } = req.body || {};
  if (!schedule || !prompt) {
    return res.status(400).json({ error: "schedule and prompt are required" });
  }
  try {
    const { addCronJob } = await import("../lib/cron.js");
    const job = addCronJob({ schedule, prompt, channel, enabled });
    res.status(201).json(job);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/settings/cron/:id
 * Remove a cron job.
 */
settingsRouter.delete("/cron/:id", async (req, res) => {
  try {
    const { removeCronJob } = await import("../lib/cron.js");
    const removed = removeCronJob(req.params.id);
    if (!removed) return res.status(404).json({ error: "Job not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/settings/skills-status
 * Scan skills and report installed vs needs-install status.
 */
settingsRouter.get("/skills-status", async (_req, res) => {
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const { execSync } = await import("node:child_process");
  const skillsDir = nodePath.default.join(nodePath.default.dirname(new URL(import.meta.url).pathname), "..", "skills");
  try {
    const results = [];
    const dirs = fs.default.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const skillMd = nodePath.default.join(skillsDir, dir.name, "SKILL.md");
      if (!fs.default.existsSync(skillMd)) continue;
      const content = fs.default.readFileSync(skillMd, "utf8").slice(0, 600);
      const descMatch = content.match(/^description:\s*(.+)/m);
      const binsMatch = content.match(/"bins":\s*\[([^\]]+)\]/);
      const bins = binsMatch ? (binsMatch[1].match(/"([^"]+)"/g) || []).map(b => b.replace(/"/g, "")) : [];
      const missing = bins.filter(b => { try { execSync(`which ${b}`, { stdio: "ignore" }); return false; } catch { return true; } });
      results.push({ name: dir.name, description: descMatch?.[1]?.trim() || "", status: bins.length === 0 || missing.length === 0 ? "ready" : "needs_install", bins, missing });
    }
    results.sort((a, b) => (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1) || a.name.localeCompare(b.name));
    res.json({ skills: results, ready: results.filter(s => s.status === "ready").length, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

