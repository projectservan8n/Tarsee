//! Port of `src/lib/railway-admin.js`: Railway for the agent (tarsee_railway): list projects, environments, services
//! and variable names, set a service variable and redeploy a service, done by Tarsee itself with a Railway token it
//! reads from the vault. Without it the only way to set a variable is a command carrying the value
//! (`railway variables --set`, or a GraphQL call with the token in it), which puts a secret into a command line, a
//! transcript and the model's context, and which Claude Code's auto mode rightly blocks.
//!
//! How it reaches Railway: the public GraphQL API (the same documents Railway's CLI 5.x sends:
//! variableCollectionUpsert, deployments + deploymentRedeploy, environment.variables for names), with an account or
//! workspace token as `Authorization: Bearer`. Not the `railway` CLI: its login is a short-lived OAuth token only the
//! CLI refreshes, and a value handed to a child process sits in its argv or stdin. Here a secret value only ever
//! travels inside the HTTPS request body.
//!
//! Which token: the vault key RAILWAY_API_TOKEN, else the RAILWAY_API_TOKEN environment variable (a Railway service
//! variable the owner set; Railway does not inject one itself). Railway's project tokens are not accepted by this API
//! as Bearer, so it takes an account or workspace token.
//!
//! Tarsee usually runs on Railway, which tells every service its own RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID and
//! RAILWAY_SERVICE_ID. With no project given, the tool works on the project Tarsee runs in, in the environment it
//! runs in, on its own service. Redeploying that service (or setting a variable on it with a deploy) restarts
//! Tarsee, which ends the turn doing it: the result says so.
//!
//! Secrets: `from_key` names a vault key; its value is read here, sent to Railway and never put in a result, a log
//! line or an error (every text that leaves is scrubbed of it and of the token). Variable values are never read
//! back: list_variables asks Railway for names only.
//!
//! Nothing here deletes: no variable, service, environment or project is ever removed, and variables are never
//! replaced wholesale (no `replace`).
//!
//! Every call returns a plain-English string (never fails) and logs one line: the action, the project, the
//! environment, the service, never a value or a token.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use super::discord_admin::{js_slice_shown, js_string, js_string_or_empty, js_tail_shown, js_template, one_line};
use crate::app::App;
use crate::env::Env;
use crate::lib::key_vault;
use crate::middleware::auth::JS_WHITESPACE;
use crate::net::fetch::{Fetch, FetchError, FetchRequest};
use crate::util::js::trim as js_trim;
use crate::util::js::{truthy, utf16_len};

pub const ACTIONS: [&str; 4] = ["list_projects", "list_variables", "set_variable", "redeploy"];
const WRITES: [&str; 2] = ["set_variable", "redeploy"];

pub const API_URL: &str = "https://backboard.railway.com/graphql/v2";
/// Per call; a set_variable is up to four of them.
const TIMEOUT: Duration = Duration::from_millis(12_000);

/// Where the token is looked for, first found wins: the vault key, then the environment variable of the same name.
pub const TOKEN_KEY: &str = "RAILWAY_API_TOKEN";
const LABEL: &str = "the owner's Railway account";

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        .expect("the UUID pattern")
});
static VAR_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[A-Za-z_][A-Za-z0-9_]{0,254}$").expect("the variable name pattern"));

/// The only documents this tool ever sends. None deletes; the upsert never passes `replace`.
pub struct Docs {
    pub projects: &'static str,
    pub project: &'static str,
    pub variable_names: &'static str,
    pub upsert: &'static str,
    pub latest_deployment: &'static str,
    pub redeploy: &'static str,
}

impl Docs {
    /// Every document, in the JS object's order (`Object.values(DOCS)`).
    pub fn all(&self) -> [&'static str; 6] {
        [
            self.projects,
            self.project,
            self.variable_names,
            self.upsert,
            self.latest_deployment,
            self.redeploy,
        ]
    }
}

pub const DOCS: Docs = Docs {
    projects: "query TarseeProjects { projects(first: 500) { edges { node { id name deletedAt } } } }",
    project: "query TarseeProject($id: String!) { project(id: $id) { id name deletedAt environments { edges { node { id name deletedAt } } } services { edges { node { id name } } } } }",
    variable_names: "query TarseeVariableNames($projectId: String!, $environmentId: String!) { environment(id: $environmentId, projectId: $projectId) { variables(first: 10000) { edges { node { name serviceId isSealed } } } } }",
    upsert: "mutation TarseeVariableUpsert($projectId: String!, $environmentId: String!, $serviceId: String!, $variables: EnvironmentVariables!, $skipDeploys: Boolean) { variableCollectionUpsert(input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, variables: $variables, skipDeploys: $skipDeploys }) }",
    latest_deployment: "query TarseeLatestDeployment($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status createdAt } } } }",
    redeploy: "mutation TarseeRedeploy($id: String!) { deploymentRedeploy(id: $id) { id } }",
};

