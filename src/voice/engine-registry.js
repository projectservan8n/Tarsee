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
 * Priority: Piper (local, fast) → ElevenLabs (cloud) → stub
 */
export async function initTTSEngine(settingsStore) {
  const engineType = settingsStore?.get("voice.engine") || "auto";

  if (engineType === "stub" || engineType === "none") {
    currentEngine = new StubTTSEngine();
    return;
  }

  // Try Piper TTS (local, fast, ONNX-based)
  if (engineType === "piper" || engineType === "auto") {
    try {
      const { PiperTTSEngine } = await import("./piper-engine.js");
      const piper = new PiperTTSEngine();
      const available = await piper.isAvailable();
      if (available) {
        currentEngine = piper;
        console.log("[voice] using Piper TTS (ONNX)");
        return;
      } else if (engineType === "piper") {
        console.warn("[voice] Piper TTS binary not found in PATH");
      }
    } catch (err) {
      console.warn("[voice] Piper TTS init failed:", err.message);
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
        }
      }
    } catch (err) {
      console.warn("[voice] ElevenLabs init failed:", err.message);
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
