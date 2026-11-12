//! Port of `src/ai/providers/codex-events.js`: what Codex streams, as Tarsee's events (design 4.8 "Event mapping").
//! Pure: no I/O.
//!
//! `codex exec --experimental-json` reports a turn as items (a command, a call to an MCP tool, a patch, a to-do list, a
//! web search, a reasoning summary, a message) that start, update and complete, then turn.completed with the usage or
//! turn.failed. Tarsee's channels, live view, tool status lines and loop guard all speak Claude Code's vocabulary, so
//! the items become the same events Claude Code's turns give, with Claude Code's tool names:
//!
//! ```text
//!   command_execution   Bash {command}             (the shell's own "bash -lc" / PowerShell wrapper taken off)
//!   mcp_tool_call       mcp__<server>__<tool>      (Tarsee's tools: mcp__tarsee__tarsee_<name>), input = arguments
//!   file_change         Write {file_path} for an added file, Edit {file_path} for an update or a delete
//!                       ({change: "delete"}), one per file in the patch
//!   todo_list           TodoWrite {todos}, each time the list changes
//!   web_search          WebSearch {query}
//!   reasoning           thinking start/stop, plus its summary as a thinking step (redacted, at most 4,000 characters)
//!   agent_message       text (a blank line between two messages), plus a text step
//!   error item          a status step (Codex carries on after these)
//! ```
//!
//! Every tool_use gets its tool_result with the same id, and a tool_start / tool_end step for the live view (the
//! shapes `lib/tool_steps.rs` gives Claude Code's turns, redacted the same way).
//!
//! The end of a turn: turn.completed gives a usage event (and a usage step) and done{end_turn}. Codex reports a
//! thread's RUNNING total there (settled against the pinned binary: a resumed thread's second turn reports both turns'
//! tokens), so the state carries the thread's total before this turn (baseline) and the usage is the difference. When
//! the engine couldn't learn that total (`baseline_known` false), no usage is given: all of the running total would
//! count the thread's earlier turns as this one.
//! turn.failed (or an error the stream ends on) is classified by `engine_errors`: a key or sign-in that was turned
//! down gives the provider's own fix as text, an error and done{auth-expired}; anything else an error and
//! done{error}; a thread that can't be resumed is recoverable (the turn layer starts fresh and hands the chat over).
//! "Reconnecting... n/5" errors while Codex retries are status steps. [`finish_codex_events`] closes a turn that ended
//! any other way (Stop, the turn limit, the program exiting) with exactly one done; the engine (`codex.rs`) puts that
//! turn's usage, read from the thread's rollout ([`usage_events`]), in front of the done.
//!
//! Codex's events are JSON, read as `serde_json::Value`, and the events made here are built as the JSON objects the
//! Node code yielded: an event whose JSON a typed [`TurnEvent`] would write differently (an item id that is not text,
//! say) is kept as it is ([`TurnEvent::Other`]), so what reaches the turn layer and the browser is always the Node
//! version's.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::ai::context_limits::{JS_DOT_CLASS, JS_SPACE_CLASS, js_number};
use crate::ai::engine_errors::{
    EngineFailure, ErrorKind, classify_engine_error, friendly, local_no_responses_message,
};
use crate::ai::local_bridge::{js_string, js_stringify, redact_bridge_urls, str_or_empty, tpl};
use crate::ai::provider_registry::{Engine, get_provider, normalize_provider_id};
use crate::ai::turn_types::TurnEvent;
use crate::lib::redact::redact_secrets;
use crate::lib::tool_steps::{display_tool_name, result_preview, summarize_tool_input, tool_input_preview};
use crate::util::js::{self, number_to_string, truthy, utf16_len, utf16_truncate};

/// A tool result's text is capped as Claude Code's turns cap it.
pub const RESULT_MAX_CHARS: usize = 2000;
const THINKING_MAX_CHARS: usize = 4000;
const STATUS_MAX_CHARS: usize = 240;

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("a codex-events pattern")
}

/// Codex's own notes that need no one's attention (shown on every turn on a model it has no metadata for).
static NOISE_RE: LazyLock<Regex> =
    LazyLock::new(|| pattern(&format!("^(?i-u:Model metadata for ){JS_DOT_CLASS}*(?i-u: not found)")));
static RECONNECT_RE: LazyLock<Regex> = LazyLock::new(|| {
    let s = format!("[{JS_SPACE_CLASS}]");
    pattern(&format!(
        r"^Reconnecting\.\.\.{s}*([0-9]+){s}*/{s}*([0-9]+){s}*(?:\(((?s:.)*)\))?{s}*$"
    ))
});
/// Codex's words for a thread it can't resume: the turn starts fresh instead.
static RESUME_FAILED_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"(?i-u:no rollout found|thread/resume failed)|(?i-u:thread)[^\n]*(?i-u:not found)|(?i-u:rollout)[^\n]*(?i-u:not found)|(?i-u:session)[^\n]*(?i-u:not found)",
    )
});
/// Codex's words for a server it couldn't reach at all.
static UNREACHABLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        "(?i-u:Connection failed|error sending request|connection refused|ECONNREFUSED|ECONNRESET|connection reset|connection closed|stream disconnected|dns error|failed to lookup address|timed out)",
    )
});
static MISSING_BINARY_RE: LazyLock<Regex> = LazyLock::new(|| {
    let not_space = format!("[^{JS_SPACE_CLASS}]");
    pattern(&format!(
        r"(?i-u:Unable to locate Codex CLI binaries)|(?i-u:spawn ){not_space}*(?i-u:codex){not_space}*(?i-u: ENOENT)|(?i-u:codex)(?i-u:\.exe)?[^A-Za-z0-9_]+(?i-u:ENOENT)"
    ))
});
static SUBSCRIPTION_SHARING_RE: LazyLock<Regex> =
    LazyLock::new(|| pattern("(?i-u:subscription_sharing_usage_unavailable)"));
