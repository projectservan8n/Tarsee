//! Tests of the loopback MCP endpoint.
//!
//! Port of `test/mcp-http.test.js`, which drove the Node endpoint with the MCP SDK's own client and with raw HTTP
//! requests. There is no SDK here, so every request is raw (one HTTP/1.1 request on a socket, written by hand, so a
//! test can set what a real client never would: a foreign Host, an Origin, a huge body), and the tools behind the
//! endpoint are `testkit::FakeTools` until `lib/tools.rs` (package S3) is merged. The case with Codex's own client
//! is in `tests/it/mcp_http.rs`.
//!
//! On top of the Node cases: every answer the Node endpoint gave to 300 requests (`node-endpoint.json`, made by
//! `docs/rust-port/reports/S4-capture-endpoint.mjs.txt`) is asked of this endpoint and compared, and a long result
//! is saved and cut as the Node endpoint saved and cut it. Nothing leaves the machine; every token is made per
//! test.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use base64::Engine as _;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::lib::tool_api::{ToolExecutor, ToolOutput, install_tool_executor};
use crate::testkit::{CapturedLogs, FakeTools, TestApp, test_app};

/// What the Node endpoint answered (see the module's words).
const NODE_ENDPOINT: &str = include_str!("node-endpoint.json");
/// The `tools` of the Node server's `tools/list` answer.
const NODE_TOOLS: &str = include_str!("../tarsee_mcp/node-tools-list-UTC.json");

const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"raw","version":"1.0.0"}}}"#;
const LIST: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;

// --- A raw HTTP client ---------------------------------------------------------------------------------------------

/// One raw HTTP request to the endpoint.
#[derive(Clone)]
struct Raw {
    method: String,
    path: String,
    token: Option<String>,
    host: Option<String>,
    /// Sent as given (a value's characters as Latin-1 bytes); one named like a default replaces it.
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    accept: bool,
    content_type: bool,
    chunked: bool,
}

fn post(body: impl AsRef<[u8]>) -> Raw {
    Raw {
        method: "POST".into(),
        path: "/mcp".into(),
        token: None,
        host: None,
        headers: Vec::new(),
        body: Some(body.as_ref().to_vec()),
        accept: true,
        content_type: true,
        chunked: false,
    }
}

/// A request with no body.
fn bare(method: &str) -> Raw {
    Raw {
        method: method.into(),
        body: None,
        ..post("")
    }
}

impl Raw {
    fn token(mut self, token: &str) -> Self {
        self.token = Some(token.to_string());
        self
    }
    fn host(mut self, host: impl Into<String>) -> Self {
        self.host = Some(host.into());
        self
    }
    fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }
    fn path(mut self, path: &str) -> Self {
        self.path = path.to_string();
        self
    }

    fn bytes(&self, port: u16, close: bool) -> Vec<u8> {
        let given = |name: &str| self.headers.iter().any(|(known, _)| known.eq_ignore_ascii_case(name));
        let mut lines: Vec<(String, String)> = Vec::new();
        lines.push((
            "host".into(),
            self.host.clone().unwrap_or_else(|| format!("127.0.0.1:{port}")),
        ));
        if self.body.is_some() && self.content_type && !given("content-type") {
            lines.push(("content-type".into(), "application/json".into()));
        }
        if self.accept && !given("accept") {
            lines.push(("accept".into(), "application/json, text/event-stream".into()));
        }
        lines.extend(self.headers.iter().cloned());
        if let Some(token) = &self.token {
            lines.push(("authorization".into(), format!("Bearer {token}")));
        }
        match &self.body {
            Some(_) if self.chunked => lines.push(("transfer-encoding".into(), "chunked".into())),
            Some(body) => lines.push(("content-length".into(), body.len().to_string())),
            None => {}
        }
        if close {
            lines.push(("connection".into(), "close".into()));
        }
        let mut out = format!("{} {} HTTP/1.1\r\n", self.method, self.path).into_bytes();
        for (name, value) in lines {
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(b": ");
            out.extend(value.chars().map(|c| c as u8));
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"\r\n");
        if let Some(body) = &self.body {
            if self.chunked {
                // In two pieces, as a client that does not know the length ahead sends it.
                let (first, rest) = body.split_at(body.len().min(10));
                for piece in [first, rest].into_iter().filter(|piece| !piece.is_empty()) {
                    out.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
                    out.extend_from_slice(piece);
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(b"0\r\n\r\n");
            } else {
                out.extend_from_slice(body);
            }
        }
        out
    }
}

/// An answer, read whole.
#[derive(Debug, Clone)]
struct Reply {
    status: u16,
    /// Names in lower case.
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, value)| value.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    /// The text of a tool call's result.
    fn text(&self) -> String {
        self.json()["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }
}

/// A connection to the endpoint that is kept open between requests.
struct Conn {
    stream: TcpStream,
    port: u16,
}

impl Conn {
    async fn open(port: u16) -> Conn {
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        Conn { stream, port }
    }

    /// Sends one request and reads its answer. An endpoint that never answers fails the test: it does not hang it.
    async fn send(&mut self, raw: &Raw, close: bool) -> Reply {
        tokio::time::timeout(Duration::from_secs(60), self.exchange(raw, close))
            .await
            .unwrap_or_else(|_| panic!("no answer to {} {} within a minute", raw.method, raw.path))
    }

    async fn exchange(&mut self, raw: &Raw, close: bool) -> Reply {
        // The server may answer a refused upload before it has all of it; that answer is what the test wants.
        let _ = self.stream.write_all(&raw.bytes(self.port, close)).await;
        let mut seen: Vec<u8> = Vec::new();
        let head_end = loop {
            if let Some(at) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
                break at;
            }
            let mut chunk = [0u8; 8192];
            let n = self.stream.read(&mut chunk).await.unwrap();
            assert!(
                n > 0,
                "the connection closed before an answer: {:?}",
                String::from_utf8_lossy(&seen)
            );
            seen.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&seen[..head_end]).into_owned();
        let mut lines = head.split("\r\n");
        let status: u16 = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let headers: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_lowercase(), value.trim().to_string()))
            .collect();
        let mut body = seen[head_end + 4..].to_vec();
        let length = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| value.parse::<usize>().ok());
        if raw.method != "HEAD" {
            match length {
                Some(length) => {
                    while body.len() < length {
                        let mut chunk = [0u8; 8192];
                        let n = self.stream.read(&mut chunk).await.unwrap();
                        assert!(n > 0, "the answer was cut short");
                        body.extend_from_slice(&chunk[..n]);
                    }
                }
                None => {
                    self.stream.read_to_end(&mut body).await.unwrap();
                }
            }
        }
        Reply {
            status,
            headers,
            body: String::from_utf8_lossy(&body).into_owned(),
        }
    }
}

/// One request on a fresh connection (no keep-alive), so each request is seen as a new caller.
async fn send(port: u16, raw: Raw) -> Reply {
    Conn::open(port).await.send(&raw, true).await
}

// --- The endpoint under test ---------------------------------------------------------------------------------------

struct Up {
    t: TestApp,
    tools: Arc<FakeTools>,
    endpoint: EndpointInfo,
}

impl Up {
    fn port(&self) -> u16 {
        self.endpoint.port
    }

    /// A grant for a turn in this conversation.
    async fn grant(&self, conversation_id: &str) -> Grant {
        grant_turn(&self.t.app, ctx_for(conversation_id), GrantOptions::default())
            .await
            .unwrap()
    }

    /// Call one tool with the grant's token and give the answer.
    async fn call(&self, grant: &Grant, name: &str, args: Value) -> Reply {
        let body =
            json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": args}});
        send(self.port(), post(body.to_string()).token(&grant.token)).await
    }
}

async fn up() -> Up {
    let t = test_app();
    let tools = FakeTools::install(&t.app);
    let endpoint = start_mcp_http(&t.app, StartOptions::default()).await.unwrap();
    Up { t, tools, endpoint }
}

