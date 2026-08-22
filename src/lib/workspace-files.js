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
 * Truncate content to a max size with 70% head + 20% tail strategy.
 * @param {string} content
 * @param {number} maxBytes - Default 20KB
 * @returns {string}
 */
function truncateContent(content, maxBytes = 8 * 1024) {
  if (!content || Buffer.byteLength(content, "utf8") <= maxBytes) return content;

  const headSize = Math.floor(maxBytes * 0.7);
  const tailSize = Math.floor(maxBytes * 0.2);

  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);
  return `${head}\n\n... [truncated — file too large] ...\n\n${tail}`;
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
    const raw = readWorkspaceFile(name);
    if (!raw || raw.trim().length < 5) continue;
    const content = truncateContent(raw);
    sections.push(`<!-- ${label} (${name}) -->\n${content}`);
  }

  return sections.join("\n\n");
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
