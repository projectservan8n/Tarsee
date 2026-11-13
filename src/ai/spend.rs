//! Port of `src/ai/spend.js`: what AI work costs in dollars, and the two limits on it (design 4.13 and 4.6h).
//!
//! - [`price_usage`]: a turn's (or a call's) tokens in USD, or `None` when nothing is billed per token here: the plans
//!   ("Included in plan"), the Anthropic key (its engine reports the exact cost), a model with no known price
//! - [`check_turn_budget`]: the per-turn ceiling: today's $0.50 background limit on every metered provider, or the
//!   caller's own `max_budget_usd`
//! - [`monthly_spend`]: this calendar month's spend in the owner's timezone
//! - [`within_monthly_cap`]: false when the optional ai.spendCap.monthlyUsd is reached and the provider bills per use
//!   (plans are never blocked)
//! - [`monthly_cap_status`]: the same, with the figures and the owner-facing message
//! - [`record_reported_cost`]: files an Anthropic key's exact cost for a turn nothing else records (no live
//!   conversation: a subagent, ACP, a Verify probe)
//! - [`anthropic_list_cost`]: an Anthropic key's turn stopped before its exact cost came: its tokens so far at the
//!   list price, as an estimate
//!
//! Where costs come from: an Anthropic key's are exact (the engine's total_cost_usd); OpenRouter's are exact when its
//! own usage.cost is reported, else the catalog price; DeepSeek, OpenAI and Local AI come from the price table
//! (`provider_registry.rs` `price_for`, DeepSeek's peak and off-peak hours included) and are shown as "est.". Plans
//! are never priced. Recorded costs live in usage_turns.cost_usd and usage_calls.cost_usd (migration 012,
//! `lib/token_usage.rs`); [`spend_between`] adds them up without counting a turn's calls twice.
//!
//! Usage objects use Claude's vocabulary, as the engines' usage events do: input_tokens (new input, cache reads NOT
//! included), output_tokens, cache_read_input_tokens, cache_creation_input_tokens. Tarsee's own row names (input,
//! output, cacheRead, cacheWrite) are accepted too. A reported cost rides along as usage.cost or usage.costUsd.
//!
//! A moment (`at`, `now`) is milliseconds since 1970, and `None` is now (the JS also took a Date or an ISO string: a
//! caller holding one passes `util::js::ms_from_iso`). The database is the one the caller names: the JS fell back to
//! the settings store's own (`store.db`), so a caller that has the real store passes `Some(app.db())`, and one that
//! passed neither still passes `None` (the cap is then never enforced, as in the JS).

use serde::{Serialize, Serializer};
use serde_json::Value;

use super::codex_models::js_string;
use super::context_limits::{js_number, js_round};
use super::provider_registry::{Caps, ProviderKind, ProviderRegistry, get_provider, normalize_provider_id};
use crate::app::App;
use crate::config::constants::background_defaults;
use crate::db::Db;
use crate::db::settings::Settings;
use crate::util::js;

/// The local midnight that began a moment's calendar month (the monthly cap's start).
pub use crate::lib::local_time::month_start;

/// Today's per-turn ceiling for background work (crons, the heartbeat, the boot checklist), on every metered
/// provider.
pub const BACKGROUND_BUDGET_USD: f64 = background_defaults::MAX_BUDGET_USD;

/// The setting that holds the optional monthly cap in USD (empty: off).
pub const SPEND_CAP_KEY: &str = "ai.spendCap.monthlyUsd";

const MILLION: f64 = 1_000_000.0;

/// `Number.MAX_SAFE_INTEGER`: the JS default for the end of a span of time.
pub const FOREVER: i64 = 9_007_199_254_740_991;

/// A dollar figure as `JSON.stringify` writes a number: a whole one without ".0", one that is not finite as null.
fn js_money<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if !value.is_finite() {
        return serializer.serialize_none();
    }
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return serializer.serialize_i64(*value as i64);
    }
    serializer.serialize_f64(*value)
}

fn js_money_or_null<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => js_money(value, serializer),
        None => serializer.serialize_none(),
    }
}

// --- What kind of cost a provider has ---

/// Where a provider's cost figure comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CostSource {
    /// Included in a plan, never priced.
    Plan,
    /// The engine reports it.
    Exact,
    /// A price table, shown as "est.".
    Estimate,
    /// Local AI with no price set.
    Free,
}

