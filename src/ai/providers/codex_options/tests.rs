//! Port of `test/codex-options.test.js`, and the whole option object checked against the Node code's.
//!
//! The Codex engine's options (design 4.8 and R1/R2/R3/R7): for each provider a Codex turn runs on,
//! `build_codex_options` gives the child's environment, the --config overrides, the API key and the thread options.
//! Every key, token and secret here is an obvious fake, and the server's environment is full of canaries: none may
//! reach the config, the command line or (beyond the provider's own credential) the environment.
//!
//! `node-cases.json` holds what the Node function gave for every provider with and without each optional input, and
//! what the helpers answered (made by `docs/rust-port/reports/A5-capture-options.mjs.txt`); the `node_*` tests below
//! build the same and compare.

use std::path::Path;

use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;
use crate::ai::engine_env::{CODEX_CONFIG_ALLOWED, HomeOpts, codex_config_guard, home_for, node_join};
use crate::ai::preamble::build_preamble;

const NODE_CASES: &str = include_str!("node-cases.json");

const STATE: &str = "/state/tarsee-codex-options-state";
const WS: &str = "/ws/tarsee-codex-options-ws";
const MCP_URL: &str = "http://127.0.0.1:45678/mcp";
const MCP_TOKEN: &str = "mcp-test-token-0123456789abcdef";

fn key(id: &str) -> Option<&'static str> {
    match id {
        "openai" => Some("sk-test-canary-own-openai-key"),
        "openrouter" => Some("sk-or-v1-testcanaryownopenrouterkey"),
        "deepseek" => Some("sk-testcanaryowndeepseekkey0001"),
        "local" => Some("sk-test-canary-own-local-key"),
        _ => None,
    }
}

const CANARIES: [(&str, &str); 13] = [
    ("OPENAI_API_KEY", "sk-test-canary-railway-openai"),
    ("OPENROUTER_API_KEY", "sk-or-v1-testcanaryrailway"),
    ("DEEPSEEK_API_KEY", "sk-testcanaryrailwaydeepseek"),
    ("TARSEE_LOCAL_AI_KEY", "sk-test-canary-railway-local"),
    ("CODEX_API_KEY", "sk-test-canary-codex-api-key"),
    ("CODEX_HOME", "/canary/home"),
    ("CODEX_ACCESS_TOKEN", "sk-test-canary-access"),
    ("OPENAI_BASE_URL", "http://canary.invalid/v1"),
    ("ANTHROPIC_API_KEY", "sk-ant-api03-testcanary"),
    ("ENCRYPTION_KEY", "sk-test-canary-enc"),
    ("TARSEE_PROVIDER_KEY", "sk-test-canary-provider-key"),
    ("TARSEE_MCP_TOKEN", "sk-test-canary-mcp"),
    ("TARSEE_CHATGPT_ACCESS_TOKEN", "sk-test-canary-chatgpt"),
];

fn server_pairs() -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = [("PATH", "/usr/bin"), ("HOME", "/home/node"), ("LANG", "C.UTF-8")]
        .iter()
        .chain(CANARIES.iter())
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    pairs.sort();
    pairs
}

fn server() -> Env {
    Env::from_pairs(server_pairs())
}

fn vault() -> EnvMap {
    EnvMap::from([("SCRIPT_KEY".to_string(), "script-key-from-the-vault".to_string())])
}

/// A Local AI turn's bridge (local_bridge open()): its loopback address and its per-turn token.
const BRIDGE_URL: &str = "http://127.0.0.1:45999/t/bridge-test-turn-01234/v1";
const BRIDGE_TOKEN: &str = "bridge-test-token-0123456789abcdefABCDEF";

fn base_ctx(id: &str, state: &str, workspace: &str) -> CodexContext {
    CodexContext {
        env: server(),
        vault_env: vault(),
        state_dir: Some(PathBuf::from(state)),
        workspace: Some(PathBuf::from(workspace)),
        mcp: Some(McpGrant {
            url: MCP_URL.into(),
            token: MCP_TOKEN.into(),
        }),
        key: key(id).map(str::to_string),
        developer_instructions: Some("You are Tarsee.".into()),
        local_url: (id == "local").then(|| "http://ollama.railway.internal:11434/v1".to_string()),
        local_bridge: (id == "local").then(|| BridgeAddress {
            url: BRIDGE_URL.into(),
            token: BRIDGE_TOKEN.into(),
        }),
        ..CodexContext::default()
    }
}

fn target(id: &str, model: Option<&str>, effort: Option<&str>) -> CodexTarget {
    CodexTarget {
        provider_id: id.to_string(),
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
    }
}

fn build_with(
    id: &str,
    model: Option<&str>,
    change: impl FnOnce(&mut CodexContext),
) -> Result<CodexOptions, EngineEnvError> {
    let mut ctx = base_ctx(id, STATE, WS);
    change(&mut ctx);
    build_codex_options(&target(id, model, None), &ctx)
}

fn build(id: &str) -> CodexOptions {
    build_with(id, None, |_| {}).unwrap()
}

/// Every string anywhere in a value.
fn strings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|x| strings(x, out)),
        Value::Object(fields) => fields.values().for_each(|x| strings(x, out)),
        _ => {}
    }
}

fn all_strings(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    strings(v, &mut out);
    out
}

fn env_strings(env: &EnvMap) -> Vec<String> {
    env.values().cloned().collect()
}

fn args(o: &CodexOptions) -> Vec<String> {
    config_args(&o.config).unwrap()
}

fn code_of(err: EngineEnvError) -> Option<&'static str> {
    err.code().map(CredentialCode::as_str)
}

// --- build_codex_options: per provider ---------------------------------------------------------------------------

