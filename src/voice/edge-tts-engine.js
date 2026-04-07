/**
 * Edge TTS engine — Microsoft's free text-to-speech service.
 * No API key needed. No rate limits. Good quality.
 * Uses node-edge-tts package.
 */

import { TTSEngine } from "./tts-interface.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class EdgeTTSEngine extends TTSEngine {
  constructor(voice) {
    super();
    this.defaultVoice = voice || "en-US-AndrewMultilingualNeural";
  }

  get name() { return "edge-tts"; }

  async isAvailable() {
    try {
      const { EdgeTTS } = await import("node-edge-tts");
      const tmpFile = `/tmp/edge-tts-test-${Date.now()}.mp3`;
      const t = new EdgeTTS({ voice: this.defaultVoice });
      await t.ttsPromise("test", tmpFile);
      fs.unlinkSync(tmpFile);
      return true;
    } catch (err) {
      console.warn("[edge-tts] availability check failed:", err.message);
      return false;
    }
  }

  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");
    // Strip emojis — Edge TTS reads them aloud as "emoji face with tears of joy" etc.
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}\u{FE0F}]/gu, "").replace(/\s{2,}/g, " ").trim();
    const { EdgeTTS } = await import("node-edge-tts");
    const voice = voiceId || this.defaultVoice;
    const tmpFile = `/tmp/edge-tts-${crypto.randomBytes(4).toString("hex")}.mp3`;

    try {
      const t = new EdgeTTS({ voice });
      await t.ttsPromise(text, tmpFile);
      const audio = fs.readFileSync(tmpFile);
      return { audio, contentType: "audio/mpeg" };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  async listVoices() {
    return [
      { id: "en-US-AndrewMultilingualNeural", name: "Andrew (US)", isClone: false },
      { id: "en-US-AvaMultilingualNeural", name: "Ava (US)", isClone: false },
      { id: "en-US-BrianMultilingualNeural", name: "Brian (US)", isClone: false },
      { id: "en-US-EmmaMultilingualNeural", name: "Emma (US)", isClone: false },
      { id: "en-GB-SoniaNeural", name: "Sonia (UK)", isClone: false },
      { id: "en-GB-RyanNeural", name: "Ryan (UK)", isClone: false },
      { id: "en-AU-NatashaNeural", name: "Natasha (AU)", isClone: false },
      { id: "en-PH-JamesNeural", name: "James (PH)", isClone: false },
      { id: "en-PH-RosaNeural", name: "Rosa (PH)", isClone: false },
    ];
  }
}