/// The tool context a turn would grant: a conversation id the tools record.
fn ctx_for(conversation_id: &str) -> ToolContext {
    ToolContext::for_conversation(conversation_id)
}

// --- test/mcp-http.test.js: the loopback endpoint ------------------------------------------------------------------

#[tokio::test]
async fn listens_on_127_0_0_1_on_a_port_the_system_picked_and_grants_point_at_its_mcp() {
    let up = up().await;
    assert_eq!(up.endpoint.host, "127.0.0.1");
    assert!(up.endpoint.port > 0);
    assert_eq!(up.endpoint.url, format!("http://127.0.0.1:{}/mcp", up.endpoint.port));
    let grant = up.grant("conv-url").await;
    assert_eq!(grant.url, format!("http://127.0.0.1:{}/mcp", up.endpoint.port));
    // The design's name for it is the same function.
    let other = grant_mcp(&up.t.app, ctx_for("conv-url"), GrantOptions::default())
        .await
        .unwrap();
    assert_eq!(other.url, grant.url);
    assert_eq!(send(up.port(), post(INIT).token(&other.token)).await.status, 200);
    // It listens on this machine's own address only.
    assert_eq!(McpHttp::of(&up.t.app).endpoint(), Some(up.endpoint.clone()));
}

#[tokio::test]
async fn gives_each_grant_its_own_32_byte_token() {
    let up = up().await;
    let a = up.grant("conv-a").await;
    let b = up.grant("conv-b").await;
    let decode = |token: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token).unwrap();
    assert_eq!(decode(&a.token).len(), 32);
    assert_eq!(decode(&b.token).len(), 32);
    assert_ne!(a.token, b.token);
    // The token must be safe in an environment variable.
    assert!(
        a.token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    );
    assert!(a.expires_at > crate::util::js::now_ms() + DEFAULT_GRANT_TTL_MS - 60_000);
}

#[tokio::test]
async fn starts_by_itself_when_a_turn_asks_for_a_grant_first_and_start_mcp_http_is_idempotent() {
    let t = test_app();
    FakeTools::install(&t.app);
    assert_eq!(McpHttp::of(&t.app).endpoint(), None);
    // (In the Node version the grant came as a promise before the endpoint listened and straight back after; here it
    // is awaited either way.)
    let grant = grant_turn(&t.app, ctx_for("conv-lazy"), GrantOptions::default())
        .await
        .unwrap();
    let endpoint = start_mcp_http(&t.app, StartOptions::default()).await.unwrap();
    assert_eq!(grant.url, format!("http://127.0.0.1:{}/mcp", endpoint.port));
    // A second start must not open a second port.
    assert_eq!(
        start_mcp_http(&t.app, StartOptions::default()).await.unwrap().port,
        endpoint.port
    );
    let listed = send(endpoint.port, post(LIST).token(&grant.token)).await;
    assert!(!listed.json()["result"]["tools"].as_array().unwrap().is_empty());

    // Stopped, the port is closed and every grant is over; the next grant starts it again.
    stop_mcp_http(&t.app).await;
    assert_eq!(McpHttp::of(&t.app).endpoint(), None);
    assert!(TcpStream::connect(("127.0.0.1", endpoint.port)).await.is_err());
    assert_eq!(grant_count(&t.app), 0);
    stop_mcp_http(&t.app).await;
    let later = grant_turn(&t.app, ctx_for("conv-lazy-2"), GrantOptions::default())
        .await
        .unwrap();
    let again = McpHttp::of(&t.app).endpoint().unwrap();
    assert_eq!(later.url, again.url);
    assert_eq!(send(again.port, post(INIT).token(&later.token)).await.status, 200);
    assert_eq!(send(again.port, post(INIT).token(&grant.token)).await.status, 401);
}

#[tokio::test]
async fn several_first_grants_at_once_share_one_server() {
    let t = test_app();
    FakeTools::install(&t.app);
    // Eight turns ask for their grant while the endpoint is still starting (the test holds the door a start goes
    // through, so all eight are waiting at it together).
    let service = McpHttp::of(&t.app);
    let door = service.starting.lock().await;
    let asking: Vec<_> = (0..8)
        .map(|i| {
            let app = t.app.clone();
            tokio::spawn(async move {
                grant_turn(&app, ctx_for(&format!("conv-{i}")), GrantOptions::default())
                    .await
                    .unwrap()
            })
        })
        .collect();
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(service.endpoint(), None);
    drop(door);
    let grants: Vec<Grant> = futures::future::join_all(asking)
        .await
        .into_iter()
        .map(Result::unwrap)
        .collect();
    let url = &grants[0].url;
    assert!(
        grants.iter().all(|grant| &grant.url == url),
        "more than one server was started"
    );
    assert_eq!(grant_count(&t.app), 8);
    for grant in &grants {
        assert_eq!(
            send(service.endpoint().unwrap().port, post(INIT).token(&grant.token))
                .await
                .status,
            200
        );
    }
}

// --- tools over streamable HTTP ------------------------------------------------------------------------------------

#[tokio::test]
async fn tools_list_returns_the_full_tarsee_tool_list_the_same_one_the_server_itself_lists() {
    let up = up().await;
    let own = create_tarsee_mcp(&up.t.app, ctx_for("conv-list"), CreateOptions { quiet: true });
    let mut expected: Vec<&str> = own.tools().iter().map(|tool| tool.name).collect();
    expected.sort_unstable();

    let grant = up.grant("conv-list").await;
    let reply = send(up.port(), post(LIST).token(&grant.token)).await;
    let listed = reply.json()["result"]["tools"].as_array().cloned().unwrap();
    let mut names: Vec<&str> = listed.iter().map(|tool| tool["name"].as_str().unwrap()).collect();
    names.sort_unstable();
    assert_eq!(names, expected);
    assert!(listed.len() >= 26, "only {} tools listed", listed.len());
    assert!(names.iter().all(|name| name.starts_with("tarsee_")));
    let schedule = listed
        .iter()
        .find(|tool| tool["name"] == "tarsee_schedule_task")
        .unwrap();
    assert_eq!(
        schedule["inputSchema"]["properties"]["action"]["properties"]["args"]["type"],
        "object"
    );
    // And it is the Node server's list, to the byte.
    assert_eq!(
        reply.body,
        format!(
            r#"{{"result":{{"tools":{}}},"jsonrpc":"2.0","id":2}}"#,
            NODE_TOOLS.trim_end()
        )
    );
}

#[tokio::test]
async fn a_call_reaches_execute_tool_with_the_granted_context_and_each_token_reaches_only_its_own() {
    let up = up().await;
    up.tools
        .respond_with("remember", |call| format!("Remembered: {}", call.args["fact"]));
    let one = grant_turn(
        &up.t.app,
        ToolContext {
            message_id: Some("msg-1".into()),
            dashboard: true,
            ..ctx_for("conv-one")
        },
        GrantOptions::default(),
    )
    .await
    .unwrap();
    let two = up.grant("conv-two").await;
    let said = up
        .call(
            &one,
            "tarsee_remember",
            json!({"content": "The canary fact is teal-42", "category": "fact"}),
        )
        .await;
    assert_eq!(said.text(), "Remembered: \"The canary fact is teal-42\"");
    up.call(
        &two,
        "tarsee_remember",
        json!({"content": "The other turn's fact is amber-7"}),
    )
    .await;
    let calls = up.tools.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        (calls[0].name.as_str(), calls[0].args.to_string()),
        (
            "remember",
            r#"{"fact":"The canary fact is teal-42","category":"fact"}"#.to_string()
        )
    );
    // The whole context of the turn, and only that turn's.
    assert_eq!(
        calls[0].ctx,
        ToolContext {
            message_id: Some("msg-1".into()),
            dashboard: true,
            ..ctx_for("conv-one")
        }
    );
    assert_eq!(calls[1].ctx, ctx_for("conv-two"));
    assert_eq!(
        calls[1].args.to_string(),
        r#"{"fact":"The other turn's fact is amber-7"}"#
    );
}

