/**
 * Ollama provider — uses native /api/chat endpoint.
 * Supports local and remote Ollama instances (including Cloudflare tunnels).
 * No API key required.
 */

export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal }) {
  const base = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const url = `${base}/api/chat`;

  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }

  // Convert messages — flatten any content arrays to plain text
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      allMessages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Extract text from content blocks (tool_result, image blocks, etc.)
      const text = msg.content
        .filter((b) => b.type === "text" || typeof b === "string")
        .map((b) => (typeof b === "string" ? b : b.text))
        .join("\n");
      if (text) allMessages.push({ role: msg.role, content: text });
    }
  }

  const body = {
    model: model || "gemma3:4b",
    messages: allMessages,
    stream: true,
  };

  const headers = { "Content-Type": "application/json" };
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
    throw new Error(`Ollama error ${response.status}: ${errText}`);
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
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);

          if (event.message?.content) {
            yield { type: "text", content: event.message.content };
          }

          if (event.done) {
            if (event.eval_count || event.prompt_eval_count) {
              yield {
                type: "usage",
                usage: {
                  input_tokens: event.prompt_eval_count || 0,
                  output_tokens: event.eval_count || 0,
                },
              };
            }
            yield { type: "done" };
            return;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "done" };
}
