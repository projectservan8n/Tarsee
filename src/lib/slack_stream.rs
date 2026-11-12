//! Port of `src/lib/slack-stream.js`: one reply, written into a Slack thread as the model produces it.
//!
//! Native (the default): Slack's streaming API (chat.startStream / appendStream / stopStream, 2025-10). Text arrives
//! as markdown chunks and each tool shows as a task card (task_update chunks, 2026-02) that turns complete or error,
//! in one message. Slack caps one stream at 12,000 characters of markdown, 50 tasks and 10 minutes from its start,
//! so a long turn rolls over to a new message in the same thread: the old one is stopped with session_status
//! "processing" (the turn is still going), an open code fence is closed there and opened again in the next message,
//! and tools still running are carried over as running.
//!
//! Editing (the fallback): when Slack refuses native streaming (a workspace or plan without it), the reply is posted
//! and then edited with markdown_text, the way the Discord channel does it: one message per stretch of text, a
//! "⚙️ Running…" line per tool that is edited to "✓ …" when it finishes.
//!
//! Every Slack call goes through one queue, so text, tool cards and the rollover clock never race each other. Here
//! the queue is an async mutex, which hands itself out in the order it was asked for. Nothing here fails to the
//! caller: a failed call is logged, and the reply carries on as best it can.
//!
//! Lengths are counted in UTF-16 units, as Slack and the Node code count them. Where a cut by length would land
//! inside a character (an emoji), it is made before that character instead, so no message carries half an emoji.

use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::Mutex as Queue;
use tokio::task::AbortHandle;

use crate::lib::discord_format::js_text::trim;
use crate::lib::slack_format::{SLACK_MAX_MARKDOWN, close_fence, open_fence};
use crate::util::js::{now_ms, utf16_len};

/// An error from a Slack Web API call. `code` is Slack's own error code when Slack answered `{ ok: false, error }`
/// ("ratelimited", "feature_disabled"...), else `None` (the connection failed, the answer was not JSON...).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SlackApiError {
    pub code: Option<String>,
    pub message: String,
}

impl SlackApiError {
    /// The error for Slack's `{ ok: false, error: code }`, worded as @slack/web-api words it.
    pub fn platform(code: impl Into<String>) -> Self {
        let code = code.into();
        SlackApiError {
            message: format!("An API error occurred: {code}"),
            code: Some(code),
        }
    }

    /// Any other failure: no Slack code.
    pub fn other(message: impl Into<String>) -> Self {
        SlackApiError {
            code: None,
            message: message.into(),
        }
    }

    /// Slack's error code, or `None` (an empty code counts as none, as `err?.data?.error || null` did).
    pub fn code(&self) -> Option<&str> {
        self.code.as_deref().filter(|c| !c.is_empty())
    }
}

/// Slack's error code on an error a Slack call returned ("ratelimited", "feature_disabled"...), or `None`: for a
/// [`SlackApiError`] (or one wrapped as the error's own source), its [`code`](SlackApiError::code).
pub fn slack_error_code<'a>(err: &'a (dyn std::error::Error + 'static)) -> Option<&'a str> {
    err.downcast_ref::<SlackApiError>().and_then(SlackApiError::code)
}

/// The Slack Web API calls a reply stream makes, each with its arguments and answer as JSON (Slack's field names).
/// Package H2 implements it over HTTP; tests implement it with a recorder.
#[async_trait]
pub trait SlackClient: Send + Sync {
    /// chat.startStream: answers with the new message's `ts`.
    async fn start_stream(&self, args: Value) -> Result<Value, SlackApiError>;
    /// chat.appendStream
    async fn append_stream(&self, args: Value) -> Result<Value, SlackApiError>;
    /// chat.stopStream
    async fn stop_stream(&self, args: Value) -> Result<Value, SlackApiError>;
    /// chat.postMessage: answers with the message's `ts`.
    async fn post_message(&self, args: Value) -> Result<Value, SlackApiError>;
    /// chat.update
    async fn update(&self, args: Value) -> Result<Value, SlackApiError>;
    /// agents.sessions.setStatus. The default does nothing, for a client without agent features (the Node code
    /// called it only when the client had it).
    async fn set_agent_session_status(&self, args: Value) -> Result<Value, SlackApiError> {
        let _ = args;
        Ok(Value::Null)
    }
}

/// Errors meaning native streaming will not work for this app or workspace: stop trying it until a restart.
const NATIVE_UNAVAILABLE: [&str; 9] = [
    "feature_disabled",
    "unknown_method",
    "method_deprecated",
    "not_allowed_token_type",
    "missing_scope",
    "team_not_allowed",
    "access_denied",
    "paid_only",
    "paid_teams_only",
];

/// How a reply reaches Slack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamMode {
    /// Slack's streaming API.
    Native,
    /// Posting and editing messages.
    Edit,
}

