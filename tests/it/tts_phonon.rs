//! test/tts-phonon.test.js, "Phonon's Python runtime" (the one speech-to-text uses, src/voice/python_runtime.rs) and
//! "Phonon worker (real)". The other cases of that file are unit tests in src/voice/engine_registry, phonon_engine and
//! phonon_install.
//!
//! Added: the Phonon worker's protocol against a stand-in for phonon_worker.py (the `fake-phonon` role): a line
//! spoken, the worker kept warm, a worker that fails to start, crashes or answers an error, and the process ended
//! when the worker is stopped or the app goes away.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tarsee::testkit::fake_download_host::{FakeDownloadHost, Route};
use tarsee::testkit::tmp_dir;
use tarsee::voice::phonon_engine::{
    PhononOptions, PhononTtsEngine, PhononWorker, phonon_installed, phonon_paths, stop_phonon_worker,
};
use tarsee::voice::phonon_install::{
    InstallOptions, PTTS_VERSION, PhononFile, PhononModel, PhononVoices, check_phonon_install,
    get_phonon_install_status, hf_url, install_phonon,
};
use tarsee::voice::python_runtime::{
    interpreter_in, set_for_tests as set_python, standalone_dir, standalone_ready, venv_interpreter,
};
use tarsee::voice::tts_interface::{SynthOptions, TtsEngine};
use tempfile::TempDir;

use crate::fake_python::{FakePython, cand};
use crate::support::testbin_as;
use crate::voice_fixtures::{VoiceApp, standalone, voice_app};

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn model() -> PhononModel {
    PhononModel {
        repo: "test/model".into(),
        revision: "rev1".into(),
        files: vec![
            PhononFile {
                name: "config.json".into(),
                sha256: None,
            },
            PhononFile {
                name: "model.q8.gguf".into(),
                sha256: Some(sha(b"weights")),
            },
        ],
    }
}

fn voices() -> PhononVoices {
    PhononVoices {
        repo: "test/voices".into(),
        revision: "rev2".into(),
        language: "en".into(),
        locales: vec!["en-us".into(), "en-gb".into()],
    }
}

/// The fake Hugging Face's files.
fn hub_routes() -> Vec<(String, Route)> {
    let (m, v) = (model(), voices());
    let list = [
        json!({ "name": "Toby", "filename": "voices/toby.safetensors", "language": "en", "locale": "en-gb" }),
        json!({ "name": "Zoey", "filename": "voices/zoey.safetensors", "language": "en", "locale": "en-us" }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    vec![
        (hf_url(&m.repo, &m.revision, "config.json"), Route::body("{}")),
        (hf_url(&m.repo, &m.revision, "model.q8.gguf"), Route::body("weights")),
        (hf_url(&v.repo, &v.revision, "voices.jsonl"), Route::body(list)),
        (
            hf_url(&v.repo, &v.revision, "voices/toby.safetensors"),
            Route::body("toby"),
        ),
        (
            hf_url(&v.repo, &v.revision, "voices/zoey.safetensors"),
            Route::body("zoey"),
        ),
        (hf_url(&v.repo, &v.revision, "README.md"), Route::body("# voices")),
    ]
}

/// The smoke test passes, nothing is logged, retries are quick; the real Python runtime step runs.
fn smoke(host: &Arc<FakeDownloadHost>) -> InstallOptions {
    InstallOptions {
        fetch: Some(host.clone()),
        model: Some(model()),
        voices: Some(voices()),
        retry_delay_ms: Some(1),
        smoke_test: Some(Arc::new(|_, _| async { Ok("ok".to_string()) }.boxed())),
        log: Some(Arc::new(|_: &str| {})),
        ..Default::default()
    }
}

struct World {
    t: VoiceApp,
    py: FakePython,
    _fake: TempDir,
}

fn world(scenario: Value, candidates: Vec<tarsee::voice::python_runtime::PythonRef>) -> World {
    let t = voice_app(&[]);
    let dir = t.path().join("phonon-py");
    std::fs::create_dir_all(&dir).unwrap();
    t.env().set("TARSEE_PHONON_DIR", dir.to_string_lossy().to_string());
    let fake = tmp_dir();
    let py = FakePython::new(fake.path(), scenario);
    set_python(&t, py.overrides(candidates));
    World { t, py, _fake: fake }
}

fn call_with<'a>(calls: &'a [Value], arg: &str) -> &'a Value {
    calls
        .iter()
        .find(|c| c["args"].as_array().is_some_and(|a| a.iter().any(|x| x == arg)))
        .unwrap_or_else(|| panic!("no call with {arg}: {calls:?}"))
}

