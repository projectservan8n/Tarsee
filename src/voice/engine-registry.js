import { StubTTSEngine } from "./tts-stub.js";

let currentEngine = new StubTTSEngine();

export function getTTSEngine() {
  return currentEngine;
}

export function setTTSEngine(engine) {
  currentEngine = engine;
}

/**
 * Initialize TTS engine based on settings.
 * Priority: user setting > ElevenLabs > Kokoro > Edge TTS > Stub
 */
export async function initTTSEngine(settingsStore) {
  const enginePref = settingsStore?.get("voice.engine") || "auto";
  const defaultVoice = settingsStore?.get("voice.defaultVoiceId");

  // If user explicitly selected an engine, try that first
  if (enginePref !== "auto") {
    const engine = await tryEngine(enginePref, settingsStore, defaultVoice);
    if (engine) {
      currentEngine = engine;
      return;
    }
    console.warn(`[voice] Preferred engine "${enginePref}" unavailable, falling back`);
  }

  // Auto: try ElevenLabs → Edge TTS → Kokoro → Stub
  // Edge TTS before Kokoro because Kokoro needs writable cache dir
  for (const name of ["elevenlabs", "edge-tts", "kokoro"]) {
    const voiceForEngine = (name === enginePref) ? defaultVoice : null;
    const engine = await tryEngine(name, settingsStore, voiceForEngine);
    if (engine) {
      currentEngine = engine;
      return;
    }
  }

  console.warn("[voice] No TTS engine available — voice disabled");
  currentEngine = new StubTTSEngine();
}

/**
 * Try to initialize a specific engine. Returns the engine if available, null otherwise.
 */
async function tryEngine(name, settingsStore, defaultVoice) {
  try {
    switch (name) {
      case "elevenlabs": {
        const apiKey = settingsStore?.getApiKey?.("elevenlabs")
          || settingsStore?.get("voice.elevenlabs.apiKey");
        if (!apiKey) return null;

        const { ElevenLabsTTSEngine } = await import("./elevenlabs-engine.js");
        const el = new ElevenLabsTTSEngine(apiKey, undefined, defaultVoice || "wNl2YBRc8v5uIcq6gOxd");
        if (await el.isAvailable()) {
          console.log(`[voice] ElevenLabs TTS active (voice: ${defaultVoice || "default"})`);
          return el;
        }
        return null;
      }

      case "kokoro": {
        const { KokoroTTSEngine } = await import("./kokoro-engine.js");
        const kokoro = new KokoroTTSEngine(defaultVoice);
        if (await kokoro.isAvailable()) {
          console.log("[voice] Kokoro TTS active (local, free)");
          return kokoro;
        }
        return null;
      }

      case "edge-tts": {
        const { EdgeTTSEngine } = await import("./edge-tts-engine.js");
        const edge = new EdgeTTSEngine(defaultVoice);
        if (await edge.isAvailable()) {
          console.log("[voice] Edge TTS active (Microsoft, free)");
          return edge;
        }
        return null;
      }

      default:
        return null;
    }
  } catch (err) {
    console.warn(`[voice] Engine "${name}" failed:`, err.message);
    return null;
  }
}

export function stopTTSEngine() {
  if (currentEngine && typeof currentEngine.stop === "function") {
    try { currentEngine.stop(); } catch { /* ignore */ }
  }
}
