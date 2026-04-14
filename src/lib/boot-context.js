/**
 * Boot context — persists and restores conversation context across redeploys.
 * Saves a lightweight summary of recent activity so Claude knows what's up after restart.
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";

const CONTEXT_FILE = path.join(config.WORKSPACE_DIR, ".boot-context.json");

/**
 * Save current activity context (called periodically and on graceful shutdown).
 * Stores: last active channels, recent topics, timestamp.
 */
export function saveBootContext(db) {
  try {
    // Get the 3 most recent conversations with their last messages
    const recentConvs = db.prepare(`
      SELECT c.id, c.title, c.model, c.updated_at,
        (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at DESC LIMIT 1) as last_user_msg,
        (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'assistant' ORDER BY created_at DESC LIMIT 1) as last_assistant_msg
      FROM conversations c
      ORDER BY c.updated_at DESC
      LIMIT 3
    `).all();

    // Get message count today
    const todayMsgs = db.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE created_at >= date('now')"
    ).get()?.count || 0;

    const context = {
      savedAt: new Date().toISOString(),
      todayMessages: todayMsgs,
      recentConversations: recentConvs.map(c => {
        // Extract plain text from timeline JSON
        let lastUser = c.last_user_msg || "";
        let lastAssistant = c.last_assistant_msg || "";
        if (lastAssistant.startsWith('{"__timeline":true')) {
          try { lastAssistant = JSON.parse(lastAssistant).text || ""; } catch {}
        }
        return {
          title: c.title,
          model: c.model,
          updatedAt: c.updated_at,
          lastUserMessage: lastUser.slice(0, 300),
          lastAssistantResponse: lastAssistant.slice(0, 300),
        };
      }),
    };

    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));
  } catch (err) {
    console.warn("[boot-context] Failed to save:", err.message);
  }
}

/**
 * Load boot context (called on startup to inject into system prompt).
 * Returns a short string summary for the system prompt, or empty string.
 */
export function getBootContextSummary() {
  try {
    if (!fs.existsSync(CONTEXT_FILE)) return "";
    const raw = fs.readFileSync(CONTEXT_FILE, "utf8");
    const ctx = JSON.parse(raw);

    if (!ctx.recentConversations?.length) return "";

    const age = Date.now() - new Date(ctx.savedAt).getTime();
    const ageStr = age < 3600000 ? `${Math.round(age / 60000)}min` : `${Math.round(age / 3600000)}h`;

    let summary = `\n\n## Boot Context (server restarted ${ageStr} ago)`;
    summary += `\nMessages today: ${ctx.todayMessages}`;

    for (const conv of ctx.recentConversations) {
      const convAge = Date.now() - new Date(conv.updatedAt).getTime();
      if (convAge > 24 * 3600000) continue; // Skip conversations older than 24h
      summary += `\n\n**${conv.title}** (${conv.model || "unknown"}, ${new Date(conv.updatedAt).toLocaleTimeString()}):`;
      if (conv.lastUserMessage) summary += `\n- User: "${conv.lastUserMessage.slice(0, 150)}"`;
      if (conv.lastAssistantResponse) summary += `\n- You replied: "${conv.lastAssistantResponse.slice(0, 150)}"`;
    }

    return summary;
  } catch {
    return "";
  }
}
