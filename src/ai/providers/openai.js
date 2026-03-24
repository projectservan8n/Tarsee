/**
 * OpenAI provider.
 * Uses the Chat Completions API with streaming.
 * Supports function calling / tool_use.
 */

export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal, tools }) {
  const url = `${baseUrl || "https://api.openai.com"}/v1/chat/completions`;

  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }
  allMessages.push(...messages);

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
    model: model || "gpt-4o",
    stream: true,
    stream_options: { include_usage: true },
    messages: allMessages,
    ...(openaiTools ? { tools: openaiTools } : {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = {};
  let stopReason = "end_turn";

  // Track tool calls being assembled
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

            // Tool call chunks
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
