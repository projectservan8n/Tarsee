/**
 * openrouter-catalog.js: the models OpenRouter offers, for the picker and for pricing (design 4.11).
 *
 * The list is OpenRouter's public GET /api/v1/models. It needs no key and none is ever sent with it: this module has
 * no way to reach a key at all. It is read at boot (the cached copy at once, then a fresh one in the background, like
 * initModelCatalog) and every 6 hours, cached in the cache.openrouter.models setting so a restart has it straight away,
 * and fed to the provider registry (setCatalogModels "openrouter"), where priceFor, contextTokensFor and capsFor read
 * it.
 *
 * Why the full list and not ?supported_parameters=tools: that filtered answer leaves out the "~maker/...-latest"
 * aliases, Tarsee's own OpenRouter defaults among them. So the full list is read and filtered here.
 *
 * A model is kept only when Tarsee can run it:
 *  - it takes tools (supported_parameters has "tools"): every Tarsee turn uses them;
 *  - it has a chat endpoint an engine speaks: /api/v1/messages (Claude Code) or /api/v1/responses (Codex). The
 *    ":batch" copies only take batch jobs;
 *  - it has a price per token. Routers that pick a different model on each request list -1: no cost can be shown or
 *    bounded for them, and a verification run says nothing about the next request;
 *  - it answers in text, and its retirement date (if any) hasn't passed.
 *
 * The picker shows three sections (openRouterSections): Recommended (the registry's recommended slugs and the shipped
 * verified models), Verified by you (ai.openrouter.verified) and All models (searchable). A row can be picked only
 * when the registry knows its engine (engineFor): Anthropic's models and OpenAI's run without a check, any other
 * maker after Verify (ai/verify-model.js).
 */
import { PROVIDERS, setCatalogModels, engineFor, effortsFor, verifiedModels } from "../ai/provider-registry.js";
import { EFFORT_IDS } from "./model-picker.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_CACHE_KEY = "cache.openrouter.models";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 20_000;
// The whole list is under 1 MB today; anything far bigger is not the list.
const MAX_BODY_CHARS = 16 * 1024 * 1024;

const CLAUDE_CODE = "claude-code";
const CODEX = "codex";
const MESSAGES_ENDPOINT = "/api/v1/messages";
const RESPONSES_ENDPOINT = "/api/v1/responses";

/** OpenRouter's common reasoning levels: what it accepts from any model that reasons but lists none of its own. */
const COMMON_EFFORTS = Object.freeze(["low", "medium", "high"]);

/** A catalog fetch that went wrong, in words the Settings page can show. */
export class CatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogError";
  }
}

let _models = null;      // the current list, normalized
let _fetchedAt = null;   // when it was fetched (ISO)
let _inflight = null;    // the fetch in progress, so callers at the same moment share it

// --- Reading OpenRouter's answer ---

/**
 * The models Tarsee can run, from the body of GET /api/v1/models. Rows it can't read are skipped; a body that isn't a
 * model list throws. Each row:
 *   { id, label, vendor, context, vision, pdf, price: {in, out, cacheRead, cacheWrite} | null, free,
 *     reasoning: {efforts, default, mandatory} | null, engines, aliasOf, retires }
 * Prices are USD per million tokens. engines are the ones whose endpoint the model has (Claude Code needs
 * /api/v1/messages, Codex /api/v1/responses); a row that doesn't list its endpoints may run on either.
 */