fn args_of(call: &Value) -> Vec<String> {
    serde_json::from_value(call["args"].clone()).unwrap()
}

// ── Phonon's Python: the one speech-to-text uses ─────────────────────────

#[tokio::test]
async fn the_venv_s_python_is_where_this_os_puts_it_scripts_python_exe_on_windows() {
    let w = world(json!({}), vec![]);
    let p = phonon_paths(&w.t);
    assert_eq!(p.venv_python, venv_interpreter(&p.venv));
}

#[tokio::test]
async fn no_python3_with_ptts_the_venv_is_made_from_the_python_found_here_the_py_launcher_on_windows_and_pip_installs_the_pinned_ptts_from_pypi_org_only()
 {
    let w = world(
        json!({ "pythons": { "py -3.12": { "version": "3.12.1" } }, "pip": { "mode": "ok", "delayMs": 1 } }),
        vec![cand("py", &["-3.12"])],
    );
    let host = FakeDownloadHost::new(hub_routes());
    let status = install_phonon(&w.t, smoke(&host)).await.unwrap();
    assert_eq!(status.state, "installed");
    let p = phonon_paths(&w.t);
    assert_eq!(p.python, p.venv_python.to_string_lossy(), "Phonon now runs on its venv");
    let calls = w.py.calls();
    let venv = call_with(&calls, "venv");
    assert_eq!(venv["cmd"], "py");
    let venv_args = args_of(venv);
    assert_eq!(venv_args[..1], ["-3.12"]);
    assert_eq!(PathBuf::from(venv_args.last().unwrap()), p.venv);
    let pip = call_with(&calls, "install");
    assert_eq!(PathBuf::from(pip["cmd"].as_str().unwrap()), p.venv_python);
    let pip_args = args_of(pip);
    assert!(pip_args.contains(&format!("ptts=={PTTS_VERSION}")));
    for flag in ["--isolated", "--only-binary=:all:"] {
        assert!(pip_args.iter().any(|a| a == flag), "{flag}");
    }
    let at = pip_args.iter().position(|a| a == "--index-url").unwrap();
    assert_eq!(pip_args[at + 1], "https://pypi.org/simple");
    assert_eq!(check_phonon_install(&w.t).await.state, "installed");
}

#[tokio::test]
async fn no_python_at_all_the_background_install_on_boot_fails_in_plain_words_install_a_click_downloads_tarsee_s_own_python_first()
 {
    let w = world(
        json!({ "pythons": {}, "pip": { "mode": "ok", "delayMs": 1 } }),
        vec![cand("python3", &[])],
    );
    let err = install_phonon(&w.t, smoke(&FakeDownloadHost::new(hub_routes())))
        .await
        .unwrap_err();
    assert!(err.message.contains("No Python 3.9 or newer"), "{err}");
    assert!(
        !err.message.contains("python3 was not found") && !err.message.contains("ENOENT"),
        "{err}"
    );
    assert_eq!(get_phonon_install_status(&w.t).state, "failed");

    let gh = standalone();
    let mut routes = gh.routes();
    routes.extend(hub_routes());
    let host = FakeDownloadHost::new(routes);
    let opts = InstallOptions {
        allow_python_download: true,
        pin: Some(gh.pin.clone()),
        ..smoke(&host)
    };
    let status = install_phonon(&w.t, opts).await.unwrap();
    assert_eq!(status.state, "installed");
    assert!(
        standalone_ready(w.t.config(), &gh.pin),
        "Tarsee's own Python, shared with speech-to-text"
    );
    let calls = w.py.calls();
    assert_eq!(
        PathBuf::from(call_with(&calls, "venv")["cmd"].as_str().unwrap()),
        interpreter_in(&standalone_dir(w.t.config(), &gh.pin))
    );
}

