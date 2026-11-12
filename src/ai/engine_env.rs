//! Port of `src/ai/engine-env.js`: the environment each agent engine starts with, so a provider's turn carries
//! exactly its own credential and nothing else (design 4.5, rules R1 to R10).
//!
//! The failures this guards against are credential leaks and silent billing switches: the Claude sign-in token sent
//! to a third-party gateway, a stray ANTHROPIC_API_KEY moving plan turns onto metered billing, a Railway provider key
//! reaching the agent's shell. So every environment is built the same way (R2):
//!
//! ```text
//!   base  = the server's env minus every credential name, Tarsee's own secrets and the Railway provider keys
//!   env   = base + the vault's keys (so scripts read them by name) + the cost savers (Claude Code only)
//!   env   = env minus every credential name again (a vault entry can't re-add one)
//!   env   = env + this provider's credential block, and nothing else
//! ```
//!
//! Hosts are code constants from the provider's registry entry (R3), read through [`host_for`]; the only override is
//! the test-only base-URL seam, honored only when NODE_ENV is "test" and the host is loopback. A missing key refuses
//! the turn (R4); there is never a fallback to another credential.
//!
//! The functions take the provider's registry ENTRY ([`ProviderEntry`]: the fields of `PROVIDERS[id]` read here: id,
//! envKey, baseUrl, models, tiers, defaultModel, wrongSlot) and the key, so this module never reads Settings or the
//! registry itself. A bare id string is accepted only for the Claude plan, which has nothing in its entry to check;
//! any other id is refused, because without the entry there is no host constant and no wrong-slot check. Everything
//! here is pure except [`ensure_home`] (mkdir), [`home_isolation_refusal`], [`settings_file_guard`] and
//! [`codex_config_guard`] (which look at the files they guard).
//!
//! Like the JS, which worked on a copy of `process.env`, every builder works on `env.snapshot()` of the [`Env`] it is
//! given, never on the real process environment.

mod js_json;

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

pub use super::context_limits::EnvMap;
use super::context_limits::{JS_DOT_CLASS, JS_SPACE_CLASS, cost_saver_env, js_number, js_round};
use crate::env::Env;
use crate::util::js::{number_to_string, trim as js_trim, trim_start as js_trim_start};
use crate::util::node_path::{join as node_join, normalize as normalize_path};

/// The pattern of [`AUTH_ENV_RE`].
pub const AUTH_ENV_PATTERN: &str = concat!(
    "^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_API_BASE_URL$|",
    "CLAUDE_CODE_API_KEY_|CLAUDE_CODE_CUSTOM_OAUTH_URL$|CLAUDE_LOCAL_OAUTH_|CLAUDE_TRUSTED_DEVICE_TOKEN$|",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE$|CLAUDE_BG_AUTH_SNAPSHOT_PATH$|CLAUDE_[A-Z0-9_]*_FILE_DESCRIPTOR$|",
    "CLAUDE_BG_(?:CLAIM|PTY|RV)_AUTH$|CLAUDE_BG_SOCKET_TOKENS_PATH$|",
    "CLAUDE_BRIDGE_(?:BASE_URL|OAUTH_TOKEN|SESSION_INGRESS_URL)$|CLAUDE_REMOTE_TOOLS_BRIDGE_URL$|",
    "CLAUDE_CODE_ARTIFACTS_API_(?:BASE_URL|TOKEN)$|CLAUDE_CODE_ARTIFACT_(?:ASSET|LIVE|SYNC|VIEWER)_BASE_URL$|",
    "CLAUDE_CODE_MEMORY_API_|CLAUDE_CODE_GATEWAY_TOKEN$|CLAUDE_CODE_GB_BASE_URL$|CLAUDE_CODE_SESSIONS_OAUTH_TOKEN$|",
    "CLAUDE_CODE_(?:MCP_SERVE_AUTH|MESSAGING|SLACK_TAG|HFI_BEARER)_TOKEN$|CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID$|",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST$|CLAUDE_CODE_HOST_AUTH_|CLAUDE_CODE_HOST_CREDS_FILE$|",
    "CLAUDE_CODE_MODEL_CATALOG|CLAUDE_CODE_CLIENT_DATA_URL$|CLAUDE_CODE_REMOTE_SDK_URL$|CLAUDE_RUNNER_API_BASE_URL$|",
    "CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDE_CONFIG_DIR$|CODEX_|OPENAI_BASE_URL$|AWS_BEARER_TOKEN_BEDROCK$|",
    "TARSEE_PROVIDER_KEY$|TARSEE_CHATGPT_ACCESS_TOKEN$|TARSEE_MCP_TOKEN$)",
);

/// Names that choose an engine's login, billing, host or home. Stripped from every environment, then added back per
/// provider. Besides the design's list this covers every Claude sign-in or host variable the pinned CLI reads
/// (test/claude-cli-env-names.test.js scans the installed CLI so a new one is caught on an SDK bump): the whole
/// CLAUDE_CODE_OAUTH_* family (the setup token, a refresh-token login with its scopes and client id), a claude.ai
/// session cookie, the files API host, the custom and local OAuth hosts, a trusted-device token, the session-ingress
/// token file, the background sign-in snapshot, and the file-descriptor sources of a token or key. Agent SDK 0.3.319's
/// CLI added more (each on the CLI's own list of secrets to scrub or of hosts it sends a sign-in to): the background
/// session's hand-off secrets, the bridge's host and token, the artifacts and memory APIs' hosts and tokens, a gateway
/// token, the feature-flag host, the cloud-sessions token, the MCP-serve, messaging, Slack-tag and HFI tokens, the
/// Design login's OAuth client, the host-managed sign-in (CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, CLAUDE_CODE_HOST_AUTH_*,
/// CLAUDE_CODE_HOST_CREDS_FILE), and the model catalog, client-data and remote-SDK/runner hosts that would change
/// which model or host a turn uses. None of them is needed by the Claude plan (it signs in from its home's
/// .credentials.json or [`PLAN_SIGN_IN_NAMES`]).
///
/// Case-sensitive, like the JS regex: use [`is_auth_env_name`] for a name as the environment spells it.
pub static AUTH_ENV_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(AUTH_ENV_PATTERN).expect("the credential-name pattern"));

/// The operator's Claude sign-in variables: `claude setup-token`'s CLAUDE_CODE_OAUTH_TOKEN, or a refresh-token login
/// (CLAUDE_CODE_OAUTH_REFRESH_TOKEN with its CLAUDE_CODE_OAUTH_SCOPES, and CLAUDE_CODE_OAUTH_CLIENT_ID). Stripped like
/// every credential, then put back from the server's environment on the Claude plan only, so the plan signs in as it
/// always has and no other provider ever sees them.
pub const PLAN_SIGN_IN_NAMES: [&str; 4] = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
];

/// Tarsee's own secrets: never in any engine's environment.
pub const TARSEE_SECRETS: [&str; 3] = ["ENCRYPTION_KEY", "SETUP_PASSWORD", "TARSEE_API_TOKEN"];

/// The Railway (server environment) copies of the provider keys. They reach an engine only as that provider's own
/// credential, never by name: a key the owner wants scripts to read goes in Settings > Vault instead.
pub const PROVIDER_KEY_NAMES: [&str; 4] = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "TARSEE_LOCAL_AI_KEY",
];

pub const CLAUDE_CODE: &str = "claude-code";
pub const CODEX: &str = "codex";

// --- Errors ------------------------------------------------------------------------------------------------------

/// Why a turn must not start (the JS `CredentialError`'s `code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialCode {
    /// No key for a provider that needs one (R4).
    NeedsKey,
    /// Local AI without a usable server address.
    NeedsSetup,
    /// A Codex turn started without its per-turn token for Tarsee's tools (a caller bug).
    NeedsMcpToken,
    /// A key that can't be sent as-is (a line break, or the entry's wrongSlot matched).
    BadKey,
    /// A gateway pin that names a Claude model (it would go to the wrong host).
    BadModel,
    /// A provider on an engine it doesn't run on, or with no host there.
    WrongEngine,
    /// A sign-in file, or a stored key, where only this provider's key belongs (R1).
    CredentialIsolation,
}

