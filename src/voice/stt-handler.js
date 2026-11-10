/**
 * Speech-to-text: faster-whisper on this server (free, private, no API key), or the paid OpenAI Whisper API when the
 * owner chooses it (voice.stt_provider = "whisper-api").
 *
 * Use it with transcribeAudio(buffer, language, { settingsStore }), or over HTTP (routes/voice.js):
 *   POST /api/voice/transcribe   the audio as the body (a short WAV is fine; WebM/Opus, Ogg, MP3 and M4A work too),
 *                                or multipart with an "audio" file; X-Language: en (optional)
 *                                -> 200 { text, language, provider }, or { error } with 501 (not set up), 503 (no model
 *                                   yet, one is downloading) or 500 (this audio failed); the error says what to do
 *   POST /api/voice/stt/warm     start faster-whisper and load the model now (a call opening), so the first reply
 *                                isn't slowed by it -> { ok, model } or { ok: false, error }
 *
 * Local transcription runs one persistent worker (stt_worker.py) with the Python that has faster-whisper
 * (stt-install.js findSttRuntime: Tarsee's own install, or the Docker image's python3). The model loads once and
 * stays loaded; after 10 idle minutes the worker stops to give its memory back. The worker is always handed a model
 * folder on disk, never a name, so transcribing never downloads anything. When the chosen model isn't on disk, the
 * closest one that is transcribes and the chosen one downloads in the background.
 *
 * Models (whisper-models.js): tiny.en (~78 MB), base.en (~148 MB, the default, in the Docker image), small.en
 * (~486 MB); and tiny, base, small, which understand many languages. The .en ones are English only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnPython } from "./python-runtime.js";
import {
  findSttRuntime, chosenModel, resolveSttModel, startModelDownload, listSttModels, modelFailedRecently,
} from "./stt-install.js";
import { modelBytes } from "./whisper-models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, "stt_worker.py");
const BOOT_TIMEOUT_MS = 90_000;
const IDLE_MS = 10 * 60_000;

/** Kept for older callers: the chosen model is read from the settings on every transcription now. */
export function resetSTTModelCache() {}

// ── The worker ───────────────────────────────────────────────────────────

const lastLine = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";

class SttWorker {
  constructor() {
    this.proc = null;
    this.key = null;
    this.ready = null;
    this.isReady = false;
    this.pending = null;
    this.buf = "";
    this.errTail = "";
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.idle = null;
    this.version = null;
  }

  /** Start the worker for this Python (or keep the one running). Resolves when it has loaded faster-whisper. */
  start(rt) {
    const key = JSON.stringify(rt.python);
    if (this.proc && this.key === key) return this.ready;
    this.stop();
    this.key = key;
    this.isReady = false;
    this.buf = "";
    this.errTail = "";
    let resolveReady;
    let rejectReady;
    this.ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    this.ready.catch(() => {}); // a failed start is reported to the request that waits on it
    this._resolveReady = resolveReady;
    this._rejectReady = rejectReady;
    const proc = spawnPython(rt.python, ["-I", "-u", WORKER], {
      env: { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    const boot = setTimeout(() => {
      if (this.proc === proc && !this.isReady) this._exit(proc, `did not start within ${BOOT_TIMEOUT_MS / 1000}s`, true);
    }, BOOT_TIMEOUT_MS);
    boot.unref?.();
    this.ready.then(() => clearTimeout(boot), () => clearTimeout(boot));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this._onData(proc, chunk));
    proc.stderr.on("data", (chunk) => { this.errTail = (this.errTail + chunk.toString()).slice(-4000); });
    // A write to a worker that just died fails with EPIPE; without a listener that would take the server down.
    proc.stdin.on("error", () => {});
    proc.on("error", (err) => this._exit(proc, err.code === "ENOENT" ? "could not start: its Python was not found" : `could not start (${err.message})`));
    proc.on("exit", (code, signal) => this._exit(proc, `stopped (${signal || `exit code ${code}`})`));
    return this.ready;
  }

  _onData(proc, chunk) {
    if (proc !== this.proc) return;
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // a library printing to stdout
      if (msg.ready === true) {
        this.isReady = true;
        this.version = msg.version || null;
        this._resolveReady();
      } else if (msg.ready === false) {
        this._rejectReady(new Error(`faster-whisper did not start: ${msg.error || "unknown error"}`));
      } else if (this.pending && msg.id === this.pending.id) {
        const p = this.pending;
        this.pending = null;
        if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg);
      }
    }
  }