#[test]
fn openai_the_key_only_as_the_api_key_codex_api_key_in_the_child_openais_host_named_explicitly_api_login_only() {
    let o = build_with("openai", Some("gpt-6.1-sol"), |_| {}).unwrap();
    assert_eq!(o.api_key.as_deref(), key("openai"));
    assert_eq!(
        o.env["CODEX_HOME"],
        node_join(Path::new(STATE), &[".codex-home-keys"]).to_string_lossy()
    );
    assert_eq!(o.home, node_join(Path::new(STATE), &[".codex-home-keys"]));
    assert_eq!(o.env["TARSEE_MCP_TOKEN"], MCP_TOKEN);
    assert_eq!(
        o.env.get("CODEX_API_KEY"),
        None,
        "the engine adds CODEX_API_KEY itself, from the API key"
    );
    assert_eq!(o.config["forced_login_method"], "api");
    assert_eq!(o.config["openai_base_url"], "https://api.openai.com/v1");
    assert!(o.config.get("model_provider").is_none());
    assert!(o.config.get("model_providers").is_none());
    assert_eq!(o.thread_options.model.as_deref(), Some("gpt-6.1-sol"));
}

#[test]
fn chatgpt_codexs_own_sign_in_in_codex_home_no_key_at_all_chatgpt_login_only_no_host_of_tarsees() {
    let o = build_with("chatgpt", None, |c| c.account_models = Some(vec![])).unwrap();
    assert_eq!(o.api_key, None);
    assert_eq!(o.home, node_join(Path::new(STATE), &[".codex-home"]));
    assert_eq!(o.env.get("TARSEE_PROVIDER_KEY"), None);
    assert_eq!(o.config["forced_login_method"], "chatgpt");
    assert!(o.config.get("openai_base_url").is_none());
    assert!(o.config.get("chatgpt_base_url").is_none());
    assert!(o.config.get("model_provider").is_none());
}

#[test]
fn openrouter_a_custom_responses_provider_on_openrouters_host_the_key_as_tarsee_provider_key_the_attribution_header() {
    let o = build_with("openrouter", Some("openai/gpt-6.1-sol"), |c| {
        c.app_title = Some("My Tarsee".into());
        c.referer = Some("https://example.com".into());
    })
    .unwrap();
    assert_eq!(o.api_key, None);
    assert_eq!(o.env.get("TARSEE_PROVIDER_KEY").map(String::as_str), key("openrouter"));
    assert_eq!(o.env.get("OPENROUTER_API_KEY"), None);
    assert_eq!(o.config["model_provider"], "tarsee_openrouter");
    assert_eq!(
        o.config["model_providers"]["tarsee_openrouter"],
        json!({
            "name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "env_key": "TARSEE_PROVIDER_KEY", "wire_api": "responses",
            "http_headers": {"X-OpenRouter-Title": "My Tarsee", "HTTP-Referer": "https://example.com"},
        })
    );
    assert_eq!(o.config["forced_login_method"], "api");
    assert_eq!(o.thread_options.model.as_deref(), Some("openai/gpt-6.1-sol"));
    // The default title, and no referer unless the owner set one.
    assert_eq!(
        build_with("openrouter", Some("openai/x"), |_| {}).unwrap().config["model_providers"]["tarsee_openrouter"]["http_headers"],
        json!({"X-OpenRouter-Title": "Tarsee"})
    );
}

#[test]
fn deepseek_the_alternative_engine_deepseeks_responses_host_the_key_as_tarsee_provider_key() {
    let o = build_with("deepseek", Some("deepseek-flash"), |_| {}).unwrap();
    assert_eq!(o.env.get("TARSEE_PROVIDER_KEY").map(String::as_str), key("deepseek"));
    assert_eq!(o.config["model_provider"], "tarsee_deepseek");
    let p = &o.config["model_providers"]["tarsee_deepseek"];
    assert_eq!(p["base_url"], "https://api.deepseek.com");
    assert_eq!(p["wire_api"], "responses");
    assert_eq!(p["env_key"], "TARSEE_PROVIDER_KEY");
    assert_eq!(o.config["forced_login_method"], "api");
    assert_eq!(o.thread_options.model.as_deref(), Some("deepseek-flash"));
}

#[test]
fn local_the_turns_bridge_address_the_bridges_token_as_its_key_never_the_owners_and_the_models_context_window() {
    let o = build_with("local", Some("llama3.1:8b"), |c| c.context_tokens = Some(32_000.0)).unwrap();
    let p = &o.config["model_providers"]["tarsee_local"];
    assert_eq!(o.config["model_provider"], "tarsee_local");
    assert_eq!(
        p["base_url"], BRIDGE_URL,
        "Codex talks to the bridge, which passes the requests on to the owner's server"
    );
    assert_eq!(p["env_key"], "TARSEE_PROVIDER_KEY");
    assert_eq!(o.env["TARSEE_PROVIDER_KEY"], BRIDGE_TOKEN);
    // The owner's key and address appear nowhere in what the Codex process gets: its environment, its config, argv.
    let everything: Vec<String> = env_strings(&o.env)
        .into_iter()
        .chain(all_strings(&o.config))
        .chain(args(&o))
        .collect();
    assert!(
        !everything.iter().any(|s| s.contains(key("local").unwrap())),
        "the owner's Local AI key never reaches the Codex process"
    );
    assert!(
        !everything.iter().any(|s| s.contains("ollama.railway.internal")),
        "nor the owner's address"
    );
    assert!(
        !args(&o).iter().any(|s| s.contains(BRIDGE_TOKEN)),
        "the bridge's token is in the environment only, never on the command line"
    );
    assert_eq!(o.config["model_context_window"], 32_000);
    // A server that sends its headers and then nothing (a wedged GPU, a model too big for its memory): Codex waits 5
    // minutes per try, so one retry, not five, gives up in about 10 minutes and lets the backup model answer.
    assert_eq!(p["stream_max_retries"], 1);
    assert!(
        p.get("stream_idle_timeout_ms").is_none(),
        "Codex's own 5 minutes: a slow local model still answers"
    );
    for (id, model) in [("openrouter", "openai/x"), ("deepseek", "deepseek-flash")] {
        let o = build_with(id, Some(model), |_| {}).unwrap();
        assert!(
            o.config["model_providers"][format!("tarsee_{id}")]
                .get("stream_max_retries")
                .is_none(),
            "{id}"
        );
    }
    // A server with no key: Codex still carries the bridge's token, which the bridge checks and never passes on.
    let keyless = build_with("local", Some("llama3.1:8b"), |c| c.key = None).unwrap();
    assert_eq!(
        keyless.config["model_providers"]["tarsee_local"]["env_key"],
        "TARSEE_PROVIDER_KEY"
    );
    assert_eq!(keyless.env["TARSEE_PROVIDER_KEY"], BRIDGE_TOKEN);
    // No bridge is a caller's mistake, never a quiet fall back to the owner's server with the owner's key.
    assert!(
        build_with("local", Some("llama3.1:8b"), |c| c.local_bridge = None)
            .unwrap_err()
            .is_type_error()
    );
    let no_token = build_with("local", Some("llama3.1:8b"), |c| {
        c.local_bridge = Some(BridgeAddress {
            url: BRIDGE_URL.into(),
            token: String::new(),
        })
    });
    assert!(no_token.unwrap_err().is_type_error());
}

