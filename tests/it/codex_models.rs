//! Port of the cases of test/codex-models.test.js that run an app-server: the signed-in ChatGPT account's own model
//! list (`ai/codex_models.rs`; design amendment A2). Tarsee never hard-codes a ChatGPT model: it asks Codex's
//! app-server (`model/list` over JSON-RPC on stdio) and, when that can't be read as the account's own answer, gives no
//! models, so the caller leaves the model out and Codex picks its default. "The account's own answer" matters: the
//! real program answers model/list with its bundled catalog both when nobody is signed in and when the account's
//! fetch fails (it only logs the failure), and a Free account can't use most of that catalog. A fetch that worked
//! leaves models_cache.json in CODEX_HOME (Codex keys it to the account), so the list counts only when that cache
//! holds every model listed and no fetch failure was logged. The app-server here is the fake codex through the
//! platform shim (`testbin/fake_codex.rs`), answering in the real program's shapes; model-list.bundled.json and
//! refresh-failed.stderr.txt (tests/fixtures/codex-login) are what the real program sent when its fetch failed.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tarsee::ai::codex_models::{
    AccountModelsOpts, ModelsReason, clear_account_models_cache, list_account_models, read_account_models,
    sync_chatgpt_catalog,
};
use tarsee::ai::provider_registry::ProviderRegistry;
use tarsee::testkit::test_app;

use super::codex_device_login::{CANARIES, Scenario, gone_soon, scenario};
use crate::support::testbin;

/// A signed-in-looking home (any auth.json; the fake's account/read decides) and the env picking the fake's answers.
fn models_scenario(vars: &[(&str, &str)], signed_in: bool) -> Scenario {
    let s = scenario(vars);
    std::fs::create_dir_all(&s.home).unwrap();
    if signed_in {
        write_auth(&s.home, "at-test-canary");
    }
    // Fetch failures must be logged whatever the server's own RUST_LOG says.
    if s.env.get("RUST_LOG").is_none() {
        s.env.set("RUST_LOG", "off");
    }
    s
}

fn write_auth(home: &Path, access_token: &str) {
    let body = json!({
        "auth_mode": "chatgpt",
        "tokens": { "id_token": "x.e30.y", "access_token": access_token, "refresh_token": format!("rt-{}", "test-canary") },
    });
    std::fs::write(home.join("auth.json"), body.to_string()).unwrap();
}

fn opts(s: &Scenario) -> AccountModelsOpts {
    AccountModelsOpts {
        codex_home: s.home.clone(),
        env: Some(s.env.clone()),
        codex_bin: Some(s.codex_bin.clone()),
        ..AccountModelsOpts::default()
    }
}

fn live() -> Value {
    json!([
        { "id": "test-free-small", "label": "Test Free Small", "efforts": ["medium", "low", "high"], "default": true, "defaultEffort": "medium", "vision": true, "description": "Test Free Small for tests." },
        { "id": "test-free-mini", "label": "Test Free Mini", "efforts": ["low"], "defaultEffort": "low", "vision": false, "description": "Test Free Mini for tests." },
    ])
}

async fn listed(s: &Scenario, opts: &AccountModelsOpts) -> Value {
    serde_json::to_value(list_account_models(&s.t, opts).await.unwrap()).unwrap()
}

/// The requests the fake app-server was sent, by method.
fn requests(s: &Scenario, method: &str) -> Vec<Value> {
    s.log_lines().into_iter().filter(|l| l["request"] == method).collect()
}

// --- listAccountModels with a fake app-server ---

