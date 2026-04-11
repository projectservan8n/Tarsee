/**
 * Speech-to-text — faster-whisper (local, free, no API key needed).
 * Uses CTranslate2 backend — ~4x faster than OpenAI's original whisper.
 * Runs on CPU, supports multiple model sizes.
 *
 * Models (auto-downloaded on first use):
 *   tiny.en   (~75MB)  — fastest, basic accuracy
 *   base.en   (~140MB) — balanced speed + accuracy (default)
 *   small.en  (~460MB) — best accuracy, slower on CPU
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MODELS_DIR = path.join(process.env.TARSEE_DATA_DIR || process.env.TARSEE_STATE_DIR || "/data/tarsee", "whisper-models");

const VALID_MODELS = ["tiny.en", "base.en", "small.en"];
const DEFAULT_MODEL = "base.en";

let _cachedModelName = null;

function getModelName(settingsStore) {
  if (_cachedModelName) return _cachedModelName;
  const pref = settingsStore?.get?.("voice.stt_model");
  _cachedModelName = (pref && VALID_MODELS.includes(pref)) ? pref : DEFAULT_MODEL;
  return _cachedModelName;
}

export function resetSTTModelCache() {
  _cachedModelName = null;
}

/**
 * Check if faster-whisper is available.
 */
function isFasterWhisperAvailable() {
  try {
    execSync("python3 -c \"import faster_whisper\"", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Transcribe audio using faster-whisper (Python).
 */
async function transcribeLocal(audioBuffer, settingsStore) {
  const modelName = getModelName(settingsStore);

  const tmpDir = "/tmp";
  const tmpInput = path.join(tmpDir, `stt-${crypto.randomBytes(4).toString("hex")}.webm`);
  const tmpWav = path.join(tmpDir, `stt-${crypto.randomBytes(4).toString("hex")}.wav`);

  try {
    fs.writeFileSync(tmpInput, audioBuffer);

    // Convert to WAV 16kHz mono
    execFileSync("ffmpeg", ["-i", tmpInput, "-ar", "16000", "-ac", "1", "-f", "wav", tmpWav, "-y"], {
      stdio: "ignore",
      timeout: 10_000,
    });

    // Timeout scales with model: tiny=20s, base=40s, small=90s
    const timeout = modelName === "small.en" ? 90_000 : modelName === "base.en" ? 40_000 : 20_000;

    // Run faster-whisper via Python
    // model_size_or_path downloads automatically to HF cache on first use
    const script = `
import sys, json
from faster_whisper import WhisperModel
model = WhisperModel("${modelName}", device="cpu", compute_type="int8")
segments, info = model.transcribe("${tmpWav}", language="en", beam_size=1, best_of=1, vad_filter=True)
text = " ".join(s.text.strip() for s in segments)
print(json.dumps({"text": text, "language": info.language, "duration": round(info.duration, 1)}))
`;

    const output = execFileSync("python3", ["-c", script], {
      encoding: "utf8",
      timeout,
      env: {
        ...process.env,
        HF_HOME: path.join(MODELS_DIR, "hf_cache"),
        TRANSFORMERS_CACHE: path.join(MODELS_DIR, "hf_cache"),
      },
    });

    const result = JSON.parse(output.trim());
    const text = (result.text || "").trim();

    console.log(`[stt] faster-whisper (${modelName}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" [${result.duration}s audio]`);
    return { transcript: text, language: result.language || "en", provider: `faster-whisper (${modelName})` };
  } finally {
    try { fs.unlinkSync(tmpInput); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

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

  if (!res.ok) throw new Error(`Whisper API error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  console.log(`[stt] Whisper API: "${data.text?.slice(0, 80)}..."`);
  return { transcript: data.text || "", language: language?.split("-")[0] || "en", provider: "whisper-api" };
}

/**
 * Transcribe audio using OpenAI GPT-4o Transcribe.
 * Better accuracy than Whisper, handles accents and noisy audio well.
 * Uses more API credits than whisper-1.
 */
async function transcribeGPT4o(audioBuffer, language, apiKey) {
  const boundary = "----TarseeSTTBoundary" + Date.now();
  const parts = [];

  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`);
  parts.push(audioBuffer);
  parts.push("\r\n");
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-transcribe\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`);
  parts.push(`--${boundary}--\r\n`);

  const body = Buffer.concat(parts.map(p => typeof p === "string" ? Buffer.from(p) : p));

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`GPT-4o Transcribe error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  console.log(`[stt] GPT-4o Transcribe: "${data.text?.slice(0, 80)}..."`);
  return { transcript: data.text || "", language: language?.split("-")[0] || "en", provider: "gpt-4o-transcribe" };
}

/**
 * Transcribe audio — uses configured provider.
 * Priority based on setting voice.stt_provider:
 *   "gpt-4o"         → GPT-4o Transcribe (best accuracy, costs API credits)
 *   "whisper-api"     → OpenAI Whisper API (good, cheaper)
 *   "local" (default) → faster-whisper local (free, no API key)
 */
export async function transcribeAudio(audioBuffer, language, opts = {}) {
  const settingsStore = opts.settingsStore;
  const provider = settingsStore?.get?.("voice.stt_provider") || "local";
  const openaiKey = settingsStore?.getApiKey?.("openai");

  // GPT-4o Transcribe — best accuracy
  if (provider === "gpt-4o" && openaiKey) {
    try {
      return await transcribeGPT4o(audioBuffer, language, openaiKey);
    } catch (err) {
      console.warn("[stt] GPT-4o Transcribe failed, falling back:", err.message);
    }
  }

  // OpenAI Whisper API
  if (provider === "whisper-api" && openaiKey) {
    try {
      return await transcribeWhisperAPI(audioBuffer, language, openaiKey);
    } catch (err) {
      console.warn("[stt] Whisper API failed, falling back:", err.message);
    }
  }

  // Local faster-whisper (free, no API key)
  if (isFasterWhisperAvailable()) {
    try {
      return await transcribeLocal(audioBuffer, settingsStore);
    } catch (err) {
      console.warn("[stt] faster-whisper failed:", err.message);
    }
  }

  // Last resort fallbacks
  if (openaiKey) {
    return await transcribeWhisperAPI(audioBuffer, language, openaiKey);
  }

  throw Object.assign(
    new Error("Speech-to-text unavailable. faster-whisper not installed and no OpenAI API key configured."),
    { status: 501 }
  );
}

/**
 * Get available STT models info (for settings UI).
 */
export function getSTTModels() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  return VALID_MODELS.map(name => {
    // faster-whisper downloads models to HF cache, check if cached
    const cacheDir = path.join(MODELS_DIR, "hf_cache");
    let downloaded = false;
    try {
      // HF cache stores models in a directory pattern
      if (fs.existsSync(cacheDir)) {
        const entries = fs.readdirSync(cacheDir, { recursive: true }).join(" ");
        downloaded = entries.includes(name.replace(".", "-"));
      }
    } catch {}
    const sizeMB = name === "tiny.en" ? 75 : name === "base.en" ? 140 : 460;
    return { name, sizeMB, downloaded };
  });
}
