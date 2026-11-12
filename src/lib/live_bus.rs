//! Port of `src/lib/live-bus.js`: the live bus, the single timeline behind the realtime dashboard.
//!
//! Every channel (web, Telegram, Discord, WhatsApp, email, crons) ends up here:
//!   - "message"     a persisted user/assistant message (`ConversationStore::add_message`)
//!   - "turn_queued" a message came in while a turn of its conversation was running: this turn waits behind it
//!     (lib/conversation_lock.rs); same turn id as its turn_start later, or its turn_end if it never begins
//!   - "turn_start"  the agent starts working on a conversation (provider)
//!   - "step"        a live step inside a turn: tool_start / tool_end / text / thinking / status, and "usage" (the
//!     turn's tokens so far and its speed, every few seconds), read from the engine's messages as they arrive
//!     (lib/tool_steps.rs)
//!   - "turn_end"    the turn finished, failed or was stopped (provider)
//!
//! Each event is written to `conversation_events` with a sequence number that is never reused, then pushed to
//! in-process subscribers (the WebSocket hub). A device that reconnects asks for "everything after seq N" and is
//! exactly in sync again, even across a daemon restart. That is what the old in-memory gateway buffer could not do
//! (it emptied on restart and its ids restarted at 1).
//!
//! The JS kept the bus in module-level variables (`initLiveBus(db)`). Here it is a service of the [`App`]:
//! [`LiveBus::init`] makes it, [`LiveBus::of`] finds it. The functions at the bottom of this file carry the JS names
//! and take the app; like the JS ones they do nothing (and answer with nothing) when the bus was never started.
//!
//! **Listeners** ([`LiveBus::on_event`]) are called one event at a time, in sequence order, on the thread of
//! whichever publisher is delivering; a listener sees every event and a slow one holds the others up, as with the
//! JS `EventEmitter`. No lock of the bus or of the database is held while a listener runs, so a listener may
//! publish or read the database itself (what it publishes is delivered after the event in hand).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::app::App;
use crate::db::Db;
use crate::lib::message_tools::strip_tool_markup;
use crate::lib::tool_steps::{js_number, js_string, js_trim, parse_json_lossy};
use crate::util::js::{now_ms, truthy, utf16_len, utf16_truncate};

/// cap any single string in a step payload
const MAX_STRING: usize = 8_000;
/// a message event carries the full clean text up to this
const MAX_MESSAGE_CHARS: usize = 200_000;
const RETENTION_DAYS: f64 = 14.0;
const EVENT_COLUMNS: &str = "seq, conversation_id, turn_id, type, payload, created_at";

/// One event of the timeline, as subscribers and the browser get it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEvent {
    pub seq: i64,
    pub conversation_id: String,
    pub turn_id: Option<String>,
    pub r#type: String,
    pub payload: Value,
    pub created_at: i64,
}

/// The turn currently running in a conversation ([`LiveBus::active_turn_for`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTurn {
    pub conversation_id: String,
    pub turn_id: Option<String>,
    pub started_at: i64,
    /// Where the turn came from ("web", "telegram", ...), or null.
    pub source: Value,
    pub steps: u64,
    pub last_step_at: i64,
    /// "Read: README.md": the latest tool to start. Null until one has; absent when that tool had no name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_step_label: Option<Value>,
    pub running_tools: Vec<RunningTool>,
}

/// A tool that started and has not ended. `id`, `name` and `summary` are the step's own; each is absent when the
/// step had none.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTool {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<Value>,
    pub started_at: i64,
}

/// A turn waiting behind a running one ([`LiveBus::queued_turn_list`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurnEntry {
    pub conversation_id: String,
    pub turn_id: Option<String>,
    pub queued_at: i64,
    pub source: Value,
}

/// A saved message, as [`LiveBus::publish_message`] takes it.
#[derive(Debug, Clone, Copy)]
pub struct TimelineMessage<'a> {
    pub id: &'a str,
    pub role: &'a str,
    pub content: &'a str,
}

type Listener = Arc<dyn Fn(&LiveEvent) + Send + Sync>;

