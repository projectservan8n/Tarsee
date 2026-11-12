//! Port of `src/ai/provider-status.js`: "can this AI answer right now, and if not, what does the owner do?" (design
//! 4.3 and 4.14).
//!
//! [`provider_status`] is the one answer every readiness consumer reads: the provider cards in Settings > AI
//! (`routes/ai.rs`), the setup check (/api/settings/setup-status), the doctor (`self_heal.rs` checkProvider),
//! /healthz/deep and the boot line. It returns
//! `{ id, label, kind, state, ready, detail, fix, keySource, keyHint, keySourceText, account, balance }`
//! where state is one of [`PROVIDER_STATES`]:
//!
//! ```text
//!   ready              it can answer
//!   needs-key          a key provider with no key in Settings or its Railway variable
//!   needs-sign-in      a plan nobody has signed in to (claude auth login, or ChatGPT's device code)
//!   sign-in-expired    a plan whose sign-in the engine reported as expired (the failure flag)
//!   out-of-credit      the engine reported billing, or the cached balance is empty
//!   blocked-keys-only  a plan while "API keys only" is on
//!   needs-setup        Local AI without a usable address or model
//!   error              anything else (a key pasted in the wrong slot, a rejected key, a sign-in check that failed)
//! ```
//!
//! It reads Settings, the environment, the sign-in files and the failure flags the engines write (`ai.<id>.status`:
//! `{state, at, detail}`). It makes no network call: the balance it shows is the 10-minute cache
//! (`cache.<id>.balance`) that the Test button and the provider cards fill (`provider_probes.rs`). It never hands out
//! a key: only where it came from ("settings", "env:NAME", "sign-in") and its last 4 characters.
//!
//! What the JS read from the process around it comes from the `App` here: the state folder and whether stored
//! secrets are encrypted (the configuration), the database a saved key's row is looked at in, the registry's runtime
//! model lists, and the server's environment, which is also where a key's Railway variable is always read from (the
//! JS store read `process.env` for it whatever `deps.env` was).

use std::path::{Path, PathBuf};

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::codex_device_login::{LoginStatusOpts, login_status};
use super::codex_models::js_string;
use super::context_limits::js_number;
use super::engine_env::{CODEX, HomeOpts, PLAN_SIGN_IN_NAMES, home_for};
use super::provider_registry::{
    Engine, PROVIDERS, Provider, ProviderKind, ProviderRegistry, active_provider_id_with, check_key_slot, engine_for,
    get_provider, keys_only, keys_only_locked, normalize_provider_id,
};
use crate::app::App;
use crate::db::settings::{KeyWithSource, Settings, get_key_with_source, key_hint};
use crate::env::Env;
use crate::lib::claude_transcript::{TranscriptOpts, claude_homes as transcript_claude_homes};
use crate::lib::safe_path::join_path;
use crate::lib::vault::{is_encrypted, is_encryption_enabled};
use crate::util::js;
use crate::util::node_path::{join as node_join, to_namespaced};

/// What a provider's readiness is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderState {
    Ready,
    NeedsKey,
    NeedsSignIn,
    SignInExpired,
    OutOfCredit,
    BlockedKeysOnly,
    NeedsSetup,
    Error,
}

impl ProviderState {
    /// The state as the JS spelled it ("needs-key", ...): it reaches the UI.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderState::Ready => "ready",
            ProviderState::NeedsKey => "needs-key",
            ProviderState::NeedsSignIn => "needs-sign-in",
            ProviderState::SignInExpired => "sign-in-expired",
            ProviderState::OutOfCredit => "out-of-credit",
            ProviderState::BlockedKeysOnly => "blocked-keys-only",
            ProviderState::NeedsSetup => "needs-setup",
            ProviderState::Error => "error",
        }
    }
}

impl std::fmt::Display for ProviderState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub const PROVIDER_STATES: [ProviderState; 8] = [
    ProviderState::Ready,
    ProviderState::NeedsKey,
    ProviderState::NeedsSignIn,
    ProviderState::SignInExpired,
    ProviderState::OutOfCredit,
    ProviderState::BlockedKeysOnly,
    ProviderState::NeedsSetup,
    ProviderState::Error,
];

/// How long a balance read from OpenRouter or DeepSeek is trusted before it is read again.
pub const BALANCE_TTL_MS: i64 = 10 * 60 * 1000;

/// The providers whose balance Tarsee reads (OpenRouter's key limit, DeepSeek's prepaid balance).
pub const BALANCE_PROVIDERS: [&str; 2] = ["openrouter", "deepseek"];

// --- Small readers -------------------------------------------------------------------------------------------------

/// `store?.get?.(key) ?? null`.
fn read_setting(store: Option<&dyn Settings>, key: &str) -> Option<Value> {
    store?.get(key).filter(|v| !v.is_null())
}

/// The text of a string that is not blank, trimmed.
fn non_empty(value: Option<&Value>) -> Option<String> {
    non_empty_text(value?.as_str()?)
}

fn non_empty_text(text: &str) -> Option<String> {
    let text = js::trim(text);
    (!text.is_empty()).then(|| text.to_string())
}

fn env_text(env: &Env, name: &str) -> Option<String> {
    non_empty_text(&env.get(name)?)
}

