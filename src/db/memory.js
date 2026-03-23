import crypto from "node:crypto";

/**
 * Persistent memory store for bot identity and learned preferences.
 * Memories survive across conversations and restarts.
 */
export class MemoryStore {
  constructor(db) {
    this.db = db;
    this._add = db.prepare(
      "INSERT INTO bot_memory (id, category, content, source_conversation_id) VALUES (?, ?, ?, ?)"
    );
    this._update = db.prepare(
      "UPDATE bot_memory SET content = ?, updated_at = datetime('now') WHERE id = ?"
    );
    this._list = db.prepare(
      "SELECT * FROM bot_memory ORDER BY updated_at DESC LIMIT ?"
    );
    this._listByCategory = db.prepare(
      "SELECT * FROM bot_memory WHERE category = ? ORDER BY updated_at DESC LIMIT ?"
    );
    this._search = db.prepare(
      "SELECT * FROM bot_memory WHERE content LIKE ? ORDER BY updated_at DESC LIMIT ?"
    );
    this._get = db.prepare("SELECT * FROM bot_memory WHERE id = ?");
    this._delete = db.prepare("DELETE FROM bot_memory WHERE id = ?");
    this._count = db.prepare("SELECT COUNT(*) as count FROM bot_memory");
  }

  add(content, category = "preference", conversationId = null) {
    const id = crypto.randomUUID();
    this._add.run(id, category, content, conversationId);
    return { id, category, content };
  }

  get(id) {
    return this._get.get(id) || null;
  }

  update(id, content) {
    return this._update.run(content, id).changes > 0;
  }

  list(limit = 50, category = null) {
    if (category) return this._listByCategory.all(category, limit);
    return this._list.all(limit);
  }

  search(query, limit = 20) {
    return this._search.all(`%${query}%`, limit);
  }

  delete(id) {
    return this._delete.run(id).changes > 0;
  }

  count() {
    return this._count.get().count;
  }

  /**
   * Build a context string for injection into system prompts.
   * Returns formatted memories or empty string if none.
   */
  getContextString(limit = 20) {
    const memories = this.list(limit);
    if (memories.length === 0) return "";

    const lines = memories.map((m) => `- [${m.category}] ${m.content}`);
    return `\n\nYou have the following memories from previous interactions:\n${lines.join("\n")}`;
  }
}
