/**
 * Speech-to-text — whisper.cpp (local) or OpenAI Whisper API (fallback).
 * whisper.cpp runs on CPU, no API key needed. Uses tiny.en model (~75MB).
 * English-only model — all parameters dedicated to English = better accuracy per MB.
 */

import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MODELS_DIR = path.join(process.env.TARSEE_DATA_DIR || process.env.TARSEE_STATE_DIR || "/data/tarsee", "whisper-models");
const MODEL_FILE = "ggml-tiny.en.bin";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";

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
async function ensureModel() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const modelPath = path.join(MODELS_DIR, MODEL_FILE);
  if (fs.existsSync(modelPath)) return modelPath;

  console.log("[stt] Downloading whisper tiny.en model (~75MB)...");
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(modelPath, buffer);
  console.log(`[stt] Model downloaded: ${modelPath} (${Math.round(buffer.length / 1024 / 1024)}MB)`);
  return modelPath;
}

/**
 * Transcribe audio using local whisper.cpp.
 */
async function transcribeLocal(audioBuffer) {
  const modelPath = await ensureModel();

  // Write audio to temp file (whisper-cli needs a file)
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

    // Run whisper-cli
    // 2 threads — Railway plan is 0.5 vCPU, no point spawning more
    // Greedy decode (beam=1) — faster, good enough for voice commands
    const output = execFileSync("whisper-cli", [
      "-m", modelPath,
      "-f", tmpWav,
      "--no-timestamps",
      "--language", "en",
      "--threads", "2",
      "--beam-size", "1",
      "--best-of", "1",
    ], { encoding: "utf8", timeout: 30_000 });

    // Parse output — whisper-cli prints text lines
    const text = output
      .split("\n")
      .filter(line => !line.startsWith("[") && line.trim())
      .join(" ")
      .trim();

    console.log(`[stt] Whisper local: "${text.slice(0, 80)}..."`);
    return { transcript: text, language: "en", provider: "whisper-cpp" };
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
  // Try local whisper.cpp first (free, no API key)
  if (isWhisperAvailable()) {
    try {
      return await transcribeLocal(audioBuffer);
    } catch (err) {
      console.warn("[stt] Local whisper failed, trying API:", err.message);
    }
  }

  // Fallback to OpenAI API
  const store = opts.settingsStore;
  const openaiKey = store?.getApiKey?.("openai");
  if (openaiKey) {
    return await transcribeAPI(audioBuffer, language, openaiKey);
  }

  throw Object.assign(
    new Error("Speech-to-text unavailable. whisper-cli not found and no OpenAI API key configured."),
    { status: 501 }
  );
}
