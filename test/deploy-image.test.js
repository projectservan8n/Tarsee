// The image and its boot (docs/superpowers/specs/2026-11-09-multi-provider-design.md 4.16, Phase 5 "Image and boot").
// - Dockerfile: the Terminal's `claude` is pinned to the Claude Code version the Agent SDK bundles (the one chat turns
//   run), and the build stops when the two differ; the Codex the SDK installed is on the PATH as `codex`, and the build
//   stops when its version isn't the SDK pin; pdftotext (poppler-utils) is installed. No docker here, so the build
//   checks are run for real in sh against stand-in `claude`, `codex` and `pdftotext` commands.
// - entrypoint.sh: every AI provider's sign-in folder exists on the volume, owner-only; /home/node/.claude and
//   /home/node/.codex link to the plan homes; each Codex home has a config.toml with Tarsee's three settings and never a
//   key, that Codex's guard accepts; CODEX_HOME and TARSEE_STATE_DIR are exported before the server starts; one
//   sign-in line per engine; an install upgraded from main with its own TARSEE_STATE_DIR keeps the Claude plan sign-in
//   (and chat transcripts) main kept in /data/tarsee/.claude-code-home, once (an older sign-in that a newer one there
//   supersedes is renamed, so a sign-out can't bring it back); changing TARSEE_STATE_DIR on this version moves nothing.
// The entrypoint's functions are sourced in sh (sourcing skips its main part). Needs a POSIX sh: on Windows, Git's.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexConfigGuard, codexConfigFilesFor, CODEX_CONFIG_ALLOWED } from "../src/ai/engine-env.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const DOCKERFILE = read("Dockerfile");
const ENTRYPOINT = path.join(ROOT, "entrypoint.sh");
const WIN = process.platform === "win32";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-deploy-image-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A POSIX sh: `sh` on the PATH, else (Windows) the one that comes with Git. null when there is none. */
function findSh() {
  const works = (bin) => {
    const r = spawnSync(bin, ["-c", "echo ok"], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() === "ok";
  };
  if (works("sh")) return "sh";
  if (WIN) {
    const r = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    if (r.status === 0) {
      for (const rel of ["../../../bin/sh.exe", "../../../usr/bin/sh.exe"]) {
        const bin = path.resolve(r.stdout.trim(), rel);
        if (fs.existsSync(bin) && works(bin)) return bin;
      }
    }
  }
  return null;
}
const SH = findSh();
const NO_SH = SH ? false : "no POSIX sh on this machine";
const posix = (p) => p.split(path.sep).join("/");

/** The Dockerfile as instructions: continued lines joined, comment lines dropped (as Docker does). */
function instructions(text) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || (cur === null && !line.trim())) continue;
    const cont = /\\\s*$/.test(line);
    const part = cont ? line.replace(/\\\s*$/, "") : line;
    cur = cur === null ? part : `${cur}\n${part}`;
    if (!cont) {
      const m = /^\s*(\w+)\s+([\s\S]*)$/.exec(cur);
      if (m) out.push({ op: m[1].toUpperCase(), args: m[2].trim() });
      cur = null;
    }
  }
  return out;
}
const STEPS = instructions(DOCKERFILE);
const lastFrom = STEPS.map((s) => s.op).lastIndexOf("FROM");
const RUNTIME = STEPS.slice(lastFrom);
const runStep = (needle) => {
  const i = RUNTIME.findIndex((s) => s.op === "RUN" && s.args.includes(needle));
  assert.ok(i >= 0, `the runtime stage has a RUN step with ${needle}`);
  return { i, cmd: RUNTIME[i].args };
};
const indexOf = (pred, what) => {
  const i = RUNTIME.findIndex(pred);
  assert.ok(i >= 0, what);
  return i;
};
const PIN = /^ARG\s+CLAUDE_CODE_VERSION=(\S+)/m.exec(DOCKERFILE)?.[1];
const agentSdk = JSON.parse(read("node_modules/@anthropic-ai/claude-agent-sdk/package.json"));
const pkg = JSON.parse(read("package.json"));
const CODEX_PIN = pkg.dependencies["@openai/codex-sdk"];

