//! Port of `test/usage-core.test.js`: the Usage page's rules (`src/public/js/usage-core.js`, `UsageCore`): counts,
//! speeds, times and a chart's bars as people read them.

use serde_json::{Value, json};

use crate::support::Page;

async fn usage_core() -> Page {
    Page::with_scripts(&["usage-core.js"]).await
}

/// `Date.parse(iso)`.
fn ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .expect("a time")
        .timestamp_millis()
}

/// `values.map(UsageCore.<name>)`, with `map`'s own arguments, as the Node test called it.
async fn map(page: &Page, name: &str, values: Value) -> Value {
    page.apply(&format!("(values) => values.map(UsageCore.{name})"), json!([values]))
        .await
}

async fn u(page: &Page, name: &str, args: Value) -> Value {
    page.call(&format!("UsageCore.{name}"), args).await
}

/// `rows.find((r) => r.label === label)`.
fn row<'a>(rows: &'a Value, label: &str) -> Option<&'a Value> {
    rows.as_array().expect("rows").iter().find(|r| r["label"] == label)
}

#[tokio::test]
async fn token_counts_plain_under_a_thousand_then_k_m_and_b_with_at_most_one_decimal() {
    let page = usage_core().await;
    assert_eq!(
        map(
            &page,
            "tokens",
            json!([
                0,
                850,
                1000,
                12_400,
                12_049,
                99_960,
                412_300,
                1_000_000,
                18_240_000,
                137_000_000,
                2_241_806_691u64
            ])
        )
        .await,
        json!([
            "0", "850", "1k", "12.4k", "12k", "100k", "412k", "1M", "18.2M", "137M", "2.2B"
        ])
    );
}

#[tokio::test]
async fn speeds_times_and_shares() {
    let page = usage_core().await;
    assert_eq!(u(&page, "tps", json!([38.4])).await, "38 tk/s");
    assert_eq!(u(&page, "tps", json!([4.25])).await, "4.3 tk/s");
    assert_eq!(u(&page, "tps", json!([13410.8])).await, "13,411 tk/s");
    assert_eq!(u(&page, "tps", json!([null])).await, "");
    assert_eq!(
        map(&page, "dur", json!([41_000, 125_000, 3_900_000, 60 * 3_600_000])).await,
        json!(["41s", "2m 05s", "1h 05m", "2d 12h"])
    );
    assert_eq!(u(&page, "pct", json!([0.964])).await, "96%");
    assert_eq!(u(&page, "pct", json!([0.004])).await, "under 1%");
}

#[tokio::test]
async fn the_line_under_a_reply() {
    let page = usage_core().await;
    assert_eq!(
        u(
            &page,
            "answerLine",
            json!([{ "total": 12_400, "outTps": 38.2, "ms": 41_000 }])
        )
        .await,
        "12.4k tokens · 38 tk/s · 41s"
    );
    assert_eq!(
        u(
            &page,
            "answerLine",
            json!([{ "total": 12_400, "outTps": null, "ms": 41_000 }])
        )
        .await,
        "12.4k tokens · 41s"
    );
    assert_eq!(
        u(&page, "answerLine", json!([{ "total": 0 }])).await,
        "",
        "a turn with no model calls has no line"
    );
    assert_eq!(
        u(
            &page,
            "liveLine",
            json!([{ "total": 84_200, "nowTps": 41, "outTps": 39 }])
        )
        .await,
        "84.2k tokens · 41 tk/s",
        "the latest calls' speed while it works"
    );
    assert_eq!(
        u(
            &page,
            "liveLine",
            json!([{ "total": 84_200, "nowTps": null, "outTps": 39 }])
        )
        .await,
        "84.2k tokens · 39 tk/s"
    );
    assert_eq!(
        u(
            &page,
            "liveLine",
            json!([{ "total": 45_300, "nowTps": null, "outTps": null }])
        )
        .await,
        "45.3k tokens",
        "the first call still going: no speed yet"
    );
    assert_eq!(u(&page, "liveLine", json!([null])).await, "");
}

#[tokio::test]
async fn a_breakdown_every_kind_of_token_the_total_the_caches_share_and_both_speeds() {
    let page = usage_core().await;
    let rows = u(
        &page,
        "breakdown",
        json!([{ "input": 10, "cacheRead": 9000, "cacheWrite": 500, "output": 490, "total": 10_000, "cacheShare": 0.9, "outTps": 98, "totalTps": 2000, "genMs": 5000, "calls": 3 }]),
    )
    .await;
    let pairs: Vec<Value> = rows
        .as_array()
        .expect("rows")
        .iter()
        .map(|r| json!([r["label"], r["value"]]))
        .collect();
    assert_eq!(
        Value::Array(pairs),
        json!([
            ["Input", "10"],
            ["Cache read", "9,000"],
            ["Cache write", "500"],
            ["Output", "490"],
            ["Total", "10,000"],
            ["Cache reads", "90%"],
            ["Output speed", "98 tk/s"],
            ["Total speed", "2,000 tk/s"],
            ["Generating", "5s"],
        ])
    );
    let unmeasured = u(&page, "breakdown", json!([{ "total": 5, "outTps": null }])).await;
    assert_eq!(
        row(&unmeasured, "Output speed").expect("a speed row")["value"],
        "not measured"
    );
}