export function parseOpenRouterModels(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
    throw new CatalogError("OpenRouter's answer isn't a model list.");
  }
  const at = typeof now === "number" ? now : new Date(now).getTime();
  const out = [];
  const seen = new Set();
  for (const raw of body.data) {
    const row = normalizeRow(raw, at);
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

function normalizeRow(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
  if (!params.includes("tools")) return null;

  const engines = enginesOf(raw.endpoints);
  if (!engines.length) return null;

  const arch = raw.architecture && typeof raw.architecture === "object" ? raw.architecture : {};
  const outputs = Array.isArray(arch.output_modalities) ? arch.output_modalities : null;
  if (outputs && !outputs.includes("text")) return null;

  const retires = dateOnly(raw.expiration_date);
  if (retires && Date.parse(`${retires}T00:00:00Z`) <= now) return null;

  const price = priceOf(raw.pricing);
  if (price === false) return null;

  const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
  const vendor = makerOf(id);
  return {
    id,
    label: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    vendor,
    context: positiveInt(raw.context_length) ?? positiveInt(raw.top_provider?.context_length),
    vision: inputs.includes("image"),
    // Native PDF blocks only for Anthropic's own models (design 4.12); every other model gets the text.
    pdf: vendor === "anthropic" && inputs.includes("file"),
    price,
    free: id.endsWith(":free") || (!!price && price.in === 0 && price.out === 0),
    reasoning: reasoningOf(raw.reasoning, params),
    engines,
    aliasOf: typeof raw.alias_target?.slug === "string" && raw.alias_target.slug.trim() ? raw.alias_target.slug.trim() : null,
    retires,
  };
}

/** The engines a model's endpoints allow. A model that doesn't list them may be tried on either. */
function enginesOf(endpoints) {
  if (!Array.isArray(endpoints)) return [CLAUDE_CODE, CODEX];
  const out = [];
  if (endpoints.includes(MESSAGES_ENDPOINT)) out.push(CLAUDE_CODE);
  if (endpoints.includes(RESPONSES_ENDPOINT)) out.push(CODEX);
  return out;
}

/**
 * Per-token prices in USD per million tokens; null when the model lists none; false for a router whose price is per
 * request (-1), which the catalog leaves out. A missing cache price costs the input rate.
 */
function priceOf(pricing) {
  if (!pricing || typeof pricing !== "object") return null;
  const inRate = perMillion(pricing.prompt);
  const outRate = perMillion(pricing.completion);
  if (inRate == null || outRate == null) return null;
  if (inRate < 0 || outRate < 0) return false;
  const cacheRead = perMillion(pricing.input_cache_read);
  const cacheWrite = perMillion(pricing.input_cache_write);
  return {
    in: inRate,
    out: outRate,
    cacheRead: cacheRead != null && cacheRead >= 0 ? cacheRead : inRate,
    cacheWrite: cacheWrite != null && cacheWrite >= 0 ? cacheWrite : inRate,
  };
}

/** "0.000002" (USD per token, as OpenRouter writes it) -> 2 (USD per million), without float noise. */
function perMillion(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e12) / 1e6;
}

/**
 * The reasoning levels a model takes, as Tarsee's effort ids (lowest first): the ones it lists, without "none" and
 * "minimal", which Tarsee doesn't offer. A model that reasons but lists no levels takes OpenRouter's common three.
 * null for a model that doesn't reason.
 */
function reasoningOf(reasoning, params) {
  const listed = Array.isArray(reasoning?.supported_efforts) ? reasoning.supported_efforts : null;
  const reasons = params.includes("reasoning") || params.includes("reasoning_effort") || !!listed?.length;
  if (!reasons) return null;
  const efforts = listed ? EFFORT_IDS.filter((e) => listed.includes(e)) : [...COMMON_EFFORTS];
  const def = typeof reasoning?.default_effort === "string" && EFFORT_IDS.includes(reasoning.default_effort) ? reasoning.default_effort : null;
  return { efforts, default: def, mandatory: reasoning?.mandatory === true };
}

// --- Fetching, caching, and feeding the registry ---

/**
 * Bring the catalog up to date. The cached list is used while it is under 6 hours old (unless `force`); otherwise
 * OpenRouter is asked, once even when several callers ask at the same moment. Never throws: when OpenRouter can't be
 * reached the last list stays in use and `error` says why.
 *
 * opts: fetch (default globalThis.fetch), url (default OPENROUTER_MODELS_URL), now (a function giving milliseconds),
 * force, signal, timeoutMs.
 * Returns { source: "cache"|"network"|"stale"|"none", models, fetchedAt, error }.
 */
