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
 *   Local AI    GET {address}/models                         (Bearer only when a key is set)
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
} from "./provider-registry.js";
import {
  providerStatus,
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
      return { ok: false, state: "error", reason: "unreachable", message: `Can't reach your Local AI at ${url}.` };
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
  if (s >= 500) {
    return { ok: false, state: "error", reason: "unavailable", httpStatus: s, message: `${label} had a problem on its side (HTTP ${s}). Try again in a minute.` };
  }
  return { ok: false, state: "error", reason: "unexpected", httpStatus: s, message: `${label} answered with HTTP ${s}, which Tarsee didn't expect.` };
}

/** The ids a /models answer lists: OpenAI's {data: [{id}]}, or Ollama's own {models: [{name|model}]}. */
export function modelIdsFrom(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
  const ids = [];
  for (const m of rows) {
    const id = typeof m === "string" ? m : m?.id ?? m?.name ?? m?.model;
    if (typeof id === "string" && id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
  }
  return ids;
}

/** The URL of Local AI's model list: the owner's address (one trailing slash dropped) plus /models. */
export function localModelsUrl(address) {
  return `${String(address).trim().replace(/\/+$/, "")}/models`;
}

/** Local AI's model ids from {address}/models, or a failure outcome. */
export async function listLocalModels({ url, key = null, fetch: doFetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const p = getProvider("local");
  const r = await get(localModelsUrl(url), { fetch: doFetch, headers: key ? { Authorization: `Bearer ${key}` } : {}, timeoutMs });
  if (r.network || r.status < 200 || r.status >= 300) return { ok: false, ...failure(p, r, url) };
  return { ok: true, models: modelIdsFrom(r.json) };
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
    const r = await listLocalModels({ url, key, fetch: doFetch, timeoutMs });
    if (!r.ok) out = r;
    else if (!r.models.length) {
      out = { ok: false, state: "needs-setup", message: "Reached your Local AI, but it lists no models. Download one on that machine first (for example: ollama pull qwen3)." };
    } else {
      setCatalogModels("local-models", r.models.map((id) => ({ id })));
      out = { ok: true, state: "ready", message: `Reached your Local AI · ${r.models.length} model${r.models.length === 1 ? "" : "s"}`, models: r.models };
    }
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