/// `Number(value)` for a JSON value (text as JavaScript reads a number, an array as its text).
fn js_number_of(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number(text),
        Value::Array(_) => js_number(&js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// "…a1b2": the last 4 characters, the only part of a key or token ever shown.
pub fn hint_of(secret: &str) -> Option<String> {
    key_hint(secret)
}

/// A plain http(s) URL with no user info in it, or `None` (the same rule `engine_env.rs` `host_for` applies).
pub fn plain_http_url(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(js::trim(raw)).ok()?;
    let plain = matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty);
    plain.then_some(url)
}

/// Local AI's server address as the owner set it: ai.local.baseUrl, else TARSEE_LOCAL_AI_URL. "" when neither.
pub fn local_url_for(store: Option<&dyn Settings>, env: &Env) -> String {
    non_empty(read_setting(store, "ai.local.baseUrl").as_ref())
        .or_else(|| env_text(env, "TARSEE_LOCAL_AI_URL"))
        .unwrap_or_default()
}

/// The model the owner chose for a provider: its `ai.<storageId>.model` setting, else TARSEE_AI_MODEL when
/// TARSEE_AI_PROVIDER names this provider (the Railway-only setup). `None` when neither is set.
pub fn chosen_model(id_or_alias: &str, store: Option<&dyn Settings>, env: &Env) -> Option<String> {
    let p = get_provider(id_or_alias)?;
    if let Some(own) = non_empty(read_setting(store, &format!("ai.{}.model", p.storage_id)).as_ref()) {
        return Some(own);
    }
    let named = env
        .get("TARSEE_AI_PROVIDER")
        .and_then(|name| normalize_provider_id(&name));
    if named == Some(p.id) {
        return env_text(env, "TARSEE_AI_MODEL");
    }
    None
}

/// The ChatGPT plan's sign-in folder: `<state_dir>/.codex-home` (CODEX_HOME on Railway points at the same place).
/// The JS defaulted the folder to `config.STATE_DIR`: pass `app.config().state_dir`.
pub fn codex_home_for(state_dir: &Path) -> PathBuf {
    let opts = HomeOpts {
        state_dir: Some(state_dir.to_path_buf()),
        home_dir: None,
    };
    // (No state folder named is a caller's mistake the JS threw for; the folder's own name is the answer here.)
    home_for("chatgpt", CODEX, &Env::new(), &opts).unwrap_or_else(|_| node_join(state_dir, ".codex-home"))
}

/// Whether the Claude plan is signed in, and how.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSignIn {
    pub signed_in: bool,
    /// "env:NAME" for a Railway sign-in variable, "sign-in" for a .credentials.json.
    pub source: Option<String>,
    /// The last 4 characters of a sign-in variable's value.
    pub hint: Option<String>,
    /// The Claude home the .credentials.json is in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<PathBuf>,
}

/// Where [`claude_sign_in`] looks. Everything left out takes the app's own.
#[derive(Clone, Copy, Default)]
pub struct SignInOpts<'a> {
    pub env: Option<&'a Env>,
    /// The Claude homes to look in (default: CLAUDE_CODE_HOME, else the plan's candidates).
    pub claude_homes: Option<&'a (dyn Fn() -> Vec<PathBuf> + Sync)>,
    /// `fs.existsSync` (default: the real one).
    pub exists: Option<&'a (dyn Fn(&Path) -> bool + Sync)>,
}

/// `fs.existsSync`, on the name as written (a home may come from an environment variable).
fn really_exists(path: &Path) -> bool {
    to_namespaced(path).exists()
}

/// Where the Claude plan's `claude auth login` may have left its .credentials.json (the same candidates the audit
/// used).
fn default_claude_homes(app: &App, env: &Env) -> Vec<PathBuf> {
    match env.get("CLAUDE_CODE_HOME").filter(|home| !home.is_empty()) {
        Some(home) => vec![PathBuf::from(home)],
        None => transcript_claude_homes(app, &TranscriptOpts::default()),
    }
}

/// The Claude plan's sign-in: a Railway sign-in variable ([`PLAN_SIGN_IN_NAMES`]), else a .credentials.json.
pub fn claude_sign_in(app: &App, opts: &SignInOpts<'_>) -> ClaudeSignIn {
    let env = opts.env.unwrap_or(app.env());
    for name in ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"] {
        if !PLAN_SIGN_IN_NAMES.contains(&name) {
            continue;
        }
        if let Some(value) = env_text(env, name) {
            return ClaudeSignIn {
                signed_in: true,
                source: Some(format!("env:{name}")),
                hint: hint_of(&value),
                home: None,
            };
        }
    }
    let homes = match opts.claude_homes {
        Some(own) => own(),
        None => default_claude_homes(app, env),
    };
    let exists = opts.exists.unwrap_or(&really_exists);
    for home in homes {
        if !home.as_os_str().is_empty() && exists(&join_path(&home, ".credentials.json")) {
            return ClaudeSignIn {
                signed_in: true,
                source: Some("sign-in".to_string()),
                hint: None,
                home: Some(home),
            };
        }
    }
    ClaudeSignIn {
        signed_in: false,
        source: None,
        hint: None,
        home: None,
    }
}

