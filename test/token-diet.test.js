// Context cost savers ported from TarseeMacOS: the auto-compact window (src/ai/context-limits.js), the Bash output
// and tarsee_* tool result caps (src/lib/clip-result.js), one-line quick memories (src/db/memory.js), short skill
// descriptions (src/lib/skills-engine.js), and the note on a prompt that waited in its chat's queue.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactWindowEnv, bashOutputEnv, costSaverEnv, DEFAULT_COMPACT_WINDOW } from "../src/ai/context-limits.js";
import { clipToolResult, clipMcpResult, withClippedResults, toolResultMaxChars } from "../src/lib/clip-result.js";
import { clipMemory } from "../src/db/memory.js";
import { shortSkillDescription } from "../src/lib/skills-engine.js";
import { withConversationTurn, takeQueuedNote } from "../src/lib/conversation-lock.js";
import { QUEUED_NOTE, withQueuedNote } from "../src/ai/providers/claude-code.js";

describe("compactWindowEnv: when the CLI summarizes the agent's context", () => {
  it("defaults to 180k so a call re-reads less", () => {
    assert.equal(DEFAULT_COMPACT_WINDOW, 180_000);
    assert.deepEqual(compactWindowEnv(undefined), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" });
    assert.deepEqual(compactWindowEnv(""), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" });
    assert.deepEqual(compactWindowEnv("nonsense"), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" });
  });
  it("takes an override in tokens or k, inside the CLI's 100k to 1M range", () => {
    assert.deepEqual(compactWindowEnv("250000"), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000" });
    assert.deepEqual(compactWindowEnv("150k"), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000" });
    assert.deepEqual(compactWindowEnv("20000"), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" });
    assert.deepEqual(compactWindowEnv("5000000"), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" });
  });
  it("off leaves the CLI's own window", () => {
    assert.deepEqual(compactWindowEnv("off"), {});
    assert.deepEqual(compactWindowEnv(" OFF "), {});
  });
});

describe("Bash output cap: past it the CLI saves the output to a file and shows a preview", () => {
  it("8000 characters by default, TARSEE_BASH_OUTPUT_MAX_CHARS to change it", () => {
    assert.deepEqual(bashOutputEnv({}), { BASH_MAX_OUTPUT_LENGTH: "8000" });
    assert.deepEqual(bashOutputEnv({ TARSEE_BASH_OUTPUT_MAX_CHARS: "20000" }), { BASH_MAX_OUTPUT_LENGTH: "20000" });
  });
  it("a BASH_MAX_OUTPUT_LENGTH the operator already set is kept", () => {
    assert.deepEqual(bashOutputEnv({ BASH_MAX_OUTPUT_LENGTH: "15000" }), {});
    assert.deepEqual(bashOutputEnv({ BASH_MAX_OUTPUT_LENGTH: "15000", TARSEE_BASH_OUTPUT_MAX_CHARS: "9000" }), { BASH_MAX_OUTPUT_LENGTH: "9000" });
  });
  it("every Claude Code process gets both", () => {
    assert.deepEqual(costSaverEnv({}), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000", BASH_MAX_OUTPUT_LENGTH: "8000" });
    assert.deepEqual(costSaverEnv({ TARSEE_COMPACT_WINDOW: "off" }), { BASH_MAX_OUTPUT_LENGTH: "8000" });
  });
});

describe("clipToolResult: a tarsee_* result stays small, the rest goes to a file", () => {
  it("12000 characters by default, TARSEE_TOOL_RESULT_MAX_CHARS to change it", () => {
    assert.equal(toolResultMaxChars({}), 12_000);
    assert.equal(toolResultMaxChars({ TARSEE_TOOL_RESULT_MAX_CHARS: "30000" }), 30_000);
    assert.equal(toolResultMaxChars({ TARSEE_TOOL_RESULT_MAX_CHARS: "12" }), 12_000, "too small to be meant");
  });
  it("leaves a short result alone", () => {
    assert.equal(clipToolResult("list_crons", "3 crons"), "3 crons");
  });
  it("cuts a long one to about the cap and keeps the whole text in a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-test-"));
    const big = Array.from({ length: 3000 }, (_, i) => `cron_${i} every day`).join("\n");
    const out = clipToolResult("list_crons", big, { max: 4000, dir, now: 1 });
    assert.ok(out.length < 4600, `got ${out.length}`);
    assert.ok(out.startsWith("cron_0 every day"));
    assert.ok(out.includes("cron_2999 every day"));
    const file = path.join(dir, "list_crons-1.txt");
    assert.ok(out.includes(JSON.stringify(file)));
    assert.equal(fs.readFileSync(file, "utf8"), big);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("every tool's handler is wrapped; images and short text pass through", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-test-"));
    const res = clipMcpResult("t", { content: [{ type: "image", data: "x".repeat(50_000) }, { type: "text", text: "y".repeat(9000) }] }, { max: 4000, dir });
    assert.equal(res.content[0].data.length, 50_000);
    assert.ok(res.content[1].text.length < 4600);
    const [wrapped] = withClippedResults([{ name: "tarsee_list", description: "d", inputSchema: {}, handler: async () => ({ content: [{ type: "text", text: "z".repeat(20_000) }] }) }]);
    assert.equal(wrapped.name, "tarsee_list");
    const out = await wrapped.handler({}, {});
    assert.ok(out.content[0].text.length < 13_000 && out.content[0].text.includes("characters, cut to keep the context small"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("prompt diet: memories and skills are one short line each", () => {
  it("a long memory becomes one line of at most 300 characters", () => {
    const note = "Meeting notes:\n" + "Sam wants the campaign live by Friday and ".repeat(40);
    const out = clipMemory(note);
    assert.ok(out.length <= 301, `got ${out.length}`);
    assert.ok(!out.includes("\n"));
    assert.ok(out.endsWith("…"));
    assert.equal(clipMemory("Prefers Telegram."), "Prefers Telegram.");
  });
  it("a skill keeps its first sentence, cut at a word near 140 characters", () => {
    assert.equal(shortSkillDescription("Render videos from HTML pages. Use for launch films and reels."), "Render videos from HTML pages.");
    const long = shortSkillDescription("Admin access to the whole estate: " + "container apps, databases, ".repeat(20));
    assert.ok(long.length <= 141 && long.endsWith("…"), long);
    assert.equal(shortSkillDescription(""), "");
  });
});

describe("a prompt that waited in its chat's queue says it is one message", () => {
  it("the note goes on once, never in front of a slash command", () => {
    assert.equal(withQueuedNote("and May?"), QUEUED_NOTE + "and May?");
    assert.equal(withQueuedNote(withQueuedNote("hi")), QUEUED_NOTE + "hi");
    assert.equal(withQueuedNote("/compact"), "/compact");
    assert.equal(withQueuedNote(""), "");
    assert.doesNotMatch(QUEUED_NOTE, /[–—]/, "no long dashes");
  });
  it("only the turn that waited gets it, and only once in its slot", async () => {
    let open;
    const gate = new Promise((r) => { open = r; });
    const seen = [];
    const a = withConversationTurn("note-1", async () => { seen.push(["first", takeQueuedNote()]); await gate; });
    const b = withConversationTurn("note-1", async () => { seen.push(["queued", takeQueuedNote()], ["queued again", takeQueuedNote()]); }, { live: { source: "web", prompt: "x" } });
    const c = withConversationTurn("note-2", async () => { seen.push(["other chat", takeQueuedNote()]); });
    open();
    await Promise.all([a, b, c]);
    await withConversationTurn("note-1", async () => { seen.push(["idle again", takeQueuedNote()]); });
    assert.deepEqual(Object.fromEntries(seen), { first: false, queued: true, "queued again": false, "other chat": false, "idle again": false });
  });
});
