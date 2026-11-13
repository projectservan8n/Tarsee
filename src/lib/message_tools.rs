//! Port of `src/lib/message-tools.js`: the tools a saved reply used, with what went in and what came out, for the
//! chat's "Used 12 tools" line when a step is opened (GET /api/chat/conversations/:id/messages/:messageId/tools).
//!
//! Two shapes are on disk:
//!   - the dashboard's replies: timeline JSON,
//!     `{"__timeline":true,"items":[{type:"tool",name,detail,input,output}...],"text":...}`
//!   - the channels' replies (Telegram, Discord, WhatsApp...): the words with each call inline as
//!     `<tool_call>{"name","arguments"}</tool_call>`, sometimes followed by its `<tool_response>...</tool_response>`.
//!
//! The chat's history comes slim (routes/chat.rs `slim_message`: names only), so this is asked for only when
//! someone opens the steps, one reply at a time.
//!
//! Everything goes through `redact_secrets`: a command line or an output can carry a key, and this is shown on a
//! screen.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::lib::redact::redact_secrets;
use crate::lib::tool_steps::{
    collapse_whitespace, display_tool_name, fold_blank_lines, js_json, js_string, parse_json_lossy,
    summarize_tool_input, whole_numbers,
};
use crate::util::js::{trim, trim_start, truthy, utf16_len, utf16_truncate};

pub const IO_CAP: usize = 4000;
pub const MAX_TOOLS: usize = 300;

/// A stored reply that is the dashboard's timeline JSON starts with this.
pub(crate) const TIMELINE_PREFIX: &str = r#"{"__timeline":true"#;

static TOOL_CALL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<tool_call>(.*?)</tool_call>").expect("the tool call pattern"));
static TOOL_RESPONSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<tool_response>.*?</tool_response>").expect("the tool response pattern"));
/// A call and, if one follows before the next call, its response.
static CALL_OR_RESPONSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<tool_call>(.*?)</tool_call>|<tool_response>(.*?)</tool_response>")
        .expect("the tool call or response pattern")
});

/// One tool as the chat shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MessageTool {
    pub name: String,
    pub summary: String,
    pub input: String,
    pub output: String,
    pub ok: bool,
}

fn cap(text: &str, max: usize) -> String {
    if utf16_len(text) > max {
        format!("{}\n…", utf16_truncate(text, max))
    } else {
        text.to_string()
    }
}

fn pretty(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => js_json(other, true),
    }
}

/// `value || fallback` then `String(...)`: the value's text when it is truthy.
fn text_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(v) if truthy(v) => js_string(v),
        _ => fallback.to_string(),
    }
}

/// The message's stored text without its inline tool markup: calls and responses taken out, runs of blank lines
/// folded. The ends are not trimmed.
pub(crate) fn strip_tool_markup(text: &str) -> String {
    let without_calls = TOOL_CALL.replace_all(text, "");
    let without_responses = TOOL_RESPONSE.replace_all(&without_calls, "");
    fold_blank_lines(&without_responses)
}

/// One tool as the chat shows it: { name, summary, input, output, ok }. `input_text` is what was typed in when
/// that is known; else the input is shown as JSON.
fn tool(name: &str, input: &Value, input_text: Option<&str>, output: &str, ok: bool, summary: &str) -> MessageTool {
    let sum = if summary.is_empty() {
        let arguments = if input.is_object() || input.is_array() {
            input
        } else {
            &Value::Null
        };
        summarize_tool_input(name, arguments)
    } else {
        summary.to_string()
    };
    let shown = match input_text {
        Some(text) => cap(text, IO_CAP),
        None => cap(&pretty(input), IO_CAP),
    };
    MessageTool {
        name: display_tool_name(name),
        summary: redact_secrets(&sum),
        input: redact_secrets(&shown),
        output: redact_secrets(&cap(output, IO_CAP)),
        ok,
    }
}

/// `/^(error|failed)$/i`.
fn is_failed_status(status: &str) -> bool {
    status.eq_ignore_ascii_case("error") || status.eq_ignore_ascii_case("failed")
}

