//! Port of `src/ai/local-bridge.js`: the Local AI bridge, a small loopback server between Codex and the owner's own AI
//! server (Ollama, LM Studio, llama.cpp's llama-server or any other Responses server).
//!
//! Why it is there. Codex 0.167 always sends Tarsee's tools (its MCP server) as one `{type: "namespace"}` tool holding
//! function tools, and finds the tool to run from a reply's `{namespace, name}` pair, with no fallback to a flat name.
//! LM Studio, Ollama before 0.34 and llama-server drop a namespace tool without a word (llama-server logs "unsupported
//! Responses tool type 'namespace' skipped"), so a Local AI model never sees the calculator, the memory or the files,
//! and Verify's tool check fails. The bridge rewrites each request so every server sees plain function tools, and each
//! reply so Codex gets its `{namespace, name}` back. It also smooths over what strict servers refuse (below).
//!
//! How a turn uses it. The Codex engine opens a turn here before Codex starts: [`LocalBridge::open`] gives a per-turn
//! address, `http://127.0.0.1:<port>/t/<turn id>/v1`, and a token. Codex's custom provider gets the address as its
//! base_url and the token as its key (TARSEE_PROVIDER_KEY, so it is never on Codex's command line, which the address
//! is), and the owner's key never enters the Codex process: the bridge adds it on the way to the owner's server. A
//! request must name the turn in its path and carry that turn's token as its Bearer header (compared in constant
//! time); both stop working when the turn releases them (the engine's `finally`, here also when the [`BridgeTurn`] is
//! dropped), or after [`MAX_TURN_MS`].
//!
//! Requests to `.../responses`:
//!   - each namespace tool becomes plain function tools named by one fixed rule ([`flat_name`]): the namespace and the
//!     name with "__" between them (none added when the namespace already ends in "__"), only `[A-Za-z0-9_-]`, at most
//!     64 characters (a longer one, or one that clashes with another tool, is cut and given a short hash). The rule is
//!     fixed, so nothing is kept between requests: each reply is mapped back with its own request's tools.
//!   - earlier function_call items in the history get the same flat name (their namespace removed)
//!   - tool types that aren't functions are dropped, and so are input items a server doesn't know (only messages,
//!     function calls, their outputs and reasoning are kept), always a call and its output together
//!   - reasoning items with no content array are dropped (llama-server answers 400 for one: a chat that switched from
//!     another provider's model has them)
//!   - every developer or system message at the start is merged into one (with the request's instructions, when it
//!     has both), and any later one becomes a user message: llama.cpp makes each a system message, and strict chat
//!     templates (the Qwen3.5 family's) refuse a system message that isn't first. The start of the prompt then stays
//!     the same from turn to turn, so the server's prompt cache keeps working.
//!   - an assistant's refusal part becomes output_text
//!   - everything else goes through unchanged
//!
//! Replies:
//!   - output_item.added and output_item.done events, function_call_arguments.done, and the output of
//!     response.completed (and of a reply that isn't streamed) get each function call's `{namespace, name}` back
//!   - a bare mid-stream error frame (llama-server's `data: {"error": ...}`, with no event name and no
//!     response.completed after it) becomes a response.failed event carrying the server's words
//!   - an HTTP error goes back unchanged; any other path (a GET of /models) is passed through as it is
//!   - when Codex hangs up, the request to the server is stopped
//!
//! Everything here runs inside Tarsee's own process. The server listens on 127.0.0.1 only and starts on first use
//! ([`local_bridge`]); the running bridge is a service of the [`App`] (or a [`LocalBridge`] its caller owns). Nothing
//! is logged with a key or a token in it.
//!
//! The requests to the owner's server go through the [`Fetch`] trait (the app's HTTP client), with no timeout of
//! their own and no redirect followed. The JSON the bridge rewrites is read and written back the way `JSON.parse` and
//! `JSON.stringify` did, so a request or a reply the Node version re-wrote comes out the same here.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::{ConnectInfo, Connected};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::serve::{IncomingStream, Listener};
use base64::Engine as _;
use bytes::Bytes;
use futures::StreamExt;
use futures::stream::{self, BoxStream};
use parking_lot::Mutex;
use rand::Rng;
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

use crate::ai::context_limits::{JS_DOT_CLASS, JS_SPACE_CLASS};
use crate::ai::engine_env::TypeError;
use crate::app::{App, WeakApp};
use crate::net::fetch::{ByteStream, Fetch, FetchError, FetchRequest, FetchResponse};
use crate::util::js::{self, number_to_string, truthy};

/// The longest tool name the Responses API takes (and llama.cpp's chat templates expect).
pub const MAX_TOOL_NAME: usize = 64;

/// How long a turn's token can work at most, even if its turn never says it is done.
pub const MAX_TURN_MS: i64 = 6 * 60 * 60 * 1000;

/// The largest request Codex sends that the bridge reads (its whole history; a picture is a file path, not bytes).
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// The input items every Responses server Tarsee knows takes.
const KNOWN_ITEMS: [&str; 4] = ["message", "function_call", "function_call_output", "reasoning"];

const LEAD_ROLES: [&str; 2] = ["developer", "system"];

fn sha(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(text.as_bytes()));
    out
}

/// `crypto.timingSafeEqual` of two digests of the same length.
fn same_digest(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b.iter()).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

// --- JavaScript values -------------------------------------------------------------------------------------------

/// A value as a template literal writes it (`${value}`): `undefined` for one that is not there, else `String(value)`.
pub(crate) fn tpl(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => js_string(value),
    }
}

/// `String(value ?? "")`.
pub(crate) fn str_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

/// `String(value)` for a JSON value: text as it is, a number as JavaScript writes it, an array as its items joined
/// with commas, an object as "[object Object]".
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_text(n),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// A parsed JSON number as JavaScript writes it: `JSON.parse` made it a double, and `String()` writes that double.
fn js_number_text(n: &serde_json::Number) -> String {
    const EXACT: u64 = 1 << 53;
    if let Some(u) = n.as_u64()
        && u <= EXACT
    {
        return u.to_string();
    }
    if let Some(i) = n.as_i64()
        && i.unsigned_abs() <= EXACT
    {
        return i.to_string();
    }
    number_to_string(n.as_f64().unwrap_or(f64::NAN))
}

/// `JSON.stringify(value)` for a value `JSON.parse` made: no spaces, numbers as JavaScript writes them (a whole
/// number without ".0", a long one rounded as a double), strings escaped as `JSON.stringify` escapes them.
pub(crate) fn js_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let text = js_number_text(n);
            // JSON has no NaN or Infinity: `JSON.stringify` writes them as null.
            if text == "NaN" || text.ends_with("Infinity") {
                out.push_str("null");
            } else {
                out.push_str(&text);
            }
        }
        Value::String(s) => out.push_str(&json_string(s)),
        Value::Array(items) => {
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (n, (key, item)) in map.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                out.push_str(&json_string(key));
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

/// A string as JSON: the same escapes as `JSON.stringify` (`\"`, `\\`, `\b \f \n \r \t`, `\u00xx` for the other
/// control characters, nothing else).
fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
}

