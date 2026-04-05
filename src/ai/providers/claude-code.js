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
import config from "../../config/env.js";

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
}) {
  // Extract the latest user message as the prompt
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const prompt = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : "hello";

  const cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd();

  const queryOptions = {
    cwd,
    model: model || config.CLAUDE_DEFAULT_MODEL || "claude-sonnet-4-6",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    maxTurns: 50,
  };

  // Append system prompt context if available
  if (systemPrompt) {
    queryOptions.systemPrompt = systemPrompt;
  }

  // Resume existing session if available
  if (sessionId) {
    queryOptions.resume = sessionId;
  }

  console.log(`[claude-code] Starting task in ${cwd}, model: ${queryOptions.model}, session: ${sessionId || "new"}`);

  try {
    for await (const message of query({ prompt, options: queryOptions, signal })) {
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

          // If the result contains text content, yield it
          if (message.result) {
            const resultText = typeof message.result === "string"
              ? message.result
              : "";
            if (resultText) {
              yield { type: "text", content: resultText };
            }
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

        default:
          // Forward any other message types as debug info
          if (message.type) {
            console.log(`[claude-code] Event: ${message.type}`, JSON.stringify(message).slice(0, 200));
          }
          break;
      }
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
