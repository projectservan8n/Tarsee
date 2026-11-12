//! Port of `src/lib/openrouter-catalog.js`: the models OpenRouter offers, for the picker and for pricing (design
//! 4.11).
//!
//! The list is OpenRouter's public GET /api/v1/models. It needs no key and none is ever sent with it: this module
//! has no way to reach a key at all. It is read at boot (the cached copy at once, then a fresh one in the
//! background, like the model catalog's own boot) and every 6 hours, cached in the `cache.openrouter.models` setting
//! so a restart has it straight away, and fed to the provider registry (`set_catalog_models("openrouter", ..)`),
//! where `price_for`, `context_tokens_for` and `caps_for` read it.
//!
//! Why the full list and not ?supported_parameters=tools: that filtered answer leaves out the "~maker/...-latest"
//! aliases, Tarsee's own OpenRouter defaults among them. So the full list is read and filtered here.
//!
//! A model is kept only when Tarsee can run it:
//!  - it takes tools (supported_parameters has "tools"): every Tarsee turn uses them;
//!  - it has a chat endpoint an engine speaks: /api/v1/messages (Claude Code) or /api/v1/responses (Codex). The
//!    ":batch" copies only take batch jobs;
//!  - it has a price per token. Routers that pick a different model on each request list -1: no cost can be shown
//!    or bounded for them, and a verification run says nothing about the next request;
//!  - it answers in text, and its retirement date (if any) hasn't passed.
//!
//! The picker shows three sections ([`OpenRouterCatalog::open_router_sections`]): Recommended (the registry's
//! recommended slugs and the shipped verified models), Verified by you (`ai.openrouter.verified`) and All models
//! (searchable). A row can be picked only when the registry knows its engine (`engine_for`): Anthropic's models and
//! OpenAI's run without a check, any other maker after Verify (`ai/verify_model.rs`).
//!
//! # State
//!
//! The JS module kept the current list, when it was fetched and the fetch in progress in module-level variables.
//! Here they are the state of an [`OpenRouterCatalog`], a service of the `App` ([`OpenRouterCatalog::of`]); the
//! functions of the JS module that read them are its methods, under their JS names. The request goes through the
//! app's HTTP client (`app.fetch()`), where the JS took a `fetch` option.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::ai::provider_registry::{
    Engine, ModelPrice, PROVIDERS, ProviderRegistry, engine_for, is_js_space, js_to_number, js_trim, positive_int,
    verified_models,
};
use crate::app::{App, WeakApp};
use crate::db::settings::Settings;
use crate::lib::model_picker::{EFFORT_IDS, js_number_to_string, js_to_precision};
use crate::net::fetch::{FetchError, FetchRequest};
use crate::util::js;

pub const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
pub const CATALOG_CACHE_KEY: &str = "cache.openrouter.models";
pub const CATALOG_TTL_MS: i64 = 6 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS: u64 = 20_000;
/// The whole list is under 1 MB today; anything far bigger is not the list.
const MAX_BODY_CHARS: usize = 16 * 1024 * 1024;

const MESSAGES_ENDPOINT: &str = "/api/v1/messages";
const RESPONSES_ENDPOINT: &str = "/api/v1/responses";

/// OpenRouter's common reasoning levels: what it accepts from any model that reasons but lists none of its own.
const COMMON_EFFORTS: &[&str] = &["low", "medium", "high"];

/// A catalog fetch that went wrong, in words the Settings page can show.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CatalogError(pub String);

/// The reasoning levels a model takes: `{ efforts, default, mandatory }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reasoning {
    /// Tarsee's effort ids, lowest first.
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub mandatory: bool,
}

/// One model Tarsee can run on OpenRouter. Serialised, it is the row the JS kept and cached:
/// `{ id, label, vendor, context, vision, pdf, price: {in, out, cacheRead, cacheWrite} | null, free,
///   reasoning: {efforts, default, mandatory} | null, engines, aliasOf, retires }`.
/// Prices are USD per million tokens. `engines` are the ones whose endpoint the model has (Claude Code needs
/// /api/v1/messages, Codex /api/v1/responses); a row that doesn't list its endpoints may run on either.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub context: Option<u64>,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub pdf: bool,
    #[serde(default)]
    pub price: Option<ModelPrice>,
    #[serde(default)]
    pub free: bool,
    #[serde(default)]
    pub reasoning: Option<Reasoning>,
    pub engines: Vec<Engine>,
    #[serde(default)]
    pub alias_of: Option<String>,
    /// The day it retires ("2026-11-13"), when OpenRouter gives one.
    #[serde(default)]
    pub retires: Option<String>,
}

// --- Reading OpenRouter's answer ---

