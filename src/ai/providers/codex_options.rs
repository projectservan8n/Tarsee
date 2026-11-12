//! Port of `src/ai/providers/codex-options.js`: everything a Codex turn starts with, worked out before anything runs
//! (design 4.8, rules R1 to R7). Pure: no I/O, no settings, no registry lookups beyond the provider's entry.
//!
//! [`build_codex_options`] gives the four things Codex is started with:
//!
//! ```text
//!   env            the child's whole environment (engine_env codex_env_for: the server's environment minus every
//!                  credential, plus the vault's keys, plus this provider's own credential block)
//!   config         the --config overrides (config_args flattens them into dotted keys)
//!   api_key        the OpenAI key, for the openai provider only (the engine passes it as CODEX_API_KEY in the child)
//!   thread_options the thread's options (model, effort, sandbox, approvals, working folder, ...)
//! ```
//!
//! No key or token is ever placed in config or on the command line: the custom providers read theirs from
//! TARSEE_PROVIDER_KEY (env_key), Tarsee's tools from TARSEE_MCP_TOKEN (bearer_token_env_var), and none of the three
//! reaches the agent's shell (shell_environment_policy, R7). Every host comes from engine_env `host_for`, OpenAI's
//! included.
//!
//! Provider blocks:
//!
//! ```text
//!   chatgpt     Codex's own ChatGPT sign-in in .codex-home (forced_login_method "chatgpt"); no host of Tarsee's.
//!               The model is only ever one the signed-in account lists (a free account can't use the paid ones),
//!               and none at all when that list is unknown: Codex then picks.
//!   openai      the built-in provider with the API key, OpenAI's host passed explicitly (openai_base_url), so no
//!               config file can move it; forced_login_method "api"
//!   openrouter  a custom Responses provider on OpenRouter's host, with its attribution headers
//!   deepseek    a custom Responses provider on DeepSeek's host (the alternative engine, used only when a model was
//!               verified on it)
//!   local       a custom Responses provider at the turn's Local AI bridge address (ai/local_bridge.rs, which passes
//!               the requests on to the owner's server); its key is the bridge's per-turn token, so the owner's key
//!               never reaches the Codex process; the context window from the server or the card
//! ```

use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::ai::context_limits::{EnvMap, compact_window_tokens, js_min, js_round};
use crate::ai::engine_env::{
    CODEX, CODEX_SHELL_EXCLUDED, CodexEnvOpts, CredentialCode, CredentialError, EngineEnvError, EntryModel,
    ProviderEntry, Tiers, TypeError, WrongSlot, codex_chatgpt_test_hosts, codex_env_for, host_for,
};
use crate::ai::local_bridge::js_string;
use crate::ai::provider_registry::{PROVIDERS, Provider, normalize_provider_id};
use crate::env::Env;
use crate::util::js::{self, utf16_len};

/// How long one call to a Tarsee tool may take (a browser task, a long fetch): over the 180 s floor the design sets.
pub const MCP_TOOL_TIMEOUT_SEC: u64 = 300;
const MCP_STARTUP_TIMEOUT_SEC: u64 = 20;

/// What Codex may say about a tool's output before trimming it for the model (tokens).
const TOOL_OUTPUT_TOKEN_LIMIT: u64 = 3000;

/// The custom provider each key provider runs as (Tarsee's own names, so none can shadow a built-in one).
const CUSTOM_PROVIDERS: [(&str, &str); 3] = [
    ("openrouter", "OpenRouter"),
    ("deepseek", "DeepSeek"),
    ("local", "Local AI"),
];

