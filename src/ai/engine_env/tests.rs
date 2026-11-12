//! Port of test/engine-env.test.js: credential isolation for the agent engines (design 4.5 R1 to R10): each
//! provider's turn gets exactly its own credential and nothing else. The server's environment here is full of canaries
//! (every credential, Claude sign-in variable, Tarsee secret and Railway provider key a host might have set), and the
//! vault offers a CODEX_API_KEY next to a benign SCRIPT_KEY. No canary may reach any engine, except the operator's
//! Claude sign-in variables on the Claude plan. Also: the test-only base-URL seam is inert outside NODE_ENV=test and
//! off loopback, a missing key refuses the turn, the per-provider homes, the settings-file guards for both engines,
//! and that the module agrees with the provider registry.
//!
//! The JS matrix ran on the registry's real entries. Until the registry (package A1) is merged, [`registry`] below is
//! a copy of its entries' values as `provider-registry.js` has them; the lead swaps it for A1's entries at merge.
//! Every key and token here is an obvious fake, built from parts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;

use super::*;
use crate::testkit::tmp_dir;

// --- The registry's entries (a copy of provider-registry.js's values) --------------------------------------------

struct Fixture {
    entry: ProviderEntry,
    kind: &'static str,
    storage_id: &'static str,
}

fn slot(pattern: &str, message: &str) -> WrongSlot {
    WrongSlot {
        re: Regex::new(pattern).unwrap(),
        message: message.to_string(),
    }
}

fn claude_token() -> WrongSlot {
    slot(
        "(?i)^sk-ant-oat",
        "This is a Claude sign-in token, not an API key. Create an API key in the Anthropic Console instead.",
    )
}
fn anthropic_key() -> WrongSlot {
    slot(
        "(?i)^sk-ant-",
        "This is an Anthropic key. Paste it in the Anthropic API key card.",
    )
}
fn openrouter_key() -> WrongSlot {
    slot(
        "(?i)^sk-or-",
        "This is an OpenRouter key. Paste it in the OpenRouter card.",
    )
}
fn openai_key() -> WrongSlot {
    slot(
        "(?i:^sk-(proj|svcacct|admin)-|^sk-[a-z0-9]{20}t3blbkfj[a-z0-9]{20}$)",
        "This is an OpenAI key. Paste it in the OpenAI API key card.",
    )
}
fn deepseek_key() -> WrongSlot {
    slot(
        "^sk-[0-9a-f]{32}$",
        "This looks like a DeepSeek key. Paste it in the DeepSeek card.",
    )
}

fn tiers(fable: &str, opus: &str, sonnet: &str, haiku: &str) -> Tiers {
    Tiers {
        fable: Some(fable.into()),
        opus: Some(opus.into()),
        sonnet: Some(sonnet.into()),
        haiku: Some(haiku.into()),
    }
}

fn models(rows: &[(&str, f64)]) -> Vec<EntryModel> {
    rows.iter()
        .map(|(id, context)| EntryModel {
            id: id.to_string(),
            context: Some(*context),
        })
        .collect()
}

