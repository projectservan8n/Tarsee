/**
 * Retention — auto-prune old conversations and checkpoint archives.
 *
 * Tarsee accumulates conversation rows fast (each channel message = a
 * row, and every edit/reply in a long session too). This module runs
 * a daily sweep at ~03:00 local server time to:
 *
 *   1. Prune conversations idle for > retention.conversations_days (14d default)
 *      - Skips the most-recent conversation per channel_conv.<key> mapping
 *        so active channels don't lose their session pointer mid-stream.
 *      - Before deleting, appends a one-line summary (date · title · msg count)
 *        to memory/archived-conversations.md so the gist survives in
 *        searchable form.
 *      - Relies on FK `messages.conversation_id ... ON DELETE CASCADE`
 *        to reap the message rows.
 *
 *   2. Prune auto-archived checkpoints older than retention.checkpoints_days
 *      (30d default), AND keep no more than retention.checkpoints_max
 *      files (50 default) by deleting the oldest if over the cap.
 *
 * Config (settings keys, all optional — defaults baked in):
 *   retention.conversations_days   (number, default 14)
 *   retention.checkpoints_days     (number, default 30)
 *   retention.checkpoints_max      (number, default 50)
 *   retention.schedule_hour        (0-23, default 3 — UTC on Railway)
 *
 * State (written by this module):
 *   retention.last_run_at          (ISO timestamp of last successful sweep)
 *   retention.last_pruned_convs    (count from last run)
 *   retention.last_pruned_checks   (count from last run)
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { appendWorkspaceFile } from "./workspace-files.js";

const ONE_HOUR = 3600_000;

const DEFAULTS = Object.freeze({
  conversations_days: 14,
  checkpoints_days: 30,
  checkpoints_max: 50,
  schedule_hour: 3,
});

let _interval = null;
let _db = null;

export function startRetention({ db }) {
  _db = db;
  // Poll once an hour; inside tick() we only actually run when the hour
  // matches schedule_hour AND we haven't already run today. This keeps
  // the code cheap + tolerant of clock drift / restarts within the run
  // window.
  _interval = setInterval(() => maybeRun().catch(() => {}), ONE_HOUR);
  // Also kick a deferred check shortly after boot in case we're booting
  // right at 03:00.
  setTimeout(() => maybeRun().catch(() => {}), 60_000);
  console.log("[retention] started — daily sweep at hour 03:00 (override via settings retention.schedule_hour)");
}

export function stopRetention() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

async function maybeRun() {
  if (!_db) return;
  try {
    const settings = new SettingsStore(_db);
    const hour = Number(settings.get("retention.schedule_hour") ?? DEFAULTS.schedule_hour);
    const now = new Date();
    if (now.getHours() !== hour) return;

    // Don't re-run twice in the same day if the service happened to be
    // up through the hour window twice (unlikely, but defensive).
    const lastRunAt = settings.get("retention.last_run_at");
    if (lastRunAt) {
      const last = new Date(lastRunAt);
      const sameDay = last.toDateString() === now.toDateString();
      if (sameDay) return;
    }

    await runSweep(settings);
    settings.set("retention.last_run_at", now.toISOString());
  } catch (err) {
    console.warn("[retention] maybeRun error:", err?.message);
  }
}

/**
 * Immediate run (exposed for /retention command).
 * Safe to call anytime — returns a { convs, checks } summary.
 */
export async function runNow() {
  if (!_db) throw new Error("Retention not initialized");
  const settings = new SettingsStore(_db);
  const result = await runSweep(settings);
  settings.set("retention.last_run_at", new Date().toISOString());
  return result;
}

/**
 * Dry-run — shows what would be pruned without deleting.
 */
export function preview() {
  if (!_db) throw new Error("Retention not initialized");
  const settings = new SettingsStore(_db);
  const convDays = Number(settings.get("retention.conversations_days") ?? DEFAULTS.conversations_days);
  const checkDays = Number(settings.get("retention.checkpoints_days") ?? DEFAULTS.checkpoints_days);
  const checkMax = Number(settings.get("retention.checkpoints_max") ?? DEFAULTS.checkpoints_max);

  const convs = findPrunableConversations(convDays, settings);
  const checks = findPrunableCheckpoints(checkDays, checkMax);

  return {
    conversations: convs.map((c) => ({
      id: c.id,
      title: c.title,
      updated_at: c.updated_at,
      msg_count: c.msg_count,
    })),
    checkpoints: checks.map((f) => ({ name: f.name, age_days: Math.round((Date.now() - f.mtime) / 86400_000) })),
    config: { convDays, checkDays, checkMax },
  };
}

async function runSweep(settings) {
  const convDays = Number(settings.get("retention.conversations_days") ?? DEFAULTS.conversations_days);
  const checkDays = Number(settings.get("retention.checkpoints_days") ?? DEFAULTS.checkpoints_days);
  const checkMax = Number(settings.get("retention.checkpoints_max") ?? DEFAULTS.checkpoints_max);

  const prunedConvs = pruneConversations(convDays, settings);
  const prunedChecks = pruneCheckpoints(checkDays, checkMax);
  // After deleting conversations, clean up any dangling back-references in
  // memory tables. Two tables have conv pointers without FK constraints:
  //   bot_memory.source_conversation_id      — learned fact → convo origin
  //   compaction_cache.conversation_id       — per-conv summary cache
  // Memories stay (the fact is still true), but we NULL the origin pointer
  // and drop the cache rows so they don't accumulate forever.
  const orphans = cleanupOrphanedReferences();

  settings.set("retention.last_pruned_convs", prunedConvs);
  settings.set("retention.last_pruned_checks", prunedChecks);
  settings.set("retention.last_orphan_cleanup", orphans);

  console.log(`[retention] sweep done — pruned ${prunedConvs} conversations, ${prunedChecks} checkpoints, cleaned ${orphans.memories} memory backrefs + ${orphans.cache} cache rows`);
  return { convs: prunedConvs, checks: prunedChecks, orphans };
}