/// A setting's row as it is stored (read raw, without decrypting it): its text, or `None` when there is no row.
fn stored_row(app: &App, key: &str) -> Option<String> {
    use rusqlite::types::Value as Sql;
    let row = app.db().with(|conn| {
        conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |row| {
            row.get::<_, Sql>(0)
        })
    });
    Some(match row.ok()? {
        Sql::Null => String::new(),
        Sql::Text(text) => text,
        Sql::Integer(n) => n.to_string(),
        Sql::Real(n) => js::number_to_string(n),
        Sql::Blob(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Whether the stored copy of a setting is encrypted at rest (read raw, without decrypting it).
fn stored_encrypted(app: &App, key: &str) -> bool {
    match stored_row(app, key) {
        Some(value) => is_encrypted(&value),
        // A store without a row for it (a test's own store).
        None => is_encryption_enabled(app),
    }
}

/// The key providers with a key saved in Settings (not a Railway variable), found without decrypting any: by the
/// stored row itself, and for a store that keeps nothing in the app's database (a test's own), by what it holds.
pub fn saved_key_providers(app: &App, store: Option<&dyn Settings>) -> Vec<&'static str> {
    let mut out = Vec::new();
    for p in PROVIDERS.iter() {
        if p.kind == ProviderKind::Subscription {
            continue;
        }
        let slot = format!("ai.{}.apiKey", p.storage_id);
        let present = match stored_row(app, &slot) {
            Some(value) => !js::trim(&value).is_empty(),
            None => read_setting(store, &slot).is_some_and(|value| !js::trim(&js_string(&value)).is_empty()),
        };
        if present {
            out.push(p.id);
        }
    }
    out
}

/// Plain words for where a credential came from. `encrypted`: whether a saved key is encrypted at rest (the JS
/// default was true); `provider`: whose sign-in it is.
pub fn key_source_text(source: Option<&str>, encrypted: bool, provider: Option<&str>) -> Option<String> {
    let source = source.filter(|s| !s.is_empty())?;
    Some(if source == "settings" {
        if encrypted {
            "Saved in Tarsee (encrypted)".to_string()
        } else {
            "Saved in Tarsee (not encrypted: set ENCRYPTION_KEY)".to_string()
        }
    } else if let Some(name) = source.strip_prefix("env:") {
        format!("Railway variable {name}")
    } else if source == "sign-in" {
        if provider == Some("chatgpt") {
            "Signed in with ChatGPT".to_string()
        } else {
            "Signed in with claude auth login".to_string()
        }
    } else {
        source.to_string()
    })
}

// --- Failure flags and balances ------------------------------------------------------------------------------------

/// The setting keys a provider's failure flag may be under (its public id, and the Claude plan's storage id).
fn flag_keys(p: &Provider) -> Vec<String> {
    let mut keys = vec![format!("ai.{}.status", p.id)];
    if p.storage_id != p.id {
        keys.push(format!("ai.{}.status", p.storage_id));
    }
    keys
}

/// The engines' failure flag for a provider: `{state, at, detail}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FailureFlag {
    pub state: String,
    /// When it was written, as it was written (an ISO moment); `None` when the flag says none.
    pub at: Option<Value>,
    pub detail: Option<Value>,
}

impl FailureFlag {
    /// `String(flag.at || "")`: what two flags are ordered by.
    fn at_text(&self) -> String {
        match &self.at {
            Some(at) if js::truthy(at) => js_string(at),
            _ => String::new(),
        }
    }
}

/// The engines' failure flag for a provider (`{state, at, detail}`), or `None`.
pub fn failure_flag(store: Option<&dyn Settings>, id_or_alias: &str) -> Option<FailureFlag> {
    let p = get_provider(id_or_alias)?;
    let mut newest: Option<FailureFlag> = None;
    for key in flag_keys(p) {
        let stored = read_setting(store, &key);
        let value = match stored {
            Some(Value::String(text)) => serde_json::from_str(&text).unwrap_or_else(|_| json!({ "state": text })),
            Some(other) => other,
            None => continue,
        };
        let Some(state) = value.get("state").and_then(Value::as_str) else {
            continue;
        };
        let flag = FailureFlag {
            state: state.to_string(),
            at: value.get("at").cloned(),
            detail: value.get("detail").cloned(),
        };
        if newest.as_ref().is_none_or(|n| flag.at_text() > n.at_text()) {
            newest = Some(flag);
        }
    }
    newest
}

/// Clear a provider's failure flag (a new key, a passing Test, a fresh sign-in).
pub fn clear_failure_flag(store: Option<&dyn Settings>, id_or_alias: &str) {
    let (Some(store), Some(p)) = (store, get_provider(id_or_alias)) else {
        return;
    };
    for key in flag_keys(p) {
        store.delete(&key);
    }
}

/// Write a provider's failure flag (a Test that the provider turned down).
pub fn set_failure_flag(
    store: &dyn Settings,
    id_or_alias: &str,
    state: &str,
    detail: Option<&str>,
) -> anyhow::Result<()> {
    let Some(p) = get_provider(id_or_alias) else {
        return Ok(());
    };
    store.set(
        &format!("ai.{}.status", p.id),
        json!({ "state": state, "at": js::now_iso(), "detail": detail }),
    )
}

/// A provider's cached balance, or `None` when there is none, it is older than [`BALANCE_TTL_MS`], or it was read
/// for another key (keyHint differs). `now`: milliseconds since 1970 (the JS default was the clock's).
/// `key_hint`: `None` takes a balance read with any key; `Some(hint)` only one read with that hint (`Some(None)`: one
/// saved with no hint at all).
pub fn cached_balance(
    store: Option<&dyn Settings>,
    id_or_alias: &str,
    now: i64,
    key_hint: Option<Option<&str>>,
) -> Option<Value> {
    let p = get_provider(id_or_alias)?;
    let value = match read_setting(store, &format!("cache.{}.balance", p.id))? {
        Value::String(text) => serde_json::from_str::<Value>(&text).ok()?,
        other => other,
    };
    if !(value.is_object() || value.is_array()) {
        return None;
    }
    let at = value.get("at").map_or(f64::NAN, js_number_of);
    let now = now as f64;
    let ttl = BALANCE_TTL_MS as f64;
    if !at.is_finite() || now - at > ttl || at - now > ttl {
        return None;
    }
    if let Some(wanted) = key_hint {
        let same = match (value.get("keyHint"), wanted) {
            (Some(Value::Null), None) => true,
            (Some(Value::String(held)), Some(wanted)) => held == wanted,
            _ => false,
        };
        if !same {
            return None;
        }
    }
    Some(value)
}

/// Cache a balance for [`BALANCE_TTL_MS`], tied to the key it was read with (by its last 4 characters). `now`:
/// milliseconds since 1970.
pub fn save_balance(
    store: &dyn Settings,
    id_or_alias: &str,
    balance: &Value,
    now: i64,
    key_hint: Option<&str>,
) -> anyhow::Result<()> {
    let Some(p) = get_provider(id_or_alias) else {
        return Ok(());
    };
    if !js::truthy(balance) {
        return Ok(());
    }
    let mut saved: Map<String, Value> = balance.as_object().cloned().unwrap_or_default();
    saved.insert("at".to_string(), json!(now));
    saved.insert("keyHint".to_string(), json!(key_hint));
    store.set(&format!("cache.{}.balance", p.id), Value::Object(saved))
}

/// Forget a provider's cached balance (its key changed).
pub fn clear_balance(store: Option<&dyn Settings>, id_or_alias: &str) {
    if let (Some(store), Some(p)) = (store, get_provider(id_or_alias)) {
        store.delete(&format!("cache.{}.balance", p.id));
    }
}

// --- Status --------------------------------------------------------------------------------------------------------

/// A provider's readiness: `{ id, label, kind, state, ready, detail, fix, keySource, keyHint, keySourceText, account,
/// balance }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    /// `None` for a provider Tarsee doesn't know.
    pub kind: Option<ProviderKind>,
    pub state: ProviderState,
    pub ready: bool,
    pub detail: String,
    pub fix: Option<String>,
    /// "settings", "env:NAME" or "sign-in".
    pub key_source: Option<String>,
    pub key_hint: Option<String>,
    pub key_source_text: Option<String>,
    pub account: Option<String>,
    /// The cached balance, as the probe saved it.
    pub balance: Option<Value>,
}

