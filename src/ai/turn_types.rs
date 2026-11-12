//! The data of a turn: the events a turn yields, the messages it is given, and the options a caller starts it with.
//!
//! The Node version passed plain objects around (`{ type: "text", content }`, `{ role: "user", content }`,
//! `runTurn({ messages, toolCtx, ... })`). About twenty files read and wrote them, so they are written down once here
//! and every package of the port builds against these types: the turn layer (`ai/turn.rs`), the two engines
//! (`ai/providers/`), the channels, the routes, scheduled tasks and subagents.
//!
//! - [`TurnEvent`]: what an engine's `run` and the turn layer's `run_turn` yield. It serialises to exactly the
//!   object the Node code yielded, and anything it does not know is kept, not dropped.
//! - [`TurnMessage`], [`MessageContent`], [`ContentBlock`]: the chat's messages as callers and engines exchange them.
//! - [`TurnOptions`]: what a caller passes to `ai::router::chat_stream` (the Node `chatStream` / `runTurn` options).
//! - [`TurnStream`]: the async generator, as a stream.
//!
//! `docs/rust-port/INTERFACES.md` has an example of each.

use std::path::PathBuf;
use std::sync::Arc;

use futures::StreamExt;
use futures::stream::{self, BoxStream};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::lib::tool_api::ToolContext;

// --- The stream --------------------------------------------------------------------------------------------------

/// What `for await (const event of chatStream(opts))` read from: a turn's events, in order.
///
/// An item is `Err` where the Node generator threw (an engine that crashed, a bug in the turn layer). The turn layer
/// itself turns an engine's crash into an `error` event and a `done`, so its callers see `Err` only when the turn
/// layer itself failed; they report it the way their `catch` did. Nothing comes after an `Err`.
///
/// Dropping the stream is the generator's `return()`: whatever produces it must stop its work then (the engine's
/// process, the turn's registration), as the Node `finally` blocks did.
pub type TurnStream = BoxStream<'static, anyhow::Result<TurnEvent>>;

/// A stream that yields these events and ends: a script, a refusal, a test's answer.
pub fn stream_of(events: impl IntoIterator<Item = TurnEvent>) -> TurnStream {
    let events: Vec<anyhow::Result<TurnEvent>> = events.into_iter().map(Ok).collect();
    stream::iter(events).boxed()
}

/// A sender and the stream of what is sent on it, for a turn that runs in a task of its own. The stream ends when
/// every sender is dropped. `send` fails once the stream was dropped: the task must stop then.
pub fn turn_channel(buffer: usize) -> (mpsc::Sender<anyhow::Result<TurnEvent>>, TurnStream) {
    let (tx, rx) = mpsc::channel(buffer.max(1));
    (tx, stream_from_receiver(rx))
}

/// The stream of what arrives on `rx`.
pub fn stream_from_receiver(rx: mpsc::Receiver<anyhow::Result<TurnEvent>>) -> TurnStream {
    stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) }).boxed()
}

/// The JavaScript `AbortError`: a stream item's error when what was awaited was stopped rather than failed.
/// `lib/background-turn.js` told it apart (`err.name === "AbortError"`); find it with `err.is::<AbortError>()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("This operation was aborted")]
pub struct AbortError;

// --- Events ------------------------------------------------------------------------------------------------------

/// One event of a turn: `{ type: "...", ... }`.
///
/// The engines (`providers/claude_code.rs`, `providers/codex.rs`) yield `text`, `thinking`, `tool_use`,
/// `tool_result`, `usage`, `step`, `error` and exactly one `done`. The turn layer (`ai/turn.rs`) puts a `route`
/// first, keeps the `step`s for the live timeline (they never reach its caller), passes the rest on, and ends with
/// exactly one `done`, with an `error` before every `done` that is not a success or a stop.
///
/// Serialising gives the Node object: `type` first, then the fields. A field the Node code left out is left out, and
/// one it set to `null` is `null`. Every variant keeps the fields it has no name for in `extra`, and an event of a
/// type not listed here (or one whose fields have another shape) is kept whole in [`TurnEvent::Other`]: the turn layer
/// passes on what it does not know, as the Node one did. Reading never fails: see [`TurnEvent::from_value`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum TurnEvent {
    /// Which AI the turn runs on. First on every turn that starts; again (with `backup`) when the backup model
    /// takes over. Callers keep the last one: it names the AI in their error notes and on the saved reply.
    Route(RouteEvent),
    /// Words of the reply, as they come.
    Text(TextEvent),
    /// The model started or stopped thinking.
    Thinking(ThinkingEvent),
    /// The engine started a tool.
    ToolUse(ToolUseEvent),
    /// A tool finished.
    ToolResult(ToolResultEvent),
    /// The turn's tokens, and its cost when the engine knows it.
    Usage(UsageEvent),
    /// A line for the dashboard's live timeline (`lib/live-bus.js`). Engines yield them; the turn layer publishes
    /// them and never passes one on.
    Step(StepEvent),
    /// Something went wrong, in words for the person.
    Error(ErrorEvent),
    /// The end of the turn. Exactly one, last.
    Done(DoneEvent),
    /// An event of any other type, or one of the types above with fields of another shape: kept as it is.
    #[serde(untagged)]
    Other(Value),
}

