// The dashboard's loop guard (src/lib/loop-guard.js): it stops a turn stuck repeating itself, and nothing else.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLoopGuard } from "../src/lib/loop-guard.js";

const run = (steps) => {
  const g = createLoopGuard();
  let i = 0;
  for (const [name, input, ok] of steps) {
    const id = `t${i++}`;
    g.onCall(id, name, input);
    g.onResult(id, ok);
  }
  return g.check();
};

describe("loop guard", () => {
  it("ordinary work is never stopped: edits of one file, reads at different offsets, files that mention errors", () => {
    assert.equal(run([
      ["Edit", { file_path: "/a.js", old_string: "1", new_string: "2" }, true],
      ["Edit", { file_path: "/a.js", old_string: "3", new_string: "4" }, true],
      ["Edit", { file_path: "/a.js", old_string: "5", new_string: "6" }, true],
    ]), false);
    assert.equal(run([
      ["Read", { file_path: "/big.log", offset: 0 }, true],
      ["Read", { file_path: "/big.log", offset: 2000 }, true],
      ["Read", { file_path: "/big.log", offset: 4000 }, true],
    ]), false);
    const many = Array.from({ length: 80 }, (_, i) => ["Grep", { pattern: `p${i}` }, true]);
    assert.equal(run(many), false, "no cap on the number of tool calls (maxTurns bounds a turn)");
  });

  it("the very same call three times in a row is a loop", () => {
    assert.match(run([
      ["Bash", { command: "npm test" }, true],
      ["Bash", { command: "npm test" }, true],
      ["Bash", { command: "npm test" }, true],
    ]), /Bash called 3 times with the same input/);
  });

  it("only the SDK's error flag counts as a failure", () => {
    assert.match(run([
      ["Bash", { command: "a" }, false],
      ["Bash", { command: "b" }, false],
      ["Bash", { command: "c" }, false],
    ]), /Bash failed 3 times in a row/);
    assert.match(run([
      ["Bash", { command: "a" }, false], ["Read", { file_path: "/x" }, false], ["Grep", { pattern: "y" }, false],
      ["Glob", { pattern: "z" }, false], ["Bash", { command: "w" }, false],
    ]), /5 consecutive tool errors/);
  });

  it("results are matched to their calls by id, when tools run side by side", () => {
    const g = createLoopGuard();
    g.onCall("a", "Bash", { command: "x" });
    g.onCall("b", "Bash", { command: "y" });
    g.onCall("c", "Bash", { command: "z" });
    g.onResult("c", true);
    g.onResult("a", false);
    g.onResult("b", false);
    assert.equal(g.check(), false, "two failures and a success are not three failures");
  });
});