/// The Node case "enforces a Tool Permissions deny: nothing runs, the model is told why, and the audit log has it"
/// tested `lib/tools.js` through the endpoint. The deny itself is `execute_tool`'s (package S3); what is this
/// endpoint's is that the tool's refusal reaches the model word for word, as an ordinary result.
#[tokio::test]
async fn a_tools_refusal_reaches_the_model_as_the_tool_worded_it() {
    let up = up().await;
    let refusal =
        "Refused by security policy: remember is set to always deny. Change it in Settings > Tool Permissions.";
    up.tools.respond("remember", refusal);
    let grant = up.grant("conv-denied").await;
    let reply = up
        .call(&grant, "tarsee_remember", json!({"content": "This must not be saved"}))
        .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), refusal);
    assert!(reply.json()["result"].get("isError").is_none());
}

fn memory_file() -> String {
    let lines: Vec<String> = (0..900)
        .map(|i| format!("- line {i}: the owner's notes go on for a while here"))
        .collect();
    format!("# Memory\n{}\nEND-OF-MEMORY-CANARY\n", lines.join("\n"))
}

#[tokio::test]
async fn saves_a_result_too_long_for_the_models_context_to_a_file_outside_the_workspace_and_returns_its_path() {
    let up = up().await;
    let limit = spill_threshold(up.t.env());
    assert_eq!(limit, 12_000);
    // The same setting as Claude Code's limit (context_limits.rs), with the same floor.
    let env = |value: &str| Env::from_pairs([("TARSEE_TOOL_RESULT_MAX_CHARS", value)]);
    assert_eq!(spill_threshold(&env("5000")), 5000);
    assert_eq!(spill_threshold(&env("500")), 12_000);
    assert_eq!(spill_threshold(&env("999.9")), 12_000);
    assert_eq!(spill_threshold(&env("1000.5")), 1001);
    assert_eq!(spill_threshold(&env(" 0x800 ")), 2048);
    assert_eq!(spill_threshold(&env("lots")), 12_000);
    assert_eq!(spill_threshold(&env("Infinity")), 12_000);
    let full = memory_file();
    assert!(full.len() > limit * 2);
    let whole = full.clone();
    up.tools.respond_with("read_file", move |_| whole.clone());

    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-spill"),
        GrantOptions {
            turn_id: Some("turn-spill-1".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let text = up
        .call(&grant, "tarsee_read_file", json!({"filename": "MEMORY.md"}))
        .await
        .text();
    assert!(text.len() < limit, "the model still got {} characters", text.len());
    let start = text.find("saved in full to ").expect("no path in the answer") + "saved in full to ".len();
    let end = text[start..].find(".txt").unwrap() + start + ".txt".len();
    let saved = PathBuf::from(&text[start..end]);
    assert!(saved.is_absolute());
    let output_root = node_path::join(up.t.path(), "tool-output");
    assert!(
        saved.starts_with(output_root.join("turn-spill-1")),
        "saved at {}",
        saved.display()
    );
    assert!(
        !saved.starts_with(&up.t.config().workspace_dir),
        "the spill file is in the workspace"
    );
    // The file must hold the whole result.
    assert_eq!(std::fs::read_to_string(&saved).unwrap(), full);
    assert!(
        text.contains("# Memory\n- line 0:"),
        "the model gets the start of it to go on"
    );
    assert!(!text.contains("END-OF-MEMORY-CANARY"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&saved).unwrap().permissions().mode() & 0o777, 0o600);
        let folder = std::fs::metadata(saved.parent().unwrap()).unwrap();
        assert_eq!(folder.permissions().mode() & 0o777, 0o700);
    }
}

#[tokio::test]
async fn is_quiet_a_turns_requests_build_its_tool_server_without_a_log_line_and_no_token_is_logged() {
    let up = up().await;
    up.tools.respond("calculator", "2");
    let grant = up.grant("conv-quiet").await;
    let logs = CapturedLogs::start();
    send(up.port(), post(INIT).token(&grant.token)).await;
    send(up.port(), post(LIST).token(&grant.token)).await;
    up.call(&grant, "tarsee_calculator", json!({"expression": "1 + 1"}))
        .await;
    up.call(&grant, "tarsee_calculator", json!({"expression": "2 + 2"}))
        .await;
    // A refusal is logged; the token it came with is not.
    send(up.port(), post(INIT).token(&grant.token).host("evil.example")).await;
    send(up.port(), post(INIT).token(&format!("{}x", grant.token))).await;
    let lines = logs.lines();
    let builds = lines
        .iter()
        .filter(|line| line.contains("Creating Tarsee MCP server"))
        .count();
    assert_eq!(builds, 0, "built {builds} times for one turn");
    assert!(
        !lines.iter().any(|line| line.contains(&grant.token)),
        "a token reached the log"
    );
    assert_eq!(
        logs.warnings(),
        [
            "[mcp-http] refused a request for another host (Host header)",
            "[mcp-http] refused a request without a live grant's token",
        ]
    );
    assert!(!format!("{grant:?}").contains(&grant.token));
}

#[tokio::test]
async fn leaves_a_short_result_as_it_is() {
    let up = up().await;
    up.tools.respond("calculator", "6 * 7 = 42");
    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-short"),
        GrantOptions {
            turn_id: Some("turn-short".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let reply = up
        .call(&grant, "tarsee_calculator", json!({"expression": "6 * 7"}))
        .await;
    assert_eq!(reply.text(), "6 * 7 = 42");
    assert!(!up.t.path().join("tool-output").join("turn-short").exists());
}

// --- refusals ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn answers_401_to_a_request_with_no_token_or_a_wrong_one() {
    let up = up().await;
    let grant = up.grant("conv-401").await;
    let none = send(up.port(), post(INIT)).await;
    assert_eq!(none.status, 401);
    assert!(
        none.header("www-authenticate")
            .unwrap_or_default()
            .starts_with("Bearer")
    );
    let made_up = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
    assert_eq!(send(up.port(), post(INIT).token(&made_up)).await.status, 401);
    let short = format!("sk-{}", "test-canary-not-a-grant");
    assert_eq!(send(up.port(), post(INIT).token(&short)).await.status, 401);
    // The token of a grant, with one character more, one less, or one changed.
    let mut changed = grant.token.clone().into_bytes();
    changed[10] = if changed[10] == b'A' { b'B' } else { b'A' };
    for near in [
        format!("{}A", grant.token),
        grant.token[..grant.token.len() - 1].to_string(),
        String::from_utf8(changed).unwrap(),
        grant.token.to_uppercase(),
    ] {
        assert_eq!(send(up.port(), post(INIT).token(&near)).await.status, 401, "{near}");
    }
    let right = send(up.port(), post(INIT).token(&grant.token)).await;
    assert_eq!(right.status, 200, "{}", right.body);
    assert!(up.tools.calls().is_empty());
}

#[tokio::test]
async fn answers_401_once_a_grant_has_expired() {
    let up = up().await;
    let ahead = Arc::new(AtomicI64::new(0));
    let (clock, start) = (ahead.clone(), crate::util::js::now_ms());
    McpHttp::of(&up.t.app).set_clock(move || start + clock.load(Ordering::SeqCst));
    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-expired"),
        GrantOptions {
            ttl: Some(Duration::from_millis(40)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(grant.expires_at, start + 40);
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 200);
    ahead.store(39, Ordering::SeqCst);
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 200);
    ahead.store(40, Ordering::SeqCst);
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 401);
    assert_eq!(grant_count(&up.t.app), 0);

    // A grant must be able to end: no time at all is refused, in the Node version's words.
    let refused = grant_turn(
        &up.t.app,
        ctx_for("conv-expired"),
        GrantOptions {
            ttl: Some(Duration::ZERO),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused.to_string(),
        "grantTurn: ttlMs must be a positive number of milliseconds"
    );
}

#[tokio::test]
async fn answers_401_once_the_turn_has_ended_and_revoked_its_grant_even_to_a_client_already_connected() {
    let up = up().await;
    let live = grant_count(&up.t.app);
    let grant = up.grant("conv-revoked").await;
    assert_eq!(grant_count(&up.t.app), live + 1);
    // A client that keeps its connection open between requests.
    let mut client = Conn::open(up.port()).await;
    let listed = client.send(&post(LIST).token(&grant.token), false).await;
    assert!(!listed.json()["result"]["tools"].as_array().unwrap().is_empty());
    grant.revoke();
    grant.revoke(); // twice is harmless
    assert_eq!(grant_count(&up.t.app), live, "the grant outlived its turn");
    assert_eq!(client.send(&post(LIST).token(&grant.token), false).await.status, 401);
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 401);
}

#[tokio::test]
async fn a_grant_ends_when_the_turn_lets_go_of_it() {
    // (A turn that fails or is dropped never reaches its own cleanup: the grant goes with whatever held it.)
    let up = up().await;
    let grant = up.grant("conv-dropped").await;
    let token = grant.token.clone();
    assert_eq!(send(up.port(), post(INIT).token(&token)).await.status, 200);
    assert_eq!(grant_count(&up.t.app), 1);
    drop(grant);
    assert_eq!(grant_count(&up.t.app), 0);
    assert_eq!(send(up.port(), post(INIT).token(&token)).await.status, 401);
}

#[tokio::test]
async fn revokes_a_grant_when_the_turns_stop_signal_fires() {
    let up = up().await;
    let stopper = CancellationToken::new();
    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-stopped"),
        GrantOptions {
            signal: Some(stopper.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 200);
    assert_eq!(grant_count(&up.t.app), 1);
    stopper.cancel();
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 401);
    assert_eq!(grant_count(&up.t.app), 0);
    // A grant for a turn already stopped must not work.
    let already = grant_turn(
        &up.t.app,
        ctx_for("conv-stopped-2"),
        GrantOptions {
            signal: Some(stopper),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(send(up.port(), post(INIT).token(&already.token)).await.status, 401);
}

#[tokio::test]
async fn answers_403_to_a_foreign_host_header_even_with_a_good_token_dns_rebinding() {
    let up = up().await;
    let grant = up.grant("conv-host").await;
    let port = up.port();
    for host in [
        "evil.example".to_string(),
        format!("evil.example:{port}"),
        "127.0.0.1:1".to_string(),
        format!("127.0.0.1.evil.example:{port}"),
        "127.0.0.1".to_string(),
        "localhost".to_string(),
        format!("127.1:{port}"),
        format!("[::1]:{port}"),
        format!("0.0.0.0:{port}"),
        format!(" 127.0.0.1:{port}x"),
    ] {
        let reply = send(port, post(INIT).token(&grant.token).host(host.clone())).await;
        assert_eq!(reply.status, 403, "Host {host} got {}", reply.status);
    }
    let local = send(port, post(INIT).token(&grant.token).host(format!("localhost:{port}"))).await;
    assert_eq!(local.status, 200);
    assert!(up.tools.calls().is_empty());
}

#[tokio::test]
async fn answers_403_to_a_request_a_web_page_sent_a_foreign_origin() {
    let up = up().await;
    let grant = up.grant("conv-origin").await;
    for origin in [
        "https://evil.example".to_string(),
        "null".to_string(),
        format!("https://127.0.0.1:{}", up.port()),
        format!("http://127.0.0.1:{}/", up.port()),
        "http://127.0.0.1".to_string(),
    ] {
        let reply = send(
            up.port(),
            post(INIT).token(&grant.token).header("origin", origin.clone()),
        )
        .await;
        assert_eq!(reply.status, 403, "Origin {origin}");
    }
    // Two Origin headers are no web page's own origin either.
    let own = format!("http://127.0.0.1:{}", up.port());
    let twice = post(INIT)
        .token(&grant.token)
        .header("origin", own.clone())
        .header("origin", own);
    assert_eq!(send(up.port(), twice).await.status, 403);
}

#[tokio::test]
async fn refuses_a_caller_that_is_not_on_this_machine() {
    let up = up().await;
    let grant = up.grant("conv-remote").await;
    // The endpoint only listens on 127.0.0.1, so a remote caller can't be produced for real: the connection is made
    // to report a remote address before the server sees the request.
    let service = McpHttp::of(&up.t.app);
    service.report_callers_as(Some("203.0.113.9:40000".parse::<SocketAddr>().unwrap()));
    let reply = send(up.port(), post(INIT).token(&grant.token)).await;
    assert_eq!(reply.status, 403);
    assert_eq!(
        reply.body,
        r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"Only this machine may use this endpoint."},"id":null}"#
    );
    service.report_callers_as(Some("[::ffff:10.0.0.5]:40000".parse::<SocketAddr>().unwrap()));
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 403);
    service.report_callers_as(Some("[::1]:40000".parse::<SocketAddr>().unwrap()));
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 200);
    service.report_callers_as(None);
    assert_eq!(send(up.port(), post(INIT).token(&grant.token)).await.status, 200);

    for addr in [
        "127.0.0.1",
        "127.8.9.10",
        "::1",
        "::ffff:127.0.0.1",
        " ::FFFF:127.0.0.1 ",
    ] {
        assert!(is_loopback_address(addr), "{addr}");
    }
    for addr in [
        "203.0.113.9",
        "10.0.0.5",
        "192.168.1.20",
        "::ffff:10.0.0.5",
        "fe80::1",
        "",
        "0.0.0.0",
        "::",
        "127.0.0.01",
        "127.1",
        "127.0.0.1.evil.example",
        "::ffff:7f00:1",
        "localhost",
    ] {
        assert!(!is_loopback_address(addr), "{addr}");
    }
}