impl StreamMode {
    /// The Node value: "native" or "edit".
    pub fn as_str(self) -> &'static str {
        match self {
            StreamMode::Native => "native",
            StreamMode::Edit => "edit",
        }
    }
}

/// The current time in milliseconds (`Date.now` by default; tests pass their own clock).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Called once when the person presses stop on the streamed message.
pub type StoppedHandler = Arc<dyn Fn() + Send + Sync>;

/// Called with Slack's code when native streaming will never work in this workspace.
pub type NativeUnavailableHandler = Arc<dyn Fn(&str) + Send + Sync>;

/// Everything a [`SlackReplyStream`] is made with. [`SlackReplyStreamOptions::new`] fills in the Node defaults.
pub struct SlackReplyStreamOptions {
    pub client: Arc<dyn SlackClient>,
    pub channel: String,
    pub thread_ts: String,
    pub recipient_user_id: Option<String>,
    pub recipient_team_id: Option<String>,
    /// Try Slack's streaming API first (true), or post and edit from the start.
    pub native: bool,
    pub now: Clock,
    /// appendStream is Tier 4; one call a second per reply is well inside it.
    pub flush_interval_ms: i64,
    /// chat.update is Tier 3, shared by every reply in the workspace.
    pub edit_interval_ms: i64,
    /// Slack ends a stream 10 minutes after it starts.
    pub max_stream_ms: i64,
    pub max_stream_chars: usize,
    pub max_stream_tasks: usize,
    pub max_message_chars: usize,
    /// Called once when the person presses stop on the streamed message.
    pub on_stopped_by_user: Option<StoppedHandler>,
    /// Called with Slack's code when native streaming will never work in this workspace.
    pub on_native_unavailable: Option<NativeUnavailableHandler>,
}

impl SlackReplyStreamOptions {
    pub fn new(client: Arc<dyn SlackClient>, channel: impl Into<String>, thread_ts: impl Into<String>) -> Self {
        SlackReplyStreamOptions {
            client,
            channel: channel.into(),
            thread_ts: thread_ts.into(),
            recipient_user_id: None,
            recipient_team_id: None,
            native: true,
            now: Arc::new(now_ms),
            flush_interval_ms: 1000,
            edit_interval_ms: 1500,
            max_stream_ms: 9 * 60_000,
            max_stream_chars: SLACK_MAX_MARKDOWN,
            max_stream_tasks: 48,
            max_message_chars: SLACK_MAX_MARKDOWN,
            on_stopped_by_user: None,
            on_native_unavailable: None,
        }
    }
}

/// A map that keeps insertion order (the JS `Map`): setting a key that is there keeps its place.
#[derive(Default)]
struct OrderedMap(Vec<(String, String)>);

impl OrderedMap {
    fn set(&mut self, key: &str, value: &str) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value.to_string(),
            None => self.0.push((key.to_string(), value.to_string())),
        }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    fn remove(&mut self, key: &str) -> Option<String> {
        let i = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(i).1)
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn clear(&mut self) {
        self.0.clear();
    }
}

/// The native stream being written.
struct NativeStream {
    ts: Option<String>,
    started_at: i64,
    /// UTF-16 units of markdown sent on it.
    chars: i64,
    text: String,
    tasks: HashSet<String>,
}

/// The message the current stretch of text is in (editing).
struct Segment {
    ts: Option<String>,
    shown: String,
}

/// Everything the queue guards.
#[derive(Default)]
struct State {
    /// text not yet sent
    pending: String,
    last_flush_at: i64,
    /// tool id → title, while it runs
    open_tasks: OrderedMap,
    // native
    stream: Option<NativeStream>,
    /// fence to open again at the start of the next stream
    reopen: String,
    /// the last stream stopped mid-turn: show running tools again in the next
    carry_tasks: bool,
    /// the last stop left the agent session "processing"
    ended_mid_turn: bool,
    // editing
    seg: Option<Segment>,
    seg_text: String,
    /// tool id → ts of its status line
    tool_msgs: OrderedMap,
}

