//! Port of `test/slack-stream.test.js`, then the same scenarios run through the Node code and this one, compared call
//! by call, then cuts through emoji and non-Latin text.
//!
//! Time is tokio's paused clock, so the flush timer only fires when a test waits for it; the stream's own clock is a
//! counter the test moves, as the Node tests' `clock()` was.

use std::sync::atomic::{AtomicI64, AtomicUsize};

use super::*;

type FailRule = Box<dyn Fn(&str, &Value, usize) -> Option<String> + Send + Sync>;

/// A Slack client that records each call: (method, args, answer). `fail` gives the error code for a call (its method,
/// args, and how many calls of that method there have been, this one included), or `None` to answer
/// `{ ok: true, ts: "<method>-<n>" }`.
struct FakeSlack {
    calls: Mutex<Vec<(String, Value, Option<Value>)>>,
    fail: FailRule,
    answered: AtomicUsize,
}

impl FakeSlack {
    fn new() -> Arc<Self> {
        Self::failing(|_, _, _| None)
    }

    fn failing(fail: impl Fn(&str, &Value, usize) -> Option<String> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(FakeSlack {
            calls: Mutex::new(Vec::new()),
            fail: Box::new(fail),
            answered: AtomicUsize::new(0),
        })
    }

    /// Fails every call of `method` with `code`.
    fn always(method: &'static str, code: &'static str) -> Arc<Self> {
        Self::failing(move |m, _, _| (m == method).then(|| code.to_string()))
    }

    /// Fails the `nth` call of `method` with `code`.
    fn nth(method: &'static str, nth: usize, code: &'static str) -> Arc<Self> {
        Self::failing(move |m, _, n| (m == method && n == nth).then(|| code.to_string()))
    }

    fn record(&self, method: &str, args: Value) -> Result<Value, SlackApiError> {
        let mut calls = self.calls.lock();
        calls.push((method.to_string(), args.clone(), None));
        let count = calls.iter().filter(|c| c.0 == method).count();
        if let Some(code) = (self.fail)(method, &args, count) {
            return Err(SlackApiError::platform(code));
        }
        let n = self.answered.fetch_add(1, Ordering::SeqCst) + 1;
        let answer = json!({ "ok": true, "ts": format!("{method}-{n}") });
        if let Some(last) = calls.last_mut() {
            last.2 = Some(answer.clone());
        }
        Ok(answer)
    }

    fn calls(&self) -> Vec<(String, Value, Option<Value>)> {
        self.calls.lock().clone()
    }

    /// The arguments of every call of `method`.
    fn of(&self, method: &str) -> Vec<Value> {
        self.calls
            .lock()
            .iter()
            .filter(|c| c.0 == method)
            .map(|c| c.1.clone())
            .collect()
    }
}

#[async_trait]
impl SlackClient for FakeSlack {
    async fn start_stream(&self, args: Value) -> Result<Value, SlackApiError> {
        self.record("startStream", args)
    }
    async fn append_stream(&self, args: Value) -> Result<Value, SlackApiError> {
        self.record("appendStream", args)
    }
    async fn stop_stream(&self, args: Value) -> Result<Value, SlackApiError> {
        self.record("stopStream", args)
    }
    async fn post_message(&self, args: Value) -> Result<Value, SlackApiError> {
        self.record("postMessage", args)
    }
    async fn update(&self, args: Value) -> Result<Value, SlackApiError> {
        self.record("update", args)
    }
    async fn set_agent_session_status(&self, args: Value) -> Result<Value, SlackApiError> {
        self.record("sessionStatus", args)
    }
}

/// The stream's clock: a number the test moves.
#[derive(Clone)]
struct TestClock(Arc<AtomicI64>);

impl TestClock {
    fn new() -> Self {
        TestClock(Arc::new(AtomicI64::new(1_000_000)))
    }

    fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }

    fn clock(&self) -> Clock {
        let t = self.0.clone();
        Arc::new(move || t.load(Ordering::SeqCst))
    }
}

fn opts(client: &Arc<FakeSlack>, clock: &TestClock) -> SlackReplyStreamOptions {
    let mut o = SlackReplyStreamOptions::new(client.clone(), "C1", "100.1");
    o.recipient_user_id = Some("U1".into());
    o.recipient_team_id = Some("T1".into());
    o.now = clock.clock();
    o
}

/// All markdown in these chunks.
fn text_of(chunks: &Value) -> String {
    chunks
        .as_array()
        .map(|cs| {
            cs.iter()
                .filter(|c| c["type"] == "markdown_text")
                .filter_map(|c| c["text"].as_str())
                .collect()
        })
        .unwrap_or_default()
}

/// All markdown that reached Slack over native streams, in order.
fn streamed_text(client: &FakeSlack) -> String {
    client
        .calls()
        .iter()
        .filter(|(m, _, _)| m == "startStream" || m == "appendStream" || m == "stopStream")
        .map(|(_, a, _)| text_of(&a["chunks"]))
        .collect()
}

fn task_updates(args: &Value) -> Vec<Value> {
    args["chunks"]
        .as_array()
        .map(|cs| cs.iter().filter(|c| c["type"] == "task_update").cloned().collect())
        .unwrap_or_default()
}

/// How many lines of `text` start with ``` (the JS `(text.match(/^```/gm) || []).length`).
fn fence_lines(text: &str) -> usize {
    text.split('\n').filter(|l| l.starts_with("```")).count()
}

