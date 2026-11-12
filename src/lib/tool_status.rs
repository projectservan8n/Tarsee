//! Port of `src/lib/tool-status.js`.
//!
//! Human-readable, leak-safe status labels for tool_use events. The Telegram, Discord and Slack channels show them
//! while a tool runs ("Running command…", "Sending report.pdf…") and when it ends ("Command done", "Sent report.pdf").
//!
//! Never returns command bodies, env values, key names or values, full URLs, or query strings: the bot UX stays safe
//! by construction even if the user disabled the webapp's secret-redaction toggle.
//!
//! Claude Code names a tool from an MCP server mcp__<server>__<tool>, so Tarsee's own tools arrive as
//! mcp__tarsee__tarsee_send_file and so on: they get words of their own, and any other server's tool shows by its own
//! name without the prefix.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::util::js::{number_to_string, truthy};

/// `String(value || "")` for a field of the tool's input: a missing or falsy value is "", anything else is what
/// JavaScript's `String()` makes of it.
fn field_text(value: Option<&Value>) -> String {
    match value {
        Some(v) if truthy(v) => js_string(v),
        _ => String::new(),
    }
}

/// JavaScript's `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(number_to_string).unwrap_or_else(|| n.to_string()),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// The file name at the end of a path, either slash.
fn file_base(path: &str) -> String {
    match path.rsplit(['\\', '/']).next() {
        Some(last) if !last.is_empty() => last.to_string(),
        _ => "file".into(),
    }
}

/// A PDF's file name, from a path or a web address (never its query string or fragment, which can hold a token).
fn pdf_base(input: &Value) -> String {
    let path = input.get("path").filter(|v| truthy(v));
    let source = input.get("source");
    let text = field_text(path.or(source));
    file_base(text.split(['?', '#']).next().unwrap_or(""))
}

static MCP_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^mcp__[^_]+(?:_[^_]+)*?__").expect("the MCP prefix pattern"));

/// mcp__tarsee__tarsee_send_file → tarsee_send_file; a built-in tool's name stays as it is.
fn bare_name(name: &str) -> String {
    let name = if name.is_empty() { "tool" } else { name };
    MCP_PREFIX.replace(name, "").into_owned()
}

