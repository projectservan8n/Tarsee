//! test/stt-routes.test.js: Settings > Voice > Speech-to-text over HTTP (src/routes/voice.rs), mounted as server.js
//! mounts it: session_auth on everything, then require_auth and csrf_protect in front of /api/voice. The status,
//! Install faster-whisper, a model's Download and Delete, and transcribing a short WAV (the call's API). The
//! installer's routes are the owner's only (signed in, or the owner's API token, which the dashboard itself sends),
//! rate-limited, and one job at a time. A fake Python and a fake download host stand in.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use serde_json::{Value, json};
use tarsee::app::App;
use tarsee::db::settings::Settings;
use tarsee::middleware::auth::{create_session, require_auth, session_auth};
use tarsee::middleware::security::{csrf_protect, generate_csrf_cookie};
use tarsee::routes::voice::{Limits, create_stt_router, router};
use tarsee::testkit::fake_download_host::FakeDownloadHost;
use tarsee::testkit::http::{self, TestRequest, TestResponse, request};
use tarsee::testkit::{MemorySettings, tmp_dir};
use tarsee::voice::python_runtime::set_for_tests as set_python;
use tarsee::voice::stt_install::{reset_stt_runtime, set_for_tests as set_catalog, stt_job};
use tempfile::TempDir;

use crate::fake_python::{FakePython, cand};
use crate::voice_fixtures::{Models, VoiceApp, models, voice_app, wav};

/// What the Node test's `app(router, mount)` built: the router behind sign-in and CSRF, and a page that hands out
/// the CSRF cookie.
fn mounted(app: &App, inner: Router<App>, mount: &str) -> Router {
    let guarded = inner
        .layer(from_fn_with_state(app.clone(), csrf_protect))
        .layer(from_fn_with_state(app.clone(), require_auth));
    Router::new()
        .route(
            "/",
            get(|| async { "ok" }).layer(from_fn_with_state(app.clone(), generate_csrf_cookie)),
        )
        .nest(mount, guarded)
        .layer(from_fn_with_state(app.clone(), session_auth))
        .with_state(app.clone())
}

/// Who a request is from: the signed-in owner's browser (session cookie and CSRF token), the owner's API token, a
/// browser session without the CSRF token, or nobody.
#[derive(Clone, Copy, PartialEq)]
enum As {
    Owner,
    Token,
    NoCsrf,
    Nobody,
}

struct World {
    t: VoiceApp,
    py: FakePython,
    models: Models,
    settings: Arc<MemorySettings>,
    router: Router,
    session: String,
    csrf: String,
    _fake: TempDir,
}

async fn world() -> World {
    let t = voice_app(&[]);
    let fake = tmp_dir();
    let py = FakePython::new(
        fake.path(),
        json!({
            "pythons": { "python3": { "version": "3.11.4" } },
            "pip": { "mode": "ok", "delayMs": 1 },
            "worker": { "mode": "ok" },
        }),
    );
    set_python(&t, py.overrides(vec![cand("python3", &[])]));
    let models = models(|_| 8_000, |_| "{}\n".to_string());
    set_catalog(&t, Some(models.catalog.clone()));
    t.app.set_fetch(FakeDownloadHost::new(models.routes(1_000, 2)));
    let settings = Arc::new(MemorySettings::new());
    let store: Arc<dyn Settings> = settings.clone();
    t.app.set(store);
    let router = mounted(&t.app, router(), "/api/voice");
    let session = create_session(&t.app, Some("127.0.0.1"));
    let csrf = http::get(&router, "/")
        .await
        .cookie("tarsee_csrf")
        .expect("the page hands out a CSRF cookie");
    World {
        t,
        py,
        models,
        settings,
        router,
        session,
        csrf,
        _fake: fake,
    }
}

impl World {
    /// A request as the signed-in owner's browser makes it (session cookie + CSRF token), or as given.
    fn request(&self, method: &str, path: &str, who: As) -> TestRequest {
        let req = request(method, path);
        match who {
            As::Owner => req
                .header("cookie", format!("tarsee_session={}", self.session))
                .header("x-csrf-token", &self.csrf),
            As::Token => req.header("authorization", format!("Bearer {}", self.t.config().api_token)),
            As::NoCsrf => req.header("cookie", format!("tarsee_session={}", self.session)),
            As::Nobody => req,
        }
    }

    async fn send_to(&self, router: &Router, method: &str, path: &str, who: As) -> TestResponse {
        http::send(router, self.request(method, path, who)).await
    }

    async fn call(&self, method: &str, path: &str) -> (u16, Value) {
        let res = self.send_to(&self.router, method, path, As::Owner).await;
        (res.status, res.json())
    }

    async fn status_as(&self, method: &str, path: &str, who: As) -> u16 {
        self.send_to(&self.router, method, path, who).await.status
    }

