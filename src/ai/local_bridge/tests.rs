//! Port of `test/local-bridge.test.js`, and the bridge's pure functions checked against the Node code's answers.
//!
//! The Local AI bridge: Codex 0.167 sends Tarsee's tools as one `{type: "namespace"}` tool, which LM Studio, Ollama
//! before 0.34 and llama-server drop, and finds the tool to run by the reply's `{namespace, name}`. The bridge flattens
//! the tools on the way to the owner's server and puts the namespace back on the way out, cleans up what strict
//! servers refuse, and keeps the owner's key out of the Codex process. Every key and token here is a fake.
//!
//! `node-cases.json` holds what the Node functions answered for several hundred inputs (made by
//! `docs/rust-port/reports/A5-capture-bridge.mjs.txt`); `node_*` tests below replay each and compare.

use std::sync::atomic::{AtomicI64, Ordering};

use futures::stream;
use serde_json::json;
use tokio::sync::oneshot;

use super::*;
use crate::net::fetch::ReqwestFetch;
use crate::testkit::{Answer, FakeFetch};

const NODE_CASES: &str = include_str!("node-cases.json");

fn node_cases() -> Value {
    serde_json::from_str(NODE_CASES).expect("node-cases.json is JSON")
}

fn func(name: &str) -> Value {
    json!({"type": "function", "name": name, "description": format!("{name} does a thing"), "strict": false, "parameters": {"type": "object", "properties": {}}})
}

/// Tarsee's tools as Codex 0.167 sends them (namespace "mcp__tarsee", captured from the pinned binary).
fn tarsee_ns() -> Value {
    json!({"type": "namespace", "name": "mcp__tarsee", "description": "Tarsee's tools", "tools": [func("tarsee_calculator"), func("tarsee_datetime")]})
}

fn names_of(tools: Value) -> ToolNames {
    flatten_tools(Some(&tools)).names
}

fn original(namespace: &str, name: &str) -> OriginalName {
    OriginalName {
        namespace: Some(json!(namespace)),
        name: name.to_string(),
    }
}

// --- flat names: one fixed rule, at most 64 characters, no clashes ----------------------------------------------

#[test]
fn joins_the_namespace_and_the_name_with_double_underscore_none_added_when_the_namespace_already_ends_in_it() {
    assert_eq!(
        flat_name("mcp__tarsee", "tarsee_calculator", None),
        "mcp__tarsee__tarsee_calculator"
    );
    assert_eq!(
        flat_name("mcp__tarsee__", "tarsee_calculator", None),
        "mcp__tarsee__tarsee_calculator"
    );
    assert_eq!(
        flat_name("mcp__my.server", "do it", None),
        "mcp__my_server__do_it",
        "only [A-Za-z0-9_-]"
    );
}

#[test]
fn a_name_past_64_characters_is_cut_and_given_a_short_hash_the_same_every_time_and_different_per_tool() {
    let long = "x".repeat(80);
    let a = flat_name("mcp__tarsee", &format!("{long}_a"), None);
    let b = flat_name("mcp__tarsee", &format!("{long}_b"), None);
    assert_eq!(a.len(), MAX_TOOL_NAME);
    assert_eq!(b.len(), MAX_TOOL_NAME);
    assert_ne!(a, b);
    assert_eq!(
        flat_name("mcp__tarsee", &format!("{long}_a"), None),
        a,
        "fixed: nothing is kept between requests"
    );
    assert!(Regex::new("^mcp__tarsee__x+_[0-9a-f]{8}$").unwrap().is_match(&a), "{a}");
}

#[test]
fn a_flat_name_that_clashes_with_a_plain_function_tool_or_another_flat_name_gets_the_hashed_form() {
    let FlatTools { tools, names } = flatten_tools(Some(&json!([func("mcp__tarsee__tarsee_calculator"), tarsee_ns()])));
    let flat: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        flat.iter().collect::<HashSet<_>>().len(),
        flat.len(),
        "no two tools share a name"
    );
    assert_eq!(
        flat[0], "mcp__tarsee__tarsee_calculator",
        "the plain tool keeps its own name"
    );
    let moved = &names.by_pair["mcp__tarsee\u{0}tarsee_calculator"];
    assert_ne!(moved, "mcp__tarsee__tarsee_calculator");
    assert_eq!(names.by_flat[moved], original("mcp__tarsee", "tarsee_calculator"));
    // Two namespaces whose joined names meet.
    let two = flatten_tools(Some(&json!([
        {"type": "namespace", "name": "a__", "tools": [func("b")]},
        {"type": "namespace", "name": "a", "tools": [func("b")]},
    ])));
    let distinct: HashSet<&str> = two.tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(distinct.len(), 2);
}

// --- requests: what any Local AI server takes --------------------------------------------------------------------

#[test]
fn namespace_tools_become_function_tools_other_tool_kinds_go_plain_functions_stay_as_they_are() {
    let body = json!({
        "model": "spark-4b", "stream": true, "tool_choice": "auto",
        "tools": [func("exec_command"), tarsee_ns(), {"type": "custom", "name": "apply_patch", "format": {"type": "grammar"}}, {"type": "web_search"}],
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
    });
    let before = body.to_string();
    let RewrittenRequest { body: out, names } = rewrite_request(&body);
    assert_eq!(
        body.to_string(),
        before,
        "the request Codex sent is not changed in place"
    );
    let kinds: Vec<(&str, &str)> = out["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["type"].as_str().unwrap(), t["name"].as_str().unwrap()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("function", "exec_command"),
            ("function", "mcp__tarsee__tarsee_calculator"),
            ("function", "mcp__tarsee__tarsee_datetime")
        ]
    );
    assert_eq!(
        out["tools"][1]["parameters"],
        tarsee_ns()["tools"][0]["parameters"],
        "each tool keeps its own description and parameters"
    );
    assert_eq!(out["tools"][1]["description"], "tarsee_calculator does a thing");
    assert_eq!(
        names.by_flat["mcp__tarsee__tarsee_datetime"],
        original("mcp__tarsee", "tarsee_datetime")
    );
    assert_eq!(out["model"], "spark-4b");
    assert_eq!(out["stream"], true);
    assert_eq!(out["tool_choice"], "auto");
}

#[test]
fn earlier_calls_in_the_history_get_their_flat_names_unknown_items_go_with_their_pairs_an_orphaned_output_goes() {
    let RewrittenRequest { body, .. } = rewrite_request(&json!({
        "tools": [tarsee_ns()],
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "work it out"}]},
            {"type": "function_call", "call_id": "c1", "namespace": "mcp__tarsee", "name": "tarsee_calculator", "arguments": "{\"expression\":\"6*7\"}"},
            {"type": "function_call_output", "call_id": "c1", "output": "6*7 = 42"},
            {"type": "tool_search_call", "call_id": "s1", "arguments": {"query": "x"}},
            {"type": "tool_search_output", "call_id": "s1", "tools": []},
            {"type": "custom_tool_call", "call_id": "p1", "name": "apply_patch", "input": "*** Begin Patch"},
            {"type": "custom_tool_call_output", "call_id": "p1", "output": "done"},
            {"type": "function_call_output", "call_id": "lost", "output": "no call for this one"},
            {"type": "additional_tools", "tools": []},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "42"}]},
        ],
    }));
    let types: Vec<&str> = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["message", "function_call", "function_call_output", "message"]);
    assert_eq!(body["input"][1]["name"], "mcp__tarsee__tarsee_calculator");
    assert!(body["input"][1].get("namespace").is_none());
    assert_eq!(body["input"][2]["call_id"], "c1");
}

