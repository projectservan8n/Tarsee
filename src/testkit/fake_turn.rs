//! A scripted turn layer: what the Node channel tests passed as `chatStream` (`test/channel-turns.test.js`'s
//! `modelStream`, `test/slack-bot.test.js`'s `scripted`, `test/verify-model.test.js`'s `runner`). It records the
//! options of every turn that is started and yields the events its script says, so whatever starts turns (a
//! channel, a scheduled task, a route) can be tested without the turn layer or an engine.
//!
//! ```ignore
//! let t = test_app();
//! let turns = FakeTurnRunner::install(&t.app);          // ai::router::chat_stream(&t.app, ...) now plays the script
//! turns.script(json!([
//!     {"type": "route", "provider": "deepseek", "engine": "claude-code", "model": "deepseek-v4-flash", "label": "DeepSeek Flash"},
//!     {"type": "text", "content": "Hello."},
//!     {"type": "usage", "usage": {"input_tokens": 12, "output_tokens": 3}},
//!     {"type": "done", "stopReason": "end_turn"},
//! ]));
//! // ... deliver a message to the channel under test ...
//! let calls = turns.calls();
//! assert_eq!(calls[0].live_source.as_deref(), Some("telegram"));
//! assert!(calls[0].provider.is_none());
//! ```
//!
//! A script is written in `testkit::fake_engine`'s vocabulary, so besides events it can hold `session` (the turn
//! reports its session handle: `on_session_id(id)`), `wait`, `sleep` and `throw` (the stream's next item is an
//! `Err`, the Node generator throwing). Until a script is set, every turn is one done{end_turn}.

use std::sync::Arc;

use futures::FutureExt;
use parking_lot::Mutex;

use super::fake_engine::{Script, pick, play};
use crate::ai::router::{TurnRunner, install_turn_runner};
use crate::ai::turn_types::{TurnOptions, TurnStream};
use crate::app::App;

type StreamFn = Arc<dyn Fn(&App, TurnOptions) -> TurnStream + Send + Sync>;

#[derive(Default)]
struct Plan {
    scripts: Vec<Script<TurnOptions>>,
    /// How many turns have started since the scripts were last set.
    played: usize,
    /// When set, it makes every turn's stream itself.
    stream: Option<StreamFn>,
}

/// The scripted turn runner.
#[derive(Default)]
pub struct FakeTurnRunner {
    plan: Arc<Mutex<Plan>>,
    calls: Arc<Mutex<Vec<TurnOptions>>>,
}

impl FakeTurnRunner {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// A new one, installed as the app's turn runner.
    pub fn install(app: &App) -> Arc<Self> {
        let runner = Self::new();
        install_turn_runner(app, runner.clone());
        runner
    }

    /// Every turn from now on plays this script (the Node `model.script = ...`).
    pub fn script(&self, script: impl Into<Script<TurnOptions>>) {
        self.scripts([script.into()]);
    }

    /// The turns from now on play these, one each; the last one repeats.
    pub fn scripts(&self, scripts: impl IntoIterator<Item = Script<TurnOptions>>) {
        let mut plan = self.plan.lock();
        plan.scripts = scripts.into_iter().collect();
        plan.played = 0;
        plan.stream = None;
    }

    /// Every turn from now on is the stream this function makes: for a turn no script can describe (one that
    /// yields while a test holds it, one that never ends). The call is still recorded.
    pub fn stream_with(&self, make: impl Fn(&App, TurnOptions) -> TurnStream + Send + Sync + 'static) {
        self.plan.lock().stream = Some(Arc::new(make));
    }

    /// The options of every turn started so far, oldest first. With a script, a turn is recorded when its stream
    /// is first read.
    pub fn calls(&self) -> Vec<TurnOptions> {
        self.calls.lock().clone()
    }

    /// Forgets the recorded turns; the script stays.
    pub fn clear_calls(&self) {
        self.calls.lock().clear();
    }
}

