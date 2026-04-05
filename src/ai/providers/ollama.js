/**
 * Ollama provider — uses native /api/chat endpoint.
 * Supports local and remote Ollama instances (including Cloudflare tunnels).
 *
 * Uses PROMPT-BASED tool calling instead of native function calling.
 * This works with ALL Ollama models (Gemma, Llama, Mistral, Phi, etc.)
 * regardless of whether they support native tool use.
 *
 * The model is instructed to output <tool_call> XML blocks which are
 * parsed from the streaming response and converted to tool_use events.
 */

/**
 * Build compact tool-calling instructions to append to the system prompt.
 * Keeps it small (~1-2KB) since the main CAPABILITY_INSTRUCTIONS already
 * lists all tools with descriptions.
 */
function buildToolCallingPrompt(tools) {
  if (!tools || tools.length === 0) return "";

  const paramRef = tools.map((t) => {
    const schema = t.input_schema;
    const required = schema?.required || [];
    const props = schema?.properties || {};
    const params = Object.entries(props)
      .map(([name, def]) => {
        const opt = required.includes(name) ? "" : "?";
        return `${name}${opt}`;
      })
      .join(", ");
    return `- ${t.name}(${params})`;
  }).join("\n");

  return `

## How to Call Tools

To use any of the tools listed above, output a tool call block in this EXACT format:

<tool_call>
{"name": "TOOL_NAME", "input": {"param1": "value1", "param2": "value2"}}
</tool_call>

### Examples:

To read a file:
<tool_call>
{"name": "read_file", "input": {"filename": "SOUL.md"}}
</tool_call>

To search memories:
<tool_call>
{"name": "search_memories", "input": {"query": "user preferences"}}
</tool_call>

To run a shell command:
<tool_call>
{"name": "exec", "input": {"command": "ls -la"}}
</tool_call>

### Tool Parameter Reference:
${paramRef}

CRITICAL RULES:
- You MUST use the exact <tool_call> XML tags shown above
- The JSON inside must be valid JSON
- ACTUALLY call tools — do NOT just describe what you would do
- When asked about files, configs, or system state: CALL read_file or exec — do NOT guess
- You can output text before or after tool calls
- After a tool executes, you will receive the result and can continue
`;
}

/**
 * Streaming text parser that detects <tool_call> blocks in the model output.
 * Returns parsed events: { type: "text", content } or { type: "tool_use", ... }
 */
class ToolCallParser {
  constructor() {
    this.buffer = "";
    this.inToolCall = false;
    this.toolCallContent = "";
    this.toolCallCounter = 0;
  }

  /** Feed a text chunk and get back an array of events */
  feed(text) {
    const events = [];
    this.buffer += text;

    // Keep processing while we can make progress
    let progress = true;
    while (progress) {
      progress = false;

      if (this.inToolCall) {
        const endTag = "</tool_call>";
        const endIdx = this.buffer.indexOf(endTag);
        if (endIdx !== -1) {
          this.toolCallContent += this.buffer.slice(0, endIdx);
          this.buffer = this.buffer.slice(endIdx + endTag.length);
          this.inToolCall = false;

          // Parse the tool call JSON
          try {
            const tc = JSON.parse(this.toolCallContent.trim());
            this.toolCallCounter++;
            events.push({
              type: "tool_use",
              id: `ollama-tc-${Date.now()}-${this.toolCallCounter}`,
              name: tc.name,
              input: tc.input || tc.arguments || tc.params || {},
            });
          } catch {
            // Failed to parse — emit as regular text so user sees what model said
            events.push({ type: "text", content: `<tool_call>${this.toolCallContent}</tool_call>` });
          }
          this.toolCallContent = "";
          progress = true;
          continue;
        } else {
          // Still buffering tool call content
          this.toolCallContent += this.buffer;
          this.buffer = "";
          break;
        }
      }

      // Not in a tool call — look for <tool_call> start
      const startTag = "<tool_call>";
      const startIdx = this.buffer.indexOf(startTag);

      if (startIdx !== -1) {
        // Emit text before the tag
        if (startIdx > 0) {
          events.push({ type: "text", content: this.buffer.slice(0, startIdx) });
        }
        this.buffer = this.buffer.slice(startIdx + startTag.length);
        this.inToolCall = true;
        this.toolCallContent = "";
        progress = true;
        continue;
      }

      // No complete start tag found — but might have a partial one at the end
      // Hold back enough chars to detect a partial "<tool_call>" (10 chars)
      const holdLen = startTag.length - 1; // 10
      if (this.buffer.length > holdLen) {
        const safeText = this.buffer.slice(0, -holdLen);
        this.buffer = this.buffer.slice(-holdLen);
        if (safeText) {
          events.push({ type: "text", content: safeText });
          progress = true;
        }
      }
      break;
    }

    return events;
  }

