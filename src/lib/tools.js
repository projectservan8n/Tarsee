import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { readWorkspaceFile, writeWorkspaceFile, appendDailyLog } from "./workspace-files.js";
import { runCmd } from "./run-cmd.js";

/**
 * Tool registry for Tarsee.
 * Defines tools that the AI can call via native tool_use (Anthropic) or function calling (OpenAI).
 * Each tool has a name, description, input_schema (JSON Schema), and execute function.
 */

const WORKSPACE_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md", "BOOT.md"];

export const TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a workspace file (SOUL.md, IDENTITY.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md, BOOT.md) or a daily memory log (memory/YYYY-MM-DD.md).",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The filename to read, e.g. 'MEMORY.md' or 'memory/2026-03-24.md'",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-indexed). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to return. Optional, defaults to all lines.",
        },
      },
      required: ["filename"],
    },
  },

  {
    name: "write_file",
    description: "Write or overwrite the contents of a workspace file. Use this to update your personality (SOUL.md), identity (IDENTITY.md), user notes (USER.md), long-term memory (MEMORY.md), tools (TOOLS.md), or agent rules (AGENTS.md).",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The workspace filename to write, e.g. 'MEMORY.md'",
        },
        content: {
          type: "string",
          description: "The full content to write to the file",
        },
      },
      required: ["filename", "content"],
    },
  },

  {
    name: "list_files",
    description: "List all workspace files and their sizes. Also lists daily memory logs.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "remember",
    description: "Save an important fact or preference to long-term memory. This appends to the MEMORY.md file and saves to the database.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "The fact, preference, or important information to remember",
        },
        category: {
          type: "string",
          description: "Category: preference, fact, project, person, decision",
          enum: ["preference", "fact", "project", "person", "decision"],
        },
      },
      required: ["fact"],
    },
  },

  {
    name: "daily_log",
    description: "Append a timestamped note to today's daily memory log (memory/YYYY-MM-DD.md).",
    input_schema: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "The note to log",
        },
      },
      required: ["note"],
    },
  },

  {
    name: "exec",
    description: "Execute a shell command on the server. Use for system tasks, checking status, running scripts, or using installed tools like Playwright. Commands run in a sandboxed environment with a 60-second timeout. Output is capped at 50KB.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute, e.g. 'ls -la' or 'node -e \"console.log(1+1)\"'",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default: 60000, max: 120000)",
        },
      },
      required: ["command"],
    },
  },

  {
    name: "web_fetch",
    description: "Fetch the contents of a URL. Returns the response body as text (HTML, JSON, etc). Useful for checking APIs, fetching web pages, or downloading data.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        method: {
          type: "string",
          description: "HTTP method (default: GET)",
          enum: ["GET", "POST", "PUT", "DELETE"],
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers as key-value pairs",
        },
        body: {
          type: "string",
          description: "Optional request body (for POST/PUT)",
        },
      },
      required: ["url"],
    },
  },

  {
    name: "search_memories",
    description: "Search through stored memories in the database for relevant facts about the user or past conversations.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term to find in memories",
        },
      },
      required: ["query"],
    },
  },

  {
    name: "edit_file",
    description: "Edit a workspace file by replacing specific text (targeted find-and-replace). Only replaces the first occurrence.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The workspace filename to edit, e.g. 'MEMORY.md'",
        },
        old_text: {
          type: "string",
          description: "The exact text to find in the file",
        },
        new_text: {
          type: "string",
          description: "The replacement text",
        },
      },
      required: ["filename", "old_text", "new_text"],
    },
  },

  {
    name: "grep",
    description: "Search for a text pattern across workspace files. Returns matching lines with filename:lineNumber format. Case-insensitive. Results capped at 50 matches.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The text pattern to search for (case-insensitive substring match)",
        },
        filename: {
          type: "string",
          description: "Optional: search only this specific workspace file. If omitted, searches all workspace files and memory logs.",
        },
      },
      required: ["pattern"],
    },
  },

  {
    name: "append_file",
    description: "Append content to a workspace file without overwriting existing content. Useful for adding entries to MEMORY.md, TOOLS.md, etc.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The workspace filename to append to, e.g. 'MEMORY.md'",
        },
        content: {
          type: "string",
          description: "The content to append to the end of the file",
        },
      },
      required: ["filename", "content"],
    },
  },

  {
    name: "browser",
    description: "Control a web browser. Actions: navigate (go to URL), screenshot (capture page), click (click element by selector), type (type text into element), evaluate (run JS in page), get_text (extract page text content). The browser persists across calls within a conversation.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "screenshot", "click", "type", "evaluate", "get_text", "close"],
          description: "The browser action to perform",
        },
        url: {
          type: "string",
          description: "URL to navigate to (for 'navigate' action)",
        },
        selector: {
          type: "string",
          description: "CSS selector for the target element (for 'click' and 'type' actions)",
        },
        text: {
          type: "string",
          description: "Text to type into the element (for 'type' action)",
        },
        script: {
          type: "string",
          description: "JavaScript code to evaluate in the page (for 'evaluate' action)",
        },
      },
      required: ["action"],
    },
  },

  {
    name: "web_search",
    description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets for the top results. Free, no API key needed.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 5, max: 10)",
        },
      },
      required: ["query"],
    },
  },

  {
    name: "pdf_read",
    description: "Read and extract text from a PDF file. Can read from a URL or from a workspace file path.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "URL of the PDF or workspace filename to read",
        },
      },
      required: ["source"],
    },
  },

  {
    name: "send_message",
    description: "Send a message to a specific channel. Use this to proactively message the user on Telegram, Discord, or Slack, or to send data/files to the chat.",
    input_schema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "The channel to send to",
          enum: ["web", "discord", "telegram", "slack"],
        },
        message: {
          type: "string",
          description: "The message content to send",
        },
        channel_id: {
          type: "string",
          description: "Optional specific chat/channel ID to target",
        },
      },
      required: ["channel", "message"],
    },
  },

  {
    name: "schedule_task",
    description: "Schedule a task to run at a specific time or interval using cron syntax. The task will be executed as an AI prompt at the scheduled time.",
    input_schema: {
      type: "object",
      properties: {
        schedule: {
          type: "string",
          description: "Cron expression, e.g. '0 9 * * *' for daily at 9am",
        },
        prompt: {
          type: "string",
          description: "What to do when the task triggers — this will be sent as an AI prompt",
        },
        name: {
          type: "string",
          description: "Optional descriptive name for this scheduled task",
        },
      },
      required: ["schedule", "prompt"],
    },
  },

  {
    name: "generate_image",
    description: "Generate an image from a text prompt. Uses DALL-E or compatible image generation API. Requires OPENAI_API_KEY.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image to generate",
        },
        size: {
          type: "string",
          description: "Image dimensions",
          enum: ["1024x1024", "1024x1792", "1792x1024"],
        },
        quality: {
          type: "string",
          description: "Image quality level",
          enum: ["standard", "hd"],
        },
      },
      required: ["prompt"],
    },
  },
];

