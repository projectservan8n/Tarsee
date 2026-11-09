/**
 * Speech-to-text — faster-whisper (local, free, no API key needed).
 * Uses CTranslate2 backend — ~4x faster than OpenAI's original whisper.
 * Runs on CPU, supports multiple model sizes.
 * The paid OpenAI Whisper API is used only when the owner chooses it (voice.stt_provider = "whisper-api").
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

// `.en` models are ENGLISH-ONLY: they cannot transcribe Tagalog/Taglish or any
// other language no matter what `language` is passed. The bare variants are
// multilingual and auto-detect. Both are offered so English-only deployments
// keep the smaller/faster model while multilingual ones can opt in.
const VALID_MODELS = ["tiny.en", "base.en", "small.en", "tiny", "base", "small"];
const DEFAULT_MODEL = "base.en";

/** True for the English-only checkpoints. */
const isEnglishOnly = (m) => m.endsWith(".en");

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
    const size = modelName.replace(/\.en$/, "");
    const timeout = size === "small" ? 90_000 : size === "base" ? 40_000 : 20_000;

    // Run faster-whisper via Python
    // model_size_or_path downloads automatically to HF cache on first use
    const script = `
import sys, json
from faster_whisper import WhisperModel
model = WhisperModel("${modelName}", device="cpu", compute_type="int8")
segments, info = model.transcribe("${tmpWav}", ${isEnglishOnly(modelName) ? 'language="en", ' : ""}beam_size=1, best_of=1, vad_filter=True)
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
    return { transcript: text, language: result.language || (isEnglishOnly(modelName) ? "en" : "auto"), provider: `faster-whisper (${modelName})` };
  } finally {
    try { fs.unlinkSync(tmpInput); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

/** Local transcription (faster-whisper): whether it is installed, and the transcriber. Swapped only by tests. */
const LOCAL = { available: isFasterWhisperAvailable, transcribe: transcribeLocal };
let _local = LOCAL;

/** Tests only: replace the local transcriber's `available` and/or `transcribe`; no `local` restores the real one. */
export function __setForTests({ local } = {}) {
  _local = local ? { ...LOCAL, ...local } : LOCAL;
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

  if (!res.ok) throw Object.assign(new Error(`Whisper API error (${res.status}): ${await res.text()}`), { apiStatus: res.status });
  const data = await res.json();
  console.log(`[stt] Whisper API: "${data.text?.slice(0, 80)}..."`);
  return { transcript: data.text || "", language: language?.split("-")[0] || "en", provider: "whisper-api" };
}

/** Where the owner turns the paid API on. */
const CHOOSE_PAID = 'The paid OpenAI Whisper API is off; to use it instead, choose "OpenAI Whisper API" in Settings > Voice > Speech-to-Text.';

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
  if (provider === "whisper-api") {
    const openaiKey = settingsStore?.getApiKey?.("openai");
    if (!openaiKey) {
      paidProblem = "Speech-to-text is set to the OpenAI Whisper API, but no OpenAI API key is saved";
      fix = "Add the key in Settings > Voice > Speech-to-Text.";
    } else {
      try {
        return await transcribeWhisperAPI(audioBuffer, language, openaiKey);
      } catch (err) {
        console.warn("[stt] Whisper API failed, trying local:", err.message);
        paidProblem = `The OpenAI Whisper API failed${err.apiStatus ? ` (HTTP ${err.apiStatus})` : ""}`;
        fix = "The server log has the details.";
      }
    }
  }

  // Local faster-whisper (free, no API key)
  if (!_local.available()) {
    const local = "local transcription (faster-whisper) is not installed on this server";
    throw sttError(paidProblem ? `${paidProblem}, and ${local}. ${fix}` : `Speech-to-text is unavailable: ${local}. ${fix}`, 501, "stt-unavailable");
  }
  try {
    return await _local.transcribe(audioBuffer, settingsStore);
  } catch (err) {
    console.warn("[stt] faster-whisper failed:", err.message);
    const local = "local transcription (faster-whisper) could not transcribe this audio";
    throw sttError(paidProblem ? `${paidProblem}, and ${local}. ${fix}` : `Speech-to-text failed: ${local} (the server log has the details). ${fix}`, 500, "stt-failed");
  }
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
    const base = name.replace(/\.en$/, "");
    const sizeMB = base === "tiny" ? 75 : base === "base" ? 140 : 460;
    return { name, sizeMB, downloaded, multilingual: !isEnglishOnly(name) };
  });
}
