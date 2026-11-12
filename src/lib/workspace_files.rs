//! Port of `src/lib/workspace-files.js`: the workspace file reader and writer, with caching.
//!
//! Reads SOUL.md, USER.md, MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md, BOOT.md, BOOTSTRAP.md and daily
//! logs from the workspace folder. Files ARE the memory: the bot reads its identity from disk every time.
//!
//! The JS kept its 5 second read cache and its "already warned about this cut" set in module variables; here they are
//! one service in the [`App`], so every function takes the app.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::app::App;
use crate::lib::safe_path::{is_inside, node_join};
use crate::util::js::{trim, utf16_len};
use crate::util::node_path::to_namespaced;

use self::jstext::js_collapse_spaces;

const CACHE_TTL: Duration = Duration::from_secs(5);

/// All known workspace files.
pub const WORKSPACE_FILES: &[&str] = &[
    "SOUL.md",
    "USER.md",
    "MEMORY.md",
    "AGENTS.md",
    "IDENTITY.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "BOOT.md",
    "BOOTSTRAP.md",
];

/// The read cache (filename -> content and when it was read) and the cuts already warned about.
#[derive(Default)]
struct WorkspaceCache {
    files: Mutex<HashMap<String, (String, Instant)>>,
    trunc_warned: Mutex<HashSet<String>>,
}

fn cache(app: &App) -> Arc<WorkspaceCache> {
    app.get_or_init(WorkspaceCache::default)
}

/// Whether a path piece that came from outside the program (a request, a tool argument, a setting, a file) is one
/// plain name, safe to join to a folder: not empty, not `.` or `..`, no separator (`/` or `\\`), not absolute and no
/// drive. Rust's `Path::join` replaces the folder with an absolute piece, so a piece is checked before it is joined.
pub fn is_plain_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return false;
    }
    let mut parts = Path::new(name).components();
    matches!((parts.next(), parts.next()), (Some(Component::Normal(n)), None) if n == name)
}

/// `path.join(WORKSPACE_DIR, filename)`: joined as Node joined, so an absolute name stays under the workspace. A
/// name whose `..` leads out of the workspace gives `None` (the Node code followed it out; the callers only pass the
/// workspace's own files). The path comes in the literal form Node handed to the system (`to_namespaced`), so on
/// Windows `SOUL.md.` is not `SOUL.md` and `nul` is a file, not a device.
fn workspace_path(app: &App, filename: &str) -> Option<PathBuf> {
    let workspace = &app.config().workspace_dir;
    let path = PathBuf::from(node_join(&[&workspace.to_string_lossy(), filename]));
    is_inside(workspace, &path).then(|| to_namespaced(&path))
}

fn outside_workspace(filename: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!("{filename} is outside the workspace"),
    )
}

/// Reads a workspace file ("SOUL.md", "memory/2026-11-12.md"), through a 5 second cache. Empty when it cannot be read.
pub fn read_workspace_file(app: &App, filename: &str) -> String {
    let cache = cache(app);
    if let Some((content, at)) = cache.files.lock().get(filename)
        && at.elapsed() < CACHE_TTL
    {
        return content.clone();
    }
    let Some(path) = workspace_path(app, filename) else {
        return String::new();
    };
    match fs::read(&path) {
        Ok(bytes) => {
            let content = String::from_utf8_lossy(&bytes).into_owned();
            cache
                .files
                .lock()
                .insert(filename.to_string(), (content.clone(), Instant::now()));
            content
        }
        Err(_) => String::new(),
    }
}

/// Writes a workspace file (overwrites), creating its folder. Invalidates its cache entry.
pub fn write_workspace_file(app: &App, filename: &str, content: &str) -> std::io::Result<()> {
    let path = workspace_path(app, filename).ok_or_else(|| outside_workspace(filename))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&path, content)?;
    cache(app).files.lock().remove(filename);
    Ok(())
}

/// Appends to a workspace file, creating it and its folder. Invalidates its cache entry.
pub fn append_workspace_file(app: &App, filename: &str, content: &str) -> std::io::Result<()> {
    let path = workspace_path(app, filename).ok_or_else(|| outside_workspace(filename))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    append_to(&path, content)?;
    cache(app).files.lock().remove(filename);
    Ok(())
}

fn append_to(path: &Path, content: &str) -> std::io::Result<()> {
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(content.as_bytes())
}

/// Appends a note to today's daily log, `memory/YYYY-MM-DD.md`. The day is the UTC date and the time is the local
/// time of the process (the TZ variable, else the system's zone), as the JS had it.
pub fn append_daily_log(app: &App, content: &str) -> std::io::Result<()> {
    append_daily_log_at(app, content, Utc::now())
}

fn append_daily_log_at(app: &App, content: &str, now: DateTime<Utc>) -> std::io::Result<()> {
    let today = now.format("%Y-%m-%d").to_string();
    let path = app.config().workspace_dir.join("memory").join(format!("{today}.md"));
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    // toLocaleTimeString("en-US", { hour12: false }): "14:05:09", "00:05:09".
    let timestamp = now.with_timezone(&jstext::process_zone(app.env())).format("%H:%M:%S");
    let entry = format!("\n- [{timestamp}] {content}");
    // Create with header if new file
    if !path.exists() {
        fs::write(&path, format!("# Daily Log — {today}\n{entry}\n"))
    } else {
        append_to(&path, &format!("{entry}\n"))
    }
}

/// Most of one workspace file the system prompt carries. It was 8KB, which cut the middle out of an AGENTS.md that
/// had grown to 16KB (the agent saw the first 5.7KB and the last 1.6KB, so the rules in between never reached it). A
/// file over the cap is still cut, and the cut is logged so it is noticed: move task-specific sections into skills.
pub const WORKSPACE_FILE_MAX_BYTES: usize = 12 * 1024;

/// Truncates content to a max size, keeping 70% from the head and 20% from the tail (`truncateContent(content,
/// maxBytes)`, with no name, so nothing is logged).
pub fn truncate_content(content: &str, max_bytes: usize) -> String {
    if content.is_empty() || content.len() <= max_bytes {
        return content.to_string();
    }
    cut_middle(content, max_bytes)
}

/// [`truncate_content`] for a named file (`truncateContent(content, maxBytes, name)`): a cut is logged once per
/// file and length.
pub fn truncate_content_named(app: &App, content: &str, max_bytes: usize, name: &str) -> String {
    if content.is_empty() || content.len() <= max_bytes {
        return content.to_string();
    }
    let key = format!("{name}:{}", utf16_len(content));
    if !name.is_empty() && cache(app).trunc_warned.lock().insert(key) {
        log::warn!(
            "[workspace] {name} is {}KB, over the {}KB a prompt file may be: its middle is cut out of the system prompt",
            js_round(content.len() as f64 / 1024.0),
            js_round(max_bytes as f64 / 1024.0)
        );
    }
    cut_middle(content, max_bytes)
}

fn cut_middle(content: &str, max_bytes: usize) -> String {
    // Head and tail measured in bytes like the cap (a file in Chinese or full of emoji has 3 or 4 bytes a character),
    // and never cutting a character in two.
    let head = bytes_from(content, (max_bytes as f64 * 0.7).floor() as usize, false);
    let tail = bytes_from(content, (max_bytes as f64 * 0.2).floor() as usize, true);
    format!("{head}\n\n... [truncated — file too large] ...\n\n{tail}")
}

/// The longest start (or end) of `s` that fits in `max` UTF-8 bytes, whole characters only.
fn bytes_from(s: &str, max: usize, from_end: bool) -> &str {
    let mut n = 0usize;
    if from_end {
        let mut start = s.len();
        for (i, c) in s.char_indices().rev() {
            if n + c.len_utf8() > max {
                break;
            }
            n += c.len_utf8();
            start = i;
        }
        &s[start..]
    } else {
        let mut end = 0;
        for c in s.chars() {
            if n + c.len_utf8() > max {
                break;
            }
            n += c.len_utf8();
            end = n;
        }
        &s[..end]
    }
}

/// `Math.round` for the non-negative numbers it is used on here.
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// What a chat's system prompt says in place of HEARTBEAT.md text that waits for the owner's OK
/// (`lib/automation_approval.rs`), or that it couldn't be checked against it.
const HEARTBEAT_WAITING_NOTE: &str = concat!(
    "<!-- Heartbeat Tasks (HEARTBEAT.md): waiting for the owner's OK, so not shown -->\n",
    "HEARTBEAT.md was changed outside Settings and the owner hasn't OK'd it, so no heartbeat check runs. ",
    "It runs only once the owner clicks Let it run in Settings > Automation (or saves it there). ",
    "Don't tell the owner it is set up or running until then; read the file if you need what it says."
);
const HEARTBEAT_UNCHECKED_NOTE: &str = concat!(
    "<!-- Heartbeat Tasks (HEARTBEAT.md): not checked against the owner's OK, so not shown -->\n",
    "HEARTBEAT.md runs only text the owner has OK'd in Settings > Automation (Let it run). ",
    "Don't tell the owner it is set up or running unless they have; read the file if you need what it says."
);

