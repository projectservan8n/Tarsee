import { AI_PROVIDERS } from "../config/constants.js";
import { resolveProfile, setCooldown, trackUsage } from "../lib/auth-profiles.js";

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
 * Supports auth profile resolution with auto-rotation on failure.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages - Conversation messages
 * @param {string} opts.provider - Provider ID (anthropic, openai, gemini, openrouter, custom)
 * @param {string} opts.model - Model ID
 * @param {string} opts.apiKey - API key
 * @param {string} [opts.baseUrl] - Custom base URL (for custom provider)
 * @param {string} [opts.systemPrompt] - System prompt
 * @param {AbortSignal} [opts.signal] - Abort signal
 * @param {string} [opts.profileName] - Auth profile name (from @syntax)
 * @param {Array} [opts.tools] - Tool definitions for function calling
 * @returns {AsyncGenerator<{type: string, content?: string, usage?: object}>}
 */
export async function* chatStream(opts) {
  let { provider: providerId, model, apiKey, baseUrl, messages, systemPrompt, signal, profileName, tools } = opts;

  if (!providerId) throw new Error("No AI provider configured");

  // Try to resolve from auth profiles first
  const profile = resolveProfile(providerId, profileName);
  if (profile) {
    apiKey = profile.apiKey;
    if (profile.model && !model) model = profile.model;
    if (profile.baseUrl && !baseUrl) baseUrl = profile.baseUrl;
  }

  if (!apiKey) throw new Error(`No API key configured for ${providerId}`);

  const providerDef = AI_PROVIDERS[providerId];
  if (!providerDef && providerId !== "custom") {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const providerModule = await loadProvider(providerId);

  try {
    yield* providerModule.chat({
      messages,
      model: model || providerDef?.defaultModel || "",
      apiKey,
      baseUrl: baseUrl || providerDef?.baseUrl || "",
      systemPrompt,
      signal,
      tools,
    });

    // Track successful usage
    if (profile) trackUsage(profile.profileId);
  } catch (err) {
    // Put profile into cooldown on failure
    if (profile) {
      setCooldown(profile.profileId, err.message?.slice(0, 100));
    }
    throw err;
  }
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
