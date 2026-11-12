//! Port of `src/voice/elevenlabs-engine.js`: the ElevenLabs TTS engine, cloud-based, works on Railway.
//!
//! Supports:
//! - Text-to-speech with any voice
//! - Instant voice cloning from audio samples
//! - Voice listing (library + cloned)
//!
//! Requires: ELEVENLABS_API_KEY in env or voice.elevenlabs.apiKey in settings.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::tts_interface::{AudioStream, ClonedVoice, SynthOptions, Synthesized, TtsEngine, TtsError, VoiceInfo};
use crate::net::fetch::{Fetch, FetchRequest};
use crate::util::js::utf16_truncate;

const BASE_URL: &str = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL: &str = "eleven_flash_v2_5";
/// Kuya Kaf
pub const DEFAULT_ELEVENLABS_VOICE: &str = "wNl2YBRc8v5uIcq6gOxd";
/// Rachel: the voice when none is set at all.
const RACHEL: &str = "21m00Tcm4TlvDq8ikWAM";

pub struct ElevenLabsTtsEngine {
    fetch: Arc<dyn Fetch>,
    api_key: Option<String>,
    model_id: String,
    default_voice: String,
}

impl ElevenLabsTtsEngine {
    /// `model_id` and `default_voice` fall back to eleven_flash_v2_5 and Kuya Kaf when `None` or empty.
    pub fn new(
        fetch: Arc<dyn Fetch>,
        api_key: Option<String>,
        model_id: Option<String>,
        default_voice: Option<String>,
    ) -> Self {
        ElevenLabsTtsEngine {
            fetch,
            api_key: api_key.filter(|k| !k.is_empty()),
            model_id: model_id
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            default_voice: default_voice
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| DEFAULT_ELEVENLABS_VOICE.to_string()),
        }
    }

    /// The key as the header carries it (the JS sent "undefined" when there was none).
    fn key(&self) -> &str {
        self.api_key.as_deref().unwrap_or("undefined")
    }

    fn voice<'a>(&'a self, voice_id: Option<&'a str>) -> &'a str {
        voice_id
            .filter(|v| !v.is_empty())
            .or(Some(self.default_voice.as_str()).filter(|v| !v.is_empty()))
            .unwrap_or(RACHEL)
    }
}

/// `new FormData()` with text fields and one file, as undici encodes it: the body and its boundary.
fn multipart(fields: &[(&str, &str)], file: (&str, &str, &str, &[u8])) -> (Vec<u8>, String) {
    use rand::RngExt;
    let boundary = format!(
        "----formdata-undici-0{:011}",
        rand::rng().random_range(0..100_000_000_000u64)
    );
    let escape = |name: &str| name.replace('\n', "%0A").replace('\r', "%0D").replace('"', "%22");
    // Line breaks in a text value are sent as CRLF.
    let normalize = |value: &str| value.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n");
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n",
                escape(name),
                normalize(value)
            )
            .as_bytes(),
        );
    }
    let (name, filename, content_type, data) = file;
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {content_type}\r\n\r\n",
            escape(name),
            escape(filename)
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (body, boundary)
}

#[async_trait]
impl TtsEngine for ElevenLabsTtsEngine {
    fn name(&self) -> &str {
        "elevenlabs"
    }

    fn default_voice(&self) -> Option<String> {
        Some(self.default_voice.clone())
    }

    async fn is_available(&self) -> bool {
        if self.api_key.is_none() {
            return false;
        }
        let request = FetchRequest::get(format!("{BASE_URL}/user"))
            .header("xi-api-key", self.key())
            .timeout(Duration::from_secs(8));
        match self.fetch.fetch(request).await {
            Ok(res) => {
                let shown = if res.ok() {
                    "OK".to_string()
                } else {
                    res.status.to_string()
                };
                log::info!("[elevenlabs] isAvailable check: {shown}");
                res.ok()
            }
            Err(_) => false,
        }
    }

