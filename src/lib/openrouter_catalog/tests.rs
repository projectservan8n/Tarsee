//! Port of `test/openrouter-catalog.test.js`.
//!
//! OpenRouter's model catalog, design 4.11 and Phase 4.
//!   - The list comes from OpenRouter's public GET /api/v1/models: no key is ever sent with it.
//!   - Only models Tarsee can run are kept: tool use (supported_parameters), a chat endpoint one of the engines
//!     speaks (Claude Code: /api/v1/messages, Codex: /api/v1/responses; ":batch" copies only take batches), a price
//!     that can be shown (routers that pick a different model per request list -1), and not retired.
//!   - Prices, context, vision, Free (":free") and the reasoning levels each model lists become the picker's rows.
//!   - It is cached for 6 hours in the cache.openrouter.models setting and fed to the provider registry.
//!   - The picker has three sections: Recommended, Verified by you, All models (searchable; a row is selectable
//!     once Tarsee knows which engine runs it).
//!
//! `test/fixtures/openrouter-models.json` is a real response of that public endpoint, recorded 2026-11-09 and
//! trimmed to 43 of its 461 entries (each kept entry is verbatim), chosen to cover every rule above.
//!
//! The JS tests asked a loopback stand-in for openrouter.ai; here the app's HTTP client is the stand-in, and each
//! test has an app of its own, so there is no list to forget between tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use serde_json::{Value, json};

use super::*;
use crate::net::fetch::{Fetch, FetchResponse};
use crate::testkit::{Answer, MemorySettings, TestApp, test_app, test_app_with_env};

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/test/fixtures/openrouter-models.json"
));
/// Where the tests ask for the list: an address only the stubbed client answers.
const URL: &str = "https://openrouter.test/api/v1/models";
const HOUR: i64 = 60 * 60 * 1000;

fn body() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

/// 2026-11-09 12:00 UTC, the day the fixture was recorded.
fn now() -> i64 {
    Utc.with_ymd_and_hms(2026, 11, 9, 12, 0, 0).unwrap().timestamp_millis()
}

fn rows() -> Vec<CatalogModel> {
    parse_open_router_models(&body(), now()).unwrap()
}

fn ids<'a>(rows: impl IntoIterator<Item = &'a CatalogModel>) -> Vec<&'a str> {
    rows.into_iter().map(|m| m.id.as_str()).collect()
}

fn by_id<'a>(rows: &'a [CatalogModel], id: &str) -> Option<&'a CatalogModel> {
    rows.iter().find(|m| m.id == id)
}

fn row<'a>(rows: &'a [CatalogModel], id: &str) -> &'a CatalogModel {
    by_id(rows, id).unwrap_or_else(|| panic!("{id} is not in the list"))
}

fn raw(id: &str) -> Value {
    body()["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("{id} is not in the fixture"))
}

fn efforts(row: &CatalogModel) -> Vec<&str> {
    row.reasoning
        .as_ref()
        .unwrap()
        .efforts
        .iter()
        .map(String::as_str)
        .collect()
}

fn price(input: f64, output: f64, cache_read: f64, cache_write: f64) -> ModelPrice {
    ModelPrice {
        input,
        output,
        cache_read,
        cache_write,
        peak: None,
    }
}

/// Two JSON values with the same content, a whole number being the same written "2" or "2.0".
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_json(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|((k, v), (l, w))| k == l && same_json(v, w))
        }
        _ => a == b,
    }
}

// --- OpenRouter catalog: which models are kept ---

#[test]
fn keeps_the_36_models_tarsee_can_run_out_of_the_43_recorded() {
    assert_eq!(body()["data"].as_array().unwrap().len(), 43);
    assert_eq!(rows().len(), 36);
}

#[test]
fn drops_models_without_tool_use_whatever_endpoint_they_have() {
    let rows = rows();
    for id in [
        "tencent/hy-mt2-7b",
        "writer/palmyra-x5",
        "google/gemini-3.1-flash-image",
        "openai/gpt-5.4-image-2",
    ] {
        raw(id);
        assert!(by_id(&rows, id).is_none(), "{id}");
    }
}

#[test]
fn drops_the_batch_copies_which_only_take_batch_jobs() {
    let rows = rows();
    assert!(by_id(&rows, "anthropic/claude-sonnet-5.5:batch").is_none());
    assert!(by_id(&rows, "openai/gpt-6.1-sol:batch").is_none());
    assert!(by_id(&rows, "anthropic/claude-sonnet-5.5").is_some());
}

#[test]
fn drops_routers_whose_price_is_per_request_minus_1_no_cost_can_be_shown_or_bounded() {
    raw("openrouter/auto");
    assert!(by_id(&rows(), "openrouter/auto").is_none());
}

#[test]
fn keeps_the_latest_aliases_the_tools_filtered_endpoint_leaves_them_out_so_the_full_list_is_read() {
    let rows = rows();
    for id in [
        "~anthropic/claude-sonnet-latest",
        "~anthropic/claude-opus-latest",
        "~anthropic/claude-haiku-latest",
        "~openai/gpt-sol-latest",
    ] {
        assert!(by_id(&rows, id).is_some(), "{id}");
    }
    assert_eq!(
        row(&rows, "~anthropic/claude-sonnet-latest").alias_of.as_deref(),
        Some("anthropic/claude-sonnet-5.5")
    );
}

#[test]
fn drops_a_model_once_its_retirement_date_has_passed_and_says_when_one_is_retiring() {
    let rows = rows();
    assert_eq!(
        row(&rows, "liquid/lfm-2.5-2.6b:free").retires.as_deref(),
        Some("2026-11-13")
    );
    assert_eq!(
        row(&rows, "moonshotai/kimi-k2.5").retires.as_deref(),
        Some("2026-11-18")
    );
    let nov_14 = Utc.with_ymd_and_hms(2026, 11, 14, 0, 0, 0).unwrap().timestamp_millis();
    let later = parse_open_router_models(&body(), nov_14).unwrap();
    assert!(by_id(&later, "liquid/lfm-2.5-2.6b:free").is_none());
    // It is gone from the first moment of its last day (UTC), and there until then.
    let nov_13 = Utc.with_ymd_and_hms(2026, 11, 13, 0, 0, 0).unwrap().timestamp_millis();
    let on_the_day = parse_open_router_models(&body(), nov_13).unwrap();
    assert!(by_id(&on_the_day, "liquid/lfm-2.5-2.6b:free").is_none());
    let just_before = parse_open_router_models(&body(), nov_13 - 1).unwrap();
    assert!(by_id(&just_before, "liquid/lfm-2.5-2.6b:free").is_some());
    assert!(by_id(&later, "moonshotai/kimi-k2.5").is_some());
}

