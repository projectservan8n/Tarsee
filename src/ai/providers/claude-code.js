/**
 * Claude Code (Agent) provider
 *
 * Wraps the @anthropic-ai/claude-agent-sdk to run Claude Code headlessly
 * through Tarsee's chat interface. Claude Code manages its own agentic
 * tool-use loop (Read, Write, Edit, Bash, Grep, Glob) — Tarsee just
 * streams the events to the client.
 *
 * Auth: Uses Claude subscription credentials from `claude login` stored
 * in ~/.claude/.credentials.json (no API key needed).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import config from "../../config/env.js";

// Directory for temporary image uploads that Claude Code can read via its Read tool
const UPLOAD_DIR = path.join(config.CLAUDE_WORKSPACE_DIR || process.cwd(), ".uploads");

/**
 * Save image content blocks to disk so Claude Code can access them via Read tool.
 * Returns an array of { path, mediaType } for each saved image.
 * Files auto-delete after 3 days via cleanup sweep.
 */
function saveImagesToDisk(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return [];

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const saved = [];
  for (const block of contentBlocks) {
    if (block.type === "image" && block.source?.data) {
      const ext = (block.source.media_type || "image/png").split("/")[1] || "png";
      const filename = `img-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
      const filePath = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(filePath, Buffer.from(block.source.data, "base64"));
      saved.push({ path: filePath, mediaType: block.source.media_type });
    }
  }
  return saved;
}

/**
 * Clean up uploaded images older than 3 days.
 */
function cleanupOldUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const file of fs.readdirSync(UPLOAD_DIR)) {
    const filePath = path.join(UPLOAD_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > THREE_DAYS_MS) {
        fs.unlinkSync(filePath);
      }
    } catch { /* ignore */ }
  }
}

// Run cleanup on load and every 6 hours
cleanupOldUploads();
setInterval(cleanupOldUploads, 6 * 60 * 60 * 1000).unref();

/**
 * Async generator that matches Tarsee's provider interface.
 *
 * Unlike other providers, Claude Code runs its own tool loop internally.
 * We yield events as they arrive — the chat route should NOT wrap this
 * in its own tool-use loop.
 *
 * @param {object} opts
 * @param {Array} opts.messages - Conversation history (we extract the latest user message)
 * @param {string} opts.model - Model ID (claude-sonnet-4-6, claude-opus-4-6, etc.)
 * @param {string} [opts.systemPrompt] - System prompt (passed as context to Claude Code)
 * @param {AbortSignal} [opts.signal] - Abort signal
 * @param {string} [opts.sessionId] - Claude Code session ID for resumption
 * @param {Function} [opts.onSessionId] - Callback when session ID is available
 */
export async function* chat({
  messages,
  model,
  systemPrompt,
  signal,
  sessionId,
  onSessionId,
  toolCtx,
}) {
  // Extract the latest user message as the prompt
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  let prompt = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : "hello";

  // Save any attached images to disk so Claude Code can read them
  if (Array.isArray(lastUserMsg?.content)) {
    const savedImages = saveImagesToDisk(lastUserMsg.content);
    if (savedImages.length > 0) {
      const imageRefs = savedImages.map((img, i) =>
        `[Attached image ${i + 1}: ${img.path}]`
      ).join("\n");
      prompt = `${prompt}\n\nThe user attached ${savedImages.length} image(s). Use the Read tool to view them:\n${imageRefs}`;
    }
  }

  const cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd();

  // Create MCP server with Tarsee tools (requires ctx passed from caller)
  const { createTarseeMcp } = await import("../tarsee-mcp.js");
  const tarseeMcp = createTarseeMcp(toolCtx || {});

  const queryOptions = {
    cwd,
    model: model || config.CLAUDE_DEFAULT_MODEL || "claude-sonnet-4-6",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 50,
    mcpServers: { tarsee: tarseeMcp },
  };

  // System prompt: tell Claude it IS Tarsee with native platform tools
  const tarseeContext = `You ARE Tarsee — an AI agent platform. You have native access to platform tools via the "tarsee" MCP server.

Your tarsee_* tools give you direct control over the platform:
- tarsee_send_message: Push messages to Telegram, Discord, Slack, or web chat
- tarsee_schedule_task: Create cron jobs that run AI prompts on a schedule
- tarsee_remember: Save facts to persistent long-term memory
- tarsee_daily_log: Write to today's memory log
- tarsee_read_file / tarsee_write_file: Read/write workspace files (SOUL.md, MEMORY.md, etc.)
- tarsee_search_memories: Search across all memory files
- tarsee_web_fetch / tarsee_web_search: Fetch URLs or search the web
- tarsee_get_key / tarsee_set_key: Encrypted key vault

ALWAYS use tarsee_* tools for platform operations. Do NOT use Bash+curl for things these tools handle directly.
Your workspace is at ${cwd}.`;

  const effectiveSystemPrompt = tarseeContext + (systemPrompt ? `\n\n${systemPrompt}` : "");
  queryOptions.systemPrompt = effectiveSystemPrompt;

  // Resume existing session if available
  if (sessionId) {
    queryOptions.resume = sessionId;
  }

  console.log(`[claude-code] Starting task in ${cwd}, model: ${queryOptions.model}, session: ${sessionId || "new"}`);

  try {
    let messageCount = 0;
    for await (const message of query({ prompt, options: queryOptions, signal })) {
      messageCount++;
      if (signal?.aborted) break;

      switch (message.type) {
        case "assistant": {
          // Assistant text content — stream it
          const text = typeof message.message?.content === "string"
            ? message.message.content
            : Array.isArray(message.message?.content)
              ? message.message.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("")
              : "";
          if (text) {
            yield { type: "text", content: text };
          }

          // Check for tool_use blocks in the content
          if (Array.isArray(message.message?.content)) {
            for (const block of message.message.content) {
              if (block.type === "tool_use") {
                yield {
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                };
              }
            }
          }
          break;
        }

        case "tool_result": {
          // Tool execution result from Claude Code
          const resultText = typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content || "");
          yield {
            type: "tool_result",
            id: message.tool_use_id || message.id,
            name: message.name || "tool",
            result: resultText.slice(0, 2000),
          };
          break;
        }

        case "result": {
          // Final result — capture session ID and usage
          if (message.sessionId && onSessionId) {
            onSessionId(message.sessionId);
          }
          if (message.usage) {
            yield { type: "usage", usage: message.usage };
          }
          // Don't yield message.result text — it duplicates what was
          // already streamed via "assistant" messages above.
          yield { type: "done", stopReason: "end_turn" };
          break;
        }

        case "error": {
          const errMsg = message.error?.message || message.error || "Unknown Claude Code error";
          // Detect auth failures
          if (/unauthorized|authentication|login|credential/i.test(errMsg)) {
            yield {
              type: "text",
              content: `**Authentication required.** Run \`claude login\` in the Tarsee terminal to authenticate with your Claude subscription.\n\nError: ${errMsg}`,
            };
          }
          yield { type: "error", message: errMsg };
          yield { type: "done", stopReason: "error" };
          break;
        }

        default:
          // Forward any other message types as debug info
          if (message.type) {
            console.log(`[claude-code] Event: ${message.type}`, JSON.stringify(message).slice(0, 200));
          }
          break;
      }
    }
    console.log(`[claude-code] Stream ended. Total messages received: ${messageCount}`);
    if (messageCount === 0) {
      yield { type: "text", content: "**Claude Code returned no response.** Check the server logs for details. The CLI may not be authenticated — run `claude login` in the Terminal." };
      yield { type: "done", stopReason: "error" };
    }
  } catch (error) {
    console.error("[claude-code] Exception:", error);
    const errMsg = error.message || "Claude Code crashed";

    if (/unauthorized|authentication|login|credential|ENOENT.*claude/i.test(errMsg)) {
      yield {
        type: "text",
        content: `**Claude Code not authenticated.** Open the Tarsee terminal and run:\n\n\`\`\`\nclaude login\n\`\`\`\n\nThen try again.\n\nError: ${errMsg}`,
      };
    }

    yield { type: "error", message: errMsg };
    yield { type: "done", stopReason: "error" };
  }
}