/// Values that look like a secret: these go through from_key, never value. JavaScript's `/i` here folds ASCII
/// letters only, and its `\s` is its own set.
static SECRET_SHAPES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let shape = |pattern: &str, what: &'static str| (Regex::new(pattern).expect("a secret shape"), what);
    vec![
        shape(
            r"(?i-u:discord(app)?\.com/api/(v[0-9]+/)?webhooks/[0-9]+/)[A-Za-z0-9_-]+",
            "a Discord webhook URL",
        ),
        shape(r"(?i-u:hooks\.slack\.com/services/)", "a Slack webhook URL"),
        shape(
            &format!("^[a-zA-Z][a-zA-Z0-9+.-]*://{}+:{}+@", not_space(":@/"), not_space("@/")),
            "a URL with a password in it",
        ),
        shape("-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"),
        shape(
            "^(sk-|sk_live_|rk_live_|ghp_|gho_|github_pat_|xox[abpr]-|glpat-)",
            "an API key or token",
        ),
        shape("^AKIA[0-9A-Z]{16}$", "an AWS access key"),
    ]
});

/// `[^\s<others>]` with JavaScript's whitespace.
fn not_space(others: &str) -> String {
    // JS_WHITESPACE is "[...]"; its inside goes into the negated class.
    let inner = &JS_WHITESPACE[1..JS_WHITESPACE.len() - 1];
    format!("[^{others}{inner}]")
}

/// The vault's mask: the first and last four characters, or **** when short.
pub fn mask_value(value: &str) -> String {
    if utf16_len(value) < 12 {
        return "****".to_string();
    }
    format!("{}...{}", js_slice_shown(value, 0, 4), js_tail_shown(value, 4))
}

/// Where Tarsee itself runs on Railway: the ids Railway gives every service, `None` off Railway (or when one is not
/// an id).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Here {
    pub project_id: Option<String>,
    pub environment_id: Option<String>,
    pub service_id: Option<String>,
}

/// Where Tarsee itself runs on Railway (the variables Railway gives every service), or nothing off Railway.
pub fn here_of(env: &Env) -> Here {
    let id = |name: &str| {
        let value = js_trim(&env.get(name).unwrap_or_default()).to_string();
        UUID.is_match(&value).then_some(value)
    };
    Here {
        project_id: id("RAILWAY_PROJECT_ID"),
        environment_id: id("RAILWAY_ENVIRONMENT_ID"),
        service_id: id("RAILWAY_SERVICE_ID"),
    }
}

// ---------------------------------------------------------------- the vault

/// Every key with its value (`None` for one that cannot be decrypted), in the vault's order.
pub type KeyValues = Vec<(String, Option<String>)>;

/// Where the token and `from_key` values come from: the key vault (`lib/key-vault.js`), or a stand-in in tests.
pub trait RailwayVault: Send + Sync {
    /// The key's value; `None` when there is none. An error is the vault failing to read it.
    fn get_key(&self, name: &str) -> anyhow::Result<Option<String>>;

    /// Every key with its value, in the vault's order (`getAllKeysDecrypted`), used only to point a value that is a
    /// key's at `from_key`. `None`: the vault cannot list them (the JS vault without that function).
    fn get_all_keys_decrypted(&self) -> Option<anyhow::Result<KeyValues>> {
        None
    }
}

/// The app's key vault.
pub struct AppVault<'a>(pub &'a App);

impl RailwayVault for AppVault<'_> {
    fn get_key(&self, name: &str) -> anyhow::Result<Option<String>> {
        Ok(key_vault::get_key(self.0, name)?)
    }

    fn get_all_keys_decrypted(&self) -> Option<anyhow::Result<KeyValues>> {
        Some(Ok(key_vault::get_all_keys_decrypted(self.0)))
    }
}

// ---------------------------------------------------------------- the tool

/// How [`railway_admin`] reaches the vault, the environment and the log. Requests go through `app.fetch()`.
#[derive(Default)]
pub struct RailwayDeps<'a> {
    /// `None`: the app's key vault.
    pub vault: Option<&'a dyn RailwayVault>,
    /// The token's fallback, and where Tarsee runs. `None`: the app's environment.
    pub env: Option<&'a Env>,
    /// One line per call. `None`: `log::info!` (the JS `console.log`).
    pub log: Option<&'a (dyn Fn(&str) + Send + Sync)>,
    /// Per request. `None`: 12 seconds.
    pub timeout: Option<Duration>,
}

/// A failure talking to Railway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApiKind {
    Auth,
    Rate,
    Server,
    Network,
    BadJson,
    Graphql,
}

#[derive(Debug, Clone)]
struct ApiError {
    kind: ApiKind,
    message: String,
}

fn api_error(kind: ApiKind, message: impl Into<String>) -> ApiError {
    ApiError {
        kind,
        message: message.into(),
    }
}

/// Why an action stopped: the tool's own refusal (the JS `RailwayError`), or Railway's answer.
enum Failure {
    Railway(String),
    Api(ApiError),
}

impl From<ApiError> for Failure {
    fn from(err: ApiError) -> Self {
        Failure::Api(err)
    }
}

type Step<T> = Result<T, Failure>;

fn fail<T>(message: impl Into<String>) -> Step<T> {
    Err(Failure::Railway(message.into()))
}

/// A project, an environment, a service: its id and name as Railway gave them.
#[derive(Debug, Clone)]
struct Named {
    id: String,
    name: String,
}

impl Named {
    fn of(node: &Value) -> Named {
        Named {
            id: js_template(node.get("id")),
            name: js_template(node.get("name")),
        }
    }
}