/// The models Tarsee can run, from the body of GET /api/v1/models. Rows it can't read are skipped; a body that
/// isn't a model list is an error. `now_ms` is the moment retirement dates are held against, in milliseconds since
/// 1970.
pub fn parse_open_router_models(body: &Value, now_ms: i64) -> Result<Vec<CatalogModel>, CatalogError> {
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        return Err(CatalogError("OpenRouter's answer isn't a model list.".to_string()));
    };
    let mut out: Vec<CatalogModel> = Vec::new();
    for raw in data {
        if let Some(row) = normalize_row(raw, now_ms)
            && !out.iter().any(|kept| kept.id == row.id)
        {
            out.push(row);
        }
    }
    Ok(out)
}

fn has_text(list: &[Value], text: &str) -> bool {
    list.iter().any(|item| item.as_str() == Some(text))
}

fn trimmed_text(value: Option<&Value>) -> Option<String> {
    let text = js_trim(value?.as_str()?);
    (!text.is_empty()).then(|| text.to_string())
}

fn normalize_row(raw: &Value, now_ms: i64) -> Option<CatalogModel> {
    let id = trimmed_text(raw.get("id"))?;
    let no_params = Vec::new();
    let params = raw
        .get("supported_parameters")
        .and_then(Value::as_array)
        .unwrap_or(&no_params);
    if !has_text(params, "tools") {
        return None;
    }

    let engines = engines_of(raw.get("endpoints"));
    if engines.is_empty() {
        return None;
    }

    let arch = raw.get("architecture");
    let modalities = |name: &str| arch.and_then(|a| a.get(name)).and_then(Value::as_array);
    if let Some(outputs) = modalities("output_modalities")
        && !has_text(outputs, "text")
    {
        return None;
    }

    let retires = date_only(raw.get("expiration_date"));
    if let Some((_, starts_ms)) = &retires
        && *starts_ms <= now_ms
    {
        return None;
    }

    let price = match price_of(raw.get("pricing")) {
        PriceOf::PerRequest => return None,
        PriceOf::None => None,
        PriceOf::PerToken(price) => Some(price),
    };

    let inputs = modalities("input_modalities").unwrap_or(&no_params);
    let vendor = maker_of(&id);
    let context = match positive_int(raw.get("context_length")) {
        Some(context) => Some(context),
        None => positive_int(raw.get("top_provider").and_then(|t| t.get("context_length"))),
    };
    Some(CatalogModel {
        label: trimmed_text(raw.get("name")).unwrap_or_else(|| id.clone()),
        context,
        vision: has_text(inputs, "image"),
        // Native PDF blocks only for Anthropic's own models (design 4.12); every other model gets the text.
        pdf: vendor == "anthropic" && has_text(inputs, "file"),
        free: id.ends_with(":free") || price.is_some_and(|p| p.input == 0.0 && p.output == 0.0),
        price,
        reasoning: reasoning_of(raw.get("reasoning"), params),
        engines,
        alias_of: trimmed_text(raw.get("alias_target").and_then(|t| t.get("slug"))),
        retires: retires.map(|(day, _)| day),
        vendor,
        id,
    })
}

/// The engines a model's endpoints allow. A model that doesn't list them may be tried on either.
fn engines_of(endpoints: Option<&Value>) -> Vec<Engine> {
    let Some(endpoints) = endpoints.and_then(Value::as_array) else {
        return vec![Engine::ClaudeCode, Engine::Codex];
    };
    let mut out = Vec::new();
    if has_text(endpoints, MESSAGES_ENDPOINT) {
        out.push(Engine::ClaudeCode);
    }
    if has_text(endpoints, RESPONSES_ENDPOINT) {
        out.push(Engine::Codex);
    }
    out
}

/// What a model's pricing says.
enum PriceOf {
    /// It lists none.
    None,
    /// A router whose price is per request (-1), which the catalog leaves out.
    PerRequest,
    PerToken(ModelPrice),
}

/// Per-token prices in USD per million tokens. A missing cache price costs the input rate.
fn price_of(pricing: Option<&Value>) -> PriceOf {
    let Some(pricing) = pricing.filter(|p| p.is_object()) else {
        return PriceOf::None;
    };
    let rate = |name: &str| per_million(pricing.get(name));
    let (Some(input), Some(output)) = (rate("prompt"), rate("completion")) else {
        return PriceOf::None;
    };
    if input < 0.0 || output < 0.0 {
        return PriceOf::PerRequest;
    }
    let cache = |name: &str| rate(name).filter(|r| *r >= 0.0).unwrap_or(input);
    PriceOf::PerToken(ModelPrice {
        input,
        output,
        cache_read: cache("input_cache_read"),
        cache_write: cache("input_cache_write"),
        peak: None,
    })
}