#[tokio::test]
async fn answers_413_to_a_body_over_4_mb_without_reading_it_all() {
    assert_eq!(MCP_BODY_LIMIT, 4 * 1024 * 1024);
    let up = up().await;
    let grant = up.grant("conv-big").await;
    let padded = |pad: usize| {
        INIT.replacen(
            r#""capabilities""#,
            &format!(r#""pad":"{}","capabilities""#, "x".repeat(pad)),
            1,
        )
    };
    let logs = CapturedLogs::start();
    let reply = send(up.port(), post(padded(MCP_BODY_LIMIT)).token(&grant.token)).await;
    assert_eq!(reply.status, 413);
    assert_eq!(
        reply.body,
        r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"The request is over 4 MB."},"id":null}"#
    );
    assert_eq!(logs.warnings(), ["[mcp-http] refused a request body over 4 MB"]);
    // The same body with no length said ahead: refused as soon as it has run past the limit.
    let mut unsized_body = post(padded(MCP_BODY_LIMIT)).token(&grant.token);
    unsized_body.chunked = true;
    assert_eq!(send(up.port(), unsized_body).await.status, 413);
    // Just under the cap is still served.
    let fits = send(up.port(), post(padded(MCP_BODY_LIMIT - 1024)).token(&grant.token)).await;
    assert_eq!(fits.status, 200);
    // And exactly the cap.
    let exact = padded(MCP_BODY_LIMIT - INIT.len() - r#""pad":"","#.len());
    assert_eq!(exact.len(), MCP_BODY_LIMIT);
    assert_eq!(send(up.port(), post(exact).token(&grant.token)).await.status, 200);
}

#[tokio::test]
async fn serves_only_post_mcp() {
    let up = up().await;
    let grant = up.grant("conv-routes").await;
    let token = grant.token.as_str();
    assert_eq!(send(up.port(), post(INIT).token(token).path("/")).await.status, 404);
    assert_eq!(
        send(up.port(), post(INIT).token(token).path("/api/chat")).await.status,
        404
    );
    let get = send(up.port(), bare("GET").token(token)).await;
    assert_eq!(get.status, 405);
    assert_eq!(get.header("allow"), Some("POST"));
    assert_eq!(send(up.port(), bare("DELETE").token(token)).await.status, 405);
    assert_eq!(send(up.port(), post("{not json").token(token)).await.status, 400);
}