/// What a label is made of: fixed words, or words built from the tool's input.
enum Label {
    Fixed(&'static str),
    Input(fn(&Value) -> String),
}

/// Tarsee's own tools: [while it runs, when it is done, when it failed].
fn tarsee_entry(bare: &str) -> Option<[Label; 3]> {
    use Label::{Fixed, Input};
    Some(match bare {
        "tarsee_send_file" => [
            Input(|i| format!("Sending {}…", file_base(&field_text(i.get("file_path"))))),
            Input(|i| format!("Sent {}", file_base(&field_text(i.get("file_path"))))),
            Input(|i| format!("Sending {} failed", file_base(&field_text(i.get("file_path"))))),
        ],
        "tarsee_send_message" => [
            Fixed("Sending a message…"),
            Fixed("Message sent"),
            Fixed("Sending the message failed"),
        ],
        "tarsee_send_email_thread" => [
            Fixed("Sending an email…"),
            Fixed("Email sent"),
            Fixed("Sending the email failed"),
        ],
        "tarsee_configure_email_channel" => [
            Fixed("Setting up email…"),
            Fixed("Email set up"),
            Fixed("Setting up email failed"),
        ],
        "tarsee_push_notification" => [
            Fixed("Sending a notification…"),
            Fixed("Notification sent"),
            Fixed("Sending the notification failed"),
        ],
        "tarsee_web_search" => [
            Fixed("Web searching…"),
            Fixed("Web search done"),
            Fixed("Web search failed"),
        ],
        "tarsee_web_fetch" => [Fixed("Fetching URL…"), Fixed("Fetch done"), Fixed("Fetch failed")],
        "tarsee_browser" => [
            Fixed("Using the browser…"),
            Fixed("Browser done"),
            Fixed("Browser failed"),
        ],
        "tarsee_remember" => [
            Fixed("Saving a memory…"),
            Fixed("Memory saved"),
            Fixed("Saving the memory failed"),
        ],
        "tarsee_search_memories" | "tarsee_search_memories_deep" => [
            Fixed("Searching memories…"),
            Fixed("Memory search done"),
            Fixed("Memory search failed"),
        ],
        "tarsee_daily_log" => [
            Fixed("Writing the daily log…"),
            Fixed("Daily log written"),
            Fixed("Writing the daily log failed"),
        ],
        "tarsee_read_file" => [
            Input(|i| format!("Reading {}…", file_base(&field_text(i.get("filename"))))),
            Input(|i| format!("Read {}", file_base(&field_text(i.get("filename"))))),
            Input(|i| format!("Reading {} failed", file_base(&field_text(i.get("filename"))))),
        ],
        "tarsee_pdf_read" => [
            Input(|i| format!("Reading {}…", pdf_base(i))),
            Input(|i| format!("Read {}", pdf_base(i))),
            Input(|i| format!("Reading {} failed", pdf_base(i))),
        ],
        "tarsee_write_file" => [
            Input(|i| format!("Writing {}…", file_base(&field_text(i.get("filename"))))),
            Input(|i| format!("Wrote {}", file_base(&field_text(i.get("filename"))))),
            Input(|i| format!("Writing {} failed", file_base(&field_text(i.get("filename"))))),
        ],
        "tarsee_list_files" => [
            Fixed("Listing files…"),
            Fixed("Files listed"),
            Fixed("Listing files failed"),
        ],
        // A task the AI schedules is saved paused, until the owner switches it on (lib/cron.rs). The saved words only
        // when the tool's result has no error mark: ai/tarsee_mcp.rs marks every answer where no task was saved (a
        // refusal, a bad schedule, the 15-minute rule), and those say so plainly.
        "tarsee_schedule_task" => [
            Fixed("Scheduling a task…"),
            Fixed("Task saved, waiting for your OK"),
            Fixed("Task not saved"),
        ],
        "tarsee_create_canvas" => [
            Fixed("Making a canvas…"),
            Fixed("Canvas made"),
            Fixed("Making the canvas failed"),
        ],
        "tarsee_create_diagram" => [
            Fixed("Drawing a diagram…"),
            Fixed("Diagram drawn"),
            Fixed("Drawing the diagram failed"),
        ],
        "tarsee_datetime" => [
            Fixed("Checking the time…"),
            Fixed("Time checked"),
            Fixed("Checking the time failed"),
        ],
        "tarsee_calculator" => [Fixed("Calculating…"), Fixed("Calculated"), Fixed("Calculation failed")],
        "tarsee_discord_admin" => [
            Fixed("Working on Discord…"),
            Fixed("Discord done"),
            Fixed("Discord failed"),
        ],
        "tarsee_railway" => [
            Fixed("Working on Railway…"),
            Fixed("Railway done"),
            Fixed("Railway failed"),
        ],
        // The vault: never a key's name, let alone its value.
        "tarsee_get_key" | "tarsee_list_keys" => [
            Fixed("Checking the vault…"),
            Fixed("Vault checked"),
            Fixed("Vault check failed"),
        ],
        "tarsee_set_key" => [
            Fixed("Saving a key…"),
            Fixed("Key saved"),
            Fixed("Saving the key failed"),
        ],
        "tarsee_delete_key" => [
            Fixed("Removing a key…"),
            Fixed("Key removed"),
            Fixed("Removing the key failed"),
        ],
        _ => return None,
    })
}

/// The words for one of Tarsee's own tools, or `None` for any other tool. A label made from the input reads a JSON
/// `null` input as `{}` (the JS `input || {}`).
fn tarsee_label(name: &str, input: &Value, which: usize) -> Option<String> {
    let entry = tarsee_entry(&bare_name(name))?;
    let label = match &entry[which] {
        Label::Fixed(text) => text.to_string(),
        Label::Input(make) => make(if truthy(input) { input } else { &Value::Null }),
    };
    if label.is_empty() { None } else { Some(label) }
}

/// A readable name for a tool nothing above knows: mcp__github__list_pull_requests → "list pull requests".
fn other_name(name: &str) -> String {
    if name.starts_with("mcp__") {
        bare_name(name).replace('_', " ")
    } else {
        name.to_string()
    }
}

/// The file name in a built-in tool's `file_path`. A `null` input reads as `{}`.
fn input_file(input: &Value) -> String {
    file_base(&field_text(input.get("file_path")))
}

/// The line a channel shows while a tool runs. Pass the tool's input (`{}` when there is none).
pub fn tool_status_label(name: &str, input: &Value) -> String {
    if let Some(own) = tarsee_label(name, input, 0) {
        return own;
    }
    match name {
        "Bash" => "Running command…".into(),
        "Read" => format!("Reading {}…", input_file(input)),
        "Write" => format!("Writing {}…", input_file(input)),
        "Edit" => format!("Editing {}…", input_file(input)),
        "Glob" => "Searching files…".into(),
        "Grep" => "Searching code…".into(),
        "WebFetch" => "Fetching URL…".into(),
        "WebSearch" => "Web searching…".into(),
        "TodoWrite" => "Updating todo list…".into(),
        _ => format!("Running {}…", other_name(name)),
    }
}

/// Variant for the post-completion "done" / "failed" line. Pass the original input so file-based tools
/// (Read/Write/Edit) keep their filename context.
pub fn tool_done_label(name: &str, input: &Value, is_error: bool) -> String {
    if let Some(own) = tarsee_label(name, input, if is_error { 2 } else { 1 }) {
        return own;
    }
    let verb = if is_error { "failed" } else { "done" };
    match name {
        "Bash" => format!("Command {verb}"),
        "Read" => format!("Read {}", input_file(input)),
        "Write" => format!("Wrote {}", input_file(input)),
        "Edit" => format!("Edited {}", input_file(input)),
        "Glob" => format!("File search {verb}"),
        "Grep" => format!("Code search {verb}"),
        "WebFetch" => format!("Fetch {verb}"),
        "WebSearch" => format!("Web search {verb}"),
        "TodoWrite" => "Todos updated".into(),
        _ => format!("{} {verb}", other_name(name)),
    }
}

#[cfg(test)]
mod tests {
    //! Port of `test/tool-status.test.js`, plus the label checks of `test/channel-tool-status.test.js`.
    use super::*;
    use serde_json::json;

