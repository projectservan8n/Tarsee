/**
 * The Python that Tarsee's local voice runs on: faster-whisper (speech-to-text, stt-install.js) and Phonon
 * (text-to-speech, phonon-install.js). Each gets its own venv; this module finds, or fetches, the Python those venvs
 * are made from.
 *
 *   1. Tarsee's own copy, once downloaded: <state>/python/cpython-<version>.
 *   2. A Python 3.9 to 3.14 on this computer that has the venv module: on Windows the py launcher (py -3.12, ...), then
 *      python; elsewhere python3.12, ..., python3. The Microsoft Store's "python" shortcut is not a Python.
 *   3. Otherwise, only when the owner asks (a click in Settings), a standalone CPython from
 *      astral-sh/python-build-standalone: the install_only build for this OS and CPU, picked from the GitHub releases
 *      API at a pinned release, checked against the pinned sha256 (and the size and digest GitHub lists), unpacked by
 *      tar-extract.js and run once to prove it works.
 *
 * Downloads only ever come from GitHub's own hosts over https (install-common.js guardedFetch). The only thing ever
 * run from a download is that Python interpreter itself.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { OFFICIAL_HOSTS, guardedFetch, downloadFile, writeFileAtomic, describeFetchError } from "./install-common.js";
import { extractTarGz } from "./tar-extract.js";

/** The Pythons faster-whisper (and its parts: ctranslate2, onnxruntime, PyAV) have builds for. */
export const PYTHON_RANGE = Object.freeze({ min: [3, 9], max: [3, 14] });

/**
 * The standalone CPython Tarsee downloads when there is no usable Python: python-build-standalone's release
 * 20261026, CPython 3.12.16, the install_only builds. sha256 as the release lists them (each asset's digest).
 */
export const STANDALONE_PYTHON = Object.freeze({
  repo: "astral-sh/python-build-standalone",
  tag: "20261026",
  version: "3.12.16",
  approxBytes: 47_000_000,
  sha256: Object.freeze({
    "x86_64-pc-windows-msvc": "590dfcbe3a34c07301e6332e13e2188b98655cd072b08afa45a7998dc4c22bc5",
    "aarch64-pc-windows-msvc": "ad585318bfe47980cbaa90be12a65319c5b4eec7472655428528068e710a6c9a",
    "x86_64-apple-darwin": "a962e47df522889eaa7ff0d6a56203f1079f68aabb65ffdbe8455f362bc769f3",
    "aarch64-apple-darwin": "fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e",
    "x86_64-unknown-linux-gnu": "6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de",
    "aarch64-unknown-linux-gnu": "a945427411dc6851a1393533b74a4a1ac434321ae397f2ec69897a9b4fde032b",
  }),
});

const OWN_LABEL = "Tarsee's own Python";
const MARKER = "tarsee-python.json";

let _spawn = spawn;
let _candidates = null;

/** Tests only: a stand-in for child_process.spawn (a fake Python), and/or a fixed list of system Pythons to try. */
export function __setForTests({ spawn: s, candidates } = {}) {
  _spawn = s || spawn;
  _candidates = candidates || null;
}

// ── Where things are ─────────────────────────────────────────────────────

/** Tarsee's Python folder: its own CPython (when downloaded) and the voice venvs. */
export function pythonHome() {
  return path.join(config.STATE_DIR, "python");
}

export function standaloneDir(pin = STANDALONE_PYTHON) {
  return path.join(pythonHome(), `cpython-${pin.version}`);
}

/** The interpreter inside an unpacked python-build-standalone folder. */
export function interpreterIn(dir, platform = process.platform) {
  return platform === "win32" ? path.win32.join(dir, "python.exe") : path.posix.join(dir, "bin", "python3");
}

/** A venv's own python. */
export function venvInterpreter(dir, platform = process.platform) {
  return platform === "win32" ? path.win32.join(dir, "Scripts", "python.exe") : path.posix.join(dir, "bin", "python");
}

/** Tarsee's own CPython is unpacked, checked, and there. */
export function standaloneReady(pin = STANDALONE_PYTHON) {
  const dir = standaloneDir(pin);
  return fs.existsSync(path.join(dir, MARKER)) && fs.existsSync(interpreterIn(dir));
}

/** A Python to run: the program and the arguments that come first (the Windows launcher is `py -3.12`). */
export function describePython(ref) {
  return ref?.label || [ref?.cmd, ...(ref?.args || [])].filter(Boolean).join(" ");
}

let _glibc;
function glibcVersion() {
  if (_glibc === undefined) {
    try { _glibc = process.report?.getReport?.().header?.glibcVersionRuntime || null; } catch { _glibc = null; }
  }
  return _glibc;
}

