//! Port of `test/provider-registry.test.js`.
//!
//! The provider registry (design 4.3) is the one table every later phase reads: which AIs exist, which one is
//! active, which engine runs a model, what a tier word means on each provider and what a turn costs.
//!
//! The JS tests emptied the runtime catalogs after each case, because the module kept them for the whole process.
//! Here each test makes a `ProviderRegistry` of its own, so there is nothing to put back.

use chrono::{TimeZone, Utc};
use serde_json::json;

use super::*;
use crate::testkit::{MemorySettings, test_app};

const ALL_IDS: [&str; 7] = [
    "claude",
    "anthropic",
    "chatgpt",
    "openai",
    "openrouter",
    "deepseek",
    "local",
];
const NON_CLAUDE: [&str; 4] = ["deepseek", "chatgpt", "openai", "local"];
const TIER_WORDS: [&str; 7] = ["fable", "opus", "sonnet", "haiku", "top", "mid", "small"];

fn store<const N: usize>(values: [(&str, Value); N]) -> MemorySettings {
    MemorySettings::from_pairs(values)
}

fn no_env() -> Env {
    Env::new()
}

fn env<const N: usize>(vars: [(&str, &str); N]) -> Env {
    Env::from_pairs(vars)
}

/// A key-shaped string put together from parts, so no scanner takes this file for one that holds a real key.
fn key(parts: &[&str]) -> String {
    parts.concat()
}

fn efforts(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|e| e.to_string()).collect()
}

/// `{ in, out, cacheRead, cacheWrite }`.
fn rates(input: f64, output: f64, cache_read: f64, cache_write: f64) -> ModelPrice {
    ModelPrice::flat(input, output, cache_read, cache_write)
}

fn table() -> &'static ProviderTable {
    &PROVIDERS
}

// --- provider registry: entries ---

#[test]
fn has_exactly_the_seven_public_ids() {
    let mut ids = PROVIDER_IDS.to_vec();
    ids.sort();
    let mut want = ALL_IDS.to_vec();
    want.sort();
    assert_eq!(ids, want);
    // The table and the list of ids are the same seven, in the same order.
    assert_eq!(table().iter().map(|p| p.id).collect::<Vec<_>>(), PROVIDER_IDS);
}

#[test]
fn gives_every_entry_the_shape_in_design_4_3() {
    for id in ALL_IDS {
        let p = table().get(id).unwrap_or_else(|| panic!("{id} is missing"));
        assert_eq!(p.id, id);
        assert!(["subscription", "key", "local"].contains(&p.kind.as_str()), "{id} kind");
        assert!(!p.engines.is_empty(), "{id} engines");
        assert!(
            p.engines.iter().all(|e| ["claude-code", "codex"].contains(&e.as_str())),
            "{id} engines"
        );
        assert!(
            [
                "claude",
                "static",
                "openrouter",
                "openai-models",
                "chatgpt-models",
                "local-models"
            ]
            .contains(&p.catalog),
            "{id} catalog"
        );
        // Every entry says how it is tested; a key provider has a noun for its key and a place to get one.
        assert!(
            p.test_probe.kind.is_some() || p.test_probe.method.is_some(),
            "{id} testProbe"
        );
        if p.kind == ProviderKind::Key {
            assert!(
                p.key_noun.is_some() && p.key_help_url.is_some() && p.key_pattern.is_some(),
                "{id} key"
            );
            assert!(
                p.error_hints.auth.is_some() && p.error_hints.billing.is_some(),
                "{id} errorHints"
            );
        }
    }
}

#[test]
fn ships_every_provider_each_ones_engine_path_is_built_and_tested_against_fakes() {
    let reg = ProviderRegistry::new();
    assert!(ALL_IDS.iter().all(|id| table().get(id).unwrap().shipped));
    assert_eq!(
        reg.shipped_providers().iter().map(|p| p.id).collect::<Vec<_>>(),
        ALL_IDS
    );
    assert!(reg.is_shipped("claude"));
    assert!(reg.is_shipped("claude-code"));
    assert!(!reg.is_shipped("gemini"), "a provider Tarsee doesn't know");
    assert!(!reg.is_shipped("nope"));
}

#[test]
fn keeps_the_claude_plans_storage_id_and_every_other_provider_stores_under_its_own_id() {
    assert_eq!(PROVIDERS.claude.storage_id, "claude-code");
    for id in ALL_IDS.iter().filter(|id| **id != "claude") {
        assert_eq!(table().get(id).unwrap().storage_id, *id);
    }
}

#[test]
fn puts_each_provider_on_the_engines_and_key_slots_the_matrix_names() {
    assert_eq!(PROVIDERS.claude.engines, [Engine::ClaudeCode]);
    assert_eq!(PROVIDERS.anthropic.engines, [Engine::ClaudeCode]);
    assert_eq!(PROVIDERS.chatgpt.engines, [Engine::Codex]);
    assert_eq!(PROVIDERS.openai.engines, [Engine::Codex]);
    assert_eq!(PROVIDERS.local.engines, [Engine::Codex]);
    assert_eq!(PROVIDERS.deepseek.engines, [Engine::ClaudeCode, Engine::Codex]);
    assert_eq!(PROVIDERS.openrouter.engines, [Engine::ClaudeCode, Engine::Codex]);
    assert_eq!(PROVIDERS.claude.env_key, None);
    assert_eq!(PROVIDERS.chatgpt.env_key, None);
    assert_eq!(PROVIDERS.anthropic.env_key, Some("ANTHROPIC_API_KEY"));
    assert_eq!(PROVIDERS.openai.env_key, Some("OPENAI_API_KEY"));
    assert_eq!(PROVIDERS.openrouter.env_key, Some("OPENROUTER_API_KEY"));
    assert_eq!(PROVIDERS.deepseek.env_key, Some("DEEPSEEK_API_KEY"));
    assert_eq!(PROVIDERS.local.env_key, Some("TARSEE_LOCAL_AI_KEY"));
}

#[test]
fn is_frozen_so_nothing_at_runtime_can_point_a_key_at_another_host() {
    // The JS froze the table and proved an assignment threw. Here the table is an immutable static of `&'static`
    // data: there is no way to write the assignment. What is left to check is the value itself.
    assert_eq!(
        PROVIDERS.deepseek.base_url(Engine::ClaudeCode),
        Some("https://api.deepseek.com/anthropic")
    );
}

// --- provider registry: base URLs are code constants ---

#[test]
fn sends_deepseek_and_openrouter_to_their_documented_hosts_per_engine() {
    assert_eq!(
        PROVIDERS.deepseek.base_urls,
        [
            (Engine::ClaudeCode, "https://api.deepseek.com/anthropic"),
            (Engine::Codex, "https://api.deepseek.com")
        ]
    );
    assert_eq!(
        PROVIDERS.openrouter.base_urls,
        [
            (Engine::ClaudeCode, "https://openrouter.ai/api"),
            (Engine::Codex, "https://openrouter.ai/api/v1")
        ]
    );
}

#[test]
fn names_the_anthropic_and_openai_api_hosts_too_so_no_key_is_left_to_an_engines_default_host() {
    assert_eq!(
        PROVIDERS.anthropic.base_urls,
        [(Engine::ClaudeCode, "https://api.anthropic.com")]
    );
    assert_eq!(
        PROVIDERS.openai.base_urls,
        [(Engine::Codex, "https://api.openai.com/v1")]
    );
}

#[test]
fn gives_the_sign_in_plans_no_host_the_engine_signs_in_to_its_own_and_local_ai_no_constant_at_all() {
    for id in ["claude", "chatgpt", "local"] {
        assert!(table().get(id).unwrap().base_urls.is_empty(), "{id}");
    }
}

#[test]
fn has_a_host_for_every_key_provider_on_every_engine_it_runs_on() {
    for p in table().iter().filter(|p| p.kind == ProviderKind::Key) {
        for engine in p.engines {
            assert!(p.base_url(*engine).is_some(), "{}/{engine}", p.id);
        }
    }
}

#[test]
fn only_ever_uses_https() {
    for p in table().iter() {
        for (_, url) in p.base_urls {
            assert!(url.starts_with("https://"), "{}", p.id);
        }
    }
}

// --- getProvider / normalizeProviderId ---

#[test]
fn accepts_every_public_id_and_the_claude_code_alias() {
    for id in ALL_IDS {
        assert_eq!(get_provider(id).map(|p| p.id), Some(id));
    }
    assert!(std::ptr::eq(get_provider("claude-code").unwrap(), &PROVIDERS.claude));
    assert_eq!(normalize_provider_id("claude-code"), Some("claude"));
    assert_eq!(normalize_provider_id(" DeepSeek "), Some("deepseek"));
}

#[test]
fn returns_null_for_anything_else() {
    // The JS also tried undefined and null; a `&str` is never either.
    for bad in [
        "",
        "  ",
        "codex",
        "gemini",
        "claude-codex",
        "__proto__",
        "constructor",
        "toString",
    ] {
        assert!(get_provider(bad).is_none(), "{bad}");
        assert_eq!(normalize_provider_id(bad), None, "{bad}");
    }
}

// --- activeProviderId ---

#[test]
fn is_the_claude_plan_when_nothing_is_set() {
    let reg = ProviderRegistry::new();
    assert_eq!(reg.active_provider_id(Some(&store([])), &no_env()), "claude");
    assert_eq!(reg.active_provider_id(None, &no_env()), "claude");
}

#[test]
fn reads_todays_stored_value_claude_code_as_the_claude_plan() {
    let reg = ProviderRegistry::new();
    let s = store([("ai.activeProvider", json!("claude-code"))]);
    assert_eq!(reg.active_provider_id(Some(&s), &no_env()), "claude");
}

#[test]
fn takes_tarsee_ai_provider_when_settings_has_none() {
    let reg = ProviderRegistry::new();
    let s = store([]);
    assert_eq!(
        reg.active_provider_id(Some(&s), &env([("TARSEE_AI_PROVIDER", "claude")])),
        "claude"
    );
    assert_eq!(
        reg.active_provider_id(Some(&s), &env([("TARSEE_AI_PROVIDER", "claude-code")])),
        "claude"
    );
    assert_eq!(
        reg.active_provider_id(Some(&s), &env([("TARSEE_AI_PROVIDER", " DeepSeek ")])),
        "deepseek"
    );
}

