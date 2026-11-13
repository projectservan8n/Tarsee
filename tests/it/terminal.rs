//! The web terminal for real: a shell started through `websocket::terminal_handler` behind an axum route, driven
//! over a WebSocket as the browser's `terminal.js` drives it. Commands run, output comes back, the terminal is
//! resized, and however the socket goes away (closed, dropped, reset at any moment, its task dropped) the shell and
//! what it started are gone, the terminal is no longer counted, and the audit log says so.

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::extract::{State, WebSocketUpgrade};
use axum::routing::any;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tarsee::App;
use tarsee::db::audit::AuditLog;
use tarsee::testkit::{CapturedLogs, TestApp, test_app_with_env, tmp_dir};
use tarsee::websocket::terminal_handler::{
    cleanup_all_terminals, get_active_terminal_count, handle_terminal_connection, shell, terminal_upgrade,
};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_util::sync::CancellationToken;

type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const WAIT: Duration = Duration::from_secs(60);

/// A variable only the app's environment has: the shell must see it.
const CANARY: (&str, &str) = ("TARSEE_SHELL_CANARY", "from-app");

/// What a shell needs from the machine to start at all (where programs are, and on Windows the system's folders).
/// Everything else in the test app's environment is its own.
fn system_env() -> Vec<(String, String)> {
    let names: &[&str] = if cfg!(windows) {
        &[
            "Path",
            "PATHEXT",
            "SystemRoot",
            "SystemDrive",
            "windir",
            "ComSpec",
            "TEMP",
            "TMP",
            "ProgramData",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ALLUSERSPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "PSModulePath",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "OS",
        ]
    } else {
        &["PATH"]
    };
    let mut env: Vec<(String, String)> = names
        .iter()
        .filter_map(|name| Some((name.to_string(), std::env::var(name).ok()?)))
        .collect();
    if cfg!(unix) {
        if env.is_empty() {
            env.push(("PATH".into(), "/usr/bin:/bin".into()));
        }
        // bash reads keystrokes outside ASCII as such only in a UTF-8 locale.
        env.push(("LANG".into(), "C.UTF-8".into()));
    }
    env
}

/// A variable of this test process's own environment that the app's environment does not have: the shell must not
/// see it (portable-pty starts from the real environment unless told not to).
fn real_only_variable() -> (String, String) {
    for name in [
        "CARGO_PKG_NAME",
        "CARGO_MANIFEST_DIR",
        "CARGO",
        "USERNAME",
        "USER",
        "LOGNAME",
    ] {
        if let Ok(value) = std::env::var(name)
            && !value.is_empty()
            && !system_env().iter().any(|(n, _)| n.eq_ignore_ascii_case(name))
        {
            return (name.to_string(), value);
        }
    }
    panic!("this test process has none of the variables used to check that the shell's environment is its own");
}

struct Server {
    t: TestApp,
    addr: SocketAddr,
    /// Kept so the working folder lives as long as the test.
    _work: tempfile::TempDir,
}

fn app_with(extra: Vec<(String, String)>) -> (TestApp, tempfile::TempDir) {
    let work = tmp_dir();
    let folder = work.path().join("work space é");
    std::fs::create_dir_all(&folder).unwrap();
    let mut env = system_env();
    env.push(("CLAUDE_WORKSPACE_DIR".into(), folder.to_string_lossy().into_owned()));
    env.push((CANARY.0.into(), CANARY.1.into()));
    env.extend(extra);
    let t = test_app_with_env(env);
    AuditLog::init(&t.app);
    (t, work)
}

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

/// A server whose `/terminal` is the web terminal, with the working folder at a path that has a space and a letter
/// outside ASCII in it.
async fn server_with(extra: Vec<(String, String)>) -> Server {
    let (t, work) = app_with(extra);
    let router = Router::new()
        .route(
            "/terminal",
            any(|State(app): State<App>, upgrade: WebSocketUpgrade| async move {
                terminal_upgrade(app, upgrade, Some("203.0.113.9".into()))
            }),
        )
        .with_state(t.app.clone());
    let addr = serve(router).await;
    Server { t, addr, _work: work }
}

async fn server() -> Server {
    server_with(Vec::new()).await
}

