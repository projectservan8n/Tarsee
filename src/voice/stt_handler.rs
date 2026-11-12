//! Port of `src/voice/stt-handler.js`. Speech-to-text: faster-whisper on this server (free, private, no API key), or
//! the paid OpenAI Whisper API when the owner chooses it (voice.stt_provider = "whisper-api").
//!
//! Use it with [`transcribe_audio`], or over HTTP (`routes::voice`):
//!   POST /api/voice/transcribe   the audio as the body (a short WAV is fine; WebM/Opus, Ogg, MP3 and M4A work too),
//!                                or multipart with an "audio" file; X-Language: en (optional)
//!                                -> 200 { text, language, provider }, or { error } with 501 (not set up), 503 (no model
//!                                   yet, one is downloading) or 500 (this audio failed); the error says what to do
//!   POST /api/voice/stt/warm     start faster-whisper and load the model now (a call opening), so the first reply
//!                                isn't slowed by it -> { ok, model } or { ok: false, error }
//!
//! Local transcription runs one persistent worker (stt_worker.py) with the Python that has faster-whisper
//! (`stt_install::find_stt_runtime`: Tarsee's own install, or the Docker image's python3). The model loads once and
//! stays loaded; after 10 idle minutes the worker stops to give its memory back. The worker is always handed a model
//! folder on disk, never a name, so transcribing never downloads anything. When the chosen model isn't on disk, the
//! closest one that is transcribes and the chosen one downloads in the background.
//!
//! Models (`whisper_models`): tiny.en (~78 MB), base.en (~148 MB, the default, in the Docker image), small.en
//! (~486 MB); and tiny, base, small, which understand many languages. The .en ones are English only.
//!
//! The worker is the app service [`SttWorker`]; [`stop_stt_worker`] stops its process, and dropping it (with the app)
//! kills the process too.

use std::collections::BTreeMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use bytes::Bytes;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio::task::AbortHandle;

use super::engine_registry::api_key;
use super::phonon_engine::line_worker::{self, ExitInfo, Promise, WorkerProcess};
use super::phonon_engine::{available_parallelism, js_round, js_string_or_empty, js_template};
use super::python_runtime::{SpawnOptions, spawn_python};
use super::speech_text::js_trim;
use super::stt_install::{
    MODEL_RETRY_PAUSE, ReadyRuntime, ResolvedModel, SttModelRow, chosen_model, find_stt_runtime, list_stt_models,
    model_failed_recently, resolve_stt_model, start_model_download, stt_provider,
};
use super::tts_interface::os_tmpdir;
use super::whisper_models::{WHISPER_MODELS, model_bytes};
use crate::app::App;
use crate::db::settings::Settings;
use crate::net::fetch::FetchRequest;
use crate::util::js::{now_ms, number_to_string, truthy, utf16_len, utf16_tail, utf16_truncate};

const BOOT_TIMEOUT: Duration = Duration::from_secs(90);
const IDLE: Duration = Duration::from_secs(10 * 60);

/// Kept for older callers: the chosen model is read from the settings on every transcription now.
pub fn reset_stt_model_cache() {}

// ── The worker ───────────────────────────────────────────────────────────

/// The last line with text.
fn last_line(text: &str) -> String {
    text.split('\n')
        .map(|l| js_trim(l.strip_suffix('\r').unwrap_or(l)))
        .rfind(|l| !l.is_empty())
        .unwrap_or("")
        .to_string()
}

struct SttPending {
    id: u64,
    tx: oneshot::Sender<Result<Value, String>>,
}

impl SttPending {
    fn reject(self, message: impl Into<String>) {
        let _ = self.tx.send(Err(message.into()));
    }
}

/// Whether the worker loaded faster-whisper: `Ok`, or why it did not start.
type Ready = Arc<Promise<Result<(), String>>>;

struct SttState {
    generation: u64,
    proc: Option<WorkerProcess>,
    /// Which Python the running worker is (`JSON.stringify(rt.python)`).
    key: Option<String>,
    ready: Ready,
    is_ready: bool,
    pending: Option<SttPending>,
    buf: String,
    err_tail: String,
    next_id: u64,
    version: Option<String>,
}

