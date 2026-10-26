/**
 * Phonon installer: puts the Phonon TTS model and its English voices on the
 * data volume, and makes sure the Python runtime (ptts) can be imported.
 *
 *   <root>/models/phonon-31m-en   gradium/phonon-31m-en, q8 weights (Apache-2.0)
 *   <root>/catalog                English voices of gradium/phonon-voices (Apache-2.0)
 *   <root>/venv                   only on machines whose python3 lacks ptts
 *   <root>/install.json           written last: the install finished
 *
 * <root> is DATA_DIR/tts/phonon, or TARSEE_PHONON_DIR.
 *
 * Only the official sources are used: the gradium organisation on Hugging Face
 * at pinned revisions, and the ptts package on PyPI at a pinned version. Every
 * file is streamed to a temporary name and renamed into place only when it is
 * complete; the weights are checked against their published sha256 first. A
 * lock file keeps two installs (the server and a terminal run) from racing.
 * The gated, non-commercial (CC BY-NC) Phonon models are never downloaded.
 *
 * Used by Settings -> Voice -> Install Phonon, by the background install on
 * first boot (autoInstallPhonon), and from a terminal:
 *
 *   node src/voice/phonon-install.js
 *
 * Nothing here ever runs inside a TTS request.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  phononPaths, phononInstalled, phononThreads, canImportPtts, resetPhononAvailability,
} from "./phonon-engine.js";
import { enginePreference } from "./engine-registry.js";

export const PTTS_VERSION = "0.4.2";
const HF = "https://huggingface.co";

/** The model, pinned. sha256 is given where Hugging Face publishes one (the LFS weights). */
export const PHONON_MODEL = {
  repo: "gradium/phonon-31m-en",
  revision: "92741c5b07d085ff840e26fea8ce43110b87852f",
  files: [
    { name: "config.json" },
    { name: "model.q8.gguf", sha256: "a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae" },
    { name: "tokenizer.json" },
    { name: "tokenizer.model" },
    { name: "default-voice.safetensors" },
    { name: "generation_config.json" },
    { name: "README.md" },
  ],
};

/** The voice catalog, pinned. Only the English voices are downloaded (about 250 KB each). */
export const PHONON_VOICES = {
  repo: "gradium/phonon-voices",
  revision: "0ee17205f254b5abc43b266c8a0f215565c352f7",
  language: "en",
  locales: ["en-us", "en-gb"],
};

// About 64.5 MB of weights, 6 MB of voices and a few small files. Only used to
// show progress; nothing depends on it being exact.
const APPROX_TOTAL_BYTES = 72_000_000;
const DOWNLOAD_ATTEMPTS = 3;
const STALL_MS = 60_000;
const LOCK_STALE_MS = 2 * 60 * 60_000;

