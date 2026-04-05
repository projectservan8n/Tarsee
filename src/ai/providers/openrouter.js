/**
 * OpenRouter provider.
 * Uses OpenAI-compatible Chat Completions API with streaming.
 * Full tool calling support via function calling format.
 *
 * Supports both paid and free models. Free models often have
 * ":free" suffix (e.g. "google/gemma-2-9b-it:free").
 */

export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal, tools }) {
  const url = `${baseUrl || "https://openrouter.ai/api"}/v1/chat/completions`;

  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }

  // Convert Anthropic-style content blocks to OpenAI format
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      allMessages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const textParts = [];
      const toolUseParts = [];
      const toolResultParts = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "image" && block.source?.type === "base64") {
          // Convert to OpenAI image_url format
          allMessages.push({
            role: msg.role,
            content: [{
              type: "image_url",
              image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
            }],
          });
        } else if (block.type === "tool_use") {
          toolUseParts.push(block);
        } else if (block.type === "tool_result") {
          toolResultParts.push(block);
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
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
      } else if (textParts.length > 0) {
        allMessages.push({ role: msg.role, content: textParts.join("\n") });
      }
    } else {
      allMessages.push({ role: msg.role, content: msg.content });
    }
  }

  // Convert Anthropic-style tools to OpenAI function format
  const openaiTools = tools?.length > 0
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
    model: model || "anthropic/claude-sonnet-4-5",
    stream: true,
    messages: allMessages,
    ...(openaiTools ? { tools: openaiTools } : {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://tarsee.ai",
      "X-Title": "Tarsee",
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
  let stopReason = "end_turn";

  // Track tool calls being assembled from streaming chunks
  const toolCalls = {};

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
            const choice = event.choices?.[0];
            const delta = choice?.delta;

            // Text content
            if (delta?.content) {
              yield { type: "text", content: delta.content };
            }

            // Tool call chunks (streamed incrementally)
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { id: tc.id || "", name: "", args: "" };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
              }
            }

            // Finish reason
            if (choice?.finish_reason) {
              if (choice.finish_reason === "tool_calls") {
                stopReason = "tool_use";
              } else {
                stopReason = choice.finish_reason === "stop" ? "end_turn" : choice.finish_reason;
              }
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

  // Emit completed tool calls
  for (const tc of Object.values(toolCalls)) {
    let input = {};
    try { input = JSON.parse(tc.args); } catch { /* empty */ }
    yield {
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input,
    };
  }

  if (Object.keys(usage).length > 0) {
    yield { type: "usage", usage };
  }
  yield { type: "done", stopReason };
}
