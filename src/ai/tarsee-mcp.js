/**
 * Tarsee MCP Server
 *
 * Exposes Tarsee's tools (send_message, schedule_task, remember, etc.)
 * as native MCP tools for Claude Code. This lets Claude directly use
 * Tarsee capabilities without curl/bash workarounds.
 *
 * Uses the Agent SDK's in-process MCP server — no separate process needed.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { executeTool } from "../lib/tools.js";

/**
 * Create a Tarsee MCP server with platform tools.
 * @param {object} ctx - Tool execution context { db, settingsStore, channelManager, conversationId }
 * @returns {McpSdkServerConfigWithInstance}
 */
export function createTarseeMcp(ctx) {
  const allTools = [
      tool(
        "tarsee_send_message",
        "Send a message to a channel (Telegram, Discord, Slack, or web chat). Use this to proactively notify the user.",
        { channel: z.enum(["telegram", "discord", "slack", "web"]).describe("Channel to send to"), message: z.string().describe("Message text"), channel_id: z.string().optional().describe("Specific chat/channel ID (auto-resolved if omitted)") },
        async (args) => {
          const result = await executeTool("send_message", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_schedule_task",
        "Schedule a task using cron syntax. Supports one-time and recurring. For simple notifications, use action (direct, instant). For complex tasks, use prompt (AI session).\n\nEXAMPLES:\n- One-time reminder: schedule='30 12 7 4 *', once=true, action={tool:'send_message', args:{channel:'telegram', message:'Meeting now!'}}\n- Daily recurring: schedule='0 1 * * *', action={tool:'send_message', args:{channel:'telegram', message:'Good morning!'}}\n- Complex: schedule='0 1 * * 1', prompt='Check calendar and summarize the week'\n\nALWAYS prefer action over prompt for send_message tasks. Set once=true for one-time reminders (auto-deletes after firing). Server is UTC — user is PHT (UTC+8), so subtract 8 hours.",
        {
          schedule: z.string().describe("Cron expression. Format: 'min hour day month weekday'. Server is UTC — subtract 8 for PHT."),
          name: z.string().optional().describe("Human-friendly name"),
          once: z.boolean().optional().describe("If true, job auto-deletes after firing once. Use for one-time reminders."),
          prompt: z.string().optional().describe("AI prompt for complex tasks (spawns full Claude session)"),
          action: z.object({
            tool: z.string().describe("Tool to execute directly (e.g. 'send_message')"),
            args: z.record(z.any()).describe("Tool arguments (e.g. {channel:'telegram', message:'Hello!'})"),
          }).optional().describe("Direct tool action — instant, no AI needed. Use for simple notifications."),
        },
        async (args) => {
          if (!args.prompt && !args.action) {
            return { content: [{ type: "text", text: "Error: Either 'prompt' or 'action' is required." }] };
          }
          const result = await executeTool("schedule_task", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_remember",
        "Save an important fact or note to long-term memory. This persists across conversations and restarts.",
        { content: z.string().describe("The fact or note to remember") },
        async (args) => {
          const result = await executeTool("remember", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_daily_log",
        "Append an entry to today's daily memory log (memory/YYYY-MM-DD.md).",
        { content: z.string().describe("Log entry to append") },
        async (args) => {
          const result = await executeTool("daily_log", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_read_file",
        "Read a Tarsee workspace file (SOUL.md, IDENTITY.md, MEMORY.md, USER.md, etc.) or a daily memory log.",
        { filename: z.string().describe("Filename to read, e.g. 'MEMORY.md' or 'memory/2026-04-05.md'") },
        async (args) => {
          const result = await executeTool("read_file", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_write_file",
        "Write or overwrite a Tarsee workspace file. Use for updating personality, identity, memory, or user notes.",
        { filename: z.string().describe("Workspace filename"), content: z.string().describe("Full content to write") },
        async (args) => {
          const result = await executeTool("write_file", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_search_memories",
        "Search through all memory files for a keyword or phrase.",
        { query: z.string().describe("Search term") },
        async (args) => {
          const result = await executeTool("search_memories", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_search_memories_deep",
        "Deep semantic search — reads ALL memories, MEMORY.md, and last 30 daily logs so you can reason about what's relevant. Use when keyword search returns nothing or the query is vague/conceptual.",
        { query: z.string().describe("What you're looking for — natural language description") },
        async (args) => {
          const result = await executeTool("search_memories_deep", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_create_canvas",
        "Create an interactive HTML/CSS/JS canvas — renders as a live iframe in chat. Use for dashboards, charts, visualizations, mini-apps, calculators, or any interactive UI the user requests.",
        {
          title: z.string().describe("Canvas title/ID (used in URL, lowercase, hyphens ok)"),
          html: z.string().describe("HTML content (the body, no need for full document)"),
          css: z.string().optional().describe("CSS styles"),
          js: z.string().optional().describe("JavaScript code"),
        },
        async (args) => {
          const result = await executeTool("create_canvas", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_browser",
        "Control a stealth web browser with captcha solving. Navigate pages, fill forms, click buttons, take screenshots, and auto-solve reCAPTCHA/hCaptcha/Turnstile. Browser persists across calls.",
        {
          action: z.enum(["navigate", "screenshot", "click", "type", "evaluate", "get_text", "wait_for", "scroll", "select", "solve_captcha", "close"]).describe("Browser action"),
          url: z.string().optional().describe("URL to navigate to"),
          selector: z.string().optional().describe("CSS selector for target element"),
          text: z.string().optional().describe("Text to type"),
          script: z.string().optional().describe("JavaScript to evaluate in page"),
          value: z.string().optional().describe("Value for select dropdown"),
          timeout: z.number().optional().describe("Timeout in ms (default 30000)"),
          direction: z.enum(["down", "up", "bottom", "top"]).optional().describe("Scroll direction"),
        },
        async (args) => {
          const result = await executeTool("browser", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_web_fetch",
        "Fetch a URL and return its content (HTML converted to text, or raw for APIs).",
        { url: z.string().describe("URL to fetch"), raw: z.boolean().optional().describe("Return raw response (for APIs)") },
        async (args) => {
          const result = await executeTool("web_fetch", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_web_search",
        "Search the web and return results.",
        { query: z.string().describe("Search query"), num_results: z.number().optional().describe("Number of results (default 5)") },
        async (args) => {
          const result = await executeTool("web_search", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_get_key",
        "Get a value from the encrypted key vault.",
        { key: z.string().describe("Key name") },
        async (args) => {
          const result = await executeTool("get_key", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_set_key",
        "Store a value in the encrypted key vault.",
        { key: z.string().describe("Key name"), value: z.string().describe("Value to store") },
        async (args) => {
          const result = await executeTool("set_key", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_list_files",
        "List all Tarsee workspace files and their sizes.",
        {},
        async () => {
          const result = await executeTool("list_files", {}, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

  ];

  console.log(`[mcp] Creating Tarsee MCP server: ${allTools.length} tools, names: ${allTools.map(t => t.name).join(", ")}`);
  return createSdkMcpServer({ name: "tarsee", version: "1.0.0", tools: allTools });
}