/** A folder of stand-in commands: name -> sh body. */
function stubBin(name, cmds) {
  const dir = path.join(tmp, `bin-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [cmd, body] of Object.entries(cmds)) {
    fs.writeFileSync(path.join(dir, cmd), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return dir;
}
/** A stand-in /app: the Agent SDK's package.json and Tarsee's, at the given versions. */
function fakeApp(name, { claudeCodeVersion, codexSdk }) {
  const dir = path.join(tmp, `app-${name}`);
  const sdkDir = path.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: agentSdk.version, claudeCodeVersion }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "tarsee", dependencies: { "@openai/codex-sdk": codexSdk } }));
  return dir;
}
/** Run one Dockerfile RUN step in sh, as the build would (ARGs are environment variables there). */
function runInSh(cmd, { bin, cwd, env = {} }) {
  return spawnSync(SH, ["-c", cmd], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
}

describe("Dockerfile: Claude Code", () => {
  it("pins the Terminal's claude to the Claude Code the Agent SDK bundles (the one chat turns run)", () => {
    assert.ok(PIN, "ARG CLAUDE_CODE_VERSION=<version>");
    assert.equal(PIN, agentSdk.claudeCodeVersion, `the Agent SDK ${agentSdk.version} bundles Claude Code ${agentSdk.claudeCodeVersion}`);
    assert.equal(pkg.dependencies["@anthropic-ai/claude-agent-sdk"], agentSdk.version, "the SDK itself is pinned exactly");
    const install = runStep("npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}");
    const check = runStep("claudeCodeVersion");
    const copied = indexOf((s) => s.op === "COPY" && /--from=builder\s+\/app\/node_modules/.test(s.args), "node_modules come from the builder");
    assert.ok(check.i > install.i && check.i > copied, "the check runs once both copies are in the image");
  });

  it("the build check passes when both are the pin, and stops the build when either differs", { skip: NO_SH }, () => {
    const { cmd } = runStep("claudeCodeVersion");
    const claude = (v) => stubBin(`claude-${v}`, { claude: `echo "${v} (Claude Code)"` });
    const same = runInSh(cmd, { bin: claude(PIN), cwd: fakeApp("same", { claudeCodeVersion: PIN, codexSdk: CODEX_PIN }), env: { CLAUDE_CODE_VERSION: PIN } });
    assert.equal(same.status, 0, same.stderr + same.stdout);
    const terminalOff = runInSh(cmd, { bin: claude("2.1.1"), cwd: fakeApp("t-off", { claudeCodeVersion: PIN, codexSdk: CODEX_PIN }), env: { CLAUDE_CODE_VERSION: PIN } });
    assert.notEqual(terminalOff.status, 0, "the Terminal's claude differs");
    assert.match(terminalOff.stderr, /CLAUDE_CODE_VERSION/);
    const sdkOff = runInSh(cmd, { bin: claude(PIN), cwd: fakeApp("s-off", { claudeCodeVersion: "2.1.999", codexSdk: CODEX_PIN }), env: { CLAUDE_CODE_VERSION: PIN } });
    assert.notEqual(sdkOff.status, 0, "the Agent SDK bundles another version");
    assert.match(sdkOff.stderr, /2\.1\.999/, "says which version the SDK wants");
    const missing = runInSh(cmd, { bin: stubBin("claude-broken", { claude: "exit 127" }), cwd: fakeApp("missing", { claudeCodeVersion: PIN, codexSdk: CODEX_PIN }), env: { CLAUDE_CODE_VERSION: PIN } });
    assert.notEqual(missing.status, 0, "no working claude");
  });
});

describe("Dockerfile: Codex", () => {
  it("puts the Codex the SDK installed on the PATH as codex, after node_modules are in", () => {
    const bin = JSON.parse(read("node_modules/@openai/codex/package.json")).bin.codex;
    assert.ok(fs.existsSync(path.join(ROOT, "node_modules", "@openai", "codex", bin)), "the launcher is where the link points");
    const link = runStep(`ln -sf /app/node_modules/@openai/codex/${bin.replace(/^\.\//, "")} /usr/local/bin/codex`);
    const copied = indexOf((s) => s.op === "COPY" && /--from=builder\s+\/app\/node_modules/.test(s.args), "node_modules come from the builder");
    assert.ok(link.i > copied);
    const check = runStep("codex --version");
    assert.ok(check.i >= link.i, "checked once linked");
  });

  it("the build check passes on the SDK's pin and stops the build on any other version", { skip: NO_SH }, () => {
    const { cmd } = runStep("codex --version");
    const codex = (v) => stubBin(`codex-${v}`, { codex: `echo "codex-cli ${v}"` });
    const ok = runInSh(cmd, { bin: codex(CODEX_PIN), cwd: fakeApp("codex-ok", { claudeCodeVersion: PIN, codexSdk: CODEX_PIN }) });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    const off = runInSh(cmd, { bin: codex("0.1.0"), cwd: fakeApp("codex-off", { claudeCodeVersion: PIN, codexSdk: CODEX_PIN }) });
    assert.notEqual(off.status, 0);
    assert.match(off.stderr, new RegExp(CODEX_PIN.replace(/\./g, "\\.")), "says which version it wanted");
    const broken = runInSh(cmd, { bin: stubBin("codex-broken", { codex: "exit 1" }), cwd: fakeApp("codex-broken", { claudeCodeVersion: PIN, codexSdk: CODEX_PIN }) });
    assert.notEqual(broken.status, 0);
  });
});

describe("Dockerfile: PDFs", () => {
  it("installs poppler-utils in the image that runs, and checks pdftotext works", { skip: NO_SH }, () => {
    const apt = RUNTIME.find((s) => s.op === "RUN" && s.args.includes("apt-get install"));
    assert.ok(apt && /(^|\s)poppler-utils(\s|$)/.test(apt.args), "poppler-utils in the runtime stage's apt-get install");
    const { cmd } = runStep("pdftotext -v");
    const good = runInSh(cmd, { bin: stubBin("pdf-ok", { pdftotext: 'echo "pdftotext version 22.12.0" >&2' }), cwd: tmp });
    assert.equal(good.status, 0, good.stderr);
    const bad = runInSh(cmd, { bin: stubBin("pdf-bad", { pdftotext: "echo nope >&2; exit 1" }), cwd: tmp });
    assert.notEqual(bad.status, 0);
  });
});