impl CredentialCode {
    /// The code as the JS spelled it ("needs-key", ...): it reaches the UI and engine-errors.
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialCode::NeedsKey => "needs-key",
            CredentialCode::NeedsSetup => "needs-setup",
            CredentialCode::NeedsMcpToken => "needs-mcp-token",
            CredentialCode::BadKey => "bad-key",
            CredentialCode::BadModel => "bad-model",
            CredentialCode::WrongEngine => "wrong-engine",
            CredentialCode::CredentialIsolation => "credential-isolation",
        }
    }
}

impl std::fmt::Display for CredentialCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A turn that must not start, and why. `provider` is the provider's id when it is known.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct CredentialError {
    pub code: CredentialCode,
    pub message: String,
    pub provider: Option<String>,
}

impl CredentialError {
    pub fn new(code: CredentialCode, message: impl Into<String>, provider: Option<&str>) -> Self {
        CredentialError {
            code,
            message: message.into(),
            provider: provider.map(str::to_string),
        }
    }
}

/// A caller's mistake (the JS `TypeError`): a bare id where the entry is needed, a missing state folder. Never a
/// condition to show a person.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TypeError(pub String);

/// What the builders here can fail with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EngineEnvError {
    #[error(transparent)]
    Credential(#[from] CredentialError),
    #[error(transparent)]
    Type(#[from] TypeError),
}

impl EngineEnvError {
    /// The refusal, when it is one (`err instanceof CredentialError`).
    pub fn credential(&self) -> Option<&CredentialError> {
        match self {
            EngineEnvError::Credential(err) => Some(err),
            EngineEnvError::Type(_) => None,
        }
    }

    /// The refusal's code, when it is one.
    pub fn code(&self) -> Option<CredentialCode> {
        self.credential().map(|err| err.code)
    }

    pub fn is_type_error(&self) -> bool {
        matches!(self, EngineEnvError::Type(_))
    }
}

fn refuse(code: CredentialCode, message: impl Into<String>, provider: &str) -> EngineEnvError {
    EngineEnvError::Credential(CredentialError::new(code, message, Some(provider)))
}

// --- The registry entry --------------------------------------------------------------------------------------------

/// What engine-env reads from a provider's registry entry (`PROVIDERS[id]` in `ai/provider-registry.js`). The
/// registry (package A1) builds one from its own entry; tests build them by hand where they need a provider the
/// registry doesn't have.
#[derive(Debug, Clone, Default)]
pub struct ProviderEntry {
    /// The provider's id ("deepseek"); the plan's is "claude" (or its storage id "claude-code").
    pub id: String,
    /// Its name in messages ("DeepSeek"); the id when `None`.
    pub label: Option<String>,
    /// The engines it runs on (`entry.engines`); `None` means every engine its home table allows.
    pub engines: Option<Vec<String>>,
    /// The environment variable a server copy of its key lives in (`entry.envKey`).
    pub env_key: Option<String>,
    /// Its host on each engine, by engine name (`entry.baseUrl`): code constants, never a setting.
    pub base_url: BTreeMap<String, String>,
    /// Keys of another provider that were pasted into this one's slot (`entry.wrongSlot`).
    pub wrong_slot: Vec<WrongSlot>,
    /// Its model catalog, for each model's context window (`entry.models`).
    pub models: Vec<EntryModel>,
    /// Its tier models (`entry.tiers`).
    pub tiers: Tiers,
    /// The model a turn uses when none is chosen (`entry.defaultModel`).
    pub default_model: Option<String>,
}

/// A key shape that belongs to another provider, and what to tell the person.
#[derive(Debug, Clone)]
pub struct WrongSlot {
    pub re: Regex,
    /// When empty: "That isn't a <label> key."
    pub message: String,
}

/// One model of an entry's catalog.
#[derive(Debug, Clone, PartialEq)]
pub struct EntryModel {
    pub id: String,
    /// The context window in tokens; `None` when unknown (the JS `undefined`).
    pub context: Option<f64>,
}

/// A provider's tier models, or a turn's overrides of them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tiers {
    pub fable: Option<String>,
    pub opus: Option<String>,
    pub sonnet: Option<String>,
    pub haiku: Option<String>,
}

/// A provider as the builders take it: its registry entry, or a bare id (accepted for the Claude plan only).
#[derive(Debug, Clone, Copy)]
pub enum ProviderRef<'a> {
    Id(&'a str),
    Entry(&'a ProviderEntry),
}

impl<'a> From<&'a str> for ProviderRef<'a> {
    fn from(id: &'a str) -> Self {
        ProviderRef::Id(id)
    }
}

impl<'a> From<&'a String> for ProviderRef<'a> {
    fn from(id: &'a String) -> Self {
        ProviderRef::Id(id)
    }
}

impl<'a> From<&'a ProviderEntry> for ProviderRef<'a> {
    fn from(entry: &'a ProviderEntry) -> Self {
        ProviderRef::Entry(entry)
    }
}

// --- Names ---------------------------------------------------------------------------------------------------------

/// True for a name [`AUTH_ENV_RE`] covers, in any case: Windows looks environment names up case-insensitively, so
/// there an "anthropic_api_key" is the same variable as ANTHROPIC_API_KEY.
pub fn is_auth_env_name(name: &str) -> bool {
    AUTH_ENV_RE.is_match(&name.to_uppercase())
}

/// True for a name R2 strips from the server's environment before anything is merged in.
fn is_base_stripped(name: &str, extra: &BTreeSet<String>) -> bool {
    let upper = name.to_uppercase();
    AUTH_ENV_RE.is_match(&upper)
        || TARSEE_SECRETS.contains(&upper.as_str())
        || PROVIDER_KEY_NAMES.contains(&upper.as_str())
        || extra.contains(&upper)
}

/// The Claude plan: public id claude, stored as claude-code.
fn is_plan(id: &str) -> bool {
    matches!(id.to_lowercase().as_str(), "claude" | "claude-code")
}

fn canonical_id(id: &str) -> String {
    if is_plan(id) {
        "claude".to_string()
    } else {
        id.to_lowercase()
    }
}

fn engine_name(engine: &str) -> &'static str {
    if engine == CODEX { "Codex" } else { "Claude Code" }
}

/// Which engines each provider runs on, and its home key there (R1; design 4.10 for the keys).
fn home_key(id: &str, engine: &str) -> Option<&'static str> {
    match (id, engine) {
        ("claude" | "anthropic" | "deepseek" | "openrouter", CLAUDE_CODE) => Some("cc"),
        ("deepseek" | "openrouter" | "openai" | "local", CODEX) => Some("cx"),
        ("chatgpt", CODEX) => Some("cxd"),
        _ => None,
    }
}

/// Providers whose key is optional (Local AI's server may need none).
fn key_optional(id: &str) -> bool {
    id == "local"
}

/// Sign-in providers: no key, and no host of Tarsee's (the engine signs in to its own).
fn is_sign_in(id: &str) -> bool {
    matches!(id, "claude" | "chatgpt")
}

fn entry_of<'a>(provider: ProviderRef<'a>) -> Result<Cow<'a, ProviderEntry>, EngineEnvError> {
    match provider {
        ProviderRef::Id(id) if is_plan(id) => Ok(Cow::Owned(ProviderEntry {
            id: id.to_string(),
            ..ProviderEntry::default()
        })),
        ProviderRef::Id(id) => Err(TypeError(format!(
            "engine-env: pass the provider's registry entry (PROVIDERS.{id}), not its id: the entry carries its hosts and key checks"
        ))
        .into()),
        ProviderRef::Entry(entry) if entry.id.is_empty() => {
            Err(TypeError("engine-env: a provider entry with an id is required".into()).into())
        }
        ProviderRef::Entry(entry) => Ok(Cow::Borrowed(entry)),
    }
}

fn label_of(entry: &ProviderEntry, id: &str) -> String {
    entry
        .label
        .clone()
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| id.to_string())
}

fn assert_runs(entry: &ProviderEntry, engine: &str) -> Result<String, EngineEnvError> {
    let id = canonical_id(&entry.id);
    let runs = home_key(&id, engine).is_some()
        && entry
            .engines
            .as_ref()
            .is_none_or(|engines| engines.iter().any(|e| e == engine));
    if !runs {
        let message = format!("{} doesn't run on {}.", label_of(entry, &id), engine_name(engine));
        return Err(refuse(CredentialCode::WrongEngine, message, &id));
    }
    Ok(id)
}