/// `Math.round(x)`: to the nearest whole number, a half going up.
fn math_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `String(value)` for what a JSON field may hold.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        // A list is its items joined with commas, a null among them being nothing.
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `Number(value)` for what a JSON field may hold.
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_to_number(text),
        Value::Array(_) | Value::Object(_) => js_to_number(&js_string(v)),
    }
}

/// "0.000002" (USD per token, as OpenRouter writes it) -> 2 (USD per million), without float noise.
fn per_million(v: Option<&Value>) -> Option<f64> {
    let v = v.filter(|v| !v.is_null() && v.as_str() != Some(""))?;
    let n = js_number(v);
    n.is_finite().then(|| math_round(n * 1e12) / 1e6)
}

/// The reasoning levels a model takes, as Tarsee's effort ids (lowest first): the ones it lists, without "none" and
/// "minimal", which Tarsee doesn't offer. A model that reasons but lists no levels takes OpenRouter's common three.
/// `None` for a model that doesn't reason.
fn reasoning_of(reasoning: Option<&Value>, params: &[Value]) -> Option<Reasoning> {
    let listed = reasoning
        .and_then(|r| r.get("supported_efforts"))
        .and_then(Value::as_array);
    let reasons =
        has_text(params, "reasoning") || has_text(params, "reasoning_effort") || listed.is_some_and(|l| !l.is_empty());
    if !reasons {
        return None;
    }
    let efforts: Vec<String> = match listed {
        Some(listed) => EFFORT_IDS
            .iter()
            .filter(|e| has_text(listed, e))
            .map(|e| e.to_string())
            .collect(),
        None => COMMON_EFFORTS.iter().map(|e| e.to_string()).collect(),
    };
    let default = reasoning
        .and_then(|r| r.get("default_effort"))
        .and_then(Value::as_str)
        .filter(|d| EFFORT_IDS.contains(d))
        .map(String::from);
    Some(Reasoning {
        efforts,
        default,
        mandatory: reasoning.and_then(|r| r.get("mandatory")) == Some(&Value::Bool(true)),
    })
}

// --- Fetching, caching, and feeding the registry ---

/// Where a refresh's list came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    /// The cached list, still under 6 hours old.
    Cache,
    /// OpenRouter, just now.
    Network,
    /// OpenRouter couldn't be reached: the last list is still in use.
    Stale,
    /// OpenRouter couldn't be reached and there is no list at all.
    None,
}

impl CatalogSource {
    /// "cache", "network", "stale" or "none".
    pub const fn as_str(self) -> &'static str {
        match self {
            CatalogSource::Cache => "cache",
            CatalogSource::Network => "network",
            CatalogSource::Stale => "stale",
            CatalogSource::None => "none",
        }
    }
}

/// What a refresh gives back: `{ source, models, fetchedAt, error }`.
#[derive(Debug, Clone, PartialEq)]
pub struct RefreshResult {
    pub source: CatalogSource,
    pub models: Arc<Vec<CatalogModel>>,
    /// When the list was fetched (ISO).
    pub fetched_at: Option<String>,
    /// Why OpenRouter couldn't be asked, when it couldn't.
    pub error: Option<String>,
}

/// The cached list: `{ fetchedAt, models }`.
#[derive(Debug, Clone, PartialEq)]
pub struct CachedCatalog {
    pub fetched_at: String,
    pub models: Arc<Vec<CatalogModel>>,
}

/// What a refresh may be told (the JS `opts`). The request itself goes through the app's HTTP client.
#[derive(Clone, Default)]
pub struct CatalogOptions {
    /// Where the list is asked for; [`OPENROUTER_MODELS_URL`] by default.
    pub url: Option<String>,
    /// The clock, in milliseconds since 1970; the real one by default.
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    /// Ask OpenRouter even when the cached list is still fresh.
    pub force: bool,
    /// Stops the request (the JS `signal`).
    pub cancel: Option<CancellationToken>,
    /// How long OpenRouter gets to answer; 20 seconds by default.
    pub timeout: Option<Duration>,
    /// [`init_open_router_catalog`] only: how often the list is asked for again; 6 hours by default.
    pub interval: Option<Duration>,
}

impl CatalogOptions {
    fn now_ms(&self) -> i64 {
        match &self.now {
            Some(now) => now(),
            None => js::now_ms(),
        }
    }
}

#[derive(Default)]
struct Current {
    /// The current list, normalized.
    models: Option<Arc<Vec<CatalogModel>>>,
    /// When it was fetched (ISO).
    fetched_at: Option<String>,
}

