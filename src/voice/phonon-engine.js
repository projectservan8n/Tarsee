/**
 * Phonon TTS engine: Gradium's open-weight Phonon 31M English model
 * (gradium/phonon-31m-en, Apache-2.0) run by the ptts runtime (MIT or
 * Apache-2.0). Fully local and CPU-only: no API key, and no network once the
 * model is on disk.
 *
 * Setup: Settings -> Voice -> Install Phonon, or the automatic background
 * install on first boot (see phonon-install.js). The model and the English
 * voices live on the data volume under DATA_DIR/tts/phonon (TARSEE_PHONON_DIR
 * overrides it), never in git or the image.
 *
 * One persistent Python worker (phonon_worker.py) loads the model once and
 * answers synth requests as line-based JSON on stdin/stdout, so each sentence
 * costs only inference time. Requests are serialised; a synth that takes longer
 * than SYNTH_TIMEOUT_MS kills the worker, and the next request starts a fresh
 * one.
 *
 * engine-registry.js wraps this engine so that a failed sentence is spoken by
 * Edge TTS instead, and uses Edge TTS outright while Phonon is not installed.
 * Voice cloning exists only in Gradium's paid API, so it is not offered here.
 */

import { TTSEngine } from "./tts-interface.js";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import config from "../config/env.js";
import { phononSpeechText } from "./speech-text.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The English voices of gradium/phonon-voices that the installer downloads. */
export const VOICES = [
  { id: "toby", name: "Toby (British male, adult)" },
  { id: "teddy", name: "Teddy (British male, young adult)" },
  { id: "hugh", name: "Hugh (British male, middle-aged)" },
  { id: "edwin", name: "Edwin (British male, middle-aged)" },
  { id: "spencer", name: "Spencer (British male, middle-aged)" },
  { id: "alfie", name: "Alfie (British male, young adult)" },
  { id: "maeve", name: "Maeve (British female, adult)" },
  { id: "freya", name: "Freya (British female, young)" },
  { id: "pippa", name: "Pippa (British female, adult)" },
  { id: "elodie-rose", name: "Elodie-Rose (British female, young)" },
  { id: "imogen", name: "Imogen (British female, adult)" },
  { id: "lottie", name: "Lottie (British female, young adult)" },
  { id: "bryony", name: "Bryony (British female, middle-aged)" },
  { id: "easton", name: "Easton (American male, young adult)" },
  { id: "micah", name: "Micah (American male, young adult)" },
  { id: "trevor", name: "Trevor (American male, middle-aged)" },
  { id: "russell", name: "Russell (American male, adult)" },
  { id: "preston", name: "Preston (American male, middle-aged)" },
  { id: "miles", name: "Miles (American male, young adult)" },
  { id: "zoey", name: "Zoey (American female, adult)" },
  { id: "juniper", name: "Juniper (American female, young adult)" },
  { id: "everly", name: "Everly (American female, middle-aged)" },
  { id: "harper", name: "Harper (American female, adult)" },
  { id: "hadley", name: "Hadley (American female, middle-aged)" },
  { id: "delia", name: "Delia (American female, middle-aged)" },
];
export const DEFAULT_VOICE = "toby";

// Phonon's speaking rate is a model condition (duration_delta), not a time
// stretch, and it only holds over a narrow range: past about 1.25x the model
// stops speeding up and then breaks down. 1.0 is its natural pace.
export const SPEED_MIN = 0.85;
export const SPEED_MAX = 1.25;
export const DEFAULT_SPEED = 1.0;
const SPEED_TO_DELTA = [[0.85, 0.5], [0.9, 0.15], [1.0, 0], [1.1, -0.15], [1.2, -0.3], [1.25, -0.45]];

export function clampSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return DEFAULT_SPEED;
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, n));
}