/// Each message's last version, in the order they were posted.
fn final_messages(client: &FakeSlack) -> Vec<String> {
    let mut last: Vec<(String, String)> = Vec::new();
    for (m, a, result) in client.calls() {
        let (ts, text) = match m.as_str() {
            "postMessage" => match result {
                Some(r) => (
                    r["ts"].as_str().unwrap_or("").to_string(),
                    a["markdown_text"].as_str().unwrap_or(""),
                ),
                None => continue,
            },
            "update" => (
                a["ts"].as_str().unwrap_or("").to_string(),
                a["markdown_text"].as_str().unwrap_or(""),
            ),
            _ => continue,
        };
        match last.iter_mut().find(|(t, _)| *t == ts) {
            Some(entry) => entry.1 = text.to_string(),
            None => last.push((ts, text.to_string())),
        }
    }
    last.into_iter().map(|(_, text)| text).collect()
}

// SlackReplyStream, native streaming

#[tokio::test(start_paused = true)]
async fn starts_a_stream_in_the_thread_for_the_person_then_appends_then_stops() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let s = SlackReplyStream::new(opts(&client, &c));
    s.text("Hello").await;
    s.text(" there").await; // inside the flush interval: buffered
    c.advance(2000);
    s.text(", friend").await; // interval passed: appended
    s.text("!").await;
    s.finish().await;

    let start = &client.of("startStream")[0];
    assert_eq!(start["channel"], "C1");
    assert_eq!(start["thread_ts"], "100.1");
    assert_eq!(start["recipient_user_id"], "U1");
    assert_eq!(start["recipient_team_id"], "T1");
    assert_eq!(start["task_display_mode"], "timeline");
    assert_eq!(text_of(&start["chunks"]), "Hello");
    assert_eq!(client.of("appendStream").len(), 1);
    assert_eq!(client.of("stopStream").len(), 1);
    assert_eq!(streamed_text(&client), "Hello there, friend!");
    assert_eq!(s.mode(), StreamMode::Native);
    assert!(s.sent_text());
}

#[tokio::test(start_paused = true)]
async fn shows_each_tool_as_a_task_card_that_turns_complete_or_error() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let s = SlackReplyStream::new(opts(&client, &c));
    s.text("Checking.").await;
    s.tool_start("t1", "Running command…").await;
    s.tool_done("t1", "Command done", true).await;
    s.tool_start("t2", "Reading a.md…").await;
    s.tool_done("t2", "Read a.md", false).await;
    s.finish().await;

    let calls = client.calls();
    let tasks: Vec<Value> = calls.iter().flat_map(|(_, a, _)| task_updates(a)).collect();
    let pairs: Vec<(String, String)> = tasks
        .iter()
        .map(|t| {
            (
                t["id"].as_str().unwrap().to_string(),
                t["status"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let want = [
        ("t1", "in_progress"),
        ("t1", "complete"),
        ("t2", "in_progress"),
        ("t2", "error"),
    ];
    assert_eq!(pairs, want.map(|(a, b)| (a.to_string(), b.to_string())));
    assert_eq!(tasks[1]["title"], "Command done");
    // Text written before a tool reaches Slack before the tool's card.
    let first_task = calls.iter().position(|(_, a, _)| !task_updates(a).is_empty()).unwrap();
    let text_before: String = calls[..=first_task]
        .iter()
        .map(|(_, a, _)| text_of(&a["chunks"]))
        .collect();
    assert_eq!(text_before, "Checking.");
}

#[tokio::test(start_paused = true)]
async fn rolls_over_to_a_new_message_before_slacks_markdown_cap_losing_nothing() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.max_stream_chars = 40;
    let s = SlackReplyStream::new(o);
    let words: String = (0..12).map(|i| format!("word{i}\n")).collect();
    for ch in words.chars() {
        c.advance(1500);
        s.text(&ch.to_string()).await;
    }
    s.finish().await;

    assert!(client.of("startStream").len() >= 2, "more than one message");
    let stops = client.of("stopStream");
    assert!(
        stops[..stops.len() - 1]
            .iter()
            .all(|a| a["session_status"] == "processing"),
        "the turn is still going at each rollover"
    );
    assert_eq!(
        stops.last().unwrap().get("session_status"),
        None,
        "the last stop ends the turn"
    );
    assert_eq!(streamed_text(&client), words);
    // No one stream carried more than the cap.
    let mut per_stream = 0;
    for (m, a, _) in client.calls() {
        if m == "startStream" {
            per_stream = 0;
        }
        per_stream += utf16_len(&text_of(&a["chunks"]));
        assert!(per_stream <= 40 + 4, "stream too long: {per_stream}");
    }
}

#[tokio::test(start_paused = true)]
async fn closes_a_code_fence_at_a_rollover_and_opens_it_again_in_the_next_message() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.max_stream_chars = 60;
    let s = SlackReplyStream::new(o);
    let code = format!("```js\n{}", (0..10).map(|i| format!("x{i}();\n")).collect::<String>());
    for line in code.split_inclusive('\n') {
        c.advance(1500);
        s.text(line).await;
    }
    s.text("```\n").await;
    s.finish().await;

    // Each message on its own has balanced fences.
    let mut messages: Vec<String> = Vec::new();
    for (m, a, _) in client.calls() {
        if m == "startStream" {
            messages.push(String::new());
        }
        if ["startStream", "appendStream", "stopStream"].contains(&m.as_str()) {
            messages.last_mut().unwrap().push_str(&text_of(&a["chunks"]));
        }
    }
    assert!(messages.len() >= 2);
    for msg in &messages {
        assert_eq!(fence_lines(msg) % 2, 0, "unbalanced: {msg:?}");
    }
    assert!(
        messages[1].starts_with("```js\n"),
        "the next message reopens the fence with its language"
    );
}

#[tokio::test(start_paused = true)]
async fn hands_over_to_a_new_message_before_the_10_minute_stream_limit_carrying_running_tools() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.max_stream_ms = 9 * 60_000;
    let s = SlackReplyStream::new(o);
    s.text("Working on it.").await;
    s.tool_start("t1", "Running command…").await;
    c.advance(9 * 60_000 + 1);
    s.tick().await;
    s.tool_done("t1", "Command done", true).await;
    s.finish().await;

    let starts = client.of("startStream");
    assert_eq!(starts.len(), 2);
    let first = &client.of("stopStream")[0];
    assert_eq!(first["session_status"], "processing");
    // The running tool shows in the new message and finishes there.
    let reopened = &task_updates(&starts[1])[0];
    assert_eq!(reopened["id"], "t1");
    assert_eq!(reopened["status"], "in_progress");
    let calls = client.calls();
    let second_start = calls.iter().rposition(|(m, _, _)| m == "startStream").unwrap();
    let done = calls[second_start..]
        .iter()
        .flat_map(|(_, a, _)| task_updates(a))
        .any(|t| t["id"] == "t1" && t["status"] == "complete");
    assert!(done, "completed in the new message");
}