#[test]
fn a_call_to_a_tool_this_request_no_longer_lists_still_gets_the_fixed_rules_name() {
    let RewrittenRequest { body, .. } = rewrite_request(&json!({"tools": [], "input": [
        {"type": "function_call", "call_id": "c", "namespace": "mcp__tarsee", "name": "tarsee_remember", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "c", "output": "ok"},
    ]}));
    assert_eq!(body["input"][0]["name"], "mcp__tarsee__tarsee_remember");
}

#[test]
fn reasoning_with_no_content_array_goes_llama_server_answers_400_for_it_with_one_it_stays() {
    let RewrittenRequest { body, .. } = rewrite_request(&json!({"input": [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "q"}]},
        {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "thinking"}], "encrypted_content": "gAAAA"},
        {"type": "reasoning", "id": "rs_2", "summary": [], "content": [{"type": "reasoning_text", "text": "kept"}]},
    ]}));
    let kept: Vec<&Value> = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i.get("id").unwrap_or(&i["role"]))
        .collect();
    assert_eq!(kept, [&json!("user"), &json!("rs_2")]);
}

#[test]
fn the_developer_messages_at_the_start_become_one_with_the_instructions_a_later_one_becomes_a_user_message() {
    // Codex 0.167 sends two developer messages first (its instructions, then Tarsee's), and no instructions field;
    // strict chat templates (the Qwen3.5 family's) refuse a system message that isn't first.
    let RewrittenRequest { body, .. } = rewrite_request(&json!({
        "instructions": "Base instructions.",
        "input": [
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Permissions."}]},
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "You are Tarsee."}, {"type": "input_text", "text": "Tools: calculator."}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]},
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "The model changed."}]},
            {"role": "system", "content": "A late system note."},
        ],
    }));
    assert!(
        body.get("instructions").is_none(),
        "folded into the one message at the start"
    );
    let roles: Vec<&str> = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["developer", "user", "user", "user"]);
    assert_eq!(body["input"][0]["content"].as_array().unwrap().len(), 1);
    assert_eq!(
        body["input"][0]["content"][0]["text"],
        "Base instructions.\n\nPermissions.\n\nYou are Tarsee.\n\nTools: calculator."
    );
    assert_eq!(body["input"][2]["content"][0]["text"], "The model changed.");
    assert_eq!(body["input"][3]["content"], "A late system note.");
    // One developer message and no instructions: as it was.
    let one = rewrite_request(&json!({"input": [{"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "only"}]}]})).body;
    assert_eq!(
        one["input"],
        json!([{"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "only"}]}])
    );
}

#[test]
fn an_assistants_refusal_part_becomes_output_text() {
    let RewrittenRequest { body, .. } = rewrite_request(&json!({"input": [
        {"type": "message", "role": "assistant", "content": [{"type": "refusal", "refusal": "I can't."}]},
    ]}));
    assert_eq!(
        body["input"][0]["content"],
        json!([{"type": "output_text", "text": "I can't.", "annotations": []}])
    );
}

// --- replies: every call gets its {namespace, name} back ---------------------------------------------------------

fn reply_names() -> ToolNames {
    names_of(json!([tarsee_ns(), func("exec_command")]))
}

fn call(name: &str) -> Value {
    json!({"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": name, "arguments": "{}", "status": "completed"})
}

#[test]
fn output_item_added_and_done_function_call_arguments_done_response_completed_and_a_whole_response() {
    let names = reply_names();
    let mut want = call("tarsee_calculator");
    want["namespace"] = json!("mcp__tarsee");
    assert_eq!(
        restore_item(&call("mcp__tarsee__tarsee_calculator"), &names),
        Some(want)
    );
    assert_eq!(
        restore_item(&call("exec_command"), &names),
        None,
        "a plain tool's call is left alone"
    );
    for ty in ["response.output_item.added", "response.output_item.done"] {
        let e = restore_event(
            &json!({"type": ty, "output_index": 0, "item": call("mcp__tarsee__tarsee_datetime")}),
            &names,
        )
        .unwrap();
        assert_eq!(e["item"]["name"], "tarsee_datetime");
        assert_eq!(e["item"]["namespace"], "mcp__tarsee");
    }
    let args = restore_event(
        &json!({"type": "response.function_call_arguments.done", "item_id": "fc_1", "name": "mcp__tarsee__tarsee_datetime", "arguments": "{}"}),
        &names,
    )
    .unwrap();
    assert_eq!(args["name"], "tarsee_datetime");
    let done = restore_event(
        &json!({"type": "response.completed", "response": {"id": "r", "output": [call("mcp__tarsee__tarsee_calculator"), {"type": "message", "content": []}]}}),
        &names,
    )
    .unwrap();
    assert_eq!(done["response"]["output"][0]["namespace"], "mcp__tarsee");
    assert_eq!(done["response"]["output"][0]["name"], "tarsee_calculator");
    let whole = restore_event(
        &json!({"id": "r", "object": "response", "output": [call("mcp__tarsee__tarsee_calculator")]}),
        &names,
    )
    .unwrap();
    assert_eq!(whole["output"][0]["name"], "tarsee_calculator");
    let text = json!({"type": "response.output_text.delta", "delta": "hi"});
    assert_eq!(
        restore_event(&text, &names),
        None,
        "anything else is the very same object"
    );
}

#[test]
fn an_sse_event_split_across_network_chunks_is_rewritten_once_it_is_whole_untouched_frames_pass_exactly_as_they_came() {
    let mut sse = create_sse_rewriter(reply_names());
    let created = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_9\"}}\n\n";
    let item = format!(
        "data: {}\r\n\r\n",
        json!({"type": "response.output_item.done", "output_index": 0, "item": call("mcp__tarsee__tarsee_calculator")})
    );
    let mut out = sse.push(&created[..20]);
    assert_eq!(out, "", "half a frame waits");
    out += &sse.push(&format!("{}{}", &created[20..], &item[..31]));
    assert_eq!(out, created, "the whole first frame, as it was");
    out += &sse.push(&item[31..70]);
    out += &sse.push(&item[70..]);
    out += &sse.end();
    let last: Value = serde_json::from_str(out[created.len()..].strip_prefix("data: ").unwrap()).unwrap();
    assert_eq!(last["item"]["name"], "tarsee_calculator");
    assert_eq!(last["item"]["namespace"], "mcp__tarsee");
    assert!(
        !out[created.len()..].contains("event:"),
        "no event line added where the server sent none (llama-server's done events)"
    );
}

#[test]
fn a_bare_mid_stream_error_frame_llama_servers_becomes_response_failed_with_the_servers_words() {
    let mut sse = create_sse_rewriter(reply_names());
    sse.push("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_5\"}}\n\n");
    let out =
        sse.push("data: {\"error\":{\"code\":500,\"message\":\"the model crashed\",\"type\":\"server_error\"}}\n\n");
    assert!(out.starts_with("event: response.failed\ndata: "), "{out}");
    let e: Value = serde_json::from_str(&out.split('\n').nth(1).unwrap()[6..]).unwrap();
    assert_eq!(e["type"], "response.failed");
    assert_eq!(e["response"]["id"], "resp_5");
    assert_eq!(e["response"]["status"], "failed");
    assert_eq!(e["response"]["error"]["message"], "the model crashed");
    assert_eq!(e["response"]["error"]["code"], "server_error");
    let full = create_sse_rewriter(reply_names()).push("data: {\"error\":{\"code\":400,\"message\":\"request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it\",\"type\":\"exceed_context_size_error\"}}\n\n");
    let full: Value = serde_json::from_str(&full.split('\n').nth(1).unwrap()[6..]).unwrap();
    assert_eq!(
        full["response"]["error"]["code"], "context_length_exceeded",
        "Codex's own code for a full context: no retry"
    );
    let done = create_sse_rewriter(reply_names()).push("data: [DONE]\n\n");
    assert_eq!(done, "data: [DONE]\n\n");
}

// --- the bridge server -------------------------------------------------------------------------------------------

/// The owner's key: a fake.
const OWNER_KEY: &str = "sk-test-canary-owner-local-key";
/// Where the owner's server is, as far as the stubbed client knows (it is never reached).
const OWNER: &str = "http://owner.test:11434/v1";

async fn bridge_with(fetch: Arc<dyn Fetch>) -> LocalBridge {
    start_local_bridge(BridgeOptions::new(fetch))
        .await
        .expect("the bridge starts")
}

/// The Codex side: the real HTTP client, talking to the bridge on loopback.
fn codex() -> ReqwestFetch {
    crate::net::install_crypto_provider();
    ReqwestFetch::new()
}

async fn get_with(url: &str, token: Option<&str>) -> FetchResponse {
    let mut request = FetchRequest::get(url);
    if let Some(token) = token {
        request = request.bearer(token);
    }
    codex().fetch(request).await.expect("the bridge answers")
}

async fn post(turn: &BridgeTurn, body: &Value) -> FetchResponse {
    codex()
        .fetch(
            FetchRequest::post(format!("{}/responses", turn.url))
                .bearer(&turn.token)
                .json(body),
        )
        .await
        .expect("the bridge answers")
}

#[tokio::test]
async fn needs_the_turn_named_in_the_path_and_its_token_as_the_bearer_header_a_released_turns_address_stops_working() {
    let fake = FakeFetch::new();
    fake.respond(OWNER, Answer::json(200, json!({"object": "list", "data": []})));
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, Some(OWNER_KEY)).unwrap();
    let other = bridge.open(OWNER, None).unwrap();
    assert!(
        Regex::new(r"^http://127\.0\.0\.1:[0-9]+/t/[A-Za-z0-9_-]{16,}/v1$")
            .unwrap()
            .is_match(&t.url),
        "{}",
        t.url
    );
    assert!(
        !t.url.contains(&t.token),
        "the token is never in the address (Codex's command line carries the address)"
    );
    assert!(Regex::new("^[A-Za-z0-9_-]{40,}$").unwrap().is_match(&t.token));
    let models = format!("{}/models", t.url);
    assert_eq!(get_with(&models, None).await.status, 401, "no header");
    assert_eq!(
        get_with(&models, Some(&other.token)).await.status,
        401,
        "another turn's token"
    );
    assert_eq!(
        get_with(&format!("{}/models", other.url), Some(&t.token)).await.status,
        401,
        "this token on another turn's address"
    );
    assert_eq!(
        get_with(&models, Some(OWNER_KEY)).await.status,
        401,
        "the owner's key itself is no way in"
    );
    let made_up = format!("{}/models", t.url.replace(&t.id, &"x".repeat(22)));
    assert_eq!(get_with(&made_up, Some(&t.token)).await.status, 401, "a made-up turn");
    assert!(fake.calls().is_empty(), "nothing refused reached the owner's server");
    let ok = get_with(&models, Some(&t.token)).await;
    assert_eq!(ok.status, 200);
    assert_eq!(
        fake.calls()[0].url,
        format!("{OWNER}/models"),
        "any other path is passed on as it is"
    );
    t.release();
    t.release();
    assert_eq!(get_with(&models, Some(&t.token)).await.status, 401, "released");
    other.release();
    assert_eq!(bridge.turns(), 0);
    bridge.close().await;
}

fn streamed_frames() -> String {
    let frames = [
        json!({"type": "response.created", "response": {"id": "resp_1"}}),
        json!({"type": "response.output_item.added", "output_index": 0, "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "mcp__tarsee__tarsee_calculator", "arguments": ""}}),
        json!({"type": "response.output_item.done", "output_index": 0, "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "mcp__tarsee__tarsee_calculator", "arguments": "{\"expression\":\"6*7\"}", "status": "completed"}}),
        json!({"type": "response.completed", "response": {"id": "resp_1", "status": "completed", "output": [{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "mcp__tarsee__tarsee_calculator", "arguments": "{\"expression\":\"6*7\"}"}]}}),
    ];
    frames
        .iter()
        .map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), js_stringify(e)))
        .collect()
}

/// The frames as `JSON.parse` would read them out of the reply text.
fn frames_of(text: &str) -> Vec<Value> {
    text.split("\n\n")
        .filter(|f| !f.is_empty())
        .map(|f| serde_json::from_str(&f.split('\n').find(|l| l.starts_with("data: ")).unwrap()[6..]).unwrap())
        .collect()
}

#[tokio::test]
async fn the_owners_key_goes_to_the_owners_server_the_turns_token_never_does_tools_go_flat_calls_come_back_namespaced_streamed()
 {
    let fake = FakeFetch::new();
    // In small pieces, so frames arrive split across chunks.
    let pieces: Vec<String> = streamed_frames()
        .as_bytes()
        .chunks(37)
        .map(|c| String::from_utf8(c.to_vec()).unwrap())
        .collect();
    fake.respond(OWNER, Answer::sse(pieces));
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, Some(OWNER_KEY)).unwrap();
    let res = post(&t, &json!({"model": "spark-4b", "stream": true, "tools": [func("exec_command"), tarsee_ns()], "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "6*7?"}]}]})).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("content-type"), Some("text/event-stream"));
    assert_eq!(res.header("cache-control"), Some("no-cache"));
    let text = res.text().await.unwrap();
    t.release();
    let seen = &fake.calls()[0];
    assert_eq!(seen.url, format!("{OWNER}/responses"));
    assert_eq!(
        seen.header("authorization").map(str::to_string),
        Some(format!("Bearer {OWNER_KEY}"))
    );
    assert!(
        !format!("{seen:?}").contains(&t.token),
        "the turn's token stays between Codex and the bridge"
    );
    let sent = seen.json();
    let tool_names: Vec<&str> = sent["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        tool_names,
        [
            "exec_command",
            "mcp__tarsee__tarsee_calculator",
            "mcp__tarsee__tarsee_datetime"
        ]
    );
    assert!(
        sent["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|x| x["type"] == "function"),
        "no namespace tool reaches the server"
    );
    let events = frames_of(&text);
    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        [
            "response.created",
            "response.output_item.added",
            "response.output_item.done",
            "response.completed"
        ]
    );
    for e in [
        &events[1]["item"],
        &events[2]["item"],
        &events[3]["response"]["output"][0],
    ] {
        assert_eq!(e["name"], "tarsee_calculator");
        assert_eq!(e["namespace"], "mcp__tarsee");
    }
    bridge.close().await;
}

#[tokio::test]
async fn a_server_with_no_key_gets_no_authorization_at_all_a_reply_that_isnt_streamed_is_mapped_back_too() {
    let fake = FakeFetch::new();
    fake.respond(
        OWNER,
        Answer::json(200, json!({"id": "resp_2", "object": "response", "status": "completed", "output": [{"type": "function_call", "call_id": "c", "name": "mcp__tarsee__tarsee_datetime", "arguments": "{}"}]})),
    );
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(&format!("{OWNER}/"), None).unwrap();
    let res = post(&t, &json!({"model": "m", "tools": [tarsee_ns()], "input": []})).await;
    let body = res.json().await.unwrap();
    t.release();
    assert_eq!(fake.calls()[0].header("authorization"), None);
    assert_eq!(
        fake.calls()[0].url,
        format!("{OWNER}/responses"),
        "one trailing slash on the address changes nothing"
    );
    assert_eq!(
        (&body["output"][0]["namespace"], &body["output"][0]["name"]),
        (&json!("mcp__tarsee"), &json!("tarsee_datetime"))
    );
    bridge.close().await;
}

#[tokio::test]
async fn an_http_error_comes_back_unchanged_a_bare_error_frame_mid_stream_becomes_response_failed() {
    let fake = FakeFetch::new();
    let error = "{\"error\":{\"code\":400,\"message\":\"request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it\",\"type\":\"exceed_context_size_error\"}}";
    fake.respond(OWNER, Answer::bytes(400, "application/json", error));
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, Some(OWNER_KEY)).unwrap();
    let bad = post(&t, &json!({"model": "m", "input": []})).await;
    assert_eq!(bad.status, 400);
    assert_eq!(bad.text().await.unwrap(), error);
    fake.respond(
        OWNER,
        Answer::sse(["event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_3\"}}\n\ndata: {\"error\":{\"code\":500,\"message\":\"Failed to parse the tool call\",\"type\":\"server_error\"}}\n\n"]),
    );
    let mid = post(&t, &json!({"model": "m", "stream": true, "input": []}))
        .await
        .text()
        .await
        .unwrap();
    t.release();
    assert!(
        Regex::new(r#"event: response\.failed\ndata: \{"type":"response\.failed".*Failed to parse the tool call"#)
            .unwrap()
            .is_match(&mid),
        "{mid}"
    );
    bridge.close().await;
}

/// The owner's server for the tests that need a body that never ends: one piece, then nothing. `gone` fires when
/// the body is dropped (the request to the owner's server stopped).
struct HangingUpstream {
    first: &'static str,
    gone: Mutex<Option<oneshot::Sender<()>>>,
}

impl HangingUpstream {
    fn new(first: &'static str, gone: oneshot::Sender<()>) -> Arc<Self> {
        Arc::new(HangingUpstream {
            first,
            gone: Mutex::new(Some(gone)),
        })
    }
}

struct FireOnDrop(Option<oneshot::Sender<()>>);

impl Drop for FireOnDrop {
    fn drop(&mut self) {
        if let Some(gone) = self.0.take() {
            let _ = gone.send(());
        }
    }
}

#[async_trait]
impl Fetch for HangingUpstream {
    async fn fetch(&self, _request: FetchRequest) -> Result<FetchResponse, FetchError> {
        let guard = FireOnDrop(self.gone.lock().take());
        let first = self.first;
        let body = stream::once(async move { Ok(Bytes::from(first)) })
            .chain(stream::pending())
            .map(move |chunk| {
                let _ = &guard;
                chunk
            })
            .boxed();
        Ok(FetchResponse::from_stream(
            200,
            vec![(
                "content-type".into(),
                if self.first.starts_with('{') {
                    "application/json"
                } else {
                    "text/event-stream"
                }
                .into(),
            )],
            body,
        ))
    }
}

/// The owner's server that never answers at all. `asked` fires when the request reaches it, `gone` when the bridge
/// gives up on it.
struct Unanswering {
    asked: Arc<tokio::sync::Notify>,
    gone: Mutex<Option<oneshot::Sender<()>>>,
}

#[async_trait]
impl Fetch for Unanswering {
    async fn fetch(&self, _request: FetchRequest) -> Result<FetchResponse, FetchError> {
        let _guard = FireOnDrop(self.gone.lock().take());
        self.asked.notify_one();
        futures::future::pending().await
    }
}

#[tokio::test]
async fn releasing_a_turn_while_its_request_waits_for_the_owners_server_cuts_it_with_no_answer() {
    let asked = Arc::new(tokio::sync::Notify::new());
    let (gone_tx, gone_rx) = oneshot::channel();
    let bridge = bridge_with(Arc::new(Unanswering {
        asked: asked.clone(),
        gone: Mutex::new(Some(gone_tx)),
    }))
    .await;
    let t = bridge.open(OWNER, None).unwrap();
    let request = FetchRequest::post(format!("{}/responses", t.url))
        .bearer(&t.token)
        .body("{}");
    let pending = tokio::spawn(async move { codex().fetch(request).await });
    asked.notified().await;
    t.release();
    let answer = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .expect("cut, not left waiting")
        .unwrap();
    assert!(answer.is_err(), "no answer at all: {answer:?}");
    assert!(
        tokio::time::timeout(Duration::from_secs(5), gone_rx).await.is_ok(),
        "the owner's request stopped"
    );
    bridge.close().await;
}

#[tokio::test]
async fn an_answer_passed_through_as_it_came_is_cut_too_when_its_turn_is_released() {
    let (gone_tx, gone_rx) = oneshot::channel();
    let bridge = bridge_with(HangingUpstream::new("{\"partial\": ", gone_tx)).await;
    let t = bridge.open(OWNER, None).unwrap();
    let res = post(&t, &json!({"model": "m", "input": []})).await;
    assert_eq!(res.header("content-type"), Some("application/json"));
    let mut body = res.into_stream();
    assert_eq!(body.next().await.unwrap().unwrap(), Bytes::from("{\"partial\": "));
    t.release();
    let rest = tokio::time::timeout(Duration::from_secs(5), body.next())
        .await
        .expect("the stream ends");
    assert!(matches!(rest, Some(Err(_))), "cut, not ended cleanly: {rest:?}");
    assert!(
        tokio::time::timeout(Duration::from_secs(5), gone_rx).await.is_ok(),
        "the owner's request stopped"
    );
    bridge.close().await;
}

#[tokio::test]
async fn when_codex_hangs_up_the_request_to_the_owners_server_is_stopped() {
    let (gone_tx, gone_rx) = oneshot::channel();
    let upstream = Arc::new(HangingUpstream {
        first: "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n",
        gone: Mutex::new(Some(gone_tx)),
    });
    let bridge = bridge_with(upstream).await;
    let t = bridge.open(OWNER, Some(OWNER_KEY)).unwrap();
    let res = post(
        &t,
        &json!({"model": "m", "stream": true, "tools": [tarsee_ns()], "input": []}),
    )
    .await;
    let mut body = res.into_stream();
    let first = body.next().await.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&first).contains("response.created"));
    drop(body);
    let stopped = tokio::time::timeout(Duration::from_secs(5), gone_rx).await;
    t.release();
    assert!(
        matches!(stopped, Ok(Ok(()))),
        "the owner's server saw the request end before its answer did"
    );
    bridge.close().await;
}

/// A 502 from a bridge that reaches the owner's server with the real HTTP client: what Codex gets for each way the
/// owner's server can't be reached.
async fn unreachable_owner_says(upstream: &str) -> String {
    crate::net::install_crypto_provider();
    let bridge = bridge_with(Arc::new(ReqwestFetch::new())).await;
    let t = bridge.open(upstream, Some(OWNER_KEY)).unwrap();
    let res = post(&t, &json!({"model": "m", "input": []})).await;
    t.release();
    assert_eq!(res.status, 502);
    assert_eq!(res.header("content-type"), Some("application/json"));
    let words = res.text().await.unwrap();
    assert!(
        !words.contains(&t.token) && !words.contains(OWNER_KEY) && !words.contains(&t.id),
        "{words}"
    );
    bridge.close().await;
    words
}

#[tokio::test]
async fn an_owners_server_that_isnt_there_is_a_502_that_names_the_owners_address_never_the_bridges_token() {
    // A port that was just free: bind one, note it, and let it go (the real client, as local_bridge(&app) uses).
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let upstream = format!("http://127.0.0.1:{port}/v1");
    assert_eq!(
        unreachable_owner_says(&upstream).await,
        format!(
            "{{\"error\":{{\"message\":\"Can't reach your Local AI at {upstream} (connection refused).\",\"type\":\"server_error\",\"code\":\"local_ai_unreachable\"}}}}"
        )
    );
}

#[tokio::test]
async fn an_owners_server_whose_name_is_not_known_is_a_502_that_says_so() {
    // The .invalid top-level name never resolves (RFC 2606), with or without a network.
    assert_eq!(
        unreachable_owner_says("http://tarsee-test.invalid/v1").await,
        "{\"error\":{\"message\":\"Can't reach your Local AI at http://tarsee-test.invalid/v1 (the name isn't known).\",\"type\":\"server_error\",\"code\":\"local_ai_unreachable\"}}"
    );
}

#[tokio::test]
async fn refuses_an_address_that_isnt_plain_http_s_and_a_key_with_a_line_break() {
    let bridge = bridge_with(FakeFetch::new()).await;
    let refusal = |upstream: &str, key: Option<&str>| bridge.open(upstream, key).map(|_| ()).unwrap_err().0;
    assert_eq!(
        refusal("ftp://x/v1", None),
        "local-bridge: the Local AI address must be a plain http(s) URL"
    );
    assert_eq!(
        refusal("http://user:pw@x/v1", None),
        "local-bridge: the Local AI address must be a plain http(s) URL"
    );
    assert_eq!(
        refusal("not a url", None),
        "local-bridge: the Local AI address must be a plain http(s) URL"
    );
    assert_eq!(
        refusal(OWNER, Some("a\nb")),
        "local-bridge: the key has a line break in it"
    );
    assert_eq!(bridge.turns(), 0);
    bridge.close().await;
}

#[tokio::test]
async fn a_turns_token_works_no_longer_than_its_time() {
    let now = Arc::new(AtomicI64::new(1_000));
    let clock = now.clone();
    let fake = FakeFetch::new();
    fake.respond(OWNER, Answer::json(200, json!({})));
    let b = start_local_bridge(BridgeOptions {
        now: Some(Arc::new(move || clock.load(Ordering::SeqCst))),
        max_turn_ms: 60_000,
        ..BridgeOptions::new(fake)
    })
    .await
    .unwrap();
    let t = b.open(OWNER, None).unwrap();
    let models = format!("{}/models", t.url);
    assert_eq!(get_with(&models, Some(&t.token)).await.status, 200);
    now.fetch_add(60_000, Ordering::SeqCst);
    assert_eq!(
        get_with(&models, Some(&t.token)).await.status,
        200,
        "still its time to the very millisecond"
    );
    now.fetch_add(1, Ordering::SeqCst);
    assert_eq!(get_with(&models, Some(&t.token)).await.status, 401);
    assert_eq!(b.turns(), 0, "an expired turn is closed when it is looked up");
    b.close().await;
}

// --- redactBridgeUrls --------------------------------------------------------------------------------------------

#[test]
fn blanks_a_bridge_addresss_turn_out_of_words_that_may_be_shown_or_logged() {
    let id = "abcdefghijklmnopqrstuv";
    assert_eq!(
        redact_bridge_urls(&format!(
            "error sending request for url (http://127.0.0.1:5555/t/{id}/v1/responses)"
        )),
        "error sending request for url (http://127.0.0.1:5555/t/…/v1/responses)"
    );
    assert_eq!(
        redact_bridge_urls("http://localhost:9931/v1/responses"),
        "http://localhost:9931/v1/responses"
    );
}

// --- The Node code's answers -------------------------------------------------------------------------------------

fn expected_names(v: &Value) -> ToolNames {
    let by_flat = v["byFlat"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e[0].as_str().unwrap().to_string(),
                OriginalName {
                    namespace: e[1].get("namespace").cloned(),
                    name: e[1]["name"].as_str().unwrap().to_string(),
                },
            )
        })
        .collect();
    let by_pair = v["byPair"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e[0].as_str().unwrap().to_string(), e[1].as_str().unwrap().to_string()))
        .collect();
    ToolNames { by_flat, by_pair }
}

#[test]
fn node_flat_names_and_their_hashed_forms_for_names_already_taken() {
    let cases = node_cases();
    for case in cases["flatName"].as_array().unwrap() {
        let (ns, name) = (case["namespace"].as_str().unwrap(), case["name"].as_str().unwrap());
        assert_eq!(flat_name(ns, name, None), case["plain"].as_str().unwrap(), "{case}");
        let mut taken = HashSet::new();
        for want in case["seq"].as_array().unwrap() {
            let got = flat_name(ns, name, Some(&taken));
            assert_eq!(got, want.as_str().unwrap(), "{case}");
            taken.insert(got);
        }
    }
}

#[test]
fn node_flatten_tools() {
    let cases = node_cases();
    for case in cases["flattenTools"].as_array().unwrap() {
        let input = &case["input"];
        let got = flatten_tools(if input.is_null() { None } else { Some(input) });
        assert_eq!(
            js_stringify(&Value::Array(got.tools)),
            js_stringify(&case["tools"]),
            "{input}"
        );
        assert_eq!(got.names, expected_names(&case["names"]), "{input}");
    }
}

#[test]
fn node_rewrite_request() {
    let cases = node_cases();
    for case in cases["rewriteRequest"].as_array().unwrap() {
        let got = rewrite_request(&case["input"]);
        assert_eq!(
            js_stringify(&got.body),
            js_stringify(&case["body"]),
            "{}",
            case["input"]
        );
        assert_eq!(got.names, expected_names(&case["names"]), "{}", case["input"]);
    }
}

#[test]
fn node_restore_event() {
    let cases = node_cases();
    let tool_sets = cases["toolSets"].as_array().unwrap().clone();
    for case in cases["restoreEvent"].as_array().unwrap() {
        let names = names_of(tool_sets[case["tools"].as_u64().unwrap() as usize].clone());
        let got = restore_event(&case["event"], &names);
        if case["same"] == true {
            assert_eq!(got, None, "{case}");
        } else {
            assert_eq!(
                js_stringify(&got.expect("changed")),
                js_stringify(&case["out"]),
                "{case}"
            );
        }
    }
}

#[test]
fn node_sse_rewriter_frame_by_frame() {
    let cases = node_cases();
    let tool_sets = cases["toolSets"].as_array().unwrap().clone();
    for case in cases["sse"].as_array().unwrap() {
        let mut sse = create_sse_rewriter(names_of(tool_sets[case["tools"].as_u64().unwrap() as usize].clone()));
        let mut got: Vec<String> = case["pushes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| sse.push(p.as_str().unwrap()))
            .collect();
        got.push(sse.end());
        let want: Vec<&str> = case["outs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o.as_str().unwrap())
            .collect();
        assert_eq!(got, want, "{}", case["pushes"]);
    }
}

#[test]
fn node_redact_bridge_urls() {
    let cases = node_cases();
    for case in cases["redact"].as_array().unwrap() {
        assert_eq!(
            redact_bridge_urls(case[0].as_str().unwrap()),
            case[1].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn node_request_bodies_are_written_back_as_json_stringify_writes_them() {
    let cases = node_cases();
    for case in cases["restringify"].as_array().unwrap() {
        let parsed: Value = serde_json::from_str(case[0].as_str().unwrap()).unwrap();
        assert_eq!(
            js_stringify(&rewrite_request(&parsed).body),
            case[1].as_str().unwrap(),
            "{case}"
        );
    }
}

// --- More than the Node tests checked ----------------------------------------------------------------------------

#[test]
fn text_cut_in_the_middle_of_a_character_waits_for_its_end() {
    let text = "Grüße 🐒 — ok";
    let bytes = text.as_bytes();
    for cut in 0..=bytes.len() {
        let mut decoder = Utf8Decoder::default();
        let joined =
            decoder.decode(&bytes[..cut], true) + &decoder.decode(&bytes[cut..], true) + &decoder.decode(&[], false);
        assert_eq!(joined, text, "cut at {cut}");
    }
    // Bytes that are not UTF-8 are U+FFFD, as TextDecoder makes them; an unfinished character at the very end too.
    let mut decoder = Utf8Decoder::default();
    assert_eq!(decoder.decode(b"a\xff\xc3", true), "a\u{FFFD}");
    assert_eq!(decoder.decode(b"", false), "\u{FFFD}");
    let mut decoder = Utf8Decoder::default();
    assert_eq!(
        decoder.decode(b"\xf0\x80b\xed\xa0\x80", false),
        "\u{FFFD}\u{FFFD}b\u{FFFD}\u{FFFD}\u{FFFD}"
    );
}

#[test]
fn an_sse_frame_rewritten_whatever_the_cut_mid_line_or_mid_character() {
    let call = json!({"type": "response.output_item.done", "output_index": 0, "item": {"type": "function_call", "call_id": "c", "name": "mcp__tarsee__tarsee_calculator", "arguments": "{\"q\":\"Grüße 🐒\"}"}});
    let stream = format!(
        "event: response.output_text.delta\ndata: {{\"type\":\"response.output_text.delta\",\"delta\":\"é🐒\"}}\n\nevent: response.output_item.done\ndata: {}\r\n\r\n",
        js_stringify(&call)
    );
    let mut whole = create_sse_rewriter(reply_names());
    let want = whole.push(&stream) + &whole.end();
    assert!(want.contains("\"namespace\":\"mcp__tarsee\""), "{want}");
    let bytes = stream.as_bytes();
    for a in 0..bytes.len() {
        for b in [a + 1, a + 7, bytes.len()] {
            let b = b.min(bytes.len());
            let mut decoder = Utf8Decoder::default();
            let mut sse = create_sse_rewriter(reply_names());
            let mut got = String::new();
            for piece in [&bytes[..a], &bytes[a..b], &bytes[b..]] {
                got += &sse.push(&decoder.decode(piece, true));
            }
            got += &sse.push(&decoder.decode(&[], false));
            got += &sse.end();
            assert_eq!(got, want, "cut at {a} and {b}");
        }
    }
}

#[tokio::test]
async fn through_the_server_a_stream_cut_mid_line_and_mid_character_comes_out_whole_and_mapped_back() {
    let frames = format!(
        "event: response.output_text.delta\ndata: {{\"type\":\"response.output_text.delta\",\"delta\":\"Grüße 🐒\"}}\n\n{}",
        streamed_frames()
    );
    // Every byte its own piece: each frame, each line and each character arrives cut.
    let chunks: Vec<Bytes> = frames
        .as_bytes()
        .iter()
        .map(|b| Bytes::copy_from_slice(&[*b]))
        .collect();
    let fake = FakeFetch::new();
    fake.respond(
        OWNER,
        Answer::Response {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream; charset=utf-8".into())],
            chunks,
        },
    );
    let bridge = bridge_with(fake).await;
    let t = bridge.open(OWNER, None).unwrap();
    let text = post(
        &t,
        &json!({"model": "m", "stream": true, "tools": [tarsee_ns()], "input": []}),
    )
    .await
    .text()
    .await
    .unwrap();
    let events = frames_of(&text);
    assert_eq!(events[0]["delta"], "Grüße 🐒");
    assert_eq!(events[4]["response"]["output"][0]["namespace"], "mcp__tarsee");
    assert_eq!(events[4]["response"]["output"][0]["name"], "tarsee_calculator");
    bridge.close().await;
}

#[tokio::test]
async fn a_stream_with_nothing_to_map_back_still_turns_a_bare_error_frame_into_response_failed() {
    let fake = FakeFetch::new();
    fake.respond(OWNER, Answer::sse(["data: {\"error\":\"out of memory\"}\n\n"]));
    let bridge = bridge_with(fake).await;
    let t = bridge.open(OWNER, None).unwrap();
    let text = post(&t, &json!({"model": "m", "stream": true, "input": []}))
        .await
        .text()
        .await
        .unwrap();
    assert_eq!(
        text,
        "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"id\":\"resp_local_bridge\",\"object\":\"response\",\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"out of memory\"},\"output\":[]}}\n\n"
    );
    bridge.close().await;
}

/// A request written on a socket by hand, and everything the bridge answers until it closes the connection.
async fn raw_request(port: u16, request: &[u8]) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket.write_all(request).await.unwrap();
    let mut answer = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), socket.read_to_end(&mut answer))
        .await
        .expect("the bridge closes the connection")
        .ok();
    String::from_utf8_lossy(&answer).into_owned()
}

#[tokio::test]
async fn what_nodes_http_server_refused_itself_headers_of_16_kib_and_an_http_1_1_request_with_no_host() {
    let fake = FakeFetch::new();
    fake.respond(OWNER, Answer::json(200, json!({"data": []})));
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, None).unwrap();
    let target = format!(
        "{}/models",
        t.url.trim_start_matches(&format!("http://127.0.0.1:{}", bridge.port()))
    );
    // Node counts the target and every header's name and value: refused from 16,384 bytes on.
    let counted = |pad: usize| {
        target.len()
            + "host".len()
            + 1
            + "authorization".len()
            + "Bearer ".len()
            + t.token.len()
            + "connection".len()
            + "close".len()
            + "x-pad".len()
            + pad
    };
    let pad = 16_384 - counted(0);
    let with_pad = |pad: usize| {
        format!(
            "GET {target} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {}\r\nConnection: close\r\nX-Pad: {}\r\n\r\n",
            t.token,
            "p".repeat(pad)
        )
    };
    assert_eq!(counted(pad - 1), 16_383);
    let under = raw_request(bridge.port(), with_pad(pad - 1).as_bytes()).await;
    assert!(under.starts_with("HTTP/1.1 200 "), "{under}");
    let at = raw_request(bridge.port(), with_pad(pad).as_bytes()).await;
    assert!(
        at.starts_with("HTTP/1.1 431 Request Header Fields Too Large\r\n"),
        "{at}"
    );
    assert!(at.to_lowercase().contains("connection: close"), "{at}");
    let big = raw_request(bridge.port(), with_pad(20_000).as_bytes()).await;
    assert!(big.starts_with("HTTP/1.1 431 "), "{big}");
    // HTTP/1.1 needs a Host header; HTTP/1.0 does not.
    let no_host = format!("GET {target} HTTP/1.1\r\nAuthorization: Bearer {}\r\n\r\n", t.token);
    let refused = raw_request(bridge.port(), no_host.as_bytes()).await;
    assert!(refused.starts_with("HTTP/1.1 400 Bad Request\r\n"), "{refused}");
    assert!(refused.to_lowercase().contains("connection: close"), "{refused}");
    let old = format!("GET {target} HTTP/1.0\r\nAuthorization: Bearer {}\r\n\r\n", t.token);
    let served = raw_request(bridge.port(), old.as_bytes()).await;
    assert!(
        served.starts_with("HTTP/1.0 200 ") || served.starts_with("HTTP/1.1 200 "),
        "{served}"
    );
    assert_eq!(
        fake.calls().len(),
        2,
        "only the two requests Node served reached the owner's server"
    );
    bridge.close().await;
}

#[test]
fn a_byte_order_mark_at_the_very_start_of_a_stream_is_taken_off_as_text_decoder_does() {
    const BOM: &[u8] = b"\xEF\xBB\xBF";
    // At the start, even arriving a byte at a time.
    let mut decoder = Utf8Decoder::default();
    let mut text = String::new();
    for byte in [&BOM[..1], &BOM[1..2], &BOM[2..], b"a".as_slice(), BOM] {
        text += &decoder.decode(byte, true);
    }
    text += &decoder.decode(&[], false);
    assert_eq!(text, "a\u{FEFF}", "only the first one, at the very start");
    // Two at the start: the second one stays.
    let mut decoder = Utf8Decoder::default();
    assert_eq!(decoder.decode(b"\xEF\xBB\xBF\xEF\xBB\xBFa", false), "\u{FEFF}a");
    // A first character that is not one (here a bad byte): any later one stays.
    let mut decoder = Utf8Decoder::default();
    assert_eq!(decoder.decode(b"\xFF\xEF\xBB\xBFa", false), "\u{FFFD}\u{FEFF}a");
}

#[tokio::test]
async fn behind_a_byte_order_mark_a_bare_error_frame_still_fails_and_a_first_frame_keeps_its_event_line() {
    let bom_first = |rest: &str| {
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend_from_slice(rest.as_bytes());
        // A byte at a time, the mark cut in three.
        let chunks: Vec<Bytes> = bytes.iter().map(|b| Bytes::copy_from_slice(&[*b])).collect();
        Answer::Response {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            chunks,
        }
    };
    let fake = FakeFetch::new();
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, None).unwrap();
    // What the Node bridge answered for the same streams.
    fake.respond(OWNER, bom_first("data: {\"error\":\"out of memory\"}\n\n"));
    let failed = post(&t, &json!({"model": "m", "stream": true, "input": []}))
        .await
        .text()
        .await
        .unwrap();
    assert_eq!(
        failed,
        "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"id\":\"resp_local_bridge\",\"object\":\"response\",\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"out of memory\"},\"output\":[]}}\n\n"
    );
    let call = json!({"type": "response.output_item.done", "output_index": 0, "item": {"type": "function_call", "call_id": "c", "name": "mcp__tarsee__tarsee_calculator", "arguments": "{}"}});
    fake.respond(
        OWNER,
        bom_first(&format!(
            "event: response.output_item.done\ndata: {}\n\n",
            js_stringify(&call)
        )),
    );
    let mapped = post(
        &t,
        &json!({"model": "m", "stream": true, "tools": [tarsee_ns()], "input": []}),
    )
    .await
    .text()
    .await
    .unwrap();
    assert_eq!(
        mapped,
        "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c\",\"name\":\"tarsee_calculator\",\"arguments\":\"{}\",\"namespace\":\"mcp__tarsee\"}}\n\n"
    );
    bridge.close().await;
}

#[tokio::test]
async fn the_request_passed_on_its_headers_its_path_and_query_and_its_body_rewritten_as_json_stringify_writes_it() {
    let fake = FakeFetch::new();
    fake.respond(OWNER, Answer::json(200, json!({"ok": 1.0})).header("retry-after", "7"));
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, Some(&format!("  {OWNER_KEY}  "))).unwrap();
    let body = r#"{"model":"m","temperature":1.0,"seed":12345678901234567890,"tools":[{"type":"namespace","name":"mcp__tarsee","tools":[{"type":"function","name":"t"}]}],"input":[]}"#;
    let res = codex()
        .fetch(
            FetchRequest::post(format!("{}/responses?api-version=2&x=%20y", t.url))
                .bearer(&t.token)
                .header("content-type", "application/json")
                .header("x-custom", "a")
                .header("x-custom", "b")
                .header("user-agent", "codex_exec/0.167")
                .header("cookie", "a=1")
                .header("cookie", "b=2")
                .header("accept-encoding", "gzip")
                .header("proxy-authorization", "Basic nope")
                .body(body),
        )
        .await
        .unwrap();
    assert_eq!(res.status, 200);
    assert_eq!(res.header("retry-after"), Some("7"));
    assert_eq!(res.header("cache-control"), Some("no-cache"));
    assert_eq!(
        res.text().await.unwrap(),
        "{\"ok\":1}",
        "re-written as JSON.stringify writes it"
    );
    let seen = &fake.calls()[0];
    assert_eq!(seen.url, format!("{OWNER}/responses?api-version=2&x=%20y"));
    assert_eq!(seen.method, "POST");
    assert_eq!(
        seen.body,
        r#"{"model":"m","temperature":1,"seed":12345678901234567000,"tools":[{"type":"function","name":"mcp__tarsee__t"}],"input":[]}"#
    );
    assert_eq!(
        seen.header("content-length"),
        Some(seen.body.len().to_string().as_str())
    );
    assert_eq!(
        seen.header("authorization").map(str::to_string),
        Some(format!("Bearer {OWNER_KEY}")),
        "the owner's key, trimmed"
    );
    assert_eq!(seen.header("accept-encoding"), Some("identity"));
    assert_eq!(seen.header("x-custom"), Some("a, b"));
    assert_eq!(seen.header("cookie"), Some("a=1; b=2"));
    assert_eq!(seen.header("user-agent"), Some("codex_exec/0.167"));
    assert_eq!(seen.header("proxy-authorization"), None);
    assert_eq!(seen.header("host"), None);
    bridge.close().await;
}

#[tokio::test]
async fn a_body_that_is_not_json_or_is_encoded_goes_through_untouched_and_a_get_has_no_body() {
    let fake = FakeFetch::new();
    fake.respond(OWNER, Answer::text(200, "plain"));
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, None).unwrap();
    let client = codex();
    let send = |body: &'static str, encoding: Option<&'static str>| {
        let mut request = FetchRequest::post(format!("{}/responses", t.url))
            .bearer(&t.token)
            .body(body);
        if let Some(encoding) = encoding {
            request = request.header("content-encoding", encoding);
        }
        client.fetch(request)
    };
    assert_eq!(send("{not json", None).await.unwrap().text().await.unwrap(), "plain");
    send("{\"a\": 1.0}", Some("zstd")).await.unwrap();
    send("{\"a\": 1.0}", Some("identity")).await.unwrap();
    get_with(&format!("{}/models", t.url), Some(&t.token)).await;
    let calls = fake.calls();
    assert_eq!(calls[0].body, "{not json");
    assert_eq!(calls[1].body, "{\"a\": 1.0}", "an encoded body is not read");
    assert_eq!(calls[2].body, "{\"a\":1}", "identity is no encoding");
    assert_eq!(
        (
            calls[3].method.as_str(),
            calls[3].body.as_str(),
            calls[3].header("content-length")
        ),
        ("GET", "", None)
    );
    bridge.close().await;
}

