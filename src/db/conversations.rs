//! Port of `src/db/conversations.js`: conversation and message CRUD operations.
//!
//! All methods are synchronous and short, as with `better-sqlite3`.
//!
//! The rows go to the browser as JSON, so each row type here serialises to exactly the object the JS returned:
//! the same field names, and `null` where the column is null.
//!
//! **Errors.** The JS let a failed statement throw. Here the methods that write return `rusqlite::Result` (a
//! message for a conversation that was just deleted is refused by the database, and the caller must hear of it);
//! the methods that only read answer with nothing (`None`, an empty list, 0) and log the failure, since a read
//! can only fail when the database itself is broken.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::app::{App, WeakApp};
use crate::db::Db;
use crate::lib::live_bus::{LiveBus, TimelineMessage};
use crate::lib::message_tools::timeline_text;
use crate::lib::tool_steps::{collapse_whitespace, js_round, js_trim, js_trim_start};
use crate::util::js::{now_iso, now_ms, utf16_len, utf16_truncate};

/// A conversation, as `SELECT * FROM conversations` gives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    /// SQLite's UTC text: "2026-11-12 08:30:00".
    pub created_at: String,
    pub updated_at: String,
    /// The session the conversation's turns resume (see [`ConversationStore::set_session_handle`]).
    pub claude_session_id: Option<String>,
}

/// A conversation in a list: [`ConversationStore::list`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A message with its token counts: [`ConversationStore::get_messages`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub created_at: String,
}

/// A message without token counts: [`ConversationStore::get_recent_messages`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
}

/// What [`ConversationStore::create`] takes. Anything left out (or empty) takes the default: the title
/// "New conversation", the rest null.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewConversation {
    pub title: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
}

impl NewConversation {
    /// A conversation with this title and nothing else set.
    pub fn titled(title: impl Into<String>) -> Self {
        NewConversation {
            title: Some(title.into()),
            ..Self::default()
        }
    }
}

/// What [`ConversationStore::update`] sets. Anything left out (or empty) becomes null.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConversationUpdate {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
}

/// What [`ConversationStore::add_message`] takes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewMessage {
    /// "user", "assistant" or "system" (the database refuses anything else).
    pub role: String,
    pub content: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    /// The sending tab's own id for the message, so it can match the echo on the live timeline.
    pub client_msg_id: Option<String>,
}

impl NewMessage {
    pub fn new(role: impl Into<String>, content: impl Into<String>) -> Self {
        NewMessage {
            role: role.into(),
            content: content.into(),
            ..Self::default()
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::new("user", content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::new("assistant", content)
    }
}

/// What [`ConversationStore::add_message`] returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
}

/// One result of [`ConversationStore::search`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub conversation_title: String,
    /// The matching words in their surroundings, the matches wrapped in `<mark>`.
    pub snippet: String,
}

/// What [`ConversationStore::get_session_recap`] returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecap {
    pub text: String,
    pub age_ms: i64,
    pub message_count: i64,
    /// When the recap was made, as an ISO time.
    pub at: String,
}

/// The JS default of `list`'s limit.
pub const LIST_LIMIT: i64 = 50;
/// The JS default of `getRecentMessages`' limit.
pub const RECENT_MESSAGES_LIMIT: i64 = 20;
/// The JS default of `search`'s limit.
pub const SEARCH_LIMIT: i64 = 30;
/// The JS default of `getSessionRecap`'s staleMinutes.
pub const RECAP_STALE_MINUTES: i64 = 30;

const CONVERSATION_COLUMNS: &str =
    "id, title, provider, model, system_prompt, created_at, updated_at, claude_session_id";

/// Session idle timeout: if no messages in 2 hours, start fresh
const IDLE_TIMEOUT_MS: i64 = 2 * 60 * 60 * 1000;

/// `value || null`: an empty string is nothing.
fn or_null(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

fn conversation_from(row: &Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        title: row.get(1)?,
        provider: row.get(2)?,
        model: row.get(3)?,
        system_prompt: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        claude_session_id: row.get(7)?,
    })
}

/// SQLite's datetime('now') stores naive UTC ('YYYY-MM-DD HH:MM:SS' with no trailing Z). The JS read it as
/// `new Date(stored + "Z")` to force UTC (on a non-UTC host every row would otherwise appear hours stale even
/// when just written). `None` for text that is not such a time (the JS `NaN`).
fn stored_utc_ms(stored: &str) -> Option<i64> {
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(stored, format) {
            return Some(naive.and_utc().timestamp_millis());
        }
    }
    None
}

/// The words of a stored message for the recap: a dashboard reply's timeline JSON gives its text.
fn strip_timeline(content: &str) -> String {
    timeline_text(content).unwrap_or_else(|| content.to_string())
}

/// `text.replace(/^\[[^\]]+\]:\s*/, "")`: the "[name]: " a channel puts in front of what someone said.
fn strip_speaker(text: &str) -> &str {
    let Some(rest) = text.strip_prefix('[') else {
        return text;
    };
    match rest.find(']') {
        Some(end) if end > 0 && rest[end + 1..].starts_with(':') => js_trim_start(&rest[end + 2..]),
        _ => text,
    }
}

/// Conversations and their messages, over the app's database.
#[derive(Clone)]
pub struct ConversationStore {
    db: Db,
    /// For the live timeline (lib/live_bus.rs), found when it is needed; `None` for a store over a bare database.
    app: Option<WeakApp>,
}