/// The full bootstrap context for system prompt injection. Order: AGENTS, SOUL, IDENTITY, USER, TOOLS, MEMORY,
/// HEARTBEAT.
///
/// HEARTBEAT.md is shown as the heartbeat's tasks only when the owner has OK'd its text (`heartbeat_waiting`
/// `Some(false)`, from `automation_status`). Text that waits for their OK is left out, with a line saying no check
/// runs: it doesn't run, and shown here the AI read it as live and told the owner the check was set up. It is also
/// text nobody has reviewed (the AI may have written it from a web page or an email it read), which would otherwise
/// reach every chat with the weight of the system prompt, and the AI can still read the file when asked about it. A
/// change made through the shell can't be caught when it is made; this line is how the AI learns of it.
///
/// `heartbeat_waiting`: `Some(true)` when HEARTBEAT.md holds text the owner hasn't OK'd; `None` when not known.
pub fn get_bootstrap_context(app: &App, heartbeat_waiting: Option<bool>) -> String {
    const FILES: &[(&str, &str)] = &[
        ("AGENTS.md", "Agent Rules"),
        ("SOUL.md", "Soul & Personality"),
        ("IDENTITY.md", "Identity"),
        ("USER.md", "About the User"),
        ("TOOLS.md", "Tools & Capabilities"),
        ("MEMORY.md", "Long-Term Memory"),
        ("HEARTBEAT.md", "Heartbeat Tasks"),
    ];

    let mut sections: Vec<String> = Vec::new();
    for &(name, label) in FILES {
        // MEMORY.md grows without bound (50KB and more on a long-lived install), so it is never inlined (nor read
        // here, its size is enough): a pointer tells the agent to grep it for the topic at hand. Reading it whole, or
        // carrying a cut-down copy in every prompt, costs the context for the few lines a task needs. The path is
        // absolute: the agent's working folder (CLAUDE_WORKSPACE_DIR) can be another one.
        if name == "MEMORY.md" {
            let mem_path = app.config().workspace_dir.join(name);
            // No MEMORY.md yet counts as empty.
            let size = fs::metadata(&mem_path).map(|m| m.len()).unwrap_or(0);
            if size < 5 {
                continue;
            }
            let mem_path = mem_path.display();
            sections.push(format!(
                "<!-- {label} ({name}): pointer only, not inlined -->\n\
                 Your long-term memory is in `{mem_path}` (~{} KB). \
                 Grep it for the topic you need (`grep -n -i \"term\" \"{mem_path}\"`) or use search_memories; never read it whole.",
                js_round(size as f64 / 1024.0).max(1)
            ));
            continue;
        }

        let raw = read_workspace_file(app, name);
        if raw.is_empty() || utf16_len(trim(&raw)) < 5 {
            continue;
        }

        if name == "HEARTBEAT.md" && heartbeat_waiting != Some(false) {
            // Only text with something to do needs the owner's OK: the default file (a heading and comments) is
            // shown as before.
            if !get_heartbeat_context(app).is_empty() {
                sections.push(
                    if heartbeat_waiting == Some(true) {
                        HEARTBEAT_WAITING_NOTE
                    } else {
                        HEARTBEAT_UNCHECKED_NOTE
                    }
                    .to_string(),
                );
                continue;
            }
        }

        let content = truncate_content_named(app, &raw, WORKSPACE_FILE_MAX_BYTES, name);
        sections.push(format!("<!-- {label} ({name}) -->\n{content}"));
    }

    sections.join("\n\n")
}

// The default SOUL.md and CLAUDE.md an install was seeded with used to say "read MEMORY.md at the start of every
// session", which now contradicts the system prompt's "grep it, never read it whole" (and CLAUDE.md said cron runs in
// UTC). Later the defaults stopped naming one AI: they said "powered by Claude", named Claude Code's own tools (Bash,
// Read/Write/Edit/Grep/Glob, mcp__tarsee__*) and the agent team's Claude models, none of which hold on another AI.
// Existing workspaces keep their seeded files, so on boot each line that is still exactly an old default line, the
// whole line, is replaced with the new one. A line the owner changed or added words to no longer matches and is left
// alone. The tests keep each old default as a fixture (tests/fixtures/workspace).

// The tool lines of the default CLAUDE.md. A new line replaces the old one whole, so the swap runs once.
// Three generations: the first defaults (Slack, no files), the WhatsApp ones (Slack gone), and today's (Slack back).
const SEND_MESSAGE_LINE_OLD: &str = "- **tarsee_send_message** — Push messages to Telegram, Discord, Slack, or web";
const SEND_MESSAGE_LINE_WHATSAPP: &str =
    "- **tarsee_send_message** — Push messages to Telegram, Discord, WhatsApp, or web";
const SEND_FILE_LINE_WHATSAPP: &str = "- **tarsee_send_file** — Send a file as a real attachment to the Telegram, Discord or WhatsApp chat you are in (never answer with a folder path)";
const SEND_MESSAGE_LINE: &str =
    "- **tarsee_send_message** — Push messages to Telegram, Discord, WhatsApp, Slack, or web";
const SEND_FILE_LINE: &str = "- **tarsee_send_file** — Send a file as a real attachment to the Telegram, Discord, WhatsApp or Slack chat you are in (never answer with a folder path)";
// SOUL.md's tool line, through four generations: Slack, WhatsApp, files, then Slack back (all naming mcp__tarsee__*,
// which only Claude Code calls them), and today's, which names them as every AI sees them.
const SOUL_TOOLS_LINE: &str = "- **Platform tools** (the tarsee_* tools): Send messages and files (real attachments) to Telegram/Discord/WhatsApp/Slack, schedule tasks, manage memory, search the web, use the encrypted vault.";

/// A file's old default lines, each with what replaces it.
type LineSwaps = Vec<(String, String)>;