struct SttInner {
    state: Mutex<SttState>,
    /// Requests run one at a time, in the order they came (the JS promise chain).
    queue: tokio::sync::Mutex<()>,
    idle: Mutex<Option<AbortHandle>>,
}

/// The persistent faster-whisper worker. An app service; stopped by [`stop_stt_worker`] and after 10 idle minutes, and
/// its process killed when it is dropped.
pub struct SttWorker {
    inner: Arc<SttInner>,
}

impl Default for SttWorker {
    fn default() -> Self {
        Self::new()
    }
}

impl SttWorker {
    pub fn new() -> Self {
        let ready: Ready = Promise::new();
        ready.settle(Err("the speech-to-text worker was not started".into()));
        SttWorker {
            inner: Arc::new(SttInner {
                state: Mutex::new(SttState {
                    generation: 0,
                    proc: None,
                    key: None,
                    ready,
                    is_ready: false,
                    pending: None,
                    buf: String::new(),
                    err_tail: String::new(),
                    next_id: 1,
                    version: None,
                }),
                queue: tokio::sync::Mutex::new(()),
                idle: Mutex::new(None),
            }),
        }
    }

    /// The app's worker, made when first needed.
    pub fn of(app: &App) -> Arc<SttWorker> {
        app.get_or_init(SttWorker::new)
    }

    /// Whether a worker process is running.
    pub fn is_running(&self) -> bool {
        self.inner.state.lock().proc.is_some()
    }

    /// The faster-whisper version the worker reported when it started.
    pub fn version(&self) -> Option<String> {
        self.inner.state.lock().version.clone()
    }

    /// Transcribe one file (`req`: `{ audio, model, language, threads }`); requests run one at a time.
    pub async fn transcribe(
        &self,
        app: &App,
        rt: &ReadyRuntime,
        req: Map<String, Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let inner = &self.inner;
        let _turn = inner.queue.lock().await;
        inner.clear_idle();
        let result = inner.run_one(app, rt, req, timeout).await;
        inner.arm_idle(idle_for(app));
        result
    }

    /// Stops the worker (before a model is deleted, after an install, at shutdown). The next transcription starts it
    /// again.
    pub fn stop(&self) {
        self.inner.stop();
    }
}

