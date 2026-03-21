/**
 * Custom OpenAI-compatible provider.
 * For self-hosted models (Ollama, vLLM, LM Studio, etc.)
 */

export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal }) {
  if (!baseUrl) throw new Error("Custom provider requires a baseUrl");

  // Normalize: ensure baseUrl ends with /v1/chat/completions or similar
  const url = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";

  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }
  allMessages.push(...messages);

  const body = {
    model: model || "default",
    stream: true,
    messages: allMessages,
  };

  const headers = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Custom provider error ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);
            const delta = event.choices?.[0]?.delta;

            if (delta?.content) {
              yield { type: "text", content: delta.content };
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

  yield { type: "done" };
}
