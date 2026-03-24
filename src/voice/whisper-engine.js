/**
 * whisper.cpp STT engine.
 *
 * Spawns the whisper-cli binary to transcribe audio locally.
 * Converts input audio to 16 kHz mono WAV via ffmpeg first.
 * Auto-downloads the ggml model from HuggingFace on first use.
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import config from "../config/env.js";

const MODELS_DIR = path.join(config.DATA_DIR, "whisper-models");
const DEFAULT_MODEL = "ggml-base.en.bin";
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/**
 * Check whether the whisper-cli binary is available on PATH.
 */
export async function isAvailable() {
  try {
    execFileSync("whisper-cli", ["--help"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Transcribe an audio buffer using whisper.cpp.
 *
 * @param {Buffer} audioBuffer - Raw audio bytes (any format ffmpeg understands)
 * @param {object} [opts]
 * @param {string} [opts.model] - Model filename (default: ggml-base.en.bin)
 * @returns {Promise<{ text: string, language: string }>}
 */
export async function transcribe(audioBuffer, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const modelPath = path.join(MODELS_DIR, model);

  // Auto-download model if not present
  if (!fs.existsSync(modelPath)) {
    await downloadModel(model);
  }

  // Write audio to temp file
  const tmpIn = path.join(os.tmpdir(), `whisper-in-${Date.now()}.audio`);
  const tmpWav = path.join(os.tmpdir(), `whisper-${Date.now()}.wav`);
  fs.writeFileSync(tmpIn, audioBuffer);

  try {
    // Convert to 16 kHz mono WAV with ffmpeg
    execFileSync(
      "ffmpeg",
      ["-i", tmpIn, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpWav, "-y"],
      { timeout: 30_000, stdio: "ignore" },
    );
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
  }

  // Run whisper-cli
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn("whisper-cli", [
      "-m", modelPath,
      "-f", tmpWav,
      "--no-timestamps",
      "-t", String(Math.min(os.cpus().length, 4)),
    ]);

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("close", (code) => {
      try { fs.unlinkSync(tmpWav); } catch { /* ignore */ }
      if (code !== 0) {
        return reject(new Error(`Whisper exited with code ${code}: ${stderr.slice(-200)}`));
      }
      resolve({ text: stdout.trim(), language: "en" });
    });

    proc.on("error", (err) => {
      try { fs.unlinkSync(tmpWav); } catch { /* ignore */ }
      reject(err);
    });

    // Hard timeout — kill after 60 s
    setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
    }, 60_000);
  });
}

/**
 * Download a whisper.cpp GGML model from HuggingFace.
 *
 * @param {string} modelName - e.g. "ggml-base.en.bin"
 */
export async function downloadModel(modelName) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const url = `${HF_BASE}/${modelName}`;
  const dest = path.join(MODELS_DIR, modelName);

  console.log(`[whisper] downloading model: ${url}`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(300_000),
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Model download failed (${res.status}): ${url}`);
  }

  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`[whisper] model saved: ${dest}`);
}
