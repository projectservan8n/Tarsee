//! Port of `src/voice/phonon-install.js`. Phonon installer: puts the Phonon TTS model and its English voices on the
//! data volume, and makes sure the Python runtime (ptts) can be imported.
//!
//!   <root>/models/phonon-31m-en   gradium/phonon-31m-en, q8 weights (Apache-2.0)
//!   <root>/catalog                English voices of gradium/phonon-voices (Apache-2.0)
//!   <root>/venv                   only on machines whose python3 lacks ptts; made from the Python
//!                                 speech-to-text uses (`python_runtime`), Windows included
//!   <root>/install.json           written last: the install finished
//!
//! <root> is DATA_DIR/tts/phonon, or TARSEE_PHONON_DIR.
//!
//! Only the official sources are used: the gradium organisation on Hugging Face at pinned revisions, and the ptts
//! package on PyPI at a pinned version. Every file is streamed to a temporary name and renamed into place only when
//! it is complete; the weights are checked against their published sha256 first. A lock file keeps two installs (the
//! server and a terminal run) from racing. The gated, non-commercial (CC BY-NC) Phonon models are never downloaded.
//!
//! Used by Settings -> Voice -> Install Phonon, by the background install on first boot ([`auto_install_phonon`]),
//! and from a terminal ([`run_install_command`]; the Node version ran `node src/voice/phonon-install.js`).
//!
//! Nothing here ever runs inside a TTS request.
//!
//! The Node module's state (the install running, its progress, the one boot attempt) is the app service
//! [`PhononInstaller`].

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};

// The download and lock helpers are shared with the other installers (`install_common`); the tests import them here.
pub use super::install_common::{acquire_lock, download_file};
use super::install_common::{
    DownloadFile, Downloader, InstallError, OFFICIAL_HOSTS, describe_fetch_error, guarded_fetch, write_file_atomic,
};
use super::engine_registry::engine_preference;
use super::phonon_engine::{
    PhononPaths, can_import_ptts, js_round, js_template, phonon_installed, phonon_paths, phonon_threads,
    reset_phonon_availability,
};
use super::python_runtime::{
    EnsureOptions, LogListener, PythonProgress, PythonRef, RunOptions, RunOutput, StandalonePython, describe_python,
    ensure_base_python, run_python,
};
use super::speech_text::js_trim;
use super::whisper_models::encode_uri_component;
use crate::app::App;
use crate::db::settings::Settings;
use crate::net::fetch::{Fetch, FetchRequest};
use crate::util::js::{now_iso, number_to_string, utf16_truncate};

pub const PTTS_VERSION: &str = "0.4.2";
const HF: &str = "https://huggingface.co";

/// A file of the model: its name, and its sha256 where Hugging Face publishes one (the LFS weights).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhononFile {
    pub name: String,
    pub sha256: Option<String>,
}

/// The model, pinned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhononModel {
    pub repo: String,
    pub revision: String,
    pub files: Vec<PhononFile>,
}

fn file(name: &str, sha256: Option<&str>) -> PhononFile {
    PhononFile {
        name: name.into(),
        sha256: sha256.map(str::to_string),
    }
}

/// The model, pinned. sha256 is given where Hugging Face publishes one (the LFS weights).
pub static PHONON_MODEL: LazyLock<PhononModel> = LazyLock::new(|| PhononModel {
    repo: "gradium/phonon-31m-en".into(),
    revision: "92741c5b07d085ff840e26fea8ce43110b87852f".into(),
    files: vec![
        file("config.json", None),
        file(
            "model.q8.gguf",
            Some("a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae"),
        ),
        file("tokenizer.json", None),
        file("tokenizer.model", None),
        file("default-voice.safetensors", None),
        file("generation_config.json", None),
        file("README.md", None),
    ],
});

/// The voice catalog, pinned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhononVoices {
    pub repo: String,
    pub revision: String,
    pub language: String,
    pub locales: Vec<String>,
}

