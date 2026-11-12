//! Port of `src/voice/python-runtime.js`: the Python that Tarsee's local voice runs on: faster-whisper
//! (speech-to-text, `stt_install`) and Phonon (text-to-speech, `phonon_install`). Each gets its own venv; this module
//! finds, or fetches, the Python those venvs are made from.
//!
//!   1. Tarsee's own copy, once downloaded: <state>/python/cpython-<version>.
//!   2. A Python 3.9 to 3.14 on this computer that has the venv module: on Windows the py launcher (py -3.12, ...),
//!      then python; elsewhere python3.12, ..., python3. The Microsoft Store's "python" shortcut is not a Python.
//!   3. Otherwise, only when the owner asks (a click in Settings), a standalone CPython from
//!      astral-sh/python-build-standalone: the install_only build for this OS and CPU, picked from the GitHub
//!      releases API at a pinned release, checked against the pinned sha256 (and the size and digest GitHub lists),
//!      unpacked by `tar_extract` and run once to prove it works.
//!
//! Downloads only ever come from GitHub's own hosts over https (`install_common::guarded_fetch`). The only thing
//! ever run from a download is that Python interpreter itself.
//!
//! The Node module's test hook (`__setForTests({ spawn, candidates })`) is [`set_for_tests`], kept in the app.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;

use super::install_common::Downloader;
use super::install_common::{
    DownloadFile, InstallError, OFFICIAL_HOSTS, describe_fetch_error, download_file, guarded_fetch, js_number_text,
    remove_all_async, remove_file_force, write_file_atomic,
};
use super::tar_extract::extract_tar_gz;
use super::tts_interface::terminate;
use crate::app::App;
use crate::config::Config;
use crate::net::fetch::{Fetch, FetchRequest};
use crate::util::js::{now_iso, number_to_string, trim, truthy, utf16_len, utf16_tail, utf16_truncate};

/// The Pythons faster-whisper (and its parts: ctranslate2, onnxruntime, PyAV) have builds for: 3.9 to 3.14.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PythonRange {
    pub min: (u32, u32),
    pub max: (u32, u32),
}

pub const PYTHON_RANGE: PythonRange = PythonRange {
    min: (3, 9),
    max: (3, 14),
};

/// The standalone CPython Tarsee downloads when there is no usable Python.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandalonePython {
    pub repo: String,
    pub tag: String,
    pub version: String,
    pub approx_bytes: u64,
    /// The pinned sha256 of each target's install_only archive.
    pub sha256: BTreeMap<String, String>,
}

/// python-build-standalone's release 20261026, CPython 3.12.16, the install_only builds. sha256 as the release
/// lists them (each asset's digest).
pub static STANDALONE_PYTHON: LazyLock<StandalonePython> = LazyLock::new(|| StandalonePython {
    repo: "astral-sh/python-build-standalone".into(),
    tag: "20261026".into(),
    version: "3.12.16".into(),
    approx_bytes: 47_000_000,
    sha256: [
        (
            "x86_64-pc-windows-msvc",
            "590dfcbe3a34c07301e6332e13e2188b98655cd072b08afa45a7998dc4c22bc5",
        ),
        (
            "aarch64-pc-windows-msvc",
            "ad585318bfe47980cbaa90be12a65319c5b4eec7472655428528068e710a6c9a",
        ),
        (
            "x86_64-apple-darwin",
            "a962e47df522889eaa7ff0d6a56203f1079f68aabb65ffdbe8455f362bc769f3",
        ),
        (
            "aarch64-apple-darwin",
            "fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e",
        ),
        (
            "x86_64-unknown-linux-gnu",
            "6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de",
        ),
        (
            "aarch64-unknown-linux-gnu",
            "a945427411dc6851a1393533b74a4a1ac434321ae397f2ec69897a9b4fde032b",
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect(),
});

const OWN_LABEL: &str = "Tarsee's own Python";
const MARKER: &str = "tarsee-python.json";

/// A Python to run: the program and the arguments that come first (the Windows launcher is `py -3.12`), where it
/// was found ("system", "tarsee") and how to name it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PythonRef {
    pub cmd: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl PythonRef {
    /// A program with no arguments of its own, from nowhere in particular, unnamed.
    pub fn new(cmd: impl Into<String>) -> Self {
        PythonRef {
            cmd: cmd.into(),
            ..Default::default()
        }
    }

    pub fn args<S: Into<String>>(mut self, args: impl IntoIterator<Item = S>) -> Self {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }
}

// ── The test hook ────────────────────────────────────────────────────────

/// A program about to be started: the program, all of its arguments, and its whole environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// Rewrites how a Python is started (the Node tests' fake `spawn`).
pub type SpawnHook = Arc<dyn Fn(Launch) -> Launch + Send + Sync>;

/// Tests only: a stand-in for starting Python (a fake Python), and/or a fixed list of system Pythons to try.
#[derive(Clone, Default)]
pub struct PythonOverrides {
    pub spawn: Option<SpawnHook>,
    pub candidates: Option<Vec<PythonRef>>,
}

/// `__setForTests({ spawn, candidates })`: stores the overrides in the app; empty overrides remove them.
pub fn set_for_tests(app: &App, overrides: PythonOverrides) {
    if overrides.spawn.is_none() && overrides.candidates.is_none() {
        app.remove::<PythonOverrides>();
    } else {
        app.set(overrides);
    }
}

// ── Where things are ─────────────────────────────────────────────────────

/// Tarsee's Python folder: its own CPython (when downloaded) and the voice venvs.
pub fn python_home(config: &Config) -> PathBuf {
    config.state_dir.join("python")
}

pub fn standalone_dir(config: &Config, pin: &StandalonePython) -> PathBuf {
    python_home(config).join(format!("cpython-{}", pin.version))
}

/// `process.platform`: "win32", "darwin", "linux", ...
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// `process.arch`: "x64", "arm64", "ia32", ...
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

fn join_for(dir: &str, parts: &[&str], platform: &str) -> String {
    let sep = if platform == "win32" { '\\' } else { '/' };
    let mut out = dir
        .trim_end_matches(|c| c == sep || (platform == "win32" && c == '/'))
        .to_string();
    for part in parts {
        out.push(sep);
        out.push_str(part);
    }
    out
}

/// The interpreter inside an unpacked python-build-standalone folder, on `platform`.
pub fn interpreter_in_for(dir: &str, platform: &str) -> String {
    if platform == "win32" {
        join_for(dir, &["python.exe"], platform)
    } else {
        join_for(dir, &["bin", "python3"], platform)
    }
}

/// The interpreter inside an unpacked python-build-standalone folder, on this computer.
pub fn interpreter_in(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("python.exe")
    } else {
        dir.join("bin").join("python3")
    }
}

/// A venv's own python, on `platform`.
pub fn venv_interpreter_for(dir: &str, platform: &str) -> String {
    if platform == "win32" {
        join_for(dir, &["Scripts", "python.exe"], platform)
    } else {
        join_for(dir, &["bin", "python"], platform)
    }
}

/// A venv's own python, on this computer.
pub fn venv_interpreter(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("Scripts").join("python.exe")
    } else {
        dir.join("bin").join("python")
    }
}

