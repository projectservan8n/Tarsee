//! Port of `test/chat-core.test.js`: the dashboard chat's rules (`src/public/js/chat-core.js`, `ChatCore`): the
//! sidebar's groups, the chats' names and times, their addresses, the one line for each tool step and for a turn, a
//! saved reply's parts, and the Markdown renderer.

use chrono::{DateTime, TimeZone, Utc};
use serde_json::{Value, json};

use crate::support::Page;

async fn chat_core() -> Page {
    Page::with_scripts(&["chat-core.js"]).await
}

/// `Date.UTC(2026, 9, 25, 12, 0, 0)`.
fn now() -> i64 {
    utc(2026, 10, 25, 12)
}

fn utc(year: i32, month: u32, day: u32, hour: u32) -> i64 {
    Utc.with_ymd_and_hms(year, month, day, hour, 0, 0)
        .single()
        .expect("a date")
        .timestamp_millis()
}

/// That many minutes before `now()`, in SQLite's UTC form ("2026-10-25 11:56:00").
fn ago(min: i64) -> String {
    DateTime::from_timestamp_millis(now() - min * 60_000)
        .expect("a time")
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// A chat as the server lists it.
fn ch(key: &str, title: &str, min: Option<i64>) -> Value {
    json!({
        "key": key,
        "platform": key.split(':').next(),
        "title": title,
        "conversationId": key,
        "updatedAt": min.map(ago),
    })
}

fn channels() -> Value {
    json!([
        ch("discord:1", "#ask-agent", Some(4)),
        ch("telegram:1", "Chat with alice", Some(300)),
        ch("web:default", "Web Chat", Some(20)),
        ch("web:old", "Quarterly notes", Some(60 * 24 * 13)),
        ch("discord:2", "#content", Some(8)),
        ch("whatsapp:15550100", "WhatsApp · Bob", Some(70)),
        ch("email:thread-1", "Email: Invoice for October", Some(30)),
        ch("slack:1", "#ops", Some(5)),
        ch("web:a1b2", "Plan the launch", Some(2)),
    ])
}

/// `ChatCore.groupChats(chats, { now, <options> })`, the options written in JavaScript (they hold `Set`s).
async fn group_chats(page: &Page, chats: Value, options: &str) -> Value {
    page.apply(
        &format!("(chats, now) => ChatCore.groupChats(chats, {{ now, {options} }})"),
        json!([chats, now()]),
    )
    .await
}

/// `list.map((x) => x[key])`.
fn pluck(list: &Value, key: &str) -> Value {
    Value::Array(
        list.as_array()
            .expect("a list")
            .iter()
            .map(|x| x[key].clone())
            .collect(),
    )
}

/// `list.find((x) => x[key] === value)`.
fn find<'a>(list: &'a Value, key: &str, value: &str) -> &'a Value {
    list.as_array()
        .expect("a list")
        .iter()
        .find(|x| x[key] == value)
        .unwrap_or_else(|| panic!("no {key} {value} in {list}"))
}

fn rows(group: &Value) -> &Vec<Value> {
    group["rows"].as_array().expect("rows")
}

// ---------------------------------------------------------------- the sidebar's groups

#[tokio::test]
async fn grouped_by_where_they_live_in_a_fixed_order_plain_names_newest_first_in_each() {
    let page = chat_core().await;
    let groups = group_chats(&page, channels(), "").await;
    assert_eq!(
        pluck(&groups, "label"),
        json!(["Web", "Telegram", "Discord", "WhatsApp", "Email", "Slack"])
    );
    let web = &groups[0];
    assert_eq!(
        pluck(&web["rows"], "name"),
        json!(["Plan the launch", "Main Session", "Quarterly notes"])
    );
    assert_eq!(
        pluck(&find(&groups, "id", "discord")["rows"], "name"),
        json!(["#ask-agent", "#content"])
    );
    assert_eq!(find(&groups, "id", "telegram")["rows"][0]["name"], "alice");
    assert_eq!(
        find(&groups, "id", "whatsapp")["rows"][0]["name"],
        "Bob",
        "WhatsApp's own prefix goes"
    );
    assert_eq!(
        find(&groups, "id", "email")["rows"][0]["name"],
        "Invoice for October",
        "an email thread is its subject"
    );
}