struct Inner {
    client: Arc<dyn SlackClient>,
    channel: String,
    thread_ts: String,
    recipient_user_id: Option<String>,
    recipient_team_id: Option<String>,
    now: Clock,
    flush_interval_ms: i64,
    edit_interval_ms: i64,
    max_stream_ms: i64,
    max_stream_chars: i64,
    max_stream_tasks: usize,
    max_message_chars: usize,
    on_stopped_by_user: Option<StoppedHandler>,
    on_native_unavailable: Option<NativeUnavailableHandler>,
    native: AtomicBool,
    sent_text: AtomicBool,
    stopped_by_user: AtomicBool,
    queue: Queue<State>,
    /// The armed flush: its number and the task to stop.
    flush_timer: Mutex<Option<(u64, AbortHandle)>>,
    timers: AtomicU64,
}

/// One reply streaming into a Slack thread. A cheap handle: clone it to call [`tick`](Self::tick) from a timer.
#[derive(Clone)]
pub struct SlackReplyStream {
    inner: Arc<Inner>,
}

impl SlackReplyStream {
    pub fn new(opts: SlackReplyStreamOptions) -> Self {
        SlackReplyStream {
            inner: Arc::new(Inner {
                client: opts.client,
                channel: opts.channel,
                thread_ts: opts.thread_ts,
                recipient_user_id: opts.recipient_user_id,
                recipient_team_id: opts.recipient_team_id,
                now: opts.now,
                flush_interval_ms: opts.flush_interval_ms,
                edit_interval_ms: opts.edit_interval_ms,
                max_stream_ms: opts.max_stream_ms,
                max_stream_chars: opts.max_stream_chars as i64,
                max_stream_tasks: opts.max_stream_tasks,
                max_message_chars: opts.max_message_chars,
                on_stopped_by_user: opts.on_stopped_by_user,
                on_native_unavailable: opts.on_native_unavailable,
                native: AtomicBool::new(opts.native),
                sent_text: AtomicBool::new(false),
                stopped_by_user: AtomicBool::new(false),
                queue: Queue::new(State::default()),
                flush_timer: Mutex::new(None),
                timers: AtomicU64::new(0),
            }),
        }
    }

    /// Native streaming, or editing (once streaming failed, or when it was off from the start).
    pub fn mode(&self) -> StreamMode {
        if self.inner.is_native() {
            StreamMode::Native
        } else {
            StreamMode::Edit
        }
    }

    /// Whether any words reached Slack.
    pub fn sent_text(&self) -> bool {
        self.inner.sent_text.load(Ordering::SeqCst)
    }

    /// Whether the person pressed stop on the streamed message.
    pub fn stopped_by_user(&self) -> bool {
        self.inner.stopped()
    }

    // ── public ────────────────────────────────────────────────────────────────

    /// More of the answer. Sent now if the last send was long enough ago, otherwise with the next one.
    pub async fn text(&self, delta: &str) {
        let mut st = self.inner.queue.lock().await;
        if delta.is_empty() {
            return;
        }
        let inner = &self.inner;
        if inner.stopped() {
            return;
        }
        st.pending.push_str(delta);
        let interval = if inner.is_native() {
            inner.flush_interval_ms
        } else {
            inner.edit_interval_ms
        };
        let wait = interval - ((inner.now)() - st.last_flush_at);
        if wait <= 0 {
            inner.flush(&mut st).await;
        } else {
            // Held text goes out on its own when the interval is up, so the last words before a long pause (the
            // model writing a big tool call) are not stuck waiting for the next event.
            inner.arm_flush(wait);
        }
    }

    /// A tool started: the text so far goes out first, then the tool's card or status line.
    pub async fn tool_start(&self, id: &str, title: &str) {
        let mut st = self.inner.queue.lock().await;
        let inner = &self.inner;
        if inner.stopped() {
            return;
        }
        st.open_tasks.set(id, title);
        if inner.is_native() {
            let result = inner.tool_start_native(&mut st, id, title).await;
            if inner.native_outcome(&mut st, result).await {
                return;
            }
        }
        inner.close_segment(&mut st).await;
        if let Some(ts) = inner.post(&format!("⚙️ _{title}_")).await {
            st.tool_msgs.set(id, &ts);
        }
    }