/// Where a credential came from and its last 4 characters: never the credential.
#[derive(Clone, Default)]
struct SafeCred {
    source: Option<String>,
    hint: Option<String>,
}

struct Extra {
    fix: Option<String>,
    cred: SafeCred,
    account: Option<String>,
    encrypted: bool,
}

impl Default for Extra {
    fn default() -> Self {
        Extra {
            fix: None,
            cred: SafeCred::default(),
            account: None,
            encrypted: true,
        }
    }
}

fn result(p: &Provider, state: ProviderState, detail: impl Into<String>, extra: Extra) -> ProviderStatus {
    ProviderStatus {
        id: p.id.to_string(),
        label: p.label.to_string(),
        kind: Some(p.kind),
        state,
        ready: state == ProviderState::Ready,
        detail: detail.into(),
        fix: extra.fix,
        key_source_text: key_source_text(extra.cred.source.as_deref(), extra.encrypted, Some(p.id)),
        key_source: extra.cred.source,
        key_hint: extra.cred.hint,
        account: extra.account,
        balance: None,
    }
}

fn unknown_provider(id_or_alias: &str) -> ProviderStatus {
    ProviderStatus {
        id: id_or_alias.to_string(),
        label: id_or_alias.to_string(),
        kind: None,
        state: ProviderState::Error,
        ready: false,
        detail: format!("Tarsee doesn't know an AI called \"{id_or_alias}\"."),
        fix: None,
        key_source: None,
        key_hint: None,
        key_source_text: None,
        account: None,
        balance: None,
    }
}

/// Where to put a key right: the card, or the Railway variable it came from.
fn key_fix(cred: &KeyWithSource) -> String {
    match cred.source.as_deref().and_then(|s| s.strip_prefix("env:")) {
        Some(name) => {
            format!("Fix the Railway variable {name}, or paste a key in Settings > AI (a saved key is used first).")
        }
        None => "Replace it in Settings > AI.".to_string(),
    }
}

fn without_https(url: &str) -> &str {
    url.strip_prefix("https://").unwrap_or(url)
}

/// `{detail, fix}` for a key provider with no key.
fn needs_key(p: &Provider) -> (String, String) {
    // (Every key provider has both names; "undefined" is what the JS would have printed for one without.)
    let noun = p.key_noun.unwrap_or("undefined");
    let get = p
        .key_help_url
        .map(|url| format!(" Get one at {}.", without_https(url)))
        .unwrap_or_default();
    (
        format!("{} needs {noun}.", p.label),
        format!(
            "Paste {noun} in Settings > AI, or set the Railway variable {}.{get}",
            p.env_key.unwrap_or("undefined")
        ),
    )
}

fn blocked_keys_only(p: &Provider, env: &Env) -> ProviderStatus {
    let fix = if keys_only_locked(env) {
        "The Railway variable TARSEE_KEYS_ONLY=1 keeps API keys only on. Remove it to use a plan sign-in again."
    } else {
        "Turn off \"API keys only\" in Settings > AI to use it."
    };
    result(
        p,
        ProviderState::BlockedKeysOnly,
        format!("\"API keys only\" is on, so the {} isn't used.", p.label),
        Extra {
            fix: Some(fix.to_string()),
            ..Extra::default()
        },
    )
}

fn sign_in_fix(p: &Provider) -> String {
    if p.id == "claude" {
        return "Run claude auth login in the Terminal, then click Check. Or set CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) as a Railway variable.".to_string();
    }
    "Sign in with ChatGPT in Settings > AI (you get a one-time code to enter at auth.openai.com), or run codex login --device-auth in the Terminal.".to_string()
}

/// A state that takes the place of "ready": `{state, detail, fix}`.
struct Instead {
    state: ProviderState,
    detail: String,
    fix: String,
}

