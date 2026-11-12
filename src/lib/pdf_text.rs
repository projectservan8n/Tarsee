//! Port of `src/lib/pdf-text.js`: the text of a PDF, for an AI that can't read PDF files itself (ai/media, design
//! 4.12) and for the pdf_read tool (tarsee_pdf_read, design 4.9).
//!
//! Two readers, tried in this order by [`PdfReader::pdf_text`]:
//!  - pdftotext (poppler-utils; the Docker image installs it). It reads nearly anything.
//!  - a small built-in reader, for a machine without pdftotext (a developer's PC) or a PDF pdftotext gave up on. It
//!    reads ordinary PDFs: compressed content, object streams (PDF 1.5+), fonts with a ToUnicode map, text drawn
//!    from form XObjects. It can't open a PDF locked with a password, and like pdftotext it finds no text in
//!    scanned pages (pictures of text).
//!
//! The pdf_read tool ([`read_pdf_tool`], run by lib/tools executeTool, so Tool Permissions and the audit log apply)
//! reads a PDF in the workspace (the uploads folder, where the channels and the dashboard save what people send, is
//! in it) or at a web address, a few whole pages at a time: by default its answer stays under what a tool result
//! shows inline (ai/context-limits, about 12,000 characters) and says which pages to ask for next. A web address
//! is only fetched when it resolves to a public address (no loopback, private network or cloud metadata host), on
//! every redirect too.
//!
//! **Where a download connects.** The Node version did not use `fetch` for this: it used `http.get` with its own
//! `lookup`, so the socket connected to exactly the addresses the guard had checked (no second DNS answer could
//! point it somewhere else between the check and the connection). [`fetch_pdf`] keeps that: its HTTP client
//! resolves names only through the [`Lookup`] it is given (by default [`GuardedLookup`] over the system resolver),
//! and connects to the addresses that lookup returned. That is why this module builds its own client instead of
//! going through `app.fetch()`: the `Fetch` trait cannot say "connect only to this checked address". The client
//! uses no proxy (a proxy would resolve the name itself) and does not ask for compressed bodies, as `http.get` did
//! not.

#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::rc::Rc;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use parking_lot::Mutex;
use regex::bytes::Regex as BytesRegex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::app::App;
use crate::config::Config;
use crate::db::settings::Settings;
use crate::env::Env;
use crate::lib::safe_path::{is_sensitive_path, resolve_path};
use crate::lib::url_safety::check_url_safety;
use crate::util::js::{number_to_string, utf16_len, utf16_tail, utf16_truncate};

/// How much of a PDF's text goes inline into a message for an AI that can't read PDFs (design 4.12).
pub const PDF_INLINE_CHARS: usize = 30_000;
/// pdf_read's answer by default: under what a tool result shows inline. The model may ask for up to the most.
pub const PDF_READ_DEFAULT_CHARS: usize = 10_000;
pub const PDF_READ_MAX_CHARS: usize = 50_000;
/// The biggest PDF read, from disk or from the web.
pub const PDF_MAX_BYTES: usize = 100 * 1024 * 1024;

const PDFTOTEXT_TIMEOUT_MS: u64 = 60_000;
const DOWNLOAD_TIMEOUT_MS: u64 = 30_000;
/// pdftotext's output is read up to this much (the JS `maxBuffer`).
const PDFTOTEXT_MAX_BUFFER: usize = 64 * 1024 * 1024;

/// The last few PDFs read are kept, by their bytes' hash: the model reading a long PDF a few pages at a time.
const CACHE_ENTRIES: usize = 6;
const CACHE_MAX_CHARS: usize = 5_000_000;

// ---------------------------------------------------------------- JavaScript text helpers

/// `\s` in a JavaScript regex, and what `trim()` removes.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

fn js_space_unit(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(js_space)
}

/// `\s` on one byte of text read as Latin-1, as the JS read a PDF.
fn js_space_byte(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | 0x0B | 0x0C | b'\r' | b' ' | 0xA0)
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(js_space)
}