/// The voice catalog, pinned. Only the English voices are downloaded (about 250 KB each).
pub static PHONON_VOICES: LazyLock<PhononVoices> = LazyLock::new(|| PhononVoices {
    repo: "gradium/phonon-voices".into(),
    revision: "0ee17205f254b5abc43b266c8a0f215565c352f7".into(),
    language: "en".into(),
    locales: vec!["en-us".into(), "en-gb".into()],
});

// About 64.5 MB of weights, 6 MB of voices and a few small files. Only used to show progress; nothing depends on it
// being exact.
const APPROX_TOTAL_BYTES: u64 = 72_000_000;
const STALL: Duration = Duration::from_secs(60);

pub fn hf_url(repo: &str, revision: &str, file: &str) -> String {
    let path: Vec<String> = file.split('/').map(encode_uri_component).collect();
    format!("{HF}/{repo}/resolve/{revision}/{}", path.join("/"))
}

// ── Status (what Settings -> Voice shows) ────────────────────────────────

/// One install, shared by everyone who asked for it while it ran: the status once installed, or why it failed.
pub type InstallRun = Shared<BoxFuture<'static, Result<PhononInstallStatus, InstallError>>>;

#[derive(Debug, Clone, Default)]
struct Progress {
    /// runtime | model | voices | check | done
    phase: Option<String>,
    file: Option<String>,
    bytes_done: i64,
    bytes_total: u64,
    error: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

/// The install's state, per app (the Node module's `_running`, `_status` and `_autoAttempted`).
pub struct PhononInstaller {
    running: Mutex<Option<(u64, InstallRun)>>,
    status: Mutex<Progress>,
    auto_attempted: AtomicBool,
    next_run: AtomicU64,
}

impl PhononInstaller {
    fn of(app: &App) -> Arc<PhononInstaller> {
        app.get_or_init(|| PhononInstaller {
            running: Mutex::new(None),
            status: Mutex::new(Progress {
                bytes_total: APPROX_TOTAL_BYTES,
                ..Default::default()
            }),
            auto_attempted: AtomicBool::new(false),
            next_run: AtomicU64::new(1),
        })
    }
}

/// `{ state, installed, phase, file, percent, error, startedAt, finishedAt }`.
/// state: "installed" | "installing" | "failed" | "not-installed".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhononInstallStatus {
    pub state: String,
    pub installed: bool,
    pub phase: Option<String>,
    pub file: Option<String>,
    pub percent: i64,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// What Settings -> Voice shows about the install.
pub fn get_phonon_install_status(app: &App) -> PhononInstallStatus {
    let installed = phonon_installed(&phonon_paths(app));
    let svc = PhononInstaller::of(app);
    let running = svc.running.lock().is_some();
    let st = svc.status.lock().clone();
    let state = if running {
        "installing"
    } else if installed {
        "installed"
    } else if st.error.is_some() {
        "failed"
    } else {
        "not-installed"
    };
    let percent = if state == "installed" {
        100
    } else {
        let share = (st.bytes_done as f64 / st.bytes_total as f64) * 100.0;
        if share.is_finite() {
            share.floor().clamp(0.0, 99.0) as i64
        } else {
            0
        }
    };
    PhononInstallStatus {
        state: state.into(),
        installed,
        phase: if running { st.phase } else { None },
        file: if running { st.file } else { None },
        percent,
        error: if state == "failed" { st.error } else { None },
        started_at: st.started_at,
        finished_at: st.finished_at,
    }
}

/// [`get_phonon_install_status`], plus a check that the Python runtime can still import ptts: files on the volume
/// outlive the image and its Python, so an install can be complete on disk and still unusable. That case reads as
/// "failed", and a retry repairs the runtime.
pub async fn check_phonon_install(app: &App) -> PhononInstallStatus {
    let status = get_phonon_install_status(app);
    if status.state != "installed" {
        return status;
    }
    let python = phonon_paths(app).python;
    if can_import_ptts(app, &python).await {
        return status;
    }
    PhononInstallStatus {
        state: "failed".into(),
        percent: 0,
        error: Some(format!("the model is installed, but {python} cannot import ptts")),
        ..status
    }
}

// ── Install ──────────────────────────────────────────────────────────────

/// Called after a successful install (re-initialises the TTS engine).
pub type OnInstalled = Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync>;

/// What the Python runtime step is given.
#[derive(Clone, Default)]
pub struct RuntimeOptions {
    /// With no usable Python here, download Tarsee's own (the owner clicked Install or Retry).
    pub allow_python_download: bool,
    pub fetch: Option<Arc<dyn Fetch>>,
    pub pin: Option<StandalonePython>,
    pub retry_delay_ms: u64,
    /// Tarsee's own Python, when it has to be downloaded first: counted in the progress too.
    pub on_python_progress: Option<Arc<dyn Fn(PythonProgress) + Send + Sync>>,
}

/// Makes `import ptts` work (tests replace it).
pub type EnsureRuntimeFn =
    Arc<dyn Fn(App, LogListener, RuntimeOptions) -> BoxFuture<'static, Result<(), InstallError>> + Send + Sync>;
/// A real synthesis with the installed files (tests replace it): a line for the log, or why it failed.
pub type SmokeTestFn = Arc<dyn Fn(App, PhononPaths) -> BoxFuture<'static, Result<String, InstallError>> + Send + Sync>;

/// The options of [`install_phonon`].
#[derive(Clone, Default)]
pub struct InstallOptions {
    /// The HTTP client (tests); the app's when `None`.
    pub fetch: Option<Arc<dyn Fetch>>,
    /// Replace [`PHONON_MODEL`] / [`PHONON_VOICES`] (tests).
    pub model: Option<PhononModel>,
    pub voices: Option<PhononVoices>,
    /// Pause before retrying a failed download (tests shorten it); 1000 ms when `None`.
    pub retry_delay_ms: Option<u64>,
    pub ensure_runtime: Option<EnsureRuntimeFn>,
    /// With no usable Python here, download Tarsee's own (the owner clicked Install or Retry).
    pub allow_python_download: bool,
    /// Replaces `python_runtime::STANDALONE_PYTHON` (tests).
    pub pin: Option<StandalonePython>,
    pub smoke_test: Option<SmokeTestFn>,
    /// On every chunk downloaded.
    pub on_progress: Option<Arc<dyn Fn(PhononInstallStatus) + Send + Sync>>,
    /// After success (re-initialises the TTS engine).
    pub on_installed: Option<OnInstalled>,
    pub log: Option<LogListener>,
}

/// Install Phonon. Concurrent calls share one run. Settles with the status once installed; fails (and the status
/// says "failed") on any error. The install runs whether or not anyone waits for it.
pub fn install_phonon(app: &App, opts: InstallOptions) -> InstallRun {
    let svc = PhononInstaller::of(app);
    let mut running = svc.running.lock();
    if let Some((_, run)) = running.as_ref() {
        return run.clone();
    }
    let id = svc.next_run.fetch_add(1, Ordering::SeqCst);
    let (app, mine) = (app.clone(), svc.clone());
    let task = tokio::spawn(async move {
        let result = run_install(&app, &opts).await;
        {
            let mut running = mine.running.lock();
            if running.as_ref().is_some_and(|(i, _)| *i == id) {
                *running = None;
            }
        }
        result.map(|()| get_phonon_install_status(&app))
    });
    let run: InstallRun = async move {
        task.await
            .unwrap_or_else(|err| Err(InstallError::new(format!("the install stopped: {err}"))))
    }
    .boxed()
    .shared();
    *running = Some((id, run.clone()));
    run
}

fn default_log(prefix: &'static str) -> LogListener {
    Arc::new(move |m: &str| log::info!("{prefix} {m}"))
}

async fn run_install(app: &App, opts: &InstallOptions) -> Result<(), InstallError> {
    // Hugging Face (and its CDN) over https, nothing else, redirects included.
    let fetch = opts.fetch.clone().unwrap_or_else(|| app.fetch());
    let get = guarded_fetch(&[OFFICIAL_HOSTS.huggingface], fetch);
    let model = opts.model.clone().unwrap_or_else(|| PHONON_MODEL.clone());
    let voices_src = opts.voices.clone().unwrap_or_else(|| PHONON_VOICES.clone());
    let retry_delay_ms = opts.retry_delay_ms.unwrap_or(1000);
    let log = opts.log.clone().unwrap_or_else(|| default_log("[phonon:install]"));
    let svc = PhononInstaller::of(app);
    let report = || {
        if let Some(on_progress) = &opts.on_progress {
            on_progress(get_phonon_install_status(app));
        }
    };
    let progress = |n: i64| {
        {
            let mut st = svc.status.lock();
            st.bytes_done = st.bytes_done.saturating_add(n).max(0);
        }
        report();
    };
    *svc.status.lock() = Progress {
        phase: Some("runtime".into()),
        file: None,
        bytes_done: 0,
        bytes_total: APPROX_TOTAL_BYTES,
        error: None,
        started_at: Some(now_iso()),
        finished_at: None,
    };
    let set = |phase: Option<&str>, file: Option<Option<String>>| {
        let mut st = svc.status.lock();
        if let Some(phase) = phase {
            st.phase = Some(phase.to_string());
        }
        if let Some(file) = file {
            st.file = file;
        }
    };

    let installed: Result<(), InstallError> = async {
        let root = phonon_paths(app).root;
        std::fs::create_dir_all(&root)?;
        let _lock = acquire_lock(app, &root, None)?;
        log(&format!("installing into {}", root.display()));

        // 1. The Python runtime.
        let python_progress = {
            let (svc, app, on_progress) = (svc.clone(), app.clone(), opts.on_progress.clone());
            Arc::new(move |p: PythonProgress| {
                {
                    let mut st = svc.status.lock();
                    st.file = Some(format!(
                        "Python ({} of {} MB)",
                        number_to_string(js_round(p.bytes_done as f64 / 1e6)),
                        number_to_string(js_round(p.bytes_total as f64 / 1e6))
                    ));
                    st.bytes_total = APPROX_TOTAL_BYTES.saturating_add(p.bytes_total);
                    st.bytes_done = i64::try_from(p.bytes_done).unwrap_or(i64::MAX);
                }
                if let Some(on_progress) = &on_progress {
                    on_progress(get_phonon_install_status(&app));
                }
            })
        };
        let runtime = RuntimeOptions {
            allow_python_download: opts.allow_python_download,
            fetch: opts.fetch.clone(),
            pin: opts.pin.clone(),
            retry_delay_ms,
            on_python_progress: Some(python_progress),
        };
        match &opts.ensure_runtime {
            Some(ensure) => ensure(app.clone(), log.clone(), runtime).await?,
            None => ensure_runtime(app, &log, &runtime).await?,
        }

        // 2. The model.
        set(Some("model"), None);
        // After step 1: the venv's python, if one was created.
        let p = phonon_paths(app);
        for f in &model.files {
            set(None, Some(Some(f.name.clone())));
            let mut spec = DownloadFile::new(hf_url(&model.repo, &model.revision, &f.name), p.model.join(&f.name))
                .retry_delay_ms(retry_delay_ms)
                .progress(&progress);
            spec.sha256 = f.sha256.clone();
            download_file(&get, spec).await?;
        }

        // 3. The English voices.
        set(Some("voices"), Some(Some("voices.jsonl".into())));
        let voices = fetch_voice_list(&get, &voices_src, &p.catalog).await?;
        for v in &voices {
            set(None, Some(Some(v.filename.clone())));
            let mut spec = DownloadFile::new(hf_url(&voices_src.repo, &voices_src.revision, &v.filename), &v.dest)
                .retry_delay_ms(retry_delay_ms)
                .progress(&progress);
            spec.sha256 = v.sha256.clone();
            download_file(&get, spec).await?;
        }
        set(None, Some(Some("README.md".into())));
        download_file(
            &get,
            DownloadFile::new(
                hf_url(&voices_src.repo, &voices_src.revision, "README.md"),
                p.catalog.join("README.md"),
            )
            .retry_delay_ms(retry_delay_ms)
            .progress(&progress),
        )
        .await?;
        // The catalog index goes in last: it lists only voices that are on disk.
        let index: Vec<&str> = voices.iter().map(|v| v.line.as_str()).collect();
        write_file_atomic(&p.catalog.join("voices.jsonl"), format!("{}\n", index.join("\n")))?;

        // 4. One real synthesis, offline, before calling it installed.
        set(Some("check"), Some(None));
        reset_phonon_availability(app);
        let smoke = match &opts.smoke_test {
            Some(smoke) => smoke(app.clone(), p.clone()).await,
            None => smoke_test(app, &p).await,
        };
        let smoke = match smoke {
            Ok(smoke) => smoke,
            Err(err) => {
                // The model files without a published hash could not be verified: drop them so a retry fetches them
                // again instead of failing the same way.
                for f in model.files.iter().filter(|f| f.sha256.is_none()) {
                    let _ = std::fs::remove_file(p.model.join(&f.name));
                }
                return Err(err);
            }
        };
        if !smoke.is_empty() {
            log(&format!("smoke test: {smoke}"));
        }

        // 5. Done.
        let marker = json!({
            "ptts": PTTS_VERSION,
            "model": { "repo": model.repo, "revision": model.revision },
            "voices": { "repo": voices_src.repo, "revision": voices_src.revision, "count": voices.len() },
            "installedAt": now_iso(),
        });
        write_file_atomic(
            &p.marker,
            format!("{}\n", serde_json::to_string_pretty(&marker).unwrap_or_default()),
        )?;
        reset_phonon_availability(app);
        {
            let mut st = svc.status.lock();
            st.phase = Some("done".into());
            st.finished_at = Some(now_iso());
        }
        log(&format!(
            "done: model and {} voices in {}",
            voices.len(),
            root.display()
        ));
        Ok(())
    }
    .await;

    if let Err(err) = installed {
        {
            let mut st = svc.status.lock();
            st.error = Some(err.message.clone());
            st.finished_at = Some(now_iso());
        }
        log(&format!("failed: {}", err.message));
        return Err(err);
    }

    if let Some(on_installed) = &opts.on_installed
        && let Err(err) = on_installed().await
    {
        log(&format!("installed, but switching the engine failed: {err}"));
    }
    Ok(())
}

/// A voice of the pinned catalog to download: `{ filename, dest, sha256, line }`.
struct VoiceEntry {
    filename: String,
    dest: PathBuf,
    sha256: Option<String>,
    line: String,
}

static SAFE_REL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$").expect("the safe path pattern"));

/// dir/rel when rel is a plain relative path that stays inside dir; `None` otherwise. Each piece is checked to be one
/// plain name before it is joined, so an absolute path or `..` can never lead out.
fn safe_join(dir: &Path, rel: Option<&Value>) -> Option<PathBuf> {
    let Some(Value::String(rel)) = rel else {
        return None;
    };
    if !SAFE_REL.is_match(rel) {
        return None;
    }
    let pieces: Vec<&str> = rel.split('/').collect();
    if pieces.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return None;
    }
    let mut dest = dir.to_path_buf();
    for piece in pieces {
        dest.push(piece);
    }
    dest.starts_with(dir).then_some(dest)
}

