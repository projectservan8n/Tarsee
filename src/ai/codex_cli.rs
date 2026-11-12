//! Port of `src/ai/codex-cli.js`: running the Codex CLI for the jobs Tarsee does outside a chat turn: the ChatGPT
//! sign-in (`codex_device_login.rs`) and the signed-in account's model list (`codex_models.rs`). Turns themselves go
//! through the Codex engine (`providers/codex.rs`); this is the small part both of those other jobs share:
//!
//! - [`resolve_codex_bin`]: which codex to run: an explicit path, TARSEE_CODEX_PATH (or the Node version's
//!   TARSEE_CODEX_BIN), or `codex` on the PATH
//! - [`codex_child_env`]: the server's environment minus every credential (engine-env's `base_env`, rule R2), plus
//!   CODEX_HOME: a sign-in started here can only ever see its own home
//! - [`spawn_codex`]: start it (a .cmd/.bat shim on Windows goes through cmd.exe, as Node required)
//! - [`kill_tree`]: stop it and everything it started: taskkill /T /F on Windows, the process group elsewhere
//! - [`run_codex`]: run one command to the end with a time limit and capped output
//!
//! [`CODEX_BASE_ARGS`] keep the sign-in in $CODEX_HOME/auth.json (never an OS keyring Tarsee can't see), skip the
//! update check and switch off the project root search (project_root_markers=[]), as every Codex turn does (design
//! 4.8): these jobs run in the Codex home, inside Tarsee's state folder, and without it Codex would take the nearest
//! folder above with .git as a project root and load a .codex/config.toml from each folder between, which no guard
//! reads.
//!
//! What changed from the Node version: it ran the binary the pinned `@openai/codex` npm package installed for the
//! platform. The Rust build has no `node_modules` (design decision 3), so the program is TARSEE_CODEX_PATH when set,
//! else `codex` found on the PATH of the environment it is given.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use parking_lot::Mutex;
use regex::Regex;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

use super::context_limits::is_js_space;
use super::engine_env::{EnvMap, TypeError, base_env, js_trim_path, resolve_path};
use crate::env::Env;
use crate::lib::run_cmd::node_error_code;
use crate::util::js::number_to_string;

pub const CODEX_BASE_ARGS: [&str; 6] = [
    "-c",
    "cli_auth_credentials_store=\"file\"",
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    "project_root_markers=[]",
];

/// Why a codex job can't run (the JS `CodexCliError`'s `code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodexCliCode {
    /// No codex program for this system.
    CodexMissing,
    /// It is there but couldn't be started.
    SpawnFailed,
}

impl CodexCliCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexCliCode::CodexMissing => "codex-missing",
            CodexCliCode::SpawnFailed => "spawn-failed",
        }
    }
}

/// A codex job that can't run.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct CodexCliError {
    pub code: CodexCliCode,
    pub message: String,
}

impl CodexCliError {
    fn new(code: CodexCliCode, message: impl Into<String>) -> Self {
        CodexCliError {
            code,
            message: message.into(),
        }
    }

    fn missing() -> Self {
        Self::new(CodexCliCode::CodexMissing, MISSING_MESSAGE)
    }
}

/// The Node version's words named the npm package; the program now comes from the machine.
const MISSING_MESSAGE: &str = "Codex isn't installed here (no codex program on the PATH, and TARSEE_CODEX_PATH doesn't name one). Install Codex, or point TARSEE_CODEX_PATH at it.";

/// The systems Codex ships a program for (the Node version's `@openai/codex` platform packages), by Node's names for
/// the platform and the processor.
const TARGETS: [&str; 6] = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "win32-arm64",
];

fn is_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// `process.platform` for this build.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// `process.arch` for this build.
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// An environment variable by name, as Windows looks it up (any case) or as the rest do (exactly).
fn env_lookup(env: &Env, name: &str) -> Option<String> {
    if cfg!(windows) {
        env.snapshot()
            .into_iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v)
    } else {
        env.get(name)
    }
}

/// The same lookup in a child's environment.
fn env_map_lookup<'a>(env: &'a EnvMap, name: &str) -> Option<&'a str> {
    if cfg!(windows) {
        env.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    } else {
        env.get(name).map(String::as_str)
    }
}

