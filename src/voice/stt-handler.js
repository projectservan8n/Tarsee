/**
 * Speech-to-text — OpenAI Whisper API only.
 * Requires OPENAI_API_KEY (env or vault).
 */

/**
 * Transcribe audio using OpenAI Whisper.
 * @param {Buffer} audioBuffer - Audio data (webm, wav, mp3, ogg)
 * @param {string} [language] - Language code (e.g., "en")
 * @param {object} [opts] - { settingsStore }
 * @returns {Promise<{transcript: string, language: string, provider: string}>}
 */
export async function transcribeAudio(audioBuffer, language, opts = {}) {
  const store = opts.settingsStore;
  const openaiKey = store?.getApiKey?.("openai");

  if (!openaiKey) {
    throw Object.assign(
      new Error("OPENAI_API_KEY is required for Whisper STT. Set it in Railway env vars or Settings > Providers."),
      { status: 501 }
    );
  }

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
  const body = Buffer.concat(bodyParts);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  console.log(`[stt] Whisper: "${data.text?.slice(0, 80)}..."`);
  return {
    transcript: data.text || "",
    language: language?.split("-")[0] || "en",
    provider: "whisper-1",
  };
}
