//! Port of `src/voice/whisper-engine.js`: the whisper.cpp STT engine.
//!
//! Starts the whisper-cli program to transcribe audio locally. Converts input audio to 16 kHz mono WAV with ffmpeg
//! first. Downloads the ggml model from Hugging Face on first use.
//!
//! The programs (`whisper-cli`, or `main` for older builds, and `ffmpeg`) are found on the app's `PATH`, with
//! `/opt/whisper/` as the last resort for whisper, as in the Node version.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, anyhow};
use serde::Serialize;
use tokio::io::AsyncReadExt;

use super::tts_interface::{exec_file, os_tmpdir, program_command};
use crate::app::App;
use crate::config::Config;
use crate::net::fetch::FetchRequest;
use crate::util::js::{now_ms, utf16_tail};

const DEFAULT_MODEL: &str = "ggml-base.en.bin";
const HF_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// Where the ggml models are kept: `<data>/whisper-models`.
pub fn models_dir(config: &Config) -> PathBuf {
    config.data_dir.join("whisper-models")
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Whether the whisper-cli program (or `main`, from older builds) is on the `PATH`.
pub async fn is_available(app: &App) -> bool {
    // Try whisper-cli first, then main (older builds)
    if exec_file(
        app.env(),
        "whisper-cli",
        &s(&["--version"]),
        None,
        Duration::from_secs(5),
    )
    .await
    .is_ok()
    {
        return true;
    }
    exec_file(app.env(), "main", &s(&["--help"]), None, Duration::from_secs(5))
        .await
        .is_ok()
}

/// What was heard: `{ text, language }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Transcript {
    pub text: String,
    pub language: String,
}

/// Transcribes audio (any format ffmpeg understands) with whisper.cpp. `model` is the model's file name (default
/// ggml-base.en.bin).
pub async fn transcribe(app: &App, audio: &[u8], model: Option<&str>) -> anyhow::Result<Transcript> {
    let model = model.filter(|m| !m.is_empty()).unwrap_or(DEFAULT_MODEL);
    let model_path = models_dir(app.config()).join(model);

    // Download the model if it is not there
    if !model_path.exists() {
        download_model(app, model).await?;
    }

    // Write the audio to a temporary file
    let tmp = os_tmpdir(app.env());
    let tmp_in = tmp.join(format!("whisper-in-{}.audio", now_ms()));
    let tmp_wav = tmp.join(format!("whisper-{}.wav", now_ms()));
    std::fs::write(&tmp_in, audio).with_context(|| format!("could not write {}", tmp_in.display()))?;

    // Convert to 16 kHz mono WAV with ffmpeg
    let converted = exec_file(
        app.env(),
        "ffmpeg",
        &[
            "-i".to_string(),
            tmp_in.to_string_lossy().into_owned(),
            "-ar".into(),
            "16000".into(),
            "-ac".into(),
            "1".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            tmp_wav.to_string_lossy().into_owned(),
            "-y".into(),
        ],
        None,
        Duration::from_secs(30),
    )
    .await;
    let _ = std::fs::remove_file(&tmp_in);
    converted.map_err(|err| anyhow!(err.to_string()))?;

    // Run whisper-cli (or 'main' for older builds)
    let binary = find_whisper_binary(app).await?;
    log::info!("[whisper] transcribing with {binary}, model={model}");

    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(4);
    let result = run_whisper(app, &binary, &model_path, &tmp_wav, threads).await;
    let _ = std::fs::remove_file(&tmp_wav);
    result
}

