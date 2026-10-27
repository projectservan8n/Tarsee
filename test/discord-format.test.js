// Discord formatting (src/lib/discord-format.js, ported from TarseeMacOS): markdown tables drawn as a fenced grid when
// narrow or as label-value lines when wide, fences left alone, and a splitter that never leaves a fence unbalanced.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatTablesForDiscord,
  splitMessageFenceSafe,
  displayWidth,
  parseMdTables,
  toAsciiGrid,
  MAX_GRID_WIDTH,
} from "../src/lib/discord-format.js";

// displayWidth
test("ascii is 1 col each", () => assert.equal(displayWidth("abc"), 3));
test("CJK is 2 cols", () => assert.equal(displayWidth("日本語"), 6));
test("emoji is 2 cols (length is 2)", () => {
  assert.equal("😀".length, 2);
  assert.equal(displayWidth("😀"), 2);
});
test("skin-tone modifier adds nothing", () => assert.equal(displayWidth("👍🏽"), 2));
test("ZWJ family is 2 cols, not 11", () => {
  assert.equal("👨‍👩‍👧".length, 8);
  assert.equal(displayWidth("👨‍👩‍👧"), 2);
});
test("VS16 promotes ambiguous glyph to 2", () => assert.equal(displayWidth("✅"), 2));
test("arrows and em dash stay narrow", () => assert.equal(displayWidth("→\u2014·"), 3));

// Edge case 2: never touch tables inside a fence
test("fenced table is byte-identical", () => {
  const src = "before\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nafter";
  assert.equal(formatTablesForDiscord(src), src);
});
test("tilde fence also protected", () => {
  const src = "~~~md\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~";
  assert.equal(formatTablesForDiscord(src), src);
});
test("unterminated fence swallows the rest", () => {
  const src = "```\n| a | b |\n|---|---|\n| 1 | 2 |";
  assert.equal(formatTablesForDiscord(src), src);
});
test("table outside a fence still transformed when a fence exists earlier", () => {
  const src = "```js\nconst x=1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";
  const out = formatTablesForDiscord(src);
  assert.ok(out.startsWith("```js\nconst x=1;\n```"), "leading fence preserved");
  assert.ok(!/^\| a \| b \|$/m.test(out), "table was rewritten");
});

// Edge case 3: escaped pipes
test("\\| does not split a column", () => {
  const [tbl] = parseMdTables("| a | b |\n|---|---|\n| x \\| y | z |");
  assert.deepEqual(tbl.rows[0], ["x \\| y", "z"]);
});
test("grid mode unescapes (a fence renders literally, a backslash would SHOW)", () => {
  const out = formatTablesForDiscord("| a | b |\n|---|---|\n| x \\| y | z |");
  assert.ok(out.includes("x | y"), out);
  assert.ok(!out.includes("\\|"), "backslash must not survive into the fence");
});
test("list mode keeps \\| escaped (bare || would become a spoiler)", () => {
  const wide = "| Name | Note |\n|---|---|\n| " + "w".repeat(45) + " | a \\|\\| b |";
  const out = formatTablesForDiscord(wide);
  assert.ok(out.includes("\\|\\|"), out);
});

// Edge case 4: ragged rows never throw
test("short row is padded", () => {
  const out = formatTablesForDiscord("| a | b | c |\n|---|---|---|\n| 1 |");
  assert.ok(out.includes("```"), out);
});
test("long row is kept, not dropped", () => {
  const out = formatTablesForDiscord("| a | b |\n|---|---|\n| 1 | 2 | 3 |");
  assert.ok(out.includes("3"), "extra cell survives as an extra column");
});
test("header + separator with zero rows does not throw", () => {
  const out = formatTablesForDiscord("| a | b |\n|---|---|");
  assert.ok(typeof out === "string");
});
test("empty string / non-string are safe", () => {
  assert.equal(formatTablesForDiscord(""), "");
  assert.equal(formatTablesForDiscord(null), null);
});

// Edge case 5: alignment separator rows
test("| :--- | ---: | :-: | is consumed and respected", () => {
  const out = formatTablesForDiscord(
    "| L | R | C |\n|:---|---:|:-:|\n| a | b | c |\n| aaaa | bbbb | cccc |"
  );
  assert.ok(!out.includes(":---"), "separator row must not survive");
  const body = out.split("\n");
  assert.ok(body.some(l => /^R\s|\sR$| {3}R/.test(l) || l.includes("   R")), out);
});
test("separator row is not mistaken for a data row", () => {
  const [tbl] = parseMdTables("| a | b |\n| :-- | --: |\n| 1 | 2 |");
  assert.equal(tbl.rows.length, 1);
  assert.deepEqual(tbl.aligns, ["left", "right"]);
});

