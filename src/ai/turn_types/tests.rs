//! Tests of `ai/turn_types.rs`.
//!
//! The two JSON files beside this one hold what the Node code really yielded, captured by running it:
//!
//! - `node-turn-layer.json`: `src/ai/turn.js` `runTurn` with scripted engines (`test/fakes/fake-engine.js`), one
//!   list of events per situation: a plain turn, a refusal, an engine that forgets its done, one that ends badly, an
//!   expired sign-in, a crash, a turn ending on a tool, an engine's own error after output, the backup model, the
//!   spend ceiling, a Codex turn over its ceiling, a reported cost with an unknown event, a Verify probe on Codex.
//! - `node-engines.json`: `src/ai/providers/claude-code.js` `run` with the SDK's `query` stubbed, and
//!   `src/ai/providers/codex-events.js` `mapCodexEvent`, `finishCodexEvents` and `usageEvents`.
//!
//! The scripts that made them are `docs/rust-port/reports/I0-capture-turn.mjs.txt` and `I0-capture-engines.mjs.txt`.

use futures::StreamExt;
use serde_json::{Value, json};

use super::*;

const NODE_TURN_LAYER: &str = include_str!("node-turn-layer.json");
const NODE_ENGINES: &str = include_str!("node-engines.json");

/// Every captured event, as (file, situation, index, the Node object).
fn node_events() -> Vec<(&'static str, String, usize, Value)> {
    let mut out = Vec::new();
    for (file, text) in [("turn layer", NODE_TURN_LAYER), ("engines", NODE_ENGINES)] {
        let scenes: serde_json::Map<String, Value> = serde_json::from_str(text).expect("the fixture is JSON");
        for (scene, events) in scenes {
            for (index, event) in events.as_array().expect("a list of events").iter().enumerate() {
                out.push((file, scene.clone(), index, event.clone()));
            }
        }
    }
    out
}

fn scene(text: &str, name: &str) -> Vec<TurnEvent> {
    let scenes: Value = serde_json::from_str(text).unwrap();
    scenes[name]
        .as_array()
        .unwrap_or_else(|| panic!("no situation called {name}"))
        .iter()
        .map(|event| TurnEvent::from_value(event.clone()))
        .collect()
}

fn types(events: &[TurnEvent]) -> Vec<&str> {
    events.iter().map(TurnEvent::event_type).collect()
}

// --- Against the Node objects ------------------------------------------------------------------------------------

#[test]
fn every_event_node_yields_reads_as_its_own_variant_and_writes_back_the_same_object() {
    let events = node_events();
    assert_eq!(events.len(), 152, "the fixtures' events");
    let mut seen = std::collections::BTreeSet::new();
    for (file, scene, index, node) in events {
        let at = format!("{file} / {scene}[{index}]: {node}");
        let event = TurnEvent::from_value(node.clone());
        let kind = node["type"].as_str().unwrap();
        // One event in the fixtures is of a type Tarsee has no name for (a scripted engine's "weather").
        assert_eq!(matches!(event, TurnEvent::Other(_)), kind == "weather", "{at}");
        assert_eq!(event.event_type(), kind, "{at}");
        assert_eq!(event.to_value(), node, "{at}");
        // And through text, as it travels: same object again.
        let again: TurnEvent = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        assert_eq!(again, event, "{at}");
        seen.insert(kind.to_string());
    }
    let seen: Vec<&str> = seen.iter().map(String::as_str).collect();
    assert_eq!(
        seen,
        [
            "done",
            "error",
            "route",
            "step",
            "text",
            "thinking",
            "tool_result",
            "tool_use",
            "usage",
            "weather"
        ],
        "every type Tarsee's turns yield is in the fixtures"
    );
}

/// The text itself, key for key in Node's order, for the events whose keys are always written in one order. An
/// error's and a usage's are not (each place in the Node code that makes one lists its keys its own way), so those
/// are held to the same object, above.
#[test]
fn route_text_thinking_tools_steps_and_done_serialise_to_nodes_own_text() {
    let mut checked = 0;
    for (file, scene, index, node) in node_events() {
        let kind = node["type"].as_str().unwrap();
        if matches!(kind, "error" | "usage") {
            continue;
        }
        let event = TurnEvent::from_value(node.clone());
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            node.to_string(),
            "{file} / {scene}[{index}]"
        );
        checked += 1;
    }
    assert_eq!(checked, 119, "all but the 20 errors and 13 usages");
}