#[tokio::test]
async fn a_charts_bars_scaled_to_the_tallest_the_strong_part_inside_its_bar_a_gap_between_them() {
    let page = usage_core().await;
    let chart = u(
        &page,
        "bars",
        json!([[{ "total": 100, "part": 10 }, { "total": 50, "part": 50 }, { "total": 0, "part": 0 }], 300, 100, { "gap": 6 }]),
    )
    .await;
    assert_eq!(chart["max"], 100);
    let bars = &chart["bars"];
    assert_eq!(
        bars[0],
        json!({ "x": 3, "w": 94, "y": 0, "h": 100, "partY": 90, "partH": 10 })
    );
    assert_eq!(bars[1]["h"], 50);
    assert_eq!(bars[1]["partH"], 50);
    assert_eq!(bars[2]["h"], 0);
    assert_eq!(
        map(&page, "niceMax", json!([1, 7, 13, 240, 2_241_806_691u64])).await,
        json!([1, 10, 20, 250, 2_500_000_000u64])
    );
}

#[tokio::test]
async fn times_in_the_servers_timezone_the_hour_today_the_day_and_hour_before() {
    let page = usage_core().await;
    u(&page, "setTimeZone", json!(["Asia/Tokyo"])).await;
    assert_eq!(u(&page, "timeZone", json!([])).await, "Asia/Tokyo");
    // 10 AM in Tokyo.
    let now = ms("2026-10-26T01:00:00Z");
    assert_eq!(
        u(&page, "when", json!([ms("2026-10-26T00:19:00Z"), now])).await,
        "9:19 AM"
    );
    assert_eq!(
        u(&page, "when", json!([ms("2026-10-25T00:19:00Z"), now])).await,
        "Oct 25, 9:19 AM"
    );
    assert_eq!(u(&page, "dayLabel", json!([now])).await, "Oct 26");
    assert_eq!(u(&page, "hourLabel", json!([now])).await, "10 AM");
    u(&page, "setTimeZone", json!(["America/New_York"])).await;
    assert_eq!(
        u(&page, "dayLabel", json!([now])).await,
        "Oct 25",
        "still the evening before in New York"
    );
    assert_eq!(
        u(&page, "span", json!([now - 90_000, null, now])).await,
        "running 1m 30s"
    );
}

#[tokio::test]
async fn money_cents_thousands_and_under_a_cent_said_so() {
    let page = usage_core().await;
    assert_eq!(
        map(&page, "money", json!([0, 0.004, 0.0631, 0.5, 12.5, 1234.5])).await,
        json!(["$0.00", "under $0.01", "$0.06", "$0.50", "$12.50", "$1,234.50"])
    );
    assert_eq!(u(&page, "money", json!([null])).await, "");
}

#[tokio::test]
async fn what_a_cost_is_exact_estimated_included_in_a_plan_free_or_not_known() {
    let page = usage_core().await;
    let cost = |c: Value| {
        let page = &page;
        async move { u(page, "costText", json!([c])).await }
    };
    assert_eq!(cost(json!({ "costUsd": 0.37, "costNote": "exact" })).await, "$0.37");
    assert_eq!(
        cost(json!({ "costUsd": 0.0631, "costNote": "est" })).await,
        "$0.06 est."
    );
    assert_eq!(
        cost(json!({ "costUsd": null, "costNote": "plan" })).await,
        "Included in plan"
    );
    assert_eq!(cost(json!({ "costUsd": 0, "costNote": "free" })).await, "Free");
    assert_eq!(
        cost(json!({ "costUsd": null, "costNote": "unknown" })).await,
        "Cost not known"
    );
    assert_eq!(
        cost(json!({ "costUsd": null, "costNote": null })).await,
        "",
        "nothing ran: nothing to say"
    );
    assert_eq!(cost(Value::Null).await, "");
}

