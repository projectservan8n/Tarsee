//! Port of `test/dialogs.test.js`: Tarsee's own questions (`src/public/js/dialogs.js`, `TarseeDialog`) in place of
//! the browser's `confirm()` and `prompt()`: the parts that need no page (`TarseeDialog.core`), and how the dashboard
//! loads it.
//!
//! The Node test faked what the browser gives (a page-less global, objects standing in for elements); here the file
//! runs in a real browser: "no page" is a worker (no window, no document) and a page whose body is gone, and the
//! elements focus goes back to are real ones.

use regex::Regex;
use serde_json::{Value, json};

use crate::support::Page;
use crate::support::files::read_public;

async fn dialogs() -> Page {
    Page::with_scripts(&["dialogs.js"]).await
}

async fn core(page: &Page, name: &str, args: Value) -> Value {
    page.call(&format!("TarseeDialog.core.{name}"), args).await
}

async fn settle_ms(page: &Page) -> i64 {
    page.eval("TarseeDialog.core.SETTLE_MS")
        .await
        .as_i64()
        .expect("SETTLE_MS")
}

// ---------------------------------------------------------------- the helper on the window

#[tokio::test]
async fn is_there_once_with_a_yes_or_no_question_and_a_text_question() {
    let page = dialogs().await;
    assert_eq!(page.eval("typeof TarseeDialog.ask").await, "function");
    assert_eq!(page.eval("typeof TarseeDialog.askText").await, "function");
    assert_eq!(page.eval("TarseeDialog.isOpen()").await, false);
    assert_eq!(
        page.eval("Object.isFrozen(TarseeDialog)").await,
        true,
        "nothing on the page can swap it"
    );
}

#[tokio::test]
async fn with_no_page_to_ask_on_the_answer_is_no_false_or_null_for_text_nothing_is_done_unasked() {
    let page = dialogs().await;
    // No page at all: the file in a worker, which has no window and no document.
    let answers = page
        .eval(
            r#"new Promise((resolve, reject) => {
                const src = `importScripts(${JSON.stringify(location.origin + "/js/dialogs.js")});
                  (async () => {
                    const D = self.TarseeDialog;
                    const ask = await D.ask({ title: "Delete it?" });
                    const askText = await D.askText({ title: "New file", label: "File name" });
                    postMessage({ ask, askText, askTextIsNull: askText === null });
                  })();`;
                const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
                worker.onmessage = (e) => { worker.terminate(); resolve(e.data); };
                worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
            })"#,
        )
        .await;
    assert_eq!(answers, json!({ "ask": false, "askText": null, "askTextIsNull": true }));
    // A page with nothing to show it on: its body gone.
    page.eval("document.body.remove()").await;
    assert_eq!(page.eval("TarseeDialog.ask({ title: 'Delete it?' })").await, false);
    assert_eq!(
        page.eval("TarseeDialog.askText({ title: 'New file', label: 'File name' }).then((v) => v === null)")
            .await,
        true
    );
    assert_eq!(page.eval("TarseeDialog.isOpen()").await, false);
}

// ---------------------------------------------------------------- the words of a question

#[tokio::test]
async fn a_blank_line_starts_a_new_paragraph_a_single_line_break_is_a_space() {
    let page = dialogs().await;
    assert_eq!(
        core(
            &page,
            "paragraphs",
            json!(["Clear this conversation?\n\nIts messages are deleted.\nThis can't be undone."])
        )
        .await,
        json!([
            "Clear this conversation?",
            "Its messages are deleted. This can't be undone."
        ])
    );
    assert_eq!(
        core(&page, "paragraphs", json!(["a\n  \nb\n\n\n c "])).await,
        json!(["a", "b", "c"])
    );
    assert_eq!(core(&page, "paragraphs", json!([""])).await, json!([]));
    assert_eq!(page.eval("TarseeDialog.core.paragraphs(undefined)").await, json!([]));
}

