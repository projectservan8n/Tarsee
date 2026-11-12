//! Port of `test/provider-status.test.js`: providerStatus(id, deps) (design 4.3 and 4.14): one answer per provider to
//! "can this AI answer right now, and if not, what does the owner do?", read from Settings, the environment, the
//! sign-in files and the failure flags the engines write. It never makes a network call (the balances it shows come
//! from the 10-minute cache the Test and the provider cards fill), and it never hands out a key: only where it came
//! from and its last 4 characters. Also the one boot line ("[ai] default=... engine=... key=... state"). Every key
//! here is an obvious fake, put together from parts.
//!
//! The JS ran on a real SettingsStore; here the store lives in memory (`MemorySettings`), and where the JS set
//! `process.env` for a key's Railway variable, the test app's own environment is set.

use serde_json::json;

use super::*;
use crate::testkit::{MemorySettings, TestApp, test_app_with_env};

fn key(id: &str) -> String {
    let tail = match id {
        "anthropic" => "ant-api03-test-canary-Anth5Rz9",
        "openai" => "test-canary-Openai7Wx2",
        "openrouter" => "or-v1-testcanaryRouter9Q",
        "deepseek" => "testcanaryDeepseek3Kp",
        _ => return format!("test-{}", "canary-Local8Mn"),
    };
    format!("sk-{tail}")
}

fn last4(key: &str) -> String {
    format!("…{}", &key[key.len() - 4..])
}

type Homes = Box<dyn Fn() -> Vec<PathBuf> + Send + Sync>;

/// One test's app, store and the deps the JS `deps(store, extra)` gave: an empty environment, the state folder, a
/// Claude home with no sign-in (so the machine's own never counts), and a ChatGPT sign-in check that says no.
struct Fx {
    t: TestApp,
    store: MemorySettings,
    env: Env,
    homes: Homes,
    login: Box<LoginStatusFn>,
    /// Every check the sign-in seam was asked.
    asked: std::sync::Arc<parking_lot::Mutex<Vec<LoginCheck>>>,
    empty_home: PathBuf,
    signed_in_home: PathBuf,
}

fn fx() -> Fx {
    let t = test_app_with_env([("ENCRYPTION_KEY", format!("test-only-encryption-key-{}", "0".repeat(40)))]);
    let empty_home = t.path().join("claude-empty");
    let signed_in_home = t.path().join("claude-signed");
    std::fs::create_dir_all(&empty_home).unwrap();
    std::fs::create_dir_all(&signed_in_home).unwrap();
    std::fs::write(
        signed_in_home.join(".credentials.json"),
        "{\"claudeAiOauth\":{\"accessToken\":\"test-canary\"}}",
    )
    .unwrap();
    let homes = empty_home.clone();
    let mut fx = Fx {
        t,
        store: MemorySettings::new(),
        env: Env::new(),
        homes: Box::new(move || vec![homes.clone()]),
        login: Box::new(|_| Box::pin(async { Ok(json!({})) })),
        asked: std::sync::Arc::default(),
        empty_home,
        signed_in_home,
    };
    fx.login_says(json!({ "signedIn": false }));
    fx
}

impl Fx {
    fn deps(&self) -> StatusDeps<'_> {
        StatusDeps {
            store: Some(&self.store),
            env: Some(&self.env),
            state_dir: Some(self.t.path()),
            claude_homes: Some(&*self.homes),
            login_status: Some(&*self.login),
            ..StatusDeps::default()
        }
    }

    fn homes(&mut self, homes: Vec<PathBuf>) {
        self.homes = Box::new(move || homes.clone());
    }

    /// The ChatGPT sign-in check answers this from now on.
    fn login_says(&mut self, answer: Value) {
        let asked = self.asked.clone();
        self.login = Box::new(move |check| {
            asked.lock().push(check);
            let answer = answer.clone();
            Box::pin(async move { Ok(answer) })
        });
    }

    fn set(&self, key: &str, value: Value) {
        self.store.set(key, value).unwrap();
    }

    async fn status(&self, id: &str) -> ProviderStatus {
        provider_status(&self.t, id, &self.deps()).await
    }
}

fn iso_now() -> String {
    js::now_iso()
}

/// Nothing in a status may carry a key, whole or in part beyond its last 4 characters.
fn assert_no_key(value: &impl Serialize, key: &str) {
    let text = serde_json::to_string(value).unwrap();
    assert!(!text.contains(key), "the key leaked: {text}");
    assert!(!text.contains(&key[..key.len() - 4]), "most of the key leaked: {text}");
}

// --- providerStatus: every provider has an answer ---

#[tokio::test]
async fn every_provider_id_gives_one_of_the_eight_states_with_a_plain_detail() {
    let f = fx();
    for p in PROVIDERS.iter() {
        let s = f.status(p.id).await;
        assert!(PROVIDER_STATES.contains(&s.state), "{}: {}", p.id, s.state);
        assert_eq!(s.id, p.id);
        assert!(!s.label.is_empty());
        assert!(!s.detail.is_empty(), "{}", p.id);
        assert_eq!(s.ready, s.state == ProviderState::Ready);
    }
    assert_eq!(PROVIDER_STATES.len(), 8);
    let names: Vec<&str> = PROVIDER_STATES.iter().map(|s| s.as_str()).collect();
    assert_eq!(
        names,
        [
            "ready",
            "needs-key",
            "needs-sign-in",
            "sign-in-expired",
            "out-of-credit",
            "blocked-keys-only",
            "needs-setup",
            "error"
        ]
    );
}

#[tokio::test]
async fn an_unknown_provider_is_an_error_not_a_throw() {
    let f = fx();
    let s = f.status("gemini").await;
    assert_eq!(s.state, ProviderState::Error);
    assert!(s.detail.to_lowercase().contains("doesn't know"));
    assert_eq!(
        serde_json::to_value(&s).unwrap(),
        json!({
            "id": "gemini", "label": "gemini", "kind": null, "state": "error", "ready": false,
            "detail": "Tarsee doesn't know an AI called \"gemini\".", "fix": null,
            "keySource": null, "keyHint": null, "keySourceText": null, "account": null, "balance": null,
        })
    );
    assert_eq!(credential_presence(&f.t, "gemini", &f.deps()), s);
}

#[tokio::test]
async fn the_claude_plans_storage_id_is_the_same_provider() {
    let f = fx();
    assert_eq!(f.status("claude-code").await.id, "claude");
}

// --- key providers ---

const KEY_PROVIDERS: [(&str, &str); 4] = [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
];

#[tokio::test]
async fn no_key_is_needs_key_naming_the_railway_variable_a_saved_key_is_ready_and_shows_only_its_last_4() {
    for (id, env_key) in KEY_PROVIDERS {
        let f = fx();
        let none = f.status(id).await;
        assert_eq!(none.state, ProviderState::NeedsKey, "{id}");
        assert!(none.fix.as_deref().unwrap().contains(env_key), "{id}");
        assert_eq!(none.key_source, None);

        f.set(&format!("ai.{id}.apiKey"), json!(key(id)));
        let saved = f.status(id).await;
        assert_eq!(saved.state, ProviderState::Ready, "{id}: {}", saved.detail);
        assert_eq!(saved.key_source.as_deref(), Some("settings"));
        assert_eq!(saved.key_hint, Some(last4(&key(id))));
        assert_eq!(saved.key_source_text.as_deref(), Some("Saved in Tarsee (encrypted)"));
        assert_eq!(saved.detail, format!("Key saved in Tarsee ({}).", last4(&key(id))));
        assert_no_key(&saved, &key(id));
    }
}