impl ConversationStore {
    /// The store over the app's database (`new ConversationStore(db)`). Cheap: make one wherever one is needed.
    /// Saved and deleted messages go on the app's live timeline when it has one.
    pub fn new(app: &App) -> Self {
        ConversationStore {
            db: app.db().clone(),
            app: Some(app.downgrade()),
        }
    }

    /// A store over a database on its own, with no live timeline.
    pub fn for_db(db: Db) -> Self {
        ConversationStore { db, app: None }
    }

    fn bus(&self) -> Option<Arc<LiveBus>> {
        self.app.as_ref()?.upgrade()?.get::<LiveBus>()
    }

    /// Runs a read, answering with the type's "nothing" when the database fails.
    fn read<R: Default>(&self, what: &str, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> R {
        match self.db.with(f) {
            Ok(found) => found,
            Err(err) => {
                log::warn!("[conv] {what} failed: {err}");
                R::default()
            }
        }
    }

    /// Clear all session IDs — forces fresh sessions on next message.
    /// Called on server boot to prevent stale MCP tool registrations.
    pub fn clear_all_sessions(&self) -> rusqlite::Result<()> {
        let changes = self.db.with(|conn| {
            conn.prepare_cached(
                "UPDATE conversations SET claude_session_id = NULL WHERE claude_session_id IS NOT NULL",
            )?
            .execute([])
        })?;
        if changes > 0 {
            log::info!("[sessions] Cleared {changes} stale session(s) on boot");
        }
        Ok(())
    }

    /// List conversations with pagination, the most recently active first. The JS defaults: limit 50, offset 0.
    pub fn list(&self, limit: i64, offset: i64) -> Vec<ConversationSummary> {
        self.read("list", |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, title, provider, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            )?;
            let rows = stmt.query_map([limit, offset], |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    provider: row.get(2)?,
                    model: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?;
            rows.collect()
        })
    }

    /// Get a single conversation by ID.
    pub fn get(&self, id: &str) -> Option<Conversation> {
        self.read("get", |conn| {
            conn.prepare_cached(&format!(
                "SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?"
            ))?
            .query_row([id], conversation_from)
            .optional()
        })
    }

