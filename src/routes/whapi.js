/**
 * WHAPI inbound webhook for the WhatsApp channel.
 *
 * POST /api/channels/whapi/:secret
 *
 * WHAPI does not sign payloads — we authenticate by requiring a per-channel
 * secret in the URL path, generated on first enable and stored encrypted
 * alongside the channel token. Acks fast (200) and processes async so the
 * WHAPI delivery queue doesn't back up on slow AI responses.
 */
import crypto from "node:crypto";
import { Router } from "express";
import { SettingsStore } from "../db/settings.js";

export const whapiRouter = Router();

let settingsStore = null;
whapiRouter.use((req, _res, next) => {
  if (!settingsStore) settingsStore = new SettingsStore(req.app.get("db"));
  next();
});

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Run a constant-time compare against ourselves to keep timing uniform.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

whapiRouter.post("/:secret", async (req, res) => {
  const cfg = settingsStore.get("channel.whatsapp");
  if (!cfg?.enabled || !cfg?.webhook_secret) {
    return res.status(404).json({ error: "WhatsApp channel not configured" });
  }
  if (!timingSafeEq(req.params.secret, cfg.webhook_secret)) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  // Ack fast — WHAPI retries on non-2xx and we don't want to block the queue
  res.status(200).json({ ok: true });

  const channelManager = req.app.get("channelManager");
  if (!channelManager) {
    console.warn("[whapi] no channelManager available — server still booting?");
    return;
  }

  let channel = channelManager.channels?.get("whatsapp");

  // Self-heal: settings say the channel is enabled + has a token, but it
  // isn't in the running map. That happens if the server booted before the
  // user enabled the channel, or if a prior startup error left it stuck.
  // Try to start it now so the very next webhook delivery succeeds.
  if (!channel?.bot?.handleInbound && cfg.enabled && cfg.token) {
    try {
      console.log("[whapi] channel not running but config is valid — starting now");
      await channelManager.start("whatsapp", cfg);
      channel = channelManager.channels?.get("whatsapp");
    } catch (err) {
      console.error("[whapi] lazy-start failed:", err.message);
      return;
    }
  }

  if (!channel?.bot?.handleInbound) {
    console.warn(
      `[whapi] channel not running, dropping inbound — ` +
      `enabled=${!!cfg.enabled} hasToken=${!!cfg.token} bot=${!!channel?.bot}`
    );
    return;
  }

  channel.bot.handleInbound(req.body).catch((err) => {
    console.error("[whapi] inbound error:", err.message);
  });
});

whapiRouter.get("/_ping", (_req, res) => {
  res.json({ ok: true, channel: "whapi" });
});
