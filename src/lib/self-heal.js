import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { readWorkspaceFile, writeWorkspaceFile, invalidateCache, appendDailyLog } from "./workspace-files.js";

/**
 * Self-healing engine for OpusClaw.
 *
 * Runs diagnostics, detects issues, and attempts automatic repairs.
 * Can be triggered by:
 *   - /doctor chat command
 *   - doctor console command
 *   - Error handler (on repeated 5xx errors)
 *   - Heartbeat system (periodic health checks)
 *   - Boot runner (startup diagnostics)
 */

// Track recent errors for escalation
const recentErrors = [];
const MAX_ERROR_HISTORY = 50;
const ERROR_THRESHOLD = 5;       // 5 errors in the window triggers self-heal
const ERROR_WINDOW_MS = 60_000;  // 1 minute window

/**
 * Record an error for trend analysis.
 */
export function recordError(err, context = "") {
  recentErrors.push({
    ts: Date.now(),
    message: err.message || String(err),
    context,
    stack: err.stack?.split("\n").slice(0, 3).join("\n"),
  });
  // Trim old entries
  while (recentErrors.length > MAX_ERROR_HISTORY) recentErrors.shift();
}

/**
 * Check if we've exceeded the error threshold and should auto-heal.
 */
export function shouldAutoHeal() {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  const recent = recentErrors.filter((e) => e.ts > cutoff);
  return recent.length >= ERROR_THRESHOLD;
}

/**
 * Get recent error summary.
 */
export function getErrorSummary() {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  const recent = recentErrors.filter((e) => e.ts > cutoff);
  const all = [...recentErrors];

  // Group by message
  const groups = {};
  for (const e of all) {
    const key = e.message.slice(0, 100);
    groups[key] = (groups[key] || 0) + 1;
  }

  return {
    total: all.length,
    recentCount: recent.length,
    threshold: ERROR_THRESHOLD,
    window: `${ERROR_WINDOW_MS / 1000}s`,
    topErrors: Object.entries(groups)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([msg, count]) => ({ message: msg, count })),
  };
}

// ── Diagnostic checks ──────────────────────────────────────────────

/**
 * Run all diagnostics. Returns array of { check, status, detail, fix? }.
 */
export async function runDiagnostics(ctx = {}) {
  const results = [];

  // 1. Database health
  results.push(await checkDatabase(ctx.db));

  // 2. Workspace files
  results.push(...checkWorkspaceFiles());

  // 3. AI provider
  results.push(checkProvider(ctx.settingsStore));

  // 4. Disk space
  results.push(checkDiskSpace());

  // 5. Memory usage
  results.push(checkMemory());

  // 6. Volume mount (Railway)
  results.push(checkVolume());

  // 7. Error trends
  results.push(checkErrorTrends());

  // 8. Channel health
  if (ctx.channelManager) {
    results.push(checkChannels(ctx.channelManager));
  }

  return results;
}

/**
 * Attempt to auto-repair detected issues.
 */
export async function autoRepair(diagnostics, ctx = {}) {
  const repairs = [];

  for (const diag of diagnostics) {
    if (diag.status === "ok") continue;

    switch (diag.check) {
      case "workspace_files": {
        // Recreate missing workspace files
        const missing = diag.missing || [];
        for (const file of missing) {
          try {
            const defaults = getDefaultFileContent(file);
            writeWorkspaceFile(file, defaults);
            repairs.push({ check: diag.check, action: `Created missing ${file}`, success: true });
          } catch (err) {
            repairs.push({ check: diag.check, action: `Failed to create ${file}`, success: false, error: err.message });
          }
        }
        break;
      }

      case "database": {
        if (diag.detail?.includes("integrity") && ctx.db) {
          try {
            ctx.db.exec("REINDEX");
            repairs.push({ check: "database", action: "Rebuilt indexes", success: true });
          } catch (err) {
            repairs.push({ check: "database", action: "REINDEX failed", success: false, error: err.message });
          }
        }
        if (diag.detail?.includes("bloated") && ctx.db) {
          try {
            ctx.db.exec("VACUUM");
            repairs.push({ check: "database", action: "Vacuumed database", success: true });
          } catch (err) {
            repairs.push({ check: "database", action: "VACUUM failed", success: false, error: err.message });
          }
        }
        break;
      }

      case "memory": {
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
          repairs.push({ check: "memory", action: "Forced garbage collection", success: true });
        }
        // Clear caches
        invalidateCache();
        repairs.push({ check: "memory", action: "Cleared workspace file cache", success: true });
        break;
      }

      case "workspace_cache": {
        invalidateCache();
        repairs.push({ check: "workspace_cache", action: "Invalidated cache", success: true });
        break;
      }

      default:
        // No auto-repair for this check
        break;
    }
  }

  // Log repairs
  if (repairs.length > 0) {
    const summary = repairs.map((r) => `${r.success ? "✓" : "✗"} ${r.action}`).join(", ");
    appendDailyLog(`[self-heal] Repairs: ${summary}`);
    console.log(`[self-heal] Performed ${repairs.length} repair(s): ${summary}`);
  }

  return repairs;
}

