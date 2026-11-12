//! Port of `src/voice/tts-interface.js`: what every text-to-speech engine offers.
//!
//! The Node version had an abstract class that each engine extended, overriding its methods; the base methods threw
//! "Not implemented" or answered "nothing". Here that is the [`TtsEngine`] trait: the methods every engine has are
//! required, the others have the base class's answers as defaults. It is object safe, so the engine in use is an
//! `Arc<dyn TtsEngine>`.

use std::path::PathBuf;

use async_trait::async_trait;
use bytes::Bytes;
use serde::Serialize;

use crate::env::Env;
use crate::net::fetch::{ByteStream, FetchError};

/// Why an engine could not do what it was asked. The Node code threw an `Error` with, sometimes, a `status` (the
/// HTTP status a route answers with: 400, 501, ...) and a `code` (`"EMPTY_TEXT"`, ...); both are kept here.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct TtsError {
    pub message: String,
    pub status: Option<u16>,
    pub code: Option<String>,
}

impl TtsError {
    pub fn new(message: impl Into<String>) -> Self {
        TtsError {
            message: message.into(),
            status: None,
            code: None,
        }
    }

    /// An error that carries the HTTP status a route should answer with.
    pub fn with_status(message: impl Into<String>, status: u16) -> Self {
        TtsError {
            status: Some(status),
            ..Self::new(message)
        }
    }

    /// The same error with a `code`.
    pub fn code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    /// Whether the error has this code.
    pub fn has_code(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }
}

impl From<FetchError> for TtsError {
    /// A request that never got an answer (the JS `fetch` throwing).
    fn from(err: FetchError) -> Self {
        TtsError::new(err.to_string())
    }
}

/// Spoken audio: `{ audio, contentType }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Synthesized {
    pub audio: Bytes,
    /// "audio/mpeg", "audio/wav".
    pub content_type: String,
}

/// Audio that arrives while it is being made: `{ stream, contentType }`.
pub struct AudioStream {
    pub stream: ByteStream,
    pub content_type: String,
}

impl std::fmt::Debug for AudioStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioStream")
            .field("content_type", &self.content_type)
            .finish_non_exhaustive()
    }
}

/// A voice an engine offers: `{ id, name, isClone }`, and ElevenLabs adds `preview` (a URL or null).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub is_clone: bool,
    /// Absent for every engine but ElevenLabs, which always sends it (null when there is no preview).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<Option<String>>,
}

impl VoiceInfo {
    /// A voice that is not a clone and has no preview.
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        VoiceInfo {
            id: id.into(),
            name: name.into(),
            is_clone: false,
            preview: None,
        }
    }
}

/// A voice made from a sample: `{ voiceId, name }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClonedVoice {
    /// Absent when the service answered without one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_id: Option<String>,
    pub name: String,
}

/// The third argument of `synthesize(text, voiceId, opts)`. Only Phonon reads it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SynthOptions {
    /// A speaking rate for this sentence only.
    pub speed: Option<f64>,
}

/// A text-to-speech engine.
#[async_trait]
pub trait TtsEngine: Send + Sync {
    /// The engine's name: "edge-tts", "elevenlabs", "piper", "phonon", "stub".
    fn name(&self) -> &str;

    /// Speaks `text` with `voice_id` (`None`: the engine's default voice).
    async fn synthesize(
        &self,
        text: &str,
        voice_id: Option<&str>,
        opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError>;

    /// Makes a voice from an audio sample (wav or mp3).
    async fn clone_voice(&self, _audio_sample: &[u8], _name: &str) -> Result<ClonedVoice, TtsError> {
        Err(TtsError::new("Not implemented"))
    }

    /// The voices this engine offers.
    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        Ok(Vec::new())
    }

    /// Whether the engine is set up and can speak now.
    async fn is_available(&self) -> bool {
        false
    }

    /// Whether [`synthesize_stream`](Self::synthesize_stream) is supported (the JS `if (!engine.synthesizeStream)`).
    fn can_stream(&self) -> bool {
        false
    }

    /// Speaks `text`, handing the audio over as it arrives. Only engines whose [`can_stream`](Self::can_stream) is
    /// true implement it.
    async fn synthesize_stream(&self, _text: &str, _voice_id: Option<&str>) -> Result<AudioStream, TtsError> {
        Err(TtsError::new("Not implemented"))
    }

    /// The voice used when none is asked for, for engines that have one.
    fn default_voice(&self) -> Option<String> {
        None
    }

    /// Sets the speaking rate, for engines that have one (Phonon).
    fn set_speed(&self, _speed: f64) {}

    /// Gets the engine ready ahead of the first sentence, for engines that need it (Phonon).
    async fn warm(&self) -> Result<(), TtsError> {
        Ok(())
    }

    /// Lets go of anything the engine keeps running (Phonon's worker).
    fn stop(&self) {}
}