  /** Flush remaining buffer at end of stream */
  flush() {
    const events = [];
    if (this.inToolCall) {
      // Unclosed tool call — emit as text
      events.push({ type: "text", content: `<tool_call>${this.toolCallContent}` });
    }
    if (this.buffer) {
      events.push({ type: "text", content: this.buffer });
    }
    this.buffer = "";
    this.toolCallContent = "";
    this.inToolCall = false;
    return events;
  }
}


export async function* chat({ messages, model, apiKey, baseUrl, systemPrompt, signal, tools }) {
  const base = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const url = `${base}/api/chat`;

  // Enhance system prompt with tool calling instructions
  let enhancedSystemPrompt = systemPrompt || "";
  if (tools?.length > 0) {
    enhancedSystemPrompt += buildToolCallingPrompt(tools);
  }

  const allMessages = [];
  if (enhancedSystemPrompt) {
    allMessages.push({ role: "system", content: enhancedSystemPrompt });
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
        // Convert assistant tool_use blocks back to text format
        // (Since we use prompt-based calling, tool calls are just text with <tool_call> tags)
        let content = textParts.join("\n");
        for (const tc of toolUseParts) {
          content += `\n<tool_call>\n${JSON.stringify({ name: tc.name, input: tc.input || {} })}\n</tool_call>`;
        }
        allMessages.push({ role: "assistant", content: content.trim() });
      } else if (toolResultParts.length > 0) {
        // Tool results — combine into a single user message
        const resultTexts = toolResultParts.map((tr) => {
          const content = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
          return `Tool result:\n${content}`;
        });
        allMessages.push({ role: "user", content: resultTexts.join("\n\n") });
      } else if (textParts.length > 0) {
        allMessages.push({ role: msg.role, content: textParts.join("\n") });
      }
    }
  }

  // NO tools parameter — we use prompt-based tool calling instead
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
  const parser = new ToolCallParser();
  let hasToolCalls = false;

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

          // Text content — feed through tool call parser
          if (event.message?.content) {
            const parsed = parser.feed(event.message.content);
            for (const evt of parsed) {
              if (evt.type === "tool_use") hasToolCalls = true;
              yield evt;
            }
          }

          if (event.done) {
            // Flush any remaining buffered text
            const flushed = parser.flush();
            for (const evt of flushed) {
              if (evt.type === "tool_use") hasToolCalls = true;
              yield evt;
            }

            if (event.eval_count || event.prompt_eval_count) {
              yield {
                type: "usage",
                usage: {
                  input_tokens: event.prompt_eval_count || 0,
                  output_tokens: event.eval_count || 0,
                },
              };
            }
            yield { type: "done", stopReason: hasToolCalls ? "tool_use" : "end_turn" };
            return;
          }
        } catch {
          // Skip malformed JSON lines from Ollama
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Flush parser in case stream ended without a done event
  const flushed = parser.flush();
  for (const evt of flushed) {
    if (evt.type === "tool_use") hasToolCalls = true;
    yield evt;
  }

  yield { type: "done", stopReason: hasToolCalls ? "tool_use" : "end_turn" };
}
