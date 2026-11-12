//! Port of `src/voice/piper-engine.js`: Piper TTS, ultra-fast local text-to-speech. Sub-500ms latency, runs on CPU,
//! no API key, no internet needed. Uses ONNX voice models (.onnx + .onnx.json pairs), stored on the volume at
//! /data/tarsee/piper-voices/.
//!
//! The voices folder is `<TARSEE_DATA_DIR or TARSEE_STATE_DIR or /data/tarsee>/piper-voices`, read from the app's
//! environment as the Node module read `process.env` (not the configuration's data folder). The `piper` program is
//! found on the app's `PATH`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use serde::Serialize;
use serde_json::Value;

use super::speech_text::clean_speech_text;
use super::tts_interface::{
    ClonedVoice, SynthOptions, Synthesized, TtsEngine, TtsError, VoiceInfo, exec_file, find_program, is_plain_name,
    os_tmpdir,
};
use crate::env::Env;

/// The folder the voice models are kept in.
pub fn voices_dir(env: &Env) -> PathBuf {
    let set = |name: &str| env.get(name).filter(|v| !v.is_empty());
    let base = set("TARSEE_DATA_DIR")
        .or_else(|| set("TARSEE_STATE_DIR"))
        .unwrap_or_else(|| "/data/tarsee".to_string());
    Path::new(&base).join("piper-voices")
}

/// A model on disk with its config beside it.
#[derive(Debug, Clone, PartialEq)]
struct ScannedVoice {
    id: String,
    file: String,
    name: String,
}

fn file_names(dir: &Path) -> Option<Vec<String>> {
    Some(
        std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect(),
    )
}

/// The models: every `.onnx` with its `.onnx.json` beside it, in the order the folder lists them.
fn model_files(files: &[String]) -> Vec<&String> {
    files
        .iter()
        .filter(|f| f.ends_with(".onnx") && !f.ends_with(".onnx.json"))
        .filter(|f| files.contains(&format!("{f}.json")))
        .collect()
}

/// `f.replace(".onnx", "")`: the first ".onnx" goes.
fn id_of(file: &str) -> String {
    file.replacen(".onnx", "", 1)
}

/// Scans the voices folder for .onnx model files. Each voice needs a .onnx and matching .onnx.json config file.
fn scan_voices(dir: &Path) -> Vec<ScannedVoice> {
    let Some(files) = file_names(dir) else {
        return Vec::new();
    };
    model_files(&files)
        .into_iter()
        .map(|f| {
            let id = id_of(f);
            // Try to extract a friendly name from the .onnx.json
            let mut friendly = id.clone();
            let config = std::fs::read_to_string(dir.join(format!("{f}.json")))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok());
            if let Some(config) = config {
                let dataset = config.get("dataset").filter(|v| crate::util::js::truthy(v));
                let english = config
                    .get("language")
                    .and_then(|l| l.get("name_english"))
                    .filter(|v| crate::util::js::truthy(v));
                if let Some(dataset) = dataset {
                    friendly = js_string(dataset);
                } else if let Some(english) = english {
                    friendly = format!("{id} ({})", js_string(english));
                }
            }
            ScannedVoice {
                id,
                file: f.clone(),
                name: friendly,
            }
        })
        .collect()
}

/// `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => crate::util::js::number_to_string(n.as_f64().unwrap_or(0.0)),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
    }
}