#[test]
fn a_plain_turn_route_first_then_the_engines_events_and_one_done() {
    let events = scene(NODE_TURN_LAYER, "plainTurn");
    assert_eq!(
        types(&events),
        [
            "route",
            "thinking",
            "thinking",
            "text",
            "tool_use",
            "tool_result",
            "text",
            "usage",
            "done"
        ]
    );
    let TurnEvent::Route(route) = &events[0] else {
        panic!("not a route")
    };
    assert_eq!(route.provider, "claude");
    assert_eq!(route.engine.as_deref(), Some("claude-code"));
    assert_eq!(route.model.as_deref(), Some("sonnet"));
    assert_eq!(route.label, "Claude Sonnet");
    assert_eq!(route.provider_label, "Claude plan");
    assert_eq!(route.effort.as_deref(), Some("medium"));
    assert_eq!(route.vendor.as_deref(), Some("claude"));
    assert!(route.streaming && !route.backup);
    assert!(route.extra.is_empty());

    assert_eq!(events[1], TurnEvent::thinking(ThinkingStatus::Start));
    assert_eq!(events[2], TurnEvent::thinking(ThinkingStatus::Stop));
    assert_eq!(events[3], TurnEvent::text("Hello"));
    assert_eq!(events[4], TurnEvent::tool_use("t1", "Bash", json!({"command": "ls"})));
    assert_eq!(events[5], TurnEvent::tool_result("t1", true, "a\nb"));
    let TurnEvent::Usage(usage) = &events[7] else {
        panic!("not a usage")
    };
    assert_eq!(
        usage.usage,
        Usage {
            context_input_tokens: Some(17),
            ..Usage::new(10, 2, 3, 4)
        }
    );
    assert_eq!((usage.cost_usd, usage.cost_exact), (None, false));
    assert_eq!(events[8], TurnEvent::done("end_turn"));
    assert!(events[8].is_done() && !events[7].is_done());
}

/// `ai/turn.js` `refuse()`: the reason as the reply, the same as an error, and a done with the reason.
#[test]
fn a_refusal_is_text_an_error_and_a_done_and_can_be_built_the_same() {
    let events = scene(NODE_TURN_LAYER, "refusal");
    let message = "\"API keys only\" is switched on, so Tarsee won't use your Claude plan. Choose an AI that uses an API key in Settings > AI.";
    let built = vec![
        TurnEvent::text(message),
        TurnEvent::Error(
            ErrorEvent::new(message)
                .with_subtype("blocked-keys-only")
                .with_recoverable(false),
        ),
        TurnEvent::done("blocked-keys-only"),
    ];
    assert_eq!(events, built);
    let node: Value = serde_json::from_str(NODE_TURN_LAYER).unwrap();
    assert_eq!(
        serde_json::to_string(&built).unwrap(),
        node["refusal"].to_string(),
        "key for key"
    );
}

/// An error's `code` has three states in the Node objects: left out, `null`, and a word.
#[test]
fn an_errors_code_can_be_left_out_null_or_a_word() {
    let error_of = |name: &str| -> ErrorEvent {
        scene(NODE_TURN_LAYER, name)
            .into_iter()
            .find_map(|event| match event {
                TurnEvent::Error(error) => Some(error),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} has no error"))
    };

    // The turn layer's own budget stop never looks for a code.
    let budget = error_of("budget");
    assert_eq!(budget.code, None);
    assert_eq!(budget.code(), None);
    assert_eq!(budget.subtype.as_deref(), Some("error_max_budget_usd"));
    assert!(budget.to_json().get("code").is_none());

    // An engine that forgot its done: the turn layer looked for a code and found none.
    let no_done = error_of("noDone");
    assert_eq!(no_done.code, Some(None));
    assert_eq!(no_done.code(), None);
    assert_eq!(
        no_done.message,
        "The AI stopped without finishing its reply. Try again."
    );
    assert_eq!(no_done.to_json()["code"], Value::Null);
    assert!(no_done.to_json().as_object().unwrap().contains_key("code"));
    assert_eq!(no_done.subtype, None);

    // A sign-in that ran out.
    let expired = error_of("authExpired");
    assert_eq!(expired.code(), Some("auth"));
    assert_eq!(expired.subtype.as_deref(), Some("auth-expired"));
    assert_eq!(expired.recoverable, Some(false));

    // A crash has a message and the null code, and no flag at all.
    let crash = error_of("crash");
    assert_eq!(
        (crash.message.as_str(), crash.recoverable, crash.code.clone()),
        ("spawn claude ENOENT", None, Some(None))
    );
    assert!(!crash.is_recoverable());

    // An engine's own error after output: the recoverable flag is gone, the rest is passed on.
    let engine = error_of("engineError");
    assert_eq!(engine.recoverable, None);
    assert_eq!(
        (engine.code(), engine.status, engine.state.as_deref()),
        (Some("billing"), Some(402), Some("out-of-credit"))
    );
    assert_eq!(engine.subtype.as_deref(), Some("error_during_execution"));

    // The builder writes the same three states.
    assert_eq!(
        serde_json::to_value(ErrorEvent::new("x")).unwrap(),
        json!({"message": "x"})
    );
    assert_eq!(
        serde_json::to_value(ErrorEvent::new("x").with_code(None)).unwrap(),
        json!({"message": "x", "code": null})
    );
    assert_eq!(
        serde_json::to_value(
            ErrorEvent::new("x")
                .with_code(Some("auth"))
                .with_status(401)
                .with_state("error")
        )
        .unwrap(),
        json!({"message": "x", "code": "auth", "status": 401, "state": "error"})
    );
}

impl ErrorEvent {
    fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap()
    }
}

#[test]
fn the_backup_model_gets_a_second_route() {
    let events = scene(NODE_TURN_LAYER, "backup");
    assert_eq!(types(&events), ["route", "route", "text", "text", "done"]);
    let routes: Vec<(&str, bool)> = events
        .iter()
        .filter_map(|event| match event {
            TurnEvent::Route(route) => Some((route.provider.as_str(), route.backup)),
            _ => None,
        })
        .collect();
    assert_eq!(routes, [("claude", false), ("deepseek", true)]);
}

