import { AI_PROVIDERS, getRecommendedModel } from "../config/constants.js";

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
  const { messages, model, systemPrompt, signal, toolCtx, sessionId, onSessionId, effort, maxTurns, maxBudgetUsd } = opts;

  if (!claudeCodeModule) {
    claudeCodeModule = await import("./providers/claude-code.js");
  }

  const providerDef = AI_PROVIDERS["claude-code"];

  yield* claudeCodeModule.chat({
    messages,
    model: model || providerDef?.defaultModel || getRecommendedModel(),
    systemPrompt,
    signal,
    toolCtx,
    sessionId,
    onSessionId,
    // Forwarded so /think works on channels too. Without this the provider
    // never receives an effort level and /think was a silent no-op on
    // Telegram / Discord / WhatsApp / email (web chat calls the provider
    // directly and so was unaffected).
    effort,
    // Ceilings for unattended work. Undefined on the interactive path, which
    // keeps the provider's generous interactive defaults.
    maxTurns,
    maxBudgetUsd,
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
