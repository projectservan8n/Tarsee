//! Port of `src/voice/whisper-models.js`: the speech-to-text models: the official faster-whisper models Systran
//! publishes on Hugging Face (the same ones faster-whisper downloads by itself), pinned to a revision with each
//! file's size and the hash Hugging Face publishes for it (sha256 for model.bin, git's blob hash for the small files).
//!
//! Where a model can be, in the order they are looked at:
//!   downloaded  <models>/<name>/, downloaded from Settings > Voice (on the data volume on Railway, so it survives
//!               redeploys); .tarsee-model.json is written last, once every file has been checked
//!   image       <bundled>/<name>/, put there by the Docker build (TARSEE_WHISPER_BUNDLED_DIR, outside /data so the
//!               volume can't hide it); never deleted
//!   cache       <models>/hf_cache/hub/models--Systran--faster-whisper-<name>/snapshots/<rev>/, where the old version
//!               let faster-whisper download it (still used, and deletable)
//!
//! faster-whisper is always handed the folder, never a model name, so it never downloads anything itself.
//!
//! This file needs nothing of Tarsee's but `install_common`: the Docker build runs the download on its own (the
//! Node version as `node whisper-models.js download base.en /opt/tarsee/whisper-models`; see
//! [`run_download_command`]).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::Serialize;

use super::install_common::{
    DownloadFile, InstallError, OFFICIAL_HOSTS, download_file, guarded_fetch, remove_all, write_file_atomic,
};
use crate::net::fetch::Fetch;
use crate::util::js::{now_iso, utf16_truncate};

pub const DEFAULT_WHISPER_MODEL: &str = "base.en";
pub const MODEL_MARKER: &str = ".tarsee-model.json";

/// One file of a model, with its size and the hash its source publishes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub name: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_sha1: Option<String>,
}

/// A model of the catalog.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WhisperModel {
    pub name: String,
    pub repo: String,
    pub revision: String,
    /// English only (the ".en" models).
    pub english: bool,
    pub description: String,
    pub files: Vec<ModelFile>,
}

/// (size, git blob sha1) of the tokenizer and the vocabulary each family shares.
struct Shared {
    tokenizer: (u64, &'static str),
    vocabulary: (u64, &'static str),
}

const SHARED_EN: Shared = Shared {
    tokenizer: (2128466, "15d7bdf9ba25718ca2504eec6a8f02bc55af0a6a"),
    vocabulary: (422309, "ee695b8d3e3c10d488304e04468efec4ca27554a"),
};
const SHARED_MULTI: Shared = Shared {
    tokenizer: (2203239, "7818adb6de9fa3064d3ff81226fdd675be1f6344"),
    vocabulary: (459861, "c9074644d9d1205686f16d411564729461324b75"),
};

fn model(
    name: &str,
    revision: &str,
    config: (u64, &str),
    model_bin: (u64, &str),
    shared: &Shared,
    description: &str,
) -> WhisperModel {
    let git = |file: &str, (size, hash): (u64, &str)| ModelFile {
        name: file.to_string(),
        size,
        sha256: None,
        git_sha1: Some(hash.to_string()),
    };
    WhisperModel {
        name: name.to_string(),
        repo: format!("Systran/faster-whisper-{name}"),
        revision: revision.to_string(),
        english: name.ends_with(".en"),
        description: description.to_string(),
        files: vec![
            git("config.json", config),
            ModelFile {
                name: "model.bin".into(),
                size: model_bin.0,
                sha256: Some(model_bin.1.to_string()),
                git_sha1: None,
            },
            git("tokenizer.json", shared.tokenizer),
            git("vocabulary.txt", shared.vocabulary),
        ],
    }
}

/// The models, smallest first in each family. Sizes and hashes as Hugging Face lists them at these revisions.
pub static WHISPER_MODELS: LazyLock<Vec<WhisperModel>> = LazyLock::new(|| {
    vec![
        model(
            "tiny.en",
            "0d3d19a32d3338f10357c0889762bd8d64bbdeba",
            (2317, "4065bb3bed375b176d5465be117d2d202e210434"),
            (
                75537502,
                "1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a",
            ),
            &SHARED_EN,
            "English only. The fastest, and the least accurate.",
        ),
        model(
            "base.en",
            "3d3d5dee26484f91867d81cb899cfcf72b96be6c",
            (2227, "594369787efe617005d199b03739ee0ead7e3ab7"),
            (
                145216508,
                "2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef",
            ),
            &SHARED_EN,
            "English only. Quick and accurate: the one to start with.",
        ),
        model(
            "small.en",
            "d1d751a5f8271d482d14ca55d9e2deeebbae577f",
            (2657, "ced3fd5bbb3e9f7664658065d2d36164712cf1d5"),
            (
                483545366,
                "62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a",
            ),
            &SHARED_EN,
            "English only. The most accurate here, and the slowest.",
        ),
        model(
            "tiny",
            "d90ca5fe260221311c53c58e660288d3deb8d356",
            (2249, "3baa18e2b321a2f489614607852a729fcd516480"),
            (
                75538270,
                "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1",
            ),
            &SHARED_MULTI,
            "Many languages, found by itself. The fastest, and the least accurate.",
        ),
        model(
            "base",
            "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
            (2309, "867cf1a0fece1394e01d55e287ba2f09a577c046"),
            (
                145217532,
                "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9",
            ),
            &SHARED_MULTI,
            "Many languages, found by itself. Quick and accurate.",
        ),
        model(
            "small",
            "536b0662742c02347bc0e980a01041f333bce120",
            (2370, "e5047537059bd8f182d9ca64c470201585015187"),
            (
                483546902,
                "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
            ),
            &SHARED_MULTI,
            "Many languages, found by itself. The most accurate here, and the slowest.",
        ),
    ]
});

/// The model names, in catalog order.
pub static WHISPER_MODEL_NAMES: LazyLock<Vec<String>> =
    LazyLock::new(|| WHISPER_MODELS.iter().map(|m| m.name.clone()).collect());

/// The model of this name in the catalog.
pub fn find_in_catalog<'a>(name: &str, catalog: &'a [WhisperModel]) -> Option<&'a WhisperModel> {
    catalog.iter().find(|m| m.name == name)
}

