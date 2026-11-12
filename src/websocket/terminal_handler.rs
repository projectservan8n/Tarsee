//! Port of `src/websocket/terminal-handler.js`: the web terminal. A WebSocket that carries a shell running in a
//! pseudo-terminal on the Tarsee server, for running commands from the browser (Claude CLI sign-in and other admin
//! tasks).
//!
//! Who may open it is decided before the upgrade (`channels/websocket.rs` checks the sign-in or the API token, as the
//! Node `server.on("upgrade")` did); this file takes the socket from there.
//!
//! The messages, as `src/public/js/terminal.js` sends and expects them (JSON text):
//!
//! - browser to server: `{type: "input", data}` (keystrokes for the shell), `{type: "resize", cols, rows}`,
//!   `{type: "ping"}`.
//! - server to browser: `{type: "connected", terminalId, shell, cwd}` first, then `{type: "data", data}` (the
//!   shell's output), `{type: "pong"}`, and `{type: "exit", exitCode, signal}` when the shell ends (`signal` only
//!   where Unix has one), after which the socket is closed with 1000 "Terminal process exited".
//!   `{type: "error", message}` and a close with 1011 when the shell cannot be started.
//!
//! The Node version used `node-pty`; this one uses `portable-pty`, whose calls block. The shell's output is read on
//! a thread of its own, keystrokes are written on another, and a third waits for the shell to end; channels carry
//! everything to and from the socket's task.
//!
//! In Node the socket's `close` event always came and ended the shell. Here the socket's task can stop anywhere (the
//! connection reset, a send failing, the task dropped, a panic), so a started shell is held by a [`Session`] whose
//! drop does what the `close` event did: the shell and what it started are ended, the terminal stops being counted,
//! and the audit lines are written.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderName};
use axum::response::Response;
use futures::SinkExt;
use parking_lot::{Condvar, Mutex};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::app::{App, WeakApp};
use crate::db::audit::{AuditEntry, AuditLog};
use crate::middleware::auth::{js_number, node_header};
use crate::util::js::{now_ms, truthy};

/// The largest message the socket takes: the `ws` package's default `maxPayload` (100 MiB), which the Node server
/// kept.
pub const MAX_PAYLOAD: usize = 100 * 1024 * 1024;

/// The pseudo-terminal's size until the browser sends its own.
const COLS: u16 = 80;
const ROWS: u16 = 30;

/// After the shell has ended on Unix, how long its last output may take to arrive (`node-pty`'s
/// `DESTROY_SOCKET_TIMEOUT_MS`).
#[cfg(not(windows))]
const OUTPUT_AFTER_EXIT: Duration = Duration::from_millis(200);
/// After the shell has ended on Windows, how long the console may stay quiet before it is closed (`node-pty`'s
/// `FLUSH_DATA_INTERVAL`): its output can come after the process has gone.
#[cfg(windows)]
const OUTPUT_AFTER_EXIT: Duration = Duration::from_millis(1000);

/// How long a closed console's last output may take before the exit is reported regardless.
const CLOSE_GRACE: Duration = Duration::from_secs(5);
/// How long a shell sent SIGHUP may take to end before it and its process group are killed outright.
#[cfg(unix)]
const HANGUP_GRACE: Duration = Duration::from_secs(3);
/// How long the browser has to answer our close (the `ws` package's `closeTimeout`).
const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

/// The cursor position request the Windows console sends before it draws, and the answer that puts it top left.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_TOP_LEFT: &[u8] = b"\x1b[1;1R";
/// What `node-pty`'s console sent first instead: clear the screen, cursor top left.
const CLEAR_SCREEN: &str = "\x1b[2J\x1b[H";

/// The shell the terminal runs: PowerShell on Windows, bash elsewhere.
pub fn shell() -> &'static str {
    if cfg!(windows) { "powershell.exe" } else { "bash" }
}

/// The folder the shell starts in (`config.CLAUDE_WORKSPACE_DIR || process.cwd()`).
pub fn working_folder(app: &App) -> PathBuf {
    let dir = &app.config().claude_workspace_dir;
    if dir.as_os_str().is_empty() {
        // The Node `process.cwd()`; the configuration always names a folder, so this is a formality.
        std::env::current_dir().unwrap_or_default()
    } else {
        dir.clone()
    }
}

/// The environment the shell gets: the server's own, with `TERM=xterm-256color` and `COLORTERM=truecolor`
/// (`{ ...process.env, TERM, COLORTERM }`), and on Unix `PWD`, which `node-pty` set to the working folder. On
/// Windows a name matches whatever its case, as in `process.env`: a `term` already there is replaced, not kept beside.
pub fn shell_env(app: &App) -> BTreeMap<String, String> {
    let mut env = app.env().snapshot();
    let mut put = |name: &str, value: String| {
        if cfg!(windows) {
            env.retain(|k, _| !k.eq_ignore_ascii_case(name));
        }
        env.insert(name.to_string(), value);
    };
    put("TERM", "xterm-256color".to_string());
    put("COLORTERM", "truecolor".to_string());
    if cfg!(unix) {
        put("PWD", working_folder(app).to_string_lossy().into_owned());
    }
    env
}

