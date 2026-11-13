//! Port of `test/spend.test.js` (design 4.13 and 4.6h): what a turn's tokens cost on each provider, the per-turn
//! dollar ceiling that keeps today's $0.50 background limit on every metered provider, and the optional monthly cap
//! (ai.spendCap.monthlyUsd, off when empty) that refuses metered turns only. Plans are never priced: "Included in
//! plan".

use serde_json::json;

use super::*;
use crate::ai::provider_registry::Price;
use crate::testkit::{MemorySettings, TestApp, test_app, test_app_with_env};

/// A settings store as the turn layer has one.
fn store_of(pairs: &[(&str, Value)]) -> MemorySettings {
    MemorySettings::from_pairs(pairs.iter().map(|(k, v)| (*k, v.clone())))
}

fn million() -> Value {
    json!({ "input_tokens": 1_000_000, "output_tokens": 1_000_000, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 })
}

fn close(a: Option<f64>, b: f64, msg: &str) {
    let a = a.unwrap_or_else(|| panic!("{msg}: expected {b}, got nothing"));
    assert!((a - b).abs() < 1e-9, "{msg} expected {b}, got {a}");
}

fn ms(iso: &str) -> i64 {
    js::ms_from_iso(iso).unwrap()
}

fn price_for(t: &TestApp, id: &str, model: &str, at: &str) -> Price {
    ProviderRegistry::of(t)
        .price_for(id, Some(model), Some(ms(at)), None)
        .unwrap()
}

// --- pricing a turn's tokens ---

#[test]
fn deepseek_the_listed_rate_in_peak_hours_half_of_it_outside_them_minute_exact_at_every_boundary_utc_monday_to_friday()
{
    let t = test_app();
    // 2026-11-09 is a Monday. Peak hours are 01:00-04:00 and 06:00-10:00 UTC.
    let at = |hhmm: &str, day: &str| ms(&format!("{day}T{hhmm}:00Z"));
    let rate = price_for(&t, "deepseek", "deepseek-flash", "2026-11-09T02:00:00Z");
    assert_eq!(rate.peak, Some(true));
    // DeepSeek Flash, a million in and a million out, at the listed (peak) rate
    let peak = rate.input + rate.output;
    let cases = [
        ("00:59", peak / 2.0),
        ("01:00", peak),
        ("03:59", peak),
        ("04:00", peak / 2.0),
        ("05:59", peak / 2.0),
        ("06:00", peak),
        ("09:59", peak),
        ("10:00", peak / 2.0),
        ("23:30", peak / 2.0),
    ];
    let price = |model: &str, at: i64| price_usage(&t, "deepseek", Some(model), &million(), Some(at), None);
    for (hhmm, want) in cases {
        close(price("deepseek-flash", at(hhmm, "2026-11-09")), want, hhmm);
    }
    close(
        price("deepseek-flash", at("02:00", "2026-11-14")),
        peak / 2.0,
        "a Saturday is never peak",
    );
    close(
        price("deepseek-flash[1m]", at("02:00", "2026-11-09")),
        peak,
        "Claude Code's [1m] suffix and a ms timestamp",
    );
}

#[test]
fn every_kind_of_token_at_its_own_rate_input_output_cache_reads_and_cache_writes() {
    let t = test_app();
    let usage = json!({ "input_tokens": 200_000, "output_tokens": 50_000, "cache_read_input_tokens": 4_000_000, "cache_creation_input_tokens": 100_000 });
    // the registry's rates, USD per million
    let r = price_for(&t, "openai", "gpt-6-luna", "2026-11-09T12:00:00Z");
    let want =
        (200_000.0 * r.input + 50_000.0 * r.output + 4_000_000.0 * r.cache_read + 100_000.0 * r.cache_write) / 1e6;
    assert!(want > 0.0);
    let at = Some(ms("2026-11-09T12:00:00Z"));
    close(
        price_usage(&t, "openai", Some("gpt-6-luna"), &usage, at, None),
        want,
        "",
    );
    // The same counts under Tarsee's own names (lib/token-usage.js rows) price the same.
    let rows = json!({ "input": 200_000, "output": 50_000, "cacheRead": 4_000_000, "cacheWrite": 100_000 });
    close(price_usage(&t, "openai", Some("gpt-6-luna"), &rows, at, None), want, "");
}

#[test]
fn plans_are_never_priced_included_in_plan_an_anthropic_keys_exact_cost_comes_from_the_engine_not_a_table() {
    let t = test_app();
    let at = Some(ms("2026-11-09T02:00:00Z"));
    for id in ["claude", "claude-code", "chatgpt"] {
        assert_eq!(price_usage(&t, id, Some("sonnet"), &million(), at, None), None, "{id}");
        assert_eq!(cost_source(&t, id, None), Some(CostSource::Plan), "{id}");
        assert!(!is_metered(&t, id, None), "{id}");
    }
    assert_eq!(
        price_usage(&t, "anthropic", Some("claude-sonnet-4-5"), &million(), None, None),
        None
    );
    assert_eq!(cost_source(&t, "anthropic", None), Some(CostSource::Exact));
    assert!(is_metered(&t, "anthropic", None));
    assert_eq!(
        price_usage(&t, "nobody", Some("x"), &million(), None, None),
        None,
        "an unknown provider"
    );
    assert_eq!(
        price_usage(&t, "deepseek", Some("deepseek-nonexistent"), &million(), None, None),
        None,
        "a model with no known price"
    );
}

#[test]
fn openrouters_own_reported_cost_wins_over_the_catalog_price() {
    let t = test_app();
    let with = |extra: Value| {
        let mut usage = million();
        usage
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        usage
    };
    assert_eq!(
        price_usage(
            &t,
            "openrouter",
            Some("deepseek/deepseek-chat"),
            &with(json!({ "cost": 0.0421 })),
            None,
            None
        ),
        Some(0.0421)
    );
    assert_eq!(
        price_usage(
            &t,
            "deepseek",
            Some("deepseek-flash"),
            &with(json!({ "costUsd": 0.5 })),
            None,
            None
        ),
        Some(0.5)
    );
    assert_eq!(
        price_usage(
            &t,
            "chatgpt",
            Some("gpt-6-luna"),
            &with(json!({ "cost": 3 })),
            None,
            None
        ),
        None,
        "a plan stays unpriced even when a cost is reported"
    );
}