/// A status in Codex's retry words ("unexpected status 401 Unauthorized: ...").
static RETRY_STATUS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        r"(?-u:\b)(?i-u:status) ([0-9]{{3}})(?:[{JS_SPACE_CLASS}]+([A-Za-z][A-Za-z ]*?))?(?:[:,)]|$)"
    ))
});
static TRY_AGAIN_RE: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i-u:try again (?:in|at|after) )[^.\n]+"));
static MODEL_WORD_RE: LazyLock<Regex> = LazyLock::new(|| pattern("(?i-u:model)"));
static URL_PART_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        "(?:,)?[{JS_SPACE_CLASS}]*(?i-u:url:)[{JS_SPACE_CLASS}]*[^{JS_SPACE_CLASS}]+"
    ))
});
static CODEX_EXITED_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        r"^Codex Exec exited with (code [0-9]+|signal [A-Za-z0-9_]+):[{JS_SPACE_CLASS}]*((?s:.)*)$"
    ))
});
static PATH_ALIASES_RE: LazyLock<Regex> =
    LazyLock::new(|| pattern("^WARNING: proceeding, even though we could not create PATH aliases"));
static READING_STDIN_RE: LazyLock<Regex> =
    LazyLock::new(|| pattern("^Reading (prompt|additional input) from stdin"));
static LOG_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    let s = format!("[{JS_SPACE_CLASS}]");
    pattern(&format!(
        r"^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}T[0-9:.]+Z{s}+(ERROR|WARN|INFO){s}+[^{JS_SPACE_CLASS}]+:{s}*"
    ))
});

static POSIX_WRAP_RE: LazyLock<Regex> = LazyLock::new(|| {
    let s = format!("[{JS_SPACE_CLASS}]");
    pattern(&format!(
        r#"^"?(?:[^"{JS_SPACE_CLASS}]*[\\/])?(?:bash|sh|zsh|dash)(?:\.exe)?"?{s}+-l?c{s}+((?s:.)+)$"#
    ))
});
/// PowerShell's wrapper, in any case (JavaScript's `i` flag, ASCII letters only): its options up to `-Command`, then
/// the command. An option spelled `-Command` is the command's, never one to skip.
static POWERSHELL_WRAP_RE: LazyLock<FancyRegex> = LazyLock::new(|| {
    let s = format!("[{JS_SPACE_CLASS}]");
    let command = "[Cc][Oo][Mm][Mm][Aa][Nn][Dd]";
    FancyRegex::new(&format!(
        r#"^"?(?:[^"]*[\\/])?(?:[Pp][Oo][Ww][Ee][Rr][Ss][Hh][Ee][Ll][Ll]|[Pp][Ww][Ss][Hh])(?:\.[Ee][Xx][Ee])?"?(?:{s}+-(?!{command}(?![A-Za-z0-9_]))[A-Za-z0-9_]+)*{s}+-{command}{s}+((?s:.)+)$"#
    ))
    .expect("the PowerShell wrapper pattern")
});

// --- Numbers -----------------------------------------------------------------------------------------------------