#[tokio::test(start_paused = true)]
async fn starts_a_fresh_message_when_slack_says_the_stream_already_ended() {
    let client = FakeSlack::nth("appendStream", 1, "message_not_in_streaming_state");
    let c = TestClock::new();
    let s = SlackReplyStream::new(opts(&client, &c));
    s.text("one ").await;
    c.advance(2000);
    s.text("two").await;
    s.finish().await;
    assert_eq!(client.of("startStream").len(), 2);
    assert_eq!(text_of(&client.of("startStream")[1]["chunks"]), "two");
}

#[tokio::test(start_paused = true)]
async fn marks_a_tool_still_running_when_the_reply_ends_as_not_finished_instead_of_leaving_it_spinning() {
    let client = FakeSlack::new();
    let s = SlackReplyStream::new(opts(&client, &TestClock::new()));
    s.tool_start("t1", "Running command…").await;
    s.finish().await;
    let stop = client.of("stopStream").pop().unwrap();
    let card = task_updates(&stop).into_iter().find(|c| c["id"] == "t1");
    let card = card.expect("the stop carries the card's last state");
    assert_eq!(card["status"], "error");
    assert!(
        card["details"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("did not finish")
    );

    let edit = FakeSlack::new();
    let mut o = opts(&edit, &TestClock::new());
    o.native = false;
    let e = SlackReplyStream::new(o);
    e.tool_start("t1", "Running command…").await;
    e.finish().await;
    assert_eq!(
        edit.of("update").last().unwrap()["markdown_text"],
        "❌ _Running command… — did not finish_"
    );
}

#[tokio::test(start_paused = true)]
async fn stops_when_the_person_presses_stop() {
    let client = FakeSlack::always("appendStream", "stopped_by_user");
    let c = TestClock::new();
    let stopped = Arc::new(AtomicUsize::new(0));
    let mut o = opts(&client, &c);
    let counter = stopped.clone();
    o.on_stopped_by_user = Some(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    let s = SlackReplyStream::new(o);
    s.text("one ").await;
    c.advance(2000);
    s.text("two").await;
    c.advance(2000);
    s.text("three").await;
    s.finish().await;
    assert_eq!(stopped.load(Ordering::SeqCst), 1);
    assert!(s.stopped_by_user());
    assert_eq!(client.of("appendStream").len(), 1, "nothing more is sent after stop");
}

// SlackReplyStream, editing fallback

#[tokio::test(start_paused = true)]
async fn falls_back_to_posting_and_editing_when_slack_refuses_native_streaming_and_says_why() {
    let client = FakeSlack::always("startStream", "feature_disabled");
    let c = TestClock::new();
    let reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let mut o = opts(&client, &c);
    let said = reason.clone();
    o.on_native_unavailable = Some(Arc::new(move |code: &str| *said.lock() = Some(code.to_string())));
    let s = SlackReplyStream::new(o);
    s.text("Hello").await;
    c.advance(2000);
    s.text(" world").await;
    s.finish().await;

    assert_eq!(reason.lock().as_deref(), Some("feature_disabled"));
    assert_eq!(s.mode(), StreamMode::Edit);
    let post = &client.of("postMessage")[0];
    assert_eq!(post["channel"], "C1");
    assert_eq!(post["thread_ts"], "100.1");
    assert_eq!(post["markdown_text"], "Hello");
    assert_eq!(client.of("update").last().unwrap()["markdown_text"], "Hello world");
}

#[tokio::test(start_paused = true)]
async fn does_not_give_up_on_native_streaming_for_a_passing_error() {
    let reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let client = FakeSlack::always("startStream", "internal_error");
    let mut o = opts(&client, &TestClock::new());
    let said = reason.clone();
    o.on_native_unavailable = Some(Arc::new(move |code: &str| *said.lock() = Some(code.to_string())));
    let s = SlackReplyStream::new(o);
    s.text("Hi").await;
    s.finish().await;
    assert_eq!(s.mode(), StreamMode::Edit, "this reply still gets through");
    assert_eq!(*reason.lock(), None, "but the bot is not told to stop trying");
    assert_eq!(client.of("postMessage")[0]["markdown_text"], "Hi");
}

#[tokio::test(start_paused = true)]
async fn edits_straight_away_when_told_native_streaming_is_off() {
    let client = FakeSlack::new();
    let mut o = opts(&client, &TestClock::new());
    o.native = false;
    let s = SlackReplyStream::new(o);
    s.text("Hi").await;
    s.finish().await;
    assert_eq!(client.of("startStream").len(), 0);
    assert_eq!(client.of("postMessage")[0]["markdown_text"], "Hi");
}

#[tokio::test(start_paused = true)]
async fn posts_a_status_line_for_each_tool_and_edits_it_when_the_tool_finishes() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.native = false;
    let s = SlackReplyStream::new(o);
    s.text("Let me look.").await;
    s.tool_start("t1", "Running command…").await;
    s.tool_done("t1", "Command done", true).await;
    s.text("Found it.").await;
    s.finish().await;

    let posts: Vec<Value> = client
        .of("postMessage")
        .iter()
        .map(|p| p["markdown_text"].clone())
        .collect();
    assert_eq!(
        posts,
        vec![
            json!("Let me look."),
            json!("⚙️ _Running command…_"),
            json!("Found it.")
        ]
    );
    assert!(
        client
            .of("update")
            .iter()
            .any(|u| u["markdown_text"] == "✓ _Command done_")
    );
}

#[tokio::test(start_paused = true)]
async fn starts_a_new_message_when_one_gets_too_long_for_slack() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.native = false;
    o.max_message_chars = 50;
    let s = SlackReplyStream::new(o);
    let long: String = (0..10).map(|i| format!("line {i}\n")).collect();
    for line in long.split_inclusive('\n') {
        c.advance(2000);
        s.text(line).await;
    }
    s.finish().await;
    assert!(client.of("postMessage").len() >= 2, "more than one message");
    for u in client.of("postMessage").iter().chain(client.of("update").iter()) {
        let text = u["markdown_text"].as_str().unwrap();
        assert!(utf16_len(text) <= 50, "too long: {}", utf16_len(text));
    }
    // Each message's last version, in order, is the whole answer.
    let squeeze = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    assert_eq!(squeeze(&final_messages(&client).concat()), squeeze(&long));
}

