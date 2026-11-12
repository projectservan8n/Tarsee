//! Port of `src/voice/stt-install.js`. Local speech-to-text, set up from Settings > Voice > Speech-to-text:
//! faster-whisper, the Python it runs on, and its models. What the page shows ([`get_stt_status`]) and does
//! ([`start_stt_install`], [`start_model_download`], [`remove_stt_model`]).
//!
//! Which Python runs faster-whisper ([`find_stt_runtime`]), first that can import it:
//!   1. TARSEE_STT_PYTHON, when set (a Python you manage yourself);
//!   2. Tarsee's own: <state>/python/stt-venv, made by "Install faster-whisper";
//!   3. a Python on this computer (the Docker image installs faster-whisper for its python3).
//!
//! "Install faster-whisper" ([`start_stt_install`]), for installs without Docker:
//!   1. a Python 3.9+ with venv found here, else Tarsee's own CPython downloaded (`python_runtime`);
//!   2. a private folder for faster-whisper made from it (a venv, <state>/python/stt-venv);
//!   3. pip installs faster-whisper [`FASTER_WHISPER_VERSION`] there: from pypi.org only (--isolated --index-url), and
//!      ready-made builds only (--only-binary=:all:, so nothing from a download runs while installing);
//!   4. a check that it imports; 5. the default model, when no model is on disk yet.
//!
//! Models (`whisper_models`) download into <data>/whisper-models, on the volume on Railway. One job (an install or a
//! model download) runs at a time, in this process and across processes (a lock file).
//!
//! The Node module's state (the runtime found, the job running, the last results, the tests' catalog) is the app
//! service [`SttInstall`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{OnceCell, watch};

use super::install_common::{acquire_lock, write_file_atomic};
use super::phonon_engine::js_round;
use super::python_runtime::{
    EnsureOptions, LogListener, PythonProbe, PythonProgress, PythonRef, PythonRunError, RunOptions, STANDALONE_PYTHON,
    StandalonePython, TargetQuery, ensure_base_python, find_pythons, node_arch, node_platform, probe_python,
    python_home, python_target, run_python, venv_interpreter,
};
use super::whisper_models::{
    DEFAULT_WHISPER_MODEL, DeletedModel, DownloadModelOptions, FoundModel, ModelDirs, ModelProgress, ModelSource,
    WHISPER_MODELS, WhisperModel, delete_whisper_model, download_whisper_model, find_in_catalog, find_whisper_model,
};
use crate::app::App;
use crate::db::settings::Settings;
use crate::net::fetch::Fetch;
use crate::util::js::{now_iso, now_ms, number_to_string, utf16_truncate};

/// The faster-whisper Tarsee installs (and the Docker image pins: the deploy tests check they agree).
pub const FASTER_WHISPER_VERSION: &str = "1.2.1";
/// What pip downloads for it, roughly: PyAV 28 MB, ctranslate2 20 MB, onnxruntime 15 MB, numpy 13 MB, sympy 6 MB,
/// tokenizers 3 MB and about 20 small ones (Windows x64, Python 3.12, November 2026).
const APPROX_PACKAGES_MB: u64 = 100;
const PIP_PACKAGES_EXPECTED: f64 = 28.0;
const PIP_TIMEOUT: Duration = Duration::from_secs(20 * 60);

// ── The service ──────────────────────────────────────────────────────────

/// What the Node module kept in its variables, per app.
pub struct SttInstall {
    /// The models (tests swap in small stand-ins).
    catalog: RwLock<Arc<Vec<WhisperModel>>>,
    /// The Python found, shared by everyone asking until it is reset.
    runtime: Mutex<Arc<OnceCell<SttRuntime>>>,
    job: Mutex<Option<Job>>,
    last: Mutex<Last>,
    next_job: AtomicU64,
}

impl SttInstall {
    fn of(app: &App) -> Arc<SttInstall> {
        app.get_or_init(|| SttInstall {
            catalog: RwLock::new(Arc::new(WHISPER_MODELS.clone())),
            runtime: Mutex::new(Arc::new(OnceCell::new())),
            job: Mutex::new(None),
            last: Mutex::new(Last::default()),
            next_job: AtomicU64::new(1),
        })
    }
}

/// Tests only: small stand-ins for the models (`{ catalog }`); `None` restores the real ones.
pub fn set_for_tests(app: &App, catalog: Option<Vec<WhisperModel>>) {
    *SttInstall::of(app).catalog.write() = Arc::new(catalog.unwrap_or_else(|| WHISPER_MODELS.clone()));
}

/// The models in use: the real catalog, or the tests' stand-ins.
pub fn catalog(app: &App) -> Arc<Vec<WhisperModel>> {
    SttInstall::of(app).catalog.read().clone()
}

// ── Folders ──────────────────────────────────────────────────────────────

/// Where everything is.
#[derive(Debug, Clone, PartialEq)]
pub struct SttDirs {
    /// Tarsee's Python folder.
    pub home: PathBuf,
    /// Tarsee's own faster-whisper (a venv).
    pub venv: PathBuf,
    /// Downloaded models.
    pub models: PathBuf,
    /// TARSEE_WHISPER_BUNDLED_DIR: the Docker image's models, read-only.
    pub bundled: Vec<PathBuf>,
    /// Where the old version let faster-whisper download.
    pub caches: Vec<PathBuf>,
}

impl SttDirs {
    /// The folders `whisper_models` looks in.
    pub fn model_dirs(&self) -> ModelDirs {
        ModelDirs {
            models: self.models.clone(),
            bundled: self.bundled.clone(),
            caches: self.caches.clone(),
        }
    }
}

const PATH_DELIMITER: char = if cfg!(windows) { ';' } else { ':' };

