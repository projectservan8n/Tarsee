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
//!
//! **Names from outside.** A file's name comes from whoever sent it, and the path of a file the agent sends comes
//! from the model. Two rules keep both where they belong:
//! - A kept copy's name is made by [`safe_file_name`] and always has `chat-<time>-<n>-` or `sent-<time>-` in front
//!   of it, so it is one plain name inside the uploads folder whatever was sent: never a path, never `..`, never a
//!   Windows device (`nul`).
//! - Every file call here hands Windows the path in the form it takes literally (`util::node_path::to_namespaced`),
//!   as Node did. So a name means what it says: `a.` is a file called `a.` (not `a`), `...` is not the folder
//!   itself, `nul` is not the null device, and the file that is checked is the file that is opened.
//!
//! **Blocking.** The JS used the synchronous file calls, and so do the functions that carry the JS names. Called
//! from async code they hold a thread of the runtime for as long as the disk takes, which for an upload of any
//! size, a copy of a file of any size, or an uploads folder of any length is not bounded. Async code calls the
//! `_async` twin instead (`keep_uploaded_files_async`, `keep_sent_file_async`, `tidy_kept_files_async`,
//! `note_sent_file_async`, `note_media_blocks_async`): the same work on the blocking pool, which also finishes
//! whether or not the caller is still there, as the JS call did.

use std::fs;
use std::io;
use std::path::{Component, MAIN_SEPARATOR, Path, PathBuf};
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
use crate::util::js::{ms_from_iso, now_ms, trim, trim_start, utf16_tail, utf16_truncate};
use crate::util::node_path::{self, to_namespaced};

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
    let base = trim(clean.trim_start_matches('.'));
    utf16_tail(if base.is_empty() { "file" } else { base }, 120)
}

/// Where a kept copy goes: `<dir>/<front><name>`, with `front` the `chat-<time>-<n>-` or `sent-<time>-` every kept
/// copy has. `name` comes from [`safe_file_name`], so it is one plain name; should it ever not be (a separator, a
/// drive's colon), it is "file" rather than a path that leaves `dir`.
fn kept_path(dir: &Path, front: &str, name: &str) -> PathBuf {
    let plain = !name.is_empty() && !name.contains(['/', '\\', ':', '\0']);
    node_path::join(dir, format!("{front}{}", if plain { name } else { "file" }))
}

static KEPT_STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:chat|sent)-([0-9]{13})-").expect("the kept file pattern"));

/// Clear out the kept copies over 30 days old. Their age is the time in their name: a kept copy of something the
/// agent sent can be a hard link to a file written long before, so its own date says nothing.
pub fn tidy_kept_files(dir: &Path, now: i64) {
    // (cleaning up is best-effort: it stops at the first thing that fails)
    // The folder is read by its literal path, so each entry's path is literal too: `sent-<time>-a.` is removed, not
    // the `sent-<time>-a` Windows would otherwise make of it.
    let Ok(entries) = fs::read_dir(to_namespaced(dir)) else {
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
    fs::create_dir_all(to_namespaced(dir))?;
    tidy_kept_files(dir, now);
    files
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let name = safe_file_name(&f.name);
            let path = kept_path(dir, &format!("chat-{now}-{i}-"), &name);
            fs::write(to_namespaced(&path), &f.buffer)?;
            Ok(KeptFile {
                name,
                size: f.buffer.len() as u64,
                path,
            })
        })
        .collect()
}

/// A link's target as Node's `readlink` gives it: without the `\\?\` (or `\??\`) Windows may put in front.
fn plain_target(target: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = target.to_string_lossy();
        for front in [r"\\?\UNC\", r"\??\UNC\"] {
            if let Some(rest) = text.strip_prefix(front) {
                return PathBuf::from(format!(r"\\{rest}"));
            }
        }
        for front in [r"\\?\", r"\??\"] {
            if let Some(rest) = text.strip_prefix(front) {
                return PathBuf::from(rest.to_string());
            }
        }
    }
    target
}

