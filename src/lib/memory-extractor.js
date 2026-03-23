import { MemoryStore } from "../db/memory.js";

/**
 * Extract [REMEMBER: ...] markers from AI response text.
 * Saves each extracted memory to DB + MEMORY.md.
 * Returns the response with markers stripped out.
 *
 * @param {string} text - Full AI response text
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} conversationId
 * @returns {string} Cleaned text with markers removed
 */
export function extractAndSaveMemories(text, db, conversationId = null) {
  if (!text || !db) return text;

  const REMEMBER_REGEX = /\[REMEMBER:\s*(.+?)\]/gi;
  const matches = [...text.matchAll(REMEMBER_REGEX)];

  if (matches.length === 0) return text;

  try {
    const memoryStore = new MemoryStore(db);
    for (const match of matches) {
      const fact = match[1].trim();
      if (fact.length > 3) {
        memoryStore.addAndSync(fact, "learned", conversationId);
        console.log(`[memory] Auto-saved: "${fact.slice(0, 80)}"`);
      }
    }
  } catch (err) {
    console.warn("[memory] Failed to auto-save memories:", err.message);
  }

  // Strip markers from the response so user doesn't see them
  return text.replace(REMEMBER_REGEX, "").replace(/\n{3,}/g, "\n\n").trim();
}
