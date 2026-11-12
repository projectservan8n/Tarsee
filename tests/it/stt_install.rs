//! test/stt-install.test.js: Settings > Voice > Speech-to-text's installer (src/voice/stt_install.rs): what is installed
//! and with which Python, each model with its size and where it is; "Install faster-whisper" (a Python found here, else
//! Tarsee's own copy downloaded; a private folder for faster-whisper; the pinned faster-whisper from pypi.org,
//! ready-made builds only; then the default model), with progress and plain-words errors; per-model Download and
//! Delete; one job at a time. A fake Python (a real process), a fake GitHub and a fake Hugging Face stand in: nothing
//! is downloaded.

use std::sync::Arc;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};
use tarsee::testkit::fake_download_host::{FakeDownloadHost, Route};
use tarsee::testkit::tmp_dir;
use tarsee::voice::python_runtime::{set_for_tests as set_python, standalone_ready, venv_interpreter};
use tarsee::voice::stt_install::{
    FASTER_WHISPER_VERSION, JobOutcome, JobSnapshot, SttJobOptions, StartedJob, find_stt_runtime, get_stt_status,
    remove_stt_model, set_for_tests as set_catalog, start_model_download, start_stt_install, stt_job,
};
use tarsee::voice::whisper_models::WHISPER_MODEL_NAMES;
use tempfile::TempDir;

use crate::fake_python::{FakePython, cand};
use crate::voice_fixtures::{Models, Standalone, VoiceApp, models, random_bytes, standalone, voice_app};

struct World {
    t: VoiceApp,
    py: FakePython,
    models: Models,
    gh: Standalone,
    _fake: TempDir,
}

fn world() -> World {
    let t = voice_app(&[]);
    let fake = tmp_dir();
    let py = FakePython::new(fake.path(), json!({ "pythons": {}, "pip": { "mode": "ok", "delayMs": 1 } }));
    set_python(&t, py.overrides(vec![cand("python3", &[]), cand("python", &[])]));
    let models = models(
        |name| if name.starts_with("small") { 40_000 } else { 20_000 },
        |name| format!("{{\"name\": \"{name}\"}}\n"),
    );
    set_catalog(&t, Some(models.catalog.clone()));
    World {
        t,
        py,
        models,
        gh: standalone(),
        _fake: fake,
    }
}

impl World {
    /// Hugging Face and GitHub, with `over` replacing some of their answers.
    fn host(&self, over: Vec<(String, Route)>) -> Arc<FakeDownloadHost> {
        let mut routes = self.models.routes(4_000, 1);
        routes.extend(self.gh.routes());
        routes.extend(over);
        FakeDownloadHost::new(routes)
    }

    fn opts(&self, host: &Arc<FakeDownloadHost>) -> SttJobOptions {
        SttJobOptions {
            fetch: Some(host.clone()),
            pin: Some(self.gh.pin.clone()),
            retry_delay_ms: Some(1),
            log: None,
        }
    }

    fn venv_python(&self) -> String {
        venv_interpreter(&self.t.path().join("python").join("stt-venv"))
            .to_string_lossy()
            .to_string()
    }
}

/// Every job update until it ends.
async fn watch(t: &VoiceApp, job: StartedJob) -> (JobOutcome, Vec<JobSnapshot>) {
    let mut seen = Vec::new();
    let done = job.done.wait();
    tokio::pin!(done);
    loop {
        tokio::select! {
            result = &mut done => return (result, seen),
            _ = tokio::time::sleep(Duration::from_millis(5)) => {
                if let Some(j) = stt_job(t) {
                    seen.push(j);
                }
            }
        }
    }
}

fn model<'a>(status: &'a tarsee::voice::stt_install::SttStatus, name: &str) -> &'a tarsee::voice::stt_install::SttModelRow {
    status.models.iter().find(|m| m.name == name).unwrap()
}

// ── speech-to-text status ────────────────────────────────────────────────