#[derive(Default)]
struct Listeners {
    next_id: AtomicU64,
    list: Mutex<Vec<(u64, Listener)>>,
}

/// What [`LiveBus::on_event`] returns: call [`off`](Self::off) to stop listening (the function the JS `onEvent`
/// returned). Dropping it does **not** stop the listener.
pub struct Subscription {
    listeners: Weak<Listeners>,
    id: u64,
}

impl Subscription {
    /// Stops the listener. An event being delivered right now may still reach it once.
    pub fn off(self) {
        if let Some(listeners) = self.listeners.upgrade() {
            listeners.list.lock().retain(|(id, _)| *id != self.id);
        }
    }
}

struct ActiveState {
    turn_id: Option<String>,
    started_at: i64,
    source: Value,
    steps: u64,
    /// tool id -> the tool, in the order they started
    running_tools: Vec<(Option<Value>, RunningTool)>,
    last_step_at: i64,
    last_step_label: Option<Value>,
}

struct QueuedState {
    turn_id: Option<String>,
    queued_at: i64,
    source: Value,
}

/// Both maps keep the order things were added in, as the JS `Map`s did: the snapshots list them in that order.
#[derive(Default)]
struct Turns {
    /// convId -> the turn running in it
    active: Vec<(String, ActiveState)>,
    /// convId -> the turns waiting behind the running one, oldest first
    queued: Vec<(String, Vec<QueuedState>)>,
}

impl Turns {
    fn unqueue(&mut self, conv_id: &str, turn_id: &Option<String>) {
        let Some(at) = self.queued.iter().position(|(id, _)| id == conv_id) else {
            return;
        };
        self.queued[at].1.retain(|q| q.turn_id != *turn_id);
        if self.queued[at].1.is_empty() {
            self.queued.remove(at);
        }
    }

    fn track(&mut self, evt: &LiveEvent) {
        let id = evt.conversation_id.as_str();
        let source = || {
            evt.payload
                .get("source")
                .filter(|s| truthy(s))
                .cloned()
                .unwrap_or(Value::Null)
        };
        match evt.r#type.as_str() {
            "turn_queued" => {
                let entry = QueuedState {
                    turn_id: evt.turn_id.clone(),
                    queued_at: evt.created_at,
                    source: source(),
                };
                let at = match self.queued.iter().position(|(conv, _)| conv == id) {
                    Some(at) => at,
                    None => {
                        self.queued.push((id.to_string(), Vec::new()));
                        self.queued.len() - 1
                    }
                };
                let queue = &mut self.queued[at].1;
                match queue.iter_mut().find(|q| q.turn_id == evt.turn_id) {
                    Some(existing) => *existing = entry,
                    None => queue.push(entry),
                }
            }
            "turn_start" => {
                self.unqueue(id, &evt.turn_id);
                let turn = ActiveState {
                    turn_id: evt.turn_id.clone(),
                    started_at: evt.created_at,
                    source: source(),
                    steps: 0,
                    running_tools: Vec::new(),
                    last_step_at: evt.created_at,
                    last_step_label: Some(Value::Null),
                };
                match self.active.iter_mut().find(|(conv, _)| conv == id) {
                    Some(existing) => existing.1 = turn,
                    None => self.active.push((id.to_string(), turn)),
                }
            }
            "step" => {
                let Some((_, t)) = self.active.iter_mut().find(|(conv, _)| conv == id) else {
                    return;
                };
                // (A step of another turn, one that overlapped this one, is not this turn's.)
                if evt.turn_id.as_deref().is_some_and(|turn| !turn.is_empty()) && t.turn_id != evt.turn_id {
                    return;
                }
                let p = &evt.payload;
                let kind = p.get("kind").and_then(Value::as_str);
                // "usage" is the tokens so far, not a step; "route" is another AI answering from here on (the
                // backup), not a step either.
                if matches!(kind, Some("usage" | "route")) {
                    return;
                }
                t.steps += 1;
                t.last_step_at = evt.created_at;
                let tool_id = p.get("id").cloned();
                if kind == Some("tool_start") {
                    let tool = RunningTool {
                        id: tool_id.clone(),
                        name: p.get("name").cloned(),
                        summary: p.get("summary").cloned(),
                        started_at: evt.created_at,
                    };
                    t.last_step_label = match p.get("summary").filter(|s| truthy(s)) {
                        Some(summary) => {
                            let name = p.get("name").map(js_string).unwrap_or_else(|| "undefined".to_string());
                            Some(json!(format!("{name}: {}", js_string(summary))))
                        }
                        None => p.get("name").cloned(),
                    };
                    match t.running_tools.iter_mut().find(|(key, _)| *key == tool_id) {
                        Some(existing) => existing.1 = tool,
                        None => t.running_tools.push((tool_id, tool)),
                    }
                } else if kind == Some("tool_end") {
                    t.running_tools.retain(|(key, _)| *key != tool_id);
                }
            }
            "turn_end" => {
                self.unqueue(id, &evt.turn_id);
                // Only the turn that ended: when two overlap in one conversation, the first one's end must not
                // make the one still running look finished.
                let ended = evt.turn_id.as_deref().filter(|turn| !turn.is_empty());
                self.active
                    .retain(|(conv, t)| !(conv == id && (ended.is_none() || t.turn_id.as_deref() == ended)));
            }
            _ => {}
        }
    }

    fn view(conversation_id: &str, t: &ActiveState) -> ActiveTurn {
        ActiveTurn {
            conversation_id: conversation_id.to_string(),
            turn_id: t.turn_id.clone(),
            started_at: t.started_at,
            source: t.source.clone(),
            steps: t.steps,
            last_step_at: t.last_step_at,
            last_step_label: t.last_step_label.clone(),
            running_tools: t.running_tools.iter().map(|(_, tool)| tool.clone()).collect(),
        }
    }
}

