/**
 * Edge TTS engine — Microsoft's free text-to-speech service.
 * No API key needed. No rate limits. Good quality.
 * Uses node-edge-tts package with retry logic.
 */

import { TTSEngine } from "./tts-interface.js";
import fs from "node:fs";
import crypto from "node:crypto";

const MAX_RETRIES = 3;
const TTS_TIMEOUT = 30_000; // 30s per attempt — longer text needs more time

export class EdgeTTSEngine extends TTSEngine {
  constructor(voice) {
    super();
    this.defaultVoice = voice || "en-US-AndrewMultilingualNeural";
  }

  get name() { return "edge-tts"; }

  async isAvailable() {
    try {
      // Light check — just import the module, don't generate audio
      await import("node-edge-tts");
      return true;
    } catch (err) {
      console.warn("[edge-tts] not available:", err.message);
      return false;
    }
  }

  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");

    // Strip emojis — Edge TTS reads them aloud as descriptions
    text = text
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}\u{FE0F}]/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!text) throw new Error("No speakable text after stripping emojis");

    // Strip markdown artifacts that sound bad when spoken
    text = text
      .replace(/```[\s\S]*?```/g, "")   // code blocks
      .replace(/`[^`]+`/g, "")           // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → just text
      .replace(/[*_~#>]/g, "")           // markdown formatting
      .replace(/\n{2,}/g, ". ")          // paragraph breaks → pause
      .replace(/\n/g, " ")              // newlines → space
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!text) throw new Error("No speakable text after cleanup");

    const { EdgeTTS } = await import("node-edge-tts");
    const voice = voiceId || this.defaultVoice;

    // Retry loop — Edge TTS WebSocket can drop
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const tmpFile = `/tmp/edge-tts-${crypto.randomBytes(4).toString("hex")}.mp3`;
      try {
        const t = new EdgeTTS({ voice });
        await Promise.race([
          t.ttsPromise(text, tmpFile),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`TTS timed out (attempt ${attempt}/${MAX_RETRIES})`)), TTS_TIMEOUT)
          ),
        ]);

        const audio = fs.readFileSync(tmpFile);
        if (audio.length < 100) throw new Error("Generated audio too small — likely empty");

        return { audio, contentType: "audio/mpeg" };
      } catch (err) {
        lastError = err;
        console.warn(`[edge-tts] attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * attempt));
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }

    throw lastError || new Error("Edge TTS failed after retries");
  }

  async listVoices() {
    return [
      // US English
      { id: "en-US-AndrewMultilingualNeural", name: "Andrew (US)", isClone: false },
      { id: "en-US-AvaMultilingualNeural", name: "Ava (US)", isClone: false },
      { id: "en-US-BrianMultilingualNeural", name: "Brian (US)", isClone: false },
      { id: "en-US-EmmaMultilingualNeural", name: "Emma (US)", isClone: false },
      { id: "en-US-ChristopherNeural", name: "Christopher (US)", isClone: false },
      { id: "en-US-JennyNeural", name: "Jenny (US)", isClone: false },
      { id: "en-US-GuyNeural", name: "Guy (US)", isClone: false },
      { id: "en-US-AriaNeural", name: "Aria (US)", isClone: false },
      { id: "en-US-DavisNeural", name: "Davis (US)", isClone: false },
      // UK English
      { id: "en-GB-SoniaNeural", name: "Sonia (UK)", isClone: false },
      { id: "en-GB-RyanNeural", name: "Ryan (UK)", isClone: false },
      { id: "en-GB-LibbyNeural", name: "Libby (UK)", isClone: false },
      // Australian
      { id: "en-AU-NatashaNeural", name: "Natasha (AU)", isClone: false },
      { id: "en-AU-WilliamNeural", name: "William (AU)", isClone: false },
      // Philippine
      { id: "en-PH-JamesNeural", name: "James (PH)", isClone: false },
      { id: "en-PH-RosaNeural", name: "Rosa (PH)", isClone: false },
      // Multilingual (multiple languages with same voice)
      { id: "en-US-AlloyMultilingualNeural", name: "Alloy (Multilingual)", isClone: false },
      { id: "en-US-NovaMultilingualNeural", name: "Nova (Multilingual)", isClone: false },
      { id: "en-US-ShimmerMultilingualNeural", name: "Shimmer (Multilingual)", isClone: false },
    ];
  }
}