#[tokio::test]
async fn returns_the_signed_in_accounts_own_list_following_every_page() {
    let s = models_scenario(&[], true);
    assert_eq!(listed(&s, &opts(&s)).await, live());
    let calls = s.calls();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    let argv: Vec<&str> = call["argv"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(argv.contains(&"app-server"));
    assert!(argv.contains(&"cli_auth_credentials_store=\"file\""));
    assert_eq!(
        Path::new(call["CODEX_HOME"].as_str().unwrap()).canonicalize().unwrap(),
        s.home.canonicalize().unwrap(),
        "CODEX_HOME is the sign-in home"
    );
    assert_eq!(
        call["RUST_LOG"], "error",
        "fetch failures are logged whatever the server's RUST_LOG says"
    );
    let names: Vec<String> = call["env"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap().to_uppercase())
        .collect();
    for k in CANARIES {
        assert!(!names.contains(&k.to_string()), "{k} must not reach codex");
    }
    // The conversation, as the app-server heard it: who is asking, then the account, then both pages.
    let init = requests(&s, "initialize");
    assert_eq!(init.len(), 1);
    assert_eq!(init[0]["id"], 1);
    assert_eq!(init[0]["params"]["clientInfo"]["name"], "tarsee");
    assert_eq!(init[0]["params"]["clientInfo"]["title"], "Tarsee");
    assert_eq!(requests(&s, "initialized").len(), 1);
    assert_eq!(
        requests(&s, "account/read")[0]["params"],
        json!({ "refreshToken": false })
    );
    let pages: Vec<Value> = requests(&s, "model/list")
        .into_iter()
        .map(|r| r["params"].clone())
        .collect();
    assert_eq!(
        pages,
        [
            json!({ "limit": 100, "includeHidden": false }),
            json!({ "limit": 100, "includeHidden": false, "cursor": "page-2" })
        ]
    );
}

#[tokio::test]
async fn read_account_models_also_says_where_the_list_came_from_and_whose_it_is() {
    let s = models_scenario(&[("FAKE_CODEX_EMAIL", "someone@example.test")], true);
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        json!({ "models": live(), "source": "account", "account": { "email": "someone@example.test", "plan": "free" } })
    );
}

#[tokio::test]
async fn the_real_binarys_fallback_after_a_failed_fetch_bundled_catalog_and_error_line_is_not_the_accounts_list() {
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "fallback")], true);
    assert_eq!(listed(&s, &opts(&s)).await, json!([]));
    clear_account_models_cache(&s.t);
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(r.reason, Some(ModelsReason::NotLive));
    assert!(r.models.is_empty());
    assert_eq!(s.calls().len(), 2, "a failed answer is asked for again");
}

#[tokio::test]
async fn an_answer_with_no_cache_behind_it_is_not_the_accounts_list_either() {
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "quiet-fallback")], true);
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert!(r.models.is_empty());
    assert_eq!(r.reason, Some(ModelsReason::NotLive));
}

#[tokio::test]
async fn nor_is_one_the_cache_doesnt_cover() {
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "mismatch")], true);
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert!(r.models.is_empty());
    assert_eq!(r.reason, Some(ModelsReason::NotLive));
}

#[tokio::test]
async fn not_signed_in_signed_in_with_an_api_key_or_a_sign_in_that_has_expired_no_models() {
    for (account, reason) in [
        ("none", ModelsReason::NotSignedIn),
        ("apikey", ModelsReason::NotChatgpt),
        ("expired", ModelsReason::SignInExpired),
    ] {
        let s = models_scenario(&[("FAKE_CODEX_ACCOUNT", account)], true);
        let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
        assert!(r.models.is_empty(), "{account}");
        assert_eq!(r.reason, Some(reason), "{account}");
        assert_eq!(r.source, None);
        assert!(
            requests(&s, "model/list").is_empty(),
            "{account}: the list is not even asked for"
        );
    }
}

#[tokio::test]
async fn no_auth_json_no_models_without_starting_codex() {
    let s = models_scenario(&[], false);
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        json!({ "models": [], "source": null, "reason": "not-signed-in" })
    );
    assert_eq!(s.calls().len(), 0);
}