type Inflight = Shared<BoxFuture<'static, RefreshResult>>;

/// The current OpenRouter list and the fetch in progress. One per `App` ([`OpenRouterCatalog::of`]).
pub struct OpenRouterCatalog {
    app: WeakApp,
    registry: Arc<ProviderRegistry>,
    current: Mutex<Current>,
    /// The fetch in progress, so callers at the same moment share it.
    inflight: Mutex<Option<Inflight>>,
}

/// Why the list couldn't be had.
enum Failure {
    /// In words the Settings page can show as they are.
    Catalog(String),
    /// Anything else, with what the failure said.
    Other(String),
}

impl OpenRouterCatalog {
    /// The app's catalog, made on first use.
    pub fn of(app: &App) -> Arc<OpenRouterCatalog> {
        app.get_or_init(|| OpenRouterCatalog {
            app: app.downgrade(),
            registry: ProviderRegistry::of(app),
            current: Mutex::new(Current::default()),
            inflight: Mutex::new(None),
        })
    }

    /// Bring the catalog up to date. The cached list is used while it is under 6 hours old (unless `force`);
    /// otherwise OpenRouter is asked, once even when several callers ask at the same moment. Never fails: when
    /// OpenRouter can't be reached the last list stays in use and `error` says why.
    ///
    /// Returns `{ source: "cache"|"network"|"stale"|"none", models, fetchedAt, error }`.
    pub async fn refresh_open_router_catalog(
        self: &Arc<Self>,
        store: Arc<dyn Settings>,
        opts: CatalogOptions,
    ) -> RefreshResult {
        let t = opts.now_ms();
        let cached = read_cache(store.as_ref());
        if !opts.force
            && let Some(cached) = &cached
            && is_fresh(&cached.fetched_at, t)
        {
            self.apply(cached.models.clone(), Some(cached.fetched_at.clone()));
            return RefreshResult {
                source: CatalogSource::Cache,
                models: cached.models.clone(),
                fetched_at: Some(cached.fetched_at.clone()),
                error: None,
            };
        }
        let fetch = {
            let mut inflight = self.inflight.lock();
            match inflight.as_ref() {
                Some(fetch) => fetch.clone(),
                None => {
                    let fetch = self.clone().fetch_fresh(store, opts, t, cached).boxed().shared();
                    *inflight = Some(fetch.clone());
                    fetch
                }
            }
        };
        fetch.await
    }

    async fn fetch_fresh(
        self: Arc<Self>,
        store: Arc<dyn Settings>,
        opts: CatalogOptions,
        t: i64,
        cached: Option<CachedCatalog>,
    ) -> RefreshResult {
        let fresh = match self.get_json(&opts).await {
            Ok(body) => parse_open_router_models(&body, t).map_err(|err| Failure::Catalog(err.0)),
            Err(failure) => Err(failure),
        };
        let result = match fresh {
            Ok(models) => {
                let models = Arc::new(models);
                let fetched_at = js::iso_from_ms(t);
                write_cache(store.as_ref(), &fetched_at, &models);
                self.apply(models.clone(), Some(fetched_at.clone()));
                RefreshResult {
                    source: CatalogSource::Network,
                    models,
                    fetched_at: Some(fetched_at),
                    error: None,
                }
            }
            Err(failure) => {
                let error = match failure {
                    Failure::Catalog(message) => message,
                    Failure::Other(why) => format!("Tarsee couldn't read OpenRouter's model list ({why})."),
                };
                let last = cached.map(|c| (c.models, Some(c.fetched_at))).or_else(|| {
                    let current = self.current.lock();
                    current
                        .models
                        .clone()
                        .map(|models| (models, current.fetched_at.clone()))
                });
                match last {
                    Some((models, fetched_at)) => {
                        self.apply(models.clone(), fetched_at.clone());
                        RefreshResult {
                            source: CatalogSource::Stale,
                            models,
                            fetched_at,
                            error: Some(error),
                        }
                    }
                    None => RefreshResult {
                        source: CatalogSource::None,
                        models: Arc::new(Vec::new()),
                        fetched_at: None,
                        error: Some(error),
                    },
                }
            }
        };
        *self.inflight.lock() = None;
        result
    }

    /// The cached list, put to use without asking OpenRouter (boot). `None` when nothing is cached.
    pub fn load_open_router_catalog(&self, store: &dyn Settings) -> Option<CachedCatalog> {
        let cached = read_cache(store)?;
        self.apply(cached.models.clone(), Some(cached.fetched_at.clone()));
        Some(cached)
    }

    /// The current list (normalized rows); empty before the first load.
    pub fn open_router_models(&self) -> Arc<Vec<CatalogModel>> {
        self.current.lock().models.clone().unwrap_or_default()
    }