/// The temporary folder (`os.tmpdir()`), worked out from the app's environment the way Node does it: `TMPDIR`, `TMP`
/// or `TEMP` on Unix (else `/tmp`); `TEMP` or `TMP` on Windows (else the Windows folder's `temp`). A trailing
/// separator is dropped.
pub fn os_tmpdir(env: &Env) -> PathBuf {
    let set = |name: &str| env.get(name).filter(|v| !v.is_empty());
    if cfg!(windows) {
        let dir = set("TEMP").or_else(|| set("TMP")).unwrap_or_else(|| {
            let root = set("SystemRoot")
                .or_else(|| set("windir"))
                .unwrap_or_else(|| "C:\\Windows".to_string());
            format!("{root}\\temp")
        });
        let trimmed = if dir.len() > 1 && dir.ends_with('\\') && !dir.ends_with(":\\") {
            &dir[..dir.len() - 1]
        } else {
            dir.as_str()
        };
        PathBuf::from(trimmed)
    } else {
        let dir = set("TMPDIR")
            .or_else(|| set("TMP"))
            .or_else(|| set("TEMP"))
            .unwrap_or_else(|| "/tmp".to_string());
        let trimmed = if dir.len() > 1 && dir.ends_with('/') {
            &dir[..dir.len() - 1]
        } else {
            dir.as_str()
        };
        PathBuf::from(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Bare;

    #[async_trait]
    impl TtsEngine for Bare {
        fn name(&self) -> &str {
            "base"
        }
        async fn synthesize(&self, _: &str, _: Option<&str>, _: &SynthOptions) -> Result<Synthesized, TtsError> {
            Err(TtsError::new("Not implemented"))
        }
    }

    #[tokio::test]
    async fn the_base_answers_are_the_defaults() {
        let engine: std::sync::Arc<dyn TtsEngine> = std::sync::Arc::new(Bare);
        assert_eq!(engine.name(), "base");
        assert_eq!(
            engine
                .synthesize("hi", None, &SynthOptions::default())
                .await
                .unwrap_err()
                .message,
            "Not implemented"
        );
        assert_eq!(
            engine.clone_voice(b"x", "n").await.unwrap_err().to_string(),
            "Not implemented"
        );
        assert_eq!(engine.list_voices().await.unwrap(), vec![]);
        assert!(!engine.is_available().await);
        assert!(!engine.can_stream());
        assert!(engine.synthesize_stream("hi", None).await.is_err());
        assert_eq!(engine.default_voice(), None);
        engine.set_speed(1.1);
        assert!(engine.warm().await.is_ok());
        engine.stop();
    }

    #[test]
    fn errors_carry_a_status_and_a_code() {
        let err = TtsError::with_status("nope", 501).code("EMPTY_TEXT");
        assert_eq!((err.status, err.has_code("EMPTY_TEXT")), (Some(501), true));
        assert_eq!(err.to_string(), "nope");
        let err: TtsError = FetchError::Connect("down".into()).into();
        assert_eq!((err.message.as_str(), err.status), ("fetch failed: down", None));
    }

    #[test]
    fn voices_serialize_with_the_javascript_field_names() {
        assert_eq!(
            serde_json::to_value(VoiceInfo::new("a", "A")).unwrap(),
            json!({"id": "a", "name": "A", "isClone": false})
        );
        let with_preview = VoiceInfo {
            preview: Some(None),
            ..VoiceInfo::new("a", "A")
        };
        assert_eq!(serde_json::to_value(with_preview).unwrap()["preview"], json!(null));
        assert_eq!(
            serde_json::to_value(ClonedVoice {
                voice_id: Some("v1".into()),
                name: "Me".into()
            })
            .unwrap(),
            json!({"voiceId": "v1", "name": "Me"})
        );
    }

    #[test]
    fn the_temporary_folder_follows_node() {
        if cfg!(windows) {
            let env = Env::from_pairs([("TEMP", "C:\\Users\\x\\AppData\\Local\\Temp\\"), ("TMP", "D:\\t")]);
            assert_eq!(os_tmpdir(&env), PathBuf::from("C:\\Users\\x\\AppData\\Local\\Temp"));
            let env = Env::from_pairs([("TMP", "D:\\t")]);
            assert_eq!(os_tmpdir(&env), PathBuf::from("D:\\t"));
            let env = Env::from_pairs([("SystemRoot", "C:\\WINDOWS")]);
            assert_eq!(os_tmpdir(&env), PathBuf::from("C:\\WINDOWS\\temp"));
        } else {
            let env = Env::from_pairs([("TMPDIR", "/var/folders/x/"), ("TMP", "/t")]);
            assert_eq!(os_tmpdir(&env), PathBuf::from("/var/folders/x"));
            let env = Env::from_pairs([("TEMP", "/te")]);
            assert_eq!(os_tmpdir(&env), PathBuf::from("/te"));
            assert_eq!(os_tmpdir(&Env::new()), PathBuf::from("/tmp"));
        }
    }
}