/** Speaking rate (1.0 natural) to the model's duration_delta condition. */
export function speedToDelta(speed) {
  const s = clampSpeed(speed);
  for (let i = 1; i < SPEED_TO_DELTA.length; i++) {
    const [s1, d1] = SPEED_TO_DELTA[i];
    if (s <= s1) {
      const [s0, d0] = SPEED_TO_DELTA[i - 1];
      return Math.round((d0 + ((s - s0) / (s1 - s0)) * (d1 - d0)) * 1000) / 1000;
    }
  }
  return SPEED_TO_DELTA[SPEED_TO_DELTA.length - 1][1];
}

/** A Phonon voice from an id, a bare name ("Toby") or "phonon:toby"; null when it is not one. */
export function findVoice(want) {
  const w = String(want || "").toLowerCase().trim().replace(/^phonon:/, "");
  if (!w) return null;
  return VOICES.find((v) => v.id === w)
    || VOICES.find((v) => v.name.toLowerCase().startsWith(w))
    || null;
}

/** The name the voice catalog knows a voice by ("toby" is "Toby"). */
function catalogName(id) {
  const v = VOICES.find((x) => x.id === id);
  return v ? v.name.split(" (")[0] : id;
}

/** File written last by the installer; its presence means the install finished. */
export const INSTALL_MARKER = "install.json";

/**
 * Where everything lives. The Python interpreter is TARSEE_PHONON_PYTHON if set,
 * else the private venv the installer creates on machines without ptts (when
 * it exists), else python3 on PATH (the Docker image installs ptts there).
 */
export function phononPaths() {
  const root = process.env.TARSEE_PHONON_DIR?.trim() || path.join(config.DATA_DIR, "tts", "phonon");
  const venv = path.join(root, "venv");
  const venvPython = path.join(venv, "bin", "python");
  const override = process.env.TARSEE_PHONON_PYTHON?.trim();
  const useVenv = !override && fs.existsSync(venvPython);
  return {
    root,
    venv,
    venvPython,
    python: override || (useVenv ? venvPython : "python3"),
    usesVenv: useVenv,
    model: path.join(root, "models", "phonon-31m-en"),
    catalog: path.join(root, "catalog"),
    marker: path.join(root, INSTALL_MARKER),
    worker: path.join(__dirname, "phonon_worker.py"),
  };
}

/** The model and voices are on disk and the install finished (no Python run). */
export function phononInstalled(p = phononPaths()) {
  return fs.existsSync(p.marker)
    && fs.existsSync(path.join(p.model, "config.json"))
    && fs.existsSync(path.join(p.model, "model.q8.gguf"))
    && fs.existsSync(path.join(p.catalog, "voices.jsonl"))
    && fs.existsSync(p.worker);
}

// `python -c "import ptts"` results, per interpreter. Only a finished install
// gets this far, so the cost is one short Python run per interpreter.
const _importChecks = new Map();

/** Whether `python` can import ptts. Cached per interpreter path. */
export function canImportPtts(python) {
  if (!_importChecks.has(python)) {
    _importChecks.set(python, new Promise((resolve) => {
      execFile(python, ["-I", "-c", "import ptts"], { timeout: 30_000 }, (err) => resolve(!err));
    }));
  }
  return _importChecks.get(python);
}

/** Forget cached availability (after an install, so the next check sees it). */
export function resetPhononAvailability() {
  _importChecks.clear();
}

/** Worker threads: TARSEE_PHONON_THREADS, else up to 4 (more rarely helps on CPU). */
export function phononThreads() {
  const n = Number.parseInt(process.env.TARSEE_PHONON_THREADS || "", 10);
  if (Number.isFinite(n) && n > 0) return n;
  return Math.max(1, Math.min(4, os.availableParallelism()));
}

const SYNTH_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 120_000;