impl SttInner {
    /// Start the worker for this Python (or keep the one running). Settles when it has loaded faster-whisper.
    fn start(self: &Arc<Self>, app: &App, rt: &ReadyRuntime) -> Ready {
        let key = json!({ "cmd": rt.python.cmd, "args": rt.python.args }).to_string();
        let mut st = self.state.lock();
        if st.proc.is_some() && st.key.as_deref() == Some(key.as_str()) {
            return st.ready.clone();
        }
        Self::stop_locked(&mut st);
        self.clear_idle();
        st.key = Some(key);
        st.is_ready = false;
        st.buf.clear();
        st.err_tail.clear();
        st.ready = Promise::new();
        st.generation += 1;
        let generation = st.generation;

        let mut env: BTreeMap<String, String> = app.env().snapshot();
        env.insert("HF_HUB_OFFLINE".into(), "1".into());
        env.insert("HF_HUB_DISABLE_TELEMETRY".into(), "1".into());
        let worker = app.config().voice_scripts_dir().join("stt_worker.py");
        let args = [
            "-I".to_string(),
            "-u".to_string(),
            worker.to_string_lossy().into_owned(),
        ];
        let spawned = spawn_python(
            app,
            &rt.python,
            &args,
            SpawnOptions {
                env: Some(env),
                cwd: None,
            },
        );
        let child = match spawned {
            Ok(child) => child,
            Err(err) => {
                let why = if err.kind() == std::io::ErrorKind::NotFound {
                    "could not start: its Python was not found".to_string()
                } else {
                    format!(
                        "could not start ({})",
                        line_worker::spawn_error_text(&rt.python.cmd, &err)
                    )
                };
                st.key = None;
                st.ready.settle(Err(format!("the speech-to-text worker {why}")));
                return st.ready.clone();
            }
        };

        let weak: Weak<SttInner> = Arc::downgrade(self);
        let (on_out, on_err, on_exit) = (weak.clone(), weak.clone(), weak.clone());
        let proc = line_worker::watch(
            child,
            move |chunk| {
                if let Some(inner) = on_out.upgrade() {
                    inner.on_data(generation, chunk);
                }
            },
            move |bytes| {
                if let Some(inner) = on_err.upgrade() {
                    let mut st = inner.state.lock();
                    if st.generation == generation {
                        let joined = format!("{}{}", st.err_tail, String::from_utf8_lossy(bytes));
                        st.err_tail = if utf16_len(&joined) > 4000 {
                            utf16_tail(&joined, 4000)
                        } else {
                            joined
                        };
                    }
                }
            },
            move |exit: ExitInfo| {
                if let Some(inner) = on_exit.upgrade() {
                    let how = exit.signal.unwrap_or_else(|| {
                        format!(
                            "exit code {}",
                            exit.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
                        )
                    });
                    inner.exit(generation, &format!("stopped ({how})"), false);
                }
            },
        );
        st.proc = Some(proc);
        let ready = st.ready.clone();
        let (booting, settled) = (weak, ready.clone());
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(BOOT_TIMEOUT) => {
                    if let Some(inner) = booting.upgrade() {
                        let still_booting = {
                            let st = inner.state.lock();
                            st.generation == generation && st.proc.is_some() && !st.is_ready
                        };
                        if still_booting {
                            inner.exit(generation, &format!("did not start within {}s", BOOT_TIMEOUT.as_secs()), true);
                        }
                    }
                }
                _ = settled.wait() => {}
            }
        });
        ready
    }

    fn on_data(&self, generation: u64, chunk: &str) {
        let mut st = self.state.lock();
        if st.generation != generation || st.proc.is_none() {
            return;
        }
        st.buf.push_str(chunk);
        while let Some(i) = st.buf.find('\n') {
            let line = js_trim(&st.buf[..i]).to_string();
            st.buf.drain(..=i);
            if line.is_empty() {
                continue;
            }
            // A library printing to stdout.
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match msg.get("ready") {
                Some(Value::Bool(true)) => {
                    st.is_ready = true;
                    st.version = msg.get("version").filter(|v| truthy(v)).map(|v| js_template(Some(v)));
                    st.ready.settle(Ok(()));
                }
                Some(Value::Bool(false)) => {
                    let error = js_string_or_empty(msg.get("error"));
                    let error = if error.is_empty() {
                        "unknown error".to_string()
                    } else {
                        error
                    };
                    st.ready.settle(Err(format!("faster-whisper did not start: {error}")));
                }
                _ => {
                    let theirs = msg.get("id").and_then(Value::as_f64);
                    let ours = st.pending.as_ref().is_some_and(|p| theirs == Some(p.id as f64));
                    if ours && let Some(p) = st.pending.take() {
                        let error = msg.get("error").filter(|e| truthy(e)).map(|e| js_template(Some(e)));
                        let _ = p.tx.send(match error {
                            Some(error) => Err(error),
                            None => Ok(msg),
                        });
                    }
                }
            }
        }
    }

    /// The process is gone, or has to go (`_exit`): who waits on it hears why, with the last line it printed.
    fn exit(&self, generation: u64, why: &str, kill: bool) {
        let mut st = self.state.lock();
        if st.generation != generation || st.proc.is_none() {
            return;
        }
        let proc = st.proc.take();
        st.key = None;
        let tail = last_line(&st.err_tail);
        let detail = if tail.is_empty() {
            String::new()
        } else {
            format!(": {}", utf16_truncate(&tail, 300))
        };
        let err = format!("the speech-to-text worker {why}{detail}");
        if !st.is_ready {
            st.ready.settle(Err(err.clone()));
        }
        if let Some(p) = st.pending.take() {
            p.reject(err);
        }
        drop(st);
        // Dropping the handle kills the process (`kill`: one that hangs); one that exited by itself is already gone.
        let _ = kill;
        drop(proc);
    }

    async fn run_one(
        self: &Arc<Self>,
        app: &App,
        rt: &ReadyRuntime,
        req: Map<String, Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let ready = self.start(app, rt);
        ready.wait().await?;
        let (id, stdin, mut rx) = {
            let mut st = self.state.lock();
            let Some(proc) = st.proc.as_ref() else {
                return Err("the speech-to-text worker stopped".into());
            };
            let stdin = proc.stdin();
            let id = st.next_id;
            st.next_id += 1;
            let (tx, rx) = oneshot::channel();
            st.pending = Some(SttPending { id, tx });
            (id, stdin, rx)
        };
        let mut line = Map::new();
        line.insert("id".into(), json!(id));
        line.extend(req);
        // A write to a worker that just died fails; its exit is what the caller hears about.
        let _ = line_worker::write_line(&stdin, &format!("{}\n", Value::Object(line))).await;
        match tokio::time::timeout(timeout, &mut rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("the speech-to-text worker was stopped".into()),
            Err(_) => {
                let mine = {
                    let mut st = self.state.lock();
                    if st.pending.as_ref().is_some_and(|p| p.id == id) {
                        st.pending = None;
                        true
                    } else {
                        false
                    }
                };
                if !mine && let Ok(answer) = rx.try_recv() {
                    return answer;
                }
                // A stuck worker is replaced on the next request.
                self.stop();
                Err(format!(
                    "faster-whisper took longer than {}s",
                    number_to_string(js_round(timeout.as_millis() as f64 / 1000.0))
                ))
            }
        }
    }

    fn clear_idle(&self) {
        if let Some(timer) = self.idle.lock().take() {
            timer.abort();
        }
    }

    fn arm_idle(self: &Arc<Self>, after: Duration) {
        self.clear_idle();
        let weak = Arc::downgrade(self);
        let timer = tokio::spawn(async move {
            tokio::time::sleep(after).await;
            if let Some(inner) = weak.upgrade() {
                inner.stop();
            }
        });
        *self.idle.lock() = Some(timer.abort_handle());
    }

    fn stop(&self) {
        self.clear_idle();
        Self::stop_locked(&mut self.state.lock());
    }

    fn stop_locked(st: &mut SttState) {
        let Some(proc) = st.proc.take() else {
            return;
        };
        st.key = None;
        let err = "the speech-to-text worker was stopped";
        if !st.is_ready {
            st.ready.settle(Err(err.into()));
        }
        if let Some(p) = st.pending.take() {
            p.reject(err);
        }
        // Dropping the handle kills the process.
        drop(proc);
    }
}