/// `which`'s view of the system, with PATH and PATHEXT taken from the given environment instead of the real one.
struct EnvPathSys {
    path: Option<OsString>,
    path_ext: Option<OsString>,
}

impl which::sys::Sys for EnvPathSys {
    type ReadDirEntry = std::fs::DirEntry;
    type Metadata = std::fs::Metadata;

    fn is_windows(&self) -> bool {
        cfg!(windows)
    }

    fn current_dir(&self) -> io::Result<PathBuf> {
        std::env::current_dir()
    }

    /// No "~" expansion in PATH entries: the operating system doesn't do it either.
    fn home_dir(&self) -> Option<PathBuf> {
        None
    }

    fn env_split_paths(&self, paths: &OsStr) -> Vec<PathBuf> {
        std::env::split_paths(paths).collect()
    }

    fn env_path(&self) -> Option<OsString> {
        self.path.clone()
    }

    fn env_path_ext(&self) -> Option<OsString> {
        self.path_ext.clone()
    }

    fn metadata(&self, path: &Path) -> io::Result<Self::Metadata> {
        std::fs::metadata(path)
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<Self::Metadata> {
        std::fs::symlink_metadata(path)
    }

    fn read_dir(&self, path: &Path) -> io::Result<Box<dyn Iterator<Item = io::Result<Self::ReadDirEntry>>>> {
        Ok(Box::new(std::fs::read_dir(path)?))
    }

    fn is_valid_executable(&self, path: &Path) -> io::Result<bool> {
        which::sys::Sys::is_valid_executable(&which::sys::RealSys, path)
    }
}

/// `codex` on the environment's PATH (with its PATHEXT on Windows), or `None`.
fn codex_on_path(env: &Env) -> Option<PathBuf> {
    let sys = EnvPathSys {
        path: env_lookup(env, "PATH").map(OsString::from),
        path_ext: env_lookup(env, "PATHEXT").map(OsString::from),
    };
    which::WhichConfig::new_with_sys(sys)
        .system_cwd(false)
        .binary_name(OsString::from("codex"))
        .first_result()
        .ok()
}

/// The codex program this system has: `codex` on the PATH of `env`. Fails with codex-missing when Codex doesn't run
/// on this system or isn't installed. (The Node version returned the binary the pinned `@openai/codex` package
/// installed for the platform.)
pub fn pinned_codex_bin(env: &Env) -> Result<PathBuf, CodexCliError> {
    pinned_codex_bin_for(env, node_platform(), node_arch())
}

/// [`pinned_codex_bin`] as if on another system (`platform` and `arch` in Node's names), for tests.
pub fn pinned_codex_bin_for(env: &Env, platform: &str, arch: &str) -> Result<PathBuf, CodexCliError> {
    let target = format!("{}-{arch}", if platform == "android" { "linux" } else { platform });
    if !TARGETS.contains(&target.as_str()) {
        return Err(CodexCliError::new(
            CodexCliCode::CodexMissing,
            format!("Codex doesn't run on this system ({platform} {arch})."),
        ));
    }
    codex_on_path(env).ok_or_else(CodexCliError::missing)
}

/// Which codex to run: `codex_bin` when given, else TARSEE_CODEX_PATH (the same override the Codex engine honours;
/// TARSEE_CODEX_BIN, the Node version's name for it, still works), else [`pinned_codex_bin`]. An explicit path that
/// isn't a file is refused here, so the error is plain instead of a shell's "not recognized".
pub fn resolve_codex_bin(codex_bin: Option<&Path>, env: &Env) -> Result<PathBuf, CodexCliError> {
    let explicit = codex_bin
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .or_else(|| {
            env.get("TARSEE_CODEX_PATH")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| env.get("TARSEE_CODEX_BIN").filter(|v| !v.is_empty()).map(PathBuf::from))
        .map(|p| js_trim_path(&p))
        .unwrap_or_default();
    if explicit.as_os_str().is_empty() {
        return pinned_codex_bin(env);
    }
    if !is_file(&explicit) {
        return Err(CodexCliError::missing());
    }
    Ok(explicit)
}

/// The folder Codex keeps this sign-in in, as an absolute path. There is no default: the caller names the home.
pub fn require_codex_home(codex_home: &Path) -> Result<PathBuf, TypeError> {
    let home = js_trim_path(codex_home);
    if home.as_os_str().is_empty() {
        return Err(TypeError(
            "codex: codexHome is required (engine-env homeFor('chatgpt', 'codex', { stateDir }))".into(),
        ));
    }
    Ok(resolve_path(&home))
}

/// The environment a codex job runs with: the server's env minus every credential, Tarsee secret and Railway
/// provider key (so no OPENAI_API_KEY, CODEX_API_KEY or OPENAI_BASE_URL can steer it), plus CODEX_HOME and any
/// `extra`.
pub fn codex_child_env(env: &Env, codex_home: &Path, extra: &EnvMap) -> EnvMap {
    let mut out = base_env(env, &[]);
    out.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    out.insert("CODEX_HOME".into(), codex_home.to_string_lossy().into_owned());
    out
}

static ANSI_CSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("a CSI pattern"));
static ANSI_OSC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").expect("an OSC pattern"));
static ANSI_OTHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b[@-Z\x5C-_]").expect("an escape pattern"));

/// Terminal colour and control sequences taken out, so what's left is the words the CLI printed.
pub fn strip_ansi(text: &str) -> String {
    let text = ANSI_OSC.replace_all(text, "");
    let text = ANSI_CSI.replace_all(&text, "");
    ANSI_OTHER.replace_all(&text, "").into_owned()
}

static QUOTE_AFTER_BACKSLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(\\*)""#).expect("a quoting pattern"));
static TRAILING_BACKSLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\\+)$").expect("a quoting pattern"));