export function hfUrl(repo, revision, file) {
  return `${HF}/${repo}/resolve/${revision}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

// ── Status (what Settings -> Voice shows) ────────────────────────────────

let _running = null;
const _status = {
  phase: null, // runtime | model | voices | check | done
  file: null,
  bytesDone: 0,
  bytesTotal: APPROX_TOTAL_BYTES,
  error: null,
  startedAt: null,
  finishedAt: null,
};

/**
 * { state, installed, phase, file, percent, error, startedAt, finishedAt }
 * state: "installed" | "installing" | "failed" | "not-installed".
 */
export function getPhononInstallStatus() {
  const installed = phononInstalled();
  let state = "not-installed";
  if (_running) state = "installing";
  else if (installed) state = "installed";
  else if (_status.error) state = "failed";
  const percent = state === "installed"
    ? 100
    : Math.max(0, Math.min(99, Math.floor((_status.bytesDone / _status.bytesTotal) * 100)));
  return {
    state,
    installed,
    phase: _running ? _status.phase : null,
    file: _running ? _status.file : null,
    percent,
    error: state === "failed" ? _status.error : null,
    startedAt: _status.startedAt,
    finishedAt: _status.finishedAt,
  };
}

/**
 * getPhononInstallStatus, plus a check that the Python runtime can still
 * import ptts: files on the volume outlive the image and its Python, so an
 * install can be complete on disk and still unusable. That case reads as
 * "failed", and a retry repairs the runtime.
 */
export async function checkPhononInstall() {
  const status = getPhononInstallStatus();
  if (status.state !== "installed") return status;
  const { python } = phononPaths();
  if (await canImportPtts(python)) return status;
  return { ...status, state: "failed", percent: 0, error: `the model is installed, but ${python} cannot import ptts` };
}

// ── Install ──────────────────────────────────────────────────────────────

/**
 * Install Phonon. Concurrent calls share one run. Resolves with the status
 * once installed; rejects (and the status says "failed") on any error.
 *
 * opts.fetch          fetch implementation (tests)
 * opts.model, opts.voices  replace PHONON_MODEL / PHONON_VOICES (tests)
 * opts.retryDelayMs   pause before retrying a failed download (tests shorten it)
 * opts.ensureRuntime  async () => void, makes `import ptts` work (tests replace it)
 * opts.smokeTest      async (paths) => string, a real synthesis (tests replace it)
 * opts.onProgress     (status) => void, on every chunk downloaded
 * opts.onInstalled    async () => void, after success (re-initialises the TTS engine)
 * opts.log            (message) => void
 */
export function installPhonon(opts = {}) {
  if (_running) return _running;
  _running = runInstall(opts)
    .finally(() => { _running = null; })
    .then(() => getPhononInstallStatus());
  return _running;
}

async function runInstall(opts) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const model = opts.model || PHONON_MODEL;
  const voicesSrc = opts.voices || PHONON_VOICES;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const log = opts.log || ((m) => console.log(`[phonon:install] ${m}`));
  const progress = (n) => {
    _status.bytesDone = Math.max(0, _status.bytesDone + n);
    opts.onProgress?.(getPhononInstallStatus());
  };
  Object.assign(_status, {
    phase: "runtime", file: null, bytesDone: 0, bytesTotal: APPROX_TOTAL_BYTES,
    error: null, startedAt: new Date().toISOString(), finishedAt: null,
  });

  let release = null;
  try {
    const root = phononPaths().root;
    fs.mkdirSync(root, { recursive: true });
    release = acquireLock(root);
    log(`installing into ${root}`);

    // 1. The Python runtime.
    await (opts.ensureRuntime || ensureRuntime)(log);

    // 2. The model.
    _status.phase = "model";
    const p = phononPaths(); // after step 1: the venv's python, if one was created
    for (const f of model.files) {
      _status.file = f.name;
      await downloadFile({
        url: hfUrl(model.repo, model.revision, f.name),
        dest: path.join(p.model, f.name),
        sha256: f.sha256,
        fetchImpl,
        progress,
        retryDelayMs,
      });
    }

    // 3. The English voices.
    _status.phase = "voices";
    _status.file = "voices.jsonl";
    const voices = await fetchVoiceList(fetchImpl, voicesSrc);
    for (const v of voices) {
      _status.file = v.filename;
      await downloadFile({
        url: hfUrl(voicesSrc.repo, voicesSrc.revision, v.filename),
        dest: v.dest,
        sha256: v.sha256,
        fetchImpl,
        progress,
        retryDelayMs,
      });
    }
    _status.file = "README.md";
    await downloadFile({
      url: hfUrl(voicesSrc.repo, voicesSrc.revision, "README.md"),
      dest: path.join(p.catalog, "README.md"),
      fetchImpl,
      progress,
      retryDelayMs,
    });
    // The catalog index goes in last: it lists only voices that are on disk.
    writeFileAtomic(path.join(p.catalog, "voices.jsonl"), voices.map((v) => v.line).join("\n") + "\n");

    // 4. One real synthesis, offline, before calling it installed.
    _status.phase = "check";
    _status.file = null;
    resetPhononAvailability();
    let smoke;
    try {
      smoke = await (opts.smokeTest || smokeTest)(p);
    } catch (err) {
      // The model files without a published hash could not be verified: drop
      // them so a retry fetches them again instead of failing the same way.
      for (const f of model.files) if (!f.sha256) fs.rmSync(path.join(p.model, f.name), { force: true });
      throw err;
    }
    if (smoke) log(`smoke test: ${smoke}`);

    // 5. Done.
    writeFileAtomic(p.marker, JSON.stringify({
      ptts: PTTS_VERSION,
      model: { repo: model.repo, revision: model.revision },
      voices: { repo: voicesSrc.repo, revision: voicesSrc.revision, count: voices.length },
      installedAt: new Date().toISOString(),
    }, null, 2) + "\n");
    resetPhononAvailability();
    _status.phase = "done";
    _status.finishedAt = new Date().toISOString();
    log(`done: model and ${voices.length} voices in ${root}`);
  } catch (err) {
    _status.error = err?.message || String(err);
    _status.finishedAt = new Date().toISOString();
    log(`failed: ${_status.error}`);
    throw err;
  } finally {
    release?.();
  }

  try { await opts.onInstalled?.(); } catch (err) { log(`installed, but switching the engine failed: ${err.message}`); }
}

/** The English voices of the pinned catalog: [{ filename, dest, sha256, line }]. */
async function fetchVoiceList(fetchImpl, src) {
  const { catalog } = phononPaths();
  const url = hfUrl(src.repo, src.revision, "voices.jsonl");
  let res;
  try { res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(STALL_MS) }); } catch (err) { throw describeFetchError(err, url); }
  if (!res.ok) throw new Error(`could not fetch the voice list (HTTP ${res.status})`);
  const text = await res.text();
  const voices = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.language !== src.language || !src.locales.includes(d.locale)) continue;
    const dest = safeJoin(catalog, d.filename);
    if (!dest) throw new Error(`the voice list names an unsafe file: ${String(d.filename).slice(0, 80)}`);
    voices.push({ filename: d.filename, dest, sha256: typeof d.sha256 === "string" ? d.sha256 : undefined, line: line.trim() });
  }
  if (voices.length === 0) throw new Error("the voice list has no English voices");
  return voices;
}

/** dir/rel when rel is a plain relative path that stays inside dir; null otherwise. */
function safeJoin(dir, rel) {
  if (typeof rel !== "string" || !/^[\w][\w.\-/]*$/.test(rel)) return null;
  if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  const dest = path.resolve(dir, rel);
  return dest.startsWith(path.resolve(dir) + path.sep) ? dest : null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Stream url to dest through a sha256, then rename into place. A file already
 * there is kept when it matches its hash (or has no published hash: files only
 * ever appear complete, by rename). Retries a few times; a stalled transfer is
 * aborted after STALL_MS without data.
 */
export async function downloadFile({ url, dest, sha256, fetchImpl = globalThis.fetch, progress = () => {}, attempts = DOWNLOAD_ATTEMPTS, retryDelayMs = 1000 }) {
  if (fs.existsSync(dest)) {
    const size = fs.statSync(dest).size;
    if (size > 0 && (!sha256 || (await sha256File(dest)) === sha256)) {
      progress(size);
      return "kept";
    }
    fs.rmSync(dest, { force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const tmp = `${dest}.part`;
    const ac = new AbortController();
    let stall = null;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ac.abort(new Error(`no data for ${STALL_MS / 1000}s`)), STALL_MS);
      stall.unref?.();
    };
    let counted = 0;
    try {
      armStall();
      const res = await fetchImpl(url, { redirect: "follow", signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${path.basename(dest)}`);
      const hash = crypto.createHash("sha256");
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          armStall();
          hash.update(chunk);
          counted += chunk.length;
          progress(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp));
      // A compressed response's Content-Length is not the size of what we read.
      const expected = Number(res.headers?.get?.("content-length"));
      if (!res.headers?.get?.("content-encoding") && expected > 0 && counted !== expected) {
        throw new Error(`${path.basename(dest)} was cut short (${counted} of ${expected} bytes)`);
      }
      const got = hash.digest("hex");
      if (sha256 && got !== sha256) {
        throw Object.assign(new Error(`${path.basename(dest)} does not match its published sha256`), { code: "HASH_MISMATCH" });
      }
      fs.renameSync(tmp, dest);
      return got;
    } catch (err) {
      lastErr = describeFetchError(err, url);
      progress(-counted);
      fs.rmSync(tmp, { force: true });
      if (attempt < attempts) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    } finally {
      clearTimeout(stall);
    }
  }
  throw lastErr;
}

