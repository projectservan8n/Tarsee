//! test/stt-local.test.js: local speech-to-text end to end (src/voice/stt_handler.rs): a short WAV goes to the
//! persistent faster-whisper worker (stt_worker.py's protocol, spoken here by a fake Python) running on the Python
//! stt_install found, with a model folder on disk, and comes back as text. The worker stays warm between recordings,
//! comes back after a crash, is stopped when it hangs, and when the chosen model isn't downloaded the closest one
//! transcribes while the chosen one downloads. This is the API a call uses: transcribe_audio, and POST
//! /api/voice/transcribe on top of it.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tarsee::testkit::fake_download_host::FakeDownloadHost;
use tarsee::testkit::{MemorySettings, tmp_dir};
use tarsee::voice::python_runtime::set_for_tests as set_python;
use tarsee::voice::stt_handler::{SttTestOverrides, SttWorker, set_for_tests, transcribe_audio, warm_stt};
use tarsee::voice::stt_install::{reset_stt_runtime, set_for_tests as set_catalog, stt_job};
use tempfile::TempDir;

use crate::fake_python::{FakePython, cand};
use crate::voice_fixtures::{Models, VoiceApp, models, voice_app, wav, worker_requests, worker_starts};

struct World {
    t: VoiceApp,
    py: FakePython,
    models: Models,
    _fake: TempDir,
}

fn world() -> World {
    let t = voice_app(&[]);
    let fake = tmp_dir();
    let py = FakePython::new(
        fake.path(),
        json!({
            "pythons": { "python3": { "version": "3.11.2", "packages": { "faster-whisper": "1.2.1" } } },
            "worker": { "mode": "ok" },
        }),
    );
    set_python(&t, py.overrides(vec![cand("python3", &[])]));
    let models = models(|_| 5_000, |_| "{}\n".to_string());
    set_catalog(&t, Some(models.catalog.clone()));
    World {
        t,
        py,
        models,
        _fake: fake,
    }
}

impl World {
    fn models_dir(&self) -> PathBuf {
        self.t.path().join("data").join("whisper-models")
    }

    fn put(&self, name: &str) {
        self.models.put(&self.models_dir(), name);
    }

    fn requests(&self) -> Vec<Value> {
        worker_requests(&self.py.calls())
    }

    fn starts(&self) -> usize {
        worker_starts(&self.py.calls())
    }

    async fn until_idle(&self) {
        while stt_job(&self.t).is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn store(values: &[(&str, &str)]) -> MemorySettings {
    MemorySettings::from_pairs(values.iter().map(|(k, v)| (k.to_string(), json!(v))))
}

#[tokio::test]
async fn transcribes_a_short_wav_with_the_model_folder_and_english_for_an_english_only_model_the_worker_stays_warm() {
    let w = world();
    w.put("base.en");
    let out = transcribe_audio(&w.t, &wav(500), Some("en-US"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(out.transcript, "hello from a wav");
    assert_eq!(out.provider, "faster-whisper (base.en)");
    assert_eq!(out.language, "en");
    let req = w.requests()[0].clone();
    assert_eq!(
        PathBuf::from(req["model"].as_str().unwrap()),
        w.models_dir().join("base.en"),
        "a folder on disk, never a model name"
    );
    assert_eq!(req["language"], "en");
    let audio = req["audio"].as_str().unwrap();
    assert!(audio.ends_with(".wav"), "{audio}");
    assert!(!PathBuf::from(audio).exists(), "the recording's temporary file is removed");
    assert!(PathBuf::from(audio).starts_with(w.t.tmp.path()), "in the temporary folder");

    transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(w.starts(), 1, "one worker for both recordings");
}

#[tokio::test]
async fn a_model_for_many_languages_finds_the_language_itself() {
    let w = world();
    w.put("small");
    let out = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[("voice.stt_model", "small")])))
        .await
        .unwrap();
    assert_eq!(out.provider, "faster-whisper (small)");
    assert_eq!(w.requests()[0]["language"], Value::Null);
}

#[tokio::test]
async fn the_chosen_model_not_downloaded_the_closest_one_on_disk_transcribes_and_the_chosen_one_downloads() {
    let w = world();
    w.put("base.en");
    let host = FakeDownloadHost::new(
        w.models
            .files("small.en")
            .iter()
            .map(|(n, b)| (w.models.url("small.en", n), tarsee::testkit::fake_download_host::Route::body(b.clone()))),
    );
    w.t.app.set_fetch(host.clone());
    let settings = store(&[("voice.stt_model", "small.en")]);
    let out = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&settings))
        .await
        .unwrap();
    assert_eq!(out.provider, "faster-whisper (base.en)");
    w.until_idle().await;
    assert!(
        host.hits(&w.models.url("small.en", "model.bin")) >= 1,
        "small.en was downloaded"
    );
    let again = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&settings))
        .await
        .unwrap();
    assert_eq!(again.provider, "faster-whisper (small.en)");
}