fn entry_for<'a>(name: &str, catalog: &'a [WhisperModel]) -> Result<&'a WhisperModel, InstallError> {
    find_in_catalog(name, catalog).ok_or_else(|| {
        let names: Vec<&str> = catalog.iter().map(|m| m.name.as_str()).collect();
        InstallError::with_code(
            format!(
                "\"{}\" is not one of the speech models ({})",
                utf16_truncate(name, 40),
                names.join(", ")
            ),
            "UNKNOWN_MODEL",
        )
    })
}

/// `encodeURIComponent(text)`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn model_file_url(m: &WhisperModel, file: &str) -> String {
    format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        m.repo,
        m.revision,
        encode_uri_component(file)
    )
}

/// A model's download size in bytes.
pub fn model_bytes(name: &str, catalog: &[WhisperModel]) -> Result<u64, InstallError> {
    Ok(entry_for(name, catalog)?.files.iter().map(|f| f.size).sum())
}

/// Every file there at its listed size (a cheap check: the hashes were checked when they were downloaded).
fn files_there(dir: &Path, m: &WhisperModel) -> bool {
    m.files
        .iter()
        .all(|f| std::fs::metadata(dir.join(&f.name)).is_ok_and(|meta| meta.len() == f.size))
}

fn repo_dir_name(m: &WhisperModel) -> String {
    format!("models--{}", m.repo.replacen('/', "--", 1))
}

/// The old version's Hugging Face cache: the pinned revision's snapshot first, then any complete one.
fn cache_snapshot(cache_dir: &Path, m: &WhisperModel) -> Option<PathBuf> {
    let snaps = cache_dir.join("hub").join(repo_dir_name(m)).join("snapshots");
    let mut revs: Vec<String> = std::fs::read_dir(&snaps)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    revs.sort_by_key(|rev| *rev != m.revision);
    revs.into_iter()
        .map(|rev| snaps.join(rev))
        .find(|dir| files_there(dir, m))
}

/// Where models are looked for: `{ models, bundled: [folders], caches: [Hugging Face cache folders] }`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelDirs {
    pub models: PathBuf,
    pub bundled: Vec<PathBuf>,
    pub caches: Vec<PathBuf>,
}

/// Where a model was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelSource {
    Downloaded,
    Image,
    Cache,
}

/// `{ name, dir, source }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FoundModel {
    pub name: String,
    pub dir: PathBuf,
    pub source: ModelSource,
}