/// The English voices of the pinned catalog.
async fn fetch_voice_list(get: &dyn Downloader, src: &PhononVoices, catalog: &Path) -> Result<Vec<VoiceEntry>, InstallError> {
    let url = hf_url(&src.repo, &src.revision, "voices.jsonl");
    let res = get
        .get(FetchRequest::get(url.clone()).timeout(STALL))
        .await
        .map_err(|err| describe_fetch_error(&err, &url))?;
    if !res.ok() {
        return Err(InstallError::new(format!(
            "could not fetch the voice list (HTTP {})",
            res.status
        )));
    }
    let text = res.text().await.map_err(InstallError::from_fetch)?;
    let mut voices = Vec::new();
    for line in text.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        let Ok(d) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let language = d.get("language").and_then(Value::as_str);
        let locale = d.get("locale").and_then(Value::as_str);
        if language != Some(src.language.as_str()) || !locale.is_some_and(|l| src.locales.iter().any(|x| x == l)) {
            continue;
        }
        let Some(dest) = safe_join(catalog, d.get("filename")) else {
            return Err(InstallError::new(format!(
                "the voice list names an unsafe file: {}",
                utf16_truncate(&js_template(d.get("filename")), 80)
            )));
        };
        voices.push(VoiceEntry {
            filename: d["filename"].as_str().unwrap_or_default().to_string(),
            dest,
            sha256: d.get("sha256").and_then(Value::as_str).map(str::to_string),
            line: js_trim(line).to_string(),
        });
    }
    if voices.is_empty() {
        return Err(InstallError::new("the voice list has no English voices"));
    }
    Ok(voices)
}