/// Stop the worker (before a model is deleted, after an install, at shutdown). The next transcription starts it again.
pub fn stop_stt_worker(app: &App) {
    if let Some(worker) = app.get::<SttWorker>() {
        worker.stop();
    }
}

// ── The tests' seam ──────────────────────────────────────────────────────

/// Whether local transcription is set up.
pub type AvailableFn = Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>;
/// Transcribes audio locally.
pub type TranscribeFn = Arc<dyn Fn(Bytes) -> BoxFuture<'static, Result<SttResult, SttError>> + Send + Sync>;

/// A stand-in for local transcription: its `available` and/or `transcribe` replace the real ones.
#[derive(Clone, Default)]
pub struct LocalTranscriber {
    pub available: Option<AvailableFn>,
    pub transcribe: Option<TranscribeFn>,
}

impl LocalTranscriber {
    /// `{ available: () => available }`.
    pub fn available(available: bool) -> Self {
        LocalTranscriber {
            available: Some(Arc::new(move || Box::pin(async move { available }))),
            transcribe: None,
        }
    }

    /// Adds a transcriber that always answers `result`.
    pub fn answering(mut self, result: Result<SttResult, SttError>) -> Self {
        self.transcribe = Some(Arc::new(move |_audio| {
            let result = result.clone();
            Box::pin(async move { result })
        }));
        self
    }
}

