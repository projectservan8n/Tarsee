import { Router } from "express";
import Busboy from "busboy";
import { getTTSEngine, initTTSEngine } from "../voice/engine-registry.js";
import { cloneVoice, listVoiceProfiles } from "../voice/clone-handler.js";
import { transcribeAudio, getSTTModels, stopSttWorker, warmSTT } from "../voice/stt-handler.js";
import {
  getSttStatus, startSttInstall, startModelDownload, removeSttModel, resetSttRuntime, chosenModel, findSttModel,
} from "../voice/stt-install.js";
import { WHISPER_MODEL_NAMES } from "../voice/whisper-models.js";
import { LIMITS } from "../config/constants.js";
import { savePiperVoice, deletePiperVoice, listPiperVoices } from "../voice/piper-engine.js";

export const voiceRouter = Router();

// ── Speech-to-text: Settings > Voice > Speech-to-text ────────────────────

// Who may install: the owner, as for every Settings route. server.js mounts /api/voice behind requireAuth (the owner's
// sign-in, or the owner's API token, which the dashboard itself sends) and CSRF (for a browser session). The
// installer's routes are also rate-limited, and run one job at a time (stt-install.js).

/** A per-address sliding-window limit on starting installer jobs. */
function makeLimiter({ max, windowMs }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = Date.now();
    const key = req.ip || req.socket?.remoteAddress || "?";
    const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      const retry = Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000));
      res.set("Retry-After", String(retry));
      return res.status(429).json({ error: `Too many tries. Wait ${retry} seconds, then try again.` });
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] >= windowMs) hits.delete(k);
    return next();
  };
}

function sendJobError(res, err) {
  const status = err.status || (err.code === "BUSY" ? 409 : 500);
  return res.status(status).json({ error: err.message, code: err.code || null });
}

/**
 * /api/voice/stt/...: the status, Install faster-whisper, a model's Download and Delete, and warming the worker.
 * limits: how many installer actions an address may start (default 20 per 10 minutes).
 */