    /// The engines a listed model's endpoints allow, or `None` when OpenRouter doesn't list it (any engine may be
    /// tried).
    pub fn catalog_engines_for(&self, model_id: &str) -> Option<Vec<Engine>> {
        self.catalog_model(model_id).map(|row| row.engines)
    }

    /// One listed model's row, or `None`.
    pub fn catalog_model(&self, model_id: &str) -> Option<CatalogModel> {
        let id = strip_context_suffix(js_trim(model_id));
        self.open_router_models().iter().find(|m| m.id == id).cloned()
    }

    async fn get_json(&self, opts: &CatalogOptions) -> Result<Value, Failure> {
        let no_answer =
            |why: &str| Failure::Catalog(format!("Tarsee couldn't reach OpenRouter for its model list ({why})."));
        let Some(app) = self.app.upgrade() else {
            return Err(no_answer("network error"));
        };
        let url = opts.url.as_deref().unwrap_or(OPENROUTER_MODELS_URL);
        let timeout = opts.timeout.unwrap_or(Duration::from_millis(FETCH_TIMEOUT_MS));
        // A public list: no key and no cookie, only a request for JSON.
        let request = FetchRequest::get(url)
            .header("accept", "application/json")
            .timeout(timeout);
        let fetch = app.fetch();
        let answer = match &opts.cancel {
            Some(cancel) => tokio::select! {
                answer = fetch.fetch(request) => answer,
                // What the JS said of a request its caller stopped: the abort's own code.
                () = cancel.cancelled() => return Err(no_answer("20")),
            },
            None => fetch.fetch(request).await,
        };
        let res = match answer {
            Ok(res) => res,
            Err(FetchError::Timeout) => return Err(no_answer("it took too long to answer")),
            Err(FetchError::Connect(cause)) => return Err(no_answer(connect_code(&cause))),
            Err(FetchError::Body(why) | FetchError::Other(why)) => {
                return Err(no_answer(if why.is_empty() { "network error" } else { &why }));
            }
        };
        if !res.ok() {
            return Err(Failure::Catalog(format!(
                "OpenRouter answered {} when asked for its model list.",
                res.status
            )));
        }
        let text = res.text().await.map_err(|err| Failure::Other(err.to_string()))?;
        if js::utf16_len(&text) > MAX_BODY_CHARS {
            return Err(Failure::Catalog(
                "OpenRouter's answer was far too big to be its model list.".to_string(),
            ));
        }
        serde_json::from_str(&text)
            .map_err(|_| Failure::Catalog("OpenRouter's model list couldn't be read.".to_string()))
    }

    /// Make a list the current one, here and in the registry (prices, context, vision, PDFs, Free).
    fn apply(&self, models: Arc<Vec<CatalogModel>>, fetched_at: Option<String>) {
        let rows: Vec<Value> = models
            .iter()
            .map(|m| {
                json!({
                    "id": m.id,
                    "label": m.label,
                    "vendor": m.vendor,
                    "context": m.context,
                    "efforts": m.reasoning.as_ref().map(|r| &r.efforts),
                    "vision": m.vision,
                    "pdf": m.pdf,
                    "price": m.price,
                    "free": m.free,
                })
            })
            .collect();
        {
            let mut current = self.current.lock();
            current.models = Some(models);
            current.fetched_at = fetched_at;
        }
        self.registry
            .set_catalog_models("openrouter", &rows)
            .expect("openrouter is a runtime catalog");
    }

    // --- The picker ---

