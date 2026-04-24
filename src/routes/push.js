/**
 * Web Push subscription routes.
 *
 * These sit under `/api/push/*`. requireAuth is applied at the server
 * mount point — same as /api/chat etc. — so only an authenticated UI
 * can subscribe. The vapid public key endpoint is trivially safe to
 * expose (it's public-by-design), but keeping it behind auth avoids
 * fingerprinting of un-deployed instances.
 */
import { Router } from "express";
import { getPublicKey, saveSubscription, removeSubscription, listSubscriptions } from "../lib/push.js";

export const pushRouter = Router();

/**
 * GET /api/push/vapid-key
 * Returns the server's public VAPID key so the client can subscribe.
 */
pushRouter.get("/vapid-key", (_req, res) => {
  const key = getPublicKey();
  if (!key) return res.status(500).json({ error: "VAPID keys not initialized" });
  res.json({ publicKey: key });
});

/**
 * POST /api/push/subscribe
 * Body: { subscription: { endpoint, keys: {p256dh, auth} }, label? }
 */
pushRouter.post("/subscribe", (req, res) => {
  const { subscription, label } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "Missing subscription or required keys" });
  }
  try {
    const count = saveSubscription(subscription, label);
    const auditLog = req.app.get("auditLog");
    auditLog?.log({ action: "push.subscribe", actor: "user", ip: req.ip, detail: label || subscription.endpoint.slice(0, 60) });
    res.json({ ok: true, subscriptions: count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/push/unsubscribe
 * Body: { endpoint }
 */
pushRouter.post("/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint required" });
  const removed = removeSubscription(endpoint);
  res.json({ ok: true, removed });
});

/**
 * GET /api/push/subscriptions
 * Lists registered devices (endpoint is truncated client-side for display).
 */
pushRouter.get("/subscriptions", (_req, res) => {
  res.json({ subscriptions: listSubscriptions() });
});

/**
 * POST /api/push/test
 * Dev/QA: send a test push to all registered subscriptions.
 */
pushRouter.post("/test", async (req, res) => {
  try {
    const { sendPush } = await import("../lib/push.js");
    const result = await sendPush({
      title: "Tarsee test",
      body: req.body?.message || "Push notifications are working 🎉",
      url: "/",
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
