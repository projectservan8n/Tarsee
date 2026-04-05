/**
 * Ollama provider — uses native /api/chat endpoint.
 * Supports local and remote Ollama instances (including Cloudflare tunnels).
 * Full tool calling support via OpenAI-compatible function calling format.
 * No API key required.
 */

export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal, tools }) {
  const base = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const url = `${base}/api/chat`;

  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }

  // Convert messages from Anthropic format to Ollama format
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      allMessages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Handle Anthropic-style content block arrays
      const textParts = [];
      const toolUseParts = [];
      const toolResultParts = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolUseParts.push(block);
        } else if (block.type === "tool_result") {
          toolResultParts.push(block);
        } else if (typeof block === "string") {
          textParts.push(block);
        }
      }

      if (toolUseParts.length > 0 && msg.role === "assistant") {
        // Assistant message with tool calls
        allMessages.push({
          role: "assistant",
          content: textParts.join("\n") || "",
          tool_calls: toolUseParts.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input || {}),
            },
          })),
        });
      } else if (toolResultParts.length > 0) {
        // Tool result messages — one per result
        for (const tr of toolResultParts) {
          allMessages.push({
            role: "tool",
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
      } else if (textParts.length > 0) {
        allMessages.push({ role: msg.role, content: textParts.join("\n") });
      }
    }
  }

  // Convert Anthropic-style tools to Ollama/OpenAI function format
  const ollamaTools = tools?.length > 0
    ? tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
    : undefined;

  const body = {
    model: model || "gemma3:4b",
    messages: allMessages,
    stream: true,
    ...(ollamaTools ? { tools: ollamaTools } : {}),
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
  let stopReason = "end_turn";

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

          // Text content
          if (event.message?.content) {
            yield { type: "text", content: event.message.content };
          }

          // Tool calls from Ollama
          if (event.message?.tool_calls) {
            stopReason = "tool_use";
            for (const tc of event.message.tool_calls) {
              const fn = tc.function;
              let input = {};
              try {
                input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments || {};
              } catch { /* empty */ }
              yield {
                type: "tool_use",
                id: tc.id || `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: fn.name,
                input,
              };
            }
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
            yield { type: "done", stopReason };
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

  yield { type: "done", stopReason };
}