#[test]
fn local_ai_is_free_unless_its_card_sets_a_price() {
    let t = test_app();
    assert_eq!(
        price_usage(&t, "local", Some("llama-local"), &million(), None, None),
        Some(0.0)
    );
    assert_eq!(cost_source(&t, "local", None), Some(CostSource::Free));
    assert!(!is_metered(&t, "local", None));
    let store = store_of(&[("ai.local.price", json!(json!({ "in": 0.1, "out": 0.2 }).to_string()))]);
    close(
        price_usage(&t, "local", Some("llama-local"), &million(), None, Some(&store)),
        0.3,
        "",
    );
    assert_eq!(cost_source(&t, "local", Some(&store)), Some(CostSource::Estimate));
    assert!(is_metered(&t, "local", Some(&store)));
    assert_eq!(cost_source(&t, "deepseek", None), Some(CostSource::Estimate));
    assert_eq!(cost_source(&t, "openrouter", None), Some(CostSource::Estimate));
    // A card that prices only what is read from the cache, or written to it, is priced too.
    for (price, usd) in [
        (json!({ "in": 0, "out": 0, "cacheRead": 0.25 }), 0.25),
        (json!({ "in": 0, "out": 0, "cacheWrite": 0.5 }), 0.5),
    ] {
        let store = store_of(&[("ai.local.price", price.clone())]);
        assert!(is_metered(&t, "local", Some(&store)), "{price}");
        assert_eq!(
            cost_source(&t, "local", Some(&store)),
            Some(CostSource::Estimate),
            "{price}"
        );
        let cached = json!({ "cache_read_input_tokens": 1_000_000, "cache_creation_input_tokens": 1_000_000 });
        assert_eq!(
            price_usage(&t, "local", Some("m"), &cached, None, Some(&store)),
            Some(usd),
            "{price}"
        );
    }
    // One whose prices are all nothing, or that names no input and output price, is free.
    for price in [json!({ "in": 0, "out": 0 }), json!({ "cacheRead": 0.25 })] {
        let store = store_of(&[("ai.local.price", price.clone())]);
        assert!(!is_metered(&t, "local", Some(&store)), "{price}");
        assert_eq!(
            cost_source(&t, "local", Some(&store)),
            Some(CostSource::Free),
            "{price}"
        );
    }
}

// --- the per-turn ceiling (design 4.6h) ---

/// DeepSeek Flash at peak, sized from the registry's rates: that many dollars of tokens.
fn pair(t: &TestApp, usd: f64) -> Value {
    let flash = price_for(t, "deepseek", "deepseek-flash", "2026-11-09T02:00:00Z");
    let n = ((usd * 1e6) / (flash.input + flash.output)).round();
    json!({ "input_tokens": n, "output_tokens": n })
}

const PEAK: &str = "2026-11-09T02:00:00Z";

fn deepseek<'a>(usage: &'a Value) -> TurnBudgetOpts<'a> {
    TurnBudgetOpts {
        provider_id: Some("deepseek"),
        model: Some("deepseek-flash"),
        usage: Some(usage),
        at: Some(ms(PEAK)),
        ..TurnBudgetOpts::default()
    }
}

#[test]
fn keeps_todays_0_50_background_ceiling_on_every_metered_provider() {
    let t = test_app();
    let (heavy, heavier) = (pair(&t, 0.45), pair(&t, 0.6));
    assert_eq!(BACKGROUND_BUDGET_USD, background_defaults::MAX_BUDGET_USD);
    assert_eq!(BACKGROUND_BUDGET_USD, 0.5);
    let under = check_turn_budget(
        &t,
        &TurnBudgetOpts {
            background: true,
            ..deepseek(&heavy)
        },
    );
    assert!(!under.tripped);
    assert_eq!(under.limit_usd, Some(0.5));
    assert!((under.spent_usd.unwrap() - 0.45).abs() < 1e-6, "{:?}", under.spent_usd);
    let over = check_turn_budget(
        &t,
        &TurnBudgetOpts {
            background: true,
            ..deepseek(&heavier)
        },
    );
    assert!(over.tripped);
    assert!(over.over, "the name the turn layer reads");
    assert!(!under.over);
    assert_eq!(over.subtype, Some("error_max_budget_usd"));
    assert!(over.estimated);
    let message = over.message.as_deref().unwrap();
    assert!(message.contains("$0.50") && message.contains("$0.60"), "{message}");
    assert_eq!(
        message,
        "Stopped after reaching this task's spending limit of $0.50 (about $0.60 so far, estimated)."
    );
}

#[test]
fn an_explicit_ceiling_wins_an_interactive_turn_with_none_never_trips() {
    let t = test_app();
    let (heavy, heavier) = (pair(&t, 0.45), pair(&t, 0.6));
    let own = check_turn_budget(
        &t,
        &TurnBudgetOpts {
            max_budget_usd: Some(0.25),
            ..deepseek(&heavy)
        },
    );
    assert!(own.tripped);
    let free = check_turn_budget(&t, &deepseek(&heavier));
    assert!(!free.tripped);
    assert_eq!(free.limit_usd, None);
}

#[test]
fn a_reported_cost_openrouters_usage_cost_or_the_turns_own_sum_counts_as_it_is() {
    let t = test_app();
    let r = check_turn_budget(
        &t,
        &TurnBudgetOpts {
            provider_id: Some("openrouter"),
            model: Some("deepseek/deepseek-chat"),
            cost_usd: Some(0.61),
            background: true,
            ..TurnBudgetOpts::default()
        },
    );
    assert!(r.tripped);
    assert!(!r.estimated);
    let running = check_turn_budget(
        &t,
        &TurnBudgetOpts {
            provider_id: Some("openai"),
            model: Some("gpt-6-luna"),
            spent_usd: Some(0.2),
            background: true,
            ..TurnBudgetOpts::default()
        },
    );
    assert!(!running.tripped);
}

#[test]
fn plans_never_trip_it_and_the_anthropic_keys_ceiling_is_enforced_by_the_engine_itself() {
    let t = test_app();
    let heavier = pair(&t, 0.6);
    let plan = check_turn_budget(
        &t,
        &TurnBudgetOpts {
            provider_id: Some("claude"),
            model: Some("sonnet"),
            cost_usd: Some(9.0),
            background: true,
            ..TurnBudgetOpts::default()
        },
    );
    assert!(!plan.metered);
    assert!(!plan.tripped);
    let chatgpt = check_turn_budget(
        &t,
        &TurnBudgetOpts {
            provider_id: Some("chatgpt"),
            model: Some("x"),
            usage: Some(&heavier),
            background: true,
            ..TurnBudgetOpts::default()
        },
    );
    assert!(!chatgpt.tripped);
    let key = check_turn_budget(
        &t,
        &TurnBudgetOpts {
            provider_id: Some("anthropic"),
            model: Some("sonnet"),
            cost_usd: Some(2.0),
            background: true,
            ..TurnBudgetOpts::default()
        },
    );
    assert!(!key.tripped);
    assert_eq!(key.enforced_by, Some(EnforcedBy::Engine));
}