#[test]
fn refuses_before_anything_starts_a_missing_key_local_ai_without_an_address_a_provider_codex_doesnt_run() {
    for id in ["openai", "openrouter", "deepseek"] {
        assert_eq!(
            code_of(build_with(id, None, |c| c.key = Some(String::new())).unwrap_err()),
            Some("needs-key"),
            "{id}"
        );
    }
    assert_eq!(
        code_of(build_with("local", None, |c| c.local_url = Some(String::new())).unwrap_err()),
        Some("needs-setup")
    );
    assert_eq!(
        code_of(build_with("anthropic", None, |_| {}).unwrap_err()),
        Some("wrong-engine")
    );
    assert_eq!(
        code_of(build_with("claude", None, |_| {}).unwrap_err()),
        Some("wrong-engine")
    );
    let nope = build_with("nope", None, |_| {}).unwrap_err();
    assert!(
        nope.is_type_error() && nope.to_string().to_lowercase().contains("provider"),
        "{nope}"
    );
    assert_eq!(
        code_of(build_with("openai", None, |c| c.mcp = None).unwrap_err()),
        Some("needs-mcp-token")
    );
    assert!(
        build_with("openai", None, |c| c.workspace = Some(PathBuf::new()))
            .unwrap_err()
            .is_type_error()
    );
}

// --- build_codex_options: what every Codex turn gets -------------------------------------------------------------

const ALL: [&str; 5] = ["chatgpt", "openai", "openrouter", "deepseek", "local"];

#[test]
fn full_access_no_approvals_the_workspace_no_git_check_no_web_search_the_skills_folder() {
    for id in ALL {
        let t = build_with(id, Some("m"), |c| c.skills_dir = Some("/app/skills".into()))
            .unwrap()
            .thread_options;
        assert_eq!(t.sandbox_mode, "danger-full-access", "{id}");
        assert_eq!(t.approval_policy, "never", "{id}");
        assert_eq!(t.working_directory, Path::new(WS), "{id}");
        assert!(t.skip_git_repo_check, "{id}");
        assert_eq!(t.web_search_mode, "disabled", "{id}");
        assert!(t.network_access_enabled, "{id}");
        assert_eq!(
            t.additional_directories,
            Some(vec![PathBuf::from("/app/skills")]),
            "{id}"
        );
    }
}

#[test]
fn tarsees_tools_as_a_streamable_http_mcp_server_the_grants_url_the_token_by_env_name_tool_calls_approved() {
    for id in ALL {
        let m = build(id).config["mcp_servers"].clone();
        assert_eq!(m.as_object().unwrap().keys().collect::<Vec<_>>(), ["tarsee"], "{id}");
        assert_eq!(m["tarsee"]["url"], MCP_URL, "{id}");
        assert_eq!(m["tarsee"]["bearer_token_env_var"], "TARSEE_MCP_TOKEN", "{id}");
        assert_eq!(m["tarsee"]["default_tools_approval_mode"], "approve", "{id}");
        assert_eq!(m["tarsee"]["required"], true, "{id}");
        let timeout = m["tarsee"]["tool_timeout_sec"].as_u64().unwrap();
        assert!(timeout >= 180 && timeout == MCP_TOOL_TIMEOUT_SEC, "{id}");
        assert!(m["tarsee"]["startup_timeout_sec"].as_u64().unwrap() > 0, "{id}");
    }
}

#[test]
fn the_shell_inherits_everything_vault_keys_reach_scripts_except_the_engines_own_credentials_r7() {
    let mut excluded = CODEX_SHELL_EXCLUDED.to_vec();
    excluded.sort();
    assert_eq!(
        excluded,
        [
            "CODEX_ACCESS_TOKEN",
            "CODEX_API_KEY",
            "TARSEE_CHATGPT_ACCESS_TOKEN",
            "TARSEE_MCP_TOKEN",
            "TARSEE_PROVIDER_KEY"
        ]
    );
    for id in ALL {
        let p = build(id).config["shell_environment_policy"].clone();
        assert_eq!(p["inherit"], "all", "{id}");
        assert_eq!(p["ignore_default_excludes"], true, "{id}");
        let filters: Map<String, Value> = CODEX_SHELL_EXCLUDED
            .iter()
            .map(|n| (n.to_string(), json!("exclude")))
            .collect();
        assert_eq!(p["filters"], Value::Object(filters), "{id}");
    }
}

