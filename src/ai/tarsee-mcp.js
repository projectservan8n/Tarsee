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
 * A key tool's answer, marked isError (MCP's own failure mark) unless it is lib/tools.js's answer for what was asked: a
 * key saved, a key deleted, a key's value, the list. So every refusal (Tarsee's own key, a name that isn't one, Tool
 * Permissions), every error and a key that isn't there is marked; each engine passes the mark on, and the chat bots'
 * status line then says the save, the removal or the check failed, never "Key saved" (lib/tool-status.js).
 */
const KEY_TOOL_FAILED = /^(?:(?:get|set|list|delete)_key (?:refused|error): |Refused\b|Tool error \(|Unknown tool: |Key ".*" not found)/s;
const KEY_TOOL_WORKED = {
  get_key: (r) => !KEY_TOOL_FAILED.test(r),
  list_keys: (r) => !KEY_TOOL_FAILED.test(r),
  set_key: (r) => /^Key "[^"\n]*" saved securely/.test(r),
  delete_key: (r) => /^Key "[^"\n]*" deleted from vault\.$/.test(r),
};
function keyToolAnswer(tool, result) {
  const text = String(result ?? "");
  const worked = typeof result === "string" && KEY_TOOL_WORKED[tool](result);
  return worked ? { content: [{ type: "text", text }] } : { isError: true, content: [{ type: "text", text }] };
}

/**
 * Create a Tarsee MCP server with platform tools.
 * @param {object} ctx - Tool execution context { db, settingsStore, channelManager, conversationId }
 * @param {{quiet?: boolean, toolsOnly?: boolean}} [opts] - quiet: no "Creating" log line (the Codex endpoint builds one
 *   per turn). toolsOnly: the tool definitions ({ name, description, inputSchema, handler }), with no server: what
 *   lib/cron.js checks a scheduled direct action's args against, for a tool lib/tools.js has no definition of
 * @returns {McpSdkServerConfigWithInstance}
 */
