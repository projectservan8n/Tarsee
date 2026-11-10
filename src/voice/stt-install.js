/**
 * Local speech-to-text, set up from Settings > Voice > Speech-to-text: faster-whisper, the Python it runs on, and its
 * models. What the page shows (getSttStatus) and does (startSttInstall, startModelDownload, removeSttModel).
 *
 * Which Python runs faster-whisper (findSttRuntime), first that can import it:
 *   1. TARSEE_STT_PYTHON, when set (a Python you manage yourself);
 *   2. Tarsee's own: <state>/python/stt-venv, made by "Install faster-whisper";
 *   3. a Python on this computer (the Docker image installs faster-whisper for its python3).
 *
 * "Install faster-whisper" (startSttInstall), for installs without Docker:
 *   1. a Python 3.9+ with venv found here, else Tarsee's own CPython downloaded (python-runtime.js);
 *   2. a private folder for faster-whisper made from it (a venv, <state>/python/stt-venv);
 *   3. pip installs faster-whisper FASTER_WHISPER_VERSION there: from pypi.org only (--isolated --index-url), and
 *      ready-made builds only (--only-binary=:all:, so nothing from a download runs while installing);
 *   4. a check that it imports; 5. the default model, when no model is on disk yet.
 *
 * Models (whisper-models.js) download into <data>/whisper-models, on the volume on Railway. One job (an install or a
 * model download) runs at a time, in this process and across processes (a lock file).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import config from "../config/env.js";
import {
  pythonHome, venvInterpreter, ensureBasePython, findPythons, probePython, runPython, pythonTarget, STANDALONE_PYTHON,
} from "./python-runtime.js";
import {
  WHISPER_MODELS, DEFAULT_WHISPER_MODEL, findWhisperModel, downloadWhisperModel, deleteWhisperModel,
} from "./whisper-models.js";
import { acquireLock, writeFileAtomic } from "./install-common.js";

/** The faster-whisper Tarsee installs (and the Docker image pins: test/deploy-image.test.js checks they agree). */
export const FASTER_WHISPER_VERSION = "1.2.1";
/**
 * What pip downloads for it, roughly: PyAV 28 MB, ctranslate2 20 MB, onnxruntime 15 MB, numpy 13 MB, sympy 6 MB,
 * tokenizers 3 MB and about 20 small ones (Windows x64, Python 3.12, November 2026).
 */
const APPROX_PACKAGES_MB = 100;
const PIP_PACKAGES_EXPECTED = 28;
const PIP_TIMEOUT_MS = 20 * 60_000;

let _catalog = WHISPER_MODELS;

/** Tests only: small stand-ins for the models ({ catalog }); no argument restores the real ones. */
export function __setForTests({ catalog } = {}) {
  _catalog = catalog || WHISPER_MODELS;
}

// ── Folders ──────────────────────────────────────────────────────────────

/** Where everything is. bundled: TARSEE_WHISPER_BUNDLED_DIR (the Docker image's models, read-only). */
export function sttDirs() {
  const models = path.join(config.DATA_DIR, "whisper-models");
  const bundled = String(process.env.TARSEE_WHISPER_BUNDLED_DIR || "").split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  // The old version let faster-whisper download into <dir>/hf_cache, with <dir> worked out its own way.
  const old = path.join(process.env.TARSEE_DATA_DIR || process.env.TARSEE_STATE_DIR || "/data/tarsee", "whisper-models");
  const caches = [...new Set([path.join(models, "hf_cache"), path.join(old, "hf_cache")])];
  return { home: pythonHome(), venv: path.join(pythonHome(), "stt-venv"), models, bundled, caches };
}

// ── Which Python runs faster-whisper ─────────────────────────────────────

let _runtime = null;

/** Forget what was found (after an install, or when Settings asks to look again). */
export function resetSttRuntime() {
  _runtime = null;
}

/**
 * { ready, python: { cmd, args }, label, version, executable, fasterWhisper, source: "custom"|"tarsee"|"system" }
 * when a Python can import faster-whisper; else { ready: false, base (a Python an install would use, or null),
 * problem }. Cached until resetSttRuntime() or refresh.
 */
