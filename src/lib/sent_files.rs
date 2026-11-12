//! Port of `src/lib/sent-files.js`: the copies of a chat's files, and handing them back to the page to look at.
//! Ported from TarseeMacOS.
//!
//! Kept: whatever the agent sends to a chat (the send_file tool, and the files it emails), as sent-<time>-<name> in
//! the workspace's uploads folder, and every file uploaded in the dashboard's chat, as chat-<time>-<n>-<name>, kept
//! with the chat (lib/chat_files.rs) and told to the pages showing it on the live timeline ("files" events). Why a
//! copy: the agent's files can be anywhere on the disk, where the page is not allowed to look. A hard link where
//! the disk allows (no second copy, and it outlives the original being tidied away), a plain copy otherwise. Copies
//! older than 30 days are cleared out as new ones arrive.
//!
//! Shown: GET /api/chat/file?p=<path> only serves files inside that uploads folder (the real path is checked, so
//! links and ".." get nowhere). Uploads come from anyone who can message the agent, so nothing is ever served as a
//! web page: pictures, PDFs, sound and video go out as what they are, everything else as plain text or as a
//! download, and all of it with a policy that stops scripts.
//!
//! The JS functions took their folder and clock as optional arguments (`{ dir = uploadsDir(), now = Date.now() }`);
//! here they are plain arguments: pass `uploads_dir(app.config())` and `now_ms()` for the defaults.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use axum::body::Body;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_ENCODING, CONTENT_LANGUAGE, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_SECURITY_POLICY, CONTENT_TYPE, ETAG, HeaderName, IF_MATCH, IF_MODIFIED_SINCE, IF_NONE_MATCH,
    IF_RANGE, IF_UNMODIFIED_SINCE, LAST_MODIFIED, RANGE, X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::app::App;
use crate::config::Config;
use crate::lib::chat_files::{
    Direction, FileView, KeptFile, RecordOptions, latest_user_message_id, message_has_files, record_chat_files,
};
use crate::lib::live_bus::{LiveEvent, active_turn_for, publish};
use crate::lib::tool_steps::js_trim;
use crate::util::js::{ms_from_iso, now_ms, utf16_tail, utf16_truncate};

const KEEP_DAYS: i64 = 30;

/// The workspace's uploads folder: the only place the page may open a file from.
pub fn uploads_dir(config: &Config) -> PathBuf {
    config.workspace_dir.join("uploads")
}

/// `[^\w.\- ()]`: what a kept file's name may not hold.
fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ' ' | '(' | ')')
}

/// A file's name with nothing in it that could reach out of a folder or break a header.
pub fn safe_file_name(name: &str) -> String {
    let last = name.rsplit(['\\', '/']).next().unwrap_or_default();
    // Each run of other characters becomes one "_".
    let mut clean = String::with_capacity(last.len());
    let mut in_run = false;
    for c in last.chars() {
        if is_name_char(c) {
            clean.push(c);
            in_run = false;
        } else if !in_run {
            clean.push('_');
            in_run = true;
        }
    }
    let base = js_trim(clean.trim_start_matches('.'));
    utf16_tail(if base.is_empty() { "file" } else { base }, 120)
}

static KEPT_STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:chat|sent)-([0-9]{13})-").expect("the kept file pattern"));

/// Clear out the kept copies over 30 days old. Their age is the time in their name: a kept copy of something the
/// agent sent can be a hard link to a file written long before, so its own date says nothing.
pub fn tidy_kept_files(dir: &Path, now: i64) {
    // (cleaning up is best-effort: it stops at the first thing that fails)
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return;
        };
        let name = entry.file_name();
        let stamp = KEPT_STAMP
            .captures(&name.to_string_lossy())
            .and_then(|found| found[1].parse::<i64>().ok())
            .unwrap_or(0);
        if stamp == 0 {
            continue;
        }
        if now - stamp > KEEP_DAYS * 86_400_000 {
            match fs::remove_file(entry.path()) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return,
            }
        }
    }
}

/// A file the dashboard's chat sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedFile {
    pub name: String,
    pub buffer: Vec<u8>,
}