#[test]
fn skips_rows_it_cant_read_instead_of_failing_the_whole_list() {
    let data = json!({"data": [null, 7, {"id": ""}, {"id": "x/no-params"}, raw("z-ai/glm-5.3")]});
    let out = parse_open_router_models(&data, now()).unwrap();
    assert_eq!(ids(&out), ["z-ai/glm-5.3"]);
    let err = parse_open_router_models(&json!({"nope": true}), now()).unwrap_err();
    assert_eq!(err.to_string(), "OpenRouter's answer isn't a model list.");
    for not_a_list in [
        json!(null),
        json!("x"),
        json!([]),
        json!({"data": "no"}),
        json!({"data": {}}),
    ] {
        assert!(parse_open_router_models(&not_a_list, now()).is_err(), "{not_a_list}");
    }
}

// --- OpenRouter catalog: what each row says ---

#[test]
fn gives_prices_in_dollars_per_million_tokens_with_no_float_noise() {
    let rows = rows();
    assert_eq!(
        row(&rows, "anthropic/claude-sonnet-5.5").price,
        Some(price(2.0, 10.0, 0.1, 2.5))
    );
    assert_eq!(
        row(&rows, "openai/gpt-6-luna").price,
        Some(price(0.1, 0.5, 0.01, 0.125))
    );
    // No separate cache-write price listed: writes cost the input rate.
    assert_eq!(
        row(&rows, "z-ai/glm-5.3").price,
        Some(price(0.0699, 1.4, 0.0689, 0.0699))
    );
}

#[test]
fn marks_the_free_models_free_and_only_those_cost_nothing() {
    let rows = rows();
    let mut free = ids(rows.iter().filter(|m| m.free));
    free.sort();
    assert_eq!(
        free,
        [
            "cohere/north-mini-code:free",
            "google/gemma-4-26b-a4b-it:free",
            "google/gemma-4-31b-it:free",
            "liquid/lfm-2.5-2.6b:free",
            "nvidia/nemotron-3.5-super-vl:free",
        ]
    );
    for id in free {
        assert_eq!(row(&rows, id).price, Some(price(0.0, 0.0, 0.0, 0.0)), "{id}");
    }
}

#[test]
fn reads_the_context_window_the_maker_and_whether_it_can_see_images() {
    let rows = rows();
    let grok = row(&rows, "x-ai/grok-4.7");
    assert_eq!(grok.context, Some(500_000));
    assert_eq!(grok.vendor, "x-ai");
    assert!(grok.vision);
    assert!(!row(&rows, "z-ai/glm-5.3").vision);
    assert_eq!(row(&rows, "~anthropic/claude-sonnet-latest").vendor, "anthropic");
    assert_eq!(
        row(&rows, "anthropic/claude-opus-5.5").label,
        "Anthropic: Claude Opus 5.5"
    );
}

#[test]
fn sends_pdfs_natively_only_to_anthropics_models_the_rest_get_the_text() {
    let rows = rows();
    assert!(row(&rows, "anthropic/claude-sonnet-5.5").pdf);
    assert!(!row(&rows, "openai/gpt-6.1-sol").pdf);
    assert!(!row(&rows, "google/gemini-4-argon").pdf);
}

#[test]
fn shows_the_reasoning_levels_each_model_lists_as_tarsees_effort_levels_lowest_first() {
    let rows = rows();
    assert_eq!(efforts(row(&rows, "anthropic/claude-sonnet-5.5")), EFFORT_IDS);
    // "none" and "minimal" are not levels Tarsee offers.
    assert_eq!(efforts(row(&rows, "openai/gpt-6-luna")), EFFORT_IDS);
    assert_eq!(efforts(row(&rows, "z-ai/glm-5.3")), ["low", "high", "max"]);
    assert_eq!(efforts(row(&rows, "deepseek/deepseek-v4-pro")), ["high", "xhigh"]);
    assert_eq!(efforts(row(&rows, "google/gemini-4-argon")), ["low", "medium", "high"]);
    let default = |id: &str| row(&rows, id).reasoning.as_ref().unwrap().default.clone();
    assert_eq!(default("google/gemini-4-argon").as_deref(), Some("medium"));
    assert_eq!(default("x-ai/grok-4.7").as_deref(), Some("high"));
    // A model that reasons but lists no levels takes OpenRouter's common three.
    assert_eq!(efforts(row(&rows, "qwen/qwen3.8-flash")), ["low", "medium", "high"]);
    // One that doesn't reason has none.
    assert_eq!(row(&rows, "qwen/qwen3-coder").reasoning, None);
}

#[test]
fn knows_which_engines_a_models_endpoints_allow() {
    assert_eq!(
        row(&rows(), "google/gemini-4-argon").engines,
        [Engine::ClaudeCode, Engine::Codex]
    );
    let mut only_responses = raw("z-ai/glm-5.3");
    only_responses["endpoints"] = json!(["/api/v1/responses"]);
    let out = parse_open_router_models(&json!({"data": [only_responses]}), now()).unwrap();
    assert_eq!(out[0].engines, [Engine::Codex]);
    let mut unlisted = raw("z-ai/glm-5.3");
    unlisted.as_object_mut().unwrap().remove("endpoints");
    let out = parse_open_router_models(&json!({"data": [unlisted]}), now()).unwrap();
    assert_eq!(out[0].engines, [Engine::ClaudeCode, Engine::Codex]);
}

#[test]
fn labels_prices_in_plain_words() {
    let rows = rows();
    assert_eq!(
        price_label(row(&rows, "anthropic/claude-sonnet-5.5").price.as_ref()).as_deref(),
        Some("$2 in, $10 out per million tokens")
    );
    assert_eq!(
        price_label(row(&rows, "~deepseek/deepseek-flash-latest").price.as_ref()).as_deref(),
        Some("$0.006 in, $0.5 out per million tokens")
    );
    assert_eq!(price_label(Some(&price(0.0, 0.0, 0.0, 0.0))).as_deref(), Some("Free"));
    assert_eq!(price_label(None), None);
}

// --- OpenRouter catalog: fetching and the 6-hour cache ---

/// A key that must never be sent with the public list, even when it is right there in the environment.
fn canary() -> String {
    ["sk-or-", "v1-testcanary0000catalog"].concat()
}

struct Setup {
    t: TestApp,
    catalog: Arc<OpenRouterCatalog>,
    registry: Arc<ProviderRegistry>,
}