impl CostSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CostSource::Plan => "plan",
            CostSource::Exact => "exact",
            CostSource::Estimate => "estimate",
            CostSource::Free => "free",
        }
    }
}

/// Where a provider's cost figure comes from: "plan" (included in a plan, never priced), "exact" (the engine
/// reports it), "estimate" (a price table, shown as "est."), "free" (Local AI with no price set), or `None` for an
/// unknown provider.
pub fn cost_source(app: &App, provider_id: &str, store: Option<&dyn Settings>) -> Option<CostSource> {
    let p = get_provider(provider_id)?;
    Some(if p.kind == ProviderKind::Subscription {
        CostSource::Plan
    } else if p.id == "anthropic" {
        CostSource::Exact
    } else if p.id == "local" && !local_priced(app, store) {
        CostSource::Free
    } else {
        CostSource::Estimate
    })
}

/// Whether a provider bills per use: every key provider, and Local AI only when its card sets a price. Plans never.
pub fn is_metered(app: &App, provider_id: &str, store: Option<&dyn Settings>) -> bool {
    match get_provider(provider_id) {
        None => false,
        Some(p) if p.kind == ProviderKind::Subscription => false,
        Some(p) if p.id == "local" => local_priced(app, store),
        Some(_) => true,
    }
}

fn local_priced(app: &App, store: Option<&dyn Settings>) -> bool {
    ProviderRegistry::of(app)
        .price_for("local", None, None, store)
        .is_some_and(|r| r.input > 0.0 || r.output > 0.0 || r.cache_read > 0.0 || r.cache_write > 0.0)
}

// --- Pricing ---

/// `Number(value)` for a JSON value that is there (text as JavaScript reads a number, an array as its text).
fn js_number_of(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number(text),
        Value::Array(_) => js_number(&js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// The four token counts of a usage object.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    #[serde(serialize_with = "js_money")]
    pub input: f64,
    #[serde(serialize_with = "js_money")]
    pub output: f64,
    #[serde(serialize_with = "js_money")]
    pub cache_read: f64,
    #[serde(serialize_with = "js_money")]
    pub cache_write: f64,
}

/// The four token counts of a usage object, in either vocabulary.
pub fn tokens_of(usage: &Value) -> Tokens {
    // The first of these members that is a number above zero, else 0.
    let n = |names: &[&str]| {
        names
            .iter()
            .filter_map(|name| usage.get(name))
            .map(js_number_of)
            .find(|x| x.is_finite() && *x > 0.0)
            .unwrap_or(0.0)
    };
    Tokens {
        input: n(&["input_tokens", "input"]),
        output: n(&["output_tokens", "output"]),
        cache_read: n(&["cache_read_input_tokens", "cacheRead", "cache_read"]),
        cache_write: n(&["cache_creation_input_tokens", "cacheWrite", "cache_write"]),
    }
}

/// A cost the provider itself reported (OpenRouter's usage.cost), or `None`.
fn reported_cost(usage: &Value) -> Option<f64> {
    ["cost", "costUsd", "cost_usd"]
        .iter()
        .filter_map(|name| usage.get(name))
        .filter_map(|v| match v {
            Value::String(text) if !js::trim(text).is_empty() => Some(js_number(text)),
            Value::Number(n) => n.as_f64(),
            _ => None,
        })
        .find(|x| x.is_finite() && *x >= 0.0)
}

/// Dollars to a billionth: no float noise in sums.
fn round(x: f64) -> f64 {
    js_round(x * 1e9) / 1e9
}

/// Where a priced figure came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PriceSource {
    /// The provider's own figure.
    Reported,
    PriceTable,
}

/// What a usage costs, with where the figure came from: `{ usd, source, estimated, peak }`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PriceDetail {
    #[serde(serialize_with = "js_money")]
    pub usd: f64,
    pub source: PriceSource,
    pub estimated: bool,
    /// Whether the moment fell in the provider's peak hours; `None` for a provider without any.
    pub peak: Option<bool>,
}

/// The rates times the counts, in dollars (the order of the sum is the JS one, so the last digit is too).
fn at_rates(t: Tokens, input: f64, output: f64, cache_read: f64, cache_write: f64) -> f64 {
    (t.input * input + t.output * output + t.cache_read * cache_read + t.cache_write * cache_write) / MILLION
}

