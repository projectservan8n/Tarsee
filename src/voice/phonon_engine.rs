//! Port of `src/voice/phonon-engine.js`. Phonon TTS engine: Gradium's open-weight Phonon 31M English model
//! (gradium/phonon-31m-en, Apache-2.0) run by the ptts runtime (MIT or Apache-2.0). Fully local and CPU-only: no API
//! key, and no network once the model is on disk.
//!
//! Setup: Settings -> Voice -> Install Phonon, or the automatic background install on first boot (see
//! `phonon_install`). The model and the English voices live on the data volume under DATA_DIR/tts/phonon
//! (TARSEE_PHONON_DIR overrides it), never in git or the image.
//!
//! One persistent Python worker (phonon_worker.py) loads the model once and answers synth requests as line-based JSON
//! on stdin/stdout, so each sentence costs only inference time. Requests are serialised; a synth that takes longer
//! than [`SYNTH_TIMEOUT`] kills the worker, and the next request starts a fresh one.
//!
//! `engine_registry` wraps this engine so that a failed sentence is spoken by Edge TTS instead, and uses Edge TTS
//! outright while Phonon is not installed. Voice cloning exists only in Gradium's paid API, so it is not offered here.
//!
//! The Node module kept the worker and the `import ptts` answers in module variables; here they are app services
//! ([`PhononWorker`], and the cache behind [`can_import_ptts`]). The worker process is ended when the worker is
//! stopped ([`stop_phonon_worker`]) or dropped with the app.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use self::line_worker::{ExitInfo, Promise, Utf8Stream, WorkerProcess};
use super::python_runtime::{PythonRef, RunOptions, python_command, run_python, venv_interpreter};
use super::install_common::js_number_text;
use super::speech_text::{PesoOptions, phonon_speech_text};
use super::tts_interface::{ClonedVoice, SynthOptions, Synthesized, TtsEngine, TtsError, VoiceInfo, os_tmpdir};
use crate::app::{App, WeakApp};
use crate::env::Env;
use crate::util::js::{now_ms, number_to_string, trim, trim_start, truthy, utf16_len, utf16_truncate};

/// A voice of gradium/phonon-voices: `{ id, name }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PhononVoice {
    pub id: &'static str,
    pub name: &'static str,
}

const fn voice(id: &'static str, name: &'static str) -> PhononVoice {
    PhononVoice { id, name }
}

/// The English voices of gradium/phonon-voices that the installer downloads.
pub const VOICES: &[PhononVoice] = &[
    voice("toby", "Toby (British male, adult)"),
    voice("teddy", "Teddy (British male, young adult)"),
    voice("hugh", "Hugh (British male, middle-aged)"),
    voice("edwin", "Edwin (British male, middle-aged)"),
    voice("spencer", "Spencer (British male, middle-aged)"),
    voice("alfie", "Alfie (British male, young adult)"),
    voice("maeve", "Maeve (British female, adult)"),
    voice("freya", "Freya (British female, young)"),
    voice("pippa", "Pippa (British female, adult)"),
    voice("elodie-rose", "Elodie-Rose (British female, young)"),
    voice("imogen", "Imogen (British female, adult)"),
    voice("lottie", "Lottie (British female, young adult)"),
    voice("bryony", "Bryony (British female, middle-aged)"),
    voice("easton", "Easton (American male, young adult)"),
    voice("micah", "Micah (American male, young adult)"),
    voice("trevor", "Trevor (American male, middle-aged)"),
    voice("russell", "Russell (American male, adult)"),
    voice("preston", "Preston (American male, middle-aged)"),
    voice("miles", "Miles (American male, young adult)"),
    voice("zoey", "Zoey (American female, adult)"),
    voice("juniper", "Juniper (American female, young adult)"),
    voice("everly", "Everly (American female, middle-aged)"),
    voice("harper", "Harper (American female, adult)"),
    voice("hadley", "Hadley (American female, middle-aged)"),
    voice("delia", "Delia (American female, middle-aged)"),
];
pub const DEFAULT_VOICE: &str = "toby";

// Phonon's speaking rate is a model condition (duration_delta), not a time stretch, and it only holds over a narrow
// range: past about 1.25x the model stops speeding up and then breaks down. 1.0 is its natural pace.
pub const SPEED_MIN: f64 = 0.85;
pub const SPEED_MAX: f64 = 1.25;
pub const DEFAULT_SPEED: f64 = 1.0;
const SPEED_TO_DELTA: [(f64, f64); 6] = [
    (0.85, 0.5),
    (0.9, 0.15),
    (1.0, 0.0),
    (1.1, -0.15),
    (1.2, -0.3),
    (1.25, -0.45),
];

