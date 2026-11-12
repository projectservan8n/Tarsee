//! Port of `src/lib/tool-steps.js`: live steps for the dashboard, from the engine's own messages.
//!
//! While a turn runs, the engine hands the provider an `assistant` message each time the model writes words or
//! starts a tool (a `tool_use` block), and a `user` message each time a tool finishes (a `tool_result` block
//! carrying the `tool_use_id` it answers). Those are exactly the moments the dashboard wants to show, so each
//! becomes a step on the live timeline (lib/live_bus.rs):
//!
//! ```text
//! { kind: "tool_start", id, name, rawName, summary, input }
//! { kind: "tool_end",   id, ok, preview }
//! { kind: "text",       text }
//! ```
//!
//! Everything shown goes through `redact_secrets`: a command line or a tool's output can carry a key, and this is
//! drawn on a screen and stored for 14 days. The same helpers label the tools of saved replies
//! (lib/message_tools.rs).
//!
//! The messages are the JSON the engine wrote, so they are read as `serde_json::Value`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::lib::redact::redact_secrets;
use crate::util::js::{now_ms, number_to_string, truthy, utf16_len, utf16_tail, utf16_truncate};

const PREVIEW_CHARS: usize = 600;
const INPUT_CHARS: usize = 2000;

/// One live step of a turn, as it goes on the timeline (`kind` says which).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    ToolStart {
        id: String,
        name: String,
        /// The tool's name as the engine has it (absent when the block had none).
        #[serde(rename = "rawName", skip_serializing_if = "Option::is_none")]
        raw_name: Option<String>,
        summary: String,
        input: String,
    },
    ToolEnd {
        id: String,
        ok: bool,
        preview: String,
    },
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    Status {
        text: String,
    },
    Usage(Usage),
}

impl Step {
    /// The step's `kind` as it is written on the timeline.
    pub fn kind(&self) -> &'static str {
        match self {
            Step::ToolStart { .. } => "tool_start",
            Step::ToolEnd { .. } => "tool_end",
            Step::Text { .. } => "text",
            Step::Thinking { .. } => "thinking",
            Step::Status { .. } => "status",
            Step::Usage(_) => "usage",
        }
    }

    /// The step as the JSON object the timeline keeps.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// The turn's tokens so far, subagents included (a `usage` step).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub calls: i64,
    pub input: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub output: i64,
    pub total: i64,
    /// Output over generation time, in tokens a second; `None` when the time is too short to say.
    #[serde(serialize_with = "serialize_js_number")]
    pub out_tps: Option<f64>,
    /// The same for the latest three calls.
    #[serde(serialize_with = "serialize_js_number")]
    pub now_tps: Option<f64>,
}

/// A tool result in the shape callers of the provider expect: the result's full text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolResult {
    pub id: String,
    pub ok: bool,
    pub result: String,
}

/// The JS `str(v)`: nothing for null, a string as it is, anything else as JSON.
fn str_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => js_json(other, false),
    }
}

fn cap(text: String, max: usize) -> String {
    if utf16_len(&text) > max {
        format!("{}…", utf16_truncate(&text, max))
    } else {
        text
    }
}

/// What a tool was given, for the step when it is opened (the summary is its one line): the command for Bash, else
/// the arguments as JSON. Redacted and capped. `input` is `Value::Null` when the tool was given nothing.
pub fn tool_input_preview(name: &str, input: &Value) -> String {
    let text = match input {
        Value::Null => return String::new(),
        Value::String(s) => s.clone(),
        other => match other.get("command") {
            Some(Value::String(command)) if name == "Bash" => command.clone(),
            _ => js_json(other, true),
        },
    };
    cap(redact_secrets(&text.replace('\r', "")), INPUT_CHARS)
}

/// A short human label for what a tool call is doing.
pub fn summarize_tool_input(name: &str, input: &Value) -> String {
    let pick = |keys: &[&str]| -> String {
        keys.iter()
            .filter_map(|k| input.get(k))
            .find(|v| truthy(v))
            .map(str_of)
            .unwrap_or_default()
    };
    let s = match name {
        "Bash" => {
            let description = pick(&["description"]);
            if description.is_empty() {
                pick(&["command"])
            } else {
                description
            }
        }
        "Read" | "Write" | "Edit" | "NotebookEdit" => pick(&["file_path", "notebook_path"]),
        "Grep" => {
            let place = match input.get("path") {
                Some(path) if truthy(path) => format!(" in {}", js_string(path)),
                _ => String::new(),
            };
            pick(&["pattern"]) + &place
        }
        "Glob" => pick(&["pattern"]),
        "WebFetch" => pick(&["url"]),
        "WebSearch" => pick(&["query"]),
        "Task" | "Agent" => pick(&["description", "prompt"]),
        "TodoWrite" => "updating the task list".to_string(),
        _ => first_text_value(input),
    };
    let mut s = js_trim(&collapse_whitespace(&s)).to_string();
    // Paths: show the tail, which is the informative part.
    if s.starts_with('/') && utf16_len(&s) > 80 {
        s = format!("…{}", utf16_tail(&s, 78));
    }
    if utf16_len(&s) > 140 {
        format!("{}…", utf16_truncate(&s, 139))
    } else {
        s
    }
}