#[tokio::test]
async fn no_emoji_or_icon_in_any_name() {
    let page = chat_core().await;
    let pictographic = regex::Regex::new(r"\p{Extended_Pictographic}").expect("regex");
    for group in group_chats(&page, channels(), "").await.as_array().expect("groups") {
        for row in rows(group) {
            let name = row["name"].as_str().expect("a name");
            assert!(!pictographic.is_match(name), "{name}");
        }
    }
}

#[tokio::test]
async fn the_quiet_time_on_each_row() {
    let page = chat_core().await;
    let groups = group_chats(&page, channels(), "").await;
    let all: Vec<Value> = groups
        .as_array()
        .expect("groups")
        .iter()
        .flat_map(|g| rows(g).clone())
        .collect();
    let all = Value::Array(all);
    let time = |name: &str| find(&all, "name", name)["time"].clone();
    assert_eq!(time("#ask-agent"), "4m");
    assert_eq!(time("alice"), "5h");
    assert_eq!(time("Quarterly notes"), "Oct 12");
}

#[tokio::test]
async fn the_main_session_is_there_before_it_has_a_conversation() {
    let page = chat_core().await;
    let groups = group_chats(&page, json!([ch("discord:1", "#a", Some(1))]), "").await;
    assert_eq!(groups[0]["id"], "web");
    let pairs: Vec<Value> = rows(&groups[0])
        .iter()
        .map(|r| json!([r["name"], r["convId"]]))
        .collect();
    assert_eq!(Value::Array(pairs), json!([["Main Session", null]]));
}

#[tokio::test]
async fn the_open_chat_is_marked_a_working_one_has_its_dot_an_unread_one_is_marked_unless_it_is_open() {
    let page = chat_core().await;
    let groups = group_chats(
        &page,
        channels(),
        "current: 'discord:2', working: new Set(['discord:1']), unread: new Set(['discord:1', 'discord:2'])",
    )
    .await;
    let d = find(&groups, "id", "discord");
    let marks: Vec<Value> = rows(d)
        .iter()
        .map(|r| json!([r["name"], r["current"], r["working"], r["unread"]]))
        .collect();
    assert_eq!(
        Value::Array(marks),
        json!([["#ask-agent", false, true, true], ["#content", true, false, false]])
    );
    assert_eq!(d["working"], 1);
    let fresh = group_chats(&page, channels(), "current: null, currentKey: 'web:default'").await;
    assert_eq!(
        find(&fresh[0]["rows"], "name", "Main Session")["current"],
        true,
        "a chat with no conversation yet is found by its key"
    );
}

#[tokio::test]
async fn a_long_group_shows_its_first_rows_and_how_many_more_the_open_one_and_a_working_one_always_show() {
    let page = chat_core().await;
    let many: Vec<Value> = (0..20)
        .map(|i| ch(&format!("discord:{i}"), &format!("#c{i}"), Some(i + 1)))
        .collect();
    let many = Value::Array(many);
    let groups = group_chats(
        &page,
        many.clone(),
        "limit: 8, current: 'discord:15', working: new Set(['discord:19'])",
    )
    .await;
    let g = find(&groups, "id", "discord");
    assert_eq!(g["total"], 20);
    assert_eq!(rows(g).len(), 10);
    assert_eq!(g["more"], 10);
    assert!(rows(g).iter().any(|r| r["name"] == "#c15") && rows(g).iter().any(|r| r["name"] == "#c19"));
    let all = group_chats(&page, many, "limit: 8, expanded: new Set(['discord'])").await;
    let all = find(&all, "id", "discord");
    assert_eq!(rows(all).len(), 20);
    assert_eq!(all["more"], 0);
}