/// What a usage costs in USD on a provider and model at a moment, with where the figure came from:
/// `{ usd, source: "reported" | "price-table", estimated, peak }` or `None` when nothing is billed per token here.
/// `at` is milliseconds since 1970; `None` is now (DeepSeek's peak hours depend on it).
pub fn price_usage_detail(
    app: &App,
    provider_id: &str,
    model: Option<&str>,
    usage: &Value,
    at: Option<i64>,
    store: Option<&dyn Settings>,
) -> Option<PriceDetail> {
    let p = get_provider(provider_id).filter(|p| p.kind != ProviderKind::Subscription)?;
    if let Some(reported) = reported_cost(usage) {
        return Some(PriceDetail {
            usd: reported,
            source: PriceSource::Reported,
            estimated: false,
            peak: None,
        });
    }
    let rates = ProviderRegistry::of(app).price_for(p.id, model, at, store)?;
    let usd = at_rates(
        tokens_of(usage),
        rates.input,
        rates.output,
        rates.cache_read,
        rates.cache_write,
    );
    Some(PriceDetail {
        usd: round(usd),
        source: PriceSource::PriceTable,
        estimated: true,
        peak: rates.peak,
    })
}

/// What a usage costs in USD, or `None` (plans, the Anthropic key's engine-reported cost, an unpriced model).
pub fn price_usage(
    app: &App,
    provider_id: &str,
    model: Option<&str>,
    usage: &Value,
    at: Option<i64>,
    store: Option<&dyn Settings>,
) -> Option<f64> {
    price_usage_detail(app, provider_id, model, usage, at, store).map(|d| d.usd)
}

/// An Anthropic key's turn that ended before its engine reported the exact cost (a Stop, a timeout, a crash): its
/// tokens so far at Anthropic's list price (`provider_registry.rs` `claude_list_price`), an estimate; `None` when no
/// price is known. Only ever the turn's own figure: the key's calls stay unpriced, so nothing is counted twice.
pub fn anthropic_list_cost(app: &App, model: Option<&str>, usage: &Value) -> Option<f64> {
    let rates = ProviderRegistry::of(app).claude_list_price(model.unwrap_or(""))?;
    Some(round(at_rates(
        tokens_of(usage),
        rates.input,
        rates.output,
        rates.cache_read,
        rates.cache_write,
    )))
}

// --- The per-turn ceiling ---

/// What [`check_turn_budget`] is asked.
#[derive(Clone, Copy, Default)]
pub struct TurnBudgetOpts<'a> {
    /// The turn's target (the JS `providerId ?? provider`).
    pub provider_id: Option<&'a str>,
    pub model: Option<&'a str>,
    /// The turn's token totals so far (priced here), or
    pub usage: Option<&'a Value>,
    /// a cost the provider or engine reported for the turn so far, or
    pub cost_usd: Option<f64>,
    /// the caller's own running sum of priced usage.
    pub spent_usd: Option<f64>,
    /// Whether `spent_usd` is an estimate; by default whatever the provider's figures are.
    pub estimated: Option<bool>,
    /// The ceiling; without one a background turn gets [`BACKGROUND_BUDGET_USD`], an interactive none.
    pub max_budget_usd: Option<f64>,
    /// True for crons, the heartbeat, the boot checklist.
    pub background: bool,
    /// The moment (DeepSeek's hours); `None` is now.
    pub at: Option<i64>,
    pub store: Option<&'a dyn Settings>,
    /// `caps_for()`'s answer if already known.
    pub caps: Option<Caps>,
}

/// Who keeps a turn's dollar ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnforcedBy {
    /// The engine itself (the Anthropic key: pass the ceiling to it).
    Engine,
    /// This check.
    Tarsee,
}

/// `{ metered, enforcedBy, limitUsd, spentUsd, estimated, tripped, over, subtype, message }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnBudget {
    pub metered: bool,
    /// `None` when there is no ceiling.
    pub enforced_by: Option<EnforcedBy>,
    #[serde(serialize_with = "js_money_or_null")]
    pub limit_usd: Option<f64>,
    #[serde(serialize_with = "js_money_or_null")]
    pub spent_usd: Option<f64>,
    pub estimated: bool,
    /// True once the spend is over the ceiling; the turn layer then stops the turn with
    /// `error{subtype:"error_max_budget_usd", message}` and `done{stopReason:"error_max_budget_usd"}`.
    pub tripped: bool,
    /// The same as `tripped` (the name `ai/turn.rs` reads).
    pub over: bool,
    pub subtype: Option<&'static str>,
    pub message: Option<String>,
}

