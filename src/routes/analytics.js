/**
 * Analytics API — real-time metrics and usage stats.
 */
import { Router } from "express";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";

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

  // Model usage breakdown
  const modelUsage = db.prepare(`
    SELECT model, COUNT(*) as count,
      COALESCE(SUM(tokens_in), 0) as tokens_in,
      COALESCE(SUM(tokens_out), 0) as tokens_out
    FROM messages
    WHERE model IS NOT NULL AND created_at >= date('now', '-30 days')
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
