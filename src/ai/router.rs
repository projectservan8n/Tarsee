//! Port of `src/ai/router.js`: the one way every caller starts a turn.
//!
//! Every channel's turn: the engine-neutral turn layer itself (`ai/turn.rs` `run_turn`), so every option a caller
//! passes reaches it as given (`thinking_summaries`, `queued_note`, `live_turn_id` and the rest). It picks the
//! provider, model and effort, runs the engine and yields Tarsee's events: route, text, thinking, tool_use,
//! tool_result, usage, error and exactly one done.
//!
//! The old generic options (apiKey, baseUrl, tools, executeTool) are ignored: the engines run their own tools, and a
//! provider's key and host are never taken from a caller.
//!
//! In Node `chatStream` *was* `runTurn` (`export const chatStream = runTurn`), and the channels took a `chatStream`
//! option so their tests could hand them a scripted one. Here [`chat_stream`] calls the [`TurnRunner`] stored in the
//! `App`: the turn layer installs itself at boot, and a test installs `testkit::FakeTurnRunner` instead. That is also
//! what lets the channels, scheduled tasks and routes be built before the turn layer is.

use std::sync::Arc;

use super::turn_types::{ErrorEvent, TurnEvent, TurnOptions, TurnStream, stream_of};
use crate::app::App;

/// What runs a turn: the Node `runTurn(opts)`. Package G3 implements it with `ai::turn::run_turn`.
///
/// Any `Fn(&App, TurnOptions) -> TurnStream` is one, so a function can be installed as it is.
pub trait TurnRunner: Send + Sync {
    /// Starts one turn and gives its events. Nothing has to run before the stream is read.
    fn run_turn(&self, app: &App, options: TurnOptions) -> TurnStream;
}

impl<F> TurnRunner for F
where
    F: Fn(&App, TurnOptions) -> TurnStream + Send + Sync,
{
    fn run_turn(&self, app: &App, options: TurnOptions) -> TurnStream {
        self(app, options)
    }
}

/// The turn runner the app holds (a service).
pub struct InstalledTurnRunner(pub Arc<dyn TurnRunner>);

/// Stores the app's turn runner, replacing any there was. `ai/turn.rs` does this at boot; a test installs
/// `testkit::FakeTurnRunner`.
pub fn install_turn_runner(app: &App, runner: Arc<dyn TurnRunner>) {
    app.set(InstalledTurnRunner(runner));
}

/// The app's turn runner, if one was installed.
pub fn turn_runner(app: &App) -> Option<Arc<dyn TurnRunner>> {
    app.get::<InstalledTurnRunner>().map(|installed| installed.0.clone())
}

/// What a turn says when no turn layer was installed (the words `ai/verify-model.js` uses for the same thing).
pub const TURN_LAYER_NOT_AVAILABLE: &str = "Tarsee's turn layer isn't available, so this turn can't run.";