#[tokio::test]
async fn a_collapsed_group_says_so_unless_the_open_chat_is_in_it() {
    let page = chat_core().await;
    let groups = group_chats(
        &page,
        channels(),
        "collapsed: new Set(['discord', 'telegram']), current: 'telegram:1'",
    )
    .await;
    assert_eq!(find(&groups, "id", "discord")["collapsed"], true);
    assert_eq!(find(&groups, "id", "telegram")["collapsed"], false);
}

#[tokio::test]
async fn the_search_box_every_word_somewhere_in_the_name_or_the_group_nothing_folded_or_collapsed_while_searching() {
    let page = chat_core().await;
    let groups = group_chats(&page, channels(), "query: 'disc ask', collapsed: new Set(['discord'])").await;
    assert_eq!(pluck(&groups, "id"), json!(["discord"]));
    assert_eq!(pluck(&groups[0]["rows"], "name"), json!(["#ask-agent"]));
    assert_eq!(groups[0]["collapsed"], false);
    assert_eq!(group_chats(&page, channels(), "query: 'zzz'").await, json!([]));
    assert_eq!(
        pluck(&group_chats(&page, channels(), "query: 'telegram'").await, "id"),
        json!(["telegram"])
    );
}

#[tokio::test]
async fn crons_and_the_heartbeat_at_work_show_under_background_working_while_they_run() {
    let page = chat_core().await;
    let groups = group_chats(
        &page,
        channels(),
        "background: [{ conversationId: 'cron:cron_morning', label: 'Cron · morning' }]",
    )
    .await;
    let bg = groups.as_array().expect("groups").last().expect("a group");
    assert_eq!(bg["id"], "background");
    let shown: Vec<Value> = rows(bg)
        .iter()
        .map(|r| json!([r["name"], r["working"], r["key"]]))
        .collect();
    assert_eq!(
        Value::Array(shown),
        json!([["Cron · morning", true, "live:cron:cron_morning"]])
    );
}

// ---------------------------------------------------------------- names and times

#[tokio::test]
async fn names() {
    let page = chat_core().await;
    let name = |chat: Value| {
        let page = &page;
        async move { page.call("ChatCore.chatName", json!([chat])).await }
    };
    assert_eq!(
        name(json!({ "key": "web:default", "title": "Web Chat" })).await,
        "Main Session"
    );
    assert_eq!(
        name(json!({ "key": "web:x", "platform": "web", "title": "Web Chat" })).await,
        "New chat"
    );
    assert_eq!(
        name(json!({ "key": "web:x", "platform": "web", "title": "Plan the launch" })).await,
        "Plan the launch"
    );
    assert_eq!(
        name(json!({ "key": "discord:1", "platform": "discord", "title": "#a-very-long-channel-name-that-goes-on" }))
            .await,
        "#a-very-long-channel-name-that-goes-on",
        "the sidebar cuts it with CSS, not here"
    );
}

#[tokio::test]
async fn times_now_minutes_hours_days_then_the_date_with_the_year_when_it_is_another() {
    let page = chat_core().await;
    let label = |at: Value| {
        let page = &page;
        async move { page.call("ChatCore.timeLabel", json!([at, now()])).await }
    };
    assert_eq!(label(json!(now() - 20_000)).await, "now");
    assert_eq!(label(json!(ago(59))).await, "59m");
    assert_eq!(label(json!(ago(60 * 23))).await, "23h");
    assert_eq!(label(json!(ago(60 * 24 * 6))).await, "6d");
    assert_eq!(label(json!(utc(2026, 1, 3, 12))).await, "Jan 3");
    assert_eq!(label(json!(utc(2025, 12, 30, 12))).await, "Dec 30, 2025");
    assert_eq!(label(Value::Null).await, "");
    assert_eq!(label(json!("not a date")).await, "");
}

