//! The voice routes that run no Python: Phonon's settings, the engine in use, text-to-speech, uploads, cloning and the
//! transcription routes' own answers (with a stand-in for local transcription). test/stt-routes.test.js, which runs
//! the installer and the worker against the fake Python, is in tests/it/stt_routes.rs.

use async_trait::async_trait;
use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::*;
use crate::testkit::http::{self, TestResponse, request};
use crate::testkit::{MemorySettings, TestApp, test_app};
use crate::voice::engine_registry::set_tts_engine;
use crate::voice::stt_handler::{LocalTranscriber, SttResult, SttTestOverrides, set_for_tests as set_stt};
use crate::voice::tts_interface::{ClonedVoice, Synthesized, TtsEngine, TtsError, VoiceInfo};

struct Fake {
    name: &'static str,
    fail: Option<TtsError>,
    warm_fails: bool,
    said: Mutex<Vec<(String, Option<String>)>>,
}

impl Fake {
    fn new(name: &'static str) -> Arc<Fake> {
        Arc::new(Fake {
            name,
            fail: None,
            warm_fails: false,
            said: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl TtsEngine for Fake {
    fn name(&self) -> &str {
        self.name
    }
    async fn is_available(&self) -> bool {
        true
    }
    async fn synthesize(&self, text: &str, voice_id: Option<&str>, _: &SynthOptions) -> Result<Synthesized, TtsError> {
        self.said.lock().push((text.to_string(), voice_id.map(str::to_string)));
        if let Some(err) = &self.fail {
            return Err(err.clone());
        }
        Ok(Synthesized {
            audio: Bytes::from(format!("RIFF:{text}")),
            content_type: "audio/mpeg".into(),
        })
    }
    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        Ok(vec![VoiceInfo::new("v1", "Voice One")])
    }
    async fn clone_voice(&self, _audio: &[u8], name: &str) -> Result<ClonedVoice, TtsError> {
        Ok(ClonedVoice {
            voice_id: Some(format!("clone-{name}")),
            name: name.to_string(),
        })
    }
    async fn warm(&self) -> Result<(), TtsError> {
        if self.warm_fails {
            return Err(TtsError::new("Phonon worker did not start"));
        }
        Ok(())
    }
}

fn app() -> (TestApp, Router) {
    let t = test_app();
    let none = t.path().join("phonon-none");
    t.env().set("TARSEE_PHONON_DIR", none.to_string_lossy().to_string());
    let router = router().with_state(t.app.clone());
    (t, router)
}

fn with_store(t: &TestApp, pairs: &[(&str, Value)]) -> Arc<MemorySettings> {
    let store = Arc::new(MemorySettings::from_pairs(
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())),
    ));
    let dynamic: Arc<dyn Settings> = store.clone();
    t.app.set(dynamic);
    store
}

/// A multipart form: (field, file name, bytes).
fn form(parts: &[(&str, Option<&str>, &[u8])]) -> (String, Vec<u8>) {
    let boundary = "----tarsee-test-boundary";
    let mut body = Vec::new();
    for (name, file, data) in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match file {
            Some(file) => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{file}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
            ),
            None => body.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes()),
        }
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn post_form(router: &Router, path: &str, parts: &[(&str, Option<&str>, &[u8])]) -> TestResponse {
    let (content_type, body) = form(parts);
    http::send(
        router,
        request("POST", path).header("content-type", content_type).body(body),
    )
    .await
}

async fn post_raw(router: &Router, path: &str, content_type: &str, body: impl Into<Body>) -> TestResponse {
    http::send(
        router,
        request("POST", path).header("content-type", content_type).body(body),
    )
    .await
}