/// An app whose HTTP client answers the list's address with the recorded list.
fn setup() -> Setup {
    let t = test_app_with_env([("OPENROUTER_API_KEY", canary())]);
    t.fetch.respond(URL, Answer::bytes(200, "application/json", FIXTURE));
    let catalog = OpenRouterCatalog::of(&t);
    let registry = ProviderRegistry::of(&t);
    Setup { t, catalog, registry }
}

fn fresh_store() -> Arc<dyn Settings> {
    Arc::new(MemorySettings::new())
}

/// Ask the stand-in address, with the clock reading `at_ms`.
fn at(at_ms: i64) -> CatalogOptions {
    CatalogOptions {
        url: Some(URL.to_string()),
        now: Some(Arc::new(move || at_ms)),
        ..CatalogOptions::default()
    }
}

#[tokio::test]
async fn asks_openrouters_public_list_with_no_key() {
    assert_eq!(OPENROUTER_MODELS_URL, "https://openrouter.ai/api/v1/models");
    let s = setup();
    let out = s.catalog.refresh_open_router_catalog(fresh_store(), at(now())).await;
    assert_eq!(out.source, CatalogSource::Network);
    assert_eq!(out.models.len(), 36);
    assert_eq!(
        (out.fetched_at.as_deref(), out.error),
        (Some("2026-11-09T12:00:00.000Z"), None)
    );
    let calls = s.t.fetch.calls();
    assert_eq!(calls.len(), 1);
    let req = &calls[0];
    assert_eq!(req.method, "GET");
    assert_eq!(req.header("authorization"), None);
    assert!(!format!("{req:?}").contains(&canary()));
    // Only a request for JSON: nothing else is sent with it.
    assert_eq!(req.headers, [("accept".to_string(), "application/json".to_string())]);
    assert_eq!(req.body, "");
}

#[tokio::test]
async fn asks_openrouters_own_address_when_given_no_other() {
    let s = setup();
    s.t.fetch
        .respond(OPENROUTER_MODELS_URL, Answer::json(200, json!({"data": []})));
    let opts = CatalogOptions {
        now: Some(Arc::new(now)),
        ..CatalogOptions::default()
    };
    let out = s.catalog.refresh_open_router_catalog(fresh_store(), opts).await;
    assert_eq!((out.source, out.models.len()), (CatalogSource::Network, 0));
    assert_eq!(s.t.fetch.calls()[0].url, "https://openrouter.ai/api/v1/models");
}

#[tokio::test]
async fn caches_the_list_in_cache_openrouter_models_and_feeds_the_registry() {
    let s = setup();
    let store = fresh_store();
    s.catalog.refresh_open_router_catalog(store.clone(), at(now())).await;
    let cached = store.get(CATALOG_CACHE_KEY).unwrap();
    assert_eq!(cached["fetchedAt"], js::iso_from_ms(now()));
    assert_eq!(cached["models"].as_array().unwrap().len(), 36);
    assert_eq!(s.registry.catalog_models("openrouter").len(), 36);
    let sonnet = s
        .registry
        .price_for("openrouter", Some("~anthropic/claude-sonnet-latest"), Some(now()), None)
        .unwrap();
    assert_eq!(
        (
            sonnet.input,
            sonnet.output,
            sonnet.cache_read,
            sonnet.cache_write,
            sonnet.peak
        ),
        (2.0, 10.0, 0.1, 2.5, None)
    );
    assert_eq!(
        s.registry.context_tokens_for("openrouter", Some("x-ai/grok-4.7"), None),
        Some(500_000)
    );
    assert!(
        !s.registry
            .caps_for("openrouter", Some("z-ai/glm-5.3"), None)
            .unwrap()
            .vision
    );
    assert_eq!(s.catalog.open_router_models().len(), 36);
}

#[tokio::test]
async fn serves_the_cache_for_6_hours_then_fetches_again() {
    let s = setup();
    let store = fresh_store();
    s.catalog.refresh_open_router_catalog(store.clone(), at(now())).await;
    let again = s
        .catalog
        .refresh_open_router_catalog(store.clone(), at(now() + CATALOG_TTL_MS - 1))
        .await;
    assert_eq!(again.source, CatalogSource::Cache);
    assert_eq!(again.models.len(), 36);
    assert_eq!(s.t.fetch.calls().len(), 1);
    let later = s
        .catalog
        .refresh_open_router_catalog(store.clone(), at(now() + CATALOG_TTL_MS))
        .await;
    assert_eq!(later.source, CatalogSource::Network);
    assert_eq!(s.t.fetch.calls().len(), 2);
    assert_eq!(CATALOG_TTL_MS, 6 * HOUR);
    // A list dated after now (a clock set back) is not fresh either.
    let earlier = s.catalog.refresh_open_router_catalog(store, at(now() - 1)).await;
    assert_eq!(earlier.source, CatalogSource::Network);
}

#[tokio::test]
async fn fetches_again_when_forced() {
    let s = setup();
    let store = fresh_store();
    s.catalog.refresh_open_router_catalog(store.clone(), at(now())).await;
    let forced = CatalogOptions {
        force: true,
        ..at(now())
    };
    s.catalog.refresh_open_router_catalog(store, forced).await;
    assert_eq!(s.t.fetch.calls().len(), 2);
}

/// An HTTP client that answers what the app's own stubbed client answers, but only once it is let through; it
/// says when each request arrives. (The JS test's stand-in answered 50 ms late; here nothing waits on a clock.)
struct GatedFetch {
    inner: Arc<dyn Fetch>,
    gate: tokio::sync::Notify,
    started: AtomicUsize,
    arrived: tokio::sync::mpsc::UnboundedSender<()>,
}

impl GatedFetch {
    /// Puts a gate in front of the app's client. The receiver gets a message for every request that arrives.
    fn before(t: &TestApp) -> (Arc<GatedFetch>, tokio::sync::mpsc::UnboundedReceiver<()>) {
        let (arrived, arrivals) = tokio::sync::mpsc::unbounded_channel();
        let gated = Arc::new(GatedFetch {
            inner: t.app.fetch(),
            gate: tokio::sync::Notify::new(),
            started: AtomicUsize::new(0),
            arrived,
        });
        t.app.set_fetch(gated.clone());
        (gated, arrivals)
    }

    /// Lets one request through: the one waiting, or the next to arrive.
    fn let_one_through(&self) {
        self.gate.notify_one();
    }
}

#[async_trait]
impl Fetch for GatedFetch {
    async fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, FetchError> {
        self.started.fetch_add(1, Ordering::SeqCst);
        let _ = self.arrived.send(());
        self.gate.notified().await;
        self.inner.fetch(request).await
    }
}