/// The program to start for [`shell`]. On Windows it is found as `node-pty`'s `CreateProcessW` found it: the first
/// folder of `PATH` (whatever the case of its name) that holds it. portable-pty would look it up itself, trying each
/// `PATHEXT` entry in each folder, and an empty entry there (a trailing `;`) makes it panic; given the full path it
/// looks no further. Not found, the bare name is given and the start fails with portable-pty's words.
fn shell_program(env: &BTreeMap<String, String>) -> PathBuf {
    if cfg!(windows)
        && let Some((_, path)) = env.iter().find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
    {
        for dir in std::env::split_paths(path) {
            let candidate = dir.join(shell());
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from(shell())
}

/// The client's address for the audit log: `req.headers["x-forwarded-for"] || req.socket.remoteAddress` (the whole
/// header as sent, not one hop of it).
pub fn terminal_client_ip(headers: &HeaderMap, remote: Option<SocketAddr>) -> Option<String> {
    static X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");
    node_header(headers, &X_FORWARDED_FOR)
        .filter(|forwarded| !forwarded.is_empty())
        .or_else(|| remote.map(|address| address.ip().to_string()))
}

/// `term-<ms>-<9 base-36 characters>`.
fn generate_terminal_id() -> String {
    use rand::RngExt;
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    let suffix: String = (0..9)
        .map(|_| DIGITS[rng.random_range(0..DIGITS.len())] as char)
        .collect();
    format!("term-{}-{suffix}", now_ms())
}

// ---------------------------------------------------------------- the open terminals

/// The terminals open now (the JS module's `terminals` map), for the count and for shutdown.
#[derive(Default)]
pub struct Terminals {
    open: Mutex<HashMap<String, Arc<Shell>>>,
}

impl Terminals {
    /// The app's terminals, made on first use.
    pub fn of(app: &App) -> Arc<Terminals> {
        app.get_or_init(Terminals::default)
    }

    fn insert(&self, id: &str, shell: Arc<Shell>) {
        self.open.lock().insert(id.to_string(), shell);
    }

    fn remove(&self, id: &str) -> Option<Arc<Shell>> {
        self.open.lock().remove(id)
    }
}

/// Get active terminal count (for monitoring).
pub fn get_active_terminal_count(app: &App) -> usize {
    Terminals::of(app).open.lock().len()
}

/// Clean up all terminals (for graceful shutdown).
pub fn cleanup_all_terminals(app: &App) {
    let terminals = Terminals::of(app);
    let all: Vec<(String, Arc<Shell>)> = terminals.open.lock().drain().collect();
    for (id, shell) in all {
        log::info!("[terminal] Cleaning up terminal: {id}");
        shell.kill();
    }
}

// ---------------------------------------------------------------- the shell in its pseudo-terminal

/// How the shell ended: `exitCode`, and on Unix `signal` (0 when it was not ended by one; `node-pty` gave none on
/// Windows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellExit {
    pub exit_code: i64,
    pub signal: Option<i64>,
}

impl ShellExit {
    fn signal_text(&self) -> String {
        self.signal
            .map(|s| s.to_string())
            .unwrap_or_else(|| "undefined".to_string())
    }
}

/// How the shell ended, once it has: for a kill waiting to see whether it has to insist, and for a session that
/// stopped before the shell did and still owes the exit's log and audit lines.
#[derive(Default)]
struct Ended {
    status: Mutex<Option<ShellExit>>,
    changed: Condvar,
}

impl Ended {
    fn set(&self, status: ShellExit) {
        *self.status.lock() = Some(status);
        self.changed.notify_all();
    }

    /// The exit, if it comes within `wait`.
    #[cfg(unix)]
    fn wait_for(&self, wait: Duration) -> Option<ShellExit> {
        let mut status = self.status.lock();
        if status.is_none() {
            self.changed.wait_for(&mut status, wait);
        }
        *status
    }

    /// The exit, however long it takes.
    fn wait(&self) -> ShellExit {
        let mut status = self.status.lock();
        loop {
            if let Some(exit) = *status {
                return exit;
            }
            self.changed.wait(&mut status);
        }
    }
}

/// A Windows job object holding the shell and everything it starts: ending the job ends exactly those processes,
/// whatever their ids, and closing its last handle does the same (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), so they
/// end with the server too.
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a job handle may be used and closed from any thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    /// A new job that ends its processes when closed, with `process` in it.
    fn holding(process: std::os::windows::io::RawHandle) -> Result<Job, String> {
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
        };
        // SAFETY: plain Win32 calls; the limit structure is zeroed, then one flag set, and passed with its size. The
        // job's handle is owned by the returned value (closed on drop, also on the error paths below).
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(format!("CreateJobObjectW failed, error {}", GetLastError()));
            }
            let job = Job(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(format!("SetInformationJobObject failed, error {}", GetLastError()));
            }
            if AssignProcessToJobObject(job.0, process.cast()) == 0 {
                return Err(format!("AssignProcessToJobObject failed, error {}", GetLastError()));
            }
            Ok(job)
        }
    }

    /// Ends every process in the job (exit code 1, as `process.kill` gave on Windows).
    fn terminate(&self) {
        // SAFETY: a call on the handle this value owns.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this value and closed once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// A running shell: what it takes to resize its terminal and to end it.
pub struct Shell {
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: Option<u32>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Windows: the job the shell and everything it starts are in; `None` when the shell could not be put in one.
    #[cfg(windows)]
    job: Mutex<Option<Job>>,
    ended: Arc<Ended>,
}

impl Shell {
    fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        match self.master.lock().as_ref() {
            Some(master) => master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }),
            None => Ok(()),
        }
    }

    /// Closes the pseudo-terminal (Windows: `ClosePseudoConsole`, which can wait for the console to finish, so on a
    /// thread of its own). The shell's output then ends.
    fn close_terminal(self: &Arc<Self>) {
        let shell = self.clone();
        let closing = std::thread::Builder::new()
            .name("terminal-close".into())
            .spawn(move || drop(shell.master.lock().take()));
        if closing.is_err() {
            drop(self.master.lock().take());
        }
    }

    fn kill_child(&self) {
        if let Err(err) = self.killer.lock().kill() {
            log::error!("[terminal] Error killing PTY: {err}");
        }
    }

    /// Ends the shell and what it started. Unix: SIGHUP, as `node-pty` sent (bash passes it on to its jobs), and if
    /// the shell is still there after a grace period, SIGKILL to it and its process group. Windows: the shell's job
    /// is ended, which ends the shell and every process it started and nothing else (`node-pty` ended the processes
    /// attached to the console); without a job, the shell alone through its handle. Then the terminal is closed.
    fn kill(self: &Arc<Self>) {
        #[cfg(unix)]
        match self.pid.and_then(|p| i32::try_from(p).ok()) {
            Some(pid) => {
                // SAFETY: kill(2) only sends a signal; a process that is gone makes it fail with ESRCH, nothing more.
                unsafe {
                    libc::kill(pid, libc::SIGHUP);
                }
                let ended = self.ended.clone();
                let _ = std::thread::Builder::new()
                    .name("terminal-kill".into())
                    .spawn(move || {
                        if ended.wait_for(HANGUP_GRACE).is_none() {
                            // SAFETY: as above.
                            unsafe {
                                if libc::kill(-pid, libc::SIGKILL) != 0 {
                                    libc::kill(pid, libc::SIGKILL);
                                }
                            }
                        }
                    });
            }
            None => self.kill_child(),
        }
        #[cfg(windows)]
        match self.job.lock().take() {
            Some(job) => job.terminate(),
            None => self.kill_child(),
        }
        #[cfg(not(any(unix, windows)))]
        self.kill_child();
        self.close_terminal();
    }
}