/// The live timeline of one app.
pub struct LiveBus {
    db: Db,
    retention_days: f64,
    turns: Mutex<Turns>,
    listeners: Arc<Listeners>,
    /// Events written and not yet handed to the listeners, in sequence order.
    outbox: Mutex<VecDeque<LiveEvent>>,
    /// Held by the one thread that is handing events to the listeners.
    delivering: Mutex<()>,
    prune_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl LiveBus {
    /// Starts the live bus and stores it in the app (`initLiveBus(db)`): old events are pruned now and every hour,
    /// and turns a restart left open are closed.
    pub fn init(app: &App) -> Arc<LiveBus> {
        let retention_days = app
            .env()
            .get("TARSEE_EVENT_RETENTION_DAYS")
            .map(|days| js_number(&Value::String(days)))
            .filter(|days| days.is_finite() && *days != 0.0)
            .unwrap_or(RETENTION_DAYS);
        let bus = app.set(LiveBus::new(app.db().clone(), retention_days));
        bus.start();
        bus
    }

    /// The app's live bus. Panics if `init` was never called.
    pub fn of(app: &App) -> Arc<LiveBus> {
        app.expect::<LiveBus>()
    }

    /// A bus over `db` that keeps events for `retention_days`. It does nothing until [`start`](Self::start).
    pub fn new(db: Db, retention_days: f64) -> LiveBus {
        LiveBus {
            db,
            retention_days,
            turns: Mutex::new(Turns::default()),
            listeners: Arc::new(Listeners::default()),
            outbox: Mutex::new(VecDeque::new()),
            delivering: Mutex::new(()),
            prune_task: Mutex::new(None),
        }
    }

    /// What `initLiveBus` did after preparing its statements.
    fn start(self: &Arc<Self>) {
        // Prune old events hourly. Messages themselves live in `messages`; this is only the live timeline, so two
        // weeks is plenty for catch-up.
        self.prune();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let bus = Arc::downgrade(self);
            let task = runtime.spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(60 * 60)).await;
                    let Some(bus) = bus.upgrade() else { return };
                    bus.prune();
                }
            });
            if let Some(old) = self.prune_task.lock().replace(task) {
                old.abort();
            }
        }

        // A restart kills any turn in flight. Close turns that started but never ended, so no device shows the
        // agent "working" forever on a dead turn. (A turn still waiting in the queue too: its "Queued" line must
        // not wait forever either.)
        let open = self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.conversation_id, s.turn_id FROM conversation_events s
                 WHERE s.type IN ('turn_start', 'turn_queued') AND s.created_at > ?
                   AND NOT EXISTS (SELECT 1 FROM conversation_events e
                                   WHERE e.type = 'turn_end' AND e.turn_id = s.turn_id)
                 GROUP BY s.turn_id",
            )?;
            let rows = stmt.query_map([now_ms() - 2 * 86_400_000], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        match open {
            Some(Ok(open)) => {
                for (conversation_id, turn_id) in &open {
                    self.publish(
                        conversation_id,
                        "turn_end",
                        json!({ "stopReason": "interrupted", "note": "Tarsee restarted during this turn" }),
                        turn_id.as_deref(),
                    );
                }
                if !open.is_empty() {
                    log::info!("[live-bus] closed {} turn(s) left open by a restart", open.len());
                }
            }
            Some(Err(err)) => log::warn!("[live-bus] open-turn cleanup failed: {err}"),
            None => {}
        }
    }

    /// Ends the hourly pruning (for shutdown). The JS interval had no stop: it ended with the process.
    pub fn stop(&self) {
        if let Some(task) = self.prune_task.lock().take() {
            task.abort();
        }
    }

    /// Removes events older than the retention time. Runs at start and every hour.
    pub fn prune(&self) {
        let cutoff = now_ms() as f64 - self.retention_days * 86_400_000.0;
        let done = self.read(|conn| {
            conn.prepare_cached("DELETE FROM conversation_events WHERE created_at < ?")?
                .execute([cutoff])
        });
        if let Some(Err(err)) = done {
            log::warn!("[live-bus] prune failed: {err}");
        }
    }

    /// Runs `f` on the database, or not at all once the database is closed (shutdown): the JS statements threw
    /// then, and every caller here already treated a throw as "nothing".
    fn read<R>(&self, f: impl FnOnce(&rusqlite::Connection) -> R) -> Option<R> {
        if !self.db.is_open() {
            return None;
        }
        Some(self.db.with(f))
    }

    /// Writes one event and queues it for the listeners. `track`: it counts for the turns in progress.
    fn append(
        &self,
        conversation_id: &str,
        turn_id: Option<&str>,
        event_type: &str,
        payload: Value,
        track: bool,
    ) -> anyhow::Result<LiveEvent> {
        let created_at = now_ms();
        let text = payload.to_string();
        // The insert, the bookkeeping and the place in the queue happen under the database's own lock, so two
        // publishers can never hand their events to the listeners out of sequence order.
        let written = self.read(|conn| -> rusqlite::Result<LiveEvent> {
            conn.prepare_cached(
                "INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            )?
            .execute(params![conversation_id, turn_id, event_type, text, created_at])?;
            let evt = LiveEvent {
                seq: conn.last_insert_rowid(),
                conversation_id: conversation_id.to_string(),
                turn_id: turn_id.map(String::from),
                r#type: event_type.to_string(),
                payload,
                created_at,
            };
            if track {
                self.turns.lock().track(&evt);
            }
            self.outbox.lock().push_back(evt.clone());
            Ok(evt)
        });
        let Some(written) = written else {
            anyhow::bail!("The database connection is not open");
        };
        let evt = written?;
        self.deliver();
        Ok(evt)
    }

    /// Hands every queued event to the listeners, oldest first. One thread does this at a time; an event queued
    /// meanwhile (by another thread, or by a listener) is delivered by that thread before it returns.
    fn deliver(&self) {
        loop {
            {
                let Some(_delivering) = self.delivering.try_lock() else {
                    return;
                };
                loop {
                    let next = self.outbox.lock().pop_front();
                    let Some(evt) = next else { break };
                    let listeners: Vec<Listener> = self.listeners.list.lock().iter().map(|(_, l)| l.clone()).collect();
                    for listener in listeners {
                        listener(&evt);
                    }
                }
            }
            // An event queued between the last look and letting go would otherwise wait for the next publish.
            if self.outbox.lock().is_empty() {
                return;
            }
        }
    }

    /// Append an event to the timeline and push it to subscribers. Never fails: the live view is best-effort and
    /// must not break a turn. `None` when there is no conversation id or type, or the write failed.
    pub fn publish(
        &self,
        conversation_id: &str,
        event_type: &str,
        payload: Value,
        turn_id: Option<&str>,
    ) -> Option<LiveEvent> {
        if conversation_id.is_empty() || event_type.is_empty() {
            return None;
        }
        let clean = cap_strings(payload, 0);
        match self.append(conversation_id, turn_id, event_type, clean, true) {
            Ok(evt) => Some(evt),
            Err(err) => {
                log::warn!("[live-bus] publish {event_type} failed: {err}");
                None
            }
        }
    }

    /// Publish a persisted message. Tool-call JSON is stripped: it belongs to steps. `extra` is added to the
    /// payload (the sending tab's `clientMsgId`); its `turnId`, when it has one, is the event's turn.
    pub fn publish_message(
        &self,
        conversation_id: &str,
        message: TimelineMessage<'_>,
        extra: &Map<String, Value>,
    ) -> Option<LiveEvent> {
        let tidy = tidy_message_text(message.content);
        let mut content = js_trim(&tidy).to_string();
        let truncated = utf16_len(&content) > MAX_MESSAGE_CHARS;
        if truncated {
            content = utf16_truncate(&content, MAX_MESSAGE_CHARS);
        }
        // Bypass the per-string cap: a message carries its full clean text.
        if conversation_id.is_empty() {
            return None;
        }
        let mut payload = Map::new();
        payload.insert("id".into(), json!(message.id));
        payload.insert("role".into(), json!(message.role));
        payload.insert("content".into(), json!(content));
        payload.insert("truncated".into(), json!(truncated));
        for (key, value) in extra {
            payload.insert(key.clone(), value.clone());
        }
        let turn_id = extra.get("turnId").filter(|t| truthy(t)).map(js_string);
        match self.append(
            conversation_id,
            turn_id.as_deref(),
            "message",
            Value::Object(payload),
            false,
        ) {
            Ok(evt) => Some(evt),
            Err(err) => {
                log::warn!("[live-bus] publishMessage failed: {err}");
                None
            }
        }
    }

    /// Calls `listener` with every event from now on, in sequence order (`onEvent(fn)`). See the module notes for
    /// what a listener may do. Keep the returned [`Subscription`] to stop it.
    pub fn on_event(&self, listener: impl Fn(&LiveEvent) + Send + Sync + 'static) -> Subscription {
        let id = self.listeners.next_id.fetch_add(1, Ordering::Relaxed);
        self.listeners.list.lock().push((id, Arc::new(listener)));
        Subscription {
            listeners: Arc::downgrade(&self.listeners),
            id,
        }
    }

    /// Every event from now on as a channel, for a listener that is an async task. Nothing is ever dropped: the
    /// channel grows while the task is behind. Dropping the receiver ends the subscription.
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<LiveEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let listeners = Arc::downgrade(&self.listeners);
        let id = self.listeners.next_id.fetch_add(1, Ordering::Relaxed);
        let listener = move |evt: &LiveEvent| {
            if tx.send(evt.clone()).is_err()
                && let Some(listeners) = listeners.upgrade()
            {
                listeners.list.lock().retain(|(other, _)| *other != id);
            }
        };
        self.listeners.list.lock().push((id, Arc::new(listener)));
        rx
    }

    fn events(&self, sql: &str, params: impl rusqlite::Params) -> Vec<LiveEvent> {
        let rows = self.read(|conn| {
            let mut stmt = conn.prepare_cached(sql)?;
            let rows = stmt.query_map(params, row_to_event)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        match rows {
            Some(Ok(events)) => events,
            Some(Err(err)) => {
                log::warn!("[live-bus] reading events failed: {err}");
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    /// Events for one conversation after `since_seq` (oldest first). The JS defaults: since 0, limit 500.
    pub fn events_since(&self, conversation_id: &str, since_seq: i64, limit: i64) -> Vec<LiveEvent> {
        self.events(
            &format!(
                "SELECT {EVENT_COLUMNS} FROM conversation_events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
            ),
            params![conversation_id, since_seq, limit],
        )
    }

    /// The most recent `limit` events for a conversation (oldest first). The JS default: 200.
    pub fn recent_events(&self, conversation_id: &str, limit: i64) -> Vec<LiveEvent> {
        let mut events = self.events(
            &format!(
                "SELECT {EVENT_COLUMNS} FROM conversation_events WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?"
            ),
            params![conversation_id, limit],
        );
        events.reverse();
        events
    }

    /// The latest sequence number: of one conversation, or (`None`) of them all. 0 when there are no events.
    pub fn latest_seq(&self, conversation_id: Option<&str>) -> i64 {
        let seq = self.read(|conn| match conversation_id.filter(|id| !id.is_empty()) {
            Some(id) => conn.query_row(
                "SELECT COALESCE(MAX(seq), 0) AS seq FROM conversation_events WHERE conversation_id = ?",
                [id],
                |row| row.get::<_, i64>(0),
            ),
            None => conn.query_row(
                "SELECT COALESCE(MAX(seq), 0) AS seq FROM conversation_events",
                [],
                |row| row.get::<_, i64>(0),
            ),
        });
        match seq {
            Some(Ok(seq)) => seq,
            _ => 0,
        }
    }

    /// All events of one turn, oldest first (to rebuild a turn in progress).
    pub fn events_for_turn(&self, turn_id: &str) -> Vec<LiveEvent> {
        if turn_id.is_empty() {
            return Vec::new();
        }
        self.events(
            &format!("SELECT {EVENT_COLUMNS} FROM conversation_events WHERE turn_id = ? ORDER BY seq ASC LIMIT 1000"),
            [turn_id],
        )
    }

    /// The turn currently running in a conversation, if any.
    pub fn active_turn_for(&self, conversation_id: &str) -> Option<ActiveTurn> {
        let turns = self.turns.lock();
        turns
            .active
            .iter()
            .find(|(conv, _)| conv == conversation_id)
            .map(|(conv, t)| Turns::view(conv, t))
    }

    /// Snapshot of turns in progress right now (for "working" indicators).
    pub fn active_turn_list(&self) -> Vec<ActiveTurn> {
        let turns = self.turns.lock();
        turns.active.iter().map(|(conv, t)| Turns::view(conv, t)).collect()
    }

    /// clientMsgIds of user messages that reached the server recently. A device that reloads with unconfirmed
    /// sends in storage uses this to tell "it landed" from "it never arrived" (and only offers Retry for the
    /// latter). Newest first. The JS default for `since_ms`: 24 hours.
    pub fn recent_client_msg_ids(&self, conversation_id: &str, since_ms: i64) -> Vec<Value> {
        if conversation_id.is_empty() {
            return Vec::new();
        }
        let ids = self.read(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT json_extract(payload, '$.clientMsgId') AS c FROM conversation_events WHERE conversation_id = ? AND type = 'message' AND created_at > ? AND json_extract(payload, '$.clientMsgId') IS NOT NULL ORDER BY seq DESC LIMIT 200",
            )?;
            let rows = stmt.query_map(params![conversation_id, now_ms() - since_ms], |row| {
                Ok(crate::db::json_from_sql(row.get_ref(0)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        match ids {
            Some(Ok(ids)) => ids,
            _ => Vec::new(),
        }
    }

    /// Turns waiting behind a running one right now, oldest first: of one conversation, or (`None`) of them all.
    pub fn queued_turn_list(&self, conversation_id: Option<&str>) -> Vec<QueuedTurnEntry> {
        let only = conversation_id.filter(|id| !id.is_empty());
        let turns = self.turns.lock();
        let mut out = Vec::new();
        for (conv, queue) in &turns.queued {
            if only.is_some_and(|id| id != conv) {
                continue;
            }
            for t in queue {
                out.push(QueuedTurnEntry {
                    conversation_id: conv.clone(),
                    turn_id: t.turn_id.clone(),
                    queued_at: t.queued_at,
                    source: t.source.clone(),
                });
            }
        }
        out
    }

    fn delete(&self, sql: &str, params: impl rusqlite::Params) -> usize {
        match self.read(|conn| conn.prepare_cached(sql)?.execute(params)) {
            Some(Ok(changes)) => changes,
            _ => 0,
        }
    }

    /// A deleted or cleared conversation's timeline goes with it: the events carry the messages' full text, and
    /// would otherwise stay readable for two weeks. Returns how many events went.
    pub fn forget_conversation(&self, conversation_id: &str) -> usize {
        if conversation_id.is_empty() {
            return 0;
        }
        self.delete(
            "DELETE FROM conversation_events WHERE conversation_id = ?",
            [conversation_id],
        )
    }

    /// A deleted message's event goes with it.
    pub fn forget_message(&self, conversation_id: &str, message_id: &str) -> usize {
        if conversation_id.is_empty() || message_id.is_empty() {
            return 0;
        }
        self.delete(
            "DELETE FROM conversation_events WHERE conversation_id = ? AND type = 'message' AND json_extract(payload, '$.id') = ?",
            [conversation_id, message_id],
        )
    }

    /// True when this clientMsgId was already saved in the conversation (retry dedupe).
    pub fn has_client_msg_id(&self, conversation_id: &str, client_msg_id: &str) -> bool {
        if conversation_id.is_empty() || client_msg_id.is_empty() {
            return false;
        }
        let found = self.read(|conn| {
            conn.prepare_cached(
                "SELECT 1 FROM conversation_events WHERE conversation_id = ? AND type = 'message' AND json_extract(payload, '$.clientMsgId') = ? LIMIT 1",
            )?
            .exists([conversation_id, client_msg_id])
        });
        matches!(found, Some(Ok(true)))
    }
}

impl Drop for LiveBus {
    fn drop(&mut self) {
        self.stop();
    }
}

fn cap_strings(value: Value, depth: usize) -> Value {
    match value {
        Value::String(s) if utf16_len(&s) > MAX_STRING => Value::String(format!("{}…", utf16_truncate(&s, MAX_STRING))),
        Value::Array(items) if depth <= 4 => {
            Value::Array(items.into_iter().take(50).map(|v| cap_strings(v, depth + 1)).collect())
        }
        Value::Object(map) if depth <= 4 => {
            Value::Object(map.into_iter().map(|(k, v)| (k, cap_strings(v, depth + 1))).collect())
        }
        other => other,
    }
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<LiveEvent> {
    let payload: String = row.get(4)?;
    Ok(LiveEvent {
        seq: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        r#type: row.get(3)?,
        // (An unreadable payload is kept as {}.)
        payload: parse_json_lossy(&payload).unwrap_or_else(|| json!({})),
        created_at: row.get(5)?,
    })
}

// ── The JS module's exports, by their names ──────────────────────────────────────────────────────────────────────
// Each takes the app and, like the JS function before `initLiveBus` was called, does nothing when the app has no
// live bus (a test that never started one).

/// Starts the app's live bus: [`LiveBus::init`].
pub fn init_live_bus(app: &App) -> Arc<LiveBus> {
    LiveBus::init(app)
}

pub fn new_turn_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// [`LiveBus::publish`] on the app's bus.
pub fn publish(
    app: &App,
    conversation_id: &str,
    event_type: &str,
    payload: Value,
    turn_id: Option<&str>,
) -> Option<LiveEvent> {
    app.get::<LiveBus>()?
        .publish(conversation_id, event_type, payload, turn_id)
}

/// A message's words as its timeline event keeps them, before the ends are trimmed: tool-call JSON stripped (it
/// belongs to steps), no runs of blank lines. [replies] db/conversations.rs counts where a reply's own words start
/// in the same words.
pub fn tidy_message_text(text: &str) -> String {
    strip_tool_markup(text)
}

/// [`LiveBus::publish_message`] on the app's bus.
pub fn publish_message(
    app: &App,
    conversation_id: &str,
    message: TimelineMessage<'_>,
    extra: &Map<String, Value>,
) -> Option<LiveEvent> {
    app.get::<LiveBus>()?.publish_message(conversation_id, message, extra)
}

/// [`LiveBus::on_event`] on the app's bus. Panics if the bus was never started: a listener that silently heard
/// nothing would be a wiring mistake nobody sees. (The JS emitter existed before `initLiveBus`; here the bus must
/// be started first.)
pub fn on_event(app: &App, listener: impl Fn(&LiveEvent) + Send + Sync + 'static) -> Subscription {
    LiveBus::of(app).on_event(listener)
}

/// Events for one conversation after `since_seq` (oldest first).
pub fn events_since(app: &App, conversation_id: &str, since_seq: i64, limit: i64) -> Vec<LiveEvent> {
    app.get::<LiveBus>()
        .map(|bus| bus.events_since(conversation_id, since_seq, limit))
        .unwrap_or_default()
}

/// The most recent `limit` events for a conversation (oldest first).
pub fn recent_events(app: &App, conversation_id: &str, limit: i64) -> Vec<LiveEvent> {
    app.get::<LiveBus>()
        .map(|bus| bus.recent_events(conversation_id, limit))
        .unwrap_or_default()
}

pub fn latest_seq(app: &App, conversation_id: Option<&str>) -> i64 {
    app.get::<LiveBus>()
        .map(|bus| bus.latest_seq(conversation_id))
        .unwrap_or(0)
}

/// All events of one turn, oldest first (to rebuild a turn in progress).
pub fn events_for_turn(app: &App, turn_id: &str) -> Vec<LiveEvent> {
    app.get::<LiveBus>()
        .map(|bus| bus.events_for_turn(turn_id))
        .unwrap_or_default()
}

/// The turn currently running in a conversation, if any.
pub fn active_turn_for(app: &App, conversation_id: &str) -> Option<ActiveTurn> {
    app.get::<LiveBus>()?.active_turn_for(conversation_id)
}

/// Snapshot of turns in progress right now (for "working" indicators).
pub fn active_turn_list(app: &App) -> Vec<ActiveTurn> {
    app.get::<LiveBus>()
        .map(|bus| bus.active_turn_list())
        .unwrap_or_default()
}

pub fn recent_client_msg_ids(app: &App, conversation_id: &str, since_ms: i64) -> Vec<Value> {
    app.get::<LiveBus>()
        .map(|bus| bus.recent_client_msg_ids(conversation_id, since_ms))
        .unwrap_or_default()
}

/// Turns waiting behind a running one right now, oldest first.
pub fn queued_turn_list(app: &App, conversation_id: Option<&str>) -> Vec<QueuedTurnEntry> {
    app.get::<LiveBus>()
        .map(|bus| bus.queued_turn_list(conversation_id))
        .unwrap_or_default()
}

pub fn forget_conversation(app: &App, conversation_id: &str) -> usize {
    app.get::<LiveBus>()
        .map(|bus| bus.forget_conversation(conversation_id))
        .unwrap_or(0)
}

pub fn forget_message(app: &App, conversation_id: &str, message_id: &str) -> usize {
    app.get::<LiveBus>()
        .map(|bus| bus.forget_message(conversation_id, message_id))
        .unwrap_or(0)
}

/// True when this clientMsgId was already saved in the conversation (retry dedupe).
pub fn has_client_msg_id(app: &App, conversation_id: &str, client_msg_id: &str) -> bool {
    app.get::<LiveBus>()
        .is_some_and(|bus| bus.has_client_msg_id(conversation_id, client_msg_id))
}

/// The JS default of `recentClientMsgIds`' `sinceMs`.
pub const CLIENT_MSG_IDS_SINCE_MS: i64 = 24 * 3_600_000;

#[cfg(test)]
mod tests;
