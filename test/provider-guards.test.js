// Phase 6's guard rails (design 7): the provider-neutral shape stays that way.
//   - No new ai.claude-code.* setting keys outside the registry: the Claude plan's settings are reached through its
//     storageId (provider-registry.js), so every provider's settings are read the same way. (db/settings.js keeps the
//     one boot fixup that deletes the old setup wizard's fake "subscription" key, by its literal name.)
//   - No provider: "claude-code" literals: the public id is "claude"; "claude-code" is only an accepted alias.
//   - The engines (src/ai/providers/*) are loaded only by the turn layer (turn.js) and the router: everything else
//     goes through runTurn, so no caller can bypass its refusals, budgets, sessions and failure flags.
//   - Every turn's caller passes the prompt in its two parts (buildSystemPromptParts), never one joined string.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...sourceFiles(p)); }
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = sourceFiles(SRC).map((file) => ({ file, rel: path.relative(ROOT, file).split(path.sep).join("/"), text: fs.readFileSync(file, "utf8") }));
/** Each line of `files` the rule matches, as "file:line": outside the `allowed` files, and not a line allowLine excuses. */
const scan = (files, re, allowed, allowLine = () => false) => files.filter((f) => !allowed.includes(f.rel)).flatMap((f) => f.text.split(/\r?\n/).map((line, i) => ({ line, i })).filter(({ line }) => re.test(line) && !allowLine(f.rel, line)).map(({ i }) => `${f.rel}:${i + 1}`));
const hits = (re, allowed, allowLine) => scan(FILES, re, allowed, allowLine);
const SETTING_KEY = /["'`]ai\.claude-code\./;
/** A call or import of the one-string prompt builder (buildSystemPromptParts is the one to use). */
const JOINED_PROMPT = /\bbuildSystemPrompt\s*\(|\{[^}]*\bbuildSystemPrompt\b(?!Parts)[^}]*\}\s*from/;
/** The one ai.claude-code.* literal outside the registry: the boot fixup's slot name, that line of src/db/settings.js only. */
const BOOT_FIXUP_LINE = (rel, line) => rel === "src/db/settings.js" && line.trim() === 'const FAKE_SUBSCRIPTION_SLOT = "ai.claude-code.apiKey";';

describe("provider guard rails (Phase 6)", () => {
  it("found the source tree", () => {
    assert.ok(FILES.length > 100, `${FILES.length} files`);
    assert.ok(FILES.some((f) => f.rel === "src/ai/turn.js"));
  });

  it("no ai.claude-code.* setting key outside the registry (and the one boot fixup)", () => {
    assert.deepEqual(hits(SETTING_KEY, ["src/ai/provider-registry.js"], BOOT_FIXUP_LINE), []);
  });

  it("no provider: \"claude-code\" literal: the Claude plan's id is claude", () => {
    assert.deepEqual(hits(/\bprovider(?:Id)?\s*:\s*["']claude-code["']/, []), []);
  });

  it("the engines are loaded only by the turn layer and the router", () => {
    const engine = /(?:from\s+|import\()\s*["'][^"']*\/providers\/(?:claude-code|codex|codex-options|codex-events)\.js["']/;
    const allowed = ["src/ai/turn.js", "src/ai/router.js", ...FILES.filter((f) => f.rel.startsWith("src/ai/providers/")).map((f) => f.rel)];
    assert.deepEqual(hits(engine, allowed), []);
  });

  it("every turn's caller passes the prompt in its two parts: nothing in src joins them with buildSystemPrompt", () => {
    // Codex keeps the stable part as a thread's instructions and gets the volatile part with each message (design 4.6
    // g); a caller that joined them restarted its channel's thread whenever today's log changed.
    assert.deepEqual(hits(JOINED_PROMPT, ["src/lib/build-system-prompt.js"]), []);
  });

  it("each rule catches what it is for", () => {
    assert.ok(JOINED_PROMPT.test("    const systemPrompt = buildSystemPrompt({"));
    assert.ok(JOINED_PROMPT.test('import { buildSystemPrompt, sendFileHint } from "../lib/build-system-prompt.js";'));
    assert.equal(JOINED_PROMPT.test("const systemParts = buildSystemPromptParts({"), false);
    assert.equal(JOINED_PROMPT.test(" * next session's buildSystemPrompt picks it up via readAndArchiveCheckpoint."), false, "a comment naming it is fine");
    assert.ok(SETTING_KEY.test("store.get(\"ai.claude-code.model\")"));
    // The boot fixup's excuse is that one line in that one file: a second key in settings.js is still caught.
    const planted = [{ rel: "src/db/settings.js", text: 'const FAKE_SUBSCRIPTION_SLOT = "ai.claude-code.apiKey";\r\nthis.get("ai.claude-code.model");\r\n' }];
    assert.deepEqual(scan(planted, SETTING_KEY, ["src/ai/provider-registry.js"], BOOT_FIXUP_LINE), ["src/db/settings.js:2"]);
    assert.equal(BOOT_FIXUP_LINE("src/db/settings.js", 'this.get("ai.claude-code.model");'), false);
    assert.equal(BOOT_FIXUP_LINE("src/db/settings.js", 'const FAKE_SUBSCRIPTION_SLOT = "ai.claude-code.model";'), false);
    assert.equal(BOOT_FIXUP_LINE("src/lib/other.js", 'const FAKE_SUBSCRIPTION_SLOT = "ai.claude-code.apiKey";'), false);
    assert.equal(BOOT_FIXUP_LINE("src/db/settings.js", 'const FAKE_SUBSCRIPTION_SLOT = "ai.claude-code.apiKey";'), true);
    assert.ok(/\bprovider(?:Id)?\s*:\s*["']claude-code["']/.test("chatStream({ provider: 'claude-code' })"));
    assert.ok(/(?:from\s+|import\()\s*["'][^"']*\/providers\/(?:claude-code|codex|codex-options|codex-events)\.js["']/.test("const m = await import(\"../ai/providers/codex.js\");"));
  });
});
