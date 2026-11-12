//! Port of `src/ai/codex-models.js`: the models the signed-in ChatGPT account can use, read live from Codex (design
//! amendment A2).
//!
//! Tarsee never writes a ChatGPT model into its code: what a ChatGPT account may use depends on its plan, and a Free
//! plan gets far fewer models than Codex knows about. So the picker lists only what the account's own list says, and
//! when that can't be read the caller leaves the model out and Codex uses its default.
//!
//! The documented way to ask is Codex's app-server: `codex app-server` speaks JSON-RPC over stdio, and after
//! `initialize` its `model/list` method answers with the models (paged by nextCursor). One catch, seen on the pinned
//! binary: model/list also answers when nobody is signed in, and when fetching the account's list fails, with the
//! catalog bundled in the binary (it only logs "failed to refresh available models"). That catalog isn't the
//! account's. A fetch that worked is cached by Codex in $CODEX_HOME/models_cache.json, keyed to the account, so an
//! answer counts as the account's only when:
//!
//! - account/read says the home is signed in with ChatGPT,
//! - no fetch failure was logged (RUST_LOG is set to "error" for this, whatever the server's says), and
//! - models_cache.json lists every model in the answer.
//!
//! Anything else gives no models (with a reason from [`read_account_models`]), never a guess.
//!
//! - [`list_account_models`]: `[{id, label, efforts, default?, defaultEffort?, vision, description?}]`
//! - [`read_account_models`]: `{models, source:'account'|null, reason?, account?:{email?, plan?}}`
//! - [`sync_chatgpt_catalog`]: [`read_account_models`]' answer, after putting its models in the registry's
//!   "chatgpt-models" catalog (emptied when there are none)
//!
//! codex runs with the server's environment minus every credential, in the sign-in home, after the home's
//! config.toml passes `codex_config_guard` (the app-server sends the account's token to its backend, so a planted
//! chatgpt_base_url must never get it). An answer is kept for five minutes per sign-in (a new auth.json asks again);
//! failures are never kept; callers asking at the same time share one app-server.
//!
//! The kept answers and the questions in flight are state of the app ([`AccountModels`]), where the JS kept two
//! module-level maps. A question runs in a task of its own, so it ends (and its codex is stopped) whether or not the
//! caller that asked is still there.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch};

use super::codex_cli::{
    CODEX_BASE_ARGS, SpawnOpts, auth_fingerprint, codex_child_env, collect_text, kill_tree, require_codex_home,
    resolve_codex_bin, spawn_codex, strip_ansi,
};
use super::codex_device_login::{clean_email_text, clean_plan_text};
use super::engine_env::js_json::{Json, parse_document};
use super::engine_env::{EnvMap, TypeError, codex_config_files_for, codex_config_guard, read_text};
use super::provider_registry::ProviderRegistry;
use crate::app::App;
use crate::env::Env;
use crate::lib::run_cmd::spawn_error_code;
use crate::util::js;

const DEFAULT_MAX_AGE_MS: u64 = 5 * 60_000;
const MAX_PAGES: usize = 20;

/// The version Tarsee names itself with to the app-server (the JS read it from package.json).
const VERSION: &str = env!("CARGO_PKG_VERSION");

// --- Mapping --------------------------------------------------------------------------------------------------------

/// `/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/`
static ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$").expect("the model-id pattern"));

/// `/^[a-z][a-z0-9_-]{0,23}$/i`
static EFFORT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?i-u:[a-z][a-z0-9_-]{0,23})$").expect("the effort pattern"));

fn is_false(b: &bool) -> bool {
    !*b
}

/// One model the account can use, as Tarsee lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountModel {
    /// The model to pass to Codex.
    pub id: String,
    pub label: String,
    /// The reasoning levels it takes, in Codex's words.
    pub efforts: Vec<String>,
    /// True for the one Codex picks (left out otherwise).
    #[serde(skip_serializing_if = "is_false")]
    pub default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    pub vision: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `String(value)` for a truthy JSON value (an array is its members joined by commas).
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// The text of a string that is not blank, trimmed (`typeof v === "string" && v.trim() ? v.trim() : undefined`).
fn trimmed_text(value: Option<&Value>) -> Option<String> {
    let text = js::trim(value?.as_str()?);
    (!text.is_empty()).then(|| text.to_string())
}