// ── Phonon ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn phonon_s_settings_with_its_voices_and_install_status() {
    let (t, router) = app();
    let res = http::get(&router, "/phonon").await;
    assert_eq!(res.status, 200);
    let body = res.json();
    assert_eq!(
        body["install"],
        json!({ "state": "not-installed", "installed": false, "phase": null, "file": null, "percent": 0, "error": null, "startedAt": null, "finishedAt": null })
    );
    assert_eq!(body["active"], false);
    assert_eq!(body["voices"].as_array().unwrap().len(), 25);
    assert_eq!(
        body["voices"][0],
        json!({ "id": "toby", "name": "Toby (British male, adult)" })
    );
    assert_eq!(
        (body["voice"].clone(), body["speed"].clone()),
        (json!("toby"), json!(1))
    );
    assert!(res.text().contains("\"speed\":1,"), "1, not 1.0: {}", res.text());
    assert_eq!(
        (body["speedMin"].clone(), body["speedMax"].clone()),
        (json!(0.85), json!(1.25))
    );
    assert_eq!(body["barePeso"], false);

    with_store(
        &t,
        &[
            ("voice.phonon.voice", json!("Harper")),
            ("voice.phonon.speed", json!("1.3")),
            ("voice.phonon.barePeso", json!("true")),
        ],
    );
    set_tts_engine(&t, Fake::new("phonon"));
    let body = http::get(&router, "/phonon").await.json();
    assert_eq!(body["voice"], "harper");
    assert_eq!(body["speed"], json!(1.25));
    assert_eq!(body["barePeso"], true);
    assert_eq!(body["active"], true);
}

#[tokio::test]
async fn installing_phonon_answers_at_once_and_the_status_says_how_it_went() {
    let (t, router) = app();
    // A Python that is not there: the install fails at its first step, without running anything.
    let python = t.path().join("no-such-python").to_string_lossy().to_string();
    t.env().set("TARSEE_PHONON_PYTHON", python.clone());
    let res = http::send(&router, request("POST", "/phonon/install")).await;
    assert_eq!(res.status, 202);
    assert_eq!(res.json()["state"], "installing");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let st = http::get(&router, "/phonon").await.json();
        if st["install"]["state"] != "installing" {
            assert_eq!(st["install"]["state"], "failed");
            assert_eq!(
                st["install"]["error"],
                json!(format!(
                    "TARSEE_PHONON_PYTHON ({python}) cannot import ptts. Install it there: {python} -m pip install ptts==0.4.2"
                ))
            );
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the install never ended");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// ── The engine ───────────────────────────────────────────────────────────

#[tokio::test]
async fn warm_is_a_no_op_for_engines_without_a_worker_and_says_when_one_did_not_start() {
    let (t, router) = app();
    let res = http::send(&router, request("POST", "/warm")).await;
    assert_eq!(res.json(), json!({ "ok": true, "engine": "stub", "warmed": false }));
    set_tts_engine(&t, Fake::new("phonon"));
    let res = http::send(&router, request("POST", "/warm")).await;
    assert_eq!(res.json(), json!({ "ok": true, "engine": "phonon", "warmed": true }));
    set_tts_engine(
        &t,
        Arc::new(Fake {
            warm_fails: true,
            ..Arc::try_unwrap(Fake::new("phonon")).ok().unwrap()
        }),
    );
    let res = http::send(&router, request("POST", "/warm")).await;
    assert_eq!(
        res.json(),
        json!({ "ok": false, "engine": "phonon", "error": "Phonon worker did not start" })
    );
}

#[tokio::test]
async fn status_and_voices_list_the_engine_s_voices_and_the_cloned_ones() {
    let (t, router) = app();
    assert_eq!(
        http::get(&router, "/status").await.json(),
        json!({ "tts": { "engine": "stub", "available": false }, "stt": { "whisper": "no key" }, "voices": [] })
    );
    set_tts_engine(&t, Fake::new("elevenlabs"));
    t.env().set("OPENAI_API_KEY", "k-test");
    assert_eq!(
        http::get(&router, "/status").await.json(),
        json!({
            "tts": { "engine": "elevenlabs", "available": true },
            "stt": { "whisper": "key set" },
            "voices": [{ "id": "v1", "name": "Voice One", "isClone": false }],
        })
    );
    clone_voice(&t, b"RIFF", "Me").await.unwrap();
    assert_eq!(
        http::get(&router, "/voices").await.json(),
        json!({ "voices": [
            { "id": "v1", "name": "Voice One", "isClone": false },
            { "id": "clone-Me", "name": "Me", "isClone": true, "engine": "elevenlabs" },
        ] })
    );
}

#[tokio::test]
async fn text_to_speech_answers_with_the_audio_and_its_type_and_length() {
    let (t, router) = app();
    let engine = Fake::new("edge-tts");
    set_tts_engine(&t, engine.clone());
    let res = http::post_json(
        &router,
        "/tts",
        &json!({ "text": "Hello", "voiceId": "en-US-AvaNeural" }),
    )
    .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("content-type"), Some("audio/mpeg"));
    assert_eq!(res.header("content-length"), Some("10"));
    assert_eq!(res.text(), "RIFF:Hello");
    assert_eq!(
        engine.said.lock()[0],
        ("Hello".to_string(), Some("en-US-AvaNeural".to_string()))
    );

    for body in [json!({}), json!({ "text": "" }), json!({ "text": 5 })] {
        let res = http::post_json(&router, "/tts", &body).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({ "error": "Text is required" })),
            "{body}"
        );
    }
    // 2,501 emoji are 5,002 characters to JavaScript.
    let res = http::post_json(&router, "/tts", &json!({ "text": "🐒".repeat(2501) })).await;
    assert_eq!(res.json(), json!({ "error": "Text too long (max 5000 characters)" }));
    let res = http::post_json(&router, "/tts", &json!({ "text": "🐒".repeat(2500) })).await;
    assert_eq!(res.status, 200);
}

