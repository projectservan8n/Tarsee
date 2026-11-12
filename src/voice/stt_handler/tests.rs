//! The parts of stt-handler.js that run no Python: choosing between local transcription and the paid Whisper API
//! (with a stand-in for local, as test/stt-opt-in.test.js does), the Whisper API request itself, and the small pieces.
//! The cases that run the worker (test/stt-local.test.js) are in tests/it/stt_local.rs.

use serde_json::json;

use super::*;
use crate::testkit::{Answer, MemorySettings, TestApp, test_app};

fn store(provider: Option<&str>, key: Option<&str>) -> MemorySettings {
    let mut pairs = Vec::new();
    if let Some(p) = provider {
        pairs.push(("voice.stt_provider".to_string(), json!(p)));
    }
    if let Some(k) = key {
        pairs.push(("ai.openai.apiKey".to_string(), json!(k)));
    }
    MemorySettings::from_pairs(pairs)
}

fn key() -> String {
    format!("sk-{}", "test-canary-stt-0000")
}

fn local_words() -> LocalTranscriber {
    LocalTranscriber::available(true).answering(Ok(SttResult {
        transcript: "local words".into(),
        language: "en".into(),
        provider: "faster-whisper (base.en)".into(),
    }))
}

fn with_local(t: &TestApp, local: LocalTranscriber) {
    set_for_tests(
        t,
        SttTestOverrides {
            local: Some(local),
            ..Default::default()
        },
    );
}

const AUDIO: &[u8] = b"not really audio";

#[tokio::test]
async fn no_paid_call_when_a_key_is_only_in_the_environment_and_local_is_not_installed() {
    let t = test_app();
    t.env().set("OPENAI_API_KEY", key());
    with_local(&t, LocalTranscriber::available(false));
    let err = transcribe_audio(&t, AUDIO, Some("en"), Some(&MemorySettings::new()))
        .await
        .unwrap_err();
    assert_eq!(err.status, Some(501));
    assert_eq!(err.code.as_deref(), Some("stt-unavailable"));
    assert_eq!(
        err.message,
        "Speech-to-text is unavailable: local transcription (faster-whisper) is not installed on this server. Install it in Settings > Voice > Speech-to-text (one click), or choose the paid \"OpenAI Whisper API\" there."
    );
    assert!(t.fetch.calls().is_empty(), "the paid Whisper API was called without the owner choosing it");
}

#[tokio::test]
async fn no_paid_call_when_local_is_chosen_and_fails() {
    let t = test_app();
    with_local(
        &t,
        LocalTranscriber::available(true).answering(Err(SttError::plain("ffmpeg exited 1"))),
    );
    let err = transcribe_audio(&t, AUDIO, Some("en"), Some(&store(Some("local"), Some(&key()))))
        .await
        .unwrap_err();
    assert_eq!((err.status, err.code.as_deref()), (Some(500), Some("stt-failed")));
    assert_eq!(
        err.message,
        "Speech-to-text failed: local transcription (faster-whisper) could not transcribe this audio (the server log has the details). The paid OpenAI Whisper API is off; to use it instead, choose \"OpenAI Whisper API\" in Settings > Voice > Speech-to-text."
    );
    assert!(t.fetch.calls().is_empty());
}

#[tokio::test]
async fn local_words_when_local_works() {
    let t = test_app();
    with_local(&t, local_words());
    let out = transcribe_audio(&t, AUDIO, Some("en"), Some(&store(Some("local"), None)))
        .await
        .unwrap();
    assert_eq!(out.transcript, "local words");
    assert!(t.fetch.calls().is_empty());
}

#[tokio::test]
async fn the_whisper_api_when_the_owner_chose_it_with_the_request_openai_expects() {
    let t = test_app();
    with_local(&t, LocalTranscriber::available(false));
    t.fetch.respond(
        "https://api.openai.com/v1/audio/transcriptions",
        Answer::json(200, json!({"text": "from the paid api"})),
    );
    let out = transcribe_audio(&t, AUDIO, Some("en-US"), Some(&store(Some("whisper-api"), Some(&key()))))
        .await
        .unwrap();
    assert_eq!(
        out,
        SttResult {
            transcript: "from the paid api".into(),
            language: "en".into(),
            provider: "whisper-api".into()
        }
    );
    let calls = t.fetch.calls();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!((call.method.as_str(), call.url.as_str()), ("POST", "https://api.openai.com/v1/audio/transcriptions"));
    assert_eq!(call.header("authorization"), Some(format!("Bearer {}", key()).as_str()));
    let content_type = call.header("content-type").unwrap();
    let boundary = content_type
        .strip_prefix("multipart/form-data; boundary=")
        .unwrap();
    assert!(boundary.starts_with("----TarseeSTTBoundary"));
    let b = boundary;
    assert_eq!(
        call.body,
        format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.webm\"\r\nContent-Type: audio/webm\r\n\r\nnot really audio\r\n--{b}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n--{b}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nen\r\n--{b}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n--{b}--\r\n"
        )
    );
}

#[tokio::test]
async fn the_chosen_whisper_api_is_called_once_not_again_when_it_fails_and_local_is_not_installed() {
    let t = test_app();
    with_local(&t, LocalTranscriber::available(false));
    t.fetch.respond(
        "https://api.openai.com/",
        Answer::text(500, "upstream error"),
    );
    let err = transcribe_audio(&t, AUDIO, Some("en"), Some(&store(Some("whisper-api"), Some(&key()))))
        .await
        .unwrap_err();
    assert_eq!(
        err.message,
        "The OpenAI Whisper API failed (HTTP 500), and local transcription (faster-whisper) is not installed on this server. The server log has the details."
    );
    assert_eq!(err.status, Some(501));
    assert_eq!(t.fetch.calls().len(), 1, "the paid API was retried");
}