fn has_marker_and_files(dir: &Path, m: &WhisperModel) -> bool {
    dir.join(MODEL_MARKER).exists() && files_there(dir, m)
}

/// Where a model is, or `None`.
pub fn find_whisper_model(name: &str, dirs: &ModelDirs, catalog: &[WhisperModel]) -> Option<FoundModel> {
    let m = find_in_catalog(name, catalog)?;
    let found = |dir: PathBuf, source| {
        Some(FoundModel {
            name: name.to_string(),
            dir,
            source,
        })
    };
    let own = dirs.models.join(name);
    if has_marker_and_files(&own, m) {
        return found(own, ModelSource::Downloaded);
    }
    for b in &dirs.bundled {
        let dir = b.join(name);
        if has_marker_and_files(&dir, m) {
            return found(dir, ModelSource::Image);
        }
    }
    for c in &dirs.caches {
        if let Some(dir) = cache_snapshot(c, m) {
            return found(dir, ModelSource::Cache);
        }
    }
    None
}

/// `{ bytesDone, bytesTotal, file }` while a model downloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// The file being fetched; `None` before the first.
    pub file: Option<String>,
}

/// The options of [`download_whisper_model`]: `{ onProgress, log, retryDelayMs, catalog }`.
pub struct DownloadModelOptions<'a> {
    pub on_progress: Option<&'a (dyn Fn(ModelProgress) + Send + Sync)>,
    pub log: Option<&'a (dyn Fn(&str) + Send + Sync)>,
    pub retry_delay_ms: u64,
    /// Replaces the catalog (tests).
    pub catalog: Option<&'a [WhisperModel]>,
}

impl Default for DownloadModelOptions<'_> {
    fn default() -> Self {
        DownloadModelOptions {
            on_progress: None,
            log: None,
            retry_delay_ms: 1000,
            catalog: None,
        }
    }
}

/// Downloads a model into `<root>/<name>/` through `fetch` (only from Hugging Face). Files already there that pass
/// their checks are kept, so a retry picks up where a failed one stopped. Gives the folder.
pub async fn download_whisper_model(
    name: &str,
    root: &Path,
    fetch: Arc<dyn Fetch>,
    opts: DownloadModelOptions<'_>,
) -> Result<PathBuf, InstallError> {
    let catalog = opts.catalog.unwrap_or(&WHISPER_MODELS);
    let m = entry_for(name, catalog)?;
    let log = |msg: &str| {
        if let Some(log) = opts.log {
            log(msg);
        }
    };
    let get = guarded_fetch(&[OFFICIAL_HOSTS.huggingface], fetch);
    let dir = root.join(name);
    let total: u64 = m.files.iter().map(|f| f.size).sum();
    let done = AtomicI64::new(0);
    std::fs::create_dir_all(&dir)?;
    match std::fs::remove_file(dir.join(MODEL_MARKER)) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
        _ => {}
    }
    log(&format!(
        "downloading {name} ({} MB) from huggingface.co/{}",
        (total as f64 / 1e6 + 0.5).floor(),
        m.repo
    ));
    if let Some(on_progress) = opts.on_progress {
        on_progress(ModelProgress {
            bytes_done: 0,
            bytes_total: total,
            file: None,
        });
    }
    for f in &m.files {
        let progress = |n: i64| {
            let now = (done.load(Ordering::SeqCst) + n).max(0);
            done.store(now, Ordering::SeqCst);
            if let Some(on_progress) = opts.on_progress {
                on_progress(ModelProgress {
                    bytes_done: now as u64,
                    bytes_total: total,
                    file: Some(f.name.clone()),
                });
            }
        };
        let mut spec = DownloadFile::new(model_file_url(m, &f.name), dir.join(&f.name))
            .size(f.size)
            .retry_delay_ms(opts.retry_delay_ms)
            .progress(&progress);
        spec.sha256 = f.sha256.clone();
        spec.git_sha1 = f.git_sha1.clone();
        download_file(&get, spec).await?;
    }
    let marker = serde_json::json!({ "repo": m.repo, "revision": m.revision, "downloadedAt": now_iso() });
    write_file_atomic(
        &dir.join(MODEL_MARKER),
        format!("{}\n", serde_json::to_string_pretty(&marker).unwrap_or_default()),
    )?;
    log(&format!("{name} is ready in {}", dir.display()));
    Ok(dir)
}