// ── Python runtime ───────────────────────────────────────────────────────

/// Run a Python (a path or a command) through `python_runtime`; the error is its last `lines` lines of output.
async fn run(
    app: &App,
    python: &PythonRef,
    args: &[&str],
    timeout: Duration,
    env: Option<std::collections::BTreeMap<String, String>>,
    lines: usize,
) -> Result<RunOutput, InstallError> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let mut opts = RunOptions::default().timeout(timeout);
    opts.env = env;
    run_python(app, python, &args, opts).await.map_err(|err| {
        let all: Vec<&str> = js_trim(&err.stderr).split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
        let detail = all[all.len().saturating_sub(lines)..].join(" ");
        let detail = js_trim(&detail);
        InstallError {
            code: err.code.clone(),
            ..InstallError::new(if detail.is_empty() { err.message.clone() } else { detail.to_string() })
        }
    })
}

const RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// Make `import ptts` work. The Docker image installs ptts for python3, so this is normally a no-op. Elsewhere it
/// creates <root>/venv and pip-installs the pinned ptts there (a prebuilt wheel; its only dependency is numpy).
///
/// The venv is made from the same Python speech-to-text uses (`python_runtime`): one found on this computer (on
/// Windows, the py launcher), else Tarsee's own CPython, which is downloaded only when `allow_python_download` (the
/// owner clicked Install or Retry; the background install on boot never downloads it).
pub async fn ensure_runtime(app: &App, log: &LogListener, opts: &RuntimeOptions) -> Result<(), InstallError> {
    let p = phonon_paths(app);
    if can_import_ptts(app, &p.python).await {
        return Ok(());
    }
    if app.env().trimmed("TARSEE_PHONON_PYTHON").is_some() {
        return Err(InstallError::new(format!(
            "TARSEE_PHONON_PYTHON ({0}) cannot import ptts. Install it there: {0} -m pip install ptts=={PTTS_VERSION}",
            p.python
        )));
    }

    let venv_python = PythonRef::new(p.venv_python.to_string_lossy());
    let venv = p.venv.to_string_lossy().into_owned();
    // A venv left half made (no pip) by an earlier failed attempt is rebuilt.
    if p.venv_python.exists()
        && run(app, &venv_python, &["-I", "-m", "pip", "--version"], RUN_TIMEOUT, None, 3)
            .await
            .is_err()
    {
        let _ = std::fs::remove_dir_all(&p.venv);
    }
    if !p.venv_python.exists() {
        let ensure = EnsureOptions {
            allow_download: opts.allow_python_download,
            fetch: opts.fetch.clone(),
            pin: opts.pin.clone(),
            on_progress: opts.on_python_progress.clone(),
            log: Some(log.clone()),
            retry_delay_ms: opts.retry_delay_ms,
        };
        let base = ensure_base_python(app, &ensure)
            .await
            .map_err(|err| InstallError::new(format!("Could not set up Python for Phonon: {}", err.message)))?;
        let named = describe_python(&base.python);
        log(&format!(
            "{} has no ptts: creating a private venv at {venv} with {named} (Python {})",
            p.python,
            base.version.as_deref().unwrap_or("")
        ));
        let made = async {
            run(app, &base.python, &["-I", "-m", "venv", &venv], Duration::from_secs(180), None, 3).await?;
            run(app, &venv_python, &["-I", "-m", "pip", "--version"], RUN_TIMEOUT, None, 3).await
        }
        .await;
        if let Err(err) = made {
            let _ = std::fs::remove_dir_all(&p.venv);
            return Err(InstallError::new(format!(
                "Could not create a Python venv for Phonon with {named} ({}). Install Python 3.9+ with the venv module (Debian/Ubuntu: apt install python3-venv), or install the runtime yourself: pip install ptts=={PTTS_VERSION}",
                err.message
            )));
        }
    }
    log(&format!("installing ptts {PTTS_VERSION} into {venv}"));
    // From pypi.org only (--isolated ignores pip settings that point elsewhere), ready-made builds only.
    let spec = format!("ptts=={PTTS_VERSION}");
    run(
        app,
        &venv_python,
        &[
            "-I",
            "-m",
            "pip",
            "--isolated",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--quiet",
            "--only-binary=:all:",
            "--index-url",
            "https://pypi.org/simple",
            &spec,
        ],
        Duration::from_secs(600),
        None,
        3,
    )
    .await
    .map_err(|err| InstallError::new(format!("pip could not install ptts {PTTS_VERSION}: {}", err.message)))?;
    reset_phonon_availability(app);
    let p = phonon_paths(app);
    if !can_import_ptts(app, &p.python).await {
        return Err(InstallError::new(format!(
            "ptts {PTTS_VERSION} was installed but {} cannot import it",
            p.python
        )));
    }
    Ok(())
}