#[tokio::test]
async fn a_yes_or_no_ok_and_cancel_when_the_buttons_are_not_named_the_title_is_the_texts_first_paragraph_when_there_is_none()
 {
    let page = dialogs().await;
    let q = core(
        &page,
        "questionOf",
        json!(["yesno", { "text": "Clear this conversation?\n\nIts messages are deleted." }]),
    )
    .await;
    assert_eq!(q["kind"], "yesno");
    assert_eq!(q["title"], "Clear this conversation?");
    assert_eq!(q["paragraphs"], json!(["Its messages are deleted."]));
    assert_eq!(q["yes"], "OK");
    assert_eq!(q["no"], "Cancel");
    assert_eq!(q["danger"], false);
    let named = core(
        &page,
        "questionOf",
        json!(["yesno", { "title": " Sign out of Tarsee on this device? ", "yes": "Sign out", "no": "Cancel", "danger": 1 }]),
    )
    .await;
    assert_eq!(named["title"], "Sign out of Tarsee on this device?");
    assert_eq!(named["yes"], "Sign out");
    assert_eq!(named["danger"], true);
    assert_eq!(
        core(&page, "questionOf", json!(["yesno", "Just words?"])).await["title"],
        "Just words?",
        "a bare string is the title"
    );
    assert_eq!(
        core(&page, "questionOf", json!(["yesno", {}])).await["title"],
        "Are you sure?"
    );
}

#[tokio::test]
async fn a_text_question_its_label_is_the_title_when_it_has_none_its_starting_words_are_kept_as_they_are() {
    let page = dialogs().await;
    let q = core(
        &page,
        "questionOf",
        json!(["text", { "title": "New file", "label": "File name", "value": "  notes.md ", "placeholder": "notes.md" }]),
    )
    .await;
    assert_eq!(q["kind"], "text");
    assert_eq!(q["label"], "File name");
    assert_eq!(q["value"], "  notes.md ", "not trimmed: what the page gave");
    assert_eq!(q["placeholder"], "notes.md");
    assert_eq!(q["type"], "text");
    assert_eq!(
        core(&page, "questionOf", json!(["text", { "label": "File name" }])).await["title"],
        "File name"
    );
    assert_eq!(
        core(&page, "questionOf", json!(["text", { "title": "Rename chat" }])).await["label"],
        "Rename chat"
    );
    assert_eq!(
        core(&page, "questionOf", json!(["text", { "type": "url" }])).await["type"],
        "url"
    );
    assert_eq!(
        core(&page, "questionOf", json!(["text", { "type": "password" }])).await["type"],
        "text",
        "only text or url"
    );
}

#[tokio::test]
async fn no_is_false_for_a_yes_or_no_and_null_for_text_as_the_browsers_confirm_and_prompt_gave() {
    let page = dialogs().await;
    assert_eq!(core(&page, "noOf", json!(["yesno"])).await, false);
    assert!(page.is_null("TarseeDialog.core.noOf('text')").await);
}

#[tokio::test]
async fn the_same_question_is_the_same_key_another_title_or_kind_is_another() {
    let page = dialogs().await;
    let keys = page
        .apply(
            "(questions) => questions.map(([kind, o]) => TarseeDialog.core.sameKey(TarseeDialog.core.questionOf(kind, o)))",
            json!([[
                ["yesno", { "title": "Delete skill \"x\"?", "yes": "Delete" }],
                ["yesno", { "title": "Delete skill \"x\"?" }],
                ["yesno", { "title": "Delete skill \"y\"?" }],
                ["text", { "title": "T" }],
                ["yesno", { "title": "T" }],
            ]]),
        )
        .await;
    assert_eq!(keys[0], keys[1]);
    assert_ne!(keys[0], keys[2]);
    assert_ne!(keys[3], keys[4]);
}

// ---------------------------------------------------------------- its keys

/// `TarseeDialog.core.keyAction(key, at)`.
async fn key_action(page: &Page, key: Value, at: Value) -> Value {
    core(page, "keyAction", json!([key, at])).await
}