/// A key for a JavaScript `Set` or `Map` of these values (SameValueZero): the same for two equal texts, numbers,
/// booleans, nulls or two missing values; `None` for an object or an array, which only ever equals itself and, read
/// from JSON, never meets itself again.
fn same_value(value: Option<&Value>) -> Option<String> {
    Some(match value {
        None => "u".to_string(),
        Some(Value::Null) => "n".to_string(),
        Some(Value::Bool(b)) => format!("b{b}"),
        Some(Value::Number(n)) => format!("#{}", number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(s)) => format!("s{s}"),
        Some(Value::Array(_) | Value::Object(_)) => return None,
    })
}

fn is_str(value: Option<&Value>, text: &str) -> bool {
    value.and_then(Value::as_str) == Some(text)
}

// --- Names -------------------------------------------------------------------------------------------------------

/// Every UTF-16 unit that is not `[A-Za-z0-9_-]` as "_" (`text.replace(/[^A-Za-z0-9_-]/g, "_")`).
fn only_name_chars(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    out
}

/// The flat name for a namespace's tool, before any clash: "<namespace>__<name>", only `[A-Za-z0-9_-]`.
fn base_name(namespace: Option<&Value>, name: Option<&Value>) -> String {
    let ns = str_or_empty(namespace);
    let name = tpl(name);
    let joined = if !ns.is_empty() && !ns.ends_with("__") {
        format!("{ns}__{name}")
    } else {
        format!("{ns}{name}")
    };
    only_name_chars(&joined)
}

/// The same name cut to fit 64 characters with a short hash of the pair at its end (always 64 long when cut).
fn hashed_name(namespace: Option<&Value>, name: Option<&Value>, hash_chars: usize) -> String {
    let digest = hex::encode(sha(&format!("{}\u{0}{}", tpl(namespace), tpl(name))));
    let tag = &digest[..hash_chars.min(digest.len())];
    let base = base_name(namespace, name);
    // The base is ASCII: a byte is a character.
    let keep = (MAX_TOOL_NAME - hash_chars - 1).min(base.len());
    format!("{}_{tag}", &base[..keep])
}

fn flat_name_of(namespace: Option<&Value>, name: Option<&Value>, taken: Option<&HashSet<String>>) -> String {
    let in_use = |candidate: &str| taken.is_some_and(|taken| taken.contains(candidate));
    let plain = base_name(namespace, name);
    if plain.len() <= MAX_TOOL_NAME && !in_use(&plain) {
        return plain;
    }
    for chars in [8, 12, 16] {
        let cut = hashed_name(namespace, name, chars);
        if !in_use(&cut) {
            return cut;
        }
    }
    hashed_name(namespace, name, 24)
}

/// The flat name a namespace's tool is sent under, by the fixed rule: the joined name, or the hashed one when that is
/// longer than 64 characters or already taken (`taken`: the names in use).
pub fn flat_name(namespace: &str, name: &str, taken: Option<&HashSet<String>>) -> String {
    let namespace = Value::String(namespace.to_string());
    let name = Value::String(name.to_string());
    flat_name_of(Some(&namespace), Some(&name), taken)
}

/// Where a flat name came from: the namespace as the request had it (`None` when its namespace tool had no name) and
/// the tool's own name.
#[derive(Debug, Clone, PartialEq)]
pub struct OriginalName {
    pub namespace: Option<Value>,
    pub name: String,
}

/// A request's flat names, both ways: `by_flat` maps each flat name back to its `{namespace, name}`, and `by_pair`
/// pairs each "<namespace>\0<name>" with its flat name.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolNames {
    pub by_flat: HashMap<String, OriginalName>,
    pub by_pair: HashMap<String, String>,
}

/// A request's tools for a server that only takes function tools.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FlatTools {
    /// Every function tool as it is, and each namespace's function tools in its place with their flat names; any
    /// other kind of tool is left out.
    pub tools: Vec<Value>,
    pub names: ToolNames,
}

/// A request's tools for a server that only takes function tools (see [`FlatTools`]). `tools` is the request's
/// `tools` field (anything but an array is no tools).
pub fn flatten_tools(tools: Option<&Value>) -> FlatTools {
    let list: &[Value] = tools.and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let mut taken: HashSet<String> = list
        .iter()
        .filter(|t| is_str(t.get("type"), "function"))
        .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut names = ToolNames::default();
    let mut out = Vec::new();
    for t in list {
        if is_str(t.get("type"), "function") {
            out.push(t.clone());
            continue;
        }
        let Some(subtools) = t.get("tools").and_then(Value::as_array) else {
            continue;
        };
        if !is_str(t.get("type"), "namespace") {
            continue;
        }
        let namespace = t.get("name");
        for s in subtools {
            let Some(fields) = s.as_object() else {
                continue;
            };
            let Some(name) = fields.get("name").and_then(Value::as_str) else {
                continue;
            };
            if fields
                .get("type")
                .is_some_and(|ty| truthy(ty) && ty.as_str() != Some("function"))
            {
                continue;
            }
            let name_value = Value::String(name.to_string());
            let flat = flat_name_of(namespace, Some(&name_value), Some(&taken));
            taken.insert(flat.clone());
            names.by_flat.insert(
                flat.clone(),
                OriginalName {
                    namespace: namespace.cloned(),
                    name: name.to_string(),
                },
            );
            names
                .by_pair
                .insert(format!("{}\u{0}{name}", tpl(namespace)), flat.clone());
            let mut tool = fields.clone();
            tool.insert("type".into(), Value::String("function".into()));
            tool.insert("name".into(), Value::String(flat));
            out.push(Value::Object(tool));
        }
    }
    FlatTools { tools: out, names }
}

/// The flat name an earlier call to a namespace's tool goes under: its request's own, else the fixed rule's.
fn flat_for_call(names: &ToolNames, namespace: Option<&Value>, name: Option<&Value>) -> String {
    match names.by_pair.get(&format!("{}\u{0}{}", tpl(namespace), tpl(name))) {
        Some(flat) if !flat.is_empty() => flat.clone(),
        _ => flat_name_of(namespace, name, None),
    }
}

// --- Requests ----------------------------------------------------------------------------------------------------