// ── Individual checks ──────────────────────────────────────────────

async function checkDatabase(db) {
  if (!db) return { check: "database", status: "error", detail: "Database not available" };

  try {
    // Quick integrity check (faster than full PRAGMA integrity_check)
    const result = db.prepare("PRAGMA quick_check").get();
    const isOk = result?.quick_check === "ok";

    // Check for bloat
    const pageCount = db.prepare("PRAGMA page_count").get()?.page_count || 0;
    const freePages = db.prepare("PRAGMA freelist_count").get()?.freelist_count || 0;
    const bloatPct = pageCount > 0 ? Math.round((freePages / pageCount) * 100) : 0;

    // Check table counts
    const convs = db.prepare("SELECT COUNT(*) as c FROM conversations").get()?.c || 0;
    const msgs = db.prepare("SELECT COUNT(*) as c FROM messages").get()?.c || 0;

    if (!isOk) {
      return { check: "database", status: "error", detail: `integrity check failed — ${result?.quick_check}` };
    }

    if (bloatPct > 30) {
      return { check: "database", status: "warn", detail: `bloated (${bloatPct}% free pages) — needs VACUUM. ${convs} convs, ${msgs} msgs` };
    }

    return { check: "database", status: "ok", detail: `${convs} conversations, ${msgs} messages, ${bloatPct}% free pages` };
  } catch (err) {
    return { check: "database", status: "error", detail: err.message };
  }
}

function checkWorkspaceFiles() {
  const required = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md", "TOOLS.md", "MEMORY.md"];
  const optional = ["HEARTBEAT.md", "BOOT.md", "BOOTSTRAP.md"];
  const results = [];
  const missing = [];

  for (const file of required) {
    const content = readWorkspaceFile(file);
    if (!content || content.trim().length < 5) {
      missing.push(file);
    }
  }

  if (missing.length > 0) {
    results.push({
      check: "workspace_files",
      status: "warn",
      detail: `Missing or empty: ${missing.join(", ")}`,
      missing,
    });
  } else {
    results.push({
      check: "workspace_files",
      status: "ok",
      detail: `All ${required.length} required files present`,
    });
  }

  return results;
}

function checkProvider(settingsStore) {
  if (!settingsStore) return { check: "ai_provider", status: "error", detail: "Settings store not available" };

  try {
    const active = settingsStore.getActiveProvider();
    if (!active?.provider) {
      return { check: "ai_provider", status: "error", detail: "No provider configured" };
    }
    if (!active?.apiKey) {
      return { check: "ai_provider", status: "error", detail: `Provider ${active.provider} has no API key` };
    }
    return {
      check: "ai_provider",
      status: "ok",
      detail: `${active.provider} / ${active.model || "default"} — key: ••••${active.apiKey.slice(-4)}`,
    };
  } catch (err) {
    return { check: "ai_provider", status: "error", detail: err.message };
  }
}

function checkDiskSpace() {
  try {
    const dirs = [config.DATA_DIR, config.WORKSPACE_DIR];
    let totalSize = 0;
    for (const dir of dirs) {
      totalSize += getDirSizeRecursive(dir);
    }
    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);

    if (totalSize > 500 * 1024 * 1024) {
      return { check: "disk_space", status: "warn", detail: `${sizeMB}MB used — consider cleanup` };
    }
    return { check: "disk_space", status: "ok", detail: `${sizeMB}MB used` };
  } catch (err) {
    return { check: "disk_space", status: "warn", detail: `Could not check: ${err.message}` };
  }
}

function checkMemory() {
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);

  if (rssMB > 512) {
    return { check: "memory", status: "error", detail: `RSS ${rssMB}MB — possible memory leak` };
  }
  if (rssMB > 256) {
    return { check: "memory", status: "warn", detail: `RSS ${rssMB}MB, heap ${heapMB}/${heapTotalMB}MB (${heapPct}%)` };
  }
  return { check: "memory", status: "ok", detail: `RSS ${rssMB}MB, heap ${heapMB}/${heapTotalMB}MB (${heapPct}%)` };
}

function checkVolume() {
  if (!config.IS_RAILWAY) {
    return { check: "volume", status: "ok", detail: "Not on Railway — local filesystem" };
  }

  if (config.STATE_DIR.startsWith("/data")) {
    return { check: "volume", status: "ok", detail: `Persistent volume at ${config.STATE_DIR}` };
  }

  return {
    check: "volume",
    status: "error",
    detail: "Railway volume NOT mounted — data will be LOST on redeploy! Mount /data in Railway settings.",
  };
}

