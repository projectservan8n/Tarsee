/**
 * launch.js: how a test starts the fake codex (fake-codex.mjs) through the real @openai/codex-sdk, per platform.
 *
 *   const fake = fakeCodexLauncher(dir, { fixture: "text-reply.jsonl" });
 *   fake.codexPath   what TARSEE_CODEX_BIN (the SDK's codexPathOverride) names
 *   fake.env         what the server's environment needs for it (the plan's file, and on Windows the preload)
 *   fake.record()    what the fake was started with: {argv, env, stdin, cwd}, or null if it never ran
 *   fake.plan(p)     replace the plan for the next start
 *
 * POSIX: the `codex` sh shim (made executable here: git may not have kept the bit). Windows: node.exe itself, with
 * the fake preloaded through NODE_OPTIONS, because Node starts a .cmd or .bat only through a shell and the SDK uses
 * none (see fake-codex.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CODEX_SCRIPT = path.join(HERE, "fake-codex.mjs");
export const FAKE_CODEX_SH = path.join(HERE, "codex");
export const FAKE_CODEX_CMD = path.join(HERE, "codex.cmd");

export function fakeCodexLauncher(dir, plan = {}, { platform = process.platform } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const planFile = path.join(dir, "fake-codex-plan.json");
  const recordFile = path.join(dir, "fake-codex-record.json");
  const write = (p) => {
    fs.rmSync(recordFile, { force: true });
    fs.writeFileSync(planFile, JSON.stringify({ record: recordFile, ...p }));
  };
  write(plan);
  let codexPath;
  const env = { FAKE_CODEX_PLAN: planFile };
  if (platform === "win32") {
    codexPath = process.execPath;
    env.NODE_OPTIONS = `--import=${pathToFileURL(FAKE_CODEX_SCRIPT).href}`;
  } else {
    try { fs.chmodSync(FAKE_CODEX_SH, 0o755); } catch { /* a read-only checkout: the bit is already there */ }
    codexPath = FAKE_CODEX_SH;
    env.FAKE_CODEX_NODE = process.execPath;
  }
  return {
    codexPath,
    env,
    plan: write,
    record() {
      try { return JSON.parse(fs.readFileSync(recordFile, "utf8")); } catch { return null; }
    },
  };
}