#[tokio::test]
async fn asks_once_when_two_callers_want_the_list_at_the_same_time() {
    let s = setup();
    let (gated, _arrivals) = GatedFetch::before(&s.t);
    let store = fresh_store();
    // Both callers are waiting before the one request is let through.
    // (Only one is let through: were each caller to ask on its own, the second would wait at the gate, and the
    // time limit here would fail the test instead of leaving it waiting.)
    let both = async {
        tokio::join!(
            s.catalog.refresh_open_router_catalog(store.clone(), at(now())),
            s.catalog.refresh_open_router_catalog(store.clone(), at(now())),
            async { gated.let_one_through() },
        )
    };
    let (a, b, ()) = tokio::time::timeout(Duration::from_secs(10), both)
        .await
        .expect("the two callers did not share one request");
    assert_eq!(gated.started.load(Ordering::SeqCst), 1);
    assert_eq!(s.t.fetch.calls().len(), 1);
    assert_eq!(a.models.len(), 36);
    assert_eq!(b.models.len(), 36);
    // Both were handed the one answer, not one the list and the other its cached copy.
    assert_eq!((a.source, b.source), (CatalogSource::Network, CatalogSource::Network));
    // The fetch in progress is forgotten once it is done: a forced refresh asks again.
    let forced = CatalogOptions {
        force: true,
        ..at(now())
    };
    gated.let_one_through();
    s.catalog.refresh_open_router_catalog(store, forced).await;
    assert_eq!(gated.started.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn keeps_the_last_list_when_openrouter_cant_be_reached_and_says_why() {
    let s = setup();
    let store = fresh_store();
    s.catalog.refresh_open_router_catalog(store.clone(), at(now())).await;
    s.t.fetch.respond(
        URL,
        Answer::connect_error("tcp connect error: Connection refused (os error 111)"),
    );
    s.registry.set_catalog_models("openrouter", &[]).unwrap();
    let out = s.catalog.refresh_open_router_catalog(store, at(now() + 7 * HOUR)).await;
    assert_eq!(out.source, CatalogSource::Stale);
    assert_eq!(
        out.error.as_deref(),
        Some("Tarsee couldn't reach OpenRouter for its model list (ECONNREFUSED).")
    );
    assert_eq!(out.models.len(), 36);
    assert_eq!(out.fetched_at.as_deref(), Some("2026-11-09T12:00:00.000Z"));
    assert_eq!(s.registry.catalog_models("openrouter").len(), 36);
}

#[tokio::test]
async fn the_last_list_is_the_stores_cached_one_or_failing_that_the_one_in_hand() {
    let s = setup();
    let rows = rows();
    s.t.fetch.respond(URL, Answer::text(502, "bad gateway"));
    // A cached list in the store and nothing in hand (a fresh boot whose first request fails).
    let cached: Arc<dyn Settings> = Arc::new(MemorySettings::from_pairs([(
        CATALOG_CACHE_KEY,
        json!({"fetchedAt": js::iso_from_ms(now() - 7 * HOUR), "models": &rows[..4]}),
    )]));
    let out = s.catalog.refresh_open_router_catalog(cached.clone(), at(now())).await;
    assert_eq!((out.source, out.models.len()), (CatalogSource::Stale, 4));
    assert_eq!(out.fetched_at, Some(js::iso_from_ms(now() - 7 * HOUR)));
    assert_eq!(s.catalog.open_router_models().len(), 4);
    // Both: the store's cached list is the one kept, not the one in hand.
    s.catalog.set_models_for_tests(rows[..9].to_vec());
    let out = s.catalog.refresh_open_router_catalog(cached, at(now())).await;
    assert_eq!((out.source, out.models.len()), (CatalogSource::Stale, 4));
    // A list in hand and nothing cached (a store that could not save it).
    s.catalog.set_models_for_tests(rows[..9].to_vec());
    let out = s.catalog.refresh_open_router_catalog(fresh_store(), at(now())).await;
    assert_eq!(
        (out.source, out.models.len(), out.fetched_at),
        (CatalogSource::Stale, 9, None)
    );
    assert_eq!(
        out.error.as_deref(),
        Some("OpenRouter answered 502 when asked for its model list.")
    );
}

#[tokio::test]
async fn never_throws_no_cache_and_no_answer_gives_an_empty_list_and_the_reason() {
    let s = setup();
    s.t.fetch.respond(URL, Answer::text(503, "busy"));
    let out = s.catalog.refresh_open_router_catalog(fresh_store(), at(now())).await;
    assert_eq!(out.source, CatalogSource::None);
    assert!(out.models.is_empty());
    assert_eq!(out.fetched_at, None);
    assert_eq!(
        out.error.as_deref(),
        Some("OpenRouter answered 503 when asked for its model list.")
    );
}

#[tokio::test]
async fn rejects_an_answer_that_isnt_the_model_list() {
    let s = setup();
    s.t.fetch.respond(URL, Answer::text(200, "{\"data\": \"no\"}"));
    let out = s.catalog.refresh_open_router_catalog(fresh_store(), at(now())).await;
    assert_eq!(out.source, CatalogSource::None);
    assert_eq!(out.error.as_deref(), Some("OpenRouter's answer isn't a model list."));
    // Nothing was cached and nothing reached the registry.
    assert!(s.catalog.open_router_models().is_empty());
}

#[tokio::test]
async fn loads_the_cached_list_at_boot_without_asking_openrouter() {
    let s = setup();
    let store = fresh_store();
    s.catalog.refresh_open_router_catalog(store.clone(), at(now())).await;
    s.registry.set_catalog_models("openrouter", &[]).unwrap();
    s.catalog.reset_for_tests();
    assert!(s.catalog.open_router_models().is_empty());
    let loaded = s.catalog.load_open_router_catalog(store.as_ref()).unwrap();
    assert_eq!(loaded.models.len(), 36);
    assert_eq!(loaded.fetched_at, "2026-11-09T12:00:00.000Z");
    assert_eq!(s.registry.catalog_models("openrouter").len(), 36);
    assert_eq!(s.t.fetch.calls().len(), 1);
    assert_eq!(s.catalog.load_open_router_catalog(&MemorySettings::new()), None);
}

#[tokio::test]
async fn init_loads_the_cache_refreshes_in_the_background_and_can_be_stopped() {
    let s = setup();
    let opts = CatalogOptions {
        interval: Some(Duration::from_secs(60)),
        ..at(now())
    };
    let handle = init_open_router_catalog(&s.t, fresh_store(), opts);
    let first = handle.ready().await;
    assert_eq!(first.source, CatalogSource::Network);
    assert_eq!(s.t.fetch.calls().len(), 1);
    // The result can be asked for again: it is the same one.
    assert_eq!(handle.ready().await, first);
    handle.stop();
}

// --- OpenRouter picker sections ---

/// An app whose catalog already holds the recorded list.
fn loaded() -> Setup {
    let s = setup();
    s.catalog.set_models_for_tests(rows());
    s
}

fn section<'a>(sections: &'a [Section], id: &str) -> &'a Section {
    sections
        .iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("section {id}"))
}

