/**
 * provider-registry.js: every AI Tarsee can talk to, in one table.
 *
 * A provider is an account the owner chooses (the Claude plan, an Anthropic
 * API key, the ChatGPT plan, an OpenAI API key, OpenRouter, DeepSeek or a
 * Local AI server). An engine is the agent harness that runs a turn on it:
 * Claude Code or Codex. The owner only ever picks a provider and a model;
 * engineFor() below picks the engine.
 *
 * Every other part of the turn path reads this table: which providers exist
 * and which are switched on (shipped), which one is active, what a tier word
 * ("opus", "haiku") means on each provider, which engine runs a model, what a
 * model can take in (images, PDFs), how big its window is and what it costs.
 *
 * Rules this file keeps:
 *  - Hosts are code constants (baseUrl), one for every key provider on every
 *    engine it runs on, so no key is ever left to an engine's default host.
 *    Nothing here reads a host from a setting or an environment variable, so a
 *    stored key can only ever go to its own provider. Local AI is the one host
 *    the owner sets, and it lives in its own setting, never in this table. A
 *    turn reads its host through engine-env.js hostFor(), the one way to get
 *    one (it adds Local AI's address and the test-only seam).
 *  - A provider is chosen by a setting or TARSEE_AI_PROVIDER, never because
 *    some provider's key happens to be in the environment.
 *  - resolveModelFor() never hands a claude-* id to DeepSeek, ChatGPT, OpenAI
 *    or Local AI.
 *  - ChatGPT has no model list of its own here: the models a signed-in
 *    account may use are only known at runtime (setCatalogModels
 *    "chatgpt-models"). Until that list is in, no model is named and Codex
 *    picks its own default.
 *  - Only shipped providers can be selected. A provider is switched on in the
 *    phase that lands its engine path.
 *
 * Import cycle: config/constants.js re-exports AI_PROVIDERS from here, and
 * this file reads the Claude model table from there. So nothing at the top
 * level of this file may read a binding from constants.js: whichever of the
 * two is loaded first, the other has not run yet. Everything from
 * constants.js is read inside functions and getters only.
 */
import {
  CLAUDE_MODELS,
  CLAUDE_MODELS_BY_ID,
  MODEL_TIERS,
  BACKGROUND_DEFAULTS,
  getRecommendedModel,
  resolveModelAlias,
  tierOf,
} from "../config/constants.js";
import { EFFORT_IDS, parsePickerId } from "../lib/model-picker.js";

const CLAUDE_CODE = "claude-code";
const CODEX = "codex";

/** Extra words for the tiers, as /auto and crons may say them. */
const TIER_ALIASES = Object.freeze({ top: "opus", mid: "sonnet", small: "haiku" });

/** Providers that must never be handed a claude-* model id. */
const NO_CLAUDE_IDS = new Set(["deepseek", "chatgpt", "openai", "local"]);
const CLAUDE_ID_RE = /^claude-/i;

/** Catalogs whose models are only known at runtime (filled by setCatalogModels). */
const RUNTIME_CATALOGS = new Set(["openrouter", "openai-models", "chatgpt-models", "local-models"]);

// --- Prices ---
// USD per million tokens. OpenAI's are its list prices as OpenRouter passes them
// through (openrouter.ai/api/v1/models, read 2026-11-09; the base rate, before any
// long-prompt surcharge). DeepSeek's are its published peak rates (api-docs.deepseek.com,
// Models & Pricing, read 2026-11-09): cache-miss input is the cacheWrite rate, a cache
// hit the cacheRead one. A cost worked out from any of them is labelled "est.", and
// Phase 7 checks them against each provider's own dashboard.

/**
 * DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
 * The listed rates are the peak ones; any other time costs half.
 */
const DEEPSEEK_PEAK = { days: [1, 2, 3, 4, 5], hoursUtc: [[1, 4], [6, 10]], offPeakFactor: 0.5 };

const DEEPSEEK_EFFORTS = ["low", "high", "max"];

const DEEPSEEK_MODELS = [
  {
    id: "deepseek-flash", label: "DeepSeek Flash", vendor: "deepseek",
    context: 1_000_000, efforts: DEEPSEEK_EFFORTS, vision: true, pdf: false,
    price: { in: 0.3, out: 1.2, cacheRead: 0.006, cacheWrite: 0.3, peak: DEEPSEEK_PEAK },
  },
  {
    id: "deepseek-v4-pro", label: "DeepSeek Pro", vendor: "deepseek",
    context: 1_000_000, efforts: DEEPSEEK_EFFORTS, vision: false, pdf: false,
    price: { in: 1.32, out: 3.96, cacheRead: 0.044, cacheWrite: 1.32, peak: DEEPSEEK_PEAK },
  },
];

/**
 * The OpenAI API key's models. Once the key's own list is in
 * (setCatalogModels "openai-models", from GET /v1/models) only the rows it
 * lists are offered. Codex sends no PDF blocks.
 */