/// Save files the dashboard's chat sent into the uploads folder `dir`, as chat-<now>-<n>-<name>.
pub fn keep_uploaded_files(files: &[UploadedFile], dir: &Path, now: i64) -> io::Result<Vec<KeptFile>> {
    if files.is_empty() {
        return Ok(Vec::new());
    }
    fs::create_dir_all(dir)?;
    tidy_kept_files(dir, now);
    files
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let name = safe_file_name(&f.name);
            let path = dir.join(format!("chat-{now}-{i}-{name}"));
            fs::write(&path, &f.buffer)?;
            Ok(KeptFile {
                name,
                size: f.buffer.len() as u64,
                path,
            })
        })
        .collect()
}

/// `fs.realpathSync(p)`: the path with every link followed. On Windows the answer is an ordinary path
/// (`C:\...`), not the `\\?\C:\...` form `canonicalize` gives: the path is stored, shown and compared as text.
pub(crate) fn real_path(p: &Path) -> io::Result<PathBuf> {
    let real = fs::canonicalize(p)?;
    #[cfg(windows)]
    {
        let text = real.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(plain) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(plain.to_string()));
        }
    }
    Ok(real)
}

/// `real.startsWith(root + path.sep)`: inside the folder, and not the folder itself.
fn is_inside(real: &Path, root: &Path) -> bool {
    real != root && real.starts_with(root)
}

/// Keep something the agent sent so the page can show it. A file already in the uploads folder `dir` is used as
/// it is.
pub fn keep_sent_file(abs_path: &Path, dir: &Path, now: i64) -> io::Result<KeptFile> {
    fs::create_dir_all(dir)?;
    let real = real_path(abs_path)?;
    let size = fs::metadata(&real)?.len();
    if is_inside(&real, &real_path(dir)?) {
        return Ok(KeptFile {
            name: shown_name(&real.to_string_lossy()),
            size,
            path: real,
        });
    }
    tidy_kept_files(dir, now);
    let name = safe_file_name(&basename(&real.to_string_lossy()));
    let mut file = dir.join(format!("sent-{now}-{name}"));
    let mut n = 1;
    // two in the same millisecond
    while file.exists() {
        file = dir.join(format!("sent-{}-{name}", now + n));
        n += 1;
    }
    if fs::hard_link(&real, &file).is_err() {
        fs::copy(&real, &file)?;
    }
    Ok(KeptFile { name, size, path: file })
}

/// `path.basename(p)`: what follows the last separator (either slash on Windows), trailing separators aside.
fn basename(p: &str) -> String {
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let trimmed = p.trim_end_matches(is_sep);
    let name = trimmed.rsplit(is_sep).next().unwrap_or_default();
    // (On Windows a drive letter is no part of a name: "C:notes.txt" is "notes.txt".)
    if cfg!(windows) && name.len() >= 2 && name.as_bytes()[1] == b':' && name.as_bytes()[0].is_ascii_alphabetic() {
        return name[2..].to_string();
    }
    name.to_string()
}

static KEPT_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(chat|sent|discord|telegram|whatsapp|slack|email)-[0-9]+-([0-9]+-)?")
        .expect("the kept prefix pattern")
});

/// A file's name as the bots and the chat keep it on disk, without the time and number they put in front.
pub fn shown_name(p: &str) -> String {
    let name = basename(p);
    let shown = KEPT_PREFIX.replace(&name, "");
    if shown.is_empty() {
        "file".to_string()
    } else {
        shown.into_owned()
    }
}

/// A file as a "files" event names it: the kept row's id when it was recorded.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotedFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub name: String,
    pub size: i64,
    pub path: String,
}

/// What [`note_sent_file`] takes.
#[derive(Debug, Clone, Copy)]
pub struct SentFile<'a> {
    pub abs_path: &'a Path,
    /// What the agent said with it ("" for nothing).
    pub caption: &'a str,
    pub conversation_id: Option<&'a str>,
    /// Where it went (discord, telegram, email, web; "" when that is not known).
    pub via: &'a str,
}

/// What [`note_sent_file`] returns.
#[derive(Debug, Clone, PartialEq)]
pub struct NotedSentFile {
    pub conversation_id: String,
    pub file: NotedFile,
    /// The "files" event, when the live timeline took it.
    pub event: Option<LiveEvent>,
}