// ---------------------------------------------------------------- a chat's own address

#[tokio::test]
async fn chat_id_both_ways() {
    let page = chat_core().await;
    let path = |id: Value| {
        let page = &page;
        async move { page.call("ChatCore.chatPath", json!([id])).await }
    };
    let parse = |p: &str| {
        let page = &page;
        let p = p.to_string();
        async move { page.call("ChatCore.parseChatPath", json!([p])).await }
    };
    for id in ["0e6b4e21-2bd3-4b94-81cb-9740dee92ac8", "cron:cron_morning", "heartbeat"] {
        let p = path(json!(id)).await;
        assert_eq!(p, json!(format!("/chat/{id}")));
        assert_eq!(
            parse(p.as_str().expect("a path")).await,
            json!({ "kind": "chat", "id": id })
        );
    }
    assert_eq!(path(Value::Null).await, "/chat/new");
    assert_eq!(parse("/chat/new").await, json!({ "kind": "new" }));
    assert_eq!(parse("/chat").await, json!({ "kind": "new" }));
    assert_eq!(parse("/").await, json!({ "kind": "root" }));
    assert_eq!(parse("/index.html").await, json!({ "kind": "root" }));
    assert_eq!(
        parse("/chat/cron%3Ajob").await,
        json!({ "kind": "chat", "id": "cron:job" })
    );
    assert_eq!(parse("/chat/a/b").await, json!({ "kind": "other" }));
    assert_eq!(
        parse("/chat/%E0%A4%A").await,
        json!({ "kind": "other" }),
        "a broken escape"
    );
    assert_eq!(parse("/chat/<script>").await, json!({ "kind": "other" }));
}

#[tokio::test]
async fn the_tabs_title() {
    let page = chat_core().await;
    let title = |name: &str| {
        let page = &page;
        let name = name.to_string();
        async move { page.call("ChatCore.pageTitle", json!([name, "Tarsee"])).await }
    };
    assert_eq!(title("#ask-agent").await, "#ask-agent · Tarsee");
    assert_eq!(title("").await, "Tarsee");
    assert_eq!(title("Tarsee").await, "Tarsee");
}

// ---------------------------------------------------------------- one line for each step

/// `ChatCore.stepLabel({ name, summary }, { running })`.
async fn step(page: &Page, name: &str, summary: &str, running: bool) -> String {
    let label = page
        .call(
            "ChatCore.stepLabel",
            json!([{ "name": name, "summary": summary }, { "running": running }]),
        )
        .await;
    label.as_str().expect("a label").to_string()
}

