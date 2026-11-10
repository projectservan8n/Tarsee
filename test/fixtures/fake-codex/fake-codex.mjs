/**
 * fake-codex.mjs: a stand-in for the codex binary, for tests that run the Codex engine through the REAL
 * @openai/codex-sdk (which starts `<codex> exec --experimental-json [--config k=v]... [resume <id>]` and writes the
 * prompt to its stdin) without the real binary. It records what it was started with and plays a scripted turn.
 *
 * Started two ways (launch.js picks by platform), because the SDK spawns the binary with no shell and Node won't start
 * a .cmd or .bat file without one:
 *   POSIX     the `codex` sh shim next to this file runs `node fake-codex.mjs exec --experimental-json ...`
 *   Windows   the SDK starts node.exe itself with NODE_OPTIONS=--import=<this file>: node takes `exec` as its script,
 *             this module runs first and exits before node goes looking for a file called exec
 *
 * What it does comes from the JSON file named by FAKE_CODEX_PLAN:
 *   record      a file to write {argv, env, stdin, cwd} to (argv is what came after the binary's name)
 *   fixture     a captured turn to play (a .jsonl file name in test/fixtures/codex/), or
 *   events      the events to play, one JSON line each
 *   sleepMs     wait this long after the events (a turn that is still working when Stop comes)
 *   stderr      text to write to stderr before exiting
 *   exitCode    the exit code (default 0)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "codex");

/** The arguments after the binary's name, however this was started. */
function codexArgs() {
  const [, second, ...rest] = process.argv;
  if (second && path.resolve(second) === fileURLToPath(import.meta.url)) return rest;
  // Preloaded into `node exec ...`: node made "exec" its script path.
  return [path.basename(second || ""), ...rest];
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function main() {
  const planFile = process.env.FAKE_CODEX_PLAN;
  if (!planFile) {
    process.stderr.write("fake codex: FAKE_CODEX_PLAN is not set\n");
    return 2;
  }
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const stdin = await readStdin();
  if (plan.record) {
    fs.writeFileSync(plan.record, JSON.stringify({ argv: codexArgs(), env: { ...process.env }, stdin, cwd: process.cwd() }));
  }
  const lines = plan.fixture
    ? fs.readFileSync(path.join(FIXTURES, plan.fixture), "utf8").split(/\r?\n/).filter((l) => l.trim())
    : (plan.events || []).map((e) => JSON.stringify(e));
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (ev.type === "x-sdk-threw") continue; // the capture's note of what the SDK threw: not an event codex prints
    process.stdout.write(`${line}\n`);
  }
  if (plan.sleepMs) await new Promise((r) => setTimeout(r, plan.sleepMs));
  if (plan.stderr) process.stderr.write(plan.stderr);
  return Number(plan.exitCode) || 0;
}

const code = await main().catch((err) => {
  process.stderr.write(`fake codex: ${err?.stack || err}\n`);
  return 3;
});
// Let stdout and stderr drain before leaving (they are pipes to the SDK).
await new Promise((r) => process.stdout.write("", () => process.stderr.write("", r)));
process.exit(code);