/// Each file's old default lines and what replaces them, in the JS order.
static DEFAULT_UPGRADES: LazyLock<Vec<(&'static str, LineSwaps)>> = LazyLock::new(|| {
    let pairs = |list: &[(&str, &str)]| -> LineSwaps {
        list.iter()
            .map(|(from, to)| (from.to_string(), to.to_string()))
            .collect()
    };
    // The lines of TOOLS.md (both the image's and the first-boot defaults) that told the agent to stay out of Bash.
    let tools_shell_lines = pairs(&[
        (
            "- Make, edit or list Discord channels and webhooks with tarsee_discord_admin. Never call Discord's API from Bash and never pull DISCORD_BOT_TOKEN from the vault for it: Tarsee's own bot does the work.",
            "- Make, edit or list Discord channels and webhooks with tarsee_discord_admin. Never call Discord's API from the shell and never pull DISCORD_BOT_TOKEN from the vault for it: Tarsee's own bot does the work.",
        ),
        (
            "- List projects, services and variable names, set a variable or redeploy with tarsee_railway. Never call Railway's API from Bash and never put a Railway token or a secret value in a command: Tarsee reads the token from the vault itself (RAILWAY_API_TOKEN, an account or workspace token).",
            "- List projects, services and variable names, set a variable or redeploy with tarsee_railway. Never call Railway's API from the shell and never put a Railway token or a secret value in a command: Tarsee reads the token from the vault itself (RAILWAY_API_TOKEN, an account or workspace token).",
        ),
    ]);
    let send_both = format!("{SEND_MESSAGE_LINE}\n{SEND_FILE_LINE}");
    vec![
        (
            "SOUL.md",
            pairs(&[
                (
                    "You are **Tarsee** — a 24/7 autonomous AI agent powered by Claude.",
                    "You are **Tarsee** — a 24/7 autonomous AI agent.",
                ),
                (
                    "- **Full tool access**: Read, Write, Edit, Bash, Grep, Glob — you can work with any file or run any command.",
                    "- **Full tool access**: you can read, write, edit and search any file, and run any command in the shell.",
                ),
                (
                    "- **Platform tools** (mcp__tarsee__*): Send messages to Telegram/Discord/Slack, schedule tasks, manage memory, search the web, use the encrypted vault.",
                    SOUL_TOOLS_LINE,
                ),
                (
                    "- **Platform tools** (mcp__tarsee__*): Send messages and files (real attachments) to Telegram/Discord/WhatsApp, schedule tasks, manage memory, search the web, use the encrypted vault.",
                    SOUL_TOOLS_LINE,
                ),
                (
                    "- **Platform tools** (mcp__tarsee__*): Send messages and files (real attachments) to Telegram/Discord/WhatsApp/Slack, schedule tasks, manage memory, search the web, use the encrypted vault.",
                    SOUL_TOOLS_LINE,
                ),
                (
                    "- **Persistent memory**: MEMORY.md stores everything you learn. Read it every session.",
                    "- **Persistent memory**: MEMORY.md stores everything you learn. Grep it for what a task needs.",
                ),
                (
                    "- **Image analysis**: Users can send images and you can read them.",
                    "- **Images and files**: Users can send pictures, PDFs and other files. Each one is saved in the workspace for you to open, and you see a picture yourself when your model can.",
                ),
                (
                    "- Always read MEMORY.md at the start of a session to know what you've learned.",
                    "- MEMORY.md grows long: grep it for the topic at hand (`grep -n -i \"term\" MEMORY.md`) or use search_memories. Never read it whole.",
                ),
                (
                    "- Use mcp__tarsee__* tools for platform actions. Never use Bash for scheduling or messaging.",
                    "- Use the tarsee_* tools for platform actions. Never use the shell for scheduling or messaging.",
                ),
                // Every default before scheduled tasks waited for the owner's OK said to schedule a follow-up
                // outright: each run of a task can be a paid turn, so the agent offers and the owner decides.
                (
                    "- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, schedule it.",
                    "- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, offer to schedule it, and schedule it only once the owner says yes.",
                ),
            ]),
        ),
        (
            "AGENTS.md",
            pairs(&[
                (
                    "- **Coder** (Opus) — Code, debugging, architecture, scripts.",
                    "- **Coder** (your AI's most capable model) — Code, debugging, architecture, scripts.",
                ),
                (
                    "- **Researcher** (Sonnet) — Web research, documentation, analysis.",
                    "- **Researcher** (its everyday model) — Web research, documentation, analysis.",
                ),
                (
                    "- **Writer** (Sonnet) — Content, emails, documents, copywriting.",
                    "- **Writer** (its everyday model) — Content, emails, documents, copywriting.",
                ),
                (
                    "- **Quick** (Haiku) — Fast lookups, formatting, simple tasks.",
                    "- **Quick** (its fastest model) — Fast lookups, formatting, simple tasks.",
                ),
            ]),
        ),
        (
            "MEMORY.md",
            pairs(&[(
                "This file stores everything Tarsee learns across sessions. Read this at the start of every conversation.",
                "This file stores everything Tarsee learns across sessions. It grows long: grep it for what a task needs, and never read it whole.",
            )]),
        ),
        ("TOOLS.md", tools_shell_lines),
        (
            "CLAUDE.md",
            pairs(&[
                (
                    &[
                        "## On Every Session Start",
                        "",
                        "Before responding, read your context files:",
                        "1. `SOUL.md` — your identity, personality, capabilities",
                        "2. `MEMORY.md` — accumulated knowledge, learned skills, API access",
                        "3. `USER.md` — what you know about your user",
                    ]
                    .join("\n"),
                    &[
                        "## Your Context Files",
                        "",
                        "`SOUL.md` (your identity) and `USER.md` (what you know about your user) are already",
                        "in your system prompt: don't read them again. `MEMORY.md` (accumulated knowledge,",
                        "learned skills, API access) is not, because it grows long: grep it for the topic a",
                        "task needs (`grep -n -i \"term\" MEMORY.md`) or use tarsee_search_memories, and never",
                        "read it whole.",
                    ]
                    .join("\n"),
                ),
                (
                    "- **tarsee_schedule_task** — Schedule cron jobs (server is UTC)",
                    "- **tarsee_schedule_task** — Schedule cron jobs (times are in the configured timezone, `TARSEE_TIMEZONE`)",
                ),
                (SEND_MESSAGE_LINE_OLD, &send_both),
                (SEND_MESSAGE_LINE_WHATSAPP, SEND_MESSAGE_LINE),
                (SEND_FILE_LINE_WHATSAPP, SEND_FILE_LINE),
                (
                    "- **Bash** — Write and run scripts for complex tasks",
                    "- **The shell** — Write and run scripts for complex tasks",
                ),
                (
                    "- You can install npm/pip packages via Bash if needed for tasks",
                    "- You can install npm/pip packages from the shell when a task needs them",
                ),
            ]),
        ),
    ]
});

/// `text` with each run of whole lines that reads `from` (one line, or several joined by \n) replaced by `to`. A line
/// matches only whole, its own ending (CRLF or LF) aside: a line the owner added words to, before or after the old
/// default, is theirs and stays. The new lines keep the file's endings: a CRLF file stays CRLF.
fn swap_whole_lines(text: &str, from: &str, to: &str) -> String {
    let want: Vec<&str> = from.split('\n').collect();
    // A CRLF file's lines keep their \r here.
    let lines: Vec<&str> = text.split('\n').collect();
    let bare = |line: &str| -> String { line.strip_suffix('\r').unwrap_or(line).to_string() };
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let matches = i + want.len() <= lines.len() && want.iter().enumerate().all(|(k, w)| bare(lines[i + k]) == *w);
        if matches {
            let cr = if lines[i].ends_with('\r') { "\r" } else { "" };
            let last_cr = if lines[i + want.len() - 1].ends_with('\r') {
                "\r"
            } else {
                ""
            };
            let news: Vec<&str> = to.split('\n').collect();
            for (k, line) in news.iter().enumerate() {
                let ending = if k == news.len() - 1 { last_cr } else { cr };
                out.push(format!("{line}{ending}"));
            }
            i += want.len();
        } else {
            out.push(lines[i].to_string());
            i += 1;
        }
    }
    out.join("\n")
}

/// Swaps the old default lines of the workspace files for today's (see above), in `dir` or else the workspace.
/// Returns the files it updated.
pub fn upgrade_default_workspace_files(app: &App, dir: Option<&Path>) -> Vec<String> {
    let dir = dir.unwrap_or(&app.config().workspace_dir);
    let mut updated: Vec<String> = Vec::new();
    for (name, swaps) in DEFAULT_UPGRADES.iter() {
        let file = dir.join(name);
        let Ok(bytes) = fs::read(&file) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let mut next = text.clone();
        // (The first line only: in a CRLF file a block of lines never holds `from`, joined by \n, as it is.)
        for (from, to) in swaps {
            if next.contains(from.split('\n').next().unwrap_or_default()) {
                next = swap_whole_lines(&next, from, to);
            }
        }
        if next == text {
            continue;
        }
        match fs::write(&file, &next) {
            Ok(()) => {
                cache(app).files.lock().remove(*name);
                updated.push(name.to_string());
            }
            Err(err) => log::warn!("[workspace] could not update {name}: {err}"),
        }
    }
    if !updated.is_empty() {
        log::info!(
            "[workspace] updated the default instructions in {} (grep MEMORY.md, never read it whole; send files as attachments; Slack; wording that fits any AI; offer a follow-up, schedule it only once the owner says yes)",
            updated.join(", ")
        );
    }
    updated
}

static HTML_COMMENT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?s)<!--.*?-->").expect("the comment pattern"));

/// `text.replace(/^#.*$/gm, "")`: every line that starts with `#` emptied. A line starts at the beginning of the text
/// or after any JavaScript line terminator (\n, \r, U+2028, U+2029), and runs to the next one.
fn strip_heading_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at_line_start = true;
    let mut skipping = false;
    for c in text.chars() {
        let terminator = matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        if terminator {
            skipping = false;
            at_line_start = true;
            out.push(c);
            continue;
        }
        if at_line_start && c == '#' {
            skipping = true;
        }
        at_line_start = false;
        if !skipping {
            out.push(c);
        }
    }
    out
}

/// The file's text when it holds something to do, else "" (HEARTBEAT.md and BOOT.md).
fn runnable_context(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    // Strip markdown headings and HTML comments BEFORE the emptiness check. The default-shipped file is a heading
    // plus instructional <!-- comments -->, which passes a naive trim>5 test while containing no actual
    // instructions. The template's own text says "Leave empty to skip ... (saves tokens)" — but the naive check
    // never skipped, so every deployment burned a full Claude turn on boot and again every ~30 minutes, forever, to
    // conclude there was nothing to do. Worse, it makes the model invent work to justify the turn.
    let without_comments = HTML_COMMENT.replace_all(content, "");
    let significant = strip_heading_lines(&without_comments);
    if utf16_len(trim(&significant)) < 5 {
        return String::new();
    }
    truncate_content(content, WORKSPACE_FILE_MAX_BYTES)
}

/// HEARTBEAT.md's content for periodic task runs, or "" when it holds nothing to do.
pub fn get_heartbeat_context(app: &App) -> String {
    runnable_context(&read_workspace_file(app, "HEARTBEAT.md"))
}

