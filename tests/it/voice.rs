//! The voice code that starts programs: Piper and whisper.cpp (with ffmpeg), and the Python the speech workers run
//! on, each against its stand-in in `tarsee-testbin`.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tarsee::testkit::{Answer, TestApp, test_app_with_env, tmp_dir};
use tarsee::voice::piper_engine::{PiperTtsEngine, save_piper_voice, voices_dir};
use tarsee::voice::tts_interface::{SynthOptions, TtsEngine, exec_file};
use tarsee::voice::whisper_engine::{Transcript, is_available as whisper_available, models_dir, transcribe};
use tempfile::TempDir;

use crate::support::testbin_as;

/// A folder holding stand-ins under these names, a log they write to, and a temporary folder; and a test app whose
/// `PATH` is that folder.
struct Programs {
    t: TestApp,
    #[allow(dead_code)]
    bin: TempDir,
    #[allow(dead_code)]
    logs: TempDir,
    log: PathBuf,
    tmp: TempDir,
}

impl Programs {
    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// Files left in the temporary folder.
    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }
}

fn programs(names: &[&str], extra: &[(&str, &str)]) -> Programs {
    let bin = tmp_dir();
    for name in names {
        testbin_as(bin.path(), name);
    }
    let logs = tmp_dir();
    let log = logs.path().join("calls.jsonl");
    let tmp = tmp_dir();
    let tmp_s = tmp.path().to_string_lossy().to_string();
    let mut env: Vec<(String, String)> = vec![
        ("PATH".into(), bin.path().to_string_lossy().to_string()),
        ("TARSEE_TESTBIN_LOG".into(), log.to_string_lossy().to_string()),
        ("TMPDIR".into(), tmp_s.clone()),
        ("TEMP".into(), tmp_s.clone()),
        ("TMP".into(), tmp_s),
    ];
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let t = test_app_with_env(env);
    Programs { t, bin, logs, log, tmp }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

// ── Piper ────────────────────────────────────────────────────────────────

fn opts() -> SynthOptions {
    SynthOptions::default()
}

#[tokio::test]
async fn piper_is_given_the_cleaned_text_on_stdin_and_its_wav_is_read_back_and_removed() {
    let p = programs(&["piper"], &[]);
    save_piper_voice(p.t.env(), b"model", b"{}", "amy").unwrap();
    let engine = PiperTtsEngine::new(p.t.env(), None);
    assert!(
        engine.is_available().await,
        "the program is on the PATH and a voice is there"
    );
    let out = engine.synthesize("**Hello** world 😀", None, &opts()).await.unwrap();
    assert_eq!(out.content_type, "audio/wav");
    assert!(out.audio.starts_with(b"RIFFHello world"));
    assert_eq!(out.audio.len(), 1000);

    let calls = p.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["stdin"], "Hello world");
    let args: Vec<String> = serde_json::from_value(calls[0]["args"].clone()).unwrap();
    assert_eq!(args[0], "--model");
    assert_eq!(PathBuf::from(&args[1]), voices_dir(p.t.env()).join("amy.onnx"));
    assert_eq!(args[2], "--output_file");
    let wav = PathBuf::from(&args[3]);
    assert_eq!(wav.parent(), Some(p.tmp.path()));
    let wav_name = wav.file_name().unwrap().to_string_lossy().to_string();
    assert!(
        wav_name.starts_with("piper-") && wav_name.ends_with(".wav") && wav_name.len() == 18,
        "{wav_name}"
    );
    assert_eq!(args[4..], s(&["--sentence_silence", "0.3"]));
    assert!(p.leftovers().is_empty(), "the wav is removed");
}

