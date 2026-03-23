import { MemoryStore } from "../db/memory.js";
import { getSkillsPromptContext } from "./skills-engine.js";
import { getLearningHint } from "./personality-learner.js";
import { getBootstrapContext } from "./workspace-files.js";

const MAX_TOTAL_BYTES = 150 * 1024; // 150KB total prompt budget

/**
 * Build the effective system prompt from all sources.
 * Used by HTTP, WebSocket, Discord, Telegram, and Slack handlers.
 *
 * Composition order:
 *   1. AGENTS.md + SOUL.md + IDENTITY.md + USER.md + TOOLS.md + MEMORY.md (workspace files)
 *   2. DB memories (bot_memory table — supplementary)
 *   3. Skills context (SKILL.md files)
 *   4. Per-conversation prompt (if set)
 *   5. Channel hint (e.g. "You are in a Discord conversation")
 *   6. Learning hint (periodic nudge)
 *   7. Fallback if everything empty
 *
 * Individual files are truncated at 20KB. Total prompt capped at 150KB.
 *
 * @param {object} opts
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string|null} opts.conversationId
 * @param {number} opts.messageCount
 * @param {string|null} opts.conversationPrompt
 * @param {string} opts.channelHint
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
  // 1. Workspace files: AGENTS → SOUL → IDENTITY → USER → TOOLS → MEMORY
  const bootstrapContext = getBootstrapContext();

  // 2. DB memories (supplementary to MEMORY.md)
  const memoryStore = new MemoryStore(db);
  const dbMemoryContext = memoryStore.getContextString(20);

  // 3. Skills
  const skillsContext = getSkillsPromptContext();

  let prompt = "";

  if (bootstrapContext) {
    prompt = bootstrapContext;
  }

  if (dbMemoryContext) {
    prompt += dbMemoryContext;
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
    const identityName = settingsStore.get("identity.name") || "OpusClaw";
    prompt = `You are ${identityName}, a helpful AI assistant.`;
  }

  // Learning hints (zero API cost — just encourages memory extraction)
  if (conversationId && messageCount > 0) {
    const learningHint = getLearningHint(conversationId, messageCount);
    if (learningHint) prompt += learningHint;
  }

  // Enforce total budget
  if (Buffer.byteLength(prompt, "utf8") > MAX_TOTAL_BYTES) {
    prompt = prompt.slice(0, MAX_TOTAL_BYTES);
  }

  return prompt;
}