/// BOOT.md's content for startup runs, or "" when it holds nothing to do.
pub fn get_boot_context(app: &App) -> String {
    runnable_context(&read_workspace_file(app, "BOOT.md"))
}

/// Whether BOOTSTRAP.md exists and has content (first-run detection).
pub fn has_bootstrap_file(app: &App) -> bool {
    let content = read_workspace_file(app, "BOOTSTRAP.md");
    !content.is_empty() && utf16_len(trim(&content)) > 5
}

/// Deletes BOOTSTRAP.md after first-run setup is complete. Already gone is fine.
pub fn delete_bootstrap_file(app: &App) {
    let path = app.config().workspace_dir.join("BOOTSTRAP.md");
    if fs::remove_file(path).is_ok() {
        cache(app).files.lock().remove("BOOTSTRAP.md");
    }
}

/// `^-\s+\*\*(.+?):\*\*\s*(.+)$` with the `m` flag, as JavaScript reads it: a line starts at the beginning or after a
/// line terminator (consumed here, which finds the same matches), `.` is anything but a line terminator, and `\s`
/// is JavaScript's whitespace (which includes the line terminators).
static IDENTITY_LINE: LazyLock<regex::Regex> = LazyLock::new(|| {
    let not_eol = r"[^\n\r\u{2028}\u{2029}]";
    let space = jstext::JS_SPACE_CLASS;
    regex::Regex::new(&format!(
        r"(?:\A|[\n\r\u{{2028}}\u{{2029}}])-[{space}]+\*\*({not_eol}+?):\*\*[{space}]*({not_eol}+)"
    ))
    .expect("the identity pattern")
});

/// Parses IDENTITY.md's `- **Label:** value` lines into `{ label: value }`, keys lower case with spaces as `_`.
/// Reads the file when `content` is `None`.
pub fn parse_identity_file(app: &App, content: Option<&str>) -> Map<String, Value> {
    let raw = match content {
        Some(text) => text.to_string(),
        None => read_workspace_file(app, "IDENTITY.md"),
    };
    let mut result = Map::new();
    if raw.is_empty() {
        return result;
    }
    for caps in IDENTITY_LINE.captures_iter(&raw) {
        let key = js_collapse_spaces(&trim(&caps[1]).to_lowercase(), "_");
        // `result[key] = value` on a plain object: "__proto__" sets the prototype and is never an own key.
        if key != "__proto__" {
            result.insert(key, Value::String(trim(&caps[2]).to_string()));
        }
    }
    // A JavaScript object lists keys that look like array indexes first, in number order.
    jstext::js_key_order(&result)
        .into_iter()
        .map(|k| (k.clone(), result[k].clone()))
        .collect()
}

/// Forgets every cached file.
pub fn invalidate_cache(app: &App) {
    cache(app).files.lock().clear();
}

/// Small pieces of JavaScript string behaviour the modules of this package need: JavaScript's whitespace (which is
/// not Rust's: it has U+FEFF and not U+0085), `String(value)`, `parseInt`, directory listings in the order Node gave
/// them, and the process's local timezone.
pub mod jstext {
    use std::path::Path;
    use std::sync::LazyLock;

    use serde_json::{Map, Value};

    use crate::env::Env;
    use crate::util::js::{number_to_string, trim};

    /// The characters of JavaScript's `\s` (and of `trim`), as the inside of a regex character class.
    pub const JS_SPACE_CLASS: &str =
        r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

