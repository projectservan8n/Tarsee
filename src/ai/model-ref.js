/**
 * model-ref.js: a model on a provider, written as one string.
 *
 *   "deepseek:deepseek-flash"                 DeepSeek's Flash
 *   "openrouter:deepseek/deepseek-chat:free"  a free model on OpenRouter
 *   "local:llama3.1:8b"                       a model on the owner's Local AI
 *   "sonnet"                                  a bare model (the provider comes from elsewhere)
 *
 * OpenRouter and Ollama ids carry colons of their own, so a ref splits on the
 * FIRST colon only, and only when what is in front of it is a provider id or
 * alias the registry knows ("claude-code" is the Claude plan). Anything else
 * is a bare model, colons and all: "deepseek/x:free" and "llama3.1:8b" have
 * no provider.
 *
 * Used for the backup model (ai.backupModel), /model and the external API.
 */
import { normalizeProviderId } from "./provider-registry.js";

/**
 * "provider:model" as { provider, model }. provider is the public id, or null
 * for a bare model; model is null when a ref names only a provider
 * ("openrouter:" means that provider's default).
 */
export function parseModelRef(str) {
  const s = typeof str === "string" ? str.trim() : "";
  if (!s) return { provider: null, model: null };
  const i = s.indexOf(":");
  if (i > 0) {
    const provider = normalizeProviderId(s.slice(0, i));
    if (provider) return { provider, model: s.slice(i + 1).trim() || null };
  }
  return { provider: null, model: s };
}

/**
 * The ref for a provider and model, as parseModelRef reads it back:
 * formatModelRef("openrouter", "deepseek/x:free") or
 * formatModelRef({ provider, model }). No provider gives the bare model; no
 * model gives "provider:". A provider the registry does not know throws, and so
 * does a bare model that would read back as a provider's ("deepseek:7b", a
 * Local AI model's name, would mean DeepSeek's API): name its provider instead.
 */
export function formatModelRef(providerOrRef, model) {
  let provider = providerOrRef;
  if (providerOrRef && typeof providerOrRef === "object") ({ provider, model } = providerOrRef);
  const m = typeof model === "string" ? model.trim() : "";
  if (provider == null || provider === "") {
    if (parseModelRef(m).provider) throw new Error(`"${m}" would read back as a ${parseModelRef(m).provider} model: name its provider`);
    return m;
  }
  const id = normalizeProviderId(provider);
  if (!id) throw new Error(`Unknown provider: ${provider}`);
  return `${id}:${m}`;
}