/// `Number(value)` for a JSON value (a missing one is NaN).
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number_from_str(s),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => js_number_from_str(&js_string(one)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Number(text)`: blank is 0; decimal, `0x`, `0o`, `0b` and `Infinity` forms; anything else NaN.
fn js_number_from_str(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = t
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
        && t.chars().any(|c| c.is_ascii_digit());
    if !valid {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|v| if v.is_null() { String::new() } else { js_string(v) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `n.toLocaleString("en-US")`: thousands separated by commas, at most three decimals.
fn en_us(n: f64) -> String {
    let fixed = format!("{:.3}", n.abs());
    let (int, frac) = fixed.split_once('.').unwrap_or((&fixed, ""));
    let frac = frac.trim_end_matches('0');
    let mut grouped = String::new();
    for (k, c) in int.chars().enumerate() {
        if k > 0 && (int.len() - k) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let sign = if n < 0.0 { "-" } else { "" };
    if frac.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{frac}")
    }
}

/// `Math.max` (NaN wins, as in JavaScript).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// JavaScript truthiness of a number.
fn truthy_num(n: f64) -> bool {
    n != 0.0 && !n.is_nan()
}

// ---------------------------------------------------------------- Which reader

/// Which reader read a PDF.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReaderKind {
    Pdftotext,
    Builtin,
}

impl ReaderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ReaderKind::Pdftotext => "pdftotext",
            ReaderKind::Builtin => "builtin",
        }
    }
}

/// A PDF's text, one string per page: `{ pages, reader, error? }`. `pages` is empty and `error` says why when
/// nothing could be read.
#[derive(Debug, Clone, PartialEq)]
pub struct PdfTextResult {
    pub pages: Vec<String>,
    /// `None` when the bytes were not a PDF at all.
    pub reader: Option<ReaderKind>,
    pub error: Option<String>,
}

/// Options of [`PdfReader::pdf_text`].
#[derive(Debug, Clone)]
pub struct PdfTextOptions {
    /// The PDF's own path, when it is on disk (saves pdftotext a copy).
    pub file: Option<PathBuf>,
    /// How long pdftotext may take.
    pub timeout: Duration,
}

impl Default for PdfTextOptions {
    fn default() -> Self {
        PdfTextOptions {
            file: None,
            timeout: Duration::from_millis(PDFTOTEXT_TIMEOUT_MS),
        }
    }
}

/// The pdftotext command, as far as it is known.
#[derive(Debug, Clone)]
enum Pdftotext {
    /// Not looked for yet.
    Unknown,
    /// Not installed.
    Missing,
    /// This command.
    Bin(PathBuf),
}

/// The two readers and the cache of what they read: the Node module's `_pdftotext` and `_cache`, kept in the
/// `App` (`PdfReader::of(app)`).
pub struct PdfReader {
    /// The environment pdftotext is found in and started with.
    env: Env,
    pdftotext: Mutex<Pdftotext>,
    /// Oldest first.
    cache: Mutex<Vec<(String, PdfTextResult)>>,
}

impl PdfReader {
    pub fn new(env: Env) -> Self {
        PdfReader {
            env,
            pdftotext: Mutex::new(Pdftotext::Unknown),
            cache: Mutex::new(Vec::new()),
        }
    }

    /// The app's reader, made on first use.
    pub fn of(app: &App) -> Arc<PdfReader> {
        app.get_or_init(|| PdfReader::new(app.env().clone()))
    }

    /// Use this pdftotext command, or (`None`) none installed; the cache is emptied (`__setPdftotextForTests(bin)`).
    pub fn set_pdftotext(&self, bin: Option<PathBuf>) {
        *self.pdftotext.lock() = match bin {
            Some(bin) => Pdftotext::Bin(bin),
            None => Pdftotext::Missing,
        };
        self.cache.lock().clear();
    }

    /// Look for pdftotext again next time; the cache is emptied (`__setPdftotextForTests()`).
    pub fn forget_pdftotext(&self) {
        *self.pdftotext.lock() = Pdftotext::Unknown;
        self.cache.lock().clear();
    }

    /// A command started with this reader's environment and nothing else, without a console window on Windows.
    fn command(&self, program: &Path) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(program);
        cmd.env_clear()
            .envs(self.env.snapshot())
            .stdin(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }

    /// A program as Node's `execFile` found it: a bare name on the `PATH` of this reader's environment (not the
    /// server's own, which a test does not control), anything with a folder in it as it is.
    fn find_program(&self, program: &Path) -> Option<PathBuf> {
        if program.components().count() > 1 || program.is_absolute() {
            return Some(program.to_path_buf());
        }
        // On Windows the variable is often spelled "Path".
        let path = self
            .env
            .snapshot()
            .into_iter()
            .find(|(name, _)| {
                if cfg!(windows) {
                    name.eq_ignore_ascii_case("PATH")
                } else {
                    name == "PATH"
                }
            })
            .map(|(_, value)| value)?;
        let cwd = std::env::current_dir().unwrap_or_default();
        which::which_in(program, Some(path), cwd).ok()
    }

    async fn pdftotext_bin(&self) -> Option<PathBuf> {
        match &*self.pdftotext.lock() {
            Pdftotext::Bin(bin) => return Some(bin.clone()),
            Pdftotext::Missing => return None,
            Pdftotext::Unknown => {}
        }
        // -v exits non-zero on some builds; only "not found" (or a hang) means there is none.
        let found = match self.find_program(Path::new("pdftotext")) {
            None => None,
            Some(bin) => {
                let mut cmd = self.command(&bin);
                cmd.arg("-v").stdout(Stdio::null()).stderr(Stdio::null());
                match cmd.spawn() {
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
                    Err(_) => Some(bin),
                    Ok(mut child) => match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
                        Ok(_) => Some(bin),
                        Err(_) => {
                            let _ = child.kill().await;
                            None
                        }
                    },
                }
            }
        };
        let known = match found {
            Some(bin) => Pdftotext::Bin(bin),
            None => Pdftotext::Missing,
        };
        *self.pdftotext.lock() = known.clone();
        match known {
            Pdftotext::Bin(bin) => Some(bin),
            _ => None,
        }
    }

    /// pdftotext's text of `file`, or the error it gave (its first line on stderr that is not a syntax warning).
    async fn run_pdftotext(&self, bin: &Path, file: &Path, timeout: Duration) -> Result<String, String> {
        let Some(program) = self.find_program(bin) else {
            return Err(format!("spawn {} ENOENT", bin.display()));
        };
        let mut cmd = self.command(&program);
        cmd.arg("-enc")
            .arg("UTF-8")
            .arg(file)
            .arg("-")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                format!("spawn {} ENOENT", bin.display())
            } else {
                format!("spawn {} {err}", bin.display())
            }
        })?;
        let mut stdout = child.stdout.take().ok_or("pdftotext gave no output")?;
        let mut stderr = child.stderr.take().ok_or("pdftotext gave no output")?;
        let read_out = async {
            let mut out = Vec::new();
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let n = stdout.read(&mut chunk).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(out);
                }
                out.extend_from_slice(&chunk[..n]);
                if out.len() > PDFTOTEXT_MAX_BUFFER {
                    return Err("stdout maxBuffer length exceeded".to_string());
                }
            }
        };
        let read_err = async {
            let mut err = Vec::new();
            let _ = (&mut stderr).take(1024 * 1024).read_to_end(&mut err).await;
            err
        };
        let run = async {
            let (out, err) = tokio::join!(read_out, read_err);
            let status = child.wait().await.map_err(|e| e.to_string())?;
            Ok::<_, String>((out, err, status))
        };
        let command_line = format!("{} -enc UTF-8 {} -", bin.display(), file.display());
        let (out, err, status) = match tokio::time::timeout(timeout, run).await {
            Ok(done) => done?,
            // kill_on_drop ends it.
            Err(_) => return Err(format!("Command failed: {command_line}")),
        };
        let said = || -> Option<String> {
            String::from_utf8_lossy(&err)
                .split('\n')
                .map(|l| l.trim_end_matches('\r').trim().to_string())
                .find(|l| !l.is_empty() && !is_syntax_line(l))
        };
        let out = match out {
            Ok(out) => out,
            Err(message) => return Err(said().unwrap_or(message)),
        };
        if !status.success() {
            let stderr_text = String::from_utf8_lossy(&err).into_owned();
            return Err(said().unwrap_or(format!("Command failed: {command_line}\n{stderr_text}")));
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// A PDF's text, one string per page. pdftotext when it is installed, else (or when it fails) the built-in
    /// reader. A PDF read before (the same bytes) comes from the cache.
    pub async fn pdf_text(&self, buffer: Bytes, options: PdfTextOptions) -> PdfTextResult {
        if !is_pdf(&buffer) {
            return PdfTextResult {
                pages: vec![],
                reader: None,
                error: Some("this isn't a PDF".into()),
            };
        }
        let key = hex::encode(Sha256::digest(&buffer));
        {
            let mut cache = self.cache.lock();
            if let Some(at) = cache.iter().position(|(k, _)| *k == key) {
                let hit = cache.remove(at);
                let result = hit.1.clone();
                cache.push(hit);
                return result;
            }
        }

        let mut result: Option<PdfTextResult> = None;
        if let Some(bin) = self.pdftotext_bin().await {
            let mut tmp: Option<tempfile::TempDir> = None;
            let src = match &options.file {
                Some(file) => Ok(file.clone()),
                None => match tempfile::Builder::new().prefix("tarsee-pdf-").tempdir() {
                    Ok(dir) => {
                        let src = dir.path().join("in.pdf");
                        let written = tokio::fs::write(&src, &buffer).await;
                        tmp = Some(dir);
                        written.map(|_| src).map_err(|e| e.to_string())
                    }
                    Err(err) => Err(err.to_string()),
                },
            };
            if let Ok(src) = src
                && let Ok(text) = self.run_pdftotext(&bin, &src, options.timeout).await
            {
                result = Some(PdfTextResult {
                    pages: split_pdftotext(&text),
                    reader: Some(ReaderKind::Pdftotext),
                    error: None,
                });
            }
            // The temporary copy goes with `tmp`.
            drop(tmp);
        }
        let result = match result {
            Some(result) => result,
            None => {
                let bytes = buffer.clone();
                let own = tokio::task::spawn_blocking(move || builtin_pdf_text(&bytes))
                    .await
                    .unwrap_or_else(|err| BuiltinText {
                        pages: vec![],
                        error: Some(format!("it could not be read ({err})")),
                    });
                match own.error {
                    Some(error) if own.pages.is_empty() => PdfTextResult {
                        pages: vec![],
                        reader: Some(ReaderKind::Builtin),
                        error: Some(error),
                    },
                    _ => PdfTextResult {
                        pages: own.pages,
                        reader: Some(ReaderKind::Builtin),
                        error: None,
                    },
                }
            }
        };
        let chars: usize = result.pages.iter().map(|p| utf16_len(p)).sum();
        if result.error.is_none() && chars <= CACHE_MAX_CHARS {
            let mut cache = self.cache.lock();
            cache.push((key, result.clone()));
            while cache.len() > CACHE_ENTRIES {
                cache.remove(0);
            }
        }
        result
    }
}

/// `/^Syntax (Warning|Error)/i`
fn is_syntax_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.starts_with("syntax warning") || lower.starts_with("syntax error")
}

/// The app's [`PdfReader::pdf_text`].
pub async fn pdf_text(app: &App, buffer: Bytes, options: PdfTextOptions) -> PdfTextResult {
    PdfReader::of(app).pdf_text(buffer, options).await
}

/// True when the bytes are a PDF ("%PDF-" in the first kilobyte, as readers allow).
pub fn is_pdf(buffer: &[u8]) -> bool {
    let head = &buffer[..buffer.len().min(1024)];
    head.windows(5).any(|w| w == b"%PDF-")
}

/// pdftotext's output: a form feed after each page.
fn split_pdftotext(out: &str) -> Vec<String> {
    let text = out.replace("\r\n", "\n").replace('\r', "\n");
    let mut pages: Vec<&str> = text.split('\x0C').collect();
    if pages.len() > 1 && pages.last().is_some_and(|p| js_trim(p).is_empty()) {
        pages.pop();
    }
    pages.into_iter().map(tidy).collect()
}

/// A page's text with control characters out, runs of spaces as one, and no more than one blank line in a row.
fn tidy(t: &str) -> String {
    let kept: String = t
        .chars()
        .filter(|c| !matches!(c, '\u{00}'..='\u{08}' | '\u{0B}' | '\u{0C}' | '\u{0E}'..='\u{1F}' | '\u{7F}'))
        .collect();
    let lines: Vec<String> = kept
        .split('\n')
        .map(|line| {
            let mut out = String::with_capacity(line.len());
            let mut in_run = false;
            for c in line.chars() {
                if matches!(c, ' ' | '\t' | '\u{A0}') {
                    if !in_run {
                        out.push(' ');
                    }
                    in_run = true;
                } else {
                    out.push(c);
                    in_run = false;
                }
            }
            js_trim(&out).to_string()
        })
        .collect();
    let joined = lines.join("\n");
    // `.replace(/\n{3,}/g, "\n\n")`
    let mut out = String::with_capacity(joined.len());
    let mut breaks = 0usize;
    for c in joined.chars() {
        if c == '\n' {
            breaks += 1;
            if breaks <= 2 {
                out.push('\n');
            }
        } else {
            breaks = 0;
            out.push(c);
        }
    }
    js_trim(&out).to_string()
}

// ---------------------------------------------------------------- Pages

/// Pages `first` to `last`, counted from 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageRange {
    pub first: usize,
    pub last: usize,
}

/// Which pages to read: "3", "2-5", "6-" (to the end), "all" or nothing (null: all of them), against the page count.
/// Returns the range (`last` clamped to the count), or an error in words the model can act on.
pub fn parse_page_range(spec: &Value, count: usize) -> Result<PageRange, String> {
    let all = PageRange { first: 1, last: count };
    match spec {
        Value::Null => return Ok(all),
        Value::String(s) if js_trim(s).is_empty() => return Ok(all),
        _ => {}
    }
    let shown = js_string(spec);
    let t = js_trim(&shown).to_lowercase();
    if t == "all" {
        return Ok(all);
    }
    // `/^(\d+)\s*(?:(-)\s*(\d*))?$/`
    let bad = || format!("\"{shown}\" isn't a page or a range of pages: use 3, 2-5, or 6- for page 6 to the end.");
    let digits_end = t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len());
    if digits_end == 0 {
        return Err(bad());
    }
    let first_digits = &t[..digits_end];
    let rest = t[digits_end..].trim_start_matches(js_space);
    let (dash, last_digits) = if rest.is_empty() {
        (false, "")
    } else if let Some(after) = rest.strip_prefix('-') {
        let after = after.trim_start_matches(js_space);
        if !after.chars().all(|c| c.is_ascii_digit()) {
            return Err(bad());
        }
        (true, after)
    } else {
        return Err(bad());
    };
    let first: f64 = first_digits.parse().unwrap_or(f64::INFINITY);
    let count_f = count as f64;
    let last = if dash {
        if last_digits.is_empty() {
            count_f
        } else {
            last_digits.parse().unwrap_or(f64::INFINITY)
        }
    } else {
        first
    };
    if first < 1.0 || last < first {
        return Err(format!(
            "\"{shown}\" isn't a range of pages: pages count from 1, e.g. 2-5."
        ));
    }
    if first > count_f {
        return Err(format!(
            "this PDF has {count} page{}, so there is no page {}.",
            if count == 1 { "" } else { "s" },
            number_to_string(first)
        ));
    }
    Ok(PageRange {
        first: first as usize,
        last: last.min(count_f) as usize,
    })
}

/// What [`fit_pages`] fitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FittedPages {
    pub text: String,
    /// The last page shown.
    pub last: usize,
    /// The one page shown was cut.
    pub partial: bool,
}

/// Whole pages, each under a "--- Page N ---" line, as many as fit in `max_chars` (UTF-16 units, as the JS
/// counted). A first page longer than that is cut. `pages`: the texts of pages `first`, `first + 1`, ...
pub fn fit_pages(pages: &[String], first: usize, max_chars: usize) -> FittedPages {
    let mut text = String::new();
    let mut text_len = 0usize;
    let mut last = first.saturating_sub(1);
    let mut partial = false;
    for (k, page) in pages.iter().enumerate() {
        let n = first + k;
        let body = if page.is_empty() {
            "(no text on this page)"
        } else {
            page.as_str()
        };
        let block = format!("--- Page {n} ---\n{body}\n\n");
        let block_len = utf16_len(&block);
        if text_len + block_len <= max_chars {
            text.push_str(&block);
            text_len += block_len;
            last = n;
            continue;
        }
        if k == 0 {
            let cut = utf16_truncate(&block, max_chars.saturating_sub(2));
            text = format!("{}\n…", js_trim_end(&cut));
            last = n;
            partial = true;
        }
        break;
    }
    FittedPages {
        text: js_trim_end(&text).to_string(),
        last,
        partial,
    }
}

// ---------------------------------------------------------------- The pdf_read tool

/// pdf_read: `{ path (or file_path, source, url), pages?, max_chars? }` -> the text, or "pdf_read error: ..." saying
/// what to do. A path is the workspace's (absolute, or relative to it); anything outside it, or a protected file
/// (credentials, keys, databases), is refused. An http(s) address is downloaded when it is public. `settings`
/// holds the Safe Browsing key for the address check.
pub async fn read_pdf_tool(app: &App, input: &Value, settings: Option<&dyn Settings>) -> String {
    let where_ = ["path", "file_path", "source", "url"]
        .iter()
        .find_map(|key| match input.get(*key) {
            Some(Value::String(s)) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
            _ => None,
        });
    let Some(where_) = where_ else {
        return "pdf_read error: 'path' is required: a PDF in the workspace (e.g. uploads/report.pdf) or a web address."
            .into();
    };
    let asked = js_number(input.get("max_chars"));
    let wanted = if asked.is_finite() && asked > 0.0 {
        asked
    } else {
        PDF_READ_DEFAULT_CHARS as f64
    };
    let max_chars = wanted.max(1_000.0).min(PDF_READ_MAX_CHARS as f64);

    let buffer: Bytes;
    let name: String;
    let mut file: Option<PathBuf> = None;
    let lower = where_.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let safety = check_url_safety(&where_, settings, &*app.fetch()).await;
        if !safety.safe {
            return format!(
                "pdf_read error: that address is blocked ({}).",
                safety.reason.unwrap_or_default()
            );
        }
        match fetch_pdf(&where_, FetchPdfOptions::default()).await {
            Ok(bytes) => buffer = Bytes::from(bytes),
            Err(err) => return format!("pdf_read error: {err}"),
        }
        name = url_file_name(&where_);
    } else {
        let found = match locate(app.config(), &where_) {
            Ok(found) => found,
            Err(error) => return format!("pdf_read error: {error}"),
        };
        name = base_name(&found);
        match tokio::fs::read(&found).await {
            Ok(bytes) => buffer = Bytes::from(bytes),
            Err(err) => {
                let message = crate::lib::safe_path::fs_error_message(&err, "open", &found);
                return format!("pdf_read error: {name} could not be opened ({message}).");
            }
        }
        file = Some(found);
    }
    if !is_pdf(&buffer) {
        return format!("pdf_read error: {name} isn't a PDF.");
    }

    let r = PdfReader::of(app)
        .pdf_text(
            buffer,
            PdfTextOptions {
                file,
                ..PdfTextOptions::default()
            },
        )
        .await;
    if r.pages.is_empty() {
        return format!(
            "pdf_read error: {name} could not be read: {}.",
            r.error
                .as_deref()
                .filter(|e| !e.is_empty())
                .unwrap_or("no pages were found in it")
        );
    }
    let total = r.pages.len();
    let range = match parse_page_range(input.get("pages").unwrap_or(&Value::Null), total) {
        Ok(range) => range,
        Err(error) => return format!("pdf_read error: {error}"),
    };
    if !r.pages.iter().any(|p| !js_trim(p).is_empty()) {
        return format!(
            "{name} has {total} page{}, but no text could be taken out of it: its pages are probably scanned (pictures of text), which this tool can't read.",
            if total == 1 { "" } else { "s" }
        );
    }

    let fit = fit_pages(&r.pages[range.first - 1..range.last], range.first, max_chars as usize);
    let mut out = vec![
        format!("{name}: pages {}-{} of {total}", range.first, fit.last),
        String::new(),
        fit.text,
    ];
    let mut tail = Vec::new();
    if fit.partial {
        tail.push(format!(
            "Page {} is longer than {} characters and was cut off; ask again with a bigger max_chars (up to {}) to see more of it.",
            fit.last,
            en_us(max_chars),
            en_us(PDF_READ_MAX_CHARS as f64)
        ));
    }
    if fit.last < range.last {
        tail.push(format!(
            "Pages {}-{} are not shown yet. To read on, ask for pages \"{}-{}\".",
            fit.last + 1,
            range.last,
            fit.last + 1,
            range.last
        ));
    }
    if !tail.is_empty() {
        out.push(String::new());
        out.push(format!("[{}]", tail.join(" ")));
    }
    out.join("\n")
}

/// `path.basename`.
fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `fs.realpathSync`: the path with every link followed. On Windows the `\\?\` that `canonicalize` puts in front
/// is taken off again, so the path reads as Node wrote it.
fn real_path(path: &Path) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = real.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\")
            && rest.as_bytes().get(1) == Some(&b':')
        {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(real)
}

/// A workspace path, checked: its real path, or why it can't be read.
fn locate(config: &Config, where_: &str) -> Result<PathBuf, String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for root in [&config.workspace_dir, &config.claude_workspace_dir] {
        if root.as_os_str().is_empty() {
            continue;
        }
        let resolved = resolve_path(root, "");
        if !roots.contains(&resolved) {
            roots.push(resolved);
        }
    }
    let candidates: Vec<PathBuf> = if Path::new(where_).is_absolute() {
        vec![resolve_path(Path::new(""), where_)]
    } else {
        roots.iter().map(|r| resolve_path(r, where_)).collect()
    };
    let Some(first) = candidates.first() else {
        return Err(format!("there is no file at {where_}."));
    };
    if candidates.iter().any(is_sensitive_path) {
        return Err(format!("{} can't be read with this tool.", base_name(first)));
    }
    let Some(real) = candidates.iter().find_map(|c| real_path(c).ok()) else {
        return Err(format!("there is no file at {}.", first.display()));
    };
    let real_roots: Vec<PathBuf> = roots
        .iter()
        .map(|r| real_path(r).unwrap_or_else(|_| r.clone()))
        .collect();
    let real_text = real.to_string_lossy();
    let inside = real_roots.iter().any(|r| {
        let r = r.to_string_lossy();
        real_text == r || real_text.starts_with(&format!("{r}{}", std::path::MAIN_SEPARATOR))
    });
    if !inside {
        return Err(format!(
            "{} is outside the workspace. Copy the file into the workspace (its uploads folder is a good place) and read it from there.",
            real.display()
        ));
    }
    if is_sensitive_path(&real) {
        return Err(format!("{} can't be read with this tool.", base_name(&real)));
    }
    let st = std::fs::metadata(&real).map_err(|err| {
        format!(
            "{} could not be opened ({}).",
            real.display(),
            crate::lib::safe_path::fs_error_message(&err, "stat", &real)
        )
    })?;
    if !st.is_file() {
        return Err(format!("{} is a folder, not a PDF.", real.display()));
    }
    if st.len() > PDF_MAX_BYTES as u64 {
        return Err(format!(
            "{} is {} MB; the most this tool reads is {} MB.",
            base_name(&real),
            (st.len() as f64 / 1024.0 / 1024.0).round(),
            PDF_MAX_BYTES / 1024 / 1024
        ));
    }
    Ok(real)
}

/// `decodeURIComponent`: `None` for a broken escape or bytes that are not UTF-8.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The file name at the end of a web address, made safe ("document.pdf" when there is none).
fn url_file_name(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return "document.pdf".into();
    };
    let last = parsed.path().rsplit('/').next().unwrap_or("");
    let Some(decoded) = decode_uri_component(last) else {
        return "document.pdf".into();
    };
    // `.replace(/[^\w.\- ()]+/g, "_")`
    let mut cleaned = String::new();
    let mut in_run = false;
    for c in decoded.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ' ' | '(' | ')') {
            cleaned.push(c);
            in_run = false;
        } else {
            if !in_run {
                cleaned.push('_');
            }
            in_run = true;
        }
    }
    let tail = utf16_tail(&cleaned, 120);
    if tail.is_empty() { "document.pdf".into() } else { tail }
}

// ---------------------------------------------------------------- Downloading

/// Whether an IP address is one a tool must never be pointed at: loopback, private networks (RFC 1918, ULA),
/// link-local (169.254.0.0/16 holds the cloud metadata service), carrier-grade NAT, multicast, reserved and
/// unspecified addresses, IPv4 inside IPv6 (mapped, NAT64, 6to4) by the IPv4 rules. Anything not an IP address is
/// refused too.
pub fn is_private_address(ip: &str) -> bool {
    let lower = ip.trim().to_lowercase();
    let mut a = lower.as_str();
    a = a.strip_prefix('[').unwrap_or(a);
    a = a.strip_suffix(']').unwrap_or(a);
    if let Some(zone) = a.find('%') {
        a = &a[..zone];
    }
    if let Some(octets) = parse_ipv4(a) {
        return private4(octets);
    }
    if a.parse::<std::net::Ipv6Addr>().is_err() {
        return true;
    }
    let Some(g) = expand6(a) else {
        return true;
    };
    let v4 = |hi: u32, lo: u32| [hi >> 8, hi & 255, lo >> 8, lo & 255];
    if g[..5].iter().all(|&x| x == 0) && (g[5] == 0xffff || g[5] == 0) {
        // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), :: and ::1
        if g[5] == 0 && g[6] == 0 && g[7] <= 1 {
            return true;
        }
        return private4(v4(g[6], g[7]));
    }
    if g[0] == 0x64 && g[1] == 0xff9b && g[2..6].iter().all(|&x| x == 0) {
        return private4(v4(g[6], g[7])); // NAT64
    }
    if g[0] == 0x2002 {
        return private4(v4(g[1], g[2])); // 6to4
    }
    if (g[0] & 0xfe00) == 0xfc00 {
        return true; // unique local
    }
    if (g[0] & 0xffc0) == 0xfe80 {
        return true; // link-local
    }
    if (g[0] & 0xffc0) == 0xfec0 {
        return true; // site-local (old)
    }
    if (g[0] & 0xff00) == 0xff00 {
        return true; // multicast
    }
    if g[0] == 0x2001 && g[1] == 0x0db8 {
        return true; // documentation
    }
    false
}

/// A dotted-decimal IPv4 address as `net.isIP` accepts it (no leading zeros).
fn parse_ipv4(a: &str) -> Option<[u32; 4]> {
    let ip: std::net::Ipv4Addr = a.parse().ok()?;
    let [w, x, y, z] = ip.octets();
    Some([u32::from(w), u32::from(x), u32::from(y), u32::from(z)])
}

fn private4([a, b, c, _]: [u32; 4]) -> bool {
    a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b == 18 || b == 19))
}

/// An IPv6 address as its 8 groups, or `None`.
fn expand6(a: &str) -> Option<Vec<u32>> {
    let mut a = a.to_string();
    let mut tail: Vec<u32> = Vec::new();
    // `/(\d+)\.(\d+)\.(\d+)\.(\d+)$/`
    if let Some(start) = dotted_tail(&a) {
        let p: Vec<u32> = a[start..].split('.').map(|n| n.parse().unwrap_or(u32::MAX)).collect();
        tail = vec![(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
        a.truncate(start);
        if a.ends_with(':') && !a.ends_with("::") {
            a.pop();
        }
    }
    let groups = |s: &str| -> Vec<u32> {
        s.split(':')
            .filter(|h| !h.is_empty())
            .map(|h| u32::from_str_radix(h, 16).unwrap_or(u32::MAX))
            .collect()
    };
    let out: Vec<u32> = if let Some((head, rest)) = a.split_once("::") {
        let rest = rest.split("::").next().unwrap_or("");
        let hs = groups(head);
        let rs = groups(rest);
        let fill = 8i64 - hs.len() as i64 - rs.len() as i64 - tail.len() as i64;
        if fill < 0 {
            return None;
        }
        let mut out = hs;
        out.extend(std::iter::repeat_n(0, fill as usize));
        out.extend(rs);
        out.extend(tail);
        out
    } else {
        let mut out = groups(&a);
        out.extend(tail);
        out
    };
    (out.len() == 8 && out.iter().all(|&x| x <= 0xffff)).then_some(out)
}

/// Where four dot-separated decimal numbers end the text, if they do.
fn dotted_tail(a: &str) -> Option<usize> {
    let bytes = a.as_bytes();
    let mut end = bytes.len();
    let mut start = end;
    for part in 0..4 {
        let digits_end = end;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start == digits_end {
            return None;
        }
        if part < 3 {
            if start == 0 || bytes[start - 1] != b'.' {
                return None;
            }
            start -= 1;
            end = start;
        }
    }
    Some(start)
}

/// Why a name could not be looked up: `ENOTFOUND` (no answer) or `EPRIVATE` (it is on a private or local network).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct LookupError {
    pub code: String,
    pub message: String,
}

/// Turns a host name into the addresses a connection may go to (`dns.lookup(host, { all: true })`). Tests swap it
/// to point a name at a local server.
#[async_trait]
pub trait Lookup: Send + Sync + 'static {
    async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, LookupError>;
}

/// The machine's own resolver.
pub struct SystemLookup;

#[async_trait]
impl Lookup for SystemLookup {
    async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, LookupError> {
        let found = tokio::net::lookup_host((hostname, 0)).await.map_err(|_| LookupError {
            code: "ENOTFOUND".into(),
            message: format!("getaddrinfo ENOTFOUND {hostname}"),
        })?;
        let mut addrs: Vec<IpAddr> = Vec::new();
        for addr in found {
            if !addrs.contains(&addr.ip()) {
                addrs.push(addr.ip());
            }
        }
        Ok(addrs)
    }
}

/// A lookup that refuses a host resolving to any private or local address (so a connection never starts).
pub struct GuardedLookup<L: Lookup = SystemLookup> {
    inner: L,
}

impl<L: Lookup> GuardedLookup<L> {
    pub fn new(inner: L) -> Self {
        GuardedLookup { inner }
    }
}

#[async_trait]
impl<L: Lookup> Lookup for GuardedLookup<L> {
    async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, LookupError> {
        let addrs = self.inner.lookup(hostname).await?;
        if addrs.is_empty() || addrs.iter().any(|ip| is_private_address(&ip.to_string())) {
            return Err(LookupError {
                code: "EPRIVATE".into(),
                message: format!(
                    "that address is on a private or local network ({hostname}), which this tool doesn't read from"
                ),
            });
        }
        Ok(addrs)
    }
}

/// The guarded system lookup every download uses unless told otherwise (`guardedLookup`).
pub fn guarded_lookup() -> Arc<dyn Lookup> {
    Arc::new(GuardedLookup::new(SystemLookup))
}

/// The HTTP client's resolver: every name goes through the [`Lookup`], and the connection goes to the addresses it
/// returned and no others.
struct PinnedResolver(Arc<dyn Lookup>);

impl reqwest::dns::Resolve for PinnedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let lookup = self.0.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = lookup
                .lookup(&host)
                .await
                .map_err(|err| Box::new(err) as Box<dyn std::error::Error + Send + Sync>)?;
            let addrs: Vec<SocketAddr> = addrs.into_iter().map(|ip| SocketAddr::new(ip, 0)).collect();
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Options of [`fetch_pdf`].
#[derive(Clone)]
pub struct FetchPdfOptions {
    pub lookup: Arc<dyn Lookup>,
    pub max_bytes: usize,
    /// The longest the connection may sit idle.
    pub timeout: Duration,
    pub max_redirects: usize,
}

impl Default for FetchPdfOptions {
    fn default() -> Self {
        FetchPdfOptions {
            lookup: guarded_lookup(),
            max_bytes: PDF_MAX_BYTES,
            timeout: Duration::from_millis(DOWNLOAD_TIMEOUT_MS),
            max_redirects: 3,
        }
    }
}

/// A download that did not work; the message says what went wrong.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct FetchPdfError(pub String);

/// Download a PDF from a public http(s) address: at most `max_bytes`, following up to `max_redirects` redirects,
/// every host checked (an IP address directly, a name through `lookup`, which refuses private addresses).
pub async fn fetch_pdf(url: &str, options: FetchPdfOptions) -> Result<Vec<u8>, FetchPdfError> {
    let fail = |m: &str| FetchPdfError(m.to_string());
    let mut current = url.to_string();
    for _hop in 0..=options.max_redirects {
        let u = url::Url::parse(&current).map_err(|_| fail("that isn't a web address"))?;
        if u.scheme() != "http" && u.scheme() != "https" {
            return Err(fail("only http and https addresses can be read"));
        }
        let host = u.host_str().unwrap_or("");
        let host = host.strip_prefix('[').unwrap_or(host);
        let host = host.strip_suffix(']').unwrap_or(host);
        if host.parse::<IpAddr>().is_ok() && is_private_address(host) {
            return Err(FetchPdfError(format!(
                "that address is on a private or local network ({host}), which this tool doesn't read from"
            )));
        }
        match download(&u, &options).await? {
            Downloaded::Redirect(location) => {
                current = u.join(&location).map_err(|_| fail("Invalid URL"))?.to_string();
            }
            Downloaded::Body(body) => return Ok(body),
        }
    }
    Err(fail("the address redirected too many times"))
}

enum Downloaded {
    Redirect(String),
    Body(Vec<u8>),
}

/// The words for a failed request: the lookup's own refusal when that was it, else what went wrong underneath.
fn download_error(err: &reqwest::Error, u: &url::Url) -> FetchPdfError {
    if err.is_timeout() {
        return FetchPdfError("the download took too long".into());
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    let mut innermost = err.to_string();
    while let Some(e) = source {
        if let Some(lookup) = e.downcast_ref::<LookupError>() {
            return FetchPdfError(lookup.message.clone());
        }
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            let target = format!(
                "{}:{}",
                u.host_str().unwrap_or(""),
                u.port_or_known_default().unwrap_or(0)
            );
            match io.kind() {
                std::io::ErrorKind::TimedOut => return FetchPdfError("the download took too long".into()),
                std::io::ErrorKind::ConnectionRefused => {
                    return FetchPdfError(format!("connect ECONNREFUSED {target}"));
                }
                std::io::ErrorKind::ConnectionReset => return FetchPdfError("read ECONNRESET".into()),
                _ => {}
            }
        }
        innermost = e.to_string();
        source = e.source();
    }
    FetchPdfError(innermost)
}

async fn download(u: &url::Url, options: &FetchPdfOptions) -> Result<Downloaded, FetchPdfError> {
    let max_bytes = options.max_bytes;
    let too_big = || {
        FetchPdfError(format!(
            "the download is too big (over {})",
            if max_bytes >= 1024 * 1024 {
                format!("{} MB", (max_bytes as f64 / 1024.0 / 1024.0).round())
            } else {
                format!("{max_bytes} bytes")
            }
        ))
    };
    let client = reqwest::Client::builder()
        .dns_resolver(Arc::new(PinnedResolver(options.lookup.clone())))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .no_gzip()
        .connect_timeout(options.timeout)
        .read_timeout(options.timeout)
        .build()
        .map_err(|err| FetchPdfError(err.to_string()))?;
    let res = client
        .get(u.clone())
        .header("User-Agent", "Tarsee")
        .header("Accept", "application/pdf,*/*")
        .send()
        .await
        .map_err(|err| download_error(&err, u))?;
    let status = res.status().as_u16();
    let location = res
        .headers()
        .get("location")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .filter(|v| !v.is_empty());
    if (300..400).contains(&status)
        && let Some(location) = location
    {
        return Ok(Downloaded::Redirect(location));
    }
    if status != 200 {
        return Err(FetchPdfError(format!("the address answered HTTP {status}")));
    }
    let declared = res
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .map(js_number_from_str);
    if declared.is_some_and(|n| n > max_bytes as f64) {
        return Err(too_big());
    }
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| download_error(&err, u))?;
        if body.len() + chunk.len() > max_bytes {
            return Err(too_big());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Downloaded::Body(body))
}

// ---------------------------------------------------------------- The built-in reader

const MAX_PAGES: usize = 5000;
const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;
const MAX_DECODED_BYTES: usize = 256 * 1024 * 1024;
/// A TJ gap wider than this (thousandths of the font size) is a space between words.
const TJ_SPACE: f64 = -200.0;

/// What the built-in reader read: `{ pages }` (one string per page, "" for a page without text) or
/// `{ pages: [], error }`.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltinText {
    pub pages: Vec<String>,
    pub error: Option<String>,
}

/// A failure inside the reader. Parse failures are caught where the JS caught them; the others end the read (or
/// the page) with this message.
#[derive(Debug, Clone)]
struct ReadError(String);

/// A PDF value. Names are "/Name" text, strings `Str` (the bytes, one character per byte), references `Ref` (only
/// when refs are parsed: not in content streams), dictionaries keyed without the "/", keywords `Kw`.
#[derive(Debug, Clone, PartialEq)]
enum V {
    Null,
    Bool(bool),
    Num(f64),
    Name(String),
    Str(Vec<u8>),
    Arr(Vec<V>),
    Dict(HashMap<String, V>),
    Ref(f64),
    Kw(String),
}

/// Text read as Latin-1: each byte one character.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// `value?.[key]`: a dictionary's entry (an array's element by its index), with `null` read as missing, as `??` and
/// `?.` treated it.
fn prop<'a>(value: Option<&'a V>, key: &str) -> Option<&'a V> {
    let found = match value? {
        V::Dict(d) => d.get(key),
        V::Arr(items) => {
            let canonical =
                !key.is_empty() && (key == "0" || !key.starts_with('0')) && key.bytes().all(|b| b.is_ascii_digit());
            if canonical {
                key.parse::<usize>().ok().and_then(|i| items.get(i))
            } else {
                None
            }
        }
        _ => None,
    };
    found.filter(|v| !matches!(v, V::Null))
}

fn is_name(value: Option<&V>, name: &str) -> bool {
    matches!(value, Some(V::Name(n)) if n == name)
}

/// JavaScript truthiness.
fn truthy(value: Option<&V>) -> bool {
    match value {
        None | Some(V::Null) => false,
        Some(V::Bool(b)) => *b,
        Some(V::Num(n)) => truthy_num(*n),
        Some(V::Name(n)) => !n.is_empty(),
        _ => true,
    }
}

/// `asArray`: an array as it is, nothing as empty, anything else as a one-element list.
fn as_array(value: Option<&V>) -> Vec<&V> {
    match value {
        Some(V::Arr(items)) => items.iter().collect(),
        None | Some(V::Null) => vec![],
        Some(other) => vec![other],
    }
}

/// `Number(value)` for a PDF value.
fn v_number(value: Option<&V>) -> f64 {
    match value {
        None => f64::NAN,
        Some(V::Null) => 0.0,
        Some(V::Bool(b)) => f64::from(u8::from(*b)),
        Some(V::Num(n)) => *n,
        Some(V::Arr(items)) => match items.as_slice() {
            [] => 0.0,
            [V::Num(n)] => *n,
            [V::Null] => 0.0,
            _ => f64::NAN,
        },
        _ => f64::NAN,
    }
}

const WS_DELIM: &[u8] = b"\0\t\n\x0C\r ()<>[]{}/%";

fn is_delim(b: u8) -> bool {
    WS_DELIM.contains(&b)
}

fn skip_ws(s: &[u8], mut i: usize) -> usize {
    while i < s.len() {
        let c = s[i];
        if c == b'%' {
            while i < s.len() && s[i] != b'\n' && s[i] != b'\r' {
                i += 1;
            }
        } else if matches!(c, b' ' | b'\n' | b'\r' | b'\t' | 0x0C | 0) {
            i += 1;
        } else {
            break;
        }
    }
    i
}

fn parse_name(s: &[u8], i: usize) -> (String, usize) {
    let mut j = i + 1;
    while j < s.len() && !is_delim(s[j]) {
        j += 1;
    }
    let raw = &s[(i + 1).min(s.len())..j];
    let mut out = Vec::with_capacity(raw.len());
    let mut k = 0;
    while k < raw.len() {
        if raw[k] == b'#'
            && let Some(pair) = raw.get(k + 1..k + 3)
            && pair.iter().all(u8::is_ascii_hexdigit)
        {
            out.push(u8::from_str_radix(&latin1(pair), 16).unwrap_or(0));
            k += 3;
            continue;
        }
        out.push(raw[k]);
        k += 1;
    }
    (format!("/{}", latin1(&out)), j)
}

fn parse_literal(s: &[u8], mut i: usize) -> (V, usize) {
    let mut depth = 1;
    let mut out = Vec::new();
    i += 1;
    while i < s.len() {
        let c = s[i];
        if c == b'\\' {
            let d = s.get(i + 1).copied();
            i += 2;
            let Some(d) = d else { break };
            let escaped = match d {
                b'n' => Some(b'\n'),
                b'r' => Some(b'\r'),
                b't' => Some(b'\t'),
                b'b' => Some(0x08),
                b'f' => Some(0x0C),
                b'(' => Some(b'('),
                b')' => Some(b')'),
                b'\\' => Some(b'\\'),
                _ => None,
            };
            if let Some(e) = escaped {
                out.push(e);
                continue;
            }
            if (b'0'..=b'7').contains(&d) {
                let mut o = u32::from(d - b'0');
                let mut n = 1;
                while n < 3 && i < s.len() && (b'0'..=b'7').contains(&s[i]) {
                    o = o * 8 + u32::from(s[i] - b'0');
                    i += 1;
                    n += 1;
                }
                out.push((o & 0xff) as u8);
                continue;
            }
            if d == b'\r' {
                if s.get(i) == Some(&b'\n') {
                    i += 1;
                }
                continue;
            }
            if d == b'\n' {
                continue;
            }
            out.push(d);
            continue;
        }
        if c == b'(' {
            depth += 1;
        } else if c == b')' {
            depth -= 1;
            if depth == 0 {
                return (V::Str(out), i + 1);
            }
        }
        out.push(c);
        i += 1;
    }
    (V::Str(out), i)
}

/// `NUM_RE` (`/[+-]?(?:\d+\.?\d*|\.\d+)/y`) at `i`: where the number ends.
fn match_num(s: &[u8], i: usize) -> Option<usize> {
    let digit = |k: usize| s.get(k).is_some_and(u8::is_ascii_digit);
    let mut j = i;
    if matches!(s.get(j), Some(b'+' | b'-')) {
        j += 1;
    }
    let digits = j;
    while digit(j) {
        j += 1;
    }
    if j > digits {
        if s.get(j) == Some(&b'.') {
            j += 1;
            while digit(j) {
                j += 1;
            }
        }
        return Some(j);
    }
    if s.get(j) == Some(&b'.') && digit(j + 1) {
        j += 1;
        while digit(j) {
            j += 1;
        }
        return Some(j);
    }
    None
}

/// `REF_RE` (`/\s+\d+\s+R(?=[\s()<>[\]{}/%]|$)/y`) at `i`: where the reference ends.
fn match_ref(s: &[u8], i: usize) -> Option<usize> {
    let mut j = i;
    let start = j;
    while j < s.len() && js_space_byte(s[j]) {
        j += 1;
    }
    if j == start {
        return None;
    }
    let digits = j;
    while j < s.len() && s[j].is_ascii_digit() {
        j += 1;
    }
    if j == digits {
        return None;
    }
    let spaces = j;
    while j < s.len() && js_space_byte(s[j]) {
        j += 1;
    }
    if j == spaces || s.get(j) != Some(&b'R') {
        return None;
    }
    j += 1;
    match s.get(j) {
        None => Some(j),
        Some(&b) if js_space_byte(b) || b"()<>[]{}/%".contains(&b) => Some(j),
        _ => None,
    }
}

fn parse_err(m: &str) -> ReadError {
    ReadError(m.to_string())
}

/// One PDF value at `s[i]`: the value and the next index.
fn parse_value(s: &[u8], i: usize, refs: bool, depth: usize) -> Result<(V, usize), ReadError> {
    if depth > 64 {
        return Err(parse_err("nested too deep"));
    }
    let mut i = skip_ws(s, i);
    let Some(&c) = s.get(i) else {
        return Err(parse_err("unexpected end"));
    };
    if c == b'<' {
        if s.get(i + 1) == Some(&b'<') {
            let mut d = HashMap::new();
            i += 2;
            loop {
                i = skip_ws(s, i);
                if i >= s.len() {
                    return Err(parse_err("unclosed dictionary"));
                }
                if s[i] == b'>' && s.get(i + 1) == Some(&b'>') {
                    return Ok((V::Dict(d), i + 2));
                }
                if s[i] != b'/' {
                    i = parse_value(s, i, refs, depth + 1)?.1;
                    continue;
                }
                let (key, j) = parse_name(s, i);
                let (val, k) = parse_value(s, j, refs, depth + 1)?;
                d.insert(key[1..].to_string(), val);
                i = k;
            }
        }
        let stop = s[i + 1..]
            .iter()
            .position(|&b| b == b'>')
            .map_or(s.len(), |p| i + 1 + p);
        let mut h: Vec<u8> = s[i + 1..stop].iter().copied().filter(u8::is_ascii_hexdigit).collect();
        if h.len() % 2 == 1 {
            h.push(b'0');
        }
        let bytes = hex::decode(&h).unwrap_or_default();
        return Ok((V::Str(bytes), stop + 1));
    }
    if c == b'(' {
        return Ok(parse_literal(s, i));
    }
    if c == b'[' {
        let mut a = Vec::new();
        i += 1;
        loop {
            i = skip_ws(s, i);
            if i >= s.len() {
                return Err(parse_err("unclosed array"));
            }
            if s[i] == b']' {
                return Ok((V::Arr(a), i + 1));
            }
            let (v, j) = parse_value(s, i, refs, depth + 1)?;
            a.push(v);
            i = j;
        }
    }
    if c == b'/' {
        let (name, j) = parse_name(s, i);
        return Ok((V::Name(name), j));
    }
    if (matches!(c, b'+' | b'-' | b'.') || c.is_ascii_digit())
        && let Some(end) = match_num(s, i)
    {
        let text = latin1(&s[i..end]);
        let v: f64 = text.parse().unwrap_or(f64::NAN);
        i = end;
        if refs
            && text.bytes().all(|b| b.is_ascii_digit())
            && let Some(after) = match_ref(s, i)
        {
            return Ok((V::Ref(v), after));
        }
        return Ok((V::Num(if v.is_finite() { v } else { 0.0 }), i));
    }
    let mut j = i;
    while j < s.len() && !is_delim(s[j]) {
        j += 1;
    }
    if j == i {
        return Err(ReadError(format!("unexpected {}", char::from(c))));
    }
    let w = latin1(&s[i..j]);
    let v = match w.as_str() {
        "true" => V::Bool(true),
        "false" => V::Bool(false),
        "null" => V::Null,
        _ => V::Kw(w),
    };
    Ok((v, j))
}

/// `/(\d+)\s+(\d+)\s+obj\b/g`
static OBJ_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r"(?-u)([0-9]+)[\t\n\x0B\x0C\r \xA0]+([0-9]+)[\t\n\x0B\x0C\r \xA0]+obj\b").expect("the obj pattern")
});
/// `/trailer\s*<</g`
static TRAILER_RE: LazyLock<BytesRegex> =
    LazyLock::new(|| BytesRegex::new(r"(?-u)trailer[\t\n\x0B\x0C\r \xA0]*<<").expect("the trailer pattern"));
/// `/beginbfchar([\s\S]*?)endbfchar/g`
static BFCHAR_RE: LazyLock<BytesRegex> =
    LazyLock::new(|| BytesRegex::new(r"(?s-u)beginbfchar(.*?)endbfchar").expect("the bfchar pattern"));
/// `/beginbfrange([\s\S]*?)endbfrange/g`
static BFRANGE_RE: LazyLock<BytesRegex> =
    LazyLock::new(|| BytesRegex::new(r"(?s-u)beginbfrange(.*?)endbfrange").expect("the bfrange pattern"));
/// `/<([0-9a-fA-F\s]*)>/g`
static HEX_RE: LazyLock<BytesRegex> =
    LazyLock::new(|| BytesRegex::new(r"(?-u)<([0-9a-fA-F\t\n\x0B\x0C\r \xA0]*)>").expect("the hex pattern"));
/// `/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F\s]*)>|\[([^\]]*)\])/g`
static RANGE_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r"(?-u)<([0-9a-fA-F]+)>[\t\n\x0B\x0C\r \xA0]*<([0-9a-fA-F]+)>[\t\n\x0B\x0C\r \xA0]*(?:<([0-9a-fA-F\t\n\x0B\x0C\r \xA0]*)>|\[([^\]]*)\])",
    )
    .expect("the range pattern")
});

/// One object: its value, and for a stream where its bytes are.
#[derive(Debug)]
struct Entry {
    value: V,
    stream: Option<(usize, usize)>,
}

/// How a font's bytes become text.
#[derive(Debug)]
struct Font {
    two_byte: bool,
    map: Option<CMap>,
    /// WinAnsi with a font's Differences; `None` for WinAnsi itself.
    enc: Option<Vec<Vec<u16>>>,
}

const DEFAULT_FONT: Font = Font {
    two_byte: false,
    map: None,
    enc: None,
};

/// A ToUnicode CMap: its bfchar and bfrange entries.
#[derive(Debug, Default)]
struct CMap {
    chars: HashMap<u32, Vec<u16>>,
    ranges: Vec<(f64, f64, Vec<u16>)>,
}

/// The objects of one PDF, and what was worked out while reading its pages.
struct PdfDoc<'b> {
    buf: &'b [u8],
    /// Object number (its bits) -> index in `entries`; a later object of the same number replaces the earlier one
    /// in its place, as a JS `Map` did.
    index: HashMap<u64, usize>,
    entries: Vec<(f64, Entry)>,
    /// The classic trailers and cross-reference streams: where each is, and its dictionary.
    trailers: Vec<(usize, V)>,
    decoded: Cell<usize>,
    fonts: RefCell<HashMap<u64, Rc<Font>>>,
    forms: RefCell<HashSet<usize>>,
    root: Option<V>,
    encrypted: bool,
}

/// `String.prototype.slice(0, end)`'s end for a text of `len` characters.
fn js_slice_end(len: usize, end: f64) -> usize {
    let end = if end.is_nan() { 0.0 } else { end.trunc() };
    if end < 0.0 {
        (len as f64 + end).max(0.0) as usize
    } else {
        end.min(len as f64) as usize
    }
}

impl<'b> PdfDoc<'b> {
    fn new(buf: &'b [u8]) -> Result<Self, ReadError> {
        let mut doc = PdfDoc {
            buf,
            index: HashMap::new(),
            entries: Vec::new(),
            trailers: Vec::new(),
            decoded: Cell::new(0),
            fonts: RefCell::new(HashMap::new()),
            forms: RefCell::new(HashSet::new()),
            root: None,
            encrypted: false,
        };
        doc.scan()?;
        let mut latest: Vec<&(usize, V)> = doc.trailers.iter().collect();
        latest.sort_by_key(|(pos, _)| *pos);
        let mut root = None;
        let mut encrypted = false;
        for (_, dict) in latest {
            if truthy(prop(Some(dict), "Root")) {
                root = prop(Some(dict), "Root").cloned();
            }
            if truthy(prop(Some(dict), "Encrypt")) {
                encrypted = true;
            }
        }
        doc.root = root;
        doc.encrypted = encrypted;
        Ok(doc)
    }

    fn has(&self, num: f64) -> bool {
        self.index.contains_key(&num.to_bits())
    }

    fn set(&mut self, num: f64, entry: Entry) {
        match self.index.get(&num.to_bits()) {
            Some(&at) => self.entries[at].1 = entry,
            None => {
                self.index.insert(num.to_bits(), self.entries.len());
                self.entries.push((num, entry));
            }
        }
    }

    fn object(&self, num: f64) -> Option<usize> {
        self.index.get(&num.to_bits()).copied()
    }

    /// Every "n g obj ... endobj" in the file, in order (a later one replaces an earlier one), then object streams.
    fn scan(&mut self) -> Result<(), ReadError> {
        let s = self.buf;
        let mut last = 0usize;
        while last <= s.len() {
            let Some(caps) = OBJ_RE.captures_at(s, last) else { break };
            let whole = caps.get(0).map_or(0..0, |m| m.range());
            let num: f64 = latin1(caps.get(1).map_or(&[][..], |m| m.as_bytes()))
                .parse()
                .unwrap_or(f64::NAN);
            last = whole.end;
            let Ok((value, i)) = parse_value(s, whole.end, true, 0) else {
                continue;
            };
            let i = skip_ws(s, i);
            let mut entry = Entry { value, stream: None };
            if s.len() >= i && s[i..].starts_with(b"stream") {
                let mut start = i + 6;
                if s.get(start) == Some(&b'\r') {
                    start += 1;
                }
                if s.get(start) == Some(&b'\n') {
                    start += 1;
                }
                let len = match prop(Some(&entry.value), "Length") {
                    Some(V::Num(n)) => *n,
                    _ => -1.0,
                };
                let ends_there = |at: usize| {
                    let window = &s[at.min(s.len())..(at + 24).min(s.len())];
                    let k = window.iter().position(|&b| !js_space_byte(b)).unwrap_or(window.len());
                    window[k..].starts_with(b"endstream")
                };
                let end = if len >= 0.0 && start as f64 + len <= s.len() as f64 && ends_there(start + len as usize) {
                    start + len as usize
                } else {
                    match find(s, b"endstream", start) {
                        None => s.len(),
                        Some(k) => {
                            let mut end = k;
                            if end > 0 && s[end - 1] == b'\n' {
                                end -= 1;
                            }
                            if end > 0 && s[end - 1] == b'\r' {
                                end -= 1;
                            }
                            end
                        }
                    }
                };
                let end = end.max(start);
                entry.stream = Some((start, end));
                last = last.max(end);
            } else {
                last = last.max(i);
            }
            let is_xref = is_name(prop(Some(&entry.value), "Type"), "/XRef");
            let trailer = is_xref.then(|| entry.value.clone());
            self.set(num, entry);
            if let Some(dict) = trailer {
                self.trailers.push((whole.start, dict));
            }
        }
        for m in TRAILER_RE.find_iter(s) {
            if let Ok((dict, _)) = parse_value(s, m.start() + 7, true, 0) {
                self.trailers.push((m.start(), dict));
            }
        }
        let streams: Vec<usize> = (0..self.entries.len())
            .filter(|&at| {
                let entry = &self.entries[at].1;
                is_name(prop(Some(&entry.value), "Type"), "/ObjStm") && entry.stream.is_some()
            })
            .collect();
        for at in streams {
            self.unpack(at)?;
        }
        Ok(())
    }

    /// The objects packed in an object stream (PDF 1.5+). A direct object of the same number wins.
    fn unpack(&mut self, at: usize) -> Result<(), ReadError> {
        let Some(data) = self.stream_bytes(Some(at))? else {
            return Ok(());
        };
        let data = data.into_owned();
        let value = &self.entries[at].1.value;
        let n = v_number(prop(Some(value), "N"));
        let count = (if truthy_num(n) { n } else { 0.0 }).min(1_000_000.0);
        let f = v_number(prop(Some(value), "First"));
        let first = if truthy_num(f) { f } else { 0.0 };
        let header = &data[..js_slice_end(data.len(), first)];
        let mut numbers = header
            .split(|b| !b.is_ascii_digit())
            .filter(|run| !run.is_empty())
            .map(|run| latin1(run).parse::<f64>().unwrap_or(f64::NAN));
        let mut pairs = Vec::new();
        let mut k = 0.0;
        while k < count {
            let (Some(a), Some(b)) = (numbers.next(), numbers.next()) else {
                break;
            };
            pairs.push((a, b));
            k += 1.0;
        }
        for (num, off) in pairs {
            if self.has(num) {
                continue;
            }
            let at = first + off;
            if at < 0.0 || at.fract() != 0.0 || at >= data.len() as f64 {
                // (an index the JS could not read: one broken object)
                continue;
            }
            if let Ok((value, _)) = parse_value(&data, at as usize, true, 0) {
                self.set(num, Entry { value, stream: None });
            }
        }
        Ok(())
    }

    /// A value with references followed.
    fn get<'a>(&'a self, value: Option<&'a V>) -> Option<&'a V> {
        let mut v = value?;
        for _ in 0..32 {
            let V::Ref(n) = v else { break };
            v = &self.entries[self.object(*n)?].1.value;
        }
        match v {
            V::Ref(_) | V::Null => None,
            other => Some(other),
        }
    }

    /// The object a reference points at, or `None`.
    fn entry(&self, value: Option<&V>) -> Option<usize> {
        let mut v = value?;
        let mut e = None;
        for _ in 0..32 {
            let V::Ref(n) = v else { break };
            e = self.object(*n);
            match e {
                Some(at) => v = &self.entries[at].1.value,
                None => break,
            }
        }
        e
    }

    /// A stream's bytes with its filters undone, or `None` when a filter is one with no text behind it (pictures).
    fn stream_bytes(&self, at: Option<usize>) -> Result<Option<Cow<'b, [u8]>>, ReadError> {
        let Some(at) = at else { return Ok(None) };
        let entry = &self.entries[at].1;
        let Some((start, end)) = entry.stream else {
            return Ok(None);
        };
        let buf: &'b [u8] = self.buf;
        let mut data: Option<Cow<'b, [u8]>> = Some(Cow::Borrowed(&buf[start..end]));
        let value = Some(&entry.value);
        let filters = as_array(self.get(prop(value, "Filter")));
        let parms_value = prop(value, "DecodeParms").or_else(|| prop(value, "DP"));
        let parms = as_array(self.get(parms_value));
        for (k, filter) in filters.iter().enumerate() {
            let Some(current) = data.take() else { break };
            data = decode_filter(filter, &current, self.get(parms.get(k).copied()))?.map(Cow::Owned);
        }
        let Some(data) = data else { return Ok(None) };
        self.decoded.set(self.decoded.get() + data.len());
        if self.decoded.get() > MAX_DECODED_BYTES {
            return Err(parse_err("it holds too much to decode"));
        }
        Ok(Some(data))
    }

    /// The pages, in page-tree order, each with the resources it has or inherits.
    fn page_list(&self) -> Vec<(&V, Option<&V>)> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        fn walk<'a>(
            doc: &'a PdfDoc<'_>,
            r: &'a V,
            inherited: Option<&'a V>,
            depth: usize,
            out: &mut Vec<(&'a V, Option<&'a V>)>,
            seen: &mut HashSet<u64>,
        ) {
            if out.len() >= MAX_PAGES || depth > 64 {
                return;
            }
            if let V::Ref(n) = r
                && !seen.insert(n.to_bits())
            {
                return;
            }
            let Some(node) = doc.get(Some(r)) else { return };
            if !matches!(node, V::Dict(_) | V::Str(_) | V::Kw(_)) {
                return;
            }
            let resources = prop(Some(node), "Resources").or(inherited);
            let kids = doc.get(prop(Some(node), "Kids"));
            let kind = prop(Some(node), "Type");
            if is_name(kind, "/Page") || (!is_name(kind, "/Pages") && !matches!(kids, Some(V::Arr(_)))) {
                out.push((node, resources));
                return;
            }
            for kid in as_array(kids) {
                walk(doc, kid, resources, depth + 1, out, seen);
            }
        }
        let catalog = self.get(self.root.as_ref());
        if let Some(pages) = prop(catalog, "Pages")
            && truthy(Some(pages))
        {
            walk(self, pages, None, 0, &mut out, &mut seen);
        }
        if out.is_empty() {
            // No page tree to follow (a damaged file): every page object, by number.
            let mut numbered: Vec<&(f64, Entry)> = self.entries.iter().collect();
            numbered.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            for (_, entry) in numbered {
                let v = &entry.value;
                if is_name(prop(Some(v), "Type"), "/Page") && out.len() < MAX_PAGES {
                    out.push((v, prop(Some(v), "Resources")));
                }
            }
        }
        out
    }

    fn page_text(&self, node: &V, resources: Option<&V>) -> Result<Vec<u16>, ReadError> {
        let contents = prop(Some(node), "Contents");
        let first = self.entry(contents);
        let refs: Vec<&V> = if first.is_some_and(|at| self.entries[at].1.stream.is_some()) {
            contents.into_iter().collect()
        } else {
            as_array(self.get(contents))
        };
        let mut data = Vec::new();
        for (k, r) in refs.iter().enumerate() {
            if k > 0 {
                data.push(b'\n');
            }
            if let Some(bytes) = self.stream_bytes(self.entry(Some(r)))? {
                data.extend_from_slice(&bytes);
            }
        }
        self.run(&data, self.get(resources), 0)
    }

    /// The text a content stream draws, in drawing order, with line breaks where the text moves to another line.
    fn run(&self, s: &[u8], resources: Option<&V>, depth: usize) -> Result<Vec<u16>, ReadError> {
        let mut out = TextOut::default();
        let mut stack: Vec<V> = Vec::new();
        let mut font: Rc<Font> = Rc::new(DEFAULT_FONT);
        let mut size = 12.0f64;
        let mut tm = [1.0f64, 0.0, 0.0, 1.0, 0.0, 0.0];
        let mut leading = 0.0f64;
        let num = |v: Option<&V>| match v {
            Some(V::Num(n)) => *n,
            _ => 0.0,
        };
        let move_to = |tm: &mut [f64; 6], out: &mut TextOut, size: f64, e: f64, f: f64| {
            tm[4] = e;
            tm[5] = f;
            let scale = if truthy_num(tm[3]) { tm[3] } else { 1.0 };
            out.at(f, js_max(1.0, (size * scale).abs() * 0.5));
        };
        let do_move = |tm: &mut [f64; 6], out: &mut TextOut, size: f64, tx: f64, ty: f64| {
            let e = tm[4] + tx * tm[0] + ty * tm[2];
            let f = tm[5] + tx * tm[1] + ty * tm[3];
            move_to(tm, out, size, e, f);
        };
        let mut i = 0;
        while i < s.len() {
            i = skip_ws(s, i);
            if i >= s.len() {
                break;
            }
            let (v, next) = match parse_value(s, i, false, 0) {
                Ok(parsed) => parsed,
                Err(_) => {
                    i += 1;
                    continue;
                }
            };
            i = next;
            let V::Kw(w) = v else {
                stack.push(v);
                if stack.len() > 32 {
                    stack.remove(0);
                }
                continue;
            };
            match w.as_str() {
                "BT" => tm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                "Tf" => {
                    font = self.font(resources, stack.first())?;
                    let n = num(stack.get(1));
                    if truthy_num(n) {
                        size = n;
                    }
                }
                "TL" => leading = num(stack.first()),
                "Td" => do_move(&mut tm, &mut out, size, num(stack.first()), num(stack.get(1))),
                "TD" => {
                    leading = -num(stack.get(1));
                    do_move(&mut tm, &mut out, size, num(stack.first()), num(stack.get(1)));
                }
                "Tm" if stack.len() >= 6 => {
                    let last6 = &stack[stack.len() - 6..];
                    for (k, v) in last6.iter().enumerate() {
                        tm[k] = num(Some(v));
                    }
                    let (e, f) = (tm[4], tm[5]);
                    move_to(&mut tm, &mut out, size, e, f);
                }
                "T*" => do_move(&mut tm, &mut out, size, 0.0, -leading),
                "Tj" => show(&mut out, &font, stack.first()),
                "'" => {
                    do_move(&mut tm, &mut out, size, 0.0, -leading);
                    show(&mut out, &font, stack.first());
                }
                "\"" => {
                    do_move(&mut tm, &mut out, size, 0.0, -leading);
                    show(&mut out, &font, stack.get(2));
                }
                "TJ" => {
                    for el in as_array(stack.first()) {
                        match el {
                            V::Str(b) => out.put(&decode_text(&font, b)),
                            V::Num(n) if *n < TJ_SPACE => out.space(),
                            _ => {}
                        }
                    }
                }
                "Do" => {
                    let text = self.form(resources, stack.first(), depth)?;
                    out.block(&text);
                }
                "ID" => {
                    // An inline picture's bytes, up to "EI": nothing to read in them.
                    i = find_inline_end(s, i).map_or(s.len(), |at| at + 3);
                }
                _ => {}
            }
            stack.clear();
        }
        Ok(out.s)
    }

    /// The text a form XObject draws (a page can draw the same form more than once; one can't draw itself).
    fn form(&self, resources: Option<&V>, name: Option<&V>, depth: usize) -> Result<Vec<u16>, ReadError> {
        let Some(V::Name(name)) = name else {
            return Ok(vec![]);
        };
        if depth >= 6 {
            return Ok(vec![]);
        }
        let xobjects = self.get(prop(resources, "XObject"));
        let r = prop(xobjects, &name[1..]);
        let Some(at) = self.entry(r) else {
            return Ok(vec![]);
        };
        let value = &self.entries[at].1.value;
        if !is_name(prop(Some(value), "Subtype"), "/Form") || self.forms.borrow().contains(&at) {
            return Ok(vec![]);
        }
        let Some(data) = self.stream_bytes(Some(at))? else {
            return Ok(vec![]);
        };
        self.forms.borrow_mut().insert(at);
        let own = self.get(prop(Some(value), "Resources"));
        let result = self.run(&data, own.or(resources), depth + 1);
        self.forms.borrow_mut().remove(&at);
        result
    }

    /// How a font's bytes become text: its ToUnicode map, else its encoding (WinAnsi with any Differences).
    fn font(&self, resources: Option<&V>, name: Option<&V>) -> Result<Rc<Font>, ReadError> {
        let fonts = self.get(prop(resources, "Font"));
        let r = match name {
            Some(V::Name(name)) if truthy(fonts) => prop(fonts, &name[1..]),
            _ => None,
        };
        let key = match r {
            Some(V::Ref(n)) => Some(n.to_bits()),
            _ => None,
        };
        if let Some(key) = key
            && let Some(found) = self.fonts.borrow().get(&key)
        {
            return Ok(found.clone());
        }
        let dict = self.get(r);
        let mut f = Font {
            two_byte: false,
            map: None,
            enc: None,
        };
        if let Some(dict @ V::Dict(_)) = dict {
            if is_name(prop(Some(dict), "Subtype"), "/Type0") {
                f.two_byte = true;
            }
            let tu = self.entry(prop(Some(dict), "ToUnicode"));
            if tu.is_some()
                && let Some(data) = self.stream_bytes(tu)?
            {
                f.map = Some(parse_cmap(&data));
            }
            let encoding = self.get(prop(Some(dict), "Encoding"));
            let differences = match encoding {
                Some(V::Dict(_) | V::Arr(_) | V::Str(_) | V::Kw(_)) => self.get(prop(encoding, "Differences")),
                _ => None,
            };
            if !f.two_byte
                && let Some(V::Arr(differences)) = differences
            {
                let mut enc: Vec<Vec<u16>> = WIN_ANSI.iter().map(|&u| vec![u]).collect();
                let mut code = 0.0f64;
                for d in differences {
                    match d {
                        V::Num(n) => code = *n,
                        V::Name(glyph) => {
                            let u = glyph_text(&glyph[1..]);
                            if let Some(u) = u
                                && (0.0..256.0).contains(&code)
                                && code.fract() == 0.0
                            {
                                enc[code as usize] = u;
                            }
                            code += 1.0;
                        }
                        _ => {}
                    }
                }
                f.enc = Some(enc);
            }
        }
        let f = Rc::new(f);
        if let Some(key) = key {
            self.fonts.borrow_mut().insert(key, f.clone());
        }
        Ok(f)
    }
}

fn find(s: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > s.len() {
        return None;
    }
    s[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// `/\sEI(?=\s|$)/g` from `from`: where the white space before "EI" is.
fn find_inline_end(s: &[u8], from: usize) -> Option<usize> {
    let mut p = from;
    while p + 3 <= s.len() {
        if js_space_byte(s[p]) && &s[p + 1..p + 3] == b"EI" && (p + 3 == s.len() || js_space_byte(s[p + 3])) {
            return Some(p);
        }
        p += 1;
    }
    None
}

fn show(out: &mut TextOut, font: &Font, v: Option<&V>) {
    if let Some(V::Str(b)) = v {
        out.put(&decode_text(font, b));
    }
}

/// The page's text as it is drawn: a line break when the text moves to another line, a space when it moves along.
/// Kept as UTF-16 units, as the JS string was, so a character split across two pieces still comes together.
#[derive(Default)]
struct TextOut {
    s: Vec<u16>,
    pending: Option<u16>,
    last_y: Option<f64>,
}

const NL: u16 = b'\n' as u16;
const SP: u16 = b' ' as u16;

impl TextOut {
    fn at(&mut self, y: f64, tolerance: f64) {
        if let Some(last_y) = self.last_y {
            if (y - last_y).abs() > tolerance {
                self.pending = Some(NL);
            } else if self.pending != Some(NL) {
                self.pending = Some(SP);
            }
        }
        self.last_y = Some(y);
    }

    fn space(&mut self) {
        if self.pending != Some(NL) {
            self.pending = Some(SP);
        }
    }

    fn put(&mut self, t: &[u16]) {
        if t.is_empty() {
            return;
        }
        if let Some(pending) = self.pending
            && !self.s.is_empty()
        {
            if pending == NL {
                self.s.push(NL);
            } else if !self.s.last().is_some_and(|&u| js_space_unit(u)) && !js_space_unit(t[0]) {
                self.s.push(SP);
            }
        }
        self.pending = None;
        self.s.extend_from_slice(t);
    }

    fn block(&mut self, t: &[u16]) {
        if t.iter().all(|&u| js_space_unit(u)) {
            return;
        }
        self.pending = Some(NL);
        self.put(t);
        self.pending = Some(NL);
    }
}

fn decode_text(font: &Font, b: &[u8]) -> Vec<u16> {
    let mut out = Vec::new();
    if font.two_byte {
        let mut k = 0;
        while k + 1 < b.len() {
            let code = (u32::from(b[k]) << 8) | u32::from(b[k + 1]);
            if let Some(map) = &font.map
                && let Some(u) = cmap_lookup(map, code)
            {
                out.extend(u);
            }
            k += 2;
        }
        return out;
    }
    for &byte in b {
        let code = u32::from(byte);
        if let Some(map) = &font.map
            && let Some(u) = cmap_lookup(map, code)
        {
            out.extend(u);
            continue;
        }
        match &font.enc {
            Some(enc) => out.extend_from_slice(&enc[byte as usize]),
            None => out.push(WIN_ANSI[byte as usize]),
        }
    }
    out
}

/// `parseInt(hex, 16)` as a whole number, `None` for an empty text.
fn hex_value(hex: &[u8]) -> Option<f64> {
    if hex.is_empty() {
        return None;
    }
    Some(hex.iter().fold(0.0, |acc, &b| {
        acc * 16.0 + f64::from(char::from(b).to_digit(16).unwrap_or(0))
    }))
}

fn without_space(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().copied().filter(|&b| !js_space_byte(b)).collect()
}

/// The `<...>` hex strings in a text, white space taken out.
fn hexes(text: &[u8]) -> Vec<Vec<u8>> {
    HEX_RE
        .captures_iter(text)
        .map(|c| without_space(c.get(1).map_or(&[][..], |m| m.as_bytes())))
        .collect()
}

/// A ToUnicode CMap: its bfchar and bfrange entries.
fn parse_cmap(t: &[u8]) -> CMap {
    let mut map = CMap::default();
    let set_char = |map: &mut CMap, code: Option<f64>, value: Vec<u16>| {
        if let Some(code) = code
            && code <= f64::from(u32::MAX)
        {
            map.chars.insert(code as u32, value);
        }
    };
    for block in BFCHAR_RE.captures_iter(t) {
        let h = hexes(block.get(1).map_or(&[][..], |m| m.as_bytes()));
        let mut k = 0;
        while k + 1 < h.len() {
            set_char(&mut map, hex_value(&h[k]), units16(&h[k + 1]));
            k += 2;
        }
    }
    for block in BFRANGE_RE.captures_iter(t) {
        let body = block.get(1).map_or(&[][..], |m| m.as_bytes());
        for m in RANGE_RE.captures_iter(body) {
            let lo = hex_value(m.get(1).map_or(&[][..], |x| x.as_bytes())).unwrap_or(f64::NAN);
            let hi = hex_value(m.get(2).map_or(&[][..], |x| x.as_bytes())).unwrap_or(f64::NAN);
            if !matches!(
                hi.partial_cmp(&lo),
                Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
            ) {
                continue;
            }
            if let Some(units) = m.get(3) {
                map.ranges.push((lo, hi, units16(&without_space(units.as_bytes()))));
            } else {
                let list = hexes(m.get(4).map_or(&[][..], |x| x.as_bytes()));
                let mut k = 0usize;
                while k < list.len() && lo + k as f64 <= hi {
                    set_char(&mut map, Some(lo + k as f64), units16(&list[k]));
                    k += 1;
                }
            }
        }
    }
    map
}

fn cmap_lookup(map: &CMap, code: u32) -> Option<Vec<u16>> {
    if let Some(c) = map.chars.get(&code) {
        return Some(c.clone());
    }
    for (lo, hi, units) in &map.ranges {
        let code_f = f64::from(code);
        if code_f >= *lo && code_f <= *hi && !units.is_empty() {
            let mut u = units.clone();
            let last = u.len() - 1;
            let step = (code_f - lo) as u64;
            u[last] = ((u64::from(u[last]) + step) & 0xffff) as u16;
            return Some(u);
        }
    }
    None
}

/// The UTF-16 units a CMap's hex destination stands for: one byte, or four hex digits each.
fn units16(hex: &[u8]) -> Vec<u16> {
    if hex.len() <= 2 {
        return hex_value(hex).map(|v| vec![v as u16]).into_iter().flatten().collect();
    }
    hex.chunks_exact(4)
        .map(|c| hex_value(c).map_or(0, |v| v as u16))
        .collect()
}

fn decode_filter(name: &V, data: &[u8], parms: Option<&V>) -> Result<Option<Vec<u8>>, ReadError> {
    let V::Name(name) = name else { return Ok(None) };
    match name.as_str() {
        "/FlateDecode" | "/Fl" => match inflate(data) {
            Some(inflated) => predict(inflated, parms).map(Some),
            None => Ok(None),
        },
        "/ASCIIHexDecode" | "/AHx" => Ok(Some(ascii_hex(data))),
        "/ASCII85Decode" | "/A85" => Ok(Some(ascii85(data))),
        // pictures (DCT, JPX, CCITT, JBIG2), LZW, encryption: no text read from these
        _ => Ok(None),
    }
}

/// zlib's inflate, as Node's `inflateSync` ran it: `zlib_header` false is raw deflate; `to_the_end` true wants the
/// whole stream (a cut-off one fails), false keeps what could be read. Output over 64 MB fails.
fn inflate_with(data: &[u8], zlib_header: bool, to_the_end: bool) -> Option<Vec<u8>> {
    use flate2::{Decompress, FlushDecompress, Status};
    let mut d = Decompress::new(zlib_header);
    let mut out: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let before_in = d.total_in();
        let before_out = d.total_out();
        let input = &data[(before_in as usize).min(data.len())..];
        let status = d.decompress(input, &mut chunk, FlushDecompress::None).ok()?;
        let produced = (d.total_out() - before_out) as usize;
        out.extend_from_slice(&chunk[..produced]);
        if out.len() > MAX_STREAM_BYTES {
            return None;
        }
        if status == Status::StreamEnd {
            return Some(out);
        }
        let consumed = d.total_in() - before_in;
        if consumed == 0 && produced == 0 {
            // Nothing more can be read: the input ran out before the stream's end.
            return if to_the_end { None } else { Some(out) };
        }
    }
}

fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    // damaged or cut off: what can be read of it; then raw deflate
    inflate_with(data, true, true)
        .or_else(|| inflate_with(data, true, false))
        .or_else(|| inflate_with(data, false, false))
}

/// PNG predictors (Predictor 10-15) under Flate, as object streams sometimes use them.
fn predict(data: Vec<u8>, parms: Option<&V>) -> Result<Vec<u8>, ReadError> {
    let p = v_number(prop(parms, "Predictor"));
    let p = if truthy_num(p) { p } else { 1.0 };
    if p < 10.0 {
        return Ok(data);
    }
    let or = |n: f64, default: f64| if truthy_num(n) { n } else { default };
    let colors = or(v_number(prop(parms, "Colors")), 1.0);
    let bpc = or(v_number(prop(parms, "BitsPerComponent")), 8.0);
    let cols = or(v_number(prop(parms, "Columns")), 1.0);
    let bpp = js_max(1.0, (colors * bpc / 8.0).ceil());
    let row_len = (colors * bpc * cols / 8.0).ceil();
    if row_len < 0.0 || !row_len.is_finite() {
        // `Buffer.alloc` of a negative or endless size threw.
        return Err(ReadError(format!(
            "The value of \"size\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
            number_to_string(row_len)
        )));
    }
    let row_len = row_len as usize;
    let bpp = if bpp.is_finite() { bpp as usize } else { usize::MAX };
    let rows = data.len() / (row_len + 1);
    let mut out = vec![0u8; rows * row_len];
    let mut prev = vec![0u8; row_len];
    for r in 0..rows {
        let kind = data[r * (row_len + 1)];
        let mut row = data[r * (row_len + 1) + 1..(r + 1) * (row_len + 1)].to_vec();
        for x in 0..row_len {
            let a = if x >= bpp { i32::from(row[x - bpp]) } else { 0 };
            let b = i32::from(prev[x]);
            let c = if x >= bpp { i32::from(prev[x - bpp]) } else { 0 };
            let add = match kind {
                1 => a,
                2 => b,
                3 => (a + b) >> 1,
                4 => {
                    let pp = a + b - c;
                    let (pa, pb, pc) = ((pp - a).abs(), (pp - b).abs(), (pp - c).abs());
                    if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    }
                }
                _ => 0,
            };
            row[x] = ((i32::from(row[x]) + add) & 0xff) as u8;
        }
        out[r * row_len..(r + 1) * row_len].copy_from_slice(&row);
        prev = row;
    }
    Ok(out)
}

fn ascii_hex(data: &[u8]) -> Vec<u8> {
    let end = data.iter().position(|&b| b == b'>').unwrap_or(data.len());
    let mut h: Vec<u8> = data[..end].iter().copied().filter(u8::is_ascii_hexdigit).collect();
    if h.len() % 2 == 1 {
        h.push(b'0');
    }
    hex::decode(&h).unwrap_or_default()
}

fn ascii85(data: &[u8]) -> Vec<u8> {
    let mut t: Vec<u8> = data.iter().copied().filter(|&b| !js_space_byte(b)).collect();
    if t.starts_with(b"<~") {
        t.drain(..2);
    }
    if let Some(end) = find(&t, b"~>", 0) {
        t.truncate(end);
    }
    let z_count = t.iter().filter(|&&b| b == b'z').count();
    let mut out = vec![0u8; (t.len() * 4).div_ceil(5) + 4 * z_count];
    let mut o = 0usize;
    let mut group: Vec<u64> = Vec::with_capacity(5);
    let flush = |group: &[u64], n: usize, out: &mut Vec<u8>, o: &mut usize| {
        let v = group.iter().fold(0u64, |v, &g| v * 85 + g) as u32;
        let bytes = v.to_be_bytes();
        for &byte in bytes.iter().take(n) {
            if *o < out.len() {
                out[*o] = byte;
            }
            *o += 1;
        }
    };
    for &ch in &t {
        if ch == b'z' && group.is_empty() {
            o += 4;
            continue;
        }
        let c = i32::from(ch) - 33;
        if !(0..=84).contains(&c) {
            continue;
        }
        group.push(c as u64);
        if group.len() == 5 {
            flush(&group, 4, &mut out, &mut o);
            group.clear();
        }
    }
    if group.len() > 1 {
        let n = group.len() - 1;
        while group.len() < 5 {
            group.push(84);
        }
        flush(&group, n, &mut out, &mut o);
    }
    out.truncate(o.min(out.len()));
    out
}

/// WinAnsiEncoding: Latin-1 with Windows' characters in 0x80-0x9F. Most simple fonts read right with it.
static WIN_ANSI: LazyLock<[u16; 256]> = LazyLock::new(|| {
    const WIN_ANSI_80: [u16; 32] = [
        0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
        0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
        0x0153, 0x009d, 0x017e, 0x0178,
    ];
    let mut table = [0u16; 256];
    for (c, slot) in table.iter_mut().enumerate() {
        *slot = if (0x80..0xa0).contains(&c) {
            WIN_ANSI_80[c - 0x80]
        } else {
            c as u16
        };
    }
    table
});

/// Glyph names a font's Differences use, as text.
const GLYPHS: &[(&str, &str)] = &[
    ("space", " "),
    ("exclam", "!"),
    ("quotedbl", "\""),
    ("numbersign", "#"),
    ("dollar", "$"),
    ("percent", "%"),
    ("ampersand", "&"),
    ("quotesingle", "'"),
    ("quoteright", "’"),
    ("quoteleft", "‘"),
    ("parenleft", "("),
    ("parenright", ")"),
    ("asterisk", "*"),
    ("plus", "+"),
    ("comma", ","),
    ("hyphen", "-"),
    ("minus", "−"),
    ("period", "."),
    ("slash", "/"),
    ("colon", ":"),
    ("semicolon", ";"),
    ("less", "<"),
    ("equal", "="),
    ("greater", ">"),
    ("question", "?"),
    ("at", "@"),
    ("bracketleft", "["),
    ("backslash", "\\"),
    ("bracketright", "]"),
    ("asciicircum", "^"),
    ("underscore", "_"),
    ("grave", "`"),
    ("braceleft", "{"),
    ("bar", "|"),
    ("braceright", "}"),
    ("asciitilde", "~"),
    ("endash", "–"),
    ("emdash", "—"),
    ("bullet", "•"),
    ("ellipsis", "…"),
    ("quotedblleft", "“"),
    ("quotedblright", "”"),
    ("quotesinglbase", "‚"),
    ("quotedblbase", "„"),
    ("dagger", "†"),
    ("daggerdbl", "‡"),
    ("degree", "°"),
    ("copyright", "©"),
    ("registered", "®"),
    ("trademark", "™"),
    ("section", "§"),
    ("paragraph", "¶"),
    ("periodcentered", "·"),
    ("fi", "fi"),
    ("fl", "fl"),
    ("ff", "ff"),
    ("ffi", "ffi"),
    ("ffl", "ffl"),
    ("germandbls", "ß"),
    ("ae", "æ"),
    ("AE", "Æ"),
    ("oe", "œ"),
    ("OE", "Œ"),
    ("oslash", "ø"),
    ("Oslash", "Ø"),
    ("euro", "€"),
    ("sterling", "£"),
    ("yen", "¥"),
    ("cent", "¢"),
    ("nbspace", "\u{A0}"),
    ("sfthyphen", ""),
    ("zero", "0"),
    ("one", "1"),
    ("two", "2"),
    ("three", "3"),
    ("four", "4"),
    ("five", "5"),
    ("six", "6"),
    ("seven", "7"),
    ("eight", "8"),
    ("nine", "9"),
];