/// Starts a turn and gives its events: the Node `chatStream(opts)`.
///
/// With no turn runner installed the stream is an error and a done, as the turn layer ends any turn it cannot run:
/// `{ type: "error", message, recoverable: false }` then `{ type: "done", stopReason: "error" }`.
pub fn chat_stream(app: &App, options: TurnOptions) -> TurnStream {
    match turn_runner(app) {
        Some(runner) => runner.run_turn(app, options),
        None => stream_of([
            TurnEvent::Error(ErrorEvent::new(TURN_LAYER_NOT_AVAILABLE).with_recoverable(false)),
            TurnEvent::done("error"),
        ]),
    }
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::ai::turn_types::{SessionCallback, TurnMessage};
    use crate::lib::tool_api::ToolContext;
    use crate::testkit::test_app;

    async fn collect(stream: TurnStream) -> Vec<TurnEvent> {
        stream.map(|item| item.expect("the stream failed")).collect().await
    }

    #[tokio::test]
    async fn with_nothing_installed_a_turn_is_an_error_and_one_done() {
        let t = test_app();
        assert!(turn_runner(&t.app).is_none());
        let events = collect(chat_stream(&t.app, TurnOptions::default())).await;
        assert_eq!(
            serde_json::to_value(&events).unwrap(),
            json!([
                { "type": "error", "message": "Tarsee's turn layer isn't available, so this turn can't run.", "recoverable": false },
                { "type": "done", "stopReason": "error" }
            ])
        );
    }

    /// `test/turn.test.js` "chatStream is runTurn: every option reaches the turn layer".
    #[tokio::test]
    async fn chat_stream_is_the_installed_runner_and_every_option_reaches_it() {
        let t = test_app();
        let seen = Arc::new(parking_lot::Mutex::new(Vec::<TurnOptions>::new()));
        let record = seen.clone();
        install_turn_runner(
            &t.app,
            Arc::new(move |_app: &App, options: TurnOptions| {
                record.lock().push(options);
                stream_of([TurnEvent::text("Hi"), TurnEvent::done("end_turn")])
            }),
        );
        let stored = Arc::new(parking_lot::Mutex::new(None::<String>));
        let store = stored.clone();
        let options = TurnOptions {
            messages: vec![TurnMessage::user("hello")],
            provider: Some("deepseek".into()),
            model: Some("deepseek:deepseek-flash".into()),
            effort: Some("high".into()),
            background: true,
            tool_ctx: ToolContext::for_conversation("conv-1"),
            session_id: Some("raw-1".into()),
            on_session_id: Some(SessionCallback::new(move |handle| {
                *store.lock() = Some(handle.to_string())
            })),
            max_turns: Some(7),
            max_budget_usd: Some(0.25),
            thinking_summaries: Some(true),
            queued_note: Some(false),
            live_conversation_id: Some("cron:daily".into()),
            live_source: Some("cron".into()),
            live_disabled: true,
            live_turn_id: Some("turn-9".into()),
            verify: true,
            engine: Some("codex".into()),
            cwd: Some("scratch".into()),
            ..Default::default()
        };
        let stop = options.signal.clone();
        let events = collect(chat_stream(&t.app, options)).await;
        assert_eq!(events, vec![TurnEvent::text("Hi"), TurnEvent::done("end_turn")]);

        let got = seen.lock().remove(0);
        assert_eq!(got.messages, vec![TurnMessage::user("hello")]);
        assert_eq!(got.provider.as_deref(), Some("deepseek"));
        assert_eq!(got.model.as_deref(), Some("deepseek:deepseek-flash"));
        assert_eq!(got.effort.as_deref(), Some("high"));
        assert!(got.background && got.live_disabled && got.verify);
        assert_eq!(got.tool_ctx.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(got.session_id.as_deref(), Some("raw-1"));
        assert_eq!((got.max_turns, got.max_budget_usd), (Some(7), Some(0.25)));
        assert_eq!((got.thinking_summaries, got.queued_note), (Some(true), Some(false)));
        assert_eq!(got.live_conversation_id.as_deref(), Some("cron:daily"));
        assert_eq!(got.live_source.as_deref(), Some("cron"));
        assert_eq!(got.live_turn_id.as_deref(), Some("turn-9"));
        assert_eq!(got.engine.as_deref(), Some("codex"));
        assert_eq!(got.cwd.as_deref(), Some(std::path::Path::new("scratch")));
        // The callback and the stop are the caller's own, not copies that went nowhere.
        got.on_session_id.as_ref().unwrap().call("deepseek/cc/deepseek:raw-2");
        assert_eq!(stored.lock().as_deref(), Some("deepseek/cc/deepseek:raw-2"));
        stop.cancel();
        assert!(got.signal.is_cancelled());
    }

    #[tokio::test]
    async fn installing_again_replaces_the_runner_and_each_app_has_its_own() {
        let a = test_app();
        let b = test_app();
        let says = |word: &'static str| {
            Arc::new(move |_: &App, _: TurnOptions| stream_of([TurnEvent::text(word), TurnEvent::done("end_turn")]))
        };
        install_turn_runner(&a.app, says("first"));
        install_turn_runner(&a.app, says("second"));
        assert_eq!(
            collect(chat_stream(&a.app, TurnOptions::default())).await[0],
            TurnEvent::text("second")
        );
        assert_eq!(
            collect(chat_stream(&b.app, TurnOptions::default())).await[0].event_type(),
            "error"
        );
    }

    #[tokio::test]
    async fn a_runner_that_fails_gives_the_caller_an_err_item() {
        let t = test_app();
        install_turn_runner(
            &t.app,
            Arc::new(|_: &App, _: TurnOptions| -> TurnStream {
                futures::stream::iter(vec![
                    Ok(TurnEvent::text("half")),
                    Err(anyhow::anyhow!("the turn layer broke")),
                ])
                .boxed()
            }),
        );
        let items: Vec<_> = chat_stream(&t.app, TurnOptions::default()).collect().await;
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].as_ref().unwrap_err().to_string(), "the turn layer broke");
    }
}
