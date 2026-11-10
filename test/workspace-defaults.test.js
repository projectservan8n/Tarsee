// The workspace files a new install is seeded with (src/workspace-defaults, copied by entrypoint.sh) work on any AI
// (docs/superpowers/specs/2026-11-09-multi-provider-design.md 4.16, Phase 5 "Docs and defaults"): no "powered by
// Claude", no tool names only Claude Code has (Bash, Read/Write/Edit/Grep/Glob, mcp__tarsee__*), no Claude model names
// for the agent team. An install seeded with the Claude-only wording keeps its own files: on boot only the exact old
// default lines are swapped for the new ones (lib/workspace-files.js upgradeDefaultWorkspaceFiles), so an unedited file
// becomes the new default exactly and a line the owner changed is left alone.
// Line endings are made LF before comparing: a checkout on Windows turns these files to CRLF, a server never does.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-workspace-defaults-"));
process.env.TARSEE_STATE_DIR = tmp;
const { upgradeDefaultWorkspaceFiles } = await import("../src/lib/workspace-files.js");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = path.join(HERE, "..", "src", "workspace-defaults");
const FIXTURES = path.join(HERE, "fixtures");
const lf = (s) => s.replace(/\r\n/g, "\n");
const readLf = (file) => lf(fs.readFileSync(file, "utf8"));
const quiet = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};
/** A workspace holding these fixtures (LF) under their real names. */
function workspaceFrom(name, files) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
  for (const [real, fixture] of Object.entries(files)) fs.writeFileSync(path.join(dir, real), readLf(path.join(FIXTURES, fixture)));
  return dir;
}

/** No single AI, no tool name only Claude Code has, no Claude model name. */
function assertNeutral(text, what) {
  assert.doesNotMatch(text, /powered by/i, what);
  assert.doesNotMatch(text, /\bClaude\b/, `${what}: no Claude (the file name CLAUDE.md aside)`);
  assert.doesNotMatch(text, /mcp__/, `${what}: Codex names Tarsee's tools differently: say tarsee_*`);
  assert.doesNotMatch(text, /\bBash\b/, `${what}: say the shell`);
  assert.doesNotMatch(text, /Read, Write, Edit|\bGrep, Glob\b/, what);
  assert.doesNotMatch(text, /\b(Opus|Sonnet|Haiku|Fable)\b/, `${what}: no Claude model names`);
}

describe("the default workspace files work on any AI", () => {
  const files = fs.readdirSync(DEFAULTS).filter((f) => f.endsWith(".md"));
  it("the seeded set is the one entrypoint.sh copies", () => {
    const seeded = /for f in ((?:[A-Z]+\.md\s*)+); do/.exec(fs.readFileSync(path.join(HERE, "..", "entrypoint.sh"), "utf8"))?.[1].trim().split(/\s+/).sort();
    assert.deepEqual(seeded, [...files].sort());
  });
  for (const f of files) {
    it(`${f} names no single AI or its tools`, () => {
      assertNeutral(fs.readFileSync(path.join(DEFAULTS, f), "utf8"), f);
    });
  }
  it("so do the ones an install without the image starts with (config/env.js writes them on first boot)", () => {
    const ws = path.join(tmp, "workspace");
    const seeded = fs.readdirSync(ws).filter((f) => f.endsWith(".md"));
    assert.ok(seeded.includes("SOUL.md") && seeded.includes("TOOLS.md"), seeded.join(", "));
    for (const f of seeded) assertNeutral(fs.readFileSync(path.join(ws, f), "utf8"), `env.js ${f}`);
  });
  it("SOUL.md still says what the agent can do and to use Tarsee's own tools for platform actions", () => {
    const soul = fs.readFileSync(path.join(DEFAULTS, "SOUL.md"), "utf8");
    assert.match(soul, /You are \*\*Tarsee\*\*/);
    assert.match(soul, /run any command/);
    assert.match(soul, /tarsee_\* tools/);
    assert.match(soul, /grep/i);
  });
  it("SOUL.md says to offer a follow-up and schedule it only once the owner says yes (every run can be a paid turn)", () => {
    const soul = fs.readFileSync(path.join(DEFAULTS, "SOUL.md"), "utf8");
    assert.ok(soul.includes("If a task needs a follow-up, offer to schedule it, and schedule it only once the owner says yes."), soul);
    assert.doesNotMatch(soul, /If a task needs a follow-up, schedule it\./);
  });
});