/// An input item's type: its `type`, or "message" for one with a role and no type. `None` for anything else (a type
/// that is not text included: it is no type a server knows).
fn item_type(item: &Value) -> Option<&str> {
    let fields = item.as_object()?;
    match fields.get("type") {
        Some(ty) if truthy(ty) => ty.as_str(),
        _ => fields.get("role").is_some_and(truthy).then_some("message"),
    }
}

fn is_known(ty: Option<&str>) -> bool {
    ty.is_some_and(|ty| KNOWN_ITEMS.contains(&ty))
}

fn is_lead_role(role: Option<&Value>) -> bool {
    role.and_then(Value::as_str)
        .is_some_and(|role| LEAD_ROLES.contains(&role))
}

/// A message's words: its text parts joined (a string content as it is).
fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

/// A message's parts that aren't words (kept when messages are merged).
fn other_parts(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|p| truthy(p) && !p.get("text").is_some_and(Value::is_string))
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

/// An assistant's refusal parts as output_text (a server that doesn't know the part type answers 400).
fn without_refusals(item: &Value) -> Value {
    let Some(parts) = item.get("content").and_then(Value::as_array) else {
        return item.clone();
    };
    let is_refusal = |p: &Value| is_str(p.get("type"), "refusal");
    if !parts.iter().any(is_refusal) {
        return item.clone();
    }
    let content: Vec<Value> = parts
        .iter()
        .map(|p| {
            if !is_refusal(p) {
                return p.clone();
            }
            let words = [p.get("refusal"), p.get("text")]
                .into_iter()
                .flatten()
                .find(|v| !v.is_null())
                .map(js_string)
                .unwrap_or_default();
            json!({"type": "output_text", "text": words, "annotations": []})
        })
        .collect();
    let mut out = item.as_object().cloned().unwrap_or_default();
    out.insert("content".into(), Value::Array(content));
    Value::Object(out)
}

/// A request rewritten for the owner's server, and the names to map its reply back with.
#[derive(Debug, Clone, PartialEq)]
pub struct RewrittenRequest {
    /// A new body (the one given is not changed).
    pub body: Value,
    pub names: ToolNames,
}

/// A Responses request body as any Local AI server takes it (see the top of this file).
pub fn rewrite_request(original: &Value) -> RewrittenRequest {
    let Some(fields) = original.as_object() else {
        return RewrittenRequest {
            body: original.clone(),
            names: ToolNames::default(),
        };
    };
    let mut body = fields.clone();
    let FlatTools { tools, names } = flatten_tools(fields.get("tools"));
    if fields.get("tools").is_some_and(Value::is_array) {
        body.insert("tools".into(), Value::Array(tools));
    }
    if let Some(Value::Object(choice)) = fields.get("tool_choice")
        && choice.get("namespace").is_some_and(truthy)
        && choice.get("name").is_some_and(Value::is_string)
    {
        let mut rest = choice.clone();
        let namespace = rest.shift_remove("namespace");
        rest.insert("type".into(), Value::String("function".into()));
        let flat = flat_for_call(&names, namespace.as_ref(), choice.get("name"));
        rest.insert("name".into(), Value::String(flat));
        body.insert("tool_choice".into(), Value::Object(rest));
    }
    if let Some(Value::Array(input)) = fields.get("input") {
        let input = rewrite_input(input, &names, &mut body);
        body.insert("input".into(), Value::Array(input));
    }
    RewrittenRequest {
        body: Value::Object(body),
        names,
    }
}

/// The input items, cleaned for the server (`rewrite_request`'s list). May move the request's instructions into them.
fn rewrite_input(input: &[Value], names: &ToolNames, body: &mut Map<String, Value>) -> Vec<Value> {
    // Items the server wouldn't know, and every call that has one of them as its pair.
    let call_id = |item: &Value| item.get("call_id").filter(|id| truthy(id)).cloned();
    let dropped: HashSet<String> = input
        .iter()
        .filter(|item| !is_known(item_type(item)))
        .filter_map(&call_id)
        .filter_map(|id| same_value(Some(&id)))
        .collect();
    let mut kept: Vec<Value> = Vec::new();
    for item in input {
        let ty = item_type(item);
        if !is_known(ty) {
            continue;
        }
        if matches!(ty, Some("function_call" | "function_call_output"))
            && call_id(item).is_some_and(|id| same_value(Some(&id)).is_some_and(|key| dropped.contains(&key)))
        {
            continue;
        }
        if ty == Some("reasoning") && !item.get("content").is_some_and(Value::is_array) {
            continue;
        }
        if ty == Some("function_call") && item.get("namespace").is_some_and(truthy) {
            let mut rest = item.as_object().cloned().unwrap_or_default();
            let namespace = rest.shift_remove("namespace");
            let flat = flat_for_call(names, namespace.as_ref(), item.get("name"));
            rest.insert("name".into(), Value::String(flat));
            kept.push(Value::Object(rest));
            continue;
        }
        kept.push(if ty == Some("message") {
            without_refusals(item)
        } else {
            item.clone()
        });
    }
    // An output whose call is gone can't be sent alone (a chat template has nothing to attach it to).
    let calls: HashSet<String> = kept
        .iter()
        .filter(|item| item_type(item) == Some("function_call"))
        .filter_map(|item| same_value(item.get("call_id")))
        .collect();
    let paired: Vec<Value> = kept
        .into_iter()
        .filter(|item| {
            item_type(item) != Some("function_call_output")
                || same_value(item.get("call_id")).is_some_and(|key| calls.contains(&key))
        })
        .collect();

    // The developer and system messages at the start become one; any later one is a user message.
    let lead = paired
        .iter()
        .take_while(|item| item_type(item) == Some("message") && is_lead_role(item.get("role")))
        .count();
    let instructions = body
        .get("instructions")
        .and_then(Value::as_str)
        .filter(|text| !js::trim(text).is_empty())
        .map(str::to_string);
    let mut out = Vec::new();
    if lead > 1 || (lead == 1 && instructions.is_some()) {
        let first = &paired[0];
        let words: Vec<String> = instructions
            .iter()
            .cloned()
            .chain(paired[..lead].iter().map(|m| text_of(m.get("content"))))
            .filter(|text| !js::trim(text).is_empty())
            .collect();
        let mut merged = Map::new();
        if first.get("type").is_some_and(truthy) {
            merged.insert("type".into(), Value::String("message".into()));
        }
        merged.insert("role".into(), first.get("role").cloned().unwrap_or(Value::Null));
        let mut content = vec![json!({"type": "input_text", "text": words.join("\n\n")})];
        content.extend(paired[..lead].iter().flat_map(|m| other_parts(m.get("content"))));
        merged.insert("content".into(), Value::Array(content));
        out.push(Value::Object(merged));
        if instructions.is_some() {
            body.shift_remove("instructions");
        }
    } else if lead == 1 {
        out.push(paired[0].clone());
    }
    for item in &paired[lead..] {
        if item_type(item) == Some("message") && is_lead_role(item.get("role")) {
            let mut user = item.as_object().cloned().unwrap_or_default();
            user.insert("role".into(), Value::String("user".into()));
            out.push(Value::Object(user));
        } else {
            out.push(item.clone());
        }
    }
    out
}

