/**
 * Speech-to-text handler with multiple backend options.
 *
 * Priority:
 *   1. OpenAI whisper-1 (cloud, requires OPENAI_API_KEY)
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
  const store = opts.settingsStore;

  // 1. Try OpenAI Whisper API (whisper-1) — vault key first, env second
  const openaiKey = store?.getApiKey?.("openai") || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      return await openaiWhisperAPI(audioBuffer, openaiKey, language);
    } catch (err) {
      console.warn("[stt] OpenAI whisper-1 failed:", err.message);
    }
  } else {
    console.warn("[stt] No OpenAI key found (vault or env)");
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

  // 3. Try Gemini — vault key first, env second
  const geminiKey = store?.getApiKey?.("gemini") || process.env.GEMINI_API_KEY;
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
      "No STT engine available. Set an OpenAI or Gemini API key in Settings > Providers, or via environment variables."
    ),
    { status: 501 }
  );
}

/**
 * OpenAI whisper-1 transcription.
 * Uses the /v1/audio/transcriptions endpoint.
 */
async function openaiWhisperAPI(audioBuffer, apiKey, language) {
  // Build multipart form data
  function buildBody() {
    const boundary = "----TarseeSTTBoundary" + Date.now();
    const parts = [];

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
      `Content-Type: audio/webm\r\n\r\n`
    );
    parts.push(audioBuffer);
    parts.push("\r\n");

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n`
    );

    if (language) {
      const lang = language.split("-")[0];
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${lang}\r\n`
      );
    }

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `json\r\n`
    );

    parts.push(`--${boundary}--\r\n`);

    const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
    return { body: Buffer.concat(bodyParts), boundary };
  }

  // Retry up to 2 times on 503/429 (OpenAI overloaded)
  // Keep total time under 20s to avoid Railway proxy timeout
  const MAX_RETRIES = 2;
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[stt] OpenAI retry ${attempt}/${MAX_RETRIES} after 1s...`);
      await new Promise((r) => setTimeout(r, 1000));
    }

    const { body, boundary } = buildBody();

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`[stt] OpenAI STT: "${data.text?.slice(0, 80)}..."`);
      return {
        transcript: data.text || "",
        language: language?.split("-")[0] || "en",
        provider: "whisper-1",
      };
    }

    const errText = await res.text();
    lastError = new Error(`OpenAI whisper-1 error (${res.status}): ${errText}`);

    // Only retry on 503 (overloaded) or 429 (rate limit)
    if (res.status !== 503 && res.status !== 429) {
      throw lastError;
    }
    console.warn(`[stt] OpenAI returned ${res.status}, retrying...`);
  }

  throw lastError;
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