fn picker_row<'a>(rows: &'a [PickerRow], id: &str) -> &'a PickerRow {
    rows.iter()
        .find(|m| m.id == id)
        .unwrap_or_else(|| panic!("{id} is not in the section"))
}

fn row_ids(rows: &[PickerRow]) -> Vec<&str> {
    rows.iter().map(|m| m.id.as_str()).collect()
}

#[test]
fn has_recommended_verified_by_you_and_all_models_in_that_order() {
    let s = loaded();
    let sections = s.catalog.open_router_sections(Some(&MemorySettings::new()), "", None);
    assert_eq!(
        sections.iter().map(|s| (s.id, s.label)).collect::<Vec<_>>(),
        [
            ("recommended", "Recommended"),
            ("verified", "Verified by you"),
            ("all", "All models")
        ]
    );
    assert!(section(&sections, "all").searchable);
    // Only "All models" says it can be searched; the others don't carry the field at all.
    let sent = serde_json::to_value(&sections).unwrap();
    assert_eq!(sent[2]["searchable"], true);
    assert!(sent[0].get("searchable").is_none() && sent[1].get("searchable").is_none());
}

#[test]
fn recommends_the_default_first_then_the_other_tier_models_all_ready_to_pick() {
    let s = loaded();
    let sections = s.catalog.open_router_sections(Some(&MemorySettings::new()), "", None);
    let rec = &section(&sections, "recommended").models;
    assert_eq!(
        row_ids(rec),
        [
            "~anthropic/claude-sonnet-latest",
            "~anthropic/claude-opus-latest",
            "~anthropic/claude-haiku-latest"
        ]
    );
    for m in rec {
        assert!(m.selectable, "{}", m.id);
        assert_eq!(m.engine, Some(Engine::ClaudeCode), "{}", m.id);
        assert_eq!(m.streaming, Some(true), "{}", m.id);
        assert_eq!(m.efforts, EFFORT_IDS, "{}", m.id);
    }
    assert_eq!(rec[0].price_label.as_deref(), Some("$2 in, $10 out per million tokens"));
    assert_eq!(rec[0].context, Some(1_000_000));
}

#[test]
fn lists_every_runnable_model_under_all_models_sorted_by_name_with_free_badges() {
    let s = loaded();
    let sections = s.catalog.open_router_sections(Some(&MemorySettings::new()), "", None);
    let all = &section(&sections, "all").models;
    assert_eq!(all.len(), 36);
    let labels: Vec<String> = all.iter().map(|m| m.label.to_lowercase()).collect();
    let mut sorted = labels.clone();
    sorted.sort();
    assert_eq!(labels, sorted);
    let gemma = picker_row(all, "google/gemma-4-31b-it:free");
    assert!(gemma.free);
    assert_eq!(gemma.price_label.as_deref(), Some("Free"));
}

#[test]
fn makes_a_model_selectable_only_once_tarsee_knows_its_engine_anthropic_and_openai_now_any_other_maker_after_verify() {
    let s = loaded();
    let sections = s.catalog.open_router_sections(Some(&MemorySettings::new()), "", None);
    let all = &section(&sections, "all").models;
    assert!(picker_row(all, "anthropic/claude-opus-5.5").selectable);
    let sol = picker_row(all, "openai/gpt-6.1-sol");
    assert!(sol.selectable);
    assert_eq!(sol.engine, Some(Engine::Codex));
    assert_eq!(sol.streaming, Some(false));
    for id in [
        "google/gemini-4-argon",
        "qwen/qwen3.8-flash",
        "deepseek/deepseek-v4.1-flash",
        "google/gemma-4-31b-it:free",
    ] {
        let row = picker_row(all, id);
        assert!(!row.selectable, "{id}");
        assert!(row.needs_verify, "{id}");
        assert_eq!(row.engine, None, "{id}");
        assert_eq!(row.streaming, None, "{id}");
        assert!(row.efforts.is_empty(), "{id}: nothing to pick until it is verified");
    }
    // What the model itself lists stays on the row either way.
    assert_eq!(
        picker_row(all, "qwen/qwen3.8-flash")
            .reasoning
            .as_ref()
            .unwrap()
            .efforts,
        ["low", "medium", "high"]
    );
}

#[test]
fn shows_the_owners_own_verified_models_under_verified_by_you_with_the_engine_and_efforts_that_passed() {
    let s = loaded();
    let store = MemorySettings::new();
    store
        .set(
            "ai.openrouter.verified",
            json!({
                "qwen/qwen3.8-flash": {
                    "engine": "codex", "at": "2026-11-09T12:00:00.000Z", "engineVersion": "0.167.0",
                    "efforts": ["low", "high"], "checks": {"reply": true, "tool": true, "shell": true, "resume": true},
                },
                "gone/retired-model": {
                    "engine": "claude-code", "at": "2026-10-01T00:00:00.000Z", "engineVersion": "2.1.300", "efforts": [],
                },
            }),
        )
        .unwrap();
    let sections = s.catalog.open_router_sections(Some(&store), "", None);
    let mine = &section(&sections, "verified").models;
    assert_eq!(row_ids(mine), ["qwen/qwen3.8-flash", "gone/retired-model"]);
    let qwen = picker_row(mine, "qwen/qwen3.8-flash");
    assert!(qwen.selectable);
    assert_eq!(qwen.engine, Some(Engine::Codex));
    assert_eq!(qwen.efforts, ["low", "high"]);
    assert_eq!(qwen.verified.as_ref().unwrap().engine, Engine::Codex);
    assert_eq!(qwen.label, "Qwen: Qwen3.8 Flash");
    // A model OpenRouter no longer lists still shows, by its id.
    let gone = picker_row(mine, "gone/retired-model");
    assert_eq!(gone.label, "gone/retired-model");
    assert!(!gone.listed);
    // And All models marks it ready too.
    assert!(picker_row(&section(&sections, "all").models, "qwen/qwen3.8-flash").selectable);
}