impl TurnEvent {
    /// `{ type: "text", content }`.
    pub fn text(content: impl Into<String>) -> Self {
        TurnEvent::Text(TextEvent {
            content: content.into(),
            extra: Map::new(),
        })
    }

    /// `{ type: "thinking", status }`.
    pub fn thinking(status: ThinkingStatus) -> Self {
        TurnEvent::Thinking(ThinkingEvent {
            status,
            extra: Map::new(),
        })
    }

    /// `{ type: "tool_use", id, name, input }`.
    pub fn tool_use(id: impl Into<String>, name: impl Into<String>, input: Value) -> Self {
        TurnEvent::ToolUse(ToolUseEvent {
            id: id.into(),
            name: name.into(),
            input,
            extra: Map::new(),
        })
    }

    /// `{ type: "tool_result", id, ok, result }`.
    pub fn tool_result(id: impl Into<String>, ok: bool, result: impl Into<String>) -> Self {
        TurnEvent::ToolResult(ToolResultEvent {
            id: id.into(),
            ok,
            result: result.into(),
            extra: Map::new(),
        })
    }

    /// `{ type: "usage", usage }`, with no cost.
    pub fn usage(usage: Usage) -> Self {
        TurnEvent::Usage(UsageEvent {
            usage,
            cost_usd: None,
            cost_exact: false,
            extra: Map::new(),
        })
    }

    /// `{ type: "step", kind }`; add its fields with [`StepEvent::with`].
    pub fn step(step: StepEvent) -> Self {
        TurnEvent::Step(step)
    }

    /// `{ type: "error", message }`; add the rest with [`ErrorEvent`]'s setters.
    pub fn error(message: impl Into<String>) -> Self {
        TurnEvent::Error(ErrorEvent::new(message))
    }

    /// `{ type: "done", stopReason }`.
    pub fn done(stop_reason: impl Into<String>) -> Self {
        TurnEvent::Done(DoneEvent::new(stop_reason))
    }

    /// The event's `type`: "route", "text", ... For [`TurnEvent::Other`], its own `type` ("" when it has none).
    pub fn event_type(&self) -> &str {
        match self {
            TurnEvent::Route(_) => "route",
            TurnEvent::Text(_) => "text",
            TurnEvent::Thinking(_) => "thinking",
            TurnEvent::ToolUse(_) => "tool_use",
            TurnEvent::ToolResult(_) => "tool_result",
            TurnEvent::Usage(_) => "usage",
            TurnEvent::Step(_) => "step",
            TurnEvent::Error(_) => "error",
            TurnEvent::Done(_) => "done",
            TurnEvent::Other(value) => value.get("type").and_then(Value::as_str).unwrap_or(""),
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(self, TurnEvent::Done(_))
    }

    /// The event for a JSON object, as the Node code would have yielded it. Never fails: what fits no variant (a
    /// `type` that is not one of Tarsee's, or is not text; a field of another shape; no object at all) is
    /// [`TurnEvent::Other`]. Deserialising a `TurnEvent` does exactly this.
    pub fn from_value(value: Value) -> Self {
        let event = match value.get("type").and_then(Value::as_str) {
            Some("route") => without_type(&value).map(TurnEvent::Route),
            Some("text") => without_type(&value).map(TurnEvent::Text),
            Some("thinking") => without_type(&value).map(TurnEvent::Thinking),
            Some("tool_use") => without_type(&value).map(TurnEvent::ToolUse),
            Some("tool_result") => without_type(&value).map(TurnEvent::ToolResult),
            Some("usage") => without_type(&value).map(TurnEvent::Usage),
            Some("step") => without_type(&value).map(TurnEvent::Step),
            Some("error") => without_type(&value).map(TurnEvent::Error),
            Some("done") => without_type(&value).map(TurnEvent::Done),
            _ => None,
        };
        event.unwrap_or(TurnEvent::Other(value))
    }

    /// The event as the JSON object the Node code yielded.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

impl<'de> Deserialize<'de> for TurnEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(TurnEvent::from_value(Value::deserialize(deserializer)?))
    }
}

