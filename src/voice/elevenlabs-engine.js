import { TTSEngine } from "./tts-interface.js";

const BASE_URL = "https://api.elevenlabs.io/v1";

/**
 * ElevenLabs TTS engine — cloud-based, works on Railway.
 *
 * Supports:
 * - Text-to-speech with any voice
 * - Instant voice cloning from audio samples
 * - Voice listing (library + cloned)
 *
 * Requires: ELEVENLABS_API_KEY in env or voice.elevenlabs.apiKey in settings
 */
export class ElevenLabsTTSEngine extends TTSEngine {
  constructor(apiKey, modelId, defaultVoice) {
    super();
    this.apiKey = apiKey;
    this.modelId = modelId || "eleven_flash_v2_5";
    this.defaultVoice = defaultVoice || "wNl2YBRc8v5uIcq6gOxd"; // Kuya Kaf
  }

  get name() {
    return "elevenlabs";
  }

  async isAvailable() {
    if (!this.apiKey) return false;
    try {
      const res = await fetch(`${BASE_URL}/user`, {
        headers: { "xi-api-key": this.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      console.log(`[elevenlabs] isAvailable check: ${res.ok ? "OK" : res.status}`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Synthesize text to speech.
   */
  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");

    // Default to Rachel voice if no ID specified
    const vid = voiceId || this.defaultVoice || "21m00Tcm4TlvDq8ikWAM";

    const res = await fetch(`${BASE_URL}/text-to-speech/${vid}`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: this.modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS error (${res.status}): ${errBody.slice(0, 200)}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: "audio/mpeg",
    };
  }

  /**
   * Clone a voice using ElevenLabs instant voice cloning.
   */
  async cloneVoice(audioSample, voiceName) {
    if (!audioSample || audioSample.length === 0) {
      throw Object.assign(new Error("Audio sample is required"), { status: 400 });
    }
    if (!voiceName) {
      throw Object.assign(new Error("Voice name is required"), { status: 400 });
    }

    // ElevenLabs expects multipart form data
    const formData = new FormData();
    formData.append("name", voiceName);
    formData.append("description", `Cloned voice: ${voiceName} (via Tarsee)`);
    formData.append("files", new Blob([audioSample], { type: "audio/wav" }), "sample.wav");

    const res = await fetch(`${BASE_URL}/voices/add`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
      },
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(
        new Error(err.detail?.message || `Voice cloning failed: ${res.status}`),
        { status: res.status >= 400 && res.status < 500 ? res.status : 500 },
      );
    }

    const data = await res.json();
    console.log(`[elevenlabs] voice cloned: ${voiceName} (${data.voice_id})`);
    return { voiceId: data.voice_id, name: voiceName };
  }

  /**
   * List all available voices (library + cloned).
   */
  async listVoices() {
    const res = await fetch(`${BASE_URL}/voices`, {
      headers: { "xi-api-key": this.apiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    return (data.voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      isClone: v.category === "cloned" || v.category === "professional",
      preview: v.preview_url || null,
    }));
  }
}
