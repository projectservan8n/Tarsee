//! Tests of the Tarsee MCP server: the tool list against what the Node server sent, the stand-in for zod against
//! what zod did, each tool's way to `execute_tool`, and the answers to requests.
//!
//! The cases of `test/mcp-tools.test.js` that only read the tool list are here ("tarsee MCP server", 4 cases); the
//! others need scheduled tasks (package S5). `test/pdf-read.test.js`'s "is listed with path required and pages
//! optional" is here too.

use serde_json::{Value, json};

use super::protocol::{Message, Request, Step, is_initialize_message, parse_message};
use super::schema as z;
use super::*;
use crate::testkit::{CapturedLogs, FakeTools, test_app, test_app_with_env};

/// The `tools` of the Node server's `tools/list` answer, as it was sent (TARSEE_TIMEZONE=UTC).
const NODE_TOOLS_UTC: &str = include_str!("node-tools-list-UTC.json");
/// The same with TARSEE_TIMEZONE=America/Argentina/Buenos_Aires.
const NODE_TOOLS_BUENOS_AIRES: &str = include_str!("node-tools-list-America_Argentina_Buenos_Aires.json");
/// What zod, through the Agent SDK's MCP server, made of a set of shapes: their JSON Schema on the wire, and what
/// calls with given arguments were answered (`docs/rust-port/reports/S4-probe-zod.mjs.txt`).
const NODE_ZOD_PROBE: &str = include_str!("node-zod-probe.json");

fn server(app: &App) -> TarseeMcp {
    create_tarsee_mcp(
        app,
        ToolContext::for_conversation("conv-1"),
        CreateOptions { quiet: true },
    )
}

fn listed(app: &App) -> Vec<Value> {
    server(app).list_tools()["tools"].as_array().cloned().unwrap()
}

fn text_of(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap()
}

// --- The tool list ---------------------------------------------------------------------------------------------------

#[test]
fn the_tool_list_is_the_node_servers_byte_for_byte() {
    let t = test_app();
    assert_eq!(t.config().timezone, "UTC");
    let ours = server(&t.app).list_tools()["tools"].to_string();
    let node = NODE_TOOLS_UTC.trim_end();
    if ours != node {
        // Where they part, so a wrong word is found without reading 30,000 characters.
        let at = ours.bytes().zip(node.bytes()).position(|(a, b)| a != b).unwrap_or(0);
        let from = at.saturating_sub(120);
        panic!(
            "the tool list differs from the Node server's at byte {at}:\n ours: {}\n node: {}",
            String::from_utf8_lossy(&ours.as_bytes()[from..(at + 80).min(ours.len())]),
            String::from_utf8_lossy(&node.as_bytes()[from..(at + 80).min(node.len())]),
        );
    }
}

#[test]
fn the_configured_timezone_is_named_where_the_node_server_named_it() {
    let t = test_app_with_env([("TARSEE_TIMEZONE", "America/Argentina/Buenos_Aires")]);
    let ours = server(&t.app).list_tools()["tools"].to_string();
    assert_eq!(ours, NODE_TOOLS_BUENOS_AIRES.trim_end());
    assert_eq!(ours.matches("America/Argentina/Buenos_Aires").count(), 3);
}

#[test]
fn every_tool_is_a_tarsee_tool_with_an_object_for_its_arguments() {
    let t = test_app();
    let tools = listed(&t.app);
    assert_eq!(tools.len(), 27);
    for tool in &tools {
        let name = tool["name"].as_str().unwrap();
        assert!(name.starts_with("tarsee_"), "{name}");
        assert!(!tool["description"].as_str().unwrap().is_empty(), "{name}");
        assert_eq!(tool["inputSchema"]["type"], "object", "{name}");
        assert_eq!(
            tool["inputSchema"]["$schema"], "http://json-schema.org/draft-07/schema#",
            "{name}"
        );
        assert_eq!(tool["execution"], json!({"taskSupport": "forbidden"}), "{name}");
        assert_eq!(
            tool.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["name", "description", "inputSchema", "execution"]
        );
    }
    // What a tool registry (lib/tool_registry.rs) reads: the names and descriptions.
    let mcp = server(&t.app);
    assert_eq!(mcp.tools().len(), 27);
    assert_eq!(mcp.tools()[0].name, "tarsee_send_message");
    assert!(mcp.tools()[0].description.starts_with("Send a message to a channel"));
    assert_eq!(mcp.tools()[0].input_schema(), tools[0]["inputSchema"]);
    assert_eq!(mcp.context(), &ToolContext::for_conversation("conv-1"));
}

