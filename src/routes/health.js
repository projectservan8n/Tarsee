import { Router } from "express";
import config from "../config/env.js";

export const healthRouter = Router();

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
  });
});