// --- Replies -----------------------------------------------------------------------------------------------------

/// A reply's item with its `{namespace, name}` back, when it is a call to a flattened tool; `None` when nothing
/// changes (the JS gave back the very same item).
pub fn restore_item(item: &Value, names: &ToolNames) -> Option<Value> {
    let fields = item.as_object()?;
    if !is_str(fields.get("type"), "function_call") {
        return None;
    }
    let orig = names.by_flat.get(fields.get("name")?.as_str()?)?;
    let mut out = fields.clone();
    out.insert("name".into(), Value::String(orig.name.clone()));
    set_namespace(&mut out, &orig.namespace);
    Some(Value::Object(out))
}

/// `{ ...item, namespace }`: a namespace that is not there (`undefined`) leaves none in the JSON.
fn set_namespace(fields: &mut Map<String, Value>, namespace: &Option<Value>) {
    match namespace {
        Some(namespace) => {
            fields.insert("namespace".into(), namespace.clone());
        }
        None => {
            fields.shift_remove("namespace");
        }
    }
}

static FUNCTION_CALL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new("function_call").expect("a fixed pattern"));

/// A Responses event (or a whole response) with every flattened call's `{namespace, name}` back; `None` when nothing
/// changed (the JS gave back the very same object).
pub fn restore_event(event: &Value, names: &ToolNames) -> Option<Value> {
    let fields = event.as_object()?;
    if names.by_flat.is_empty() {
        return None;
    }
    let mut out: Option<Map<String, Value>> = None;
    let mut set = |key: &str, value: Option<Value>| {
        let out = out.get_or_insert_with(|| fields.clone());
        match value {
            Some(value) => {
                out.insert(key.to_string(), value);
            }
            None => {
                out.shift_remove(key);
            }
        }
    };
    if let Some(item) = fields.get("item").filter(|item| truthy(item))
        && let Some(restored) = restore_item(item, names)
    {
        set("item", Some(restored));
    }
    if let Some(Value::Array(list)) = fields.get("output") {
        let mapped: Vec<Option<Value>> = list.iter().map(|item| restore_item(item, names)).collect();
        if mapped.iter().any(Option::is_some) {
            let output = list
                .iter()
                .zip(mapped)
                .map(|(item, restored)| restored.unwrap_or_else(|| item.clone()))
                .collect();
            set("output", Some(Value::Array(output)));
        }
    }
    if let Some(response) = fields.get("response").filter(|r| truthy(r))
        && let Some(restored) = restore_event(response, names)
    {
        set("response", Some(restored));
    }
    if let Some(Value::String(name)) = fields.get("name") {
        let ty = fields
            .get("type")
            .filter(|ty| truthy(ty))
            .map(js_string)
            .unwrap_or_default();
        if FUNCTION_CALL_RE.is_match(&ty)
            && let Some(orig) = names.by_flat.get(name)
        {
            set("name", Some(Value::String(orig.name.clone())));
            set("namespace", orig.namespace.clone());
        }
    }
    out.map(Value::Object)
}

/// A context overflow in a server's words (llama-server, LM Studio, Ollama).
pub static CONTEXT_OVERFLOW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:exceed_context_size_error|exceeds the available context size|is larger than the max context size|context (?:length|window) (?:exceeded|is exceeded)|context_length_exceeded|maximum context length)")
        .expect("the context overflow pattern")
});

/// A bare error frame's payload as a response.failed event, carrying the server's words.
fn failed_event(payload: &Value, response_id: Option<&Value>) -> Value {
    let error = payload.get("error");
    let message = match error {
        Some(Value::String(text)) => text.clone(),
        _ => match error.and_then(|e| e.get("message")).filter(|m| !m.is_null()) {
            Some(message) => js_string(message),
            None => js_stringify(error.filter(|e| !e.is_null()).unwrap_or(payload)),
        },
    };
    let raw = match error {
        Some(e @ (Value::Object(_) | Value::Array(_))) => [e.get("type"), e.get("code")]
            .into_iter()
            .flatten()
            .find(|v| !v.is_null())
            .cloned(),
        _ => None,
    };
    let raw_text = raw.as_ref().map(js_string);
    let code = if CONTEXT_OVERFLOW_RE.is_match(&format!("{} {message}", raw_text.as_deref().unwrap_or(""))) {
        "context_length_exceeded".to_string()
    } else {
        raw_text.unwrap_or_else(|| "server_error".to_string())
    };
    let id = response_id
        .filter(|id| truthy(id))
        .cloned()
        .unwrap_or_else(|| Value::String("resp_local_bridge".into()));
    json!({
        "type": "response.failed",
        "response": {"id": id, "object": "response", "status": "failed", "error": {"code": code, "message": message}, "output": []},
    })
}

/// The end of an SSE frame: a blank line, with or without carriage returns.
static FRAME_END_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n\r?\n").expect("a fixed pattern"));

/// A rewriter for a reply's SSE stream: [`push`](Self::push) gives the text to pass on (whole frames only; a frame
/// split across network chunks waits for its end), [`end`](Self::end) whatever was left. Frames that don't change
/// are passed on exactly as they came (each ended with one blank line).
#[derive(Debug, Clone)]
pub struct SseRewriter {
    names: ToolNames,
    buf: String,
    /// How far into `buf` no frame end can start any more (the search picks up there).
    searched: usize,
    response_id: Option<Value>,
}

/// A rewriter for a reply's SSE stream with these names.
pub fn create_sse_rewriter(names: ToolNames) -> SseRewriter {
    SseRewriter {
        names,
        buf: String::new(),
        searched: 0,
        response_id: None,
    }
}

impl SseRewriter {
    pub fn push(&mut self, text: &str) -> String {
        self.buf.push_str(text);
        self.take(false)
    }

    pub fn end(&mut self) -> String {
        self.take(true)
    }

    fn take(&mut self, last: bool) -> String {
        let mut out = String::new();
        while let Some(found) = FRAME_END_RE.find_at(&self.buf, self.searched) {
            let (start, end) = (found.start(), found.end());
            let raw = self.buf[..start].to_string();
            out.push_str(&self.frame(&raw));
            self.buf.drain(..end);
            self.searched = 0;
        }
        // A frame end is at most four bytes, so one not found yet starts in the last three.
        let mut from = self.buf.len().saturating_sub(3);
        while !self.buf.is_char_boundary(from) {
            from -= 1;
        }
        self.searched = from;
        if last && !self.buf.is_empty() {
            let raw = std::mem::take(&mut self.buf);
            out.push_str(&self.frame(&raw));
            self.searched = 0;
        }
        out
    }

