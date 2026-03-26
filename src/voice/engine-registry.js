import { StubTTSEngine } from "./tts-stub.js";

let currentEngine = new StubTTSEngine();

/**
 * Gets the current TTS engine instance.
 */
export function getTTSEngine() {
  return currentEngine;
}

/**
 * Sets the TTS engine.
 */
export function setTTSEngine(engine) {
  currentEngine = engine;
}

/**
 * Initializes the TTS engine based on settings.
 * Priority: ElevenLabs (cloud) → OpenAI TTS (cloud) → stub
 */
export async function initTTSEngine(settingsStore) {
  const engineType = settingsStore?.get("voice.engine") || "auto";

  if (engineType === "stub" || engineType === "none") {
    currentEngine = new StubTTSEngine();
    return;
  }

  // Try ElevenLabs (cloud, supports cloning)
  if (engineType === "elevenlabs" || engineType === "auto") {
    try {
      const apiKey = settingsStore?.getApiKey?.("elevenlabs")
        || settingsStore?.get("voice.elevenlabs.apiKey");
      if (apiKey) {
        const { ElevenLabsTTSEngine } = await import("./elevenlabs-engine.js");
        const modelId = settingsStore?.get("voice.elevenlabs.model") || undefined;
        const defaultVoice = settingsStore?.get("voice.defaultVoiceId") || "iWyfYyRejPZ24HwI8ySp";
        const el = new ElevenLabsTTSEngine(apiKey, modelId, defaultVoice);
        const available = await el.isAvailable();
        if (available) {
          currentEngine = el;
          console.log(`[voice] using ElevenLabs TTS (default voice: ${defaultVoice})`);
          return;
        }
      }
    } catch (err) {
      console.warn("[voice] ElevenLabs init failed:", err.message);
    }
  }

  // Try OpenAI TTS (cloud fallback)
  if (engineType === "openai-tts" || engineType === "auto") {
    try {
      const apiKey = settingsStore?.getApiKey?.("openai");
      if (apiKey) {
        const { OpenAITTSEngine } = await import("./openai-tts-engine.js");
        const voice = settingsStore?.get("voice.openai.voice") || "onyx";
        const engine = new OpenAITTSEngine(apiKey, { voice });
        currentEngine = engine;
        console.log(`[voice] using OpenAI TTS (voice: ${voice})`);
        return;
      }
    } catch (err) {
      console.warn("[voice] OpenAI TTS init failed:", err.message);
    }
  }

  // Fallback to stub
  if (engineType === "auto") {
    console.log("[voice] no TTS engine available, using stub");
  }
  currentEngine = new StubTTSEngine();
}

/**
 * Stops the current TTS engine (cleanup on shutdown).
 */
export function stopTTSEngine() {
  if (currentEngine && typeof currentEngine.stop === "function") {
    try { currentEngine.stop(); } catch { /* ignore */ }
  }
}