/// An object's fields without its `type`, read as `T`; `None` when it is no object or does not fit.
fn without_type<T: DeserializeOwned>(value: &Value) -> Option<T> {
    let mut fields = value.as_object()?.clone();
    fields.shift_remove("type");
    serde_json::from_value(Value::Object(fields)).ok()
}

/// `{ type: "route", provider, engine, model, label, providerLabel, effort, vendor, streaming, backup }`
/// (`ai/turn.js` `routeEvent`).
///
/// The turn layer always sets every field, and every field is always written: `null` where `engine`, `model`,
/// `effort` or `vendor` is none. Reading is lenient, because tests script partial ones: a field left out reads as
/// `""` (`provider`, `label`, `providerLabel`), none (the four above) or false (`streaming`, `backup`), and is
/// written back that way, not left out again.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RouteEvent {
    /// The provider's public id: "claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local".
    pub provider: String,
    /// "claude-code" or "codex".
    pub engine: Option<String>,
    /// The model that runs; `None` when the ChatGPT account's own default does (Codex picks).
    pub model: Option<String>,
    /// The model's name for people: "Claude Sonnet", "DeepSeek Flash".
    pub label: String,
    /// The provider's name for people: "Claude plan", "OpenAI API key".
    pub provider_label: String,
    /// The thinking effort the turn runs at, or `None`.
    pub effort: Option<String>,
    /// The model's maker (OpenRouter's "anthropic", "openai", ...; else the provider's id).
    pub vendor: Option<String>,
    /// Whether the reply comes word by word (Claude Code) rather than a message at a time (Codex).
    pub streaming: bool,
    /// True when this is the backup model taking over (`ai.backupModel`).
    pub backup: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `{ type: "text", content }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextEvent {
    #[serde(default)]
    pub content: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `{ type: "thinking", status: "start" | "stop" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingEvent {
    pub status: ThinkingStatus,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingStatus {
    Start,
    Stop,
}

impl ThinkingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ThinkingStatus::Start => "start",
            ThinkingStatus::Stop => "stop",
        }
    }
}

/// `{ type: "tool_use", id, name, input }`. The name is Claude Code's on both engines: "Bash", "Write",
/// "mcp__tarsee__tarsee_send_message". The input is the tool's own arguments, free-form.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolUseEvent {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub input: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `{ type: "tool_result", id, ok, result }`: the result's text (the engines cap it at 2,000 characters), for the
/// `tool_use` with the same id.
///
/// The engines give no `name`; `routes/chat.js` and `channels/websocket.js` read `event.name` all the same, so one
/// that is there is kept in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResultEvent {
    #[serde(default)]
    pub id: String,
    /// False when the tool failed. A result that does not say reads as true: callers only ever asked
    /// `event.ok === false`.
    #[serde(default = "yes")]
    pub ok: bool,
    #[serde(default)]
    pub result: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn yes() -> bool {
    true
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// `{ type: "usage", usage, costUsd?, costExact? }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageEvent {
    #[serde(default)]
    pub usage: Usage,
    /// What the turn cost in USD, when the engine knows: the Anthropic key's exact total, OpenRouter's own figure,
    /// or the price table's estimate. Left out when it has none (a plan, Codex).
    #[serde(
        rename = "costUsd",
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js_number::serialize_option"
    )]
    pub cost_usd: Option<f64>,
    /// True when `cost_usd` is the provider's own figure, not an estimate. Written only when true.
    #[serde(rename = "costExact", default, skip_serializing_if = "is_false")]
    pub cost_exact: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A turn's token counts, in the Messages API's names.
///
/// Each count is `None` when the object did not have it, and is left out again when written: both engines always
/// send all four (so does [`Usage::new`]), but a scripted usage may name only some, and what a caller gathers from
/// it must not gain counts nobody sent. [`Usage::default`] is `{}`. Read a count the way the Node code did, with
/// [`Usage::input`] and the others (`usage.input_tokens || 0`), or as the `Option` it is
/// (`usage.output_tokens ?? null`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub cache_creation_input_tokens: Option<u64>,
    /// How full the context is: the last model call's prompt, not the turn's calls summed (`routes/chat.js`'s 95%
    /// check and the page's meter read it). Left out when the engine cannot tell.
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub context_input_tokens: Option<u64>,
    /// Anything else an engine put there (the turn layer also reads a `cost_usd` or `cost` from here).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A count that is there: a whole number. One that is `null` or anything else does not fit, so the event it is in
/// is kept as it is ([`TurnEvent::Other`]) instead of losing the field.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    u64::deserialize(deserializer).map(Some)
}