// --- spilled results are kept for a week ---------------------------------------------------------------------------

fn set_mtime(path: &Path, at: SystemTime) {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_WRITE_ATTRIBUTES, and FILE_FLAG_BACKUP_SEMANTICS so a folder can be opened.
        std::fs::File::options()
            .access_mode(0x0100)
            .custom_flags(0x0200_0000)
            .open(path)
            .unwrap()
    };
    #[cfg(not(windows))]
    let file = std::fs::File::open(path).unwrap();
    file.set_modified(at).unwrap();
}

#[test]
fn prunes_turn_folders_older_than_seven_days_and_keeps_newer_ones() {
    let t = test_app();
    let root = t.path().join("prune-test");
    let old = root.join("turn-old");
    let recent = root.join("turn-recent");
    for dir in [&old, &recent] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("1-tarsee_read_file.txt"), "x").unwrap();
    }
    std::fs::write(root.join("stray-old.txt"), "x").unwrap();
    std::fs::write(root.join("stray-new.txt"), "x").unwrap();
    let now = crate::util::js::now_ms();
    let eight_days_ago = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
    set_mtime(&old, eight_days_ago);
    set_mtime(&root.join("stray-old.txt"), eight_days_ago);
    assert_eq!(TOOL_OUTPUT_KEEP_MS, 7 * 24 * 3_600_000);
    let removed = prune_tool_output(
        &t.app,
        PruneOptions {
            dir: Some(root.clone()),
            now: Some(now),
            ..Default::default()
        },
    );
    assert_eq!(removed, 2);
    assert!(!old.exists());
    assert!(!root.join("stray-old.txt").exists());
    assert!(recent.exists());
    assert!(root.join("stray-new.txt").exists());
    let missing = PruneOptions {
        dir: Some(t.path().join("no-such-folder")),
        now: Some(now),
        ..Default::default()
    };
    assert_eq!(prune_tool_output(&t.app, missing), 0);
    // Without a folder named: the app's own tool-output, where a week from now everything is old.
    let own = t.path().join("tool-output").join("turn-x");
    std::fs::create_dir_all(&own).unwrap();
    assert_eq!(prune_tool_output(&t.app, PruneOptions::default()), 0);
    let later = PruneOptions {
        now: Some(now + TOOL_OUTPUT_KEEP_MS + 60_000),
        ..Default::default()
    };
    assert_eq!(prune_tool_output(&t.app, later), 1);
    assert!(!own.exists());
}

#[tokio::test]
async fn a_folder_left_over_from_an_earlier_run_is_pruned_when_the_endpoint_starts() {
    let t = test_app();
    let old = t.path().join("tool-output").join("turn-old");
    let recent = t.path().join("tool-output").join("turn-recent");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::create_dir_all(&recent).unwrap();
    set_mtime(&old, SystemTime::now() - Duration::from_secs(8 * 24 * 3600));
    start_mcp_http(&t.app, StartOptions::default()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        while old.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the old folder was not pruned at start");
    assert!(recent.exists());
}

// --- Every answer of the Node endpoint -----------------------------------------------------------------------------

/// A case of the capture where this endpoint answers differently, and why. (Each is in the report.)
fn known_difference(name: &str) -> Option<&'static str> {
    Some(match name {
        // serde_json refuses a number past what a double holds, where JSON.parse reads Infinity.
        "number NaN-ish" | "id 1e999" => "a number beyond a double is not JSON here",
        // serde_json refuses nesting past 128 levels.
        "deep nesting 200" => "nesting past 128 levels is not JSON here",
        // Half of a surrogate pair is left out (a Rust string cannot hold one).
        "lone surrogate escape id" => "half a surrogate pair is left out",
        _ => return None,
    })
}

#[tokio::test]
async fn every_answer_is_the_node_endpoints() {
    let up = up().await;
    let capture: Value = serde_json::from_str(NODE_ENDPOINT).unwrap();
    let cases = capture["cases"].as_array().unwrap();
    assert!(cases.len() > 290);
    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-capture"),
        GrantOptions {
            turn_id: Some("turn-capture".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let port = up.port();

    // The tools answer what the Node tools answered: (tool, a piece of its arguments, the answer).
    let answers: Arc<Mutex<Vec<(String, String, String)>>> = Arc::default();
    let server = create_tarsee_mcp(&up.t.app, ctx_for("x"), CreateOptions { quiet: true });
    for tool in server.tools() {
        let inner = tool.name.strip_prefix("tarsee_").unwrap().to_string();
        let (known, name) = (answers.clone(), inner.clone());
        up.tools.respond_with(inner, move |call| {
            let args = call.args.to_string();
            known
                .lock()
                .iter()
                .find(|(tool, piece, _)| *tool == name && args.contains(piece))
                .map(|(_, _, answer)| answer.clone())
                .unwrap_or_else(|| format!("no answer was captured for {name} {args}"))
        });
    }

    let mut compared = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        // Long results have their own test below.
        if name.starts_with("spill") || name.contains("limit") {
            continue;
        }
        let request = &case["request"];
        let body: Option<Vec<u8>> = match (&request["bodyBase64"], &request["chunked"], &request["body"]) {
            (Value::String(encoded), _, _) => Some(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()),
            (_, Value::String(chunked), _) => Some(chunked.clone().into_bytes()),
            (_, _, Value::String(body)) => Some(body.clone().into_bytes()),
            _ => None,
        };

        // What the tools must answer in this case: every call the Node endpoint let through to a tool.
        let sent = body
            .as_deref()
            .and_then(|body| parse_json_lossy(&String::from_utf8_lossy(body)));
        let node: Option<Value> = serde_json::from_str(case["response"]["body"].as_str().unwrap()).ok();
        let mut reached = 0;
        answers.lock().clear();
        up.tools.clear_calls();
        let messages = match &sent {
            Some(Value::Array(list)) => list.clone(),
            Some(single) => vec![single.clone()],
            None => Vec::new(),
        };
        for message in &messages {
            let Some(tool) = message["params"]["name"]
                .as_str()
                .and_then(|name| name.strip_prefix("tarsee_"))
            else {
                continue;
            };
            if message["method"] != "tools/call" {
                continue;
            }
            let answered = match &node {
                Some(Value::Array(list)) => list.iter().find(|answer| answer["id"] == message["id"]).cloned(),
                Some(single) => Some(single.clone()),
                None => None,
            };
            let Some(text) =
                answered.and_then(|answer| answer["result"]["content"][0]["text"].as_str().map(String::from))
            else {
                continue;
            };
            if text.starts_with("MCP error -32602") || text.starts_with("Error: Either 'prompt' or 'action'") {
                continue;
            }
            let piece = message["params"]["arguments"]
                .as_object()
                .and_then(|args| args.values().find(|value| value.is_string()))
                .map(Value::to_string)
                .unwrap_or_default();
            answers.lock().push((tool.to_string(), piece, text));
            reached += 1;
        }

        let mut raw = Raw {
            method: request["method"].as_str().unwrap().to_string(),
            path: request["path"].as_str().unwrap().to_string(),
            token: None,
            host: request["host"]
                .as_str()
                .map(|host| host.replace("<port>", &port.to_string())),
            headers: Vec::new(),
            body,
            accept: request["noAccept"] != true,
            content_type: request["noContentType"] != true,
            chunked: request["chunked"].is_string(),
        };
        for (header, value) in request["headers"].as_object().unwrap() {
            let value = value
                .as_str()
                .unwrap()
                .replace("<port>", &port.to_string())
                .replace("<token>", &grant.token);
            if header == "transfer-encoding" {
                continue;
            }
            raw.headers.push((header.clone(), value));
        }
        if request["wrongToken"] == true {
            raw.token = Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]));
        } else if request["noToken"] != true {
            raw.token = Some(grant.token.clone());
        }

        let reply = send(port, raw).await;
        compared += 1;
        if let Some(why) = known_difference(name) {
            let same =
                reply.body == case["response"]["body"].as_str().unwrap() && reply.status == case["response"]["status"];
            assert!(!same, "{name}: listed as a difference ({why}), but it is none");
            match name {
                "lone surrogate escape id" => {
                    assert_eq!(
                        (reply.status, reply.body.as_str()),
                        (200, r#"{"result":{},"jsonrpc":"2.0","id":"a"}"#)
                    )
                }
                _ => assert_eq!(
                    (reply.status, reply.body.as_str()),
                    (
                        400,
                        r#"{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: the body is not JSON."},"id":null}"#
                    ),
                    "{name}"
                ),
            }
            continue;
        }
        assert_eq!(reply.status, case["response"]["status"], "{name}: {}", reply.body);
        let expected = case["response"]["body"]
            .as_str()
            .unwrap()
            .replace(r#""<tools>""#, NODE_TOOLS.trim_end());
        assert_eq!(reply.body, expected, "{name}");
        // The headers a client reads. (Not compared: the Date, the length of the body or how it is framed, and the
        // case of a header's name.)
        let seen = |headers: Vec<(String, String)>| -> Vec<(String, String)> {
            let mut kept: Vec<(String, String)> = headers
                .into_iter()
                .map(|(header, value)| (header.to_lowercase(), value))
                .filter(|(header, _)| {
                    ["content-type", "cache-control", "allow", "www-authenticate"].contains(&header.as_str())
                })
                .collect();
            kept.sort();
            kept
        };
        let node_headers: Vec<(String, String)> = case["response"]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().unwrap().to_string(),
                    pair[1].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(seen(reply.headers.clone()), seen(node_headers), "{name}");
        // A tool ran exactly when the Node endpoint ran it: arguments that don't fit never reach one.
        assert_eq!(up.tools.calls().len(), reached, "{name}: {:?}", up.tools.calls());
    }
    assert_eq!(compared, cases.len() - 11);
}