// --- this month's spend and the optional monthly cap ---

/// `Date.parse("2026-11-09T12:00:00Z")`.
const NOW: &str = "2026-11-09T12:00:00Z";
/// UTC+8: November begins at 2026-10-31T16:00Z
const TZ: &str = "Asia/Manila";

fn turn(
    t: &TestApp,
    id: &str,
    started: &str,
    ended: &str,
    provider: Option<&str>,
    engine: Option<&str>,
    cost: Option<f64>,
) {
    t.db()
        .with(|c| {
            c.execute(
                "INSERT INTO usage_turns (turn_id, conversation_id, started_at, ended_at, provider, engine, cost_usd)
                 VALUES (?, 'c1', ?, ?, ?, ?, ?)",
                rusqlite::params![id, ms(started), ms(ended), provider, engine, cost],
            )
        })
        .unwrap();
}

fn call(t: &TestApp, id: &str, ended: &str, turn_id: Option<&str>, provider: &str, cost: f64) {
    t.db()
        .with(|c| {
            c.execute(
                "INSERT INTO usage_calls (id, session_id, model, started_at, ended_at, output, turn_id, placed, provider, engine, cost_usd)
                 VALUES (?, 's', 'm', NULL, ?, 1, ?, 1, ?, 'claude-code', ?)",
                rusqlite::params![id, ms(ended), turn_id, provider, cost],
            )
        })
        .unwrap();
}

/// The JS suite's month of usage.
fn spent() -> TestApp {
    let t = test_app();
    turn(
        &t,
        "A",
        "2026-11-02T00:00:00Z",
        "2026-11-02T00:05:00Z",
        Some("deepseek"),
        Some("claude-code"),
        Some(0.4),
    );
    // in turn A: not counted again
    call(&t, "A-call", "2026-11-02T00:04:00Z", Some("A"), "deepseek", 0.4);
    // Nov 1, 01:00 in Manila
    turn(
        &t,
        "B",
        "2026-10-31T16:55:00Z",
        "2026-10-31T17:00:00Z",
        Some("openai"),
        Some("codex"),
        Some(0.25),
    );
    // still October in Manila
    turn(
        &t,
        "C",
        "2026-10-31T14:00:00Z",
        "2026-10-31T15:00:00Z",
        Some("deepseek"),
        Some("claude-code"),
        Some(5.0),
    );
    // the Claude plan (an old row)
    turn(
        &t,
        "D",
        "2026-11-03T00:00:00Z",
        "2026-11-03T00:01:00Z",
        None,
        None,
        None,
    );
    // in no turn: counted itself
    call(&t, "orphan", "2026-11-03T00:00:00Z", None, "openrouter", 0.1);
    t
}

fn month<'a>(time_zone: &'a str) -> MonthlyOpts<'a> {
    MonthlyOpts {
        now: Some(ms(NOW)),
        time_zone: Some(time_zone),
        provider: None,
    }
}

#[test]
fn adds_up_the_calendar_month_in_the_owners_timezone_each_turn_once_and_calls_in_no_turn_once() {
    let t = spent();
    assert_eq!(month_start(ms(NOW), TZ), ms("2026-10-31T16:00:00Z"));
    let m = monthly_spend(&t, Some(t.db()), &month(TZ));
    close(Some(m.total_usd), 0.75, "");
    close(m.by_provider.get("deepseek"), 0.4, "");
    close(m.by_provider.get("openai"), 0.25, "");
    close(m.by_provider.get("openrouter"), 0.1, "");
    assert_eq!(m.by_provider.get("claude"), None, "the plan costs nothing here");
    close(
        Some(monthly_spend(&t, Some(t.db()), &month("UTC")).total_usd),
        0.75 - 0.25,
        "in UTC turn B was still October",
    );
    assert_eq!(
        (m.from, m.to, m.time_zone.as_str()),
        (ms("2026-10-31T16:00:00Z"), ms(NOW), TZ)
    );
}

#[test]
fn is_off_when_empty_and_once_reached_it_refuses_metered_turns_only() {
    let t = spent();
    let cap = |store: &MemorySettings, id: &str| {
        monthly_cap_status(
            &t,
            id,
            &CapOpts {
                store: Some(store),
                db: Some(t.db()),
                now: Some(ms(NOW)),
                time_zone: Some(TZ),
            },
        )
    };
    let within = |store: &MemorySettings, id: &str| cap(store, id).ok;
    assert!(
        within(&store_of(&[("ai.spendCap.monthlyUsd", json!(""))]), "deepseek"),
        "off by default"
    );
    assert!(within(&store_of(&[]), "deepseek"));
    let capped = store_of(&[("ai.spendCap.monthlyUsd", json!("0.70"))]);
    for id in ["deepseek", "anthropic", "openai", "openrouter"] {
        assert!(!within(&capped, id), "{id} is metered");
    }
    for id in ["claude", "claude-code", "chatgpt", "local"] {
        assert!(within(&capped, id), "{id} is not billed per use");
    }
    assert!(within(
        &store_of(&[("ai.spendCap.monthlyUsd", json!("$5"))]),
        "deepseek"
    ));
    let s = cap(&capped, "deepseek");
    assert!(!s.ok);
    assert_eq!(s.subtype, Some("spend-cap"));
    assert_eq!(s.cap_usd, Some(0.7));
    close(s.spent_usd, 0.75, "");
    assert_eq!(s.remaining_usd, Some(0.0));
    let message = s.message.as_deref().unwrap();
    assert!(message.contains("$0.70") && message.contains("Settings > AI"));
    assert_eq!(
        message,
        "This month's AI spending has reached the $0.70 limit set in Settings > AI (about $0.75 so far). Raise or clear the limit there, or switch this chat to a plan, which isn't billed per use."
    );
    assert!(cap(&capped, "claude").ok);
    // The public one-word answer is the same.
    let opts = CapOpts {
        store: Some(&capped),
        db: Some(t.db()),
        now: Some(ms(NOW)),
        time_zone: Some(TZ),
    };
    assert!(!within_monthly_cap(&t, "deepseek", &opts));
    assert!(within_monthly_cap(&t, "chatgpt", &opts));
}