#[test]
fn a_done_carries_its_reason_the_over_budget_marks_and_whatever_else_the_engine_put_there() {
    let over = scene(NODE_TURN_LAYER, "overBudget");
    let TurnEvent::Done(done) = over.last().unwrap() else {
        panic!("not a done")
    };
    assert_eq!(done.reason(), Some("end_turn"));
    assert!(done.over_budget);
    assert_eq!((done.ceiling_usd, done.spent_usd), (Some(1.0), Some(18.0)));
    // (Whole dollars are written as Node writes them: 1 and 18, not 1.0 and 18.0.)
    assert_eq!(
        serde_json::to_string(done).unwrap(),
        r#"{"stopReason":"end_turn","overBudget":true,"ceilingUsd":1,"spentUsd":18}"#
    );
    let TurnEvent::Route(route) = &over[0] else {
        panic!("not a route")
    };
    assert_eq!((route.engine.as_deref(), route.streaming), (Some("codex"), false));

    let reported = scene(NODE_TURN_LAYER, "reportedCost");
    let TurnEvent::Done(done) = reported.last().unwrap() else {
        panic!("not a done")
    };
    assert_eq!(done.extra.get("engineNote"), Some(&json!("kept")));
    assert!(!done.over_budget && done.ceiling_usd.is_none());

    assert_eq!(
        serde_json::to_string(&TurnEvent::done("aborted")).unwrap(),
        r#"{"type":"done","stopReason":"aborted"}"#
    );
    // An event with no reason at all (only a scripted engine yields one): the caller's default applies.
    let bare = TurnEvent::from_value(json!({"type": "done"}));
    let TurnEvent::Done(done) = &bare else {
        panic!("not a done: {bare:?}")
    };
    assert_eq!(done.reason(), None);
    assert_eq!(done.reason().unwrap_or("end_turn"), "end_turn");
}