impl Usage {
    /// All four counts, as an engine reports them.
    pub fn new(
        input_tokens: u64,
        output_tokens: u64,
        cache_read_input_tokens: u64,
        cache_creation_input_tokens: u64,
    ) -> Self {
        Usage {
            input_tokens: Some(input_tokens),
            output_tokens: Some(output_tokens),
            cache_read_input_tokens: Some(cache_read_input_tokens),
            cache_creation_input_tokens: Some(cache_creation_input_tokens),
            context_input_tokens: None,
            extra: Map::new(),
        }
    }

    /// `usage.input_tokens || 0`.
    pub fn input(&self) -> u64 {
        self.input_tokens.unwrap_or(0)
    }

    /// `usage.output_tokens || 0`.
    pub fn output(&self) -> u64 {
        self.output_tokens.unwrap_or(0)
    }

    /// `usage.cache_read_input_tokens || 0`.
    pub fn cache_read(&self) -> u64 {
        self.cache_read_input_tokens.unwrap_or(0)
    }

    /// `usage.cache_creation_input_tokens || 0`.
    pub fn cache_creation(&self) -> u64 {
        self.cache_creation_input_tokens.unwrap_or(0)
    }

    /// `usage = { ...usage, ...event.usage }`: takes over every field `later` has and keeps the rest. Every caller
    /// of a turn gathers its usage this way, starting from `Usage::default()` (`{}`): a later event's counts replace
    /// the earlier ones, a field only an earlier event had (`context_input_tokens`) stays, and a turn with no usage
    /// event leaves `{}`.
    pub fn merge(&mut self, later: &Usage) {
        fn take(mine: &mut Option<u64>, theirs: Option<u64>) {
            if theirs.is_some() {
                *mine = theirs;
            }
        }
        take(&mut self.input_tokens, later.input_tokens);
        take(&mut self.output_tokens, later.output_tokens);
        take(&mut self.cache_read_input_tokens, later.cache_read_input_tokens);
        take(&mut self.cache_creation_input_tokens, later.cache_creation_input_tokens);
        take(&mut self.context_input_tokens, later.context_input_tokens);
        for (name, value) in &later.extra {
            self.extra.insert(name.clone(), value.clone());
        }
    }
}

/// `{ type: "step", kind, ... }`: one line of the dashboard's live timeline, published as it is (without `type`)
/// and drawn by `public/js/live.js`. The kinds and their fields today:
///
/// | kind | fields | from |
/// |---|---|---|
/// | `tool_start` | `id, name, rawName, summary, input` | `lib/tool-steps.js`, `providers/codex-events.js` |
/// | `tool_end` | `id, ok, preview` | the same |
/// | `text` | `text` | the same |
/// | `thinking` | `text` | the same |
/// | `status` | `text` | the same, and the turn layer (the backup model, over budget) |
/// | `usage` | `calls, input, cacheRead, cacheWrite, output, total, outTps, nowTps` | the same |
/// | `route` | `provider, engine, model, label, streaming` | the turn layer (the backup model takes over) |
///
/// The fields stay JSON, in the order they were added: whoever builds a step decides its shape, and the page gets
/// exactly that.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StepEvent {
    #[serde(default)]
    pub kind: String,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl StepEvent {
    pub fn new(kind: impl Into<String>) -> Self {
        StepEvent {
            kind: kind.into(),
            fields: Map::new(),
        }
    }

    /// Adds a field (after the ones already there).
    pub fn with(mut self, name: impl Into<String>, value: impl Into<Value>) -> Self {
        self.fields.insert(name.into(), value.into());
        self
    }

    /// The step for a JSON object that has a `kind` (a `type`, if it has one, is dropped): what
    /// `{ type: "step", ...step }` did with a step from `lib/tool-steps.js`. `None` for anything else.
    pub fn from_value(value: Value) -> Option<Self> {
        let Value::Object(mut fields) = value else {
            return None;
        };
        let kind = match fields.shift_remove("kind") {
            Some(Value::String(kind)) => kind,
            _ => return None,
        };
        fields.shift_remove("type");
        Some(StepEvent { kind, fields })
    }

    pub fn get(&self, name: &str) -> Option<&Value> {
        self.fields.get(name)
    }

    /// The step without its `type`: `{ kind, ... }`, what the turn layer publishes to the live timeline.
    pub fn payload(&self) -> Value {
        let mut out = Map::new();
        out.insert("kind".into(), Value::String(self.kind.clone()));
        for (name, value) in &self.fields {
            out.insert(name.clone(), value.clone());
        }
        Value::Object(out)
    }
}