#[tokio::test]
async fn nothing_installed_no_python_says_so_in_plain_words_every_model_with_its_size_none_downloaded_and_where_they_go() {
    let w = world();
    let s = get_stt_status(&w.t, true, None).await;
    assert_eq!(s.runtime.state, "not-installed");
    assert_eq!(s.runtime.python, None);
    assert!(s.runtime.needs_python_download);
    assert!(s.runtime.can_install);
    assert!(s.runtime.summary.to_lowercase().contains("not installed"), "{}", s.runtime.summary);
    let jargon = Regex::new(r"(?i)venv|pip|ENOENT|hf_cache").unwrap();
    assert!(!jargon.is_match(&s.runtime.summary), "no jargon");
    assert_eq!(s.models.iter().map(|m| m.name.clone()).collect::<Vec<_>>(), *WHISPER_MODEL_NAMES);
    let size = Regex::new(r"[0-9]+ (KB|MB)").unwrap();
    for m in &s.models {
        assert_eq!(m.state, "missing");
        assert!(m.bytes > 0 && size.is_match(&m.size), "{}: {}", m.name, m.size);
        assert!(!m.description.is_empty());
    }
    assert_eq!(s.current, "base.en");
    assert_eq!(s.models_dir, w.t.path().join("data").join("whisper-models").to_string_lossy());
    assert_eq!(s.job, None);
}

#[tokio::test]
async fn a_python_here_with_faster_whisper_the_docker_image_s_and_a_model_that_comes_with_the_image_ready_nothing_to_do() {
    let w = world();
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.2", "packages": { "faster-whisper": "1.2.1" }, "executable": "/usr/bin/python3" } } }));
    let image = w.t.path().join("image-models");
    w.models.put(&image, "base.en");
    w.t.env().set("TARSEE_WHISPER_BUNDLED_DIR", image.to_string_lossy().to_string());
    let s = get_stt_status(&w.t, true, None).await;
    assert_eq!(s.runtime.state, "ready");
    assert_eq!(s.runtime.faster_whisper.as_deref(), Some("1.2.1"));
    let python = s.runtime.python.as_ref().unwrap();
    assert_eq!(python.version.as_deref(), Some("3.11.2"));
    assert_eq!(python.executable.as_deref(), Some("/usr/bin/python3"));
    assert!(s.runtime.summary.contains("Ready"));
    let base = model(&s, "base.en");
    assert_eq!(base.state, "image");
    assert!(!base.deletable);
    assert_eq!(base.where_.as_deref(), Some(image.join("base.en").to_string_lossy().as_ref()));
    assert!(base.current);
}

// ── Install faster-whisper ───────────────────────────────────────────────

