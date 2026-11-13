//! Port of the browser cases of `test/chat-files.test.js`: the viewer's rules, the pure parts of the page that shows
//! a chat's files (`src/public/js/file-viewer-core.js`, an ES module), and that the dashboard loads the cards, the
//! viewer and their styles. The server's side of that test file is in `src/lib/chat_files.rs` and
//! `src/lib/sent_files.rs` (package D1).

use regex::Regex;
use serde_json::{Value, json};

use crate::support::Page;
use crate::support::files::read_public;

/// Calls `function` (written in JavaScript) with the viewer's core module as its first argument, then `args` (a
/// JSON array), and gives what it returns.
async fn with_core(page: &Page, function: &str, args: Value) -> Value {
    let call = format!(
        "async (...args) => {{ const core = await import('/js/file-viewer-core.js'); return ({function})(core, ...args); }}"
    );
    page.apply(&call, args).await
}

async fn page() -> Page {
    Page::with_scripts(&[]).await
}

// ---------------------------------------------------------------- files people send in show too

#[tokio::test]
async fn the_channels_notes_in_a_message_are_its_files_telegrams_discords_an_emails_whatsapps() {
    let page = page().await;
    // (The uploads folder as a page sees it from a server on Linux: the notes name paths that start with a slash.)
    let up = |name: &str| format!("/data/tarsee/workspace/uploads/{name}");
    let msg = [
        "[tg_user]: see these".to_string(),
        format!(
            "[PDF attached: Q3 report.pdf (84KB) → {}] — multimodal PDF block provided above; you can also Read this file directly at the path.",
            up("telegram-1-Q3_report.pdf")
        ),
        format!(
            "[Attached file saved: sheet.csv (text/csv, 2KB) → {}]",
            up("discord-2-sheet.csv")
        ),
        format!(
            "You can read this file with the Read tool at: {}",
            up("discord-2-sheet.csv")
        ),
        format!(
            "[Email attachment saved: deck.pptx (application/vnd.ms-powerpoint, 1KB) → {}]",
            up("email-3-deck.pptx")
        ),
        format!("[PDF saved: menu.pdf (12KB) → {}]", up("whatsapp-4-menu.pdf")),
        format!(
            "[Video saved: (900KB) → {}] You can read this file with the Read tool.",
            up("whatsapp-5-clip.mp4")
        ),
    ]
    .join("\n");
    let split = with_core(
        &page,
        "(core, msg) => { const { text, files } = core.splitNotes(msg); \
         return { text, files: files.map((f) => [f.name, f.size]), urls: files.map((f) => f.url) }; }",
        json!([msg]),
    )
    .await;
    assert_eq!(split["text"], "[tg_user]: see these");
    assert_eq!(
        split["files"],
        json!([
            ["Q3 report.pdf", 84 * 1024],
            ["sheet.csv", 2048],
            ["deck.pptx", 1024],
            ["menu.pdf", 12 * 1024],
            ["clip.mp4", 900 * 1024],
        ])
    );
    let urls = split["urls"].as_array().expect("the files' addresses");
    assert_eq!(urls.len(), 5);
    assert!(
        urls.iter()
            .all(|url| url.as_str().is_some_and(|url| url.starts_with("/api/chat/file?p="))),
        "{urls:?}"
    );
    // The address is the one the server makes for the same path (`lib/chat_files.rs` `file_url`).
    assert_eq!(
        urls[0],
        "/api/chat/file?p=%2Fdata%2Ftarsee%2Fworkspace%2Fuploads%2Ftelegram-1-Q3_report.pdf"
    );
}

// ---------------------------------------------------------------- the viewer's rules (public/js/file-viewer-core.js)