/// The agent sent a file to a chat: keep a copy, keep it with that chat's conversation (lib/chat_files.rs), and
/// tell the pages showing that chat on the live timeline. When a turn is at work in that chat (the one sending it,
/// as a rule) the file is that turn's: it shows on the turn's reply, and the event carries the turn's id.
/// Best-effort on purpose: it runs after the file has gone, and nothing here may turn a good send into an error.
/// `None` when it could not be kept.
pub fn note_sent_file(app: &App, sent: SentFile<'_>) -> Option<NotedSentFile> {
    let conversation_id = sent.conversation_id.filter(|conv| !conv.is_empty())?;
    if sent.abs_path.as_os_str().is_empty() {
        return None;
    }
    let kept = match keep_sent_file(sent.abs_path, &uploads_dir(app.config()), now_ms()) {
        Ok(kept) => kept,
        Err(err) => {
            log::warn!("[chat-files] a file the agent sent could not be kept for the dashboard: {err}");
            return None;
        }
    };
    let turn_id = active_turn_for(app, conversation_id)
        .and_then(|turn| turn.turn_id)
        .filter(|turn| !turn.is_empty());
    let text = utf16_truncate(sent.caption, 500);
    let rows = record_chat_files(
        app,
        conversation_id,
        std::slice::from_ref(&kept),
        &RecordOptions {
            direction: Direction::Out,
            turn_id: turn_id.clone(),
            caption: text.clone(),
            via: sent.via.to_string(),
            ..RecordOptions::default()
        },
    );
    let file = match rows.first() {
        Some(row) => NotedFile {
            id: Some(row.id),
            name: row.name.clone(),
            size: row.size,
            path: row.path.clone(),
        },
        None => NotedFile {
            id: None,
            name: kept.name.clone(),
            size: i64::try_from(kept.size).unwrap_or(i64::MAX),
            path: kept.path.to_string_lossy().into_owned(),
        },
    };
    let event = publish(
        app,
        conversation_id,
        "files",
        json!({ "from": "agent", "caption": text, "files": [file] }),
        turn_id.as_deref(),
    );
    Some(NotedSentFile {
        conversation_id: conversation_id.to_string(),
        file,
        event,
    })
}

/// What [`note_received_files`] takes.
#[derive(Debug, Clone, Default)]
pub struct ReceivedFiles<'a> {
    pub conversation_id: &'a str,
    pub message_id: Option<&'a str>,
    pub files: &'a [KeptFile],
    pub via: &'a str,
}

/// Files someone sent in with a message, kept as copies in the uploads folder: kept with the conversation on that
/// message, and told to the pages showing it ("files" with from "in" and the message's id). Returns the kept rows.
/// Best-effort, as [`note_sent_file`].
pub fn note_received_files(app: &App, received: ReceivedFiles<'_>) -> Vec<FileView> {
    if received.conversation_id.is_empty() || received.files.is_empty() {
        return Vec::new();
    }
    let message_id = received.message_id.filter(|id| !id.is_empty());
    let rows = record_chat_files(
        app,
        received.conversation_id,
        received.files,
        &RecordOptions {
            direction: Direction::In,
            message_id: message_id.map(String::from),
            via: received.via.to_string(),
            ..RecordOptions::default()
        },
    );
    if !rows.is_empty() {
        let files: Vec<NotedFile> = rows
            .iter()
            .map(|r| NotedFile {
                id: Some(r.id),
                name: r.name.clone(),
                size: r.size,
                path: r.path.clone(),
            })
            .collect();
        publish(
            app,
            received.conversation_id,
            "files",
            json!({ "from": "in", "messageId": message_id, "files": files }),
            None,
        );
    }
    rows
}

fn picture_ext(media_type: &str) -> &'static str {
    match media_type.to_lowercase().as_str() {
        "image/png" => ".png",
        "image/jpeg" | "image/jpg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/heic" => ".heic",
        _ => ".png",
    }
}

/// `Buffer.from(text, "base64")`: either alphabet, whitespace and anything else that is not base64 passed over,
/// the end at the first "=".
pub(crate) fn decode_base64_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut bits: u32 = 0;
    let mut count = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            bits = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => {}
    }
    out
}

/// The options of [`note_media_blocks`].
#[derive(Debug, Clone, Default)]
pub struct MediaBlockOptions<'a> {
    /// The message the turn answers, which the channel saved (default: the latest one a person sent).
    pub message_id: Option<&'a str>,
    pub via: &'a str,
    /// Where the copies go (default: the workspace's uploads folder).
    pub dir: Option<&'a Path>,
    /// The time in their names (default: now).
    pub now: Option<i64>,
}