#[tokio::test]
async fn paths_the_turn_does_not_serve_and_tokens_that_are_not_bearer_are_refused_with_the_same_words() {
    let fake = FakeFetch::new();
    fake.respond(OWNER, Answer::json(200, json!({})));
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, None).unwrap();
    let base = format!("http://127.0.0.1:{}", bridge.port());
    for (url, auth) in [
        (format!("{base}/"), format!("Bearer {}", t.token)),
        (format!("{base}/t/{}", "x".repeat(15)), format!("Bearer {}", t.token)),
        (
            format!("{base}/t/{}/v1/../../models", t.id),
            format!("Bearer {}", t.token),
        ),
        (format!("{base}/x/t/{}/v1/models", t.id), format!("Bearer {}", t.token)),
        (format!("{}/models", t.url), format!("Basic {}", t.token)),
        (format!("{}/models", t.url), format!("Bearer {} extra", t.token)),
        (format!("{}/models", t.url), "Bearer".to_string()),
    ] {
        let res = codex()
            .fetch(FetchRequest::get(&url).header("authorization", &auth))
            .await
            .unwrap();
        assert_eq!(res.status, 401, "{url} {auth}");
        assert_eq!(res.header("content-type"), Some("application/json"));
        assert_eq!(
            res.text().await.unwrap(),
            "{\"error\":{\"message\":\"This address is only for the Local AI turn it was made for.\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}"
        );
    }
    // Any case of "Bearer", and the turn's address without /v1: still the turn's.
    let res = codex()
        .fetch(
            FetchRequest::get(format!("{base}/t/{}/models", t.id))
                .header("authorization", format!("bEaReR   {}", t.token)),
        )
        .await
        .unwrap();
    assert_eq!(res.status, 200);
    assert_eq!(fake.calls()[0].url, format!("{OWNER}/models"));
    let res = codex()
        .fetch(FetchRequest::get(format!("{base}/t/{}/v1", t.id)).bearer(&t.token))
        .await
        .unwrap();
    assert_eq!(res.status, 200);
    assert_eq!(
        fake.calls()[1].url,
        OWNER,
        "the turn's own root is the server's address"
    );
    bridge.close().await;
}