#[tokio::test]
async fn falls_back_to_free_local_transcription_when_the_chosen_whisper_api_fails() {
    let t = test_app();
    with_local(&t, local_words());
    t.fetch.respond("https://api.openai.com/", Answer::text(429, "rate limited"));
    let out = transcribe_audio(&t, AUDIO, Some("en"), Some(&store(Some("whisper-api"), Some(&key()))))
        .await
        .unwrap();
    assert_eq!(out.transcript, "local words");
    assert_eq!(t.fetch.calls().len(), 1);
}

#[tokio::test]
async fn says_the_key_is_missing_when_the_whisper_api_is_chosen_without_one() {
    let t = test_app();
    with_local(&t, LocalTranscriber::available(false));
    let err = transcribe_audio(&t, AUDIO, Some("en"), Some(&store(Some("whisper-api"), None)))
        .await
        .unwrap_err();
    assert_eq!(
        err.message,
        "Speech-to-text is set to the OpenAI Whisper API, but no OpenAI API key is saved, and local transcription (faster-whisper) is not installed on this server. Add the key in Settings > Voice > Speech-to-text."
    );
    assert!(t.fetch.calls().is_empty());
}

#[tokio::test]
async fn a_local_answer_in_the_owner_s_words_keeps_its_status_and_gains_the_paid_problem() {
    let t = test_app();
    with_local(
        &t,
        LocalTranscriber::available(true).answering(Err(stt_error("No speech model is downloaded yet.", 503, "stt-unavailable"))),
    );
    let err = transcribe_audio(&t, AUDIO, None, Some(&store(None, None))).await.unwrap_err();
    assert_eq!((err.message.as_str(), err.status), ("No speech model is downloaded yet.", Some(503)));
    t.fetch.respond("https://api.openai.com/", Answer::connect_error("down"));
    let err = transcribe_audio(&t, AUDIO, None, Some(&store(Some("whisper-api"), Some(&key()))))
        .await
        .unwrap_err();
    assert_eq!(
        err.message,
        "The OpenAI Whisper API failed. No speech model is downloaded yet."
    );
    assert_eq!((err.status, err.code.as_deref()), (Some(503), Some("stt-unavailable")));
}

#[tokio::test]
async fn without_a_stand_in_and_without_faster_whisper_it_is_a_501_that_says_where_to_install_it() {
    let t = test_app();
    // No Python to try at all.
    crate::voice::python_runtime::set_for_tests(
        &t,
        crate::voice::python_runtime::PythonOverrides {
            spawn: None,
            candidates: Some(vec![]),
        },
    );
    let err = transcribe_audio(&t, AUDIO, Some("en"), None).await.unwrap_err();
    assert_eq!((err.status, err.code.as_deref()), (Some(501), Some("stt-unavailable")));
    assert!(err.message.contains("not installed"));
    assert_eq!(
        warm_stt(&t, None).await,
        json!({"ok": false, "error": format!("{NOT_INSTALLED}. {INSTALL_OR_PAID}")})
    );
    let paid = store(Some("whisper-api"), None);
    assert_eq!(
        warm_stt(&t, Some(&paid)).await,
        json!({"ok": true, "model": null, "skipped": "the OpenAI Whisper API is chosen"})
    );
}

#[test]
fn the_audio_kind_comes_from_its_first_bytes() {
    assert_eq!(audio_ext(b"RIFF\0\0\0\0WAVE"), ".wav");
    assert_eq!(audio_ext(b"OggS\0"), ".ogg");
    assert_eq!(audio_ext(&[0x1a, 0x45, 0xdf, 0xa3, 0]), ".webm");
    assert_eq!(audio_ext(b"\0\0\0\x18ftypM4A "), ".m4a");
    assert_eq!(audio_ext(b"ID3\x04"), ".mp3");
    assert_eq!(audio_ext(&[0xff, 0xfb, 0x90]), ".mp3");
    assert_eq!(audio_ext(b"xy"), ".audio");
    assert_eq!(audio_ext(b""), ".audio");
}

#[test]
fn a_recording_gets_time_for_the_model_to_load_and_about_real_time() {
    let t = test_app();
    assert_eq!(timeout_for(&t, "base.en", 0), Duration::from_millis(50_000));
    // 160 KB of Opus is ten seconds: base takes 0.6 s a second.
    assert_eq!(timeout_for(&t, "base", 160_000), Duration::from_millis(56_000));
    assert_eq!(timeout_for(&t, "small.en", 160_000), Duration::from_millis(65_000));
    assert_eq!(timeout_for(&t, "tiny", 160_000), Duration::from_millis(53_000));
    assert_eq!(timeout_for(&t, "small", 1 << 30), Duration::from_millis(600_000));
    set_for_tests(
        &t,
        SttTestOverrides {
            timeout_ms: Some(400),
            ..Default::default()
        },
    );
    assert_eq!(timeout_for(&t, "small", 1 << 30), Duration::from_millis(400));
    set_for_tests(&t, SttTestOverrides::default());
    assert!(!t.has::<SttTestOverrides>());
}

#[test]
fn the_silence_is_a_tenth_of_a_second_of_16_khz_wav() {
    let wav = silence_wav();
    assert_eq!(wav.len(), 3244);
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(&wav[8..16], b"WAVEfmt ");
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
    assert_eq!(&wav[36..40], b"data");
    assert!(wav[44..].iter().all(|b| *b == 0));
    assert_eq!(last_line("a\r\n  b \r\n\r\n"), "b");
    assert_eq!(last_line(""), "");
    reset_stt_model_cache();
}