/** The python-build-standalone target for this computer: { triple } or { error } in plain words. */
export function pythonTarget({ platform = process.platform, arch = process.arch, glibc } = {}) {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!cpu) {
    return { error: arch === "ia32" ? "this is a 32-bit computer, and faster-whisper needs a 64-bit one" : `there is no Python build for this computer's processor (${arch})` };
  }
  if (platform === "win32") return { triple: `${cpu}-pc-windows-msvc` };
  if (platform === "darwin") return { triple: `${cpu}-apple-darwin` };
  if (platform === "linux") {
    const libc = glibc === undefined ? glibcVersion() : glibc;
    if (!libc) return { error: "this Linux uses musl (Alpine, for one), and faster-whisper has no build for it; use Tarsee's Docker image, or a Linux with glibc" };
    return { triple: `${cpu}-unknown-linux-gnu` };
  }
  return { error: `there is no Python build Tarsee can download for ${platform}` };
}

/** The Pythons to look for on this computer, best first. */
export function systemCandidates(platform = process.platform) {
  const versions = ["3.12", "3.13", "3.11", "3.10", "3.14", "3.9"];
  if (platform === "win32") {
    return [
      ...versions.map((v) => ({ cmd: "py", args: [`-${v}`], source: "system", label: `py -${v}` })),
      { cmd: "py", args: ["-3"], source: "system", label: "py -3" },
      { cmd: "python", args: [], source: "system", label: "python" },
      { cmd: "python3", args: [], source: "system", label: "python3" },
    ];
  }
  return [
    ...versions.map((v) => ({ cmd: `python${v}`, args: [], source: "system", label: `python${v}` })),
    { cmd: "python3", args: [], source: "system", label: "python3" },
    { cmd: "python", args: [], source: "system", label: "python" },
  ];
}

// ── Running Python ───────────────────────────────────────────────────────

/** Start `ref` with `args` and keep it running (the speech-to-text worker). opts as child_process.spawn's. */
export function spawnPython(ref, args, opts = {}) {
  return _spawn(ref.cmd, [...(ref.args || []), ...args], { windowsHide: true, ...opts });
}

const lastLines = (text, n = 3) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" ");
const KEEP = 256 * 1024;

/**
 * Run `ref` with `args`. Resolves { stdout, stderr }. Rejects with an Error whose message is the last lines it printed,
 * and: code "ENOENT" (no such program), exitCode, timedOut, stdout, stderr. onLine(line, "stdout"|"stderr") gets
 * each line as it comes.
 */
export function runPython(ref, args, { timeout = 120_000, env, onLine, cwd } = {}) {
  const label = describePython(ref);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = _spawn(ref.cmd, [...(ref.args || []), ...args], { env: env || process.env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(Object.assign(new Error(`${label} could not be started (${err.message})`), { code: err.code }));
      return;
    }
    const out = { stdout: "", stderr: "" };
    const partial = { stdout: "", stderr: "" };
    let timedOut = false;
    let settled = false;
    const timer = timeout ? setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeout) : null;
    timer?.unref?.();
    const take = (which) => (chunk) => {
      const s = chunk.toString("utf8");
      out[which] = (out[which] + s).slice(-KEEP);
      if (!onLine) return;
      partial[which] += s;
      let i;
      while ((i = partial[which].search(/\r?\n/)) >= 0) {
        const line = partial[which].slice(0, i);
        partial[which] = partial[which].slice(i + (partial[which][i] === "\r" ? 2 : 1));
        try { onLine(line, which); } catch { /* a listener's problem is not the run's */ }
      }
    };
    child.stdout?.on("data", take("stdout"));
    child.stderr?.on("data", take("stderr"));
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    child.on("error", (err) => finish(() => {
      const msg = err.code === "ENOENT" ? `${label} was not found` : `${label} could not be started (${err.message})`;
      reject(Object.assign(new Error(msg), { code: err.code, stdout: out.stdout, stderr: out.stderr }));
    }));
    child.on("close", (code, signal) => finish(() => {
      if (onLine) for (const which of ["stdout", "stderr"]) if (partial[which]) { try { onLine(partial[which], which); } catch { /* ignore */ } }
      if (timedOut) {
        reject(Object.assign(new Error(`${label} did not finish within ${Math.round(timeout / 1000)}s`), { timedOut: true, stdout: out.stdout, stderr: out.stderr }));
      } else if (code !== 0) {
        const detail = lastLines(out.stderr) || lastLines(out.stdout) || `${label} stopped (${signal || `exit code ${code}`})`;
        reject(Object.assign(new Error(detail), { exitCode: code, signal, stdout: out.stdout, stderr: out.stderr }));
      } else {
        resolve({ stdout: out.stdout, stderr: out.stderr });
      }
    }));
  });
}