#[tokio::test]
async fn releasing_a_turn_mid_answer_cuts_its_stream_and_closing_the_bridge_cuts_every_connection() {
    let (gone_tx, gone_rx) = oneshot::channel();
    let upstream = Arc::new(HangingUpstream {
        first: "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n",
        gone: Mutex::new(Some(gone_tx)),
    });
    let bridge = bridge_with(upstream).await;
    let t = bridge.open(OWNER, None).unwrap();
    let res = post(&t, &json!({"model": "m", "stream": true, "input": []})).await;
    let mut body = res.into_stream();
    assert!(body.next().await.unwrap().is_ok());
    t.release();
    let rest = tokio::time::timeout(Duration::from_secs(5), body.next())
        .await
        .expect("the stream ends");
    assert!(matches!(rest, Some(Err(_))), "cut, not ended cleanly: {rest:?}");
    assert!(
        tokio::time::timeout(Duration::from_secs(5), gone_rx).await.is_ok(),
        "the owner's request stopped"
    );

    // A request still waiting for the owner's server when the bridge closes: no answer at all.
    let waiting = Arc::new(tokio::sync::Notify::new());
    struct Never(Arc<tokio::sync::Notify>);
    #[async_trait]
    impl Fetch for Never {
        async fn fetch(&self, _request: FetchRequest) -> Result<FetchResponse, FetchError> {
            self.0.notify_one();
            futures::future::pending().await
        }
    }
    let bridge = bridge_with(Arc::new(Never(waiting.clone()))).await;
    let t = bridge.open(OWNER, None).unwrap();
    let request = FetchRequest::post(format!("{}/responses", t.url))
        .bearer(&t.token)
        .body("{}");
    let pending = tokio::spawn(async move { codex().fetch(request).await });
    waiting.notified().await;
    tokio::time::timeout(Duration::from_secs(5), bridge.close())
        .await
        .expect("close returns");
    let answer = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(answer.is_err(), "the connection was cut without an answer: {answer:?}");
}

