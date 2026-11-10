import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";

/**
 * Workspace file reader/writer with caching.
 * Reads SOUL.md, USER.md, MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md,
 * HEARTBEAT.md, BOOT.md, BOOTSTRAP.md and daily logs from WORKSPACE_DIR.
 * Files ARE the memory — the bot reads its identity from disk every time.
 */

const CACHE_TTL_MS = 5000; // 5 seconds
const cache = new Map(); // filename → { content, timestamp }

/** All known workspace files */
export const WORKSPACE_FILES = [
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

/**
 * Read a workspace file with 5s cache.
 * @param {string} filename - e.g. "SOUL.md", "AGENTS.md"
 * @returns {string} File content or empty string
 */
export function readWorkspaceFile(filename) {
  const cached = cache.get(filename);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.content;
  }

  const filePath = path.join(config.WORKSPACE_DIR, filename);
  try {
    const content = fs.readFileSync(filePath, "utf8");
    cache.set(filename, { content, timestamp: Date.now() });
    return content;
  } catch {
    return "";
  }
}

/**
 * Write a workspace file (overwrites). Invalidates cache.
 * @param {string} filename
 * @param {string} content
 */
export function writeWorkspaceFile(filename, content) {
  const filePath = path.join(config.WORKSPACE_DIR, filename);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  cache.delete(filename);
}

/**
 * Append to a workspace file. Invalidates cache.
 * @param {string} filename
 * @param {string} content
 */
export function appendWorkspaceFile(filename, content) {
  const filePath = path.join(config.WORKSPACE_DIR, filename);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, content, "utf8");
  cache.delete(filename);
}

/**
 * Append a note to today's daily log: memory/YYYY-MM-DD.md
 * @param {string} content - The note to append
 */
