/**
 * Anthropic (Claude) provider.
 * Uses the Messages API with streaming.
 */

/**
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {string} opts.model
 * @param {string} opts.apiKey
 * @param {string} opts.baseUrl
 * @param {string} [opts.systemPrompt]
 * @param {AbortSignal} [opts.signal]
 * @yields {{ type: 'text', content: string } | { type: 'usage', usage: object } | { type: 'done' }}
 */
export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal }) {
  const url = `${baseUrl || "https://api.anthropic.com"}/v1/messages`;

  // Convert messages to Anthropic format (system is separate)
  const anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const system = systemPrompt || messages.find((m) => m.role === "system")?.content || undefined;

  const body = {
    model: model || "claude-sonnet-4-5-20250929",
    max_tokens: 8192,
    stream: true,
    messages: anthropicMessages,
    ...(system ? { system } : {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
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

            if (event.type === "content_block_delta" && event.delta?.text) {
              yield { type: "text", content: event.delta.text };
            } else if (event.type === "message_delta" && event.usage) {
              usage = { ...usage, ...event.usage };
            } else if (event.type === "message_start" && event.message?.usage) {
              usage = { ...usage, input_tokens: event.message.usage.input_tokens };
            }
          } catch {
            // Skip malformed JSON lines
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
