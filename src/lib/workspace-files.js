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
 * Get the full bootstrap context for system prompt injection.
 * Order: AGENTS → SOUL → IDENTITY → USER → TOOLS → MEMORY
 * @returns {string}
 */
export function getBootstrapContext() {
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

    const content = truncateContent(raw, WORKSPACE_FILE_MAX_BYTES, name);
    sections.push(`<!-- ${label} (${name}) -->\n${content}`);
  }

  return sections.join("\n\n");
}

/**
 * The default SOUL.md and CLAUDE.md an install was seeded with used to say
 * "read MEMORY.md at the start of every session", which now contradicts the
 * system prompt's "grep it, never read it whole" (and CLAUDE.md said cron runs
 * in UTC). Existing workspaces keep their seeded files, so on boot the exact
 * old default lines are replaced with the new ones. A line the owner changed
 * no longer matches and is left alone. Returns the files it updated.
 */
const DEFAULT_UPGRADES = {
  "SOUL.md": [
    ["- **Persistent memory**: MEMORY.md stores everything you learn. Read it every session.",
      "- **Persistent memory**: MEMORY.md stores everything you learn. Grep it for what a task needs."],
    ["- Always read MEMORY.md at the start of a session to know what you've learned.",
      "- MEMORY.md grows long: grep it for the topic at hand (`grep -n -i \"term\" MEMORY.md`) or use search_memories. Never read it whole."],
  ],
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
  ],
};

export function upgradeDefaultWorkspaceFiles(dir = config.WORKSPACE_DIR) {
  const updated = [];
  for (const [name, swaps] of Object.entries(DEFAULT_UPGRADES)) {
    const file = path.join(dir, name);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    let next = text;
    for (const [from, to] of swaps) if (next.includes(from)) next = next.split(from).join(to);
    if (next === text) continue;
    try {
      fs.writeFileSync(file, next, "utf8");
      cache.delete(name);
      updated.push(name);
    } catch (err) {
      console.warn(`[workspace] could not update ${name}: ${err.message}`);
    }
  }
  if (updated.length) console.log(`[workspace] updated the default memory instructions in ${updated.join(" and ")}: grep MEMORY.md, never read it whole`);
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