#[tokio::test]
async fn enter_answers_yes_or_no_on_the_no_button_esc_answers_no() {
    let page = dialogs().await;
    let later = settle_ms(&page).await + 1;
    assert_eq!(
        key_action(&page, json!({ "key": "Enter" }), json!({ "sinceOpen": later })).await,
        "yes"
    );
    assert_eq!(
        key_action(
            &page,
            json!({ "key": "Enter" }),
            json!({ "sinceOpen": later, "onNo": true })
        )
        .await,
        "no"
    );
    assert_eq!(
        key_action(&page, json!({ "key": "Escape" }), json!({ "sinceOpen": later })).await,
        "no"
    );
    assert_eq!(
        key_action(&page, json!({ "key": "Esc" }), json!({ "sinceOpen": later })).await,
        "no"
    );
    assert_eq!(
        key_action(&page, json!({ "key": "Escape" }), json!({ "sinceOpen": 0 })).await,
        "no",
        "Esc may answer at once"
    );
}

#[tokio::test]
async fn enter_held_down_from_what_opened_it_or_in_its_first_moments_answers_nothing() {
    let page = dialogs().await;
    let settle = settle_ms(&page).await;
    assert_eq!(
        key_action(
            &page,
            json!({ "key": "Enter", "repeat": true }),
            json!({ "sinceOpen": settle + 1 })
        )
        .await,
        "wait"
    );
    assert_eq!(
        key_action(&page, json!({ "key": "Enter" }), json!({ "sinceOpen": settle - 1 })).await,
        "wait"
    );
    assert_eq!(
        key_action(&page, json!({ "key": "Enter" }), json!({ "sinceOpen": settle })).await,
        "yes"
    );
}

#[tokio::test]
async fn tab_goes_round_its_own_controls_the_rest_is_the_focused_controls_typing_space_on_a_button_an_ime() {
    let page = dialogs().await;
    let later = json!({ "sinceOpen": settle_ms(&page).await + 1 });
    assert_eq!(key_action(&page, json!({ "key": "Tab" }), later.clone()).await, "round");
    assert_eq!(
        key_action(&page, json!({ "key": "Tab", "shiftKey": true }), later.clone()).await,
        "round"
    );
    for k in ["a", "w", " ", "ArrowLeft", "Backspace", "?"] {
        assert_eq!(
            key_action(&page, json!({ "key": k }), later.clone()).await,
            "own",
            "{k}"
        );
    }
    assert_eq!(
        key_action(&page, json!({ "key": "Enter", "isComposing": true }), later.clone()).await,
        "own",
        "an IME picking a word"
    );
    assert_eq!(
        key_action(&page, json!({ "key": "Process", "keyCode": 229 }), later.clone()).await,
        "own"
    );
    assert_eq!(
        key_action(&page, json!({ "key": "Escape", "isComposing": true }), later).await,
        "own",
        "Esc leaves the IME, not the question"
    );
}

#[tokio::test]
async fn tab_and_shift_tab_round_from_the_last_control_to_the_first_and_back() {
    let page = dialogs().await;
    let tab = |i: i64, n: i64, back: bool| {
        let page = &page;
        async move { core(page, "tabTo", json!([i, n, back])).await }
    };
    assert_eq!(tab(0, 2, false).await, 1);
    assert_eq!(tab(1, 2, false).await, 0);
    assert_eq!(tab(0, 2, true).await, 1);
    assert_eq!(tab(1, 3, true).await, 0);
    assert_eq!(tab(0, 3, true).await, 2);
    assert_eq!(tab(-1, 3, false).await, 0, "from outside its controls: the first");
    assert_eq!(tab(-1, 3, true).await, 2, "or the last, backwards");
    assert_eq!(tab(5, 3, false).await, 0);
    assert_eq!(tab(0, 0, false).await, -1, "nothing to go to");
}

// ---------------------------------------------------------------- presses

#[tokio::test]
async fn its_buttons_count_once_it_has_settled_the_second_click_of_a_double_click_does_not() {
    let page = dialogs().await;
    let settle = settle_ms(&page).await;
    assert_eq!(core(&page, "settled", json!([0])).await, false);
    assert_eq!(core(&page, "settled", json!([settle - 1])).await, false);
    assert_eq!(core(&page, "settled", json!([settle])).await, true);
    assert!(
        (300..=600).contains(&settle),
        "long enough for a double click, short beside reading a question"
    );
}