#[tokio::test]
async fn knows_each_kind_names_it_for_a_person_and_lays_out_csv_and_json() {
    let page = page().await;
    assert_eq!(
        with_core(
            &page,
            "(core, names) => names.map((name) => core.kindOf({ name }))",
            json!([["a.png", "b.MOV", "c.m4a", "d.pdf", "e.docx", "f.csv", "g.bin"]]),
        )
        .await,
        json!(["image", "video", "audio", "pdf", "doc", "text", "other"])
    );
    assert_eq!(
        with_core(
            &page,
            "(core, names) => names.map((name) => core.typeLabel({ name }))",
            json!([["x.pdf", "x.docx", "x.jpg", "x.py"]]),
        )
        .await,
        json!(["PDF", "Word", "Picture", "PY"])
    );
    assert_eq!(
        with_core(
            &page,
            "(core, text) => core.parseCsv(text)",
            json!(["a,\"b,c\"\n1,\"say \"\"hi\"\"\"\n"]),
        )
        .await,
        json!([["a", "b,c"], ["1", "say \"hi\""]])
    );
    assert_eq!(
        with_core(&page, "(core, text) => core.prettyJson(text)", json!(["{\"a\":1}"])).await,
        json!("{\n  \"a\": 1\n}")
    );
    assert_eq!(
        with_core(
            &page,
            "(core, paths) => paths.map(core.shownName)",
            json!([[
                "/w/uploads/sent-1793000000000-Report.pdf",
                "/w/uploads/chat-1793000000000-2-notes.md"
            ]]),
        )
        .await,
        json!(["Report.pdf", "notes.md"])
    );
}

#[tokio::test]
async fn a_link_to_one_of_the_chats_files_opens_in_the_viewer_anything_else_stays_a_link() {
    let page = page().await;
    let origin = "https://tarsee.example";
    assert_eq!(
        with_core(
            &page,
            "(core, href, origin) => core.fileLink(href, origin).path",
            json!(["/api/chat/file?p=%2Fw%2Fuploads%2Fa.pdf", origin]),
        )
        .await,
        json!("/w/uploads/a.pdf")
    );
    for elsewhere in [
        "https://elsewhere.example/api/chat/file?p=x",
        "/api/files/download?path=x",
    ] {
        assert_eq!(
            with_core(
                &page,
                "(core, href, origin) => core.fileLink(href, origin) === null",
                json!([elsewhere, origin]),
            )
            .await,
            json!(true),
            "{elsewhere}"
        );
    }
}

#[tokio::test]
async fn the_waveform_loudest_sample_a_slice_scaled_to_the_loudest_never_quite_silent() {
    let page = page().await;
    assert_eq!(
        with_core(
            &page,
            "(core, samples, n) => core.peaksOf([Float32Array.from(samples)], n)",
            json!([[0, 0.5, 0, 1, 0, 0.25], 3]),
        )
        .await,
        json!([0.5, 1, 0.25])
    );
    assert_eq!(
        with_core(&page, "(core, n) => core.peaksOf([new Float32Array(0)], n)", json!([2])).await,
        json!([0.04, 0.04])
    );
    assert_eq!(
        with_core(&page, "(core, sec) => core.clock(sec)", json!([3725])).await,
        json!("1:02:05")
    );
}

#[test]
fn the_dashboard_loads_the_cards_the_viewer_and_their_styles_the_offline_cache_has_them() {
    let page = read_public("index.html");
    for wanted in [
        r#"<script type="module" src="/js/chat-files\.js"></script>"#,
        r#"href="/css/chat-files\.css""#,
        r#"href="/css/file-viewer\.css""#,
        r#"id="viewer"[^>]*hidden"#,
    ] {
        assert!(
            Regex::new(wanted).expect("a pattern").is_match(&page),
            "index.html has no {wanted}"
        );
    }
    let sw = read_public("sw.js");
    for file in [
        "/js/chat-files.js",
        "/js/file-viewer.js",
        "/js/file-viewer-core.js",
        "/css/chat-files.css",
        "/css/file-viewer.css",
    ] {
        assert!(sw.contains(&format!("\"{file}\"")), "{file}");
    }
}