struct Project {
    id: String,
    name: String,
    environments: Vec<Named>,
    services: Vec<Named>,
    is_here: bool,
}

/// What the log line knows, and the secrets every text that leaves is scrubbed of.
#[derive(Default)]
struct Note {
    project: Option<Named>,
    env: Option<Named>,
    service: Option<Named>,
    extra: Vec<String>,
    secrets: Vec<String>,
    outcome_unknown: bool,
}

impl Note {
    /// Every form a secret could take in a text (as it is, JSON-escaped, URL-encoded) becomes `****`.
    fn scrub(&self, text: &str) -> String {
        let mut s = text.to_string();
        for secret in &self.secrets {
            if secret.is_empty() || utf16_len(secret) < 6 {
                continue;
            }
            let json = serde_json::to_string(secret).unwrap_or_default();
            let escaped = json[1..json.len() - 1].to_string();
            let mut forms: Vec<String> = Vec::new();
            for form in [secret.clone(), escaped, encode_uri_component(secret)] {
                if !forms.contains(&form) {
                    forms.push(form);
                }
            }
            for form in forms {
                s = s.replace(&form, "****");
            }
        }
        s
    }
}

/// `encodeURIComponent(text)`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

struct Ctx<'a> {
    args: &'a Value,
    vault: &'a dyn RailwayVault,
    fetch: &'a dyn Fetch,
    token: String,
    timeout: Duration,
    here: Here,
}

impl Ctx<'_> {
    async fn api(&self, query: &str, variables: Value) -> Result<Value, ApiError> {
        gql(self.fetch, &self.token, query, variables, self.timeout).await
    }
}

/// Runs the tool: `args` is its input (see tarsee_railway in `ai/tarsee_mcp.rs`). Always answers with text.
pub async fn railway_admin(app: &App, args: &Value, deps: RailwayDeps<'_>) -> String {
    let empty = Value::Object(Default::default());
    // `args && typeof args === "object" ? args : {}`
    let args = if args.is_object() || args.is_array() {
        args
    } else {
        &empty
    };
    let action = js_string_or_empty(args.get("action"));
    let mut note = Note::default();
    let app_vault = AppVault(app);
    let vault: &dyn RailwayVault = deps.vault.unwrap_or(&app_vault);
    let env = deps.env.unwrap_or(app.env());
    let fetch = app.fetch();
    let timeout = deps.timeout.unwrap_or(TIMEOUT);

    let result = run(args, &action, vault, env, &*fetch, timeout, &mut note).await;
    let (outcome, answer) = match result {
        Ok(out) => ("ok".to_string(), note.scrub(&out)),
        Err(failure) => {
            let mut text = match failure {
                Failure::Railway(message) => message,
                Failure::Api(err) => api_error_text(&err),
            };
            if WRITES.contains(&action.as_str())
                && !note.outcome_unknown
                && !(text.ends_with("Nothing was done.") || text.ends_with("Nothing was changed."))
            {
                text.push_str(" Nothing was changed.");
            }
            let text = note.scrub(&text);
            let outcome = format!("failed: {}", js_slice_shown(&one_line(&text), 0, 200));
            (outcome, format!("railway {action} error: {text}").replace("  ", " "))
        }
    };
    let label = |x: &Option<Named>| match x {
        Some(x) => format!("\"{}\" ({})", x.name, x.id),
        None => "-".to_string(),
    };
    let shown = if action.is_empty() {
        "(no action)"
    } else {
        action.as_str()
    };
    let extra = if note.extra.is_empty() {
        String::new()
    } else {
        format!(" {}", note.extra.join(" "))
    };
    let line = note.scrub(&format!(
        "[railway] {shown} project={} env={} service={}{extra} {outcome}",
        label(&note.project),
        label(&note.env),
        label(&note.service)
    ));
    match deps.log {
        Some(log) => log(&line),
        None => log::info!("{line}"),
    }
    answer
}

async fn run(
    args: &Value,
    action: &str,
    vault: &dyn RailwayVault,
    env: &Env,
    fetch: &dyn Fetch,
    timeout: Duration,
    note: &mut Note,
) -> Step<String> {
    if !ACTIONS.contains(&action) {
        return fail(format!(
            "Unknown action \"{action}\". This tool does: {}. It never deletes anything: deleting a variable, a service or a project is something the owner does by hand in Railway.",
            ACTIONS.join(", ")
        ));
    }
    let writes = WRITES.contains(&action);
    if writes && js_trim(&js_string_or_empty(args.get("approved_by"))).is_empty() {
        return fail(format!(
            "{action} changes a Railway service, so it needs approved_by: who gave the go and for what, in their words, e.g. \"the owner in chat: put the alerts webhook on the worker service\". Who can give it: the owner, or whoever your instructions (AGENTS.md, USER.md) say may. If nobody has said go for this exact change, ask first. Nothing was done."
        ));
    }
    if writes {
        let go = one_line(&js_string_or_empty(args.get("approved_by")));
        note.extra.push(format!("go=\"{}\"", js_slice_shown(&go, 0, 120)));
    }
    let token = token_of(vault, env)?;
    note.secrets.push(token.clone());
    let ctx = Ctx {
        args,
        vault,
        fetch,
        token,
        timeout,
        here: here_of(env),
    };
    match action {
        "list_projects" => list_projects(&ctx, note).await,
        "list_variables" => list_variables(&ctx, note).await,
        "set_variable" => set_variable(&ctx, note).await,
        _ => redeploy(&ctx, note).await,
    }
}

