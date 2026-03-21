import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import config from "../config/env.js";

export const backupRouter = Router();

/**
 * GET /api/backup/export
 * Download a tar.gz backup of the data directory.
 */
backupRouter.get("/export", (req, res) => {
  const dataDir = config.DATA_DIR;

  if (!fs.existsSync(dataDir)) {
    return res.status(404).json({ error: "Data directory not found" });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `opusclaw-backup-${timestamp}.tar.gz`;

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  try {
    const tar = spawn("tar", ["czf", "-", "-C", path.dirname(dataDir), path.basename(dataDir)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    tar.stdout.pipe(res);

    tar.stderr.on("data", (d) => {
      console.warn("[backup] tar stderr:", d.toString());
    });

    tar.on("error", (err) => {
      console.error("[backup] tar error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Backup failed: " + err.message });
      }
    });

    tar.on("close", (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ error: `tar exited with code ${code}` });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/backup/info
 * Get backup/data directory info.
 */
backupRouter.get("/info", (_req, res) => {
  const dataDir = config.DATA_DIR;
  const stateDir = config.STATE_DIR;

  const info = {
    dataDir,
    stateDir,
    dbPath: config.DB_PATH,
    exists: fs.existsSync(dataDir),
  };

  if (info.exists) {
    try {
      const dbStat = fs.statSync(config.DB_PATH);
      info.dbSize = dbStat.size;
    } catch { /* db may not exist yet */ }
  }

  res.json(info);
});
