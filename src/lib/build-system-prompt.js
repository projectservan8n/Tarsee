import { MemoryStore } from "../db/memory.js";
import { getSkillsPromptContext } from "./skills-engine.js";
import { getLearningHint } from "./personality-learner.js";
import { getBootstrapContext, readWorkspaceFile } from "./workspace-files.js";

const MAX_TOTAL_BYTES = 150 * 1024; // 150KB total prompt budget

/**
 * Memory & capabilities instruction block.
 * Tells the AI about its memory system and how to use it.
 */
const CAPABILITY_INSTRUCTIONS = `

## Your Capabilities

You have access to real tools via native function calling. The system will execute them and return results.

**Available tools:**
- **read_file** — Read workspace files (SOUL.md, MEMORY.md, etc.) and daily logs
- **write_file** — Update workspace files (personality, identity, memory, rules)
- **list_files** — List all workspace files and sizes
- **remember** — Save facts/preferences to long-term memory
- **daily_log** — Append timestamped notes to today's log
- **exec** — Run shell commands on the server (system tasks, scripts, Playwright)
- **web_fetch** — Fetch URLs (APIs, web pages, data)
- **search_memories** — Search stored memories

**CRITICAL tool use rules:**
- ALWAYS use tools instead of guessing or describing what you would do. Actually DO it.
- When asked about files, paths, or system info: call exec or list_files — do NOT guess paths like "/app"
- When asked to remember something: call the remember tool — do NOT just say you'll remember it
- When asked about your config/memory: call read_file — do NOT quote from the system prompt
- exec commands run in a sandboxed shell with a 60s timeout
- Do NOT output XML tool blocks like <function_calls> or <tool_call> in your text — use the native tool calling mechanism provided by the API
- If you're unsure about something on the system, use exec to check rather than guessing
- You have REAL tools that execute on the server. Use them.
`;

const MEMORY_INSTRUCTIONS = `

## Memory & Learning

You have persistent long-term memory that survives across conversations and restarts.

**Your memory sources:**
- **MEMORY.md** — your main memory file (injected above as "Long-Term Memory")
- **USER.md** — facts about your user (injected above as "About the User")
- **DB memories** — quick indexed memories (shown as "Additional quick memories" below)

**How to remember things:**
When you learn something important about the user — preferences, facts, names, projects, decisions, communication style, recurring topics — you MUST save it by including a memory marker in your response:

\`[REMEMBER: brief fact to save]\`

Examples:
- \`[REMEMBER: User's name is Karl, works in construction tech]\`
- \`[REMEMBER: Prefers concise responses, no fluff]\`
- \`[REMEMBER: Main project is Worksite360 — construction management platform]\`
- \`[REMEMBER: Uses Railway for deployments, GitHub for code]\`

These markers are automatically extracted and saved to your memory. The user won't see them.
You can include multiple [REMEMBER: ...] markers in a single response.

**When to remember:**
- User tells you their name, role, company, or preferences
- User corrects you or clarifies something important
- Important decisions or conclusions from conversations
- Recurring topics or projects the user works on
- Communication style preferences (formal/casual/technical)

**When NOT to remember:**
- Trivial or temporary information (today's weather, a one-off question)
- Things already in your memory (avoid duplicates)
- Sensitive data like passwords, API keys, or secrets

**The user can also:**
- Type \`/remember [fact]\` to manually save a memory
- Type \`/forget\` to list stored memories
- Edit MEMORY.md directly in Settings > Workspace

**Always reference your memories** when relevant. If the user asks about something you've discussed before, check your memory context above first.`;

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

  // 2. DB memories (supplementary to MEMORY.md)
  const memoryStore = new MemoryStore(db);
  const dbMemoryContext = memoryStore.getContextString(20);

  // 3. Skills
  const skillsContext = getSkillsPromptContext();

  // 4. Daily memory logs (today + yesterday)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const fmt = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD
  const todayStr = fmt(today);
  const yesterdayStr = fmt(yesterday);

  const todayLog = readWorkspaceFile(`memory/${todayStr}.md`);
  const yesterdayLog = readWorkspaceFile(`memory/${yesterdayStr}.md`);

  let dailyLogsContext = "";
  if (todayLog || yesterdayLog) {
    dailyLogsContext = "\n\n## Recent Daily Logs";
    if (yesterdayLog) {
      dailyLogsContext += `\n### ${yesterdayStr}\n${yesterdayLog.trim()}`;
    }
    if (todayLog) {
      dailyLogsContext += `\n### ${todayStr}\n${todayLog.trim()}`;
    }
  }

  let prompt = "";

  if (bootstrapContext) {
    prompt = bootstrapContext;
  }

  // Inject daily memory logs right after workspace files
  if (dailyLogsContext) {
    prompt += dailyLogsContext;
  }

  // Capability instructions — prevent hallucinated tool use
  prompt += CAPABILITY_INSTRUCTIONS;

  // Memory instructions — always included so the bot knows how to remember
  prompt += MEMORY_INSTRUCTIONS;

  // Current session context
  prompt += `\n\n## Current Session\nMessages in this conversation: ${messageCount}`;
  if (messageCount > 20) {
    prompt += `\nNote: This conversation is getting long. Consider using the \`remember\` tool to save important facts before they leave context.`;
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
