/**
 * Piper TTS engine — ultra-fast local text-to-speech.
 * Sub-500ms latency, runs on CPU, no API key, no internet needed.
 * Uses ONNX voice models (.onnx + .onnx.json pairs).
 * Models stored on volume at /data/tarsee/piper-voices/
 */

import { TTSEngine } from "./tts-interface.js";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const VOICES_DIR = path.join(process.env.TARSEE_DATA_DIR || process.env.TARSEE_STATE_DIR || "/data/tarsee", "piper-voices");

export class PiperTTSEngine extends TTSEngine {
  constructor(defaultVoice) {
    super();
    fs.mkdirSync(VOICES_DIR, { recursive: true });
    this._defaultVoice = defaultVoice || null;
  }

  get name() { return "piper"; }

  async isAvailable() {
    try {
      execSync("which piper", { stdio: "ignore", timeout: 3000 });
      // Check if at least one voice model exists
      const voices = this._scanVoices();
      return voices.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Scan the voices directory for .onnx model files.
   * Each voice needs a .onnx and matching .onnx.json config file.
   */
  _scanVoices() {
    try {
      const files = fs.readdirSync(VOICES_DIR);
      const onnxFiles = files.filter(f => f.endsWith(".onnx") && !f.endsWith(".onnx.json"));
      return onnxFiles
        .filter(f => {
          // Must have matching .onnx.json config
          const jsonFile = f + ".json";
          return files.includes(jsonFile);
        })
        .map(f => {
          const id = f.replace(".onnx", "");
          // Try to extract a friendly name from the .onnx.json
          let friendlyName = id;
          try {
            const config = JSON.parse(fs.readFileSync(path.join(VOICES_DIR, f + ".json"), "utf8"));
            if (config.dataset) friendlyName = config.dataset;
            else if (config.language?.name_english) friendlyName = `${id} (${config.language.name_english})`;
          } catch { /* use filename */ }
          return { id, file: f, name: friendlyName };
        });
    } catch { return []; }
  }

  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");

    // Strip emojis and markdown
    text = text
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}\u{FE0F}]/gu, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~#>]/g, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!text) throw new Error("No speakable text after cleanup");

    // Resolve voice model path
    const voices = this._scanVoices();
    let modelPath;

    if (voiceId) {
      const voice = voices.find(v => v.id === voiceId);
      if (voice) modelPath = path.join(VOICES_DIR, voice.file);
    }

    if (!modelPath && this._defaultVoice) {
      const voice = voices.find(v => v.id === this._defaultVoice);
      if (voice) modelPath = path.join(VOICES_DIR, voice.file);
    }

    if (!modelPath && voices.length > 0) {
      modelPath = path.join(VOICES_DIR, voices[0].file);
    }

    if (!modelPath) throw new Error("No Piper voice models found. Upload .onnx + .onnx.json files in Settings > Voice.");

    const tmpOut = `/tmp/piper-${crypto.randomBytes(4).toString("hex")}.wav`;

    try {
      // Pipe text to piper via stdin, output to wav file
      // --sentence_silence adds natural pauses between sentences
      execFileSync("piper", [
        "--model", modelPath,
        "--output_file", tmpOut,
        "--sentence_silence", "0.3",
      ], {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 15_000,
      });

      const audio = fs.readFileSync(tmpOut);
      if (audio.length < 100) throw new Error("Piper generated empty audio");

      return { audio, contentType: "audio/wav" };
    } finally {
      try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    }
  }

  async listVoices() {
    return this._scanVoices().map(v => ({
      id: v.id,
      name: v.name,
      isClone: false,
    }));
  }

  /**
   * "Cloning" for Piper = uploading a custom .onnx model.
   * Not actual voice cloning — just model file upload.
   */
  async cloneVoice(_audioSample, _name) {
    throw Object.assign(
      new Error("Piper doesn't support voice cloning from audio. Upload .onnx + .onnx.json model files instead via Settings > Voice."),
      { status: 400 }
    );
  }
}

/**
 * Save an uploaded Piper voice model (.onnx + .onnx.json pair).
 * @param {Buffer} onnxBuffer - The .onnx model file
 * @param {Buffer} jsonBuffer - The .onnx.json config file
 * @param {string} name - Voice name (used as filename)
 * @returns {{ id: string, name: string }}
 */
export function savePiperVoice(onnxBuffer, jsonBuffer, name) {
  fs.mkdirSync(VOICES_DIR, { recursive: true });

  // Sanitize name for filesystem
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 50);
  const onnxPath = path.join(VOICES_DIR, `${safeName}.onnx`);
  const jsonPath = path.join(VOICES_DIR, `${safeName}.onnx.json`);

  fs.writeFileSync(onnxPath, onnxBuffer);
  fs.writeFileSync(jsonPath, jsonBuffer);

  console.log(`[piper] Saved voice: ${safeName} (${Math.round(onnxBuffer.length / 1024 / 1024)}MB)`);
  return { id: safeName, name };
}

/**
 * Delete a Piper voice model.
 */
export function deletePiperVoice(voiceId) {
  const onnxPath = path.join(VOICES_DIR, `${voiceId}.onnx`);
  const jsonPath = path.join(VOICES_DIR, `${voiceId}.onnx.json`);
  try { fs.unlinkSync(onnxPath); } catch {}
  try { fs.unlinkSync(jsonPath); } catch {}
}

/**
 * List all Piper voices on disk.
 */
export function listPiperVoices() {
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  try {
    const files = fs.readdirSync(VOICES_DIR);
    return files
      .filter(f => f.endsWith(".onnx") && !f.endsWith(".onnx.json"))
      .filter(f => files.includes(f + ".json"))
      .map(f => {
        const id = f.replace(".onnx", "");
        const stat = fs.statSync(path.join(VOICES_DIR, f));
        return { id, sizeMB: Math.round(stat.size / 1024 / 1024), file: f };
      });
  } catch { return []; }
}