#[test]
fn falls_back_to_the_claude_plan_for_a_provider_that_is_not_shipped() {
    let reg = ProviderRegistry::new();
    let only_claude = |id: &str| id == "claude";
    for id in ALL_IDS.iter().copied().filter(|id| *id != "claude") {
        let chosen = store([("ai.activeProvider", json!(id))]);
        assert_eq!(
            active_provider_id_with(Some(&chosen), &no_env(), only_claude),
            "claude",
            "setting {id}"
        );
        assert_eq!(
            active_provider_id_with(Some(&store([])), &env([("TARSEE_AI_PROVIDER", id)]), only_claude),
            "claude",
            "env {id}"
        );
        assert_eq!(reg.active_provider_id(Some(&chosen), &no_env()), id, "shipped: {id}");
    }
    let gemini = store([("ai.activeProvider", json!("gemini"))]);
    assert_eq!(reg.active_provider_id(Some(&gemini), &no_env()), "claude");
}

#[test]
fn never_picks_a_provider_because_its_key_happens_to_be_in_the_environment() {
    let reg = ProviderRegistry::new();
    let keys = env([
        ("OPENROUTER_API_KEY", key(&["sk-or-", "v1-test-canary-0000"]).as_str()),
        ("OPENAI_API_KEY", key(&["sk-", "test-canary-openai-0000"]).as_str()),
        ("DEEPSEEK_API_KEY", key(&["sk-", "test-canary-deepseek-0000"]).as_str()),
        (
            "ANTHROPIC_API_KEY",
            key(&["sk-ant-", "api03-test-canary-0000"]).as_str(),
        ),
        ("TARSEE_LOCAL_AI_URL", "http://127.0.0.1:11434/v1"),
    ]);
    assert_eq!(reg.active_provider_id(Some(&store([])), &keys), "claude");
    // Even with every provider shipped, key presence alone never chooses one.
    assert_eq!(active_provider_id_with(Some(&store([])), &keys, |_| true), "claude");
}

#[test]
fn prefers_the_settings_value_over_tarsee_ai_provider_once_both_name_shipped_providers() {
    let all = |_: &str| true;
    let openai = env([("TARSEE_AI_PROVIDER", "openai")]);
    let deepseek = store([("ai.activeProvider", json!("deepseek"))]);
    assert_eq!(active_provider_id_with(Some(&deepseek), &openai, all), "deepseek");
    assert_eq!(active_provider_id_with(Some(&store([])), &openai, all), "openai");
}

// --- keysOnly ---

#[test]
fn is_off_by_default() {
    assert!(!keys_only(Some(&store([])), &no_env()));
    assert!(!keys_only(None, &no_env()));
    assert!(!keys_only_locked(&no_env()));
}

#[test]
fn follows_the_ai_keys_only_setting() {
    for on in [json!(true), json!("true"), json!("1"), json!(1)] {
        assert!(
            keys_only(Some(&store([("ai.keysOnly", on.clone())])), &no_env()),
            "{on}"
        );
    }
    for off in [
        json!(false),
        json!("false"),
        json!("0"),
        json!(0),
        json!(null),
        json!(""),
    ] {
        assert!(
            !keys_only(Some(&store([("ai.keysOnly", off.clone())])), &no_env()),
            "{off}"
        );
    }
}

#[test]
fn is_locked_on_by_tarsee_keys_only_1_whatever_the_setting_says() {
    let off = store([("ai.keysOnly", json!(false))]);
    assert!(keys_only(Some(&off), &env([("TARSEE_KEYS_ONLY", "1")])));
    assert!(keys_only_locked(&env([("TARSEE_KEYS_ONLY", "1")])));
    assert!(!keys_only_locked(&env([("TARSEE_KEYS_ONLY", "0")])));
    assert!(!keys_only(Some(&off), &env([("TARSEE_KEYS_ONLY", "0")])));
    // The other words for yes, in any case and with space around them.
    for word in [" TRUE ", "yes", "On"] {
        assert!(keys_only_locked(&env([("TARSEE_KEYS_ONLY", word)])), "{word}");
    }
}

// --- resolveModelFor ---

#[test]
fn never_returns_a_claude_id_for_deepseek_chatgpt_openai_or_local() {
    let nasty: Vec<Option<&str>> = [None, Some(""), Some("   ")]
        .into_iter()
        .chain(TIER_WORDS.iter().copied().map(Some))
        .chain(
            [
                "OPUS",
                "claude-opus-5",
                "claude-sonnet-4-6",
                "claude-haiku-4-5",
                "claude-fable-5-1",
                "claude-opus-9-9",
                "Claude-Opus-5",
                "claude-sonnet-5[1m]",
                "claude-code",
                "claude",
                "claude-",
                "anthropic/claude-sonnet-5",
                "~anthropic/claude-sonnet-latest",
                "random-model",
                "gpt-6.1-sol",
                "deepseek-flash",
            ]
            .into_iter()
            .map(Some),
        )
        .collect();
    let reg = ProviderRegistry::new();
    let check = |label: &str| {
        for id in NON_CLAUDE {
            for m in &nasty {
                let out = reg.resolve_model_for(id, *m, None);
                assert!(
                    out.as_deref().is_none_or(|model| !is_claude_id(model)),
                    "{label} {id} {m:?} -> {out:?}"
                );
            }
        }
    };
    check("no catalogs:");
    // A runtime list that itself carries a claude-looking id still can't leak one.
    reg.set_catalog_models(
        "chatgpt-models",
        &[
            json!({"id": "claude-sonnet-5", "tier": "sonnet"}),
            json!({"id": "gpt-6-luna", "tier": "haiku", "default": true}),
        ],
    )
    .unwrap();
    reg.set_catalog_models("local-models", &[json!({"id": "claude-distill:7b"})])
        .unwrap();
    check("hostile catalogs:");
}

#[test]
fn maps_every_tier_word_on_deepseek() {
    let reg = ProviderRegistry::new();
    let want = [
        ("fable", "deepseek-v4-pro"),
        ("opus", "deepseek-v4-pro"),
        ("top", "deepseek-v4-pro"),
        ("sonnet", "deepseek-flash"),
        ("mid", "deepseek-flash"),
        ("haiku", "deepseek-flash"),
        ("small", "deepseek-flash"),
    ];
    for (t, m) in want {
        assert_eq!(
            reg.resolve_model_for("deepseek", Some(t), None).as_deref(),
            Some(m),
            "{t}"
        );
    }
}

#[test]
fn maps_every_tier_word_on_the_openai_key() {
    let reg = ProviderRegistry::new();
    let want = [
        ("fable", "gpt-6-astra"),
        ("opus", "gpt-6-astra"),
        ("top", "gpt-6-astra"),
        ("sonnet", "gpt-6.1-sol"),
        ("mid", "gpt-6.1-sol"),
        ("haiku", "gpt-6-luna"),
        ("small", "gpt-6-luna"),
    ];
    for (t, m) in want {
        assert_eq!(
            reg.resolve_model_for("openai", Some(t), None).as_deref(),
            Some(m),
            "{t}"
        );
    }
}

#[test]
fn keeps_the_claude_tier_words_as_todays_always_latest_aliases() {
    let reg = ProviderRegistry::new();
    for id in ["claude", "anthropic", "claude-code"] {
        for t in ["fable", "opus", "sonnet", "haiku"] {
            assert_eq!(reg.resolve_model_for(id, Some(t), None).as_deref(), Some(t), "{id} {t}");
        }
        assert_eq!(reg.resolve_model_for(id, Some("top"), None).as_deref(), Some("opus"));
        assert_eq!(reg.resolve_model_for(id, Some("mid"), None).as_deref(), Some("sonnet"));
        assert_eq!(reg.resolve_model_for(id, Some("small"), None).as_deref(), Some("haiku"));
    }
}

#[test]
fn maps_every_tier_word_on_openrouter_to_the_latest_anthropic_slugs() {
    let reg = ProviderRegistry::new();
    let resolve = |t: &str| reg.resolve_model_for("openrouter", Some(t), None);
    assert_eq!(resolve("opus").as_deref(), Some("~anthropic/claude-opus-latest"));
    assert_eq!(resolve("fable").as_deref(), Some("~anthropic/claude-opus-latest"));
    assert_eq!(resolve("sonnet").as_deref(), Some("~anthropic/claude-sonnet-latest"));
    assert_eq!(resolve("haiku").as_deref(), Some("~anthropic/claude-haiku-latest"));
    assert_eq!(resolve("small").as_deref(), Some("~anthropic/claude-haiku-latest"));
}

