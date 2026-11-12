//! Role `echo`: says what it was started with, as one line of JSON on stdout.
//!
//!   {"args": [...], "cwd": "...", "env": {NAME: value-or-null, ...}, "stdin": "..."}
//!
//! - `env` holds the variables named in `TARSEE_TESTBIN_ECHO_ENV` (comma-separated); null for one that is unset.
//! - `stdin` is everything on stdin, read only when `TARSEE_TESTBIN_READ_STDIN=1`.
//! - `TARSEE_TESTBIN_STDERR` is written to stderr as it is, `TARSEE_TESTBIN_STDERR_REPEAT` times (default once).
//! - `TARSEE_TESTBIN_SLEEP_MS` waits that long before exiting (for tests of timeouts and of stopping a program).
//! - The exit code is `TARSEE_TESTBIN_EXIT` (default 0).

use std::io::{Read, Write};

pub fn main() -> i32 {
    let var = |name: &str| std::env::var(name).ok();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let mut env = serde_json::Map::new();
    for name in var("TARSEE_TESTBIN_ECHO_ENV")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        env.insert(
            name.to_string(),
            var(name)
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }

    let mut out = serde_json::json!({ "args": args, "cwd": cwd, "env": env });
    if var("TARSEE_TESTBIN_READ_STDIN").as_deref() == Some("1") {
        let mut stdin = String::new();
        let _ = std::io::stdin().read_to_string(&mut stdin);
        out["stdin"] = serde_json::Value::String(stdin);
    }
    println!("{out}");
    let _ = std::io::stdout().flush();

    if let Some(text) = var("TARSEE_TESTBIN_STDERR") {
        // Large output is made here, never handed in: Linux refuses an environment string over 128 KiB.
        let times = var("TARSEE_TESTBIN_STDERR_REPEAT")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(1);
        let mut stderr = std::io::stderr().lock();
        for _ in 0..times {
            let _ = stderr.write_all(text.as_bytes());
        }
        let _ = stderr.flush();
    }
    if let Some(ms) = var("TARSEE_TESTBIN_SLEEP_MS").and_then(|v| v.parse::<u64>().ok()) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    var("TARSEE_TESTBIN_EXIT").and_then(|v| v.parse().ok()).unwrap_or(0)
}