/// An argument quoted the way a Windows program reads its command line.
fn win_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| is_js_space(c) || c == '"') {
        return arg.to_string();
    }
    let quoted = QUOTE_AFTER_BACKSLASHES.replace_all(arg, r#"$1$1\""#);
    let quoted = TRAILING_BACKSLASHES.replace(&quoted, "$1$1");
    format!("\"{quoted}\"")
}

/// How [`spawn_codex`] starts the program.
#[derive(Debug, Clone, Default)]
pub struct SpawnOpts {
    /// The program's whole environment.
    pub env: EnvMap,
    pub cwd: Option<PathBuf>,
}

/// `CREATE_NO_WINDOW`: Node's `windowsHide`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Start codex with pipes on all three streams. On Windows a .cmd/.bat (a shim) runs through cmd.exe, as Node
/// required; anything else starts directly, and outside Windows in its own process group so [`kill_tree`] reaches
/// whatever it starts. (A failure to start is the returned error: Rust has no "error" event that could go unheard.)
pub fn spawn_codex<S: AsRef<str>>(bin: &Path, args: &[S], opts: &SpawnOpts) -> io::Result<Child> {
    let mut command = command_for(bin, args, &opts.env);
    command
        .env_clear()
        .envs(&opts.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &opts.cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn()
}

#[cfg(windows)]
fn command_for<S: AsRef<str>>(bin: &Path, args: &[S], env: &EnvMap) -> Command {
    let text = bin.to_string_lossy();
    let lower = text.to_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let line: Vec<String> = std::iter::once(win_arg(&text))
            .chain(args.iter().map(|a| win_arg(a.as_ref())))
            .collect();
        let shell = env_map_lookup(env, "ComSpec")
            .filter(|s| !s.is_empty())
            .unwrap_or("cmd.exe");
        let mut command = Command::new(shell);
        command.raw_arg("/d /s /c").raw_arg(format!("\"{}\"", line.join(" ")));
        return command;
    }
    let mut command = Command::new(bin);
    command.args(args.iter().map(AsRef::as_ref));
    command
}

#[cfg(not(windows))]
fn command_for<S: AsRef<str>>(bin: &Path, args: &[S], _env: &EnvMap) -> Command {
    let mut command = Command::new(bin);
    command.args(args.iter().map(AsRef::as_ref));
    #[cfg(unix)]
    command.process_group(0);
    command
}

/// Whether the child is still running (it has a pid and no exit status yet).
fn running(child: &mut Child) -> bool {
    child.id().is_some() && matches!(child.try_wait(), Ok(None))
}