#[test]
fn searches_all_models_by_name_or_id_every_word_must_match() {
    let s = loaded();
    let store = MemorySettings::new();
    let all = |query: &str| {
        let sections = s.catalog.open_router_sections(Some(&store), query, None);
        let mut found: Vec<String> = section(&sections, "all").models.iter().map(|m| m.id.clone()).collect();
        found.sort();
        found
    };
    assert_eq!(
        all("kimi"),
        ["moonshotai/kimi-k2.5", "moonshotai/kimi-k3", "~moonshotai/kimi-latest"]
    );
    assert_eq!(
        all("gemma free"),
        ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"]
    );
    let one = [CatalogModel {
        label: "Alpha".to_string(),
        ..row(&rows(), "z-ai/glm-5.3").clone()
    }];
    assert_eq!(search_models(&one, "  "), [&one[0]]);
    // The other sections are short and stay whole.
    let sections = s.catalog.open_router_sections(Some(&store), "kimi", None);
    assert_eq!(section(&sections, "recommended").models.len(), 3);
}

#[test]
fn knows_which_engines_to_try_a_model_on_from_its_endpoints() {
    let s = loaded();
    assert_eq!(
        s.catalog.catalog_engines_for("google/gemini-4-argon"),
        Some(vec![Engine::ClaudeCode, Engine::Codex])
    );
    assert_eq!(s.catalog.catalog_engines_for("not/listed"), None);
}

// --- What the JS suite did not test ---

#[test]
fn a_row_is_the_json_the_node_version_cached_and_a_picker_row_the_json_it_sent() {
    let rows = rows();
    let node_row: Value = serde_json::from_str(
        r#"{"id":"liquid/lfm-2.5-2.6b:free","label":"LiquidAI: LFM2.5-2.6B (free)","vendor":"liquid","context":65536,"vision":false,"pdf":false,"price":{"in":0,"out":0,"cacheRead":0,"cacheWrite":0},"free":true,"reasoning":{"efforts":["low","medium","high"],"default":null,"mandatory":true},"engines":["claude-code","codex"],"aliasOf":null,"retires":"2026-11-13"}"#,
    )
    .unwrap();
    let liquid = row(&rows, "liquid/lfm-2.5-2.6b:free");
    assert!(
        same_json(&serde_json::to_value(liquid).unwrap(), &node_row),
        "the same keys in the same order"
    );
    // And the row the Node version cached reads back as the same row.
    assert_eq!(&serde_json::from_value::<CatalogModel>(node_row).unwrap(), liquid);

    let s = loaded();
    let store = MemorySettings::from_pairs([(
        "ai.openrouter.verified",
        json!({
            "qwen/qwen3.8-flash": {"engine": "codex", "at": "2026-11-09T12:00:00.000Z", "engineVersion": "0.167.0", "efforts": ["low", "high"]},
            "gone/free-one:free": {"engine": "codex"},
        }),
    )]);
    let sections = s.catalog.open_router_sections(Some(&store), "", None);
    let node_section: Value = serde_json::from_str(
        r#"[{"id":"qwen/qwen3.8-flash","label":"Qwen: Qwen3.8 Flash","vendor":"qwen","context":1000000,"vision":true,"pdf":false,"price":{"in":0.15,"out":0.47,"cacheRead":0.016,"cacheWrite":0.15},"free":false,"reasoning":{"efforts":["low","medium","high"],"default":null,"mandatory":false},"engines":["claude-code","codex"],"aliasOf":null,"retires":null,"listed":true,"engine":"codex","selectable":true,"needsVerify":false,"streaming":false,"efforts":["low","high"],"verified":{"engine":"codex","at":"2026-11-09T12:00:00.000Z","engineVersion":"0.167.0"},"priceLabel":"$0.15 in, $0.47 out per million tokens"},{"id":"gone/free-one:free","label":"gone/free-one:free","vendor":"gone","context":null,"vision":null,"pdf":null,"price":null,"free":true,"reasoning":null,"engines":null,"aliasOf":null,"retires":null,"listed":false,"engine":"codex","selectable":true,"needsVerify":false,"streaming":false,"efforts":[],"verified":{"engine":"codex","at":null,"engineVersion":null},"priceLabel":null}]"#,
    )
    .unwrap();
    let mine = serde_json::to_value(&section(&sections, "verified").models).unwrap();
    assert!(same_json(&mine, &node_section), "{mine}");
}

#[test]
fn the_cache_the_node_version_wrote_is_read_whether_the_store_hands_it_back_parsed_or_as_text() {
    let rows = rows();
    let value = json!({"fetchedAt": "2026-11-09T12:00:00.000Z", "models": &rows[..3]});
    let s = setup();
    for held in [value.clone(), json!(value.to_string())] {
        let store = MemorySettings::from_pairs([(CATALOG_CACHE_KEY, held)]);
        let cached = s.catalog.load_open_router_catalog(&store).unwrap();
        assert_eq!(cached.models.as_slice(), &rows[..3]);
        assert_eq!(s.catalog.open_router_models().len(), 3);
    }
    // Rows without an id or a list of engines are left out, as the JS left them out; the rest are kept.
    let patchy = json!({"fetchedAt": "2026-11-09T12:00:00.000Z", "models": [
        null, 5, {"id": "no/engines"}, {"id": "  ", "engines": []}, {"id": 7, "engines": []},
        {"id": "bare/row", "engines": ["codex"]}, rows[0],
    ]});
    let store = MemorySettings::from_pairs([(CATALOG_CACHE_KEY, patchy)]);
    let cached = s.catalog.load_open_router_catalog(&store).unwrap();
    assert_eq!(ids(cached.models.iter()), ["bare/row", rows[0].id.as_str()]);
    assert_eq!(cached.models[0].engines, [Engine::Codex]);
    // Not a cache at all.
    for not in [
        json!("not json"),
        json!({"models": []}),
        json!({"fetchedAt": 5, "models": []}),
        json!([]),
    ] {
        let store = MemorySettings::from_pairs([(CATALOG_CACHE_KEY, not.clone())]);
        assert_eq!(s.catalog.load_open_router_catalog(&store), None, "{not}");
    }
}