export function findSttRuntime({ refresh = false } = {}) {
  if (refresh || !_runtime) {
    const p = detectRuntime().catch((err) => ({ ready: false, base: null, problem: err.message }));
    _runtime = p;
  }
  return _runtime;
}

function readyFrom(probe, source) {
  return {
    ready: true,
    python: { cmd: probe.cmd, args: probe.args || [] },
    label: probe.label,
    version: probe.version,
    executable: probe.executable,
    fasterWhisper: probe.fasterWhisper,
    source,
  };
}

async function detectRuntime() {
  const custom = process.env.TARSEE_STT_PYTHON?.trim();
  if (custom) {
    const p = await probePython({ cmd: custom, args: [], label: custom });
    if (p.fasterWhisper) return readyFrom(p, "custom");
    return { ready: false, base: null, custom: true, problem: `TARSEE_STT_PYTHON (${custom}) ${p.found ? "can't load faster-whisper" : "was not found"}` };
  }
  const venvPy = venvInterpreter(sttDirs().venv);
  let broken = null;
  if (fs.existsSync(venvPy)) {
    const p = await probePython({ cmd: venvPy, args: [], label: "Tarsee's faster-whisper" });
    if (p.fasterWhisper) return readyFrom(p, "tarsee");
    broken = "Tarsee's faster-whisper folder is there but doesn't work";
  }
  const all = await findPythons();
  const withIt = all.find((p) => p.fasterWhisper);
  if (withIt) return readyFrom(withIt, "system");
  return { ready: false, base: all.find((p) => p.usable) || null, problem: broken };
}

// ── Models ───────────────────────────────────────────────────────────────

const validModel = (name) => typeof name === "string" && Object.hasOwn(_catalog, name);

/** The model the owner chose (voice.stt_model), or the default. */
export function chosenModel(settingsStore) {
  const pref = settingsStore?.get?.("voice.stt_model");
  return validModel(pref) ? pref : DEFAULT_WHISPER_MODEL;
}

/** Where a model is on disk ({ name, dir, source }), or null. */
export function findSttModel(name) {
  return validModel(name) ? findWhisperModel(name, sttDirs(), _catalog) : null;
}

/**
 * The model to transcribe with: the chosen one when it is on disk, else the closest one that is (the same kind,
 * English-only or many languages, first). { name, dir, source, wanted } (wanted: the chosen one, when it isn't the
 * one used), or { missing: <chosen> } when no model is on disk at all.
 */
export function resolveSttModel(want) {
  const dirs = sttDirs();
  const name = validModel(want) ? want : DEFAULT_WHISPER_MODEL;
  const hit = findWhisperModel(name, dirs, _catalog);
  if (hit) return { ...hit, wanted: null };
  const english = _catalog[name].english;
  const order = Object.keys(_catalog).sort((a, b) => (
    (_catalog[b].english === english) - (_catalog[a].english === english)
    || (b === DEFAULT_WHISPER_MODEL) - (a === DEFAULT_WHISPER_MODEL)
  ));
  for (const other of order) {
    const h = findWhisperModel(other, dirs, _catalog);
    if (h) return { ...h, wanted: name };
  }
  return { missing: name };
}