/// The failure flag as a state, or `None` when it doesn't apply.
fn flag_state(p: &Provider, flag: Option<&FailureFlag>) -> Option<Instead> {
    let flag = flag?;
    let s = flag.state.to_lowercase();
    let hints = &p.error_hints;
    let said = |hint: Option<&'static str>| hint.filter(|h| !h.is_empty()).map(str::to_string);
    if ["auth", "auth-expired", "sign-in-expired", "expired"].contains(&s.as_str()) {
        if p.kind == ProviderKind::Subscription {
            return Some(Instead {
                state: ProviderState::SignInExpired,
                detail: said(hints.auth).unwrap_or_else(|| format!("The {} sign-in has expired.", p.label)),
                fix: sign_in_fix(p),
            });
        }
        return Some(Instead {
            state: ProviderState::Error,
            detail: said(hints.auth).unwrap_or_else(|| format!("Your {} key was rejected.", p.label)),
            fix: "Replace the key in Settings > AI (or its Railway variable), then press Test.".to_string(),
        });
    }
    if ["billing", "out-of-credit"].contains(&s.as_str()) {
        let place = match hints.top_up_url.filter(|url| !url.is_empty()) {
            Some(url) => format!(" at {}", without_https(url)),
            None => " with the provider".to_string(),
        };
        return Some(Instead {
            state: ProviderState::OutOfCredit,
            detail: said(hints.billing).unwrap_or_else(|| format!("{} has run out of credit.", p.label)),
            fix: format!("Add credit{place}, then press Test."),
        });
    }
    if s == "error" {
        // (The plans' cards have a Check button; the key cards a Test button.)
        let button = if p.kind == ProviderKind::Subscription {
            "Click Check"
        } else {
            "Press Test"
        };
        return Some(Instead {
            state: ProviderState::Error,
            detail: non_empty(flag.detail.as_ref())
                .unwrap_or_else(|| format!("{} reported an error on its last turn.", p.label)),
            fix: format!("{button} in Settings > AI to check it again."),
        });
    }
    None
}

fn balance_out_of_credit(p: &Provider, balance: &Value) -> Option<Instead> {
    if !balance.get("empty").is_some_and(js::truthy) {
        return None;
    }
    if p.id == "openrouter" {
        return Some(Instead {
            state: ProviderState::OutOfCredit,
            detail: "Your OpenRouter key has used up its spending limit.".to_string(),
            fix:
                "Raise the key's limit at openrouter.ai/settings/keys, or add credit at openrouter.ai/settings/credits."
                    .to_string(),
        });
    }
    Some(Instead {
        state: ProviderState::OutOfCredit,
        detail: format!("Your {} balance is empty.", p.label),
        fix: p
            .error_hints
            .billing
            .filter(|hint| !hint.is_empty())
            .unwrap_or("Add credit.")
            .to_string(),
    })
}

/// The plan's name with its first letter a capital (`plan.replace(/^./, (c) => c.toUpperCase())`).
fn capitalised(plan: &str) -> String {
    let mut chars = plan.chars();
    match chars.next() {
        // One UTF-16 unit is what the JS changed: a character outside the basic plane stays as it is.
        Some(first) if first.len_utf16() == 1 && !matches!(first, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
            first.to_uppercase().chain(chars).collect()
        }
        _ => plan.to_string(),
    }
}

fn plan_account(login: &Login) -> Option<String> {
    let plan = login.plan.as_deref().map(capitalised);
    match (login.email.as_deref(), plan) {
        (None, None) => None,
        (Some(email), Some(plan)) => Some(format!("{email} ({plan})")),
        (Some(email), None) => Some(email.to_string()),
        (None, Some(plan)) => Some(format!("{plan} plan")),
    }
}

/// A sign-in check's answer, as the status reads it.
#[derive(Debug, Default, PartialEq, Eq)]
struct Login {
    signed_in: bool,
    expired: bool,
    /// "api" or "other" when the home holds a sign-in that is not a ChatGPT one.
    other_login: Option<&'static str>,
    email: Option<String>,
    plan: Option<String>,
}

/// The first of these members that is there and not null (`r.a ?? r.b ?? ...`).
fn first_set<'a>(r: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().filter_map(|name| r.get(name)).find(|v| !v.is_null())
}

/// `codex_device_login`'s `login_status` answer (`{signedIn, method: "chatgpt" | "api" | "other" | null, email?,
/// plan?}`) as `{signedIn, expired, email, plan, otherLogin}`. Only a ChatGPT sign-in counts: an API-key login (or
/// any other kind) in the ChatGPT home is not one.
fn normalize_login(r: &Value) -> Login {
    if !(r.is_object() || r.is_array()) {
        return Login::default();
    }
    let method = first_set(r, &["method", "authMode", "auth_mode", "mode"])
        .map(js_string)
        .filter(|m| !m.is_empty())
        .map(|m| m.to_lowercase());
    let other_login = match method.as_deref() {
        None | Some("chatgpt") => None,
        Some("api" | "apikey" | "api_key") => Some("api"),
        Some(_) => Some("other"),
    };
    let state = r
        .get("state")
        .filter(|s| js::truthy(s))
        .map(js_string)
        .unwrap_or_default();
    let expired = r.get("expired") == Some(&Value::Bool(true))
        || matches!(state.to_lowercase().as_str(), "sign-in-expired" | "expired");
    let signed_in =
        first_set(r, &["signedIn", "loggedIn", "ok", "ready"]).is_some_and(js::truthy) && other_login.is_none();
    let account = r.get("account");
    let email = first_set(r, &["email"]).or_else(|| account.and_then(|a| a.get("email")));
    let plan = first_set(r, &["plan", "planType", "plan_type"]).or_else(|| account.and_then(|a| a.get("plan")));
    Login {
        signed_in,
        expired,
        other_login,
        email: non_empty(email),
        plan: non_empty(plan),
    }
}