#[tokio::test]
async fn no_model_on_disk_at_all_a_503_that_says_one_is_downloading() {
    let w = world();
    w.t.app.set_fetch(FakeDownloadHost::new(Vec::<(String, _)>::new()));
    let err = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap_err();
    assert_eq!(err.status, Some(503));
    assert_eq!(err.code.as_deref(), Some("stt-unavailable"), "channels pass this message on");
    assert!(err.message.contains("downloading base.en"), "{err}");
    w.until_idle().await;
}

#[tokio::test]
async fn a_model_whose_download_just_failed_isn_t_downloaded_again_on_every_recording() {
    let w = world();
    let host = FakeDownloadHost::new(Vec::<(String, _)>::new());
    w.t.app.set_fetch(host.clone());
    let err = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap_err();
    assert!(err.message.contains("downloading base.en"), "{err}");
    w.until_idle().await;
    let asked = host.requests().len();
    assert!(asked > 0);
    let err = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap_err();
    assert_eq!(err.status, Some(503));
    assert!(
        err.message.contains("Download one in Settings > Voice > Speech-to-text"),
        "{err}"
    );
    assert_eq!(host.requests().len(), asked, "not tried again straight away");
}

#[tokio::test]
async fn faster_whisper_not_installed_a_501_that_says_where_to_install_it() {
    let w = world();
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.2" } } }));
    w.put("base.en");
    let err = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap_err();
    assert_eq!(err.status, Some(501));
    assert!(err.message.contains("not installed"));
    assert!(err.message.contains("Settings > Voice > Speech-to-text"));
}

#[tokio::test]
async fn a_worker_that_crashes_is_started_again_for_the_next_recording() {
    let w = world();
    w.put("base.en");
    w.py.set(json!({ "worker": { "mode": "crash" } }));
    let err = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap_err();
    assert_eq!((err.code.as_deref(), err.status), (Some("stt-failed"), Some(500)), "{err}");
    w.py.set(json!({ "worker": { "mode": "ok" } }));
    let out = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(out.transcript, "hello from a wav");
    assert_eq!(w.starts(), 2);
}

#[tokio::test]
async fn a_worker_that_hangs_is_stopped_after_the_time_limit_and_the_next_recording_gets_a_fresh_one() {
    let w = world();
    w.put("base.en");
    set_for_tests(
        &w.t,
        SttTestOverrides {
            timeout_ms: Some(400),
            ..Default::default()
        },
    );
    w.py.set(json!({ "worker": { "mode": "hang" } }));
    let t0 = Instant::now();
    let err = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap_err();
    assert_eq!(err.code.as_deref(), Some("stt-failed"));
    assert!(t0.elapsed() < Duration::from_secs(5));
    w.py.set(json!({ "worker": { "mode": "ok" } }));
    let out = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(out.transcript, "hello from a wav");
}

#[tokio::test]
async fn warm_stt_loads_the_model_ahead_of_the_first_recording_a_call_opening() {
    let w = world();
    w.put("base.en");
    assert_eq!(warm_stt(&w.t, Some(&store(&[]))).await, json!({ "ok": true, "model": "base.en" }));
    assert_eq!(w.starts(), 1);
    transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(w.starts(), 1, "the warm worker answers");
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.2" } } }));
    reset_stt_runtime(&w.t);
    let cold = warm_stt(&w.t, Some(&store(&[]))).await;
    assert_eq!(cold["ok"], false);
    assert!(cold["error"].as_str().unwrap().contains("not installed"));
}

#[tokio::test]
async fn an_idle_worker_stops_by_itself_to_give_its_memory_back() {
    let w = world();
    w.put("base.en");
    set_for_tests(
        &w.t,
        SttTestOverrides {
            idle_ms: Some(100),
            ..Default::default()
        },
    );
    transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    let worker = SttWorker::of(&w.t);
    let deadline = Instant::now() + Duration::from_secs(10);
    while worker.is_running() {
        assert!(Instant::now() < deadline, "the idle worker was never stopped");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(w.starts(), 2, "stopped while idle, started again when needed");
}

// ── Added ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_worker_whose_python_cannot_load_faster_whisper_says_so_and_the_process_is_gone_with_the_app() {
    let w = world();
    w.put("base.en");
    // The probe sees faster-whisper, but the worker says it did not start.
    w.py.set(json!({ "worker": { "mode": "ok" } }));
    let out = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(out.transcript, "hello from a wav");
    let worker = SttWorker::of(&w.t);
    assert!(worker.is_running());
    assert_eq!(worker.version().as_deref(), Some("1.2.1"));
    tarsee::voice::stt_handler::stop_stt_worker(&w.t);
    assert!(!worker.is_running());
}