/// The app-server's model entries as Tarsee's: `{id (the model to pass to Codex), label, efforts (the reasoning
/// levels it takes, in Codex's words), default? (true for the one Codex picks), defaultEffort?, vision,
/// description?}`. Hidden entries, duplicates and entries without a usable id are left out.
pub fn map_model_list(data: &Value) -> Vec<AccountModel> {
    let mut out: Vec<AccountModel> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for m in data.as_array().map(Vec::as_slice).unwrap_or_default() {
        if !m.is_object() || m.get("hidden") == Some(&Value::Bool(true)) {
            continue;
        }
        let named = ["model", "id"]
            .into_iter()
            .filter_map(|name| m.get(name))
            .find(|v| js::truthy(v));
        let id = named.map(js_string).unwrap_or_default();
        let id = js::trim(&id);
        if !ID_RE.is_match(id) || !seen.insert(id.to_string()) {
            continue;
        }
        let mut efforts: Vec<String> = Vec::new();
        let supported = m.get("supportedReasoningEfforts").and_then(Value::as_array);
        for e in supported.map(Vec::as_slice).unwrap_or_default() {
            let level = match e {
                Value::String(text) => Some(text.as_str()),
                other => other.get("reasoningEffort").and_then(Value::as_str),
            };
            if let Some(level) = level.filter(|l| EFFORT_RE.is_match(l))
                && !efforts.iter().any(|known| known == level)
            {
                efforts.push(level.to_string());
            }
        }
        let vision = match m.get("inputModalities").and_then(Value::as_array) {
            Some(modalities) => modalities.iter().any(|kind| kind == "image"),
            None => true,
        };
        out.push(AccountModel {
            id: id.to_string(),
            label: trimmed_text(m.get("displayName")).unwrap_or_else(|| id.to_string()),
            efforts,
            default: m.get("isDefault") == Some(&Value::Bool(true)),
            default_effort: m
                .get("defaultReasoningEffort")
                .and_then(Value::as_str)
                .filter(|level| EFFORT_RE.is_match(level))
                .map(str::to_string),
            vision,
            description: trimmed_text(m.get("description")),
        });
    }
    out
}

/// The model ids in Codex's models_cache.json, or `None` when there is no readable cache. Read as `JSON.parse` read
/// it: whether an answer counts as the account's own hangs on it.
fn cached_model_ids(home: &Path) -> Option<HashSet<String>> {
    let text = read_text(&home.join("models_cache.json")).ok()?;
    let json = parse_document(text.strip_prefix('\u{FEFF}').unwrap_or(&text))?;
    let models = json.get("models")?.as_array()?;
    let ids: HashSet<String> = models
        .iter()
        .flat_map(|m| ["slug", "id", "model"].into_iter().filter_map(|name| m.get(name)))
        .filter_map(Json::as_text)
        .filter(|id| !id.is_empty())
        .collect();
    (!ids.is_empty()).then_some(ids)
}

/// Whose list it is, as far as it is worth showing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct AccountInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

fn account_info(account: &Value) -> AccountInfo {
    let text = |name: &str| account.get(name).and_then(Value::as_str);
    AccountInfo {
        email: text("email").and_then(clean_email_text),
        plan: text("planType").and_then(clean_plan_text),
    }
}

// --- JSON-RPC over the app-server's stdio ----------------------------------------------------------------------------

/// A request that got no result: the server's own error, or the app-server gone.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RpcError {
    message: String,
}

type Pending = Arc<Mutex<PendingState>>;

#[derive(Default)]
struct PendingState {
    waiting: HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>,
    /// Why no more answers will come, once that is so.
    closed_with: Option<RpcError>,
}

/// What goes to the app-server's stdin.
enum Outgoing {
    Line(String),
    /// Close stdin (the JS `child.stdin.end()`): the app-server then finishes on its own.
    End,
}

struct RpcClient {
    next_id: u64,
    pending: Pending,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    /// Ends when the app-server's stdout has ended.
    reader: tokio::task::JoinHandle<()>,
}

impl RpcClient {
    fn new(stdin: Option<ChildStdin>, stdout: Option<ChildStdout>) -> RpcClient {
        let pending: Pending = Arc::default();
        let (outgoing, mut lines_out) = mpsc::unbounded_channel::<Outgoing>();
        // The writer: one line at a time, until stdin is to be closed (or the app-server has gone).
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(message) = lines_out.recv().await {
                match (message, stdin.as_mut()) {
                    (Outgoing::Line(line), Some(pipe)) => {
                        if pipe.write_all(line.as_bytes()).await.is_err() || pipe.flush().await.is_err() {
                            stdin = None;
                        }
                    }
                    (Outgoing::End, _) => stdin = None,
                    (Outgoing::Line(_), None) => {}
                }
            }
        });
        // The reader: every line the app-server prints, for as long as it prints.
        let reader = {
            let (pending, outgoing) = (pending.clone(), outgoing.clone());
            tokio::spawn(async move {
                if let Some(stdout) = stdout {
                    let mut stdout = BufReader::new(stdout);
                    let mut line = Vec::new();
                    loop {
                        line.clear();
                        match stdout.read_until(b'\n', &mut line).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => on_line(&String::from_utf8_lossy(&line), &pending, &outgoing),
                        }
                    }
                }
                let gone = RpcError {
                    message: "codex app-server exited".to_string(),
                };
                let mut state = pending.lock();
                state.closed_with = Some(gone.clone());
                for (_, waiter) in state.waiting.drain() {
                    let _ = waiter.send(Err(gone.clone()));
                }
            })
        };
        RpcClient {
            next_id: 1,
            pending,
            outgoing,
            reader,
        }
    }

    fn write(&self, message: &Value) {
        let _ = self.outgoing.send(Outgoing::Line(format!("{message}\n")));
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        let (answer, answered) = oneshot::channel();
        let id = self.next_id;
        {
            let mut state = self.pending.lock();
            if let Some(gone) = &state.closed_with {
                return Err(gone.clone());
            }
            state.waiting.insert(id, answer);
        }
        self.next_id += 1;
        self.write(&json!({ "id": id, "method": method, "params": params }));
        answered.await.unwrap_or_else(|_| {
            Err(RpcError {
                message: "codex app-server exited".to_string(),
            })
        })
    }

    fn notify(&self, method: &str) {
        self.write(&json!({ "method": method }));
    }

    /// Closes the app-server's stdin, so it finishes on its own.
    fn end_input(&self) {
        let _ = self.outgoing.send(Outgoing::End);
    }
}

