/**
 * spend.js: what AI work costs in dollars, and the two limits on it (design 4.13 and 4.6h).
 *
 *   priceUsage(providerId, model, usage, at, store)   a turn's (or a call's) tokens in USD, or null when nothing is
 *                                                     billed per token here: the plans ("Included in plan"), the
 *                                                     Anthropic key (its engine reports the exact cost), a model
 *                                                     with no known price
 *   checkTurnBudget({...})                            the per-turn ceiling: today's $0.50 background limit on every
 *                                                     metered provider, or the caller's own maxBudgetUsd
 *   monthlySpend(db, {now, timeZone})                 this calendar month's spend in the owner's timezone
 *   withinMonthlyCap(providerId, {store, db, ...})    false when the optional ai.spendCap.monthlyUsd is reached and
 *                                                     the provider bills per use (plans are never blocked)
 *   monthlyCapStatus(providerId, {...})               the same, with the figures and the owner-facing message
 *   recordReportedCost(row, db)                       files an Anthropic key's exact cost for a turn nothing else
 *                                                     records (no live conversation: a subagent, ACP, a Verify probe)
 *   anthropicListCost(model, usage)                   an Anthropic key's turn stopped before its exact cost came: its
 *                                                     tokens so far at the list price, as an estimate
 *
 * Where costs come from: an Anthropic key's are exact (the engine's total_cost_usd); OpenRouter's are exact when
 * its own usage.cost is reported, else the catalog price; DeepSeek, OpenAI and Local AI come from the price table
 * (provider-registry.js priceFor, DeepSeek's peak and off-peak hours included) and are shown as "est.". Plans are
 * never priced. Recorded costs live in usage_turns.cost_usd and usage_calls.cost_usd (migration 012,
 * lib/token-usage.js); spendBetween() adds them up without counting a turn's calls twice.
 *
 * Usage objects use Claude's vocabulary, as the engines' usage events do: input_tokens (new input, cache reads NOT
 * included), output_tokens, cache_read_input_tokens, cache_creation_input_tokens. Tarsee's own row names (input,
 * output, cacheRead, cacheWrite) are accepted too. A reported cost rides along as usage.cost or usage.costUsd.
 */
import { BACKGROUND_DEFAULTS } from "../config/constants.js";
import { capsFor, claudeListPrice, getProvider, normalizeProviderId, priceFor } from "./provider-registry.js";
import config from "../config/env.js";
import { monthStart } from "../lib/local-time.js";

/** The local midnight that began a moment's calendar month (the monthly cap's start). */
export { monthStart };

/** Today's per-turn ceiling for background work (crons, the heartbeat, the boot checklist), on every metered provider. */
export const BACKGROUND_BUDGET_USD = BACKGROUND_DEFAULTS.MAX_BUDGET_USD;

/** The setting that holds the optional monthly cap in USD (empty: off). */
export const SPEND_CAP_KEY = "ai.spendCap.monthlyUsd";

const MILLION = 1_000_000;

// --- What kind of cost a provider has ---

/**
 * Where a provider's cost figure comes from: "plan" (included in a plan, never priced), "exact" (the engine
 * reports it), "estimate" (a price table, shown as "est."), "free" (Local AI with no price set), or null for an
 * unknown provider.
 */
export function costSource(providerId, store = null) {
  const p = getProvider(providerId);
  if (!p) return null;
  if (p.kind === "subscription") return "plan";
  if (p.id === "anthropic") return "exact";
  if (p.id === "local") return localPriced(store) ? "estimate" : "free";
  return "estimate";
}

/** Whether a provider bills per use: every key provider, and Local AI only when its card sets a price. Plans never. */
export function isMetered(providerId, store = null) {
  const p = getProvider(providerId);
  if (!p || p.kind === "subscription") return false;
  if (p.id === "local") return localPriced(store);
  return true;
}

function localPriced(store) {
  const r = priceFor("local", null, null, store);
  return !!r && (r.in > 0 || r.out > 0 || r.cacheRead > 0 || r.cacheWrite > 0);
}

// --- Pricing ---

/** The four token counts of a usage object, in either vocabulary. */
export function tokensOf(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const n = (...vals) => {
    for (const v of vals) { const x = Number(v); if (Number.isFinite(x) && x > 0) return x; }
    return 0;
  };
  return {
    input: n(u.input_tokens, u.input),
    output: n(u.output_tokens, u.output),
    cacheRead: n(u.cache_read_input_tokens, u.cacheRead, u.cache_read),
    cacheWrite: n(u.cache_creation_input_tokens, u.cacheWrite, u.cache_write),
  };
}