#[tokio::test]
async fn bash_its_own_description_never_the_raw_command() {
    let page = chat_core().await;
    let l = |name: &'static str, summary: &'static str, running: bool| step(&page, name, summary, running);
    assert_eq!(
        l("Bash", "Check Railway account workspaces and helper script", false).await,
        "Check Railway account workspaces and helper script"
    );
    assert_eq!(
        l("Bash", r#"cd "/Users/x/repo"; git status -sb | head -3"#, false).await,
        "Ran git status"
    );
    assert_eq!(
        l(
            "Bash",
            r#"for u in https://a https://b; do echo "== $u"; curl -sS $u; done"#,
            true
        )
        .await,
        "Running curl"
    );
    assert_eq!(l("Bash", "curl -sS https://e.com | jq .", false).await, "Ran curl");
    assert_eq!(
        l("Bash", "sudo FOO=1 launchctl kickstart -k gui/501/x", false).await,
        "Ran launchctl kickstart"
    );
    assert_eq!(l("Bash", "cd /x && sleep 2 && npm test", false).await, "Ran npm test");
    assert_eq!(l("Bash", "", false).await, "Ran a command");
}

#[tokio::test]
async fn an_older_step_that_kept_its_arguments_as_json_whole_or_cut_off_their_description_not_the_json() {
    let page = chat_core().await;
    assert_eq!(
        step(
            &page,
            "Agent",
            r#"{"description":"Build cookie consent + policy, both sites","subagent_type":"gene"#,
            false
        )
        .await,
        "Asked a helper: Build cookie consent + policy, both sites"
    );
    assert_eq!(
        step(&page, "Read", r#"{"file_path":"/a/b/README.md"}"#, false).await,
        "Read README.md"
    );
    assert_eq!(
        page.call("ChatCore.summaryOf", json!(["plain words"])).await,
        "plain words"
    );
    assert_eq!(page.call("ChatCore.summaryOf", json!([r#"{"x":1}"#])).await, "");
}

#[tokio::test]
async fn the_others_present_while_running_and_past_after() {
    let page = chat_core().await;
    let l = |name: &'static str, summary: &'static str, running: bool| step(&page, name, summary, running);
    assert_eq!(
        l("Read", "…/workspace/repos/tarsee-template/README.md", true).await,
        "Reading README.md"
    );
    assert_eq!(l("Read", "/a/b/c.js", false).await, "Read c.js");
    assert_eq!(l("Edit", "/a/style.css", false).await, "Edited style.css");
    assert_eq!(l("Write", "/a/new.md", true).await, "Writing new.md");
    assert_eq!(
        l("Grep", "cookie in src/pages", false).await,
        r#"Searched for "cookie""#
    );
    assert_eq!(
        l("WebSearch", "burgman seat 44K10", false).await,
        "Searched the web: burgman seat 44K10"
    );
    assert_eq!(
        l("web_search", "Tarsee Railway template", true).await,
        "Searching the web: Tarsee Railway template"
    );
    assert_eq!(
        l("WebFetch", "https://www.shopee.ph/burgman-seat", false).await,
        "Read shopee.ph"
    );
    assert_eq!(
        l("Agent", "Build cookie consent + policy, both sites", false).await,
        "Asked a helper: Build cookie consent + policy, both sites"
    );
    assert_eq!(
        l("TodoWrite", "updating the task list", true).await,
        "Updating the plan"
    );
    assert_eq!(
        l("mcp__tarsee__send_message", "photos", false).await,
        "Sent a message: photos"
    );
    assert_eq!(
        l("tarsee_canvas_create", "cookie banner diagram", false).await,
        "Canvas create: cookie banner diagram"
    );
    assert_eq!(l("ToolSearch", "", false).await, "Looked up tools");
}

#[tokio::test]
async fn short_a_long_description_is_cut() {
    let page = chat_core().await;
    let label = step(&page, "Bash", &"Explain ".repeat(40), false).await;
    // (JavaScript's length: UTF-16 units.)
    assert!(label.encode_utf16().count() <= 110, "{label}");
}

// ---------------------------------------------------------------- the line in the answer's place

async fn turn_line(page: &Page, turn: Value) -> Value {
    page.call("ChatCore.turnLine", json!([turn])).await
}

#[tokio::test]
async fn while_he_works_after_and_when_it_went_wrong() {
    let page = chat_core().await;
    assert_eq!(
        turn_line(
            &page,
            json!({ "state": "running", "tools": 3, "last": "Reading README.md" })
        )
        .await,
        json!({ "title": "Working", "detail": "3 steps · Reading README.md", "tone": "running" })
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "running", "tools": 0 })).await,
        json!({ "title": "Working", "detail": "Thinking", "tone": "running" })
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "done", "tools": 12, "ms": 16_000 })).await,
        json!({ "title": "Used 12 tools", "detail": "16s", "tone": "muted" })
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "done", "tools": 1, "failed": 1, "ms": 61_000 })).await,
        json!({ "title": "Used 1 tool", "detail": "1m 01s · 1 failed", "tone": "warn" })
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "done", "tools": 0 })).await["title"],
        "",
        "no tools: no line, the answer says it all"
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "stopped", "tools": 2, "ms": 9000 })).await["title"],
        "Stopped after 9s"
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "failed", "error": "The model refused" })).await["detail"],
        "The model refused"
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "interrupted" })).await["detail"],
        "Tarsee restarted during this turn"
    );
}

