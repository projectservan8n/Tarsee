import { TTSEngine } from "./tts-interface.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import config from "../config/env.js";

const VOICES_DIR = path.join(config.DATA_DIR, "piper-voices");
const BUNDLED_VOICES_DIR = "/opt/piper-voices"; // pre-downloaded in Docker image
const DEFAULT_VOICE = "en_US-lessac-medium";
const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0";

/**
 * Piper TTS engine — fast, lightweight, ONNX-based.
 * Each voice is a pair of files: <name>.onnx + <name>.onnx.json
 * Voices stored in /data/tarsee/data/piper-voices/
 */
export class PiperTTSEngine extends TTSEngine {
  constructor() {
    super();
    fs.mkdirSync(VOICES_DIR, { recursive: true });
  }

  get name() {
    return "piper";
  }

  async isAvailable() {
    try {
      const code = await new Promise((resolve) => {
        const proc = spawn("piper", ["--version"], { stdio: "ignore", timeout: 5000 });
        proc.on("close", resolve);
        proc.on("error", () => resolve(1));
      });
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Synthesize text to speech using Piper.
   */
  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");

    const voiceName = voiceId || DEFAULT_VOICE;
    let modelPath = path.join(VOICES_DIR, `${voiceName}.onnx`);

    // Check bundled voices dir (Docker image) as fallback
    if (!fs.existsSync(modelPath)) {
      const bundledPath = path.join(BUNDLED_VOICES_DIR, `${voiceName}.onnx`);
      if (fs.existsSync(bundledPath)) {
        modelPath = bundledPath;
        console.log(`[piper] using bundled voice model: ${bundledPath}`);
      } else if (voiceName === DEFAULT_VOICE) {
        // Auto-download default voice as last resort
        console.log(`[piper] downloading default voice: ${voiceName}`);
        await this.downloadVoice(voiceName);
      } else {
        throw new Error(`Voice not found: ${voiceName}. Upload .onnx + .onnx.json to piper-voices directory.`);
      }
    }

    const outFile = path.join(os.tmpdir(), `piper-${Date.now()}.wav`);

    return new Promise((resolve, reject) => {
      const proc = spawn("piper", [
        "--model", modelPath,
        "--output_file", outFile,
      ], { stdio: ["pipe", "pipe", "pipe"] });

      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.stdin.write(text);
      proc.stdin.end();

      proc.on("close", (code) => {
        if (code !== 0) {
          try { fs.unlinkSync(outFile); } catch { /* ignore */ }
          return reject(new Error(`Piper exited with code ${code}: ${stderr.slice(-200)}`));
        }

        try {
          const audio = fs.readFileSync(outFile);
          fs.unlinkSync(outFile);
          resolve({ audio, contentType: "audio/wav" });
        } catch (err) {
          reject(new Error(`Failed to read Piper output: ${err.message}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn Piper: ${err.message}`));
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        reject(new Error("Piper TTS timed out (30s)"));
      }, 30_000);
    });
  }

  /**
   * Voice cloning is not supported by Piper.
   * Users add voices by uploading .onnx + .onnx.json files.
   */
  async cloneVoice(_audioSample, _name) {
    throw Object.assign(
      new Error("Piper TTS doesn't support voice cloning from audio samples. Upload .onnx + .onnx.json voice model files instead via Settings > Voice."),
      { status: 400 },
    );
  }

  /**
   * List available Piper voices (ONNX models in the voices directory).
   */
  async listVoices() {
    const voices = [];
    try {
      const files = fs.readdirSync(VOICES_DIR);
      for (const file of files) {
        if (file.endsWith(".onnx") && !file.endsWith(".onnx.json")) {
          const name = file.replace(".onnx", "");
          // Check if config JSON exists
          const hasConfig = fs.existsSync(path.join(VOICES_DIR, `${name}.onnx.json`));
          voices.push({
            id: name,
            name: name.replace(/-/g, " ").replace(/_/g, " "),
            isClone: false,
            hasConfig,
          });
        }
      }
    } catch { /* no directory yet */ }
    return voices;
  }

  /**
   * Download a voice from Hugging Face rhasspy/piper-voices.
   * Voice name format: en_US-lessac-medium
   */
  async downloadVoice(voiceName) {
    // Parse voice name to build HF URL path
    // Format: {lang}_{REGION}-{name}-{quality}
    // URL: /en/en_US/lessac/medium/en_US-lessac-medium.onnx
    const parts = voiceName.match(/^([a-z]{2})_([A-Z]{2})-([a-z0-9_]+)-(\w+)$/);
    if (!parts) {
      throw new Error(`Invalid voice name format: ${voiceName}. Expected: xx_XX-name-quality`);
    }

    const [, lang, region, name, quality] = parts;
    const basePath = `${lang}/${lang}_${region}/${name}/${quality}`;

    const onnxUrl = `${HF_BASE}/${basePath}/${voiceName}.onnx`;
    const jsonUrl = `${HF_BASE}/${basePath}/${voiceName}.onnx.json`;

    console.log(`[piper] downloading ${onnxUrl}`);
    await downloadFile(onnxUrl, path.join(VOICES_DIR, `${voiceName}.onnx`));

    console.log(`[piper] downloading ${jsonUrl}`);
    await downloadFile(jsonUrl, path.join(VOICES_DIR, `${voiceName}.onnx.json`));

    console.log(`[piper] voice ${voiceName} downloaded`);
  }

  /**
   * Add a voice from uploaded .onnx + .onnx.json files.
   */
  addVoiceFromFiles(name, onnxBuffer, jsonBuffer) {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    fs.writeFileSync(path.join(VOICES_DIR, `${safeName}.onnx`), onnxBuffer);
    if (jsonBuffer) {
      fs.writeFileSync(path.join(VOICES_DIR, `${safeName}.onnx.json`), jsonBuffer);
    }
    return { voiceId: safeName, name };
  }
}

/**
 * Download a file from URL to disk.
 */
async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${url} → ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}