#[tokio::test]
async fn a_key_from_the_railway_variable_says_so() {
    for (id, env_key) in KEY_PROVIDERS {
        let f = fx();
        // (The JS set process.env: the store reads a key's variable from the server's environment, not deps.env.)
        f.t.env().set(env_key, key(id));
        let s = f.status(id).await;
        assert_eq!(s.state, ProviderState::Ready, "{id}: {}", s.detail);
        assert_eq!(s.key_source, Some(format!("env:{env_key}")));
        assert_eq!(s.key_source_text, Some(format!("Railway variable {env_key}")));
        assert_eq!(
            s.detail,
            format!("Key from the Railway variable {env_key} ({}).", last4(&key(id)))
        );
        assert_no_key(&s, &key(id));
    }
}

#[tokio::test]
async fn a_key_in_the_wrong_slot_is_an_error_that_says_whose_key_it_is_a_claude_sign_in_token_as_the_anthropic_key() {
    let f = fx();
    let token = format!("sk-{}", "ant-oat01-test-canary-SignIn4Tk");
    f.t.env().set("ANTHROPIC_API_KEY", token.clone());
    let s = f.status("anthropic").await;
    assert_eq!(s.state, ProviderState::Error);
    assert!(s.detail.contains("Claude sign-in token"), "{}", s.detail);
    assert!(s.fix.as_deref().unwrap().contains("ANTHROPIC_API_KEY"));
    assert_eq!(
        s.fix.as_deref(),
        Some(
            "Fix the Railway variable ANTHROPIC_API_KEY, or paste a key in Settings > AI (a saved key is used first)."
        )
    );
    assert_no_key(&s, &token);
}

#[tokio::test]
async fn an_openrouter_key_saved_as_the_deepseek_key_is_an_error_naming_openrouter() {
    let f = fx();
    f.set("ai.deepseek.apiKey", json!(key("openrouter")));
    let s = f.status("deepseek").await;
    assert_eq!(s.state, ProviderState::Error);
    assert!(s.detail.contains("OpenRouter key"), "{}", s.detail);
    assert_eq!(s.fix.as_deref(), Some("Replace it in Settings > AI."));
    assert_eq!(s.key_source.as_deref(), Some("settings"));
}

#[tokio::test]
async fn the_engines_failure_flag_a_rejected_key_is_an_error_an_empty_balance_is_out_of_credit() {
    let f = fx();
    f.set("ai.deepseek.apiKey", json!(key("deepseek")));
    f.set(
        "ai.deepseek.status",
        json!({ "state": "auth", "at": iso_now(), "detail": "401 from the gateway" }),
    );
    let s = f.status("deepseek").await;
    assert_eq!(s.state, ProviderState::Error);
    assert!(s.detail.contains("DeepSeek key was rejected"), "{}", s.detail);
    assert!(!s.ready);
    f.set("ai.deepseek.status", json!({ "state": "billing", "at": iso_now() }));
    let s = f.status("deepseek").await;
    assert_eq!(s.state, ProviderState::OutOfCredit);
    assert!(s.fix.as_deref().unwrap().contains("platform.deepseek.com"));
    // The values the turn layer writes (turn.js writeFailureFlag) and engine-errors' failureStateFor.
    f.set(
        "ai.deepseek.status",
        json!({ "state": "out-of-credit", "at": iso_now() }),
    );
    assert_eq!(f.status("deepseek").await.state, ProviderState::OutOfCredit);
    f.set(
        "ai.deepseek.status",
        json!({ "state": "error", "at": iso_now(), "detail": "The key was turned down." }),
    );
    let s = f.status("deepseek").await;
    assert_eq!(s.state, ProviderState::Error);
    assert!(s.detail.contains("turned down"));
    assert_eq!(s.fix.as_deref(), Some("Press Test in Settings > AI to check it again."));
    f.set("ai.deepseek.status", json!({ "state": "needs-key", "at": iso_now() }));
    assert_eq!(
        f.status("deepseek").await.state,
        ProviderState::Ready,
        "a flag that disagrees with the facts (the key is there) doesn't count"
    );
    let ignoring = StatusDeps {
        ignore_flags: true,
        ..f.deps()
    };
    assert_eq!(
        provider_status(&f.t, "deepseek", &ignoring).await.state,
        ProviderState::Ready
    );
    f.store.delete("ai.deepseek.status");
    assert_eq!(f.status("deepseek").await.state, ProviderState::Ready);
    // A flag that would count is passed over when the caller says so (the Test button).
    f.set("ai.deepseek.status", json!({ "state": "auth", "at": iso_now() }));
    assert_eq!(
        provider_status(&f.t, "deepseek", &ignoring).await.state,
        ProviderState::Ready
    );
}

#[tokio::test]
async fn a_fresh_cached_balance_shows_on_the_card_and_an_empty_one_is_out_of_credit_a_stale_or_another_keys_is_ignored()
{
    let f = fx();
    f.set("ai.openrouter.apiKey", json!(key("openrouter")));
    let hint = last4(&key("openrouter"));
    let now = js::now_ms();
    let at = |now: i64| StatusDeps {
        now: Some(now),
        ..f.deps()
    };
    let limit = |remaining: f64, empty: bool, text: &str| json!({ "kind": "limit", "currency": "USD", "remaining": remaining, "limit": 2, "empty": empty, "text": text });
    save_balance(
        &f.store,
        "openrouter",
        &limit(1.8, false, "Spending limit left $1.80 of $2.00"),
        now,
        Some(&hint),
    )
    .unwrap();
    let s = provider_status(&f.t, "openrouter", &at(now)).await;
    assert_eq!(s.state, ProviderState::Ready);
    assert_eq!(
        s.balance.as_ref().unwrap()["text"],
        "Spending limit left $1.80 of $2.00"
    );
    assert_eq!(
        s.detail,
        format!("Key saved in Tarsee ({hint}). Spending limit left $1.80 of $2.00.")
    );

    save_balance(
        &f.store,
        "openrouter",
        &limit(0.0, true, "Spending limit left $0.00 of $2.00"),
        now,
        Some(&hint),
    )
    .unwrap();
    let s = provider_status(&f.t, "openrouter", &at(now)).await;
    assert_eq!(s.state, ProviderState::OutOfCredit);
    assert!(s.fix.as_deref().unwrap().contains("openrouter.ai/settings/keys"));
    assert!(s.balance.is_some() && !s.ready);

    let s = provider_status(&f.t, "openrouter", &at(now + BALANCE_TTL_MS + 1)).await;
    assert_eq!(s.state, ProviderState::Ready, "a stale balance no longer decides");
    assert_eq!(s.balance, None);

    save_balance(&f.store, "openrouter", &limit(0.0, true, "x"), now, Some("…zzzz")).unwrap();
    let s = provider_status(&f.t, "openrouter", &at(now)).await;
    assert_eq!(
        s.state,
        ProviderState::Ready,
        "a balance read for another key doesn't count"
    );
    assert_eq!(BALANCE_TTL_MS, 600_000);
}

// --- the Claude plan ---

#[tokio::test]
async fn no_sign_in_is_needs_sign_in_with_claude_auth_login_and_the_railway_variable_as_fixes() {
    let f = fx();
    let s = f.status("claude").await;
    assert_eq!(s.state, ProviderState::NeedsSignIn);
    let fix = s.fix.as_deref().unwrap();
    assert!(fix.contains("claude auth login"));
    // The pinned CLI has no top-level `login` (it would open a chat), and the card's only button is Check.
    assert!(!fix.contains("claude login"));
    assert!(fix.contains("click Check"));
    assert!(!fix.to_lowercase().contains("press test"));
    assert!(fix.contains("CLAUDE_CODE_OAUTH_TOKEN"));
    assert_eq!(s.detail, "Nobody has signed in to the Claude plan yet.");
}

