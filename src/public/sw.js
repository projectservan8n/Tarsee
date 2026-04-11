// Tarsee Service Worker v2 — PWA install, offline shell, stale-while-revalidate
const CACHE_NAME = "tarsee-v4";

const APP_SHELL = [
  "/",
  "/offline.html",
  "/css/style.css",
  "/css/chat.css",
  "/css/voice.css",
  "/css/tokens.css",
  "/css/utilities.css",

  "/css/console.css",
  "/css/files.css",
  "/js/app.js",
  "/js/api.js",
  "/js/chat.js",
  "/js/voice.js",
  "/js/settings.js",
  "/js/setup.js",
  "/js/sw-register.js",

  "/js/console.js",
  "/js/files.js",
  "/js/terminal.js",
  "/manifest.json",
  "/icon-32.png",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
];

// Precache app shell on install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Clean up old caches on activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch strategies
self.addEventListener("fetch", (event) => {
  // Skip non-GET, API, WebSocket, and external requests
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // Don't intercept CDN/external requests
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

  const isNavigation = event.request.mode === "navigate";
  const ext = url.pathname.split(".").pop();
  const isStatic = ["css", "js", "png", "ico", "json", "woff2"].includes(ext);

  if (isNavigation) {
    // HTML navigation: network-first, fallback to offline page
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match("/offline.html"))
    );
  } else if (isStatic) {
    // Static assets: stale-while-revalidate
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request).then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        });
        return cached || networkFetch;
      })
    );
  } else {
    // Everything else: network-first, fallback to cache
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