#[tokio::test]
async fn a_body_bigger_than_64_mib_is_refused_after_it_is_read() {
    let fake = FakeFetch::new();
    let bridge = bridge_with(fake.clone()).await;
    let t = bridge.open(OWNER, None).unwrap();
    let big = vec![b'x'; MAX_BODY_BYTES + 1];
    let res = codex()
        .fetch(
            FetchRequest::post(format!("{}/responses", t.url))
                .bearer(&t.token)
                .body(big),
        )
        .await
        .unwrap();
    assert_eq!(res.status, 413);
    assert_eq!(
        res.text().await.unwrap(),
        "{\"error\":{\"message\":\"The request is too big for the Local AI bridge.\"}}"
    );
    assert!(fake.calls().is_empty());
    bridge.close().await;
}

#[tokio::test]
async fn the_apps_bridge_starts_once_and_reaches_the_owner_through_the_apps_http_client() {
    let t = crate::testkit::test_app();
    t.fetch.respond(OWNER, Answer::json(200, json!({"data": []})));
    let first = local_bridge(&t.app).await.unwrap();
    let second = local_bridge(&t.app).await.unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    let turn = first.open(OWNER, Some(OWNER_KEY)).unwrap();
    assert_eq!(
        get_with(&format!("{}/models", turn.url), Some(&turn.token))
            .await
            .status,
        200
    );
    assert_eq!(
        t.fetch.calls()[0].header("authorization").map(str::to_string),
        Some(format!("Bearer {OWNER_KEY}"))
    );
    drop(turn);
    assert_eq!(first.turns(), 0, "dropping a turn releases it");
}