// --- R2 ------------------------------------------------------------------------------------------------------------

/// R2's first step: the server's env minus credentials, Tarsee's secrets, the Railway provider keys and any
/// `strip_names`. Also what `agent_vault_env()` should compare against (its `env` option), so a vault key that shares
/// a name with a stripped Railway variable (OPENAI_API_KEY, say) still reaches scripts instead of being skipped as
/// "already set".
pub fn base_env(env: &Env, strip_names: &[&str]) -> EnvMap {
    let extra: BTreeSet<String> = strip_names
        .iter()
        .filter(|name| !name.is_empty())
        .map(|name| name.to_uppercase())
        .collect();
    env.snapshot()
        .into_iter()
        .filter(|(name, _)| !is_base_stripped(name, &extra))
        .collect()
}

/// What [`finalize_env`] merges.
#[derive(Debug, Clone, Default)]
pub struct FinalizeOpts {
    /// The server's environment.
    pub env: Env,
    pub vault_env: EnvMap,
    pub extra_env: EnvMap,
    pub credentials: EnvMap,
    pub strip_names: Vec<String>,
}

/// R2 in one call: `base_env(env, strip_names)`, plus the vault's keys and `extra_env`, minus credentials again, plus
/// the credential block. The block always wins.
pub fn finalize_env(opts: &FinalizeOpts) -> EnvMap {
    let strip: Vec<&str> = opts.strip_names.iter().map(String::as_str).collect();
    let mut merged = base_env(&opts.env, &strip);
    merged.extend(opts.vault_env.iter().map(|(k, v)| (k.clone(), v.clone())));
    merged.extend(opts.extra_env.iter().map(|(k, v)| (k.clone(), v.clone())));
    merged.retain(|name, _| !is_auth_env_name(name));
    merged.extend(opts.credentials.iter().map(|(k, v)| (k.clone(), v.clone())));
    merged
}

// --- Keys ----------------------------------------------------------------------------------------------------------

/// `.replace(/^(["'])(.*)\1$/, "$2")`: one pair of matching surrounding quotes taken off, when what they hold has no
/// line terminator in it.
fn unquote(text: &str) -> &str {
    let mut chars = text.chars();
    let (Some(first), Some(last)) = (chars.next(), chars.next_back()) else {
        return text;
    };
    if (first == '"' || first == '\'') && last == first {
        let inner = &text[1..text.len() - 1];
        if !inner.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
            return inner;
        }
    }
    text
}

/// The provider's key, trimmed of whitespace and quotes, or a refusal (R4). `None` when the key is optional and
/// absent.
fn require_key(
    entry: &ProviderEntry,
    id: &str,
    key: Option<&str>,
    optional: bool,
) -> Result<Option<String>, EngineEnvError> {
    let k = js_trim(unquote(js_trim(key.unwrap_or(""))));
    let label = label_of(entry, id);
    if k.is_empty() {
        if optional {
            return Ok(None);
        }
        let place = entry
            .env_key
            .as_deref()
            .filter(|name| !name.is_empty())
            .map(|name| format!(" (Settings > AI, or the {name} variable)"))
            .unwrap_or_default();
        return Err(refuse(
            CredentialCode::NeedsKey,
            format!("{label} needs its API key{place}."),
            id,
        ));
    }
    // A line break would let the key carry a second header; a NUL can't be in an environment string at all.
    if k.contains(['\r', '\n', '\0']) {
        let message = format!("The {label} key has a line break in it; paste it again.");
        return Err(refuse(CredentialCode::BadKey, message, id));
    }
    for slot in &entry.wrong_slot {
        if slot.re.is_match(k) {
            let message = if slot.message.is_empty() {
                format!("That isn't a {label} key.")
            } else {
                slot.message.clone()
            };
            return Err(refuse(CredentialCode::BadKey, message, id));
        }
    }
    Ok(Some(k.to_string()))
}

/// The provider's key checked as a turn would check it (R4: trimmed of whitespace and quotes; a line break or another
/// provider's key refused with bad-key, a missing one with needs-key), without putting it anywhere. Local AI's key is
/// optional: `None` when there is none. The Codex engine checks the owner's Local AI key with this before handing it
/// to the Local AI bridge (`ai/local_bridge.rs`), which adds it on the way to the owner's server: the Codex process
/// itself only ever gets the bridge's per-turn token.
pub fn checked_provider_key<'a>(
    provider: impl Into<ProviderRef<'a>>,
    key: Option<&str>,
) -> Result<Option<String>, EngineEnvError> {
    let entry = entry_of(provider.into())?;
    let id = canonical_id(&entry.id);
    require_key(&entry, &id, key, key_optional(&id))
}

// --- Hosts (R3) and the test-only seam -----------------------------------------------------------------------------

static LOOPBACK_V4: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$").expect("a loopback pattern"));

fn is_loopback_host(hostname: &str) -> bool {
    let h = hostname.to_lowercase();
    h == "localhost" || h == "[::1]" || LOOPBACK_V4.is_match(&h)
}

/// A plain http(s) URL with no user info in it, or `None` (`new URL(raw)`, WHATWG parsing).
fn plain_http_url(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(raw).ok()?;
    if (url.scheme() != "http" && url.scheme() != "https") || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(url)
}

/// The test-only base-URL override TARSEE_TEST_BASE_URL_<ID>, or `None`. Honored only when NODE_ENV is exactly
/// "test" and the URL is plain http(s) on a loopback host with no user info, so a fake server in a test can stand in
/// for a provider and nothing in production can point a stored key anywhere else.
pub fn test_base_url(provider_id: &str, env: &Env) -> Option<String> {
    if env.get("NODE_ENV").as_deref() != Some("test") {
        return None;
    }
    let mut name = String::from("TARSEE_TEST_BASE_URL_");
    for c in provider_id.to_uppercase().chars() {
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            name.push(c);
        } else {
            // One "_" per UTF-16 unit, as the JS replace saw them.
            name.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    let raw = env.get(&name).unwrap_or_default();
    let raw = js_trim(&raw);
    if raw.is_empty() {
        return None;
    }
    let url = plain_http_url(raw)?;
    is_loopback_host(url.host_str().unwrap_or("")).then(|| raw.to_string())
}

/// The host a provider's turn goes to on an engine, the one way to get it (Codex's config and Claude Code's
/// ANTHROPIC_BASE_URL are both built from it):
///
/// - claude, chatgpt: `None`: a sign-in plan signs in to the engine's own host, and no key goes with it
/// - local: the owner's server address (`local_url`: ai.local.baseUrl, else TARSEE_LOCAL_AI_URL), which must be a
///   plain http(s) URL; none refuses the turn with needs-setup
/// - every key provider: the entry's code constant for that engine; none refuses the turn with wrong-engine, so a
///   key never falls through to an engine's default host (Codex's is OpenAI's)
///
/// The test seam stands in for any provider but the sign-in plans, in tests only.
pub fn host_for<'a>(
    provider: impl Into<ProviderRef<'a>>,
    engine: &str,
    env: &Env,
    local_url: Option<&str>,
) -> Result<Option<String>, EngineEnvError> {
    let entry = entry_of(provider.into())?;
    let id = assert_runs(&entry, engine)?;
    if is_sign_in(&id) {
        return Ok(None);
    }
    if let Some(seam) = test_base_url(&id, env) {
        return Ok(Some(seam));
    }
    let label = label_of(&entry, &id);
    if id == "local" {
        let raw = js_trim(local_url.unwrap_or(""));
        if raw.is_empty() {
            let message = format!("{label} has no server address yet. Add it in Settings > AI.");
            return Err(refuse(CredentialCode::NeedsSetup, message, &id));
        }
        if plain_http_url(raw).is_none() {
            let message =
                format!("{label}'s server address must be an http:// or https:// URL with no password in it.");
            return Err(refuse(CredentialCode::NeedsSetup, message, &id));
        }
        return Ok(Some(raw.to_string()));
    }
    match entry.base_url.get(engine).filter(|host| !host.is_empty()) {
        Some(host) => Ok(Some(host.clone())),
        None => {
            let message = format!("{label} has no {} host.", engine_name(engine));
            Err(refuse(CredentialCode::WrongEngine, message, &id))
        }
    }
}

