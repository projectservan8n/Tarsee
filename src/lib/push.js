/**
 * Web Push — VAPID key management + subscription fan-out.
 *
 * Stores:
 *   settings.push.vapid_public / push.vapid_private
 *     — generated on first boot, persisted to settings
 *   settings.push.subscriptions
 *     — array of { endpoint, keys: {p256dh, auth}, createdAt, label }
 *
 * Public API:
 *   getPublicKey()                                → base64 VAPID public key
 *   saveSubscription(sub, label?)                 → persist; replaces by endpoint
 *   removeSubscription(endpoint)                  → drop one
 *   listSubscriptions()                           → all (without keys)
 *   sendPush({ title, body, url?, tag? })         → fan-out to all; auto-evicts 410s
 *   sendPushTo(endpoint, payload)                 → single-target variant
 *
 * web-push lib handles signing + encryption. Auto-evicts subscriptions
 * that return 404/410 (user uninstalled PWA or revoked permission).
 */
import webpush from "web-push";
import { SettingsStore } from "../db/settings.js";

let _settingsStore = null;

/**
 * Lazily resolve the SettingsStore from the given DB handle — called
 * from routes and the MCP tool which both have access to `app.get("db")`.
 */
export function initPush(db, auditLog = null) {
  if (!_settingsStore) {
    _settingsStore = new SettingsStore(db, auditLog);
    ensureVapidKeys();
  }
  return { getPublicKey, saveSubscription, removeSubscription, listSubscriptions, sendPush };
}

function store() {
  if (!_settingsStore) throw new Error("Push not initialized — call initPush(db) first");
  return _settingsStore;
}

function ensureVapidKeys() {
  const s = store();
  let pub = s.get("push.vapid_public");
  let priv = s.get("push.vapid_private");
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    s.set("push.vapid_public", pub);
    s.set("push.vapid_private", priv);
    console.log("[push] generated new VAPID keypair");
  }
  const subject = s.get("push.vapid_subject") || "mailto:tony@opusautomations.com";
  webpush.setVapidDetails(subject, pub, priv);
}

export function getPublicKey() {
  return store().get("push.vapid_public");
}

export function listSubscriptions() {
  const subs = store().get("push.subscriptions") || [];
  return subs.map(({ endpoint, label, createdAt }) => ({ endpoint, label, createdAt }));
}

export function saveSubscription(sub, label = null) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error("Invalid subscription — missing endpoint or keys");
  }
  const s = store();
  const existing = s.get("push.subscriptions") || [];
  // De-dup by endpoint — re-subscribing replaces rather than piles up.
  const filtered = existing.filter((e) => e.endpoint !== sub.endpoint);
  filtered.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label: label || null,
    createdAt: new Date().toISOString(),
  });
  s.set("push.subscriptions", filtered);
  return filtered.length;
}

export function removeSubscription(endpoint) {
  const s = store();
  const existing = s.get("push.subscriptions") || [];
  const filtered = existing.filter((e) => e.endpoint !== endpoint);
  s.set("push.subscriptions", filtered);
  return existing.length - filtered.length;
}

/**
 * Send a push to every registered subscription.
 * Returns { sent, failed, evicted }.
 *
 * payload shape matches what the service worker's push handler expects:
 *   { title, body, url?, tag?, icon?, badge? }
 */
export async function sendPush(payload) {
  const s = store();
  const subs = s.get("push.subscriptions") || [];
  if (subs.length === 0) return { sent: 0, failed: 0, evicted: 0, total: 0 };

  const body = JSON.stringify({
    title: payload.title || "Tarsee",
    body: payload.body || "",
    url: payload.url || "/",
    tag: payload.tag || "tarsee",
    icon: payload.icon || "/icon-192.png",
    badge: payload.badge || "/icon-192.png",
  });

  let sent = 0, failed = 0;
  const toEvict = [];

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        body,
        { TTL: 60 * 60 * 24 }, // 24h — if not delivered by then, drop it
      );
      sent++;
    } catch (err) {
      failed++;
      // 404 = gone, 410 = gone (the only semantic). Evict.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        toEvict.push(sub.endpoint);
      } else {
        console.warn("[push] send failed:", err?.statusCode, err?.message, "for", sub.endpoint.slice(0, 60));
      }
    }
  }));

  if (toEvict.length > 0) {
    const remaining = subs.filter((s) => !toEvict.includes(s.endpoint));
    store().set("push.subscriptions", remaining);
    console.log(`[push] evicted ${toEvict.length} dead subscriptions`);
  }

  return { sent, failed, evicted: toEvict.length, total: subs.length };
}

/**
 * Small convenience — send to one specific endpoint. Useful for a webhook
 * that wants to notify a particular device.
 */
export async function sendPushTo(endpoint, payload) {
  const s = store();
  const subs = s.get("push.subscriptions") || [];
  const sub = subs.find((e) => e.endpoint === endpoint);
  if (!sub) return { ok: false, reason: "subscription not found" };

  const body = JSON.stringify({
    title: payload.title || "Tarsee",
    body: payload.body || "",
    url: payload.url || "/",
  });

  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 86400 });
    return { ok: true };
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      removeSubscription(endpoint);
      return { ok: false, reason: "subscription gone — evicted" };
    }
    return { ok: false, reason: err?.message || "unknown" };
  }
}