#[test]
fn openrouters_tiers_follow_the_default_models_maker_once_that_isnt_anthropic_design_4_11() {
    let reg = ProviderRegistry::new();
    reg.set_catalog_models(
        "openrouter",
        &[
            json!({"id": "google/gemini-3-pro", "price": {"in": 2, "out": 12}}),
            json!({"id": "google/gemini-3-flash", "price": {"in": 0.3, "out": 2.5}}),
            json!({"id": "google/gemini-3-ultra", "price": {"in": 10, "out": 40}}),
            json!({"id": "openai/gpt-5.5", "price": {"in": 1.25, "out": 10}}),
            json!({"id": "anthropic/claude-sonnet-4.6", "price": {"in": 3, "out": 15}}),
        ],
    )
    .unwrap();
    // The verified map as the JSON text a plain store holds, the default model, and anything else on top.
    let at = |verified: Value, extra: Vec<(&str, Value)>| {
        let mut pairs = vec![
            ("ai.openrouter.verified", json!(verified.to_string())),
            ("ai.openrouter.model", json!("google/gemini-3-pro")),
        ];
        for (name, value) in extra {
            pairs.retain(|(n, _)| *n != name);
            pairs.push((name, value));
        }
        MemorySettings::from_pairs(pairs)
    };
    let resolve = |t: &str, s: &MemorySettings| reg.resolve_model_for("openrouter", Some(t), Some(s));
    let pro = json!({"engine": "claude-code"});
    // The default and a cheaper model of its maker: the cheaper one is haiku, the default every tier above.
    let two = at(
        json!({"google/gemini-3-pro": pro, "google/gemini-3-flash": {"engine": "codex"}}),
        vec![],
    );
    let want = [
        ("fable", "google/gemini-3-pro"),
        ("opus", "google/gemini-3-pro"),
        ("sonnet", "google/gemini-3-pro"),
        ("haiku", "google/gemini-3-flash"),
        ("small", "google/gemini-3-flash"),
    ];
    for (t, m) in want {
        assert_eq!(resolve(t, &two).as_deref(), Some(m), "{t}");
    }
    assert_eq!(
        resolve("claude-opus-4-8", &two).as_deref(),
        Some("google/gemini-3-pro"),
        "a built-in agent's Claude id maps by tier too"
    );
    // A dearer one verified too: it is opus and fable.
    let three = at(
        json!({"google/gemini-3-pro": pro, "google/gemini-3-flash": pro, "google/gemini-3-ultra": pro}),
        vec![],
    );
    assert_eq!(resolve("opus", &three).as_deref(), Some("google/gemini-3-ultra"));
    assert_eq!(resolve("fable", &three).as_deref(), Some("google/gemini-3-ultra"));
    assert_eq!(resolve("sonnet", &three).as_deref(), Some("google/gemini-3-pro"));
    assert_eq!(resolve("haiku", &three).as_deref(), Some("google/gemini-3-flash"));
    // Only the default of that maker: every tier is the default.
    let one = at(
        json!({"google/gemini-3-pro": pro, "openai/gpt-5.5": {"engine": "codex"}}),
        vec![],
    );
    for t in TIER_WORDS {
        assert_eq!(resolve(t, &one).as_deref(), Some("google/gemini-3-pro"), "{t}");
    }
    // An openai/* default runs unverified (on Codex): its maker's tiers too.
    let openai_default = at(json!({}), vec![("ai.openrouter.model", json!("openai/gpt-5.5"))]);
    for t in TIER_WORDS {
        assert_eq!(resolve(t, &openai_default).as_deref(), Some("openai/gpt-5.5"), "{t}");
    }
    // The owner's own map still wins; an Anthropic default, no default, or a default that can't run yet: today's
    // slugs.
    let own_map = at(
        json!({"google/gemini-3-pro": pro}),
        vec![("ai.openrouter.tiers", json!({"haiku": "deepseek/deepseek-chat:free"}))],
    );
    assert_eq!(
        resolve("haiku", &own_map).as_deref(),
        Some("deepseek/deepseek-chat:free")
    );
    for s in [
        at(
            json!({"google/gemini-3-pro": pro}),
            vec![("ai.openrouter.model", json!("anthropic/claude-sonnet-4.6"))],
        ),
        at(
            json!({"google/gemini-3-pro": pro}),
            vec![("ai.openrouter.model", json!(null))],
        ),
        at(json!({}), vec![]),
    ] {
        assert_eq!(resolve("haiku", &s).as_deref(), Some("~anthropic/claude-haiku-latest"));
        assert_eq!(resolve("opus", &s).as_deref(), Some("~anthropic/claude-opus-latest"));
    }
}

#[test]
fn claude_list_price_a_claude_models_list_price_from_openrouters_public_list_a_tier_word_is_its_familys_newest() {
    let reg = ProviderRegistry::new();
    assert_eq!(
        reg.claude_list_price("claude-sonnet-5"),
        None,
        "nothing until the list is in"
    );
    reg.set_catalog_models(
        "openrouter",
        &[
            json!({"id": "anthropic/claude-sonnet-4.6", "price": {"in": 2, "out": 10, "cacheRead": 0.2, "cacheWrite": 2.5}}),
            json!({"id": "anthropic/claude-sonnet-5", "price": {"in": 3, "out": 15, "cacheRead": 0.3, "cacheWrite": 3.75}}),
            json!({"id": "anthropic/claude-opus-4.7", "price": {"in": 5, "out": 25}}),
            json!({"id": "anthropic/claude-haiku-4.5", "price": {"in": 1, "out": 5, "cacheRead": 0.1, "cacheWrite": 1.25}}),
        ],
    )
    .unwrap();
    assert_eq!(
        reg.claude_list_price("claude-sonnet-4-6"),
        Some(rates(2.0, 10.0, 0.2, 2.5))
    );
    assert_eq!(
        reg.claude_list_price("claude-opus-4-7[1m]"),
        Some(rates(5.0, 25.0, 5.0, 5.0))
    );
    assert_eq!(
        reg.claude_list_price("sonnet"),
        Some(rates(3.0, 15.0, 0.3, 3.75)),
        "the family's newest"
    );
    assert_eq!(reg.claude_list_price("opus[1m]"), Some(rates(5.0, 25.0, 5.0, 5.0)));
    assert_eq!(
        reg.claude_list_price("claude-haiku-4-6"),
        Some(rates(1.0, 5.0, 0.1, 1.25)),
        "a pin the list lacks: its family's newest"
    );
    assert_eq!(reg.claude_list_price("fable"), None, "no Fable on the list");
    assert_eq!(reg.claude_list_price(""), None);
    // What it gives is the four rates and nothing else.
    assert_eq!(
        serde_json::to_string(&reg.claude_list_price("sonnet")).unwrap(),
        r#"{"in":3.0,"out":15.0,"cacheRead":0.3,"cacheWrite":3.75}"#
    );
}

#[test]
fn lets_the_owners_openrouter_and_local_tier_maps_win() {
    let reg = ProviderRegistry::new();
    let s = store([("ai.openrouter.tiers", json!({"haiku": "deepseek/deepseek-chat:free"}))]);
    assert_eq!(
        reg.resolve_model_for("openrouter", Some("haiku"), Some(&s)).as_deref(),
        Some("deepseek/deepseek-chat:free")
    );
    assert_eq!(
        reg.resolve_model_for("openrouter", Some("sonnet"), Some(&s)).as_deref(),
        Some("~anthropic/claude-sonnet-latest")
    );
    let l = store([
        ("ai.local.model", json!("qwen3:32b")),
        ("ai.local.tiers", json!(json!({"haiku": "qwen3:4b"}).to_string())),
    ]);
    assert_eq!(
        reg.resolve_model_for("local", Some("haiku"), Some(&l)).as_deref(),
        Some("qwen3:4b")
    );
    assert_eq!(
        reg.resolve_model_for("local", Some("opus"), Some(&l)).as_deref(),
        Some("qwen3:32b")
    );
}

#[test]
fn maps_every_tier_on_local_ai_to_the_chosen_model() {
    let reg = ProviderRegistry::new();
    let s = store([("ai.local.model", json!("llama3.1:8b"))]);
    for t in TIER_WORDS {
        assert_eq!(
            reg.resolve_model_for("local", Some(t), Some(&s)).as_deref(),
            Some("llama3.1:8b"),
            "{t}"
        );
    }
    assert_eq!(
        reg.resolve_model_for("local", Some(""), Some(&s)).as_deref(),
        Some("llama3.1:8b")
    );
    // No chosen model: the first one the server lists.
    reg.set_catalog_models(
        "local-models",
        &[json!({"id": "mistral:7b"}), json!({"id": "phi4:14b"})],
    )
    .unwrap();
    for t in TIER_WORDS {
        assert_eq!(
            reg.resolve_model_for("local", Some(t), None).as_deref(),
            Some("mistral:7b"),
            "{t}"
        );
    }
}

#[test]
fn has_no_chatgpt_model_of_its_own_tiers_come_from_the_accounts_live_list_else_codex_chooses() {
    let reg = ProviderRegistry::new();
    let resolve = |m: &str| reg.resolve_model_for("chatgpt", Some(m), None);
    assert!(PROVIDERS.chatgpt.models.is_empty());
    assert_eq!(PROVIDERS.chatgpt.default_model, None);
    assert_eq!(PROVIDERS.chatgpt.background_model, None);
    for t in TIER_WORDS {
        assert_eq!(resolve(t), None, "{t}");
    }
    assert_eq!(resolve(""), None);
    assert_eq!(
        resolve("gpt-6.1-sol"),
        None,
        "without the account's list, no model is named at all"
    );
    // A free account that only lists the small model: every tier steps to it.
    reg.set_catalog_models("chatgpt-models", &[json!({"id": "gpt-6-luna", "tier": "haiku"})])
        .unwrap();
    for t in TIER_WORDS {
        assert_eq!(resolve(t).as_deref(), Some("gpt-6-luna"), "{t}");
    }
    // A bigger account: each tier steps down to the best the account lists.
    reg.set_catalog_models(
        "chatgpt-models",
        &[
            json!({"id": "gpt-6.1-sol", "tier": "sonnet", "default": true}),
            json!({"id": "gpt-6-luna", "tier": "haiku"}),
        ],
    )
    .unwrap();
    assert_eq!(resolve("opus").as_deref(), Some("gpt-6.1-sol"));
    assert_eq!(resolve("fable").as_deref(), Some("gpt-6.1-sol"));
    assert_eq!(resolve("haiku").as_deref(), Some("gpt-6-luna"));
    assert_eq!(resolve("").as_deref(), Some("gpt-6.1-sol"));
    assert_eq!(
        resolve("gpt-6-astra").as_deref(),
        Some("gpt-6.1-sol"),
        "a model the account does not list falls back to its default"
    );
}

