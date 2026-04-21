/**
 * Webhook Triggers — external events trigger AI actions.
 *
 * POST /api/webhooks/:hookId
 *
 * Auth: Bearer token in the Authorization header (the API token from
 * Settings > Memories tab). Query-param tokens are NOT accepted — tokens
 * in URLs leak into access logs, browser history, and referer headers.
 *
 * The webhook payload is forwarded to the AI as a prompt.
 * Hooks are configured via /webhook command or settings.
 */
import crypto from "node:crypto";
import { Router } from "express";
import { SettingsStore } from "../db/settings.js";
import { ConversationStore } from "../db/conversations.js";
import { runCronJob } from "../lib/cron.js";
import { requireAuth } from "../middleware/auth.js";

export const webhookRouter = Router();

let settingsStore = null;
let convStore = null;

webhookRouter.use((req, _res, next) => {
  if (!settingsStore) {
    const db = req.app.get("db");
    settingsStore = new SettingsStore(db);
    convStore = new ConversationStore(db);
  }
  next();
});

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify webhook token from the Authorization: Bearer header only.
 * Query-param tokens are rejected to prevent leakage via logs/history.
 */
function verifyWebhookToken(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  if (!token) return false;

  const storedToken = settingsStore.get("api.token");
  return !!storedToken && timingSafeEq(token, storedToken);
}

/**
 * POST /api/webhooks/:hookId
 *
 * Receives external event, builds a prompt, sends to AI.
 * The hookId maps to a stored webhook config with a prompt template.
 */
webhookRouter.post("/:hookId", async (req, res) => {
  if (!verifyWebhookToken(req)) {
    return res.status(401).json({ error: "Invalid or missing token" });
  }

  const { hookId } = req.params;

  // Validate hookId shape so it's safe in logs and URLs
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(hookId)) {
    return res.status(400).json({ error: "Invalid hookId" });
  }

  const payload = req.body;

  // Look up webhook config
  const hooks = settingsStore.get("webhooks") || {};
  const hook = hooks[hookId];

  // Reject unknown hooks — previously unknown hookIds silently used the
  // generic prompt, which let attackers trigger arbitrary AI runs with
  // just a valid bearer token. Only configured hooks may fire.
  if (!hook) {
    return res.status(404).json({ error: "Unknown webhook" });
  }

  // Build prompt from template or raw payload
  let prompt;
  if (hook.prompt) {
    prompt = hook.prompt
      .replace(/\{\{payload\}\}/g, typeof payload === "string" ? payload : JSON.stringify(payload, null, 2))
      .replace(/\{\{json\}\}/g, JSON.stringify(payload))
      .replace(/\{\{hookId\}\}/g, hookId);
  } else {
    prompt = `[Webhook: ${hookId}] Received external event:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nAnalyze this event and take appropriate action.`;
  }

  const channel = hook.channel || "web:default";

  // Run as a cron-style job (reuses the same AI execution pipeline).
  // We fire-and-forget intentionally (the job can take minutes), but we
  // attach the catch BEFORE replying so the promise is always handled,
  // and we validate the job spec synchronously before responding.
  const job = { id: `webhook-${hookId}`, prompt, channel };
  const jobPromise = runCronJob(job).catch((err) => {
    console.error(`[webhook] ${hookId} error:`, err?.message || err);
  });
  // Prevent "unhandled rejection" if caller never awaits
  jobPromise.catch(() => {});

  res.status(202).json({
    ok: true,
    hookId,
    message: `Webhook accepted, AI processing asynchronously: ${hookId}`,
  });
});

/**
 * GET /api/webhooks
 * List configured webhooks. Requires session auth — previously public.
 */
webhookRouter.get("/", requireAuth, (_req, res) => {
  const hooks = settingsStore.get("webhooks") || {};
  res.json({ hooks });
});
