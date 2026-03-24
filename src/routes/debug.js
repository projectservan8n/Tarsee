import { Router } from "express";
import fs from "node:fs";
import config from "../config/env.js";
import { getTTSEngine } from "../voice/engine-registry.js";
import { logCapture } from "../lib/log-capture.js";

export const debugRouter = Router();

/**
 * Allowlisted debug commands.
 * Only these commands can be executed via the console.
 */
export const ALLOWED_COMMANDS = {
  "system.info": {
    description: "System information",
    run: async () => {
      const mem = process.memoryUsage();
      return [
        `Node:     ${process.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        `PID:      ${process.pid}`,
        `Uptime:   ${Math.floor(process.uptime())}s`,
        `RSS:      ${Math.round(mem.rss / 1024 / 1024)}MB`,
        `Heap:     ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
        `Data dir: ${config.DATA_DIR}`,
        `State:    ${config.STATE_DIR}`,
        `DB:       ${config.DB_PATH}`,
      ].join("\n");
    },
  },

  "system.env": {
    description: "Show (safe) environment variables",
    run: async () => {
      const safe = ["NODE_ENV", "PORT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID"];
      return safe
        .map((k) => `${k}=${process.env[k] || "(not set)"}`)
        .join("\n");
    },
  },

  "db.stats": {
    description: "Database statistics",
    run: async (_args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available";

      const convCount = db.prepare("SELECT COUNT(*) as count FROM conversations").get();
      const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages").get();
      const settingsCount = db.prepare("SELECT COUNT(*) as count FROM settings").get();
      const dbSize = db.prepare("PRAGMA page_count").get();
      const pageSize = db.prepare("PRAGMA page_size").get();
      const sizeBytes = dbSize.page_count * pageSize.page_size;

      return [
        `Conversations: ${convCount.count}`,
        `Messages:      ${msgCount.count}`,
        `Settings:      ${settingsCount.count}`,
        `DB Size:       ${Math.round(sizeBytes / 1024)}KB`,
        `WAL mode:      enabled`,
      ].join("\n");
    },
  },

  "db.vacuum": {
    description: "Vacuum database to reclaim space",
    run: async (_args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available";
      db.exec("VACUUM");
      return "Database vacuumed successfully.";
    },
  },

  "voice.status": {
    description: "TTS engine status",
    run: async () => {
      const engine = getTTSEngine();
      const lines = [`Engine: ${engine.name || "unknown"}`];
      if (engine.name !== "stub") {
        try {
          const voices = await engine.listVoices();
          lines.push(`Voices: ${voices.length}`);
          if (engine.ready !== undefined) lines.push(`Ready: ${engine.ready}`);
        } catch (err) {
          lines.push(`Error: ${err.message}`);
        }
      }
      return lines.join("\n");
    },
  },

  "channels.status": {
    description: "Channel integration status",
    run: async (_args, ctx) => {
      const cm = ctx.channelManager;
      if (!cm) return "Channel manager not available";
      const status = cm.getStatus();
      return Object.entries(status)
        .map(([type, s]) => `${type}: ${s.status}${s.error ? ` (${s.error})` : ""}`)
        .join("\n");
    },
  },

  "logs.recent": {
    description: "Show recent console output (last 50 lines)",
    run: async () => {
      const entries = logCapture.recent(50);
      if (entries.length === 0) return "(no log entries captured yet)";
      return entries
        .map((e) => {
          const t = new Date(e.ts).toISOString().slice(11, 23);
          return `[${t}] ${e.level.toUpperCase().padEnd(5)} ${e.text}`;
        })
        .join("\n");
    },
  },

  "disk.usage": {
    description: "Disk usage of data directories",
    run: async () => {
      const dirs = [config.DATA_DIR, config.STATE_DIR, config.WORKSPACE_DIR];
      const results = [];
      for (const dir of dirs) {
        try {
          const size = getDirSize(dir);
          results.push(`${dir}: ${formatSize(size)}`);
        } catch {
          results.push(`${dir}: (not accessible)`);
        }
      }
      return results.join("\n");
    },
  },

  // ── New commands (OpenClaw parity) ──────────────────────────────────

  "restart": {
    description: "Restart the server (Railway auto-restarts)",
    run: async () => {
      setTimeout(() => process.exit(0), 500);
      return "Restarting Tarsee... back in a few seconds.";
    },
  },

  "config.list": {
    description: "List all non-secret config values",
    run: async (_args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available";
      const rows = db.prepare("SELECT key, value FROM settings ORDER BY key").all();
      if (rows.length === 0) return "(no settings)";
      return rows.map((r) => {
        const val = (r.key.includes("apiKey") || r.key.includes("token") || r.key.includes("secret"))
          ? "••••••"
          : r.value?.slice(0, 80);
        return `${r.key} = ${val}`;
      }).join("\n");
    },
  },

  "config.get": {
    description: "Get a specific config value (usage: config.get <key>)",
    run: async (args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available";
      if (!args) return "Usage: config.get <key>";
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(args);
      if (!row) return `${args}: (not set)`;
      if (args.includes("apiKey") || args.includes("token")) return `${args}: ••••••`;
      return `${args}: ${row.value}`;
    },
  },

  "provider.status": {
    description: "Current AI provider, model, and key status",
    run: async (_args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available";
      const provider = db.prepare("SELECT value FROM settings WHERE key = 'ai.activeProvider'").get();
      const p = provider?.value || "none";
      const model = db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai.${p}.model`);
      const key = db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai.${p}.apiKey`);
      const base = db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai.${p}.baseUrl`);
      return [
        `Provider: ${p}`,
        `Model:    ${model?.value || "(default)"}`,
        `API Key:  ${key?.value ? "••••" + key.value.slice(-4) : "(not set / env fallback)"}`,
        `Base URL: ${base?.value || "(default)"}`,
      ].join("\n");
    },
  },

  "memory.stats": {
    description: "Bot memory statistics",
    run: async (_args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available";
      try {
        const total = db.prepare("SELECT COUNT(*) as count FROM bot_memory").get();
        const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM bot_memory GROUP BY category ORDER BY count DESC").all();
        const lines = [`Total memories: ${total.count}`];
        for (const row of byCategory) {
          lines.push(`  ${row.category}: ${row.count}`);
        }
        return lines.join("\n");
      } catch {
        return "bot_memory table not found";
      }
    },
  },

  "skills.list": {
    description: "List all available skills",
    run: async () => {
      try {
        const { getSkillsList } = await import("../lib/skills-engine.js");
        const skills = getSkillsList();
        if (skills.length === 0) return "(no skills)";
        return skills.map((s) => `${s.name} [${s.source}] — ${s.description}`).join("\n");
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  "workspace.files": {
    description: "List workspace files and their sizes",
    run: async () => {
      const files = ["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "IDENTITY.md", "TOOLS.md", "HEARTBEAT.md", "BOOT.md", "BOOTSTRAP.md"];
      const results = [];
      for (const f of files) {
        const path = `${config.WORKSPACE_DIR}/${f}`;
        try {
          const stat = fs.statSync(path);
          results.push(`${f}: ${formatSize(stat.size)}`);
        } catch {
          results.push(`${f}: (not created)`);
        }
      }
      return results.join("\n");
    },
  },

  "sessions.list": {
    description: "List recent conversations/sessions",
    run: async (_args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available";
      const rows = db.prepare("SELECT id, title, channel, created_at FROM conversations ORDER BY created_at DESC LIMIT 10").all();
      if (rows.length === 0) return "(no conversations)";
      return rows.map((r) =>
        `${r.id.slice(0, 8)}… [${r.channel || "web"}] ${r.title || "(untitled)"} — ${r.created_at}`
      ).join("\n");
    },
  },

  "cron.status": {
    description: "Show cron job status",
    run: async () => {
      try {
        const { getCronStatus } = await import("../lib/cron.js");
        const status = getCronStatus();
        if (status.jobs.length === 0) return "No cron jobs configured";
        const lines = [`Active: ${status.activeJobs}/${status.totalJobs}`];
        for (const j of status.jobs) {
          lines.push(`  ${j.id} [${j.enabled ? "ON" : "OFF"}] ${j.schedule} — ${j.prompt.slice(0, 50)}`);
        }
        return lines.join("\n");
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  "heartbeat.status": {
    description: "Show heartbeat system status",
    run: async () => {
      try {
        const { getHeartbeatStatus } = await import("../lib/heartbeat.js");
        const s = getHeartbeatStatus();
        return [
          `Running:   ${s.running ? "Yes" : "No"}`,
          `Last run:  ${s.lastRun || "Never"}`,
          `Run count: ${s.runCount || 0}`,
          `Last result: ${s.lastResult?.slice(0, 100) || "(none)"}`,
        ].join("\n");
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  "doctor": {
    description: "Run diagnostics and auto-repair (usage: doctor [fix])",
    run: async (args, ctx) => {
      const { runDiagnostics, autoRepair, formatDiagnosticsPlain } = await import("../lib/self-heal.js");
      const diagnostics = await runDiagnostics(ctx);
      let repairs = [];
      if (args === "fix" || args === "repair") {
        repairs = await autoRepair(diagnostics, ctx);
      }
      return formatDiagnosticsPlain(diagnostics, repairs);
    },
  },

  "memory.consolidate": {
    description: "Deduplicate similar memories",
    run: async (_args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available";
      try {
        const { MemoryStore } = await import("../lib/../db/memory.js");
        const store = new MemoryStore(db);
        const removed = store.consolidate();
        const stats = store.getStats();
        return `Removed ${removed} duplicate(s). Total: ${stats.total} memories.`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  "reload": {
    description: "Force-reload workspace files and skills cache",
    run: async () => {
      try {
        const { invalidateCache } = await import("../lib/workspace-files.js");
        invalidateCache();
        const skills = await import("../lib/skills-engine.js");
        skills.invalidateCache();
        return "Workspace files and skills cache cleared.";
      } catch (err) {
        return `Reload error: ${err.message}`;
      }
    },
  },
};

/**
 * GET /api/debug/commands
 * List available debug commands.
 */
debugRouter.get("/commands", (_req, res) => {
  const commands = Object.entries(ALLOWED_COMMANDS).map(([name, cmd]) => ({
    name,
    description: cmd.description,
  }));
  res.json({ commands });
});

/**
 * POST /api/debug/run
 * Execute an allowlisted debug command.
 */
debugRouter.post("/run", async (req, res) => {
  const { command, args } = req.body || {};
  if (!command) return res.status(400).json({ error: "Command required" });

  const cmd = ALLOWED_COMMANDS[command];
  if (!cmd) {
    return res.status(400).json({
      error: `Unknown command: ${command}`,
      available: Object.keys(ALLOWED_COMMANDS),
    });
  }

  try {
    const ctx = {
      db: req.app.get("db"),
      channelManager: req.app.get("channelManager"),
    };
    const output = await cmd.run(args, ctx);
    res.json({ ok: true, command, output });
  } catch (err) {
    res.status(500).json({ error: `Command failed: ${err.message}` });
  }
});

// Helpers
function getDirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = `${dirPath}/${entry.name}`;
      if (entry.isFile()) {
        size += fs.statSync(full).size;
      } else if (entry.isDirectory()) {
        size += getDirSize(full);
      }
    }
  } catch { /* ignore */ }
  return size;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