const OPENAI_MODELS = [
  {
    id: "gpt-6-astra", label: "GPT-6 Astra", vendor: "openai",
    context: 1_050_000, efforts: [...EFFORT_IDS], vision: true, pdf: false,
    price: { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  },
  {
    id: "gpt-6.1-sol", label: "GPT-6.1 Sol", vendor: "openai",
    context: 1_050_000, efforts: [...EFFORT_IDS], vision: true, pdf: false,
    price: { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  {
    id: "gpt-6-luna", label: "GPT-6 Luna", vendor: "openai",
    context: 1_050_000, efforts: [...EFFORT_IDS], vision: true, pdf: false,
    price: { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
  {
    id: "gpt-5.5", label: "GPT-5.5", vendor: "openai",
    context: 1_050_000, efforts: ["low", "medium", "high", "xhigh"], vision: true, pdf: false,
    price: { in: 5, out: 30, cacheRead: 0.5, cacheWrite: 5 },
  },
];

/** Claude's tier words stay tier words: the engine turns each into the newest model of the tier (lib/model-catalog.js). */
const CLAUDE_TIERS = { fable: "fable", opus: "opus", sonnet: "sonnet", haiku: "haiku" };

const OPENROUTER_OPUS = "~anthropic/claude-opus-latest";
const OPENROUTER_SONNET = "~anthropic/claude-sonnet-latest";
const OPENROUTER_HAIKU = "~anthropic/claude-haiku-latest";

// --- Keys pasted into the wrong slot ---
const CLAUDE_TOKEN = { re: /^sk-ant-oat/i, message: "This is a Claude sign-in token, not an API key. Create an API key in the Anthropic Console instead." };
const ANTHROPIC_KEY = { re: /^sk-ant-/i, message: "This is an Anthropic key. Paste it in the Anthropic API key card." };
const OPENROUTER_KEY = { re: /^sk-or-/i, message: "This is an OpenRouter key. Paste it in the OpenRouter card." };
// OpenAI's project, service-account and admin keys, and its legacy ones (48 characters with T3BlbkFJ in the middle).
const OPENAI_KEY = { re: /^sk-(proj|svcacct|admin)-|^sk-[a-z0-9]{20}t3blbkfj[a-z0-9]{20}$/i, message: "This is an OpenAI key. Paste it in the OpenAI API key card." };
// DeepSeek's keys are sk- and 32 lowercase hex characters, a shape no OpenAI key has (so no i flag). Some other
// OpenAI-compatible servers make keys of that shape too, hence "looks like".
const DEEPSEEK_KEY = { re: /^sk-[0-9a-f]{32}$/, message: "This looks like a DeepSeek key. Paste it in the DeepSeek card." };

/** The Claude model table (config/constants.js) as registry rows. Built on first use: see the import cycle note at the top. */
let _claudeModels = null;
function claudeModels() {
  if (!_claudeModels) {
    _claudeModels = deepFreeze(CLAUDE_MODELS.map((m) => ({
      id: m.id,
      label: m.displayName,
      vendor: "anthropic",
      tier: m.tier,
      alias: !!m.alias,
      context: contextFromLabel(m.context),
      efforts: [...EFFORT_IDS],
      vision: true,
      pdf: true,
      price: null,
    })));
  }
  return _claudeModels;
}

const PROVIDER_TABLE = {
  claude: {
    id: "claude",
    storageId: "claude-code",
    label: "Claude plan",
    // The name AI_PROVIDERS has always shown for it.
    legacyName: "Claude Code (Agent)",
    kind: "subscription",
    shipped: true,
    engines: [CLAUDE_CODE],
    // Signs in with `claude auth login` in the Terminal, or the CLAUDE_CODE_OAUTH_TOKEN
    // Railway variable from `claude setup-token`. It takes no API key.
    envKey: null,
    keyNoun: null,
    keyPattern: null,
    wrongSlot: [],
    keyHelpUrl: null,
    consoleUrl: "https://claude.ai/settings/usage",
    baseUrl: {},
    catalog: "claude",
    get models() { return claudeModels(); },
    tiers: CLAUDE_TIERS,
    get defaultModel() { return getRecommendedModel(); },
    get backgroundModel() { return BACKGROUND_DEFAULTS.MODEL; },
    defaultContext: 1_000_000,
    testProbe: { kind: "sign-in", check: "claude-credentials" },
    balanceProbe: null,
    // Only what happened: the card and the wizard put provider-status.js's fix (the command, then Check) after it.
    errorHints: { auth: "Claude's sign-in has expired." },
  },

  anthropic: {
    id: "anthropic",
    storageId: "anthropic",
    label: "Anthropic API key",
    kind: "key",
    shipped: true,
    engines: [CLAUDE_CODE],
    envKey: "ANTHROPIC_API_KEY",
    keyNoun: "an Anthropic API key",
    // Anthropic documents the sk-ant- prefix only (personal and service-account keys are the newer kinds); a Claude
    // sign-in token (sk-ant-oat…) is caught first, by wrongSlot.
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{16,}$/,
    wrongSlot: [CLAUDE_TOKEN, OPENROUTER_KEY, OPENAI_KEY],
    keyHelpUrl: "https://platform.claude.com/settings/keys",
    consoleUrl: "https://platform.claude.com/settings/billing",
    // Claude Code's own default host, named so nothing is left to a default.
    baseUrl: { [CLAUDE_CODE]: "https://api.anthropic.com" },
    catalog: "claude",
    get models() { return claudeModels(); },
    tiers: CLAUDE_TIERS,
    get defaultModel() { return getRecommendedModel(); },
    get backgroundModel() { return BACKGROUND_DEFAULTS.MODEL; },
    defaultContext: 1_000_000,
    testProbe: { method: "GET", url: "https://api.anthropic.com/v1/models", auth: "x-api-key" },
    balanceProbe: null,
    errorHints: {
      auth: "Your Anthropic key was rejected. Update it in Settings > AI or the Railway variable ANTHROPIC_API_KEY.",
      billing: "Your Anthropic credit has run out. Add credit in the Anthropic Console.",
      topUpUrl: "https://platform.claude.com/settings/billing",
    },
  },

  chatgpt: {
    id: "chatgpt",
    storageId: "chatgpt",
    label: "ChatGPT plan",
    kind: "subscription",
    shipped: true,
    engines: [CODEX],
    // Signs in with Codex's own device code (codex login --device-auth). It takes no API key.
    envKey: null,
    keyNoun: null,
    keyPattern: null,
    wrongSlot: [],
    keyHelpUrl: null,
    consoleUrl: "https://chatgpt.com/codex/settings/usage",
    baseUrl: {},
    // The account's own models, read at runtime. None are written here: a free
    // account and a paid one can use different models.
    catalog: "chatgpt-models",
    models: [],
    tiers: {},
    defaultModel: null,
    backgroundModel: null,
    defaultContext: 200_000,
    testProbe: { kind: "sign-in", check: "codex-login-status" },
    balanceProbe: null,
    // Only what happened: provider-status.js's fix (sign in again, or the Terminal's command) follows it on the card.
    errorHints: { auth: "The ChatGPT sign-in has expired." },
  },

  openai: {
    id: "openai",
    storageId: "openai",
    label: "OpenAI API key",
    kind: "key",
    shipped: true,
    engines: [CODEX],
    envKey: "OPENAI_API_KEY",
    keyNoun: "an OpenAI API key",
    keyPattern: /^sk-(?!ant-|or-)[A-Za-z0-9_-]{16,}$/,
    wrongSlot: [CLAUDE_TOKEN, ANTHROPIC_KEY, OPENROUTER_KEY, DEEPSEEK_KEY],
    keyHelpUrl: "https://platform.openai.com/api-keys",
    consoleUrl: "https://platform.openai.com/usage",
    // Passed to Codex explicitly, so a config.toml can't move it (design 4.8).
    baseUrl: { [CODEX]: "https://api.openai.com/v1" },
    catalog: "openai-models",
    models: OPENAI_MODELS,
    tiers: { fable: "gpt-6-astra", opus: "gpt-6-astra", sonnet: "gpt-6.1-sol", haiku: "gpt-6-luna" },
    defaultModel: "gpt-6.1-sol",
    backgroundModel: "gpt-6-luna",
    defaultContext: 400_000,
    testProbe: { method: "GET", url: "https://api.openai.com/v1/models", auth: "bearer" },
    balanceProbe: null,
    errorHints: {
      auth: "Your OpenAI key was rejected. Update it in Settings > AI or the Railway variable OPENAI_API_KEY.",
      billing: "Your OpenAI project is out of credit or over its budget. Check it at platform.openai.com.",
      topUpUrl: "https://platform.openai.com/settings/organization/billing/overview",
    },
  },

  openrouter: {
    id: "openrouter",
    storageId: "openrouter",
    label: "OpenRouter",
    kind: "key",
    shipped: true,
    // anthropic/* runs on Claude Code, openai/* on Codex, any other maker on
    // whichever engine passed verification (engineFor).
    engines: [CLAUDE_CODE, CODEX],
    envKey: "OPENROUTER_API_KEY",
    keyNoun: "an OpenRouter key",
    keyPattern: /^sk-or-v1-[A-Za-z0-9]{8,}$/,
    wrongSlot: [CLAUDE_TOKEN, ANTHROPIC_KEY, OPENAI_KEY],
    keyHelpUrl: "https://openrouter.ai/settings/keys",
    consoleUrl: "https://openrouter.ai/activity",
    baseUrl: { [CLAUDE_CODE]: "https://openrouter.ai/api", [CODEX]: "https://openrouter.ai/api/v1" },
    // The attribution title OpenRouter shows (ai.openrouter.appTitle overrides it).
    defaultAppTitle: "Tarsee",
    catalog: "openrouter",
    // The shipped verified results (models[].verified) land here from the Phase 7 sweep
    // (scripts/smoke-backends.mjs); the live list itself is the runtime catalog (lib/openrouter-catalog.js).
    models: [],
    // The picker's Recommended section: the default first, then the other tier models, then the shipped verified
    // ones. Anthropic's models run on Claude Code through OpenRouter's guaranteed /api/v1/messages, so these need no
    // verification first.
    recommended: [OPENROUTER_SONNET, OPENROUTER_OPUS, OPENROUTER_HAIKU],
    // The owner can edit these (ai.openrouter.tiers). Fable takes Opus's slug, as on the other metered providers.
    tiers: { fable: OPENROUTER_OPUS, opus: OPENROUTER_OPUS, sonnet: OPENROUTER_SONNET, haiku: OPENROUTER_HAIKU },
    defaultModel: OPENROUTER_SONNET,
    backgroundModel: OPENROUTER_HAIKU,
    defaultContext: 200_000,
    testProbe: { method: "GET", url: "https://openrouter.ai/api/v1/key", auth: "bearer" },
    balanceProbe: { method: "GET", url: "https://openrouter.ai/api/v1/key", auth: "bearer" },
    errorHints: {
      auth: "Your OpenRouter key was rejected. Update it in Settings > AI or the Railway variable OPENROUTER_API_KEY.",
      billing: "Your OpenRouter key has hit its spending limit. Raise it at openrouter.ai/settings/keys.",
      topUpUrl: "https://openrouter.ai/settings/keys",
    },
  },

  deepseek: {
    id: "deepseek",
    storageId: "deepseek",
    label: "DeepSeek",
    kind: "key",
    shipped: true,
    // Claude Code against DeepSeek's Anthropic endpoint (DeepSeek documents
    // it); Codex over its Responses API only when verification picked it.
    engines: [CLAUDE_CODE, CODEX],
    envKey: "DEEPSEEK_API_KEY",
    keyNoun: "a DeepSeek key",
    keyPattern: /^sk-[A-Za-z0-9]{16,}$/,
    wrongSlot: [CLAUDE_TOKEN, ANTHROPIC_KEY, OPENROUTER_KEY, OPENAI_KEY],
    keyHelpUrl: "https://platform.deepseek.com/api_keys",
    consoleUrl: "https://platform.deepseek.com/usage",
    baseUrl: { [CLAUDE_CODE]: "https://api.deepseek.com/anthropic", [CODEX]: "https://api.deepseek.com" },
    catalog: "static",
    models: DEEPSEEK_MODELS,
    tiers: { fable: "deepseek-v4-pro", opus: "deepseek-v4-pro", sonnet: "deepseek-flash", haiku: "deepseek-flash" },
    defaultModel: "deepseek-flash",
    backgroundModel: "deepseek-flash",
    defaultContext: 1_000_000,
    testProbe: { method: "GET", url: "https://api.deepseek.com/user/balance", auth: "bearer" },
    balanceProbe: { method: "GET", url: "https://api.deepseek.com/user/balance", auth: "bearer" },
    errorHints: {
      auth: "Your DeepSeek key was rejected. Update it in Settings > AI or the Railway variable DEEPSEEK_API_KEY.",
      billing: "Your DeepSeek balance is empty. Top up at platform.deepseek.com.",
      topUpUrl: "https://platform.deepseek.com/top_up",
    },
  },

  local: {
    id: "local",
    storageId: "local",
    label: "Local AI",
    kind: "local",
    shipped: true,
    engines: [CODEX],
    // Optional: only if the owner's server wants one.
    envKey: "TARSEE_LOCAL_AI_KEY",
    // The server's address: ai.local.baseUrl, else this variable. Never a constant here.
    urlEnv: "TARSEE_LOCAL_AI_URL",
    keyNoun: "a key",
    keyPattern: null,
    // A key for another provider must not be sent to a host the owner typed in.
    wrongSlot: [CLAUDE_TOKEN, ANTHROPIC_KEY, OPENROUTER_KEY, OPENAI_KEY, DEEPSEEK_KEY],
    keyHelpUrl: null,
    consoleUrl: null,
    baseUrl: {},
    catalog: "local-models",
    models: [],
    tiers: {},
    defaultModel: null,
    backgroundModel: null,
    // ai.local.context overrides it.
    defaultContext: 128_000,
    testProbe: { method: "GET", path: "/models", auth: "bearer-optional" },
    balanceProbe: null,
    errorHints: {
      auth: "Your Local AI turned down Tarsee's key. Check it in Settings > AI.",
      unreachable: "Can't reach your Local AI at {url}.",
    },
  },
};

/** Every provider, by public id. Frozen all the way down: nothing at runtime can change a host or a price. */
export const PROVIDERS = deepFreeze(PROVIDER_TABLE);

/** The public ids, as TARSEE_AI_PROVIDER, /model, the API and the UI use them. */
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

/** Other names accepted for a provider: the Claude plan's storage id. */
export const PROVIDER_ALIASES = Object.freeze({ "claude-code": "claude" });

/**
 * config/constants.js re-exports this as AI_PROVIDERS: the shipped providers,
 * keyed by the id their settings are stored under, in the shape that table has
 * always had (the Claude plan as "claude-code", exactly as before). A provider
 * joins it when it is shipped.
 */
export const AI_PROVIDERS = Object.freeze(Object.fromEntries(
  PROVIDER_IDS.filter((id) => PROVIDERS[id].shipped).map((id) => {
    const p = PROVIDERS[id];
    return [p.storageId, Object.freeze({
      id: p.storageId,
      name: p.legacyName || p.label,
      envKey: p.envKey,
      // A getter, so it tracks the recommended model (constants.js) as it always has.
      get defaultModel() { return p.defaultModel; },
      baseUrl: null,
      noKeyRequired: p.kind !== "key",
    })];
  }),
));

// --- Lookups ---

/** The public id for a provider id or alias ("claude-code" is the Claude plan), or null. */
export function normalizeProviderId(idOrAlias) {
  if (typeof idOrAlias !== "string") return null;
  const k = idOrAlias.trim().toLowerCase();
  if (!k) return null;
  if (Object.hasOwn(PROVIDERS, k)) return k;
  if (Object.hasOwn(PROVIDER_ALIASES, k)) return PROVIDER_ALIASES[k];
  return null;
}

/** A provider's entry by id or alias, shipped or not; null when there is none. */
export function getProvider(idOrAlias) {
  const id = normalizeProviderId(idOrAlias);
  return id ? PROVIDERS[id] : null;
}

/** Whether a provider is switched on: only these can be selected anywhere. */
export function isShipped(idOrAlias) {
  return !!getProvider(idOrAlias)?.shipped;
}

/** The switched-on providers, in table order. */
export function shippedProviders() {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]).filter((p) => p.shipped);
}

// --- Which provider, and the keys-only switch ---

/**
 * The provider a turn uses when nothing more specific is chosen: the
 * ai.activeProvider setting, then TARSEE_AI_PROVIDER, then the Claude plan.
 * The first of those that is set decides; when it names a provider that does
 * not exist or is not shipped, the answer is the Claude plan. A provider's key
 * being present in the environment never chooses it.
 *
 * `isShipped` is for tests (to prove the order once more providers ship).
 */
export function activeProviderId(store, { env = process.env, isShipped: shipped = isShipped } = {}) {
  const chosen = nonEmpty(readSetting(store, "ai.activeProvider")) ?? nonEmpty(env?.TARSEE_AI_PROVIDER);
  if (chosen == null) return "claude";
  const id = normalizeProviderId(chosen);
  return id && shipped(id) ? id : "claude";
}

/** Whether TARSEE_KEYS_ONLY=1 locks "API keys only" on. */
export function keysOnlyLocked(env = process.env) {
  return truthy(env?.TARSEE_KEYS_ONLY);
}

/** "API keys only": the ai.keysOnly setting, or locked on by TARSEE_KEYS_ONLY=1. */
export function keysOnly(store, { env = process.env } = {}) {
  return keysOnlyLocked(env) || truthy(readSetting(store, "ai.keysOnly"));
}

// --- Runtime catalogs ---

const runtimeCatalogs = new Map();
const EMPTY = Object.freeze([]);

/**
 * Fill a catalog whose models are only known at runtime: "chatgpt-models" (the
 * signed-in account's list), "openai-models" (what the key lists),
 * "openrouter" (OpenRouter's public list) or "local-models" (the server's
 * /models). An empty list empties it again. Each model is
 * { id, label?, vendor?, context?, efforts?, vision?, pdf?, price?, tier?, default?, free? },
 * prices in USD per million tokens.
 */
export function setCatalogModels(name, models) {
  if (!RUNTIME_CATALOGS.has(name)) throw new Error(`Not a runtime model catalog: ${name}`);
  const list = (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.id === "string" && m.id.trim())
    .map(runtimeEntry);
  runtimeCatalogs.set(name, Object.freeze(list.map(deepFreeze)));
}

/** A runtime catalog's models (empty until it is filled). */
export function catalogModels(name) {
  return runtimeCatalogs.get(name) || EMPTY;
}

/** The models a provider offers right now. */
export function modelsFor(idOrAlias) {
  const p = getProvider(idOrAlias);
  return p ? modelList(p) : EMPTY;
}

/**
 * The models verified on a provider: the shipped results, with the owner's own
 * (ai.<id>.verified, JSON { model: { engine, at, engineVersion, efforts?, checks? } })
 * on top. Entries naming an engine the provider does not have are dropped.
 */
export function verifiedModels(idOrAlias, store) {
  const p = getProvider(idOrAlias);
  if (!p) return {};
  const out = {};
  if (p.catalog !== "claude") {
    for (const m of p.models) if (m.verified) out[m.id] = m.verified;
  }
  const own = readJson(store, `ai.${p.id}.verified`);
  if (own && typeof own === "object" && !Array.isArray(own)) {
    for (const [id, v] of Object.entries(own)) {
      if (v && typeof v === "object" && p.engines.includes(v.engine)) out[id] = v;
    }
  }
  return out;
}

// --- Models ---

/**
 * The model id to run for a model or tier word on a provider.
 *  - Tier words (fable, opus, sonnet, haiku, and top, mid, small) map through
 *    the provider's tiers, stepping down to the next tier it has. Claude Code's
 *    "[1m]" suffix on one ("opus[1m]") doesn't change which tier it is.
 *  - A claude-* id on any other provider maps through its tier.
 *  - An id the provider does not offer falls back to its default.
 *  - The Claude providers behave as today: tier words stay tier words (with
 *    their "[1m]", which Claude Code reads), ids in Tarsee's table or Claude
 *    Code's catalog are kept, partial names resolve.
 *  - It never returns a claude-* id for deepseek, chatgpt, openai or local.
 * null means no model is named (the engine's own default), or no such provider.
 *
 * `store` (optional) brings in the owner's choices: Local AI's model and
 * context, OpenRouter's and Local AI's tier maps, and verified models.
 */
export function resolveModelFor(idOrAlias, modelOrTier, store = null) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  const raw = typeof modelOrTier === "string" ? modelOrTier.trim() : "";
  if (p.catalog === "claude") return resolveClaude(raw);

  let out;
  const tier = tierWord(stripContextSuffix(raw));
  if (!raw) out = defaultFor(p, store);
  else if (tier) out = resolveTier(p, tier, store);
  else if (CLAUDE_ID_RE.test(raw)) {
    const t = tierOf(raw);
    out = t && MODEL_TIERS.includes(t) ? resolveTier(p, t, store) : defaultFor(p, store);
  } else {
    const id = stripContextSuffix(raw);
    out = isAvailable(p, id, store) ? id : defaultFor(p, store);
  }
  if (out && NO_CLAUDE_IDS.has(p.id) && CLAUDE_ID_RE.test(out)) return null;
  return out || null;
}

/**
 * The engine that runs a model on a provider:
 *  - claude, anthropic: Claude Code.
 *  - chatgpt, openai, local: Codex.
 *  - deepseek: the engine it was verified on, else Claude Code.
 *  - openrouter: the engine it was verified on; else anthropic/* on Claude Code
 *    and openai/* on Codex; else null, meaning it must be verified first.
 */
export function engineFor(idOrAlias, model, store = null) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  if (p.engines.length === 1) return p.engines[0];
  const id = stripContextSuffix(typeof model === "string" ? model.trim() : "");
  const verified = id ? verifiedModels(p.id, store)[id] : null;
  if (verified) return verified.engine;
  if (p.id === "openrouter") {
    const maker = openRouterMaker(id);
    if (maker === "anthropic") return CLAUDE_CODE;
    if (maker === "openai") return CODEX;
    return null;
  }
  return p.engines[0];
}

/**
 * Who made a model: the slug's maker on OpenRouter (without the "~"), otherwise
 * the provider id; null for no such provider. Always a name a session handle can
 * carry (lower case letters, digits, ".", "-" and "_"): session-handle.js uses
 * this very function, so a session is tied to its maker by one rule.
 */
export function vendorFor(idOrAlias, model) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  if (p.id === "openrouter") {
    const maker = String(openRouterMaker(typeof model === "string" ? model.trim() : "") || "").replace(/[^a-z0-9._-]/g, "");
    return maker || p.id;
  }
  return p.id;
}

