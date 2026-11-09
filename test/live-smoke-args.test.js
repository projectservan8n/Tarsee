// scripts/e2e/live-smoke.mjs is the owner's morning check with real keys. Its address and password come only from
// TARSEE_URL and TARSEE_PASSWORD, and it never prints the password. A short password (a 4-digit SETUP_PASSWORD) can't
// be blanked out of what it prints without giving it away (it would show as the gap in a date or a sum), so the
// script must never put it in a line at all: not even when it is typed by mistake after an option, where a value the
// script doesn't know used to be repeated back ("--verify: "4817" isn't an AI Tarsee knows").
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { parseArgs, main } = await import("../scripts/e2e/live-smoke.mjs");

// Made at run time: a 4-digit PIN, a short all-lowercase word and a short mixed one.
const pin = String(1000 + crypto.randomInt(9000));
const word = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz"[crypto.randomInt(26)]).join("");
const mixed = `Pw${crypto.randomInt(100000)}!x`;
const CASES = (pw) => [
  ["--only", pw],
  [`--only=${pw}`],
  ["--only", `deepseek,${pw}`],
  ["--verify", pw],
  [`--verify=${pw}`],
  ["--model", `${pw}=x`],
  ["--verify", `${pw}=x`],
  [`--${pw}`],
  [pw],
];
/** The password on its own in text: not as part of a longer number or word around it. */
const standsAlone = (text, pw) => new RegExp(`(?<![\\w.,])${pw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.,])`).test(text);

describe("live-smoke: a password typed after an option is never repeated back", () => {
  for (const [name, pw] of [["a 4-digit PIN", pin], ["a short lowercase word", word], ["a short mixed password", mixed]]) {
    it(`${name}: refused, and not shown`, () => {
      for (const argv of CASES(pw)) {
        const o = parseArgs(argv, { password: pw });
        assert.ok(o.errors.length >= 1, `${argv.join(" ")} is refused`);
        for (const e of o.errors) assert.equal(standsAlone(e, pw), false, `${argv.join(" ")}: "${e}" shows the password`);
      }
    });

    it(`${name}: what main() prints for it doesn't show it either`, async (t) => {
      const lines = [];
      t.mock.method(console, "log", (...a) => lines.push(a.join(" ")));
      t.mock.method(console, "error", (...a) => lines.push(a.join(" ")));
      for (const argv of CASES(pw)) {
        const code = await main(argv, { TARSEE_URL: "", TARSEE_PASSWORD: pw });
        assert.equal(code, 1, argv.join(" "));
      }
      const out = lines.join("\n");
      assert.ok(/isn't an AI Tarsee knows|Unknown option|isn't an option/.test(out), "it says what was wrong");
      assert.equal(standsAlone(out, pw), false, "the password isn't in the output");
    });
  }

  it("an AI name it doesn't know is still named, so a typo is easy to fix", () => {
    const o = parseArgs(["--only", "deepsek"], { password: pin });
    assert.match(o.errors.join("\n"), /"deepsek" isn't an AI Tarsee knows/);
    assert.match(parseArgs(["--colour"], { password: pin }).errors.join("\n"), /Unknown option --colour/);
  });

  it("a name that contains the password is not shown, even when it looks like an AI name", () => {
    const o = parseArgs(["--only", `x${word}`], { password: word });
    assert.equal(o.errors.some((e) => e.includes(word)), false);
  });
});