#[test]
fn why_the_owners_server_could_not_be_reached_in_short_words() {
    // What the HTTP client reports, in Node's words (src/net/fetch.rs), and the bridge's words for each code
    // (reachWhy): a code with no words of its own is shown as it is.
    for (err, want) in [
        (FetchError::Timeout, "it took too long to answer"),
        (
            FetchError::Connect("connect ECONNREFUSED 127.0.0.1:9931".into()),
            "connection refused",
        ),
        (
            FetchError::Connect("getaddrinfo ENOTFOUND ollama.invalid".into()),
            "the name isn't known",
        ),
        (
            FetchError::Connect("getaddrinfo EAI_AGAIN ollama.lan".into()),
            "the name isn't known",
        ),
        (
            FetchError::Connect("read ECONNRESET".into()),
            "the connection was reset",
        ),
        (
            FetchError::Connect("connect ETIMEDOUT 10.0.0.9:11434".into()),
            "it took too long to answer",
        ),
        (
            FetchError::Connect("connect EHOSTUNREACH 10.0.0.9:11434".into()),
            "EHOSTUNREACH",
        ),
        (
            FetchError::Connect("connect ENETUNREACH 10.0.0.9:11434".into()),
            "ENETUNREACH",
        ),
        (
            FetchError::Connect("invalid peer certificate: UnknownIssuer".into()),
            "network error",
        ),
        (FetchError::Body("connection cut".into()), "network error"),
    ] {
        assert_eq!(reach_why(&err), want, "{err:?}");
    }
}

#[test]
fn json_stringify_numbers_and_strings() {
    let v: Value =
        serde_json::from_str("[1.0, 2.5, -0.0, 1e21, 1e-7, 9007199254740993, -9007199254740993, \"\\u2028\\u0000\"]")
            .unwrap();
    assert_eq!(
        js_stringify(&v),
        "[1,2.5,0,1e+21,1e-7,9007199254740992,-9007199254740992,\"\u{2028}\\u0000\"]"
    );
    // String(number): a whole double without ".0", a long one rounded as a double, an exponent as JavaScript writes it.
    let numbers: Value = serde_json::from_str("[2.0, -0.5, 1e21, 12345678901234567890, 1e-7]").unwrap();
    let texts: Vec<String> = numbers.as_array().unwrap().iter().map(js_string).collect();
    assert_eq!(texts, ["2", "-0.5", "1e+21", "12345678901234567000", "1e-7"]);
    assert_eq!(js_string(&numbers), "2,-0.5,1e+21,12345678901234567000,1e-7");
    assert_eq!(tpl(None), "undefined");
    assert_eq!(tpl(Some(&json!([1, null, "a"]))), "1,,a");
    assert_eq!(str_or_empty(Some(&Value::Null)), "");
}