    async fn until_idle(&self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let (_, body) = self.call("GET", "/api/voice/stt").await;
            if body["job"].is_null() {
                return body;
            }
            assert!(Instant::now() < deadline, "the job never finished");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn tmp_files(&self) -> Vec<String> {
        std::fs::read_dir(self.t.tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect()
    }
}

fn model<'a>(status: &'a Value, name: &str) -> &'a Value {
    status["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == name)
        .unwrap()
}

#[tokio::test]
async fn are_behind_sign_in_and_csrf_like_the_other_settings_routes() {
    let w = world().await;
    assert_eq!(w.status_as("GET", "/api/voice/stt", As::Nobody).await, 401);
    assert_eq!(w.status_as("POST", "/api/voice/stt/install", As::Nobody).await, 401);
    assert_eq!(w.status_as("POST", "/api/voice/stt/install", As::NoCsrf).await, 403);
    assert_eq!(
        w.status_as("DELETE", "/api/voice/stt/models/base.en", As::NoCsrf).await,
        403
    );
    assert_eq!(stt_job(&w.t), None, "nothing started");
}

#[tokio::test]
async fn the_owner_s_api_token_works_too_the_dashboard_itself_sends_it_a_wrong_one_is_a_401() {
    let w = world().await;
    assert_eq!(w.status_as("GET", "/api/voice/stt", As::Token).await, 200);
    let res = w
        .send_to(&w.router, "POST", "/api/voice/stt/models/tiny/download", As::Token)
        .await;
    assert_eq!(res.status, 202);
    w.until_idle().await;
    let wrong = http::send(
        &w.router,
        request("POST", "/api/voice/stt/install").header("authorization", "Bearer not-the-token"),
    )
    .await;
    assert_eq!(wrong.status, 401);
    assert_eq!(stt_job(&w.t), None, "nothing started");
}

#[tokio::test]
async fn install_202_with_the_job_progress_in_the_status_then_ready_a_second_job_meanwhile_is_a_409() {
    let w = world().await;
    let (_, s) = w.call("GET", "/api/voice/stt?refresh=1").await;
    assert_eq!(s["runtime"]["state"], "not-installed");
    assert_eq!(s["runtime"]["canInstall"], true);

    let (status, body) = w.call("POST", "/api/voice/stt/install").await;
    assert_eq!(status, 202);
    assert_eq!(body["job"]["kind"], "install");
    let (status, busy) = w.call("POST", "/api/voice/stt/models/tiny/download").await;
    assert_eq!(status, 409);
    assert!(
        busy["error"].as_str().unwrap().contains("installing faster-whisper"),
        "{busy}"
    );
    assert_eq!(busy["code"], "BUSY");
    let (_, during) = w.call("GET", "/api/voice/stt").await;
    assert_eq!(during["runtime"]["state"], "installing");

    let done = w.until_idle().await;
    assert_eq!(done["runtime"]["state"], "ready", "{}", done["runtime"]["summary"]);
    assert_eq!(model(&done, "base.en")["state"], "downloaded");
}

#[tokio::test]
async fn a_failed_install_says_why_in_the_status_and_try_again_works() {
    let w = world().await;
    w.py.set(json!({ "pip": { "mode": "no-wheel", "delayMs": 1 } }));
    w.call("POST", "/api/voice/stt/install").await;
    let s = w.until_idle().await;
    assert_eq!(s["runtime"]["state"], "failed");
    assert!(
        s["runtime"]["error"]
            .as_str()
            .unwrap()
            .contains("no ready-made build of ctranslate2")
    );
    w.py.set(json!({ "pip": { "mode": "ok", "delayMs": 1 } }));
    assert_eq!(w.call("POST", "/api/voice/stt/install").await.0, 202);
    let s = w.until_idle().await;
    assert_eq!(s["runtime"]["state"], "ready");
}

#[tokio::test]
async fn a_model_s_download_and_delete_an_unknown_model_is_a_400() {
    let w = world().await;
    let (status, body) = w.call("POST", "/api/voice/stt/models/small/download").await;
    assert_eq!(status, 202);
    assert_eq!(body["job"]["model"], "small");
    let s = w.until_idle().await;
    assert_eq!(model(&s, "small")["state"], "downloaded");
    let (status, body) = w.call("DELETE", "/api/voice/stt/models/small").await;
    assert_eq!(status, 200);
    assert_eq!(body["removed"].as_array().unwrap().len(), 1);
    assert_eq!(body["kept"], Value::Null);
    let (_, s) = w.call("GET", "/api/voice/stt").await;
    assert_eq!(model(&s, "small")["state"], "missing");
    let (status, body) = w
        .call("POST", "/api/voice/stt/models/..%2F..%2Fetc/download")
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "UNKNOWN_MODEL");
    assert_eq!(w.call("DELETE", "/api/voice/stt/models/large-v3").await.0, 400);
}

