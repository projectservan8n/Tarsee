import crypto from "node:crypto";
import config from "../config/env.js";
import { LIMITS } from "../config/constants.js";

// --- Rate limiting state ---
const authAttempts = new Map(); // ip → { count, resetAt }

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (now >= entry.resetAt) authAttempts.delete(ip);
  }
}, 5 * 60_000).unref();

/**
 * Timing-safe string comparison.
 */
function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still do a comparison to maintain constant time
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Extracts Bearer token from Authorization header.
 */
function extractBearerToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

/**
 * Extracts session token from cookie.
 */
function extractSessionToken(req) {
  const cookies = req.headers.cookie || "";
  const match = cookies.match(/(?:^|;\s*)opusclaw_session=([^;]+)/);
  return match ? match[1].trim() : null;
}

// --- Active sessions ---
const sessions = new Map(); // sessionId → { createdAt, ip }
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Clean up expired sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_MAX_AGE_MS) sessions.delete(id);
  }
}, 30 * 60_000).unref();

/**
 * Creates a new session and returns the session ID.
 */
export function createSession(ip) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, { createdAt: Date.now(), ip });
  return sessionId;
}

/**
 * Destroys a session.
 */
export function destroySession(sessionId) {
  sessions.delete(sessionId);
}

/**
 * Validates password against SETUP_PASSWORD.
 */
export function validatePassword(password) {
  if (!config.SETUP_PASSWORD) return false;
  return safeCompare(password, config.SETUP_PASSWORD);
}

/**
 * Validates an API token.
 */
export function validateApiToken(token) {
  return safeCompare(token, config.API_TOKEN);
}

/**
 * Validates a session from an HTTP request (for WebSocket upgrades).
 * Returns true if the request has a valid session cookie.
 */
export function validateSessionFromRequest(req) {
  // If no password is required, all connections are allowed
  if (!config.SETUP_PASSWORD) return true;

  const sessionToken = extractSessionToken(req);
  if (!sessionToken || !sessions.has(sessionToken)) return false;

  const session = sessions.get(sessionToken);
  if (Date.now() - session.createdAt > SESSION_MAX_AGE_MS) {
    sessions.delete(sessionToken);
    return false;
  }
  return true;
}

/**
 * Middleware: Extracts auth info and attaches to req.auth.
 * Does NOT enforce auth — use requireAuth for that.
 */
export function sessionAuth(req, _res, next) {
  req.auth = { authenticated: false, method: null };

  // Check Bearer token (for API clients)
  const bearerToken = extractBearerToken(req);
  if (bearerToken && validateApiToken(bearerToken)) {
    req.auth = { authenticated: true, method: "bearer" };
    return next();
  }

  // Check session cookie (for WebUI)
  const sessionToken = extractSessionToken(req);
  if (sessionToken && sessions.has(sessionToken)) {
    const session = sessions.get(sessionToken);
    if (Date.now() - session.createdAt < SESSION_MAX_AGE_MS) {
      req.auth = { authenticated: true, method: "session", sessionId: sessionToken };
      return next();
    }
    sessions.delete(sessionToken);
  }

  next();
}

/**
 * Middleware: Requires authentication. Returns 401 if not authenticated.
 */
export function requireAuth(req, res, next) {
  if (req.auth?.authenticated) return next();
  res.status(401).json({ error: "Authentication required" });
}

/**
 * Middleware: Rate limits authentication attempts per IP.
 */
export function rateLimitAuth(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const window = LIMITS.RATE_LIMIT_AUTH_WINDOW_MS;
  const max = LIMITS.RATE_LIMIT_AUTH_MAX;

  let entry = authAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + window };
    authAttempts.set(ip, entry);
  }

  if (entry.count >= max) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many authentication attempts. Try again later." });
  }

  // Increment on every attempt (successful attempts won't hit this path often)
  entry.count++;
  next();
}
