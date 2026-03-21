/**
 * OpenRouter provider.
 * Uses OpenAI-compatible Chat Completions API with streaming.
 */

export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal }) {
  const url = `${baseUrl || "https://openrouter.ai/api"}/v1/chat/completions`;

  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }
  allMessages.push(...messages);

  const body = {
    model: model || "anthropic/claude-sonnet-4-5",
    stream: true,
    messages: allMessages,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://opusclaw.ai",
      "X-Title": "OpusClaw",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errText}`);
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
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);
            const delta = event.choices?.[0]?.delta;

            if (delta?.content) {
              yield { type: "text", content: delta.content };
            }

            if (event.usage) {
              usage = event.usage;
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
