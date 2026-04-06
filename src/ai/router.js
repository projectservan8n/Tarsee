import { AI_PROVIDERS } from "../config/constants.js";

// Lazy-loaded provider module
let claudeCodeModule = null;

/**
 * Routes a chat request to Claude Code.
 * Returns an async generator that yields streaming events.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages - Conversation messages
 * @param {string} [opts.provider] - Provider ID (only "claude-code" supported)
 * @param {string} [opts.model] - Model ID
 * @param {string} [opts.systemPrompt] - System prompt
 * @param {AbortSignal} [opts.signal] - Abort signal
 * @param {Array} [opts.tools] - Tool definitions (unused — Claude Code manages its own tools)
 * @returns {AsyncGenerator<{type: string, content?: string, usage?: object}>}
 */
export async function* chatStream(opts) {
  const { messages, model, systemPrompt, signal, toolCtx, sessionId, onSessionId } = opts;

  if (!claudeCodeModule) {
    claudeCodeModule = await import("./providers/claude-code.js");
  }

  const providerDef = AI_PROVIDERS["claude-code"];

  yield* claudeCodeModule.chat({
    messages,
    model: model || providerDef?.defaultModel || "claude-sonnet-4-6",
    systemPrompt,
    signal,
    toolCtx,
    sessionId,
    onSessionId,
  });
}

/**
 * Gets list of available providers.
 * @returns {Array<{id: string, name: string, configured: boolean}>}
 */
export function getAvailableProviders() {
  return Object.values(AI_PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    configured: true,
    defaultModel: p.defaultModel,
  }));
}