#[test]
fn with_no_list_loaded_the_sections_are_drawn_from_the_cached_one() {
    let s = setup();
    let rows = rows();
    let store = MemorySettings::from_pairs([(
        CATALOG_CACHE_KEY,
        json!({"fetchedAt": "2026-11-09T12:00:00.000Z", "models": &rows[..7]}),
    )]);
    let sections = s.catalog.open_router_sections(Some(&store), "", None);
    assert_eq!(section(&sections, "all").models.len(), 7);
    // With neither, the recommended models still show, by their ids, and none is listed.
    let sections = s.catalog.open_router_sections(None, "", None);
    assert!(section(&sections, "all").models.is_empty());
    let rec = &section(&sections, "recommended").models;
    assert_eq!(rec.len(), 3);
    assert!(rec.iter().all(|m| !m.listed && m.selectable && m.label == m.id));
    // A list given by the caller stands in for the current one; of two rows with one id the later is the one shown.
    let copy = |label: &str| CatalogModel {
        label: label.to_string(),
        id: "~anthropic/claude-sonnet-latest".to_string(),
        ..rows[0].clone()
    };
    let given = [copy("First Copy"), rows[1].clone(), copy("Second Copy")];
    let sections = s.catalog.open_router_sections(None, "", Some(&given));
    assert_eq!(section(&sections, "all").models.len(), 3);
    assert_eq!(section(&sections, "recommended").models[0].label, "Second Copy");
}

#[tokio::test]
async fn a_request_that_takes_too_long_or_is_stopped_says_so_and_never_fails() {
    let s = setup();
    // The stand-in never answers: what ends the wait is the request's own time limit.
    s.t.fetch.respond(URL, Answer::Hang);
    let slow = CatalogOptions {
        timeout: Some(Duration::from_millis(10)),
        ..at(now())
    };
    let out = s.catalog.refresh_open_router_catalog(fresh_store(), slow).await;
    assert_eq!(out.source, CatalogSource::None);
    assert_eq!(
        out.error.as_deref(),
        Some("Tarsee couldn't reach OpenRouter for its model list (it took too long to answer).")
    );
    // Stopped by its caller.
    let cancel = CancellationToken::new();
    cancel.cancel();
    let stopped = CatalogOptions {
        cancel: Some(cancel),
        ..at(now())
    };
    let out = s.catalog.refresh_open_router_catalog(fresh_store(), stopped).await;
    assert_eq!(
        out.error.as_deref(),
        Some("Tarsee couldn't reach OpenRouter for its model list (20).")
    );
}

#[tokio::test]
async fn an_answer_that_cant_be_read_or_a_host_that_cant_be_found_says_which() {
    let s = setup();
    let ask = || s.catalog.refresh_open_router_catalog(fresh_store(), at(now()));
    s.t.fetch.respond(URL, Answer::text(200, "<html>not json</html>"));
    assert_eq!(
        ask().await.error.as_deref(),
        Some("OpenRouter's model list couldn't be read.")
    );
    s.t.fetch.respond(
        URL,
        Answer::connect_error("dns error: failed to lookup address information"),
    );
    assert_eq!(
        ask().await.error.as_deref(),
        Some("Tarsee couldn't reach OpenRouter for its model list (ENOTFOUND).")
    );
    s.t.fetch
        .respond(URL, Answer::connect_error("something this code has no name for"));
    assert_eq!(
        ask().await.error.as_deref(),
        Some("Tarsee couldn't reach OpenRouter for its model list (something this code has no name for).")
    );
    assert_eq!(connect_code("connection reset by peer"), "ECONNRESET");
    assert_eq!(connect_code("operation timed out"), "ETIMEDOUT");
    assert_eq!(connect_code(""), "network error");
}

#[tokio::test]
async fn a_store_that_cant_save_the_list_does_not_stop_it_being_used() {
    struct ReadOnly;
    impl Settings for ReadOnly {
        fn get(&self, _key: &str) -> Option<Value> {
            None
        }
        fn set(&self, _key: &str, _value: Value) -> anyhow::Result<()> {
            anyhow::bail!("attempt to write a readonly database")
        }
        fn delete(&self, _key: &str) -> bool {
            false
        }
        fn get_by_prefix(&self, _prefix: &str) -> Vec<(String, Value)> {
            Vec::new()
        }
    }
    let s = setup();
    let out = s
        .catalog
        .refresh_open_router_catalog(Arc::new(ReadOnly), at(now()))
        .await;
    assert_eq!(
        (out.source, out.models.len(), out.error),
        (CatalogSource::Network, 36, None)
    );
    assert_eq!(s.registry.catalog_models("openrouter").len(), 36);
}

