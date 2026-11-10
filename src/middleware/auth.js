import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import config from "../config/env.js";
import { LIMITS } from "../config/constants.js";

// --- Rate limiting + lockout state ---
// A place (signInKey, and for an IPv6 client its /56 and /48 too, placeLevels) → { count, resetAt, failures,
// lockedUntil, lastFailureAt }. failures, lockedUntil and lastFailureAt are kept in tarsee.db too (sign_in_places,
// initSignInLimits), so a restart doesn't give a place a fresh start.
const authAttempts = new Map();
// How long a place's wrong guesses are remembered after its last one. The sweep below used to forget a place as soon as
// it was between waits, so three guesses, a five-minute pause, and three more never reached the long waits.
const FAILURE_MEMORY_MS = 24 * 60 * 60_000;

// Clean up stale entries every 5 minutes, and write what a failed write left out (savePending). Housekeeping timers
// run outside any request, so an uncaught throw here takes the whole process down — keep the body wrapped.
setInterval(() => {
  try {
    const now = Date.now();
    for (const [key, entry] of authAttempts) {
      if (now >= entry.resetAt && placeForgotten(entry, now)) authAttempts.delete(key);
    }
    if (openStore()) {
      savePending();
      forgetStoredPlaces(now);
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
  initSignInLimits(db);
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

  // With TARSEE_TRUSTED_PROXY=cloudflare, req.ip is the client Cloudflare names too, as the sign-in limit counts it:
  // Express's trust proxy reads only X-Forwarded-For, which isn't believed then (trustProxyHop).
  if (trustedProxies().cloudflare) {
    const client = clientAddress(req);
    if (client) Object.defineProperty(req, "ip", { value: client, configurable: true, enumerable: true, writable: true });
  }

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

// --- Signing in: who a sign-in comes from, and how many wrong guesses it gets ---
//
// The dashboard's password may be a short PIN (4 digits is 10,000 choices), so wrong guesses are limited twice over:
//
// 1. Each place a sign-in comes from (signInKey) has its own budget, with waits that grow:
//      wrong guesses 1-3: no wait (typos happen)
//                    4-5: 30 seconds
//                    6-7: 2 minutes
//                    8-9: 10 minutes
//                    10+: 1 hour each
//    plus at most 5 tries a minute. A place's wrong guesses are remembered until a day passes without one, and a right
//    password clears them. So one place gets 8 wrong guesses in its first 10 minutes and then 24 a day: a 4-digit PIN
//    takes it about 200 days on average.
//    An IPv6 client is its /64, and its /56 and /48 are places too, each with the budget above (placeLevels): a home
//    is commonly given a /56 (256 /64s) and a free tunnel a /48 (65,536), so with the /64 alone one home could make a
//    new budget from each of its /64s. A guess waits while any of the three does. Clients that share a /48 share its
//    budget, as clients behind one IPv4 address (a carrier's NAT) share that address's.
//
// 2. All places together get 30 wrong guesses in 10 minutes. Then signing in pauses for everyone for 15 minutes, and
//    each pause that starts within a day of the last one ending is twice as long, up to 4 hours. Why these numbers:
//    - the owner and a few people mistyping never come near 30 in 10 minutes;
//    - one place can't reach it: it adds at most 8 in 10 minutes (EVERYONE_PER_PLACE; its waits hold it to that
//      anyway, and an IPv6 client counts by its /48), so one guesser can't stop everyone else from signing in: it
//      takes four or more places guessing together. That holds only while a client can't pass as a new place with
//      each guess, which is why a header naming the client (X-Forwarded-For, or Cloudflare's CF-Connecting-IP) is
//      believed only from a proxy the owner names (TARSEE_TRUSTED_PROXY), and never X-Forwarded-For through
//      Cloudflare, which anyone with a Cloudflare account can send requests from;
//    - places that do guess together get about 300 wrong guesses in the first day and 180 a day after that, so a
//      4-digit PIN takes them about a month on average, and a 6-digit one years.
//    During a pause, anyone already signed in stays signed in; only new sign-ins wait, the right password too (a guess
//    must not learn it was right).
//
// Both counts are kept in tarsee.db (initSignInLimits) and read back at boot. A restart used to give every place, and
// all places together, a fresh start, and the AI can cause one (the Railway tool redeploys Tarsee; today its shell
// can stop the server), so guessers could make 29 wrong guesses, have Tarsee restarted, and go again.
// Each try is counted as a wrong password, and saved, before its password is checked (startSignInAttempt). When that
// can't be saved (a full disk, a locked database: the AI shares the volume, so it could fill it), the try is turned
// away unchecked (refuseUnrecorded), so no guess is ever checked on a count that a restart would forget. Anyone
// already signed in stays signed in, and new sign-ins open again by themselves once a write works.

const THIS_MACHINE = "this machine";
const NO_ADDRESS = "no address";

/** An address as Node gives it, made comparable: lower case, without "::ffff:" before an IPv4 address or a zone ("%eth0"). */
function plainAddress(addr) {
  if (typeof addr !== "string") return "";
  let a = addr.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone !== -1) a = a.slice(0, zone);
  if (a.startsWith("::ffff:") && net.isIPv4(a.slice(7))) a = a.slice(7);
  return a;
}

let ownAddresses = { at: -Infinity, set: new Set() };
/** This machine's own network addresses, every interface's, looked up again after a minute. */
function ownAddressSet() {
  const now = performance.now();
  if (now - ownAddresses.at < 60_000) return ownAddresses.set;
  const set = new Set();
  try {
    for (const nics of Object.values(os.networkInterfaces())) {
      for (const nic of nics || []) {
        const a = plainAddress(nic.address);
        if (a) set.add(a);
      }
    }
  } catch { /* none listed: loopback is still known below */ }
  ownAddresses = { at: now, set };
  return set;
}

/**
 * Whether a connection comes from this machine itself: a loopback address (any of 127.0.0.0/8, or ::1) or one of the
 * machine's own network addresses. Whatever runs here, the AI's shell included, connects from one of these, and can
 * write any X-Forwarded-For or X-Real-IP it likes. That holds after the AI gets its own OS user too: it still shares
 * this machine's network.
 */
export function isThisMachine(addr) {
  const a = plainAddress(addr);
  if (!a) return false;
  if (a === "::1" || a === "::" || a === "0.0.0.0") return true;
  if (net.isIPv4(a) && a.startsWith("127.")) return true;
  return ownAddressSet().has(a);
}

const onRailway = () => !!process.env.RAILWAY_PROJECT_ID;

// --- Which proxy may name the client: TARSEE_TRUSTED_PROXY ---
//
// A proxy in front of Tarsee connects from its own address and names the client in a header. Any client can write
// that header too, so it is believed only from a proxy the owner names:
//   none (the default): from nobody; each connection is its own client, its socket's address. Reached directly, or
//     through Docker's published port, a client can't pass as a new one with each guess;
//   loopback: a proxy on this same machine (nginx, Caddy, cloudflared or Tailscale in front of `npm start`), which
//     names the client in X-Forwarded-For. Anything else running here, the AI's shell included, can then name any
//     client, and only the limit for all places holds it: it can pause signing in for everyone;
//   addresses and CIDR ranges, such as "10.0.0.2" or "172.18.0.5, fd00::/8", with "loopback" among them or not: a
//     proxy elsewhere, which names the client in X-Forwarded-For. They never cover this machine itself; that takes
//     "loopback". Any that takes in an address of Cloudflare's is left out (refused): that takes "cloudflare";
//   cloudflare: Cloudflare in front, through cloudflared or straight to Tarsee's port. The client is the
//     CF-Connecting-IP header Cloudflare sets (cloudflareClient), believed from this machine (cloudflared, at
//     loopback's cost), from Cloudflare's published ranges, and from any address or range named beside it (a
//     cloudflared container). X-Forwarded-For is never believed then.
// Behind several X-Forwarded-For proxies, name each: the client is the first address, from the right, that isn't one.
// On Railway the setting is ignored but for cloudflare: the client is the X-Real-IP Railway's edge sets, or, with
// cloudflare, the CF-Connecting-IP Cloudflare set when that X-Real-IP is one of Cloudflare's edges (clientAddress).
//
// Why Cloudflare's addresses can't name the client in X-Forwarded-For: anyone with a Cloudflare account can send
// requests from them. A Worker's request to another account's site arrives from 2a06:98c0:3600::103, inside
// 2a06:98c0::/29, and Cloudflare appends to whatever X-Forwarded-For it carries, so a walk back past Cloudflare's
// addresses ends at one the Worker made up: a new place with each guess. CF-Connecting-IP is Cloudflare's own: on that
// request it is the Worker's address. To a site that isn't on Cloudflare (Tarsee's own address, say) a Worker may
// write any CF-Connecting-IP, but Cloudflare adds CF-Worker, the Worker's zone, to every request a Worker sends, so
// such a request counts as the Worker's address: one place. Cloudflare's docs, "Cloudflare HTTP headers"
// (developers.cloudflare.com/fundamentals/reference/http-headers/), say all three.

// Cloudflare's published ranges, https://www.cloudflare.com/ips/ (ips-v4 and ips-v6), as of November 2026. Cloudflare
// rarely changes them; one added later can be named beside "cloudflare" until this list has it.
export const CLOUDFLARE_RANGES = Object.freeze([
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]);
const CLOUDFLARE_AS_OF = "November 2026";
// CF-Connecting-IP on a Worker's request to another account's site, and what any Worker's request counts as.
const CLOUDFLARE_WORKER = "2a06:98c0:3600::103";
// The place of every Class E address a header named with no IPv6 address beside it (Cloudflare's Pseudo IPv4).
const CLASS_E = "240.0.0.0/4";

/** An address's family for net.BlockList, or null when it isn't an address. */
const familyOf = (a) => (net.isIPv4(a) ? "ipv4" : net.isIPv6(a) ? "ipv6" : null);

let cloudflareRead = null;
/** Cloudflare's ranges: { list (a net.BlockList), starts ([address, family] of each range's first address) }. */
function cloudflareRanges() {
  if (cloudflareRead) return cloudflareRead;
  const list = new net.BlockList();
  const starts = [];
  for (const range of CLOUDFLARE_RANGES) {
    const [addr, bits] = range.split("/");
    list.addSubnet(addr, Number(bits), familyOf(addr));
    starts.push([addr, familyOf(addr)]);
  }
  cloudflareRead = { list, starts };
  return cloudflareRead;
}

/** Whether an address is one of Cloudflare's: in a range it publishes. */
function isCloudflare(addr) {
  const a = plainAddress(addr);
  const family = familyOf(a);
  return !!family && cloudflareRanges().list.check(a, family);
}

/** Whether an entry of TARSEE_TRUSTED_PROXY (an address, or with `bits` a range) takes in any of Cloudflare's addresses. */
function overlapsCloudflare(addr, bits, family) {
  const cf = cloudflareRanges();
  if (cf.list.check(addr, family)) return true;
  if (bits === undefined) return false;
  // Two ranges either don't meet or one holds the other, so one holding a range of Cloudflare's holds its start.
  const entry = new net.BlockList();
  entry.addSubnet(addr, bits, family);
  return cf.starts.some(([start, f]) => f === family && entry.check(start, f));
}

/** A header that names one address, made comparable (plainAddress), else "" (none, several, or not an address). */
function headerAddress(value) {
  if (typeof value !== "string") return "";
  const a = plainAddress(value);
  return net.isIP(a) ? a : "";
}

/** Whether two addresses are the same, however each is written. */
function sameAddress(a, b) {
  const key = (x) => (net.isIPv6(x) ? ipv6Groups(x).join(":") : x);
  return !!a && !!b && key(a) === key(b);
}

/** Whether an address is Class E (240.0.0.0/4): never a real client's, but what Cloudflare's Pseudo IPv4 hands on. */
const isClassE = (a) => net.isIPv4(a) && Number(a.split(".")[0]) >= 240;

/**
 * A client a header named, with Cloudflare's Pseudo IPv4 undone: "Overwrite Headers" puts a Class E address in
 * CF-Connecting-IP and X-Forwarded-For, and the client's real IPv6 address in CF-Connecting-IPv6. That one is taken,
 * so an IPv6 client still counts by its /64, /56 and /48. Only for a Class E address, which only Cloudflare's
 * rewrite puts there: next to a real address, CF-Connecting-IPv6 could be the client's own.
 */
function withRealIPv6(client, req) {
  if (!isClassE(client)) return client;
  const v6 = headerAddress(req.headers?.["cf-connecting-ipv6"]);
  return net.isIPv6(v6) ? v6 : client;
}

let trustRead = { raw: null, trust: null };

/**
 * TARSEE_TRUSTED_PROXY, read: { loopback, cloudflare, list (a net.BlockList), names (what was taken, for the boot
 * log), skipped (what wasn't: not "none", "loopback", "cloudflare", an address or a range; a /0 range, every
 * address, isn't taken either), refused (addresses and ranges left out because they take in Cloudflare's, unless
 * "cloudflare" is there too) }.
 */
export function trustedProxies(raw = process.env.TARSEE_TRUSTED_PROXY) {
  const text = String(raw ?? "").trim();
  if (trustRead.trust && text === trustRead.raw) return trustRead.trust;
  const entries = text.split(/[\s,]+/).filter(Boolean);
  const cloudflare = entries.some((e) => e.toLowerCase() === "cloudflare");
  const trust = { loopback: false, cloudflare, list: new net.BlockList(), names: cloudflare ? ["cloudflare"] : [], skipped: [], refused: [] };
  for (const entry of entries) {
    const word = entry.toLowerCase();
    if (word === "none" || word === "cloudflare") continue;
    if (word === "loopback") {
      // With cloudflare, this machine (cloudflared) may already name the client in CF-Connecting-IP.
      if (!trust.loopback && !cloudflare) trust.names.push("loopback");
      trust.loopback = true;
      continue;
    }
    const [addrPart, bitsPart, extra] = word.split("/");
    const addr = plainAddress(addrPart);
    const family = familyOf(addr);
    if (!family || extra !== undefined) { trust.skipped.push(entry); continue; }
    let bits;
    if (bitsPart !== undefined) {
      bits = /^\d{1,3}$/.test(bitsPart) ? Number(bitsPart) : NaN;
      if (!(bits >= 1 && bits <= (family === "ipv4" ? 32 : 128))) { trust.skipped.push(entry); continue; }
    }
    if (overlapsCloudflare(addr, bits, family)) {
      // With cloudflare, Cloudflare's addresses are taken already, for CF-Connecting-IP only.
      if (!cloudflare) trust.refused.push(entry);
      continue;
    }
    if (bits === undefined) {
      trust.list.addAddress(addr, family);
      trust.names.push(addr);
    } else {
      trust.list.addSubnet(addr, bits, family);
      trust.names.push(`${addr}/${bits}`);
    }
  }
  trustRead = { raw: text, trust };
  return trust;
}

/** Whether a connection from `addr` is a proxy the owner named, and so may name the client in X-Forwarded-For. */
function isTrustedProxy(addr, trust = trustedProxies()) {
  if (trust.cloudflare) return false; // X-Forwarded-For is never believed then
  const a = plainAddress(addr);
  if (!net.isIP(a)) return false;
  if (isThisMachine(a)) return trust.loopback;
  return trust.list.check(a, familyOf(a));
}

/** With cloudflare: whether a connection from `addr` may hand on Cloudflare's CF-Connecting-IP. */
function handsOnCloudflare(addr, trust = trustedProxies()) {
  const a = plainAddress(addr);
  if (!net.isIP(a)) return false;
  return isThisMachine(a) || isCloudflare(a) || trust.list.check(a, familyOf(a));
}

/**
 * Whether a proxy between Cloudflare and Tarsee (cloudflared, or nginx behind Cloudflare) heard the request from
 * Cloudflare, by the last address of its X-Forwarded-For. A proxy that appends there (nginx's
 * $proxy_add_x_forwarded_for) appends who it heard from: one of Cloudflare's edges. From cloudflared, the last is the
 * client Cloudflare appended, the one CF-Connecting-IP (or, with Pseudo IPv4, CF-Connecting-IPv6) names. Anything
 * else came to that proxy from outside Cloudflare, with a CF-Connecting-IP of the sender's own. With no
 * X-Forwarded-For there is nothing to tell by, and it is believed.
 */
function heardFromCloudflare(req, named) {
  const xff = req.headers?.["x-forwarded-for"];
  if (xff === undefined) return true;
  const last = plainAddress(String(xff).split(",").at(-1));
  if (!net.isIP(last)) return false;
  return isCloudflare(last) || sameAddress(last, named) || sameAddress(last, headerAddress(req.headers?.["cf-connecting-ipv6"]));
}

/**
 * The client of a request Cloudflare handed on, reaching Tarsee from `from`: one of Cloudflare's edges, or, when
 * `between`, a proxy between Cloudflare and Tarsee (cloudflared, or nginx behind Cloudflare).
 * - A Worker's request (CF-Worker) is the Worker's address, whatever else it says: to a site outside Cloudflare a
 *   Worker writes CF-Connecting-IP itself.
 * - Otherwise the address CF-Connecting-IP names, with Pseudo IPv4 undone (withRealIPv6). Without one, it is `from`.
 * - Through a proxy between that heard it from outside Cloudflare (heardFromCloudflare), it is `from`.
 */
function cloudflareClient(req, from, between) {
  if (req.headers?.["cf-worker"] !== undefined) return CLOUDFLARE_WORKER;
  const named = headerAddress(req.headers?.["cf-connecting-ip"]);
  if (!named) return from;
  if (between && !heardFromCloudflare(req, named)) return from;
  return withRealIPv6(named, req);
}

/**
 * Express's "trust proxy" (server.js), so req.ip off Railway is the client clientAddress names: X-Forwarded-For is
 * believed only from a proxy TARSEE_TRUSTED_PROXY names, and never with cloudflare (sessionAuth then sets req.ip from
 * CF-Connecting-IP). On Railway it is believed from the one hop in front that isn't this machine (the edge), as
 * before; sign-ins there go by X-Real-IP instead.
 */
export function trustProxyHop(addr, hop) {
  if (!plainAddress(addr)) return false;
  if (onRailway()) return hop === 0 && !isThisMachine(addr);
  return isTrustedProxy(addr);
}

/**
 * Who a request comes from: { client, peer }. peer is the address it reached Tarsee from (on Railway, the X-Real-IP
 * Railway's edge sets); client differs only when a header Tarsee believes named someone else.
 */
function whoSent(req) {
  const peer = plainAddress(req?.socket?.remoteAddress);
  if (!peer) return { client: "", peer: "" };
  const trust = trustedProxies();
  if (onRailway()) {
    if (isThisMachine(peer)) return { client: peer, peer };
    const real = headerAddress(req.headers?.["x-real-ip"]);
    if (!real) return { client: peer, peer };
    if (trust.cloudflare && isCloudflare(real)) return { client: cloudflareClient(req, real, false), peer: real };
    return { client: real, peer: real };
  }
  if (trust.cloudflare) {
    if (!handsOnCloudflare(peer, trust)) return { client: peer, peer };
    return { client: cloudflareClient(req, peer, !isCloudflare(peer)), peer };
  }
  let client = peer;
  for (const hop of String(req.headers?.["x-forwarded-for"] ?? "").split(",").reverse()) {
    if (!isTrustedProxy(client, trust)) break;
    const next = plainAddress(hop);
    if (!net.isIP(next)) break;
    client = next;
  }
  // cloudflared in front, with TARSEE_TRUSTED_PROXY=loopback: Pseudo IPv4 is undone here too.
  return { client: client === peer ? client : withRealIPv6(client, req), peer };
}

/**
 * The client's address, as the sign-in limit, the Terminal's log and the sign-in log name it. Works on any request,
 * an Express one or a WebSocket upgrade's:
 * - on Railway: the X-Real-IP header Railway's edge sets, unless the connection comes from this machine (then that).
 *   Railway's docs (Networking > Public Networking > Specs & Limits) say only that X-Real-IP identifies the client's
 *   address. That the edge replaces any copy the client sent comes from Railway's community forum, Central Station:
 *   in "Edge Proxy X-Forwarded-For and X-Real-Ip can't be trusted" (station.railway.com/questions/
 *   edge-proxy-x-forwarded-for-and-x-real-ip-c5a50049, August 2024) a client's own X-Real-IP got through, a Railway
 *   employee called it a bug and then said "the client can no longer set the X-Real-Ip header", and in 2026 a
 *   moderator wrote that X-Real-IP is overwritten at the edge. It hasn't been checked on a live deploy. X-Forwarded-For
 *   there can end with an address of Railway's own network, which many clients share, so it can't tell clients apart.
 *   A request that skips the edge (Railway's private network from another of the owner's services, or a TCP proxy)
 *   could write its own X-Real-IP: the limit for all places together still holds it. With cloudflare, when X-Real-IP
 *   is one of Cloudflare's edges, the client Cloudflare names (cloudflareClient);
 * - with cloudflare: the client Cloudflare names, from this machine, Cloudflare's ranges or an address named beside
 *   it; from anywhere else, the connection's own address;
 * - elsewhere: the connection's own address, walked back through X-Forwarded-For only past proxies
 *   TARSEE_TRUSTED_PROXY names.
 */
export function clientAddress(req) {
  return whoSent(req).client;
}

/** An IPv6 address's eight 16-bit groups, as numbers (an IPv4 address at its end, as in ::ffff:1.2.3.4, is two). */
function ipv6Groups(a) {
  let s = a;
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [b1, b2, b3, b4] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((b1 << 8) | b2).toString(16)}:${((b3 << 8) | b4).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return groups.map((g) => parseInt(g, 16) || 0);
}

/** The block of `bits` (48, 56 or 64) that IPv6 groups are in, as "2001:db8:5:6::/64", "2001:db8:5:0::/56" or "2001:db8:5::/48". */
function ipv6Block(groups, bits) {
  const kept = groups.slice(0, Math.ceil(bits / 16));
  if (bits % 16) kept[kept.length - 1] &= (0xffff << (16 - (bits % 16))) & 0xffff;
  return `${kept.map((g) => g.toString(16)).join(":")}::/${bits}`;
}

const clientKey = (a) => (net.isIPv6(a) ? ipv6Block(ipv6Groups(a), 64) : a);

/**
 * The place a sign-in comes from, which its wrong guesses count against, and which the logs name: the client's
 * address (clientAddress), or "this machine" for any of this machine's own addresses (any 127.x.x.x can be used, so
 * they are one place). An IPv6 client is its /64, so one server can't make new budgets from its spare addresses; its
 * /56 and /48 count too (placeLevels).
 */
export function signInKey(req) {
  const { client, peer } = whoSent(req);
  if (!client) return NO_ADDRESS;
  if (isThisMachine(client)) return THIS_MACHINE;
  // A Class E address a header named with no IPv6 address beside it (withRealIPv6): Cloudflare's stand-in for an
  // IPv6 client whose network can't be told, so they are all one place.
  if (client !== peer && isClassE(client)) return CLASS_E;
  return clientKey(client);
}

/**
 * The places a sign-in from `key` (signInKey) counts against: the place itself, and for an IPv6 /64 its /56 and /48
 * too, the blocks one home and one tunnel are given. Each has a place's budget, so a home or a tunnel gets no more
 * than one place does, of its own wrong guesses or of the count for everyone. The widest comes last.
 */
export function placeLevels(key) {
  if (typeof key !== "string" || !key.endsWith("::/64")) return [key];
  const groups = ipv6Groups(key.slice(0, -3));
  return [key, ipv6Block(groups, 56), ipv6Block(groups, 48)];
}

// All places together (2 above).
const EVERYONE_WRONG_GUESSES = 30;
const EVERYONE_WINDOW_MS = 10 * 60_000;
// The most any one place (an IPv6 client's /48, the widest of placeLevels) adds to it in that window: what one place's
// own waits let it make in 10 minutes. Its waits already hold it to that; this holds it too while a right password
// keeps clearing them.
const EVERYONE_PER_PLACE = 8;
const EVERYONE_FIRST_PAUSE_MS = 15 * 60_000;
const EVERYONE_LONGEST_PAUSE_MS = 4 * 60 * 60_000;
const EVERYONE_CALM_MS = 24 * 60 * 60_000;
// wrong: the recent wrong guesses, each [when, the widest place it came from].
const everyone = { wrong: [], pausedUntil: 0, pauses: 0 };

// --- The counts, kept in tarsee.db ---
//   sign_in_places: each place's wrong guesses, when the last one was, and until when it waits (an IPv6 client has a
//     row for its /64, one for its /56 and one for its /48);
//   sign_in_pause: one row, the pause for everyone: the recent wrong guesses (JSON), until when, how many.
// Once the AI runs as its own OS user it can't write tarsee.db, so it can't wipe them either. It still shares the
// volume, so it could fill it: then no write goes through, and new sign-ins are turned away until one does.
//   wired: initSignInLimits has been given the database (server.js always does; a test that never does keeps the
//     counts in memory only);
//   ready: the tables are there and the counts have been read back. Until then sign-ins are turned away, and each try
//     (and the sweep) tries again;
//   failing: the last write failed (said once in the log, and again once one goes through);
//   pending, pausePending: rows a failed write left out, written with the next write that goes through.
const store = { db: null, wired: false, ready: false, failing: false, pending: new Set(), pausePending: false };
// How long a sign-in turned away because its count can't be saved is told to wait (Retry-After).
const UNRECORDED_RETRY_MS = 60_000;

/** Whether a place has nothing left to remember: no wait on, and no wrong guess within the last day. */
function placeForgotten(entry, now) {
  const waiting = entry.lockedUntil && now < entry.lockedUntil;
  const remembered = entry.failures > 0 && now - entry.lastFailureAt < FAILURE_MEMORY_MS;
  return !waiting && !remembered;
}

/** Called by initSessionStore at boot: makes the two tables and reads the counts back into memory (openStore). */
function initSignInLimits(db) {
  Object.assign(store, { db, wired: true, ready: false, failing: false, pausePending: false });
  store.pending.clear();
  authAttempts.clear();
  Object.assign(everyone, { wrong: [], pausedUntil: 0, pauses: 0 });
  if (!openStore()) return;
  const now = Date.now();
  forgetStoredPlaces(now);
  const places = [...authAttempts.values()].filter((e) => !placeForgotten(e, now)).length;
  const paused = now < everyone.pausedUntil ? `; signing in is paused for everyone for ${inWords(Math.ceil((everyone.pausedUntil - now) / 1000))} more` : "";
  if (places || paused) console.log(`[auth] sign-in limits read back: ${places} place(s) with wrong passwords${paused}`);
}

/**
 * Makes the two tables, if they aren't there, and reads the counts back into memory, once: true when that is done
 * (or no database was ever given). Until it is, sign-ins are turned away, since the counts on disk aren't known.
 */
function openStore() {
  if (!store.wired || store.ready) return true;
  const { db } = store;
  const now = Date.now();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sign_in_places (
      place TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      last_failure_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS sign_in_pause (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      wrong TEXT NOT NULL,
      paused_until INTEGER NOT NULL,
      pauses INTEGER NOT NULL
    )`);
    const places = new Map();
    for (const r of db.prepare("SELECT place, failures, last_failure_at, locked_until FROM sign_in_places").all()) {
      const entry = { count: 0, resetAt: 0, failures: Number(r.failures) || 0, lastFailureAt: Number(r.last_failure_at) || 0, lockedUntil: Number(r.locked_until) || 0 };
      if (!placeForgotten(entry, now)) places.set(r.place, entry);
    }
    const p = db.prepare("SELECT wrong, paused_until, pauses FROM sign_in_pause WHERE id = 1").get();
    authAttempts.clear();
    for (const [place, entry] of places) authAttempts.set(place, entry);
    Object.assign(everyone, { wrong: [], pausedUntil: 0, pauses: 0 });
    if (p) {
      let wrong = [];
      try { wrong = JSON.parse(p.wrong); } catch { /* unreadable: no recent wrong guesses */ }
      // Each [when, place]; a Tarsee before it kept only the times.
      everyone.wrong = (Array.isArray(wrong) ? wrong : [])
        .map((w) => (Array.isArray(w) ? [Number(w[0]), typeof w[1] === "string" ? w[1] : null] : [Number(w), null]))
        .filter(([t]) => Number.isFinite(t) && now - t < EVERYONE_WINDOW_MS);
      everyone.pausedUntil = Number(p.paused_until) || 0;
      everyone.pauses = Number(p.pauses) || 0;
    }
  } catch (err) {
    storeFailing(err);
    return false;
  }
  store.ready = true;
  return true;
}

/** Says once, when it starts, that the counts can't be saved, and so new sign-ins are turned away. */
function storeFailing(err) {
  if (store.failing) return;
  store.failing = true;
  console.error(`[auth] Tarsee can't record sign-in attempts in its database (${err.message}), so new sign-ins are paused until it can. Anyone already signed in stays signed in. Free some space on the volume, and sign-ins open again by themselves.`);
}

/** Says once that the counts are being saved again. */
function storeWorking() {
  if (!store.failing) return;
  store.failing = false;
  console.log("[auth] Sign-in attempts are recorded again, so new sign-ins are open again.");
}

/**
 * Writes the rows of `places` as memory has them now, the pause for everyone with them when `withPause`, and whatever
 * a failed write left out (pending), all in one transaction: true once it went through, or when there is no database.
 */
function saveLimits(places, withPause) {
  if (!store.wired) return true;
  if (!store.ready) return false;
  const keys = new Set([...store.pending, ...places]);
  const pause = withPause || store.pausePending;
  try {
    const { db } = store;
    db.transaction(() => {
      const now = Date.now();
      const drop = db.prepare("DELETE FROM sign_in_places WHERE place = ?");
      const keep = db.prepare("INSERT OR REPLACE INTO sign_in_places (place, failures, last_failure_at, locked_until) VALUES (?, ?, ?, ?)");
      for (const key of keys) {
        const entry = authAttempts.get(key);
        if (!entry || placeForgotten(entry, now)) drop.run(key);
        else keep.run(key, entry.failures, entry.lastFailureAt, entry.lockedUntil);
      }
      if (pause) {
        db.prepare("INSERT OR REPLACE INTO sign_in_pause (id, wrong, paused_until, pauses) VALUES (1, ?, ?, ?)")
          .run(JSON.stringify(everyone.wrong), everyone.pausedUntil, everyone.pauses);
      }
    })();
  } catch (err) {
    storeFailing(err);
    return false;
  }
  store.pending.clear();
  store.pausePending = false;
  storeWorking();
  return true;
}

/** Writes what a failed write left out (the sweep). */
function savePending() {
  if (store.pending.size || store.pausePending) saveLimits([], false);
}

/** Drops the stored places with nothing left to remember (the sweep, and boot). Not saving that changes nothing. */
function forgetStoredPlaces(now) {
  if (!store.wired || !store.ready) return;
  try {
    store.db.prepare("DELETE FROM sign_in_places WHERE locked_until <= ? AND last_failure_at <= ?").run(now, now - FAILURE_MEMORY_MS);
  } catch (err) {
    storeFailing(err);
  }
}

/** A wait in words: "45 seconds", "15 minutes", "about 4 hours". */
function inWords(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `about ${Math.round(minutes / 60)} hours`;
}

function refuse(res, untilMs, now, error) {
  const retryAfter = Math.max(1, Math.ceil((untilMs - now) / 1000));
  res.set("Retry-After", String(retryAfter));
  return res.status(429).json({ error: error(inWords(retryAfter)) });
}

/** Turns a sign-in away because its try can't be counted in tarsee.db (a full disk, a locked database). */
export function refuseUnrecorded(res) {
  const now = Date.now();
  return refuse(res, now + UNRECORDED_RETRY_MS, now, (wait) =>
    `Tarsee can't record sign-in attempts right now (is the disk full?), so new sign-ins are paused. Anyone already signed in stays signed in. Try again in ${wait}.`);
}

// What noteUntrustedProxy has said already: each once.
const noted = { xff: false, cloudflare: false, unset: false, outside: false };
/**
 * Says once, in the log, when a sign-in carries a header naming its client that Tarsee doesn't believe, so the owner
 * can set TARSEE_TRUSTED_PROXY: behind a proxy the owner hasn't named, every client shares the proxy's one budget.
 * `key` is the place it was counted as (signInKey).
 */
function noteUntrustedProxy(req, key) {
  if (onRailway()) return;
  const peer = plainAddress(req.socket?.remoteAddress);
  if (!peer) return;
  const who = isThisMachine(peer) ? "this machine" : peer;
  const headers = req.headers || {};
  const named = headerAddress(headers["cf-connecting-ip"]);
  const trust = trustedProxies();
  if (trust.cloudflare) {
    if (!named || headers["cf-worker"] !== undefined) return;
    if (!handsOnCloudflare(peer, trust)) {
      if (noted.cloudflare) return;
      noted.cloudflare = true;
      console.warn(`[auth] A sign-in carried CF-Connecting-IP from ${peer}, which is neither one of Cloudflare's addresses, nor this machine, nor named in TARSEE_TRUSTED_PROXY, so it was counted as ${peer} itself. If a cloudflared of yours runs there (a container), name it beside cloudflare: TARSEE_TRUSTED_PROXY=cloudflare, ${peer}.`);
    } else if (!isCloudflare(peer) && !heardFromCloudflare(req, named) && !noted.outside) {
      noted.outside = true;
      const last = plainAddress(String(headers["x-forwarded-for"]).split(",").at(-1)) || "something that isn't an address";
      console.warn(`[auth] A sign-in came through the proxy at ${who}, which heard it from ${last}, not from Cloudflare, so its CF-Connecting-IP was not believed and it was counted as ${who}. Let only Cloudflare reach that proxy (Cloudflare's ranges are at https://www.cloudflare.com/ips/), or use cloudflared.`);
    }
    return;
  }
  if (named && !noted.unset) {
    noted.unset = true;
    console.warn(`[auth] A sign-in carried Cloudflare's CF-Connecting-IP header (from ${who}), which Tarsee believes only with TARSEE_TRUSTED_PROXY=cloudflare, so it was counted as ${key}. If Cloudflare is in front of Tarsee, set TARSEE_TRUSTED_PROXY=cloudflare so each client is limited on its own.`);
    return;
  }
  if (noted.xff || !headers["x-forwarded-for"] || isTrustedProxy(peer, trust)) return;
  noted.xff = true;
  console.warn(`[auth] A sign-in carried X-Forwarded-For from ${who}, which TARSEE_TRUSTED_PROXY doesn't name, so it was counted as ${who} itself. If a proxy of yours is in front of Tarsee, name it in TARSEE_TRUSTED_PROXY ("loopback" for one on this machine, "cloudflare" for Cloudflare) so each client behind it is limited on its own.`);
}

/** A place's entry in memory, made when it has none. */
function placeEntry(key, now) {
  let entry = authAttempts.get(key);
  if (!entry) {
    entry = { count: 0, resetAt: now + 60_000, failures: 0, lockedUntil: 0, lastFailureAt: 0 };
    authAttempts.set(key, entry);
  }
  return entry;
}

/**
 * Middleware on POST /api/auth/login: turns a sign-in away while the counts can't be read (openStore), while signing
 * in is paused for everyone, or while its place, or for IPv6 its /56 or /48, is waiting; and counts its try. The place
 * goes on req.signInKey, for startSignInAttempt.
 */
export function rateLimitAuth(req, res, next) {
  const key = signInKey(req);
  req.signInKey = key;
  const now = Date.now();
  noteUntrustedProxy(req, key);

  if (!openStore()) return refuseUnrecorded(res);

  if (now < everyone.pausedUntil) {
    return refuse(res, everyone.pausedUntil, now, (wait) =>
      `Too many wrong passwords have been tried here from different places, so signing in is paused for everyone for ${wait}. Anyone already signed in stays signed in.`);
  }

  const entries = placeLevels(key).map((k) => placeEntry(k, now));
  let longest = -1;
  entries.forEach((e, i) => {
    if (e.lockedUntil > now && (longest < 0 || e.lockedUntil > entries[longest].lockedUntil)) longest = i;
  });
  if (longest >= 0) {
    const from = longest === 0 ? "from here" : "from your network";
    return refuse(res, entries[longest].lockedUntil, now, (wait) => `Too many wrong passwords ${from}. Try again in ${wait}.`);
  }

  // At most 5 tries a minute, from the place and from each of its wider networks.
  for (const e of entries) {
    if (now >= e.resetAt) {
      e.count = 0;
      e.resetAt = now + 60_000;
    }
  }
  const full = entries.filter((e) => e.count >= 5);
  if (full.length) {
    return refuse(res, Math.max(...full.map((e) => e.resetAt)), now, (wait) => `Too many tries from here. Try again in ${wait}.`);
  }

  for (const e of entries) e.count++;
  next();
}

/** A place's wait after its n-th wrong guess in a row, in ms (0: none yet). */
function waitAfter(failures) {
  if (failures >= 10) return 60 * 60_000;
  if (failures >= 8) return 10 * 60_000;
  if (failures >= 6) return 2 * 60_000;
  if (failures >= 4) return 30_000;
  return 0;
}

/**
 * Counts a try from `key` (signInKey) as a wrong password, against the place and its wider networks (placeLevels) and
 * against all places together, and saves that to tarsee.db, before its password is checked. Returns null when it
 * can't be saved: the try must then be turned away unchecked (refuseUnrecorded), so no guess is checked on a count a
 * restart would forget. Otherwise it returns { wrong, right }, and the caller says which, at once:
 *   wrong(): it was a wrong password. Nothing more to save. Returns how long signing in is now paused for everyone, in
 *     ms, when this one starts that pause, else 0;
 *   right(): it was the right password. The count is taken back, and the place's wrong guesses are cleared (for IPv6
 *     its /56's and /48's too); all places' count keeps the others' wrong guesses. If that can't be saved, the database
 *     holds one wrong guess too many until the next write goes through: never fewer.
 */
export function startSignInAttempt(key) {
  if (!openStore()) return null;
  const now = Date.now();
  const levels = placeLevels(key);
  const entries = levels.map((k) => placeEntry(k, now));
  const before = entries.map((e) => ({ failures: e.failures, lastFailureAt: e.lastFailureAt, lockedUntil: e.lockedUntil }));
  const beforeEveryone = { wrong: everyone.wrong, pausedUntil: everyone.pausedUntil, pauses: everyone.pauses };

  for (const e of entries) {
    e.failures++;
    e.lastFailureAt = now;
    const wait = waitAfter(e.failures);
    if (wait) e.lockedUntil = now + wait;
  }
  const widest = levels.at(-1);
  const recent = everyone.wrong.filter(([t]) => now - t < EVERYONE_WINDOW_MS);
  if (recent.filter(([, from]) => from === widest).length < EVERYONE_PER_PLACE) recent.push([now, widest]);
  everyone.wrong = recent;
  let pause = 0;
  if (everyone.wrong.length >= EVERYONE_WRONG_GUESSES) {
    if (now - everyone.pausedUntil >= EVERYONE_CALM_MS) everyone.pauses = 0;
    everyone.pauses++;
    pause = Math.min(EVERYONE_FIRST_PAUSE_MS * 2 ** (everyone.pauses - 1), EVERYONE_LONGEST_PAUSE_MS);
    everyone.pausedUntil = now + pause;
    everyone.wrong = [];
  }

  if (!saveLimits(levels, true)) {
    entries.forEach((e, i) => Object.assign(e, before[i]));
    Object.assign(everyone, beforeEveryone);
    return null;
  }

  let settled = false;
  return {
    wrong() {
      settled = true;
      return pause;
    },
    right() {
      if (settled) return;
      settled = true;
      Object.assign(everyone, beforeEveryone);
      for (const e of entries) { e.failures = 0; e.lockedUntil = 0; }
      if (!saveLimits(levels, true)) {
        for (const k of levels) store.pending.add(k);
        store.pausePending = true;
      }
    },
  };
}

/**
 * Counts a wrong password from `key` (signInKey), as startSignInAttempt and its wrong() do. Returns how long signing
 * in is now paused for everyone, in ms, when this one starts that pause, else 0 (also when it couldn't be saved).
 */
export function recordFailedAttempt(key) {
  const attempt = startSignInAttempt(key);
  return attempt ? attempt.wrong() : 0;
}

/**
 * What Tarsee says about signing in as it starts (server.js logs each, so they show in the dashboard's Console too):
 * a SETUP_PASSWORD shorter than 12 characters, and which proxy, if any, may name the client (TARSEE_TRUSTED_PROXY).
 * Returns [{ level: "warn" | "log", text }]. Never says the password.
 */
export function signInBootNotes({ password = config.SETUP_PASSWORD, env = process.env } = {}) {
  const notes = [];
  const length = password ? [...String(password)].length : 0;
  if (length && length < 12) {
    notes.push({
      level: "warn",
      text: `[auth] WARNING: SETUP_PASSWORD is only ${length} characters. The sign-in limits slow guessing down, but places guessing together still get about 180 tries a day, so a 4-digit PIN can be found in about a month. Use 12 or more characters (on a phone, the PIN pad's "Use password instead" takes a longer one).`,
    });
  }
  const raw = String(env.TARSEE_TRUSTED_PROXY ?? "").trim();
  const trust = trustedProxies(raw);
  const ranges = `Cloudflare's published ranges (built in, as of ${CLOUDFLARE_AS_OF}; https://www.cloudflare.com/ips/)`;
  if (env.RAILWAY_PROJECT_ID) {
    if (trust.cloudflare) {
      notes.push({ level: "log", text: `[auth] Each sign-in's place is the X-Real-IP header Railway's edge sets, or, when that is one of ${ranges}, the CF-Connecting-IP header Cloudflare sets (TARSEE_TRUSTED_PROXY=cloudflare). Every request a Cloudflare Worker sends counts as one place.` });
      const rest = trust.names.length > 1 || trust.loopback || trust.skipped.length || trust.refused.length;
      if (rest) notes.push({ level: "log", text: "[auth] On Railway, the rest of TARSEE_TRUSTED_PROXY is ignored: only cloudflare is used there." });
    } else if (raw) {
      notes.push({ level: "log", text: "[auth] TARSEE_TRUSTED_PROXY is ignored on Railway (but for cloudflare): each sign-in's place is the X-Real-IP header Railway's edge sets." });
    }
    return notes;
  }
  if (trust.skipped.length) {
    notes.push({ level: "warn", text: `[auth] TARSEE_TRUSTED_PROXY: skipped ${trust.skipped.join(", ")}. Each entry is "none", "loopback", "cloudflare", an address (10.0.0.2) or a range (172.18.0.0/16, fd00::/8).` });
  }
  if (trust.refused.length) {
    notes.push({ level: "warn", text: `[auth] TARSEE_TRUSTED_PROXY: left out ${trust.refused.join(", ")}, which take${trust.refused.length === 1 ? "s" : ""} in Cloudflare's addresses. Anyone with a Cloudflare account can send requests from them (a Worker) with any X-Forwarded-For, so they can't name the client: a client through Cloudflare counts as the Cloudflare address it came from. For Cloudflare in front of Tarsee, set TARSEE_TRUSTED_PROXY=cloudflare instead: it takes each client from the CF-Connecting-IP header Cloudflare sets.` });
  }
  if (trust.cloudflare) {
    const named = trust.names.filter((n) => n !== "cloudflare");
    notes.push({ level: "log", text: `[auth] Sign-in limits take each client from the CF-Connecting-IP header Cloudflare sets (TARSEE_TRUSTED_PROXY=cloudflare), believed from this machine (cloudflared), from ${ranges}${named.length ? ` and from ${named.join(", ")}` : ""}. X-Forwarded-For is never believed, and every request a Cloudflare Worker sends counts as one place.` });
    notes.push({ level: "warn", text: "[auth] With TARSEE_TRUSTED_PROXY=cloudflare, anything running on this machine, the AI's shell included, can name any client in CF-Connecting-IP: only the limit for all places together holds it, and it can pause signing in for everyone." });
    return notes;
  }
  if (!trust.names.length) {
    notes.push({ level: "log", text: "[auth] Sign-in limits count each connection's own address; X-Forwarded-For is believed from no proxy. Behind a proxy of your own, name it in TARSEE_TRUSTED_PROXY (\"cloudflare\" for Cloudflare), or every client behind it shares one budget." });
    return notes;
  }
  const named = trust.names.filter((n) => n !== "loopback");
  const parts = [trust.loopback ? "a proxy on this machine (loopback)" : "", named.length ? named.join(", ") : ""].filter(Boolean);
  notes.push({ level: "log", text: `[auth] Sign-in limits believe X-Forwarded-For from ${parts.join(" and ")} (TARSEE_TRUSTED_PROXY).` });
  if (trust.loopback) {
    notes.push({ level: "warn", text: "[auth] With TARSEE_TRUSTED_PROXY=loopback, anything running on this machine, the AI's shell included, can name any client in X-Forwarded-For: only the limit for all places together holds it, and it can pause signing in for everyone." });
  }
  return notes;
}

/** Forgets every place's tries and any pause for everyone (tests), in memory and in the database. */
export function __resetSignInLimitsForTests() {
  authAttempts.clear();
  everyone.wrong = [];
  everyone.pausedUntil = 0;
  everyone.pauses = 0;
  ownAddresses = { at: -Infinity, set: new Set() };
  trustRead = { raw: null, trust: null };
  for (const k of Object.keys(noted)) noted[k] = false;
  store.failing = false;
  store.pending.clear();
  store.pausePending = false;
  try {
    if (store.ready) store.db?.exec("DELETE FROM sign_in_places; DELETE FROM sign_in_pause;");
  } catch { /* closed */ }
}