/// Stop a codex child and everything under it, and return once it has exited (or after `grace` + 3 s regardless).
/// Windows: taskkill /T /F on its tree (a shim's cmd.exe and the program it runs). Elsewhere: SIGTERM to its process
/// group, then SIGKILL after `grace` (the JS default was 2 s).
pub async fn kill_tree(child: &mut Child, grace: Duration) {
    if !running(child) {
        return;
    }
    let Some(pid) = child.id() else { return };
    let cap = tokio::time::Instant::now() + grace + Duration::from_secs(3);
    #[cfg(windows)]
    {
        let started = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        match started {
            Ok(mut taskkill) => {
                tokio::spawn(async move {
                    let _ = taskkill.wait().await;
                });
            }
            Err(_) => {
                let _ = child.start_kill();
            }
        }
    }
    #[cfg(unix)]
    {
        signal_group(pid, libc::SIGTERM);
        tokio::select! {
            _ = child.wait() => return,
            _ = tokio::time::sleep(grace) => {}
        }
        if running(child) {
            signal_group(pid, libc::SIGKILL);
        }
    }
    let _ = tokio::time::timeout_at(cap, child.wait()).await;
}

/// `process.kill(-pid, signal)`, else the process alone.
#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) {
    let Ok(pid) = i32::try_from(pid) else { return };
    // SAFETY: kill(2) only sends a signal; a pid or group that is gone makes it fail with ESRCH, nothing more.
    unsafe {
        if libc::kill(-pid, signal) != 0 {
            libc::kill(pid, signal);
        }
    }
}

/// A stream's text, collected up to a limit while the program runs (the JS `collectText` getter).
#[derive(Clone)]
pub struct CollectedText {
    bytes: Arc<Mutex<Vec<u8>>>,
    reader: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl CollectedText {
    /// What has arrived so far (bytes past the limit are read and dropped).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock()).into_owned()
    }

    /// Waits until the stream ends, then gives the text.
    pub async fn finish(&self) -> String {
        let reader = self.reader.lock().take();
        if let Some(reader) = reader {
            let _ = reader.await;
        }
        self.text()
    }
}

/// Collect a stream's text up to `max_bytes` (the JS default was 256 KB). Reading goes on to the end, so the program
/// never blocks on a full pipe; what is past the limit is dropped.
pub fn collect_text<R>(stream: Option<R>, max_bytes: usize) -> CollectedText
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let reader = stream.map(|mut stream| {
        let bytes = bytes.clone();
        tokio::spawn(async move {
            let mut chunk = vec![0u8; 16 * 1024];
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut kept = bytes.lock();
                        let room = max_bytes.saturating_sub(kept.len());
                        kept.extend_from_slice(&chunk[..n.min(room)]);
                    }
                }
            }
        })
    });
    CollectedText {
        bytes,
        reader: Arc::new(Mutex::new(reader)),
    }
}

/// How [`run_codex`] runs one command.
#[derive(Debug, Clone)]
pub struct RunCodexOpts {
    pub env: EnvMap,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    pub max_bytes: usize,
}

impl Default for RunCodexOpts {
    fn default() -> Self {
        RunCodexOpts {
            env: EnvMap::new(),
            cwd: None,
            timeout: Duration::from_millis(15_000),
            max_bytes: 256 * 1024,
        }
    }
}

/// How one codex command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexRun {
    /// The exit code; `None` when a signal ended it.
    pub code: Option<i32>,
    /// The signal's name ("SIGTERM") when one ended it.
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

fn spawn_failure(err: &io::Error) -> CodexCliError {
    if matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) {
        return CodexCliError::missing();
    }
    let why = node_error_code(err).map_or_else(|| err.to_string(), str::to_string);
    CodexCliError::new(CodexCliCode::SpawnFailed, format!("Codex couldn't start ({why})."))
}