#[test]
fn maps_a_claude_id_on_a_non_claude_provider_through_its_tier() {
    let reg = ProviderRegistry::new();
    let resolve = |id: &str, m: &str| reg.resolve_model_for(id, Some(m), None);
    assert_eq!(resolve("deepseek", "claude-opus-5").as_deref(), Some("deepseek-v4-pro"));
    assert_eq!(
        resolve("deepseek", "claude-fable-5-1").as_deref(),
        Some("deepseek-v4-pro")
    );
    assert_eq!(
        resolve("deepseek", "claude-haiku-4-5").as_deref(),
        Some("deepseek-flash")
    );
    assert_eq!(resolve("openai", "claude-sonnet-5[1m]").as_deref(), Some("gpt-6.1-sol"));
    assert_eq!(
        resolve("openrouter", "claude-haiku-4-5").as_deref(),
        Some("~anthropic/claude-haiku-latest")
    );
}

#[test]
fn falls_back_to_the_providers_default_for_an_unknown_id() {
    let reg = ProviderRegistry::new();
    let resolve = |id: &str, m: &str| reg.resolve_model_for(id, Some(m), None);
    assert_eq!(resolve("deepseek", "gpt-4o").as_deref(), Some("deepseek-flash"));
    assert_eq!(
        reg.resolve_model_for("deepseek", None, None).as_deref(),
        Some("deepseek-flash")
    );
    assert_eq!(resolve("openai", "deepseek-flash").as_deref(), Some("gpt-6.1-sol"));
    assert_eq!(
        resolve("claude", "gpt-6.1-sol").as_deref(),
        Some(get_recommended_model())
    );
    assert_eq!(resolve("claude", "").as_deref(), Some(get_recommended_model()));
    assert_eq!(
        resolve("openrouter", "").as_deref(),
        Some("~anthropic/claude-sonnet-latest")
    );
}

#[test]
fn keeps_known_ids_and_drops_the_1m_suffix_the_engine_adds_itself() {
    let reg = ProviderRegistry::new();
    let resolve = |id: &str, m: &str| reg.resolve_model_for(id, Some(m), None);
    assert_eq!(resolve("deepseek", "deepseek-flash").as_deref(), Some("deepseek-flash"));
    assert_eq!(
        resolve("deepseek", "deepseek-v4-pro[1m]").as_deref(),
        Some("deepseek-v4-pro")
    );
    assert_eq!(resolve("openai", "gpt-5.5").as_deref(), Some("gpt-5.5"));
}

#[test]
fn reads_a_tier_word_with_claude_codes_1m_suffix_as_that_tier() {
    let reg = ProviderRegistry::new();
    let resolve = |id: &str, m: &str| reg.resolve_model_for(id, Some(m), None);
    // The Claude providers pass it through as today ("opus[1m]" is a Claude Code alias); the rest map the tier.
    for id in ["claude", "anthropic", "claude-code"] {
        for t in ["fable", "opus", "sonnet", "haiku"] {
            let want = format!("{t}[1m]");
            assert_eq!(resolve(id, &want), Some(want.clone()), "{id} {t}[1m]");
            let shouted = format!("{}[1M]", t.to_uppercase());
            assert_eq!(resolve(id, &shouted), Some(want), "{id} {shouted}");
        }
        assert_eq!(resolve(id, "top[1m]").as_deref(), Some("opus[1m]"));
    }
    assert_eq!(resolve("deepseek", "opus[1m]").as_deref(), Some("deepseek-v4-pro"));
    assert_eq!(resolve("deepseek", "fable[1m]").as_deref(), Some("deepseek-v4-pro"));
    assert_eq!(resolve("deepseek", "sonnet[1m]").as_deref(), Some("deepseek-flash"));
    assert_eq!(
        resolve("openrouter", "opus[1m]").as_deref(),
        Some("~anthropic/claude-opus-latest")
    );
    assert_eq!(
        resolve("openrouter", "sonnet[1m]").as_deref(),
        Some("~anthropic/claude-sonnet-latest")
    );
    assert_eq!(
        resolve("openrouter", "fable[1m]").as_deref(),
        Some("~anthropic/claude-opus-latest")
    );
    assert_eq!(resolve("openai", "haiku[1m]").as_deref(), Some("gpt-6-luna"));
}

#[test]
fn keeps_claude_ids_as_today_pinned_rows_newer_catalog_ids_and_partial_names() {
    let reg = ProviderRegistry::new();
    let resolve = |id: &str, m: &str| reg.resolve_model_for(id, Some(m), None);
    assert_eq!(resolve("claude", "claude-opus-4-6").as_deref(), Some("claude-opus-4-6"));
    assert_eq!(
        resolve("claude", "claude-opus-5-5").as_deref(),
        Some("claude-opus-5-5"),
        "a release only Claude Code's catalog lists yet"
    );
    assert_eq!(resolve("claude", "opus-4-6").as_deref(), Some("claude-opus-4-6"));
    assert_eq!(
        resolve("claude-code", "claude-sonnet-5[1m]").as_deref(),
        Some("claude-sonnet-5[1m]")
    );
}

#[test]
fn passes_openrouter_slugs_through_colons_and_all() {
    let reg = ProviderRegistry::new();
    let resolve = |m: &str| reg.resolve_model_for("openrouter", Some(m), None);
    assert_eq!(
        resolve("deepseek/deepseek-chat:free").as_deref(),
        Some("deepseek/deepseek-chat:free")
    );
    assert_eq!(
        resolve("anthropic/claude-sonnet-5").as_deref(),
        Some("anthropic/claude-sonnet-5")
    );
}

#[test]
fn drops_an_openrouter_slug_its_loaded_catalog_does_not_list_unless_the_owner_verified_it() {
    let reg = ProviderRegistry::new();
    reg.set_catalog_models(
        "openrouter",
        &[
            json!({"id": "anthropic/claude-sonnet-5"}),
            json!({"id": "deepseek/deepseek-chat:free"}),
        ],
    )
    .unwrap();
    assert_eq!(
        reg.resolve_model_for("openrouter", Some("nobody/never-heard-of"), None)
            .as_deref(),
        Some("~anthropic/claude-sonnet-latest")
    );
    let s = store([(
        "ai.openrouter.verified",
        json!({"nobody/never-heard-of": {"engine": "codex", "at": "2026-11-09"}}),
    )]);
    assert_eq!(
        reg.resolve_model_for("openrouter", Some("nobody/never-heard-of"), Some(&s))
            .as_deref(),
        Some("nobody/never-heard-of")
    );
}

#[test]
fn resolve_model_for_returns_null_for_a_provider_that_does_not_exist() {
    assert_eq!(
        ProviderRegistry::new().resolve_model_for("gemini", Some("sonnet"), None),
        None
    );
}

// --- engineFor ---

#[test]
fn runs_the_claude_providers_on_claude_code_and_the_openai_style_ones_on_codex() {
    assert_eq!(engine_for("claude", Some("sonnet"), None), Some(Engine::ClaudeCode));
    assert_eq!(
        engine_for("claude-code", Some("sonnet"), None),
        Some(Engine::ClaudeCode)
    );
    assert_eq!(engine_for("anthropic", Some("opus"), None), Some(Engine::ClaudeCode));
    assert_eq!(engine_for("chatgpt", Some("gpt-6-luna"), None), Some(Engine::Codex));
    assert_eq!(engine_for("openai", Some("gpt-6.1-sol"), None), Some(Engine::Codex));
    assert_eq!(engine_for("local", Some("llama3.1:8b"), None), Some(Engine::Codex));
}

#[test]
fn runs_deepseek_on_claude_code_unless_verification_picked_codex() {
    assert_eq!(
        engine_for("deepseek", Some("deepseek-flash"), None),
        Some(Engine::ClaudeCode)
    );
    let verified = json!({"deepseek-v4-pro": {"engine": "codex", "at": "2026-11-09"}});
    let s = store([("ai.deepseek.verified", json!(verified.to_string()))]);
    assert_eq!(
        engine_for("deepseek", Some("deepseek-v4-pro"), Some(&s)),
        Some(Engine::Codex)
    );
    assert_eq!(
        engine_for("deepseek", Some("deepseek-v4-pro[1m]"), Some(&s)),
        Some(Engine::Codex)
    );
    assert_eq!(
        engine_for("deepseek", Some("deepseek-flash"), Some(&s)),
        Some(Engine::ClaudeCode)
    );
}

#[test]
fn routes_openrouter_by_maker_and_needs_verification_for_every_other_maker() {
    let engine = |m: &str| engine_for("openrouter", Some(m), None);
    assert_eq!(engine("anthropic/claude-sonnet-5"), Some(Engine::ClaudeCode));
    assert_eq!(engine("~anthropic/claude-sonnet-latest"), Some(Engine::ClaudeCode));
    assert_eq!(engine("openai/gpt-6.1-sol"), Some(Engine::Codex));
    assert_eq!(engine("~openai/gpt-latest"), Some(Engine::Codex));
    assert_eq!(engine("meta-llama/llama-4-maverick"), None);
    assert_eq!(engine("deepseek/deepseek-chat:free"), None);
    let s = store([(
        "ai.openrouter.verified",
        json!({"meta-llama/llama-4-maverick": {"engine": "claude-code"}}),
    )]);
    assert_eq!(
        engine_for("openrouter", Some("meta-llama/llama-4-maverick"), Some(&s)),
        Some(Engine::ClaudeCode)
    );
}

#[test]
fn ignores_a_verified_entry_naming_an_engine_the_provider_does_not_have() {
    let s = store([
        (
            "ai.openrouter.verified",
            json!({"x-ai/grok-5": {"engine": "gemini-cli"}}),
        ),
        ("ai.deepseek.verified", json!("not json")),
    ]);
    assert_eq!(engine_for("openrouter", Some("x-ai/grok-5"), Some(&s)), None);
    assert_eq!(
        engine_for("deepseek", Some("deepseek-flash"), Some(&s)),
        Some(Engine::ClaudeCode)
    );
}

#[test]
fn engine_for_returns_null_for_a_provider_that_does_not_exist() {
    assert_eq!(engine_for("gemini", Some("x"), None), None);
}

// --- contextTokensFor ---

