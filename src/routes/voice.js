import { Router } from "express";
import Busboy from "busboy";
import { getTTSEngine, initTTSEngine } from "../voice/engine-registry.js";
import { cloneVoice, listVoiceProfiles } from "../voice/clone-handler.js";
import { transcribeAudio } from "../voice/stt-handler.js";
import { transcribe as whisperTranscribe, isAvailable as whisperAvailable } from "../voice/whisper-engine.js";
import { LIMITS } from "../config/constants.js";

export const voiceRouter = Router();

/**
 * GET /api/voice/status
 * Check voice engine status.
 */
voiceRouter.get("/status", async (_req, res) => {
  const engine = getTTSEngine();
  const available = await engine.isAvailable();
  const voices = await engine.listVoices();

  // STT diagnostics — check vault + env
  const sStore = req.app.get("settingsStore");
  const hasOpenAI = !!sStore?.getApiKey?.("openai");
  const hasGemini = !!sStore?.getApiKey?.("gemini");
  const whisperLocal = await whisperAvailable().catch(() => false);

  res.json({
    engine: engine.name,
    available,
    voices,
    stt: {
      openai: hasOpenAI ? "key set" : "no key",
      whisperLocal: whisperLocal ? "available" : "not installed",
      gemini: hasGemini ? "key set" : "no key",
    },
  });
});

/**
 * GET /api/voice/voices
 * List available voices (built-in + cloned).
 */
voiceRouter.get("/voices", async (req, res) => {
  const db = req.app.get("db");
  const engine = getTTSEngine();

  const builtInVoices = await engine.listVoices();
  const clonedVoices = listVoiceProfiles(db).map((v) => ({
    id: v.id,
    name: v.name,
    isClone: true,
    engine: v.engine,
  }));

  res.json({ voices: [...builtInVoices, ...clonedVoices] });
});

/**
 * POST /api/voice/tts
 * Text-to-speech. Returns audio stream.
 * Body: { text: string, voiceId?: string }
 */