export function appendDailyLog(content) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = path.join("memory", `${today}.md`);
  const filePath = path.join(config.WORKSPACE_DIR, filename);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const entry = `\n- [${timestamp}] ${content}`;

  // Create with header if new file
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Daily Log — ${today}\n${entry}\n`, "utf8");
  } else {
    fs.appendFileSync(filePath, `${entry}\n`, "utf8");
  }
}

/**
 * Most of one workspace file the system prompt carries. It was 8KB, which cut
 * the middle out of an AGENTS.md that had grown to 16KB (measured on
 * TarseeMacOS: the agent saw the first 5.7KB and the last 1.6KB, so the rules
 * in between never reached it). A file over the cap is still cut, and the cut
 * is logged so it is noticed: move task-specific sections into skills.
 */
export const WORKSPACE_FILE_MAX_BYTES = 12 * 1024;
const _truncWarned = new Set();

/**
 * Truncate content to a max size with 70% head + 20% tail strategy.
 * @param {string} content
 * @param {number} maxBytes - Default WORKSPACE_FILE_MAX_BYTES (12KB)
 * @param {string} [name] - the file's name, for the warning
 * @returns {string}
 */
export function truncateContent(content, maxBytes = WORKSPACE_FILE_MAX_BYTES, name = "") {
  if (!content) return content;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= maxBytes) return content;
  const key = `${name}:${content.length}`;
  if (name && !_truncWarned.has(key)) {
    _truncWarned.add(key);
    console.warn(`[workspace] ${name} is ${Math.round(bytes / 1024)}KB, over the ${Math.round(maxBytes / 1024)}KB a prompt file may be: its middle is cut out of the system prompt`);
  }

  // Head and tail measured in bytes like the cap (a file in Chinese or full of
  // emoji has 3 or 4 bytes a character), and never cutting a character in two.
  const head = bytesFrom(content, Math.floor(maxBytes * 0.7), "start");
  const tail = bytesFrom(content, Math.floor(maxBytes * 0.2), "end");
  return `${head}\n\n... [truncated — file too large] ...\n\n${tail}`;
}

/** The longest start (or end) of `s` that fits in `max` UTF-8 bytes, whole characters only. */
function bytesFrom(s, max, from) {
  const chars = Array.from(s);
  if (from === "end") chars.reverse();
  const out = [];
  let n = 0;
  for (const c of chars) {
    const b = Buffer.byteLength(c, "utf8");
    if (n + b > max) break;
    out.push(c);
    n += b;
  }
  if (from === "end") out.reverse();
  return out.join("");
}

/**
 * What a chat's system prompt says in place of HEARTBEAT.md text that waits for the owner's OK
 * (lib/automation-approval.js), or that it couldn't be checked against it.
 */
const HEARTBEAT_WAITING_NOTE = "<!-- Heartbeat Tasks (HEARTBEAT.md): waiting for the owner's OK, so not shown -->\n"
  + "HEARTBEAT.md was changed outside Settings and the owner hasn't OK'd it, so no heartbeat check runs. "
  + "It runs only once the owner clicks Let it run in Settings > Automation (or saves it there). "
  + "Don't tell the owner it is set up or running until then; read the file if you need what it says.";
const HEARTBEAT_UNCHECKED_NOTE = "<!-- Heartbeat Tasks (HEARTBEAT.md): not checked against the owner's OK, so not shown -->\n"
  + "HEARTBEAT.md runs only text the owner has OK'd in Settings > Automation (Let it run). "
  + "Don't tell the owner it is set up or running unless they have; read the file if you need what it says.";

/**
 * Get the full bootstrap context for system prompt injection.
 * Order: AGENTS → SOUL → IDENTITY → USER → TOOLS → MEMORY → HEARTBEAT
 *
 * HEARTBEAT.md is shown as the heartbeat's tasks only when the owner has OK'd its text (opts.heartbeatWaiting false,
 * from lib/automation-approval.js automationStatus). Text that waits for their OK is left out, with a line saying no
 * check runs: it doesn't run, and shown here the AI read it as live and told the owner the check was set up. It is also
 * text nobody has reviewed (the AI may have written it from a web page or an email it read), which would otherwise
 * reach every chat with the weight of the system prompt, and the AI can still read the file when asked about it. A
 * change made through the shell can't be caught when it is made; this line is how the AI learns of it.
 * @param {object} [opts]
 * @param {boolean|null} [opts.heartbeatWaiting] true: HEARTBEAT.md holds text the owner hasn't OK'd; null: not known
 * @returns {string}
 */
export function getBootstrapContext({ heartbeatWaiting = null } = {}) {
  const files = [
    { name: "AGENTS.md", label: "Agent Rules" },
    { name: "SOUL.md", label: "Soul & Personality" },
    { name: "IDENTITY.md", label: "Identity" },
    { name: "USER.md", label: "About the User" },
    { name: "TOOLS.md", label: "Tools & Capabilities" },
    { name: "MEMORY.md", label: "Long-Term Memory" },
    { name: "HEARTBEAT.md", label: "Heartbeat Tasks" },
  ];

  const sections = [];
  for (const { name, label } of files) {
    // MEMORY.md grows without bound (50KB and more on a long-lived install), so
    // it is never inlined (nor read here, its size is enough): a pointer tells
    // the agent to grep it for the topic at hand. Reading it whole, or carrying
    // a cut-down copy in every prompt, costs the context for the few lines a
    // task needs. The path is absolute: the agent's working folder
    // (CLAUDE_WORKSPACE_DIR) can be another one.
    if (name === "MEMORY.md") {
      const memPath = path.join(config.WORKSPACE_DIR, name);
      let size = 0;
      try { size = fs.statSync(memPath).size; } catch { /* no MEMORY.md yet */ }
      if (size < 5) continue;
      sections.push(
        `<!-- ${label} (${name}): pointer only, not inlined -->\n`
        + `Your long-term memory is in \`${memPath}\` (~${Math.max(1, Math.round(size / 1024))} KB). `
        + `Grep it for the topic you need (\`grep -n -i "term" "${memPath}"\`) or use search_memories; never read it whole.`,
      );
      continue;
    }

    const raw = readWorkspaceFile(name);
    if (!raw || raw.trim().length < 5) continue;

    if (name === "HEARTBEAT.md" && heartbeatWaiting !== false) {
      // Only text with something to do needs the owner's OK: the default file (a heading and comments) is shown as before.
      if (getHeartbeatContext()) {
        sections.push(heartbeatWaiting === true ? HEARTBEAT_WAITING_NOTE : HEARTBEAT_UNCHECKED_NOTE);
        continue;
      }
    }

    const content = truncateContent(raw, WORKSPACE_FILE_MAX_BYTES, name);
    sections.push(`<!-- ${label} (${name}) -->\n${content}`);
  }

  return sections.join("\n\n");
}

