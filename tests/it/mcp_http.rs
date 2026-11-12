//! The loopback MCP endpoint (`src/ai/mcp_http.rs`) against the two programs it is for: Codex's own MCP client and
//! Claude Code's.
//!
//! The Node test (`test/mcp-http.test.js`, "with Codex's own MCP client") ran the pinned `@openai/codex` binary
//! whenever it was installed. The Rust build uses the programs on the machine, so these run only when asked for,
//! with each program's path given when the tests are built (read at compile time, as `support::testbin()` is):
//!
//! ```text
//! TARSEE_TEST_CODEX=/path/to/codex cargo test --test it -- --ignored codexs_own_mcp_client
//! TARSEE_TEST_CLAUDE_CLI=/path/to/claude cargo test --test it -- --ignored claude_codes_own_mcp_client
//! ```
//!
//! Neither needs an account: each program gets a home of its own with no credentials in it, and its model hosts are
//! pointed at a closed port on this machine, so nothing can leave it. No model turn runs. The tools behind the
//! endpoint are `testkit::FakeTools`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tarsee::ai::mcp_http::{Grant, GrantOptions, MCP_TOKEN_ENV, grant_turn};
use tarsee::ai::tarsee_mcp::{CreateOptions, create_tarsee_mcp};
use tarsee::lib::tool_api::ToolContext;
use tarsee::testkit::{FakeTools, TestApp, test_app};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// A port on this machine where nothing listens: a program told to find its model host there reaches nobody.
const CLOSED: &str = "http://127.0.0.1:9";

/// A program started with an environment of the test's own: a home under the test's folder, the few variables a
/// program needs to run at all on this system (taken when the tests are built), and nothing else of the machine's.
fn program(bin: &Path, home: &Path) -> Command {
    std::fs::create_dir_all(home).unwrap();
    let home_text = home.to_string_lossy().into_owned();
    let mut command = Command::new(bin);
    command
        .env_clear()
        .env("HOME", &home_text)
        .env("USERPROFILE", &home_text)
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("TEMP", &home_text)
        .env("TMP", &home_text)
        .env("TMPDIR", &home_text)
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if cfg!(windows) {
        let root = option_env!("SystemRoot").unwrap_or(r"C:\Windows");
        command
            .env("SystemRoot", root)
            .env("windir", root)
            .env("SystemDrive", &root[..2])
            .env("ComSpec", format!(r"{root}\System32\cmd.exe"))
            .env("PATHEXT", ".COM;.EXE;.BAT;.CMD")
            .env("PATH", format!(r"{root}\System32;{root}"));
    } else {
        command.env("PATH", "/usr/bin:/bin");
    }
    command
}

struct Tools {
    t: TestApp,
    fake: Arc<FakeTools>,
    grant: Grant,
    /// Every tool's name, sorted.
    names: Vec<String>,
}

