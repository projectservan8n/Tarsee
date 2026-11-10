/**
 * /api/ai: Settings > AI and the setup wizard's "Connect an AI" (design 4.14 and 5). Mounted behind requireAuth and
 * csrf in server.js.
 *
 *   GET    /providers            one card per provider: state, what to do, where its key lives ("…a1b2" only),
 *                                the balance (OpenRouter, DeepSeek; cached 10 minutes), models; the default AI;
 *                                the "API keys only" switch; banners
 *   PUT    /active               {provider, model?, backgroundModel?}: the default AI (only a ready one)
 *   PUT    /providers/:id        {model?, backgroundModel?, baseUrl?, context?, price? (Local AI), appTitle?,
 *                                referer? (OpenRouter), tiers? (OpenRouter, Local AI)}
 *   GET    /models/:id           the models a provider offers now (ChatGPT: the signed-in account's own list)
 *   PUT    /keys/:id             {apiKey}: checked (format, wrong slot), stored encrypted, never echoed
 *   DELETE /keys/:id             the saved key (a Railway variable then applies again)
 *   POST   /test/:id             {apiKey?}: a cheap live check (provider-probes.js); 6 a minute
 *   POST   /verify/:id           {model}: the 4-step check (verify-model.js), recorded on a pass; 3 a minute
 *   PUT    /keys-only            {on}: "API keys only" (locked on by TARSEE_KEYS_ONLY=1)
 *   POST   /chatgpt/login        start Codex's device-code sign-in: {state, url, code, expiresAt}; 5 a minute
 *   GET    /chatgpt/login        poll it: idle | waiting | done | failed | expired
 *   DELETE /chatgpt/login        cancel it
 *   POST   /chatgpt/logout       sign out of ChatGPT (removes Codex's auth.json)
 *
 * Nothing here ever answers with a key. Errors are {error, state?, fix?} in plain words.
 *
 * createAiRouter(deps) takes its outside world as deps (fetch, the Codex sign-in and model list, verifyModel, the
 * clock, the state folder, rate limits), so tests run it against stubs; aiRouter is the production instance.
 */
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import config from "../config/env.js";
import { SettingsStore } from "../db/settings.js";
import {
  PROVIDERS,
  PROVIDER_IDS,
  getProvider,
  isShipped as registryIsShipped,
  checkKeySlot,
  keysOnly,
  keysOnlyLocked,
  resolveModelFor,
  engineFor,
  modelsFor,
  setCatalogModels,
  setLocalModels,
  localContextTokens,
  verifiedModels,
  capsFor,
  effortsFor,
} from "../ai/provider-registry.js";
import { baseEnv, ensureHome } from "../ai/engine-env.js";
import {
  providerStatus,
  activeTarget,
  codexHomeFor,
  clearFailureFlag,
  clearBalance,
  localUrlFor,
  plainHttpUrl,
  chosenModel,
  savedKeyProviders,
  BALANCE_PROVIDERS,
} from "../ai/provider-status.js";
import { probeProvider, refreshBalance, cleanKey, listLocalModels, listOpenAIModels } from "../ai/provider-probes.js";
import { refreshProviderModels } from "../ai/provider-models.js";
import { estimateVerifyCost, needsRecheck } from "../ai/verify-model.js";
import { refreshOpenRouterCatalog } from "../lib/openrouter-catalog.js";
import { settingsGuardFindings, fixSettingsFile } from "../ai/settings-guard.js";
import { monthlySpend, spendCapUsd } from "../ai/spend.js";
import { modelChoices } from "../lib/model-catalog.js";
import { isEncryptionEnabled } from "../lib/vault.js";
import { redactSecrets } from "../lib/redact.js";
import { encryptionKeyOnVolume } from "../lib/security-audit.js";

/** Requests per minute, per address: Test is free but reaches a provider; Verify costs a few cents; sign-in starts Codex. */
export const AI_RATE_LIMITS = Object.freeze({
  test: { max: 6, windowMs: 60_000 },
  verify: { max: 3, windowMs: 60_000 },
  login: { max: 5, windowMs: 60_000 },
});

/** How long a ChatGPT device code lasts when Codex doesn't say. */
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

const BASE_URL_REFUSED = "A provider's address can't be set: each provider's host is fixed, so its key only ever goes there. Only Local AI takes an address.";

/** A model id with a space in it (llama-server names a model after its file path unless it is given --alias). */
const NOT_A_MODEL_NAME = "That isn't a model name: a model name has no spaces in it. For llama.cpp, start llama-server with --alias and a short name.";

/** Claude's model words and ids, as the Claude providers take them. */
const CLAUDE_MODEL_RE = /^(?:(?:fable|opus|sonnet|haiku|top|mid|small)(?:\[1m\])?|claude-[a-z0-9][a-z0-9.-]*(?:\[1m\])?)$/i;
const TIER_WORD_RE = /^(?:fable|opus|sonnet|haiku|top|mid|small)(?:\[1m\])?$/i;
const TIERS = ["fable", "opus", "sonnet", "haiku"];

const bare = (id) => String(id ?? "").trim().replace(/\[1m\]$/i, "");
const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** A line break or other control character: it would let a value become a second HTTP header. */
const hasControlChar = (s) => [...String(s)].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** An address to show: any user name and password in it removed (a Railway TARSEE_LOCAL_AI_URL may carry them). */
function displayUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.username && !u.password) return raw;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return String(raw).replace(/\/\/[^/@]*@/, "//");
  }
}

function unknownProvider(res, id) {
  return res.status(404).json({ error: `Tarsee doesn't know an AI called "${String(id ?? "").slice(0, 40)}".` });
}