#[tokio::test]
async fn an_engine_s_failure_is_its_status_or_a_500() {
    let (t, router) = app();
    let failing = |status: Option<u16>| {
        Arc::new(Fake {
            fail: Some(TtsError {
                message: "nope".into(),
                status,
                code: None,
            }),
            ..Arc::try_unwrap(Fake::new("edge-tts")).ok().unwrap()
        })
    };
    set_tts_engine(&t, failing(Some(400)));
    let res = http::post_json(&router, "/tts", &json!({ "text": "Hi" })).await;
    assert_eq!((res.status, res.json()), (400, json!({ "error": "nope" })));
    set_tts_engine(&t, failing(None));
    let res = http::post_json(&router, "/tts", &json!({ "text": "Hi" })).await;
    assert_eq!(res.status, 500);
    // The streaming route answers 500 whatever the engine said.
    set_tts_engine(&t, failing(Some(400)));
    let res = http::post_json(&router, "/tts-stream", &json!({ "text": "Hi" })).await;
    assert_eq!((res.status, res.json()), (500, json!({ "error": "nope" })));
}

#[tokio::test]
async fn the_streaming_route_speaks_whole_with_an_engine_that_cannot_stream() {
    let (t, router) = app();
    set_tts_engine(&t, Fake::new("phonon"));
    let res = http::post_json(&router, "/tts-stream", &json!({ "text": "Hi there" })).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("content-type"), Some("audio/mpeg"));
    assert_eq!(res.text(), "RIFF:Hi there");
    let res = http::post_json(&router, "/tts-stream", &json!({})).await;
    assert_eq!((res.status, res.json()), (400, json!({ "error": "Text is required" })));
}

// ── Speech-to-text ───────────────────────────────────────────────────────

fn words(t: &TestApp) {
    set_stt(
        t,
        SttTestOverrides {
            local: Some(LocalTranscriber::available(true).answering(Ok(SttResult {
                transcript: "hello".into(),
                language: "en".into(),
                provider: "faster-whisper (base.en)".into(),
            }))),
            ..Default::default()
        },
    );
}

#[tokio::test]
async fn transcribe_takes_the_audio_as_the_body_or_as_a_form_s_audio_file() {
    let (t, router) = app();
    words(&t);
    let want = json!({ "text": "hello", "language": "en", "provider": "faster-whisper (base.en)" });
    let res = post_raw(&router, "/transcribe", "audio/wav", b"RIFF....".to_vec()).await;
    assert_eq!((res.status, res.json()), (200, want.clone()));
    let res = post_form(
        &router,
        "/transcribe",
        &[("other", Some("x.txt"), b"x"), ("audio", Some("a.webm"), b"OggS")],
    )
    .await;
    assert_eq!((res.status, res.json()), (200, want.clone()));
    let res = post_raw(&router, "/stt", "audio/wav", b"RIFF".to_vec()).await;
    assert_eq!((res.status, res.json()), (200, want));

    let res = post_form(&router, "/transcribe", &[("audio", None, b"not a file")]).await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({ "error": "No audio file provided" }))
    );
    let res = post_raw(&router, "/transcribe", "audio/wav", Vec::new()).await;
    assert_eq!((res.status, res.json()), (400, json!({ "error": "Empty audio" })));
}

