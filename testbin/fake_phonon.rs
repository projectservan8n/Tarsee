//! Role `fake-phonon`: a Python that has ptts and runs `phonon_worker.py`'s protocol, for the Phonon engine's tests. A
//! test copies the stand-in as `fake-phonon` (`.exe` on Windows) and points TARSEE_PHONON_PYTHON at the copy.
//!
//! - `-I -c "import ptts"`: succeeds (fails when FAKE_PHONON_NO_PTTS is set).
//! - `-I -u <worker>`: prints a line that is not JSON, then `{ready: true, device, boot_ms, voices}` and answers each
//!   request line `{text, voice, duration_delta, out}` by writing a WAV to `out` and printing `{ok: true, ms}`.
//!
//! FAKE_PHONON_MODE changes the worker: "fail-start" (`{ready: false, error}`, then exit 1), "crash" (exit 3 on the
//! first request), "error" (`{ok: false, error: "boom"}`), "silent" (never says it is ready). Each start (with its
//! pid) and each request is appended as a JSON line to FAKE_PHONON_LOG when that is set.

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
    if !args.last().is_some_and(|a| a.ends_with("phonon_worker.py")) {
        eprintln!("fake phonon: nothing to do for {args:?}");
        return 2;
    }
    log(&json!({ "start": std::process::id(), "threads": std::env::var("PHONON_THREADS").ok(), "offline": std::env::var("HF_HUB_OFFLINE").ok() }));
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
        match mode.as_str() {
            "crash" => return 3,
            "error" => {
                out(&json!({ "ok": false, "error": "boom" }).to_string());
                continue;
            }
            _ => {}
        }
        let mut wav = b"RIFF".to_vec();
        wav.resize(24_044, 0);
        let path = req["out"].as_str().unwrap_or_default();
        if std::fs::write(path, wav).is_err() {
            out(&json!({ "ok": false, "error": format!("cannot write {path}") }).to_string());
            continue;
        }
        out(&json!({ "ok": true, "ms": 5 }).to_string());
    }
    0
}
