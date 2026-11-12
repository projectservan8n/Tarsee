//! test/stt-routes.test.js: Settings > Voice > Speech-to-text over HTTP (src/routes/voice.rs): the status, Install
//! faster-whisper, a model's Download and Delete, and transcribing a short WAV (the call's API). The installer's
//! routes are rate-limited and run one job at a time. A fake Python and a fake download host stand in.
//!
//! The Node tests mounted the router as server.js does, behind requireAuth and CSRF; those two middlewares are package
//! B1's, applied in server.rs, so the two cases about sign-in, CSRF and the API token are not ported here (see the
//! V2 report). The routes themselves are called directly.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use serde_json::{Value, json};
use tarsee::db::settings::Settings;
use tarsee::routes::voice::{Limits, create_stt_router, router};
use tarsee::testkit::fake_download_host::FakeDownloadHost;
use tarsee::testkit::http::{self, request};
use tarsee::testkit::{MemorySettings, tmp_dir};
use tarsee::voice::python_runtime::set_for_tests as set_python;
use tarsee::voice::stt_install::{reset_stt_runtime, set_for_tests as set_catalog, stt_job};
use tempfile::TempDir;

use crate::fake_python::{FakePython, cand};
use crate::voice_fixtures::{Models, VoiceApp, models, voice_app, wav};

struct World {
    t: VoiceApp,
    py: FakePython,
    models: Models,
    settings: Arc<MemorySettings>,
    router: Router,
    _fake: TempDir,
}

fn world() -> World {
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
    let router = router().with_state(t.app.clone());
    World {
        t,
        py,
        models,
        settings,
        router,
        _fake: fake,
    }
}

impl World {
    async fn get(&self, path: &str) -> (u16, Value) {
        let res = http::get(&self.router, path).await;
        (res.status, res.json())
    }

    async fn call(&self, method: &str, path: &str) -> (u16, Value) {
        let res = http::send(&self.router, request(method, path)).await;
        (res.status, res.json())
    }

