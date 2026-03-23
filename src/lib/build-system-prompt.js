import { MemoryStore } from "../db/memory.js";
import { getSkillsPromptContext } from "./skills-engine.js";
import { getLearningHint } from "./personality-learner.js";

/**
 * Build the effective system prompt from all sources.
 * Used by HTTP, WebSocket, Discord, Telegram, and Slack handlers.
 *
 * @param {object} opts
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string|null} opts.conversationId - Current conversation ID (for learning hints)
 * @param {number} opts.messageCount - Number of messages in conversation (for learning hints)
 * @param {string|null} opts.conversationPrompt - Per-conversation system prompt
 * @param {string} opts.channelHint - Extra context like "You are in a Discord conversation."
 * @returns {string}
 */
export function buildSystemPrompt({
  settingsStore,
  db,
  conversationId = null,
  messageCount = 0,
  conversationPrompt = null,
  channelHint = "",
}) {
  const identityName = settingsStore.get("identity.name") || "OpusClaw";
  const globalPrompt = settingsStore.get("identity.systemPrompt") || "";
  const memoryStore = new MemoryStore(db);
  const memoryContext = memoryStore.getContextString(20);
  const skillsContext = getSkillsPromptContext();

  let prompt = "";

  if (globalPrompt) {
    prompt = globalPrompt;
  }

  if (memoryContext) {
    prompt += memoryContext;
  }

  if (skillsContext) {
    prompt += skillsContext;
  }

  if (conversationPrompt) {
    prompt += (prompt ? "\n\n" : "") + conversationPrompt;
  }

  if (channelHint) {
    prompt += (prompt ? "\n\n" : "") + channelHint;
  }

  if (!prompt) {
    prompt = `You are ${identityName}, a helpful AI assistant.`;
  }

  // Learning hints (zero API cost — just encourages memory extraction)
  if (conversationId && messageCount > 0) {
    const learningHint = getLearningHint(conversationId, messageCount);
    if (learningHint) prompt += learningHint;
  }

  return prompt;
}