/**
 * A model's context window in tokens (the model's own; the caller applies the
 * auto-compact window). Claude reads today's table as the context meter does,
 * an unknown id counting as 1M. Local AI takes the card's ai.local.context.
 */
export function contextTokensFor(idOrAlias, model, store = null) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  if (p.catalog === "claude") {
    const meta = model ? CLAUDE_MODELS_BY_ID[model] : null;
    return contextFromLabel(meta?.context || "1M");
  }
  if (p.id === "local") {
    const own = positiveInt(readSetting(store, "ai.local.context"));
    if (own) return own;
  }
  return findModel(p, model)?.context || p.defaultContext;
}

/** The effort levels a model takes (Tarsee's ids, low to max); empty when none is sent. */
export function effortsFor(idOrAlias, model, store = null) {
  const p = getProvider(idOrAlias);
  if (!p) return [];
  if (p.catalog === "claude") return [...EFFORT_IDS];
  const id = stripContextSuffix(typeof model === "string" ? model.trim() : "");
  const verified = id ? verifiedModels(p.id, store)[id] : null;
  if (Array.isArray(verified?.efforts)) return verified.efforts.filter((e) => typeof e === "string");
  if (p.id === "openrouter") return openRouterMaker(id) === "anthropic" ? [...EFFORT_IDS] : [];
  const entry = findModel(p, id);
  if (Array.isArray(entry?.efforts)) return [...entry.efforts];
  if (p.id === "deepseek") return [...DEEPSEEK_EFFORTS];
  if (p.id === "chatgpt" || p.id === "openai") return [...EFFORT_IDS];
  return [];
}