/// A number above zero, or `None`.
fn positive(n: Option<f64>) -> Option<f64> {
    n.filter(|n| n.is_finite() && *n > 0.0)
}

fn finite_non_neg(n: Option<f64>) -> Option<f64> {
    n.filter(|n| n.is_finite() && *n >= 0.0)
}

/// Whether a turn has gone over its dollar ceiling (design 4.6h). Plans are never metered here, so they never trip
/// it.
pub fn check_turn_budget(app: &App, opts: &TurnBudgetOpts<'_>) -> TurnBudget {
    let id = opts.provider_id.and_then(normalize_provider_id);
    let store = opts.store;
    let metered = id.is_some_and(|id| is_metered(app, id, store));
    let limit = positive(opts.max_budget_usd).or(opts.background.then_some(BACKGROUND_BUDGET_USD));
    let mut out = TurnBudget {
        metered,
        enforced_by: None,
        limit_usd: limit.filter(|_| metered),
        spent_usd: None,
        estimated: false,
        tripped: false,
        over: false,
        subtype: None,
        message: None,
    };
    let Some(id) = id.filter(|_| metered) else {
        return out;
    };

    let mut spent = None;
    let mut estimated = false;
    if let Some(reported) = finite_non_neg(opts.cost_usd) {
        spent = Some(reported);
    } else if let Some(running) = finite_non_neg(opts.spent_usd) {
        spent = Some(running);
        estimated = opts
            .estimated
            .unwrap_or_else(|| cost_source(app, id, store) != Some(CostSource::Exact));
    } else if let Some(d) = price_usage_detail(app, id, opts.model, opts.usage.unwrap_or(&Value::Null), opts.at, store)
    {
        spent = Some(d.usd);
        estimated = d.estimated;
    }
    out.spent_usd = spent;
    out.estimated = estimated;

    let native = match opts.caps {
        Some(caps) => caps.native_budget,
        None => ProviderRegistry::of(app)
            .caps_for(id, opts.model, store)
            .is_some_and(|caps| caps.native_budget),
    };
    let Some(limit) = limit else { return out };
    if native {
        out.enforced_by = Some(EnforcedBy::Engine);
        return out;
    }
    out.enforced_by = Some(EnforcedBy::Tarsee);
    if let Some(spent) = spent.filter(|spent| *spent > limit + 1e-12) {
        out.tripped = true;
        out.over = true;
        out.subtype = Some("error_max_budget_usd");
        out.message = Some(format!(
            "Stopped after reaching this task's spending limit of {} (about {} so far{}).",
            money(limit),
            money(spent),
            if estimated { ", estimated" } else { "" }
        ));
    }
    out
}

// --- What has been spent ---

/// Dollars by provider, in the order the providers came up.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ByProvider(Vec<(&'static str, f64)>);

impl ByProvider {
    /// What a provider spent (`byProvider[id]`); `None` when it spent nothing that counts.
    pub fn get(&self, id: &str) -> Option<f64> {
        self.0.iter().find(|(p, _)| *p == id).map(|(_, usd)| *usd)
    }

    /// The providers that spent something (`Object.keys(byProvider)`).
    pub fn ids(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.0.iter().map(|(id, _)| *id)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&'static str, f64)> + '_ {
        self.0.iter().copied()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn add(&mut self, id: &'static str, usd: f64) {
        match self.0.iter_mut().find(|(p, _)| *p == id) {
            Some((_, sum)) => *sum = round(*sum + usd),
            None => self.0.push((id, round(usd))),
        }
    }
}

impl Serialize for ByProvider {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        struct Usd(f64);
        impl Serialize for Usd {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                js_money(&self.0, serializer)
            }
        }
        serializer.collect_map(self.0.iter().map(|(id, usd)| (*id, Usd(*usd))))
    }
}

/// The recorded spend of a span of time: `{ totalUsd, byProvider: { id: usd }, estimated }`.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    #[serde(serialize_with = "js_money")]
    pub total_usd: f64,
    pub by_provider: ByProvider,
    /// True when any counted row is Tarsee's estimate rather than the provider's own figure.
    pub estimated: bool,
}

