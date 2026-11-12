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
use tarsee::voice::python_runtime::PythonRef;
use tarsee::voice::stt_handler::{SttTestOverrides, SttWorker, set_for_tests, stop_stt_worker, transcribe_audio, warm_stt};
use tarsee::voice::stt_install::{ReadyRuntime, reset_stt_runtime, set_for_tests as set_catalog, stt_job};
use tempfile::TempDir;

use crate::fake_python::{FakePython, cand};
use crate::support::testbin_as;
use crate::voice_fixtures::{Models, VoiceApp, alive, models, until_gone, voice_app, wav, worker_requests, worker_starts};

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

    /// What is left in the temporary folder.
    fn tmp_files(&self) -> Vec<String> {
        std::fs::read_dir(self.t.tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect()
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
    assert!(
        !PathBuf::from(audio).exists(),
        "the recording's temporary file is removed"
    );
    assert!(
        PathBuf::from(audio).starts_with(w.t.tmp.path()),
        "in the temporary folder"
    );

    transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(w.starts(), 1, "one worker for both recordings");
}

#[tokio::test]
async fn a_model_for_many_languages_finds_the_language_itself() {
    let w = world();
    w.put("small");
    let out = transcribe_audio(
        &w.t,
        &wav(500),
        Some("en"),
        Some(&store(&[("voice.stt_model", "small")])),
    )
    .await
    .unwrap();
    assert_eq!(out.provider, "faster-whisper (small)");
    assert_eq!(w.requests()[0]["language"], Value::Null);
}

#[tokio::test]
async fn the_chosen_model_not_downloaded_the_closest_one_on_disk_transcribes_and_the_chosen_one_downloads() {
    let w = world();
    w.put("base.en");
    let host = FakeDownloadHost::new(w.models.files("small.en").iter().map(|(n, b)| {
        (
            w.models.url("small.en", n),
            tarsee::testkit::fake_download_host::Route::body(b.clone()),
        )
    }));
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
    assert_eq!(
        err.code.as_deref(),
        Some("stt-unavailable"),
        "channels pass this message on"
    );
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
        err.message
            .contains("Download one in Settings > Voice > Speech-to-text"),
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
    assert_eq!(
        (err.code.as_deref(), err.status),
        (Some("stt-failed"), Some(500)),
        "{err}"
    );
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
    let err = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap_err();
    assert_eq!(err.code.as_deref(), Some("stt-failed"));
    w.py.set(json!({ "worker": { "mode": "ok" } }));
    let out = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(out.transcript, "hello from a wav");
    assert_eq!(w.starts(), 2, "the stuck worker was stopped, and a fresh one answered");
}

#[tokio::test]
async fn warm_stt_loads_the_model_ahead_of_the_first_recording_a_call_opening() {
    let w = world();
    w.put("base.en");
    assert_eq!(
        warm_stt(&w.t, Some(&store(&[]))).await,
        json!({ "ok": true, "model": "base.en" })
    );
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
    let deadline = Instant::now() + Duration::from_secs(120);
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

/// The `fake-phonon` stand-in as the Python of a speech-to-text runtime: it speaks `stt_worker.py`'s protocol, logs
/// its pid, and (with FAKE_PHONON_LINGER) keeps running after its input closes, so only a kill ends it.
struct Stand {
    t: VoiceApp,
    rt: ReadyRuntime,
    log: PathBuf,
    _bin: TempDir,
}

fn stand_in(extra: &[(&str, &str)]) -> Stand {
    let bin = tmp_dir();
    let python = testbin_as(bin.path(), "fake-phonon");
    let log = bin.path().join("stt.jsonl");
    let mut env = vec![("FAKE_PHONON_LOG", log.to_string_lossy().to_string())];
    env.extend(extra.iter().map(|(k, v)| (*k, v.to_string())));
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let t = voice_app(&env);
    let rt = ReadyRuntime {
        python: PythonRef::new(python.to_string_lossy()),
        label: "fake".into(),
        version: Some("3.12.1".into()),
        executable: None,
        faster_whisper: "1.2.1".into(),
        source: "custom",
    };
    Stand { t, rt, log, _bin: bin }
}

impl Stand {
    fn starts(&self) -> Vec<u32> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok()?["start"].as_u64())
            .map(|p| p as u32)
            .collect()
    }

    async fn transcribe(&self) -> Result<Value, String> {
        let audio = self.t.tmp.path().join("a.wav");
        std::fs::write(&audio, b"RIFF").unwrap();
        let mut req = serde_json::Map::new();
        req.insert("audio".into(), json!(audio.to_string_lossy()));
        req.insert("model".into(), json!("/models/base.en"));
        let out = SttWorker::of(&self.t)
            .transcribe(&self.t, &self.rt, req, Duration::from_secs(120))
            .await;
        let _ = std::fs::remove_file(&audio);
        out
    }
}

