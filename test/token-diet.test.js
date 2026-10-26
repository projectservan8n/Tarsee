// Context cost savers ported from TarseeMacOS: the auto-compact window, the Bash output and tool result caps
// (src/ai/context-limits.js, all three Claude Code's own settings), one-line quick memories (src/db/memory.js), short
// skill descriptions (src/lib/skills-engine.js), and the note on a prompt that waited in its chat's queue.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactWindowEnv, bashOutputEnv, mcpOutputEnv, costSaverEnv, effectiveContextWindow, DEFAULT_COMPACT_WINDOW } from "../src/ai/context-limits.js";
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
});

describe("tool result cap: past it Claude Code saves the result to a file and tells the agent how to read it", () => {
  it("about 12000 characters by default, passed as MAX_MCP_OUTPUT_TOKENS (a token is about 4 characters)", () => {
    assert.deepEqual(mcpOutputEnv({}), { MAX_MCP_OUTPUT_TOKENS: "3000" });
    assert.deepEqual(mcpOutputEnv({ TARSEE_TOOL_RESULT_MAX_CHARS: "30000" }), { MAX_MCP_OUTPUT_TOKENS: "7500" });
    assert.deepEqual(mcpOutputEnv({ TARSEE_TOOL_RESULT_MAX_CHARS: "12" }), { MAX_MCP_OUTPUT_TOKENS: "3000" }, "too small to be meant");
  });
  it("a MAX_MCP_OUTPUT_TOKENS the operator already set is kept", () => {
    assert.deepEqual(mcpOutputEnv({ MAX_MCP_OUTPUT_TOKENS: "10000" }), {});
  });
});

describe("what every Claude Code process gets", () => {
  it("all three caps", () => {
    assert.deepEqual(costSaverEnv({}), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000", BASH_MAX_OUTPUT_LENGTH: "8000", MAX_MCP_OUTPUT_TOKENS: "3000" });
    assert.deepEqual(costSaverEnv({ TARSEE_COMPACT_WINDOW: "off" }), { BASH_MAX_OUTPUT_LENGTH: "8000", MAX_MCP_OUTPUT_TOKENS: "3000" });
  });
  it("an operator's own CLAUDE_CODE_AUTO_COMPACT_WINDOW stands unless TARSEE_COMPACT_WINDOW is set", () => {
    assert.equal(costSaverEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined, "not overridden: process.env carries it");
    assert.equal(costSaverEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000", TARSEE_COMPACT_WINDOW: "200k" }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  });
});

describe("the window the context meter and Token Health measure against", () => {
  it("the compact window when it is smaller than the model's, else the model's", () => {
    assert.equal(effectiveContextWindow(1_000_000, {}), 180_000, "Sonnet/Opus 1M: summarized near 180k");
    assert.equal(effectiveContextWindow(200_000, {}), 180_000);
    assert.equal(effectiveContextWindow(1_000_000, { TARSEE_COMPACT_WINDOW: "off" }), 1_000_000);
    assert.equal(effectiveContextWindow(1_000_000, { TARSEE_COMPACT_WINDOW: "300k" }), 300_000);
    assert.equal(effectiveContextWindow(200_000, { TARSEE_COMPACT_WINDOW: "300k" }), 200_000);
    assert.equal(effectiveContextWindow(1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" }), 400_000, "the operator's own");
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
    const a = withConversationTurn("note-1", async () => { seen.push(["first", takeQueuedNote("note-1")]); await gate; });
    const b = withConversationTurn("note-1", async () => {
      seen.push(["a helper's turn inside it", takeQueuedNote("note-9")], ["no conversation", takeQueuedNote(null)]);
      seen.push(["queued", takeQueuedNote("note-1")], ["queued again", takeQueuedNote("note-1")]);
    }, { live: { source: "web", prompt: "x" } });
    const c = withConversationTurn("note-2", async () => { seen.push(["other chat", takeQueuedNote("note-2")]); });
    open();
    await Promise.all([a, b, c]);
    await withConversationTurn("note-1", async () => { seen.push(["idle again", takeQueuedNote("note-1")]); });
    assert.deepEqual(Object.fromEntries(seen), {
      first: false, "a helper's turn inside it": false, "no conversation": false, queued: true, "queued again": false, "other chat": false, "idle again": false,
    });
  });
});
