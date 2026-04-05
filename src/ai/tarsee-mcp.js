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
 * Create a Tarsee MCP server with all platform tools.
 * @param {object} ctx - Tool execution context { db, settingsStore, channelManager, conversationId }
 * @returns {McpSdkServerConfigWithInstance}
 */
export function createTarseeMcp(ctx) {
  return createSdkMcpServer({
    name: "tarsee",
    version: "1.0.0",
    tools: [
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
        "Schedule a recurring or one-time task using cron syntax. The task runs as an AI prompt at the scheduled time. Example: '0 20 * * *' for daily at 8 PM.",
        { schedule: z.string().describe("Cron expression (e.g. '0 20 * * *' for 8 PM daily)"), prompt: z.string().describe("The AI prompt to execute at the scheduled time"), name: z.string().optional().describe("Human-friendly name for this task") },
        async (args) => {
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
    ],
  });
}