// --- What the JS suite left out ---

#[test]
fn money_is_written_as_the_en_us_locale_writes_it() {
    // Node: v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) behind a "$".
    for (usd, want) in [
        (0.0, "$0.00"),
        (-0.0, "$0.00"),
        (f64::NAN, "$0.00"),
        (0.004, "under $0.01"),
        (0.0049999, "under $0.01"),
        (0.005, "$0.01"),
        (0.01, "$0.01"),
        (0.5, "$0.50"),
        (0.6, "$0.60"),
        (0.125, "$0.13"),
        (0.135, "$0.14"),
        (1.005, "$1.01"),
        (1.004999, "$1.00"),
        (2.675, "$2.68"),
        (0.995, "$1.00"),
        (9.999, "$10.00"),
        (999.995, "$1,000.00"),
        (1234.0, "$1,234.00"),
        (1234.5, "$1,234.50"),
        (1_234_567.891, "$1,234,567.89"),
        (123_456.0, "$123,456.00"),
        (1e21, "$1,000,000,000,000,000,000,000.00"),
        (-1.0, "$-1.00"),
        (-1234.567, "$-1,234.57"),
        (-0.001, "$-0.00"),
        (f64::INFINITY, "$∞"),
        (f64::NEG_INFINITY, "$-∞"),
        (-5e-324, "$-0.00"),
        (1e23, "$100,000,000,000,000,000,000,000.00"),
        (9_007_199_254_740_993.0, "$9,007,199,254,740,992.00"),
        // A number written with the fewest digits that read back as it: of two as near, JavaScript takes the even one
        // (Rust the other, so these three are sums: written out, clippy would call their last digits too many).
        (150_000_000_000_000.0 + 0.125, "$150,000,000,000,000.12"),
        (200_000_000_000_000.0 + 0.375, "$200,000,000,000,000.38"),
        (1_000_000_000_000_000.0 + 0.25, "$1,000,000,000,000,000.20"),
        // Just above a power of two the nearest number of sixteen digits reads back as a neighbour; the next one up
        // is the one JavaScript writes (2 to the 89th is 618970019642690137449562112).
        (2f64.powi(89), "$618,970,019,642,690,200,000,000,000.00"),
    ] {
        assert_eq!(money(usd), want, "{usd}");
    }
}

#[test]
fn the_cap_is_read_from_a_number_or_from_text_with_its_dollar_sign() {
    let cap = |value: Value| spend_cap_usd(Some(&store_of(&[(SPEND_CAP_KEY, value)])));
    assert_eq!(SPEND_CAP_KEY, "ai.spendCap.monthlyUsd");
    assert_eq!(spend_cap_usd(None), None);
    assert_eq!(spend_cap_usd(Some(&store_of(&[]))), None);
    for (value, want) in [
        (json!(20), Some(20.0)),
        (json!(0.5), Some(0.5)),
        (json!("20"), Some(20.0)),
        (json!("$20"), Some(20.0)),
        (json!(" $ 1,250.50 "), Some(1250.5)),
        // Any white space goes, wherever it stands, not the space alone.
        (json!("2\u{3000}0"), Some(20.0)),
        (json!("1\t000"), Some(1000.0)),
        (json!("\u{feff}$\u{a0}20\n"), Some(20.0)),
        (json!("USD 20"), Some(20.0)),
        (json!("usd20"), Some(20.0)),
        (json!("20 USD"), None),
        (json!("1e2"), Some(100.0)),
        (json!("0x10"), Some(16.0)),
        (json!(0), None),
        (json!(-5), None),
        (json!("0"), None),
        (json!("-5"), None),
        (json!(""), None),
        (json!("  "), None),
        (json!("$"), None),
        (json!("twenty"), None),
        (json!("Infinity"), None),
        (json!(true), None),
        (json!(null), None),
        (json!(["20"]), None),
        (json!({ "usd": 20 }), None),
    ] {
        assert_eq!(cap(value.clone()), want, "{value}");
    }
}