describe("an install seeded with the SOUL.md from before scheduled tasks waited for the owner", () => {
  it("gets the new follow-up line, and nothing else changes, once", () => {
    const dir = workspaceFrom("before-owner-ok", { "SOUL.md": "before-owner-ok-default-SOUL.md" });
    const old = readLf(path.join(dir, "SOUL.md"));
    assert.deepEqual(quiet(() => upgradeDefaultWorkspaceFiles(dir)), ["SOUL.md"]);
    const now = readLf(path.join(dir, "SOUL.md"));
    assert.equal(now, readLf(path.join(DEFAULTS, "SOUL.md")));
    const changed = now.split("\n").filter((line, i) => line !== old.split("\n")[i]);
    assert.deepEqual(changed, ["- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, offer to schedule it, and schedule it only once the owner says yes."]);
    assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), [], "a second boot changes nothing");
  });
  it("keeps the line when the owner wrote their own", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "own-follow-up-"));
    const own = "# Soul\n- You are proactive. If a task needs a follow-up, schedule it without asking, my rule.\n";
    fs.writeFileSync(path.join(dir, "SOUL.md"), own);
    assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), []);
    assert.equal(fs.readFileSync(path.join(dir, "SOUL.md"), "utf8"), own);
  });

  // Only a whole line that is the old default changes. A line the owner added words to, before or after it, is theirs:
  // swapping the old words inside it would leave "...offer to schedule it, and schedule it only once the owner says
  // yes. Don't ask me first, just do it.", a rule that says both things.
  const OLD_FOLLOW_UP = "- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, schedule it.";
  const NEW_FOLLOW_UP = "- You are proactive. If you notice something useful, mention it. If a task needs a follow-up, offer to schedule it, and schedule it only once the owner says yes.";
  for (const [ending, eol] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
    it(`keeps a line the owner added to, after or before the old words (${ending})`, () => {
      for (const line of [`${OLD_FOLLOW_UP} Don't ask me first, just do it.`, `My rule, not a default: ${OLD_FOLLOW_UP}`]) {
        const dir = fs.mkdtempSync(path.join(tmp, `extended-follow-up-${ending}-`));
        for (const own of [["# Soul", line, "- Keep it short.", ""].join(eol), ["# Soul", line].join(eol)]) {
          fs.writeFileSync(path.join(dir, "SOUL.md"), own);
          assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), [], line);
          assert.equal(fs.readFileSync(path.join(dir, "SOUL.md"), "utf8"), own, line);
        }
      }
    });
    it(`upgrades the old line when it is the whole line, keeps the file's ${ending} endings, and only once`, () => {
      const dir = fs.mkdtempSync(path.join(tmp, `exact-follow-up-${ending}-`));
      // In the middle of the file, and as its last line with no line ending after it.
      for (const [before, after] of [[["# Soul", OLD_FOLLOW_UP, "- Keep it short.", ""], ["# Soul", NEW_FOLLOW_UP, "- Keep it short.", ""]], [["# Soul", OLD_FOLLOW_UP], ["# Soul", NEW_FOLLOW_UP]]]) {
        fs.writeFileSync(path.join(dir, "SOUL.md"), before.join(eol));
        assert.deepEqual(quiet(() => upgradeDefaultWorkspaceFiles(dir)), ["SOUL.md"]);
        assert.equal(fs.readFileSync(path.join(dir, "SOUL.md"), "utf8"), after.join(eol));
        assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), [], "a second boot changes nothing");
      }
    });
  }
});