/// Load the model and speak one line, offline. Fails when that does not work.
pub async fn smoke_test(app: &App, p: &PhononPaths) -> Result<String, InstallError> {
    let code = [
        "import sys, ptts",
        "ptts.set_num_threads(int(sys.argv[3]))",
        "tts = ptts.TTS(sys.argv[1], lang='en', quant='q8', voice_catalog=sys.argv[2])",
        "pcm = tts.synth('Phonon is ready.', voice='Toby')",
        "assert len(pcm) > 0, 'no audio'",
        "print(f'{len(pcm) / tts.sample_rate:.1f}s of audio on {tts.device}-{tts.quant}')",
    ]
    .join("\n");
    let mut env = app.env().snapshot();
    env.insert("HF_HUB_OFFLINE".into(), "1".into());
    env.insert("HF_HUB_DISABLE_TELEMETRY".into(), "1".into());
    let model = p.model.to_string_lossy().into_owned();
    let catalog = p.catalog.to_string_lossy().into_owned();
    let threads = phonon_threads(app.env()).to_string();
    // lines 1: the exception, not the traceback.
    run(
        app,
        &PythonRef::new(&p.python),
        &["-I", "-c", &code, &model, &catalog, &threads],
        Duration::from_secs(180),
        Some(env),
        1,
    )
    .await
    .map(|out| js_trim(&out.stdout).to_string())
    .map_err(|err| InstallError::new(format!("the downloaded model did not load: {}", err.message)))
}

