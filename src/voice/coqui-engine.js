import { TTSEngine } from "./tts-interface.js";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import config from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TTS_SERVER_PORT = 5002;
const TTS_SERVER_HOST = "127.0.0.1";
const TTS_SERVER_URL = `http://${TTS_SERVER_HOST}:${TTS_SERVER_PORT}`;

// Default XTTS v2 model — best zero-shot cloning
const DEFAULT_MODEL = "tts_models/multilingual/multi-dataset/xtts_v2";

/**
 * Coqui TTS engine.
 * Manages a Python TTS server subprocess and communicates via HTTP.
 *
 * XTTS v2 features:
 * - Zero-shot voice cloning from ~6 seconds of audio
 * - Multilingual (17 languages)
 * - CPU-compatible (slower but works)
 * - ~500MB-1GB RAM usage
 */
export class CoquiTTSEngine extends TTSEngine {
  constructor(opts = {}) {
    super();
    this.model = opts.model || DEFAULT_MODEL;
    this.serverProc = null;
    this.ready = false;
    this.starting = null;
    this.voicesDir = path.join(config.DATA_DIR, "voices");
    this.modelsDir = path.join(config.DATA_DIR, "tts-models");

    // Ensure directories exist
    try {
      fs.mkdirSync(this.voicesDir, { recursive: true });
      fs.mkdirSync(this.modelsDir, { recursive: true });
    } catch { /* best effort */ }
  }

  get name() {
    return "coqui";
  }

  /**
   * Start the Coqui TTS server if not already running.
   */
  async ensureRunning() {
    if (this.ready) {
      // Quick health check
      try {
        const res = await fetch(`${TTS_SERVER_URL}/api/tts-ready`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* not ready, restart */ }
      this.ready = false;
    }

    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = this._start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async _start() {
    console.log("[coqui] starting TTS server...");

    // Kill existing process if any
    this.stop();

    const scriptPath = path.join(__dirname, "coqui-server.py");

    this.serverProc = childProcess.spawn("python3", [
      scriptPath,
      "--port", String(TTS_SERVER_PORT),
      "--host", TTS_SERVER_HOST,
      "--model", this.model,
      "--models-dir", this.modelsDir,
      "--voices-dir", this.voicesDir,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        COQUI_TOS_AGREED: "1",  // Auto-agree to Coqui TOS
      },
    });

    let serverOutput = "";

    this.serverProc.stdout.on("data", (d) => {
      const line = d.toString();
      serverOutput += line;
      if (line.includes("[coqui-server] ready")) {
        this.ready = true;
      }
    });

    this.serverProc.stderr.on("data", (d) => {
      const line = d.toString();
      serverOutput += line;
      // TTS library logs to stderr
      if (line.includes("Running on") || line.includes("ready")) {
        this.ready = true;
      }
    });

    this.serverProc.on("exit", (code, signal) => {
      console.warn(`[coqui] server exited with code ${code} signal ${signal}`);
      if (serverOutput) console.warn(`[coqui] last output: ${serverOutput.slice(-500)}`);
      this.ready = false;
      this.serverProc = null;
    });

    this.serverProc.on("error", (err) => {
      console.error("[coqui] server spawn error:", err.message);
      this.ready = false;
      this.serverProc = null;
    });

    // Wait for server to be ready (up to 120s for first-time model download)
    const timeout = 120_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.ready) return;

      try {
        const res = await fetch(`${TTS_SERVER_URL}/api/tts-ready`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          this.ready = true;
          console.log("[coqui] TTS server ready");
          return;
        }
      } catch { /* not ready yet */ }

      await new Promise((r) => setTimeout(r, 1000));
    }

    // Check if process died
    if (!this.serverProc) {
      throw Object.assign(
        new Error(`Coqui TTS server failed to start. Output:\n${serverOutput.slice(-500)}`),
        { status: 503 }
      );
    }