/// Where everything is. bundled: TARSEE_WHISPER_BUNDLED_DIR (the Docker image's models, read-only).
pub fn stt_dirs(app: &App) -> SttDirs {
    let env = app.env();
    let models = app.config().data_dir.join("whisper-models");
    let bundled = env
        .get("TARSEE_WHISPER_BUNDLED_DIR")
        .unwrap_or_default()
        .split(PATH_DELIMITER)
        .map(|s| super::speech_text::js_trim(s).to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();
    // The old version let faster-whisper download into <dir>/hf_cache, with <dir> worked out its own way.
    let set = |name: &str| env.get(name).filter(|v| !v.is_empty());
    let old = PathBuf::from(
        set("TARSEE_DATA_DIR")
            .or_else(|| set("TARSEE_STATE_DIR"))
            .unwrap_or_else(|| "/data/tarsee".into()),
    )
    .join("whisper-models");
    let mut caches = vec![models.join("hf_cache")];
    let old_cache = old.join("hf_cache");
    if !caches.contains(&old_cache) {
        caches.push(old_cache);
    }
    let home = python_home(app.config());
    SttDirs {
        venv: home.join("stt-venv"),
        home,
        models,
        bundled,
        caches,
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ── Which Python runs faster-whisper ─────────────────────────────────────

/// A Python that can import faster-whisper: `{ ready: true, python: { cmd, args }, label, version, executable,
/// fasterWhisper, source }`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadyRuntime {
    /// Only `cmd` and `args` are set.
    pub python: PythonRef,
    pub label: String,
    pub version: Option<String>,
    pub executable: Option<String>,
    pub faster_whisper: String,
    /// "custom" | "tarsee" | "system".
    pub source: &'static str,
}

/// What [`find_stt_runtime`] found.
#[derive(Debug, Clone, PartialEq)]
pub enum SttRuntime {
    Ready(ReadyRuntime),
    /// `{ ready: false, base, custom, problem }`: base is a Python an install would use, or `None`.
    NotReady {
        base: Option<PythonProbe>,
        custom: bool,
        problem: Option<String>,
    },
}

impl SttRuntime {
    pub fn ready(&self) -> Option<&ReadyRuntime> {
        match self {
            SttRuntime::Ready(rt) => Some(rt),
            SttRuntime::NotReady { .. } => None,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready().is_some()
    }
}

/// Forget what was found (after an install, or when Settings asks to look again).
pub fn reset_stt_runtime(app: &App) {
    *SttInstall::of(app).runtime.lock() = Arc::new(OnceCell::new());
}

/// The Python that runs faster-whisper, or why there is none. Cached until [`reset_stt_runtime`] or `refresh`.
pub async fn find_stt_runtime(app: &App, refresh: bool) -> SttRuntime {
    let cell = {
        let svc = SttInstall::of(app);
        let mut slot = svc.runtime.lock();
        if refresh {
            *slot = Arc::new(OnceCell::new());
        }
        slot.clone()
    };
    cell.get_or_init(|| detect_runtime(app)).await.clone()
}

fn ready_from(probe: &PythonProbe, source: &'static str) -> ReadyRuntime {
    ReadyRuntime {
        python: PythonRef::new(&probe.python.cmd).args(probe.python.args.clone()),
        label: probe.label().to_string(),
        version: probe.version.clone(),
        executable: probe.executable.clone(),
        faster_whisper: probe.faster_whisper.clone().unwrap_or_default(),
        source,
    }
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

async fn detect_runtime(app: &App) -> SttRuntime {
    if let Some(custom) = app.env().trimmed("TARSEE_STT_PYTHON") {
        let p = probe_python(app, &PythonRef::new(&custom).label(&custom), PROBE_TIMEOUT).await;
        if p.faster_whisper.is_some() {
            return SttRuntime::Ready(ready_from(&p, "custom"));
        }
        let why = if p.found {
            "can't load faster-whisper"
        } else {
            "was not found"
        };
        return SttRuntime::NotReady {
            base: None,
            custom: true,
            problem: Some(format!("TARSEE_STT_PYTHON ({custom}) {why}")),
        };
    }
    let venv_py = venv_interpreter(&stt_dirs(app).venv);
    let mut broken = None;
    if venv_py.exists() {
        let own = PythonRef::new(venv_py.to_string_lossy()).label("Tarsee's faster-whisper");
        let p = probe_python(app, &own, PROBE_TIMEOUT).await;
        if p.faster_whisper.is_some() {
            return SttRuntime::Ready(ready_from(&p, "tarsee"));
        }
        broken = Some("Tarsee's faster-whisper folder is there but doesn't work".to_string());
    }
    let all = find_pythons(app, &STANDALONE_PYTHON).await;
    if let Some(with_it) = all.iter().find(|p| p.faster_whisper.is_some()) {
        return SttRuntime::Ready(ready_from(with_it, "system"));
    }
    SttRuntime::NotReady {
        base: all.into_iter().find(|p| p.usable),
        custom: false,
        problem: broken,
    }
}

// ── Models ───────────────────────────────────────────────────────────────

fn valid_model(app: &App, name: &str) -> bool {
    find_in_catalog(name, &catalog(app)).is_some()
}

/// The model the owner chose (voice.stt_model), or the default.
pub fn chosen_model(app: &App, settings: Option<&dyn Settings>) -> String {
    match settings.and_then(|s| s.get("voice.stt_model")) {
        Some(Value::String(pref)) if valid_model(app, &pref) => pref,
        _ => DEFAULT_WHISPER_MODEL.to_string(),
    }
}

/// Where a model is on disk (`{ name, dir, source }`), or `None`.
pub fn find_stt_model(app: &App, name: &str) -> Option<FoundModel> {
    if !valid_model(app, name) {
        return None;
    }
    find_whisper_model(name, &stt_dirs(app).model_dirs(), &catalog(app))
}

/// What [`resolve_stt_model`] picked.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedModel {
    /// `{ name, dir, source, wanted }`: wanted is the chosen one, when it isn't the one used.
    Found { model: FoundModel, wanted: Option<String> },
    /// `{ missing: <chosen> }`: no model is on disk at all.
    Missing(String),
}

impl ResolvedModel {
    pub fn missing(&self) -> Option<&str> {
        match self {
            ResolvedModel::Missing(name) => Some(name),
            ResolvedModel::Found { .. } => None,
        }
    }

    pub fn found(&self) -> Option<&FoundModel> {
        match self {
            ResolvedModel::Found { model, .. } => Some(model),
            ResolvedModel::Missing(_) => None,
        }
    }

    pub fn wanted(&self) -> Option<&str> {
        match self {
            ResolvedModel::Found { wanted, .. } => wanted.as_deref(),
            ResolvedModel::Missing(_) => None,
        }
    }
}

/// The model to transcribe with: the chosen one when it is on disk, else the closest one that is (the same kind,
/// English-only or many languages, first), or [`ResolvedModel::Missing`] when no model is on disk at all.
pub fn resolve_stt_model(app: &App, want: &str) -> ResolvedModel {
    let dirs = stt_dirs(app).model_dirs();
    let catalog = catalog(app);
    let name = if valid_model(app, want) {
        want
    } else {
        DEFAULT_WHISPER_MODEL
    };
    if let Some(hit) = find_whisper_model(name, &dirs, &catalog) {
        return ResolvedModel::Found {
            model: hit,
            wanted: None,
        };
    }
    let english = find_in_catalog(name, &catalog).is_none_or(|m| m.english);
    let mut order: Vec<&WhisperModel> = catalog.iter().collect();
    order.sort_by_key(|m| (m.english != english, m.name != DEFAULT_WHISPER_MODEL));
    for other in order {
        if let Some(hit) = find_whisper_model(&other.name, &dirs, &catalog) {
            return ResolvedModel::Found {
                model: hit,
                wanted: Some(name.to_string()),
            };
        }
    }
    ResolvedModel::Missing(name.to_string())
}

/// A size as Settings shows it: "1.5 GB", "148 MB", "20 KB".
fn size_text(bytes: u64) -> String {
    let b = bytes as f64;
    if b >= 1e9 {
        return format!("{:.1} GB", b / 1e9);
    }
    if b >= 1e6 {
        return format!("{} MB", number_to_string(js_round(b / 1e6)));
    }
    format!("{} KB", number_to_string(js_round(b / 1e3).max(1.0)))
}

/// One row of Settings' model list.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SttModelRow {
    pub name: String,
    pub description: String,
    pub english: bool,
    pub multilingual: bool,
    pub bytes: u64,
    pub size: String,
    #[serde(rename = "sizeMB")]
    pub size_mb: u64,
    /// "downloaded" | "image" | "cache" | "missing" | "downloading" | "failed".
    pub state: String,
    pub downloaded: bool,
    #[serde(rename = "where")]
    pub where_: Option<String>,
    pub deletable: bool,
    pub current: bool,
    pub percent: Option<i64>,
    pub error: Option<String>,
}

fn source_text(source: ModelSource) -> &'static str {
    match source {
        ModelSource::Downloaded => "downloaded",
        ModelSource::Image => "image",
        ModelSource::Cache => "cache",
    }
}

/// One row per model, for Settings: its size, whether and where it is, and what can be done with it.
pub fn list_stt_models(app: &App, current: &str) -> Vec<SttModelRow> {
    let svc = SttInstall::of(app);
    let dirs = stt_dirs(app).model_dirs();
    let catalog = catalog(app);
    let job = svc.job.lock().as_ref().map(Job::snapshot);
    let last = svc.last.lock();
    catalog
        .iter()
        .map(|m| {
            let bytes: u64 = m.files.iter().map(|f| f.size).sum();
            let hit = find_whisper_model(&m.name, &dirs, &catalog);
            let job = job
                .as_ref()
                .filter(|j| j.kind == "model" && j.model.as_deref() == Some(m.name.as_str()));
            let last_error = last.models.get(&m.name).and_then(|l| l.error.clone());
            let mut state = hit
                .as_ref()
                .map(|h| source_text(h.source).to_string())
                .unwrap_or_else(|| "missing".into());
            if job.is_some() {
                state = "downloading".into();
            } else if hit.is_none() && last_error.is_some() {
                state = "failed".into();
            }
            SttModelRow {
                name: m.name.clone(),
                description: m.description.clone(),
                english: m.english,
                multilingual: !m.english,
                bytes,
                size: size_text(bytes),
                size_mb: js_round(bytes as f64 / 1e6) as u64,
                state,
                downloaded: hit.is_some(),
                where_: hit.as_ref().map(|h| path_text(&h.dir)),
                deletable: hit.as_ref().is_some_and(|h| h.source != ModelSource::Image),
                current: m.name == current,
                percent: job.map(|j| j.percent),
                error: if hit.is_none() && job.is_none() {
                    last_error
                } else {
                    None
                },
            }
        })
        .collect()
}

// ── Jobs ─────────────────────────────────────────────────────────────────

/// How a job ended: `{ ok, error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobOutcome {
    pub ok: bool,
    pub error: Option<String>,
}

