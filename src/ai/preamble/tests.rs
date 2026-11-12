//! Port of test/preamble.test.js (design 4.2): the head of every agent turn's system prompt. The Claude Code text must
//! be exactly what the Claude Code engine sent before the move; the Codex text names Codex's own tools.

use super::*;
use crate::testkit::test_app;

/// The text the Claude Code engine built inline before the move, verbatim.
fn claude_preamble_before_the_move(cwd: &str, timezone: &str) -> String {
    format!(
        "You ARE Tarsee — a headless AI agent running 24/7 on a server.

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
- **datetime**(timezone?, date?, format?) — current date/time/day or timezone conversion. ALWAYS use this for dates and days of the week, never guess. Default timezone: {timezone}
- **browser**(action, url?, selector?, text?, ...) — stealth Playwright browser with captcha solving
- **discord_admin**(action, ...) — list, make and edit Discord channels and make webhooks with Tarsee's own bot (never the bot token from Bash); changes need approved_by, a webhook URL goes to the vault, nothing deletes
- **railway**(action, project?, environment?, service?, ...) — list Railway projects and variable names, set a variable (secrets via from_key, a vault key name) or redeploy, with the vault's RAILWAY_API_TOKEN; writes need approved_by. Use it instead of Railway calls from Bash

## Memory
Use remember for durable facts. Use daily_log for session notes. Only append, never overwrite.
Before saying \"I don't know\" or \"I can't remember\":
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
You have skills installed in the skills/ directory. Before saying \"I can't do that\":
1. Check if a skill exists: list files in {cwd}/skills/ or read a skill's SKILL.md
2. If a matching skill exists, read its SKILL.md and follow the instructions
3. If no skill exists, ask the user if they want you to create one

## Workspace: {cwd}"
    )
}

const TOOLS: [&str; 16] = [
    "send_message",
    "send_file",
    "schedule_task",
    "remember",
    "daily_log",
    "read_file",
    "search_memories",
    "search_memories_deep",
    "create_canvas",
    "web_fetch",
    "get_key",
    "calculator",
    "datetime",
    "browser",
    "discord_admin",
    "railway",
];

#[test]
fn claude_code_unchanged_by_the_move() {
    assert_eq!(
        build_preamble(Some("claude-code"), "/data/tarsee/workspace", "Europe/London"),
        claude_preamble_before_the_move("/data/tarsee/workspace", "Europe/London")
    );
    assert_eq!(
        build_preamble(Some("claude-code"), "C:\\ws", "UTC"),
        claude_preamble_before_the_move("C:\\ws", "UTC")
    );
}

#[test]
fn defaults_to_claude_code_and_the_configured_timezone() {
    let t = test_app();
    let text = build_preamble(None, "/w", &t.config().timezone);
    assert!(text.starts_with("You ARE Tarsee"));
    assert!(text.contains(&format!("Default timezone: {}\n", t.config().timezone)));
    assert!(!t.config().timezone.is_empty());
    assert!(text.ends_with("## Workspace: /w"));
    assert!(text.contains("Use Bash to run any of these directly."));
}

#[test]
fn names_every_tarsee_tool_the_agent_can_call_discord_admin_and_railway_included() {
    let text = build_preamble(Some("claude-code"), "/w", "UTC");
    for tool in TOOLS {
        assert!(text.contains(&format!("**{tool}**(")), "{tool}");
    }
    assert!(text.contains("**discord_admin**(action, ...)"));
}

#[test]
fn codex_the_same_tarsee_tools_codexs_own_exec_command_and_apply_patch_no_claude_code_tool_names() {
    let text = build_preamble(Some("codex"), "/w", "UTC");
    assert!(text.starts_with("You ARE Tarsee"));
    assert!(text.contains("mcp__tarsee__tarsee_<name>"));
    // The pinned codex 0.167's command tool is exec_command (no tool is called "shell"), and on its gpt-6.1 models
    // every tool, Tarsee's included, is reached from inside its JavaScript exec tool.
    assert!(text.contains("exec_command"));
    assert!(!text.contains("shell tool"));
    assert!(text.contains("apply_patch"));
    assert!(
        text.contains("await tools.mcp__tarsee__tarsee_<name>({...})"),
        "how to call Tarsee's tools from exec"
    );
    assert!(text.contains("ALL_TOOLS"));
    assert!(!text.contains("Use Bash to run"));
    assert!(!text.contains("from Bash"), "Codex has no tool called Bash");
    // gpt-5.5 gets Tarsee's tools behind tool_search (it can't be switched off): offered only where it exists.
    assert!(text.contains("tool_search where that tool is offered"));
    let claude = build_preamble(Some("claude-code"), "/w", "UTC");
    assert!(!claude.contains("tool_search"));
    assert!(!claude.contains("ALL_TOOLS"));
    for tool in TOOLS {
        assert!(text.contains(&format!("**{tool}**(")), "{tool}");
    }
    assert!(text.contains("Default timezone: UTC"));
    assert!(text.ends_with("## Workspace: /w"));
    assert!(text.contains("/w/skills/"));
}

#[test]
fn an_unknown_engine_gets_the_claude_code_text() {
    assert_eq!(
        build_preamble(Some("something"), "/w", "UTC"),
        build_preamble(Some("claude-code"), "/w", "UTC")
    );
}