// --- Claude Code (R2 blocks, design 4.7) ---------------------------------------------------------------------------

static LINE_BREAKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\r\n\x00]+").expect("a line-break pattern"));

fn one_line(text: Option<&str>) -> String {
    js_trim(&LINE_BREAKS.replace_all(text.unwrap_or(""), " ")).to_string()
}

/// Claude Code's "[1m]" context suffix is the engine's business, not part of a provider's model id.
fn bare_model(model: Option<&str>) -> String {
    let model = js_trim(model.unwrap_or(""));
    let cut = model.len().saturating_sub(4);
    match model.get(cut..) {
        Some(tail) if tail.eq_ignore_ascii_case("[1m]") => model[..cut].to_string(),
        _ => model.to_string(),
    }
}

const ONE_MILLION: f64 = 1_000_000.0;

/// A model's context window from the entry's catalog (by its bare id), or NaN.
fn catalog_context(entry: &ProviderEntry, model: Option<&str>) -> f64 {
    let id = bare_model(model);
    entry
        .models
        .iter()
        .find(|m| m.id == id)
        .and_then(|m| m.context)
        .unwrap_or(f64::NAN)
}

/// A gateway pin: the provider's own id, with Claude Code's "[1m]" when that model's window is at least 1M (design
/// 4.7's rule for the turn's model). Every pin follows the same rule, so the main, tier and subagent pins agree.
fn pin_of(model: &str, context: f64) -> String {
    let id = bare_model(Some(model));
    if context >= ONE_MILLION {
        format!("{id}[1m]")
    } else {
        id
    }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// The model pins of a gateway turn, by variable name, in the order the JS checked them.
type Pins = Vec<(&'static str, String)>;

fn gateway_pins(entry: &ProviderEntry, id: &str, opts: &ClaudeEnvOpts) -> Result<(f64, Pins), EngineEnvError> {
    let label = label_of(entry, id);
    let pick = |own: &Option<String>, theirs: &Option<String>| own.clone().or_else(|| theirs.clone());
    let tiers = Tiers {
        fable: pick(&opts.tiers.fable, &entry.tiers.fable),
        opus: pick(&opts.tiers.opus, &entry.tiers.opus),
        sonnet: pick(&opts.tiers.sonnet, &entry.tiers.sonnet),
        haiku: pick(&opts.tiers.haiku, &entry.tiers.haiku),
    };
    let model = bare_model(non_empty(&opts.model).or(entry.default_model.as_deref()));
    if model.is_empty() {
        return Err(refuse(
            CredentialCode::BadModel,
            format!("No model chosen for {label}."),
            id,
        ));
    }
    let context = opts
        .context_tokens
        .unwrap_or_else(|| catalog_context(entry, Some(&model)));
    let main = pin_of(&model, context);
    // A tier naming the turn's own model gets the main pin; any other is pinned by its own catalog window.
    let tier = |t: Option<&str>| match t.filter(|t| !t.is_empty()) {
        Some(t) if bare_model(Some(t)) != model => pin_of(t, catalog_context(entry, Some(t))),
        _ => main.clone(),
    };
    let pins = vec![
        ("ANTHROPIC_MODEL", main.clone()),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", tier(tiers.opus.as_deref())),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", tier(tiers.sonnet.as_deref())),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", tier(tiers.haiku.as_deref())),
        (
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            tier(non_empty(&tiers.fable).or(tiers.opus.as_deref())),
        ),
        ("ANTHROPIC_SMALL_FAST_MODEL", tier(tiers.haiku.as_deref())),
        ("CLAUDE_CODE_SUBAGENT_MODEL", main.clone()),
    ];
    for (name, value) in &pins {
        if value
            .get(..7)
            .is_some_and(|start| start.eq_ignore_ascii_case("claude-"))
        {
            let message = format!("{name} names a Claude model ({value}), which {label} doesn't serve.");
            return Err(refuse(CredentialCode::BadModel, message, id));
        }
    }
    Ok((context, pins))
}

/// CLAUDE_CODE_MAX_CONTEXT_TOKENS and a compact window no bigger than the model's context, for a gateway model.
fn context_env(context: f64, merged: &EnvMap) -> EnvMap {
    if !context.is_finite() || context <= 0.0 {
        return EnvMap::new();
    }
    let compact = merged
        .get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
        .map_or(f64::NAN, |v| js_number(v));
    let window = if compact.is_finite() && compact > 0.0 {
        compact.min(context)
    } else {
        context
    };
    EnvMap::from([
        (
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(),
            number_to_string(js_round(context)),
        ),
        (
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
            number_to_string(js_round(window)),
        ),
    ])
}

/// Every key and gateway turn runs host-managed (CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1). The pinned CLI then ignores
/// provider and credential entries in settings files' env blocks (a second layer under R5's guard: without it a
/// planted <workspace>/.claude/settings.json env.ANTHROPIC_BASE_URL sends the turn, key and all, to that host), and
/// keeps the block's key and headers out of the environment of the commands the agent runs (R10), while the vault's
/// keys still reach them and the requests still carry the key and the title header. That is not isolation: those
/// commands run as the same user as the CLI, so on Linux they can still read the key from the CLI's
/// /proc/<pid>/environ (test/key-exposure-linux.test.js); the docs and cards say so and recommend a capped key.
/// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, the other candidate for R10, also strips the vault's keys from those commands, so
/// it stays off. Both were checked against the pinned CLI (test/claude-gateway.test.js). Not on the plan: its
/// behaviour stays as it was.
pub const HOST_MANAGED: [(&str, &str); 1] = [("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1")];

/// What [`claude_env_for`] builds from.
#[derive(Debug, Clone, Default)]
pub struct ClaudeEnvOpts {
    /// The server's environment.
    pub env: Env,
    /// The vault's keys for scripts: `agent_vault_env` compared against [`base_env`]`(env)`.
    pub vault_env: EnvMap,
    /// Extra env for Claude Code; `None` means [`cost_saver_env`]`(env)`.
    pub cost_saver: Option<EnvMap>,
    /// The provider's key (anthropic, deepseek, openrouter); never read from the environment here.
    pub key: Option<String>,
    /// The turn's model id (gateways; default the entry's default model; "[1m]" or not, the same model).
    pub model: Option<String>,
    /// Tier overrides (OpenRouter's editable tiers).
    pub tiers: Tiers,
    /// The turn model's context (default from the entry's models; pass `context_tokens_for()` for OpenRouter).
    pub context_tokens: Option<f64>,
    /// OpenRouter's attribution headers.
    pub app_title: Option<String>,
    pub referer: Option<String>,
    /// The provider's CLAUDE_CONFIG_DIR (default [`home_for`]`(id, "claude-code", ...)`).
    pub home: Option<PathBuf>,
    /// Tarsee's state folder (`config.state_dir`), required for a key home unless `home` is given.
    pub state_dir: Option<PathBuf>,
    /// The user's home folder, for the plan's home (default `os.homedir()`).
    pub home_dir: Option<PathBuf>,
}

/// The environment for a Claude Code turn on `provider` (its registry entry; the plan may be given as its id).
///
/// Blocks:
/// - claude: the operator's Claude sign-in variables ([`PLAN_SIGN_IN_NAMES`]), only those set in the server's
///   environment. Nothing else.
/// - anthropic: CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY (no ANTHROPIC_BASE_URL: it is stripped, so Claude Code uses its
///   own default, which is the entry's constant)
/// - gateways: CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL (constant), ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY="", every
///   model pinned to the provider's own ids, betas, attribution and nonessential traffic off, the context.
///
/// The engine (`providers/claude_code.rs`) adds [`HOST_MANAGED`] to every block but the plan's.
pub fn claude_env_for<'a>(
    provider: impl Into<ProviderRef<'a>>,
    opts: &ClaudeEnvOpts,
) -> Result<EnvMap, EngineEnvError> {
    let entry = entry_of(provider.into())?;
    let id = assert_runs(&entry, CLAUDE_CODE)?;
    let env = &opts.env;
    let cost_saver = opts.cost_saver.clone().unwrap_or_else(|| cost_saver_env(env));
    let mut merged = finalize_env(&FinalizeOpts {
        env: env.clone(),
        vault_env: opts.vault_env.clone(),
        extra_env: cost_saver,
        credentials: EnvMap::new(),
        strip_names: entry.env_key.iter().cloned().collect(),
    });

    if id == "claude" {
        for name in PLAN_SIGN_IN_NAMES {
            let value = env.get(name).unwrap_or_default();
            let value = js_trim(&value);
            if !value.is_empty() {
                merged.insert(name.to_string(), value.to_string());
            }
        }
        return Ok(merged);
    }

    let key = require_key(&entry, &id, opts.key.as_deref(), false)?.unwrap_or_default();
    let home = match opts.home.as_ref().filter(|h| !h.as_os_str().is_empty()) {
        Some(home) => home.clone(),
        None => home_for(
            &id,
            CLAUDE_CODE,
            env,
            &HomeOpts {
                state_dir: opts.state_dir.clone(),
                home_dir: opts.home_dir.clone(),
            },
        )?,
    };
    let home = path_string(&home);

    if id == "anthropic" {
        merged.insert("CLAUDE_CONFIG_DIR".into(), home);
        if let Some(seam) = test_base_url(&id, env) {
            merged.insert("ANTHROPIC_BASE_URL".into(), seam);
        }
        merged.insert("ANTHROPIC_API_KEY".into(), key);
        return Ok(merged);
    }

    let base_url = host_for(&*entry, CLAUDE_CODE, env, None)?.unwrap_or_default();
    let (context, pins) = gateway_pins(&entry, &id, opts)?;
    let mut block = EnvMap::new();
    block.insert("CLAUDE_CONFIG_DIR".into(), home);
    block.insert("ANTHROPIC_BASE_URL".into(), base_url);
    block.insert("ANTHROPIC_AUTH_TOKEN".into(), key);
    block.insert("ANTHROPIC_API_KEY".into(), String::new());
    block.extend(pins.into_iter().map(|(name, value)| (name.to_string(), value)));
    block.insert("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".into(), "1".into());
    block.insert("CLAUDE_CODE_ATTRIBUTION_HEADER".into(), "0".into());
    block.insert("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into());
    block.extend(context_env(context, &merged));
    if id == "openrouter" {
        let title = one_line(opts.app_title.as_deref());
        let mut headers = vec![format!(
            "X-OpenRouter-Title: {}",
            if title.is_empty() { "Tarsee" } else { &title }
        )];
        let referer = one_line(opts.referer.as_deref());
        if !referer.is_empty() {
            headers.push(format!("HTTP-Referer: {referer}"));
        }
        block.insert("ANTHROPIC_CUSTOM_HEADERS".into(), headers.join("\n"));
    }
    merged.extend(block);
    Ok(merged)
}

// --- Codex (R2 blocks, design 4.8) ---------------------------------------------------------------------------------

/// What [`codex_env_for`] builds from.
#[derive(Debug, Clone, Default)]
pub struct CodexEnvOpts {
    /// The server's environment.
    pub env: Env,
    pub vault_env: EnvMap,
    pub key: Option<String>,
    /// Required: the per-turn token for Tarsee's MCP endpoint.
    pub mcp_token: Option<String>,
    pub home: Option<PathBuf>,
    /// Tarsee's state folder (`config.state_dir`), required unless `home` is given.
    pub state_dir: Option<PathBuf>,
}

/// The environment for a Codex turn on `provider` (its registry entry). No base URL ever goes in it (Codex hosts go
/// in its config, from [`host_for`], and OPENAI_BASE_URL is stripped), and no key is ever placed in config or argv.
///
/// Blocks (all get CODEX_HOME and TARSEE_MCP_TOKEN):
/// - chatgpt: nothing else: Codex's own sign-in in its home (.codex-home)
/// - openai: nothing else in env: the engine passes the key as Codex's CODEX_API_KEY in the child only. The key is
///   still required here, so a missing one refuses the turn before anything starts.
/// - openrouter, deepseek: TARSEE_PROVIDER_KEY (the custom provider's env_key)
/// - local: TARSEE_PROVIDER_KEY holds the Local AI bridge's per-turn token (codex-options passes it as `key`), never
///   the owner's key: the bridge (`local_bridge.rs`) adds that on the way to the owner's server. Optional here, so a
///   caller with no bridge token gets no TARSEE_PROVIDER_KEY at all.
pub fn codex_env_for<'a>(provider: impl Into<ProviderRef<'a>>, opts: &CodexEnvOpts) -> Result<EnvMap, EngineEnvError> {
    let entry = entry_of(provider.into())?;
    let id = assert_runs(&entry, CODEX)?;
    let mcp_token = js_trim(opts.mcp_token.as_deref().unwrap_or(""));
    if mcp_token.is_empty() || mcp_token.contains(['\r', '\n', '\0']) {
        return Err(refuse(
            CredentialCode::NeedsMcpToken,
            "This turn has no token for Tarsee's tools.",
            &id,
        ));
    }
    let mut merged = finalize_env(&FinalizeOpts {
        env: opts.env.clone(),
        vault_env: opts.vault_env.clone(),
        strip_names: entry.env_key.iter().cloned().collect(),
        ..FinalizeOpts::default()
    });
    let home = match opts.home.as_ref().filter(|h| !h.as_os_str().is_empty()) {
        Some(home) => home.clone(),
        None => home_for(
            &id,
            CODEX,
            &opts.env,
            &HomeOpts {
                state_dir: opts.state_dir.clone(),
                home_dir: None,
            },
        )?,
    };
    let mut block = EnvMap::new();
    block.insert("CODEX_HOME".into(), path_string(&home));
    block.insert("TARSEE_MCP_TOKEN".into(), mcp_token.to_string());
    if id == "openai" {
        require_key(&entry, &id, opts.key.as_deref(), false)?;
    } else if id != "chatgpt"
        && let Some(key) = require_key(&entry, &id, opts.key.as_deref(), key_optional(&id))?
    {
        block.insert("TARSEE_PROVIDER_KEY".into(), key);
    }
    merged.extend(block);
    Ok(merged)
}

