/**
 * Google Gemini provider.
 * Uses the generateContent streaming API.
 */

export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal }) {
  const base = baseUrl || "https://generativelanguage.googleapis.com";
  const modelId = model || "gemini-2.5-flash";
  const url = `${base}/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;

  // Convert to Gemini format (supports text + vision)
  const contents = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // Handled separately
    const parts = [];

    if (Array.isArray(msg.content)) {
      // Multi-part content (text + images)
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image" && block.source?.data) {
          parts.push({
            inline_data: {
              mime_type: block.source.media_type || "image/png",
              data: block.source.data,
            },
          });
        }
      }
    } else {
      parts.push({ text: msg.content });
    }

    if (parts.length > 0) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }
  }

  const systemInstruction = systemPrompt || messages.find((m) => m.role === "system")?.content;

  const body = {
    contents,
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    generationConfig: {
      maxOutputTokens: 8192,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const event = JSON.parse(data);
            const text = event.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) {
              yield { type: "text", content: text };
            }

            if (event.usageMetadata) {
              usage = {
                input_tokens: event.usageMetadata.promptTokenCount,
                output_tokens: event.usageMetadata.candidatesTokenCount,
              };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (Object.keys(usage).length > 0) {
    yield { type: "usage", usage };
  }
  yield { type: "done" };
}