// ---------------------------------------------------------------- the token

fn token_of(vault: &dyn RailwayVault, env: &Env) -> Step<String> {
    let value = match vault.get_key(TOKEN_KEY) {
        Ok(value) => value,
        Err(err) => {
            return fail(format!(
                "The vault key {TOKEN_KEY} could not be read ({err}). Nothing was done."
            ));
        }
    };
    if let Some(value) = value {
        let trimmed = js_trim(&value);
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let from_env = js_trim(&env.get(TOKEN_KEY).unwrap_or_default()).to_string();
    if !from_env.is_empty() {
        return Ok(from_env);
    }
    fail(format!(
        "There is no Railway token: the vault has no {TOKEN_KEY} and neither does the environment. Ask the owner for a Railway account or workspace token (Railway: Account Settings > Tokens, or the workspace's Settings > Tokens; a project token will not do) and save it with tarsee_set_key as {TOKEN_KEY}. Nothing was done."
    ))
}

// ---------------------------------------------------------------- the API

static AUTH_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("(?i-u:not authori[sz]ed|unauthori[sz]ed|invalid token|forbidden)").expect("the auth words")
});

/// `Math.round(ms / 1000)` for a duration.
fn whole_seconds(timeout: Duration) -> u128 {
    (timeout.as_millis() + 500) / 1000
}