/// `/^\s*(error|failed)\b/i`: the response starts with the word.
fn starts_with_failure(text: &str) -> bool {
    let text = trim_start(text);
    ["error", "failed"].iter().any(|word| {
        text.get(..word.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(word))
            && !text[word.len()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// The tools in a stored message's content (either shape), oldest first.
pub fn message_tools(content: &str) -> Vec<MessageTool> {
    if content.starts_with(TIMELINE_PREFIX) {
        let Some(data) = parse_json_lossy(content) else {
            return Vec::new();
        };
        let items = data
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        return items
            .iter()
            .filter(|it| it.get("type").and_then(Value::as_str) == Some("tool"))
            .take(MAX_TOOLS)
            .map(|it| {
                let mut input = match it.get("input") {
                    Some(Value::String(text)) if trim_start(text).starts_with(['{', '[']) => {
                        parse_json_lossy(text).unwrap_or(Value::Null)
                    }
                    _ => Value::Null,
                };
                if let Some(todos) = it.get("todos").filter(|t| t.is_array()) {
                    input = json!({ "todos": todos });
                }
                let typed = [it.get("input"), it.get("detail")]
                    .into_iter()
                    .flatten()
                    .find(|v| truthy(v))
                    .map(js_string)
                    .unwrap_or_default();
                tool(
                    &text_or(it.get("name"), ""),
                    &input,
                    Some(&typed),
                    &text_or(it.get("output"), ""),
                    !is_failed_status(&text_or(it.get("status"), "")),
                    &text_or(it.get("summary"), ""),
                )
            })
            .collect();
    }
    let mut out: Vec<MessageTool> = Vec::new();
    let mut answered = false;
    for found in CALL_OR_RESPONSE.captures_iter(content) {
        if out.len() > MAX_TOOLS {
            break;
        }
        if let Some(call) = found.get(1) {
            let j = parse_json_lossy(call.as_str()).filter(truthy);
            let name = text_or(j.as_ref().and_then(|j| j.get("name")), "tool");
            let input = j
                .as_ref()
                .and_then(|j| {
                    [j.get("arguments"), j.get("input")]
                        .into_iter()
                        .flatten()
                        .find(|v| !v.is_null())
                })
                .cloned()
                .unwrap_or(Value::Null);
            let typed = if j.is_some() { None } else { Some(call.as_str()) };
            out.push(tool(&name, &input, typed, "", true, ""));
            answered = false;
        } else if let (Some(response), Some(last)) = (found.get(2), out.last_mut())
            && !answered
        {
            last.output = redact_secrets(&cap(trim(response.as_str()), IO_CAP));
            last.ok = !starts_with_failure(response.as_str());
            answered = true;
        }
    }
    out.truncate(MAX_TOOLS);
    out
}

/// A stored message as the chat's history sends it: the words, and for each tool its name and one line, without
/// inputs or outputs.
///
/// Two shapes are stored. The dashboard's own replies are timeline JSON
/// (`{"__timeline":true,"items":[...],"text":...}`); it stays timeline JSON, its notes kept and each tool cut to
/// name, one line, status and todo list. The channels' replies carry each call inline as
/// `<tool_call>{...}</tool_call>` (and sometimes its `<tool_response>`); those are taken out and listed in `tools`.
///
/// `m` is the message as a JSON object (a row of the store, or just `{ "content": ... }`). A message with no tools
/// comes back as it was.
pub fn slim_message(m: &Value) -> Value {
    // (Whatever writes the answer out, the message's numbers are JavaScript's: a count of 12.0 is 12.)
    let mut slim = slim_message_as_is(m);
    whole_numbers(&mut slim);
    slim
}

fn slim_message_as_is(m: &Value) -> Value {
    let content = text_or(m.get("content"), "");
    let Some(message) = m.as_object() else {
        return m.clone();
    };
    if content.starts_with(TIMELINE_PREFIX) {
        let Some(data) = parse_json_lossy(&content) else {
            return m.clone();
        };
        let Some(items) = data.get("items").and_then(Value::as_array) else {
            return m.clone();
        };
        let items: Vec<Value> = items
            .iter()
            .take(300)
            .map(|it| {
                if it.get("type").and_then(Value::as_str) != Some("tool") {
                    return it.clone();
                }
                let line = [it.get("summary"), it.get("detail")]
                    .into_iter()
                    .flatten()
                    .find(|v| truthy(v))
                    .map(js_string)
                    .unwrap_or_default();
                let mut slim = Map::new();
                slim.insert("type".into(), json!("tool"));
                slim.insert(
                    "name".into(),
                    json!(display_tool_name(&text_or(it.get("name"), "tool"))),
                );
                slim.insert("summary".into(), json!(one_line(&line)));
                slim.insert(
                    "status".into(),
                    it.get("status").filter(|s| truthy(s)).cloned().unwrap_or(json!("done")),
                );
                if let Some(todos) = it.get("todos").filter(|t| t.is_array()) {
                    slim.insert("todos".into(), todos.clone());
                }
                Value::Object(slim)
            })
            .collect();
        let text = data.get("text").filter(|t| truthy(t)).cloned().unwrap_or(json!(""));
        let slimmed = json!({ "__timeline": true, "items": items, "text": text });
        let mut out = message.clone();
        out.insert("content".into(), json!(js_json(&slimmed, false)));
        return Value::Object(out);
    }
    if !content.contains("<tool_call>") && !content.contains("<tool_response>") {
        return m.clone();
    }
    let mut tools: Vec<Value> = Vec::new();
    for found in TOOL_CALL.captures_iter(&content) {
        // JSON that is not an object with a name and arguments names a plain "tool" (`null` has neither).
        let slim = match parse_json_lossy(&found[1]) {
            Some(j) if !j.is_null() => {
                let name = text_or(j.get("name"), "");
                let args = j.get("arguments").filter(|a| truthy(a)).cloned().unwrap_or(json!({}));
                let mut hint = summarize_tool_input(&name, &args);
                if hint.is_empty() {
                    hint = ["description", "file_path", "command", "pattern", "url", "query"]
                        .iter()
                        .filter_map(|key| args.get(key))
                        .find(|v| truthy(v))
                        .map(js_string)
                        .unwrap_or_default();
                }
                let shown = if name.is_empty() { "tool" } else { &name };
                json!({ "name": display_tool_name(shown), "summary": one_line(&hint) })
            }
            _ => json!({ "name": "tool", "summary": "" }),
        };
        tools.push(slim);
        if tools.len() >= 200 {
            break;
        }
    }
    let clean = strip_tool_markup(&content);
    let mut out = message.clone();
    out.insert("content".into(), json!(trim(&clean)));
    out.insert("tools".into(), Value::Array(tools));
    Value::Object(out)
}

/// A tool's one line in the slim history: whitespace folded, cut to 140, redacted.
fn one_line(text: &str) -> String {
    redact_secrets(&utf16_truncate(&collapse_whitespace(text), 140))
}

/// The words of a stored reply, whichever shape it has: the `text` of timeline JSON, else the content itself.
/// (What the Node code spelled out wherever it read history: `c.startsWith('{"__timeline":true') ? JSON.parse(c).text`.)
/// Content that only looks like timeline JSON stays as it is.
pub(crate) fn timeline_text(content: &str) -> Option<String> {
    if !content.starts_with(TIMELINE_PREFIX) {
        return None;
    }
    let data = parse_json_lossy(content)?;
    Some(match data.get("text") {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    })
}

#[cfg(test)]
mod tests {
    //! Port of the "message tools" cases of `test/live-bus.test.js`.
    use super::*;

    fn timeline() -> String {
        json!({
            "__timeline": true,
            "items": [
                { "type": "text", "text": "Checking." },
                { "type": "tool", "name": "Bash", "summary": "List files", "detail": "ls -la", "input": "ls -la", "output": "x".repeat(5000), "status": "done" },
                { "type": "tool", "name": "Update Todos", "detail": "", "input": "", "output": "", "status": "done", "todos": [{ "content": "a", "status": "completed" }] },
            ],
            "text": "All done.",
        })
        .to_string()
    }

    fn fake_key() -> String {
        format!("sk-ant-{}", "api03-abcdefghijklmnopqrstuvwxyz0123456789")
    }

    #[test]
    fn a_dashboard_reply_stays_timeline_json_without_the_tools_inputs_and_outputs() {
        let slim = slim_message(&json!({ "id": "m1", "role": "assistant", "content": timeline() }));
        let content = slim["content"].as_str().unwrap();
        let data: Value = serde_json::from_str(content).unwrap();
        assert_eq!(data["__timeline"], true);
        assert_eq!(data["text"], "All done.");
        assert_eq!(data["items"][0]["text"], "Checking.");
        assert_eq!(
            data["items"][1],
            json!({ "type": "tool", "name": "Bash", "summary": "List files", "status": "done" })
        );
        assert_eq!(
            data["items"][2]["todos"],
            json!([{ "content": "a", "status": "completed" }])
        );
        assert!(content.len() < 400);
        // Byte for byte what the Node version sends.
        assert_eq!(
            content,
            r#"{"__timeline":true,"items":[{"type":"text","text":"Checking."},{"type":"tool","name":"Bash","summary":"List files","status":"done"},{"type":"tool","name":"Update Todos","summary":"","status":"done","todos":[{"content":"a","status":"completed"}]}],"text":"All done."}"#
        );
        assert_eq!(slim["id"], "m1");
        assert_eq!(
            slim.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "role", "content"]
        );
    }

    #[test]
    fn a_channel_reply_has_its_inline_tool_calls_taken_out_and_listed() {
        let content = "Looking.\n<tool_call>{\"name\":\"mcp__tarsee__tarsee_web_search\",\"arguments\":{\"query\":\"weather\"}}</tool_call>\n<tool_response>sunny</tool_response>\n\n\n\nSunny today.";
        let slim = slim_message(&json!({ "id": "m2", "role": "assistant", "content": content }));
        assert_eq!(slim["content"], "Looking.\n\nSunny today.");
        assert_eq!(
            slim["tools"],
            json!([{ "name": "tarsee_web_search", "summary": "weather" }])
        );
        assert_eq!(
            slim.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "role", "content", "tools"]
        );
        // a message with no tools is left alone
        let plain = json!({ "id": "m3", "role": "user", "content": "hi" });
        assert_eq!(slim_message(&plain), plain);
    }

    #[test]
    fn a_replys_tools_opened_input_and_output_capped_and_redacted_from_either_shape() {
        let from_timeline = message_tools(&timeline());
        assert_eq!(from_timeline.len(), 2);
        assert_eq!(from_timeline[0].name, "Bash");
        assert!(utf16_len(&from_timeline[0].output) <= 4002);
        assert!(from_timeline[0].output.ends_with("\n…"));
        let from_channel = message_tools(&format!(
            "<tool_call>{{\"name\":\"Bash\",\"arguments\":{{\"command\":\"echo {}\"}}}}</tool_call><tool_response>ok</tool_response>",
            fake_key()
        ));
        assert_eq!(from_channel.len(), 1);
        assert_eq!(from_channel[0].output, "ok");
        assert!(!from_channel[0].input.contains("abcdefghijklmnopqrstuvwxyz0123456789"));
    }

    #[test]
    fn the_tools_of_a_timeline_reply_are_written_as_the_node_version_wrote_them() {
        let tools = message_tools(&timeline());
        assert_eq!(
            serde_json::to_value(&tools[1]).unwrap(),
            json!({ "name": "Update Todos", "summary": "", "input": "", "output": "", "ok": true })
        );
        assert_eq!(tools[0].summary, "List files");
        assert_eq!(tools[0].input, "ls -la");
        // A failed step, a step with JSON input, and one with only a detail.
        let content = json!({
            "__timeline": true,
            "items": [
                { "type": "tool", "name": "mcp__tarsee__tarsee_send_file", "input": "{\"file_path\":\"/w/a.pdf\"}", "output": "no", "status": "Error" },
                { "type": "tool", "detail": "the detail" },
                { "type": "note" },
            ],
        })
        .to_string();
        assert_eq!(
            serde_json::to_value(message_tools(&content)).unwrap(),
            json!([
                { "name": "tarsee_send_file", "summary": "/w/a.pdf", "input": "{\"file_path\":\"/w/a.pdf\"}", "output": "no", "ok": false },
                { "name": "tool", "summary": "", "input": "the detail", "output": "", "ok": true },
            ])
        );
        assert!(message_tools("{\"__timeline\":true, broken").is_empty());
        assert!(message_tools("").is_empty());
    }

    #[test]
    fn the_tools_of_a_channel_reply_calls_responses_and_what_is_not_json() {
        let content = "a<tool_call>{\"name\":\"Read\",\"arguments\":{\"file_path\":\"/w/notes.md\"}}</tool_call>\
            <tool_response> Error: no such file </tool_response><tool_response>ignored: already answered</tool_response>\
            <tool_call>not json</tool_call><tool_call>{\"name\":\"Glob\",\"input\":{\"pattern\":\"*.rs\"}}</tool_call>\
            <tool_response>errors: none</tool_response>";
        assert_eq!(
            serde_json::to_value(message_tools(content)).unwrap(),
            json!([
                { "name": "Read", "summary": "/w/notes.md", "input": "{\n  \"file_path\": \"/w/notes.md\"\n}", "output": "Error: no such file", "ok": false },
                { "name": "tool", "summary": "", "input": "not json", "output": "", "ok": true },
                { "name": "Glob", "summary": "*.rs", "input": "{\n  \"pattern\": \"*.rs\"\n}", "output": "errors: none", "ok": true },
            ])
        );
        // A response with no call before it belongs to nothing.
        assert!(message_tools("<tool_response>orphan</tool_response>").is_empty());
    }

    #[test]
    fn a_channel_replys_slim_tools_fall_back_to_a_plain_name() {
        let content = "x<tool_call>nope</tool_call><tool_call>null</tool_call>\
            <tool_call>{\"arguments\":{\"n\":1,\"url\":\"https://example.com/a  b\"}}</tool_call>y";
        let slim = slim_message(&json!({ "content": content }));
        assert_eq!(
            slim["tools"],
            json!([
                { "name": "tool", "summary": "" },
                { "name": "tool", "summary": "" },
                { "name": "tool", "summary": "https://example.com/a b" },
            ])
        );
        assert_eq!(slim["content"], "xy");
        // Timeline JSON that does not parse, or has no items, is left as it is.
        let broken = json!({ "content": "{\"__timeline\":true, broken" });
        assert_eq!(slim_message(&broken), broken);
        let no_items = json!({ "content": "{\"__timeline\":true}" });
        assert_eq!(slim_message(&no_items), no_items);
        assert_eq!(slim_message(&Value::Null), Value::Null);
    }

    /// Review finding M4: the fields a message is handed on with, and the timeline it is rewritten into, have
    /// their numbers as JavaScript writes them.
    #[test]
    fn a_slim_message_has_its_numbers_as_javascript_writes_them() {
        let channel = json!({ "id": "m1", "tokens_in": 12.0, "score": 0.5, "content": "a<tool_call>{\"name\":\"Read\"}</tool_call>b" });
        assert_eq!(
            serde_json::to_string(&slim_message(&channel)).unwrap(),
            r#"{"id":"m1","tokens_in":12,"score":0.5,"content":"ab","tools":[{"name":"Read","summary":""}]}"#
        );
        let timeline =
            json!({ "__timeline": true, "items": [{ "type": "text", "text": "x", "at": 3.0 }], "text": "t" })
                .to_string();
        let slim = slim_message(&json!({ "tokens_out": 7.0, "content": timeline }));
        assert_eq!(
            serde_json::to_string(&slim).unwrap(),
            r#"{"tokens_out":7,"content":"{\"__timeline\":true,\"items\":[{\"type\":\"text\",\"text\":\"x\",\"at\":3}],\"text\":\"t\"}"}"#
        );
        // A message with nothing to slim is handed on with the same numbers.
        let plain = json!({ "id": "m3", "tokens_in": 4.0, "content": "hi" });
        assert_eq!(
            serde_json::to_string(&slim_message(&plain)).unwrap(),
            r#"{"id":"m3","tokens_in":4,"content":"hi"}"#
        );
    }

    #[test]
    fn the_words_of_a_stored_reply() {
        assert_eq!(timeline_text(&timeline()).as_deref(), Some("All done."));
        assert_eq!(timeline_text("plain words"), None);
        assert_eq!(timeline_text("{\"__timeline\":true, broken"), None);
        assert_eq!(timeline_text("{\"__timeline\":true,\"items\":[]}").as_deref(), Some(""));
        assert_eq!(strip_tool_markup("a\n\n\n<tool_call>x</tool_call>\n\nb "), "a\n\nb ");
    }
}
