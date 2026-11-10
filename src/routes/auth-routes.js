import { Router } from "express";
import { validatePassword, createSession, destroySession, recordFailedAttempt, clearFailedAttempts, requireAuth, sessionCookieMaxAgeMs, rateLimitAuth, liveSessionId, signInKey } from "../middleware/auth.js";
import { generateCsrfCookie } from "../middleware/security.js";
import config from "../config/env.js";

export const authRouter = Router();

/**
 * The sign-in's cookie. The browser keeps it past the sign-in itself (sessionCookieMaxAgeMs), so a tab left open
 * after the sign-in ran out still sends it, and an owner-only action it asks for is told "your sign-in has run out"
 * (middleware/auth.js signInEnded) rather than refused in the words meant for the API token the page sends too.
 */
function setSessionCookie(res, sessionId) {
  res.cookie("tarsee_session", sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    secure: config.NODE_ENV === "production",
    maxAge: sessionCookieMaxAgeMs(),
    path: "/",
  });
}

/**
 * POST /api/auth/login
 * Body: { password: string }
 * Returns session cookie on success.
 */
// rateLimitAuth sits on THIS route only. Mounted on the whole router it also
// throttled GET /status, which the web UI polls, so normal use burned the
// 5-per-minute budget and locked people out of their own login.
authRouter.post("/login", rateLimitAuth, (req, res) => {
  const { password } = req.body || {};

  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Password is required" });
  }

  if (!config.SETUP_PASSWORD) {
    return res.status(500).json({ error: "SETUP_PASSWORD not configured. Set it in environment variables." });
  }

  // Where the sign-in comes from, as rateLimitAuth counted it: never a client named in a header by this machine itself,
  // nor by a proxy TARSEE_TRUSTED_PROXY doesn't name. The log names the same place.
  const place = req.signInKey ?? signInKey(req);

  if (!validatePassword(password)) {
    const auditLog = req.app.get("auditLog");
    auditLog?.log({ action: "auth.login_failed", actor: "user", ip: place });
    const pausedMs = recordFailedAttempt(place);
    if (pausedMs) {
      const minutes = Math.round(pausedMs / 60_000);
      auditLog?.log({ action: "auth.login_paused", actor: "system", ip: place, detail: `Too many wrong passwords from different places: signing in is paused for everyone for ${minutes} minutes` });
      console.warn(`[auth] Too many wrong passwords from different places: signing in is paused for everyone for ${minutes} minutes.`);
    }
    return res.status(401).json({ error: "Invalid password" });
  }

  // Successful login — clear lockout
  clearFailedAttempts(place);
  const sessionId = createSession(req.ip || req.socket?.remoteAddress);
  const auditLog = req.app.get("auditLog");
  auditLog?.log({ action: "auth.login", actor: "user", ip: place });

  setSessionCookie(res, sessionId);

  // Do NOT return the API token here — fetch it separately via /api/auth/api-token
  // (session-authenticated) so it doesn't end up in access logs or browser history.
  res.json({ ok: true });
});

/**
 * GET /api/auth/api-token
 * Returns the API token for the authenticated session (used by WebSocket + external clients).
 * Requires an active session — the token is never returned in the login response body.
 */
authRouter.get("/api-token", requireAuth, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ apiToken: config.API_TOKEN });
});

/**
 * POST /api/auth/logout
 * Ends this device's sign-in: the one its cookie names, also when the API token comes with it (the dashboard sends
 * both, and sessionAuth then names the request by the token, without the sign-in's id).
 */
authRouter.post("/logout", (req, res) => {
  const sessionId = req.auth?.sessionId || liveSessionId(req);
  if (sessionId) {
    destroySession(sessionId);
  }
  res.clearCookie("tarsee_session", { path: "/" });
  res.json({ ok: true });
});

/**
 * GET /api/auth/status
 * Returns current auth status (no password needed).
 */
/**
 * GET /api/auth/csrf: a fresh CSRF cookie. The cookie is otherwise only set on
 * page loads, so a tab left open past the token's lifetime asks for a new one
 * (js/api.js refreshCsrf) instead of failing every send with "CSRF token
 * missing". Safe to hand out: the cookie is SameSite=Strict, and only this
 * site's pages can read it to send it back.
 */
authRouter.get("/csrf", (req, res) => {
  generateCsrfCookie(req, res, () => { res.set("Cache-Control", "no-store"); res.json({ ok: true }); });
});

authRouter.get("/status", (req, res) => {
  // The dashboard asks this first as it opens. A live sign-in's cookie is set again with the lifetime it has now, so a
  // cookie from before the browser kept it past the sign-in gets that too.
  if (req.auth?.method === "session" && req.auth.sessionId) setSessionCookie(res, req.auth.sessionId);
  res.json({
    authenticated: req.auth?.authenticated || false,
    method: req.auth?.method || null,
    needsPassword: !!config.SETUP_PASSWORD,
  });
});
