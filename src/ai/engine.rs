//! What the turn layer calls on an engine, and where it finds one.
//!
//! Two engines run Tarsee's turns, each with its own tool loop: Claude Code (`providers/claude_code.rs`, package G1)
//! and Codex (`providers/codex.rs`, package G2). The turn layer (`ai/turn.rs`, package G3) reaches them by name and
//! calls `run(opts)`, which in Node was an async generator of Tarsee's events. This file is that contract:
//!
//! - [`Engine`]: `run(app, opts)` gives the stream of events.
//! - [`EngineOptions`]: what the turn layer passes (`ai/turn.js` `runAttempt`), and [`Target`], the AI a turn runs on
//!   (`ai/turn.js` `resolveTarget`).
//! - [`EngineRegistry`]: the Node `registerEngine` and `loadEngine`, as a service of the `App` instead of a
//!   module-level map. Tests put a scripted engine in (`testkit::FakeEngine`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::turn_types::{ContentBlock, SessionCallback, SystemParts, TurnMessage, TurnStream};
use crate::app::App;
use crate::lib::tool_api::ToolContext;

/// The Claude Code engine's name (`ai/engine-env.js` `CLAUDE_CODE`).
pub const CLAUDE_CODE: &str = "claude-code";
/// The Codex engine's name (`ai/engine-env.js` `CODEX`).
pub const CODEX: &str = "codex";
/// The engines Tarsee has (`ai/turn.js` `ENGINE_LOADERS`): a name outside this list is no engine at all.
pub const ENGINE_NAMES: [&str; 2] = [CLAUDE_CODE, CODEX];

/// An engine's events: text, thinking, tool_use, tool_result, usage, step, error and exactly one done. An `Err` item
/// is the engine crashing (the Node generator throwing): the turn layer reports it as an error and a done.
pub type EngineStream = TurnStream;

/// An agent engine: the Node engine module's `run(opts)`.
///
/// `run` starts nothing by itself, like calling an async generator: the work happens as the stream is read. The
/// stream ends after its one `done`. When `opts.signal` is cancelled the engine stops what it started and ends with
/// `done{aborted}` and no error. Dropping the stream before its end stops the engine too (the generator's
/// `finally`): no engine process may outlive it.
pub trait Engine: Send + Sync {
    fn run(&self, app: &App, opts: EngineOptions) -> EngineStream;
}

/// The AI a turn runs on (`ai/turn.js` `resolveTarget`, `targetFor`): `{ provider, providerId, storageId, kind,
/// engine, model, effort, vendor, homeKey, caps, label, providerLabel }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Target {
    /// The provider's public id: "claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local".
    pub provider: String,
    /// The same id again (the Node object had both names; the engines read `providerId ?? provider`).
    pub provider_id: String,
    /// The id the provider's settings are stored under (`ai.<storageId>.model`): "claude-code" for the Claude plan.
    pub storage_id: String,
    /// "subscription" (a sign-in plan), "key" or "local".
    pub kind: String,
    /// "claude-code" or "codex". `None` for a model that must be verified first (the turn layer refuses those, so
    /// an engine never sees it).
    pub engine: Option<String>,
    /// The model, by the provider's own id. `None`: the provider's own default (the ChatGPT account's).
    pub model: Option<String>,
    /// The thinking effort, already stepped to a level the model takes. `None`: none is sent.
    pub effort: Option<String>,
    /// The model's maker: OpenRouter's "anthropic", "openai", ...; else the provider's id. A session resumes only
    /// on the same maker.
    pub vendor: Option<String>,
    /// The engine home's short name in a session handle: "cc" or "cx" (`ai/engine-env.js` `homeKeyFor`).
    pub home_key: Option<String>,
    /// What the model can do (`provider-registry.js` `capsFor`).
    pub caps: TargetCaps,
    /// The model's name for people: "Claude Sonnet", "DeepSeek Flash".
    pub label: String,
    /// The provider's name for people: "Claude plan", "OpenAI API key".
    pub provider_label: String,
}