#[tokio::test]
async fn piper_uses_the_voice_asked_for_then_the_default_then_the_first() {
    let p = programs(&["piper"], &[]);
    save_piper_voice(p.t.env(), b"m", b"{}", "amy").unwrap();
    save_piper_voice(p.t.env(), b"m", b"{}", "bob").unwrap();
    let model_of = |call: &Value| {
        PathBuf::from(call["args"][1].as_str().unwrap())
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string()
    };
    let with_default = PiperTtsEngine::new(p.t.env(), Some("bob"));
    with_default.synthesize("hi", Some("amy"), &opts()).await.unwrap();
    with_default.synthesize("hi", Some("nobody"), &opts()).await.unwrap();
    with_default.synthesize("hi", None, &opts()).await.unwrap();
    let calls = p.calls();
    assert_eq!(model_of(&calls[0]), "amy.onnx");
    assert_eq!(model_of(&calls[1]), "bob.onnx");
    assert_eq!(model_of(&calls[2]), "bob.onnx");
    // Neither asked for nor a default: the first the folder lists.
    PiperTtsEngine::new(p.t.env(), None)
        .synthesize("hi", Some("nobody"), &opts())
        .await
        .unwrap();
    assert!(["amy.onnx", "bob.onnx"].contains(&model_of(&p.calls()[3]).as_str()));
}

#[tokio::test]
async fn piper_failing_or_writing_too_little_is_an_error_and_leaves_nothing() {
    let p = programs(&["piper"], &[("TARSEE_TESTBIN_PIPER_EXIT", "3")]);
    save_piper_voice(p.t.env(), b"m", b"{}", "amy").unwrap();
    let engine = PiperTtsEngine::new(p.t.env(), None);
    let err = engine.synthesize("hello", None, &opts()).await.unwrap_err();
    let model = voices_dir(p.t.env()).join("amy.onnx");
    assert!(
        err.message.starts_with(&format!(
            "Command failed: piper --model {} --output_file ",
            model.display()
        )),
        "{err}"
    );
    assert!(err.message.ends_with(" --sentence_silence 0.3"), "{err}");

    p.t.env().remove("TARSEE_TESTBIN_PIPER_EXIT");
    p.t.env().set("TARSEE_TESTBIN_PIPER_BYTES", "99");
    let err = engine.synthesize("hello", None, &opts()).await.unwrap_err();
    assert_eq!(err.message, "Piper generated empty audio");
    assert!(p.leftovers().is_empty());
}

#[tokio::test]
async fn a_program_that_runs_too_long_is_stopped_in_node_s_words() {
    let p = programs(&["piper"], &[("TARSEE_TESTBIN_PIPER_SLEEP_MS", "5000")]);
    let started = std::time::Instant::now();
    let err = exec_file(p.t.env(), "piper", &[], Some(b"x"), Duration::from_millis(300))
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "spawnSync piper ETIMEDOUT");
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "it was killed, not waited for"
    );
}

// ── whisper.cpp ──────────────────────────────────────────────────────────

fn put_model(p: &Programs, name: &str) -> PathBuf {
    let dir = models_dir(p.t.config());
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    std::fs::write(&file, b"ggml").unwrap();
    file
}