/// `Number(value)` for a JSON value.
fn number_of(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number(s),
        Value::Array(_) => js_number(&js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// A number as `JSON.stringify` writes it: a whole number without ".0", NaN and the infinities as null.
fn js_num(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

// --- Usage -------------------------------------------------------------------------------------------------------

/// A thread's token counts as Codex reports them (its running total, or one turn's share of it). Each count is a
/// JavaScript number: never below zero, and 0 for anything that isn't a number.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CodexUsage {
    pub input_tokens: f64,
    pub cached_input_tokens: f64,
    pub cache_write_input_tokens: f64,
    pub output_tokens: f64,
    pub reasoning_output_tokens: f64,
}

impl CodexUsage {
    /// The counts of a usage object (the JS `normalizeUsage`): `Math.max(0, Number(u[f]) || 0)` for each.
    pub fn from_value(usage: &Value) -> Self {
        let count = |name: &str| {
            let n = usage.get(name).map_or(f64::NAN, number_of);
            if n.is_nan() || n == 0.0 { 0.0 } else { n.max(0.0) }
        };
        CodexUsage {
            input_tokens: count("input_tokens"),
            cached_input_tokens: count("cached_input_tokens"),
            cache_write_input_tokens: count("cache_write_input_tokens"),
            output_tokens: count("output_tokens"),
            reasoning_output_tokens: count("reasoning_output_tokens"),
        }
    }

    /// The counts as the JS object `{ input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
    /// reasoning_output_tokens }`.
    pub fn to_value(&self) -> Value {
        json!({
            "input_tokens": js_num(self.input_tokens),
            "cached_input_tokens": js_num(self.cached_input_tokens),
            "cache_write_input_tokens": js_num(self.cache_write_input_tokens),
            "output_tokens": js_num(self.output_tokens),
            "reasoning_output_tokens": js_num(self.reasoning_output_tokens),
        })
    }

    fn fields(&self) -> [f64; 5] {
        [
            self.input_tokens,
            self.cached_input_tokens,
            self.cache_write_input_tokens,
            self.output_tokens,
            self.reasoning_output_tokens,
        ]
    }
}

/// This turn's share of a running total: now − baseline. A baseline bigger than now in any field (a thread Codex
/// compacted or replaced) means the count started again, so all of now is this turn's. (The JS took raw usage
/// objects and read them with `normalizeUsage`; read raw ones with [`CodexUsage::from_value`].)
pub fn usage_delta(now: &CodexUsage, baseline: Option<&CodexUsage>) -> CodexUsage {
    let Some(base) = baseline else {
        return *now;
    };
    if base.fields().iter().zip(now.fields()).any(|(b, n)| *b > n) {
        return *now;
    }
    CodexUsage {
        input_tokens: now.input_tokens - base.input_tokens,
        cached_input_tokens: now.cached_input_tokens - base.cached_input_tokens,
        cache_write_input_tokens: now.cache_write_input_tokens - base.cache_write_input_tokens,
        output_tokens: now.output_tokens - base.output_tokens,
        reasoning_output_tokens: now.reasoning_output_tokens - base.reasoning_output_tokens,
    }
}

/// Codex's usage as Tarsee's (Anthropic's shape): its input_tokens includes the cached and cache-written parts.
/// (input, cache_read, cache_creation, output).
fn tarsee_usage(d: &CodexUsage) -> [f64; 4] {
    [
        (d.input_tokens - d.cached_input_tokens - d.cache_write_input_tokens).max(0.0),
        d.cached_input_tokens,
        d.cache_write_input_tokens,
        d.output_tokens,
    ]
}

// --- State -------------------------------------------------------------------------------------------------------

/// What [`create_codex_event_state`] starts a turn's mapping with.
#[derive(Debug, Clone)]
pub struct CodexEventOptions {
    /// The provider's id or alias.
    pub provider_id: String,
    pub model: Option<String>,
    /// The thread's usage total before this turn, for a resumed thread.
    pub baseline: Option<CodexUsage>,
    /// False when a resumed thread's total before this turn couldn't be read: no usage is given. Default true.
    pub baseline_known: bool,
    /// Local AI's address, for "can't reach it" words.
    pub local_url: Option<String>,
}

impl Default for CodexEventOptions {
    fn default() -> Self {
        CodexEventOptions {
            provider_id: String::new(),
            model: None,
            baseline: None,
            baseline_known: true,
            local_url: None,
        }
    }
}

/// A tool's id as the events carry it (`None`: an item with no id, whose events have none either), and the key it is
/// remembered under (two ids JavaScript's `Set` takes for the same have the same key).
#[derive(Debug, Clone)]
struct ToolId {
    key: String,
    value: Option<Value>,
}

impl ToolId {
    fn text(text: String) -> Self {
        ToolId {
            key: format!("s{text}"),
            value: Some(Value::String(text)),
        }
    }
}

/// A turn's mapping state.
#[derive(Debug, Clone)]
pub struct CodexEventState {
    /// The provider's public id (or the id as given, when the registry doesn't know it).
    pub provider_id: String,
    /// The provider's name for people ("The AI" when there is none).
    pub label: String,
    pub model: Option<String>,
    pub local_url: Option<String>,
    pub baseline: Option<CodexUsage>,
    pub baseline_known: bool,
    /// The thread Codex started or resumed (thread.started).
    pub thread_id: Option<String>,
    /// The thread's running total from turn.completed.
    pub totals: Option<CodexUsage>,
    /// True once the turn has ended: nothing more is mapped.
    pub done: bool,
    /// The tools started so far (for the turn limit): a patch counts once, a to-do list never.
    pub tool_count: u64,
    started: HashSet<String>,
    /// The tools waiting for their result, oldest first.
    open: Vec<(String, Option<Value>)>,
    /// Each to-do list's last contents and how many times it was shown.
    todos: HashMap<String, (String, u64)>,
    thinking: HashSet<String>,
    text_count: u64,
    /// The last error Codex reported ("" for none).
    pub last_error: String,
    /// The reason of the last "Reconnecting..." ("" for none).
    pub last_retry: String,
    /// For ids that are objects: JavaScript compares those by identity, so each item's own is new.
    unique: u64,
}

/// A turn's mapping state (the JS `createCodexEventState`).
pub fn create_codex_event_state(opts: CodexEventOptions) -> CodexEventState {
    let id = normalize_provider_id(&opts.provider_id).map_or_else(|| opts.provider_id.clone(), str::to_string);
    let label = get_provider(&id)
        .map(|p| p.label.to_string())
        .filter(|label| !label.is_empty())
        .or_else(|| (!id.is_empty()).then(|| id.clone()))
        .unwrap_or_else(|| "The AI".to_string());
    CodexEventState {
        provider_id: id,
        label,
        model: opts.model.filter(|m| !m.is_empty()),
        local_url: opts.local_url.filter(|u| !u.is_empty()),
        baseline: opts.baseline,
        baseline_known: opts.baseline_known,
        thread_id: None,
        totals: None,
        done: false,
        tool_count: 0,
        started: HashSet::new(),
        open: Vec::new(),
        todos: HashMap::new(),
        thinking: HashSet::new(),
        text_count: 0,
        last_error: String::new(),
        last_retry: String::new(),
        unique: 0,
    }
}

// --- Helpers -----------------------------------------------------------------------------------------------------

/// The event for a JSON object the Node code would have yielded: the typed event when it writes the same JSON back,
/// else the object as it is.
fn event(value: Value) -> TurnEvent {
    let typed = TurnEvent::from_value(value.clone());
    if typed.to_value() == value {
        typed
    } else {
        TurnEvent::Other(value)
    }
}

/// `{ type, ...fields }` with an `id` that is left out when there is none.
fn with_id(head: &[(&str, Value)], id: &Option<Value>, rest: Vec<(&str, Value)>) -> Value {
    let mut out = Map::new();
    for (name, value) in head {
        out.insert((*name).to_string(), value.clone());
    }
    if let Some(id) = id {
        out.insert("id".into(), id.clone());
    }
    for (name, value) in rest {
        out.insert(name.to_string(), value);
    }
    Value::Object(out)
}

fn step(kind: &str, text: String) -> TurnEvent {
    event(json!({"type": "step", "kind": kind, "text": text}))
}

fn unquote(raw: &str) -> String {
    let s = js::trim(raw);
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        return s[1..s.len() - 1].replace("'\\''", "'");
    }
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        // `\"`, `\\`, `\$` and `` \` `` lose their backslash.
        let inner = &s[1..s.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\'
                && let Some(&next) = chars.peek()
                && matches!(next, '"' | '\\' | '$' | '`')
            {
                out.push(next);
                chars.next();
                continue;
            }
            out.push(c);
        }
        return out;
    }
    s.to_string()
}