describe("Dockerfile: speech-to-text works on the first try", () => {
  const SRC_VOICE = path.join(ROOT, "src", "voice");
  const sttVersion = /export const FASTER_WHISPER_VERSION = "([\d.]+)"/.exec(read("src/voice/stt-install.js"))?.[1];
  const env = () => {
    const step = RUNTIME.find((s) => s.op === "ENV" && /TARSEE_WHISPER_BUNDLED_DIR/.test(s.args));
    assert.ok(step, "ENV TARSEE_WHISPER_BUNDLED_DIR, where speech-to-text finds the image's models");
    return { i: RUNTIME.indexOf(step), dir: /TARSEE_WHISPER_BUNDLED_DIR[= ](\S+)/.exec(step.args)[1] };
  };

  it("pins faster-whisper to the version Settings > Voice installs where there is no Docker", () => {
    const { cmd } = runStep("pip3 install");
    assert.ok(sttVersion, "stt-install.js FASTER_WHISPER_VERSION");
    assert.equal(/faster-whisper==([\d.]+)/.exec(cmd)?.[1], sttVersion);
  });

  it("ships the default model outside /data (the volume would hide it), after faster-whisper is in", () => {
    const { i: envAt, dir } = env();
    assert.ok(path.posix.isAbsolute(dir));
    assert.ok(!/^\/data(\/|$)/.test(dir), `${dir}: Railway mounts the volume at /data, over anything the image put there`);
    const dl = runStep("whisper-models.js download");
    assert.match(dl.cmd, /download base\.en "\$TARSEE_WHISPER_BUNDLED_DIR"/);
    assert.ok(dl.i > runStep("pip3 install").i, "faster-whisper is installed first, for the check");
    assert.ok(envAt < dl.i);
    const default_ = /export const DEFAULT_WHISPER_MODEL = "([^"]+)"/.exec(read("src/voice/whisper-models.js"))?.[1];
    assert.equal(default_, "base.en", "the model the image ships is the default");
  });

  it("copies in only what the download needs (so a change elsewhere doesn't download the model again)", () => {
    const dl = runStep("whisper-models.js download");
    const copy = RUNTIME.findIndex((s) => s.op === "COPY" && /whisper-models\.js/.test(s.args));
    assert.ok(copy >= 0 && copy < dl.i, "copied before the download");
    assert.doesNotMatch(RUNTIME[copy].args, /\bsrc\s/, "not the whole src/");
    const imports = (file) => [...fs.readFileSync(path.join(SRC_VOICE, file), "utf8").matchAll(/^import .* from "(\.{1,2}\/[^"]+)"/gm)].map((m) => m[1]);
    for (const rel of imports("whisper-models.js")) {
      assert.match(rel, /^\.\/[\w.-]+\.js$/, "only files next to it");
      assert.ok(RUNTIME[copy].args.includes(`src/voice/${rel.slice(2)}`), `${rel} is copied too`);
      assert.deepEqual(imports(rel.slice(2)), [], `${rel} imports nothing of Tarsee's`);
    }
  });

  it("the build checks the model loads offline and transcribes, and the build stops if it doesn't", { skip: NO_SH }, () => {
    const dl = runStep("whisper-models.js download");
    const check = runStep("from stt_worker import decode");
    assert.ok(check.i > dl.i, "the check runs on the model just downloaded");
    assert.match(check.cmd, /HF_HUB_OFFLINE=1 python3 -I -c "[^"]*WhisperModel\(sys\.argv\[1\][^"]*\.transcribe\(decode\(f\)[^"]*"/,
      "a real WAV through the worker's own decode(), as every recording goes: a blank array skipped the decoder, which newer PyAV broke");
    const workerCopy = RUNTIME.findIndex((s) => s.op === "COPY" && /src\/voice\/stt_worker\.py/.test(s.args));
    assert.ok(workerCopy > dl.i && workerCopy < check.i, "the worker comes in after the download, so changing it doesn't download the model again");
    assert.match(dl.cmd, /^set -e;/);
    assert.match(check.cmd, /^set -e;/);
    const build = path.join(tmp, "stt-build");
    const checkDir = path.join(tmp, "stt-check");
    const models = path.join(tmp, "stt-image-models");
    const log = path.join(tmp, "stt-build.log");
    // The folders come from the environment (a path with an apostrophe breaks sh quoting). The two steps run in turn.
    const cmd = [dl.cmd.replaceAll("/opt/tarsee/stt-build", "$STT_BUILD"), check.cmd.replaceAll("/opt/tarsee/stt-check", "$STT_CHECK")].join("\n");
    const run = (pythonExit) => {
      for (const d of [build, checkDir]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
      fs.rmSync(log, { force: true });
      const bin = stubBin(`stt-${pythonExit}`, {
        node: 'echo "node $* [$(cat package.json)]" >> "$STT_LOG"; mkdir -p "$4/$3"',
        python3: `echo "python3 HF_HUB_OFFLINE=$HF_HUB_OFFLINE $1 $2 ... \${4:-} \${5:-}" >> "$STT_LOG"; exit ${pythonExit}`,
      });
      return runInSh(cmd, { bin, cwd: tmp, env: { STT_BUILD: posix(build), STT_CHECK: posix(checkDir), STT_LOG: posix(log), TARSEE_WHISPER_BUNDLED_DIR: posix(models) } });
    };
    const ok = run(0);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    const lines = fs.readFileSync(log, "utf8").trim().split(/\r?\n/);
    assert.match(lines[0], /^node whisper-models\.js download base\.en \S+stt-image-models \[\{"type":"module"\}\]$/);
    assert.match(lines[1], /^python3 HF_HUB_OFFLINE=1 -I -c \.\.\. \S+stt-image-models\/base\.en/);
    assert.ok(fs.existsSync(path.join(models, "base.en")));
    assert.equal(fs.existsSync(build), false, "the build files are removed");
    assert.equal(fs.existsSync(checkDir), false, "and the check's");
    const bad = run(1);
    assert.notEqual(bad.status, 0, "a model that doesn't load stops the build");
  });
});