/// One line from the app-server: an answer to a request of ours, a request of its own (refused: nothing here asks
/// for one), or something to pass over (a notification, an answer nobody waits for, a line that is not JSON).
fn on_line(line: &str, pending: &Pending, outgoing: &mpsc::UnboundedSender<Outgoing>) {
    let Ok(m) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let Some(m) = m.as_object() else { return };
    let id = m.get("id");
    if m.get("method").is_some_and(Value::is_string)
        && let Some(id) = id
    {
        // A request from the server (an approval, say): nothing here asks for one, so refuse it.
        let refusal = json!({ "id": id, "error": { "code": -32601, "message": "Tarsee's model check doesn't handle this request." } });
        let _ = outgoing.send(Outgoing::Line(format!("{refusal}\n")));
        return;
    }
    // Our ids are whole numbers: an answer is ours when its id is that number (as a number, not as text).
    let Some(id) = id.and_then(Value::as_f64).filter(|id| *id >= 1.0 && id.fract() == 0.0) else {
        return;
    };
    let Some(waiter) = pending.lock().waiting.remove(&(id as u64)) else {
        return;
    };
    let answer = match m.get("error").filter(|error| js::truthy(error)) {
        Some(error) => Err(RpcError {
            message: match error.get("message") {
                None | Some(Value::Null) => "app-server error".to_string(),
                Some(message) => js_string(message),
            },
        }),
        None => Ok(m.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = waiter.send(answer);
}

/// `/refresh|sign in|signed out|log ?in|log out|expired|unauthori[sz]ed|\b401\b/i`
static SIGN_IN_GONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:refresh|sign in|signed out|log ?in|log out|expired|unauthori[sz]ed|\b401\b)")
        .expect("the sign-in-gone pattern")
});

/// What the conversation with the app-server came to.
enum Talk {
    /// The account and every model listed for it.
    Listed {
        data: Vec<Value>,
        account: Value,
    },
    Reason(ModelsReason),
}

/// initialize, then account/read, then every page of model/list.
async fn converse(rpc: &mut RpcClient) -> Result<Talk, RpcError> {
    let client = json!({ "clientInfo": { "name": "tarsee", "title": "Tarsee", "version": VERSION } });
    rpc.request("initialize", client).await?;
    rpc.notify("initialized");
    let account = match rpc.request("account/read", json!({ "refreshToken": false })).await {
        Ok(answer) => answer.get("account").cloned().unwrap_or(Value::Null),
        Err(err) => {
            return Ok(Talk::Reason(if SIGN_IN_GONE.is_match(&err.message) {
                ModelsReason::SignInExpired
            } else {
                ModelsReason::Error
            }));
        }
    };
    if !js::truthy(&account) {
        return Ok(Talk::Reason(ModelsReason::NotSignedIn));
    }
    if account.get("type").and_then(Value::as_str) != Some("chatgpt") {
        return Ok(Talk::Reason(ModelsReason::NotChatgpt));
    }
    let mut data: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for _page in 0..MAX_PAGES {
        let mut params = json!({ "limit": 100, "includeHidden": false });
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let res = rpc.request("model/list", params).await?;
        if let Some(page) = res.get("data").and_then(Value::as_array) {
            data.extend(page.iter().cloned());
        }
        cursor = res
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|next| !next.is_empty())
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok(Talk::Listed { data, account })
}

/// `/failed to refresh available models/i`
static REFRESH_FAILED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:failed to refresh available models)").expect("the refresh-failed pattern"));

struct Ask {
    home: PathBuf,
    env: Env,
    codex_bin: Option<PathBuf>,
    timeout: Duration,
}