    /// The picker's OpenRouter sections, each `{ id, label, models, searchable? }`:
    ///   recommended  "Recommended": the registry's recommended slugs (the default first), then the shipped verified
    ///                models
    ///   verified     "Verified by you": the models the owner verified (`ai.openrouter.verified`), newest result kept
    ///   all          "All models": every model Tarsee can run, sorted by name; `query` narrows only this one
    /// Each row: the catalog row plus
    ///   engine       the engine that runs it now, or null (it must be verified first)
    ///   selectable   whether it can be picked now (engine is known); needsVerify is its opposite
    ///   streaming    replies word by word (Claude Code) or a message at a time (Codex); null until the engine is
    ///                known
    ///   efforts      the effort levels the picker offers for it now ([] until it can be picked)
    ///   verified     { engine, at, engineVersion } when a verification passed, else null
    ///   priceLabel   the price in plain words ("Free" for the free ones)
    ///   listed       false for a verified model OpenRouter no longer lists
    ///
    /// `models` stands in for the current list when given.
    pub fn open_router_sections(
        &self,
        store: Option<&dyn Settings>,
        query: &str,
        models: Option<&[CatalogModel]>,
    ) -> Vec<Section> {
        let held: Arc<Vec<CatalogModel>>;
        let list: &[CatalogModel] = match models {
            Some(models) => models,
            None => {
                held = match self.current.lock().models.clone() {
                    Some(current) => current,
                    None => store
                        .and_then(read_cache)
                        .map(|cached| cached.models)
                        .unwrap_or_default(),
                };
                &held
            }
        };
        let p = &PROVIDERS.openrouter;
        let mut rec_ids: Vec<&str> = Vec::new();
        let shipped_verified = p.models.iter().filter(|m| m.verified.is_some()).map(|m| m.id.as_str());
        for id in p.recommended.iter().copied().chain(shipped_verified) {
            if !rec_ids.contains(&id) {
                rec_ids.push(id);
            }
        }
        let verified = verified_models("openrouter", store);
        let row = |m: &CatalogModel| self.picker_row(PickerRow::listed(m), store, &verified);
        let row_for = |id: &str| match list.iter().rev().find(|m| m.id == id) {
            Some(m) => row(m),
            None => self.picker_row(PickerRow::unlisted(id), store, &verified),
        };

        let mine: Vec<&String> = verified.keys().filter(|id| !rec_ids.contains(&id.as_str())).collect();
        let mut all: Vec<PickerRow> = search_models(list, query).into_iter().map(row).collect();
        all.sort_by(by_label);
        vec![
            Section {
                id: "recommended",
                label: "Recommended",
                models: rec_ids.iter().map(|id| row_for(id)).collect(),
                searchable: false,
            },
            Section {
                id: "verified",
                label: "Verified by you",
                models: mine.iter().map(|id| row_for(id)).collect(),
                searchable: false,
            },
            Section {
                id: "all",
                label: "All models",
                models: all,
                searchable: true,
            },
        ]
    }

    fn picker_row(
        &self,
        mut row: PickerRow,
        store: Option<&dyn Settings>,
        verified: &serde_json::Map<String, Value>,
    ) -> PickerRow {
        let engine = engine_for("openrouter", Some(&row.id), store);
        row.engine = engine;
        row.selectable = engine.is_some();
        row.needs_verify = engine.is_none();
        row.streaming = engine.map(|e| e == Engine::ClaudeCode);
        row.efforts = match engine {
            Some(_) => self.registry.efforts_for("openrouter", Some(&row.id), store),
            None => Vec::new(),
        };
        row.verified = verified.get(&row.id).and_then(|v| {
            Some(VerifiedSummary {
                engine: v.get("engine").and_then(Value::as_str).and_then(Engine::from_id)?,
                at: v.get("at").cloned().unwrap_or(Value::Null),
                engine_version: v.get("engineVersion").cloned().unwrap_or(Value::Null),
            })
        });
        row.price_label = price_label(row.price.as_ref());
        row
    }

    /// Tests only: forget the current list.
    pub fn reset_for_tests(&self) {
        *self.current.lock() = Current::default();
        *self.inflight.lock() = None;
    }

    /// Tests only: use this list as the current one.
    pub fn set_models_for_tests(&self, models: Vec<CatalogModel>) {
        self.apply(Arc::new(models), None);
    }
}

/// What Node's own name for a failed connection would have been, where the cause says which it was; else the
/// cause itself.
fn connect_code(cause: &str) -> &str {
    let lower = cause.to_lowercase();
    if lower.contains("refused") {
        "ECONNREFUSED"
    } else if lower.contains("dns error") || lower.contains("failed to lookup") || lower.contains("no such host") {
        "ENOTFOUND"
    } else if lower.contains("reset") {
        "ECONNRESET"
    } else if lower.contains("timed out") {
        "ETIMEDOUT"
    } else if cause.is_empty() {
        "network error"
    } else {
        cause
    }
}

/// The handle [`init_open_router_catalog`] gives back: `{ ready, stop() }`.
pub struct CatalogHandle {
    ready: Inflight,
    timer: tokio::task::JoinHandle<()>,
}

impl CatalogHandle {
    /// The first refresh's result.
    pub async fn ready(&self) -> RefreshResult {
        self.ready.clone().await
    }

    /// Ends the 6-hourly refresh.
    pub fn stop(&self) {
        self.timer.abort();
    }
}