    throw Object.assign(
      new Error("Coqui TTS server did not become ready in time (120s). First run may need to download the model (~2GB)."),
      { status: 503 }
    );
  }

  /**
   * Stop the TTS server.
   */
  stop() {
    if (this.serverProc) {
      try { this.serverProc.kill("SIGTERM"); } catch { /* ignore */ }
      this.serverProc = null;
    }
    this.ready = false;
  }

  /**
   * Synthesize text to audio using Coqui TTS.
   */
  async synthesize(text, voiceId) {
    if (!text) throw Object.assign(new Error("Text is required"), { status: 400 });

    await this.ensureRunning();

    const params = new URLSearchParams({ text });

    // If voiceId is provided, use the cloned voice sample
    if (voiceId) {
      const samplePath = path.join(this.voicesDir, `${voiceId}.wav`);
      if (!fs.existsSync(samplePath)) {
        throw Object.assign(new Error(`Voice profile '${voiceId}' not found`), { status: 404 });
      }
      params.set("speaker_wav", samplePath);
    }

    params.set("language", "en");

    const res = await fetch(`${TTS_SERVER_URL}/api/tts?${params}`, {
      signal: AbortSignal.timeout(60_000), // TTS can be slow on CPU
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw Object.assign(new Error(`Coqui TTS error: ${errText}`), { status: 502 });
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: "audio/wav",
    };
  }

  /**
   * Clone a voice from an audio sample.
   * XTTS v2 does zero-shot cloning — just needs a reference audio file.
   */
  async cloneVoice(audioSample, voiceName) {
    if (!audioSample || audioSample.length === 0) {
      throw Object.assign(new Error("Audio sample is required (6-30 seconds recommended)"), { status: 400 });
    }
    if (!voiceName) {
      throw Object.assign(new Error("Voice name is required"), { status: 400 });
    }

    // Generate a voice ID
    const crypto = await import("node:crypto");
    const voiceId = crypto.randomUUID();

    // Save the audio sample as the voice reference
    const samplePath = path.join(this.voicesDir, `${voiceId}.wav`);

    // If the input isn't WAV, we still save it — Coqui can handle various formats
    fs.writeFileSync(samplePath, audioSample);

    // Verify the server can use this sample by doing a quick test synthesis
    try {
      await this.ensureRunning();

      const params = new URLSearchParams({
        text: "Voice profile created successfully.",
        speaker_wav: samplePath,
        language: "en",
      });

      // First request triggers model download + load — allow 5 minutes
      const res = await fetch(`${TTS_SERVER_URL}/api/tts?${params}`, {
        signal: AbortSignal.timeout(300_000),
      });

      if (!res.ok) {
        fs.unlinkSync(samplePath);
        const errText = await res.text().catch(() => "");
        throw new Error(`Voice sample rejected: ${errText}`);
      }

      // Discard the test audio
      await res.arrayBuffer();
    } catch (err) {
      // Clean up on failure
      try { fs.unlinkSync(samplePath); } catch { /* ignore */ }
      throw Object.assign(
        new Error(`Voice cloning failed: ${err.message}`),
        { status: 400 }
      );
    }

    console.log(`[coqui] voice cloned: ${voiceName} (${voiceId})`);
    return { voiceId, name: voiceName };
  }

  /**
   * List available voices.
   */
  async listVoices() {
    const voices = [];

    // List cloned voice samples
    try {
      const files = fs.readdirSync(this.voicesDir);
      for (const file of files) {
        if (file.endsWith(".wav")) {
          const id = file.replace(".wav", "");
          voices.push({ id, name: id, isClone: true });
        }
      }
    } catch { /* no voices dir */ }

    return voices;
  }

  /**
   * Check if Coqui TTS is available.
   */
  async isAvailable() {
    // Check if python3 and TTS are installed
    try {
      const result = await new Promise((resolve) => {
        const proc = childProcess.spawn("python3", ["-c", "import TTS; print('ok')"], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        });
        let out = "";
        proc.stdout.on("data", (d) => out += d);
        proc.on("close", (code) => resolve({ code, out }));
        proc.on("error", () => resolve({ code: 1, out: "" }));
      });
      return result.code === 0 && result.out.includes("ok");
    } catch {
      return false;
    }
  }
}