// ── Probing ──────────────────────────────────────────────────────────────

const PROBE = [
  "import sys, json",
  "r = {'version': list(sys.version_info[:3]), 'executable': sys.executable, 'prefix': sys.prefix, 'venv': False, 'fasterWhisper': None}",
  "try:",
  "    import venv, ensurepip",
  "    r['venv'] = True",
  "except Exception:",
  "    pass",
  "try:",
  "    import faster_whisper",
  "    r['fasterWhisper'] = getattr(faster_whisper, '__version__', 'unknown')",
  "except Exception as e:",
  "    r['fasterWhisperError'] = (type(e).__name__ + ': ' + str(e))[:300]",
  "print('TARSEE-PROBE ' + json.dumps(r))",
].join("\n");

const cmpVer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

/**
 * Ask a Python about itself. { ...ref, found, usable, version, executable, venv, fasterWhisper, problem }:
 * found (the program exists), usable (a Python in PYTHON_RANGE with venv: a base for Tarsee's venvs), fasterWhisper
 * (its version when this Python can import it), problem (why it isn't usable, in plain words).
 */
export async function probePython(ref, { timeout = 30_000 } = {}) {
  const base = { ...ref, label: describePython(ref), found: false, usable: false, version: null, executable: null, venv: false, fasterWhisper: null, problem: null };
  let stdout;
  try {
    ({ stdout } = await runPython(ref, ["-I", "-c", PROBE], { timeout, env: { ...process.env, HF_HUB_OFFLINE: "1" } }));
  } catch (err) {
    if (err.code === "ENOENT") return { ...base, problem: "not found" };
    if (err.timedOut) return { ...base, found: true, problem: `did not answer within ${Math.round(timeout / 1000)}s` };
    // The py launcher, asked for a version this computer doesn't have (its message mentions the Microsoft Store too).
    if (/^py(\.exe)?$/i.test(path.basename(ref.cmd)) && /No suitable Python runtime|not found/i.test(`${err.stderr}`)) return { ...base, problem: "not found" };
    if (/Microsoft Store/i.test(`${err.stderr} ${err.stdout} ${err.message}`) || err.exitCode === 9009) {
      return { ...base, found: true, problem: "this is the Microsoft Store shortcut, not Python itself" };
    }
    return { ...base, found: true, problem: `did not run (${err.message})` };
  }
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("TARSEE-PROBE "));
  let r;
  try { r = JSON.parse(line.slice("TARSEE-PROBE ".length)); } catch { return { ...base, found: true, problem: "did not answer like a Python does" }; }
  const v = Array.isArray(r.version) ? r.version.map(Number) : [0, 0, 0];
  const version = v.join(".");
  const res = { ...base, found: true, version, executable: r.executable || null, venv: !!r.venv, fasterWhisper: r.fasterWhisper || null };
  if (cmpVer(v, PYTHON_RANGE.min) < 0) return { ...res, problem: `Python ${version} is too old (faster-whisper needs 3.9 or newer)` };
  if (cmpVer(v, PYTHON_RANGE.max) > 0) return { ...res, problem: `Python ${version} is newer than faster-whisper supports yet (3.9 to 3.14)` };
  if (!r.venv) return { ...res, problem: `Python ${version} has no venv module (on Debian or Ubuntu: apt install python3-venv)` };
  return { ...res, usable: true };
}