  _exit(proc, why, kill = false) {
    if (proc !== this.proc) return;
    this.proc = null;
    this.key = null;
    if (kill) { try { proc.kill(); } catch { /* gone */ } }
    const tail = lastLine(this.errTail);
    const err = new Error(`the speech-to-text worker ${why}${tail ? `: ${tail.slice(0, 300)}` : ""}`);
    if (!this.isReady) this._rejectReady?.(err);
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(err); }
  }

  /** Transcribe one file; requests run one at a time. */
  transcribe(rt, req, timeoutMs) {
    const task = async () => {
      clearTimeout(this.idle);
      await this.start(rt);
      const proc = this.proc;
      if (!proc) throw new Error("the speech-to-text worker stopped");
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        const timer = setTimeout(() => {
          if (this.pending?.id !== id) return;
          this.pending = null;
          reject(new Error(`faster-whisper took longer than ${Math.round(timeoutMs / 1000)}s`));
          this.stop(); // a stuck worker is replaced on the next request
        }, timeoutMs);
        timer.unref?.();
        this.pending = {
          id,
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        };
        proc.stdin.write(JSON.stringify({ id, ...req }) + "\n");
      });
    };
    const run = this.queue.then(task, task);
    this.queue = run.then(() => this._armIdle(), () => this._armIdle());
    return run;
  }

  _armIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), _idleMs);
    this.idle.unref?.();
  }

  stop() {
    clearTimeout(this.idle);
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.key = null;
    const err = new Error("the speech-to-text worker was stopped");
    if (!this.isReady) this._rejectReady?.(err);
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(err); }
    try { proc.kill(); } catch { /* already gone */ }
  }
}

const _worker = new SttWorker();
let _idleMs = IDLE_MS;
let _timeoutMs = null;

/** Stop the worker (before a model is deleted, after an install, at shutdown). The next transcription starts it again. */
export function stopSttWorker() {
  _worker.stop();
}

// ── Local transcription ──────────────────────────────────────────────────

/** How long one recording may take: loading the model, then about real time or better on a CPU. */
function timeoutFor(model, bytes) {
  if (_timeoutMs) return _timeoutMs;
  const size = model.replace(/\.en$/, "");
  const perSecond = size === "small" ? 1.5 : size === "base" ? 0.6 : 0.3;
  const seconds = bytes / 16_000; // Opus at ~128 kbit/s; a 16 kHz WAV is half this, so it gets twice the time
  return Math.min(10 * 60_000, Math.round(30_000 + seconds * perSecond * 1000 + 20_000));
}