export function createSttRouter({ limits = { max: 20, windowMs: 10 * 60_000 } } = {}) {
  const r = Router();
  const limit = makeLimiter(limits);

  /** GET /api/voice/stt[?refresh=1]: everything Settings shows (stt-install.js getSttStatus). */
  r.get("/", async (req, res) => {
    try {
      res.json(await getSttStatus({ refresh: req.query.refresh === "1", settingsStore: req.app.get("settingsStore") }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/voice/stt/install: Install (or Try again) faster-whisper in the background; GET reports progress. */
  r.post("/install", limit, (req, res) => {
    try {
      const job = startSttInstall();
      // The worker picks up the new Python on the next recording.
      job.done.then(() => { stopSttWorker(); resetSttRuntime(); });
      const { done: _done, ...snapshot } = job;
      res.status(202).json({ job: snapshot });
    } catch (err) {
      sendJobError(res, err);
    }
  });

  /** POST /api/voice/stt/models/:name/download: download one model in the background. */
  r.post("/models/:name/download", limit, (req, res) => {
    try {
      const { done: _done, ...snapshot } = startModelDownload(req.params.name);
      res.status(202).json({ job: snapshot });
    } catch (err) {
      sendJobError(res, err);
    }
  });

  /** DELETE /api/voice/stt/models/:name: delete a downloaded model (never the one that comes with the image). */
  r.delete("/models/:name", limit, async (req, res) => {
    try {
      stopSttWorker(); // it may have the model open (Windows won't delete an open file)
      res.json(await removeSttModel(req.params.name));
    } catch (err) {
      sendJobError(res, err);
    }
  });

  /** POST /api/voice/stt/warm: load faster-whisper and the model now (a call opening). { ok, model } or { ok: false, error }. */
  r.post("/warm", async (req, res) => {
    res.json(await warmSTT(req.app.get("settingsStore")));
  });

  return r;
}

voiceRouter.use("/stt", createSttRouter());

/**
 * GET /api/voice/stt-models
 * The STT models: each one's size, whether it is downloaded, and where (GET /api/voice/stt has everything).
 */
voiceRouter.get("/stt-models", (req, res) => {
  const sStore = req.app.get("settingsStore");
  res.json({ models: getSTTModels(sStore), current: chosenModel(sStore) });
});

/**
 * POST /api/voice/stt-model
 * Choose the STT model. One that isn't on disk yet starts downloading ({ downloading: true }), unless another
 * download or install is running (its row in Settings then has a Download button).
 */
voiceRouter.post("/stt-model", (req, res) => {
  const { model } = req.body || {};
  if (!WHISPER_MODEL_NAMES.includes(model)) return res.status(400).json({ error: `Invalid model. Valid: ${WHISPER_MODEL_NAMES.join(", ")}` });
  const sStore = req.app.get("settingsStore");
  sStore.set("voice.stt_model", model);
  let downloading = false;
  if (!findSttModel(model)) {
    try { startModelDownload(model); downloading = true; } catch { /* another job is running: Download is on the model's row */ }
  }
  res.json({ ok: true, model, downloading });
});

/**
 * GET /api/voice/piper-voices
 * List uploaded Piper voice models.
 */
voiceRouter.get("/piper-voices", (req, res) => {
  res.json({ voices: listPiperVoices() });
});

/**
 * POST /api/voice/piper-upload
 * Upload a Piper voice model (.onnx + .onnx.json pair).
 * Multipart form: 'onnx' file + 'json' file + 'name' field.
 */
voiceRouter.post("/piper-upload", async (req, res) => {
  try {
    const { onnxBuffer, jsonBuffer, name } = await new Promise((resolve, reject) => {
      const busboy = Busboy({ headers: req.headers, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB max
      let onnxBuffer = null, jsonBuffer = null, name = "custom-voice";

      busboy.on("file", (fieldname, stream) => {
        const chunks = [];
        stream.on("data", c => chunks.push(c));
        stream.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (fieldname === "onnx") onnxBuffer = buf;
          else if (fieldname === "json") jsonBuffer = buf;
        });
        stream.on("limit", () => reject(Object.assign(new Error("File too large (max 200MB)"), { status: 413 })));
      });

      busboy.on("field", (fieldname, value) => {
        if (fieldname === "name") name = value.trim() || "custom-voice";
      });

      busboy.on("finish", () => {
        if (!onnxBuffer) return reject(Object.assign(new Error("Missing .onnx file (field: 'onnx')"), { status: 400 }));
        if (!jsonBuffer) return reject(Object.assign(new Error("Missing .onnx.json file (field: 'json')"), { status: 400 }));
        resolve({ onnxBuffer, jsonBuffer, name });
      });

      busboy.on("error", reject);
      req.pipe(busboy);
    });

    const result = savePiperVoice(onnxBuffer, jsonBuffer, name);
    res.status(201).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * DELETE /api/voice/piper-voices/:id
 * Delete a Piper voice model.
 */
voiceRouter.delete("/piper-voices/:id", (req, res) => {
  deletePiperVoice(req.params.id);
  res.json({ ok: true });
});

/**
 * GET /api/voice/phonon
 * Phonon's own settings for Settings -> Voice: its voices, the chosen voice and
 * speed, the bare-"P" peso option, and the install status (with progress while
 * downloading).
 */
voiceRouter.get("/phonon", async (req, res) => {
  const ph = await import("../voice/phonon-engine.js");
  const { checkPhononInstall } = await import("../voice/phonon-install.js");
  const sStore = req.app.get("settingsStore");
  const barePeso = sStore?.get("voice.phonon.barePeso");
  res.json({
    install: await checkPhononInstall(),
    active: getTTSEngine().name === "phonon",
    voices: ph.VOICES,
    voice: ph.findVoice(sStore?.get("voice.phonon.voice"))?.id || ph.DEFAULT_VOICE,
    speed: ph.clampSpeed(sStore?.get("voice.phonon.speed") ?? ph.DEFAULT_SPEED),
    speedMin: ph.SPEED_MIN,
    speedMax: ph.SPEED_MAX,
    barePeso: barePeso === true || barePeso === "true",
  });
});

/**
 * POST /api/voice/phonon/install
 * Start (or retry) the Phonon download in the background and return the
 * status at once; GET /api/voice/phonon reports progress. When it finishes,
 * the TTS engine is re-initialised so Phonon takes over from Edge TTS.
 * On a computer with no usable Python, the owner's click (a browser session)
 * also downloads Tarsee's own Python, the one speech-to-text uses too.
 */
voiceRouter.post("/phonon/install", async (req, res) => {
  const { installPhonon, getPhononInstallStatus, checkPhononInstall } = await import("../voice/phonon-install.js");
  const { resetPhononAvailability } = await import("../voice/phonon-engine.js");
  resetPhononAvailability(); // re-check the runtime rather than trust an old answer
  const status = await checkPhononInstall();
  if (status.state === "installed" || status.state === "installing") return res.json(status);
  const sStore = req.app.get("settingsStore");
  installPhonon({ onInstalled: () => initTTSEngine(sStore), allowPythonDownload: true }).catch((err) => {
    console.warn(`[phonon] install failed: ${err.message}`);
  });
  res.status(202).json(getPhononInstallStatus());
});

/**
 * POST /api/voice/warm
 * Start a local engine's worker ahead of the first reply (voice mode opening).
 * A no-op for engines without one.
 */
voiceRouter.post("/warm", async (req, res) => {
  const engine = getTTSEngine();
  if (typeof engine.warm !== "function") return res.json({ ok: true, engine: engine.name, warmed: false });
  try {
    await engine.warm();
    res.json({ ok: true, engine: engine.name, warmed: true });
  } catch (err) {
    res.json({ ok: false, engine: engine.name, error: err.message });
  }
});

/**
 * GET /api/voice/status
 * Check voice engine status.
 */
voiceRouter.get("/status", async (req, res) => {
  const engine = getTTSEngine();
  const available = await engine.isAvailable();
  const voices = await engine.listVoices();
  const sStore = req.app.get("settingsStore");

  res.json({
    tts: { engine: engine.name, available },
    stt: { whisper: !!sStore?.getApiKey?.("openai") ? "key set" : "no key" },
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
        error: "No TTS engine available. Add your ElevenLabs API key in Settings > Voice, or select Edge TTS (free).",
      });
    }

    console.log(`[tts] engine=${engine.name}, voiceId=${voiceId || "default"}, textLen=${text.length}`);
    const { audio, contentType } = await engine.synthesize(text, voiceId);

    res.set("Content-Type", contentType || "audio/wav");
    res.set("Content-Length", String(audio.length));
    res.send(audio);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error(`[tts] error: ${msg}`);
    const status = err.status || 500;
    if (!res.headersSent) res.status(status).json({ error: msg });
  }
});

/**
 * POST /api/voice/tts-stream
 * Streaming TTS — returns audio as it's generated for lower latency.
 */
voiceRouter.post("/tts-stream", async (req, res) => {
  const { text, voiceId } = req.body || {};
  if (!text) return res.status(400).json({ error: "Text is required" });

  try {
    let engine = getTTSEngine();

    // Re-init if engine is stub (key may have been added after startup)
    if (engine.name === "stub") {
      const sStore = req.app.get("settingsStore");
      await initTTSEngine(sStore);
      engine = getTTSEngine();
    }

    if (!engine.synthesizeStream) {
      // Fallback to non-streaming
      const { audio, contentType } = await engine.synthesize(text, voiceId);
      res.set("Content-Type", contentType);
      return res.send(audio);
    }

    const { stream, contentType } = await engine.synthesizeStream(text, voiceId);
    res.set("Content-Type", contentType);
    res.set("Transfer-Encoding", "chunked");
    for await (const chunk of stream) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("[tts-stream] error:", msg);
    if (!res.headersSent) res.status(500).json({ error: msg });
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
 * Transcribe audio with the chosen speech-to-text (multipart form with 'audio' file).
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

    // Speech-to-text as chosen in Settings > Voice: local faster-whisper, or the paid OpenAI Whisper API only when
    // chosen. When nothing can transcribe, the error's status and message say why and what to change.
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