/// Codex features a Tarsee turn keeps off. Tarsee's own tools do these jobs, the same on every engine: ChatGPT's apps
/// and plugins (connectors that would bring their own tools and hosts), extra agents and goals, the built-in browser
/// and computer use, picture generation (its pictures don't reach a chat), tool suggestions, and installing a skill's
/// MCP servers on the fly. Hooks too: a hook is a program Codex runs around each tool call with the turn's whole
/// environment (the engine's own key included, which is kept out of the shell's environment), and Tarsee uses none.
/// Also unbounded_connection_retries: with it, a server that isn't there (a Local AI that is switched off) is retried
/// for ever and the turn never ends; without it Codex gives up after its usual retries and the turn says where it
/// looked. Set on every turn's command line, so a config file can't switch one back on.
const FEATURES_OFF: [&str; 16] = [
    "apps",
    "plugins",
    "remote_plugin",
    "plugin_discovery_prefetch",
    "multi_agent",
    "goals",
    "computer_use",
    "browser_use",
    "browser_use_external",
    "in_app_browser",
    "image_generation",
    "tool_suggest",
    "skill_mcp_dependency_install",
    "memories",
    "hooks",
    "unbounded_connection_retries",
];

/// The effort levels Codex takes that Tarsee also names (lib/model_picker.rs EFFORT_IDS).
const CODEX_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// The per-argument limit developer_instructions must fit: 128 KiB per argument on Linux, 32K characters in all on
/// Windows. `platform` is Node's name for the system ("win32", "linux", ...).
pub fn instructions_limit(platform: &str) -> usize {
    if platform == "win32" { 24 * 1024 } else { 96 * 1024 }
}

/// The longest start of `s` that fits in `max_bytes` of UTF-8, never ending on half a character.
fn fit_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// The longest end of `s` that fits in `max_bytes` of UTF-8, never starting on half a character.
fn last_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// The first whole lines of `block` that fit in `max_bytes` ("" when not even the first one does).
fn fit_lines(block: &str, max_bytes: usize) -> String {
    let mut out = String::new();
    for line in block.split('\n') {
        let next = if out.is_empty() { line.to_string() } else { format!("{out}\n{line}") };
        if next.len() > max_bytes {
            break;
        }
        out = next;
    }
    out
}

/// The database's saved memories in the system prompt (db/memory.rs MemoryStore::get_context_string): its first line
/// and its one-line "- [category] …" rows, at the start of a line (any of JavaScript's line ends). The preamble's own
/// "## Memory" section is how to use the memory tools, not memories, and is never cut.
static QUICK_MEMORIES_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\A|[\n\r\x{2028}\x{2029}])(Additional quick memories[^\n]*\n(?:- \[[^\n]*(?:\n|\z))*)")
        .expect("the quick memories pattern")
});
const TRIMMED: &str = "\n[… trimmed to fit; search the memory files for the rest]\n";
const TRIMMED_MIDDLE: &str = "\n[… trimmed to fit; the workspace files are on disk]\n";

/// Instructions that fit in `max_bytes`. When they are too long, the saved memories lose their last rows first
/// (search_memories finds them again), down to none; then, if that wasn't enough, the middle of the text goes, never
/// either end: the start is the preamble (Tarsee's tools and how to use memory), the end the conversation's own prompt
/// and the channel hint (how to send a file there). (The JS first dropped halves of surrogate pairs, which a Rust
/// string cannot hold.)
pub fn cap_instructions(text: &str, max_bytes: usize) -> String {
    let mut s = text.to_string();
    if s.len() <= max_bytes {
        return s;
    }
    if let Some(found) = QUICK_MEMORIES_RE.captures(text).and_then(|c| c.get(1)) {
        let before = &text[..found.start()];
        let rest = &text[found.end()..];
        let after = if rest.starts_with('\n') {
            format!("\n{}", rest.trim_start_matches('\n'))
        } else {
            rest.to_string()
        };
        let room = max_bytes as i64 - before.len() as i64 - after.len() as i64 - TRIMMED.len() as i64;
        let kept = if room > 0 {
            fit_lines(found.as_str().trim_end_matches('\n'), room as usize)
        } else {
            String::new()
        };
        if !kept.is_empty() {
            return format!("{before}{kept}{TRIMMED}{after}");
        }
        // Not even the first line fits: the memories go, and the middle is cut below if that still isn't enough.
        s = format!("{}{TRIMMED}{after}", js::trim_end(before));
        if s.len() <= max_bytes {
            return s;
        }
    }
    if max_bytes <= TRIMMED_MIDDLE.len() * 4 {
        return fit_bytes(&s, max_bytes).to_string();
    }
    let mut tail = last_bytes(&s, max_bytes / 4);
    if let Some(line_start) = tail.find('\n')
        && 2 * utf16_len(&tail[..line_start]) < utf16_len(tail)
    {
        tail = &tail[line_start + 1..];
    }
    let mut head = fit_bytes(&s, max_bytes - TRIMMED_MIDDLE.len() - tail.len());
    if let Some(line_end) = head.rfind('\n')
        && 2 * utf16_len(&head[..line_end]) > utf16_len(head)
    {
        head = &head[..line_end];
    }
    format!("{head}{TRIMMED_MIDDLE}{tail}")
}