// SlackReplyStream, editing fallback with code

#[tokio::test(start_paused = true)]
async fn splits_a_long_code_block_across_messages_without_losing_gluing_or_unfencing_a_line() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.native = false;
    o.max_message_chars = 120;
    let s = SlackReplyStream::new(o);
    let lines: Vec<String> = (0..20).map(|i| format!("const v{i} = {i};\n")).collect();
    let text = format!("Here:\n```js\n{}```\nAfter.", lines.concat());
    for piece in text.split_inclusive('\n') {
        c.advance(2000);
        s.text(piece).await;
    }
    s.finish().await;

    let msgs = final_messages(&client);
    assert!(msgs.len() >= 3, "split into several messages: {}", msgs.len());
    let glued = regex::Regex::new(r"```[^\s`]").unwrap();
    for m in &msgs {
        assert!(utf16_len(m) <= 120, "too long: {}", utf16_len(m));
        assert_eq!(fence_lines(m) % 2, 0, "unbalanced fences: {m:?}");
        assert!(
            !glued.is_match(&m.replace("```js\n", "")),
            "a fence glued to code: {m:?}"
        );
    }
    for m in &msgs[1..msgs.len() - 1] {
        assert!(m.starts_with("```js\n"), "a continuation reopens the block: {m:?}");
    }
    let code_line = regex::Regex::new(r"(?m)^const v[0-9]+ = [0-9]+;$").unwrap();
    let joined = msgs.join("\n");
    let code: Vec<&str> = code_line.find_iter(&joined).map(|m| m.as_str()).collect();
    let want: Vec<&str> = lines.iter().map(|l| l.trim()).collect();
    assert_eq!(code, want, "every line once, in order");
    assert!(msgs[0].starts_with("Here:\n```js\n"));
    assert!(msgs.last().unwrap().ends_with("```\nAfter."));
}

#[tokio::test(start_paused = true)]
async fn shows_a_block_still_being_written_as_closed_so_the_rest_of_the_message_is_not_swallowed() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.native = false;
    let s = SlackReplyStream::new(o);
    s.text("```py\nx = 1\n").await;
    assert_eq!(client.of("postMessage")[0]["markdown_text"], "```py\nx = 1\n```");
    c.advance(2000);
    s.text("```\nDone.").await;
    s.finish().await;
    assert_eq!(
        client.of("update").last().unwrap()["markdown_text"],
        "```py\nx = 1\n```\nDone."
    );
}

// SlackReplyStream, when things go wrong part-way

#[tokio::test(start_paused = true)]
async fn falling_back_after_a_rollover_keeps_the_code_block_open_and_ends_the_agent_session() {
    let client = FakeSlack::nth("startStream", 2, "internal_error");
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.max_stream_chars = 40;
    let s = SlackReplyStream::new(o);
    for line in [
        "```js\n",
        "const a = 1;\n",
        "const b = 2;\n",
        "const c = 3;\n",
        "const d = 4;\n",
        "```\n",
    ] {
        c.advance(1500);
        s.text(line).await;
    }
    s.finish().await;
    assert_eq!(s.mode(), StreamMode::Edit);
    let last = client
        .of("update")
        .last()
        .or(client.of("postMessage").last())
        .map(|a| a["markdown_text"].as_str().unwrap().to_string())
        .unwrap();
    assert!(
        last.starts_with("```js\n"),
        "the rest of the block is still code: {last:?}"
    );
    assert_eq!(
        client.of("sessionStatus").last().map(|a| a["status"].clone()),
        Some(json!("active")),
        "the session is not left spinning"
    );
}

#[tokio::test(start_paused = true)]
async fn posts_the_last_words_when_slack_refuses_the_final_stop_instead_of_dropping_them() {
    let client = FakeSlack::always("stopStream", "internal_error");
    let c = TestClock::new();
    let s = SlackReplyStream::new(opts(&client, &c));
    s.text("First part.").await;
    s.text(" Last part.").await;
    s.finish().await;
    assert!(
        client
            .of("postMessage")
            .iter()
            .any(|p| p["markdown_text"].as_str().unwrap().contains("Last part.")),
        "the tail reaches the thread"
    );
}