/**
 * What a model on a provider can do: { vision, pdf, thinkingSummaries, nativeBudget, streaming }.
 *  - pdf: native PDF blocks, only on Claude Code with a Claude model (the
 *    Claude providers and OpenRouter anthropic/*). Elsewhere the text is
 *    extracted instead.
 *  - thinkingSummaries: the Claude providers, and Codex on OpenAI's own models.
 *  - nativeBudget: the engine enforces a dollar ceiling itself (the Claude providers).
 *  - streaming: replies arrive word by word (Claude Code), not a message at a time (Codex).
 */
export function capsFor(idOrAlias, model, store = null) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  if (p.catalog === "claude") return { vision: true, pdf: true, thinkingSummaries: true, nativeBudget: true, streaming: true };
  const id = stripContextSuffix(typeof model === "string" ? model.trim() : "");
  const engine = engineFor(p.id, id, store);
  const entry = findModel(p, id);
  const maker = p.id === "openrouter" ? openRouterMaker(id) : null;
  const visionDefault = p.id === "openrouter" ? (maker === "anthropic" || maker === "openai") : (p.id === "chatgpt" || p.id === "openai");
  return {
    vision: typeof entry?.vision === "boolean" ? entry.vision : visionDefault,
    pdf: engine === CLAUDE_CODE && (typeof entry?.pdf === "boolean" ? entry.pdf : maker === "anthropic"),
    thinkingSummaries: p.id === "chatgpt" || p.id === "openai",
    nativeBudget: false,
    streaming: engine === CLAUDE_CODE,
  };
}

