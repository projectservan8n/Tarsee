// The calculator tool (src/lib/tools.js) works a sum out with a small arithmetic parser of its own. It used to hand the
// expression to `new Function` behind an input filter that let through anything starting with a bracket or a digit,
// so "(process.env.ENCRYPTION_KEY)" gave the key back and "(import('node:fs')...)" ran code: anyone who can talk to
// the bot (any channel user) could get the AI to do it for them. These tests ask for secrets, the global object, code,
// and every way around a filter, and check that each one is refused in plain words and that nothing runs. They also
// check that every sum the old tool got right comes out exactly the same, in the same words.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep every module that reads config away from the real state dir, vault and DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-calculator-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
const SECRET = "calculator-test-encryption-key-0123456789";
process.env.ENCRYPTION_KEY = SECRET;
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { executeTool, TOOLS } = await import("../src/lib/tools.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "../src/lib/tools.js"), "utf8");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const calc = (expression) => executeTool("calculator", { expression });
const REFUSED = "Error: Invalid expression.";

/** What the old tool gave for a sum it could do: the test's own inputs are trusted, so `new Function` is fine here. */
function oldAnswer(expression) {
  const result = new Function("Math", `"use strict"; return (${expression.trim()});`)(Math);
  if (typeof result !== "number" || !isFinite(result)) return `Result: ${result} (not a finite number)`;
  return `${expression} = ${result}`;
}

/** A refusal: the usual error text, and nothing in it that came from running anything. */
function assertRefused(out, expression) {
  assert.ok(out.startsWith(REFUSED), `${JSON.stringify(expression)} wasn't refused: ${JSON.stringify(out)}`);
  assert.ok(!out.includes(SECRET), `${JSON.stringify(expression)} leaked the key: ${JSON.stringify(out)}`);
  for (const sign of ["[object", "native code", "Promise", "Result:", " = "]) {
    assert.ok(!out.includes(sign), `${JSON.stringify(expression)} gave back something it ran (${sign}): ${JSON.stringify(out)}`);
  }
}

describe("calculator: a secret, the global object or code never comes back", () => {
  const leaks = {
    "process.env, as the bug report had it": "(process.env.ENCRYPTION_KEY)",
    "process.env after a comma": "1, process.env.ENCRYPTION_KEY",
    "process.env added to a number": "1 + process.env.ENCRYPTION_KEY",
    "process.env on a new line": "1\n+ process.env.ENCRYPTION_KEY",
    "process itself": "(process)",
    "globalThis": "(globalThis)",
    "globalThis.process": "(globalThis.process.env.ENCRYPTION_KEY)",
    "global": "(global)",
    "this": "(this)",
    "require": "(require('node:fs'))",
    "import()": "(import('node:fs'))",
    "import.meta": "(import.meta)",
    "eval": "(eval('process.env.ENCRYPTION_KEY'))",
    "Function": "(Function('return process.env.ENCRYPTION_KEY')())",
    "Math on its own": "(Math)",
    "Math.constructor": "Math.constructor",
    "Math.__proto__": "Math.__proto__",
    "Math.__proto__.constructor": "(Math.__proto__.constructor)",
    "Math.constructor.constructor": "(Math.constructor.constructor('return process')().env.ENCRYPTION_KEY)",
    "a Math function's constructor": "Math.abs.constructor('return process.env.ENCRYPTION_KEY')()",
    "a Math function's call.constructor": "Math.sqrt.call.constructor('return process.env.ENCRYPTION_KEY')()",
    "a number's constructor": "(1).constructor.constructor('return process.env.ENCRYPTION_KEY')()",
    "a constant's constructor": "Math.PI.constructor.constructor('return process.env.ENCRYPTION_KEY')()",
    "square brackets": "Math['constructor']['constructor']('return process.env.ENCRYPTION_KEY')()",
    "Math.toString": "Math.toString()",
    "Math.hasOwnProperty": "Math.hasOwnProperty('PI')",
    "a string": "('A')",
    "a string with \\x escapes": "(globalThis['\\x70rocess'].env.ENCRYPTION_KEY)",
    "a string with \\u escapes": "(globalThis['\\u0070rocess'].env.ENCRYPTION_KEY)",
    "strings joined": "(globalThis['pro' + 'cess'].env['ENCRYPTION_KEY'])",
    "a template string": "(`${process.env.ENCRYPTION_KEY}`)",
    "a \\u escape in a name": "(\\u0070rocess.env.ENCRYPTION_KEY)",
    "a \\u{} escape in a name": "(\\u{70}rocess.env.ENCRYPTION_KEY)",
    "a \\u escape after Math.": "Math.\\u0063onstructor",
    "a comment": "1 /* sum */ + process.env.ENCRYPTION_KEY",
    "an arrow function": "((x) => x)(process.env.ENCRYPTION_KEY)",
    "an array": "[process.env.ENCRYPTION_KEY]",
    "a BigInt": "10n",
    "the spread sign": "Math.max(...[1, 2])",
  };
  for (const [what, expression] of Object.entries(leaks)) {
    it(`refuses ${what}`, async () => assertRefused(await calc(expression), expression));
  }

  it("runs nothing: an assignment to the global object doesn't happen", async () => {
    const out = await calc("(globalThis.__tarseeCalculatorRan = 1)");
    assertRefused(out, "(globalThis.__tarseeCalculatorRan = 1)");
    assert.equal(globalThis.__tarseeCalculatorRan, undefined);
  });

  it("runs nothing: import('node:fs') can't write a file", async () => {
    const marker = path.join(tmp, "calculator-ran.txt");
    const expression = `(import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(marker)}, 'ran')))`;
    const out = await calc(expression);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.existsSync(marker), false, "the expression wrote a file");
    assertRefused(out, expression);
  });

  it("has no eval and no Function in the calculator", () => {
    const start = SRC.indexOf('case "calculator": {');
    const end = SRC.indexOf('case "datetime": {', start);
    assert.ok(start > 0 && end > start, "the calculator case wasn't found in tools.js");
    // Its comments tell the story of `new Function`; the code mustn't use it.
    const code = SRC.slice(start, end).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\bFunction\b|\beval\b|\bimport\s*\(|\brequire\s*\(|\bvm\./);
  });
});

describe("calculator: every sum the old tool could do comes out the same", () => {
  const sums = [
    "48271 * 3917", "10001 * 2026", "20267 * 3917", "42026 * 202", "(149 * 12) * 0.85", "Math.sqrt(144) + 5",
    "2 ** 10", "10 % 3", "-7 % 3", "7.5 % 2", "1e3", "1.5e-2*2", "1E+3 / 4", ".5 + 5.", "5.e3", "2.5e-3",
    "-(-3)", "- -3", "+4", "0.1+0.2", "2 + 3 * 4", "(2 + 3) * 4", "10 - 4 - 3", "100 / 10 / 5", "2 ** 3 ** 2",
    "2 ** -1", "(-2) ** 2", "-(2 ** 2)", "-2 * 3", "2 * -3", "1 - -1", "12 * (3 + (4 - 1) * 2)", "3 * -(2 + 1)",
    "Math.round(2.5)", "Math.round(-2.5)", "Math.ceil(4.01)", "Math.floor(-4.01)", "Math.abs(-12.5)",
    "Math.log(Math.E)", "Math.PI * 2", "Math.E ** 2", "Math.max(1, 2, 3)", "Math.min(3, 1)", "Math.pow(2, 8)",
    "Math.hypot(3, 4)", "Math.log10(1000)", "Math.log2(8)", "Math.trunc(-4.7)", "Math.sign(-3)", "Math.cbrt(27)",
    "Math.exp(1)", "Math.sin(Math.PI / 2)", "Math.cos(0)", "Math.atan2(1, 1)", "Math.SQRT2 * Math.SQRT2",
    "Math.LN2 + Math.LN10 + Math.LOG2E + Math.LOG10E + Math.SQRT1_2",
    "Math.max(Math.min(5, 9), Math.abs(-7))", "0x1F + 0b101 + 0o17", "1_000_000 * 3", "1250000 * 0.0525 / 12",
    "((1 + 0.05) ** 10 - 1) * 100", "1999.99 * 0.12", "(48271 * 3917) % 1000", "94906265 * 94906265",
    "9007199254740991 - 1", "2 ** 53 - 1", "\t48271\n*\n3917 ", "  7 * 6  ", "1/0", "-1/0", "0/0", "Math.sqrt(-1)",
    "Math.max()", "1e400", "-0", "0 * -1",
  ];
  for (const expression of sums) {
    it(JSON.stringify(expression), async () => assert.equal(await calc(expression), oldAnswer(expression)));
  }

  it("multiplies 5-digit numbers as the live tests do: 48271 * 3917 = 189077507", async () => {
    assert.equal(await calc("48271 * 3917"), "48271 * 3917 = 189077507");
  });

  it("keeps whole numbers exact as far as JavaScript numbers go (9007199254740991)", async () => {
    assert.equal(await calc("94906265 * 94906265"), "94906265 * 94906265 = 9007199136250225");
    assert.equal(await calc("9007199254740990 + 1"), "9007199254740990 + 1 = 9007199254740991");
    assert.equal(await calc("123456789 * 72"), "123456789 * 72 = 8888888808");
  });

  it("says when a number goes past that, so a rounded answer isn't taken as exact", async () => {
    const out = await calc("123456789 * 987654321");
    assert.ok(out.startsWith("123456789 * 987654321 = 121932631112635260 "), out);
    assert.match(out, /9007199254740991/);
    assert.match(out, /rounded/);
    assert.match(await calc("9007199254740993 - 10"), /rounded/, "a number written past it is flagged too");
    assert.doesNotMatch(await calc("2 ** 53 - 1"), /rounded/);
  });

  it("takes spaces around Math's dot and brackets, as JavaScript does", async () => {
    assert.equal(await calc("Math . sqrt ( 16 ) + Math. PI * 0"), "Math . sqrt ( 16 ) + Math. PI * 0 = 4");
  });

  it("takes a number as well as text", async () => {
    assert.equal(await executeTool("calculator", { expression: 42 }), "42 = 42");
  });

  it("gives a Math.random() number between 0 and 1", async () => {
    const out = await calc("Math.random()");
    const m = /^Math\.random\(\) = (.+)$/.exec(out);
    assert.ok(m, out);
    const n = Number(m[1]);
    assert.ok(n >= 0 && n < 1, out);
  });

  it("does every sign and Math function and constant its description lists", async () => {
    const def = TOOLS.find((t) => t.name === "calculator");
    const listed = [...def.description.matchAll(/Math\.(\w+)(\(\))?/g)];
    assert.ok(listed.length >= 8, "the description lists the Math functions and constants");
    for (const [, name, call] of listed) {
      const expression = call ? `Math.${name}(2.5)` : `Math.${name}`;
      assert.equal(await calc(expression), oldAnswer(expression));
    }
    for (const sign of ["+", "-", "*", "/", "**", "%"]) {
      assert.ok(def.description.includes(sign), `the description lists ${sign}`);
      assert.equal(await calc(`7 ${sign} 2`), oldAnswer(`7 ${sign} 2`));
    }
  });
});

describe("calculator: a sum it can't do is refused in plain words", () => {
  it("'^' points to ** for a power", async () => {
    const out = await calc("2^3");
    assert.ok(out.startsWith(REFUSED), out);
    assert.match(out, /2 \*\* 3/);
  });

  it("a comma outside a Math function is refused, not worked out as the last number", async () => {
    for (const expression of ["1,000 * 2", "(1, 2)"]) {
      const out = await calc(expression);
      assert.ok(out.startsWith(REFUSED), out);
      assert.match(out, /comma/);
    }
  });

  it("a Math function without Math. says to write Math.", async () => {
    const out = await calc("sqrt(16)");
    assert.ok(out.startsWith(REFUSED), out);
    assert.match(out, /Math\.sqrt/);
  });

  it("an unknown Math name is refused", async () => {
    const out = await calc("Math.foo(2)");
    assert.ok(out.startsWith(REFUSED), out);
    assert.match(out, /Math\.foo/);
  });

  it("an unknown name or sign is refused by name", async () => {
    assert.match(await calc("2 * x"), /^Error: Invalid expression\. 'x' /);
    assert.match(await calc("5 & 3"), /^Error: Invalid expression\. '&' /);
  });

  const mistakes = {
    "a missing ')'": ["(1 + 2", /\)/],
    "an extra ')'": ["1 + 2)", /\)/],
    "two numbers with no sign": ["2 3", /sign/],
    "a sign at the end": ["2 +", /number/],
    "a sign at the start": ["* 3", /number/],
    "empty brackets": ["()", /empty/],
    "a minus straight before **": ["-2 ** 2", /\(-2\) \*\* 2/],
    "a minus straight before ** on the right of **": ["2 ** -1 ** 2", /\(-2\) \*\* 2/],
    "a Math function with no brackets": ["Math.sqrt", /brackets/],
    "a Math constant with brackets": ["Math.PI(2)", /Math\.PI/],
    "a name straight after a number": ["2Math.PI", /sign/],
    "two decimal points": ["1.2.3", /sign/],
    "an exponent with no digits": ["1e", /exponent/],
    "% at the end, as a percent sign": ["50%", /50 \/ 100 \* 200/],
    "% before another sign, as a percent sign": ["50% * 200", /remainder/],
  };
  for (const [what, [expression, says]] of Object.entries(mistakes)) {
    it(`${what}: ${JSON.stringify(expression)}`, async () => {
      const out = await calc(expression);
      assert.ok(out.startsWith("Math error: "), out);
      assert.match(out, says);
    });
  }

  it("brackets or signs nested too deep give an error, not a crash", async () => {
    for (const expression of [`${"(".repeat(5000)}1${")".repeat(5000)}`, `${"- ".repeat(50000)}1`, `2${" ** 2".repeat(5000)}`]) {
      const out = await calc(expression);
      assert.ok(out.startsWith("Math error: "), out.slice(0, 200));
      assert.match(out, /inside one another/);
    }
  });

  it("an empty or missing expression asks for one", async () => {
    for (const input of [{ expression: "" }, { expression: "   " }, {}, null]) {
      assert.equal(await executeTool("calculator", input), "Error: 'expression' is required.");
    }
  });

  it("an expression that isn't text or a number is refused", async () => {
    const out = await executeTool("calculator", { expression: { toString: () => "1 + 1" } });
    assert.ok(out.startsWith("Error: "), out);
    assert.doesNotMatch(out, /= 2/);
  });
});