#[test]
fn the_fixed_settings_instructions_no_agents_md_no_history_file_sign_in_kept_in_a_file_no_update_check() {
    for id in ALL {
        let o = build(id);
        let c = &o.config;
        assert_eq!(c["developer_instructions"], "You are Tarsee.", "{id}");
        assert_eq!(c["project_doc_max_bytes"], 0, "{id}");
        assert_eq!(c["history"], json!({"persistence": "none"}), "{id}");
        assert_eq!(c["cli_auth_credentials_store"], "file", "{id}");
        assert_eq!(c["check_for_update_on_startup"], false, "{id}");
        assert_eq!(c["tool_output_token_limit"], 3000, "{id}");
        // ChatGPT's apps, plugins, extra agents and goals stay off: Tarsee's own tools do those jobs. Hooks too: a
        // hook is a program Codex would run with the turn's whole environment, the engine's own key included.
        for f in ["apps", "plugins", "multi_agent", "goals", "hooks"] {
            assert_eq!(c["features"][f], false, "{id} {f}");
        }
        // No project root above the workspace: Codex would otherwise load a .codex/config.toml from every folder
        // between the nearest git root and the workspace (an mcp_servers entry there gets the turn's key), and the
        // guard reads only the workspace's own.
        assert_eq!(c["project_root_markers"], json!([]), "{id}");
        assert!(args(&o).contains(&"project_root_markers=[]".to_string()), "{id}");
    }
}

#[test]
fn thinking_summaries_only_when_asked_and_the_compact_limit_is_the_smaller_of_the_window_setting_and_85_percent_of_the_context()
 {
    assert_eq!(build("openai").config["model_reasoning_summary"], "none");
    assert_eq!(
        build_with("openai", None, |c| c.thinking_summaries = true)
            .unwrap()
            .config["model_reasoning_summary"],
        "concise"
    );
    let limit = |id: &str, context: f64, window: f64| {
        build_with(id, None, |c| {
            c.context_tokens = Some(context);
            c.compact_window = Some(window);
        })
        .unwrap()
        .config["model_auto_compact_token_limit"]
            .clone()
    };
    assert_eq!(limit("openai", 400_000.0, 180_000.0), 180_000);
    assert_eq!(limit("local", 32_000.0, 180_000.0), 27_200);
}

#[test]
fn the_environment_no_canary_from_the_servers_environment_the_vaults_keys_the_turns_mark() {
    for id in ALL {
        let o = build_with(id, None, |c| c.turn_mark = Some("turn-mark-1".into())).unwrap();
        for (name, value) in CANARIES {
            // Local AI's TARSEE_PROVIDER_KEY is its bridge's token; every other key provider's is its own key.
            let own_key = if id == "local" { Some(BRIDGE_TOKEN) } else { key(id) };
            let got = o.env.get(name).map(String::as_str);
            let own = (name == "TARSEE_MCP_TOKEN" && got == Some(MCP_TOKEN))
                || (name == "TARSEE_PROVIDER_KEY" && got == own_key)
                || (name == "CODEX_HOME" && got != Some(value));
            if !own {
                assert_eq!(got, None, "{id}: {name}");
            }
            assert!(!o.env.values().any(|v| v == value), "{id}: the value of {name}");
        }
        assert_eq!(o.env["SCRIPT_KEY"], "script-key-from-the-vault", "{id}");
        assert_eq!(o.env["TARSEE_CODEX_TURN"], "turn-mark-1", "{id}");
    }
}

#[test]
fn no_secret_in_the_config_or_on_the_command_line_for_any_provider() {
    let mut secrets: Vec<String> = ["openai", "openrouter", "deepseek", "local"]
        .iter()
        .filter_map(|id| key(id))
        .map(str::to_string)
        .collect();
    secrets.push(MCP_TOKEN.into());
    secrets.extend(CANARIES.iter().map(|(_, v)| v.to_string()));
    for id in ALL {
        let mut ctx = base_ctx(id, STATE, WS);
        ctx.context_tokens = None;
        let o = build_codex_options(&target(id, Some("m"), Some("high")), &ctx).unwrap();
        let thread = serde_json::to_value(&o.thread_options).unwrap();
        let argv = format!("{}\n{}", args(&o).join("\n"), all_strings(&thread).join("\n"));
        for s in &secrets {
            assert!(
                !argv.contains(s.as_str()),
                "{id}: {}… on the command line",
                &s[..s.len().min(24)]
            );
        }
        assert!(!all_strings(&o.config).iter().any(|v| secrets.contains(v)), "{id}");
    }
}

#[test]
fn config_args_flattens_the_config_the_way_the_sdk_does_dotted_keys_toml_values() {
    let got = config_args(&json!({"a": {"b": "x", "c": 2}, "d": [true, "y"], "e": {}})).unwrap();
    assert_eq!(got, ["a.b=\"x\"", "a.c=2", "d=[true, \"y\"]", "e={}"]);
}

// --- models and effort -------------------------------------------------------------------------------------------

#[test]
fn chatgpt_names_only_a_model_the_accounts_live_list_has_its_default_included_none_when_the_list_is_missing_or_lacks_it()
 {
    let list = vec![
        json!({"id": "gpt-6-luna", "default": true, "efforts": ["low", "medium"]}),
        json!({"id": "gpt-6-luna-mini", "efforts": ["low"]}),
    ];
    assert_eq!(
        codex_model_for("chatgpt", Some("gpt-6-luna-mini"), Some(&list)).as_deref(),
        Some("gpt-6-luna-mini")
    );
    // The account's default is named too: left out, a `model` in the home's config.toml (the Terminal's /model writes
    // one there, and the guard allows it) would run instead of the one Tarsee shows and records.
    assert_eq!(
        codex_model_for("chatgpt", Some("gpt-6-luna"), Some(&list)).as_deref(),
        Some("gpt-6-luna")
    );
    assert_eq!(codex_model_for("chatgpt", Some("default"), Some(&list)), None);
    assert_eq!(
        codex_model_for("chatgpt", Some("gpt-6.1-sol"), Some(&list)),
        None,
        "not on this account's list"
    );
    assert_eq!(
        codex_model_for("chatgpt", Some("gpt-6-luna-mini"), Some(&[])),
        None,
        "no live list: Codex's own default"
    );
    assert_eq!(
        codex_model_for("chatgpt", Some("gpt-6-luna-mini"), None),
        None,
        "no list at all: Codex's own default"
    );
    assert_eq!(codex_model_for("chatgpt", Some(""), Some(&list)), None);
    let chatgpt = |model: &str, effort: Option<&str>| {
        let mut ctx = base_ctx("chatgpt", STATE, WS);
        ctx.account_models = Some(list.clone());
        build_codex_options(&target("chatgpt", Some(model), effort), &ctx)
            .unwrap()
            .thread_options
    };
    assert_eq!(
        chatgpt("gpt-6-luna-mini", None).model.as_deref(),
        Some("gpt-6-luna-mini")
    );
    assert_eq!(chatgpt("gpt-6-luna", None).model.as_deref(), Some("gpt-6-luna"));
    // ...and the default's own efforts apply: a level it doesn't take is not sent.
    assert_eq!(chatgpt("gpt-6-luna", Some("high")).model_reasoning_effort, None);
    assert_eq!(
        chatgpt("gpt-6-luna", Some("medium")).model_reasoning_effort.as_deref(),
        Some("medium")
    );
}