/// `Math.round(x)`: halves go up, towards +infinity.
pub(crate) fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `Number(value)` for a JSON value (a setting).
pub(crate) fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number_text(s),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => js_number(Some(&Value::String(js_template(Some(one))))),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// A value as a JavaScript template literal prints it (`${value}`): `undefined` for a missing one.
pub(crate) fn js_template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                other => js_template(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String(value || "")`: a falsy value is "", anything else as JavaScript prints it.
pub(crate) fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(v) if truthy(v) => js_template(Some(v)),
        _ => String::new(),
    }
}

/// Clamps a speaking rate into the range Phonon holds; a rate that is not a finite number is the natural pace.
pub fn clamp_speed(speed: f64) -> f64 {
    if !speed.is_finite() {
        return DEFAULT_SPEED;
    }
    speed.clamp(SPEED_MIN, SPEED_MAX)
}

/// [`clamp_speed`] of `Number(value)`: what a setting holds ("1.1", 1.1, or nonsense).
pub fn clamp_speed_value(value: &Value) -> f64 {
    clamp_speed(js_number(Some(value)))
}

/// Speaking rate (1.0 natural) to the model's duration_delta condition.
pub fn speed_to_delta(speed: f64) -> f64 {
    let s = clamp_speed(speed);
    for i in 1..SPEED_TO_DELTA.len() {
        let (s1, d1) = SPEED_TO_DELTA[i];
        if s <= s1 {
            let (s0, d0) = SPEED_TO_DELTA[i - 1];
            return js_round((d0 + ((s - s0) / (s1 - s0)) * (d1 - d0)) * 1000.0) / 1000.0;
        }
    }
    SPEED_TO_DELTA[SPEED_TO_DELTA.len() - 1].1
}

/// A Phonon voice from an id, a bare name ("Toby") or "phonon:toby"; `None` when it is not one.
pub fn find_voice(want: &str) -> Option<&'static PhononVoice> {
    let lowered = want.to_lowercase();
    let w = trim(&lowered);
    let w = w.strip_prefix("phonon:").unwrap_or(w);
    if w.is_empty() {
        return None;
    }
    VOICES
        .iter()
        .find(|v| v.id == w)
        .or_else(|| VOICES.iter().find(|v| v.name.to_lowercase().starts_with(w)))
}

/// [`find_voice`] of a setting's value (`findVoice(store.get("voice.phonon.voice"))`).
pub fn find_voice_value(want: Option<&Value>) -> Option<&'static PhononVoice> {
    find_voice(&js_string_or_empty(want))
}

/// The name the voice catalog knows a voice by ("toby" is "Toby").
fn catalog_name(id: &str) -> String {
    match VOICES.iter().find(|v| v.id == id) {
        Some(v) => v.name.split(" (").next().unwrap_or(v.name).to_string(),
        None => id.to_string(),
    }
}

/// File written last by the installer; its presence means the install finished.
pub const INSTALL_MARKER: &str = "install.json";

/// Where everything is (`phononPaths()`).
#[derive(Debug, Clone, PartialEq)]
pub struct PhononPaths {
    pub root: PathBuf,
    pub venv: PathBuf,
    /// bin/python, or Scripts\python.exe on Windows.
    pub venv_python: PathBuf,
    /// The interpreter that runs Phonon: a path, or a command found on the PATH ("python3").
    pub python: String,
    pub uses_venv: bool,
    pub model: PathBuf,
    pub catalog: PathBuf,
    pub marker: PathBuf,
    pub worker: PathBuf,
}

/// Where everything lives. The Python interpreter is TARSEE_PHONON_PYTHON if set, else the private venv the installer
/// creates on machines without ptts (when it exists; made from the Python speech-to-text uses, `python_runtime`),
/// else python3 on PATH (the Docker image installs ptts there).
pub fn phonon_paths(app: &App) -> PhononPaths {
    let env = app.env();
    let root = env
        .trimmed("TARSEE_PHONON_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.config().data_dir.join("tts").join("phonon"));
    let venv = root.join("venv");
    let venv_python = venv_interpreter(&venv);
    let over = env.trimmed("TARSEE_PHONON_PYTHON");
    let uses_venv = over.is_none() && venv_python.exists();
    let python = match over {
        Some(over) => over,
        None if uses_venv => venv_python.to_string_lossy().into_owned(),
        None => "python3".to_string(),
    };
    PhononPaths {
        model: root.join("models").join("phonon-31m-en"),
        catalog: root.join("catalog"),
        marker: root.join(INSTALL_MARKER),
        worker: app.config().voice_scripts_dir().join("phonon_worker.py"),
        root,
        venv,
        venv_python,
        python,
        uses_venv,
    }
}

/// The model and voices are on disk and the install finished (no Python run).
pub fn phonon_installed(p: &PhononPaths) -> bool {
    p.marker.exists()
        && p.model.join("config.json").exists()
        && p.model.join("model.q8.gguf").exists()
        && p.catalog.join("voices.jsonl").exists()
        && p.worker.exists()
}

/// Work that runs to its end in a task of its own, whoever waits for it, and whose answer every caller shares (a
/// JavaScript promise kept in a variable). `failed` is the answer when the task panicked or the runtime ended.
pub(crate) type SharedTask<T> = Shared<BoxFuture<'static, T>>;

pub(crate) fn spawn_shared<T: Clone + Send + Sync + 'static>(
    work: impl std::future::Future<Output = T> + Send + 'static,
    failed: T,
) -> SharedTask<T> {
    let task = tokio::spawn(work);
    async move { task.await.unwrap_or(failed) }.boxed().shared()
}

/// `python -c "import ptts"` results, per interpreter. Only a finished install gets this far, so the cost is one short
/// Python run per interpreter.
#[derive(Default)]
struct PttsChecks {
    checks: Mutex<HashMap<String, SharedTask<bool>>>,
}

/// Whether `python` can import ptts. Cached per interpreter path; callers asking at the same time share one run, which
/// finishes (and is remembered) even when every caller has gone.
pub async fn can_import_ptts(app: &App, python: &str) -> bool {
    let check = {
        let checks = app.get_or_init(PttsChecks::default);
        let mut checks = checks.checks.lock();
        checks
            .entry(python.to_string())
            .or_insert_with(|| {
                let (app, python) = (app.clone(), python.to_string());
                spawn_shared(
                    async move {
                        let args = ["-I".to_string(), "-c".to_string(), "import ptts".to_string()];
                        let opts = RunOptions::default().timeout(Duration::from_secs(30));
                        run_python(&app, &PythonRef::new(&python), &args, opts).await.is_ok()
                    },
                    false,
                )
            })
            .clone()
    };
    check.await
}

/// Forget cached availability (after an install, so the next check sees it).
pub fn reset_phonon_availability(app: &App) {
    if let Some(checks) = app.get::<PttsChecks>() {
        checks.checks.lock().clear();
    }
}

/// `Number.parseInt(text, 10)`: leading whitespace, a sign, then digits; whatever follows them is ignored.
pub(crate) fn parse_int(text: &str) -> Option<i64> {
    let t = trim_start(text);
    let (sign, rest) = match t.as_bytes().first() {
        Some(b'-') => (-1, &t[1..]),
        Some(b'+') => (1, &t[1..]),
        _ => (1, t),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().map(|n| sign * n)
}

/// This computer's processors, as `os.availableParallelism()` counts them.
pub(crate) fn available_parallelism() -> usize {
    std::thread::available_parallelism().map(usize::from).unwrap_or(1)
}

/// Worker threads: TARSEE_PHONON_THREADS, else up to 4 (more rarely helps on CPU).
pub fn phonon_threads(env: &Env) -> usize {
    match env.get("TARSEE_PHONON_THREADS").as_deref().and_then(parse_int) {
        Some(n) if n > 0 => n as usize,
        _ => available_parallelism().clamp(1, 4),
    }
}

/// How long one sentence may take before the worker is stopped.
pub const SYNTH_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the worker may take to load the model and say it is ready.
pub const BOOT_TIMEOUT: Duration = Duration::from_secs(120);

/// The plumbing both long-running Python workers share (Phonon here, faster-whisper in `stt_handler`): a promise
/// several waiters can await, a UTF-8 decoder for output that arrives in pieces, and a started process whose output
/// is handed over as it comes and which is killed when its handle is dropped.
pub(crate) mod line_worker {
    use std::sync::Arc;
    use std::time::Duration;

    use parking_lot::Mutex;
    use tokio::io::AsyncReadExt;
    use tokio::process::{Child, ChildStdin};
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;

    /// A JavaScript promise: settled once, awaited by any number of callers.
    pub(crate) struct Promise<T: Clone> {
        value: Mutex<Option<T>>,
        notify: Notify,
    }

    impl<T: Clone> Promise<T> {
        pub(crate) fn new() -> Arc<Self> {
            Arc::new(Promise {
                value: Mutex::new(None),
                notify: Notify::new(),
            })
        }

        /// Settles it; false (and nothing changes) when it was already settled.
        pub(crate) fn settle(&self, value: T) -> bool {
            {
                let mut slot = self.value.lock();
                if slot.is_some() {
                    return false;
                }
                *slot = Some(value);
            }
            self.notify.notify_waiters();
            true
        }

        pub(crate) fn peek(&self) -> Option<T> {
            self.value.lock().clone()
        }

        pub(crate) async fn wait(&self) -> T {
            loop {
                let notified = self.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(value) = self.peek() {
                    return value;
                }
                notified.await;
            }
        }
    }

    /// Output decoded as it arrives: a character split between two reads waits for its other half (Node's
    /// `setEncoding("utf8")`).
    #[derive(Default)]
    pub(crate) struct Utf8Stream {
        pending: Vec<u8>,
    }

    impl Utf8Stream {
        pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
            self.pending.extend_from_slice(bytes);
            let valid = match std::str::from_utf8(&self.pending) {
                Ok(_) => self.pending.len(),
                Err(err) if err.error_len().is_none() => err.valid_up_to(),
                Err(_) => self.pending.len(),
            };
            let text = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
            self.pending.drain(..valid);
            text
        }
    }

    /// How a worker ended: `code` and `signal` as Node's `exit` event gave them.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub(crate) struct ExitInfo {
        pub code: Option<i32>,
        pub signal: Option<String>,
    }

    impl ExitInfo {
        fn of(status: &std::process::ExitStatus) -> Self {
            ExitInfo {
                code: status.code(),
                signal: signal_of(status),
            }
        }
    }

    #[cfg(unix)]
    fn signal_of(status: &std::process::ExitStatus) -> Option<String> {
        use std::os::unix::process::ExitStatusExt;
        signal_name(status.signal()?).map(str::to_string)
    }

    /// A signal's name as Node gives it in a child's `exit` event (its `signo_string`, in its order: the first name of
    /// a number wins). A number Node has no name for gives no signal at all (`null`).
    #[cfg(unix)]
    pub(crate) fn signal_name(signo: i32) -> Option<&'static str> {
        let mut names: Vec<(i32, &'static str)> = vec![
            (libc::SIGHUP, "SIGHUP"),
            (libc::SIGINT, "SIGINT"),
            (libc::SIGQUIT, "SIGQUIT"),
            (libc::SIGILL, "SIGILL"),
            (libc::SIGTRAP, "SIGTRAP"),
            (libc::SIGABRT, "SIGABRT"),
            (libc::SIGBUS, "SIGBUS"),
            (libc::SIGFPE, "SIGFPE"),
            (libc::SIGKILL, "SIGKILL"),
            (libc::SIGUSR1, "SIGUSR1"),
            (libc::SIGSEGV, "SIGSEGV"),
            (libc::SIGUSR2, "SIGUSR2"),
            (libc::SIGPIPE, "SIGPIPE"),
            (libc::SIGALRM, "SIGALRM"),
            (libc::SIGTERM, "SIGTERM"),
            (libc::SIGCHLD, "SIGCHLD"),
        ];
        #[cfg(any(target_os = "linux", target_os = "android"))]
        names.push((libc::SIGSTKFLT, "SIGSTKFLT"));
        names.extend([
            (libc::SIGCONT, "SIGCONT"),
            (libc::SIGSTOP, "SIGSTOP"),
            (libc::SIGTSTP, "SIGTSTP"),
            (libc::SIGTTIN, "SIGTTIN"),
            (libc::SIGTTOU, "SIGTTOU"),
            (libc::SIGURG, "SIGURG"),
            (libc::SIGXCPU, "SIGXCPU"),
            (libc::SIGXFSZ, "SIGXFSZ"),
            (libc::SIGVTALRM, "SIGVTALRM"),
            (libc::SIGPROF, "SIGPROF"),
            (libc::SIGWINCH, "SIGWINCH"),
            (libc::SIGIO, "SIGIO"),
        ]);
        #[cfg(any(target_os = "linux", target_os = "android"))]
        names.push((libc::SIGPWR, "SIGPWR"));
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
        names.push((libc::SIGINFO, "SIGINFO"));
        names.push((libc::SIGSYS, "SIGSYS"));
        names.into_iter().find(|(n, _)| *n == signo).map(|(_, name)| name)
    }

    #[cfg(not(unix))]
    fn signal_of(_status: &std::process::ExitStatus) -> Option<String> {
        None
    }

    /// The input of a running worker.
    pub(crate) type Stdin = Arc<tokio::sync::Mutex<Option<ChildStdin>>>;

    /// A running worker. Dropping the handle kills the process.
    pub(crate) struct WorkerProcess {
        stdin: Stdin,
        kill: CancellationToken,
    }

    impl WorkerProcess {
        pub(crate) fn stdin(&self) -> Stdin {
            self.stdin.clone()
        }
    }

    impl Drop for WorkerProcess {
        fn drop(&mut self) {
            self.kill.cancel();
        }
    }

    /// Watches a started worker: each piece of its output goes to `on_stdout` (decoded) and `on_stderr` (raw), and
    /// `on_exit` is called once it has ended and its output has been read.
    pub(crate) fn watch(
        mut child: Child,
        mut on_stdout: impl FnMut(&str) + Send + 'static,
        mut on_stderr: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(ExitInfo) + Send + 'static,
    ) -> WorkerProcess {
        let kill = CancellationToken::new();
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take()));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let killed = kill.clone();
        tokio::spawn(async move {
            let errors = stderr.map(|mut pipe| {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8 * 1024];
                    loop {
                        match pipe.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => on_stderr(&buf[..n]),
                        }
                    }
                })
            });
            let mut stopped = false;
            if let Some(mut pipe) = stdout {
                let mut text = Utf8Stream::default();
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    tokio::select! {
                        _ = killed.cancelled() => { stopped = true; break; }
                        read = pipe.read(&mut buf) => match read {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let chunk = text.push(&buf[..n]);
                                if !chunk.is_empty() {
                                    on_stdout(&chunk);
                                }
                            }
                        },
                    }
                }
            }
            let status = if stopped {
                let _ = child.start_kill();
                child.wait().await
            } else {
                tokio::select! {
                    _ = killed.cancelled() => {
                        let _ = child.start_kill();
                        child.wait().await
                    }
                    status = child.wait() => status,
                }
            };
            if let Some(errors) = errors {
                // What it said on its way out belongs to its exit; a pipe some other process keeps open does not.
                if tokio::time::timeout(Duration::from_secs(2), errors).await.is_err() {
                    log::debug!("[voice] a worker's stderr stayed open after it exited");
                }
            }
            on_exit(status.map(|s| ExitInfo::of(&s)).unwrap_or_default());
        });
        WorkerProcess { stdin, kill }
    }

    /// Node's words for a program that could not be started: "spawn python3 ENOENT".
    pub(crate) fn spawn_error_text(program: &str, err: &std::io::Error) -> String {
        match err.kind() {
            std::io::ErrorKind::NotFound => format!("spawn {program} ENOENT"),
            std::io::ErrorKind::PermissionDenied => format!("spawn {program} EACCES"),
            _ => format!("spawn {program} {err}"),
        }
    }

    /// Writes one line to a worker. A write to a worker that just died fails; that is reported, and the worker's
    /// exit is what the caller hears about. A closed pipe is said as Node said it: "write EPIPE".
    pub(crate) async fn write_line(stdin: &Stdin, line: &str) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt;
        let epipe = || std::io::Error::new(std::io::ErrorKind::BrokenPipe, "write EPIPE");
        let mut guard = stdin.lock().await;
        let Some(pipe) = guard.as_mut() else {
            return Err(epipe());
        };
        let written = match pipe.write_all(line.as_bytes()).await {
            Ok(()) => pipe.flush().await,
            Err(err) => Err(err),
        };
        written.map_err(|err| {
            if err.kind() == std::io::ErrorKind::BrokenPipe {
                epipe()
            } else {
                err
            }
        })
    }
}

// ── The worker ───────────────────────────────────────────────────────────

/// What a synth request waits for: the worker's answer, or why there is none.
struct Pending {
    id: u64,
    tx: oneshot::Sender<Result<Value, String>>,
}

impl Pending {
    fn resolve(self, value: Value) {
        let _ = self.tx.send(Ok(value));
    }

    fn reject(self, message: impl Into<String>) {
        let _ = self.tx.send(Err(message.into()));
    }
}

struct WorkerState {
    /// Which process the state belongs to: output and exits of an older one are ignored.
    generation: u64,
    proc: Option<WorkerProcess>,
    ready: bool,
    device: String,
    boot_error: Option<String>,
    ready_promise: Arc<Promise<()>>,
    pending: Option<Pending>,
    next_id: u64,
    stdout_buf: String,
}

struct WorkerInner {
    state: Mutex<WorkerState>,
    /// Requests run one at a time, in the order they came (the JS promise chain).
    queue: tokio::sync::Mutex<()>,
}

/// Persistent worker: one spawned Python process and a serial request queue. An app service; stopped by
/// [`stop_phonon_worker`], and its process killed when it is dropped.
pub struct PhononWorker {
    inner: Arc<WorkerInner>,
}

impl Default for PhononWorker {
    fn default() -> Self {
        Self::new()
    }
}

impl PhononWorker {
    pub fn new() -> Self {
        PhononWorker {
            inner: Arc::new(WorkerInner {
                state: Mutex::new(WorkerState {
                    generation: 0,
                    proc: None,
                    ready: false,
                    device: "unknown".into(),
                    boot_error: None,
                    ready_promise: Promise::new(),
                    pending: None,
                    next_id: 1,
                    stdout_buf: String::new(),
                }),
                queue: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// The app's worker, made when first needed.
    pub fn of(app: &App) -> Arc<PhononWorker> {
        app.get_or_init(PhononWorker::new)
    }

    /// Whether the worker has loaded the model and said so.
    pub fn is_ready(&self) -> bool {
        self.inner.state.lock().ready
    }

    /// Whether a worker process is running.
    pub fn is_running(&self) -> bool {
        self.inner.state.lock().proc.is_some()
    }

    /// Where the model runs, as the worker reported it ("cpu"), or "unknown".
    pub fn device(&self) -> String {
        self.inner.state.lock().device.clone()
    }

    /// Starts the worker, unless it is running; waits until it said it is ready, failed, or ended.
    pub async fn start(&self, app: &App) {
        let promise = self.inner.start(app);
        promise.wait().await;
    }

    /// One synth request: `{ text, voice, duration_delta, out }`; the worker's answer (`{ ok: true, ms }`) or why it
    /// failed.
    pub async fn synth(&self, app: &App, req: Value) -> Result<Value, String> {
        // The request, its place in the queue and its answer live in a task of their own, as the JS promise ran to its
        // end: a caller that goes away (a client that disconnects) must not leave its request pending for the next
        // request to receive the answer to.
        let (inner, app) = (self.inner.clone(), app.clone());
        tokio::spawn(async move { Self::queued_synth(&inner, &app, req).await })
            .await
            .unwrap_or_else(|err| Err(format!("Phonon worker stopped ({err})")))
    }

    async fn queued_synth(inner: &Arc<WorkerInner>, app: &App, req: Value) -> Result<Value, String> {
        let _turn = inner.queue.lock().await;
        let promise = {
            let running = inner.state.lock().proc.is_some();
            if running {
                inner.state.lock().ready_promise.clone()
            } else {
                inner.start(app)
            }
        };
        promise.wait().await;
        let (id, stdin, mut rx) = {
            let mut st = inner.state.lock();
            let stdin = match (&st.proc, st.ready) {
                (Some(proc), true) => proc.stdin(),
                _ => {
                    let why = st.boot_error.as_ref().map(|e| format!(": {e}")).unwrap_or_default();
                    return Err(format!("Phonon worker never became ready{why}"));
                }
            };
            let id = st.next_id;
            st.next_id += 1;
            let (tx, rx) = oneshot::channel();
            st.pending = Some(Pending { id, tx });
            (id, stdin, rx)
        };
        if let Err(err) = line_worker::write_line(&stdin, &format!("{req}\n")).await {
            log::warn!("[phonon:worker] stdin: {err}");
        }
        match tokio::time::timeout(SYNTH_TIMEOUT, &mut rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("Phonon worker stopped".into()),
            Err(_) => {
                let mine = {
                    let mut st = inner.state.lock();
                    match &st.pending {
                        Some(p) if p.id == id => {
                            st.pending = None;
                            true
                        }
                        _ => false,
                    }
                };
                if !mine && let Ok(answer) = rx.try_recv() {
                    return answer;
                }
                // A stuck worker is replaced on the next request.
                inner.stop();
                Err(format!("Phonon synth timed out after {}s", SYNTH_TIMEOUT.as_secs()))
            }
        }
    }

    /// Stops the worker process (the next request starts a fresh one).
    pub fn stop(&self) {
        self.inner.stop();
    }
}

impl WorkerInner {
    fn start(self: &Arc<Self>, app: &App) -> Arc<Promise<()>> {
        let mut st = self.state.lock();
        if st.proc.is_some() {
            return st.ready_promise.clone();
        }
        let p = phonon_paths(app);
        st.ready = false;
        st.stdout_buf.clear();
        st.boot_error = None;
        st.generation += 1;
        let generation = st.generation;

        let mut env: BTreeMap<String, String> = app.env().snapshot();
        if p.uses_venv {
            env.insert("VIRTUAL_ENV".into(), p.venv.to_string_lossy().into_owned());
        }
        env.insert("PHONON_MODEL_DIR".into(), p.model.to_string_lossy().into_owned());
        env.insert("PHONON_CATALOG".into(), p.catalog.to_string_lossy().into_owned());
        env.insert("PHONON_THREADS".into(), phonon_threads(app.env()).to_string());
        env.insert("HF_HUB_OFFLINE".into(), "1".into());
        env.insert("HF_HUB_DISABLE_TELEMETRY".into(), "1".into());
        let args = [
            "-I".to_string(),
            "-u".to_string(),
            p.worker.to_string_lossy().into_owned(),
        ];
        let mut cmd = python_command(app, &PythonRef::new(&p.python), &args, env);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                let why = format!("spawn error: {}", line_worker::spawn_error_text(&p.python, &err));
                // The promise handed back is settled: the caller sees at once that it never became ready.
                let promise = st.ready_promise.clone();
                Self::exited(&mut st, &why);
                return promise;
            }
        };

        let weak: Weak<WorkerInner> = Arc::downgrade(self);
        let (on_out, on_exit) = (weak.clone(), weak.clone());
        let mut errors = Utf8Stream::default();
        let proc = line_worker::watch(
            child,
            move |chunk| {
                if let Some(inner) = on_out.upgrade() {
                    inner.on_stdout(generation, chunk);
                }
            },
            move |bytes| {
                let text = errors.push(bytes);
                let text = trim(&text);
                if !text.is_empty() {
                    log::warn!("[phonon:worker stderr] {}", utf16_truncate(text, 300));
                }
            },
            move |exit: ExitInfo| {
                if let Some(inner) = on_exit.upgrade() {
                    let code = exit.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into());
                    let signal = exit.signal.unwrap_or_else(|| "null".into());
                    inner.on_exit(generation, &format!("code={code} signal={signal}"));
                }
            },
        );
        st.proc = Some(proc);
        let promise = st.ready_promise.clone();
        let (booting, settled) = (weak, promise.clone());
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(BOOT_TIMEOUT) => {
                    if let Some(inner) = booting.upgrade() {
                        inner.boot_timed_out(generation);
                    }
                }
                _ = settled.wait() => {}
            }
        });
        promise
    }

    /// The process is gone (`_onExit`): waiters are woken, the request in flight fails.
    fn exited(st: &mut WorkerState, why: &str) {
        log::warn!("[phonon:worker] exited {why}");
        st.proc = None;
        st.ready = false;
        if st.boot_error.is_none() {
            st.boot_error = Some(format!("exited {why}"));
        }
        // Wake anyone waiting; they see ready=false.
        let woken = std::mem::replace(&mut st.ready_promise, Promise::new());
        woken.settle(());
        if let Some(pending) = st.pending.take() {
            pending.reject(format!("Phonon worker died ({why})"));
        }
    }

    fn on_exit(&self, generation: u64, why: &str) {
        let mut st = self.state.lock();
        // An older process already replaced or stopped.
        if st.generation != generation || st.proc.is_none() {
            return;
        }
        Self::exited(&mut st, why);
    }

    fn boot_timed_out(&self, generation: u64) {
        let mut st = self.state.lock();
        if st.generation != generation || st.proc.is_none() || st.ready {
            return;
        }
        let why = format!("no ready signal after {}s", BOOT_TIMEOUT.as_secs());
        log::warn!("[phonon:worker] {why}, stopping it");
        st.boot_error = Some(why);
        Self::stop_locked(&mut st);
    }

    fn on_stdout(&self, generation: u64, chunk: &str) {
        let mut st = self.state.lock();
        if st.generation != generation {
            return;
        }
        st.stdout_buf.push_str(chunk);
        while let Some(idx) = st.stdout_buf.find('\n') {
            let line = trim(&st.stdout_buf[..idx]).to_string();
            st.stdout_buf.drain(..=idx);
            if line.is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(&line) {
                Ok(msg) => msg,
                Err(_) => {
                    log::warn!("[phonon:worker] non-JSON: {}", utf16_truncate(&line, 200));
                    continue;
                }
            };
            let ready = msg.get("ready");
            if ready == Some(&Value::Bool(true)) && !st.ready {
                st.ready = true;
                st.device = match msg.get("device") {
                    Some(d) if truthy(d) => js_template(Some(d)),
                    _ => "unknown".into(),
                };
                let voices = match msg.get("voices") {
                    Some(v) if !truthy(v) => "0".to_string(),
                    None => "0".to_string(),
                    Some(Value::Array(list)) => list.len().to_string(),
                    Some(Value::String(s)) => utf16_len(s).to_string(),
                    Some(_) => "undefined".to_string(),
                };
                log::info!(
                    "[phonon] worker ready on {} (boot {}ms, {voices} voices)",
                    st.device,
                    js_template(msg.get("boot_ms"))
                );
                st.ready_promise.settle(());
                continue;
            }
            if ready == Some(&Value::Bool(false)) {
                let error = js_string_or_empty(msg.get("error"));
                log::warn!("[phonon] worker failed to start: {}", utf16_truncate(&error, 200));
                st.boot_error = Some(if error.is_empty() {
                    "worker failed to start".into()
                } else {
                    error
                });
                st.ready_promise.settle(());
                continue;
            }
            if let Some(pending) = st.pending.take() {
                if msg.get("ok").is_some_and(truthy) {
                    pending.resolve(msg);
                } else {
                    let error = js_string_or_empty(msg.get("error"));
                    pending.reject(if error.is_empty() {
                        "phonon worker error".to_string()
                    } else {
                        error
                    });
                }
            }
        }
    }

    fn stop(&self) {
        Self::stop_locked(&mut self.state.lock());
    }

    fn stop_locked(st: &mut WorkerState) {
        let Some(proc) = st.proc.take() else {
            return;
        };
        st.ready = false;
        if let Some(pending) = st.pending.take() {
            pending.reject("Phonon worker stopped");
        }
        let woken = std::mem::replace(&mut st.ready_promise, Promise::new());
        woken.settle(());
        // Dropping the handle kills the process.
        drop(proc);
    }
}

/// Stop the warm Phonon worker (the engine was switched away from Phonon, or shutdown).
pub fn stop_phonon_worker(app: &App) {
    if let Some(worker) = app.remove::<PhononWorker>() {
        worker.stop();
    }
}

// ── The engine ───────────────────────────────────────────────────────────

/// `{ barePeso }`: read "P2,500" as pesos too (voice.phonon.barePeso).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PhononOptions {
    pub bare_peso: bool,
}

pub struct PhononTtsEngine {
    app: WeakApp,
    default_voice: &'static str,
    speed: Mutex<f64>,
    bare_peso: bool,
}

impl PhononTtsEngine {
    /// `default_voice`: a Phonon voice id or name (voice.phonon.voice).
    pub fn new(app: &App, default_voice: Option<&str>, opts: PhononOptions) -> Self {
        let wanted = default_voice.unwrap_or("");
        let found = find_voice(wanted);
        if !wanted.is_empty() && found.is_none() {
            log::warn!("[phonon] voice \"{wanted}\" is not a Phonon voice, using {DEFAULT_VOICE}.");
        }
        PhononTtsEngine {
            app: app.downgrade(),
            default_voice: found.map(|v| v.id).unwrap_or(DEFAULT_VOICE),
            speed: Mutex::new(DEFAULT_SPEED),
            bare_peso: opts.bare_peso,
        }
    }

    /// The speaking rate set now.
    pub fn speed(&self) -> f64 {
        *self.speed.lock()
    }

    /// The text as Phonon will be given it (markdown and emoji gone, pesos written out).
    pub fn speech_text(&self, text: &str) -> String {
        phonon_speech_text(
            text,
            PesoOptions {
                bare_peso: self.bare_peso,
            },
        )
    }

    fn app(&self) -> Result<App, TtsError> {
        self.app
            .upgrade()
            .ok_or_else(|| TtsError::new("Tarsee is shutting down"))
    }
}

fn random_hex(bytes: usize) -> String {
    use rand::Rng;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// A JSON number as `JSON.stringify` writes it: 0, not 0.0.
fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// What reading a file that is not there said in Node.
fn read_error(path: &std::path::Path, err: &std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        format!("ENOENT: no such file or directory, open '{}'", path.display())
    } else {
        err.to_string()
    }
}

#[async_trait]
impl TtsEngine for PhononTtsEngine {
    fn name(&self) -> &str {
        "phonon"
    }

    fn default_voice(&self) -> Option<String> {
        Some(self.default_voice.to_string())
    }

    /// Installed, and the interpreter can import ptts. Never downloads anything.
    async fn is_available(&self) -> bool {
        let Ok(app) = self.app() else { return false };
        let p = phonon_paths(&app);
        if !phonon_installed(&p) {
            return false;
        }
        can_import_ptts(&app, &p.python).await
    }

    fn set_speed(&self, speed: f64) {
        *self.speed.lock() = clamp_speed(speed);
    }

    /// Start the worker ahead of the first reply (opening voice mode).
    async fn warm(&self) -> Result<(), TtsError> {
        let app = self.app()?;
        let worker = PhononWorker::of(&app);
        worker.start(&app).await;
        if !worker.is_ready() {
            return Err(TtsError::new("Phonon worker did not start"));
        }
        Ok(())
    }

    async fn synthesize(
        &self,
        text: &str,
        voice_id: Option<&str>,
        opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError> {
        if text.is_empty() {
            return Err(TtsError::new("Text is required"));
        }
        let text = self.speech_text(text);
        if text.is_empty() {
            return Err(TtsError::new("No speakable text after cleanup").code("EMPTY_TEXT"));
        }
        let app = self.app()?;

        // Ids from other engines (an Edge or ElevenLabs voice) are not Phonon voices: speak with Phonon's own default
        // rather than fail.
        let voice = find_voice(voice_id.unwrap_or(""))
            .map(|v| v.id)
            .unwrap_or(self.default_voice);
        let speed = match opts.speed {
            Some(speed) => clamp_speed(speed),
            None => self.speed(),
        };

        let tmp_out = os_tmpdir(app.env()).join(format!("phonon-{}.wav", random_hex(6)));
        let worker = PhononWorker::of(&app);
        let t0 = now_ms();
        let req = json!({
            "text": text,
            "voice": catalog_name(voice),
            "duration_delta": json_number(speed_to_delta(speed)),
            "out": tmp_out.to_string_lossy(),
        });
        // The line and the removal of its WAV run to their end in a task of their own (the JS `try/finally` did),
        // whether or not the caller is still waiting.
        let line = async move {
            let result = async {
                let res = worker.synth(&app, req).await.map_err(TtsError::new)?;
                let audio = tokio::fs::read(&tmp_out)
                    .await
                    .map_err(|err| TtsError::new(read_error(&tmp_out, &err)))?;
                if audio.len() < 100 {
                    return Err(TtsError::new("Phonon generated empty audio"));
                }
                log::info!(
                    "[phonon] {} chars, voice={voice}, {}B in {}ms (worker {}ms on {})",
                    utf16_len(&text),
                    audio.len(),
                    now_ms() - t0,
                    js_template(res.get("ms")),
                    worker.device()
                );
                Ok(Synthesized {
                    audio: Bytes::from(audio),
                    content_type: "audio/wav".into(),
                })
            }
            .await;
            // Not written, or already gone: either way there is nothing to remove.
            let _ = tokio::fs::remove_file(&tmp_out).await;
            result
        };
        tokio::spawn(line)
            .await
            .unwrap_or_else(|err| Err(TtsError::new(format!("Phonon worker stopped ({err})"))))
    }

    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        Ok(VOICES.iter().map(|v| VoiceInfo::new(v.id, v.name)).collect())
    }

    async fn clone_voice(&self, _audio_sample: &[u8], _name: &str) -> Result<ClonedVoice, TtsError> {
        Err(TtsError::with_status(
            "Phonon has no local voice cloning (it is only in Gradium's paid API). Pick one of its built-in voices.",
            400,
        ))
    }

    fn stop(&self) {
        if let Some(app) = self.app.upgrade() {
            stop_phonon_worker(&app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{test_app, test_app_with_env};
    use crate::voice::speech_text::{clean_speech_text, speak_pesos};

    // test/tts-phonon.test.js, "Phonon text: pesos and cleanup".

    fn bare() -> PesoOptions {
        PesoOptions { bare_peso: true }
    }

    #[test]
    fn peso_sign_and_php_amounts_are_written_out_so_phonon_reads_them() {
        let none = PesoOptions::default();
        assert_eq!(
            speak_pesos("The invoice is ₱12,500, plus ₱3,750.", none),
            "The invoice is 12,500 pesos, plus 3,750 pesos."
        );
        assert_eq!(
            speak_pesos("PHP 2,500 and Php1.5M and ₱ 300k", none),
            "2,500 pesos and 1.5 million pesos and 300 thousand pesos"
        );
        assert_eq!(speak_pesos("₱12,500 pesos lang", none), "12,500 pesos lang");
        assert_eq!(speak_pesos("₱1,250,000.50.", none), "1,250,000.50 pesos.");
        assert_eq!(speak_pesos("₱5 each", none), "5 pesos each");
    }

    #[test]
    fn php_the_programming_language_is_left_alone() {
        let none = PesoOptions::default();
        assert_eq!(
            speak_pesos("Upgrade to PHP 8.3 first", none),
            "Upgrade to PHP 8.3 first"
        );
        assert_eq!(speak_pesos("runs on PHP 7", none), "runs on PHP 7");
        assert_eq!(speak_pesos("PHP 5.6.40 is old", none), "PHP 5.6.40 is old");
        assert_eq!(
            speak_pesos("PHP 8 pesos", none),
            "8 pesos",
            "with the word pesos it is money"
        );
        assert_eq!(speak_pesos("PHP 500", none), "500 pesos");
    }

    #[test]
    fn a_bare_p_is_money_only_when_the_bare_peso_option_is_on() {
        let none = PesoOptions::default();
        assert_eq!(speak_pesos("P2,500 or P99.50", none), "P2,500 or P99.50");
        assert_eq!(speak_pesos("P2,500 or P99.50", bare()), "2,500 pesos or 99.50 pesos");
        assert_eq!(speak_pesos("a P1 bug, P2 and MP3", bare()), "a P1 bug, P2 and MP3");
        assert_eq!(phonon_speech_text("Total: P1,200", bare()), "Total: 1,200 pesos");
        assert_eq!(phonon_speech_text("Total: P1,200", none), "Total: P1,200");
    }

    #[test]
    fn the_cleanup_drops_emoji_code_and_markdown() {
        assert_eq!(
            clean_speech_text("**Hi** \u{1F600} `code` [link](http://x)\n\nnext\nline"),
            "Hi link. next line"
        );
        assert_eq!(
            phonon_speech_text("**Paid** ₱500 \u{1F44D}\u{FE0F}", PesoOptions::default()),
            "Paid 500 pesos"
        );
        assert_eq!(clean_speech_text("```js\nx()\n```"), "");
    }

    #[test]
    fn the_engine_reads_the_bare_peso_option_it_was_built_with_off_by_default() {
        let t = test_app();
        assert_eq!(
            PhononTtsEngine::new(&t, Some("toby"), PhononOptions::default()).speech_text("P2,500 and ₱300"),
            "P2,500 and 300 pesos"
        );
        assert_eq!(
            PhononTtsEngine::new(&t, Some("toby"), PhononOptions { bare_peso: true }).speech_text("P2,500 and ₱300"),
            "2,500 pesos and 300 pesos"
        );
    }

    // "Phonon voices and speed".

    #[test]
    fn speed_maps_to_the_model_s_duration_condition_inside_the_range_it_holds() {
        assert_eq!(speed_to_delta(1.0), 0.0);
        assert!(
            speed_to_delta(1.1) < 0.0 && speed_to_delta(1.25) < speed_to_delta(1.1),
            "faster is a more negative delta"
        );
        assert!(speed_to_delta(0.9) > 0.0);
        assert_eq!(speed_to_delta(3.0), speed_to_delta(SPEED_MAX));
        assert_eq!(speed_to_delta(0.1), speed_to_delta(SPEED_MIN));
        assert_eq!(clamp_speed_value(&json!("1.3")), SPEED_MAX);
        assert_eq!(clamp_speed_value(&json!("nonsense")), 1.0);
    }

    #[test]
    fn voices_names_ids_and_other_engines_ids() {
        let t = test_app();
        assert_eq!(DEFAULT_VOICE, "toby");
        assert_eq!(find_voice("Toby").unwrap().id, "toby");
        assert_eq!(find_voice("phonon:teddy").unwrap().id, "teddy");
        assert_eq!(find_voice("en-US-AndrewMultilingualNeural"), None);
        assert_eq!(
            PhononTtsEngine::new(&t, Some("en-US-AndrewMultilingualNeural"), PhononOptions::default())
                .default_voice()
                .as_deref(),
            Some(DEFAULT_VOICE)
        );
        assert_eq!(
            PhononTtsEngine::new(&t, Some("Harper"), PhononOptions::default())
                .default_voice()
                .as_deref(),
            Some("harper")
        );
    }

    #[tokio::test]
    async fn an_empty_install_folder_is_not_available_so_edge_tts_takes_over() {
        let t = test_app();
        let none = t.path().join("phonon-none");
        t.env().set("TARSEE_PHONON_DIR", none.to_string_lossy().to_string());
        assert!(!phonon_installed(&phonon_paths(&t)));
        assert!(
            !PhononTtsEngine::new(&t, None, PhononOptions::default())
                .is_available()
                .await
        );
    }

    // Added: what the Node tests went through without naming.

    #[test]
    fn speed_to_delta_matches_the_javascript_values() {
        // Computed by phonon-engine.js.
        for (speed, delta) in [
            (0.85, 0.5),
            (0.87, 0.36),
            (0.9, 0.15),
            (0.95, 0.075),
            (1.05, -0.075),
            (1.1, -0.15),
            (1.15, -0.225),
            (1.2, -0.3),
            (1.22, -0.36),
            (1.25, -0.45),
        ] {
            assert_eq!(speed_to_delta(speed), delta, "speed {speed}");
        }
        assert_eq!(clamp_speed(f64::NAN), 1.0);
        assert_eq!(clamp_speed(f64::INFINITY), 1.0);
        assert_eq!(clamp_speed_value(&json!(null)), SPEED_MIN, "Number(null) is 0");
        assert_eq!(clamp_speed_value(&json!(" 1.1 ")), 1.1);
        assert_eq!(clamp_speed_value(&json!("0x1")), 1.0);
        assert_eq!(clamp_speed_value(&json!("inf")), 1.0, "not a number in JavaScript");
        assert_eq!(clamp_speed_value(&json!(true)), 1.0);
    }

    #[test]
    fn find_voice_trims_lowercases_and_takes_a_name_prefix() {
        assert_eq!(find_voice("  PHONON:Elodie").unwrap().id, "elodie-rose");
        assert_eq!(find_voice("").map(|v| v.id), None);
        assert_eq!(find_voice("phonon:").map(|v| v.id), None);
        assert_eq!(find_voice_value(Some(&json!("Zoey"))).unwrap().id, "zoey");
        assert_eq!(find_voice_value(Some(&json!(0))).map(|v| v.id), None);
        assert_eq!(find_voice_value(None).map(|v| v.id), None);
        assert_eq!(catalog_name("elodie-rose"), "Elodie-Rose");
        assert_eq!(catalog_name("nobody"), "nobody");
    }

    #[test]
    fn the_paths_follow_the_environment_and_the_venv() {
        let t = test_app();
        let p = phonon_paths(&t);
        assert_eq!(p.root, t.config().data_dir.join("tts").join("phonon"));
        assert_eq!(p.python, "python3");
        assert!(!p.uses_venv);
        assert_eq!(p.venv_python, venv_interpreter(&p.venv));
        assert_eq!(p.marker, p.root.join("install.json"));
        assert_eq!(p.worker, t.config().voice_scripts_dir().join("phonon_worker.py"));
        assert!(p.worker.is_file(), "the worker script ships with Tarsee");

        std::fs::create_dir_all(p.venv_python.parent().unwrap()).unwrap();
        std::fs::write(&p.venv_python, "").unwrap();
        let p = phonon_paths(&t);
        assert!(p.uses_venv);
        assert_eq!(p.python, p.venv_python.to_string_lossy());

        let t = test_app_with_env([
            ("TARSEE_PHONON_DIR", " /x/phonon "),
            ("TARSEE_PHONON_PYTHON", "/opt/py"),
        ]);
        let p = phonon_paths(&t);
        assert_eq!(p.root, PathBuf::from("/x/phonon"));
        assert_eq!((p.python.as_str(), p.uses_venv), ("/opt/py", false));
    }

    #[test]
    fn threads_come_from_the_environment_else_up_to_four() {
        assert_eq!(phonon_threads(&Env::from_pairs([("TARSEE_PHONON_THREADS", "6")])), 6);
        assert_eq!(phonon_threads(&Env::from_pairs([("TARSEE_PHONON_THREADS", " 3x")])), 3);
        let auto = phonon_threads(&Env::from_pairs([("TARSEE_PHONON_THREADS", "0")]));
        assert!((1..=4).contains(&auto));
        assert_eq!(phonon_threads(&Env::new()), auto);
        assert_eq!(parse_int("-2"), Some(-2));
        assert_eq!(parse_int("abc"), None);
    }

    #[tokio::test]
    async fn voices_listing_and_cloning() {
        let t = test_app();
        let engine = PhononTtsEngine::new(&t, None, PhononOptions::default());
        let voices = engine.list_voices().await.unwrap();
        assert_eq!(voices.len(), VOICES.len());
        assert_eq!(
            serde_json::to_value(&voices[0]).unwrap(),
            json!({"id": "toby", "name": "Toby (British male, adult)", "isClone": false})
        );
        let err = engine.clone_voice(b"RIFF", "me").await.unwrap_err();
        assert_eq!(err.status, Some(400));
        assert!(err.message.starts_with("Phonon has no local voice cloning"));
        assert_eq!(engine.name(), "phonon");
        engine.set_speed(9.0);
        assert_eq!(engine.speed(), SPEED_MAX);
    }

    #[tokio::test]
    async fn nothing_to_say_is_refused_before_any_worker_starts() {
        let t = test_app();
        let engine = PhononTtsEngine::new(&t, None, PhononOptions::default());
        let err = engine.synthesize("", None, &SynthOptions::default()).await.unwrap_err();
        assert_eq!(err.message, "Text is required");
        let err = engine
            .synthesize("```code```", None, &SynthOptions::default())
            .await
            .unwrap_err();
        assert!(err.has_code("EMPTY_TEXT"));
        assert!(!PhononWorker::of(&t).is_running());
    }

    #[tokio::test]
    async fn a_python_that_is_not_there_is_said_in_node_s_words() {
        let t = test_app_with_env([("TARSEE_PHONON_PYTHON", "no-such-python-for-phonon"), ("PATH", "")]);
        let engine = PhononTtsEngine::new(&t, None, PhononOptions::default());
        let err = engine
            .synthesize("Hello", None, &SynthOptions::default())
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Phonon worker never became ready: exited spawn error: spawn no-such-python-for-phonon ENOENT"
        );
        assert!(engine.warm().await.is_err());
    }

    #[test]
    fn javascript_numbers_and_templates() {
        assert_eq!(js_number(Some(&json!(""))), 0.0);
        assert_eq!(js_number(Some(&json!("0b11"))), 3.0);
        assert!(js_number(Some(&json!("1e"))).is_nan());
        assert_eq!(js_number(Some(&json!("-Infinity"))), f64::NEG_INFINITY);
        assert_eq!(js_number(Some(&json!([" 2 "]))), 2.0);
        assert_eq!(js_template(None), "undefined");
        assert_eq!(js_template(Some(&json!(12.0))), "12");
        assert_eq!(js_template(Some(&json!([1, null, "a"]))), "1,,a");
        assert_eq!(js_string_or_empty(Some(&json!(false))), "");
        assert_eq!(json_number(0.0), json!(0));
        assert_eq!(json_number(-0.15), json!(-0.15));
        assert_eq!(js_round(-2.5), -2.0);
    }
}