/// Tarsee's effort level as Codex's, or `None` to send none (an unknown level, or one this model doesn't take:
/// `allowed` is the model's own list, as JSON).
pub fn codex_effort(effort: Option<&str>, allowed: Option<&Value>) -> Option<String> {
    let e = js::trim(effort.unwrap_or("")).to_lowercase();
    if !CODEX_EFFORTS.contains(&e.as_str()) {
        return None;
    }
    if let Some(Value::Array(levels)) = allowed
        && !levels.is_empty()
        && !levels.iter().any(|level| level.as_str() == Some(e.as_str()))
    {
        return None;
    }
    Some(e)
}

/// The model to name on the command line, or `None` for Codex's own default.
///
/// - chatgpt: only a model the signed-in account's live list has (`account_models`: its rows, `[{id, efforts?,
///   default?}]`), the one it marks as its default included (left out, a `model` in the home's config.toml, which
///   the Terminal's /model writes, would run instead of the model Tarsee shows and records); nothing when the list
///   is unknown or empty, or doesn't have it. A ChatGPT model is never hard-coded.
/// - others: the model as chosen; nothing for none or "default".
pub fn codex_model_for(provider_id: &str, model: Option<&str>, account_models: Option<&[Value]>) -> Option<String> {
    let m = js::trim(model.unwrap_or(""));
    if m.is_empty() || m.to_lowercase() == "default" {
        return None;
    }
    if normalize_provider_id(provider_id) != Some("chatgpt") {
        return Some(m.to_string());
    }
    account_models
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(m))
        .then(|| m.to_string())
}

/// Codex's `--config` arguments for a config object (dotted keys, TOML values), for checks and logs. A `null` value
/// is a caller's mistake (the JS threw).
pub fn config_args(config: &Value) -> Result<Vec<String>, TypeError> {
    fn flatten(value: &Value, prefix: &str, out: &mut Vec<String>) -> Result<(), TypeError> {
        if let Value::Object(entries) = value {
            if entries.is_empty() {
                if !prefix.is_empty() {
                    out.push(format!("{prefix}={{}}"));
                }
                return Ok(());
            }
            for (key, item) in entries {
                let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                flatten(item, &path, out)?;
            }
            return Ok(());
        }
        out.push(format!("{prefix}={}", toml(value)?));
        Ok(())
    }
    let mut out = Vec::new();
    flatten(config, "", &mut out)?;
    Ok(out)
}

static BARE_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[A-Za-z0-9_-]+$").expect("a fixed pattern"));

fn toml(value: &Value) -> Result<String, TypeError> {
    Ok(match value {
        Value::String(text) => serde_json::to_string(text).unwrap_or_default(),
        Value::Number(_) | Value::Bool(_) => js_string(value),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(toml).collect::<Result<Vec<_>, _>>()?.join(", ")
        ),
        Value::Object(entries) => {
            let parts = entries
                .iter()
                .map(|(key, item)| {
                    let key = if BARE_KEY.is_match(key) {
                        key.clone()
                    } else {
                        serde_json::to_string(key).unwrap_or_default()
                    };
                    Ok(format!("{key} = {}", toml(item)?))
                })
                .collect::<Result<Vec<_>, TypeError>>()?;
            format!("{{{}}}", parts.join(", "))
        }
        Value::Null => return Err(TypeError("A Codex config value can't be null".into())),
    })
}