/** Persistent worker: one spawned Python process and a serial request queue. */
class PhononWorker {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.device = "unknown";
    this.queue = Promise.resolve();
    this.pending = null;
    this.stdoutBuf = "";
    this._newReady();
  }

  _newReady() {
    this._readyPromise = new Promise((r) => { this._readyResolver = r; });
  }

  start() {
    if (this.proc) return this._readyPromise;
    const p = phononPaths();
    this.ready = false;
    this.stdoutBuf = "";
    this._bootError = null;
    this.proc = spawn(p.python, ["-I", "-u", p.worker], {
      env: {
        ...process.env,
        ...(p.usesVenv ? { VIRTUAL_ENV: p.venv } : {}),
        PHONON_MODEL_DIR: p.model,
        PHONON_CATALOG: p.catalog,
        PHONON_THREADS: String(phononThreads()),
        HF_HUB_OFFLINE: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const proc = this.proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    proc.stderr.on("data", (chunk) => {
      const txt = chunk.toString().trim();
      if (txt) console.warn(`[phonon:worker stderr] ${txt.slice(0, 300)}`);
    });
    // A write to a worker that just died fails with EPIPE on stdin; without a
    // listener that error would be thrown and take the server down.
    proc.stdin.on("error", (err) => console.warn(`[phonon:worker] stdin: ${err.message}`));
    proc.on("error", (err) => this._onExit(proc, `spawn error: ${err.message}`));
    proc.on("exit", (code, signal) => this._onExit(proc, `code=${code} signal=${signal}`));

    const bootTimer = setTimeout(() => {
      if (this.proc === proc && !this.ready) {
        this._bootError = `no ready signal after ${BOOT_TIMEOUT_MS / 1000}s`;
        console.warn(`[phonon:worker] ${this._bootError}, stopping it`);
        this.stop();
      }
    }, BOOT_TIMEOUT_MS);
    bootTimer.unref?.();
    this._readyPromise.then(() => clearTimeout(bootTimer));
    return this._readyPromise;
  }

  _onExit(proc, why) {
    if (this.proc !== proc) return; // an older process already replaced or stopped
    console.warn(`[phonon:worker] exited ${why}`);
    this.proc = null;
    this.ready = false;
    if (!this._bootError) this._bootError = `exited ${why}`;
    this._readyResolver?.(); // wake anyone waiting; they see ready=false
    this._newReady();
    if (this.pending) { this.pending.reject(new Error(`Phonon worker died (${why})`)); this.pending = null; }
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { console.warn(`[phonon:worker] non-JSON: ${line.slice(0, 200)}`); continue; }
      if (msg.ready === true && !this.ready) {
        this.ready = true;
        this.device = msg.device || "unknown";
        console.log(`[phonon] worker ready on ${this.device} (boot ${msg.boot_ms}ms, ${(msg.voices || []).length} voices)`);
        this._readyResolver?.();
        continue;
      }
      if (msg.ready === false) {
        console.warn(`[phonon] worker failed to start: ${(msg.error || "").slice(0, 200)}`);
        this._bootError = msg.error || "worker failed to start";
        this._readyResolver?.();
        continue;
      }
      if (this.pending) {
        const { resolve, reject } = this.pending;
        this.pending = null;
        if (msg.ok) resolve(msg); else reject(new Error(msg.error || "phonon worker error"));
      }
    }
  }

  synth(req) {
    const task = async () => {
      if (!this.proc) this.start();
      await this._readyPromise;
      if (!this.ready || !this.proc) throw new Error(`Phonon worker never became ready${this._bootError ? `: ${this._bootError}` : ""}`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending?.reject === rejectOnce) {
            this.pending = null;
            reject(new Error(`Phonon synth timed out after ${SYNTH_TIMEOUT_MS / 1000}s`));
            this.stop(); // a stuck worker is replaced on the next request
          }
        }, SYNTH_TIMEOUT_MS);
        timer.unref?.();
        const resolveOnce = (v) => { clearTimeout(timer); resolve(v); };
        const rejectOnce = (e) => { clearTimeout(timer); reject(e); };
        this.pending = { resolve: resolveOnce, reject: rejectOnce };
        this.proc.stdin.write(JSON.stringify(req) + "\n");
      });
    };
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.ready = false;
    if (this.pending) { this.pending.reject(new Error("Phonon worker stopped")); this.pending = null; }
    this._readyResolver?.();
    this._newReady();
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