async fn ask_codex(ask: Ask) -> AccountModelsResult {
    let fail = AccountModelsResult::failed;
    let home = &ask.home;
    let guard = codex_config_guard(&codex_config_files_for(home, Some(home)), None);
    if !guard.ok {
        return fail(ModelsReason::UnsafeConfig);
    }
    let Ok(bin) = resolve_codex_bin(ask.codex_bin.as_deref(), &ask.env) else {
        return fail(ModelsReason::CodexMissing);
    };
    let mut args: Vec<&str> = CODEX_BASE_ARGS.to_vec();
    args.push("app-server");
    let extra = EnvMap::from([("RUST_LOG".to_string(), "error".to_string())]);
    let spawned = spawn_codex(
        &bin,
        &args,
        &SpawnOpts {
            env: codex_child_env(&ask.env, home, &extra),
            cwd: Some(home.clone()),
        },
    );
    let mut child = match spawned {
        Ok(child) => child,
        // Node told of these three through the child's error event, as an error; any other failed start, and a
        // program that isn't there or can't be run, is a codex that is missing.
        Err(err) => {
            return fail(match spawn_error_code(&bin, &err) {
                Some("EAGAIN" | "EMFILE" | "ENFILE") => ModelsReason::Error,
                _ => ModelsReason::CodexMissing,
            });
        }
    };
    let stderr = collect_text(child.stderr.take(), 256 * 1024);
    let mut rpc = RpcClient::new(child.stdin.take(), child.stdout.take());

    let result = match tokio::time::timeout(ask.timeout, converse(&mut rpc)).await {
        Err(_) => fail(ModelsReason::Timeout),
        Ok(Err(_)) => fail(ModelsReason::Error),
        Ok(Ok(Talk::Reason(reason))) => fail(reason),
        Ok(Ok(Talk::Listed { data, account })) => {
            // Let it finish on its own, so everything it logged is in before reading the log.
            rpc.end_input();
            let closed = async {
                let _ = child.wait().await;
                let _ = (&mut rpc.reader).await;
                stderr.finish().await;
            };
            let _ = tokio::time::timeout(Duration::from_millis(3000), closed).await;
            let models = map_model_list(&Value::Array(data));
            if REFRESH_FAILED.is_match(&strip_ansi(&stderr.text())) {
                fail(ModelsReason::NotLive)
            } else {
                match cached_model_ids(home) {
                    Some(cached) if models.iter().all(|m| cached.contains(&m.id)) => {
                        if models.is_empty() {
                            fail(ModelsReason::Empty)
                        } else {
                            AccountModelsResult {
                                models,
                                source: Some(ModelsSource::Account),
                                reason: None,
                                account: Some(account_info(&account)),
                            }
                        }
                    }
                    _ => fail(ModelsReason::NotLive),
                }
            }
        }
    };
    kill_tree(&mut child, Duration::from_millis(2000)).await;
    result
}

// --- Public ---------------------------------------------------------------------------------------------------------

/// Why the account's list couldn't be read as its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelsReason {
    NotSignedIn,
    /// An API key login.
    NotChatgpt,
    SignInExpired,
    /// Codex answered from its bundled catalog.
    NotLive,
    Empty,
    Timeout,
    UnsafeConfig,
    CodexMissing,
    Error,
}

impl ModelsReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelsReason::NotSignedIn => "not-signed-in",
            ModelsReason::NotChatgpt => "not-chatgpt",
            ModelsReason::SignInExpired => "sign-in-expired",
            ModelsReason::NotLive => "not-live",
            ModelsReason::Empty => "empty",
            ModelsReason::Timeout => "timeout",
            ModelsReason::UnsafeConfig => "unsafe-config",
            ModelsReason::CodexMissing => "codex-missing",
            ModelsReason::Error => "error",
        }
    }
}

/// Where a list came from: only ever the account's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelsSource {
    Account,
}

/// The signed-in ChatGPT account's models, with where they came from: `{models, source, reason?, account?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountModelsResult {
    pub models: Vec<AccountModel>,
    /// "account" for the account's live list, else null with no models and a reason.
    pub source: Option<ModelsSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ModelsReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountInfo>,
}

impl AccountModelsResult {
    fn failed(reason: ModelsReason) -> Self {
        AccountModelsResult {
            models: Vec::new(),
            source: None,
            reason: Some(reason),
            account: None,
        }
    }
}

/// An answer kept for a home: the auth.json it was read with, when, and the answer.
struct Kept {
    fingerprint: String,
    at: i64,
    result: AccountModelsResult,
}

type Asked = watch::Receiver<Option<AccountModelsResult>>;

/// The app's kept answers by home, and the questions being asked right now by home and sign-in. The JS kept these
/// in two module-level maps.
#[derive(Default)]
pub struct AccountModels {
    kept: Mutex<HashMap<PathBuf, Kept>>,
    inflight: Mutex<HashMap<(PathBuf, String), Asked>>,
}

impl AccountModels {
    /// The app's, made on first use.
    pub fn of(app: &App) -> Arc<AccountModels> {
        app.get_or_init(AccountModels::default)
    }
}

/// Forget every kept answer (after a sign-out, say; a changed auth.json already does this per home).
pub fn clear_account_models_cache(app: &App) {
    AccountModels::of(app).kept.lock().clear();
}

