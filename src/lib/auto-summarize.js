/**
 * Auto-summarize idle conversations.
 * When a conversation has been idle for 2+ hours and has 5+ messages,
 * generate a brief summary and save to memory/summaries.md.
 * This gives Claude searchable context about past conversations.
 */

import { ConversationStore } from "../db/conversations.js";
import { appendWorkspaceFile } from "./workspace-files.js";

const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const MIN_MESSAGES = 5;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes

let _interval = null;
let _summarizedIds = new Set(); // Track already-summarized conversations this session

/**
 * Check for idle conversations and summarize them.
 */
export function checkAndSummarize(db) {
  try {
    const convStore = new ConversationStore(db);

    // Find conversations updated in the last 24h but idle for 2+ hours
    const cutoff = new Date(Date.now() - IDLE_THRESHOLD_MS).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const idle = db.prepare(`
      SELECT id, title, updated_at FROM conversations
      WHERE updated_at < ? AND updated_at > ?
      ORDER BY updated_at DESC
      LIMIT 10
    `).all(cutoff, dayAgo);

    for (const conv of idle) {
      if (_summarizedIds.has(conv.id)) continue;

      const msgCount = convStore.messageCount(conv.id);
      if (msgCount < MIN_MESSAGES) continue;

      // Get last few messages for summary
      const messages = convStore.getRecentMessages(conv.id, 10);
      if (!messages.length) continue;

      // Build a simple extractive summary (no AI call — just key messages)
      const userMsgs = messages.filter(m => m.role === "user").map(m => {
        let content = m.content || "";
        // Strip timeline JSON
        if (content.startsWith('{"__timeline":true')) {
          try { content = JSON.parse(content).text || ""; } catch {}
        }
        return content.slice(0, 150);
      });

      const assistantMsgs = messages.filter(m => m.role === "assistant").map(m => {
        let content = m.content || "";
        if (content.startsWith('{"__timeline":true')) {
          try { content = JSON.parse(content).text || ""; } catch {}
        }
        return content.slice(0, 150);
      });

      if (userMsgs.length === 0) continue;

      // Format summary
      const date = new Date(conv.updated_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const topics = userMsgs.slice(0, 3).join(" | ");
      const lastResponse = assistantMsgs[assistantMsgs.length - 1] || "";

      const summary = `### ${date} — ${conv.title || "Untitled"} (${msgCount} msgs)\n- Topics: ${topics}\n- Last: ${lastResponse.slice(0, 200)}\n`;

      // Append to summaries file
      appendWorkspaceFile("memory/summaries.md", "\n" + summary);
      _summarizedIds.add(conv.id);

      console.log(`[auto-summarize] Summarized: "${conv.title}" (${msgCount} msgs)`);
    }
  } catch (err) {
    console.warn("[auto-summarize] Error:", err.message);
  }
}

/**
 * Start the auto-summarize interval.
 */
export function startAutoSummarize(db) {
  // Run once on startup
  setTimeout(() => checkAndSummarize(db), 10_000);
  // Then every 30 minutes
  _interval = setInterval(() => checkAndSummarize(db), CHECK_INTERVAL_MS);
}

/**
 * Stop the auto-summarize interval.
 */
export function stopAutoSummarize() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}