fn random_hex(bytes: usize) -> String {
    use rand::Rng;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

pub struct PiperTtsEngine {
    env: Env,
    dir: PathBuf,
    default_voice: Option<String>,
}

impl PiperTtsEngine {
    /// `env`: the app's environment (where the voices are, and the `PATH` piper is found on). Makes the voices
    /// folder.
    pub fn new(env: &Env, default_voice: Option<&str>) -> Self {
        let dir = voices_dir(env);
        let _ = std::fs::create_dir_all(&dir);
        PiperTtsEngine {
            env: env.clone(),
            dir,
            default_voice: default_voice.filter(|v| !v.is_empty()).map(str::to_string),
        }
    }

    fn model_path(&self, voice_id: Option<&str>) -> Option<PathBuf> {
        let voices = scan_voices(&self.dir);
        let by_id = |id: Option<&str>| {
            let id = id.filter(|v| !v.is_empty())?;
            voices.iter().find(|v| v.id == id).map(|v| self.dir.join(&v.file))
        };
        by_id(voice_id)
            .or_else(|| by_id(self.default_voice.as_deref()))
            .or_else(|| voices.first().map(|v| self.dir.join(&v.file)))
    }
}

#[async_trait]
impl TtsEngine for PiperTtsEngine {
    fn name(&self) -> &str {
        "piper"
    }

    fn default_voice(&self) -> Option<String> {
        self.default_voice.clone()
    }

    async fn is_available(&self) -> bool {
        // The program is there, and at least one voice model exists.
        find_program(&self.env, "piper").is_some() && !scan_voices(&self.dir).is_empty()
    }

    async fn synthesize(
        &self,
        text: &str,
        voice_id: Option<&str>,
        _opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError> {
        if text.is_empty() {
            return Err(TtsError::new("Text is required"));
        }

        // Strip emojis and markdown. As in edge_tts_engine.rs: the ZWJ and variation selectors are bare members on
        // purpose, because this deletes every codepoint of a sequence rather than matching the sequence as a
        // single grapheme.
        let text = clean_speech_text(text);
        if text.is_empty() {
            return Err(TtsError::new("No speakable text after cleanup"));
        }

        let Some(model_path) = self.model_path(voice_id) else {
            return Err(TtsError::new(
                "No Piper voice models found. Upload .onnx + .onnx.json files in Settings > Voice.",
            ));
        };

        let tmp_out = os_tmpdir(&self.env).join(format!("piper-{}.wav", random_hex(4)));
        let result = async {
            // Pipe text to piper via stdin, output to a wav file. --sentence_silence adds natural pauses between
            // sentences.
            let args = vec![
                "--model".to_string(),
                model_path.to_string_lossy().into_owned(),
                "--output_file".to_string(),
                tmp_out.to_string_lossy().into_owned(),
                "--sentence_silence".to_string(),
                "0.3".to_string(),
            ];
            exec_file(
                &self.env,
                "piper",
                &args,
                Some(text.as_bytes()),
                Duration::from_secs(15),
            )
            .await
            .map_err(|err| TtsError::new(err.to_string()))?;

            let audio = std::fs::read(&tmp_out).map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    TtsError::new(format!(
                        "ENOENT: no such file or directory, open '{}'",
                        tmp_out.display()
                    ))
                } else {
                    TtsError::new(err.to_string())
                }
            })?;
            if audio.len() < 100 {
                return Err(TtsError::new("Piper generated empty audio"));
            }
            Ok(Synthesized {
                audio: Bytes::from(audio),
                content_type: "audio/wav".into(),
            })
        }
        .await;
        let _ = std::fs::remove_file(&tmp_out);
        result
    }

    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        Ok(scan_voices(&self.dir)
            .into_iter()
            .map(|v| VoiceInfo::new(v.id, v.name))
            .collect())
    }

    /// "Cloning" for Piper = uploading a custom .onnx model. Not actual voice cloning, just a model file upload.
    async fn clone_voice(&self, _audio_sample: &[u8], _name: &str) -> Result<ClonedVoice, TtsError> {
        Err(TtsError::with_status(
            "Piper doesn't support voice cloning from audio. Upload .onnx + .onnx.json model files instead via Settings > Voice.",
            400,
        ))
    }
}

/// A saved voice: `{ id, name }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedPiperVoice {
    pub id: String,
    pub name: String,
}