    fn frame(&mut self, raw: &str) -> String {
        if js::trim(raw).is_empty() {
            return String::new();
        }
        let mut event: Option<String> = None;
        let mut data: Vec<&str> = Vec::new();
        for line in raw.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(name) = line.strip_prefix("event:") {
                event = Some(js::trim(name).to_string());
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.strip_prefix(' ').unwrap_or(value));
            }
        }
        let payload = if data.is_empty() {
            None
        } else {
            serde_json::from_str::<Value>(&data.join("\n")).ok()
        };
        let Some(payload) = payload.filter(|p| p.is_object() || p.is_array()) else {
            return format!("{raw}\n\n");
        };
        if self.response_id.is_none()
            && let Some(id) = payload
                .get("response")
                .and_then(|r| r.get("id"))
                .filter(|id| truthy(id))
        {
            self.response_id = Some(id.clone());
        }
        let event = event.filter(|name| !name.is_empty());
        if event.is_none() && !payload.get("type").is_some_and(truthy) && payload.get("error").is_some_and(truthy) {
            let failed = failed_event(&payload, self.response_id.as_ref());
            return format!("event: response.failed\ndata: {}\n\n", js_stringify(&failed));
        }
        match restore_event(&payload, &self.names) {
            None => format!("{raw}\n\n"),
            Some(restored) => {
                let head = event.map(|name| format!("event: {name}\n")).unwrap_or_default();
                format!("{head}data: {}\n\n", js_stringify(&restored))
            }
        }
    }
}