/// What [`delete_whisper_model`] did: `{ removed: [folders], kept: <image folder> | null }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeletedModel {
    pub removed: Vec<PathBuf>,
    pub kept: Option<PathBuf>,
}

/// Deletes a model's downloaded copy and any copy in the old Hugging Face cache. A model that comes with the image
/// is left (it is part of Tarsee).
pub fn delete_whisper_model(
    name: &str,
    dirs: &ModelDirs,
    catalog: &[WhisperModel],
) -> Result<DeletedModel, InstallError> {
    let m = entry_for(name, catalog)?;
    let mut removed = Vec::new();
    let own = dirs.models.join(name);
    if own.exists() {
        // A model the speech-to-text worker has open cannot be removed on Windows: that is an error, as it was.
        remove_all(&own)?;
        removed.push(own);
    }
    for c in &dirs.caches {
        let repo_dir = c.join("hub").join(repo_dir_name(m));
        if repo_dir.exists() {
            remove_all(&repo_dir)?;
            removed.push(repo_dir);
        }
    }
    let kept = dirs
        .bundled
        .iter()
        .map(|b| b.join(name))
        .find(|d| has_marker_and_files(d, m));
    Ok(DeletedModel { removed, kept })
}

// ── Terminal (the Docker build) ──────────────────────────────────────────

