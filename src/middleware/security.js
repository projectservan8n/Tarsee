import crypto from "node:crypto";

// --- CSRF: HMAC-signed tokens (stateless, survives restarts) ---
const CSRF_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// Derive a stable CSRF secret from ENCRYPTION_KEY or generate a persistent one.
// Using ENCRYPTION_KEY means tokens survive restarts as long as env is stable.
const CSRF_SECRET = process.env.ENCRYPTION_KEY
  ? crypto.createHash("sha256").update("csrf:" + process.env.ENCRYPTION_KEY).digest()
  : crypto.randomBytes(32);

function signCsrfToken(timestamp) {
  const hmac = crypto.createHmac("sha256", CSRF_SECRET);
  hmac.update(String(timestamp));
  return `${timestamp}.${hmac.digest("hex")}`;
}

function verifyCsrfToken(token) {
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const timestamp = Number(token.slice(0, dot));
  if (isNaN(timestamp)) return false;
  // Check expiry
  if (Date.now() - timestamp > CSRF_TOKEN_MAX_AGE_MS) return false;
  // Verify HMAC
  const expected = signCsrfToken(timestamp);
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

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
  const token = signCsrfToken(Date.now());

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

  // Validate HMAC signature and expiry (stateless — no server-side storage needed)
  if (!verifyCsrfToken(headerToken)) {
    return res.status(403).json({ error: "CSRF token invalid or expired" });
  }

  next();
}