/// Tests only: `__setForTests({ local, timeoutMs, idleMs })`. `local` replaces the local transcriber's `available`
/// and/or `transcribe` (`None` restores the real one); `timeout_ms` and `idle_ms` shorten the worker's waits.
#[derive(Clone, Default)]
pub struct SttTestOverrides {
    pub local: Option<LocalTranscriber>,
    pub timeout_ms: Option<u64>,
    pub idle_ms: Option<u64>,
}

pub fn set_for_tests(app: &App, overrides: SttTestOverrides) {
    let empty =
        overrides.local.is_none() && overrides.timeout_ms.unwrap_or(0) == 0 && overrides.idle_ms.unwrap_or(0) == 0;
    if empty {
        app.remove::<SttTestOverrides>();
    } else {
        app.set(overrides);
    }
}

fn overrides(app: &App) -> Option<Arc<SttTestOverrides>> {
    app.get::<SttTestOverrides>()
}

fn idle_for(app: &App) -> Duration {
    overrides(app)
        .and_then(|o| o.idle_ms)
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(IDLE)
}

// ── Local transcription ──────────────────────────────────────────────────

/// What a transcription gave: `{ transcript, language, provider }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SttResult {
    pub transcript: String,
    pub language: String,
    pub provider: String,
}

/// Why nothing could transcribe, in words the owner can act on: `status` is what the HTTP routes answer with, and
/// `code` ("stt-unavailable", "stt-failed") lets the channels pass the message on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SttError {
    pub message: String,
    pub status: Option<u16>,
    pub code: Option<String>,
}

impl SttError {
    /// An error with no status or code (a failure the owner can't act on directly).
    pub fn plain(message: impl Into<String>) -> Self {
        SttError {
            message: message.into(),
            status: None,
            code: None,
        }
    }
}

fn stt_error(message: impl Into<String>, status: u16, code: &str) -> SttError {
    SttError {
        message: message.into(),
        status: Some(status),
        code: Some(code.into()),
    }
}

/// How long one recording may take: loading the model, then about real time or better on a CPU.
fn timeout_for(app: &App, model: &str, bytes: usize) -> Duration {
    if let Some(ms) = overrides(app).and_then(|o| o.timeout_ms).filter(|ms| *ms > 0) {
        return Duration::from_millis(ms);
    }
    let size = model.strip_suffix(".en").unwrap_or(model);
    let per_second = match size {
        "small" => 1.5,
        "base" => 0.6,
        _ => 0.3,
    };
    // Opus at ~128 kbit/s; a 16 kHz WAV is half this, so it gets twice the time.
    let seconds = bytes as f64 / 16_000.0;
    let ms = (10.0 * 60_000.0f64).min(js_round(30_000.0 + seconds * per_second * 1000.0 + 20_000.0));
    Duration::from_millis(ms as u64)
}

/// The file name ending that tells faster-whisper (PyAV) what the audio is.
fn audio_ext(buf: &[u8]) -> &'static str {
    let at = |i: usize| buf.get(i).copied();
    let slice = |from: usize, to: usize| buf.get(from..to.min(buf.len())).unwrap_or(&[]);
    if slice(0, 4) == b"RIFF" {
        return ".wav";
    }
    if slice(0, 4) == b"OggS" {
        return ".ogg";
    }
    if (at(0), at(1), at(2), at(3)) == (Some(0x1a), Some(0x45), Some(0xdf), Some(0xa3)) {
        return ".webm";
    }
    if slice(4, 8) == b"ftyp" {
        return ".m4a";
    }
    if slice(0, 3) == b"ID3" || (at(0) == Some(0xff) && at(1).is_some_and(|b| b & 0xe0 == 0xe0)) {
        return ".mp3";
    }
    ".audio"
}

