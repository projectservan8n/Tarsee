import { Router } from "express";
import config from "../config/env.js";

export const adminRouter = Router();

/**
 * GET /api/admin/status
 * System status overview.
 */
adminRouter.get("/status", (req, res) => {
  const channelManager = req.app.get("channelManager");
  const memUsage = process.memoryUsage();

  res.json({
    service: "opusclaw",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
    },
    channels: channelManager?.getStatus() || {},
    stateDir: config.STATE_DIR,
    isRailway: config.IS_RAILWAY,
  });
});

/**
 * POST /api/admin/channels/:type/restart
 * Restart a specific channel.
 */
adminRouter.post("/channels/:type/restart", async (req, res) => {
  const { type } = req.params;
  const channelManager = req.app.get("channelManager");

  if (!channelManager) {
    return res.status(500).json({ error: "Channel manager not initialized" });
  }

  try {
    await channelManager.restart(type);
    res.json({ ok: true, status: "restarted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/admin/channels/:type/stop
 * Stop a specific channel.
 */
adminRouter.post("/channels/:type/stop", async (req, res) => {
  const { type } = req.params;
  const channelManager = req.app.get("channelManager");

  if (!channelManager) {
    return res.status(500).json({ error: "Channel manager not initialized" });
  }

  try {
    await channelManager.stop(type);
    res.json({ ok: true, status: "stopped" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