/**
 * Get tool definitions for the AI API (Anthropic format).
 * OpenAI format conversion happens in the provider.
 */
export function getToolDefinitions() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

// ── Browser state (persists across tool calls within a session) ──
let browserInstance = null;
let browserPage = null;

async function ensureBrowser() {
  if (browserPage && !browserPage.isClosed()) return browserPage;
  try {
    const { chromium } = await import("playwright");
    browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext();
    browserPage = await context.newPage();
    return browserPage;
  } catch (err) {
    throw new Error(`Failed to launch browser: ${err.message}. Make sure playwright is installed (npm i playwright).`);
  }
}

/**
 * Execute a tool call and return the result string.
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} ctx - Context with db, settingsStore, conversationId
 * @returns {Promise<string>}
 */
export async function executeTool(toolName, toolInput, ctx = {}) {
  const MAX_RESULT = 50_000; // 50KB max result

  try {
    switch (toolName) {
      case "read_file": {
        const { filename, offset, limit } = toolInput;
        // Allow workspace files and memory/ subdirectory
        if (!isAllowedFile(filename)) {
          return `Error: Cannot read '${filename}'. Allowed files: ${WORKSPACE_FILES.join(", ")} and memory/*.md`;
        }
        let content = readWorkspaceFile(filename);
        if (!content) return `File '${filename}' is empty or does not exist.`;
        // Apply offset and limit if provided
        if (offset || limit) {
          const lines = content.split("\n");
          const start = Math.max(0, (offset || 1) - 1); // 1-indexed to 0-indexed
          const end = limit ? start + limit : lines.length;
          content = lines.slice(start, end).join("\n");
          if (!content) return `No content in '${filename}' at offset ${offset || 1} with limit ${limit || "all"}.`;
        }
        return truncate(content, MAX_RESULT);
      }

      case "write_file": {
        const { filename, content } = toolInput;
        if (!isAllowedWriteFile(filename)) {
          return `Error: Cannot write to '${filename}'. Allowed: ${WORKSPACE_FILES.join(", ")}`;
        }
        writeWorkspaceFile(filename, content);
        // Auto-sync identity.name when IDENTITY.md is written
        if (filename === "IDENTITY.md" && ctx.settingsStore) {
          const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/i);
          if (nameMatch) {
            ctx.settingsStore.set("identity.name", nameMatch[1].trim());
          }
        }
        return `Successfully wrote ${content.length} chars to ${filename}.`;
      }

      case "list_files": {
        const files = [];
        for (const f of WORKSPACE_FILES) {
          const filePath = path.join(config.WORKSPACE_DIR, f);
          try {
            const stat = fs.statSync(filePath);
            files.push(`${f}: ${stat.size} bytes`);
          } catch {
            files.push(`${f}: (not created)`);
          }
        }
        // List memory logs
        const memDir = path.join(config.WORKSPACE_DIR, "memory");
        try {
          const memFiles = fs.readdirSync(memDir).filter((f) => f.endsWith(".md")).sort();
          for (const f of memFiles.slice(-10)) {
            const stat = fs.statSync(path.join(memDir, f));
            files.push(`memory/${f}: ${stat.size} bytes`);
          }
        } catch { /* no memory dir yet */ }
        return files.join("\n");
      }

      case "remember": {
        const { fact, category } = toolInput;
        // Save to DB
        if (ctx.db) {
          try {
            const { MemoryStore } = await import("../db/memory.js");
            const store = new MemoryStore(ctx.db);
            store.addAndSync(fact, category || "fact", ctx.conversationId || null);
          } catch { /* best effort */ }
        }
        return `Remembered: "${fact}"`;
      }

      case "daily_log": {
        const { note } = toolInput;
        appendDailyLog(note);
        const today = new Date().toISOString().slice(0, 10);
        return `Logged to memory/${today}.md: "${note}"`;
      }

      case "exec": {
        const { command, timeout_ms } = toolInput;
        const timeout = Math.min(timeout_ms || 60_000, 120_000);
        // Split command for runCmd
        const result = await runCmd("sh", ["-c", command], { timeoutMs: timeout });
        const output = truncate(result.output || "(no output)", MAX_RESULT);
        return `Exit code: ${result.code}\n${output}`;
      }

      case "web_fetch": {
        const { url, method, headers, body } = toolInput;
        const res = await fetch(url, {
          method: method || "GET",
          headers: headers || {},
          body: body || undefined,
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        return truncate(`Status: ${res.status}\n\n${text}`, MAX_RESULT);
      }

      case "search_memories": {
        const { query } = toolInput;
        if (!ctx.db) return "Database not available.";
        try {
          const { MemoryStore } = await import("../db/memory.js");
          const store = new MemoryStore(ctx.db);
          const results = store.search(query, 10);
          if (results.length === 0) return `No memories found matching "${query}".`;
          return results.map((m) => `[${m.category}] ${m.content}`).join("\n");
        } catch (err) {
          return `Memory search error: ${err.message}`;
        }
      }

      case "edit_file": {
        const { filename, old_text, new_text } = toolInput;
        if (!isAllowedWriteFile(filename)) {
          return `Error: Cannot edit '${filename}'. Allowed: ${WORKSPACE_FILES.join(", ")}`;
        }
        const existing = readWorkspaceFile(filename);
        if (!existing) return `Error: File '${filename}' is empty or does not exist.`;
        if (!existing.includes(old_text)) {
          return `Error: Could not find the specified old_text in '${filename}'. Make sure the text matches exactly (including whitespace and newlines).`;
        }
        const updated = existing.replace(old_text, new_text);
        writeWorkspaceFile(filename, updated);
        // Auto-sync identity.name when IDENTITY.md is edited
        if (filename === "IDENTITY.md" && ctx.settingsStore) {
          const nameMatch = updated.match(/\*\*Name:\*\*\s*(.+)/i);
          if (nameMatch) ctx.settingsStore.set("identity.name", nameMatch[1].trim());
        }
        return `Successfully edited '${filename}'. Replaced ${old_text.length} chars with ${new_text.length} chars.`;
      }

      case "grep": {
        const { pattern, filename } = toolInput;
        const MAX_MATCHES = 50;
        const matches = [];
        const regex = new RegExp(pattern, "i");

        const searchFile = (fname) => {
          try {
            const content = readWorkspaceFile(fname);
            if (!content) return;
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
              if (regex.test(lines[i])) {
                matches.push(`${fname}:${i + 1}: ${lines[i]}`);
              }
            }
          } catch { /* skip unreadable files */ }
        };

        if (filename) {
          if (!isAllowedFile(filename)) {
            return `Error: Cannot search '${filename}'. Allowed files: ${WORKSPACE_FILES.join(", ")} and memory/*.md`;
          }
          searchFile(filename);
        } else {
          // Search all workspace files
          for (const f of WORKSPACE_FILES) {
            if (matches.length >= MAX_MATCHES) break;
            searchFile(f);
          }
          // Search memory logs
          const memDir = path.join(config.WORKSPACE_DIR, "memory");
          try {
            const memFiles = fs.readdirSync(memDir).filter((f) => f.endsWith(".md")).sort();
            for (const f of memFiles) {
              if (matches.length >= MAX_MATCHES) break;
              searchFile(`memory/${f}`);
            }
          } catch { /* no memory dir yet */ }
        }

        if (matches.length === 0) return `No matches found for pattern "${pattern}".`;
        let result = matches.join("\n");
        if (matches.length >= MAX_MATCHES) result += `\n...(capped at ${MAX_MATCHES} matches)`;
        return result;
      }

      case "append_file": {
        const { filename, content } = toolInput;
        if (!isAllowedWriteFile(filename)) {
          return `Error: Cannot append to '${filename}'. Allowed: ${WORKSPACE_FILES.join(", ")}`;
        }
        const existing = readWorkspaceFile(filename) || "";
        const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        writeWorkspaceFile(filename, existing + separator + content);
        return `Successfully appended ${content.length} chars to '${filename}'.`;
      }

      case "send_message": {
        const { channel, message, channel_id } = toolInput;
        if (!ctx.db) return "Database not available.";
        try {
          const { ConversationStore } = await import("../db/conversations.js");
          const store = new ConversationStore(ctx.db);
          // Find or create a conversation for this channel
          let conv = store.findByChannel(channel, channel_id);
          if (!conv) {
            conv = store.create({ channel, channelId: channel_id || null, title: `${channel} outbound` });
          }
          store.addMessage(conv.id, { role: "assistant", content: message });
          const preview = message.length > 80 ? message.slice(0, 80) + "..." : message;
          return `Message sent to ${channel}: ${preview}`;
        } catch (err) {
          return `send_message error: ${err.message}`;
        }
      }

      case "schedule_task": {
        const { schedule, prompt, name } = toolInput;
        try {
          const { addCronJob } = await import("./cron.js");
          const job = addCronJob({ schedule, prompt, name });
          return `Scheduled task: ${name || job.id} at ${schedule}`;
        } catch (err) {
          return `schedule_task error: ${err.message}`;
        }
      }

      case "generate_image": {
        const { prompt, size, quality } = toolInput;
        const apiKey = process.env.OPENAI_API_KEY || ctx.settingsStore?.get("ai.openai.apiKey");
        if (!apiKey) {
          return "Image generation requires an OpenAI API key. Set OPENAI_API_KEY or configure OpenAI in settings.";
        }
        try {
          const res = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size: size || "1024x1024", quality: quality || "standard" }),
            signal: AbortSignal.timeout(60000),
          });
          const data = await res.json();
          if (data.error) return `Image generation error: ${data.error.message}`;
          const imageUrl = data.data?.[0]?.url;
          return `Image generated: ${imageUrl}\n\nRevised prompt: ${data.data?.[0]?.revised_prompt || prompt}`;
        } catch (err) {
          return `generate_image error: ${err.message}`;
        }
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `Tool error (${toolName}): ${err.message}`;
  }
}

// ── Helpers ──

function isAllowedFile(filename) {
  if (WORKSPACE_FILES.includes(filename)) return true;
  if (filename.startsWith("memory/") && filename.endsWith(".md")) return true;
  return false;
}

function isAllowedWriteFile(filename) {
  return WORKSPACE_FILES.includes(filename);
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n...(truncated)";
}