#[tokio::test]
async fn with_a_python_found_here_a_private_folder_for_it_the_pinned_faster_whisper_ready_made_builds_from_pypi_org_only_then_the_default_model()
 {
    let w = world();
    // pip's lines come a little apart, as a real download's do: watch() looks every 5 ms, and lines 2 ms apart could
    // each be replaced by the next before it looks (a fast machine missed ctranslate2's).
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.4" } }, "pip": { "delayMs": 25 } }));
    let host = w.host(vec![]);
    let job = start_stt_install(&w.t, w.opts(&host)).unwrap();
    assert_eq!(job.job.kind, "install");
    let (result, seen) = watch(&w.t, job).await;
    assert!(result.ok, "{:?}", result.error);
    let mut phases: Vec<String> = Vec::new();
    for j in &seen {
        if !phases.contains(&j.phase) {
            phases.push(j.phase.clone());
        }
    }
    let phases: Vec<&str> = phases.iter().map(String::as_str).filter(|p| *p != "python").collect();
    assert_eq!(phases, ["venv", "packages", "check", "model"], "phases: {phases:?}");
    assert!(
        seen.iter().any(|j| j.step.as_deref().unwrap_or("").contains("ctranslate2")),
        "the step names what pip is downloading"
    );
    let pcts: Vec<i64> = seen.iter().map(|j| j.percent).collect();
    assert!(pcts.windows(2).all(|p| p[1] >= p[0]), "progress only goes up: {pcts:?}");
    assert!(seen.iter().all(|j| j.percent < 100));

    let calls = w.py.calls();
    let pip = calls
        .iter()
        .find(|c| c["args"].as_array().is_some_and(|a| a.iter().any(|x| x == "install")))
        .expect("pip ran");
    let args: Vec<String> = serde_json::from_value(pip["args"].clone()).unwrap();
    for flag in ["--isolated", "--only-binary=:all:", "--no-input", "--disable-pip-version-check"] {
        assert!(args.iter().any(|a| a == flag), "pip {flag}");
    }
    let at = args.iter().position(|a| a == "--index-url").unwrap();
    assert_eq!(args[at + 1], "https://pypi.org/simple");
    assert!(args.contains(&format!("faster-whisper=={FASTER_WHISPER_VERSION}")));
    assert_eq!(
        pip["cmd"].as_str().unwrap(),
        w.venv_python(),
        "pip runs in Tarsee's own folder, not the system Python"
    );

    let s = get_stt_status(&w.t, false, None).await;
    assert_eq!(s.runtime.state, "ready");
    assert_eq!(s.runtime.source.as_deref(), Some("tarsee"));
    assert_eq!(model(&s, "base.en").state, "downloaded");
    assert_eq!(
        host.requests()
            .iter()
            .filter(|r| r.url.starts_with("https://api.github.com"))
            .count(),
        0,
        "no Python was downloaded"
    );
    let rt = find_stt_runtime(&w.t, false).await;
    assert_eq!(
        rt.ready().unwrap().python.cmd,
        w.venv_python(),
        "speech-to-text now uses that Python"
    );
}

#[tokio::test]
async fn with_no_python_at_all_tarsee_s_own_python_is_downloaded_first_then_the_rest() {
    let w = world();
    let host = w.host(vec![]);
    let (result, seen) = watch(&w.t, start_stt_install(&w.t, w.opts(&host)).unwrap()).await;
    assert!(result.ok, "{:?}", result.error);
    assert!(
        seen.iter()
            .any(|j| j.phase == "python" && j.step.as_deref().unwrap_or("").contains("Python 3.12")),
        "says it is downloading Python"
    );
    assert!(standalone_ready(w.t.config(), &w.gh.pin));
    let s = get_stt_status(&w.t, false, None).await;
    assert_eq!(s.runtime.state, "ready");
    assert_eq!(s.runtime.python.unwrap().version.as_deref(), Some("3.12.16"));
}

async fn pip_failing(mode: &str, words: &str) {
    let w = world();
    let words = Regex::new(words).unwrap();
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.4" } }, "pip": { "mode": mode, "delayMs": 1 } }));
    let host = w.host(vec![]);
    let (result, _) = watch(&w.t, start_stt_install(&w.t, w.opts(&host)).unwrap()).await;
    assert!(!result.ok);
    let error = result.error.unwrap();
    assert!(words.is_match(&error), "{error}");
    assert!(error.starts_with("Installing faster-whisper failed"), "{error}");
    let s = get_stt_status(&w.t, true, None).await;
    assert_eq!(s.runtime.state, "failed");
    assert!(words.is_match(s.runtime.error.as_deref().unwrap()));
    assert!(s.runtime.can_install, "Try again");

    w.py.set(json!({ "pip": { "mode": "ok", "delayMs": 1 } }));
    let (again, _) = watch(&w.t, start_stt_install(&w.t, w.opts(&host)).unwrap()).await;
    assert!(again.ok, "{:?}", again.error);
    assert_eq!(get_stt_status(&w.t, false, None).await.runtime.state, "ready");
}

#[tokio::test]
async fn pip_failing_fail_halfway_is_said_in_plain_words_the_status_shows_it_and_a_retry_works() {
    pip_failing("fail-halfway", r"disk is full").await;
}

#[tokio::test]
async fn pip_failing_offline_is_said_in_plain_words_the_status_shows_it_and_a_retry_works() {
    pip_failing("offline", r"could not reach pypi\.org").await;
}

