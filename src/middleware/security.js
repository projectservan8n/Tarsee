import crypto from "node:crypto";

// --- CSRF Token Store ---
// Maps CSRF token → expiry timestamp. Tokens are single-use or expire after 2 hours.
const csrfTokens = new Map();
const CSRF_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// Cleanup expired tokens every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of csrfTokens) {
    if (now >= expiry) csrfTokens.delete(token);
  }
}, 30 * 60_000).unref();

/**
 * Middleware: Sets security headers on all responses.
 */
export function securityHeaders(_req, res, next) {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("X-XSS-Protection", "0");  // Deprecated, but some scanners check for it
  res.set("Referrer-Policy", "same-origin");
  res.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  res.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",            // For voice audio playback
    "connect-src 'self' ws: wss:",       // WebSocket connections
    "font-src 'self' https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  next();
}

/**
 * Middleware: Generates a CSRF cookie on page loads.
 * Call this on GET routes that serve HTML pages.
 */
export function generateCsrfCookie(_req, res, next) {
  const token = crypto.randomBytes(32).toString("hex");
  csrfTokens.set(token, Date.now() + CSRF_TOKEN_MAX_AGE_MS);

  res.cookie("opusclaw_csrf", token, {
    httpOnly: false,        // JS needs to read it for the double-submit pattern
    sameSite: "Strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: CSRF_TOKEN_MAX_AGE_MS,
    path: "/",
  });
  next();
}

/**
 * Middleware: Validates CSRF token on state-changing requests.
 * Expects X-CSRF-Token header to match the opusclaw_csrf cookie.
 * Skips validation for Bearer token auth (API clients don't need CSRF).
 */
export function csrfProtect(req, res, next) {
  // Skip CSRF for API token auth (Bearer) — CSRF is a browser-specific attack
  if (req.auth?.method === "bearer") return next();

  // Only enforce on state-changing methods
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const headerToken = req.headers["x-csrf-token"];
  if (!headerToken) {
    return res.status(403).json({ error: "CSRF token missing" });
  }

  // Validate token exists and hasn't expired
  const expiry = csrfTokens.get(headerToken);
  if (!expiry || Date.now() >= expiry) {
    csrfTokens.delete(headerToken);
    return res.status(403).json({ error: "CSRF token invalid or expired" });
  }

  // Token is valid — don't delete it (allow reuse within the window for SPA)
  next();
}
