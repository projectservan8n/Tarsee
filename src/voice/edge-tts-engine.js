/**
 * Edge TTS engine — Microsoft's free text-to-speech service.
 * No API key needed. No rate limits. Good quality.
 * Uses Microsoft Edge's online TTS service.
 */

import { TTSEngine } from "./tts-interface.js";

export class EdgeTTSEngine extends TTSEngine {
  constructor(voice) {
    super();
    this.defaultVoice = voice || "en-US-AndrewMultilingualNeural";
  }

  get name() { return "edge-tts"; }

  async isAvailable() {
    try {
      const { getVoices } = await import("edge-tts");
      const voices = await getVoices();
      return voices.length > 0;
    } catch {
      return false;
    }
  }

  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");
    const { tts } = await import("edge-tts");
    const voice = voiceId || this.defaultVoice;
    const audioBuffer = await tts(text, { voice });
    return { audio: Buffer.from(audioBuffer), contentType: "audio/mpeg" };
  }

  async listVoices() {
    try {
      const { getVoices } = await import("edge-tts");
      const voices = await getVoices();
      // Return a curated list (full list has 400+ voices)
      const curated = voices
        .filter(v => v.Locale?.startsWith("en-"))
        .slice(0, 20)
        .map(v => ({ id: v.ShortName, name: v.FriendlyName || v.ShortName, isClone: false }));
      return curated;
    } catch {
      return [
        { id: "en-US-AndrewMultilingualNeural", name: "Andrew (US)", isClone: false },
        { id: "en-US-AvaMultilingualNeural", name: "Ava (US)", isClone: false },
        { id: "en-US-BrianMultilingualNeural", name: "Brian (US)", isClone: false },
        { id: "en-GB-SoniaNeural", name: "Sonia (UK)", isClone: false },
        { id: "en-AU-NatashaNeural", name: "Natasha (AU)", isClone: false },
      ];
    }
  }
}