/// Tarsee's own CPython is unpacked, checked, and there.
pub fn standalone_ready(config: &Config, pin: &StandalonePython) -> bool {
    let dir = standalone_dir(config, pin);
    dir.join(MARKER).exists() && interpreter_in(&dir).exists()
}

/// How a Python is named: its label, else the program and its own arguments.
pub fn describe_python(python: &PythonRef) -> String {
    if let Some(label) = python.label.as_deref().filter(|l| !l.is_empty()) {
        return label.to_string();
    }
    std::iter::once(python.cmd.as_str())
        .chain(python.args.iter().map(String::as_str))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The glibc this computer runs, when it runs one (Node's `process.report` `glibcVersionRuntime`). A program built
/// for glibc runs only where there is one; otherwise the system's loader is looked for.
fn glibc_version() -> Option<String> {
    if cfg!(all(target_os = "linux", target_env = "gnu")) {
        return Some("glibc".into());
    }
    if cfg!(target_os = "linux") {
        let loaders = [
            "/lib64/ld-linux-x86-64.so.2",
            "/lib/ld-linux-aarch64.so.1",
            "/lib/x86_64-linux-gnu/libc.so.6",
            "/lib/aarch64-linux-gnu/libc.so.6",
            "/usr/lib64/libc.so.6",
        ];
        if loaders.iter().any(|p| Path::new(p).exists()) {
            return Some("glibc".into());
        }
    }
    None
}

/// What [`python_target`] is asked about: `{ platform, arch, glibc }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetQuery {
    pub platform: String,
    pub arch: String,
    /// The glibc version; `None` for a Linux without glibc (musl).
    pub glibc: Option<String>,
}

impl TargetQuery {
    pub fn new(platform: &str, arch: &str, glibc: Option<&str>) -> Self {
        TargetQuery {
            platform: platform.into(),
            arch: arch.into(),
            glibc: glibc.map(str::to_string),
        }
    }

    /// This computer.
    pub fn current() -> Self {
        TargetQuery {
            platform: node_platform().into(),
            arch: node_arch().into(),
            glibc: glibc_version(),
        }
    }
}

/// The python-build-standalone target for a computer: the triple, or why there is none, in plain words.
pub fn python_target(q: &TargetQuery) -> Result<String, String> {
    let cpu = match q.arch.as_str() {
        "x64" => "x86_64",
        "arm64" => "aarch64",
        "ia32" => return Err("this is a 32-bit computer, and faster-whisper needs a 64-bit one".into()),
        other => {
            return Err(format!(
                "there is no Python build for this computer's processor ({other})"
            ));
        }
    };
    match q.platform.as_str() {
        "win32" => Ok(format!("{cpu}-pc-windows-msvc")),
        "darwin" => Ok(format!("{cpu}-apple-darwin")),
        "linux" => {
            if q.glibc.as_deref().is_none_or(str::is_empty) {
                return Err("this Linux uses musl (Alpine, for one), and faster-whisper has no build for it; use Tarsee's Docker image, or a Linux with glibc".into());
            }
            Ok(format!("{cpu}-unknown-linux-gnu"))
        }
        other => Err(format!("there is no Python build Tarsee can download for {other}")),
    }
}

/// The Pythons to look for on a computer, best first.
pub fn system_candidates(platform: &str) -> Vec<PythonRef> {
    let versions = ["3.12", "3.13", "3.11", "3.10", "3.14", "3.9"];
    let system = |cmd: &str, args: &[&str], label: &str| {
        PythonRef::new(cmd)
            .args(args.iter().copied())
            .source("system")
            .label(label)
    };
    let mut out: Vec<PythonRef> = Vec::new();
    if platform == "win32" {
        for v in versions {
            out.push(system("py", &[&format!("-{v}")], &format!("py -{v}")));
        }
        out.push(system("py", &["-3"], "py -3"));
        out.push(system("python", &[], "python"));
        out.push(system("python3", &[], "python3"));
    } else {
        for v in versions {
            let name = format!("python{v}");
            out.push(system(&name, &[], &name));
        }
        out.push(system("python3", &[], "python3"));
        out.push(system("python", &[], "python"));
    }
    out
}

// ── Running Python ───────────────────────────────────────────────────────

/// The command that starts `python` with `args` (after its own) and exactly the environment `env`: found on that
/// environment's `PATH`, through the test hook when one is set, without a console window on Windows, and stopped
/// when dropped. Set its stdio, then spawn it.
pub fn python_command(
    app: &App,
    python: &PythonRef,
    args: &[String],
    env: BTreeMap<String, String>,
) -> tokio::process::Command {
    let mut launch = Launch {
        program: PathBuf::from(&python.cmd),
        args: python.args.iter().chain(args.iter()).cloned().collect(),
        env,
    };
    if let Some(hook) = app.get::<PythonOverrides>().and_then(|o| o.spawn.clone()) {
        launch = hook(launch);
    }
    let program = if launch.program.components().count() > 1 || launch.program.is_absolute() {
        launch.program.clone()
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        which::which_in(&launch.program, path_variable(&launch.env), cwd).unwrap_or(launch.program.clone())
    };
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&launch.args).env_clear().envs(&launch.env).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// The `PATH` of an environment given as a plain map: on Windows its name may be in any case (`Path`), as the
/// system and Node's `process.env` take it.
fn path_variable(env: &BTreeMap<String, String>) -> Option<&String> {
    if cfg!(windows) {
        env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v)
    } else {
        env.get("PATH")
    }
}

