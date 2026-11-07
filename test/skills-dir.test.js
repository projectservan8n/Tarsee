// Where Tarsee's bundled skills (src/skills) are found. Both places used new URL(import.meta.url).pathname, which on
// Windows is "/E:/AGENTIC%20SCALE%20AI/...": Settings → Skills answered 500. And the provider joined one ".." too few,
// so the folder it gave Claude Code (src/ai/skills) does not exist anywhere.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-skills-dir-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { BUNDLED_SKILLS_DIR } = await import("../src/ai/providers/claude-code.js");

const db = initDb(path.join(tmp, "tarsee.db"));
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.set("db", db);
  app.use("/api/settings", settingsRouter);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("the bundled skills folder", () => {
  it("Settings → Skills lists the bundled skills", async () => {
    const res = await fetch(`${base}/api/settings/skills-status`);
    assert.equal(res.status, 200, await res.clone().text());
    const { skills } = await res.json();
    assert.ok(skills.length > 0, "some skills listed");
    assert.ok(skills.some((s) => s.name === "diagram"), "the diagram skill is one of them");
  });

  it("the provider hands Claude Code the folder that holds them", () => {
    assert.ok(fs.existsSync(path.join(BUNDLED_SKILLS_DIR, "diagram", "SKILL.md")), BUNDLED_SKILLS_DIR);
  });
});