#[tokio::test]
async fn audio_over_25_mb_is_a_413() {
    let (t, router) = app();
    words(&t);
    let big = vec![0u8; limits::VOICE_SAMPLE_MAX_BYTES + 1];
    let res = post_raw(&router, "/stt", "audio/wav", big.clone()).await;
    assert_eq!((res.status, res.json()), (413, json!({ "error": "Audio too large" })));
    let res = post_form(&router, "/transcribe", &[("audio", Some("a.wav"), &big)]).await;
    assert_eq!((res.status, res.json()), (413, json!({ "error": "Audio too large" })));
    let res = post_form(&router, "/clone", &[("audio", Some("a.wav"), &big)]).await;
    assert_eq!(
        (res.status, res.json()),
        (413, json!({ "error": "Audio sample too large (max 25MB)" }))
    );
    // Exactly the limit is fine.
    let res = post_raw(&router, "/stt", "audio/wav", vec![0u8; limits::VOICE_SAMPLE_MAX_BYTES]).await;
    assert_eq!(res.status, 200);
}

#[tokio::test]
async fn a_transcription_error_answers_with_its_status() {
    let (t, router) = app();
    set_stt(
        &t,
        SttTestOverrides {
            local: Some(LocalTranscriber::available(false)),
            ..Default::default()
        },
    );
    let res = post_raw(&router, "/transcribe", "audio/wav", b"RIFF".to_vec()).await;
    assert_eq!(res.status, 501);
    assert!(
        res.json()["error"]
            .as_str()
            .unwrap()
            .starts_with("Speech-to-text is unavailable")
    );
}

#[tokio::test]
async fn choosing_a_model_needs_one_of_the_real_names() {
    let (t, router) = app();
    let res = http::post_json(&router, "/stt-model", &json!({ "model": "huge" })).await;
    assert_eq!(
        (res.status, res.json()),
        (
            400,
            json!({ "error": "Invalid model. Valid: tiny.en, base.en, small.en, tiny, base, small" })
        )
    );
    let res = http::post_json(&router, "/stt-model", &json!({ "model": "tiny" })).await;
    assert_eq!(
        res.status, 500,
        "no settings store: what Express's error handler answered"
    );
    let store = with_store(&t, &[]);
    t.fetch
        .respond("https://huggingface.co/", crate::testkit::Answer::text(404, "no"));
    let res = http::post_json(&router, "/stt-model", &json!({ "model": "tiny" })).await;
    assert_eq!(res.json(), json!({ "ok": true, "model": "tiny", "downloading": true }));
    assert_eq!(store.get("voice.stt_model"), Some(json!("tiny")));
    let models = http::get(&router, "/stt-models").await.json();
    assert_eq!(models["current"], "tiny");
    assert_eq!(models["models"].as_array().unwrap().len(), 6);
}

#[tokio::test]
async fn the_installer_routes_are_rate_limited_per_address() {
    let (_t, _) = app();
    let limiter = Limiter::new(Limits {
        max: 2,
        window: Duration::from_secs(60),
    });
    assert!(limiter.check("1.2.3.4").is_none());
    assert!(limiter.check("1.2.3.4").is_none());
    let refused = limiter.check("1.2.3.4").unwrap();
    assert_eq!(refused.status(), 429);
    assert_eq!(refused.headers().get("retry-after").unwrap(), "60");
    assert!(limiter.check("5.6.7.8").is_none(), "another address has its own count");

    let req = |xff: Option<&str>| {
        let mut b = axum::http::Request::builder().uri("/");
        if let Some(x) = xff {
            b = b.header("x-forwarded-for", x);
        }
        b.body(Body::empty()).unwrap()
    };
    assert_eq!(client_key(&req(Some("10.0.0.1, 203.0.113.9"))), "203.0.113.9");
    assert_eq!(client_key(&req(None)), "?");
}

