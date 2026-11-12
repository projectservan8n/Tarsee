//! Port of `test/fakes/fake-engine.js`: a scripted agent engine for the turn layer's tests (`ai::engine`
//! `register_engine`). It records what each call was given and yields the events its script says, as a real engine
//! (`providers/claude_code.rs`, `providers/codex.rs`) would.
//!
//! ```ignore
//! let engine = FakeEngine::new([
//!     script(json!([{"type": "session", "id": "raw-1"}, {"type": "text", "content": "Hi"}, {"type": "done", "stopReason": "end_turn"}])),
//!     // ...one script per call; the last one repeats
//! ]);
//! register_engine(&app, "claude-code", Some(engine.clone()));
//! // ... run the turn ...
//! engine.calls()   // what each run() got
//! ```
//!
//! Besides Tarsee's events a script can hold:
//!
//! - `{ type: "session", id }`: the engine reports its session, `on_session_handle(id)`
//! - `{ type: "wait" }`: wait until the turn's signal is cancelled, then end with done{aborted} (a stopped engine)
//! - `{ type: "sleep", ms }`: wait that long (ends early, with done{aborted}, if the signal is cancelled)
//! - `{ type: "throw", message }`: the engine crashes (the stream's next item is an `Err`)
//!
//! A script can also be a function `(opts, call_index)` returning the items, which may wait for something first
//! ([`Script::from_fn`]).
//!
//! The same scripts drive `testkit::FakeTurnRunner`, which stands in for the whole turn layer.

use std::collections::VecDeque;
use std::future::Future;
use std::ops::Deref;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt, stream};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::ai::engine::{Engine, EngineOptions, EngineStream, register_engine};
use crate::ai::turn_types::{MessageContent, SessionCallback, TurnEvent, TurnMessage, TurnStream};
use crate::app::App;

/// One line of a script.
// (An event is far bigger than the script's own lines. A script is a handful of items in a test, so the size does
// not matter, and a boxed event would only make scripts harder to write and to match on.)
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum ScriptItem {
    /// One of Tarsee's events, yielded as it is.
    Event(TurnEvent),
    /// `{ type: "session", id }`: the session is reported to the caller's callback; nothing is yielded.
    Session(String),
    /// `{ type: "wait" }`: nothing more until the stop, then done{aborted}.
    Wait,
    /// `{ type: "sleep", ms }`.
    Sleep(Duration),
    /// `{ type: "throw", message }`.
    Throw(String),
}

impl ScriptItem {
    /// The item for a JSON object, in the Node fake's vocabulary: "session", "wait", "sleep" and "throw" are the
    /// script's own, anything else is an event (`TurnEvent::from_value`).
    pub fn from_value(value: Value) -> Self {
        match value.get("type").and_then(Value::as_str) {
            Some("session") => ScriptItem::Session(value.get("id").and_then(Value::as_str).unwrap_or("").to_string()),
            Some("wait") => ScriptItem::Wait,
            Some("sleep") => ScriptItem::Sleep(Duration::from_millis(
                value.get("ms").and_then(Value::as_u64).unwrap_or(0),
            )),
            Some("throw") => ScriptItem::Throw(
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty())
                    .unwrap_or("the engine crashed")
                    .to_string(),
            ),
            _ => ScriptItem::Event(TurnEvent::from_value(value)),
        }
    }
}

impl From<TurnEvent> for ScriptItem {
    fn from(event: TurnEvent) -> Self {
        ScriptItem::Event(event)
    }
}

impl From<Value> for ScriptItem {
    fn from(value: Value) -> Self {
        ScriptItem::from_value(value)
    }
}

/// The items of a JSON array, one per element: how a Node test's script is written down here.
///
/// ```ignore
/// items(json!([{"type": "text", "content": "Done."}, {"type": "done", "stopReason": "end_turn"}]))
/// ```
pub fn items(script: Value) -> Vec<ScriptItem> {
    match script {
        Value::Array(list) => list.into_iter().map(ScriptItem::from_value).collect(),
        other => vec![ScriptItem::from_value(other)],
    }
}

/// The script every Node test file had as `ok(text)` or `answer(text)`: the words, then done{end_turn}.
pub fn answer(text: &str) -> Vec<ScriptItem> {
    items(json!([{"type": "text", "content": text}, {"type": "done", "stopReason": "end_turn"}]))
}

type ScriptFn<O> = Arc<dyn Fn(O, usize) -> BoxFuture<'static, Vec<ScriptItem>> + Send + Sync>;

