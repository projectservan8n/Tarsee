/**
 * Auto-checkpoint — deterministic, periodic session handoff.
 *
 * Complements manual /checkpoint. The manual version spawns an AI round
 * trip and produces a thoughtful handoff. This one runs on a timer, has
 * zero AI cost, and produces an exhaustive-but-shallow mechanical dump.
 *
 * Design:
 *   - Timer: fires every 30 min (cheap poll).
 *   - Activity gate: only writes if ≥ 5 messages have been added since the
 *     last auto-checkpoint AND the most recent CHECKPOINT.md is older
 *     than 6 h (or doesn't exist).
 *   - Manual-priority: if CHECKPOINT.md was written in the last 30 min,
 *     defer — the user probably just ran /checkpoint and we don't want
 *     to clobber their deliberate snapshot.
 *   - Output: same CHECKPOINT.md path the manual flow writes to, so the
 *     next session's buildSystemPrompt picks it up automatically via
 *     readAndArchiveCheckpoint().
 *   - State: persisted in settings (checkpoint.last_auto_at,
 *     checkpoint.last_message_count).
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { SettingsStore } from "../db/settings.js";
import { CHECKPOINT_FILE_PATH } from "./checkpoint.js";

const CHECK_INTERVAL_MS = 30 * 60_000;         // 30 min poll
const MIN_AGE_BEFORE_NEW_MS = 6 * 3600_000;    // 6 h between auto-writes
const MANUAL_DEFER_WINDOW_MS = 30 * 60_000;    // don't clobber fresh manual
const MIN_MESSAGES = 5;                        // activity floor

let _interval = null;
let _db = null;

export function startAutoCheckpoint({ db }) {
  _db = db;
  // Run once after a short delay so the server has fully booted, then
  // every CHECK_INTERVAL_MS afterwards.
  setTimeout(() => runCheck().catch(() => {}), 60_000);
  _interval = setInterval(() => runCheck().catch(() => {}), CHECK_INTERVAL_MS);
  console.log(`[auto-checkpoint] started — check every ${CHECK_INTERVAL_MS / 60_000}min, write every ${MIN_AGE_BEFORE_NEW_MS / 3600_000}h if active`);
}

export function stopAutoCheckpoint() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

async function runCheck() {
  if (!_db) return;
  try {
    const settings = new SettingsStore(_db);

    // Total message count right now — used as the activity gate.
    const currentCount = _db.prepare("SELECT COUNT(*) AS c FROM messages").get()?.c || 0;
    const lastCount = Number(settings.get("checkpoint.last_message_count") || 0);
    const deltaMessages = currentCount - lastCount;
    if (deltaMessages < MIN_MESSAGES) {
      // No meaningful activity since last run — skip.
      return;
    }

    // Respect a recently-written CHECKPOINT.md (manual or auto).
    try {
      const stat = fs.existsSync(CHECKPOINT_FILE_PATH) && fs.statSync(CHECKPOINT_FILE_PATH);
      if (stat) {
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < MANUAL_DEFER_WINDOW_MS) {
          // Manual version is fresh, back off.
          return;
        }
      }
    } catch { /* stat errors — ignore and proceed */ }

    // Enforce minimum gap between auto-writes.
    const lastAutoAt = Number(settings.get("checkpoint.last_auto_at") || 0);
    if (lastAutoAt && Date.now() - lastAutoAt < MIN_AGE_BEFORE_NEW_MS) {
      return;
    }

    const body = composeMechanicalCheckpoint(_db, settings);
    if (!body) return;

    fs.mkdirSync(path.dirname(CHECKPOINT_FILE_PATH), { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE_PATH, body, "utf8");

    settings.set("checkpoint.last_auto_at", Date.now());
    settings.set("checkpoint.last_message_count", currentCount);

    console.log(`[auto-checkpoint] wrote CHECKPOINT.md (${Math.round(body.length / 1024)}KB, ${deltaMessages} new messages since last)`);
  } catch (err) {
    console.warn("[auto-checkpoint] run error:", err?.message);
  }
}

/**
 * Assemble a markdown snapshot of current server state.
 * No AI calls — pure DB + filesystem reads.
 */