// --- entrypoint.sh ---

const HOMES =[".claude-code-home", ".claude-home-anthropic", ".claude-home-deepseek", ".claude-home-openrouter", ".codex-home", ".codex-home-keys"];
const CANARY = "sk-test-canary-entrypoint-0000";

/**
 * Source entrypoint.sh in sh (its main part doesn't run) and call one of its functions. The file and the arguments
 * go through the environment: on Windows, Git's sh reads its command line itself and takes an apostrophe in a path
 * (a user folder like C:\Users\O'Brien) for a quote.
 */
function callEntrypoint(fn, args, env = {}) {
  const argEnv = Object.fromEntries(args.map((a, i) => [`TEST_EP_ARG${i + 1}`, a]));
  const call = ["\"$TEST_EP_FN\"", ...args.map((_, i) => `"$TEST_EP_ARG${i + 1}"`)].join(" ");
  return spawnSync(SH, ["-c", `. "$TEST_EP_FILE"; ${call}`], {
    encoding: "utf8",
    env: { ...process.env, ...env, ...argEnv, TEST_EP_FILE: posix(ENTRYPOINT), TEST_EP_FN: fn },
  });
}
function freshDirs(name) {
  const state = path.join(tmp, `state-${name}`);
  const home = path.join(tmp, `home-${name}`);
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { state, home };
}
/** The root names a TOML file sets before its first [table], and every key name set anywhere. */
function tomlShape(text) {
  const root = [];
  const all = [];
  let atRoot = true;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    if (/^\s*\[/.test(line)) { atRoot = false; continue; }
    const k = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    if (k) { all.push(k); if (atRoot) root.push(k); }
  }
  return { root, all };
}
const SEEDED = { cli_auth_credentials_store: '"file"', check_for_update_on_startup: "false" };
function rootValue(text, key) {
  const head = text.split(/^\s*\[/m)[0];
  return new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(head)?.[1];
}

describe("entrypoint.sh: the AI providers' sign-in folders", { skip: NO_SH }, () => {
  it("sourcing it runs nothing (only its functions are defined)", () => {
    const r = spawnSync(SH, ["-c", '. "$TEST_EP_FILE"; echo sourced'], { encoding: "utf8", env: { ...process.env, TEST_EP_FILE: posix(ENTRYPOINT) } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "sourced");
  });

  it("makes every home, owner-only, and links ~/.claude and ~/.codex to the plan homes", () => {
    const { state, home } = freshDirs("homes");
    const r = callEntrypoint("setup_provider_homes", [posix(state), posix(home), ""]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const h of HOMES) {
      const st = fs.statSync(path.join(state, h));
      assert.ok(st.isDirectory(), h);
      if (!WIN) assert.equal(st.mode & 0o777, 0o700, `${h} is mode 700`);
    }
    if (!WIN) {
      assert.equal(fs.readlinkSync(path.join(home, ".claude")), posix(path.join(state, ".claude-code-home")));
      assert.equal(fs.readlinkSync(path.join(home, ".codex")), posix(path.join(state, ".codex-home")));
      for (const f of ["config.toml"]) {
        assert.equal(fs.statSync(path.join(state, ".codex-home", f)).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.join(state, ".codex-home-keys", f)).mode & 0o777, 0o600);
      }
    } else {
      assert.ok(fs.existsSync(path.join(home, ".claude")) && fs.existsSync(path.join(home, ".codex")));
    }
  });

  it("seeds each Codex home's config.toml with Tarsee's settings and the home's sign-in kind, and no key", () => {
    const { state, home } = freshDirs("seed");
    const r = callEntrypoint("setup_provider_homes", [posix(state), posix(home), ""], {
      OPENAI_API_KEY: CANARY, CLAUDE_CODE_OAUTH_TOKEN: CANARY, DEEPSEEK_API_KEY: CANARY, OPENROUTER_API_KEY: CANARY,
    });
    assert.equal(r.status, 0, r.stderr);
    for (const [h, method] of [[".codex-home", '"chatgpt"'], [".codex-home-keys", '"api"']]) {
      const text = fs.readFileSync(path.join(state, h, "config.toml"), "utf8");
      const { root, all } = tomlShape(text);
      assert.deepEqual([...root].sort(), ["check_for_update_on_startup", "cli_auth_credentials_store", "forced_login_method"], h);
      assert.deepEqual(all, root, "nothing but those three");
      for (const [k, v] of Object.entries(SEEDED)) assert.equal(rootValue(text, k), v, `${h} ${k}`);
      assert.equal(rootValue(text, "forced_login_method"), method, `${h} signs in with ${method} only`);
      assert.ok(root.every((k) => CODEX_CONFIG_ALLOWED.includes(k)));
      assert.deepEqual(codexConfigGuard(codexConfigFilesFor({ home: path.join(state, h) })), { ok: true, files: [] }, "Codex's guard accepts it");
    }
    assert.equal(r.stdout.includes(CANARY) || r.stderr.includes(CANARY), false);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(state)) assert.equal(fs.readFileSync(f, "utf8").includes(CANARY), false, `${f} holds no key`);
  });

  it("keeps what Codex wrote there, puts missing settings at the top (never inside a table), fixes a wrong sign-in kind, and runs again unchanged", () => {
    const { state, home } = freshDirs("keep");
    fs.mkdirSync(path.join(state, ".codex-home"), { recursive: true });
    fs.mkdirSync(path.join(state, ".codex-home-keys"), { recursive: true });
    const codexWrote = [
      'model = "a-model-the-terminal-chose"',
      'forced_login_method = "api"',
      "",
      '[projects."/data/tarsee/workspace"]',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(state, ".codex-home", "config.toml"), codexWrote);
    // A setting indented with a tab is still that setting (the image's awk is mawk: no [[:space:]] needed).
    fs.writeFileSync(path.join(state, ".codex-home-keys", "config.toml"), '\tcheck_for_update_on_startup = false\n forced_login_method = "chatgpt"\n[notice]\nhide_full_access_warning = true\n');
    assert.equal(callEntrypoint("setup_provider_homes", [posix(state), posix(home), ""]).status, 0);
    const plan = fs.readFileSync(path.join(state, ".codex-home", "config.toml"), "utf8");
    assert.equal(rootValue(plan, "model"), '"a-model-the-terminal-chose"', "Codex's own setting stays");
    assert.equal(rootValue(plan, "forced_login_method"), '"chatgpt"', "the plan home signs in with ChatGPT only");
    assert.equal(rootValue(plan, "cli_auth_credentials_store"), '"file"');
    assert.match(plan, /\[projects\."\/data\/tarsee\/workspace"\]\r?\ntrust_level = "trusted"/, "the table and what's in it stay");
    const shape = tomlShape(plan);
    for (const k of ["cli_auth_credentials_store", "check_for_update_on_startup", "forced_login_method"]) {
      assert.equal(shape.all.filter((x) => x === k).length, 1, `${k} once`);
      assert.ok(shape.root.includes(k), `${k} at the top level`);
    }
    const keys = fs.readFileSync(path.join(state, ".codex-home-keys", "config.toml"), "utf8");
    assert.equal(rootValue(keys, "forced_login_method"), '"api"', "the keys home never takes a ChatGPT sign-in");
    assert.equal(tomlShape(keys).all.filter((x) => x === "check_for_update_on_startup").length, 1);
    assert.match(keys, /\[notice\]\r?\nhide_full_access_warning = true/);
    for (const h of [".codex-home", ".codex-home-keys"]) {
      assert.equal(codexConfigGuard(codexConfigFilesFor({ home: path.join(state, h) })).ok, true, h);
    }
    const before = [plan, keys];
    assert.equal(callEntrypoint("setup_provider_homes", [posix(state), posix(home), ""]).status, 0);
    assert.deepEqual([fs.readFileSync(path.join(state, ".codex-home", "config.toml"), "utf8"), fs.readFileSync(path.join(state, ".codex-home-keys", "config.toml"), "utf8")], before, "a second boot changes nothing");
  });

  it("logs one sign-in line per engine, and warns when a key home holds a sign-in", () => {
    const { state, home } = freshDirs("report");
    assert.equal(callEntrypoint("setup_provider_homes", [posix(state), posix(home), ""]).status, 0);
    const none = callEntrypoint("report_sign_ins", [posix(state)], { CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "" });
    assert.equal(none.status, 0, none.stderr);
    const lines = none.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 2, none.stdout);
    assert.match(lines[0], /^\[entrypoint\] Claude Code: .*no Claude plan sign-in.*claude auth login/i);
    assert.match(lines[1], /^\[entrypoint\] Codex: .*no ChatGPT plan sign-in.*codex login --device-auth/i);

    const byVar = callEntrypoint("report_sign_ins", [posix(state)], { CLAUDE_CODE_OAUTH_TOKEN: CANARY });
    assert.match(byVar.stdout, /Claude Code: .*CLAUDE_CODE_OAUTH_TOKEN/);
    assert.equal(byVar.stdout.includes(CANARY), false, "never the token itself");

    fs.writeFileSync(path.join(state, ".claude-code-home", ".credentials.json"), "{}");
    fs.writeFileSync(path.join(state, ".codex-home", "auth.json"), "{}");
    const signed = callEntrypoint("report_sign_ins", [posix(state)], { CLAUDE_CODE_OAUTH_TOKEN: "" });
    assert.match(signed.stdout, /Claude Code: Claude plan signed in/);
    assert.match(signed.stdout, /Codex: ChatGPT plan signed in/);
    assert.doesNotMatch(signed.stdout, /warning/i);

    fs.writeFileSync(path.join(state, ".codex-home-keys", "auth.json"), "{}");
    fs.writeFileSync(path.join(state, ".claude-home-deepseek", ".credentials.json"), "{}");
    const leaked = callEntrypoint("report_sign_ins", [posix(state)]);
    assert.match(leaked.stdout, /warning: .*\.codex-home-keys.*auth\.json/);
    assert.match(leaked.stdout, /warning: .*\.claude-home-deepseek.*\.credentials\.json/);
  });
});