/// `Object.values(input).find((v) => typeof v === "string" && v.trim())`: the first argument that is words.
fn first_text_value(input: &Value) -> String {
    let is_words = |v: &&Value| v.as_str().is_some_and(|s| !js_trim(s).is_empty());
    match input {
        Value::Object(map) => map.values().find(is_words).map(str_of).unwrap_or_default(),
        Value::Array(items) => items.iter().find(is_words).map(str_of).unwrap_or_default(),
        // (A string's values are its characters.)
        Value::String(s) => s
            .chars()
            .find(|c| !is_js_whitespace(*c))
            .map(String::from)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

static MCP_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^mcp__[^_]+(?:_[^_]+)*?__([^\n\r\u{2028}\u{2029}]+)$").expect("the MCP tool name pattern")
});

/// Friendly tool names: mcp__tarsee__tarsee_send_message → tarsee_send_message.
pub fn display_tool_name(name: &str) -> String {
    let n = if name.is_empty() { "tool" } else { name };
    match MCP_NAME.captures(n) {
        Some(found) => found[1].to_string(),
        None => n.to_string(),
    }
}

/// A tool result's blocks as text: each text block's words, images as [image], one a line.
fn blocks_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .map(|c| match c.get("type").and_then(Value::as_str) {
            Some("text") => match c.get("text") {
                None | Some(Value::Null) => String::new(),
                Some(text) => js_string(text),
            },
            Some("image") => "[image]".to_string(),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A tool result's content as a short preview: its text, images as [image].
pub fn result_preview(content: &Value) -> String {
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks_text(blocks),
        other => str_of(other),
    };
    cap(redact_secrets(js_trim(&text.replace('\r', ""))), PREVIEW_CHARS)
}

/// The key a tool id is remembered under: the id itself when it is a string.
fn id_text(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => js_string(other),
    }
}

/// The live steps in one engine message (an `assistant` or `user` message; any other type has none). `seen`
/// remembers tool ids already started, so a message delivered twice does not start the same tool twice.
/// Steps come oldest first.
pub fn steps_from_sdk_message(message: &Value, seen: &mut HashSet<String>) -> Vec<Step> {
    let Some(content) = message
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut steps = Vec::new();
    match message.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            for b in content {
                let kind = b.get("type").and_then(Value::as_str);
                let id = b.get("id").filter(|id| truthy(id)).map(id_text);
                match (kind, id) {
                    (Some("tool_use"), Some(id)) if !seen.contains(&id) => {
                        seen.insert(id.clone());
                        let raw_name = b.get("name").and_then(Value::as_str);
                        let input = b.get("input").unwrap_or(&Value::Null);
                        steps.push(Step::ToolStart {
                            id,
                            name: display_tool_name(raw_name.unwrap_or_default()),
                            raw_name: raw_name.map(String::from),
                            summary: redact_secrets(&summarize_tool_input(raw_name.unwrap_or_default(), input)),
                            input: tool_input_preview(raw_name.unwrap_or_default(), input),
                        });
                    }
                    (Some("text"), _) => {
                        let text = b.get("text").and_then(Value::as_str).map(js_trim).unwrap_or_default();
                        if !text.is_empty() {
                            steps.push(Step::Text { text: text.to_string() });
                        }
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            for b in content {
                if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(id) = b.get("tool_use_id").filter(|id| truthy(id)) else {
                    continue;
                };
                steps.push(Step::ToolEnd {
                    id: id_text(id),
                    ok: !b.get("is_error").is_some_and(truthy),
                    preview: result_preview(b.get("content").unwrap_or(&Value::Null)),
                });
            }
        }
        _ => {}
    }
    steps
}

/// The tool results in an engine `user` message, in the shape callers of the provider already expect:
/// { id, ok, result } with the result's full text.
pub fn tool_results_from_sdk_message(message: &Value) -> Vec<ToolResult> {
    if message.get("type").and_then(Value::as_str) != Some("user") {
        return Vec::new();
    }
    let Some(content) = message
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for b in content {
        if b.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let Some(id) = b.get("tool_use_id").filter(|id| truthy(id)) else {
            continue;
        };
        let result = match b.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(blocks)) => blocks_text(blocks),
            Some(other) => str_of(other),
            None => String::new(),
        };
        out.push(ToolResult {
            id: id_text(id),
            ok: !b.get("is_error").is_some_and(truthy),
            result,
        });
    }
    out
}

/// What the engine's error words mean, for a retry's line.
fn retry_why(error: &str) -> Option<&'static str> {
    Some(match error {
        "authentication_failed" => "sign-in failed",
        "oauth_org_not_allowed" => "organization not allowed",
        "billing_error" => "billing problem",
        "rate_limit" => "rate limited",
        "invalid_request" => "invalid request",
        "server_error" => "server error",
        "max_output_tokens" => "output limit",
        _ => return None,
    })
}

const THINKING_CHARS: usize = 4000;
const CALL_MAX_MS: i64 = 20 * 60_000;

/// A speed in tokens a second, or `None` when the time is too short to say.
fn tps(out: i64, ms: i64) -> Option<f64> {
    if ms >= 500 {
        Some(js_round(out as f64 / (ms as f64 / 1000.0) * 10.0) / 10.0)
    } else {
        None
    }
}