/// The names kept out of a Codex turn's shell environment (R7; still readable from codex's /proc/<pid>/environ on
/// Linux, see test/key-exposure-linux.test.js): the engine's own credentials. Everything else in the turn's
/// environment reaches the shell (shell_environment_policy inherit "all", with Codex's default *KEY*, *SECRET* and
/// *TOKEN* excludes switched off), so the vault's keys still reach scripts by name.
pub const CODEX_SHELL_EXCLUDED: [&str; 5] = [
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "TARSEE_MCP_TOKEN",
    "TARSEE_PROVIDER_KEY",
    "TARSEE_CHATGPT_ACCESS_TOKEN",
];

/// ChatGPT's two hosts in a test (see [`codex_chatgpt_test_hosts`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatgptTestHosts {
    pub chatgpt_base_url: String,
    pub openai_base_url: String,
}

/// The ChatGPT sign-in's hosts in a test, or `None` (always, outside one). The ChatGPT plan sends its sign-in only to
/// Codex's own hosts ([`host_for`] gives `None`), so a test that runs the real Codex on it points both of ChatGPT's
/// hosts at a fake server through TARSEE_TEST_BASE_URL_CHATGPT (its origin): the backend (chatgpt_base_url) and the
/// model requests (openai_base_url, which Codex also uses for ChatGPT's /codex/responses and /codex/models). Honored
/// only as [`test_base_url`] honors it: NODE_ENV exactly "test" and a loopback http(s) URL.
pub fn codex_chatgpt_test_hosts(env: &Env) -> Option<ChatgptTestHosts> {
    let seam = test_base_url("chatgpt", env)?;
    let origin = seam.trim_end_matches('/');
    Some(ChatgptTestHosts {
        chatgpt_base_url: format!("{origin}/backend-api/"),
        openai_base_url: format!("{origin}/backend-api/codex"),
    })
}

// --- Homes (R1) ----------------------------------------------------------------------------------------------------

/// Where [`home_for`] puts a home.
#[derive(Debug, Clone, Default)]
pub struct HomeOpts {
    /// `config.state_dir`: required for every home but the plan's. There is no default, because only the
    /// configuration knows where the state folder really is, a Railway volume included.
    pub state_dir: Option<PathBuf>,
    /// The user's home folder, for the plan's home; `None` means the home of the `Env` given to [`home_for`] (the
    /// JS `os.homedir()`).
    pub home_dir: Option<PathBuf>,
}