    /// Synthesize text to speech.
    async fn synthesize(
        &self,
        text: &str,
        voice_id: Option<&str>,
        _opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError> {
        if text.is_empty() {
            return Err(TtsError::new("Text is required"));
        }
        // Default to Rachel voice if no ID specified
        let vid = self.voice(voice_id);
        let body = json!({
            "text": text,
            "model_id": self.model_id,
            "voice_settings": { "stability": 0.5, "similarity_boost": 0.75 },
        });
        let request = FetchRequest::post(format!("{BASE_URL}/text-to-speech/{vid}"))
            .header("xi-api-key", self.key())
            .header("Content-Type", "application/json")
            .header("Accept", "audio/mpeg")
            .json(&body)
            .timeout(Duration::from_secs(15));
        let res = self.fetch.fetch(request).await?;
        if !res.ok() {
            let status = res.status;
            let err_body = res.text().await.unwrap_or_default();
            return Err(TtsError::new(format!(
                "ElevenLabs TTS error ({status}): {}",
                utf16_truncate(&err_body, 200)
            )));
        }
        Ok(Synthesized {
            audio: res.bytes().await?,
            content_type: "audio/mpeg".into(),
        })
    }

    fn can_stream(&self) -> bool {
        true
    }

    /// Stream TTS audio: the audio arrives as it is made. First audio bytes arrive in ~300ms instead of waiting for
    /// full synthesis.
    async fn synthesize_stream(&self, text: &str, voice_id: Option<&str>) -> Result<AudioStream, TtsError> {
        if text.is_empty() {
            return Err(TtsError::new("Text is required"));
        }
        let vid = self.voice(voice_id);
        let body = json!({
            "text": text,
            "model_id": self.model_id,
            "voice_settings": { "stability": 0.5, "similarity_boost": 0.75 },
            "output_format": "mp3_44100_64",
        });
        let request = FetchRequest::post(format!("{BASE_URL}/text-to-speech/{vid}/stream"))
            .header("xi-api-key", self.key())
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(15));
        let res = self.fetch.fetch(request).await?;
        if !res.ok() {
            let status = res.status;
            let err_body = res.text().await.unwrap_or_default();
            return Err(TtsError::new(format!(
                "ElevenLabs stream error ({status}): {}",
                utf16_truncate(&err_body, 200)
            )));
        }
        Ok(AudioStream {
            stream: res.into_stream(),
            content_type: "audio/mpeg".into(),
        })
    }

    /// Clone a voice using ElevenLabs instant voice cloning.
    async fn clone_voice(&self, audio_sample: &[u8], voice_name: &str) -> Result<ClonedVoice, TtsError> {
        if audio_sample.is_empty() {
            return Err(TtsError::with_status("Audio sample is required", 400));
        }
        if voice_name.is_empty() {
            return Err(TtsError::with_status("Voice name is required", 400));
        }

        // ElevenLabs expects multipart form data
        let description = format!("Cloned voice: {voice_name} (via Tarsee)");
        let (body, boundary) = multipart(
            &[("name", voice_name), ("description", &description)],
            ("files", "sample.wav", "audio/wav", audio_sample),
        );
        let request = FetchRequest::post(format!("{BASE_URL}/voices/add"))
            .header("xi-api-key", self.key())
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .body(body)
            .timeout(Duration::from_secs(60));
        let res = self.fetch.fetch(request).await?;

        if !res.ok() {
            let status = res.status;
            let err = res.json().await.unwrap_or(Value::Object(Default::default()));
            let message = match err.get("detail").and_then(|d| d.get("message")) {
                Some(Value::String(m)) if !m.is_empty() => m.clone(),
                Some(other) if crate::util::js::truthy(other) => match other {
                    Value::Number(n) => crate::util::js::number_to_string(n.as_f64().unwrap_or(0.0)),
                    other => other.to_string(),
                },
                _ => format!("Voice cloning failed: {status}"),
            };
            let status = if (400..500).contains(&status) { status } else { 500 };
            return Err(TtsError::with_status(message, status));
        }

        let data = res.json().await?;
        let voice_id = data.get("voice_id").and_then(Value::as_str).map(str::to_string);
        log::info!(
            "[elevenlabs] voice cloned: {voice_name} ({})",
            voice_id.as_deref().unwrap_or("undefined")
        );
        Ok(ClonedVoice {
            voice_id,
            name: voice_name.to_string(),
        })
    }