/// The options of [`spawn_python`]: the environment (the app's when `None`) and the working folder.
#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    pub env: Option<BTreeMap<String, String>>,
    pub cwd: Option<PathBuf>,
}

/// Starts `python` with `args` and keeps it running (the speech-to-text worker), its stdin, stdout and stderr piped.
pub fn spawn_python(
    app: &App,
    python: &PythonRef,
    args: &[String],
    opts: SpawnOptions,
) -> std::io::Result<tokio::process::Child> {
    let env = opts.env.unwrap_or_else(|| app.env().snapshot());
    let mut cmd = python_command(app, python, args, env);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = opts.cwd {
        cmd.current_dir(cwd);
    }
    cmd.spawn()
}

/// The last `n` lines with text, trimmed, joined with spaces.
fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.split('\n').map(trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join(" ")
}

const KEEP: usize = 256 * 1024;

/// Which output a line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    Stdout,
    Stderr,
}

impl Output {
    pub fn as_str(self) -> &'static str {
        match self {
            Output::Stdout => "stdout",
            Output::Stderr => "stderr",
        }
    }
}

/// Gets each line a program prints, as it comes.
pub type LineListener = Arc<dyn Fn(&str, Output) + Send + Sync>;

/// The options of [`run_python`]: `{ timeout, env, onLine, cwd }`.
#[derive(Clone)]
pub struct RunOptions {
    /// `None`: no limit. Default two minutes.
    pub timeout: Option<Duration>,
    /// The whole environment; the app's when `None`.
    pub env: Option<BTreeMap<String, String>>,
    pub on_line: Option<LineListener>,
    pub cwd: Option<PathBuf>,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions {
            timeout: Some(Duration::from_secs(120)),
            env: None,
            on_line: None,
            cwd: None,
        }
    }
}

impl RunOptions {
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn env(mut self, env: BTreeMap<String, String>) -> Self {
        self.env = Some(env);
        self
    }

    pub fn on_line(mut self, listener: impl Fn(&str, Output) + Send + Sync + 'static) -> Self {
        self.on_line = Some(Arc::new(listener));
        self
    }
}

/// What a finished run printed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunOutput {
    pub stdout: String,
    pub stderr: String,
}

/// Why a run failed. The message is the last lines the program printed (or what kept it from running); `code` is
/// "ENOENT" when there is no such program.
#[derive(Debug, Clone, Default, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PythonRunError {
    pub message: String,
    pub code: Option<String>,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

/// One output of a running program: everything it printed (the last 256K), and the line not finished yet.
struct Collected {
    all: String,
    partial: String,
}

/// Reads one pipe to its end, handing over each whole line as it comes.
async fn collect<R: tokio::io::AsyncRead + Unpin>(
    mut pipe: R,
    which: Output,
    on_line: Option<LineListener>,
) -> Collected {
    let mut all = String::new();
    let mut partial = String::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        // Whole characters only; a character cut between two reads waits for its other half.
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(err) if err.error_len().is_none() => err.valid_up_to(),
            Err(_) => pending.len(),
        };
        let s = String::from_utf8_lossy(&pending[..valid]).into_owned();
        pending.drain(..valid);
        all.push_str(&s);
        if all.len() > KEEP && utf16_len(&all) > KEEP {
            all = utf16_tail(&all, KEEP);
        }
        let Some(on_line) = on_line.as_ref() else { continue };
        partial.push_str(&s);
        while let Some(j) = partial.find('\n') {
            let i = if j > 0 && partial.as_bytes()[j - 1] == b'\r' {
                j - 1
            } else {
                j
            };
            let line = partial[..i].to_string();
            partial.drain(..=j);
            // A listener's problem is not the run's.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_line(&line, which)));
        }
    }
    if !pending.is_empty() {
        let s = String::from_utf8_lossy(&pending).into_owned();
        all.push_str(&s);
        partial.push_str(&s);
    }
    Collected { all, partial }
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    let name = match status.signal()? {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        other => return Some(format!("signal {other}")),
    };
    Some(name.to_string())
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