/// The ends of the shell's pipes the socket's task uses.
struct Pipes {
    /// The shell's output, as it is read; closed when the terminal has no more.
    output: mpsc::Receiver<Vec<u8>>,
    /// Keystrokes for the shell, written in order on the writer's thread.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    exit: oneshot::Receiver<ShellExit>,
}

/// The panic's message, for a panic inside the pseudo-terminal library.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "the pseudo-terminal library failed".to_string())
}

/// Starts the shell in a pseudo-terminal of 80 by 30, in the working folder, with [`shell_env`]. Blocking. A panic
/// inside portable-pty is caught and answered as a shell that could not start.
fn spawn_shell(app: &App) -> Result<(Arc<Shell>, Pipes), String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start_shell(app))) {
        Ok(started) => started.map_err(|err| format!("{err:#}")),
        Err(payload) => Err(panic_text(&*payload)),
    }
}

fn start_shell(app: &App) -> anyhow::Result<(Arc<Shell>, Pipes)> {
    let pair = native_pty_system().openpty(PtySize {
        rows: ROWS,
        cols: COLS,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let env = shell_env(app);
    let mut command = CommandBuilder::new(shell_program(&env));
    // The environment is exactly the one built here; portable-pty would otherwise start from the real one.
    command.env_clear();
    for (name, value) in env {
        command.env(name, value);
    }
    command.cwd(working_folder(app));
    let mut child = pair.slave.spawn_command(command)?;
    // The slave side now belongs to the shell; the output ends when the shell and what it started have let go of it.
    drop(pair.slave);

    // Windows: the shell goes in a job at once, before it can start anything.
    #[cfg(windows)]
    let job = match child.as_raw_handle().map(Job::holding) {
        Some(Ok(job)) => Some(job),
        Some(Err(err)) => {
            log::warn!(
                "[terminal] Could not put the shell in a job object ({err}): closing the terminal will end the shell alone"
            );
            None
        }
        None => {
            log::warn!(
                "[terminal] Could not put the shell in a job object (no process handle): closing the terminal will end the shell alone"
            );
            None
        }
    };

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let ended = Arc::new(Ended::default());
    let shell = Arc::new(Shell {
        pid: child.process_id(),
        killer: Mutex::new(child.clone_killer()),
        master: Mutex::new(Some(pair.master)),
        #[cfg(windows)]
        job: Mutex::new(job),
        ended: ended.clone(),
    });

    let (output_tx, output) = mpsc::channel::<Vec<u8>>(64);
    std::thread::Builder::new()
        .name("terminal-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    // EIO on Unix once nothing holds the terminal any more; a broken pipe on Windows.
                    Err(_) => break,
                }
            }
        })?;

    let (input, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name("terminal-write".into())
        .spawn(move || {
            while let Ok(bytes) = input_rx.recv() {
                if let Err(err) = writer.write_all(&bytes).and_then(|_| writer.flush()) {
                    log::error!("Unhandled pty write error {err}");
                }
            }
        })?;

    let (exit_tx, exit) = oneshot::channel();
    std::thread::Builder::new()
        .name("terminal-wait".into())
        .spawn(move || {
            let status = wait_for(&mut *child);
            ended.set(status);
            let _ = exit_tx.send(status);
        })?;

    Ok((shell, Pipes { output, input, exit }))
}

