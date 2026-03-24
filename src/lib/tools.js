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
        const { filename } = toolInput;
        // Allow workspace files and memory/ subdirectory
        if (!isAllowedFile(filename)) {
          return `Error: Cannot read '${filename}'. Allowed files: ${WORKSPACE_FILES.join(", ")} and memory/*.md`;
        }
        const content = readWorkspaceFile(filename);
        if (!content) return `File '${filename}' is empty or does not exist.`;
        return truncate(content, MAX_RESULT);
      }

      case "write_file": {
        const { filename, content } = toolInput;
        if (!isAllowedWriteFile(filename)) {
          return `Error: Cannot write to '${filename}'. Allowed: ${WORKSPACE_FILES.join(", ")}`;
        }
        writeWorkspaceFile(filename, content);
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