// Edge case 1: inline markdown inside cells
test("grid mode strips **bold**, `code`, *em*: they render literally in a fence", () => {
  const out = formatTablesForDiscord(
    "| Task | State |\n|---|---|\n| **Deploy** | `done` |\n| *Audit* | ~~cut~~ |"
  );
  assert.ok(!/\*\*|`code`|~~/.test(out.replace(/```/g, "")), out);
  assert.ok(out.includes("Deploy"), out);
});
test("grid column width is measured AFTER stripping (the old padding bug)", () => {
  const { lines } = toAsciiGrid(["h", "k"], [null, null], [["**xx**", "1"], ["y", "2"]]);
  // "**xx**".length is 6; stripped it is 2 -> the column must be 2 wide, so
  // the second column starts at index 4 ("xx" + 2-space gap).
  assert.equal(lines[0], "h   k");
  assert.equal(lines[2], "xx  1");
  assert.equal(lines[3], "y   2");
});
test("snake_case survives the italic stripper", () => {
  const out = formatTablesForDiscord("| Col | T |\n|---|---|\n| user_id_v2 | int |\n| _em_ | x |");
  assert.ok(out.includes("user_id_v2"), out);
  assert.ok(/^em\b/m.test(out), "real _italics_ still stripped: " + out);
});
test("list mode preserves bold inside cells", () => {
  const out = formatTablesForDiscord(
    "| Day | Note |\n|---|---|\n| Mon | **" + "x".repeat(40) + "** |"
  );
  assert.ok(out.includes("**" + "x".repeat(40) + "**"), out);
});

// Edge case 6: emoji / CJK padding
test("emoji column stays aligned", () => {
  const out = formatTablesForDiscord("| S | N |\n|---|---|\n| ✅ | ok |\n| ab | no |");
  const rows = out.split("\n").filter(l => /ok|no/.test(l));
  assert.equal(displayWidth(rows[0].split("  ")[0]), displayWidth(rows[1].split("  ")[0]));
});
test("CJK column stays aligned", () => {
  const out = formatTablesForDiscord("| K | N |\n|---|---|\n| 日本 | a |\n| abcd | b |");
  const lines = out.split("\n").filter(l => /\ba\b|\bb\b/.test(l));
  const col0 = lines.map(l => l.slice(0, l.lastIndexOf("  ")));
  assert.equal(displayWidth(col0[0]), displayWidth(col0[1]), JSON.stringify(col0));
});

// Mode selection at the 40-col threshold
test("narrow table -> fenced grid", () => {
  const out = formatTablesForDiscord("| Env | Status |\n|---|---|\n| prod | green |\n| dev | amber |");
  assert.ok(out.startsWith("```"), out);
  const width = Math.max(...out.split("\n").slice(1, -1).map(displayWidth));
  assert.ok(width <= MAX_GRID_WIDTH, `width ${width}`);
});
test("wide table -> list, no fence", () => {
  const out = formatTablesForDiscord(
    "| Project | Owner | Notes |\n|---|---|---|\n| Migration of the billing system | Sam | needs sign-off from finance before Friday |"
  );
  assert.ok(!out.includes("```"), out);
  assert.ok(out.startsWith("**Migration of the billing system**"), out);
});
test("huge narrow table -> list, because a >1900-char fence cannot survive splitting", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| r${i} | ${i} |`).join("\n");
  const out = formatTablesForDiscord(`| Key | N |\n|---|---|\n${rows}`);
  assert.ok(!out.includes("```"), "must NOT emit a fence it cannot keep intact");
  assert.ok(out.includes("**r299**"), out);
});

// Edge case 8: idempotency
for (const [name, src] of [
  ["narrow", "| Env | Status |\n|---|---|\n| prod | green |"],
  ["wide", "| Project | Owner | Notes |\n|---|---|---|\n| Migration of billing | Sam | needs finance sign-off Friday |"],
  ["mixed prose", "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nOutro with a | pipe."],
]) {
  test(`idempotent: ${name}`, () => {
    const once = formatTablesForDiscord(src);
    assert.equal(formatTablesForDiscord(once), once);
    assert.equal(formatTablesForDiscord(formatTablesForDiscord(once)), once);
  });
}

// Surrounding text untouched
test("prose before/after is preserved exactly", () => {
  const out = formatTablesForDiscord("Hello **world**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nBye _now_.");
  assert.ok(out.startsWith("Hello **world**.\n\n"), out);
  assert.ok(out.endsWith("\n\nBye _now_."), out);
});
test("text with no table is returned identical", () => {
  const src = "just prose | with a pipe\nand another | line";
  assert.equal(formatTablesForDiscord(src), src);
});
test("indented table (nested under a bullet) is handled, indent preserved", () => {
  const out = formatTablesForDiscord("- Results:\n  | a | b |\n  |---|---|\n  | 1 | 2 |");
  assert.ok(out.startsWith("- Results:\n"), out);
  assert.ok(out.split("\n")[1].startsWith("  "), out);
});
test("two tables in one message both transform", () => {
  const out = formatTablesForDiscord("| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| c | d |\n|---|---|\n| 3 | 4 |");
  assert.equal((out.match(/```/g) || []).length, 4);
});
test("matched inline code in a cell is unwrapped, so no fence conflict", () => {
  const out = formatTablesForDiscord("| a | b |\n|---|---|\n| ```x``` | 2 |");
  assert.equal(out.split("\n")[0], "```");
  assert.ok(out.includes("x"), out);
});
test("an UNMATCHED backtick run in a cell forces a longer fence", () => {
  const out = formatTablesForDiscord("| a | b |\n|---|---|\n| ``` | 2 |");
  const opener = out.split("\n")[0];
  assert.ok(opener.length >= 4, `fence must outrun the content: ${JSON.stringify(opener)}`);
  assert.ok(out.trimEnd().endsWith(opener), "closing fence must match");
});

// splitMessageFenceSafe
test("short text returned as one chunk", () => {
  assert.deepEqual(splitMessageFenceSafe("hi", 2000), ["hi"]);
});
test("fences are balanced in EVERY chunk", () => {
  const body = Array.from({ length: 400 }, (_, i) => `row ${i} ....................`).join("\n");
  const chunks = splitMessageFenceSafe("```\n" + body + "\n```", 2000);
  assert.ok(chunks.length > 1, "should have split");
  for (const [i, c] of chunks.entries()) {
    const n = (c.match(/^```/gm) || []).length;
    assert.equal(n % 2, 0, `chunk ${i} has ${n} fence markers:\n${c.slice(0, 120)}`);
    assert.ok(c.length <= 2000, `chunk ${i} is ${c.length}`);
  }
});
test("language tag is carried across the boundary", () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} ....................`).join("\n");
  const chunks = splitMessageFenceSafe("```ansi\n" + body + "\n```", 2000);
  assert.ok(chunks[1].startsWith("```ansi"), chunks[1].slice(0, 40));
});
test("never cleaves a ``` marker (the original's worst case)", () => {
  const chunks = splitMessageFenceSafe("```\n" + "x".repeat(1994) + "\n```", 2000);
  for (const c of chunks) assert.ok(!/(^|[^`])``($|[^`])/.test(c), `half marker in: ${c.slice(-10)}`);
});
test("no lone surrogates on a hard cut", () => {
  const chunks = splitMessageFenceSafe("x".repeat(1999) + "😀".repeat(50), 2000);
  for (const c of chunks) {
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(c), "trailing high surrogate");
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c), "leading low surrogate");
  }
});
test("continuation chunks do not start with a blank line", () => {
  const chunks = splitMessageFenceSafe(Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"), 500);
  for (const c of chunks.slice(1)) assert.ok(!c.startsWith("\n"), JSON.stringify(c.slice(0, 8)));
});
test("no chunk exceeds maxLen; nothing is lost", () => {
  const src = Array.from({ length: 200 }, (_, i) => `line ${i} abcdefghij`).join("\n");
  const chunks = splitMessageFenceSafe(src, 400);
  for (const c of chunks) assert.ok(c.length <= 400, `${c.length}`);
  assert.equal(chunks.join("\n").replace(/\n/g, ""), src.replace(/\n/g, ""));
});
test("dangling fence in the INPUT is closed on output", () => {
  const chunks = splitMessageFenceSafe("```\n" + "y".repeat(3000), 2000);
  assert.ok(chunks.at(-1).trimEnd().endsWith("```"), chunks.at(-1).slice(-20));
});

// a real failing example (names changed)
const REAL = [
  "| Day | Before | After | |",
  "|---|---|---|---|",
  "| Tue 28 | 37.2h | **6.4h** | Website launch only |",
  "| Wed 29 | 29.5h | **15.7h** | Launch crunch, alone |",
  "| Sat 1 Aug | \u2014 | 7.0h | Support rota |",
].join("\n");

const REAL_EXPECTED = [
  "**Tue 28** · Before 37.2h → After **6.4h** \u2014 Website launch only",
  "**Wed 29** · Before 29.5h → After **15.7h** \u2014 Launch crunch, alone",
  "**Sat 1 Aug** · After 7.0h \u2014 Support rota",
].join("\n");

test("the real table renders exactly as specified", () => {
  assert.equal(formatTablesForDiscord(REAL), REAL_EXPECTED);
});
test("the real table is idempotent", () => {
  assert.equal(formatTablesForDiscord(REAL_EXPECTED), REAL_EXPECTED);
});
test("the real table picks list mode because its grid is wider than 40 cols", () => {
  const [tbl] = parseMdTables(REAL);
  assert.ok(toAsciiGrid(tbl.headers, tbl.aligns, tbl.rows).width > MAX_GRID_WIDTH);
});