/// What a sign-in check is asked: the ChatGPT home, and whether codex itself should confirm it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginCheck {
    pub codex_home: PathBuf,
    /// False reads the sign-in file alone, starting nothing.
    pub cli: bool,
}

/// The sign-in check a caller may put in place of `codex_device_login::login_status` (the JS `deps.loginStatus`):
/// it answers with the status as JSON (`{signedIn, method, email?, plan?}`, read leniently), or fails.
pub type LoginStatusFn = dyn Fn(LoginCheck) -> BoxFuture<'static, anyhow::Result<Value>> + Send + Sync;

/// What the status functions read from (the JS `deps`). Everything left out takes the app's own.
#[derive(Clone, Copy, Default)]
pub struct StatusDeps<'a> {
    /// The settings store; with none, no key is saved and no flag is set.
    pub store: Option<&'a dyn Settings>,
    /// The environment the sign-in variables, "API keys only", Local AI's address and the Railway-only model are
    /// read from; default the app's. (A key's own Railway variable is always read from the app's.)
    pub env: Option<&'a Env>,
    /// Default `config.state_dir`.
    pub state_dir: Option<&'a Path>,
    pub claude_homes: Option<&'a (dyn Fn() -> Vec<PathBuf> + Sync)>,
    pub exists: Option<&'a (dyn Fn(&Path) -> bool + Sync)>,
    /// The ChatGPT plan's home; default `<state_dir>/.codex-home`.
    pub codex_home: Option<&'a Path>,
    /// Default `codex_device_login::login_status`.
    pub login_status: Option<&'a LoginStatusFn>,
    /// Has Codex itself confirm the ChatGPT sign-in instead of reading its file (the Test button).
    pub login_cli: bool,
    /// The moment, in milliseconds since 1970; default now.
    pub now: Option<i64>,
    /// Leaves the engines' failure flag out (the Test button asks "is the sign-in there now?").
    pub ignore_flags: bool,
    /// Which providers count as switched on, for the default provider; default the app's registry.
    pub is_shipped: Option<&'a (dyn Fn(&str) -> bool + Sync)>,
}

