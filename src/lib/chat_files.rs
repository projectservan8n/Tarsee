//! Port of `src/lib/chat-files.js`: the files of a chat, kept with its conversation (table chat_files), so the
//! dashboard's chat shows them: after a reload, on every device, on the message they belong to. Ported from
//! TarseeMacOS.
//!
//! What is kept here:
//!   out  every file the agent sends into a chat: send_file to any channel (the dashboard's own chats too), and the
//!        files it attaches to an email (lib/sent_files.rs `note_sent_file`, from lib/tools.rs)
//!   in   files people send in that no note in their message names: the dashboard's own uploads (routes/chat.rs
//!        /send) and pictures or sounds the channels hand the agent as bytes (ai/providers/claude_code.rs, where
//!        they are written to disk). Files the bots save with a note in the message ("[Attached file saved: ...]")
//!        are read from that note instead (public/js/file-viewer-core.js splitNotes), so they are never kept twice.
//!
//! Each row points at a copy inside the workspace's uploads folder, the only place the page may open a file from.
//!
//! Where each one shows in the chat ([`place_files`]):
//!   - a person's file, on the message it came with
//!   - the agent's, on the reply of the turn that sent it ("attached above", as Discord shows it): when the next
//!     message after it is the agent's and it was sent while a turn was at work in that chat
//!   - otherwise as a row of its own, right after the message that was the latest when it came (a file sent there
//!     from another chat, or one whose turn said nothing after it)
//!
//! The JS kept the database in a module-level variable (`initChatFiles(db)`); here [`ChatFiles`] is a service of
//! the app, and the functions with the JS names take the app. As in the JS, they keep nothing and answer with
//! nothing until [`ChatFiles::init`] has run.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{OptionalExtension, named_params, params};
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::app::App;
use crate::db::Db;
use crate::lib::tool_steps::js_string;
use crate::util::js::{ms_from_iso, now_ms, truthy, utf16_truncate};

/// The agent's file goes on the next reply only when that reply came within this long of it.
const ON_REPLY_WITHIN_MS: i64 = 2 * 3_600_000;
const MAX_ROWS: i64 = 2000;

/// `encodeURIComponent(text)`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The URL the page opens a kept file at (routes/chat.rs GET /file).
pub fn file_url(p: &str) -> String {
    format!("/api/chat/file?p={}", encode_uri_component(p))
}

/// A copy of a file inside the uploads folder: what [`record_chat_files`] takes and lib/sent_files.rs makes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeptFile {
    pub name: String,
    pub size: u64,
    #[serde(serialize_with = "serialize_path")]
    pub path: PathBuf,
}

fn serialize_path<S: Serializer>(path: &Path, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&path.to_string_lossy())
}

/// Who sent a file: the agent ("out"), or someone to the agent ("in").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Direction {
    In,
    #[default]
    Out,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::In => "in",
            Direction::Out => "out",
        }
    }
}

/// The options of [`record_chat_files`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecordOptions {
    pub direction: Direction,
    /// The message they came with (a person's files).
    pub message_id: Option<String>,
    /// The turn at work in this conversation when the agent sent them.
    pub turn_id: Option<String>,
    /// What it said with them.
    pub caption: String,
    /// Where they went or came from (discord, telegram, email, web).
    pub via: String,
    /// When, in milliseconds (default: now).
    pub at: Option<i64>,
}

/// A row of `chat_files`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ChatFileRow {
    pub id: i64,
    pub conversation_id: String,
    /// "in" or "out".
    pub direction: String,
    pub message_id: Option<String>,
    pub after_message_id: Option<String>,
    pub turn_id: Option<String>,
    pub name: String,
    pub size: i64,
    pub path: String,
    pub caption: Option<String>,
    pub via: Option<String>,
    pub created_at: i64,
}

/// A kept file as the page gets it.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub id: i64,
    pub name: String,
    pub size: i64,
    pub path: String,
    /// Where the page opens it.
    pub url: String,
    /// "in" (someone sent it) or "agent".
    pub from: String,
    pub caption: String,
    pub via: String,
    /// When it was kept, in milliseconds.
    pub at: i64,
    pub message_id: Option<String>,
    pub after_message_id: Option<String>,
    pub turn_id: Option<String>,
    /// The copy is no longer there (copies are tidied after 30 days).
    pub gone: bool,
}

