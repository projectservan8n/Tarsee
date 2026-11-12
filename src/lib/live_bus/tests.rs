//! Port of the "live bus: the timeline" cases of `test/live-bus.test.js`, and of "a restart closes a line left
//! queued". The "messages" cases are in `db/conversations.rs`, the "Queued line" cases in
//! `lib/conversation_lock.rs`.
use std::sync::atomic::AtomicUsize;

use super::*;
use crate::testkit::{TestApp, test_app};

fn started() -> (TestApp, Arc<LiveBus>) {
    let t = test_app();
    let bus = LiveBus::init(&t.app);
    (t, bus)
}

fn seed(t: &TestApp, conv: &str, turn: Option<&str>, kind: &str, payload: Value, created_at: i64) {
    t.db()
        .with(|c| {
            c.execute(
                "INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
                params![conv, turn, kind, payload.to_string(), created_at],
            )
        })
        .unwrap();
}

fn types(events: &[LiveEvent]) -> Vec<&str> {
    events.iter().map(|e| e.r#type.as_str()).collect()
}

#[test]
fn closes_a_turn_a_restart_left_open_so_nothing_shows_as_working_forever() {
    let t = test_app();
    // A turn that started before a "restart" and never ended.
    seed(
        &t,
        "conv-dead",
        Some("turn-dead"),
        "turn_start",
        json!({ "source": "telegram" }),
        now_ms() - 60_000,
    );
    let bus = LiveBus::init(&t.app);
    let events = bus.events_since("conv-dead", 0, 500);
    let end = events
        .iter()
        .find(|e| e.r#type == "turn_end")
        .expect("a turn_end was published at start-up");
    assert_eq!(end.turn_id.as_deref(), Some("turn-dead"));
    assert_eq!(end.payload["stopReason"], "interrupted");
    assert_eq!(end.payload["note"], "Tarsee restarted during this turn");
    assert_eq!(bus.active_turn_for("conv-dead"), None);
    // A second start finds it closed: nothing more is published.
    let again = LiveBus::init(&t.app);
    assert_eq!(again.events_since("conv-dead", 0, 500).len(), 2);
}

#[test]
fn a_restart_closes_a_line_left_queued() {
    let t = test_app();
    seed(
        &t,
        "conv-q",
        Some("turn-q"),
        "turn_queued",
        json!({ "source": "web" }),
        now_ms() - 1000,
    );
    // One that ended, and one too old to matter, are left alone.
    seed(&t, "conv-ok", Some("turn-ok"), "turn_start", json!({}), now_ms() - 5000);
    seed(&t, "conv-ok", Some("turn-ok"), "turn_end", json!({}), now_ms() - 4000);
    seed(
        &t,
        "conv-old",
        Some("turn-old"),
        "turn_start",
        json!({}),
        now_ms() - 3 * 86_400_000,
    );
    let bus = LiveBus::init(&t.app);
    let ends: Vec<LiveEvent> = bus
        .events_for_turn("turn-q")
        .into_iter()
        .filter(|e| e.r#type == "turn_end")
        .collect();
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].payload["stopReason"], "interrupted");
    assert_eq!(bus.events_for_turn("turn-ok").len(), 2);
    assert_eq!(bus.events_for_turn("turn-old").len(), 1);
}

#[test]
fn numbers_events_in_order_and_replays_everything_after_a_given_seq() {
    let (_t, bus) = started();
    let a = bus
        .publish("c1", "turn_start", json!({ "source": "web" }), Some("t1"))
        .unwrap();
    let b = bus
        .publish(
            "c1",
            "step",
            json!({ "kind": "tool_start", "id": "x", "name": "Bash", "summary": "ls" }),
            Some("t1"),
        )
        .unwrap();
    let c = bus
        .publish("c1", "turn_end", json!({ "stopReason": "end_turn" }), Some("t1"))
        .unwrap();
    assert!(a.seq < b.seq && b.seq < c.seq);
    assert_eq!(types(&bus.events_since("c1", a.seq, 500)), ["step", "turn_end"]);
    assert_eq!(bus.latest_seq(Some("c1")), c.seq);
    assert_eq!(bus.latest_seq(None), c.seq);
    assert_eq!(bus.latest_seq(Some("nobody")), 0);
    assert_eq!(
        bus.events_for_turn("t1").iter().map(|e| e.seq).collect::<Vec<_>>(),
        [a.seq, b.seq, c.seq]
    );
    assert_eq!(types(&bus.recent_events("c1", 2)), ["step", "turn_end"]);
    assert_eq!(bus.events_since("c1", 0, 1).len(), 1);
    // What was read back is what was published.
    assert_eq!(bus.events_since("c1", a.seq, 1), [b]);
}

#[test]
fn an_event_is_written_for_the_browser_with_the_node_field_names() {
    let (_t, bus) = started();
    let evt = bus
        .publish("c1", "turn_start", json!({ "source": "web" }), Some("t1"))
        .unwrap();
    assert_eq!(
        serde_json::to_string(&evt).unwrap(),
        format!(
            r#"{{"seq":{},"conversationId":"c1","turnId":"t1","type":"turn_start","payload":{{"source":"web"}},"createdAt":{}}}"#,
            evt.seq, evt.created_at
        )
    );
    let no_turn = bus
        .publish("c1", "step", json!({ "kind": "text", "text": "hi" }), None)
        .unwrap();
    assert_eq!(serde_json::to_value(&no_turn).unwrap()["turnId"], Value::Null);
}

#[test]
fn knows_the_turn_in_progress_its_steps_and_the_tools_still_running() {
    let (_t, bus) = started();
    bus.publish("c2", "turn_start", json!({ "source": "discord" }), Some("t2"));
    let step = bus
        .publish(
            "c2",
            "step",
            json!({ "kind": "tool_start", "id": "r1", "name": "Read", "summary": "README.md" }),
            Some("t2"),
        )
        .unwrap();
    let t = bus.active_turn_for("c2").unwrap();
    assert_eq!(t.turn_id.as_deref(), Some("t2"));
    assert_eq!(t.source, "discord");
    assert_eq!(
        t.running_tools
            .iter()
            .map(|x| x.id.clone().unwrap())
            .collect::<Vec<_>>(),
        [json!("r1")]
    );
    assert_eq!(t.last_step_label, Some(json!("Read: README.md")));
    assert!(bus.active_turn_list().iter().any(|x| x.conversation_id == "c2"));
    // The snapshot as the page gets it.
    assert_eq!(
        serde_json::to_value(&t).unwrap(),
        json!({
            "conversationId": "c2", "turnId": "t2", "startedAt": t.started_at, "source": "discord", "steps": 1,
            "lastStepAt": step.created_at, "lastStepLabel": "Read: README.md",
            "runningTools": [{ "id": "r1", "name": "Read", "summary": "README.md", "startedAt": step.created_at }],
        })
    );
    bus.publish(
        "c2",
        "step",
        json!({ "kind": "tool_end", "id": "r1", "ok": true }),
        Some("t2"),
    );
    let t = bus.active_turn_for("c2").unwrap();
    assert!(t.running_tools.is_empty());
    assert_eq!(t.steps, 2);
    bus.publish("c2", "turn_end", json!({ "stopReason": "end_turn" }), Some("t2"));
    assert_eq!(bus.active_turn_for("c2"), None);
}

#[test]
fn a_turn_just_started_has_a_null_label_and_a_tool_with_no_summary_is_labelled_by_its_name() {
    let (_t, bus) = started();
    bus.publish("c6", "turn_start", json!({}), Some("t6"));
    let fresh = serde_json::to_value(bus.active_turn_for("c6").unwrap()).unwrap();
    assert_eq!(fresh["lastStepLabel"], Value::Null);
    assert_eq!(fresh["source"], Value::Null);
    assert_eq!(fresh["runningTools"], json!([]));
    bus.publish(
        "c6",
        "step",
        json!({ "kind": "tool_start", "id": "g1", "name": "Glob" }),
        Some("t6"),
    );
    let t = serde_json::to_value(bus.active_turn_for("c6").unwrap()).unwrap();
    assert_eq!(t["lastStepLabel"], "Glob");
    assert_eq!(
        t["runningTools"][0].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["id", "name", "startedAt"]
    );
}

#[test]
fn a_backup_taking_over_a_route_step_names_the_ai_and_is_no_step_of_the_turns() {
    let (_t, bus) = started();
    bus.publish("c5", "turn_start", json!({ "source": "web" }), Some("t5"));
    bus.publish(
        "c5",
        "step",
        json!({ "kind": "route", "label": "DeepSeek Flash", "streaming": true }),
        Some("t5"),
    );
    bus.publish("c5", "step", json!({ "kind": "usage", "total": 10 }), Some("t5"));
    assert_eq!(bus.active_turn_for("c5").unwrap().steps, 0);
    bus.publish("c5", "turn_end", json!({ "stopReason": "end_turn" }), Some("t5"));
}

#[test]
fn caps_long_strings_in_a_step_and_pushes_every_event_to_subscribers() {
    let (_t, bus) = started();
    let seen = Arc::new(Mutex::new(Vec::<LiveEvent>::new()));
    let sink = seen.clone();
    let off = bus.on_event(move |e| sink.lock().push(e.clone()));
    let evt = bus
        .publish(
            "c3",
            "step",
            json!({ "kind": "text", "text": "x".repeat(20_000) }),
            None,
        )
        .unwrap();
    off.off();
    let text = evt.payload["text"].as_str().unwrap();
    assert!(utf16_len(text) < 9000);
    assert_eq!(utf16_len(text), 8001);
    assert!(text.ends_with('…'));
    assert_eq!(seen.lock().len(), 1);
    assert_eq!(seen.lock()[0].seq, evt.seq);
    bus.publish(
        "c3",
        "step",
        json!({ "kind": "text", "text": "after unsubscribe" }),
        None,
    );
    assert_eq!(seen.lock().len(), 1);
}

#[test]
fn strings_are_capped_five_levels_down_and_lists_cut_to_fifty() {
    let long = "y".repeat(9000);
    let capped = cap_strings(
        json!({
            "list": (0..60).collect::<Vec<_>>(),
            "a": { "b": { "c": { "d": { "kept": long.clone(), "e": { "deep": long.clone(), "text": long.clone() } } } } },
        }),
        0,
    );
    assert_eq!(capped["list"].as_array().unwrap().len(), 50);
    // (depth 4: its strings are capped; the object below it is kept as it is)
    assert_eq!(utf16_len(capped["a"]["b"]["c"]["d"]["kept"].as_str().unwrap()), 8001);
    assert_eq!(
        utf16_len(capped["a"]["b"]["c"]["d"]["e"]["deep"].as_str().unwrap()),
        9000
    );
    // A cut never leaves half an emoji.
    let emoji = cap_strings(json!(format!("a{}", "🐒".repeat(4000))), 0);
    assert_eq!(emoji, json!(format!("a{}…", "🐒".repeat(3999))));
}

#[test]
fn two_turns_overlapping_in_one_conversation_the_first_ones_end_leaves_the_other_running() {
    let (_t, bus) = started();
    bus.publish("c4", "turn_start", json!({ "source": "web" }), Some("a"));
    bus.publish("c4", "turn_start", json!({ "source": "api" }), Some("b"));
    bus.publish("c4", "turn_end", json!({ "stopReason": "end_turn" }), Some("a"));
    assert_eq!(bus.active_turn_for("c4").unwrap().turn_id.as_deref(), Some("b"));
    bus.publish(
        "c4",
        "step",
        json!({ "kind": "tool_start", "id": "s1", "name": "Read" }),
        Some("a"),
    );
    assert_eq!(
        bus.active_turn_for("c4").unwrap().steps,
        0,
        "a step of the turn that ended is not this one's"
    );
    bus.publish("c4", "turn_end", json!({ "stopReason": "end_turn" }), Some("b"));
    assert_eq!(bus.active_turn_for("c4"), None);
}

#[test]
fn never_throws_and_does_nothing_without_a_conversation_id() {
    let (t, bus) = started();
    assert_eq!(bus.publish("", "step", json!({}), None), None);
    assert_eq!(bus.publish("c", "", json!({}), None), None);
    assert_eq!(bus.latest_seq(None), 0);
    // Nor once the database is closed (shutdown).
    t.db().close();
    assert_eq!(bus.publish("c", "step", json!({}), None), None);
    assert!(bus.events_since("c", 0, 500).is_empty());
    assert_eq!(bus.latest_seq(Some("c")), 0);
    assert_eq!(bus.forget_conversation("c"), 0);
    assert!(!bus.has_client_msg_id("c", "x"));
    bus.prune();
}

#[test]
fn the_functions_by_their_js_names_do_nothing_until_the_bus_is_started() {
    let t = test_app();
    assert_eq!(publish(&t.app, "c", "step", json!({}), None), None);
    assert!(events_since(&t.app, "c", 0, 500).is_empty());
    assert!(recent_events(&t.app, "c", 200).is_empty());
    assert!(events_for_turn(&t.app, "t").is_empty());
    assert_eq!(latest_seq(&t.app, None), 0);
    assert_eq!(active_turn_for(&t.app, "c"), None);
    assert!(active_turn_list(&t.app).is_empty());
    assert!(queued_turn_list(&t.app, None).is_empty());
    assert!(recent_client_msg_ids(&t.app, "c", CLIENT_MSG_IDS_SINCE_MS).is_empty());
    assert_eq!(forget_conversation(&t.app, "c"), 0);
    assert_eq!(forget_message(&t.app, "c", "m"), 0);
    assert!(!has_client_msg_id(&t.app, "c", "x"));
    let message = TimelineMessage {
        id: "m",
        role: "user",
        content: "hi",
    };
    assert_eq!(publish_message(&t.app, "c", message, &Map::new()), None);

    init_live_bus(&t.app);
    let evt = publish(&t.app, "c", "turn_start", json!({}), Some("t")).unwrap();
    assert_eq!(events_since(&t.app, "c", 0, 500), std::slice::from_ref(&evt));
    assert_eq!(recent_events(&t.app, "c", 200), std::slice::from_ref(&evt));
    assert_eq!(events_for_turn(&t.app, "t"), std::slice::from_ref(&evt));
    assert_eq!(latest_seq(&t.app, Some("c")), evt.seq);
    assert_eq!(active_turn_for(&t.app, "c").unwrap().turn_id.as_deref(), Some("t"));
    assert_eq!(active_turn_list(&t.app).len(), 1);
    let said = publish_message(&t.app, "c", message, &Map::new()).unwrap();
    assert_eq!(
        said.payload,
        json!({ "id": "m", "role": "user", "content": "hi", "truncated": false })
    );
    assert_eq!(forget_message(&t.app, "c", "m"), 1);
    assert_eq!(forget_conversation(&t.app, "c"), 1);
    assert_eq!(new_turn_id().len(), 36);
    assert_ne!(new_turn_id(), new_turn_id());
}

#[test]
fn a_message_event_carries_the_clean_words_the_tabs_id_and_its_turn() {
    let (_t, bus) = started();
    let mut extra = Map::new();
    extra.insert("clientMsgId".into(), json!("tab-1"));
    extra.insert("turnId".into(), json!("t9"));
    let evt = bus
        .publish_message(
            "c7",
            TimelineMessage {
                id: "m1",
                role: "assistant",
                content: "  hi <tool_call>{\"name\":\"Bash\"}</tool_call>\n\n\n\nthere <tool_response>out</tool_response> ",
            },
            &extra,
        )
        .unwrap();
    assert_eq!(evt.r#type, "message");
    assert_eq!(evt.turn_id.as_deref(), Some("t9"));
    assert_eq!(
        evt.payload.to_string(),
        r#"{"id":"m1","role":"assistant","content":"hi \n\nthere","truncated":false,"clientMsgId":"tab-1","turnId":"t9"}"#
    );
    // A message is no step: the turn in progress does not count it.
    bus.publish("c7", "turn_start", json!({}), Some("t9"));
    bus.publish_message(
        "c7",
        TimelineMessage {
            id: "m2",
            role: "user",
            content: "x",
        },
        &Map::new(),
    );
    assert_eq!(bus.active_turn_for("c7").unwrap().steps, 0);
    assert!(bus.has_client_msg_id("c7", "tab-1"));
    assert!(!bus.has_client_msg_id("c7", "tab-2"));
    assert_eq!(
        bus.recent_client_msg_ids("c7", CLIENT_MSG_IDS_SINCE_MS),
        [json!("tab-1")]
    );
    // The whole of a long message is kept, up to 200,000 characters.
    let long = "word ".repeat(50_000);
    let big = bus
        .publish_message(
            "c7",
            TimelineMessage {
                id: "m3",
                role: "assistant",
                content: &long,
            },
            &Map::new(),
        )
        .unwrap();
    assert_eq!(big.payload["truncated"], true);
    assert_eq!(utf16_len(big.payload["content"].as_str().unwrap()), 200_000);
    assert_eq!(tidy_message_text("a\n\n\n\nb"), "a\n\nb");
}

#[test]
fn turns_waiting_are_listed_oldest_first_until_they_start_or_end() {
    let (_t, bus) = started();
    bus.publish("q1", "turn_queued", json!({ "source": "web" }), Some("w1"));
    bus.publish("q2", "turn_queued", json!({}), Some("w2"));
    bus.publish("q1", "turn_queued", json!({ "source": "telegram" }), Some("w3"));
    let all = bus.queued_turn_list(None);
    assert_eq!(
        all.iter().map(|q| q.turn_id.as_deref().unwrap()).collect::<Vec<_>>(),
        ["w1", "w3", "w2"]
    );
    assert_eq!(
        serde_json::to_value(&bus.queued_turn_list(Some("q2"))[0]).unwrap(),
        json!({ "conversationId": "q2", "turnId": "w2", "queuedAt": all[2].queued_at, "source": null })
    );
    bus.publish("q1", "turn_start", json!({}), Some("w1"));
    bus.publish("q1", "turn_end", json!({ "stopReason": "removed" }), Some("w3"));
    assert!(bus.queued_turn_list(Some("q1")).is_empty());
    // The end of a queued turn leaves the running one running.
    assert_eq!(bus.active_turn_for("q1").unwrap().turn_id.as_deref(), Some("w1"));
    assert_eq!(bus.queued_turn_list(None).len(), 1);
}

#[test]
fn events_older_than_the_retention_time_are_pruned() {
    let t = test_app_with_retention("2");
    seed(&t, "old", None, "step", json!({}), now_ms() - 3 * 86_400_000);
    seed(&t, "new", None, "step", json!({}), now_ms() - 86_400_000);
    let bus = LiveBus::init(&t.app);
    assert!(bus.events_since("old", 0, 500).is_empty());
    assert_eq!(bus.events_since("new", 0, 500).len(), 1);
    // Unset, blank or not a number: 14 days.
    for (value, kept) in [("", 1), ("abc", 1), ("0", 1), ("0.5", 0)] {
        let t = test_app_with_retention(value);
        seed(&t, "c", None, "step", json!({}), now_ms() - 86_400_000);
        let bus = LiveBus::init(&t.app);
        assert_eq!(bus.events_since("c", 0, 500).len(), kept, "{value:?}");
    }
}

fn test_app_with_retention(days: &str) -> TestApp {
    crate::testkit::test_app_with_env([("TARSEE_EVENT_RETENTION_DAYS", days)])
}

#[tokio::test(start_paused = true)]
async fn pruning_runs_every_hour_until_the_bus_is_stopped() {
    let t = test_app_with_retention("1");
    let bus = LiveBus::init(&t.app);
    seed(&t, "c", None, "step", json!({}), now_ms() - 2 * 86_400_000);
    assert_eq!(
        bus.events_since("c", 0, 500).len(),
        1,
        "not pruned until the hour is up"
    );
    tokio::time::sleep(Duration::from_secs(60 * 60 + 1)).await;
    assert!(bus.events_since("c", 0, 500).is_empty());

    bus.stop();
    seed(&t, "c", None, "step", json!({}), now_ms() - 2 * 86_400_000);
    tokio::time::sleep(Duration::from_secs(2 * 60 * 60)).await;
    assert_eq!(
        bus.events_since("c", 0, 500).len(),
        1,
        "stopped: nothing prunes any more"
    );
}

#[test]
fn a_listener_may_publish_and_read_the_database_and_still_sees_everything_in_order() {
    let (t, bus) = started();
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = seen.clone();
    let again = Arc::downgrade(&bus);
    let db = t.db().clone();
    bus.on_event(move |e| {
        let count: i64 = db
            .with(|c| c.query_row("SELECT count(*) FROM conversation_events", [], |r| r.get(0)))
            .unwrap();
        sink.lock().push(format!("{}:{count}", e.r#type));
        if e.r#type == "turn_start" {
            let bus = again.upgrade().unwrap();
            bus.publish("c", "step", json!({ "kind": "text" }), None);
            bus.publish("c", "files", json!({}), None);
        }
    });
    let second = Arc::new(Mutex::new(Vec::<i64>::new()));
    let sink = second.clone();
    bus.on_event(move |e| sink.lock().push(e.seq));
    bus.publish("c", "turn_start", json!({}), Some("t"));
    bus.publish("c", "turn_end", json!({}), Some("t"));
    // What the first listener published reached both listeners after the event in hand, in order. (Both of its
    // events were written before either was delivered: the count is 3 by then.)
    assert_eq!(*seen.lock(), ["turn_start:1", "step:3", "files:3", "turn_end:4"]);
    assert_eq!(*second.lock(), [1, 2, 3, 4]);
}

#[test]
fn publishers_on_many_threads_reach_every_listener_in_sequence_order_and_lose_nothing() {
    let (_t, bus) = started();
    let seen = Arc::new(Mutex::new(Vec::<i64>::new()));
    let sink = seen.clone();
    bus.on_event(move |e| sink.lock().push(e.seq));
    let published = Arc::new(AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for worker in 0..8 {
            let bus = bus.clone();
            let published = published.clone();
            scope.spawn(move || {
                for n in 0..50 {
                    if bus
                        .publish(&format!("c{worker}"), "step", json!({ "kind": "text", "n": n }), None)
                        .is_some()
                    {
                        published.fetch_add(1, Ordering::SeqCst);
                    }
                }
            });
        }
    });
    assert_eq!(published.load(Ordering::SeqCst), 400);
    let seen = seen.lock();
    assert_eq!(seen.len(), 400, "every event reached the listener");
    assert!(seen.windows(2).all(|pair| pair[0] < pair[1]), "in sequence order");
}

#[tokio::test]
async fn a_subscribed_channel_gets_every_event_and_ends_its_subscription_when_dropped() {
    let (_t, bus) = started();
    let mut rx = bus.subscribe();
    for n in 0..300 {
        bus.publish("c", "step", json!({ "n": n }), None);
    }
    // Nothing was read meanwhile, and nothing was dropped.
    for n in 0..300 {
        assert_eq!(rx.recv().await.unwrap().payload["n"], n);
    }
    drop(rx);
    bus.publish("c", "step", json!({}), None);
    assert!(bus.listeners.list.lock().is_empty());
}

#[test]
fn a_payload_the_node_version_stored_with_half_an_emoji_still_reads() {
    let (t, bus) = started();
    t.db()
        .with(|c| {
            c.execute(
                "INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES ('c', NULL, 'step', ?, 1)",
                [r#"{"kind":"text","text":"cut \ud83d…"}"#],
            )?;
            c.execute(
                "INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES ('c', NULL, 'step', 'not json', 2)",
                [],
            )
        })
        .unwrap();
    let events = bus.events_since("c", 0, 500);
    assert_eq!(events[0].payload, json!({ "kind": "text", "text": "cut …" }));
    assert_eq!(events[1].payload, json!({}));
}
