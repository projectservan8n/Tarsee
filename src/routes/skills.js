import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import {
  scanSkills,
  getSkillContent,
  getCustomSkillsDir,
  invalidateCache,
} from "../lib/skills-engine.js";

export const skillsRouter = Router();

/**
 * GET / — List all available skills (built-in + custom).
 */
skillsRouter.get("/", (_req, res) => {
  try {
    const skills = scanSkills().map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
    }));
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /:name — Get full content of a skill.
 */
skillsRouter.get("/:name", (req, res) => {
  const skill = getSkillContent(req.params.name);
  if (!skill) {
    return res.status(404).json({ error: "Skill not found" });
  }
  res.json(skill);
});

/**
 * POST / — Create a new custom skill.
 * Body: { name, description, content }
 */
skillsRouter.post("/", (req, res) => {
  const { name, description, content } = req.body;

  if (!name || !content) {
    return res.status(400).json({ error: "Name and content are required" });
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return res.status(400).json({
      error: "Invalid name. Use lowercase letters, numbers, and hyphens only.",
    });
  }

  const customDir = getCustomSkillsDir();
  const skillDir = path.join(customDir, name);

  if (fs.existsSync(skillDir)) {
    return res.status(409).json({ error: "Skill already exists. Use PUT to update." });
  }

  try {
    fs.mkdirSync(skillDir, { recursive: true });

    const md = `---\nname: ${name}\ndescription: ${description || ""}\n---\n\n${content}`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), md, "utf8");

    invalidateCache();
    res.status(201).json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /:name — Update a custom skill.
 * Body: { description?, content? }
 */
skillsRouter.put("/:name", (req, res) => {
  const { name } = req.params;
  const { description, content } = req.body;

  const skillPath = path.join(getCustomSkillsDir(), name, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    return res.status(404).json({ error: "Custom skill not found (built-in skills are read-only)" });
  }

  try {
    const existing = getSkillContent(name);
    const newDesc = description !== undefined ? description : existing?.description || "";
    const newContent = content !== undefined ? content : existing?.content || "";

    const md = `---\nname: ${name}\ndescription: ${newDesc}\n---\n\n${newContent}`;
    fs.writeFileSync(skillPath, md, "utf8");

    invalidateCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /:name — Delete a custom skill.
 */
skillsRouter.delete("/:name", (req, res) => {
  const { name } = req.params;
  const skillDir = path.join(getCustomSkillsDir(), name);

  if (!fs.existsSync(skillDir)) {
    return res.status(404).json({ error: "Skill not found" });
  }

  // Prevent deleting built-in skills
  const skills = scanSkills();
  const skill = skills.find((s) => s.name === name);
  if (skill?.source === "built-in") {
    return res.status(403).json({ error: "Cannot delete built-in skills" });
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    invalidateCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