/// `{ type: "error", message, subtype?, recoverable?, code?, status?, state? }`.
///
/// The message is already in plain words for the person (what went wrong and, when there is one, what to do):
/// callers show it as it is.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ErrorEvent {
    pub message: String,
    /// What kind of stop this is, in the engine's or the turn layer's word: a refusal's reason ("not-ready",
    /// "blocked-keys-only", "needs-verification", "spend-cap"), "error_max_turns", "error_max_budget_usd",
    /// "auth-expired", "session", "tool_use", ...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtype: Option<String>,
    /// From an engine: true when a fresh session would get past it (the turn layer then tries once more). The turn
    /// layer never passes `true` on: an error its caller sees has `false` or no flag at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recoverable: Option<bool>,
    /// What went wrong, as a word: an engine's own (`engine-errors.js`: "expired", "auth", "billing", "rate",
    /// "session", "context", "unknown", ...), which the turn layer reduces to "auth", "billing", "rate",
    /// "unavailable" or "model" where it is one of those.
    ///
    /// Three states, as in the Node objects: no `code` at all (`None`), `code: null` (`Some(None)`: the turn layer
    /// looked and found none) and a word. [`ErrorEvent::code`] reads the word whichever it is.
    #[serde(skip_serializing_if = "Option::is_none", with = "nullable")]
    pub code: Option<Option<String>>,
    /// The HTTP status the provider answered, when the engine knows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// The provider's failure flag for the turn layer to write (`ai.<id>.status`): "sign-in-expired",
    /// "out-of-credit", "error".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ErrorEvent {
    /// `{ type: "error", message }`.
    pub fn new(message: impl Into<String>) -> Self {
        ErrorEvent {
            message: message.into(),
            ..Default::default()
        }
    }

    pub fn with_subtype(mut self, subtype: impl Into<String>) -> Self {
        self.subtype = Some(subtype.into());
        self
    }

    pub fn with_recoverable(mut self, recoverable: bool) -> Self {
        self.recoverable = Some(recoverable);
        self
    }

    /// Sets `code` to a word, or to `null` with `None`.
    pub fn with_code(mut self, code: Option<&str>) -> Self {
        self.code = Some(code.map(str::to_string));
        self
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn with_state(mut self, state: impl Into<String>) -> Self {
        self.state = Some(state.into());
        self
    }

    /// The code word, if there is one (`event.code`, where `null` and absent are both nothing).
    pub fn code(&self) -> Option<&str> {
        self.code.as_ref().and_then(|code| code.as_deref())
    }

    /// `!!event.recoverable`.
    pub fn is_recoverable(&self) -> bool {
        self.recoverable == Some(true)
    }
}

/// `{ type: "done", stopReason, overBudget?, ceilingUsd?, spentUsd? }`.
///
/// Stop reasons: "end_turn" (the only success), "aborted" (a stop: no error comes before it), a refusal's reason
/// ("not-ready", "blocked-keys-only", "needs-verification", "spend-cap"), "auth-expired", "error", "max_turns",
/// "budget", "error_max_budget_usd". Never "tool_use" from the turn layer: engines run their own tools.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DoneEvent {
    /// Empty when the event had none (only a scripted engine does that); see [`DoneEvent::reason`].
    #[serde(rename = "stopReason")]
    pub stop_reason: String,
    /// True on a turn that finished, whose cost (known only at its end: a Codex AI's) went over its ceiling. The
    /// reply stands. Written only when true.
    #[serde(rename = "overBudget", skip_serializing_if = "is_false")]
    pub over_budget: bool,
    /// With `over_budget`: the ceiling in USD.
    #[serde(
        rename = "ceilingUsd",
        skip_serializing_if = "Option::is_none",
        serialize_with = "js_number::serialize_option"
    )]
    pub ceiling_usd: Option<f64>,
    /// With `over_budget`: what the turn cost in USD, when that is known.
    #[serde(
        rename = "spentUsd",
        skip_serializing_if = "Option::is_none",
        serialize_with = "js_number::serialize_option"
    )]
    pub spent_usd: Option<f64>,
    /// Whatever else the engine put on its done: the turn layer passes it on.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl DoneEvent {
    pub fn new(stop_reason: impl Into<String>) -> Self {
        DoneEvent {
            stop_reason: stop_reason.into(),
            ..Default::default()
        }
    }

    /// The stop reason, or `None` when the event had none: `event.stopReason || <the caller's default>`.
    pub fn reason(&self) -> Option<&str> {
        if self.stop_reason.is_empty() {
            None
        } else {
            Some(&self.stop_reason)
        }
    }
}