/**
 * The default SOUL.md and CLAUDE.md an install was seeded with used to say
 * "read MEMORY.md at the start of every session", which now contradicts the
 * system prompt's "grep it, never read it whole" (and CLAUDE.md said cron runs
 * in UTC). Later the defaults stopped naming one AI: they said "powered by
 * Claude", named Claude Code's own tools (Bash, Read/Write/Edit/Grep/Glob,
 * mcp__tarsee__*) and the agent team's Claude models, none of which hold on
 * another AI. Existing workspaces keep their seeded files, so on boot each line
 * that is still exactly an old default line, the whole line, is replaced with
 * the new one. A line the owner changed or added words to no longer matches and
 * is left alone. Returns the files it updated.
 * test/workspace-defaults.test.js keeps each old default as a fixture.
 */
// The tool lines of the default CLAUDE.md. A new line replaces the old one whole, so the swap runs once.
// Three generations: the first defaults (Slack, no files), the WhatsApp ones (Slack gone), and today's (Slack back).
const SEND_MESSAGE_LINE_OLD = "- **tarsee_send_message** — Push messages to Telegram, Discord, Slack, or web";
const SEND_MESSAGE_LINE_WHATSAPP = "- **tarsee_send_message** — Push messages to Telegram, Discord, WhatsApp, or web";
const SEND_FILE_LINE_WHATSAPP = "- **tarsee_send_file** — Send a file as a real attachment to the Telegram, Discord or WhatsApp chat you are in (never answer with a folder path)";
const SEND_MESSAGE_LINE = "- **tarsee_send_message** — Push messages to Telegram, Discord, WhatsApp, Slack, or web";
const SEND_FILE_LINE = "- **tarsee_send_file** — Send a file as a real attachment to the Telegram, Discord, WhatsApp or Slack chat you are in (never answer with a folder path)";
// SOUL.md's tool line, through four generations: Slack, WhatsApp, files, then Slack back (all naming mcp__tarsee__*,
// which only Claude Code calls them), and today's, which names them as every AI sees them.
const SOUL_TOOLS_LINE = "- **Platform tools** (the tarsee_* tools): Send messages and files (real attachments) to Telegram/Discord/WhatsApp/Slack, schedule tasks, manage memory, search the web, use the encrypted vault.";
// The lines of TOOLS.md (both the image's and config/env.js's) that told the agent to stay out of Bash.
const TOOLS_SHELL_LINES = [
  ["- Make, edit or list Discord channels and webhooks with tarsee_discord_admin. Never call Discord's API from Bash and never pull DISCORD_BOT_TOKEN from the vault for it: Tarsee's own bot does the work.",
    "- Make, edit or list Discord channels and webhooks with tarsee_discord_admin. Never call Discord's API from the shell and never pull DISCORD_BOT_TOKEN from the vault for it: Tarsee's own bot does the work."],
  ["- List projects, services and variable names, set a variable or redeploy with tarsee_railway. Never call Railway's API from Bash and never put a Railway token or a secret value in a command: Tarsee reads the token from the vault itself (RAILWAY_API_TOKEN, an account or workspace token).",
    "- List projects, services and variable names, set a variable or redeploy with tarsee_railway. Never call Railway's API from the shell and never put a Railway token or a secret value in a command: Tarsee reads the token from the vault itself (RAILWAY_API_TOKEN, an account or workspace token)."],
  // What tarsee_railway sets on Tarsee's own service (an allowlist) and when else it refuses. The old line is split, so
  // once swapped it is no longer there whole and the swap runs once.
  ["- On Railway, leaving out project means Tarsee's own project and service. Redeploying Tarsee's own service restarts it and ends the turn. Nothing in the tool deletes: deleting a variable or a service is for the owner to do by hand in Railway.", [
    "- On Railway, leaving out project means Tarsee's own project and service. Redeploying Tarsee's own service restarts it and ends the turn.",
    "- On Tarsee's own service it sets only a key or address for the owner's own scripts (a name in capitals ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL that Tarsee doesn't read itself and that appears nowhere in its AI engines' code, the Terminal's own claude program included: Tarsee reads the one running now when it starts), TZ and a few tuning settings. It sets only TZ and the tuning settings there while that program can't be read, and while TARSEE_AUTO_UPDATE_CLI is among its variables (TARSEE_AUTO_UPDATE_CLI=1 installs the newest claude at each start). The owner sets anything else there by hand in Railway's dashboard: sign-in, the AI and its keys, how Tarsee is built, starts or runs.",
    "- A variable one of Tarsee's own variables is filled in from by a Railway reference counts as that variable, under the same rules; names that differ only in case are different variables. It also refuses, saying why: anything in a Tarsee's environment while a refused variable is sealed or filled in from a service the project doesn't have, and a vault key onto Tarsee's own service, or into a variable it is filled in from, while get_key is denied in Tool Permissions. Tell the person what the refusal says; never look for a way around it.",
    "- Any Tarsee service gets the same limits: Tarsee's own in any environment, and any service whose variable names (in any environment of its project, or the name being set) include SETUP_PASSWORD, ENCRYPTION_KEY or a TARSEE_ name, or that Railway says is deployed from a repo or image named like Tarsee's. On each of them but Tarsee's own service in the environment it runs in, it sets only TZ and the tuning settings, since Tarsee can't read the programs that one runs. If Railway doesn't give a project's variable names, nothing is set there.",
    "- Nothing in the tool deletes: deleting a variable or a service is for the owner to do by hand in Railway.",
  ].join("\n")],
];

