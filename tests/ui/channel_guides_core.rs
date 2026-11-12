//! Port of `test/channel-guides-core.test.js`: how to connect each chat platform
//! (`src/public/js/channel-guides-core.js`, `ChannelGuides`). Settings → Channels and the setup wizard draw their
//! steps from it, so it has to cover every channel the server runs and match the page it fills (`index.html`).

use regex::Regex;
use serde_json::{Value, json};

use crate::support::files::read_public;
use crate::support::{Page, truthy};

async fn guides() -> Page {
    Page::with_scripts(&["channel-guides-core.js"]).await
}

async fn platforms(page: &Page) -> Vec<Value> {
    page.eval("ChannelGuides.PLATFORMS")
        .await
        .as_array()
        .expect("platforms")
        .clone()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("a list")
        .iter()
        .map(|s| s.as_str().expect("text").to_string())
        .collect()
}

/// `p.steps.join("") + p.tips.join("")`.
fn steps_and_tips(p: &Value) -> String {
    strings(&p["steps"]).concat() + &strings(&p["tips"]).concat()
}

/// `text.indexOf(part)`, -1 when it is not there.
fn index_of(text: &str, part: &str) -> i64 {
    text.find(part).map_or(-1, |i| i as i64)
}

async fn guide_html(page: &Page, args: Value) -> String {
    page.call("ChannelGuides.guideHtml", args)
        .await
        .as_str()
        .expect("HTML")
        .to_string()
}

#[tokio::test]
async fn cover_every_channel_the_server_can_run_in_the_order_they_are_offered() {
    let page = guides().await;
    let ids: Vec<Value> = platforms(&page).await.iter().map(|p| p["id"].clone()).collect();
    assert_eq!(
        Value::Array(ids),
        json!(["telegram", "discord", "slack", "whatsapp", "email"])
    );
}

#[tokio::test]
async fn each_has_a_name_a_one_line_what_it_takes_steps_and_tips() {
    let page = guides().await;
    for p in platforms(&page).await {
        let id = &p["id"];
        let filled = |key: &str| p[key].as_str().is_some_and(|s| !s.is_empty());
        assert!(filled("name") && filled("needs"), "{id}");
        assert!(p["steps"].as_array().expect("steps").len() >= 4, "{id}: steps");
        assert!(p["tips"].is_array(), "{id}: tips");
        assert!(!steps_and_tips(&p).contains("${"), "{id}: no template left in the text");
    }
}

#[tokio::test]
async fn each_has_its_own_section_on_the_channels_page_with_a_status_line_and_a_place_for_its_guide() {
    let page_html = read_public("index.html");
    let page = guides().await;
    for p in platforms(&page).await {
        let id = p["id"].as_str().expect("an id");
        let section = p["section"].as_str().expect("a section");
        let has = |pattern: String| Regex::new(&pattern).expect("regex").is_match(&page_html);
        assert!(has(format!(r#"id="{section}""#)), "{id}: section");
        assert!(has(format!(r#"id="{id}ChannelStatus""#)), "{id}: status line");
        assert!(has(format!(r#"data-guide-slot="{id}""#)), "{id}: guide slot");
    }
}

#[tokio::test]
async fn links_open_in_a_new_tab_over_https() {
    let page = guides().await;
    let anchor = Regex::new(r"<a [^>]*>").expect("regex");
    for p in platforms(&page).await {
        let text = steps_and_tips(&p);
        for a in anchor.find_iter(&text).map(|m| m.as_str()) {
            assert!(a.contains(r#"href="https://"#), "{a}");
            assert!(a.contains(r#"target="_blank""#), "{a}");
            assert!(a.contains(r#"rel="noopener noreferrer""#), "{a}");
        }
    }
}

#[tokio::test]
async fn draws_a_guide_as_steps_in_order_and_tips_folded_unless_asked_open() {
    let page = guides().await;
    let html = guide_html(&page, json!(["telegram"])).await;
    assert!(
        html.starts_with(r#"<details class="channel-guide" data-guide="telegram">"#),
        "{html}"
    );
    assert!(html.contains("<summary>How to connect Telegram</summary>"), "{html}");
    let telegram = page.call("ChannelGuides.get", json!(["telegram"])).await;
    let expected =
        telegram["steps"].as_array().expect("steps").len() + telegram["tips"].as_array().expect("tips").len();
    assert_eq!(html.matches("<li>").count(), expected);
    assert!(
        index_of(&html, "/newbot") < index_of(&html, "Paste it"),
        "steps in order"
    );
    assert!(
        guide_html(&page, json!(["slack", { "open": true }]))
            .await
            .contains(r#"data-guide="slack" open>"#)
    );
    assert_eq!(guide_html(&page, json!(["nope"])).await, "");
}

#[tokio::test]
async fn has_an_app_password_note_for_every_email_preset_button() {
    let page_html = read_public("index.html");
    let preset = Regex::new(r#"data-preset="([a-z]+)""#).expect("regex");
    let presets: Vec<&str> = preset
        .captures_iter(&page_html)
        .map(|c| c.get(1).expect("a name").as_str())
        .collect();
    assert!(presets.len() >= 6, "{presets:?}");
    let page = guides().await;
    let providers = page.eval("ChannelGuides.EMAIL_PROVIDERS").await;
    for name in presets {
        assert!(truthy(&providers[name]), "email preset {name}");
    }
}

#[tokio::test]
async fn says_a_channels_status_in_words() {
    let page = guides().await;
    let status = |args: Value| {
        let page = &page;
        async move { page.call("ChannelGuides.statusLine", args).await }
    };
    assert_eq!(
        status(json!([{ "status": "running", "identity": "@my_tarsee_bot" }])).await,
        json!({ "text": "Connected as @my_tarsee_bot", "tone": "ok" })
    );
    assert_eq!(
        status(json!([{ "status": "running" }])).await,
        json!({ "text": "Connected", "tone": "ok" })
    );
    assert_eq!(
        status(json!([{ "status": "starting" }])).await,
        json!({ "text": "Connecting…", "tone": "wait" })
    );
    assert_eq!(
        status(json!([{ "status": "error", "error": "Telegram refused the bot token." }])).await,
        json!({ "text": "Telegram refused the bot token.", "tone": "bad" })
    );
    assert_eq!(
        status(json!([{ "status": "error" }])).await,
        json!({ "text": "Could not connect", "tone": "bad" })
    );
    assert_eq!(
        status(json!([{ "status": "stopped" }])).await,
        json!({ "text": "Saved, not connected yet", "tone": "wait" })
    );
    assert_eq!(
        status(json!([{ "status": "not_configured" }, { "enabled": false, "configured": true }])).await,
        json!({ "text": "Off", "tone": "off" }),
        "saved, switched off"
    );
    assert_eq!(
        status(json!([{ "status": "not_configured" }, { "enabled": false, "configured": false }])).await,
        json!({ "text": "Not set up", "tone": "off" }),
        "never set up"
    );
    assert_eq!(
        status(json!([{ "status": "not_configured" }])).await,
        json!({ "text": "Not set up", "tone": "off" })
    );
    let warning = "Saved, but couldn't check the token with WHAPI (no answer in time).";
    assert_eq!(
        status(json!([{ "status": "running", "identity": null, "warning": warning }])).await,
        json!({ "text": warning, "tone": "wait" }),
        "running but unchecked is not 'Connected'"
    );
    assert_eq!(
        page.eval("ChannelGuides.statusLine(undefined)").await,
        json!({ "text": "Not set up", "tone": "off" })
    );
}