// test/mcp-tools.test.js, "tarsee MCP server".

#[test]
fn lists_its_tools_without_throwing() {
    let t = test_app();
    assert!(!listed(&t.app).is_empty(), "tools/list returned an empty tool list");
}

#[test]
fn exposes_every_declared_tool_so_none_is_silently_dropped() {
    let t = test_app();
    let tools = listed(&t.app);
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    // The provider advertises these by name in the system prompt; if one stops being listed, the model is being
    // told about a tool it cannot call.
    for name in [
        "tarsee_send_message",
        "tarsee_schedule_task",
        "tarsee_remember",
        "tarsee_read_file",
        "tarsee_write_file",
        "tarsee_search_memories",
    ] {
        assert!(names.contains(&name), "{name} is missing from tools/list");
    }
}

#[test]
fn produces_a_valid_json_schema_for_schedule_tasks_nested_action_args() {
    // The exact shape that used to throw. `args` is a free-form object, so the schema must describe an object.
    let t = test_app();
    let tools = listed(&t.app);
    let schedule = tools.iter().find(|t| t["name"] == "tarsee_schedule_task").unwrap();
    let args = &schedule["inputSchema"]["properties"]["action"]["properties"]["args"];
    assert_eq!(args["type"], "object");
    assert_eq!(args["additionalProperties"], json!({}));
}

#[test]
fn schedule_task_says_to_schedule_only_when_the_owner_asks_and_that_a_task_starts_paused_until_the_owner_switches_it_on()
 {
    // Every run of a scheduled task can be a paid turn on the AI, so the owner decides: lib/cron.rs saves the AI's
    // tasks paused, and the description tells the model so before it calls the tool.
    let t = test_app();
    let tools = listed(&t.app);
    let schedule = tools.iter().find(|t| t["name"] == "tarsee_schedule_task").unwrap();
    let description = schedule["description"].as_str().unwrap();
    for said in [
        "Only schedule a task when the owner asks for one",
        "starts paused",
        "until the owner switches it on",
        "/cron on <id>",
        "at most once every 15 minutes",
    ] {
        assert!(description.contains(said), "{said}");
    }
}

// test/pdf-read.test.js, "tarsee_pdf_read (MCP)".
#[test]
fn pdf_read_is_listed_with_path_required_and_pages_optional() {
    let t = test_app();
    let tools = listed(&t.app);
    let tool = tools
        .iter()
        .find(|t| t["name"] == "tarsee_pdf_read")
        .expect("tarsee_pdf_read is not listed");
    assert_eq!(tool["inputSchema"]["required"], json!(["path"]));
    assert!(tool["inputSchema"]["properties"]["pages"].is_object());
}

#[test]
fn creating_a_server_says_so_once_with_its_tools_unless_it_is_asked_to_be_quiet() {
    let t = test_app();
    let logs = CapturedLogs::start();
    create_tarsee_mcp(&t.app, ToolContext::default(), CreateOptions { quiet: true });
    assert!(logs.lines().is_empty());
    create_tarsee_mcp(&t.app, ToolContext::default(), CreateOptions::default());
    let lines = logs.infos();
    assert_eq!(lines.len(), 1);
    assert!(
        lines[0]
            .starts_with("[mcp] Creating Tarsee MCP server: 27 tools, names: tarsee_send_message, tarsee_send_file, "),
        "{}",
        lines[0]
    );
    assert!(lines[0].ends_with(", tarsee_list_files, tarsee_push_notification"));
}

// --- zod -------------------------------------------------------------------------------------------------------------