/**
 * Whether a moment falls in DeepSeek's peak hours (01:00-04:00 and 06:00-10:00
 * UTC, Monday to Friday). A moment is a Date, milliseconds since 1970 (what
 * Date.now() and the stored timestamps hold) or an ISO string; null, undefined
 * or anything unreadable means now.
 */
export function isDeepSeekPeak(at = new Date()) {
  return inPeakWindow(DEEPSEEK_PEAK, at);
}

/**
 * A model's price at a moment, in USD per million tokens:
 * { in, out, cacheRead, cacheWrite, peak } where peak is true or false for a
 * provider with peak hours (DeepSeek: off-peak is half price) and null
 * otherwise. null when there is no per-token price: the plans ("Included in
 * plan"), the Anthropic key (the engine reports the exact cost), or a model
 * with no known price. Local AI is free unless the card sets ai.local.price.
 * `at` is read as isDeepSeekPeak() reads it: null (a turn still running) is now.
 */
export function priceFor(idOrAlias, model, at = new Date(), store = null) {
  const p = getProvider(idOrAlias);
  if (!p || p.kind === "subscription" || p.catalog === "claude") return null;
  if (p.id === "local") {
    const own = normalizePrice(readJson(store, "ai.local.price"));
    return { ...(own || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }), peak: null };
  }
  const price = findModel(p, model)?.price;
  if (!price) return null;
  const base = { in: price.in, out: price.out, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite };
  if (!price.peak) return { ...base, peak: null };
  const peak = inPeakWindow(price.peak, at);
  const f = peak ? 1 : price.peak.offPeakFactor;
  return { in: base.in * f, out: base.out * f, cacheRead: base.cacheRead * f, cacheWrite: base.cacheWrite * f, peak };
}