#[tokio::test(start_paused = true)]
async fn sends_held_text_on_its_own_once_the_interval_passes_without_waiting_for_more() {
    let client = FakeSlack::new();
    let start = tokio::time::Instant::now();
    let mut o = opts(&client, &TestClock::new());
    o.now = Arc::new(move || 1_000_000 + start.elapsed().as_millis() as i64);
    o.flush_interval_ms = 40;
    let s = SlackReplyStream::new(o);
    s.text("one ").await;
    s.text("two").await;
    assert_eq!(streamed_text(&client), "one ");
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(streamed_text(&client), "one two");
    s.finish().await;
}

// slackErrorCode

/// The Node case also passed `null`; there is no null error in Rust.
#[test]
fn reads_slacks_error_code_off_a_thrown_error() {
    assert_eq!(
        slack_error_code(&SlackApiError::platform("ratelimited")),
        Some("ratelimited")
    );
    assert_eq!(slack_error_code(&std::io::Error::other("boom")), None);
    assert_eq!(slack_error_code(&SlackApiError::other("boom")), None);
    assert_eq!(
        SlackApiError::platform("ratelimited").to_string(),
        "An API error occurred: ratelimited"
    );
    let wrapped = anyhow::Error::new(SlackApiError::platform("missing_scope"));
    assert_eq!(slack_error_code(wrapped.as_ref()), Some("missing_scope"));
}

// The same scenarios through the Node code and this one.

/// Runs one scenario of [`NODE_SCENARIOS`] and checks every call and the end state against what the Node code did.
async fn run_node_scenario(raw: &str) {
    let expected: Value = serde_json::from_str(raw).unwrap();
    let sc = &expected["scenario"];
    let name = sc["name"].as_str().unwrap().to_string();
    let rules = sc["fail"].clone();
    let client = FakeSlack::failing(move |method, _, count| match &rules[method] {
        Value::String(code) => Some(code.clone()),
        Value::Object(by_call) => by_call
            .get(&count.to_string())
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    });
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    let given = &sc["opts"];
    o.native = given["native"].as_bool().unwrap_or(true);
    o.max_stream_chars = given["maxStreamChars"].as_u64().unwrap_or(11_000) as usize;
    o.max_message_chars = given["maxMessageChars"].as_u64().unwrap_or(11_000) as usize;
    o.max_stream_ms = given["maxStreamMs"].as_i64().unwrap_or(540_000);
    o.max_stream_tasks = given["maxStreamTasks"].as_u64().unwrap_or(48) as usize;
    let s = SlackReplyStream::new(o);
    for step in sc["steps"].as_array().unwrap() {
        let arg = |i: usize| step[i].as_str().unwrap_or("");
        match arg(0) {
            "text" => s.text(arg(1)).await,
            "advance" => c.advance(step[1].as_i64().unwrap()),
            "toolStart" => s.tool_start(arg(1), arg(2)).await,
            "toolDone" => s.tool_done(arg(1), arg(2), step[3].as_bool().unwrap()).await,
            "tick" => s.tick().await,
            "finish" => s.finish().await,
            other => panic!("unknown step {other}"),
        }
    }
    let calls: Vec<Value> = client.calls().into_iter().map(|(m, a, _)| json!([m, a])).collect();
    // Compared as text, so the order of each object's fields counts too.
    let got = serde_json::to_string_pretty(&calls).unwrap();
    let want = serde_json::to_string_pretty(&expected["calls"]).unwrap();
    assert_eq!(got, want, "{name}");
    assert_eq!(s.mode().as_str(), expected["end"]["mode"], "{name}");
    assert_eq!(s.sent_text(), expected["end"]["sentText"], "{name}");
    assert_eq!(s.stopped_by_user(), expected["end"]["stoppedByUser"], "{name}");
}

#[tokio::test(start_paused = true)]
async fn every_call_matches_the_node_code_in_each_scenario() {
    for raw in NODE_SCENARIOS {
        run_node_scenario(raw).await;
    }
}

// Cuts through emoji and non-Latin text.

/// Every message of a reply and the text of each, from the native stream calls.
fn native_messages(client: &FakeSlack) -> Vec<String> {
    let mut messages: Vec<String> = Vec::new();
    for (m, a, _) in client.calls() {
        if m == "startStream" {
            messages.push(String::new());
        }
        if ["startStream", "appendStream", "stopStream"].contains(&m.as_str())
            && let Some(last) = messages.last_mut()
        {
            last.push_str(&text_of(&a["chunks"]));
        }
    }
    messages
}

/// The Node code cut a stream's text at a UTF-16 count, which could leave half of an emoji at the end of one message
/// and the other half at the start of the next. Here the emoji moves whole to the next message.
#[tokio::test(start_paused = true)]
async fn a_native_cut_through_an_emoji_moves_it_whole_to_the_next_message() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.max_stream_chars = 10;
    let s = SlackReplyStream::new(o);
    let text = "abcdefghi😀xyz🐒🐒🐒🐒🐒 日本語のテキスト";
    s.text(text).await;
    s.finish().await;
    let messages = native_messages(&client);
    assert!(messages.len() > 2);
    assert_eq!(messages[0], "abcdefghi");
    assert!(messages[1].starts_with('😀'));
    for m in &messages {
        assert!(utf16_len(m) <= 10, "{m:?} is {} units", utf16_len(m));
    }
    assert_eq!(messages.concat(), text);
}