fn seconds(d: Duration) -> String {
    number_to_string((d.as_millis() as f64 / 1000.0 + 0.5).floor())
}

/// Runs `python` with `args` to its end. Fails with the last lines it printed, or when it is not there (code
/// ENOENT), takes too long (`timed_out`) or exits with an error (`exit_code`).
pub async fn run_python(
    app: &App,
    python: &PythonRef,
    args: &[String],
    opts: RunOptions,
) -> Result<RunOutput, PythonRunError> {
    let label = describe_python(python);
    let env = opts.env.clone().unwrap_or_else(|| app.env().snapshot());
    let mut cmd = python_command(app, python, args, env);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = &opts.cwd {
        cmd.current_dir(cwd);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            let (message, code) = match err.kind() {
                std::io::ErrorKind::NotFound => (format!("{label} was not found"), Some("ENOENT")),
                std::io::ErrorKind::PermissionDenied => {
                    (format!("{label} could not be started ({err})"), Some("EACCES"))
                }
                _ => (format!("{label} could not be started ({err})"), None),
            };
            return Err(PythonRunError {
                message,
                code: code.map(str::to_string),
                ..Default::default()
            });
        }
    };
    let stdout = child
        .stdout
        .take()
        .map(|p| tokio::spawn(collect(p, Output::Stdout, opts.on_line.clone())));
    let stderr = child
        .stderr
        .take()
        .map(|p| tokio::spawn(collect(p, Output::Stderr, opts.on_line.clone())));

    let mut timed_out = false;
    let waited = match opts.timeout.filter(|t| !t.is_zero()) {
        Some(limit) => match tokio::time::timeout(limit, child.wait()).await {
            Ok(status) => status,
            Err(_) => {
                timed_out = true;
                terminate(&mut child);
                child.wait().await
            }
        },
        None => child.wait().await,
    };
    let done = |task: Option<tokio::task::JoinHandle<Collected>>| async move {
        match task {
            Some(task) => task.await.unwrap_or(Collected {
                all: String::new(),
                partial: String::new(),
            }),
            None => Collected {
                all: String::new(),
                partial: String::new(),
            },
        }
    };
    let out = done(stdout).await;
    let err = done(stderr).await;
    if let Some(on_line) = opts.on_line.as_ref() {
        for (c, which) in [(&out, Output::Stdout), (&err, Output::Stderr)] {
            if !c.partial.is_empty() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_line(&c.partial, which)));
            }
        }
    }
    let status = match waited {
        Ok(status) => status,
        Err(e) => {
            return Err(PythonRunError {
                message: format!("{label} could not be started ({e})"),
                stdout: out.all,
                stderr: err.all,
                ..Default::default()
            });
        }
    };
    if timed_out {
        let limit = opts.timeout.unwrap_or_default();
        return Err(PythonRunError {
            message: format!("{label} did not finish within {}s", seconds(limit)),
            timed_out: true,
            stdout: out.all,
            stderr: err.all,
            ..Default::default()
        });
    }
    if !status.success() {
        let code = status.code();
        let signal = signal_of(&status);
        let mut detail = last_lines(&err.all, 3);
        if detail.is_empty() {
            detail = last_lines(&out.all, 3);
        }
        if detail.is_empty() {
            let why = signal.clone().unwrap_or_else(|| {
                format!(
                    "exit code {}",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
                )
            });
            detail = format!("{label} stopped ({why})");
        }
        return Err(PythonRunError {
            message: detail,
            exit_code: code,
            signal,
            stdout: out.all,
            stderr: err.all,
            ..Default::default()
        });
    }
    Ok(RunOutput {
        stdout: out.all,
        stderr: err.all,
    })
}

// ── Probing ──────────────────────────────────────────────────────────────

const PROBE: &str = "import sys, json
r = {'version': list(sys.version_info[:3]), 'executable': sys.executable, 'prefix': sys.prefix, 'venv': False, 'fasterWhisper': None}
try:
    import venv, ensurepip
    r['venv'] = True
except Exception:
    pass
try:
    import faster_whisper
    r['fasterWhisper'] = getattr(faster_whisper, '__version__', 'unknown')
except Exception as e:
    r['fasterWhisperError'] = (type(e).__name__ + ': ' + str(e))[:300]
print('TARSEE-PROBE ' + json.dumps(r))";

/// What a Python said about itself: `{ ...ref, found, usable, version, executable, venv, fasterWhisper, problem }`.
/// found: the program exists; usable: a Python in [`PYTHON_RANGE`] with venv (a base for Tarsee's venvs);
/// fasterWhisper: its version when this Python can import it; problem: why it isn't usable, in plain words.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonProbe {
    /// The Python asked, its label always set.
    #[serde(flatten)]
    pub python: PythonRef,
    pub found: bool,
    pub usable: bool,
    pub version: Option<String>,
    pub executable: Option<String>,
    pub venv: bool,
    pub faster_whisper: Option<String>,
    pub problem: Option<String>,
}

