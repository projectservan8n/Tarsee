// What a turn leaves behind when the server stops in the middle of it (a redeploy, Ctrl+C, a crash, `node --watch`
// restarting): a Codex turn's copies of the person's pictures (<system temp>/tarsee-codex/tarsee-images-*) and a
// Verify's workspace (<state>/verify/<provider>-*). Their turn's own clean-up never ran, so the server sweeps them once
// at boot (lib/turn-leftovers.js). Only what is over an hour old goes: a turn another Tarsee sharing the folders is
// running right now is never touched, and nothing else in those folders is.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sweepTurnLeftovers, CODEX_IMAGE_DIR } from "../src/lib/turn-leftovers.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-leftovers-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HOUR = 3_600_000;
const NOW = Date.now();
function folder(dir, name, ageMs, file = "image-1.png") {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, file), "x");
  const t = new Date(NOW - ageMs);
  fs.utimesSync(path.join(p, file), t, t);
  fs.utimesSync(p, t, t);
  return p;
}

describe("a stopped turn's leftovers, swept at boot", () => {
  it("removes pictures and Verify workspaces over an hour old; keeps newer ones and anything else", () => {
    const tmpDir = path.join(tmp, "system-temp");
    const stateDir = path.join(tmp, "state");
    const images = path.join(tmpDir, "tarsee-codex");
    const verify = path.join(stateDir, "verify");
    const oldPics = folder(images, "tarsee-images-aaaaaa", 2 * HOUR);
    const newPics = folder(images, "tarsee-images-bbbbbb", 10 * 60_000);
    const otherOld = folder(images, "someone-elses", 5 * HOUR);
    const oldCheck = folder(verify, "deepseek-cccccc", 3 * HOUR, "notes.txt");
    const newCheck = folder(verify, "openrouter-dddddd", 5 * 60_000, "notes.txt");

    assert.deepEqual(sweepTurnLeftovers({ tmpDir, stateDir, now: NOW }), { pictures: 1, verify: 1 });
    assert.ok(!fs.existsSync(oldPics) && !fs.existsSync(oldCheck));
    assert.ok(fs.existsSync(newPics), "a picture turn running now stays");
    assert.ok(fs.existsSync(newCheck), "a Verify running now stays");
    assert.ok(fs.existsSync(otherOld), "only tarsee-images-* in the pictures folder");

    assert.deepEqual(sweepTurnLeftovers({ tmpDir, stateDir, now: NOW + 2 * HOUR }), { pictures: 1, verify: 1 }, "the rest once they're old");
  });

  it("nothing there, or no state folder, is fine", () => {
    assert.deepEqual(sweepTurnLeftovers({ tmpDir: path.join(tmp, "none"), stateDir: path.join(tmp, "none-either"), now: NOW }), { pictures: 0, verify: 0 });
    assert.deepEqual(sweepTurnLeftovers({ tmpDir: path.join(tmp, "none"), stateDir: "", now: NOW }), { pictures: 0, verify: 0 });
  });

  it("the pictures folder is the one the Codex engine writes to", () => {
    assert.equal(CODEX_IMAGE_DIR, path.join(os.tmpdir(), "tarsee-codex"));
    const engine = fs.readFileSync(new URL("../src/ai/providers/codex.js", import.meta.url), "utf8");
    assert.ok(/path\.join\(os\.tmpdir\(\), "tarsee-codex"\)|CODEX_IMAGE_DIR/.test(engine), "codex.js writes pictures under <system temp>/tarsee-codex");
  });
});

