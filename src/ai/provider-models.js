/**
 * provider-models.js: the models a key (or a Local AI server) can use, read from the provider itself (design 4.11).
 *
 *   openai    GET https://api.openai.com/v1/models with the key. The registry's OpenAI table is narrowed to the models
 *             the key lists (setCatalogModels "openai-models"), so the picker never offers one the key can't use.
 *   deepseek  GET https://api.deepseek.com/models with the key: confirms the static table (DeepSeek's model ids and
 *             prices are code constants) and names any model the table doesn't know yet.
 *   local     GET {the server's address}/models, with Local AI's own key when it has one. Every model the server
 *             lists that can chat becomes a choice (setLocalModels "local-models"; embedding models are left out),
 *             with its context: the server's own size when it says one (llama-server, LM Studio, Ollama), else the
 *             card's, else 128K (provider-registry.js localContextTokens).
 * The Claude catalog is lib/model-catalog.js, OpenRouter's is lib/openrouter-catalog.js and the ChatGPT account's list
 * comes from Codex (ai/codex-models.js).
 *
 * A key only ever goes to its own provider's host: the address comes from engine-env.js hostFor(), the one way to get
 * a host (code constants; Local AI's own address; the test-only loopback seam). Requests never follow a redirect, a
 * key pasted into the wrong card is refused before anything is sent, and no error ever carries the key or the
 * provider's answer text.
 */
import { PROVIDERS, getProvider, setCatalogModels, setLocalModels, modelsFor } from "./provider-registry.js";
import { hostFor, CredentialError } from "./engine-env.js";
import { describeLocalModels } from "./provider-probes.js";

const CODEX = "codex";
const TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const SUPPORTED = new Set(["openai", "deepseek", "local"]);

/**
 * GET <host>/models for openai, deepseek or local.
 * opts: key (the provider's key; optional for local), localUrl (Local AI's address), env (for the test seam; default
 * process.env), fetch (default globalThis.fetch), signal, timeoutMs.
 * Returns { ok: true, status, ids } or { ok: false, code, status?, error } where code is one of not-supported,
 * needs-key, bad-key, needs-setup, unreachable, auth, billing, rate, error.
 */
export async function listProviderModels(providerId, opts = {}) {
  const entry = getProvider(providerId);
  if (!entry || !SUPPORTED.has(entry.id)) {
    return { ok: false, code: "not-supported", error: "Tarsee reads this AI's models another way." };
  }
  const label = entry.label;
  const key = cleanKey(opts.key);
  const keyOptional = entry.id === "local";
  if (!key && !keyOptional) {
    return { ok: false, code: "needs-key", error: `${label} needs its API key first (Settings > AI, or the ${entry.envKey} variable).` };
  }
  if (key) {
    if (/[\r\n\0]/.test(key)) return { ok: false, code: "bad-key", error: `The ${label} key has a line break in it; paste it again.` };
    for (const slot of entry.wrongSlot || []) {
      if (slot.re.test(key)) return { ok: false, code: "bad-key", error: slot.message };
    }
  }

  let host;
  try {
    host = hostFor(entry, CODEX, { env: opts.env ?? process.env, localUrl: opts.localUrl });
  } catch (err) {
    if (err instanceof CredentialError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
  const url = `${String(host).replace(/\/+$/, "")}/models`;

  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  let res;
  try {
    // redirect "error": a redirect could carry the key to another host.
    res = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal });
  } catch (err) {
    const why = timeout.aborted ? "it took too long to answer" : (err?.cause?.code || err?.code || "network error");
    if (entry.id === "local") {
      return { ok: false, code: "unreachable", error: entry.errorHints.unreachable.replace("{url}", String(opts.localUrl ?? host).trim()) };
    }
    return { ok: false, code: "unreachable", error: `Tarsee couldn't reach ${label} (${why}).` };
  }

  if (!res.ok) return { ok: false, status: res.status, ...statusError(entry, res.status, host) };

  let body;
  try {
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) throw new Error("too big");
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: "error", status: res.status, error: `${label}'s model list couldn't be read.` };
  }
  const ids = idsOf(body);
  if (!ids) return { ok: false, code: "error", status: res.status, error: `${label}'s answer isn't a model list.` };
  if (entry.id === "local") {
    // What the server says about each model (provider-probes.js describeLocalModels): its real context, and no
    // embedding models (they can't chat).
    const d = await describeLocalModels(body, host, { key, fetch: fetchImpl, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS });
    return { ok: true, status: res.status, ids: d.models, rows: d.rows, hidden: d.hidden, server: d.server };
  }
  return { ok: true, status: res.status, ids };
}

/**
 * Read a provider's model list and put it to use.
 * opts: as listProviderModels, plus store (SettingsStore): the key comes from it when not handed in (encrypted
 * Settings, then the provider's Railway variable: getKeyWithSource), and Local AI's address from ai.local.baseUrl,
 * else TARSEE_LOCAL_AI_URL. A list that can't be read leaves the registry as it was.
 * Returns the listProviderModels result plus:
 *   openai    models: the table rows the key can use ({id, label})
 *   deepseek  models: the table rows with confirmed true or false; extra: ids the table doesn't know
 *   local     models: the server's models ({id, label, context})
 */