/// `name` as a file name: lower case, anything but a-z, 0-9, _ and - becomes "-", runs of "-" become one, at most
/// 50 characters.
fn safe_name(name: &str) -> String {
    let lowered: String = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let mut collapsed = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    collapsed.chars().take(50).collect()
}

/// Saves an uploaded Piper voice model (.onnx + .onnx.json pair); `name` is the voice name (used as the file name).
pub fn save_piper_voice(env: &Env, onnx: &[u8], json: &[u8], name: &str) -> std::io::Result<SavedPiperVoice> {
    let dir = voices_dir(env);
    std::fs::create_dir_all(&dir)?;
    // Sanitize name for filesystem
    let safe = safe_name(name);
    std::fs::write(dir.join(format!("{safe}.onnx")), onnx)?;
    std::fs::write(dir.join(format!("{safe}.onnx.json")), json)?;
    log::info!(
        "[piper] Saved voice: {safe} ({}MB)",
        (onnx.len() as f64 / 1024.0 / 1024.0 + 0.5).floor()
    );
    Ok(SavedPiperVoice {
        id: safe,
        name: name.to_string(),
    })
}

/// Deletes a Piper voice model.
pub fn delete_piper_voice(env: &Env, voice_id: &str) {
    // The id comes from the request's URL. Node joined it unchecked, so "../x" deleted x.onnx beside the voices
    // folder; only a plain name is taken here, anything else deletes nothing.
    if !is_plain_name(voice_id) {
        return;
    }
    let dir = voices_dir(env);
    let _ = std::fs::remove_file(dir.join(format!("{voice_id}.onnx")));
    let _ = std::fs::remove_file(dir.join(format!("{voice_id}.onnx.json")));
}

/// A voice model on disk: `{ id, sizeMB, file }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PiperVoiceFile {
    pub id: String,
    #[serde(rename = "sizeMB")]
    pub size_mb: u64,
    pub file: String,
}

