/**
 * Anthropic (Claude) provider.
 * Uses the Messages API with streaming.
 * Supports tool_use for function calling.
 */

/**
 * @param {object} opts
 * @param {Array} opts.messages - Conversation messages (may include tool_result blocks)
 * @param {string} opts.model
 * @param {string} opts.apiKey
 * @param {string} opts.baseUrl
 * @param {string} [opts.systemPrompt]
 * @param {AbortSignal} [opts.signal]
 * @param {Array} [opts.tools] - Tool definitions for function calling
 * @yields {{ type: 'text', content: string } | { type: 'tool_use', id: string, name: string, input: object } | { type: 'usage', usage: object } | { type: 'done', stopReason: string }}
 */
export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal, tools }) {
  const url = `${baseUrl || "https://api.anthropic.com"}/v1/messages`;

  // Convert messages to Anthropic format (system is separate)
  let anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      // Pass through structured content blocks (for tool_result messages)
      if (Array.isArray(m.content)) {
        return { role: m.role, content: m.content };
      }
      return { role: m.role, content: m.content };
    });

  // Anthropic requires messages to alternate user/assistant roles.
  // Merge consecutive same-role messages and ensure first message is from user.
  anthropicMessages = mergeConsecutiveRoles(anthropicMessages);

  // Anthropic requires at least one message
  if (anthropicMessages.length === 0) {
    throw new Error("No messages to send");
  }

  // Build system prompt
  const systemBlocks = systemPrompt || messages.find((m) => m.role === "system")?.content || undefined;

  const resolvedModel = model || "claude-sonnet-4-6";

  const body = {
    model: resolvedModel,
    max_tokens: 8192,
    stream: true,
    messages: anthropicMessages,
    ...(systemBlocks ? { system: systemBlocks } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
  };

  const bodyJson = JSON.stringify(body);
  console.log(`[anthropic] POST ${url}`);
  console.log(`[anthropic] auth=api-key model=${resolvedModel} messages=${anthropicMessages.length} tools=${tools?.length || 0}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "accept": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    },
    body: bodyJson,
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[anthropic] API error ${response.status}: ${errText}`);
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = {};
  let stopReason = "end_turn";

  // Track tool_use content blocks being built
  let currentToolUse = null;
  let toolUseJsonBuf = "";

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

            // Text content
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              yield { type: "text", content: event.delta.text };
            }

            // Tool use content block start
            if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              currentToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
              };
              toolUseJsonBuf = "";
            }

            // Tool use input JSON delta
            if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
              toolUseJsonBuf += event.delta.partial_json || "";
            }

            // Content block stop — emit completed tool_use
            if (event.type === "content_block_stop" && currentToolUse) {
              let input = {};
              try { input = JSON.parse(toolUseJsonBuf); } catch { /* empty input */ }
              yield {
                type: "tool_use",
                id: currentToolUse.id,
                name: currentToolUse.name,
                input,
              };
              currentToolUse = null;
              toolUseJsonBuf = "";
            }

            // Message-level events
            if (event.type === "message_delta") {
              if (event.usage) usage = { ...usage, ...event.usage };
              if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            }
            if (event.type === "message_start" && event.message?.usage) {
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
  yield { type: "done", stopReason };
}

/**
 * Anthropic requires strictly alternating user/assistant roles,
 * starting with user. Merge consecutive same-role messages.
 */
function mergeConsecutiveRoles(messages) {
  if (messages.length === 0) return messages;

  // Ensure first message is from user
  if (messages[0].role !== "user") {
    messages = [{ role: "user", content: "(continued)" }, ...messages];
  }

  const merged = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    if (messages[i].role === prev.role) {
      // Only merge if both are simple strings
      if (typeof prev.content === "string" && typeof messages[i].content === "string") {
        prev.content += "\n\n" + messages[i].content;
      } else {
        // Can't merge structured content — just push
        merged.push({ ...messages[i] });
      }
    } else {
      merged.push({ ...messages[i] });
    }
  }

  return merged;
}
