//! The Python the speech workers run on (src/voice/python_runtime.rs), against the fake Python and a fake GitHub.
//! test/python-runtime.test.js: "finding a Python on this computer" and "downloading a standalone Python". The cases
//! that run nothing are unit tests in src/voice/python_runtime.rs.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tarsee::testkit::fake_download_host::{FakeDownloadHost, Route};
use tarsee::testkit::tar::{TarEntry, make_tar_gz};
use tarsee::testkit::{TestApp, test_app, tmp_dir};
use tarsee::voice::python_runtime::{
    EnsureOptions, PythonProgress, PythonRef, RunOptions, STANDALONE_PYTHON, StandalonePython, TargetQuery,
    ensure_base_python, find_base_python, find_pythons, interpreter_in, probe_python, python_home, python_target,
    run_python, set_for_tests, standalone_dir, standalone_ready,
};
use tempfile::TempDir;

use crate::fake_python::{FakePython, cand, fake_interpreter};

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

struct World {
    t: TestApp,
    py: FakePython,
    _fake_dir: TempDir,
}

fn world(candidates: Vec<PythonRef>) -> World {
    let t = test_app();
    let fake_dir = tmp_dir();
    let py = FakePython::new(fake_dir.path(), json!({ "pythons": {} }));
    set_for_tests(&t, py.overrides(candidates));
    World {
        t,
        py,
        _fake_dir: fake_dir,
    }
}