/// Lists all Piper voices on disk.
pub fn list_piper_voices(env: &Env) -> Vec<PiperVoiceFile> {
    let dir = voices_dir(env);
    let _ = std::fs::create_dir_all(&dir);
    let Some(files) = file_names(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for f in model_files(&files) {
        let Ok(meta) = std::fs::metadata(dir.join(f)) else {
            // The JS listing failed as a whole here, and gave nothing.
            return Vec::new();
        };
        out.push(PiperVoiceFile {
            id: id_of(f),
            size_mb: (meta.len() as f64 / 1024.0 / 1024.0 + 0.5).floor() as u64,
            file: f.clone(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::tmp_dir;

    // The Node code had no tests of its own. These cover what needs no piper program; tests/it/voice.rs starts
    // the stand-in.

    fn env_in(dir: &Path) -> Env {
        Env::from_pairs([
            ("TARSEE_STATE_DIR", dir.to_string_lossy().to_string()),
            ("PATH", String::new()),
        ])
    }

    #[test]
    fn the_voices_folder_follows_the_environment() {
        assert_eq!(
            voices_dir(&Env::from_pairs([
                ("TARSEE_DATA_DIR", "/d"),
                ("TARSEE_STATE_DIR", "/s")
            ])),
            Path::new("/d").join("piper-voices")
        );
        assert_eq!(
            voices_dir(&Env::from_pairs([("TARSEE_DATA_DIR", ""), ("TARSEE_STATE_DIR", "/s")])),
            Path::new("/s").join("piper-voices")
        );
        assert_eq!(voices_dir(&Env::new()), Path::new("/data/tarsee").join("piper-voices"));
    }

    #[tokio::test]
    async fn saved_voices_are_listed_with_friendly_names_and_deleted() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        let saved = save_piper_voice(
            &env,
            &vec![0u8; 3 * 1024 * 1024],
            br#"{"dataset": "amy"}"#,
            "Amy (US)! v2",
        )
        .unwrap();
        assert_eq!(
            saved,
            SavedPiperVoice {
                id: "amy-us-v2".into(),
                name: "Amy (US)! v2".into()
            }
        );
        save_piper_voice(&env, b"m", br#"{"language": {"name_english": "Filipino"}}"#, "Rosa").unwrap();
        save_piper_voice(&env, b"m", b"not json", "plain").unwrap();
        // A model without its config, and a config without its model, are not voices.
        std::fs::write(voices_dir(&env).join("lonely.onnx"), b"m").unwrap();
        std::fs::write(voices_dir(&env).join("orphan.onnx.json"), b"{}").unwrap();

        let engine = PiperTtsEngine::new(&env, None);
        let mut voices = engine.list_voices().await.unwrap();
        voices.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            voices,
            vec![
                VoiceInfo::new("amy-us-v2", "amy"),
                VoiceInfo::new("plain", "plain"),
                VoiceInfo::new("rosa", "rosa (Filipino)"),
            ]
        );
        let mut files = list_piper_voices(&env);
        files.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            files[0],
            PiperVoiceFile {
                id: "amy-us-v2".into(),
                size_mb: 3,
                file: "amy-us-v2.onnx".into()
            }
        );
        assert_eq!(serde_json::to_value(&files[0]).unwrap()["sizeMB"], 3);
        assert_eq!(files.len(), 3);

        delete_piper_voice(&env, "rosa");
        delete_piper_voice(&env, "never-there");
        assert_eq!(list_piper_voices(&env).len(), 2);
    }

    #[test]
    fn a_voice_id_that_is_not_a_plain_name_deletes_nothing() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        save_piper_voice(&env, b"m", b"{}", "amy").unwrap();
        // Files beside the voices folder that a "../" id would have reached.
        std::fs::write(dir.path().join("outside.onnx"), b"keep").unwrap();
        let absolute = dir.path().join("abs");
        std::fs::write(absolute.with_extension("onnx"), b"keep").unwrap();
        delete_piper_voice(&env, "../outside");
        delete_piper_voice(&env, &absolute.to_string_lossy());
        assert!(dir.path().join("outside.onnx").exists());
        assert!(absolute.with_extension("onnx").exists());
        delete_piper_voice(&env, "amy");
        assert!(list_piper_voices(&env).is_empty());
    }

    #[test]
    fn names_become_safe_file_names() {
        assert_eq!(safe_name("My Voice"), "my-voice");
        assert_eq!(safe_name("a--b__c"), "a-b__c");
        assert_eq!(safe_name("Ünïcödé 🐒"), "-n-c-d-");
        assert_eq!(safe_name(&"x".repeat(80)).len(), 50);
        assert_eq!(id_of("a.onnx.v2.onnx"), "a.v2.onnx");
        assert_eq!(js_string(&serde_json::json!(5)), "5");
    }

    #[tokio::test]
    async fn without_text_voices_or_the_program_it_says_why() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        let engine = PiperTtsEngine::new(&env, Some("amy"));
        assert_eq!(engine.name(), "piper");
        assert_eq!(engine.default_voice().as_deref(), Some("amy"));
        assert!(voices_dir(&env).is_dir(), "the folder is made");
        let opts = SynthOptions::default();
        let speak = |t: &'static str| engine.synthesize(t, None, &opts);
        assert_eq!(speak("").await.unwrap_err().message, "Text is required");
        assert_eq!(
            speak("😀 **").await.unwrap_err().message,
            "No speakable text after cleanup"
        );
        assert_eq!(
            speak("hello").await.unwrap_err().message,
            "No Piper voice models found. Upload .onnx + .onnx.json files in Settings > Voice."
        );
        save_piper_voice(&env, b"m", b"{}", "amy").unwrap();
        assert!(!engine.is_available().await, "no piper on the PATH");
        assert_eq!(speak("hello").await.unwrap_err().message, "spawnSync piper ENOENT");
        let err = engine.clone_voice(b"x", "n").await.unwrap_err();
        assert_eq!(err.status, Some(400));
    }
}
