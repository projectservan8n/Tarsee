//! Role `fake-phonon`: a Python that has ptts and runs the protocols of Tarsee's two speech workers, for the tests of
//! the Phonon engine and of the speech-to-text worker. A test copies the stand-in as `fake-phonon` (`.exe` on Windows)
//! and points TARSEE_PHONON_PYTHON (or a speech-to-text runtime) at the copy.
//!
//! - `-I -c "import ptts"`: succeeds (fails when FAKE_PHONON_NO_PTTS is set).
//! - `-I -u <.../phonon_worker.py>`: prints a line that is not JSON, then `{ready: true, device, boot_ms, voices}` and
//!   answers each request line `{text, voice, duration_delta, out}` by writing a WAV to `out` ("RIFF", the text, then
//!   zeros up to 24,044 bytes) and printing `{ok: true, ms}`.
//! - `-I -u <.../stt_worker.py>`: prints `{ready: true, version}` and answers each request line `{id, audio, ...}` with
//!   `{id, text: "heard <the audio file's size> bytes", language: "en", duration}`.
//!
//! FAKE_PHONON_MODE changes the worker: "fail-start" (`{ready: false, error}`, then exit 1), "crash" (exit 3 on the
//! first request), "error" (`{ok: false, error: "boom"}`), "silent" (never says it is ready). FAKE_PHONON_DELAY_MS
//! waits that long before each answer. Each start (with its pid) and each request is appended as a JSON line to
//! FAKE_PHONON_LOG when that is set. With FAKE_PHONON_LINGER set it keeps running after its input closes, so only a
//! kill ends it.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

fn log(line: &Value) {
    if let Ok(path) = std::env::var("FAKE_PHONON_LOG")
        && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

fn out(line: &str) {
    let mut o = std::io::stdout();
    let _ = writeln!(o, "{line}");
    let _ = o.flush();
}

fn delay() {
    if let Some(ms) = std::env::var("FAKE_PHONON_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

fn linger() {
    // A worker that does not notice its input closing: only killing it ends it.
    if std::env::var_os("FAKE_PHONON_LINGER").is_some() {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

pub fn main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = std::env::var("FAKE_PHONON_MODE").unwrap_or_default();
    if args.iter().any(|a| a == "-c") {
        if std::env::var_os("FAKE_PHONON_NO_PTTS").is_some() {
            eprintln!("ModuleNotFoundError: No module named 'ptts'");
            return 1;
        }
        return 0;
    }
    let script = args.last().cloned().unwrap_or_default();
    if script.ends_with("stt_worker.py") {
        return stt_worker(&mode);
    }
    if !script.ends_with("phonon_worker.py") {
        eprintln!("fake phonon: nothing to do for {args:?}");
        return 2;
    }
    log(
        &json!({ "start": std::process::id(), "threads": std::env::var("PHONON_THREADS").ok(), "offline": std::env::var("HF_HUB_OFFLINE").ok() }),
    );
    out("loading the model...");
    eprintln!("a warning on stderr");
    match mode.as_str() {
        "fail-start" => {
            out(&json!({ "ready": false, "error": "no model in /models" }).to_string());
            return 1;
        }
        "silent" => {}
        _ => out(&json!({ "ready": true, "device": "cpu", "boot_ms": 12, "voices": ["Toby", "Zoey"] }).to_string()),
    }
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        log(&json!({ "request": req }));
        delay();
        match mode.as_str() {
            "crash" => return 3,
            "error" => {
                out(&json!({ "ok": false, "error": "boom" }).to_string());
                continue;
            }
            _ => {}
        }
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(req["text"].as_str().unwrap_or_default().as_bytes());
        wav.resize(wav.len().max(24_044), 0);
        let path = req["out"].as_str().unwrap_or_default();
        if std::fs::write(path, wav).is_err() {
            out(&json!({ "ok": false, "error": format!("cannot write {path}") }).to_string());
            continue;
        }
        out(&json!({ "ok": true, "ms": 5 }).to_string());
    }
    linger();
    0
}

/// `stt_worker.py`'s side: ready, then one answer per request, carrying its id.
fn stt_worker(mode: &str) -> i32 {
    log(&json!({ "start": std::process::id(), "worker": "stt" }));
    if mode == "fail-start" {
        out(&json!({ "ready": false, "error": "ModuleNotFoundError: No module named 'faster_whisper'" }).to_string());
        return 1;
    }
    out(&json!({ "ready": true, "version": "1.2.1" }).to_string());
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        log(&json!({ "request": req }));
        delay();
        if mode == "crash" {
            return 3;
        }
        let size = std::fs::metadata(req["audio"].as_str().unwrap_or_default())
            .map(|m| m.len())
            .unwrap_or(0);
        out(&json!({ "id": req["id"], "text": format!("heard {size} bytes"), "language": "en", "duration": 1.0 }).to_string());
    }
    linger();
    0
}