fn random_hex(bytes: usize) -> String {
    use rand::Rng;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// Start downloading a model nobody asked to download right now; false when another job is running, or when its last
/// download failed a moment ago (Settings shows why, with Try again; a recording doesn't retry it every time).
fn download_quietly(app: &App, name: &str) -> bool {
    if model_failed_recently(app, name, MODEL_RETRY_PAUSE) {
        return false;
    }
    start_model_download(app, name, Default::default()).is_ok()
}

fn threads() -> usize {
    available_parallelism().clamp(1, 4)
}

/// Transcribe with faster-whisper on this server.
async fn transcribe_local(app: &App, audio: &[u8], settings: Option<&dyn Settings>) -> Result<SttResult, SttError> {
    let rt = find_stt_runtime(app, false).await;
    let Some(rt) = rt.ready() else {
        return Err(stt_error(
            format!("Speech-to-text is unavailable: {NOT_INSTALLED}. {INSTALL_OR_PAID}"),
            501,
            "stt-unavailable",
        ));
    };
    let (model, wanted) = match resolve_stt_model(app, &chosen_model(app, settings)) {
        ResolvedModel::Missing(missing) => {
            let bytes = model_bytes(&missing, &WHISPER_MODELS).map_err(|err| SttError::plain(err.message))?;
            let mb = number_to_string(js_round(bytes as f64 / 1e6));
            let started = download_quietly(app, &missing);
            return Err(stt_error(
                if started {
                    format!(
                        "No speech model is downloaded yet. Tarsee is downloading {missing} ({mb} MB) now: try again in a minute."
                    )
                } else {
                    "No speech model is downloaded yet. Download one in Settings > Voice > Speech-to-text.".to_string()
                },
                503,
                "stt-unavailable",
            ));
        }
        ResolvedModel::Found { model, wanted } => (model, wanted),
    };
    if let Some(wanted) = wanted
        && download_quietly(app, &wanted)
    {
        log::info!(
            "[stt] {wanted} isn't downloaded yet: downloading it, and using {} meanwhile",
            model.name
        );
    }
    let english = model.name.ends_with(".en");
    let tmp = os_tmpdir(app.env()).join(format!("tarsee-stt-{}{}", random_hex(6), audio_ext(audio)));
    tokio::fs::write(&tmp, audio)
        .await
        .map_err(|err| SttError::plain(err.to_string()))?;
    let mut req = Map::new();
    req.insert("audio".into(), json!(tmp.to_string_lossy()));
    req.insert("model".into(), json!(model.dir.to_string_lossy()));
    req.insert("language".into(), if english { json!("en") } else { Value::Null });
    req.insert("threads".into(), json!(threads()));
    let res = SttWorker::of(app)
        .transcribe(app, rt, req, timeout_for(app, &model.name, audio.len()))
        .await;
    // Already gone is fine.
    let _ = tokio::fs::remove_file(&tmp).await;
    let res = res.map_err(SttError::plain)?;
    let text = js_trim(&js_string_or_empty(res.get("text"))).to_string();
    let more = if utf16_len(&text) > 80 { "..." } else { "" };
    let duration = match res.get("duration") {
        None | Some(Value::Null) => "?".to_string(),
        other => js_template(other),
    };
    log::info!(
        "[stt] faster-whisper ({}): \"{}{more}\" [{duration}s audio]",
        model.name,
        utf16_truncate(&text, 80)
    );
    let language = match res.get("language") {
        Some(l) if truthy(l) => js_template(Some(l)),
        _ if english => "en".into(),
        _ => "auto".into(),
    };
    Ok(SttResult {
        transcript: text,
        language,
        provider: format!("faster-whisper ({})", model.name),
    })
}

/// A tenth of a second of silence as a 16 kHz mono WAV: it loads the model and transcribes nothing.
fn silence_wav() -> Vec<u8> {
    let mut b = Vec::with_capacity(44 + 3200);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36u32 + 3200).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&16_000u32.to_le_bytes());
    b.extend_from_slice(&32_000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&3200u32.to_le_bytes());
    b.resize(44 + 3200, 0);
    b
}

