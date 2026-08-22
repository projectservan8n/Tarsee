import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Busboy from "busboy";
import config from "../config/env.js";
import { isEncryptionEnabled } from "../lib/vault.js";
import { AuditLog } from "../db/audit.js";
import { CLAUDE_MODELS_BY_ID, getRecommendedModel } from "../config/constants.js";
import {
  transcriptSizeMB,
  isTranscriptOverCap,
  SESSION_JSONL_MAX_MB,
} from "../lib/claude-transcript.js";

export const adminRouter = Router();

/**
 * GET /api/admin/status
 * System status overview.
 */
adminRouter.get("/status", (req, res) => {
  const channelManager = req.app.get("channelManager");
  const memUsage = process.memoryUsage();

  res.json({
    service: "tarsee",
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
    encryption: isEncryptionEnabled() ? "enabled" : "disabled",
  });
});

/**
 * GET /api/admin/audit
 * View credential access audit log.
 */
adminRouter.get("/audit", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Number(req.query.offset) || 0;

  const auditLog = req.app.get("auditLog");
  if (!auditLog) {
    return res.status(500).json({ error: "Audit log not initialized" });
  }

  res.json({
    entries: auditLog.query(limit, offset),
    total: auditLog.count(),
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
// Security audit
adminRouter.get("/security-audit", async (req, res) => {
  try {
    const { runAudit } = await import("../lib/security-audit.js");
    const settingsStore = req.app.get("settingsStore");
    res.json(runAudit(settingsStore));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tool permissions
adminRouter.get("/tool-permissions", async (req, res) => {
  try {
    const { getSecurityManager } = await import("../lib/security-manager.js");
    const sm = getSecurityManager(req.app.get("settingsStore"));
    res.json({ permissions: sm.listPermissions() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.post("/tool-permissions", async (req, res) => {
  const { toolName, mode } = req.body || {};
  if (!toolName || !mode) return res.status(400).json({ error: "toolName and mode required" });
  try {
    const { getSecurityManager } = await import("../lib/security-manager.js");
    const sm = getSecurityManager(req.app.get("settingsStore"));
    sm.setToolPermission(toolName, mode);
    res.json({ ok: true, toolName, mode });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

/**
 * GET /api/admin/backup
 * Stream a consistent SQLite snapshot of the main database.
 *
 * Uses better-sqlite3's online backup API so the live DB stays usable
 * during the snapshot. The file is produced in a tmp location, streamed
 * to the client, then deleted.
 */
adminRouter.get("/backup", async (req, res) => {
  const db = req.app.get("db");
  if (!db) return res.status(500).json({ error: "Database not initialized" });

  const auditLog = req.app.get("auditLog");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tmpFile = path.join(os.tmpdir(), `tarsee-backup-${stamp}-${crypto.randomBytes(6).toString("hex")}.db`);

  try {
    await db.backup(tmpFile);
    const stat = fs.statSync(tmpFile);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", `attachment; filename="tarsee-backup-${stamp}.db"`);
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(tmpFile);
    stream.on("close", () => fs.promises.unlink(tmpFile).catch(() => {}));
    stream.on("error", () => fs.promises.unlink(tmpFile).catch(() => {}));
    stream.pipe(res);

    auditLog?.log({ action: "admin.backup", actor: "user", ip: req.ip, detail: `${stat.size} bytes` });
  } catch (err) {
    fs.promises.unlink(tmpFile).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/restore
 * Accept an uploaded SQLite backup file (multipart/form-data, field "backup")
 * and stage it under STATE_DIR/restore/. The file is validated as SQLite by
 * checking the 16-byte header magic before it is accepted. Applying the
 * restore requires a server restart — we deliberately do NOT auto-swap the
 * live DB because other subsystems (cron, channels) hold cached state.
 *
 * Response contains the staged path. Operator runbook: stop server → move
 * file over the live DB → restart.
 */
const SQLITE_HEADER = Buffer.from("SQLite format 3\x00", "binary");

adminRouter.post("/restore", (req, res) => {
  if (!/multipart\/form-data/i.test(req.headers["content-type"] || "")) {
    return res.status(400).json({ error: "Use multipart/form-data with a 'backup' file field" });
  }

  const auditLog = req.app.get("auditLog");
  const restoreDir = path.join(config.STATE_DIR, "restore");
  fs.mkdirSync(restoreDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stagedPath = path.join(restoreDir, `staged-${stamp}.db`);

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      files: 1,
      fileSize: 500 * 1024 * 1024, // 500MB cap — SQLite files rarely larger
    },
  });

  let gotFile = false;
  let headerOk = false;
  let bytes = 0;
  let aborted = false;

  busboy.on("file", (_name, stream, info) => {
    gotFile = true;
    const out = fs.createWriteStream(stagedPath);
    let headerBuf = Buffer.alloc(0);

    stream.on("data", (chunk) => {
      if (!headerOk) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        if (headerBuf.length >= SQLITE_HEADER.length) {
          if (!headerBuf.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
            aborted = true;
            stream.unpipe(out);
            out.destroy();
            fs.promises.unlink(stagedPath).catch(() => {});
            if (!res.headersSent) res.status(400).json({ error: "Not a valid SQLite database file" });
            req.unpipe(busboy);
            return;
          }
          headerOk = true;
        }
      }
      bytes += chunk.length;
    });

    stream.on("limit", () => {
      aborted = true;
      stream.unpipe(out);
      out.destroy();
      fs.promises.unlink(stagedPath).catch(() => {});
      if (!res.headersSent) res.status(413).json({ error: "Backup file too large" });
    });

    stream.pipe(out);
    out.on("close", () => {
      if (aborted || res.headersSent) return;
      if (!headerOk) {
        fs.promises.unlink(stagedPath).catch(() => {});
        return res.status(400).json({ error: "File too short to validate as SQLite" });
      }
      auditLog?.log({
        action: "admin.restore_staged",
        actor: "user",
        ip: req.ip,
        detail: `${info.filename || "uploaded"} → ${stagedPath} (${bytes} bytes)`,
      });
      res.json({
        ok: true,
        stagedPath,
        bytes,
        next: "Stop the server, move this file over the live DB at " + config.DB_PATH + ", then restart.",
      });
    });
  });

  busboy.on("error", (err) => {
    if (!res.headersSent) res.status(400).json({ error: err.message });
  });
  busboy.on("finish", () => {
    if (!gotFile && !res.headersSent) {
      res.status(400).json({ error: "No file uploaded (field must be 'backup')" });
    }
  });

  req.pipe(busboy);
});


/**
 * Parse a model registry context string ("1M", "200k") into a token count.
 * Falls back to 200k for anything unrecognised.
 */
function contextWindowTokens(modelId) {
  const override = Number(process.env.TARSEE_MODEL_CONTEXT_TOKENS);
  if (override > 0) return override;
  const raw = CLAUDE_MODELS_BY_ID[modelId]?.context
    || CLAUDE_MODELS_BY_ID[getRecommendedModel()]?.context;
  const m = /^([\d.]+)\s*([MmKk])?$/.exec(String(raw || "").trim());
  if (!m) return 200_000;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  if (unit === "m") return Math.round(n * 1_000_000);
  if (unit === "k") return Math.round(n * 1_000);
  return Math.round(n);
}

/**
 * GET /api/admin/context-health
 *
 * Per-conversation context-window health: how full the model's context
 * actually is, plus the Claude session transcript (.jsonl) size — the real
 * driver of bloat-hangs. Sorted biggest-transcript-first so the hang-prone
 * conversations stand out.
 *
 * IMPORTANT — how contextPct is computed:
 * Context fill is a POINT-IN-TIME measure: the prompt size of the most recent
 * turn. It is NOT the running total of every token the conversation ever used
 * (summing those yields nonsense like 832% once a chat is long enough). We
 * therefore take the LAST assistant message's tokens_in, which the channels
 * now record as input + cache_read + cache_creation — the true prompt size.
 *
 * Conversations whose transcript is past the cap are flagged
 * `willResetNextTurn`; the provider enforces that same cap by refusing to
 * resume, so the flag reflects real behaviour rather than predicting it.
 */
adminRouter.get("/context-health", (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "db unavailable" });

    const convs = db.prepare(
      "SELECT id, title, model, claude_session_id, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 80",
    ).all();

    const rows = convs.map((c) => {
      const messages = db.prepare(
        "SELECT COUNT(*) n FROM messages WHERE conversation_id=?",
      ).get(c.id)?.n || 0;

      // Last recorded prompt size = current context fill.
      const lastIn = db.prepare(
        `SELECT tokens_in FROM messages
          WHERE conversation_id=? AND tokens_in IS NOT NULL AND tokens_in > 0
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(c.id)?.tokens_in || 0;

      // Cumulative spend is still useful, but it is a DIFFERENT number and is
      // reported separately so the two can never be confused again.
      const totals = db.prepare(
        `SELECT COALESCE(SUM(tokens_in),0) ti, COALESCE(SUM(tokens_out),0) tou
           FROM messages WHERE conversation_id=?`,
      ).get(c.id) || { ti: 0, tou: 0 };

      const contextWindow = contextWindowTokens(c.model);
      const measured = lastIn > 0;
      // Only estimate when we genuinely have no telemetry for this chat.
      const tokensEst = measured ? lastIn : messages * 80;
      const contextPct = Math.min(
        100,
        Math.round((tokensEst / contextWindow) * 1000) / 10,
      );
      const transcriptMB = transcriptSizeMB(c.claude_session_id);

      return {
        id: c.id,
        title: c.title || "(untitled)",
        messages,
        contextTokens: tokensEst,
        contextWindow,
        contextPct,
        // Callers must not present an estimate as a measurement.
        measured,
        status: contextPct > 95 ? "critical" : contextPct > 80 ? "warning" : "healthy",
        lifetimeTokensIn: totals.ti,
        lifetimeTokensOut: totals.tou,
        transcriptMB,
        willResetNextTurn: isTranscriptOverCap(c.claude_session_id),
        updatedAt: c.updated_at,
      };
    }).sort((a, b) => (b.transcriptMB || 0) - (a.transcriptMB || 0));

    res.json({
      sessionCapMB: SESSION_JSONL_MAX_MB,
      conversations: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