    async fn until_idle(&self) -> Value {
        for _ in 0..1000 {
            let (_, body) = self.get("/stt").await;
            if body["job"].is_null() {
                return body;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the job never finished");
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
async fn install_202_with_the_job_progress_in_the_status_then_ready_a_second_job_meanwhile_is_a_409() {
    let w = world();
    let (_, s) = w.get("/stt?refresh=1").await;
    assert_eq!(s["runtime"]["state"], "not-installed");
    assert_eq!(s["runtime"]["canInstall"], true);

    let (status, body) = w.call("POST", "/stt/install").await;
    assert_eq!(status, 202);
    assert_eq!(body["job"]["kind"], "install");
    let (status, busy) = w.call("POST", "/stt/models/tiny/download").await;
    assert_eq!(status, 409);
    assert!(busy["error"].as_str().unwrap().contains("installing faster-whisper"), "{busy}");
    assert_eq!(busy["code"], "BUSY");
    let (_, during) = w.get("/stt").await;
    assert_eq!(during["runtime"]["state"], "installing");

    let done = w.until_idle().await;
    assert_eq!(done["runtime"]["state"], "ready", "{}", done["runtime"]["summary"]);
    assert_eq!(model(&done, "base.en")["state"], "downloaded");
}

#[tokio::test]
async fn a_failed_install_says_why_in_the_status_and_try_again_works() {
    let w = world();
    w.py.set(json!({ "pip": { "mode": "no-wheel", "delayMs": 1 } }));
    w.call("POST", "/stt/install").await;
    let s = w.until_idle().await;
    assert_eq!(s["runtime"]["state"], "failed");
    assert!(
        s["runtime"]["error"]
            .as_str()
            .unwrap()
            .contains("no ready-made build of ctranslate2")
    );
    w.py.set(json!({ "pip": { "mode": "ok", "delayMs": 1 } }));
    assert_eq!(w.call("POST", "/stt/install").await.0, 202);
    let s = w.until_idle().await;
    assert_eq!(s["runtime"]["state"], "ready");
}

#[tokio::test]
async fn a_model_s_download_and_delete_an_unknown_model_is_a_400() {
    let w = world();
    let (status, body) = w.call("POST", "/stt/models/small/download").await;
    assert_eq!(status, 202);
    assert_eq!(body["job"]["model"], "small");
    let s = w.until_idle().await;
    assert_eq!(model(&s, "small")["state"], "downloaded");
    let (status, body) = w.call("DELETE", "/stt/models/small").await;
    assert_eq!(status, 200);
    assert_eq!(body["removed"].as_array().unwrap().len(), 1);
    assert_eq!(body["kept"], Value::Null);
    let (_, s) = w.get("/stt").await;
    assert_eq!(model(&s, "small")["state"], "missing");
    let (status, body) = w.call("POST", "/stt/models/..%2F..%2Fetc/download").await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "UNKNOWN_MODEL");
    assert_eq!(w.call("DELETE", "/stt/models/large-v3").await.0, 400);
}

#[tokio::test]
async fn choosing_a_model_that_isn_t_downloaded_starts_its_download() {
    let w = world();
    let res = http::post_json(&w.router, "/stt-model", &json!({ "model": "tiny.en" })).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.json()["downloading"], true);
    assert_eq!(w.settings.get("voice.stt_model"), Some(json!("tiny.en")));
    let s = w.until_idle().await;
    assert_eq!(s["current"], "tiny.en");
    assert_eq!(model(&s, "tiny.en")["state"], "downloaded");
    assert_eq!(
        http::post_json(&w.router, "/stt-model", &json!({ "model": "huge" })).await.status,
        400
    );
}

#[tokio::test]
async fn post_transcribe_with_a_short_wav_answers_with_its_text_what_a_call_uses() {
    let w = world();
    w.py.set(json!({ "pythons": { "python3": { "version": "3.11.2", "packages": { "faster-whisper": "1.2.1" } } } }));
    reset_stt_runtime(&w.t);
    w.models.put(&w.t.path().join("data").join("whisper-models"), "base.en");
    let (_, warm) = w.call("POST", "/stt/warm").await;
    assert_eq!(warm, json!({ "ok": true, "model": "base.en" }));
    let res = http::send(
        &w.router,
        request("POST", "/transcribe")
            .header("content-type", "audio/wav")
            .header("x-language", "en")
            .body(wav(500)),
    )
    .await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(
        res.json(),
        json!({ "text": "hello from a wav", "language": "en", "provider": "faster-whisper (base.en)" })
    );
    // An API client (the owner's token, checked in front of the router) sends the same request.
    let res = http::send(
        &w.router,
        request("POST", "/transcribe")
            .header("content-type", "audio/wav")
            .body(wav(500)),
    )
    .await;
    assert_eq!(res.status, 200, "an API client can transcribe");
}

#[tokio::test]
async fn starting_jobs_is_rate_limited() {
    let w = world();
    let limited = Router::new()
        .nest(
            "/api/voice/stt",
            create_stt_router(Limits {
                max: 2,
                window: Duration::from_secs(60),
            }),
        )
        .with_state(w.t.app.clone());
    let a = http::delete(&limited, "/api/voice/stt/models/tiny").await;
    let b = http::delete(&limited, "/api/voice/stt/models/tiny").await;
    let c = http::delete(&limited, "/api/voice/stt/models/tiny").await;
    assert_eq!([a.status, b.status, c.status], [200, 200, 429]);
    let error = c.json()["error"].as_str().unwrap().to_string();
    assert!(
        regex::Regex::new(r"Wait [0-9]+ seconds").unwrap().is_match(&error),
        "{error}"
    );
    // The status itself is not limited.
    assert_eq!(http::get(&limited, "/api/voice/stt").await.status, 200);
    assert_eq!(stt_job(&w.t), None);
}
