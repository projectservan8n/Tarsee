import { TTSEngine } from "./tts-interface.js";

/**
 * OpenAI TTS engine — cloud-based, works anywhere with an API key.
 * Uses the /v1/audio/speech endpoint.
 *
 * Voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer
 * Models: tts-1 (fast), tts-1-hd (quality)
 */
export class OpenAITTSEngine extends TTSEngine {
  constructor(apiKey, opts = {}) {
    super();
    this.apiKey = apiKey;
    this.model = opts.model || "tts-1";
    this.defaultVoice = opts.voice || "onyx";
  }

  get name() {
    return "openai-tts";
  }

  async isAvailable() {
    return !!this.apiKey;
  }

  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");

    const voice = voiceId || this.defaultVoice;

    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI TTS error: ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: "audio/mpeg",
    };
  }

  async cloneVoice(_audioSample, _name) {
    throw Object.assign(
      new Error("OpenAI TTS does not support voice cloning. Use ElevenLabs for cloned voices."),
      { status: 400 }
    );
  }

  async listVoices() {
    return [
      { id: "alloy", name: "Alloy", isClone: false },
      { id: "ash", name: "Ash", isClone: false },
      { id: "ballad", name: "Ballad", isClone: false },
      { id: "coral", name: "Coral", isClone: false },
      { id: "echo", name: "Echo", isClone: false },
      { id: "fable", name: "Fable", isClone: false },
      { id: "nova", name: "Nova", isClone: false },
      { id: "onyx", name: "Onyx", isClone: false },
      { id: "sage", name: "Sage", isClone: false },
      { id: "shimmer", name: "Shimmer", isClone: false },
    ];
  }
}