/** Every Python found: Tarsee's own first (when there), then this computer's, without repeats. */
export async function findPythons({ pin = STANDALONE_PYTHON } = {}) {
  const list = [];
  if (standaloneReady(pin)) list.push({ cmd: interpreterIn(standaloneDir(pin)), args: [], source: "tarsee", label: OWN_LABEL });
  list.push(...(_candidates || systemCandidates()));
  const probes = await Promise.all(list.map((ref) => probePython(ref)));
  const seen = new Set();
  return probes.filter((p) => {
    if (!p.executable) return true;
    const key = process.platform === "win32" ? p.executable.toLowerCase() : p.executable;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The best Python to make a venv from, or null. */
export async function findBasePython(opts = {}) {
  return (await findPythons(opts)).find((p) => p.usable) || null;
}

export const NO_PYTHON = "No Python 3.9 or newer was found on this computer";

/**
 * A Python to make a venv from: findBasePython's, else (allowDownload) Tarsee's own, downloaded now. Without
 * allowDownload, no Python is an error that says what to do.
 * opts: allowDownload, fetch, pin, onProgress({ phase, bytesDone, bytesTotal }), log, retryDelayMs.
 */
export async function ensureBasePython(opts = {}) {
  const found = await findBasePython({ pin: opts.pin });
  if (found) return found;
  if (!opts.allowDownload) {
    throw Object.assign(new Error(`${NO_PYTHON}. Install it from python.org, or use the Install button in Settings > Voice, which downloads Tarsee's own copy (about 45 MB).`), { code: "NO_PYTHON" });
  }
  return downloadStandalonePython(opts);
}

// ── The standalone download ──────────────────────────────────────────────

/** Download, check, unpack and run once the pinned standalone CPython. Resolves with its probe (source "tarsee"). */
export async function downloadStandalonePython({ fetch: fetchImpl, pin = STANDALONE_PYTHON, onProgress, log = () => {}, retryDelayMs = 1000 } = {}) {
  const target = pythonTarget();
  if (target.error) throw new Error(`Tarsee can't download Python for this computer: ${target.error}.`);
  const get = guardedFetch([OFFICIAL_HOSTS.github], fetchImpl || globalThis.fetch);

  // 1. The release, from GitHub's API.
  const apiUrl = `https://api.github.com/repos/${pin.repo}/releases/tags/${pin.tag}`;
  let res;
  try {
    res = await get(apiUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Tarsee", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Could not read the Python release list from GitHub: ${describeFetchError(err, apiUrl).message}.`);
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub is turning requests from this address away for now (its rate limit). Try again in an hour.");
  }
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the Python release list. Try again later.`);
  let release;
  try { release = await res.json(); } catch { throw new Error("GitHub's Python release list could not be read. Try again later."); }

  // 2. This computer's build, checked against the pin before a byte of it is fetched.
  const name = `cpython-${pin.version}+${pin.tag}-${target.triple}-install_only.tar.gz`;
  const asset = (release?.assets || []).find((a) => a?.name === name);
  if (!asset) throw new Error(`GitHub's Python release ${pin.tag} has no build for this computer (${target.triple}).`);
  const pinned = pin.sha256?.[target.triple] || null;
  const listed = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ""))?.[1]?.toLowerCase() || null;
  if (pinned && listed && listed !== pinned) {
    throw new Error(`The Python build GitHub lists (${name}) does not match the one this version of Tarsee expects, so it was not downloaded.`);
  }
  const sha256 = pinned || listed;
  if (!sha256) throw new Error(`GitHub lists no hash for ${name}, so it was not downloaded.`);
  const official = `https://github.com/${pin.repo}/releases/download/${pin.tag}/`;
  const url = String(asset.browser_download_url || "");
  if (!url.startsWith(official)) throw new Error(`Refused the Python download: its link is not the official one (${url.slice(0, 80)}).`);
  const size = Number(asset.size) > 0 ? Number(asset.size) : undefined;
  const total = size || pin.approxBytes || 47_000_000;

  // 3. Download it.
  const downloads = path.join(pythonHome(), "downloads");
  const file = path.join(downloads, name);
  let done = 0;
  onProgress?.({ phase: "python", bytesDone: 0, bytesTotal: total });
  log(`downloading Python ${pin.version} (${name}) from GitHub`);
  try {
    await downloadFile({
      url, dest: file, sha256, size, fetchImpl: get, retryDelayMs,
      progress: (n) => { done = Math.max(0, done + n); onProgress?.({ phase: "python", bytesDone: done, bytesTotal: total }); },
    });
  } catch (err) {
    cleanDownloads(downloads, file);
    throw new Error(`Downloading Python from GitHub failed: ${err.message}.`);
  }

  // 4. Unpack it (strictly: tar-extract.js), then put it in place.
  const dir = standaloneDir(pin);
  const partial = `${dir}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  onProgress?.({ phase: "python-unpack", bytesDone: done, bytesTotal: total });
  try {
    await extractTarGz(file, partial, { strip: 1 });
    if (!fs.existsSync(interpreterIn(partial))) throw new Error("it has no Python interpreter in it");
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    cleanDownloads(downloads, file);
    throw new Error(`The Python download could not be unpacked: ${err.message}.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(partial, dir);
  cleanDownloads(downloads, file);

  // 5. Run it once (the only thing from a download Tarsee ever runs is this interpreter).
  const probe = await probePython({ cmd: interpreterIn(dir), args: [], source: "tarsee", label: OWN_LABEL });
  if (!probe.usable) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`The downloaded Python did not run (${probe.problem}).`);
  }
  writeFileAtomic(path.join(dir, MARKER), JSON.stringify({
    repo: pin.repo, tag: pin.tag, version: pin.version, target: target.triple, sha256, installedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  log(`Python ${probe.version} is ready in ${dir}`);
  return probe;
}

function cleanDownloads(dir, file) {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.part`, { force: true });
  try { fs.rmdirSync(dir); } catch { /* not empty, or gone */ }
}