impl Target {
    /// The provider's id, by either name (`target.providerId ?? target.provider`).
    pub fn provider_id(&self) -> &str {
        if self.provider_id.is_empty() {
            &self.provider
        } else {
            &self.provider_id
        }
    }
}

/// What a model on a provider can do: `{ vision, pdf, thinkingSummaries, nativeBudget, streaming }`
/// (`provider-registry.js` `capsFor`). All false for a model nothing is known about.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TargetCaps {
    /// It sees pictures.
    pub vision: bool,
    /// It reads PDF blocks itself (Claude models on Claude Code); elsewhere the text is taken out for it.
    pub pdf: bool,
    /// It can give summaries of its thinking.
    pub thinking_summaries: bool,
    /// The engine keeps a dollar ceiling itself (the Claude providers); elsewhere the turn layer does.
    pub native_budget: bool,
    /// Replies arrive word by word (Claude Code), not a message at a time (Codex).
    pub streaming: bool,
}

/// Tarsee's tools for a turn: the loopback MCP endpoint and this turn's token (`ai/mcp-http.js` `grantTurn`'s
/// `{ url, token }`). The one grant type: the turn layer hands it to an engine here, and the Codex engine passes it
/// on in `providers::codex_options::CodexContext::mcp`. `Debug` leaves the token out: it opens Tarsee's tools.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpGrant {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for McpGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpGrant")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

/// The Node `sessionId` option of an engine, which meant three things.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SessionChoice {
    /// No `sessionId` was passed: the engine works the session out from `session_handle`, resuming it only when it
    /// is this provider's own (a caller with only a stored handle).
    #[default]
    Unset,
    /// `sessionId: null`: start a fresh session on purpose, whatever `session_handle` says.
    Fresh,
    /// `sessionId: "<raw id>"`: the session the turn layer chose to resume.
    Resume(String),
}

impl SessionChoice {
    /// `Fresh` for `None`, `Resume` for an id: what the turn layer passes.
    pub fn from_raw(raw: Option<String>) -> Self {
        match raw {
            Some(id) => SessionChoice::Resume(id),
            None => SessionChoice::Fresh,
        }
    }

    /// The raw id to resume, if one was chosen.
    pub fn raw(&self) -> Option<&str> {
        match self {
            SessionChoice::Resume(id) => Some(id),
            _ => None,
        }
    }
}

/// The Node `media` option of an engine.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineMedia {
    /// The prompt's image and document blocks, already adapted to the model. What the turn layer passes (an empty
    /// list for a prompt with none).
    Blocks(Vec<ContentBlock>),
    /// `ai/media.js` `adaptMedia`'s result as it is: the media blocks, and the words that go with them (`None`:
    /// the last message's own). Only the Claude engine takes this form.
    Adapted {
        media: Vec<ContentBlock>,
        text: Option<String>,
    },
}

