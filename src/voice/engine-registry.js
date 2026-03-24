import { StubTTSEngine } from "./tts-stub.js";

let currentEngine = new StubTTSEngine();

/**
 * Gets the current TTS engine instance.
 * @returns {import('./tts-interface.js').TTSEngine}
 */
export function getTTSEngine() {
  return currentEngine;
}

/**
 * Sets the TTS engine.
 * @param {import('./tts-interface.js').TTSEngine} engine
 */
export function setTTSEngine(engine) {
  currentEngine = engine;
}

/**
 * Initializes the TTS engine based on settings.
 * Called on server startup.
 */
export async function initTTSEngine(settingsStore) {
  // Default to auto — try Coqui (local/free) first, then ElevenLabs (cloud).
  // Falls back to stub if nothing is available.
  const engineType = settingsStore?.get("voice.engine") || "auto";

  if (engineType === "stub" || engineType === "none") {
    currentEngine = new StubTTSEngine();
    return;
  }

  // Try Coqui TTS first (local, free, voice cloning)
  if (engineType === "coqui" || engineType === "auto") {
    try {
      const { CoquiTTSEngine } = await import("./coqui-engine.js");
      const coqui = new CoquiTTSEngine();
      const available = await coqui.isAvailable();

      if (available) {
        currentEngine = coqui;
        console.log("[voice] using Coqui TTS (XTTS v2)");
        return;
      } else if (engineType === "coqui") {
        console.warn("[voice] Coqui TTS requested but not available (python3 or TTS package not found)");
      }
    } catch (err) {
      if (engineType === "coqui") {
        console.warn("[voice] Coqui TTS init failed:", err.message);
      }
    }
  }

  // Try ElevenLabs (cloud fallback)
  if (engineType === "elevenlabs" || engineType === "auto") {
    try {
      const apiKey =
        settingsStore?.get("voice.elevenlabs.apiKey") ||
        process.env.ELEVENLABS_API_KEY;
      if (apiKey) {
        const { ElevenLabsTTSEngine } = await import("./elevenlabs-engine.js");
        const modelId = settingsStore?.get("voice.elevenlabs.model") || undefined;
        const el = new ElevenLabsTTSEngine(apiKey, modelId);
        const available = await el.isAvailable();
        if (available) {
          currentEngine = el;
          console.log("[voice] using ElevenLabs TTS");
          return;
        } else if (engineType === "elevenlabs") {
          console.warn("[voice] ElevenLabs API key invalid or unreachable");
        }
      } else if (engineType === "elevenlabs") {
        console.warn("[voice] ElevenLabs requested but no API key (set ELEVENLABS_API_KEY or voice.elevenlabs.apiKey)");
      }
    } catch (err) {
      console.warn("[voice] ElevenLabs init failed:", err.message);
    }
  }

  // (Coqui already tried above)

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