/**
 * Whether a pasted key fits a provider's slot: { ok, message }. Catches a
 * Claude sign-in token pasted as an API key and keys pasted into another
 * provider's card.
 */
export function checkKeySlot(idOrAlias, key) {
  const p = getProvider(idOrAlias);
  if (!p) return { ok: false, message: "Tarsee doesn't know that AI." };
  if (p.kind === "subscription") return { ok: false, message: `The ${p.label} signs in; it takes no API key.` };
  const k = typeof key === "string" ? key.trim().replace(/^["']|["']$/g, "") : "";
  if (!k) return { ok: false, message: "Paste a key first." };
  for (const w of p.wrongSlot) if (w.re.test(k)) return { ok: false, message: w.message };
  if (p.keyPattern && !p.keyPattern.test(k)) return { ok: false, message: `This doesn't look like ${p.keyNoun}.` };
  return { ok: true, message: null };
}

// --- Internals ---

function resolveClaude(raw) {
  if (!raw) return getRecommendedModel();
  // "opus[1m]" is a Claude Code alias of its own: the tier, kept with its suffix as today.
  const bare = stripContextSuffix(raw);
  const tier = tierWord(bare);
  if (tier) return (resolveModelAlias(tier) || tier) + (bare === raw ? "" : "[1m]");
  const known = resolveModelAlias(raw);
  if (known) return known;
  // A release Claude Code's catalog lists before Tarsee's table does.
  if (parsePickerId(raw)) return raw;
  return getRecommendedModel();
}

function tierWord(raw) {
  const w = String(raw || "").toLowerCase();
  if (Object.hasOwn(TIER_ALIASES, w)) return TIER_ALIASES[w];
  return MODEL_TIERS.includes(w) ? w : null;
}

/** The tiers from the asked one down, then up: a provider without the asked tier answers with the next one below. */
function stepOrder(tier) {
  const i = MODEL_TIERS.indexOf(tier);
  return [...MODEL_TIERS.slice(i), ...MODEL_TIERS.slice(0, i).reverse()];
}

function resolveTier(p, tier, store) {
  const own = ownerTiers(p, store);
  // Local AI: the owner's map for this tier, else the one chosen model for every tier.
  if (p.id === "local") return own[tier] || defaultFor(p, store);
  return pickTier(p, tier, store) || defaultFor(p, store);
}

function pickTier(p, tier, store) {
  const own = ownerTiers(p, store);
  const list = modelList(p);
  for (const t of stepOrder(tier)) {
    if (own[t]) return own[t];
    const shipped = p.tiers[t];
    if (shipped && isAvailable(p, shipped, store)) return shipped;
    const listed = list.find((m) => m.tier === t);
    if (listed) return listed.id;
  }
  return null;
}

/** The owner's own tier map (ai.<id>.tiers): OpenRouter and Local AI only. */
function ownerTiers(p, store) {
  if (p.id !== "openrouter" && p.id !== "local") return {};
  const own = readJson(store, `ai.${p.id}.tiers`);
  if (!own || typeof own !== "object" || Array.isArray(own)) return {};
  const out = {};
  for (const t of MODEL_TIERS) {
    const v = nonEmpty(own[t]);
    if (v && !(NO_CLAUDE_IDS.has(p.id) && CLAUDE_ID_RE.test(v))) out[t] = v;
  }
  return out;
}

function defaultFor(p, store) {
  if (p.catalog === "claude") return getRecommendedModel();
  if (p.id === "local") {
    const chosen = nonEmpty(readSetting(store, `ai.${p.storageId}.model`));
    if (chosen && !CLAUDE_ID_RE.test(chosen)) return chosen;
  }
  const d = p.defaultModel;
  if (d && isAvailable(p, d, store)) return d;
  const list = modelList(p);
  const flagged = list.find((m) => m.default);
  if (flagged) return flagged.id;
  // The default is not on offer (a key that can't use it): step down from its tier.
  const t = d ? MODEL_TIERS.find((x) => p.tiers[x] === d) : null;
  const stepped = t ? pickTier(p, t, store) : null;
  return stepped || list[0]?.id || null;
}

/** The models a provider offers now: its table, its runtime catalog, or the table narrowed to what the key lists. */
function modelList(p) {
  let list;
  if (p.catalog === "claude") return claudeModels();
  if (p.catalog === "static") list = p.models;
  else if (p.catalog === "openai-models") {
    const live = catalogModels("openai-models");
    if (live.length) {
      const ids = new Set(live.map((m) => m.id));
      list = p.models.filter((m) => ids.has(m.id));
    } else list = p.models;
  } else list = catalogModels(p.catalog);
  return NO_CLAUDE_IDS.has(p.id) ? list.filter((m) => !CLAUDE_ID_RE.test(m.id)) : list;
}

function findModel(p, model) {
  const id = stripContextSuffix(typeof model === "string" ? model.trim() : "");
  if (!id) return null;
  return modelList(p).find((m) => m.id === id) || null;
}

/** Whether a provider can be asked for this model id now. */
function isAvailable(p, id, store) {
  if (!id) return false;
  if (NO_CLAUDE_IDS.has(p.id) && CLAUDE_ID_RE.test(id)) return false;
  if (verifiedModels(p.id, store)[id]) return true;
  const list = modelList(p);
  if (list.some((m) => m.id === id)) return true;
  // Before OpenRouter's or the Local AI server's list is in, any id may be
  // asked for (the engine says if it is unknown). OpenRouter's "~" latest
  // slugs are never in its list.
  if (p.catalog === "openrouter") return !list.length || id.startsWith("~");
  if (p.catalog === "local-models") return !list.length;
  return false;
}

/** "~anthropic/claude-sonnet-latest" -> "anthropic"; null for an id without a maker. */
function openRouterMaker(slug) {
  const s = String(slug || "").replace(/^~/, "");
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i).toLowerCase() : null;
}

/** Claude Code's "[1m]" context suffix is the engine's business, not part of the model id. */
function stripContextSuffix(id) {
  return String(id || "").replace(/\[1m\]$/i, "");
}

/** "1M" / "200K" (the Claude table's context labels) in tokens; anything unreadable counts as 1M, as the context meter does. */
function contextFromLabel(c) {
  if (c === "200K") return 200_000;
  if (c === "1M") return 1_000_000;
  const m = String(c || "").match(/^(\d+)\s*(K|M)$/i);
  return m ? Number(m[1]) * (m[2].toUpperCase() === "M" ? 1_000_000 : 1_000) : 1_000_000;
}

function inPeakWindow(spec, at) {
  // new Date(null) is 1970-01-01, an off-peak Thursday: a missing moment is now, not that.
  let d = at == null ? new Date() : at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) d = new Date();
  if (!spec.days.includes(d.getUTCDay())) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return spec.hoursUtc.some(([from, to]) => mins >= from * 60 && mins < to * 60);
}

