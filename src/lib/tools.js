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

  {
    name: "spawn_agent",
    description: "Spawn a background subagent to work on a task independently. The subagent runs as a separate AI conversation with its own tool access. Use this for: long-running tasks, parallel research, monitoring jobs, or delegating work. Returns a task ID you can check later.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Detailed description of what the subagent should do",
        },
        name: {
          type: "string",
          description: "Short name for this agent task (e.g. 'research-competitors', 'monitor-site')",
        },
      },
      required: ["task"],
    },
  },

  {
    name: "list_agents",
    description: "List all spawned subagents and their current status (running, completed, failed).",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "get_agent_result",
    description: "Get the result/output of a completed subagent by its task ID.",
    input_schema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID returned by spawn_agent",
        },
      },
      required: ["task_id"],
    },
  },

  {
    name: "stop_agent",
    description: "Stop a running subagent by its task ID.",
    input_schema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to stop",
        },
      },
      required: ["task_id"],
    },
  },

  {
    name: "analyze_image",
    description: "Analyze an image using AI vision. Accepts a base64-encoded image or URL. Returns a detailed description.",
    input_schema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Base64-encoded image data or URL" },
        prompt: { type: "string", description: "Optional analysis prompt (default: describe the image)" },
      },
      required: ["image"],
    },
  },

  {
    name: "get_key",
    description: "Retrieve an API key or secret from the secure vault. Use this when you need a key for a task (e.g., Google Places API key, Stripe key, etc). Keys are stored encrypted and only decrypted when needed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Key name (e.g., GOOGLE_PLACES_KEY, STRIPE_SECRET)" },
      },
      required: ["name"],
    },
  },

  {
    name: "set_key",
    description: "Store an API key or secret in the secure vault. The user gives you a key and you save it encrypted. Use a descriptive name like GOOGLE_PLACES_KEY, OPENWEATHER_KEY, etc.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Key name (uppercase with underscores, e.g., GOOGLE_PLACES_KEY)" },
        value: { type: "string", description: "The secret value to store" },
        description: { type: "string", description: "What this key is for (e.g., Google Places API for location lookups)" },
      },
      required: ["name", "value"],
    },
  },

  {
    name: "list_keys",
    description: "List all API keys and secrets stored in the vault. Shows names and descriptions only — values are masked for security.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "delete_key",
    description: "Delete an API key or secret from the vault.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Key name to delete" },
      },
      required: ["name"],
    },
  },

  {
    name: "create_canvas",
    description: "Create an interactive HTML/CSS/JS canvas that can be viewed in the browser. Use for dashboards, visualizations, mini-apps, or any UI the user needs.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Canvas title/ID (used in URL)" },
        html: { type: "string", description: "HTML content" },
        css: { type: "string", description: "Optional CSS styles" },
        js: { type: "string", description: "Optional JavaScript" },
      },
      required: ["title", "html"],
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

      case "browser": {
        const { action, url, selector, text, script } = toolInput;
        try {
          if (action === "close") {
            if (browserInstance) {
              await browserInstance.close();
              browserInstance = null;
              browserPage = null;
            }
            return "Browser closed.";
          }

          const page = await ensureBrowser();

          switch (action) {
            case "navigate": {
              if (!url) return "Error: 'url' is required for navigate action.";
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
              const title = await page.title();
              return `Navigated to: ${page.url()}\nTitle: ${title}`;
            }
            case "screenshot": {
              const buf = await page.screenshot({ type: "png", fullPage: false });
              const b64 = buf.toString("base64");
              return `Screenshot captured (${buf.length} bytes, base64). Data URL: data:image/png;base64,${b64.slice(0, 200)}... (truncated for display, full image available)`;
            }
            case "click": {
              if (!selector) return "Error: 'selector' is required for click action.";
              await page.click(selector, { timeout: 10_000 });
              return `Clicked element: ${selector}`;
            }
            case "type": {
              if (!selector) return "Error: 'selector' is required for type action.";
              if (!text) return "Error: 'text' is required for type action.";
              await page.fill(selector, text);
              return `Typed "${text}" into ${selector}`;
            }
            case "evaluate": {
              if (!script) return "Error: 'script' is required for evaluate action.";
              const result = await page.evaluate(script);
              return truncate(JSON.stringify(result, null, 2) || "undefined", MAX_RESULT);
            }
            case "get_text": {
              const bodyText = await page.textContent("body");
              return truncate(bodyText || "(empty page)", MAX_RESULT);
            }
            default:
              return `Unknown browser action: ${action}. Valid actions: navigate, screenshot, click, type, evaluate, get_text, close`;
          }
        } catch (err) {
          return `Browser error (${action}): ${err.message}`;
        }
      }

      case "web_search": {
        const { query, max_results } = toolInput;
        const limit = Math.min(Math.max(max_results || 5, 1), 10);
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
          signal: AbortSignal.timeout(15_000),
        });
        const html = await res.text();

        // Parse results from DuckDuckGo HTML
        const results = [];
        const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
          const rawUrl = match[1];
          const title = match[2].replace(/<[^>]+>/g, "").trim();
          // DuckDuckGo wraps URLs in a redirect; extract the actual URL
          let actualUrl = rawUrl;
          const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
          if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);
          results.push({ title, url: actualUrl, snippet: "" });
        }

        // Extract snippets
        let snippetIdx = 0;
        while ((match = snippetRegex.exec(html)) !== null && snippetIdx < results.length) {
          results[snippetIdx].snippet = match[1].replace(/<[^>]+>/g, "").trim();
          snippetIdx++;
        }

        if (results.length === 0) return `No results found for "${query}".`;

        return results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
        ).join("\n\n");
      }

      case "pdf_read": {
        const { source } = toolInput;
        let pdfBuffer;

        if (source.startsWith("http://") || source.startsWith("https://")) {
          // Fetch PDF from URL
          const res = await fetch(source, {
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) return `Error fetching PDF: HTTP ${res.status}`;
          pdfBuffer = Buffer.from(await res.arrayBuffer());
        } else {
          // Read from workspace
          const filePath = path.join(config.WORKSPACE_DIR, source);
          try {
            pdfBuffer = fs.readFileSync(filePath);
          } catch (err) {
            return `Error reading PDF file '${source}': ${err.message}`;
          }
        }

        // Try pdftotext first (poppler-utils), fall back to raw text extraction
        try {
          const { execSync } = await import("node:child_process");
          const tmpPath = path.join(config.WORKSPACE_DIR, ".tmp_pdf_read.pdf");
          fs.writeFileSync(tmpPath, pdfBuffer);
          try {
            const text = execSync(`pdftotext "${tmpPath}" -`, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }).toString();
            fs.unlinkSync(tmpPath);
            if (text.trim()) return truncate(text, MAX_RESULT);
          } catch {
            // pdftotext not available, fall through
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }

        // Fallback: extract readable ASCII text from PDF binary
        const rawText = pdfBuffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
        if (rawText.length < 50) return "Could not extract meaningful text from this PDF. Install poppler-utils (pdftotext) for better PDF support.";
        return truncate(`(Raw text extraction — install pdftotext for better results)\n\n${rawText}`, MAX_RESULT);
      }

      case "spawn_agent": {
        const { task, name } = toolInput;
        if (!task) return "Error: 'task' is required.";
        try {
          const { spawnAgent } = await import("./subagents.js");
          const result = spawnAgent({ task, name, settingsStore: ctx.settingsStore, db: ctx.db });
          return `Agent "${result.name}" spawned (ID: ${result.taskId}). It's working in the background. Use list_agents to check progress or get_agent_result to get output.`;
        } catch (err) {
          return `spawn_agent error: ${err.message}`;
        }
      }

      case "list_agents": {
        try {
          const { listAgents } = await import("./subagents.js");
          const agents = listAgents();
          if (agents.length === 0) return "No subagents running or completed.";
          return agents.map((a) =>
            `[${a.status}] ${a.name} (${a.id}) — ${a.task}${a.resultPreview ? `\n  Preview: ${a.resultPreview}` : ""}`
          ).join("\n\n");
        } catch (err) {
          return `list_agents error: ${err.message}`;
        }
      }

      case "get_agent_result": {
        const { task_id } = toolInput;
        if (!task_id) return "Error: 'task_id' is required.";
        try {
          const { getAgentResult } = await import("./subagents.js");
          const agent = getAgentResult(task_id);
          if (!agent) return `Agent not found: ${task_id}`;
          if (agent.status === "running") return `Agent "${agent.name}" is still running. Check back later.`;
          if (agent.error) return `Agent "${agent.name}" failed: ${agent.error}`;
          return `**Agent: ${agent.name}** (${agent.status})\n**Task:** ${agent.task}\n**Result:**\n${truncate(agent.result || "(no output)", MAX_RESULT)}`;
        } catch (err) {
          return `get_agent_result error: ${err.message}`;
        }
      }

      case "stop_agent": {
        const { task_id } = toolInput;
        if (!task_id) return "Error: 'task_id' is required.";
        try {
          const { stopAgent } = await import("./subagents.js");
          const stopped = stopAgent(task_id);
          return stopped ? `Agent ${task_id} stopped.` : `Agent not found: ${task_id}`;
        } catch (err) {
          return `stop_agent error: ${err.message}`;
        }
      }

      case "analyze_image": {
        const { image, prompt: imgPrompt } = toolInput;
        try {
          const { analyzeImage, getMediaProviderInfo } = await import("./media-understanding.js");
          const providerInfo = getMediaProviderInfo(ctx.settingsStore);
          if (!providerInfo) return "No vision-capable API key configured (needs Anthropic, OpenAI, or Gemini).";
          let imageBuffer;
          if (image.startsWith("http")) {
            const res = await fetch(image, { signal: AbortSignal.timeout(30000) });
            imageBuffer = Buffer.from(await res.arrayBuffer());
          } else {
            imageBuffer = Buffer.from(image, "base64");
          }
          const analysis = await analyzeImage(imageBuffer, "image/png", { ...providerInfo, prompt: imgPrompt });
          return truncate(analysis, MAX_RESULT);
        } catch (err) {
          return `analyze_image error: ${err.message}`;
        }
      }

      case "get_key": {
        const { name: keyName } = toolInput;
        try {
          const { getKey } = await import("./key-vault.js");
          const value = getKey(keyName);
          if (!value) return `Key "${keyName}" not found in vault. Use list_keys to see available keys.`;
          return value;
        } catch (err) {
          return `get_key error: ${err.message}`;
        }
      }

      case "set_key": {
        const { name: skName, value: skValue, description: skDesc } = toolInput;
        try {
          const { setKey } = await import("./key-vault.js");
          const result = setKey(skName, skValue, skDesc);
          return `Key "${result.name}" saved securely (masked: ${result.masked}). Description: ${result.description || "none"}`;
        } catch (err) {
          return `set_key error: ${err.message}`;
        }
      }

      case "list_keys": {
        try {
          const { listKeys } = await import("./key-vault.js");
          const keys = listKeys();
          if (keys.length === 0) return "No keys stored in vault. Use set_key to add API keys.";
          return keys.map(k => k.name + ": " + (k.description || "(no description)") + " [masked: " + k.masked + "]").join("\n");
        } catch (err) {
          return `list_keys error: ${err.message}`;
        }
      }

      case "delete_key": {
        const { name: dkName } = toolInput;
        try {
          const { deleteKey } = await import("./key-vault.js");
          const deleted = deleteKey(dkName);
          return deleted ? `Key "${dkName}" deleted from vault.` : `Key "${dkName}" not found.`;
        } catch (err) {
          return `delete_key error: ${err.message}`;
        }
      }

      case "create_canvas": {
        const { title, html, css, js } = toolInput;
        try {
          const { CanvasServer } = await import("./canvas.js");
          const canvas = CanvasServer.create();
          const canvasId = title.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
          const result = canvas.serve(canvasId, html, css, js);
          return `Canvas created! View at: /canvas/${canvasId}/  (${result.size} bytes)`;
        } catch (err) {
          return `create_canvas error: ${err.message}`;
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