#[tokio::test]
async fn a_credentials_json_in_a_claude_home_is_ready() {
    let mut f = fx();
    f.homes(vec![f.empty_home.clone(), f.signed_in_home.clone()]);
    let s = f.status("claude").await;
    assert_eq!(s.state, ProviderState::Ready, "{}", s.detail);
    assert_eq!(s.key_source.as_deref(), Some("sign-in"));
    assert_eq!(s.key_source_text.as_deref(), Some("Signed in with claude auth login"));
    assert_eq!(s.detail, "Signed in to your Claude plan.");
    assert_eq!(s.key_hint, None);
}

#[tokio::test]
async fn claude_code_oauth_token_in_the_environment_is_ready_shown_by_name_and_last_4_only() {
    let f = fx();
    let token = format!("sk-{}", "ant-oat01-test-canary-Railway7Qz");
    f.env.set("CLAUDE_CODE_OAUTH_TOKEN", token.clone());
    let s = f.status("claude").await;
    assert_eq!(s.state, ProviderState::Ready);
    assert_eq!(s.key_source.as_deref(), Some("env:CLAUDE_CODE_OAUTH_TOKEN"));
    assert_eq!(s.key_hint, Some(last4(&token)));
    assert_eq!(
        s.detail,
        "Signed in to your Claude plan through the Railway variable CLAUDE_CODE_OAUTH_TOKEN."
    );
    assert_no_key(&s, &token);
}

#[tokio::test]
async fn a_refresh_token_login_counts_as_signed_in_too() {
    let f = fx();
    f.env.set("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "test-canary-refresh-Rf3");
    f.env.set("CLAUDE_CODE_OAUTH_SCOPES", "user:inference");
    let s = f.status("claude").await;
    assert_eq!(s.state, ProviderState::Ready);
    assert_eq!(s.key_source.as_deref(), Some("env:CLAUDE_CODE_OAUTH_REFRESH_TOKEN"));
}

#[tokio::test]
async fn an_expired_sign_in_flag_is_sign_in_expired() {
    let mut f = fx();
    f.set("ai.claude.status", json!({ "state": "auth-expired", "at": iso_now() }));
    f.homes(vec![f.signed_in_home.clone()]);
    let s = f.status("claude").await;
    assert_eq!(s.state, ProviderState::SignInExpired);
    let fix = s.fix.as_deref().unwrap();
    assert!(fix.contains("claude auth login"));
    let both = format!("{} {fix}", s.detail);
    assert!(!both.contains("claude login"));
    assert_eq!(
        both.split("claude auth login").count(),
        2,
        "the command is said once, not in the detail too"
    );
    assert_eq!(s.detail, "Claude's sign-in has expired.");
}

#[tokio::test]
async fn api_keys_only_blocks_it_and_says_how_to_turn_that_off_or_that_a_railway_variable_locks_it() {
    let mut f = fx();
    f.homes(vec![f.signed_in_home.clone()]);
    f.set("ai.keysOnly", json!(true));
    let s = f.status("claude").await;
    assert_eq!(s.state, ProviderState::BlockedKeysOnly);
    assert!(s.fix.as_deref().unwrap().contains("Settings > AI"));
    assert_eq!(s.detail, "\"API keys only\" is on, so the Claude plan isn't used.");
    let mut f = fx();
    f.homes(vec![f.signed_in_home.clone()]);
    f.env.set("TARSEE_KEYS_ONLY", "1");
    let s = f.status("claude").await;
    assert_eq!(s.state, ProviderState::BlockedKeysOnly);
    assert!(s.fix.as_deref().unwrap().contains("TARSEE_KEYS_ONLY"));
}

// --- the ChatGPT plan ---

#[tokio::test]
async fn reads_codexs_own_sign_in_through_login_status_in_the_codex_home_under_the_state_folder() {
    let mut f = fx();
    f.login_says(json!({ "signedIn": true, "email": "owner@example.com", "plan": "free" }));
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::Ready);
    assert_eq!(s.account.as_deref(), Some("owner@example.com (Free)"));
    assert_eq!(f.asked.lock()[0].codex_home, f.t.path().join(".codex-home"));
    assert_eq!(s.detail, "Signed in as owner@example.com (Free).");
    assert_eq!(s.key_source_text.as_deref(), Some("Signed in with ChatGPT"));
}

#[tokio::test]
async fn not_signed_in_is_needs_sign_in_an_expired_sign_in_is_sign_in_expired() {
    let mut f = fx();
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::NeedsSignIn);
    let fix = s.fix.as_deref().unwrap();
    assert!(fix.contains("Settings > AI"));
    assert!(fix.contains("codex login --device-auth"));
    f.login_says(json!({ "signedIn": true, "expired": true }));
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::SignInExpired);
    assert_eq!(
        format!("{} {}", s.detail, s.fix.as_deref().unwrap())
            .split("codex login --device-auth")
            .count(),
        2,
        "the command is said once, not in the detail too"
    );
    // The ChatGPT card's only button is Check, like the Claude plan's.
    f.set("ai.chatgpt.status", json!({ "state": "error", "at": iso_now() }));
    f.login_says(json!({ "signedIn": true, "method": "chatgpt" }));
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::Error);
    let fix = s.fix.as_deref().unwrap();
    assert!(fix.contains("Click Check"));
    assert!(!fix.contains("Press Test"));
}

#[tokio::test]
async fn an_api_key_login_or_some_other_kind_in_the_chatgpt_sign_in_folder_is_not_a_chatgpt_sign_in() {
    let mut f = fx();
    f.login_says(json!({ "signedIn": true, "authMode": "apikey" }));
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::NeedsSignIn);
    assert_eq!(
        s.detail,
        "The ChatGPT sign-in folder holds an API-key login, not a ChatGPT sign-in."
    );
    f.login_says(json!({ "signedIn": true, "method": "api" }));
    assert_eq!(f.status("chatgpt").await.state, ProviderState::NeedsSignIn);
    f.login_says(json!({ "signedIn": true, "method": "other" }));
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::NeedsSignIn);
    assert!(s.detail.contains("some other way"));
    f.login_says(json!({ "signedIn": true, "method": "chatgpt", "email": "owner@example.com" }));
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::Ready);
    assert_eq!(s.account.as_deref(), Some("owner@example.com"));
}

#[tokio::test]
async fn the_cards_read_the_sign_in_file_without_starting_codex_test_asks_codex_itself() {
    let mut f = fx();
    f.login_says(json!({ "signedIn": true, "method": "chatgpt" }));
    f.status("chatgpt").await;
    assert!(!f.asked.lock()[0].cli);
    let test_button = StatusDeps {
        login_cli: true,
        ..f.deps()
    };
    provider_status(&f.t, "chatgpt", &test_button).await;
    assert!(f.asked.lock()[1].cli);
}

#[tokio::test]
async fn a_sign_in_check_that_throws_is_an_error_not_a_crash() {
    let mut f = fx();
    f.login = Box::new(|_| Box::pin(async { Err(anyhow::anyhow!("codex missing")) }));
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::Error);
    assert!(s.detail.contains("codex missing"));
    assert_eq!(s.detail, "Tarsee couldn't check the ChatGPT sign-in: codex missing");
    assert_eq!(
        s.fix.as_deref(),
        Some("Try again in a moment; if it keeps failing, sign in again in Settings > AI.")
    );
}

#[tokio::test]
async fn api_keys_only_blocks_it() {
    let mut f = fx();
    f.set("ai.keysOnly", json!("true"));
    f.login_says(json!({ "signedIn": true }));
    let s = f.status("chatgpt").await;
    assert_eq!(s.state, ProviderState::BlockedKeysOnly);
    assert!(f.asked.lock().is_empty(), "the sign-in is not even looked at");
}

// --- Local AI ---