export function refreshOpenRouterCatalog(store, opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const t = now();
  const cached = readCache(store);
  if (!opts.force && cached && isFresh(cached.fetchedAt, t)) {
    apply(cached.models, cached.fetchedAt);
    return Promise.resolve({ source: "cache", models: cached.models, fetchedAt: cached.fetchedAt, error: null });
  }
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const body = await getJson(opts);
      const models = parseOpenRouterModels(body, { now: t });
      const fetchedAt = new Date(t).toISOString();
      writeCache(store, { fetchedAt, models });
      apply(models, fetchedAt);
      return { source: "network", models, fetchedAt, error: null };
    } catch (err) {
      const error = err instanceof CatalogError ? err.message : `Tarsee couldn't read OpenRouter's model list (${err?.message || err}).`;
      const last = cached || (_models ? { models: _models, fetchedAt: _fetchedAt } : null);
      if (last) {
        apply(last.models, last.fetchedAt);
        return { source: "stale", models: last.models, fetchedAt: last.fetchedAt, error };
      }
      return { source: "none", models: [], fetchedAt: null, error };
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** The cached list, put to use without asking OpenRouter (boot). null when nothing is cached. */
export function loadOpenRouterCatalog(store) {
  const cached = readCache(store);
  if (!cached) return null;
  apply(cached.models, cached.fetchedAt);
  return cached;
}

/**
 * Boot: the cached list at once, a fresh one in the background, and again every 6 hours. Returns
 * { ready (the first refresh's result), stop() }. opts as refreshOpenRouterCatalog, plus intervalMs.
 */
export function initOpenRouterCatalog(store, opts = {}) {
  loadOpenRouterCatalog(store);
  const ready = refreshOpenRouterCatalog(store, opts).then((r) => {
    if (r.error) console.warn(`[models] OpenRouter catalog: ${r.error}${r.models.length ? ` Using the list from ${r.fetchedAt}.` : ""}`);
    else if (r.source === "network") console.log(`[models] OpenRouter catalog: ${r.models.length} models Tarsee can run`);
    return r;
  });
  const timer = setInterval(() => {
    refreshOpenRouterCatalog(store, { ...opts, force: true }).catch(() => { /* never throws; belt and braces */ });
  }, opts.intervalMs ?? CATALOG_TTL_MS);
  timer.unref?.();
  return { ready, stop: () => clearInterval(timer) };
}

/** The current list (normalized rows); empty before the first load. */
export function openRouterModels() {
  return _models || [];
}

/** The engines a listed model's endpoints allow, or null when OpenRouter doesn't list it (any engine may be tried). */
export function catalogEnginesFor(modelId) {
  const id = String(modelId ?? "").trim().replace(/\[1m\]$/i, "");
  const row = (_models || []).find((m) => m.id === id);
  return row ? [...row.engines] : null;
}

/** One listed model's row, or null. */
export function catalogModel(modelId) {
  const id = String(modelId ?? "").trim().replace(/\[1m\]$/i, "");
  return (_models || []).find((m) => m.id === id) || null;
}

async function getJson({ fetch: fetchImpl = globalThis.fetch, url = OPENROUTER_MODELS_URL, signal, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    // A public list: no key and no cookie, only a request for JSON.
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: sig });
  } catch (err) {
    const why = timeout.aborted ? "it took too long to answer" : (err?.cause?.code || err?.code || err?.name || "network error");
    throw new CatalogError(`Tarsee couldn't reach OpenRouter for its model list (${why}).`);
  }
  if (!res.ok) throw new CatalogError(`OpenRouter answered ${res.status} when asked for its model list.`);
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) throw new CatalogError("OpenRouter's answer was far too big to be its model list.");
  try {
    return JSON.parse(text);
  } catch {
    throw new CatalogError("OpenRouter's model list couldn't be read.");
  }
}

function isFresh(fetchedAt, now) {
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && now >= at && now - at < CATALOG_TTL_MS;
}

function readCache(store) {
  let v;
  try { v = store?.get?.(CATALOG_CACHE_KEY); } catch { return null; }
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== "object" || !Array.isArray(v.models) || typeof v.fetchedAt !== "string") return null;
  const models = v.models.filter((m) => m && typeof m === "object" && typeof m.id === "string" && m.id.trim() && Array.isArray(m.engines));
  return { fetchedAt: v.fetchedAt, models };
}

function writeCache(store, value) {
  try { store?.set?.(CATALOG_CACHE_KEY, value); } catch (err) { console.warn(`[models] couldn't cache OpenRouter's model list: ${err.message}`); }
}

/** Make a list the current one, here and in the registry (prices, context, vision, PDFs, Free). */
function apply(models, fetchedAt) {
  _models = models;
  _fetchedAt = fetchedAt || null;
  setCatalogModels("openrouter", models.map((m) => ({
    id: m.id,
    label: m.label,
    vendor: m.vendor,
    context: m.context,
    efforts: m.reasoning ? m.reasoning.efforts : null,
    vision: m.vision,
    pdf: m.pdf,
    price: m.price,
    free: m.free,
  })));
}

// --- The picker ---