/** fetch's own "fetch failed" says nothing; name the host and the cause instead. */
function describeFetchError(err, url) {
  if (err?.message !== "fetch failed") return err;
  const host = (() => { try { return new URL(url).host; } catch { return "the download server"; } })();
  const cause = err.cause?.code || err.cause?.message || "network error";
  return Object.assign(new Error(`could not reach ${host} (${cause})`), { cause: err });
}

// ── Lock ─────────────────────────────────────────────────────────────────

// Lock files this process holds right now.
const _heldLocks = new Set();

/** Take <root>/.install.lock or throw (code LOCKED). Returns the release function. */
export function acquireLock(root) {
  const file = path.join(root, ".install.lock");
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
      _heldLocks.add(file);
      return () => {
        _heldLocks.delete(file);
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (!lockIsStale(file)) {
        throw Object.assign(new Error("another Phonon install is already running"), { code: "LOCKED" });
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw Object.assign(new Error("could not take the Phonon install lock"), { code: "LOCKED" });
}

function lockIsStale(file) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Unreadable: stale unless it was created a moment ago (being written).
    try { return Date.now() - fs.statSync(file).mtimeMs > 10_000; } catch { return true; }
  }
  if (info.pid === process.pid) {
    // Ours and held: a live lock. Ours but not held: left over from an earlier
    // container that ran with the same pid (common for PID 1-ish processes).
    return !_heldLocks.has(file);
  }
  const age = Date.now() - Date.parse(info.startedAt);
  if (!(age < LOCK_STALE_MS)) return true;
  try { process.kill(info.pid, 0); return false; } catch (err) { return err.code !== "EPERM"; }
}