/** A cost the provider itself reported (OpenRouter's usage.cost), or null. */
function reportedCost(usage) {
  if (!usage || typeof usage !== "object") return null;
  for (const v of [usage.cost, usage.costUsd, usage.cost_usd]) {
    const x = typeof v === "string" && v.trim() ? Number(v) : v;
    if (typeof x === "number" && Number.isFinite(x) && x >= 0) return x;
  }
  return null;
}

/**
 * What a usage costs in USD on a provider and model at a moment, with where the figure came from:
 * { usd, source: "reported" | "price-table", estimated, peak } or null when nothing is billed per token here.
 * `at` is a Date, ms or an ISO string; null or undefined is now (DeepSeek's peak hours depend on it).
 */
export function priceUsageDetail(providerId, model, usage, at = null, store = null) {
  const p = getProvider(providerId);
  if (!p || p.kind === "subscription") return null;
  const reported = reportedCost(usage);
  if (reported != null) return { usd: reported, source: "reported", estimated: false, peak: null };
  const rates = priceFor(p.id, typeof model === "string" ? model : null, at ?? new Date(), store);
  if (!rates) return null;
  const t = tokensOf(usage);
  const usd = (t.input * rates.in + t.output * rates.out + t.cacheRead * rates.cacheRead + t.cacheWrite * rates.cacheWrite) / MILLION;
  return { usd: round(usd), source: "price-table", estimated: true, peak: rates.peak };
}

/** What a usage costs in USD, or null (plans, the Anthropic key's engine-reported cost, an unpriced model). */
export function priceUsage(providerId, model, usage, at = null, store = null) {
  return priceUsageDetail(providerId, model, usage, at, store)?.usd ?? null;
}

/**
 * An Anthropic key's turn that ended before its engine reported the exact cost (a Stop, a timeout, a crash): its
 * tokens so far at Anthropic's list price (provider-registry.js claudeListPrice), an estimate; null when no price is
 * known. Only ever the turn's own figure: the key's calls stay unpriced, so nothing is counted twice.
 */
export function anthropicListCost(model, usage) {
  const rates = claudeListPrice(model);
  if (!rates) return null;
  const t = tokensOf(usage);
  return round((t.input * rates.in + t.output * rates.out + t.cacheRead * rates.cacheRead + t.cacheWrite * rates.cacheWrite) / MILLION);
}

// --- The per-turn ceiling ---

/**
 * Whether a turn has gone over its dollar ceiling (design 4.6h). opts:
 *   providerId, model     the turn's target
 *   usage                 the turn's token totals so far (priced here), or
 *   costUsd               a cost the provider or engine reported for the turn so far, or
 *   spentUsd              the caller's own running sum of priced usage
 *   maxBudgetUsd          the ceiling; without one a background turn gets BACKGROUND_BUDGET_USD, an interactive none
 *   background            true for crons, the heartbeat, the boot checklist
 *   at, store, caps       the moment (DeepSeek's hours), the settings store, capsFor()'s answer if already known
 * Returns { metered, enforcedBy, limitUsd, spentUsd, estimated, tripped, over, subtype, message }:
 *   enforcedBy  "engine" when the engine enforces the ceiling itself (the Anthropic key: pass maxBudgetUsd to it),
 *               "tarsee" when this check does, null when there is no ceiling
 *   tripped     true once the spend is over the ceiling; the turn layer then stops the turn with
 *               error{subtype:"error_max_budget_usd", message} and done{stopReason:"error_max_budget_usd"}
 *   over        the same as tripped (the name ai/turn.js reads)
 * Plans are never metered here, so they never trip it.
 */
export function checkTurnBudget(opts = {}) {
  const id = normalizeProviderId(opts.providerId ?? opts.provider) || null;
  const store = opts.store || null;
  const metered = id ? isMetered(id, store) : false;
  const own = positive(opts.maxBudgetUsd);
  const limit = own ?? (opts.background ? BACKGROUND_BUDGET_USD : null);
  const out = { metered, enforcedBy: null, limitUsd: metered ? limit : null, spentUsd: null, estimated: false, tripped: false, over: false, subtype: null, message: null };
  if (!metered) return out;

  let spent = null;
  let estimated = false;
  const reported = finiteNonNeg(opts.costUsd);
  const running = finiteNonNeg(opts.spentUsd);
  if (reported != null) spent = reported;
  else if (running != null) { spent = running; estimated = opts.estimated ?? costSource(id, store) !== "exact"; }
  else {
    const d = priceUsageDetail(id, opts.model, opts.usage, opts.at ?? null, store);
    if (d) { spent = d.usd; estimated = d.estimated; }
  }
  out.spentUsd = spent;
  out.estimated = estimated;

  const native = opts.caps?.nativeBudget ?? capsFor(id, opts.model, store)?.nativeBudget;
  if (limit == null) return out;
  if (native) { out.enforcedBy = "engine"; return out; }
  out.enforcedBy = "tarsee";
  if (spent != null && spent > limit + 1e-12) {
    out.tripped = true;
    out.over = true;
    out.subtype = "error_max_budget_usd";
    out.message = `Stopped after reaching this task's spending limit of ${money(limit)} (about ${money(spent)} so far${estimated ? ", estimated" : ""}).`;
  }
  return out;
}