/// The credential home for a provider on an engine:
///
/// - claude on Claude Code: `<home_dir>/.claude` (the Terminal's `claude auth login`; /home/node/.claude on Railway)
/// - anthropic, deepseek, openrouter: `<state_dir>/.claude-home-<id>` (CLAUDE_CONFIG_DIR)
/// - chatgpt on Codex: `<state_dir>/.codex-home` (Codex's own device sign-in)
/// - every other Codex turn: `<state_dir>/.codex-home-keys`
///
/// `env` is the server's environment (`app.env()`); it gives only the plan's home folder when `home_dir` is unset,
/// never a state folder (TARSEE_STATE_DIR in it is not a default).
pub fn home_for(provider_id: &str, engine: &str, env: &Env, opts: &HomeOpts) -> Result<PathBuf, EngineEnvError> {
    let id = canonical_id(provider_id);
    if home_key(&id, engine).is_none() {
        let message = format!("{provider_id} doesn't run on {engine}.");
        return Err(refuse(CredentialCode::WrongEngine, message, &id));
    }
    if id == "claude" {
        let home_dir = opts
            .home_dir
            .clone()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or_else(|| crate::config::env::home_dir(env));
        return Ok(node_join(&home_dir, ".claude"));
    }
    let state = opts.state_dir.as_deref().map(js_trim_path).unwrap_or_default();
    if state.as_os_str().is_empty() {
        return Err(TypeError(format!(
            "engine-env: stateDir (config.STATE_DIR) is required for {id}'s {} home",
            engine_name(engine)
        ))
        .into());
    }
    if engine == CLAUDE_CODE {
        return Ok(node_join(&state, format!(".claude-home-{id}")));
    }
    Ok(node_join(
        &state,
        if id == "chatgpt" {
            ".codex-home"
        } else {
            ".codex-home-keys"
        },
    ))
}

/// The session-handle home key (design 4.10): cc on Claude Code, cxd for .codex-home, cx for .codex-home-keys;
/// `None` if it can't run there.
pub fn home_key_for(provider_id: &str, engine: &str) -> Option<&'static str> {
    home_key(&canonical_id(provider_id), engine)
}

/// Create a credential home (and its parents) owner-only, tightening one that exists. Returns the folder.
pub fn ensure_home(dir: &Path) -> io::Result<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)?;
        // Node's chmod(0o700) on Windows only clears the read-only attribute (the owner may write).
        let mut permissions = std::fs::metadata(dir)?.permissions();
        if permissions.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            std::fs::set_permissions(dir, permissions)?;
        }
    }
    Ok(dir.to_path_buf())
}

/// A file reader standing in for the real one in tests (the JS `readFile` option): the file's text, or the error.
pub type ReadFile<'a> = &'a dyn Fn(&Path) -> io::Result<String>;

/// `fs.readFileSync(path, "utf8")`: bytes that aren't UTF-8 become U+FFFD rather than an error.
pub fn read_text(path: &Path) -> io::Result<String> {
    std::fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// ENOENT or ENOTDIR: the file isn't there (a guard passes it).
fn is_missing(err: &io::Error) -> bool {
    matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

static LOGIN_KEY_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    let s = JS_SPACE_CLASS;
    Regex::new(&format!(r#""primaryApiKey"[{s}]*:[{s}]*"[{s}]*[^"{s}]"#)).expect("a login-key pattern")
});

static UNICODE_ESCAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\u([0-9A-Fa-f]{4})").expect("a unicode-escape pattern"));

/// The text with its `\uXXXX` escapes written out (a surrogate one as U+FFFD), so a key name spelled with escapes
/// reads as the name.
fn unescape_unicode(text: &str) -> String {
    UNICODE_ESCAPE
        .replace_all(text, |c: &regex::Captures<'_>| {
            u32::from_str_radix(&c[1], 16)
                .ok()
                .and_then(char::from_u32)
                .unwrap_or('\u{FFFD}')
                .to_string()
        })
        .into_owned()
}

/// Whether a Claude Code global config file holds a Console key saved by `/login` (primaryApiKey). The CLI writes
/// this file on every run, so only a stored key counts. A file that isn't JSON is searched as text, so a torn write
/// can't hide one; a file that is there but can't be read counts as holding one (fail closed).
///
/// The JSON is read as `JSON.parse` reads it (`js_json`), so this decides as the Node version did on every file it
/// could parse. On a file it can't, the text is searched as the JS searched it and, failing closed, once more with its
/// `\uXXXX` escapes written out, so a torn file can't hide a key behind an escaped name either.
fn holds_login_key(file: &Path, read_file: ReadFile<'_>) -> bool {
    let text = match read_file(file) {
        Ok(text) => text,
        Err(err) => return !is_missing(&err),
    };
    match js_json::parse(strip_bom(&text)) {
        Some(json) => matches!(json.member("primaryApiKey"), Some(js_json::Value::Str(key)) if !js_json::is_blank(key)),
        None => LOGIN_KEY_TEXT.is_match(&text) || LOGIN_KEY_TEXT.is_match(&unescape_unicode(&text)),
    }
}

/// R1's refusal (see [`home_isolation_refusal`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IsolationRefusal {
    pub code: CredentialCode,
    pub file: PathBuf,
    pub message: String,
}

/// How [`home_isolation_refusal`] looks.
#[derive(Default)]
pub struct IsolationOpts<'a> {
    /// With `engine`: treat the home as this provider's even at another path.
    pub provider_id: Option<&'a str>,
    pub engine: Option<&'a str>,
    /// `fs.existsSync` (default: the real one).
    pub exists: Option<&'a dyn Fn(&Path) -> bool>,
    /// The file reader (default: [`read_text`]).
    pub read_file: Option<ReadFile<'a>>,
}

/// R1's refusal: a key home holding a sign-in or another key, so the Claude or ChatGPT sign-in, or a Console key,
/// could load in a process aimed at someone else. Returns the refusal or `None`.
///
/// - A .claude-home-* folder must hold no .credentials.json (the claude.ai sign-in), and its global config
///   (.config.json, which the CLI reads first when it is there, else .claude.json) no primaryApiKey (a Console key a
///   Terminal `/login` saved): on a gateway turn ANTHROPIC_API_KEY is empty, and the CLI would fall back to that key
///   and send it to the gateway's host.
/// - .codex-home-keys must hold no auth.json.
///
/// With `provider_id` and `engine`, the same holds for a key home at any other path.
pub fn home_isolation_refusal(home: &Path, opts: &IsolationOpts<'_>) -> Option<IsolationRefusal> {
    let resolved = resolve_path(home);
    let name = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let id = opts.provider_id.map(canonical_id).filter(|id| !id.is_empty());
    let engine = opts.engine.unwrap_or("");
    let key_claude_home =
        name.starts_with(".claude-home-") || id.as_deref().is_some_and(|id| id != "claude" && engine == CLAUDE_CODE);
    let key_codex_home =
        name == ".codex-home-keys" || id.as_deref().is_some_and(|id| id != "chatgpt" && engine == CODEX);
    let sign_in = if key_claude_home {
        ".credentials.json"
    } else if key_codex_home {
        "auth.json"
    } else {
        return None;
    };
    let real_exists = |path: &Path| path.exists();
    let exists: &dyn Fn(&Path) -> bool = opts.exists.unwrap_or(&real_exists);
    let read_file: ReadFile<'_> = opts.read_file.unwrap_or(&read_text);

    let file = node_join(home, sign_in);
    if exists(&file) {
        let message = format!(
            "{} is a sign-in file in a folder meant only for an API key. Tarsee won't start this turn while it is there; delete it (or sign in from the Terminal without pointing at this folder).",
            file.display()
        );
        return Some(IsolationRefusal {
            code: CredentialCode::CredentialIsolation,
            file,
            message,
        });
    }
    if key_claude_home {
        for config in [".config.json", ".claude.json"] {
            let config_file = node_join(home, config);
            if !holds_login_key(&config_file, read_file) {
                continue;
            }
            let message = format!(
                "{} holds an Anthropic Console key saved by /login (primaryApiKey), in a folder meant only for this provider's key. Tarsee won't start this turn while it is there; remove the primaryApiKey entry (or run /login from the Terminal without pointing at this folder).",
                config_file.display()
            );
            return Some(IsolationRefusal {
                code: CredentialCode::CredentialIsolation,
                file: config_file,
                message,
            });
        }
    }
    None
}