/** A per-address sliding-window limiter, one bucket per kind of request. */
function makeLimiter(overrides = {}, now) {
  const hits = new Map();
  return (bucket) => (req, res, next) => {
    const { max, windowMs } = { ...AI_RATE_LIMITS[bucket], ...(overrides?.[bucket] || {}) };
    const t = now();
    const key = `${bucket}|${req.ip || req.socket?.remoteAddress || "?"}`;
    const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      const retry = Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000));
      res.set("Retry-After", String(retry));
      return res.status(429).json({ error: `Too many tries. Wait ${retry} seconds, then try again.` });
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] >= windowMs) hits.delete(k);
    return next();
  };
}

/** Short notes a provider's card carries (what it costs, terms, and how replies arrive). */
function notesFor(p) {
  const messageAtATime = "Replies appear a message at a time.";
  // Both engines keep the key out of the environment of the commands the agent runs, but those run as the same user,
  // so on Linux they can still read it from the engine's process (design A9, test/key-exposure-linux.test.js).
  const readable = "On a Linux server a command the agent runs can still read this key from the engine's process, so give the key a spending limit.";
  switch (p.id) {
    case "claude": return ["Uses your Claude subscription: no per-message cost. For your own use, under Anthropic's terms."];
    case "anthropic": return ["Billed per token by Anthropic.", readable];
    case "chatgpt": return [
      "Uses your ChatGPT subscription: no per-message cost. Codex's own sign-in, for your own use; device sign-in must be switched on in ChatGPT > Settings > Security.",
      messageAtATime,
    ];
    case "openai": return [
      "Billed per token; a project budget is recommended.",
      readable,
      "Also used for voice transcription only if you choose Whisper API in Voice.",
      messageAtATime,
    ];
    case "openrouter": return ["Hundreds of models with one key; free ones are marked Free.", "A credit limit on the key caps what it can spend.", readable];
    case "deepseek": return ["The cheapest per token; a small top-up is enough, and it is all DeepSeek can spend.", readable];
    case "local": return [
      "Free: runs on a machine you run (Ollama, LM Studio, llama.cpp or any Responses-compatible server). Small models may use tools poorly.",
      "On a Linux server a command the agent runs can still read this key, if your server uses one, from the engine's process, so use a key made only for Tarsee.",
      messageAtATime,
    ];
    default: return [];
  }
}