#[tokio::test]
async fn no_address_is_needs_setup_an_address_that_isnt_plain_http_s_is_needs_setup_too() {
    let f = fx();
    let s = f.status("local").await;
    assert_eq!(s.state, ProviderState::NeedsSetup);
    assert!(s.fix.as_deref().unwrap().contains("TARSEE_LOCAL_AI_URL"));
    f.set("ai.local.baseUrl", json!("ftp://192.168.1.20/v1"));
    assert_eq!(f.status("local").await.state, ProviderState::NeedsSetup);
    f.set("ai.local.baseUrl", json!("http://user:pass@192.168.1.20/v1"));
    let s = f.status("local").await;
    assert_eq!(s.state, ProviderState::NeedsSetup);
    assert_eq!(
        s.detail,
        "Local AI's address must start with http:// or https:// and have no password in it."
    );
}

#[tokio::test]
async fn an_address_without_a_chosen_model_is_needs_setup_with_one_it_is_ready_with_no_key_needed() {
    let f = fx();
    f.set("ai.local.baseUrl", json!("http://192.168.1.20:11434/v1"));
    let s = f.status("local").await;
    assert_eq!(s.state, ProviderState::NeedsSetup);
    assert!(s.detail.to_lowercase().contains("model"));
    f.set("ai.local.model", json!("qwen3:8b"));
    let s = f.status("local").await;
    assert_eq!(s.state, ProviderState::Ready, "{}", s.detail);
    assert!(s.detail.contains("192.168.1.20"));
    assert_eq!(s.detail, "Using your Local AI at http://192.168.1.20:11434/v1.");
    assert_eq!(s.key_source, None);
}

#[tokio::test]
async fn tarsee_local_ai_url_and_tarsee_ai_model_set_it_up_from_railway_alone() {
    let f = fx();
    f.env
        .set("TARSEE_LOCAL_AI_URL", "http://ollama.railway.internal:11434/v1");
    f.env.set("TARSEE_AI_PROVIDER", "local");
    f.env.set("TARSEE_AI_MODEL", "llama3.3");
    let s = f.status("local").await;
    assert_eq!(s.state, ProviderState::Ready, "{}", s.detail);
}

#[tokio::test]
async fn another_providers_key_in_the_local_ai_slot_is_an_error_it_would_go_to_a_host_the_owner_typed() {
    let f = fx();
    f.set("ai.local.baseUrl", json!("http://192.168.1.20:11434/v1"));
    f.set("ai.local.model", json!("qwen3:8b"));
    f.set("ai.local.apiKey", json!(key("openrouter")));
    let s = f.status("local").await;
    assert_eq!(s.state, ProviderState::Error);
    assert_no_key(&s, &key("openrouter"));
}

// --- credentialPresence (synchronous, for the security audit) ---

#[test]
fn answers_without_the_network_or_codex_key_presence_the_claude_sign_in_file_the_chatgpt_auth_json() {
    let f = fx();
    let presence = |id: &str, deps: &StatusDeps<'_>| credential_presence(&f.t, id, deps).state;
    assert_eq!(presence("deepseek", &f.deps()), ProviderState::NeedsKey);
    f.set("ai.deepseek.apiKey", json!(key("deepseek")));
    assert_eq!(presence("deepseek", &f.deps()), ProviderState::Ready);
    assert_eq!(presence("claude", &f.deps()), ProviderState::NeedsSignIn);
    let codex_home = f.t.path().join("codex-home-x");
    std::fs::create_dir_all(&codex_home).unwrap();
    let there = StatusDeps {
        codex_home: Some(&codex_home),
        ..f.deps()
    };
    assert_eq!(presence("chatgpt", &there), ProviderState::NeedsSignIn);
    std::fs::write(codex_home.join("auth.json"), "{}").unwrap();
    assert_eq!(presence("chatgpt", &there), ProviderState::Ready);
    assert!(f.asked.lock().is_empty(), "the sign-in check is never run");
}

// --- activeTarget and the boot line ---

fn all_shipped(_: &str) -> bool {
    true
}

#[tokio::test]
async fn names_the_default_provider_model_engine_where_its_key_came_from_last_4_only_and_its_state() {
    let f = fx();
    f.set("ai.activeProvider", json!("deepseek"));
    f.t.env().set("DEEPSEEK_API_KEY", key("deepseek"));
    let deps = StatusDeps {
        is_shipped: Some(&all_shipped),
        ..f.deps()
    };
    let line = ai_boot_line(&f.t, &deps).await;
    assert_eq!(
        line,
        format!(
            "[ai] default=deepseek:deepseek-flash engine=claude-code key=env:DEEPSEEK_API_KEY ({}) ready",
            last4(&key("deepseek"))
        )
    );
    assert_no_key(&line, &key("deepseek"));
}

#[test]
fn tarsee_ai_provider_and_tarsee_ai_model_pick_the_default_when_settings_has_none() {
    let f = fx();
    let env = Env::from_pairs([
        ("TARSEE_AI_PROVIDER", "deepseek"),
        ("TARSEE_AI_MODEL", "deepseek-v4-pro"),
    ]);
    let t = active_target(&f.t, Some(&f.store), Some(&env), Some(&all_shipped));
    assert_eq!(
        serde_json::to_value(&t).unwrap(),
        json!({ "provider": "deepseek", "label": "DeepSeek", "model": "deepseek-v4-pro", "engine": "claude-code", "chosenBy": "env" })
    );
}

#[tokio::test]
async fn nothing_chosen_is_the_claude_plan_not_signed_in_says_so_and_what_to_do() {
    let f = fx();
    let line = ai_boot_line(&f.t, &f.deps()).await;
    let rest = line
        .strip_prefix("[ai] default=claude:")
        .unwrap_or_else(|| panic!("{line}"));
    let (model, rest) = rest.split_once(' ').unwrap();
    assert!(!model.is_empty());
    assert!(
        rest.starts_with("engine=claude-code key=none needs-sign-in: Nobody has signed in"),
        "{line}"
    );
    assert!(line.contains("claude auth login"));
}

#[tokio::test]
async fn an_anthropic_api_key_left_in_the_environment_while_the_claude_plan_is_the_default_is_called_out_as_unused() {
    let mut f = fx();
    f.env.set("ANTHROPIC_API_KEY", key("anthropic"));
    f.homes(vec![f.signed_in_home.clone()]);
    let line = ai_boot_line(&f.t, &f.deps()).await;
    assert!(line.contains(" ready"), "{line}");
    assert!(line.contains("ANTHROPIC_API_KEY is set but not used"));
    assert!(line.ends_with(
        " key=sign-in ready (ANTHROPIC_API_KEY is set but not used: the default AI is the Claude plan. To bill that key instead, choose \"Anthropic API key\" in Settings > AI.)"
    ), "{line}");
    assert_no_key(&line, &key("anthropic"));
}

// --- What the JS suite left out ---

#[tokio::test]
async fn a_status_is_the_node_object_key_for_key() {
    let f = fx();
    f.set("ai.openrouter.apiKey", json!(key("openrouter")));
    let hint = last4(&key("openrouter"));
    let s = f.status("openrouter").await;
    assert_eq!(
        serde_json::to_string(&s).unwrap(),
        format!(
            r#"{{"id":"openrouter","label":"OpenRouter","kind":"key","state":"ready","ready":true,"detail":"Key saved in Tarsee ({hint}).","fix":null,"keySource":"settings","keyHint":"{hint}","keySourceText":"Saved in Tarsee (encrypted)","account":null,"balance":null}}"#
        )
    );
    let none = f.status("deepseek").await;
    assert_eq!(
        serde_json::to_value(&none).unwrap(),
        json!({
            "id": "deepseek", "label": "DeepSeek", "kind": "key", "state": "needs-key", "ready": false,
            "detail": "DeepSeek needs a DeepSeek key.",
            "fix": "Paste a DeepSeek key in Settings > AI, or set the Railway variable DEEPSEEK_API_KEY. Get one at platform.deepseek.com/api_keys.",
            "keySource": null, "keyHint": null, "keySourceText": null, "account": null, "balance": null,
        })
    );
    let plan = f.status("claude").await;
    assert_eq!(serde_json::to_value(&plan).unwrap()["kind"], "subscription");
    assert_eq!(serde_json::to_value(f.status("local").await).unwrap()["kind"], "local");
}