/// The command a person would recognise: Codex's shell wrapper ("/bin/bash -lc '…'", PowerShell's -Command) taken
/// off.
pub fn unwrap_shell_command(command: &str) -> String {
    let s = js::trim(command);
    if let Some(found) = POSIX_WRAP_RE.captures(s) {
        return unquote(&found[1]);
    }
    if let Ok(Some(found)) = POWERSHELL_WRAP_RE.captures(s)
        && let Some(inner) = found.get(1)
    {
        return unquote(inner.as_str());
    }
    s.to_string()
}

/// `t.length > n ? t.slice(0, n - 1) + "…" : t`, counted in UTF-16 units.
fn clip(text: &str, max: usize) -> String {
    if utf16_len(text) > max {
        format!("{}…", utf16_truncate(text, max - 1))
    } else {
        text.to_string()
    }
}

fn mcp_result_text(item: &Value) -> String {
    if let Some(message) = item.get("error").and_then(|e| e.get("message")).filter(|m| truthy(m)) {
        return js_string(message);
    }
    let result = item.get("result");
    if let Some(Value::Array(content)) = result.and_then(|r| r.get("content"))
        && !content.is_empty()
    {
        return content
            .iter()
            .map(|c| {
                let ty = c.get("type");
                if ty.and_then(Value::as_str) == Some("text") {
                    c.get("text").map(|text| if text.is_null() { String::new() } else { js_string(text) }).unwrap_or_default()
                } else if ty.and_then(Value::as_str) == Some("image") {
                    "[image]".to_string()
                } else if let Some(ty) = ty.filter(|ty| truthy(ty)) {
                    format!("[{}]", js_string(ty))
                } else {
                    String::new()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    match result.and_then(|r| r.get("structured_content")) {
        Some(structured) if !structured.is_null() => js_stringify(structured),
        _ => String::new(),
    }
}

fn step_start(id: &Option<Value>, name: &str, input: &Value) -> TurnEvent {
    event(with_id(
        &[("type", json!("step")), ("kind", json!("tool_start"))],
        id,
        vec![
            ("name", json!(display_tool_name(name))),
            ("rawName", json!(name)),
            ("summary", json!(redact_secrets(&summarize_tool_input(name, input)))),
            ("input", json!(tool_input_preview(name, input))),
        ],
    ))
}

/// One file of a patch, as a tool.
struct FileTool {
    id: ToolId,
    name: &'static str,
    input: Value,
    kind: Option<Value>,
    path: String,
}

/// A file_change item's tools: one Write or Edit per file.
fn file_tools(item: &Value) -> Vec<FileTool> {
    let changes: &[Value] = item.get("changes").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    changes
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let kind = c.get("kind").cloned();
            let path = str_or_empty(c.get("path"));
            let is = |word: &str| kind.as_ref().and_then(Value::as_str) == Some(word);
            let mut input = Map::new();
            input.insert("file_path".into(), Value::String(path.clone()));
            if is("delete") {
                input.insert("change".into(), json!("delete"));
            }
            FileTool {
                id: ToolId::text(format!("{}:{i}", tpl(item.get("id")))),
                name: if is("add") { "Write" } else { "Edit" },
                input: Value::Object(input),
                kind,
                path,
            }
        })
        .collect()
}

/// The words worth showing from "Codex Exec exited with code N: <stderr>" (its own start-up chatter dropped).
fn clean_codex_error(message: &str) -> String {
    // A Local AI turn's requests go to its bridge address, whose path carries the turn's token: never in what is
    // shown.
    let text = redact_bridge_urls(message);
    let Some(found) = CODEX_EXITED_RE.captures(&text) else {
        return js::trim(&text).to_string();
    };
    let lines: Vec<String> = found[2]
        .split('\n')
        .map(|l| js::trim(l.strip_suffix('\r').unwrap_or(l)))
        .filter(|l| !l.is_empty() && !PATH_ALIASES_RE.is_match(l) && !READING_STDIN_RE.is_match(l))
        .map(|l| LOG_PREFIX_RE.replacen(l, 1, "").into_owned())
        .collect();
    js::trim(&lines.join("\n")).to_string()
}

/// `text.replace(pattern, replacement)` with a text pattern: the first occurrence, with JavaScript's `$$`, `$&`,
/// `` $` `` and `$'` in the replacement.
fn js_replace_first(text: &str, pattern: &str, replacement: &str) -> String {
    let Some(at) = text.find(pattern) else {
        return text.to_string();
    };
    let (before, after) = (&text[..at], &text[at + pattern.len()..]);
    let mut expanded = String::new();
    let mut chars = replacement.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            match chars.peek() {
                Some('$') => {
                    expanded.push('$');
                    chars.next();
                    continue;
                }
                Some('&') => {
                    expanded.push_str(pattern);
                    chars.next();
                    continue;
                }
                Some('`') => {
                    expanded.push_str(before);
                    chars.next();
                    continue;
                }
                Some('\'') => {
                    expanded.push_str(after);
                    chars.next();
                    continue;
                }
                _ => {}
            }
        }
        expanded.push(c);
    }
    format!("{before}{expanded}{after}")
}

