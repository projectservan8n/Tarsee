import { Router } from "express";
import { validatePassword, createSession, destroySession, recordFailedAttempt, clearFailedAttempts, requireAuth, sessionMaxAgeMs, rateLimitAuth } from "../middleware/auth.js";
import config from "../config/env.js";

export const authRouter = Router();

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

  if (!validatePassword(password)) {
    const auditLog = req.app.get("auditLog");
    auditLog?.log({ action: "auth.login_failed", actor: "user", ip: req.ip });
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "Invalid password" });
  }

  // Successful login — clear lockout
  clearFailedAttempts(req.ip);
  const sessionId = createSession(req.ip || req.socket?.remoteAddress);
  const auditLog = req.app.get("auditLog");
  auditLog?.log({ action: "auth.login", actor: "user", ip: req.ip });

  res.cookie("tarsee_session", sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    secure: config.NODE_ENV === "production",
    maxAge: sessionMaxAgeMs(), // kept in lockstep with the server-side session
    path: "/",
  });

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
 */
authRouter.post("/logout", (req, res) => {
  if (req.auth?.sessionId) {
    destroySession(req.auth.sessionId);
  }
  res.clearCookie("tarsee_session", { path: "/" });
  res.json({ ok: true });
});

/**
 * GET /api/auth/status
 * Returns current auth status (no password needed).
 */
authRouter.get("/status", (req, res) => {
  res.json({
    authenticated: req.auth?.authenticated || false,
    method: req.auth?.method || null,
    needsPassword: !!config.SETUP_PASSWORD,
  });
});