// --- What has been spent ---

/**
 * The recorded spend between two moments, per provider: { totalUsd, byProvider: { id: usd }, estimated }. Each turn
 * counts once at its end (its own cost_usd: its calls' sum, or the engine's exact figure), and calls that belong to
 * no turn count themselves, so nothing is counted twice. Plans never add anything. provider: only that one.
 * estimated is true when any counted row is Tarsee's estimate rather than the provider's own figure (a turn without
 * cost_exact, or a call in no turn, which is always priced from the table).
 */
export function spendBetween(db, from, to = Number.MAX_SAFE_INTEGER, { provider = null } = {}) {
  const only = provider ? normalizeProviderId(provider) : null;
  const byProvider = {};
  let totalUsd = 0;
  let estimated = 0;
  if (!db) return { totalUsd, byProvider, estimated: false };
  const sql = (exactCol) => `SELECT p AS provider, SUM(c) AS usd, SUM(e) AS est FROM (
        SELECT COALESCE(provider, 'claude') AS p, cost_usd AS c, ${exactCol} AS e FROM usage_turns
          WHERE cost_usd IS NOT NULL AND COALESCE(ended_at, last_call_at, started_at) >= ? AND COALESCE(ended_at, last_call_at, started_at) < ?
        UNION ALL
        SELECT COALESCE(provider, 'claude') AS p, cost_usd AS c, 1 AS e FROM usage_calls
          WHERE cost_usd IS NOT NULL AND turn_id IS NULL AND ended_at >= ? AND ended_at < ?
      ) GROUP BY p`;
  let rows = [];
  try {
    rows = db.prepare(sql("1 - COALESCE(cost_exact, 0)")).all(from, to, from, to);
  } catch {
    // A usage table from before cost_exact: every figure in it is an estimate.
    try { rows = db.prepare(sql("1")).all(from, to, from, to); } catch { return { totalUsd, byProvider, estimated: false }; }   // no usage tables yet
  }
  for (const r of rows) {
    const id = normalizeProviderId(r.provider);
    if (!id || getProvider(id).kind === "subscription") continue;
    if (only && id !== only) continue;
    const usd = Number(r.usd) || 0;
    byProvider[id] = round((byProvider[id] || 0) + usd);
    totalUsd += usd;
    estimated += Number(r.est) || 0;
  }
  return { totalUsd: round(totalUsd), byProvider, estimated: estimated > 0 };
}

/**
 * File a provider's own exact cost for a turn that nothing else will put a cost on: an Anthropic key's turn with no
 * live conversation (a subagent, ACP, a Verify probe). Its transcript's calls are never priced (the key's figure is
 * exact, priceUsage gives null), and with no turn_end the usage index never reads the figure either, so without this
 * the turn would add nothing to spendBetween, the monthly cap and the Usage page. It becomes that turn's row in
 * usage_turns (cost_exact 1, which the index never overwrites, unless row.exact is false: a turn stopped before the
 * engine's figure came, priced at the list price); its calls stay unpriced and in no turn, so nothing is counted
 * twice. Recording the same turn again replaces its figure.
 * row: { turnId, conversationId, source?, provider, engine, model?, effort?, startedAt, endedAt?, stopReason?, costUsd, exact? }
 * Returns { recorded: true } or { recorded: false, reason }. Never throws: usage is bookkeeping.
 */