const DEFAULT_UPGRADES = {
  "SOUL.md": [
    ["You are **Tarsee** — a 24/7 autonomous AI agent powered by Claude.",
      "You are **Tarsee** — a 24/7 autonomous AI agent."],
    ["- **Full tool access**: Read, Write, Edit, Bash, Grep, Glob — you can work with any file or run any command.",
      "- **Full tool access**: you can read, write, edit and search any file, and run any command in the shell."],
    ["- **Platform tools** (mcp__tarsee__*): Send messages to Telegram/Discord/Slack, schedule tasks, manage memory, search the web, use the encrypted vault.",
      SOUL_TOOLS_LINE],
    ["- **Platform tools** (mcp__tarsee__*): Send messages and files (real attachments) to Telegram/Discord/WhatsApp, schedule tasks, manage memory, search the web, use the encrypted vault.",
      SOUL_TOOLS_LINE],
    ["- **Platform tools** (mcp__tarsee__*): Send messages and files (real attachments) to Telegram/Discord/WhatsApp/Slack, schedule tasks, manage memory, search the web, use the encrypted vault.",
      SOUL_TOOLS_LINE],
    ["- **Persistent memory**: MEMORY.md stores everything you learn. Read it every session.",
      "- **Persistent memory**: MEMORY.md stores everything you learn. Grep it for what a task needs."],
    ["- **Image analysis**: Users can send images and you can read them.",
      "- **Images and files**: Users can send pictures, PDFs and other files. Each one is saved in the workspace for you to open, and you see a picture yourself when your model can."],
    ["- Always read MEMORY.md at the start of a session to know what you've learned.",
      "- MEMORY.md grows long: grep it for the topic at hand (`grep -n -i \"term\" MEMORY.md`) or use search_memories. Never read it whole."],
    ["- Use mcp__tarsee__* tools for platform actions. Never use Bash for scheduling or messaging.",
      "- Use the tarsee_* tools for platform actions. Never use the shell for scheduling or messaging."],
    // Every default before scheduled tasks waited for the owner's OK said to schedule a follow-up outright: each run of
    // a task can be a paid turn, so the agent offers and the owner decides.
    ["- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, schedule it.",
      "- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, offer to schedule it, and schedule it only once the owner says yes."],
  ],
  "AGENTS.md": [
    ["- **Coder** (Opus) — Code, debugging, architecture, scripts.",
      "- **Coder** (your AI's most capable model) — Code, debugging, architecture, scripts."],
    ["- **Researcher** (Sonnet) — Web research, documentation, analysis.",
      "- **Researcher** (its everyday model) — Web research, documentation, analysis."],
    ["- **Writer** (Sonnet) — Content, emails, documents, copywriting.",
      "- **Writer** (its everyday model) — Content, emails, documents, copywriting."],
    ["- **Quick** (Haiku) — Fast lookups, formatting, simple tasks.",
      "- **Quick** (its fastest model) — Fast lookups, formatting, simple tasks."],
  ],
  "MEMORY.md": [
    ["This file stores everything Tarsee learns across sessions. Read this at the start of every conversation.",
      "This file stores everything Tarsee learns across sessions. It grows long: grep it for what a task needs, and never read it whole."],
  ],
  "TOOLS.md": TOOLS_SHELL_LINES,
  "CLAUDE.md": [
    [[
      "## On Every Session Start",
      "",
      "Before responding, read your context files:",
      "1. `SOUL.md` — your identity, personality, capabilities",
      "2. `MEMORY.md` — accumulated knowledge, learned skills, API access",
      "3. `USER.md` — what you know about your user",
    ].join("\n"), [
      "## Your Context Files",
      "",
      "`SOUL.md` (your identity) and `USER.md` (what you know about your user) are already",
      "in your system prompt: don't read them again. `MEMORY.md` (accumulated knowledge,",
      "learned skills, API access) is not, because it grows long: grep it for the topic a",
      "task needs (`grep -n -i \"term\" MEMORY.md`) or use tarsee_search_memories, and never",
      "read it whole.",
    ].join("\n")],
    ["- **tarsee_schedule_task** — Schedule cron jobs (server is UTC)",
      "- **tarsee_schedule_task** — Schedule cron jobs (times are in the configured timezone, `TARSEE_TIMEZONE`)"],
    [SEND_MESSAGE_LINE_OLD, `${SEND_MESSAGE_LINE}\n${SEND_FILE_LINE}`],
    [SEND_MESSAGE_LINE_WHATSAPP, SEND_MESSAGE_LINE],
    [SEND_FILE_LINE_WHATSAPP, SEND_FILE_LINE],
    ["- **Bash** — Write and run scripts for complex tasks",
      "- **The shell** — Write and run scripts for complex tasks"],
    ["- You can install npm/pip packages via Bash if needed for tasks",
      "- You can install npm/pip packages from the shell when a task needs them"],
  ],
};