#[tokio::test]
async fn a_stuck_app_server_times_out_to_no_models_and_is_killed() {
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "hang")], true);
    let t0 = Instant::now();
    let r = read_account_models(
        &s.t,
        &AccountModelsOpts {
            timeout: Duration::from_millis(1500),
            ..opts(&s)
        },
    )
    .await
    .unwrap();
    assert!(r.models.is_empty());
    assert_eq!(r.reason, Some(ModelsReason::Timeout));
    assert!(t0.elapsed() < Duration::from_secs(8));
    assert!(gone_soon(s.pid()).await, "the app-server process is gone");
}

#[tokio::test]
async fn a_config_toml_that_could_send_the_sign_in_elsewhere_no_models_without_starting_codex() {
    let s = models_scenario(&[], true);
    std::fs::write(
        s.home.join("config.toml"),
        "chatgpt_base_url = \"https://example.test/\"\n",
    )
    .unwrap();
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert!(r.models.is_empty());
    assert_eq!(r.reason, Some(ModelsReason::UnsafeConfig));
    assert_eq!(s.calls().len(), 0);
}

#[tokio::test]
async fn a_dotenv_in_the_home_codex_loads_it_into_its_own_environment_a_proxy_a_certificate_no_models_without_starting_codex()
 {
    let s = models_scenario(&[], true);
    std::fs::write(s.home.join(".env"), "HTTPS_PROXY=http://127.0.0.1:9\n").unwrap();
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert!(r.models.is_empty());
    assert_eq!(r.reason, Some(ModelsReason::UnsafeConfig));
    assert_eq!(s.calls().len(), 0);
}

#[tokio::test]
async fn no_codex_binary_no_models() {
    let s = models_scenario(&[], true);
    let r = read_account_models(
        &s.t,
        &AccountModelsOpts {
            codex_bin: Some(s.dir.join("no-such-codex")),
            ..opts(&s)
        },
    )
    .await
    .unwrap();
    assert!(r.models.is_empty());
    assert_eq!(r.reason, Some(ModelsReason::CodexMissing));
}

#[tokio::test]
async fn needs_a_home() {
    let s = models_scenario(&[], true);
    let err = list_account_models(&s.t, &AccountModelsOpts::default())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("codexHome is required"), "{err}");
    assert!(read_account_models(&s.t, &AccountModelsOpts::default()).await.is_err());
    assert!(sync_chatgpt_catalog(&s.t, &AccountModelsOpts::default()).await.is_err());
}

// --- listAccountModels caching ---

#[tokio::test]
async fn one_app_server_for_callers_at_the_same_time_and_none_again_while_the_answer_is_fresh() {
    let s = models_scenario(&[], true);
    let o = opts(&s);
    let (a, b) = tokio::join!(listed(&s, &o), listed(&s, &o));
    assert_eq!(a, live());
    assert_eq!(b, live());
    assert_eq!(listed(&s, &o).await, live());
    assert_eq!(s.calls().len(), 1);
    // A caller changing its copy doesn't change the next answer.
    let mut mine = list_account_models(&s.t, &o).await.unwrap();
    mine.pop();
    assert_eq!(listed(&s, &o).await, live());
    assert_eq!(s.calls().len(), 1);
}

#[tokio::test]
async fn a_new_sign_in_auth_json_changed_asks_again() {
    let s = models_scenario(&[], true);
    listed(&s, &opts(&s)).await;
    write_auth(&s.home, "at-test-canary-2-and-longer");
    assert_eq!(listed(&s, &opts(&s)).await, live());
    assert_eq!(s.calls().len(), 2);
}

#[tokio::test]
async fn max_age_ms_0_always_asks_and_a_failed_answer_is_never_kept() {
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "fallback")], true);
    assert_eq!(listed(&s, &opts(&s)).await, json!([]));
    s.env.set("FAKE_CODEX_MODELS", "live");
    assert_eq!(listed(&s, &opts(&s)).await, live(), "the failure wasn't cached");
    listed(
        &s,
        &AccountModelsOpts {
            max_age: Duration::ZERO,
            ..opts(&s)
        },
    )
    .await;
    assert_eq!(s.calls().len(), 3);
}

// --- syncChatgptCatalog: the registry's ChatGPT models come from the account ---