impl PythonProbe {
    pub fn label(&self) -> &str {
        self.python.label.as_deref().unwrap_or("")
    }
}

/// `String(value)` for what a probe printed.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        other => other.to_string(),
    }
}

/// `Number(value)`.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        Value::String(s) => js_number_text(s),
        _ => f64::NAN,
    }
}

/// `(a[0] - b[0]) || (a[1] - b[1])`.
fn cmp_ver(a: &[f64], b: (u32, u32)) -> f64 {
    let at = |i: usize| a.get(i).copied().unwrap_or(f64::NAN);
    let major = at(0) - f64::from(b.0);
    if major != 0.0 && !major.is_nan() {
        major
    } else {
        at(1) - f64::from(b.1)
    }
}

static PY_LAUNCHER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^py(\.exe)?$").expect("the py launcher pattern"));
static PY_MISSING: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)No suitable Python runtime|not found").expect("the py missing pattern"));
static STORE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)Microsoft Store").expect("the store pattern"));

fn base_name(cmd: &str) -> &str {
    cmd.rsplit(['/', '\\']).next().unwrap_or(cmd)
}

/// Asks a Python about itself (30 seconds at most: `timeout`).
pub async fn probe_python(app: &App, python: &PythonRef, timeout: Duration) -> PythonProbe {
    let mut named = python.clone();
    named.label = Some(describe_python(python));
    let base = PythonProbe {
        python: named,
        found: false,
        usable: false,
        version: None,
        executable: None,
        venv: false,
        faster_whisper: None,
        problem: None,
    };
    let mut env = app.env().snapshot();
    env.insert("HF_HUB_OFFLINE".into(), "1".into());
    let args = ["-I".to_string(), "-c".to_string(), PROBE.to_string()];
    let stdout = match run_python(app, python, &args, RunOptions::default().timeout(timeout).env(env)).await {
        Ok(out) => out.stdout,
        Err(err) => {
            let problem = |found: bool, problem: String| PythonProbe {
                found,
                problem: Some(problem),
                ..base.clone()
            };
            if err.code.as_deref() == Some("ENOENT") {
                return problem(false, "not found".into());
            }
            if err.timed_out {
                return problem(true, format!("did not answer within {}s", seconds(timeout)));
            }
            // The py launcher, asked for a version this computer doesn't have (its message mentions the Microsoft
            // Store too).
            if PY_LAUNCHER.is_match(base_name(&python.cmd)) && PY_MISSING.is_match(&err.stderr) {
                return problem(false, "not found".into());
            }
            if STORE.is_match(&format!("{} {} {}", err.stderr, err.stdout, err.message)) || err.exit_code == Some(9009)
            {
                return problem(true, "this is the Microsoft Store shortcut, not Python itself".into());
            }
            return problem(true, format!("did not run ({})", err.message));
        }
    };
    let parsed = stdout
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .find(|l| l.starts_with("TARSEE-PROBE "))
        .and_then(|l| serde_json::from_str::<Value>(&l["TARSEE-PROBE ".len()..]).ok());
    let Some(r) = parsed else {
        return PythonProbe {
            found: true,
            problem: Some("did not answer like a Python does".into()),
            ..base
        };
    };
    let v: Vec<f64> = match r.get("version") {
        Some(Value::Array(parts)) => parts.iter().map(js_number).collect(),
        _ => vec![0.0, 0.0, 0.0],
    };
    let version = v.iter().map(|n| number_to_string(*n)).collect::<Vec<_>>().join(".");
    let truthy_text = |key: &str| r.get(key).filter(|v| truthy(v)).map(js_string);
    let res = PythonProbe {
        found: true,
        version: Some(version.clone()),
        executable: truthy_text("executable"),
        venv: r.get("venv").is_some_and(truthy),
        faster_whisper: truthy_text("fasterWhisper"),
        ..base
    };
    let problem = if cmp_ver(&v, PYTHON_RANGE.min) < 0.0 {
        Some(format!(
            "Python {version} is too old (faster-whisper needs 3.9 or newer)"
        ))
    } else if cmp_ver(&v, PYTHON_RANGE.max) > 0.0 {
        Some(format!(
            "Python {version} is newer than faster-whisper supports yet (3.9 to 3.14)"
        ))
    } else if !res.venv {
        Some(format!(
            "Python {version} has no venv module (on Debian or Ubuntu: apt install python3-venv)"
        ))
    } else {
        None
    };
    match problem {
        Some(problem) => PythonProbe {
            problem: Some(problem),
            ..res
        },
        None => PythonProbe { usable: true, ..res },
    }
}

/// Every Python found: Tarsee's own first (when there), then this computer's, without repeats.
pub async fn find_pythons(app: &App, pin: &StandalonePython) -> Vec<PythonProbe> {
    let mut list = Vec::new();
    if standalone_ready(app.config(), pin) {
        list.push(
            PythonRef::new(interpreter_in(&standalone_dir(app.config(), pin)).to_string_lossy())
                .source("tarsee")
                .label(OWN_LABEL),
        );
    }
    match app.get::<PythonOverrides>().and_then(|o| o.candidates.clone()) {
        Some(candidates) => list.extend(candidates),
        None => list.extend(system_candidates(node_platform())),
    }
    let probes = futures::future::join_all(list.iter().map(|p| probe_python(app, p, Duration::from_secs(30)))).await;
    let mut seen = std::collections::HashSet::new();
    probes
        .into_iter()
        .filter(|p| {
            let Some(exe) = &p.executable else { return true };
            let key = if cfg!(windows) { exe.to_lowercase() } else { exe.clone() };
            seen.insert(key)
        })
        .collect()
}