/// What a Codex failure means: `{ kind, recoverable, message }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexFailure {
    pub kind: ErrorKind,
    pub recoverable: bool,
    pub message: String,
}

/// What [`classify_codex_failure`] reads besides the words.
#[derive(Debug, Clone, Copy, Default)]
pub struct FailureContext<'a> {
    pub model: Option<&'a str>,
    pub local_url: Option<&'a str>,
    pub status: Option<u16>,
    pub code: Option<&'a str>,
}

/// What a Codex failure means (`engine_errors::classify_engine_error`, with Codex's own words for a thread it can't
/// resume, a server it can't reach, a Local AI server with no Responses API and a missing program).
pub fn classify_codex_failure(provider_id: &str, raw_message: &str, ctx: FailureContext<'_>) -> CodexFailure {
    let id = normalize_provider_id(provider_id).map_or_else(|| provider_id.to_string(), str::to_string);
    let message = clean_codex_error(raw_message);
    if MISSING_BINARY_RE.is_match(&message) {
        return CodexFailure {
            kind: ErrorKind::Unknown,
            recoverable: false,
            message: "**Codex isn't installed where Tarsee can run it** (the @openai/codex package or its program for this system is missing). Reinstall Tarsee's dependencies, then try again.".to_string(),
        };
    }
    if RESUME_FAILED_RE.is_match(&message) {
        return CodexFailure {
            kind: ErrorKind::Session,
            recoverable: true,
            message: friendly(&id, ErrorKind::Session, None, None),
        };
    }
    if SUBSCRIPTION_SHARING_RE.is_match(&message) {
        return CodexFailure {
            kind: ErrorKind::Unavailable,
            recoverable: false,
            message: "**The ChatGPT plan's usage isn't available to Codex right now.** Check the plan at chatgpt.com/codex/settings/usage, or switch to another AI in Settings > AI meanwhile.".to_string(),
        };
    }
    let c = classify_engine_error(
        &id,
        Some(Engine::Codex),
        EngineFailure {
            status: ctx.status,
            code: ctx.code,
            message: Some(&message),
            model: ctx.model,
        },
    );
    // A Local AI server that lists models but has no /responses route (Ollama before 0.13.3, LM Studio before 0.3.29,
    // a chat-completions-only server) answers 404 without a word about a model; a real unknown model's 404 names it.
    if id == "local"
        && c.kind == ErrorKind::Model
        && c.status == Some(404)
        && !MODEL_WORD_RE.is_match(&URL_PART_RE.replace_all(&message, ""))
    {
        return CodexFailure {
            kind: ErrorKind::Unavailable,
            recoverable: false,
            message: redact_secrets(&local_no_responses_message(ctx.local_url)),
        };
    }
    let mut kind = c.kind;
    let mut words = c.message.clone();
    if matches!(kind, ErrorKind::Unknown | ErrorKind::Unavailable) && UNREACHABLE_RE.is_match(&message) && c.status.is_none() {
        kind = ErrorKind::Unavailable;
    }
    if kind == ErrorKind::Unavailable && id == "local" {
        let hint = get_provider("local")
            .and_then(|p| p.error_hints.unreachable)
            .filter(|h| !h.is_empty())
            .unwrap_or("Can't reach your Local AI at {url}.");
        let place = ctx.local_url.filter(|u| !u.is_empty()).unwrap_or("its address");
        words = format!(
            "**{}** Check that the server is running and that the address in Settings > AI is right. If you just started llama-server with -hf, it may still be downloading the model.",
            js_replace_first(hint, "{url}", place)
        );
    } else if kind == ErrorKind::Unavailable && c.kind != ErrorKind::Unavailable {
        words = friendly(&id, ErrorKind::Unavailable, None, None);
    }
    if kind == ErrorKind::Rate
        && let Some(when) = TRY_AGAIN_RE.find(&message)
    {
        words = format!("{words} ({})", js::trim(when.as_str()));
    }
    CodexFailure {
        kind,
        recoverable: c.recoverable,
        message: redact_secrets(&words),
    }
}

/// The usage event and usage step for a thread's running total (Codex's turn.completed usage, or the last total its
/// rollout recorded for a turn that ended any other way): this turn's share, the total less the baseline.
pub fn usage_events(state: &CodexEventState, totals: &CodexUsage) -> Vec<TurnEvent> {
    let [input, cache_read, cache_write, output] = tarsee_usage(&usage_delta(totals, state.baseline.as_ref()));
    vec![
        event(json!({
            "type": "usage",
            "usage": {
                "input_tokens": js_num(input),
                "cache_read_input_tokens": js_num(cache_read),
                "cache_creation_input_tokens": js_num(cache_write),
                "output_tokens": js_num(output),
            },
        })),
        event(json!({
            "type": "step", "kind": "usage",
            "input": js_num(input), "cacheRead": js_num(cache_read), "cacheWrite": js_num(cache_write), "output": js_num(output),
            "total": js_num(input + cache_read + cache_write + output),
            "calls": null, "outTps": null, "nowTps": null,
        })),
    ]
}

