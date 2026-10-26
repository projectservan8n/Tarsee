/**
 * Analytics API — real-time metrics and usage stats.
 *
 *   GET  /api/analytics                  counts (conversations, messages, crons) and the process's memory
 *   GET  /api/analytics/usage            the Usage page's overview (lib/token-usage.js)
 *   GET  /api/analytics/usage/jobs       jobs, each with its turns
 *   POST /api/analytics/usage/jobs/:key  rename a job, merge it with the one before, split it again
 *   GET  /api/analytics/usage/chat/:id   a chat's total and each reply's turn
 *   GET  /api/analytics/usage/turn/:id   one turn's numbers
 */
import { Router } from "express";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { usageIndex } from "../lib/token-usage.js";

export const analyticsRouter = Router();

let convStore = null;
let settingsStore = null;

analyticsRouter.use((req, _res, next) => {
  if (!convStore) {
    const db = req.app.get("db");
    convStore = new ConversationStore(db);
    settingsStore = new SettingsStore(db);
  }
  next();
});

/**
 * GET /api/analytics
 * Returns comprehensive dashboard metrics.
 */
analyticsRouter.get("/", (req, res) => {
  const db = req.app.get("db");

  // System stats
  const mem = process.memoryUsage();
  const uptime = Math.floor(process.uptime());

  // Conversation stats
  const convCount = db.prepare("SELECT COUNT(*) as count FROM conversations").get()?.count || 0;
  const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages").get()?.count || 0;
  const todayMsgs = db.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE created_at >= date('now')"
  ).get()?.count || 0;

  // Token usage (all time + today + last 7 days)
  const tokenStats = db.prepare(`
    SELECT
      COALESCE(SUM(tokens_in), 0) as total_in,
      COALESCE(SUM(tokens_out), 0) as total_out,
      COALESCE(SUM(CASE WHEN created_at >= date('now') THEN tokens_in ELSE 0 END), 0) as today_in,
      COALESCE(SUM(CASE WHEN created_at >= date('now') THEN tokens_out ELSE 0 END), 0) as today_out,
      COALESCE(SUM(CASE WHEN created_at >= date('now', '-7 days') THEN tokens_in ELSE 0 END), 0) as week_in,
      COALESCE(SUM(CASE WHEN created_at >= date('now', '-7 days') THEN tokens_out ELSE 0 END), 0) as week_out
    FROM messages
  `).get() || {};

  // Messages per day (last 14 days)
  const dailyMessages = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count, role
    FROM messages
    WHERE created_at >= date('now', '-14 days')
    GROUP BY day, role
    ORDER BY day ASC
  `).all() || [];

  // Daily token usage (last 14 days)
  const dailyTokens = db.prepare(`
    SELECT date(created_at) as day,
      COALESCE(SUM(tokens_in), 0) as tokens_in,
      COALESCE(SUM(tokens_out), 0) as tokens_out
    FROM messages
    WHERE created_at >= date('now', '-14 days')
    GROUP BY day
    ORDER BY day ASC
  `).all() || [];

  // Model usage breakdown (Anthropic/Claude models only)
  const modelUsage = db.prepare(`
    SELECT model, COUNT(*) as count,
      COALESCE(SUM(tokens_in), 0) as tokens_in,
      COALESCE(SUM(tokens_out), 0) as tokens_out
    FROM messages
    WHERE model IS NOT NULL AND model LIKE 'claude%' AND created_at >= date('now', '-30 days')
    GROUP BY model
    ORDER BY count DESC
  `).all() || [];

  // Channel activity (from conversation titles/sources)
  const channelActivity = db.prepare(`
    SELECT
      CASE
        WHEN c.title LIKE 'telegram:%' THEN 'telegram'
        WHEN c.title LIKE 'discord:%' THEN 'discord'
        ELSE 'web'
      END as channel,
      COUNT(m.id) as messages
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.created_at >= date('now', '-7 days')
    GROUP BY channel
  `).all() || [];

  // Memory stats
  let memoryCount = 0;
  try {
    memoryCount = db.prepare("SELECT COUNT(*) as count FROM bot_memory").get()?.count || 0;
  } catch { /* table might not exist */ }

  // Cron job stats
  const cronJobs = settingsStore.get("cron.jobs") || [];
  const activeCrons = cronJobs.filter((j) => j.enabled !== false).length;

  // Active sessions (conversations with messages in last 2 hours)
  const activeSessions = db.prepare(
    "SELECT COUNT(DISTINCT conversation_id) as count FROM messages WHERE created_at >= datetime('now', '-2 hours')"
  ).get()?.count || 0;

  res.json({
    system: {
      uptime,
      memoryMB: Math.round(mem.rss / 1024 / 1024),
      heapMB: Math.round(mem.heapUsed / 1024 / 1024),
    },
    conversations: {
      total: convCount,
      activeSessions,
    },
    messages: {
      total: msgCount,
      today: todayMsgs,
      daily: dailyMessages,
    },
    tokens: {
      allTime: { in: tokenStats.total_in, out: tokenStats.total_out },
      today: { in: tokenStats.today_in, out: tokenStats.today_out },
      week: { in: tokenStats.week_in, out: tokenStats.week_out },
      daily: dailyTokens,
    },
    models: modelUsage,
    channels: channelActivity,
    memories: memoryCount,
    cron: { total: cronJobs.length, active: activeCrons },
  });
});

// ------------------------------------------------------------------ token usage (lib/token-usage.js)

const DAY = 86_400_000;
const JOBS_KEY = "usage.jobs";   // { names: { jobKey: name }, merges: { jobKey: keyOfTheJobBefore } }

function jobOverrides() {
  const o = settingsStore?.get(JOBS_KEY);
  return { names: { ...(o?.names || {}) }, merges: { ...(o?.merges || {}) } };
}

/** The index, with a read started if none has run since the server began. */
function freshIndex(db) {
  const index = usageIndex(db);
  if (!index.lastRefreshAt && !index.running) index.refresh();
  return index;
}

/** Wait a moment for a read in progress (not the first, long one), so a reply that just ended has its numbers. */
async function settle(index, ms = 2500) {
  if (!index.running || index.progress.firstPass) return;
  await Promise.race([index.running, new Promise((r) => setTimeout(r, ms))]);
}

/**
 * GET /api/analytics/usage
 * Today, the last 7 days, the last 5 hours, by model, channel and chat, the
 * heaviest jobs, speed, and each day and hour (in the configured timezone,
 * named in `timeZone`).
 */
analyticsRouter.get("/usage", (req, res) => {
  const db = req.app.get("db");
  const index = freshIndex(db);
  try {
    // windows: null. Nothing in this build reads the plan's own 5-hour and weekly limits, so those
    // cards are simply the last 5 hours and the last 7 days.
    res.json(index.overview({ windows: null, overrides: jobOverrides() }));
  } catch (err) {
    res.status(500).json({ error: `Could not add up the usage: ${err.message}` });
  }
});

/**
 * GET /api/analytics/usage/jobs?days=7&conversation=<id>
 * Jobs with a turn in the last `days` days (1 to 60), newest first, each with its turns.
 */
analyticsRouter.get("/usage/jobs", (req, res) => {
  const db = req.app.get("db");
  const index = freshIndex(db);
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
  const conversationId = typeof req.query.conversation === "string" && req.query.conversation ? req.query.conversation : null;
  const now = Date.now();
  try {
    const jobs = index.jobs({ from: now - days * DAY, conversationId, overrides: jobOverrides(), now });
    const titles = index.titles([...new Set(jobs.map((j) => j.conversationId))]);
    const turns = new Map(index.turnsBetween(now - (days + 1) * DAY, Number.MAX_SAFE_INTEGER, conversationId).map((t) => [t.turnId, t]));
    res.json({
      days, now, timeZone: index.timeZone, progress: index.status(),
      jobs: jobs.slice(0, 300).map((j) => ({
        ...j, chatTitle: titles[j.conversationId] || null,
        turnList: j.turnIds.map((id) => turns.get(id)).filter(Boolean).map((t) => index.turnView(t, now)),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: `Could not list the jobs: ${err.message}` });
  }
});

/**
 * POST /api/analytics/usage/jobs/:key   { name?: string, merge?: "previous", split?: true }
 * Name a job (an empty name clears it), merge it with the job before it in the
 * same chat, or split off what was merged into it.
 */
analyticsRouter.post("/usage/jobs/:key", (req, res) => {
  const db = req.app.get("db");
  const index = usageIndex(db);
  const key = String(req.params.key || "");
  const o = jobOverrides();
  const now = Date.now();
  const all = index.jobs({ from: 0, overrides: o, now });
  const job = all.find((j) => j.key === key);
  if (!job) return res.status(404).json({ error: "There is no such job." });
  const body = req.body || {};
  if (typeof body.name === "string") {
    const name = body.name.replace(/\s+/g, " ").trim().slice(0, 80);
    if (name) o.names[key] = name; else delete o.names[key];
  }
  if (body.merge === "previous") {
    const before = all.filter((j) => j.conversationId === job.conversationId && j.startedAt < job.startedAt).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!before) return res.status(400).json({ error: "There is no earlier job in this chat to merge it with." });
    o.merges[key] = before.key;
    if (o.names[key] && !o.names[before.key]) o.names[before.key] = o.names[key];
    delete o.names[key];
  }
  if (body.split) for (const k of job.mergedKeys || []) delete o.merges[k];
  settingsStore.set(JOBS_KEY, o);
  const jobs = index.jobs({ from: 0, conversationId: job.conversationId, overrides: o, now });
  res.json({ ok: true, job: jobs.find((j) => j.key === key || j.mergedKeys.includes(key)) || null });
});

/**
 * GET /api/analytics/usage/chat/:id
 * A chat's running total and each turn's numbers by the reply it ended in.
 */
analyticsRouter.get("/usage/chat/:id", async (req, res) => {
  const db = req.app.get("db");
  const index = freshIndex(db);
  await settle(index);
  try { res.json({ ...index.chat(String(req.params.id)), progress: index.status() }); } catch (err) {
    res.status(500).json({ error: `Could not add up this chat: ${err.message}` });
  }
});

/** GET /api/analytics/usage/turn/:id  One turn's numbers. */
analyticsRouter.get("/usage/turn/:id", async (req, res) => {
  const db = req.app.get("db");
  const index = freshIndex(db);
  await settle(index);
  const t = index.turn(String(req.params.id));
  if (!t) return res.status(404).json({ error: "No numbers for that turn yet." });
  res.json(t);
});
