/**
 * Service-worker registration + push subscription flow.
 *
 * The SW itself is always registered (PWA shell + offline). Push
 * subscription is NOT automatic — we only prompt the user to enable
 * notifications when they explicitly opt in (from Settings > Appearance
 * or by calling window.TarseePush.enable() from the console/console
 * dashboard). This keeps us off Apple's/Chrome's spammy-notification
 * shame lists.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.register("/sw.js?v=4").catch(() => {});

  // Convert base64 VAPID key to Uint8Array (web-push convention).
  function urlBase64ToUint8Array(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(normalized);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function csrfHeaders(method = "POST") {
    const headers = { "Content-Type": "application/json" };
    // Reuse the CSRF token the API wrapper uses when present.
    const match = document.cookie.match(/(?:^|;\s*)tarsee_csrf=([^;]+)/);
    if (match && method !== "GET") headers["X-CSRF-Token"] = match[1];
    return headers;
  }

  const api = {
    /**
     * Current subscription status:
     *   "unsupported" — browser has no PushManager
     *   "denied"      — user denied permission
     *   "default"     — hasn't been asked yet
     *   "subscribed"  — we have an active subscription
     *   "granted-unsubscribed" — permission granted but no PushManager sub yet
     */
    async status() {
      if (!("PushManager" in window) || !("Notification" in window)) return "unsupported";
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      if (!reg) return "unsupported";
      const perm = Notification.permission;
      if (perm === "denied") return "denied";
      if (perm === "default") return "default";
      const sub = await reg.pushManager.getSubscription();
      return sub ? "subscribed" : "granted-unsubscribed";
    },

    /**
     * Prompt for permission + subscribe. Safe to call even if already
     * subscribed (idempotent — re-saves the existing subscription so the
     * server has the latest label).
     */
    async enable(label = null) {
      if (!("PushManager" in window)) throw new Error("Push not supported in this browser");

      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notification permission " + perm);

      const reg = await navigator.serviceWorker.ready;

      // Pull VAPID public key from the server.
      const keyRes = await fetch("/api/push/vapid-key", {
        credentials: "same-origin",
      });
      if (!keyRes.ok) throw new Error("Could not fetch VAPID key");
      const { publicKey } = await keyRes.json();

      // Subscribe (idempotent — if already subscribed, returns the existing one).
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      // Persist to server.
      const labelGuess = label || (navigator.userAgentData?.platform || navigator.platform || "web");
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: await csrfHeaders("POST"),
        body: JSON.stringify({ subscription: sub.toJSON(), label: labelGuess }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Subscribe failed: HTTP ${res.status}`);
      }
      return sub;
    },

    async disable() {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      if (!reg) return { ok: true };
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return { ok: true };
      try {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: await csrfHeaders("POST"),
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch { /* best-effort */ }
      await sub.unsubscribe().catch(() => {});
      return { ok: true };
    },
  };

  window.TarseePush = api;
})();
