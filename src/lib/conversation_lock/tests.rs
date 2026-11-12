//! Port of `test/conversation-lock.test.js` and of the "Queued line" cases of `test/live-bus.test.js`, and the
//! cases the Rust version needs that the JS could not have: a turn that panics, a turn whose future is dropped,
//! and turns arriving on several threads at once.

use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::Notify;

use super::*;
use crate::lib::live_bus::LiveBus;
use crate::testkit::{TestApp, test_app};

type Never = Infallible;

fn plain() -> TurnOptions {
    TurnOptions::default()
}

fn live(source: &str, prompt: &str) -> TurnOptions {
    TurnOptions {
        live: Some(LiveQueue {
            source: Some(source.to_string()),
            prompt: prompt.to_string(),
            ..LiveQueue::default()
        }),
        ..TurnOptions::default()
    }
}

fn with_bus() -> (TestApp, Arc<LiveBus>) {
    let t = test_app();
    let bus = LiveBus::init(&t.app);
    (t, bus)
}

/// A gate a turn waits at until the test opens it.
#[derive(Clone, Default)]
struct Gate(Arc<(AtomicBool, Notify)>);

impl Gate {
    fn open(&self) {
        self.0.0.store(true, Ordering::SeqCst);
        self.0.1.notify_waiters();
    }

    async fn passed(&self) {
        loop {
            let opened = self.0.1.notified();
            tokio::pin!(opened);
            // Listening before looking, so an opening in between is not missed.
            opened.as_mut().enable();
            if self.0.0.load(Ordering::SeqCst) {
                return;
            }
            opened.await;
        }
    }
}

/// The events of one turn in one conversation: (type, stopReason).
fn of(bus: &LiveBus, conv: &str, turn_id: &str) -> Vec<(String, Option<String>)> {
    bus.events_for_turn(turn_id)
        .into_iter()
        .filter(|e| e.conversation_id == conv)
        .map(|e| {
            let reason = e.payload.get("stopReason").and_then(Value::as_str).map(String::from);
            (e.r#type, reason)
        })
        .collect()
}

fn evt(kind: &str, reason: Option<&str>) -> (String, Option<String>) {
    (kind.to_string(), reason.map(String::from))
}

/// A turn that panics.
fn broke(what: &str) -> Result<(), Never> {
    panic!("{what}")
}

// ── test/conversation-lock.test.js ───────────────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn runs_turns_for_one_conversation_strictly_in_order_never_overlapping() {
    let t = test_app();
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let concurrent = Arc::new(AtomicUsize::new(0));
    let max_concurrent = Arc::new(AtomicUsize::new(0));

    let turn = |name: &'static str, ms: u64| {
        let (events, concurrent, max_concurrent) = (events.clone(), concurrent.clone(), max_concurrent.clone());
        with_conversation_turn(&t.app, Some("conv-1"), plain(), move || async move {
            let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
            max_concurrent.fetch_max(now, Ordering::SeqCst);
            events.lock().push(format!("{name}:start"));
            tokio::time::sleep(Duration::from_millis(ms)).await;
            events.lock().push(format!("{name}:end"));
            concurrent.fetch_sub(1, Ordering::SeqCst);
            Ok::<_, Never>(name)
        })
    };

    // Start a slow turn, then a fast one — the fast one must still wait. (It is polled first here: the order is
    // the order they were started in, not the order they are awaited in.)
    let a = turn("a", 30);
    let b = turn("b", 1);
    let (b, a) = tokio::join!(b, a);
    assert_eq!((a, b), (Ok(Turn::Ran("a")), Ok(Turn::Ran("b"))));
    assert_eq!(
        max_concurrent.load(Ordering::SeqCst),
        1,
        "two turns ran at once on one conversation"
    );
    assert_eq!(*events.lock(), ["a:start", "a:end", "b:start", "b:end"]);
}