#[tokio::test]
async fn pip_failing_no_wheel_is_said_in_plain_words_the_status_shows_it_and_a_retry_works() {
    pip_failing("no-wheel", r"no ready-made build of ctranslate2").await;
}

#[tokio::test]
async fn faster_whisper_installed_but_the_model_s_download_failing_ready_with_the_error_on_that_model_s_row() {
    let w = world();
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.4" } } }));
    let host = w.host(vec![(
        w.models.url("base.en", "model.bin"),
        Route::body(random_bytes(20_000)),
    )]);
    let (result, _) = watch(&w.t, start_stt_install(&w.t, w.opts(&host)).unwrap()).await;
    assert!(!result.ok);
    let error = result.error.unwrap();
    assert!(
        error.contains("faster-whisper is installed, but downloading the base.en model failed"),
        "{error}"
    );
    let s = get_stt_status(&w.t, false, None).await;
    assert_eq!(s.runtime.state, "ready");
    let base = model(&s, "base.en");
    assert_eq!(base.state, "failed");
    assert!(base.error.as_deref().unwrap().contains("sha256"), "{:?}", base.error);
}

#[tokio::test]
async fn a_download_of_python_that_fails_is_not_silent_either() {
    let w = world();
    let host = w.host(vec![(w.gh.dl.clone(), Route::body(w.gh.archive.clone()).fail_at(10))]);
    let (result, _) = watch(&w.t, start_stt_install(&w.t, w.opts(&host)).unwrap()).await;
    assert!(!result.ok);
    let error = result.error.unwrap();
    assert!(error.contains("Python"), "{error}");
    assert!(error.contains("cut off"), "{error}");
    assert_eq!(get_stt_status(&w.t, true, None).await.runtime.state, "failed");
}

// ── models: Download and Delete ──────────────────────────────────────────

#[tokio::test]
async fn downloads_one_with_progress_then_deletes_it() {
    let w = world();
    let host = w.host(vec![]);
    let job = start_model_download(&w.t, "small", w.opts(&host)).unwrap();
    assert_eq!(job.job.kind, "model");
    assert_eq!(job.job.model.as_deref(), Some("small"));
    let during = get_stt_status(&w.t, false, None).await;
    assert_eq!(model(&during, "small").state, "downloading");
    let (result, seen) = watch(&w.t, job).await;
    assert!(result.ok, "{:?}", result.error);
    assert!(seen.len() > 2 && seen.iter().any(|j| j.percent > 0 && j.percent < 100), "{seen:?}");
    let s = get_stt_status(&w.t, false, None).await;
    let small = model(&s, "small");
    let folder = w.t.path().join("data").join("whisper-models").join("small");
    assert_eq!(small.state, "downloaded");
    assert!(small.deletable);
    assert_eq!(small.where_.as_deref(), Some(folder.to_string_lossy().as_ref()));

    let r = remove_stt_model(&w.t, "small").unwrap();
    assert_eq!(r.removed, [folder]);
    let s = get_stt_status(&w.t, false, None).await;
    assert_eq!(model(&s, "small").state, "missing");
}

#[tokio::test]
async fn a_model_download_that_fails_its_hash_shows_the_error_on_that_model() {
    let w = world();
    let host = w.host(vec![(w.models.url("tiny", "model.bin"), Route::body(random_bytes(20_000)))]);
    let (result, _) = watch(&w.t, start_model_download(&w.t, "tiny", w.opts(&host)).unwrap()).await;
    assert!(!result.ok);
    assert!(result.error.as_deref().unwrap().contains("sha256"));
    let s = get_stt_status(&w.t, false, None).await;
    let tiny = model(&s, "tiny");
    assert_eq!(tiny.state, "failed");
    assert!(tiny.error.as_deref().unwrap().contains("sha256"));
}