fn or_none(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// A row as the page gets it: where to open it, and whether it is still there (copies are tidied after 30 days).
pub fn file_view(r: &ChatFileRow) -> FileView {
    FileView {
        id: r.id,
        name: r.name.clone(),
        size: r.size,
        path: r.path.clone(),
        url: file_url(&r.path),
        from: if r.direction == "in" { "in" } else { "agent" }.to_string(),
        caption: r.caption.clone().unwrap_or_default(),
        via: r.via.clone().unwrap_or_default(),
        at: r.created_at,
        message_id: or_none(r.message_id.clone()),
        after_message_id: or_none(r.after_message_id.clone()),
        turn_id: or_none(r.turn_id.clone()),
        gone: !Path::new(&r.path).exists(),
    }
}

const INSERT: &str = "INSERT INTO chat_files (conversation_id, direction, message_id, after_message_id, turn_id, name, size, path, caption, via, created_at)
                      VALUES (:conversationId, :direction, :messageId, :afterMessageId, :turnId, :name, :size, :path, :caption, :via, :at)";
const LATEST: &str = "SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1";
const LATEST_USER: &str =
    "SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1";
const OF_CONV: &str = "SELECT id, conversation_id, direction, message_id, after_message_id, turn_id, name, size, path, caption, via, created_at FROM chat_files WHERE conversation_id = ? ORDER BY id DESC LIMIT ?";
const OF_MESSAGE: &str = "SELECT COUNT(*) AS n FROM chat_files WHERE message_id = ? AND direction = 'in'";
const ORDER: &str =
    "SELECT id, role, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC";
const FORGET: &str = "DELETE FROM chat_files WHERE conversation_id = ?";

/// The chat files of one app's database.
pub struct ChatFiles {
    db: Db,
}

impl ChatFiles {
    /// Starts keeping chat files in the app's database (`initChatFiles(db)`). A database without the table (an old
    /// test fixture) is left alone: files are simply not kept, and `None` comes back.
    pub fn init(app: &App) -> Option<Arc<ChatFiles>> {
        let db = app.db().clone();
        let found = db.with(|conn| -> rusqlite::Result<()> {
            for sql in [INSERT, LATEST, LATEST_USER, OF_CONV, OF_MESSAGE, ORDER, FORGET] {
                conn.prepare_cached(sql)?;
            }
            Ok(())
        });
        match found {
            Ok(()) => Some(app.set(ChatFiles { db })),
            Err(err) => {
                // A database without the table (an old test fixture): files are simply not kept.
                log::warn!("[chat-files] not kept: {err}");
                app.remove::<ChatFiles>();
                None
            }
        }
    }

    /// The app's chat files, when [`init`](Self::init) found the table.
    pub fn of(app: &App) -> Option<Arc<ChatFiles>> {
        app.get::<ChatFiles>()
    }

    /// See [`record_chat_files`].
    pub fn record(&self, conversation_id: &str, files: &[KeptFile], opts: &RecordOptions) -> Vec<FileView> {
        if conversation_id.is_empty() || files.is_empty() {
            return Vec::new();
        }
        let recorded = self.db.with(|conn| -> rusqlite::Result<Vec<FileView>> {
            let after_message_id: Option<String> = conn
                .prepare_cached(LATEST)?
                .query_row([conversation_id], |row| row.get::<_, Option<String>>(0))
                .optional()?
                .flatten()
                .filter(|id| !id.is_empty());
            let mut rows = Vec::new();
            for f in files {
                if f.path.as_os_str().is_empty() {
                    continue;
                }
                let name = if f.name.is_empty() { "file" } else { &f.name };
                let row = ChatFileRow {
                    id: 0,
                    conversation_id: conversation_id.to_string(),
                    direction: opts.direction.as_str().to_string(),
                    message_id: or_none(opts.message_id.clone()),
                    after_message_id: after_message_id.clone(),
                    turn_id: or_none(opts.turn_id.clone()),
                    name: utf16_truncate(name, 200),
                    size: i64::try_from(f.size).unwrap_or(i64::MAX),
                    path: f.path.to_string_lossy().into_owned(),
                    caption: or_none(Some(utf16_truncate(&opts.caption, 500))),
                    via: or_none(Some(utf16_truncate(&opts.via, 40))),
                    created_at: opts.at.filter(|at| *at != 0).unwrap_or_else(now_ms),
                };
                conn.prepare_cached(INSERT)?.execute(named_params! {
                    ":conversationId": row.conversation_id,
                    ":direction": row.direction,
                    ":messageId": row.message_id,
                    ":afterMessageId": row.after_message_id,
                    ":turnId": row.turn_id,
                    ":name": row.name,
                    ":size": row.size,
                    ":path": row.path,
                    ":caption": row.caption,
                    ":via": row.via,
                    ":at": row.created_at,
                })?;
                rows.push(file_view(&ChatFileRow {
                    id: conn.last_insert_rowid(),
                    ..row
                }));
            }
            Ok(rows)
        });
        match recorded {
            Ok(rows) => rows,
            Err(err) => {
                log::warn!(
                    "[chat-files] could not keep a file for {}: {err}",
                    utf16_truncate(conversation_id, 8)
                );
                Vec::new()
            }
        }
    }

    /// See [`latest_user_message_id`].
    pub fn latest_user_message_id(&self, conversation_id: &str) -> Option<String> {
        if conversation_id.is_empty() {
            return None;
        }
        self.db
            .with(|conn| {
                conn.prepare_cached(LATEST_USER)?
                    .query_row([conversation_id], |row| row.get::<_, Option<String>>(0))
                    .optional()
            })
            .ok()
            .flatten()
            .flatten()
            .filter(|id| !id.is_empty())
    }

    /// See [`message_has_files`].
    pub fn message_has_files(&self, message_id: &str) -> bool {
        if message_id.is_empty() {
            return false;
        }
        self.db
            .with(|conn| {
                conn.prepare_cached(OF_MESSAGE)?
                    .query_row([message_id], |row| row.get::<_, i64>(0))
            })
            .is_ok_and(|n| n > 0)
    }

    /// See [`chat_files_for`].
    pub fn files_for(&self, conversation_id: &str) -> Vec<FileView> {
        if conversation_id.is_empty() {
            return Vec::new();
        }
        let rows = self.db.with(|conn| {
            let mut stmt = conn.prepare_cached(OF_CONV)?;
            let rows = stmt.query_map(params![conversation_id, MAX_ROWS], |row| {
                Ok(ChatFileRow {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    direction: row.get(2)?,
                    message_id: row.get(3)?,
                    after_message_id: row.get(4)?,
                    turn_id: row.get(5)?,
                    name: row.get(6)?,
                    size: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                    path: row.get(8)?,
                    caption: row.get(9)?,
                    via: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        let mut rows = rows.unwrap_or_default();
        rows.reverse();
        rows.iter().map(file_view).collect()
    }

    /// See [`place_files_on_page`].
    pub fn place_on_page(&self, conversation_id: &str, page: &mut [Value], complete: bool) -> Vec<FileView> {
        let files = self.files_for(conversation_id);
        if files.is_empty() {
            return Vec::new();
        }
        let order = self.db.with(|conn| {
            let mut stmt = conn.prepare_cached(ORDER)?;
            let rows = stmt.query_map([conversation_id], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, Option<String>>(0)?,
                    "role": row.get::<_, Option<String>>(1)?,
                    "created_at": row.get::<_, Option<String>>(2)?,
                }))
            })?;
            rows.collect::<rusqlite::Result<Vec<Value>>>()
        });
        let Ok(mut order) = order else {
            return Vec::new();
        };
        let lead_files = place_files(&mut order, &files, true);
        let by_id: HashMap<&str, &Value> = order.iter().filter_map(|m| Some((m.get("id")?.as_str()?, m))).collect();
        for m in page.iter_mut() {
            let Some(placed) = m.get("id").and_then(Value::as_str).and_then(|id| by_id.get(id)) else {
                continue;
            };
            let Some(message) = m.as_object_mut() else {
                continue;
            };
            for key in ["files", "filesAfter"] {
                if let Some(list) = placed.get(key) {
                    message.insert(key.to_string(), list.clone());
                }
            }
        }
        if complete { lead_files } else { Vec::new() }
    }

    /// See [`forget_chat_files`].
    pub fn forget(&self, conversation_id: &str) -> usize {
        if conversation_id.is_empty() {
            return 0;
        }
        self.db
            .with(|conn| conn.prepare_cached(FORGET)?.execute([conversation_id]))
            .unwrap_or(0)
    }
}

// ── The JS module's exports, by their names ──────────────────────────────────────────────────────────────────────

/// Starts keeping chat files in the app's database: [`ChatFiles::init`].
pub fn init_chat_files(app: &App) -> Option<Arc<ChatFiles>> {
    ChatFiles::init(app)
}

/// For tests: forget the database (`__resetChatFiles`).
pub fn reset_chat_files(app: &App) {
    app.remove::<ChatFiles>();
}

/// True once the table can be written (`init_chat_files` found it).
pub fn chat_files_ready(app: &App) -> bool {
    app.has::<ChatFiles>()
}

/// Keep files with a conversation. `files` are copies inside the uploads folder.
///   direction   the agent sent them, or someone sent them to the agent
///   message_id  the message they came with (a person's files)
///   turn_id     the turn at work in this conversation when the agent sent them
///   caption     what it said with them; via: where they went or came from (discord, telegram, email, web)
///
/// Returns the kept rows as the page gets them ([`file_view`]), or nothing when nothing could be kept. Never fails.
pub fn record_chat_files(app: &App, conversation_id: &str, files: &[KeptFile], opts: &RecordOptions) -> Vec<FileView> {
    ChatFiles::of(app)
        .map(|kept| kept.record(conversation_id, files, opts))
        .unwrap_or_default()
}

/// The latest message a person sent in a conversation (the one the bytes being written now came with), or `None`.
pub fn latest_user_message_id(app: &App, conversation_id: &str) -> Option<String> {
    ChatFiles::of(app)?.latest_user_message_id(conversation_id)
}

/// True when a message already has files of its own on record (the dashboard's upload kept them first).
pub fn message_has_files(app: &App, message_id: &str) -> bool {
    ChatFiles::of(app).is_some_and(|kept| kept.message_has_files(message_id))
}

/// A conversation's files, oldest first (the newest 2000).
pub fn chat_files_for(app: &App, conversation_id: &str) -> Vec<FileView> {
    ChatFiles::of(app)
        .map(|kept| kept.files_for(conversation_id))
        .unwrap_or_default()
}

/// A page of a conversation's messages (oldest first, as the history API sends them) with its files in their
/// places: placed among all of the conversation's messages (their ids and who said them only), so a file whose
/// message is just over the page's edge still goes on the reply that is on it. Each message of the page (a JSON
/// object with its `id`) gets `files` and `filesAfter` as [`place_files`] gives them; files placed on messages of
/// older pages are left for those pages. Returns the lead files (only on a page that starts at the beginning:
/// `complete`).
pub fn place_files_on_page(app: &App, conversation_id: &str, page: &mut [Value], complete: bool) -> Vec<FileView> {
    ChatFiles::of(app)
        .map(|kept| kept.place_on_page(conversation_id, page, complete))
        .unwrap_or_default()
}

/// The conversation is deleted or cleared: its rows go too (the copies are tidied with the rest of the uploads
/// folder). Returns how many went.
pub fn forget_chat_files(app: &App, conversation_id: &str) -> usize {
    ChatFiles::of(app).map_or(0, |kept| kept.forget(conversation_id))
}

/// "2026-10-27 01:56:34" (SQLite's UTC, to the second), an ISO date or ms → ms (0 for none).
pub fn ms_of(v: &Value) -> i64 {
    if let Value::Number(n) = v {
        return n.as_f64().filter(|f| f.is_finite()).map_or(0, |f| f as i64);
    }
    if !truthy(v) {
        return 0;
    }
    let s = js_string(v);
    ms_from_iso(&sqlite_as_iso(&s).unwrap_or(s)).unwrap_or(0)
}

/// `/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/`: SQLite's text, as the ISO time it is in UTC.
fn sqlite_as_iso(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let shape: &[u8] = match bytes.len() {
        16 => b"dddd-dd-dd dd:dd",
        19 => b"dddd-dd-dd dd:dd:dd",
        _ => return None,
    };
    let fits = bytes.iter().zip(shape).all(|(byte, kind)| match kind {
        b'd' => byte.is_ascii_digit(),
        other => byte == other,
    });
    if !fits {
        return None;
    }
    let seconds = if bytes.len() == 16 { ":00" } else { "" };
    Some(format!("{}T{}{seconds}Z", &s[..10], &s[11..]))
}

/// Put each file in its place among a page of messages (oldest first: JSON objects with `id`, `role` and
/// `created_at`). Files: [`file_view`] rows, oldest first. `complete`: the page starts at the conversation's first
/// message (all of it, or a first page).
///
/// Adds to the messages, in place: `files` (shown in that message: a person's own, or the agent's on its reply) and
/// `filesAfter` (a row of their own just after it). Returns the lead files (before every message, kept when nothing
/// had been said yet; only on a complete page). A file whose place is on an older page is left for that page.
pub fn place_files(messages: &mut [Value], files: &[FileView], complete: bool) -> Vec<FileView> {
    let index: HashMap<String, usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| Some((m.get("id")?.as_str()?.to_string(), i)))
        .collect();
    let created_at = |m: &Value| ms_of(m.get("created_at").unwrap_or(&Value::Null));
    // (None: no messages at all, the JS Infinity.)
    let first_at = messages.first().map(created_at);
    let times: Vec<i64> = messages.iter().map(created_at).collect();
    let mut lead_files = Vec::new();
    /// `(m[key] ||= []).push(f)`
    fn put(messages: &mut [Value], i: usize, key: &str, f: &FileView) {
        let Some(message) = messages[i].as_object_mut() else {
            return;
        };
        let list = message.entry(key).or_insert_with(|| Value::Array(Vec::new()));
        if !truthy(list) || !list.is_array() {
            *list = Value::Array(Vec::new());
        }
        if let (Some(list), Ok(file)) = (list.as_array_mut(), serde_json::to_value(f)) {
            list.push(file);
        }
    }
    // Messages are kept to the second: a file of the same second as a message came after it.
    let last_before = |at: i64| times.iter().rposition(|time| *time <= at);
    for f in files {
        let on_message = f.message_id.as_deref().filter(|id| !id.is_empty());
        let after_message = f.after_message_id.as_deref().filter(|id| !id.is_empty());
        if let Some(i) = on_message.and_then(|id| index.get(id)) {
            put(messages, *i, "files", f);
            continue;
        }
        // (None: before every message.)
        let i: Option<usize> = if let Some(i) = after_message.and_then(|id| index.get(id)) {
            Some(*i)
        } else if after_message.is_none() && on_message.is_none() {
            None // nothing had been said in the chat yet
        } else {
            // Its message is on an older page, or was deleted: by its time.
            if first_at.is_none_or(|first| f.at < first - 999) {
                if complete {
                    lead_files.push(f.clone());
                }
                continue;
            }
            last_before(f.at)
        };
        if i.is_none() && !complete {
            continue;
        }
        let next = i.map_or(0, |i| i + 1);
        let on_reply = f.from == "agent"
            && f.turn_id.as_deref().is_some_and(|turn| !turn.is_empty())
            && messages.get(next).is_some_and(|m| {
                m.get("role").and_then(Value::as_str) == Some("assistant") && times[next] - f.at < ON_REPLY_WITHIN_MS
            });
        if on_reply {
            put(messages, next, "files", f);
        } else if let Some(i) = i {
            put(messages, i, "filesAfter", f);
        } else {
            lead_files.push(f.clone());
        }
    }
    lead_files
}

#[cfg(test)]
mod tests {
    //! Port of the `placeFiles` cases of `test/chat-files.test.js` (the rest of that file's cases that this package
    //! can hold are in `lib/sent_files.rs`).
    use serde_json::json;

    use super::*;
    use crate::db::conversations::{ConversationStore, NewConversation, NewMessage};
    use crate::testkit::{TestApp, test_app};

    fn msgs() -> Vec<Value> {
        vec![
            json!({ "id": "u1", "role": "user", "created_at": "2026-10-27 01:00:00" }),
            json!({ "id": "a1", "role": "assistant", "created_at": "2026-10-27 01:02:00" }),
            json!({ "id": "u2", "role": "user", "created_at": "2026-10-27 05:00:00" }),
        ]
    }

    fn at(s: &str) -> i64 {
        ms_of(&json!(s))
    }

    fn names(list: Option<&Value>) -> Vec<String> {
        list.and_then(Value::as_array)
            .map(|files| files.iter().map(|f| f["name"].as_str().unwrap().to_string()).collect())
            .unwrap_or_default()
    }

    fn file(name: &str, from: &str, at: i64) -> FileView {
        FileView {
            name: name.to_string(),
            from: from.to_string(),
            at,
            ..FileView::default()
        }
    }

    #[test]
    fn the_agents_on_the_next_reply_when_its_turn_sent_it_otherwise_a_row_after_its_message_a_persons_on_their_message()
    {
        let mut messages = msgs();
        let lead = place_files(
            &mut messages,
            &[
                FileView {
                    turn_id: Some("t1".into()),
                    after_message_id: Some("u1".into()),
                    ..file("turn.pdf", "agent", at("2026-10-27 01:01:00"))
                },
                FileView {
                    turn_id: None,
                    after_message_id: Some("u1".into()),
                    ..file("loose.pdf", "agent", at("2026-10-27 01:01:00"))
                },
                FileView {
                    message_id: Some("u2".into()),
                    ..file("photo.jpg", "in", at("2026-10-27 05:00:00"))
                },
            ],
            true,
        );
        assert!(lead.is_empty());
        assert_eq!(names(messages[1].get("files")), ["turn.pdf"]);
        assert_eq!(names(messages[0].get("filesAfter")), ["loose.pdf"]);
        assert_eq!(names(messages[2].get("files")), ["photo.jpg"]);
    }

    #[test]
    fn not_on_a_reply_that_came_hours_later_a_file_whose_message_is_gone_goes_by_its_time_a_later_page_leaves_older_files()
     {
        let mut late = msgs();
        place_files(
            &mut late,
            &[FileView {
                turn_id: Some("t1".into()),
                after_message_id: Some("a1".into()),
                ..file("x.pdf", "agent", at("2026-10-27 01:03:00"))
            }],
            true,
        );
        assert_eq!(
            names(late[1].get("filesAfter")),
            ["x.pdf"],
            "the next reply came 4 hours after it"
        );
        let mut gone = msgs();
        place_files(
            &mut gone,
            &[FileView {
                after_message_id: Some("deleted".into()),
                ..file("y.pdf", "agent", at("2026-10-27 01:30:00"))
            }],
            true,
        );
        assert_eq!(names(gone[1].get("filesAfter")), ["y.pdf"]);
        let mut page = msgs().split_off(2);
        let lead = place_files(
            &mut page,
            &[FileView {
                message_id: Some("u1".into()),
                ..file("old.pdf", "in", at("2026-10-27 01:00:00"))
            }],
            false,
        );
        assert!(lead.is_empty());
        assert_eq!(page[0].get("files"), None);
    }

    #[test]
    fn files_before_every_message_lead_the_page_only_when_it_starts_at_the_beginning() {
        // Nothing had been said yet when it came.
        let early = [file("hello.txt", "agent", at("2026-10-27 00:30:00"))];
        let mut messages = msgs();
        assert_eq!(place_files(&mut messages, &early, true), early);
        assert_eq!(messages, msgs(), "nothing was put on a message");
        assert!(place_files(&mut msgs(), &early, false).is_empty());
        // No messages at all: everything leads.
        let mut none: Vec<Value> = Vec::new();
        let orphan = [FileView {
            after_message_id: Some("gone".into()),
            ..file("a.txt", "agent", 5)
        }];
        assert_eq!(place_files(&mut none, &orphan, true), orphan);
        assert!(place_files(&mut none, &orphan, false).is_empty());
        // Its message is on an older page (well before this page's first message): left for that page.
        let mut page = msgs().split_off(1);
        let older = [FileView {
            after_message_id: Some("u1".into()),
            ..file("b.txt", "agent", at("2026-10-27 01:00:30"))
        }];
        assert!(place_files(&mut page, &older, false).is_empty());
        assert_eq!(page, msgs().split_off(1));
        // A file of the same second as a message came after it; one the agent's turn sent before the first
        // message of the page goes on that reply.
        let mut messages = msgs();
        place_files(
            &mut messages,
            &[
                FileView {
                    after_message_id: Some("gone".into()),
                    ..file("same-second.txt", "in", at("2026-10-27 01:02:00"))
                },
                FileView {
                    turn_id: Some("t0".into()),
                    ..file("first-reply.txt", "agent", at("2026-10-27 01:01:59"))
                },
            ],
            true,
        );
        assert_eq!(names(messages[1].get("filesAfter")), ["same-second.txt"]);
        let mut reply_first = msgs().split_off(1);
        place_files(
            &mut reply_first,
            &[FileView {
                turn_id: Some("t0".into()),
                ..file("first-reply.txt", "agent", at("2026-10-27 01:01:59"))
            }],
            true,
        );
        assert_eq!(names(reply_first[0].get("files")), ["first-reply.txt"]);
    }

    #[test]
    fn a_time_is_read_from_sqlites_text_an_iso_date_or_milliseconds() {
        assert_eq!(ms_of(&json!("2026-10-27 01:56:34")), 1_793_066_194_000);
        assert_eq!(ms_of(&json!("2026-10-27 01:56")), 1_793_066_160_000);
        assert_eq!(ms_of(&json!("2026-10-27T01:56:34.500Z")), 1_793_066_194_500);
        assert_eq!(ms_of(&json!(1_793_066_194_000_i64)), 1_793_066_194_000);
        for none in [json!(null), json!(""), json!("soon"), json!(false), json!(0)] {
            assert_eq!(ms_of(&none), 0, "{none}");
        }
    }

    #[test]
    fn a_files_address_is_its_path_encoded_as_javascript_encodes_it() {
        assert_eq!(
            file_url("/w/uploads/sent-1-Q3 report (final).pdf"),
            "/api/chat/file?p=%2Fw%2Fuploads%2Fsent-1-Q3%20report%20(final).pdf"
        );
        assert_eq!(
            file_url("C:\\w\\uploads\\ñ&a=b#c.txt"),
            "/api/chat/file?p=C%3A%5Cw%5Cuploads%5C%C3%B1%26a%3Db%23c.txt"
        );
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    }

    fn started() -> (TestApp, ConversationStore) {
        let t = test_app();
        ChatFiles::init(&t.app).expect("the table is there");
        let store = ConversationStore::new(&t.app);
        (t, store)
    }

    fn kept(t: &TestApp, name: &str) -> KeptFile {
        let dir = t.config().workspace_dir.join("uploads");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, "xy").unwrap();
        KeptFile {
            name: name.to_string(),
            size: 2,
            path,
        }
    }

    #[test]
    fn a_kept_file_is_recorded_after_the_latest_message_and_comes_back_as_the_page_gets_it() {
        let (t, store) = started();
        assert!(chat_files_ready(&t.app));
        let conv = store.create(NewConversation::titled("files")).unwrap().id;
        let said = store.add_message(&conv, NewMessage::user("here")).unwrap().id;
        let file = kept(&t, "sent-1793000000000-Report.pdf");
        let rows = record_chat_files(
            &t.app,
            &conv,
            std::slice::from_ref(&file),
            &RecordOptions {
                turn_id: Some("turn-1".into()),
                caption: "c".repeat(600),
                via: "telegram".into(),
                at: Some(1_793_000_000_123),
                ..RecordOptions::default()
            },
        );
        let path = file.path.to_string_lossy().into_owned();
        assert_eq!(
            serde_json::to_value(&rows).unwrap(),
            json!([{
                "id": rows[0].id, "name": "sent-1793000000000-Report.pdf", "size": 2, "path": path,
                "url": file_url(&path), "from": "agent", "caption": "c".repeat(500), "via": "telegram",
                "at": 1_793_000_000_123_i64, "messageId": null, "afterMessageId": said, "turnId": "turn-1",
                "gone": false,
            }])
        );
        assert_eq!(
            serde_json::to_value(&rows[0])
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            [
                "id",
                "name",
                "size",
                "path",
                "url",
                "from",
                "caption",
                "via",
                "at",
                "messageId",
                "afterMessageId",
                "turnId",
                "gone"
            ]
        );
        assert_eq!(chat_files_for(&t.app, &conv), rows);
        // A person's file, on their message; "now" when no time is given; nothing for nothing.
        let theirs = record_chat_files(
            &t.app,
            &conv,
            &[
                kept(&t, "chat-1-0-a.png"),
                KeptFile {
                    name: String::new(),
                    size: 0,
                    path: PathBuf::new(),
                },
            ],
            &RecordOptions {
                direction: Direction::In,
                message_id: Some(said.clone()),
                ..RecordOptions::default()
            },
        );
        assert_eq!(theirs.len(), 1, "a file with no path is passed over");
        assert_eq!(
            (theirs[0].from.as_str(), theirs[0].message_id.as_deref()),
            ("in", Some(said.as_str()))
        );
        assert_eq!((theirs[0].caption.as_str(), theirs[0].via.as_str()), ("", ""));
        assert!((theirs[0].at - now_ms()).abs() < 60_000);
        assert!(message_has_files(&t.app, &said));
        assert!(!message_has_files(&t.app, "nobody"));
        assert_eq!(latest_user_message_id(&t.app, &conv), Some(said));
        assert_eq!(chat_files_for(&t.app, &conv).len(), 2, "oldest first");
        assert_eq!(chat_files_for(&t.app, &conv)[0].id, rows[0].id);
        assert!(record_chat_files(&t.app, &conv, &[], &RecordOptions::default()).is_empty());
        assert!(record_chat_files(&t.app, "", &[file], &RecordOptions::default()).is_empty());
        assert_eq!(forget_chat_files(&t.app, &conv), 2);
        assert!(chat_files_for(&t.app, &conv).is_empty());
    }

    #[test]
    fn a_page_of_the_history_gets_its_files_placed_among_all_of_the_conversations_messages() {
        let (t, store) = started();
        let conv = store.create(NewConversation::titled("page")).unwrap().id;
        let asked = store.add_message(&conv, NewMessage::user("the report?")).unwrap().id;
        let turn = RecordOptions {
            turn_id: Some("t1".into()),
            ..RecordOptions::default()
        };
        record_chat_files(&t.app, &conv, &[kept(&t, "sent-1-report.pdf")], &turn);
        let reply = store
            .add_message(&conv, NewMessage::assistant("Here it is"))
            .unwrap()
            .id;
        record_chat_files(
            &t.app,
            &conv,
            &[kept(&t, "sent-2-loose.txt")],
            &RecordOptions::default(),
        );

        // The whole history: the turn's file on its reply, the other after it.
        let mut page: Vec<Value> = store
            .get_messages(&conv)
            .iter()
            .map(crate::db::conversations::to_json)
            .collect();
        assert!(place_files_on_page(&t.app, &conv, &mut page, true).is_empty());
        assert_eq!(page[0]["id"], asked);
        assert_eq!(page[0].get("files"), None);
        assert_eq!(names(page[1].get("files")), ["sent-1-report.pdf"]);
        assert_eq!(names(page[1].get("filesAfter")), ["sent-2-loose.txt"]);
        // A page that holds only the reply still has the file whose message is over its edge.
        let mut last: Vec<Value> = vec![json!({ "id": reply, "role": "assistant", "content": "Here it is" })];
        place_files_on_page(&t.app, &conv, &mut last, false);
        assert_eq!(names(last[0].get("files")), ["sent-1-report.pdf"]);
        // Lead files only on a page that starts at the beginning.
        let quiet = store.create(NewConversation::titled("quiet")).unwrap().id;
        record_chat_files(
            &t.app,
            &quiet,
            &[kept(&t, "sent-3-hello.txt")],
            &RecordOptions::default(),
        );
        store.add_message(&quiet, NewMessage::user("thanks")).unwrap();
        let mut page: Vec<Value> = store
            .get_messages(&quiet)
            .iter()
            .map(crate::db::conversations::to_json)
            .collect();
        let lead = place_files_on_page(&t.app, &quiet, &mut page, true);
        assert_eq!(
            lead.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["sent-3-hello.txt"]
        );
        assert!(place_files_on_page(&t.app, &quiet, &mut page, false).is_empty());
    }

    #[test]
    fn nothing_is_kept_until_the_table_is_found() {
        let t = test_app();
        assert!(!chat_files_ready(&t.app));
        let file = kept(&t, "sent-1-a.txt");
        assert!(record_chat_files(&t.app, "c", std::slice::from_ref(&file), &RecordOptions::default()).is_empty());
        assert!(chat_files_for(&t.app, "c").is_empty());
        assert_eq!(latest_user_message_id(&t.app, "c"), None);
        assert!(!message_has_files(&t.app, "m"));
        assert_eq!(forget_chat_files(&t.app, "c"), 0);
        assert!(place_files_on_page(&t.app, "c", &mut [], true).is_empty());

        // A database without the table (an old fixture): files are simply not kept.
        t.db().with(|c| c.execute_batch("DROP TABLE chat_files")).unwrap();
        assert!(init_chat_files(&t.app).is_none());
        assert!(!chat_files_ready(&t.app));

        // Started, then forgotten again (the JS test hook).
        let t = test_app();
        assert!(init_chat_files(&t.app).is_some());
        assert!(chat_files_ready(&t.app));
        reset_chat_files(&t.app);
        assert!(!chat_files_ready(&t.app));
    }

    #[test]
    fn a_row_that_cannot_be_written_keeps_nothing_and_fails_nothing() {
        let (t, store) = started();
        let conv = store.create(NewConversation::default()).unwrap().id;
        t.db()
            .with(|c| {
                c.execute_batch(
                    "CREATE TRIGGER no_files BEFORE INSERT ON chat_files BEGIN SELECT RAISE(ABORT, 'disk full'); END",
                )
            })
            .unwrap();
        let file = kept(&t, "sent-1-a.txt");
        assert!(record_chat_files(&t.app, &conv, &[file], &RecordOptions::default()).is_empty());
    }
}