export function createAiRouter(deps = {}) {
  const router = Router();
  const now = () => (deps.now ? deps.now() : Date.now());
  const envOf = () => deps.env ?? process.env;
  const stateDir = () => deps.stateDir ?? config.STATE_DIR;
  const codexHome = () => deps.codexHome ?? codexHomeFor(stateDir());
  const fetchFn = () => deps.fetch ?? globalThis.fetch;
  const shipped = (id) => (deps.isShipped ? !!deps.isShipped(id) : registryIsShipped(id));
  const limit = makeLimiter(deps.rateLimits, now);

  let fallbackStore = null;
  const storeOf = (req) => req.app.get("settingsStore") || (fallbackStore ||= new SettingsStore(req.app.get("db"), req.app.get("auditLog")));
  const statusDeps = (store) => ({
    store,
    env: envOf(),
    stateDir: stateDir(),
    codexHome: codexHome(),
    claudeHomes: deps.claudeHomes,
    loginStatus: deps.loginStatus,
    now,
    isShipped: deps.isShipped,
  });
  const audit = (req, entry) => {
    try { req.app.get("auditLog")?.log({ actor: "user", ip: req.ip, ...entry }); } catch { /* never fails a request */ }
  };

  /** The provider in :id, or a 404 already sent (null). */
  const providerOf = (req, res) => {
    const p = getProvider(req.params.id);
    if (!p) { unknownProvider(res, req.params.id); return null; }
    return p;
  };
  /** False (with a 400 sent) for a provider this version doesn't switch on. */
  const requireShipped = (p, res) => {
    if (shipped(p.id)) return true;
    res.status(400).json({ error: `${p.label} isn't available in this version of Tarsee.` });
    return false;
  };

  /** The environment Codex gets for a sign-in or model-list call: no credential, no Tarsee secret, its own home. */
  const codexChildEnv = () => ({ ...baseEnv(envOf()), CODEX_HOME: codexHome() });

  async function loadDeviceLogin() {
    if (deps.startDeviceLogin) return { startDeviceLogin: deps.startDeviceLogin, logout: deps.logout };
    return import("../ai/codex-device-login.js");
  }

  /**
   * Ask Codex for the signed-in ChatGPT account's own models and make them the ChatGPT plan's catalog: {models,
   * reason?}. An empty list (it couldn't be read as the account's own) empties the catalog, so no model is named
   * and Codex uses the account's default; nothing is ever hard-coded for ChatGPT. While "API keys only" is on it
   * reads nothing and leaves the catalog as it is ({models: [], reason: "keys-only"}): reading the list starts Codex
   * in the plan's home, which sends the plan's sign-in to ChatGPT's backend (lib/model-catalog.js has the same rule).
   */
  async function fillChatgptModels(store) {
    if (keysOnly(store, { env: envOf() })) return { models: [], reason: "keys-only" };
    const opts = { codexHome: codexHome(), env: codexChildEnv() };
    let models;
    let reason = null;
    if (deps.listAccountModels) {
      models = await deps.listAccountModels(opts);
    } else {
      const mod = await import("../ai/codex-models.js");
      const r = await mod.readAccountModels(opts);
      models = r.models;
      reason = r.reason ?? null;
    }
    const list = Array.isArray(models) ? models.filter((m) => m && typeof m.id === "string") : [];
    setCatalogModels("chatgpt-models", list.map((m) => ({
      id: m.id, label: m.label, efforts: m.efforts, default: m.default === true, context: m.context, vision: m.vision,
    })));
    return { models: list, reason };
  }

  /**
   * Check a model for a provider: {ok, model} (null clears the choice, undefined leaves it), or {ok:false, status,
   * error, state?}. Claude takes its words and ids; Local AI any id its server may have; every other provider only
   * ids it offers, and OpenRouter's only once verified (or by a maker Tarsee runs without verification).
   */
  async function checkModel(p, raw, store) {
    if (raw === undefined) return { ok: true, model: undefined };
    if (raw === null || (typeof raw === "string" && !raw.trim())) return { ok: true, model: null };
    if (typeof raw !== "string" || raw.trim().length > 200 || /[\s\0]/.test(raw.trim())) {
      return { ok: false, status: 400, error: NOT_A_MODEL_NAME };
    }
    const m = raw.trim();
    if (p.catalog === "claude") {
      if (CLAUDE_MODEL_RE.test(m)) return { ok: true, model: m };
      return { ok: false, status: 400, error: `${m} isn't a Claude model. Use opus, sonnet, haiku or fable, or a claude- model id.` };
    }
    if (p.id === "local") {
      if (/^claude-/i.test(m)) return { ok: false, status: 400, error: "Local AI runs your own server's models, not Claude." };
      return { ok: true, model: m };
    }
    if (p.id === "chatgpt") {
      // Its models are only known from the account's own list, which "API keys only" never reads (fillChatgptModels),
      // and the plan isn't used then anyway: said plainly, as PUT /active does, not as "isn't on your list".
      if (keysOnly(store, { env: envOf() })) {
        return { ok: false, status: 409, state: "blocked-keys-only", error: "\"API keys only\" is on, so the ChatGPT plan isn't used. Turn it off in Settings > AI first." };
      }
      if (!modelsFor("chatgpt").length) {
        try { await fillChatgptModels(store); } catch { /* the check below says it isn't listed */ }
      }
    }
    const resolved = resolveModelFor(p.id, m, store);
    if (!resolved || (!TIER_WORD_RE.test(m) && bare(resolved) !== bare(m))) {
      const where = p.id === "chatgpt" ? "isn't on your ChatGPT account's list" : `isn't one of ${p.label}'s models`;
      return { ok: false, status: 400, error: `${m} ${where}.` };
    }
    if (!engineFor(p.id, resolved, store)) {
      return { ok: false, status: 409, state: "needs-verification", error: `${m} hasn't been verified yet. Verify it in Settings > AI first.` };
    }
    return { ok: true, model: m };
  }

  function setOrDelete(store, key, value) {
    if (value === undefined) return;
    if (value === null) store.delete(key);
    else store.set(key, value);
  }

  /**
   * What a card shows for a provider's own settings. Local AI's context is two things kept apart: context, the size the
   * owner saved (null when they saved none), and serverContext, the size the server said it gives the card's model
   * (or, from llama-server, every model), read when its models were last read; contextUsed is what a turn uses
   * (provider-registry.js localContextTokens: the smaller of the two, else either, else defaultContext).
   */
  function settingsFor(p, store) {
    if (p.id === "local") {
      const own = Number(store.get("ai.local.context")) || null;
      const rows = modelsFor("local");
      const chosen = chosenModel("local", store, envOf());
      const row = rows.find((m) => m.id === chosen) || (rows.length === 1 ? rows[0] : null);
      const sizes = [...new Set(rows.map((m) => m.serverContext).filter(Boolean))];
      const serverContext = row?.serverContext || (!row && sizes.length === 1 && rows.every((m) => m.serverContext) ? sizes[0] : null);
      return {
        baseUrl: displayUrl(localUrlFor(store, envOf())),
        context: own,
        serverContext: serverContext || null,
        contextUsed: localContextTokens({ own, serverContext, maxContext: row?.maxContext }),
        defaultContext: p.defaultContext,
        price: store.get("ai.local.price") || null,
        tiers: store.get("ai.local.tiers") || null,
      };
    }
    if (p.id === "openrouter") {
      return {
        appTitle: nonEmpty(store.get("ai.openrouter.appTitle")) || p.defaultAppTitle,
        referer: nonEmpty(store.get("ai.openrouter.referer")),
        tiers: store.get("ai.openrouter.tiers") || null,
      };
    }
    return null;
  }

  async function cardFor(p, store, active) {
    const s = await providerStatus(p.id, statusDeps(store));
    const env = envOf();
    const model = resolveModelFor(p.id, chosenModel(p.id, store, env), store);
    const background = resolveModelFor(p.id, nonEmpty(store.get(`ai.${p.storageId}.backgroundModel`)) || p.backgroundModel, store);
    const caps = model ? capsFor(p.id, model, store) : null;
    return {
      id: p.id,
      // The id its settings are stored under (the Claude plan's is claude-code), for the page's own reads.
      storageId: p.storageId,
      label: p.label,
      kind: p.kind,
      shipped: shipped(p.id),
      active: active.provider === p.id,
      state: s.state,
      ready: s.ready,
      detail: s.detail,
      fix: s.fix,
      keySource: s.keySource,
      keyHint: s.keyHint,
      keySourceText: s.keySourceText,
      account: s.account,
      balance: s.balance,
      envKey: p.envKey,
      keyHelpUrl: p.keyHelpUrl,
      consoleUrl: p.consoleUrl,
      model,
      backgroundModel: background,
      streaming: caps ? caps.streaming : p.engines.includes("claude-code"),
      notes: notesFor(p),
      settings: settingsFor(p, store),
    };
  }

  /** Where the settings-file guards look (deps.settingsGuard lets a test point them at its own folders). */
  const guardOpts = () => ({ stateDir: stateDir(), isShipped: deps.isShipped, ...(deps.settingsGuard || {}) });

  /** "A, B and C". */
  const listWords = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] || "");

  function banners(store, active) {
    const env = envOf();
    const out = [];
    // A settings file the engines refuse to start a turn with (design 4.5 R5): which file, which entries, which AIs.
    let findings = [];
    try { findings = settingsGuardFindings(guardOpts()); } catch (err) { console.warn("[ai] checking the settings files failed:", err?.message || err); }
    findings.forEach((g, i) => {
      const who = listWords(g.labels);
      out.push({
        id: `settings-guard-${i + 1}`,
        level: "error",
        message: g.dotenv
          ? `${g.file} is loaded by Codex into its own environment (a proxy or certificate there could read the AI's key and traffic), so Tarsee won't run ${who} turns until it is set aside.`
          : g.unreadable
          ? `${g.file} can't be read safely, so Tarsee won't run ${who} turns until it is fixed or set aside.`
          : `${g.file} has settings that could send an AI key or its requests somewhere else (${g.entries.join(", ")}), so Tarsee won't run ${who} turns until they're removed.`,
        action: { label: g.unreadable ? "Set this file aside" : "Remove these entries", kind: "settings-guard", file: g.file },
      });
    });
    if (active.provider === "claude" && nonEmpty(env.ANTHROPIC_API_KEY)) {
      out.push({
        id: "anthropic-key-ignored",
        level: "info",
        message: "ANTHROPIC_API_KEY is set as a Railway variable, but your default AI is the Claude plan, so that key isn't used.",
        action: { label: "Use the Anthropic API key instead", provider: "anthropic" },
      });
    }
    const saved = savedKeyProviders(store);
    if (saved.length && !isEncryptionEnabled()) {
      out.push({ id: "keys-not-encrypted", level: "warning", message: "Your saved AI keys aren't encrypted. Set ENCRYPTION_KEY as a Railway variable, then save the keys again." });
    } else if (saved.length && encryptionKeyOnVolume({ stateDir: stateDir(), env })) {
      out.push({
        id: "encryption-key-on-volume",
        level: "warning",
        message: "Your saved AI keys are encrypted with a key kept on the same volume. Add ENCRYPTION_KEY as a Railway variable (the same value as the .encryption-key file, so saved keys still open), then delete that file.",
      });
    }
    return out;
  }

  // --- Cards ----------------------------------------------------------------------------------------------------

  router.get("/providers", async (req, res) => {
    const store = storeOf(req);
    const env = envOf();
    const force = req.query.refresh === "1" || req.query.refresh === "true";
    await Promise.all(BALANCE_PROVIDERS.map((id) => refreshBalance(id, { store, fetch: fetchFn(), now, force }).catch(() => null)));
    const active = activeTarget(store, { env, isShipped: deps.isShipped });
    const providers = await Promise.all(PROVIDER_IDS.map((id) => cardFor(PROVIDERS[id], store, active)));
    const activeCard = providers.find((c) => c.id === active.provider);
    res.json({
      active: {
        ...active,
        state: activeCard.state,
        ready: activeCard.ready,
        detail: activeCard.detail,
        fix: activeCard.fix,
        streaming: activeCard.streaming,
      },
      keysOnly: { on: keysOnly(store, { env }), locked: keysOnlyLocked(env) },
      providers,
      banners: banners(store, active),
      spend: spendNow(req, store),
    });
  });

  /**
   * This month's spend on API-key AIs (plans aren't counted) and the optional cap: { monthUsd, costNote, capUsd,
   * timeZone }. costNote is "exact" when every counted figure is the provider's own, else "est" (Settings shows "(est.)").
   */
  function spendNow(req, store) {
    let monthUsd = null;
    let costNote = null;
    let timeZone = null;
    try {
      const m = monthlySpend(req.app.get("db") || store.db, { now: now() });
      monthUsd = m.totalUsd;
      costNote = m.estimated ? "est" : "exact";
      timeZone = m.timeZone || null;
    } catch (err) {
      console.warn("[ai] this month's spend couldn't be read:", err?.message || err);
    }
    return { monthUsd, costNote, capUsd: spendCapUsd(store), timeZone };
  }

  // The one-click fix for a settings file the guards refuse: only a file they refuse right now is ever touched.
  router.post("/settings-guard/fix", (req, res) => {
    const r = fixSettingsFile(req.body?.file, guardOpts());
    if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
    audit(req, { action: "ai.settings_guard_fix", target: r.file, detail: r.setAside ? `set aside as ${r.setAside}` : r.removed.join(", ") });
    return res.json({ ok: true, file: r.file, removed: r.removed, setAside: r.setAside || null });
  });

  // --- The default AI -------------------------------------------------------------------------------------------

  router.put("/active", async (req, res) => {
    const store = storeOf(req);
    const body = req.body || {};
    const p = getProvider(body.provider);
    if (!p) return unknownProvider(res, body.provider);
    if (!requireShipped(p, res)) return undefined;
    const status = await providerStatus(p.id, statusDeps(store));
    if (!status.ready) {
      return res.status(409).json({ error: `${p.label} isn't ready: ${status.detail}`, state: status.state, fix: status.fix });
    }
    const model = await checkModel(p, body.model, store);
    if (!model.ok) return res.status(model.status).json({ error: model.error, state: model.state });
    const background = await checkModel(p, body.backgroundModel, store);
    if (!background.ok) return res.status(background.status).json({ error: background.error, state: background.state });

    store.set("ai.activeProvider", p.storageId);
    setOrDelete(store, `ai.${p.storageId}.model`, model.model);
    setOrDelete(store, `ai.${p.storageId}.backgroundModel`, background.model);
    audit(req, { action: "ai.default", target: p.id, detail: model.model ? `model ${model.model}` : null });
    const target = activeTarget(store, { env: envOf(), isShipped: deps.isShipped });
    res.json({ ok: true, provider: p.id, model: target.model, status });
  });

  router.put("/providers/:id", async (req, res) => {
    const p = providerOf(req, res);
    if (!p || !requireShipped(p, res)) return undefined;
    const store = storeOf(req);
    const body = req.body || {};
    const writes = [];

    if ("baseUrl" in body && p.id !== "local") return res.status(400).json({ error: BASE_URL_REFUSED });
    for (const [field, setting] of [["model", "model"], ["backgroundModel", "backgroundModel"]]) {
      const m = await checkModel(p, body[field], store);
      if (!m.ok) return res.status(m.status).json({ error: m.error, state: m.state });
      if (m.model !== undefined) writes.push([`ai.${p.storageId}.${setting}`, m.model]);
    }

    if (p.id === "local") {
      if ("baseUrl" in body) {
        const v = body.baseUrl;
        if (v === null || v === "") writes.push(["ai.local.baseUrl", null]);
        else if (typeof v !== "string" || v.length > 500 || !plainHttpUrl(v)) {
          return res.status(400).json({ error: "Local AI's address must start with http:// or https:// and have no password in it (for example http://localhost:11434/v1 for Ollama, or http://localhost:9931/v1 for llama.cpp)." });
        } else writes.push(["ai.local.baseUrl", v.trim()]);
      }
      if ("context" in body) {
        const v = body.context;
        const n = typeof v === "string" ? Number(v.trim()) : v;
        if (v === null || v === "") writes.push(["ai.local.context", null]);
        else if (!Number.isInteger(n) || n < 1000 || n > 10_000_000) {
          return res.status(400).json({ error: "The context size is a number of tokens between 1,000 and 10,000,000 (for example 32768)." });
        } else writes.push(["ai.local.context", n]);
      }
      if ("price" in body) {
        const v = body.price;
        const ok = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x < 10_000;
        if (v === null) writes.push(["ai.local.price", null]);
        else if (!v || typeof v !== "object" || !ok(v.in) || !ok(v.out)) {
          return res.status(400).json({ error: "A custom price is {in, out} in US dollars per million tokens." });
        } else writes.push(["ai.local.price", { in: v.in, out: v.out }]);
      }
    } else if ("context" in body || "price" in body) {
      return res.status(400).json({ error: "Only Local AI takes a context size or a custom price." });
    }

    if (p.id === "openrouter") {
      if ("appTitle" in body) {
        const v = body.appTitle;
        if (v === null || v === "") writes.push(["ai.openrouter.appTitle", null]);
        else if (typeof v !== "string" || v.trim().length > 60 || hasControlChar(v)) {
          return res.status(400).json({ error: "The name OpenRouter shows is one short line (60 characters at most)." });
        } else writes.push(["ai.openrouter.appTitle", v.trim()]);
      }
      if ("referer" in body) {
        const v = body.referer;
        if (v === null || v === "") writes.push(["ai.openrouter.referer", null]);
        else if (typeof v !== "string" || v.length > 300 || !plainHttpUrl(v) || hasControlChar(v)) {
          return res.status(400).json({ error: "The site address OpenRouter shows must be an http:// or https:// address." });
        } else writes.push(["ai.openrouter.referer", v.trim()]);
      }
    } else if ("appTitle" in body || "referer" in body) {
      return res.status(400).json({ error: "Only OpenRouter takes a name and site address to show." });
    }

    if ("tiers" in body) {
      if (p.id !== "openrouter" && p.id !== "local") return res.status(400).json({ error: `${p.label}'s model sizes are fixed.` });
      const v = body.tiers;
      if (v === null) writes.push([`ai.${p.id}.tiers`, null]);
      else if (!v || typeof v !== "object" || Array.isArray(v)) return res.status(400).json({ error: "Model sizes are {fable, opus, sonnet, haiku}, each a model id." });
      else {
        const tiers = {};
        for (const t of TIERS) {
          const id = v[t];
          if (id === undefined || id === null || id === "") continue;
          if (typeof id !== "string" || id.trim().length > 200 || /[\s\0]/.test(id.trim()) || (p.id === "local" && /^claude-/i.test(id.trim()))) {
            return res.status(400).json({ error: `The ${t} model isn't a model id (a model id has no spaces in it; for llama.cpp, start llama-server with --alias and a short name).` });
          }
          tiers[t] = id.trim();
        }
        writes.push([`ai.${p.id}.tiers`, tiers]);
      }
    }

    const urlChanged = writes.some(([k]) => k === "ai.local.baseUrl");
    for (const [key, value] of writes) setOrDelete(store, key, value);
    if (urlChanged) setCatalogModels("local-models", []);
    else if (writes.some(([k]) => k === "ai.local.context")) {
      // The models' context follows the new setting at once (each keeps what its server said).
      setLocalModels(modelsFor("local").map((m) => ({ id: m.id, label: m.label, serverContext: m.serverContext, maxContext: m.maxContext })), store);
    }
    if (writes.length) audit(req, { action: "ai.provider_settings", target: p.id, detail: writes.map(([k]) => k).join(", ") });
    const active = activeTarget(store, { env: envOf(), isShipped: deps.isShipped });
    res.json({ ok: true, card: await cardFor(p, store, active) });
  });

  router.get("/models/:id", async (req, res) => {
    const p = providerOf(req, res);
    if (!p) return undefined;
    const store = storeOf(req);
    const env = envOf();
    let note = null;
    let confirmed = null;
    if (p.id === "chatgpt") {
      const s = await providerStatus("chatgpt", statusDeps(store));
      if (!s.ready) return res.status(409).json({ error: s.detail, state: s.state, fix: s.fix });
      try {
        const r = await fillChatgptModels(store);
        if (!r.models.length) note = "Your ChatGPT account's model list couldn't be read, so Tarsee names no model and Codex uses your account's default model.";
      } catch (err) {
        return res.status(502).json({ error: `Tarsee couldn't read your ChatGPT account's models: ${redactSecrets(err?.message || String(err))}` });
      }
    } else if (p.id === "local") {
      const url = localUrlFor(store, env);
      if (url && plainHttpUrl(url)) {
        const r = await listLocalModels({ url, key: store.getKeyWithSource("local").key, fetch: fetchFn() });
        // Each row keeps the size the server gives it (serverContext) beside the one a turn uses (context).
        if (r.ok && r.rows.length) setLocalModels(r.rows.filter((m) => !/\s/.test(m.id)), store);
        if (r.ok && r.hidden?.length) {
          const one = r.hidden.length === 1;
          note = `${one ? "One embedding model isn't" : `${r.hidden.length} embedding models aren't`} listed (${r.hidden.slice(0, 3).join(", ")}): ${one ? "it" : "they"} can't chat.`;
        }
      }
    } else if (p.id === "openai") {
      const { key } = store.getKeyWithSource("openai");
      if (key && checkKeySlot("openai", key).ok) {
        const r = await listOpenAIModels({ key, fetch: fetchFn() });
        if (r.ok && r.models.length) setCatalogModels("openai-models", r.models.map((id) => ({ id })));
      }
    } else if (p.id === "openrouter") {
      // OpenRouter's public list (no key is sent): the cached copy while it is under 6 hours old, so the list refills
      // here even if the boot fetch failed.
      await refreshOpenRouterCatalog(store, { fetch: fetchFn() });
    } else if (p.id === "deepseek") {
      // DeepSeek's models are a table in code; with a key, DeepSeek's own list confirms it.
      const { key } = store.getKeyWithSource("deepseek");
      if (key && checkKeySlot("deepseek", key).ok) {
        const r = await refreshProviderModels("deepseek", { store, key, env, fetch: fetchFn() });
        if (r.ok) {
          confirmed = new Map(r.models.map((m) => [m.id, m.confirmed]));
          const missing = r.models.filter((m) => !m.confirmed).map((m) => m.label || m.id);
          const words = [];
          if (missing.length) words.push(`DeepSeek doesn't list ${missing.join(" or ")} for this key right now.`);
          if (r.extra?.length) words.push(`DeepSeek also offers ${r.extra.slice(0, 5).join(", ")}, which this version of Tarsee doesn't list yet.`);
          note = words.join(" ") || null;
        }
      }
    }
    const verified = verifiedModels(p.id, store);
    // Whether a chat's model menu and /model take each model (lib/model-catalog.js, the one rule): Local AI's chosen
    // model and its verified ones, OpenRouter's once verified or by a maker Tarsee runs as it is. The card's own list
    // (needsVerification) keeps every model the provider has, so a new default can still be chosen there.
    const menu = new Map(modelChoices(p.id, store, { env }).map((c) => [c.id, c.selectable]));
    // The OpenAI key: a newer model its table lacks, once the owner verified it (the card's model id box), is one of
    // its models too, so it can be the card's default.
    const own = p.id === "openai"
      ? Object.keys(verified).filter((id) => !p.models.some((m) => m.id === id)).map((id) => ({ id, label: id }))
      : [];
    const models = [...modelsFor(p.id), ...own].map((m) => ({
      id: m.id,
      label: m.label || m.id,
      context: m.context ?? null,
      ...(p.id === "local" ? { serverContext: m.serverContext ?? null } : {}),
      vision: m.vision ?? null,
      efforts: effortsFor(p.id, m.id, store),
      free: m.free === true,
      price: m.price ?? null,
      verified: !!verified[m.id],
      needsVerification: !engineFor(p.id, m.id, store),
      inMenu: menu.has(m.id) ? menu.get(m.id) : !!engineFor(p.id, m.id, store),
      // What a Verify run would cost, shown before it starts (Local AI's models are checked too), and whether a
      // model verified on an older version of its engine should be checked again.
      verifyCost: !engineFor(p.id, m.id, store) || p.id === "local" ? estimateVerifyCost(p.id, m.id, { store }).label : null,
      recheck: !!verified[m.id] && needsRecheck(verified[m.id]),
      confirmed: confirmed ? (confirmed.get(m.id) ?? null) : null,
    }));
    res.json({
      provider: p.id,
      models,
      defaultModel: resolveModelFor(p.id, chosenModel(p.id, store, env), store),
      backgroundModel: resolveModelFor(p.id, nonEmpty(store.get(`ai.${p.storageId}.backgroundModel`)) || p.backgroundModel, store),
      note,
    });
  });

  // --- Keys -----------------------------------------------------------------------------------------------------

  router.put("/keys/:id", async (req, res) => {
    const p = providerOf(req, res);
    if (!p || !requireShipped(p, res)) return undefined;
    const store = storeOf(req);
    const raw = req.body?.apiKey ?? req.body?.key;
    if (raw !== undefined && raw !== null && typeof raw !== "string") return res.status(400).json({ error: "The key must be text." });
    const key = cleanKey(raw);
    if (p.kind !== "subscription") {
      if (!key) return res.status(400).json({ error: "Paste a key first." });
      if (key.length > 512) return res.status(400).json({ error: "That is too long to be an API key." });
      if (/\s|\0/.test(key)) return res.status(400).json({ error: "This key has a line break or a space in it. Copy it again and paste it whole." });
    }
    const slot = checkKeySlot(p.id, key);
    if (!slot.ok) return res.status(400).json({ error: slot.message });

    store.set(`ai.${p.storageId}.apiKey`, key, { actor: "user", ip: req.ip });
    clearFailureFlag(store, p.id);
    clearBalance(store, p.id);
    if (p.id === "openai") setCatalogModels("openai-models", []);
    const status = await providerStatus(p.id, statusDeps(store));
    res.json({ ok: true, id: p.id, keySource: status.keySource, keyHint: status.keyHint, keySourceText: status.keySourceText, encrypted: isEncryptionEnabled(), status });
  });

  router.delete("/keys/:id", async (req, res) => {
    const p = providerOf(req, res);
    if (!p) return undefined;
    const store = storeOf(req);
    const removed = store.clearKey(p.id, { actor: "user", ip: req.ip, detail: "Removed in Settings > AI" });
    clearFailureFlag(store, p.id);
    clearBalance(store, p.id);
    if (p.id === "openai") setCatalogModels("openai-models", []);
    res.json({ ok: true, removed, status: await providerStatus(p.id, statusDeps(store)) });
  });

  // --- Test and Verify ------------------------------------------------------------------------------------------

  router.post("/test/:id", limit("test"), async (req, res) => {
    const p = providerOf(req, res);
    if (!p || !requireShipped(p, res)) return undefined;
    const store = storeOf(req);
    const apiKey = req.body?.apiKey;
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") return res.status(400).json({ error: "The key must be text." });
    const out = await probeProvider(p.id, { ...statusDeps(store), fetch: fetchFn(), apiKey });
    if (out.badKey) return res.status(400).json({ error: out.message });
    res.json(out);
  });

  router.post("/verify/:id", limit("verify"), async (req, res) => {
    const p = providerOf(req, res);
    if (!p || !requireShipped(p, res)) return undefined;
    const store = storeOf(req);
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!model || model.length > 200 || /\0/.test(model)) return res.status(400).json({ error: "Say which model to verify." });
    if (/\s/.test(model)) return res.status(400).json({ error: NOT_A_MODEL_NAME });
    if (p.catalog === "claude" && !CLAUDE_MODEL_RE.test(model)) return res.status(400).json({ error: `${model} isn't a Claude model.` });
    const status = await providerStatus(p.id, statusDeps(store));
    if (!status.ready) return res.status(409).json({ error: `${p.label} isn't ready: ${status.detail}`, state: status.state, fix: status.fix });

    let verify;
    try {
      verify = deps.verifyModel ?? (await import("../ai/verify-model.js")).verifyModel;
    } catch (err) {
      return res.status(500).json({ error: `Verification couldn't start: ${redactSecrets(err?.message || String(err))}` });
    }
    let r;
    try {
      // verify-model.js records a pass in ai.<id>.verified itself (it is given the store) and keeps its own
      // per-provider hourly limit on top of this route's per-minute one.
      r = await verify(p.id, model, { store, stateDir: stateDir() });
    } catch (err) {
      return res.status(500).json({ error: `Verification couldn't run: ${redactSecrets(err?.message || String(err))}` });
    }
    if (!r?.ok && r?.code === "rate-limited") return res.status(429).json({ error: redactSecrets(r.error || "Too many checks for now. Try again later."), code: r.code });
    if (!r?.ok && r?.code === "busy") return res.status(409).json({ error: redactSecrets(r.error || "A check is already running. Wait for it to finish."), code: r.code });
    const ok = !!r?.ok && p.engines.includes(r.engine);
    if (ok) {
      if (!r.recorded) {
        // A verifier that didn't save its result: record the engine and the efforts that passed, as the registry reads them.
        const own = store.get(`ai.${p.id}.verified`);
        const merged = own && typeof own === "object" && !Array.isArray(own) ? { ...own } : {};
        merged[bare(model)] = r.entry && typeof r.entry === "object" ? r.entry : {
          engine: r.engine,
          at: new Date(now()).toISOString(),
          engineVersion: r.engineVersion ?? null,
          efforts: Array.isArray(r.efforts) ? r.efforts.filter((e) => typeof e === "string") : [],
          checks: r.checks ?? null,
        };
        store.set(`ai.${p.id}.verified`, merged);
      }
      audit(req, { action: "ai.verify", target: p.id, detail: `${bare(model)} passed` });
    }
    const why = redactSecrets(r?.error || "It didn't pass every check.");
    res.json({
      ok,
      engine: ok ? r.engine : null,
      efforts: Array.isArray(r?.efforts) ? r.efforts : [],
      checks: r?.checks ?? null,
      code: ok ? null : r?.code ?? "failed",
      error: ok ? null : why,
      message: ok ? redactSecrets(r.message || `${model} passed. You can choose it now.`) : redactSecrets(r?.message || why),
    });
  });

  // --- API keys only --------------------------------------------------------------------------------------------

  router.put("/keys-only", (req, res) => {
    const store = storeOf(req);
    const env = envOf();
    const on = req.body?.on;
    if (typeof on !== "boolean") return res.status(400).json({ error: "Send {\"on\": true} or {\"on\": false}." });
    if (keysOnlyLocked(env) && !on) {
      return res.status(423).json({
        error: "The Railway variable TARSEE_KEYS_ONLY=1 keeps \"API keys only\" on. Remove that variable to change it here.",
        keysOnly: { on: true, locked: true },
      });
    }
    store.set("ai.keysOnly", on);
    audit(req, { action: "ai.keys_only", target: "ai.keysOnly", detail: on ? "on" : "off" });
    const active = activeTarget(store, { env, isShipped: deps.isShipped });
    const nowOn = keysOnly(store, { env });
    const activeBlocked = nowOn && PROVIDERS[active.provider].kind === "subscription";
    res.json({
      ok: true,
      keysOnly: { on: nowOn, locked: keysOnlyLocked(env) },
      activeBlocked,
      message: activeBlocked
        ? `Your default AI (${active.label}) is a plan sign-in, which "API keys only" turns off. Choose an API-key AI as the default.`
        : null,
    });
  });

  // --- ChatGPT: Codex's device-code sign-in ---------------------------------------------------------------------

  let login = null;

  const loginView = (l) => {
    const out = { state: l.state };
    if (l.state === "waiting") Object.assign(out, { url: l.url, code: l.code, expiresAt: new Date(l.expiresAt).toISOString() });
    if (l.error) out.error = l.error;
    if (l.code) out.code = l.code;
    return out;
  };
  const stopLogin = (l) => {
    try { Promise.resolve(l?.cancel?.()).catch(() => {}); } catch { /* already stopped */ }
  };

  router.post("/chatgpt/login", limit("login"), async (req, res) => {
    const p = PROVIDERS.chatgpt;
    if (!requireShipped(p, res)) return undefined;
    const store = storeOf(req);
    if (keysOnly(store, { env: envOf() })) {
      return res.status(409).json({ error: "\"API keys only\" is on, so ChatGPT plan sign-in is off. Turn it off in Settings > AI first.", state: "blocked-keys-only" });
    }
    if (login?.state === "waiting") {
      if (now() <= login.expiresAt) return res.json(loginView(login));
      stopLogin(login);
    }

    let start;
    try {
      start = (await loadDeviceLogin()).startDeviceLogin;
    } catch (err) {
      return res.status(500).json({ error: `ChatGPT sign-in couldn't start: ${redactSecrets(err?.message || String(err))}` });
    }
    const home = codexHome();
    let handle;
    try {
      ensureHome(home);
      handle = await start({ codexHome: home, env: envOf() });
    } catch (err) {
      // codex-device-login's DeviceLoginError carries a code (device-code-disabled, network, unsafe-config,
      // codex-missing...) and a message that says what to do.
      return res.status(502).json({ error: `ChatGPT sign-in couldn't start: ${redactSecrets(err?.message || String(err))}`, code: err?.code ?? null });
    }
    const expires = Date.parse(handle?.expiresAt) || Number(handle?.expiresAt) || now() + DEVICE_CODE_TTL_MS;
    const entry = { state: "waiting", url: handle.url, code: handle.code, expiresAt: expires, cancel: handle.cancel, error: null };
    login = entry;
    audit(req, { action: "ai.chatgpt_signin_started", target: "chatgpt" });

    Promise.resolve(handle.done).then(async (r) => {
      if (login !== entry || entry.state !== "waiting") return;
      if (r?.ok) {
        entry.state = "done";
        store.set("ai.chatgpt.method", "device");
        clearFailureFlag(store, "chatgpt");
        audit(req, { action: "credential.write", target: "chatgpt.signin", detail: "Signed in with ChatGPT (device code)" });
        // Not read if "API keys only" was switched on while the code waited (fillChatgptModels checks it again now).
        try { await fillChatgptModels(store); } catch (err) { console.warn("[ai] reading the ChatGPT account's models failed:", redactSecrets(err?.message || String(err))); }
      } else {
        const why = String(r?.error || "Sign-in didn't finish.");
        entry.state = r?.code === "timeout" || /expired|timed? ?out/i.test(why) ? "expired" : "failed";
        entry.error = redactSecrets(why);
        entry.code = r?.code ?? null;
      }
    }, (err) => {
      if (login !== entry || entry.state !== "waiting") return;
      entry.state = "failed";
      entry.error = redactSecrets(err?.message || String(err));
      entry.code = null;   // the device code is spent: a failed view never shows it
    });

    res.json(loginView(entry));
  });

  router.get("/chatgpt/login", async (req, res) => {
    if (!login) return res.json({ state: "idle" });
    if (login.state === "waiting" && now() > login.expiresAt) {
      stopLogin(login);
      login.state = "expired";
      login.error = "The code expired before sign-in finished. Start again.";
      login.code = null;
    }
    const out = loginView(login);
    if (login.state === "done") {
      const s = await providerStatus("chatgpt", statusDeps(storeOf(req)));
      out.account = s.account;
      out.status = s;
    }
    res.json(out);
  });

  router.delete("/chatgpt/login", (_req, res) => {
    if (login?.state === "waiting") stopLogin(login);
    login = null;
    res.json({ ok: true, state: "idle" });
  });

  router.post("/chatgpt/logout", async (req, res) => {
    const store = storeOf(req);
    if (login?.state === "waiting") stopLogin(login);
    login = null;
    const home = codexHome();
    // Codex's own logout (it stops a login in progress, runs `codex logout`, then removes auth.json); the file is
    // removed here as well, so a sign-out never leaves the sign-in behind.
    let result = { ok: true };
    try {
      const mod = deps.startDeviceLogin ? { logout: deps.logout } : await loadDeviceLogin();
      if (typeof mod?.logout === "function") result = (await mod.logout({ codexHome: home, env: envOf() })) || { ok: true };
    } catch (err) {
      console.warn("[ai] codex logout failed (removing its sign-in file anyway):", redactSecrets(err?.message || String(err)));
    }
    if (result.ok === false) return res.status(500).json({ error: redactSecrets(result.error || "Couldn't sign out of ChatGPT.") });
    try {
      fs.rmSync(path.join(home, "auth.json"), { force: true });
    } catch (err) {
      return res.status(500).json({ error: `Couldn't remove the ChatGPT sign-in file: ${err?.message || err}` });
    }
    store.delete("ai.chatgpt.method");
    clearFailureFlag(store, "chatgpt");
    setCatalogModels("chatgpt-models", []);
    audit(req, { action: "credential.delete", target: "chatgpt.signin", detail: "Signed out of ChatGPT" });
    res.json({ ok: true, status: await providerStatus("chatgpt", statusDeps(store)) });
  });

  return router;
}

/** The production router (server.js mounts it at /api/ai behind requireAuth and csrf). */
export const aiRouter = createAiRouter();
