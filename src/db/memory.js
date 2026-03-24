import crypto from "node:crypto";
import { appendWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from "../lib/workspace-files.js";

/**
 * Persistent memory store for bot identity and learned preferences.
 * Memories survive across conversations and restarts.
 * Syncs to MEMORY.md file on the workspace volume.
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
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    // Build a query that fetches any row matching at least one word
    const conditions = words.map(() => "LOWER(content) LIKE ?").join(" OR ");
    const params = words.map((w) => `%${w}%`);

    const rows = this.db
      .prepare(
        `SELECT * FROM bot_memory WHERE ${conditions} ORDER BY updated_at DESC`
      )
      .all(...params);

    // Score each row by how many query words it matches
    const scored = rows.map((row) => {
      const lower = row.content.toLowerCase();
      const score = words.reduce(
        (acc, w) => acc + (lower.includes(w) ? 1 : 0),
        0
      );
      return { ...row, score };
    });

    // Sort by score descending, then by recency (updated_at descending)
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });

    return scored.slice(0, limit);
  }

  delete(id) {
    return this._delete.run(id).changes > 0;
  }

  count() {
    return this._count.get().count;
  }

  /**
   * Get memories filtered by category, ordered by most recent.
   */
  getRecentByCategory(category, limit = 10) {
    return this._listByCategory.all(category, limit);
  }

  /**
   * Merge duplicate/similar memories (first 50 chars match).
   * Keeps the most recent duplicate, deletes older ones.
   * Returns the count of removed duplicates.
   */
  consolidate() {
    const all = this.db
      .prepare("SELECT * FROM bot_memory ORDER BY updated_at DESC")
      .all();

    const seen = new Map(); // prefix -> most-recent row id
    const toDelete = [];

    for (const row of all) {
      const prefix = row.content.substring(0, 50).toLowerCase().trim();
      if (seen.has(prefix)) {
        // This row is older (list is sorted DESC), so mark it for deletion
        toDelete.push(row.id);
      } else {
        seen.set(prefix, row.id);
      }
    }

    if (toDelete.length > 0) {
      const deleteStmt = this.db.prepare("DELETE FROM bot_memory WHERE id = ?");
      const batch = this.db.transaction((ids) => {
        for (const id of ids) deleteStmt.run(id);
      });
      batch(toDelete);
    }

    return toDelete.length;
  }

  /**
   * Return memory statistics: total count, count by category,
   * oldest and newest memory dates.
   */
  getStats() {
    const total = this._count.get().count;

    const categoryRows = this.db
      .prepare(
        "SELECT category, COUNT(*) as count FROM bot_memory GROUP BY category ORDER BY count DESC"
      )
      .all();
    const byCategory = Object.fromEntries(
      categoryRows.map((r) => [r.category, r.count])
    );

    const oldest = this.db
      .prepare("SELECT created_at FROM bot_memory ORDER BY created_at ASC LIMIT 1")
      .get();
    const newest = this.db
      .prepare("SELECT created_at FROM bot_memory ORDER BY created_at DESC LIMIT 1")
      .get();

    return {
      total,
      byCategory,
      oldestDate: oldest?.created_at || null,
      newestDate: newest?.created_at || null,
    };
  }

  /**
   * Build a context string for injection into system prompts.
   * Returns formatted memories or empty string if none.
   * These are supplementary to MEMORY.md (which is the primary source).
   */
  getContextString(limit = 20) {
    const memories = this.list(limit);
    if (memories.length === 0) return "";

    const lines = memories.map((m) => `- [${m.category}] ${m.content}`);
    return `\n\nAdditional quick memories:\n${lines.join("\n")}`;
  }

  /**
   * Add a memory and also append it to MEMORY.md file.
   */
  addAndSync(content, category = "preference", conversationId = null) {
    const result = this.add(content, category, conversationId);
    try {
      appendWorkspaceFile("MEMORY.md", `\n- [${category}] ${content}`);
    } catch {
      // best-effort file sync
    }
    return result;
  }

  /**
   * One-time migration: export all DB memories to MEMORY.md if the file
   * is still the default template but DB has entries.
   */
  syncToMemoryFile() {
    try {
      const existing = readWorkspaceFile("MEMORY.md");
      const memories = this.list(100);
      if (memories.length === 0) return;

      // Only migrate if MEMORY.md is still the default template
      if (existing.includes("<!-- Curated memories are stored here -->") && !existing.includes("- [")) {
        const lines = memories.map((m) => `- [${m.category}] ${m.content}`);
        const content = `# Long-Term Memory\n\n${lines.join("\n")}\n`;
        writeWorkspaceFile("MEMORY.md", content);
        console.log(`[memory] Migrated ${memories.length} DB memories to MEMORY.md`);
      }
    } catch (err) {
      console.warn("[memory] syncToMemoryFile error:", err.message);
    }
  }
}