    #[test]
    fn names_tarsees_own_tools_in_words_not_as_mcp_tarsee_tarsee() {
        assert_eq!(
            tool_status_label(
                "mcp__tarsee__tarsee_send_file",
                &json!({ "file_path": "/data/report.pdf" })
            ),
            "Sending report.pdf…"
        );
        assert_eq!(
            tool_done_label(
                "mcp__tarsee__tarsee_send_file",
                &json!({ "file_path": "/data/report.pdf" }),
                false
            ),
            "Sent report.pdf"
        );
        assert_eq!(
            tool_done_label(
                "mcp__tarsee__tarsee_send_file",
                &json!({ "file_path": "/data/report.pdf" }),
                true
            ),
            "Sending report.pdf failed"
        );
        assert_eq!(
            tool_status_label("mcp__tarsee__tarsee_send_message", &json!({})),
            "Sending a message…"
        );
        assert_eq!(
            tool_done_label("mcp__tarsee__tarsee_send_message", &json!({}), false),
            "Message sent"
        );
        assert_eq!(
            tool_status_label("mcp__tarsee__tarsee_web_search", &json!({ "query": "secret plans" })),
            "Web searching…"
        );
        assert_eq!(
            tool_status_label(
                "mcp__tarsee__tarsee_web_fetch",
                &json!({ "url": "https://x.test/?token=abc" })
            ),
            "Fetching URL…"
        );
        assert_eq!(
            tool_status_label("mcp__tarsee__tarsee_remember", &json!({ "content": "x" })),
            "Saving a memory…"
        );
        assert_eq!(
            tool_done_label("mcp__tarsee__tarsee_remember", &json!({}), false),
            "Memory saved"
        );
        assert_eq!(
            tool_status_label("mcp__tarsee__tarsee_search_memories_deep", &json!({})),
            "Searching memories…"
        );
        assert_eq!(
            tool_status_label(
                "mcp__tarsee__tarsee_read_file",
                &json!({ "filename": "memory/2026-04-05.md" })
            ),
            "Reading 2026-04-05.md…"
        );
        assert_eq!(
            tool_done_label(
                "mcp__tarsee__tarsee_write_file",
                &json!({ "filename": "MEMORY.md" }),
                false
            ),
            "Wrote MEMORY.md"
        );
        assert_eq!(
            tool_status_label("mcp__tarsee__tarsee_schedule_task", &json!({})),
            "Scheduling a task…"
        );
        assert_eq!(
            tool_status_label("mcp__tarsee__tarsee_browser", &json!({})),
            "Using the browser…"
        );
    }