/// How [`read_account_models`] asks.
#[derive(Debug, Clone)]
pub struct AccountModelsOpts {
    /// The ChatGPT home (required).
    pub codex_home: PathBuf,
    /// The server's environment; default the app's. Credentials are stripped from it.
    pub env: Option<Env>,
    /// The codex to ask (else TARSEE_CODEX_PATH, else `codex` on the PATH).
    pub codex_bin: Option<PathBuf>,
    pub timeout: Duration,
    /// How long an answer is kept; zero to always ask.
    pub max_age: Duration,
}

impl Default for AccountModelsOpts {
    fn default() -> Self {
        AccountModelsOpts {
            codex_home: PathBuf::new(),
            env: None,
            codex_bin: None,
            timeout: Duration::from_millis(20_000),
            max_age: Duration::from_millis(DEFAULT_MAX_AGE_MS),
        }
    }
}

/// The signed-in ChatGPT account's models, with where they came from: `{models, source, reason?, account?}`.
/// source is account for the account's live list, else null with no models and a reason: not-signed-in, not-chatgpt
/// (an API key login), sign-in-expired, not-live (Codex answered from its bundled catalog), empty, timeout,
/// unsafe-config, codex-missing or error.
///
/// opts: `codex_home` (required; the ChatGPT home), `env` (the server's environment; credentials are stripped from
/// it), `codex_bin` (else TARSEE_CODEX_PATH, else `codex` on the PATH), `timeout` (20 s), `max_age` (how long an
/// answer is kept; 5 minutes, zero to always ask).
pub async fn read_account_models(app: &App, opts: &AccountModelsOpts) -> Result<AccountModelsResult, TypeError> {
    let home = require_codex_home(&opts.codex_home)?;
    let Some(fingerprint) = auth_fingerprint(&home) else {
        return Ok(AccountModelsResult::failed(ModelsReason::NotSignedIn));
    };
    let service = AccountModels::of(app);
    let max_age = i64::try_from(opts.max_age.as_millis()).unwrap_or(i64::MAX);
    if let Some(hit) = service.kept.lock().get(&home)
        && hit.fingerprint == fingerprint
        && max_age > 0
        && js::now_ms().saturating_sub(hit.at) < max_age
    {
        return Ok(hit.result.clone());
    }
    let key = (home.clone(), fingerprint.clone());
    let mut asked = {
        let mut inflight = service.inflight.lock();
        match inflight.get(&key) {
            Some(asked) => asked.clone(),
            None => {
                let (answer, asked) = watch::channel(None);
                inflight.insert(key.clone(), asked.clone());
                let ask = Ask {
                    home,
                    env: opts.env.clone().unwrap_or_else(|| app.env().clone()),
                    codex_bin: opts.codex_bin.clone(),
                    timeout: opts.timeout,
                };
                let service = service.clone();
                tokio::spawn(async move {
                    let home = ask.home.clone();
                    let result = ask_codex(ask).await;
                    if result.source == Some(ModelsSource::Account) {
                        service.kept.lock().insert(
                            home,
                            Kept {
                                fingerprint,
                                at: js::now_ms(),
                                result: result.clone(),
                            },
                        );
                    }
                    service.inflight.lock().remove(&key);
                    let _ = answer.send(Some(result));
                });
                asked
            }
        }
    };
    let answered = match asked.wait_for(Option::is_some).await {
        Ok(result) => result.clone(),
        // The task that asked is gone without an answer (the server is shutting down).
        Err(_) => None,
    };
    Ok(answered.unwrap_or_else(|| AccountModelsResult::failed(ModelsReason::Error)))
}

/// The signed-in ChatGPT account's models: `[{id, label, efforts, default?, defaultEffort?, vision, description?}]`,
/// or none when they can't be read as the account's own (the caller then leaves the model out and Codex uses its
/// default).
pub async fn list_account_models(app: &App, opts: &AccountModelsOpts) -> Result<Vec<AccountModel>, TypeError> {
    Ok(read_account_models(app, opts).await?.models)
}

/// Fill the provider registry's "chatgpt-models" catalog (what the picker, tiers and defaults read for ChatGPT) with
/// the signed-in account's list, or empty it when the list can't be read, so no model is named and Codex picks its
/// default. Call it at boot, after a sign-in, after a sign-out, and when the picker is opened (the five-minute
/// memory above keeps that cheap). Takes [`list_account_models`]' options; gives [`read_account_models`]' answer.
pub async fn sync_chatgpt_catalog(app: &App, opts: &AccountModelsOpts) -> Result<AccountModelsResult, TypeError> {
    require_codex_home(&opts.codex_home)?;
    // A task of its own, as the JS call went on by itself: the catalog takes the answer whether or not the caller
    // that asked for the sync is still there.
    let (app, opts) = (app.clone(), opts.clone());
    let synced = tokio::spawn(async move {
        let result = read_account_models(&app, &opts).await?;
        let rows: Vec<Value> = result
            .models
            .iter()
            .map(|model| serde_json::to_value(model).unwrap_or(Value::Null))
            .collect();
        // ("chatgpt-models" is a runtime catalog: this cannot fail.)
        let _ = ProviderRegistry::of(&app).set_catalog_models("chatgpt-models", &rows);
        Ok(result)
    });
    // (A task gone without an answer: the server is shutting down.)
    synced
        .await
        .unwrap_or_else(|_| Ok(AccountModelsResult::failed(ModelsReason::Error)))
}

