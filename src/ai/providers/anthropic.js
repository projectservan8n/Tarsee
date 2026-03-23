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

  const isOAuth = apiKey.includes("sk-ant-oat");
  const isApiKey = apiKey.startsWith("sk-ant-api");

  // Convert messages to Anthropic format (system is separate)
  let anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  // Anthropic requires messages to alternate user/assistant.
  // Merge consecutive same-role messages and ensure first message is from user.
  anthropicMessages = mergeConsecutiveRoles(anthropicMessages);

  // Anthropic requires at least one message
  if (anthropicMessages.length === 0) {
    throw new Error("No messages to send");
  }

  // Build system prompt — OAuth tokens are scoped to Claude Code and require
  // the identity prefix or Anthropic rejects the request.
  let systemBlocks;
  const userSystem = systemPrompt || messages.find((m) => m.role === "system")?.content || undefined;

  if (isOAuth) {
    systemBlocks = [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ...(userSystem ? [{ type: "text", text: userSystem }] : []),
    ];
  } else {
    systemBlocks = userSystem || undefined;
  }

  const resolvedModel = model || "claude-sonnet-4-6";

  const body = {
    model: resolvedModel,
    max_tokens: 8192,
    stream: true,
    messages: anthropicMessages,
    ...(systemBlocks ? { system: systemBlocks } : {}),
  };

  // Auth headers
  const authHeaders = isApiKey
    ? { "x-api-key": apiKey }
    : { "Authorization": `Bearer ${apiKey}` };

  // Beta headers differ for OAuth vs API key
  const betaHeaders = isOAuth
    ? "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14"
    : "fine-grained-tool-streaming-2025-05-14";

  // OAuth requires mimicking Claude Code CLI exactly
  const oauthHeaders = isOAuth
    ? {
        "user-agent": "claude-cli/2.1.62",
        "x-app": "cli",
        "anthropic-dangerous-direct-browser-access": "true",
      }
    : {};

  const bodyJson = JSON.stringify(body);
  console.log(`[anthropic] POST ${url}`);
  console.log(`[anthropic] auth=${isOAuth ? "oauth" : isApiKey ? "api-key" : "bearer"} model=${resolvedModel} messages=${anthropicMessages.length}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "accept": "application/json",
      ...authHeaders,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": betaHeaders,
      ...oauthHeaders,
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
      // Merge consecutive same-role messages
      prev.content += "\n\n" + messages[i].content;
    } else {
      merged.push({ ...messages[i] });
    }
  }

  return merged;
}
