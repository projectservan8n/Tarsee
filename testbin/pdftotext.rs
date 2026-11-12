//! Role `pdftotext`: plays poppler's pdftotext for the PDF reader's tests.
//!
//! - `pdftotext -v`: a version line on stderr, exit 0.
//! - `pdftotext -enc UTF-8 <file> -`: the text of the pages on stdout, each page followed by a form feed, with
//!   Windows line ends (as poppler writes them on Windows). The text is `TARSEE_TESTBIN_PDFTOTEXT_PAGES` split on
//!   `|` (default "Page one|Page two"), and each page also says the size of `<file>` and that it was read, so a test
//!   can see which file was given.
//! - `TARSEE_TESTBIN_STDERR` is written to stderr; `TARSEE_TESTBIN_EXIT` is the exit code (default 0);
//!   `TARSEE_TESTBIN_SLEEP_MS` waits that long first.
//! - Every run appends its arguments as one line of JSON to `TARSEE_TESTBIN_LOG`, when that is set.
//! - `TARSEE_TESTBIN_PDFTOTEXT_FLOOD`: write that many bytes, then hang with stderr open.

use std::io::Write;

pub fn main() -> i32 {
    let var = |name: &str| std::env::var(name).ok();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(log) = var("TARSEE_TESTBIN_LOG") {
        let line = serde_json::json!(args).to_string();
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let _ = writeln!(file, "{line}");
        }
    }
    if let Some(ms) = var("TARSEE_TESTBIN_SLEEP_MS").and_then(|v| v.parse::<u64>().ok()) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    if let Some(text) = var("TARSEE_TESTBIN_STDERR") {
        let _ = std::io::stderr().write_all(text.as_bytes());
    }
    let code = var("TARSEE_TESTBIN_EXIT")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0);
    if args.first().map(String::as_str) == Some("-v") {
        eprintln!("pdftotext version 0.0.0 (stand-in)");
        return code;
    }
    if code != 0 {
        return code;
    }
    // TARSEE_TESTBIN_PDFTOTEXT_FLOOD: write that many bytes to stdout, then wait a minute with stderr still open (a
    // program stuck writing more than its reader takes).
    if let Some(bytes) = var("TARSEE_TESTBIN_PDFTOTEXT_FLOOD").and_then(|v| v.parse::<usize>().ok()) {
        let chunk = vec![b'x'; 64 * 1024];
        let mut left = bytes;
        let mut stdout = std::io::stdout();
        while left > 0 {
            let n = left.min(chunk.len());
            if stdout.write_all(&chunk[..n]).is_err() {
                return 1;
            }
            left -= n;
        }
        let _ = stdout.flush();
        std::thread::sleep(std::time::Duration::from_secs(60));
        return 0;
    }
    // -enc UTF-8 <file> -
    let file = args.get(2).cloned().unwrap_or_default();
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    let pages = var("TARSEE_TESTBIN_PDFTOTEXT_PAGES").unwrap_or_else(|| "Page one|Page two".to_string());
    let mut out = String::new();
    for page in pages.split('|') {
        out.push_str(&page.replace('\n', "\r\n"));
        out.push_str(&format!("\r\n(read {size} bytes)\r\n\x0C"));
    }
    let _ = std::io::stdout().write_all(out.as_bytes());
    0
}