/// UTF-8 bytes arriving in pieces, as text (`new TextDecoder().decode(chunk, { stream: true })`): a character cut
/// between two pieces waits for its end, and bytes that are not UTF-8 become U+FFFD.
#[derive(Debug, Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    /// The text in `chunk`. `more` is false for the last call (`decoder.decode()`), which also gives up on a
    /// character left unfinished.
    fn decode(&mut self, chunk: &[u8], more: bool) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut out = String::new();
        let mut rest: &[u8] = &bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    out.push_str(&String::from_utf8_lossy(&rest[..valid]));
                    match err.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &rest[valid + len..];
                        }
                        None => {
                            if more {
                                self.pending = rest[valid..].to_vec();
                            } else {
                                out.push('\u{FFFD}');
                            }
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

// --- The server --------------------------------------------------------------------------------------------------

const REFUSED: &str = "This address is only for the Local AI turn it was made for.";

fn json_response(status: u16, body: &Value) -> Response {
    let mut res = Response::new(Body::from(js_stringify(body)));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    res.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    res
}

fn refuse() -> Response {
    json_response(
        401,
        &json!({"error": {"message": REFUSED, "type": "invalid_request_error", "code": "invalid_api_key"}}),
    )
}

/// Codex's request headers worth passing on (never its Authorization: that is the turn's token).
const DROPPED_HEADERS: [&str; 11] = [
    "authorization",
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "accept-encoding",
    "upgrade",
    "proxy-authorization",
    "te",
    "trailer",
];

/// Headers Node keeps only the first of when a request repeats them (`req.headers`).
const FIRST_ONLY_HEADERS: [&str; 18] = [
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

/// A request header as Node's `req.headers[name]` had it: the first of some, every value joined for the rest
/// (`cookie` with "; ", the others with ", "), and `set-cookie` as a list (`None` here: it is never passed on).
fn node_header(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut values = headers
        .get_all(name)
        .iter()
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    if name == "set-cookie" {
        return None;
    }
    if FIRST_ONLY_HEADERS.contains(&name) {
        return values.next();
    }
    let all: Vec<String> = values.collect();
    if all.is_empty() {
        return None;
    }
    Some(all.join(if name == "cookie" { "; " } else { ", " }))
}

fn upstream_headers(headers: &HeaderMap, key: Option<&str>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for name in headers.keys() {
        let name = name.as_str();
        if DROPPED_HEADERS.contains(&name) {
            continue;
        }
        if let Some(value) = node_header(headers, name) {
            out.push((name.to_string(), value));
        }
    }
    out.push(("accept-encoding".into(), "identity".into()));
    if let Some(key) = key {
        out.push(("authorization".into(), format!("Bearer {key}")));
    }
    out
}

/// Why a request to the owner's server failed, in short words (a connection refused, a timeout...).
fn reach_why(err: &FetchError) -> &'static str {
    let cause = match err {
        FetchError::Timeout => return "it took too long to answer",
        FetchError::Connect(cause) | FetchError::Body(cause) | FetchError::Other(cause) => cause.to_lowercase(),
    };
    let has = |words: &[&str]| words.iter().any(|w| cause.contains(w));
    if has(&["refused", "(os error 111)", "(os error 61)", "(os error 10061)"]) {
        "connection refused"
    } else if has(&[
        "dns error",
        "failed to lookup",
        "no such host",
        "name or service not known",
    ]) {
        "the name isn't known"
    } else if has(&[
        "reset",
        "forcibly closed",
        "(os error 104)",
        "(os error 54)",
        "(os error 10054)",
    ]) {
        "the connection was reset"
    } else if has(&[
        "timed out",
        "did not properly respond",
        "(os error 110)",
        "(os error 60)",
        "(os error 10060)",
    ]) {
        "it took too long to answer"
    } else {
        "network error"
    }
}

/// One open turn: its id, its token's digest, the owner's server and key, until when it works, and the requests in
/// flight for it (stopped when the turn closes).
struct Turn {
    id: String,
    digest: [u8; 32],
    upstream: String,
    key: Option<String>,
    until: i64,
    live: CancellationToken,
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Shared {
    turns: Mutex<HashMap<String, Arc<Turn>>>,
    fetch: Arc<dyn Fetch>,
    now: Clock,
}

impl Shared {
    fn lookup(&self, id: &str) -> Option<Arc<Turn>> {
        let mut turns = self.turns.lock();
        let turn = turns.get(id)?.clone();
        if (self.now)() > turn.until {
            turns.remove(&turn.id);
            turn.live.cancel();
            return None;
        }
        Some(turn)
    }

    fn close_turn(&self, turn: &Arc<Turn>) {
        let mut turns = self.turns.lock();
        if turns.get(&turn.id).is_some_and(|open| Arc::ptr_eq(open, turn)) {
            turns.remove(&turn.id);
        }
        drop(turns);
        turn.live.cancel();
    }
}

/// What [`start_local_bridge`] starts with (the JS `opts`).
#[derive(Clone)]
pub struct BridgeOptions {
    /// How the owner's server is reached (the JS `request`): the app's HTTP client, or a test's.
    pub fetch: Arc<dyn Fetch>,
    /// The clock, in milliseconds since 1970 (`Date.now`).
    pub now: Option<Clock>,
    /// How long a turn's token works.
    pub max_turn_ms: i64,
    /// The address the server listens on.
    pub host: String,
}

impl BridgeOptions {
    /// The defaults, with this HTTP client.
    pub fn new(fetch: Arc<dyn Fetch>) -> Self {
        BridgeOptions {
            fetch,
            now: None,
            max_turn_ms: MAX_TURN_MS,
            host: "127.0.0.1".to_string(),
        }
    }
}

/// A running bridge: `{ port, open(), turns(), close() }`. Dropping it stops the server.
pub struct LocalBridge {
    shared: Arc<Shared>,
    port: u16,
    host: String,
    max_turn_ms: i64,
    /// Cancelled to stop: the server stops listening and every connection is cut.
    stop: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for LocalBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalBridge")
            .field("port", &self.port)
            .field("turns", &self.turns())
            .finish_non_exhaustive()
    }
}

/// One turn's own address on the bridge: `{ url, id, token, release() }`. Dropping it releases the turn.
pub struct BridgeTurn {
    /// `http://127.0.0.1:<port>/t/<id>/v1`: Codex's base_url.
    pub url: String,
    pub id: String,
    /// The turn's Bearer token: Codex's key (TARSEE_PROVIDER_KEY), never on its command line.
    pub token: String,
    turn: Arc<Turn>,
    shared: Arc<Shared>,
}

impl BridgeTurn {
    /// Stops the turn's address and token working, and stops its requests in flight. Safe to call more than once.
    pub fn release(&self) {
        self.shared.close_turn(&self.turn);
    }
}

impl Drop for BridgeTurn {
    fn drop(&mut self) {
        self.release();
    }
}

impl std::fmt::Debug for BridgeTurn {
    /// Without the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BridgeTurn")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

static TRAILING_SLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new("/+$").expect("a fixed pattern"));

fn random_base64url<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl LocalBridge {
    /// The port the server listens on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// A turn's own address. `upstream` is the owner's server address (…/v1), `key` its key or `None`. Refuses an
    /// address that isn't a plain http(s) URL and a key with a line break (a caller's mistake: `TypeError`).
    pub fn open(&self, upstream: &str, key: Option<&str>) -> Result<BridgeTurn, TypeError> {
        let address = js::trim(upstream);
        let plain = url::Url::parse(address).ok().is_some_and(|u| {
            matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none()
        });
        if !plain {
            return Err(TypeError(
                "local-bridge: the Local AI address must be a plain http(s) URL".into(),
            ));
        }
        let key = js::trim(key.unwrap_or(""));
        if key.contains(['\r', '\n', '\0']) {
            return Err(TypeError("local-bridge: the key has a line break in it".into()));
        }
        let token = random_base64url::<32>();
        let id = random_base64url::<16>();
        let turn = Arc::new(Turn {
            id: id.clone(),
            digest: sha(&token),
            upstream: TRAILING_SLASHES.replace(address, "").into_owned(),
            key: (!key.is_empty()).then(|| key.to_string()),
            until: (self.shared.now)().saturating_add(self.max_turn_ms),
            live: CancellationToken::new(),
        });
        self.shared.turns.lock().insert(id.clone(), turn.clone());
        Ok(BridgeTurn {
            url: format!("http://{}:{}/t/{id}/v1", self.host, self.port),
            id,
            token,
            turn,
            shared: self.shared.clone(),
        })
    }

    /// How many turns are open (tests).
    pub fn turns(&self) -> usize {
        self.shared.turns.lock().len()
    }

    /// Closes every turn and the server, cutting every connection. Returns once the server has stopped.
    pub async fn close(&self) {
        let open: Vec<Arc<Turn>> = self.shared.turns.lock().drain().map(|(_, turn)| turn).collect();
        for turn in open {
            turn.live.cancel();
        }
        self.stop.cancel();
        let task = self.task.lock().take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

impl Drop for LocalBridge {
    fn drop(&mut self) {
        for turn in self.shared.turns.lock().values() {
            turn.live.cancel();
        }
        self.stop.cancel();
    }
}

/// Starts a bridge on a port the system picks.
pub async fn start_local_bridge(opts: BridgeOptions) -> io::Result<LocalBridge> {
    let listener = TcpListener::bind((opts.host.as_str(), 0)).await?;
    let port = listener.local_addr()?.port();
    let now: Clock = opts.now.clone().unwrap_or_else(|| Arc::new(js::now_ms));
    let shared = Arc::new(Shared {
        turns: Mutex::new(HashMap::new()),
        fetch: opts.fetch.clone(),
        now,
    });
    let stop = CancellationToken::new();
    let router = Router::new().fallback(handle).with_state(shared.clone());
    let serve = axum::serve(
        BridgeListener {
            listener,
            stop: stop.clone(),
        },
        router.into_make_service_with_connect_info::<Conn>(),
    )
    .with_graceful_shutdown(stop.clone().cancelled_owned());
    let task = tokio::spawn(async move {
        let _ = serve.await;
    });
    Ok(LocalBridge {
        shared,
        port,
        host: opts.host,
        max_turn_ms: opts.max_turn_ms,
        stop,
        task: Mutex::new(Some(task)),
    })
}

/// The app's bridge, started on first use (a start that fails is tried again by the next caller).
#[derive(Default)]
struct AppBridge(tokio::sync::OnceCell<Arc<LocalBridge>>);

/// The app's bridge, started on first use. Its requests go through the app's HTTP client (`app.fetch()`).
pub async fn local_bridge(app: &App) -> io::Result<Arc<LocalBridge>> {
    let holder = app.get_or_init(AppBridge::default);
    let weak = app.downgrade();
    holder
        .0
        .get_or_try_init(|| async move {
            start_local_bridge(BridgeOptions::new(Arc::new(AppFetch(weak))))
                .await
                .map(Arc::new)
        })
        .await
        .cloned()
}

/// The app's HTTP client as it is at each request (a test may swap it), without keeping the app alive.
struct AppFetch(WeakApp);

#[async_trait]
impl Fetch for AppFetch {
    async fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, FetchError> {
        let Some(app) = self.0.upgrade() else {
            return Err(FetchError::Other("the app has shut down".into()));
        };
        let fetch = app.fetch();
        drop(app);
        fetch.fetch(request).await
    }
}

/// A bridge address's turn id blanked out, for words that may be shown or logged ("…/t/…/v1/responses").
pub fn redact_bridge_urls(text: &str) -> String {
    static PREFIX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"127\.0\.0\.1:[0-9]+/t/").expect("the bridge address pattern"));
    let is_id_char = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    let is_word = |c: Option<u8>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_');
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(prefix) = PREFIX.find_at(text, from) {
        let start = prefix.end();
        let run = bytes[start..].iter().take_while(|&&c| is_id_char(c)).count();
        // The longest id of 16 to 128 characters followed by "/" or a word boundary (`(?=\/|\b)`).
        let fits = (16..=run.min(128)).rev().find(|&len| {
            let last = Some(bytes[start + len - 1]);
            let next = bytes.get(start + len).copied();
            next == Some(b'/') || is_word(last) != is_word(next)
        });
        match fits {
            Some(len) => {
                out.push_str(&text[copied..start]);
                out.push('…');
                copied = start + len;
                from = copied;
            }
            None => from = prefix.start() + 1,
        }
    }
    out.push_str(&text[copied..]);
    out
}

// --- The server's insides ----------------------------------------------------------------------------------------

/// The listener: each connection it accepts can be cut from the server's side (`res.destroy()`, and every
/// connection at `close()`).
struct BridgeListener {
    listener: TcpListener,
    stop: CancellationToken,
}

impl Listener for BridgeListener {
    type Io = CuttableStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.listener.accept().await {
                Ok((stream, addr)) => return (CuttableStream::new(stream, self.stop.child_token()), addr),
                Err(err) => {
                    let passing = matches!(
                        err.kind(),
                        io::ErrorKind::ConnectionRefused
                            | io::ErrorKind::ConnectionAborted
                            | io::ErrorKind::ConnectionReset
                    );
                    if !passing {
                        // Out of file handles and the like: wait a moment rather than spin.
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

/// A connection the server can cut: once its token is cancelled every read and write fails, and the connection is
/// closed without another byte.
struct CuttableStream {
    inner: TcpStream,
    cut: CancellationToken,
    cut_wait: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl CuttableStream {
    fn new(inner: TcpStream, cut: CancellationToken) -> Self {
        let cut_wait = Box::pin(cut.clone().cancelled_owned());
        CuttableStream { inner, cut, cut_wait }
    }

    fn check(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.cut.is_cancelled() || self.cut_wait.as_mut().poll(cx).is_ready() {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "the bridge closed the connection",
            ));
        }
        Ok(())
    }
}

impl AsyncRead for CuttableStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if let Err(err) = self.check(cx) {
            return Poll::Ready(Err(err));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for CuttableStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        if let Err(err) = self.check(cx) {
            return Poll::Ready(Err(err));
        }
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Err(err) = self.check(cx) {
            return Poll::Ready(Err(err));
        }
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// A request's connection, so the handler can cut it (`res.destroy()`).
#[derive(Clone)]
struct Conn {
    cut: CancellationToken,
}

impl Conn {
    fn destroy(&self) {
        self.cut.cancel();
    }
}

impl Connected<IncomingStream<'_, BridgeListener>> for Conn {
    fn connect_info(stream: IncomingStream<'_, BridgeListener>) -> Self {
        Conn {
            cut: stream.io().cut.clone(),
        }
    }
}

/// The connection is cut and nothing is answered (`res.destroy()`).
fn destroyed(conn: &Conn) -> Response {
    conn.destroy();
    Response::new(Body::empty())
}

static TURN_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^/t/([A-Za-z0-9_-]{{16,128}})(/{JS_DOT_CLASS}*)?$")).expect("the turn path pattern")
});
static BEARER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^(?i-u:Bearer)[{JS_SPACE_CLASS}]+([^{JS_SPACE_CLASS}]+)$")).expect("the bearer pattern")
});
static EVENT_STREAM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i-u:event-stream)").expect("a fixed pattern"));