#[test]
fn the_token_counts_are_read_in_either_vocabulary_and_only_what_is_a_count() {
    let t = |usage: Value| serde_json::to_value(tokens_of(&usage)).unwrap();
    let none = json!({ "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 });
    assert_eq!(t(json!(null)), none);
    assert_eq!(t(json!("usage")), none);
    assert_eq!(t(json!({})), none);
    assert_eq!(
        t(
            json!({ "input_tokens": 5, "output_tokens": 6, "cache_read_input_tokens": 7, "cache_creation_input_tokens": 8 })
        ),
        json!({ "input": 5, "output": 6, "cacheRead": 7, "cacheWrite": 8 })
    );
    assert_eq!(
        t(json!({ "input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4 })),
        json!({ "input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4 })
    );
    assert_eq!(
        t(json!({ "cache_read": 3, "cache_write": 4 })),
        json!({ "input": 0, "output": 0, "cacheRead": 3, "cacheWrite": 4 })
    );
    // The engines' name first; one that is zero, negative or no number falls through to Tarsee's own.
    assert_eq!(
        t(
            json!({ "input_tokens": 0, "input": 9, "output_tokens": -1, "output": "12", "cache_read_input_tokens": "x", "cacheRead": 1.5, "cacheWrite": true })
        ),
        json!({ "input": 9, "output": 12, "cacheRead": 1.5, "cacheWrite": 1 })
    );
    assert_eq!(
        t(
            json!({ "input_tokens": 5, "input": 9, "output_tokens": 6, "output": 1, "cache_read_input_tokens": 7, "cacheRead": 2, "cache_read": 3 })
        ),
        json!({ "input": 5, "output": 6, "cacheRead": 7, "cacheWrite": 0 })
    );
    assert_eq!(
        serde_json::to_string(&tokens_of(&json!({ "input": 2 }))).unwrap(),
        r#"{"input":2,"output":0,"cacheRead":0,"cacheWrite":0}"#
    );
}

#[test]
fn a_priced_usage_says_where_its_figure_came_from() {
    let t = test_app();
    let at = Some(ms(PEAK));
    let detail = |id: &str, model: Option<&str>, usage: Value| {
        price_usage_detail(&t, id, model, &usage, at, None).map(|d| serde_json::to_value(d).unwrap())
    };
    let flash = price_for(&t, "deepseek", "deepseek-flash", PEAK);
    assert_eq!(
        detail("deepseek", Some("deepseek-flash"), million()),
        Some(json!({ "usd": flash.input + flash.output, "source": "price-table", "estimated": true, "peak": true }))
    );
    assert_eq!(
        detail("openai", Some("gpt-6-luna"), json!({})),
        Some(json!({ "usd": 0, "source": "price-table", "estimated": true, "peak": null }))
    );
    // A reported cost: a number, or text of one; the first of cost, costUsd, cost_usd that is one; never negative.
    for (usage, usd) in [
        (json!({ "cost": 0.0421 }), json!(0.0421)),
        (json!({ "cost": "0.5" }), json!(0.5)),
        (json!({ "cost": 0 }), json!(0)),
        (json!({ "cost": -1, "costUsd": 2 }), json!(2)),
        (json!({ "cost": "  ", "cost_usd": 3 }), json!(3)),
        (json!({ "cost": null, "costUsd": "x", "cost_usd": "4" }), json!(4)),
        (json!({ "cost": 1, "costUsd": 2, "cost_usd": 3 }), json!(1)),
        (json!({ "costUsd": 2, "cost_usd": 3 }), json!(2)),
    ] {
        assert_eq!(
            detail("openrouter", Some("deepseek/deepseek-chat"), usage.clone()),
            Some(json!({ "usd": usd, "source": "reported", "estimated": false, "peak": null })),
            "{usage}"
        );
    }
    // No model at all: no price on a provider whose prices are per model; Local AI has one price.
    assert_eq!(detail("deepseek", None, million()), None);
    assert!(detail("local", None, million()).is_some());
    // A figure is rounded to a billionth of a dollar.
    let usage = json!({ "input_tokens": 1, "output_tokens": 1 });
    let usd = price_usage(&t, "openai", Some("gpt-6-luna"), &usage, at, None).unwrap();
    assert_eq!(usd, 0.000_000_6);
}

#[test]
fn an_anthropic_keys_unfinished_turn_is_priced_at_the_list_price_once_the_catalog_has_it() {
    let t = test_app();
    let usage = json!({ "input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_input_tokens": 2_000_000, "cache_creation_input_tokens": 10_000 });
    assert_eq!(
        anthropic_list_cost(&t, Some("claude-sonnet-4-5"), &usage),
        None,
        "the catalog isn't in yet"
    );
    ProviderRegistry::of(&t)
        .set_catalog_models(
            "openrouter",
            &[json!({ "id": "anthropic/claude-sonnet-4.5", "price": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheWrite": 3.75 } })],
        )
        .unwrap();
    close(
        anthropic_list_cost(&t, Some("claude-sonnet-4-5"), &usage),
        3.0 + 1.5 + 0.6 + 0.0375,
        "",
    );
    close(
        anthropic_list_cost(&t, Some("sonnet"), &usage),
        5.1375,
        "a tier word takes its family's newest",
    );
    assert_eq!(anthropic_list_cost(&t, Some("gpt-6-luna"), &usage), None);
    assert_eq!(anthropic_list_cost(&t, None, &usage), None);
}

#[test]
fn the_ceiling_says_who_keeps_it_what_was_spent_and_whether_that_is_an_estimate() {
    let t = test_app();
    let budget = |opts: TurnBudgetOpts<'_>| serde_json::to_value(check_turn_budget(&t, &opts)).unwrap();
    // No provider, an unknown one, a plan: nothing is metered and nothing else is said.
    let unmetered = json!({ "metered": false, "enforcedBy": null, "limitUsd": null, "spentUsd": null, "estimated": false, "tripped": false, "over": false, "subtype": null, "message": null });
    for id in [None, Some("nobody"), Some("claude-code"), Some("local")] {
        let opts = TurnBudgetOpts {
            provider_id: id,
            cost_usd: Some(9.0),
            background: true,
            ..TurnBudgetOpts::default()
        };
        assert_eq!(budget(opts), unmetered, "{id:?}");
    }
    // A running sum is an estimate on a provider priced from a table, exact on the Anthropic key, unless the caller
    // says otherwise.
    let running = |id: &'static str, estimated: Option<bool>| TurnBudgetOpts {
        provider_id: Some(id),
        model: Some("m"),
        spent_usd: Some(0.2),
        estimated,
        max_budget_usd: Some(1.0),
        ..TurnBudgetOpts::default()
    };
    assert_eq!(
        budget(running("openai", None)),
        json!({ "metered": true, "enforcedBy": "tarsee", "limitUsd": 1, "spentUsd": 0.2, "estimated": true, "tripped": false, "over": false, "subtype": null, "message": null })
    );
    assert_eq!(budget(running("openai", Some(false)))["estimated"], json!(false));
    let key = budget(running("anthropic", None));
    assert_eq!(
        (key["estimated"].clone(), key["enforcedBy"].clone()),
        (json!(false), json!("engine"))
    );
    // The caller's own word on who keeps the ceiling wins over the registry's.
    let no_native = TurnBudgetOpts {
        caps: Some(Caps::default()),
        spent_usd: Some(2.0),
        ..running("anthropic", None)
    };
    let tripped = budget(no_native);
    assert_eq!(tripped["enforcedBy"], json!("tarsee"));
    assert_eq!(
        tripped["message"],
        json!("Stopped after reaching this task's spending limit of $1.00 (about $2.00 so far).")
    );
    // A reported cost comes before a running sum, and both before the usage; one that is no amount is passed over.
    let both = TurnBudgetOpts {
        cost_usd: Some(0.3),
        ..running("openai", None)
    };
    assert_eq!(budget(both)["spentUsd"], json!(0.3));
    let bad = TurnBudgetOpts {
        cost_usd: Some(-1.0),
        spent_usd: Some(f64::NAN),
        usage: Some(&json!({ "cost": 0.4 })),
        ..running("openai", None)
    };
    let from_usage = budget(bad);
    assert_eq!(
        (from_usage["spentUsd"].clone(), from_usage["estimated"].clone()),
        (json!(0.4), json!(false))
    );
    // Nothing is an amount: a reported cost of 0 is not passed over for the running sum, nor a running sum of 0 for
    // the usage.
    let free = TurnBudgetOpts {
        cost_usd: Some(0.0),
        ..running("openai", None)
    };
    assert_eq!(budget(free)["spentUsd"], json!(0));
    let nothing_yet = TurnBudgetOpts {
        spent_usd: Some(0.0),
        usage: Some(&json!({ "cost": 0.4 })),
        ..running("openai", None)
    };
    assert_eq!(budget(nothing_yet)["spentUsd"], json!(0));
    // A ceiling that is no amount is no ceiling of the caller's: the background one, or none.
    for own in [Some(0.0), Some(-1.0), Some(f64::NAN), None] {
        let opts = TurnBudgetOpts {
            max_budget_usd: own,
            ..running("openai", None)
        };
        assert_eq!(budget(opts)["limitUsd"], json!(null), "{own:?}");
        let background = TurnBudgetOpts {
            max_budget_usd: own,
            background: true,
            ..running("openai", None)
        };
        assert_eq!(budget(background)["limitUsd"], json!(0.5), "{own:?}");
    }
    // Exactly at the ceiling is not over it; a hair above is.
    let at = |spent: f64| {
        check_turn_budget(
            &t,
            &TurnBudgetOpts {
                spent_usd: Some(spent),
                ..running("openai", None)
            },
        )
        .tripped
    };
    assert!(!at(1.0) && !at(1.0 + 1e-13) && at(1.0 + 1e-9));
}

#[test]
fn the_spend_of_a_span_counts_turns_at_their_end_calls_in_no_turn_and_says_when_any_of_it_is_an_estimate() {
    let t = spent();
    let all = spend_between(Some(t.db()), 0, FOREVER, None);
    assert_eq!(
        serde_json::to_value(&all).unwrap(),
        json!({ "totalUsd": 5.75, "byProvider": { "deepseek": 5.4, "openai": 0.25, "openrouter": 0.1 }, "estimated": true })
    );
    assert_eq!(
        all.by_provider.ids().collect::<Vec<_>>(),
        ["deepseek", "openai", "openrouter"]
    );
    // One provider only; a name that is no provider narrows nothing, as in the JS.
    let only = spend_between(Some(t.db()), 0, FOREVER, Some("DeepSeek"));
    assert_eq!(
        serde_json::to_value(&only).unwrap(),
        json!({ "totalUsd": 5.4, "byProvider": { "deepseek": 5.4 }, "estimated": true })
    );
    assert_eq!(spend_between(Some(t.db()), 0, FOREVER, Some("nobody")), all);
    assert_eq!(spend_between(Some(t.db()), 0, FOREVER, Some("")), all);
    // The span takes its start and leaves its end out: turn A ended at 00:05.
    let end_of_a = ms("2026-11-02T00:05:00Z");
    assert_eq!(spend_between(Some(t.db()), end_of_a, end_of_a + 1, None).total_usd, 0.4);
    assert_eq!(
        spend_between(Some(t.db()), end_of_a - 10, end_of_a, None).total_usd,
        0.0
    );
    // A turn still running is placed by its last call, else its start.
    t.db()
        .with(|c| {
            c.execute(
                "INSERT INTO usage_turns (turn_id, conversation_id, started_at, last_call_at, provider, cost_usd, cost_exact)
                 VALUES ('running', 'c1', 100, 200, 'anthropic', 1.5, 1), ('started', 'c1', 300, NULL, 'anthropic', 2.5, 1)",
                [],
            )
        })
        .unwrap();
    let early = spend_between(Some(t.db()), 0, 1000, None);
    assert_eq!(
        serde_json::to_value(&early).unwrap(),
        json!({ "totalUsd": 4, "byProvider": { "anthropic": 4 }, "estimated": false }),
        "the engine's own figures are no estimate"
    );
    assert_eq!(spend_between(Some(t.db()), 150, 250, None).total_usd, 1.5);
    assert_eq!(spend_between(Some(t.db()), 250, 350, None).total_usd, 2.5);
    // No database: nothing spent.
    assert_eq!(spend_between(None, 0, FOREVER, None), Spend::default());
    assert_eq!(
        serde_json::to_string(&Spend::default()).unwrap(),
        r#"{"totalUsd":0,"byProvider":{},"estimated":false}"#
    );
}

#[test]
fn rows_recorded_under_another_spelling_of_a_provider_add_to_it_and_a_plans_rows_never_count() {
    let t = test_app();
    let (from, to) = ("2026-11-02T00:00:00Z", "2026-11-02T00:05:00Z");
    turn(&t, "a", from, to, Some("deepseek"), Some("claude-code"), Some(0.1));
    turn(&t, "b", from, to, Some("DeepSeek"), Some("claude-code"), Some(0.2));
    call(&t, "c", to, None, "DEEPSEEK", 0.3);
    // A plan's rows, under each of its names and under none, even with a figure on them.
    turn(&t, "d", from, to, Some("claude"), Some("claude-code"), Some(9.0));
    turn(&t, "e", from, to, Some("claude-code"), Some("claude-code"), Some(9.0));
    turn(&t, "f", from, to, Some("chatgpt"), Some("codex"), Some(9.0));
    turn(&t, "g", from, to, None, None, Some(9.0));
    call(&t, "h", to, None, "chatgpt", 9.0);
    assert_eq!(
        serde_json::to_value(spend_between(Some(t.db()), 0, FOREVER, None)).unwrap(),
        json!({ "totalUsd": 0.6, "byProvider": { "deepseek": 0.6 }, "estimated": true })
    );
}

#[test]
fn a_usage_table_from_before_cost_exact_counts_every_figure_as_an_estimate_and_no_tables_is_nothing() {
    let old = Db::from_connection(rusqlite::Connection::open_in_memory().unwrap());
    assert_eq!(
        spend_between(Some(&old), 0, FOREVER, None),
        Spend::default(),
        "no usage tables yet"
    );
    old.with(|c| {
        c.execute_batch(
            "CREATE TABLE usage_turns (turn_id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER, last_call_at INTEGER, provider TEXT, cost_usd REAL);
             CREATE TABLE usage_calls (id TEXT PRIMARY KEY, ended_at INTEGER, turn_id TEXT, provider TEXT, cost_usd REAL);
             INSERT INTO usage_turns VALUES ('t', 1, 2, NULL, 'anthropic', 1.25);",
        )
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(spend_between(Some(&old), 0, FOREVER, None)).unwrap(),
        json!({ "totalUsd": 1.25, "byProvider": { "anthropic": 1.25 }, "estimated": true })
    );
    old.close();
    assert_eq!(
        spend_between(Some(&old), 0, FOREVER, None),
        Spend::default(),
        "a closed database"
    );
}

#[test]
fn an_engines_own_cost_is_filed_for_a_turn_nothing_else_records() {
    let t = test_app();
    let row = ReportedCost {
        turn_id: " turn-1 ",
        conversation_id: "conv-1",
        source: Some("subagent"),
        provider: "Anthropic",
        engine: Some("claude-code"),
        model: Some(" claude-sonnet-4-5 "),
        effort: Some("  "),
        started_at: Some(1000.4),
        ended_at: Some(2000.5),
        stop_reason: None,
        cost_usd: 0.123_456_789_123,
        exact: None,
    };
    let filed = record_reported_cost(&row, Some(t.db()));
    assert_eq!(serde_json::to_string(&filed).unwrap(), r#"{"recorded":true}"#);
    let stored = |turn: &str| {
        t.db()
            .with(|c| {
                crate::db::get(
                    c,
                    "SELECT turn_id, conversation_id, source, model, effort, started_at, ended_at, stop_reason, provider, engine, cost_usd, cost_exact FROM usage_turns WHERE turn_id = ?",
                    [turn],
                )
            })
            .unwrap()
            .map(Value::Object)
    };
    assert_eq!(
        stored("turn-1"),
        Some(json!({
            "turn_id": "turn-1", "conversation_id": "conv-1", "source": "subagent", "model": "claude-sonnet-4-5", "effort": null,
            "started_at": 1000, "ended_at": 2001, "stop_reason": null, "provider": "anthropic", "engine": "claude-code",
            "cost_usd": 0.123_456_789, "cost_exact": 1,
        }))
    );
    assert_eq!(spend_between(Some(t.db()), 0, FOREVER, None).total_usd, 0.123_456_789);
    assert!(!spend_between(Some(t.db()), 0, FOREVER, None).estimated);
    // Recording the same turn again replaces its figure and its end; a stop reason once known stays.
    let again = ReportedCost {
        cost_usd: 0.5,
        ended_at: Some(3000.0),
        stop_reason: Some("stopped"),
        exact: Some(false),
        ..row
    };
    assert!(record_reported_cost(&again, Some(t.db())).recorded);
    let later = ReportedCost {
        stop_reason: None,
        ..again
    };
    assert!(record_reported_cost(&later, Some(t.db())).recorded);
    let now = stored("turn-1").unwrap();
    assert_eq!(
        (
            now["cost_usd"].clone(),
            now["cost_exact"].clone(),
            now["ended_at"].clone(),
            now["stop_reason"].clone(),
            now["started_at"].clone()
        ),
        (json!(0.5), json!(0), json!(3000), json!("stopped"), json!(1000))
    );
    assert!(
        spend_between(Some(t.db()), 0, FOREVER, None).estimated,
        "the list price is an estimate"
    );
    // What is not filed, and why.
    let refused = |row: ReportedCost<'_>, db: Option<&Db>| record_reported_cost(&row, db).reason;
    assert_eq!(refused(row, None), Some("no-db"));
    for provider in ["claude", "claude-code", "chatgpt", "nobody", ""] {
        assert_eq!(
            refused(ReportedCost { provider, ..row }, Some(t.db())),
            Some("provider"),
            "{provider}"
        );
    }
    assert_eq!(
        refused(ReportedCost { turn_id: "  ", ..row }, Some(t.db())),
        Some("turn")
    );
    assert_eq!(
        refused(
            ReportedCost {
                conversation_id: "",
                ..row
            },
            Some(t.db())
        ),
        Some("turn")
    );
    for cost_usd in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(
            refused(ReportedCost { cost_usd, ..row }, Some(t.db())),
            Some("cost"),
            "{cost_usd}"
        );
    }
    assert_eq!(
        serde_json::to_string(&record_reported_cost(
            &ReportedCost { cost_usd: 0.0, ..row },
            Some(t.db())
        ))
        .unwrap(),
        r#"{"recorded":false,"reason":"cost"}"#
    );
    // No end given: now; no start: the end.
    let before = js::now_ms();
    let open = ReportedCost {
        turn_id: "turn-2",
        started_at: None,
        ended_at: Some(-5.0),
        ..row
    };
    assert!(record_reported_cost(&open, Some(t.db())).recorded);
    let two = stored("turn-2").unwrap();
    assert!(two["ended_at"].as_i64().unwrap() >= before);
    assert_eq!(two["started_at"], two["ended_at"]);
    // A database that can't take the row: said in the log, never an error.
    let logs = crate::testkit::CapturedLogs::start();
    let bare = Db::from_connection(rusqlite::Connection::open_in_memory().unwrap());
    assert_eq!(refused(row, Some(&bare)), Some("error"));
    // A table from before its newer columns: SQLite's own words, without the statement around them.
    let old = Db::from_connection(rusqlite::Connection::open_in_memory().unwrap());
    old.with(|c| c.execute_batch("CREATE TABLE usage_turns (turn_id TEXT PRIMARY KEY, conversation_id TEXT)"))
        .unwrap();
    assert_eq!(refused(row, Some(&old)), Some("error"));
    assert_eq!(
        logs.warnings().last().map(String::as_str),
        Some("[spend] a turn's cost couldn't be recorded: table usage_turns has no column named source")
    );
    // One that was closed: the same, in the words the JS database had for it.
    bare.close();
    assert_eq!(refused(row, Some(&bare)), Some("error"));
    assert_eq!(
        refused(ReportedCost { cost_usd: 0.0, ..row }, Some(&bare)),
        Some("cost"),
        "what is wrong with the row is said first"
    );
    assert_eq!(
        logs.warnings(),
        [
            "[spend] a turn's cost couldn't be recorded: no such table: usage_turns",
            "[spend] a turn's cost couldn't be recorded: table usage_turns has no column named source",
            "[spend] a turn's cost couldn't be recorded: The database connection is not open",
        ]
    );
}

#[test]
fn a_database_failure_is_logged_in_sqlites_own_words_without_the_statement() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // A statement SQLite can point into: the error then carries the statement too, which the log line leaves out.
    let err = conn.execute("SELEC 1", []).unwrap_err();
    assert!(err.to_string().contains("SELEC 1"), "{err}");
    assert_eq!(sqlite_message(&err), "near \"SELEC\": syntax error");
    let err = conn.execute("INSERT INTO nowhere VALUES (1)", []).unwrap_err();
    assert_eq!(sqlite_message(&err), "no such table: nowhere");
    // An error that is not SQLite's is written as it is.
    let err = rusqlite::Error::InvalidParameterName("x".to_string());
    assert_eq!(sqlite_message(&err), err.to_string());
}

#[test]
fn the_month_is_the_owners_calendar_month_across_month_ends_and_clock_changes() {
    let t = test_app();
    // One dollar of spend at each of these moments.
    let moments = [
        "2026-02-28T23:59:59.999Z",
        "2026-03-01T00:00:00.000Z",
        // Berlin: March began at 23:00Z on Feb 28 (UTC+1); the clocks go forward on March 29.
        "2026-02-28T22:59:59.999Z",
        "2026-02-28T23:00:00.000Z",
        "2026-03-31T21:59:59.999Z",
        "2026-03-31T22:00:00.000Z",
        // New York: November begins at 04:00Z on Nov 1 (UTC-4), the day the clocks go back.
        "2026-11-01T03:59:59.999Z",
        "2026-11-01T04:00:00.000Z",
        "2026-12-01T04:59:59.999Z",
        "2026-12-01T05:00:00.000Z",
    ];
    for (i, at) in moments.iter().enumerate() {
        t.db()
            .with(|c| {
                c.execute(
                    "INSERT INTO usage_calls (id, session_id, ended_at, provider, cost_usd) VALUES (?, 's', ?, 'openai', 1)",
                    rusqlite::params![format!("c{i}"), ms(at)],
                )
            })
            .unwrap();
    }
    let month = |now: &str, zone: &'static str| {
        let m = monthly_spend(
            &t,
            Some(t.db()),
            &MonthlyOpts {
                now: Some(ms(now)),
                time_zone: Some(zone),
                provider: None,
            },
        );
        (js::iso_from_ms(m.from), m.total_usd)
    };
    // UTC, on the last instant of February and the first of March.
    assert_eq!(
        month("2026-02-28T23:59:59.999Z", "UTC"),
        ("2026-02-01T00:00:00.000Z".to_string(), 3.0)
    );
    assert_eq!(
        month("2026-03-01T00:00:00.000Z", "UTC"),
        ("2026-03-01T00:00:00.000Z".to_string(), 1.0)
    );
    // Berlin: the same instants are already March there; its April begins at 22:00Z (UTC+2 after the change).
    assert_eq!(
        month("2026-02-28T22:59:59.999Z", "Europe/Berlin"),
        ("2026-01-31T23:00:00.000Z".to_string(), 1.0)
    );
    assert_eq!(
        month("2026-02-28T23:00:00.000Z", "Europe/Berlin"),
        ("2026-02-28T23:00:00.000Z".to_string(), 1.0)
    );
    assert_eq!(
        month("2026-03-31T21:59:59.999Z", "Europe/Berlin"),
        ("2026-02-28T23:00:00.000Z".to_string(), 4.0)
    );
    assert_eq!(
        month("2026-03-31T22:00:00.000Z", "Europe/Berlin"),
        ("2026-03-31T22:00:00.000Z".to_string(), 1.0)
    );
    // New York: November begins before the clocks go back that same day, December after.
    assert_eq!(
        month("2026-11-01T03:59:59.999Z", "America/New_York"),
        ("2026-10-01T04:00:00.000Z".to_string(), 1.0)
    );
    assert_eq!(
        month("2026-11-01T04:00:00.000Z", "America/New_York"),
        ("2026-11-01T04:00:00.000Z".to_string(), 1.0)
    );
    assert_eq!(
        month("2026-12-01T04:59:59.999Z", "America/New_York"),
        ("2026-11-01T04:00:00.000Z".to_string(), 2.0)
    );
    assert_eq!(
        month("2026-12-01T05:00:00.000Z", "America/New_York"),
        ("2026-12-01T05:00:00.000Z".to_string(), 1.0)
    );
    // The owner's own zone is the default (the test app's is UTC); an unknown zone counts as UTC.
    let own = monthly_spend(
        &t,
        Some(t.db()),
        &MonthlyOpts {
            now: Some(ms("2026-03-01T00:00:00.000Z")),
            ..MonthlyOpts::default()
        },
    );
    assert_eq!((own.time_zone.as_str(), own.total_usd), ("UTC", 1.0));
    assert_eq!(month("2026-03-01T00:00:00.000Z", "Mars/Olympus").1, 1.0);
    // No zone named, or an empty one, is the owner's.
    let manila = test_app_with_env([("TARSEE_TIMEZONE", "Asia/Manila")]);
    for zone in [None, Some("")] {
        let opts = MonthlyOpts {
            now: Some(ms(NOW)),
            time_zone: zone,
            provider: None,
        };
        let m = monthly_spend(&manila, None, &opts);
        assert_eq!(
            (m.time_zone.as_str(), m.from),
            ("Asia/Manila", ms("2026-10-31T16:00:00Z")),
            "{zone:?}"
        );
    }
    // The moment asked about is counted; one a millisecond later is not.
    assert_eq!(month("2026-03-31T22:00:00.000Z", "UTC").1, 3.0);
    assert_eq!(month("2026-03-31T21:59:59.999Z", "UTC").1, 2.0);
}

#[test]
fn the_cap_needs_a_database_to_be_reached_and_says_what_is_left() {
    let t = spent();
    let capped = store_of(&[(SPEND_CAP_KEY, json!(2))]);
    let opts = CapOpts {
        store: Some(&capped),
        db: Some(t.db()),
        now: Some(ms(NOW)),
        time_zone: Some(TZ),
    };
    assert_eq!(
        serde_json::to_value(monthly_cap_status(&t, "openai", &opts)).unwrap(),
        json!({ "ok": true, "metered": true, "capUsd": 2, "spentUsd": 0.75, "remainingUsd": 1.25, "subtype": null, "message": null })
    );
    // With no database named the cap is never reached, as in the JS for a store that has none.
    let no_db = CapOpts { db: None, ..opts };
    assert_eq!(
        serde_json::to_value(monthly_cap_status(&t, "openai", &no_db)).unwrap(),
        json!({ "ok": true, "metered": true, "capUsd": 2, "spentUsd": null, "remainingUsd": null, "subtype": null, "message": null })
    );
    // An unknown provider, or none: nothing is metered.
    for id in ["nobody", ""] {
        let s = monthly_cap_status(&t, id, &opts);
        assert!(s.ok && !s.metered && s.spent_usd.is_none(), "{id}");
    }
    // Exactly at the cap is reached.
    let exact = store_of(&[(SPEND_CAP_KEY, json!(0.75))]);
    let s = monthly_cap_status(
        &t,
        "deepseek",
        &CapOpts {
            store: Some(&exact),
            ..opts
        },
    );
    assert!(!s.ok);
    assert_eq!(s.remaining_usd, Some(0.0));
    // Local AI is refused only once its card sets a price.
    let priced = store_of(&[
        (SPEND_CAP_KEY, json!(0.5)),
        ("ai.local.price", json!({ "in": 1, "out": 1 })),
    ]);
    assert!(!within_monthly_cap(
        &t,
        "local",
        &CapOpts {
            store: Some(&priced),
            ..opts
        }
    ));
}