#[tokio::test]
async fn a_keys_railway_variable_is_read_from_the_servers_environment_whatever_env_the_caller_gives() {
    let f = fx();
    // In the caller's env only: not a key (the JS store read process.env).
    f.env.set("OPENAI_API_KEY", key("openai"));
    assert_eq!(f.status("openai").await.state, ProviderState::NeedsKey);
    // In the server's: the key.
    f.t.env().set("OPENAI_API_KEY", key("openai"));
    assert_eq!(f.status("openai").await.state, ProviderState::Ready);
    // No store at all: no key from anywhere, as in the JS (the lookup is the store's).
    let no_store = StatusDeps {
        store: None,
        ..f.deps()
    };
    let s = provider_status(&f.t, "openai", &no_store).await;
    assert_eq!(s.state, ProviderState::NeedsKey);
    // With nothing given at all, everything is the app's own.
    let own = provider_status(&f.t, "openai", &StatusDeps::default()).await;
    assert_eq!(own.state, ProviderState::NeedsKey);
}

#[tokio::test]
async fn whether_a_saved_key_is_encrypted_is_read_off_its_stored_row() {
    let f = fx();
    let slot = "ai.openai.apiKey";
    f.set(slot, json!(key("openai")));
    let insert = |value: &str| {
        f.t.db()
            .with(|c| {
                c.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    [slot, value],
                )
            })
            .unwrap();
    };
    // Stored in the clear (saved before ENCRYPTION_KEY was set).
    insert(&key("openai"));
    let s = f.status("openai").await;
    assert_eq!(
        s.key_source_text.as_deref(),
        Some("Saved in Tarsee (not encrypted: set ENCRYPTION_KEY)")
    );
    // Stored encrypted.
    insert(&crate::lib::vault::encrypt(&f.t, &key("openai")));
    let s = f.status("openai").await;
    assert_eq!(s.key_source_text.as_deref(), Some("Saved in Tarsee (encrypted)"));
    // No row and no ENCRYPTION_KEY: not encrypted.
    let plain = crate::testkit::test_app();
    let store = MemorySettings::from_pairs([(slot, json!(key("openai")))]);
    let deps = StatusDeps {
        store: Some(&store),
        ..StatusDeps::default()
    };
    let s = provider_status(&plain, "openai", &deps).await;
    assert_eq!(
        s.key_source_text.as_deref(),
        Some("Saved in Tarsee (not encrypted: set ENCRYPTION_KEY)")
    );
}

#[test]
fn the_saved_keys_are_found_by_their_rows_or_by_what_the_store_holds_and_never_a_plans() {
    let f = fx();
    assert!(saved_key_providers(&f.t, Some(&f.store)).is_empty());
    assert!(saved_key_providers(&f.t, None).is_empty());
    f.set("ai.deepseek.apiKey", json!(key("deepseek")));
    f.set("ai.openai.apiKey", json!("   "));
    f.set("ai.local.apiKey", json!(12_345_678));
    f.set("ai.claude-code.apiKey", json!("subscription"));
    f.set("ai.chatgpt.apiKey", json!("x"));
    assert_eq!(saved_key_providers(&f.t, Some(&f.store)), ["deepseek", "local"]);
    // A row in the database counts by itself, blank or not as it is stored.
    let insert = |slot: &str, value: &str| {
        f.t.db()
            .with(|c| {
                c.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    [slot, value],
                )
            })
            .unwrap();
    };
    insert("ai.anthropic.apiKey", "enc:v1:abc");
    insert("ai.deepseek.apiKey", "  ");
    assert_eq!(saved_key_providers(&f.t, Some(&f.store)), ["anthropic", "local"]);
    assert_eq!(saved_key_providers(&f.t, None), ["anthropic"]);
}

#[test]
fn a_failure_flag_is_read_in_any_form_it_was_stored_in_and_the_newest_of_the_plans_two_wins() {
    let f = fx();
    let store: Option<&dyn Settings> = Some(&f.store);
    assert_eq!(failure_flag(store, "deepseek"), None);
    assert_eq!(failure_flag(None, "deepseek"), None);
    assert_eq!(failure_flag(store, "gemini"), None);
    // An object, JSON text of one, or a bare word.
    f.set(
        "ai.deepseek.status",
        json!({ "state": "auth", "at": "2026-11-01T00:00:00.000Z", "detail": "d" }),
    );
    let flag = failure_flag(store, "deepseek").unwrap();
    assert_eq!(
        serde_json::to_value(&flag).unwrap(),
        json!({ "state": "auth", "at": "2026-11-01T00:00:00.000Z", "detail": "d" })
    );
    f.set("ai.deepseek.status", json!("{\"state\":\"billing\"}"));
    assert_eq!(failure_flag(store, "deepseek").unwrap().state, "billing");
    f.set("ai.deepseek.status", json!("auth"));
    assert_eq!(failure_flag(store, "deepseek").unwrap().state, "auth");
    // Not a flag: no state, a state that is not text, a list, a number, text that is JSON but no object.
    for not in [
        json!({}),
        json!({ "state": 5 }),
        json!(["auth"]),
        json!(7),
        json!("\"auth\""),
        json!("5"),
        json!(null),
    ] {
        f.set("ai.deepseek.status", not.clone());
        assert_eq!(failure_flag(store, "deepseek"), None, "{not}");
    }
    // The Claude plan's flag may be under its public id or its storage id: the newer one counts.
    f.set(
        "ai.claude.status",
        json!({ "state": "auth", "at": "2026-11-01T00:00:00.000Z" }),
    );
    f.set(
        "ai.claude-code.status",
        json!({ "state": "billing", "at": "2026-11-02T00:00:00.000Z" }),
    );
    assert_eq!(failure_flag(store, "claude").unwrap().state, "billing");
    assert_eq!(failure_flag(store, "claude-code").unwrap().state, "billing");
    f.set(
        "ai.claude.status",
        json!({ "state": "auth", "at": "2026-11-03T00:00:00.000Z" }),
    );
    assert_eq!(failure_flag(store, "claude").unwrap().state, "auth");
    // With no time on either, the first one found stays.
    f.set("ai.claude.status", json!({ "state": "one" }));
    f.set("ai.claude-code.status", json!({ "state": "two" }));
    assert_eq!(failure_flag(store, "claude").unwrap().state, "one");
    // Clearing takes both away; setting writes the public id's, with the moment.
    clear_failure_flag(store, "claude-code");
    assert_eq!(failure_flag(store, "claude"), None);
    clear_failure_flag(None, "claude");
    clear_failure_flag(store, "gemini");
    set_failure_flag(&f.store, "claude-code", "auth", Some("why")).unwrap();
    let written = f.store.get("ai.claude.status").unwrap();
    assert_eq!(written["state"], "auth");
    assert_eq!(written["detail"], "why");
    assert_eq!(written["at"].as_str().unwrap().len(), 24);
    assert_eq!(
        written.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["state", "at", "detail"]
    );
    set_failure_flag(&f.store, "deepseek", "out-of-credit", None).unwrap();
    assert_eq!(f.store.get("ai.deepseek.status").unwrap()["detail"], json!(null));
    set_failure_flag(&f.store, "gemini", "auth", None).unwrap();
    assert_eq!(f.store.get("ai.gemini.status"), None);
}