    /// List all available voices (library + cloned).
    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        let request = FetchRequest::get(format!("{BASE_URL}/voices"))
            .header("xi-api-key", self.key())
            .timeout(Duration::from_secs(10));
        let res = self.fetch.fetch(request).await?;
        if !res.ok() {
            return Ok(Vec::new());
        }
        let data = res.json().await?;
        let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        Ok(data
            .get("voices")
            .and_then(Value::as_array)
            .map(|voices| {
                voices
                    .iter()
                    .map(|v| {
                        let category = v.get("category").and_then(Value::as_str);
                        let preview = v
                            .get("preview_url")
                            .and_then(Value::as_str)
                            .filter(|p| !p.is_empty())
                            .map(str::to_string);
                        VoiceInfo {
                            id: text(v, "voice_id"),
                            name: text(v, "name"),
                            is_clone: matches!(category, Some("cloned" | "professional")),
                            preview: Some(preview),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{Answer, FakeFetch};
    use futures::StreamExt;

    // The Node code had no tests of its own; these check every request it makes and every answer it reads.

    const KEY: &str = "xi-test-key";

    fn engine(fetch: &Arc<FakeFetch>) -> ElevenLabsTtsEngine {
        ElevenLabsTtsEngine::new(fetch.clone(), Some(KEY.into()), None, None)
    }

    #[tokio::test]
    async fn it_is_available_only_with_a_key_the_service_accepts() {
        let fetch = FakeFetch::new();
        assert!(
            !ElevenLabsTtsEngine::new(fetch.clone(), None, None, None)
                .is_available()
                .await
        );
        assert!(fetch.calls().is_empty(), "no key: nothing is asked");
        fetch.respond(format!("{BASE_URL}/user"), Answer::json(200, json!({})));
        assert!(engine(&fetch).is_available().await);
        assert_eq!(fetch.calls()[0].header("xi-api-key"), Some(KEY));
        fetch.respond(format!("{BASE_URL}/user"), Answer::json(401, json!({})));
        assert!(!engine(&fetch).is_available().await);
        fetch.respond(format!("{BASE_URL}/user"), Answer::connect_error("down"));
        assert!(!engine(&fetch).is_available().await);
    }

    #[tokio::test]
    async fn synthesize_posts_the_text_and_gives_the_audio() {
        let fetch = FakeFetch::new();
        fetch.respond(
            format!("{BASE_URL}/text-to-speech/"),
            Answer::bytes(200, "audio/mpeg", vec![7u8; 300]),
        );
        let out = engine(&fetch)
            .synthesize("Hello there", Some("voice-1"), &SynthOptions::default())
            .await
            .unwrap();
        assert_eq!((out.audio.len(), out.content_type.as_str()), (300, "audio/mpeg"));
        let call = &fetch.calls()[0];
        assert_eq!(call.url, format!("{BASE_URL}/text-to-speech/voice-1"));
        assert_eq!(call.method, "POST");
        assert_eq!(call.header("xi-api-key"), Some(KEY));
        assert_eq!(call.header("accept"), Some("audio/mpeg"));
        assert_eq!(call.header("content-type"), Some("application/json"));
        assert_eq!(
            call.body,
            r#"{"text":"Hello there","model_id":"eleven_flash_v2_5","voice_settings":{"stability":0.5,"similarity_boost":0.75}}"#
        );

        engine(&fetch)
            .synthesize("x", None, &SynthOptions::default())
            .await
            .unwrap();
        assert_eq!(
            fetch.calls()[1].url,
            format!("{BASE_URL}/text-to-speech/{DEFAULT_ELEVENLABS_VOICE}"),
            "the default voice"
        );
        let other = ElevenLabsTtsEngine::new(fetch.clone(), Some(KEY.into()), Some("m2".into()), Some("v9".into()));
        other.synthesize("x", None, &SynthOptions::default()).await.unwrap();
        assert_eq!(fetch.calls()[2].url, format!("{BASE_URL}/text-to-speech/v9"));
        assert_eq!(fetch.calls()[2].json()["model_id"], "m2");
        assert_eq!(other.default_voice().as_deref(), Some("v9"));
    }

    #[tokio::test]
    async fn a_refused_request_says_the_status_and_the_start_of_the_answer() {
        let fetch = FakeFetch::new();
        fetch.respond(
            format!("{BASE_URL}/text-to-speech/"),
            Answer::text(401, "é".repeat(300)),
        );
        let err = engine(&fetch)
            .synthesize("hi", None, &SynthOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.message, format!("ElevenLabs TTS error (401): {}", "é".repeat(200)));
        assert_eq!(
            engine(&fetch)
                .synthesize("", None, &SynthOptions::default())
                .await
                .unwrap_err()
                .message,
            "Text is required"
        );
        fetch.respond(
            format!("{BASE_URL}/text-to-speech/"),
            Answer::connect_error("getaddrinfo ENOTFOUND"),
        );
        let err = engine(&fetch)
            .synthesize("hi", None, &SynthOptions::default())
            .await
            .unwrap_err();
        assert!(err.message.starts_with("fetch failed"), "{err}");
    }

    #[tokio::test]
    async fn the_stream_hands_over_the_audio_as_it_arrives() {
        let fetch = FakeFetch::new();
        fetch.respond(
            format!("{BASE_URL}/text-to-speech/v1/stream"),
            Answer::Response {
                status: 200,
                headers: vec![],
                chunks: vec![bytes::Bytes::from_static(b"ab"), bytes::Bytes::from_static(b"cd")],
            },
        );
        let e = engine(&fetch);
        assert!(e.can_stream());
        let out = e.synthesize_stream("hi", Some("v1")).await.unwrap();
        assert_eq!(out.content_type, "audio/mpeg");
        let pieces: Vec<_> = out.stream.map(|p| p.unwrap()).collect().await;
        assert_eq!(pieces.len(), 2);
        let call = &fetch.calls()[0];
        assert_eq!(call.header("accept"), None);
        assert_eq!(call.json()["output_format"], "mp3_44100_64");
        assert_eq!(
            call.json()["voice_settings"],
            json!({"stability": 0.5, "similarity_boost": 0.75})
        );

        fetch.respond(
            format!("{BASE_URL}/text-to-speech/v1/stream"),
            Answer::text(500, "busy"),
        );
        assert_eq!(
            e.synthesize_stream("hi", Some("v1")).await.unwrap_err().message,
            "ElevenLabs stream error (500): busy"
        );
        assert_eq!(
            e.synthesize_stream("", None).await.unwrap_err().message,
            "Text is required"
        );
    }

    #[tokio::test]
    async fn cloning_sends_the_sample_as_a_form_and_gives_the_new_voice() {
        let fetch = FakeFetch::new();
        fetch.respond(
            format!("{BASE_URL}/voices/add"),
            Answer::json(200, json!({"voice_id": "new-1"})),
        );
        let e = engine(&fetch);
        let out = e.clone_voice(b"RIFFsample", "My Voice").await.unwrap();
        assert_eq!(
            out,
            ClonedVoice {
                voice_id: Some("new-1".into()),
                name: "My Voice".into()
            }
        );
        let call = &fetch.calls()[0];
        let content_type = call.header("content-type").unwrap();
        let boundary = content_type.strip_prefix("multipart/form-data; boundary=").unwrap();
        assert_eq!(
            call.body,
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nMy Voice\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"description\"\r\n\r\nCloned voice: My Voice (via Tarsee)\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"sample.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFFsample\r\n--{boundary}--\r\n"
            )
        );

        let err = e.clone_voice(b"", "x").await.unwrap_err();
        assert_eq!(
            (err.message.as_str(), err.status),
            ("Audio sample is required", Some(400))
        );
        let err = e.clone_voice(b"x", "").await.unwrap_err();
        assert_eq!(
            (err.message.as_str(), err.status),
            ("Voice name is required", Some(400))
        );

        fetch.respond(
            format!("{BASE_URL}/voices/add"),
            Answer::json(422, json!({"detail": {"message": "Sample too short"}})),
        );
        let err = e.clone_voice(b"x", "n").await.unwrap_err();
        assert_eq!((err.message.as_str(), err.status), ("Sample too short", Some(422)));
        fetch.respond(format!("{BASE_URL}/voices/add"), Answer::text(503, "down"));
        let err = e.clone_voice(b"x", "n").await.unwrap_err();
        assert_eq!(
            (err.message.as_str(), err.status),
            ("Voice cloning failed: 503", Some(500))
        );
    }

    #[tokio::test]
    async fn the_voice_list_marks_clones_and_keeps_the_preview() {
        let fetch = FakeFetch::new();
        fetch.respond(
            format!("{BASE_URL}/voices"),
            Answer::json(
                200,
                json!({"voices": [
                    {"voice_id": "a", "name": "Ann", "category": "premade", "preview_url": "https://p/a.mp3"},
                    {"voice_id": "b", "name": "Me", "category": "cloned"},
                    {"voice_id": "c", "name": "Pro", "category": "professional", "preview_url": ""},
                ]}),
            ),
        );
        let voices = engine(&fetch).list_voices().await.unwrap();
        assert_eq!(
            serde_json::to_value(&voices).unwrap(),
            json!([
                {"id": "a", "name": "Ann", "isClone": false, "preview": "https://p/a.mp3"},
                {"id": "b", "name": "Me", "isClone": true, "preview": null},
                {"id": "c", "name": "Pro", "isClone": true, "preview": null},
            ])
        );
        assert_eq!(fetch.calls()[0].header("xi-api-key"), Some(KEY));
        fetch.respond(format!("{BASE_URL}/voices"), Answer::json(401, json!({})));
        assert!(engine(&fetch).list_voices().await.unwrap().is_empty());
        fetch.respond(format!("{BASE_URL}/voices"), Answer::json(200, json!({})));
        assert!(engine(&fetch).list_voices().await.unwrap().is_empty());
        assert_eq!(engine(&fetch).name(), "elevenlabs");
    }
}