function checkErrorTrends() {
  const summary = getErrorSummary();
  if (summary.recentCount >= ERROR_THRESHOLD) {
    return {
      check: "error_trends",
      status: "error",
      detail: `${summary.recentCount} errors in last ${summary.window} (threshold: ${ERROR_THRESHOLD}). Top: ${summary.topErrors[0]?.message || "unknown"}`,
    };
  }
  if (summary.total > 10) {
    return {
      check: "error_trends",
      status: "warn",
      detail: `${summary.total} total errors recorded, ${summary.recentCount} recent`,
    };
  }
  return { check: "error_trends", status: "ok", detail: `${summary.total} errors recorded` };
}

function checkChannels(channelManager) {
  try {
    const status = channelManager.getStatus();
    const issues = [];
    for (const [type, s] of Object.entries(status)) {
      if (s.status === "error") issues.push(`${type}: ${s.error || "error"}`);
    }
    if (issues.length > 0) {
      return { check: "channels", status: "warn", detail: issues.join("; ") };
    }
    return { check: "channels", status: "ok", detail: `All channels healthy` };
  } catch (err) {
    return { check: "channels", status: "warn", detail: err.message };
  }
}

// ── Format diagnostics for display ──────────────────────────────────

export function formatDiagnostics(diagnostics, repairs = []) {
  const icons = { ok: "●", warn: "▲", error: "✗" };
  const colors = { ok: "green", warn: "yellow", error: "red" };

  const lines = ["**OpusClaw Doctor**", ""];

  for (const d of diagnostics) {
    const icon = icons[d.status] || "?";
    lines.push(`${icon} **${d.check.replace(/_/g, " ")}**: ${d.detail}`);
  }

  const okCount = diagnostics.filter((d) => d.status === "ok").length;
  const warnCount = diagnostics.filter((d) => d.status === "warn").length;
  const errCount = diagnostics.filter((d) => d.status === "error").length;

  lines.push("");
  lines.push(`**Summary:** ${okCount} OK, ${warnCount} warnings, ${errCount} errors`);

  if (repairs.length > 0) {
    lines.push("");
    lines.push("**Repairs performed:**");
    for (const r of repairs) {
      lines.push(`${r.success ? "✓" : "✗"} ${r.action}${r.error ? ` (${r.error})` : ""}`);
    }
  }

  if (errCount === 0 && warnCount === 0) {
    lines.push("", "All systems healthy.");
  } else if (errCount > 0) {
    lines.push("", "Use `/doctor fix` to attempt auto-repair.");
  }

  return lines.join("\n");
}

/**
 * Format diagnostics for console output (plain text, no markdown).
 */
export function formatDiagnosticsPlain(diagnostics, repairs = []) {
  const icons = { ok: "[OK]  ", warn: "[WARN]", error: "[ERR] " };
  const lines = [];

  for (const d of diagnostics) {
    lines.push(`${icons[d.status] || "[???]"} ${d.check}: ${d.detail}`);
  }

  const okCount = diagnostics.filter((d) => d.status === "ok").length;
  const warnCount = diagnostics.filter((d) => d.status === "warn").length;
  const errCount = diagnostics.filter((d) => d.status === "error").length;
  lines.push(`--- ${okCount} OK, ${warnCount} warn, ${errCount} error`);

  if (repairs.length > 0) {
    lines.push("");
    for (const r of repairs) {
      lines.push(`${r.success ? "[FIX]" : "[FAIL]"} ${r.action}`);
    }
  }

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────

function getDirSizeRecursive(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isFile()) size += fs.statSync(full).size;
      else if (entry.isDirectory()) size += getDirSizeRecursive(full);
    }
  } catch { /* ignore */ }
  return size;
}

function getDefaultFileContent(filename) {
  const defaults = {
    "SOUL.md": "# Soul & Personality\n\nYou are OpusClaw, a helpful AI assistant.\nBe concise, direct, and helpful. Adapt your communication style to match the user.\n\n<!-- Edit this file to change your bot's personality and behavior -->\n",
    "IDENTITY.md": "# Identity\n\n- **Name:** OpusClaw\n- **Emoji:** 🦞\n- **Creature:** Lobster\n- **Vibe:** Helpful and sharp\n\n<!-- Metadata about the agent — parsed as key-value pairs -->\n",
    "AGENTS.md": "# Agent Rules & Conventions\n\n<!-- Define rules, workspace conventions, and how the agent should behave -->\n<!-- This is always injected into the system prompt -->\n",
    "USER.md": "# About the User\n\n<!-- Preferences and info about your human go here -->\n<!-- This gets injected into every conversation so the bot knows you -->\n",
    "TOOLS.md": "# Tools & Capabilities\n\n<!-- Available tools, local setup notes, capabilities -->\n<!-- This is injected into the system prompt so the tool knows what it can do -->\n",
    "MEMORY.md": "# Long-Term Memory\n\n<!-- Curated memories are stored here -->\n<!-- Use /remember in chat or edit this file directly -->\n",
    "HEARTBEAT.md": "",
    "BOOT.md": "",
  };
  return defaults[filename] || `# ${filename}\n\n<!-- Auto-created by self-heal -->\n`;
}