#[tokio::test(start_paused = true)]
async fn a_native_cut_prefers_a_line_end_in_non_latin_text() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.max_stream_chars = 12;
    let s = SlackReplyStream::new(o);
    let text = "日本語の\n文章です。\nこんにちは世界\n終わり";
    s.text(text).await;
    s.finish().await;
    let messages = native_messages(&client);
    assert_eq!(messages, vec!["日本語の\n文章です。\n", "こんにちは世界\n終わり"]);
}

#[tokio::test(start_paused = true)]
async fn an_edited_message_cut_through_emoji_keeps_every_one_whole() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.native = false;
    o.max_message_chars = 13;
    let s = SlackReplyStream::new(o);
    let text = format!("x{}", "🐒".repeat(12));
    s.text(&text).await;
    s.finish().await;
    let msgs = final_messages(&client);
    assert!(msgs.len() > 2);
    for m in &msgs {
        assert!(utf16_len(m) <= 13, "{m:?}");
    }
    assert_eq!(msgs.concat(), text);
}

/// When the room left in a stream is one unit and the next character is an emoji, the emoji goes whole (one unit
/// over), rather than half of it (the Node code) or nothing at all (which would never end).
#[tokio::test(start_paused = true)]
async fn a_room_of_one_unit_still_sends_an_emoji() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.max_stream_chars = 3;
    let s = SlackReplyStream::new(o);
    s.text("ab").await;
    c.advance(1500);
    s.text("😀😀").await;
    s.finish().await;
    assert_eq!(native_messages(&client), vec!["ab😀", "😀"]);
}

#[tokio::test(start_paused = true)]
async fn finish_cancels_a_flush_that_has_not_fired_yet() {
    let client = FakeSlack::new();
    let start = tokio::time::Instant::now();
    let mut o = opts(&client, &TestClock::new());
    o.now = Arc::new(move || 1_000_000 + start.elapsed().as_millis() as i64);
    o.flush_interval_ms = 40;
    let s = SlackReplyStream::new(o);
    s.text("one ").await;
    s.text("two").await;
    s.finish().await;
    let calls = client.calls().len();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(client.calls().len(), calls, "nothing after the end");
    assert_eq!(streamed_text(&client), "one two");
}

#[tokio::test(start_paused = true)]
async fn a_client_without_agent_features_leaves_the_session_alone() {
    struct Bare(Arc<FakeSlack>);
    #[async_trait]
    impl SlackClient for Bare {
        async fn start_stream(&self, args: Value) -> Result<Value, SlackApiError> {
            self.0.start_stream(args).await
        }
        async fn append_stream(&self, args: Value) -> Result<Value, SlackApiError> {
            self.0.append_stream(args).await
        }
        async fn stop_stream(&self, args: Value) -> Result<Value, SlackApiError> {
            self.0.stop_stream(args).await
        }
        async fn post_message(&self, args: Value) -> Result<Value, SlackApiError> {
            self.0.post_message(args).await
        }
        async fn update(&self, args: Value) -> Result<Value, SlackApiError> {
            self.0.update(args).await
        }
    }
    let inner = FakeSlack::nth("startStream", 2, "internal_error");
    let c = TestClock::new();
    let mut o = opts(&inner, &c);
    o.client = Arc::new(Bare(inner.clone()));
    o.max_stream_chars = 10;
    let s = SlackReplyStream::new(o);
    c.advance(1500);
    s.text("0123456789abc").await;
    s.finish().await;
    assert_eq!(s.mode(), StreamMode::Edit);
    assert!(inner.of("sessionStatus").is_empty());
    assert!(final_messages(&inner).concat().ends_with("abc"));
}

/// What a stream already holds counts in UTF-16 units: three emoji are six, so four more letters fill a stream of ten.
#[tokio::test(start_paused = true)]
async fn emoji_already_in_a_stream_count_two_units_each() {
    let client = FakeSlack::new();
    let c = TestClock::new();
    let mut o = opts(&client, &c);
    o.max_stream_chars = 10;
    let s = SlackReplyStream::new(o);
    s.text("😀😀😀").await;
    c.advance(1500);
    s.text("abcdef").await;
    s.finish().await;
    assert_eq!(native_messages(&client), vec!["😀😀😀abcd", "ef"]);
}

