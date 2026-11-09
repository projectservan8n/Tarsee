/**
 * codex-cli.js: running the pinned Codex CLI for the jobs Tarsee does outside a chat turn: the ChatGPT sign-in
 * (codex-device-login.js) and the signed-in account's model list (codex-models.js). Turns themselves go through the
 * Codex SDK (providers/codex.js); this is the small part both of those other jobs share:
 *
 *   resolveCodexBin()   which codex to run: an explicit path, TARSEE_CODEX_BIN, or the binary the pinned
 *                       @openai/codex package installed for this platform (found the way the SDK finds it)
 *   codexChildEnv()     the server's environment minus every credential (engine-env's baseEnv, rule R2), plus
 *                       CODEX_HOME: a sign-in started here can only ever see its own home
 *   spawnCodex()        start it (a .cmd/.bat shim on Windows goes through cmd.exe, which Node requires)
 *   killTree()          stop it and everything it started: taskkill /T /F on Windows, the process group elsewhere
 *   runCodex()          run one command to the end with a time limit and capped output
 *
 * CODEX_BASE_ARGS keep the sign-in in $CODEX_HOME/auth.json (never an OS keyring Tarsee can't see), skip the update
 * check and switch off the project root search (project_root_markers=[]), as every Codex turn does (design 4.8): these
 * jobs run in the Codex home, inside Tarsee's state folder, and without it Codex would take the nearest folder above
 * with .git as a project root and load a .codex/config.toml from each folder between, which no guard reads.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { baseEnv } from "./engine-env.js";

export const CODEX_BASE_ARGS = Object.freeze([
  "-c", 'cli_auth_credentials_store="file"',
  "-c", "check_for_update_on_startup=false",
  "-c", "project_root_markers=[]",
]);

/** A codex job that can't run; code is codex-missing (no binary for this system) or spawn-failed. */
export class CodexCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodexCliError";
    this.code = code;
  }
}

const MISSING_MESSAGE = "Codex isn't installed here (the @openai/codex package or its program for this system is missing). Reinstall Tarsee's dependencies.";

/** The platform packages @openai/codex installs, as the Codex SDK maps them. */
const TARGETS = {
  "linux-x64": ["x86_64-unknown-linux-musl", "@openai/codex-linux-x64"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "@openai/codex-linux-arm64"],
  "darwin-x64": ["x86_64-apple-darwin", "@openai/codex-darwin-x64"],
  "darwin-arm64": ["aarch64-apple-darwin", "@openai/codex-darwin-arm64"],
  "win32-x64": ["x86_64-pc-windows-msvc", "@openai/codex-win32-x64"],
  "win32-arm64": ["aarch64-pc-windows-msvc", "@openai/codex-win32-arm64"],
};

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** The @openai/codex package.json: hoisted next to Tarsee, or under the SDK that depends on it. */
function codexPackageJson() {
  const req = createRequire(import.meta.url);
  try { return req.resolve("@openai/codex/package.json"); } catch {}
  try {
    const sdkEntry = fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
    return createRequire(sdkEntry).resolve("@openai/codex/package.json");
  } catch {}
  return null;
}

/** The codex binary the pinned @openai/codex installed for this platform. Throws CodexCliError codex-missing. */
export function pinnedCodexBin({ platform = process.platform, arch = process.arch } = {}) {
  const target = TARGETS[`${platform === "android" ? "linux" : platform}-${arch}`];
  if (!target) throw new CodexCliError("codex-missing", `Codex doesn't run on this system (${platform} ${arch}).`);
  const [triple, pkg] = target;
  const codexJson = codexPackageJson();
  if (!codexJson) throw new CodexCliError("codex-missing", MISSING_MESSAGE);
  let platformJson;
  try { platformJson = createRequire(codexJson).resolve(`${pkg}/package.json`); } catch {
    throw new CodexCliError("codex-missing", MISSING_MESSAGE);
  }
  const root = path.join(path.dirname(platformJson), "vendor", triple);
  const name = platform === "win32" ? "codex.exe" : "codex";
  for (const candidate of [path.join(root, "bin", name), path.join(root, "codex", name)]) {
    if (isFile(candidate)) return candidate;
  }
  throw new CodexCliError("codex-missing", MISSING_MESSAGE);
}

/**
 * Which codex to run: `codexBin` when given, else TARSEE_CODEX_BIN (the same override the Codex engine honours),
 * else the pinned binary. An explicit path that isn't a file is refused here, so the error is plain instead of a
 * shell's "not recognized".
 */
