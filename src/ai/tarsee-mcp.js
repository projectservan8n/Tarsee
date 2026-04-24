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
        "Send a message to a channel (Telegram, Discord, Slack, email, or web chat). Use this to proactively notify the user. For email, channel_id MUST be the target address; for threaded email replies with In-Reply-To headers, use tarsee_send_email_thread instead.",
        { channel: z.enum(["telegram", "discord", "slack", "email", "web"]).describe("Channel to send to"), message: z.string().describe("Message text"), channel_id: z.string().optional().describe("Specific chat/channel ID (auto-resolved if omitted — required for email)") },
        async (args) => {
          const result = await executeTool("send_message", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_configure_email_channel",
        "Configure the email channel when the user tells you their IMAP/SMTP credentials in chat. Partial-update — only the fields you pass get written; existing values stay. Passwords are stored encrypted. Call this instead of asking the user to open Settings. Infer common provider hosts (Gmail: imap.gmail.com:993 / smtp.gmail.com:465; Outlook: outlook.office365.com:993 / smtp.office365.com:587; iCloud: imap.mail.me.com:993 / smtp.mail.me.com:587; Zoho: imap.zoho.com:993 / smtp.zoho.com:465; FastMail: imap.fastmail.com:993 / smtp.fastmail.com:465) from the user's email domain when they don't specify.",
        {
          tarseeEmailAddress: z.string().optional().describe("The mailbox Tarsee answers at, e.g. 'tarsee@yourcompany.com'"),
          imap: z.object({
            host: z.string().optional(),
            port: z.number().optional().describe("Default 993"),
            user: z.string().optional().describe("Usually the same as the mailbox address"),
            password: z.string().optional().describe("App password — stored encrypted"),
            secure: z.boolean().optional(),
          }).optional(),
          smtp: z.object({
            host: z.string().optional(),
            port: z.number().optional().describe("Default 465 (implicit TLS) or 587 (STARTTLS)"),
            user: z.string().optional(),
            password: z.string().optional().describe("App password — stored encrypted"),
            secure: z.boolean().optional(),
          }).optional(),
          allowlistFromAddresses: z.array(z.string()).optional().describe("Only reply to emails from these addresses. Empty = accept from anyone (dev mode — warn the user)."),
          mentionKeyword: z.string().optional().describe("Without leading @. Default 'tarsee'. Tarsee only replies when the body contains this mention."),
          replyAllMarker: z.string().optional().describe("Subject marker that opts into reply-all. Default '[reply-all]'."),
          fromName: z.string().optional().describe("Display name on outbound mail. Default 'Tarsee'."),
          enabled: z.boolean().optional().describe("Toggle the channel on/off. Leave undefined to preserve current state."),
        },
        async (args) => {
          const result = await executeTool("configure_email_channel", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_send_email_thread",
        "Start a new email thread or reply to an existing one with proper threading headers (In-Reply-To + References). Use this for proactive outbound email — you don't need to wait for the recipient to email first. Body is plain text; no markdown formatting survives email well. For replies, pass inReplyTo with the Message-ID from the inbound email.",
        {
          to: z.union([z.string(), z.array(z.string())]).describe("Primary recipient(s). Single address string or array."),
          cc: z.union([z.string(), z.array(z.string())]).optional().describe("Optional CC recipients"),
          subject: z.string().describe("Subject line (Tarsee adds 'Re: ' automatically when inReplyTo is set)"),
          body: z.string().describe("Plain text body"),
          inReplyTo: z.string().optional().describe("Message-ID of the email you're replying to (include angle brackets). Omit for new threads."),
        },
        async (args) => {
          const result = await executeTool("send_email_thread", args, ctx);
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
        "tarsee_create_diagram",
        "Render a clickable flowchart/diagram in chat. Use for multi-step processes, workflows, architecture, decision trees. Each clickable node triggers a follow-up question when the user clicks it.",
        {
          title: z.string().describe("Diagram title"),
          nodes: z.array(z.object({
            id: z.string(),
            label: z.string(),
            sublabel: z.string().optional(),
            kind: z.enum(["trigger", "processing", "decision", "output", "note"]),
            question: z.string().optional(),
          })).describe("Diagram nodes"),
          edges: z.array(z.object({
            from: z.string(),
            to: z.string(),
            label: z.string().optional(),
          })).describe("Directional connections"),
          legend: z.array(z.object({
            kind: z.enum(["trigger", "processing", "decision", "output", "note"]),
            label: z.string().optional(),
          })).optional(),
        },
        async (args) => {
          const result = await executeTool("create_diagram", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_datetime",
        "Get current date/time/day or convert timezones. ALWAYS use this for dates and days of the week — never guess.",
        {
          timezone: z.string().optional().describe("IANA timezone, e.g. 'Asia/Manila', 'America/New_York'. Default: Asia/Manila"),
          date: z.string().optional().describe("Date to check, e.g. '2026-04-17' or 'next friday'"),
          format: z.enum(["full", "date", "time", "day", "iso"]).optional().describe("Output format"),
        },
        async (args) => {
          const result = await executeTool("datetime", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_calculator",
        "Evaluate a math expression with precision. Use for ANY math — arithmetic, percentages, conversions, financial calculations. Never do math in your head.",
        {
          expression: z.string().describe("Math expression, e.g. '(149 * 12) * 0.85' or 'Math.sqrt(144)'"),
        },
        async (args) => {
          const result = await executeTool("calculator", args, ctx);
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
        "Get a value from the encrypted key vault. The session system prompt " +
        "already includes an inventory of what's available — use this tool to " +
        "fetch the actual value when you need to USE a key, not to check whether " +
        "one exists.",
        { key: z.string().describe("Key name (matches an entry from the inventory)") },
        async (args) => {
          // executeTool's get_key case destructures `name` — map the MCP-level `key` to that.
          const result = await executeTool("get_key", { name: args.key }, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_set_key",
        "Store a value in the encrypted key vault. Use when the user gives you " +
        "a new credential (API key, token, password) to remember across sessions.",
        {
          key: z.string().describe("Key name (uppercase with underscores, e.g. STRIPE_SECRET)"),
          value: z.string().describe("Secret value — stored encrypted at rest"),
          description: z.string().optional().describe("What this key is for (surfaced in the next session's inventory)"),
        },
        async (args) => {
          const result = await executeTool("set_key", { name: args.key, value: args.value, description: args.description }, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_list_keys",
        "Re-query the vault live for the current list of keys. The session " +
        "system prompt already snapshots this at start, so only call this if " +
        "you just set/deleted a key or suspect the inventory is stale. Returns " +
        "names + descriptions only — values require tarsee_get_key.",
        {},
        async () => {
          const result = await executeTool("list_keys", {}, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_delete_key",
        "Remove a key from the encrypted vault. Use when the user explicitly " +
        "asks to forget or rotate a credential.",
        { key: z.string().describe("Key name to delete") },
        async (args) => {
          const result = await executeTool("delete_key", { name: args.key }, ctx);
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
        "tarsee_push_notification",
        "Send a Web Push notification to all the user's registered devices (iPhone/iPad PWA, laptop browsers). Use this for time-sensitive pings — cron completions, webhook alerts, proactive reminders — when the user may not have the app open. Non-urgent follow-ups should use tarsee_send_message instead.",
        {
          title: z.string().describe("Short headline — appears as the notification title. Keep under 50 chars."),
          body: z.string().describe("One- or two-sentence body. Keep under 200 chars; platforms truncate."),
          url: z.string().optional().describe("Deep-link URL on tap. Defaults to the app root. Use e.g. '/?conv=xxx' to jump to a specific conversation."),
          tag: z.string().optional().describe("Grouping tag — pushes with the same tag replace each other in the tray instead of stacking."),
        },
        async (args) => {
          try {
            const { sendPush } = await import("../lib/push.js");
            const res = await sendPush(args);
            if (res.total === 0) {
              return { content: [{ type: "text", text: "No devices have subscribed to push notifications yet. Ask the user to enable them from Settings > Appearance." }] };
            }
            return { content: [{ type: "text", text: `Push sent to ${res.sent}/${res.total} devices · ${res.failed} failed · ${res.evicted} evicted as gone.` }] };
          } catch (err) {
            return { content: [{ type: "text", text: "Push failed: " + err.message }] };
          }
        }
      ),

  ];

  console.log(`[mcp] Creating Tarsee MCP server: ${allTools.length} tools, names: ${allTools.map(t => t.name).join(", ")}`);
  return createSdkMcpServer({ name: "tarsee", version: "1.0.0", tools: allTools });
}
