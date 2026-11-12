//! Port of `src/voice/clone-handler.js`: handles voice cloning requests. Receives an audio sample and creates a voice
//! profile (the `voice_profiles` table).

use serde::Serialize;

use super::engine_registry::get_tts_engine;
use super::tts_interface::{ClonedVoice, TtsError};
use crate::app::App;
use crate::db::Db;

/// Clones a voice with the engine in use and saves the profile: `audio` is the sample (10-30 seconds recommended),
/// `name` the profile's name. Gives `{ voiceId, name }`.
pub async fn clone_voice(app: &App, audio: &[u8], name: &str) -> Result<ClonedVoice, TtsError> {
    if audio.is_empty() {
        return Err(TtsError::with_status("Audio sample is required", 400));
    }
    if name.is_empty() {
        return Err(TtsError::with_status("Voice name is required", 400));
    }

    let engine = get_tts_engine(app);
    let result = engine.clone_voice(audio, name).await?;

    // Save voice profile to database
    let id = result
        .voice_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    app.db()
        .with(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO voice_profiles (id, name, engine, data) VALUES (?, ?, ?, ?)",
                rusqlite::params![id, name, engine.name(), audio],
            )
        })
        .map_err(|err| TtsError::new(err.to_string()))?;

    Ok(ClonedVoice {
        voice_id: Some(id),
        name: name.to_string(),
    })
}

/// A saved voice profile: `{ id, name, engine, created_at }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VoiceProfile {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub created_at: String,
}

/// Lists all voice profiles, newest first.
pub fn list_voice_profiles(db: &Db) -> rusqlite::Result<Vec<VoiceProfile>> {
    db.with(|conn| {
        let mut stmt =
            conn.prepare_cached("SELECT id, name, engine, created_at FROM voice_profiles ORDER BY created_at DESC")?;
        stmt.query_map([], |row| {
            Ok(VoiceProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                engine: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?
        .collect()
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::testkit::test_app;
    use crate::voice::engine_registry::set_tts_engine;
    use crate::voice::tts_interface::{SynthOptions, Synthesized, TtsEngine};

    struct Cloner(Option<&'static str>);

    #[async_trait]
    impl TtsEngine for Cloner {
        fn name(&self) -> &str {
            "elevenlabs"
        }
        async fn synthesize(&self, _: &str, _: Option<&str>, _: &SynthOptions) -> Result<Synthesized, TtsError> {
            Err(TtsError::new("Not implemented"))
        }
        async fn clone_voice(&self, _audio: &[u8], name: &str) -> Result<ClonedVoice, TtsError> {
            Ok(ClonedVoice {
                voice_id: self.0.map(str::to_string),
                name: name.to_string(),
            })
        }
    }

    #[tokio::test]
    async fn a_clone_is_saved_with_the_engine_s_id_and_listed() {
        let t = test_app();
        set_tts_engine(&t, Arc::new(Cloner(Some("v-123"))));
        let made = clone_voice(&t, b"RIFF....", "Me").await.unwrap();
        assert_eq!(
            serde_json::to_value(&made).unwrap(),
            json!({"voiceId": "v-123", "name": "Me"})
        );
        let data: Vec<u8> = t
            .db()
            .with(|c| c.query_row("SELECT data FROM voice_profiles WHERE id = 'v-123'", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(data, b"RIFF....");

        // An engine that gives no id: a new one is made.
        set_tts_engine(&t, Arc::new(Cloner(None)));
        let other = clone_voice(&t, b"x", "You").await.unwrap();
        let id = other.voice_id.unwrap();
        assert_eq!(id.len(), 36);

        let listed = list_voice_profiles(t.db()).unwrap();
        assert_eq!(listed.len(), 2);
        let mine = listed.iter().find(|p| p.id == "v-123").unwrap();
        assert_eq!((mine.name.as_str(), mine.engine.as_str()), ("Me", "elevenlabs"));
        assert_eq!(
            serde_json::to_value(mine)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["id", "name", "engine", "created_at"]
        );
    }

    #[tokio::test]
    async fn no_audio_or_no_name_is_a_400_and_the_stub_says_it_cannot_clone() {
        let t = test_app();
        let err = clone_voice(&t, b"", "Me").await.unwrap_err();
        assert_eq!(
            (err.message.as_str(), err.status),
            ("Audio sample is required", Some(400))
        );
        let err = clone_voice(&t, b"x", "").await.unwrap_err();
        assert_eq!(
            (err.message.as_str(), err.status),
            ("Voice name is required", Some(400))
        );
        let err = clone_voice(&t, b"x", "Me").await.unwrap_err();
        assert_eq!(err.status, Some(501));
        assert!(list_voice_profiles(t.db()).unwrap().is_empty());
    }
}