#[test]
fn reads_todays_claude_table_unknown_ids_count_as_1m_as_the_context_meter_does() {
    let reg = ProviderRegistry::new();
    let context = |id: &str, m: &str| reg.context_tokens_for(id, Some(m), None);
    assert_eq!(context("claude", "sonnet"), Some(1_000_000));
    assert_eq!(context("claude", "haiku"), Some(200_000));
    assert_eq!(context("claude", "claude-haiku-4-5"), Some(200_000));
    assert_eq!(context("anthropic", "claude-opus-5"), Some(1_000_000));
    assert_eq!(context("claude", "claude-opus-5-5"), Some(1_000_000));
}

#[test]
fn gives_both_deepseek_models_a_1m_window() {
    let reg = ProviderRegistry::new();
    assert_eq!(
        reg.context_tokens_for("deepseek", Some("deepseek-flash"), None),
        Some(1_000_000)
    );
    assert_eq!(
        reg.context_tokens_for("deepseek", Some("deepseek-v4-pro[1m]"), None),
        Some(1_000_000)
    );
}

#[test]
fn uses_the_local_ai_cards_context_128k_by_default() {
    let reg = ProviderRegistry::new();
    assert_eq!(
        reg.context_tokens_for("local", Some("llama3.1:8b"), None),
        Some(128_000)
    );
    assert_eq!(
        reg.context_tokens_for(
            "local",
            Some("llama3.1:8b"),
            Some(&store([("ai.local.context", json!(32768))]))
        ),
        Some(32768)
    );
    assert_eq!(
        reg.context_tokens_for(
            "local",
            Some("llama3.1:8b"),
            Some(&store([("ai.local.context", json!("65536"))]))
        ),
        Some(65536)
    );
}

#[test]
fn local_ai_the_servers_own_size_when_it_says_one_the_smaller_of_it_and_the_cards_never_past_what_the_model_was_trained_for()
 {
    let reg = ProviderRegistry::new();
    let own = |n: u64| store([("ai.local.context", json!(n))]);
    let context =
        |m: &str, s: Option<&MemorySettings>| reg.context_tokens_for("local", Some(m), s.map(|s| s as &dyn Settings));
    // The owner's case: LM Studio loaded the model at 32,768 while Tarsee assumed 128,000.
    reg.set_local_models(
        &[
            json!({"id": "spark-4b", "serverContext": 32_768}),
            json!({"id": "qwen3:8b"}),
            json!({"id": "tiny", "maxContext": 8192}),
        ],
        None,
    );
    assert_eq!(
        context("spark-4b", None),
        Some(32_768),
        "the server's size, not the 128K default"
    );
    assert_eq!(
        context("spark-4b", Some(&own(128_000))),
        Some(32_768),
        "min(the owner's, the server's)"
    );
    assert_eq!(context("spark-4b", Some(&own(16_384))), Some(16_384));
    assert_eq!(
        context("qwen3:8b", Some(&own(65_536))),
        Some(65_536),
        "no word from the server: the owner's"
    );
    assert_eq!(context("qwen3:8b", None), Some(128_000), "then 128K");
    assert_eq!(context("tiny", None), Some(8192), "never past the model's own most");
    assert_eq!(local_context_tokens(Some(&json!(100_000)), Some(65_536), None), 65_536);
    assert_eq!(local_context_tokens(None, None, None), 128_000);
    let rows = reg.catalog_models("local-models");
    assert_eq!(
        rows.iter()
            .map(|m| (m.id.as_str(), m.context, m.server_context))
            .collect::<Vec<_>>(),
        [
            ("spark-4b", Some(32_768), Some(32_768)),
            ("qwen3:8b", Some(128_000), None),
            ("tiny", Some(8192), None)
        ],
        "each row keeps the server's size apart from the one used"
    );
}

#[test]
fn uses_a_runtime_catalogs_context_where_there_is_one() {
    let reg = ProviderRegistry::new();
    reg.set_catalog_models(
        "openrouter",
        &[json!({"id": "deepseek/deepseek-chat:free", "context": 163_840})],
    )
    .unwrap();
    assert_eq!(
        reg.context_tokens_for("openrouter", Some("deepseek/deepseek-chat:free"), None),
        Some(163_840)
    );
    assert_eq!(
        reg.context_tokens_for("openrouter", Some("unknown/model"), None),
        Some(200_000)
    );
    assert_eq!(reg.context_tokens_for("chatgpt", None, None), Some(200_000));
    assert_eq!(
        reg.context_tokens_for("openai", Some("gpt-6.1-sol"), None),
        Some(1_050_000)
    );
    assert_eq!(reg.context_tokens_for("gemini", Some("x"), None), None);
}

// --- effortsFor ---

#[test]
fn offers_claudes_five_levels_on_the_claude_providers() {
    let reg = ProviderRegistry::new();
    assert_eq!(reg.efforts_for("claude", Some("sonnet"), None), EFFORT_IDS);
    assert_eq!(reg.efforts_for("anthropic", Some("claude-opus-5"), None), EFFORT_IDS);
}

#[test]
fn offers_low_high_and_max_on_deepseek() {
    let reg = ProviderRegistry::new();
    assert_eq!(
        reg.efforts_for("deepseek", Some("deepseek-flash"), None),
        ["low", "high", "max"]
    );
    assert_eq!(
        reg.efforts_for("deepseek", Some("deepseek-v4-pro"), None),
        ["low", "high", "max"]
    );
}

#[test]
fn offers_claude_levels_on_openrouter_anthropic_and_only_what_verification_passed_elsewhere() {
    let reg = ProviderRegistry::new();
    assert_eq!(
        reg.efforts_for("openrouter", Some("anthropic/claude-sonnet-5"), None),
        EFFORT_IDS
    );
    assert_eq!(
        reg.efforts_for("openrouter", Some("~anthropic/claude-sonnet-latest"), None),
        EFFORT_IDS
    );
    assert!(
        reg.efforts_for("openrouter", Some("meta-llama/llama-4-maverick"), None)
            .is_empty()
    );
    let s = store([(
        "ai.openrouter.verified",
        json!({"meta-llama/llama-4-maverick": {"engine": "codex", "efforts": ["low", "high"]}}),
    )]);
    assert_eq!(
        reg.efforts_for("openrouter", Some("meta-llama/llama-4-maverick"), Some(&s)),
        ["low", "high"]
    );
}

#[test]
fn only_lists_effort_ids_tarsee_knows() {
    let reg = ProviderRegistry::new();
    for id in ALL_IDS {
        for m in [
            None,
            Some("sonnet"),
            Some("deepseek-flash"),
            Some("gpt-6.1-sol"),
            Some("gpt-5.5"),
        ] {
            for e in reg.efforts_for(id, m, None) {
                assert!(EFFORT_IDS.contains(&e.as_str()), "{id} {m:?} {e}");
            }
        }
    }
    assert!(reg.efforts_for("gemini", Some("x"), None).is_empty());
    assert_eq!(
        reg.efforts_for("openai", Some("gpt-5.5"), None),
        ["low", "medium", "high", "xhigh"]
    );
    assert!(reg.efforts_for("local", Some("llama3.1:8b"), None).is_empty());
}

// --- capsFor ---

fn caps(vision: bool, pdf: bool, thinking_summaries: bool, native_budget: bool, streaming: bool) -> Caps {
    Caps {
        vision,
        pdf,
        thinking_summaries,
        native_budget,
        streaming,
    }
}

#[test]
fn gives_the_claude_providers_everything_with_a_native_budget() {
    let reg = ProviderRegistry::new();
    let want = Some(caps(true, true, true, true, true));
    assert_eq!(reg.caps_for("claude", Some("sonnet"), None), want);
    assert_eq!(reg.caps_for("anthropic", Some("claude-opus-5"), None), want);
    assert_eq!(
        serde_json::to_string(&want).unwrap(),
        r#"{"vision":true,"pdf":true,"thinkingSummaries":true,"nativeBudget":true,"streaming":true}"#
    );
}

#[test]
fn knows_deepseek_has_no_pdfs_and_v4_pro_no_images() {
    let reg = ProviderRegistry::new();
    assert_eq!(
        reg.caps_for("deepseek", Some("deepseek-flash"), None),
        Some(caps(true, false, false, false, true))
    );
    assert_eq!(
        reg.caps_for("deepseek", Some("deepseek-v4-pro"), None),
        Some(caps(false, false, false, false, true))
    );
}

#[test]
fn says_codex_run_models_reply_a_message_at_a_time_and_take_no_pdfs() {
    let reg = ProviderRegistry::new();
    for (id, m) in [
        ("openai", Some("gpt-6.1-sol")),
        ("chatgpt", None),
        ("local", Some("llama3.1:8b")),
        ("openrouter", Some("openai/gpt-6.1-sol")),
    ] {
        let c = reg.caps_for(id, m, None).unwrap();
        assert!(!c.streaming, "{id}");
        assert!(!c.pdf, "{id}");
        assert!(!c.native_budget, "{id}");
    }
    let s = store([("ai.deepseek.verified", json!({"deepseek-flash": {"engine": "codex"}}))]);
    assert!(
        !reg.caps_for("deepseek", Some("deepseek-flash"), Some(&s))
            .unwrap()
            .streaming
    );
}

#[test]
fn gives_openrouter_anthropic_native_pdfs_and_takes_vision_from_the_catalog() {
    let reg = ProviderRegistry::new();
    let of = |m: &str| reg.caps_for("openrouter", Some(m), None).unwrap();
    assert!(of("anthropic/claude-sonnet-5").pdf);
    assert!(of("anthropic/claude-sonnet-5").streaming);
    reg.set_catalog_models(
        "openrouter",
        &[
            json!({"id": "qwen/qwen3-vl", "vision": true}),
            json!({"id": "qwen/qwen3-coder", "vision": false}),
        ],
    )
    .unwrap();
    assert!(of("qwen/qwen3-vl").vision);
    assert!(!of("qwen/qwen3-coder").vision);
    assert!(!of("qwen/qwen3-coder").pdf);
}

#[test]
fn caps_for_returns_null_for_a_provider_that_does_not_exist() {
    assert_eq!(ProviderRegistry::new().caps_for("gemini", Some("x"), None), None);
}

// --- priceFor ---

