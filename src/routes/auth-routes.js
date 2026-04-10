import { Router } from "express";
import { validatePassword, createSession, destroySession } from "../middleware/auth.js";
import config from "../config/env.js";

export const authRouter = Router();

/**
 * POST /api/auth/login
 * Body: { password: string }
 * Returns session cookie on success.
 */
authRouter.post("/login", (req, res) => {
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
    return res.status(401).json({ error: "Invalid password" });
  }

  const sessionId = createSession(req.ip || req.socket?.remoteAddress);
  const auditLog = req.app.get("auditLog");
  auditLog?.log({ action: "auth.login", actor: "user", ip: req.ip });

  res.cookie("tarsee_session", sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    secure: config.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: "/",
  });

  res.json({
    ok: true,
    apiToken: config.API_TOKEN, // Return API token for WebSocket/external use
  });
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