/// What the turn layer passes an engine's `run` (`ai/turn.js` `runAttempt`). A caller that runs an engine directly
/// (its own tests) fills in what it needs and leaves the rest: `..Default::default()`.
///
/// The Node object also had `mcp` (the same value as `mcpGrant`), `onSessionId` (the same function as
/// `onSessionHandle`) and, from the engines' own tests, `deps` (each engine's seams, which are its own to define).
#[derive(Debug, Clone, Default)]
pub struct EngineOptions {
    /// The AI to run on.
    pub target: Target,
    /// `target.model` again.
    pub model: Option<String>,
    /// `target.effort` again.
    pub effort: Option<String>,
    /// The chat's messages; the last one with role "user" is the prompt, with the handoff and the queued note
    /// already in front of its words and its media adapted to the model.
    pub messages: Vec<TurnMessage>,
    /// The whole system prompt: the stable part and the volatile part joined.
    pub system_prompt: String,
    /// The system prompt in its two parts. The turn layer always passes it; `None` (a direct caller) means
    /// `system_prompt` is all there is.
    pub system_parts: Option<SystemParts>,
    /// The prompt's media. `None` (a direct caller): the engine takes the last message's own blocks.
    pub media: Option<EngineMedia>,
    /// Stops the turn: the engine ends with `done{aborted}`.
    pub signal: CancellationToken,
    /// Tarsee's tool context, for the tools the engine runs.
    pub tool_ctx: ToolContext,
    /// The chat's stored session handle, when the turn resumes; `None` for a fresh session.
    pub session_handle: Option<String>,
    /// The raw session id the turn layer chose to resume, or its choice to start fresh.
    pub session_id: SessionChoice,
    /// Called once with the session the turn runs in, for the turn layer to tag and store: a raw id from Claude
    /// Code, a tagged handle from Codex. (The Node `onSessionHandle`, and `onSessionId` when there was no
    /// `onSessionHandle`.)
    pub on_session_handle: Option<SessionCallback>,
    /// The ceiling on the engine's own turns (for Codex, on the tools it starts). `None` (a direct caller): the
    /// engine's own default, 50.
    pub max_turns: Option<u32>,
    /// The dollar ceiling, only for an engine that keeps one itself (`target.caps.native_budget`); `None`
    /// otherwise, and the turn layer's guard applies.
    pub max_budget_usd: Option<f64>,
    /// Summaries of the model's thinking: asked for, and the model gives them.
    pub thinking_summaries: bool,
    /// Always false from the turn layer, which has already put the queued note on the prompt: the engine is told
    /// not to add it again.
    pub queued_note: bool,
    /// The turn's id on the live timeline (it also names the folder long tool results go in).
    pub turn_id: Option<String>,
    /// Tarsee's tools over loopback MCP, for Codex. `None` for Claude Code, and for a direct caller of Codex, which
    /// then makes a grant of its own. (The Node `mcpGrant`, also passed as `mcp`.)
    pub mcp_grant: Option<McpGrant>,
    /// Where the turn came from ("web", "telegram", "cron", ...).
    pub live_source: Option<String>,
    /// Whether this is unattended work.
    pub background: bool,
    /// The folder the agent works in, when the caller has its own; `None`: the workspace.
    pub cwd: Option<PathBuf>,
}

// --- The registry ------------------------------------------------------------------------------------------------

/// Why [`EngineRegistry::load_engine`] found no engine. The messages are the Node ones.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EngineLoadError {
    /// A name that is neither "claude-code" nor "codex".
    #[error("No AI engine called {}", serde_json::Value::String(.0.clone()))]
    Unknown(String),
    /// One of Tarsee's engines, but nothing was installed under its name (in Node: a module with no `run()`).
    #[error("The {0} engine can't run turns (it has no run())")]
    NotInstalled(String),
}

/// The engines of one app: the Node `registeredEngines` map and `ENGINE_LOADERS`, as a service.
///
/// Two layers, as in Node. An engine's own module is *installed* under its name once, at boot
/// ([`EngineRegistry::install`]: what `ENGINE_LOADERS` imported on first use). A test, or an engine loaded some other
/// way, is *registered* over it and taken out again ([`EngineRegistry::register_engine`]).
#[derive(Default)]
pub struct EngineRegistry {
    registered: RwLock<HashMap<String, Arc<dyn Engine>>>,
    installed: RwLock<HashMap<String, Arc<dyn Engine>>>,
}

impl EngineRegistry {
    /// The app's engine registry, made empty on first use.
    pub fn of(app: &App) -> Arc<EngineRegistry> {
        app.get_or_init(EngineRegistry::default)
    }

    /// Installs an engine's own module under its name ("claude-code", "codex"), replacing one installed before.
    /// `providers/claude_code.rs` and `providers/codex.rs` are installed at boot.
    pub fn install(&self, name: &str, engine: Arc<dyn Engine>) {
        self.installed.write().insert(name.to_string(), engine);
    }

    /// Puts an engine in for a name; `None` takes it out again, so the engine's own module runs. For tests and for
    /// an engine loaded some other way (`ai/turn.js` `registerEngine`).
    pub fn register_engine(&self, name: &str, engine: Option<Arc<dyn Engine>>) {
        match engine {
            Some(engine) => {
                self.registered.write().insert(name.to_string(), engine);
            }
            None => {
                self.registered.write().remove(name);
            }
        }
    }