#[tokio::test]
async fn a_flag_becomes_a_state_by_the_providers_kind_and_its_own_words() {
    let mut f = fx();
    f.homes(vec![f.signed_in_home.clone()]);
    f.t.env().set("OPENAI_API_KEY", key("openai"));
    f.set("ai.local.baseUrl", json!("http://localhost:11434/v1"));
    f.set("ai.local.model", json!("m"));
    // A plan that ran out: the provider's place to add credit is unknown, so "with the provider".
    f.set("ai.claude.status", json!({ "state": "BILLING" }));
    let s = f.status("claude").await;
    assert_eq!(s.state, ProviderState::OutOfCredit);
    assert_eq!(s.detail, "Claude plan has run out of credit.");
    assert_eq!(s.fix.as_deref(), Some("Add credit with the provider, then press Test."));
    // A key provider: its own words and its own top-up page.
    f.set("ai.openai.status", json!({ "state": "expired" }));
    let s = f.status("openai").await;
    assert_eq!(s.state, ProviderState::Error);
    assert_eq!(
        s.detail,
        "Your OpenAI key was rejected. Update it in Settings > AI or the Railway variable OPENAI_API_KEY."
    );
    assert_eq!(
        s.fix.as_deref(),
        Some("Replace the key in Settings > AI (or its Railway variable), then press Test.")
    );
    f.set("ai.openai.status", json!({ "state": "billing" }));
    let s = f.status("openai").await;
    assert_eq!(
        s.fix.as_deref(),
        Some("Add credit at platform.openai.com/settings/organization/billing/overview, then press Test.")
    );
    // Local AI has no billing words of its own; an error flag without a detail names the provider.
    f.set("ai.local.status", json!({ "state": "out-of-credit" }));
    let s = f.status("local").await;
    assert_eq!(s.detail, "Local AI has run out of credit.");
    f.set("ai.local.status", json!({ "state": "error", "detail": "   " }));
    let s = f.status("local").await;
    assert_eq!(s.detail, "Local AI reported an error on its last turn.");
    assert_eq!(s.fix.as_deref(), Some("Press Test in Settings > AI to check it again."));
    // What stays of the ready answer under a flag: where the key came from.
    assert_eq!(s.state, ProviderState::Error);
    assert!(!s.ready);
    f.set("ai.openai.status", json!({ "state": "auth" }));
    let s = f.status("openai").await;
    assert_eq!(s.key_source.as_deref(), Some("env:OPENAI_API_KEY"));
    assert_eq!(s.key_hint, Some(last4(&key("openai"))));
}