/// One model call of the turn, as the stream has told of it so far.
#[derive(Debug, Clone, Default)]
struct Call {
    input: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    started_at: i64,
    ended_at: i64,
}

impl Call {
    fn take(&mut self, usage: Option<&Value>) {
        let Some(usage) = usage.filter(|u| truthy(u)) else {
            return;
        };
        let read = |key: &str| usage.get(key).filter(|v| !v.is_null()).map(js_count);
        if let Some(n) = read("input_tokens") {
            self.input = n;
        }
        if let Some(n) = read("cache_read_input_tokens") {
            self.cache_read = n;
        }
        if let Some(n) = read("cache_creation_input_tokens") {
            self.cache_write = n;
        }
        if let Some(n) = read("output_tokens") {
            self.output = n;
        }
    }
}

/// The other live steps of a turn, read from the engine's stream as it comes (partial messages): the answer to
/// "what is it doing" while the line only says "Thinking".
///
/// ```text
/// { kind: "thinking", text }  a summary of what the model thought, when its thinking block ends (only a turn
///                             that asked for summaries gets any text; see providers/claude_code.rs)
/// { kind: "status", text }    why it is waiting: an API error it will retry, or compacting the conversation
/// { kind: "usage", total, input, cacheRead, cacheWrite, output, calls, outTps, nowTps }
///                             the turn's tokens so far, subagents included, at each model call's start and end;
///                             outTps is output over generation time, nowTps the same for the latest three calls
/// ```
///
/// A subagent's thinking stays out of the list (its work shows as its one Task step), but its tokens count.
pub struct StreamWatcher {
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    /// message id -> the call, in the order the calls began
    calls: Vec<(String, Call)>,
    /// parent tool id ("" for the turn itself) -> the message id being streamed
    current: Vec<(String, String)>,
    /// (parent, index) -> the summary so far
    thinking: Vec<((String, String), String)>,
}

/// A watcher for one turn's stream, on the real clock (`createStreamWatcher()`).
pub fn create_stream_watcher() -> StreamWatcher {
    StreamWatcher::new()
}

impl Default for StreamWatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamWatcher {
    pub fn new() -> Self {
        Self::with_clock(now_ms)
    }

    /// A watcher that reads the time from `now` (milliseconds), for tests: `createStreamWatcher({ now })`.
    pub fn with_clock(now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        StreamWatcher {
            now: Box::new(now),
            calls: Vec::new(),
            current: Vec::new(),
            thinking: Vec::new(),
        }
    }

    /// The turn's tokens so far, as a `usage` step.
    pub fn usage_so_far(&self) -> Step {
        let mut usage = Usage {
            calls: 0,
            input: 0,
            cache_read: 0,
            cache_write: 0,
            output: 0,
            total: 0,
            out_tps: None,
            now_tps: None,
        };
        let mut gen_ms = 0;
        let mut gen_out = 0;
        // (generation time, output, when it ended)
        let mut timed: Vec<(i64, i64, i64)> = Vec::new();
        for (_, c) in &self.calls {
            usage.calls += 1;
            usage.input += c.input;
            usage.cache_read += c.cache_read;
            usage.cache_write += c.cache_write;
            usage.output += c.output;
            let g = if c.ended_at != 0 && c.started_at != 0 {
                c.ended_at - c.started_at
            } else {
                0
            };
            // (a believable generation time only: not under a millisecond per 1.5 tokens, not over 20 minutes)
            if g > 0 && g <= CALL_MAX_MS && c.output as f64 <= g as f64 * 1.5 {
                gen_ms += g;
                gen_out += c.output;
                timed.push((g, c.output, c.ended_at));
            }
        }
        timed.sort_by_key(|(_, _, at)| *at);
        let last = &timed[timed.len().saturating_sub(3)..];
        usage.total = usage.input + usage.cache_read + usage.cache_write + usage.output;
        usage.out_tps = tps(gen_out, gen_ms);
        usage.now_tps = tps(
            last.iter().map(|(_, out, _)| out).sum(),
            last.iter().map(|(g, _, _)| g).sum(),
        );
        Step::Usage(usage)
    }

    fn call_mut(&mut self, id: &str) -> Option<&mut Call> {
        self.calls.iter_mut().find(|(key, _)| key == id).map(|(_, call)| call)
    }