async fn run_whisper(
    app: &App,
    binary: &str,
    model_path: &std::path::Path,
    wav: &std::path::Path,
    threads: usize,
) -> anyhow::Result<Transcript> {
    let Some(mut cmd) = program_command(app.env(), binary) else {
        return Err(anyhow!("spawn {binary} ENOENT"));
    };
    cmd.args([
        "-m".to_string(),
        model_path.to_string_lossy().into_owned(),
        "-f".to_string(),
        wav.to_string_lossy().into_owned(),
        "--no-timestamps".to_string(),
        "-t".to_string(),
        threads.to_string(),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => anyhow!("spawn {binary} ENOENT"),
        _ => anyhow!(err),
    })?;
    let read = |pipe: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
        tokio::spawn(async move {
            let mut all = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut all).await;
            }
            String::from_utf8_lossy(&all).into_owned()
        })
    };
    let stdout = read(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    );
    let stderr = read(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    );

    // Hard timeout: killed after 60 s
    let status = match tokio::time::timeout(Duration::from_secs(60), child.wait()).await {
        Ok(status) => status?,
        Err(_) => {
            let _ = child.start_kill();
            child.wait().await?
        }
    };
    let stdout = stdout.await.unwrap_or_default();
    let stderr = stderr.await.unwrap_or_default();
    if status.code() != Some(0) {
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "null".into());
        return Err(anyhow!("Whisper exited with code {code}: {}", utf16_tail(&stderr, 200)));
    }
    Ok(Transcript {
        text: super::speech_text::js_trim(&stdout).to_string(),
        language: "en".into(),
    })
}

/// Finds the whisper program (whisper-cli or main).
async fn find_whisper_binary(app: &App) -> anyhow::Result<String> {
    for name in ["whisper-cli", "main"] {
        if exec_file(app.env(), name, &s(&["--version"]), None, Duration::from_secs(3))
            .await
            .is_ok()
        {
            return Ok(name.to_string());
        }
    }
    // Last resort: check /opt/whisper directly
    for name in ["/opt/whisper/whisper-cli", "/opt/whisper/main"] {
        if std::path::Path::new(name).exists() {
            return Ok(name.to_string());
        }
    }
    Err(anyhow!("whisper-cli binary not found. Check Docker build."))
}

/// Downloads a whisper.cpp GGML model (e.g. "ggml-base.en.bin") from Hugging Face.
pub async fn download_model(app: &App, model_name: &str) -> anyhow::Result<()> {
    let dir = models_dir(app.config());
    std::fs::create_dir_all(&dir)?;

    let url = format!("{HF_BASE}/{model_name}");
    let dest = dir.join(model_name);

    log::info!("[whisper] downloading model: {url}");

    let res = app
        .fetch()
        .fetch(FetchRequest::get(url.clone()).timeout(Duration::from_secs(300)))
        .await?;
    if !res.ok() {
        return Err(anyhow!("Model download failed ({}): {url}", res.status));
    }
    let bytes = res.bytes().await?;
    std::fs::write(&dest, &bytes)?;
    log::info!("[whisper] model saved: {}", dest.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{Answer, test_app_with_env};

    // The Node code had no tests. These need no program; tests/it/voice.rs starts the stand-ins.

    #[tokio::test]
    async fn a_model_is_downloaded_from_hugging_face_into_the_models_folder() {
        let t = test_app_with_env([("PATH", "")]);
        t.fetch.respond(
            format!("{HF_BASE}/ggml-tiny.bin"),
            Answer::bytes(200, "application/octet-stream", vec![5u8; 64]),
        );
        download_model(&t, "ggml-tiny.bin").await.unwrap();
        let file = models_dir(t.config()).join("ggml-tiny.bin");
        assert_eq!(std::fs::read(&file).unwrap(), vec![5u8; 64]);
        assert!(file.starts_with(&t.config().data_dir));

        t.fetch
            .respond(format!("{HF_BASE}/ggml-gone.bin"), Answer::text(404, "Entry not found"));
        let err = download_model(&t, "ggml-gone.bin").await.unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("Model download failed (404): {HF_BASE}/ggml-gone.bin")
        );
        assert!(!models_dir(t.config()).join("ggml-gone.bin").exists());
    }

    #[tokio::test]
    async fn without_the_programs_it_is_not_available_and_says_so() {
        let t = test_app_with_env([("PATH", "")]);
        let tmp = t.path().to_string_lossy().to_string();
        for name in ["TMPDIR", "TEMP", "TMP"] {
            t.env().set(name, tmp.clone());
        }
        assert!(!is_available(&t).await);
        t.fetch.respond(
            format!("{HF_BASE}/"),
            Answer::bytes(200, "application/octet-stream", vec![1u8; 8]),
        );
        let err = transcribe(&t, b"audio", None).await.unwrap_err();
        assert_eq!(err.to_string(), "spawnSync ffmpeg ENOENT");
        assert!(
            models_dir(t.config()).join(DEFAULT_MODEL).exists(),
            "the default model was fetched first"
        );
    }
}
