import { MemoryStore } from "../db/memory.js";

/**
 * Lightweight personality learner.
 *
 * Instead of making expensive background API calls, we:
 * 1. Track conversation message counts
 * 2. Every N messages, append a subtle hint to the next system prompt
 *    asking the AI to use /remember if it notices something worth saving
 * 3. The AI can call /remember via the command system to save memories
 *
 * This approach is:
 * - Zero extra API cost (no background calls)
 * - Zero extra RAM (just a counter)
 * - Works on Raspberry Pi
 */

// Message counts per conversation (in-memory, resets on restart — that's fine)
const counters = new Map();
const LEARN_INTERVAL = 10; // Every 10 messages, nudge the AI

/**
 * Track a message and return an optional learning hint to append to the system prompt.
 * @param {string} conversationId
 * @param {number} messageCount - total messages in this conversation
 * @returns {string} Optional hint to append to system prompt, or empty string
 */
export function getLearningHint(conversationId, messageCount) {
  const prev = counters.get(conversationId) || 0;
  const current = messageCount;
  counters.set(conversationId, current);

  // Only add hint at intervals
  if (current > 0 && current % LEARN_INTERVAL === 0 && current !== prev) {
    return LEARNING_HINT;
  }
  return "";
}

/**
 * Clean up counter for a deleted conversation.
 */
export function clearCounter(conversationId) {
  counters.delete(conversationId);
}

const LEARNING_HINT = `

[Internal note: If you've noticed any user preferences, communication style patterns, or important facts during this conversation that would be useful to remember for future conversations, mention them naturally or suggest saving them. The user can add memories in Settings.]`;