/// A moment in November 2026, UTC, in milliseconds. 2026-11-09 is a Monday; 2026-11-14 a Saturday; 2026-11-15 a
/// Sunday; 2026-11-13 a Friday.
fn at(day: u32, hour: u32, minute: u32) -> i64 {
    Utc.with_ymd_and_hms(2026, 11, day, hour, minute, 0)
        .unwrap()
        .timestamp_millis()
}

#[test]
fn charges_nothing_per_token_on_the_plans_and_leaves_the_anthropic_keys_cost_to_the_engine() {
    let reg = ProviderRegistry::new();
    assert_eq!(reg.price_for("claude", Some("sonnet"), Some(at(9, 2, 0)), None), None);
    assert_eq!(
        reg.price_for("chatgpt", Some("gpt-6-luna"), Some(at(9, 2, 0)), None),
        None
    );
    assert_eq!(
        reg.price_for("anthropic", Some("claude-opus-5"), Some(at(9, 2, 0)), None),
        None
    );
}

#[test]
fn knows_deepseeks_peak_window_01_00_04_00_and_06_00_10_00_utc_monday_to_friday() {
    let peak = [
        at(9, 1, 0),
        at(9, 2, 30),
        at(9, 3, 59),
        at(9, 6, 0),
        at(9, 9, 59),
        at(13, 7, 0),
        at(10, 1, 0),
    ];
    let off = [
        at(9, 0, 59),
        at(9, 4, 0),
        at(9, 5, 59),
        at(9, 10, 0),
        at(9, 23, 0),
        at(14, 2, 0),
        at(15, 8, 0),
        at(14, 7, 0),
    ];
    for t in peak {
        assert!(is_deep_seek_peak(Some(t)), "{}", js::iso_from_ms(t));
    }
    for t in off {
        assert!(!is_deep_seek_peak(Some(t)), "{}", js::iso_from_ms(t));
    }
}

#[test]
fn halves_deepseeks_rates_off_peak() {
    let reg = ProviderRegistry::new();
    for m in ["deepseek-flash", "deepseek-v4-pro"] {
        let p = reg.price_for("deepseek", Some(m), Some(at(9, 2, 0)), None).unwrap();
        let o = reg.price_for("deepseek", Some(m), Some(at(9, 12, 0)), None).unwrap();
        assert_eq!(p.peak, Some(true), "{m}");
        assert_eq!(o.peak, Some(false), "{m}");
        for (peak_rate, off_rate) in [
            (p.input, o.input),
            (p.output, o.output),
            (p.cache_read, o.cache_read),
            (p.cache_write, o.cache_write),
        ] {
            assert!(peak_rate > 0.0, "{m}");
            assert_eq!(off_rate, peak_rate / 2.0, "{m}");
        }
    }
}

#[test]
fn prices_deepseek_at_its_published_rates_flash_0_30_in_1_20_out_at_peak_half_that_off_peak_pro_dearer() {
    let reg = ProviderRegistry::new();
    let price = |m: &str, t: i64| reg.price_for("deepseek", Some(m), Some(t), None).unwrap();
    let peak = price("deepseek-flash", at(9, 2, 0));
    assert_eq!(
        [peak.input, peak.output, peak.cache_read, peak.cache_write],
        [0.3, 1.2, 0.006, 0.3]
    );
    assert_eq!(price("deepseek-flash", at(9, 12, 0)).input, 0.15, "off-peak is half");
    let pro = price("deepseek-v4-pro", at(9, 2, 0));
    assert_eq!(
        [pro.input, pro.output, pro.cache_read, pro.cache_write],
        [1.32, 3.96, 0.044, 1.32]
    );
    assert!(pro.input > peak.input);
    assert_eq!(price("deepseek-flash[1m]", at(9, 2, 0)).input, 0.3);
}

#[test]
fn prices_the_openai_table_and_reads_openrouters_from_its_catalog() {
    let reg = ProviderRegistry::new();
    for m in ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.5"] {
        let p = reg.price_for("openai", Some(m), Some(at(9, 2, 0)), None).unwrap();
        assert!(p.input > 0.0 && p.output > 0.0, "{m}");
        assert_eq!(p.peak, None, "{m}");
    }
    let sonnet = |reg: &ProviderRegistry| {
        reg.price_for("openrouter", Some("anthropic/claude-sonnet-5"), Some(at(9, 2, 0)), None)
    };
    assert_eq!(sonnet(&reg), None);
    reg.set_catalog_models(
        "openrouter",
        &[json!({"id": "anthropic/claude-sonnet-5", "price": {"in": 3, "out": 15, "cacheRead": 0.3, "cacheWrite": 3.75}})],
    )
    .unwrap();
    let want = Price {
        input: 3.0,
        output: 15.0,
        cache_read: 0.3,
        cache_write: 3.75,
        peak: None,
    };
    assert_eq!(sonnet(&reg), Some(want));
    assert_eq!(
        serde_json::to_string(&want).unwrap(),
        r#"{"in":3.0,"out":15.0,"cacheRead":0.3,"cacheWrite":3.75,"peak":null}"#
    );
}