/// The combining accents of `glyphText`, and for each the letters that compose with it into one character
/// (what `.normalize("NFC")` gives; a letter not listed stays as the letter and the combining accent).
type Composed = &'static [(u8, u16)];
const ACCENTS: &[(&str, u16, Composed)] = &[
    (
        "acute",
        0x0301,
        &[
            (b'A', 0xC1),
            (b'C', 0x106),
            (b'E', 0xC9),
            (b'G', 0x1F4),
            (b'I', 0xCD),
            (b'K', 0x1E30),
            (b'L', 0x139),
            (b'M', 0x1E3E),
            (b'N', 0x143),
            (b'O', 0xD3),
            (b'P', 0x1E54),
            (b'R', 0x154),
            (b'S', 0x15A),
            (b'U', 0xDA),
            (b'W', 0x1E82),
            (b'Y', 0xDD),
            (b'Z', 0x179),
            (b'a', 0xE1),
            (b'c', 0x107),
            (b'e', 0xE9),
            (b'g', 0x1F5),
            (b'i', 0xED),
            (b'k', 0x1E31),
            (b'l', 0x13A),
            (b'm', 0x1E3F),
            (b'n', 0x144),
            (b'o', 0xF3),
            (b'p', 0x1E55),
            (b'r', 0x155),
            (b's', 0x15B),
            (b'u', 0xFA),
            (b'w', 0x1E83),
            (b'y', 0xFD),
            (b'z', 0x17A),
        ],
    ),
    (
        "grave",
        0x0300,
        &[
            (b'A', 0xC0),
            (b'E', 0xC8),
            (b'I', 0xCC),
            (b'N', 0x1F8),
            (b'O', 0xD2),
            (b'U', 0xD9),
            (b'W', 0x1E80),
            (b'Y', 0x1EF2),
            (b'a', 0xE0),
            (b'e', 0xE8),
            (b'i', 0xEC),
            (b'n', 0x1F9),
            (b'o', 0xF2),
            (b'u', 0xF9),
            (b'w', 0x1E81),
            (b'y', 0x1EF3),
        ],
    ),
    (
        "circumflex",
        0x0302,
        &[
            (b'A', 0xC2),
            (b'C', 0x108),
            (b'E', 0xCA),
            (b'G', 0x11C),
            (b'H', 0x124),
            (b'I', 0xCE),
            (b'J', 0x134),
            (b'O', 0xD4),
            (b'S', 0x15C),
            (b'U', 0xDB),
            (b'W', 0x174),
            (b'Y', 0x176),
            (b'Z', 0x1E90),
            (b'a', 0xE2),
            (b'c', 0x109),
            (b'e', 0xEA),
            (b'g', 0x11D),
            (b'h', 0x125),
            (b'i', 0xEE),
            (b'j', 0x135),
            (b'o', 0xF4),
            (b's', 0x15D),
            (b'u', 0xFB),
            (b'w', 0x175),
            (b'y', 0x177),
            (b'z', 0x1E91),
        ],
    ),
    (
        "tilde",
        0x0303,
        &[
            (b'A', 0xC3),
            (b'E', 0x1EBC),
            (b'I', 0x128),
            (b'N', 0xD1),
            (b'O', 0xD5),
            (b'U', 0x168),
            (b'V', 0x1E7C),
            (b'Y', 0x1EF8),
            (b'a', 0xE3),
            (b'e', 0x1EBD),
            (b'i', 0x129),
            (b'n', 0xF1),
            (b'o', 0xF5),
            (b'u', 0x169),
            (b'v', 0x1E7D),
            (b'y', 0x1EF9),
        ],
    ),
    (
        "dieresis",
        0x0308,
        &[
            (b'A', 0xC4),
            (b'E', 0xCB),
            (b'H', 0x1E26),
            (b'I', 0xCF),
            (b'O', 0xD6),
            (b'U', 0xDC),
            (b'W', 0x1E84),
            (b'X', 0x1E8C),
            (b'Y', 0x178),
            (b'a', 0xE4),
            (b'e', 0xEB),
            (b'h', 0x1E27),
            (b'i', 0xEF),
            (b'o', 0xF6),
            (b't', 0x1E97),
            (b'u', 0xFC),
            (b'w', 0x1E85),
            (b'x', 0x1E8D),
            (b'y', 0xFF),
        ],
    ),
    (
        "ring",
        0x030A,
        &[
            (b'A', 0xC5),
            (b'U', 0x16E),
            (b'a', 0xE5),
            (b'u', 0x16F),
            (b'w', 0x1E98),
            (b'y', 0x1E99),
        ],
    ),
    (
        "cedilla",
        0x0327,
        &[
            (b'C', 0xC7),
            (b'D', 0x1E10),
            (b'E', 0x228),
            (b'G', 0x122),
            (b'H', 0x1E28),
            (b'K', 0x136),
            (b'L', 0x13B),
            (b'N', 0x145),
            (b'R', 0x156),
            (b'S', 0x15E),
            (b'T', 0x162),
            (b'c', 0xE7),
            (b'd', 0x1E11),
            (b'e', 0x229),
            (b'g', 0x123),
            (b'h', 0x1E29),
            (b'k', 0x137),
            (b'l', 0x13C),
            (b'n', 0x146),
            (b'r', 0x157),
            (b's', 0x15F),
            (b't', 0x163),
        ],
    ),
    (
        "caron",
        0x030C,
        &[
            (b'A', 0x1CD),
            (b'C', 0x10C),
            (b'D', 0x10E),
            (b'E', 0x11A),
            (b'G', 0x1E6),
            (b'H', 0x21E),
            (b'I', 0x1CF),
            (b'K', 0x1E8),
            (b'L', 0x13D),
            (b'N', 0x147),
            (b'O', 0x1D1),
            (b'R', 0x158),
            (b'S', 0x160),
            (b'T', 0x164),
            (b'U', 0x1D3),
            (b'Z', 0x17D),
            (b'a', 0x1CE),
            (b'c', 0x10D),
            (b'd', 0x10F),
            (b'e', 0x11B),
            (b'g', 0x1E7),
            (b'h', 0x21F),
            (b'i', 0x1D0),
            (b'j', 0x1F0),
            (b'k', 0x1E9),
            (b'l', 0x13E),
            (b'n', 0x148),
            (b'o', 0x1D2),
            (b'r', 0x159),
            (b's', 0x161),
            (b't', 0x165),
            (b'u', 0x1D4),
            (b'z', 0x17E),
        ],
    ),
];