#[tokio::test]
async fn the_list_is_asked_for_again_every_interval_until_it_is_stopped() {
    let s = setup();
    let (gated, mut arrivals) = GatedFetch::before(&s.t);
    let interval = Duration::from_millis(150);
    let opts = CatalogOptions {
        interval: Some(interval),
        ..at(now())
    };
    // Each wait below is for the request itself to arrive, however long the machine takes to get there.
    let mut next_request = async || {
        tokio::time::timeout(Duration::from_secs(30), arrivals.recv())
            .await
            .expect("the list was not asked for again")
            .expect("the client is gone");
        gated.let_one_through();
    };
    let started = std::time::Instant::now();
    let mut handle = init_open_router_catalog(&s.t, fresh_store(), opts);
    next_request().await;
    assert_eq!(handle.ready().await.source, CatalogSource::Network);
    // Once for each interval after that, even though the cached list is still fresh.
    next_request().await;
    assert!(
        started.elapsed() >= interval,
        "the first repeat comes a whole interval after boot, not at once"
    );
    next_request().await;
    assert_eq!(gated.started.load(Ordering::SeqCst), 3);
    handle.stop();
    // The task that asked is over: nothing is left to ask again.
    let ended = (&mut handle.timer).await;
    assert!(ended.is_err_and(|err| err.is_cancelled()));
    assert_eq!(gated.started.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn the_refreshing_ends_by_itself_once_the_app_is_gone() {
    let s = setup();
    let opts = CatalogOptions {
        interval: Some(Duration::from_millis(10)),
        ..at(now())
    };
    let handle = init_open_router_catalog(&s.t, fresh_store(), opts);
    handle.ready().await;
    // The catalog and the registry are still held here; the app itself is not.
    let Setup { t, catalog, registry } = s;
    let app = t.app.downgrade();
    drop(t);
    assert!(app.upgrade().is_none());
    let ended = tokio::time::timeout(Duration::from_secs(30), handle.timer)
        .await
        .expect("the list went on being asked for after the app had gone");
    assert!(ended.is_ok(), "the task ended by itself, not by being stopped");
    drop((catalog, registry));
}

#[tokio::test]
async fn init_puts_the_cached_list_to_use_before_openrouter_answers() {
    let s = setup();
    let rows = rows();
    let store: Arc<dyn Settings> = Arc::new(MemorySettings::from_pairs([(
        CATALOG_CACHE_KEY,
        json!({"fetchedAt": js::iso_from_ms(now() - 7 * HOUR), "models": &rows[..5]}),
    )]));
    s.t.fetch.respond(URL, Answer::text(500, "down"));
    let handle = init_open_router_catalog(&s.t, store, at(now()));
    // Already there, with no await between.
    assert_eq!(s.catalog.open_router_models().len(), 5);
    assert_eq!(s.registry.catalog_models("openrouter").len(), 5);
    let first = handle.ready().await;
    assert_eq!(first.source, CatalogSource::Stale);
    assert_eq!(first.models.len(), 5);
    assert_eq!(
        first.error.as_deref(),
        Some("OpenRouter answered 500 when asked for its model list.")
    );
    handle.stop();
}

#[test]
fn each_app_has_a_catalog_of_its_own() {
    let a = loaded();
    let b = test_app();
    assert_eq!(OpenRouterCatalog::of(&a.t).open_router_models().len(), 36);
    assert!(OpenRouterCatalog::of(&b).open_router_models().is_empty());
    assert!(ProviderRegistry::of(&b).catalog_models("openrouter").is_empty());
    assert!(a.catalog.catalog_model(" google/gemini-4-argon[1M] ").is_some());
    assert_eq!(a.catalog.catalog_model("not/listed"), None);
}

#[test]
fn odd_rows_are_read_as_the_javascript_read_them() {
    let base = raw("z-ai/glm-5.3");
    let with = |id: &str, change: Value| {
        let mut row = base.clone();
        row["id"] = json!(id);
        row.as_object_mut().unwrap().extend(change.as_object().unwrap().clone());
        row
    };
    let data = json!({"data": [
        with("  spaced/id  ", json!({"name": "  Spaced  "})),
        with("dup/one", json!({})),
        with("dup/one", json!({"name": "second"})),
        with("no/endpoint", json!({"endpoints": []})),
        with("image/only", json!({"architecture": {"output_modalities": ["image"]}})),
        with("noslash", json!({"name": 5})),
        with("Up Per+x/y:free", json!({})),
        with("c/ctx", json!({"context_length": 0, "top_provider": {"context_length": "8192"}})),
        with("date/past", json!({"expiration_date": "2026-11-09T23:59:59Z"})),
        with("date/next", json!({"expiration_date": " 2026-11-10 "})),
        with("date/feb-31", json!({"expiration_date": "2027-02-31"})),
        with("date/month-13", json!({"expiration_date": "2026-13-01"})),
        with("price/per-request", json!({"pricing": {"prompt": "0.000001", "completion": "-1"}})),
        with("price/none", json!({"pricing": {"prompt": "", "completion": "0.1"}})),
        with("price/numbers", json!({"pricing": {"prompt": 0.0000003, "completion": "5e-6", "input_cache_read": "-1", "input_cache_write": "0.000000375"}})),
        with("price/tiny", json!({"pricing": {"prompt": "0.0000000000005", "completion": "0.000000000000449"}})),
        with("reason/listed", json!({"reasoning": {"supported_efforts": ["max", "none", "low"], "default_effort": "minimal", "mandatory": "yes"}, "supported_parameters": ["tools"]})),
        with("reason/empty", json!({"reasoning": {"supported_efforts": []}, "supported_parameters": ["tools", "reasoning"]})),
        with("reason/none", json!({"reasoning": {"supported_efforts": []}, "supported_parameters": ["tools"]})),
    ]});
    let out = parse_open_router_models(&data, now()).unwrap();
    assert_eq!(
        ids(&out),
        [
            "spaced/id",
            "dup/one",
            "noslash",
            "Up Per+x/y:free",
            "c/ctx",
            "date/next",
            "date/feb-31",
            "date/month-13",
            "price/none",
            "price/numbers",
            "price/tiny",
            "reason/listed",
            "reason/empty",
            "reason/none"
        ]
    );
    assert_eq!(row(&out, "spaced/id").label, "Spaced");
    assert_ne!(
        row(&out, "dup/one").label,
        "second",
        "the first of two rows with one id is the one kept"
    );
    assert_eq!(
        (
            row(&out, "noslash").label.as_str(),
            row(&out, "noslash").vendor.as_str()
        ),
        ("noslash", "openrouter")
    );
    let upper = row(&out, "Up Per+x/y:free");
    assert_eq!((upper.vendor.as_str(), upper.free), ("upperx", true));
    assert_eq!(row(&out, "c/ctx").context, Some(8192));
    assert_eq!(row(&out, "date/next").retires.as_deref(), Some("2026-11-10"));
    // A day past the end of its month runs into the next, as a JavaScript date does; a 13th month is no date.
    assert_eq!(row(&out, "date/feb-31").retires.as_deref(), Some("2027-02-31"));
    assert_eq!(row(&out, "date/month-13").retires, None);
    assert_eq!(row(&out, "price/none").price, None);
    assert_eq!(row(&out, "price/numbers").price, Some(price(0.3, 5.0, 0.3, 0.375)));
    assert_eq!(
        row(&out, "price/tiny").price,
        Some(price(0.000001, 0.0, 0.000001, 0.000001))
    );
    assert!(!row(&out, "price/tiny").free, "only what costs nothing at all is free");
    assert_eq!(
        row(&out, "reason/listed").reasoning,
        Some(Reasoning {
            efforts: vec!["low".to_string(), "max".to_string()],
            default: None,
            mandatory: false
        })
    );
    assert_eq!(
        row(&out, "reason/empty").reasoning.as_ref().unwrap().efforts,
        Vec::<String>::new()
    );
    assert_eq!(row(&out, "reason/none").reasoning, None);
}

#[test]
fn a_price_label_keeps_three_figures_as_javascript_wrote_them() {
    let label = |input: f64, output: f64| price_label(Some(&price(input, output, input, input)));
    assert_eq!(
        label(0.0699, 1.4).as_deref(),
        Some("$0.0699 in, $1.4 out per million tokens")
    );
    assert_eq!(
        label(1.125, 999.5).as_deref(),
        Some("$1.13 in, $1000 out per million tokens")
    );
    assert_eq!(
        label(1234.5, 0.000123456).as_deref(),
        Some("$1230 in, $0.000123 out per million tokens")
    );
    assert_eq!(
        label(1e-7, 3e-7).as_deref(),
        Some("$1e-7 in, $3e-7 out per million tokens")
    );
    assert_eq!(
        label(f64::INFINITY, 1.0).as_deref(),
        Some("? in, $1 out per million tokens")
    );
    assert_eq!(CatalogSource::Stale.as_str(), "stale");
    assert_eq!(serde_json::to_value(CatalogSource::None).unwrap(), json!("none"));
}