/// [providers/claude_code.rs] The pictures a message handed the agent as bytes (a photo sent on Telegram, Discord
/// or WhatsApp): a copy each in the uploads folder, kept with the person's message they came with (`message_id`:
/// the message the turn answers, which the channel saved; else the latest one in the conversation), since no note
/// in that message names them. PDFs always come with a note, so they are left to it. Skipped when that message
/// has files on record already (the dashboard's own upload kept them first).
/// `blocks`: the turn's media blocks (`{ type: "image", source: { media_type, data } }`). Returns the kept rows.
pub fn note_media_blocks(
    app: &App,
    conversation_id: &str,
    blocks: &[Value],
    opts: MediaBlockOptions<'_>,
) -> Vec<FileView> {
    let data_of = |b: &Value| -> Option<String> {
        if b.get("type").and_then(Value::as_str) != Some("image") {
            return None;
        }
        let data = b.get("source")?.get("data")?.as_str()?;
        (!data.is_empty()).then(|| data.to_string())
    };
    let pictures: Vec<(&Value, String)> = blocks.iter().filter_map(|b| Some((b, data_of(b)?))).collect();
    if conversation_id.is_empty() || pictures.is_empty() {
        return Vec::new();
    }
    let given = opts.message_id.filter(|id| !id.is_empty()).map(String::from);
    let Some(message_id) = given.or_else(|| latest_user_message_id(app, conversation_id)) else {
        return Vec::new();
    };
    if message_has_files(app, &message_id) {
        return Vec::new();
    }
    let default_dir = uploads_dir(app.config());
    let dir = opts.dir.unwrap_or(&default_dir);
    let now = opts.now.unwrap_or_else(now_ms);
    if fs::create_dir_all(dir).is_err() {
        return Vec::new();
    }
    tidy_kept_files(dir, now);
    let mut files = Vec::new();
    for (i, (block, data)) in pictures.iter().enumerate() {
        let number = if pictures.len() > 1 {
            format!("-{}", i + 1)
        } else {
            String::new()
        };
        let media_type = block
            .get("source")
            .and_then(|s| s.get("media_type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name = format!("image{number}{}", picture_ext(media_type));
        let path = dir.join(format!("chat-{now}-{i}-{name}"));
        let buffer = decode_base64_lenient(data);
        if fs::write(&path, &buffer).is_err() {
            return Vec::new();
        }
        files.push(KeptFile {
            name,
            size: buffer.len() as u64,
            path,
        });
    }
    note_received_files(
        app,
        ReceivedFiles {
            conversation_id,
            message_id: Some(&message_id),
            files: &files,
            via: opts.via,
        },
    )
}

/// `path.resolve(p)`: the path made absolute against the working folder, its "." and ".." taken out as text
/// (before any link is followed).
fn resolve(p: &Path) -> io::Result<PathBuf> {
    let absolute = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()?.join(p)
    };
    let mut out = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// The real path of a file the page may look at, or `None`: it must exist and sit inside the uploads folder `dir`.
pub fn viewable_path(p: &str, dir: &Path) -> Option<PathBuf> {
    if p.is_empty() || p.contains('\0') {
        return None;
    }
    let root = real_path(dir).ok()?;
    let real = real_path(&resolve(Path::new(p)).ok()?).ok()?;
    if !is_inside(&real, &root) || !fs::metadata(&real).ok()?.is_file() {
        return None;
    }
    Some(real)
}

/// How a file is sent to the browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ViewKind {
    /// Its Content-Type.
    pub r#type: &'static str,
    /// Offered to save, not shown.
    pub download: bool,
}

/// Kinds a browser can show without running anything. SVG and HTML are not here on purpose.
fn inline_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".heic" => "image/heic",
        ".bmp" => "image/bmp",
        ".avif" => "image/avif",
        ".pdf" => "application/pdf",
        ".mp4" | ".m4v" => "video/mp4",
        ".mov" => "video/quicktime",
        ".webm" => "video/webm",
        ".ogv" => "video/ogg",
        ".mkv" => "video/x-matroska",
        ".3gp" => "video/3gpp",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".aac" => "audio/aac",
        ".wav" => "audio/wav",
        ".ogg" | ".oga" | ".opus" => "audio/ogg",
        ".flac" => "audio/flac",
        _ => return None,
    })
}

