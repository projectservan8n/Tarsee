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
async fn installing_phonon_answers_at_once_with_the_run_s_fresh_status_and_a_retry_starts_afresh() {
    let (t, router) = app();
    // A Python that is not there: the install fails at its first step, without running anything.
    let python = t.path().join("no-such-python").to_string_lossy().to_string();
    t.env().set("TARSEE_PHONON_PYTHON", python.clone());
    let failure = format!(
        "TARSEE_PHONON_PYTHON ({python}) cannot import ptts. Install it there: {python} -m pip install ptts==0.4.2"
    );
    let mut started = Vec::new();
    for attempt in ["first", "retry"] {
        let res = http::send(&router, request("POST", "/phonon/install")).await;
        assert_eq!(res.status, 202, "{attempt}");
        let first = res.json();
        // What the JS run had already set before the route answered.
        assert_eq!(first["state"], "installing", "{attempt}");
        assert_eq!(first["phase"], "runtime", "{attempt}: {first}");
        assert_eq!((first["file"].clone(), first["error"].clone()), (Value::Null, Value::Null));
        assert_eq!((first["percent"].clone(), first["finishedAt"].clone()), (json!(0), Value::Null), "{attempt}");
        let at = first["startedAt"].as_str().expect("the run's start time").to_string();
        assert!(crate::util::js::ms_from_iso(&at).is_some(), "{at}");
        started.push(at);
        // The run that is going (asking again shares it): wait for its end, not for the clock.
        let err = install_phonon(&t, InstallOptions::default()).await.unwrap_err();
        assert_eq!(err.message, failure);
        let st = http::get(&router, "/phonon").await.json();
        assert_eq!(st["install"]["state"], "failed");
        assert_eq!(st["install"]["error"], json!(failure));
        assert!(st["install"]["finishedAt"].is_string());
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
    // `!!sStore?.getApiKey?.("openai")`: with no settings store there is no key, not even the environment's.
    assert_eq!(
        http::get(&router, "/status").await.json()["stt"],
        json!({ "whisper": "no key" })
    );
    with_store(&t, &[]);
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
fn a_path_parameter_decodes_as_decode_uri_component_does() {
    assert_eq!(decode_uri_component("a%20b").as_deref(), Some("a b"));
    assert_eq!(decode_uri_component("..%2F..%2Fetc").as_deref(), Some("../../etc"));
    assert_eq!(decode_uri_component("%C3%A9").as_deref(), Some("é"));
    assert_eq!(decode_uri_component("a+b").as_deref(), Some("a+b"));
    assert_eq!(decode_uri_component("%00").as_deref(), Some("\0"));
    for bad in ["%FF", "%zz", "%", "%2", "%+1", "%C3", "%ED%A0%80"] {
        assert_eq!(decode_uri_component(bad), None, "{bad}");
    }
}

#[tokio::test]
async fn a_path_parameter_that_does_not_decode_is_express_s_400_in_json() {
    let (_t, router) = app();
    for (method, path, raw) in [
        ("DELETE", "/piper-voices/%FF", "%FF"),
        ("POST", "/stt/models/%FF/download", "%FF"),
        ("DELETE", "/stt/models/a%C3", "a%C3"),
    ] {
        let res = http::send(&router, request(method, path)).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({ "error": format!("Failed to decode param '{raw}'") })),
            "{method} {path}"
        );
    }
    // It decodes, but it is no plain name.
    let res = http::delete(&router, "/piper-voices/%00").await;
    assert_eq!(res.json(), json!({ "error": "Invalid voice id" }));
    let res = http::send(&router, request("POST", "/stt/models/..%2F..%2Fetc/download")).await;
    assert_eq!(res.status, 400);
    assert_eq!(res.json()["code"], "UNKNOWN_MODEL");
}