impl CodexEventState {
    /// An item's id, remembered as JavaScript's `Set` and `Map` would have it: by value for text and numbers, by
    /// identity for an object (so only within the event it came in).
    fn id_of(&mut self, value: Option<&Value>) -> ToolId {
        let key = match value {
            None => "u".to_string(),
            Some(Value::Null) => "n".to_string(),
            Some(Value::Bool(b)) => format!("b{b}"),
            Some(Value::Number(n)) => format!("#{}", number_to_string(n.as_f64().unwrap_or(f64::NAN))),
            Some(Value::String(s)) => format!("s{s}"),
            Some(Value::Array(_) | Value::Object(_)) => {
                self.unique += 1;
                format!("o{}", self.unique)
            }
        };
        ToolId {
            key,
            value: value.cloned(),
        }
    }

    /// A tool's start: the tool_use and its step. `count_item` adds it to the tools started (the turn limit).
    fn start_tool(&mut self, id: &ToolId, name: &str, input: Value, count_item: bool) -> Vec<TurnEvent> {
        if !self.started.insert(id.key.clone()) {
            return Vec::new();
        }
        self.open.push((id.key.clone(), id.value.clone()));
        if count_item {
            self.tool_count += 1;
        }
        let start = step_start(&id.value, name, &input);
        let tool_use = event(with_id(
            &[("type", json!("tool_use"))],
            &id.value,
            vec![("name", json!(name)), ("input", input)],
        ));
        vec![tool_use, start]
    }

    /// A tool's end: the tool_result (text capped) and its step.
    fn end_tool(&mut self, id: &ToolId, ok: bool, text: &str) -> Vec<TurnEvent> {
        if let Some(at) = self.open.iter().position(|(key, _)| *key == id.key) {
            self.open.remove(at);
        }
        let result = utf16_truncate(text, RESULT_MAX_CHARS);
        let preview = result_preview(&Value::String(result.clone()));
        vec![
            event(with_id(
                &[("type", json!("tool_result"))],
                &id.value,
                vec![("ok", json!(ok)), ("result", json!(result))],
            )),
            event(with_id(
                &[("type", json!("step")), ("kind", json!("tool_end"))],
                &id.value,
                vec![("ok", json!(ok)), ("preview", json!(preview))],
            )),
        ]
    }

    /// Every tool still waiting for its result, closed as not finished.
    fn close_open(&mut self, why: &str) -> Vec<TurnEvent> {
        let open = self.open.clone();
        open.into_iter()
            .flat_map(|(key, value)| self.end_tool(&ToolId { key, value }, false, why))
            .collect()
    }

    fn todo_pair(&mut self, item: &Value) -> Vec<TurnEvent> {
        let items: &[Value] = item.get("items").and_then(Value::as_array).map_or(&[], Vec::as_slice);
        let key = js_stringify(&Value::Array(
            items
                .iter()
                .map(|t| json!([t.get("text").cloned().unwrap_or(Value::Null), t.get("completed").is_some_and(truthy)]))
                .collect(),
        ));
        let list = self.id_of(item.get("id")).key;
        let seen = self.todos.get(&list);
        if seen.is_some_and(|(seen_key, _)| *seen_key == key) {
            return Vec::new();
        }
        let n = seen.map_or(0, |(_, n)| *n) + 1;
        self.todos.insert(list, (key, n));
        let id = ToolId::text(format!("{}#{n}", tpl(item.get("id"))));
        let todos: Vec<Value> = items
            .iter()
            .map(|t| {
                let text = str_or_empty(t.get("text"));
                let done = t.get("completed").is_some_and(truthy);
                json!({"content": text, "status": if done { "completed" } else { "pending" }, "activeForm": text})
            })
            .collect();
        let mut out = self.start_tool(&id, "TodoWrite", json!({"todos": todos}), false);
        out.extend(self.end_tool(&id, true, "The task list was updated."));
        out
    }

    fn retry_step(&self, n: f64, of: f64, reason: Option<&str>) -> TurnEvent {
        let why = js::trim(reason.unwrap_or(""));
        let label = &self.label;
        let what = if let Some(status) = RETRY_STATUS_RE.captures(why) {
            let named = status.get(2).map(|m| format!(" {}", js::trim(m.as_str()))).unwrap_or_default();
            format!("{label} answered {}{named}", &status[1])
        } else if UNREACHABLE_RE.is_match(why) {
            format!("Couldn't reach {label}")
        } else if why.is_empty() {
            format!("{label} had a problem")
        } else {
            format!("{label} had a problem ({})", clip(why, 120))
        };
        let text = format!(
            "{what}. Trying again ({} of {}).",
            number_to_string(n),
            number_to_string(of)
        );
        step("status", redact_secrets(&clip(&text, STATUS_MAX_CHARS)))
    }