/// Waits for the shell to end. Unix: the exit code, or 0 and the signal that ended it, as `node-pty` gave them.
fn wait_for(child: &mut (dyn portable_pty::Child + Send + Sync)) -> ShellExit {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(std_child) = child.as_any_mut().downcast_mut::<std::process::Child>() {
            return match std_child.wait() {
                Ok(status) => ShellExit {
                    exit_code: status.code().map(i64::from).unwrap_or(0),
                    signal: Some(status.signal().map(i64::from).unwrap_or(0)),
                },
                Err(_) => ShellExit {
                    exit_code: 0,
                    signal: Some(0),
                },
            };
        }
    }
    let code = child.wait().map(|s| i64::from(s.exit_code())).unwrap_or(0);
    ShellExit {
        exit_code: code,
        signal: if cfg!(unix) { Some(0) } else { None },
    }
}

// ---------------------------------------------------------------- the session

fn audit(app: &App, entry: AuditEntry) {
    if let Some(audit_log) = app.get::<AuditLog>() {
        audit_log.log(entry);
    }
}

/// The shell's end, as Node's `onExit` reported it: the log line, the terminal no longer counted, the audit line.
fn report_exit(app: &App, terminal_id: &str, terminals: &Terminals, status: ShellExit) {
    log::info!(
        "[terminal] Terminal {terminal_id} exited: code={}, signal={}",
        status.exit_code,
        status.signal_text()
    );
    terminals.remove(terminal_id);
    let mut detail = json!({ "terminalId": terminal_id, "exitCode": status.exit_code });
    if let Some(signal) = status.signal {
        detail["signal"] = json!(signal);
    }
    audit(
        app,
        AuditEntry::new("terminal.exit")
            .actor("session-user")
            .detail(detail.to_string()),
    );
}

/// A started shell, from the moment it is counted until its session is over. Whatever ends the socket's task (the
/// socket closing, a reset, a send failing, the task dropped, a panic), dropping this does what Node's `close` and
/// `exit` handlers did and the task did not get to: the socket's close is logged and audited, the shell and what it
/// started are ended, and the shell's exit is logged and audited when it comes.
struct Session {
    app: App,
    terminal_id: String,
    terminals: Arc<Terminals>,
    shell: Arc<Shell>,
    /// The socket's close has been handled (`ws.on("close")`).
    socket_done: bool,
    /// The shell's exit has been reported (`ptyProcess.onExit`).
    exit_done: bool,
}

impl Session {
    /// Counts the shell as an open terminal (`terminals.set`) and takes charge of it.
    fn start(app: &App, terminal_id: &str, shell: Arc<Shell>) -> Session {
        let terminals = Terminals::of(app);
        terminals.insert(terminal_id, shell.clone());
        Session {
            app: app.clone(),
            terminal_id: terminal_id.to_string(),
            terminals,
            shell,
            socket_done: false,
            exit_done: false,
        }
    }

    /// The socket has closed (Handle WebSocket close): the shell is ended if it is still counted.
    fn socket_closed(&mut self) {
        if self.socket_done {
            return;
        }
        self.socket_done = true;
        log::info!("[terminal] WebSocket closed for {}", self.terminal_id);
        // Kill PTY process
        if let Some(shell) = self.terminals.remove(&self.terminal_id) {
            shell.kill();
        }
        audit(
            &self.app,
            AuditEntry::new("terminal.disconnect")
                .actor("session-user")
                .detail(json!({ "terminalId": self.terminal_id }).to_string()),
        );
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.socket_closed();
        if !self.exit_done {
            // The exit comes once the shell has gone, which the kill above makes sure of; it is reported then, as
            // Node's `onExit` reported it after the socket had closed.
            let app: WeakApp = self.app.downgrade();
            let terminal_id = self.terminal_id.clone();
            let terminals = self.terminals.clone();
            let ended = self.shell.ended.clone();
            let waiting = std::thread::Builder::new()
                .name("terminal-exit".into())
                .spawn(move || {
                    let status = ended.wait();
                    if let Some(app) = app.upgrade() {
                        report_exit(&app, &terminal_id, &terminals, status);
                    }
                });
            if waiting.is_err() {
                log::error!("[terminal] Terminal {} exit will not be reported", self.terminal_id);
            }
        }
        self.shell.close_terminal();
    }
}

// ---------------------------------------------------------------- text out of the terminal

/// Turns the terminal's bytes into text the way Node's `setEncoding("utf8")` did: a character cut between two reads
/// waits for its other half, and a byte that is not UTF-8 becomes U+FFFD.
#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn decode(&mut self, chunk: &[u8]) -> String {
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
                    let (valid, after) = rest.split_at(err.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match err.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &after[len..];
                        }
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// What is left at the end: half a character becomes U+FFFD.
    fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            self.pending.clear();
            "\u{FFFD}".to_string()
        }
    }
}

/// The Windows console portable-pty makes (`PSEUDOCONSOLE_INHERIT_CURSOR`, which it gives no way to leave out)
/// starts by asking where the cursor is, and draws from there. `node-pty`'s console did not ask: it cleared the
/// screen and started top left. So the question is answered here, top left, before anything reaches the browser,
/// and the browser gets the clear screen instead of the question.
struct CursorQuery {
    /// The first output, held until it is clear whether it starts with the question; `None` once decided.
    held: Option<Vec<u8>>,
}