// --- Settings files (R5) -------------------------------------------------------------------------------------------

/// settingSources per provider: today's behaviour for the plan, made explicit; only the project's for every other.
pub fn setting_sources_for(provider_id: &str) -> Vec<&'static str> {
    if is_plan(provider_id) {
        vec!["user", "project", "local"]
    } else {
        vec!["project"]
    }
}

/// The settings files a Claude Code turn would load: the home's settings.json always (the agent's Bash can write
/// it), then <workspace>/.claude/settings.json for "project" and settings.local.json for "local".
pub fn settings_files_for(setting_sources: &[&str], home: &Path, workspace: &Path) -> Vec<PathBuf> {
    let mut files = vec![node_join(home, "settings.json")];
    if setting_sources.contains(&"project") {
        files.push(node_join(workspace, Path::new(".claude").join("settings.json")));
    }
    if setting_sources.contains(&"local") {
        files.push(node_join(workspace, Path::new(".claude").join("settings.local.json")));
    }
    files
}

/// A file a guard refused: which, and the entries (names, never values) it refused for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GuardFile {
    pub file: PathBuf,
    pub entries: Vec<String>,
    /// There, but not readable safely (fail closed).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
    /// A Codex home's .env (refused whatever it holds).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dotenv: bool,
}

impl GuardFile {
    /// A file refused for these entries.
    pub fn entries(file: impl Into<PathBuf>, entries: &[&str]) -> Self {
        GuardFile {
            file: file.into(),
            entries: entries.iter().map(|e| e.to_string()).collect(),
            unreadable: false,
            dotenv: false,
        }
    }

    /// A file that is there but can't be read safely.
    pub fn unreadable(file: impl Into<PathBuf>) -> Self {
        GuardFile {
            unreadable: true,
            ..GuardFile::entries(file, &[])
        }
    }
}

/// A guard's answer: `ok`, or the files it refused and the message for the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GuardResult {
    pub ok: bool,
    pub files: Vec<GuardFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl GuardResult {
    fn pass() -> Self {
        GuardResult {
            ok: true,
            files: Vec::new(),
            message: None,
        }
    }
}

/// R5: refuse the turn when any settings file that will load sets a credential through its env block (a name
/// [`AUTH_ENV_RE`] covers, in any case) or defines apiKeyHelper. A file that is there but can't be read as JSON
/// refuses too (fail closed); a missing one is fine. Entries are names like "env.ANTHROPIC_BASE_URL" and
/// "apiKeyHelper", never values.
pub fn settings_file_guard(paths: &[PathBuf], read_file: Option<ReadFile<'_>>) -> GuardResult {
    let read_file: ReadFile<'_> = read_file.unwrap_or(&read_text);
    let mut files = Vec::new();
    for file in paths {
        let text = match read_file(file) {
            Ok(text) => text,
            Err(err) if is_missing(&err) => continue,
            Err(_) => {
                files.push(GuardFile::unreadable(file));
                continue;
            }
        };
        // Read as JSON.parse reads it (a lone surrogate, a number beyond f64 and any depth are fine).
        let Some(json) = js_json::parse(strip_bom(&text)) else {
            files.push(GuardFile::unreadable(file));
            continue;
        };
        if !matches!(json, js_json::Document::Object(_)) {
            continue;
        }
        let mut entries = Vec::new();
        if let Some(js_json::Value::Object(names)) = json.member("env") {
            entries.extend(
                names
                    .iter()
                    .map(|name| js_json::to_text(name))
                    .filter(|name| is_auth_env_name(name))
                    .map(|name| format!("env.{name}")),
            );
        }
        if json.member("apiKeyHelper").is_some() {
            entries.push("apiKeyHelper".to_string());
        }
        if !entries.is_empty() {
            files.push(GuardFile {
                entries,
                ..GuardFile::entries(file, &[])
            });
        }
    }
    if files.is_empty() {
        return GuardResult::pass();
    }
    let lines: Vec<String> = files
        .iter()
        .map(|f| {
            if f.unreadable {
                format!("{} (can't be read as JSON)", f.file.display())
            } else {
                format!("{}: {}", f.file.display(), f.entries.join(", "))
            }
        })
        .collect();
    let message = format!(
        "A Claude Code settings file would change which account this AI uses, so Tarsee won't start the turn. Remove these entries: {}",
        lines.join("; ")
    );
    GuardResult {
        ok: false,
        files,
        message: Some(message),
    }
}

// --- Codex's config.toml (R5's counterpart for Codex) --------------------------------------------------------------

/// The root entries a Codex config.toml may have: what Tarsee seeds (cli_auth_credentials_store,
/// check_for_update_on_startup, forced_login_method) and what Codex itself writes there when used from the Terminal
/// (project trust, notices, the model and effort chosen, the TUI's settings, the Windows sandbox choice the TUI asks
/// for on first run, feature switches from /experimental, the /personality choice). Codex 0.167's turns (`codex exec`)
/// write nothing there; those Terminal entries were recorded by driving the pinned TUI against a fake server. None of
/// them can change where a request goes or run a program: a [projects."<path>"] table holds only trust_level,
/// [windows] only the sandbox kind, and every feature a turn depends on is set again on its command line, which wins.
/// Anything else refuses the turn. An allowlist, not a denylist: the agent's shell can write this file, and Codex
/// keeps adding entries that change where requests go or run a program with the turn's environment (openai_base_url,
/// chatgpt_base_url, model_provider(s), profile(s), mcp_servers, notify, plugins, a network proxy...). --config
/// overrides on the command line don't remove any of them.
pub const CODEX_CONFIG_ALLOWED: [&str; 11] = [
    "cli_auth_credentials_store",
    "check_for_update_on_startup",
    "forced_login_method",
    "projects",
    "notice",
    "model",
    "model_reasoning_effort",
    "tui",
    "windows",
    "features",
    "personality",
];

fn codex_allowed(name: &str) -> bool {
    CODEX_CONFIG_ALLOWED.contains(&name)
}

/// The Codex files a turn would load: the home's config.toml and .env, then the workspace's project config. Those
/// are the only ones: every Codex run Tarsee starts switches the project root search off (project_root_markers=[],
/// in providers/codex_options.rs and codex_cli.rs CODEX_BASE_ARGS), so no .codex/config.toml above the workspace
/// loads, and Codex reads a .env only from its home (checked against the pinned binary: one in the workspace or the
/// process's folder is not loaded).
pub fn codex_config_files_for(home: &Path, workspace: Option<&Path>) -> Vec<PathBuf> {
    let mut files = vec![node_join(home, "config.toml"), node_join(home, ".env")];
    if let Some(workspace) = workspace.filter(|w| !w.as_os_str().is_empty()) {
        files.push(node_join(workspace, Path::new(".codex").join("config.toml")));
    }
    files
}

/// Whether a path is a Codex home's .env ([`codex_config_guard`] refuses any that is there, unread).
fn is_dotenv(file: &Path) -> bool {
    file.file_name()
        .is_some_and(|name| name.to_string_lossy().to_lowercase() == ".env")
}

/// A config.toml the strict line reader can't read safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the file can't be read safely")]
pub struct UnreadableToml;

/// A TOML key path at the start of `s`: bare, 'literal' or "basic" segments joined by dots, with optional spaces.
/// Returns the segments and the rest. A basic segment's escapes are skipped over as TOML reads them (so an escaped
/// quote doesn't end it), and are fine after the first segment: that is how Codex writes a trusted folder whose path
/// can't be a literal string ([projects."C:\\Users\\O'Neil\\…"]). In the first segment, the root name the guard
/// checks, an escape is refused: it could spell any name.
fn read_key_path(s: &str) -> Result<(Vec<String>, &str), UnreadableToml> {
    let b = s.as_bytes();
    let mut segments = Vec::new();
    let mut i = 0;
    loop {
        while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
            i += 1;
        }
        let segment;
        if i < b.len() && b[i] == b'"' {
            let mut end = i + 1;
            let mut escaped = false;
            while end < b.len() && b[end] != b'"' {
                if b[end] == b'\\' {
                    escaped = true;
                    end += 1;
                }
                end += 1;
            }
            if end >= b.len() || (escaped && segments.is_empty()) {
                return Err(UnreadableToml);
            }
            segment = &s[i + 1..end];
            i = end + 1;
        } else if i < b.len() && b[i] == b'\'' {
            let end = s[i + 1..].find('\'').ok_or(UnreadableToml)? + i + 1;
            segment = &s[i + 1..end];
            i = end + 1;
        } else {
            let len = b[i..]
                .iter()
                .take_while(|c| c.is_ascii_alphanumeric() || **c == b'_' || **c == b'-')
                .count();
            if len == 0 {
                return Err(UnreadableToml);
            }
            segment = &s[i..i + len];
            i += len;
        }
        segments.push(segment.to_string());
        while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
            i += 1;
        }
        if i >= b.len() || b[i] != b'.' {
            break;
        }
        i += 1;
    }
    Ok((segments, &s[i..]))
}