    /// The events a failure ends a turn with (and marks the state done).
    fn failure_events(&mut self, raw_message: &str) -> Vec<TurnEvent> {
        let c = classify_codex_failure(
            &self.provider_id,
            raw_message,
            FailureContext {
                model: self.model.as_deref(),
                local_url: self.local_url.as_deref(),
                ..FailureContext::default()
            },
        );
        self.done = true;
        let kind = c.kind.as_str();
        if matches!(c.kind, ErrorKind::Auth | ErrorKind::Expired) {
            return vec![
                event(json!({"type": "text", "content": c.message})),
                event(json!({"type": "error", "message": c.message, "code": kind, "subtype": "auth-expired", "recoverable": false})),
                event(json!({"type": "done", "stopReason": "auth-expired"})),
            ];
        }
        vec![
            event(json!({"type": "error", "message": c.message, "code": kind, "subtype": kind, "recoverable": c.recoverable})),
            event(json!({"type": "done", "stopReason": "error"})),
        ]
    }

    fn item_started(&mut self, item: Option<&Value>) -> Vec<TurnEvent> {
        let Some(item) = item.filter(|item| truthy(item)) else {
            return Vec::new();
        };
        let id = self.id_of(item.get("id"));
        self.item_started_as(item, &id)
    }

    /// An item's start, with its id worked out once for the whole event (an object id is only itself within it).
    fn item_started_as(&mut self, item: &Value, id: &ToolId) -> Vec<TurnEvent> {
        if !item.get("id").is_some_and(truthy) {
            return Vec::new();
        }
        let ty = item.get("type").and_then(Value::as_str);
        match ty {
            Some("command_execution") => {
                let command = unwrap_shell_command(&str_or_empty(item.get("command")));
                self.start_tool(id, "Bash", json!({"command": command}), true)
            }
            Some("mcp_tool_call") => {
                let name = format!("mcp__{}__{}", tpl(item.get("server")), tpl(item.get("tool")));
                let input = item.get("arguments").filter(|a| !a.is_null()).cloned().unwrap_or_else(|| json!({}));
                self.start_tool(id, &name, input, true)
            }
            Some("file_change") => {
                let tools = file_tools(item);
                if tools.is_empty() {
                    return Vec::new();
                }
                if !tools.iter().any(|t| self.started.contains(&t.id.key)) {
                    self.tool_count += 1;
                }
                tools
                    .into_iter()
                    .flat_map(|t| self.start_tool(&t.id, t.name, t.input, false))
                    .collect()
            }
            Some("todo_list") => self.todo_pair(item),
            Some("web_search") => {
                let query = str_or_empty(item.get("query"));
                self.start_tool(id, "WebSearch", json!({"query": query}), true)
            }
            Some("reasoning") => {
                if !self.thinking.insert(id.key.clone()) {
                    return Vec::new();
                }
                vec![event(json!({"type": "thinking", "status": "start"}))]
            }
            _ => Vec::new(),
        }
    }

    fn item_completed(&mut self, item: Option<&Value>) -> Vec<TurnEvent> {
        let Some(item) = item.filter(|item| truthy(item)) else {
            return Vec::new();
        };
        let id = self.id_of(item.get("id"));
        match item.get("type").and_then(Value::as_str) {
            Some("command_execution") => {
                let mut out = self.item_started_as(item, &id);
                let exit_code = item.get("exit_code");
                let is_zero = exit_code.and_then(Value::as_f64) == Some(0.0);
                let ok = item.get("status").and_then(Value::as_str) != Some("failed") && is_zero;
                let text = match item.get("aggregated_output").filter(|o| truthy(o)) {
                    Some(output) => js_string(output),
                    None => match exit_code {
                        Some(code) if !code.is_null() && !is_zero => format!("(exit code {})", js_string(code)),
                        _ => String::new(),
                    },
                };
                out.extend(self.end_tool(&id, ok, &text));
                out
            }
            Some("mcp_tool_call") => {
                let mut out = self.item_started_as(item, &id);
                let ok = item.get("status").and_then(Value::as_str) == Some("completed")
                    && !item.get("error").is_some_and(truthy);
                out.extend(self.end_tool(&id, ok, &mcp_result_text(item)));
                out
            }
            Some("file_change") => {
                let mut out = self.item_started_as(item, &id);
                let ok = item.get("status").and_then(Value::as_str) == Some("completed");
                for t in file_tools(item) {
                    let verb = match t.kind.as_ref().and_then(Value::as_str) {
                        Some("add") => "Added",
                        Some("delete") => "Deleted",
                        _ => "Updated",
                    };
                    let text = if ok {
                        format!("{verb} {}", t.path)
                    } else {
                        format!("The change to {} wasn't applied.", t.path)
                    };
                    out.extend(self.end_tool(&t.id, ok, &text));
                }
                out
            }
            Some("todo_list") => self.todo_pair(item),
            Some("web_search") => {
                let mut out = self.item_started_as(item, &id);
                out.extend(self.end_tool(&id, true, ""));
                out
            }
            Some("reasoning") => {
                let mut out = if self.thinking.remove(&id.key) {
                    Vec::new()
                } else {
                    vec![event(json!({"type": "thinking", "status": "start"}))]
                };
                let text = str_or_empty(item.get("text"));
                let text = js::trim(&text);
                if !text.is_empty() {
                    out.push(step("thinking", redact_secrets(&utf16_truncate(text, THINKING_MAX_CHARS))));
                }
                out.push(event(json!({"type": "thinking", "status": "stop"})));
                out
            }
            Some("agent_message") => {
                let text = str_or_empty(item.get("text"));
                if text.is_empty() {
                    return Vec::new();
                }
                let content = if self.text_count > 0 { format!("\n\n{text}") } else { text.clone() };
                self.text_count += 1;
                let mut out = vec![event(json!({"type": "text", "content": content}))];
                let trimmed = js::trim(&text);
                if !trimmed.is_empty() {
                    out.push(step("text", trimmed.to_string()));
                }
                out
            }
            Some("error") => {
                let message = str_or_empty(item.get("message"));
                let message = js::trim(&message);
                if message.is_empty() || NOISE_RE.is_match(message) {
                    return Vec::new();
                }
                vec![step("status", redact_secrets(&clip(message, STATUS_MAX_CHARS)))]
            }
            _ => Vec::new(),
        }
    }
}

