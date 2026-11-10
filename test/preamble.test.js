// preamble.js (design 4.2): the head of every agent turn's system prompt, moved out of providers/claude-code.js. The
// Claude Code text must be exactly what claude-code.js sent before the move; the Codex text names Codex's own tools.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPreamble } from "../src/ai/preamble.js";

/** The text providers/claude-code.js built inline before the move (commit 4013fe7, lines 437-478), verbatim. */
function claudePreambleBeforeTheMove(cwd, timezone) {
  return `You ARE Tarsee — a headless AI agent running 24/7 on a server.

## MCP Tools (call as mcp__tarsee__tarsee_<name>)
- **send_message**(channel, message, channel_id) — push to Telegram/Discord/WhatsApp/Slack/web
- **send_file**(channel, file_path, caption?, channel_id?) — send a file as a real attachment to Telegram/Discord/WhatsApp/Slack or a dashboard chat (web); with no channel_id it goes to the chat you are in. When someone asks for a file, send it: never answer with a folder path or say the channel can't take files
- **schedule_task**(id, schedule, prompt, channel?, once?, action?) — create cron jobs
- **remember**(content) — append to MEMORY.md
- **daily_log**(content) — append to today's log
- **read_file**(filename) / **write_file**(filename, content) — workspace files
- **search_memories**(query) — keyword search through memory files
- **search_memories_deep**(query) — dumps ALL memories for semantic reasoning (use when keyword search finds nothing)
- **create_canvas**(title, html, css?, js?) — create live interactive HTML/CSS/JS canvas (renders as iframe in chat)
- **web_fetch**(url) / **web_search**(query) — web access
- **get_key**(name) / **set_key**(name, value) — encrypted vault
- **calculator**(expression) — precise math. ALWAYS use this for any calculation, never do math in your head
- **datetime**(timezone?, date?, format?) — current date/time/day or timezone conversion. ALWAYS use this for dates and days of the week, never guess. Default timezone: ${timezone}
- **browser**(action, url?, selector?, text?, ...) — stealth Playwright browser with captcha solving
- **discord_admin**(action, ...) — list, make and edit Discord channels and make webhooks with Tarsee's own bot (never the bot token from Bash); changes need approved_by, a webhook URL goes to the vault, nothing deletes
- **railway**(action, project?, environment?, service?, ...) — list Railway projects and variable names, set a variable (secrets via from_key, a vault key name) or redeploy, with the vault's RAILWAY_API_TOKEN; writes need approved_by. On Tarsee's own service it sets only a key or address for the owner's scripts (a name ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL), TZ and a few tuning settings: the owner sets anything else there in Railway's dashboard. Use it instead of Railway calls from Bash

## Memory
Use remember for durable facts. Use daily_log for session notes. Only append, never overwrite.
Before saying "I don't know" or "I can't remember":
1. Try search_memories first (fast, keyword-based)
2. If nothing found, use search_memories_deep (reads everything, lets you reason about relevance)

## CLI Tools Installed
- **railway** — Railway CLI for logs and deploys (to set a variable or redeploy, use the railway tool above: never a secret in a command)
- **gog** — Google Workspace (Gmail, Calendar, Drive, Contacts, Sheets)
- **himalaya** — Zoho/IMAP email
- **gh** — GitHub CLI
- **claude** — Claude Code CLI
- **whisper-cli** — local speech-to-text
- Use Bash to run any of these directly.

## Skill Discovery
You have skills installed in the skills/ directory. Before saying "I can't do that":
1. Check if a skill exists: list files in ${cwd}/skills/ or read a skill's SKILL.md
2. If a matching skill exists, read its SKILL.md and follow the instructions
3. If no skill exists, ask the user if they want you to create one

## Workspace: ${cwd}`;
}

const TOOLS = ["send_message", "send_file", "schedule_task", "remember", "daily_log", "read_file", "search_memories", "search_memories_deep", "create_canvas", "web_fetch", "get_key", "calculator", "datetime", "browser", "discord_admin", "railway"];

describe("buildPreamble", () => {
  it("Claude Code: unchanged by the move", () => {
    assert.equal(buildPreamble({ engine: "claude-code", cwd: "/data/tarsee/workspace", timezone: "Europe/London" }), claudePreambleBeforeTheMove("/data/tarsee/workspace", "Europe/London"));
    assert.equal(buildPreamble({ engine: "claude-code", cwd: "C:\\ws", timezone: "UTC" }), claudePreambleBeforeTheMove("C:\\ws", "UTC"));
  });

  it("defaults to Claude Code and the configured timezone", () => {
    const text = buildPreamble({ cwd: "/w" });
    assert.match(text, /^You ARE Tarsee/);
    assert.match(text, /Default timezone: \S+/);
    assert.match(text, /## Workspace: \/w$/);
    assert.ok(text.includes("Use Bash to run any of these directly."));
  });

  it("names every Tarsee tool the agent can call, discord_admin and railway included", () => {
    const text = buildPreamble({ engine: "claude-code", cwd: "/w", timezone: "UTC" });
    for (const tool of TOOLS) assert.ok(text.includes(`**${tool}**(`), tool);
    assert.ok(text.includes("**discord_admin**(action, ...)"));
  });

  it("Codex: the same Tarsee tools, Codex's own exec_command and apply_patch, no Claude Code tool names", () => {
    const text = buildPreamble({ engine: "codex", cwd: "/w", timezone: "UTC" });
    assert.match(text, /^You ARE Tarsee/);
    assert.ok(text.includes("mcp__tarsee__tarsee_<name>"));
    // The pinned codex 0.167's command tool is exec_command (no tool is called "shell"), and on its gpt-6.1 models
    // every tool, Tarsee's included, is reached from inside its JavaScript exec tool.
    assert.match(text, /\bexec_command\b/);
    assert.doesNotMatch(text, /shell tool/);
    assert.match(text, /\bapply_patch\b/);
    assert.ok(text.includes("await tools.mcp__tarsee__tarsee_<name>({...})"), "how to call Tarsee's tools from exec");
    assert.match(text, /ALL_TOOLS/);
    assert.ok(!text.includes("Use Bash to run"));
    assert.ok(!text.includes("from Bash"), "Codex has no tool called Bash");
    // gpt-5.5 gets Tarsee's tools behind tool_search (it can't be switched off): offered only where it exists.
    assert.match(text, /tool_search where that tool is offered/);
    assert.ok(!buildPreamble({ engine: "claude-code", cwd: "/w", timezone: "UTC" }).includes("tool_search"));
    assert.ok(!buildPreamble({ engine: "claude-code", cwd: "/w", timezone: "UTC" }).includes("ALL_TOOLS"));
    for (const tool of TOOLS) assert.ok(text.includes(`**${tool}**(`), tool);
    assert.ok(text.includes("Default timezone: UTC"));
    assert.match(text, /## Workspace: \/w$/);
    assert.ok(text.includes("/w/skills/"));
  });

  it("an unknown engine gets the Claude Code text (the engine every provider can fall back on)", () => {
    assert.equal(buildPreamble({ engine: "something", cwd: "/w", timezone: "UTC" }), buildPreamble({ engine: "claude-code", cwd: "/w", timezone: "UTC" }));
  });
});
