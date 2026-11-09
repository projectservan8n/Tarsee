import { MemoryStore } from "../db/memory.js";
import { getSkillsPromptContext } from "./skills-engine.js";
import { getLearningHint } from "./personality-learner.js";
import { getBootstrapContext, readWorkspaceFile } from "./workspace-files.js";
import { readAndArchiveCheckpoint } from "./checkpoint.js";
import { getCredentialInventory, renderInventoryPromptSection } from "./credential-inventory.js";

const MAX_TOTAL_BYTES = 50 * 1024; // 50KB total prompt budget (trimmed from 150KB)

/**
 * The channel hint's line on files: the agent sends them as attachments to this chat. Without it a model asked for
 * "the html file" on Telegram answered with folder paths and "I can't attach files to Telegram from here".
 */
export function sendFileHint(channel) {
  if (channel === "web") return `- To give the person a file (a report, an export, an image, anything on disk), call tarsee_send_file with channel="web" and the file's path: it shows in this chat as a card they can open and download. Never answer with a folder path instead.`;
  return `- To send a file (a report, an export, an image, anything on disk), call tarsee_send_file with channel="${channel}" and the file's path: it arrives here as a real attachment. Never answer with a folder path instead, and never say you can't attach files here.`;
}

/**
 * Build the effective system prompt from all sources.
 * Used by HTTP, WebSocket, Discord, Telegram, and Slack handlers.
 *
 * It is buildSystemPromptParts()'s two parts, stable then volatile, as one string.
 *
 * @param {object} opts see buildSystemPromptParts
 * @returns {string}
 */
export function buildSystemPrompt(opts) {
  const { stable, volatile } = buildSystemPromptParts(opts);
  return stable + volatile;
}

/**
 * The system prompt in two parts (design 4.6 g and 4.8):
 *
 *   stable    what stays the same from one turn to the next: AGENTS.md + SOUL.md + IDENTITY.md + USER.md +
 *             TOOLS.md + MEMORY.md (the workspace files), the saved memories, the skills, the conversation's own
 *             prompt and the channel hint (or, with none of those, "You are <name>, a helpful AI assistant.")
 *   volatile  what changes during a conversation: today's log, the checkpoint a previous instance left (first message
 *             only, then archived), the credential inventory (first message of a session), the periodic learning
 *             nudge
 *
 * Claude Code takes the two as one system prompt (buildSystemPrompt). Codex keeps the stable part as its instructions
 * and gets the volatile part with each message, so a new daily log line doesn't start its session over.
 *
 * Individual files are truncated at 12KB (WORKSPACE_FILE_MAX_BYTES); MEMORY.md is
 * a pointer to grep, not inlined. Quick memories are one line each (300 chars),
 * skills a short description each. The two parts together are capped at 50KB (the
 * stable part first).
 *
 * @param {object} opts
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string|null} opts.conversationId
 * @param {number} opts.messageCount
 * @param {string|null} opts.conversationPrompt
 * @param {string} opts.channelHint
 * @returns {{stable: string, volatile: string}}
 */
export function buildSystemPromptParts({
  settingsStore,
  db,
  conversationId = null,
  messageCount = 0,
  conversationPrompt = null,
  channelHint = "",
  channelManager = null,
}) {
  // 1. Workspace files: AGENTS → SOUL → IDENTITY → USER → TOOLS → MEMORY
  const bootstrapContext = getBootstrapContext();

  // 2. DB memories (brief supplementary — top 10 instead of 20)
  const memoryStore = new MemoryStore(db);
  const dbMemoryContext = memoryStore.getContextString(10);

  // 3. Skills (just names)
  const skillsContext = getSkillsPromptContext();

  // --- The stable part. No tool lists or memory instructions: the engine's preamble has those (ai/preamble.js).
  let stable = "";

  if (bootstrapContext) {
    stable = bootstrapContext;
  }

  // DB memories (brief supplementary context)
  if (dbMemoryContext) {
    stable += dbMemoryContext;
  }

  // Skills list (just names, not full docs)
  if (skillsContext) {
    stable += skillsContext;
  }

  // Boot context injection REMOVED: it broadcast the last user message +
  // assistant reply of the 3 most-recent conversations across ALL channels
  // into every conversation's early system prompt. That leaked one channel's
  // content into another (e.g. a Telegram exchange surfacing in a Discord
  // answer) — unacceptable once more than one person or channel is in play.
  // Per-conversation continuity is already handled by each conversation's own
  // resumed session (which now survives restarts, see server.js), so this
  // cross-conversation summary was both leaky AND redundant. Durable shared
  // knowledge still flows via MEMORY.md / USER.md / bot_memory — those are
  // intentional shared facts, not private chatter.

  if (conversationPrompt) {
    stable += (stable ? "\n\n" : "") + conversationPrompt;
  }

  if (channelHint) {
    stable += (stable ? "\n\n" : "") + channelHint;
  }

  if (!stable) {
    const identityName = settingsStore.get("identity.name") || "Tarsee";
    stable = `You are ${identityName}, a helpful AI assistant.`;
  }

  // --- The volatile part.
  let volatile = "";

  // 4. Today's daily log only (yesterday accessible via tools if needed)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayLog = readWorkspaceFile(`memory/${todayStr}.md`);
  if (todayLog) {
    // Only last 2KB of today's log — most recent entries
    const trimmed = todayLog.length > 2048 ? todayLog.slice(-2048) : todayLog;
    volatile += `\n\n## Today's Log (${todayStr})\n${trimmed.trim()}`;
  }

  // Checkpoint — user-written detailed handoff from a previous instance
  // (dropped via /checkpoint before a planned restart). Inject on the
  // VERY first message of a session only, and consume atomically so the
  // handoff is surfaced exactly once. Takes precedence over boot-context:
  // it's explicit, detailed, and written by the last Claude instance
  // that was actively engaged with the current work.
  if (messageCount === 0) {
    const checkpointBody = readAndArchiveCheckpoint();
    if (checkpointBody) {
      volatile += `\n\n## Handoff from previous instance
*This CHECKPOINT.md was written by your previous self before a container
wipe. It's the deliberate handoff — treat it as authoritative for what
was in-flight. After absorbing, confirm to the user in ONE line that
you've picked up the context and continue from the "Next Action on
Reboot" step.*

${checkpointBody.trim()}`;
    }
  }

  // Credential inventory — one-shot preload at session start so Claude
  // knows what's available without running a tool. Worth the ~200
  // tokens once per session to save a round-trip on every "use X" ask.
  if (messageCount <= 1) {
    try {
      const inv = getCredentialInventory({ settingsStore, channelManager });
      const section = renderInventoryPromptSection(inv);
      if (section) volatile += section;
    } catch (err) {
      // Never block prompt assembly on an inventory failure.
      console.warn("[prompt] credential inventory failed:", err.message);
    }
  }

  // Learning hints (zero API cost — just encourages memory extraction)
  if (conversationId && messageCount > 0) {
    const learningHint = getLearningHint(conversationId, messageCount);
    if (learningHint) volatile += learningHint;
  }

  // Enforce total budget, in bytes: the stable part first, the volatile part in what is left.
  stable = clipBytes(stable, MAX_TOTAL_BYTES);
  volatile = clipBytes(volatile, MAX_TOTAL_BYTES - Buffer.byteLength(stable, "utf8"));

  return { stable, volatile };
}

/** The text cut to at most maxBytes of UTF-8, never through the middle of a character. */
function clipBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // (UTF-8 continuation bytes are 10xxxxxx: step back to the first byte of the character that doesn't fit.)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}