// --- Mapping -----------------------------------------------------------------------------------------------------

/// Tarsee's events for one Codex event.
pub fn map_codex_event(ev: &Value, state: &mut CodexEventState) -> Vec<TurnEvent> {
    if !matches!(ev, Value::Object(_) | Value::Array(_)) || state.done {
        return Vec::new();
    }
    match ev.get("type").and_then(Value::as_str) {
        Some("thread.started") => {
            if let Some(thread) = ev.get("thread_id").filter(|t| truthy(t)) {
                state.thread_id = Some(js_string(thread));
            }
            Vec::new()
        }
        Some("item.started") => state.item_started(ev.get("item")),
        Some("item.updated") => match ev.get("item") {
            Some(item) if item.get("type").and_then(Value::as_str) == Some("todo_list") => state.todo_pair(item),
            _ => Vec::new(),
        },
        Some("item.completed") => state.item_completed(ev.get("item")),
        Some("turn.completed") => {
            let totals = CodexUsage::from_value(ev.get("usage").unwrap_or(&Value::Null));
            state.totals = Some(totals);
            state.done = true;
            let mut out = state.close_open("Ended without a result.");
            if state.baseline_known {
                out.extend(usage_events(state, &totals));
            }
            out.push(event(json!({"type": "done", "stopReason": "end_turn"})));
            out
        }
        Some("turn.failed") => {
            let mut out = state.close_open("The turn failed before it finished.");
            let words = match ev.get("error").and_then(|e| e.get("message")).filter(|m| truthy(m)) {
                Some(message) => js_string(message),
                None if !state.last_error.is_empty() => state.last_error.clone(),
                None => "The turn failed.".to_string(),
            };
            out.extend(state.failure_events(&words));
            out
        }
        Some("error") => {
            let message = str_or_empty(ev.get("message"));
            if let Some(retry) = RECONNECT_RE.captures(&message) {
                let reason = retry.get(3).map(|m| m.as_str());
                state.last_retry = reason.unwrap_or("").to_string();
                return vec![state.retry_step(js_number(&retry[1]), js_number(&retry[2]), reason)];
            }
            state.last_error = message;
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// How a turn ended, for [`finish_codex_events`].
#[derive(Debug, Clone, Default)]
pub struct FinishOptions {
    /// Stop, the idle watchdog, a caller giving up.
    pub aborted: bool,
    /// The turn started more tools than allowed: the limit.
    pub max_turns: Option<u64>,
    /// The message of what was thrown (the program missing or exiting, a thread it couldn't resume). An empty one
    /// reads as "Error", as `String(new Error(""))` did.
    pub error: Option<String>,
}

/// The end of a turn that didn't end itself (or nothing when it did): the tools still open are closed, then
///
/// ```text
///   aborted   done{aborted}, no error (Stop, the idle watchdog, a caller giving up)
///   maxTurns  error{subtype: error_max_turns} and done{max_turns}: the turn started more tools than allowed
///   error     what was thrown (the program missing or exiting, a thread it couldn't resume), else the last error
///             Codex reported: classified as for turn.failed
///   nothing   the engine ended without a word: an error and done{error}
/// ```
///
/// Never more than one done.
pub fn finish_codex_events(state: &mut CodexEventState, opts: FinishOptions) -> Vec<TurnEvent> {
    if state.done {
        return Vec::new();
    }
    if let Some(max_turns) = opts.max_turns {
        state.done = true;
        let mut out = state.close_open("Stopped: the turn limit was reached.");
        out.push(event(json!({
            "type": "error", "subtype": "error_max_turns", "code": "max_turns", "recoverable": false,
            "message": format!("Stopped after {max_turns} tool steps, the limit for this task. The task needs to be broken into smaller steps."),
        })));
        out.push(event(json!({"type": "done", "stopReason": "max_turns"})));
        return out;
    }
    if opts.aborted {
        state.done = true;
        let mut out = state.close_open("Stopped before it finished.");
        out.push(event(json!({"type": "done", "stopReason": "aborted"})));
        return out;
    }
    let mut out = state.close_open("The turn ended before it finished.");
    let thrown = match opts.error.as_deref() {
        Some("") => clean_codex_error("Error"),
        Some(message) => clean_codex_error(message),
        None => String::new(),
    };
    let words = [&thrown, &state.last_error, &state.last_retry]
        .into_iter()
        .find(|w| !w.is_empty())
        .cloned();
    if let Some(words) = words {
        let use_last_error = !thrown.is_empty()
            && !state.last_error.is_empty()
            && !RESUME_FAILED_RE.is_match(&thrown)
            && !MISSING_BINARY_RE.is_match(&thrown);
        let raw = if use_last_error { state.last_error.clone() } else { words };
        out.extend(state.failure_events(&raw));
        return out;
    }
    state.done = true;
    out.push(event(json!({
        "type": "error", "code": "unknown", "recoverable": false,
        "message": format!("{} stopped without finishing its reply. Try again.", state.label),
    })));
    out.push(event(json!({"type": "done", "stopReason": "error"})));
    out
}

#[cfg(test)]
mod tests;