/// The rest of the request after `/t/<id>`, without its leading `/v1` (`/v1/responses` is `/responses`).
fn rest_of(path: Option<&str>) -> String {
    let path = path.filter(|p| !p.is_empty()).unwrap_or("/");
    let rest = match path.strip_prefix("/v1") {
        Some(after) if after.is_empty() || after.starts_with('/') => after,
        _ => path,
    };
    if rest.is_empty() {
        "/".to_string()
    } else {
        rest.to_string()
    }
}

/// Reads and discards a request's body, so the connection can take the next request (`req.resume()`).
fn drain(body: Body) {
    tokio::spawn(async move {
        let mut body = body.into_data_stream();
        while let Some(Ok(_)) = body.next().await {}
    });
}

/// Why a body could not be taken.
enum BodyError {
    TooBig,
    Unreadable,
}

/// The request's body, at most MAX_BODY_BYTES (a bigger one is read to its end and refused).
async fn read_body(body: Body) -> Result<Bytes, BodyError> {
    let mut stream = body.into_data_stream();
    let mut chunks: Vec<u8> = Vec::new();
    let mut size: usize = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BodyError::Unreadable)?;
        size = size.saturating_add(chunk.len());
        if size > MAX_BODY_BYTES {
            chunks = Vec::new();
            continue;
        }
        chunks.extend_from_slice(&chunk);
    }
    if size > MAX_BODY_BYTES {
        return Err(BodyError::TooBig);
    }
    Ok(Bytes::from(chunks))
}

