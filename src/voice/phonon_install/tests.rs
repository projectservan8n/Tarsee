//! test/tts-phonon.test.js, "Phonon installer", with a fake Hugging Face and a stand-in for the Python runtime and the
//! smoke test. The cases that run a (fake) Python are in tests/it/tts_phonon.rs.

use std::sync::atomic::AtomicUsize;

use sha2::{Digest, Sha256};

use super::*;
use crate::testkit::fake_download_host::{FakeDownloadHost, Route};
use crate::testkit::{MemorySettings, TestApp, test_app};
use crate::voice::install_common::Downloaded;
use crate::voice::phonon_engine::{PhononOptions, PhononTtsEngine};
use crate::voice::tts_interface::TtsEngine;

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn model() -> PhononModel {
    PhononModel {
        repo: "test/model".into(),
        revision: "rev1".into(),
        files: vec![file("config.json", None), file("model.q8.gguf", Some(&sha(b"weights")))],
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

fn voice_list() -> String {
    [
        json!({ "name": "Toby", "filename": "voices/toby.safetensors", "language": "en", "locale": "en-gb" }),
        json!({ "name": "Zoey", "filename": "voices/zoey.safetensors", "language": "en", "locale": "en-us" }),
        json!({ "name": "Remy", "filename": "voices/remy.safetensors", "language": "fr", "locale": "fr-fr" }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n")
}

/// A fake Hugging Face serving the test model and voices; `over` replaces some answers. Unknown URLs are a 404.
fn hub(over: &[(String, String)]) -> Arc<FakeDownloadHost> {
    let (m, v) = (model(), voices());
    let mut files = vec![
        (hf_url(&m.repo, &m.revision, "config.json"), "{}".to_string()),
        (hf_url(&m.repo, &m.revision, "model.q8.gguf"), "weights".to_string()),
        (hf_url(&v.repo, &v.revision, "voices.jsonl"), voice_list()),
        (
            hf_url(&v.repo, &v.revision, "voices/toby.safetensors"),
            "toby".to_string(),
        ),
        (
            hf_url(&v.repo, &v.revision, "voices/zoey.safetensors"),
            "zoey".to_string(),
        ),
        (hf_url(&v.repo, &v.revision, "README.md"), "# voices".to_string()),
    ];
    for (url, body) in over {
        files.retain(|(u, _)| u != url);
        files.push((url.clone(), body.clone()));
    }
    FakeDownloadHost::new(files.into_iter().map(|(u, b)| (u, Route::body(b.into_bytes()))))
}

/// The ensureRuntime / smokeTest stand-ins: nothing runs.
fn fake_runtime(host: &Arc<FakeDownloadHost>) -> InstallOptions {
    InstallOptions {
        fetch: Some(host.clone()),
        model: Some(model()),
        voices: Some(voices()),
        retry_delay_ms: Some(1),
        ensure_runtime: Some(Arc::new(|_, _, _| async { Ok(()) }.boxed())),
        smoke_test: Some(Arc::new(|_, _| async { Ok("ok".to_string()) }.boxed())),
        log: Some(Arc::new(|_: &str| {})),
        ..Default::default()
    }
}

/// A test app installing into a folder of its own.
fn phonon_app() -> (TestApp, PathBuf) {
    let t = test_app();
    let dir = t.path().join("phonon-test");
    std::fs::create_dir_all(&dir).unwrap();
    t.env().set("TARSEE_PHONON_DIR", dir.to_string_lossy().to_string());
    (t, dir)
}

#[tokio::test]
async fn download_file_keeps_a_file_whose_sha256_matches_and_rejects_one_that_does_not() {
    let (_t, dir) = phonon_app();
    let good = b"weights".to_vec();
    let host = FakeDownloadHost::new([
        ("https://x/good", Route::body(good.clone())),
        ("https://x/bad", Route::body("tampered")),
    ]);
    let dest = dir.join("m").join("model.bin");
    assert_eq!(
        download_file(&*host, DownloadFile::new("https://x/good", &dest).sha256(sha(&good)))
            .await
            .unwrap(),
        Downloaded::Fetched(sha(&good))
    );
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "weights");

    let bad = dir.join("m").join("other.bin");
    let err = download_file(
        &*host,
        DownloadFile::new("https://x/bad", &bad)
            .sha256(sha(&good))
            .retry_delay_ms(1),
    )
    .await
    .unwrap_err();
    assert!(err.has_code("HASH_MISMATCH"), "{err}");
    assert!(!bad.exists(), "nothing is renamed into place");
    assert!(
        !dir.join("m").join("other.bin.part").exists(),
        "the partial file is removed"
    );
}

#[tokio::test]
async fn download_file_does_not_fetch_a_file_that_is_already_there_and_verified() {
    let (_t, dir) = phonon_app();
    let host = FakeDownloadHost::new([("https://x/f", Route::body("weights"))]);
    let dest = dir.join("f.bin");
    std::fs::write(&dest, "weights").unwrap();
    let spec = || DownloadFile::new("https://x/f", &dest).sha256(sha(b"weights"));
    assert_eq!(download_file(&*host, spec()).await.unwrap(), Downloaded::Kept);
    assert_eq!(host.hits("https://x/f"), 0);
    std::fs::write(&dest, "corrupt").unwrap();
    download_file(&*host, spec()).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(&dest).unwrap(),
        "weights",
        "a file that fails its hash is downloaded again"
    );
}

#[tokio::test]
async fn installs_the_model_and_only_the_english_voices_then_marks_it_installed() {
    let (t, dir) = phonon_app();
    let host = hub(&[]);
    let done = Arc::new(AtomicUsize::new(0));
    let counted = done.clone();
    let opts = InstallOptions {
        on_installed: Some(Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }.boxed()
        })),
        ..fake_runtime(&host)
    };
    let status = install_phonon(&t, opts).await.unwrap();
    assert_eq!(status.state, "installed");
    assert_eq!(status.percent, 100);
    assert_eq!(done.load(Ordering::SeqCst), 1, "the engine is re-initialised once");
    let p = phonon_paths(&t);
    assert!(phonon_installed(&p));
    assert!(p.marker.exists());
    assert_eq!(
        std::fs::read_to_string(p.model.join("model.q8.gguf")).unwrap(),
        "weights"
    );
    let catalog: Vec<String> = std::fs::read_to_string(p.catalog.join("voices.jsonl"))
        .unwrap()
        .trim()
        .split('\n')
        .map(|l| {
            serde_json::from_str::<Value>(l).unwrap()["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(catalog, ["Toby", "Zoey"]);
    assert!(p.catalog.join("voices").join("toby.safetensors").exists());
    assert!(!p.catalog.join("voices").join("remy.safetensors").exists());
    assert!(!dir.join(".install.lock").exists(), "the lock is released");
}

#[tokio::test]
async fn a_tampered_model_fails_the_install_status_failed_no_marker_and_a_retry_works() {
    let (t, dir) = phonon_app();
    let m = model();
    let bad = hub(&[(hf_url(&m.repo, &m.revision, "model.q8.gguf"), "tampered".into())]);
    let err = install_phonon(&t, fake_runtime(&bad)).await.unwrap_err();
    assert!(err.message.contains("sha256"), "{err}");
    let st = get_phonon_install_status(&t);
    assert_eq!(st.state, "failed");
    assert!(st.error.as_deref().unwrap().contains("sha256"));
    assert!(!phonon_paths(&t).marker.exists());
    assert!(
        !dir.join(".install.lock").exists(),
        "the lock is released after a failure"
    );

    let good = hub(&[]);
    install_phonon(&t, fake_runtime(&good)).await.unwrap();
    assert!(phonon_paths(&t).marker.exists());
    assert_eq!(
        good.hits(&hf_url(&m.repo, &m.revision, "config.json")),
        0,
        "files already in place are kept"
    );
}

#[tokio::test]
async fn a_model_that_does_not_load_is_not_marked_installed_its_unverified_files_are_dropped_for_the_retry() {
    let (t, _dir) = phonon_app();
    let host = hub(&[]);
    let opts = InstallOptions {
        smoke_test: Some(Arc::new(|_, _| {
            async { Err(InstallError::new("the downloaded model did not load: bad config")) }.boxed()
        })),
        ..fake_runtime(&host)
    };
    let err = install_phonon(&t, opts).await.unwrap_err();
    assert!(err.message.contains("did not load"));
    let p = phonon_paths(&t);
    assert!(!p.marker.exists());
    assert!(!phonon_installed(&p));
    assert!(
        !p.model.join("config.json").exists(),
        "no published hash: fetched again next time"
    );
    assert!(p.model.join("model.q8.gguf").exists(), "verified weights are kept");
}

#[tokio::test]
async fn files_on_disk_with_no_usable_python_runtime_read_as_failed_so_retry_can_repair_it() {
    let (t, dir) = phonon_app();
    let host = hub(&[]);
    install_phonon(&t, fake_runtime(&host)).await.unwrap();
    t.env().set(
        "TARSEE_PHONON_PYTHON",
        dir.join("no-such-python").to_string_lossy().to_string(),
    );
    assert_eq!(
        get_phonon_install_status(&t).state,
        "installed",
        "the files are all there"
    );
    let st = check_phonon_install(&t).await;
    assert_eq!(st.state, "failed");
    assert_eq!(st.percent, 0);
    assert!(st.error.as_deref().unwrap().contains("cannot import ptts"), "{st:?}");
    assert!(
        !PhononTtsEngine::new(&t, None, PhononOptions::default())
            .is_available()
            .await,
        "so Edge TTS speaks"
    );
}

#[tokio::test]
async fn concurrent_installs_share_one_run() {
    let (t, _dir) = phonon_app();
    let host = hub(&[]);
    let a = install_phonon(&t, fake_runtime(&host));
    let b = install_phonon(&t, fake_runtime(&host));
    assert!(Shared::ptr_eq(&a, &b));
    assert_eq!(get_phonon_install_status(&t).state, "installing");
    a.await.unwrap();
    let m = model();
    assert_eq!(host.hits(&hf_url(&m.repo, &m.revision, "model.q8.gguf")), 1);
}

#[tokio::test]
async fn the_lock_keeps_a_second_installer_out_and_a_stale_lock_is_taken_over() {
    let (t, dir) = phonon_app();
    let first = acquire_lock(&t, &dir, None).unwrap();
    assert!(acquire_lock(&t, &dir, None).unwrap_err().has_code("LOCKED"));
    first.release();
    acquire_lock(&t, &dir, None).unwrap().release();

    let lock = dir.join(".install.lock");
    // Left by a process that is gone.
    std::fs::write(
        &lock,
        json!({ "pid": (1u64 << 22) + 12345, "startedAt": now_iso() }).to_string(),
    )
    .unwrap();
    acquire_lock(&t, &dir, None).unwrap().release();
    // Left by an earlier container that had this same pid.
    std::fs::write(
        &lock,
        json!({ "pid": std::process::id(), "startedAt": now_iso() }).to_string(),
    )
    .unwrap();
    acquire_lock(&t, &dir, None).unwrap().release();

    // Held by a live process: the install fails with LOCKED.
    let mut child = std::process::Command::new(if cfg!(windows) { "ping" } else { "sleep" })
        .args(if cfg!(windows) {
            vec!["-n", "30", "127.0.0.1"]
        } else {
            vec!["30"]
        })
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    std::fs::write(&lock, json!({ "pid": child.id(), "startedAt": now_iso() }).to_string()).unwrap();
    let host = hub(&[]);
    let err = install_phonon(&t, fake_runtime(&host)).await.unwrap_err();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(err.has_code("LOCKED"), "{err}");
    assert!(lock.exists(), "someone else's lock is left alone");
}

#[tokio::test]
async fn a_voice_list_naming_a_path_outside_the_catalog_is_refused() {
    let (t, dir) = phonon_app();
    let v = voices();
    let evil =
        json!({ "name": "Evil", "filename": "../../escape.sh", "language": "en", "locale": "en-us" }).to_string();
    let host = hub(&[(hf_url(&v.repo, &v.revision, "voices.jsonl"), evil)]);
    let err = install_phonon(&t, fake_runtime(&host)).await.unwrap_err();
    assert!(err.message.contains("unsafe file"), "{err}");
    assert!(!dir.join("..").join("escape.sh").exists());
}

#[tokio::test]
async fn the_background_install_on_boot_only_for_phonon_only_when_missing_once_and_can_be_turned_off() {
    let (t, _dir) = phonon_app();
    let calls: Arc<Mutex<Vec<InstallOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let called = Arc::new(tokio::sync::Notify::new());
    let install: InstallFn = {
        let (calls, called) = (calls.clone(), called.clone());
        Arc::new(move |_app, o| {
            calls.lock().push(o);
            called.notify_one();
            async { Ok(()) }.boxed()
        })
    };
    let opts = |on_installed: Option<OnInstalled>| AutoInstallOptions {
        install: Some(install.clone()),
        on_installed,
        delay: Duration::ZERO,
    };
    let store =
        |pairs: &[(&str, &str)]| MemorySettings::from_pairs(pairs.iter().map(|(k, v)| (k.to_string(), json!(v))));

    t.env().set("TARSEE_PHONON_AUTO_INSTALL", "0");
    assert!(!auto_install_phonon(&t, Some(&store(&[])), opts(None)));
    t.env().remove("TARSEE_PHONON_AUTO_INSTALL");
    assert!(!auto_install_phonon(
        &t,
        Some(&store(&[("voice.engine", "edge-tts")])),
        opts(None)
    ));
    assert!(!auto_install_phonon(
        &t,
        Some(&store(&[("voice.engine", "auto")])),
        opts(None)
    ));
    let on_installed: OnInstalled = Arc::new(|| async { Ok(()) }.boxed());
    assert!(auto_install_phonon(
        &t,
        Some(&store(&[])),
        opts(Some(on_installed.clone()))
    ));
    assert!(
        !auto_install_phonon(&t, Some(&store(&[("voice.engine", "phonon")])), opts(None)),
        "one attempt per boot"
    );
    called.notified().await;
    let calls = calls.lock();
    assert_eq!(calls.len(), 1);
    assert!(Arc::ptr_eq(calls[0].on_installed.as_ref().unwrap(), &on_installed));
}

// ── Added ────────────────────────────────────────────────────────────────

#[test]
fn hugging_face_links_encode_each_piece_of_the_path() {
    assert_eq!(
        hf_url("gradium/phonon-voices", "rev", "voices/a b+c.safetensors"),
        "https://huggingface.co/gradium/phonon-voices/resolve/rev/voices/a%20b%2Bc.safetensors"
    );
}

#[test]
fn a_voice_file_must_be_a_plain_path_inside_the_catalog() {
    let dir = Path::new("cat");
    let ok = safe_join(dir, Some(&json!("voices/toby.safetensors"))).unwrap();
    assert_eq!(ok, dir.join("voices").join("toby.safetensors"));
    for bad in [
        json!("../x"),
        json!("voices/../../x"),
        json!("/etc/passwd"),
        json!("C:\\x"),
        json!("voices//x"),
        json!("voices/./x"),
        json!(".hidden"),
        json!(""),
        json!(3),
    ] {
        assert_eq!(safe_join(dir, Some(&bad)), None, "{bad}");
    }
    assert_eq!(safe_join(dir, None), None);
}

#[tokio::test]
async fn progress_moves_while_downloading_and_the_status_names_the_file() {
    let (t, _dir) = phonon_app();
    let host = hub(&[]);
    let seen: Arc<Mutex<Vec<PhononInstallStatus>>> = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let opts = InstallOptions {
        on_progress: Some(Arc::new(move |s| record.lock().push(s))),
        ..fake_runtime(&host)
    };
    install_phonon(&t, opts).await.unwrap();
    let seen = seen.lock();
    assert!(seen.iter().all(|s| s.state == "installing"));
    assert!(
        seen.iter()
            .any(|s| s.phase.as_deref() == Some("model") && s.file.as_deref() == Some("model.q8.gguf"))
    );
    assert!(seen.iter().any(|s| s.phase.as_deref() == Some("voices")));
    let status = serde_json::to_value(get_phonon_install_status(&t)).unwrap();
    assert_eq!(
        status.as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "state",
            "installed",
            "phase",
            "file",
            "percent",
            "error",
            "startedAt",
            "finishedAt"
        ]
    );
    assert_eq!(
        (status["phase"].clone(), status["file"].clone()),
        (Value::Null, Value::Null)
    );
}

#[tokio::test]
async fn a_python_override_that_cannot_import_ptts_says_how_to_install_it_there() {
    let (t, dir) = phonon_app();
    let python = dir.join("no-such-python").to_string_lossy().to_string();
    t.env().set("TARSEE_PHONON_PYTHON", python.clone());
    let log: LogListener = Arc::new(|_: &str| {});
    let err = ensure_runtime(&t, &log, &RuntimeOptions::default()).await.unwrap_err();
    assert_eq!(
        err.message,
        format!(
            "TARSEE_PHONON_PYTHON ({python}) cannot import ptts. Install it there: {python} -m pip install ptts==0.4.2"
        )
    );
}