#[test]
fn makes_local_ai_free_unless_the_card_sets_a_price() {
    let reg = ProviderRegistry::new();
    let free = Price {
        input: 0.0,
        output: 0.0,
        cache_read: 0.0,
        cache_write: 0.0,
        peak: None,
    };
    assert_eq!(
        reg.price_for("local", Some("llama3.1:8b"), Some(at(9, 2, 0)), None),
        Some(free)
    );
    let s = store([("ai.local.price", json!({"in": 0.1, "out": 0.2}))]);
    assert_eq!(
        reg.price_for("local", Some("llama3.1:8b"), Some(at(9, 2, 0)), Some(&s)),
        Some(Price {
            input: 0.1,
            output: 0.2,
            cache_read: 0.1,
            cache_write: 0.1,
            peak: None
        })
    );
    // The card's price as the text a plain store holds, with rates written as text.
    let s = store([(
        "ai.local.price",
        json!(r#"{"in": "0.5", "out": " 2 ", "cacheRead": 0.05}"#),
    )]);
    assert_eq!(
        reg.price_for("local", None, None, Some(&s)),
        Some(Price {
            input: 0.5,
            output: 2.0,
            cache_read: 0.05,
            cache_write: 0.5,
            peak: None
        })
    );
}

#[test]
fn defaults_to_now() {
    let reg = ProviderRegistry::new();
    // The clock is read once before and once after, so a peak hour starting in between cannot fail this.
    let before = is_deep_seek_peak(None);
    let p = reg.price_for("deepseek", Some("deepseek-flash"), None, None).unwrap();
    let after = is_deep_seek_peak(None);
    assert!(p.peak == Some(before) || p.peak == Some(after));
}

#[test]
fn reads_a_missing_moment_null_as_a_running_turns_end_time_is_as_now_never_as_1970() {
    // The JS test moved the clock (mock timers). Here "now" is an argument of the two functions the public ones
    // call with the real clock.
    let reg = ProviderRegistry::new();
    let now = at(9, 2, 0);
    assert!(in_peak_window(&DEEPSEEK_PEAK, moment(None, now)));
    // 1970-01-01 00:00 was an off-peak Thursday: a missing moment read as that would say false.
    assert!(!in_peak_window(&DEEPSEEK_PEAK, 0));
    let flash = |at_ms: i64| reg.price_at("deepseek", Some("deepseek-flash"), at_ms, None).unwrap();
    assert_eq!(
        Some(flash(moment(None, now))),
        reg.price_for("deepseek", Some("deepseek-flash"), Some(now), None)
    );
    assert_eq!(flash(moment(None, now)).peak, Some(true));
    assert_eq!(flash(moment(None, at(9, 12, 0))).peak, Some(false));
    // A moment no date can hold is now too (the JS `new Date(NaN)`).
    assert_eq!(moment(Some(i64::MAX), now), now);
    assert_eq!(moment(Some(0), now), 0);
}

#[test]
fn takes_a_moment_as_a_date_or_as_milliseconds_date_now_the_stored_timestamps() {
    assert!(is_deep_seek_peak(Some(at(9, 2, 0))));
    assert!(!is_deep_seek_peak(Some(at(9, 12, 0))));
    // An ISO string (what the database stores) goes through `ms_from_iso`.
    assert!(is_deep_seek_peak(js::ms_from_iso(&js::iso_from_ms(at(9, 2, 0)))));
    assert!(is_deep_seek_peak(js::ms_from_iso("2026-11-09 02:00:00")));
    // A date value.
    let date = Utc.with_ymd_and_hms(2026, 11, 9, 12, 0, 0).unwrap();
    assert!(!is_deep_seek_peak(Some(date.timestamp_millis())));
}

// --- vendorFor ---

#[test]
fn is_the_maker_on_openrouter_and_the_provider_id_elsewhere() {
    assert_eq!(
        vendor_for("openrouter", Some("~anthropic/claude-sonnet-latest")).as_deref(),
        Some("anthropic")
    );
    assert_eq!(
        vendor_for("openrouter", Some("deepseek/deepseek-chat:free")).as_deref(),
        Some("deepseek")
    );
    assert_eq!(
        vendor_for("deepseek", Some("deepseek-flash")).as_deref(),
        Some("deepseek")
    );
    assert_eq!(vendor_for("claude-code", Some("sonnet")).as_deref(), Some("claude"));
}

#[test]
fn is_a_name_a_session_handle_can_carry_lower_case_only_letters_digits_dot_dash_and_underscore() {
    assert_eq!(
        vendor_for("openrouter", Some("Open AI/gpt-6")).as_deref(),
        Some("openai")
    );
    assert_eq!(vendor_for("openrouter", Some("a+b/c")).as_deref(), Some("ab"));
    assert_eq!(vendor_for("openrouter", Some("auto")).as_deref(), Some("openrouter"));
    assert_eq!(vendor_for("openrouter", Some("+++/x")).as_deref(), Some("openrouter"));
    assert_eq!(vendor_for("openrouter", None).as_deref(), Some("openrouter"));
    assert_eq!(vendor_for("nobody", Some("x")), None);
}

// --- checkKeySlot ---

#[test]
fn catches_a_claude_sign_in_token_pasted_as_an_api_key() {
    let r = check_key_slot("anthropic", &key(&["sk-ant-", "oat01-test-canary-0000"]));
    assert!(!r.ok);
    assert!(r.message.unwrap().to_lowercase().contains("sign-in token"));
}

#[test]
fn catches_keys_pasted_into_another_providers_slot() {
    let message = |id: &str, k: &str| check_key_slot(id, k).message.unwrap_or_default();
    let anthropic = key(&["sk-ant-", "api03-test-canary-0000"]);
    let openrouter = key(&["sk-or-", "v1-testcanary0000"]);
    assert!(message("openai", &anthropic).contains("Anthropic key"));
    assert!(message("openai", &openrouter).contains("OpenRouter"));
    assert!(message("deepseek", &openrouter).contains("OpenRouter"));
    assert!(message("anthropic", &openrouter).contains("OpenRouter"));
    assert!(message("openrouter", &anthropic).contains("Anthropic key"));
}

#[test]
fn a_deepseek_key_sk_and_32_lowercase_hex_is_refused_in_the_openai_and_local_ai_cards_so_it_never_travels_there() {
    let message = |id: &str, k: &str| check_key_slot(id, k).message.unwrap_or_default();
    let ds = key(&["sk-", &"0123456789abcdef".repeat(2)]);
    assert!(message("openai", &ds).contains("looks like a DeepSeek key"));
    assert!(message("local", &ds).contains("DeepSeek card"));
    assert!(check_key_slot("deepseek", &ds).ok);
    // OpenAI's own keys are never that shape: they still pass.
    assert!(check_key_slot("openai", &key(&["sk-", "proj-test-canary-00000000"])).ok);
    assert!(
        check_key_slot("openai", &key(&["sk-", &"0123456789ABCDEF".repeat(2)])).ok,
        "upper case isn't DeepSeek's"
    );
    assert!(
        check_key_slot("openai", &key(&["sk-", &"0123456789abcdef".repeat(2), "0"])).ok,
        "nor is a 33rd character"
    );
    // A legacy OpenAI key (48 characters with T3BlbkFJ in the middle) is refused in every other card.
    let legacy = key(&["sk-", "testcanary0000000000", "T3Blbk", "FJ", "testcanary0000000000"]);
    assert!(check_key_slot("openai", &legacy).ok);
    for id in ["deepseek", "openrouter", "anthropic", "local"] {
        assert!(message(id, &legacy).contains("OpenAI"), "{id}");
    }
}

#[test]
fn accepts_each_providers_own_key_shape() {
    let ok = |id: &str, parts: &[&str]| check_key_slot(id, &key(parts)).ok;
    assert!(ok("anthropic", &["sk-ant-", "api03-test-canary-0000"]));
    // Anthropic documents only the sk-ant- prefix; newer key kinds (personal, service account) needn't say api03.
    assert!(ok("anthropic", &["sk-ant-", "svc01-test-canary-00000000"]));
    assert!(ok("anthropic", &["sk-ant-", "test-canary-0000000000000000"]));
    assert!(!ok("anthropic", &["sk-ant-", "short"]), "too short to be a key");
    assert!(!ok("anthropic", &["sk-ant-", "api03-has space-0000000000"]));
    assert!(ok("openrouter", &["sk-or-", "v1-testcanary0000"]));
    assert!(ok("openai", &["sk-", "proj-test-canary-00000000"]));
    assert!(ok("deepseek", &["sk-", "testcanary0000000000000000"]));
    assert!(ok("local", &["anything-at-all"]));
    // Fitting is `{ ok: true, message: null }`.
    assert_eq!(
        serde_json::to_string(&check_key_slot("local", "anything-at-all")).unwrap(),
        r#"{"ok":true,"message":null}"#
    );
}

#[test]
fn refuses_an_empty_key_and_a_provider_that_takes_none() {
    let anthropic = key(&["sk-ant-", "api03-test-canary-0000"]);
    assert_eq!(
        check_key_slot("deepseek", "  ").message.as_deref(),
        Some("Paste a key first.")
    );
    assert_eq!(
        check_key_slot("claude", &anthropic).message.as_deref(),
        Some("The Claude plan signs in; it takes no API key.")
    );
    assert_eq!(
        check_key_slot("gemini", "x").message.as_deref(),
        Some("Tarsee doesn't know that AI.")
    );
    assert!(!check_key_slot("deepseek", "  ").ok && !check_key_slot("claude", &anthropic).ok);
    assert!(!check_key_slot("gemini", "x").ok);
}

#[test]
fn a_key_is_read_without_the_space_and_the_one_pair_of_quotes_around_it() {
    let anthropic = key(&["sk-ant-", "api03-test-canary-0000"]);
    assert!(check_key_slot("anthropic", &format!("  \"{anthropic}\"\n")).ok);
    assert!(check_key_slot("anthropic", &format!("'{anthropic}'")).ok);
    assert_eq!(
        check_key_slot("anthropic", "\"\"").message.as_deref(),
        Some("Paste a key first.")
    );
    assert_eq!(
        check_key_slot("anthropic", "no-such-shape").message.as_deref(),
        Some("This doesn't look like an Anthropic API key.")
    );
    // Only one quote comes off each side.
    assert_eq!(strip_one_quote_each_side("\"\"k'"), "\"k");
    assert_eq!(strip_one_quote_each_side("\""), "");
}

// --- runtime catalogs ---

#[test]
fn start_empty_and_only_take_the_names_the_registry_uses() {
    let reg = ProviderRegistry::new();
    assert!(reg.catalog_models("chatgpt-models").is_empty());
    let err = reg.set_catalog_models("claude", &[json!({"id": "x"})]).unwrap_err();
    assert_eq!(err.to_string(), "Not a runtime model catalog: claude");
    assert!(reg.set_catalog_models("nope", &[]).is_err());
}

#[test]
fn keeps_a_frozen_copy_skipping_entries_without_an_id() {
    let reg = ProviderRegistry::new();
    let mut list = vec![
        json!({"id": "a"}),
        json!({"label": "no id"}),
        json!(null),
        json!({"id": "b", "context": 4096}),
    ];
    reg.set_catalog_models("local-models", &list).unwrap();
    let got = reg.catalog_models("local-models");
    assert_eq!(got.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    // The catalog holds its own copy: a list changed afterwards changes nothing, and a list handed out earlier
    // stays as it was when the catalog is filled again.
    list.push(json!({"id": "c"}));
    assert_eq!(reg.catalog_models("local-models").len(), 2);
    reg.set_catalog_models("local-models", &[]).unwrap();
    assert_eq!(got.len(), 2);
    assert!(reg.catalog_models("local-models").is_empty());
}

#[test]
fn narrows_the_openai_table_to_what_the_key_lists_once_the_live_list_is_in() {
    let reg = ProviderRegistry::new();
    let resolve = |m: &str| reg.resolve_model_for("openai", Some(m), None);
    assert!(PROVIDERS.openai.models.len() >= 4);
    reg.set_catalog_models(
        "openai-models",
        &[
            json!({"id": "gpt-6-luna"}),
            json!({"id": "gpt-5.5"}),
            json!({"id": "whisper-1"}),
        ],
    )
    .unwrap();
    assert_eq!(
        resolve("gpt-6-astra").as_deref(),
        Some("gpt-6-luna"),
        "the default steps down to what the key can use"
    );
    assert_eq!(resolve("gpt-5.5").as_deref(), Some("gpt-5.5"));
    assert_eq!(
        resolve("whisper-1").as_deref(),
        Some("gpt-6-luna"),
        "not a chat model in the table"
    );
    assert_eq!(
        reg.models_for("openai")
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-6-luna", "gpt-5.5"]
    );
}

// --- Claude catalog ---

#[test]
fn is_todays_model_table() {
    let ids: Vec<&str> = CLAUDE_MODELS.iter().map(|m| m.id).collect();
    assert_eq!(
        PROVIDERS
            .claude
            .models
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ids
    );
    assert_eq!(
        PROVIDERS
            .anthropic
            .models
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ids
    );
    assert_eq!(PROVIDERS.claude.default_model, Some(get_recommended_model()));
    assert_eq!(PROVIDERS.claude.background_model, Some("haiku"));
    assert_eq!(PROVIDERS.claude.catalog, "claude");
}

// --- AI_PROVIDERS compatibility view (config/constants.js) ---

#[test]
fn keeps_the_claude_code_entry_exactly_as_it_was_and_adds_every_other_shipped_provider_by_its_stored_id() {
    assert_eq!(
        AI_PROVIDERS.keys().collect::<Vec<_>>(),
        ALL_IDS.map(|id| table().get(id).unwrap().storage_id)
    );
    let claude_code = AI_PROVIDERS.get("claude-code").unwrap();
    assert_eq!(
        *claude_code,
        AiProvider {
            id: "claude-code",
            name: "Claude Code (Agent)",
            env_key: None,
            default_model: Some(get_recommended_model()),
            base_url: None,
            no_key_required: true,
        }
    );
    // The same keys in the same order, as the JSON a route would send.
    assert_eq!(
        serde_json::to_string(claude_code).unwrap(),
        r#"{"id":"claude-code","name":"Claude Code (Agent)","envKey":null,"defaultModel":"sonnet","baseUrl":null,"noKeyRequired":true}"#
    );
    assert!(
        AI_PROVIDERS.get("claude").is_none(),
        "the Claude plan is stored as claude-code"
    );
    let deepseek = AI_PROVIDERS.get("deepseek").unwrap();
    assert_eq!(deepseek.env_key, Some("DEEPSEEK_API_KEY"));
    assert!(!deepseek.no_key_required);
    assert_eq!(deepseek.base_url, None, "no host is ever handed out");
    assert!(AI_PROVIDERS.iter().all(|p| p.base_url.is_none()));
    assert!(AI_PROVIDERS.get("local").unwrap().no_key_required);
}

// --- What the JS suite left to other files, or did not test ---

#[test]
fn hidden_providers_cannot_be_selected_and_hiding_replaces_what_was_hidden_before() {
    let reg = ProviderRegistry::new();
    reg.hide_providers(&["local", "nope"]);
    assert!(!reg.is_shipped("local"));
    assert!(!reg.is_shipped(" LOCAL "));
    assert_eq!(
        reg.shipped_providers().iter().map(|p| p.id).collect::<Vec<_>>(),
        ["claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek"]
    );
    let chosen = store([("ai.activeProvider", json!("local"))]);
    assert_eq!(reg.active_provider_id(Some(&chosen), &no_env()), "claude");
    // An alias hides the provider it names; a new set replaces the old one.
    reg.hide_providers(&["claude-code"]);
    assert!(reg.is_shipped("local"));
    assert!(!reg.is_shipped("claude"));
    reg.hide_providers(&[]);
    assert_eq!(reg.shipped_providers().len(), 7);
}

#[test]
fn local_ai_is_hidden_only_on_railway_with_no_address_set() {
    let railway = env([("RAILWAY_PROJECT_ID", "p-1")]);
    assert!(!local_ai_hidden_here(&no_env(), None), "self-hosted always offers it");
    assert!(!local_ai_hidden_here(&env([("RAILWAY_PROJECT_ID", "  ")]), None));
    assert!(local_ai_hidden_here(&railway, None));
    assert!(local_ai_hidden_here(&railway, Some(&store([]))));
    assert!(local_ai_hidden_here(
        &railway,
        Some(&store([("ai.local.baseUrl", json!("   "))]))
    ));
    assert!(local_ai_hidden_here(
        &railway,
        Some(&store([("ai.local.baseUrl", json!(7))]))
    ));
    assert!(!local_ai_hidden_here(
        &railway,
        Some(&store([("ai.local.baseUrl", json!("http://10.0.0.5:8080/v1"))]))
    ));
    let with_url = env([
        ("RAILWAY_PROJECT_ID", "p-1"),
        ("TARSEE_LOCAL_AI_URL", "http://models.internal:8080/v1"),
    ]);
    assert!(!local_ai_hidden_here(&with_url, None));
}

#[test]
fn each_app_has_a_registry_of_its_own() {
    let a = test_app();
    let b = test_app();
    let in_a = ProviderRegistry::of(&a);
    in_a.set_catalog_models("local-models", &[json!({"id": "only-in-a"})])
        .unwrap();
    in_a.hide_providers(&["local"]);
    // The same registry every time for one app, and another one for another app.
    assert_eq!(ProviderRegistry::of(&a).catalog_models("local-models").len(), 1);
    assert!(!ProviderRegistry::of(&a).is_shipped("local"));
    assert!(ProviderRegistry::of(&b).catalog_models("local-models").is_empty());
    assert!(ProviderRegistry::of(&b).is_shipped("local"));
}

#[test]
fn a_tier_word_is_one_of_the_seven_with_or_without_the_1m_suffix() {
    for word in TIER_WORDS {
        assert!(is_tier_word(word), "{word}");
        assert!(is_tier_word(&format!(" {}[1M] ", word.to_uppercase())), "{word}");
    }
    for not in ["", "opus-5", "claude-opus-5", "gpt-6-luna", "opus [1m]", "[1m]"] {
        assert!(!is_tier_word(not), "{not}");
    }
}

#[test]
fn verified_models_are_the_owners_own_with_an_engine_the_provider_has() {
    assert!(verified_models("gemini", None).is_empty());
    assert!(verified_models("openrouter", None).is_empty());
    let s = store([
        (
            "ai.openrouter.verified",
            json!({
                "b/second": {"engine": "codex", "at": "2026-11-09", "efforts": ["low"]},
                "a/first": {"engine": "claude-code"},
                "x/other-engine": {"engine": "gemini-cli"},
                "x/no-engine": {},
                "x/not-an-object": "codex",
                "x/a-list": ["codex"],
            }),
        ),
        ("ai.chatgpt.verified", json!({"gpt-6-luna": {"engine": "claude-code"}})),
        ("ai.local.verified", json!([{"engine": "codex"}])),
    ]);
    let own = verified_models("openrouter", Some(&s));
    // In the order they were saved.
    assert_eq!(own.keys().collect::<Vec<_>>(), ["b/second", "a/first"]);
    assert_eq!(own["b/second"]["efforts"], json!(["low"]));
    assert!(
        verified_models("chatgpt", Some(&s)).is_empty(),
        "ChatGPT has no Claude Code engine"
    );
    assert!(
        verified_models("local", Some(&s)).is_empty(),
        "a list is not a map of models"
    );
}

#[test]
fn a_runtime_catalogs_row_is_read_leniently_and_serialises_as_the_javascript_row() {
    let reg = ProviderRegistry::new();
    reg.set_catalog_models(
        "openrouter",
        &[
            json!({
                "id": "  maker/model  ", "label": " A Model ", "vendor": "maker", "context": "4096",
                "efforts": ["low", 7, "high"], "vision": true, "pdf": "yes",
                "price": {"in": "1.5", "out": 3, "cacheWrite": -1}, "tier": "opus", "default": true, "free": 1,
            }),
            json!({"id": "bare", "tier": "top", "context": -5, "price": {"in": 1}}),
            json!("just-a-string"),
            json!({"id": 7}),
            json!({"id": "   "}),
        ],
    )
    .unwrap();
    let rows = reg.catalog_models("openrouter");
    assert_eq!(rows.len(), 2);
    assert_eq!(
        serde_json::to_value(&rows[0]).unwrap(),
        json!({
            "id": "maker/model", "label": "A Model", "vendor": "maker", "context": 4096,
            "efforts": ["low", "high"], "vision": true, "pdf": null,
            "price": {"in": 1.5, "out": 3.0, "cacheRead": 1.5, "cacheWrite": 1.5}, "tier": "opus", "default": true,
            "free": false,
        })
    );
    assert_eq!(
        serde_json::to_string(&rows[1]).unwrap(),
        r#"{"id":"bare","label":"bare","vendor":null,"context":null,"efforts":null,"vision":null,"pdf":null,"price":null,"tier":null,"default":false,"free":false}"#
    );
    // Local AI's rows carry what the server said, only where it said it.
    reg.set_local_models(
        &[
            json!("by-id"),
            json!({"id": "sized", "label": "Sized", "serverContext": "8192"}),
        ],
        None,
    );
    let local = reg.catalog_models("local-models");
    assert_eq!(
        serde_json::to_value(&local[1]).unwrap(),
        json!({
            "id": "sized", "label": "Sized", "vendor": null, "context": 8192, "efforts": null, "vision": null,
            "pdf": null, "price": null, "tier": null, "default": false, "free": false, "serverContext": 8192,
        })
    );
    assert_eq!((local[0].id.as_str(), local[0].context), ("by-id", Some(128_000)));
}

#[test]
fn the_table_rows_carry_the_prices_and_deepseeks_peak_hours() {
    let flash = &PROVIDERS.deepseek.models[0];
    assert_eq!(
        serde_json::to_value(flash.price).unwrap(),
        json!({
            "in": 0.3, "out": 1.2, "cacheRead": 0.006, "cacheWrite": 0.3,
            "peak": {"days": [1, 2, 3, 4, 5], "hoursUtc": [[1, 4], [6, 10]], "offPeakFactor": 0.5},
        })
    );
    assert_eq!(PROVIDERS.openai.models[2].price, Some(rates(0.1, 0.5, 0.01, 0.125)));
    assert_eq!(PROVIDERS.openai.tier("haiku"), Some("gpt-6-luna"));
    assert_eq!(PROVIDERS.chatgpt.tier("haiku"), None);
    let opus = PROVIDERS.claude.models.iter().find(|m| m.id == "opus").unwrap();
    assert!(opus.alias);
    assert_eq!(
        (opus.tier.as_deref(), opus.context, opus.price),
        (Some("opus"), Some(1_000_000), None)
    );
}

#[test]
fn engines_and_kinds_are_written_as_the_javascript_strings() {
    assert_eq!(serde_json::to_string(&Engine::ClaudeCode).unwrap(), r#""claude-code""#);
    assert_eq!(serde_json::from_str::<Engine>(r#""codex""#).unwrap(), Engine::Codex);
    assert_eq!(Engine::from_id("claude-code"), Some(Engine::ClaudeCode));
    assert_eq!(Engine::from_id("gemini-cli"), None);
    assert_eq!(Engine::Codex.to_string(), "codex");
    assert_eq!(
        serde_json::to_string(&ProviderKind::Subscription).unwrap(),
        r#""subscription""#
    );
    assert_eq!(ProviderKind::Local.to_string(), "local");
}

#[test]
fn numbers_in_settings_are_read_as_javascript_reads_them() {
    assert_eq!(positive_int(Some(&json!(4096))), Some(4096));
    assert_eq!(positive_int(Some(&json!(" 4096 "))), Some(4096));
    assert_eq!(positive_int(Some(&json!(2.5))), Some(3));
    assert_eq!(positive_int(Some(&json!("1e3"))), Some(1000));
    assert_eq!(positive_int(Some(&json!("0x10"))), Some(16));
    for not in [
        json!(0),
        json!(-1),
        json!(""),
        json!("abc"),
        json!("12px"),
        json!(true),
        json!(null),
        json!([5]),
    ] {
        assert_eq!(positive_int(Some(&not)), None, "{not}");
    }
    assert_eq!(positive_int(None), None);
    assert!(js_to_number("inf").is_nan() && js_to_number("nan").is_nan() && js_to_number("-0x10").is_nan());
    assert_eq!(js_to_number("  -Infinity "), f64::NEG_INFINITY);
    assert_eq!(js_to_number(".5"), 0.5);
    assert_eq!(js_to_number("5."), 5.0);
    assert_eq!(context_from_label("200K"), 200_000);
    assert_eq!(context_from_label("2 m"), 2_000_000);
    assert_eq!(context_from_label("lots"), 1_000_000);
}