/// Run one codex command to the end. A command past `timeout` is killed (with its tree) and comes back with
/// `timed_out` true. Fails only when codex can't start.
pub async fn run_codex<S: AsRef<str>>(bin: &Path, args: &[S], opts: &RunCodexOpts) -> Result<CodexRun, CodexCliError> {
    let mut child = spawn_codex(
        bin,
        args,
        &SpawnOpts {
            env: opts.env.clone(),
            cwd: opts.cwd.clone(),
        },
    )
    .map_err(|err| spawn_failure(&err))?;
    let stdout = collect_text(child.stdout.take(), opts.max_bytes);
    let stderr = collect_text(child.stderr.take(), opts.max_bytes);
    drop(child.stdin.take());

    let deadline = tokio::time::sleep(opts.timeout);
    tokio::pin!(deadline);
    let mut timed_out = false;
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            _ = &mut deadline, if !timed_out => {
                timed_out = true;
                kill_tree(&mut child, Duration::from_millis(2000)).await;
            }
        }
    };
    let status = status.map_err(|err| spawn_failure(&err))?;
    // The JS waited for "close": the program gone and both of its streams ended.
    let streams = async { (stdout.finish().await, stderr.finish().await) };
    tokio::pin!(streams);
    let (stdout, stderr) = if timed_out {
        streams.await
    } else {
        tokio::select! {
            texts = &mut streams => texts,
            _ = &mut deadline => {
                timed_out = true;
                streams.await
            }
        }
    };
    Ok(CodexRun {
        code: status.code(),
        signal: signal_name(&status),
        stdout,
        stderr,
        timed_out,
    })
}

/// The name Node gives the signal that ended a program.
#[cfg(unix)]
fn signal_name(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    let signal = status.signal()?;
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        other => return Some(format!("SIG{other}")),
    };
    Some(name.to_string())
}

