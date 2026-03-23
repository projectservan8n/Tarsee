import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";

/**
 * Workspace file reader/writer with caching.
 * Reads SOUL.md, USER.md, MEMORY.md and daily logs from WORKSPACE_DIR.
 * Files ARE the memory — the bot reads its identity from disk every time.
 */

const CACHE_TTL_MS = 5000; // 5 seconds
const cache = new Map(); // filename → { content, timestamp }

/**
 * Read a workspace file with 5s cache.
 * @param {string} filename - e.g. "SOUL.md", "USER.md", "MEMORY.md"
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
 * Get the full bootstrap context: SOUL.md + USER.md + MEMORY.md combined.
 * This is injected into every system prompt.
 * @returns {string}
 */
export function getBootstrapContext() {
  const soul = readWorkspaceFile("SOUL.md");
  const user = readWorkspaceFile("USER.md");
  const memory = readWorkspaceFile("MEMORY.md");

  let context = "";

  if (soul) {
    context += soul;
  }

  if (user) {
    context += (context ? "\n\n" : "") + user;
  }

  if (memory) {
    context += (context ? "\n\n" : "") + memory;
  }

  return context;
}

/**
 * Invalidate all cached files.
 */
export function invalidateCache() {
  cache.clear();
}