describe("every old default line is swapped only as a whole line", () => {
  // test/fixtures/<seed>-<name>: every generation of default an install was seeded with.
  const SEEDED = {
    "claude-only-default": ["SOUL.md", "CLAUDE.md", "AGENTS.md", "MEMORY.md", "TOOLS.md"],
    "old-default": ["SOUL.md", "CLAUDE.md"],
    "before-owner-ok-default": ["SOUL.md"],
  };
  it("a line the owner added words to stays as they wrote it, in every file an install was ever seeded with", () => {
    for (const [seed, names] of Object.entries(SEEDED)) {
      const dir = fs.mkdtempSync(path.join(tmp, `owner-words-${seed}-`));
      const own = {};
      for (const n of names) {
        own[n] = readLf(path.join(FIXTURES, `${seed}-${n}`)).split("\n").map((l) => (l.trim() ? `${l} (my words)` : l)).join("\n");
        fs.writeFileSync(path.join(dir, n), own[n]);
      }
      assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), [], seed);
      for (const n of names) assert.equal(fs.readFileSync(path.join(dir, n), "utf8"), own[n], `${seed} ${n}`);
    }
  });
  it("an unedited file saved with Windows line endings (CRLF) becomes the new default exactly, still CRLF, once", () => {
    for (const [seed, names] of Object.entries(SEEDED)) {
      const dir = fs.mkdtempSync(path.join(tmp, `crlf-${seed}-`));
      for (const n of names) fs.writeFileSync(path.join(dir, n), readLf(path.join(FIXTURES, `${seed}-${n}`)).replace(/\n/g, "\r\n"));
      assert.deepEqual(quiet(() => upgradeDefaultWorkspaceFiles(dir)).sort(), [...names].sort(), seed);
      for (const n of names) assert.equal(fs.readFileSync(path.join(dir, n), "utf8"), readLf(path.join(DEFAULTS, n)).replace(/\n/g, "\r\n"), `${seed} ${n}`);
      assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), [], `${seed}: a second boot changes nothing`);
    }
  });
});

describe("an install seeded with the Claude-only defaults", () => {
  it("gets the new wording: each unedited file becomes the new default exactly, once", () => {
    const names = ["SOUL.md", "CLAUDE.md", "AGENTS.md", "MEMORY.md", "TOOLS.md"];
    const dir = workspaceFrom("claude-only", Object.fromEntries(names.map((n) => [n, `claude-only-default-${n}`])));
    assert.deepEqual(quiet(() => upgradeDefaultWorkspaceFiles(dir)).sort(), [...names].sort());
    for (const n of names) assert.equal(readLf(path.join(dir, n)), readLf(path.join(DEFAULTS, n)), n);
    assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), [], "a second boot changes nothing");
  });
  it("the first default SOUL.md (from before the memory and file changes) also becomes today's", () => {
    const dir = workspaceFrom("first", { "SOUL.md": "old-default-SOUL.md" });
    assert.deepEqual(quiet(() => upgradeDefaultWorkspaceFiles(dir)), ["SOUL.md"]);
    assert.equal(readLf(path.join(dir, "SOUL.md")), readLf(path.join(DEFAULTS, "SOUL.md")));
  });
  it("keeps a file the owner wrote, Claude and all", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "own-"));
    const own = {
      "SOUL.md": "# Soul\n\nYou are **Tarsee** — my agent, powered by Claude, and proud of it.\n- Use Bash for everything.\n",
      "AGENTS.md": "# Agent Team\n- **Coder** (Opus) — only the hard stuff, my rule.\n",
    };
    for (const [n, t] of Object.entries(own)) fs.writeFileSync(path.join(dir, n), t);
    assert.deepEqual(upgradeDefaultWorkspaceFiles(dir), []);
    for (const [n, t] of Object.entries(own)) assert.equal(fs.readFileSync(path.join(dir, n), "utf8"), t);
  });
  it("swaps only the default lines in a file the owner added to", () => {
    const dir = workspaceFrom("added", { "SOUL.md": "claude-only-default-SOUL.md" });
    fs.appendFileSync(path.join(dir, "SOUL.md"), "- Always answer in haiku form on Fridays.\n");
    assert.deepEqual(quiet(() => upgradeDefaultWorkspaceFiles(dir)), ["SOUL.md"]);
    const text = fs.readFileSync(path.join(dir, "SOUL.md"), "utf8");
    assert.ok(text.endsWith("- Always answer in haiku form on Fridays.\n"), "the owner's line stays");
    assert.doesNotMatch(text, /powered by Claude|mcp__|Bash/);
  });
});