    /// The steps in one engine message: none for most.
    pub fn on_message(&mut self, message: &Value) -> Vec<Step> {
        let kind = message.get("type").and_then(Value::as_str);
        if kind == Some("system") {
            return system_steps(message);
        }
        let Some(e) = message.get("event").filter(|e| truthy(e)) else {
            return Vec::new();
        };
        if kind != Some("stream_event") {
            return Vec::new();
        }
        let parent = message
            .get("parent_tool_use_id")
            .filter(|p| truthy(p))
            .map(js_string)
            .unwrap_or_default();
        let index = e.get("index").map(js_string).unwrap_or_else(|| "undefined".to_string());
        let key = (parent.clone(), index);
        match e.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let id = e
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .filter(|id| truthy(id))
                    .map(js_string)
                    .unwrap_or_else(|| format!("call-{}", self.calls.len() + 1));
                if self.call_mut(&id).is_none() {
                    let started_at = (self.now)();
                    self.calls.push((
                        id.clone(),
                        Call {
                            started_at,
                            ..Call::default()
                        },
                    ));
                }
                let usage = e.get("message").and_then(|m| m.get("usage"));
                if let Some(call) = self.call_mut(&id) {
                    call.take(usage);
                }
                match self.current.iter_mut().find(|(p, _)| *p == parent) {
                    Some(slot) => slot.1 = id,
                    None => self.current.push((parent, id)),
                }
                vec![self.usage_so_far()]
            }
            Some("message_delta") => {
                let usage = e.get("usage").filter(|u| truthy(u));
                let id = self
                    .current
                    .iter()
                    .find(|(p, _)| *p == parent)
                    .map(|(_, id)| id.clone());
                let now = (self.now)();
                let (Some(usage), Some(call)) = (usage, id.and_then(|id| self.call_mut(&id))) else {
                    return Vec::new();
                };
                call.take(Some(usage));
                call.ended_at = now;
                vec![self.usage_so_far()]
            }
            Some("content_block_start") => {
                let is_thinking = e
                    .get("content_block")
                    .and_then(|b| b.get("type"))
                    .and_then(Value::as_str)
                    == Some("thinking");
                if parent.is_empty() && is_thinking {
                    match self.thinking.iter_mut().find(|(k, _)| *k == key) {
                        Some(slot) => slot.1 = String::new(),
                        None => self.thinking.push((key, String::new())),
                    }
                }
                Vec::new()
            }
            Some("content_block_delta") => {
                let delta = e.get("delta");
                let is_thinking = delta.and_then(|d| d.get("type")).and_then(Value::as_str) == Some("thinking_delta");
                if is_thinking
                    && let Some((_, sofar)) = self.thinking.iter_mut().find(|(k, _)| *k == key)
                    && utf16_len(sofar) < THINKING_CHARS
                {
                    let more = delta.and_then(|d| d.get("thinking")).filter(|t| truthy(t));
                    sofar.push_str(&more.map(js_string).unwrap_or_default());
                }
                Vec::new()
            }
            Some("content_block_stop") => {
                let Some(at) = self.thinking.iter().position(|(k, _)| *k == key) else {
                    return Vec::new();
                };
                let (_, sofar) = self.thinking.remove(at);
                let text = js_trim(&sofar);
                // (No text: the model thought without a summary, which is all a turn that did not ask for one gets.)
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![Step::Thinking {
                        text: redact_secrets(&utf16_truncate(text, THINKING_CHARS)),
                    }]
                }
            }
            _ => Vec::new(),
        }
    }
}

/// The steps of a `system` message: why the turn is waiting.
fn system_steps(message: &Value) -> Vec<Step> {
    let status = |text: String| vec![Step::Status { text }];
    match message.get("subtype").and_then(Value::as_str) {
        Some("api_retry") => status(retry_text(message)),
        Some("status") => {
            if message.get("status").and_then(Value::as_str) == Some("compacting") {
                return status("Compacting the conversation to make room.".to_string());
            }
            if message.get("compact_result").and_then(Value::as_str) == Some("failed") {
                let why = match message.get("compact_error").filter(|e| truthy(e)) {
                    Some(error) => format!(": {}", utf16_truncate(&redact_secrets(&js_string(error)), 200)),
                    None => ".".to_string(),
                };
                return status(format!("Compacting failed{why}"));
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn retry_text(m: &Value) -> String {
    let delay = m.get("retry_delay_ms").map(js_number).filter(|n| !n.is_nan());
    let secs = js_round(delay.unwrap_or(0.0) / 1000.0).max(1.0);
    let or = |key: &str, fallback: &str| {
        m.get(key)
            .filter(|v| truthy(v))
            .map(js_string)
            .unwrap_or_else(|| fallback.to_string())
    };
    let when = format!(
        "Trying again in {}s (attempt {} of {}).",
        number_to_string(secs),
        or("attempt", "1"),
        or("max_retries", "?")
    );
    let Some(status) = m.get("error_status").filter(|s| !s.is_null()) else {
        return format!("Could not reach Claude's API. {when}");
    };
    let why = m
        .get("error")
        .and_then(Value::as_str)
        .and_then(retry_why)
        .map(|why| format!(" ({why})"))
        .unwrap_or_default();
    format!("Claude's API answered {}{why}. {when}", js_string(status))
}

// ── JavaScript behaviour this package needs that `util::js` does not have yet ───────────────────────────────────
// (Proposed for `util::js` in the package report; they live here because this is the first module of the package
// that needs them.)

/// What JavaScript calls whitespace (`\s`, and what `trim()` removes). Unlike Rust's it has U+FEFF and not U+0085.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `text.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `text.trimStart()`.
pub(crate) fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// `text.replace(/\s+/g, " ")`.
pub(crate) fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `text.replace(/\n{3,}/g, "\n\n")`.
pub(crate) fn fold_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut newlines = 0usize;
    for c in text.chars() {
        if c == '\n' {
            newlines += 1;
            continue;
        }
        flush_newlines(&mut out, newlines);
        newlines = 0;
        out.push(c);
    }
    flush_newlines(&mut out, newlines);
    out
}

fn flush_newlines(out: &mut String, count: usize) {
    for _ in 0..count.min(2) {
        out.push('\n');
    }
}

/// `String(value)`, as a template literal writes a value: text as it is, a whole number without a decimal point,
/// an array as its items joined with commas, an object as "[object Object]".
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `Number(value)`: NaN for what is not a number.
pub(crate) fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let s = js_trim(s);
            if s.is_empty() {
                0.0
            } else if s
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+' | b'e' | b'E'))
            {
                s.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
        _ => f64::NAN,
    }
}

/// `Number(value) || 0`, as a whole count.
fn js_count(value: &Value) -> i64 {
    let n = js_number(value);
    if n.is_finite() { n as i64 } else { 0 }
}

/// `Math.round(n)`: halves go up.
pub(crate) fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// `JSON.stringify(value)` (or with `pretty`, `JSON.stringify(value, null, 2)`). A number with no fraction is
/// written without one (JavaScript has one kind of number: 1.0 is 1).
pub(crate) fn js_json(value: &Value, pretty: bool) -> String {
    let value = whole_numbers(value);
    let text = if pretty {
        serde_json::to_string_pretty(&value)
    } else {
        serde_json::to_string(&value)
    };
    text.unwrap_or_default()
}

fn whole_numbers(value: &Value) -> Value {
    match value {
        Value::Number(n) if n.is_f64() => match n.as_f64() {
            Some(f) if f == f.trunc() && f.abs() < 9_007_199_254_740_992.0 => Value::from(f as i64),
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(whole_numbers).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), whole_numbers(v))).collect()),
        other => other.clone(),
    }
}