#[test]
fn every_other_provider_passes_its_model_through_and_none_at_all_means_codexs_default() {
    assert_eq!(
        codex_model_for("openai", Some("gpt-6.1-sol"), None).as_deref(),
        Some("gpt-6.1-sol")
    );
    assert_eq!(
        codex_model_for("local", Some("llama3.1:8b"), None).as_deref(),
        Some("llama3.1:8b")
    );
    assert_eq!(codex_model_for("openai", Some("default"), None), None);
    assert_eq!(codex_model_for("openai", None, None), None);
}

#[test]
fn effort_tarsees_levels_go_through_anything_else_is_dropped_and_a_models_own_list_is_respected() {
    for e in ["low", "medium", "high", "xhigh", "max"] {
        assert_eq!(codex_effort(Some(e), None).as_deref(), Some(e));
    }
    assert_eq!(codex_effort(Some("turbo"), None), None);
    assert_eq!(codex_effort(None, None), None);
    assert_eq!(codex_effort(Some("max"), Some(&json!(["low", "medium"]))), None);
    assert_eq!(
        codex_effort(Some("low"), Some(&json!(["low", "medium"]))).as_deref(),
        Some("low")
    );
    let list = vec![json!({"id": "gpt-6-luna-mini", "efforts": ["low"]})];
    let effort = |e: &str| {
        let mut ctx = base_ctx("chatgpt", STATE, WS);
        ctx.account_models = Some(list.clone());
        build_codex_options(&target("chatgpt", Some("gpt-6-luna-mini"), Some(e)), &ctx)
            .unwrap()
            .thread_options
            .model_reasoning_effort
    };
    assert_eq!(effort("high"), None);
    assert_eq!(effort("low").as_deref(), Some("low"));
    let openai = build_codex_options(
        &target("openai", Some("gpt-6.1-sol"), Some("xhigh")),
        &base_ctx("openai", STATE, WS),
    )
    .unwrap();
    assert_eq!(openai.thread_options.model_reasoning_effort.as_deref(), Some("xhigh"));
}

// --- developer instructions --------------------------------------------------------------------------------------

#[test]
fn fit_under_the_per_argument_limit_24_kb_on_windows_96_kb_elsewhere() {
    assert_eq!(instructions_limit("win32"), 24 * 1024);
    assert_eq!(instructions_limit("linux"), 96 * 1024);
}

/// Half of a surrogate pair anywhere in the text (`[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]`):
/// a Rust string cannot hold one, so the check is that every character survived whole, which is what that pattern
/// guarded.
fn has_half_character(text: &str) -> bool {
    text.contains('\u{FFFD}')
}