#[tokio::test]
async fn a_press_outside_the_panel_answers_no_only_when_it_went_down_and_came_up_there_once_settled() {
    let page = dialogs().await;
    let t = settle_ms(&page).await + 50;
    let outside = |down: bool, up: bool, since: i64| {
        let page = &page;
        async move {
            core(
                page,
                "outsideAnswers",
                json!([{ "downOutside": down, "upOutside": up, "sinceOpen": since }]),
            )
            .await
        }
    };
    assert_eq!(outside(true, true, t).await, true);
    assert_eq!(outside(false, true, t).await, false, "a drag out of the text box");
    assert_eq!(outside(true, false, t).await, false);
    assert_eq!(
        outside(true, true, 120).await,
        false,
        "the second click of a double click"
    );
}

// ---------------------------------------------------------------- where the focus goes after

#[tokio::test]
async fn back_to_what_had_it_if_that_is_gone_to_the_one_with_its_id_now_else_to_back() {
    let page = dialogs().await;
    // Real buttons: `node(id)` is one on the page, `node(id, false)` one that is not (any more). Each says which it
    // is, so what focusBack gave can be named.
    let found = page
        .eval(
            r#"(() => {
                const { focusBack } = TarseeDialog.core;
                let n = 0;
                const node = (id, connected = true) => {
                    const b = document.createElement("button");
                    b.id = id;
                    b.dataset.name = `${id || "button"}#${++n}`;
                    if (connected) document.body.append(b);
                    return b;
                };
                const name = (el) => (el === null ? null : el === undefined ? "undefined" : el.dataset.name);
                const out = [];
                const had = node("signOutBtn");
                out.push([name(focusBack(had, null, () => null)), name(had)]);
                had.remove();
                const again = node("signOutBtn");
                out.push([name(focusBack(node("signOutBtn", false), null, (id) => (id === "signOutBtn" ? again : null))), name(again)]);
                const close = node("settingsClose");
                out.push([name(focusBack(node("", false), () => close, () => null)), name(close)]);
                out.push([name(focusBack(node("", false), close, () => null)), name(close)]);
                out.push([name(focusBack(null, null, () => null)), null]);
                out.push([name(focusBack(node("", false), () => { throw new Error("gone"); }, () => null)), null]);
                return out;
            })()"#,
        )
        .await;
    let found = found.as_array().expect("results");
    for (i, pair) in found.iter().enumerate() {
        assert_eq!(pair[0], pair[1], "case {}: {pair}", i + 1);
    }
    assert_eq!(found[4][0], Value::Null, "nothing had it: nowhere");
    assert_eq!(found.len(), 6);
}

// ---------------------------------------------------------------- one at a time

/// A question shown by hand, as the Node test's `asked()`: `show(name)` makes a show function whose question is
/// answered with `shows[i].answer(v)`; `tick()` lets the promises run.
const ASKED: &str = r#"
    const { lineUp } = TarseeDialog.core;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const shows = [];
    const show = (name) => () => new Promise((resolve) => shows.push({ name, answer: resolve }));
    const names = () => shows.map((s) => s.name);
    const seen = {};
"#;

async fn scenario(page: &Page, steps: &str) -> Value {
    page.eval(&format!("(async () => {{ {ASKED} {steps} return seen; }})()"))
        .await
}

#[tokio::test]
async fn a_second_question_waits_until_the_first_is_answered_then_shows() {
    let page = dialogs().await;
    let seen = scenario(
        &page,
        r#"
        const run = lineUp();
        const a = run("a", show("a"), false);
        const b = run("b", show("b"), false);
        await tick();
        seen.first = names();
        shows[0].answer(true);
        seen.a = await a;
        await tick();
        seen.second = names();
        shows[1].answer(false);
        seen.b = await b;
        "#,
    )
    .await;
    assert_eq!(seen["first"], json!(["a"]), "only the first is up");
    assert_eq!(seen["a"], true);
    assert_eq!(seen["second"], json!(["a", "b"]));
    assert_eq!(seen["b"], false);
}