function sizeText(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** One row per model, for Settings: its size, whether and where it is, and what can be done with it. */
export function listSttModels(current = DEFAULT_WHISPER_MODEL) {
  const dirs = sttDirs();
  return Object.values(_catalog).map((m) => {
    const bytes = m.files.reduce((a, f) => a + f.size, 0);
    const hit = findWhisperModel(m.name, dirs, _catalog);
    const job = _job && _job.kind === "model" && _job.model === m.name ? _job : null;
    const last = _last.models[m.name];
    let state = hit ? hit.source : "missing";
    if (job) state = "downloading";
    else if (!hit && last?.error) state = "failed";
    return {
      name: m.name,
      description: m.description,
      english: m.english,
      multilingual: !m.english,
      bytes,
      size: sizeText(bytes),
      sizeMB: Math.round(bytes / 1e6),
      state,
      downloaded: !!hit,
      where: hit ? hit.dir : null,
      deletable: !!hit && hit.source !== "image",
      current: m.name === current,
      percent: job ? job.percent : null,
      error: !hit && !job ? last?.error || null : null,
    };
  });
}

// ── Jobs ─────────────────────────────────────────────────────────────────

let _job = null;
const _last = { install: null, models: {} };

/** Tests only: forget earlier jobs' results. */
export function __resetJobsForTests() {
  _last.install = null;
  _last.models = {};
}

function snapshot(j = _job) {
  if (!j) return null;
  const { kind, model, phase, step, percent, startedAt } = j;
  return { kind, model, phase, step, percent, startedAt };
}

/** The job running now, or null: { kind: "install"|"model", model, phase, step, percent, startedAt }. */
export function sttJob() {
  return snapshot();
}

function describeJob(j) {
  return j.kind === "install" ? "installing faster-whisper" : `downloading the ${j.model} model`;
}

/**
 * Start a job, or hand back the same one already running. Another job running: an error (code BUSY, status 409).
 * Returns the job's snapshot plus done: a promise of { ok, error } (never rejects).
 */
function begin(kind, model, run) {
  if (_job) {
    if (_job.kind === kind && _job.model === model) return { ...snapshot(), done: _job.done };
    throw Object.assign(new Error(`Tarsee is already ${describeJob(_job)}. Wait for it to finish, then try again.`), { code: "BUSY", status: 409 });
  }
  let release;
  try {
    release = acquireLock(pythonHome(), "speech-to-text download");
  } catch (err) {
    if (err.code === "LOCKED") throw Object.assign(new Error("Another speech-to-text download is running (perhaps from a terminal). Wait for it to finish, then try again."), { code: "BUSY", status: 409 });
    throw err;
  }
  const job = { kind, model, phase: "start", step: null, percent: 0, startedAt: new Date().toISOString() };
  const update = (patch) => {
    if (patch.percent !== undefined) patch.percent = Math.max(job.percent, Math.min(99, Math.floor(patch.percent)));
    Object.assign(job, patch);
  };
  _job = job;
  job.done = (async () => {
    try {
      await run(update);
      if (kind === "install") _last.install = { error: null, finishedAt: new Date().toISOString() };
      else _last.models[model] = { error: null, finishedAt: new Date().toISOString() };
      return { ok: true, error: null };
    } catch (err) {
      const error = err?.message || String(err);
      console.warn(`[stt] ${describeJob(job)} failed: ${error}`);
      if (kind === "install") _last.install = { error, finishedAt: new Date().toISOString() };
      else _last.models[model] = { error, finishedAt: new Date().toISOString() };
      return { ok: false, error };
    } finally {
      _job = null;
      release();
    }
  })();
  return { ...snapshot(job), done: job.done };
}

// ── Install faster-whisper ───────────────────────────────────────────────

/** pip's own words, when it fails, as the owner would say them. */
function pipProblem(err, pyVersion) {
  const text = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`;
  if (err?.timedOut) return "it took more than 20 minutes (a slow connection?)";
  if (/No space left on device|Errno 28/i.test(text)) return "the disk is full";
  if (/NewConnectionError|getaddrinfo|Name or service not known|Temporary failure in name resolution|Network is unreachable|ConnectTimeout|ReadTimeoutError|ProxyError|SSLError/i.test(text)) {
    return "could not reach pypi.org (check the internet connection)";
  }
  const nf = /No matching distribution found for ([^\s]+)/.exec(text);
  if (nf) {
    const pkg = nf[1].replace(/[<>=!~;[].*$/, "");
    return `pypi.org has no ready-made build of ${pkg} for this computer (Python ${pyVersion} on ${process.platform} ${process.arch})`;
  }
  const line = text.split(/\r?\n/).reverse().find((l) => /^ERROR:/.test(l.trim()));
  return line ? line.trim().replace(/^ERROR:\s*/, "") : (err?.message || "pip stopped");
}

async function pipWorks(python) {
  try { await runPython(python, ["-I", "-m", "pip", "--version"], { timeout: 60_000 }); return true; } catch { return false; }
}

/**
 * Start "Install faster-whisper" in the background. opts (tests): fetch, pin, retryDelayMs, log.
 * Returns the job (see begin).
 */
export function startSttInstall(opts = {}) {
  return begin("install", null, (update) => installFasterWhisper(update, opts));
}

async function installFasterWhisper(update, opts) {
  const log = opts.log || ((m) => console.log(`[stt:install] ${m}`));
  const dirs = sttDirs();
  fs.mkdirSync(dirs.home, { recursive: true });

  // 1. A Python to build on.
  update({ phase: "python", step: "Looking for Python on this computer", percent: 1 });
  let base;
  try {
    base = await ensureBasePython({
      allowDownload: true,
      fetch: opts.fetch,
      pin: opts.pin,
      retryDelayMs: opts.retryDelayMs,
      log,
      onProgress: ({ phase, bytesDone, bytesTotal }) => {
        const pin = opts.pin || STANDALONE_PYTHON;
        const mb = (n) => Math.round(n / 1e6);
        update(phase === "python-unpack"
          ? { phase: "python", step: `Unpacking Python ${pin.version}`, percent: 24 }
          : { phase: "python", step: `Downloading Python ${pin.version.split(".").slice(0, 2).join(".")} (${mb(bytesDone)} of ${mb(bytesTotal)} MB)`, percent: 2 + 20 * (bytesDone / bytesTotal) });
      },
    });
  } catch (err) {
    throw new Error(`Installing faster-whisper failed: ${err.message.replace(/\.$/, "")}.`);
  }
  log(`using ${base.label} (Python ${base.version}${base.executable ? `, ${base.executable}` : ""})`);

  // 2. A private folder for faster-whisper (a venv), made again if an earlier try left it without pip.
  update({ phase: "venv", step: "Making a private folder for faster-whisper", percent: 25 });
  const venvPy = { cmd: venvInterpreter(dirs.venv), args: [], label: "Tarsee's faster-whisper" };
  if (!fs.existsSync(venvPy.cmd) || !(await pipWorks(venvPy))) {
    fs.rmSync(dirs.venv, { recursive: true, force: true });
    try {
      await runPython(base, ["-I", "-m", "venv", dirs.venv], { timeout: 180_000 });
      if (!(await pipWorks(venvPy))) throw new Error("it has no pip");
    } catch (err) {
      fs.rmSync(dirs.venv, { recursive: true, force: true });
      throw new Error(`Installing faster-whisper failed: could not make its folder with ${base.label} (${err.message}).`);
    }
  }

  // 3. faster-whisper itself, pinned, from pypi.org only, ready-made builds only.
  update({ phase: "packages", step: `Downloading faster-whisper ${FASTER_WHISPER_VERSION}`, percent: 30 });
  let collected = 0;
  try {
    await runPython(venvPy, [
      "-I", "-m", "pip", "--isolated", "install",
      "--disable-pip-version-check", "--no-input", "--progress-bar", "off",
      "--only-binary=:all:", "--index-url", "https://pypi.org/simple",
      `faster-whisper==${FASTER_WHISPER_VERSION}`,
    ], {
      timeout: PIP_TIMEOUT_MS,
      onLine: (line) => {
        const dl = /^\s*Downloading\s+(\S+?)-\d[^\s]*\s*(?:\(([^)]+)\))?/.exec(line);
        if (/^\s*Collecting\s/.test(line)) collected++;
        if (dl) {
          update({ step: `Downloading faster-whisper's parts: ${dl[1].replace(/_/g, "-")}${dl[2] ? ` (${dl[2]})` : ""}`, percent: 30 + 40 * Math.min(1, collected / PIP_PACKAGES_EXPECTED) });
        } else if (/^Installing collected packages/.test(line)) {
          update({ step: "Installing faster-whisper's parts", percent: 72 });
        }
      },
    });
  } catch (err) {
    throw new Error(`Installing faster-whisper failed: ${pipProblem(err, base.version)}.`);
  }

  // 4. It loads.
  update({ phase: "check", step: "Checking faster-whisper works", percent: 76 });
  resetSttRuntime();
  const probe = await probePython(venvPy, { timeout: 120_000 });
  if (!probe.fasterWhisper) {
    throw new Error(`Installing faster-whisper failed: it was installed but doesn't load (${probe.problem || "no faster-whisper"}).`);
  }
  writeFileAtomic(path.join(dirs.venv, "tarsee-stt.json"), JSON.stringify({
    fasterWhisper: probe.fasterWhisper, python: base.version, pythonFrom: base.label, installedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  log(`faster-whisper ${probe.fasterWhisper} is ready in ${dirs.venv}`);

  // 5. A model, when there is none on disk yet.
  update({ phase: "model", step: null, percent: 78 });
  if (resolveSttModel(DEFAULT_WHISPER_MODEL).missing) {
    await downloadWhisperModel(DEFAULT_WHISPER_MODEL, dirs.models, {
      fetch: opts.fetch,
      catalog: _catalog,
      retryDelayMs: opts.retryDelayMs,
      log,
      onProgress: ({ bytesDone, bytesTotal }) => update({
        step: `Downloading the ${DEFAULT_WHISPER_MODEL} speech model (${Math.round(bytesDone / 1e6)} of ${Math.round(bytesTotal / 1e6)} MB)`,
        percent: 78 + 21 * (bytesDone / bytesTotal),
      }),
    }).catch((err) => {
      // Shown on the model's row too, with its Try again.
      _last.models[DEFAULT_WHISPER_MODEL] = { error: err.message, finishedAt: new Date().toISOString() };
      throw new Error(`faster-whisper is installed, but downloading the ${DEFAULT_WHISPER_MODEL} model failed: ${err.message}.`);
    });
  }
  resetSttRuntime();
}

// ── Models: Download and Delete ──────────────────────────────────────────

function badModel(name) {
  return Object.assign(new Error(`"${String(name).slice(0, 40)}" is not one of the speech models (${Object.keys(_catalog).join(", ")}).`), { status: 400, code: "UNKNOWN_MODEL" });
}

/** Start downloading a model in the background. opts (tests): fetch, retryDelayMs. Returns the job (see begin). */
export function startModelDownload(name, opts = {}) {
  if (!validModel(name)) throw badModel(name);
  return begin("model", name, async (update) => {
    update({ phase: "model", step: `Downloading ${name}`, percent: 0 });
    await downloadWhisperModel(name, sttDirs().models, {
      fetch: opts.fetch,
      catalog: _catalog,
      retryDelayMs: opts.retryDelayMs,
      log: opts.log || ((m) => console.log(`[stt] ${m}`)),
      onProgress: ({ bytesDone, bytesTotal }) => update({
        step: `Downloading ${name} (${Math.round(bytesDone / 1e6)} of ${Math.round(bytesTotal / 1e6)} MB)`,
        percent: 100 * (bytesDone / bytesTotal),
      }),
    });
  });
}

/** Whether the last download of this model failed less than `ms` ago (so a transcription doesn't retry it each time). */
export function modelFailedRecently(name, ms = 10 * 60_000) {
  const last = _last.models[name];
  return !!last?.error && Date.now() - Date.parse(last.finishedAt) < ms;
}

/** Delete a model's downloaded copy (never the image's). { removed: [folders], kept: <image folder>|null }. */
export async function removeSttModel(name) {
  if (!validModel(name)) throw badModel(name);
  if (_job?.kind === "model" && _job.model === name) {
    throw Object.assign(new Error(`${name} is downloading. Wait for it to finish, then delete it.`), { status: 409, code: "BUSY" });
  }
  delete _last.models[name];
  return deleteWhisperModel(name, sttDirs(), _catalog);
}

// ── Status (Settings > Voice > Speech-to-text) ───────────────────────────

function pythonInfo(p) {
  return p ? { label: p.label, version: p.version, executable: p.executable || null, source: p.source || null } : null;
}

/** Everything Settings shows: the runtime, every model, the running job. refresh: look for Python again. */
export async function getSttStatus({ refresh = false, settingsStore } = {}) {
  if (refresh && !_job) resetSttRuntime();
  const rt = await findSttRuntime();
  const dirs = sttDirs();
  const current = chosenModel(settingsStore);
  const target = pythonTarget();
  const own = rt.ready && rt.source === "tarsee";
  const python = rt.ready ? pythonInfo({ ...rt, source: rt.source }) : pythonInfo(rt.base);
  const installing = _job?.kind === "install";
  const lastError = _last.install?.error || null;

  let state;
  if (installing) state = "installing";
  else if (rt.ready) state = "ready";
  else if (lastError) state = "failed";
  else if (target.error && !rt.base) state = "unsupported";
  else state = "not-installed";

  const needsPythonDownload = !rt.ready && !rt.base;
  const pyMB = Math.round((STANDALONE_PYTHON.approxBytes || 47e6) / 1e6);
  let summary;
  if (state === "ready") {
    const where = own ? ` (Tarsee's own copy, in ${dirs.venv})` : rt.executable ? ` (${rt.executable})` : "";
    summary = `Ready: faster-whisper ${rt.fasterWhisper} on Python ${rt.version}${where}.`;
  } else if (state === "installing") {
    summary = "Installing faster-whisper…"; // (the step and its progress are the job's)
  } else if (state === "failed") {
    summary = lastError;
  } else if (state === "unsupported") {
    summary = `faster-whisper can't be installed here: ${target.error}. Choose the OpenAI Whisper API instead.`;
  } else if (rt.custom) {
    summary = `Not ready: ${rt.problem}.`;
  } else if (rt.base) {
    summary = `Not installed. Install sets faster-whisper up in Tarsee's own folder, using Python ${rt.base.version}${rt.base.executable ? ` (${rt.base.executable})` : ""}: about ${APPROX_PACKAGES_MB} MB to download.`;
  } else {
    summary = `Not installed, and there is no Python on this computer. Install downloads Tarsee's own copy of Python (about ${pyMB} MB) and faster-whisper (about ${APPROX_PACKAGES_MB} MB) into Tarsee's folder.`;
  }

  return {
    provider: settingsStore?.get?.("voice.stt_provider") || "local",
    current,
    runtime: {
      state,
      ready: !!rt.ready,
      summary,
      fasterWhisper: rt.ready ? rt.fasterWhisper : null,
      python,
      source: rt.ready ? rt.source : null,
      where: rt.ready && own ? dirs.venv : null,
      installFolder: dirs.home,
      needsPythonDownload,
      canInstall: !rt.ready && !installing && !rt.custom && state !== "unsupported",
      downloadMB: (needsPythonDownload ? pyMB : 0) + APPROX_PACKAGES_MB,
      error: state === "failed" ? lastError : null,
      version: FASTER_WHISPER_VERSION,
      platform: `${os.platform()} ${os.arch()}`,
    },
    models: listSttModels(current),
    modelsDir: dirs.models,
    bundledDirs: dirs.bundled,
    job: sttJob(),
  };
}

/** One line for the server log at boot: whether speech-to-text works out of the box. */
export async function sttBootLine(settingsStore) {
  const s = await getSttStatus({ settingsStore });
  const provider = s.provider === "whisper-api" ? "OpenAI Whisper API (chosen in Settings), with local as backup" : "local";
  if (!s.runtime.ready) {
    return `[stt] speech-to-text (${provider}): faster-whisper is not installed. Install it from Settings > Voice > Speech-to-text.`;
  }
  const m = resolveSttModel(s.current);
  const model = m.missing
    ? `no model on disk yet (${m.missing} downloads on first use)`
    : `model ${m.name} (${m.source === "image" ? "in the image" : m.source === "cache" ? "in the old download cache" : "downloaded"}${m.wanted ? `; ${m.wanted} was chosen but isn't downloaded` : ""})`;
  return `[stt] speech-to-text (${provider}): ready, faster-whisper ${s.runtime.fasterWhisper} on Python ${s.runtime.python?.version}, ${model}`;
}