/// `fs.realpathSync(p)`, as Node's own (written in JavaScript) works it out: the path made absolute and tidied as
/// text, then walked name by name, each link replaced by what it points at. Every name must be there.
///
/// A name that is not a link stays **as it was written**. That is the difference from `fs::canonicalize`, which
/// asks the system for the one true spelling: on Windows that also answers for a name in another case, a short
/// name (`CHAT-1~1.TXT`), a trailing dot or space, a `\\?\` in front. Node refused some of those and kept the
/// others as written, and so does this: each name is looked up literally (`to_namespaced`), and the answer is
/// stored, shown and compared as text.
pub(crate) fn real_path(p: &Path) -> io::Result<PathBuf> {
    let mut path = resolve(p)?;
    // (Node follows links for as long as there are any, and a ring of them ends in the system's own error at the
    // `metadata` below. The count is only so that nothing here can go round for ever.)
    for _ in 0..256 {
        let mut current = PathBuf::new();
        let mut parts = path.components();
        let mut after_link = None;
        while let Some(part) = parts.next() {
            let Component::Normal(name) = part else {
                // (The root: a drive, a share, "/".)
                current.push(part.as_os_str());
                continue;
            };
            let base = current.join(name);
            let literal = to_namespaced(&base);
            if !fs::symlink_metadata(&literal)?.file_type().is_symlink() {
                current = base;
                continue;
            }
            // What it points at has to be there.
            fs::metadata(&literal)?;
            let target = plain_target(fs::read_link(&literal)?);
            // `path.resolve(previous, linkTarget)` (a target that is absolute stands alone), then what was left.
            let mut next = current.join(target);
            for rest in parts.by_ref() {
                next.push(rest.as_os_str());
            }
            after_link = Some(node_path::normalize(&next));
            break;
        }
        match after_link {
            Some(next) => path = next,
            None => {
                // (A path that is only a root: Node checks that it is there.)
                fs::symlink_metadata(to_namespaced(&current))?;
                return Ok(current);
            }
        }
    }
    Err(io::Error::other("too many links"))
}

/// `real.startsWith(root + path.sep)`: inside the folder, and not the folder itself. Compared as text, as the JS
/// compared them: another spelling of the folder (another case, a `\\?\` in front) is not the folder.
fn is_inside(real: &Path, root: &Path) -> bool {
    let (real, root) = (real.to_string_lossy(), root.to_string_lossy());
    real.strip_prefix(root.as_ref())
        .is_some_and(|rest| rest.starts_with(MAIN_SEPARATOR))
}

