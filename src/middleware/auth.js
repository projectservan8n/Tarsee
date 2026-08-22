import crypto from "node:crypto";
import config from "../config/env.js";
import { LIMITS } from "../config/constants.js";

// --- Rate limiting + lockout state ---
const authAttempts = new Map(); // ip → { count, resetAt, failures, lockedUntil }

// Clean up stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_MAX_AGE_MS;
  for (const [ip, entry] of authAttempts) {
    if (now >= entry.resetAt && (!entry.lockedUntil || now >= entry.lockedUntil)) {
      authAttempts.delete(ip);
    }
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
  const match = cookies.match(/(?:^|;\s*)tarsee_session=([^;]+)/);
  return match ? match[1].trim() : null;
}

// --- Active sessions ---
const sessions = new Map(); // sessionId → { createdAt, ip }
// Persisted to SQLite (see initSessionStore): the in-memory Map is a
// write-through cache hydrated from disk on boot, so a restart or a Railway
// deploy no longer logs the whole team out. Railway REPLACES the container on
// every deploy, so without this every deploy signed everyone out.
// Override with TARSEE_SESSION_MAX_AGE_DAYS.
const SESSION_MAX_AGE_MS =
  (Number(process.env.TARSEE_SESSION_MAX_AGE_DAYS) || 30) * 24 * 60 * 60 * 1000;
let _sessionDb = null;

/**
 * Wire the sessions cache to SQLite. Creates the table, drops expired rows,
 * and hydrates surviving sessions so logins persist across restarts. Called
 * once at boot from server.js, right after initDb.
 */
export function initSessionStore(db) {
  _sessionDb = db;
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    ip TEXT
  )`);
  const cutoff = Date.now() - SESSION_MAX_AGE_MS;
  try { db.prepare("DELETE FROM sessions WHERE created_at < ?").run(cutoff); } catch {}
  let restored = 0;
  try {
    for (const r of db.prepare("SELECT id, created_at, ip FROM sessions").all()) {
      sessions.set(r.id, { createdAt: r.created_at, ip: r.ip });
      restored++;
    }
  } catch {}
  console.log(`[auth] session store ready — ${restored} session(s) restored from disk (survive restarts)`);
}

/** Session lifetime in ms — exported so cookie maxAge cannot drift from it. */
export function sessionMaxAgeMs() { return SESSION_MAX_AGE_MS; }

// Clean up expired sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
  try { _sessionDb?.prepare("DELETE FROM sessions WHERE created_at < ?").run(cutoff); } catch {}
}, 30 * 60_000).unref();

/**
 * Creates a new session and returns the session ID.
 */
export function createSession(ip) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const createdAt = Date.now();
  sessions.set(sessionId, { createdAt, ip });
  try { _sessionDb?.prepare("INSERT OR REPLACE INTO sessions (id, created_at, ip) VALUES (?, ?, ?)").run(sessionId, createdAt, ip); } catch {}
  return sessionId;
}

/**
 * Destroys a session.
 */
export function destroySession(sessionId) {
  sessions.delete(sessionId);
  try { _sessionDb?.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId); } catch {}
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
/**
 * Progressive lockout for brute-force protection.
 * 4-digit PIN = 10K combinations, so we need aggressive lockout:
 *
 *   Failures 1-3:  no delay (typos happen)
 *   Failures 4-5:  30 second lockout
 *   Failures 6-7:  2 minute lockout
 *   Failures 8-9:  10 minute lockout
 *   Failures 10+:  1 hour lockout (IP is blocked)
 *
 * Plus: max 5 attempts per 60-second window (rate limit).
 * Combined: brute-forcing 10K PINs takes ~2,000 hours.
 */
export function rateLimitAuth(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  let entry = authAttempts.get(ip);
  if (!entry) {
    entry = { count: 0, resetAt: now + 60_000, failures: 0, lockedUntil: 0 };
    authAttempts.set(ip, entry);
  }

  // Check lockout first
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: `Locked out. Try again in ${retryAfter}s.` });
  }

  // Rate limit: max 5 per 60s window
  if (now >= entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60_000;
  }

  if (entry.count >= 5) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  entry.count++;
  next();
}

/**
 * Record a failed login attempt and apply progressive lockout.
 */
export function recordFailedAttempt(ip) {
  let entry = authAttempts.get(ip);
  if (!entry) {
    entry = { count: 0, resetAt: Date.now() + 60_000, failures: 0, lockedUntil: 0 };
    authAttempts.set(ip, entry);
  }
  entry.failures++;

  // Progressive lockout
  if (entry.failures >= 10) entry.lockedUntil = Date.now() + 60 * 60_000;       // 1 hour
  else if (entry.failures >= 8) entry.lockedUntil = Date.now() + 10 * 60_000;    // 10 min
  else if (entry.failures >= 6) entry.lockedUntil = Date.now() + 2 * 60_000;     // 2 min
  else if (entry.failures >= 4) entry.lockedUntil = Date.now() + 30_000;          // 30s
}

/**
 * Clear failed attempts for an IP (call on successful login).
 */
export function clearFailedAttempts(ip) {
  const entry = authAttempts.get(ip);
  if (entry) { entry.failures = 0; entry.lockedUntil = 0; }
}
