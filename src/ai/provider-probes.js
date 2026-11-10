/**
 * provider-probes.js: the cheap live checks behind Settings > AI's Test button, and the balance reads the provider
 * cards show (design 4.13 "Balance cards" and 4.14 "Test probes"). Each is one free GET to the provider's own host,
 * taken from the registry's code constants (testProbe / balanceProbe), so a key only ever travels to its own provider;
 * Local AI's goes only to the address the owner set for it.
 *
 *   Anthropic   GET https://api.anthropic.com/v1/models      (x-api-key)
 *   OpenAI      GET https://api.openai.com/v1/models         (Bearer)
 *   OpenRouter  GET https://openrouter.ai/api/v1/key         (Bearer; the key's spending limit and usage)
 *   DeepSeek    GET https://api.deepseek.com/user/balance    (Bearer; the prepaid balance)
 *   Local AI    GET {address}/models                         (Bearer only when a key is set), and POST
 *               {address}/responses with an empty body: a server without that API can't run a turn. A server the
 *               model list names gets one more read for what it really runs (listLocalModels): llama-server GET
 *               /props (its build and context), LM Studio GET /api/v0/models (each model's kind and loaded context),
 *               Ollama GET /api/ps and POST /api/show (each model's context and capabilities). Embedding models are
 *               left out, and Test fails for a context under 32,768 tokens or a llama.cpp build before b11768.
 *   The plans   no network: the Claude sign-in, or Codex's own ChatGPT sign-in (provider-status.js)
 *
 * Every probe answers { ok, state, message, httpStatus?, balance?, account?, models? }: a plain sentence for the
 * owner, never an exception and never the key. fetch is injectable (tests use a stub that records where each request
 * went), and a test server (NODE_ENV=test with a loopback TARSEE_TEST_BASE_URL_<ID>, engine-env's seam) sends each
 * probe to its fake instead of the provider's host. A probe of the stored key also updates the card: a pass clears the engines' failure flag, a rejected key or
 * an empty balance sets it, and a balance read is cached for 10 minutes.
 */
import {
  getProvider,
  checkKeySlot,
  setCatalogModels,
  setLocalModels,
} from "./provider-registry.js";
import {
  providerStatus,
  chosenModel,
  localUrlFor,
  plainHttpUrl,
  saveBalance,
  cachedBalance,
  clearFailureFlag,
  failureFlag,
  setFailureFlag,
  BALANCE_PROVIDERS,
} from "./provider-status.js";
import { testBaseUrl } from "./engine-env.js";
import { localNoResponsesMessage } from "./engine-errors.js";

/** How long a Test waits for an answer. */
export const PROBE_TIMEOUT_MS = 10_000;

/** How long the provider cards wait for a balance before showing the card without one. */
export const BALANCE_TIMEOUT_MS = 5_000;

const ANTHROPIC_VERSION = "2023-06-01";

// --- Money and balances --------------------------------------------------------------------------------------------

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** $4.20, ¥110.00, or "4.20 EUR". */
export function money(amount, currency = "USD") {
  const n = Number(amount) || 0;
  const cur = String(currency || "USD").toUpperCase();
  const fixed = Math.abs(n).toFixed(2);
  const sign = n < 0 ? "-" : "";
  if (cur === "USD") return `${sign}$${fixed}`;
  if (cur === "CNY") return `${sign}¥${fixed}`;
  return `${sign}${fixed} ${cur}`;
}

/**
 * OpenRouter's GET /api/v1/key answer as a balance card. Its "label" (which carries part of the key) is never
 * kept. remaining is null for a key with no spending limit.
 */
export function parseOpenRouterKey(json) {
  const d = json && typeof json === "object" ? (json.data && typeof json.data === "object" ? json.data : json) : null;
  if (!d) return null;
  const limit = num(d.limit);
  const usage = num(d.usage);
  let remaining = num(d.limit_remaining);
  if (remaining === null && limit !== null && usage !== null) remaining = limit - usage;
  const usageDaily = num(d.usage_daily);
  const usageMonthly = num(d.usage_monthly);
  const empty = remaining !== null && remaining <= 0;
  let text;
  if (limit !== null && remaining !== null) text = `Spending limit left ${money(Math.max(0, remaining))} of ${money(limit)}`;
  else if (usageMonthly !== null) text = `No spending limit · ${money(usageMonthly)} used this month`;
  else if (usage !== null) text = `No spending limit · ${money(usage)} used`;
  else text = "No spending limit";
  return { kind: "limit", currency: "USD", remaining, limit, usage, usageDaily, usageMonthly, freeTier: d.is_free_tier === true, empty, text };
}