/// The best Python to make a venv from, or `None`.
pub async fn find_base_python(app: &App, pin: &StandalonePython) -> Option<PythonProbe> {
    find_pythons(app, pin).await.into_iter().find(|p| p.usable)
}

pub const NO_PYTHON: &str = "No Python 3.9 or newer was found on this computer";

/// `{ phase: "python" | "python-unpack", bytesDone, bytesTotal }` while Tarsee's own Python downloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonProgress {
    pub phase: &'static str,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

/// Gets the download's progress.
pub type ProgressListener = Arc<dyn Fn(PythonProgress) + Send + Sync>;

/// Gets each line an install has to say.
pub type LogListener = Arc<dyn Fn(&str) + Send + Sync>;

/// The options of [`ensure_base_python`] and [`download_standalone_python`]: `{ allowDownload, fetch, pin,
/// onProgress, log, retryDelayMs }`.
#[derive(Clone)]
pub struct EnsureOptions {
    pub allow_download: bool,
    /// The HTTP client; the app's when `None`.
    pub fetch: Option<Arc<dyn Fetch>>,
    /// Replaces [`STANDALONE_PYTHON`] (tests).
    pub pin: Option<StandalonePython>,
    pub on_progress: Option<ProgressListener>,
    pub log: Option<LogListener>,
    pub retry_delay_ms: u64,
}

impl Default for EnsureOptions {
    fn default() -> Self {
        EnsureOptions {
            allow_download: false,
            fetch: None,
            pin: None,
            on_progress: None,
            log: None,
            retry_delay_ms: 1000,
        }
    }
}

/// A Python to make a venv from: [`find_base_python`]'s, else (`allow_download`) Tarsee's own, downloaded now.
/// Without `allow_download`, no Python is an error (code NO_PYTHON) that says what to do.
pub async fn ensure_base_python(app: &App, opts: &EnsureOptions) -> Result<PythonProbe, InstallError> {
    let pin = opts.pin.clone().unwrap_or_else(|| STANDALONE_PYTHON.clone());
    if let Some(found) = find_base_python(app, &pin).await {
        return Ok(found);
    }
    if !opts.allow_download {
        return Err(InstallError::with_code(
            format!(
                "{NO_PYTHON}. Install it from python.org, or use the Install button in Settings > Voice, which downloads Tarsee's own copy (about 45 MB)."
            ),
            "NO_PYTHON",
        ));
    }
    download_standalone_python(app, opts).await
}

// ── The standalone download ──────────────────────────────────────────────