function runtimeEntry(m) {
  const id = m.id.trim();
  return {
    id,
    label: nonEmpty(m.label) || id,
    vendor: nonEmpty(m.vendor),
    context: positiveInt(m.context),
    efforts: Array.isArray(m.efforts) ? m.efforts.filter((e) => typeof e === "string") : null,
    vision: typeof m.vision === "boolean" ? m.vision : null,
    pdf: typeof m.pdf === "boolean" ? m.pdf : null,
    price: normalizePrice(m.price),
    tier: typeof m.tier === "string" && MODEL_TIERS.includes(m.tier) ? m.tier : null,
    default: m.default === true,
    free: m.free === true,
  };
}

/** { in, out, cacheRead?, cacheWrite? } with numbers; a missing cache rate counts as the input rate. */
function normalizePrice(p) {
  if (!p || typeof p !== "object") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null));
  const inRate = num(p.in);
  const outRate = num(p.out);
  if (inRate == null || outRate == null) return null;
  return { in: inRate, out: outRate, cacheRead: num(p.cacheRead) ?? inRate, cacheWrite: num(p.cacheWrite) ?? inRate };
}

function readSetting(store, key) {
  try { return store?.get?.(key) ?? null; } catch { return null; }
}

/** A setting that holds JSON: SettingsStore hands it back parsed, a plain string is parsed here. */
function readJson(store, key) {
  const v = readSetting(store, key);
  if (v == null || v === "") return null;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return typeof v === "object" ? v : null;
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function positiveInt(v) {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);
function truthy(v) {
  return v === true || v === 1 || (typeof v === "string" && TRUE_WORDS.has(v.trim().toLowerCase()));
}

/** Freeze an object and every plain value under it. Getters are left as getters; regular expressions are left alone. */
function deepFreeze(o) {
  if (o === null || typeof o !== "object" || o instanceof RegExp || Object.isFrozen(o)) return o;
  for (const d of Object.values(Object.getOwnPropertyDescriptors(o))) {
    if ("value" in d) deepFreeze(d.value);
  }
  return Object.freeze(o);
}
