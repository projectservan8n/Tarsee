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
import config from "../config/env.js";

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
        { channel: z.enum(["telegram", "discord", "whatsapp", "slack", "email", "web"]).describe("Channel to send to"), message: z.string().describe("Message text"), channel_id: z.string().optional().describe("Specific chat/channel ID (auto-resolved if omitted — required for email)") },
        async (args) => {
          const result = await executeTool("send_message", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_send_file",
        "Send a file as a real attachment (PDF, HTML report, image, audio, video, zip, spreadsheet, anything) to a Telegram, Discord or WhatsApp chat, or to one of the dashboard's own chats (web: a card there that opens in the viewer). Use it whenever someone asks for a file or you made one for them: never answer with a folder path or a download link instead, and never say a channel can't take attachments. With no channel_id it goes to the chat you are talking in (else that channel's most recent chat). The file must already exist; a relative path is read from the workspace. Size caps: Telegram 50 MB, Discord 25 MB, WhatsApp 16 MB, web 50 MB. For email, use tarsee_send_email_thread with attachments.",
        {
          channel: z.enum(["telegram", "discord", "whatsapp", "web"]).describe("Channel to send to: the one you are talking in, unless asked otherwise (web: one of the dashboard's own chats; channel_id is its conversation id, the one you are in by default)"),
          file_path: z.string().describe("Absolute path, or a path relative to the workspace"),
          caption: z.string().optional().describe("Optional words sent with the file (Telegram shows up to 1024 characters)"),
          channel_id: z.string().optional().describe("Specific chat/channel ID; leave it out to send to the chat you are in"),
        },
        async (args) => {
          const result = await executeTool("send_file", args, ctx);
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
        "Start a new email thread or reply to an existing one with proper threading headers (In-Reply-To + References). Use this for proactive outbound email — you don't need to wait for the recipient to email first. Body is plain text; no markdown formatting survives email well. For replies, pass inReplyTo with the Message-ID from the inbound email. Attach files with attachments (paths on disk).",
        {
          to: z.union([z.string(), z.array(z.string())]).describe("Primary recipient(s). Single address string or array."),
          cc: z.union([z.string(), z.array(z.string())]).optional().describe("Optional CC recipients"),
          subject: z.string().describe("Subject line (Tarsee adds 'Re: ' automatically when inReplyTo is set)"),
          body: z.string().describe("Plain text body"),
          inReplyTo: z.string().optional().describe("Message-ID of the email you're replying to (include angle brackets). Omit for new threads."),
          attachments: z.array(z.string()).optional().describe("Files to attach as real attachments: absolute paths, or paths relative to the workspace. Never paste a file's contents or a folder path into the body instead."),
        },
        async (args) => {
          const result = await executeTool("send_email_thread", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_schedule_task",
        `Schedule a task using cron syntax. Supports one-time and recurring. For simple notifications, use action (direct, instant). For complex tasks, use prompt (AI session).\n\nEXAMPLES:\n- One-time reminder: schedule='30 12 7 4 *', once=true, action={tool:'send_message', args:{channel:'telegram', message:'Meeting now!'}}\n- Daily recurring: schedule='0 8 * * *', action={tool:'send_message', args:{channel:'telegram', message:'Good morning!'}}\n- Complex: schedule='0 8 * * 1', prompt='Check calendar and summarize the week'\n\nALWAYS prefer action over prompt for send_message tasks. Set once=true for one-time reminders (auto-deletes after firing). Cron expressions are interpreted in ${config.TIMEZONE} — call tarsee_datetime to confirm the current local time before scheduling.`,
        {
          schedule: z.string().describe(`Cron expression. Format: 'min hour day month weekday'. Interpreted in ${config.TIMEZONE}.`),
          name: z.string().optional().describe("Human-friendly name"),
          once: z.boolean().optional().describe("If true, job auto-deletes after firing once. Use for one-time reminders."),
          prompt: z.string().optional().describe("AI prompt for complex tasks (spawns full Claude session)"),
          action: z.object({
            tool: z.string().describe("Tool to execute directly (e.g. 'send_message')"),
            // MUST pass a key schema. zod 4 removed the single-argument form:
            // `z.record(z.any())` builds an object whose keyType is undefined,
            // and converting it to JSON Schema throws inside the MCP server's
            // tools/list handler. That failure is not isolated to this tool —
            // it fails the whole list call, so EVERY mcp__tarsee__* tool went
            // invisible to Claude while the system prompt kept advertising
            // them. That is the real cause of the agent shelling out to curl
            // instead of calling tarsee_send_message. See test/mcp-tools.test.js.
            args: z.record(z.string(), z.any()).describe("Tool arguments (e.g. {channel:'telegram', message:'Hello!'})"),
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
        {
          content: z.string().describe("The fact or note to remember"),
          category: z.string().optional().describe("Optional category label, e.g. 'preference', 'fact', 'project'"),
        },
        async (args) => {
          // executeTool("remember") destructures { fact, category } — map `content`
          // onto `fact` or the memory row is written as undefined.
          const result = await executeTool("remember", { fact: args.content, category: args.category }, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_daily_log",
        "Append an entry to today's daily memory log (memory/YYYY-MM-DD.md).",
        { content: z.string().describe("Log entry to append") },
        async (args) => {
          // executeTool("daily_log") destructures { note } — map `content` onto it.
          const result = await executeTool("daily_log", { note: args.content }, ctx);
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
          timezone: z.string().optional().describe(`IANA timezone, e.g. 'Europe/Berlin', 'America/New_York'. Default: ${config.TIMEZONE}`),
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

      // Without this the agent made channels and webhooks by pulling DISCORD_BOT_TOKEN from the vault and calling
      // Discord's REST API from Bash: auto mode blocks that as a credential leak, rightly. Tarsee's own logged-in bot
      // does it now (src/lib/discord-admin.js). No delete actions.
      tool(
        "tarsee_discord_admin",
        "Admin jobs in a Discord server the bot is in, done by Tarsee's own logged-in bot: list_channels, create_channel (text, voice or category; public, private for listed people and roles, or with another channel's access), edit_channel (name, topic, category, who can see or do what), create_webhook, list_webhooks. Use it whenever someone asks for a new channel, a private channel, a webhook or a permission change. It replaces any Discord REST call from Bash: never pull DISCORD_BOT_TOKEN from the vault for this, and never put a bot token or a webhook URL in a command.\n\nGET THE GO FIRST for anything that changes a server, following the approval rules in your instructions (AGENTS.md). A new webhook counts as a credential (its URL lets anyone post), so create_webhook needs the owner's go. Put who said go, in their words, in approved_by (it is logged and shows in the server's audit log). If nobody has said go for this exact change, ask instead. list_channels and list_webhooks need no go.\n\nTHE SERVER: guild_id, or channel_id of any channel in it (the one you are answering in works), or nothing when the bot is in one server only.\n\nWEBHOOK URLS ARE SECRETS: create_webhook saves the URL in the vault under save_as_key (e.g. ALERTS_WATCHDOG_WEBHOOK; say what it is for in purpose) and returns only the webhook id, the key name and a masked URL. Scripts and services read it from the vault by that key name. reveal: true puts the full URL in the result: only when the owner asks to see it themselves, never for anything that goes into a chat.\n\nNOTHING HERE DELETES: deleting a channel or a webhook is for the owner to do by hand; say so if asked. If Discord refuses for a missing permission, the error says which one and where: tell the person, do not try another way around it.",
        {
          action: z.enum(["list_channels", "create_channel", "edit_channel", "create_webhook", "list_webhooks"]).describe("What to do"),
          guild_id: z.string().optional().describe("The server's id. Optional: channel_id of any channel in it works too, and with one server neither is needed"),
          channel_id: z.string().optional().describe("edit_channel, create_webhook, list_webhooks: the channel to act on. list_channels, create_channel: any channel in the server (e.g. the one you are answering in), only to find the server"),
          approved_by: z.string().optional().describe("Required for create_channel, edit_channel and create_webhook: who said go and for what, e.g. \"the owner in #general: make #alerts and a webhook for the watchdog\""),
          name: z.string().optional().describe("create_channel: the new channel's name. edit_channel: its new name. create_webhook: the webhook's name, shown on its posts"),
          type: z.enum(["text", "voice", "category"]).optional().describe("create_channel: the kind of channel (default text)"),
          parent_id: z.string().optional().describe("create_channel: the category to put it in. edit_channel: the category to move it to, or \"none\" to take it out of its category"),
          topic: z.string().optional().describe("Text channels: the topic line (an empty string clears it in edit_channel)"),
          near_channel_id: z.string().optional().describe("create_channel: put the new channel next to this one (it goes in the same category unless parent_id says otherwise)"),
          place: z.enum(["before", "after"]).optional().describe("create_channel with near_channel_id: before or after it (default after)"),
          private: z.boolean().optional().describe("create_channel, edit_channel: true hides it from @everyone and lets in only the bot, allow_user_ids and allow_role_ids (and server admins). edit_channel false: @everyone's view goes back to the default"),
          allow_user_ids: z.array(z.string()).optional().describe("With private: true, the Discord user ids who may see and use it"),
          allow_role_ids: z.array(z.string()).optional().describe("With private: true, the role ids whose members may see and use it"),
          copy_permissions_from: z.string().optional().describe("create_channel: give the new channel the same access as this channel (instead of private). Without either, a channel in a category gets the category's access, and one outside any category is public"),
          sync_with_category: z.boolean().optional().describe("edit_channel: replace its access with its category's (the new one when parent_id is given)"),
          permissions: z.array(z.object({
            target: z.string().describe("A user id, a role id, or \"everyone\""),
            target_type: z.enum(["user", "role"]).optional().describe("Only if the id could be either"),
            allow: z.array(z.string()).optional().describe("Permissions to allow, e.g. ViewChannel, SendMessages, ReadMessageHistory, Connect, Speak (or view, send, history)"),
            deny: z.array(z.string()).optional().describe("Permissions to deny"),
            reset: z.array(z.string()).optional().describe("Permissions to set back to the default (neither allowed nor denied here)"),
            clear: z.boolean().optional().describe("true removes this target's whole overwrite on the channel"),
          })).optional().describe("edit_channel: who may see or do what in the channel"),
          save_as_key: z.string().optional().describe("create_webhook: the vault key name for the URL, capitals and underscores, e.g. ALERTS_WATCHDOG_WEBHOOK (default DISCORD_WEBHOOK_<CHANNEL>). An existing key is never replaced unless overwrite_key is true"),
          purpose: z.string().optional().describe("create_webhook: what the webhook is for, saved with the vault key, e.g. \"uptime watchdog alerts\""),
          overwrite_key: z.boolean().optional().describe("create_webhook: replace a vault key of that name that is already there"),
          use_bot_avatar: z.boolean().optional().describe("create_webhook: give the webhook the bot's own picture"),
          reveal: z.boolean().optional().describe("create_webhook: also return the full URL. Only when the owner asks to see it themselves; never for anything that goes into a chat"),
        },
        async (args) => {
          const result = await executeTool("discord_admin", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      // Setting a Railway variable otherwise means a command with the value in it (`railway variables --set`, or
      // GraphQL with the token), a secret in a command line and a transcript. Tarsee does it with a token from the
      // vault (lib/railway-admin.js). No delete actions.
      tool(
        "tarsee_railway",
        "Railway jobs done by Tarsee itself with a Railway token it reads from the vault (RAILWAY_API_TOKEN): list_projects (projects; with project, its environments and services), list_variables (variable NAMES on a service, never values), set_variable (set one variable on a service, then Railway redeploys it as it does on any variable change), redeploy (redeploy a service's latest deployment). Use it whenever someone asks to set a Railway variable or redeploy. It replaces any Railway call from Bash: never put a Railway token or a secret value in a command (no `railway variables --set` with a secret, no GraphQL with a token).\n\nSECRETS GO THROUGH from_key: for anything secret (a token, a password, a webhook URL, a database URL) pass from_key, the vault key name that holds it (e.g. from_key: \"ALERTS_WEBHOOK\"). Tarsee reads the value itself; it never shows up in the result, the logs or your context, only a masked form. value is for plain, non-secret text only (a port, a flag, a public URL); a value that looks like a secret or is a vault key's value is refused.\n\nGET THE GO FIRST for set_variable and redeploy: from the owner, or from whoever your instructions (AGENTS.md, USER.md) say may give it. Putting a secret into a service (from_key) counts as handing out a credential, so it needs the owner's go. Put who said go, in their words, in approved_by (it is logged). If nobody has said go for this exact change, ask instead. list_projects and list_variables need no go.\n\nTARSEE'S OWN SERVICE: when Tarsee runs on Railway, leaving out project works on the project Tarsee runs in, in its environment, on its own service. Redeploying it, or setting a variable on it with a deploy, restarts Tarsee and ends the turn doing it: say so before you do it, and finish anything else first.\n\nNAMES OR IDS: project, environment (default: the one Tarsee runs in, else production) and service each take a name (any case) or an id. A name that matches nothing, or more than one, is refused with the choices listed.\n\nNOTHING HERE DELETES: deleting a variable, a service or a project is for the owner to do by hand in Railway; say so if asked. If Railway refuses, the error says why in plain words: tell the person, do not try another way around it.",
        {
          action: z.enum(["list_projects", "list_variables", "set_variable", "redeploy"]).describe("What to do"),
          project: z.string().optional().describe("The project's name (any case) or id. Leave it out for the project Tarsee runs in (on Railway); list_projects without it lists them all"),
          environment: z.string().optional().describe("The environment's name or id (default: the one Tarsee runs in, else production)"),
          service: z.string().optional().describe("list_variables, set_variable, redeploy: the service's name or id (default in Tarsee's own project: Tarsee's own service)"),
          name: z.string().optional().describe("set_variable: the variable's name, e.g. ALERTS_WEBHOOK_URL"),
          from_key: z.string().optional().describe("set_variable: the vault key whose value to set, for anything secret. The value is read by Tarsee and never shown"),
          value: z.string().optional().describe("set_variable: a plain, NON-SECRET value. Anything secret goes in the vault and through from_key instead. Pass from_key or value, not both"),
          deploy: z.boolean().optional().describe("set_variable: true (default) lets Railway redeploy the service as it normally does on a variable change; false sets it without a deploy (it takes effect on the next one)"),
          approved_by: z.string().optional().describe("Required for set_variable and redeploy: who said go and for what, e.g. \"the owner in chat: put the alerts webhook on the worker service\""),
        },
        async (args) => {
          const result = await executeTool("railway", args, ctx);
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
        { query: z.string().describe("Search query"), num_results: z.number().optional().describe("Number of results, 1-10 (default 5)") },
        async (args) => {
          // executeTool("web_search") destructures { query, max_results } — map
          // `num_results` onto it, otherwise the count is silently ignored and
          // every search returns the default 5.
          const result = await executeTool("web_search", { query: args.query, max_results: args.num_results }, ctx);
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
  // (A result past TARSEE_TOOL_RESULT_MAX_CHARS goes to a file, by Claude Code itself: ai/context-limits.js.)
  return createSdkMcpServer({ name: "tarsee", version: "1.0.0", tools: allTools });
}