export function resolveCodexBin({ codexBin, env = process.env } = {}) {
  const explicit = String(codexBin || env?.TARSEE_CODEX_BIN || "").trim();
  if (!explicit) return pinnedCodexBin();
  if (!isFile(explicit)) throw new CodexCliError("codex-missing", MISSING_MESSAGE);
  return explicit;
}

/** The folder Codex keeps this sign-in in, as an absolute path. There is no default: the caller names the home. */
export function requireCodexHome(codexHome) {
  const home = String(codexHome ?? "").trim();
  if (!home) throw new TypeError("codex: codexHome is required (engine-env homeFor('chatgpt', 'codex', { stateDir }))");
  return path.resolve(home);
}

/**
 * The environment a codex job runs with: the server's env minus every credential, Tarsee secret and Railway provider
 * key (so no OPENAI_API_KEY, CODEX_API_KEY or OPENAI_BASE_URL can steer it), plus CODEX_HOME and any `extra`.
 */
export function codexChildEnv(env, codexHome, extra = {}) {
  return { ...baseEnv(env ?? process.env), ...extra, CODEX_HOME: codexHome };
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const ANSI_OTHER = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");

/** Terminal colour and control sequences taken out, so what's left is the words the CLI printed. */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_OTHER, "");
}

/** An argument quoted the way a Windows program reads its command line. */
function winArg(arg) {
  const s = String(arg);
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Start codex with pipes on all three streams. On Windows a .cmd/.bat (a shim) runs through cmd.exe, as Node
 * requires; anything else starts directly, and outside Windows in its own process group so killTree() reaches
 * whatever it starts.
 */
export function spawnCodex(bin, args, { env, cwd } = {}) {
  const opts = { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
  let child;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin, ...args].map(winArg).join(" ");
    child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  } else {
    child = spawn(bin, args, { ...opts, detached: process.platform !== "win32" });
  }
  // Always someone listening: a child's "error" (a failed start, a failed kill) with no listener would take the
  // whole server down. Callers add their own listeners for what they need to know.
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  return child;
}

const running = (child) => !!child && child.pid !== undefined && child.exitCode === null && child.signalCode === null;

/**
 * Stop a codex child and everything under it, and resolve once it has exited (or after graceMs + 3 s regardless).
 * Windows: taskkill /T /F on its tree (a shim's cmd.exe and the program it runs). Elsewhere: SIGTERM to its process
 * group, then SIGKILL after graceMs.
 */
export function killTree(child, { graceMs = 2000 } = {}) {
  if (!running(child)) return Promise.resolve();
  const exited = new Promise((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    try {
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      tk.on("error", () => { try { child.kill(); } catch {} });
    } catch {
      try { child.kill(); } catch {}
    }
  } else {
    const signal = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
    };
    signal("SIGTERM");
    const hard = setTimeout(() => { if (running(child)) signal("SIGKILL"); }, graceMs);
    hard.unref?.();
    exited.then(() => clearTimeout(hard));
  }
  let cap;
  const late = new Promise((resolve) => { cap = setTimeout(resolve, graceMs + 3000); });
  return Promise.race([exited, late]).finally(() => clearTimeout(cap));
}

/** Collect a stream's text up to maxBytes; returns a getter. */
export function collectText(stream, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  stream?.on("data", (b) => {
    if (size >= maxBytes) return;
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
    chunks.push(buf.subarray(0, maxBytes - size));
    size += buf.length;
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

function spawnFailure(err) {
  if (err?.code === "ENOENT" || err?.code === "EACCES") return new CodexCliError("codex-missing", MISSING_MESSAGE);
  return new CodexCliError("spawn-failed", `Codex couldn't start (${err?.code || err?.message || "unknown error"}).`);
}

/**
 * Run one codex command to the end. Resolves {code, signal, stdout, stderr, timedOut}; a command past timeoutMs is
 * killed (with its tree) and resolves with timedOut true. Rejects only when codex can't start (CodexCliError).
 */
export function runCodex(bin, args, { env, cwd, timeoutMs = 15_000, maxBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnCodex(bin, args, { env, cwd }); } catch (err) { reject(spawnFailure(err)); return; }
    let settled = false;
    let timedOut = false;
    const stdout = collectText(child.stdout, maxBytes);
    const stderr = collectText(child.stderr, maxBytes);
    child.stdin.end();
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(spawnFailure(err));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout(), stderr: stderr(), timedOut });
    });
  });
}

/** auth.json's identity right now ("size:mtime"), or null when there is none: a changed value means a new sign-in. */
export function authFingerprint(codexHome) {
  try {
    const st = fs.statSync(path.join(codexHome, "auth.json"));
    return st.isFile() ? `${st.size}:${st.mtimeMs}` : null;
  } catch {
    return null;
  }
}