#[tokio::test(start_paused = true)]
async fn does_not_serialize_across_different_conversations() {
    let t = test_app();
    let concurrent = Arc::new(AtomicUsize::new(0));
    let max_concurrent = Arc::new(AtomicUsize::new(0));
    let turn = |conv: &str| {
        let (concurrent, max_concurrent) = (concurrent.clone(), max_concurrent.clone());
        with_conversation_turn(&t.app, Some(conv), plain(), move || async move {
            let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
            max_concurrent.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;
            concurrent.fetch_sub(1, Ordering::SeqCst);
            Ok::<_, Never>(())
        })
    };
    let _ = tokio::join!(turn("a"), turn("b"), turn("c"));
    // A slow Telegram group must never block Discord.
    assert_eq!(max_concurrent.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn keeps_draining_the_queue_after_a_turn_throws() {
    let t = test_app();
    let boom = with_conversation_turn(&t.app, Some("conv-1"), plain(), || async {
        Err::<(), _>(anyhow::anyhow!("turn failed"))
    })
    .await;
    assert_eq!(boom.unwrap_err().to_string(), "turn failed");

    // The next turn must still run: one failed reply cannot wedge a chat.
    let after = with_conversation_turn(&t.app, Some("conv-1"), plain(), || async { Ok::<_, Never>("ok") }).await;
    assert_eq!(after, Ok(Turn::Ran("ok")));
}

#[tokio::test]
async fn propagates_the_result_and_the_error_to_the_caller() {
    let t = test_app();
    assert_eq!(
        with_conversation_turn(&t.app, Some("c"), plain(), || async { Ok::<_, Never>(42) }).await,
        Ok(Turn::Ran(42))
    );
    let failed = with_conversation_turn(&t.app, Some("c"), plain(), || async { Err::<(), _>("nope") }).await;
    assert_eq!(failed, Err("nope"));
}

#[tokio::test(start_paused = true)]
async fn reports_how_many_turns_are_ahead_when_it_has_to_wait() {
    let t = test_app();
    let queued_at = Arc::new(Mutex::new(Vec::<usize>::new()));
    let opts = || {
        let queued_at = queued_at.clone();
        TurnOptions {
            on_queued: Some(Box::new(move |ahead| queued_at.lock().push(ahead))),
            ..TurnOptions::default()
        }
    };
    let slow = with_conversation_turn(&t.app, Some("conv-1"), opts(), || async {
        tokio::time::sleep(Duration::from_millis(5)).await;
        Ok::<_, Never>("1")
    });
    let second = with_conversation_turn(&t.app, Some("conv-1"), opts(), || async { Ok::<_, Never>("2") });
    let third = with_conversation_turn(&t.app, Some("conv-1"), opts(), || async { Ok::<_, Never>("3") });
    // The first did not wait; the others each saw someone ahead of them (told as they arrived, before anything
    // was awaited).
    assert_eq!(*queued_at.lock(), [1, 2]);
    assert_eq!(queue_depth(&t.app, "conv-1"), 3);
    let done = tokio::join!(slow, second, third);
    assert_eq!(done, (Ok(Turn::Ran("1")), Ok(Turn::Ran("2")), Ok(Turn::Ran("3"))));
    assert_eq!(*queued_at.lock(), [1, 2]);
}

#[tokio::test]
async fn releases_state_once_the_conversation_goes_idle() {
    let t = test_app();
    let _ = with_conversation_turn(&t.app, Some("conv-1"), plain(), || async { Ok::<_, Never>("done") }).await;
    assert_eq!(queue_depth(&t.app, "conv-1"), 0);
    assert!(ConversationLocks::of(&t.app).state.lock().queues.is_empty());
}

#[tokio::test]
async fn runs_immediately_when_there_is_no_conversation_id() {
    let t = test_app();
    assert_eq!(
        with_conversation_turn(&t.app, None, plain(), || async { Ok::<_, Never>("anon") }).await,
        Ok(Turn::Ran("anon"))
    );
    assert_eq!(
        with_conversation_turn(&t.app, Some(""), plain(), || async { Ok::<_, Never>("blank") }).await,
        Ok(Turn::Ran("blank"))
    );
    assert!(ConversationLocks::of(&t.app).state.lock().queues.is_empty());
}

// ── test/live-bus.test.js: "the Queued line: a message waiting behind the running turn" ──────────────────────────

#[tokio::test]
async fn goes_on_the_timeline_as_queued_and_the_provider_that_begins_it_keeps_its_id_the_same_line_starts() {
    let (t, bus) = with_bus();
    let g = Gate::default();
    let gate = g.clone();
    let a = with_conversation_turn(&t.app, Some("q-1"), live("web", "first"), move || async move {
        gate.passed().await;
        Ok::<_, Never>(())
    });
    let b = with_conversation_turn(&t.app, Some("q-1"), live("web", "second"), || async {
        let claimed = claim_queued_turn(Some("q-1"));
        let second = claim_queued_turn(Some("q-1"));
        Ok::<_, Never>((claimed, second))
    });
    let waiting = bus.queued_turn_list(Some("q-1"));
    assert_eq!(waiting.len(), 1, "only the one that waits: the first turn never queued");
    assert_eq!(waiting[0].source, "web");
    g.open();
    let (_, b) = tokio::join!(a, b);
    let (claimed, second) = b.unwrap().ran().unwrap();
    assert_eq!(claimed, waiting[0].turn_id);
    assert_eq!(second, None, "a second turn in the same slot gets an id of its own");
    assert_eq!(
        of(&bus, "q-1", &claimed.unwrap()),
        [evt("turn_queued", None)],
        "the provider publishes its start and end, not the lock"
    );
}

#[tokio::test]
async fn a_slot_no_provider_claims_a_command_answered_a_failure_first_ends_its_line() {
    let (t, bus) = with_bus();
    let g = Gate::default();
    let gate = g.clone();
    let a = with_conversation_turn(&t.app, Some("q-2"), plain(), move || async move {
        gate.passed().await;
        Ok::<_, Never>(())
    });
    let b = with_conversation_turn(&t.app, Some("q-2"), live("telegram", "/help"), || async {
        Ok::<_, Never>(current_queued_turn().unwrap().turn_id.clone())
    });
    g.open();
    let (_, id) = tokio::join!(a, b);
    let id = id.unwrap().ran().unwrap();
    assert_eq!(
        of(&bus, "q-2", &id),
        [evt("turn_queued", None), evt("turn_end", Some("ended"))]
    );
    assert_eq!(bus.queued_turn_list(Some("q-2")).len(), 0);
}

#[tokio::test]
async fn a_slot_that_fails_before_anything_begins_ends_its_line_as_failed_and_the_caller_still_gets_the_error() {
    let (t, bus) = with_bus();
    let g = Gate::default();
    let gate = g.clone();
    let a = with_conversation_turn(&t.app, Some("q-5"), plain(), move || async move {
        gate.passed().await;
        Ok::<_, Never>(())
    });
    let id = Arc::new(Mutex::new(String::new()));
    let seen = id.clone();
    let b = with_conversation_turn(&t.app, Some("q-5"), live("web", "x"), move || async move {
        *seen.lock() = current_queued_turn().unwrap().turn_id.clone();
        Err::<(), _>(anyhow::anyhow!("no provider"))
    });
    g.open();
    let (a, b) = tokio::join!(a, b);
    assert_eq!(a, Ok(Turn::Ran(())));
    assert_eq!(b.unwrap_err().to_string(), "no provider");
    let events = bus.events_for_turn(&id.lock());
    let end = events.iter().find(|e| e.r#type == "turn_end").unwrap();
    assert_eq!(
        end.payload,
        json!({ "stopReason": "error", "error": "It could not start" })
    );
}

#[tokio::test]
async fn its_stop_takes_it_out_alone_it_never_runs_its_line_ends_at_once_the_turn_ahead_goes_on() {
    let (t, bus) = with_bus();
    let g = Gate::default();
    let gate = g.clone();
    let a_done = Arc::new(AtomicBool::new(false));
    let done = a_done.clone();
    let a = with_conversation_turn(&t.app, Some("q-3"), plain(), move || async move {
        gate.passed().await;
        done.store(true, Ordering::SeqCst);
        Ok::<_, Never>(())
    });
    let ran = Arc::new(AtomicBool::new(false));
    let removed_called = Arc::new(AtomicBool::new(false));
    let (did_run, was_removed) = (ran.clone(), removed_called.clone());
    let opts = TurnOptions {
        live: Some(LiveQueue {
            source: Some("web".into()),
            prompt: "never mind".into(),
            on_removed: Some(Box::new(move || was_removed.store(true, Ordering::SeqCst))),
            ..LiveQueue::default()
        }),
        ..TurnOptions::default()
    };
    let b = with_conversation_turn(&t.app, Some("q-3"), opts, move || async move {
        did_run.store(true, Ordering::SeqCst);
        Ok::<_, Never>(())
    });
    let id = bus.queued_turn_list(Some("q-3"))[0].turn_id.clone().unwrap();
    assert!(
        !remove_queued_turn(&t.app, &id, Some("another-chat")),
        "only from its own chat"
    );
    assert!(remove_queued_turn(&t.app, &id, Some("q-3")));
    assert!(removed_called.load(Ordering::SeqCst));
    assert_eq!(
        of(&bus, "q-3", &id),
        [evt("turn_queued", None), evt("turn_end", Some("removed"))],
        "ended at once, before the turn ahead"
    );
    assert!(!remove_queued_turn(&t.app, &id, Some("q-3")), "once");
    assert_eq!(queue_depth(&t.app, "q-3"), 2, "it keeps its place until its slot comes");
    g.open();
    let (b, a) = tokio::join!(b, a);
    assert_eq!(b, Ok(Turn::QueueRemoved));
    assert!(b.unwrap().is_queue_removed());
    assert_eq!(a, Ok(Turn::Ran(())));
    assert!(!ran.load(Ordering::SeqCst));
    assert!(a_done.load(Ordering::SeqCst));
    assert_eq!(of(&bus, "q-3", &id).len(), 2, "nothing more was said of it");
    assert_eq!(queue_depth(&t.app, "q-3"), 0);
}

#[tokio::test]
async fn a_turn_whose_slot_has_come_is_no_longer_in_the_queue_stop_it_as_the_running_turn() {
    let (t, _bus) = with_bus();
    let g = Gate::default();
    let a = with_conversation_turn(&t.app, Some("q-4"), plain(), || async { Ok::<_, Never>(()) });
    let app = t.app.clone();
    let (gate, at_gate) = (g.clone(), Arc::new(Notify::new()));
    let reached = at_gate.clone();
    let b = tokio::spawn(with_conversation_turn(
        &t.app,
        Some("q-4"),
        live("web", "x"),
        move || async move {
            let id = current_queued_turn().unwrap().turn_id.clone();
            // (Neither by its id nor on the turn itself.)
            let removable = remove_queued_turn(&app, &id, Some("q-4")) || current_queued_turn().unwrap().remove();
            reached.notify_one();
            gate.passed().await;
            Ok::<_, Never>(removable)
        },
    ));
    assert_eq!(a.await, Ok(Turn::Ran(())));
    at_gate.notified().await;
    g.open();
    assert_eq!(b.await.unwrap(), Ok(Turn::Ran(false)));
}

// ── Two things at once, and holders that fail: what the plan asks this package to pin ────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_messages_arriving_together_for_one_conversation_never_run_at_once_and_none_is_lost() {
    let (t, bus) = with_bus();
    let concurrent = Arc::new(AtomicUsize::new(0));
    let max_concurrent = Arc::new(AtomicUsize::new(0));
    let ran = Arc::new(Mutex::new(Vec::<usize>::new()));
    let store = crate::db::conversations::ConversationStore::new(&t.app);
    let conv = store.create(Default::default()).unwrap().id;
    let start = Arc::new(tokio::sync::Barrier::new(24));
    let mut tasks = Vec::new();
    for n in 0..24 {
        let (app, conv, start) = (t.app.clone(), conv.clone(), start.clone());
        let (concurrent, max_concurrent, ran, store) =
            (concurrent.clone(), max_concurrent.clone(), ran.clone(), store.clone());
        tasks.push(tokio::spawn(async move {
            start.wait().await;
            with_conversation_turn(&app, Some(&conv), live("web", "hi"), || async {
                let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                max_concurrent.fetch_max(now, Ordering::SeqCst);
                // What a turn does while it holds the slot: the database and the live timeline, and awaits.
                store.add_message(&conv, crate::db::conversations::NewMessage::user(format!("m{n}")))?;
                tokio::task::yield_now().await;
                publish(&app, &conv, "step", json!({ "kind": "text", "text": n }), None);
                tokio::task::yield_now().await;
                ran.lock().push(n);
                concurrent.fetch_sub(1, Ordering::SeqCst);
                Ok::<_, rusqlite::Error>(n)
            })
            .await
        }));
    }
    for (n, task) in tasks.into_iter().enumerate() {
        assert_eq!(task.await.unwrap(), Ok(Turn::Ran(n)));
    }
    assert_eq!(
        max_concurrent.load(Ordering::SeqCst),
        1,
        "two turns ran at once on one conversation"
    );
    assert_eq!(ran.lock().len(), 24, "every message got its turn");
    assert_eq!(store.message_count(&conv), 24);
    assert_eq!(queue_depth(&t.app, &conv), 0);
    assert!(bus.queued_turn_list(None).is_empty(), "no line left queued");
    // Every turn that waited ended its line itself (no provider claimed any here).
    let queued = bus
        .events_since(&conv, 0, 1000)
        .into_iter()
        .filter(|e| e.r#type == "turn_queued")
        .count();
    let ended = bus
        .events_since(&conv, 0, 1000)
        .into_iter()
        .filter(|e| e.r#type == "turn_end")
        .count();
    assert_eq!(queued, ended);
    assert!(ConversationLocks::of(&t.app).state.lock().waiting.is_empty());
}

#[tokio::test]
async fn turns_run_in_the_order_they_arrived_however_they_are_awaited() {
    let t = test_app();
    let order = Arc::new(Mutex::new(Vec::<usize>::new()));
    let turns: Vec<_> = (0..6)
        .map(|n| {
            let order = order.clone();
            with_conversation_turn(&t.app, Some("c"), plain(), move || async move {
                tokio::task::yield_now().await;
                order.lock().push(n);
                Ok::<_, Never>(())
            })
        })
        .collect();
    // Awaited last to first.
    let mut tasks: Vec<_> = turns.into_iter().rev().map(tokio::spawn).collect();
    for task in tasks.drain(..) {
        task.await.unwrap().unwrap();
    }
    assert_eq!(*order.lock(), [0, 1, 2, 3, 4, 5]);
}

#[tokio::test]
async fn a_holder_that_panics_lets_the_next_turn_run_and_a_queued_one_that_panics_ends_its_line_as_failed() {
    let (t, bus) = with_bus();
    let g = Gate::default();
    let gate = g.clone();
    let holder = tokio::spawn(with_conversation_turn(
        &t.app,
        Some("p-1"),
        plain(),
        move || async move {
            gate.passed().await;
            broke("the holder broke")
        },
    ));
    let queued = tokio::spawn(with_conversation_turn(
        &t.app,
        Some("p-1"),
        live("web", "second"),
        || async { broke("the queued one broke too") },
    ));
    let last = with_conversation_turn(&t.app, Some("p-1"), live("web", "third"), || async {
        Ok::<_, Never>("ran")
    });
    let lines: Vec<String> = bus
        .queued_turn_list(Some("p-1"))
        .into_iter()
        .filter_map(|q| q.turn_id)
        .collect();
    assert_eq!(lines.len(), 2);
    g.open();
    assert!(holder.await.unwrap_err().is_panic());
    assert!(queued.await.unwrap_err().is_panic());
    assert_eq!(last.await, Ok(Turn::Ran("ran")));
    assert_eq!(
        of(&bus, "p-1", &lines[0]),
        [evt("turn_queued", None), evt("turn_end", Some("error"))]
    );
    assert_eq!(
        of(&bus, "p-1", &lines[1]),
        [evt("turn_queued", None), evt("turn_end", Some("ended"))]
    );
    assert_eq!(queue_depth(&t.app, "p-1"), 0);
}

#[tokio::test]
async fn a_turn_dropped_while_it_runs_gives_the_slot_back() {
    let (t, bus) = with_bus();
    let started = Arc::new(Notify::new());
    let reached = started.clone();
    let holder = tokio::spawn(with_conversation_turn(
        &t.app,
        Some("d-1"),
        plain(),
        move || async move {
            reached.notify_one();
            std::future::pending::<()>().await;
            Ok::<_, Never>(())
        },
    ));
    started.notified().await;
    let next = with_conversation_turn(&t.app, Some("d-1"), live("web", "next"), || async {
        Ok::<_, Never>(claim_queued_turn(Some("d-1")))
    });
    assert_eq!(queue_depth(&t.app, "d-1"), 2);
    // The turn is stopped the hard way: its task is aborted, as a shutdown or a caller that gave up would.
    holder.abort();
    assert!(holder.await.unwrap_err().is_cancelled());
    let claimed = next.await.unwrap().ran().unwrap();
    assert_eq!(claimed, bus.events_since("d-1", 0, 10)[0].turn_id);
    assert_eq!(queue_depth(&t.app, "d-1"), 0);
}

#[tokio::test]
async fn a_waiting_turn_that_is_dropped_leaves_the_queue_and_the_one_behind_it_still_waits_its_turn() {
    let (t, bus) = with_bus();
    let g = Gate::default();
    let gate = g.clone();
    let running = Arc::new(AtomicBool::new(false));
    let (set, check) = (running.clone(), running.clone());
    let a = with_conversation_turn(&t.app, Some("d-2"), plain(), move || async move {
        set.store(true, Ordering::SeqCst);
        gate.passed().await;
        set.store(false, Ordering::SeqCst);
        Ok::<_, Never>(())
    });
    let b = with_conversation_turn(&t.app, Some("d-2"), live("web", "dropped"), || async {
        Ok::<_, Never>("b must never run")
    });
    let c = tokio::spawn(with_conversation_turn(
        &t.app,
        Some("d-2"),
        live("web", "last"),
        move || async move { Ok::<_, Never>(check.load(Ordering::SeqCst)) },
    ));
    let lines: Vec<String> = bus
        .queued_turn_list(Some("d-2"))
        .into_iter()
        .filter_map(|q| q.turn_id)
        .collect();
    assert_eq!(queue_depth(&t.app, "d-2"), 3);

    // The middle one goes away while it waits (never polled, even).
    drop(b);
    assert_eq!(queue_depth(&t.app, "d-2"), 2);
    assert_eq!(
        of(&bus, "d-2", &lines[0]),
        [evt("turn_queued", None), evt("turn_end", Some("removed"))],
        "its line ends at once"
    );
    assert_eq!(bus.queued_turn_list(Some("d-2")).len(), 1);

    // The one behind it does not slip past the turn still running.
    let a = tokio::spawn(a);
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(running.load(Ordering::SeqCst), "the first turn is at work");
    assert!(!c.is_finished(), "the last one waits for it");
    g.open();
    assert_eq!(a.await.unwrap(), Ok(Turn::Ran(())));
    assert_eq!(
        c.await.unwrap(),
        Ok(Turn::Ran(false)),
        "it began only after the first turn was done"
    );
    assert_eq!(queue_depth(&t.app, "d-2"), 0);
}

#[tokio::test]
async fn a_turn_woken_for_its_slot_and_then_dropped_passes_the_slot_on() {
    let t = test_app();
    let a = with_conversation_turn(&t.app, Some("d-3"), plain(), || async { Ok::<_, Never>(()) });
    let b = with_conversation_turn(&t.app, Some("d-3"), plain(), || async { Ok::<_, Never>("b") });
    let c = with_conversation_turn(&t.app, Some("d-3"), plain(), || async { Ok::<_, Never>("c") });
    // The first ends and hands the slot to the second, which is dropped before it is ever polled.
    assert_eq!(a.await, Ok(Turn::Ran(())));
    drop(b);
    assert_eq!(c.await, Ok(Turn::Ran("c")));
    assert_eq!(queue_depth(&t.app, "d-3"), 0);
}

#[tokio::test]
async fn a_turn_started_from_inside_a_turn_of_the_same_conversation_runs_after_it() {
    let t = test_app();
    let order = Arc::new(Mutex::new(Vec::<&str>::new()));
    let (outer_order, inner_order) = (order.clone(), order.clone());
    let app = t.app.clone();
    let outer = with_conversation_turn(&t.app, Some("r-1"), plain(), move || async move {
        outer_order.lock().push("outer:start");
        // As in the JS: the inner turn queues behind the one that started it. It is not awaited in here (that
        // would wait for ever, in both versions): its future is handed out.
        let inner = with_conversation_turn(&app, Some("r-1"), plain(), move || async move {
            inner_order.lock().push("inner");
            Ok::<_, Never>(())
        });
        assert_eq!(queue_depth(&app, "r-1"), 2);
        tokio::task::yield_now().await;
        outer_order.lock().push("outer:end");
        Ok::<_, Never>(inner)
    });
    let inner = outer.await.unwrap().ran().unwrap();
    assert_eq!(inner.await, Ok(Turn::Ran(())));
    assert_eq!(*order.lock(), ["outer:start", "outer:end", "inner"]);
    assert_eq!(queue_depth(&t.app, "r-1"), 0);
}

#[tokio::test]
async fn a_listener_of_the_timeline_may_stop_a_queued_turn_the_moment_it_is_queued() {
    // The lock module holds none of its own locks while it publishes: a listener that comes straight back into it
    // (here: the Stop of a line as soon as it shows) must not wait on anything.
    let (t, bus) = with_bus();
    let app = t.app.downgrade();
    let depth_seen = Arc::new(Mutex::new(Vec::<usize>::new()));
    let depths = depth_seen.clone();
    bus.on_event(move |e| {
        let app = app.upgrade().unwrap();
        if e.r#type == "turn_queued" {
            depths.lock().push(queue_depth(&app, &e.conversation_id));
            assert!(remove_queued_turn(
                &app,
                e.turn_id.as_deref().unwrap(),
                Some(&e.conversation_id)
            ));
        }
    });
    let g = Gate::default();
    let gate = g.clone();
    let a = with_conversation_turn(&t.app, Some("l-1"), plain(), move || async move {
        gate.passed().await;
        Ok::<_, Never>(())
    });
    let b = with_conversation_turn(&t.app, Some("l-1"), live("web", "x"), || async { Ok::<_, Never>(()) });
    assert_eq!(*depth_seen.lock(), [2]);
    g.open();
    let (a, b) = tokio::join!(a, b);
    assert_eq!((a, b), (Ok(Turn::Ran(())), Ok(Turn::QueueRemoved)));
    // And it can be called with the database in hand (a store method that queues a turn).
    let again = t.db().with(|_conn| {
        let first = with_conversation_turn(&t.app, Some("l-2"), live("web", "a"), || async { Ok::<_, Never>(1) });
        let second = with_conversation_turn(&t.app, Some("l-2"), live("web", "b"), || async { Ok::<_, Never>(2) });
        (first, second)
    });
    let (first, second) = tokio::join!(again.0, again.1);
    assert_eq!((first, second), (Ok(Turn::Ran(1)), Ok(Turn::QueueRemoved)));
}

#[tokio::test]
async fn the_queued_line_says_where_it_came_from_and_the_start_of_what_was_asked() {
    let (t, bus) = with_bus();
    let g = Gate::default();
    let gate = g.clone();
    let a = with_conversation_turn(&t.app, Some("e-1"), live("web", "first"), move || async move {
        gate.passed().await;
        Ok::<_, Never>(())
    });
    let opts = TurnOptions {
        live: Some(LiveQueue {
            conversation_id: Some("cron:7".into()),
            source: None,
            prompt: format!("{}🐒tail", "p".repeat(299)),
            model: Some("opus".into()),
            on_removed: None,
        }),
        ..TurnOptions::default()
    };
    let b = with_conversation_turn(&t.app, Some("e-1"), opts, || async { Ok::<_, Never>(()) });
    assert!(
        bus.events_since("e-1", 0, 10).is_empty(),
        "the turn ahead never queued; the line is on the other timeline"
    );
    let line = &bus.events_since("cron:7", 0, 10)[0];
    assert_eq!(line.r#type, "turn_queued");
    assert_eq!(
        line.payload.to_string(),
        format!(r#"{{"source":null,"model":"opus","prompt":"{}"}}"#, "p".repeat(299)),
        "300 characters, and never half an emoji"
    );
    assert_eq!(bus.queued_turn_list(Some("cron:7")).len(), 1);
    // Its Stop is asked for by the timeline it shows on.
    assert!(!remove_queued_turn(
        &t.app,
        line.turn_id.as_deref().unwrap(),
        Some("e-1")
    ));
    assert!(remove_queued_turn(&t.app, line.turn_id.as_deref().unwrap(), None));
    g.open();
    let _ = tokio::join!(a, b);
}

#[tokio::test]
async fn the_claim_and_the_queued_note_are_for_the_conversation_that_waited_and_only_once() {
    let (t, _bus) = with_bus();
    assert_eq!(claim_queued_turn(Some("n-1")), None, "outside any turn");
    assert!(!take_queued_note("n-1"));
    assert!(current_queued_turn().is_none());

    let g = Gate::default();
    let gate = g.clone();
    let first = with_conversation_turn(&t.app, Some("n-1"), live("web", "first"), move || async move {
        gate.passed().await;
        // A turn that never waited has no note and nothing to claim.
        Ok::<_, Never>((take_queued_note("n-1"), claim_queued_turn(Some("n-1"))))
    });
    let app = t.app.clone();
    let second = with_conversation_turn(&t.app, Some("n-1"), live("web", "second"), move || async move {
        let other = (
            take_queued_note("n-2"),
            claim_queued_turn(Some("n-2")),
            take_queued_note(""),
        );
        // A turn of another conversation started from inside this one sees this one's slot, and is refused.
        let inside = with_conversation_turn(&app, Some("n-2"), plain(), || async {
            Ok::<_, Never>((take_queued_note("n-2"), claim_queued_turn(Some("n-2"))))
        })
        .await;
        let own = (take_queued_note("n-1"), take_queued_note("n-1"));
        // With no conversation named, the claim is this slot's.
        let claimed = claim_queued_turn(None);
        // A task spawned from the turn sees the slot only when it is handed it.
        let alone = tokio::spawn(async { current_queued_turn().is_some() }).await.unwrap();
        let handed = tokio::spawn(scope_queued_turn(current_queued_turn(), async {
            current_queued_turn().map(|q| q.turn_id.clone())
        }))
        .await
        .unwrap();
        Ok::<_, Never>((other, inside, own, claimed, alone, handed))
    });
    g.open();
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first, Ok(Turn::Ran((false, None))));
    let (other, inside, own, claimed, alone, handed) = second.unwrap().ran().unwrap();
    assert_eq!(other, (false, None, false));
    assert_eq!(inside, Ok(Turn::Ran((false, None))));
    assert_eq!(own, (true, false), "once per waiting slot");
    assert!(claimed.is_some());
    assert!(!alone);
    assert_eq!(handed, claimed);
}

#[tokio::test]
async fn resetting_drops_all_state_and_turns_under_way_still_finish() {
    let t = test_app();
    let g = Gate::default();
    let gate = g.clone();
    let before = with_conversation_turn(&t.app, Some("z-1"), plain(), move || async move {
        gate.passed().await;
        Ok::<_, Never>("before")
    });
    assert_eq!(queue_depth(&t.app, "z-1"), 1);
    reset_conversation_locks(&t.app);
    assert_eq!(queue_depth(&t.app, "z-1"), 0);
    let after = with_conversation_turn(&t.app, Some("z-1"), plain(), || async { Ok::<_, Never>("after") });
    assert_eq!(
        after.await,
        Ok(Turn::Ran("after")),
        "it does not wait for the turn from before"
    );
    g.open();
    assert_eq!(before.await, Ok(Turn::Ran("before")));
}