const TEXT: &[&str] = &[
    ".txt",
    ".md",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".log",
    ".yml",
    ".yaml",
    ".xml",
    ".html",
    ".htm",
    ".svg",
    ".css",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".py",
    ".sh",
    ".sql",
    ".ini",
    ".toml",
    ".env",
    ".srt",
    ".vtt",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".h",
    ".cpp",
    ".php",
    ".markdown",
    ".zsh",
    ".conf",
    ".kt",
    ".swift",
    ".lua",
    ".diff",
    ".patch",
    ".tex",
];

/// `path.extname(file).toLowerCase()`: from the last dot of the name on ("" for none, and for a name that only
/// starts with one).
fn extname(file: &str) -> String {
    let name = basename(file);
    match name.rfind('.') {
        Some(at) if at > 0 => name[at..].to_lowercase(),
        _ => String::new(),
    }
}

/// How a file is sent to the browser: its type, and whether it is offered to save instead of shown.
pub fn view_kind(file: &str) -> ViewKind {
    let ext = extname(file);
    if let Some(kind) = inline_type(&ext) {
        return ViewKind {
            r#type: kind,
            download: false,
        };
    }
    if TEXT.contains(&ext.as_str()) {
        // web pages and scripts too: shown as text, never run
        return ViewKind {
            r#type: "text/plain; charset=utf-8",
            download: false,
        };
    }
    ViewKind {
        r#type: "application/octet-stream",
        download: true,
    }
}

/// A file's name for its Content-Disposition: what the bots and the chat put in front taken off, nothing that could
/// break the header.
pub fn disposition_name(file: &str) -> String {
    let name: String = shown_name(file)
        .chars()
        .map(|c| if is_name_char(c) { c } else { '_' })
        .collect();
    if name.is_empty() { "file".to_string() } else { name }
}

/// The options of [`send_viewable`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOptions {
    /// Offered to save (attachment), not shown.
    pub save: bool,
    /// The Cache-Control header.
    pub cache: String,
}

impl Default for SendOptions {
    fn default() -> Self {
        SendOptions {
            save: false,
            cache: "private, max-age=3600".to_string(),
        }
    }
}

const SANDBOX: &str = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'";