    /// Create a new conversation.
    pub fn create(&self, new: NewConversation) -> rusqlite::Result<Conversation> {
        let id = uuid::Uuid::new_v4().to_string();
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO conversations (id, title, provider, model, system_prompt) VALUES (?, ?, ?, ?, ?)",
            )?
            .execute(params![
                id,
                or_null(&new.title).unwrap_or("New conversation"),
                or_null(&new.provider),
                or_null(&new.model),
                or_null(&new.system_prompt),
            ])?;
            conn.prepare_cached(&format!(
                "SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?"
            ))?
            .query_row([&id], conversation_from)
        })
    }

    /// Update conversation title.
    pub fn update_title(&self, id: &str, title: &str) -> rusqlite::Result<()> {
        self.db.with(|conn| {
            conn.prepare_cached("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")?
                .execute([title, id])
        })?;
        Ok(())
    }

    /// Update conversation settings.
    pub fn update(&self, id: &str, update: ConversationUpdate) -> rusqlite::Result<()> {
        self.db.with(|conn| {
            conn.prepare_cached(
                "UPDATE conversations SET provider = ?, model = ?, system_prompt = ?, updated_at = datetime('now') WHERE id = ?",
            )?
            .execute(params![
                or_null(&update.provider),
                or_null(&update.model),
                or_null(&update.system_prompt),
                id,
            ])
        })?;
        Ok(())
    }

    /// Delete a conversation and all its messages (cascade), and the chat's own settings
    /// (session.<id>.provider, .model, .effort, .clearedAt, .instrHash): nothing reads them once the chat is gone.
    /// True if there was one.
    pub fn delete(&self, id: &str) -> rusqlite::Result<bool> {
        let gone = self.db.with(|conn| {
            conn.prepare_cached("DELETE FROM conversations WHERE id = ?")?
                .execute([id])
        })? > 0;
        if gone {
            // its live timeline too (lib/live_bus.rs)
            if let Some(bus) = self.bus() {
                bus.forget_conversation(id);
            }
            self.forget_chat_settings(id);
        }
        Ok(gone)
    }

    /// Remove session.<id>.* (an exact prefix, so session.reset.* is never touched). Never fails.
    fn forget_chat_settings(&self, id: &str) {
        let prefix = format!("session.{id}.");
        let done = self.db.with(|conn| {
            conn.prepare_cached("DELETE FROM settings WHERE substr(key, 1, ?) = ?")?
                .execute(params![utf16_len(&prefix) as i64, prefix])
        });
        if let Err(err) = done {
            // A database with no settings table (a bare test one) has none to remove.
            let message = err.to_string();
            if !message.to_lowercase().contains("no such table") {
                log::warn!("[conv] removing chat {id}'s settings failed: {message}");
            }
        }
    }

    /// Get all messages in a conversation, oldest first.
    pub fn get_messages(&self, conversation_id: &str) -> Vec<Message> {
        self.read("getMessages", |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, role, content, provider, model, tokens_in, tokens_out, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map([conversation_id], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                    provider: row.get(3)?,
                    model: row.get(4)?,
                    tokens_in: row.get(5)?,
                    tokens_out: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })?;
            rows.collect()
        })
    }

    /// Get the N most recent messages (returned in chronological order). The JS default: 20.
    pub fn get_recent_messages(&self, conversation_id: &str, limit: i64) -> Vec<RecentMessage> {
        let mut rows: Vec<RecentMessage> = self.read("getRecentMessages", |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, role, content, provider, model, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
            )?;
            let rows = stmt.query_map(params![conversation_id, limit], |row| {
                Ok(RecentMessage {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                    provider: row.get(3)?,
                    model: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?;
            rows.collect()
        });
        rows.reverse(); // chronological order
        rows
    }

    /// Session recap — if the conversation has been idle for >= `stale_minutes` (the JS default: 30), return a
    /// short human-readable "last time we..." summary. Used when a client resumes an old conversation on a new
    /// device.
    ///
    /// Built from the messages alone (no AI call, nothing written). Returns `None` when:
    ///   - conversation doesn't exist
    ///   - last activity < `stale_minutes` ago (no recap needed)
    ///   - conversation has < 3 messages (nothing to summarize)
    pub fn get_session_recap(&self, conversation_id: &str, stale_minutes: i64) -> Option<SessionRecap> {
        let conv = self.get(conversation_id)?;
        if conv.updated_at.is_empty() {
            return None;
        }
        let updated = stored_utc_ms(&conv.updated_at)?;
        let age_ms = now_ms() - updated;
        if age_ms < stale_minutes.saturating_mul(60_000) {
            return None;
        }

        let msg_count = self.message_count(conversation_id);
        if msg_count < 3 {
            return None;
        }

        // READ-ONLY. This used to call summarizeConversation(), which APPENDS a section to memory/summaries.md,
        // and the dashboard calls this GET every time a chat is opened or a device wakes: just looking at an idle
        // chat kept writing summaries into the agent's memory. The recap below is built from the messages alone;
        // the write was never used for it.
        let messages = self.get_recent_messages(conversation_id, 15);
        let users: Vec<&RecentMessage> = messages.iter().filter(|m| m.role == "user").collect();
        let user_msgs: Vec<String> = users[users.len().saturating_sub(3)..]
            .iter()
            .map(|m| utf16_truncate(strip_speaker(&strip_timeline(&m.content)), 140))
            .collect();
        let last_assistant = messages
            .iter()
            .rev()
            .find(|m| m.role == "assistant")
            .map(|m| utf16_truncate(&strip_timeline(&m.content), 220))
            .unwrap_or_default();

        let age_hrs = js_round(age_ms as f64 / 3_600_000.0) as i64;
        let age_label = if age_hrs < 1 {
            "< 1 hr".to_string()
        } else if age_hrs < 24 {
            format!("{age_hrs} hr")
        } else {
            format!("{} days", js_round(age_hrs as f64 / 24.0) as i64)
        };

        let mut lines = vec![format!("Last active {age_label} ago · {msg_count} messages total.")];
        if !user_msgs.is_empty() {
            lines.push(format!("You were asking about: {}", user_msgs.join(" · ")));
        }
        if !last_assistant.is_empty() {
            lines.push(format!("Last response: {last_assistant}"));
        }
        Some(SessionRecap {
            text: lines.join("\n"),
            age_ms,
            message_count: msg_count,
            at: now_iso(),
        })
    }

    /// Add a message to a conversation.
    pub fn add_message(&self, conversation_id: &str, message: NewMessage) -> rusqlite::Result<AddedMessage> {
        let id = uuid::Uuid::new_v4().to_string();
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO messages (id, conversation_id, role, content, provider, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                id,
                conversation_id,
                message.role,
                message.content,
                or_null(&message.provider),
                or_null(&message.model),
                message.tokens_in.filter(|n| *n != 0),
                message.tokens_out.filter(|n| *n != 0),
            ])?;
            conn.prepare_cached("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")?
                .execute([conversation_id])
        })?;
        // Every channel persists through here, so this one line puts every user and assistant message on the live
        // dashboard timeline. clientMsgId is the sending tab's own id for the message, so it can match the echo.
        if let Some(bus) = self.bus() {
            let mut extra = Map::new();
            if let Some(client_msg_id) = or_null(&message.client_msg_id) {
                extra.insert("clientMsgId".into(), json!(client_msg_id));
            }
            bus.publish_message(
                conversation_id,
                TimelineMessage {
                    id: &id,
                    role: &message.role,
                    content: &message.content,
                },
                &extra,
            );
        }
        Ok(AddedMessage {
            id,
            conversation_id: conversation_id.to_string(),
            role: message.role,
            content: message.content,
        })
    }

    /// Delete a specific message. True if there was one.
    pub fn delete_message(&self, conversation_id: &str, message_id: &str) -> rusqlite::Result<bool> {
        let gone = self.db.with(|conn| {
            conn.prepare_cached("DELETE FROM messages WHERE id = ? AND conversation_id = ?")?
                .execute([message_id, conversation_id])
        })? > 0;
        if gone && let Some(bus) = self.bus() {
            bus.forget_message(conversation_id, message_id);
        }
        Ok(gone)
    }

    /// Get message count for a conversation.
    pub fn message_count(&self, conversation_id: &str) -> i64 {
        self.read("messageCount", |conn| {
            conn.prepare_cached("SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?")?
                .query_row([conversation_id], |row| row.get(0))
        })
    }

    fn write_session_handle(&self, conversation_id: &str, handle: Option<&str>) -> rusqlite::Result<()> {
        self.db.with(|conn| {
            conn.prepare_cached(
                "UPDATE conversations SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?",
            )?
            .execute(params![handle, conversation_id])
        })?;
        Ok(())
    }

    /// Store the session a conversation's turns resume (design 4.10): the Claude plan's bare session id, or any
    /// other AI's tagged handle ("deepseek/cc/deepseek:<id>", ai/session_handle.rs). `None` forgets it. Kept in the
    /// conversations.claude_session_id column, so older installs need no migration.
    pub fn set_session_handle(&self, conversation_id: &str, handle: Option<&str>) -> rusqlite::Result<()> {
        self.write_session_handle(conversation_id, handle)
    }

    /// The old name of [`set_session_handle`](Self::set_session_handle).
    pub fn set_claude_session_id(&self, conversation_id: &str, handle: Option<&str>) -> rusqlite::Result<()> {
        self.set_session_handle(conversation_id, handle)
    }

    /// Full-text search across all messages. Returns matching messages with conversation title and highlighted
    /// snippet, the best match first. The JS default limit: 30.
    pub fn search(&self, query: &str, limit: i64) -> Vec<SearchResult> {
        let trimmed = js_trim(query);
        if trimmed.is_empty() {
            return Vec::new();
        }
        // Escape FTS5 special chars and add prefix matching
        let escaped = collapse_whitespace(&trimmed.replace(['\'', '"'], ""));
        let fts_query = escaped
            .split(' ')
            .map(|word| format!("\"{word}\"*"))
            .collect::<Vec<_>>()
            .join(" ");
        let found = self.db.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
                        c.title as conversation_title,
                        snippet(messages_fts, 0, '<mark>', '</mark>', '...', 48) as snippet
                 FROM messages_fts
                 JOIN messages m ON m.rowid = messages_fts.rowid
                 JOIN conversations c ON c.id = m.conversation_id
                 WHERE messages_fts MATCH ?
                 ORDER BY rank
                 LIMIT ?",
            )?;
            let rows = stmt.query_map(params![fts_query, limit], |row| {
                Ok(SearchResult {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                    conversation_title: row.get(5)?,
                    snippet: row.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        found.unwrap_or_default()
    }

    /// The old name of [`get_session_handle`](Self::get_session_handle).
    pub fn get_claude_session_id(&self, conversation_id: &str) -> Option<String> {
        self.get_session_handle(conversation_id)
    }

    /// The session handle a conversation's next turn resumes (see `set_session_handle`), or `None`. Returns `None`
    /// if the session is stale (idle > 2 hours) to force a fresh start, on every AI.
    pub fn get_session_handle(&self, conversation_id: &str) -> Option<String> {
        let conv = self.get(conversation_id)?;
        let handle = conv.claude_session_id.filter(|handle| !handle.is_empty())?;

        // (A time that cannot be read is not counted as idle; no time at all is.)
        let idle_ms = if conv.updated_at.is_empty() {
            Some(now_ms())
        } else {
            stored_utc_ms(&conv.updated_at).map(|updated_at| now_ms() - updated_at)
        };
        if idle_ms.is_some_and(|idle| idle > IDLE_TIMEOUT_MS) {
            log::info!("[session] Session for conv {conversation_id} expired (idle > 2h), starting fresh");
            if let Err(err) = self.write_session_handle(conversation_id, None) {
                log::warn!("[conv] forgetting the expired session of {conversation_id} failed: {err}");
            }
            return None;
        }

        Some(handle)
    }
}

/// The store as plain JSON rows, for code that builds a response out of them (`{ ...conv, messages }`).
pub fn to_json<T: Serialize>(row: &T) -> Value {
    serde_json::to_value(row).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    //! Port of the `ConversationStore` cases of `test/db.test.js`, the "live bus: messages" cases of
    //! `test/live-bus.test.js`, and the cases of `test/conversation-settings-cleanup.test.js` that need only this
    //! store (its daily-sweep case needs lib/retention.rs, package S1).
    use super::*;
    use crate::testkit::{TestApp, test_app};

    fn store() -> (TestApp, ConversationStore) {
        let t = test_app();
        let store = ConversationStore::new(&t.app);
        (t, store)
    }

    fn with_bus() -> (TestApp, ConversationStore, Arc<LiveBus>) {
        let t = test_app();
        let bus = LiveBus::init(&t.app);
        let store = ConversationStore::new(&t.app);
        (t, store, bus)
    }

    fn say(store: &ConversationStore, conv: &str, role: &str, content: &str) -> AddedMessage {
        store.add_message(conv, NewMessage::new(role, content)).unwrap()
    }

    // ── test/db.test.js ──────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn creates_a_conversation() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::titled("Test conversation")).unwrap();
        assert!(!conv.id.is_empty());
        assert_eq!(conv.title, "Test conversation");
        assert_eq!(conv.id.len(), 36, "a UUID, as crypto.randomUUID() gave");
    }

    #[test]
    fn lists_conversations() {
        let (_t, store) = store();
        store.create(NewConversation::titled("One")).unwrap();
        let list = store.list(LIST_LIMIT, 0);
        assert!(!list.is_empty());
    }

    #[test]
    fn gets_a_conversation_by_id() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::titled("Get test")).unwrap();
        let found = store.get(&conv.id).unwrap();
        assert_eq!(found.title, "Get test");
        assert_eq!(found, conv);
    }

    #[test]
    fn deletes_a_conversation() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::titled("Delete test")).unwrap();
        assert!(store.delete(&conv.id).unwrap());
        assert_eq!(store.get(&conv.id), None);
        assert!(!store.delete(&conv.id).unwrap());
    }

    #[test]
    fn adds_and_retrieves_messages() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::titled("Message test")).unwrap();
        say(&store, &conv.id, "user", "Hello!");
        say(&store, &conv.id, "assistant", "Hi there!");

        let messages = store.get_messages(&conv.id);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
    }

    #[test]
    fn returns_message_count() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::titled("Count test")).unwrap();
        assert_eq!(store.message_count(&conv.id), 0);
        say(&store, &conv.id, "user", "Hello");
        assert_eq!(store.message_count(&conv.id), 1);
    }

    #[test]
    fn cascades_delete_to_messages() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::titled("Cascade test")).unwrap();
        say(&store, &conv.id, "user", "Hello");
        store.delete(&conv.id).unwrap();
        assert_eq!(store.get_messages(&conv.id).len(), 0);
    }

    #[test]
    fn keeps_a_chats_session_handle_any_ais_design_4_10_under_its_old_names_too() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::titled("Handle test")).unwrap();
        store
            .set_session_handle(&conv.id, Some("deepseek/cc/deepseek:abc"))
            .unwrap();
        assert_eq!(
            store.get_session_handle(&conv.id).as_deref(),
            Some("deepseek/cc/deepseek:abc")
        );
        assert_eq!(
            store.get_claude_session_id(&conv.id).as_deref(),
            Some("deepseek/cc/deepseek:abc"),
            "the old name reads the same"
        );
        store.set_claude_session_id(&conv.id, Some("plain-raw-id")).unwrap();
        assert_eq!(
            store.get_session_handle(&conv.id).as_deref(),
            Some("plain-raw-id"),
            "the old name writes the same"
        );
        store.set_session_handle(&conv.id, None).unwrap();
        assert_eq!(store.get_session_handle(&conv.id), None);
    }

    // ── test/live-bus.test.js: "live bus: messages" ──────────────────────────────────────────────────────────────

    #[test]
    fn every_saved_message_goes_on_the_timeline_with_the_sending_tabs_id() {
        let (_t, store, bus) = with_bus();
        let conv = store.create(NewConversation::titled("Live")).unwrap();
        let user = store
            .add_message(
                &conv.id,
                NewMessage {
                    client_msg_id: Some("tab-123".into()),
                    ..NewMessage::user("hello")
                },
            )
            .unwrap();
        say(
            &store,
            &conv.id,
            "assistant",
            "hi <tool_call>{\"name\":\"Bash\"}</tool_call>\n\n\n\nthere",
        );
        let msgs: Vec<_> = bus
            .events_since(&conv.id, 0, 500)
            .into_iter()
            .filter(|e| e.r#type == "message")
            .collect();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].payload["id"], user.id);
        assert_eq!(msgs[0].payload["clientMsgId"], "tab-123");
        assert_eq!(
            msgs[1].payload["content"], "hi \n\nthere",
            "tool-call JSON stripped: it belongs to steps"
        );
        assert!(msgs[1].payload.get("clientMsgId").is_none(), "absent, not null");
        assert!(
            bus.has_client_msg_id(&conv.id, "tab-123"),
            "a retry of the same send is recognised"
        );
        assert!(!bus.has_client_msg_id(&conv.id, "tab-999"));
        assert_eq!(bus.recent_client_msg_ids(&conv.id, 24 * 3_600_000), [json!("tab-123")]);
    }

    #[test]
    fn a_deleted_message_a_deleted_chat_and_a_cleared_chat_leave_nothing_on_the_timeline() {
        let (_t, store, bus) = with_bus();
        let conv = store.create(NewConversation::titled("Forget me")).unwrap();
        let m1 = say(&store, &conv.id, "user", "secret one");
        say(&store, &conv.id, "user", "secret two");
        assert!(store.delete_message(&conv.id, &m1.id).unwrap());
        assert_eq!(
            bus.events_since(&conv.id, 0, 500)
                .iter()
                .map(|e| e.payload["content"].clone())
                .collect::<Vec<_>>(),
            [json!("secret two")]
        );
        assert!(!store.delete_message(&conv.id, &m1.id).unwrap(), "once");
        store.delete(&conv.id).unwrap();
        assert!(bus.events_since(&conv.id, 0, 500).is_empty());
        let other = store.create(NewConversation::titled("Clear me")).unwrap();
        say(&store, &other.id, "user", "x");
        assert_eq!(bus.forget_conversation(&other.id), 1);
        assert!(bus.events_since(&other.id, 0, 500).is_empty());
    }

    #[test]
    fn opening_a_chats_recap_writes_nothing_to_memory() {
        let (t, store, _bus) = with_bus();
        let conv = store.create(NewConversation::titled("Old chat")).unwrap();
        for i in 0..4 {
            say(
                &store,
                &conv.id,
                if i % 2 == 1 { "assistant" } else { "user" },
                &format!("m{i}"),
            );
        }
        t.db()
            .with(|c| {
                c.execute(
                    "UPDATE conversations SET updated_at = datetime('now', '-2 hours') WHERE id = ?",
                    [&conv.id],
                )
            })
            .unwrap();
        let memory_before = dir_listing(&t.config().memory_dir());
        let recap = store.get_session_recap(&conv.id, 30).unwrap();
        assert!(recap.text.contains("Last active"));
        assert_eq!(dir_listing(&t.config().memory_dir()), memory_before);
        assert_eq!(recap.message_count, 4);
    }

    fn dir_listing(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    // ── test/conversation-settings-cleanup.test.js (the cases that need only this store) ─────────────────────────

    const FIELDS: [&str; 5] = ["provider", "model", "effort", "clearedAt", "instrHash"];

    fn set_setting(t: &TestApp, key: &str, value: &str) {
        t.db()
            .with(|c| {
                c.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    [key, value],
                )
            })
            .unwrap();
    }

    fn chat_with_settings(t: &TestApp, store: &ConversationStore) -> String {
        let conv = store.create(NewConversation::titled("A chat")).unwrap();
        for field in FIELDS {
            set_setting(t, &format!("session.{}.{field}", conv.id), &format!("{field}-value"));
        }
        conv.id
    }

    fn chat_keys(t: &TestApp, id: &str) -> Vec<String> {
        t.db()
            .with(|c| {
                let mut stmt = c.prepare("SELECT key FROM settings WHERE key LIKE ? ORDER BY key")?;
                let rows = stmt.query_map([format!("session.{id}.%")], |row| row.get(0))?;
                rows.collect::<rusqlite::Result<Vec<String>>>()
            })
            .unwrap()
    }

    fn setting(t: &TestApp, key: &str) -> Option<String> {
        t.db()
            .with(|c| {
                c.query_row("SELECT value FROM settings WHERE key = ?", [key], |row| row.get(0))
                    .optional()
            })
            .unwrap()
    }

    #[test]
    fn deleting_a_chat_removes_its_session_id_rows_and_only_its_own() {
        let (t, store, _bus) = with_bus();
        set_setting(&t, "session.reset.mode", "idle");
        set_setting(&t, "session.reset.idleMinutes", "90");
        let gone = chat_with_settings(&t, &store);
        let kept = chat_with_settings(&t, &store);
        assert_eq!(chat_keys(&t, &gone).len(), FIELDS.len());

        assert!(store.delete(&gone).unwrap());
        assert!(chat_keys(&t, &gone).is_empty(), "the deleted chat's settings are gone");
        assert_eq!(chat_keys(&t, &kept).len(), FIELDS.len(), "another chat's settings stay");
        assert_eq!(setting(&t, "session.reset.mode").as_deref(), Some("idle"));
        assert_eq!(setting(&t, "session.reset.idleMinutes").as_deref(), Some("90"));
    }

    #[test]
    fn a_chat_that_isnt_there_removes_nothing() {
        let (t, store, _bus) = with_bus();
        let kept = chat_with_settings(&t, &store);
        assert!(!store.delete("no-such-chat").unwrap());
        assert_eq!(chat_keys(&t, &kept).len(), FIELDS.len());
    }

    #[test]
    fn a_database_with_no_settings_table_still_deletes_the_chat() {
        let bare = Connection::open_in_memory().unwrap();
        bare.execute_batch(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, provider TEXT, model TEXT, system_prompt TEXT, claude_session_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
             CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, provider TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at TEXT DEFAULT (datetime('now')));
             CREATE VIRTUAL TABLE messages_fts USING fts5(content);",
        )
        .unwrap();
        let store = ConversationStore::for_db(Db::from_connection(bare));
        let conv = store.create(NewConversation::titled("Bare")).unwrap();
        assert_eq!(conv.title, "Bare");
        assert!(store.delete(&conv.id).unwrap());
        assert_eq!(store.get(&conv.id), None);
    }

    // ── What the Node tests left untested ────────────────────────────────────────────────────────────────────────

    #[test]
    fn rows_are_written_for_the_browser_with_the_node_field_names_and_nulls() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::default()).unwrap();
        assert_eq!(
            serde_json::to_string(&conv).unwrap(),
            format!(
                r#"{{"id":"{}","title":"New conversation","provider":null,"model":null,"system_prompt":null,"created_at":"{}","updated_at":"{}","claude_session_id":null}}"#,
                conv.id, conv.created_at, conv.updated_at
            )
        );
        assert_eq!(conv.created_at.len(), 19, "SQLite's UTC text");
        let added = store
            .add_message(
                &conv.id,
                NewMessage {
                    provider: Some("claude".into()),
                    model: Some(String::new()),
                    tokens_in: Some(12),
                    tokens_out: Some(0),
                    ..NewMessage::assistant("Hi")
                },
            )
            .unwrap();
        assert_eq!(
            to_json(&added),
            json!({ "id": added.id, "conversationId": conv.id, "role": "assistant", "content": "Hi" })
        );
        let stored = store.get_messages(&conv.id);
        assert_eq!(
            serde_json::to_string(&stored[0]).unwrap(),
            format!(
                r#"{{"id":"{}","role":"assistant","content":"Hi","provider":"claude","model":null,"tokens_in":12,"tokens_out":null,"created_at":"{}"}}"#,
                added.id, stored[0].created_at
            ),
            "an empty model and a count of 0 are stored as null, as `value || null` did"
        );
        let recent = store.get_recent_messages(&conv.id, RECENT_MESSAGES_LIMIT);
        assert_eq!(
            to_json(&recent[0]).as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "role", "content", "provider", "model", "created_at"],
            "no token counts on a recent message"
        );
        let listed = store.list(LIST_LIMIT, 0);
        assert_eq!(
            to_json(&listed[0]).as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "title", "provider", "model", "created_at", "updated_at"]
        );
    }

    #[test]
    fn create_and_update_keep_what_is_given_and_null_what_is_empty() {
        let (_t, store) = store();
        let conv = store
            .create(NewConversation {
                title: Some(String::new()),
                provider: Some("codex".into()),
                model: Some("gpt".into()),
                system_prompt: Some("Be brief.".into()),
            })
            .unwrap();
        assert_eq!(conv.title, "New conversation");
        assert_eq!(
            (
                conv.provider.as_deref(),
                conv.model.as_deref(),
                conv.system_prompt.as_deref()
            ),
            (Some("codex"), Some("gpt"), Some("Be brief."))
        );
        store
            .update(
                &conv.id,
                ConversationUpdate {
                    provider: Some("claude".into()),
                    model: Some(String::new()),
                    system_prompt: None,
                },
            )
            .unwrap();
        store.update_title(&conv.id, "Renamed").unwrap();
        let after = store.get(&conv.id).unwrap();
        assert_eq!(after.title, "Renamed");
        assert_eq!(
            (after.provider.as_deref(), after.model, after.system_prompt),
            (Some("claude"), None, None)
        );
    }

    #[test]
    fn the_list_is_paged_most_recently_active_first_and_recent_messages_come_oldest_first() {
        let (t, store) = store();
        let ids: Vec<String> = (0..3)
            .map(|i| store.create(NewConversation::titled(format!("c{i}"))).unwrap().id)
            .collect();
        for (i, id) in ids.iter().enumerate() {
            t.db()
                .with(|c| {
                    c.execute(
                        "UPDATE conversations SET updated_at = datetime('now', ?) WHERE id = ?",
                        [format!("-{} minutes", 10 - i), id.clone()],
                    )
                })
                .unwrap();
        }
        let titles = |limit, offset| {
            store
                .list(limit, offset)
                .into_iter()
                .map(|c| c.title)
                .collect::<Vec<_>>()
        };
        assert_eq!(titles(50, 0), ["c2", "c1", "c0"]);
        assert_eq!(titles(2, 0), ["c2", "c1"]);
        assert_eq!(titles(2, 2), ["c0"]);

        for i in 0..5 {
            let added = say(&store, &ids[0], "user", &format!("m{i}"));
            t.db()
                .with(|c| {
                    c.execute(
                        "UPDATE messages SET created_at = datetime('now', ?) WHERE id = ?",
                        [format!("-{} seconds", 50 - i), added.id],
                    )
                })
                .unwrap();
        }
        let recent: Vec<String> = store
            .get_recent_messages(&ids[0], 3)
            .into_iter()
            .map(|m| m.content)
            .collect();
        assert_eq!(recent, ["m2", "m3", "m4"]);
    }

    #[test]
    fn a_message_for_a_conversation_that_is_gone_or_with_a_role_the_database_refuses_is_an_error() {
        let (_t, store, bus) = with_bus();
        let err = store.add_message("no-such-chat", NewMessage::user("hi")).unwrap_err();
        assert!(err.to_string().contains("FOREIGN KEY constraint failed"), "{err}");
        let conv = store.create(NewConversation::default()).unwrap();
        assert!(store.add_message(&conv.id, NewMessage::new("robot", "hi")).is_err());
        assert!(
            bus.events_since(&conv.id, 0, 500).is_empty(),
            "nothing went on the timeline"
        );
        assert_eq!(store.message_count(&conv.id), 0);
    }

    #[test]
    fn saving_a_message_makes_its_conversation_the_latest() {
        let (t, store) = store();
        let conv = store.create(NewConversation::default()).unwrap();
        t.db()
            .with(|c| {
                c.execute(
                    "UPDATE conversations SET updated_at = '2020-01-01 00:00:00' WHERE id = ?",
                    [&conv.id],
                )
            })
            .unwrap();
        say(&store, &conv.id, "user", "hello");
        assert_ne!(store.get(&conv.id).unwrap().updated_at, "2020-01-01 00:00:00");
    }

    #[test]
    fn a_recap_says_how_long_ago_what_was_asked_and_the_last_reply() {
        let (t, store) = store();
        let conv = store.create(NewConversation::titled("Recap")).unwrap();
        assert_eq!(store.get_session_recap("no-such-chat", 30), None);
        say(&store, &conv.id, "user", "[tg_user]:   first question");
        say(
            &store,
            &conv.id,
            "assistant",
            &json!({ "__timeline": true, "items": [], "text": "The timeline answer." }).to_string(),
        );
        assert_eq!(store.get_session_recap(&conv.id, 0), None, "under three messages");
        say(&store, &conv.id, "user", &"long ".repeat(60));
        // Messages are kept to the second: give them an order.
        let ids: Vec<String> = t
            .db()
            .with(|c| {
                let mut stmt = c.prepare("SELECT id FROM messages ORDER BY rowid")?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                rows.collect::<rusqlite::Result<Vec<String>>>()
            })
            .unwrap();
        for (i, id) in ids.iter().enumerate() {
            t.db()
                .with(|c| {
                    c.execute(
                        "UPDATE messages SET created_at = datetime('now', ?) WHERE id = ?",
                        [format!("-{} seconds", 100 - i), id.clone()],
                    )
                })
                .unwrap();
        }
        assert_eq!(store.get_session_recap(&conv.id, 30), None, "active a moment ago");

        let aged = |modifier: &str, stale_minutes: i64| {
            t.db()
                .with(|c| {
                    c.execute(
                        "UPDATE conversations SET updated_at = datetime('now', ?) WHERE id = ?",
                        [modifier, conv.id.as_str()],
                    )
                })
                .unwrap();
            store.get_session_recap(&conv.id, stale_minutes)
        };
        let age = |modifier: &str| aged(modifier, RECAP_STALE_MINUTES).unwrap();
        let recap = age("-5 hours");
        let asked = format!("first question · {}", utf16_truncate(&"long ".repeat(60), 140));
        assert_eq!(
            recap.text,
            format!(
                "Last active 5 hr ago · 3 messages total.\nYou were asking about: {asked}\nLast response: The timeline answer."
            )
        );
        assert_eq!(recap.message_count, 3);
        assert!((recap.age_ms - 5 * 3_600_000).abs() < 60_000);
        assert_eq!(recap.at.len(), 24);
        assert_eq!(
            to_json(&recap).as_object().unwrap().keys().collect::<Vec<_>>(),
            ["text", "ageMs", "messageCount", "at"]
        );
        assert!(age("-40 minutes").text.starts_with("Last active 1 hr ago"));
        assert_eq!(
            aged("-20 minutes", RECAP_STALE_MINUTES),
            None,
            "not idle for half an hour yet"
        );
        let short = aged("-20 minutes", 10).unwrap();
        assert!(
            short.text.starts_with("Last active < 1 hr ago"),
            "0 hours rounds to under one"
        );
        assert!(age("-3 days").text.starts_with("Last active 3 days ago"));
        assert_eq!(aged("-3 days", 60 * 24 * 7), None, "not stale yet by that measure");
    }

    #[test]
    fn a_session_idle_for_over_two_hours_is_forgotten() {
        let (t, store) = store();
        let conv = store.create(NewConversation::default()).unwrap();
        store.set_session_handle(&conv.id, Some("sess-1")).unwrap();
        t.db()
            .with(|c| {
                c.execute(
                    "UPDATE conversations SET updated_at = datetime('now', '-3 hours') WHERE id = ?",
                    [&conv.id],
                )
            })
            .unwrap();
        assert_eq!(store.get_session_handle(&conv.id), None);
        assert_eq!(
            store.get(&conv.id).unwrap().claude_session_id,
            None,
            "and cleared in the database"
        );
        assert_eq!(store.get_session_handle("no-such-chat"), None);
        // Just under two hours is still resumed.
        store.set_session_handle(&conv.id, Some("sess-2")).unwrap();
        t.db()
            .with(|c| {
                c.execute(
                    "UPDATE conversations SET updated_at = datetime('now', '-119 minutes') WHERE id = ?",
                    [&conv.id],
                )
            })
            .unwrap();
        assert_eq!(store.get_session_handle(&conv.id).as_deref(), Some("sess-2"));
    }

    #[test]
    fn clearing_all_sessions_forgets_every_handle() {
        let (_t, store) = store();
        let a = store.create(NewConversation::default()).unwrap();
        let b = store.create(NewConversation::default()).unwrap();
        store.set_session_handle(&a.id, Some("one")).unwrap();
        store.set_session_handle(&b.id, Some("two")).unwrap();
        store.clear_all_sessions().unwrap();
        assert_eq!(store.get(&a.id).unwrap().claude_session_id, None);
        assert_eq!(store.get_session_handle(&b.id), None);
        store.clear_all_sessions().unwrap();
    }

    #[test]
    fn search_finds_words_by_their_start_and_marks_them() {
        let (_t, store) = store();
        let conv = store.create(NewConversation::titled("Trip")).unwrap();
        say(&store, &conv.id, "user", "Book the flight to Manila for Tuesday");
        say(&store, &conv.id, "assistant", "Done: the hotel is booked too");
        let hits = store.search("  flig   man ", SEARCH_LIMIT);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, conv.id);
        assert_eq!(hits[0].conversation_title, "Trip");
        assert_eq!(hits[0].role, "user");
        assert_eq!(
            hits[0].snippet,
            "Book the <mark>flight</mark> to <mark>Manila</mark> for Tuesday"
        );
        assert_eq!(
            to_json(&hits[0]).as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "id",
                "conversation_id",
                "role",
                "content",
                "created_at",
                "conversation_title",
                "snippet"
            ]
        );
        assert_eq!(store.search("book", 1).len(), 1, "the limit");
        assert_eq!(store.search("book", SEARCH_LIMIT).len(), 2);
        assert!(store.search("   ", SEARCH_LIMIT).is_empty());
        assert!(
            store.search("\"", SEARCH_LIMIT).is_empty(),
            "nothing left to search for"
        );
        assert_eq!(
            store.search("it's \"booked\"", SEARCH_LIMIT).len(),
            0,
            "its booked: no such words together"
        );
        assert_eq!(
            store.search("\"hotel\" 'is'", SEARCH_LIMIT).len(),
            1,
            "quotes are taken out"
        );
    }

    #[test]
    fn a_stored_time_is_read_as_utc() {
        assert_eq!(stored_utc_ms("2026-11-12 08:30:00"), Some(1_794_472_200_000));
        assert_eq!(stored_utc_ms("2026-11-12T08:30:00.123"), Some(1_794_472_200_123));
        // What `new Date(text + "Z")` could not read.
        assert_eq!(stored_utc_ms("2026-11-12T08:30:00Z"), None);
        assert_eq!(stored_utc_ms("yesterday"), None);
        assert_eq!(strip_speaker("[tg_user]:  hi"), "hi");
        assert_eq!(strip_speaker("[]: hi"), "[]: hi");
        assert_eq!(strip_speaker("[a] hi"), "[a] hi");
        assert_eq!(strip_speaker("no [a]: hi"), "no [a]: hi");
    }
}