// The Claude plan home across boots and versions (carry_plan_home <volume> <state dir>, then setup_provider_homes).
const NO_TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "" };
/** One boot's part of main(): the state folder exists (main makes it), then carry_plan_home, then setup_provider_homes. */
function boot(vol, state, home) {
  fs.mkdirSync(state, { recursive: true });
  const carry = callEntrypoint("carry_plan_home", [posix(vol), posix(state)]);
  assert.equal(carry.status, 0, carry.stderr + carry.stdout);
  const setup = callEntrypoint("setup_provider_homes", [posix(state), posix(home), ""]);
  assert.equal(setup.status, 0, setup.stderr + setup.stdout);
  return carry.stdout;
}
/** Every file and folder under a folder, with each file's text: what a boot changed. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isSymbolicLink()) out.push(`${rel} -> ${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) { out.push(`${rel}/`); walk(p); }
      else out.push(`${rel}: ${fs.readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out;
}
const readIn = (dir, ...rel) => fs.readFileSync(path.join(dir, ...rel), "utf8");

// Versions before multi-provider support (main, 7e5563d) kept the Claude plan's sign-in in
// /data/tarsee/.claude-code-home whatever TARSEE_STATE_DIR said; this version keeps it in
// $TARSEE_STATE_DIR/.claude-code-home. On the first boot after that upgrade, carry_plan_home moves it there once.
describe("entrypoint.sh: an install upgraded from main with its own TARSEE_STATE_DIR keeps its Claude plan sign-in", { skip: NO_SH }, () => {
  /** main's volume: <volume>/tarsee/.claude-code-home holding a sign-in and a chat's transcript, and no .codex-home. */
  function mainVolume(name) {
    const vol = path.join(tmp, `vol-${name}`);
    const old = path.join(vol, "tarsee", ".claude-code-home");
    fs.mkdirSync(path.join(old, "projects", "x"), { recursive: true });
    fs.writeFileSync(path.join(old, ".credentials.json"), '{"claudeAiOauth":{"note":"main\'s sign-in"}}');
    fs.writeFileSync(path.join(old, "projects", "x", "s.jsonl"), '{"type":"user","message":"from main"}\n');
    const home = path.join(tmp, `home-vol-${name}`);
    fs.mkdirSync(home, { recursive: true });
    return { vol, old, home };
  }

  it("moves main's sign-in and chat transcripts into the state folder's plan home, where ~/.claude points, once", () => {
    const { vol, old, home } = mainVolume("move");
    const state = path.join(vol, "state");
    const said = boot(vol, state, home);
    assert.match(said, /^\[entrypoint\] Claude Code: moved the Claude plan sign-in/m);
    assert.match(readIn(home, ".claude", ".credentials.json"), /main's sign-in/, "~/.claude holds main's sign-in");
    assert.match(readIn(home, ".claude", "projects", "x", "s.jsonl"), /from main/, "and main's chat transcript");
    if (!WIN) assert.equal(fs.readlinkSync(path.join(home, ".claude")), posix(path.join(state, ".claude-code-home")));
    assert.equal(fs.existsSync(old), false, "moved, not copied: no second copy of the sign-in is left behind");
    const report = callEntrypoint("report_sign_ins", [posix(state)], NO_TOKEN);
    assert.match(report.stdout, /Claude Code: Claude plan signed in/);

    const before = snapshot(vol);
    assert.equal(boot(vol, state, home), "", "a second boot says nothing");
    assert.deepEqual(snapshot(vol), before, "and changes nothing");
  });

  it("still moves it when an earlier boot of this version already made an empty plan home there", () => {
    const { vol, home } = mainVolume("rebooted");
    const state = path.join(vol, "state");
    fs.mkdirSync(state, { recursive: true });
    assert.equal(callEntrypoint("setup_provider_homes", [posix(state), posix(home), ""]).status, 0, "the earlier boot");
    boot(vol, state, home);
    assert.match(readIn(state, ".claude-code-home", ".credentials.json"), /main's sign-in/);
    assert.match(readIn(state, ".claude-code-home", "projects", "x", "s.jsonl"), /from main/);
  });

  it("never replaces what the plan home already has: files both have stay where they are", () => {
    const { vol, old, home } = mainVolume("merge");
    const state = path.join(vol, "state");
    const plan = path.join(state, ".claude-code-home");
    fs.mkdirSync(path.join(plan, "projects", "x"), { recursive: true });
    fs.writeFileSync(path.join(plan, "projects", "x", "s.jsonl"), "made after the upgrade\n");
    fs.writeFileSync(path.join(plan, "projects", "x", "t.jsonl"), "another chat\n");
    fs.writeFileSync(path.join(old, "projects", "x", "u.jsonl"), "one more of main's chats\n");
    const said = boot(vol, state, home);
    assert.match(readIn(plan, ".credentials.json"), /main's sign-in/, "the sign-in moves");
    assert.equal(readIn(plan, "projects", "x", "s.jsonl"), "made after the upgrade\n", "a file the plan home has is kept");
    assert.equal(readIn(plan, "projects", "x", "t.jsonl"), "another chat\n");
    assert.equal(readIn(plan, "projects", "x", "u.jsonl"), "one more of main's chats\n", "a file it lacks moves in, folders merged");
    assert.match(readIn(old, "projects", "x", "s.jsonl"), /from main/, "the other copy stays in the old folder");
    assert.equal(fs.existsSync(path.join(old, ".credentials.json")), false);
    assert.ok(said.includes(posix(old)), `says what stayed where: ${said}`);
    const before = snapshot(vol);
    assert.equal(boot(vol, state, home), "", "a second boot says nothing");
    assert.deepEqual(snapshot(vol), before, "and changes nothing");
  });

  it("keeps a plan home that is already signed in, and takes main's sign-in out of use so a sign-out there can't bring it back", () => {
    const { vol, old, home } = mainVolume("signed");
    const state = path.join(vol, "state");
    const plan = path.join(state, ".claude-code-home");
    fs.mkdirSync(plan, { recursive: true });
    fs.writeFileSync(path.join(plan, ".credentials.json"), '{"note":"a newer sign-in"}');
    const said = boot(vol, state, home);
    assert.match(readIn(plan, ".credentials.json"), /a newer sign-in/, "the plan home keeps its own sign-in");
    assert.equal(fs.existsSync(path.join(old, ".credentials.json")), false, "main's sign-in is no longer named .credentials.json");
    assert.match(readIn(old, ".credentials.json.superseded"), /main's sign-in/, "renamed, not deleted");
    assert.match(readIn(old, "projects", "x", "s.jsonl"), /from main/, "nothing else in the old folder changes");
    assert.ok(said.includes(posix(path.join(old, ".credentials.json.superseded"))), `says where it is now: ${said}`);
    assert.doesNotMatch(said, /moved the Claude plan sign-in/);

    // The owner signs out in the Terminal (claude auth logout deletes .credentials.json), then Tarsee restarts.
    fs.rmSync(path.join(plan, ".credentials.json"));
    const before = snapshot(vol);
    assert.equal(boot(vol, state, home), "", "the next boot says nothing");
    assert.deepEqual(snapshot(vol), before, "and brings no sign-in back");
    const report = callEntrypoint("report_sign_ins", [posix(state)], NO_TOKEN);
    assert.match(report.stdout, /Claude Code: no Claude plan sign-in/, "the sign-out holds");
  });

  it("never replaces a sign-in an earlier boot renamed", () => {
    const { vol, old, home } = mainVolume("superseded-twice");
    fs.writeFileSync(path.join(old, ".credentials.json.superseded"), '{"note":"renamed on an earlier boot"}');
    const state = path.join(vol, "state");
    fs.mkdirSync(path.join(state, ".claude-code-home"), { recursive: true });
    fs.writeFileSync(path.join(state, ".claude-code-home", ".credentials.json"), '{"note":"a newer sign-in"}');
    const said = boot(vol, state, home);
    assert.equal(readIn(old, ".credentials.json.superseded"), '{"note":"renamed on an earlier boot"}', "the earlier one stays as it was");
    assert.match(readIn(old, ".credentials.json.superseded.2"), /main's sign-in/, "this one takes the next free name");
    assert.equal(fs.existsSync(path.join(old, ".credentials.json")), false);
    assert.ok(said.includes(posix(path.join(old, ".credentials.json.superseded.2"))), `says where it is now: ${said}`);
  });

  it("does nothing on the default layout (TARSEE_STATE_DIR is <volume>/tarsee), boot after boot, or on a new install", () => {
    const { vol, old, home } = mainVolume("default");
    const before = snapshot(old);
    assert.equal(boot(vol, path.join(vol, "tarsee"), home), "");
    assert.deepEqual(snapshot(old), before, "the plan home is as it was");
    assert.match(readIn(home, ".claude", ".credentials.json"), /main's sign-in/);
    const after1 = snapshot(vol);
    assert.equal(boot(vol, path.join(vol, "tarsee"), home), "", "the next boot (now this version's own layout) says nothing either");
    assert.deepEqual(snapshot(vol), after1);

    const fresh = path.join(tmp, "vol-fresh");
    fs.mkdirSync(fresh, { recursive: true });
    assert.equal(boot(fresh, path.join(fresh, "state"), path.join(tmp, "home-vol-fresh")), "");
  });

  it("keeps the sign-in on the volume when the state folder is off it, and says where it is", () => {
    const { vol, old, home } = mainVolume("offvol");
    const state = path.join(tmp, "not-the-volume", "state");
    const before = snapshot(old);
    const said = boot(vol, state, home);
    assert.deepEqual(snapshot(old), before, "the only copy of the sign-in stays on the volume");
    assert.equal(fs.existsSync(path.join(state, ".claude-code-home", ".credentials.json")), false);
    assert.ok(said.includes(posix(old)) && /TARSEE_STATE_DIR/.test(said), `says where the sign-in is: ${said}`);
  });

  it("leaves main's sign-in exactly as it is when a state folder off the volume is already signed in", () => {
    const { vol, old, home } = mainVolume("offvol-signed");
    const state = path.join(tmp, "not-the-volume", "state-signed");
    fs.mkdirSync(path.join(state, ".claude-code-home"), { recursive: true });
    fs.writeFileSync(path.join(state, ".claude-code-home", ".credentials.json"), '{"note":"a sign-in off the volume"}');
    const before = snapshot(old);
    assert.equal(boot(vol, state, home), "");
    assert.deepEqual(snapshot(old), before, "not renamed: it is still the only sign-in a redeploy keeps");
    assert.match(readIn(state, ".claude-code-home", ".credentials.json"), /off the volume/);
  });
});

// This version keeps everything, the Claude plan sign-in included, in $TARSEE_STATE_DIR. So once it has used
// <volume>/tarsee as its state folder (every boot of it makes a .codex-home there; main never did), the plan home there
// is that install's own, and a later change of TARSEE_STATE_DIR moves nothing out of it.
describe("entrypoint.sh: changing TARSEE_STATE_DIR on this version moves no sign-in", { skip: NO_SH }, () => {
  /** This version's default install: booted with <volume>/tarsee, then signed in to the Claude plan with one chat. */
  function ownVolume(name) {
    const vol = path.join(tmp, `own-${name}`);
    const own = path.join(vol, "tarsee");
    const home = path.join(tmp, `home-own-${name}`);
    fs.mkdirSync(home, { recursive: true });
    assert.equal(boot(vol, own, home), "", "the first boot");
    const plan = path.join(own, ".claude-code-home");
    fs.mkdirSync(path.join(plan, "projects", "x"), { recursive: true });
    fs.writeFileSync(path.join(plan, ".credentials.json"), '{"claudeAiOauth":{"note":"this install\'s sign-in"}}');
    fs.writeFileSync(path.join(plan, "projects", "x", "s.jsonl"), '{"type":"user","message":"a chat"}\n');
    return { vol, own, plan, home };
  }

  it("leaves the default folder's sign-in and chats where they are, so setting the variable back finds them", () => {
    const { vol, own, plan, home } = ownVolume("revert");
    const before = snapshot(plan);
    const other = path.join(vol, "other");
    const said = boot(vol, other, home);
    assert.deepEqual(snapshot(plan), before, "nothing moves out of it");
    assert.equal(fs.existsSync(path.join(other, ".claude-code-home", ".credentials.json")), false);
    assert.doesNotMatch(said, /moved the Claude plan sign-in/);
    assert.ok(said.includes(posix(plan)) && said.includes(`TARSEE_STATE_DIR back to ${posix(own)}`), `says where the sign-in is and how to use it: ${said}`);

    assert.equal(boot(vol, own, home), "", "set back: nothing to say");
    assert.deepEqual(snapshot(plan), before);
    const report = callEntrypoint("report_sign_ins", [posix(own)], NO_TOKEN);
    assert.match(report.stdout, /Claude Code: Claude plan signed in/);
    assert.match(readIn(home, ".claude", "projects", "x", "s.jsonl"), /a chat/, "the chat is where ~/.claude points");
  });

  it("renames nothing and moves nothing between two folders this version signed in, before or after a sign-out", () => {
    const { vol, plan, home } = ownVolume("both");
    const other = path.join(vol, "other");
    boot(vol, other, home);
    const otherPlan = path.join(other, ".claude-code-home");
    fs.writeFileSync(path.join(otherPlan, ".credentials.json"), '{"note":"signed in with the other folder"}');
    const before = snapshot(plan);
    assert.equal(boot(vol, other, home), "", "both signed in: nothing to say");
    assert.deepEqual(snapshot(plan), before, "the default folder's sign-in keeps its name");

    fs.rmSync(path.join(otherPlan, ".credentials.json"));
    boot(vol, other, home);
    assert.equal(fs.existsSync(path.join(otherPlan, ".credentials.json")), false, "a sign-out in the other folder holds");
    assert.deepEqual(snapshot(plan), before);
  });
});

describe("entrypoint.sh: start-up", () => {
  const text = fs.readFileSync(ENTRYPOINT, "utf8");
  const lines = text.split(/\r?\n/);
  const at = (re) => lines.findIndex((l) => re.test(l));
  /** main()'s `if [ -d /data ]; then` block (the volume is there): its first and last line. */
  const volumeBlock = () => {
    const start = at(/^\s*if \[ -d \/data \]; then\s*$/);
    assert.ok(start >= 0, "main() has an if [ -d /data ]; then block");
    const indent = /^\s*/.exec(lines[start])[0];
    const end = lines.findIndex((l, i) => i > start && l === `${indent}fi`);
    assert.ok(end > start, "and it ends");
    return { start, end };
  };
  it("sets up the homes and reports the sign-ins on the volume", () => {
    assert.ok(at(/^\s*setup_provider_homes\s+"?\$STATE_DIR"?\s+\/home\/node\s+node:node/) >= 0, "setup_provider_homes \"$STATE_DIR\" /home/node node:node");
    assert.ok(at(/^\s*report_sign_ins\s+"?\$STATE_DIR"?/) >= 0);
  });
  it("moves main's Claude plan sign-in to the state folder before it links ~/.claude there", () => {
    const { start, end } = volumeBlock();
    const carry = at(/^\s*carry_plan_home\s+\/data\s+"\$STATE_DIR"\s*$/);
    const setup = at(/^\s*setup_provider_homes\s+"?\$STATE_DIR"?\s/);
    assert.ok(carry > start && carry < end, "carry_plan_home /data \"$STATE_DIR\", on the volume");
    assert.ok(carry < setup, "before setup_provider_homes");
  });
  it("tells the server the state folder it set up, so the server reads the same sign-ins, keys and workspace", () => {
    // Without it, a docker run with a volume (no TARSEE_STATE_DIR, no Railway) has the server in ~/.tarsee, off the
    // volume, while CODEX_HOME and ~/.codex point at the volume (src/config/env.js resolveStateDir).
    const { start, end } = volumeBlock();
    const exp = at(/^\s*export TARSEE_STATE_DIR="\$STATE_DIR"\s*$/);
    assert.ok(exp > start && exp < end, "export TARSEE_STATE_DIR=\"$STATE_DIR\" when the volume is there (else the server keeps ~/.tarsee)");
    assert.ok(at(/^\s*exec gosu node node src\/server\.js\s*$/) > exp, "before the server starts");
  });
  it("exports CODEX_HOME (the ChatGPT plan home) before it drops to the node user", () => {
    const exp = at(/^\s*export CODEX_HOME="?\$STATE_DIR\/\.codex-home"?\s*$/);
    const gosu = at(/^\s*exec gosu node node src\/server\.js\s*$/);
    assert.ok(exp >= 0, "export CODEX_HOME=$STATE_DIR/.codex-home");
    assert.ok(gosu > exp);
  });
  it("is kept with LF line endings, or sh can't run it in the image", () => {
    assert.match(read(".gitattributes"), /^entrypoint\.sh\s+text\s+eol=lf/m);
    assert.equal(text.includes("\r\n"), false);
  });
});