/// The end of a job, to wait for (the JS `done` promise, which never rejects).
#[derive(Clone)]
pub struct JobDone(watch::Receiver<Option<JobOutcome>>);

impl JobDone {
    pub async fn wait(mut self) -> JobOutcome {
        match self.0.wait_for(Option::is_some).await {
            Ok(outcome) => outcome.clone().unwrap_or(JobOutcome { ok: false, error: None }),
            Err(_) => JobOutcome {
                ok: false,
                error: Some("the job stopped".into()),
            },
        }
    }
}

/// The job running now: `{ kind: "install" | "model", model, phase, step, percent, startedAt }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub kind: String,
    pub model: Option<String>,
    pub phase: String,
    pub step: Option<String>,
    pub percent: i64,
    pub started_at: String,
}

/// A job that was started (or was already running): its snapshot, and its end.
pub struct StartedJob {
    pub job: JobSnapshot,
    pub done: JobDone,
}

struct Job {
    id: u64,
    kind: &'static str,
    model: Option<String>,
    phase: String,
    step: Option<String>,
    percent: i64,
    started_at: String,
    done: JobDone,
}

impl Job {
    fn snapshot(&self) -> JobSnapshot {
        JobSnapshot {
            kind: self.kind.to_string(),
            model: self.model.clone(),
            phase: self.phase.clone(),
            step: self.step.clone(),
            percent: self.percent,
            started_at: self.started_at.clone(),
        }
    }

    fn describe(&self) -> String {
        describe_job(self.kind, self.model.as_deref())
    }
}

fn describe_job(kind: &str, model: Option<&str>) -> String {
    if kind == "install" {
        "installing faster-whisper".into()
    } else {
        format!("downloading the {} model", model.unwrap_or("undefined"))
    }
}

#[derive(Debug, Clone, Default)]
struct LastResult {
    error: Option<String>,
    finished_at_ms: i64,
}

#[derive(Default)]
struct Last {
    install: Option<LastResult>,
    models: HashMap<String, LastResult>,
}

impl Last {
    fn record(&mut self, kind: &str, model: Option<&str>, error: Option<String>) {
        let result = LastResult {
            error,
            finished_at_ms: now_ms(),
        };
        if kind == "install" {
            self.install = Some(result);
        } else {
            self.models.insert(model.unwrap_or_default().to_string(), result);
        }
    }
}

/// Tests only: forget earlier jobs' results.
pub fn reset_jobs_for_tests(app: &App) {
    *SttInstall::of(app).last.lock() = Last::default();
}

/// The job running now, or `None`.
pub fn stt_job(app: &App) -> Option<JobSnapshot> {
    SttInstall::of(app).job.lock().as_ref().map(Job::snapshot)
}

/// Why a job could not start, or a model could not be deleted: the message, its `code` ("BUSY", "UNKNOWN_MODEL") and
/// the HTTP `status` the routes answer with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SttJobError {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<u16>,
}

impl SttJobError {
    fn busy(message: impl Into<String>) -> Self {
        SttJobError {
            message: message.into(),
            code: Some("BUSY".into()),
            status: Some(409),
        }
    }
}

/// Changes the job's phase, step and progress while it runs. Progress only ever goes up, and stays below 100.
#[derive(Clone)]
struct Updater {
    svc: Arc<SttInstall>,
    id: u64,
}