async fn handle(State(shared): State<Arc<Shared>>, ConnectInfo(conn): ConnectInfo<Conn>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let raw_target = parts.uri.to_string();
    let base = url::Url::parse("http://bridge/").ok();
    let Some(url) = base.and_then(|base| base.join(if raw_target.is_empty() { "/" } else { &raw_target }).ok()) else {
        drain(body);
        return refuse();
    };
    let search = url
        .query()
        .filter(|q| !q.is_empty())
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let found = TURN_PATH_RE.captures(url.path());
    let authorization = parts
        .headers
        .get("authorization")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .unwrap_or_default();
    let bearer = BEARER_RE
        .captures(&authorization)
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    let (Some(found), false) = (found, bearer.is_empty()) else {
        drain(body);
        return refuse();
    };
    // The turn named in the path, and its token in the header: compared as fixed-length digests, in constant time.
    let turn = match shared.lookup(&found[1]) {
        Some(turn) if same_digest(&turn.digest, &sha(&bearer)) => turn,
        _ => {
            drain(body);
            return refuse();
        }
    };

    let rest = rest_of(found.get(2).map(|m| m.as_str()));
    let target = format!(
        "{}{}{search}",
        turn.upstream,
        if rest == "/" { "" } else { rest.as_str() }
    );
    let mut body = match read_body(body).await {
        Ok(body) => body,
        Err(BodyError::TooBig) => {
            return json_response(
                413,
                &json!({"error": {"message": "The request is too big for the Local AI bridge."}}),
            );
        }
        Err(BodyError::Unreadable) => {
            return json_response(400, &json!({"error": {"message": "The request couldn't be read."}}));
        }
    };

    let mut names = ToolNames::default();
    let encoded = node_header(&parts.headers, "content-encoding").is_some_and(|e| !e.is_empty() && e != "identity");
    if parts.method == Method::POST && rest.ends_with("/responses") && !body.is_empty() && !encoded {
        // Not JSON: the server says what is wrong with it.
        if let Ok(original) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&body)) {
            let rewritten = rewrite_request(&original);
            names = rewritten.names;
            body = Bytes::from(js_stringify(&rewritten.body));
        }
    }

    let mut request = FetchRequest::new(parts.method.as_str(), target).no_redirects();
    for (name, value) in upstream_headers(&parts.headers, turn.key.as_deref()) {
        request = request.header(name, value);
    }
    if !body.is_empty() {
        request = request.header("content-length", body.len().to_string());
        if parts.method != Method::GET && parts.method != Method::HEAD {
            request = request.body(body);
        }
    }
    // The request joins the turn's live ones only now, after its body: one whose turn closed while its body was
    // still coming in goes on to the owner's server all the same, as the Node bridge's did (it added its abort to the
    // turn's set after closeTurn had emptied it).
    let live = if turn.live.is_cancelled() {
        CancellationToken::new()
    } else {
        turn.live.child_token()
    };
    // Codex hanging up drops this future, and with it the request to the owner's server.
    let fetched = tokio::select! {
        fetched = shared.fetch.fetch(request) => fetched,
        _ = live.cancelled() => return destroyed(&conn),
    };
    let up = match fetched {
        Ok(up) => up,
        Err(_) if live.is_cancelled() => return destroyed(&conn),
        Err(err) => {
            let message = format!("Can't reach your Local AI at {} ({}).", turn.upstream, reach_why(&err));
            return json_response(
                502,
                &json!({"error": {"message": message, "type": "server_error", "code": "local_ai_unreachable"}}),
            );
        }
    };
    reply(up, names, live, conn).await
}

/// The owner's server's answer, passed on to Codex: as it came (an HTTP error, or nothing to map back), rewritten
/// frame by frame (a stream), or rewritten whole (a reply that isn't streamed).
async fn reply(up: FetchResponse, names: ToolNames, live: CancellationToken, conn: Conn) -> Response {
    let status = if up.status == 0 { 502 } else { up.status };
    let content_type = up.header("content-type").unwrap_or("").to_string();
    let retry_after = up.header("retry-after").filter(|v| !v.is_empty()).map(str::to_string);
    let event_stream = EVENT_STREAM_RE.is_match(&content_type);
    let respond = |body: Body| -> Response {
        let mut builder = Response::builder()
            .status(status)
            .header(
                "content-type",
                if content_type.is_empty() {
                    "application/octet-stream"
                } else {
                    content_type.as_str()
                },
            )
            .header("cache-control", "no-cache");
        if let Some(retry_after) = &retry_after {
            builder = builder.header("retry-after", retry_after.as_str());
        }
        // A header the response can't carry (the JS writeHead threw, and the connection was cut).
        builder.body(body).unwrap_or_else(|_| destroyed(&conn))
    };
    if !(200..300).contains(&status) || (names.by_flat.is_empty() && !event_stream) {
        // An HTTP error, or nothing to map back: as it came.
        return respond(Body::from_stream(pass_through(up.into_stream(), live, conn.clone())));
    }
    if event_stream {
        return respond(Body::from_stream(rewrite_stream(
            up.into_stream(),
            names,
            live,
            conn.clone(),
        )));
    }
    let whole = tokio::select! {
        whole = up.bytes() => whole,
        _ = live.cancelled() => return destroyed(&conn),
    };
    let Ok(whole) = whole else {
        // The server's answer broke off: Codex sees the connection end, as it would without the bridge.
        return destroyed(&conn);
    };
    let text = String::from_utf8_lossy(&whole).into_owned();
    let out = match serde_json::from_str::<Value>(&text) {
        Ok(parsed) => js_stringify(&restore_event(&parsed, &names).unwrap_or(parsed)),
        Err(_) => text,
    };
    respond(Body::from(out))
}

/// Why a reply stopped before its end.
fn broke_off() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "the Local AI's answer broke off")
}

/// The owner's server's body as it comes. A stop (the turn closed) or a break cuts Codex's connection.
fn pass_through(up: ByteStream, live: CancellationToken, conn: Conn) -> BoxStream<'static, io::Result<Bytes>> {
    stream::unfold(Some((up, live, conn)), |state| async move {
        let (mut up, live, conn) = state?;
        let next = tokio::select! {
            next = up.next() => next,
            _ = live.cancelled() => Some(Err(FetchError::Other("stopped".into()))),
        };
        match next {
            Some(Ok(chunk)) => Some((Ok(chunk), Some((up, live, conn)))),
            Some(Err(_)) => {
                conn.destroy();
                Some((Err(broke_off()), None))
            }
            None => None,
        }
    })
    .boxed()
}

/// The owner's server's event stream, rewritten frame by frame as it comes.
fn rewrite_stream(
    up: ByteStream,
    names: ToolNames,
    live: CancellationToken,
    conn: Conn,
) -> BoxStream<'static, io::Result<Bytes>> {
    struct Rewriting {
        up: ByteStream,
        decoder: Utf8Decoder,
        sse: SseRewriter,
        live: CancellationToken,
        conn: Conn,
    }
    let state = Rewriting {
        up,
        decoder: Utf8Decoder::default(),
        sse: create_sse_rewriter(names),
        live,
        conn,
    };
    stream::unfold(Some(state), |state| async move {
        let mut st = state?;
        loop {
            let next = tokio::select! {
                next = st.up.next() => next,
                _ = st.live.cancelled() => Some(Err(FetchError::Other("stopped".into()))),
            };
            match next {
                Some(Ok(chunk)) => {
                    let text = st.decoder.decode(&chunk, true);
                    let out = st.sse.push(&text);
                    if !out.is_empty() {
                        return Some((Ok(Bytes::from(out)), Some(st)));
                    }
                }
                Some(Err(_)) => {
                    st.conn.destroy();
                    return Some((Err(broke_off()), None));
                }
                None => {
                    let rest = st.decoder.decode(&[], false);
                    let last = st.sse.push(&rest) + &st.sse.end();
                    return (!last.is_empty()).then(|| (Ok(Bytes::from(last)), None));
                }
            }
        }
    })
    .boxed()
}

#[cfg(test)]
mod tests;