/// One row of the sum: a provider as it was recorded, its dollars, and how many of its rows are estimates.
type SpendRow = (Option<String>, Option<f64>, Option<f64>);

fn spend_rows(db: &Db, exact_column: &str, from: i64, to: i64) -> rusqlite::Result<Vec<SpendRow>> {
    let sql = format!(
        "SELECT p AS provider, SUM(c) AS usd, SUM(e) AS est FROM (
        SELECT COALESCE(provider, 'claude') AS p, cost_usd AS c, {exact_column} AS e FROM usage_turns
          WHERE cost_usd IS NOT NULL AND COALESCE(ended_at, last_call_at, started_at) >= ? AND COALESCE(ended_at, last_call_at, started_at) < ?
        UNION ALL
        SELECT COALESCE(provider, 'claude') AS p, cost_usd AS c, 1 AS e FROM usage_calls
          WHERE cost_usd IS NOT NULL AND turn_id IS NULL AND ended_at >= ? AND ended_at < ?
      ) GROUP BY p"
    );
    db.with(|conn| {
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map([from, to, from, to], |row| {
            // (A provider or a sum of another type than expected counts as none, as `Number(x) || 0` did.)
            Ok((
                row.get::<_, Option<String>>(0).unwrap_or(None),
                row.get::<_, Option<f64>>(1).unwrap_or(None),
                row.get::<_, Option<f64>>(2).unwrap_or(None),
            ))
        })?;
        rows.collect()
    })
}

/// The recorded spend between two moments, per provider: `{ totalUsd, byProvider: { id: usd }, estimated }`. Each
/// turn counts once at its end (its own cost_usd: its calls' sum, or the engine's exact figure), and calls that
/// belong to no turn count themselves, so nothing is counted twice. Plans never add anything. `provider`: only that
/// one. estimated is true when any counted row is Tarsee's estimate rather than the provider's own figure (a turn
/// without cost_exact, or a call in no turn, which is always priced from the table). `to`: the JS default was
/// [`FOREVER`].
pub fn spend_between(db: Option<&Db>, from: i64, to: i64, provider: Option<&str>) -> Spend {
    let only = provider.filter(|p| !p.is_empty()).and_then(normalize_provider_id);
    let mut spend = Spend::default();
    let Some(db) = db.filter(|db| db.is_open()) else {
        return spend;
    };
    let rows = match spend_rows(db, "1 - COALESCE(cost_exact, 0)", from, to) {
        Ok(rows) => rows,
        // A usage table from before cost_exact: every figure in it is an estimate.
        Err(_) => match spend_rows(db, "1", from, to) {
            Ok(rows) => rows,
            Err(_) => return spend, // no usage tables yet
        },
    };
    let mut total = 0.0;
    let mut estimated = 0.0;
    for (provider, usd, est) in rows {
        let Some(p) = provider.as_deref().and_then(get_provider) else {
            continue;
        };
        if p.kind == ProviderKind::Subscription || only.is_some_and(|only| p.id != only) {
            continue;
        }
        let usd = usd.filter(|usd| !usd.is_nan()).unwrap_or(0.0);
        spend.by_provider.add(p.id, usd);
        total += usd;
        estimated += est.filter(|est| !est.is_nan()).unwrap_or(0.0);
    }
    spend.total_usd = round(total);
    spend.estimated = estimated > 0.0;
    spend
}

/// A provider's own cost for a turn, to be filed: `{ turnId, conversationId, source?, provider, engine, model?,
/// effort?, startedAt, endedAt?, stopReason?, costUsd, exact? }`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ReportedCost<'a> {
    pub turn_id: &'a str,
    pub conversation_id: &'a str,
    pub source: Option<&'a str>,
    pub provider: &'a str,
    pub engine: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    /// Milliseconds since 1970; without one (or with one that is no moment) the turn's end.
    pub started_at: Option<f64>,
    /// Milliseconds since 1970; without one (or with one that is no moment) now.
    pub ended_at: Option<f64>,
    pub stop_reason: Option<&'a str>,
    pub cost_usd: f64,
    /// False for a turn stopped before the engine's figure came, priced at the list price; the JS default was true.
    pub exact: Option<bool>,
}