/// The shapes the probe gave zod, written with the stand-in.
fn probe_shapes() -> Vec<(&'static str, z::Schema)> {
    let combos = z::object([
        ("s_plain", z::string()),
        ("s_desc", z::string().describe("D")),
        ("s_opt", z::string().optional()),
        ("s_opt_desc", z::string().optional().describe("D")),
        ("s_desc_opt", z::string().describe("D").optional()),
        ("s_desc_opt_desc", z::string().describe("D1").optional().describe("D2")),
        ("n_desc_opt", z::number().describe("D").optional()),
        ("e_plain", z::enumeration(["a", "b"])),
        ("e_opt_desc", z::enumeration(["a", "b"]).optional().describe("D")),
        ("e_desc_opt", z::enumeration(["a", "b"]).describe("D").optional()),
        ("a_opt_desc", z::array(z::string()).optional().describe("D")),
        ("a_desc_opt", z::array(z::string()).describe("D").optional()),
        ("a_item_desc", z::array(z::string().describe("I")).optional()),
        ("o_opt_desc", z::object([("x", z::string())]).optional().describe("D")),
        ("o_desc_opt", z::object([("x", z::string())]).describe("D").optional()),
        ("o_empty", z::object(no_keys()).optional()),
        ("o_all_opt", z::object([("x", z::string().optional())]).optional()),
        (
            "u_desc",
            z::union([z::string(), z::array(z::string())]).describe("D").optional(),
        ),
        (
            "u_opt_desc",
            z::union([z::string(), z::array(z::string())]).optional().describe("D"),
        ),
        ("r_plain", z::record(z::any()).optional()),
        ("r_desc", z::record(z::any()).describe("D").optional()),
        ("r_opt_desc", z::record(z::any()).optional().describe("D")),
        ("b_desc", z::boolean().describe("D").optional()),
    ]);
    let strip = z::object([
        ("a", z::string().optional()),
        (
            "b",
            z::object([("x", z::string().optional()), ("y", z::number().optional())]).optional(),
        ),
        ("c", z::array(z::object([("k", z::string())])).optional()),
        ("r", z::record(z::any()).optional()),
        ("u", z::union([z::string(), z::array(z::string())]).optional()),
        ("n", z::number().optional()),
        ("f", z::boolean().optional()),
    ]);
    vec![
        ("combos", combos),
        ("strip", strip),
        ("none", z::object(no_keys())),
        ("single", z::object([("only", z::enumeration(["a"]))])),
    ]
}

#[test]
fn a_shape_becomes_the_json_schema_zod_made_of_it() {
    let probe: Value = serde_json::from_str(NODE_ZOD_PROBE).unwrap();
    let shapes = probe_shapes();
    let tools = probe["tools"].as_array().unwrap();
    assert_eq!(tools.len(), shapes.len());
    for (tool, (name, shape)) in tools.iter().zip(&shapes) {
        assert_eq!(tool["name"], *name);
        assert_eq!(
            shape.input_schema().to_string(),
            tool["inputSchema"].to_string(),
            "{name}"
        );
    }
}