/**
 * `text` with each run of whole lines that reads `from` (one line, or several joined by \n) replaced by `to`. A line
 * matches only whole, its own ending (CRLF or LF) aside: a line the owner added words to, before or after the old
 * default, is theirs and stays. The new lines keep the file's endings: a CRLF file stays CRLF.
 */
function swapWholeLines(text, from, to) {
  const want = from.split("\n");
  const lines = text.split("\n"); // a CRLF file's lines keep their \r here
  const bare = (line) => (line.endsWith("\r") ? line.slice(0, -1) : line);
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (i + want.length <= lines.length && want.every((w, k) => bare(lines[i + k]) === w)) {
      const cr = lines[i].endsWith("\r") ? "\r" : "";
      const lastCr = lines[i + want.length - 1].endsWith("\r") ? "\r" : "";
      const news = to.split("\n");
      news.forEach((line, k) => out.push(line + (k === news.length - 1 ? lastCr : cr)));
      i += want.length;
    } else {
      out.push(lines[i]);
      i += 1;
    }
  }
  return out.join("\n");
}

export function upgradeDefaultWorkspaceFiles(dir = config.WORKSPACE_DIR) {
  const updated = [];
  for (const [name, swaps] of Object.entries(DEFAULT_UPGRADES)) {
    const file = path.join(dir, name);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    let next = text;
    // (The first line only: in a CRLF file a block of lines never holds `from`, joined by \n, as it is.)
    for (const [from, to] of swaps) if (next.includes(from.split("\n")[0])) next = swapWholeLines(next, from, to);
    if (next === text) continue;
    try {
      fs.writeFileSync(file, next, "utf8");
      cache.delete(name);
      updated.push(name);
    } catch (err) {
      console.warn(`[workspace] could not update ${name}: ${err.message}`);
    }
  }
  if (updated.length) console.log(`[workspace] updated the default instructions in ${updated.join(", ")} (grep MEMORY.md, never read it whole; send files as attachments; Slack; wording that fits any AI; offer a follow-up, schedule it only once the owner says yes)`);
  return updated;
}