/// Scenarios run through the Node `SlackReplyStream` with a recording client: the scenario, every call it made
/// (method and arguments, in order), and the stream's state at the end. Generated, not typed.
const NODE_SCENARIOS: &[&str] = &[
    r####"{"scenario":{"name":"native: tools, a code block and CJK text over a small cap","opts":{"maxStreamChars":60},"steps":[["text","Checking the 日本語 notes."],["toolStart","t1","Running command…"],["advance",1200],["text","```js\n"],["advance",1200],["advance",1100],["text","const 変数0 = 0;\n"],["advance",1100],["text","const 変数1 = 1;\n"],["advance",1100],["text","const 変数2 = 2;\n"],["advance",1100],["text","const 変数3 = 3;\n"],["advance",1100],["text","const 変数4 = 4;\n"],["advance",1100],["text","const 変数5 = 5;\n"],["toolDone","t1","Command done",true],["text","```\nDone — 完了."],["finish"]]},"calls":[["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"Checking the 日本語 notes."}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"task_update","id":"t1","title":"Running command…","status":"in_progress"}]}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"```js\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"const 変数0 = 0;\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"const 変数1 = 1;\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"c"}]}],["stopStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"task_update","id":"t1","title":"Running command…","status":"pending","details":"Continued below"}],"session_status":"processing"}],["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"task_update","id":"t1","title":"Running command…","status":"in_progress"},{"type":"markdown_text","text":"onst 変数2 = 2;\n"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-8","chunks":[{"type":"markdown_text","text":"const 変数3 = 3;\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-8","chunks":[{"type":"markdown_text","text":"const 変数4 = 4;\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-8","chunks":[{"type":"markdown_text","text":"const 変数5 = 5;\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-8","chunks":[{"type":"task_update","id":"t1","title":"Command done","status":"complete"}]}],["appendStream",{"channel":"C1","ts":"startStream-8","chunks":[{"type":"markdown_text","text":"`"}]}],["stopStream",{"channel":"C1","ts":"startStream-8","session_status":"processing"}],["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"``\nDone — 完了."}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["stopStream",{"channel":"C1","ts":"startStream-15"}]],"end":{"mode":"native","sentText":true,"stoppedByUser":false}}"####,
    r####"{"scenario":{"name":"native: the stream ends under it, then a refused start falls back to editing with the block open","opts":{"maxStreamChars":40},"fail":{"appendStream":{"2":"message_not_in_streaming_state"},"startStream":{"3":"missing_scope"}},"steps":[["text","intro\n```py\n"],["advance",1500],["text","x0 = ''\n"],["advance",1500],["text","x1 = 'é'\n"],["advance",1500],["text","x2 = 'éé'\n"],["advance",1500],["text","x3 = 'ééé'\n"],["advance",1500],["text","x4 = 'éééé'\n"],["advance",1500],["text","x5 = 'ééééé'\n"],["advance",1500],["text","x6 = 'éééééé'\n"],["advance",1500],["text","x7 = 'ééééééé'\n"],["toolStart","t2","Reading a.md…"],["advance",1500],["text","```\nafter"],["toolDone","t2","Read a.md",false],["finish"]]},"calls":[["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"intro\n```py\n"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"x0 = ''\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"x1 = 'é'\n"}]}],["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"```py\nx1 = 'é'\n"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-3","chunks":[{"type":"markdown_text","text":"x2 = 'éé'\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-3","chunks":[{"type":"markdown_text","text":"x3 = 'ééé'\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-3","chunks":[{"type":"markdown_text","text":"x4 ="}]}],["stopStream",{"channel":"C1","ts":"startStream-3","chunks":[{"type":"markdown_text","text":"\n```"}],"session_status":"processing"}],["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"```py\n 'éééé'\n"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"```py\n 'éééé'\n```"}],["update",{"channel":"C1","ts":"postMessage-8","markdown_text":"```py\n 'éééé'\nx5 = 'ééééé'\n```"}],["update",{"channel":"C1","ts":"postMessage-8","markdown_text":"```py\n 'éééé'\nx5 = 'ééééé'\nx6 = 'éééééé'\n```"}],["update",{"channel":"C1","ts":"postMessage-8","markdown_text":"```py\n 'éééé'\nx5 = 'ééééé'\nx6 = 'éééééé'\nx7 = 'ééééééé'\n```"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"⚙️ _Reading a.md…_"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"```\nafter\n```"}],["update",{"channel":"C1","ts":"postMessage-12","markdown_text":"❌ _Read a.md_"}],["sessionStatus",{"channel_id":"C1","thread_ts":"100.1","status":"active"}]],"end":{"mode":"edit","sentText":true,"stoppedByUser":false}}"####,
    r####"{"scenario":{"name":"native: a tick past the time limit with a tool running, a stop that fails at the end","opts":{"maxStreamMs":5000},"fail":{"stopStream":{"2":"internal_error"}},"steps":[["text","Working."],["toolStart","a","Searching…"],["toolStart","b","Fetching…"],["advance",5001],["tick"],["toolDone","a","Search done",true],["text"," Still going "],["text","and the last words."],["finish"]]},"calls":[["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"Working."}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"task_update","id":"a","title":"Searching…","status":"in_progress"}]}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"task_update","id":"b","title":"Fetching…","status":"in_progress"}]}],["stopStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"task_update","id":"a","title":"Searching…","status":"pending","details":"Continued below"},{"type":"task_update","id":"b","title":"Fetching…","status":"pending","details":"Continued below"}],"session_status":"processing"}],["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"task_update","id":"a","title":"Searching…","status":"in_progress"},{"type":"task_update","id":"b","title":"Fetching…","status":"in_progress"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-5","chunks":[{"type":"task_update","id":"a","title":"Search done","status":"complete"}]}],["stopStream",{"channel":"C1","ts":"startStream-5","chunks":[{"type":"markdown_text","text":" Still going and the last words."},{"type":"task_update","id":"b","title":"Fetching…","status":"error","details":"Did not finish"}]}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":" Still going and the last words."}]],"end":{"mode":"native","sentText":true,"stoppedByUser":false}}"####,
    r####"{"scenario":{"name":"native: the task cap rolls the stream over","opts":{"maxStreamTasks":2},"steps":[["toolStart","1","one"],["toolStart","2","two"],["toolDone","1","one done",true],["toolStart","3","three"],["toolDone","2","two done",false],["finish"]]},"calls":[["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"task_update","id":"1","title":"one","status":"in_progress"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"task_update","id":"2","title":"two","status":"in_progress"}]}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"task_update","id":"1","title":"one done","status":"complete"}]}],["stopStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"task_update","id":"2","title":"two","status":"pending","details":"Continued below"}],"session_status":"processing"}],["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"task_update","id":"2","title":"two","status":"in_progress"},{"type":"task_update","id":"3","title":"three","status":"in_progress"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-5","chunks":[{"type":"task_update","id":"2","title":"two done","status":"error"}]}],["stopStream",{"channel":"C1","ts":"startStream-5","chunks":[{"type":"task_update","id":"3","title":"three","status":"error","details":"Did not finish"}]}]],"end":{"mode":"native","sentText":false,"stoppedByUser":false}}"####,
    r####"{"scenario":{"name":"editing: long CJK and code over small messages, a tool that never finishes","opts":{"native":false,"maxMessageChars":40},"steps":[["text","前書き\n"],["toolStart","t","Running command…"],["advance",2000],["text","```sh\n"],["advance",2000],["text","echo 字 0\n"],["advance",2000],["text","echo 字字 1\n"],["advance",2000],["text","echo 字字字 2\n"],["advance",2000],["text","echo 字字字字 3\n"],["advance",2000],["text","echo 字字字字字 4\n"],["advance",2000],["text","echo 字字字字字字 5\n"],["advance",2000],["text","echo 字字字字字字字 6\n"],["advance",2000],["text","```\n"],["advance",2000],["text","あとがき 長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長"],["finish"]]},"calls":[["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"前書き\n"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"⚙️ _Running command…_"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"```sh\n```"}],["update",{"channel":"C1","ts":"postMessage-3","markdown_text":"```sh\necho 字 0\n```"}],["update",{"channel":"C1","ts":"postMessage-3","markdown_text":"```sh\necho 字 0\necho 字字 1\n```"}],["update",{"channel":"C1","ts":"postMessage-3","markdown_text":"```sh\necho 字 0\necho 字字 1\necho 字字字 2\n```"}],["update",{"channel":"C1","ts":"postMessage-3","markdown_text":"```sh\necho 字 0\necho 字字 1\n```"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"```sh\necho 字字字 2\necho 字字字字 3\n```"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"```sh\necho 字字字字字 4\n```"}],["update",{"channel":"C1","ts":"postMessage-9","markdown_text":"```sh\necho 字字字字字 4\necho 字字字字字字 5\n```"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"```sh\necho 字字字字字字字 6\n```"}],["update",{"channel":"C1","ts":"postMessage-11","markdown_text":"```sh\necho 字字字字字字字 6\n```\n"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"あとがき 長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長"}],["update",{"channel":"C1","ts":"postMessage-2","markdown_text":"❌ _Running command… — did not finish_"}]],"end":{"mode":"edit","sentText":true,"stoppedByUser":false}}"####,
    r####"{"scenario":{"name":"native: stopped by the person, then more text and tools","opts":{},"fail":{"appendStream":{"1":"stopped_by_user"}},"steps":[["text","one "],["advance",2000],["text","two"],["toolStart","x","X"],["toolDone","x","X done",true],["text","three"],["finish"]]},"calls":[["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"one "}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"two"}]}],["stopStream",{"channel":"C1","ts":"startStream-1"}]],"end":{"mode":"native","sentText":true,"stoppedByUser":true}}"####,
    r####"{"scenario":{"name":"native: emoji already in the stream count two units each toward the cap","opts":{"maxStreamChars":20},"steps":[["text","😀 one\n"],["advance",1500],["text","🐒🐒 two\n"],["advance",1500],["text","three 🎉\n"],["advance",1500],["text","four 🇵🇭 five\n"],["advance",1500],["text","six"],["finish"]]},"calls":[["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"😀 one\n"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"🐒🐒 two\n"}]}],["appendStream",{"channel":"C1","ts":"startStream-1","chunks":[{"type":"markdown_text","text":"thre"}]}],["stopStream",{"channel":"C1","ts":"startStream-1","session_status":"processing"}],["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"e 🎉\n"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["appendStream",{"channel":"C1","ts":"startStream-5","chunks":[{"type":"markdown_text","text":"four 🇵🇭 five\n"}]}],["stopStream",{"channel":"C1","ts":"startStream-5","session_status":"processing"}],["startStream",{"channel":"C1","thread_ts":"100.1","task_display_mode":"timeline","chunks":[{"type":"markdown_text","text":"six"}],"recipient_user_id":"U1","recipient_team_id":"T1"}],["stopStream",{"channel":"C1","ts":"startStream-8"}]],"end":{"mode":"native","sentText":true,"stoppedByUser":false}}"####,
    r####"{"scenario":{"name":"editing: emoji count two units each toward the message size","opts":{"native":false,"maxMessageChars":20},"steps":[["text","😀😀😀😀 a\n"],["advance",2000],["text","🐒 bb\n"],["advance",2000],["text","ccc dd\n"],["advance",2000],["text","eeee 🎉\n"],["finish"]]},"calls":[["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"😀😀😀😀 a\n"}],["update",{"channel":"C1","ts":"postMessage-1","markdown_text":"😀😀😀😀 a\n🐒 bb\n"}],["update",{"channel":"C1","ts":"postMessage-1","markdown_text":"😀😀😀😀 a\n"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"🐒 bb\nccc dd\n"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"eeee 🎉\n"}]],"end":{"mode":"edit","sentText":true,"stoppedByUser":false}}"####,
    r####"{"scenario":{"name":"editing: a status line whose post fails, and an update that fails","opts":{"native":false},"fail":{"postMessage":{"2":"ratelimited"},"update":"internal_error"},"steps":[["text","a"],["toolStart","t","T"],["toolDone","t","T done",true],["advance",2000],["text","b"],["advance",2000],["text","c"],["finish"]]},"calls":[["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"a"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"⚙️ _T_"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"✓ _T done_"}],["postMessage",{"channel":"C1","thread_ts":"100.1","markdown_text":"b"}],["update",{"channel":"C1","ts":"postMessage-3","markdown_text":"bc"}]],"end":{"mode":"edit","sentText":true,"stoppedByUser":false}}"####,
];
