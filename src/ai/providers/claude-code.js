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
import config from "../../config/env.js";

/**
 * Extract image blocks from content array.
 * Returns { images: ImageBlockParam[], text: string }
 */
/**
 * Extract media blocks (images, PDFs) from content array.
 * Returns { mediaBlocks: ContentBlockParam[], text: string }
 */
function extractMedia(content) {
  if (!Array.isArray(content)) return { mediaBlocks: [], text: typeof content === "string" ? content : "hello" };
  const mediaBlocks = [];
  const textParts = [];
  for (const block of content) {
    if (block.type === "image" && block.source?.data) {
      mediaBlocks.push({
        type: "image",
        source: { type: "base64", media_type: block.source.media_type || "image/png", data: block.source.data },
      });
    } else if (block.type === "document" && block.source?.data) {
      mediaBlocks.push({
        type: "document",
        source: { type: "base64", media_type: block.source.media_type || "application/pdf", data: block.source.data },
      });
    } else if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return { mediaBlocks, text: textParts.join("\n") || "hello" };
}

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
  // Extract the latest user message — separate text and images
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const { mediaBlocks, text: extractedText } = extractMedia(lastUserMsg?.content);
  let prompt = extractedText;
  const hasMedia = mediaBlocks.length > 0;

  const cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd();

  // Create MCP server with Tarsee tools (requires ctx passed from caller)
  const { createTarseeMcp } = await import("../tarsee-mcp.js");
  const tarseeMcp = createTarseeMcp(toolCtx || {});

  // Skills directory — Claude Code discovers SKILL.md files here
  const skillsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "skills");

  const queryOptions = {
    cwd,
    model: model || config.CLAUDE_DEFAULT_MODEL || "claude-opus-4-6",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 50,
    includePartialMessages: true,
    mcpServers: { tarsee: tarseeMcp },
    additionalDirectories: [skillsDir],
  };

  // OpenClaw-style: lightweight system prompt + tool-based memory access
  // DON'T inject full files — tell agent to read them on demand
  const { readWorkspaceFile } = await import("../../lib/workspace-files.js");

  // Only inject a BRIEF identity summary (not the full file)
  const soulMd = readWorkspaceFile("SOUL.md") || "";
  const soulSummary = soulMd.split("\n").slice(0, 8).join("\n").slice(0, 500); // First 8 lines max

  // Only read memory on first message of a session (no sessionId = new session)
  const isNewSession = !sessionId;

  const tarseeContext = `You ARE Tarsee — a headless AI agent running 24/7 on a server.
${soulSummary ? `\n${soulSummary}\n` : ""}
${isNewSession ? `## New Session — Read your memory first
Read MEMORY.md and USER.md via mcp__tarsee__tarsee_read_file before responding to the FIRST message.
After that, only search memories when relevant — don't re-read every message.` : ""}

## MCP Tools — AVAILABLE NOW (call as mcp__tarsee__tarsee_<name>)
These tools are registered and available in your current session. Use them directly — NEVER use Bash for platform actions. They WILL work.
- **send_message**(channel, message, channel_id) — push to Telegram/Discord/web
- **schedule_task**(id, schedule, prompt, channel?, once?, action?) — create cron jobs. Use this to schedule tasks NOW.
- **remember**(content) — append to MEMORY.md permanently
- **daily_log**(content) — append to today's memory/YYYY-MM-DD.md
- **read_file**(filename) — read workspace files (MEMORY.md, USER.md, SOUL.md, etc.)
- **write_file**(filename, content) — create/overwrite workspace files
- **search_memories**(query) — keyword search across all memory files
- **get_key**(name) / **set_key**(name, value) — encrypted vault for API keys
- **web_fetch**(url) — fetch URLs, APIs, pages
- **web_search**(query) — DuckDuckGo search (free)
- **spawn_agent**(task, agent_id?) — delegate to: coder, researcher, writer, quick
- **list_agents**() — see team status
- **check_agents**() / **get_agent_result**(task_id) — monitor + get results

## Agent Team
Coder (Opus), Researcher (Sonnet), Writer (Sonnet), Quick (Haiku). Each has persistent memory.
Route: research→researcher, code→coder, write→writer, trivial→quick or answer directly. Nicknames work too.

## Memory
Use remember for durable facts. Use daily_log for session notes. Only append, never overwrite.
Before saying "I can't" → search_memories first.

## Workspace: ${cwd}`;

  const effectiveSystemPrompt = tarseeContext + (systemPrompt ? `\n\n${systemPrompt}` : "");
  queryOptions.systemPrompt = effectiveSystemPrompt;

  // Resume existing session if available
  if (sessionId) {
    queryOptions.resume = sessionId;
  }

  console.log(`[claude-code] Starting task in ${cwd}, model: ${queryOptions.model}, session: ${sessionId || "new"}, media: ${mediaBlocks.length}, mcp: ${tarseeMcp ? "yes" : "NO"}`);

  // Build prompt: use AsyncIterable with image content blocks if images present
  let queryPrompt;
  if (hasMedia) {
    // Native image support via AsyncIterable<SDKUserMessage>
    const contentBlocks = [...mediaBlocks, { type: "text", text: prompt }];
    async function* imagePrompt() {
      yield {
        type: "user",
        message: { role: "user", content: contentBlocks },
        parent_tool_use_id: null,
      };
    }
    queryPrompt = imagePrompt();
  } else {
    queryPrompt = prompt;
  }

  try {
    let messageCount = 0;
    let everStreamed = false; // True if ANY text was streamed via stream_event
    let inThinking = false;
    for await (const message of query({ prompt: queryPrompt, options: queryOptions, signal })) {
      messageCount++;
      if (signal?.aborted) break;

      switch (message.type) {
        case "stream_event": {
          // Token-by-token streaming — text deltas and thinking
          const evt = message.event;
          if (evt?.type === "content_block_delta") {
            if (evt.delta?.type === "text_delta" && evt.delta.text) {
              yield { type: "text", content: evt.delta.text };
              everStreamed = true;
            } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
              // Don't emit thinking as text — skip it silently
              // (thinking bloats the response and confuses users)
              everStreamed = true;
            }
          } else if (evt?.type === "content_block_start") {
            if (evt.content_block?.type === "thinking") {
              inThinking = true;
            }
          } else if (evt?.type === "content_block_stop") {
            if (inThinking) {
              inThinking = false;
            }
          }
          break;
        }

        case "assistant": {
          // Full assistant message — skip text if already streamed token-by-token
          if (!everStreamed) {
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
              everStreamed = true;
            }
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
          const sid = message.session_id || message.sessionId;
          if (sid && onSessionId) {
            onSessionId(sid);
          }
          if (message.usage) {
            yield { type: "usage", usage: message.usage };
          }
          // Yield result text as fallback if nothing was streamed at all
          if (!everStreamed && message.result) {
            yield { type: "text", content: message.result };
          }
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

        case "system": {
          // Capture session ID from init event
          if (message.session_id && onSessionId) {
            onSessionId(message.session_id);
          }
          break;
        }

        default:
          // Forward any other message types
          if (message.type && !["rate_limit_event", "user"].includes(message.type)) {
            console.log(`[claude-code] Event: ${message.type}`, JSON.stringify(message).slice(0, 200));
          }
          break;
      }
    }
    console.log(`[claude-code] Stream ended. Messages: ${messageCount}, streamed: ${everStreamed}`);
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