impl CursorQuery {
    fn new() -> Self {
        CursorQuery {
            held: cfg!(windows).then(Vec::new),
        }
    }

    /// What of `chunk` goes on to the browser, and whether the question was found (and is to be answered).
    fn filter(&mut self, chunk: Vec<u8>) -> (Vec<u8>, bool) {
        let Some(mut held) = self.held.take() else {
            return (chunk, false);
        };
        held.extend_from_slice(&chunk);
        if let Some(rest) = held.strip_prefix(CURSOR_QUERY) {
            return (rest.to_vec(), true);
        }
        if CURSOR_QUERY.starts_with(&held) {
            self.held = Some(held);
            return (Vec::new(), false);
        }
        (held, false)
    }

    /// What is still held when the output ends.
    fn finish(&mut self) -> Vec<u8> {
        self.held.take().unwrap_or_default()
    }
}

// ---------------------------------------------------------------- the socket

/// Answers the upgrade with the terminal: the socket takes messages up to [`MAX_PAYLOAD`], as the Node server's did.
/// The caller has checked who is asking.
pub fn terminal_upgrade(app: App, upgrade: WebSocketUpgrade, client_ip: Option<String>) -> Response {
    upgrade
        .max_message_size(MAX_PAYLOAD)
        .max_frame_size(MAX_PAYLOAD)
        .on_upgrade(move |socket| handle_terminal_connection(app, socket, client_ip))
}