#[test]
fn a_usage_carries_the_cost_when_the_engine_knows_it() {
    let events = scene(NODE_TURN_LAYER, "reportedCost");
    let TurnEvent::Usage(usage) = &events[1] else {
        panic!("not a usage")
    };
    assert_eq!((usage.cost_usd, usage.cost_exact), (Some(0.0042), true));
    assert_eq!(usage.usage, Usage::new(10, 10, 0, 0));
    assert_eq!(
        serde_json::to_string(&events[1]).unwrap(),
        r#"{"type":"usage","usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"costUsd":0.0042,"costExact":true}"#
    );

    // costExact is written only when true, costUsd only when there is one; whole numbers as Node writes them.
    let mut event = UsageEvent {
        usage: Usage::new(1, 2, 3, 4),
        cost_usd: Some(2.0),
        ..Default::default()
    };
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4},"costUsd":2}"#
    );
    event.cost_usd = Some(0.5);
    assert!(serde_json::to_string(&event).unwrap().ends_with(r#""costUsd":0.5}"#));
    assert_eq!(
        serde_json::to_string(&TurnEvent::usage(Usage::new(1, 2, 3, 4))).unwrap(),
        r#"{"type":"usage","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}"#
    );

    // A cost the engine left inside the usage itself (the turn layer reads `usage.cost_usd` and `usage.cost` too).
    let inside = TurnEvent::from_value(
        json!({"type": "usage", "usage": {"input_tokens": 5, "output_tokens": 1, "cost": 0.002}}),
    );
    let TurnEvent::Usage(usage) = &inside else {
        panic!("not a usage: {inside:?}")
    };
    assert_eq!(usage.usage.extra.get("cost"), Some(&json!(0.002)));
    assert_eq!(
        usage.usage.cache_read_input_tokens, None,
        "a count nobody sent is not there"
    );
    assert_eq!(
        usage.usage.cache_read(),
        0,
        "and reads as 0, as `usage.cache_read_input_tokens || 0` did"
    );
}

/// `usage = { ...usage, ...event.usage }`, as every caller of a turn gathers it (`routes/chat.js`,
/// `channels/websocket.js`, the five channels), with what they store from it:
/// `tokensIn = (input + cache_read + cache_creation) || null`, `tokensOut = usage.output_tokens ?? null`. Each
/// expected text is what Node's own spread gave for the same events.
#[test]
fn a_caller_gathers_the_turns_usage_as_node_spreads_it() {
    let text = |usage: &Usage| serde_json::to_string(usage).unwrap();
    let prompt = |usage: &Usage| usage.input() + usage.cache_read() + usage.cache_creation();
    let usage_of = |node: Value| serde_json::from_value::<Usage>(node).unwrap();

    // A turn with no usage event leaves {}.
    let mut gathered = Usage::default();
    assert_eq!(text(&gathered), "{}");
    assert_eq!((prompt(&gathered), gathered.output_tokens), (0, None));

    // The scripted usage of test/channel-turns.test.js and test/slack-bot.test.js names two counts: the other two
    // are not made up.
    gathered.merge(&usage_of(json!({"input_tokens": 12, "output_tokens": 3})));
    assert_eq!(text(&gathered), r#"{"input_tokens":12,"output_tokens":3}"#);
    assert_eq!((prompt(&gathered), gathered.output_tokens), (12, Some(3)));

    // A whole usage, as the engines send it.
    let mut gathered = Usage::default();
    gathered.merge(&Usage {
        context_input_tokens: Some(40_000),
        ..Usage::new(10, 2, 3, 4)
    });
    assert_eq!(
        text(&gathered),
        r#"{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"context_input_tokens":40000}"#
    );
    assert_eq!((prompt(&gathered), gathered.output_tokens), (17, Some(2)));

    // A later event's counts replace the earlier ones; what only the earlier one had stays.
    gathered.merge(&usage_of(json!({
        "input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "cost": 0.002
    })));
    assert_eq!(
        text(&gathered),
        r#"{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"context_input_tokens":40000,"cost":0.002}"#
    );

    // A later event that names one count changes that one.
    gathered.merge(&usage_of(json!({"output_tokens": 7})));
    assert_eq!(
        text(&gathered),
        r#"{"input_tokens":100,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"context_input_tokens":40000,"cost":0.002}"#
    );
    assert_eq!((prompt(&gathered), gathered.output_tokens), (100, Some(7)));

    // Only the input: no output count to store (`usage.output_tokens ?? null`).
    let mut gathered = Usage::default();
    gathered.merge(&usage_of(json!({"input_tokens": 5})));
    assert_eq!(text(&gathered), r#"{"input_tokens":5}"#);
    assert_eq!(
        (prompt(&gathered), gathered.output_tokens, gathered.output()),
        (5, None, 0)
    );
}

/// What an engine sends has all four counts, a zero written as a zero.
#[test]
fn a_usage_from_an_engine_has_all_four_counts() {
    let usage = Usage::new(1000, 80, 0, 0);
    assert_eq!(
        serde_json::to_string(&usage).unwrap(),
        r#"{"input_tokens":1000,"output_tokens":80,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}"#
    );
    assert_eq!(
        (
            usage.input(),
            usage.output(),
            usage.cache_read(),
            usage.cache_creation()
        ),
        (1000, 80, 0, 0)
    );
    assert_eq!(usage.cache_read_input_tokens, Some(0));
    assert_eq!(serde_json::to_string(&Usage::default()).unwrap(), "{}");
}

#[test]
fn an_event_of_a_type_tarsee_has_no_name_for_is_kept_whole() {
    let events = scene(NODE_TURN_LAYER, "reportedCost");
    let TurnEvent::Other(value) = &events[3] else {
        panic!("not kept as it is: {:?}", events[3])
    };
    assert_eq!(value, &json!({"type": "weather", "sky": "clear"}));
    assert_eq!(events[3].event_type(), "weather");
    assert_eq!(
        serde_json::to_string(&events[3]).unwrap(),
        r#"{"type":"weather","sky":"clear"}"#
    );
}

#[test]
fn what_fits_no_variant_is_kept_as_it_is_and_reading_never_fails() {
    for odd in [
        json!({"type": "text", "content": 5}),
        json!({"type": "thinking", "status": "paused"}),
        json!({"type": "tool_result", "id": "t1", "ok": "yes"}),
        json!({"type": "usage", "usage": "none"}),
        json!({"type": "usage", "usage": {"input_tokens": -1}}),
        // (A count that is null is not a count: the event is kept whole rather than losing the field.)
        json!({"type": "usage", "usage": {"input_tokens": 5, "output_tokens": null}}),
        json!({"type": "usage", "usage": {"input_tokens": 1.5}}),
        json!({"type": "done", "stopReason": 7}),
        json!({"type": "error", "message": {"text": "x"}}),
        json!({"content": "no type"}),
        // (A number for a type is no type: serde would otherwise take it for the fourth variant.)
        json!({"type": 3}),
        json!({"type": "Text", "content": "wrong case"}),
        json!("just words"),
        json!(null),
        json!([1, 2]),
    ] {
        let event = TurnEvent::from_value(odd.clone());
        assert_eq!(event, TurnEvent::Other(odd.clone()), "{odd}");
        assert_eq!(event.to_value(), odd);
        let kind = odd.get("type").and_then(Value::as_str).unwrap_or("");
        assert_eq!(event.event_type(), kind);
        assert_eq!(serde_json::from_value::<TurnEvent>(odd.clone()).unwrap(), event);
    }
}

#[test]
fn fields_tarsee_has_no_name_for_stay_on_the_event() {
    for (node, kind) in [
        (json!({"type": "text", "content": "Hi", "index": 2}), "text"),
        (
            json!({"type": "thinking", "status": "start", "signature": "abc"}),
            "thinking",
        ),
        (
            json!({"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}, "parent": "t0"}),
            "tool_use",
        ),
        // (routes/chat.js and channels/websocket.js read a tool_result's `name`, which no engine gives.)
        (
            json!({"type": "tool_result", "id": "t1", "ok": false, "result": "no", "name": "Bash"}),
            "tool_result",
        ),
        (
            json!({"type": "route", "provider": "claude", "engine": "claude-code", "model": null, "label": "Claude", "providerLabel": "Claude plan", "effort": null, "vendor": "claude", "streaming": true, "backup": false, "tier": "opus"}),
            "route",
        ),
        (json!({"type": "error", "message": "x", "retryAfter": 30}), "error"),
        (
            json!({"type": "usage", "usage": {"input_tokens": 1, "output_tokens": 2, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "reasoning_tokens": 9}, "calls": 3}),
            "usage",
        ),
    ] {
        let event = TurnEvent::from_value(node.clone());
        assert!(!matches!(event, TurnEvent::Other(_)), "{node}");
        assert_eq!(event.event_type(), kind);
        assert_eq!(event.to_value(), node, "nothing was lost");
    }
    let TurnEvent::ToolResult(result) =
        TurnEvent::from_value(json!({"type": "tool_result", "id": "t1", "ok": false, "result": "no", "name": "Bash"}))
    else {
        panic!("not a tool_result")
    };
    assert_eq!(result.extra.get("name"), Some(&json!("Bash")));
}

/// The partial events the Node tests script for the channels (`test/channel-turns.test.js`,
/// `test/slack-bot.test.js`, `test/verify-model.test.js`): they read as the variant they are.
#[test]
fn a_scripted_event_with_fields_left_out_still_reads_as_its_variant() {
    let route = TurnEvent::from_value(json!({
        "type": "route", "provider": "deepseek", "engine": "claude-code", "model": "deepseek-v4-flash",
        "label": "DeepSeek Flash", "providerLabel": "DeepSeek API key", "effort": null
    }));
    let TurnEvent::Route(route) = route else {
        panic!("not a route: {route:?}")
    };
    assert_eq!(
        (
            route.label.as_str(),
            route.vendor.as_deref(),
            route.streaming,
            route.backup
        ),
        ("DeepSeek Flash", None, false, false)
    );
    // Written back, the fields it left out are there with nothing in them (the turn layer's own routes always
    // have all nine).
    assert_eq!(
        serde_json::to_string(&TurnEvent::Route(route)).unwrap(),
        r#"{"type":"route","provider":"deepseek","engine":"claude-code","model":"deepseek-v4-flash","label":"DeepSeek Flash","providerLabel":"DeepSeek API key","effort":null,"vendor":null,"streaming":false,"backup":false}"#
    );
    // The text fields of a route that names nothing read, and write back, as "".
    assert_eq!(
        serde_json::to_string(&TurnEvent::from_value(json!({"type": "route"}))).unwrap(),
        r#"{"type":"route","provider":"","engine":null,"model":null,"label":"","providerLabel":"","effort":null,"vendor":null,"streaming":false,"backup":false}"#
    );

    let usage = TurnEvent::from_value(json!({"type": "usage", "usage": {"input_tokens": 12, "output_tokens": 3}}));
    let TurnEvent::Usage(usage) = usage else {
        panic!("not a usage: {usage:?}")
    };
    // The counts it left out are not there, and are not written back.
    assert_eq!(
        usage.usage,
        Usage {
            input_tokens: Some(12),
            output_tokens: Some(3),
            ..Default::default()
        }
    );
    assert_eq!(
        serde_json::to_string(&TurnEvent::Usage(usage)).unwrap(),
        r#"{"type":"usage","usage":{"input_tokens":12,"output_tokens":3}}"#
    );

    let error = TurnEvent::from_value(
        json!({"type": "error", "message": "The session could not be resumed.", "recoverable": true}),
    );
    let TurnEvent::Error(error) = error else {
        panic!("not an error: {error:?}")
    };
    assert!(error.is_recoverable());
    assert_eq!((error.subtype.as_deref(), error.code()), (None, None));

    // A result that does not say whether it worked did (callers only ask `event.ok === false`).
    let result = TurnEvent::from_value(json!({"type": "tool_result", "id": "t1"}));
    let TurnEvent::ToolResult(result) = result else {
        panic!("not a tool_result: {result:?}")
    };
    assert!(result.ok);
    assert_eq!(result.result, "");

    let tool = TurnEvent::from_value(json!({"type": "tool_use", "id": "t1", "name": "Bash"}));
    let TurnEvent::ToolUse(tool) = tool else {
        panic!("not a tool_use: {tool:?}")
    };
    assert_eq!(tool.input, Value::Null);
}

// --- The engines' events -----------------------------------------------------------------------------------------

#[test]
fn the_claude_engines_tool_round_steps_included() {
    let events = scene(NODE_ENGINES, "claudeToolRound");
    assert_eq!(
        types(&events),
        [
            "step",
            "thinking",
            "step",
            "thinking",
            "step",
            "step",
            "tool_use",
            "step",
            "step",
            "tool_result",
            "text",
            "step",
            "usage",
            "done"
        ]
    );
    let kinds: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            TurnEvent::Step(step) => Some(step.kind.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        kinds,
        ["usage", "thinking", "text", "tool_start", "usage", "tool_end", "status"]
    );

    let TurnEvent::Step(start) = &events[5] else {
        panic!("not a step")
    };
    assert_eq!(start.get("rawName"), Some(&json!("mcp__tarsee__tarsee_datetime")));
    assert_eq!(start.get("name"), Some(&json!("tarsee_datetime")));
    // What the turn layer publishes to the live timeline: the step without its type.
    assert_eq!(
        start.payload().to_string(),
        r#"{"kind":"tool_start","id":"tu1","name":"tarsee_datetime","rawName":"mcp__tarsee__tarsee_datetime","summary":"date","input":"{\n  \"format\": \"date\"\n}"}"#
    );
    let TurnEvent::Step(usage) = &events[0] else {
        panic!("not a step")
    };
    assert_eq!(usage.get("total"), Some(&json!(126)));
    assert_eq!(usage.get("outTps"), Some(&Value::Null), "null stays null");

    let TurnEvent::Usage(usage) = &events[12] else {
        panic!("not a usage")
    };
    assert_eq!((usage.cost_usd, usage.cost_exact), (Some(0.0123), true));
    assert_eq!(usage.usage.context_input_tokens, Some(125));
}

#[test]
fn the_engines_errors_their_flags_and_their_one_done() {
    let last_two = |name: &str| -> (ErrorEvent, DoneEvent) {
        let mut events = scene(NODE_ENGINES, name);
        let (Some(TurnEvent::Done(done)), Some(TurnEvent::Error(error))) = (events.pop(), events.pop()) else {
            panic!("{name} does not end with an error and a done")
        };
        (error, done)
    };

    let (error, done) = last_two("claudeAuthExpired");
    assert_eq!(
        (error.code(), error.status, error.state.as_deref()),
        (Some("expired"), Some(401), Some("sign-in-expired"))
    );
    assert_eq!((error.recoverable, done.reason()), (Some(false), Some("auth-expired")));

    let (error, done) = last_two("claudeMaxTurns");
    assert_eq!(
        (error.subtype.as_deref(), error.code(), done.reason()),
        (Some("error_max_turns"), Some("max_turns"), Some("max_turns"))
    );

    let (error, done) = last_two("claudeBudget");
    assert_eq!(
        (error.subtype.as_deref(), error.code(), done.reason()),
        (Some("error_max_budget_usd"), Some("budget"), Some("budget"))
    );

    // A session the engine could not resume: recoverable, so the turn layer tries once more, fresh.
    let (error, done) = last_two("claudeSessionLost");
    assert!(error.is_recoverable());
    assert_eq!(
        (error.code(), error.status, done.reason()),
        (Some("session"), Some(400), Some("error"))
    );
    let (error, _) = last_two("codexSessionLost");
    assert!(error.is_recoverable());
    assert_eq!(
        (error.code(), error.subtype.as_deref()),
        (Some("session"), Some("session"))
    );

    let (error, done) = last_two("codexMaxTurns");
    assert_eq!(
        (error.subtype.as_deref(), error.code(), done.reason()),
        (Some("error_max_turns"), Some("max_turns"), Some("max_turns"))
    );

    let (error, done) = last_two("codexAuthFailed");
    assert_eq!(
        (error.code(), error.subtype.as_deref(), done.reason()),
        (Some("auth"), Some("auth-expired"), Some("auth-expired"))
    );

    // A stop is one done and no error.
    assert_eq!(scene(NODE_ENGINES, "codexAborted"), vec![TurnEvent::done("aborted")]);
}

#[test]
fn a_codex_turn_in_claude_codes_vocabulary() {
    let events = scene(NODE_ENGINES, "codexTurn");
    let tools: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            TurnEvent::ToolUse(tool) => Some(tool.name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        tools,
        [
            "Bash",
            "mcp__tarsee__tarsee_datetime",
            "Write",
            "Edit",
            "TodoWrite",
            "WebSearch"
        ]
    );
    let TurnEvent::ToolUse(todo) = events
        .iter()
        .find(|e| matches!(e, TurnEvent::ToolUse(t) if t.name == "TodoWrite"))
        .unwrap()
    else {
        unreachable!()
    };
    assert_eq!(
        todo.input["todos"][1],
        json!({"content": "Answer", "status": "pending", "activeForm": "Answer"})
    );
    assert_eq!(events.last().unwrap(), &TurnEvent::done("end_turn"));
    // Codex lists a usage's keys in another order than Claude Code; it is the same object.
    let TurnEvent::Usage(usage) = events.iter().rev().find(|e| matches!(e, TurnEvent::Usage(_))).unwrap() else {
        unreachable!()
    };
    assert_eq!(usage.usage, Usage::new(1000, 80, 200, 0));
}

// --- Steps -------------------------------------------------------------------------------------------------------

#[test]
fn a_step_is_built_field_by_field_in_order_and_made_from_a_live_step() {
    // `ai/turn.js`: `{ type: "step", kind: "status", text }` and the backup model's route step.
    let status = TurnEvent::step(StepEvent::new("status").with(
        "text",
        "Claude plan unavailable (out of credit); answering with DeepSeek Flash",
    ));
    assert_eq!(
        serde_json::to_string(&status).unwrap(),
        r#"{"type":"step","kind":"status","text":"Claude plan unavailable (out of credit); answering with DeepSeek Flash"}"#
    );
    let route = StepEvent::new("route")
        .with("provider", "deepseek")
        .with("engine", "claude-code")
        .with("model", "deepseek-flash")
        .with("label", "DeepSeek Flash")
        .with("streaming", true);
    assert_eq!(
        serde_json::to_string(&TurnEvent::step(route.clone())).unwrap(),
        r#"{"type":"step","kind":"route","provider":"deepseek","engine":"claude-code","model":"deepseek-flash","label":"DeepSeek Flash","streaming":true}"#
    );
    assert_eq!(route.payload()["kind"], "route");
    assert!(route.payload().get("type").is_none());

    // `{ type: "step", ...step }` for a step from lib/tool-steps.js.
    let live = json!({"kind": "tool_end", "id": "t1", "ok": true, "preview": "a"});
    let step = StepEvent::from_value(live.clone()).unwrap();
    assert_eq!(step.kind, "tool_end");
    assert_eq!(step.payload(), live);
    assert_eq!(
        serde_json::to_string(&TurnEvent::step(step)).unwrap(),
        r#"{"type":"step","kind":"tool_end","id":"t1","ok":true,"preview":"a"}"#
    );
    // One that already has its type keeps a single one.
    let typed = StepEvent::from_value(json!({"type": "step", "kind": "text", "text": "Hi"})).unwrap();
    assert_eq!(
        serde_json::to_string(&TurnEvent::step(typed)).unwrap(),
        r#"{"type":"step","kind":"text","text":"Hi"}"#
    );
    assert_eq!(StepEvent::from_value(json!({"text": "no kind"})), None);
    assert_eq!(StepEvent::from_value(json!("words")), None);
}

// --- Messages ----------------------------------------------------------------------------------------------------

#[test]
fn a_message_is_role_and_content_and_its_time_when_the_caller_has_it() {
    assert_eq!(
        serde_json::to_string(&TurnMessage::user("hi")).unwrap(),
        r#"{"role":"user","content":"hi"}"#
    );
    assert_eq!(
        serde_json::to_string(&TurnMessage::assistant("Sure.").at("2026-11-09 10:00:00")).unwrap(),
        r#"{"role":"assistant","content":"Sure.","createdAt":"2026-11-09 10:00:00"}"#
    );
    // ACP's messages carry milliseconds (`ts: Date.now()`).
    assert_eq!(
        serde_json::to_string(&TurnMessage::user("hi").at(1_794_472_200_123_i64)).unwrap(),
        r#"{"role":"user","content":"hi","createdAt":1794472200123}"#
    );
    assert_eq!(TurnMessage::user("hi").content.as_text(), Some("hi"));
    assert_eq!(TurnMessage::default().content, MessageContent::Text(String::new()));
}

/// The external API hands the turn the stored rows as they are (`routes/external-api.js`: `messages: history`).
#[test]
fn a_stored_row_passed_as_it_is_keeps_its_time_and_its_other_columns() {
    let row = json!({
        "id": "5e0d4b9c-0000-4000-8000-000000000001", "conversation_id": "c1", "role": "assistant",
        "content": "Sure.", "provider": "claude", "model": "sonnet", "tokens_in": 12, "tokens_out": 3,
        "created_at": "2026-11-09 10:00:00"
    });
    let message: TurnMessage = serde_json::from_value(row).unwrap();
    assert_eq!(message.role, "assistant");
    assert_eq!(
        message.created_at,
        Some(MessageTime::Text("2026-11-09 10:00:00".into()))
    );
    assert_eq!(message.extra.get("provider"), Some(&json!("claude")));
    assert_eq!(message.extra.get("tokens_in"), Some(&json!(12)));
    assert!(!message.extra.contains_key("created_at") && !message.extra.contains_key("role"));

    let dashboard: TurnMessage =
        serde_json::from_value(json!({"role": "user", "content": "hi", "createdAt": 1794472200123_i64})).unwrap();
    assert_eq!(dashboard.created_at, Some(MessageTime::Millis(1_794_472_200_123)));
    let none: TurnMessage = serde_json::from_value(json!({"role": "user", "content": "hi"})).unwrap();
    assert_eq!(none, TurnMessage::user("hi"));
}

/// The content blocks the channels and the web chat build (`routes/chat.js`, `channels/websocket.js`,
/// `channels/telegram.js`): pictures, PDFs and voice notes as base64, then the words.
#[test]
fn content_blocks_are_the_messages_api_shape() {
    let content: MessageContent = vec![
        ContentBlock::image("image/png", "cG5n"),
        ContentBlock::document("application/pdf", "JVBERg=="),
        ContentBlock::audio("audio/ogg", "T2dnUw=="),
        ContentBlock::text("what is this?"),
    ]
    .into();
    let node = r#"[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"cG5n"}},{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERg=="}},{"type":"audio","source":{"type":"base64","media_type":"audio/ogg","data":"T2dnUw=="}},{"type":"text","text":"what is this?"}]"#;
    assert_eq!(serde_json::to_string(&content).unwrap(), node);
    assert_eq!(serde_json::from_str::<MessageContent>(node).unwrap(), content);

    let blocks = content.as_blocks().unwrap();
    assert_eq!(
        blocks.iter().map(ContentBlock::block_type).collect::<Vec<_>>(),
        ["image", "document", "audio", "text"]
    );
    assert_eq!(
        blocks.iter().map(ContentBlock::is_media).collect::<Vec<_>>(),
        [true, true, true, false]
    );
    assert_eq!(blocks[3].as_text(), Some("what is this?"));
    assert_eq!(blocks[0].as_text(), None);
    assert_eq!(content.as_text(), None);

    let message = TurnMessage::user(content);
    assert!(
        serde_json::to_string(&message)
            .unwrap()
            .starts_with(r#"{"role":"user","content":[{"type":"image""#)
    );
}

#[test]
fn a_block_keeps_what_tarsee_has_no_name_for_and_an_unknown_one_is_kept_whole() {
    // A PDF's name rides on the block or on its source (`ai/media.js` reads `name`, `title` and `source.name`).
    let named = json!({"type": "document", "title": "Q3 report", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBERg==", "name": "q3.pdf"}});
    let block: ContentBlock = serde_json::from_value(named.clone()).unwrap();
    let ContentBlock::Document(media) = &block else {
        panic!("not a document: {block:?}")
    };
    assert_eq!(media.extra.get("title"), Some(&json!("Q3 report")));
    assert_eq!(media.source.extra.get("name"), Some(&json!("q3.pdf")));
    assert_eq!(serde_json::to_value(&block).unwrap(), named);

    // A source with no media type (each reader has its own default for it).
    let bare = json!({"type": "image", "source": {"type": "base64", "data": "cG5n"}});
    let block: ContentBlock = serde_json::from_value(bare.clone()).unwrap();
    let ContentBlock::Image(media) = &block else {
        panic!("not an image: {block:?}")
    };
    assert_eq!(media.source.media_type, None);
    assert_eq!(serde_json::to_value(&block).unwrap(), bare);

    // Not base64 data, or a kind no engine takes: kept, and still media by its type where it says so.
    for (odd, media) in [
        (
            json!({"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}),
            true,
        ),
        (
            json!({"type": "video", "source": {"type": "base64", "data": "AAAA"}}),
            false,
        ),
        (
            json!({"type": "tool_result", "tool_use_id": "t1", "content": "x"}),
            false,
        ),
        (json!("loose words"), false),
    ] {
        let block: ContentBlock = serde_json::from_value(odd.clone()).unwrap();
        assert_eq!(block, ContentBlock::Other(odd.clone()), "{odd}");
        assert_eq!(block.is_media(), media, "{odd}");
        assert_eq!(serde_json::to_value(&block).unwrap(), odd);
    }
    let cached = json!({"type": "text", "text": "hi", "cache_control": {"type": "ephemeral"}});
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<ContentBlock>(cached.clone()).unwrap()).unwrap(),
        cached
    );
}

#[test]
fn the_system_prompts_two_parts() {
    let parts = SystemParts {
        stable: "SOUL".into(),
        volatile: "\n\n## Today".into(),
    };
    assert_eq!(
        serde_json::to_string(&parts).unwrap(),
        r#"{"stable":"SOUL","volatile":"\n\n## Today"}"#
    );
    assert_eq!(
        serde_json::from_value::<SystemParts>(json!({"stable": "SOUL"}))
            .unwrap()
            .volatile,
        ""
    );
}

// --- Options -----------------------------------------------------------------------------------------------------

/// What `ai/turn.js` `runTurn` takes an option left out to mean: nothing chosen, nothing switched on.
#[test]
fn options_start_with_nothing_chosen() {
    let options = TurnOptions::default();
    assert!(options.messages.is_empty());
    assert!(options.provider.is_none() && options.model.is_none() && options.effort.is_none());
    assert!(!options.background && !options.live_disabled && !options.verify);
    assert!(options.system_prompt.is_none() && options.system_parts.is_none());
    assert_eq!(options.tool_ctx, ToolContext::default());
    assert!(options.session_id.is_none() && options.on_session_id.is_none());
    assert!(!options.signal.is_cancelled());
    assert!(options.max_turns.is_none() && options.max_budget_usd.is_none());
    assert!(options.thinking_summaries.is_none() && options.queued_note.is_none());
    assert!(options.live_conversation_id.is_none() && options.live_source.is_none() && options.live_turn_id.is_none());
    assert!(options.engine.is_none() && options.cwd.is_none());
}

#[test]
fn a_copy_of_the_options_shares_the_callers_callback_and_stop() {
    let stored = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let store = stored.clone();
    let options = TurnOptions {
        messages: vec![TurnMessage::user("hi")],
        on_session_id: Some(SessionCallback::new(move |handle| {
            store.lock().push(handle.to_string())
        })),
        ..Default::default()
    };
    let copy = options.clone();
    copy.on_session_id.as_ref().unwrap().call("raw-1");
    options
        .on_session_id
        .as_ref()
        .unwrap()
        .call("deepseek/cc/deepseek:raw-2");
    assert_eq!(*stored.lock(), ["raw-1", "deepseek/cc/deepseek:raw-2"]);
    options.signal.cancel();
    assert!(copy.signal.is_cancelled());
    assert!(format!("{copy:?}").contains("SessionCallback"));
}

// --- The stream --------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_list_of_events_as_a_stream() {
    let events: Vec<_> = stream_of([TurnEvent::text("a"), TurnEvent::done("end_turn")])
        .collect()
        .await;
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].as_ref().unwrap(), &TurnEvent::done("end_turn"));
    assert_eq!(stream_of([]).count().await, 0);
}

#[tokio::test]
async fn a_channel_carries_a_turn_from_its_task_and_ends_when_the_task_does() {
    let (tx, mut stream) = turn_channel(4);
    let task = tokio::spawn(async move {
        tx.send(Ok(TurnEvent::text("one"))).await.unwrap();
        tx.send(Err(anyhow::Error::new(AbortError))).await.unwrap();
    });
    assert_eq!(stream.next().await.unwrap().unwrap(), TurnEvent::text("one"));
    let failed = stream.next().await.unwrap().unwrap_err();
    assert!(failed.is::<AbortError>());
    assert_eq!(failed.to_string(), "This operation was aborted");
    task.await.unwrap();
    assert!(stream.next().await.is_none(), "the sender is gone: the stream ends");
}

#[tokio::test]
async fn sending_fails_once_the_stream_is_dropped_so_the_task_can_stop() {
    let (tx, stream) = turn_channel(1);
    drop(stream);
    assert!(tx.send(Ok(TurnEvent::text("nobody listens"))).await.is_err());
    assert!(tx.is_closed());
}