// ── Background install on boot ───────────────────────────────────────────

/// Starts an install (tests replace [`install_phonon`]).
pub type InstallFn = Arc<dyn Fn(App, InstallOptions) -> BoxFuture<'static, Result<(), InstallError>> + Send + Sync>;

/// The options of [`auto_install_phonon`].
#[derive(Clone)]
pub struct AutoInstallOptions {
    pub install: Option<InstallFn>,
    pub on_installed: Option<OnInstalled>,
    /// How long after boot the download starts (5 s).
    pub delay: Duration,
}

impl Default for AutoInstallOptions {
    fn default() -> Self {
        AutoInstallOptions {
            install: None,
            on_installed: None,
            delay: Duration::from_secs(5),
        }
    }
}

static OFF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(0|false|off|no)$").expect("the off pattern"));

/// Called once at server start. When the voice engine is Phonon (the default) and the model is not on the volume
/// yet, download it in the background; Edge TTS speaks meanwhile. One attempt per boot; a failure is shown in
/// Settings -> Voice with a retry button. TARSEE_PHONON_AUTO_INSTALL=0 turns it off. Returns whether an install was
/// scheduled.
pub fn auto_install_phonon(app: &App, settings: Option<&dyn Settings>, opts: AutoInstallOptions) -> bool {
    let svc = PhononInstaller::of(app);
    if svc.auto_attempted.load(Ordering::SeqCst) {
        return false;
    }
    let switch = app.env().get("TARSEE_PHONON_AUTO_INSTALL").unwrap_or_default();
    if OFF.is_match(js_trim(&switch)) {
        return false;
    }
    if engine_preference(settings) != "phonon" {
        return false;
    }
    if phonon_installed(&phonon_paths(app)) {
        return false;
    }
    svc.auto_attempted.store(true, Ordering::SeqCst);
    log::info!(
        "[phonon] Phonon is the voice engine but is not installed yet: downloading it in the background (Edge TTS speaks until it is ready; TARSEE_PHONON_AUTO_INSTALL=0 turns this off)"
    );
    let install: InstallFn = opts.install.unwrap_or_else(|| {
        Arc::new(|app: App, opts: InstallOptions| {
            async move { install_phonon(&app, opts).await.map(|_| ()) }.boxed()
        })
    });
    let app = app.clone();
    let on_installed = opts.on_installed;
    let delay = opts.delay;
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        let started = install(
            app,
            InstallOptions {
                on_installed,
                ..Default::default()
            },
        )
        .await;
        if let Err(err) = started {
            log::warn!(
                "[phonon] background install failed: {} (retry from Settings -> Voice)",
                err.message
            );
        }
    });
    true
}

// ── Terminal ─────────────────────────────────────────────────────────────

/// `tarsee phonon-install` (the Node version's `node src/voice/phonon-install.js`): installs Phonon here, with
/// progress every 10%. Gives the exit code: 0 installed, 1 failed.
pub async fn run_install_command(app: &App) -> i32 {
    let shown = Arc::new(Mutex::new(-10i64));
    let opts = InstallOptions {
        log: Some(Arc::new(|m: &str| log::info!("[phonon] {m}"))),
        on_progress: Some(Arc::new(move |s: PhononInstallStatus| {
            let mut shown = shown.lock();
            if s.percent >= *shown + 10 {
                *shown = s.percent - s.percent % 10;
                log::info!(
                    "[phonon] {} {}%",
                    s.phase.as_deref().unwrap_or("null"),
                    s.percent
                );
            }
        })),
        ..Default::default()
    };
    match install_phonon(app, opts).await {
        Ok(_) => {
            log::info!(
                "[phonon] installed. A running Tarsee switches to it after a restart, or when Settings -> Voice is saved."
            );
            0
        }
        Err(err) => {
            log::error!("[phonon] install failed: {}", err.message);
            1
        }
    }
}

#[cfg(test)]
mod tests;
