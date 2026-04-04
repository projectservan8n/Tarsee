/**
 * Media understanding for Tarsee.
 * Analyzes images, audio, and video using AI vision models.
 */

const MAX_CONCURRENT = 3;
let activeAnalyses = 0;

export async function analyzeImage(imageBuffer, mimeType, opts = {}) {
  while (activeAnalyses >= MAX_CONCURRENT) await new Promise((r) => setTimeout(r, 100));
  activeAnalyses++;
  try {
    const b64 = imageBuffer.toString("base64");
    const provider = opts.provider || "anthropic";
    const apiKey = opts.apiKey;
    if (!apiKey) return "No API key available for image analysis.";

    if (provider === "anthropic") {
      return await analyzeWithClaude(b64, mimeType, apiKey, opts.prompt);
    } else if (provider === "openai") {
      return await analyzeWithGPT4(b64, mimeType, apiKey, opts.prompt);
    } else if (provider === "gemini") {
      return await analyzeWithGemini(b64, mimeType, opts.geminiKey, opts.prompt);
    }
    return "Unsupported provider for image analysis.";
  } finally {
    activeAnalyses--;
  }
}

async function analyzeWithClaude(b64, mimeType, apiKey, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType || "image/png", data: b64 } },
          { type: "text", text: prompt || "Describe this image in detail." },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (data.error) return `Analysis error: ${data.error.message || data.error.type || JSON.stringify(data.error)}`;
  return data.content?.[0]?.text || "No analysis generated.";
}

async function analyzeWithGPT4(b64, mimeType, apiKey, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType || "image/png"};base64,${b64}` } },
          { type: "text", text: prompt || "Describe this image in detail." },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (data.error) return `Analysis error: ${data.error.message || data.error.type || JSON.stringify(data.error)}`;
  return data.choices?.[0]?.message?.content || "No analysis generated.";
}

async function analyzeWithGemini(b64, mimeType, apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType || "image/png", data: b64 } },
          { text: prompt || "Describe this image in detail." },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (data.error) return `Analysis error: ${data.error.message || data.error.type || JSON.stringify(data.error)}`;
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No analysis generated.";
}

export async function analyzeAudio(audioBuffer, opts = {}) {
  // Use Whisper for transcription
  try {
    const { isAvailable, transcribe } = await import("../voice/whisper-engine.js");
    if (isAvailable()) {
      const result = await transcribe(audioBuffer);
      return { transcript: result.text, language: result.language };
    }
  } catch { /* whisper not available */ }
  return { transcript: "Audio transcription not available. Install whisper.cpp for local STT.", language: null };
}

export function getMediaProviderInfo(settingsStore) {
  const anthropicKey = settingsStore?.getApiKey?.("anthropic");
  const openaiKey = settingsStore?.getApiKey?.("openai");
  const geminiKey = settingsStore?.getApiKey?.("gemini");
  if (anthropicKey) return { provider: "anthropic", apiKey: anthropicKey };
  if (openaiKey) return { provider: "openai", apiKey: openaiKey };
  if (geminiKey) return { provider: "gemini", apiKey: geminiKey };
  return null;
}
