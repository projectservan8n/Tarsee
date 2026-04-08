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
 * @param {object} [opts] - Options
 * @param {boolean} [opts.isOrchestrator] - If true, exclude web_fetch/web_search (force delegation to agents)
 * @returns {McpSdkServerConfigWithInstance}
 */
export function createTarseeMcp(ctx, opts = {}) {
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

      tool(
        "tarsee_spawn_agent",
        "Spawn a background agent to work on a task independently. Each agent runs its own Claude session with its own model. Use for parallel work — research while coding, draft while analyzing. The orchestrator (you) will be notified when agents complete.\n\nAvailable agents: Use tarsee_list_agents to see them, or specify by id: 'coder' (Opus), 'researcher' (Sonnet), 'writer' (Sonnet), 'quick' (Haiku).",
        {
          task: z.string().describe("The task for the agent to work on"),
          name: z.string().optional().describe("Human-friendly task name"),
          agent_id: z.string().optional().describe("Agent type: 'coder', 'researcher', 'writer', 'quick'. Auto-selects if omitted."),
        },
        async (args) => {
          const { spawnAgent } = await import("../lib/subagents.js");
          try {
            const result = spawnAgent({
              task: args.task,
              name: args.name,
              agentId: args.agent_id,
              settingsStore: ctx.settingsStore,
              db: ctx.db,
              channelManager: ctx.channelManager,
            });
            const queueMsg = result.queued
              ? `Agent ${result.name} is busy — task queued at position ${result.position}. `
              : `Agent ${result.name} started. `;
            return { content: [{ type: "text", text: `${queueMsg}task_id: "${result.taskId}". NOW call tarsee_await_agent("${result.taskId}") to wait for the result.` }] };
          } catch (err) {
            return { content: [{ type: "text", text: `Failed to spawn agent: ${err.message}` }] };
          }
        }
      ),

      tool(
        "tarsee_check_agents",
        "Check the status of all background agents. Shows running, completed, and failed tasks.",
        {},
        async () => {
          const { listAgents } = await import("../lib/subagents.js");
          const agents = listAgents();
          if (agents.length === 0) return { content: [{ type: "text", text: "No agents running or recently completed." }] };
          const lines = agents.map(a => {
            const status = a.status === "running" ? `🟡 Running (${a.toolsUsed} tools${a.lastTool ? `, last: ${a.lastTool}` : ""})` :
              a.status === "queued" ? "⏳ Queued" :
              a.status === "completed" ? "✅ Done" : a.status === "failed" ? "❌ Failed" : "⏹️ Stopped";
            return `${a.icon || "🤖"} **${a.name}** [${a.id}] — ${status}\n  Task: ${a.task}\n  ${a.resultPreview ? `Result: ${a.resultPreview}` : ""}`;
          });
          return { content: [{ type: "text", text: lines.join("\n\n") }] };
        }
      ),

      tool(
        "tarsee_get_agent_result",
        "Get the full result of a completed background agent.",
        { task_id: z.string().describe("The task ID returned by tarsee_spawn_agent") },
        async (args) => {
          const { getAgentResult } = await import("../lib/subagents.js");
          const result = getAgentResult(args.task_id);
          if (!result) return { content: [{ type: "text", text: "Agent not found." }] };
          return { content: [{ type: "text", text: `**${result.name}** (${result.status})\nModel: ${result.model || "default"}\nTools: ${result.toolsUsed}\n\n${result.result || result.error || "No output"}` }] };
        }
      ),

      tool(
        "tarsee_await_agent",
        "Wait for a spawned agent to complete and return its full result. Call this IMMEDIATELY after spawn_agent. Blocks until the agent finishes (up to timeout).",
        {
          task_id: z.string().describe("The task_id returned by tarsee_spawn_agent"),
          timeout: z.number().optional().describe("Max seconds to wait (default 120)"),
        },
        async (args) => {
          const { getAgentResult } = await import("../lib/subagents.js");
          const start = Date.now();
          const timeoutMs = (args.timeout || 120) * 1000;
          while (Date.now() - start < timeoutMs) {
            const result = getAgentResult(args.task_id);
            if (!result) return { content: [{ type: "text", text: `Agent "${args.task_id}" not found.` }] };
            if (result.status === "completed") {
              return { content: [{ type: "text", text: `**${result.name}** completed.\nModel: ${result.model || "default"} | Tools used: ${result.toolsUsed}\n\n${result.result || "(no output)"}` }] };
            }
            if (result.status === "failed") {
              return { content: [{ type: "text", text: `**${result.name}** failed: ${result.error || "unknown error"}` }] };
            }
            if (result.status === "stopped") {
              return { content: [{ type: "text", text: `**${result.name}** was stopped.` }] };
            }
            // Still running — wait 3s and check again
            await new Promise(r => setTimeout(r, 3000));
          }
          return { content: [{ type: "text", text: `**${args.task_id}** is still running after ${args.timeout || 120}s. Use tarsee_check_agents to monitor.` }] };
        }
      ),

      tool(
        "tarsee_list_agents",
        "List available agent types (Coder, Researcher, Writer, Quick) with their models and capabilities.",
        {},
        async () => {
          const { getAgents } = await import("../lib/agent-registry.js");
          const agents = getAgents();
          const lines = agents.map(a => `${a.icon || "🤖"} **${a.name}** (\`${a.id}\`) — ${a.model}\n  ${a.prompt.slice(0, 100)}`);
          return { content: [{ type: "text", text: `Available agents:\n\n${lines.join("\n\n")}` }] };
        }
      ),
  ];

  console.log(`[mcp] Creating Tarsee MCP server: ${allTools.length} tools, names: ${allTools.map(t => t.name).join(", ")}`);
  return createSdkMcpServer({ name: "tarsee", version: "1.0.0", tools: allTools });
}