/// A multipart body from raw parts: (Content-Disposition parameters after `form-data`, the part's Content-Type, data).
fn raw_form(parts: &[(&str, Option<&str>, &[u8])]) -> (String, Vec<u8>) {
    let boundary = "----tarsee-raw-boundary";
    let mut body = Vec::new();
    for (disposition, content_type, data) in parts {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; {disposition}\r\n").as_bytes());
        if let Some(t) = content_type {
            body.extend_from_slice(format!("Content-Type: {t}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn post_raw_form(router: &Router, path: &str, parts: &[(&str, Option<&str>, &[u8])]) -> TestResponse {
    let (content_type, body) = raw_form(parts);
    post_raw(router, path, &content_type, body).await
}

/// A stand-in for local transcription that says how many bytes it was given.
fn counting(t: &TestApp) {
    let transcribe: crate::voice::stt_handler::TranscribeFn = Arc::new(|audio: Bytes| {
        Box::pin(async move {
            Ok(SttResult {
                transcript: format!("{} bytes", audio.len()),
                language: "en".into(),
                provider: "faster-whisper (base.en)".into(),
            })
        })
    });
    set_stt(
        t,
        SttTestOverrides {
            local: Some(LocalTranscriber {
                transcribe: Some(transcribe),
                ..LocalTranscriber::available(true)
            }),
            ..Default::default()
        },
    );
}

#[tokio::test]
async fn a_part_is_a_file_when_it_has_a_file_name_or_the_octet_stream_type_as_busboy_said() {
    let (t, router) = app();
    counting(&t);
    // No file name, but sent as application/octet-stream: a file.
    let octet = [("name=\"audio\"", Some("application/octet-stream"), &b"RIFF"[..])];
    let res = post_raw_form(&router, "/transcribe", &octet).await;
    assert_eq!((res.status, res.json()["text"].clone()), (200, json!("4 bytes")));
    // An empty file name is no file name: a field.
    let empty_name = [("name=\"audio\"; filename=\"\"", None, &b"RIFF"[..])];
    let res = post_raw_form(&router, "/transcribe", &empty_name).await;
    assert_eq!((res.status, res.json()), (400, json!({ "error": "No audio file provided" })));
    let named = [("name=\"audio\"; filename=\"a.wav\"", Some("audio/wav"), &b"RIFFxx"[..])];
    let res = post_raw_form(&router, "/transcribe", &named).await;
    assert_eq!(res.json()["text"], "6 bytes");
    // The same rule for a Piper upload.
    let piper = [
        ("name=\"onnx\"", Some("application/octet-stream"), &b"model"[..]),
        ("name=\"json\"; filename=\"v.onnx.json\"", Some("application/json"), &b"{}"[..]),
    ];
    let res = post_raw_form(&router, "/piper-upload", &piper).await;
    assert_eq!(
        (res.status, res.json()),
        (201, json!({ "id": "custom-voice", "name": "custom-voice" }))
    );
}

#[tokio::test]
async fn a_json_body_on_an_audio_route_is_no_audio_as_express_json_left_it() {
    let (t, router) = app();
    counting(&t);
    set_tts_engine(&t, Fake::new("elevenlabs"));
    let res = post_raw(&router, "/stt", "application/json", b"{\"a\": 1}".to_vec()).await;
    assert_eq!((res.status, res.json()["text"].clone()), (200, json!("0 bytes")));
    let res = post_raw(&router, "/stt", "application/json", b"{x".to_vec()).await;
    assert_eq!(res.status, 400, "not JSON: express.json's 400");
    let res = post_raw(&router, "/transcribe", "application/json", b"{\"a\": 1}".to_vec()).await;
    assert_eq!((res.status, res.json()), (400, json!({ "error": "Empty audio" })));
    let res = post_raw(&router, "/clone", "application/json", b"{\"a\": 1}".to_vec()).await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({ "error": "Audio sample is required" }))
    );
    assert!(list_voice_profiles(t.db()).unwrap().is_empty());
}

#[tokio::test]
async fn the_streaming_route_hands_on_a_value_that_is_not_text_as_each_engine_read_it() {
    let (t, router) = app();
    // Phonon read it with String(value).
    set_tts_engine(&t, Fake::new("phonon"));
    for (text, said) in [
        (json!(5), "RIFF:5"),
        (json!(["a", "b"]), "RIFF:a,b"),
        (json!({ "k": 1 }), "RIFF:[object Object]"),
    ] {
        let res = http::post_json(&router, "/tts-stream", &json!({ "text": text })).await;
        assert_eq!((res.status, res.text()), (200, said.to_string()), "{text}");
    }
    // Edge TTS and Piper called a string method on it, which threw.
    for name in ["edge-tts", "piper"] {
        let engine = Fake::new(name);
        set_tts_engine(&t, engine.clone());
        let res = http::post_json(&router, "/tts-stream", &json!({ "text": 5 })).await;
        assert_eq!(
            (res.status, res.json()),
            (500, json!({ "error": "text.replace is not a function" })),
            "{name}"
        );
        assert!(engine.said.lock().is_empty());
    }
}

#[tokio::test]
async fn a_form_field_keeps_its_first_megabyte_and_an_urlencoded_upload_has_no_files() {
    let (t, router) = app();
    set_tts_engine(&t, Fake::new("elevenlabs"));
    let long = vec![b'a'; FIELD_SIZE + 100];
    let res = post_form(
        &router,
        "/clone",
        &[("name", None, &long), ("audio", Some("a.wav"), b"RIFF")],
    )
    .await;
    assert_eq!(res.status, 201);
    assert_eq!(res.json()["name"].as_str().unwrap().len(), FIELD_SIZE);
    let res = post_raw(
        &router,
        "/piper-upload",
        "application/x-www-form-urlencoded",
        b"name=x&onnx=model&json=%7B%7D".to_vec(),
    )
    .await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({ "error": "Missing .onnx file (field: 'onnx')" }))
    );
}