/// A glyph name's text (as UTF-16 units), or `None` for a name it doesn't know.
fn glyph_text(name: &str) -> Option<Vec<u16>> {
    if let Some((_, text)) = GLYPHS.iter().find(|(n, _)| *n == name) {
        return Some(text.encode_utf16().collect());
    }
    let bytes = name.as_bytes();
    if bytes.len() == 1 && bytes[0].is_ascii_alphabetic() {
        return Some(vec![u16::from(bytes[0])]);
    }
    // `/^uni([0-9A-Fa-f]{4})+$/`
    if let Some(hex) = name.strip_prefix("uni")
        && !hex.is_empty()
        && hex.len() % 4 == 0
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Some(
            hex.as_bytes()
                .chunks(4)
                .map(|c| u16::from_str_radix(&latin1(c), 16).unwrap_or(0))
                .collect(),
        );
    }
    // `/^u([0-9A-Fa-f]{4,6})$/`
    if let Some(hex) = name.strip_prefix('u')
        && (4..=6).contains(&hex.len())
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        let cp = u32::from_str_radix(hex, 16).unwrap_or(u32::MAX);
        if cp > 0x10ffff {
            return None;
        }
        return Some(if cp < 0x10000 {
            vec![cp as u16]
        } else {
            let v = cp - 0x10000;
            vec![0xD800 + (v >> 10) as u16, 0xDC00 + (v & 0x3ff) as u16]
        });
    }
    // `/^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|ring|cedilla|caron)$/`
    if bytes.len() > 1 && bytes[0].is_ascii_alphabetic() {
        let letter = bytes[0];
        if let Some((_, mark, composed)) = ACCENTS.iter().find(|(accent, _, _)| &name[1..] == *accent) {
            return Some(match composed.iter().find(|(l, _)| *l == letter) {
                Some((_, one)) => vec![*one],
                None => vec![u16::from(letter), *mark],
            });
        }
    }
    None
}

