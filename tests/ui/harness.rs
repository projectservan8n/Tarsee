//! The harness itself: what tests rely on it to do. These go beyond the Node tests because the harness is new code
//! with risks of its own (a protocol client, a shared browser, errors that must not slip by).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::http::HeaderMap;
use axum::routing::get;
use serde_json::json;

use crate::support::{Page, Site, playwright_programs_in};

#[tokio::test]
async fn a_page_loads_the_browser_files_and_runs_them() {
    let page = Page::with_scripts(&["chat-core.js"]).await;
    assert_eq!(page.eval("typeof ChatCore.chatName").await, json!("function"));
    assert_eq!(page.eval("1 + 1").await, json!(2));
    assert_eq!(
        page.call(
            "ChatCore.chatName",
            json!([{ "key": "web:default", "title": "Web Chat" }])
        )
        .await,
        json!("Main Session")
    );
}

// ---------------------------------------------------------------- values both ways

#[tokio::test]
async fn values_come_back_as_json_promises_awaited_undefined_as_null_and_negative_zero_kept() {
    let page = Page::with_scripts(&[]).await;
    assert_eq!(
        page.eval("({ a: [1, 'two', null, true], b: { c: 1.5 } })").await,
        json!({ "a": [1, "two", null, true], "b": { "c": 1.5 } })
    );
    assert_eq!(page.eval("Promise.resolve(41).then((n) => n + 1)").await, json!(42));
    assert_eq!(page.eval("undefined").await, json!(null));
    assert!(page.is_undefined("undefined").await);
    assert!(!page.is_null("undefined").await);
    assert!(page.is_null("null").await);
    let zero = page.eval("-0").await;
    assert_eq!(zero, json!(-0.0));
    assert_ne!(zero, json!(0), "as Node's strict assertions tell -0 from 0");
    let nan = page.try_eval("NaN").await.unwrap_err();
    assert!(nan.contains("NaN"), "{nan}");
}

#[tokio::test]
async fn what_the_page_throws_is_the_error_with_its_message() {
    let page = Page::with_scripts(&[]).await;
    let thrown = page
        .try_eval("(() => { throw new TypeError('no such chat'); })()")
        .await;
    let thrown = thrown.unwrap_err();
    assert!(thrown.contains("TypeError: no such chat"), "{thrown}");
    let rejected = page.try_eval("Promise.reject(new Error('refused'))").await.unwrap_err();
    assert!(rejected.contains("refused"), "{rejected}");
    // (A throw that the test asked for is its answer, not an error of the page's.)
    page.check_errors();
}