#[test]
fn an_oversized_prompt_loses_its_saved_memories_first_then_its_middle_never_the_preamble_or_the_end_never_a_surrogate_half()
 {
    // The instructions as a Codex turn builds them (codex.rs): the preamble, the workspace CLAUDE.md, then the stable
    // part (workspace files, the database's quick memories, skills, the conversation's prompt, the channel hint).
    let preamble = build_preamble(Some("codex"), "/data/tarsee/workspace", "UTC");
    let claude_md = format!(
        "## Workspace instructions (CLAUDE.md)\n\n{}",
        "Keep the workspace tidy and log what you do.\n".repeat(150)
    );
    let files = format!(
        "<!-- SOUL.md -->\n{}",
        "I am calm and precise, and I say so when I don't know.\n".repeat(150)
    );
    let memories = format!(
        "\n\nAdditional quick memories (shortened; search memory for the full note):\n{}",
        (0..300)
            .map(|i| format!("- [fact] remembered fact number {i} about the owner's projects"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let skills = "\n\n## Skills\n- pdf: make PDF files\n- browser: browse the web";
    let conversation_prompt = "\n\nThis conversation's own prompt: answer in French.";
    let channel_hint = "\n\nYou are talking on Telegram. Send a file with send_file, as an attachment.";
    let stable = format!("{files}{memories}{skills}{conversation_prompt}{channel_hint}");
    let text = [preamble.as_str(), &claude_md, &stable].join("\n\n");
    let limit = 24 * 1024;
    assert!(text.len() > limit, "the fixture is over the Windows limit");

    let fit = cap_instructions(&text, limit);
    assert!(fit.len() <= limit, "{} bytes", fit.len());
    assert!(fit.starts_with(&preamble), "the whole preamble survives");
    assert!(
        fit.contains("## Memory\nUse remember for durable facts."),
        "and its memory-tool instructions"
    );
    assert!(fit.contains("Additional quick memories"), "the memories' heading stays");
    assert!(
        fit.contains("remembered fact number 0 ") && !fit.contains("remembered fact number 299 "),
        "the saved memories are trimmed first"
    );
    assert!(
        fit.contains("## Skills")
            && fit.contains(js::trim(conversation_prompt))
            && fit.ends_with(js::trim(channel_hint)),
        "the end survives"
    );
    assert!(
        fit.contains(&claude_md[..200]),
        "the workspace instructions too, when trimming the memories is enough"
    );

    // Not enough even without the memories: the middle goes (the workspace files), and both ends stay.
    let huge = [
        preamble.as_str(),
        &claude_md,
        &format!(
            "{}{memories}{skills}{conversation_prompt}{channel_hint}",
            files.repeat(6)
        ),
    ]
    .join("\n\n");
    let cut = cap_instructions(&huge, limit);
    assert!(cut.len() <= limit, "{} bytes", cut.len());
    assert!(cut.starts_with(&preamble), "the preamble survives");
    assert!(
        cut.ends_with(js::trim(channel_hint)) && cut.contains(js::trim(conversation_prompt)),
        "the conversation's prompt and the channel hint survive"
    );
    assert!(cut.contains("trimmed to fit"));
    assert!(
        !has_half_character(&cap_instructions(&format!("{}end", "😀".repeat(5000)), 1001)),
        "never half a character"
    );

    let plain = cap_instructions(&format!("{}😀", "x".repeat(10_000)), 1000);
    assert!(plain.len() <= 1000);
    assert!(!has_half_character(&plain));
    assert_eq!(cap_instructions("short", 1000), "short");
    // ("a\uD800b" can't be written in Rust: a string never holds half a surrogate pair.)
}

#[test]
fn build_applies_the_platforms_limit() {
    let big = "y".repeat(40 * 1024);
    let instructions = |platform: &str| {
        build_with("openai", None, |c| {
            c.developer_instructions = Some(big.clone());
            c.platform = Some(platform.into());
        })
        .unwrap()
        .config["developer_instructions"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert!(instructions("win32").len() <= 24 * 1024);
    assert_eq!(instructions("linux").len(), big.len());
}

// --- the test-only ChatGPT hosts and the config allowlist --------------------------------------------------------

#[test]
fn chatgpts_hosts_move_only_in_tests_only_to_loopback() {
    let hosts = |pairs: &[(&str, &str)]| codex_chatgpt_test_hosts(&Env::from_pairs(pairs.iter().copied()));
    assert_eq!(
        hosts(&[("TARSEE_TEST_BASE_URL_CHATGPT", "http://127.0.0.1:9")]),
        None,
        "not without NODE_ENV=test"
    );
    assert_eq!(
        hosts(&[
            ("NODE_ENV", "test"),
            ("TARSEE_TEST_BASE_URL_CHATGPT", "http://canary.invalid")
        ]),
        None
    );
    let got = hosts(&[
        ("NODE_ENV", "test"),
        ("TARSEE_TEST_BASE_URL_CHATGPT", "http://127.0.0.1:9/"),
    ])
    .unwrap();
    assert_eq!(
        (got.chatgpt_base_url.as_str(), got.openai_base_url.as_str()),
        (
            "http://127.0.0.1:9/backend-api/",
            "http://127.0.0.1:9/backend-api/codex"
        )
    );
    let o = build_with("chatgpt", None, |c| {
        let env = server();
        env.set("NODE_ENV", "test");
        env.set("TARSEE_TEST_BASE_URL_CHATGPT", "http://127.0.0.1:9");
        c.env = env;
    })
    .unwrap();
    assert_eq!(o.config["chatgpt_base_url"], "http://127.0.0.1:9/backend-api/");
    assert_eq!(o.config["openai_base_url"], "http://127.0.0.1:9/backend-api/codex");
}

#[test]
fn the_guard_reads_a_trusted_folder_however_codex_spells_it_and_still_refuses_a_root_name_hidden_by_escapes() {
    let guard = |text: &'static str| {
        let read = move |_: &Path| -> std::io::Result<String> { Ok(text.to_string()) };
        codex_config_guard(&[PathBuf::from("config.toml")], Some(&read))
    };
    // What Codex writes when a folder is trusted from the Terminal: a literal string, or (a path with a ' in it,
    // which can't be one) a basic string with its backslashes escaped.
    assert!(guard("[projects.'C:\\Users\\owner\\workspace']\ntrust_level = \"trusted\"\n").ok);
    assert!(guard("[projects.\"C:\\\\Users\\\\O'Neil\\\\workspace\"]\ntrust_level = \"trusted\"\n").ok);
    assert!(guard("[projects.\"/data/a \\\"quoted\\\" name\"]\ntrust_level = \"trusted\"\n").ok);
    assert!(guard("[projects.\"/data/workspace\"]\ntrust_level = \"trusted\"\n").ok);
    // An escape in the root name could spell any name: refused, unread.
    for text in [
        "\"openai_base_u\\u0072l\" = \"http://x.invalid\"\n",
        "[\"mcp_serv\\u0065rs\".leak]\ncommand = \"node\"\n",
    ] {
        let r = guard(text);
        assert!(!r.ok, "{text}");
        assert!(r.files[0].unreadable, "{text}");
    }
    // A string that never closes, or an escape at the end of the line: unread.
    for text in ["[projects.\"C:\\\\x]\n", "[projects.\"C:\\\"]\n"] {
        assert!(!guard(text).ok, "{text}");
    }
    // A root entry after a trusted folder's table is still a root entry only in TOML's eyes when there is no table:
    // after a [table] line, keys belong to that table (so this one is harmless and passes).
    assert!(guard("model = \"m\"\n[projects.\"C:\\\\a\"]\ntrust_level = \"trusted\"\n").ok);
    assert!(!guard("openai_base_url = \"http://x.invalid\"\n[projects.\"C:\\\\a\"]\ntrust_level = \"trusted\"\n").ok);
}

#[test]
fn the_allowlist_has_what_codex_writes_itself_the_windows_sandbox_choice_features_personality_and_nothing_that_moves_traffic()
 {
    for k in [
        "windows",
        "features",
        "personality",
        "tui",
        "projects",
        "notice",
        "model",
        "model_reasoning_effort",
    ] {
        assert!(CODEX_CONFIG_ALLOWED.contains(&k), "{k}");
    }
    for k in [
        "openai_base_url",
        "chatgpt_base_url",
        "model_provider",
        "model_providers",
        "profile",
        "profiles",
        "mcp_servers",
        "notify",
        "plugins",
        "network",
        "shell_environment_policy",
        "otel",
        "analytics",
    ] {
        assert!(!CODEX_CONFIG_ALLOWED.contains(&k), "{k}");
    }
}

// --- The Node code's answers -------------------------------------------------------------------------------------

fn node_cases() -> Value {
    serde_json::from_str(NODE_CASES).expect("node-cases.json is JSON")
}

fn sha256(text: &str) -> Value {
    json!({"sha256": hex::encode(Sha256::digest(text.as_bytes())), "bytes": text.len()})
}

/// A long text as the capture wrote it: its digest.
fn short(text: &str) -> Value {
    if utf16_len(text) > 1000 {
        sha256(text)
    } else {
        json!(text)
    }
}

/// The base context the capture built (`base(id)`), with the case's changes.
fn node_ctx(provider: &str, change: &Value) -> CodexContext {
    let id = provider.trim().to_lowercase();
    let mut ctx = base_ctx(&id, "/state", "/ws");
    ctx.local_url = (id == "local").then(|| "http://ollama.internal:11434/v1".to_string());
    ctx.platform = Some("linux".into());
    let text = |v: &Value| v.as_str().map(str::to_string);
    for (name, v) in change.as_object().unwrap() {
        match name.as_str() {
            "env" => {
                ctx.env = Env::from_pairs(
                    v.as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())),
                )
            }
            "vaultEnv" => {
                ctx.vault_env = v
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                    .collect()
            }
            "key" => ctx.key = text(v),
            "stateDir" => ctx.state_dir = text(v).map(PathBuf::from),
            "home" => ctx.home = text(v).map(PathBuf::from),
            "workspace" => ctx.workspace = text(v).map(PathBuf::from),
            "mcp" => {
                ctx.mcp = v.as_object().map(|m| McpGrant {
                    url: m["url"].as_str().unwrap_or("").to_string(),
                    token: m.get("token").and_then(Value::as_str).unwrap_or("").to_string(),
                })
            }
            "developerInstructions" => {
                ctx.developer_instructions = match v {
                    Value::Object(digest) => {
                        // The 40 KiB of "y" the capture used.
                        let made = "y".repeat(digest["bytes"].as_u64().unwrap() as usize);
                        assert_eq!(sha256(&made), *v);
                        Some(made)
                    }
                    other => text(other),
                }
            }
            "localUrl" => ctx.local_url = text(v),
            "localBridge" => {
                ctx.local_bridge = v.as_object().map(|b| BridgeAddress {
                    url: b["url"].as_str().unwrap_or("").to_string(),
                    token: b.get("token").and_then(Value::as_str).unwrap_or("").to_string(),
                })
            }
            "appTitle" => ctx.app_title = text(v),
            "referer" => ctx.referer = text(v),
            "contextTokens" => ctx.context_tokens = v.as_f64(),
            "compactWindow" => ctx.compact_window = v.as_f64(),
            "thinkingSummaries" => ctx.thinking_summaries = v == true,
            "accountModels" => ctx.account_models = v.as_array().cloned(),
            "skillsDir" => ctx.skills_dir = text(v).map(PathBuf::from),
            "turnMark" => ctx.turn_mark = text(v),
            "platform" => ctx.platform = text(v),
            other => panic!("no such input: {other}"),
        }
    }
    ctx
}

fn error_json(err: &EngineEnvError) -> Value {
    match err {
        EngineEnvError::Credential(c) => {
            json!({"name": "CredentialError", "code": c.code.as_str(), "message": c.message})
        }
        EngineEnvError::Type(t) => json!({"name": "TypeError", "code": null, "message": t.0}),
    }
}

#[test]
fn node_build_codex_options_for_every_provider_with_and_without_each_optional_input() {
    let cases = node_cases();
    for case in cases["builds"].as_array().unwrap() {
        let input = &case["input"];
        let provider = input["provider"].as_str().unwrap();
        let ctx = node_ctx(provider, &input["change"]);
        let target = CodexTarget {
            provider_id: provider.to_string(),
            model: input["target"]["model"].as_str().map(str::to_string),
            effort: input["target"]["effort"].as_str().map(str::to_string),
        };
        let what = format!("{provider:?} {}", case["name"]);
        let built = build_codex_options(&target, &ctx);
        if let Some(want) = case.get("error") {
            assert_eq!(error_json(built.as_ref().map(|_| ()).unwrap_err()), *want, "{what}");
            continue;
        }
        let o = built.unwrap_or_else(|err| panic!("{what}: {err}"));
        // The home: the state folder's (or the one named), as Node's path.join made it on this system.
        let id = normalize_provider_id(provider).unwrap();
        let home = ctx.home.clone().unwrap_or_else(|| {
            home_for(
                id,
                CODEX,
                &HomeOpts {
                    state_dir: ctx.state_dir.clone(),
                    home_dir: None,
                },
            )
            .unwrap()
        });
        assert_eq!(o.home, home, "{what}");
        assert_eq!(o.env["CODEX_HOME"], home.to_string_lossy(), "{what}");
        #[cfg(windows)]
        assert_eq!(
            json!(o.home.to_string_lossy()),
            case["home"],
            "{what}: as the Node capture (made on Windows) has it"
        );
        let mut got = serde_json::to_value(&o).unwrap();
        let fields = got.as_object_mut().unwrap();
        fields.shift_remove("home");
        fields["env"].as_object_mut().unwrap().shift_remove("CODEX_HOME");
        let instructions = fields["config"]["developer_instructions"].as_str().unwrap().to_string();
        fields["config"]["developer_instructions"] = short(&instructions);
        let want = &case["out"];
        // The config in order, key by key (its order is the order of Codex's --config arguments).
        assert_eq!(
            crate::ai::local_bridge::js_stringify(&got["config"]),
            crate::ai::local_bridge::js_stringify(&want["config"]),
            "{what}"
        );
        assert_eq!(got, *want, "{what}");
        if let Some(want_args) = case.get("args") {
            let got_args: Vec<Value> = args(&o)
                .iter()
                .map(|a| if utf16_len(a) > 1000 { sha256(a) } else { json!(a) })
                .collect();
            assert_eq!(Value::Array(got_args), *want_args, "{what}");
        }
    }
}

#[test]
fn node_codex_effort() {
    let cases = node_cases();
    for case in cases["efforts"].as_array().unwrap() {
        let allowed = Some(&case[1]).filter(|a| !a.is_null());
        assert_eq!(json!(codex_effort(case[0].as_str(), allowed)), case[2], "{case}");
    }
}

#[test]
fn node_codex_model_for() {
    let cases = node_cases();
    for case in cases["models"].as_array().unwrap() {
        let list = case[2].as_array().map(Vec::as_slice);
        assert_eq!(
            json!(codex_model_for(case[0].as_str().unwrap(), case[1].as_str(), list)),
            case[3],
            "{case}"
        );
    }
}

#[test]
fn node_config_args() {
    let cases = node_cases();
    for case in cases["configArgs"].as_array().unwrap() {
        let got = match config_args(&case[0]) {
            Ok(list) => json!(list),
            Err(err) => json!({"name": "TypeError", "code": null, "message": err.0}),
        };
        assert_eq!(got, case[1], "{case}");
    }
}

/// The texts the capture cut, made again the same way.
fn cap_texts() -> Vec<String> {
    let preamble = format!(
        "# Preamble\n\n## Memory\nUse remember for durable facts.\n{}",
        "Tool notes line.\n".repeat(40)
    );
    let claude_md = format!(
        "## Workspace instructions (CLAUDE.md)\n\n{}",
        "Keep the workspace tidy and log what you do.\n".repeat(150)
    );
    let files = format!(
        "<!-- SOUL.md -->\n{}",
        "I am calm and precise, and I say so when I don't know.\n".repeat(150)
    );
    let memories = format!(
        "\n\nAdditional quick memories (shortened; search memory for the full note):\n{}",
        (0..300)
            .map(|i| format!("- [fact] remembered fact number {i} about the owner's projects"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let rest = "\n\n## Skills\n- pdf: make PDF files\n\nThis conversation's own prompt: answer in French.\n\nYou are talking on Telegram. Send a file with send_file, as an attachment.";
    vec![
        [preamble.as_str(), &claude_md, &format!("{files}{memories}{rest}")].join("\n\n"),
        [
            preamble.as_str(),
            &claude_md,
            &format!("{}{memories}{rest}", files.repeat(6)),
        ]
        .join("\n\n"),
        format!("{}end", "😀".repeat(5000)),
        format!("{}😀", "x".repeat(10_000)),
        "short".to_string(),
        format!("{}\n{}", "é".repeat(3000), "日本".repeat(2000)),
        format!(
            "start\r\nAdditional quick memories x\n- [a] one\n- [b] two\n\n\n\nend {}",
            "z".repeat(500)
        ),
        format!(
            "start\u{2028}Additional quick memories x\n- [a] one\n- [b] two\nend {}",
            "z".repeat(500)
        ),
        format!(
            "Additional quick memories at the very start\n- [a] {}\n- [b] b\nafter",
            "a".repeat(200)
        ),
        format!("no newline in the tail {}\nlast line", "w".repeat(3000)),
        "line\n".repeat(2000),
        // The tail's first line end exactly half way into it (at 1000 bytes the tail is the last 250): kept whole.
        format!("{}{}\n{}", "a".repeat(2000), "b".repeat(125), "c".repeat(124)),
        // The head's last line end exactly half way into it (at 1000 or 1001 bytes, whichever leaves an even head).
        {
            let head = [1000, 1001]
                .iter()
                .map(|max| max - TRIMMED_MIDDLE.len() - 250)
                .find(|h| h % 2 == 0)
                .unwrap();
            format!("{}\n{}{}", "a".repeat(head / 2), "a".repeat(5000), "c".repeat(250))
        },
    ]
}

#[test]
fn node_cap_instructions_on_every_size_around_its_edges() {
    let cases = node_cases();
    let texts = cap_texts();
    for case in cases["caps"].as_array().unwrap() {
        let text = &texts[case[0].as_u64().unwrap() as usize];
        let max = case[1].as_u64().unwrap() as usize;
        assert_eq!(
            sha256(&cap_instructions(text, max)),
            case[2],
            "text {} at {max}",
            case[0]
        );
    }
}

// --- More than the Node tests checked ----------------------------------------------------------------------------

#[test]
fn the_registry_entry_gives_engine_env_what_it_reads() {
    let entry = engine_entry(&PROVIDERS.openrouter);
    assert_eq!(entry.id, "openrouter");
    assert_eq!(entry.label.as_deref(), Some(PROVIDERS.openrouter.label));
    assert_eq!(entry.env_key.as_deref(), Some("OPENROUTER_API_KEY"));
    assert_eq!(
        entry.base_url.get("codex").map(String::as_str),
        Some("https://openrouter.ai/api/v1")
    );
    assert!(entry.engines.as_ref().unwrap().contains(&"codex".to_string()));
    assert_eq!(entry.wrong_slot.len(), PROVIDERS.openrouter.wrong_slot.len());
    assert_eq!(
        engine_entry(&PROVIDERS.claude).default_model.as_deref(),
        PROVIDERS.claude.default_model
    );
}

#[test]
fn compact_off_gives_a_compact_limit_of_zero_as_the_node_code_did() {
    // Math.min(null, ...) is 0 in JavaScript: with TARSEE_COMPACT_WINDOW=off the limit Codex gets is 0.
    let o = build_with("openai", None, |c| {
        c.env.set("TARSEE_COMPACT_WINDOW", "off");
    })
    .unwrap();
    assert_eq!(o.config["model_auto_compact_token_limit"], 0);
}

#[test]
fn debug_output_never_shows_a_key_or_a_token() {
    let o = build("openrouter");
    let shown = format!(
        "{o:?} {:?} {:?}",
        McpGrant {
            url: MCP_URL.into(),
            token: MCP_TOKEN.into()
        },
        BridgeAddress {
            url: BRIDGE_URL.into(),
            token: BRIDGE_TOKEN.into()
        }
    );
    for secret in [key("openrouter").unwrap(), MCP_TOKEN, BRIDGE_TOKEN] {
        assert!(!shown.contains(secret), "{secret}");
    }
}