/// Whether a cost was filed: `{ recorded: true }` or `{ recorded: false, reason }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Recorded {
    pub recorded: bool,
    /// "no-db", "provider", "turn", "cost" or "error".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// File a provider's own exact cost for a turn that nothing else will put a cost on: an Anthropic key's turn with no
/// live conversation (a subagent, ACP, a Verify probe). Its transcript's calls are never priced (the key's figure is
/// exact, `price_usage` gives `None`), and with no turn_end the usage index never reads the figure either, so
/// without this the turn would add nothing to [`spend_between`], the monthly cap and the Usage page. It becomes that
/// turn's row in usage_turns (cost_exact 1, which the index never overwrites, unless `row.exact` is false: a turn
/// stopped before the engine's figure came, priced at the list price); its calls stay unpriced and in no turn, so
/// nothing is counted twice. Recording the same turn again replaces its figure.
/// Returns `{ recorded: true }` or `{ recorded: false, reason }`. Never fails: usage is bookkeeping.
pub fn record_reported_cost(row: &ReportedCost<'_>, db: Option<&Db>) -> Recorded {
    let refused = |reason| Recorded {
        recorded: false,
        reason: Some(reason),
    };
    let Some(db) = db else {
        return refused("no-db");
    };
    let Some(p) = get_provider(row.provider).filter(|p| p.kind != ProviderKind::Subscription) else {
        return refused("provider");
    };
    let turn_id = js::trim(row.turn_id);
    let conversation_id = js::trim(row.conversation_id);
    if turn_id.is_empty() || conversation_id.is_empty() {
        return refused("turn");
    }
    let Some(cost) = finite_non_neg(Some(row.cost_usd)).filter(|cost| *cost != 0.0) else {
        return refused("cost");
    };
    let moment = |at: Option<f64>| {
        at.filter(|at| at.is_finite() && *at > 0.0)
            .map(|at| js_round(at) as i64)
    };
    let ended_at = moment(row.ended_at).unwrap_or_else(js::now_ms);
    let started_at = moment(row.started_at).unwrap_or(ended_at);
    let text = |v: Option<&str>| v.map(js::trim).filter(|v| !v.is_empty()).map(str::to_string);
    if !db.is_open() {
        // (What the JS database said when it was asked for a statement after it was closed.)
        log::warn!("[spend] a turn's cost couldn't be recorded: The database connection is not open");
        return refused("error");
    }
    let written = db.with(|conn| {
        conn.execute(
            "INSERT INTO usage_turns (turn_id, conversation_id, source, model, effort, started_at, ended_at, stop_reason, provider, engine, cost_usd, cost_exact)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET cost_usd = excluded.cost_usd, cost_exact = excluded.cost_exact, ended_at = excluded.ended_at,
        stop_reason = COALESCE(excluded.stop_reason, usage_turns.stop_reason)",
            rusqlite::params![
                turn_id,
                conversation_id,
                text(row.source),
                text(row.model),
                text(row.effort),
                started_at,
                ended_at,
                text(row.stop_reason),
                p.id,
                text(row.engine),
                round(cost),
                if row.exact == Some(false) { 0 } else { 1 },
            ],
        )
    });
    match written {
        Ok(_) => Recorded {
            recorded: true,
            reason: None,
        },
        Err(err) => {
            log::warn!("[spend] a turn's cost couldn't be recorded: {}", sqlite_message(&err));
            refused("error")
        }
    }
}

/// What SQLite itself said went wrong (the JS error's `message`), without the statement around it.
fn sqlite_message(err: &rusqlite::Error) -> String {
    match err {
        rusqlite::Error::SqlInputError { msg, .. } | rusqlite::Error::SqliteFailure(_, Some(msg)) => msg.clone(),
        other => other.to_string(),
    }
}

/// Which month [`monthly_spend`] adds up.
#[derive(Debug, Clone, Copy, Default)]
pub struct MonthlyOpts<'a> {
    /// The moment, in milliseconds since 1970; `None` is now.
    pub now: Option<i64>,
    /// Default `config.timezone`.
    pub time_zone: Option<&'a str>,
    /// Only that provider.
    pub provider: Option<&'a str>,
}

