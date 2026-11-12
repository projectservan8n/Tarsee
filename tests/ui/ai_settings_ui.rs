//! Port of `test/ai-settings-ui.test.js`: Settings → AI, the setup wizard's "Choose your AI", the header chip and the
//! Security tab's tool list (design 5, 4.14 and the Phase 5 UI tasks): what the page and its scripts must contain,
//! read as files. No browser needed.

use regex::Regex;

use crate::support::files::read_public;

fn matches(pattern: &str, text: &str) -> bool {
    Regex::new(pattern).expect("regex").is_match(text)
}

/// `html.indexOf(a) >= 0 && html.indexOf(b) >= 0 && html.indexOf(a) < html.indexOf(b)`.
fn order(html: &str, a: &str, b: &str) -> bool {
    matches!((html.find(a), html.find(b)), (Some(i), Some(j)) if i < j)
}

// ---------------------------------------------------------------- Settings → AI: the page

#[test]
fn the_tab_is_called_ai() {
    let page = read_public("index.html");
    assert!(matches(
        r#"<button class="settings-tab" data-tab="ai">[\s\S]*?AI\s*</button>"#,
        &page
    ));
    assert!(page.contains(r#"<div class="settings-tab-panel" data-tab="ai">"#));
    assert!(!page.contains("AI Provider"));
    assert!(!page.contains(r#"data-tab="provider""#));
}

#[test]
fn has_the_chips_row_the_banners_the_default_ai_the_keys_only_switch_the_backup_model_and_the_monthly_cap() {
    let page = read_public("index.html");
    for id in [
        "aiChips",
        "aiBanners",
        "aiDefaultNow",
        "aiKeysOnly",
        "aiKeysOnlyNote",
        "aiBackupModel",
        "aiMonthlyCap",
        "aiSaveExtrasBtn",
        "aiTermsNote",
    ] {
        assert!(matches(&format!(r#"id="{id}""#), &page), "{id}");
    }
}

#[test]
fn the_old_hidden_provider_fields_are_gone_no_base_url_a_key_could_be_pointed_at() {
    let page = read_public("index.html");
    let settings = read_public("js/settings.js");
    for id in [
        "settingsBaseUrl",
        "customBaseUrlGroup",
        "settingsProvider",
        "settingsApiKey",
        "saveProviderBtn",
    ] {
        assert!(!matches(&format!(r#"id="{id}""#), &page), "index.html: {id}");
        assert!(!matches(id, &settings), "settings.js: {id}");
    }
    assert!(
        !matches(r"(?-u:\b)baseUrl:\s*document", &settings),
        "no base URL element"
    );
}

#[test]
fn the_guides_load_before_the_scripts_that_use_them_and_the_offline_cache_has_them() {
    let page = read_public("index.html");
    let sw = read_public("sw.js");
    assert!(page.contains(r#"<script src="/js/provider-guides-core.js"></script>"#));
    assert!(order(&page, "/js/provider-guides-core.js", "/js/settings.js"));
    assert!(order(&page, "/js/provider-guides-core.js", "/js/setup.js"));
    assert!(sw.contains(r#""/js/provider-guides-core.js""#));
    assert!(
        !sw.contains(r#"const CACHE_NAME = "tarsee-v12""#),
        "the cache version moves on so phones pick up the new page"
    );
}

#[test]
fn the_header_shows_the_active_ai_and_a_banner_when_it_needs_attention() {
    let page = read_public("index.html");
    assert!(page.contains(r#"id="aiHeaderChip""#));
    assert!(matches(r#"id="aiAttention"[^>]*hidden"#, &page));
}

#[test]
fn talks_to_api_ai_for_every_card_action() {
    let settings = read_public("js/settings.js");
    for path in [
        "/api/ai/providers",
        "/api/ai/active",
        "/api/ai/keys/",
        "/api/ai/test/",
        "/api/ai/verify/",
        "/api/ai/keys-only",
        "/api/ai/chatgpt/login",
        "/api/ai/chatgpt/logout",
        "/api/ai/models/",
    ] {
        assert!(settings.contains(path), "settings.js: {path}");
    }
}

// ---------------------------------------------------------------- setup wizard: Choose your AI

#[test]
fn saves_no_placeholder_key_and_never_the_old_subscription_one() {
    let setup = read_public("js/setup.js");
    assert!(!matches(r#"["']subscription["']\s*\}"#, &setup), "no fake key value");
    assert!(
        !matches(r#"apiKey:\s*["'`]"#, &setup),
        "a key sent is always one the person pasted"
    );
    assert!(!setup.contains("saveProvider"));
}

#[test]
fn offers_the_three_choices_and_asks_who_will_talk_to_this_tarsee() {
    let setup = read_public("js/setup.js");
    for words in [
        "Choose your AI",
        "My Claude plan",
        "My ChatGPT plan",
        "My own API key",
        "Who will talk to this Tarsee?",
        "Just me",
        "Other people too",
    ] {
        assert!(setup.contains(words), "{words}");
    }
    assert!(
        setup.contains("/api/ai/keys-only"),
        "the keys-only choice is saved, explicitly"
    );
    assert!(
        setup.contains("/api/ai/active"),
        "the chosen AI becomes the default only once it's ready"
    );
}

// ---------------------------------------------------------------- Settings → Security: Tool Permissions

#[test]
fn lists_the_tools_from_the_registry_not_a_list_written_in_the_page() {
    let settings = read_public("js/settings.js");
    assert!(settings.contains("/api/admin/tool-registry"));
    assert!(
        !matches(r#"\["read_file",\s*"write_file""#, &settings),
        "no hard-coded tool list"
    );
    assert!(!settings.contains("const tools = ["));
}
