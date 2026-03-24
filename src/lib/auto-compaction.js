/**
 * Automatic context compaction for Tarsee.
 * Summarizes old message segments to reduce context size while preserving meaning.
 */

import { chatStream } from "../ai/router.js";

// In-memory compaction cache (conversation_id:range -> summary)
const compactionCache = new Map();

export async function compactMessages(messages, { provider, apiKey, model, baseUrl }) {
  if (!messages || messages.length < 10) return null;

  const cacheKey = messages.map((m) => m.content?.slice?.(0, 20) || "").join("|").slice(0, 200);
  if (compactionCache.has(cacheKey)) return compactionCache.get(cacheKey);

  const textToSummarize = messages
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[complex content]"}`)
    .join("\n")
    .slice(0, 8000);

  const summaryPrompt = `Summarize this conversation segment concisely (2-4 sentences). Preserve key facts, decisions, and context:\n\n${textToSummarize}`;

  let summary = "";
  try {
    const stream = chatStream({
      provider,
      model,
      apiKey,
      baseUrl,
      messages: [{ role: "user", content: summaryPrompt }],
      systemPrompt: "You are a conversation summarizer. Be concise and preserve important details.",
    });
    for await (const event of stream) {
      if (event.type === "text") summary += event.content;
    }
  } catch (err) {
    console.warn("[compaction] summary generation failed:", err.message);
    return null;
  }

  if (summary) {
    compactionCache.set(cacheKey, summary);
    // Limit cache size
    if (compactionCache.size > 100) {
      const first = compactionCache.keys().next().value;
      compactionCache.delete(first);
    }
  }

  return summary || null;
}

export function clearCompactionCache() {
  compactionCache.clear();
}
