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
  // Default to stub (no TTS) to avoid loading ~8GB Coqui model into RAM.
  // Set voice.engine = "coqui" in settings to enable TTS when needed.
  const engineType = settingsStore?.get("voice.engine") || "stub";

  if (engineType === "stub" || engineType === "none") {
    currentEngine = new StubTTSEngine();
    return;
  }

  // Try Coqui TTS (auto-detect or explicit)
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