#[tokio::test]
async fn a_replys_line_and_breakdown_carry_what_it_cost_a_plans_reply_line_stays_as_it_was() {
    let page = usage_core().await;
    assert_eq!(
        u(
            &page,
            "answerLine",
            json!([{ "total": 12_400, "outTps": 38.2, "ms": 41_000, "costUsd": 0.0123, "costNote": "est" }])
        )
        .await,
        "12.4k tokens · 38 tk/s · 41s · $0.01 est."
    );
    assert_eq!(
        u(
            &page,
            "answerLine",
            json!([{ "total": 12_400, "outTps": 38.2, "ms": 41_000, "costUsd": null, "costNote": "plan" }])
        )
        .await,
        "12.4k tokens · 38 tk/s · 41s"
    );
    let rows = u(
        &page,
        "breakdown",
        json!([{ "total": 10, "outTps": null, "costUsd": null, "costNote": "plan", "providerLabel": "Claude plan" }]),
    )
    .await;
    assert_eq!(row(&rows, "Cost").expect("a cost row")["value"], "Included in plan");
    assert_eq!(
        rows.as_array().expect("rows").last().expect("a row")["label"],
        "Cost",
        "after the tokens"
    );
    let exact = u(
        &page,
        "breakdown",
        json!([{ "total": 10, "costUsd": 0.37, "costNote": "exact" }]),
    )
    .await;
    assert_eq!(row(&exact, "Cost").expect("a cost row")["value"], "$0.37");
    let unknown = u(&page, "breakdown", json!([{ "total": 10 }])).await;
    assert!(row(&unknown, "Cost").is_none(), "no cost known: no row");
}

#[tokio::test]
async fn the_charts_spend_line_the_days_total_and_the_daily_average_est_when_any_of_it_is() {
    let page = usage_core().await;
    let days = json!([{ "costUsd": null, "costNote": "plan" }, { "costUsd": 0.5, "costNote": "exact" }, { "costUsd": 0.9, "costNote": "est" }, { "costUsd": null, "costNote": null }]);
    assert_eq!(
        u(&page, "spendLine", json!([days])).await,
        "Spent $1.40 est. over 4 days, about $0.35 a day"
    );
    assert_eq!(
        u(
            &page,
            "spendLine",
            json!([[{ "costUsd": 0.5, "costNote": "exact" }, { "costUsd": 0.25, "costNote": "exact" }]])
        )
        .await,
        "Spent $0.75 over 2 days, about $0.38 a day"
    );
    assert_eq!(
        u(
            &page,
            "spendLine",
            json!([[{ "costUsd": null, "costNote": "plan" }, { "costUsd": null, "costNote": "plan" }]])
        )
        .await,
        "Included in plan",
        "only a plan's work"
    );
    assert_eq!(
        u(&page, "spendLine", json!([[{ "costUsd": null, "costNote": null }]])).await,
        "",
        "nothing ran"
    );
    assert_eq!(page.eval("UsageCore.spendLine(undefined)").await, "");
}

#[tokio::test]
async fn the_provider_filter_shows_once_more_than_one_ai_did_work_and_stays_while_it_is_in_use() {
    let page = usage_core().await;
    let list = json!([{ "id": "claude", "label": "Claude plan" }, { "id": "deepseek", "label": "DeepSeek" }]);
    let c = u(&page, "providerChoices", json!([list, null])).await;
    assert_eq!(c["show"], true);
    let items: Vec<Value> = c["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|i| json!([i["id"], i["label"], i["pressed"]]))
        .collect();
    assert_eq!(
        Value::Array(items),
        json!([
            [null, "All", true],
            ["claude", "Claude plan", false],
            ["deepseek", "DeepSeek", false]
        ])
    );
    assert_eq!(
        u(&page, "providerChoices", json!([[list[0]], null])).await["show"],
        false,
        "one AI: nothing to choose"
    );
    let kept = u(&page, "providerChoices", json!([[list[1]], "deepseek"])).await;
    assert_eq!(kept["show"], true);
    let pressed: Vec<&Value> = kept["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter(|i| i["pressed"] == true)
        .map(|i| &i["id"])
        .collect();
    assert_eq!(pressed, [&json!("deepseek")]);
    assert_eq!(
        page.eval("UsageCore.providerChoices(undefined, null).show").await,
        false
    );
}

#[tokio::test]
async fn a_zone_the_browser_does_not_know_falls_back_to_the_browsers_own() {
    let page = usage_core().await;
    u(&page, "setTimeZone", json!(["Not/AZone"])).await;
    assert_eq!(page.eval("typeof UsageCore.timeZone()").await, "undefined");
    let when = page.eval("UsageCore.when(Date.now())").await;
    assert!(when.as_str().is_some_and(|s| !s.is_empty()), "{when}");
    u(&page, "setTimeZone", json!([null])).await;
    assert_eq!(page.eval("typeof UsageCore.timeZone()").await, "undefined");
}
