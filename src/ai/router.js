import { AI_PROVIDERS } from "../config/constants.js";

// Lazy-loaded provider modules
const providerModules = {};

/**
 * Loads a provider module on demand.
 * @param {string} providerId
 * @returns {Promise<{chat: Function}>}
 */
async function loadProvider(providerId) {
  if (providerModules[providerId]) return providerModules[providerId];

  const moduleMap = {
    anthropic: "./providers/anthropic.js",
    openai: "./providers/openai.js",
    gemini: "./providers/gemini.js",
    openrouter: "./providers/openrouter.js",
    custom: "./providers/custom.js",
  };

  const modulePath = moduleMap[providerId];
  if (!modulePath) throw new Error(`Unknown provider: ${providerId}`);

  const mod = await import(modulePath);
  providerModules[providerId] = mod;
  return mod;
}

/**
 * Routes a chat request to the appropriate AI provider.
 * Returns an async generator that yields text chunks.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages - Conversation messages
 * @param {string} opts.provider - Provider ID (anthropic, openai, gemini, openrouter, custom)
 * @param {string} opts.model - Model ID
 * @param {string} opts.apiKey - API key
 * @param {string} [opts.baseUrl] - Custom base URL (for custom provider)
 * @param {string} [opts.systemPrompt] - System prompt
 * @param {AbortSignal} [opts.signal] - Abort signal
 * @returns {AsyncGenerator<{type: string, content?: string, usage?: object}>}
 */
export async function* chatStream(opts) {
  const { provider: providerId, model, apiKey, baseUrl, messages, systemPrompt, signal } = opts;

  if (!providerId) throw new Error("No AI provider configured");
  if (!apiKey) throw new Error(`No API key configured for ${providerId}`);

  const providerDef = AI_PROVIDERS[providerId];
  if (!providerDef && providerId !== "custom") {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const providerModule = await loadProvider(providerId);

  yield* providerModule.chat({
    messages,
    model: model || providerDef?.defaultModel || "",
    apiKey,
    baseUrl: baseUrl || providerDef?.baseUrl || "",
    systemPrompt,
    signal,
  });
}

/**
 * Gets list of available providers (those with API keys configured).
 * @param {import('../db/settings.js').SettingsStore} settingsStore
 * @returns {Array<{id: string, name: string, configured: boolean}>}
 */
export function getAvailableProviders(settingsStore) {
  return Object.values(AI_PROVIDERS).map((p) => {
    const apiKey = settingsStore.get(`ai.${p.id}.apiKey`) || process.env[p.envKey];
    return {
      id: p.id,
      name: p.name,
      configured: !!apiKey,
      defaultModel: p.defaultModel,
    };
  });
}
