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
  // Auto-memory flush: if conversation is long, prepend extraction instruction
  const messageCount = messages.length;
  const FLUSH_THRESHOLD = 30; // After 30 messages, trigger memory flush
  const needsFlush = messageCount > 0 && messageCount % FLUSH_THRESHOLD === 0;

  // Extract the latest user message — separate text and images
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const { mediaBlocks, text: extractedText } = extractMedia(lastUserMsg?.content);
  let prompt = extractedText;
  const hasMedia = mediaBlocks.length > 0;

  // Inject memory flush instruction when conversation is long
  if (needsFlush) {
    prompt = `[MEMORY FLUSH] Before responding, extract and save any important information from this conversation to memory/YYYY-MM-DD.md using tarsee_daily_log. Save: facts learned, decisions made, tasks discussed, API keys mentioned, user preferences. Then respond normally.\n\n${prompt}`;
    console.log(`[claude-code] Memory flush triggered at ${messageCount} messages`);
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

  const tarseeContext = `You ARE Tarsee — a headless AI agent running 24/7 on a server.

## Session Startup
BEFORE responding to ANY message, run your startup sequence:
1. mcp__tarsee__tarsee_read_file("MEMORY.md") — your accumulated knowledge, API keys, skills, preferences
2. mcp__tarsee__tarsee_search_memories with the user's topic — find relevant past context
3. If this is a NEW conversation or you're unsure of context, also read SOUL.md and USER.md

This is NON-NEGOTIABLE. Always check memory before responding. Never say "I don't have that info" without searching first.

## Identity (from SOUL.md)
${soulSummary}

## Platform Tools (MCP server: "tarsee")
Your tools appear as mcp__tarsee__<name>. Use them directly — NEVER use Bash for platform actions.

Key tools:
- tarsee_send_message: Push to Telegram/Discord/Slack/web
- tarsee_schedule_task: Cron jobs + one-time reminders (action field for direct, once=true for one-time)
- tarsee_remember: Save to MEMORY.md (append, never overwrite)
- tarsee_daily_log: Append to today's memory/YYYY-MM-DD.md
- tarsee_read_file / tarsee_write_file: Workspace files
- tarsee_search_memories: Keyword search across all memory files
- tarsee_get_key / tarsee_set_key: Encrypted vault
- tarsee_web_fetch / tarsee_web_search: Web access

## Agents — You Are The Orchestrator
You can spawn specialized background agents for parallel work:
- tarsee_spawn_agent: Spawn an agent with a task. Specify agent_id for the right specialist.
- tarsee_check_agents: Check status of all running/completed agents.
- tarsee_get_agent_result: Get full output from a completed agent.
- tarsee_list_agents: See available agent types.

Available agents: Coder (Opus), Researcher (Sonnet), Writer (Sonnet), Quick (Haiku).

When to delegate: complex research, parallel tasks, long-running work. You stay responsive while agents work.
ALWAYS report back to the user when agents complete — don't make them check manually.

## Memory Rules
- ALWAYS save important info to memory/YYYY-MM-DD.md (append-only daily log)
- Use tarsee_remember for durable facts (API keys, user preferences, workflows)
- NEVER overwrite MEMORY.md wholesale — only append
- When the user teaches you something → save immediately
- Before saying "I can't" → search memories first

## Skills (${skillStatus.filter(s => s.status === "ready").length} ready / ${skillStatus.length} total)
${skillStatus.filter(s => s.status === "ready").map(s => s.name).join(", ") || "none"} ready.
${skillStatus.filter(s => s.status === "needs_install").length} need CLI install. Run /skills for full list.

## Workspace: ${cwd}`;

  const effectiveSystemPrompt = tarseeContext + (systemPrompt ? `\n\n${systemPrompt}` : "");
  queryOptions.systemPrompt = effectiveSystemPrompt;

  // Resume existing session if available
  if (sessionId) {
    queryOptions.resume = sessionId;
  }

  console.log(`[claude-code] Starting task in ${cwd}, model: ${queryOptions.model}, session: ${sessionId || "new"}, media: ${mediaBlocks.length}`);

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
    let streamed = false;
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
              streamed = true;
            } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
              // Don't emit thinking as text — skip it silently
              // (thinking bloats the response and confuses users)
              streamed = true;
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
          // Full assistant message (after streaming completes)
          // Only yield text if we didn't already stream it
          if (!streamed) {
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
          }
          streamed = false;

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
          // Yield result text as fallback if streaming didn't capture it
          if (!streamed && message.result) {
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
    console.log(`[claude-code] Stream ended. Messages: ${messageCount}, streamed: ${streamed}`);
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