static LINE_BREAKS: LazyLock<Regex> = LazyLock::new(|| Regex::new("[\r\n\0]+").expect("a fixed pattern"));

/// `String(s ?? "").replace(/[\r\n\0]+/g, " ").trim()`.
fn one_line(text: Option<&str>) -> String {
    js::trim(&LINE_BREAKS.replace_all(text.unwrap_or(""), " ")).to_string()
}

/// A number as `JSON.stringify` writes it: a whole number without ".0".
fn js_num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// What engine_env reads of a provider, from its registry entry.
pub fn engine_entry(p: &Provider) -> ProviderEntry {
    let tier = |name: &str| p.tier(name).map(str::to_string);
    ProviderEntry {
        id: p.id.to_string(),
        label: Some(p.label.to_string()),
        engines: Some(p.engines.iter().map(|e| e.as_str().to_string()).collect()),
        env_key: p.env_key.map(str::to_string),
        base_url: p
            .base_urls
            .iter()
            .map(|(engine, url)| (engine.as_str().to_string(), url.to_string()))
            .collect(),
        wrong_slot: p
            .wrong_slot
            .iter()
            .map(|slot| WrongSlot {
                re: slot.re.clone(),
                message: slot.message.to_string(),
            })
            .collect(),
        models: p
            .models
            .iter()
            .map(|m| EntryModel {
                id: m.id.clone(),
                context: m.context.map(|c| c as f64),
            })
            .collect(),
        tiers: Tiers {
            fable: tier("fable"),
            opus: tier("opus"),
            sonnet: tier("sonnet"),
            haiku: tier("haiku"),
        },
        default_model: p.default_model.map(str::to_string),
    }
}

/// The turn's grant for Tarsee's tools: the MCP endpoint and its per-turn token.
#[derive(Clone, Default)]
pub struct McpGrant {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for McpGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpGrant").field("url", &self.url).finish_non_exhaustive()
    }
}

/// A Local AI turn's address on the bridge and its per-turn token (`ai::local_bridge::BridgeTurn`).
#[derive(Clone, Default)]
pub struct BridgeAddress {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for BridgeAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BridgeAddress").field("url", &self.url).finish_non_exhaustive()
    }
}

/// Which AI a Codex turn runs on: `{ providerId, model, effort }`.
#[derive(Debug, Clone, Default)]
pub struct CodexTarget {
    /// The provider's id or alias.
    pub provider_id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// What a Codex turn's options are built from (the JS `ctx`).
#[derive(Clone, Default)]
pub struct CodexContext {
    /// The provider's registry entry, when not the registry's own (`PROVIDERS[id]`).
    pub entry: Option<&'static Provider>,
    /// The server's environment.
    pub env: Env,
    /// The vault's keys for scripts (engine_env R2).
    pub vault_env: EnvMap,
    /// The provider's key (openai, openrouter, deepseek; not used for Local AI, which goes through its bridge).
    pub key: Option<String>,
    /// `config.state_dir` (the key and sign-in homes live under it).
    pub state_dir: Option<PathBuf>,
    /// The home itself, named outright.
    pub home: Option<PathBuf>,
    /// The agent's working folder (required).
    pub workspace: Option<PathBuf>,
    /// The turn's grant for Tarsee's tools (required).
    pub mcp: Option<McpGrant>,
    /// The stable instructions (preamble, workspace CLAUDE.md, stable system prompt).
    pub developer_instructions: Option<String>,
    /// Local AI's server address (ai.local.baseUrl, else TARSEE_LOCAL_AI_URL): checked, never given to Codex.
    pub local_url: Option<String>,
    /// Local AI only, required: the turn's bridge. Codex's base_url is its url and its key (TARSEE_PROVIDER_KEY) its
    /// token.
    pub local_bridge: Option<BridgeAddress>,
    /// OpenRouter's attribution title and referer.
    pub app_title: Option<String>,
    pub referer: Option<String>,
    /// The model's context window.
    pub context_tokens: Option<f64>,
    /// TARSEE_COMPACT_WINDOW's value (default: read from `env`).
    pub compact_window: Option<f64>,
    /// Ask for reasoning summaries (the dashboard's live view).
    pub thinking_summaries: bool,
    /// The ChatGPT account's live model list, as JSON rows (`[{id, efforts?, default?}]`).
    pub account_models: Option<Vec<Value>>,
    /// Tarsee's bundled skills (added to the turn's folders).
    pub skills_dir: Option<PathBuf>,
    /// A value unique to this turn, set as TARSEE_CODEX_TURN so Stop can find everything the turn started.
    pub turn_mark: Option<String>,
    /// Node's name for the system, for the instructions' size limit (default: this one).
    pub platform: Option<String>,
}

/// A thread's options: the model, its effort, and how Codex may act.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<String>,
    /// "danger-full-access".
    pub sandbox_mode: &'static str,
    /// "never".
    pub approval_policy: &'static str,
    pub working_directory: PathBuf,
    pub skip_git_repo_check: bool,
    pub network_access_enabled: bool,
    /// "disabled".
    pub web_search_mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_directories: Option<Vec<PathBuf>>,
}

