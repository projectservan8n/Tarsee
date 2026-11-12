//! Shared by the speech-to-text and Phonon tests: small stand-ins for the whisper models (same names, repos and
//! revisions; tiny files), a short WAV, a standalone Python as the fake GitHub serves it, and a test app whose
//! temporary folder is its own.

use std::path::Path;

use rand::Rng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tarsee::testkit::fake_download_host::Route;
use tarsee::testkit::tar::{TarEntry, make_tar_gz};
use tarsee::testkit::{TestApp, test_app_with_env, tmp_dir};
use tarsee::voice::install_common::git_blob_sha1;
use tarsee::voice::python_runtime::{STANDALONE_PYTHON, StandalonePython, TargetQuery, interpreter_in, python_target};
use tarsee::voice::whisper_models::{MODEL_MARKER, ModelFile, WHISPER_MODELS, WhisperModel, model_file_url};
use tempfile::TempDir;

use crate::fake_python::fake_interpreter;

pub fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    buf
}

/// A test app with its own temporary folder (`os.tmpdir()`), kept with it.
pub struct VoiceApp {
    pub t: TestApp,
    pub tmp: TempDir,
}

impl std::ops::Deref for VoiceApp {
    type Target = TestApp;
    fn deref(&self) -> &TestApp {
        &self.t
    }
}

pub fn voice_app(extra: &[(&str, &str)]) -> VoiceApp {
    let tmp = tmp_dir();
    let tmp_s = tmp.path().to_string_lossy().to_string();
    let mut env: Vec<(String, String)> = vec![
        ("TMPDIR".into(), tmp_s.clone()),
        ("TEMP".into(), tmp_s.clone()),
        ("TMP".into(), tmp_s),
    ];
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    VoiceApp {
        t: test_app_with_env(env),
        tmp,
    }
}

/// A model's files: (name, bytes).
type ModelFiles = Vec<(String, Vec<u8>)>;

/// Small stand-ins for the six models, and their files.
pub struct Models {
    pub catalog: Vec<WhisperModel>,
    files: Vec<(String, ModelFiles)>,
}

/// `model_size(name)`: the size of each model's model.bin.
pub fn models(model_size: impl Fn(&str) -> usize, config: impl Fn(&str) -> String) -> Models {
    let mut catalog = Vec::new();
    let mut files = Vec::new();
    for m in WHISPER_MODELS.iter() {
        let these: ModelFiles = vec![
            ("config.json".into(), config(&m.name).into_bytes()),
            ("model.bin".into(), random_bytes(model_size(&m.name))),
            ("tokenizer.json".into(), b"{}\n".to_vec()),
            ("vocabulary.txt".into(), b"a\n".to_vec()),
        ];
        let entries = these
            .iter()
            .map(|(n, b)| ModelFile {
                name: n.clone(),
                size: b.len() as u64,
                sha256: (n == "model.bin").then(|| sha(b)),
                git_sha1: (n != "model.bin").then(|| git_blob_sha1(b)),
            })
            .collect();
        catalog.push(WhisperModel {
            files: entries,
            ..m.clone()
        });
        files.push((m.name.clone(), these));
    }
    Models { catalog, files }
}

impl Models {
    pub fn entry(&self, name: &str) -> &WhisperModel {
        self.catalog.iter().find(|m| m.name == name).unwrap()
    }

    pub fn files(&self, name: &str) -> &[(String, Vec<u8>)] {
        &self.files.iter().find(|(n, _)| n == name).unwrap().1
    }

    pub fn file(&self, name: &str, file: &str) -> Vec<u8> {
        self.files(name).iter().find(|(n, _)| n == file).unwrap().1.clone()
    }

    pub fn url(&self, name: &str, file: &str) -> String {
        model_file_url(self.entry(name), file)
    }

    /// Every file of every model, as Hugging Face would serve it.
    pub fn routes(&self, chunk: usize, delay_ms: u64) -> Vec<(String, Route)> {
        let mut out = Vec::new();
        for (name, files) in &self.files {
            for (n, b) in files {
                out.push((
                    self.url(name, n),
                    Route::body(b.clone()).chunk(chunk).delay_ms(delay_ms),
                ));
            }
        }
        out
    }

    /// Puts a model on disk as a finished download leaves it.
    pub fn put(&self, dir: &Path, name: &str) {
        let dir = dir.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        for (n, b) in self.files(name) {
            std::fs::write(dir.join(n), b).unwrap();
        }
        std::fs::write(dir.join(MODEL_MARKER), "{}").unwrap();
    }
}

/// A 16 kHz mono 16-bit WAV of `ms` milliseconds of a tone.
pub fn wav(ms: usize) -> Vec<u8> {
    let n = 16 * ms;
    let mut b = Vec::with_capacity(44 + n * 2);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n as u32 * 2).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&16_000u32.to_le_bytes());
    b.extend_from_slice(&32_000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(n as u32 * 2).to_le_bytes());
    for i in 0..n {
        let v = (8000.0 * ((i as f64 / 16000.0) * 2.0 * std::f64::consts::PI * 440.0).sin()).round() as i16;
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

/// A standalone Python for this computer, as the fake GitHub serves it.
pub struct Standalone {
    pub pin: StandalonePython,
    pub archive: Vec<u8>,
    pub asset: String,
    /// The download link.
    pub dl: String,
    /// The release in GitHub's API.
    pub api: String,
}

fn exe_rel() -> String {
    let x = Path::new("X");
    interpreter_in(x)
        .strip_prefix(x)
        .unwrap()
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn standalone() -> Standalone {
    let target = python_target(&TargetQuery::current()).unwrap();
    let archive =
        make_tar_gz(&[
            TarEntry::file(&format!("python/{}", exe_rel()), fake_interpreter("3.12.16", json!({}))).mode(0o755),
        ]);
    let mut pin = STANDALONE_PYTHON.clone();
    pin.sha256 = [(target.clone(), sha(&archive))].into_iter().collect();
    let asset = format!("cpython-{}+{}-{}-install_only.tar.gz", pin.version, pin.tag, target);
    let dl = format!(
        "https://github.com/{}/releases/download/{}/{}",
        pin.repo,
        pin.tag,
        asset.replace('+', "%2B")
    );
    let api = format!("https://api.github.com/repos/{}/releases/tags/{}", pin.repo, pin.tag);
    Standalone {
        pin,
        archive,
        asset,
        dl,
        api,
    }
}

impl Standalone {
    /// The release and the archive, with the archive sent in small pieces.
    pub fn routes(&self) -> Vec<(String, Route)> {
        vec![
            (
                self.api.clone(),
                Route::json(json!({ "assets": [{
                    "name": self.asset,
                    "size": self.archive.len(),
                    "digest": format!("sha256:{}", sha(&self.archive)),
                    "browser_download_url": self.dl,
                }] })),
            ),
            (
                self.dl.clone(),
                Route::body(self.archive.clone()).chunk(256).delay_ms(1),
            ),
        ]
    }
}

/// The worker requests the fake Python recorded.
pub fn worker_requests(calls: &[Value]) -> Vec<Value> {
    calls.iter().filter_map(|c| c.get("worker").cloned()).collect()
}

/// How many times the speech-to-text worker was started.
pub fn worker_starts(calls: &[Value]) -> usize {
    calls
        .iter()
        .filter(|c| {
            c["args"].as_array().is_some_and(|a| {
                a.iter()
                    .any(|x| x.as_str().is_some_and(|s| s.ends_with("stt_worker.py")))
            })
        })
        .count()
}
