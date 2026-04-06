import { StubTTSEngine } from "./tts-stub.js";

let currentEngine = new StubTTSEngine();

export function getTTSEngine() {
  return currentEngine;
}

export function setTTSEngine(engine) {
  currentEngine = engine;
}

/**
 * Initializes TTS — ElevenLabs only.
 */
export async function initTTSEngine(settingsStore) {
  try {
    const apiKey = settingsStore?.getApiKey?.("elevenlabs")
      || settingsStore?.get("voice.elevenlabs.apiKey")
      || process.env.ELEVEN_LABS_API_KEY
      || process.env.XI_API_KEY;

    if (!apiKey) {
      console.warn("[voice] No ElevenLabs API key found — TTS disabled");
      currentEngine = new StubTTSEngine();
      return;
    }

    const { ElevenLabsTTSEngine } = await import("./elevenlabs-engine.js");
    const defaultVoice = settingsStore?.get("voice.defaultVoiceId") || "wNl2YBRc8v5uIcq6gOxd";
    const el = new ElevenLabsTTSEngine(apiKey, undefined, defaultVoice);
    const available = await el.isAvailable();

    if (available) {
      currentEngine = el;
      console.log(`[voice] ElevenLabs TTS active (voice: ${defaultVoice})`);
    } else {
      console.warn("[voice] ElevenLabs API key invalid or unreachable");
      currentEngine = new StubTTSEngine();
    }
  } catch (err) {
    console.error("[voice] ElevenLabs init failed:", err.message);
    currentEngine = new StubTTSEngine();
  }
}

export function stopTTSEngine() {
  if (currentEngine && typeof currentEngine.stop === "function") {
    try { currentEngine.stop(); } catch { /* ignore */ }
  }
}