/// Send a file to look at in the page (inline, as what it is) or, with `save`, to keep (attachment). Range requests
/// are answered (a video seeks, a sound's waveform and a text's start are fetched without the rest). Nothing in it
/// may run: every kind but a PDF goes out under a sandbox policy (a PDF needs the browser's own viewer, which a
/// sandbox blocks; the viewer draws PDFs itself with pdf.js from the bytes).
///
/// The JS handed the file to Express's `res.sendFile` (the `send` package). What that did is done here by hand,
/// with the same answers: `Accept-Ranges`, `Last-Modified` and a weak `ETag` of the file's size and time; 304 for a
/// conditional request that is still fresh; 206 with `Content-Range` for one satisfiable range (several ranges, or
/// a range that is out of date by `If-Range`, get the whole file); and, as the JS callback had it, 404 with no body
/// for anything that goes wrong (a file that has gone, a range that cannot be satisfied, a failed precondition).
///
/// `method` and `request` are the request's method and headers.
pub async fn send_viewable(method: &Method, request: &HeaderMap, file: &Path, opts: &SendOptions) -> Response {
    let shown = file.to_string_lossy();
    let kind = view_kind(&shown);
    let mut headers = HeaderMap::new();
    fn set(headers: &mut HeaderMap, name: HeaderName, value: &str) {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(name, value);
        }
    }
    set(&mut headers, CONTENT_TYPE, kind.r#type);
    set(&mut headers, X_CONTENT_TYPE_OPTIONS, "nosniff");
    let disposition = if kind.download || opts.save {
        "attachment"
    } else {
        "inline"
    };
    set(
        &mut headers,
        CONTENT_DISPOSITION,
        &format!("{disposition}; filename=\"{}\"", disposition_name(&shown)),
    );
    set(&mut headers, CACHE_CONTROL, &opts.cache);
    if kind.r#type != "application/pdf" {
        set(&mut headers, CONTENT_SECURITY_POLICY, SANDBOX);
    }

    let not_found = |headers: HeaderMap| respond(StatusCode::NOT_FOUND, headers, Body::empty());
    let stat = match tokio::fs::metadata(file).await {
        Ok(stat) if stat.is_file() => stat,
        _ => return not_found(headers),
    };
    let size = stat.len();
    let modified_ms = stat
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        // (a JS Date holds whole milliseconds, rounded from the file's time)
        .map_or(0, |since| ((since.as_nanos() + 500_000) / 1_000_000) as i64);
    let last_modified = DateTime::<Utc>::from_timestamp_millis(modified_ms)
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let etag = format!("W/\"{size:x}-{modified_ms:x}\"");
    set(&mut headers, ACCEPT_RANGES, "bytes");
    set(&mut headers, LAST_MODIFIED, &last_modified);
    set(&mut headers, ETAG, &etag);

    let asked = |name: HeaderName| {
        request
            .get(name)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
    };

    // conditional GET support
    let conditional = [IF_MATCH, IF_UNMODIFIED_SINCE, IF_NONE_MATCH, IF_MODIFIED_SINCE]
        .into_iter()
        .any(|name| asked(name).is_some());
    if conditional {
        if is_precondition_failure(asked(IF_MATCH), asked(IF_UNMODIFIED_SINCE), &etag, &last_modified) {
            return not_found(headers);
        }
        if is_fresh(
            asked(IF_MODIFIED_SINCE),
            asked(IF_NONE_MATCH),
            asked(CACHE_CONTROL),
            &etag,
            &last_modified,
        ) {
            for name in [
                CONTENT_ENCODING,
                CONTENT_LANGUAGE,
                CONTENT_LENGTH,
                CONTENT_RANGE,
                CONTENT_TYPE,
            ] {
                headers.remove(name);
            }
            return respond(StatusCode::NOT_MODIFIED, headers, Body::empty());
        }
    }

    // Range support
    let mut status = StatusCode::OK;
    let mut offset = 0u64;
    let mut len = size;
    if let Some(range) = asked(RANGE).filter(|range| range.trim_start_matches(' ').starts_with("bytes=")) {
        let ranges = if is_range_fresh(asked(IF_RANGE), &etag, &last_modified) {
            parse_range(size, range)
        } else {
            Ranges::Ignored
        };
        match ranges {
            Ranges::Unsatisfiable => {
                set(&mut headers, CONTENT_RANGE, &format!("bytes */{size}"));
                return not_found(headers);
            }
            // (syntactically invalid/multiple ranges are treated as a regular response)
            Ranges::Satisfiable(ranges) if ranges.len() == 1 => {
                let (start, end) = ranges[0];
                status = StatusCode::PARTIAL_CONTENT;
                set(&mut headers, CONTENT_RANGE, &format!("bytes {start}-{end}/{size}"));
                offset = start;
                len = end - start + 1;
            }
            _ => {}
        }
    }
    set(&mut headers, CONTENT_LENGTH, &len.to_string());

    // HEAD support
    if method == Method::HEAD {
        return respond(status, headers, Body::empty());
    }
    let mut source = match tokio::fs::File::open(file).await {
        Ok(source) => source,
        Err(_) => {
            headers.remove(CONTENT_LENGTH);
            return not_found(headers);
        }
    };
    if offset > 0 && source.seek(io::SeekFrom::Start(offset)).await.is_err() {
        headers.remove(CONTENT_LENGTH);
        return not_found(headers);
    }
    respond(status, headers, Body::from_stream(ReaderStream::new(source.take(len))))
}