#[tokio::test]
async fn a_turn_waiting_behind_the_running_one_says_so_not_working_not_thinking_no_time() {
    let page = chat_core().await;
    assert_eq!(
        turn_line(
            &page,
            json!({ "state": "queued", "tools": 0, "ms": 12_000, "last": "Thinking" })
        )
        .await,
        json!({ "title": "Queued", "detail": "after the reply above", "tone": "muted" })
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "removed" })).await,
        json!({ "title": "Removed from the queue", "detail": "", "tone": "muted" })
    );
    for state in ["queued", "removed"] {
        let line = turn_line(&page, json!({ "state": state })).await.to_string();
        assert!(!line.contains(['\u{2013}', '\u{2014}']), "no long dashes: {line}");
    }
}

#[tokio::test]
async fn while_it_thinks_the_line_names_the_ai_that_answers_design_5_thinking_with_deepseek_flash() {
    let page = chat_core().await;
    assert_eq!(
        turn_line(
            &page,
            json!({ "state": "running", "tools": 0, "model": "DeepSeek Flash" })
        )
        .await,
        json!({ "title": "Working", "detail": "Thinking with DeepSeek Flash", "tone": "running" })
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "running", "tools": 2, "model": "GPT-6 Luna" })).await["detail"],
        "2 steps \u{b7} Thinking with GPT-6 Luna"
    );
    assert_eq!(
        turn_line(
            &page,
            json!({ "state": "running", "tools": 1, "last": "Reading README.md", "model": "GPT-6 Luna" })
        )
        .await["detail"],
        "1 step \u{b7} Reading README.md",
        "a step on now says what it does"
    );
    assert_eq!(
        turn_line(&page, json!({ "state": "queued", "model": "GPT-6 Luna" })).await["detail"],
        "after the reply above"
    );
}

// ---------------------------------------------------------------- a saved reply's parts

#[tokio::test]
async fn timeline_json_the_answer_what_he_said_on_the_way_the_tools_with_a_one_line_summary() {
    let page = chat_core().await;
    let content = json!({ "__timeline": true, "text": "Both sites set cookies.", "items": [
        { "type": "text", "text": "I'll look at both sites first." },
        { "type": "tool", "name": "Bash", "summary": "Check the headers", "detail": "curl -sS -D - https://a", "input": "curl -sS -D - https://a", "output": "HTTP/2 200", "status": "done" },
        { "type": "tool", "name": "Read", "detail": "/x/Privacy.jsx", "input": "/x/Privacy.jsx", "output": "", "status": "running" },
        { "type": "text", "text": "Both sites set cookies." },
    ] })
    .to_string();
    let p = page.call("ChatCore.replyParts", json!([content])).await;
    assert_eq!(p["answer"], "Both sites set cookies.");
    assert_eq!(p["notes"], json!(["I'll look at both sites first."]));
    assert_eq!(p["tools"].as_array().expect("tools").len(), 2);
    assert_eq!(
        json!([p["tools"][0]["summary"], p["tools"][0]["output"]]),
        json!(["Check the headers", "HTTP/2 200"])
    );
    assert_eq!(
        p["tools"][1]["summary"], "/x/Privacy.jsx",
        "an old step with no summary: its detail"
    );
    assert_eq!(
        pluck(&p["steps"], "type"),
        json!(["note", "tool", "tool"]),
        "in the order they happened, the answer itself left out"
    );
}

