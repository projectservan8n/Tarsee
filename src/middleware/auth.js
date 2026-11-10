import crypto from "node:crypto";
import config from "../config/env.js";
import { LIMITS } from "../config/constants.js";

// --- Rate limiting + lockout state ---
const authAttempts = new Map(); // ip → { count, resetAt, failures, lockedUntil }

// Clean up stale entries every 5 minutes. Housekeeping timers run outside any
// request, so an uncaught throw here takes the whole process down — keep the
// body wrapped.
setInterval(() => {
  try {
    const now = Date.now();
    for (const [ip, entry] of authAttempts) {
      if (now >= entry.resetAt && (!entry.lockedUntil || now >= entry.lockedUntil)) {
        authAttempts.delete(ip);
      }
    }
  } catch (err) {
    console.error("[auth] rate-limit sweep failed:", err);
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
// A sign-in's id is the tarsee_session cookie, and only the browser keeps it. Tarsee keeps a hash of it (sessionKey),
// in this Map and in the sessions table, and looks a cookie up by its hash. The AI's shell runs as the same user and
// can read tarsee.db, so with the id itself stored there it could act as the signed-in owner (a free CSRF token from
// GET /api/auth/csrf does the rest). A hash read from the database signs nobody in: no cookie hashes to it.
const sessions = new Map(); // sessionKey(id) → { createdAt, ip }
// Persisted to SQLite (see initSessionStore): the in-memory Map is a
// write-through cache hydrated from disk on boot, so a restart or a Railway
// deploy no longer logs the whole team out. Railway REPLACES the container on
// every deploy, so without this every deploy signed everyone out.
// Override with TARSEE_SESSION_MAX_AGE_DAYS.
const SESSION_MAX_AGE_MS =
  (Number(process.env.TARSEE_SESSION_MAX_AGE_DAYS) || 30) * 24 * 60 * 60 * 1000;
let _sessionDb = null;

/** How a stored sign-in is marked as a hash: an older Tarsee stored the id itself (64 hex characters, no mark). */
const HASHED = "sha256:";

/**
 * What Tarsee keeps of a sign-in's id: "sha256:" and its SHA-256. The id is 32 random bytes, so a plain hash is enough:
 * there is nothing to guess.
 */
function sessionKey(sessionId) {
  return HASHED + crypto.createHash("sha256").update(String(sessionId), "utf8").digest("hex");
}

/**
 * Wire the sessions cache to SQLite. Creates the table, drops expired rows, hashes any id an older Tarsee stored as it
 * was (its owner stays signed in: their cookie hashes to the new row), and hydrates surviving sessions so logins
 * persist across restarts. Called once at boot from server.js, right after initDb.
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
  try {
    const hashed = hashStoredIds(db);
    if (hashed) console.log(`[auth] ${hashed} sign-in(s) were stored as their ids; now only a hash of each is kept, and they stay signed in`);
  } catch (err) {
    console.error("[auth] could not hash the stored sign-ins:", err.message);
  }
  sessions.clear();
  let restored = 0;
  try {
    for (const r of db.prepare(`SELECT id, created_at, ip FROM sessions WHERE id LIKE '${HASHED}%'`).all()) {
      sessions.set(r.id, { createdAt: r.created_at, ip: r.ip });
      restored++;
    }
  } catch {}
  console.log(`[auth] session store ready — ${restored} session(s) restored from disk (survive restarts)`);
}

/**
 * Replace each sign-in stored as its id (an older Tarsee) with its hash. The old text is wiped from the file as it is
 * replaced (secure_delete), and the write-ahead log is written back and emptied, so the ids are gone from disk too.
 * Returns how many were hashed.
 */
function hashStoredIds(db) {
  const plain = db.prepare(`SELECT id FROM sessions WHERE id NOT LIKE '${HASHED}%'`).all();
  if (!plain.length) return 0;
  // Back to what it was, by name: SQLite reads it as 0, 1 or 2, but takes "2" back as ON, not FAST.
  const before = ["OFF", "ON", "FAST"][Number(db.pragma("secure_delete", { simple: true }))] || "OFF";
  db.pragma("secure_delete = ON");
  try {
    const rename = db.prepare("UPDATE OR REPLACE sessions SET id = ? WHERE id = ?");
    db.transaction(() => { for (const { id } of plain) rename.run(sessionKey(id), id); })();
  } finally {
    db.pragma(`secure_delete = ${before}`);
  }
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  return plain.length;
}

/** Session lifetime in ms. */
export function sessionMaxAgeMs() { return SESSION_MAX_AGE_MS; }

/**
 * How long the browser keeps the sign-in's cookie: past the sign-in itself (400 days, the most browsers keep one), so
 * a tab left open after its sign-in ran out still sends it, and the server can say "your sign-in has run out" rather
 * than speak of the API token the page sends too (signInEnded). The id is no use once the sign-in has ended.
 */
export function sessionCookieMaxAgeMs() { return Math.max(SESSION_MAX_AGE_MS + 24 * 60 * 60 * 1000, 400 * 24 * 60 * 60 * 1000); }

// Clean up expired sessions every 30 minutes (memory + disk).
setInterval(() => {
  try {
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    for (const [id, session] of sessions) {
      if (session.createdAt < cutoff) sessions.delete(id);
    }
    try { _sessionDb?.prepare("DELETE FROM sessions WHERE created_at < ?").run(cutoff); } catch {}
  } catch (err) {
    console.error("[auth] session sweep failed:", err);
  }
}, 30 * 60_000).unref();

/**
 * Creates a new session and returns the session ID (for the cookie; only its hash is kept).
 */
export function createSession(ip) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const key = sessionKey(sessionId);
  const createdAt = Date.now();
  sessions.set(key, { createdAt, ip });
  try { _sessionDb?.prepare("INSERT OR REPLACE INTO sessions (id, created_at, ip) VALUES (?, ?, ?)").run(key, createdAt, ip); } catch {}
  return sessionId;
}

/**
 * Destroys a session, by the id its cookie holds.
 */
export function destroySession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return;
  const key = sessionKey(sessionId);
  sessions.delete(key);
  try { _sessionDb?.prepare("DELETE FROM sessions WHERE id = ?").run(key); } catch {}
}

/** Whether a cookie's id is a sign-in that is still on (not run out, not signed out). */
export function isLiveSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  const key = sessionKey(sessionId);
  const session = sessions.get(key);
  if (!session) return false;
  if (Date.now() - session.createdAt >= SESSION_MAX_AGE_MS) {
    sessions.delete(key);
    return false;
  }
  return true;
}