/// Boot: the cached list at once, a fresh one in the background, and again every 6 hours. Returns
/// `{ ready (the first refresh's result), stop() }`. Must be called inside the tokio runtime.
pub fn init_open_router_catalog(app: &App, store: Arc<dyn Settings>, opts: CatalogOptions) -> CatalogHandle {
    let catalog = OpenRouterCatalog::of(app);
    catalog.load_open_router_catalog(store.as_ref());

    let first = {
        let (catalog, store, opts) = (catalog.clone(), store.clone(), opts.clone());
        async move {
            let r = catalog.refresh_open_router_catalog(store, opts).await;
            if let Some(error) = &r.error {
                let using = match (&r.fetched_at, r.models.is_empty()) {
                    (Some(fetched_at), false) => format!(" Using the list from {fetched_at}."),
                    (None, false) => " Using the list from null.".to_string(),
                    (_, true) => String::new(),
                };
                log::warn!("[models] OpenRouter catalog: {error}{using}");
            } else if r.source == CatalogSource::Network {
                log::info!("[models] OpenRouter catalog: {} models Tarsee can run", r.models.len());
            }
            r
        }
    };
    let ready: Inflight = first.boxed().shared();
    // The first refresh runs whether or not anyone waits for `ready`.
    tokio::spawn(ready.clone().map(|_| ()));

    let period = opts.interval.unwrap_or(Duration::from_millis(CATALOG_TTL_MS as u64));
    let timer = tokio::spawn(async move {
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            ticks.tick().await;
            // The app has shut down: nothing left to keep up to date.
            if catalog.app.upgrade().is_none() {
                break;
            }
            let forced = CatalogOptions {
                force: true,
                ..opts.clone()
            };
            catalog.refresh_open_router_catalog(store.clone(), forced).await;
        }
    });
    CatalogHandle { ready, timer }
}

fn is_fresh(fetched_at: &str, now_ms: i64) -> bool {
    js::ms_from_iso(fetched_at).is_some_and(|at| now_ms >= at && now_ms - at < CATALOG_TTL_MS)
}

fn read_cache(store: &dyn Settings) -> Option<CachedCatalog> {
    let v = match store.get(CATALOG_CACHE_KEY)? {
        Value::String(text) => serde_json::from_str(&text).ok()?,
        other => other,
    };
    let fetched_at = v.get("fetchedAt")?.as_str()?.to_string();
    let models: Vec<CatalogModel> = v
        .get("models")?
        .as_array()?
        .iter()
        .filter(|m| {
            m.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| !js_trim(id).is_empty())
                && m.get("engines").is_some_and(Value::is_array)
        })
        // A row whose fields are not what a row holds is skipped (the JS kept whatever was there).
        .filter_map(|m| serde_json::from_value(m.clone()).ok())
        .collect();
    Some(CachedCatalog {
        fetched_at,
        models: Arc::new(models),
    })
}

fn write_cache(store: &dyn Settings, fetched_at: &str, models: &[CatalogModel]) {
    let value = json!({ "fetchedAt": fetched_at, "models": models });
    if let Err(err) = store.set(CATALOG_CACHE_KEY, value) {
        log::warn!("[models] couldn't cache OpenRouter's model list: {err}");
    }
}