// ── Phonon worker (real) ─────────────────────────────────────────────────

/// Runs only by hand, where Phonon is really installed: `TARSEE_PHONON_DIR=<folder> cargo test --test it -- --ignored
/// speaks_a_line_through_the_real_worker`.
#[tokio::test]
#[ignore = "needs a real Phonon install (TARSEE_PHONON_DIR) and its Python"]
async fn speaks_a_line_through_the_real_worker_and_stops_cleanly() {
    let real = std::env::var("TARSEE_PHONON_DIR").expect("TARSEE_PHONON_DIR names a real install");
    let path = std::env::var("PATH").unwrap_or_default();
    let t = voice_app(&[("TARSEE_PHONON_DIR", &real), ("PATH", &path)]);
    assert!(phonon_installed(&phonon_paths(&t)), "Phonon is not installed in {real}");
    let tts = PhononTtsEngine::new(&t, Some("toby"), PhononOptions::default());
    assert!(tts.is_available().await);
    let out = tts
        .synthesize(
            "On it. That is ₱2,500.",
            Some("en-US-AndrewMultilingualNeural"),
            &SynthOptions::default(),
        )
        .await;
    tts.stop();
    let out = out.unwrap();
    assert_eq!(out.content_type, "audio/wav");
    assert_eq!(&out.audio[..4], b"RIFF");
    assert!(
        out.audio.len() > 24_000,
        "a second or more of 24 kHz audio ({} bytes)",
        out.audio.len()
    );
}

// ── Added: the worker's protocol, against a stand-in ─────────────────────

struct Worker {
    t: VoiceApp,
    log: PathBuf,
    _bin: TempDir,
}

/// A finished install (the files the check looks for) whose Python is the `fake-phonon` stand-in.
fn installed(mode: &str) -> Worker {
    let bin = tmp_dir();
    let python = testbin_as(bin.path(), "fake-phonon");
    let log = bin.path().join("phonon.jsonl");
    let t = voice_app(&[
        ("TARSEE_PHONON_PYTHON", python.to_string_lossy().as_ref()),
        ("FAKE_PHONON_LOG", log.to_string_lossy().as_ref()),
        ("FAKE_PHONON_MODE", mode),
        ("TARSEE_PHONON_THREADS", "2"),
    ]);
    let dir = t.path().join("phonon");
    t.env().set("TARSEE_PHONON_DIR", dir.to_string_lossy().to_string());
    let p = phonon_paths(&t);
    for (file, body) in [
        (p.model.join("config.json"), "{}"),
        (p.model.join("model.q8.gguf"), "weights"),
        (p.catalog.join("voices.jsonl"), "{}\n"),
        (p.marker.clone(), "{}"),
    ] {
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, body).unwrap();
    }
    Worker { t, log, _bin: bin }
}

impl Worker {
    fn lines(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn starts(&self) -> Vec<u32> {
        self.lines()
            .iter()
            .filter_map(|l| l["start"].as_u64().map(|p| p as u32))
            .collect()
    }

    fn requests(&self) -> Vec<Value> {
        self.lines().iter().filter_map(|l| l.get("request").cloned()).collect()
    }

    fn engine(&self) -> PhononTtsEngine {
        PhononTtsEngine::new(&self.t, Some("toby"), PhononOptions::default())
    }
}

/// Whether a process with this id is running.
fn alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }
}