voiceRouter.post("/tts", async (req, res) => {
  const { text, voiceId } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Text is required" });
  }

  if (text.length > 5000) {
    return res.status(400).json({ error: "Text too long (max 5000 characters)" });
  }

  try {
    let engine = getTTSEngine();

    // If engine is still stub, try to re-init (key may have been added after startup)
    if (engine.name === "stub") {
      console.log("[tts] engine is stub, attempting re-init...");
      const sStore = req.app.get("settingsStore");
      await initTTSEngine(sStore);
      engine = getTTSEngine();
      console.log(`[tts] after re-init: engine=${engine.name}`);
    }

    if (engine.name === "stub") {
      return res.status(501).json({
        error: "No TTS engine available. Check ELEVENLABS_API_KEY is set in Railway env vars.",
        hint: `env check: ELEVENLABS_API_KEY=${process.env.ELEVENLABS_API_KEY ? "set" : "missing"}, ELEVEN_LABS_API_KEY=${process.env.ELEVEN_LABS_API_KEY ? "set" : "missing"}`
      });
    }

    console.log(`[tts] engine=${engine.name}, voiceId=${voiceId || "default"}, textLen=${text.length}`);
    const { audio, contentType } = await engine.synthesize(text, voiceId);

    res.set("Content-Type", contentType || "audio/wav");
    res.set("Content-Length", String(audio.length));
    res.send(audio);
  } catch (err) {
    console.error(`[tts] error: ${err.message}`);
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/voice/stt
 * Speech-to-text (server-side fallback).
 * Expects raw audio in request body.
 */
voiceRouter.post("/stt", async (req, res) => {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > LIMITS.VOICE_SAMPLE_MAX_BYTES) {
      return res.status(413).json({ error: "Audio too large" });
    }
    chunks.push(chunk);
  }

  const audioBuffer = Buffer.concat(chunks);
  const language = req.headers["x-language"] || "en-US";

  try {
    const sStore = req.app.get("settingsStore");
    const result = await transcribeAudio(audioBuffer, language, { settingsStore: sStore });
    res.json({ text: result.transcript, language: result.language, provider: result.provider });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/voice/transcribe
 * Transcribe audio using whisper.cpp (multipart form with 'audio' file).
 * Returns { text, language }.
 */
voiceRouter.post("/transcribe", async (req, res) => {
  const contentType = req.headers["content-type"] || "";

  try {
    let audioBuffer;

    if (contentType.includes("multipart/form-data")) {
      // Parse multipart — reuse busboy inline
      audioBuffer = await new Promise((resolve, reject) => {
        const busboy = Busboy({ headers: req.headers, limits: { fileSize: LIMITS.VOICE_SAMPLE_MAX_BYTES } });
        let buf = null;

        busboy.on("file", (fieldname, stream) => {
          if (fieldname !== "audio") { stream.resume(); return; }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => { buf = Buffer.concat(chunks); });
          stream.on("limit", () => {
            reject(Object.assign(new Error("Audio too large"), { status: 413 }));
          });
        });

        busboy.on("finish", () => {
          if (!buf) return reject(Object.assign(new Error("No audio file provided"), { status: 400 }));
          resolve(buf);
        });

        busboy.on("error", reject);
        req.pipe(busboy);
      });
    } else {
      // Raw body fallback
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > LIMITS.VOICE_SAMPLE_MAX_BYTES) {
          return res.status(413).json({ error: "Audio too large" });
        }
        chunks.push(chunk);
      }
      audioBuffer = Buffer.concat(chunks);
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: "Empty audio" });
    }

    // Use multi-provider STT (OpenAI Whisper API > whisper.cpp > Gemini > error)
    const sStore = req.app.get("settingsStore");
    const result = await transcribeAudio(audioBuffer, req.headers["x-language"] || "en", { settingsStore: sStore });
    res.json({ text: result.transcript, language: result.language, provider: result.provider });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/voice/clone
 * Clone a voice from an audio sample.
 * Accepts multipart form (web UI) or raw binary (API clients).
 */
voiceRouter.post("/clone", async (req, res) => {
  const contentType = req.headers["content-type"] || "";
  const db = req.app.get("db");

  // Multipart form data (from web UI: FormData with 'audio' file + 'name' field)
  if (contentType.includes("multipart/form-data")) {
    try {
      const { audioBuffer, name } = await parseMultipart(req);
      console.log(`[voice] clone request: name="${name}" audioSize=${audioBuffer?.length || 0} bytes`);
      const result = await cloneVoice(audioBuffer, name, db);
      return res.status(201).json(result);
    } catch (err) {
      console.error(`[voice] clone error: ${err.message}`);
      const status = err.status || 500;
      return res.status(status).json({ error: err.message });
    }
  }

  // Raw binary fallback (API clients: Content-Type: application/octet-stream)
  const name = req.headers["x-voice-name"] || req.query.name || "Custom Voice";
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > LIMITS.VOICE_SAMPLE_MAX_BYTES) {
      return res.status(413).json({ error: "Audio sample too large (max 25MB)" });
    }
    chunks.push(chunk);
  }

  const audioBuffer = Buffer.concat(chunks);

  try {
    const result = await cloneVoice(audioBuffer, name, db);
    res.status(201).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * Parse multipart form data with busboy.
 * Returns { audioBuffer, name }.
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: LIMITS.VOICE_SAMPLE_MAX_BYTES } });
    let audioBuffer = null;
    let name = "Custom Voice";

    busboy.on("file", (fieldname, stream) => {
      if (fieldname !== "audio") { stream.resume(); return; }
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => { audioBuffer = Buffer.concat(chunks); });
      stream.on("limit", () => {
        reject(Object.assign(new Error("Audio sample too large (max 25MB)"), { status: 413 }));
      });
    });

    busboy.on("field", (fieldname, value) => {
      if (fieldname === "name") name = value.trim() || "Custom Voice";
    });

    busboy.on("finish", () => {
      if (!audioBuffer) return reject(Object.assign(new Error("No audio file provided"), { status: 400 }));
      resolve({ audioBuffer, name });
    });

    busboy.on("error", reject);
    req.pipe(busboy);
  });
}