/// An engine that says when a request has reached it, waits for the test to let it go on, then says it finished.
struct Gated {
    reached: Arc<tokio::sync::Notify>,
    gate: Arc<tokio::sync::Notify>,
    finished: Arc<tokio::sync::Notify>,
}

impl Gated {
    async fn pass(&self) {
        self.reached.notify_one();
        self.gate.notified().await;
    }
}

#[async_trait]
impl TtsEngine for Gated {
    fn name(&self) -> &str {
        "edge-tts"
    }
    async fn synthesize(&self, text: &str, _: Option<&str>, _: &SynthOptions) -> Result<Synthesized, TtsError> {
        self.pass().await;
        self.finished.notify_one();
        Ok(Synthesized {
            audio: Bytes::from(text.to_string()),
            content_type: "audio/mpeg".into(),
        })
    }
    async fn clone_voice(&self, _audio: &[u8], name: &str) -> Result<ClonedVoice, TtsError> {
        self.pass().await;
        Ok(ClonedVoice {
            voice_id: Some(format!("clone-{name}")),
            name: name.to_string(),
        })
    }
}

/// Runs a request until the engine has it, then lets the client go away.
async fn leave_once_reached(request: impl std::future::Future<Output = TestResponse>, reached: &tokio::sync::Notify) {
    tokio::pin!(request);
    tokio::select! {
        _ = &mut request => panic!("the request ended before the engine had it"),
        _ = reached.notified() => {}
    }
}

#[tokio::test]
async fn a_sentence_or_a_clone_whose_client_leaves_still_runs_to_its_end() {
    let (t, router) = app();
    let engine = Arc::new(Gated {
        reached: Arc::new(tokio::sync::Notify::new()),
        gate: Arc::new(tokio::sync::Notify::new()),
        finished: Arc::new(tokio::sync::Notify::new()),
    });
    set_tts_engine(&t, engine.clone());

    leave_once_reached(http::post_json(&router, "/tts", &json!({ "text": "Hi" })), &engine.reached).await;
    engine.gate.notify_one();
    engine.finished.notified().await;

    // A clone's profile is saved all the same.
    let (content_type, body) = form(&[("name", None, b"Mine"), ("audio", Some("a.wav"), b"RIFF")]);
    let cloning = http::send(&router, request("POST", "/clone").header("content-type", content_type).body(body));
    leave_once_reached(cloning, &engine.reached).await;
    engine.gate.notify_one();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while list_voice_profiles(t.db()).unwrap().is_empty() {
        assert!(std::time::Instant::now() < deadline, "the clone was never saved");
        tokio::task::yield_now().await;
    }
    assert_eq!(list_voice_profiles(t.db()).unwrap()[0].id, "clone-Mine");
}