impl Updater {
    /// `update({ phase, step, percent })`: a `None` leaves that part as it is.
    fn update(&self, phase: Option<&str>, step: Option<Option<String>>, percent: Option<f64>) {
        let mut slot = self.svc.job.lock();
        let Some(job) = slot.as_mut().filter(|j| j.id == self.id) else {
            return;
        };
        if let Some(phase) = phase {
            job.phase = phase.to_string();
        }
        if let Some(step) = step {
            job.step = step;
        }
        if let Some(percent) = percent {
            let floored = percent.floor().min(99.0);
            if floored.is_finite() {
                job.percent = job.percent.max(floored as i64);
            }
        }
    }

    fn step(&self, step: impl Into<String>, percent: f64) {
        self.update(None, Some(Some(step.into())), Some(percent));
    }
}

/// Start a job, or hand back the same one already running. Another job running: an error (code BUSY, status 409).
/// `prelude` is what the Node job did before its first pause (the first progress it showed, in the answer to the
/// click); `run` is the job itself.
fn begin<F, Fut>(
    app: &App,
    kind: &'static str,
    model: Option<String>,
    prelude: impl FnOnce(&Updater),
    run: F,
) -> Result<StartedJob, SttJobError>
where
    F: FnOnce(App, Updater) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
{
    let svc = SttInstall::of(app);
    let mut slot = svc.job.lock();
    if let Some(job) = slot.as_ref() {
        if job.kind == kind && job.model == model {
            return Ok(StartedJob {
                job: job.snapshot(),
                done: job.done.clone(),
            });
        }
        return Err(SttJobError::busy(format!(
            "Tarsee is already {}. Wait for it to finish, then try again.",
            job.describe()
        )));
    }
    let lock = acquire_lock(app, &python_home(app.config()), Some("speech-to-text download")).map_err(|err| {
        if err.has_code("LOCKED") {
            SttJobError::busy(
                "Another speech-to-text download is running (perhaps from a terminal). Wait for it to finish, then try again.",
            )
        } else {
            SttJobError {
                message: err.message,
                code: err.code,
                status: None,
            }
        }
    })?;
    let id = svc.next_job.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = watch::channel(None);
    *slot = Some(Job {
        id,
        kind,
        model: model.clone(),
        phase: "start".into(),
        step: None,
        percent: 0,
        started_at: now_iso(),
        done: JobDone(rx),
    });
    drop(slot);

    let up = Updater { svc: svc.clone(), id };
    prelude(&up);
    let started = {
        let slot = svc.job.lock();
        let job = slot.as_ref().filter(|j| j.id == id);
        StartedJob {
            job: job.map(Job::snapshot).unwrap_or_else(|| JobSnapshot {
                kind: kind.into(),
                model: model.clone(),
                phase: "start".into(),
                step: None,
                percent: 0,
                started_at: now_iso(),
            }),
            done: job.map(|j| j.done.clone()).unwrap_or_else(|| JobDone(tx.subscribe())),
        }
    };

    let app = app.clone();
    tokio::spawn(async move {
        let result = run(app, up).await;
        let outcome = match result {
            Ok(()) => {
                svc.last.lock().record(kind, model.as_deref(), None);
                JobOutcome { ok: true, error: None }
            }
            Err(error) => {
                log::warn!("[stt] {} failed: {error}", describe_job(kind, model.as_deref()));
                svc.last.lock().record(kind, model.as_deref(), Some(error.clone()));
                JobOutcome {
                    ok: false,
                    error: Some(error),
                }
            }
        };
        {
            let mut slot = svc.job.lock();
            if slot.as_ref().is_some_and(|j| j.id == id) {
                *slot = None;
            }
        }
        lock.release();
        let _ = tx.send(Some(outcome));
    });
    Ok(started)
}

/// What a job may be given (tests): the HTTP client, the standalone Python's pin, the pause before a retry, where its
/// lines go.
#[derive(Clone, Default)]
pub struct SttJobOptions {
    pub fetch: Option<Arc<dyn Fetch>>,
    pub pin: Option<StandalonePython>,
    pub retry_delay_ms: Option<u64>,
    pub log: Option<LogListener>,
}

// ── Install faster-whisper ───────────────────────────────────────────────

static PIP_NO_SPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)No space left on device|Errno 28").expect("the disk-full pattern"));
static PIP_OFFLINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)NewConnectionError|getaddrinfo|Name or service not known|Temporary failure in name resolution|Network is unreachable|ConnectTimeout|ReadTimeoutError|ProxyError|SSLError")
        .expect("the offline pattern")
});
static PIP_NOT_FOUND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"No matching distribution found for ([^\s]+)").expect("the no-build pattern"));
static PIP_SPEC_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[<>=!~;\[].*$").expect("the spec pattern"));
static PIP_ERROR_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ERROR:\s*").expect("the error-line pattern"));
static PIP_DOWNLOADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*Downloading\s+(\S+?)-[0-9][^\s]*\s*(?:\(([^)]+)\))?").expect("the downloading pattern")
});
static PIP_COLLECTING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*Collecting\s").expect("the collecting pattern"));