#[tokio::test]
async fn arguments_reach_the_page_exactly_as_json_whatever_they_hold() {
    let page = Page::with_scripts(&[]).await;
    let args = json!([
        "quotes \" and ' and ` and ${x}",
        "</script><script>alert(1)</script>",
        "lines\nand\u{2028}separators\u{0}",
        "Pinoy 🇵🇭 · ñ",
        { "nested": [1, 2.5, null, false] },
        null,
    ]);
    assert_eq!(page.apply("(...all) => all", args.clone()).await, args);
    assert_eq!(page.call("Array.of", args.clone()).await, args);
    assert_eq!(
        page.call("JSON.stringify", json!([{ "a": 1 }])).await,
        json!(r#"{"a":1}"#),
        "a method is called on what it is on"
    );
}

// ---------------------------------------------------------------- waiting

#[tokio::test]
async fn a_wait_ends_as_soon_as_the_thing_is_there_and_gives_its_value() {
    let page = Page::with_scripts(&[]).await;
    page.eval("setTimeout(() => { window.flag = 'up'; }, 100); 0").await;
    assert_eq!(page.wait_for("window.flag", "the flag").await, json!("up"));
}

#[tokio::test]
#[should_panic(expected = "timed out after 0.2s waiting for a flag nobody raises")]
async fn a_wait_that_runs_out_of_time_says_what_it_waited_for() {
    let page = Page::with_scripts(&[]).await;
    page.wait_for_within("window.never", Duration::from_millis(200), "a flag nobody raises")
        .await;
}

// ---------------------------------------------------------------- errors

#[tokio::test]
async fn errors_the_page_reports_are_kept_for_the_test_to_take() {
    let page = Page::with_scripts(&[]).await;
    page.allow_errors();
    page.eval("console.error('first', { n: 1 }); console.warn('only a warning'); 0")
        .await;
    page.eval("setTimeout(() => { throw new Error('from a timer'); }, 0); 0")
        .await;
    page.eval("Promise.reject(new Error('nobody caught me')); 0").await;
    page.wait_for(
        "new Promise((r) => setTimeout(() => r(true), 0))",
        "the timer to have run",
    )
    .await;
    let errors = page.take_errors();
    assert_eq!(errors.len(), 3, "{errors:?}");
    assert!(errors[0].starts_with("console.error: first"), "{errors:?}");
    assert!(errors.iter().any(|e| e.contains("from a timer")), "{errors:?}");
    assert!(errors.iter().any(|e| e.contains("nobody caught me")), "{errors:?}");
    assert!(page.take_errors().is_empty(), "taken once");
}

#[tokio::test]
async fn a_script_that_does_not_load_is_an_error() {
    let page = Page::with_scripts(&["no-such-file.js"]).await;
    let errors = page.take_errors();
    assert!(
        errors
            .iter()
            .any(|e| e.contains("404") && e.contains("/js/no-such-file.js")),
        "{errors:?}"
    );
}

#[tokio::test]
#[should_panic(expected = "the page reported 1 error(s)")]
async fn an_error_the_test_did_not_take_fails_it_at_its_next_step() {
    let page = Page::with_scripts(&[]).await;
    page.eval("console.error('unexpected'); 0").await;
    page.eval("1").await;
}

#[tokio::test]
#[should_panic(expected = "console.error: at the very end")]
async fn an_error_the_test_did_not_take_fails_it_when_the_page_is_dropped() {
    let page = Page::with_scripts(&[]).await;
    page.eval("console.error('at the very end'); 0").await;
}

// ---------------------------------------------------------------- elements and input

const FORM: &str = r#"
<p id="said">nothing yet</p>
<input id="name" value="">
<button id="go" data-kind="primary">Go</button>
<script>
  let clicks = 0;
  document.getElementById("go").addEventListener("click", (e) => {
    clicks++;
    document.getElementById("said").textContent = `clicked ${clicks} (trusted: ${e.isTrusted})`;
  });
  window.keys = [];
  addEventListener("keydown", (e) => keys.push(`${e.shiftKey ? "Shift+" : ""}${e.key}`));
</script>
"#;

#[tokio::test]
async fn text_attributes_clicks_typing_and_keys_as_a_person_does_them() {
    let page = Page::with_scripts_and_body(&[], FORM).await;
    assert_eq!(page.text("#said").await, "nothing yet");
    assert_eq!(page.attr("#go", "data-kind").await.as_deref(), Some("primary"));
    assert_eq!(page.attr("#go", "data-none").await, None);
    assert!(page.exists("#name").await && !page.exists("#nothing").await);
    page.click("#go").await;
    assert_eq!(page.text("#said").await, "clicked 1 (trusted: true)");
    page.type_text("#name", "Tarsee · ñ").await;
    assert_eq!(page.eval("document.getElementById('name').value").await, "Tarsee · ñ");
    page.press("Enter").await;
    page.press("Shift+Tab").await;
    page.press("a").await;
    assert_eq!(page.eval("keys").await, json!(["Enter", "Shift+Tab", "a"]));
}

#[tokio::test]
async fn an_element_that_comes_later_is_waited_for() {
    let page = Page::with_scripts(&[]).await;
    page.eval("setTimeout(() => { const p = document.createElement('p'); p.id = 'late'; p.textContent = 'here'; document.body.append(p); }, 100); 0")
        .await;
    assert_eq!(page.text("#late").await, "here");
}

#[tokio::test]
async fn a_question_of_tarsee_dialog_answered_with_a_click_and_with_typing() {
    let page = Page::with_scripts(&["dialogs.js"]).await;
    // Note when each question opens, to wait out its first moments (a press then is not an answer).
    page.eval(
        "addEventListener('tarsee:dialog', (e) => { if (e.detail.open) window.openedAt = performance.now(); }); 0",
    )
    .await;
    let settled = "TarseeDialog.isOpen() && performance.now() - window.openedAt >= TarseeDialog.core.SETTLE_MS";

    page.eval("window.answer = TarseeDialog.ask({ title: 'Delete it?', yes: 'Delete', danger: true }); 0")
        .await;
    assert_eq!(page.text("dialog .td-title").await, "Delete it?");
    page.wait_for(settled, "the question to settle").await;
    page.click("dialog .td-yes").await;
    assert_eq!(page.eval("window.answer").await, true);
    assert!(!page.exists("dialog").await);

    page.eval("window.answer = TarseeDialog.askText({ title: 'New file', label: 'File name' }); 0")
        .await;
    page.wait_for(settled, "the question to settle").await;
    page.type_text("dialog input", "notes.md").await;
    page.press("Enter").await;
    assert_eq!(page.eval("window.answer").await, "notes.md");
}

#[tokio::test]
async fn a_chosen_file_reaches_the_page_as_a_file_input_gives_it() {
    let dir = tarsee::testkit::tmp_dir();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "hello from a file").expect("a file");
    let page = Page::with_scripts_and_body(&[], r#"<input type="file" id="pick">"#).await;
    page.eval("document.getElementById('pick').addEventListener('change', async (e) => { const f = e.target.files[0]; window.got = `${f.name}: ${await f.text()}`; }); 0")
        .await;
    page.set_files("#pick", &[&file]).await;
    assert_eq!(
        page.wait_for("window.got", "the file to be read").await,
        "notes.txt: hello from a file"
    );
}

// ---------------------------------------------------------------- sites, contexts, cookies, permissions

#[tokio::test]
async fn a_site_of_the_tests_own_answers_its_routes_and_serves_the_browser_files_too() {
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = Arc::clone(&seen);
    let routes = Router::new().route(
        "/api/echo",
        get(move |headers: HeaderMap| {
            let cookie = headers
                .get("cookie")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            log.lock().expect("log").push(cookie.clone());
            async move { axum::Json(json!({ "cookie": cookie })) }
        }),
    );
    let site = Site::start(routes);
    assert_ne!(site.base(), Site::shared().base(), "an origin of its own");
    let page = Page::open(&site.page("<p id=hi>hi</p><script src=\"/js/chat-core.js\"></script>")).await;
    assert_eq!(page.eval("typeof ChatCore").await, "object");
    page.set_cookie("tarsee_session", "abc123", true).await;
    assert_eq!(page.cookie("tarsee_session").await.as_deref(), Some("abc123"));
    assert_eq!(
        page.eval("document.cookie").await,
        "",
        "an HttpOnly cookie is not the page's to read"
    );
    assert_eq!(
        page.eval("fetch('/api/echo').then((r) => r.json())").await,
        json!({ "cookie": "tarsee_session=abc123" })
    );
    assert_eq!(*seen.lock().expect("log"), ["tarsee_session=abc123"]);
}

#[tokio::test]
async fn each_opened_page_has_its_own_cookies_and_storage() {
    let url = Site::shared().page("<p>a page</p>");
    let a = Page::open(&url).await;
    let b = Page::open(&url).await;
    a.eval("localStorage.setItem('k', 'a'); document.cookie = 'c=a'; 0")
        .await;
    assert!(b.is_null("localStorage.getItem('k')").await);
    assert_eq!(b.eval("document.cookie").await, "");
    assert_eq!(a.eval("localStorage.getItem('k')").await, "a");
}

#[tokio::test]
async fn the_clock_is_utc_and_the_language_american_english_until_a_test_says_otherwise() {
    let page = Page::with_scripts(&[]).await;
    assert_eq!(
        page.eval("Intl.DateTimeFormat().resolvedOptions().timeZone").await,
        "UTC"
    );
    assert_eq!(page.eval("new Date(0).getHours()").await, 0);
    assert_eq!(page.eval("navigator.language").await, "en-US");
    page.set_timezone("Asia/Manila").await;
    assert_eq!(page.eval("new Date(0).getHours()").await, 8);
}

#[tokio::test]
async fn the_network_is_closed_only_the_loopback_answers() {
    let page = Page::with_scripts(&[]).await;
    assert_eq!(
        page.eval("fetch('http://example.com/').then(() => 'reached', () => 'refused')")
            .await,
        "refused"
    );
    assert!(
        page.take_errors()
            .iter()
            .all(|e| e.contains("ERR_NAME_NOT_RESOLVED") || e.contains("example.com"))
    );
}

#[tokio::test]
async fn a_microphone_allowed_without_asking_gives_a_fake_stream() {
    let page = Page::open(&Site::shared().page("<p>call</p>")).await;
    page.grant(&["microphone"]).await;
    assert_eq!(
        page.eval("navigator.permissions.query({ name: 'microphone' }).then((p) => p.state)")
            .await,
        "granted"
    );
    let tracks = page
        .eval("navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getAudioTracks().map((t) => t.readyState))")
        .await;
    assert_eq!(tracks, json!(["live"]));
}

// ---------------------------------------------------------------- finding the browser

#[test]
fn playwrights_chromium_is_found_newest_revision_first_then_its_headless_shell() {
    let dir = tarsee::testkit::tmp_dir();
    for folder in [
        "chromium-1100",
        "chromium-1234",
        "chromium_headless_shell-1300",
        "chromium-tip",
        "ffmpeg-1011",
    ] {
        std::fs::create_dir_all(dir.path().join(folder)).expect("a folder");
    }
    let found = playwright_programs_in(dir.path());
    let folders: Vec<String> = found
        .iter()
        .map(|p| {
            p.strip_prefix(dir.path())
                .expect("inside")
                .components()
                .next()
                .expect("a folder")
                .as_os_str()
                .to_string_lossy()
                .to_string()
        })
        .collect();
    let first_of = |name: &str| folders.iter().position(|f| f == name);
    assert!(first_of("chromium-1234") < first_of("chromium-1100"), "{folders:?}");
    assert!(
        first_of("chromium-1100") < first_of("chromium_headless_shell-1300"),
        "{folders:?}"
    );
    assert!(
        !folders.iter().any(|f| f == "chromium-tip" || f == "ffmpeg-1011"),
        "{folders:?}"
    );
}

#[tokio::test]
#[should_panic(expected = "could not open")]
async fn opening_a_page_that_is_not_there_fails_with_its_address() {
    Page::open(&Site::shared().url("/__ui/no-such-page")).await;
}
