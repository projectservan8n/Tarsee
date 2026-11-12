//! Roles `piper`, `ffmpeg` and `whisper-cli`: the local speech programs the voice engines start.
//!
//! - `piper --model M --output_file O --sentence_silence S`: reads the text on stdin and writes O: "RIFF", then the
//!   text, then zeros up to `TARSEE_TESTBIN_PIPER_BYTES` bytes (default 1000).
//! - `ffmpeg -i IN ... OUT -y`: writes OUT as "RIFF" followed by IN's bytes.
//! - `whisper-cli -m MODEL -f WAV ...`: prints a transcript naming the model file and the size of the wav;
//!   `whisper-cli --version` prints a version.
//!
//! Each writes one JSON line `{"role", "args", "stdin"}` to the file `TARSEE_TESTBIN_LOG` when that is set, and
//! honours, for its own role (PIPER, FFMPEG, WHISPER): `TARSEE_TESTBIN_<ROLE>_EXIT` (exit with this code before doing
//! anything), `TARSEE_TESTBIN_<ROLE>_SLEEP_MS` (wait first) and `TARSEE_TESTBIN_<ROLE>_STDERR` (written to stderr).

use std::io::{Read, Write};

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn log(role: &str, args: &[String], stdin: &str) {
    if let Some(path) = var("TARSEE_TESTBIN_LOG")
        && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let line = serde_json::json!({ "role": role, "args": args, "stdin": stdin });
        let _ = writeln!(f, "{line}");
    }
}

/// The shared start of every role: the log line, the wait, stderr, and an early exit when asked for.
fn start(role: &str, key: &str, args: &[String], stdin: &str) -> Option<i32> {
    log(role, args, stdin);
    if let Some(ms) = var(&format!("TARSEE_TESTBIN_{key}_SLEEP_MS")).and_then(|v| v.parse::<u64>().ok()) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    if let Some(text) = var(&format!("TARSEE_TESTBIN_{key}_STDERR")) {
        eprint!("{text}");
    }
    var(&format!("TARSEE_TESTBIN_{key}_EXIT")).and_then(|v| v.parse().ok())
}

fn after(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

pub fn piper() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut text = String::new();
    let _ = std::io::stdin().read_to_string(&mut text);
    if let Some(code) = start("piper", "PIPER", &args, &text) {
        return code;
    }
    let Some(out) = after(&args, "--output_file") else {
        eprintln!("piper: no --output_file");
        return 2;
    };
    let size: usize = var("TARSEE_TESTBIN_PIPER_BYTES")
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let mut audio = b"RIFF".to_vec();
    audio.extend_from_slice(text.as_bytes());
    if audio.len() < size {
        audio.resize(size, 0);
    } else {
        audio.truncate(size);
    }
    match std::fs::write(&out, audio) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("piper: {err}");
            1
        }
    }
}

pub fn ffmpeg() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = start("ffmpeg", "FFMPEG", &args, "") {
        return code;
    }
    let (Some(input), Some(out)) = (after(&args, "-i"), args.iter().rev().find(|a| !a.starts_with('-'))) else {
        eprintln!("ffmpeg: nothing to do");
        return 2;
    };
    let Ok(data) = std::fs::read(&input) else {
        eprintln!("ffmpeg: {input}: No such file or directory");
        return 1;
    };
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&data);
    if std::fs::write(out, wav).is_err() {
        return 1;
    }
    0
}

pub fn whisper_cli() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = start("whisper-cli", "WHISPER", &args, "") {
        return code;
    }
    if args.iter().any(|a| a == "--version" || a == "--help") {
        println!("whisper-cli stand-in 1.0");
        return 0;
    }
    let model = after(&args, "-m").unwrap_or_default();
    let wav = after(&args, "-f").unwrap_or_default();
    let size = std::fs::metadata(&wav).map(|m| m.len()).unwrap_or(0);
    let model_name = std::path::Path::new(&model)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    println!("  hello from whisper ({model_name}, {size} bytes)  ");
    let _ = std::io::stdout().flush();
    0
}