/// One section of the picker: `{ id, label, models, searchable? }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Section {
    pub id: &'static str,
    pub label: &'static str,
    pub models: Vec<PickerRow>,
    /// Only on "All models": absent, not false, on the others.
    #[serde(skip_serializing_if = "is_false")]
    pub searchable: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A verification that passed, as a picker row shows it: `{ engine, at, engineVersion }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedSummary {
    pub engine: Engine,
    /// When it passed, as it was saved; null when it was not.
    pub at: Value,
    pub engine_version: Value,
}

/// One model in the picker's OpenRouter sections: the catalog row and what Tarsee knows about running it now. A
/// verified model OpenRouter no longer lists has no vision, pdf or engines to give (null).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerRow {
    pub id: String,
    pub label: String,
    pub vendor: String,
    pub context: Option<u64>,
    pub vision: Option<bool>,
    pub pdf: Option<bool>,
    pub price: Option<ModelPrice>,
    pub free: bool,
    pub reasoning: Option<Reasoning>,
    pub engines: Option<Vec<Engine>>,
    pub alias_of: Option<String>,
    pub retires: Option<String>,
    /// False for a verified model OpenRouter no longer lists.
    pub listed: bool,
    /// The engine that runs it now, or null (it must be verified first).
    pub engine: Option<Engine>,
    pub selectable: bool,
    pub needs_verify: bool,
    pub streaming: Option<bool>,
    pub efforts: Vec<String>,
    pub verified: Option<VerifiedSummary>,
    pub price_label: Option<String>,
}

impl PickerRow {
    fn listed(m: &CatalogModel) -> PickerRow {
        PickerRow {
            id: m.id.clone(),
            label: m.label.clone(),
            vendor: m.vendor.clone(),
            context: m.context,
            vision: Some(m.vision),
            pdf: Some(m.pdf),
            price: m.price,
            free: m.free,
            reasoning: m.reasoning.clone(),
            engines: Some(m.engines.clone()),
            alias_of: m.alias_of.clone(),
            retires: m.retires.clone(),
            listed: true,
            engine: None,
            selectable: false,
            needs_verify: true,
            streaming: None,
            efforts: Vec::new(),
            verified: None,
            price_label: None,
        }
    }

    /// A row for a model OpenRouter doesn't list (a verified one that has since gone).
    fn unlisted(id: &str) -> PickerRow {
        PickerRow {
            id: id.to_string(),
            label: id.to_string(),
            vendor: maker_of(id),
            context: None,
            vision: None,
            pdf: None,
            price: None,
            free: id.ends_with(":free"),
            reasoning: None,
            engines: None,
            alias_of: None,
            retires: None,
            listed: false,
            engine: None,
            selectable: false,
            needs_verify: true,
            streaming: None,
            efforts: Vec::new(),
            verified: None,
            price_label: None,
        }
    }
}

/// Rows whose id or name holds every word of the query (any case). An empty query keeps them all.
pub fn search_models<'a>(models: &'a [CatalogModel], query: &str) -> Vec<&'a CatalogModel> {
    let query = query.to_lowercase();
    let words: Vec<&str> = query.split(is_js_space).filter(|w| !w.is_empty()).collect();
    models
        .iter()
        .filter(|m| {
            let hay = format!("{} {}", m.id, m.label).to_lowercase();
            words.iter().all(|w| hay.contains(w))
        })
        .collect()
}

/// A price in plain words: "$2 in, $10 out per million tokens", "Free", or `None` when there is none.
pub fn price_label(price: Option<&ModelPrice>) -> Option<String> {
    let price = price?;
    if price.input == 0.0 && price.output == 0.0 {
        return Some("Free".to_string());
    }
    Some(format!(
        "{} in, {} out per million tokens",
        usd(price.input),
        usd(price.output)
    ))
}

fn usd(n: f64) -> String {
    if !n.is_finite() {
        return "?".to_string();
    }
    format!("${}", js_number_to_string(js_to_precision(n, 3)))
}

/// By name, then by id, as JavaScript orders strings (by UTF-16 unit).
fn by_label(a: &PickerRow, b: &PickerRow) -> std::cmp::Ordering {
    let name = |row: &PickerRow| if row.label.is_empty() { &row.id } else { &row.label }.to_lowercase();
    let (x, y) = (name(a), name(b));
    x.encode_utf16()
        .cmp(y.encode_utf16())
        .then_with(|| a.id.encode_utf16().cmp(b.id.encode_utf16()))
}

/// "~anthropic/claude-sonnet-latest" -> "anthropic"; "openrouter" for an id with no maker.
fn maker_of(id: &str) -> String {
    let s = id.strip_prefix('~').unwrap_or(id);
    let maker: String = match s.find('/') {
        Some(i) if i > 0 => s[..i]
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
            .collect(),
        _ => String::new(),
    };
    if maker.is_empty() {
        "openrouter".to_string()
    } else {
        maker
    }
}

/// The day at the start of a date ("2026-11-13T00:00:00Z" as "2026-11-13") and the moment that day begins in UTC,
/// in milliseconds since 1970; `None` when the text does not start with a date.
fn date_only(v: Option<&Value>) -> Option<(String, i64)> {
    let text = js_trim(v?.as_str()?);
    let day = text.get(..10)?;
    let bytes = day.as_bytes();
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && bytes[4] == b'-' && digits(5..7) && bytes[7] == b'-' && digits(8..10)) {
        return None;
    }
    let number = |range: std::ops::Range<usize>| day[range].parse::<u32>().ok();
    let (year, month, date) = (number(0..4)?, number(5..7)?, number(8..10)?);
    // As JavaScript reads a date: any month takes a day up to 31, the days past its end running into the next.
    if !(1..=12).contains(&month) || !(1..=31).contains(&date) {
        return None;
    }
    let first = chrono::NaiveDate::from_ymd_opt(year as i32, month, 1)?;
    let starts = first.checked_add_days(chrono::Days::new(u64::from(date - 1)))?;
    let starts_ms = starts.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis();
    Some((day.to_string(), starts_ms))
}

/// Claude Code's "[1m]" context suffix is the engine's business, not part of the model id.
fn strip_context_suffix(id: &str) -> &str {
    let cut = id.len().saturating_sub(4);
    if id.len() >= 4 && id.is_char_boundary(cut) && id[cut..].eq_ignore_ascii_case("[1m]") {
        &id[..cut]
    } else {
        id
    }
}

#[cfg(test)]
mod tests;
