//! Port of `test/provider-guides-core.test.js`: how to set up each AI (`src/public/js/provider-guides-core.js`,
//! `ProviderGuides`). Settings → AI and the setup wizard's "Choose your AI" draw their steps, costs and status lines
//! from it, so it has to cover every provider Tarsee knows and match the cards on the page it fills (`index.html`).
//!
//! Not here yet, because they compare with server code that is being ported: the two checks against the provider
//! registry (`src/ai/provider-registry.js`, package A1) and the check of `routes/ai.js`'s notes (package R2). See the
//! notes at those tests.

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::support::files::{read_public, read_repo};
use crate::support::{Page, truthy};

async fn guides() -> Page {
    Page::with_scripts(&["provider-guides-core.js"]).await
}

async fn providers(page: &Page) -> Vec<Value> {
    page.eval("ProviderGuides.PROVIDERS")
        .await
        .as_array()
        .expect("providers")
        .clone()
}

async fn get(page: &Page, id: &str) -> Value {
    page.call("ProviderGuides.get", json!([id])).await
}

async fn guide_html(page: &Page, args: Value) -> String {
    page.call("ProviderGuides.guideHtml", args)
        .await
        .as_str()
        .expect("HTML")
        .to_string()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("a list")
        .iter()
        .map(|s| s.as_str().expect("text").to_string())
        .collect()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// Every piece of text a provider's guide shows: `[p.needs, p.cost, ...p.steps, ...p.tips].join("\n")`.
fn all_text(p: &Value) -> String {
    let mut parts = vec![text(&p["needs"]).to_string(), text(&p["cost"]).to_string()];
    parts.extend(strings(&p["steps"]));
    parts.extend(strings(&p["tips"]));
    parts.join("\n")
}

/// A JavaScript regular expression's test, written for the `regex` crate (`\b` as `(?-u:\b)`, `\d` as `[0-9]`).
fn matches(pattern: &str, text: &str) -> bool {
    Regex::new(pattern).expect("regex").is_match(text)
}

// ---------------------------------------------------------------- what they cover

#[tokio::test]
async fn every_provider_the_registry_knows_plans_first_in_the_order_the_wizard_offers_them() {
    let page = guides().await;
    let ids: Vec<Value> = providers(&page).await.iter().map(|p| p["id"].clone()).collect();
    assert_eq!(
        Value::Array(ids),
        json!([
            "claude",
            "chatgpt",
            "anthropic",
            "openai",
            "openrouter",
            "deepseek",
            "local"
        ])
    );
    // After package A1: the same ids, sorted, are the registry's (`PROVIDER_IDS` of src/ai/provider_registry.rs).
}

// "each kind matches the registry's: a plan sign-in, an API key, or a server you run": after package A1, which
// ports the registry it compares with (`REGISTRY[p.id].kind`: subscription -> plan, key -> key, local -> local).

#[tokio::test]
async fn each_has_a_name_a_one_line_what_it_takes_a_one_line_cost_numbered_steps_and_tips() {
    let page = guides().await;
    for p in providers(&page).await {
        let id = &p["id"];
        assert!(truthy(&p["name"]) && truthy(&p["needs"]) && truthy(&p["cost"]), "{id}");
        assert!(
            !text(&p["needs"]).contains('\n') && !text(&p["cost"]).contains('\n'),
            "{id}: one line each"
        );
        assert!(p["steps"].as_array().expect("steps").len() >= 3, "{id}: steps");
        assert!(p["tips"].as_array().is_some_and(|t| !t.is_empty()), "{id}: tips");
        assert!(!all_text(&p).contains("${"), "{id}: no template left in the text");
    }
}

#[tokio::test]
async fn the_key_providers_say_where_the_key_comes_from_and_what_one_looks_like() {
    let page = guides().await;
    for p in providers(&page).await.iter().filter(|p| p["kind"] == "key") {
        let id = &p["id"];
        assert!(matches("^https://", text(&p["getKeyUrl"])), "{id}");
        assert!(truthy(&p["keyPlaceholder"]), "{id}: a placeholder for the key box");
        assert!(
            matches(r"(?i)spend|limit|budget|top.?up|credit", &all_text(p)),
            "{id}: how to keep its spending small"
        );
    }
}

#[tokio::test]
async fn the_claude_plan_signs_in_with_claude_auth_login_in_the_terminal_or_a_railway_token() {
    let page = guides().await;
    let claude = get(&page, "claude").await;
    let text = all_text(&claude);
    assert!(
        text.contains("claude auth login"),
        "Claude Code's own sign-in command (claude auth login --help)"
    );
    assert_eq!(claude["command"], "claude auth login");
    assert!(text.contains("CLAUDE_CODE_OAUTH_TOKEN"));
    assert!(text.contains("claude setup-token"));
}

#[tokio::test]
async fn chatgpt_uses_codexs_device_code_sign_in_names_no_model_and_says_free_plans_get_less() {
    let page = guides().await;
    let text = all_text(&get(&page, "chatgpt").await);
    assert!(
        matches("Settings.*Security", &text),
        "where to turn device code sign-in on"
    );
    assert!(matches("(?i)device code", &text));
    // The switch's own name and heading as ChatGPT shows them (Settings → Security → App security).
    assert!(
        text.contains("Enable device code sign-in for Codex"),
        "the switch named as ChatGPT names it"
    );
    assert!(text.contains("App security"), "the heading the switch sits under");
    assert!(
        !text.contains("device code authorization for Codex"),
        "the old, wrong name of the switch"
    );
    assert!(text.contains("codex login --device-auth"), "the Terminal fallback");
    assert!(matches("[Ff]ree", &text));
    assert!(
        !matches(r"(?-u:\b)gpt-|Luna|Sol(?-u:\b)|Astra", &text),
        "never a hard-coded ChatGPT model"
    );
    for p in providers(&page).await {
        assert!(
            !all_text(&p).contains("Continue with ChatGPT"),
            "{}: no Continue with ChatGPT",
            p["id"]
        );
    }
}

#[tokio::test]
async fn local_ai_names_ollama_lm_studio_and_llama_cpp_with_their_usual_addresses_llama_cpps_older_8080_too() {
    let page = guides().await;
    let local = get(&page, "local").await;
    let text = all_text(&local);
    assert!(text.contains("Ollama"));
    assert!(text.contains("LM Studio"));
    assert!(text.contains("llama.cpp"));
    let presets = local["presets"].as_array().expect("presets");
    let names: Vec<&Value> = presets.iter().map(|x| &x["name"]).collect();
    assert_eq!(names, [&json!("Ollama"), &json!("LM Studio"), &json!("llama.cpp")]);
    let urls: Vec<&Value> = presets.iter().map(|x| &x["url"]).collect();
    assert_eq!(
        urls,
        [
            &json!("http://localhost:11434/v1"),
            &json!("http://localhost:1234/v1"),
            &json!("http://localhost:9931/v1")
        ]
    );
    assert!(
        local["presetNote"].as_str().unwrap_or_default().contains("8080"),
        "older builds and the Docker image"
    );
    assert!(text.contains("http://localhost:8080/v1"));
    assert!(
        local["pitch"]
            .as_str()
            .unwrap_or_default()
            .contains("Ollama, LM Studio or llama.cpp")
    );
}

#[tokio::test]
async fn local_ai_says_which_versions_speak_the_responses_api_tarsee_uses_ollama_0_13_3_lm_studio_0_3_29_llama_cpp_b11768()
 {
    let page = guides().await;
    let text = all_text(&get(&page, "local").await);
    assert!(text.contains("Ollama 0.13.3 or newer"));
    assert!(text.contains("LM Studio 0.3.29 or newer"));
    assert!(text.contains("b11768 (v0.8.0) or newer"));
}

#[tokio::test]
async fn local_ai_on_llama_cpp_how_to_install_it_everywhere_the_command_with_a_tagged_hf_alias_and_enough_c_and_the_tips()
 {
    let page = guides().await;
    let local = get(&page, "local").await;
    let steps = strings(&local["steps"]).join("\n");
    assert!(steps.contains("winget install ggml.llamacpp"), "Windows");
    assert!(matches(r"win-cuda[\s\S]*cudart", &steps), "an NVIDIA card's two zips");
    assert!(steps.contains("brew install llama.cpp"), "Mac and Linux");
    assert!(steps.contains("llama-server --version"));
    let command = Regex::new(r"<code>(llama-server -hf [^<]+)</code>")
        .expect("regex")
        .captures(&steps)
        .map(|c| c[1].to_string());
    let command = command.expect("the command to start it");
    assert!(
        matches(r"-hf \S+/\S+:Q[0-9][A-Za-z0-9_]*", &command),
        "always a quant tag after the colon: {command}"
    );
    assert!(matches(r"--alias \S+", &command), "{command}");
    let ctx: u64 = Regex::new(r"-c ([0-9]+)")
        .expect("regex")
        .captures(&command)
        .and_then(|c| c[1].parse().ok())
        .unwrap_or(0);
    assert!(ctx >= 32_768, "-c {ctx} leaves Tarsee room");
    assert!(steps.contains("at least 32768"));
    let tips = strings(&local["tips"]).join("\n");
    assert!(tips.contains("--host 0.0.0.0"));
    assert!(tips.contains("--api-key"));
    assert!(tips.contains("after the colon"));
    assert!(tips.contains("not an OpenAI model's name"));
}

#[tokio::test]
async fn the_anthropic_key_is_made_in_a_workspace_a_key_outside_one_needs_a_header_tarsee_doesnt_send() {
    let page = guides().await;
    let a = get(&page, "anthropic").await;
    assert!(
        matches(
            r"(?i)<strong>Create key</strong>[\s\S]*workspace",
            &strings(&a["steps"]).join("\n")
        ),
        "the step that makes the key picks a workspace"
    );
    assert!(
        matches("(?i)workspace", &strings(&a["tips"]).join("\n")),
        "and the tip for when Test says so"
    );
    assert!(
        all_text(&a).contains("starts with <code>sk-ant-</code>"),
        "the prefix the Console documents"
    );
}

#[tokio::test]
async fn the_plan_vs_key_note_says_plans_are_for_your_own_use_and_api_keys_for_other_people() {
    let page = guides().await;
    let note = page.eval("ProviderGuides.TERMS_NOTE").await;
    let note = text(&note);
    assert!(matches("(?i)own (personal )?use", note), "{note}");
    assert!(note.contains("API key"), "{note}");
    assert!(matches("(?i)other people|team|customers", note), "{note}");
}

#[tokio::test]
async fn every_key_providers_guide_and_card_and_the_docs_say_a_command_the_agent_runs_can_still_read_the_key_design_4_5_r10_a9()
 {
    // Both engines keep the key out of the environment of the commands the agent runs, but those commands run as the
    // same user as the engine, so on Linux they can still read it from the engine's process
    // (test/key-exposure-linux.test.js). A capped key is the real guard, so every place that takes a key says so.
    let docs = read_repo("docs/providers.md");
    let stated = "(?i)can still read (this|the) key";
    let page = guides().await;
    let all = providers(&page).await;
    for p in all
        .iter()
        .filter(|p| ["anthropic", "openai", "openrouter", "deepseek", "local"].contains(&text(&p["id"])))
    {
        assert!(matches(stated, &all_text(p)), "{}", p["id"]);
    }
    assert!(matches(stated, &docs), "docs/providers.md");
    // After package R2: the same of routes/ai.rs's notesFor (the Node test read src/routes/ai.js).
    let promises = r"(?i)kept out of the agent['’]s shell|commands the agent runs can['’]?t read|can['’]?t read (it|this key|the key)|(?-u:\b)kept out(?-u:\b)";
    let mut texts: Vec<(String, String)> = all.iter().map(|p| (text(&p["id"]).to_string(), all_text(p))).collect();
    texts.push(("docs/providers.md".to_string(), docs));
    for (name, text) in texts {
        assert!(!matches(promises, &text), "{name} promises the key can't be read");
    }
}

#[tokio::test]
async fn the_wizards_three_choices_the_two_plans_then_the_five_key_providers() {
    let page = guides().await;
    let wizard = page.eval("ProviderGuides.WIZARD").await;
    assert_eq!(wizard["plans"], json!(["claude", "chatgpt"]));
    assert_eq!(
        wizard["keys"],
        json!(["anthropic", "openai", "openrouter", "deepseek", "local"])
    );
    for id in strings(&wizard["plans"]).into_iter().chain(strings(&wizard["keys"])) {
        assert!(truthy(&get(&page, &id).await), "{id}");
    }
}

// ---------------------------------------------------------------- the page they fill

#[tokio::test]
async fn each_provider_has_its_own_card_on_the_ai_tab_with_a_status_line_a_place_for_its_guide_and_its_controls() {
    let page_html = read_public("index.html");
    let page = guides().await;
    for p in providers(&page).await {
        let id = text(&p["id"]);
        let section = text(&p["section"]);
        assert!(matches(&format!(r#"id="{section}""#), &page_html), "{id}: card");
        assert!(
            matches(&format!(r#"id="{id}AiStatus""#), &page_html),
            "{id}: status line"
        );
        assert!(
            matches(&format!(r#"data-ai-guide-slot="{id}""#), &page_html),
            "{id}: guide slot"
        );
        assert!(
            matches(&format!(r#"data-ai-body="{id}""#), &page_html),
            "{id}: controls"
        );
    }
}

#[tokio::test]
async fn links_open_in_a_new_tab_over_https() {
    let page = guides().await;
    let mut texts: Vec<String> = providers(&page).await.iter().map(all_text).collect();
    texts.push(text(&page.eval("ProviderGuides.TERMS_NOTE").await).to_string());
    let anchor = Regex::new(r"<a [^>]*>").expect("regex");
    let mut links = 0;
    for t in &texts {
        for a in anchor.find_iter(t).map(|m| m.as_str()) {
            links += 1;
            assert!(a.contains(r#"href="https://"#), "{a}");
            assert!(a.contains(r#"target="_blank""#), "{a}");
            assert!(a.contains(r#"rel="noopener noreferrer""#), "{a}");
        }
    }
    assert!(links >= 10, "the guides link to where things are done");
}

#[tokio::test]
async fn draws_a_guide_as_steps_in_order_the_cost_and_the_tips_folded_unless_asked_open() {
    let page = guides().await;
    let html = guide_html(&page, json!(["deepseek"])).await;
    assert!(
        html.starts_with(r#"<details class="channel-guide ai-guide" data-ai-guide="deepseek">"#),
        "{html}"
    );
    assert!(html.contains("<summary>How to set up DeepSeek</summary>"));
    let d = get(&page, "deepseek").await;
    let steps = strings(&d["steps"]);
    assert_eq!(html.matches("<li>").count(), steps.len() + strings(&d["tips"]).len());
    let at = |part: &str| html.find(part).map_or(-1, |i| i as i64);
    assert!(at(&steps[0]) < at(&steps[1]), "steps in order");
    assert!(html.contains(text(&d["cost"])), "what it costs");
    assert!(
        guide_html(&page, json!(["claude", { "open": true }]))
            .await
            .contains(r#"data-ai-guide="claude" open>"#)
    );
    assert_eq!(guide_html(&page, json!(["nope"])).await, "");
}

#[tokio::test]
async fn the_setup_wizards_steps_name_the_wizards_own_buttons_not_settings_ais_save_key_test_use_this_ai_verify() {
    let setup = read_public("js/setup.js");
    let page = guides().await;
    let wizard = page.eval("ProviderGuides.WIZARD").await;
    let wizard_ids: Vec<String> = strings(&wizard["plans"])
        .into_iter()
        .chain(strings(&wizard["keys"]))
        .collect();
    let wizard_steps = |id: &str| {
        let page = &page;
        let id = id.to_string();
        async move {
            let html = guide_html(page, json!([id, { "wizard": true }])).await;
            Regex::new(r#"<ol class="channel-guide-steps">([\s\S]*?)</ol>"#)
                .expect("regex")
                .captures(&html)
                .map(|c| c[1].to_string())
                .unwrap_or_else(|| panic!("{id}: no steps in {html}"))
        }
    };
    let tags = Regex::new(r"<[^>]+>").expect("regex");
    for id in &wizard_ids {
        let steps = wizard_steps(id).await;
        // (Other companies' pages have buttons of their own, OpenAI's Save among them: only Tarsee's Settings words
        // are out.)
        assert!(
            !matches(
                r"<strong>(Save key|Test|Use this AI|Verify)</strong>|<strong>Save</strong>, then|&gt;_",
                &steps
            ),
            "{id}"
        );
        // Read as text, as a person does: "click Test" would send them to a button the wizard doesn't have.
        assert!(
            !matches(
                r"click (Save key|Test|Use this AI|Verify)(?-u:\b)|(?-u:\b)Test (shows|lists)(?-u:\b)",
                &tags.replace_all(&steps, "")
            ),
            "{id}"
        );
    }
    for id in ["anthropic", "openai", "openrouter", "deepseek"] {
        assert!(
            wizard_steps(id).await.contains("<strong>Test and save</strong>"),
            "{id}"
        );
    }
    assert!(wizard_steps("local").await.contains("<strong>Save and test</strong>"));
    for id in ["chatgpt", "anthropic", "openai", "openrouter", "deepseek", "local"] {
        assert!(wizard_steps(id).await.contains("click <strong>Next</strong>"), "{id}");
    }
    assert!(
        wizard_steps("claude")
            .await
            .contains("<strong>Open the Terminal</strong> below")
    );
    assert!(
        wizard_steps("openrouter").await.contains("later in Settings → AI"),
        "OpenRouter's other models are verified there"
    );
    // The buttons the wizard's steps name are the ones setup.js draws.
    assert!(setup.contains(">Test and save<"));
    assert!(setup.contains(">Save and test<"));
    assert!(setup.contains("`Next: use "));
    assert!(setup.contains(">Open the Terminal ↗<"));
    assert!(
        matches(r"guideHtml\(id, \{[^}]*wizard: true", &setup),
        "and the wizard asks for its own wording"
    );
    // Settings → AI keeps its own.
    assert!(
        guide_html(&page, json!(["deepseek"]))
            .await
            .contains("click <strong>Save key</strong>, then <strong>Test</strong>")
    );
    assert!(
        guide_html(&page, json!(["local"]))
            .await
            .contains("click <strong>Save</strong>, then <strong>Test</strong>")
    );
    assert!(
        guide_html(&page, json!(["openrouter"]))
            .await
            .contains("click <strong>Verify</strong> first")
    );
    assert!(guide_html(&page, json!(["claude"])).await.contains("&gt;_"));
    assert_eq!(
        guide_html(&page, json!(["deepseek", { "wizard": true }]))
            .await
            .matches("<li>")
            .count(),
        guide_html(&page, json!(["deepseek"])).await.matches("<li>").count(),
        "the same steps and tips"
    );
}

// ---------------------------------------------------------------- status in words

/// A provider card from GET /api/ai/providers: DeepSeek, ready, with `over` on top.
fn card(over: Value) -> Value {
    let mut base: Map<String, Value> = json!({
        "id": "deepseek", "label": "DeepSeek", "state": "ready", "ready": true,
        "detail": "Key saved in Tarsee (…a1b2).", "fix": null, "model": "deepseek-flash",
    })
    .as_object()
    .expect("an object")
    .clone();
    for (key, value) in over.as_object().expect("an object") {
        base.insert(key.clone(), value.clone());
    }
    Value::Object(base)
}

async fn status_line(page: &Page, args: Value) -> Value {
    page.call("ProviderGuides.statusLine", args).await
}

#[tokio::test]
async fn a_ready_ai_says_what_it_uses_and_its_balance() {
    let page = guides().await;
    assert_eq!(
        status_line(&page, json!([card(json!({})), { "modelLabel": "DeepSeek Flash" }])).await,
        json!({ "text": "Ready, using DeepSeek Flash", "tone": "ok" })
    );
    assert_eq!(
        status_line(&page, json!([card(json!({}))])).await,
        json!({ "text": "Ready, using deepseek-flash", "tone": "ok" })
    );
    assert_eq!(
        status_line(
            &page,
            json!([card(json!({ "balance": { "text": "Balance $4.20" } })), { "modelLabel": "DeepSeek Flash" }])
        )
        .await,
        json!({ "text": "Ready, using DeepSeek Flash · Balance $4.20", "tone": "ok" })
    );
    assert_eq!(
        status_line(
            &page,
            json!([card(
                json!({ "id": "chatgpt", "model": null, "account": "you@example.com (Free)" })
            )])
        )
        .await,
        json!({ "text": "Ready, signed in as you@example.com (Free), using your account's default model", "tone": "ok" })
    );
}

#[tokio::test]
async fn an_ai_that_isnt_ready_says_whats_wrong_and_what_to_do() {
    let page = guides().await;
    let line = |over: Value| {
        let page = &page;
        async move { status_line(page, json!([card(over)])).await }
    };
    assert_eq!(
        line(
            json!({ "state": "needs-key", "ready": false, "detail": "No DeepSeek key yet.", "fix": "Paste one below." })
        )
        .await,
        json!({ "text": "No DeepSeek key yet. Paste one below.", "tone": "off" })
    );
    assert_eq!(
        line(json!({ "state": "out-of-credit", "ready": false, "detail": "The balance is empty.", "fix": null })).await,
        json!({ "text": "The balance is empty.", "tone": "bad" })
    );
    assert_eq!(
        line(json!({ "state": "sign-in-expired", "ready": false, "detail": "Expired." })).await["tone"],
        "bad"
    );
    assert_eq!(
        line(json!({ "state": "error", "ready": false, "detail": "Rejected." })).await["tone"],
        "bad"
    );
    assert_eq!(
        line(json!({ "state": "needs-sign-in", "ready": false, "detail": "Nobody has signed in." })).await["tone"],
        "off"
    );
    assert_eq!(
        line(json!({ "state": "needs-setup", "ready": false, "detail": "No address." })).await["tone"],
        "off"
    );
    assert_eq!(
        line(json!({ "state": "blocked-keys-only", "ready": false, "detail": "x" })).await,
        json!({ "text": "Off: \"Only use API keys\" is on", "tone": "off" })
    );
    assert_eq!(
        page.eval("ProviderGuides.statusLine(undefined)").await,
        json!({ "text": "Checking…", "tone": "wait" })
    );
}

#[tokio::test]
async fn a_short_word_for_each_state_for_the_chips_and_the_header() {
    let page = guides().await;
    let word = |state: &'static str| {
        let page = &page;
        async move { page.call("ProviderGuides.stateWord", json!([state])).await }
    };
    let tone = |state: &'static str| {
        let page = &page;
        async move { page.call("ProviderGuides.toneOf", json!([state])).await }
    };
    assert_eq!(word("ready").await, "Ready");
    assert_eq!(word("needs-key").await, "Needs a key");
    assert_eq!(word("needs-sign-in").await, "Needs sign-in");
    assert_eq!(word("sign-in-expired").await, "Sign-in expired");
    assert_eq!(word("out-of-credit").await, "Out of credit");
    assert_eq!(word("blocked-keys-only").await, "Off (API keys only)");
    assert_eq!(word("needs-setup").await, "Needs setup");
    assert_eq!(word("error").await, "Needs attention");
    assert_eq!(tone("ready").await, "ok");
    assert_eq!(tone("out-of-credit").await, "bad");
    assert_eq!(tone("needs-key").await, "off");
}

#[tokio::test]
async fn a_test_result_in_words_the_balance_or_the_spending_limit_left() {
    let page = guides().await;
    let test_line = |result: Value| {
        let page = &page;
        async move { page.call("ProviderGuides.testLine", json!([result])).await }
    };
    assert_eq!(
        test_line(json!({ "ok": true, "message": "Key works · Balance $4.20" })).await,
        json!({ "text": "✓ Key works · Balance $4.20", "tone": "ok" })
    );
    assert_eq!(
        test_line(
            json!({ "ok": false, "message": "Key works, but the balance is empty. Top up at platform.deepseek.com." })
        )
        .await,
        json!({ "text": "✗ Key works, but the balance is empty. Top up at platform.deepseek.com.", "tone": "bad" })
    );
    assert_eq!(
        test_line(json!({ "ok": false, "state": "needs-key", "message": "No key yet." })).await,
        json!({ "text": "No key yet.", "tone": "off" })
    );
}