/** DeepSeek's GET /user/balance answer as a balance card (US dollars when the account has them, else its currency). */
export function parseDeepSeekBalance(json) {
  if (!json || typeof json !== "object") return null;
  const infos = Array.isArray(json.balance_infos) ? json.balance_infos.filter((i) => i && typeof i === "object") : [];
  const pick = infos.find((i) => String(i.currency).toUpperCase() === "USD") || infos[0] || null;
  const currency = pick ? String(pick.currency || "USD").toUpperCase() : "USD";
  const total = pick ? num(pick.total_balance) ?? 0 : 0;
  const available = json.is_available !== false;
  return {
    kind: "prepaid",
    currency,
    total,
    granted: pick ? num(pick.granted_balance) : null,
    toppedUp: pick ? num(pick.topped_up_balance) : null,
    available,
    empty: !available || !(total > 0),
    text: `Balance ${money(total, currency)}`,
  };
}

const BALANCE_PARSERS = { openrouter: parseOpenRouterKey, deepseek: parseDeepSeekBalance };

// --- Requests ------------------------------------------------------------------------------------------------------

/** One GET with a timeout: {status, json} or {network: "timeout" | "refused" | "dns" | "network"}. Never throws. */
async function get(url, { fetch: doFetch = globalThis.fetch, headers = {}, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let res;
  try {
    // A redirect is refused rather than followed: the key goes to this one address and nowhere else.
    res = await doFetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { network: networkReason(err) };
  }
  let json = null;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch { json = null; }
  return { status: res.status, json };
}

function networkReason(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  const code = err?.cause?.code || err?.code || "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  return "network";
}

function authHeaders(p, key) {
  if (!key) return {};
  if (p.testProbe?.auth === "x-api-key") return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  return { Authorization: `Bearer ${key}` };
}

/** A key as pasted: whitespace and one pair of wrapping quotes removed (what Settings stores). */
export function cleanKey(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

// --- Outcomes ------------------------------------------------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

/** What an HTTP status or network failure means for a provider, as {ok, state, message, reason}. */
function failure(p, r, url) {
  const hints = p.errorHints || {};
  const label = p.label;
  if (r.network) {
    if (p.id === "local" && (r.network === "refused" || r.network === "dns")) {
      return { ok: false, state: "error", reason: "unreachable", message: `Can't reach your Local AI at ${url}. If you just started llama-server with -hf, it may still be downloading the model.` };
    }
    if (r.network === "timeout") return { ok: false, state: "error", reason: "timeout", message: `${label} took too long to answer. Try again in a moment.` };
    return { ok: false, state: "error", reason: "network", message: `Tarsee couldn't reach ${label} (${hostOf(url)}). Check this server's internet connection, then try again.` };
  }
  const s = r.status;
  const errText = String(r.json?.error?.message ?? r.json?.message ?? "");
  const errCode = String(r.json?.error?.code ?? r.json?.error?.type ?? r.json?.code ?? "");
  if (s === 401 || s === 403) {
    return { ok: false, state: "error", reason: "auth", httpStatus: s, message: hints.auth || `${label} turned this key down.` };
  }
  if (s === 402 || (s === 429 && /insufficient_quota|billing|credit|balance/i.test(`${errCode} ${errText}`))) {
    return { ok: false, state: "out-of-credit", reason: "billing", httpStatus: s, message: hints.billing || `${label} has run out of credit.` };
  }
  if (s === 429) {
    return { ok: true, state: "ready", reason: "rate", httpStatus: s, message: `Key works, but ${label} is limiting requests right now. Try again in a minute.` };
  }
  if (s === 404 && p.id === "local") {
    return { ok: false, state: "needs-setup", reason: "not-found", httpStatus: s, message: `Your Local AI answered, but has no model list at ${url}. Check the address (it usually ends in /v1).` };
  }
  if (s === 503 && p.id === "local" && /loading/i.test(errText)) {
    // llama-server answers every request but /health with 503 "Loading model" until its model is in memory.
    return { ok: false, state: "error", reason: "loading", httpStatus: s, message: "Your Local AI is still loading its model. Click Test again in a minute." };
  }
  if (s >= 500) {
    return { ok: false, state: "error", reason: "unavailable", httpStatus: s, message: `${label} had a problem on its side (HTTP ${s}). Try again in a minute.` };
  }
  return { ok: false, state: "error", reason: "unexpected", httpStatus: s, message: `${label} answered with HTTP ${s}, which Tarsee didn't expect.` };
}

/** The rows a /models answer lists: OpenAI's {data: [...]}, or Ollama's own {models: [...]}, ids trimmed, no repeats. */
function modelRowsOf(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
  const out = [];
  for (const m of rows) {
    const raw = typeof m === "string" ? m : m?.id ?? m?.name ?? m?.model;
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id && !out.some((r) => r.id === id)) out.push({ id, row: m && typeof m === "object" ? m : {} });
  }
  return out;
}

/** The ids a /models answer lists: OpenAI's {data: [{id}]}, or Ollama's own {models: [{name|model}]}. */
export function modelIdsFrom(json) {
  return modelRowsOf(json).map((r) => r.id);
}

/** The URL of Local AI's model list: the owner's address (one trailing slash dropped) plus /models. */
export function localModelsUrl(address) {
  return `${String(address).trim().replace(/\/+$/, "")}/models`;
}

/** The smallest context Tarsee can work in: Codex's own instructions and Tarsee's tools take about 20,000 tokens a call. */
export const MIN_LOCAL_CONTEXT = 32_768;

/** The first llama.cpp build whose stream Tarsee relies on: tool calls carry output_index (b11768, v0.8.0). */
export const MIN_LLAMACPP_BUILD = 11_768;

const posInt = (v) => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** The server's own address: the owner's address without its /v1 (where llama-server's /props and Ollama's /api live). */
export function localServerRoot(address) {
  return String(address).trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** Which server a /models answer comes from, by its rows: "llama.cpp", "LM Studio", "Ollama", or null. */
export function localServerKind(rows) {
  const list = rows.map((r) => r.row);
  if (list.some((r) => r.owned_by === "llamacpp")) return "llama.cpp";
  if (list.length && list.every((r) => r.owned_by === "organization_owner")) return "LM Studio";
  // Ollama names each row's owner after the model's namespace ("library" for its own) and dates it; its ids have a tag.
  if (list.length && list.every((r) => typeof r.created === "number" && typeof r.owned_by === "string")
    && rows.some((r) => r.row.owned_by === "library" || /:[^/:]+$/.test(r.id))) return "Ollama";
  return null;
}

/** "b12238-08f945ffb" as {build: "b12238", buildNumber: 12238}, or nulls. */
export function llamaBuildOf(buildInfo) {
  const m = /^b(\d+)\b/.exec(String(buildInfo ?? "").trim());
  return m ? { build: `b${m[1]}`, buildNumber: Number(m[1]) } : { build: null, buildNumber: null };
}

/** What the extra reads add per model: {serverContext?, maxContext?, kind?: "embedding"} by id. */
async function serverDetails(kind, root, ids, { doFetch, headers, timeoutMs }) {
  const per = new Map();
  const add = (id, info) => per.set(id, { ...(per.get(id) || {}), ...info });
  const server = {};
  if (kind === "llama.cpp") {
    // GET /props: the build, the context each request gets, and the router role (several models, loaded on demand).
    const r = await get(`${root}/props`, { fetch: doFetch, headers, timeoutMs });
    if (r.status === 200 && r.json && typeof r.json === "object") {
      Object.assign(server, llamaBuildOf(r.json.build_info));
      server.context = posInt(r.json.default_generation_settings?.n_ctx) ?? posInt(r.json.n_ctx);
      server.router = r.json.role === "router";
    } else if (r.status === 401 || r.status === 403) {
      server.authFailed = r.status;
    } else if (r.status === 503) {
      server.loading = true;
    }
  } else if (kind === "LM Studio") {
    // LM Studio's own model list: each model's kind (llm, vlm, embeddings) and, once loaded, the context it was loaded
    // with. Its newer /api/v1 list is read when /api/v0 isn't there.
    const v0 = await get(`${root}/api/v0/models`, { fetch: doFetch, headers, timeoutMs });
    if (v0.status === 200 && Array.isArray(v0.json?.data)) {
      for (const m of v0.json.data) {
        if (typeof m?.id !== "string") continue;
        add(m.id, {
          kind: /^embedding/i.test(String(m.type || "")) ? "embedding" : null,
          serverContext: m.state === "loaded" ? posInt(m.loaded_context_length) : null,
          maxContext: posInt(m.max_context_length),
        });
      }
    } else {
      const v1 = await get(`${root}/api/v1/models`, { fetch: doFetch, headers, timeoutMs });
      for (const m of Array.isArray(v1.json?.models) ? v1.json.models : []) {
        if (typeof m?.key !== "string") continue;
        const loaded = Array.isArray(m.loaded_instances) ? m.loaded_instances.map((x) => posInt(x?.config?.context_length)).filter(Boolean) : [];
        add(m.key, {
          kind: /^embedding/i.test(String(m.type || "")) ? "embedding" : null,
          serverContext: loaded.length ? Math.min(...loaded) : null,
          maxContext: posInt(m.max_context_length),
        });
      }
    }
  } else if (kind === "Ollama") {
    // /api/ps: the context of each model in memory. /api/show: each model's capabilities (an embedding model has no
    // "completion") and the num_ctx it is set to load with, if any.
    const ps = await get(`${root}/api/ps`, { fetch: doFetch, headers, timeoutMs });
    const loaded = new Map();
    for (const m of Array.isArray(ps.json?.models) ? ps.json.models : []) {
      const n = posInt(m?.context_length);
      for (const name of [m?.name, m?.model]) if (typeof name === "string" && n) loaded.set(name, n);
    }
    await Promise.all(ids.slice(0, 40).map(async (id) => {
      const r = await post(`${root}/api/show`, { model: id }, { fetch: doFetch, headers, timeoutMs });
      const caps = Array.isArray(r.json?.capabilities) ? r.json.capabilities : null;
      const numCtx = posInt(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(r.json?.parameters ?? ""))?.[1]);
      const trained = r.json?.model_info && typeof r.json.model_info === "object"
        ? posInt(Object.entries(r.json.model_info).find(([k]) => /\.context_length$/.test(k))?.[1]) : null;
      add(id, {
        kind: caps && caps.includes("embedding") && !caps.includes("completion") ? "embedding" : null,
        serverContext: loaded.get(id) ?? numCtx ?? null,
        maxContext: trained,
      });
    }));
  }
  return { per, server };
}

/** One POST of JSON with a timeout, as get() does it: {status, json} or {network}. Never throws. */
async function post(url, body, { fetch: doFetch = globalThis.fetch, headers = {}, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { network: networkReason(err) };
  }
  let json = null;
  try { const text = await res.text(); json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

/** An embedding model's name, for a server that says nothing of what its models are for. */
const EMBEDDING_NAME_RE = /(?:^|[/_.:-])(?:text-)?embed(?:ding)?s?(?:[/_.:-]|$)|(?:^|[/_.:-])(?:nomic-embed|mxbai-embed|bge-(?:m3|large|base|small))/i;

/**
 * Local AI's models from {address}/models, with what the server says about each, or a failure outcome:
 *   { ok: true, models: [ids that can chat], rows: [{id, serverContext, maxContext}], hidden: [embedding model ids],
 *     server: {kind: "llama.cpp" | "LM Studio" | "Ollama" | null, build?, buildNumber?, context?, router?, loading?,
 *     authFailed?} }
 * serverContext is the context the server actually gives that model now (llama-server's meta.n_ctx and /props n_ctx,
 * LM Studio's loaded_context_length, Ollama's /api/ps context_length or its num_ctx); maxContext the most the model
 * was trained for. Embedding models are left out of models and rows (LM Studio's type "embeddings", Ollama's
 * capabilities, else a name like "text-embedding-..."). Only a server the /models answer names gets its extra reads:
 * llama-server GET /props, LM Studio GET /api/v0/models (else /api/v1/models), Ollama GET /api/ps and POST /api/show;
 * any other server gets no request beyond /models.
 */
export async function listLocalModels({ url, key = null, fetch: doFetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const p = getProvider("local");
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const r = await get(localModelsUrl(url), { fetch: doFetch, headers, timeoutMs });
  if (r.network || r.status < 200 || r.status >= 300) return { ok: false, ...failure(p, r, url) };
  return describeLocalModels(r.json, url, { key, fetch: doFetch, timeoutMs });
}

/** listLocalModels' answer for a /models answer already read (json) from the server at url. Never throws. */
export async function describeLocalModels(json, url, { key = null, fetch: doFetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const listed = modelRowsOf(json);
  const kind = localServerKind(listed);
  const { per, server } = kind
    ? await serverDetails(kind, localServerRoot(url), listed.map((x) => x.id), { doFetch, headers, timeoutMs })
    : { per: new Map(), server: {} };
  const rows = [];
  const hidden = [];
  for (const { id, row } of listed) {
    const extra = per.get(id) || {};
    const embedding = extra.kind === "embedding" || (!per.has(id) && EMBEDDING_NAME_RE.test(id));
    if (embedding) { hidden.push(id); continue; }
    const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
    rows.push({
      id,
      serverContext: extra.serverContext ?? posInt(meta.n_ctx) ?? (kind === "llama.cpp" && !server.router ? server.context ?? null : null),
      maxContext: extra.maxContext ?? posInt(meta.n_ctx_train) ?? null,
    });
  }
  return { ok: true, models: rows.map((x) => x.id), rows, hidden, server: { kind, ...server } };
}

/**
 * What Local AI's server answers POST {address}/responses with an empty body, which names no model, so nothing loads
 * on the server: { has, status, words }. has is false only for a clear "no such address": a 404 that names no model
 * (Ollama before 0.13.3, llama-server before b7793's "File Not Found", a chat-completions-only server) or old LM
 * Studio's "Unexpected endpoint" answer. Anything else (a 400 or 422 for the missing input or model, no answer at all)
 * says nothing against it. status and words let Test tell a key the server turned down (401) or a model still loading
 * (503) from a pass. Never throws.
 */
export async function localResponsesCheck({ url, key = null, fetch: doFetch = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await doFetch(`${String(url).trim().replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { has: true, status: null, words: "" };
  }
  let words = "";
  try {
    words = await res.text();
    const j = JSON.parse(words);
    const said = typeof j?.error === "string" ? j.error : j?.error?.message ?? j?.detail ?? j?.message;
    if (typeof said === "string") words = said;
  } catch { /* plain text, or nothing */ }
  const has = !(res.status === 404 && !/model/i.test(words)) && !/Unexpected endpoint or method/i.test(words);
  return { has, status: res.status, words };
}

/** Whether Local AI's server has the Responses API (localResponsesCheck's has). Never throws. */
export async function localHasResponses(opts = {}) {
  return (await localResponsesCheck(opts)).has;
}

/** A context size in the words a card uses: 65536 as "64K", 128000 as "128K". */
export function contextWords(n) {
  const v = Number(n);
  if (!(v > 0)) return "";
  return v % 1024 === 0 ? `${v / 1024}K` : `${Math.round(v / 1000)}K`;
}

/**
 * Where a probe of a provider's own host goes: its code constant, or, in a test server only (engine-env testBaseUrl:
 * NODE_ENV exactly "test" and a loopback TARSEE_TEST_BASE_URL_<ID>), the same path on the fake standing in for that
 * provider, so a test's made-up key never goes to the real provider.
 */
function probeUrl(p, url, env) {
  const seam = testBaseUrl(p.id, env);
  if (!seam) return url;
  const u = new URL(url);
  return `${new URL(seam).origin}${u.pathname}${u.search}`;
}

/** The OpenAI key's model ids from GET /v1/models, or a failure outcome. */
export async function listOpenAIModels({ key, fetch: doFetch, timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  const p = getProvider("openai");
  const url = probeUrl(p, p.testProbe.url, env);
  const r = await get(url, { fetch: doFetch, headers: authHeaders(p, key), timeoutMs });
  if (r.network || r.status < 200 || r.status >= 300) return { ok: false, ...failure(p, r, url) };
  return { ok: true, models: modelIdsFrom(r.json) };
}

// --- Balances ------------------------------------------------------------------------------------------------------

/** Read a provider's balance now with the given key: {ok, balance} or a failure outcome. */
export async function fetchBalance(idOrAlias, { key, fetch: doFetch, timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  const p = getProvider(idOrAlias);
  if (!p || !p.balanceProbe || !BALANCE_PARSERS[p.id]) return { ok: false, state: "error", message: "This AI has no balance to read." };
  const url = probeUrl(p, p.balanceProbe.url, env);
  const r = await get(url, { fetch: doFetch, headers: authHeaders(p, key), timeoutMs });
  if (r.network || r.status < 200 || r.status >= 300) return { ok: false, ...failure(p, r, url) };
  const balance = BALANCE_PARSERS[p.id](r.json);
  if (!balance) return { ok: false, state: "error", reason: "unexpected", message: `${p.label} answered in a way Tarsee didn't expect.` };
  return { ok: true, balance };
}

/**
 * The stored key's balance for OpenRouter or DeepSeek, from the 10-minute cache or read fresh (force reads it
 * anyway). null when there is no key or the read failed: a card without a balance is better than a slow page. The
 * key here may be one nobody has tested yet (a Railway variable), so the answer also shows on its card, as Test's
 * does: a key the provider turned down sets the "auth" failure flag (the card, the wizard and the header then say it
 * was rejected), and a read that works clears that flag. No connection, a timeout or the provider's own outage say
 * nothing about the key and change nothing.
 */
export async function refreshBalance(idOrAlias, { store, fetch: doFetch, now = Date.now, force = false, timeoutMs = BALANCE_TIMEOUT_MS, env = process.env } = {}) {
  const p = getProvider(idOrAlias);
  if (!p || !BALANCE_PROVIDERS.includes(p.id) || !store?.getKeyWithSource) return null;
  const cred = store.getKeyWithSource(p.id);
  if (!cred.key || !checkKeySlot(p.id, cred.key).ok) return null;
  const at = typeof now === "function" ? now() : now;
  if (!force) {
    const cached = cachedBalance(store, p.id, { now: at, keyHint: cred.hint });
    if (cached) return cached;
  }
  const r = await fetchBalance(p.id, { key: cred.key, fetch: doFetch, timeoutMs, env });
  if (!r.ok) {
    if (r.reason === "auth") {
      try { setFailureFlag(store, p.id, "auth", r.message); } catch (err) { console.warn(`[ai] ${p.id}'s card couldn't be flagged: ${err?.message || err}`); }
    }
    return null;
  }
  try {
    if (failureFlag(store, p.id)?.state === "auth") clearFailureFlag(store, p.id);
  } catch (err) { console.warn(`[ai] ${p.id}'s card flag couldn't be cleared: ${err?.message || err}`); }
  saveBalance(store, p.id, r.balance, { now: at, keyHint: cred.hint });
  return { ...r.balance, at, keyHint: cred.hint };
}

// --- Test ----------------------------------------------------------------------------------------------------------

const thousands = (n) => Number(n).toLocaleString("en-US");

/** Too little context for Tarsee, in the words for the server it runs on. */
function tooSmallMessage(kind, model, n) {
  const room = `room for only ${thousands(n)} tokens. Tarsee needs at least ${thousands(MIN_LOCAL_CONTEXT)}.`;
  if (kind === "llama.cpp") return `llama.cpp was started with ${room} Start it again with -c 65536.`;
  if (kind === "LM Studio") return `LM Studio loaded ${model} with ${room} Load it again with a longer context length (65536 is a good choice).`;
  if (kind === "Ollama") return `Ollama runs ${model} with ${room} Set OLLAMA_CONTEXT_LENGTH=65536 where Ollama runs (or the model's num_ctx), then start it again.`;
  return `Your Local AI gives ${model} ${room} Give it a larger context on your server.`;
}

/**
 * Test's answer for Local AI from its model list (listLocalModels) and its Responses check (localResponsesCheck), for
 * the card's model (chosen): {ok, state, message, models?, rows?, reason?, server?}. rows, when there, are the models
 * for the catalog: a server that lists chat models and has the Responses API fills it even when Test still fails on
 * its build or its context, so the card shows what was found.
 */
export function localOutcome(p, url, r, check, chosen = null) {
  if (!r.ok) return r;
  if (check.status === 401 || check.status === 403 || r.server?.authFailed) {
    return { ok: false, state: "error", reason: "auth", httpStatus: check.status || r.server.authFailed, message: p.errorHints?.auth || "Your Local AI turned down Tarsee's key." };
  }
  if ((check.status === 503 && /loading/i.test(check.words)) || r.server?.loading) {
    return { ok: false, state: "error", reason: "loading", httpStatus: 503, message: "Your Local AI is still loading its model. Click Test again in a minute." };
  }
  const usable = r.rows.filter((m) => !/\s/.test(m.id));
  const spaced = r.rows.filter((m) => /\s/.test(m.id)).map((m) => m.id);
  if (!r.rows.length) {
    const only = r.hidden?.length ? ` It has only ${r.hidden.length === 1 ? "an embedding model" : "embedding models"} (${r.hidden.slice(0, 3).join(", ")}), which can't chat.` : "";
    return { ok: false, state: "needs-setup", message: `Reached your Local AI, but it lists no models it can chat with.${only} Load one on that machine first: ollama pull qwen3, or start llama-server with -hf and a model (the guide below has the command).` };
  }
  if (!check.has) {
    // It lists models but can't run a turn: every model would fail the same way, so none goes in the picker.
    return { ok: false, state: "needs-setup", reason: "no-responses", message: localNoResponsesMessage(url).replace(/\*\*/g, "") };
  }
  const s = r.server || {};
  if (!usable.length) {
    return { ok: false, state: "needs-setup", message: `Your Local AI names its model "${spaced[0]}", with spaces in it, which Tarsee can't use. Start llama-server with --alias and a short name (for example --alias qwen3.5-9b).` };
  }
  const models = usable.map((m) => m.id);
  const name = s.kind === "llama.cpp" && s.build ? `llama.cpp ${s.build}` : s.kind;
  // The context the card's model gets: its own, or the one size the server gives every model (llama-server).
  const row = usable.find((m) => m.id === chosen) || (usable.length === 1 ? usable[0] : null);
  const sizes = [...new Set(usable.map((m) => m.serverContext).filter(Boolean))];
  const context = row?.serverContext || (sizes.length === 1 && s.kind === "llama.cpp" ? sizes[0] : null);
  const base = { rows: usable, models, server: { kind: s.kind ?? null, build: s.build ?? null, context: context ?? null } };
  if (s.kind === "llama.cpp" && s.buildNumber && s.buildNumber < MIN_LLAMACPP_BUILD) {
    return { ...base, ok: false, state: "needs-setup", reason: "old-build", message: `Update llama.cpp to b${MIN_LLAMACPP_BUILD} or newer: older builds can mix up tool calls. This one is ${s.build}.` };
  }
  if (context && context < MIN_LOCAL_CONTEXT) {
    return { ...base, ok: false, state: "needs-setup", reason: "small-context", message: tooSmallMessage(s.kind, row?.id || models[0], context) };
  }
  const parts = ["Reached your Local AI"];
  if (name) parts.push(name);
  parts.push(`${models.length} model${models.length === 1 ? "" : "s"}`);
  if (context) parts.push(`${contextWords(context)} context`);
  let message = parts.join(" · ");
  if (spaced.length) message += `. ${spaced.length === 1 ? "One model name has" : `${spaced.length} model names have`} spaces in it, which Tarsee can't use: start llama-server with --alias and a short name.`;
  return { ...base, ok: true, state: "ready", message };
}

function keyOutcome(p, kind, { balance } = {}) {
  if (kind === "openrouter-empty") {
    return { ok: false, state: "out-of-credit", reason: "billing", message: "Key works, but its spending limit is used up. Raise it at openrouter.ai/settings/keys.", balance };
  }
  return { ok: false, state: "out-of-credit", reason: "billing", message: `Key works, but the balance is empty. Top up at ${String(p.errorHints?.topUpUrl || "").replace(/^https:\/\//, "").replace(/\/.*$/, "") || "the provider"}.`, balance };
}

/**
 * The Test button: a cheap live check of one provider (see the top of this file).
 * deps: { store, env, fetch, apiKey (a pasted key to check without saving it), timeoutMs, now, ...providerStatus deps }
 * A wrong-slot pasted key answers {ok:false, badKey:true} without being sent anywhere.
 */
export async function probeProvider(idOrAlias, deps = {}) {
  const p = getProvider(idOrAlias);
  if (!p) return { ok: false, state: "error", message: `Tarsee doesn't know an AI called "${idOrAlias}".` };
  const { store, env = process.env, fetch: doFetch = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = deps;
  const clock = typeof deps.now === "function" ? deps.now : () => (deps.now ?? Date.now());

  // The plans: their sign-in, no network. Asking again means "I've fixed it": a sign-in that is there clears an old flag.
  if (p.kind === "subscription") {
    const s = await providerStatus(p.id, { ...deps, ignoreFlags: true, loginCli: true });
    if (s.ready) clearFailureFlag(store, p.id);
    const message = s.ready ? (s.account ? `Signed in as ${s.account}.` : s.detail) : `${s.detail}${s.fix ? ` ${s.fix}` : ""}`;
    return { ok: s.ready, state: s.state, message, account: s.account ?? null };
  }

  const candidate = deps.apiKey !== undefined && deps.apiKey !== null && cleanKey(deps.apiKey) !== "";
  let key;
  if (candidate) {
    key = cleanKey(deps.apiKey);
    if (/[\r\n\0]/.test(key)) return { ok: false, state: "error", badKey: true, message: "This key has a line break in it; paste it again." };
    const slot = checkKeySlot(p.id, key);
    if (!slot.ok) return { ok: false, state: "error", badKey: true, message: slot.message };
  } else {
    const cred = store?.getKeyWithSource ? store.getKeyWithSource(p.id) : { key: null };
    key = cred.key;
    if (key) {
      const slot = checkKeySlot(p.id, key);
      if (!slot.ok) return { ok: false, state: "error", message: slot.message };
    }
  }

  let out;
  if (p.id === "local") {
    const url = localUrlFor(store, env);
    if (!url || !plainHttpUrl(url)) {
      const s = await providerStatus("local", deps);
      return { ok: false, state: "needs-setup", message: `${s.detail} ${s.fix || ""}`.trim() };
    }
    // Both asked at once, so a server that doesn't answer keeps Test waiting no longer than before.
    const responses = localResponsesCheck({ url, key, fetch: doFetch, timeoutMs });
    const r = await listLocalModels({ url, key, fetch: doFetch, timeoutMs });
    out = localOutcome(p, url, r, await responses, chosenModel("local", store, env));
    if (out.rows) setLocalModels(out.rows, store);
    delete out.rows;
  } else {
    if (!key) {
      const s = await providerStatus(p.id, deps);
      return { ok: false, state: "needs-key", message: `${s.detail} ${s.fix || ""}`.trim() };
    }
    if (BALANCE_PARSERS[p.id]) {
      const r = await fetchBalance(p.id, { key, fetch: doFetch, timeoutMs, env });
      if (!r.ok) out = r;
      else {
        if (!candidate) saveBalance(store, p.id, r.balance, { now: clock(), keyHint: store.getKeyWithSource(p.id).hint });
        if (r.balance.empty) out = keyOutcome(p, p.id === "openrouter" ? "openrouter-empty" : "prepaid-empty", { balance: r.balance });
        else out = { ok: true, state: "ready", message: `Key works · ${r.balance.text}`, balance: r.balance };
      }
    } else if (p.id === "openai") {
      const r = await listOpenAIModels({ key, fetch: doFetch, timeoutMs, env });
      if (!r.ok) out = r;
      else {
        if (!candidate && r.models.length) setCatalogModels("openai-models", r.models.map((id) => ({ id })));
        out = { ok: true, state: "ready", message: `Key works · ${r.models.length} model${r.models.length === 1 ? "" : "s"} available`, models: r.models };
      }
    } else {
      const url = probeUrl(p, p.testProbe.url, env);
      const r = await get(url, { fetch: doFetch, headers: authHeaders(p, key), timeoutMs });
      out = r.network || r.status < 200 || r.status >= 300 ? failure(p, r, url) : { ok: true, state: "ready", message: "Key works." };
    }
  }

  // The stored key's result shows on its card, flagged as the turn layer flags it (turn.js writeFailureFlag): a
  // rejected key is "auth", an empty balance or used-up limit "out-of-credit".
  if (!candidate && store) {
    if (out.ok) clearFailureFlag(store, p.id);
    else if (out.reason === "auth") setFailureFlag(store, p.id, "auth", out.message);
    else if (out.reason === "billing") setFailureFlag(store, p.id, "out-of-credit", out.message);
  }
  const { reason, ...answer } = out;
  return answer;
}
