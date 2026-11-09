import { Router } from "express";
import config from "../config/env.js";
import { getErrorSummary } from "../lib/self-heal.js";

export const healthRouter = Router();

/** Basic health check — fast, for load balancers. */
healthRouter.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "tarsee",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    stateDir: config.STATE_DIR,
    volumeMounted: config.STATE_DIR.startsWith("/data"),
  });
});

/**
 * Deep health check — runs diagnostics. 503 while any check fails, the default AI not being ready among them
 * (self-heal.js checkProvider, from providerStatus); `ai` says which AI that is and what state it is in.
 *
 * It is mounted before sign-in (server.js), so anyone who can reach the address can call it: without signing in
 * the answer is only the 503/200 signal and the default AI's id and state. The details (what to fix, which may name
 * Local AI's internal address; the other AIs' checks; the recent errors) go only to a signed-in caller, a session or
 * the API token (req.auth, which sessionAuth sets before this runs).
 */
healthRouter.get("/healthz/deep", async (req, res) => {
  const signedIn = req.auth?.authenticated === true;
  try {
    const { runDiagnostics } = await import("../lib/self-heal.js");
    const ctx = {
      db: req.app.get("db"),
      settingsStore: req.app.get("settingsStore"),
      channelManager: req.app.get("channelManager"),
    };
    const diagnostics = await runDiagnostics(ctx);

    const hasErrors = diagnostics.some((d) => d.status === "error");
    const aiCheck = diagnostics.find((d) => d.check === "ai_provider");
    const ai = aiCheck
      ? { provider: aiCheck.provider ?? null, state: aiCheck.state ?? null, ready: aiCheck.status === "ok" }
      : null;
    const status = hasErrors ? 503 : 200;
    const head = { ok: !hasErrors, service: "tarsee", uptime: Math.floor(process.uptime()) };

    if (!signedIn) return res.status(status).json({ ...head, ai });
    res.status(status).json({
      ...head,
      ai: ai ? { ...ai, detail: aiCheck.detail } : null,
      checks: diagnostics,
      errors: getErrorSummary(),
    });
  } catch (err) {
    res.status(500).json(signedIn ? { ok: false, error: err.message } : { ok: false });
  }
});