fn respond(status: StatusCode, headers: HeaderMap, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

/// `Date.parse(text)` for an HTTP date ("Tue, 27 Oct 2026 01:56:34 GMT").
fn parse_http_date(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc2822(text.trim())
        .map(|date| date.timestamp_millis())
        .ok()
        .or_else(|| ms_from_iso(text))
}

/// A header's comma-separated values, the spaces around each taken off.
fn token_list(text: &str) -> impl Iterator<Item = &str> {
    text.split(',').map(|token| token.trim_matches(' '))
}

fn etag_matches(token: &str, etag: &str) -> bool {
    token == etag || token == format!("W/{etag}") || format!("W/{token}") == etag
}

/// The request's preconditions failed (`If-Match`, `If-Unmodified-Since`).
fn is_precondition_failure(
    if_match: Option<&str>,
    if_unmodified_since: Option<&str>,
    etag: &str,
    last_modified: &str,
) -> bool {
    if let Some(wanted) = if_match {
        return wanted != "*"
            && token_list(wanted)
                .filter(|token| !token.is_empty())
                .all(|token| !etag_matches(token, etag));
    }
    if let Some(since) = if_unmodified_since.and_then(parse_http_date) {
        return parse_http_date(last_modified).is_none_or(|modified| modified > since);
    }
    false
}

/// The copy the browser has is still good (`If-None-Match`, `If-Modified-Since`).
fn is_fresh(
    if_modified_since: Option<&str>,
    if_none_match: Option<&str>,
    cache_control: Option<&str>,
    etag: &str,
    last_modified: &str,
) -> bool {
    // unconditional request
    if if_modified_since.is_none() && if_none_match.is_none() {
        return false;
    }
    // Always return stale when Cache-Control: no-cache to support end-to-end reload requests
    if cache_control.is_some_and(|value| token_list(value).any(|token| token.trim() == "no-cache")) {
        return false;
    }
    // if-none-match takes precedent over if-modified-since
    if let Some(wanted) = if_none_match {
        return wanted == "*" || token_list(wanted).any(|token| etag_matches(token, etag));
    }
    if let Some(since) = if_modified_since {
        return match (parse_http_date(last_modified), parse_http_date(since)) {
            (Some(modified), Some(since)) => modified <= since,
            _ => false,
        };
    }
    true
}

/// The range is asked of the version the browser has (`If-Range`).
fn is_range_fresh(if_range: Option<&str>, etag: &str, last_modified: &str) -> bool {
    let Some(if_range) = if_range else {
        return true;
    };
    // if-range as etag
    if if_range.contains('"') {
        return if_range.contains(etag);
    }
    // if-range as modified date
    match (parse_http_date(last_modified), parse_http_date(if_range)) {
        (Some(modified), Some(wanted)) => modified <= wanted,
        _ => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Ranges {
    /// Not a range header that can be read: answered with the whole file.
    Ignored,
    Unsatisfiable,
    /// (first byte, last byte) of each range, overlapping and adjacent ones combined.
    Satisfiable(Vec<(u64, u64)>),
}

/// `parseInt(text, 10)`.
fn parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (sign, digits) = match text.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, text.strip_prefix('+').unwrap_or(text)),
    };
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    digits[..end].parse::<i64>().ok().map(|n| sign * n)
}

/// The `range-parser` package, with `combine: true`.
fn parse_range(size: u64, header: &str) -> Ranges {
    let Some(at) = header.find('=') else {
        return Ranges::Ignored;
    };
    let size = i64::try_from(size).unwrap_or(i64::MAX);
    let mut ranges: Vec<(i64, i64)> = Vec::new();
    for part in header[at + 1..].split(',') {
        let mut ends = part.split('-');
        let start = ends.next().and_then(parse_int);
        let end = ends.next().and_then(parse_int);
        let (start, mut end) = match (start, end) {
            // -nnn
            (None, Some(end)) => (size - end, size - 1),
            // nnn-
            (Some(start), None) => (start, size - 1),
            (Some(start), Some(end)) => (start, end),
            (None, None) => continue,
        };
        // limit last-byte-pos to current length
        if end > size - 1 {
            end = size - 1;
        }
        // invalid or unsatisifiable
        if start > end || start < 0 {
            continue;
        }
        ranges.push((start, end));
    }
    if ranges.is_empty() {
        return Ranges::Unsatisfiable;
    }
    // Combine overlapping & adjacent ranges, each kept at the place of the first of its parts.
    let mut ordered: Vec<(usize, i64, i64)> = ranges
        .iter()
        .enumerate()
        .map(|(index, (start, end))| (index, *start, *end))
        .collect();
    ordered.sort_by_key(|(_, start, _)| *start);
    let mut combined: Vec<(usize, i64, i64)> = Vec::new();
    for (index, start, end) in ordered {
        match combined.last_mut() {
            Some(current) if start <= current.2 + 1 => {
                if end > current.2 {
                    current.2 = end;
                    current.0 = current.0.min(index);
                }
            }
            _ => combined.push((index, start, end)),
        }
    }
    combined.sort_by_key(|(index, _, _)| *index);
    Ranges::Satisfiable(
        combined
            .into_iter()
            .map(|(_, start, end)| (start as u64, end as u64))
            .collect(),
    )
}

#[cfg(test)]
mod tests;