#[tokio::test]
async fn one_job_at_a_time_a_second_kind_of_job_is_turned_away_asking_for_the_same_one_again_gets_the_running_one() {
    let w = world();
    let host = w.host(vec![(
        w.models.url("small.en", "model.bin"),
        Route::body(w.models.file("small.en", "model.bin")).chunk(500).delay_ms(3),
    )]);
    let a = start_model_download(&w.t, "small.en", w.opts(&host)).unwrap();
    let same = start_model_download(&w.t, "small.en", w.opts(&host)).unwrap();
    assert_eq!(same.job.started_at, a.job.started_at);
    let busy = start_model_download(&w.t, "tiny.en", w.opts(&host)).err().unwrap();
    assert_eq!((busy.code.as_deref(), busy.status), (Some("BUSY"), Some(409)));
    assert!(busy.message.contains("small.en"), "{busy}");
    let busy = start_stt_install(&w.t, w.opts(&host)).err().unwrap();
    assert_eq!(busy.code.as_deref(), Some("BUSY"));
    a.done.wait().await;
    assert_eq!(stt_job(&w.t), None);
    assert!(!w.t.path().join("python").join(".install.lock").exists(), "the lock is let go");
}

#[tokio::test]
async fn an_unknown_model_name_is_refused() {
    let w = world();
    let host = w.host(vec![]);
    assert_eq!(
        start_model_download(&w.t, "../../etc", w.opts(&host)).err().unwrap().status,
        Some(400)
    );
    assert_eq!(remove_stt_model(&w.t, "large-v3").unwrap_err().status, Some(400));
}

// ── Added ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_status_has_every_field_the_settings_page_reads() {
    let w = world();
    let s = serde_json::to_value(get_stt_status(&w.t, true, None).await).unwrap();
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(
        keys(&s),
        ["provider", "current", "runtime", "models", "modelsDir", "bundledDirs", "job"]
    );
    assert_eq!(
        keys(&s["runtime"]),
        [
            "state", "ready", "summary", "fasterWhisper", "python", "source", "where", "installFolder",
            "needsPythonDownload", "canInstall", "downloadMB", "error", "version", "platform"
        ]
    );
    assert_eq!(s["provider"], "local");
    assert_eq!(s["runtime"]["downloadMB"], 147);
    assert_eq!(
        s["runtime"]["summary"],
        "Not installed, and there is no Python on this computer. Install downloads Tarsee's own copy of Python (about 47 MB) and faster-whisper (about 100 MB) into Tarsee's folder."
    );
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.4", "executable": "/usr/bin/python3" } } }));
    let s = get_stt_status(&w.t, true, None).await;
    assert_eq!(
        s.runtime.summary,
        "Not installed. Install sets faster-whisper up in Tarsee's own folder, using Python 3.11.4 (/usr/bin/python3): about 100 MB to download."
    );
    let python = s.runtime.python.unwrap();
    assert_eq!((python.label.as_str(), python.source.as_deref()), ("python3", Some("system")));
    assert_eq!(s.runtime.download_mb, 100);
}

#[tokio::test]
async fn a_python_named_in_tarsee_stt_python_is_the_one_used_or_said_to_be_missing() {
    let w = world();
    w.t.env().set("TARSEE_STT_PYTHON", " python3 ");
    let s = get_stt_status(&w.t, true, None).await;
    assert_eq!(s.runtime.summary, "Not ready: TARSEE_STT_PYTHON (python3) was not found.");
    assert!(!s.runtime.can_install);
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.4" } } }));
    let s = get_stt_status(&w.t, true, None).await;
    assert_eq!(s.runtime.summary, "Not ready: TARSEE_STT_PYTHON (python3) can't load faster-whisper.");
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.4", "packages": { "faster-whisper": "1.2.1" } } } }));
    let s = get_stt_status(&w.t, true, None).await;
    assert_eq!(s.runtime.source.as_deref(), Some("custom"));
    let boot = tarsee::voice::stt_install::stt_boot_line(&w.t, None).await;
    assert!(
        boot.starts_with("[stt] speech-to-text (local): ready, faster-whisper 1.2.1 on Python 3.11.4, no model on disk yet (base.en downloads on first use)"),
        "{boot}"
    );
}
