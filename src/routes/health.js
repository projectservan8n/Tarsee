import { Router } from "express";
import config from "../config/env.js";
import { getErrorSummary } from "../lib/self-heal.js";

export const healthRouter = Router();

/** Basic health check — fast, for load balancers. */
healthRouter.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "opusclaw",
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

/** Deep health check — runs diagnostics. */
healthRouter.get("/healthz/deep", async (req, res) => {
  try {
    const { runDiagnostics } = await import("../lib/self-heal.js");
    const ctx = {
      db: req.app.get("db"),
      settingsStore: req.app.get("settingsStore"),
      channelManager: req.app.get("channelManager"),
    };
    const diagnostics = await runDiagnostics(ctx);

    const hasErrors = diagnostics.some((d) => d.status === "error");
    const errorSummary = getErrorSummary();

    res.status(hasErrors ? 503 : 200).json({
      ok: !hasErrors,
      service: "opusclaw",
      uptime: Math.floor(process.uptime()),
      checks: diagnostics,
      errors: errorSummary,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
