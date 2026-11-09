// The image and its boot (docs/superpowers/specs/2026-11-09-multi-provider-design.md 4.16, Phase 5 "Image and boot").
// - Dockerfile: the Terminal's `claude` is pinned to the Claude Code version the Agent SDK bundles (the one chat turns
//   run), and the build stops when the two differ; the Codex the SDK installed is on the PATH as `codex`, and the build
//   stops when its version isn't the SDK pin; pdftotext (poppler-utils) is installed. No docker here, so the build
//   checks are run for real in sh against stand-in `claude`, `codex` and `pdftotext` commands.
// - entrypoint.sh: every AI provider's sign-in folder exists on the volume, owner-only; /home/node/.claude and
//   /home/node/.codex link to the plan homes; each Codex home has a config.toml with Tarsee's three settings and never a
//   key, that Codex's guard accepts; CODEX_HOME is exported before the server starts; one sign-in line per engine.
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

// --- entrypoint.sh ---

const HOMES = [".claude-code-home", ".claude-home-anthropic", ".claude-home-deepseek", ".claude-home-openrouter", ".codex-home", ".codex-home-keys"];
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

describe("entrypoint.sh: start-up", () => {
  const text = fs.readFileSync(ENTRYPOINT, "utf8");
  const lines = text.split(/\r?\n/);
  const at = (re) => lines.findIndex((l) => re.test(l));
  it("sets up the homes and reports the sign-ins on the volume", () => {
    assert.ok(at(/^\s*setup_provider_homes\s+"?\$STATE_DIR"?\s+\/home\/node\s+node:node/) >= 0, "setup_provider_homes \"$STATE_DIR\" /home/node node:node");
    assert.ok(at(/^\s*report_sign_ins\s+"?\$STATE_DIR"?/) >= 0);
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