fn pin() -> StandalonePython {
    STANDALONE_PYTHON.clone()
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

// ── finding a Python on this computer ────────────────────────────────────

fn finding() -> World {
    world(vec![cand("py", &["-3.12"]), cand("python3", &[]), cand("python", &[])])
}

#[tokio::test]
async fn no_python_at_all_nothing_found_and_without_a_download_allowed_it_says_so_in_plain_words() {
    let w = finding();
    assert!(find_base_python(&w.t, &pin()).await.is_none());
    let all = find_pythons(&w.t, &pin()).await;
    assert_eq!(all.len(), 3);
    assert!(all.iter().all(|p| !p.found), "{all:?}");
    let err = ensure_base_python(&w.t, &EnsureOptions::default()).await.unwrap_err();
    assert!(err.message.to_lowercase().contains("no python 3.9 or newer"), "{err}");
    assert!(!err.message.contains("ENOENT"));
    assert!(err.has_code("NO_PYTHON"));
}

#[tokio::test]
async fn the_microsoft_store_shortcut_is_not_a_python() {
    let w = finding();
    w.py.set(json!({ "pythons": { "python": { "store": true }, "python3": { "store": true } } }));
    let p = probe_python(&w.t, &cand("python", &[]), Duration::from_secs(30)).await;
    assert!(p.found);
    assert!(!p.usable);
    assert!(p.problem.as_deref().unwrap().contains("Microsoft Store"));
    assert!(find_base_python(&w.t, &pin()).await.is_none());
    // The py launcher asked for a version it doesn't have says "open the Microsoft Store" too: that's "not found".
    w.py.set(json!({ "pythons": { "py -3.13": { "version": "3.13.7" } } }));
    let missing = probe_python(&w.t, &cand("py", &["-3.12"]), Duration::from_secs(30)).await;
    assert!(!missing.found);
    assert_eq!(missing.problem.as_deref(), Some("not found"));
}

#[tokio::test]
async fn skips_one_too_old_one_too_new_and_one_without_venv_and_takes_the_first_that_fits() {
    let w = finding();
    w.py.set(json!({ "pythons": {
        "py -3.12": { "version": "3.8.10" },
        "python3": { "version": "3.11.4", "venv": false },
        "python": { "version": "3.12.1" },
    } }));
    let all = find_pythons(&w.t, &pin()).await;
    let problem = |label: &str| {
        all.iter()
            .find(|p| p.label() == label)
            .unwrap()
            .problem
            .clone()
            .unwrap()
    };
    let old = problem("py -3.12");
    assert!(old.contains("too old") || old.contains("3.9"), "{old}");
    assert!(problem("python3").contains("venv"));
    let best = find_base_python(&w.t, &pin()).await.unwrap();
    assert_eq!(best.label(), "python");
    assert_eq!(best.version.as_deref(), Some("3.12.1"));
    assert!(best.usable);
    w.py.set(json!({ "pythons": { "python": { "version": "3.15.0" } } }));
    let p = probe_python(&w.t, &cand("python", &[]), Duration::from_secs(30)).await;
    assert!(p.problem.unwrap().contains("newer"));
}

#[tokio::test]
async fn a_python_that_never_answers_is_given_up_on() {
    let w = finding();
    w.py.set(json!({ "pythons": { "python3": { "probeHang": true } } }));
    let started = std::time::Instant::now();
    let p = probe_python(&w.t, &cand("python3", &[]), Duration::from_millis(500)).await;
    assert!(!p.usable);
    assert_eq!(p.problem.as_deref(), Some("did not answer within 1s"));
    assert!(started.elapsed() < Duration::from_secs(10), "it was stopped");
}

#[tokio::test]
async fn run_python_a_missing_program_a_failure_and_the_output_line_by_line() {
    let w = finding();
    let err = run_python(&w.t, &cand("nope", &[]), &args(&["-c", "x"]), RunOptions::default())
        .await
        .unwrap_err();
    assert_eq!(err.code.as_deref(), Some("ENOENT"));
    assert_eq!(err.message, "nope was not found");
    w.py.set(json!({ "pythons": { "python3": { "version": "3.12.1" } } }));
    let err = run_python(
        &w.t,
        &cand("python3", &[]),
        &args(&["-I", "-c", "import faster_whisper"]),
        RunOptions::default(),
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("No module named 'faster_whisper'"), "{err}");
    assert_eq!(err.exit_code, Some(1));
    let lines = Arc::new(Mutex::new(Vec::new()));
    let seen = lines.clone();
    run_python(
        &w.t,
        &cand("python3", &[]),
        &args(&["-I", "-c", "print('TARSEE-PROBE')"]),
        RunOptions::default().on_line(move |l, _| seen.lock().push(l.to_string())),
    )
    .await
    .unwrap();
    assert!(
        lines.lock().iter().any(|l| l.starts_with("TARSEE-PROBE ")),
        "{:?}",
        lines.lock()
    );
    let calls = w.py.calls();
    assert_eq!(calls.last().unwrap()["cmd"], "python3");
}

// Added: the environment a Python is given, and what a failure says.
#[tokio::test]
async fn a_python_gets_exactly_the_environment_it_is_given_and_a_failure_says_its_last_lines() {
    let w = finding();
    set_for_tests(&w.t, Default::default());
    let echo_dir = tmp_dir();
    let echo = crate::support::testbin_as(echo_dir.path(), "echo");
    let me = PythonRef::new(echo.to_string_lossy()).label("echo");
    w.t.env().set("ONLY_IN_THE_APP", "yes");

    let mut env = w.t.env().snapshot();
    env.insert(
        "TARSEE_TESTBIN_ECHO_ENV".into(),
        "ONLY_IN_THE_APP,HF_HUB_OFFLINE".into(),
    );
    env.insert("TARSEE_TESTBIN_EXIT".into(), "4".into());
    let err = run_python(&w.t, &me, &args(&["-c", "x"]), RunOptions::default().env(env))
        .await
        .unwrap_err();
    let said: Value = serde_json::from_str(err.stdout.trim()).unwrap();
    assert_eq!(said["env"], json!({"ONLY_IN_THE_APP": "yes", "HF_HUB_OFFLINE": null}));
    assert_eq!(said["args"], json!(["-c", "x"]));
    assert_eq!(err.exit_code, Some(4));
    assert!(err.message.starts_with("{\"args\""), "the last line it printed: {err}");

    // A probe runs offline, and an answer without its marker line is not a Python.
    w.t.env().set("TARSEE_TESTBIN_ECHO_ENV", "HF_HUB_OFFLINE");
    let probe = probe_python(&w.t, &me, Duration::from_secs(30)).await;
    assert_eq!(probe.problem.as_deref(), Some("did not answer like a Python does"));
    assert!(probe.found);

    // Nothing printed at all: the exit code says it.
    w.t.env().set("TARSEE_TESTBIN_EXIT", "5");
    let silent = PythonRef::new(echo.to_string_lossy());
    let mut env = w.t.env().snapshot();
    env.insert("TARSEE_TESTBIN_ROLE".into(), "nobody-at-all".into());
    let err = run_python(&w.t, &silent, &[], RunOptions::default().env(env))
        .await
        .unwrap_err();
    assert_eq!(err.exit_code, Some(64));
    assert!(err.message.contains("no such role"), "{err}");
}

// ── downloading a standalone Python ──────────────────────────────────────

struct Download {
    w: World,
    target: String,
    archive: Vec<u8>,
    pin: StandalonePython,
    asset_name: String,
    api: String,
    dl: String,
}

const CDN: &str = "https://release-assets.githubusercontent.com/github-production-release-asset/162334160/abc";

fn exe_rel() -> String {
    let x = std::path::Path::new("X");
    interpreter_in(x)
        .strip_prefix(x)
        .unwrap()
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn download() -> Download {
    let target =
        python_target(&TargetQuery::current()).expect("this test machine has no python-build-standalone target");
    let archive = make_tar_gz(&[
        TarEntry::dir("python/"),
        TarEntry::file(&format!("python/{}", exe_rel()), fake_interpreter("3.12.16", json!({}))).mode(0o755),
        TarEntry::file("python/lib/python3.12/os.py", "# os"),
    ]);
    let mut pin = STANDALONE_PYTHON.clone();
    pin.sha256 = [(target.clone(), sha(&archive))].into_iter().collect();
    let asset_name = format!("cpython-{}+{}-{}-install_only.tar.gz", pin.version, pin.tag, target);
    let api = format!("https://api.github.com/repos/{}/releases/tags/{}", pin.repo, pin.tag);
    let dl = format!(
        "https://github.com/{}/releases/download/{}/{}",
        pin.repo,
        pin.tag,
        asset_name.replace('+', "%2B")
    );
    let w = world(vec![cand("python3", &[])]);
    Download {
        w,
        target,
        archive,
        pin,
        asset_name,
        api,
        dl,
    }
}

impl Download {
    fn release(&self, over: Value) -> Route {
        let mut asset = json!({
            "name": self.asset_name,
            "size": self.archive.len(),
            "digest": format!("sha256:{}", sha(&self.archive)),
            "browser_download_url": self.dl,
        });
        if let Value::Object(over) = over {
            for (k, v) in over {
                asset[k] = v;
            }
        }
        Route::json(json!({
            "tag_name": self.pin.tag,
            "assets": [
                {
                    "name": format!("cpython-{}+{}-{}-install_only_stripped.tar.gz", self.pin.version, self.pin.tag, self.target),
                    "size": 1,
                    "digest": "sha256:00",
                    "browser_download_url": format!("{}-stripped", self.dl),
                },
                asset,
                {
                    "name": "SHA256SUMS",
                    "size": 10,
                    "browser_download_url": format!("https://github.com/{}/releases/download/{}/SHA256SUMS", self.pin.repo, self.pin.tag),
                },
            ],
        }))
    }

    fn opts(&self, host: &Arc<FakeDownloadHost>) -> EnsureOptions {
        EnsureOptions {
            allow_download: true,
            fetch: Some(host.clone()),
            pin: Some(self.pin.clone()),
            retry_delay_ms: 1,
            ..Default::default()
        }
    }

    /// Nothing left: no Python folder, and nothing in Tarsee's Python folder but empty folders (and the lock).
    fn leaves_nothing(&self, pin: &StandalonePython) {
        let config = self.w.t.config();
        assert!(!standalone_dir(config, pin).exists(), "no Python folder");
        let left: Vec<String> = std::fs::read_dir(python_home(config))
            .map(|entries| {
                entries
                    .map(|e| e.unwrap())
                    .filter(|e| e.file_name() != ".install.lock")
                    .filter(|e| !e.path().is_dir() || std::fs::read_dir(e.path()).unwrap().next().is_some())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        assert!(left.is_empty(), "left behind: {left:?}");
    }
}

#[tokio::test]
async fn no_python_here_downloads_the_pinned_build_with_progress_extracts_it_runs_it_once_and_uses_it_from_then_on() {
    let d = download();
    let host = FakeDownloadHost::new([
        (d.api.clone(), d.release(json!({}))),
        (d.dl.clone(), Route::redirect(CDN)),
        (CDN.to_string(), Route::body(d.archive.clone()).chunk(64).delay_ms(1)),
    ]);
    let seen = Arc::new(Mutex::new(Vec::<PythonProgress>::new()));
    let record = seen.clone();
    let logged = Arc::new(Mutex::new(Vec::<String>::new()));
    let log = logged.clone();
    let opts = EnsureOptions {
        on_progress: Some(Arc::new(move |p| record.lock().push(p))),
        log: Some(Arc::new(move |m: &str| log.lock().push(m.to_string()))),
        ..d.opts(&host)
    };
    let found = ensure_base_python(&d.w.t, &opts).await.unwrap();
    let config = d.w.t.config();
    assert_eq!(found.python.source.as_deref(), Some("tarsee"));
    assert_eq!(found.version.as_deref(), Some("3.12.16"));
    assert_eq!(
        found.python.cmd,
        interpreter_in(&standalone_dir(config, &d.pin)).to_string_lossy()
    );
    assert!(standalone_ready(config, &d.pin));
    let seen = seen.lock().clone();
    assert!(seen.len() > 5, "progress while downloading: {}", seen.len());
    let last = seen.last().unwrap();
    assert!(last.bytes_done >= d.archive.len() as u64 && last.bytes_total == d.archive.len() as u64);
    assert_eq!(last.phase, "python-unpack");
    let api_call = host.requests().into_iter().find(|r| r.url == d.api).unwrap();
    assert!(api_call.header("User-Agent").is_some(), "GitHub asks for a User-Agent");
    assert!(!api_call.follow_redirects, "redirects are followed by hand");
    let mut left: Vec<String> = std::fs::read_dir(python_home(config))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    left.sort();
    assert_eq!(
        left,
        vec![
            standalone_dir(config, &d.pin)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string()
        ],
        "the archive is gone once extracted"
    );
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(standalone_dir(config, &d.pin).join("tarsee-python.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(marker["target"], json!(d.target));
    assert_eq!(marker["sha256"], json!(sha(&d.archive)));
    assert_eq!(
        logged.lock()[0],
        format!("downloading Python 3.12.16 ({}) from GitHub", d.asset_name)
    );

    let again = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap();
    assert_eq!(again.python.cmd, found.python.cmd);
    assert_eq!(host.hits(&d.api), 1, "no second download");
    assert_eq!(
        find_base_python(&d.w.t, &d.pin).await.unwrap().python.source.as_deref(),
        Some("tarsee"),
        "Tarsee's own Python comes first once it is there"
    );
}

#[tokio::test]
async fn a_usable_python_on_this_computer_is_used_and_nothing_is_downloaded() {
    let d = download();
    d.w.py.set(json!({ "pythons": { "python3": { "version": "3.11.4" } } }));
    let host = FakeDownloadHost::new(Vec::<(String, Route)>::new());
    let found = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap();
    assert_eq!(found.label(), "python3");
    assert!(host.requests().is_empty());
}

#[tokio::test]
async fn github_listing_a_different_file_than_the_pinned_one_is_refused_before_downloading() {
    let d = download();
    let host = FakeDownloadHost::new([
        (
            d.api.clone(),
            d.release(json!({ "digest": format!("sha256:{}", "ab".repeat(32)) })),
        ),
        (d.dl.clone(), Route::body(d.archive.clone())),
    ]);
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert!(
        err.message.contains("does not match") || err.message.contains("different"),
        "{err}"
    );
    assert_eq!(host.hits(&d.dl), 0);
    d.leaves_nothing(&d.pin);
}

#[tokio::test]
async fn a_file_that_does_not_match_its_hash_is_refused_and_nothing_is_extracted() {
    let d = download();
    let mut tampered = d.archive.clone();
    let at = tampered.len() - 20;
    tampered[at] ^= 0xff;
    let host = FakeDownloadHost::new([
        (d.api.clone(), d.release(json!({}))),
        (d.dl.clone(), Route::body(tampered)),
    ]);
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert!(err.message.contains("hash") || err.message.contains("sha256"), "{err}");
    assert_eq!(
        err.message,
        format!(
            "Downloading Python from GitHub failed: {} does not match its published sha256.",
            d.asset_name
        )
    );
    d.leaves_nothing(&d.pin);
}

#[tokio::test]
async fn a_download_that_keeps_stopping_halfway_fails_in_plain_words() {
    let d = download();
    let host = FakeDownloadHost::new([
        (d.api.clone(), d.release(json!({}))),
        (
            d.dl.clone(),
            Route::body(d.archive.clone()).fail_at(d.archive.len() / 2),
        ),
    ]);
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert!(err.message.contains("cut off"), "{err}");
    d.leaves_nothing(&d.pin);
}

#[tokio::test]
async fn github_turning_the_request_away_rate_limit_says_to_try_again_later() {
    let d = download();
    let host = FakeDownloadHost::new([(
        d.api.clone(),
        Route::status(403, r#"{"message":"API rate limit exceeded"}"#).header("x-ratelimit-remaining", "0"),
    )]);
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert!(
        err.message.contains("GitHub") && err.message.to_lowercase().contains("try again"),
        "{err}"
    );
}

#[tokio::test]
async fn a_release_whose_download_link_points_anywhere_else_is_refused() {
    let d = download();
    let host = FakeDownloadHost::new([(
        d.api.clone(),
        d.release(json!({ "browser_download_url": "https://evil.example/python.tar.gz" })),
    )]);
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert!(
        err.message.contains("not the official") || err.message.contains("refused"),
        "{err}"
    );
    assert_eq!(host.hits("https://evil.example/python.tar.gz"), 0);
}

#[tokio::test]
async fn an_archive_whose_python_does_not_run_is_not_kept() {
    let d = download();
    let broken = make_tar_gz(&[TarEntry::file(&format!("python/{}", exe_rel()), "not a python at all").mode(0o755)]);
    let mut pin2 = d.pin.clone();
    pin2.sha256 = [(d.target.clone(), sha(&broken))].into_iter().collect();
    let host = FakeDownloadHost::new([
        (
            d.api.clone(),
            Route::json(json!({ "assets": [{
                "name": d.asset_name,
                "size": broken.len(),
                "digest": format!("sha256:{}", sha(&broken)),
                "browser_download_url": d.dl,
            }] })),
        ),
        (d.dl.clone(), Route::body(broken)),
    ]);
    let opts = EnsureOptions {
        pin: Some(pin2.clone()),
        ..d.opts(&host)
    };
    let err = ensure_base_python(&d.w.t, &opts).await.unwrap_err();
    assert!(
        err.message.contains("did not run") || err.message.contains("could not run"),
        "{err}"
    );
    assert!(!standalone_dir(d.w.t.config(), &pin2).exists());
}

// Added: answers the Node tests did not reach.
#[tokio::test]
async fn a_release_without_this_computer_s_build_or_any_hash_is_refused_in_plain_words() {
    let d = download();
    let host = FakeDownloadHost::new([(d.api.clone(), Route::json(json!({ "assets": [] })))]);
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert_eq!(
        err.message,
        format!(
            "GitHub's Python release {} has no build for this computer ({}).",
            d.pin.tag, d.target
        )
    );
    let mut unpinned = d.pin.clone();
    unpinned.sha256.clear();
    host.route(d.api.clone(), d.release(json!({ "digest": null })));
    let opts = EnsureOptions {
        pin: Some(unpinned),
        ..d.opts(&host)
    };
    let err = ensure_base_python(&d.w.t, &opts).await.unwrap_err();
    assert_eq!(
        err.message,
        format!("GitHub lists no hash for {}, so it was not downloaded.", d.asset_name)
    );
    host.route(d.api.clone(), Route::status(500, "oops"));
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert_eq!(
        err.message,
        "GitHub answered HTTP 500 for the Python release list. Try again later."
    );
    host.route(d.api.clone(), Route::status(200, "not json"));
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert_eq!(
        err.message,
        "GitHub's Python release list could not be read. Try again later."
    );
    host.route(
        d.api.clone(),
        Route::Error(tarsee::net::fetch::FetchError::Connect(
            "getaddrinfo ENOTFOUND api.github.com".into(),
        )),
    );
    let err = ensure_base_python(&d.w.t, &d.opts(&host)).await.unwrap_err();
    assert_eq!(
        err.message,
        "Could not read the Python release list from GitHub: could not reach api.github.com (getaddrinfo ENOTFOUND api.github.com)."
    );
}
