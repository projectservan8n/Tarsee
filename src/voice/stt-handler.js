/**
 * Speech-to-text handler with multiple backend options.
 *
 * Priority:
 *   1. OpenAI Whisper API (cloud, requires OPENAI_API_KEY)
 *   2. Local whisper.cpp (requires binary + ffmpeg)
 *   3. Anthropic/Gemini audio (if available)
 *   4. Stub error
 *
 * The frontend voice.js sends audio to /api/voice/transcribe.
 */

import { isAvailable as whisperLocalAvailable, transcribe as whisperLocalTranscribe } from "./whisper-engine.js";

/**
 * Transcribe audio using the best available STT engine.
 * @param {Buffer} audioBuffer - Audio data (webm, wav, mp3, ogg)
 * @param {string} [language] - Language code (e.g., "en")
 * @param {object} [opts] - { settingsStore }
 * @returns {Promise<{transcript: string, language: string, provider: string}>}
 */
export async function transcribeAudio(audioBuffer, language, opts = {}) {
  // 1. Try OpenAI Whisper API
  const openaiKey = process.env.OPENAI_API_KEY || opts.settingsStore?.get?.("ai.openai.apiKey");
  if (openaiKey) {
    try {
      return await openaiWhisperAPI(audioBuffer, openaiKey, language);
    } catch (err) {
      console.warn("[stt] OpenAI Whisper API failed:", err.message);
      // Fall through to next option
    }
  }

  // 2. Try local whisper.cpp
  if (await whisperLocalAvailable()) {
    try {
      const result = await whisperLocalTranscribe(audioBuffer);
      return { transcript: result.text, language: result.language || "en", provider: "whisper.cpp" };
    } catch (err) {
      console.warn("[stt] Local whisper.cpp failed:", err.message);
    }
  }

  // 3. Try Gemini (supports audio in content)
  const geminiKey = process.env.GEMINI_API_KEY || opts.settingsStore?.get?.("ai.gemini.apiKey");
  if (geminiKey) {
    try {
      return await geminiTranscribe(audioBuffer, geminiKey, language);
    } catch (err) {
      console.warn("[stt] Gemini transcription failed:", err.message);
    }
  }

  // 4. No STT engine available
  throw Object.assign(
    new Error(
      "No STT engine available. Options: 1) Set OPENAI_API_KEY for cloud Whisper API, " +
      "2) Install whisper.cpp + ffmpeg for local STT, " +
      "3) Set GEMINI_API_KEY for Gemini audio."
    ),
    { status: 501 }
  );
}

/**
 * OpenAI Whisper API transcription.
 * Uses the /v1/audio/transcriptions endpoint.
 */
async function openaiWhisperAPI(audioBuffer, apiKey, language) {
  // Build multipart form data manually
  const boundary = "----TarseeSTTBoundary" + Date.now();
  const parts = [];

  // File part
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
    `Content-Type: audio/webm\r\n\r\n`
  );
  parts.push(audioBuffer);
  parts.push("\r\n");

  // Model part
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-1\r\n`
  );

  // Language part (optional)
  if (language) {
    const lang = language.split("-")[0]; // "en-US" -> "en"
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `${lang}\r\n`
    );
  }

  // Response format
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
    `json\r\n`
  );

  parts.push(`--${boundary}--\r\n`);

  // Combine into single buffer
  const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
  const body = Buffer.concat(bodyParts);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Whisper API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  console.log(`[stt] OpenAI Whisper: "${data.text?.slice(0, 80)}..."`);
  return {
    transcript: data.text || "",
    language: language?.split("-")[0] || "en",
    provider: "openai-whisper",
  };
}

/**
 * Gemini audio transcription.
 * Sends audio as inline_data to Gemini and asks for transcription.
 */
async function geminiTranscribe(audioBuffer, apiKey, language) {
  const b64 = audioBuffer.toString("base64");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: "audio/webm", data: b64 } },
          { text: "Transcribe this audio exactly. Return only the spoken words, nothing else." },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini transcription error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  console.log(`[stt] Gemini: "${text.slice(0, 80)}..."`);
  return {
    transcript: text.trim(),
    language: language?.split("-")[0] || "en",
    provider: "gemini",
  };
}