#[tokio::test]
async fn fills_chatgpt_models_with_the_accounts_list_and_empties_it_when_the_list_cant_be_read() {
    let s = models_scenario(&[], true);
    let registry = ProviderRegistry::of(&s.t);
    let r = sync_chatgpt_catalog(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(serde_json::to_value(r.source).unwrap(), json!("account"));
    let listed = registry.catalog_models("chatgpt-models");
    let ids: Vec<&str> = listed.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["test-free-small", "test-free-mini"]);
    assert!(listed[0].default);
    assert_eq!(listed[1].efforts.as_deref(), Some(&["low".to_string()][..]));
    assert_eq!(listed[1].vision, Some(false));
    let offered: Vec<String> = registry.models_for("chatgpt").iter().map(|m| m.id.clone()).collect();
    assert_eq!(
        offered,
        ["test-free-small", "test-free-mini"],
        "the provider offers exactly these"
    );

    s.env.set("FAKE_CODEX_MODELS", "fallback");
    let failed = sync_chatgpt_catalog(
        &s.t,
        &AccountModelsOpts {
            max_age: Duration::ZERO,
            ..opts(&s)
        },
    )
    .await
    .unwrap();
    assert_eq!(failed.reason, Some(ModelsReason::NotLive));
    assert!(
        registry.catalog_models("chatgpt-models").is_empty(),
        "no model named: Codex picks its default"
    );
}

#[tokio::test]
async fn signed_out_emptied_without_starting_codex() {
    let s = models_scenario(&[], true);
    let registry = ProviderRegistry::of(&s.t);
    sync_chatgpt_catalog(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(registry.catalog_models("chatgpt-models").len(), 2);
    std::fs::remove_file(s.home.join("auth.json")).unwrap();
    let r = sync_chatgpt_catalog(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(r.reason, Some(ModelsReason::NotSignedIn));
    assert!(registry.catalog_models("chatgpt-models").is_empty());
    assert_eq!(s.calls().len(), 1);
}

// --- What the Node suite left out: an app-server that answers late, twice, with other lines between, or not at all ---

#[tokio::test]
async fn lines_that_are_no_answer_are_passed_over_an_answer_sent_twice_counts_once_and_the_servers_own_requests_are_refused()
 {
    let s = models_scenario(&[("FAKE_CODEX_RPC_NOISE", "1")], true);
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(serde_json::to_value(&r.models).unwrap(), live());
    assert_eq!(requests(&s, "model/list").len(), 2, "each page asked for once");
    // Every request of the server's own got its refusal, under the id the server gave it.
    let replies: Vec<Value> = s
        .log_lines()
        .into_iter()
        .filter_map(|l| l.get("reply").cloned())
        .collect();
    assert_eq!(replies.len(), 4, "one for each answer the app-server gave: {replies:?}");
    for (n, reply) in replies.iter().enumerate() {
        assert_eq!(
            *reply,
            json!({ "id": format!("srv-{}", n + 1), "error": { "code": -32601, "message": "Tarsee's model check doesn't handle this request." } })
        );
    }
}

#[tokio::test]
async fn an_answer_that_comes_late_but_in_time_counts_and_one_past_the_limit_is_a_timeout() {
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "late"), ("FAKE_CODEX_DELAY_MS", "400")], true);
    assert_eq!(listed(&s, &opts(&s)).await, live());
    // The same app-server, asked with less patience than it needs: no models, never a partial list, and it is stopped.
    clear_account_models_cache(&s.t);
    s.env.set("FAKE_CODEX_DELAY_MS", "60000");
    let r = read_account_models(
        &s.t,
        &AccountModelsOpts {
            timeout: Duration::from_millis(1200),
            ..opts(&s)
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        json!({ "models": [], "source": null, "reason": "timeout" })
    );
    assert!(gone_soon(s.pid()).await);
    // A timeout is not kept: the next question starts codex again.
    s.env.set("FAKE_CODEX_DELAY_MS", "0");
    assert_eq!(listed(&s, &opts(&s)).await, live());
    assert_eq!(s.calls().len(), 3);
}

