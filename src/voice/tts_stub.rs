//! Port of `src/voice/tts-stub.js`: the engine in place while no real one is configured. Every request is answered
//! with a 501 that says what to set up.

use async_trait::async_trait;

use super::tts_interface::{ClonedVoice, SynthOptions, Synthesized, TtsEngine, TtsError, VoiceInfo};

/// Stub TTS engine: returns 501 for all operations. This is the default until a real TTS engine is configured.
#[derive(Debug, Clone, Copy, Default)]
pub struct StubTtsEngine;

impl StubTtsEngine {
    pub fn new() -> Self {
        StubTtsEngine
    }
}

#[async_trait]
impl TtsEngine for StubTtsEngine {
    fn name(&self) -> &str {
        "stub"
    }

    async fn synthesize(
        &self,
        _text: &str,
        _voice_id: Option<&str>,
        _opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError> {
        Err(TtsError::with_status(
            "TTS engine not configured. Add ElevenLabs key in Settings > Voice, or select Edge TTS (free).",
            501,
        ))
    }

    async fn clone_voice(&self, _audio_sample: &[u8], _name: &str) -> Result<ClonedVoice, TtsError> {
        Err(TtsError::with_status(
            "Voice cloning requires a TTS engine that supports it. Configure one in Settings.",
            501,
        ))
    }

    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        Ok(Vec::new())
    }

    async fn is_available(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_request_is_a_501_that_says_what_to_set_up() {
        let stub = StubTtsEngine::new();
        assert_eq!(stub.name(), "stub");
        let err = stub
            .synthesize("hello", None, &SynthOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.status, Some(501));
        assert!(err.message.contains("Edge TTS (free)"));
        let err = stub.clone_voice(b"RIFF", "me").await.unwrap_err();
        assert_eq!(err.status, Some(501));
        assert!(err.message.starts_with("Voice cloning requires"));
        assert!(stub.list_voices().await.unwrap().is_empty());
        assert!(!stub.is_available().await);
    }
}