/// The text of a JSON string, without its quotes.
fn in_json(text: &str) -> String {
    let quoted = Value::String(text.to_string()).to_string();
    quoted[1..quoted.len() - 1].to_string()
}

#[tokio::test]
async fn a_long_result_is_saved_and_cut_as_the_node_endpoint_saved_and_cut_it() {
    let up = up().await;
    let capture: Value = serde_json::from_str(NODE_ENDPOINT).unwrap();
    let case = |name: &str| -> (String, String) {
        let case = capture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap_or_else(|| panic!("no case {name}"));
        (
            case["request"]["body"].as_str().unwrap().to_string(),
            case["response"]["body"].as_str().unwrap().to_string(),
        )
    };
    // The files the Node tools read, by name.
    let memory = memory_file();
    let files: Vec<(&str, String)> = vec![
        ("MEMORY.md", memory.clone()),
        ("USER.md", format!("x{}", "🐒".repeat(7000))),
        ("TOOLS.md", "é".repeat(12_000)),
        ("AGENTS.md", "é".repeat(12_001)),
        ("SOUL.md", "0123456789".repeat(150)),
        ("HEARTBEAT.md", "0123456789".repeat(100)),
    ];
    let known = files.clone();
    up.tools.respond_with("read_file", move |call| {
        let name = call.args["filename"].as_str().unwrap();
        known.iter().find(|(file, _)| *file == name).unwrap().1.clone()
    });
    up.tools.respond("calculator", "1+1 = 2");
    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-capture"),
        GrantOptions {
            turn_id: Some("turn-capture".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let turn_folder = node_path::join(&node_path::join(up.t.path(), "tool-output"), "turn-capture");
    let folder_text = format!("{}{}", turn_folder.display(), std::path::MAIN_SEPARATOR);
    // The Node answer with this run's folder and the file's own random ending in it.
    let expected = |node: &str, ours: &str| -> String {
        let mut expected = node.replace(r"<tmp>\\tool-output\\turn-capture\\", &in_json(&folder_text));
        let mut rest = ours;
        while let Some(at) = expected.find("-<hex>.txt") {
            let found = rest.find("-tarsee_read_file-").expect("no saved file in the answer");
            let hex = &rest[found + 18..found + 24];
            assert!(hex.chars().all(|c| c.is_ascii_hexdigit()), "{hex}");
            expected.replace_range(at..at + 10, &format!("-{hex}.txt"));
            rest = &rest[found + 24..];
        }
        expected
    };
    let ask = |body: String| {
        let (port, token) = (up.port(), grant.token.clone());
        async move { send(port, post(body).token(&token)).await.body }
    };

    // (In the order the Node endpoint was asked, so each file gets the number it got there.)
    for name in ["spill ascii", "spill ascii again"] {
        let (request, node) = case(name);
        let ours = ask(request).await;
        assert_eq!(ours, expected(&node, &ours), "{name}");
    }

    // A cut that lands in the middle of an emoji: the Node endpoint sent half of it (a lone surrogate); here the
    // half is left out, and the count says what is shown.
    let (request, node) = case("spill emoji cut");
    let ours = ask(request).await;
    assert!(
        node.ends_with(r#"\ud83d"}]},"jsonrpc":"2.0","id":62}"#),
        "the capture has no half emoji"
    );
    let node = node
        .replace(r"\ud83d", "")
        .replace("The first 2,000 characters:", "The first 1,999 characters:");
    assert_eq!(ours, expected(&node, &ours));

    // Exactly the limit is left alone (the limit is in UTF-16 units, not bytes: these are 24,000 bytes), one more
    // is not.
    let (request, _) = case("exactly at the limit");
    let ours: Value = serde_json::from_str(&ask(request).await).unwrap();
    assert_eq!(ours["result"]["content"][0]["text"], "é".repeat(12_000));
    let (request, node) = case("one over the limit");
    let ours = ask(request).await;
    assert_eq!(ours, expected(&node, &ours));

    // TARSEE_TOOL_RESULT_MAX_CHARS, read at each call as the Node endpoint read it.
    up.t.env().set("TARSEE_TOOL_RESULT_MAX_CHARS", "1000");
    let (request, node) = case("spill at a limit of 1000");
    let ours = ask(request).await;
    assert_eq!(ours, expected(&node, &ours));
    for (name, limit) in [
        ("at a limit of 1000 exactly", "1000"),
        ("a limit of 999 is the default", "999"),
        ("spill at a limit of 1000.6", "1000.6"),
    ] {
        up.t.env().set("TARSEE_TOOL_RESULT_MAX_CHARS", limit);
        let (request, node) = case(name);
        assert_eq!(ask(request).await, node, "{name}");
    }
    up.t.env().remove("TARSEE_TOOL_RESULT_MAX_CHARS");

    // A batch: the long answer is saved, the short one beside it is left alone.
    let (request, node) = case("spill in a batch");
    let ours = ask(request).await;
    assert_eq!(ours, expected(&node, &ours));

    // What is on disk: the whole of each long result, numbered in the order they came, in the turn's folder.
    let mut saved: Vec<String> = std::fs::read_dir(&turn_folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    saved.sort();
    let numbers: Vec<&str> = saved.iter().map(|name| &name[..18]).collect();
    assert_eq!(
        numbers,
        [
            "1-tarsee_read_file",
            "2-tarsee_read_file",
            "3-tarsee_read_file",
            "4-tarsee_read_file",
            "5-tarsee_read_file",
            "6-tarsee_read_file"
        ]
    );
    let on_disk = |n: usize| std::fs::read_to_string(turn_folder.join(&saved[n])).unwrap();
    assert_eq!(on_disk(0), memory);
    assert_eq!(on_disk(1), memory);
    assert_eq!(on_disk(2), files[1].1);
    assert_eq!(on_disk(3), files[3].1);
    assert_eq!(on_disk(4), files[4].1);
    assert_eq!(on_disk(5), memory);
    assert_eq!(saved, {
        let mut listed: Vec<String> = capture["toolOutput"][1]["files"]
            .as_array()
            .unwrap()
            .iter()
            .zip(&saved)
            .map(|(node, ours)| node.as_str().unwrap().replace("<hex>", &ours[19..25]))
            .collect();
        listed.sort();
        listed
    });
}

#[tokio::test]
async fn a_long_result_that_cant_be_saved_is_cut_and_says_so() {
    let up = up().await;
    let capture: Value = serde_json::from_str(NODE_ENDPOINT).unwrap();
    let case = capture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "spill that can't be saved")
        .unwrap();
    let memory = memory_file();
    up.tools.respond_with("read_file", move |_| memory.clone());
    // The turn's name as a folder: nothing of it that could leave the tool-output folder.
    let turn_id = case["turnId"].as_str().unwrap();
    assert_eq!(turn_id, "blocked/..\\turn id!");
    assert_eq!(safe_name(turn_id), case["inTheWay"].as_str().unwrap());
    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-capture"),
        GrantOptions {
            turn_id: Some(turn_id.to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    // A file is where the turn's folder would go.
    let output = node_path::join(up.t.path(), "tool-output");
    std::fs::create_dir_all(&output).unwrap();
    let in_the_way = output.join("blocked_turn_id");
    std::fs::write(&in_the_way, "in the way").unwrap();

    let logs = CapturedLogs::start();
    let request = case["request"]["body"].as_str().unwrap();
    let ours = send(up.port(), post(request).token(&grant.token)).await.body;
    let node = case["response"]["body"].as_str().unwrap().replace(
        r"<tmp>\\tool-output\\blocked_turn_id",
        &in_json(&in_the_way.display().to_string()),
    );
    assert_eq!(ours, node);
    assert_eq!(
        logs.warnings(),
        [format!(
            "[mcp-http] could not save a long tool result: EEXIST: file already exists, mkdir '{}'",
            in_the_way.display()
        )]
    );
    assert_eq!(std::fs::read_to_string(&in_the_way).unwrap(), "in the way");
}

#[tokio::test]
async fn names_that_come_with_a_call_stay_inside_the_turns_folder() {
    for (given, safe) in [
        ("turn-1_a", "turn-1_a"),
        ("../../etc/passwd", "etc_passwd"),
        ("C:\\Windows\\system32", "C_Windows_system32"),
        ("\\\\server\\share", "server_share"),
        ("...", ""),
        ("__a__", "a"),
        ("a__b", "a__b"),
        ("nul", "nul"),
        ("tarsee_read_file", "tarsee_read_file"),
        ("ünï🐒code", "n_code"),
    ] {
        assert_eq!(safe_name(given), safe, "{given}");
    }
    assert_eq!(safe_name(&"a".repeat(200)).len(), 80);

    // A tool that does not exist is named in its answer; a long enough name makes a long result, saved under a
    // name made of what is safe in the tool's.
    let up = up().await;
    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-names"),
        GrantOptions {
            // (On Windows this name is a device unless it is written literally.)
            turn_id: Some("nul".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let tool = format!("..\\..\\{}", "x/".repeat(8000));
    let reply = up.call(&grant, &tool, json!({})).await;
    let text = reply.text();
    let length = "MCP error -32602: Tool  not found".len() + tool.len();
    assert!(
        text.starts_with(&format!(
            "[This result is {} characters, too long to show here",
            with_commas(length)
        )),
        "{text}"
    );
    let folder = node_path::join(up.t.path(), "tool-output").join("nul");
    let saved: Vec<PathBuf> = std::fs::read_dir(node_path::to_namespaced(&folder))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(saved.len(), 1);
    let name = saved[0].file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with(&format!("1-{}-", "x_".repeat(40))), "{name}");
    assert!(text.contains(&format!("{}{}{name}", folder.display(), std::path::MAIN_SEPARATOR)));
    assert_eq!(reply.json()["result"]["isError"], true);
    assert!(up.tools.calls().is_empty());
    // (A folder of that name can only be removed the way it was made.)
    std::fs::remove_dir_all(node_path::to_namespaced(&folder)).unwrap();
}

#[tokio::test]
async fn a_turn_may_ask_for_its_long_results_as_they_are() {
    // (The Claude engine: Claude Code cuts a long result itself, as it did when its tools were in-process.)
    let up = up().await;
    let memory = memory_file();
    let whole = memory.clone();
    up.tools.respond_with("read_file", move |_| whole.clone());
    let grant = grant_turn(
        &up.t.app,
        ctx_for("conv-whole"),
        GrantOptions {
            turn_id: Some("turn-whole".into()),
            leave_long_results: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let reply = up
        .call(&grant, "tarsee_read_file", json!({"filename": "MEMORY.md"}))
        .await;
    assert_eq!(reply.text(), memory);
    assert!(!up.t.path().join("tool-output").exists());
}

// --- What the engines are handed -----------------------------------------------------------------------------------

#[tokio::test]
async fn a_grant_says_what_to_hand_each_engines_program() {
    let up = up().await;
    let grant = up.grant("conv-engines").await;
    assert_eq!(
        grant.mcp_grant(),
        McpGrant {
            url: grant.url.clone(),
            token: grant.token.clone()
        }
    );
    assert_eq!(grant.authorization(), format!("Bearer {}", grant.token));
    assert_eq!(grant.token_env(), ("TARSEE_MCP_TOKEN", grant.token.as_str()));
    // The claude program's --mcp-config: the token is read from its environment, never written here.
    let config = grant.claude_mcp_config();
    assert_eq!(
        config.to_string(),
        format!(
            r#"{{"mcpServers":{{"tarsee":{{"type":"http","url":"{}","headers":{{"Authorization":"Bearer ${{TARSEE_MCP_TOKEN}}"}}}}}}}}"#,
            grant.url
        )
    );
    assert!(!config.to_string().contains(&grant.token));
    // That header, with the variable filled in, opens the endpoint.
    let header = config["mcpServers"]["tarsee"]["headers"]["Authorization"]
        .as_str()
        .unwrap()
        .replace("${TARSEE_MCP_TOKEN}", &grant.token);
    assert_eq!(header, grant.authorization());
    let reply = send(up.port(), post(INIT).header("authorization", header)).await;
    assert_eq!(reply.status, 200);
}

/// How the grant fits what `providers/codex_options.rs` builds for Codex: the endpoint's address in the config,
/// the token in the program's environment under the name the config says to read it from, and nowhere else.
#[tokio::test]
async fn the_options_codex_is_started_with_carry_the_grant_as_codex_reads_it() {
    use crate::ai::providers::codex_options::{CodexContext, CodexTarget, McpGrant as CodexGrant, build_codex_options};
    let up = up().await;
    let grant = up.grant("conv-codex-options").await;
    let handed = CodexGrant::from(&grant);
    assert_eq!(
        (handed.url.as_str(), handed.token.as_str()),
        (grant.url.as_str(), grant.token.as_str())
    );
    let built = build_codex_options(
        &CodexTarget {
            provider_id: "openai".into(),
            model: Some("gpt-6.1-sol".into()),
            effort: None,
        },
        &CodexContext {
            env: Env::from_pairs([("PATH", "/usr/bin")]),
            key: Some(format!("sk-{}", "test-canary-own-openai-key")),
            state_dir: Some(up.t.path().to_path_buf()),
            workspace: Some(up.t.config().workspace_dir.clone()),
            mcp: Some(handed),
            developer_instructions: Some("You are Tarsee.".into()),
            ..CodexContext::default()
        },
    )
    .map_err(|err| err.to_string())
    .unwrap();
    let server = &built.config["mcp_servers"]["tarsee"];
    assert_eq!(server["url"], grant.url);
    assert_eq!(server["bearer_token_env_var"], MCP_TOKEN_ENV);
    assert_eq!(built.env.get(MCP_TOKEN_ENV), Some(&grant.token));
    assert!(
        !built.config.to_string().contains(&grant.token),
        "the token is in Codex's config"
    );
    // And with exactly that, a request gets in.
    let header = format!("Bearer {}", built.env[MCP_TOKEN_ENV]);
    let port = up.port();
    assert_eq!(server["url"], format!("http://127.0.0.1:{port}/mcp"));
    assert_eq!(send(port, post(INIT).header("authorization", header)).await.status, 200);
    assert_eq!(McpGrant::from(&grant), grant.mcp_grant());
}

// --- Two things at once, and a caller that goes away ---------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_calls_at_once_each_run_in_their_own_turns_context() {
    let up = up().await;
    up.tools.respond_with("remember", |call| {
        format!(
            "{} in {}",
            call.args["fact"].as_str().unwrap(),
            call.ctx.conversation_id.as_deref().unwrap()
        )
    });
    let grants: Vec<Grant> = futures::future::join_all((0..6).map(|i| {
        let app = up.t.app.clone();
        async move {
            grant_turn(&app, ctx_for(&format!("conv-{i}")), GrantOptions::default())
                .await
                .unwrap()
        }
    }))
    .await;
    let port = up.port();
    let replies = futures::future::join_all((0..60).map(|n| {
        let token = grants[n % 6].token.clone();
        async move {
            let body = json!({"jsonrpc": "2.0", "id": n, "method": "tools/call", "params": {
                "name": "tarsee_remember", "arguments": {"content": format!("fact {n}")}
            }});
            send(port, post(body.to_string()).token(&token)).await
        }
    }))
    .await;
    for (n, reply) in replies.iter().enumerate() {
        assert_eq!(reply.status, 200);
        assert_eq!(reply.json()["id"], n);
        assert_eq!(reply.text(), format!("fact {n} in conv-{}", n % 6));
    }
    assert_eq!(up.tools.calls().len(), 60);
}

/// Tools that wait to be let go, so a test can do something while a call is running.
#[derive(Default)]
struct GatedTools {
    started: Notify,
    release: Notify,
    finished: Notify,
    done: AtomicBool,
}

#[async_trait]
impl ToolExecutor for GatedTools {
    async fn execute_tool(&self, _app: &App, _name: &str, _args: Value, _ctx: &ToolContext) -> ToolOutput {
        self.started.notify_one();
        self.release.notified().await;
        self.done.store(true, Ordering::SeqCst);
        self.finished.notify_one();
        "Message sent".into()
    }
}

#[tokio::test]
async fn a_call_runs_to_its_end_when_the_caller_hangs_up_or_the_grant_ends_meanwhile() {
    let t = test_app();
    let gated = Arc::new(GatedTools::default());
    install_tool_executor(&t.app, gated.clone());
    let endpoint = start_mcp_http(&t.app, StartOptions::default()).await.unwrap();
    let grant = grant_turn(&t.app, ctx_for("conv-gone"), GrantOptions::default())
        .await
        .unwrap();
    let call = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "tarsee_send_message", "arguments": {"channel": "telegram", "message": "half-way"}
    }})
    .to_string();

    // The caller hangs up while the tool is at work.
    let mut caller = TcpStream::connect(("127.0.0.1", endpoint.port)).await.unwrap();
    caller
        .write_all(&post(&call).token(&grant.token).bytes(endpoint.port, false))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(20), gated.started.notified())
        .await
        .expect("the call never reached the tool");
    drop(caller);
    // The turn ends too. (And another request goes all the way round, so the server has seen the caller leave.)
    let token = grant.token.clone();
    drop(grant);
    assert_eq!(send(endpoint.port, post(INIT).token(&token)).await.status, 401);
    assert!(!gated.done.load(Ordering::SeqCst));
    gated.release.notify_one();
    tokio::time::timeout(Duration::from_secs(20), gated.finished.notified())
        .await
        .expect("the tool was stopped half-way when its caller left");
    assert!(gated.done.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_request_dropped_half_way_leaves_the_endpoint_as_it_was() {
    let up = up().await;
    up.tools.respond("calculator", "2");
    let grant = up.grant("conv-half").await;
    let call = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "tarsee_calculator", "arguments": {"expression": "1 + 1"}
    }})
    .to_string();
    let whole = post(&call).token(&grant.token).bytes(up.port(), false);
    // Cut at every kind of place: in the request line, in the headers, at the blank line, in the body.
    let head_end = whole.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    for cut in [5, 40, head_end - 2, head_end, head_end + 1, whole.len() - 1] {
        let mut caller = TcpStream::connect(("127.0.0.1", up.port())).await.unwrap();
        caller.write_all(&whole[..cut]).await.unwrap();
        drop(caller);
    }
    // Nothing ran for a request that never arrived whole, the grant is still the turn's, and the next request is
    // served as ever.
    let reply = send(up.port(), post(&call).token(&grant.token)).await;
    assert_eq!(reply.text(), "2");
    assert_eq!(up.tools.calls().len(), 1);
    assert_eq!(grant_count(&up.t.app), 1);
    // A body that says it is longer than what comes, then nothing more: the same.
    let mut caller = TcpStream::connect(("127.0.0.1", up.port())).await.unwrap();
    let mut short = post(&call).token(&grant.token);
    short
        .headers
        .push(("content-length".into(), (call.len() + 50).to_string()));
    let mut bytes = short.bytes(up.port(), false);
    let own_length = format!("content-length: {}\r\n", call.len());
    let at = bytes
        .windows(own_length.len())
        .rposition(|w| w == own_length.as_bytes())
        .unwrap();
    bytes.drain(at..at + own_length.len());
    caller.write_all(&bytes).await.unwrap();
    drop(caller);
    assert_eq!(send(up.port(), post(&call).token(&grant.token)).await.text(), "2");
    assert_eq!(up.tools.calls().len(), 2);
}

#[tokio::test]
async fn nothing_listens_once_the_app_is_gone() {
    let t = test_app();
    let endpoint = start_mcp_http(&t.app, StartOptions::default()).await.unwrap();
    assert!(TcpStream::connect(("127.0.0.1", endpoint.port)).await.is_ok());
    drop(t);
    // The socket closes as soon as the server's own task has run: a few connections may still get in, not many.
    // (Counted, not timed: a connection can fail for other reasons once thousands have been made.)
    let mut still_let_in = 0;
    while TcpStream::connect(("127.0.0.1", endpoint.port)).await.is_ok() {
        still_let_in += 1;
        assert!(
            still_let_in < 50,
            "the endpoint kept listening after its app was dropped"
        );
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn a_refusal_is_logged_at_most_once_a_minute_per_kind() {
    let up = up().await;
    let ahead = Arc::new(AtomicI64::new(0));
    let (clock, start) = (ahead.clone(), crate::util::js::now_ms());
    McpHttp::of(&up.t.app).set_clock(move || start + clock.load(Ordering::SeqCst));
    let logs = CapturedLogs::start();
    for _ in 0..3 {
        assert_eq!(send(up.port(), post(INIT)).await.status, 401);
    }
    assert_eq!(
        send(up.port(), post(INIT).header("origin", "https://evil.example"))
            .await
            .status,
        403
    );
    assert_eq!(
        logs.warnings(),
        [
            "[mcp-http] refused a request without a live grant's token",
            "[mcp-http] refused a request a web page sent (Origin header)",
        ]
    );
    ahead.store(59_999, Ordering::SeqCst);
    send(up.port(), post(INIT)).await;
    assert_eq!(logs.warnings().len(), 2);
    ahead.store(60_000, Ordering::SeqCst);
    send(up.port(), post(INIT)).await;
    assert_eq!(logs.warnings().len(), 3);
}
