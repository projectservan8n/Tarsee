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
   * Get the Claude Code CLI session ID for a conversation.
   */
  getClaudeSessionId(conversationId) {
    const conv = this.get(conversationId);
    return conv?.claude_session_id || null;
  }
}