    /// The engine for a name: one registered, else the engine's own module (`ai/turn.js` `loadEngine`).
    pub fn load_engine(&self, name: &str) -> Result<Arc<dyn Engine>, EngineLoadError> {
        if let Some(engine) = self.registered.read().get(name) {
            return Ok(engine.clone());
        }
        if !ENGINE_NAMES.contains(&name) {
            return Err(EngineLoadError::Unknown(name.to_string()));
        }
        match self.installed.read().get(name) {
            Some(engine) => Ok(engine.clone()),
            None => Err(EngineLoadError::NotInstalled(name.to_string())),
        }
    }
}

/// `registerEngine(name, mod)` on the app's registry.
pub fn register_engine(app: &App, name: &str, engine: Option<Arc<dyn Engine>>) {
    EngineRegistry::of(app).register_engine(name, engine);
}

/// `loadEngine(name)` on the app's registry.
pub fn load_engine(app: &App, name: &str) -> Result<Arc<dyn Engine>, EngineLoadError> {
    EngineRegistry::of(app).load_engine(name)
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::ai::turn_types::{TurnEvent, stream_of};
    use crate::testkit::test_app;

    /// An engine that says its own name and ends.
    struct Named(&'static str);

    impl Engine for Named {
        fn run(&self, _app: &App, opts: EngineOptions) -> EngineStream {
            let said = format!("{} ran {}", self.0, opts.target.provider_id());
            stream_of([TurnEvent::text(said), TurnEvent::done("end_turn")])
        }
    }

    async fn words(engine: Arc<dyn Engine>, app: &App) -> String {
        let opts = EngineOptions {
            target: Target {
                provider: "claude".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        let events: Vec<_> = engine.run(app, opts).collect().await;
        match events[0].as_ref().unwrap() {
            TurnEvent::Text(text) => text.content.clone(),
            other => panic!("not text: {other:?}"),
        }
    }

    #[test]
    fn with_nothing_installed_a_known_name_cannot_run_and_an_unknown_one_is_no_engine() {
        let t = test_app();
        let err = load_engine(&t.app, "claude-code").err().unwrap();
        assert_eq!(err, EngineLoadError::NotInstalled("claude-code".into()));
        assert_eq!(
            err.to_string(),
            "The claude-code engine can't run turns (it has no run())"
        );
        let err = load_engine(&t.app, "gemini").err().unwrap();
        assert_eq!(err.to_string(), "No AI engine called \"gemini\"");
        // (JSON.stringify(name): a quote in the name is escaped.)
        assert_eq!(
            load_engine(&t.app, "a\"b").err().unwrap().to_string(),
            "No AI engine called \"a\\\"b\""
        );
    }

    #[tokio::test]
    async fn a_registered_engine_wins_over_the_installed_one_and_null_takes_it_out_again() {
        let t = test_app();
        EngineRegistry::of(&t.app).install(CLAUDE_CODE, Arc::new(Named("real")));
        assert_eq!(
            words(load_engine(&t.app, "claude-code").unwrap(), &t.app).await,
            "real ran claude"
        );

        register_engine(&t.app, "claude-code", Some(Arc::new(Named("scripted"))));
        assert_eq!(
            words(load_engine(&t.app, "claude-code").unwrap(), &t.app).await,
            "scripted ran claude"
        );
        assert!(load_engine(&t.app, "codex").is_err(), "the other name is untouched");

        register_engine(&t.app, "claude-code", None);
        assert_eq!(
            words(load_engine(&t.app, "claude-code").unwrap(), &t.app).await,
            "real ran claude"
        );
    }

    #[tokio::test]
    async fn an_engine_registered_under_any_name_is_found() {
        let t = test_app();
        register_engine(&t.app, "experimental", Some(Arc::new(Named("other"))));
        assert_eq!(
            words(load_engine(&t.app, "experimental").unwrap(), &t.app).await,
            "other ran claude"
        );
        register_engine(&t.app, "experimental", None);
        assert_eq!(
            load_engine(&t.app, "experimental").err().unwrap(),
            EngineLoadError::Unknown("experimental".into())
        );
    }

    #[test]
    fn each_app_has_its_own_engines() {
        let a = test_app();
        let b = test_app();
        register_engine(&a.app, "codex", Some(Arc::new(Named("a"))));
        assert!(load_engine(&a.app, "codex").is_ok());
        assert!(load_engine(&b.app, "codex").is_err());
    }

    /// The targets the Node turn layer handed its engines (captured from `ai/turn.js` `resolveTarget` with the
    /// Claude plan signed in, and with an OpenAI key).
    #[test]
    fn a_target_is_the_node_object() {
        let node = json!({
            "provider": "claude", "providerId": "claude", "storageId": "claude-code", "kind": "subscription",
            "engine": "claude-code", "model": "sonnet", "effort": "medium", "vendor": "claude", "homeKey": "cc",
            "caps": { "vision": true, "pdf": true, "thinkingSummaries": true, "nativeBudget": true, "streaming": true },
            "label": "Claude Sonnet", "providerLabel": "Claude plan"
        });
        let target: Target = serde_json::from_value(node.clone()).unwrap();
        assert_eq!(target.storage_id, "claude-code");
        assert_eq!(target.home_key.as_deref(), Some("cc"));
        assert!(target.caps.native_budget && target.caps.thinking_summaries);
        assert_eq!(serde_json::to_string(&target).unwrap(), node.to_string());

        let codex = json!({
            "provider": "openai", "providerId": "openai", "storageId": "openai", "kind": "key", "engine": "codex",
            "model": "gpt-6.1-sol", "effort": "medium", "vendor": "openai", "homeKey": "cx",
            "caps": { "vision": true, "pdf": false, "thinkingSummaries": true, "nativeBudget": false, "streaming": false },
            "label": "GPT-6.1 Sol", "providerLabel": "OpenAI API key"
        });
        let target: Target = serde_json::from_value(codex.clone()).unwrap();
        assert_eq!(
            target.caps,
            TargetCaps {
                vision: true,
                thinking_summaries: true,
                ..Default::default()
            }
        );
        assert_eq!(serde_json::to_string(&target).unwrap(), codex.to_string());
    }

    #[test]
    fn a_target_from_a_direct_caller_names_its_provider_either_way() {
        // The engines' own tests pass `{ providerId, model }` or `{ provider, model }`.
        let by_id: Target =
            serde_json::from_value(json!({"providerId": "deepseek", "model": "deepseek-flash"})).unwrap();
        assert_eq!(by_id.provider_id(), "deepseek");
        let by_name: Target = serde_json::from_value(json!({"provider": "openai"})).unwrap();
        assert_eq!(by_name.provider_id(), "openai");
        assert_eq!(by_name.model, None);
        assert_eq!(Target::default().provider_id(), "");
    }

    #[test]
    fn the_session_choice_keeps_the_three_meanings_of_session_id() {
        assert_eq!(SessionChoice::default(), SessionChoice::Unset);
        assert_eq!(SessionChoice::from_raw(None), SessionChoice::Fresh);
        assert_eq!(SessionChoice::from_raw(Some("raw-1".into())).raw(), Some("raw-1"));
        assert_eq!(SessionChoice::Fresh.raw(), None);
        assert_eq!(SessionChoice::Unset.raw(), None);
    }

    #[test]
    fn options_start_empty_and_a_default_signal_is_never_cancelled() {
        let opts = EngineOptions::default();
        assert!(!opts.signal.is_cancelled());
        assert_eq!(opts.session_id, SessionChoice::Unset);
        assert!(opts.media.is_none() && opts.mcp_grant.is_none() && opts.max_turns.is_none());
        let copy = opts.clone();
        opts.signal.cancel();
        assert!(copy.signal.is_cancelled(), "a copy shares the stop");
    }
}