/// Keep something the agent sent so the page can show it. A file already in the uploads folder `dir` is used as
/// it is.
pub fn keep_sent_file(abs_path: &Path, dir: &Path, now: i64) -> io::Result<KeptFile> {
    fs::create_dir_all(to_namespaced(dir))?;
    let real = real_path(abs_path)?;
    let size = fs::metadata(to_namespaced(&real))?.len();
    if is_inside(&real, &real_path(dir)?) {
        return Ok(KeptFile {
            name: shown_name(&real.to_string_lossy()),
            size,
            path: real,
        });
    }
    tidy_kept_files(dir, now);
    let name = safe_file_name(&basename(&real.to_string_lossy()));
    let mut file = kept_path(dir, &format!("sent-{now}-"), &name);
    let mut n = 1;
    // two in the same millisecond
    while to_namespaced(&file).exists() {
        file = kept_path(dir, &format!("sent-{}-", now + n), &name);
        n += 1;
    }
    if fs::hard_link(to_namespaced(&real), to_namespaced(&file)).is_err() {
        fs::copy(to_namespaced(&real), to_namespaced(&file))?;
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
    if fs::create_dir_all(to_namespaced(dir)).is_err() {
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
        let path = kept_path(dir, &format!("chat-{now}-{i}-"), &name);
        let buffer = decode_base64_lenient(data);
        if fs::write(to_namespaced(&path), &buffer).is_err() {
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

/// Runs blocking file work on tokio's blocking pool and waits for it. The work goes on to its end even if the
/// caller stops waiting (its request was dropped), as the JS call it stands for did.
async fn off_the_runtime<R: Send + 'static>(work: impl FnOnce() -> R + Send + 'static) -> Result<R, io::Error> {
    tokio::task::spawn_blocking(work).await.map_err(io::Error::other)
}

/// [`tidy_kept_files`] for async code: the uploads folder can be of any length.
pub async fn tidy_kept_files_async(dir: &Path, now: i64) {
    let dir = dir.to_path_buf();
    let _ = off_the_runtime(move || tidy_kept_files(&dir, now)).await;
}

/// [`keep_uploaded_files`] for async code: an upload can be of any size.
pub async fn keep_uploaded_files_async(files: Vec<UploadedFile>, dir: &Path, now: i64) -> io::Result<Vec<KeptFile>> {
    let dir = dir.to_path_buf();
    off_the_runtime(move || keep_uploaded_files(&files, &dir, now)).await?
}

/// [`keep_sent_file`] for async code: where a hard link cannot be made, the file (of any size) is copied.
pub async fn keep_sent_file_async(abs_path: &Path, dir: &Path, now: i64) -> io::Result<KeptFile> {
    let (abs_path, dir) = (abs_path.to_path_buf(), dir.to_path_buf());
    off_the_runtime(move || keep_sent_file(&abs_path, &dir, now)).await?
}

/// [`note_sent_file`] for async code (a tool's `send_file`): the copy, the row and the "files" event, off the
/// runtime's threads. `None` when it could not be kept.
pub async fn note_sent_file_async(app: &App, sent: SentFile<'_>) -> Option<NotedSentFile> {
    let app = app.clone();
    let abs_path = sent.abs_path.to_path_buf();
    let (caption, via) = (sent.caption.to_string(), sent.via.to_string());
    let conversation_id = sent.conversation_id.map(String::from);
    let noted = off_the_runtime(move || {
        note_sent_file(
            &app,
            SentFile {
                abs_path: &abs_path,
                caption: &caption,
                conversation_id: conversation_id.as_deref(),
                via: &via,
            },
        )
    });
    match noted.await {
        Ok(noted) => noted,
        Err(err) => {
            log::warn!("[chat-files] a file the agent sent could not be kept for the dashboard: {err}");
            None
        }
    }
}

/// [`note_media_blocks`] for async code (a turn handing the agent pictures): the pictures are decoded and written
/// off the runtime's threads. Returns the kept rows.
pub async fn note_media_blocks_async(
    app: &App,
    conversation_id: &str,
    blocks: &[Value],
    opts: MediaBlockOptions<'_>,
) -> Vec<FileView> {
    let app = app.clone();
    let conversation_id = conversation_id.to_string();
    let blocks = blocks.to_vec();
    let (message_id, via) = (opts.message_id.map(String::from), opts.via.to_string());
    let (dir, now) = (opts.dir.map(Path::to_path_buf), opts.now);
    let kept = off_the_runtime(move || {
        let opts = MediaBlockOptions {
            message_id: message_id.as_deref(),
            via: &via,
            dir: dir.as_deref(),
            now,
        };
        note_media_blocks(&app, &conversation_id, &blocks, opts)
    });
    kept.await.unwrap_or_default()
}

/// `path.resolve(p)`: the path made absolute against the working folder and tidied as text (its ".", ".." and
/// doubled separators taken out), before any link is followed.
fn resolve(p: &Path) -> io::Result<PathBuf> {
    let absolute = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()?.join(p)
    };
    Ok(node_path::normalize(&absolute))
}

/// The real path of a file the page may look at, or `None`: it must exist and sit inside the uploads folder `dir`.
///
/// `p` comes from the page. It is looked up exactly as written (see [`real_path`]): a spelling Windows would
/// quietly read as another file (a trailing dot or space, `nul`, `...`) is no file here, as it was none in Node.
pub fn viewable_path(p: &str, dir: &Path) -> Option<PathBuf> {
    if p.is_empty() || p.contains('\0') {
        return None;
    }
    let root = real_path(dir).ok()?;
    let real = real_path(Path::new(p)).ok()?;
    if !is_inside(&real, &root) || !fs::metadata(to_namespaced(&real)).ok()?.is_file() {
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
    let mut name = String::new();
    for c in shown_name(file).chars() {
        if is_name_char(c) {
            name.push(c);
        } else {
            // One "_" for each UTF-16 unit, as the JS pattern (which has no `u` flag) replaced them: two for an
            // emoji.
            name.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
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
    // `send` refused a path with a ".." in it (403) or a NUL (400) before it looked at the disk, whatever the
    // route had checked; the JS callback made either a 404. The route's own check (`viewable_path`) stays the first
    // guard: this is the second.
    if has_up_segment(&shown) || shown.contains('\0') {
        return not_found(headers);
    }
    // (The file is opened by its literal path, so it is the file `viewable_path` checked.)
    let literal = to_namespaced(file);
    let stat = match tokio::fs::metadata(&literal).await {
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
    let mut source = match tokio::fs::File::open(&literal).await {
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

/// `send`'s `/(?:^|[\\/])\.\.(?:[\\/]|$)/`: a ".." between separators (either slash), or at an end.
fn has_up_segment(path: &str) -> bool {
    path.split(['/', '\\']).any(|part| part == "..")
}

fn respond(status: StatusCode, headers: HeaderMap, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

/// `Date.parse(text)` for an HTTP date ("Tue, 27 Oct 2026 01:56:34 GMT").
fn parse_http_date(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc2822(trim(text))
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
    if cache_control.is_some_and(|value| token_list(value).any(|token| trim(token) == "no-cache")) {
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
    let text = trim_start(text);
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