#[cfg(test)]
mod tests {
    //! Port of the cases of `test/codex-models.test.js` that start nothing ("mapModelList: the app-server's model
    //! shape", and the check that no ChatGPT model is written into Tarsee's code). The cases that run an app-server
    //! are in `tests/it/codex_models.rs`.
    use super::*;
    use crate::testkit::tmp_dir;

    const BUNDLED: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/codex-login/model-list.bundled.json"
    ));

    #[test]
    fn maps_the_real_binarys_answer_id_label_efforts_the_default_and_hidden_ones_left_out() {
        let bundled: Value = serde_json::from_str(BUNDLED).unwrap();
        let mapped = map_model_list(&bundled["data"]);
        let visible: Vec<&Value> = bundled["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| !js::truthy(&m["hidden"]))
            .collect();
        assert_eq!(mapped.len(), visible.len());
        assert!(mapped.len() > 2, "the fixture lists real models");
        for (got, m) in mapped.iter().zip(&visible) {
            assert_eq!(got.id, m["model"].as_str().unwrap());
            assert_eq!(got.label, m["displayName"].as_str().unwrap());
            let efforts: Vec<&str> = m["supportedReasoningEfforts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["reasoningEffort"].as_str().unwrap())
                .collect();
            assert_eq!(got.efforts, efforts);
            assert_eq!(got.default_effort.as_deref(), m["defaultReasoningEffort"].as_str());
            assert_eq!(got.default, m["isDefault"] == json!(true));
            let modalities = m.get("inputModalities").cloned().unwrap_or(json!(["text", "image"]));
            assert_eq!(
                got.vision,
                modalities.as_array().unwrap().contains(&json!("image")),
                "{}",
                got.id
            );
        }
        assert_eq!(mapped.iter().filter(|m| m.default).count(), 1, "one default");
    }

    #[test]
    fn drops_entries_without_a_usable_id_duplicates_and_odd_effort_values() {
        let mapped = map_model_list(&json!([
            { "id": "a", "model": "a", "displayName": "A", "hidden": false, "isDefault": false, "supportedReasoningEfforts": [{ "reasoningEffort": "low" }, { "reasoningEffort": "" }, {}], "defaultReasoningEffort": "low" },
            { "id": "a", "model": "a", "displayName": "A again", "hidden": false, "isDefault": false, "supportedReasoningEfforts": [] },
            { "id": "", "model": "", "displayName": "nothing", "hidden": false },
            { "id": "bad id with spaces", "model": "bad id with spaces", "displayName": "x", "hidden": false },
            null,
            { "id": "b", "displayName": "", "hidden": false, "isDefault": true, "supportedReasoningEfforts": [] },
        ]));
        assert_eq!(
            serde_json::to_value(&mapped).unwrap(),
            json!([
                { "id": "a", "label": "A", "efforts": ["low"], "defaultEffort": "low", "vision": true },
                { "id": "b", "label": "b", "efforts": [], "default": true, "vision": true },
            ])
        );
        // The keys come in the JS order.
        assert_eq!(
            serde_json::to_string(&mapped[0]).unwrap(),
            r#"{"id":"a","label":"A","efforts":["low"],"defaultEffort":"low","vision":true}"#
        );
    }

    /// "the sign-in and model-list modules name no model": no ChatGPT model is written into Tarsee's code.
    #[test]
    fn the_sign_in_and_model_list_modules_name_no_model() {
        // `/\bgpt-\d|\bo[1-9](-mini)?\b|\bluna\b|\bastra\b|\bcodex-mini\b/i`
        let names_a_model =
            Regex::new(r"(?i-u:\bgpt-[0-9]|\bo[1-9](-mini)?\b|\bluna\b|\bastra\b|\bcodex-mini\b)").unwrap();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("ai");
        // The code itself: what comes before each file's tests (this very pattern is in this file's).
        for file in ["codex_models.rs", "codex_device_login.rs", "codex_cli.rs"] {
            let src = std::fs::read_to_string(dir.join(file)).unwrap();
            let code = src.split("#[cfg(test)]").next().unwrap();
            assert!(code.len() > 2000, "{file}");
            let found = names_a_model.find(code).map(|m| m.as_str());
            assert_eq!(found, None, "{file}");
        }
        assert!(names_a_model.is_match("use gpt-5 here") && names_a_model.is_match("the O3-mini model"));
    }

    // --- What the JS suite left out ---

    #[test]
    fn a_model_entry_is_read_as_leniently_as_javascript_read_it() {
        let mapped = map_model_list(&json!([
            // model wins over id; a name that is only spaces falls back to the id; text is trimmed.
            { "model": " m1 ", "id": "other", "displayName": "   ", "description": "  words  " },
            // The id when there is no model; efforts as plain strings, each once, odd ones dropped.
            { "model": "", "id": "m2", "supportedReasoningEfforts": ["High", "high", "High", "x y", 7, null, { "reasoningEffort": "low" }], "defaultReasoningEffort": "bad one" },
            // A number is its text; a one-item list is its item.
            { "model": 5 },
            { "id": ["m3"] },
            // No modalities listed: it sees pictures. Listed without image: it doesn't. Not a list: it does.
            { "id": "m4", "inputModalities": ["text"] },
            { "id": "m5", "inputModalities": "image" },
            // hidden must be exactly true to hide; isDefault exactly true to be the default.
            { "id": "m6", "hidden": "true", "isDefault": 1 },
            { "id": "m7", "hidden": true },
            // Not an id: too long, an odd first character, an object, nothing at all.
            { "id": format!("m{}", "x".repeat(128)) },
            { "id": "-m8" },
            { "id": {} },
            { "displayName": "nameless" },
            "m9",
            ["m10"],
            7,
        ]));
        let ids: Vec<&str> = mapped.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m1", "m2", "5", "m3", "m4", "m5", "m6"]);
        assert_eq!(mapped[0].label, "m1");
        assert_eq!(mapped[0].description.as_deref(), Some("words"));
        assert_eq!(mapped[1].efforts, ["High", "high", "low"]);
        assert_eq!(mapped[1].default_effort, None);
        assert!(mapped[2].vision && !mapped[4].vision && mapped[5].vision);
        assert!(!mapped[6].default);
        // An id of exactly 128 characters is one; anything that is not a list gives nothing.
        assert_eq!(map_model_list(&json!([{ "id": "m".repeat(128) }])).len(), 1);
        for not_a_list in [json!(null), json!({}), json!("x"), json!(3)] {
            assert!(map_model_list(&not_a_list).is_empty());
        }
    }

    #[test]
    fn the_cache_names_its_models_by_slug_id_or_model_and_is_nothing_when_it_names_none() {
        let tmp = tmp_dir();
        let cache = |text: &str| {
            std::fs::write(tmp.path().join("models_cache.json"), text).unwrap();
            cached_model_ids(tmp.path()).map(|ids| {
                let mut ids: Vec<String> = ids.into_iter().collect();
                ids.sort();
                ids
            })
        };
        assert_eq!(cached_model_ids(tmp.path()), None, "no file");
        assert_eq!(
            cache(
                r#"{"models":[{"slug":"a"},{"id":"b"},{"model":"c"},{"slug":"d","id":"e","model":"f"},{"slug":""},{"slug":7},"g",null,["h"]]}"#
            ),
            Some(vec![
                "a".into(),
                "b".into(),
                "c".into(),
                "d".into(),
                "e".into(),
                "f".into()
            ])
        );
        for nothing in [
            "{ torn",
            "null",
            "[]",
            "{}",
            r#"{"models":{}}"#,
            r#"{"models":[]}"#,
            r#"{"models":[{"slug":""},{"name":"x"}]}"#,
        ] {
            assert_eq!(cache(nothing), None, "{nothing}");
        }
        // Read as JSON.parse read it: a byte order mark, and values a stricter reader refuses, don't hide the list.
        assert_eq!(
            cache("\u{FEFF}{\"etag\":\"\\ud800\",\"n\":1e400,\"models\":[{\"slug\":\"a\"}]}"),
            Some(vec!["a".into()])
        );
    }

    #[test]
    fn an_answer_line_is_matched_to_its_request_and_everything_else_is_passed_over_or_refused() {
        let pending: Pending = Arc::default();
        let (outgoing, mut written) = mpsc::unbounded_channel();
        let ask = |id: u64| {
            let (answer, answered) = oneshot::channel();
            pending.lock().waiting.insert(id, answer);
            answered
        };
        let mut wrote = || match written.try_recv() {
            Ok(Outgoing::Line(line)) => Some(line),
            _ => None,
        };
        // Lines to pass over: nothing is answered, nothing is written.
        let mut first = ask(1);
        for line in [
            "",
            "not json",
            "42",
            "[1]",
            "null",
            r#"{"method":"thread/started","params":{}}"#,
            r#"{"id":"1","result":{"text":"an id as text is not ours"}}"#,
            r#"{"id":2,"result":{"nobody":"asked"}}"#,
            r#"{"id":1.5,"result":{}}"#,
            r#"{"id":null,"result":{}}"#,
            r#"{"result":{"no":"id"}}"#,
        ] {
            on_line(line, &pending, &outgoing);
            assert!(first.try_recv().is_err(), "{line}");
            assert_eq!(wrote(), None, "{line}");
        }
        // The answer; then the same answer again, which nobody waits for any more.
        on_line(r#"{"id":1,"result":{"ok":true}}"#, &pending, &outgoing);
        assert_eq!(first.try_recv().unwrap(), Ok(json!({ "ok": true })));
        on_line(r#"{"id":1,"result":{"ok":false}}"#, &pending, &outgoing);
        assert!(pending.lock().waiting.is_empty());
        // An id written as 2.0 is the number 2; no result at all is null.
        let mut second = ask(2);
        on_line(r#"{"id":2.0}"#, &pending, &outgoing);
        assert_eq!(second.try_recv().unwrap(), Ok(Value::Null));
        // An error, with its message as text; without one, the fallback. An error that is null or false is none.
        for (line, want) in [
            (
                r#"{"id":3,"error":{"code":-32603,"message":"Please log out and sign in again."}}"#,
                Err("Please log out and sign in again."),
            ),
            (r#"{"id":3,"error":{"code":1}}"#, Err("app-server error")),
            (r#"{"id":3,"error":{"message":null}}"#, Err("app-server error")),
            (r#"{"id":3,"error":{"message":401}}"#, Err("401")),
            (r#"{"id":3,"error":"boom"}"#, Err("app-server error")),
            (r#"{"id":3,"error":null,"result":5}"#, Ok(json!(5))),
            (r#"{"id":3,"error":false,"result":5}"#, Ok(json!(5))),
            (r#"{"id":3,"error":0}"#, Ok(Value::Null)),
        ] {
            let mut third = ask(3);
            on_line(line, &pending, &outgoing);
            let got = third.try_recv().unwrap().map_err(|err| err.message);
            assert_eq!(got, want.map_err(str::to_string), "{line}");
        }
        // A request of the server's own is refused with its id as given, whatever that is; ours stay pending.
        let mut fourth = ask(4);
        for (line, id) in [
            (
                r#"{"id":"srv-1","method":"approval/request","params":{}}"#,
                json!("srv-1"),
            ),
            (r#"{"id":4,"method":"approval/request"}"#, json!(4)),
            (r#"{"id":null,"method":"x"}"#, json!(null)),
        ] {
            on_line(line, &pending, &outgoing);
            let reply: Value = serde_json::from_str(&wrote().expect("a refusal")).unwrap();
            assert_eq!(
                reply,
                json!({ "id": id, "error": { "code": -32601, "message": "Tarsee's model check doesn't handle this request." } })
            );
            assert!(fourth.try_recv().is_err());
        }
        // A method that is not text is no request: with our id it is an answer.
        on_line(r#"{"id":4,"method":7,"result":"r"}"#, &pending, &outgoing);
        assert_eq!(fourth.try_recv().unwrap(), Ok(json!("r")));
    }

    #[test]
    fn the_account_shown_is_an_email_and_a_plan_that_look_like_ones() {
        let shown = |account: Value| serde_json::to_value(account_info(&account)).unwrap();
        assert_eq!(
            shown(json!({ "type": "chatgpt", "email": "someone@example.test", "planType": "free" })),
            json!({ "email": "someone@example.test", "plan": "free" })
        );
        assert_eq!(
            shown(json!({ "email": "not an address", "planType": "two words" })),
            json!({})
        );
        assert_eq!(shown(json!({ "email": 7, "planType": null })), json!({}));
        assert_eq!(shown(json!(true)), json!({}));
    }

    #[test]
    fn the_reasons_and_the_answers_shape_are_the_node_ones() {
        for (reason, text) in [
            (ModelsReason::NotSignedIn, "not-signed-in"),
            (ModelsReason::NotChatgpt, "not-chatgpt"),
            (ModelsReason::SignInExpired, "sign-in-expired"),
            (ModelsReason::NotLive, "not-live"),
            (ModelsReason::Empty, "empty"),
            (ModelsReason::Timeout, "timeout"),
            (ModelsReason::UnsafeConfig, "unsafe-config"),
            (ModelsReason::CodexMissing, "codex-missing"),
            (ModelsReason::Error, "error"),
        ] {
            assert_eq!(reason.as_str(), text);
            assert_eq!(serde_json::to_value(reason).unwrap(), json!(text));
        }
        assert_eq!(
            serde_json::to_string(&AccountModelsResult::failed(ModelsReason::NotLive)).unwrap(),
            r#"{"models":[],"source":null,"reason":"not-live"}"#
        );
        let live = AccountModelsResult {
            models: vec![],
            source: Some(ModelsSource::Account),
            reason: None,
            account: Some(AccountInfo {
                email: None,
                plan: Some("free".into()),
            }),
        };
        assert_eq!(
            serde_json::to_string(&live).unwrap(),
            r#"{"models":[],"source":"account","account":{"plan":"free"}}"#
        );
        // The words that mean the sign-in is gone, as the app-server may put them.
        for gone in [
            "Your access token could not be refreshed. Please log out and sign in again.",
            "token expired",
            "401 Unauthorized",
            "unauthorised",
            "please login",
            "you were signed out",
        ] {
            assert!(SIGN_IN_GONE.is_match(gone), "{gone}");
        }
        for other in [
            "codex app-server exited",
            "internal error",
            "code 4010",
            "app-server error",
        ] {
            assert!(!SIGN_IN_GONE.is_match(other), "{other}");
        }
    }
}