// ── Python runtime ───────────────────────────────────────────────────────

function run(cmd, args, { timeout = 120_000, env, lines = 3 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env: env || process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim().split("\n").slice(-lines).join(" ").trim();
        return reject(Object.assign(new Error(detail || err.message), { code: err.code }));
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Make `import ptts` work. The Docker image installs ptts for python3, so this
 * is normally a no-op. Elsewhere it creates <root>/venv and pip-installs the
 * pinned ptts there (a prebuilt wheel; its only dependency is numpy).
 */
async function ensureRuntime(log) {
  let p = phononPaths();
  if (await canImportPtts(p.python)) return;
  if (process.env.TARSEE_PHONON_PYTHON?.trim()) {
    throw new Error(`TARSEE_PHONON_PYTHON (${p.python}) cannot import ptts. Install it there: ${p.python} -m pip install ptts==${PTTS_VERSION}`);
  }
  const venvHelp = `Install Python 3.9+ with the venv module (Debian/Ubuntu: apt install python3-venv), or install the runtime yourself: pip install ptts==${PTTS_VERSION}`;

  // A venv left half made (no pip) by an earlier failed attempt is rebuilt.
  if (fs.existsSync(p.venvPython)) {
    try { await run(p.venvPython, ["-m", "pip", "--version"]); } catch { fs.rmSync(p.venv, { recursive: true, force: true }); }
  }
  if (!fs.existsSync(p.venvPython)) {
    log(`python3 has no ptts: creating a private venv at ${p.venv}`);
    try {
      await run("python3", ["-m", "venv", p.venv]);
      await run(path.join(p.venv, "bin", "python"), ["-m", "pip", "--version"]);
    } catch (err) {
      fs.rmSync(p.venv, { recursive: true, force: true });
      const why = err.code === "ENOENT" ? "python3 was not found" : err.message;
      throw new Error(`Could not create a Python venv for Phonon (${why}). ${venvHelp}`);
    }
  }
  log(`installing ptts ${PTTS_VERSION} into ${p.venv}`);
  try {
    await run(path.join(p.venv, "bin", "python"),
      ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--quiet", `ptts==${PTTS_VERSION}`],
      { timeout: 600_000 });
  } catch (err) {
    throw new Error(`pip could not install ptts ${PTTS_VERSION}: ${err.message}`);
  }
  resetPhononAvailability();
  p = phononPaths();
  if (!(await canImportPtts(p.python))) throw new Error(`ptts ${PTTS_VERSION} was installed but ${p.python} cannot import it`);
}

/** Load the model and speak one line, offline. Throws when that does not work. */
async function smokeTest(p) {
  const code = [
    "import sys, ptts",
    "ptts.set_num_threads(int(sys.argv[3]))",
    "tts = ptts.TTS(sys.argv[1], lang='en', quant='q8', voice_catalog=sys.argv[2])",
    "pcm = tts.synth('Phonon is ready.', voice='Toby')",
    "assert len(pcm) > 0, 'no audio'",
    "print(f'{len(pcm) / tts.sample_rate:.1f}s of audio on {tts.device}-{tts.quant}')",
  ].join("\n");
  try {
    const { stdout } = await run(p.python, ["-I", "-c", code, p.model, p.catalog, String(phononThreads())], {
      timeout: 180_000,
      lines: 1, // the exception, not the traceback
      env: { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`the downloaded model did not load: ${err.message}`);
  }
}

// ── Background install on boot ───────────────────────────────────────────

let _autoAttempted = false;

/**
 * Called once at server start. When the voice engine is Phonon (the default)
 * and the model is not on the volume yet, download it in the background; Edge
 * TTS speaks meanwhile. One attempt per boot; a failure is shown in Settings ->
 * Voice with a retry button. TARSEE_PHONON_AUTO_INSTALL=0 turns it off.
 * Returns whether an install was scheduled. opts.install replaces installPhonon (tests).
 */
export function autoInstallPhonon(settingsStore, opts = {}) {
  if (_autoAttempted) return false;
  if (/^(0|false|off|no)$/i.test(String(process.env.TARSEE_PHONON_AUTO_INSTALL ?? "").trim())) return false;
  if (enginePreference(settingsStore) !== "phonon") return false;
  if (phononInstalled()) return false;
  _autoAttempted = true;
  console.log("[phonon] Phonon is the voice engine but is not installed yet: downloading it in the background (Edge TTS speaks until it is ready; TARSEE_PHONON_AUTO_INSTALL=0 turns this off)");
  const install = opts.install || installPhonon;
  const start = () => install({ onInstalled: opts.onInstalled }).catch((err) => {
    console.warn(`[phonon] background install failed: ${err.message} (retry from Settings -> Voice)`);
  });
  const timer = setTimeout(start, opts.delayMs ?? 5_000);
  timer.unref?.();
  return true;
}

// ── Terminal ─────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let shown = -10;
  installPhonon({
    log: (m) => console.log(`[phonon] ${m}`),
    onProgress: (s) => {
      if (s.percent >= shown + 10) { shown = s.percent - (s.percent % 10); console.log(`[phonon] ${s.phase} ${s.percent}%`); }
    },
  }).then(() => {
    console.log("[phonon] installed. A running Tarsee switches to it after a restart, or when Settings -> Voice is saved.");
    process.exit(0);
  }, (err) => {
    console.error(`[phonon] install failed: ${err.message}`);
    process.exit(1);
  });
}