/// A server whose terminal task is dropped, wherever it is, when `stop` is cancelled.
async fn stoppable_server(stop: CancellationToken) -> Server {
    let (t, work) = app_with(Vec::new());
    let router = Router::new()
        .route(
            "/terminal",
            any(move |State(app): State<App>, upgrade: WebSocketUpgrade| {
                let stop = stop.clone();
                async move {
                    upgrade.on_upgrade(move |socket| async move {
                        // The terminal first: it has always started (and begun starting its shell) when the stop is
                        // seen, however early that comes.
                        tokio::select! {
                            biased;
                            _ = handle_terminal_connection(app, socket, None) => {}
                            _ = stop.cancelled() => {}
                        }
                    })
                }
            }),
        )
        .with_state(t.app.clone());
    let addr = serve(router).await;
    Server { t, addr, _work: work }
}

/// The browser's side of the socket.
struct Term {
    ws: Client,
    /// Every `data` text so far.
    screen: String,
    /// The first `data` text.
    first: Option<String>,
}

impl Term {
    async fn open(server: &Server) -> Term {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/terminal", server.addr))
            .await
            .unwrap();
        Term {
            ws,
            screen: String::new(),
            first: None,
        }
    }

    async fn send(&mut self, value: Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.unwrap();
    }

    async fn input(&mut self, text: &str) {
        self.send(json!({"type": "input", "data": text})).await;
    }

    /// The next message: JSON text, or the close frame as `{"close": [code, reason]}`, or null when the socket ended.
    async fn next(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(WAIT, self.ws.next())
                .await
                .unwrap_or_else(|_| panic!("no message from the terminal; screen so far:\n{}", self.screen));
            match message {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "data" {
                        let data = value["data"].as_str().unwrap();
                        // The Windows console's question for the cursor position is answered by the server, as
                        // node-pty's console never asked it.
                        assert!(!data.contains("\x1b[6n"), "the console's question reached the browser");
                        self.first.get_or_insert_with(|| data.to_string());
                        self.screen.push_str(data);
                    }
                    return value;
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((1005, String::new()));
                    return json!({"close": [code, reason]});
                }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return Value::Null,
            }
        }
    }

    /// Reads until the screen matches `pattern`; gives its first group (or the whole match).
    async fn wait_for(&mut self, pattern: &str) -> String {
        let re = regex::Regex::new(pattern).unwrap();
        loop {
            if let Some(found) = re.captures(&self.screen) {
                let text = found.get(1).or(found.get(0)).unwrap().as_str().to_string();
                self.screen.clear();
                return text;
            }
            let message = self.next().await;
            assert!(
                message["type"] == "data",
                "waiting for /{pattern}/ the terminal sent {message}; screen:\n{}",
                self.screen
            );
        }
    }

    /// Answers the server's close and reads the socket to its end, as a browser does (tungstenite sends the answer
    /// while it is read).
    async fn finish(&mut self) {
        let _ = self.ws.close(None).await;
        while let Ok(Some(Ok(_))) = tokio::time::timeout(WAIT, self.ws.next()).await {}
    }

    /// Reads until a message of this type.
    async fn wait_message(&mut self, kind: &str) -> Value {
        loop {
            let message = self.next().await;
            if message["type"] == kind || (kind == "close" && message.get("close").is_some()) {
                return message;
            }
            assert!(
                message["type"] == "data",
                "waiting for {kind} the terminal sent {message}"
            );
        }
    }

    /// The shell's process id, asked of the shell.
    async fn shell_pid(&mut self) -> u32 {
        self.input(&say("pid", if cfg!(windows) { "$PID" } else { "$$" })).await;
        self.wait_for(r"pid=([0-9]+)").await.parse().unwrap()
    }
}

/// Resets the connection (no close frame, the TCP connection aborted), as a crashed or killed client does.
#[allow(deprecated)]
fn reset(ws: Client) {
    if let tokio_tungstenite::MaybeTlsStream::Plain(tcp) = ws.get_ref() {
        tcp.set_linger(Some(Duration::ZERO)).unwrap();
    }
    drop(ws);
}