/// pip's own words, when it fails, as the owner would say them.
fn pip_problem(err: &PythonRunError, py_version: &str) -> String {
    let text = format!("{}\n{}\n{}", err.stderr, err.stdout, err.message);
    if err.timed_out {
        return "it took more than 20 minutes (a slow connection?)".into();
    }
    if PIP_NO_SPACE.is_match(&text) {
        return "the disk is full".into();
    }
    if PIP_OFFLINE.is_match(&text) {
        return "could not reach pypi.org (check the internet connection)".into();
    }
    if let Some(nf) = PIP_NOT_FOUND.captures(&text) {
        let pkg = PIP_SPEC_TAIL.replace(&nf[1], "");
        return format!(
            "pypi.org has no ready-made build of {pkg} for this computer (Python {py_version} on {} {})",
            node_platform(),
            node_arch()
        );
    }
    let line = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .rev()
        .find(|l| super::speech_text::js_trim(l).starts_with("ERROR:"));
    match line {
        Some(line) => PIP_ERROR_LINE
            .replace(super::speech_text::js_trim(line), "")
            .into_owned(),
        None if !err.message.is_empty() => err.message.clone(),
        None => "pip stopped".into(),
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

async fn pip_works(app: &App, python: &PythonRef) -> bool {
    run_python(
        app,
        python,
        &args(&["-I", "-m", "pip", "--version"]),
        RunOptions::default().timeout(Duration::from_secs(60)),
    )
    .await
    .is_ok()
}

/// Start "Install faster-whisper" in the background. Returns the job (see [`StartedJob`]).
pub fn start_stt_install(app: &App, opts: SttJobOptions) -> Result<StartedJob, SttJobError> {
    begin(
        app,
        "install",
        None,
        |up| {
            up.update(
                Some("python"),
                Some(Some("Looking for Python on this computer".into())),
                Some(1.0),
            )
        },
        move |app, up| async move { install_faster_whisper(&app, &up, &opts).await },
    )
}

fn default_log(prefix: &'static str) -> LogListener {
    Arc::new(move |m: &str| log::info!("{prefix} {m}"))
}

async fn install_faster_whisper(app: &App, up: &Updater, opts: &SttJobOptions) -> Result<(), String> {
    let log = opts.log.clone().unwrap_or_else(|| default_log("[stt:install]"));
    let dirs = stt_dirs(app);
    std::fs::create_dir_all(&dirs.home).map_err(|err| err.to_string())?;

    // 1. A Python to build on.
    up.update(
        Some("python"),
        Some(Some("Looking for Python on this computer".into())),
        Some(1.0),
    );
    let version = opts.pin.as_ref().unwrap_or(&STANDALONE_PYTHON).version.clone();
    let progress = up.clone();
    let on_progress = Arc::new(move |p: PythonProgress| {
        let mb = |n: u64| number_to_string(js_round(n as f64 / 1e6));
        if p.phase == "python-unpack" {
            progress.update(
                Some("python"),
                Some(Some(format!("Unpacking Python {version}"))),
                Some(24.0),
            );
        } else {
            let short = version.split('.').take(2).collect::<Vec<_>>().join(".");
            progress.update(
                Some("python"),
                Some(Some(format!(
                    "Downloading Python {short} ({} of {} MB)",
                    mb(p.bytes_done),
                    mb(p.bytes_total)
                ))),
                Some(2.0 + 20.0 * (p.bytes_done as f64 / p.bytes_total as f64)),
            );
        }
    });
    let ensure = EnsureOptions {
        allow_download: true,
        fetch: opts.fetch.clone(),
        pin: opts.pin.clone(),
        on_progress: Some(on_progress),
        log: Some(log.clone()),
        retry_delay_ms: opts.retry_delay_ms.unwrap_or(1000),
    };
    let base = ensure_base_python(app, &ensure).await.map_err(|err| {
        format!(
            "Installing faster-whisper failed: {}.",
            err.message.strip_suffix('.').unwrap_or(&err.message)
        )
    })?;
    let base_version = base.version.clone().unwrap_or_default();
    let exe = base.executable.as_ref().map(|e| format!(", {e}")).unwrap_or_default();
    log(&format!("using {} (Python {base_version}{exe})", base.label()));

    // 2. A private folder for faster-whisper (a venv), made again if an earlier try left it without pip.
    up.update(
        Some("venv"),
        Some(Some("Making a private folder for faster-whisper".into())),
        Some(25.0),
    );
    let venv_py = PythonRef::new(venv_interpreter(&dirs.venv).to_string_lossy()).label("Tarsee's faster-whisper");
    if !Path::new(&venv_py.cmd).exists() || !pip_works(app, &venv_py).await {
        let _ = std::fs::remove_dir_all(&dirs.venv);
        let made = async {
            run_python(
                app,
                &base.python,
                &args(&["-I", "-m", "venv", &path_text(&dirs.venv)]),
                RunOptions::default().timeout(Duration::from_secs(180)),
            )
            .await
            .map_err(|err| err.message)?;
            if !pip_works(app, &venv_py).await {
                return Err("it has no pip".to_string());
            }
            Ok(())
        }
        .await;
        if let Err(why) = made {
            let _ = std::fs::remove_dir_all(&dirs.venv);
            return Err(format!(
                "Installing faster-whisper failed: could not make its folder with {} ({why}).",
                base.label()
            ));
        }
    }

    // 3. faster-whisper itself, pinned, from pypi.org only, ready-made builds only.
    up.update(
        Some("packages"),
        Some(Some(format!("Downloading faster-whisper {FASTER_WHISPER_VERSION}"))),
        Some(30.0),
    );
    let collected = Arc::new(AtomicUsize::new(0));
    let lines = up.clone();
    let pip_args = args(&[
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--progress-bar",
        "off",
        "--only-binary=:all:",
        "--index-url",
        "https://pypi.org/simple",
        &format!("faster-whisper=={FASTER_WHISPER_VERSION}"),
    ]);
    let pip = RunOptions::default().timeout(PIP_TIMEOUT).on_line(move |line, _| {
        let dl = PIP_DOWNLOADING.captures(line);
        if PIP_COLLECTING.is_match(line) {
            collected.fetch_add(1, Ordering::SeqCst);
        }
        if let Some(dl) = dl {
            let size = dl
                .get(2)
                .map(|m| m.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| format!(" ({s})"))
                .unwrap_or_default();
            let share = (collected.load(Ordering::SeqCst) as f64 / PIP_PACKAGES_EXPECTED).min(1.0);
            lines.step(
                format!("Downloading faster-whisper's parts: {}{size}", dl[1].replace('_', "-")),
                30.0 + 40.0 * share,
            );
        } else if line.starts_with("Installing collected packages") {
            lines.step("Installing faster-whisper's parts", 72.0);
        }
    });
    run_python(app, &venv_py, &pip_args, pip).await.map_err(|err| {
        format!(
            "Installing faster-whisper failed: {}.",
            pip_problem(&err, &base_version)
        )
    })?;

    // 4. It loads.
    up.update(
        Some("check"),
        Some(Some("Checking faster-whisper works".into())),
        Some(76.0),
    );
    reset_stt_runtime(app);
    let probe = probe_python(app, &venv_py, Duration::from_secs(120)).await;
    let Some(fw) = probe.faster_whisper.clone() else {
        return Err(format!(
            "Installing faster-whisper failed: it was installed but doesn't load ({}).",
            probe
                .problem
                .as_deref()
                .filter(|p| !p.is_empty())
                .unwrap_or("no faster-whisper")
        ));
    };
    let marker = serde_json::json!({
        "fasterWhisper": fw,
        "python": base.version,
        "pythonFrom": base.label(),
        "installedAt": now_iso(),
    });
    write_file_atomic(
        &dirs.venv.join("tarsee-stt.json"),
        format!("{}\n", serde_json::to_string_pretty(&marker).unwrap_or_default()),
    )
    .map_err(|err| err.to_string())?;
    log(&format!("faster-whisper {fw} is ready in {}", dirs.venv.display()));

    // 5. A model, when there is none on disk yet.
    up.update(Some("model"), Some(None), Some(78.0));
    if resolve_stt_model(app, DEFAULT_WHISPER_MODEL).missing().is_some() {
        let catalog = catalog(app);
        let progress = up.clone();
        let on_progress = move |p: ModelProgress| {
            progress.step(
                format!(
                    "Downloading the {DEFAULT_WHISPER_MODEL} speech model ({} of {} MB)",
                    number_to_string(js_round(p.bytes_done as f64 / 1e6)),
                    number_to_string(js_round(p.bytes_total as f64 / 1e6))
                ),
                78.0 + 21.0 * (p.bytes_done as f64 / p.bytes_total as f64),
            );
        };
        let fetch = opts.fetch.clone().unwrap_or_else(|| app.fetch());
        let downloaded = download_whisper_model(
            DEFAULT_WHISPER_MODEL,
            &dirs.models,
            fetch,
            DownloadModelOptions {
                on_progress: Some(&on_progress),
                log: Some(&*log),
                retry_delay_ms: opts.retry_delay_ms.unwrap_or(1000),
                catalog: Some(&catalog),
            },
        )
        .await;
        if let Err(err) = downloaded {
            // Shown on the model's row too, with its Try again.
            SttInstall::of(app)
                .last
                .lock()
                .record("model", Some(DEFAULT_WHISPER_MODEL), Some(err.message.clone()));
            return Err(format!(
                "faster-whisper is installed, but downloading the {DEFAULT_WHISPER_MODEL} model failed: {}.",
                err.message
            ));
        }
    }
    reset_stt_runtime(app);
    Ok(())
}

// ── Models: Download and Delete ──────────────────────────────────────────

fn bad_model(app: &App, name: &str) -> SttJobError {
    let names: Vec<String> = catalog(app).iter().map(|m| m.name.clone()).collect();
    SttJobError {
        message: format!(
            "\"{}\" is not one of the speech models ({}).",
            utf16_truncate(name, 40),
            names.join(", ")
        ),
        code: Some("UNKNOWN_MODEL".into()),
        status: Some(400),
    }
}

/// Start downloading a model in the background. Returns the job (see [`StartedJob`]).
pub fn start_model_download(app: &App, name: &str, opts: SttJobOptions) -> Result<StartedJob, SttJobError> {
    if !valid_model(app, name) {
        return Err(bad_model(app, name));
    }
    let total: u64 = find_in_catalog(name, &catalog(app))
        .map(|m| m.files.iter().map(|f| f.size).sum())
        .unwrap_or(0);
    let model = name.to_string();
    let first = model.clone();
    begin(
        app,
        "model",
        Some(model.clone()),
        move |up| {
            up.update(Some("model"), Some(Some(format!("Downloading {first}"))), Some(0.0));
            up.step(
                format!(
                    "Downloading {first} (0 of {} MB)",
                    number_to_string(js_round(total as f64 / 1e6))
                ),
                0.0,
            );
        },
        move |app, up| async move {
            up.update(Some("model"), Some(Some(format!("Downloading {model}"))), Some(0.0));
            let catalog = catalog(&app);
            let log = opts.log.clone().unwrap_or_else(|| default_log("[stt]"));
            let progress = up.clone();
            let shown = model.clone();
            let on_progress = move |p: ModelProgress| {
                progress.step(
                    format!(
                        "Downloading {shown} ({} of {} MB)",
                        number_to_string(js_round(p.bytes_done as f64 / 1e6)),
                        number_to_string(js_round(p.bytes_total as f64 / 1e6))
                    ),
                    100.0 * (p.bytes_done as f64 / p.bytes_total as f64),
                );
            };
            let fetch = opts.fetch.clone().unwrap_or_else(|| app.fetch());
            download_whisper_model(
                &model,
                &stt_dirs(&app).models,
                fetch,
                DownloadModelOptions {
                    on_progress: Some(&on_progress),
                    log: Some(&*log),
                    retry_delay_ms: opts.retry_delay_ms.unwrap_or(1000),
                    catalog: Some(&catalog),
                },
            )
            .await
            .map(|_| ())
            .map_err(|err| err.message)
        },
    )
}

/// Whether the last download of this model failed less than `within` ago (so a transcription doesn't retry it each
/// time).
pub fn model_failed_recently(app: &App, name: &str, within: Duration) -> bool {
    SttInstall::of(app)
        .last
        .lock()
        .models
        .get(name)
        .is_some_and(|l| l.error.is_some() && now_ms() - l.finished_at_ms < within.as_millis() as i64)
}

/// The window [`model_failed_recently`] looks back over by default: ten minutes.
pub const MODEL_RETRY_PAUSE: Duration = Duration::from_secs(10 * 60);

/// Delete a model's downloaded copy (never the image's): `{ removed: [folders], kept: <image folder> | null }`.
pub fn remove_stt_model(app: &App, name: &str) -> Result<DeletedModel, SttJobError> {
    if !valid_model(app, name) {
        return Err(bad_model(app, name));
    }
    let svc = SttInstall::of(app);
    let downloading = svc
        .job
        .lock()
        .as_ref()
        .is_some_and(|j| j.kind == "model" && j.model.as_deref() == Some(name));
    if downloading {
        return Err(SttJobError {
            message: format!("{name} is downloading. Wait for it to finish, then delete it."),
            code: Some("BUSY".into()),
            status: Some(409),
        });
    }
    svc.last.lock().models.remove(name);
    delete_whisper_model(name, &stt_dirs(app).model_dirs(), &catalog(app)).map_err(|err| SttJobError {
        message: err.message,
        code: err.code,
        status: None,
    })
}

// ── Status (Settings > Voice > Speech-to-text) ───────────────────────────

/// A Python as Settings shows it: `{ label, version, executable, source }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PythonInfo {
    pub label: String,
    pub version: Option<String>,
    pub executable: Option<String>,
    pub source: Option<String>,
}

/// Whether faster-whisper is set up, and what Install would do.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// "ready" | "installing" | "failed" | "unsupported" | "not-installed".
    pub state: String,
    pub ready: bool,
    pub summary: String,
    pub faster_whisper: Option<String>,
    pub python: Option<PythonInfo>,
    pub source: Option<String>,
    #[serde(rename = "where")]
    pub where_: Option<String>,
    pub install_folder: String,
    pub needs_python_download: bool,
    pub can_install: bool,
    #[serde(rename = "downloadMB")]
    pub download_mb: u64,
    pub error: Option<String>,
    pub version: String,
    pub platform: String,
}