#[test]
fn arguments_are_checked_and_handed_on_as_zod_checked_and_handed_them_on() {
    let probe: Value = serde_json::from_str(NODE_ZOD_PROBE).unwrap();
    let shapes = probe_shapes();
    let calls = probe["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 25);
    for call in calls {
        let name = call["tool"].as_str().unwrap();
        let shape = &shapes.iter().find(|(known, _)| *known == name).unwrap().1;
        // The probe's tools answered with the arguments they were handed, as JSON; a refused call with zod's words.
        let node = text_of(&call["result"]);
        let ours = match checked_arguments(name, shape, Some(&call["arguments"])) {
            Ok(args) => args.to_string(),
            Err(refusal) => refusal,
        };
        assert_eq!(ours, node, "{name} {}", call["arguments"]);
        assert_eq!(
            call["result"]["isError"] == json!(true),
            ours.starts_with("MCP error"),
            "{name}"
        );
    }
}

#[test]
fn a_call_with_no_arguments_at_all_is_refused_as_zod_refused_it() {
    // (The SDK handed zod `undefined`, not `{}`.)
    let none = z::object(no_keys());
    assert_eq!(
        checked_arguments("tarsee_list_files", &none, None).unwrap_err(),
        "MCP error -32602: Input validation error: Invalid arguments for tool tarsee_list_files: [\n  {\n    \"expected\": \"object\",\n    \"code\": \"invalid_type\",\n    \"path\": [],\n    \"message\": \"Invalid input: expected object, received undefined\"\n  }\n]"
    );
    assert_eq!(
        checked_arguments("x", &none, Some(&json!({"a": 1}))).unwrap(),
        json!({})
    );
}

#[test]
fn the_shapes_only_the_requests_use_check_as_zod_checks_them() {
    // A whole number JavaScript holds exactly: 1.0 is one, 2^53 is not, 1.5 is not.
    assert_eq!(z::int().parse(Some(&json!(1.0))).unwrap(), Some(json!(1)));
    assert_eq!(z::int().parse(Some(&json!(-0.0))).unwrap(), Some(json!(0)));
    assert!(z::int().accepts(Some(&json!(9_007_199_254_740_991_i64))));
    assert!(!z::int().accepts(Some(&json!(9_007_199_254_740_992_i64))));
    assert!(!z::int().accepts(Some(&json!(1.5))));
    assert!(!z::int().accepts(Some(&json!("1"))));
    assert!(!z::int().accepts(Some(&json!(u64::MAX))));
    // A loose object keeps what it does not name, after what it names; a strict one refuses it.
    let loose = z::loose_object([("b", z::string().optional())]);
    assert_eq!(
        loose
            .parse(Some(&json!({"z": 1, "b": "x", "a": [2]})))
            .unwrap()
            .unwrap()
            .to_string(),
        r#"{"b":"x","z":1,"a":[2]}"#
    );
    let strict = z::strict_object([("b", z::string().optional())]);
    assert!(strict.accepts(Some(&json!({"b": "x"}))));
    assert_eq!(
        strict.parse(Some(&json!({"b": "x", "z": 1, "y": 2}))).unwrap_err(),
        vec![
            json!({"code": "unrecognized_keys", "keys": ["z", "y"], "path": [], "message": "Unrecognized keys: \"z\", \"y\""})
        ]
    );
    assert!(z::literal("2.0").accepts(Some(&json!("2.0"))));
    assert!(!z::literal("2.0").accepts(Some(&json!(2.0))));
    assert!(z::assert_object().accepts(Some(&json!([]))));
    assert!(!z::assert_object().accepts(Some(&json!(null))));
    // Both halves of an intersection speak.
    let both = z::intersection(z::object(no_keys()), z::record(z::any()));
    assert_eq!(both.parse(Some(&json!(5))).unwrap_err().len(), 2);
    // z.any() where a value must be: zod's own words for that.
    assert_eq!(
        z::object([("x", z::any())]).parse(Some(&json!({}))).unwrap_err()[0].to_string(),
        r#"{"code":"invalid_type","expected":"nonoptional","path":["x"],"message":"Invalid input: expected nonoptional, received undefined"}"#
    );
    assert!(z::string().optional().is_optional() && !z::string().is_optional());
}

// --- Calls -----------------------------------------------------------------------------------------------------------

/// Every tool, with arguments that fit it, and what `execute_tool` must be asked for it: the tool's own name and
/// the arguments under the names it reads.
fn routes() -> Vec<(&'static str, Value, &'static str, Value)> {
    let same = |mcp: &'static str, inner: &'static str, args: Value| (mcp, args.clone(), inner, args);
    vec![
        same(
            "tarsee_send_message",
            "send_message",
            json!({"channel": "telegram", "message": "hi", "channel_id": "42"}),
        ),
        same(
            "tarsee_send_file",
            "send_file",
            json!({"channel": "web", "file_path": "report.pdf"}),
        ),
        same(
            "tarsee_configure_email_channel",
            "configure_email_channel",
            json!({"imap": {"host": "imap.example.com", "port": 993}, "enabled": true}),
        ),
        same(
            "tarsee_send_email_thread",
            "send_email_thread",
            json!({"to": ["a@example.com"], "cc": "b@example.com", "subject": "s", "body": "b"}),
        ),
        same(
            "tarsee_schedule_task",
            "schedule_task",
            json!({"schedule": "0 8 * * *", "action": {"tool": "send_message", "args": {"channel": "web", "n": [1, {"deep": null}]}}}),
        ),
        (
            "tarsee_remember",
            json!({"content": "likes tea", "category": "preference"}),
            "remember",
            json!({"fact": "likes tea", "category": "preference"}),
        ),
        (
            "tarsee_daily_log",
            json!({"content": "walked"}),
            "daily_log",
            json!({"note": "walked"}),
        ),
        same("tarsee_read_file", "read_file", json!({"filename": "MEMORY.md"})),
        same(
            "tarsee_write_file",
            "write_file",
            json!({"filename": "USER.md", "content": "x"}),
        ),
        same("tarsee_search_memories", "search_memories", json!({"query": "tea"})),
        same(
            "tarsee_search_memories_deep",
            "search_memories_deep",
            json!({"query": "tea"}),
        ),
        same(
            "tarsee_create_canvas",
            "create_canvas",
            json!({"title": "t", "html": "<p>x</p>", "js": "1"}),
        ),
        same(
            "tarsee_create_diagram",
            "create_diagram",
            json!({"title": "t", "nodes": [{"id": "a", "label": "A", "kind": "note"}], "edges": [{"from": "a", "to": "a"}]}),
        ),
        same("tarsee_datetime", "datetime", json!({"format": "iso"})),
        same("tarsee_calculator", "calculator", json!({"expression": "6 * 7"})),
        same(
            "tarsee_discord_admin",
            "discord_admin",
            json!({"action": "edit_channel", "permissions": [{"target": "everyone", "allow": ["view"], "clear": false}]}),
        ),
        same(
            "tarsee_railway",
            "railway",
            json!({"action": "set_variable", "name": "PORT", "value": "8080", "deploy": false}),
        ),
        same(
            "tarsee_browser",
            "browser",
            json!({"action": "scroll", "timeout": 500, "direction": "down"}),
        ),
        same(
            "tarsee_web_fetch",
            "web_fetch",
            json!({"url": "https://example.com", "raw": true}),
        ),
        (
            "tarsee_web_search",
            json!({"query": "tarsiers", "num_results": 3}),
            "web_search",
            json!({"query": "tarsiers", "max_results": 3}),
        ),
        same(
            "tarsee_pdf_read",
            "pdf_read",
            json!({"path": "uploads/a.pdf", "pages": "2-5", "max_chars": 2000}),
        ),
        (
            "tarsee_get_key",
            json!({"key": "ALERTS"}),
            "get_key",
            json!({"name": "ALERTS"}),
        ),
        (
            "tarsee_set_key",
            json!({"key": "ALERTS", "value": "v", "description": "for alerts"}),
            "set_key",
            json!({"name": "ALERTS", "value": "v", "description": "for alerts"}),
        ),
        ("tarsee_list_keys", json!({}), "list_keys", json!({})),
        (
            "tarsee_delete_key",
            json!({"key": "ALERTS"}),
            "delete_key",
            json!({"name": "ALERTS"}),
        ),
        ("tarsee_list_files", json!({"anything": 1}), "list_files", json!({})),
        same(
            "tarsee_push_notification",
            "push_notification",
            json!({"title": "t", "body": "b", "tag": "g"}),
        ),
    ]
}

#[tokio::test]
async fn each_tool_reaches_execute_tool_under_its_own_name_with_the_arguments_it_reads_and_the_turns_context() {
    let t = test_app();
    let tools = FakeTools::install(&t.app);
    let mcp = server(&t.app);
    let routes = routes();
    let every: Vec<&str> = mcp.tools().iter().map(|tool| tool.name).collect();
    assert_eq!(
        routes.iter().map(|route| route.0).collect::<Vec<_>>(),
        every,
        "a tool has no case here"
    );
    for (name, args, inner, inner_args) in routes {
        tools.clear_calls();
        tools.respond(inner, format!("{inner} ran"));
        let result = mcp.call_tool(&t.app, name, Some(&args)).await;
        // A saved task is the one answer of schedule_task that is no failure.
        if name == "tarsee_schedule_task" {
            assert_eq!(result["isError"], true);
        } else {
            assert_eq!(
                result.to_string(),
                format!(r#"{{"content":[{{"type":"text","text":"{inner} ran"}}]}}"#)
            );
        }
        let calls = tools.calls();
        assert_eq!(calls.len(), 1, "{name}");
        assert_eq!(calls[0].name, inner);
        assert_eq!(calls[0].args.to_string(), inner_args.to_string(), "{name}");
        assert_eq!(calls[0].ctx, ToolContext::for_conversation("conv-1"));
    }
}

#[tokio::test]
async fn what_the_tool_is_handed_has_only_the_keys_its_shape_names_in_the_shapes_order() {
    let t = test_app();
    let tools = FakeTools::install(&t.app);
    let mcp = server(&t.app);
    mcp.call_tool(
        &t.app,
        "tarsee_send_message",
        Some(&json!({"zzz": true, "channel_id": "42", "message": "hi", "__proto__": {"x": 1}, "channel": "slack"})),
    )
    .await;
    mcp.call_tool(
        &t.app,
        "tarsee_remember",
        Some(&json!({"content": "no category", "fact": "not this"})),
    )
    .await;
    mcp.call_tool(
        &t.app,
        "tarsee_web_search",
        Some(&json!({"query": "q", "max_results": 9})),
    )
    .await;
    let calls = tools.calls();
    assert_eq!(
        calls[0].args.to_string(),
        r#"{"channel":"slack","message":"hi","channel_id":"42"}"#
    );
    // One that was left out stays out (JavaScript's `undefined`).
    assert_eq!(calls[1].args.to_string(), r#"{"fact":"no category"}"#);
    assert_eq!(calls[2].args.to_string(), r#"{"query":"q"}"#);
}

#[tokio::test]
async fn arguments_that_dont_fit_never_reach_the_tool_and_the_model_is_told_what_is_wrong() {
    let t = test_app();
    let tools = FakeTools::install(&t.app);
    let mcp = server(&t.app);
    let refused = mcp
        .call_tool(
            &t.app,
            "tarsee_send_message",
            Some(&json!({"channel": "pager", "message": 5})),
        )
        .await;
    assert_eq!(refused["isError"], true);
    assert_eq!(
        text_of(&refused),
        "MCP error -32602: Input validation error: Invalid arguments for tool tarsee_send_message: [\n  {\n    \"code\": \"invalid_value\",\n    \"values\": [\n      \"telegram\",\n      \"discord\",\n      \"whatsapp\",\n      \"slack\",\n      \"email\",\n      \"web\"\n    ],\n    \"path\": [\n      \"channel\"\n    ],\n    \"message\": \"Invalid option: expected one of \\\"telegram\\\"|\\\"discord\\\"|\\\"whatsapp\\\"|\\\"slack\\\"|\\\"email\\\"|\\\"web\\\"\"\n  },\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"message\"\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  }\n]"
    );
    for (name, args) in [
        ("tarsee_calculator", None),
        ("tarsee_calculator", Some(json!({}))),
        ("tarsee_calculator", Some(json!({"expression": null}))),
        ("tarsee_list_files", None),
        (
            "tarsee_send_email_thread",
            Some(json!({"to": 5, "subject": "s", "body": "b"})),
        ),
        (
            "tarsee_schedule_task",
            Some(json!({"schedule": "* * * * *", "action": {"tool": "x", "args": []}})),
        ),
        (
            "tarsee_create_diagram",
            Some(json!({"title": "t", "nodes": [{"id": "a"}], "edges": []})),
        ),
    ] {
        let result = mcp.call_tool(&t.app, name, args.as_ref()).await;
        assert_eq!(result["isError"], true, "{name} {args:?}");
        assert!(
            text_of(&result).starts_with(&format!(
                "MCP error -32602: Input validation error: Invalid arguments for tool {name}: ["
            )),
            "{name}"
        );
    }
    let unknown = mcp
        .call_tool(&t.app, "calculator", Some(&json!({"expression": "1"})))
        .await;
    assert_eq!(
        unknown.to_string(),
        r#"{"content":[{"type":"text","text":"MCP error -32602: Tool calculator not found"}],"isError":true}"#
    );
    assert!(tools.calls().is_empty(), "a refused call reached a tool");
}

#[tokio::test]
async fn schedule_task_marks_every_answer_where_no_task_was_saved_as_a_failure() {
    let t = test_app();
    let tools = FakeTools::install(&t.app);
    let mcp = server(&t.app);
    let schedule = |args: Value| {
        let (mcp, app) = (mcp.clone(), t.app.clone());
        async move { mcp.call_tool(&app, "tarsee_schedule_task", Some(&args)).await }
    };

    // Neither a prompt nor an action (an empty prompt is none): the tool is not run.
    for args in [
        json!({"schedule": "0 8 * * 1", "name": "Nothing to do"}),
        json!({"schedule": "0 8 * * 1", "prompt": ""}),
    ] {
        let result = schedule(args).await;
        assert_eq!(
            result.to_string(),
            r#"{"content":[{"type":"text","text":"Error: Either 'prompt' or 'action' is required. Nothing was saved."}],"isError":true}"#
        );
    }
    assert!(tools.calls().is_empty());

    // lib/tools.rs's saved answer, and only that, is a success.
    tools.respond(
        "schedule_task",
        "Saved the task \"Weekly summary\" (id cron_1), but it is paused",
    );
    let saved = schedule(json!({"schedule": "0 8 * * 1", "prompt": "Sum up the week", "name": "Weekly summary"})).await;
    assert_eq!(
        saved.to_string(),
        r#"{"content":[{"type":"text","text":"Saved the task \"Weekly summary\" (id cron_1), but it is paused"}]}"#
    );
    // An action alone is enough to run the tool.
    let direct = schedule(json!({"schedule": "0 9 * * *", "action": {"tool": "send_message", "args": {}}})).await;
    assert!(direct.get("isError").is_none());

    for said in [
        "schedule_task error: Invalid cron schedule",
        "schedule_task refused: this run was started by a scheduled task",
        "Refused by security policy: schedule_task is denied. Change it in Settings > Tool Permissions.",
        "saved the task",
        "",
    ] {
        tools.respond("schedule_task", said);
        let result = schedule(json!({"schedule": "0 8 * * 1", "prompt": "Say hi"})).await;
        assert_eq!(result["isError"], true, "{said}");
        assert_eq!(text_of(&result), said);
        assert_eq!(
            result.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["content", "isError"]
        );
    }
}

// --- Requests --------------------------------------------------------------------------------------------------------

fn request(value: Value) -> Request {
    match parse_message(&value) {
        Some(Message::Request(request)) => request,
        other => panic!("not a request: {value} ({other:?})"),
    }
}

#[tokio::test]
async fn a_request_is_answered_as_the_sdks_server_answered_it() {
    let t = test_app();
    let tools = FakeTools::install(&t.app);
    tools.respond("calculator", "6 * 7 = 42");
    let mcp = server(&t.app);
    let answer = |value: Value| {
        let (mcp, app) = (mcp.clone(), t.app.clone());
        async move { mcp.handle_request(&app, &request(value)).await.to_string() }
    };

    assert_eq!(
        answer(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).await,
        r#"{"result":{},"jsonrpc":"2.0","id":1}"#
    );
    assert_eq!(
        answer(json!({"jsonrpc": "2.0", "id": "a", "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "c", "version": "1"}
        }}))
        .await,
        r#"{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"tarsee","version":"1.0.0"}},"jsonrpc":"2.0","id":"a"}"#
    );
    // A version the server does not know: its newest.
    assert!(
        answer(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "c", "version": "1"}
        }}))
        .await
        .contains(r#""protocolVersion":"2025-11-25""#)
    );
    assert_eq!(
        answer(json!({"jsonrpc": "2.0", "id": 2, "method": "resources/list"})).await,
        r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}"#
    );
    assert_eq!(
        answer(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})).await,
        format!(
            r#"{{"result":{{"tools":{}}},"jsonrpc":"2.0","id":3}}"#,
            NODE_TOOLS_UTC.trim_end()
        )
    );
    assert_eq!(
        answer(json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "tarsee_calculator", "arguments": {"expression": "6 * 7"}, "_meta": {"progressToken": 1}
        }}))
        .await,
        r#"{"result":{"content":[{"type":"text","text":"6 * 7 = 42"}]},"jsonrpc":"2.0","id":4}"#
    );
    assert_eq!(
        answer(json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"arguments": {}}})).await,
        "{\"jsonrpc\":\"2.0\",\"id\":5,\"error\":{\"code\":-32603,\"message\":\"[\\n  {\\n    \\\"expected\\\": \\\"string\\\",\\n    \\\"code\\\": \\\"invalid_type\\\",\\n    \\\"path\\\": [\\n      \\\"params\\\",\\n      \\\"name\\\"\\n    ],\\n    \\\"message\\\": \\\"Invalid input: expected string, received undefined\\\"\\n  }\\n]\"}}"
    );
    assert_eq!(
        answer(json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "tarsee_calculator", "task": {}}}))
            .await,
        r#"{"jsonrpc":"2.0","id":6,"error":{"code":-32603,"message":"Server does not support task creation (required for tools/call)"}}"#
    );
    assert_eq!(tools.calls().len(), 1);
}

