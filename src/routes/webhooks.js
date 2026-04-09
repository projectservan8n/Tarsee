/**
 * Webhook Triggers — external events trigger AI actions.
 *
 * POST /api/webhooks/:hookId
 *
 * Auth: Bearer token (the API token from Settings > Memories tab)
 * or ?token=xxx query param.
 *
 * The webhook payload is forwarded to the AI as a prompt.
 * Hooks are configured via /webhook command or settings.
 */
import { Router } from "express";
import { SettingsStore } from "../db/settings.js";
import { ConversationStore } from "../db/conversations.js";
import { runCronJob } from "../lib/cron.js";

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

/**
 * Verify webhook token.
 */
function verifyWebhookToken(req) {
  const auth = req.headers.authorization;
  const queryToken = req.query.token;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : queryToken;
  if (!token) return false;

  const storedToken = settingsStore.get("api.token");
  return storedToken && token === storedToken;
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
  const payload = req.body;

  // Look up webhook config
  const hooks = settingsStore.get("webhooks") || {};
  const hook = hooks[hookId];

  // Build prompt from template or raw payload
  let prompt;
  if (hook?.prompt) {
    // Replace {{payload}} and {{json}} placeholders in template
    prompt = hook.prompt
      .replace(/\{\{payload\}\}/g, typeof payload === "string" ? payload : JSON.stringify(payload, null, 2))
      .replace(/\{\{json\}\}/g, JSON.stringify(payload))
      .replace(/\{\{hookId\}\}/g, hookId);
  } else {
    // No config — use generic prompt
    prompt = `[Webhook: ${hookId}] Received external event:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nAnalyze this event and take appropriate action.`;
  }

  const channel = hook?.channel || "web:default";

  // Run as a cron-style job (reuses the same AI execution pipeline)
  try {
    const job = { id: `webhook-${hookId}`, prompt, channel };
    runCronJob(job).catch((err) => console.error(`[webhook] ${hookId} error:`, err.message));

    res.json({
      ok: true,
      hookId,
      message: `Webhook received, AI processing: ${hookId}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/webhooks
 * List configured webhooks (requires session auth).
 */
webhookRouter.get("/", (req, res) => {
  const hooks = settingsStore.get("webhooks") || {};
  res.json({ hooks });
});