#[tokio::test]
async fn each_of_the_three_conditions_decides_by_itself_the_logged_failure_the_cache_and_an_empty_list() {
    // A cache that happens to cover the bundled catalog (left by an earlier fetch, say).
    let bundled: Value = serde_json::from_str(include_str!("../fixtures/codex-login/model-list.bundled.json")).unwrap();
    let slugs: Vec<Value> = bundled["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| json!({ "slug": m["model"] }))
        .collect();
    let covering_cache = json!({ "client_version": "0.167.0", "models": slugs }).to_string();

    // With the fetch failure logged, the answer is not the account's, whatever the cache holds.
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "fallback")], true);
    std::fs::write(s.home.join("models_cache.json"), &covering_cache).unwrap();
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        json!({ "models": [], "source": null, "reason": "not-live" })
    );

    // The same answer with nothing logged and the cache covering it does count: the cache is what vouches for it.
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "quiet-fallback")], true);
    std::fs::write(s.home.join("models_cache.json"), &covering_cache).unwrap();
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(serde_json::to_value(r.source).unwrap(), json!("account"));
    let visible = bundled["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["hidden"] != json!(true))
        .count();
    assert_eq!(r.models.len(), visible);
    assert_eq!(r.reason, None);

    // A fetch that worked and lists nothing to show: empty, and not kept (it is asked again).
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "none-listed")], true);
    for _ in 0..2 {
        let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "models": [], "source": null, "reason": "empty" })
        );
    }
    assert_eq!(s.calls().len(), 2);
}

#[tokio::test]
async fn a_list_that_never_ends_is_read_for_twenty_pages_and_no_more() {
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "endless")], true);
    let r = read_account_models(&s.t, &opts(&s)).await.unwrap();
    assert_eq!(requests(&s, "model/list").len(), 20);
    // The same two models twenty times over: each is listed once.
    assert_eq!(serde_json::to_value(&r.models).unwrap(), live());
}

#[tokio::test]
async fn a_program_that_exits_without_answering_is_an_error_not_a_hang() {
    let s = models_scenario(&[("TARSEE_TESTBIN_ROLE", "echo")], true);
    let t0 = Instant::now();
    let r = read_account_models(
        &s.t,
        &AccountModelsOpts {
            // Not the fake codex: a program that prints one line and goes.
            codex_bin: Some(testbin()),
            ..opts(&s)
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        json!({ "models": [], "source": null, "reason": "error" })
    );
    assert!(
        t0.elapsed() < Duration::from_secs(15),
        "long before the 20-second limit"
    );
}

#[tokio::test]
async fn a_question_goes_on_when_the_caller_that_asked_has_gone_and_each_app_keeps_its_own_answers() {
    let s = models_scenario(&[("FAKE_CODEX_MODELS", "late"), ("FAKE_CODEX_DELAY_MS", "300")], true);
    let caller = {
        let (app, o) = (s.t.app.clone(), opts(&s));
        tokio::spawn(async move { read_account_models(&app, &o).await })
    };
    let pid = s.pid_when_written().await;
    caller.abort();
    let _ = caller.await;
    // The next caller joins the question already asked (or finds its answer kept): codex ran once.
    assert_eq!(listed(&s, &opts(&s)).await, live());
    assert_eq!(s.calls().len(), 1);
    assert!(
        gone_soon(pid).await,
        "the app-server was stopped when the answer was in"
    );
    // Another app has kept nothing: it asks for itself.
    let other = test_app();
    let again = list_account_models(&other, &opts(&s)).await.unwrap();
    assert_eq!(serde_json::to_value(again).unwrap(), live());
    assert_eq!(s.calls().len(), 2);
    // Forgetting the kept answers makes the first app ask again too.
    clear_account_models_cache(&s.t);
    listed(&s, &opts(&s)).await;
    assert_eq!(s.calls().len(), 3);
}
