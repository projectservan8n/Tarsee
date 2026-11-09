// The shared codex runner (src/ai/codex-cli.js) used by the ChatGPT sign-in and the account's model list: which
// binary runs, the environment it gets, ANSI stripping, and that a codex child can never take the server down with an
// "error" event nobody listens to. Every key here is an obvious fake.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_BASE_ARGS, CodexCliError, codexChildEnv, killTree, pinnedCodexBin, requireCodexHome, resolveCodexBin, runCodex,
  spawnCodex, stripAnsi,
} from "../src/ai/codex-cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "fake-codex-login");

let root;
let fakeBin;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-codex-cli-"));
  fs.cpSync(FIXTURES, path.join(root, "bin"), { recursive: true });
  fakeBin = path.join(root, "bin", process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform !== "win32") fs.chmodSync(fakeBin, 0o755);
});
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const fakeEnv = (extra = {}) => ({ ...process.env, FAKE_CODEX_NODE: process.execPath, ...extra });

describe("codex-cli", () => {
  it("a codex child's error event never goes unheard, however many come", async () => {
    const child = spawnCodex(fakeBin, ["logout"], { env: fakeEnv({ CODEX_HOME: root }), cwd: root });
    assert.doesNotThrow(() => child.emit("error", new Error("first")));
    assert.doesNotThrow(() => child.emit("error", new Error("second")));
    await killTree(child);
  });

  it("runCodex runs one command to the end through the platform shim", async () => {
    const home = path.join(root, "status-home");
    fs.mkdirSync(home);
    const r = await runCodex(fakeBin, [...CODEX_BASE_ARGS, "login", "status"], { env: fakeEnv({ CODEX_HOME: home }), cwd: home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Not logged in/);
    assert.equal(r.timedOut, false);
  });

  it("killTree on a child that already exited resolves at once", async () => {
    const child = spawnCodex(fakeBin, ["nothing"], { env: fakeEnv({ CODEX_HOME: root }), cwd: root });
    await new Promise((r) => child.once("exit", r));
    await killTree(child);
  });

  it("which codex: an explicit path, then TARSEE_CODEX_BIN, then the pinned binary; a missing one is said plainly", () => {
    assert.equal(resolveCodexBin({ codexBin: fakeBin, env: {} }), fakeBin);
    assert.equal(resolveCodexBin({ env: { TARSEE_CODEX_BIN: fakeBin } }), fakeBin);
    assert.throws(() => resolveCodexBin({ codexBin: path.join(root, "nope"), env: {} }), (err) => err instanceof CodexCliError && err.code === "codex-missing");
    assert.throws(() => pinnedCodexBin({ platform: "plan9", arch: "x64" }), { code: "codex-missing" });
    let pinned = null;
    try { pinned = pinnedCodexBin(); } catch {}
    if (pinned) assert.equal(resolveCodexBin({ env: {} }), pinned);
  });

  it("the child's environment: no credential, no base URL, and CODEX_HOME is the one asked for", () => {
    const env = codexChildEnv({
      PATH: "/usr/bin", OPENAI_API_KEY: "sk-test-canary-1", CODEX_API_KEY: "sk-test-canary-2", CODEX_HOME: "/elsewhere",
      OPENAI_BASE_URL: "https://example.test", ENCRYPTION_KEY: "x", ANTHROPIC_API_KEY: "sk-test-canary-3", LANG: "C.UTF-8",
    }, "/data/tarsee/.codex-home", { RUST_LOG: "error" });
    assert.deepEqual(env, { PATH: "/usr/bin", LANG: "C.UTF-8", RUST_LOG: "error", CODEX_HOME: "/data/tarsee/.codex-home" });
  });

  it("stripAnsi leaves only the words", () => {
    const ESC = String.fromCharCode(27);
    assert.equal(stripAnsi(`${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m ${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\`), "https://auth.openai.com/codex/device link");
  });

  it("every job keeps its sign-in in a file, skips the update check and looks for no project root above its folder", async () => {
    const pairs = [];
    for (let i = 0; i < CODEX_BASE_ARGS.length; i += 2) pairs.push([CODEX_BASE_ARGS[i], CODEX_BASE_ARGS[i + 1]]);
    assert.ok(pairs.every(([flag]) => flag === "-c"), CODEX_BASE_ARGS.join(" "));
    const values = pairs.map(([, v]) => v);
    assert.ok(values.includes('cli_auth_credentials_store="file"'));
    assert.ok(values.includes("check_for_update_on_startup=false"));
    // Without it Codex finds a project root at the nearest folder above with .git and loads every .codex/config.toml
    // from there down to the job's folder (the Codex home, under Tarsee's state folder), which no guard reads.
    assert.ok(values.includes("project_root_markers=[]"));
    // The pinned codex takes it: `login status` still answers in its own words.
    let pinned = null;
    try { pinned = pinnedCodexBin(); } catch { /* no binary for this system: nothing more to check */ }
    if (!pinned) return;
    const home = path.join(root, "pinned-status-home");
    fs.mkdirSync(home);
    const r = await runCodex(pinned, [...CODEX_BASE_ARGS, "login", "status"], { env: codexChildEnv(process.env, home), cwd: home, timeoutMs: 20_000 });
    assert.equal(r.timedOut, false);
    assert.match(stripAnsi(`${r.stderr}\n${r.stdout}`), /Not logged in/);
  });

  it("needs a home", () => {
    assert.throws(() => requireCodexHome(""), TypeError);
    assert.equal(requireCodexHome("rel/home"), path.resolve("rel/home"));
  });
});