/**
 * The picker's OpenRouter sections, each { id, label, models, searchable? }:
 *   recommended  "Recommended": the registry's recommended slugs (the default first), then the shipped verified models
 *   verified     "Verified by you": the models the owner verified (ai.openrouter.verified), newest result kept
 *   all          "All models": every model Tarsee can run, sorted by name; `query` narrows only this one
 * Each row: the catalog row plus
 *   engine       the engine that runs it now, or null (it must be verified first)
 *   selectable   whether it can be picked now (engine is known); needsVerify is its opposite
 *   streaming    replies word by word (Claude Code) or a message at a time (Codex); null until the engine is known
 *   efforts      the effort levels the picker offers for it now ([] until it can be picked)
 *   verified     { engine, at, engineVersion } when a verification passed, else null
 *   priceLabel   the price in plain words ("Free" for the free ones)
 *   listed       false for a verified model OpenRouter no longer lists
 * opts: query, models (instead of the current list).
 */
export function openRouterSections(store, { query = "", models } = {}) {
  const list = Array.isArray(models) ? models : (_models || readCache(store)?.models || []);
  const byId = new Map(list.map((m) => [m.id, m]));
  const p = PROVIDERS.openrouter;
  const shippedVerified = p.models.filter((m) => m.verified).map((m) => m.id);
  const recIds = unique([...(p.recommended || []), ...shippedVerified]);
  const rowFor = (id) => pickerRow(byId.get(id) || unlisted(id), store);

  const own = ownVerified(store, p);
  const mine = Object.keys(own).filter((id) => !recIds.includes(id));
  const all = searchModels(list, query).map((m) => pickerRow(m, store)).sort(byLabel);
  return [
    { id: "recommended", label: "Recommended", models: recIds.map(rowFor) },
    { id: "verified", label: "Verified by you", models: mine.map(rowFor) },
    { id: "all", label: "All models", models: all, searchable: true },
  ];
}

/** Rows whose id or name holds every word of the query (any case). An empty query keeps them all. */
export function searchModels(models, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models;
  return models.filter((m) => {
    const hay = `${m.id} ${m.label || ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A price in plain words: "$2 in, $10 out per million tokens", "Free", or null when there is none. */
export function priceLabel(price) {
  if (!price || typeof price !== "object") return null;
  if (price.in === 0 && price.out === 0) return "Free";
  return `${usd(price.in)} in, ${usd(price.out)} out per million tokens`;
}

function usd(n) {
  if (!Number.isFinite(n)) return "?";
  return `$${Number(n.toPrecision(3))}`;
}

function pickerRow(m, store) {
  const engine = engineFor("openrouter", m.id, store);
  const v = verifiedModels("openrouter", store)[m.id] || null;
  return {
    ...m,
    reasoning: m.reasoning ? { ...m.reasoning, efforts: [...m.reasoning.efforts] } : null,
    engines: m.engines ? [...m.engines] : null,
    listed: m.listed !== false,
    engine,
    selectable: engine != null,
    needsVerify: engine == null,
    streaming: engine ? engine === CLAUDE_CODE : null,
    efforts: engine ? effortsFor("openrouter", m.id, store) : [],
    verified: v ? { engine: v.engine, at: v.at ?? null, engineVersion: v.engineVersion ?? null } : null,
    priceLabel: priceLabel(m.price),
  };
}

/** A row for a model OpenRouter doesn't list (a verified one that has since gone). */
function unlisted(id) {
  return {
    id, label: id, vendor: makerOf(id), context: null, vision: null, pdf: null, price: null,
    free: id.endsWith(":free"), reasoning: null, engines: null, aliasOf: null, retires: null, listed: false,
  };
}

/** The owner's own verified models (not the shipped ones), in the order they were saved. */
function ownVerified(store, p) {
  let v;
  try { v = store?.get?.(`ai.${p.id}.verified`); } catch { return {}; }
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return {}; } }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(v)) {
    if (entry && typeof entry === "object" && p.engines.includes(entry.engine)) out[id] = entry;
  }
  return out;
}

function byLabel(a, b) {
  const x = String(a.label || a.id).toLowerCase();
  const y = String(b.label || b.id).toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function unique(arr) {
  return [...new Set(arr)];
}

/** "~anthropic/claude-sonnet-latest" -> "anthropic"; "openrouter" for an id with no maker. */
function makerOf(id) {
  const s = String(id).replace(/^~/, "");
  const i = s.indexOf("/");
  const maker = i > 0 ? s.slice(0, i).toLowerCase().replace(/[^a-z0-9._-]/g, "") : "";
  return maker || "openrouter";
}

function dateOnly(v) {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m && Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1] : null;
}

function positiveInt(v) {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Tests only: forget the current list. */
export function __resetForTests() {
  _models = null;
  _fetchedAt = null;
  _inflight = null;
}

/** Tests only: use this list as the current one. */
export function __setModelsForTests(models) {
  apply(models, null);
}
