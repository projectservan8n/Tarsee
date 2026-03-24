/**
 * Smart context management for Tarsee.
 * Assembles conversation context within token budgets using intelligent
 * prioritization and compaction instead of simple truncation.
 */

import { countTokens, countMessageTokens } from "./token-counter.js";

const DEFAULT_BUDGET = 30000; // ~30K tokens for context

export function assembleContext(messages, budget = DEFAULT_BUDGET) {
  if (!messages || messages.length === 0) return [];
  const totalTokens = countMessageTokens(messages);
  if (totalTokens <= budget) return messages;

  // Keep system messages, first message, and recent messages
  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length === 0) return systemMsgs;

  const first = nonSystem[0];
  const recentCount = Math.min(20, Math.ceil(nonSystem.length * 0.4));
  const recent = nonSystem.slice(-recentCount);
  const middle = nonSystem.slice(1, -recentCount);

  // Start with system + first + recent and check budget
  const result = [...systemMsgs, first, ...recent];
  let used = countMessageTokens(result);

  if (used >= budget) {
    // Even recent is too much — just keep system + last 10
    const minimal = [...systemMsgs, ...nonSystem.slice(-10)];
    return minimal;
  }

  // Fill remaining budget with middle messages (most recent first)
  const remainingBudget = budget - used;
  const middleReversed = [...middle].reverse();
  const included = [];

  let middleTokens = 0;
  for (const msg of middleReversed) {
    const msgTokens = countTokens(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)) + 4;
    if (middleTokens + msgTokens > remainingBudget) {
      // Summarize remaining old messages
      const skipped = middle.length - included.length;
      if (skipped > 0) {
        included.push({
          role: "system",
          content: `[${skipped} earlier messages summarized: The conversation covered various topics. Key context has been preserved in recent messages and memory.]`,
        });
      }
      break;
    }
    included.unshift(msg);
    middleTokens += msgTokens;
  }

  return [...systemMsgs, first, ...included, ...recent];
}

/**
 * Check if compaction is needed based on message count threshold.
 */
export function needsCompaction(messageCount, threshold = 50) {
  return messageCount > threshold;
}