async fn tools_for(conversation_id: &str, turn_id: &str) -> Tools {
    let t = test_app();
    let fake = FakeTools::install(&t.app);
    fake.respond_with("remember", |call| format!("Remembered: {}", call.args["fact"]));
    let grant = grant_turn(
        &t.app,
        ToolContext::for_conversation(conversation_id),
        GrantOptions {
            turn_id: Some(turn_id.to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let server = create_tarsee_mcp(&t.app, ToolContext::default(), CreateOptions { quiet: true });
    let mut names: Vec<String> = server.tools().iter().map(|tool| tool.name.to_string()).collect();
    names.sort();
    Tools { t, fake, grant, names }
}

/// Codex's app-server on stdio, set up the way a Codex turn reaches Tarsee's tools: the tarsee MCP server at the
/// grant's url, its token read from TARSEE_MCP_TOKEN. Its own home, no credentials, its model hosts pointed at a
/// closed port on this machine, and the features that reach out on their own switched off (on startup it otherwise
/// git-fetches OpenAI's plugin list from GitHub, in a child that outlives it), so nothing can leave the machine.
struct CodexAppServer {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next: u64,
}

impl CodexAppServer {
    fn start(bin: &Path, home: &Path, grant: &Grant) -> CodexAppServer {
        let offline = [
            "plugins",
            "remote_plugin",
            "plugin_discovery_prefetch",
            "apps",
            "in_app_updates",
            "daemon_auto_start",
        ];
        let mut command = program(bin, home);
        command.arg("app-server");
        for feature in offline {
            command.args(["--disable", feature]);
        }
        for setting in [
            format!("mcp_servers.tarsee.url=\"{}\"", grant.url),
            format!("mcp_servers.tarsee.bearer_token_env_var=\"{MCP_TOKEN_ENV}\""),
            "mcp_servers.tarsee.default_tools_approval_mode=\"approve\"".to_string(),
            "mcp_servers.tarsee.required=true".to_string(),
            "mcp_servers.tarsee.startup_timeout_sec=20".to_string(),
            "check_for_update_on_startup=false".to_string(),
            "analytics.enabled=false".to_string(),
            format!("openai_base_url=\"{CLOSED}/v1\""),
            format!("chatgpt_base_url=\"{CLOSED}/backend-api\""),
        ] {
            command.args(["-c", &setting]);
        }
        let (name, token) = grant.token_env();
        let mut child = command
            .env("CODEX_HOME", home)
            .env(name, token)
            // (Nothing reads what it says on stderr: left open, a full pipe would stop it.)
            .stderr(Stdio::null())
            .spawn()
            .expect("codex could not be started");
        let stdin = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        CodexAppServer {
            child,
            stdin,
            lines,
            next: 0,
        }
    }

    /// One request, and its reply.
    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        let line = json!({"id": id, "method": method, "params": params}).to_string();
        self.stdin.write_all(format!("{line}\n").as_bytes()).await.unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let line = self.lines.next_line().await.unwrap().expect("codex closed its output");
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) if message["id"] == id => return message,
                    _ => continue,
                }
            }
        })
        .await;
        reply.unwrap_or_else(|_| panic!("codex did not answer {method}"))
    }

    async fn notify(&mut self, method: &str) {
        let line = json!({"method": method}).to_string();
        self.stdin.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    }

    /// End of input lets app-server shut down by itself; it is killed only if it hasn't within 5 seconds.
    async fn stop(mut self) {
        drop(self.stdin);
        if tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

/// `test/mcp-http.test.js`: "lists every Tarsee tool and runs a call with the granted context".
#[tokio::test]
#[ignore = "needs a real codex: build the tests with TARSEE_TEST_CODEX=<path> and run with --ignored"]
async fn codexs_own_mcp_client_lists_every_tarsee_tool_and_runs_a_call_with_the_granted_context() {
    let Some(path) = option_env!("TARSEE_TEST_CODEX") else {
        panic!("TARSEE_TEST_CODEX was not set when the tests were built: set it to the codex program and build again");
    };
    let tools = tools_for("conv-codex", "turn-codex").await;
    let home = tools.t.path().join("codex-home");
    let mut codex = CodexAppServer::start(&PathBuf::from(path), &home, &tools.grant);

    let init = codex
        .rpc(
            "initialize",
            json!({"clientInfo": {"name": "tarsee-test", "version": "1.0.0"}}),
        )
        .await;
    assert!(init["result"].is_object(), "initialize: {init}");
    codex.notify("initialized").await;

    let status = codex.rpc("mcpServerStatus/list", json!({"serverName": "tarsee"})).await;
    let server = status["result"]["data"]
        .as_array()
        .and_then(|servers| servers.iter().find(|server| server["name"] == "tarsee"))
        .unwrap_or_else(|| panic!("no tarsee server in {status}"));
    let mut listed: Vec<String> = server["tools"].as_object().unwrap().keys().cloned().collect();
    listed.sort();
    assert_eq!(listed, tools.names);
    // What Codex shows the model for a tool is what the endpoint sent.
    let ours = create_tarsee_mcp(&tools.t.app, ToolContext::default(), CreateOptions { quiet: true });
    let sent = ours.list_tools();
    let message = sent["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "tarsee_send_message")
        .unwrap();
    let shown = &server["tools"]["tarsee_send_message"];
    assert_eq!(shown["description"], message["description"]);
    assert_eq!(
        shown["inputSchema"]["properties"]["channel"],
        message["inputSchema"]["properties"]["channel"]
    );

    let thread = codex.rpc("thread/start", json!({"cwd": home})).await;
    let thread_id = thread["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start: {thread}"))
        .to_string();
    let call = codex
        .rpc(
            "mcpServer/tool/call",
            json!({"server": "tarsee", "threadId": thread_id, "tool": "tarsee_remember", "arguments": {"content": "Codex reached the tools"}}),
        )
        .await;
    assert_eq!(
        call["result"]["content"][0]["text"], "Remembered: \"Codex reached the tools\"",
        "{call}"
    );
    let calls = tools.fake.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "remember");
    assert_eq!(calls[0].args, json!({"fact": "Codex reached the tools"}));
    assert_eq!(calls[0].ctx.conversation_id.as_deref(), Some("conv-codex"));

    // Arguments that don't fit come back to Codex as a failed call with zod's words, and no tool runs.
    let refused = codex
        .rpc(
            "mcpServer/tool/call",
            json!({"server": "tarsee", "threadId": thread_id, "tool": "tarsee_calculator", "arguments": {"expression": 5}}),
        )
        .await;
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    assert!(
        refused["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("MCP error -32602: Input validation error: Invalid arguments for tool tarsee_calculator: ["),
        "{refused}"
    );
    assert_eq!(tools.fake.calls().len(), 1);
    codex.stop().await;
}

/// Runs the claude program to its end and gives what it printed (both streams).
async fn claude(bin: &Path, home: &Path, config_dir: &Path, token: Option<&str>, args: &[&str]) -> String {
    let mut command = program(bin, home);
    command
        .args(args)
        .env("CLAUDE_CONFIG_DIR", config_dir)
        .env("ANTHROPIC_BASE_URL", CLOSED)
        .env("DISABLE_AUTOUPDATER", "1")
        .env("DISABLE_TELEMETRY", "1")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .stdin(Stdio::null());
    if let Some(token) = token {
        command.env(MCP_TOKEN_ENV, token);
    }
    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .expect("claude did not finish")
        .expect("claude could not be started");
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Claude Code reaches Tarsee's tools as the Claude engine will point it at them: the server "tarsee" over HTTP,
/// its token read from TARSEE_MCP_TOKEN in the program's own environment (never on a command line).
#[tokio::test]
#[ignore = "needs a Claude Code CLI: build the tests with TARSEE_TEST_CLAUDE_CLI=<path> and run with --ignored"]
async fn claude_codes_own_mcp_client_connects_with_the_token_from_its_environment_and_is_shown_every_tarsee_tool() {
    let Some(path) = option_env!("TARSEE_TEST_CLAUDE_CLI") else {
        panic!(
            "TARSEE_TEST_CLAUDE_CLI was not set when the tests were built: set it to the claude program and build again"
        );
    };
    let bin = PathBuf::from(path);
    let tools = tools_for("conv-claude", "turn-claude").await;
    let home = tools.t.path().join("claude-home");
    let config_dir = home.join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let (_, token) = tools.grant.token_env();
    let config = tools.grant.claude_mcp_config();
    assert!(!config.to_string().contains(token));

    // 1. `claude mcp list`: the server as the config names it, with and without the variable.
    let server = config["mcpServers"]["tarsee"].to_string();
    let added = claude(&bin, &home, &config_dir, None, &["mcp", "add-json", "tarsee", &server]).await;
    assert!(added.contains("Added"), "{added}");
    let listed = claude(&bin, &home, &config_dir, Some(token), &["mcp", "list"]).await;
    assert!(
        listed.contains(&format!("tarsee: {} (HTTP)", tools.grant.url)),
        "{listed}"
    );
    assert!(listed.contains("Connected"), "{listed}");
    let without = claude(&bin, &home, &config_dir, None, &["mcp", "list"]).await;
    assert!(!without.contains("Connected"), "{without}");
    let wrong = claude(&bin, &home, &config_dir, Some("not-the-token"), &["mcp", "list"]).await;
    assert!(!wrong.contains("Connected"), "{wrong}");

    // 2. A session started as the engine starts one, with --mcp-config: before anything is asked of a model, the
    //    program says which MCP servers it reached and which tools it has.
    let config_file = home.join("mcp.json");
    std::fs::write(&config_file, config.to_string()).unwrap();
    let mut command = program(&bin, &home);
    command
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--mcp-config",
        ])
        .arg(&config_file)
        .env("CLAUDE_CONFIG_DIR", &config_dir)
        .env("ANTHROPIC_BASE_URL", CLOSED)
        .env("DISABLE_AUTOUPDATER", "1")
        .env("DISABLE_TELEMETRY", "1")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env(MCP_TOKEN_ENV, token)
        .stderr(Stdio::null());
    let mut child = command.spawn().expect("claude could not be started");
    let mut stdin = child.stdin.take().unwrap();
    let said = json!({"type": "user", "message": {"role": "user", "content": "hello"}}).to_string();
    stdin.write_all(format!("{said}\n").as_bytes()).await.unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let init = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let line = lines
                .next_line()
                .await
                .unwrap()
                .expect("claude closed its output before saying what it started with");
            match serde_json::from_str::<Value>(&line) {
                Ok(message) if message["type"] == "system" && message["subtype"] == "init" => return message,
                _ => continue,
            }
        }
    })
    .await
    .expect("claude did not say what it started with");
    let _ = child.kill().await;
    let servers = init["mcp_servers"].as_array().unwrap();
    assert_eq!(servers.len(), 1, "{init}");
    assert_eq!(
        (&servers[0]["name"], &servers[0]["status"]),
        (&json!("tarsee"), &json!("connected")),
        "{init}"
    );
    let mut shown: Vec<String> = init["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool.as_str()?.strip_prefix("mcp__tarsee__").map(String::from))
        .collect();
    shown.sort();
    assert_eq!(shown, tools.names);
    assert!(tools.fake.calls().is_empty(), "no tool was asked for");
}