export async function refreshProviderModels(providerId, opts = {}) {
  const entry = getProvider(providerId);
  if (!entry || !SUPPORTED.has(entry.id)) return listProviderModels(providerId, opts);
  const store = opts.store || null;
  const env = opts.env ?? process.env;
  const key = opts.key !== undefined ? opts.key : readKey(store, entry);
  const localUrl = entry.id === "local"
    ? (opts.localUrl ?? nonEmpty(readSetting(store, "ai.local.baseUrl")) ?? nonEmpty(env?.[entry.urlEnv]))
    : undefined;
  const out = await listProviderModels(entry.id, { ...opts, key, localUrl, env });
  if (!out.ok) return out;

  if (entry.id === "openai") {
    setCatalogModels("openai-models", out.ids.map((id) => ({ id })));
    return { ...out, models: modelsFor("openai").map((m) => ({ id: m.id, label: m.label })) };
  }
  if (entry.id === "deepseek") {
    const listed = new Set(out.ids);
    const known = new Set(PROVIDERS.deepseek.models.map((m) => m.id));
    return {
      ...out,
      models: PROVIDERS.deepseek.models.map((m) => ({ id: m.id, label: m.label, confirmed: listed.has(m.id) })),
      extra: out.ids.filter((id) => !known.has(id)),
    };
  }
  setLocalModels(out.rows || out.ids, store);
  return { ...out, models: modelsFor("local").map((m) => ({ id: m.id, label: m.label, context: m.context, serverContext: m.serverContext ?? null })) };
}

/** After a Local AI server couldn't be read, how long before it is asked again (a turn would otherwise wait each time). */
const LOCAL_RETRY_MS = 60_000;
/** How long a read for a waiting turn may take (Test and Settings > AI take the usual 15 s). */
const LOCAL_READ_TIMEOUT_MS = 5_000;
let _localRead = null;
let _localFailed = null;

/**
 * Local AI's models when nothing has read them since the server started: the runtime catalog lives only in memory,
 * and Local AI has no default model, so an install set up only through Railway variables (TARSEE_LOCAL_AI_URL, no
 * TARSEE_AI_MODEL) would otherwise count as "no model chosen" after every restart until someone opened Settings > AI.
 * Reads the server at ai.local.baseUrl, else TARSEE_LOCAL_AI_URL (refreshProviderModels), once for callers asking
 * together; a server that can't be read (or lists nothing) isn't asked again at that address for a minute.
 * Resolves the models now in the catalog ([] when there are none). Never throws.
 * opts: env, fetch, now, timeoutMs (5 s).
 */
export async function ensureLocalModels(store, { env = process.env, fetch, now = Date.now, timeoutMs = LOCAL_READ_TIMEOUT_MS } = {}) {
  if (modelsFor("local").length) return modelsFor("local");
  const url = nonEmpty(readSetting(store, "ai.local.baseUrl")) ?? nonEmpty(env?.[PROVIDERS.local.urlEnv]);
  if (!url) return [];
  if (_localFailed && _localFailed.url === url && now() - _localFailed.at < LOCAL_RETRY_MS) return [];
  if (!_localRead || _localRead.url !== url) {
    const failed = () => { _localFailed = { url, at: now() }; };
    const promise = refreshProviderModels("local", { store, env, localUrl: url, fetch, timeoutMs })
      .then((r) => {
        if (r?.ok && modelsFor("local").length) _localFailed = null;
        else {
          failed();
          console.warn(`[models] Local AI's model list couldn't be read at ${url}: ${r?.error || "it lists no models"}`);
        }
      })
      .catch((err) => { failed(); console.warn(`[models] Local AI's model list couldn't be read: ${err?.message || err}`); })
      .finally(() => { if (_localRead?.promise === promise) _localRead = null; });
    _localRead = { url, promise };
  }
  await _localRead.promise;
  return modelsFor("local");
}

/** Forget a read in progress and a remembered failure (tests; a changed Local AI card reads at once anyway). */
export function forgetLocalModelsRead() {
  _localRead = null;
  _localFailed = null;
}

/** A non-2xx answer in plain words: the provider's own hints where it has them. */
function statusError(entry, status, host) {
  const label = entry.label;
  if (status === 401 || status === 403) return { code: "auth", error: entry.errorHints.auth || `${label} turned down the key.` };
  if (status === 402) return { code: "billing", error: entry.errorHints.billing || `${label} says the account is out of credit.` };
  if (status === 429) return { code: "rate", error: `${label} is busy right now; try again in a minute.` };
  if (status === 404 && entry.id === "local") {
    return {
      code: "needs-setup",
      error: `Your Local AI at ${host} has no model list there. Check the address: it usually ends in /v1 (Ollama: http://<computer>:11434/v1, LM Studio: http://<computer>:1234/v1, llama.cpp: http://<computer>:9931/v1, or 8080 for older builds and Docker).`,
    };
  }
  return { code: "error", error: `${label} answered ${status} when asked for its models.` };
}

/** Model ids from an OpenAI-style {data:[{id}]} list, or Ollama's own {models:[{name|model}]}; null for neither. */
function idsOf(body) {
  let rows = null;
  if (Array.isArray(body?.data)) rows = body.data;
  else if (Array.isArray(body?.models)) rows = body.models;
  if (!rows) return null;
  const out = [];
  for (const r of rows) {
    const id = typeof r === "string" ? r : (r?.id ?? r?.model ?? r?.name);
    if (typeof id === "string" && id.trim() && !out.includes(id.trim())) out.push(id.trim());
  }
  return out;
}

function readKey(store, entry) {
  try { return store?.getKeyWithSource?.(entry.storageId)?.key ?? null; } catch { return null; }
}

function readSetting(store, key) {
  try { return store?.get?.(key) ?? null; } catch { return null; }
}

function cleanKey(v) {
  if (v === null || v === undefined) return null;
  const k = String(v).trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return k || null;
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function positiveInt(v) {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