/**
 * Get heartbeat context: HEARTBEAT.md content for periodic task runs.
 * @returns {string}
 */
export function getHeartbeatContext() {
  const content = readWorkspaceFile("HEARTBEAT.md");
  if (!content) return "";
  // Strip markdown headings and HTML comments BEFORE the emptiness check.
  // The default-shipped file is a heading plus instructional <!-- comments -->,
  // which passes a naive trim>5 test while containing no actual instructions.
  // The template's own text says "Leave empty to skip ... (saves tokens)" — but
  // the naive check never skipped, so every deployment burned a full Claude turn
  // on boot and again every ~30 minutes, forever, to conclude there was nothing
  // to do. Worse, it makes the model invent work to justify the turn.
  const significant = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#.*$/gm, "")
    .trim();
  if (significant.length < 5) return "";
  return truncateContent(content);
}

/**
 * Get boot context: BOOT.md content for startup runs.
 * @returns {string}
 */
export function getBootContext() {
  const content = readWorkspaceFile("BOOT.md");
  if (!content) return "";
  // Strip markdown headings and HTML comments BEFORE the emptiness check.
  // The default-shipped file is a heading plus instructional <!-- comments -->,
  // which passes a naive trim>5 test while containing no actual instructions.
  // The template's own text says "Leave empty to skip ... (saves tokens)" — but
  // the naive check never skipped, so every deployment burned a full Claude turn
  // on boot and again every ~30 minutes, forever, to conclude there was nothing
  // to do. Worse, it makes the model invent work to justify the turn.
  const significant = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#.*$/gm, "")
    .trim();
  if (significant.length < 5) return "";
  return truncateContent(content);
}

/**
 * Check if BOOTSTRAP.md exists and has content (first-run detection).
 * @returns {boolean}
 */
export function hasBootstrapFile() {
  const content = readWorkspaceFile("BOOTSTRAP.md");
  return !!(content && content.trim().length > 5);
}

/**
 * Delete BOOTSTRAP.md after first-run setup is complete.
 */
export function deleteBootstrapFile() {
  const filePath = path.join(config.WORKSPACE_DIR, "BOOTSTRAP.md");
  try {
    fs.unlinkSync(filePath);
    cache.delete("BOOTSTRAP.md");
  } catch {
    // already gone
  }
}

/**
 * Parse IDENTITY.md key-value format: `- **Label:** value`
 * @param {string} [content] - Optional content, reads file if not provided
 * @returns {Record<string, string>}
 */
export function parseIdentityFile(content) {
  const raw = content ?? readWorkspaceFile("IDENTITY.md");
  if (!raw) return {};

  const result = {};
  const pattern = /^-\s+\*\*(.+?):\*\*\s*(.+)$/gm;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
    result[key] = match[2].trim();
  }
  return result;
}

/**
 * Invalidate all cached files.
 */
export function invalidateCache() {
  cache.clear();
}