/// What a call plays: a list of items, or a function that makes one from the call's options and its number
/// (0 for the first call).
pub enum Script<O> {
    Items(Vec<ScriptItem>),
    Fn(ScriptFn<O>),
}

impl<O> Clone for Script<O> {
    fn clone(&self) -> Self {
        match self {
            Script::Items(items) => Script::Items(items.clone()),
            Script::Fn(function) => Script::Fn(function.clone()),
        }
    }
}

impl<O: Send + 'static> Script<O> {
    /// A script made when the call comes, by a function that may wait first (for a gate a test opens, say): the
    /// Node `async (opts, callIndex) => [...]`.
    pub fn from_fn<F, Fut>(function: F) -> Self
    where
        F: Fn(O, usize) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Vec<ScriptItem>> + Send + 'static,
    {
        Script::Fn(Arc::new(move |opts, index| function(opts, index).boxed()))
    }

    /// A script made when the call comes, at once: the Node `(opts) => [...]`.
    pub fn from_sync(function: impl Fn(&O, usize) -> Vec<ScriptItem> + Send + Sync + 'static) -> Self {
        Script::Fn(Arc::new(move |opts, index| {
            let items = function(&opts, index);
            async move { items }.boxed()
        }))
    }

    pub(crate) async fn items_for(&self, opts: O, index: usize) -> Vec<ScriptItem> {
        match self {
            Script::Items(items) => items.clone(),
            Script::Fn(function) => function(opts, index).await,
        }
    }
}

impl<O> From<Vec<ScriptItem>> for Script<O> {
    fn from(items: Vec<ScriptItem>) -> Self {
        Script::Items(items)
    }
}

impl<O> From<Vec<TurnEvent>> for Script<O> {
    fn from(events: Vec<TurnEvent>) -> Self {
        Script::Items(events.into_iter().map(ScriptItem::Event).collect())
    }
}

/// A JSON array of items.
impl<O> From<Value> for Script<O> {
    fn from(script: Value) -> Self {
        Script::Items(items(script))
    }
}

/// A script from a JSON array: `script(json!([{...}, {...}]))`.
pub fn script<O>(script: Value) -> Script<O> {
    Script::from(script)
}

/// The script for call number `index`: one per call, the last one repeats. An empty list plays one
/// done{end_turn}, the Node fake's default.
pub(crate) fn pick<O>(scripts: &[Script<O>], index: usize) -> Script<O> {
    match scripts.get(index.min(scripts.len().saturating_sub(1))) {
        Some(script) => script.clone(),
        None => Script::Items(vec![ScriptItem::Event(TurnEvent::done("end_turn"))]),
    }
}

/// Plays a script as a stream, the way the Node fake's generator did. `start` runs when the stream is first read
/// and gives the items.
pub(crate) fn play(
    start: BoxFuture<'static, Vec<ScriptItem>>,
    signal: CancellationToken,
    on_session: Option<SessionCallback>,
) -> TurnStream {
    struct Playing {
        start: Option<BoxFuture<'static, Vec<ScriptItem>>>,
        items: VecDeque<ScriptItem>,
        signal: CancellationToken,
        on_session: Option<SessionCallback>,
        over: bool,
    }
    let playing = Playing {
        start: Some(start),
        items: VecDeque::new(),
        signal,
        on_session,
        over: false,
    };
    stream::unfold(playing, |mut playing| async move {
        if playing.over {
            return None;
        }
        if let Some(start) = playing.start.take() {
            playing.items = start.await.into();
        }
        let aborted = || Ok(TurnEvent::done("aborted"));
        loop {
            let item = playing.items.pop_front()?;
            match item {
                ScriptItem::Session(id) => {
                    if let Some(callback) = &playing.on_session {
                        callback.call(&id);
                    }
                }
                ScriptItem::Wait => {
                    playing.signal.cancelled().await;
                    playing.over = true;
                    return Some((aborted(), playing));
                }
                ScriptItem::Sleep(time) => {
                    let stopped = tokio::select! {
                        biased;
                        _ = playing.signal.cancelled() => true,
                        _ = tokio::time::sleep(time) => false,
                    };
                    if stopped {
                        playing.over = true;
                        return Some((aborted(), playing));
                    }
                }
                ScriptItem::Throw(message) => {
                    playing.over = true;
                    return Some((Err(anyhow::anyhow!(message)), playing));
                }
                ScriptItem::Event(event) => {
                    if playing.signal.is_cancelled() {
                        playing.over = true;
                        return Some((aborted(), playing));
                    }
                    return Some((Ok(event), playing));
                }
            }
        }
    })
    .boxed()
}