/// This calendar month's spend: `{ totalUsd, byProvider, estimated, from, to, timeZone }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlySpend {
    #[serde(serialize_with = "js_money")]
    pub total_usd: f64,
    pub by_provider: ByProvider,
    pub estimated: bool,
    /// The local midnight that began the month.
    pub from: i64,
    /// The moment asked about.
    pub to: i64,
    pub time_zone: String,
}

/// This calendar month's spend in the owner's timezone: `{ totalUsd, byProvider, from, to, timeZone }`.
/// opts: `now` (ms), `time_zone` (default `config.timezone`), `provider` (only that one).
pub fn monthly_spend(app: &App, db: Option<&Db>, opts: &MonthlyOpts<'_>) -> MonthlySpend {
    let now = opts.now.unwrap_or_else(js::now_ms);
    let time_zone = opts
        .time_zone
        .filter(|zone| !zone.is_empty())
        .unwrap_or(&app.config().timezone);
    let from = month_start(now, time_zone);
    let spend = spend_between(db, from, now.saturating_add(1), opts.provider);
    MonthlySpend {
        total_usd: spend.total_usd,
        by_provider: spend.by_provider,
        estimated: spend.estimated,
        from,
        to: now,
        time_zone: time_zone.to_string(),
    }
}

/// The monthly cap in USD from ai.spendCap.monthlyUsd ("20", "$20", 20), or `None` when it is off.
pub fn spend_cap_usd(store: Option<&dyn Settings>) -> Option<f64> {
    match store?.get(SPEND_CAP_KEY)? {
        Value::Number(n) => positive(n.as_f64()),
        Value::String(raw) => {
            // `raw.replace(/[$,\s]/g, "").replace(/^usd/i, "")`
            let bare: String = raw
                .chars()
                .filter(|c| !matches!(c, '$' | ',') && !js::is_whitespace(*c))
                .collect();
            let bare = match bare.get(..3) {
                Some(start) if start.eq_ignore_ascii_case("usd") => &bare[3..],
                _ => bare.as_str(),
            };
            if bare.is_empty() {
                None
            } else {
                positive(Some(js_number(bare)))
            }
        }
        _ => None,
    }
}

/// What [`monthly_cap_status`] looks at.
#[derive(Clone, Copy, Default)]
pub struct CapOpts<'a> {
    /// The settings (the cap, and Local AI's price).
    pub store: Option<&'a dyn Settings>,
    /// The database the month's spend is read from; with none the cap is never reached.
    pub db: Option<&'a Db>,
    pub now: Option<i64>,
    pub time_zone: Option<&'a str>,
}

/// `{ ok, metered, capUsd, spentUsd, remainingUsd, subtype, message }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapStatus {
    pub ok: bool,
    pub metered: bool,
    #[serde(serialize_with = "js_money_or_null")]
    pub cap_usd: Option<f64>,
    #[serde(serialize_with = "js_money_or_null")]
    pub spent_usd: Option<f64>,
    #[serde(serialize_with = "js_money_or_null")]
    pub remaining_usd: Option<f64>,
    pub subtype: Option<&'static str>,
    pub message: Option<String>,
}

/// The monthly cap's answer for a turn on a provider (design 4.6b, refusal "spend-cap"):
/// `{ ok, metered, capUsd, spentUsd, remainingUsd, subtype, message }`. Only providers that bill per use are ever
/// refused; with no cap set everything is ok. opts: `store` (settings), `db`, `now`, `time_zone`.
pub fn monthly_cap_status(app: &App, provider_id: &str, opts: &CapOpts<'_>) -> CapStatus {
    let id = normalize_provider_id(provider_id);
    let cap_usd = spend_cap_usd(opts.store);
    let metered = id.is_some_and(|id| is_metered(app, id, opts.store));
    let mut out = CapStatus {
        ok: true,
        metered,
        cap_usd,
        spent_usd: None,
        remaining_usd: None,
        subtype: None,
        message: None,
    };
    let (Some(cap), true, Some(db)) = (cap_usd, metered, opts.db) else {
        return out;
    };
    let month = MonthlyOpts {
        now: opts.now,
        time_zone: opts.time_zone,
        provider: None,
    };
    let spent = monthly_spend(app, Some(db), &month).total_usd;
    out.spent_usd = Some(spent);
    out.remaining_usd = Some(round((cap - spent).max(0.0)));
    if spent >= cap {
        out.ok = false;
        out.subtype = Some("spend-cap");
        out.message = Some(format!(
            "This month's AI spending has reached the {} limit set in Settings > AI (about {} so far). Raise or clear the limit there, or switch this chat to a plan, which isn't billed per use.",
            money(cap),
            money(spent)
        ));
    }
    out
}