fn hosts(rows: &[(&str, &str)]) -> BTreeMap<String, String> {
    rows.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn claude_models() -> Vec<EntryModel> {
    models(&[
        ("opus", 1e6),
        ("sonnet", 1e6),
        ("haiku", 2e5),
        ("fable", 1e6),
        ("claude-fable-5-1", 1e6),
        ("claude-opus-5", 1e6),
        ("claude-sonnet-5", 1e6),
        ("claude-haiku-4-5", 2e5),
    ])
}

const PRO: &str = "deepseek-v4-pro";
const FLASH: &str = "deepseek-flash";
const OR_OPUS: &str = "~anthropic/claude-opus-latest";
const OR_SONNET: &str = "~anthropic/claude-sonnet-latest";
const OR_HAIKU: &str = "~anthropic/claude-haiku-latest";

/// PROVIDER_IDS, in the registry's order.
const PROVIDER_IDS: [&str; 7] = [
    "claude",
    "anthropic",
    "chatgpt",
    "openai",
    "openrouter",
    "deepseek",
    "local",
];

fn registry() -> BTreeMap<&'static str, Fixture> {
    let engines = |list: &[&str]| Some(list.iter().map(|e| e.to_string()).collect());
    let mut r = BTreeMap::new();
    r.insert(
        "claude",
        Fixture {
            kind: "subscription",
            storage_id: "claude-code",
            entry: ProviderEntry {
                id: "claude".into(),
                label: Some("Claude plan".into()),
                engines: engines(&[CLAUDE_CODE]),
                models: claude_models(),
                tiers: tiers("fable", "opus", "sonnet", "haiku"),
                default_model: Some("sonnet".into()),
                ..ProviderEntry::default()
            },
        },
    );
    r.insert(
        "anthropic",
        Fixture {
            kind: "key",
            storage_id: "anthropic",
            entry: ProviderEntry {
                id: "anthropic".into(),
                label: Some("Anthropic API key".into()),
                engines: engines(&[CLAUDE_CODE]),
                env_key: Some("ANTHROPIC_API_KEY".into()),
                base_url: hosts(&[(CLAUDE_CODE, "https://api.anthropic.com")]),
                wrong_slot: vec![claude_token(), openrouter_key(), openai_key()],
                models: claude_models(),
                tiers: tiers("fable", "opus", "sonnet", "haiku"),
                default_model: Some("sonnet".into()),
            },
        },
    );
    r.insert(
        "chatgpt",
        Fixture {
            kind: "subscription",
            storage_id: "chatgpt",
            entry: ProviderEntry {
                id: "chatgpt".into(),
                label: Some("ChatGPT plan".into()),
                engines: engines(&[CODEX]),
                ..ProviderEntry::default()
            },
        },
    );
    r.insert(
        "openai",
        Fixture {
            kind: "key",
            storage_id: "openai",
            entry: ProviderEntry {
                id: "openai".into(),
                label: Some("OpenAI API key".into()),
                engines: engines(&[CODEX]),
                env_key: Some("OPENAI_API_KEY".into()),
                base_url: hosts(&[(CODEX, "https://api.openai.com/v1")]),
                wrong_slot: vec![claude_token(), anthropic_key(), openrouter_key(), deepseek_key()],
                models: models(&[
                    ("gpt-6-astra", 1_050_000.0),
                    ("gpt-6.1-sol", 1_050_000.0),
                    ("gpt-6-luna", 1_050_000.0),
                    ("gpt-5.5", 1_050_000.0),
                ]),
                tiers: tiers("gpt-6-astra", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"),
                default_model: Some("gpt-6.1-sol".into()),
            },
        },
    );
    r.insert(
        "openrouter",
        Fixture {
            kind: "key",
            storage_id: "openrouter",
            entry: ProviderEntry {
                id: "openrouter".into(),
                label: Some("OpenRouter".into()),
                engines: engines(&[CLAUDE_CODE, CODEX]),
                env_key: Some("OPENROUTER_API_KEY".into()),
                base_url: hosts(&[
                    (CLAUDE_CODE, "https://openrouter.ai/api"),
                    (CODEX, "https://openrouter.ai/api/v1"),
                ]),
                wrong_slot: vec![claude_token(), anthropic_key(), openai_key()],
                models: Vec::new(),
                tiers: tiers(OR_OPUS, OR_OPUS, OR_SONNET, OR_HAIKU),
                default_model: Some(OR_SONNET.into()),
            },
        },
    );
    r.insert(
        "deepseek",
        Fixture {
            kind: "key",
            storage_id: "deepseek",
            entry: ProviderEntry {
                id: "deepseek".into(),
                label: Some("DeepSeek".into()),
                engines: engines(&[CLAUDE_CODE, CODEX]),
                env_key: Some("DEEPSEEK_API_KEY".into()),
                base_url: hosts(&[
                    (CLAUDE_CODE, "https://api.deepseek.com/anthropic"),
                    (CODEX, "https://api.deepseek.com"),
                ]),
                wrong_slot: vec![claude_token(), anthropic_key(), openrouter_key(), openai_key()],
                models: models(&[(FLASH, 1e6), (PRO, 1e6)]),
                tiers: tiers(PRO, PRO, FLASH, FLASH),
                default_model: Some(FLASH.into()),
            },
        },
    );
    r.insert(
        "local",
        Fixture {
            kind: "local",
            storage_id: "local",
            entry: ProviderEntry {
                id: "local".into(),
                label: Some("Local AI".into()),
                engines: engines(&[CODEX]),
                env_key: Some("TARSEE_LOCAL_AI_KEY".into()),
                wrong_slot: vec![
                    claude_token(),
                    anthropic_key(),
                    openrouter_key(),
                    openai_key(),
                    deepseek_key(),
                ],
                ..ProviderEntry::default()
            },
        },
    );
    r
}

/// `PROVIDERS[id]`.
fn p(id: &str) -> ProviderEntry {
    registry().remove(id).unwrap().entry
}

// --- The canaries ----------------------------------------------------------------------------------------------

/// The operator's Claude sign-in variables: `claude setup-token`'s token, or a refresh-token login with its scopes
/// and client id. They go back on the Claude plan, and nowhere else.
const PLAN_NAMES: [&str; 4] = [
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// Every credential a host might have set, each with a value that names it.
const CANARY_NAMES: [&str; 40] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "ENCRYPTION_KEY",
    "SETUP_PASSWORD",
    "TARSEE_API_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    // and the rest of what R2 strips
    "TARSEE_LOCAL_AI_KEY",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_USE_VERTEX",
    "CODEX_HOME",
    "CODEX_ACCESS_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "TARSEE_PROVIDER_KEY",
    "TARSEE_CHATGPT_ACCESS_TOKEN",
    "TARSEE_MCP_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    // the Claude sign-in and host variables the pinned CLI reads besides CLAUDE_CODE_OAUTH_TOKEN
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_LOCAL_OAUTH_API_BASE",
    "CLAUDE_LOCAL_OAUTH_APPS_BASE",
    "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
    "CLAUDE_TRUSTED_DEVICE_TOKEN",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
];

fn canary(name: &str) -> String {
    format!("sk-{}-{name}", "test-canary")
}

const BENIGN: [(&str, &str); 4] = [
    ("PATH", "/usr/local/bin:/usr/bin"),
    ("HOME", "/home/node"),
    ("TARSEE_TIMEZONE", "UTC"),
    ("LANG", "C.UTF-8"),
];

/// The server's environment: the benign variables, every canary, then `extra` (`None` unsets a name).
fn server_env_with(extra: &[(&str, Option<&str>)]) -> Env {
    let env = Env::from_pairs(BENIGN);
    for name in CANARY_NAMES {
        env.set(name, canary(name));
    }
    for (name, value) in extra {
        match value {
            Some(value) => env.set(*name, *value),
            None => {
                env.remove(name);
            }
        }
    }
    env
}

fn server_env() -> Env {
    server_env_with(&[])
}

fn vault() -> EnvMap {
    map(&[
        ("CODEX_API_KEY", &format!("sk-{}", "test-canary-vault-CODEX_API_KEY")),
        ("SCRIPT_KEY", "script-key-from-the-vault"),
    ])
}

fn map(pairs: &[(&str, &str)]) -> EnvMap {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn env_of(pairs: &[(&str, &str)]) -> Env {
    Env::from_pairs(pairs.iter().copied())
}

/// `path.join(os.tmpdir(), "tarsee-engine-env-state")`: a state folder that is never made.
fn state() -> PathBuf {
    normalize_path(Path::new("/srv/tarsee-engine-env-state"))
}

fn in_state(name: &str) -> String {
    path_string(&state().join(name))
}

fn key(id: &str) -> Option<String> {
    let rest = match id {
        "anthropic" => "test-own-anthropic-key",
        "deepseek" => "test-own-deepseek-key",
        "openrouter" => "or-v1-test-own-openrouter-key",
        "openai" => "test-own-openai-key",
        "local" => "test-own-local-key",
        _ => return None,
    };
    Some(format!("sk-{rest}"))
}

const MCP: &str = "mcp-test-token-0123456789";

/// What counts as a credential-shaped variable for the exactness checks: deliberately wider than AUTH_ENV_RE, so a
/// pin, a header or a config dir that appears unasked is caught too.
fn cred_of(env: &EnvMap) -> EnvMap {
    let shaped = Regex::new(
        "^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|OPENROUTER_|DEEPSEEK_|AWS_|ENCRYPTION_KEY$|SETUP_PASSWORD$|TARSEE_(PROVIDER_KEY|MCP_TOKEN|CHATGPT_ACCESS_TOKEN|API_TOKEN|LOCAL_AI_KEY)$)",
    )
    .unwrap();
    env.iter()
        .filter(|(k, _)| shaped.is_match(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn canary_values(env: &EnvMap) -> Vec<String> {
    env.iter()
        .filter(|(_, v)| v.contains("canary"))
        .map(|(k, _)| k.clone())
        .collect()
}

fn plan_canaries() -> EnvMap {
    PLAN_NAMES.iter().map(|n| (n.to_string(), canary(n))).collect()
}

/// `claudeEnvFor(P[id], { env: serverEnv(), vaultEnv: VAULT, costSaver: {}, stateDir: STATE, key: KEYS[id], ...opts })`
fn cc(id: &str, tweak: impl FnOnce(&mut ClaudeEnvOpts)) -> Result<EnvMap, EngineEnvError> {
    let mut opts = ClaudeEnvOpts {
        env: server_env(),
        vault_env: vault(),
        cost_saver: Some(EnvMap::new()),
        state_dir: Some(state()),
        key: key(id),
        ..ClaudeEnvOpts::default()
    };
    tweak(&mut opts);
    claude_env_for(&p(id), &opts)
}

/// `codexEnvFor(P[id], { env: serverEnv(), vaultEnv: VAULT, stateDir: STATE, key: KEYS[id], mcpToken: MCP, ...opts })`
fn cx(id: &str, tweak: impl FnOnce(&mut CodexEnvOpts)) -> Result<EnvMap, EngineEnvError> {
    let mut opts = CodexEnvOpts {
        env: server_env(),
        vault_env: vault(),
        state_dir: Some(state()),
        key: key(id),
        mcp_token: Some(MCP.into()),
        ..CodexEnvOpts::default()
    };
    tweak(&mut opts);
    codex_env_for(&p(id), &opts)
}

fn none<T>(_: &mut T) {}

fn gateway_flags() -> Vec<(&'static str, &'static str)> {
    vec![
        ("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1"),
        ("CLAUDE_CODE_ATTRIBUTION_HEADER", "0"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
    ]
}

fn code_of<T: std::fmt::Debug>(result: Result<T, EngineEnvError>) -> Option<CredentialCode> {
    result.expect_err("the call should have been refused").code()
}

// --- engine-env canary matrix: exactly the provider's own credential, on every path ------------------------------

#[test]
fn claude_plan_every_anthropic_stripped_the_operators_claude_sign_in_variables_go_back_nothing_else() {
    let mut names = PLAN_SIGN_IN_NAMES.to_vec();
    names.sort();
    assert_eq!(names, PLAN_NAMES);
    let env = cc("claude", |o| o.key = None).unwrap();
    assert_eq!(cred_of(&env), plan_canaries());
    assert!(env.keys().all(|k| !k.starts_with("ANTHROPIC_")));
    assert_eq!(env["SCRIPT_KEY"], vault()["SCRIPT_KEY"]);
}

#[test]
fn claude_plan_no_sign_in_variable_when_the_operator_didnt_set_one_even_when_the_vault_offers_it() {
    let unset: Vec<(&str, Option<&str>)> = PLAN_NAMES.iter().map(|n| (*n, None)).collect();
    let mut vault_env = vault();
    vault_env.insert(
        "CLAUDE_CODE_OAUTH_TOKEN".into(),
        format!("sk-{}", "test-canary-vault-oauth"),
    );
    vault_env.insert(
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN".into(),
        format!("sk-{}", "test-canary-vault-refresh"),
    );
    vault_env.insert("ANTHROPIC_API_KEY".into(), format!("sk-{}", "test-canary-vault-ant"));
    let env = claude_env_for(
        &p("claude"),
        &ClaudeEnvOpts {
            env: server_env_with(&unset),
            cost_saver: Some(EnvMap::new()),
            state_dir: Some(state()),
            vault_env,
            ..ClaudeEnvOpts::default()
        },
    )
    .unwrap();
    assert_eq!(cred_of(&env), EnvMap::new());
    assert_eq!(canary_values(&env), Vec::<String>::new());
    assert_eq!(env["SCRIPT_KEY"], vault()["SCRIPT_KEY"]);
}

#[test]
fn claude_plan_a_refresh_token_login_goes_back_as_the_operator_set_it() {
    let refresh = format!("sk-{}", "test-canary-refresh");
    let login = [
        ("CLAUDE_CODE_OAUTH_TOKEN", None),
        ("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", Some(refresh.as_str())),
        ("CLAUDE_CODE_OAUTH_SCOPES", Some("user:inference user:profile")),
        ("CLAUDE_CODE_OAUTH_CLIENT_ID", None),
    ];
    let env = claude_env_for(
        &p("claude"),
        &ClaudeEnvOpts {
            env: server_env_with(&login),
            cost_saver: Some(EnvMap::new()),
            state_dir: Some(state()),
            ..ClaudeEnvOpts::default()
        },
    )
    .unwrap();
    assert_eq!(
        cred_of(&env),
        map(&[
            ("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", &refresh),
            ("CLAUDE_CODE_OAUTH_SCOPES", "user:inference user:profile"),
        ])
    );
}

#[test]
fn claude_plan_its_id_or_the_storage_id_claude_code_is_the_same_provider() {
    let opts = ClaudeEnvOpts {
        env: server_env(),
        cost_saver: Some(EnvMap::new()),
        ..ClaudeEnvOpts::default()
    };
    for id in ["claude", "claude-code"] {
        assert_eq!(cred_of(&claude_env_for(id, &opts).unwrap()), plan_canaries(), "{id}");
        let entry = ProviderEntry {
            id: id.into(),
            ..ProviderEntry::default()
        };
        assert_eq!(
            cred_of(&claude_env_for(&entry, &opts).unwrap()),
            plan_canaries(),
            "{{id: {id}}}"
        );
    }
}

#[test]
fn anthropic_its_own_home_and_its_own_key_nothing_else() {
    let env = cc("anthropic", none).unwrap();
    assert_eq!(
        cred_of(&env),
        map(&[
            ("CLAUDE_CONFIG_DIR", &in_state(".claude-home-anthropic")),
            ("ANTHROPIC_API_KEY", &key("anthropic").unwrap()),
        ])
    );
}

#[test]
fn deepseek_on_claude_code_own_home_constant_host_own_key_as_the_bearer_token_every_model_pinned_to_its_own_ids() {
    let env = cc("deepseek", none).unwrap();
    let flash = format!("{FLASH}[1m]");
    let pro = format!("{PRO}[1m]");
    let mut want = map(&[
        ("CLAUDE_CONFIG_DIR", &in_state(".claude-home-deepseek")),
        ("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic"),
        ("ANTHROPIC_AUTH_TOKEN", &key("deepseek").unwrap()),
        ("ANTHROPIC_API_KEY", ""),
        ("ANTHROPIC_MODEL", &flash),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", &pro),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", &flash),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", &flash),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL", &pro),
        ("ANTHROPIC_SMALL_FAST_MODEL", &flash),
        ("CLAUDE_CODE_SUBAGENT_MODEL", &flash),
        ("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "1000000"),
        ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "1000000"),
    ]);
    want.extend(map(&gateway_flags()));
    assert_eq!(cred_of(&env), want);
}

#[test]
fn deepseek_on_claude_code_the_turns_model_is_the_main_pin_with_or_without_the_1m_the_design_sends() {
    let pro = format!("{PRO}[1m]");
    for model in [PRO.to_string(), format!("{PRO}[1m]"), format!("{PRO}[1M]")] {
        let env = cc("deepseek", |o| o.model = Some(model.clone())).unwrap();
        assert_eq!(env["ANTHROPIC_MODEL"], pro, "{model}");
        assert_eq!(env["CLAUDE_CODE_SUBAGENT_MODEL"], pro, "{model}");
        assert_eq!(
            env["ANTHROPIC_DEFAULT_OPUS_MODEL"], pro,
            "{model}: the tier pins say the same as the main pin"
        );
        assert_eq!(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"], format!("{FLASH}[1m]"), "{model}");
        assert_eq!(
            env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "1000000",
            "{model}: the context pins are kept"
        );
        assert_eq!(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "1000000", "{model}");
    }
}

#[test]
fn openrouter_on_claude_code_own_home_constant_host_own_key_own_pins_the_title_header() {
    let env = cc("openrouter", |o| o.context_tokens = Some(200_000.0)).unwrap();
    let mut want = map(&[
        ("CLAUDE_CONFIG_DIR", &in_state(".claude-home-openrouter")),
        ("ANTHROPIC_BASE_URL", "https://openrouter.ai/api"),
        ("ANTHROPIC_AUTH_TOKEN", &key("openrouter").unwrap()),
        ("ANTHROPIC_API_KEY", ""),
        ("ANTHROPIC_MODEL", OR_SONNET),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", OR_OPUS),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", OR_SONNET),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", OR_HAIKU),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL", OR_OPUS),
        ("ANTHROPIC_SMALL_FAST_MODEL", OR_HAIKU),
        ("CLAUDE_CODE_SUBAGENT_MODEL", OR_SONNET),
        ("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "200000"),
        ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "200000"),
        ("ANTHROPIC_CUSTOM_HEADERS", "X-OpenRouter-Title: Tarsee"),
    ]);
    want.extend(map(&gateway_flags()));
    assert_eq!(cred_of(&env), want);
}

#[test]
fn openrouter_on_claude_code_a_1m_models_pin_carries_1m_and_so_does_every_pin_naming_the_same_model() {
    let env = cc("openrouter", |o| o.context_tokens = Some(1_000_000.0)).unwrap();
    let sonnet_1m = format!("{OR_SONNET}[1m]");
    assert_eq!(env["ANTHROPIC_MODEL"], sonnet_1m);
    assert_eq!(env["CLAUDE_CODE_SUBAGENT_MODEL"], sonnet_1m);
    assert_eq!(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], sonnet_1m);
    assert_eq!(
        env["ANTHROPIC_DEFAULT_OPUS_MODEL"], OR_OPUS,
        "a model whose window isn't known gets no suffix"
    );
    assert_eq!(env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "1000000");
}

#[test]
fn openrouter_on_claude_code_the_owners_title_and_referer_go_in_as_headers_and_cant_inject_another_header() {
    let env = cc("openrouter", |o| {
        o.app_title = Some("My Bot\r\nX-Evil: 1".into());
        o.referer = Some("https://example.test/\nX-Evil: 2".into());
    })
    .unwrap();
    assert_eq!(
        env["ANTHROPIC_CUSTOM_HEADERS"],
        "X-OpenRouter-Title: My Bot X-Evil: 1\nHTTP-Referer: https://example.test/ X-Evil: 2"
    );
}

#[test]
fn chatgpt_device_sign_in_on_codex_its_own_home_and_the_mcp_token_nothing_else() {
    let env = cx("chatgpt", |o| o.key = None).unwrap();
    assert_eq!(
        cred_of(&env),
        map(&[("CODEX_HOME", &in_state(".codex-home")), ("TARSEE_MCP_TOKEN", MCP)])
    );
}

#[test]
fn openai_on_codex_the_key_home_and_the_mcp_token_the_key_itself_goes_only_through_the_engines_own_variable() {
    let env = cx("openai", none).unwrap();
    assert_eq!(
        cred_of(&env),
        map(&[("CODEX_HOME", &in_state(".codex-home-keys")), ("TARSEE_MCP_TOKEN", MCP)])
    );
    assert!(
        !env.values().any(|v| *v == key("openai").unwrap()),
        "the openai key is nowhere in the environment"
    );
}

fn key_provider_on_codex(id: &str) {
    let env = cx(id, none).unwrap();
    assert_eq!(
        cred_of(&env),
        map(&[
            ("CODEX_HOME", &in_state(".codex-home-keys")),
            ("TARSEE_MCP_TOKEN", MCP),
            ("TARSEE_PROVIDER_KEY", &key(id).unwrap()),
        ]),
        "{id}"
    );
}

#[test]
fn openrouter_on_codex_the_key_home_the_mcp_token_and_its_own_key_as_tarsee_provider_key() {
    key_provider_on_codex("openrouter");
}

#[test]
fn deepseek_on_codex_the_key_home_the_mcp_token_and_its_own_key_as_tarsee_provider_key() {
    key_provider_on_codex("deepseek");
}

#[test]
fn local_on_codex_the_key_home_the_mcp_token_and_its_own_key_as_tarsee_provider_key() {
    key_provider_on_codex("local");
}

#[test]
fn local_on_codex_without_a_key_no_tarsee_provider_key_at_all() {
    let env = cx("local", |o| o.key = None).unwrap();
    assert_eq!(
        cred_of(&env),
        map(&[("CODEX_HOME", &in_state(".codex-home-keys")), ("TARSEE_MCP_TOKEN", MCP)])
    );
}

const PATHS: [(&str, &str); 9] = [
    ("claude", CLAUDE_CODE),
    ("anthropic", CLAUDE_CODE),
    ("deepseek", CLAUDE_CODE),
    ("openrouter", CLAUDE_CODE),
    ("chatgpt", CODEX),
    ("openai", CODEX),
    ("openrouter", CODEX),
    ("deepseek", CODEX),
    ("local", CODEX),
];

fn build(id: &str, engine: &str, env: Option<Env>) -> Result<EnvMap, EngineEnvError> {
    if engine == CLAUDE_CODE {
        cc(id, |o| {
            if let Some(env) = env {
                o.env = env;
            }
        })
    } else {
        cx(id, |o| {
            if let Some(env) = env {
                o.env = env;
            }
        })
    }
}

#[test]
fn the_matrix_covers_every_provider_on_every_engine_it_runs_on() {
    let registry = registry();
    let mut want: Vec<String> = PROVIDER_IDS
        .iter()
        .flat_map(|id| {
            let engines = registry[id].entry.engines.clone().unwrap_or_default();
            engines.into_iter().map(move |engine| format!("{id}/{engine}"))
        })
        .collect();
    want.sort();
    let mut have: Vec<String> = PATHS.iter().map(|(id, engine)| format!("{id}/{engine}")).collect();
    have.sort();
    assert_eq!(have, want);
}

#[test]
fn on_every_path_the_vaults_script_key_passes_no_canary_passes_but_the_operators_sign_in_on_the_plan() {
    for (id, engine) in PATHS {
        let env = build(id, engine, None).unwrap();
        assert_eq!(env["SCRIPT_KEY"], vault()["SCRIPT_KEY"], "{id}/{engine}");
        let leaked = canary_values(&env);
        let want: Vec<String> = if id == "claude" {
            PLAN_NAMES.iter().map(|n| n.to_string()).collect()
        } else {
            Vec::new()
        };
        assert_eq!(leaked, want, "{id}/{engine}");
        assert_eq!(env["TARSEE_TIMEZONE"], "UTC", "{id}/{engine}: benign variables pass");
        assert_eq!(env["PATH"], BENIGN[0].1, "{id}/{engine}: benign variables pass");
    }
}

#[test]
fn on_every_path_the_tarsee_secrets_and_the_railway_provider_keys_never_pass() {
    for (id, engine) in PATHS {
        let env = build(id, engine, None).unwrap();
        for name in TARSEE_SECRETS.iter().chain(PROVIDER_KEY_NAMES.iter()) {
            assert!(!env.contains_key(*name), "{id}/{engine}: {name}");
        }
    }
}

#[test]
fn on_every_path_the_providers_key_appears_at_most_once_and_a_base_url_never_without_its_own_token() {
    for seam in [false, true] {
        for (id, engine) in PATHS {
            let name = format!("TARSEE_TEST_BASE_URL_{}", id.to_uppercase());
            let extra: Vec<(&str, Option<&str>)> = if seam {
                vec![("NODE_ENV", Some("test")), (&name, Some("http://127.0.0.1:4555/fake"))]
            } else {
                Vec::new()
            };
            let env = build(id, engine, Some(server_env_with(&extra))).unwrap();
            let place = format!("{id}/{engine}{}", if seam { " (seam)" } else { "" });
            if let Some(own) = key(id) {
                assert!(env.values().filter(|v| **v == own).count() <= 1, "{place}");
            }
            assert!(!env.contains_key("OPENAI_BASE_URL"), "{place}: OPENAI_BASE_URL");
            assert!(
                !env.contains_key("CLAUDE_CODE_API_BASE_URL"),
                "{place}: CLAUDE_CODE_API_BASE_URL"
            );
            if let Some(base_url) = env.get("ANTHROPIC_BASE_URL") {
                let token = env
                    .get("ANTHROPIC_AUTH_TOKEN")
                    .filter(|t| !t.is_empty())
                    .or(env.get("ANTHROPIC_API_KEY"));
                assert_eq!(
                    token.cloned(),
                    key(id),
                    "{place}: the base URL comes with the provider's own key"
                );
                assert!(!base_url.contains("canary"), "{place}");
            }
        }
    }
}

#[test]
fn a_missing_or_blank_key_refuses_the_turn_r4_naming_the_provider_and_never_falls_back_to_another_credential() {
    let keyed = [
        ("anthropic", CLAUDE_CODE),
        ("deepseek", CLAUDE_CODE),
        ("openrouter", CLAUDE_CODE),
        ("openai", CODEX),
        ("openrouter", CODEX),
        ("deepseek", CODEX),
    ];
    for (id, engine) in keyed {
        for blank in [None, Some(""), Some("   ")] {
            let result = if engine == CLAUDE_CODE {
                cc(id, |o| o.key = blank.map(String::from))
            } else {
                cx(id, |o| o.key = blank.map(String::from))
            };
            let err = result.unwrap_err();
            let refusal = err
                .credential()
                .unwrap_or_else(|| panic!("{id}/{engine} key={blank:?}"));
            assert_eq!(refusal.code, CredentialCode::NeedsKey, "{id}/{engine} key={blank:?}");
            assert_eq!(refusal.provider.as_deref(), Some(id), "{id}/{engine} key={blank:?}");
        }
    }
    // The words name the provider and where its key goes.
    let err = cc("deepseek", |o| o.key = None).unwrap_err();
    assert_eq!(
        err.to_string(),
        "DeepSeek needs its API key (Settings > AI, or the DEEPSEEK_API_KEY variable)."
    );
}

#[test]
fn a_key_with_a_line_break_or_nul_in_it_is_refused_not_sent() {
    assert_eq!(
        code_of(cc("deepseek", |o| o.key = Some(format!("sk-{}", "test-a\nb")))),
        Some(CredentialCode::BadKey)
    );
    assert_eq!(
        code_of(cx("openrouter", |o| o.key = Some(format!("sk-{}", "test-a\0b")))),
        Some(CredentialCode::BadKey)
    );
}

#[test]
fn a_key_pasted_into_the_wrong_slot_is_refused_on_every_path() {
    let err = cc("anthropic", |o| o.key = Some(format!("sk-ant-{}", "oat01-test-fake"))).unwrap_err();
    assert_eq!(err.code(), Some(CredentialCode::BadKey));
    assert_eq!(
        err.to_string(),
        "This is a Claude sign-in token, not an API key. Create an API key in the Anthropic Console instead."
    );
    for id in ["openrouter", "deepseek", "local"] {
        assert_eq!(
            code_of(cx(id, |o| o.key = Some(format!("sk-ant-{}", "api03-test-fake")))),
            Some(CredentialCode::BadKey),
            "{id}"
        );
    }
    assert_eq!(
        code_of(cc("deepseek", |o| o.key = Some(format!("sk-or-{}", "v1-test-fake")))),
        Some(CredentialCode::BadKey)
    );
}

#[test]
fn a_provider_on_an_engine_it_cant_run_on_is_refused() {
    for id in ["openai", "chatgpt", "local"] {
        assert_eq!(code_of(cc(id, none)), Some(CredentialCode::WrongEngine), "{id}");
    }
    for id in ["claude", "anthropic"] {
        assert_eq!(code_of(cx(id, none)), Some(CredentialCode::WrongEngine), "{id}");
    }
    assert_eq!(
        cc("openai", none).unwrap_err().to_string(),
        "OpenAI API key doesn't run on Claude Code."
    );
}

#[test]
fn a_gateway_pin_can_never_be_a_claude_id() {
    assert_eq!(
        code_of(cc("deepseek", |o| o.model = Some("claude-sonnet-4-5".into()))),
        Some(CredentialCode::BadModel)
    );
    let err = cc("deepseek", |o| o.tiers.haiku = Some("claude-haiku-4-5".into())).unwrap_err();
    assert_eq!(err.code(), Some(CredentialCode::BadModel));
    assert_eq!(
        err.to_string(),
        "ANTHROPIC_DEFAULT_HAIKU_MODEL names a Claude model (claude-haiku-4-5), which DeepSeek doesn't serve."
    );
}

#[test]
fn a_codex_turn_without_its_mcp_token_is_refused() {
    let err = cx("openai", |o| o.mcp_token = None).unwrap_err();
    assert_eq!(err.code(), Some(CredentialCode::NeedsMcpToken));
    assert_eq!(err.to_string(), "This turn has no token for Tarsee's tools.");
    assert_eq!(
        code_of(cx("openai", |o| o.mcp_token = Some("a\nb".into()))),
        Some(CredentialCode::NeedsMcpToken)
    );
}

#[test]
fn the_cost_savers_go_on_claude_code_turns_only() {
    let claude = claude_env_for(
        &p("claude"),
        &ClaudeEnvOpts {
            env: env_of(&[("PATH", "/bin")]),
            ..ClaudeEnvOpts::default()
        },
    )
    .unwrap();
    assert_eq!(claude["BASH_MAX_OUTPUT_LENGTH"], "8000");
    assert_eq!(claude["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "180000");
    let codex = codex_env_for(
        &p("openai"),
        &CodexEnvOpts {
            env: env_of(&[("PATH", "/bin")]),
            state_dir: Some(state()),
            key: key("openai"),
            mcp_token: Some(MCP.into()),
            ..CodexEnvOpts::default()
        },
    )
    .unwrap();
    assert!(!codex.contains_key("BASH_MAX_OUTPUT_LENGTH"));
    assert!(!codex.contains_key("CLAUDE_CODE_AUTO_COMPACT_WINDOW"));
}

#[test]
fn a_gateways_compact_window_never_exceeds_the_models_context() {
    let opts = |context| ClaudeEnvOpts {
        env: env_of(&[("PATH", "/bin")]),
        state_dir: Some(state()),
        key: key("openrouter"),
        context_tokens: Some(context),
        ..ClaudeEnvOpts::default()
    };
    let env = claude_env_for(&p("openrouter"), &opts(200_000.0)).unwrap();
    assert_eq!(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "180000");
    let small = claude_env_for(&p("openrouter"), &opts(128_000.0)).unwrap();
    assert_eq!(small["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "128000");
    assert_eq!(small["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "128000");
}

// --- a provider is passed as its registry entry, never a bare id ---------------------------------------------------

#[test]
fn a_key_providers_id_string_is_refused_by_every_builder_before_a_key_is_looked_at() {
    let claude_opts = ClaudeEnvOpts {
        env: server_env(),
        cost_saver: Some(EnvMap::new()),
        state_dir: Some(state()),
        key: Some(format!("sk-ant-{}", "api03-test-fake")),
        ..ClaudeEnvOpts::default()
    };
    let codex_opts = CodexEnvOpts {
        env: server_env(),
        state_dir: Some(state()),
        mcp_token: Some(MCP.into()),
        key: Some(format!("sk-ant-{}", "api03-test-fake")),
        ..CodexEnvOpts::default()
    };
    for id in ["anthropic", "deepseek", "openrouter"] {
        assert!(claude_env_for(id, &claude_opts).unwrap_err().is_type_error(), "{id}");
    }
    for id in ["openai", "openrouter", "deepseek", "local", "chatgpt"] {
        assert!(codex_env_for(id, &codex_opts).unwrap_err().is_type_error(), "{id}");
    }
    for id in ["openrouter", "deepseek", "openai", "local"] {
        for engine in [CLAUDE_CODE, CODEX] {
            assert!(
                host_for(id, engine, &Env::new(), None).unwrap_err().is_type_error(),
                "{id}/{engine}"
            );
        }
    }
}

#[test]
fn the_plans_id_or_storage_id_is_the_one_string_accepted() {
    assert_eq!(host_for("claude", CLAUDE_CODE, &Env::new(), None).unwrap(), None);
    assert_eq!(host_for("claude-code", CLAUDE_CODE, &Env::new(), None).unwrap(), None);
    let opts = ClaudeEnvOpts {
        env: server_env(),
        cost_saver: Some(EnvMap::new()),
        ..ClaudeEnvOpts::default()
    };
    assert!(claude_env_for("claude-code", &opts).is_ok());
}

#[test]
fn an_object_without_an_id_is_refused() {
    // (The JS also refused `null`; a Rust caller can't pass one.)
    let empty = ProviderEntry::default();
    assert!(
        claude_env_for(&empty, &ClaudeEnvOpts::default())
            .unwrap_err()
            .is_type_error()
    );
    let opts = CodexEnvOpts {
        mcp_token: Some(MCP.into()),
        ..CodexEnvOpts::default()
    };
    assert!(codex_env_for(&empty, &opts).unwrap_err().is_type_error());
}

// --- host_for: where a provider's turn goes, always a code constant (R3) -------------------------------------------

#[test]
fn host_for_gives_each_key_provider_its_constant_on_each_engine_it_runs_on() {
    let env = Env::new();
    let host = |id: &str, engine: &str| host_for(&p(id), engine, &env, None).unwrap();
    assert_eq!(
        host("deepseek", CLAUDE_CODE).as_deref(),
        Some("https://api.deepseek.com/anthropic")
    );
    assert_eq!(host("deepseek", CODEX).as_deref(), Some("https://api.deepseek.com"));
    assert_eq!(
        host("openrouter", CLAUDE_CODE).as_deref(),
        Some("https://openrouter.ai/api")
    );
    assert_eq!(
        host("openrouter", CODEX).as_deref(),
        Some("https://openrouter.ai/api/v1")
    );
    assert_eq!(
        host("anthropic", CLAUDE_CODE).as_deref(),
        Some("https://api.anthropic.com")
    );
    assert_eq!(
        host("openai", CODEX).as_deref(),
        Some("https://api.openai.com/v1"),
        "OpenAI's host is named, not left to Codex's default"
    );
}

#[test]
fn the_sign_in_plans_have_no_host_of_tarsees() {
    assert_eq!(host_for(&p("claude"), CLAUDE_CODE, &Env::new(), None).unwrap(), None);
    assert_eq!(host_for(&p("chatgpt"), CODEX, &Env::new(), None).unwrap(), None);
}

#[test]
fn refuses_a_key_provider_whose_entry_has_no_host_for_the_engine_instead_of_falling_back_to_the_engines_default() {
    let env = Env::new();
    let mut no_codex_host = p("deepseek");
    no_codex_host.base_url = hosts(&[(CLAUDE_CODE, "https://api.deepseek.com/anthropic")]);
    let err = host_for(&no_codex_host, CODEX, &env, None).unwrap_err();
    let refusal = err.credential().unwrap();
    assert_eq!(refusal.code, CredentialCode::WrongEngine);
    assert_eq!(refusal.provider.as_deref(), Some("deepseek"));
    assert_eq!(refusal.message, "DeepSeek has no Codex host.");
    let mut no_claude_code_host = p("deepseek");
    no_claude_code_host.base_url = hosts(&[(CODEX, "https://api.deepseek.com")]);
    let opts = ClaudeEnvOpts {
        state_dir: Some(state()),
        key: key("deepseek"),
        cost_saver: Some(EnvMap::new()),
        ..ClaudeEnvOpts::default()
    };
    assert_eq!(
        code_of(claude_env_for(&no_claude_code_host, &opts)),
        Some(CredentialCode::WrongEngine)
    );
    let bare = ProviderEntry {
        id: "openrouter".into(),
        ..ProviderEntry::default()
    };
    assert_eq!(
        code_of(host_for(&bare, CLAUDE_CODE, &env, None)),
        Some(CredentialCode::WrongEngine)
    );
    assert_eq!(
        code_of(host_for(&p("openai"), CLAUDE_CODE, &env, None)),
        Some(CredentialCode::WrongEngine),
        "openai doesn't run on Claude Code"
    );
}

#[test]
fn local_ais_host_is_the_owners_setting_an_http_url_without_credentials_or_the_turn_waits_for_setup() {
    let env = Env::new();
    let local = p("local");
    assert_eq!(
        host_for(&local, CODEX, &env, Some(" http://192.168.1.20:11434/v1 "))
            .unwrap()
            .as_deref(),
        Some("http://192.168.1.20:11434/v1")
    );
    assert_eq!(
        host_for(&local, CODEX, &env, Some("https://ai.example.test/v1"))
            .unwrap()
            .as_deref(),
        Some("https://ai.example.test/v1")
    );
    for local_url in [
        None,
        Some(""),
        Some("   "),
        Some("ftp://192.168.1.20"),
        Some("http://user:pw@192.168.1.20"),
        Some("not a url"),
        Some("file:///etc/passwd"),
    ] {
        assert_eq!(
            code_of(host_for(&local, CODEX, &env, local_url)),
            Some(CredentialCode::NeedsSetup),
            "{local_url:?}"
        );
    }
}

#[test]
fn the_test_seam_stands_in_for_any_keyed_providers_host_in_tests_never_for_a_sign_in_plans() {
    let env = |id: &str| {
        env_of(&[
            ("NODE_ENV", "test"),
            (
                &format!("TARSEE_TEST_BASE_URL_{}", id.to_uppercase()),
                "http://127.0.0.1:4555/fake",
            ),
        ])
    };
    let fake = Some("http://127.0.0.1:4555/fake".to_string());
    assert_eq!(host_for(&p("openai"), CODEX, &env("openai"), None).unwrap(), fake);
    assert_eq!(host_for(&p("local"), CODEX, &env("local"), None).unwrap(), fake);
    assert_eq!(host_for(&p("claude"), CLAUDE_CODE, &env("claude"), None).unwrap(), None);
    assert_eq!(host_for(&p("chatgpt"), CODEX, &env("chatgpt"), None).unwrap(), None);
}

// --- finalize_env (R2: strip, merge, strip again, then add) --------------------------------------------------------

#[test]
fn a_vault_entry_cant_re_add_a_credential_the_credential_block_always_wins_and_nothing_undefined_is_passed() {
    let env = finalize_env(&FinalizeOpts {
        // (The JS's GONE: undefined has no counterpart: an Env holds only set variables.)
        env: env_of(&[
            ("PATH", "/bin"),
            ("ANTHROPIC_API_KEY", &format!("sk-{}", "test-canary-env")),
            ("ENCRYPTION_KEY", &format!("sk-{}", "test-canary-enc")),
        ]),
        vault_env: map(&[
            ("ANTHROPIC_BASE_URL", "http://canary.invalid"),
            ("CODEX_API_KEY", &format!("sk-{}", "test-canary-vault")),
            ("SCRIPT_KEY", "ok"),
        ]),
        extra_env: map(&[("BASH_MAX_OUTPUT_LENGTH", "8000")]),
        credentials: map(&[("ANTHROPIC_API_KEY", &format!("sk-{}", "test-own"))]),
        strip_names: Vec::new(),
    });
    assert_eq!(
        env,
        map(&[
            ("PATH", "/bin"),
            ("SCRIPT_KEY", "ok"),
            ("BASH_MAX_OUTPUT_LENGTH", "8000"),
            ("ANTHROPIC_API_KEY", &format!("sk-{}", "test-own")),
        ])
    );
}

#[test]
fn base_env_is_what_the_vault_compares_against_a_vault_key_named_like_a_stripped_railway_key_still_reaches_scripts() {
    let server = env_of(&[
        ("PATH", "/bin"),
        ("OPENAI_API_KEY", &format!("sk-{}", "test-canary-railway")),
        ("ENCRYPTION_KEY", &format!("sk-{}", "test-canary-enc")),
    ]);
    assert_eq!(base_env(&server, &[]), map(&[("PATH", "/bin")]));
    // The JS built the vault's keys with agentVaultEnv({ env: baseEnv(server) }) (package B1); with OPENAI_API_KEY
    // not in baseEnv it offers the vault's copy, which this hands over as agent_vault_env would.
    let base = base_env(&server, &[]);
    assert!(!base.contains_key("OPENAI_API_KEY"));
    let vault_env = map(&[("OPENAI_API_KEY", &format!("sk-{}", "test-vault-for-scripts"))]);
    let env = codex_env_for(
        &p("chatgpt"),
        &CodexEnvOpts {
            env: server,
            vault_env,
            state_dir: Some(state()),
            mcp_token: Some(MCP.into()),
            ..CodexEnvOpts::default()
        },
    )
    .unwrap();
    assert_eq!(env["OPENAI_API_KEY"], format!("sk-{}", "test-vault-for-scripts"));
    assert_eq!(canary_values(&env), Vec::<String>::new());
}

#[test]
fn strips_credential_names_in_any_case() {
    let env = finalize_env(&FinalizeOpts {
        env: env_of(&[
            ("anthropic_api_key", &format!("sk-{}", "test-canary-lower")),
            ("Codex_Home", "x"),
            ("claude_code_oauth_refresh_token", "y"),
            ("Path", "C:\\bin"),
        ]),
        ..FinalizeOpts::default()
    });
    assert_eq!(env, map(&[("Path", "C:\\bin")]));
}

#[test]
fn auth_env_re_covers_the_designs_list_and_every_claude_sign_in_or_host_variable_the_pinned_cli_reads() {
    for name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_FOO",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "OPENAI_BASE_URL",
        "AWS_BEARER_TOKEN_BEDROCK",
        "TARSEE_PROVIDER_KEY",
        "TARSEE_CHATGPT_ACCESS_TOKEN",
        "TARSEE_MCP_TOKEN",
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
        "CLAUDE_CODE_OAUTH_SCOPES",
        "CLAUDE_CODE_OAUTH_CLIENT_ID",
        "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
        "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
        "CLAUDE_CODE_API_BASE_URL",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
        "CLAUDE_CODE_CUSTOM_OAUTH_URL",
        "CLAUDE_LOCAL_OAUTH_API_BASE",
        "CLAUDE_LOCAL_OAUTH_APPS_BASE",
        "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
        "CLAUDE_TRUSTED_DEVICE_TOKEN",
        "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
        "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
        "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    ] {
        assert!(AUTH_ENV_RE.is_match(name), "{name}");
        assert!(is_auth_env_name(&name.to_lowercase()), "{}", name.to_lowercase());
    }
    for name in [
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
        "OPENAI_API_KEY",
        "PATH",
        "SCRIPT_KEY",
        "MY_FILE_DESCRIPTOR",
    ] {
        assert!(!AUTH_ENV_RE.is_match(name), "{name}");
    }
}

// --- the engine-env tables agree with the provider registry --------------------------------------------------------

#[test]
fn every_providers_key_variable_is_stripped_from_every_engines_environment() {
    let registry = registry();
    for id in PROVIDER_IDS {
        let Some(name) = registry[id].entry.env_key.clone() else {
            continue;
        };
        assert!(
            is_auth_env_name(&name) || PROVIDER_KEY_NAMES.contains(&name.as_str()),
            "{id}'s {name} would reach every other provider's agent"
        );
        let server = env_of(&[(&name, &format!("sk-{}", "test-canary"))]);
        let claude = claude_env_for(
            &p("claude"),
            &ClaudeEnvOpts {
                env: server.clone(),
                cost_saver: Some(EnvMap::new()),
                ..ClaudeEnvOpts::default()
            },
        )
        .unwrap();
        assert!(!claude.contains_key(&name), "{name} reached claude/claude-code");
        let codex = codex_env_for(
            &p("chatgpt"),
            &CodexEnvOpts {
                env: server,
                state_dir: Some(state()),
                mcp_token: Some(MCP.into()),
                ..CodexEnvOpts::default()
            },
        )
        .unwrap();
        assert!(!codex.contains_key(&name), "{name} reached chatgpt/codex");
    }
}

#[test]
fn a_provider_has_a_home_exactly_on_the_engines_the_registry_says_it_runs_on() {
    for (id, fixture) in registry() {
        let engines = fixture.entry.engines.clone().unwrap_or_default();
        for alias in [id, fixture.storage_id] {
            for engine in [CLAUDE_CODE, CODEX] {
                assert_eq!(
                    home_key_for(alias, engine).is_some(),
                    engines.iter().any(|e| e == engine),
                    "{alias}/{engine}"
                );
            }
        }
    }
}

#[test]
fn every_keyed_provider_has_an_https_host_on_every_engine_it_runs_on() {
    for (id, fixture) in registry() {
        if fixture.kind != "key" {
            continue;
        }
        for engine in fixture.entry.engines.clone().unwrap_or_default() {
            let host = host_for(&fixture.entry, &engine, &Env::new(), None).unwrap().unwrap();
            assert!(host.starts_with("https://"), "{id}/{engine}");
        }
    }
}

// --- the test-only base-URL seam -------------------------------------------------------------------------------

fn seam(env: &[(&str, &str)]) -> Option<String> {
    test_base_url("deepseek", &env_of(env))
}

#[test]
fn the_seam_is_honored_only_when_node_env_is_test_and_the_host_is_loopback() {
    for url in [
        "http://127.0.0.1:4555/anthropic",
        "http://localhost:4555",
        "http://[::1]:4555/x",
    ] {
        assert_eq!(
            seam(&[("NODE_ENV", "test"), ("TARSEE_TEST_BASE_URL_DEEPSEEK", url)]).as_deref(),
            Some(url)
        );
    }
}

#[test]
fn the_seam_is_inert_in_production_in_development_and_with_node_env_unset() {
    for node_env in [
        Some("production"),
        Some("development"),
        None,
        Some("TEST"),
        Some(" test"),
    ] {
        let env = env_of(&[("TARSEE_TEST_BASE_URL_DEEPSEEK", "http://127.0.0.1:4555")]);
        if let Some(node_env) = node_env {
            env.set("NODE_ENV", node_env);
        }
        assert_eq!(test_base_url("deepseek", &env), None, "{node_env:?}");
        let built = claude_env_for(
            &p("deepseek"),
            &ClaudeEnvOpts {
                env,
                cost_saver: Some(EnvMap::new()),
                state_dir: Some(state()),
                key: key("deepseek"),
                ..ClaudeEnvOpts::default()
            },
        )
        .unwrap();
        assert_eq!(
            built["ANTHROPIC_BASE_URL"], "https://api.deepseek.com/anthropic",
            "{node_env:?}"
        );
    }
}

#[test]
fn the_seam_is_ignored_for_any_host_off_loopback_credentials_in_the_url_or_a_non_http_scheme() {
    for url in [
        "http://example.com",
        "http://127.0.0.1.evil.test",
        "http://0.0.0.0:4555",
        "http://10.0.0.1",
        "http://user:pw@127.0.0.1:4555",
        "file:///etc/passwd",
        "ftp://127.0.0.1",
        "not a url",
    ] {
        assert_eq!(
            seam(&[("NODE_ENV", "test"), ("TARSEE_TEST_BASE_URL_DEEPSEEK", url)]),
            None,
            "{url}"
        );
    }
}

#[test]
fn the_seam_points_a_gateway_at_the_fake_in_tests_with_its_own_key() {
    let env = claude_env_for(
        &p("deepseek"),
        &ClaudeEnvOpts {
            env: server_env_with(&[
                ("NODE_ENV", Some("test")),
                ("TARSEE_TEST_BASE_URL_DEEPSEEK", Some("http://127.0.0.1:4555/anthropic")),
            ]),
            cost_saver: Some(EnvMap::new()),
            state_dir: Some(state()),
            key: key("deepseek"),
            ..ClaudeEnvOpts::default()
        },
    )
    .unwrap();
    assert_eq!(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4555/anthropic");
    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], key("deepseek").unwrap());
}

#[test]
fn the_claude_plan_never_gets_a_base_url_seam_or_not() {
    let env = claude_env_for(
        &p("claude"),
        &ClaudeEnvOpts {
            env: server_env_with(&[
                ("NODE_ENV", Some("test")),
                ("TARSEE_TEST_BASE_URL_CLAUDE", Some("http://127.0.0.1:4555")),
            ]),
            cost_saver: Some(EnvMap::new()),
            ..ClaudeEnvOpts::default()
        },
    )
    .unwrap();
    assert!(!env.contains_key("ANTHROPIC_BASE_URL"));
    let seamed = env_of(&[
        ("NODE_ENV", "test"),
        ("TARSEE_TEST_BASE_URL_CLAUDE", "http://127.0.0.1:1"),
    ]);
    assert_eq!(host_for(&p("claude"), CLAUDE_CODE, &seamed, None).unwrap(), None);
}

// --- R1: one credential home per provider and engine -------------------------------------------------------------

fn home_opts(state_dir: Option<&str>, home_dir: Option<&str>) -> HomeOpts {
    HomeOpts {
        state_dir: state_dir.map(PathBuf::from),
        home_dir: home_dir.map(PathBuf::from),
    }
}

#[test]
fn home_for_names_each_home() {
    let node_home = normalize_path(Path::new("/home/node"));
    let with_home = HomeOpts {
        home_dir: Some(node_home.clone()),
        ..HomeOpts::default()
    };
    assert_eq!(
        home_for("claude", CLAUDE_CODE, &with_home).unwrap(),
        node_home.join(".claude")
    );
    assert_eq!(
        home_for("claude-code", CLAUDE_CODE, &with_home).unwrap(),
        node_home.join(".claude")
    );
    let with_state = HomeOpts {
        state_dir: Some(state()),
        ..HomeOpts::default()
    };
    for id in ["anthropic", "deepseek", "openrouter"] {
        assert_eq!(
            home_for(id, CLAUDE_CODE, &with_state).unwrap(),
            state().join(format!(".claude-home-{id}"))
        );
    }
    assert_eq!(
        home_for("chatgpt", CODEX, &with_state).unwrap(),
        state().join(".codex-home")
    );
    for id in ["openai", "openrouter", "deepseek", "local"] {
        assert_eq!(
            home_for(id, CODEX, &with_state).unwrap(),
            state().join(".codex-home-keys")
        );
    }
}

#[test]
fn a_key_home_needs_the_callers_state_folder_there_is_no_default_to_guess_wrong_on_railway() {
    for (id, engine) in [
        ("deepseek", CLAUDE_CODE),
        ("anthropic", CLAUDE_CODE),
        ("chatgpt", CODEX),
        ("openai", CODEX),
    ] {
        assert!(
            home_for(id, engine, &HomeOpts::default()).unwrap_err().is_type_error(),
            "{id}/{engine}"
        );
        assert!(
            home_for(id, engine, &home_opts(Some("  "), None))
                .unwrap_err()
                .is_type_error(),
            "{id}/{engine} blank"
        );
    }
    // TARSEE_STATE_DIR in the environment is not a default either.
    let with_state_var = env_of(&[("PATH", "/bin"), ("TARSEE_STATE_DIR", "/data/tarsee")]);
    let err = claude_env_for(
        &p("deepseek"),
        &ClaudeEnvOpts {
            env: with_state_var.clone(),
            key: key("deepseek"),
            ..ClaudeEnvOpts::default()
        },
    )
    .unwrap_err();
    assert!(err.is_type_error());
    assert_eq!(
        err.to_string(),
        "engine-env: stateDir (config.STATE_DIR) is required for deepseek's Claude Code home"
    );
    let codex = CodexEnvOpts {
        env: with_state_var,
        mcp_token: Some(MCP.into()),
        ..CodexEnvOpts::default()
    };
    assert!(codex_env_for(&p("chatgpt"), &codex).unwrap_err().is_type_error());
    // An explicit home is enough, and the plan's home is the user's own .claude.
    let explicit = claude_env_for(
        &p("deepseek"),
        &ClaudeEnvOpts {
            env: env_of(&[("PATH", "/bin")]),
            key: key("deepseek"),
            home: Some(PathBuf::from("/x/.claude-home-deepseek")),
            ..ClaudeEnvOpts::default()
        },
    )
    .unwrap();
    assert_eq!(explicit["CLAUDE_CONFIG_DIR"], "/x/.claude-home-deepseek");
    let plan = ClaudeEnvOpts {
        env: env_of(&[("PATH", "/bin")]),
        ..ClaudeEnvOpts::default()
    };
    assert!(claude_env_for(&p("claude"), &plan).is_ok());
}

#[test]
fn home_for_refuses_a_provider_on_an_engine_it_doesnt_run_on() {
    let opts = HomeOpts {
        state_dir: Some(state()),
        ..HomeOpts::default()
    };
    for (id, engine) in [
        ("claude", CODEX),
        ("anthropic", CODEX),
        ("openai", CLAUDE_CODE),
        ("chatgpt", CLAUDE_CODE),
        ("local", CLAUDE_CODE),
        ("nobody", CODEX),
        ("deepseek", "other"),
    ] {
        assert_eq!(
            code_of(home_for(id, engine, &opts)),
            Some(CredentialCode::WrongEngine),
            "{id}/{engine}"
        );
    }
    assert_eq!(
        home_for("Nobody", CODEX, &opts).unwrap_err().to_string(),
        "Nobody doesn't run on codex."
    );
}

#[test]
fn home_key_for_cc_on_claude_code_cxd_for_the_chatgpt_sign_in_home_cx_for_the_key_home() {
    assert_eq!(home_key_for("deepseek", CLAUDE_CODE), Some("cc"));
    assert_eq!(home_key_for("claude", CLAUDE_CODE), Some("cc"));
    assert_eq!(home_key_for("chatgpt", CODEX), Some("cxd"));
    assert_eq!(home_key_for("openai", CODEX), Some("cx"));
    assert_eq!(home_key_for("openrouter", CODEX), Some("cx"));
    assert_eq!(home_key_for("openai", CLAUDE_CODE), None);
}

#[test]
fn ensure_home_creates_the_folder_and_its_parents_owner_only_and_is_idempotent() {
    let tmp = tmp_dir();
    let dir = tmp.path().join("state").join(".claude-home-deepseek");
    assert_eq!(ensure_home(&dir).unwrap(), dir);
    assert!(dir.is_dir());
    ensure_home(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_home(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700, "an existing folder is tightened");
    }
}

/// A folder under `tmp/homes` holding these files.
fn mk(tmp: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = tmp.join("homes").join(name);
    std::fs::create_dir_all(&dir).unwrap();
    for (file, text) in files {
        std::fs::write(dir.join(file), text).unwrap();
    }
    dir
}

fn isolation(home: &Path) -> Option<IsolationRefusal> {
    home_isolation_refusal(home, &IsolationOpts::default())
}

fn isolation_as(home: &Path, provider_id: &str, engine: &str) -> Option<IsolationRefusal> {
    home_isolation_refusal(
        home,
        &IsolationOpts {
            provider_id: Some(provider_id),
            engine: Some(engine),
            ..IsolationOpts::default()
        },
    )
}

#[test]
fn a_key_home_holding_a_sign_in_file_refuses_the_turn_the_sign_in_homes_may_hold_theirs() {
    let tmp = tmp_dir();
    let tmp = tmp.path();
    let bad1 = isolation(&mk(
        tmp,
        ".claude-home-deepseek",
        &[(".credentials.json", "{\"fake\":true}")],
    ))
    .unwrap();
    assert_eq!(bad1.code, CredentialCode::CredentialIsolation);
    assert_eq!(
        bad1.file,
        tmp.join("homes")
            .join(".claude-home-deepseek")
            .join(".credentials.json")
    );
    assert_eq!(
        bad1.message,
        format!(
            "{} is a sign-in file in a folder meant only for an API key. Tarsee won't start this turn while it is there; delete it (or sign in from the Terminal without pointing at this folder).",
            bad1.file.display()
        )
    );
    assert_eq!(
        isolation(&mk(tmp, ".codex-home-keys", &[("auth.json", "{\"fake\":true}")])).map(|r| r.code),
        Some(CredentialCode::CredentialIsolation)
    );
    assert_eq!(isolation(&mk(tmp, ".claude-home-openrouter", &[])), None);
    assert_eq!(
        isolation(&mk(tmp, ".claude-code-home", &[(".credentials.json", "{}")])),
        None
    );
    assert_eq!(isolation(&mk(tmp, ".codex-home", &[("auth.json", "{}")])), None);
    assert_eq!(
        isolation(&tmp.join("homes").join("missing").join(".claude-home-anthropic")),
        None
    );
}

#[test]
fn the_refusal_also_holds_for_a_home_at_another_path_when_the_provider_and_engine_say_its_a_key_home() {
    let tmp = tmp_dir();
    let dir = mk(
        tmp.path(),
        "custom-home",
        &[(".credentials.json", "{}"), ("auth.json", "{}")],
    );
    let code = |id, engine| isolation_as(&dir, id, engine).map(|r| r.code);
    assert_eq!(
        code("anthropic", CLAUDE_CODE),
        Some(CredentialCode::CredentialIsolation)
    );
    assert_eq!(code("openai", CODEX), Some(CredentialCode::CredentialIsolation));
    assert_eq!(code("claude", CLAUDE_CODE), None);
    assert_eq!(code("chatgpt", CODEX), None);
}

#[test]
fn a_claude_key_home_whose_global_config_holds_a_login_console_key_refuses_the_turn() {
    // The CLI writes .claude.json in CLAUDE_CONFIG_DIR on every run; only a stored key in it is a problem. A Terminal
    // `/login` with CLAUDE_CONFIG_DIR pointed at a key home would save one, and on a gateway turn (ANTHROPIC_API_KEY
    // empty) the CLI would send it as x-api-key to the gateway's host.
    let tmp = tmp_dir();
    let tmp = tmp.path();
    let with_key =
        serde_json::json!({ "numStartups": 3, "primaryApiKey": format!("sk-ant-{}", "api03-test-canary-login") })
            .to_string();
    let bad = isolation(&mk(tmp, ".claude-home-deepseek-login", &[(".claude.json", &with_key)])).unwrap();
    assert_eq!(bad.code, CredentialCode::CredentialIsolation);
    assert_eq!(
        bad.file,
        tmp.join("homes")
            .join(".claude-home-deepseek-login")
            .join(".claude.json")
    );
    assert!(!bad.message.contains("canary"), "the key is never echoed");
    // The legacy name the CLI reads first when it's there.
    assert_eq!(
        isolation(&mk(
            tmp,
            ".claude-home-openrouter-legacy",
            &[(".config.json", &with_key)]
        ))
        .map(|r| r.code),
        Some(CredentialCode::CredentialIsolation)
    );
    // A file the CLI wrote half-way (not JSON) still can't hide a key.
    let torn = format!("{{\"primaryApiKey\": \"sk-ant-{}\", ", "api03-test-x");
    assert_eq!(
        isolation(&mk(tmp, ".claude-home-anthropic-torn", &[(".claude.json", &torn)])).map(|r| r.code),
        Some(CredentialCode::CredentialIsolation)
    );
    // The everyday file, an account's metadata, or an emptied key are fine.
    let fine = serde_json::json!({ "numStartups": 3, "oauthAccount": { "emailAddress": "a@example.test" }, "primaryApiKey": "" })
        .to_string();
    assert_eq!(
        isolation(&mk(tmp, ".claude-home-deepseek-ok", &[(".claude.json", &fine)])),
        None
    );
    assert_eq!(
        isolation_as(
            &mk(tmp, "plan-home", &[(".claude.json", &with_key)]),
            "claude",
            CLAUDE_CODE
        ),
        None,
        "the plan's own home is R6's business"
    );
    assert_eq!(
        isolation_as(
            &mk(tmp, "custom-key-home", &[(".claude.json", &with_key)]),
            "deepseek",
            CLAUDE_CODE
        )
        .map(|r| r.code),
        Some(CredentialCode::CredentialIsolation)
    );
}

#[test]
fn the_isolation_check_uses_the_given_exists_and_read_file_and_a_file_it_cant_read_counts_as_holding_a_key() {
    let home = PathBuf::from("/virtual/.claude-home-deepseek");
    let nothing = |_: &Path| false;
    let denied = |_: &Path| -> io::Result<String> { Err(io::Error::from(io::ErrorKind::PermissionDenied)) };
    let refusal = home_isolation_refusal(
        &home,
        &IsolationOpts {
            exists: Some(&nothing),
            read_file: Some(&denied),
            ..IsolationOpts::default()
        },
    )
    .unwrap();
    assert_eq!(refusal.file, node_join(&home, &[".config.json"]), "fail closed");
    let missing = |_: &Path| -> io::Result<String> { Err(io::Error::from(io::ErrorKind::NotFound)) };
    assert_eq!(
        home_isolation_refusal(
            &home,
            &IsolationOpts {
                exists: Some(&nothing),
                read_file: Some(&missing),
                ..IsolationOpts::default()
            },
        ),
        None
    );
}

// --- R5: setting sources and the settings-file guard ---------------------------------------------------------------

struct GuardDirs {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    ws: PathBuf,
}

/// A test's temporary folder as Node's `path` module spells it (the guards' messages name files that way).
fn root(tmp: &tempfile::TempDir) -> PathBuf {
    normalize_path(tmp.path())
}

fn guard_dirs() -> GuardDirs {
    let tmp = tmp_dir();
    let home = root(&tmp).join(".claude-home-deepseek");
    let ws = root(&tmp).join("workspace");
    GuardDirs { _tmp: tmp, home, ws }
}

fn write(file: &Path, text: &str) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

#[test]
fn setting_sources_for_the_plan_keeps_todays_sources_every_other_provider_loads_the_project_only() {
    assert_eq!(setting_sources_for("claude"), ["user", "project", "local"]);
    assert_eq!(setting_sources_for("claude-code"), ["user", "project", "local"]);
    for id in ["anthropic", "deepseek", "openrouter"] {
        assert_eq!(setting_sources_for(id), ["project"]);
    }
}

#[test]
fn settings_files_for_lists_the_homes_settings_json_always_then_each_workspace_file_the_sources_load() {
    let d = guard_dirs();
    assert_eq!(
        settings_files_for(&["project"], &d.home, &d.ws),
        [d.home.join("settings.json"), d.ws.join(".claude").join("settings.json")]
    );
    assert_eq!(
        settings_files_for(&["user", "project", "local"], &d.home, &d.ws),
        [
            d.home.join("settings.json"),
            d.ws.join(".claude").join("settings.json"),
            d.ws.join(".claude").join("settings.local.json"),
        ]
    );
}

#[test]
fn the_settings_guard_passes_when_the_files_are_missing_or_hold_no_credential() {
    let d = guard_dirs();
    let files = settings_files_for(&["user", "project", "local"], &d.home, &d.ws);
    let result = settings_file_guard(&files, None);
    assert_eq!(result, GuardResult::pass());
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::json!({ "ok": true, "files": [] })
    );
    write(
        &d.ws.join(".claude").join("settings.json"),
        r#"{"env":{"BASH_MAX_OUTPUT_LENGTH":"9000"},"permissions":{"allow":[]}}"#,
    );
    assert!(settings_file_guard(&files, None).ok);
}

#[test]
fn the_settings_guard_refuses_a_credential_env_entry_in_the_home_settings_json_naming_the_file_and_only_the_bad_entries()
 {
    let d = guard_dirs();
    let file = d.home.join("settings.json");
    write(
        &file,
        &format!(
            r#"{{"env":{{"ANTHROPIC_BASE_URL":"http://canary.invalid","FOO":"bar","anthropic_api_key":"sk-{}"}}}}"#,
            "test-canary"
        ),
    );
    let res = settings_file_guard(&settings_files_for(&["project"], &d.home, &d.ws), None);
    assert!(!res.ok);
    assert_eq!(
        res.files,
        [GuardFile::entries(
            &file,
            &["env.ANTHROPIC_BASE_URL", "env.anthropic_api_key"]
        )]
    );
    let message = res.message.unwrap();
    assert!(message.contains(&file.display().to_string()));
    assert!(!message.contains("canary"), "values are never echoed");
    assert_eq!(
        message,
        format!(
            "A Claude Code settings file would change which account this AI uses, so Tarsee won't start the turn. Remove these entries: {}: env.ANTHROPIC_BASE_URL, env.anthropic_api_key",
            file.display()
        )
    );
}

#[test]
fn the_settings_guard_refuses_the_claude_sign_in_and_host_variables_the_pinned_cli_reads_in_any_case() {
    let d = guard_dirs();
    let file = d.home.join("settings.json");
    write(
        &file,
        &format!(
            r#"{{"env":{{"CLAUDE_CODE_API_BASE_URL":"http://canary.invalid","CLAUDE_CODE_OAUTH_REFRESH_TOKEN":"sk-{c}","CLAUDE_CODE_CUSTOM_OAUTH_URL":"http://canary.invalid","claude_trusted_device_token":"sk-{c}","OK_ONE":"1"}}}}"#,
            c = "test-canary"
        ),
    );
    let res = settings_file_guard(std::slice::from_ref(&file), None);
    assert!(!res.ok);
    assert_eq!(
        res.files,
        [GuardFile::entries(
            &file,
            &[
                "env.CLAUDE_CODE_API_BASE_URL",
                "env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
                "env.CLAUDE_CODE_CUSTOM_OAUTH_URL",
                "env.claude_trusted_device_token",
            ]
        )]
    );
}

#[test]
fn the_settings_guard_refuses_api_key_helper_in_the_workspace_settings_local_json() {
    let d = guard_dirs();
    let file = d.ws.join(".claude").join("settings.local.json");
    write(
        &file,
        &format!(r#"{{"apiKeyHelper":"/bin/echo sk-{}"}}"#, "test-canary"),
    );
    let res = settings_file_guard(&settings_files_for(&["user", "project", "local"], &d.home, &d.ws), None);
    assert!(!res.ok);
    assert_eq!(res.files, [GuardFile::entries(&file, &["apiKeyHelper"])]);
}

#[test]
fn the_settings_guard_refuses_a_settings_file_it_cant_read_as_json_and_reads_one_with_a_byte_order_mark() {
    let d = guard_dirs();
    let file = d.home.join("settings.json");
    write(&file, "{ not json");
    let res = settings_file_guard(std::slice::from_ref(&file), None);
    assert!(!res.ok);
    assert_eq!(res.files, [GuardFile::unreadable(&file)]);
    assert_eq!(
        serde_json::to_value(&res.files).unwrap(),
        serde_json::json!([{ "file": file.to_string_lossy(), "entries": [], "unreadable": true }])
    );
    assert!(res.message.unwrap().ends_with("(can't be read as JSON)"));
    write(&file, "\u{FEFF}{\"env\":{\"CLAUDE_CODE_USE_BEDROCK\":\"1\"}}");
    assert_eq!(
        settings_file_guard(std::slice::from_ref(&file), None).files,
        [GuardFile::entries(&file, &["env.CLAUDE_CODE_USE_BEDROCK"])]
    );
}

#[test]
fn the_settings_guard_counts_a_file_it_isnt_allowed_to_read_as_unreadable_and_a_missing_folder_as_missing() {
    let file = PathBuf::from("/virtual/settings.json");
    let denied = |_: &Path| -> io::Result<String> { Err(io::Error::from(io::ErrorKind::PermissionDenied)) };
    assert_eq!(
        settings_file_guard(std::slice::from_ref(&file), Some(&denied)).files,
        [GuardFile::unreadable(&file)]
    );
    let not_a_dir = |_: &Path| -> io::Result<String> { Err(io::Error::from(io::ErrorKind::NotADirectory)) };
    assert!(settings_file_guard(std::slice::from_ref(&file), Some(&not_a_dir)).ok);
}

// --- Codex's config.toml guard (R5's counterpart for Codex) ------------------------------------------------------

fn codex_dirs() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let tmp = tmp_dir();
    let home = root(&tmp).join(".codex-home-keys");
    let ws = root(&tmp).join("workspace");
    let file = home.join("config.toml");
    std::fs::create_dir_all(&home).unwrap();
    (tmp, home, ws, file)
}

fn guard(file: &Path, text: &str) -> GuardResult {
    std::fs::write(file, text).unwrap();
    let result = codex_config_guard(&[file.to_path_buf()], None);
    std::fs::remove_file(file).unwrap();
    result
}

#[test]
fn codex_config_files_for_lists_the_homes_config_toml_and_env_then_the_workspaces_project_config() {
    let (_tmp, home, ws, _) = codex_dirs();
    assert_eq!(
        codex_config_files_for(&home, Some(&ws)),
        [
            home.join("config.toml"),
            home.join(".env"),
            ws.join(".codex").join("config.toml")
        ]
    );
    assert_eq!(
        codex_config_files_for(&home, None),
        [home.join("config.toml"), home.join(".env")]
    );
}

#[test]
fn the_codex_guard_refuses_a_env_in_the_codex_home_whatever_it_holds_even_empty() {
    let (_tmp, home, ws, file) = codex_dirs();
    let dotenv = home.join(".env");
    for text in [
        "HTTP_PROXY=http://127.0.0.1:47812\n",
        "SSL_CERT_FILE=/tmp/attacker-ca.pem\n",
        "# nothing yet\n",
        "",
    ] {
        std::fs::write(&dotenv, text).unwrap();
        let res = codex_config_guard(&codex_config_files_for(&home, Some(&ws)), None);
        assert!(!res.ok, "{text:?}");
        assert_eq!(
            res.files,
            [GuardFile {
                dotenv: true,
                ..GuardFile::unreadable(&dotenv)
            }],
            "{text:?}"
        );
        let message = res.message.unwrap();
        assert!(message.contains(&dotenv.display().to_string()));
        assert!(message.contains("into its own environment"));
        assert!(message.contains("set the file aside"));
        assert!(
            !message.contains("127.0.0.1") && !message.contains("attacker"),
            "values are never echoed"
        );
    }
    // A folder or a link by that name counts too: Codex would read through it.
    std::fs::remove_file(&dotenv).unwrap();
    std::fs::create_dir(&dotenv).unwrap();
    assert!(!codex_config_guard(&codex_config_files_for(&home, None), None).ok);
    std::fs::remove_dir(&dotenv).unwrap();
    // Beside a refused config.toml, both are named.
    std::fs::write(&dotenv, "HTTPS_PROXY=http://127.0.0.1:1\n").unwrap();
    std::fs::write(&file, "openai_base_url = \"http://canary.invalid\"\n").unwrap();
    let both = codex_config_guard(&codex_config_files_for(&home, None), None);
    let named: Vec<&PathBuf> = both.files.iter().map(|f| &f.file).collect();
    assert_eq!(named, [&file, &dotenv]);
    let message = both.message.unwrap();
    assert!(message.contains("openai_base_url"));
    assert!(message.contains("into its own environment"));
    std::fs::remove_file(&dotenv).unwrap();
    std::fs::remove_file(&file).unwrap();
    // Only the home's own .env loads: one in the workspace is not Codex's.
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join(".env"), "HTTP_PROXY=http://127.0.0.1:47812\n").unwrap();
    assert_eq!(
        codex_config_guard(&codex_config_files_for(&home, Some(&ws)), None),
        GuardResult::pass()
    );
}

#[test]
fn the_codex_guard_passes_when_the_files_are_missing() {
    let (_tmp, home, ws, _) = codex_dirs();
    assert_eq!(
        codex_config_guard(&codex_config_files_for(&home, Some(&ws)), None),
        GuardResult::pass()
    );
}

#[test]
fn the_codex_guard_passes_the_seeded_config_and_what_codex_itself_writes_there() {
    let (_tmp, _home, _ws, file) = codex_dirs();
    let seeded = [
        "\u{FEFF}# Seeded by Tarsee: no secrets here.",
        "cli_auth_credentials_store = \"file\"",
        "check_for_update_on_startup = false",
        "forced_login_method = \"api\"   # the key homes",
        "model = \"gpt-6.1-sol\"",
        "model_reasoning_effort = 'high'",
        "",
        "[projects.'C:\\Users\\owner\\workspace']",
        "trust_level = \"trusted\"",
        "[projects.\"/data/tarsee/workspace\"]",
        "trust_level = \"trusted\"",
        "[notice]",
        "hide_full_access_warning = true",
        "[tui]",
        "notifications = true",
    ]
    .join("\r\n");
    assert_eq!(guard(&file, &seeded), GuardResult::pass());
}

#[test]
fn the_codex_guard_refuses_anything_that_could_send_a_key_elsewhere_or_run_a_program_that_sees_it() {
    let (_tmp, _home, _ws, file) = codex_dirs();
    let cases = [
        (
            "openai_base_url",
            "openai_base_url = \"http://127.0.0.1:47812/v1\"".to_string(),
        ),
        (
            "chatgpt_base_url",
            "chatgpt_base_url = \"http://canary.invalid\"".to_string(),
        ),
        ("model_provider", "model_provider = \"attacker\"".to_string()),
        (
            "model_providers",
            "[model_providers.deepseek]\nbase_url = \"http://canary.invalid\"\nenv_key = \"TARSEE_PROVIDER_KEY\""
                .to_string(),
        ),
        ("profile", "profile = \"evil\"".to_string()),
        ("profiles", "[[ profiles . evil ]]\nmodel_provider = \"x\"".to_string()),
        (
            "mcp_servers",
            "[mcp_servers.leak]\ncommand = \"node\"\nenv_vars = [\"TARSEE_PROVIDER_KEY\"]".to_string(),
        ),
        ("notify", "notify = [\"node\", \"leak.js\"]".to_string()),
        (
            "experimental_bearer_token",
            format!("experimental_bearer_token = \"sk-{}\"", "test-canary"),
        ),
    ];
    for (name, text) in cases {
        let res = guard(&file, &format!("check_for_update_on_startup = false\n{text}\n"));
        assert!(!res.ok, "{name}");
        assert_eq!(res.files, [GuardFile::entries(&file, &[name])], "{name}");
        let message = res.message.unwrap();
        assert!(message.contains(&file.display().to_string()), "{name}");
        assert!(
            !message.contains("canary") && !message.contains("127.0.0.1") && !message.contains("leak"),
            "{name}: values are never echoed"
        );
    }
}

#[test]
fn the_codex_guard_sees_a_root_entry_however_toml_spells_it() {
    let (_tmp, _home, _ws, file) = codex_dirs();
    for text in [
        "mcp_servers.leak.command = \"node\"",
        "\"mcp_servers\".leak = { command = \"node\" }",
        "'mcp_servers' . leak . command = \"x\"",
        "[ \"mcp_servers\" . leak ]",
        "mcp_servers = { leak = { command = \"node\" } }",
        "  mcp_servers.leak.command=\"node\"  # indented",
    ] {
        assert_eq!(
            guard(&file, text).files,
            [GuardFile::entries(&file, &["mcp_servers"])],
            "{text}"
        );
    }
}

#[test]
fn the_codex_guard_refuses_any_root_entry_it_doesnt_know() {
    let (_tmp, _home, _ws, file) = codex_dirs();
    assert_eq!(
        guard(
            &file,
            "[plugins.x]\nenabled = true\n[network]\nproxy_url = \"http://x\""
        )
        .files,
        [GuardFile::entries(&file, &["plugins", "network"])]
    );
}

#[test]
fn the_codex_guard_refuses_a_file_it_cant_read_safely() {
    let (_tmp, _home, _ws, file) = codex_dirs();
    for text in [
        "model = \"\"\"\nx\n\"\"\"",
        "model = '''\nx\n'''",
        "notify = [\n  \"node\",\n]",
        "\"mcp\\u005Fservers\" = 1",
        "[projects]]",
        "[projects",
        "= 1",
        "just words",
    ] {
        let res = guard(&file, text);
        assert!(!res.ok, "{text}");
        assert!(res.files[0].unreadable, "{text}");
        assert!(res.message.unwrap().ends_with("(can't be read safely)"), "{text}");
    }
}

#[test]
fn the_codex_guard_reads_a_key_under_an_allowed_table_as_that_tables() {
    let (_tmp, _home, _ws, file) = codex_dirs();
    assert!(guard(&file, "[projects.\"/w\"]\ntrust_level = \"trusted\"\nnotify = true").ok);
}

#[test]
fn the_codex_guard_checks_the_workspaces_project_config_too() {
    let (_tmp, home, ws, _) = codex_dirs();
    let project_file = ws.join(".codex").join("config.toml");
    write(&project_file, "openai_base_url = \"http://canary.invalid\"\n");
    let res = codex_config_guard(&codex_config_files_for(&home, Some(&ws)), None);
    assert_eq!(res.files, [GuardFile::entries(&project_file, &["openai_base_url"])]);
}

// --- Exports the JS tests above don't cover ----------------------------------------------------------------------

#[test]
fn strip_codex_config_takes_out_every_root_entry_the_guard_refuses_and_keeps_the_rest() {
    let text = [
        "\u{FEFF}# kept",
        "check_for_update_on_startup = false",
        "openai_base_url = \"http://x\"",
        "model = \"gpt-6.1-sol\"",
        "[mcp_servers.leak]",
        "command = \"node\"",
        "# a comment in a dropped table",
        "",
        "[projects.\"/w\"]",
        "trust_level = \"trusted\"",
        "[[profiles.evil]]",
        "model_provider = \"x\"",
        "[mcp_servers.again]",
        "command = \"y\"",
    ]
    .join("\r\n");
    let stripped = strip_codex_config(&text).unwrap();
    assert_eq!(stripped.removed, ["openai_base_url", "mcp_servers", "profiles"]);
    assert_eq!(
        stripped.text,
        [
            "# kept",
            "check_for_update_on_startup = false",
            "model = \"gpt-6.1-sol\"",
            "[projects.\"/w\"]",
            "trust_level = \"trusted\"",
        ]
        .join("\r\n")
    );
    assert_eq!(
        codex_root_names(&stripped.text).unwrap(),
        ["check_for_update_on_startup", "model", "projects"]
    );
    assert_eq!(strip_codex_config("model = \"\"\"\nx\n\"\"\""), Err(UnreadableToml));
    let unix = strip_codex_config("notify = 1\nmodel = \"m\"\n").unwrap();
    assert_eq!(unix.text, "model = \"m\"\n");
}

#[test]
fn checked_provider_key_trims_quotes_refuses_a_wrong_or_broken_key_and_local_ais_is_optional() {
    let deepseek = p("deepseek");
    let own = key("deepseek").unwrap();
    assert_eq!(
        checked_provider_key(&deepseek, Some(&format!(" \"{own}\" "))).unwrap(),
        Some(own.clone())
    );
    assert_eq!(
        checked_provider_key(&deepseek, Some(&format!("\u{FEFF}'{own}'\n"))).unwrap(),
        Some(own.clone())
    );
    assert_eq!(
        code_of(checked_provider_key(&deepseek, Some("\"a\nb\""))),
        Some(CredentialCode::BadKey)
    );
    assert_eq!(
        code_of(checked_provider_key(&deepseek, None)),
        Some(CredentialCode::NeedsKey)
    );
    assert_eq!(checked_provider_key(&p("local"), Some("  ")).unwrap(), None);
    assert_eq!(
        code_of(checked_provider_key(
            &p("local"),
            Some(&format!("sk-or-{}", "v1-test-fake"))
        )),
        Some(CredentialCode::BadKey)
    );
    let mut nameless = p("deepseek");
    nameless.wrong_slot = vec![slot("^bad", "")];
    assert_eq!(
        checked_provider_key(&nameless, Some("bad-key"))
            .unwrap_err()
            .to_string(),
        "That isn't a DeepSeek key."
    );
    assert!(checked_provider_key("deepseek", Some("x")).unwrap_err().is_type_error());
}

#[test]
fn codex_chatgpt_test_hosts_points_both_of_chatgpts_hosts_at_the_fake_in_tests_only() {
    let env = env_of(&[
        ("NODE_ENV", "test"),
        ("TARSEE_TEST_BASE_URL_CHATGPT", "http://127.0.0.1:4555//"),
    ]);
    assert_eq!(
        codex_chatgpt_test_hosts(&env),
        Some(ChatgptTestHosts {
            chatgpt_base_url: "http://127.0.0.1:4555/backend-api/".into(),
            openai_base_url: "http://127.0.0.1:4555/backend-api/codex".into(),
        })
    );
    env.set("NODE_ENV", "production");
    assert_eq!(codex_chatgpt_test_hosts(&env), None);
}

#[test]
fn the_constants_are_the_js_ones() {
    assert_eq!(HOST_MANAGED, [("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1")]);
    assert_eq!(
        CODEX_SHELL_EXCLUDED,
        [
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "TARSEE_MCP_TOKEN",
            "TARSEE_PROVIDER_KEY",
            "TARSEE_CHATGPT_ACCESS_TOKEN"
        ]
    );
    assert_eq!(TARSEE_SECRETS, ["ENCRYPTION_KEY", "SETUP_PASSWORD", "TARSEE_API_TOKEN"]);
    assert_eq!(CredentialCode::CredentialIsolation.as_str(), "credential-isolation");
    assert_eq!(
        serde_json::to_value(CredentialCode::NeedsMcpToken).unwrap(),
        serde_json::json!("needs-mcp-token")
    );
}

#[test]
fn node_paths_normalize_join_and_resolve_as_node_does() {
    assert_eq!(normalize_path(Path::new("a/./b/../c")), Path::new("a").join("c"));
    assert_eq!(normalize_path(Path::new("../a/..")), PathBuf::from(".."));
    assert_eq!(normalize_path(Path::new("")), PathBuf::from("."));
    assert_eq!(
        node_join(Path::new("x"), &[".claude", "settings.json"]),
        Path::new("x").join(".claude").join("settings.json")
    );
    let resolved = resolve_path(Path::new("rel/home"));
    assert!(resolved.is_absolute());
    assert!(resolved.ends_with(Path::new("rel").join("home")));
    assert_eq!(
        resolve_path(Path::new("x/.claude-home-a/.")).file_name().unwrap(),
        ".claude-home-a"
    );
}