/// A blank or comment-only line (`/^\s*(#.*)?$/`).
static TOML_BLANK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[{JS_SPACE_CLASS}]*(?:#{JS_DOT_CLASS}*)?$")).expect("a blank-line pattern")
});

/// A table header line (`/^\s*(\[\[?)(.*)$/`).
static TOML_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^[{JS_SPACE_CLASS}]*(\[\[?)({JS_DOT_CLASS}*)$")).expect("a header pattern"));

/// `text.split(/\r?\n/)`: a CR goes only with the line feed after it, so a last line ending in a lone CR keeps it
/// (and then fails the strict reader, as in the JS).
fn toml_lines(text: &str) -> impl Iterator<Item = &str> {
    let mut pieces = text.split('\n').peekable();
    std::iter::from_fn(move || {
        let piece = pieces.next()?;
        Some(if pieces.peek().is_some() {
            piece.strip_suffix('\r').unwrap_or(piece)
        } else {
            piece
        })
    })
}

/// The root names (each root key's or table's first segment) a config.toml sets, read line by line and strictly:
/// every line must be blank, a comment, a [table] or [[table]] header, or a key = value line. Anything else (a value
/// continued on the next line, a multi-line string) fails, so nothing can hide a root entry from the guard.
fn codex_root_names(text: &str) -> Result<Vec<String>, UnreadableToml> {
    let src = strip_bom(text);
    if src.contains("\"\"\"") || src.contains("'''") {
        return Err(UnreadableToml);
    }
    let mut names = Vec::new();
    let mut at_root = true;
    for line in toml_lines(src) {
        if TOML_BLANK.is_match(line) {
            continue;
        }
        if let Some(header) = TOML_HEADER.captures(line) {
            let (segments, rest) = read_key_path(&header[2])?;
            let close = if &header[1] == "[[" { "]]" } else { "]" };
            let after = js_trim_start(rest);
            if !after.starts_with(close) || !TOML_BLANK.is_match(&after[close.len()..]) {
                return Err(UnreadableToml);
            }
            names.extend(segments.into_iter().next());
            at_root = false;
            continue;
        }
        let (segments, rest) = read_key_path(line)?;
        if !js_trim_start(rest).starts_with('=') {
            return Err(UnreadableToml);
        }
        if at_root {
            names.extend(segments.into_iter().next());
        }
    }
    Ok(names)
}

/// What [`strip_codex_config`] gives back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrippedConfig {
    pub text: String,
    /// The root names taken out, in order.
    pub removed: Vec<String>,
}

/// A config.toml with every root entry outside [`CODEX_CONFIG_ALLOWED`] taken out: root key lines, and whole tables
/// with their lines (Settings > AI's one-click fix, `ai/settings_guard.rs`). Read by the same strict line reader as
/// the guard, so what it keeps is exactly what the guard then allows. Fails for a file the guard can't read safely
/// (that one is set aside instead).
pub fn strip_codex_config(text: &str) -> Result<StrippedConfig, UnreadableToml> {
    let src = strip_bom(text);
    codex_root_names(src)?;
    let eol = if src.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out: Vec<&str> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    let note_removed = |name: String, removed: &mut Vec<String>| {
        if !removed.contains(&name) {
            removed.push(name);
        }
    };
    let mut at_root = true;
    let mut dropping = false;
    for line in toml_lines(src) {
        if TOML_BLANK.is_match(line) {
            if !dropping {
                out.push(line);
            }
            continue;
        }
        if let Some(header) = TOML_HEADER.captures(line) {
            let root = read_key_path(&header[2])?.0.into_iter().next().unwrap_or_default();
            at_root = false;
            dropping = !codex_allowed(&root);
            if dropping {
                note_removed(root, &mut removed);
            } else {
                out.push(line);
            }
            continue;
        }
        if dropping {
            continue;
        }
        if at_root {
            let root = read_key_path(line)?.0.into_iter().next().unwrap_or_default();
            if !codex_allowed(&root) {
                note_removed(root, &mut removed);
                continue;
            }
        }
        out.push(line);
    }
    Ok(StrippedConfig {
        text: out.join(eol),
        removed,
    })
}

/// Before every Codex run (a turn, the device sign-in, the model list): refuse when a config file it would load has
/// a root entry outside [`CODEX_CONFIG_ALLOWED`]. A file that is there but can't be read safely refuses too (fail
/// closed); a missing one is fine. A .env in the Codex home refuses whatever it holds: Codex loads it into its own
/// environment at start (every name but CODEX_*), so HTTP(S)_PROXY there would route the tools' token and the
/// provider's key through the agent's own listener, and SSL_CERT_FILE would let that listener read TLS. It is never
/// read, only noticed. Entries are root names, never values.
pub fn codex_config_guard(paths: &[PathBuf], read_file: Option<ReadFile<'_>>) -> GuardResult {
    let read_file: ReadFile<'_> = read_file.unwrap_or(&read_text);
    let mut files: Vec<GuardFile> = Vec::new();
    for file in paths {
        if is_dotenv(file) {
            let present = match std::fs::symlink_metadata(file) {
                Ok(_) => true,
                Err(err) => !is_missing(&err),
            };
            if present {
                files.push(GuardFile {
                    dotenv: true,
                    ..GuardFile::unreadable(file)
                });
            }
            continue;
        }
        let text = match read_file(file) {
            Ok(text) => text,
            Err(err) if is_missing(&err) => continue,
            Err(_) => {
                files.push(GuardFile::unreadable(file));
                continue;
            }
        };
        let Ok(names) = codex_root_names(&text) else {
            files.push(GuardFile::unreadable(file));
            continue;
        };
        let mut entries: Vec<String> = Vec::new();
        for name in names {
            if !codex_allowed(&name) && !entries.contains(&name) {
                entries.push(name);
            }
        }
        if !entries.is_empty() {
            files.push(GuardFile {
                entries,
                ..GuardFile::entries(file, &[])
            });
        }
    }
    if files.is_empty() {
        return GuardResult::pass();
    }
    let mut parts = Vec::new();
    let lines: Vec<String> = files
        .iter()
        .filter(|f| !f.dotenv)
        .map(|f| {
            if f.unreadable {
                format!("{} (can't be read safely)", f.file.display())
            } else {
                format!("{}: {}", f.file.display(), f.entries.join(", "))
            }
        })
        .collect();
    if !lines.is_empty() {
        parts.push(format!(
            "A Codex config file could change where this AI's key goes, so Tarsee won't start the turn. Remove these entries: {}",
            lines.join("; ")
        ));
    }
    for f in files.iter().filter(|f| f.dotenv) {
        parts.push(format!(
            "Codex loads {} into its own environment (a proxy, a certificate file or a token there would override the turn's), so Tarsee won't start it; set the file aside.",
            f.file.display()
        ));
    }
    GuardResult {
        ok: false,
        files,
        message: Some(parts.join(" ")),
    }
}

// --- Paths, as Node's `path` module spells them --------------------------------------------------------------------

/// The path as a string for an environment variable.
pub(crate) fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `String(path).trim()` as a path: surrounding whitespace off a path that is text.
pub(crate) fn js_trim_path(path: &Path) -> PathBuf {
    match path.to_str() {
        Some(text) => PathBuf::from(js_trim(text)),
        None => path.to_path_buf(),
    }
}

/// `path.resolve(path)`: absolute against the process's working folder, then normalized.
pub(crate) fn resolve_path(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    normalize_path(&absolute)
}

#[cfg(test)]
mod tests;