/// Whether a turn on this provider may run under the monthly cap: false only for a metered provider once it is
/// reached.
pub fn within_monthly_cap(app: &App, provider_id: &str, opts: &CapOpts<'_>) -> bool {
    monthly_cap_status(app, provider_id, opts).ok
}

// --- Helpers ---

/// "$0.50", "$1,234.00"; under a cent: "under $0.01".
pub fn money(usd: f64) -> String {
    // (`Number(usd) || 0`: what is no number is 0; a zero below nothing is written without its sign further down.)
    let v = if usd.is_nan() { 0.0 } else { usd };
    if v > 0.0 && v < 0.005 {
        return "under $0.01".to_string();
    }
    format!("${}", en_us_two_places(v))
}

/// The digits of a finite number that is not negative, as JavaScript writes a number (and as its locale formatting
/// starts from): the fewest that read back as the same number; of several such, the nearest to it; of two as near,
/// the even one (Rust's own shortest form takes the odd one: 150000000000000.125 is "150000000000000.13" there and
/// "150000000000000.12" in JavaScript). Returns the digits and how many of them stand before the decimal point.
fn js_digits(v: f64) -> (Vec<u8>, i32) {
    let digits_of = |text: &str| -> Vec<u8> { text.bytes().filter(u8::is_ascii_digit).map(|b| b - b'0').collect() };
    for precision in 0..=16_usize {
        // The nearest number of that many digits, a half going to the even digit.
        let text = format!("{v:.precision$e}");
        let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
        let exponent: i32 = exponent.parse().unwrap_or(0);
        let digits = digits_of(mantissa);
        if text.parse::<f64>() == Ok(v) {
            return (digits, exponent + 1);
        }
        // Just above a power of two the numbers below lie closer than those above: the nearest may then read back
        // as a neighbour while the next one of that many digits still reads back as this number.
        let n = digits.iter().fold(0_u64, |n, d| n * 10 + u64::from(*d));
        for neighbour in [n + 1, n.saturating_sub(1)] {
            let written = neighbour.to_string();
            let scaled = format!("{written}e{}", exponent - precision as i32);
            if written.len() == digits.len() && scaled.parse::<f64>() == Ok(v) {
                return (digits_of(&written), exponent + 1);
            }
        }
    }
    // (Seventeen digits always read back, so this is never reached.)
    (digits_of(&format!("{v:.16e}")), v.log10().floor() as i32 + 1)
}

/// `v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })`: two decimals, a half
/// rounding away from zero on the number as it is written in decimal (1.005 is "1.01"), thousands in groups.
fn en_us_two_places(v: f64) -> String {
    if v.is_infinite() {
        return if v > 0.0 { "∞" } else { "-∞" }.to_string();
    }
    // The number as it is written, without an exponent: its whole part, then its decimal places.
    let (written, point) = js_digits(v.abs());
    let (mut digits, mut places) = match usize::try_from(point) {
        Ok(point) if point >= written.len() => {
            let mut whole = written;
            whole.resize(point, 0);
            (whole, Vec::new())
        }
        Ok(point) if point > 0 => (written[..point].to_vec(), written[point..].to_vec()),
        _ => {
            let mut places = vec![0; point.unsigned_abs() as usize];
            places.extend(written);
            (vec![0], places)
        }
    };
    let round_up = places.get(2).is_some_and(|d| *d >= 5);
    places.resize(2, 0);
    digits.extend(places);
    if round_up {
        let mut at = digits.len();
        loop {
            if at == 0 {
                digits.insert(0, 1);
                break;
            }
            at -= 1;
            if digits[at] == 9 {
                digits[at] = 0;
            } else {
                digits[at] += 1;
                break;
            }
        }
    }
    let (whole, cents) = digits.split_at(digits.len() - 2);
    let mut out = String::new();
    if v < 0.0 {
        out.push('-');
    }
    for (i, d) in whole.iter().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(char::from(b'0' + d));
    }
    out.push('.');
    out.extend(cents.iter().map(|d| char::from(b'0' + d)));
    out
}

#[cfg(test)]
mod tests;
