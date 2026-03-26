import { TTSEngine } from "./tts-interface.js";

/**
 * Stub TTS engine — returns 501 for all operations.
 * This is the default until a real TTS engine is configured.
 */
export class StubTTSEngine extends TTSEngine {
  async synthesize(_text, _voiceId) {
    throw Object.assign(
      new Error("TTS engine not configured. Set ELEVENLABS_API_KEY or OPENAI_API_KEY for cloud TTS."),
      { status: 501 }
    );
  }

  async cloneVoice(_audioSample, _name) {
    throw Object.assign(
      new Error("Voice cloning requires a TTS engine that supports it. Configure one in Settings."),
      { status: 501 }
    );
  }

  async listVoices() {
    return [];
  }

  async isAvailable() {
    return false;
  }

  get name() {
    return "stub";
  }
}