    #[test]
    fn never_shows_a_keys_name_or_value() {
        let leak = Regex::new(r"STRIPE|sk_live|mcp__|tarsee_").unwrap();
        for name in [
            "tarsee_get_key",
            "tarsee_set_key",
            "tarsee_delete_key",
            "tarsee_list_keys",
        ] {
            let input = json!({ "key": "STRIPE_SECRET", "value": format!("sk_{}_123", "live") });
            let full = format!("mcp__tarsee__{name}");
            for label in [
                tool_status_label(&full, &input),
                tool_done_label(&full, &input, false),
                tool_done_label(&full, &input, true),
            ] {
                assert!(!leak.is_match(&label), "{name}: {label}");
            }
        }
    }

    #[test]
    fn shows_any_other_mcp_tool_by_its_own_name_without_the_mcp_server_prefix() {
        assert_eq!(
            tool_status_label("mcp__github__list_pull_requests", &json!({})),
            "Running list pull requests…"
        );
        assert_eq!(
            tool_done_label("mcp__github__list_pull_requests", &json!({}), false),
            "list pull requests done"
        );
        assert_eq!(
            tool_done_label("mcp__github__list_pull_requests", &json!({}), true),
            "list pull requests failed"
        );
    }

    #[test]
    fn shortens_a_windows_path_to_its_file_name_too() {
        assert_eq!(
            tool_status_label("Write", &json!({ "file_path": "C:\\Users\\me\\workspace\\notes.txt" })),
            "Writing notes.txt…"
        );
        assert_eq!(
            tool_done_label(
                "Read",
                &json!({ "file_path": "C:\\Users\\me\\workspace\\notes.txt" }),
                false
            ),
            "Read notes.txt"
        );
        assert_eq!(
            tool_status_label("Edit", &json!({ "file_path": "/data/tarsee/workspace/SOUL.md" })),
            "Editing SOUL.md…"
        );
    }

    #[test]
    fn reads_a_pdf_by_its_file_name_and_never_shows_a_web_addresss_query_or_the_rest_of_its_path() {
        assert_eq!(
            tool_status_label("mcp__tarsee__tarsee_pdf_read", &json!({ "path": "docs/q3 report.pdf" })),
            "Reading q3 report.pdf…"
        );
        assert_eq!(
            tool_done_label(
                "mcp__tarsee__tarsee_pdf_read",
                &json!({ "path": "C:\\work\\deck.pdf" }),
                false
            ),
            "Read deck.pdf"
        );
        assert_eq!(
            tool_done_label("mcp__tarsee__tarsee_pdf_read", &json!({ "path": "deck.pdf" }), true),
            "Reading deck.pdf failed"
        );
        let web = tool_status_label(
            "mcp__tarsee__tarsee_pdf_read",
            &json!({ "path": "https://files.example.com/private/a.pdf?token=sk-test-canary-123#p2" }),
        );
        assert_eq!(web, "Reading a.pdf…");
        assert_eq!(
            tool_status_label("mcp__tarsee__tarsee_pdf_read", &json!({ "source": "old/arg.pdf" })),
            "Reading arg.pdf…",
            "the old source argument too"
        );
    }