// ------------------------------------------------------------------
// Conversations
// ------------------------------------------------------------------

function findPrunableConversations(days, settings) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  // Conversations older than cutoff.
  const candidates = _db.prepare(`
    SELECT c.id, c.title, c.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count
    FROM conversations c
    WHERE c.updated_at < ?
    ORDER BY c.updated_at ASC
  `).all(cutoff);

  if (candidates.length === 0) return [];

  // Build a set of "do-not-delete" conv IDs = current channel pointers.
  // channel_conv.<key> → convId in settings table.
  const keepIds = new Set();
  try {
    const pointers = _db.prepare(
      "SELECT value FROM settings WHERE key LIKE 'channel_conv.%'"
    ).all();
    for (const p of pointers) {
      let v = p.value;
      try {
        // settings values are stored as JSON strings in some places
        if (typeof v === "string" && v.startsWith('"')) v = JSON.parse(v);
      } catch { /* raw string is fine */ }
      if (typeof v === "string" && v) keepIds.add(v);
    }
  } catch { /* ignore — defensive */ }

  return candidates.filter((c) => !keepIds.has(c.id));
}

function pruneConversations(days, settings) {
  const prunable = findPrunableConversations(days, settings);
  if (prunable.length === 0) return 0;

  const convStore = new ConversationStore(_db);

  // Archive a one-line summary of each pruned convo before delete. This
  // is append-only — the user can grep memory/archived-conversations.md
  // later if they need to recall a specific session.
  try {
    const lines = prunable.map((c) => {
      const date = (c.updated_at || "").slice(0, 10);
      const title = (c.title || "Untitled").replace(/\n/g, " ").slice(0, 100);
      return `- ${date} · ${title} · ${c.msg_count} msgs · id=${c.id}`;
    });
    const header = `\n\n## Pruned ${new Date().toISOString().slice(0, 10)} (retention ${days}d)\n`;
    appendWorkspaceFile("memory/archived-conversations.md", header + lines.join("\n") + "\n");
  } catch (err) {
    console.warn("[retention] archive summary write failed:", err?.message);
  }

  // Batch delete via cascade.
  let deleted = 0;
  const tx = _db.transaction((ids) => {
    for (const id of ids) {
      try {
        if (convStore.delete(id)) deleted++;
      } catch { /* individual fail, keep going */ }
    }
  });
  tx(prunable.map((c) => c.id));

  // Reclaim space if we pruned a meaningful amount.
  if (deleted >= 100) {
    try { _db.exec("VACUUM"); } catch { /* vacuum is best-effort */ }
  }

  return deleted;
}

// ------------------------------------------------------------------
// Checkpoints
// ------------------------------------------------------------------

function findPrunableCheckpoints(days, maxFiles) {
  const archiveDir = path.join(config.WORKSPACE_DIR, "memory", "checkpoints");
  if (!fs.existsSync(archiveDir)) return [];

  const entries = fs.readdirSync(archiveDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => {
      const full = path.join(archiveDir, e.name);
      const stat = fs.statSync(full);
      return { name: e.name, path: full, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  const cutoffMs = Date.now() - days * 86400_000;
  const prunable = [];

  // Rule 1: files older than cutoff.
  for (const e of entries) {
    if (e.mtime < cutoffMs) prunable.push(e);
  }

  // Rule 2: if still over maxFiles after rule 1, drop the oldest remaining.
  const remaining = entries.filter((e) => !prunable.includes(e));
  if (remaining.length > maxFiles) {
    const overflow = remaining.slice(maxFiles); // oldest tail
    prunable.push(...overflow);
  }

  return prunable;
}

function pruneCheckpoints(days, maxFiles) {
  const prunable = findPrunableCheckpoints(days, maxFiles);
  let deleted = 0;
  for (const e of prunable) {
    try { fs.unlinkSync(e.path); deleted++; } catch { /* best-effort */ }
  }
  return deleted;
}

// ------------------------------------------------------------------
// Orphan cleanup
// Two tables reference conversations.id without a foreign key, so rows
// linger after a cascade delete wipes the conversation. Left alone they
// don't break anything (memories still read, compaction_cache is scoped
// per query), but they grow unbounded and make the DB less tidy.
// ------------------------------------------------------------------

function cleanupOrphanedReferences() {
  let memories = 0;
  let cache = 0;
  try {
    // bot_memory: NULL out source_conversation_id where the target is gone.
    // We deliberately keep the row (the fact is still true; only the origin
    // pointer is stale). The LIMIT 0 inner select is a defensive no-op — we
    // want UPDATE ... WHERE NOT EXISTS matching, which SQLite supports via
    // correlated subquery.
    const r1 = _db.prepare(`
      UPDATE bot_memory
      SET source_conversation_id = NULL
      WHERE source_conversation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = bot_memory.source_conversation_id)
    `).run();
    memories = r1.changes || 0;
  } catch (err) {
    console.warn("[retention] bot_memory cleanup failed:", err?.message);
  }
  try {
    // compaction_cache: delete rows pointing at dead convos.
    const r2 = _db.prepare(`
      DELETE FROM compaction_cache
      WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = compaction_cache.conversation_id)
    `).run();
    cache = r2.changes || 0;
  } catch (err) {
    console.warn("[retention] compaction_cache cleanup failed:", err?.message);
  }
  return { memories, cache };
}