#[test]
fn a_tools_call_is_the_one_request_that_is_not_answered_at_once() {
    let t = test_app();
    let mcp = server(&t.app);
    let step = mcp.begin(&request(
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "tarsee_list_files"
        }}),
    ));
    assert_eq!(
        step,
        Step::Call {
            name: "tarsee_list_files".into(),
            arguments: None
        }
    );
    assert!(matches!(
        mcp.begin(&request(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))),
        Step::Answer(_)
    ));
}

#[test]
fn a_message_is_a_request_a_notification_or_a_response_and_nothing_else() {
    let kind = |value: Value| match parse_message(&value) {
        Some(Message::Request(_)) => "request",
        Some(Message::Notification { .. }) => "notification",
        Some(Message::Response) => "response",
        None => "none",
    };
    assert_eq!(kind(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})), "request");
    assert_eq!(kind(json!({"jsonrpc": "2.0", "id": "", "method": ""})), "request");
    assert_eq!(
        kind(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})),
        "notification"
    );
    assert_eq!(kind(json!({"jsonrpc": "2.0", "id": 1, "result": {}})), "response");
    assert_eq!(
        kind(json!({"jsonrpc": "2.0", "error": {"code": -1, "message": "x", "data": [1]}})),
        "response"
    );
    for not_a_message in [
        json!(null),
        json!("ping"),
        json!([]),
        json!({}),
        json!({"id": 1, "method": "ping"}),
        json!({"jsonrpc": "1.0", "id": 1, "method": "ping"}),
        json!({"jsonrpc": "2.0", "id": 1}),
        json!({"jsonrpc": "2.0", "id": null, "method": "ping"}),
        json!({"jsonrpc": "2.0", "id": 1.5, "method": "ping"}),
        json!({"jsonrpc": "2.0", "id": true, "method": "ping"}),
        json!({"jsonrpc": "2.0", "id": 9_007_199_254_740_993_i64, "method": "ping"}),
        json!({"jsonrpc": "2.0", "id": 1, "method": 5}),
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": null}),
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": [1]}),
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"_meta": 5}}),
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"_meta": {"progressToken": 1.5}}}),
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "extra": 1}),
        json!({"jsonrpc": "2.0", "method": "x", "params": 5}),
        json!({"jsonrpc": "2.0", "id": 1, "result": 5}),
        json!({"jsonrpc": "2.0", "id": 1, "result": {}, "error": {"code": 1, "message": "x"}}),
        json!({"jsonrpc": "2.0", "id": 1, "error": {"code": 1.5, "message": "x"}}),
        json!({"jsonrpc": "2.0", "id": null, "error": {"code": 1, "message": "x"}}),
    ] {
        assert_eq!(kind(not_a_message.clone()), "none", "{not_a_message}");
    }
    // An id is sent back as a whole number, however it was written.
    assert_eq!(
        request(json!({"jsonrpc": "2.0", "id": 1.0, "method": "ping"})).id,
        json!(1)
    );
    // The params are kept whole, whatever else is in them.
    let kept = request(json!({"jsonrpc": "2.0", "id": 1, "method": "x", "params": {"a": [1], "_meta": {"k": "v"}}}));
    assert_eq!(kept.params, Some(json!({"a": [1], "_meta": {"k": "v"}})));
}

#[test]
fn an_initialization_is_an_initialize_with_parameters_that_fit() {
    let fits =
        json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "c", "version": "1"}});
    let message = |value: Value| parse_message(&value).unwrap();
    assert!(is_initialize_message(&message(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": fits})
    )));
    // (The SDK asked the same of a message with no id.)
    assert!(is_initialize_message(&message(
        json!({"jsonrpc": "2.0", "method": "initialize", "params": fits})
    )));
    assert!(!is_initialize_message(&message(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    )));
    assert!(!is_initialize_message(&message(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "x"}})
    )));
    assert!(!is_initialize_message(&message(
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": fits})
    )));
    assert!(!is_initialize_message(&message(
        json!({"jsonrpc": "2.0", "id": 1, "result": {}})
    )));
}