#[tokio::test]
async fn a_note_that_is_the_answer_with_its_bold_marks_is_still_the_answer() {
    let page = chat_core().await;
    let content = json!({ "__timeline": true, "text": "It says **March 2025**.\n\nMore.", "items": [
        { "type": "tool", "name": "Bash", "detail": "ls" },
        { "type": "text", "text": "It says March 2025." },
    ] })
    .to_string();
    let p = page.call("ChatCore.replyParts", json!([content])).await;
    assert_eq!(p["notes"], json!([]));
}

#[tokio::test]
async fn the_engines_shape_the_final_words_first_then_the_tools_the_answer_is_still_the_words() {
    let page = chat_core().await;
    let content = json!({ "__timeline": true, "text": "Done.", "items": [
        { "type": "text", "text": "Done." },
        { "type": "tool", "name": "Bash", "detail": "ls" },
    ] })
    .to_string();
    let p = page.call("ChatCore.replyParts", json!([content])).await;
    assert_eq!(p["answer"], "Done.");
    assert_eq!(p["notes"], json!([]));
    assert_eq!(p["tools"].as_array().expect("tools").len(), 1);
}

#[tokio::test]
async fn a_channel_reply_its_words_with_the_slim_list_of_tools_beside_it() {
    let page = chat_core().await;
    let p = page
        .call(
            "ChatCore.replyParts",
            json!([
                "You need the seat.",
                [{ "name": "Bash", "summary": "List downloads" }, { "name": "Read", "summary": "/a/seat.jpg" }]
            ]),
        )
        .await;
    assert_eq!(p["answer"], "You need the seat.");
    assert_eq!(pluck(&p["tools"], "name"), json!(["Bash", "Read"]));
}

#[tokio::test]
async fn who_said_it_name_words() {
    let page = chat_core().await;
    assert_eq!(
        page.call("ChatCore.sender", json!(["[alice]: yeah do an audit"])).await,
        json!({ "who": "alice", "body": "yeah do an audit" })
    );
    assert_eq!(
        page.call("ChatCore.sender", json!(["just words"])).await,
        json!({ "who": "", "body": "just words" })
    );
}

// ---------------------------------------------------------------- Markdown

async fn md(page: &Page, text: Value) -> String {
    let html = page.call("ChatCore.renderMarkdown", json!([text])).await;
    html.as_str().expect("HTML").to_string()
}

#[tokio::test]
async fn paragraphs_keep_their_line_breaks_a_blank_line_is_a_new_paragraph() {
    let page = chat_core().await;
    assert_eq!(
        md(&page, json!("one\ntwo\n\nthree")).await,
        "<p>one<br>two</p><p>three</p>"
    );
}

#[tokio::test]
async fn bold_italic_strike_and_code_snake_case_is_not_italic_nothing_is_formatted_inside_code() {
    let page = chat_core().await;
    assert_eq!(
        md(&page, json!("**b** *i* _u_ ~~s~~ `**x**` my_var_name *a*")).await,
        "<p><strong>b</strong> <em>i</em> <em>u</em> <del>s</del> <code>**x**</code> my_var_name <em>a</em></p>"
    );
}

#[tokio::test]
async fn headings_a_rule_a_quote() {
    let page = chat_core().await;
    assert_eq!(
        md(&page, json!("## Plan\n---\n> We use one cookie\n> to keep you in")).await,
        "<h2>Plan</h2><hr><blockquote><p>We use one cookie<br>to keep you in</p></blockquote>"
    );
}

#[tokio::test]
async fn lists_bullets_numbers_from_where_they_start_nested_and_an_items_words_over_two_lines() {
    let page = chat_core().await;
    assert_eq!(md(&page, json!("- a\n- b")).await, "<ul><li>a</li><li>b</li></ul>");
    assert_eq!(
        md(&page, json!("3. c\n4. d")).await,
        r#"<ol start="3"><li>c</li><li>d</li></ol>"#
    );
    assert_eq!(
        md(&page, json!("- a\n  - a1\n  - a2\n- b")).await,
        "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>"
    );
    assert_eq!(
        md(&page, json!("1. **Cost check.** What they must set,\nwhat breaks")).await,
        "<ol><li><strong>Cost check.</strong> What they must set,<br>what breaks</li></ol>"
    );
    assert_eq!(
        md(&page, json!("Here:\n- a\n- b")).await,
        "<p>Here:</p><ul><li>a</li><li>b</li></ul>",
        "a list right under a line of words"
    );
}