function composeMechanicalCheckpoint(db, settings) {
  const now = new Date();
  const lines = [];

  lines.push("# Tarsee Session Checkpoint (auto)");
  lines.push(`*Written: ${now.toISOString()}*`);
  lines.push("*Source: auto-checkpoint (mechanical). Manual `/checkpoint` produces a richer, AI-synthesized handoff.*");
  lines.push("");

  // --- Recent conversations (last 24h) ---
  try {
    const convs = db.prepare(`
      SELECT c.id, c.title, c.model, c.updated_at,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS msg_count,
        (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at DESC LIMIT 1) AS last_user,
        (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'assistant' ORDER BY created_at DESC LIMIT 1) AS last_assistant
      FROM conversations c
      WHERE c.updated_at >= datetime('now', '-24 hours')
      ORDER BY c.updated_at DESC
      LIMIT 10
    `).all();

    if (convs.length) {
      lines.push("## Recent Conversations (last 24h)");
      for (const c of convs) {
        const stripTl = (s) => {
          let t = s || "";
          if (t.startsWith('{"__timeline":true')) {
            try { t = JSON.parse(t).text || ""; } catch {}
          }
          return t.replace(/^\[[^\]]+\]:\s*/, "");
        };
        lines.push(`### ${c.title || c.id} — ${c.model || "unknown"}`);
        lines.push(`- Updated: ${c.updated_at} · ${c.msg_count} messages`);
        if (c.last_user)      lines.push(`- Last user: "${stripTl(c.last_user).slice(0, 220)}"`);
        if (c.last_assistant) lines.push(`- Last reply: "${stripTl(c.last_assistant).slice(0, 220)}"`);
        lines.push("");
      }
    }
  } catch { /* ignore */ }

  // --- Memories added in last 24h ---
  try {
    const mems = db.prepare(`
      SELECT category, content, created_at
      FROM bot_memory
      WHERE created_at >= datetime('now', '-24 hours')
      ORDER BY created_at DESC
      LIMIT 30
    `).all();
    if (mems.length) {
      lines.push("## Memories Saved (last 24h)");
      for (const m of mems) {
        lines.push(`- **${m.category}**: ${m.content.slice(0, 200)}`);
      }
      lines.push("");
    }
  } catch { /* ignore */ }

  // --- Active cron jobs ---
  try {
    const jobs = settings.get("cron.jobs") || [];
    if (Array.isArray(jobs) && jobs.length) {
      lines.push("## Scheduled Cron Jobs");
      for (const j of jobs) {
        lines.push(`- \`${j.schedule}\` → ${j.name || j.id} · ${(j.prompt || "").slice(0, 140)}`);
      }
      lines.push("");
    }
  } catch { /* ignore */ }

  // --- Webhooks ---
  try {
    const hooks = settings.get("webhooks") || {};
    const entries = Object.entries(hooks);
    if (entries.length) {
      lines.push("## Registered Webhooks");
      for (const [id, hook] of entries) {
        lines.push(`- **${id}** → ${(hook.prompt || "").slice(0, 140)}`);
      }
      lines.push("");
    }
  } catch { /* ignore */ }

  // --- Current settings snapshot ---
  try {
    const provider = settings.get("ai.activeProvider") || "claude-code";
    const model = settings.get(`ai.${provider}.model`) || "default";
    const theme = settings.get("ui.theme") || "warm-charcoal";
    const pushSubs = (settings.get("push.subscriptions") || []).length;
    lines.push("## Current Settings");
    lines.push(`- Provider: ${provider} / Model: ${model}`);
    lines.push(`- Theme: ${theme}`);
    lines.push(`- Push subscriptions: ${pushSubs}`);
    lines.push("");
  } catch { /* ignore */ }

  // --- Workspace files touched recently ---
  try {
    const wsDir = config.WORKSPACE_DIR;
    if (fs.existsSync(wsDir)) {
      const recent = fs.readdirSync(wsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => {
          const full = path.join(wsDir, e.name);
          const s = fs.statSync(full);
          return { name: e.name, mtime: s.mtimeMs };
        })
        .filter((e) => Date.now() - e.mtime < 24 * 3600_000)
        .sort((a, b) => b.mtime - a.mtime);
      if (recent.length) {
        lines.push("## Workspace Files Edited (last 24h)");
        for (const f of recent) {
          lines.push(`- ${f.name} (${new Date(f.mtime).toISOString()})`);
        }
        lines.push("");
      }
    }
  } catch { /* ignore */ }

  // --- Tail ---
  lines.push("## Next Action on Reboot");
  lines.push("Greet the user briefly and confirm you've re-absorbed this checkpoint. Ask what they want to continue with — do NOT assume context on what to work on next beyond what's listed above. For a richer handoff, ask the user to run `/checkpoint` before the next redeploy.");
  lines.push("");

  return lines.join("\n");
}
