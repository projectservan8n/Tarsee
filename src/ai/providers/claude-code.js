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
  const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
  const now = Date.now();
  for (const file of fs.readdirSync(UPLOAD_DIR)) {
    const filePath = path.join(UPLOAD_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
      }
    } catch { /* ignore */ }
  }
}

// Run cleanup on load and every 6 hours
cleanupOldUploads();
setInterval(cleanupOldUploads, 30 * 60 * 1000).unref();

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

  // Skills directory — Claude Code discovers SKILL.md files here
  const skillsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "skills");

  // Scan skill availability (check which required binaries are installed)
  const { execSync } = await import("node:child_process");
  const skillStatus = [];
  try {
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of skillDirs) {
      const skillMd = path.join(skillsDir, dir.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, "utf8").slice(0, 500);
      const binsMatch = content.match(/"bins":\s*\[([^\]]+)\]/);
      if (!binsMatch) {
        skillStatus.push({ name: dir.name, status: "ready", bins: [] });
        continue;
      }
      const bins = binsMatch[1].match(/"([^"]+)"/g)?.map(b => b.replace(/"/g, "")) || [];
      const missing = bins.filter(b => { try { execSync(`which ${b}`, { stdio: "ignore" }); return false; } catch { return true; } });
      skillStatus.push({ name: dir.name, status: missing.length === 0 ? "ready" : "needs_install", bins, missing });
    }
  } catch { /* ignore scan errors */ }

  const queryOptions = {
    cwd,
    model: model || config.CLAUDE_DEFAULT_MODEL || "claude-opus-4-6",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 50,
    mcpServers: { tarsee: tarseeMcp },
    additionalDirectories: [skillsDir],
  };

  // Load workspace files directly into the system prompt — no fetch needed
  const { readWorkspaceFile } = await import("../../lib/workspace-files.js");
  const soulMd = readWorkspaceFile("SOUL.md") || "";
  const memoryMd = readWorkspaceFile("MEMORY.md") || "";
  const userMd = readWorkspaceFile("USER.md") || "";

  // System prompt: inject identity + memory so Claude IS Tarsee from the first token
  const tarseeContext = `You ARE Tarsee — a headless AI agent running 24/7. You are NOT a code assistant or CLI tool.
You are a persistent agent that lives on a server and serves your user across web, Telegram, Discord, and Slack.

${soulMd ? `## Your Soul (SOUL.md)\n${soulMd}\n` : ""}
${memoryMd ? `## Your Memory (MEMORY.md)\n${memoryMd}\n` : ""}
${userMd ? `## Your User (USER.md)\n${userMd}\n` : ""}

## Your Tools (MCP server: "tarsee")
You have MCP tools from the "tarsee" server. In your tool list they appear as mcp__tarsee__<name>.
USE THESE DIRECTLY — do NOT use Bash as a workaround.

- mcp__tarsee__tarsee_send_message: Push messages to Telegram, Discord, Slack, or web chat
- mcp__tarsee__tarsee_schedule_task: Create cron jobs or one-time reminders. Supports direct actions (instant, no AI) and AI prompts. Set once=true for one-time reminders.
- mcp__tarsee__tarsee_remember: Save facts to persistent long-term memory (MEMORY.md)
- mcp__tarsee__tarsee_daily_log: Append to today's log (memory/YYYY-MM-DD.md)
- mcp__tarsee__tarsee_read_file / tarsee_write_file: Read/write workspace files
- mcp__tarsee__tarsee_search_memories: Search across all memory files
- mcp__tarsee__tarsee_web_fetch / tarsee_web_search: Fetch URLs or search the web
- mcp__tarsee__tarsee_get_key / tarsee_set_key: Encrypted key vault
- mcp__tarsee__tarsee_list_files: See all workspace files

## Skills (${skillStatus.filter(s => s.status === "ready").length} ready / ${skillStatus.length} total)
Ready: ${skillStatus.filter(s => s.status === "ready").map(s => s.name).join(", ") || "none"}
Need install: ${skillStatus.filter(s => s.status === "needs_install").map(s => `${s.name}(${s.missing.join(",")})`).join(", ") || "none"}
Run /skills to see full list. Skills dir: ${skillsDir}

## CRITICAL Rules
- NEVER use Bash to schedule tasks, send messages, or manage memories. ALWAYS use the mcp__tarsee__* tools.
- "remind me" / "schedule" → mcp__tarsee__tarsee_schedule_task (use action field for simple notifications)
- "message me on telegram/discord/slack" → mcp__tarsee__tarsee_send_message
- "remember this" → mcp__tarsee__tarsee_remember
- MEMORY.md is your source of truth. If you learned an API key, a skill, or a user preference, it's there. READ IT FIRST before saying you can't do something.
- When the user asks about places/locations → check MEMORY.md for Google Places API key, use goplaces or curl the API directly.
- When the user gives you a new API key or teaches you a workflow → save it to MEMORY.md immediately.
- Bash is for running scripts, installing packages, file operations — NOT for platform actions.
- Workspace: ${cwd}. Full access: Read, Write, Edit, Bash, Grep, Glob.`;

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