    static SPACES: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(&format!("[{JS_SPACE_CLASS}]+")).expect("the space pattern"));

    /// `s.replace(/\s+/g, with)`.
    pub fn js_collapse_spaces(s: &str, with: &str) -> String {
        SPACES.replace_all(s, regex::NoExpand(with)).into_owned()
    }

    /// `s.split(/\s+/)`.
    pub fn js_split_spaces(s: &str) -> Vec<&str> {
        SPACES.split(s).collect()
    }

    /// `String(value)`; `None` is `undefined`.
    pub fn js_string(value: Option<&Value>) -> String {
        match value {
            None => "undefined".into(),
            Some(Value::Null) => "null".into(),
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(0.0)),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item {
                    Value::Null => String::new(),
                    other => js_string(Some(other)),
                })
                .collect::<Vec<_>>()
                .join(","),
            Some(Value::Object(_)) => "[object Object]".into(),
        }
    }

    /// Whether a property name is an array index, which JavaScript objects keep first, in number order.
    pub fn is_array_index(key: &str) -> bool {
        !key.is_empty()
            && key.chars().all(|c| c.is_ascii_digit())
            && (key == "0" || !key.starts_with('0'))
            && key.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
    }

    /// An object's keys in JavaScript's property order: array indexes ascending, then the rest as inserted.
    pub fn js_key_order(object: &Map<String, Value>) -> Vec<&String> {
        let mut indexes: Vec<&String> = object.keys().filter(|k| is_array_index(k)).collect();
        indexes.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
        indexes.extend(object.keys().filter(|k| !is_array_index(k)));
        indexes
    }

    /// `JSON.stringify(value)`: numbers as JavaScript prints them, object keys in JavaScript's order.
    pub fn js_json_stringify(value: &Value) -> String {
        match value {
            Value::Number(n) => {
                let f = n.as_f64().unwrap_or(0.0);
                if f.is_finite() {
                    number_to_string(f)
                } else {
                    "null".into()
                }
            }
            Value::Array(items) => format!(
                "[{}]",
                items.iter().map(js_json_stringify).collect::<Vec<_>>().join(",")
            ),
            Value::Object(object) => format!(
                "{{{}}}",
                js_key_order(object)
                    .into_iter()
                    .map(|k| format!("{}:{}", Value::String(k.clone()), js_json_stringify(&object[k])))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            other => other.to_string(),
        }
    }

    /// `parseInt(text)` (no radix): leading whitespace, a sign, then decimal digits, or hex after `0x`. `None` is
    /// `NaN`.
    pub fn js_parse_int(text: &str) -> Option<i64> {
        let s = trim(text);
        let (negative, s) = match s.as_bytes().first() {
            Some(b'-') => (true, &s[1..]),
            Some(b'+') => (false, &s[1..]),
            _ => (false, s),
        };
        let (radix, digits) = if s.len() >= 2 && (s.starts_with("0x") || s.starts_with("0X")) {
            (16, &s[2..])
        } else {
            (10, s)
        };
        let end = digits
            .char_indices()
            .find(|(_, c)| !c.is_digit(radix))
            .map(|(i, _)| i)
            .unwrap_or(digits.len());
        if end == 0 {
            return None;
        }
        let value = i64::from_str_radix(&digits[..end], radix).unwrap_or(i64::MAX);
        Some(if negative { -value } else { value })
    }

    /// `Number(text)` (and what `<`, `>` and arithmetic do to text): blank is 0, otherwise the whole trimmed text
    /// must be a number (decimal, `0x`, `0o`, `0b`, or `Infinity`); anything else is NaN.
    pub fn js_to_number(s: &str) -> f64 {
        let t = trim(s);
        if t.is_empty() {
            return 0.0;
        }
        let radix = |prefix: &str, radix: u32| {
            t.strip_prefix(prefix)
                .or_else(|| t.strip_prefix(&prefix.to_uppercase()))
                .map(|digits| {
                    if digits.is_empty() {
                        f64::NAN
                    } else {
                        u64::from_str_radix(digits, radix).map_or(f64::NAN, |v| v as f64)
                    }
                })
        };
        if let Some(v) = radix("0x", 16).or_else(|| radix("0o", 8)).or_else(|| radix("0b", 2)) {
            return v;
        }
        match t {
            "Infinity" | "+Infinity" => return f64::INFINITY,
            "-Infinity" => return f64::NEG_INFINITY,
            _ => {}
        }
        let valid = t
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
            && t.chars().any(|c| c.is_ascii_digit());
        if !valid {
            return f64::NAN;
        }
        t.parse::<f64>().unwrap_or(f64::NAN)
    }

    /// What Node's `path.join` and the `fs` functions threw for a path argument that is not text
    /// (`ERR_INVALID_ARG_TYPE`); `None` is `undefined`.
    pub fn path_type_error(value: Option<&Value>) -> String {
        let received = match value {
            None => "undefined".to_string(),
            Some(Value::Null) => "null".to_string(),
            Some(Value::Bool(b)) => format!("type boolean ({b})"),
            Some(Value::Number(n)) => format!("type number ({})", number_to_string(n.as_f64().unwrap_or(0.0))),
            Some(Value::String(s)) => format!("type string ('{s}')"),
            Some(Value::Array(_)) => "an instance of Array".to_string(),
            Some(Value::Object(_)) => "an instance of Object".to_string(),
        };
        format!("The \"path\" argument must be of type string. Received {received}")
    }

    /// `parseInt(text, 10)`: leading whitespace, a sign, then decimal digits; `None` is `NaN`.
    pub fn js_parse_int_decimal(text: &str) -> Option<i64> {
        let s = crate::util::js::trim_start(text);
        let (negative, s) = match s.as_bytes().first() {
            Some(b'-') => (true, &s[1..]),
            Some(b'+') => (false, &s[1..]),
            _ => (false, s),
        };
        let end = s.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(s.len());
        if end == 0 {
            return None;
        }
        let value = s[..end].parse::<i64>().unwrap_or(i64::MAX);
        Some(if negative { -value } else { value })
    }

    /// The entries of a folder in the order Node's `fs.readdirSync` gave them on Linux (libuv sorts them by name, byte
    /// by byte).
    pub fn read_dir_sorted(dir: &Path) -> std::io::Result<Vec<std::fs::DirEntry>> {
        let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
        entries.sort_by(|a, b| a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes()));
        Ok(entries)
    }

    /// The timezone Node formatted local times in: the `TZ` variable, else the system's zone, else UTC.
    pub fn process_zone(env: &Env) -> chrono_tz::Tz {
        env.trimmed("TZ")
            .and_then(|zone| zone.trim_start_matches(':').parse().ok())
            .or_else(|| iana_time_zone::get_timezone().ok().and_then(|zone| zone.parse().ok()))
            .unwrap_or(chrono_tz::UTC)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn whitespace_is_javascripts() {
            assert_eq!(trim("\u{FEFF} hi \u{A0}\n"), "hi");
            assert_eq!(trim("\u{85}hi"), "\u{85}hi");
            assert_eq!(js_collapse_spaces("a \t\n b\u{3000}c", " "), "a b c");
            assert_eq!(js_split_spaces("a  b"), ["a", "b"]);
            assert_eq!(js_split_spaces(""), [""]);
        }

        #[test]
        fn string_of_a_value() {
            assert_eq!(js_string(None), "undefined");
            assert_eq!(js_string(Some(&json!(null))), "null");
            assert_eq!(js_string(Some(&json!(12.0))), "12");
            assert_eq!(js_string(Some(&json!([1, null, "a"]))), "1,,a");
            assert_eq!(js_string(Some(&json!({"a": 1}))), "[object Object]");
        }

        #[test]
        fn parse_int_reads_like_javascript() {
            assert_eq!(js_parse_int("42"), Some(42));
            assert_eq!(js_parse_int("  12abc"), Some(12));
            assert_eq!(js_parse_int("-5"), Some(-5));
            assert_eq!(js_parse_int("0x10"), Some(16));
            assert_eq!(js_parse_int("abc"), None);
            assert_eq!(js_parse_int(""), None);
            assert_eq!(js_parse_int("1,2"), Some(1));
        }

        #[test]
        fn the_process_zone_follows_tz() {
            let env = Env::from_pairs([("TZ", "Asia/Manila")]);
            assert_eq!(process_zone(&env), chrono_tz::Asia::Manila);
            env.set("TZ", ":UTC");
            assert_eq!(process_zone(&env), chrono_tz::UTC);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{TestApp, test_app, test_app_with_env, tmp_dir};
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("workspace")
    }

    fn lf(s: &str) -> String {
        s.replace("\r\n", "\n")
    }

    fn read_lf(path: &Path) -> String {
        lf(&fs::read_to_string(path).unwrap())
    }

    fn defaults(t: &TestApp) -> PathBuf {
        t.config().workspace_defaults_dir()
    }

    /// A workspace holding these fixtures (LF) under their real names.
    fn workspace_from(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tmp_dir();
        for (real, fixture) in files {
            fs::write(dir.path().join(real), read_lf(&fixtures().join(fixture))).unwrap();
        }
        dir
    }

    fn rules(bytes: usize) -> String {
        let mut lines: Vec<String> = Vec::new();
        let mut i = 0;
        while lines.join("\n").len() < bytes {
            lines.push(format!("- rule {i}: say it plainly and keep it."));
            i += 1;
        }
        format!("# Agent Rules\n{}\n- LAST RULE\n", lines.join("\n"))
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    // --- test/prompt-audit.test.js: workspace files in the system prompt ---

    #[test]
    fn an_11kb_agents_md_reaches_the_agent_whole() {
        let t = test_app();
        fs::write(t.config().workspace_dir.join("AGENTS.md"), rules(11 * 1024)).unwrap();
        invalidate_cache(&t);
        let ctx = get_bootstrap_context(&t, None);
        assert_eq!(WORKSPACE_FILE_MAX_BYTES, 12 * 1024);
        assert!(ctx.contains("- rule 150:") && ctx.contains("- LAST RULE"));
        assert!(!ctx.contains("[truncated"));
    }

    #[test]
    fn a_longer_one_loses_its_middle_and_the_cut_is_logged_once() {
        let t = test_app();
        fs::write(t.config().workspace_dir.join("AGENTS.md"), rules(20 * 1024)).unwrap();
        invalidate_cache(&t);
        let logs = crate::testkit::CapturedLogs::start();
        let ctx = get_bootstrap_context(&t, None);
        get_bootstrap_context(&t, None);
        assert!(ctx.contains("[truncated") && ctx.contains("- LAST RULE"));
        let warned: Vec<String> = logs
            .lines()
            .into_iter()
            .filter(|w| w.contains("AGENTS.md is 20KB"))
            .collect();
        assert_eq!(warned.len(), 1, "{:?}", logs.lines());
        assert_eq!(
            warned[0],
            "[workspace] AGENTS.md is 20KB, over the 12KB a prompt file may be: its middle is cut out of the system prompt"
        );
    }

    #[test]
    fn memory_md_is_a_pointer_that_says_grep_it_by_its_full_path_never_inlined() {
        let t = test_app();
        let ws = t.config().workspace_dir.clone();
        fs::write(
            ws.join("MEMORY.md"),
            "# Long-Term Memory\n- a fact only grep should find\n",
        )
        .unwrap();
        invalidate_cache(&t);
        let ctx = get_bootstrap_context(&t, None);
        assert!(ctx.contains("Grep it for the topic you need"));
        assert!(ctx.contains("never read it whole"));
        assert!(
            ctx.contains(&format!("grep -n -i \"term\" \"{}\"", ws.join("MEMORY.md").display())),
            "absolute: the agent's working folder can be another one"
        );
        assert!(!ctx.contains("a fact only grep should find"));
        assert!(ctx.contains("(~1 KB)"));
    }

    #[test]
    fn a_file_in_a_language_of_3_byte_characters_is_cut_by_bytes_whole_characters_never_longer_than_it_was() {
        let zh = "\u{4f60}\u{597d}\u{4e16}\u{754c}".repeat(1300) + "END"; // 15.6KB in 5,203 characters
        let out = truncate_content(&zh, 12 * 1024);
        assert!(out.len() <= 12 * 1024, "got {} bytes", out.len());
        assert!(
            utf16_len(&out) < utf16_len(&zh),
            "shorter, not the whole file plus a repeated tail"
        );
        assert_eq!(out.split("END").count() - 1, 1);
        let emoji = "\u{1F600}".repeat(4000);
        let cut = truncate_content(&emoji, 1024);
        // A Rust string cannot hold half an emoji; check the cut kept whole ones only.
        assert!(
            cut.chars()
                .all(|c| c == '\u{1F600}' || "\n. [truncated — file too large]".contains(c))
        );
        assert_eq!(cut.matches('\u{1F600}').count(), 716 / 4 + 204 / 4);
    }

    #[test]
    fn the_default_workspace_files_say_the_same_grep_memory_md_never_read_it_whole() {
        let t = test_app();
        let pattern =
            regex::Regex::new(r"(?i)read MEMORY\.md at the start|Read it every session|On Every Session Start")
                .unwrap();
        for f in ["SOUL.md", "CLAUDE.md"] {
            let text = fs::read_to_string(defaults(&t).join(f)).unwrap();
            assert!(text.to_lowercase().contains("grep"), "{f}");
            assert!(!pattern.is_match(&text), "{f}");
        }
    }

    #[test]
    fn the_old_default_soul_md_and_claude_md_become_the_new_ones_exactly() {
        let t = test_app();
        let dir = tmp_dir();
        for f in ["SOUL.md", "CLAUDE.md"] {
            fs::copy(fixtures().join(format!("old-default-{f}")), dir.path().join(f)).unwrap();
        }
        assert_eq!(
            sorted(upgrade_default_workspace_files(&t, Some(dir.path()))),
            ["CLAUDE.md", "SOUL.md"]
        );
        for f in ["SOUL.md", "CLAUDE.md"] {
            assert_eq!(read_lf(&dir.path().join(f)), read_lf(&defaults(&t).join(f)), "{f}");
        }
        assert!(upgrade_default_workspace_files(&t, Some(dir.path())).is_empty(), "once");
    }

    #[test]
    fn leaves_a_line_the_owner_changed_alone() {
        let t = test_app();
        let dir = tmp_dir();
        let own = "# Soul\n- Always read MEMORY.md at the start of a session, every time, my rule.\n";
        fs::write(dir.path().join("SOUL.md"), own).unwrap();
        assert!(upgrade_default_workspace_files(&t, Some(dir.path())).is_empty());
        assert_eq!(fs::read_to_string(dir.path().join("SOUL.md")).unwrap(), own);
    }

    // --- test/workspace-defaults.test.js ---

    /// No single AI, no tool name only Claude Code has, no Claude model name.
    fn assert_neutral(text: &str, what: &str) {
        let checks: &[(&str, &str)] = &[
            (r"(?i)powered by", what),
            (r"(?-u:\b)Claude(?-u:\b)", "no Claude (the file name CLAUDE.md aside)"),
            (r"mcp__", "Codex names Tarsee's tools differently: say tarsee_*"),
            (r"(?-u:\b)Bash(?-u:\b)", "say the shell"),
            (r"Read, Write, Edit|(?-u:\b)Grep, Glob(?-u:\b)", what),
            (r"(?-u:\b)(Opus|Sonnet|Haiku|Fable)(?-u:\b)", "no Claude model names"),
        ];
        for (pattern, why) in checks {
            assert!(
                !regex::Regex::new(pattern).unwrap().is_match(text),
                "{what}: {why} ({pattern})"
            );
        }
    }

    fn default_md_files(t: &TestApp) -> Vec<String> {
        let mut files: Vec<String> = fs::read_dir(defaults(t))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|f| f.ends_with(".md"))
            .collect();
        files.sort();
        files
    }

    #[test]
    fn the_seeded_set_is_the_one_entrypoint_sh_copies() {
        let t = test_app();
        let entrypoint = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("entrypoint.sh")).unwrap();
        let re = regex::Regex::new(r"for f in ((?:[A-Z]+\.md\s*)+); do").unwrap();
        let mut seeded: Vec<String> = re.captures(&entrypoint).unwrap()[1]
            .split_whitespace()
            .map(String::from)
            .collect();
        seeded.sort();
        assert_eq!(seeded, default_md_files(&t));
    }

    #[test]
    fn each_default_file_names_no_single_ai_or_its_tools() {
        let t = test_app();
        for f in default_md_files(&t) {
            assert_neutral(&fs::read_to_string(defaults(&t).join(&f)).unwrap(), &f);
        }
    }

    #[test]
    fn so_do_the_ones_an_install_without_the_image_starts_with() {
        // config/env.rs writes them on first boot.
        let t = test_app();
        let ws = &t.config().workspace_dir;
        let seeded: Vec<String> = fs::read_dir(ws)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|f| f.ends_with(".md"))
            .collect();
        assert!(
            seeded.contains(&"SOUL.md".to_string()) && seeded.contains(&"TOOLS.md".to_string()),
            "{seeded:?}"
        );
        for f in seeded {
            assert_neutral(&fs::read_to_string(ws.join(&f)).unwrap(), &format!("env.rs {f}"));
        }
    }

    #[test]
    fn soul_md_still_says_what_the_agent_can_do_and_to_use_tarsees_own_tools_for_platform_actions() {
        let t = test_app();
        let soul = fs::read_to_string(defaults(&t).join("SOUL.md")).unwrap();
        assert!(soul.contains("You are **Tarsee**"));
        assert!(soul.contains("run any command"));
        assert!(soul.contains("tarsee_* tools"));
        assert!(soul.to_lowercase().contains("grep"));
    }

    #[test]
    fn soul_md_says_to_offer_a_follow_up_and_schedule_it_only_once_the_owner_says_yes() {
        let t = test_app();
        let soul = fs::read_to_string(defaults(&t).join("SOUL.md")).unwrap();
        assert!(soul.contains(
            "If a task needs a follow-up, offer to schedule it, and schedule it only once the owner says yes."
        ));
        assert!(!soul.contains("If a task needs a follow-up, schedule it."));
    }

    #[test]
    fn before_owner_ok_gets_the_new_follow_up_line_and_nothing_else_changes_once() {
        let t = test_app();
        let dir = workspace_from(&[("SOUL.md", "before-owner-ok-default-SOUL.md")]);
        let old = read_lf(&dir.path().join("SOUL.md"));
        assert_eq!(upgrade_default_workspace_files(&t, Some(dir.path())), ["SOUL.md"]);
        let now = read_lf(&dir.path().join("SOUL.md"));
        assert_eq!(now, read_lf(&defaults(&t).join("SOUL.md")));
        let old_lines: Vec<&str> = old.split('\n').collect();
        let changed: Vec<&str> = now
            .split('\n')
            .enumerate()
            .filter(|(i, line)| old_lines.get(*i) != Some(line))
            .map(|(_, line)| line)
            .collect();
        assert_eq!(
            changed,
            [
                "- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, offer to schedule it, and schedule it only once the owner says yes."
            ]
        );
        assert!(
            upgrade_default_workspace_files(&t, Some(dir.path())).is_empty(),
            "a second boot changes nothing"
        );
    }

    #[test]
    fn keeps_the_line_when_the_owner_wrote_their_own() {
        let t = test_app();
        let dir = tmp_dir();
        let own = "# Soul\n- You are proactive. If a task needs a follow-up, schedule it without asking, my rule.\n";
        fs::write(dir.path().join("SOUL.md"), own).unwrap();
        assert!(upgrade_default_workspace_files(&t, Some(dir.path())).is_empty());
        assert_eq!(fs::read_to_string(dir.path().join("SOUL.md")).unwrap(), own);
    }

    const OLD_FOLLOW_UP: &str =
        "- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, schedule it.";
    const NEW_FOLLOW_UP: &str = "- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, offer to schedule it, and schedule it only once the owner says yes.";

    // Only a whole line that is the old default changes. A line the owner added words to, before or after it, is
    // theirs: swapping the old words inside it would leave "...offer to schedule it, and schedule it only once the
    // owner says yes. Don't ask me first, just do it.", a rule that says both things.
    #[test]
    fn keeps_a_line_the_owner_added_to_after_or_before_the_old_words_lf_and_crlf() {
        let t = test_app();
        for eol in ["\n", "\r\n"] {
            for line in [
                format!("{OLD_FOLLOW_UP} Don't ask me first, just do it."),
                format!("My rule, not a default: {OLD_FOLLOW_UP}"),
            ] {
                let dir = tmp_dir();
                for own in [
                    ["# Soul", line.as_str(), "- Keep it short.", ""].join(eol),
                    ["# Soul", line.as_str()].join(eol),
                ] {
                    fs::write(dir.path().join("SOUL.md"), &own).unwrap();
                    assert!(
                        upgrade_default_workspace_files(&t, Some(dir.path())).is_empty(),
                        "{line}"
                    );
                    assert_eq!(fs::read_to_string(dir.path().join("SOUL.md")).unwrap(), own, "{line}");
                }
            }
        }
    }

    #[test]
    fn upgrades_the_old_line_when_it_is_the_whole_line_keeps_the_files_endings_and_only_once() {
        let t = test_app();
        for eol in ["\n", "\r\n"] {
            let dir = tmp_dir();
            // In the middle of the file, and as its last line with no line ending after it.
            let cases: [(Vec<&str>, Vec<&str>); 2] = [
                (
                    vec!["# Soul", OLD_FOLLOW_UP, "- Keep it short.", ""],
                    vec!["# Soul", NEW_FOLLOW_UP, "- Keep it short.", ""],
                ),
                (vec!["# Soul", OLD_FOLLOW_UP], vec!["# Soul", NEW_FOLLOW_UP]),
            ];
            for (before, after) in cases {
                fs::write(dir.path().join("SOUL.md"), before.join(eol)).unwrap();
                assert_eq!(upgrade_default_workspace_files(&t, Some(dir.path())), ["SOUL.md"]);
                assert_eq!(fs::read_to_string(dir.path().join("SOUL.md")).unwrap(), after.join(eol));
                assert!(
                    upgrade_default_workspace_files(&t, Some(dir.path())).is_empty(),
                    "a second boot changes nothing"
                );
            }
        }
    }

    /// tests/fixtures/workspace/<seed>-<name>: every generation of default an install was seeded with.
    const SEEDED: &[(&str, &[&str])] = &[
        (
            "claude-only-default",
            &["SOUL.md", "CLAUDE.md", "AGENTS.md", "MEMORY.md", "TOOLS.md"],
        ),
        ("old-default", &["SOUL.md", "CLAUDE.md"]),
        ("before-owner-ok-default", &["SOUL.md"]),
    ];

    #[test]
    fn a_line_the_owner_added_words_to_stays_as_they_wrote_it_in_every_file_an_install_was_ever_seeded_with() {
        let t = test_app();
        for (seed, names) in SEEDED {
            let dir = tmp_dir();
            let mut own: HashMap<&str, String> = HashMap::new();
            for n in *names {
                let text = read_lf(&fixtures().join(format!("{seed}-{n}")))
                    .split('\n')
                    .map(|l| {
                        if l.trim().is_empty() {
                            l.to_string()
                        } else {
                            format!("{l} (my words)")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                fs::write(dir.path().join(n), &text).unwrap();
                own.insert(n, text);
            }
            assert!(
                upgrade_default_workspace_files(&t, Some(dir.path())).is_empty(),
                "{seed}"
            );
            for n in *names {
                assert_eq!(fs::read_to_string(dir.path().join(n)).unwrap(), own[n], "{seed} {n}");
            }
        }
    }

    #[test]
    fn an_unedited_file_saved_with_windows_line_endings_becomes_the_new_default_exactly_still_crlf_once() {
        let t = test_app();
        for (seed, names) in SEEDED {
            let dir = tmp_dir();
            for n in *names {
                fs::write(
                    dir.path().join(n),
                    read_lf(&fixtures().join(format!("{seed}-{n}"))).replace('\n', "\r\n"),
                )
                .unwrap();
            }
            let mut expected: Vec<String> = names.iter().map(|n| n.to_string()).collect();
            expected.sort();
            assert_eq!(
                sorted(upgrade_default_workspace_files(&t, Some(dir.path()))),
                expected,
                "{seed}"
            );
            for n in *names {
                assert_eq!(
                    fs::read_to_string(dir.path().join(n)).unwrap(),
                    read_lf(&defaults(&t).join(n)).replace('\n', "\r\n"),
                    "{seed} {n}"
                );
            }
            assert!(
                upgrade_default_workspace_files(&t, Some(dir.path())).is_empty(),
                "{seed}: a second boot changes nothing"
            );
        }
    }

    #[test]
    fn claude_only_defaults_each_unedited_file_becomes_the_new_default_exactly_once() {
        let t = test_app();
        let names = ["SOUL.md", "CLAUDE.md", "AGENTS.md", "MEMORY.md", "TOOLS.md"];
        let fixture_names: Vec<(String, String)> = names
            .iter()
            .map(|n| (n.to_string(), format!("claude-only-default-{n}")))
            .collect();
        let pairs: Vec<(&str, &str)> = fixture_names.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let dir = workspace_from(&pairs);
        let mut expected: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        expected.sort();
        assert_eq!(sorted(upgrade_default_workspace_files(&t, Some(dir.path()))), expected);
        for n in names {
            assert_eq!(read_lf(&dir.path().join(n)), read_lf(&defaults(&t).join(n)), "{n}");
        }
        assert!(
            upgrade_default_workspace_files(&t, Some(dir.path())).is_empty(),
            "a second boot changes nothing"
        );
    }

    #[test]
    fn the_first_default_soul_md_also_becomes_todays() {
        let t = test_app();
        let dir = workspace_from(&[("SOUL.md", "old-default-SOUL.md")]);
        assert_eq!(upgrade_default_workspace_files(&t, Some(dir.path())), ["SOUL.md"]);
        assert_eq!(
            read_lf(&dir.path().join("SOUL.md")),
            read_lf(&defaults(&t).join("SOUL.md"))
        );
    }

    #[test]
    fn keeps_a_file_the_owner_wrote_claude_and_all() {
        let t = test_app();
        let dir = tmp_dir();
        let own = [
            (
                "SOUL.md",
                "# Soul\n\nYou are **Tarsee** — my agent, powered by Claude, and proud of it.\n- Use Bash for everything.\n",
            ),
            (
                "AGENTS.md",
                "# Agent Team\n- **Coder** (Opus) — only the hard stuff, my rule.\n",
            ),
        ];
        for (n, text) in own {
            fs::write(dir.path().join(n), text).unwrap();
        }
        assert!(upgrade_default_workspace_files(&t, Some(dir.path())).is_empty());
        for (n, text) in own {
            assert_eq!(fs::read_to_string(dir.path().join(n)).unwrap(), text);
        }
    }

    #[test]
    fn swaps_only_the_default_lines_in_a_file_the_owner_added_to() {
        let t = test_app();
        let dir = workspace_from(&[("SOUL.md", "claude-only-default-SOUL.md")]);
        append_to(
            &dir.path().join("SOUL.md"),
            "- Always answer in haiku form on Fridays.\n",
        )
        .unwrap();
        assert_eq!(upgrade_default_workspace_files(&t, Some(dir.path())), ["SOUL.md"]);
        let text = fs::read_to_string(dir.path().join("SOUL.md")).unwrap();
        assert!(
            text.ends_with("- Always answer in haiku form on Fridays.\n"),
            "the owner's line stays"
        );
        assert!(
            !regex::Regex::new("powered by Claude|mcp__|Bash")
                .unwrap()
                .is_match(&text)
        );
    }

    // --- the rest of the module, which the Node tests did not cover ---

    #[test]
    fn reads_are_cached_for_five_seconds_and_writes_invalidate() {
        let t = test_app();
        let path = t.config().workspace_dir.join("NOTES.md");
        assert_eq!(read_workspace_file(&t, "NOTES.md"), "");
        fs::write(&path, "one").unwrap();
        assert_eq!(
            read_workspace_file(&t, "NOTES.md"),
            "one",
            "a missing file is not cached"
        );
        fs::write(&path, "two").unwrap();
        assert_eq!(read_workspace_file(&t, "NOTES.md"), "one", "cached");
        // Age the entry past the 5 seconds.
        if let Some(entry) = cache(&t).files.lock().get_mut("NOTES.md") {
            entry.1 = Instant::now().checked_sub(Duration::from_secs(6)).unwrap();
        }
        assert_eq!(read_workspace_file(&t, "NOTES.md"), "two");
        write_workspace_file(&t, "NOTES.md", "three").unwrap();
        assert_eq!(read_workspace_file(&t, "NOTES.md"), "three");
        append_workspace_file(&t, "NOTES.md", "+four").unwrap();
        assert_eq!(read_workspace_file(&t, "NOTES.md"), "three+four");
        fs::write(&path, "five").unwrap();
        invalidate_cache(&t);
        assert_eq!(read_workspace_file(&t, "NOTES.md"), "five");
        write_workspace_file(&t, "deep/er/x.md", "made").unwrap();
        assert_eq!(read_workspace_file(&t, "deep/er/x.md"), "made");
        append_workspace_file(&t, "memory/summaries.md", "\nnew").unwrap();
        assert_eq!(read_workspace_file(&t, "memory/summaries.md"), "\nnew");
    }

    #[test]
    fn the_daily_log_has_a_header_then_one_timestamped_line_per_note() {
        let t = test_app_with_env([("TZ", "Asia/Manila")]);
        let at = DateTime::parse_from_rfc3339("2026-11-12T16:05:09Z")
            .unwrap()
            .with_timezone(&Utc);
        append_daily_log_at(&t, "first", at).unwrap();
        append_daily_log_at(&t, "second", at + chrono::Duration::seconds(1)).unwrap();
        let path = t.config().workspace_dir.join("memory").join("2026-11-12.md");
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "# Daily Log — 2026-11-12\n\n- [00:05:09] first\n\n- [00:05:10] second\n"
        );
        append_daily_log(&t, "now").unwrap();
    }

    #[test]
    fn heartbeat_and_boot_need_something_to_do() {
        let t = test_app();
        let ws = t.config().workspace_dir.clone();
        // The default files: a heading and comments only.
        assert_eq!(get_heartbeat_context(&t), "");
        assert_eq!(get_boot_context(&t), "");
        fs::write(
            ws.join("HEARTBEAT.md"),
            "# Heartbeat\r\n<!-- a\nlong comment -->\r\n## Tasks\r\nok\r\n",
        )
        .unwrap();
        invalidate_cache(&t);
        assert_eq!(get_heartbeat_context(&t), "", "two letters are not a task");
        let task = "# Heartbeat\n\n- Check the inbox and summarise it.\n";
        fs::write(ws.join("BOOT.md"), task).unwrap();
        invalidate_cache(&t);
        assert_eq!(get_boot_context(&t), task);
        assert_eq!(strip_heading_lines("a\r# b\n#c\u{2028}#d\nx#y"), "a\r\n\u{2028}\nx#y");
    }

    #[test]
    fn the_heartbeat_is_shown_only_when_the_owner_has_okd_it() {
        let t = test_app();
        let ws = t.config().workspace_dir.clone();
        let task = "# Heartbeat\n\n- Check the inbox and summarise it.\n";
        fs::write(ws.join("HEARTBEAT.md"), task).unwrap();
        invalidate_cache(&t);
        let shown = get_bootstrap_context(&t, Some(false));
        assert!(shown.contains(&format!("<!-- Heartbeat Tasks (HEARTBEAT.md) -->\n{task}")));
        let waiting = get_bootstrap_context(&t, Some(true));
        assert!(waiting.ends_with(HEARTBEAT_WAITING_NOTE));
        assert!(!waiting.contains("Check the inbox"));
        let unknown = get_bootstrap_context(&t, None);
        assert!(unknown.ends_with(HEARTBEAT_UNCHECKED_NOTE));
        // The default file is shown as before, whatever the OK.
        fs::write(ws.join("HEARTBEAT.md"), crate::config::env::DEFAULT_FILES[6].1).unwrap();
        invalidate_cache(&t);
        assert!(get_bootstrap_context(&t, None).contains("<!-- Heartbeat Tasks (HEARTBEAT.md) -->\n# Heartbeat Tasks"));
    }

    #[test]
    fn the_bootstrap_context_is_in_order_and_skips_near_empty_files() {
        let t = test_app();
        let ws = t.config().workspace_dir.clone();
        for name in [
            "AGENTS.md",
            "SOUL.md",
            "IDENTITY.md",
            "USER.md",
            "TOOLS.md",
            "HEARTBEAT.md",
        ] {
            fs::write(ws.join(name), format!("{name} text")).unwrap();
        }
        fs::write(ws.join("USER.md"), "\u{FEFF} abc \n").unwrap();
        fs::write(ws.join("MEMORY.md"), "1234").unwrap();
        invalidate_cache(&t);
        assert_eq!(
            get_bootstrap_context(&t, Some(false)),
            "<!-- Agent Rules (AGENTS.md) -->\nAGENTS.md text\n\n<!-- Soul & Personality (SOUL.md) -->\nSOUL.md text\n\n\
             <!-- Identity (IDENTITY.md) -->\nIDENTITY.md text\n\n<!-- Tools & Capabilities (TOOLS.md) -->\nTOOLS.md text\n\n\
             <!-- Heartbeat Tasks (HEARTBEAT.md) -->\nHEARTBEAT.md text"
        );
    }

    #[test]
    fn the_bootstrap_file_is_detected_and_deleted() {
        let t = test_app();
        assert!(!has_bootstrap_file(&t));
        write_workspace_file(&t, "BOOTSTRAP.md", "  12345  ").unwrap();
        assert!(!has_bootstrap_file(&t), "five characters are not enough");
        write_workspace_file(&t, "BOOTSTRAP.md", "# First run\nAsk the owner their name.").unwrap();
        assert!(has_bootstrap_file(&t));
        delete_bootstrap_file(&t);
        assert!(!has_bootstrap_file(&t));
        assert!(!t.config().workspace_dir.join("BOOTSTRAP.md").exists());
        delete_bootstrap_file(&t);
    }

    #[test]
    fn identity_lines_become_keys_and_values() {
        let t = test_app();
        let parsed = parse_identity_file(&t, None);
        assert_eq!(
            Value::Object(parsed),
            serde_json::json!({"name": "Tarsee", "emoji": "🐒", "creature": "Tarsier", "vibe": "Sees everything, forgets nothing"})
        );
        let parsed = parse_identity_file(
            &t,
            Some("- **Full  Name:**  Ana\r\n- **Name:** x\r\n-  **Name:**   y  \r\nnot - **A:** b\n-**B:** c"),
        );
        assert_eq!(
            Value::Object(parsed),
            serde_json::json!({"full_name": "Ana", "name": "y"})
        );
        // JavaScript's \s takes line ends too, so a label can run on from the line before (checked against Node).
        assert_eq!(
            Value::Object(parse_identity_file(&t, Some("- **A:**\n- **B:** c\n-\n**C:** d"))),
            serde_json::json!({"a": "- **B:** c", "c": "d"})
        );
        assert!(parse_identity_file(&t, Some("")).is_empty());
        // Checked against Node: number-like labels first, and no __proto__.
        assert_eq!(
            Value::Object(parse_identity_file(
                &t,
                Some("- **Name:** a\n- **2:** two\n- **1:** one\n- **__proto__:** x\n- **Vibe:** v")
            ))
            .to_string(),
            r#"{"1":"one","2":"two","name":"a","vibe":"v"}"#
        );
    }

    #[test]
    fn a_plain_name_is_one_name_and_nothing_else() {
        for name in ["SOUL.md", "my-skill", "a b", "..x", "x.."] {
            assert!(is_plain_name(name), "{name}");
        }
        let absolute = if cfg!(windows) { r"C:\Windows" } else { "/etc" };
        for name in ["", ".", "..", "a/b", "a\\b", "/abs", absolute, "nul\0x"] {
            assert!(!is_plain_name(name), "{name:?}");
        }
        #[cfg(windows)]
        for name in ["C:", "c:x", r"\\server\share"] {
            assert!(!is_plain_name(name), "{name:?}");
        }
    }

    #[test]
    fn a_workspace_file_name_is_joined_as_node_joined_it_and_never_leaves_the_workspace() {
        let t = test_app();
        let ws = t.config().workspace_dir.clone();
        let outside = tmp_dir();
        let target = outside.path().join("victim.md");
        std::fs::write(&target, "keep me").unwrap();
        // An absolute name stays under the workspace, as path.join kept it (on Windows the drive's colon then makes
        // a name the system refuses, as it refused Node's).
        let absolute = target.to_string_lossy().to_string();
        let written = write_workspace_file(&t, &absolute, "inside");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep me");
        assert!(is_inside(
            &ws,
            Path::new(&node_join(&[&ws.to_string_lossy(), &absolute]))
        ));
        if cfg!(unix) {
            written.unwrap();
            assert_eq!(read_workspace_file(&t, &absolute), "inside");
        }
        // `..` out of the workspace is refused (the JS followed it).
        let up = "../escaped.md";
        assert_eq!(
            write_workspace_file(&t, up, "x").unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(append_workspace_file(&t, up, "x").is_err());
        assert_eq!(read_workspace_file(&t, "../escaped.md"), "");
        assert!(!t.path().join("escaped.md").exists());
        // `..` that stays inside is fine.
        write_workspace_file(&t, "memory/../NOTES.md", "ok").unwrap();
        assert_eq!(std::fs::read_to_string(ws.join("NOTES.md")).unwrap(), "ok");
    }

    #[test]
    fn a_workspace_file_name_means_what_it_says_dots_spaces_and_device_names_included() {
        let t = test_app();
        write_workspace_file(&t, "SOUL.md", "the soul").unwrap();
        // On Windows `SOUL.md.` and `SOUL.md ` would write SOUL.md itself, and `nul` would go to a device.
        for name in ["SOUL.md.", "SOUL.md ", "nul"] {
            write_workspace_file(&t, name, &format!("written as {name:?}")).unwrap();
            invalidate_cache(&t);
            assert_eq!(
                read_workspace_file(&t, name),
                format!("written as {name:?}"),
                "{name:?}"
            );
        }
        // `...` is a name too, never the workspace folder itself.
        let dots = write_workspace_file(&t, "...", "dots");
        invalidate_cache(&t);
        if dots.is_ok() {
            assert_eq!(read_workspace_file(&t, "..."), "dots");
        }
        assert_eq!(read_workspace_file(&t, "SOUL.md"), "the soul");
        assert!(t.config().workspace_dir.join("SOUL.md").is_file());
    }

    #[test]
    fn the_memory_path_shown_to_the_model_is_tidied_as_path_join_tidied_it() {
        let dir = tmp_dir();
        let messy = format!("{}/./ws//", dir.path().display());
        let t = test_app_with_env([("TARSEE_WORKSPACE_DIR", messy.as_str())]);
        std::fs::write(t.config().workspace_dir.join("MEMORY.md"), "# Memory\n- fact\n").unwrap();
        let ctx = get_bootstrap_context(&t, None);
        let tidy = crate::util::node_path::normalize(&dir.path().join("ws").join("MEMORY.md"));
        let pointer = format!("Your long-term memory is in `{}`", tidy.display());
        assert!(ctx.contains(&pointer), "{pointer}\n{ctx}");
        assert!(!pointer.contains("//") && !pointer.contains("/./") && !pointer.contains("\\\\"));
    }
}
