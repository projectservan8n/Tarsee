import crypto from "node:crypto";

/**
 * Conversation and message CRUD operations.
 * All methods are synchronous (better-sqlite3 is sync).
 */
export class ConversationStore {
  constructor(db) {
    this.db = db;
    this._prepareStatements();
  }

  _prepareStatements() {
    this._listConversations = this.db.prepare(
      "SELECT id, title, provider, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    );
    this._getConversation = this.db.prepare(
      "SELECT * FROM conversations WHERE id = ?"
    );
    this._createConversation = this.db.prepare(
      "INSERT INTO conversations (id, title, provider, model, system_prompt) VALUES (?, ?, ?, ?, ?)"
    );
    this._updateTitle = this.db.prepare(
      "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?"
    );
    this._updateConversation = this.db.prepare(
      "UPDATE conversations SET provider = ?, model = ?, system_prompt = ?, updated_at = datetime('now') WHERE id = ?"
    );
    this._deleteConversation = this.db.prepare(
      "DELETE FROM conversations WHERE id = ?"
    );
    this._getMessages = this.db.prepare(
      "SELECT id, role, content, provider, model, tokens_in, tokens_out, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
    );
    this._getRecentMessages = this.db.prepare(
      "SELECT id, role, content, provider, model, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?"
    );
    this._addMessage = this.db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, provider, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    this._deleteMessage = this.db.prepare(
      "DELETE FROM messages WHERE id = ? AND conversation_id = ?"
    );
    this._touchConversation = this.db.prepare(
      "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
    );
    this._countMessages = this.db.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?"
    );
    this._updateClaudeSessionId = this.db.prepare(
      "UPDATE conversations SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    );
    this._clearAllSessions = this.db.prepare(
      "UPDATE conversations SET claude_session_id = NULL WHERE claude_session_id IS NOT NULL"
    );
    this._searchMessages = this.db.prepare(`
      SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
             c.title as conversation_title,
             snippet(messages_fts, 0, '<mark>', '</mark>', '...', 48) as snippet
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
  }

  /**
   * Clear all session IDs — forces fresh sessions on next message.
   * Called on server boot to prevent stale MCP tool registrations.
   */
  clearAllSessions() {
    const result = this._clearAllSessions.run();
    if (result.changes > 0) {
      console.log(`[sessions] Cleared ${result.changes} stale session(s) on boot`);
    }
  }

  /**
   * List conversations with pagination.
   */
  list(limit = 50, offset = 0) {
    return this._listConversations.all(limit, offset);
  }

  /**
   * Get a single conversation by ID.
   */
  get(id) {
    return this._getConversation.get(id) || null;
  }

  /**
   * Create a new conversation.
   */
  create({ title, provider, model, systemPrompt } = {}) {
    const id = crypto.randomUUID();
    this._createConversation.run(
      id,
      title || "New conversation",
      provider || null,
      model || null,
      systemPrompt || null
    );
    return this.get(id);
  }

  /**
   * Update conversation title.
   */
  updateTitle(id, title) {
    this._updateTitle.run(title, id);
  }

  /**
   * Update conversation settings.
   */
  update(id, { provider, model, systemPrompt }) {
    this._updateConversation.run(provider || null, model || null, systemPrompt || null, id);
  }

  /**
   * Delete a conversation and all its messages (cascade).
   */
  delete(id) {
    return this._deleteConversation.run(id).changes > 0;
  }

  /**
   * Get all messages in a conversation.
   */
  getMessages(conversationId) {
    return this._getMessages.all(conversationId);
  }

  /**
   * Get the N most recent messages (returned in chronological order).
   */
  getRecentMessages(conversationId, limit = 20) {
    const rows = this._getRecentMessages.all(conversationId, limit);
    return rows.reverse(); // chronological order
  }

  /**
   * Session recap — if the conversation has been idle for >= staleMinutes,
   * return a short human-readable "last time we..." summary. Used when a
   * client resumes an old conversation on a new device.
   *
   * Lazy-synthesizes via summarizeConversation() from auto-summarize.js,
   * which is a cheap extractive summary (no AI call). Returns null when:
   *   - conversation doesn't exist
   *   - last activity < staleMinutes ago (no recap needed)
   *   - conversation has < 3 messages (nothing to summarize)
   */
  async getSessionRecap(conversationId, staleMinutes = 30) {
    const conv = this.get(conversationId);
    if (!conv) return null;
    if (!conv.updated_at) return null;

    // SQLite's datetime('now') stores naive UTC ('YYYY-MM-DD HH:MM:SS' with no
    // trailing Z). new Date() parses that as LOCAL time, so on a non-UTC host
    // every row appears N hours stale even when just written. Force UTC.
    const updated = new Date(conv.updated_at + "Z").getTime();
    if (Number.isNaN(updated)) return null;
    const ageMs = Date.now() - updated;
    if (ageMs < staleMinutes * 60_000) return null;

    const msgCount = this.messageCount(conversationId);
    if (msgCount < 3) return null;

    // Pull a fresh summary — summarizeConversation is defensive (returns
    // {skipped: true} if anything's wrong) so we just check ok.
    try {
      const { summarizeConversation } = await import("../lib/auto-summarize.js");
      const result = summarizeConversation(this.db, conversationId);
      if (!result?.ok) return null;

      // summarizeConversation writes a section to memory/summaries.md.
      // For the wire format we return just the synthesized text: topics +
      // last assistant response, which is what the user wants to see.
      const messages = this.getRecentMessages(conversationId, 15);
      const stripTimeline = (content) => {
        let c = content || "";
        if (c.startsWith('{"__timeline":true')) {
          try { c = JSON.parse(c).text || ""; } catch {}
        }
        return c;
      };
      const userMsgs = messages
        .filter((m) => m.role === "user")
        .slice(-3)
        .map((m) => stripTimeline(m.content).replace(/^\[[^\]]+\]:\s*/, "").slice(0, 140));
      const lastAssistant = messages
        .filter((m) => m.role === "assistant")
        .slice(-1)
        .map((m) => stripTimeline(m.content).slice(0, 220))[0] || "";

      const ageHrs = Math.round(ageMs / 3_600_000);
      const ageLabel = ageHrs < 1 ? "< 1 hr" : ageHrs < 24 ? `${ageHrs} hr` : `${Math.round(ageHrs / 24)} days`;

      return {
        text: [
          `Last active ${ageLabel} ago · ${msgCount} messages total.`,
          userMsgs.length ? `You were asking about: ${userMsgs.join(" · ")}` : null,
          lastAssistant ? `Last response: ${lastAssistant}` : null,
        ].filter(Boolean).join("\n"),
        ageMs,
        messageCount: msgCount,
        at: new Date().toISOString(),
      };
    } catch (err) {
      console.warn("[conv] getSessionRecap error:", err?.message);
      return null;
    }
  }

  /**
   * Add a message to a conversation.
   */
  addMessage(conversationId, { role, content, provider, model, tokensIn, tokensOut }) {
    const id = crypto.randomUUID();
    this._addMessage.run(id, conversationId, role, content, provider || null, model || null, tokensIn || null, tokensOut || null);
    this._touchConversation.run(conversationId);
    return { id, conversationId, role, content };
  }

  /**
   * Delete a specific message.
   */
  deleteMessage(conversationId, messageId) {
    return this._deleteMessage.run(messageId, conversationId).changes > 0;
  }

  /**
   * Get message count for a conversation.
   */
  messageCount(conversationId) {
    return this._countMessages.get(conversationId)?.count || 0;
  }

  /**
   * Update the Claude Code CLI session ID for a conversation.
   * This allows resuming the session later.
   */
  setClaudeSessionId(conversationId, claudeSessionId) {
    this._updateClaudeSessionId.run(claudeSessionId, conversationId);
  }

  /**
   * Full-text search across all messages.
   * Returns matching messages with conversation title and highlighted snippet.
   */
  search(query, limit = 30) {
    if (!query || !query.trim()) return [];
    // Escape FTS5 special chars and add prefix matching
    const escaped = query.trim().replace(/['"]/g, "").replace(/\s+/g, " ");
    const ftsQuery = escaped.split(" ").map(w => `"${w}"*`).join(" ");
    try {
      return this._searchMessages.all(ftsQuery, limit);
    } catch {
      return [];
    }
  }

  /**
   * Get the Claude Code CLI session ID for a conversation.
   * Returns null if session is stale (idle > 2 hours) to force fresh start.
   */
  getClaudeSessionId(conversationId) {
    const conv = this.get(conversationId);
    if (!conv?.claude_session_id) return null;

    // Session idle timeout: if no messages in 2 hours, start fresh
    const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
    const updatedAt = conv.updated_at ? new Date(conv.updated_at + "Z").getTime() : 0;
    if (Date.now() - updatedAt > IDLE_TIMEOUT_MS) {
      console.log(`[session] Session for conv ${conversationId} expired (idle > 2h), starting fresh`);
      this._updateClaudeSessionId.run(null, conversationId);
      return null;
    }

    return conv.claude_session_id;
  }
}