/// Everything a Codex turn starts with: `{ providerId, home, env, config, apiKey, threadOptions }`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOptions {
    /// The provider's public id.
    pub provider_id: String,
    /// Codex's home (CODEX_HOME).
    pub home: PathBuf,
    /// The child's whole environment.
    pub env: EnvMap,
    /// The --config overrides, as an object ([`config_args`] flattens it).
    pub config: Value,
    /// The OpenAI key, for the openai provider only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub thread_options: ThreadOptions,
}

impl std::fmt::Debug for CodexOptions {
    /// Without the key or the environment's values.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexOptions")
            .field("provider_id", &self.provider_id)
            .field("home", &self.home)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("config", &self.config)
            .field("thread_options", &self.thread_options)
            .finish_non_exhaustive()
    }
}

/// `"x".trim().replace(/^(["'])(.*)\1$/, "$2").trim()`: a key with its quotes taken off.
fn unquoted_key(key: &str) -> String {
    let k = js::trim(key);
    let quoted = k.len() >= 2
        && (k.starts_with('"') || k.starts_with('\''))
        && k.ends_with(&k[..1])
        && !k[1..k.len() - 1].contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    let k = if quoted { &k[1..k.len() - 1] } else { k };
    js::trim(k).to_string()
}

fn type_error(message: impl Into<String>) -> EngineEnvError {
    TypeError(message.into()).into()
}