/// Downloads, checks, unpacks and runs once the pinned standalone CPython. Gives its probe (source "tarsee").
pub async fn download_standalone_python(app: &App, opts: &EnsureOptions) -> Result<PythonProbe, InstallError> {
    let pin = opts.pin.clone().unwrap_or_else(|| STANDALONE_PYTHON.clone());
    let target = python_target(&TargetQuery::current())
        .map_err(|err| InstallError::new(format!("Tarsee can't download Python for this computer: {err}.")))?;
    let fetch = opts.fetch.clone().unwrap_or_else(|| app.fetch());
    let get = guarded_fetch(&[OFFICIAL_HOSTS.github], fetch);
    let log = |msg: &str| {
        if let Some(log) = &opts.log {
            log(msg);
        }
    };
    let progress = |phase: &'static str, done: u64, total: u64| {
        if let Some(on_progress) = &opts.on_progress {
            on_progress(PythonProgress {
                phase,
                bytes_done: done,
                bytes_total: total,
            });
        }
    };

    // 1. The release, from GitHub's API.
    let api_url = format!("https://api.github.com/repos/{}/releases/tags/{}", pin.repo, pin.tag);
    let request = FetchRequest::get(api_url.clone())
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Tarsee")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(30));
    let res = get.get(request).await.map_err(|err| {
        InstallError::new(format!(
            "Could not read the Python release list from GitHub: {}.",
            describe_fetch_error(&err, &api_url).message
        ))
    })?;
    if res.status == 403 || res.status == 429 {
        return Err(InstallError::new(
            "GitHub is turning requests from this address away for now (its rate limit). Try again in an hour.",
        ));
    }
    if !res.ok() {
        return Err(InstallError::new(format!(
            "GitHub answered HTTP {} for the Python release list. Try again later.",
            res.status
        )));
    }
    let release = res
        .json()
        .await
        .map_err(|_| InstallError::new("GitHub's Python release list could not be read. Try again later."))?;

    // 2. This computer's build, checked against the pin before a byte of it is fetched.
    let name = format!("cpython-{}+{}-{}-install_only.tar.gz", pin.version, pin.tag, target);
    let asset = release
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets
                .iter()
                .find(|a| a.get("name").and_then(Value::as_str) == Some(name.as_str()))
        })
        .cloned()
        .ok_or_else(|| {
            InstallError::new(format!(
                "GitHub's Python release {} has no build for this computer ({target}).",
                pin.tag
            ))
        })?;
    let pinned = pin.sha256.get(&target).filter(|s| !s.is_empty()).cloned();
    let listed = asset.get("digest").and_then(Value::as_str).and_then(|d| {
        let lower = d.to_ascii_lowercase();
        let hex = lower.strip_prefix("sha256:")?;
        (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| hex.to_string())
    });
    if let (Some(pinned), Some(listed)) = (&pinned, &listed)
        && listed != pinned
    {
        return Err(InstallError::new(format!(
            "The Python build GitHub lists ({name}) does not match the one this version of Tarsee expects, so it was not downloaded."
        )));
    }
    let Some(sha256) = pinned.or(listed) else {
        return Err(InstallError::new(format!(
            "GitHub lists no hash for {name}, so it was not downloaded."
        )));
    };
    let official = format!("https://github.com/{}/releases/download/{}/", pin.repo, pin.tag);
    let url = match asset.get("browser_download_url") {
        Some(v) if truthy(v) => js_string(v),
        _ => String::new(),
    };
    if !url.starts_with(&official) {
        return Err(InstallError::new(format!(
            "Refused the Python download: its link is not the official one ({}).",
            utf16_truncate(&url, 80)
        )));
    }
    let size = asset.get("size").map(js_number).filter(|n| *n > 0.0).map(|n| n as u64);
    let total = size.unwrap_or(if pin.approx_bytes > 0 {
        pin.approx_bytes
    } else {
        47_000_000
    });

    // 3. Download it.
    let home = python_home(app.config());
    let downloads = home.join("downloads");
    let file = downloads.join(&name);
    let done = std::sync::atomic::AtomicI64::new(0);
    progress("python", 0, total);
    log(&format!("downloading Python {} ({name}) from GitHub", pin.version));
    let on_bytes = |n: i64| {
        let now = (done.load(std::sync::atomic::Ordering::SeqCst) + n).max(0);
        done.store(now, std::sync::atomic::Ordering::SeqCst);
        progress("python", now as u64, total);
    };
    let mut spec = DownloadFile::new(url, &file)
        .sha256(sha256.clone())
        .retry_delay_ms(opts.retry_delay_ms)
        .progress(&on_bytes);
    spec.size = size;
    if let Err(err) = download_file(&get, spec).await {
        clean_downloads(&downloads, &file)?;
        return Err(InstallError::new(format!(
            "Downloading Python from GitHub failed: {}.",
            err.message
        )));
    }
    let done = done.load(std::sync::atomic::Ordering::SeqCst).max(0) as u64;

    // 4. Unpack it (strictly: tar_extract), then put it in place.
    let dir = standalone_dir(app.config(), &pin);
    let mut partial_name = dir.as_os_str().to_owned();
    partial_name.push(".partial");
    let partial = PathBuf::from(partial_name);
    remove_all_async(&partial).await?;
    progress("python-unpack", done, total);
    let unpacked = match extract_tar_gz(&file, &partial, 1).await {
        Ok(_) if !interpreter_in(&partial).exists() => Err("it has no Python interpreter in it".to_string()),
        Ok(_) => Ok(()),
        Err(err) => Err(err.message),
    };
    if let Err(why) = unpacked {
        remove_all_async(&partial).await?;
        clean_downloads(&downloads, &file)?;
        return Err(InstallError::new(format!(
            "The Python download could not be unpacked: {why}."
        )));
    }
    remove_all_async(&dir).await?;
    std::fs::rename(&partial, &dir)?;
    clean_downloads(&downloads, &file)?;

    // 5. Run it once (the only thing from a download Tarsee ever runs is this interpreter).
    let own = PythonRef::new(interpreter_in(&dir).to_string_lossy())
        .source("tarsee")
        .label(OWN_LABEL);
    let probe = probe_python(app, &own, Duration::from_secs(30)).await;
    if !probe.usable {
        remove_all_async(&dir).await?;
        return Err(InstallError::new(format!(
            "The downloaded Python did not run ({}).",
            probe.problem.as_deref().unwrap_or("null")
        )));
    }
    let marker = serde_json::json!({
        "repo": pin.repo,
        "tag": pin.tag,
        "version": pin.version,
        "target": target,
        "sha256": sha256,
        "installedAt": now_iso(),
    });
    write_file_atomic(
        &dir.join(MARKER),
        format!("{}\n", serde_json::to_string_pretty(&marker).unwrap_or_default()),
    )?;
    log(&format!(
        "Python {} is ready in {}",
        probe.version.as_deref().unwrap_or(""),
        dir.display()
    ));
    Ok(probe)
}