#[cfg(not(unix))]
fn signal_name(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

/// auth.json's identity right now ("size:mtime"), or `None` when there is none: a changed value means a new sign-in.
pub fn auth_fingerprint(codex_home: &Path) -> Option<String> {
    let meta = std::fs::metadata(codex_home.join("auth.json")).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta.modified().ok()?;
    let ms = match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6,
        Err(before) => -(before.duration().as_secs_f64() * 1e3),
    };
    Some(format!("{}:{}", meta.len(), number_to_string(ms)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::tmp_dir;

    #[test]
    fn the_childs_environment_no_credential_no_base_url_and_codex_home_is_the_one_asked_for() {
        let env = Env::from_pairs([
            ("PATH", "/usr/bin".to_string()),
            ("OPENAI_API_KEY", format!("sk-{}", "test-canary-1")),
            ("CODEX_API_KEY", format!("sk-{}", "test-canary-2")),
            ("CODEX_HOME", "/elsewhere".to_string()),
            ("OPENAI_BASE_URL", "https://example.test".to_string()),
            ("ENCRYPTION_KEY", "x".to_string()),
            ("ANTHROPIC_API_KEY", format!("sk-{}", "test-canary-3")),
            ("LANG", "C.UTF-8".to_string()),
        ]);
        let extra = EnvMap::from([("RUST_LOG".to_string(), "error".to_string())]);
        let child = codex_child_env(&env, Path::new("/data/tarsee/.codex-home"), &extra);
        let want: EnvMap = [
            ("PATH", "/usr/bin"),
            ("LANG", "C.UTF-8"),
            ("RUST_LOG", "error"),
            ("CODEX_HOME", "/data/tarsee/.codex-home"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(child, want);
    }

    #[test]
    fn strip_ansi_leaves_only_the_words() {
        let e = '\u{1b}';
        assert_eq!(
            strip_ansi(&format!(
                "{e}[94mhttps://auth.openai.com/codex/device{e}[0m {e}]8;;https://x.test{e}\\link{e}]8;;{e}\\"
            )),
            "https://auth.openai.com/codex/device link"
        );
        assert_eq!(strip_ansi(&format!("a{e}Mb{e}]0;title\u{7}c{e}[2Kd")), "abcd");
        assert_eq!(
            strip_ansi(&format!("{e}[x")),
            "",
            "an unfinished CSI is still cut at its final byte"
        );
    }

    #[test]
    fn every_job_keeps_its_sign_in_in_a_file_skips_the_update_check_and_looks_for_no_project_root_above_its_folder() {
        let pairs: Vec<(&str, &str)> = CODEX_BASE_ARGS.chunks(2).map(|p| (p[0], p[1])).collect();
        assert!(pairs.iter().all(|(flag, _)| *flag == "-c"), "{CODEX_BASE_ARGS:?}");
        let values: Vec<&str> = pairs.iter().map(|(_, v)| *v).collect();
        assert!(values.contains(&"cli_auth_credentials_store=\"file\""));
        assert!(values.contains(&"check_for_update_on_startup=false"));
        // Without it Codex finds a project root at the nearest folder above with .git and loads every
        // .codex/config.toml from there down to the job's folder (the Codex home, under Tarsee's state folder), which
        // no guard reads.
        assert!(values.contains(&"project_root_markers=[]"));
    }

    #[test]
    fn needs_a_home() {
        assert!(require_codex_home(Path::new("")).is_err());
        assert!(require_codex_home(Path::new("   ")).is_err());
        assert_eq!(
            require_codex_home(Path::new("rel/home")).unwrap(),
            resolve_path(Path::new("rel/home"))
        );
        assert!(require_codex_home(Path::new("rel/home")).unwrap().is_absolute());
    }

    #[test]
    fn which_codex_an_explicit_path_then_tarsee_codex_path_then_the_path_a_missing_one_is_said_plainly() {
        let tmp = tmp_dir();
        let bin = tmp.path().join(if cfg!(windows) { "codex.exe" } else { "codex" });
        std::fs::write(&bin, "not really a program").unwrap();
        let empty = Env::new();
        assert_eq!(resolve_codex_bin(Some(&bin), &empty).unwrap(), bin);
        let by_var = Env::from_pairs([("TARSEE_CODEX_PATH", bin.to_string_lossy().to_string())]);
        assert_eq!(resolve_codex_bin(None, &by_var).unwrap(), bin);
        let by_node_name = Env::from_pairs([("TARSEE_CODEX_BIN", bin.to_string_lossy().to_string())]);
        assert_eq!(
            resolve_codex_bin(None, &by_node_name).unwrap(),
            bin,
            "the Node version's name still works"
        );
        let err = resolve_codex_bin(Some(&tmp.path().join("nope")), &empty).unwrap_err();
        assert_eq!(err.code, CodexCliCode::CodexMissing);
        assert_eq!(err.message, MISSING_MESSAGE);
        let err = pinned_codex_bin_for(&empty, "plan9", "x64").unwrap_err();
        assert_eq!(err.code, CodexCliCode::CodexMissing);
        assert_eq!(err.message, "Codex doesn't run on this system (plan9 x64).");
        // No PATH, no codex.
        assert_eq!(pinned_codex_bin(&empty).unwrap_err().code, CodexCliCode::CodexMissing);
        assert_eq!(
            resolve_codex_bin(None, &empty).unwrap_err().code,
            CodexCliCode::CodexMissing
        );
        // A blank override is no override.
        let blank = Env::from_pairs([("TARSEE_CODEX_PATH", "  ")]);
        assert_eq!(resolve_codex_bin(None, &blank).unwrap_err().message, MISSING_MESSAGE);
    }

    #[test]
    fn windows_arguments_are_quoted_as_a_windows_program_reads_them() {
        assert_eq!(win_arg("plain"), "plain");
        assert_eq!(win_arg(""), "\"\"");
        assert_eq!(win_arg("two words"), "\"two words\"");
        assert_eq!(win_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(win_arg("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(win_arg("C:\\dir with space\\"), "\"C:\\dir with space\\\\\"");
        assert_eq!(
            win_arg("cli_auth_credentials_store=\"file\""),
            "\"cli_auth_credentials_store=\\\"file\\\"\""
        );
        assert_eq!(win_arg("tab\there"), "\"tab\there\"");
    }

    #[test]
    fn auth_fingerprint_is_size_and_time_and_none_without_a_sign_in() {
        let tmp = tmp_dir();
        assert_eq!(auth_fingerprint(tmp.path()), None);
        std::fs::create_dir(tmp.path().join("auth.json")).unwrap();
        assert_eq!(auth_fingerprint(tmp.path()), None, "a folder is not a sign-in");
        std::fs::remove_dir(tmp.path().join("auth.json")).unwrap();
        std::fs::write(tmp.path().join("auth.json"), "{\"x\":1}").unwrap();
        let first = auth_fingerprint(tmp.path()).unwrap();
        assert!(first.starts_with("7:"), "{first}");
        std::fs::write(tmp.path().join("auth.json"), "{\"x\":12}").unwrap();
        let second = auth_fingerprint(tmp.path()).unwrap();
        assert_ne!(first, second);
    }
}