/// A field that can be left out, `null`, or a value: `Option<Option<T>>`, with
/// `#[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]`.
mod nullable {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(Some(inner)) => inner.serialize(serializer),
            _ => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

/// Numbers as `JSON.stringify` writes them: a whole number without a decimal point (`1`, not `1.0`).
mod js_number {
    use serde::Serializer;

    pub fn serialize_option<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            // 2^53: every whole number up to it is exact in a double.
            Some(n) if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 => serializer.serialize_i64(*n as i64),
            Some(n) => serializer.serialize_f64(*n),
            None => serializer.serialize_none(),
        }
    }
}

// --- Messages ----------------------------------------------------------------------------------------------------

/// One message of the chat, as a caller hands it to a turn: `{ role, content, createdAt? }`. The turn's prompt is
/// the last one with role "user".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TurnMessage {
    /// "user" or "assistant" (anything else is left out of a handoff).
    #[serde(default)]
    pub role: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub content: MessageContent,
    /// When it was written, for the handoff to a fresh session (which leaves out what came before a `/clear`):
    /// the dashboard and ACP pass it, the chat channels do not. Read from `createdAt` or, on a stored row passed as
    /// it is (the external API), `created_at`.
    #[serde(
        rename = "createdAt",
        alias = "created_at",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub created_at: Option<MessageTime>,
    /// Whatever else was on the object (a stored row's `id`, `provider`, `model`, ...).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `null` reads as the default (`m.content ?? ""`).
fn null_as_default<'de, T: Default + Deserialize<'de>, D: Deserializer<'de>>(deserializer: D) -> Result<T, D::Error> {
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

impl TurnMessage {
    pub fn new(role: impl Into<String>, content: impl Into<MessageContent>) -> Self {
        TurnMessage {
            role: role.into(),
            content: content.into(),
            created_at: None,
            extra: Map::new(),
        }
    }

    /// `{ role: "user", content }`.
    pub fn user(content: impl Into<MessageContent>) -> Self {
        Self::new("user", content)
    }

    /// `{ role: "assistant", content }`.
    pub fn assistant(content: impl Into<MessageContent>) -> Self {
        Self::new("assistant", content)
    }

    pub fn at(mut self, created_at: impl Into<MessageTime>) -> Self {
        self.created_at = Some(created_at.into());
        self
    }
}

/// When a message was written: milliseconds since 1970 (`Date.now()`), or text (an ISO time, or SQLite's
/// `datetime('now')`, "YYYY-MM-DD HH:MM:SS", which is UTC).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageTime {
    Millis(i64),
    Text(String),
}

impl From<i64> for MessageTime {
    fn from(ms: i64) -> Self {
        MessageTime::Millis(ms)
    }
}

impl From<String> for MessageTime {
    fn from(text: String) -> Self {
        MessageTime::Text(text)
    }
}

impl From<&str> for MessageTime {
    fn from(text: &str) -> Self {
        MessageTime::Text(text.to_string())
    }
}

/// A message's content: its words, or blocks (words, pictures, PDFs, voice notes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl Default for MessageContent {
    fn default() -> Self {
        MessageContent::Text(String::new())
    }
}

impl From<String> for MessageContent {
    fn from(text: String) -> Self {
        MessageContent::Text(text)
    }
}

impl From<&str> for MessageContent {
    fn from(text: &str) -> Self {
        MessageContent::Text(text.to_string())
    }
}

impl From<Vec<ContentBlock>> for MessageContent {
    fn from(blocks: Vec<ContentBlock>) -> Self {
        MessageContent::Blocks(blocks)
    }
}

impl MessageContent {
    /// The words, when the content is a plain string (`typeof content === "string"`).
    pub fn as_text(&self) -> Option<&str> {
        match self {
            MessageContent::Text(text) => Some(text),
            MessageContent::Blocks(_) => None,
        }
    }

    /// The blocks, when the content is an array.
    pub fn as_blocks(&self) -> Option<&[ContentBlock]> {
        match self {
            MessageContent::Text(_) => None,
            MessageContent::Blocks(blocks) => Some(blocks),
        }
    }
}

/// One block of a message's content, in the Messages API's shape.
///
/// A block of another type, or an image, document or audio block whose `source` holds no base64 `data`, is kept as
/// it is in [`ContentBlock::Other`]; `ai/media.js` left such a block out of the turn.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// `{ type: "text", text }`.
    Text {
        text: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// `{ type: "image", source: { type: "base64", media_type, data } }`.
    Image(MediaBlock),
    /// `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`.
    Document(MediaBlock),
    /// `{ type: "audio", source: { type: "base64", media_type, data } }`: a voice note. No AI takes sound as it is;
    /// the turn layer turns it into its transcript (`ai/media.js`).
    Audio(MediaBlock),
    #[serde(untagged)]
    Other(Value),
}