#[tokio::test]
async fn whisper_converts_with_ffmpeg_then_transcribes_and_cleans_up() {
    let p = programs(&["ffmpeg", "whisper-cli"], &[]);
    let model = put_model(&p, "ggml-base.en.bin");
    assert!(whisper_available(&p.t).await);
    let audio = b"OggS-some-audio";
    let heard = transcribe(&p.t, audio, None).await.unwrap();
    let wav_size = 4 + audio.len();
    assert_eq!(
        heard,
        Transcript {
            text: format!("hello from whisper (ggml-base.en.bin, {wav_size} bytes)"),
            language: "en".into()
        }
    );

    let calls: Vec<Value> = p.calls().into_iter().skip(1).collect(); // after is_available's --version
    assert_eq!(calls[0]["role"], "ffmpeg");
    let ff: Vec<String> = serde_json::from_value(calls[0]["args"].clone()).unwrap();
    assert_eq!(ff[0], "-i");
    let tmp_in = PathBuf::from(&ff[1]);
    assert_eq!(tmp_in.parent(), Some(p.tmp.path()));
    let name = tmp_in.file_name().unwrap().to_string_lossy().to_string();
    assert!(name.starts_with("whisper-in-") && name.ends_with(".audio"), "{name}");
    assert_eq!(ff[2..8], s(&["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]));
    let wav = PathBuf::from(&ff[8]);
    assert_eq!(ff[9], "-y");
    assert_eq!(
        calls[1]["args"],
        serde_json::json!(["--version"]),
        "the program is looked for"
    );
    let w: Vec<String> = serde_json::from_value(calls[2]["args"].clone()).unwrap();
    assert_eq!(w[0..2], [s(&["-m"])[0].clone(), model.to_string_lossy().to_string()]);
    assert_eq!(
        w[2..5],
        [
            s(&["-f"])[0].clone(),
            wav.to_string_lossy().to_string(),
            "--no-timestamps".into()
        ]
    );
    assert_eq!(w[5], "-t");
    let threads: usize = w[6].parse().unwrap();
    assert!((1..=4).contains(&threads));
    assert!(p.leftovers().is_empty(), "both temporary files are removed");
}

#[tokio::test]
async fn whisper_downloads_a_missing_model_first() {
    let p = programs(&["ffmpeg", "whisper-cli"], &[]);
    let url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";
    p.t.fetch
        .respond(url, Answer::bytes(200, "application/octet-stream", vec![1u8; 32]));
    let heard = transcribe(&p.t, b"x", Some("ggml-tiny.en.bin")).await.unwrap();
    assert!(heard.text.contains("ggml-tiny.en.bin"), "{}", heard.text);
    assert_eq!(p.t.fetch.calls_to(url).len(), 1);
    assert!(models_dir(p.t.config()).join("ggml-tiny.en.bin").exists());
}

#[tokio::test]
async fn whisper_failing_says_its_exit_code_and_the_end_of_what_it_printed() {
    let tail = format!("{}END", "x".repeat(300));
    let p = programs(
        &["ffmpeg", "whisper-cli"],
        &[
            ("TARSEE_TESTBIN_WHISPER_EXIT", "2"),
            ("TARSEE_TESTBIN_WHISPER_STDERR", &tail),
        ],
    );
    put_model(&p, "ggml-base.en.bin");
    let err = transcribe(&p.t, b"x", None).await.unwrap_err();
    assert_eq!(
        err.to_string(),
        format!("Whisper exited with code 2: {}", &tail[tail.len() - 200..])
    );
    assert!(p.leftovers().is_empty());
}

#[tokio::test]
async fn whisper_from_an_older_build_or_missing_altogether() {
    let p = programs(&["ffmpeg", "main"], &[]);
    put_model(&p, "ggml-base.en.bin");
    assert!(whisper_available(&p.t).await, "`main --help` answers");
    let heard = transcribe(&p.t, b"x", None).await.unwrap();
    assert!(heard.text.starts_with("hello from whisper"));

    let none = programs(&["ffmpeg"], &[]);
    put_model(&none, "ggml-base.en.bin");
    assert!(!whisper_available(&none.t).await);
    if !std::path::Path::new("/opt/whisper").exists() {
        let err = transcribe(&none.t, b"x", None).await.unwrap_err();
        assert_eq!(err.to_string(), "whisper-cli binary not found. Check Docker build.");
    }

    let no_ffmpeg = programs(&["whisper-cli"], &[("TARSEE_TESTBIN_FFMPEG_EXIT", "1")]);
    put_model(&no_ffmpeg, "ggml-base.en.bin");
    let err = transcribe(&no_ffmpeg.t, b"x", None).await.unwrap_err();
    assert_eq!(err.to_string(), "spawnSync ffmpeg ENOENT");
    assert!(
        no_ffmpeg.leftovers().is_empty(),
        "the audio written for ffmpeg is removed"
    );

    let bad_ffmpeg = programs(&["ffmpeg", "whisper-cli"], &[("TARSEE_TESTBIN_FFMPEG_EXIT", "1")]);
    put_model(&bad_ffmpeg, "ggml-base.en.bin");
    let err = transcribe(&bad_ffmpeg.t, b"x", None).await.unwrap_err();
    assert!(err.to_string().starts_with("Command failed: ffmpeg -i "), "{err}");
}
