/**
 * Speech-to-text — whisper.cpp (local, free, no API key needed).
 * Supports multiple model sizes — configurable in Settings > Voice.
 * English-only models for best accuracy per MB.
 *
 * Models:
 *   tiny.en   (~75MB)  — fastest, good for short commands
 *   base.en   (~140MB) — best balance of speed + accuracy (default)
 *   small.en  (~460MB) — near-perfect, slower on 0.5 vCPU
 */

import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MODELS_DIR = path.join(process.env.TARSEE_DATA_DIR || process.env.TARSEE_STATE_DIR || "/data/tarsee", "whisper-models");

const MODELS = {
  "tiny.en":  { file: "ggml-tiny.en.bin",  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",  sizeMB: 75 },
  "base.en":  { file: "ggml-base.en.bin",  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",  sizeMB: 140 },
  "small.en": { file: "ggml-small.en.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin", sizeMB: 460 },
};

const DEFAULT_MODEL = "base.en";

// Cache the current model preference
let _cachedModelName = null;

function getModelName(settingsStore) {
  if (_cachedModelName) return _cachedModelName;
  const pref = settingsStore?.get?.("voice.stt_model");
  _cachedModelName = (pref && MODELS[pref]) ? pref : DEFAULT_MODEL;
  return _cachedModelName;
}

// Reset cache when settings change
export function resetSTTModelCache() {
  _cachedModelName = null;
}

/**
 * Check if whisper-cli is available.
 */
function isWhisperAvailable() {
  try {
    execSync("which whisper-cli", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Download the model if not present.
 */
async function ensureModel(modelName) {
  const model = MODELS[modelName] || MODELS[DEFAULT_MODEL];
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const modelPath = path.join(MODELS_DIR, model.file);
  if (fs.existsSync(modelPath)) return modelPath;

  console.log(`[stt] Downloading whisper ${modelName} model (~${model.sizeMB}MB)...`);
  const res = await fetch(model.url);
  if (!res.ok) throw new Error(`Model download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(modelPath, buffer);
  console.log(`[stt] Model downloaded: ${modelPath} (${Math.round(buffer.length / 1024 / 1024)}MB)`);
  return modelPath;
}

/**
 * Transcribe audio using local whisper.cpp.
 */
async function transcribeLocal(audioBuffer, settingsStore) {
  const modelName = getModelName(settingsStore);
  const modelPath = await ensureModel(modelName);

  const tmpDir = "/tmp";
  const tmpInput = path.join(tmpDir, `stt-${crypto.randomBytes(4).toString("hex")}.webm`);
  const tmpWav = path.join(tmpDir, `stt-${crypto.randomBytes(4).toString("hex")}.wav`);

  try {
    fs.writeFileSync(tmpInput, audioBuffer);

    // Convert to WAV (whisper-cli needs 16kHz mono WAV)
    execFileSync("ffmpeg", ["-i", tmpInput, "-ar", "16000", "-ac", "1", "-f", "wav", tmpWav, "-y"], {
      stdio: "ignore",
      timeout: 10_000,
    });

    // Tune threads based on model size
    // Railway is 0.5-2 vCPU depending on plan
    const threads = modelName === "small.en" ? "4" : "2";

    // Timeout scales with model: tiny=15s, base=30s, small=60s
    const timeout = modelName === "small.en" ? 60_000 : modelName === "base.en" ? 30_000 : 15_000;

    const output = execFileSync("whisper-cli", [
      "-m", modelPath,
      "-f", tmpWav,
      "--no-timestamps",
      "--language", "en",
      "--threads", threads,
      "--beam-size", "1",
      "--best-of", "1",
    ], { encoding: "utf8", timeout });

    // Parse output — whisper-cli prints text lines
    const text = output
      .split("\n")
      .filter(line => !line.startsWith("[") && line.trim())
      .join(" ")
      .trim();

    console.log(`[stt] Whisper ${modelName}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
    return { transcript: text, language: "en", provider: `whisper-cpp (${modelName})` };
  } finally {
    try { fs.unlinkSync(tmpInput); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

/**
 * Transcribe audio using OpenAI Whisper API (fallback).
 */
async function transcribeAPI(audioBuffer, language, apiKey) {
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

  if (!res.ok) throw new Error(`Whisper API error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  console.log(`[stt] Whisper API: "${data.text?.slice(0, 80)}..."`);
  return { transcript: data.text || "", language: language?.split("-")[0] || "en", provider: "whisper-api" };
}

/**
 * Transcribe audio — tries local whisper.cpp first, falls back to API.
 */
export async function transcribeAudio(audioBuffer, language, opts = {}) {
  const settingsStore = opts.settingsStore;

  // Try local whisper.cpp first (free, no API key)
  if (isWhisperAvailable()) {
    try {
      return await transcribeLocal(audioBuffer, settingsStore);
    } catch (err) {
      console.warn("[stt] Local whisper failed, trying API:", err.message);
    }
  }

  // Fallback to OpenAI API
  const openaiKey = settingsStore?.getApiKey?.("openai");
  if (openaiKey) {
    return await transcribeAPI(audioBuffer, language, openaiKey);
  }

  throw Object.assign(
    new Error("Speech-to-text unavailable. whisper-cli not found and no OpenAI API key configured."),
    { status: 501 }
  );
}

/**
 * Get available STT models info (for settings UI).
 */
export function getSTTModels() {
  return Object.entries(MODELS).map(([name, info]) => ({
    name,
    sizeMB: info.sizeMB,
    downloaded: fs.existsSync(path.join(MODELS_DIR, info.file)),
  }));
}
