// Block quotes as Discord draws them (src/lib/discord-format.js formatQuotesForDiscord), and the Discord channel's
// reply paths going through the formatter (displayForDiscord, the fence-safe split).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatQuotesForDiscord, formatForDiscord, DISCORD_EMPTY_QUOTE_LINE as E } from "../src/lib/discord-format.js";

// src/channels/discord.js loads the app's config, which seeds a workspace: keep it in a folder of its own.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-discord-format-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
const { displayForDiscord } = await import("../src/channels/discord.js");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a bare > between quoted paragraphs becomes an empty quoted line, not a literal >", () => {
  const md = "Here it is:\n\n> Hi Sam, here's the plan.\n>\n> I'll finish the user guide.\n>\n> Can we do a handover call today?\n\nOne change from your draft.";
  assert.equal(formatQuotesForDiscord(md), `Here it is:\n\n> Hi Sam, here's the plan.\n${E}\n> I'll finish the user guide.\n${E}\n> Can we do a handover call today?\n\nOne change from your draft.`);
});

test("several bare lines in a row give one empty quoted line", () => {
  assert.equal(formatQuotesForDiscord("> a\n>\n>  \n> b"), `> a\n${E}\n> b`);
});

test("bare > at the start or end of a quote is dropped", () => {
  assert.equal(formatQuotesForDiscord(">\n> a\n> b\n>\n\nafter"), "> a\n> b\n\nafter");
});

test(">text gets its missing space; >>> and lone > away from quotes are left alone", () => {
  assert.equal(formatQuotesForDiscord(">tight\n> spaced"), "> tight\n> spaced");
  assert.equal(formatQuotesForDiscord(">>> whole rest\nof the message"), ">>> whole rest\nof the message");
  assert.equal(formatQuotesForDiscord("a > b\n>\nplain"), "a > b\n>\nplain");
});

test("code fences are never touched", () => {
  const md = "```\n> a\n>\n> b\n```";
  assert.equal(formatQuotesForDiscord(md), md);
});

test("idempotent, and the empty quoted line has no long dash or visible text", () => {
  const md = "> a\n>\n> b";
  const once = formatQuotesForDiscord(md);
  assert.equal(formatQuotesForDiscord(once), once);
  assert.equal(E.replace(/[>\s\u200b]/g, ""), "");
  assert.ok(!E.includes("\u2014"));
});

test("formatForDiscord and displayForDiscord apply it with tables", () => {
  const md = "> one\n>\n> two\n\n| a | b |\n|---|---|\n| 1 | 2 |";
  assert.ok(formatForDiscord(md).startsWith(`> one\n${E}\n> two`));
  assert.ok(displayForDiscord(md).startsWith(`> one\n${E}\n> two`));
  assert.ok(!/^>$/m.test(displayForDiscord(md)));
  assert.ok(displayForDiscord(md).includes("```"), "the narrow table is drawn as a fenced grid");
  assert.ok(!/^\| a \| b \|$/m.test(displayForDiscord(md)), "no raw pipes left");
});

test("displayForDiscord takes the reaction markers and tool-call records out", () => {
  const raw = "Done [react: ✅]\n\n\n\n<tool_call>{\"x\":1}</tool_call>Next";
  assert.ok(!displayForDiscord(raw).includes("[react:"));
  assert.ok(!displayForDiscord(raw).includes("tool_call"));
  assert.ok(!/\n{3,}/.test(displayForDiscord(raw)));
});