    /// A tool finished (`ok`: false when it failed).
    pub async fn tool_done(&self, id: &str, title: &str, ok: bool) {
        let mut st = self.inner.queue.lock().await;
        let inner = &self.inner;
        st.open_tasks.remove(id);
        if inner.stopped() {
            return;
        }
        if inner.is_native() {
            let status = if ok { "complete" } else { "error" };
            let result = inner
                .send_native(&mut st, vec![task(id, title, status, None)], true)
                .await;
            if inner.native_outcome(&mut st, result).await {
                return;
            }
        }
        let line = if ok {
            format!("✓ _{title}_")
        } else {
            format!("❌ _{title}_")
        };
        match st.tool_msgs.remove(id) {
            Some(ts) => inner.update(&ts, &line).await,
            None => {
                inner.post(&line).await;
            }
        }
    }

    /// Call every so often: hands a long-running reply over to a new message before Slack's 10-minute stream limit.
    pub async fn tick(&self) {
        let mut st = self.inner.queue.lock().await;
        let inner = &self.inner;
        let Some(stream) = &st.stream else { return };
        if !inner.is_native() || inner.stopped() {
            return;
        }
        if (inner.now)() - stream.started_at < inner.max_stream_ms {
            return;
        }
        let result = inner.tick_native(&mut st).await;
        inner.native_outcome(&mut st, result).await;
    }

    /// The turn is over: send what is left and end the message.
    pub async fn finish(&self) {
        self.inner.disarm_flush();
        let mut st = self.inner.queue.lock().await;
        let inner = &self.inner;
        inner.disarm_flush(); // a text() queued just before this one may have set it
        if inner.is_native() {
            let result = inner.finish_native(&mut st).await;
            if inner.native_outcome(&mut st, result).await {
                return;
            }
        }
        if !inner.stopped() {
            inner.close_segment(&mut st).await;
        }
        // Status lines of tools that never reported back.
        let unfinished = std::mem::take(&mut st.tool_msgs);
        for (id, ts) in &unfinished.0 {
            let title = st
                .open_tasks
                .get(id)
                .filter(|t| !t.is_empty())
                .unwrap_or("Tool")
                .to_string();
            inner.update(ts, &format!("❌ _{title} — did not finish_")).await;
        }
        st.open_tasks.clear();
        // Streamed messages earlier in this reply left the agent session "processing": set it back.
        if st.ended_mid_turn {
            inner.session_active(&mut st).await;
        }
    }
}

/// A markdown chunk.
fn markdown(text: &str) -> Value {
    json!({ "type": "markdown_text", "text": text })
}

/// A task card chunk.
fn task(id: &str, title: &str, status: &str, details: Option<&str>) -> Value {
    let mut chunk = json!({ "type": "task_update", "id": id, "title": title, "status": status });
    if let Some(details) = details {
        chunk["details"] = Value::String(details.to_string());
    }
    chunk
}

fn is_markdown(chunk: &Value) -> bool {
    chunk["type"] == "markdown_text"
}

fn is_task(chunk: &Value) -> bool {
    chunk["type"] == "task_update"
}

/// The backticks of a fence line ("```js" → "```").
fn fence_ticks(fence: &str) -> &str {
    &fence[..fence.len() - fence.trim_start_matches('`').len()]
}

/// `text.lastIndexOf("\n", from)` in UTF-16 units, -1 when there is none.
fn last_newline_at_or_before(text: &str, from: i64) -> i64 {
    let from = from.max(0);
    let mut unit = 0i64;
    let mut found = -1;
    for c in text.chars() {
        if unit > from {
            break;
        }
        if c == '\n' {
            found = unit;
        }
        unit += c.len_utf16() as i64;
    }
    found
}

/// The byte offset in `text` of UTF-16 unit `units`, moved back to the start of a character the cut would split. At
/// least the first character, so a cut always takes something.
fn byte_offset_for_units(text: &str, units: i64) -> usize {
    let mut unit = 0i64;
    for (i, c) in text.char_indices() {
        let next = unit + c.len_utf16() as i64;
        if next > units {
            return if i == 0 { c.len_utf8() } else { i };
        }
        unit = next;
    }
    text.len()
}

impl Inner {
    fn is_native(&self) -> bool {
        self.native.load(Ordering::SeqCst)
    }

    fn stopped(&self) -> bool {
        self.stopped_by_user.load(Ordering::SeqCst)
    }