let _sharedWorker = null;
function getWorker() {
  if (!_sharedWorker) _sharedWorker = new PhononWorker();
  return _sharedWorker;
}

/** Stop the warm Phonon worker (the engine was switched away from Phonon, or shutdown). */
export function stopPhononWorker() {
  if (_sharedWorker) { _sharedWorker.stop(); _sharedWorker = null; }
}

export class PhononTTSEngine extends TTSEngine {
  /**
   * @param {string} [defaultVoice] a Phonon voice id or name (voice.phonon.voice)
   * @param {{ barePeso?: boolean }} [opts] barePeso: read "P2,500" as pesos too (voice.phonon.barePeso)
   */
  constructor(defaultVoice, opts = {}) {
    super();
    const v = findVoice(defaultVoice);
    if (defaultVoice && !v) console.warn(`[phonon] voice "${defaultVoice}" is not a Phonon voice, using ${DEFAULT_VOICE}.`);
    this._defaultVoice = v ? v.id : DEFAULT_VOICE;
    this._speed = DEFAULT_SPEED;
    this._barePeso = !!opts.barePeso;
  }

  get name() { return "phonon"; }

  get defaultVoice() { return this._defaultVoice; }

  /** Installed, and the interpreter can import ptts. Never downloads anything. */
  async isAvailable() {
    const p = phononPaths();
    if (!phononInstalled(p)) return false;
    return canImportPtts(p.python);
  }

  setSpeed(speed) {
    this._speed = clampSpeed(speed);
  }

  /** Start the worker ahead of the first reply (opening voice mode). */
  async warm() {
    const w = getWorker();
    await w.start();
    if (!w.ready) throw new Error("Phonon worker did not start");
  }

  /** The text as Phonon will be given it (markdown and emoji gone, pesos written out). */
  speechText(text) {
    return phononSpeechText(text, { barePeso: this._barePeso });
  }

  async synthesize(text, voiceId, opts = {}) {
    if (!text) throw new Error("Text is required");
    text = this.speechText(text);
    if (!text) throw Object.assign(new Error("No speakable text after cleanup"), { code: "EMPTY_TEXT" });

    // Ids from other engines (an Edge or ElevenLabs voice) are not Phonon
    // voices: speak with Phonon's own default rather than fail.
    const voice = findVoice(voiceId)?.id || this._defaultVoice;
    const speed = opts.speed !== undefined ? clampSpeed(opts.speed) : this._speed;

    const tmpOut = path.join(os.tmpdir(), `phonon-${crypto.randomBytes(6).toString("hex")}.wav`);
    const worker = getWorker();
    const t0 = Date.now();
    try {
      const res = await worker.synth({ text, voice: catalogName(voice), duration_delta: speedToDelta(speed), out: tmpOut });
      const audio = fs.readFileSync(tmpOut);
      if (audio.length < 100) throw new Error("Phonon generated empty audio");
      console.log(`[phonon] ${text.length} chars, voice=${voice}, ${audio.length}B in ${Date.now() - t0}ms (worker ${res.ms}ms on ${worker.device})`);
      return { audio, contentType: "audio/wav" };
    } finally {
      try { fs.unlinkSync(tmpOut); } catch { /* not written */ }
    }
  }

  async listVoices() {
    return VOICES.map((v) => ({ id: v.id, name: v.name, isClone: false }));
  }

  async cloneVoice() {
    throw Object.assign(new Error("Phonon has no local voice cloning (it is only in Gradium's paid API). Pick one of its built-in voices."), { status: 400 });
  }

  stop() {
    stopPhononWorker();
  }
}
