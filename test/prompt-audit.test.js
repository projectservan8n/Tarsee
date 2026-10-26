// The system prompt's workspace files (src/lib/workspace-files.js, src/lib/skills-engine.js), ported from
// TarseeMacOS: a file up to 12KB reaches the agent whole (an AGENTS.md of 16KB used to lose its middle, silently,
// under the old 8KB cap), a longer one is cut and the cut is logged, MEMORY.md is a pointer to grep, never inlined,
// and the skills list says where the skill folders really are.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-prompt-audit-"));
process.env.TARSEE_STATE_DIR = tmp;
const ws = path.join(tmp, "workspace");
fs.mkdirSync(path.join(ws, "skills", "canvas-db"), { recursive: true });
fs.writeFileSync(path.join(ws, "skills", "canvas-db", "SKILL.md"), "---\nname: canvas-db\ndescription: Every canvas has its own SQLite database. It survives redeploys.\n---\nbody\n");
fs.mkdirSync(path.join(ws, "skills", "gmail-helper"), { recursive: true });
fs.writeFileSync(path.join(ws, "skills", "gmail-helper", "SKILL.md"), "---\nname: Gmail Helper\ndescription: Read and send Gmail with the stored app password.\n---\nbody\n");

const { getBootstrapContext, invalidateCache, truncateContent, upgradeDefaultWorkspaceFiles, WORKSPACE_FILE_MAX_BYTES } = await import("../src/lib/workspace-files.js");
const { getSkillsPromptContext, getCustomSkillsDir, getBuiltInSkillsDir } = await import("../src/lib/skills-engine.js");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const rules = (bytes) => {
  const lines = [];
  for (let i = 0; lines.join("\n").length < bytes; i++) lines.push(`- rule ${i}: say it plainly and keep it.`);
  return `# Agent Rules\n${lines.join("\n")}\n- LAST RULE\n`;
};

describe("workspace files in the system prompt", () => {
  it("an 11KB AGENTS.md reaches the agent whole", () => {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), rules(11 * 1024));
    invalidateCache();
    const ctx = getBootstrapContext();
    assert.equal(WORKSPACE_FILE_MAX_BYTES, 12 * 1024);
    assert.ok(ctx.includes("- rule 150:") && ctx.includes("- LAST RULE"));
    assert.ok(!ctx.includes("[truncated"));
  });
  it("a longer one loses its middle, and the cut is logged once", () => {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), rules(20 * 1024));
    invalidateCache();
    const warned = [];
    const orig = console.warn;
    console.warn = (m) => warned.push(String(m));
    try {
      const ctx = getBootstrapContext();
      getBootstrapContext();
      assert.ok(ctx.includes("[truncated") && ctx.includes("- LAST RULE"));
      assert.equal(warned.filter((w) => w.includes("AGENTS.md is 20KB")).length, 1, warned.join("\n"));
    } finally { console.warn = orig; }
  });
  it("MEMORY.md is a pointer that says grep it, by its full path, never inlined", () => {
    fs.writeFileSync(path.join(ws, "MEMORY.md"), "# Long-Term Memory\n- a fact only grep should find\n");
    invalidateCache();
    const ctx = getBootstrapContext();
    assert.ok(ctx.includes("Grep it for the topic you need"));
    assert.ok(ctx.includes("never read it whole"));
    assert.ok(ctx.includes(`grep -n -i "term" "${path.join(ws, "MEMORY.md")}"`), "absolute: the agent's working folder can be another one");
    assert.ok(!ctx.includes("a fact only grep should find"));
  });
  it("a file in a language of 3-byte characters is cut by bytes, whole characters, never longer than it was", () => {
    const zh = "\u4f60\u597d\u4e16\u754c".repeat(1300) + "END";   // 15.6KB in 5,203 characters
    const out = truncateContent(zh, 12 * 1024);
    assert.ok(Buffer.byteLength(out, "utf8") <= 12 * 1024, `got ${Buffer.byteLength(out, "utf8")} bytes`);
    assert.ok(out.length < zh.length, "shorter, not the whole file plus a repeated tail");
    assert.equal(out.split("END").length - 1, 1);
    const emoji = "\u{1F600}".repeat(4000);
    assert.doesNotMatch(truncateContent(emoji, 1024), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no half of an emoji");
  });
  it("the default workspace files say the same: grep MEMORY.md, never read it whole", () => {
    const defaults = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "workspace-defaults");
    for (const f of ["SOUL.md", "CLAUDE.md"]) {
      const text = fs.readFileSync(path.join(defaults, f), "utf8");
      assert.match(text, /grep/i, f);
      assert.doesNotMatch(text, /read MEMORY\.md at the start|Read it every session|On Every Session Start/i, f);
    }
  });
});

describe("the skills list", () => {
  it("names the skill folders where they are, each with a short description", () => {
    const s = getSkillsPromptContext();
    assert.ok(s.includes(`cat "${getCustomSkillsDir()}/{folder}/SKILL.md"`) && s.includes(`cat "${getBuiltInSkillsDir()}/{folder}/SKILL.md"`));
    assert.ok(s.includes("- **canvas-db**: Every canvas has its own SQLite database."));
    assert.ok(!s.includes("It survives redeploys."), "the first sentence only");
  });
  it("a skill that names itself differently from its folder shows the folder", () => {
    assert.ok(getSkillsPromptContext().includes("- **Gmail Helper** (folder `gmail-helper`): Read and send Gmail with the stored app password."));
  });
});

describe("an install seeded with the old default files", () => {
  const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
  const defaults = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "workspace-defaults");
  it("gets the new memory instructions: the old default SOUL.md and CLAUDE.md become the new ones exactly", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "old-ws-"));
    for (const f of ["SOUL.md", "CLAUDE.md"]) fs.copyFileSync(path.join(fixtures, `old-default-${f}`), path.join(dir, f));
    const logs = [];
    const orig = console.log;
    console.log = (m) => logs.push(String(m));
    try { assert.deepEqual(upgradeDefaultWorkspaceFiles(dir).sort(), ["CLAUDE.md", "SOUL.md"]); } finally { console.log = orig; }
    for (const f of ["SOUL.md", "CLAUDE.md"]) assert.equal(fs.readFileSync(path.join(dir, f), "utf8"), fs.readFileSync(path.join(defaults, f), "utf8"), f);
    assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), [], "once");
  });
  it("leaves a line the owner changed alone", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "own-ws-"));
    const own = "# Soul\n- Always read MEMORY.md at the start of a session, every time, my rule.\n";
    fs.writeFileSync(path.join(dir, "SOUL.md"), own);
    assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), []);
    assert.equal(fs.readFileSync(path.join(dir, "SOUL.md"), "utf8"), own);
  });
});