/// Everything Settings shows: the runtime, every model, the running job.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    /// voice.stt_provider as saved, else "local".
    pub provider: Value,
    pub current: String,
    pub runtime: RuntimeStatus,
    pub models: Vec<SttModelRow>,
    pub models_dir: String,
    pub bundled_dirs: Vec<String>,
    pub job: Option<JobSnapshot>,
}

/// The provider the owner chose (`store.get("voice.stt_provider") || "local"`).
pub(crate) fn stt_provider(settings: Option<&dyn Settings>) -> Value {
    match settings.and_then(|s| s.get("voice.stt_provider")) {
        Some(v) if crate::util::js::truthy(&v) => v,
        _ => Value::String("local".into()),
    }
}

/// Everything Settings shows: the runtime, every model, the running job. `refresh`: look for Python again.
pub async fn get_stt_status(app: &App, refresh: bool, settings: Option<&dyn Settings>) -> SttStatus {
    let svc = SttInstall::of(app);
    if refresh && svc.job.lock().is_none() {
        reset_stt_runtime(app);
    }
    let rt = find_stt_runtime(app, false).await;
    let dirs = stt_dirs(app);
    let current = chosen_model(app, settings);
    let target = python_target(&TargetQuery::current());
    let own = rt.ready().is_some_and(|r| r.source == "tarsee");
    let (custom, base, problem) = match &rt {
        SttRuntime::Ready(_) => (false, None, None),
        SttRuntime::NotReady { base, custom, problem } => (*custom, base.as_ref(), problem.clone()),
    };
    let python = match rt.ready() {
        Some(r) => Some(PythonInfo {
            label: r.label.clone(),
            version: r.version.clone(),
            executable: r.executable.clone(),
            source: Some(r.source.to_string()),
        }),
        None => base.map(|b| PythonInfo {
            label: b.label().to_string(),
            version: b.version.clone(),
            executable: b.executable.clone(),
            source: b.python.source.clone(),
        }),
    };
    let installing = svc.job.lock().as_ref().is_some_and(|j| j.kind == "install");
    let last_error = svc.last.lock().install.as_ref().and_then(|l| l.error.clone());

    let state = if installing {
        "installing"
    } else if rt.is_ready() {
        "ready"
    } else if last_error.is_some() {
        "failed"
    } else if target.is_err() && base.is_none() {
        "unsupported"
    } else {
        "not-installed"
    };

    let needs_python_download = !rt.is_ready() && base.is_none();
    let py_mb = js_round(STANDALONE_PYTHON.approx_bytes as f64 / 1e6) as u64;
    let summary = match state {
        "ready" => {
            let r = rt.ready().expect("ready");
            let at = if own {
                format!(" (Tarsee's own copy, in {})", dirs.venv.display())
            } else {
                r.executable.as_ref().map(|e| format!(" ({e})")).unwrap_or_default()
            };
            format!(
                "Ready: faster-whisper {} on Python {}{at}.",
                r.faster_whisper,
                r.version.as_deref().unwrap_or("undefined")
            )
        }
        // (the step and its progress are the job's)
        "installing" => "Installing faster-whisper…".to_string(),
        "failed" => last_error.clone().unwrap_or_default(),
        "unsupported" => format!(
            "faster-whisper can't be installed here: {}. Choose the OpenAI Whisper API instead.",
            target.as_ref().err().cloned().unwrap_or_default()
        ),
        _ if custom => format!("Not ready: {}.", problem.as_deref().unwrap_or("null")),
        _ => match base {
            Some(b) => format!(
                "Not installed. Install sets faster-whisper up in Tarsee's own folder, using Python {}{}: about {APPROX_PACKAGES_MB} MB to download.",
                b.version.as_deref().unwrap_or("null"),
                b.executable.as_ref().map(|e| format!(" ({e})")).unwrap_or_default()
            ),
            None => format!(
                "Not installed, and there is no Python on this computer. Install downloads Tarsee's own copy of Python (about {py_mb} MB) and faster-whisper (about {APPROX_PACKAGES_MB} MB) into Tarsee's folder."
            ),
        },
    };

    let ready = rt.ready();
    SttStatus {
        provider: stt_provider(settings),
        current: current.clone(),
        runtime: RuntimeStatus {
            state: state.to_string(),
            ready: ready.is_some(),
            summary,
            faster_whisper: ready.map(|r| r.faster_whisper.clone()),
            python,
            source: ready.map(|r| r.source.to_string()),
            where_: (ready.is_some() && own).then(|| path_text(&dirs.venv)),
            install_folder: path_text(&dirs.home),
            needs_python_download,
            can_install: ready.is_none() && !installing && !custom && state != "unsupported",
            download_mb: if needs_python_download { py_mb } else { 0 } + APPROX_PACKAGES_MB,
            error: (state == "failed").then(|| last_error.clone().unwrap_or_default()),
            version: FASTER_WHISPER_VERSION.to_string(),
            platform: format!("{} {}", node_platform(), node_arch()),
        },
        models: list_stt_models(app, &current),
        models_dir: path_text(&dirs.models),
        bundled_dirs: dirs.bundled.iter().map(|d| path_text(d)).collect(),
        job: stt_job(app),
    }
}