impl<'a> StatusDeps<'a> {
    fn env_of(&self, app: &'a App) -> &'a Env {
        self.env.unwrap_or(app.env())
    }

    fn codex_home_of(&self, app: &App) -> PathBuf {
        match self.codex_home.filter(|home| !home.as_os_str().is_empty()) {
            Some(home) => home.to_path_buf(),
            None => codex_home_for(self.state_dir.unwrap_or(&app.config().state_dir)),
        }
    }
}

/// The parts of a provider's status that need nothing but Settings, the environment and the files on disk: key
/// presence and slot, the Claude sign-in, ChatGPT's auth.json being there, Local AI's address and model, keys-only.
/// Synchronous, for the security audit; [`provider_status`] builds on it.
/// deps: `{ store, env, state_dir, claude_homes, exists, codex_home }`
pub fn credential_presence(app: &App, id_or_alias: &str, deps: &StatusDeps<'_>) -> ProviderStatus {
    let Some(p) = get_provider(id_or_alias) else {
        return unknown_provider(id_or_alias);
    };
    let store = deps.store;
    let env = deps.env_of(app);
    let exists = deps.exists.unwrap_or(&really_exists);

    if p.kind == ProviderKind::Subscription && keys_only(store, env) {
        return blocked_keys_only(p, env);
    }

    if p.id == "claude" {
        let cred = claude_sign_in(
            app,
            &SignInOpts {
                env: Some(env),
                claude_homes: deps.claude_homes,
                exists: Some(exists),
            },
        );
        let Some(source) = cred.source.filter(|_| cred.signed_in) else {
            return result(
                p,
                ProviderState::NeedsSignIn,
                "Nobody has signed in to the Claude plan yet.",
                Extra {
                    fix: Some(sign_in_fix(p)),
                    ..Extra::default()
                },
            );
        };
        let how = match source.strip_prefix("env:") {
            Some(name) => format!(" through the Railway variable {name}"),
            None => String::new(),
        };
        return result(
            p,
            ProviderState::Ready,
            format!("Signed in to your Claude plan{how}."),
            Extra {
                cred: SafeCred {
                    source: Some(source),
                    hint: cred.hint,
                },
                ..Extra::default()
            },
        );
    }

    if p.id == "chatgpt" {
        let home = deps.codex_home_of(app);
        if !exists(&node_join(&home, "auth.json")) {
            return result(
                p,
                ProviderState::NeedsSignIn,
                "Nobody has signed in to ChatGPT yet.",
                Extra {
                    fix: Some(sign_in_fix(p)),
                    ..Extra::default()
                },
            );
        }
        return result(
            p,
            ProviderState::Ready,
            "Signed in to ChatGPT.",
            Extra {
                cred: SafeCred {
                    source: Some("sign-in".to_string()),
                    hint: None,
                },
                ..Extra::default()
            },
        );
    }

    // (The key's own Railway variable is read from the server's environment, as the JS store read it.)
    let cred = store
        .map(|store| get_key_with_source(store, app.env(), p.id))
        .unwrap_or_default();
    let encrypted = if cred.source.as_deref() == Some("settings") {
        stored_encrypted(app, &format!("ai.{}.apiKey", p.storage_id))
    } else {
        true
    };
    let safe_cred = SafeCred {
        source: cred.source.clone(),
        hint: cred.hint.clone(),
    };
    let with_cred = |fix: Option<String>| Extra {
        fix,
        cred: safe_cred.clone(),
        encrypted,
        ..Extra::default()
    };

    if let Some(key) = cred.key.as_deref().filter(|key| !key.is_empty()) {
        let slot = check_key_slot(p.id, key);
        if !slot.ok {
            return result(
                p,
                ProviderState::Error,
                slot.message.unwrap_or_default(),
                with_cred(Some(key_fix(&cred))),
            );
        }
    }

    if p.id == "local" {
        let raw = local_url_for(store, env);
        if raw.is_empty() {
            return result(
                p,
                ProviderState::NeedsSetup,
                "Local AI has no server address yet.",
                with_cred(Some("Add your server's address in Settings > AI (its buttons fill in the usual ones, such as http://localhost:11434/v1), or set the Railway variable TARSEE_LOCAL_AI_URL.".to_string())),
            );
        }
        if plain_http_url(&raw).is_none() {
            return result(
                p,
                ProviderState::NeedsSetup,
                "Local AI's address must start with http:// or https:// and have no password in it.",
                with_cred(Some(
                    "Fix the address in Settings > AI (or TARSEE_LOCAL_AI_URL).".to_string(),
                )),
            );
        }
        let model = chosen_model(p.id, store, env).filter(|m| !m.is_empty()).or_else(|| {
            let listed = ProviderRegistry::of(app).models_for(p.id);
            listed.first().map(|m| m.id.clone()).filter(|id| !id.is_empty())
        });
        if model.is_none() {
            return result(
                p,
                ProviderState::NeedsSetup,
                format!("Local AI at {raw} has no model chosen yet."),
                with_cred(Some("Choose a model on the Local AI card in Settings > AI (Test lists what your server has), or set the Railway variable TARSEE_AI_MODEL to one of your server's models.".to_string())),
            );
        }
        return result(
            p,
            ProviderState::Ready,
            format!("Using your Local AI at {raw}."),
            with_cred(None),
        );
    }

    if cred.key.as_deref().is_none_or(str::is_empty) {
        let (detail, fix) = needs_key(p);
        return result(
            p,
            ProviderState::NeedsKey,
            detail,
            Extra {
                fix: Some(fix),
                cred: safe_cred.clone(),
                ..Extra::default()
            },
        );
    }
    let hint = cred.hint.as_deref().unwrap_or("null");
    let from = match cred.source.as_deref().and_then(|s| s.strip_prefix("env:")) {
        Some(name) => format!("Key from the Railway variable {name} ({hint})"),
        None => format!("Key saved in Tarsee ({hint})"),
    };
    result(p, ProviderState::Ready, format!("{from}."), with_cred(None))
}

/// A provider's full status (see the top of this file). Async: the ChatGPT plan asks Codex's own sign-in
/// (`codex_device_login::login_status`).
/// deps: `{ store, env, state_dir, claude_homes, exists, codex_home, login_status, login_cli, now, ignore_flags }`.
/// `ignore_flags` leaves the engines' failure flag out (the Test button asks "is the sign-in there now?");
/// `login_cli` has Codex itself confirm the ChatGPT sign-in instead of reading its file.
pub async fn provider_status(app: &App, id_or_alias: &str, deps: &StatusDeps<'_>) -> ProviderStatus {
    let Some(p) = get_provider(id_or_alias) else {
        return unknown_provider(id_or_alias);
    };
    let store = deps.store;
    let now = deps.now.unwrap_or_else(js::now_ms);

    let mut base = credential_presence(app, p.id, deps);
    if matches!(base.state, ProviderState::BlockedKeysOnly | ProviderState::NeedsSetup) {
        return base;
    }

    if p.id == "chatgpt" {
        // The cards, the doctor and the health check read Codex's sign-in file (cli:false, no process started); the
        // Test button passes login_cli so `codex login status` itself confirms it.
        let check = LoginCheck {
            codex_home: deps.codex_home_of(app),
            cli: deps.login_cli,
        };
        let answer = match deps.login_status {
            Some(own) => own(check).await,
            None => default_login_status(app, check).await,
        };
        let login = match answer {
            Ok(answer) => normalize_login(&answer),
            Err(err) => {
                return result(
                    p,
                    ProviderState::Error,
                    format!("Tarsee couldn't check the ChatGPT sign-in: {err}"),
                    Extra {
                        fix: Some(
                            "Try again in a moment; if it keeps failing, sign in again in Settings > AI.".to_string(),
                        ),
                        ..Extra::default()
                    },
                );
            }
        };
        if login.expired {
            let detail = p
                .error_hints
                .auth
                .filter(|hint| !hint.is_empty())
                .unwrap_or("The ChatGPT sign-in has expired.");
            return result(
                p,
                ProviderState::SignInExpired,
                detail,
                Extra {
                    fix: Some(sign_in_fix(p)),
                    ..Extra::default()
                },
            );
        }
        if !login.signed_in {
            let detail = match login.other_login {
                Some("api") => "The ChatGPT sign-in folder holds an API-key login, not a ChatGPT sign-in.",
                Some(_) => {
                    "Codex in the ChatGPT sign-in folder is signed in some other way, not with a ChatGPT account."
                }
                None => "Nobody has signed in to ChatGPT yet.",
            };
            return result(
                p,
                ProviderState::NeedsSignIn,
                detail,
                Extra {
                    fix: Some(sign_in_fix(p)),
                    ..Extra::default()
                },
            );
        }
        let account = plan_account(&login);
        let detail = match &account {
            Some(account) => format!("Signed in as {account}."),
            None => "Signed in to ChatGPT.".to_string(),
        };
        base = result(
            p,
            ProviderState::Ready,
            detail,
            Extra {
                cred: SafeCred {
                    source: Some("sign-in".to_string()),
                    hint: None,
                },
                account,
                ..Extra::default()
            },
        );
    }

    if base.state != ProviderState::Ready {
        return base;
    }

    let flagged = if deps.ignore_flags {
        None
    } else {
        flag_state(p, failure_flag(store, p.id).as_ref())
    };
    if let Some(flagged) = flagged {
        return ProviderStatus {
            state: flagged.state,
            detail: flagged.detail,
            fix: Some(flagged.fix),
            ready: false,
            ..base
        };
    }

    if BALANCE_PROVIDERS.contains(&p.id)
        && let Some(balance) = cached_balance(store, p.id, now, Some(base.key_hint.as_deref()))
    {
        if let Some(empty) = balance_out_of_credit(p, &balance) {
            return ProviderStatus {
                state: empty.state,
                detail: empty.detail,
                fix: Some(empty.fix),
                ready: false,
                balance: Some(balance),
                ..base
            };
        }
        // (A balance saved without its words reads "undefined", as the JS wrote it.)
        let text = balance.get("text").map_or_else(|| "undefined".to_string(), js_string);
        let mut detail = format!("{} {text}.", base.detail);
        if detail.ends_with("..") {
            detail.pop();
        }
        return ProviderStatus {
            detail,
            balance: Some(balance),
            ..base
        };
    }
    base
}

/// The sign-in check when the caller gives none: Codex's own (`codex_device_login::login_status`).
async fn default_login_status(app: &App, check: LoginCheck) -> anyhow::Result<Value> {
    let status = login_status(
        app,
        &LoginStatusOpts {
            codex_home: check.codex_home,
            cli: check.cli,
            ..LoginStatusOpts::default()
        },
    )
    .await?;
    Ok(serde_json::to_value(status)?)
}

// --- The default provider ------------------------------------------------------------------------------------------

/// Who chose the default provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChosenBy {
    Settings,
    Env,
    Default,
}