export function createTarseeMcp(ctx, opts = {}) {
  const allTools = [
      tool(
        "tarsee_send_message",
        "Send a message to a channel (Telegram, Discord, WhatsApp, Slack, email, or web chat). Use this to proactively notify the user. For email, channel_id MUST be the target address; for threaded email replies with In-Reply-To headers, use tarsee_send_email_thread instead.",
        { channel: z.enum(["telegram", "discord", "whatsapp", "slack", "email", "web"]).describe("Channel to send to"), message: z.string().describe("Message text"), channel_id: z.string().optional().describe("Specific chat/channel ID (auto-resolved if omitted — required for email)") },
        async (args) => {
          const result = await executeTool("send_message", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

      tool(
        "tarsee_send_file",
        "Send a file as a real attachment (PDF, HTML report, image, audio, video, zip, spreadsheet, anything) to a Telegram, Discord, WhatsApp or Slack chat, or to one of the dashboard's own chats (web: a card there that opens in the viewer). Use it whenever someone asks for a file or you made one for them: never answer with a folder path or a download link instead, and never say a channel can't take attachments. With no channel_id it goes to the chat you are talking in (on Slack, the same thread; else that channel's most recent chat). The file must already exist; a relative path is read from the workspace. Size caps: Telegram 50 MB, Discord 25 MB, WhatsApp 16 MB, Slack 100 MB, web 50 MB. For email, use tarsee_send_email_thread with attachments.",
        {
          channel: z.enum(["telegram", "discord", "whatsapp", "slack", "web"]).describe("Channel to send to: the one you are talking in, unless asked otherwise (web: one of the dashboard's own chats; channel_id is its conversation id, the one you are in by default)"),
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
        "Configure the email channel when the user tells you their IMAP/SMTP credentials in chat. Partial update: only the fields you pass get written; the rest stay as saved. Passwords are stored encrypted. A saved password is only used with the server it was saved for: a call that changes the IMAP or SMTP host, port, user or secure setting must carry that side's password in the same call (ask the user for the app password), or it is refused and nothing is saved. A server set up here is only ever logged in to over TLS: IMAP on 993; SMTP on 465, or 587 with STARTTLS, which must then succeed. secure: false is accepted only for a server that offers STARTTLS, on IMAP port 143 or SMTP port 587, 25 or 2525, and Tarsee then won't log in unless the connection switches to TLS; any other secure: false is refused, as it would send the password in plain text. What would change who can reach you by email, or where your mail goes, is saved but not put in force: turning email on, another IMAP or SMTP host or user (the mailbox Tarsee reads, and where its replies go), and an allowlist that lets in anyone the owner hasn't allowed (an empty list lets any sender in, and no list saved yet counts as nobody allowed). These wait for the owner's OK in Settings > Channels > Email, the rest of the call goes in, and the answer lists what waits: tell the owner it is waiting for them, as you can't OK it yourself. Setting up email from nothing therefore always waits for the owner. What narrows goes straight in: senders removed, email off, the mention word, the display name, another port on the same server. Tarsee answers an allowed address only when the owner's mail provider vouches that the mail really came from it (its Authentication-Results line), since anyone can write any From line; what Tarsee trusts for that is the owner's to set in Settings, not yours. Infer common provider hosts (Gmail: imap.gmail.com:993 / smtp.gmail.com:465; iCloud: imap.mail.me.com:993 / smtp.mail.me.com:587; Zoho: imap.zoho.com:993 / smtp.zoho.com:465; FastMail: imap.fastmail.com:993 / smtp.fastmail.com:465) from the user's email domain when they don't specify. Outlook.com, Hotmail and Microsoft 365 mailboxes cannot connect this way: Microsoft refuses app passwords for IMAP and requires its own sign-in, so tell the user to use a mailbox from another provider instead of saving one.",
        {
          tarseeEmailAddress: z.string().optional().describe("The mailbox Tarsee answers at, e.g. 'tarsee@yourcompany.com'"),
          imap: z.object({
            host: z.string().optional().describe("e.g. imap.gmail.com"),
            port: z.number().optional().describe("Default 993 (TLS). 143 only with secure: false, for a server that offers STARTTLS"),
            user: z.string().optional().describe("Usually the same as the mailbox address"),
            password: z.string().optional().describe("App password — stored encrypted. Required in the same call whenever the IMAP host, port, user or secure setting changes"),
            secure: z.boolean().optional().describe("TLS from the start (default true). false only on port 143, where STARTTLS must then succeed before the login"),
          }).optional().describe("The mailbox Tarsee reads. Another host or user than the one in force waits for the owner's OK in Settings > Channels > Email."),
          smtp: z.object({
            host: z.string().optional().describe("e.g. smtp.gmail.com"),
            port: z.number().optional().describe("Default 465 (implicit TLS) or 587 (STARTTLS, which must succeed)"),
            user: z.string().optional(),
            password: z.string().optional().describe("App password — stored encrypted. Required in the same call whenever the SMTP host, port, user or secure setting changes"),
            secure: z.boolean().optional().describe("Default true. false only on port 587, 25 or 2525, where STARTTLS must then succeed before the login"),
          }).optional().describe("Where Tarsee's replies go out. Another host or user than the one in force waits for the owner's OK in Settings > Channels > Email."),
          allowlistFromAddresses: z.array(z.string()).optional().describe("Only reply to emails from these addresses; empty lets any sender in. A list that lets in anyone the owner hasn't allowed (an empty one too, and any list where the owner has saved none) waits for the owner's OK in Settings > Channels > Email; a narrower one goes straight in."),
          mentionKeyword: z.string().optional().describe("Without leading @. Default 'tarsee'. Tarsee only replies when the body contains this mention."),
          replyAllMarker: z.string().optional().describe("Subject marker that opts into reply-all. Default '[reply-all]'."),
          fromName: z.string().optional().describe("Display name on outbound mail. Default 'Tarsee'."),
          enabled: z.boolean().optional().describe("Turn the channel on or off. Off goes straight in; on waits for the owner's OK in Settings > Channels > Email. Leave it out to keep the current state."),
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
        `Schedule a task using cron syntax. Supports one-time and recurring. For simple notifications, use action (direct, instant). For complex tasks, use prompt (AI session).\n\nOnly schedule a task when the owner asks for one, or has said yes when you offered: every run of a prompt task is a paid turn on the AI. A task you schedule starts paused, and won't run until the owner switches it on, in Settings > Automation > Scheduled tasks or by sending /cron on <id>. Say so when you save one, with its id. You can't schedule tasks while running a scheduled task, the heartbeat or BOOT.md.\n\nEXAMPLES:\n- One-time reminder: schedule='30 12 7 4 *', once=true, action={tool:'send_message', args:{channel:'telegram', message:'Meeting now!'}}\n- Daily recurring: schedule='0 8 * * *', action={tool:'send_message', args:{channel:'telegram', message:'Good morning!'}}\n- Complex: schedule='0 8 * * 1', prompt='Check calendar and summarize the week'\n\nALWAYS prefer action over prompt for send_message tasks. Set once=true for one-time reminders (auto-deletes after firing). A prompt task runs at most once every 15 minutes (5-part schedules, no seconds). Cron expressions are interpreted in ${config.TIMEZONE} — call tarsee_datetime to confirm the current local time before scheduling.`,
        {
          schedule: z.string().describe(`Cron expression. Format: 'min hour day month weekday'. Interpreted in ${config.TIMEZONE}.`),
          name: z.string().optional().describe("Human-friendly name"),
          once: z.boolean().optional().describe("If true, job auto-deletes after firing once. Use for one-time reminders."),
          prompt: z.string().optional().describe("AI prompt for complex tasks (each run is a full, paid AI session)"),
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
            // What fits is checked in lib/cron.js against the tool's own inputs, when the task is saved and at every run.
            args: z.record(z.string(), z.any()).describe("The tool's arguments (e.g. {channel:'telegram', message:'Hello!'}). They must fit that tool's own inputs, checked when the task is saved and at every run, and a refusal lists them (remember takes fact, daily_log takes note, the key tools take name). A direct action never runs get_key and never writes Tarsee's own keys."),
          }).optional().describe("Direct tool action — instant, no AI needed. Use for simple notifications."),
        },
        // A task that was not saved (no prompt or action, a refusal, a bad schedule, the 15-minute rule, Tool
        // Permissions) comes back marked isError, MCP's own failure mark: each engine passes it on (Claude Code as the
        // tool_result's is_error, Codex as a failed call), and the chat bots show a cross, not a tick and "Task saved,
        // waiting for your OK" (lib/tool-status.js). Only lib/tools.js's saved answer counts as saved; anything else,
        // even an answer worded in a way nobody planned for, is marked.
        async (args) => {
          if (!args.prompt && !args.action) {
            return { isError: true, content: [{ type: "text", text: "Error: Either 'prompt' or 'action' is required. Nothing was saved." }] };
          }
          const result = await executeTool("schedule_task", args, ctx);
          // lib/tools.js's answer starts so when, and only when, addCronJob saved the task.
          const saved = typeof result === "string" && result.startsWith("Saved the task ");
          return saved ? { content: [{ type: "text", text: result }] } : { isError: true, content: [{ type: "text", text: result }] };
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
        "Write or overwrite a Tarsee workspace file. Use for updating personality, identity, memory, or user notes. HEARTBEAT.md (the heartbeat's checks) and BOOT.md (what runs when Tarsee restarts) can be written too, but what you write there doesn't run until the owner OKs it in Settings > Automation (Let it run; for BOOT.md, Run at each restart): tell the owner so, and never say it is set up or running before then. The same goes for a change made with your own file or shell tools.",
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
        "Railway jobs done by Tarsee itself with a Railway token it reads from the vault (RAILWAY_API_TOKEN): list_projects (projects; with project, its environments and services), list_variables (variable NAMES on a service, never values), set_variable (set one variable on a service, then Railway redeploys it as it does on any variable change), redeploy (redeploy a service's latest deployment). Use it whenever someone asks to set a Railway variable or redeploy. It replaces any Railway call from Bash: never put a Railway token or a secret value in a command (no `railway variables --set` with a secret, no GraphQL with a token).\n\nSECRETS GO THROUGH from_key: for anything secret (a token, a password, a webhook URL, a database URL) pass from_key, the vault key name that holds it (e.g. from_key: \"ALERTS_WEBHOOK\"). Tarsee reads the value itself; it never shows up in the result, the logs or your context, only a masked form. value is for plain, non-secret text only (a port, a flag, a public URL); a value that looks like a secret or is a vault key's value is refused.\n\nGET THE GO FIRST for set_variable and redeploy: from the owner, or from whoever your instructions (AGENTS.md, USER.md) say may give it. Putting a secret into a service (from_key) counts as handing out a credential, so it needs the owner's go. Put who said go, in their words, in approved_by (it is logged). If nobody has said go for this exact change, ask instead. list_projects and list_variables need no go.\n\nTARSEE'S OWN SERVICE: when Tarsee runs on Railway, leaving out project works on the project Tarsee runs in, in its environment, on its own service. Redeploying it, or setting a variable on it with a deploy, restarts Tarsee and ends the turn doing it: say so before you do it, and finish anything else first.\n\nNEVER, WHOEVER GAVE THE GO: a value with a Railway reference (${{ ... }}) in it, which pulls in another variable's value when the service deploys, is refused on every service. Tarsee's own keys (RAILWAY_API_TOKEN, and its sign-in and encryption secrets) are never copied into a service.\n\nON TARSEE'S OWN SERVICE IT SETS ONLY (an allowlist, with a deploy or without): a key or address for the owner's own scripts, named in capitals and ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL (e.g. SOME_SERVICE_API_KEY, ALERTS_WEBHOOK), unless Tarsee reads that name itself or it appears anywhere in the code of its AI engines or browser library, which may read it (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, VOICE_STREAM_BASE_URL, DATABASE_URL and the like are refused); TZ, with a time zone name; and the tuning settings TARSEE_TIMEZONE, TARSEE_DEFAULT_EFFORT, TARSEE_COMPACT_WINDOW, TARSEE_MODEL_CONTEXT_TOKENS, TARSEE_TOOL_RESULT_MAX_CHARS, TARSEE_BASH_OUTPUT_MAX_CHARS, TARSEE_SESSION_JSONL_MAX_MB, TARSEE_PHONON_THREADS. Everything else is refused there: how people sign in (SETUP_PASSWORD, ENCRYPTION_KEY, TARSEE_API_TOKEN), which AI answers or its keys (TARSEE_AI_PROVIDER, OPENAI_API_KEY and the other AI keys: those go in Settings > AI), how Railway builds and runs it, how programs, shells and the browser start (GOOGLE_API_KEY included), and where its files are. A variable that one of Tarsee's own variables is filled in from by a Railway reference (on any service, through a shared variable or a chain of them) counts as that variable: the same rules apply, under that variable's name. While a refused one is sealed (Railway never shows its value), nothing is set in that environment of Tarsee's project. While get_key is denied in Tool Permissions, from_key onto Tarsee's own service, or into a variable it is filled in from, is refused, and so is any from_key in that environment while one of its variables is sealed. Each refusal says where the owner makes that change instead (Railway's dashboard, or Settings > AI): tell the person that, and do not look for another way to make it.\n\nNAMES OR IDS: project, environment (default: the one Tarsee runs in, else production) and service each take a name (any case) or an id. A name that matches nothing, or more than one, is refused with the choices listed.\n\nNOTHING HERE DELETES: deleting a variable, a service or a project is for the owner to do by hand in Railway; say so if asked. If Railway refuses, the error says why in plain words: tell the person, do not try another way around it.",
        {
          action: z.enum(["list_projects", "list_variables", "set_variable", "redeploy"]).describe("What to do"),
          project: z.string().optional().describe("The project's name (any case) or id. Leave it out for the project Tarsee runs in (on Railway); list_projects without it lists them all"),
          environment: z.string().optional().describe("The environment's name or id (default: the one Tarsee runs in, else production)"),
          service: z.string().optional().describe("list_variables, set_variable, redeploy: the service's name or id (default in Tarsee's own project: Tarsee's own service)"),
          name: z.string().optional().describe("set_variable: the variable's name, e.g. ALERTS_WEBHOOK_URL. On Tarsee's own service only a key or address for the owner's scripts (capitals, ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL, in none of its engines' code), TZ and the tuning settings above"),
          from_key: z.string().optional().describe("set_variable: the vault key whose value to set, for anything secret. The value is read by Tarsee and never shown. Tarsee's own keys (RAILWAY_API_TOKEN, its sign-in and encryption secrets) are refused, and so is from_key onto Tarsee's own service, or into a variable it is filled in from, while get_key is denied in Tool Permissions"),
          value: z.string().optional().describe("set_variable: a plain, NON-SECRET value. Anything secret goes in the vault and through from_key instead. Pass from_key or value, not both. A Railway reference (${{ ... }}) is refused"),
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

      // For an AI that can't open PDFs itself (every model but Claude's): a message's PDF arrives as its first pages'
      // text plus the saved path (ai/media.js), and this reads the rest. Through executeTool, so Tool Permissions apply.
      tool(
        "tarsee_pdf_read",
        "Read the text of a PDF: a file in the workspace (files people send in are saved in its uploads folder) or a web address. Long PDFs come a few pages at a time; the answer says which pages to ask for next. Use it whenever you need what a PDF says and can't open the file yourself. Scanned pages (pictures of text) have no text to read.",
        {
          path: z.string().describe("The PDF: a path in the workspace (absolute, or relative to it, e.g. 'uploads/report.pdf') or an http(s) address"),
          pages: z.string().optional().describe("Which pages: '3', '2-5', or '6-' for page 6 to the end. Default: from page 1, as many as fit"),
          max_chars: z.number().optional().describe("The most characters to return (default 10000, up to 50000)"),
        },
        async (args) => {
          const result = await executeTool("pdf_read", args, ctx);
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
          return keyToolAnswer("get_key", result);
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
          return keyToolAnswer("set_key", result);
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
          return keyToolAnswer("list_keys", result);
        }
      ),

      tool(
        "tarsee_delete_key",
        "Remove a key from the encrypted vault. Use when the user explicitly " +
        "asks to forget or rotate a credential.",
        { key: z.string().describe("Key name to delete") },
        async (args) => {
          const result = await executeTool("delete_key", { name: args.key }, ctx);
          return keyToolAnswer("delete_key", result);
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
          // Through executeTool, so Tool Permissions and the audit log apply (lib/tools.js push_notification).
          const result = await executeTool("push_notification", args, ctx);
          return { content: [{ type: "text", text: result }] };
        }
      ),

  ];
  if (opts.toolsOnly) return allTools;

  // (Quiet for the Codex endpoint, ai/mcp-http.js, which builds one per turn and logs its own start once.)
  if (!opts.quiet) console.log(`[mcp] Creating Tarsee MCP server: ${allTools.length} tools, names: ${allTools.map(t => t.name).join(", ")}`);
  // (A result past TARSEE_TOOL_RESULT_MAX_CHARS goes to a file, by Claude Code itself: ai/context-limits.js.)
  return createSdkMcpServer({ name: "tarsee", version: "1.0.0", tools: allTools });
}