function audioExt(buf) {
  const head = buf.subarray(0, 12);
  if (head.subarray(0, 4).toString("latin1") === "RIFF") return ".wav";
  if (head.subarray(0, 4).toString("latin1") === "OggS") return ".ogg";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return ".webm";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return ".m4a";
  if (head.subarray(0, 3).toString("latin1") === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return ".mp3";
  return ".audio";
}

/**
 * Start downloading a model nobody asked to download right now; false when another job is running, or when its last
 * download failed a moment ago (Settings shows why, with Try again; a recording doesn't retry it every time).
 */
function downloadQuietly(name) {
  if (modelFailedRecently(name)) return false;
  try {
    startModelDownload(name);
    return true;
  } catch {
    return false;
  }
}

/** Transcribe with faster-whisper on this server. */
async function transcribeLocal(audioBuffer, settingsStore) {
  const rt = await findSttRuntime();
  if (!rt.ready) throw sttError(`Speech-to-text is unavailable: ${NOT_INSTALLED}. ${INSTALL_OR_PAID}`, 501, "stt-unavailable");
  const model = resolveSttModel(chosenModel(settingsStore));
  if (model.missing) {
    const mb = Math.round(modelBytes(model.missing) / 1e6);
    const started = downloadQuietly(model.missing);
    throw sttError(started
      ? `No speech model is downloaded yet. Tarsee is downloading ${model.missing} (${mb} MB) now: try again in a minute.`
      : "No speech model is downloaded yet. Download one in Settings > Voice > Speech-to-text.", 503, "stt-unavailable");
  }
  if (model.wanted && downloadQuietly(model.wanted)) {
    console.log(`[stt] ${model.wanted} isn't downloaded yet: downloading it, and using ${model.name} meanwhile`);
  }
  const english = model.name.endsWith(".en");
  const tmp = path.join(os.tmpdir(), `tarsee-stt-${crypto.randomBytes(6).toString("hex")}${audioExt(audioBuffer)}`);
  fs.writeFileSync(tmp, audioBuffer);
  try {
    const res = await _worker.transcribe(rt, {
      audio: tmp,
      model: model.dir,
      language: english ? "en" : null,
      threads: Math.max(1, Math.min(4, os.availableParallelism())),
    }, timeoutFor(model.name, audioBuffer.length));
    const text = String(res.text || "").trim();
    console.log(`[stt] faster-whisper (${model.name}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" [${res.duration ?? "?"}s audio]`);
    return { transcript: text, language: res.language || (english ? "en" : "auto"), provider: `faster-whisper (${model.name})` };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Start faster-whisper and load the chosen model now (a call opening), so the first recording isn't slowed by it.
 * { ok, model } or { ok: false, error }. Never throws.
 */
export async function warmSTT(settingsStore) {
  try {
    if ((settingsStore?.get?.("voice.stt_provider") || "local") !== "local") return { ok: true, model: null, skipped: "the OpenAI Whisper API is chosen" };
    const rt = await findSttRuntime();
    if (!rt.ready) return { ok: false, error: `${NOT_INSTALLED}. ${INSTALL_OR_PAID}` };
    const model = resolveSttModel(chosenModel(settingsStore));
    if (model.missing) return { ok: false, error: "No speech model is downloaded yet. Download one in Settings > Voice > Speech-to-text." };
    // A tenth of a second of silence: loads the model, transcribes nothing.
    const silence = Buffer.alloc(44 + 3200);
    silence.write("RIFF", 0, "latin1"); silence.writeUInt32LE(36 + 3200, 4); silence.write("WAVEfmt ", 8, "latin1");
    silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22); silence.writeUInt32LE(16000, 24);
    silence.writeUInt32LE(32000, 28); silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write("data", 36, "latin1"); silence.writeUInt32LE(3200, 40);
    const tmp = path.join(os.tmpdir(), `tarsee-stt-warm-${crypto.randomBytes(6).toString("hex")}.wav`);
    fs.writeFileSync(tmp, silence);
    try {
      await _worker.transcribe(rt, { audio: tmp, model: model.dir, language: model.name.endsWith(".en") ? "en" : null, threads: Math.max(1, Math.min(4, os.availableParallelism())) }, timeoutFor(model.name, 0));
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
    }
    return { ok: true, model: model.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Local transcription (faster-whisper): whether it is installed, and the transcriber. Swapped only by tests. */
const LOCAL = { available: async () => (await findSttRuntime()).ready, transcribe: transcribeLocal };
let _local = LOCAL;

/**
 * Tests only: replace the local transcriber's `available` and/or `transcribe` (no `local` restores the real one);
 * timeoutMs and idleMs shorten the worker's waits.
 */
export function __setForTests({ local, timeoutMs, idleMs } = {}) {
  _local = local ? { ...LOCAL, ...local } : LOCAL;
  _timeoutMs = timeoutMs || null;
  _idleMs = idleMs || IDLE_MS;
}

// ── The OpenAI Whisper API ───────────────────────────────────────────────

/**
 * Transcribe audio using OpenAI Whisper API.
 */
async function transcribeWhisperAPI(audioBuffer, language, apiKey) {
  const boundary = "----TarseeSTTBoundary" + Date.now();
  const parts = [];

  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`);
  parts.push(audioBuffer);
  parts.push("\r\n");
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
  if (language) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language.split("-")[0]}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`);
  parts.push(`--${boundary}--\r\n`);

  const body = Buffer.concat(parts.map(p => typeof p === "string" ? Buffer.from(p) : p));

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw Object.assign(new Error(`Whisper API error (${res.status}): ${await res.text()}`), { apiStatus: res.status });
  const data = await res.json();
  console.log(`[stt] Whisper API: "${data.text?.slice(0, 80)}..."`);
  return { transcript: data.text || "", language: language?.split("-")[0] || "en", provider: "whisper-api" };
}

// ── Choosing ─────────────────────────────────────────────────────────────

const NOT_INSTALLED = "local transcription (faster-whisper) is not installed on this server";
/** Where the owner sets local transcription up, or turns the paid API on. */
const INSTALL_OR_PAID = 'Install it in Settings > Voice > Speech-to-text (one click), or choose the paid "OpenAI Whisper API" there.';
/** Where the owner turns the paid API on. */
const CHOOSE_PAID = 'The paid OpenAI Whisper API is off; to use it instead, choose "OpenAI Whisper API" in Settings > Voice > Speech-to-text.';

/** An error whose message the owner can act on; `status` is what the HTTP routes answer with. */
function sttError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Transcribe audio with the provider the owner chose (setting voice.stt_provider):
 *   "local" (default) → faster-whisper on this server (free, no API key). Nothing paid is ever called.
 *   "whisper-api"     → OpenAI Whisper API (paid, $0.006/min) with the saved OpenAI key. When that call fails or
 *                       there is no key, free local transcription is tried.
 * The paid API runs only when chosen: an OpenAI key saved for anything else (a Railway OPENAI_API_KEY, the chat AI's
 * key) never turns it on. When nothing can transcribe, the error says why and what to change.
 */
export async function transcribeAudio(audioBuffer, language, opts = {}) {
  const settingsStore = opts.settingsStore;
  const provider = settingsStore?.get?.("voice.stt_provider") || "local";

  // OpenAI Whisper API: only when the owner chose it. What went wrong with it, and what to do, if local can't help either.
  let paidProblem = null;
  let fix = CHOOSE_PAID;
  let installFix = INSTALL_OR_PAID;
  if (provider === "whisper-api") {
    const openaiKey = settingsStore?.getApiKey?.("openai");
    if (!openaiKey) {
      paidProblem = "Speech-to-text is set to the OpenAI Whisper API, but no OpenAI API key is saved";
      fix = installFix = "Add the key in Settings > Voice > Speech-to-text.";
    } else {
      try {
        return await transcribeWhisperAPI(audioBuffer, language, openaiKey);
      } catch (err) {
        console.warn("[stt] Whisper API failed, trying local:", err.message);
        paidProblem = `The OpenAI Whisper API failed${err.apiStatus ? ` (HTTP ${err.apiStatus})` : ""}`;
        fix = installFix = "The server log has the details.";
      }
    }
  }

  // Local faster-whisper (free, no API key)
  if (!(await _local.available())) {
    throw sttError(paidProblem ? `${paidProblem}, and ${NOT_INSTALLED}. ${fix}` : `Speech-to-text is unavailable: ${NOT_INSTALLED}. ${installFix}`, 501, "stt-unavailable");
  }
  try {
    return await _local.transcribe(audioBuffer, settingsStore);
  } catch (err) {
    // Already in words the owner can act on (no model yet: one is downloading).
    if (err.code === "stt-unavailable" && err.status) throw paidProblem ? sttError(`${paidProblem}. ${err.message}`, err.status, err.code) : err;
    console.warn("[stt] faster-whisper failed:", err.message);
    const local = "local transcription (faster-whisper) could not transcribe this audio";
    throw sttError(paidProblem ? `${paidProblem}, and ${local}. ${fix}` : `Speech-to-text failed: ${local} (the server log has the details). ${fix}`, 500, "stt-failed");
  }
}

/** The models for Settings (stt-install.js listSttModels): size, whether downloaded, and where. */
export function getSTTModels(settingsStore) {
  return listSttModels(chosenModel(settingsStore));
}
