import { Router } from "express";
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
 * Expects multipart form with 'audio' file and 'name' field.
 */
voiceRouter.post("/clone", async (req, res) => {
  // Simple body buffer read for audio (Content-Type: application/octet-stream or multipart)
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
  const db = req.app.get("db");

  try {
    const result = await cloneVoice(audioBuffer, name, db);
    res.status(201).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});