/// What one `run()` was given: the options, and `prompt`, the words of its last user message. It reads as the
/// options themselves (`call.target.provider`, `call.max_turns`).
#[derive(Debug, Clone)]
pub struct EngineCall {
    pub opts: EngineOptions,
    /// `lastUserText(opts.messages)`.
    pub prompt: String,
}

impl Deref for EngineCall {
    type Target = EngineOptions;
    fn deref(&self) -> &EngineOptions {
        &self.opts
    }
}

/// The scripted engine.
pub struct FakeEngine {
    scripts: Vec<Script<EngineOptions>>,
    calls: Arc<Mutex<Vec<EngineCall>>>,
}

impl FakeEngine {
    /// An engine that plays these scripts, one per call; the last one repeats. With none, every call is one
    /// done{end_turn}.
    pub fn new(scripts: impl IntoIterator<Item = Script<EngineOptions>>) -> Arc<Self> {
        Arc::new(FakeEngine {
            scripts: scripts.into_iter().collect(),
            calls: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// A new engine, registered in the app under `name` ("claude-code", "codex") in place of the real one.
    pub fn register(app: &App, name: &str, scripts: impl IntoIterator<Item = Script<EngineOptions>>) -> Arc<Self> {
        let engine = Self::new(scripts);
        register_engine(app, name, Some(engine.clone()));
        engine
    }

    /// What each `run()` got, oldest first. A call is recorded when its stream is first read.
    pub fn calls(&self) -> Vec<EngineCall> {
        self.calls.lock().clone()
    }
}

/// `createFakeEngine(scripts)`.
pub fn create_fake_engine(scripts: impl IntoIterator<Item = Script<EngineOptions>>) -> Arc<FakeEngine> {
    FakeEngine::new(scripts)
}

impl Engine for FakeEngine {
    fn run(&self, _app: &App, opts: EngineOptions) -> EngineStream {
        let signal = opts.signal.clone();
        let on_session = opts.on_session_handle.clone();
        let calls = self.calls.clone();
        let scripts = self.scripts.clone();
        let start = async move {
            let index = {
                let mut calls = calls.lock();
                calls.push(EngineCall {
                    prompt: last_user_text(&opts.messages),
                    opts: opts.clone(),
                });
                calls.len() - 1
            };
            pick(&scripts, index).items_for(opts, index).await
        };
        play(start.boxed(), signal, on_session)
    }
}

/// The words of a run's last user message (its content blocks' text joined), as the engine would send them.
pub fn last_user_text(messages: &[TurnMessage]) -> String {
    let Some(last) = messages.iter().rev().find(|message| message.role == "user") else {
        return String::new();
    };
    match &last.content {
        MessageContent::Text(text) => text.clone(),
        MessageContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| block.as_text())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::sync::Notify;

    use super::*;
    use crate::ai::engine::{CLAUDE_CODE, SessionChoice, Target, load_engine};
    use crate::ai::turn_types::ContentBlock;
    use crate::testkit::test_app;

    async fn collect(stream: EngineStream) -> Vec<anyhow::Result<TurnEvent>> {
        stream.collect().await
    }

    async fn events(stream: EngineStream) -> Vec<TurnEvent> {
        collect(stream)
            .await
            .into_iter()
            .map(|item| item.expect("the engine crashed"))
            .collect()
    }

    fn opts(prompt: &str) -> EngineOptions {
        EngineOptions {
            target: Target {
                provider: "claude".into(),
                ..Default::default()
            },
            messages: vec![TurnMessage::user(prompt)],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn it_plays_one_script_per_call_and_the_last_one_repeats() {
        let t = test_app();
        let engine = FakeEngine::new([
            script(json!([{"type": "text", "content": "first"}, {"type": "done", "stopReason": "end_turn"}])),
            answer("later").into(),
        ]);
        assert_eq!(
            events(engine.run(&t.app, opts("one"))).await,
            [TurnEvent::text("first"), TurnEvent::done("end_turn")]
        );
        assert_eq!(
            events(engine.run(&t.app, opts("two"))).await[0],
            TurnEvent::text("later")
        );
        assert_eq!(
            events(engine.run(&t.app, opts("three"))).await[0],
            TurnEvent::text("later")
        );

        let calls = engine.calls();
        assert_eq!(
            calls.iter().map(|call| call.prompt.as_str()).collect::<Vec<_>>(),
            ["one", "two", "three"]
        );
        assert_eq!(
            calls[0].target.provider, "claude",
            "a call reads as the options it was given"
        );
        assert_eq!(calls[0].session_id, SessionChoice::Unset);
    }

    #[tokio::test]
    async fn with_no_script_every_call_is_one_done() {
        let t = test_app();
        let engine = create_fake_engine([]);
        assert_eq!(
            events(engine.run(&t.app, opts("hi"))).await,
            [TurnEvent::done("end_turn")]
        );
        assert_eq!(
            events(engine.run(&t.app, opts("again"))).await,
            [TurnEvent::done("end_turn")]
        );
    }

    #[tokio::test]
    async fn a_session_is_reported_to_the_callback_and_not_yielded() {
        let t = test_app();
        let engine = FakeEngine::new([script(
            json!([{"type": "session", "id": "raw-1"}, {"type": "done", "stopReason": "end_turn"}]),
        )]);
        let reported = Arc::new(Mutex::new(Vec::<String>::new()));
        let report = reported.clone();
        let with_callback = EngineOptions {
            on_session_handle: Some(SessionCallback::new(move |id| report.lock().push(id.to_string()))),
            ..opts("hi")
        };
        assert_eq!(
            events(engine.run(&t.app, with_callback)).await,
            [TurnEvent::done("end_turn")]
        );
        assert_eq!(*reported.lock(), ["raw-1"]);
        // No callback: the session line is passed over.
        assert_eq!(
            events(engine.run(&t.app, opts("hi"))).await,
            [TurnEvent::done("end_turn")]
        );
    }

    #[tokio::test]
    async fn wait_holds_until_the_stop_then_ends_aborted() {
        let t = test_app();
        let engine = FakeEngine::new([script(
            json!([{"type": "text", "content": "Working on it"}, {"type": "wait"}, {"type": "text", "content": "never"}]),
        )]);
        let run = opts("long job");
        let stop = run.signal.clone();
        let mut stream = engine.run(&t.app, run);
        assert_eq!(stream.next().await.unwrap().unwrap(), TurnEvent::text("Working on it"));
        assert!(stream.next().now_or_never().is_none(), "nothing comes while it waits");
        stop.cancel();
        assert_eq!(stream.next().await.unwrap().unwrap(), TurnEvent::done("aborted"));
        assert!(stream.next().await.is_none(), "and nothing after its done");
    }

    #[tokio::test]
    async fn sleep_waits_that_long_or_ends_aborted_when_stopped_first() {
        let t = test_app();
        let engine = FakeEngine::new([
            script(
                json!([{"type": "sleep", "ms": 40}, {"type": "text", "content": "awake"}, {"type": "done", "stopReason": "end_turn"}]),
            ),
            // (A minute: this test would hang that long if the stop did not end the sleep.)
            script(json!([{"type": "sleep", "ms": 60_000}, {"type": "text", "content": "never"}])),
        ]);

        let started = std::time::Instant::now();
        assert_eq!(
            events(engine.run(&t.app, opts("hi"))).await,
            [TurnEvent::text("awake"), TurnEvent::done("end_turn")]
        );
        assert!(
            started.elapsed() >= Duration::from_millis(40),
            "it slept: {:?}",
            started.elapsed()
        );

        let run = opts("hi");
        let stop = run.signal.clone();
        let mut stream = engine.run(&t.app, run);
        assert!(stream.next().now_or_never().is_none(), "asleep");
        stop.cancel();
        assert_eq!(stream.next().await.unwrap().unwrap(), TurnEvent::done("aborted"));
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn throw_is_the_engine_crashing() {
        let t = test_app();
        let engine = FakeEngine::new([script(
            json!([{"type": "text", "content": "half"}, {"type": "throw", "message": "spawn claude ENOENT"}, {"type": "done", "stopReason": "end_turn"}]),
        )]);
        let items = collect(engine.run(&t.app, opts("hi"))).await;
        assert_eq!(items.len(), 2, "nothing after the crash");
        assert_eq!(items[0].as_ref().unwrap(), &TurnEvent::text("half"));
        assert_eq!(items[1].as_ref().unwrap_err().to_string(), "spawn claude ENOENT");

        let unnamed = FakeEngine::new([script(json!([{"type": "throw"}]))]);
        let items = collect(unnamed.run(&t.app, opts("hi"))).await;
        assert_eq!(items[0].as_ref().unwrap_err().to_string(), "the engine crashed");
    }

    #[tokio::test]
    async fn a_run_already_stopped_yields_done_aborted_in_place_of_its_next_event() {
        let t = test_app();
        let engine = FakeEngine::new([Script::Items(answer("Done."))]);
        let run = opts("hi");
        run.signal.cancel();
        assert_eq!(events(engine.run(&t.app, run)).await, [TurnEvent::done("aborted")]);
    }

    #[tokio::test]
    async fn a_script_can_be_a_function_of_the_options_and_the_call_number_and_may_wait() {
        let t = test_app();
        let gate = Arc::new(Notify::new());
        let open = gate.clone();
        let engine = FakeEngine::new([
            Script::from_fn(move |opts: EngineOptions, index| {
                let gate = gate.clone();
                async move {
                    gate.notified().await;
                    answer(&format!("call {index} on {}", opts.target.provider))
                }
            }),
            Script::from_sync(|opts: &EngineOptions, index| {
                answer(&format!("call {index}: {}", last_user_text(&opts.messages)))
            }),
        ]);
        let mut first = engine.run(&t.app, opts("one"));
        assert!(first.next().now_or_never().is_none(), "it waits for the gate");
        assert_eq!(
            engine.calls().len(),
            1,
            "the call is recorded before its script is made"
        );
        open.notify_one();
        assert_eq!(
            first.next().await.unwrap().unwrap(),
            TurnEvent::text("call 0 on claude")
        );
        assert_eq!(
            events(engine.run(&t.app, opts("two"))).await[0],
            TurnEvent::text("call 1: two")
        );
    }

    #[tokio::test]
    async fn a_call_is_recorded_when_its_stream_is_first_read_as_a_generator_starts() {
        let t = test_app();
        let engine = FakeEngine::new([]);
        let stream = engine.run(&t.app, opts("hi"));
        assert_eq!(engine.calls().len(), 0);
        events(stream).await;
        assert_eq!(engine.calls().len(), 1);
    }

    #[tokio::test]
    async fn register_puts_it_in_the_apps_registry() {
        let t = test_app();
        let engine = FakeEngine::register(&t.app, CLAUDE_CODE, [Script::Items(answer("Hi"))]);
        let loaded = load_engine(&t.app, "claude-code").unwrap();
        assert_eq!(
            events(loaded.run(&t.app, opts("hello"))).await[0],
            TurnEvent::text("Hi")
        );
        assert_eq!(engine.calls()[0].prompt, "hello");
    }

    /// `test/fakes/fake-engine.js` `lastUserText`.
    #[test]
    fn last_user_text_is_the_last_user_messages_words() {
        assert_eq!(last_user_text(&[]), "");
        assert_eq!(last_user_text(&[TurnMessage::assistant("only me")]), "");
        assert_eq!(
            last_user_text(&[
                TurnMessage::user("first"),
                TurnMessage::assistant("reply"),
                TurnMessage::user("second"),
                TurnMessage::assistant("after")
            ]),
            "second"
        );
        let blocks = vec![
            ContentBlock::image("image/png", "cG5n"),
            ContentBlock::text("what is this?"),
            ContentBlock::text("and this?"),
        ];
        assert_eq!(last_user_text(&[TurnMessage::user(blocks)]), "what is this?\nand this?");
        assert_eq!(
            last_user_text(&[TurnMessage::user(vec![ContentBlock::image("image/png", "cG5n")])]),
            ""
        );
    }

    #[test]
    fn script_items_are_read_in_the_node_fakes_vocabulary() {
        assert_eq!(
            items(json!([
                {"type": "session", "id": "raw-1"}, {"type": "wait"}, {"type": "sleep", "ms": 300},
                {"type": "throw", "message": "boom"}, {"type": "text", "content": "Hi"},
                {"type": "step", "kind": "usage", "input": 5}
            ])),
            [
                ScriptItem::Session("raw-1".into()),
                ScriptItem::Wait,
                ScriptItem::Sleep(Duration::from_millis(300)),
                ScriptItem::Throw("boom".into()),
                ScriptItem::Event(TurnEvent::text("Hi")),
                ScriptItem::Event(TurnEvent::from_value(
                    json!({"type": "step", "kind": "usage", "input": 5})
                )),
            ]
        );
        assert_eq!(
            ScriptItem::from(TurnEvent::done("end_turn")),
            ScriptItem::Event(TurnEvent::done("end_turn"))
        );
        assert_eq!(
            items(json!({"type": "wait"})),
            [ScriptItem::Wait],
            "one item need not be in a list"
        );
        assert_eq!(
            answer("Done."),
            items(json!([{"type": "text", "content": "Done."}, {"type": "done", "stopReason": "end_turn"}]))
        );
    }
}