#[tokio::test]
async fn a_worker_whose_python_cannot_load_faster_whisper_says_so() {
    let s = stand_in(&[("FAKE_PHONON_MODE", "fail-start")]);
    let err = s.transcribe().await.unwrap_err();
    assert_eq!(
        err,
        "faster-whisper did not start: ModuleNotFoundError: No module named 'faster_whisper'"
    );
}

#[tokio::test]
async fn the_worker_process_ends_when_it_is_stopped_and_when_the_app_goes_away() {
    let s = stand_in(&[("FAKE_PHONON_LINGER", "1")]);
    let out = s.transcribe().await.unwrap();
    assert_eq!(out["text"], "heard 4 bytes");
    assert_eq!(SttWorker::of(&s.t).version().as_deref(), Some("1.2.1"));
    let first = s.starts()[0];
    assert!(alive(first));
    stop_stt_worker(&s.t);
    until_gone(first).await;

    s.transcribe().await.unwrap();
    let second = s.starts()[1];
    assert!(alive(second));
    let Stand { t, .. } = s;
    drop(t);
    until_gone(second).await;
}

#[tokio::test]
async fn a_transcription_whose_caller_goes_away_leaves_no_recording_and_the_worker_still_stops_when_idle() {
    let w = world();
    w.put("base.en");
    set_for_tests(
        &w.t,
        SttTestOverrides {
            idle_ms: Some(300),
            ..Default::default()
        },
    );
    // Each answer takes a while, so a caller can go away in the middle of one.
    w.py.set(json!({ "worker": { "mode": "ok", "delayMs": 300 } }));
    for after in [Duration::ZERO, Duration::from_millis(50), Duration::from_millis(400)] {
        // Not a WAV: the fake hears it as "hello from the fake".
        let settings = store(&[]);
        let leaving = transcribe_audio(&w.t, b"OggS not a wav", Some("en"), Some(&settings));
        tokio::pin!(leaving);
        if after.is_zero() {
            let _ = futures::poll!(&mut leaving);
        } else {
            let _ = tokio::time::timeout(after, &mut leaving).await;
        }
        drop(leaving);
        let out = transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
            .await
            .unwrap();
        assert_eq!(out.transcript, "hello from a wav", "its own answer after a caller left at {after:?}");
    }
    let worker = SttWorker::of(&w.t);
    let deadline = Instant::now() + Duration::from_secs(120);
    while worker.is_running() || !w.tmp_files().is_empty() {
        assert!(
            Instant::now() < deadline,
            "the worker never stopped for idleness, or files were left: {:?}",
            w.tmp_files()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_warm_up_whose_caller_goes_away_leaves_no_file() {
    let w = world();
    w.put("base.en");
    w.py.set(json!({ "worker": { "mode": "ok", "delayMs": 300 } }));
    let settings = store(&[]);
    let leaving = warm_stt(&w.t, Some(&settings));
    tokio::pin!(leaving);
    let _ = tokio::time::timeout(Duration::from_millis(100), &mut leaving).await;
    drop(leaving);
    // The warm-up still runs: the next recording finds the worker warm.
    transcribe_audio(&w.t, &wav(500), Some("en"), Some(&store(&[])))
        .await
        .unwrap();
    assert_eq!(w.starts(), 1);
    let deadline = Instant::now() + Duration::from_secs(120);
    while !w.tmp_files().is_empty() {
        assert!(Instant::now() < deadline, "left behind: {:?}", w.tmp_files());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