/// Everything a Codex turn on `target` starts with. Refuses the turn (`EngineEnvError::Credential`, engine_env's
/// codes) when it can't start: a missing key, Local AI without an address, a provider Codex doesn't run, no grant
/// for the tools; a caller's mistake is `EngineEnvError::Type`.
pub fn build_codex_options(target: &CodexTarget, ctx: &CodexContext) -> Result<CodexOptions, EngineEnvError> {
    let Some(id) = normalize_provider_id(&target.provider_id) else {
        return Err(type_error(format!(
            "buildCodexOptions: unknown provider {}",
            serde_json::to_string(&target.provider_id).unwrap_or_default()
        )));
    };
    let Some(entry) = ctx.entry.or_else(|| PROVIDERS.get(id)) else {
        return Err(type_error(format!("buildCodexOptions: unknown provider \"{id}\"")));
    };
    let engine_entry = engine_entry(entry);
    let env = &ctx.env;
    let workspace = ctx
        .workspace
        .as_deref()
        .map(crate::ai::engine_env::js_trim_path)
        .unwrap_or_default();
    if workspace.as_os_str().is_empty() {
        return Err(type_error("buildCodexOptions: the turn's workspace folder is required"));
    }
    let Some(mcp) = ctx.mcp.as_ref().filter(|m| !m.url.is_empty()) else {
        return Err(CredentialError::new(
            CredentialCode::NeedsMcpToken,
            "This turn has no grant for Tarsee's tools.",
            Some(id),
        )
        .into());
    };

    // Local AI: the owner's address is checked (none refuses the turn), and Codex is given the turn's bridge instead.
    let mut bridge = None;
    if id == "local" {
        host_for(&engine_entry, CODEX, env, ctx.local_url.as_deref())?;
        bridge = ctx
            .local_bridge
            .as_ref()
            .filter(|b| !b.url.is_empty() && !b.token.is_empty());
        if bridge.is_none() {
            return Err(type_error(
                "buildCodexOptions: a Local AI turn goes through its bridge (ctx.localBridge {url, token})",
            ));
        }
    }

    // The environment first: it refuses a provider Codex doesn't run, a missing key and a missing token (R4).
    let mut child_env = codex_env_for(
        &engine_entry,
        &CodexEnvOpts {
            env: env.clone(),
            vault_env: ctx.vault_env.clone(),
            key: match bridge {
                Some(bridge) => Some(bridge.token.clone()),
                None => ctx.key.clone(),
            },
            mcp_token: Some(mcp.token.clone()),
            home: ctx.home.clone(),
            state_dir: ctx.state_dir.clone(),
        },
    )?;
    if let Some(mark) = ctx.turn_mark.as_ref().filter(|m| !m.is_empty()) {
        child_env.insert("TARSEE_CODEX_TURN".into(), mark.clone());
    }

    let context = match ctx.context_tokens {
        Some(tokens) if tokens > 0.0 => Some(js_round(tokens)),
        _ => Some(entry.default_context as f64).filter(|c| *c != 0.0),
    };
    let compact = match ctx.compact_window {
        Some(window) if window > 0.0 => Some(window),
        _ => compact_window_tokens(env.get("TARSEE_COMPACT_WINDOW").as_deref()).map(|n| n as f64),
    };

    let platform = ctx
        .platform
        .clone()
        .unwrap_or_else(|| crate::daemon::service::current_platform().to_string());
    let filters: Map<String, Value> = CODEX_SHELL_EXCLUDED
        .iter()
        .map(|name| (name.to_string(), json!("exclude")))
        .collect();
    let features: Map<String, Value> = FEATURES_OFF.iter().map(|f| (f.to_string(), json!(false))).collect();
    let mut settings = object(json!({
        "developer_instructions": cap_instructions(ctx.developer_instructions.as_deref().unwrap_or(""), instructions_limit(&platform)),
        "project_doc_max_bytes": 0,
        // No project root search: by default Codex treats the nearest folder above with .git as the project root and
        // loads a .codex/config.toml from every folder between it and the workspace (a trusted root's mcp_servers
        // there would get the turn's environment, its key included). With no markers the workspace is the root, and
        // the only project file Codex loads is <workspace>/.codex/config.toml, which codex_config_guard reads before
        // every turn.
        "project_root_markers": [],
        "history": {"persistence": "none"},
        "cli_auth_credentials_store": "file",
        "check_for_update_on_startup": false,
        "model_reasoning_summary": if ctx.thinking_summaries { "concise" } else { "none" },
        "tool_output_token_limit": TOOL_OUTPUT_TOKEN_LIMIT,
        "shell_environment_policy": {
            "inherit": "all",
            "ignore_default_excludes": true,
            "filters": filters,
        },
        "mcp_servers": {
            "tarsee": {
                "url": mcp.url,
                "bearer_token_env_var": "TARSEE_MCP_TOKEN",
                "default_tools_approval_mode": "approve",
                "required": true,
                "startup_timeout_sec": MCP_STARTUP_TIMEOUT_SEC,
                "tool_timeout_sec": MCP_TOOL_TIMEOUT_SEC,
            },
        },
        "features": features,
    }));
    if let Some(context) = context {
        // `Math.min(compact, ...)` with no compact window ("off") is Math.min(null, ...): 0.
        let limit = js_min(compact.unwrap_or(0.0), (context * 0.85).floor());
        settings.insert("model_auto_compact_token_limit".into(), js_num(limit));
    }

    let mut api_key = None;
    if id == "chatgpt" {
        settings.insert("forced_login_method".into(), json!("chatgpt"));
        if let Some(hosts) = codex_chatgpt_test_hosts(env) {
            settings.insert("chatgpt_base_url".into(), json!(hosts.chatgpt_base_url));
            settings.insert("openai_base_url".into(), json!(hosts.openai_base_url));
        }
    } else if id == "openai" {
        settings.insert("forced_login_method".into(), json!("api"));
        let host = host_for(&engine_entry, CODEX, env, None)?;
        settings.insert("openai_base_url".into(), host.map_or(Value::Null, Value::String));
        api_key = Some(unquoted_key(ctx.key.as_deref().unwrap_or("undefined")));
    } else {
        let name = format!("tarsee_{id}");
        let label = CUSTOM_PROVIDERS
            .iter()
            .find(|(custom, _)| *custom == id)
            .map(|(_, label)| *label)
            .or(Some(entry.label).filter(|l| !l.is_empty()))
            .unwrap_or(id);
        let base_url = match bridge {
            Some(bridge) => bridge.url.clone(),
            None => host_for(&engine_entry, CODEX, env, None)?.unwrap_or_default(),
        };
        let mut provider = Map::new();
        provider.insert("name".into(), json!(label));
        provider.insert("base_url".into(), json!(base_url));
        if child_env.get("TARSEE_PROVIDER_KEY").is_some_and(|k| !k.is_empty()) {
            provider.insert("env_key".into(), json!("TARSEE_PROVIDER_KEY"));
        }
        provider.insert("wire_api".into(), json!("responses"));
        // A Local AI server that sends its headers and then nothing (a wedged GPU, a model too big for its memory)
        // costs Codex 5 minutes per try: one retry instead of five gives up in about 10 minutes, so the backup model
        // can answer. The 5 minutes themselves stay: a slow local model still streams within them.
        if id == "local" {
            provider.insert("stream_max_retries".into(), json!(1));
        }
        if id == "openrouter" {
            let title = Some(one_line(ctx.app_title.as_deref()))
                .filter(|t| !t.is_empty())
                .or_else(|| entry.default_app_title.filter(|t| !t.is_empty()).map(str::to_string))
                .unwrap_or_else(|| "Tarsee".to_string());
            let mut headers = Map::new();
            headers.insert("X-OpenRouter-Title".into(), json!(title));
            let referer = one_line(ctx.referer.as_deref());
            if !referer.is_empty() {
                headers.insert("HTTP-Referer".into(), json!(referer));
            }
            provider.insert("http_headers".into(), Value::Object(headers));
        }
        settings.insert("model_provider".into(), json!(name));
        let mut providers = Map::new();
        providers.insert(name, Value::Object(provider));
        settings.insert("model_providers".into(), Value::Object(providers));
        settings.insert("forced_login_method".into(), json!("api"));
        if let Some(context) = context {
            settings.insert("model_context_window".into(), js_num(context));
        }
    }

    let account_models = ctx.account_models.as_deref();
    let model = codex_model_for(id, target.model.as_deref(), account_models);
    let model_row = match (&model, id) {
        (Some(model), "chatgpt") => account_models
            .unwrap_or_default()
            .iter()
            .find(|row| row.get("id").and_then(Value::as_str) == Some(model.as_str())),
        _ => None,
    };
    let allowed = if id == "chatgpt" { model_row.and_then(|row| row.get("efforts")) } else { None };
    let effort = codex_effort(target.effort.as_deref(), allowed);

    let thread_options = ThreadOptions {
        model,
        model_reasoning_effort: effort,
        sandbox_mode: "danger-full-access",
        approval_policy: "never",
        working_directory: workspace,
        skip_git_repo_check: true,
        network_access_enabled: true,
        web_search_mode: "disabled",
        additional_directories: ctx
            .skills_dir
            .clone()
            .filter(|dir| !dir.as_os_str().is_empty())
            .map(|dir| vec![dir]),
    };

    Ok(CodexOptions {
        provider_id: id.to_string(),
        home: PathBuf::from(child_env.get("CODEX_HOME").cloned().unwrap_or_default()),
        env: child_env,
        config: Value::Object(settings),
        api_key,
        thread_options,
    })
}

/// The fields of an object (none for anything else).
fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

#[cfg(test)]
mod tests;