async fn send_json(socket: &mut WebSocket, value: Value) -> bool {
    socket.send(Message::Text(value.to_string().into())).await.is_ok()
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

/// The next message, or never when the socket is gone.
async fn next_message(socket: &mut Option<WebSocket>) -> Option<Result<Message, axum::Error>> {
    match socket {
        Some(socket) => socket.recv().await,
        None => std::future::pending().await,
    }
}

/// Whether a failed read is one `ws` reported with an `error` event. A connection that drops or is reset was not
/// (`ws` only closed); a broken frame, a message too large or text that is not UTF-8 was.
fn is_reported_error(err: &axum::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(err);
    while let Some(cause) = source {
        if cause.is::<std::io::Error>() {
            return false;
        }
        source = cause.source();
    }
    let text = err.to_string();
    ![
        "Connection reset without closing handshake",
        "Connection closed normally",
        "Trying to work with closed connection",
        "IO error",
    ]
    .iter()
    .any(|quiet| text.contains(quiet))
}

/// Runs one terminal on an upgraded socket until both the shell and the socket are done.
pub async fn handle_terminal_connection(app: App, socket: WebSocket, client_ip: Option<String>) {
    let mut socket = Some(socket);
    // Auth is already handled at upgrade level
    let terminal_id = generate_terminal_id();
    log::info!("[terminal] New terminal session: {terminal_id}");
    audit(
        &app,
        AuditEntry::new("terminal.connect")
            .actor("session-user")
            .ip(client_ip)
            .detail(json!({ "terminalId": terminal_id }).to_string()),
    );

    let shell_name = shell();
    let cwd = working_folder(&app);
    // The session is made where the shell is started: if this task is dropped while it starts, the session is
    // dropped with the result, and the shell ended.
    let starting = (app.clone(), terminal_id.clone());
    let started = tokio::task::spawn_blocking(move || {
        let (app, terminal_id) = starting;
        spawn_shell(&app).map(|(shell, pipes)| (Session::start(&app, &terminal_id, shell), pipes))
    })
    .await;
    let (mut session, pipes) = match started {
        Ok(Ok(started)) => started,
        Ok(Err(err)) => {
            if let Some(socket) = socket.as_mut() {
                spawn_failed(socket, &err).await;
            }
            return;
        }
        Err(err) => {
            if let Some(socket) = socket.as_mut() {
                spawn_failed(socket, &err.to_string()).await;
            }
            return;
        }
    };
    let Pipes {
        mut output,
        input,
        mut exit,
    } = pipes;
    let shell = session.shell.clone();

    // Send initial terminal ID
    let connected = json!({ "type": "connected", "terminalId": terminal_id, "shell": shell_name, "cwd": cwd.to_string_lossy() });
    if let Some(open) = socket.as_mut()
        && !send_json(open, connected).await
    {
        socket = None;
        session.socket_closed();
    }

    let mut decoder = Utf8Decoder::default();
    let mut cursor_query = CursorQuery::new();
    let mut output_done = false;
    let mut exited: Option<ShellExit> = None;
    // After the shell has ended: when to stop waiting for its last output (Windows: when to close the console).
    let mut drain_until: Option<Instant> = None;
    let mut console_closed = false;

    loop {
        if let Some(status) = exited
            && output_done
        {
            // Handle PTY exit
            log::info!(
                "[terminal] Terminal {terminal_id} exited: code={}, signal={}",
                status.exit_code,
                status.signal_text()
            );
            session.terminals.remove(&terminal_id);
            if let Some(open) = socket.as_mut() {
                let mut message = json!({ "type": "exit", "exitCode": status.exit_code });
                if let Some(signal) = status.signal {
                    message["signal"] = json!(signal);
                }
                send_json(open, message).await;
                close(open, 1000, "Terminal process exited").await;
            }
            let mut detail = json!({ "terminalId": terminal_id, "exitCode": status.exit_code });
            if let Some(signal) = status.signal {
                detail["signal"] = json!(signal);
            }
            audit(
                &app,
                AuditEntry::new("terminal.exit")
                    .actor("session-user")
                    .detail(detail.to_string()),
            );
            session.exit_done = true;
            break;
        }
        tokio::select! {
            message = next_message(&mut socket), if socket.is_some() => match message {
                Some(Ok(Message::Text(text))) => {
                    if let Some(open) = socket.as_mut() {
                        handle_message(open, text.as_bytes(), &shell, &input).await;
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if let Some(open) = socket.as_mut() {
                        handle_message(open, &bytes, &shell, &input).await;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) => {
                    // `ws` answered a close at once and ended the connection; the answer is queued, flushing sends it.
                    if let Some(mut open) = socket.take() {
                        let _ = open.flush().await;
                    }
                    session.socket_closed();
                }
                None => {
                    socket = None;
                    session.socket_closed();
                }
                Some(Err(err)) => {
                    if is_reported_error(&err) {
                        log::error!("[terminal] WebSocket error for {terminal_id}: {err}");
                        // `ws` closed with 1009 on a message over its limit.
                        if err.to_string().contains("Space limit exceeded")
                            && let Some(open) = socket.as_mut()
                        {
                            close(open, 1009, "").await;
                        }
                    }
                    socket = None;
                    session.socket_closed();
                }
            },
            chunk = output.recv(), if !output_done => {
                let text = match chunk {
                    Some(bytes) => {
                        if cfg!(windows) && exited.is_some() && !console_closed {
                            drain_until = Some(Instant::now() + OUTPUT_AFTER_EXIT);
                        }
                        let (bytes, asked) = cursor_query.filter(bytes);
                        if asked {
                            let _ = input.send(CURSOR_TOP_LEFT.to_vec());
                            format!("{CLEAR_SCREEN}{}", decoder.decode(&bytes))
                        } else {
                            decoder.decode(&bytes)
                        }
                    }
                    None => {
                        output_done = true;
                        let held = cursor_query.finish();
                        format!("{}{}", decoder.decode(&held), decoder.finish())
                    }
                };
                if !text.is_empty()
                    && let Some(open) = socket.as_mut()
                    && !send_json(open, json!({ "type": "data", "data": text })).await
                {
                    socket = None;
                    session.socket_closed();
                }
            },
            status = &mut exit, if exited.is_none() => {
                exited = Some(status.unwrap_or(ShellExit { exit_code: 0, signal: if cfg!(unix) { Some(0) } else { None } }));
                drain_until = Some(Instant::now() + OUTPUT_AFTER_EXIT);
            },
            _ = tokio::time::sleep_until(drain_until.unwrap_or_else(Instant::now)), if exited.is_some() && !output_done && drain_until.is_some() => {
                if cfg!(windows) && !console_closed {
                    // The console stays open after its shell has gone; closing it ends the output.
                    console_closed = true;
                    shell.close_terminal();
                    drain_until = Some(Instant::now() + CLOSE_GRACE);
                } else {
                    output_done = true;
                }
            },
        }
    }
    drop(input);

    // After our close, the browser answers with its own; then the socket is done.
    if let Some(mut open) = socket.take() {
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
            loop {
                match open.recv().await {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await;
        drop(open);
        session.socket_closed();
    }
}

async fn spawn_failed(socket: &mut WebSocket, err: &str) {
    log::error!("[terminal] Failed to spawn PTY: {err}");
    send_json(
        socket,
        json!({ "type": "error", "message": format!("Failed to spawn shell: {err}") }),
    )
    .await;
    close(socket, 1011, "PTY spawn failed").await;
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(message)) = socket.recv().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
    })
    .await;
}

/// One message from the browser. A message that cannot be read, or asks for something the terminal cannot do, is
/// logged and otherwise ignored.
async fn handle_message(
    socket: &mut WebSocket,
    bytes: &[u8],
    shell: &Arc<Shell>,
    input: &std::sync::mpsc::Sender<Vec<u8>>,
) {
    if let Err(error) = handle_message_inner(socket, bytes, shell, input).await {
        log::error!("[terminal] Error handling message: {error}");
    }
}

async fn handle_message_inner(
    socket: &mut WebSocket,
    bytes: &[u8],
    shell: &Arc<Shell>,
    input: &std::sync::mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    // `JSON.parse(message)`: the frame's bytes read as UTF-8.
    let msg: Value =
        serde_json::from_str(&String::from_utf8_lossy(bytes)).map_err(|err| format!("SyntaxError: {err}"))?;
    if msg.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'type')".to_string());
    }
    match msg.get("type").and_then(Value::as_str) {
        Some("input") => {
            // User input - write to PTY
            let data = input_bytes(msg.get("data"))?;
            if !data.is_empty() {
                let _ = input.send(data);
            }
        }
        Some("resize") => {
            // Terminal resize
            let (cols, rows) = (msg.get("cols"), msg.get("rows"));
            if let (Some(cols), Some(rows)) = (cols.filter(|v| truthy(v)), rows.filter(|v| truthy(v))) {
                let (cols, rows) = pty_size(cols, rows)?;
                let shell = shell.clone();
                tokio::task::spawn_blocking(move || shell.resize(cols, rows))
                    .await
                    .map_err(|err| err.to_string())?
                    .map_err(|err| format!("Error: {err}"))?;
            }
        }
        Some("ping") => {
            // Keepalive
            send_json(socket, json!({ "type": "pong" })).await;
        }
        _ => {}
    }
    Ok(())
}