#[tokio::test]
async fn choosing_a_model_that_isn_t_downloaded_starts_its_download() {
    let w = world().await;
    let req = w
        .request("POST", "/api/voice/stt-model", As::Owner)
        .json(&json!({ "model": "tiny.en" }));
    let res = http::send(&w.router, req).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.json()["downloading"], true);
    assert_eq!(w.settings.get("voice.stt_model"), Some(json!("tiny.en")));
    let s = w.until_idle().await;
    assert_eq!(s["current"], "tiny.en");
    assert_eq!(model(&s, "tiny.en")["state"], "downloaded");
    let req = w
        .request("POST", "/api/voice/stt-model", As::Owner)
        .json(&json!({ "model": "huge" }));
    assert_eq!(http::send(&w.router, req).await.status, 400);
}

/// What a call sends: a short WAV, as the owner's browser or as an API client with the owner's token.
fn wav_request(w: &World, who: As, language: Option<&str>) -> TestRequest {
    let req = w
        .request("POST", "/api/voice/transcribe", who)
        .header("content-type", "audio/wav");
    match language {
        Some(language) => req.header("x-language", language),
        None => req,
    }
    .body(wav(500))
}

fn ready_with_a_model(w: &World) {
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.2", "packages": { "faster-whisper": "1.2.1" } } } }));
    reset_stt_runtime(&w.t);
    w.models
        .put(&w.t.path().join("data").join("whisper-models"), "base.en");
}

#[tokio::test]
async fn post_transcribe_with_a_short_wav_answers_with_its_text_what_a_call_uses() {
    let w = world().await;
    ready_with_a_model(&w);
    let (_, warm) = w.call("POST", "/api/voice/stt/warm").await;
    assert_eq!(warm, json!({ "ok": true, "model": "base.en" }));
    let res = http::send(&w.router, wav_request(&w, As::Owner, Some("en"))).await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(
        res.json(),
        json!({ "text": "hello from a wav", "language": "en", "provider": "faster-whisper (base.en)" })
    );
    let token = http::send(&w.router, wav_request(&w, As::Token, None)).await;
    assert_eq!(token.status, 200, "an API client can transcribe");
}

#[tokio::test]
async fn starting_jobs_is_rate_limited() {
    let w = world().await;
    let limited = mounted(
        &w.t.app,
        create_stt_router(Limits {
            max: 2,
            window: Duration::from_secs(60),
        }),
        "/api/voice/stt",
    );
    let path = "/api/voice/stt/models/tiny";
    let a = w.send_to(&limited, "DELETE", path, As::Owner).await;
    let b = w.send_to(&limited, "DELETE", path, As::Owner).await;
    let c = w.send_to(&limited, "DELETE", path, As::Owner).await;
    assert_eq!([a.status, b.status, c.status], [200, 200, 429]);
    let error = c.json()["error"].as_str().unwrap().to_string();
    assert!(
        regex::Regex::new(r"Wait [0-9]+ seconds").unwrap().is_match(&error),
        "{error}"
    );
    // The status itself is not limited.
    assert_eq!(w.send_to(&limited, "GET", "/api/voice/stt", As::Owner).await.status, 200);
}

// ── Added ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_transcription_whose_client_leaves_leaves_no_recording_and_the_next_one_gets_its_own_answer() {
    let w = world().await;
    ready_with_a_model(&w);
    // Each answer takes a while, so a client can go away in the middle of one.
    w.py.set(json!({ "worker": { "mode": "ok", "delayMs": 300 } }));
    let mut gone = 0;
    for after in [Duration::ZERO, Duration::from_millis(50), Duration::from_millis(400)] {
        // Not a WAV: the fake hears it as "hello from the fake".
        let leaving = http::send(
            &w.router,
            w.request("POST", "/api/voice/transcribe", As::Owner)
                .header("content-type", "audio/ogg")
                .body(b"OggS not a wav".to_vec()),
        );
        tokio::pin!(leaving);
        if after.is_zero() {
            let _ = futures::poll!(&mut leaving);
        } else {
            let _ = tokio::time::timeout(after, &mut leaving).await;
        }
        drop(leaving);
        gone += 1;
        let res = http::send(&w.router, wav_request(&w, As::Owner, Some("en"))).await;
        assert_eq!(res.status, 200, "after the client left at {after:?}: {}", res.text());
        assert_eq!(res.json()["text"], "hello from a wav", "its own answer (after {gone} gone)");
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    while !w.tmp_files().is_empty() {
        assert!(Instant::now() < deadline, "left in the temporary folder: {:?}", w.tmp_files());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