#[test]
fn a_balance_is_kept_ten_minutes_for_the_key_it_was_read_with() {
    let f = fx();
    let store: Option<&dyn Settings> = Some(&f.store);
    let now = 1_794_472_200_000_i64;
    assert_eq!(cached_balance(store, "deepseek", now, None), None);
    save_balance(
        &f.store,
        "deepseek",
        &json!({ "text": "t", "at": 1, "empty": false }),
        now,
        Some("…abcd"),
    )
    .unwrap();
    // Saved under the public id, with the moment and the hint; a moment the balance brought is replaced in place.
    assert_eq!(
        serde_json::to_string(&f.store.get("cache.deepseek.balance").unwrap()).unwrap(),
        format!(r#"{{"text":"t","at":{now},"empty":false,"keyHint":"…abcd"}}"#)
    );
    let fresh = |now: i64, hint: Option<Option<&str>>| cached_balance(store, "deepseek", now, hint).is_some();
    assert!(fresh(now, None));
    assert!(fresh(now, Some(Some("…abcd"))));
    assert!(!fresh(now, Some(Some("…zzzz"))));
    assert!(
        !fresh(now, Some(None)),
        "a hint was saved: it is not the no-hint balance"
    );
    // Exactly ten minutes either side is still in; a millisecond more is not.
    assert!(fresh(now + BALANCE_TTL_MS, None) && fresh(now - BALANCE_TTL_MS, None));
    assert!(!fresh(now + BALANCE_TTL_MS + 1, None) && !fresh(now - BALANCE_TTL_MS - 1, None));
    // Saved with no hint: only the no-hint question (or any) takes it.
    save_balance(&f.store, "deepseek", &json!({ "text": "t" }), now, None).unwrap();
    assert!(fresh(now, Some(None)) && fresh(now, None) && !fresh(now, Some(Some("…abcd"))));
    // Stored as text; a moment that is text; and what is no balance at all.
    f.set(
        "cache.deepseek.balance",
        json!(format!("{{\"at\":\"{now}\",\"text\":\"x\"}}")),
    );
    assert_eq!(cached_balance(store, "deepseek", now, None).unwrap()["text"], "x");
    for not in [
        json!("{ torn"),
        json!("5"),
        json!(7),
        json!({ "text": "no moment" }),
        json!({ "at": "soon" }),
        json!({ "at": null }),
        json!([1]),
    ] {
        f.set("cache.deepseek.balance", not.clone());
        assert_eq!(cached_balance(store, "deepseek", now, None), None, "{not}");
    }
    // Nothing to save, nobody to save it for; clearing forgets it.
    save_balance(&f.store, "deepseek", &json!(null), now, None).unwrap();
    save_balance(&f.store, "gemini", &json!({ "text": "t" }), now, None).unwrap();
    assert_eq!(f.store.get("cache.gemini.balance"), None);
    save_balance(&f.store, "deepseek", &json!({ "text": "t" }), now, None).unwrap();
    clear_balance(store, "deepseek");
    assert_eq!(f.store.get("cache.deepseek.balance"), None);
    clear_balance(None, "deepseek");
    clear_balance(store, "gemini");
    assert_eq!(BALANCE_PROVIDERS, ["openrouter", "deepseek"]);
}

#[tokio::test]
async fn a_cached_balance_is_shown_only_on_the_two_providers_tarsee_reads_one_for() {
    let f = fx();
    f.t.env().set("OPENAI_API_KEY", key("openai"));
    f.t.env().set("DEEPSEEK_API_KEY", key("deepseek"));
    let now = js::now_ms();
    let hint = last4(&key("deepseek"));
    save_balance(
        &f.store,
        "openai",
        &json!({ "text": "x", "empty": true }),
        now,
        Some(&last4(&key("openai"))),
    )
    .unwrap();
    assert_eq!(f.status("openai").await.balance, None);
    // DeepSeek's empty balance: its own words; a balance whose words end in a full stop keeps one.
    save_balance(
        &f.store,
        "deepseek",
        &json!({ "text": "Balance $0.00", "empty": true }),
        now,
        Some(&hint),
    )
    .unwrap();
    let s = f.status("deepseek").await;
    assert_eq!(s.state, ProviderState::OutOfCredit);
    assert_eq!(s.detail, "Your DeepSeek balance is empty.");
    assert_eq!(
        s.fix.as_deref(),
        Some("Your DeepSeek balance is empty. Top up at platform.deepseek.com.")
    );
    save_balance(
        &f.store,
        "deepseek",
        &json!({ "text": "Balance $5.00." }),
        now,
        Some(&hint),
    )
    .unwrap();
    let s = f.status("deepseek").await;
    assert!(s.detail.ends_with(" Balance $5.00."), "{}", s.detail);
    assert!(!s.detail.ends_with(".."));
    // A flag comes before the balance.
    f.set("ai.deepseek.status", json!({ "state": "auth" }));
    let s = f.status("deepseek").await;
    assert_eq!((s.state, s.balance), (ProviderState::Error, None));
}

#[test]
fn a_sign_in_checks_answer_is_read_leniently_and_only_a_chatgpt_sign_in_counts() {
    let login = |answer: Value| normalize_login(&answer);
    let signed_in = |answer: Value| login(answer).signed_in;
    assert_eq!(login(json!(null)), Login::default());
    assert_eq!(login(json!("yes")), Login::default());
    assert_eq!(login(json!({})), Login::default());
    for yes in [
        json!({ "signedIn": true }),
        json!({ "loggedIn": true }),
        json!({ "ok": 1 }),
        json!({ "ready": "yes" }),
        json!({ "signedIn": true, "method": "ChatGPT" }),
        json!({ "signedIn": true, "method": null, "authMode": "chatgpt" }),
        json!({ "signedIn": true, "method": "" }),
        json!({ "signedIn": null, "loggedIn": true }),
    ] {
        assert!(signed_in(yes.clone()), "{yes}");
    }
    for no in [
        json!({ "signedIn": false, "loggedIn": true }),
        json!({ "signedIn": 0, "ok": true }),
        json!({ "signedIn": "" }),
        json!({ "signedIn": true, "method": "api" }),
        json!({ "signedIn": true, "auth_mode": "API_KEY" }),
        json!({ "signedIn": true, "mode": "token" }),
        json!({ "signedIn": true, "method": 7 }),
    ] {
        assert!(!signed_in(no.clone()), "{no}");
    }
    assert_eq!(login(json!({ "method": "apikey" })).other_login, Some("api"));
    assert_eq!(login(json!({ "method": "cloud" })).other_login, Some("other"));
    assert_eq!(login(json!({ "method": "chatgpt" })).other_login, None);
    // Expired: said outright, or as a state.
    assert!(login(json!({ "expired": true })).expired);
    assert!(!login(json!({ "expired": "true" })).expired);
    assert!(login(json!({ "state": "Sign-In-Expired" })).expired);
    assert!(login(json!({ "state": "expired" })).expired);
    assert!(!login(json!({ "state": "ready" })).expired);
    // The email and plan, wherever they are; text only, trimmed.
    let l = login(json!({ "email": " a@b ", "planType": "plus" }));
    assert_eq!((l.email.as_deref(), l.plan.as_deref()), (Some("a@b"), Some("plus")));
    let l = login(json!({ "account": { "email": "c@d", "plan": "pro" } }));
    assert_eq!((l.email.as_deref(), l.plan.as_deref()), (Some("c@d"), Some("pro")));
    let l = login(json!({ "email": null, "account": { "email": "c@d" }, "plan": null, "plan_type": "team" }));
    assert_eq!((l.email.as_deref(), l.plan.as_deref()), (Some("c@d"), Some("team")));
    let l = login(json!({ "email": 5, "account": { "email": "c@d" }, "plan": "  " }));
    assert_eq!((l.email, l.plan), (None, None));
    // How the account reads on the card.
    let account = |email: Option<&str>, plan: Option<&str>| {
        plan_account(&Login {
            email: email.map(String::from),
            plan: plan.map(String::from),
            ..Login::default()
        })
    };
    assert_eq!(account(None, None), None);
    assert_eq!(account(Some("a@b"), Some("free")).as_deref(), Some("a@b (Free)"));
    assert_eq!(account(Some("a@b"), None).as_deref(), Some("a@b"));
    assert_eq!(account(None, Some("plus")).as_deref(), Some("Plus plan"));
    assert_eq!(account(None, Some("ßeta")).as_deref(), Some("SSeta plan"));
    assert_eq!(account(None, Some("🐒x")).as_deref(), Some("🐒x plan"));
}

#[tokio::test]
async fn with_no_check_given_codexs_own_sign_in_file_is_read() {
    let f = fx();
    let home = f.t.path().join(".codex-home");
    std::fs::create_dir_all(&home).unwrap();
    let own = StatusDeps {
        login_status: None,
        ..f.deps()
    };
    // Nothing there yet.
    let s = provider_status(&f.t, "chatgpt", &own).await;
    assert_eq!(s.state, ProviderState::NeedsSignIn);
    assert_eq!(s.detail, "Nobody has signed in to ChatGPT yet.");
    // An API-key login in the ChatGPT home.
    let api_key = format!("sk-{}", "test-canary-0000000000000000abcd");
    std::fs::write(
        home.join("auth.json"),
        json!({ "auth_mode": "apikey", "OPENAI_API_KEY": api_key }).to_string(),
    )
    .unwrap();
    let s = provider_status(&f.t, "chatgpt", &own).await;
    assert_eq!(
        s.detail,
        "The ChatGPT sign-in folder holds an API-key login, not a ChatGPT sign-in."
    );
    assert_no_key(&s, &api_key);
    // A ChatGPT sign-in (no codex is started: the cards read the file).
    std::fs::write(
        home.join("auth.json"),
        json!({ "auth_mode": "chatgpt", "tokens": { "access_token": "at-test", "refresh_token": "rt-test" } })
            .to_string(),
    )
    .unwrap();
    let s = provider_status(&f.t, "chatgpt", &own).await;
    assert_eq!(s.state, ProviderState::Ready);
    assert_eq!(s.detail, "Signed in to ChatGPT.");
    assert_eq!(s.key_source.as_deref(), Some("sign-in"));
}

#[test]
fn the_claude_sign_in_is_looked_for_in_the_variables_then_the_homes() {
    let f = fx();
    let none = SignInOpts::default();
    // The app's own homes, its home folder's .claude first.
    let own = f.t.path().join("home").join(".claude");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(own.join(".credentials.json"), "{}").unwrap();
    let found = claude_sign_in(&f.t, &none);
    assert_eq!(
        serde_json::to_value(&found).unwrap(),
        json!({ "signedIn": true, "source": "sign-in", "hint": null, "home": own })
    );
    // CLAUDE_CODE_HOME names the one home to look in.
    let env = Env::from_pairs([("CLAUDE_CODE_HOME", f.empty_home.to_string_lossy().to_string())]);
    let in_env = SignInOpts {
        env: Some(&env),
        ..SignInOpts::default()
    };
    assert_eq!(
        serde_json::to_value(claude_sign_in(&f.t, &in_env)).unwrap(),
        json!({ "signedIn": false, "source": null, "hint": null })
    );
    env.set("CLAUDE_CODE_HOME", f.signed_in_home.to_string_lossy().to_string());
    assert_eq!(claude_sign_in(&f.t, &in_env).home.as_ref(), Some(&f.signed_in_home));
    // A sign-in variable wins over any file; the token first, then the refresh token; a blank one is none. The two
    // other sign-in variables are not sign-ins by themselves.
    env.set("CLAUDE_CODE_OAUTH_SCOPES", "user:inference");
    env.set("CLAUDE_CODE_OAUTH_CLIENT_ID", "client");
    assert_eq!(claude_sign_in(&f.t, &in_env).source.as_deref(), Some("sign-in"));
    env.set("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", " refresh-test-canary ");
    let found = claude_sign_in(&f.t, &in_env);
    assert_eq!(found.source.as_deref(), Some("env:CLAUDE_CODE_OAUTH_REFRESH_TOKEN"));
    assert_eq!(found.hint.as_deref(), Some("…nary"));
    env.set("CLAUDE_CODE_OAUTH_TOKEN", "   ");
    assert_eq!(
        claude_sign_in(&f.t, &in_env).source.as_deref(),
        Some("env:CLAUDE_CODE_OAUTH_REFRESH_TOKEN")
    );
    env.set("CLAUDE_CODE_OAUTH_TOKEN", "short");
    let found = claude_sign_in(&f.t, &in_env);
    assert_eq!(found.source.as_deref(), Some("env:CLAUDE_CODE_OAUTH_TOKEN"));
    assert_eq!(found.hint.as_deref(), Some("…"));
    // The seams: the homes and the file check a caller gives are the ones used.
    let homes = || vec![PathBuf::new(), PathBuf::from("/nowhere/a"), PathBuf::from("/nowhere/b")];
    let seen = parking_lot::Mutex::new(Vec::new());
    let exists = |path: &Path| {
        seen.lock().push(path.to_path_buf());
        path.starts_with("/nowhere/b")
    };
    let seams = SignInOpts {
        env: Some(&f.env),
        claude_homes: Some(&homes),
        exists: Some(&exists),
    };
    assert_eq!(claude_sign_in(&f.t, &seams).home, Some(PathBuf::from("/nowhere/b")));
    assert_eq!(
        *seen.lock(),
        [
            PathBuf::from("/nowhere/a").join(".credentials.json"),
            PathBuf::from("/nowhere/b").join(".credentials.json")
        ]
    );
}

#[test]
fn the_small_readers_answer_as_the_node_ones() {
    let store = MemorySettings::new();
    let s: Option<&dyn Settings> = Some(&store);
    let env = Env::new();
    // hintOf
    assert_eq!(hint_of(""), None);
    assert_eq!(hint_of("1234567").as_deref(), Some("…"));
    assert_eq!(hint_of("12345678").as_deref(), Some("…5678"));
    // plainHttpUrl
    for yes in [
        "http://localhost:11434/v1",
        " https://example.test ",
        "HTTP://EXAMPLE.TEST",
        "http://[::1]:8080",
    ] {
        assert!(plain_http_url(yes).is_some(), "{yes}");
    }
    for no in [
        "ftp://example.test",
        "http://user@example.test",
        "http://user:pw@example.test",
        "localhost:11434",
        "",
        "//example.test",
    ] {
        assert!(plain_http_url(no).is_none(), "{no}");
    }
    assert_eq!(
        plain_http_url("http://example.test/a b").unwrap().as_str(),
        "http://example.test/a%20b"
    );
    // localUrlFor: the setting, then the variable, then nothing.
    assert_eq!(local_url_for(s, &env), "");
    assert_eq!(local_url_for(None, &env), "");
    env.set("TARSEE_LOCAL_AI_URL", " http://env.test/v1 ");
    assert_eq!(local_url_for(s, &env), "http://env.test/v1");
    store.set("ai.local.baseUrl", json!("   ")).unwrap();
    assert_eq!(local_url_for(s, &env), "http://env.test/v1");
    store.set("ai.local.baseUrl", json!(" http://set.test/v1 ")).unwrap();
    assert_eq!(local_url_for(s, &env), "http://set.test/v1");
    store.set("ai.local.baseUrl", json!(5)).unwrap();
    assert_eq!(local_url_for(s, &env), "http://env.test/v1");
    // chosenModel: the provider's own setting (under its storage id), else the Railway pair when it names it.
    assert_eq!(chosen_model("deepseek", s, &env), None);
    assert_eq!(chosen_model("gemini", s, &env), None);
    env.set("TARSEE_AI_MODEL", " env-model ");
    assert_eq!(chosen_model("deepseek", s, &env), None, "no provider named");
    env.set("TARSEE_AI_PROVIDER", " DeepSeek ");
    assert_eq!(chosen_model("deepseek", s, &env).as_deref(), Some("env-model"));
    assert_eq!(chosen_model("openai", s, &env), None, "the pair names another provider");
    env.set("TARSEE_AI_PROVIDER", "claude-code");
    assert_eq!(chosen_model("claude", s, &env).as_deref(), Some("env-model"));
    store.set("ai.claude-code.model", json!(" opus ")).unwrap();
    assert_eq!(chosen_model("claude", s, &env).as_deref(), Some("opus"));
    assert_eq!(chosen_model("claude-code", s, &env).as_deref(), Some("opus"));
    assert_eq!(chosen_model("claude", None, &env).as_deref(), Some("env-model"));
    // codexHomeFor
    assert_eq!(
        codex_home_for(Path::new("/data/tarsee")),
        PathBuf::from("/data/tarsee").join(".codex-home")
    );
    // keySourceText
    assert_eq!(key_source_text(None, true, None), None);
    assert_eq!(key_source_text(Some(""), true, None), None);
    assert_eq!(
        key_source_text(Some("settings"), true, None).as_deref(),
        Some("Saved in Tarsee (encrypted)")
    );
    assert_eq!(
        key_source_text(Some("settings"), false, None).as_deref(),
        Some("Saved in Tarsee (not encrypted: set ENCRYPTION_KEY)")
    );
    assert_eq!(
        key_source_text(Some("env:X_KEY"), true, None).as_deref(),
        Some("Railway variable X_KEY")
    );
    assert_eq!(
        key_source_text(Some("sign-in"), true, Some("chatgpt")).as_deref(),
        Some("Signed in with ChatGPT")
    );
    assert_eq!(
        key_source_text(Some("sign-in"), true, Some("claude")).as_deref(),
        Some("Signed in with claude auth login")
    );
    assert_eq!(
        key_source_text(Some("elsewhere"), true, None).as_deref(),
        Some("elsewhere")
    );
}

#[tokio::test]
async fn the_default_target_follows_settings_then_the_environment_and_the_boot_line_says_what_is_missing() {
    let f = fx();
    let target = |env: &Env| active_target(&f.t, Some(&f.store), Some(env), None);
    // Nothing chosen.
    let t = target(&f.env);
    assert_eq!(
        (t.provider, t.label, t.chosen_by),
        ("claude", "Claude plan", ChosenBy::Default)
    );
    assert_eq!(t.engine, Some(Engine::ClaudeCode));
    // The environment, with the app's own environment when none is given.
    f.t.env().set("TARSEE_AI_PROVIDER", "openai");
    let t = active_target(&f.t, Some(&f.store), None, None);
    assert_eq!(
        (t.provider, t.chosen_by, t.engine),
        ("openai", ChosenBy::Env, Some(Engine::Codex))
    );
    // Settings wins, and says so even when what it names is not offered here.
    f.set("ai.activeProvider", json!("chatgpt"));
    let t = target(&f.env);
    assert_eq!((t.provider, t.chosen_by), ("chatgpt", ChosenBy::Settings));
    assert_eq!(t.model, None, "the ChatGPT plan before its account list is in");
    ProviderRegistry::of(&f.t).hide_providers(&["chatgpt"]);
    let t = target(&f.env);
    assert_eq!((t.provider, t.chosen_by), ("claude", ChosenBy::Settings));
    ProviderRegistry::of(&f.t).hide_providers(&[]);
    // The boot line: no model named is "auto"; a model that must be verified first has no engine yet.
    let line = ai_boot_line(&f.t, &f.deps()).await;
    assert!(
        line.starts_with("[ai] default=chatgpt:auto engine=codex key=none needs-sign-in: Nobody has signed in to ChatGPT yet. Sign in with ChatGPT in Settings > AI"),
        "{line}"
    );
    f.set("ai.activeProvider", json!("openrouter"));
    f.set("ai.openrouter.model", json!("mistralai/mistral-large"));
    f.set("ai.openrouter.apiKey", json!(key("openrouter")));
    let line = ai_boot_line(&f.t, &f.deps()).await;
    assert_eq!(
        line,
        format!(
            "[ai] default=openrouter:mistralai/mistral-large engine=needs-verification key=settings ({}) ready",
            last4(&key("openrouter"))
        )
    );
    // An Anthropic key in the environment is only remarked on when the Claude plan is the default.
    f.env.set("ANTHROPIC_API_KEY", key("anthropic"));
    let line = ai_boot_line(&f.t, &f.deps()).await;
    assert!(line.ends_with(" ready"), "{line}");
}
