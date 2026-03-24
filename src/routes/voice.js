import { Router } from "express";
import Busboy from "busboy";
import { getTTSEngine } from "../voice/engine-registry.js";
import { cloneVoice, listVoiceProfiles } from "../voice/clone-handler.js";
import { transcribeAudio } from "../voice/stt-handler.js";
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

  res.json({
    engine: engine.name,
    available,
    voices,
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
    const engine = getTTSEngine();
    const { audio, contentType } = await engine.synthesize(text, voiceId);

    res.set("Content-Type", contentType || "audio/wav");
    res.set("Content-Length", String(audio.length));
    res.send(audio);
  } catch (err) {
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
    const result = await transcribeAudio(audioBuffer, language);
    res.json(result);
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

/**
 * POST /api/voice/upload-model
 * Upload a Piper ONNX voice model (.onnx + optional .onnx.json).
 * Multipart form: 'onnx' file (required), 'config' file (optional .onnx.json), 'name' field.
 */
voiceRouter.post("/upload-model", async (req, res) => {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return res.status(400).json({ error: "Multipart form data required" });
  }

  try {
    const { onnxBuffer, jsonBuffer, name } = await parseModelUpload(req);
    const engine = getTTSEngine();

    if (typeof engine.addVoiceFromFiles !== "function") {
      return res.status(400).json({ error: "Current TTS engine doesn't support model uploads. Switch to Piper." });
    }

    const result = engine.addVoiceFromFiles(name, onnxBuffer, jsonBuffer);
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/voice/download-model
 * Download a Piper voice from Hugging Face by name.
 * Body: { name: "en_US-lessac-medium" }
 */
voiceRouter.post("/download-model", async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Voice name required" });

  const engine = getTTSEngine();
  if (typeof engine.downloadVoice !== "function") {
    return res.status(400).json({ error: "Current TTS engine doesn't support voice downloads." });
  }

  try {
    await engine.downloadVoice(name);
    res.json({ ok: true, voiceId: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseModelUpload(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max
    let onnxBuffer = null;
    let jsonBuffer = null;
    let name = "custom-voice";

    busboy.on("file", (fieldname, stream) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (fieldname === "onnx") onnxBuffer = buf;
        else if (fieldname === "config") jsonBuffer = buf;
      });
    });

    busboy.on("field", (fieldname, value) => {
      if (fieldname === "name") name = value.trim() || "custom-voice";
    });

    busboy.on("finish", () => {
      if (!onnxBuffer) return reject(Object.assign(new Error("No .onnx file provided"), { status: 400 }));
      resolve({ onnxBuffer, jsonBuffer, name });
    });

    busboy.on("error", reject);
    req.pipe(busboy);
  });
}