/// What `pty.write(msg.data)` wrote: a string as UTF-8; on Unix also a list of numbers as bytes (`Buffer.from`), each
/// taken modulo 256. Anything else made `node-pty` throw.
fn input_bytes(data: Option<&Value>) -> Result<Vec<u8>, String> {
    match data {
        Some(Value::String(text)) => Ok(text.as_bytes().to_vec()),
        #[cfg(unix)]
        Some(Value::Array(items)) => Ok(items
            .iter()
            .map(|item| {
                let n = item.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0).trunc();
                n.rem_euclid(256.0) as u8
            })
            .collect()),
        _ => Err(
            "TypeError [ERR_INVALID_ARG_TYPE]: The \"data\" argument must be of type string or an instance of Buffer"
                .to_string(),
        ),
    }
}

/// `Number(value)` for a JSON value.
fn js_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number(text),
        Value::Array(_) => js_number(&crate::lib::discord_admin::js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// `pty.resize(cols, rows)`: `node-pty` refused anything that is not a positive, finite number, then its native side
/// read each as a 32-bit integer (a value that is not a number made it throw), and the terminal took 16 bits of it.
fn pty_size(cols: &Value, rows: &Value) -> Result<(u16, u16), String> {
    let (c, r) = (js_to_number(cols), js_to_number(rows));
    if c.is_nan() || r.is_nan() || c <= 0.0 || r <= 0.0 || c.is_infinite() || r.is_infinite() {
        return Err("Error: resizing must be done using positive cols and rows".to_string());
    }
    let native = |value: &Value| match value {
        Value::Number(n) => Ok(n.as_f64().unwrap_or(0.0).trunc().rem_euclid(65536.0) as u16),
        _ => Err("Error: A number was expected".to_string()),
    };
    Ok((native(cols)?, native(rows)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{test_app, test_app_with_env, tmp_dir};

    #[test]
    fn the_shell_is_powershell_on_windows_and_bash_elsewhere() {
        assert_eq!(shell(), if cfg!(windows) { "powershell.exe" } else { "bash" });
    }

    #[test]
    fn the_shell_starts_in_the_claude_workspace_folder() {
        let t = test_app();
        assert_eq!(working_folder(&t.app), t.config().claude_workspace_dir);
        let other = t.path().join("elsewhere");
        let t2 = test_app_with_env([("CLAUDE_WORKSPACE_DIR", other.to_string_lossy().to_string())]);
        assert_eq!(working_folder(&t2.app), other);
    }

    #[test]
    fn the_shell_gets_the_servers_environment_with_term_and_colorterm() {
        let t = test_app_with_env([("SOME_KEY", "x"), ("TERM", "dumb")]);
        let env = shell_env(&t.app);
        assert_eq!(env.get("SOME_KEY").map(String::as_str), Some("x"));
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("HOME"), t.env().get("HOME").as_ref());
        if cfg!(unix) {
            assert_eq!(
                env.get("PWD").map(String::as_str),
                Some(t.config().claude_workspace_dir.to_string_lossy().as_ref())
            );
        } else {
            assert_eq!(env.get("PWD"), None);
        }
        // The server's own environment is untouched.
        assert_eq!(t.env().get("TERM").as_deref(), Some("dumb"));
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_a_name_in_another_case_is_replaced_not_kept_beside() {
        let t = test_app_with_env([("Term", "dumb"), ("colorTerm", "no"), ("Path", "C:\\x")]);
        let env = shell_env(&t.app);
        assert!(!env.contains_key("Term") && !env.contains_key("colorTerm"));
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("Path").map(String::as_str), Some("C:\\x"));
    }

    #[test]
    fn the_shell_program_is_found_in_path_on_windows_and_left_to_the_system_elsewhere() {
        let dir = tmp_dir();
        let empty = dir.path().join("empty");
        let holding = dir.path().join("with shell");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&holding).unwrap();
        std::fs::write(holding.join(shell()), b"").unwrap();
        let path = std::env::join_paths([&empty, &holding]).unwrap().into_string().unwrap();
        let env = BTreeMap::from([("Path".to_string(), path), ("PATHEXT".to_string(), ".COM;.EXE;".to_string())]);
        if cfg!(windows) {
            assert_eq!(shell_program(&env), holding.join(shell()));
        } else {
            assert_eq!(shell_program(&env), PathBuf::from(shell()));
        }
        // Nowhere to be found: the bare name.
        let none = BTreeMap::from([("PATH".to_string(), empty.to_string_lossy().into_owned())]);
        assert_eq!(shell_program(&none), PathBuf::from(shell()));
        assert_eq!(shell_program(&BTreeMap::new()), PathBuf::from(shell()));
    }

    #[test]
    fn a_panic_inside_the_library_becomes_its_message() {
        let caught = std::panic::catch_unwind(|| panic!("start byte index 1 is out of bounds of ``")).unwrap_err();
        assert_eq!(panic_text(&*caught), "start byte index 1 is out of bounds of ``");
        let caught = std::panic::catch_unwind(|| std::panic::panic_any(5)).unwrap_err();
        assert_eq!(panic_text(&*caught), "the pseudo-terminal library failed");
    }

    #[test]
    fn the_client_address_is_the_forwarded_header_as_sent_else_the_connection() {
        let mut headers = HeaderMap::new();
        let remote: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        assert_eq!(terminal_client_ip(&headers, Some(remote)).as_deref(), Some("127.0.0.1"));
        assert_eq!(terminal_client_ip(&headers, None), None);
        headers.append("x-forwarded-for", "203.0.113.5, 10.0.0.1".parse().unwrap());
        headers.append("x-forwarded-for", "10.0.0.2".parse().unwrap());
        assert_eq!(
            terminal_client_ip(&headers, Some(remote)).as_deref(),
            Some("203.0.113.5, 10.0.0.1, 10.0.0.2")
        );
        let mut empty = HeaderMap::new();
        empty.insert("x-forwarded-for", "".parse().unwrap());
        assert_eq!(terminal_client_ip(&empty, Some(remote)).as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn a_terminal_id_is_term_the_time_and_nine_base_36_characters() {
        let re = regex::Regex::new("^term-[0-9]{13}-[0-9a-z]{9}$").unwrap();
        let a = generate_terminal_id();
        assert!(re.is_match(&a), "{a}");
        assert_ne!(a, generate_terminal_id());
    }

    #[test]
    fn output_is_decoded_as_utf8_with_a_character_cut_between_reads_kept_for_the_next() {
        let mut d = Utf8Decoder::default();
        let monkey = "🐒".as_bytes();
        assert_eq!(d.decode(b"a"), "a");
        assert_eq!(d.decode(&monkey[..1]), "");
        assert_eq!(d.decode(&monkey[1..3]), "");
        assert_eq!(d.decode(&[monkey[3], b'b']), "🐒b");
        assert_eq!(d.decode(&[0xFF, b'c', 0xC3]), "\u{FFFD}c");
        assert_eq!(d.decode(&[0xA9]), "é");
        assert_eq!(d.decode(&[0xE2, 0x82]), "");
        assert_eq!(d.finish(), "\u{FFFD}");
        assert_eq!(d.finish(), "");
        // A sequence broken off in the middle is replaced and the next byte read afresh.
        assert_eq!(Utf8Decoder::default().decode(&[0xE2, 0x82, b'x']), "\u{FFFD}x");
    }

    #[test]
    fn the_consoles_first_question_is_taken_out_on_windows_even_in_pieces() {
        let mut q = CursorQuery::new();
        if cfg!(windows) {
            assert_eq!(q.filter(b"\x1b[".to_vec()), (Vec::new(), false));
            assert_eq!(q.filter(b"6n\x1b[?9001h".to_vec()), (b"\x1b[?9001h".to_vec(), true));
            // Only the first output is looked at.
            assert_eq!(q.filter(b"\x1b[6n".to_vec()), (b"\x1b[6n".to_vec(), false));
            let mut other = CursorQuery::new();
            assert_eq!(other.filter(b"\x1bX".to_vec()), (b"\x1bX".to_vec(), false));
            let mut cut = CursorQuery::new();
            assert_eq!(cut.filter(b"\x1b".to_vec()), (Vec::new(), false));
            assert_eq!(cut.finish(), b"\x1b".to_vec());
        } else {
            assert_eq!(q.filter(b"\x1b[6n".to_vec()), (b"\x1b[6n".to_vec(), false));
        }
    }

    #[test]
    fn input_is_written_as_utf8_text() {
        assert_eq!(input_bytes(Some(&json!("ls é\r"))).unwrap(), "ls é\r".as_bytes());
        assert!(input_bytes(None).is_err());
        assert!(input_bytes(Some(&json!(5))).is_err());
        assert!(input_bytes(Some(&json!({"a": 1}))).is_err());
        if cfg!(unix) {
            // Buffer.from([...]) on Unix.
            assert_eq!(
                input_bytes(Some(&json!([104, 105, 256, -1, 1.9, "x"]))).unwrap(),
                [104, 105, 0, 255, 1, 0]
            );
        } else {
            assert!(input_bytes(Some(&json!([104]))).is_err());
        }
    }

    #[test]
    fn a_resize_takes_positive_numbers_as_node_pty_did() {
        let size = |c: Value, r: Value| pty_size(&c, &r);
        let positive = Err("Error: resizing must be done using positive cols and rows".to_string());
        let not_number = Err("Error: A number was expected".to_string());
        assert_eq!(size(json!(120), json!(40)), Ok((120, 40)));
        assert_eq!(size(json!(80.9), json!(24.2)), Ok((80, 24)));
        assert_eq!(size(json!(65536 + 100), json!(30)), Ok((100, 30)));
        assert_eq!(size(json!(-5), json!(30)), positive);
        assert_eq!(size(json!(80), json!("abc")), positive);
        assert_eq!(size(json!(" "), json!(30)), positive);
        assert_eq!(size(json!("80"), json!(-1)), positive);
        assert_eq!(size(json!("80"), json!(30)), not_number);
        assert_eq!(size(json!(true), json!(30)), not_number);
        assert_eq!(size(json!([80]), json!(30)), not_number);
        assert_eq!(size(json!({}), json!(30)), positive);
    }

    #[test]
    fn no_terminal_is_open_until_one_is_started_and_cleanup_of_none_does_nothing() {
        let t = test_app();
        assert_eq!(get_active_terminal_count(&t.app), 0);
        cleanup_all_terminals(&t.app);
        assert_eq!(get_active_terminal_count(&t.app), 0);
    }
}