/// The Docker build's `whisper-models download <model> <folder>`: `args` are what follows the program's own name.
/// Logs progress every 10% and gives the exit code (0 done, 1 failed, 2 wrong arguments).
pub async fn run_download_command(fetch: Arc<dyn Fetch>, args: &[String]) -> i32 {
    let (cmd, name, root) = (args.first(), args.get(1), args.get(2));
    let (Some("download"), Some(name), Some(root)) = (cmd.map(String::as_str), name, root) else {
        log::error!("usage: node whisper-models.js download <model> <folder>");
        return 2;
    };
    if name.is_empty() || root.is_empty() {
        log::error!("usage: node whisper-models.js download <model> <folder>");
        return 2;
    }
    let shown = AtomicI64::new(-10);
    let on_progress = |p: ModelProgress| {
        let pct = ((p.bytes_done as f64 / p.bytes_total as f64) * 100.0).floor() as i64;
        if pct >= shown.load(Ordering::SeqCst) + 10 {
            let now = pct - pct % 10;
            shown.store(now, Ordering::SeqCst);
            log::info!("[stt] {name} {now}%");
        }
    };
    let log = |msg: &str| log::info!("[stt] {msg}");
    let opts = DownloadModelOptions {
        on_progress: Some(&on_progress),
        log: Some(&log),
        ..Default::default()
    };
    match download_whisper_model(name, Path::new(root), fetch, opts).await {
        Ok(_) => 0,
        Err(err) => {
            log::error!("[stt] could not download {name}: {}", err.message);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::fake_download_host::{FakeDownloadHost, Route};
    use crate::testkit::tmp_dir;
    use crate::voice::install_common::git_blob_sha1;
    use parking_lot::Mutex;
    use rand::Rng;
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    // test/whisper-models.test.js

    fn sha(b: &[u8]) -> String {
        hex::encode(Sha256::digest(b))
    }

    fn random_bytes(n: usize) -> Vec<u8> {
        let mut buf = vec![0u8; n];
        rand::rng().fill_bytes(&mut buf);
        buf
    }

    const CDN: &str = "https://us.aws.cdn.hf.co/xet-bridge-us/abc/model";

    /// A fake "tiny.en" with small files, its catalog entry, and a host serving it (model.bin through the CDN
    /// redirect).
    struct FakeModel {
        files: Vec<(&'static str, Vec<u8>)>,
        entry: WhisperModel,
        catalog: Vec<WhisperModel>,
        host: Arc<FakeDownloadHost>,
    }

    fn entry_with(files: &[(&'static str, Vec<u8>)]) -> WhisperModel {
        let mut entry = find_in_catalog("tiny.en", &WHISPER_MODELS).unwrap().clone();
        entry.files = files
            .iter()
            .map(|(name, buf)| ModelFile {
                name: name.to_string(),
                size: buf.len() as u64,
                sha256: (*name == "model.bin").then(|| sha(buf)),
                git_sha1: (*name != "model.bin").then(|| git_blob_sha1(buf)),
            })
            .collect();
        entry
    }

    fn catalog_with(entry: &WhisperModel) -> Vec<WhisperModel> {
        WHISPER_MODELS
            .iter()
            .map(|m| if m.name == "tiny.en" { entry.clone() } else { m.clone() })
            .collect()
    }

    fn fake_model(model_bin: Option<Route>, extra: Vec<(String, Route)>) -> FakeModel {
        let files: Vec<(&'static str, Vec<u8>)> = vec![
            (
                "config.json",
                b"{\"alignment_heads\": [[1, 0]], \"lang_ids\": []}\n".to_vec(),
            ),
            ("model.bin", random_bytes(300_000)),
            ("tokenizer.json", b"{\"version\": \"1.0\"}\n".to_vec()),
            ("vocabulary.txt", b"a\nb\nc\n".to_vec()),
        ];
        let entry = entry_with(&files);
        let catalog = catalog_with(&entry);
        let host = FakeDownloadHost::new(Vec::<(String, Route)>::new());
        for (name, buf) in &files {
            let url = model_file_url(&entry, name);
            if *name == "model.bin" {
                host.route(url, Route::redirect(CDN));
                host.route(
                    CDN,
                    model_bin
                        .clone()
                        .unwrap_or_else(|| Route::body(buf.clone()).chunk(8_000)),
                );
            } else {
                host.route(url, Route::body(buf.clone()));
            }
        }
        for (url, route) in extra {
            host.route(url, route);
        }
        FakeModel {
            files,
            entry,
            catalog,
            host,
        }
    }

    fn dirs(base: &TempDir) -> ModelDirs {
        let models = base.path().join("whisper-models");
        ModelDirs {
            bundled: vec![base.path().join("image")],
            caches: vec![models.join("hf_cache")],
            models,
        }
    }

    fn opts(catalog: &[WhisperModel]) -> DownloadModelOptions<'_> {
        DownloadModelOptions {
            catalog: Some(catalog),
            retry_delay_ms: 1,
            ..Default::default()
        }
    }

    #[test]
    fn are_the_six_official_systran_repos_at_fixed_revisions_every_file_with_a_size_and_its_published_hash() {
        let mut names: Vec<&str> = WHISPER_MODELS.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(
            names,
            ["tiny.en", "base.en", "small.en", "tiny", "base", "small"],
            "catalog order"
        );
        names.sort();
        assert_eq!(names, ["base", "base.en", "small", "small.en", "tiny", "tiny.en"]);
        assert_eq!(
            *WHISPER_MODEL_NAMES,
            ["tiny.en", "base.en", "small.en", "tiny", "base", "small"]
        );
        assert_eq!(DEFAULT_WHISPER_MODEL, "base.en");
        let hex = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
        for m in WHISPER_MODELS.iter() {
            assert_eq!(m.repo, format!("Systran/faster-whisper-{}", m.name));
            assert!(hex(&m.revision, 40));
            let mut files: Vec<&str> = m.files.iter().map(|f| f.name.as_str()).collect();
            files.sort();
            assert_eq!(files, ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]);
            for f in &m.files {
                assert!(f.size > 0, "{}/{} has a size", m.name, f.name);
                if f.name == "model.bin" {
                    assert!(
                        hex(f.sha256.as_deref().unwrap(), 64),
                        "{}/{} has its hash",
                        m.name,
                        f.name
                    );
                } else {
                    assert!(
                        hex(f.git_sha1.as_deref().unwrap(), 40),
                        "{}/{} has its hash",
                        m.name,
                        f.name
                    );
                }
            }
            assert_eq!(m.english, m.name.ends_with(".en"));
            let lower = m.description.to_lowercase();
            assert!(
                !m.description.is_empty()
                    && !["ctranslate", "int8", "hf_cache", "snapshot"]
                        .iter()
                        .any(|w| lower.contains(w)),
                "said in plain words"
            );
            assert_eq!(
                model_file_url(m, "model.bin"),
                format!(
                    "https://huggingface.co/Systran/faster-whisper-{}/resolve/{}/model.bin",
                    m.name, m.revision
                )
            );
        }
        let base_en = model_bytes("base.en", &WHISPER_MODELS).unwrap();
        assert!(
            base_en > 140_000_000 && base_en < 160_000_000,
            "base.en is about 148 MB"
        );
        assert!(model_bytes("small", &WHISPER_MODELS).unwrap() > 480_000_000);
    }

    #[tokio::test]
    async fn fetches_every_file_through_hugging_faces_cdn_with_progress_checks_each_and_writes_its_marker_last() {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let fm = fake_model(None, vec![]);
        let seen = Mutex::new(Vec::new());
        let on_progress = |p: ModelProgress| seen.lock().push(p);
        let logged = Mutex::new(Vec::new());
        let log = |m: &str| logged.lock().push(m.to_string());
        let where_ = download_whisper_model(
            "tiny.en",
            &dirs.models,
            fm.host.clone(),
            DownloadModelOptions {
                on_progress: Some(&on_progress),
                log: Some(&log),
                ..opts(&fm.catalog)
            },
        )
        .await
        .unwrap();
        assert_eq!(where_, dirs.models.join("tiny.en"));
        for (name, buf) in &fm.files {
            assert_eq!(std::fs::read(where_.join(name)).unwrap(), *buf, "{name}");
        }
        let seen = seen.lock();
        assert!(seen.len() > 10, "progress while downloading");
        let last = seen.last().unwrap();
        assert_eq!(last.bytes_done, last.bytes_total);
        assert_eq!(seen[0].file, None);
        let found = find_whisper_model("tiny.en", &dirs, &fm.catalog);
        assert_eq!(
            found,
            Some(FoundModel {
                name: "tiny.en".into(),
                dir: where_.clone(),
                source: ModelSource::Downloaded
            })
        );
        let marker: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(where_.join(MODEL_MARKER)).unwrap()).unwrap();
        assert_eq!(marker["repo"], "Systran/faster-whisper-tiny.en");
        assert_eq!(
            *logged.lock(),
            [
                "downloading tiny.en (0 MB) from huggingface.co/Systran/faster-whisper-tiny.en".to_string(),
                format!("tiny.en is ready in {}", where_.display())
            ]
        );
    }

    #[tokio::test]
    async fn a_model_bin_that_doesnt_match_its_hash_fails_is_not_marked_downloaded_and_a_retry_keeps_the_files_already_checked()
     {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let bad = fake_model(Some(Route::body(random_bytes(300_000))), vec![]);
        let err = download_whisper_model("tiny.en", &dirs.models, bad.host.clone(), opts(&bad.catalog))
            .await
            .unwrap_err();
        assert!(err.message.contains("sha256"), "{err}");
        assert_eq!(find_whisper_model("tiny.en", &dirs, &bad.catalog), None);
        assert!(!dirs.models.join("tiny.en").join("model.bin").exists());

        // The same small files, a good model.bin.
        let good = fake_model(None, vec![]);
        let mut entry = good.entry.clone();
        entry.files = good
            .entry
            .files
            .iter()
            .map(|f| {
                if f.name == "model.bin" {
                    f.clone()
                } else {
                    bad.entry.files.iter().find(|b| b.name == f.name).unwrap().clone()
                }
            })
            .collect();
        let catalog = catalog_with(&entry);
        let host = FakeDownloadHost::new(Vec::<(String, Route)>::new());
        for n in ["config.json", "tokenizer.json", "vocabulary.txt"] {
            let buf = bad.files.iter().find(|(name, _)| *name == n).unwrap().1.clone();
            host.route(model_file_url(&entry, n), Route::body(buf));
        }
        let good_bin = good.files.iter().find(|(n, _)| *n == "model.bin").unwrap().1.clone();
        host.route(model_file_url(&entry, "model.bin"), Route::body(good_bin));
        download_whisper_model("tiny.en", &dirs.models, host.clone(), opts(&catalog))
            .await
            .unwrap();
        assert_eq!(
            host.hits(&model_file_url(&entry, "config.json")),
            0,
            "checked files are kept"
        );
        assert_eq!(
            find_whisper_model("tiny.en", &dirs, &catalog).map(|f| f.source),
            Some(ModelSource::Downloaded)
        );
    }

    #[tokio::test]
    async fn a_download_that_keeps_stopping_halfway_fails_in_plain_words_and_leaves_the_model_not_downloaded() {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let fm = fake_model(Some(Route::body(Vec::new()).fail_at(0)), vec![]);
        let err = download_whisper_model("tiny.en", &dirs.models, fm.host.clone(), opts(&fm.catalog))
            .await
            .unwrap_err();
        assert!(err.message.contains("cut off"), "{err}");
        assert_eq!(find_whisper_model("tiny.en", &dirs, &fm.catalog), None);
    }

    #[tokio::test]
    async fn refuses_a_redirect_off_hugging_face_and_a_name_that_isnt_one_of_the_models() {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let fm = fake_model(None, vec![]);
        let evil = FakeDownloadHost::new(fm.entry.files.iter().map(|f| {
            (
                model_file_url(&fm.entry, &f.name),
                Route::redirect("https://evil.example/m"),
            )
        }));
        let err = download_whisper_model("tiny.en", &dirs.models, evil.clone(), opts(&fm.catalog))
            .await
            .unwrap_err();
        assert!(err.message.contains("refused"), "{err}");
        assert_eq!(evil.hits("https://evil.example/m"), 0);
        for name in ["../evil", "large-v3"] {
            let err = download_whisper_model(name, &dirs.models, evil.clone(), DownloadModelOptions::default())
                .await
                .unwrap_err();
            assert!(err.message.contains("not one of"), "{err}");
            assert!(err.has_code("UNKNOWN_MODEL"));
        }
        assert!(
            !dirs.models.join("large-v3").exists(),
            "nothing is made for a name that is not a model"
        );
    }

    fn write_model(dir: &Path, entry: &WhisperModel, files: &[(&str, Vec<u8>)], marker: bool) {
        std::fs::create_dir_all(dir).unwrap();
        for (n, b) in files {
            std::fs::write(dir.join(n), b).unwrap();
        }
        if marker {
            std::fs::write(
                dir.join(MODEL_MARKER),
                serde_json::json!({"repo": entry.repo, "revision": entry.revision}).to_string(),
            )
            .unwrap();
        } else {
            let _ = std::fs::remove_file(dir.join(MODEL_MARKER));
        }
    }

    #[test]
    fn one_that_comes_with_the_image_is_found_there_and_is_never_deleted() {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let fm = fake_model(None, vec![]);
        let image = dirs.bundled[0].join("tiny.en");
        write_model(&image, &fm.entry, &fm.files, true);
        assert_eq!(
            find_whisper_model("tiny.en", &dirs, &fm.catalog),
            Some(FoundModel {
                name: "tiny.en".into(),
                dir: image.clone(),
                source: ModelSource::Image
            })
        );
        let r = delete_whisper_model("tiny.en", &dirs, &fm.catalog).unwrap();
        assert!(r.removed.is_empty());
        assert_eq!(r.kept, Some(image.clone()));
        assert!(image.join("model.bin").exists());
    }

    #[test]
    fn one_the_old_version_left_in_hugging_faces_cache_is_found_and_deleting_it_frees_that_space() {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let fm = fake_model(None, vec![]);
        let repo_dir = dirs.caches[0]
            .join("hub")
            .join("models--Systran--faster-whisper-tiny.en");
        write_model(
            &repo_dir.join("snapshots").join(&fm.entry.revision),
            &fm.entry,
            &fm.files,
            false,
        );
        std::fs::create_dir_all(repo_dir.join("blobs")).unwrap();
        let found = find_whisper_model("tiny.en", &dirs, &fm.catalog).unwrap();
        assert_eq!(found.source, ModelSource::Cache);
        assert_eq!(found.dir, repo_dir.join("snapshots").join(&fm.entry.revision));
        let r = delete_whisper_model("tiny.en", &dirs, &fm.catalog).unwrap();
        assert_eq!(r.removed, vec![repo_dir.clone()]);
        assert!(!repo_dir.exists());
        assert_eq!(find_whisper_model("tiny.en", &dirs, &fm.catalog), None);
    }

    /// Fix round 1: a model that cannot be removed (held open by the speech-to-text worker, on Windows) is an
    /// error, not a model said to be deleted while it is still there.
    #[test]
    fn a_model_that_cannot_be_removed_is_an_error() {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let fm = fake_model(None, vec![]);
        let dir = dirs.models.join("tiny.en");
        write_model(&dir, &fm.entry, &fm.files, true);
        #[cfg(windows)]
        let held = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(dir.join("model.bin"))
                .unwrap()
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
            // Someone who may write anywhere (root, in a container) can remove it anyway: nothing to check then.
            if std::fs::write(dir.join("probe"), "x").is_ok() {
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
                return;
            }
        }
        let err = delete_whisper_model("tiny.en", &dirs, &fm.catalog).unwrap_err();
        assert!(!err.message.is_empty());
        assert!(dir.join("model.bin").exists(), "it is still there");
        #[cfg(windows)]
        drop(held);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            delete_whisper_model("tiny.en", &dirs, &fm.catalog).unwrap().removed,
            vec![dir.clone()]
        );
    }

    #[test]
    fn a_folder_missing_a_file_or_with_a_file_of_the_wrong_size_is_not_a_model_a_downloaded_one_deletes() {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let fm = fake_model(None, vec![]);
        let dir = dirs.models.join("tiny.en");
        let mut short = fm.files.clone();
        short[1].1.truncate(10);
        write_model(&dir, &fm.entry, &short, true);
        assert_eq!(find_whisper_model("tiny.en", &dirs, &fm.catalog), None);
        write_model(&dir, &fm.entry, &fm.files, false);
        assert_eq!(
            find_whisper_model("tiny.en", &dirs, &fm.catalog),
            None,
            "no marker: the download never finished"
        );
        write_model(&dir, &fm.entry, &fm.files, true);
        assert_eq!(
            find_whisper_model("tiny.en", &dirs, &fm.catalog).map(|f| f.source),
            Some(ModelSource::Downloaded)
        );
        assert_eq!(
            delete_whisper_model("tiny.en", &dirs, &fm.catalog).unwrap().removed,
            vec![dir.clone()]
        );
        assert!(!dir.exists());
    }

    // Added: what the Node tests did not reach.

    #[test]
    fn a_cache_snapshot_at_the_pinned_revision_comes_first_and_an_unknown_name_is_not_found() {
        let base = tmp_dir();
        let dirs = dirs(&base);
        let fm = fake_model(None, vec![]);
        let snaps = dirs.caches[0]
            .join("hub")
            .join("models--Systran--faster-whisper-tiny.en")
            .join("snapshots");
        write_model(&snaps.join("0000-other"), &fm.entry, &fm.files, false);
        write_model(&snaps.join(&fm.entry.revision), &fm.entry, &fm.files, false);
        write_model(&snaps.join("zzzz-other"), &fm.entry, &fm.files, false);
        assert_eq!(
            find_whisper_model("tiny.en", &dirs, &fm.catalog).unwrap().dir,
            snaps.join(&fm.entry.revision)
        );
        std::fs::remove_dir_all(snaps.join(&fm.entry.revision)).unwrap();
        assert!(
            find_whisper_model("tiny.en", &dirs, &fm.catalog).is_some(),
            "any complete one"
        );
        assert_eq!(find_whisper_model("large-v3", &dirs, &fm.catalog), None);
        let err = delete_whisper_model("large-v3", &dirs, &fm.catalog).unwrap_err();
        assert_eq!(
            err.message,
            "\"large-v3\" is not one of the speech models (tiny.en, base.en, small.en, tiny, base, small)"
        );
        assert!(model_bytes("nope", &fm.catalog).is_err());
        assert_eq!(
            model_bytes("tiny.en", &fm.catalog).unwrap(),
            fm.files.iter().map(|f| f.1.len() as u64).sum::<u64>()
        );
        assert_eq!(encode_uri_component("a b/ü.json"), "a%20b%2F%C3%BC.json");
        assert_eq!(
            serde_json::to_value(find_whisper_model("tiny.en", &dirs, &fm.catalog).unwrap()).unwrap()["source"],
            "cache"
        );
    }

    #[tokio::test]
    async fn the_docker_build_command_downloads_and_says_how_it_went() {
        let base = tmp_dir();
        let root = base.path().join("out");
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let host = FakeDownloadHost::new(Vec::<(String, Route)>::new());
        assert_eq!(
            run_download_command(host.clone(), &args(&["download", "base.en"])).await,
            2
        );
        assert_eq!(
            run_download_command(host.clone(), &args(&["fetch", "base.en", "x"])).await,
            2
        );
        // The real catalog against a host that has nothing: a 404, so it fails at once.
        let root_s = root.to_string_lossy().to_string();
        assert_eq!(
            run_download_command(host.clone(), &args(&["download", "base.en", &root_s])).await,
            1
        );
        assert_eq!(host.requests().len(), 1);
        assert_eq!(
            run_download_command(host.clone(), &args(&["download", "large", &root_s])).await,
            1
        );
    }
}
