/**
 * Kokoro TTS engine — open source, runs locally on CPU.
 * 82M parameter model, ~200MB RAM, near real-time synthesis.
 * No API key needed. Free.
 */

import { TTSEngine } from "./tts-interface.js";

let kokoroInstance = null;

export class KokoroTTSEngine extends TTSEngine {
  constructor(voice) {
    super();
    this.defaultVoice = voice || "af_heart";
  }

  get name() { return "kokoro"; }

  async isAvailable() {
    try {
      await this._getInstance();
      return true;
    } catch {
      return false;
    }
  }

  async _getInstance() {
    if (kokoroInstance) return kokoroInstance;
    // Set cache dir to writable location (Railway runs as node user, /app is read-only)
    const cacheDir = process.env.TARSEE_DATA_DIR || process.env.HOME || "/tmp";
    process.env.TRANSFORMERS_CACHE = `${cacheDir}/.cache/huggingface`;
    process.env.HF_HOME = `${cacheDir}/.cache/huggingface`;

    const { KokoroTTS } = await import("kokoro-js");
    console.log("[kokoro] Loading model (first time takes ~30s)...");
    kokoroInstance = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device: "cpu",
    });
    console.log("[kokoro] Model loaded");
    return kokoroInstance;
  }

  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");
    const tts = await this._getInstance();
    const voice = voiceId || this.defaultVoice;
    const audio = await tts.generate(text, { voice });

    // Convert to WAV buffer
    const wavBuffer = audio.toWav();
    return { audio: Buffer.from(wavBuffer), contentType: "audio/wav" };
  }

  async listVoices() {
    try {
      const tts = await this._getInstance();
      const voices = tts.list_voices();
      return voices.map(v => ({ id: v, name: v, isClone: false }));
    } catch {
      return [
        { id: "af_heart", name: "Heart (Female)", isClone: false },
        { id: "af_alloy", name: "Alloy (Female)", isClone: false },
        { id: "am_adam", name: "Adam (Male)", isClone: false },
        { id: "am_michael", name: "Michael (Male)", isClone: false },
        { id: "bf_emma", name: "Emma (British Female)", isClone: false },
        { id: "bm_george", name: "George (British Male)", isClone: false },
      ];
    }
  }
}