async fn until_gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while alive(pid) {
        assert!(Instant::now() < deadline, "the worker process {pid} is still running");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn tmp_files(t: &VoiceApp) -> Vec<String> {
    std::fs::read_dir(t.tmp.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect()
}

#[tokio::test]
async fn a_line_is_spoken_by_the_worker_which_stays_warm_and_ends_when_stopped() {
    let w = installed("ok");
    // It would carry on with its input closed: only a kill ends it.
    w.t.env().set("FAKE_PHONON_LINGER", "1");
    let tts = w.engine();
    assert!(tts.is_available().await);
    let out = tts
        .synthesize(
            "On it. That is ₱2,500.",
            Some("en-US-AndrewMultilingualNeural"),
            &SynthOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(out.content_type, "audio/wav");
    assert_eq!(out.audio.len(), 24_044);
    let req = &w.requests()[0];
    assert_eq!(req["text"], "On it. That is 2,500 pesos.");
    assert_eq!(req["voice"], "Toby", "another engine's voice id: Phonon's default");
    assert_eq!(req["duration_delta"], json!(0));
    assert!(Path::new(req["out"].as_str().unwrap()).starts_with(w.t.tmp.path()));
    assert!(tmp_files(&w.t).is_empty(), "the wav is removed");
    let start = &w.lines()[0];
    assert_eq!(
        (start["threads"].clone(), start["offline"].clone()),
        (json!("2"), json!("1"))
    );

    tts.set_speed(1.1);
    tts.synthesize("Faster.", Some("Zoey"), &SynthOptions::default())
        .await
        .unwrap();
    tts.synthesize("Fastest.", None, &SynthOptions { speed: Some(9.0) })
        .await
        .unwrap();
    let reqs = w.requests();
    assert_eq!(
        (reqs[1]["voice"].clone(), reqs[1]["duration_delta"].clone()),
        (json!("Zoey"), json!(-0.15))
    );
    assert_eq!(reqs[2]["duration_delta"], json!(-0.45));
    let starts = w.starts();
    assert_eq!(starts.len(), 1, "one worker for every line");
    assert!(PhononWorker::of(&w.t).is_ready());
    assert_eq!(PhononWorker::of(&w.t).device(), "cpu");

    tts.stop();
    assert!(!PhononWorker::of(&w.t).is_running());
    until_gone(starts[0]).await;
}

#[tokio::test]
async fn the_worker_process_ends_when_the_app_goes_away() {
    let w = installed("ok");
    // It would carry on with its input closed: only a kill ends it.
    w.t.env().set("FAKE_PHONON_LINGER", "1");
    let tts = w.engine();
    tts.synthesize("Hello.", None, &SynthOptions::default()).await.unwrap();
    let pid = w.starts()[0];
    assert!(alive(pid));
    let Worker { t, log: _, _bin } = w;
    drop(t);
    until_gone(pid).await;
    assert!(
        tts.synthesize("Anyone?", None, &SynthOptions::default()).await.is_err(),
        "the engine outlived its app"
    );
}

#[tokio::test]
async fn a_worker_that_cannot_start_says_why_and_warm_fails_too() {
    let w = installed("fail-start");
    let tts = w.engine();
    let err = tts
        .synthesize("Hello.", None, &SynthOptions::default())
        .await
        .unwrap_err();
    assert_eq!(err.message, "Phonon worker never became ready: no model in /models");
    let err = installed("fail-start").engine().warm().await.unwrap_err();
    assert_eq!(err.message, "Phonon worker did not start");
}

#[tokio::test]
async fn a_worker_that_crashes_fails_that_line_and_the_next_line_gets_a_fresh_one() {
    let w = installed("crash");
    let tts = w.engine();
    let err = tts
        .synthesize("Hello.", None, &SynthOptions::default())
        .await
        .unwrap_err();
    assert!(err.message.starts_with("Phonon worker died (code=3 signal="), "{err}");
    w.t.env().set("FAKE_PHONON_MODE", "ok");
    tts.synthesize("Again.", None, &SynthOptions::default()).await.unwrap();
    assert_eq!(w.starts().len(), 2);
}

#[tokio::test]
async fn an_error_from_the_worker_is_the_line_s_error_and_the_worker_stays() {
    let w = installed("error");
    let tts = w.engine();
    for _ in 0..2 {
        let err = tts
            .synthesize("Hello.", None, &SynthOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.message, "boom");
    }
    assert_eq!(w.starts().len(), 1);
    stop_phonon_worker(&w.t);
}

#[tokio::test]
async fn without_ptts_the_install_is_not_available() {
    let w = installed("ok");
    w.t.env().set("FAKE_PHONON_NO_PTTS", "1");
    assert!(!w.engine().is_available().await);
    let st = check_phonon_install(&w.t).await;
    assert_eq!(st.state, "failed");
}