/// The text of a PDF without pdftotext: `{ pages }` (one string per page, "" for a page without text) or
/// `{ pages: [], error }`. Never fails.
pub fn builtin_pdf_text(buffer: &[u8]) -> BuiltinText {
    if !is_pdf(buffer) {
        return BuiltinText {
            pages: vec![],
            error: Some("this isn't a PDF".into()),
        };
    }
    let doc = match PdfDoc::new(buffer) {
        Ok(doc) => doc,
        Err(ReadError(message)) => {
            return BuiltinText {
                pages: vec![],
                error: Some(format!("it could not be read ({message})")),
            };
        }
    };
    if doc.encrypted {
        return BuiltinText {
            pages: vec![],
            error: Some(
                "it is locked with a password (encrypted); pdftotext (poppler-utils) can open many of these".into(),
            ),
        };
    }
    let pages = doc.page_list();
    if pages.is_empty() {
        return BuiltinText {
            pages: vec![],
            error: Some("no pages were found in it".into()),
        };
    }
    BuiltinText {
        pages: pages
            .into_iter()
            .map(|(node, resources)| match doc.page_text(node, resources) {
                Ok(units) => tidy(&String::from_utf16_lossy(&units)),
                Err(_) => String::new(),
            })
            .collect(),
        error: None,
    }
}