impl<'de> Deserialize<'de> for ContentBlock {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(ContentBlock::from_value(Value::deserialize(deserializer)?))
    }
}

/// A text block's fields.
#[derive(Deserialize)]
struct TextBlock {
    #[serde(default)]
    text: String,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

impl ContentBlock {
    /// The block for a JSON value. Never fails: what fits no variant is [`ContentBlock::Other`]. Deserialising a
    /// `ContentBlock` does exactly this.
    pub fn from_value(value: Value) -> Self {
        let block = match value.get("type").and_then(Value::as_str) {
            Some("text") => without_type::<TextBlock>(&value).map(|block| ContentBlock::Text {
                text: block.text,
                extra: block.extra,
            }),
            Some("image") => without_type(&value).map(ContentBlock::Image),
            Some("document") => without_type(&value).map(ContentBlock::Document),
            Some("audio") => without_type(&value).map(ContentBlock::Audio),
            _ => None,
        };
        block.unwrap_or(ContentBlock::Other(value))
    }

    pub fn text(text: impl Into<String>) -> Self {
        ContentBlock::Text {
            text: text.into(),
            extra: Map::new(),
        }
    }

    /// An image block holding these base64 bytes.
    pub fn image(media_type: impl Into<String>, data: impl Into<String>) -> Self {
        ContentBlock::Image(MediaBlock::base64(media_type, data))
    }

    /// A document block (a PDF) holding these base64 bytes.
    pub fn document(media_type: impl Into<String>, data: impl Into<String>) -> Self {
        ContentBlock::Document(MediaBlock::base64(media_type, data))
    }

    /// An audio block holding these base64 bytes.
    pub fn audio(media_type: impl Into<String>, data: impl Into<String>) -> Self {
        ContentBlock::Audio(MediaBlock::base64(media_type, data))
    }

    /// The block's `type` ("" when it has none).
    pub fn block_type(&self) -> &str {
        match self {
            ContentBlock::Text { .. } => "text",
            ContentBlock::Image(_) => "image",
            ContentBlock::Document(_) => "document",
            ContentBlock::Audio(_) => "audio",
            ContentBlock::Other(value) => value.get("type").and_then(Value::as_str).unwrap_or(""),
        }
    }

    /// Whether the block is an image, a document or audio by its `type`, with or without data (`ai/turn.js`
    /// `isMediaBlock`).
    pub fn is_media(&self) -> bool {
        matches!(self.block_type(), "image" | "document" | "audio")
    }

    /// The words of a text block.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            ContentBlock::Text { text, .. } => Some(text),
            _ => None,
        }
    }
}

/// The body of an image, document or audio block: `{ source, ... }`. A PDF's name, when the sender gave one, is in
/// `extra` as `name` or `title` (or in the source's `extra` as `name`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaBlock {
    pub source: MediaSource,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl MediaBlock {
    pub fn base64(media_type: impl Into<String>, data: impl Into<String>) -> Self {
        MediaBlock {
            source: MediaSource {
                kind: "base64".into(),
                media_type: Some(media_type.into()),
                data: data.into(),
                extra: Map::new(),
            },
            extra: Map::new(),
        }
    }
}

/// `{ type: "base64", media_type, data }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaSource {
    /// Always "base64" today.
    #[serde(rename = "type", default = "base64")]
    pub kind: String,
    /// "image/png", "application/pdf", "audio/ogg", ... Each reader has its own default for one left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// The bytes, in base64.
    pub data: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn base64() -> String {
    "base64".into()
}

/// The system prompt in its two parts (`lib/build-system-prompt.js` `buildSystemPromptParts`): what stays the same
/// from turn to turn, and what changes (today's log, the checkpoint, the credential inventory). Codex keeps the
/// stable part as its thread's instructions and gets the volatile part with each message.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SystemParts {
    pub stable: String,
    pub volatile: String,
}

// --- Options -----------------------------------------------------------------------------------------------------

/// A caller's `onSessionId(handle)`: called with the handle of the session a turn ran in, to store it.
#[derive(Clone)]
pub struct SessionCallback(Arc<dyn Fn(&str) + Send + Sync>);

impl SessionCallback {
    pub fn new(callback: impl Fn(&str) + Send + Sync + 'static) -> Self {
        SessionCallback(Arc::new(callback))
    }

    pub fn call(&self, handle: &str) {
        (self.0)(handle)
    }
}

impl std::fmt::Debug for SessionCallback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionCallback")
    }
}