impl TurnRunner for FakeTurnRunner {
    fn run_turn(&self, app: &App, options: TurnOptions) -> TurnStream {
        let own_stream = self.plan.lock().stream.clone();
        if let Some(make) = own_stream {
            self.calls.lock().push(options.clone());
            return make(app, options);
        }
        let signal = options.signal.clone();
        let on_session = options.on_session_id.clone();
        let plan = self.plan.clone();
        let calls = self.calls.clone();
        let start = async move {
            calls.lock().push(options.clone());
            let (script, index) = {
                let mut plan = plan.lock();
                let index = plan.played;
                plan.played += 1;
                (pick(&plan.scripts, index), index)
            };
            script.items_for(options, index).await
        };
        play(start.boxed(), signal, on_session)
    }
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::ai::router::chat_stream;
    use crate::ai::turn_types::{SessionCallback, SystemParts, TurnEvent, TurnMessage, stream_of};
    use crate::lib::tool_api::ToolContext;
    use crate::testkit::fake_engine::{answer, items, script};
    use crate::testkit::test_app;

    async fn events(stream: TurnStream) -> Vec<TurnEvent> {
        stream.map(|item| item.expect("the turn failed")).collect().await
    }

    fn says(events: &[TurnEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                TurnEvent::Text(text) => Some(text.content.as_str()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn until_a_script_is_set_every_turn_is_one_done() {
        let t = test_app();
        let turns = FakeTurnRunner::install(&t.app);
        assert_eq!(
            events(chat_stream(&t.app, TurnOptions::default())).await,
            [TurnEvent::done("end_turn")]
        );
        assert_eq!(turns.calls().len(), 1);
    }

    /// What `test/channel-turns.test.js` asserts of every channel (`assertTurnOptions`): the options a channel
    /// passed are there to read.
    #[tokio::test]
    async fn it_records_every_option_a_caller_passed() {
        let t = test_app();
        let turns = FakeTurnRunner::install(&t.app);
        turns.script(json!([
            {"type": "route", "provider": "deepseek", "engine": "claude-code", "model": "deepseek-v4-flash", "label": "DeepSeek Flash", "providerLabel": "DeepSeek API key", "effort": null},
            {"type": "text", "content": "Hello."},
            {"type": "usage", "usage": {"input_tokens": 12, "output_tokens": 3}},
            {"type": "done", "stopReason": "end_turn"},
        ]));
        let got = events(chat_stream(
            &t.app,
            TurnOptions {
                live_source: Some("telegram".into()),
                messages: vec![TurnMessage::user("hi")],
                system_parts: Some(SystemParts {
                    stable: "SOUL".into(),
                    volatile: String::new(),
                }),
                tool_ctx: ToolContext {
                    message_id: Some("m1".into()),
                    ..ToolContext::for_conversation("conv-1")
                },
                session_id: Some("raw-1".into()),
                ..Default::default()
            },
        ))
        .await;
        assert_eq!(
            got.iter().map(TurnEvent::event_type).collect::<Vec<_>>(),
            ["route", "text", "usage", "done"]
        );

        let calls = turns.calls();
        assert_eq!(calls.len(), 1);
        let opts = &calls[0];
        assert_eq!(opts.live_source.as_deref(), Some("telegram"));
        assert!(
            opts.provider.is_none() && opts.model.is_none(),
            "the turn layer picks the AI"
        );
        assert_eq!(opts.tool_ctx.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(opts.tool_ctx.message_id.as_deref(), Some("m1"));
        assert!(
            opts.system_prompt.is_none(),
            "the prompt goes in its two parts, not as one string"
        );
        assert_eq!(opts.system_parts.as_ref().unwrap().stable, "SOUL");
        assert_eq!(opts.session_id.as_deref(), Some("raw-1"));
        assert_eq!(opts.messages, [TurnMessage::user("hi")]);

        turns.clear_calls();
        assert!(turns.calls().is_empty());
    }

    #[tokio::test]
    async fn one_script_for_every_turn_or_one_per_turn_with_the_last_repeating() {
        let t = test_app();
        let turns = FakeTurnRunner::install(&t.app);
        turns.script(answer("Hello."));
        for _ in 0..2 {
            assert_eq!(
                says(&events(chat_stream(&t.app, TurnOptions::default())).await),
                "Hello."
            );
        }
        turns.scripts([answer("first").into(), answer("then").into()]);
        let mut said = Vec::new();
        for _ in 0..3 {
            said.push(says(&events(chat_stream(&t.app, TurnOptions::default())).await));
        }
        assert_eq!(said, ["first", "then", "then"]);
        // A new script starts over from its own first turn.
        turns.scripts([answer("again").into(), answer("and on").into()]);
        assert_eq!(
            says(&events(chat_stream(&t.app, TurnOptions::default())).await),
            "again"
        );
    }

    /// The Node `model.script = (opts) => [...]`.
    #[tokio::test]
    async fn a_script_can_look_at_the_turns_options() {
        let t = test_app();
        let turns = FakeTurnRunner::install(&t.app);
        turns.script(Script::from_sync(|opts: &TurnOptions, index| {
            answer(&format!(
                "turn {index} for {}",
                opts.live_source.as_deref().unwrap_or("nobody")
            ))
        }));
        let from = |source: &str| TurnOptions {
            live_source: Some(source.into()),
            ..Default::default()
        };
        assert_eq!(
            says(&events(chat_stream(&t.app, from("discord"))).await),
            "turn 0 for discord"
        );
        assert_eq!(
            says(&events(chat_stream(&t.app, from("email"))).await),
            "turn 1 for email"
        );
    }

    /// As `test/verify-model.test.js`'s runner does: `opts.onSessionId?.(session.handle)`.
    #[tokio::test]
    async fn a_session_line_reports_the_handle_to_the_callers_callback() {
        let t = test_app();
        let turns = FakeTurnRunner::install(&t.app);
        turns.script(json!([{"type": "session", "id": "deepseek/cc/deepseek:raw-9"}, {"type": "done", "stopReason": "end_turn"}]));
        let stored = Arc::new(Mutex::new(None::<String>));
        let store = stored.clone();
        let options = TurnOptions {
            on_session_id: Some(SessionCallback::new(move |handle| {
                *store.lock() = Some(handle.to_string())
            })),
            ..Default::default()
        };
        assert_eq!(
            events(chat_stream(&t.app, options)).await,
            [TurnEvent::done("end_turn")]
        );
        assert_eq!(stored.lock().as_deref(), Some("deepseek/cc/deepseek:raw-9"));
    }

    #[tokio::test]
    async fn wait_ends_aborted_at_the_callers_stop_and_throw_is_an_err_item() {
        let t = test_app();
        let turns = FakeTurnRunner::install(&t.app);
        turns.script(json!([{"type": "text", "content": "Working"}, {"type": "wait"}]));
        let options = TurnOptions::default();
        let stop = options.signal.clone();
        let mut stream = chat_stream(&t.app, options);
        assert_eq!(stream.next().await.unwrap().unwrap(), TurnEvent::text("Working"));
        assert!(stream.next().now_or_never().is_none(), "it waits");
        stop.cancel();
        assert_eq!(stream.next().await.unwrap().unwrap(), TurnEvent::done("aborted"));
        assert!(stream.next().await.is_none());

        turns.script(json!([{"type": "throw", "message": "the turn layer broke"}]));
        let failed: Vec<_> = chat_stream(&t.app, TurnOptions::default()).collect().await;
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].as_ref().unwrap_err().to_string(), "the turn layer broke");
    }

    #[tokio::test]
    async fn a_turn_can_be_a_stream_of_the_tests_own_making() {
        let t = test_app();
        let turns = FakeTurnRunner::install(&t.app);
        turns.stream_with(|_app, options| {
            let words = options.messages.len().to_string();
            stream_of([TurnEvent::text(words), TurnEvent::done("end_turn")])
        });
        let options = TurnOptions {
            messages: vec![TurnMessage::user("a"), TurnMessage::user("b")],
            ..Default::default()
        };
        assert_eq!(says(&events(chat_stream(&t.app, options)).await), "2");
        assert_eq!(turns.calls().len(), 1);
        // Setting a script again takes the function out.
        turns.script(items(json!([{"type": "done", "stopReason": "error"}])));
        assert_eq!(
            events(chat_stream(&t.app, TurnOptions::default())).await,
            [TurnEvent::done("error")]
        );
    }

    #[tokio::test]
    async fn script_reads_a_json_array() {
        let t = test_app();
        let turns = FakeTurnRunner::install(&t.app);
        turns.scripts([script(json!([{"type": "error", "message": "The session could not be resumed.", "recoverable": true}, {"type": "done", "stopReason": "error"}]))]);
        let got = events(chat_stream(&t.app, TurnOptions::default())).await;
        let TurnEvent::Error(error) = &got[0] else {
            panic!("not an error")
        };
        assert!(error.is_recoverable());
    }
}