// ── Piper voices and cloning ─────────────────────────────────────────────

#[tokio::test]
async fn a_piper_voice_is_uploaded_listed_and_deleted_and_only_by_a_plain_id() {
    let (t, router) = app();
    let res = post_form(
        &router,
        "/piper-upload",
        &[
            ("name", None, b"  My Voice "),
            ("onnx", Some("m.onnx"), b"model"),
            ("json", Some("m.onnx.json"), b"{}"),
        ],
    )
    .await;
    assert_eq!(
        (res.status, res.json()),
        (201, json!({ "id": "my-voice", "name": "My Voice" }))
    );
    let listed = http::get(&router, "/piper-voices").await.json();
    assert_eq!(listed["voices"][0]["id"], "my-voice");

    // A name from the request never leads out of the voices folder.
    let outside = t.path().join("outside.onnx");
    std::fs::write(&outside, "keep").unwrap();
    for id in ["..%2Foutside", "%2E%2E", "C%3A%5Cx", "%2Fetc%2Fx"] {
        let res = http::delete(&router, &format!("/piper-voices/{id}")).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({ "error": "Invalid voice id" })),
            "{id}"
        );
    }
    assert!(outside.exists());

    let res = http::delete(&router, "/piper-voices/my-voice").await;
    assert_eq!(res.json(), json!({ "ok": true }));
    assert_eq!(
        http::get(&router, "/piper-voices").await.json(),
        json!({ "voices": [] })
    );

    let res = post_form(&router, "/piper-upload", &[("onnx", Some("m.onnx"), b"model")]).await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({ "error": "Missing .onnx.json file (field: 'json')" }))
    );
    let res = post_raw(&router, "/piper-upload", "application/json", b"{}".to_vec()).await;
    assert_eq!(
        (res.status, res.json()),
        (500, json!({ "error": "Unsupported content type: application/json" }))
    );
    let res = http::send(&router, request("POST", "/piper-upload")).await;
    assert_eq!(
        (res.status, res.json()),
        (500, json!({ "error": "Missing Content-Type" }))
    );
}

#[tokio::test]
async fn a_voice_is_cloned_from_a_form_or_from_the_raw_audio() {
    let (t, router) = app();
    set_tts_engine(&t, Fake::new("elevenlabs"));
    let res = post_form(
        &router,
        "/clone",
        &[("name", None, b" Mine "), ("audio", Some("a.wav"), b"RIFF")],
    )
    .await;
    assert_eq!(
        (res.status, res.json()),
        (201, json!({ "voiceId": "clone-Mine", "name": "Mine" }))
    );
    let res = post_form(&router, "/clone", &[("audio", Some("a.wav"), b"RIFF")]).await;
    assert_eq!(res.json()["name"], "Custom Voice");
    let res = post_form(&router, "/clone", &[("name", None, b"x")]).await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({ "error": "No audio file provided" }))
    );

    let res = http::send(
        &router,
        request("POST", "/clone?name=Query")
            .header("x-voice-name", "Header")
            .body(b"RIFF".to_vec()),
    )
    .await;
    assert_eq!(res.json(), json!({ "voiceId": "clone-Header", "name": "Header" }));
    let res = http::send(&router, request("POST", "/clone?name=Query").body(b"RIFF".to_vec())).await;
    assert_eq!(res.json()["name"], "Query");
    let res = http::send(&router, request("POST", "/clone").body(b"RIFF".to_vec())).await;
    assert_eq!(res.json()["name"], "Custom Voice");
    let res = http::send(&router, request("POST", "/clone?name=a&name=b").body(b"RIFF".to_vec())).await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({ "error": "Voice name is required" }))
    );
    let res = http::send(&router, request("POST", "/clone").body(Vec::<u8>::new())).await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({ "error": "Audio sample is required" }))
    );
}

#[test]
fn a_plain_name_is_one_piece_of_a_path() {
    for ok in ["my-voice", "a.b", "en_US-amy-medium"] {
        assert!(plain_name(ok), "{ok}");
    }
    for bad in ["", ".", "..", "../x", "a/b", "a\\b", "C:x", "/etc", "\\\\server\\x"] {
        assert!(!plain_name(bad), "{bad}");
    }
}