    fn mark_sent(&self) {
        self.sent_text.store(true, Ordering::SeqCst);
    }

    // ── queue ─────────────────────────────────────────────────────────────────

    fn arm_flush(self: &Arc<Self>, ms: i64) {
        let mut slot = self.flush_timer.lock();
        if slot.is_some() {
            return;
        }
        let number = self.timers.fetch_add(1, Ordering::SeqCst) + 1;
        let me = Arc::clone(self);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms.max(0) as u64)).await;
            {
                // Fired: from here on it is a queued flush, which finishing no longer cancels.
                let mut slot = me.flush_timer.lock();
                if !matches!(&*slot, Some((n, _)) if *n == number) {
                    return;
                }
                *slot = None;
            }
            let mut st = me.queue.lock().await;
            if !me.stopped() {
                me.flush(&mut st).await;
            }
        });
        *slot = Some((number, handle.abort_handle()));
    }

    fn disarm_flush(&self) {
        if let Some((_, handle)) = self.flush_timer.lock().take() {
            handle.abort();
        }
    }

    async fn flush(&self, st: &mut State) {
        if st.pending.is_empty() {
            return;
        }
        if self.is_native() {
            let result = self.send_native(st, Vec::new(), true).await;
            if self.native_outcome(st, result).await {
                return;
            }
        }
        self.flush_edit(st).await;
    }

    // ── native streaming ──────────────────────────────────────────────────────

    async fn tool_start_native(&self, st: &mut State, id: &str, title: &str) -> Result<(), SlackApiError> {
        if let Some(stream) = &st.stream
            && !stream.tasks.contains(id)
            && stream.tasks.len() >= self.max_stream_tasks
        {
            self.end_stream(st, Some("processing"), "").await;
        }
        self.send_native(st, vec![task(id, title, "in_progress", None)], true)
            .await
    }

    async fn tick_native(&self, st: &mut State) -> Result<(), SlackApiError> {
        self.end_stream(st, Some("processing"), "").await;
        // Tools still running show again straight away, so the thread does not look finished while they run.
        if !st.open_tasks.is_empty() || !st.pending.is_empty() {
            self.send_native(st, Vec::new(), true).await?;
        }
        Ok(())
    }

    async fn finish_native(&self, st: &mut State) -> Result<(), SlackApiError> {
        if self.stopped() {
            st.pending.clear();
        }
        // The last of the text rides on the stopStream call when it fits; otherwise it is sent first.
        let pending = utf16_len(&st.pending) as i64;
        let fits = st.stream.as_ref().is_some_and(|s| {
            pending <= self.max_stream_chars - s.chars && (self.now)() - s.started_at < self.max_stream_ms
        });
        if !st.pending.is_empty() && !fits {
            self.send_native(st, Vec::new(), true).await?;
        }
        if st.stream.is_some() {
            let tail = std::mem::take(&mut st.pending);
            self.end_stream(st, None, &tail).await;
        } else if st.ended_mid_turn {
            self.session_active(st).await;
        }
        Ok(())
    }

    /// The end of native work. On an error that native streaming cannot get past, switch this reply to editing (and
    /// tell the bot when the workspace will never stream) and return false so the caller does the same work by
    /// editing. True when the work went through, or the person stopped the reply.
    async fn native_outcome(&self, st: &mut State, result: Result<(), SlackApiError>) -> bool {
        let Err(err) = result else { return true };
        let code = err.code();
        if code == Some("stopped_by_user") {
            self.user_stopped(st);
            return true;
        }
        log::warn!(
            "[slack] native streaming failed ({}); editing messages for the rest of this reply",
            code.unwrap_or(&err.message)
        );
        if let Some(code) = code
            && NATIVE_UNAVAILABLE.contains(&code)
            && let Some(tell) = &self.on_native_unavailable
        {
            // the bot's cache is best-effort
            let _ = std::panic::catch_unwind(AssertUnwindSafe(|| tell(code)));
        }
        if let Some(stream) = st.stream.take() {
            // Best-effort: end the half-written stream so it does not sit "processing" until Slack times it out. A
            // code block open in it carries on, opened again, in the first edited message.
            if let Some(fence) = open_fence(&stream.text) {
                st.reopen = format!("{fence}\n");
            }
            let mut args = Map::new();
            args.insert("channel".into(), json!(self.channel));
            if let Some(ts) = &stream.ts {
                args.insert("ts".into(), json!(ts));
            }
            let _ = self.client.stop_stream(Value::Object(args)).await; // already gone
        }
        self.native.store(false, Ordering::SeqCst);
        false
    }

    fn user_stopped(&self, st: &mut State) {
        if self.stopped() {
            return;
        }
        self.stopped_by_user.store(true, Ordering::SeqCst);
        st.pending.clear();
        if let Some(handler) = &self.on_stopped_by_user {
            // caller's handler
            let _ = std::panic::catch_unwind(AssertUnwindSafe(|| handler()));
        }
    }

    /// Send the waiting text (`flush_text`) and these chunks on the current stream, starting one when there is none
    /// and rolling over to a new one before a cap. Fails on a Slack error other than an expired stream.
    async fn send_native(&self, st: &mut State, chunks: Vec<Value>, flush_text: bool) -> Result<(), SlackApiError> {
        if st
            .stream
            .as_ref()
            .is_some_and(|s| (self.now)() - s.started_at >= self.max_stream_ms)
        {
            self.end_stream(st, Some("processing"), "").await;
        }
        while flush_text && !st.pending.is_empty() {
            let prefix = if st.stream.is_some() {
                String::new()
            } else {
                st.reopen.clone()
            };
            let room = self.max_stream_chars - st.stream.as_ref().map_or(0, |s| s.chars) - utf16_len(&prefix) as i64;
            if room <= 0 {
                self.end_stream(st, Some("processing"), "").await;
                continue;
            }
            let mut piece_bytes = st.pending.len();
            if utf16_len(&st.pending) as i64 > room {
                let cut = last_newline_at_or_before(&st.pending, room - 1);
                piece_bytes = if cut > 0 {
                    byte_offset_for_units(&st.pending, cut + 1)
                } else {
                    byte_offset_for_units(&st.pending, room)
                };
            }
            let rest = st.pending[piece_bytes..].to_string();
            let last = rest.is_empty();
            let mut send = vec![markdown(&format!("{prefix}{}", &st.pending[..piece_bytes]))];
            if last {
                send.extend(chunks.iter().cloned());
            }
            self.append(st, send).await?;
            st.pending = rest;
            if !last {
                self.end_stream(st, Some("processing"), "").await;
            } else {
                return Ok(());
            }
        }
        if !chunks.is_empty() || st.stream.is_none() {
            self.append(st, chunks).await?;
        }
        Ok(())
    }

    /// One startStream or appendStream call. A stream Slack already ended is replaced by a new one, once.
    async fn append(&self, st: &mut State, chunks: Vec<Value>) -> Result<(), SlackApiError> {
        let starting = st.stream.is_none();
        let send = if starting {
            self.opening_chunks(st, &chunks)
        } else {
            chunks.clone()
        };
        if send.is_empty() {
            return Ok(());
        }
        let Err(err) = self.stream_call(st, starting, send).await else {
            return Ok(());
        };
        if err.code() != Some("message_not_in_streaming_state") || starting {
            return Err(err);
        }
        // Slack closed the stream itself (its 10 minutes ran out): carry on in a new message.
        let old_text = st.stream.take().map(|s| s.text).unwrap_or_default();
        st.reopen = open_fence(&old_text).map(|f| format!("{f}\n")).unwrap_or_default();
        st.carry_tasks = true;
        let reopened: Vec<Value> = chunks
            .into_iter()
            .map(|mut c| {
                if is_markdown(&c) && !st.reopen.is_empty() {
                    let text = format!("{}{}", st.reopen, c["text"].as_str().unwrap_or(""));
                    c["text"] = Value::String(text);
                }
                c
            })
            .collect();
        let fresh = self.opening_chunks(st, &reopened);
        st.reopen.clear();
        self.stream_call(st, true, fresh).await
    }

    /// The first chunks of a new stream: running tools carried over, then the fence reopened in front of the text.
    fn opening_chunks(&self, st: &State, chunks: &[Value]) -> Vec<Value> {
        let mut out = Vec::new();
        if st.carry_tasks {
            for (id, title) in &st.open_tasks.0 {
                if !chunks.iter().any(|c| is_task(c) && c["id"] == id.as_str()) {
                    out.push(task(id, title, "in_progress", None));
                }
            }
        }
        if !st.reopen.is_empty() && !chunks.iter().any(is_markdown) {
            out.push(markdown(&st.reopen));
        }
        out.extend(chunks.iter().cloned());
        out
    }

    async fn stream_call(&self, st: &mut State, starting: bool, chunks: Vec<Value>) -> Result<(), SlackApiError> {
        if starting {
            let mut args = Map::new();
            args.insert("channel".into(), json!(self.channel));
            args.insert("thread_ts".into(), json!(self.thread_ts));
            args.insert("task_display_mode".into(), json!("timeline"));
            args.insert("chunks".into(), Value::Array(chunks.clone()));
            if let Some(user) = self.recipient_user_id.as_deref().filter(|u| !u.is_empty()) {
                args.insert("recipient_user_id".into(), json!(user));
            }
            if let Some(team) = self.recipient_team_id.as_deref().filter(|t| !t.is_empty()) {
                args.insert("recipient_team_id".into(), json!(team));
            }
            let res = self.client.start_stream(Value::Object(args)).await?;
            st.stream = Some(NativeStream {
                ts: res.get("ts").and_then(Value::as_str).map(str::to_string),
                started_at: (self.now)(),
                chars: 0,
                text: String::new(),
                tasks: HashSet::new(),
            });
            st.reopen.clear();
            st.carry_tasks = false;
            st.ended_mid_turn = false;
        } else {
            let mut args = Map::new();
            args.insert("channel".into(), json!(self.channel));
            if let Some(ts) = st.stream.as_ref().and_then(|s| s.ts.as_deref()) {
                args.insert("ts".into(), json!(ts));
            }
            args.insert("chunks".into(), Value::Array(chunks.clone()));
            self.client.append_stream(Value::Object(args)).await?;
        }
        if let Some(stream) = st.stream.as_mut() {
            for c in &chunks {
                if is_markdown(c) {
                    let text = c["text"].as_str().unwrap_or("");
                    stream.chars += utf16_len(text) as i64;
                    stream.text.push_str(text);
                    if !trim(text).is_empty() {
                        self.mark_sent();
                    }
                } else if is_task(c) {
                    stream.tasks.insert(c["id"].as_str().unwrap_or("").to_string());
                }
            }
        }
        st.last_flush_at = (self.now)();
        Ok(())
    }

    /// Stop the current stream, with the last of the text (`tail`) when there is some. "processing": the turn goes on
    /// in a next message, so close what is open here.
    async fn end_stream(&self, st: &mut State, session_status: Option<&str>, tail: &str) {
        let Some(stream) = st.stream.take() else { return };
        let processing = session_status == Some("processing");
        let mut chunks = Vec::new();
        let text = format!("{}{tail}", stream.text);
        if !tail.is_empty() {
            chunks.push(markdown(tail));
            if !trim(tail).is_empty() {
                self.mark_sent();
            }
        }
        let fence = open_fence(&text);
        if let Some(fence) = &fence {
            let newline = if text.ends_with('\n') { "" } else { "\n" };
            chunks.push(markdown(&format!("{newline}{}", fence_ticks(fence))));
        }
        for (id, title) in &st.open_tasks.0 {
            if !stream.tasks.contains(id) {
                continue;
            }
            // Mid-turn the tool goes on in the next message; at the end of the turn it never finished (stopped,
            // aborted).
            chunks.push(if processing {
                task(id, title, "pending", Some("Continued below"))
            } else {
                task(id, title, "error", Some("Did not finish"))
            });
        }
        if !processing {
            st.open_tasks.clear();
        }
        let mut args = Map::new();
        args.insert("channel".into(), json!(self.channel));
        if let Some(ts) = &stream.ts {
            args.insert("ts".into(), json!(ts));
        }
        if !chunks.is_empty() {
            args.insert("chunks".into(), Value::Array(chunks));
        }
        if let Some(status) = session_status {
            args.insert("session_status".into(), json!(status));
        }
        if let Err(err) = self.client.stop_stream(Value::Object(args)).await {
            let code = err.code();
            if code == Some("stopped_by_user") {
                self.user_stopped(st);
            } else {
                if code != Some("message_not_in_streaming_state") {
                    log::warn!("[slack] stopStream failed: {}", code.unwrap_or(&err.message));
                }
                // The last words rode on this stop: they would be lost, so they go in a message of their own.
                if !trim(tail).is_empty() {
                    let before = open_fence(&stream.text).map(|f| format!("{f}\n")).unwrap_or_default();
                    self.post(&close_fence(&format!("{before}{tail}"))).await;
                }
            }
        }
        if processing {
            st.reopen = fence.map(|f| format!("{f}\n")).unwrap_or_default();
            st.carry_tasks = true;
            st.ended_mid_turn = true;
        } else {
            st.ended_mid_turn = false;
        }
    }

    /// The turn ended between two streams: set the agent session back to active (it would otherwise spin for an
    /// hour).
    async fn session_active(&self, st: &mut State) {
        st.ended_mid_turn = false;
        let args = json!({ "channel_id": self.channel, "thread_ts": self.thread_ts, "status": "active" });
        // no agent features in this workspace: nothing is spinning
        let _ = self.client.set_agent_session_status(args).await;
    }

    // ── editing ───────────────────────────────────────────────────────────────

    async fn flush_edit(&self, st: &mut State) {
        if st.pending.is_empty() {
            return;
        }
        // The first words after switching from native streaming, in the middle of a code block: open it again.
        if !st.reopen.is_empty() && st.seg_text.is_empty() {
            st.pending = format!("{}{}", st.reopen, st.pending);
        }
        st.reopen.clear();
        let pending = std::mem::take(&mut st.pending);
        st.seg_text.push_str(&pending);
        // A stretch longer than one message: the finished part goes out with its code block closed, and the rest
        // carries on in a new message with the block opened again. The cut is made on the raw text, so no line is
        // lost, glued to a fence or left outside its block.
        let room = self.max_message_chars as i64 - 6; // room for a closing fence
        while utf16_len(&st.seg_text) > self.max_message_chars {
            let reopened = if st.seg_text.starts_with("```") {
                st.seg_text
                    .find('\n')
                    .map_or(0, |i| utf16_len(&st.seg_text[..i]) as i64 + 1)
            } else {
                0
            };
            let mut cut = last_newline_at_or_before(&st.seg_text, room - 1) + 1;
            if cut <= reopened {
                cut = room; // one line longer than a message: cut it
            }
            let at = byte_offset_for_units(&st.seg_text, cut);
            let mut head = st.seg_text[..at].to_string();
            let mut rest = st.seg_text[at..].to_string();
            if let Some(fence) = open_fence(&head) {
                head = close_fence(&head);
                rest = format!("{fence}\n{rest}");
            }
            self.show_segment(st, &head).await;
            st.seg = None;
            st.seg_text = rest;
        }
        let whole = st.seg_text.clone();
        self.show_segment(st, &whole).await;
    }

    async fn show_segment(&self, st: &mut State, raw: &str) {
        // A block still being written is shown closed, so it does not swallow what follows it in the message.
        let text = close_fence(raw);
        if trim(&text).is_empty() {
            return;
        }
        match st.seg.as_mut() {
            Some(seg) if seg.ts.is_some() => {
                if text != seg.shown {
                    let ts = seg.ts.clone().unwrap_or_default();
                    self.update(&ts, &text).await;
                    seg.shown = text;
                }
            }
            _ => {
                let ts = self.post(&text).await;
                st.seg = Some(Segment { ts, shown: text });
            }
        }
        st.last_flush_at = (self.now)();
        self.mark_sent();
    }

    async fn close_segment(&self, st: &mut State) {
        self.flush_edit(st).await;
        st.seg = None;
        st.seg_text.clear();
    }

    /// chat.postMessage in the thread; the new message's ts, or `None` when it failed.
    async fn post(&self, markdown_text: &str) -> Option<String> {
        let args = json!({ "channel": self.channel, "thread_ts": self.thread_ts, "markdown_text": markdown_text });
        let res = self.call("postMessage", args).await?;
        res.get("ts")
            .and_then(Value::as_str)
            .filter(|ts| !ts.is_empty())
            .map(str::to_string)
    }

    async fn update(&self, ts: &str, markdown_text: &str) {
        let args = json!({ "channel": self.channel, "ts": ts, "markdown_text": markdown_text });
        self.call("update", args).await;
    }

    async fn call(&self, method: &str, args: Value) -> Option<Value> {
        let result = match method {
            "postMessage" => self.client.post_message(args).await,
            _ => self.client.update(args).await,
        };
        match result {
            Ok(res) => Some(res),
            Err(err) => {
                log::warn!("[slack] chat.{method} failed: {}", err.code().unwrap_or(&err.message));
                None
            }
        }
    }
}

#[cfg(test)]
mod tests;