/// Writes a number the way `JSON.stringify` does: no decimal point on a whole one. `None` is null.
pub(crate) fn serialize_js_number<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        None => serializer.serialize_none(),
        Some(n) if *n == n.trunc() && n.abs() < 9_007_199_254_740_992.0 => serializer.serialize_i64(*n as i64),
        Some(n) => serializer.serialize_f64(*n),
    }
}

/// `JSON.parse(text)` for JSON the Node version stored. It wrote half of a surrogate pair as an escape (`\ud83d`)
/// wherever a cut landed in the middle of an emoji; a Rust string cannot hold half a pair, so such a half is left
/// out, as `util::js::utf16_truncate` leaves it out. `None` when the text is not JSON.
pub(crate) fn parse_json_lossy(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str(text) {
        return Some(value);
    }
    if !text.contains("\\u") {
        return None;
    }
    serde_json::from_str(&drop_lone_surrogate_escapes(text)).ok()
}

/// Removes every `\uD800`–`\uDFFF` escape that is not half of a proper pair. Escaped backslashes are stepped over,
/// so `\\ud83d` (a backslash and the letters) is left alone.
fn drop_lone_surrogate_escapes(text: &str) -> String {
    let bytes = text.as_bytes();
    let unit = |at: usize| -> Option<u16> {
        let hex = bytes.get(at + 2..at + 6)?;
        if bytes[at] != b'\\' || bytes[at + 1] != b'u' {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i + 1 < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        match unit(i) {
            Some(0xD800..=0xDBFF) => match unit(i + 6) {
                Some(0xDC00..=0xDFFF) => i += 12,
                _ => {
                    out.push_str(&text[copied..i]);
                    i += 6;
                    copied = i;
                }
            },
            Some(0xDC00..=0xDFFF) => {
                out.push_str(&text[copied..i]);
                i += 6;
                copied = i;
            }
            Some(_) => i += 6,
            // Any other escape (`\\`, `\"`, `\n`): two bytes.
            None => i += 2,
        }
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    //! Port of the "tool steps" and "stream watcher" cases of `test/live-bus.test.js`.
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    use serde_json::json;

    use super::*;

    fn assistant(content: Value) -> Value {
        json!({ "type": "assistant", "message": { "role": "assistant", "content": content }, "parent_tool_use_id": null })
    }

    fn user(content: Value) -> Value {
        json!({ "type": "user", "message": { "role": "user", "content": content }, "parent_tool_use_id": null })
    }

    fn kinds(steps: &[Step]) -> Vec<&'static str> {
        steps.iter().map(Step::kind).collect()
    }

    /// A key-shaped string, built from parts so the repository's push protection does not take it for a real one.
    fn fake_key() -> String {
        format!("sk-ant-{}", "api03-abcdefghijklmnopqrstuvwxyz0123456789")
    }

    #[test]
    fn a_tool_use_block_starts_a_step_once_with_a_one_line_summary_and_redacted_input() {
        let mut seen = HashSet::new();
        let msg = assistant(json!([
            { "type": "text", "text": "Let me look." },
            { "type": "tool_use", "id": "tu1", "name": "Bash", "input": {
                "command": format!("curl -H 'Authorization: Bearer {}' x", fake_key()),
                "description": "Fetch the page",
            } },
        ]));
        let steps = steps_from_sdk_message(&msg, &mut seen);
        assert_eq!(kinds(&steps), ["text", "tool_start"]);
        let Step::ToolStart { summary, input, .. } = &steps[1] else {
            panic!("not a tool_start");
        };
        assert_eq!(summary, "Fetch the page");
        assert!(
            !input.contains("abcdefghijklmnopqrstuvwxyz0123456789"),
            "the key is redacted"
        );
        assert!(input.starts_with("curl -H 'Authorization: Bearer "));
        // the same tool does not start twice
        assert_eq!(kinds(&steps_from_sdk_message(&msg, &mut seen)), ["text"]);
    }

    #[test]
    fn a_tool_start_is_written_as_the_timeline_keeps_it() {
        let msg = assistant(json!([
            { "type": "tool_use", "id": "tu9", "name": "mcp__tarsee__tarsee_web_search", "input": { "query": "weather" } },
            { "type": "tool_use", "id": "tu10" },
        ]));
        let steps = steps_from_sdk_message(&msg, &mut HashSet::new());
        assert_eq!(
            serde_json::to_string(&steps[0]).unwrap(),
            r#"{"kind":"tool_start","id":"tu9","name":"tarsee_web_search","rawName":"mcp__tarsee__tarsee_web_search","summary":"weather","input":"{\n  \"query\": \"weather\"\n}"}"#
        );
        // A block with no name and no input: "tool", and no rawName at all.
        assert_eq!(
            steps[1].to_value(),
            json!({ "kind": "tool_start", "id": "tu10", "name": "tool", "summary": "", "input": "" })
        );
    }

    #[test]
    fn a_tool_result_block_in_a_user_message_ends_the_step_it_answers() {
        let msg = user(json!([
            { "type": "tool_result", "tool_use_id": "tu1", "content": [{ "type": "text", "text": "done" }], "is_error": false },
        ]));
        let steps = steps_from_sdk_message(&msg, &mut HashSet::new());
        assert_eq!(
            serde_json::to_value(&steps).unwrap(),
            json!([{ "kind": "tool_end", "id": "tu1", "ok": true, "preview": "done" }])
        );
        assert_eq!(
            serde_json::to_value(tool_results_from_sdk_message(&msg)).unwrap(),
            json!([{ "id": "tu1", "ok": true, "result": "done" }])
        );
        let failed =
            user(json!([{ "type": "tool_result", "tool_use_id": "tu2", "content": "boom", "is_error": true }]));
        assert!(!tool_results_from_sdk_message(&failed)[0].ok);
        assert_eq!(tool_results_from_sdk_message(&failed)[0].result, "boom");
    }

    #[test]
    fn other_messages_have_no_steps() {
        let mut seen = HashSet::new();
        assert!(steps_from_sdk_message(&json!({ "type": "result", "result": "x" }), &mut seen).is_empty());
        assert!(steps_from_sdk_message(&user(json!("plain prompt text")), &mut seen).is_empty());
        assert!(tool_results_from_sdk_message(&assistant(json!([{ "type": "text", "text": "x" }]))).is_empty());
    }

    #[test]
    fn names_tarsees_mcp_tools_plainly_and_summarises_the_common_tools() {
        assert_eq!(
            display_tool_name("mcp__tarsee__tarsee_send_message"),
            "tarsee_send_message"
        );
        assert_eq!(display_tool_name("Read"), "Read");
        assert_eq!(display_tool_name(""), "tool");
        assert_eq!(display_tool_name("mcp__claude_ai_Docs__batch"), "batch");
        assert_eq!(
            summarize_tool_input("Grep", &json!({ "pattern": "TODO", "path": "src" })),
            "TODO in src"
        );
        assert_eq!(summarize_tool_input("TodoWrite", &json!({})), "updating the task list");
        let long_path = format!("/{}file.js", "a/".repeat(60));
        assert!(summarize_tool_input("Read", &json!({ "file_path": long_path })).starts_with('…'));
    }

    #[test]
    fn a_summary_is_one_line_cut_to_140_and_an_unknown_tools_is_its_first_words() {
        assert_eq!(
            summarize_tool_input("Bash", &json!({ "command": "ls  -la\n\t/tmp" })),
            "ls -la /tmp"
        );
        assert_eq!(
            summarize_tool_input("Task", &json!({ "prompt": "Find the bug", "description": "" })),
            "Find the bug"
        );
        assert_eq!(
            summarize_tool_input("custom", &json!({ "n": 5, "blank": "  ", "what": "the thing" })),
            "the thing"
        );
        assert_eq!(summarize_tool_input("custom", &Value::Null), "");
        let long = summarize_tool_input("WebSearch", &json!({ "query": "x".repeat(300) }));
        assert_eq!(utf16_len(&long), 140);
        assert!(long.ends_with('…'));
        // The path's tail is 78 units and an ellipsis.
        let tail = summarize_tool_input("Read", &json!({ "file_path": format!("/{}", "b".repeat(100)) }));
        assert_eq!(tail, format!("…{}", "b".repeat(78)));
        // A cut never leaves half an emoji.
        let emoji = summarize_tool_input("WebSearch", &json!({ "query": "🐒".repeat(100) }));
        assert_eq!(emoji, format!("{}…", "🐒".repeat(69)));
    }

    #[test]
    fn a_tools_input_is_its_command_or_its_arguments_redacted_and_capped() {
        assert_eq!(
            tool_input_preview("Bash", &json!({ "command": "ls\r\n-la" })),
            "ls\n-la"
        );
        assert_eq!(
            tool_input_preview("Read", &json!({ "file_path": "/a", "limit": 2.0 })),
            "{\n  \"file_path\": \"/a\",\n  \"limit\": 2\n}"
        );
        assert_eq!(tool_input_preview("Read", &json!("as text")), "as text");
        assert_eq!(tool_input_preview("Read", &Value::Null), "");
        // (Words, not one long run of letters: that would be taken for a token and redacted.)
        let long = tool_input_preview("Bash", &json!({ "command": "yes ".repeat(750) }));
        assert_eq!(utf16_len(&long), 2001);
        assert!(long.ends_with("yes …"));
        assert_eq!(
            tool_input_preview("Bash", &json!({ "command": format!("echo {}", fake_key()) })),
            "echo [REDACTED]"
        );
    }

    #[test]
    fn a_results_preview_is_its_text_with_images_named_capped_at_600() {
        assert_eq!(result_preview(&json!("  done\r\n")), "done");
        assert_eq!(
            result_preview(&json!([{ "type": "text", "text": "one" }, { "type": "image" }, { "type": "other" }])),
            "one\n[image]"
        );
        assert_eq!(result_preview(&json!({ "a": 1 })), "{\"a\":1}");
        assert_eq!(result_preview(&Value::Null), "");
        let long = result_preview(&json!("zed ".repeat(175)));
        assert_eq!(utf16_len(&long), 601);
        assert!(long.ends_with("zed …"));
    }

    fn se(event: Value, parent: Option<&str>) -> Value {
        json!({ "type": "stream_event", "event": event, "parent_tool_use_id": parent })
    }

    fn usage_of(steps: &[Step]) -> Usage {
        match steps {
            [Step::Usage(usage)] => usage.clone(),
            other => panic!("not one usage step: {other:?}"),
        }
    }

    #[test]
    fn tokens_so_far_at_each_calls_start_and_end_and_the_speed_of_its_output() {
        let t = Arc::new(AtomicI64::new(1_000_000));
        let clock = t.clone();
        let mut w = StreamWatcher::with_clock(move || clock.load(Ordering::SeqCst));
        let start = usage_of(&w.on_message(&se(
            json!({ "type": "message_start", "message": { "id": "m1", "usage": {
                "input_tokens": 4, "cache_read_input_tokens": 40_000, "cache_creation_input_tokens": 300, "output_tokens": 1,
            } } }),
            None,
        )));
        assert_eq!(start.total, 40_305);
        assert_eq!(start.out_tps, None, "nothing generated yet");
        t.fetch_add(4000, Ordering::SeqCst);
        let end = w.on_message(&se(
            json!({ "type": "message_delta", "usage": {
                "input_tokens": 4, "cache_read_input_tokens": 40_000, "cache_creation_input_tokens": 300, "output_tokens": 200,
            } }),
            None,
        ));
        assert_eq!(
            serde_json::to_string(&end[0]).unwrap(),
            r#"{"kind":"usage","calls":1,"input":4,"cacheRead":40000,"cacheWrite":300,"output":200,"total":40504,"outTps":50,"nowTps":50}"#
        );
        let end = usage_of(&end);
        assert_eq!(end.total, 40_504);
        assert_eq!(end.out_tps, Some(50.0));
        assert_eq!(end.now_tps, Some(50.0));
        // A subagent's call counts too.
        w.on_message(&se(
            json!({ "type": "message_start", "message": { "id": "m2", "usage": { "input_tokens": 10, "output_tokens": 0 } } }),
            Some("toolu_1"),
        ));
        t.fetch_add(1000, Ordering::SeqCst);
        let sub = usage_of(&w.on_message(&se(
            json!({ "type": "message_delta", "usage": { "output_tokens": 100 } }),
            Some("toolu_1"),
        )));
        assert_eq!(sub.calls, 2);
        assert_eq!(sub.output, 300);
        assert_eq!(w.usage_so_far(), Step::Usage(sub));
    }

    #[test]
    fn a_speed_that_is_not_a_whole_number_keeps_one_decimal() {
        let t = Arc::new(AtomicI64::new(5_000));
        let clock = t.clone();
        let mut w = StreamWatcher::with_clock(move || clock.load(Ordering::SeqCst));
        w.on_message(&se(json!({ "type": "message_start", "message": { "id": "m1" } }), None));
        t.fetch_add(3000, Ordering::SeqCst);
        let end = w.on_message(&se(
            json!({ "type": "message_delta", "usage": { "output_tokens": 100 } }),
            None,
        ));
        assert_eq!(end[0].to_value()["outTps"], json!(33.3));
    }

    #[test]
    fn a_thinking_summary_when_its_block_ends_nothing_for_thinking_left_out_nor_for_a_subagents() {
        let mut w = create_stream_watcher();
        let delta = |index: u32, thinking: &str| json!({ "type": "content_block_delta", "index": index, "delta": { "type": "thinking_delta", "thinking": thinking } });
        let start = |index: u32| json!({ "type": "content_block_start", "index": index, "content_block": { "type": "thinking" } });
        let stop = |index: u32| json!({ "type": "content_block_stop", "index": index });

        w.on_message(&se(start(0), None));
        assert!(w.on_message(&se(delta(0, "Working out the dates, "), None)).is_empty());
        w.on_message(&se(delta(0, "then checking with cal."), None));
        assert_eq!(
            serde_json::to_value(w.on_message(&se(stop(0), None))).unwrap(),
            json!([{ "kind": "thinking", "text": "Working out the dates, then checking with cal." }])
        );
        // Omitted thinking (no summary asked for): one empty delta.
        w.on_message(&se(start(1), None));
        w.on_message(&se(delta(1, ""), None));
        assert!(w.on_message(&se(stop(1), None)).is_empty());
        w.on_message(&se(start(0), Some("toolu_9")));
        w.on_message(&se(delta(0, "inside a helper"), Some("toolu_9")));
        assert!(w.on_message(&se(stop(0), Some("toolu_9"))).is_empty());
        // A text block's end is not a thought.
        assert!(w.on_message(&se(stop(2), None)).is_empty());
    }

    #[test]
    fn why_it_is_waiting_an_api_error_it_retries_compacting() {
        let mut w = create_stream_watcher();
        assert_eq!(
            serde_json::to_value(w.on_message(&json!({
                "type": "system", "subtype": "api_retry", "attempt": 2, "max_retries": 10, "retry_delay_ms": 4200,
                "error_status": 529, "error": "server_error",
            })))
            .unwrap(),
            json!([{ "kind": "status", "text": "Claude's API answered 529 (server error). Trying again in 4s (attempt 2 of 10)." }])
        );
        assert_eq!(
            serde_json::to_value(w.on_message(&json!({
                "type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 10, "retry_delay_ms": 500,
                "error_status": null, "error": "unknown",
            })))
            .unwrap(),
            json!([{ "kind": "status", "text": "Could not reach Claude's API. Trying again in 1s (attempt 1 of 10)." }])
        );
        assert_eq!(
            serde_json::to_value(
                w.on_message(&json!({ "type": "system", "subtype": "status", "status": "compacting" }))
            )
            .unwrap(),
            json!([{ "kind": "status", "text": "Compacting the conversation to make room." }])
        );
        assert!(
            w.on_message(&json!({ "type": "system", "subtype": "status", "status": "requesting" }))
                .is_empty()
        );
        assert!(w.on_message(&json!({ "type": "system", "subtype": "init" })).is_empty());
        assert!(
            w.on_message(&json!({ "type": "assistant", "message": { "content": [] } }))
                .is_empty()
        );
    }

    #[test]
    fn a_compaction_that_failed_says_why() {
        let mut w = create_stream_watcher();
        let said = |w: &mut StreamWatcher, message: Value| serde_json::to_value(w.on_message(&message)).unwrap();
        assert_eq!(
            said(
                &mut w,
                json!({ "type": "system", "subtype": "status", "compact_result": "failed", "compact_error": "too long" })
            ),
            json!([{ "kind": "status", "text": "Compacting failed: too long" }])
        );
        assert_eq!(
            said(
                &mut w,
                json!({ "type": "system", "subtype": "status", "compact_result": "failed" })
            ),
            json!([{ "kind": "status", "text": "Compacting failed." }])
        );
        // An unknown error word has no gloss; a missing attempt is the first; an unknown limit is "?".
        assert_eq!(
            said(
                &mut w,
                json!({ "type": "system", "subtype": "api_retry", "error_status": 500, "error": "strange" })
            ),
            json!([{ "kind": "status", "text": "Claude's API answered 500. Trying again in 1s (attempt 1 of ?)." }])
        );
    }

    #[test]
    fn javascripts_whitespace_strings_and_numbers() {
        assert_eq!(js_trim("\u{feff} a b \u{2028}"), "a b");
        assert_eq!(
            js_trim("\u{85}a\u{85}"),
            "\u{85}a\u{85}",
            "U+0085 is not whitespace in JavaScript"
        );
        assert_eq!(js_trim_start("  /help "), "/help ");
        assert_eq!(collapse_whitespace("a \n\t b\u{a0}c"), "a b c");
        assert_eq!(fold_blank_lines("a\n\n\n\nb\n\nc\n\n\n"), "a\n\nb\n\nc\n\n");
        assert_eq!(js_string(&json!(3)), "3");
        assert_eq!(js_string(&json!(2.5)), "2.5");
        assert_eq!(js_string(&json!([1, null, "a", [2, 3]])), "1,,a,2,3");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
        assert_eq!(js_number(&json!(" 42 ")), 42.0);
        assert_eq!(js_number(&json!("")), 0.0);
        assert!(js_number(&json!("12px")).is_nan());
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(
            js_json(&json!({ "a": 1.0, "b": [2.5, 3.0] }), false),
            r#"{"a":1,"b":[2.5,3]}"#
        );
    }

    #[test]
    fn stored_json_with_half_a_surrogate_pair_still_reads() {
        assert_eq!(parse_json_lossy(r#"{"a":1}"#), Some(json!({ "a": 1 })));
        assert_eq!(parse_json_lossy("not json"), None);
        // A cut through an emoji, as the Node version stored it: the half is left out.
        assert_eq!(
            parse_json_lossy(r#"{"text":"cut \ud83d","next":"\udc12 tail"}"#),
            Some(json!({ "text": "cut ", "next": " tail" }))
        );
        // A whole pair, an escaped backslash before "ud83d", and other escapes are left alone.
        assert_eq!(
            parse_json_lossy(r#"{"a":"\ud83d\udc12","b":"\\ud83d","c":"\n\"","d":"\ud83d"}"#),
            Some(json!({ "a": "🐒", "b": "\\ud83d", "c": "\n\"", "d": "" }))
        );
    }
}