export function recordReportedCost(row = {}, db = null) {
  if (!db || typeof db.prepare !== "function") return { recorded: false, reason: "no-db" };
  const id = normalizeProviderId(row.provider);
  if (!id || getProvider(id).kind === "subscription") return { recorded: false, reason: "provider" };
  const turnId = typeof row.turnId === "string" ? row.turnId.trim() : "";
  const conversationId = typeof row.conversationId === "string" ? row.conversationId.trim() : "";
  if (!turnId || !conversationId) return { recorded: false, reason: "turn" };
  const cost = finiteNonNeg(Number(row.costUsd));
  if (cost == null || cost === 0) return { recorded: false, reason: "cost" };
  const endedAt = Number.isFinite(Number(row.endedAt)) && Number(row.endedAt) > 0 ? Math.round(Number(row.endedAt)) : Date.now();
  const startedAt = Number.isFinite(Number(row.startedAt)) && Number(row.startedAt) > 0 ? Math.round(Number(row.startedAt)) : endedAt;
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  try {
    db.prepare(`INSERT INTO usage_turns (turn_id, conversation_id, source, model, effort, started_at, ended_at, stop_reason, provider, engine, cost_usd, cost_exact)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET cost_usd = excluded.cost_usd, cost_exact = excluded.cost_exact, ended_at = excluded.ended_at,
        stop_reason = COALESCE(excluded.stop_reason, usage_turns.stop_reason)`)
      .run(turnId, conversationId, text(row.source), text(row.model), text(row.effort), startedAt, endedAt, text(row.stopReason), id, text(row.engine), round(cost), row.exact === false ? 0 : 1);
    return { recorded: true };
  } catch (err) {
    console.warn(`[spend] a turn's cost couldn't be recorded: ${err?.message || err}`);
    return { recorded: false, reason: "error" };
  }
}

/**
 * This calendar month's spend in the owner's timezone: { totalUsd, byProvider, from, to, timeZone }.
 * Takes (db, opts) or ({ db, ... }); opts: now (ms), timeZone (default config.TIMEZONE), provider (only that one),
 * store (its db is used when no db is given).
 */
export function monthlySpend(dbOrOpts, opts = {}) {
  const o = argsOf(dbOrOpts, opts);
  const now = o.now ?? Date.now();
  const timeZone = o.timeZone || config.TIMEZONE;
  const from = monthStart(now, timeZone);
  const s = spendBetween(o.db, from, now + 1, { provider: o.provider });
  return { ...s, from, to: now, timeZone };
}

/** The monthly cap in USD from ai.spendCap.monthlyUsd ("20", "$20", 20), or null when it is off. */
export function spendCapUsd(store) {
  let raw;
  try { raw = store?.get?.(SPEND_CAP_KEY); } catch { raw = null; }
  if (typeof raw === "number") return positive(raw);
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[$,\s]/g, "").replace(/^usd/i, "");
  return v ? positive(Number(v)) : null;
}

/**
 * The monthly cap's answer for a turn on a provider (design 4.6b, refusal "spend-cap"):
 * { ok, metered, capUsd, spentUsd, remainingUsd, subtype, message }. Only providers that bill per use are ever
 * refused; with no cap set everything is ok. opts: store (settings; its db is used when no db is given), db, now,
 * timeZone.
 */
export function monthlyCapStatus(providerOrOpts, opts = {}) {
  const o = typeof providerOrOpts === "object" && providerOrOpts !== null ? providerOrOpts : { ...opts, providerId: providerOrOpts };
  const id = normalizeProviderId(o.providerId ?? o.provider) || null;
  const store = o.store || null;
  const capUsd = spendCapUsd(store);
  const metered = id ? isMetered(id, store) : false;
  const out = { ok: true, metered, capUsd, spentUsd: null, remainingUsd: null, subtype: null, message: null };
  if (capUsd == null || !metered) return out;
  const db = o.db || store?.db || null;
  if (!db) return out;
  const spent = monthlySpend(db, { now: o.now, timeZone: o.timeZone }).totalUsd;
  out.spentUsd = spent;
  out.remainingUsd = round(Math.max(0, capUsd - spent));
  if (spent >= capUsd) {
    out.ok = false;
    out.subtype = "spend-cap";
    out.message = `This month's AI spending has reached the ${money(capUsd)} limit set in Settings > AI (about ${money(spent)} so far). `
      + "Raise or clear the limit there, or switch this chat to a plan, which isn't billed per use.";
  }
  return out;
}

/** Whether a turn on this provider may run under the monthly cap: false only for a metered provider once it is reached. */
export function withinMonthlyCap(providerOrOpts, opts = {}) {
  return monthlyCapStatus(providerOrOpts, opts).ok;
}

// --- Helpers ---

/** "$0.50", "$1,234.00"; under a cent: "under $0.01". */
export function money(usd) {
  const v = Number(usd) || 0;
  if (v > 0 && v < 0.005) return "under $0.01";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function argsOf(dbOrOpts, opts) {
  if (dbOrOpts && typeof dbOrOpts.prepare === "function") return { ...opts, db: dbOrOpts };
  const o = { ...(dbOrOpts || {}), ...opts };
  return { ...o, db: o.db || o.store?.db || null };
}

function positive(v) {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNonNeg(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Dollars to a billionth: no float noise in sums. */
function round(x) {
  return Math.round(x * 1e9) / 1e9;
}