/// One line for the server log at boot: whether speech-to-text works out of the box.
pub async fn stt_boot_line(app: &App, settings: Option<&dyn Settings>) -> String {
    let s = get_stt_status(app, false, settings).await;
    let provider = if s.provider == Value::String("whisper-api".into()) {
        "OpenAI Whisper API (chosen in Settings), with local as backup"
    } else {
        "local"
    };
    if !s.runtime.ready {
        return format!(
            "[stt] speech-to-text ({provider}): faster-whisper is not installed. Install it from Settings > Voice > Speech-to-text."
        );
    }
    let model = match resolve_stt_model(app, &s.current) {
        ResolvedModel::Missing(name) => format!("no model on disk yet ({name} downloads on first use)"),
        ResolvedModel::Found { model, wanted } => {
            let from = match model.source {
                ModelSource::Image => "in the image",
                ModelSource::Cache => "in the old download cache",
                ModelSource::Downloaded => "downloaded",
            };
            let chosen = wanted
                .map(|w| format!("; {w} was chosen but isn't downloaded"))
                .unwrap_or_default();
            format!("model {} ({from}{chosen})", model.name)
        }
    };
    let version = s
        .runtime
        .python
        .as_ref()
        .map(|p| p.version.clone().unwrap_or_else(|| "null".into()))
        .unwrap_or_else(|| "undefined".into());
    format!(
        "[stt] speech-to-text ({provider}): ready, faster-whisper {} on Python {version}, {model}",
        s.runtime.faster_whisper.as_deref().unwrap_or("null")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{MemorySettings, test_app, test_app_with_env};
    use serde_json::json;

    fn run_error(stdout: &str, stderr: &str, message: &str) -> PythonRunError {
        PythonRunError {
            message: message.into(),
            stdout: stdout.into(),
            stderr: stderr.into(),
            ..Default::default()
        }
    }

    #[test]
    fn pip_s_failures_are_said_in_plain_words() {
        let full = run_error(
            "",
            "ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device",
            "x",
        );
        assert_eq!(pip_problem(&full, "3.11.4"), "the disk is full");
        let offline = run_error(
            "WARNING: Retrying ... NewConnectionError(...getaddrinfo failed')",
            "ERROR: No matching distribution found for faster-whisper==1.2.1",
            "x",
        );
        assert_eq!(
            pip_problem(&offline, "3.11.4"),
            "could not reach pypi.org (check the internet connection)"
        );
        let no_wheel = run_error("", "ERROR: No matching distribution found for ctranslate2<5,>=4.0", "x");
        assert_eq!(
            pip_problem(&no_wheel, "3.11.4"),
            format!(
                "pypi.org has no ready-made build of ctranslate2 for this computer (Python 3.11.4 on {} {})",
                node_platform(),
                node_arch()
            )
        );
        let other = run_error("", "ERROR: first\r\nnoise\r\n  ERROR:   last one  \r\n", "x");
        assert_eq!(pip_problem(&other, "3"), "last one");
        assert_eq!(pip_problem(&run_error("", "", "boom"), "3"), "boom");
        assert_eq!(pip_problem(&run_error("", "", ""), "3"), "pip stopped");
        let slow = PythonRunError {
            timed_out: true,
            ..run_error("", "", "x")
        };
        assert_eq!(
            pip_problem(&slow, "3"),
            "it took more than 20 minutes (a slow connection?)"
        );
    }

    #[test]
    fn pip_s_progress_lines_name_the_part() {
        let dl = PIP_DOWNLOADING
            .captures("  Downloading ctranslate2-4.8.5-cp312-cp312-win_amd64.whl (19.4 MB)")
            .unwrap();
        assert_eq!(
            (&dl[1], dl.get(2).map(|m| m.as_str())),
            ("ctranslate2", Some("19.4 MB"))
        );
        let dl = PIP_DOWNLOADING
            .captures("  Downloading faster_whisper-1.2.1-py3-none-any.whl")
            .unwrap();
        assert_eq!((&dl[1], dl.get(2)), ("faster_whisper", None));
        assert!(PIP_COLLECTING.is_match("Collecting numpy (from ...)"));
        assert!(!PIP_COLLECTING.is_match("Collectingnumpy"));
    }

    #[test]
    fn sizes_read_as_settings_shows_them() {
        assert_eq!(size_text(145_216_508 + 2_227 + 2_128_466 + 422_309), "148 MB");
        assert_eq!(size_text(20_000), "20 KB");
        assert_eq!(size_text(100), "1 KB");
        assert_eq!(size_text(1_500_000_000), "1.5 GB");
    }

    #[test]
    fn the_folders_follow_the_configuration_and_the_environment() {
        let t = test_app();
        let d = stt_dirs(&t);
        assert_eq!(d.models, t.config().data_dir.join("whisper-models"));
        assert_eq!(d.home, t.path().join("python"));
        assert_eq!(d.venv, t.path().join("python").join("stt-venv"));
        assert!(d.bundled.is_empty());
        // TARSEE_STATE_DIR is set, TARSEE_DATA_DIR is not: the old cache is <state>/whisper-models/hf_cache.
        assert_eq!(
            d.caches,
            [
                d.models.join("hf_cache"),
                t.path().join("whisper-models").join("hf_cache")
            ]
        );
        let delim = PATH_DELIMITER.to_string();
        let data = t.path().join("data").to_string_lossy().to_string();
        let t2 = test_app_with_env([
            ("TARSEE_WHISPER_BUNDLED_DIR", format!(" /a {delim}{delim}/b ")),
            ("TARSEE_DATA_DIR", data),
        ]);
        let d2 = stt_dirs(&t2);
        assert_eq!(d2.bundled, [PathBuf::from("/a"), PathBuf::from("/b")]);
        assert_eq!(d2.caches.len(), 1, "the same folder twice is one: {:?}", d2.caches);
    }

    #[test]
    fn the_chosen_model_is_one_of_the_catalog_s_else_the_default() {
        let t = test_app();
        let pick = |v: Value| chosen_model(&t, Some(&MemorySettings::from_pairs([("voice.stt_model", v)])));
        assert_eq!(pick(json!("small")), "small");
        assert_eq!(pick(json!("large-v3")), "base.en");
        assert_eq!(pick(json!(3)), "base.en");
        assert_eq!(chosen_model(&t, None), "base.en");
    }

    #[test]
    fn with_no_model_on_disk_the_chosen_one_is_missing_and_every_row_says_so() {
        let t = test_app();
        assert_eq!(resolve_stt_model(&t, "small"), ResolvedModel::Missing("small".into()));
        assert_eq!(resolve_stt_model(&t, "nope"), ResolvedModel::Missing("base.en".into()));
        let rows = list_stt_models(&t, "tiny");
        assert_eq!(rows.len(), 6);
        let tiny = serde_json::to_value(&rows[3]).unwrap();
        assert_eq!(
            tiny,
            json!({
                "name": "tiny", "description": "Many languages, found by itself. The fastest, and the least accurate.",
                "english": false, "multilingual": true, "bytes": 75538270 + 2249 + 2203239 + 459861, "size": "78 MB",
                "sizeMB": 78, "state": "missing", "downloaded": false, "where": null, "deletable": false,
                "current": true, "percent": null, "error": null,
            })
        );
    }

    #[test]
    fn an_unknown_model_is_refused_with_the_names_there_are() {
        let t = test_app();
        let err = start_model_download(&t, "../../etc", SttJobOptions::default())
            .err()
            .unwrap();
        assert_eq!(err.status, Some(400));
        assert_eq!(err.code.as_deref(), Some("UNKNOWN_MODEL"));
        assert_eq!(
            err.message,
            "\"../../etc\" is not one of the speech models (tiny.en, base.en, small.en, tiny, base, small)."
        );
        assert_eq!(remove_stt_model(&t, "large-v3").unwrap_err().status, Some(400));
        assert!(!model_failed_recently(&t, "tiny", MODEL_RETRY_PAUSE));
    }

    #[test]
    fn the_job_s_progress_only_goes_up_and_stays_below_100() {
        let t = test_app();
        let svc = SttInstall::of(&t);
        let (_tx, rx) = watch::channel(None);
        *svc.job.lock() = Some(Job {
            id: 7,
            kind: "model",
            model: Some("tiny".into()),
            phase: "start".into(),
            step: None,
            percent: 0,
            started_at: now_iso(),
            done: JobDone(rx),
        });
        let up = Updater {
            svc: svc.clone(),
            id: 7,
        };
        up.step("a", 40.7);
        assert_eq!(stt_job(&t).unwrap().percent, 40);
        up.step("b", 10.0);
        assert_eq!(stt_job(&t).unwrap().percent, 40);
        up.update(Some("model"), Some(None), Some(250.0));
        let snap = stt_job(&t).unwrap();
        assert_eq!((snap.percent, snap.step), (99, None));
        // Another job's updates change nothing.
        Updater { svc, id: 8 }.step("other", 1.0);
        assert_eq!(stt_job(&t).unwrap().step, None);
        assert_eq!(
            serde_json::to_value(stt_job(&t).unwrap())
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["kind", "model", "phase", "step", "percent", "startedAt"]
        );
    }
}