// A server that exits mid-turn (a redeploy's SIGTERM handler calls process.exit, as does Ctrl+C) runs no finally block,
// so each module also cleans up on the process's exit: the Codex turn's pictures and its codex process (and whatever
// that started), and a Verify's workspace. Each case runs in a child Node that exits while the turn is waiting.
const CHILD_ENV = (dir) => {
  const env = { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir, TARSEE_STATE_DIR: path.join(dir, "state"),
    TARSEE_WORKSPACE_DIR: path.join(dir, "workspace"), TARSEE_DATA_DIR: path.join(dir, "data"), NODE_ENV: "test" };
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]) delete env[k];
  return env;
};
function runChild(dir, source) {
  const file = path.join(dir, "child.mjs");
  fs.writeFileSync(file, source);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: CHILD_ENV(dir), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the child didn't exit: ${out}`)); }, 20_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
const src = (rel) => JSON.stringify(pathToFileURL(path.resolve(rel)).href);

describe("a server that exits in the middle of a turn", () => {
  it("a Codex turn's pictures go, its codex is stopped and the processes it marked are swept", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "codex-exit-"));
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5f40000000049454e44ae426082", "hex").toString("base64");
    const { code, out } = await runChild(dir, `
import fs from "node:fs";
import path from "node:path";
const { run } = await import(${src("src/ai/providers/codex.js")});
const dir = ${JSON.stringify(dir)};
const note = (name, text = "1") => fs.writeFileSync(path.join(dir, name), text);
class FakeCodex {
  startThread() { return this.thread(); }
  resumeThread() { return this.thread(); }
  thread() {
    return { id: null, async runStreamed(input, { signal } = {}) {
      signal.addEventListener("abort", () => note("aborted"));
      note("pictures.json", JSON.stringify(input.filter((i) => i.type === "local_image").map((i) => i.path)));
      return { events: (async function* () {
        yield { type: "thread.started", thread_id: "01a1c000-0000-7000-8000-0000000000e1" };
        yield { type: "turn.started" };
        await new Promise(() => {});
      })() };
    } };
  }
}
const store = { get: () => null, set() {}, delete() {}, getKeyWithSource: () => ({ key: "sk-test-canary-exit-0001", source: "settings" }) };
const turn = run({
  target: { provider: "openai", model: "gpt-6.1-sol" },
  messages: [{ role: "user", content: "what is this?" }],
  media: [{ type: "image", source: { type: "base64", media_type: "image/png", data: ${JSON.stringify(png)} } }],
  systemParts: { stable: "S", volatile: "V" },
  toolCtx: { settingsStore: store, conversationId: "conv-exit" },
  mcpGrant: { url: "http://127.0.0.1:9/mcp", token: "mcp-test-token-exit" },
  deps: { Codex: FakeCodex, env: { PATH: process.env.PATH || "", NODE_ENV: "test" }, stateDir: path.join(dir, "state"),
    workspace: dir, vaultEnv: async () => ({}), preamble: async () => "P", accountModels: () => [],
    sweep: (mark) => { note("swept", mark); return []; } },
});
(async () => { for await (const _ of turn) { /* the turn waits */ } })();
const t = setInterval(() => { if (fs.existsSync(path.join(dir, "pictures.json"))) { clearInterval(t); process.exit(0); } }, 10);
`);
    assert.equal(code, 0, out);
    const pictures = JSON.parse(fs.readFileSync(path.join(dir, "pictures.json"), "utf8"));
    assert.equal(pictures.length, 1);
    assert.ok(pictures[0].startsWith(path.join(dir, "tarsee-codex")), pictures[0]);
    assert.ok(!fs.existsSync(path.dirname(pictures[0])), "the turn's pictures folder is gone");
    assert.ok(fs.existsSync(path.join(dir, "aborted")), "codex was stopped");
    assert.match(fs.readFileSync(path.join(dir, "swept"), "utf8"), /^[0-9a-f]{24}$/, "the turn's processes were swept by its mark");
  });

  it("a Verify's workspace goes", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "verify-exit-"));
    const { code, out } = await runChild(dir, `
import fs from "node:fs";
import path from "node:path";
const { verifyModel } = await import(${src("src/ai/verify-model.js")});
const dir = ${JSON.stringify(dir)};
verifyModel("deepseek", "deepseek-flash", {
  stateDir: path.join(dir, "state"), limiter: null, engines: ["claude-code"],
  runner: async function* (opts) {
    fs.writeFileSync(path.join(dir, "cwd.txt"), opts.cwd);
    await new Promise(() => {});
  },
});
const t = setInterval(() => { if (fs.existsSync(path.join(dir, "cwd.txt"))) { clearInterval(t); process.exit(0); } }, 10);
`);
    assert.equal(code, 0, out);
    const cwd = fs.readFileSync(path.join(dir, "cwd.txt"), "utf8");
    const workspace = path.dirname(cwd);
    assert.equal(path.dirname(workspace), path.join(dir, "state", "verify"));
    assert.ok(!fs.existsSync(workspace), "the Verify workspace is gone");
  });
});