#[tokio::test]
async fn a_table_with_its_columns_alignment() {
    let page = chat_core().await;
    let html = md(
        &page,
        json!("| Site | Before | After |\n|---|---:|:-:|\n| academy | 4 | 1 |"),
    )
    .await;
    assert!(
        html.starts_with(
            r#"<div class="md-table-wrap"><table class="md-table"><thead><tr><th>Site</th><th style="text-align:right">Before</th><th style="text-align:center">After</th></tr></thead><tbody><tr><td>academy</td>"#
        ),
        "{html}"
    );
}

#[tokio::test]
async fn a_code_block_escaped_its_language_a_copy_button_one_still_being_written_takes_the_rest() {
    let page = chat_core().await;
    assert_eq!(
        md(&page, json!("```js\nif (a < b) alert(1)\n```")).await,
        r#"<div class="code-block"><div class="code-header"><span>js</span><button type="button" class="copy-btn">Copy</button></div><pre><code class="lang-js">if (a &lt; b) alert(1)</code></pre></div>"#
    );
    let open = md(&page, json!("```\nstill coming")).await;
    assert!(open.contains("<code>still coming</code>"), "{open}");
}

#[tokio::test]
async fn links_only_safe_ones_bare_links_too_without_the_sentences_full_stop() {
    let page = chat_core().await;
    assert_eq!(
        md(&page, json!("[Shopee listing](https://shopee.ph/x?a=1&b=2)")).await,
        r#"<p><a href="https://shopee.ph/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Shopee listing</a></p>"#
    );
    assert_eq!(md(&page, json!("[bad](javascript:alert(1))")).await, "<p>bad</p>");
    let broke = md(&page, json!(r#"[x](https://e.com/" onmouseover="alert(1))"#)).await;
    assert!(
        !broke.contains(r#"onmouseover=""#),
        "a quote never closes the href: {broke}"
    );
    let href = regex::Regex::new(r#"href="([^"]*)""#).expect("regex");
    for m in href.captures_iter(&broke) {
        assert!(!m[1].contains(['"', '<', '>']), "{}", &m[1]);
    }
    assert_eq!(
        md(&page, json!("See https://example.com/canvas.")).await,
        r#"<p>See <a href="https://example.com/canvas" target="_blank" rel="noopener noreferrer">https://example.com/canvas</a>.</p>"#
    );
    assert_eq!(
        md(&page, json!("[`code` here](/chat/x)")).await,
        r#"<p><a href="/chat/x" target="_blank" rel="noopener noreferrer"><code>code</code> here</a></p>"#
    );
}

#[tokio::test]
async fn html_in_a_message_is_only_text() {
    let page = chat_core().await;
    let html = md(
        &page,
        json!(r#"<img src=x onerror="alert(1)"> <script>alert(1)</script>"#),
    )
    .await;
    assert!(!html.contains("<img") && !html.contains("<script"), "{html}");
    assert!(
        html.contains("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"),
        "{html}"
    );
}

#[tokio::test]
async fn a_pages_own_block_token_passes_through_on_its_line() {
    let page = chat_core().await;
    assert_eq!(
        md(&page, json!("Here it is:\n\u{0}3\u{0}\nNice?")).await,
        "<p>Here it is:</p>\u{0}3\u{0}<p>Nice?</p>"
    );
}

#[tokio::test]
async fn nothing_nothing() {
    let page = chat_core().await;
    assert_eq!(md(&page, json!("")).await, "");
    assert_eq!(md(&page, Value::Null).await, "");
}