#[tokio::test]
async fn the_same_question_asked_again_while_it_is_up_a_double_click_is_answered_no_at_once_and_asked_once() {
    let page = dialogs().await;
    let seen = scenario(
        &page,
        r#"
        const run = lineUp();
        const first = run("end", show("end"), false);
        seen.double = await run("end", show("end again"), false);
        const other = run("other", show("other"), null);   // (another question is not a double: it waits its turn)
        await tick();
        seen.up = names();
        shows[0].answer(true);
        seen.first = await first;
        await tick();
        seen.then = names();
        shows[1].answer("typed");
        seen.other = await other;
        "#,
    )
    .await;
    assert_eq!(seen["double"], false, "the double: no, at once");
    assert_eq!(seen["up"], json!(["end"]));
    assert_eq!(seen["first"], true, "the first one's own answer");
    assert_eq!(seen["then"], json!(["end", "other"]));
    assert_eq!(seen["other"], "typed");
}

#[tokio::test]
async fn once_answered_the_same_question_can_be_asked_again() {
    let page = dialogs().await;
    let seen = scenario(
        &page,
        r#"
        const run = lineUp();
        const one = run("q", show("1"), false);
        await tick();
        shows[0].answer(false);
        seen.one = await one;
        const two = run("q", show("2"), false);
        await tick();
        seen.shown = shows.length;
        shows[1].answer(true);
        seen.two = await two;
        "#,
    )
    .await;
    assert_eq!(seen["one"], false);
    assert_eq!(seen["shown"], 2);
    assert_eq!(seen["two"], true);
}

#[tokio::test]
async fn a_question_that_fails_to_show_does_not_hold_up_the_next_one() {
    let page = dialogs().await;
    let seen = scenario(
        &page,
        r#"
        const run = lineUp();
        const broken = run("x", () => Promise.reject(new Error("no page")), false);
        seen.rejected = await broken.then(() => false, () => true);
        seen.y = await run("y", () => Promise.resolve("ok"), false);
        seen.again = await run("x", () => Promise.resolve("again"), false);
        "#,
    )
    .await;
    assert_eq!(seen["rejected"], true);
    assert_eq!(seen["y"], "ok");
    assert_eq!(seen["again"], "again", "and it can be asked again");
}

// ---------------------------------------------------------------- the dashboard loads it first

/// `html.indexOf(a) >= 0 && html.indexOf(b) >= 0 && html.indexOf(a) < html.indexOf(b)`.
fn order(html: &str, a: &str, b: &str) -> bool {
    matches!((html.find(a), html.find(b)), (Some(i), Some(j)) if i < j)
}

#[test]
fn the_dashboard_before_its_own_scripts_with_its_stylesheet() {
    let html = read_public("index.html");
    assert!(html.contains(r#"<script src="/js/dialogs.js"></script>"#));
    for s in [
        "/js/api.js",
        "/js/chat.js",
        "/js/settings.js",
        "/js/files.js",
        "/js/app.js",
    ] {
        assert!(order(&html, "/js/dialogs.js", s), "before {s}");
    }
    assert!(
        order(&html, "/css/style.css", "/css/dialogs.css"),
        "its stylesheet after the modal's own (style.css)"
    );
}

#[test]
fn the_service_worker_keeps_both_with_the_dashboards_other_files() {
    let sw = read_public("sw.js");
    assert!(sw.contains(r#""/js/dialogs.js""#) && sw.contains(r#""/css/dialogs.css""#));
}

#[test]
fn every_button_is_40px_tall_at_least_44px_under_a_finger() {
    let css = read_public("css/dialogs.css");
    let matches = |pattern: &str, text: &str| Regex::new(pattern).expect("regex").is_match(text);
    assert!(matches(r"--space-10:\s*40px", &read_public("css/tokens.css")));
    assert!(matches(
        r"\.td-dash \.td-actions \.btn \{[^}]*min-height: var\(--space-10\)",
        &css
    ));
    assert!(matches(
        r"@media \(pointer: coarse\) \{\s*\.td-dash \.td-actions \.btn \{ min-height: 44px; \}",
        &css
    ));
}