fn clean_downloads(dir: &Path, file: &Path) -> std::io::Result<()> {
    remove_file_force(file)?;
    let mut part = file.as_os_str().to_owned();
    part.push(".part");
    remove_file_force(&PathBuf::from(part))?;
    // Not empty, or gone: either way it stays as it is.
    let _ = std::fs::remove_dir(dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::test_app;

    // test/python-runtime.test.js, "which Python build fits this computer". The cases that run a (fake) Python are
    // in tests/it/voice.rs.

    #[test]
    fn picks_the_install_only_asset_for_each_os_and_cpu() {
        let t = |p: &str, a: &str, g: Option<&str>| python_target(&TargetQuery::new(p, a, g));
        assert_eq!(t("win32", "x64", None).unwrap(), "x86_64-pc-windows-msvc");
        assert_eq!(t("win32", "arm64", None).unwrap(), "aarch64-pc-windows-msvc");
        assert_eq!(t("darwin", "arm64", None).unwrap(), "aarch64-apple-darwin");
        assert_eq!(t("darwin", "x64", None).unwrap(), "x86_64-apple-darwin");
        assert_eq!(t("linux", "x64", Some("2.36")).unwrap(), "x86_64-unknown-linux-gnu");
        assert_eq!(t("linux", "arm64", Some("2.36")).unwrap(), "aarch64-unknown-linux-gnu");
        let musl = t("linux", "x64", None).unwrap_err();
        assert!(musl.contains("musl") || musl.contains("Alpine"), "{musl}");
        assert!(t("win32", "ia32", None).unwrap_err().contains("32-bit"));
        assert!(
            t("freebsd", "x64", None)
                .unwrap_err()
                .to_lowercase()
                .contains("freebsd")
        );
        assert!(t("linux", "s390x", Some("2.36")).unwrap_err().contains("(s390x)"));
        for target in [
            "x86_64-pc-windows-msvc",
            "aarch64-apple-darwin",
            "x86_64-unknown-linux-gnu",
        ] {
            let pinned = &STANDALONE_PYTHON.sha256[target];
            assert!(
                pinned.len() == 64 && pinned.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "a pinned sha256 for {target}"
            );
        }
        // This computer has a target (the tests below download for it).
        assert!(python_target(&TargetQuery::current()).is_ok());
    }

    #[test]
    fn looks_for_the_windows_py_launcher_first_on_windows_and_python3_elsewhere() {
        let win = system_candidates("win32");
        assert_eq!(win[0].cmd, "py");
        assert_eq!(win[0].args, ["-3.12"]);
        assert_eq!(win[0].label.as_deref(), Some("py -3.12"));
        assert!(win.iter().any(|c| c.cmd == "python"));
        let linux = system_candidates("linux");
        assert!(linux.iter().any(|c| c.cmd == "python3"));
        assert!(!linux.iter().any(|c| c.cmd == "py"));
        assert_eq!(linux[0].cmd, "python3.12");
        assert!(linux.iter().all(|c| c.source.as_deref() == Some("system")));
    }

    #[test]
    fn knows_where_a_venv_s_python_is_on_each_os() {
        let t = test_app();
        assert_eq!(
            venv_interpreter_for("C:\\t\\venv", "win32"),
            "C:\\t\\venv\\Scripts\\python.exe"
        );
        assert_eq!(venv_interpreter_for("/t/venv", "linux"), "/t/venv/bin/python");
        assert_eq!(
            interpreter_in_for("C:\\t\\cpython", "win32"),
            "C:\\t\\cpython\\python.exe"
        );
        assert_eq!(interpreter_in_for("/t/cpython", "darwin"), "/t/cpython/bin/python3");
        assert!(standalone_dir(t.config(), &STANDALONE_PYTHON).starts_with(python_home(t.config())));
        assert!(
            python_home(t.config()).starts_with(t.path()),
            "in Tarsee's state folder"
        );
        assert_eq!(
            standalone_dir(t.config(), &STANDALONE_PYTHON).file_name().unwrap(),
            "cpython-3.12.16"
        );
        assert!(!standalone_ready(t.config(), &STANDALONE_PYTHON));
    }

    // Added: the small pieces the Node tests went through without naming.

    #[test]
    fn a_python_is_named_by_its_label_else_its_command() {
        assert_eq!(describe_python(&PythonRef::new("py").args(["-3.12"])), "py -3.12");
        assert_eq!(describe_python(&PythonRef::new("/x/python").label("Mine")), "Mine");
        assert_eq!(describe_python(&PythonRef::new("python3").label("")), "python3");
        assert_eq!(last_lines("a\r\n\n  b  \nc\nd\n", 3), "b c d");
        assert_eq!(cmp_ver(&[3.0, 8.0, 10.0], (3, 9)), -1.0);
        assert_eq!(cmp_ver(&[4.0, 0.0], (3, 14)), 1.0);
        assert!(cmp_ver(&[3.0], (3, 9)).is_nan());
        assert_eq!(seconds(Duration::from_millis(500)), "1");
        assert_eq!(seconds(Duration::from_secs(30)), "30");
        assert_eq!(base_name("C:\\Windows\\py.exe"), "py.exe");
    }

    #[test]
    fn a_probe_serializes_with_the_javascript_field_names() {
        let probe = PythonProbe {
            python: PythonRef::new("python3").source("system").label("python3"),
            found: true,
            usable: true,
            version: Some("3.12.1".into()),
            executable: Some("/usr/bin/python3".into()),
            venv: true,
            faster_whisper: None,
            problem: None,
        };
        assert_eq!(
            serde_json::to_string(&probe).unwrap(),
            r#"{"cmd":"python3","args":[],"source":"system","label":"python3","found":true,"usable":true,"version":"3.12.1","executable":"/usr/bin/python3","venv":true,"fasterWhisper":null,"problem":null}"#
        );
    }

    #[test]
    fn the_test_hook_is_kept_in_the_app_and_taken_out_again() {
        let t = test_app();
        set_for_tests(
            &t,
            PythonOverrides {
                spawn: None,
                candidates: Some(vec![PythonRef::new("python3")]),
            },
        );
        assert!(t.has::<PythonOverrides>());
        set_for_tests(&t, PythonOverrides::default());
        assert!(!t.has::<PythonOverrides>());
    }
}
