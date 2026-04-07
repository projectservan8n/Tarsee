import { MemoryStore } from "../db/memory.js";
import { getSkillsPromptContext } from "./skills-engine.js";
import { getLearningHint } from "./personality-learner.js";
import { getBootstrapContext, readWorkspaceFile } from "./workspace-files.js";

const MAX_TOTAL_BYTES = 50 * 1024; // 50KB total prompt budget (trimmed from 150KB)

/**
 * Build the effective system prompt from all sources.
 * Used by HTTP, WebSocket, Discord, Telegram, and Slack handlers.
 *
 * Composition order:
 *   1. AGENTS.md + SOUL.md + IDENTITY.md + USER.md + TOOLS.md + MEMORY.md (workspace files)
 *   2. Memory instructions (how to use memory system)
 *   3. DB memories (bot_memory table — supplementary)
 *   4. Skills context (SKILL.md files)
 *   5. Per-conversation prompt (if set)
 *   6. Channel hint (e.g. "You are in a Discord conversation")
 *   7. Learning hint (periodic nudge)
 *   8. Fallback if everything empty
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

  // 2. DB memories (brief supplementary — top 10 instead of 20)
  const memoryStore = new MemoryStore(db);
  const dbMemoryContext = memoryStore.getContextString(10);

  // 3. Skills (just names)
  const skillsContext = getSkillsPromptContext();

  // 4. Today's daily log only (yesterday accessible via tools if needed)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayLog = readWorkspaceFile(`memory/${todayStr}.md`);

  let dailyLogsContext = "";
  if (todayLog) {
    // Only last 2KB of today's log — most recent entries
    const trimmed = todayLog.length > 2048 ? todayLog.slice(-2048) : todayLog;
    dailyLogsContext = `\n\n## Today's Log (${todayStr})\n${trimmed.trim()}`;
  }

  // Build lightweight context — no tool lists or memory instructions (handled by tarseeContext in claude-code.js)
  let prompt = "";

  if (bootstrapContext) {
    prompt = bootstrapContext;
  }

  // Inject daily memory logs (today + yesterday only)
  if (dailyLogsContext) {
    prompt += dailyLogsContext;
  }

  // DB memories (brief supplementary context)
  if (dbMemoryContext) {
    prompt += dbMemoryContext;
  }

  // Skills list (just names, not full docs)
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
    const identityName = settingsStore.get("identity.name") || "Tarsee";
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