/// The provider a turn uses when nothing more specific is chosen: `{ provider, label, model, engine, chosenBy }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTarget {
    pub provider: &'static str,
    pub label: &'static str,
    /// `None` when the engine picks its own (the ChatGPT plan before its account list is in).
    pub model: Option<String>,
    /// `None` for an OpenRouter model that must be verified.
    pub engine: Option<Engine>,
    pub chosen_by: ChosenBy,
}

/// The provider a turn uses when nothing more specific is chosen, its model and engine, and who chose it:
/// `{ provider, label, model, engine, chosenBy: "settings" | "env" | "default" }`. model is `None` when the engine
/// picks its own (the ChatGPT plan before its account list is in); engine is `None` for an OpenRouter model that
/// must be verified. `env`: default the app's; `is_shipped`: default the app's registry.
pub fn active_target(
    app: &App,
    store: Option<&dyn Settings>,
    env: Option<&Env>,
    is_shipped: Option<&(dyn Fn(&str) -> bool + Sync)>,
) -> ActiveTarget {
    let env = env.unwrap_or(app.env());
    let registry = ProviderRegistry::of(app);
    let provider = match is_shipped {
        Some(own) => active_provider_id_with(store, env, own),
        None => registry.active_provider_id(store, env),
    };
    let label = get_provider(provider).map_or(provider, |p| p.label);
    let chosen_by = if non_empty(read_setting(store, "ai.activeProvider").as_ref()).is_some() {
        ChosenBy::Settings
    } else if env_text(env, "TARSEE_AI_PROVIDER").is_some() {
        ChosenBy::Env
    } else {
        ChosenBy::Default
    };
    let model = registry.resolve_model_for(provider, chosen_model(provider, store, env).as_deref(), store);
    let engine = engine_for(provider, model.as_deref(), store);
    ActiveTarget {
        provider,
        label,
        model,
        engine,
        chosen_by,
    }
}

/// The one boot line (design 4.5 R9), e.g.
/// `[ai] default=deepseek:deepseek-flash engine=claude-code key=env:DEEPSEEK_API_KEY (…a1b2) ready`.
/// When the default isn't ready it adds what to do; when an ANTHROPIC_API_KEY sits in the environment while the
/// Claude plan is the default it says that key is not used (the plan's turns strip it).
pub async fn ai_boot_line(app: &App, deps: &StatusDeps<'_>) -> String {
    let env = deps.env_of(app);
    let target = active_target(app, deps.store, Some(env), deps.is_shipped);
    let s = provider_status(app, target.provider, deps).await;
    let key = match (&s.key_source, &s.key_hint) {
        (Some(source), Some(hint)) if !hint.is_empty() => format!("{source} ({hint})"),
        (Some(source), _) if !source.is_empty() => source.clone(),
        _ => "none".to_string(),
    };
    let mut line = format!(
        "[ai] default={}:{} engine={} key={key} {}",
        target.provider,
        target.model.as_deref().unwrap_or("auto"),
        target.engine.map_or("needs-verification", Engine::as_str),
        s.state
    );
    if !s.ready {
        line.push_str(&format!(": {}", s.detail));
        if let Some(fix) = s.fix.as_deref().filter(|fix| !fix.is_empty()) {
            line.push_str(&format!(" {fix}"));
        }
    }
    if target.provider == "claude" && env_text(env, "ANTHROPIC_API_KEY").is_some() {
        line.push_str(" (ANTHROPIC_API_KEY is set but not used: the default AI is the Claude plan. To bill that key instead, choose \"Anthropic API key\" in Settings > AI.)");
    }
    line
}

#[cfg(test)]
mod tests;
