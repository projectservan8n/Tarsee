import { Router } from "express";
import { MemoryStore } from "../db/memory.js";

export const memoryRouter = Router();

/**
 * GET /api/memory
 * List memories. Optional ?category= and ?limit= query params.
 */
memoryRouter.get("/", (req, res) => {
  const db = req.app.get("db");
  const store = new MemoryStore(db);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const category = req.query.category || null;
  const memories = store.list(limit, category);
  res.json({ memories, total: store.count() });
});

/**
 * POST /api/memory
 * Add a new memory. Body: { content, category? }
 */
memoryRouter.post("/", (req, res) => {
  const { content, category, conversationId } = req.body || {};
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "Content is required" });
  }

  const db = req.app.get("db");
  const store = new MemoryStore(db);
  const memory = store.add(content.trim(), category || "preference", conversationId || null);
  res.status(201).json(memory);
});

/**
 * DELETE /api/memory/:id
 * Delete a memory by ID.
 */
memoryRouter.delete("/:id", (req, res) => {
  const db = req.app.get("db");
  const store = new MemoryStore(db);
  const deleted = store.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Memory not found" });
  res.json({ ok: true });
});

/**
 * GET /api/memory/search
 * Search memories. Query: ?q=search+term&limit=20
 */
memoryRouter.get("/search", (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Query param 'q' is required" });

  const db = req.app.get("db");
  const store = new MemoryStore(db);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const memories = store.search(q, limit);
  res.json({ memories });
});
