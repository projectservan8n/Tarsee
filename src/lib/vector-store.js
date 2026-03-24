import { cosineSimilarity } from "./embeddings.js";

export function initVectorTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      embedding BLOB NOT NULL,
      provider TEXT NOT NULL DEFAULT 'unknown',
      model TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (memory_id) REFERENCES bot_memory(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_vectors_memory ON memory_vectors(memory_id);
    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export class VectorStore {
  constructor(db) {
    this.db = db;
  }

  storeEmbedding(memoryId, embedding, provider = "unknown", model = "unknown") {
    if (!embedding) return;
    const blob = Buffer.from(embedding.buffer);
    this.db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(memoryId);
    this.db.prepare("INSERT INTO memory_vectors (memory_id, embedding, provider, model) VALUES (?, ?, ?, ?)").run(memoryId, blob, provider, model);
  }

  getEmbedding(memoryId) {
    const row = this.db.prepare("SELECT embedding FROM memory_vectors WHERE memory_id = ?").get(memoryId);
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }

  vectorSearch(queryEmbedding, topK = 10) {
    if (!queryEmbedding) return [];
    const rows = this.db.prepare("SELECT memory_id, embedding FROM memory_vectors").all();
    const scored = [];
    for (const row of rows) {
      const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const sim = cosineSimilarity(queryEmbedding, stored);
      scored.push({ memoryId: row.memory_id, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  deleteEmbedding(memoryId) {
    this.db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(memoryId);
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) as count FROM memory_vectors").get().count;
  }

  getEmbeddedMemoryIds() {
    return this.db.prepare("SELECT memory_id FROM memory_vectors").all().map((r) => r.memory_id);
  }
}