async fn gql(
    fetch: &dyn Fetch,
    token: &str,
    query: &str,
    variables: Value,
    timeout: Duration,
) -> Result<Value, ApiError> {
    let request = FetchRequest::post(API_URL)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {token}"))
        .body(json!({ "query": query, "variables": variables }).to_string())
        .timeout(timeout);
    let answered = tokio::time::timeout(timeout, async {
        let res = fetch.fetch(request).await?;
        let status = res.status;
        Ok::<_, FetchError>((status, res.text().await?))
    })
    .await;
    let no_answer = || {
        api_error(
            ApiKind::Network,
            format!("no answer within {} seconds", whole_seconds(timeout)),
        )
    };
    let (status, body) = match answered {
        Err(_) | Ok(Err(FetchError::Timeout)) => return Err(no_answer()),
        Ok(Err(FetchError::Connect(why) | FetchError::Body(why) | FetchError::Other(why))) => {
            return Err(api_error(ApiKind::Network, why));
        }
        Ok(Ok(answer)) => answer,
    };
    let json = serde_json::from_str::<Value>(&body).ok().filter(truthy);
    let first_error = json
        .as_ref()
        .and_then(|j| j.get("errors"))
        .and_then(|e| e.get(0))
        .and_then(|e| e.get("message"))
        .filter(|m| truthy(m))
        .map(js_string);
    if status == 401 || status == 403 {
        return Err(api_error(
            ApiKind::Auth,
            first_error.unwrap_or_else(|| format!("HTTP {status}")),
        ));
    }
    if status == 429 {
        return Err(api_error(
            ApiKind::Rate,
            first_error.unwrap_or_else(|| "Too Many Requests".to_string()),
        ));
    }
    if status >= 500 {
        return Err(api_error(
            ApiKind::Server,
            first_error.unwrap_or_else(|| format!("HTTP {status}")),
        ));
    }
    let Some(json) = json else {
        return Err(api_error(ApiKind::BadJson, format!("HTTP {status}")));
    };
    if let Some(Value::Array(errors)) = json.get("errors")
        && !errors.is_empty()
    {
        let joined = errors
            .iter()
            .map(|e| one_line(&js_string_or_empty(e.get("message"))))
            .filter(|m| !m.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        let message = if joined.is_empty() {
            "an error with no message".to_string()
        } else {
            joined
        };
        let kind = if AUTH_WORDS.is_match(&message) {
            ApiKind::Auth
        } else {
            ApiKind::Graphql
        };
        return Err(api_error(kind, message));
    }
    if status >= 400 {
        return Err(api_error(ApiKind::Graphql, format!("HTTP {status}")));
    }
    Ok(json
        .get("data")
        .filter(|d| truthy(d))
        .cloned()
        .unwrap_or_else(|| json!({})))
}

/// What a failure from Railway means, in plain words.
fn api_error_text(err: &ApiError) -> String {
    match err.kind {
        ApiKind::Auth => format!(
            "Railway did not accept this with the token for {LABEL} (Railway said: \"{}\"). The token may have been revoked or replaced, it may be a project token (this needs an account or workspace token), or the project may be in a workspace it cannot reach. list_projects shows what it can see; if that fails too, ask the owner for a new token, saved in the vault as {TOKEN_KEY}.",
            err.message
        ),
        ApiKind::Rate => {
            "Railway is limiting how often it is called right now (too many requests). Wait a minute and try again."
                .to_string()
        }
        ApiKind::Server => format!(
            "Railway's API had a problem on its side ({}). Try again in a minute.",
            err.message
        ),
        ApiKind::Network => format!(
            "Railway's API could not be reached ({}). Check the internet connection and try again.",
            err.message
        ),
        ApiKind::BadJson => format!(
            "Railway's API sent back something that is not an answer ({}). Try again in a minute.",
            err.message
        ),
        ApiKind::Graphql => format!("Railway said: \"{}\".", err.message),
    }
}

// ---------------------------------------------------------------- names to ids

/// `(conn?.edges || []).map((e) => e?.node).filter(Boolean)`.
fn nodes(conn: Option<&Value>) -> Vec<Value> {
    match conn.and_then(|c| c.get("edges")) {
        Some(Value::Array(edges)) => edges
            .iter()
            .filter_map(|e| e.get("node"))
            .filter(|n| truthy(n))
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

/// Those not deleted.
fn live(list: Vec<Value>) -> Vec<Value> {
    list.into_iter()
        .filter(|x| !x.get("deletedAt").is_some_and(truthy))
        .collect()
}

static NOT_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^a-z0-9]+").expect("the squash pattern"));

fn squash(text: &str) -> String {
    NOT_ALNUM.replace_all(&text.to_lowercase(), "").into_owned()
}

/// The one entry whose id, or name in any case, is `want`; a missing or doubled name says so with the choices.
fn pick(list: &[Named], want: &str, what: &str, place: &str) -> Step<Named> {
    let raw = js_trim(want).to_string();
    if let Some(by_id) = list.iter().find(|x| x.id == raw) {
        return Ok(by_id.clone());
    }
    let lower = raw.to_lowercase();
    let same: Vec<&Named> = list
        .iter()
        .filter(|x| js_trim(&x.name).to_lowercase() == lower)
        .collect();
    if same.len() == 1 {
        return Ok(same[0].clone());
    }
    if same.len() > 1 {
        let names = same
            .iter()
            .map(|x| format!("{} (id {})", x.name, x.id))
            .collect::<Vec<_>>()
            .join(", ");
        return fail(format!(
            "More than one {what} in {place} is named \"{raw}\": {names}. Pass the id instead."
        ));
    }
    let a = squash(&raw);
    let near: Vec<&Named> = if a.len() < 3 {
        Vec::new()
    } else {
        list.iter()
            .filter(|x| {
                let b = squash(&x.name);
                b.len() >= 3 && (b.contains(&a) || a.contains(&b))
            })
            .collect()
    };
    let hint = if near.is_empty() {
        String::new()
    } else {
        let names = near
            .iter()
            .take(5)
            .map(|x| format!("\"{}\" (id {})", x.name, x.id))
            .collect::<Vec<_>>()
            .join(" or ");
        format!(" Did you mean {names}?")
    };
    let all = if list.is_empty() {
        format!(" There are no {what}s there.")
    } else {
        let names = list
            .iter()
            .take(40)
            .map(|x| format!("{} (id {})", x.name, x.id))
            .collect::<Vec<_>>()
            .join(", ");
        let more = if list.len() > 40 { ", ..." } else { "" };
        format!(" The {what}s there: {names}{more}.")
    };
    fail(format!("There is no {what} \"{raw}\" in {place}.{hint}{all}"))
}

async fn all_projects(ctx: &Ctx<'_>) -> Step<Vec<Named>> {
    let data = ctx.api(DOCS.projects, json!({})).await?;
    Ok(live(nodes(data.get("projects"))).iter().map(Named::of).collect())
}

/// The project asked for, or (with none given) the one Tarsee runs in.
async fn resolve_project(ctx: &Ctx<'_>, note: &mut Note) -> Step<Project> {
    let asked = js_trim(&js_string_or_empty(ctx.args.get("project"))).to_string();
    let want = if !asked.is_empty() {
        asked
    } else {
        ctx.here.project_id.clone().unwrap_or_default()
    };
    if want.is_empty() {
        return fail("project is required: the Railway project's name or id (list_projects shows them).");
    }
    let mut id = want.clone();
    if !UUID.is_match(&want) {
        id = pick(&all_projects(ctx).await?, &want, "project", LABEL)?.id;
    }
    let data = match ctx.api(DOCS.project, json!({ "id": id })).await {
        Ok(data) => data,
        Err(err) => {
            static NOT_SEEN: LazyLock<Regex> = LazyLock::new(|| {
                Regex::new("(?i-u:not found|not authori[sz]ed|unauthori[sz]ed)").expect("the not seen words")
            });
            if UUID.is_match(&want)
                && matches!(err.kind, ApiKind::Graphql | ApiKind::Auth)
                && NOT_SEEN.is_match(&err.message)
            {
                return fail(format!(
                    "{LABEL} cannot see a project with id {want} (Railway said: \"{}\"). list_projects shows the ones it can.",
                    err.message
                ));
            }
            return Err(err.into());
        }
    };
    let p = data.get("project").filter(|p| truthy(p));
    let deleted = p.and_then(|p| p.get("deletedAt")).is_some_and(truthy);
    let Some(p) = p.filter(|_| !deleted) else {
        return fail(format!(
            "{LABEL} has no project with id {id}{}. list_projects shows the ones it can see.",
            if deleted { " (it was deleted)" } else { "" }
        ));
    };
    let named = Named::of(p);
    let project = Project {
        is_here: ctx.here.project_id.as_deref() == Some(named.id.as_str()),
        id: named.id.clone(),
        name: named.name.clone(),
        environments: live(nodes(p.get("environments"))).iter().map(Named::of).collect(),
        services: nodes(p.get("services")).iter().map(Named::of).collect(),
    };
    note.project = Some(named);
    Ok(project)
}

/// The environment asked for; else, in Tarsee's own project, the one it runs in; else production.
fn resolve_env(ctx: &Ctx<'_>, project: &Project, note: &mut Note) -> Step<Named> {
    let asked = js_trim(&js_string_or_empty(ctx.args.get("environment"))).to_string();
    let want = if !asked.is_empty() {
        asked
    } else if let Some(here) = ctx.here.environment_id.clone().filter(|_| project.is_here) {
        here
    } else {
        "production".to_string()
    };
    let env = pick(
        &project.environments,
        &want,
        "environment",
        &format!("the project \"{}\"", project.name),
    )?;
    note.env = Some(env.clone());
    Ok(env)
}

/// The service asked for; else, in Tarsee's own project, Tarsee's own service.
fn resolve_service(ctx: &Ctx<'_>, project: &Project, note: &mut Note) -> Step<Named> {
    let asked = js_trim(&js_string_or_empty(ctx.args.get("service"))).to_string();
    let want = if !asked.is_empty() {
        asked
    } else {
        ctx.here
            .service_id
            .clone()
            .filter(|_| project.is_here)
            .unwrap_or_default()
    };
    if want.is_empty() {
        let names = project
            .services
            .iter()
            .map(|s| format!("{} (id {})", s.name, s.id))
            .collect::<Vec<_>>()
            .join(", ");
        return fail(format!(
            "service is required: the service's name or id in the project \"{}\". Services there: {}.",
            project.name,
            if names.is_empty() { "none".to_string() } else { names }
        ));
    }
    let svc = pick(
        &project.services,
        &want,
        "service",
        &format!("the project \"{}\"", project.name),
    )?;
    note.service = Some(svc.clone());
    Ok(svc)
}

struct VariableName {
    name: String,
    service_id: Option<String>,
    sealed: bool,
}

async fn variable_names(ctx: &Ctx<'_>, project: &Project, env: &Named) -> Step<Vec<VariableName>> {
    let data = ctx
        .api(
            DOCS.variable_names,
            json!({ "projectId": project.id, "environmentId": env.id }),
        )
        .await?;
    let Some(environment) = data.get("environment").filter(|e| truthy(e)) else {
        return fail(format!(
            "Railway found no environment {} in the project \"{}\".",
            env.id, project.name
        ));
    };
    Ok(nodes(environment.get("variables"))
        .iter()
        .map(|n| VariableName {
            name: js_template(n.get("name")),
            service_id: n.get("serviceId").filter(|s| truthy(s)).map(js_string),
            sealed: n.get("isSealed").is_some_and(truthy),
        })
        .collect())
}

fn where_of(svc: &Named, env: &Named, project: &Project) -> String {
    format!(
        "{} (service id {}) in {} (environment id {}), project \"{}\" (id {})",
        svc.name, svc.id, env.name, env.id, project.name, project.id
    )
}

fn is_self(svc: &Named, env: &Named, here: &Here) -> bool {
    match &here.service_id {
        Some(service) => svc.id == *service && here.environment_id.as_ref().is_none_or(|e| env.id == *e),
        None => false,
    }
}

const SELF_RESTART: &str = "This is Tarsee's own service: the deploy restarts Tarsee, which ends the turn that asked for it. Tarsee is back once Railway has deployed it (usually a minute or two).";

// ---------------------------------------------------------------- list_projects

async fn list_projects(ctx: &Ctx<'_>, note: &mut Note) -> Step<String> {
    if js_trim(&js_string_or_empty(ctx.args.get("project"))).is_empty() {
        let mut list = all_projects(ctx).await?;
        list.sort_by(|a, b| locale_compare(&a.name, &b.name));
        if list.is_empty() {
            return Ok(format!("{} has no projects this token can see.", capitalize(LABEL)));
        }
        let mut out = vec![format!("Railway projects in {LABEL} ({}):", list.len())];
        for p in &list {
            let here = if ctx.here.project_id.as_deref() == Some(p.id.as_str()) {
                " (Tarsee runs here)"
            } else {
                ""
            };
            out.push(format!("- {} (id {}){here}", p.name, p.id));
        }
        out.push("Pass project (a name or an id) to see its environments and services.".to_string());
        return Ok(out.join("\n"));
    }
    let project = resolve_project(ctx, note).await?;
    let envs: Vec<String> = project
        .environments
        .iter()
        .map(|e| {
            let here = project.is_here && ctx.here.environment_id.as_deref() == Some(e.id.as_str());
            format!(
                "- {} (id {}){}",
                e.name,
                e.id,
                if here { " (Tarsee runs here)" } else { "" }
            )
        })
        .collect();
    let svcs: Vec<String> = project
        .services
        .iter()
        .map(|s| {
            let here = project.is_here && ctx.here.service_id.as_deref() == Some(s.id.as_str());
            format!(
                "- {} (id {}){}",
                s.name,
                s.id,
                if here { " (Tarsee itself)" } else { "" }
            )
        })
        .collect();
    let mut out = vec![
        format!("Project \"{}\" (id {}) in {LABEL}:", project.name, project.id),
        format!("Environments ({}):", envs.len()),
    ];
    if envs.is_empty() {
        out.push("  none".to_string());
    }
    out.extend(envs.iter().cloned());
    out.push(format!("Services ({}):", svcs.len()));
    if svcs.is_empty() {
        out.push("  none".to_string());
    }
    out.extend(svcs.iter().cloned());
    Ok(out.join("\n"))
}

/// `s.charAt(0).toUpperCase() + s.slice(1)`.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

// ---------------------------------------------------------------- list_variables

async fn list_variables(ctx: &Ctx<'_>, note: &mut Note) -> Step<String> {
    let project = resolve_project(ctx, note).await?;
    let env = resolve_env(ctx, &project, note)?;
    let svc = resolve_service(ctx, &project, note)?;
    let vars = variable_names(ctx, &project, &env).await?;
    let mut mine: Vec<&VariableName> = vars
        .iter()
        .filter(|x| x.service_id.as_deref() == Some(svc.id.as_str()))
        .collect();
    mine.sort_by(|a, b| locale_compare(&a.name, &b.name));
    let mut shared: Vec<&VariableName> = vars.iter().filter(|x| x.service_id.is_none()).collect();
    shared.sort_by(|a, b| locale_compare(&a.name, &b.name));
    let line = |x: &&VariableName| format!("- {}{}", x.name, if x.sealed { " (sealed)" } else { "" });
    let mut out = vec![format!(
        "Variables on {}: {} names. Values are never shown.",
        where_of(&svc, &env, &project),
        mine.len()
    )];
    if mine.is_empty() {
        out.push("  none".to_string());
    }
    out.extend(mine.iter().map(line));
    out.push(if shared.is_empty() {
        format!("Shared variables in {}: none", env.name)
    } else {
        format!("Shared variables in {} (any service can reference them):", env.name)
    });
    out.extend(shared.iter().map(line));
    Ok(out.join("\n"))
}

// ---------------------------------------------------------------- set_variable

async fn set_variable(ctx: &Ctx<'_>, note: &mut Note) -> Step<String> {
    let args = ctx.args;
    let name = js_trim(&js_string_or_empty(args.get("name"))).to_string();
    if name.is_empty() {
        return fail("name is required: the variable's name, e.g. ALERTS_WEBHOOK_URL.");
    }
    if !VAR_NAME.is_match(&name) {
        return fail(format!(
            "name \"{name}\" is not a usable variable name: letters, digits and underscores, not starting with a digit."
        ));
    }
    note.extra.push(format!("name={name}"));

    let from_key = args.get("from_key").filter(|v| !v.is_null());
    let has_key = from_key.is_some_and(|k| !js_trim(&js_string(k)).is_empty());
    let value_arg = args.get("value").filter(|v| !v.is_null());
    let has_value = value_arg.is_some();
    if has_key == has_value {
        return fail(if has_key {
            "Pass the value one way only: from_key (a vault key name, for anything secret) or value (plain, non-secret text), not both."
        } else {
            "Pass the value: from_key (the vault key that holds it, for anything secret) or value (plain, non-secret text only)."
        });
    }

    let (value, shown) = if let Some(key) = from_key.filter(|_| has_key) {
        let key_name = js_trim(&js_string(key)).to_string();
        let upper = key_name.to_uppercase();
        let read = match ctx.vault.get_key(&key_name) {
            Ok(None) if key_name != upper => ctx.vault.get_key(&upper),
            other => other,
        };
        let raw = match read {
            Ok(raw) => raw,
            Err(err) => return fail(format!("The vault key {key_name} could not be read ({err}).")),
        };
        let Some(value) = raw else {
            return fail(format!(
                "The vault has no key named {key_name}. tarsee_list_keys lists the names."
            ));
        };
        if value.is_empty() {
            return fail(format!(
                "The vault key {key_name} is empty, so there is nothing to set."
            ));
        }
        note.secrets.push(value.clone());
        note.extra.push(format!("from_key={key_name}"));
        let shown = format!(
            "from the vault key {key_name} (masked: {}). The value was not shown anywhere.",
            mask_value(&value)
        );
        (value, shown)
    } else {
        let value = value_arg.map(js_string).unwrap_or_default();
        if let Some(key) = vault_key_holding(ctx.vault, &value) {
            return fail(format!(
                "That value is the vault key {key}. Pass from_key: \"{key}\" instead, so the value never goes through a chat or a command."
            ));
        }
        let trimmed = js_trim(&value);
        if let Some((_, what)) = SECRET_SHAPES.iter().find(|(re, _)| re.is_match(trimmed)) {
            return fail(format!(
                "value looks like a secret ({what}). Save it in the vault with tarsee_set_key and pass from_key with that key name instead, so it never goes through a chat or a command."
            ));
        }
        note.extra.push("value=plain".to_string());
        let quoted = if utf16_len(&value) > 200 {
            format!("{}...", js_slice_shown(&value, 0, 200))
        } else {
            value.clone()
        };
        (value, format!("\"{quoted}\" (plain value)"))
    };
    let deploy = args.get("deploy") != Some(&Value::Bool(false));
    note.extra.push(format!("deploy={}", if deploy { "yes" } else { "no" }));

    let project = resolve_project(ctx, note).await?;
    let env = resolve_env(ctx, &project, note)?;
    let svc = resolve_service(ctx, &project, note)?;
    let names = variable_names(ctx, &project, &env).await?;
    let before = names
        .iter()
        .find(|x| x.service_id.as_deref() == Some(svc.id.as_str()) && x.name == name);

    let mut variables = serde_json::Map::new();
    variables.insert(name.clone(), Value::String(value));
    let upserted = ctx
        .api(
            DOCS.upsert,
            json!({
                "projectId": project.id,
                "environmentId": env.id,
                "serviceId": svc.id,
                "variables": variables,
                "skipDeploys": !deploy,
            }),
        )
        .await;
    let ok = match upserted {
        Ok(data) => data.get("variableCollectionUpsert").cloned(),
        Err(err) if err.kind == ApiKind::Network => {
            note.outcome_unknown = true;
            return fail(format!(
                "Railway's API stopped answering while the variable was being set ({}), so it is not known whether {name} was set. Check with list_variables before trying again.",
                err.message
            ));
        }
        Err(err) => return Err(err.into()),
    };
    if ok == Some(Value::Bool(false)) {
        return fail(format!("Railway answered that {name} was not set on {}.", svc.name));
    }
    let mut out = vec![
        format!("Set {name} on {}.", where_of(&svc, &env, &project)),
        format!("value: {shown}"),
        match before {
            Some(before) => format!(
                "It replaced the value {name} had{}.",
                if before.sealed { " (it was sealed)" } else { "" }
            ),
            None => format!("{name} is a new variable on {}.", svc.name),
        },
        if deploy {
            format!(
                "deploy: yes. Railway redeploys {} in {} with it, as it does on any variable change.",
                svc.name, env.name
            )
        } else {
            format!(
                "deploy: no (deploy: false). {} keeps the old value until its next deploy; redeploy starts one.",
                svc.name
            )
        },
    ];
    if deploy && is_self(&svc, &env, &ctx.here) {
        out.push(SELF_RESTART.to_string());
    }
    Ok(out.join("\n"))
}

/// The vault key whose value is exactly this one, if any (only to point at from_key; nothing is shown).
fn vault_key_holding(vault: &dyn RailwayVault, value: &str) -> Option<String> {
    if value.is_empty() || utf16_len(value) < 8 {
        return None;
    }
    // A vault that cannot be read whole is no reason to refuse.
    let entries = vault.get_all_keys_decrypted()?.ok()?;
    entries
        .into_iter()
        .find(|(_, val)| val.as_deref() == Some(value))
        .map(|(key, _)| key)
}

// ---------------------------------------------------------------- redeploy

async fn redeploy(ctx: &Ctx<'_>, note: &mut Note) -> Step<String> {
    let project = resolve_project(ctx, note).await?;
    let env = resolve_env(ctx, &project, note)?;
    let svc = resolve_service(ctx, &project, note)?;
    let data = ctx
        .api(
            DOCS.latest_deployment,
            json!({ "input": { "environmentId": env.id, "serviceId": svc.id } }),
        )
        .await?;
    let Some(latest) = nodes(data.get("deployments")).into_iter().next() else {
        return fail(format!(
            "{} has no deployment in {} yet, so there is nothing to redeploy. Its first deploy comes from Railway (a push to its repo, or the dashboard's Deploy button).",
            svc.name, env.name
        ));
    };
    let mut variables = serde_json::Map::new();
    if let Some(id) = latest.get("id") {
        variables.insert("id".into(), id.clone());
    }
    let fresh = match ctx.api(DOCS.redeploy, Value::Object(variables)).await {
        Ok(data) => data.get("deploymentRedeploy").cloned(),
        Err(err) if err.kind == ApiKind::Network => {
            note.outcome_unknown = true;
            return fail(format!(
                "Railway's API stopped answering while the redeploy was being asked for ({}), so it is not known whether one started. Check the service's deployments in Railway before trying again.",
                err.message
            ));
        }
        Err(err) => return Err(err.into()),
    };
    let latest_id = js_template(latest.get("id"));
    note.extra.push(format!("from_deployment={latest_id}"));
    let status = match latest.get("status").filter(|s| truthy(s)) {
        Some(status) => js_string(status).to_lowercase(),
        None => "status unknown".to_string(),
    };
    let made = match latest.get("createdAt").filter(|c| truthy(c)) {
        Some(at) => format!(", made {}", js_string(at)),
        None => String::new(),
    };
    let mut out = vec![
        format!("Asked Railway to redeploy {}.", where_of(&svc, &env, &project)),
        format!(
            "It redeploys the latest deployment {latest_id} ({status}{made}), with the service's current variables."
        ),
    ];
    if let Some(id) = fresh.as_ref().and_then(|f| f.get("id")).filter(|id| truthy(id)) {
        out.push(format!("new deployment id: {}", js_string(id)));
    }
    if is_self(&svc, &env, &ctx.here) {
        out.push(SELF_RESTART.to_string());
    }
    Ok(out.join("\n"))
}

// ---------------------------------------------------------------- String.prototype.localeCompare

mod collation;
use collation::locale_compare;

#[cfg(test)]
mod tests;