/// What a caller passes to start a turn: the Node `chatStream(opts)` / `runTurn(opts)` options (`ai/turn.js`).
/// Everything but `messages` is optional; build it with `..Default::default()`.
///
/// The Node options that are not here: `apiKey`, `baseUrl`, `tools` and `executeTool` (ignored since the engines run
/// their own tools), `sessionHandle` (another name for `sessionId`), `onSessionHandle` (the turn layer only ever
/// called `onSessionId`), and `store` (the settings store now comes from the `App`).
#[derive(Debug, Clone, Default)]
pub struct TurnOptions {
    /// The chat's messages, the turn's prompt last (role "user").
    pub messages: Vec<TurnMessage>,
    /// The caller's own choice of AI: a provider id or alias. `None`: the chat's pick, else the default AI. A
    /// caller that names the default provider has not chosen one.
    pub provider: Option<String>,
    /// The caller's own choice of model: a model id, a tier word ("opus", "sonnet", "haiku", "top"), or a ref
    /// naming its AI ("deepseek:deepseek-flash"). `None`: the chat's pick, else the AI's default (for background
    /// work, its background model).
    pub model: Option<String>,
    /// This message's thinking effort ("low", "medium", "high", "xhigh", "max": `/think`, `!think`). `None`: the
    /// chat's, else `ai.defaultEffort`, else medium. Anything else is ignored.
    pub effort: Option<String>,
    /// Unattended work (a scheduled task, a webhook, the heartbeat, BOOT.md): the background model, a lower turn
    /// ceiling (12), a spending ceiling even when none is named, and a tool context marked with its source
    /// (`tool_ctx.background = live_source`). Default false.
    pub background: bool,
    /// The system prompt as one string, for a caller that has no parts. Ignored when `system_parts` is given.
    pub system_prompt: Option<String>,
    /// The system prompt in its two parts. Default: `system_prompt` as the stable part, nothing volatile.
    pub system_parts: Option<SystemParts>,
    /// For Tarsee's tools, and where the turn layer reads the conversation from (the chat's pick, its session, the
    /// live timeline, Stop). Default: no conversation.
    pub tool_ctx: ToolContext,
    /// The chat's stored session handle (bare for the Claude plan, tagged for the rest: `ai/session-handle.js`).
    /// It is resumed only on the same provider, engine home and maker; `None` starts fresh. (The Node code also
    /// took it as `sessionHandle`.)
    pub session_id: Option<String>,
    /// Called with the handle of the session this turn ran in, tagged as `session-handle.js` says, to store it.
    pub on_session_id: Option<SessionCallback>,
    /// The caller's stop (the Node `signal`). Default: a token nobody cancels.
    pub signal: CancellationToken,
    /// The ceiling on the engine's own turns. Default: 50 for an interactive turn, 12 for background work.
    pub max_turns: Option<u32>,
    /// The turn's spending ceiling in USD: handed to an engine that keeps one itself, else kept by the turn layer.
    /// Default: none for an interactive turn, 0.50 for background work.
    pub max_budget_usd: Option<f64>,
    /// Summaries of the model's thinking for the live view. Default: on for a turn whose `live_source` is "web".
    pub thinking_summaries: Option<bool>,
    /// Whether the prompt waited in its chat's queue (the agent is told so, once). Default: asked of
    /// `lib/conversation-lock.js`. No caller passes it today.
    pub queued_note: Option<bool>,
    /// The id the live timeline shows this turn under: a conversation id, or a background job's ("cron:<id>",
    /// "heartbeat", "boot"). Default: `tool_ctx.conversation_id`.
    pub live_conversation_id: Option<String>,
    /// Where the turn came from: "web", "telegram", "discord", "slack", "whatsapp", "email", "api", "acp",
    /// "agent", "cron", "heartbeat", "boot". It labels the turn on the timeline and in the usage index.
    pub live_source: Option<String>,
    /// Keeps the turn off the live timeline (a subagent, a Verify probe). Default false.
    pub live_disabled: bool,
    /// The id of the turn's line on the timeline. Default: its "Queued" line's when it waited, else a new one. No
    /// caller passes it today.
    pub live_turn_id: Option<String>,
    /// A verification probe (`ai/verify-model.js`): the model runs as named, on `engine`, with its effort as
    /// given, and with no handoff, second try or backup model. Default false.
    pub verify: bool,
    /// With `verify`: the engine to run on ("claude-code" or "codex"), when the provider runs on it. Ignored
    /// otherwise: the registry picks the engine.
    pub engine: Option<String>,
    /// The folder the agent works in, when the caller has its own (Verify's scratch folder). Default: the
    /// workspace.
    pub cwd: Option<PathBuf>,
}

#[cfg(test)]
mod tests;