/** The id of the request's sign-in (its tarsee_session cookie) while it is on, else null. */
export function liveSessionId(req) {
  const sessionId = extractSessionToken(req);
  return sessionId && isLiveSession(sessionId) ? sessionId : null;
}

/**
 * Whether the request carries a sign-in's cookie that is no longer on: the sign-in ran out (or was signed out
 * elsewhere, or the server no longer knows it). The browser keeps the cookie past the sign-in (sessionCookieMaxAgeMs),
 * so this is a dashboard tab left open, told apart from an API caller, which sends no such cookie.
 */
export function signInEnded(req) {
  const sessionId = extractSessionToken(req);
  return !!sessionId && !isLiveSession(sessionId);
}

/** The answer to an owner-only request refused because its sign-in has run out. Sign in again, then `what`. */
export function signInRanOut(what = "try once more") {
  return `Your sign-in has run out. Sign in again, then ${what}.`;
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
  // No blanket bypass when SETUP_PASSWORD is unset.
  //
  // This used to `return true` in that case, and websocket.js uses this
  // function to gate the /terminal upgrade. So a deploy that forgot
  // SETUP_PASSWORD (or typo'd the variable name) published an unauthenticated
  // root-capable shell: anyone could open wss://<host>/terminal and read the
  // Claude OAuth credentials, the encryption key and every channel token off
  // the volume. A missing password must mean "no session can be valid", not
  // "every request is valid" — callers already fall back to the API token,
  // which is always generated.
  return !!liveSessionId(req);
}

/**
 * Middleware: Extracts auth info and attaches to req.auth.
 * Does NOT enforce auth — use requireAuth for that.
 * method "bearer" when the API token is sent, even with a sign-in's cookie (the dashboard sends both): what only the
 * owner may do checks the sign-in itself (liveSessionId).
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
  const sessionId = liveSessionId(req);
  if (sessionId) req.auth = { authenticated: true, method: "session", sessionId };

  next();
}

/**
 * Middleware: Requires authentication. Returns 401 if not authenticated. A sign-in that has run out is told so, with
 * needsSignIn (the dashboard then shows its sign-in screen): the owner's OK for HEARTBEAT.md and BOOT.md goes with the
 * sign-in alone (js/settings.js _ownerPost), so this is where it is refused.
 */
export function requireAuth(req, res, next) {
  if (req.auth?.authenticated) return next();
  if (signInEnded(req)) return res.status(401).json({ error: signInRanOut(), needsSignIn: true });
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
