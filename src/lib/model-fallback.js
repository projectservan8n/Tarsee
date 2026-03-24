/**
 * Model fallback chain for Tarsee.
 * Automatically tries alternative providers when the primary fails.
 */

import { chatStream } from "../ai/router.js";

export class ModelFallbackChain {
  constructor(providers) {
    this.providers = providers; // [{provider, model, apiKey, baseUrl}]
    this.cooldowns = new Map(); // provider -> {until, reason}
  }

  async *execute({ messages, systemPrompt, tools, signal }) {
    const attempts = [];

    for (const p of this.providers) {
      // Skip cooled-down providers
      const cd = this.cooldowns.get(p.provider);
      if (cd && Date.now() < cd.until) {
        attempts.push({ provider: p.provider, error: `Cooled down: ${cd.reason}` });
        continue;
      }

      try {
        const stream = chatStream({
          provider: p.provider,
          model: p.model,
          apiKey: p.apiKey,
          baseUrl: p.baseUrl,
          messages,
          systemPrompt,
          signal,
          tools,
        });

        for await (const event of stream) {
          yield event;
        }
        return; // Success
      } catch (err) {
        const errorType = categorizeError(err);
        attempts.push({ provider: p.provider, error: err.message, type: errorType });

        // Apply cooldown based on error type
        switch (errorType) {
          case "auth":
            this.cooldowns.set(p.provider, { until: Date.now() + 300000, reason: "auth failure" }); // 5 min
            break;
          case "billing":
            this.cooldowns.set(p.provider, { until: Date.now() + 3600000, reason: "billing issue" }); // 1 hour
            break;
          case "rate_limit":
            this.cooldowns.set(p.provider, { until: Date.now() + 60000, reason: "rate limited" }); // 1 min
            break;
          case "server_error":
            this.cooldowns.set(p.provider, { until: Date.now() + 30000, reason: "server error" }); // 30 sec
            break;
          // timeout and content_filter: skip immediately, no cooldown
        }

        console.warn(`[fallback] ${p.provider} failed (${errorType}): ${err.message}. Trying next...`);
      }
    }

    // All providers failed
    throw new Error(`All providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join("; ")}`);
  }
}

function categorizeError(err) {
  const msg = err.message || "";
  const status = err.status || err.statusCode;
  if (status === 401 || status === 403 || msg.includes("unauthorized") || msg.includes("invalid api key")) return "auth";
  if (status === 402 || msg.includes("billing") || msg.includes("quota")) return "billing";
  if (status === 429 || msg.includes("rate limit")) return "rate_limit";
  if (status >= 500 || msg.includes("internal server") || msg.includes("502") || msg.includes("503")) return "server_error";
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) return "timeout";
  if (msg.includes("content filter") || msg.includes("safety")) return "content_filter";
  return "unknown";
}

export function buildFallbackChain(settingsStore) {
  const providers = [];
  const providerIds = ["anthropic", "openai", "gemini", "openrouter"];
  for (const id of providerIds) {
    const apiKey = settingsStore?.get?.(`ai.${id}.apiKey`) || process.env[`${id.toUpperCase()}_API_KEY`];
    if (apiKey) {
      const model = settingsStore?.get?.(`ai.${id}.model`);
      const baseUrl = settingsStore?.get?.(`ai.${id}.baseUrl`);
      providers.push({ provider: id, model, apiKey, baseUrl });
    }
  }
  return new ModelFallbackChain(providers);
}