/// The command line for the shell (PowerShell or bash) that prints `text` built so its echo does not show it.
fn say(name: &str, value: &str) -> String {
    if cfg!(windows) {
        format!("Write-Output (\"{name}\" + \"=\" + {value})\r")
    } else {
        format!("echo {name}\"=\"{value}\r")
    }
}

/// Whether a process with this id is running.
fn running(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: a handle opened, read and closed here.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE as u32
        }
    }
    #[cfg(unix)]
    {
        // SAFETY: signal 0 sends nothing.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
}

/// Waits (polling the process table, at most a minute) until the process is gone.
async fn gone(pid: u32) -> bool {
    let until = tokio::time::Instant::now() + WAIT;
    while tokio::time::Instant::now() < until {
        if !running(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn audit_actions(app: &App) -> Vec<(String, Value, Option<String>)> {
    let mut rows = app.expect::<AuditLog>().query(Some(100), None).unwrap();
    rows.sort_by_key(|row| row["id"].as_i64());
    rows.iter()
        .filter(|row| row["action"].as_str().unwrap_or_default().starts_with("terminal."))
        .map(|row| {
            (
                row["action"].as_str().unwrap().to_string(),
                serde_json::from_str(row["detail"].as_str().unwrap_or("null")).unwrap(),
                row["ip"].as_str().map(str::to_string),
            )
        })
        .collect()
}

async fn until_closed_count(app: &App) {
    let until = tokio::time::Instant::now() + WAIT;
    while get_active_terminal_count(app) != 0 && tokio::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits until the one terminal's session is over (no terminal counted, three audit lines: the last, the exit,
/// is written once the shell has really ended) and gives the audit lines' actions.
async fn session_over(app: &App) -> Vec<String> {
    until_closed_count(app).await;
    assert_eq!(get_active_terminal_count(app), 0);
    let until = tokio::time::Instant::now() + WAIT;
    let mut actions = audit_actions(app);
    while actions.len() < 3 && tokio::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
        actions = audit_actions(app);
    }
    actions.into_iter().map(|(action, _, _)| action).collect()
}

/// A process this test starts itself, outside any terminal.
fn outsider() -> std::process::Child {
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("ping");
        c.args(["-n", "600", "127.0.0.1"]);
        c
    } else {
        let mut c = std::process::Command::new("sleep");
        c.arg("600");
        c
    };
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shell_runs_commands_resizes_and_is_gone_with_what_it_started_when_the_socket_closes() {
    let server = server().await;
    let mut term = Term::open(&server).await;

    let connected = term.next().await;
    assert_eq!(connected["type"], "connected");
    assert_eq!(connected["shell"], shell());
    let cwd = server.t.config().claude_workspace_dir.to_string_lossy().into_owned();
    assert_eq!(connected["cwd"], cwd.as_str());
    let terminal_id = connected["terminalId"].as_str().unwrap().to_string();
    assert!(terminal_id.starts_with("term-"));
    assert_eq!(get_active_terminal_count(&server.t.app), 1);

    // A command, its output, and where it ran.
    term.input(&say("sum", if cfg!(windows) { "(40 + 2)" } else { "$((40+2))" }))
        .await;
    assert_eq!(term.wait_for(r"sum=([0-9]+)").await, "42");
    if cfg!(windows) {
        // The screen starts as node-pty's console started it: cleared, the cursor top left.
        assert!(
            term.first.as_deref().unwrap().starts_with("\x1b[2J\x1b[H"),
            "{:?}",
            term.first
        );
    }
    let shell_pid = term.shell_pid().await;
    let here = if cfg!(windows) {
        "(Get-Location).Path"
    } else {
        "\"$(pwd)\""
    };
    term.input(&say("cwd", here)).await;
    let ran_in = term.wait_for(r"cwd=([^\r\n]+)").await;
    assert_eq!(
        std::fs::canonicalize(ran_in.trim()).unwrap(),
        std::fs::canonicalize(&cwd).unwrap()
    );
    // The environment the shell was given, and nothing from this process's own.
    let term_var = if cfg!(windows) {
        "$env:TERM + \"/\" + $env:COLORTERM"
    } else {
        "\"$TERM/$COLORTERM\""
    };
    term.input(&say("vars", term_var)).await;
    assert_eq!(
        term.wait_for(r"vars=([^\r\n]+)").await.trim(),
        "xterm-256color/truecolor"
    );
    let read = |name: &str| {
        if cfg!(windows) {
            format!("\"[\" + $env:{name} + \"]\"")
        } else {
            format!("\"[${{{name}}}]\"")
        }
    };
    term.input(&say("canary", &read(CANARY.0))).await;
    assert_eq!(term.wait_for(r"canary=\[([^\]\r\n]*)\]").await, CANARY.1);
    let (real_only, value) = real_only_variable();
    assert!(!value.is_empty());
    term.input(&say("leak", &read(&real_only))).await;
    assert_eq!(
        term.wait_for(r"leak=\[([^\]\r\n]*)\]").await,
        "",
        "the shell sees {real_only} from the server's real environment"
    );

    // Text outside ASCII both ways.
    term.input(&say("word", "\"ñé🐒\"")).await;
    assert_eq!(term.wait_for(r"word=([^\r\n]+)").await.trim(), "ñé🐒");

    // A resize reaches the shell.
    term.send(json!({"type": "resize", "cols": 100, "rows": 40})).await;
    // Columns by rows in PowerShell; `stty size` gives rows, then columns.
    let (size, want) = if cfg!(windows) {
        (
            "$Host.UI.RawUI.WindowSize.Width + \"x\" + $Host.UI.RawUI.WindowSize.Height",
            "100x40",
        )
    } else {
        ("\"$(stty size | tr ' ' x)\"", "40x100")
    };
    term.input(&say("size", size)).await;
    assert_eq!(term.wait_for(r"size=([0-9]+x[0-9]+)").await, want);

    // The keepalive.
    term.send(json!({"type": "ping"})).await;
    assert_eq!(term.wait_message("pong").await, json!({"type": "pong"}));

    // Something the shell started, still running when the socket closes.
    let child = if cfg!(windows) {
        "$p = Start-Process -PassThru -NoNewWindow -FilePath ping.exe -ArgumentList '-n','600','127.0.0.1' -RedirectStandardOutput NUL; Write-Output (\"child=\" + $p.Id)\r"
            .to_string()
    } else {
        "sleep 600 & echo child\"=\"$!\r".to_string()
    };
    term.input(&child).await;
    let child_pid: u32 = term.wait_for(r"child=([0-9]+)").await.parse().unwrap();
    assert!(running(shell_pid) && running(child_pid));
    let mut others = vec![child_pid];
    if cfg!(windows) {
        // One in a console of its own (a hidden window), which closing the terminal's console does not end.
        term.input(concat!(
            "$q = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe ",
            "-ArgumentList '-n','600','127.0.0.1'; Write-Output (\"hidden=\" + $q.Id)\r"
        ))
        .await;
        let hidden: u32 = term.wait_for(r"hidden=([0-9]+)").await.parse().unwrap();
        assert!(running(hidden));
        others.push(hidden);
        // And a grandchild in such a console: a hidden cmd.exe that runs ping.
        term.input(concat!(
            "$c = Start-Process -PassThru -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '/c ping -n 600 127.0.0.1'; ",
            "do { Start-Sleep -Milliseconds 200; ",
            "$g = Get-CimInstance Win32_Process -Filter (\"ParentProcessId=\" + $c.Id + \" AND Name='PING.EXE'\") } ",
            "until ($g); Write-Output (\"grand=\" + $g.ProcessId)\r"
        ))
        .await;
        let grandchild: u32 = term.wait_for(r"grand=([0-9]+)").await.parse().unwrap();
        assert!(running(grandchild));
        others.push(grandchild);
    }
    // A process outside the shell's tree, which must outlive it.
    let mut stranger = outsider();

    term.ws.close(None).await.unwrap();
    assert!(gone(shell_pid).await, "the shell is still running");
    for pid in others {
        assert!(gone(pid).await, "what the shell started is still running ({pid})");
    }
    until_closed_count(&server.t.app).await;
    assert_eq!(get_active_terminal_count(&server.t.app), 0);
    assert!(running(stranger.id()), "a process the shell did not start was ended");
    let _ = stranger.kill();
    let _ = stranger.wait();

    // Connected, the socket closed (and the shell with it), then the shell's end.
    let until = tokio::time::Instant::now() + WAIT;
    let mut actions = audit_actions(&server.t.app);
    while actions.len() < 3 && tokio::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
        actions = audit_actions(&server.t.app);
    }
    let names: Vec<&str> = actions.iter().map(|(a, _, _)| a.as_str()).collect();
    assert_eq!(names, ["terminal.connect", "terminal.disconnect", "terminal.exit"]);
    assert_eq!(actions[0].1, json!({"terminalId": terminal_id}));
    assert_eq!(actions[0].2.as_deref(), Some("203.0.113.9"));
    assert_eq!(actions[1].1, json!({"terminalId": terminal_id}));
    assert_eq!(actions[2].1["terminalId"], json!(terminal_id));
    if cfg!(windows) {
        assert_eq!(actions[2].1, json!({"terminalId": terminal_id, "exitCode": 1}));
    } else {
        // SIGHUP, as node-pty sent.
        assert_eq!(
            actions[2].1,
            json!({"terminalId": terminal_id, "exitCode": 0, "signal": 1})
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn when_the_shell_exits_the_browser_gets_its_code_and_the_socket_closes_with_1000() {
    let server = server().await;
    let mut term = Term::open(&server).await;
    let connected = term.next().await;
    let terminal_id = connected["terminalId"].as_str().unwrap().to_string();
    term.input(&say("ready", "1")).await;
    term.wait_for(r"ready=1").await;
    term.input("exit 3\r").await;
    let exit = term.wait_message("exit").await;
    // The terminal is no longer counted once its shell has ended, before the socket's close is done.
    assert_eq!(get_active_terminal_count(&server.t.app), 0);
    if cfg!(windows) {
        assert_eq!(exit, json!({"type": "exit", "exitCode": 3}));
    } else {
        assert_eq!(exit, json!({"type": "exit", "exitCode": 3, "signal": 0}));
    }
    assert_eq!(
        term.wait_message("close").await,
        json!({"close": [1000, "Terminal process exited"]})
    );
    // The browser answers the close; the socket is then done.
    term.finish().await;
    until_closed_count(&server.t.app).await;
    let until = tokio::time::Instant::now() + WAIT;
    let mut actions = audit_actions(&server.t.app);
    while actions.len() < 3 && tokio::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
        actions = audit_actions(&server.t.app);
    }
    let names: Vec<&str> = actions.iter().map(|(a, _, _)| a.as_str()).collect();
    assert_eq!(names, ["terminal.connect", "terminal.exit", "terminal.disconnect"]);
    let mut want = json!({"terminalId": terminal_id, "exitCode": 3});
    if cfg!(unix) {
        want["signal"] = json!(0);
    }
    assert_eq!(actions[1].1, want);
}

#[tokio::test(flavor = "multi_thread")]
async fn messages_it_cannot_read_are_ignored_and_the_terminal_carries_on() {
    let server = server().await;
    let mut term = Term::open(&server).await;
    term.next().await;
    for bad in [
        "not json",
        "null",
        "5",
        r#"{"type": "input", "data": 5}"#,
        r#"{"type": "resize", "cols": -1, "rows": 10}"#,
        r#"{"type": "resize", "cols": "80", "rows": 10}"#,
        r#"{"type": "resize", "cols": 0, "rows": 10}"#,
        r#"{"type": "nothing"}"#,
    ] {
        term.ws.send(Message::Text(bad.into())).await.unwrap();
    }
    // A message in a binary frame is read like a text one, as the Node `ws` gave both as a Buffer.
    term.ws
        .send(Message::Binary(json!({"type": "ping"}).to_string().into_bytes().into()))
        .await
        .unwrap();
    assert_eq!(term.wait_message("pong").await, json!({"type": "pong"}));
    term.input(&say("still", "\"here\"")).await;
    assert_eq!(term.wait_for(r"still=([a-z]+)").await, "here");
    let shell_pid = term.shell_pid().await;
    drop(term);
    assert!(gone(shell_pid).await, "a dropped connection ends the shell too");
}

/// Where in a session the connection is reset.
#[derive(Debug, Clone, Copy)]
enum Stage {
    /// Right after the upgrade, before `connected` can be sent.
    BeforeConnected,
    /// After `connected`, before the shell's first output.
    AfterConnected,
    /// While the shell's output streams.
    DuringOutput,
    /// Right after a large input.
    DuringInput,
}

async fn reset_at(stage: Stage) {
    let server = server().await;
    let mut term = Term::open(&server).await;
    let mut pid = None;
    match stage {
        Stage::BeforeConnected => {}
        Stage::AfterConnected => {
            assert_eq!(term.next().await["type"], "connected");
        }
        Stage::DuringOutput => {
            term.next().await;
            pid = Some(term.shell_pid().await);
            let lots = if cfg!(windows) {
                "1..200000 | ForEach-Object { \"line $_\" }\r"
            } else {
                "seq 1 3000000 | sed 's/^/line /'\r"
            };
            term.input(lots).await;
            term.wait_for(r"line 2000[^0-9]").await;
        }
        Stage::DuringInput => {
            term.next().await;
            pid = Some(term.shell_pid().await);
            term.input(&"x".repeat(300_000)).await;
        }
    }
    reset(term.ws);
    if let Some(pid) = pid {
        assert!(gone(pid).await, "{stage:?}: the shell is still running");
    }
    // The exit's audit line is written once the shell has really ended.
    assert_eq!(
        session_over(&server.t.app).await,
        ["terminal.connect", "terminal.disconnect", "terminal.exit"],
        "{stage:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_reset_before_connected_still_ends_the_shell() {
    reset_at(Stage::BeforeConnected).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_reset_between_connected_and_the_first_output_ends_the_shell() {
    reset_at(Stage::AfterConnected).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_reset_while_output_streams_ends_the_shell() {
    reset_at(Stage::DuringOutput).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_reset_during_input_ends_the_shell() {
    reset_at(Stage::DuringInput).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn when_the_terminal_task_is_dropped_half_way_the_shell_still_ends() {
    // Dropped while it runs.
    let stop = CancellationToken::new();
    let server = stoppable_server(stop.clone()).await;
    let mut term = Term::open(&server).await;
    term.next().await;
    let pid = term.shell_pid().await;
    stop.cancel();
    assert!(gone(pid).await, "the shell outlived its task");
    assert_eq!(
        session_over(&server.t.app).await,
        ["terminal.connect", "terminal.disconnect", "terminal.exit"]
    );
    // Dropped while the shell is still being started.
    let stop = CancellationToken::new();
    let server = stoppable_server(stop.clone()).await;
    let _term = Term::open(&server).await;
    stop.cancel();
    assert_eq!(
        session_over(&server.t.app).await,
        ["terminal.connect", "terminal.disconnect", "terminal.exit"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_close_the_browser_starts_is_answered_and_ends_the_shell() {
    let server = server().await;
    let mut term = Term::open(&server).await;
    term.next().await;
    let pid = term.shell_pid().await;
    term.ws
        .close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "bye".into(),
        }))
        .await
        .unwrap();
    // `ws` answered with the same code and reason, then ended the connection.
    let answer = loop {
        match tokio::time::timeout(WAIT, term.ws.next()).await.unwrap() {
            Some(Ok(Message::Close(frame))) => break frame,
            Some(Ok(_)) => continue,
            other => panic!("no answer to the close: {other:?}"),
        }
    };
    let answer = answer.unwrap();
    assert_eq!((u16::from(answer.code), answer.reason.as_str()), (1000, "bye"));
    assert!(
        tokio::time::timeout(WAIT, term.ws.next()).await.unwrap().is_none(),
        "the connection ends cleanly after the close"
    );
    assert!(gone(pid).await);
    assert_eq!(
        session_over(&server.t.app).await,
        ["terminal.connect", "terminal.disconnect", "terminal.exit"]
    );
}

// The server's tasks run on this test's thread, so its log lines are captured.
#[tokio::test]
async fn a_connection_that_drops_logs_that_the_socket_closed_and_no_error() {
    let logs = CapturedLogs::start();
    let server = server().await;
    let mut term = Term::open(&server).await;
    let connected = term.next().await;
    let terminal_id = connected["terminalId"].as_str().unwrap().to_string();
    let pid = term.shell_pid().await;
    // Gone without a close frame: the TCP connection just ends.
    drop(term);
    assert!(gone(pid).await);
    session_over(&server.t.app).await;
    assert!(
        logs.errors().iter().all(|line| !line.contains("WebSocket error")),
        "{:?}",
        logs.errors()
    );
    assert!(
        logs.infos()
            .contains(&format!("[terminal] WebSocket closed for {terminal_id}")),
        "{:?}",
        logs.infos()
    );
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_pathext_with_an_empty_entry_still_starts_the_shell_as_node_pty_did() {
    let server = server_with(vec![("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD;".into())]).await;
    let mut term = Term::open(&server).await;
    assert_eq!(term.next().await["type"], "connected");
    term.input(&say("ready", "1")).await;
    term.wait_for(r"ready=1").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cleanup_all_terminals_ends_every_shell_and_each_browser_is_told() {
    let server = server().await;
    let mut a = Term::open(&server).await;
    let mut b = Term::open(&server).await;
    a.next().await;
    b.next().await;
    let mut pids = Vec::new();
    for term in [&mut a, &mut b] {
        pids.push(term.shell_pid().await);
    }
    assert_eq!(get_active_terminal_count(&server.t.app), 2);
    cleanup_all_terminals(&server.t.app);
    assert_eq!(get_active_terminal_count(&server.t.app), 0);
    for term in [&mut a, &mut b] {
        assert_eq!(term.wait_message("exit").await["type"], "exit");
        assert_eq!(
            term.wait_message("close").await,
            json!({"close": [1000, "Terminal process exited"]})
        );
        term.finish().await;
    }
    for pid in pids {
        assert!(gone(pid).await);
    }
}

/// Starts a terminal in this environment, which cannot start a shell, and gives the answer.
async fn cannot_start(env: Vec<(String, String)>) -> String {
    let t = test_app_with_env(env);
    let router = Router::new()
        .route(
            "/terminal",
            any(
                |State(app): State<App>, upgrade: WebSocketUpgrade| async move { terminal_upgrade(app, upgrade, None) },
            ),
        )
        .with_state(t.app.clone());
    let addr = serve(router).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/terminal"))
        .await
        .unwrap();
    let first = tokio::time::timeout(WAIT, ws.next()).await.unwrap().unwrap().unwrap();
    let value: Value = serde_json::from_str(first.to_text().unwrap()).unwrap();
    assert_eq!(value["type"], "error");
    match tokio::time::timeout(WAIT, ws.next()).await.unwrap() {
        Some(Ok(Message::Close(Some(frame)))) => {
            assert_eq!(frame.code, CloseCode::from(1011));
            assert_eq!(frame.reason.as_str(), "PTY spawn failed");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(get_active_terminal_count(&t.app), 0);
    value["message"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shell_that_cannot_start_is_an_error_message_and_a_1011_close() {
    // No folder to find the shell in.
    let empty = tmp_dir();
    let folder = empty.path().to_string_lossy().into_owned();
    let mut env = vec![("CLAUDE_WORKSPACE_DIR".to_string(), folder.clone())];
    for name in ["PATH", "Path"] {
        env.push((name.to_string(), folder.clone()));
    }
    let message = cannot_start(env.clone()).await;
    assert!(message.starts_with("Failed to spawn shell: "), "{message}");
    if cfg!(windows) {
        // Not found, portable-pty tries each PATHEXT entry and panics on an empty one: still an answer, never a
        // panic's report.
        env.push(("PATHEXT".to_string(), ".COM;.EXE;".to_string()));
        let message = cannot_start(env).await;
        assert!(message.starts_with("Failed to spawn shell: "), "{message}");
        assert!(!message.contains("panicked"), "{message}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_past_64_mib_still_gets_through_as_the_node_server_took_up_to_100() {
    let server = server().await;
    let mut term = Term::open(&server).await;
    term.next().await;
    let padding = "x".repeat(65 * 1024 * 1024);
    term.send(json!({"type": "ping", "padding": padding})).await;
    assert_eq!(term.wait_message("pong").await, json!({"type": "pong"}));
}