/// Start faster-whisper and load the chosen model now (a call opening), so the first recording isn't slowed by it.
/// `{ ok, model }` or `{ ok: false, error }`. Never fails.
pub async fn warm_stt(app: &App, settings: Option<&dyn Settings>) -> Value {
    if stt_provider(settings) != Value::String("local".into()) {
        return json!({ "ok": true, "model": null, "skipped": "the OpenAI Whisper API is chosen" });
    }
    let rt = find_stt_runtime(app, false).await;
    let Some(rt) = rt.ready() else {
        return json!({ "ok": false, "error": format!("{NOT_INSTALLED}. {INSTALL_OR_PAID}") });
    };
    let model = match resolve_stt_model(app, &chosen_model(app, settings)) {
        ResolvedModel::Found { model, .. } => model,
        ResolvedModel::Missing(_) => {
            return json!({ "ok": false, "error": "No speech model is downloaded yet. Download one in Settings > Voice > Speech-to-text." });
        }
    };
    let tmp = os_tmpdir(app.env()).join(format!("tarsee-stt-warm-{}.wav", random_hex(6)));
    if let Err(err) = tokio::fs::write(&tmp, silence_wav()).await {
        return json!({ "ok": false, "error": err.to_string() });
    }
    let mut req = Map::new();
    req.insert("audio".into(), json!(tmp.to_string_lossy()));
    req.insert("model".into(), json!(model.dir.to_string_lossy()));
    req.insert(
        "language".into(),
        if model.name.ends_with(".en") {
            json!("en")
        } else {
            Value::Null
        },
    );
    req.insert("threads".into(), json!(threads()));
    let res = SttWorker::of(app)
        .transcribe(app, rt, req, timeout_for(app, &model.name, 0))
        .await;
    // Gone already is fine.
    let _ = tokio::fs::remove_file(&tmp).await;
    match res {
        Ok(_) => json!({ "ok": true, "model": model.name }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

async fn local_available(app: &App) -> bool {
    match overrides(app).and_then(|o| o.local.as_ref().and_then(|l| l.available.clone())) {
        Some(available) => available().await,
        None => find_stt_runtime(app, false).await.is_ready(),
    }
}

async fn local_transcribe(app: &App, audio: &[u8], settings: Option<&dyn Settings>) -> Result<SttResult, SttError> {
    match overrides(app).and_then(|o| o.local.as_ref().and_then(|l| l.transcribe.clone())) {
        Some(transcribe) => transcribe(Bytes::copy_from_slice(audio)).await,
        None => transcribe_local(app, audio, settings).await,
    }
}

// ── The OpenAI Whisper API ───────────────────────────────────────────────

/// Why the Whisper API call failed; `api_status` when it answered with an error.
struct WhisperApiError {
    message: String,
    api_status: Option<u16>,
}

/// Transcribe audio using OpenAI Whisper API.
async fn transcribe_whisper_api(
    app: &App,
    audio: &[u8],
    language: Option<&str>,
    api_key: &str,
) -> Result<SttResult, WhisperApiError> {
    let boundary = format!("----TarseeSTTBoundary{}", now_ms());
    let mut body: Vec<u8> = Vec::with_capacity(audio.len() + 512);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.webm\"\r\nContent-Type: audio/webm\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n").as_bytes(),
    );
    let short = language.map(|l| l.split('-').next().unwrap_or("").to_string());
    if let Some(lang) = language.filter(|l| !l.is_empty()) {
        let first = lang.split('-').next().unwrap_or("");
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{first}\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n").as_bytes(),
    );
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let request = FetchRequest::post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .timeout(Duration::from_secs(15));
    let failed = |message: String| WhisperApiError {
        message,
        api_status: None,
    };
    let res = app
        .fetch()
        .fetch(request)
        .await
        .map_err(|err| failed(err.to_string()))?;
    if !res.ok() {
        let status = res.status;
        let text = res.text().await.unwrap_or_default();
        return Err(WhisperApiError {
            message: format!("Whisper API error ({status}): {text}"),
            api_status: Some(status),
        });
    }
    let data = res.json().await.map_err(|err| failed(err.to_string()))?;
    let text = data.get("text");
    let shown = match text {
        Some(Value::String(s)) => utf16_truncate(s, 80),
        other => js_template(other),
    };
    log::info!("[stt] Whisper API: \"{shown}...\"");
    Ok(SttResult {
        transcript: js_string_or_empty(text),
        language: short.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into()),
        provider: "whisper-api".into(),
    })
}

// ── Choosing ─────────────────────────────────────────────────────────────