    #[test]
    fn keeps_the_built_in_tools_words() {
        assert_eq!(
            tool_status_label("Bash", &json!({ "command": "cat .env" })),
            "Running command…"
        );
        assert_eq!(tool_done_label("Bash", &json!({}), false), "Command done");
        assert_eq!(tool_done_label("Bash", &json!({}), true), "Command failed");
        assert_eq!(tool_status_label("SomethingNew", &json!({})), "Running SomethingNew…");
    }

    /// From `test/channel-tool-status.test.js` (package H1): the words a channel puts after "⚙️", "✓" and "❌" for the
    /// scripted turn there (a Bash that worked, a Read that failed). The Telegram bot itself is H1's.
    #[test]
    fn the_running_done_and_failed_lines_of_the_channel_tool_status_turn() {
        assert_eq!(
            tool_status_label("Bash", &json!({ "command": "ls" })),
            "Running command…"
        );
        assert_eq!(
            tool_done_label("Bash", &json!({ "command": "ls" }), false),
            "Command done"
        );
        assert_eq!(
            tool_done_label("Read", &json!({ "file_path": "/x/missing.md" }), true),
            "Read missing.md"
        );
    }

    /// The expected text was printed by the Node code (`src/lib/tool-status.js`) for the same calls.
    #[test]
    fn awkward_names_and_inputs_match_the_node_output() {
        let cases: Vec<(&str, Value, bool, &str, &str)> = vec![
            (
                "mcp__my_server__do_thing",
                json!({}),
                false,
                "Running do thing…",
                "do thing done",
            ),
            ("mcp__a_b_c__x_y", json!({}), true, "Running x y…", "x y failed"),
            (
                "mcp__tarsee__tarsee_send_file",
                json!({ "file_path": "dir/" }),
                false,
                "Sending file…",
                "Sent file",
            ),
            (
                "mcp__tarsee__tarsee_send_file",
                Value::Null,
                true,
                "Sending file…",
                "Sending file failed",
            ),
            (
                "tarsee_send_file",
                json!({ "file_path": 42 }),
                false,
                "Sending 42…",
                "Sent 42",
            ),
            ("Read", json!({}), false, "Reading file…", "Read file"),
            (
                "Read",
                json!({ "file_path": ["a", "b/c.txt"] }),
                false,
                "Reading c.txt…",
                "Read c.txt",
            ),
            (
                "Edit",
                json!({ "file_path": { "x": 1 } }),
                true,
                "Editing [object Object]…",
                "Edited [object Object]",
            ),
            ("mcp__", json!({}), false, "Running mcp  …", "mcp   done"),
            ("mcp____x", json!({}), false, "Running mcp    x…", "mcp    x done"),
            ("", json!({}), false, "Running …", " done"),
            (
                "constructor",
                json!({}),
                false,
                "Running constructor…",
                "constructor done",
            ),
            ("TodoWrite", json!({}), true, "Updating todo list…", "Todos updated"),
            (
                "mcp__tarsee__tarsee_pdf_read",
                json!({ "path": "", "source": "x/y.pdf?a=1" }),
                false,
                "Reading y.pdf…",
                "Read y.pdf",
            ),
            (
                "mcp__tarsee__tarsee_pdf_read",
                json!({}),
                false,
                "Reading file…",
                "Read file",
            ),
        ];
        for (name, input, is_error, running, done) in cases {
            assert_eq!(tool_status_label(name, &input), running, "{name} {input}");
            assert_eq!(tool_done_label(name, &input, is_error), done, "{name} {input}");
        }
    }
}
