import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Cache ---
let cachedSkills = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Parse simple YAML frontmatter from a SKILL.md file.
 * Supports: name, description
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — use first heading as name, first paragraph as description
    const lines = content.split("\n");
    const heading = lines.find((l) => l.startsWith("# "));
    return {
      frontmatter: {
        name: heading ? heading.replace(/^#\s+/, "").trim().toLowerCase().replace(/\s+/g, "-") : "unnamed",
        description: "",
      },
      body: content,
    };
  }

  const yaml = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) frontmatter[key] = val;
  }

  return { frontmatter, body };
}

/**
 * Get the built-in skills directory (ships with Tarsee).
 */
export function getBuiltInSkillsDir() {
  return path.join(__dirname, "..", "skills");
}

/**
 * Get the custom skills directory (user's workspace, persists on volume).
 */
export function getCustomSkillsDir() {
  return path.join(config.WORKSPACE_DIR, "skills");
}

/**
 * Scan a directory for skill folders (folders containing SKILL.md).
 */
function scanDirectory(dir, source) {
  const skills = [];
  try {
    if (!fs.existsSync(dir)) return skills;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const raw = fs.readFileSync(skillMdPath, "utf8");
        const { frontmatter } = parseFrontmatter(raw);

        skills.push({
          name: frontmatter.name || entry.name,
          description: frontmatter.description || "",
          source,
          folder: entry.name,
          path: skillMdPath,
        });
      } catch {
        // Skip corrupted skill files
      }
    }
  } catch {
    // Directory doesn't exist or unreadable
  }

  return skills;
}

/**
 * Scan all skill locations and return a merged list.
 */
export function scanSkills() {
  const now = Date.now();
  if (cachedSkills && now - cacheTime < CACHE_TTL_MS) {
    return cachedSkills;
  }

  const builtIn = scanDirectory(getBuiltInSkillsDir(), "built-in");
  const custom = scanDirectory(getCustomSkillsDir(), "custom");

  // Custom skills override built-in if same name
  const byName = new Map();
  for (const s of builtIn) byName.set(s.name, s);
  for (const s of custom) byName.set(s.name, s);

  cachedSkills = Array.from(byName.values());
  cacheTime = now;
  return cachedSkills;
}

/**
 * Get brief skills list (for prompt injection + UI listing).
 */
export function getSkillsList() {
  return scanSkills().map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source,
  }));
}

/**
 * Get full content of a skill by name.
 */
export function getSkillContent(name) {
  const skills = scanSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;

  try {
    const raw = fs.readFileSync(skill.path, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      content: body,
      frontmatter,
    };
  } catch {
    return null;
  }
}

/**
 * Build the skills context string for system prompt injection.
 * Kept brief to minimize token usage.
 */
export function getSkillsPromptContext() {
  const skills = scanSkills();
  if (skills.length === 0) return "";

  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`);

  return `\n\nYou have these specialized skills available. When a user's request clearly matches a skill, load and follow its instructions:\n${lines.join("\n")}`;
}

/**
 * Invalidate the skills cache (call after CRUD operations).
 */
export function invalidateCache() {
  cachedSkills = null;
  cacheTime = 0;
}