const NOT_INSTALLED: &str = "local transcription (faster-whisper) is not installed on this server";
/// Where the owner sets local transcription up, or turns the paid API on.
const INSTALL_OR_PAID: &str =
    "Install it in Settings > Voice > Speech-to-text (one click), or choose the paid \"OpenAI Whisper API\" there.";
/// Where the owner turns the paid API on.
const CHOOSE_PAID: &str = "The paid OpenAI Whisper API is off; to use it instead, choose \"OpenAI Whisper API\" in Settings > Voice > Speech-to-text.";

/// Transcribe audio with the provider the owner chose (setting voice.stt_provider):
///   "local" (default) → faster-whisper on this server (free, no API key). Nothing paid is ever called.
///   "whisper-api"     → OpenAI Whisper API (paid, $0.006/min) with the saved OpenAI key. When that call fails or
///                       there is no key, free local transcription is tried.
///
/// The paid API runs only when chosen: an OpenAI key saved for anything else (a Railway OPENAI_API_KEY, the chat AI's
/// key) never turns it on. When nothing can transcribe, the error says why and what to change.
pub async fn transcribe_audio(
    app: &App,
    audio: &[u8],
    language: Option<&str>,
    settings: Option<&dyn Settings>,
) -> Result<SttResult, SttError> {
    let provider = stt_provider(settings);

    // OpenAI Whisper API: only when the owner chose it. What went wrong with it, and what to do, if local can't help
    // either.
    let mut paid_problem: Option<String> = None;
    let mut fix = CHOOSE_PAID.to_string();
    let mut install_fix = INSTALL_OR_PAID.to_string();
    if provider == Value::String("whisper-api".into()) {
        match api_key(settings, app.env(), "openai") {
            None => {
                paid_problem =
                    Some("Speech-to-text is set to the OpenAI Whisper API, but no OpenAI API key is saved".into());
                fix = "Add the key in Settings > Voice > Speech-to-text.".into();
                install_fix = fix.clone();
            }
            Some(key) => match transcribe_whisper_api(app, audio, language, &key).await {
                Ok(result) => return Ok(result),
                Err(err) => {
                    log::warn!("[stt] Whisper API failed, trying local: {}", err.message);
                    let status = err.api_status.map(|s| format!(" (HTTP {s})")).unwrap_or_default();
                    paid_problem = Some(format!("The OpenAI Whisper API failed{status}"));
                    fix = "The server log has the details.".into();
                    install_fix = fix.clone();
                }
            },
        }
    }

    // Local faster-whisper (free, no API key)
    if !local_available(app).await {
        return Err(stt_error(
            match &paid_problem {
                Some(paid) => format!("{paid}, and {NOT_INSTALLED}. {fix}"),
                None => format!("Speech-to-text is unavailable: {NOT_INSTALLED}. {install_fix}"),
            },
            501,
            "stt-unavailable",
        ));
    }
    match local_transcribe(app, audio, settings).await {
        Ok(result) => Ok(result),
        Err(err) => {
            // Already in words the owner can act on (no model yet: one is downloading).
            if err.code.as_deref() == Some("stt-unavailable")
                && let Some(status) = err.status
            {
                return Err(match &paid_problem {
                    Some(paid) => stt_error(format!("{paid}. {}", err.message), status, "stt-unavailable"),
                    None => err,
                });
            }
            log::warn!("[stt] faster-whisper failed: {}", err.message);
            let local = "local transcription (faster-whisper) could not transcribe this audio";
            Err(stt_error(
                match &paid_problem {
                    Some(paid) => format!("{paid}, and {local}. {fix}"),
                    None => format!("Speech-to-text failed: {local} (the server log has the details). {fix}"),
                },
                500,
                "stt-failed",
            ))
        }
    }
}

/// The models for Settings (`stt_install::list_stt_models`): size, whether downloaded, and where.
pub fn get_stt_models(app: &App, settings: Option<&dyn Settings>) -> Vec<SttModelRow> {
    list_stt_models(app, &chosen_model(app, settings))
}

#[cfg(test)]
mod tests;
