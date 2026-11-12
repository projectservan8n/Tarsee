//! Port of `src/ai/mcp-http.js`: Tarsee's own tools for the engines, on a loopback MCP endpoint (design 4.9, rule
//! R12).
//!
//! The Node version gave Claude Code Tarsee's tools as an in-process MCP server and served the very same tools to
//! Codex, which runs as a child process and can only reach an MCP server it starts itself or one over HTTP, on a
//! loopback endpoint. Here there is no in-process server: both engines' programs are children, and both reach
//! Tarsee's tools (`ai/tarsee_mcp.rs`, so the same `execute_tool` path, Tool Permissions, SSRF checks and audit
//! log) over streamable HTTP, from inside the main process:
//!
//!   - its own http server on 127.0.0.1, on a port the system picks, started on first use. It is never mounted on
//!     the main router, so Railway's proxy can't reach it and the dashboard's login and CSRF don't apply;
//!   - each turn gets a grant ([`grant_turn`]): a fresh 32-byte bearer token tied to that turn's tool context. The
//!     engine's program reads it from TARSEE_MCP_TOKEN, which is not in its shell's environment (R7), though on
//!     Linux the shell can still read it from the program's /proc environ: the grant lasts one turn and is revoked
//!     when the turn ends, and Tool Permissions still apply to every call made with it;
//!   - every request must come from this machine, name this endpoint in its Host header (no DNS rebinding), carry
//!     no web page's Origin, and carry a live grant's token (compared in constant time); the body is capped at
//!     4 MB, and only POST /mcp is served (stateless: each request is answered on its own);
//!   - a tool result too long for the model's context (TARSEE_TOOL_RESULT_MAX_CHARS, default 12,000 characters, the
//!     same limit Claude Code applies) is saved to STATE_DIR/tool-output/<turn>/, outside the workspace and the
//!     files screen, and the model gets the path and the start of it. Those files are pruned after 7 days;
//!   - a grant ends when the turn revokes it or lets go of it (dropping a [`Grant`] revokes it), when the turn's
//!     stop signal fires, or when it expires (a backstop for a turn that never got to its end).
//!
//! Logging is quiet: one line when it starts listening, refusals at most once a minute per kind, never a token.
//!
//! What the MCP SDK's streamable-HTTP transport did for the Node version (the Accept and Content-Type checks, the
//! reading of JSON-RPC messages, batches, the 202 for a POST that asks nothing) is written out here; what its
//! server did (the answers themselves) is `ai/tarsee_mcp/protocol.rs`. Every answer was compared with the Node
//! endpoint's (`mcp_http/node-endpoint.json`).

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, OnceLock, Weak};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{
    ACCEPT, ALLOW, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HOST as HOST_HEADER, HeaderName, ORIGIN,
    WWW_AUTHENTICATE,
};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::serve::{IncomingStream, Listener};
use base64::Engine as _;
use futures::FutureExt;
use http_body_util::BodyExt;
use parking_lot::Mutex;
use rand::Rng;
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::ai::context_limits::{DEFAULT_TOOL_RESULT_MAX_CHARS, JS_SPACE_CLASS, js_number, js_round};
use crate::ai::engine::McpGrant;
use crate::ai::tarsee_mcp::protocol::{
    self, Message, SUPPORTED_PROTOCOL_VERSIONS, Step, is_initialize_message, parse_message, result_response,
};
use crate::ai::tarsee_mcp::{CreateOptions, SERVER_NAME, TarseeMcp, create_tarsee_mcp};
use crate::app::{App, WeakApp};
use crate::config::env::create_private_dir;
use crate::env::Env;
use crate::lib::safe_path::fs_error_message;
use crate::lib::tool_api::ToolContext;
use crate::lib::tool_steps::parse_json_lossy;
use crate::middleware::auth::node_header;
use crate::util::js::{now_ms, trim as js_trim, utf16_len, utf16_truncate};
use crate::util::node_path;

/// Largest request body accepted (R12).
pub const MCP_BODY_LIMIT: usize = 4 * 1024 * 1024;

/// How long a spilled tool result is kept.
pub const TOOL_OUTPUT_KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// How long a grant lives when the turn names no limit of its own. A backstop only: the turn revokes its grant when
/// it ends, and its stop signal revokes it too. Interactive turns have no fixed length (only an idle abort), so
/// this is generous; a turn with a timeout passes it as `ttl`.
pub const DEFAULT_GRANT_TTL_MS: i64 = 6 * 60 * 60 * 1000;

/// The environment variable an engine's program reads its turn's token from (Codex: `bearer_token_env_var`; Claude
/// Code: `${TARSEE_MCP_TOKEN}` in the server's headers).
pub const MCP_TOKEN_ENV: &str = "TARSEE_MCP_TOKEN";

const HOST: &str = "127.0.0.1";
const MCP_PATH: &str = "/mcp";
const PRUNE_EVERY: Duration = Duration::from_millis(12 * 60 * 60 * 1000);
const PREVIEW_CHARS: usize = 2000;
/// The most messages one POST may hold (the SDK transport's own limit).
const MAX_BATCH_SIZE: usize = 100;

/// The endpoint while it listens.
struct Running {
    port: u16,
    url: String,
    state_dir: PathBuf,
    /// Cancelled to stop accepting and let the connections end.
    shutdown: CancellationToken,
    prune_timer: JoinHandle<()>,
    /// Resolves once the listening socket is closed.
    closed: Option<oneshot::Receiver<()>>,
}

/// A live grant: {tokenHash, ctx, turnDir, expiresAt, seq}.
struct GrantEntry {
    token_hash: [u8; 32],
    ctx: ToolContext,
    turn_dir: String,
    expires_at: i64,
    /// The turn's stop signal: once it has fired the grant is over.
    signal: Option<CancellationToken>,
    /// How many long results this turn has saved.
    seq: AtomicU64,
    /// A long result goes to the model as it is (the engine's program cuts it itself).
    leave_long_results: bool,
    /// The turn's tool server, built at its first request: about once per turn, as on Claude Code, instead of once
    /// per request.
    mcp: OnceLock<Arc<TarseeMcp>>,
}

impl GrantEntry {
    /// Whether the grant still opens anything: it has not expired, and its turn has not been stopped.
    fn live(&self, now: i64) -> bool {
        now < self.expires_at && !self.signal.as_ref().is_some_and(CancellationToken::is_cancelled)
    }
}

#[derive(Default)]
struct Live {
    running: Option<Running>,
    /// Live grants by id.
    grants: HashMap<String, Arc<GrantEntry>>,
    last_warned: HashMap<&'static str, i64>,
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The loopback endpoint of one app: the Node module's `running`, `starting` and `grants`.
pub struct McpHttp {
    app: WeakApp,
    state: Mutex<Live>,
    /// One start or stop at a time, so concurrent first grants share one server.
    starting: tokio::sync::Mutex<()>,
    /// `Date.now()`; a test sets its own to let a grant expire without waiting.
    clock: Mutex<Clock>,
    /// Tests only: every caller is reported as coming from this address (see `report_callers_as`).
    reported_remote: Arc<Mutex<Option<SocketAddr>>>,
}

/// Where the endpoint listens: `{ host, port, url }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointInfo {
    pub host: String,
    pub port: u16,
    pub url: String,
}

/// The options of [`start_mcp_http`].
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    /// Where tool-output/ goes (default: the app's state folder).
    pub state_dir: Option<PathBuf>,
}

/// The options of [`grant_turn`].
#[derive(Debug, Clone, Default)]
pub struct GrantOptions {
    /// Names the folder long results go in (default: the context's `turn_id`, else the grant's own id).
    pub turn_id: Option<String>,
    /// How long the grant may live (default [`DEFAULT_GRANT_TTL_MS`]); pass the turn's timeout when it has one.
    pub ttl: Option<Duration>,
    /// The turn's stop signal: cancelling it revokes the grant.
    pub signal: Option<CancellationToken>,
    /// Leave a long result as it is instead of saving it to a file. The Node version saved long results for Codex
    /// only: Claude Code got its tools in-process and cut long results itself (MAX_MCP_OUTPUT_TOKENS,
    /// `ai/context_limits.rs`). The Claude engine sets this to keep that.
    pub leave_long_results: bool,
}

/// One turn's use of Tarsee's tools: where the endpoint is and the token that opens it, for that turn's tool
/// context only. Dropping it revokes it.
pub struct Grant {
    /// The endpoint: `http://127.0.0.1:<port>/mcp`.
    pub url: String,
    /// The turn's bearer token: 32 random bytes in base64url. Never log it.
    pub token: String,
    /// When the grant stops working by itself, in milliseconds since 1970.
    pub expires_at: i64,
    id: String,
    service: Weak<McpHttp>,
}

impl Grant {
    /// Ends the grant: its token opens nothing from now on. Twice is harmless.
    pub fn revoke(&self) {
        if let Some(service) = self.service.upgrade() {
            service.state.lock().grants.remove(&self.id);
        }
    }

    /// `{ url, token }`, as the turn layer hands it to an engine (`EngineOptions::mcp_grant`).
    pub fn mcp_grant(&self) -> McpGrant {
        McpGrant {
            url: self.url.clone(),
            token: self.token.clone(),
        }
    }

    /// The `Authorization` header a request must carry: `Bearer <token>`.
    pub fn authorization(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// The variable to add to the engine program's environment so it can read the token: `(TARSEE_MCP_TOKEN,
    /// <token>)`.
    pub fn token_env(&self) -> (&'static str, &str) {
        (MCP_TOKEN_ENV, &self.token)
    }

    /// What the `claude` program takes as `--mcp-config` to reach Tarsee's tools as the server "tarsee" (so the
    /// model sees `mcp__tarsee__<tool>`). The token is not in it: the program reads it from TARSEE_MCP_TOKEN in its
    /// own environment ([`token_env`](Self::token_env)), so it is never on a command line.
    pub fn claude_mcp_config(&self) -> Value {
        claude_mcp_config(&self.url)
    }
}

/// [`Grant::claude_mcp_config`] for an endpoint address.
pub fn claude_mcp_config(url: &str) -> Value {
    json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer ${{{MCP_TOKEN_ENV}}}") },
            }
        }
    })
}

impl From<&Grant> for McpGrant {
    fn from(grant: &Grant) -> Self {
        grant.mcp_grant()
    }
}

/// What `providers/codex_options.rs` takes as the turn's grant (`CodexContext::mcp`): it writes the url into Codex's
/// `mcp_servers.tarsee` with `bearer_token_env_var = "TARSEE_MCP_TOKEN"`, and puts the token in Codex's environment
/// under that name.
impl From<&Grant> for crate::ai::providers::codex_options::McpGrant {
    fn from(grant: &Grant) -> Self {
        crate::ai::providers::codex_options::McpGrant {
            url: grant.url.clone(),
            token: grant.token.clone(),
        }
    }
}

impl Drop for Grant {
    fn drop(&mut self) {
        self.revoke();
    }
}

impl std::fmt::Debug for Grant {
    /// Without the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grant")
            .field("url", &self.url)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// Most characters of one tool result the model gets inline; past it the result goes to a file. Same rule as
/// `context_limits::mcp_output_env`: TARSEE_TOOL_RESULT_MAX_CHARS when it is at least 1,000, else 12,000.
pub fn spill_threshold(env: &Env) -> usize {
    let own = env
        .get("TARSEE_TOOL_RESULT_MAX_CHARS")
        .map_or(f64::NAN, |v| js_number(&v));
    if own.is_finite() && own >= 1000.0 {
        // (A float past what a usize holds becomes the largest usize.)
        js_round(own) as usize
    } else {
        DEFAULT_TOOL_RESULT_MAX_CHARS as usize
    }
}

/// True only for this machine's own addresses (127.0.0.0/8, ::1, and their IPv4-mapped form).
pub fn is_loopback_address(addr: &str) -> bool {
    if addr.is_empty() {
        return false;
    }
    let lower = js_trim(addr).to_lowercase();
    let a = lower.strip_prefix("::ffff:").unwrap_or(&lower);
    if a == "::1" {
        return true;
    }
    a.parse::<Ipv4Addr>().is_ok() && a.starts_with("127.")
}

impl McpHttp {
    /// The app's endpoint service, made on first use. Nothing listens until [`start_mcp_http`] or a first
    /// [`grant_turn`].
    pub fn of(app: &App) -> Arc<McpHttp> {
        app.get_or_init(|| McpHttp {
            app: app.downgrade(),
            state: Mutex::new(Live::default()),
            starting: tokio::sync::Mutex::new(()),
            clock: Mutex::new(Arc::new(now_ms)),
            reported_remote: Arc::default(),
        })
    }

    fn now(&self) -> i64 {
        let clock = self.clock.lock().clone();
        clock()
    }

    /// Tests only: the clock grants expire by and refusals are logged by (`Date.now()` in the Node version).
    pub fn set_clock(&self, clock: impl Fn() -> i64 + Send + Sync + 'static) {
        *self.clock.lock() = Arc::new(clock);
    }

    /// Tests only: report every new connection as coming from `remote` (`None`: from where it really comes). The
    /// endpoint only listens on 127.0.0.1, so a caller from another machine can't be produced for real; the Node
    /// test made the socket report another address the same way.
    pub fn report_callers_as(&self, remote: Option<SocketAddr>) {
        *self.reported_remote.lock() = remote;
    }

    fn endpoint_info(&self) -> Option<EndpointInfo> {
        let state = self.state.lock();
        let running = state.running.as_ref()?;
        Some(EndpointInfo {
            host: HOST.to_string(),
            port: running.port,
            url: running.url.clone(),
        })
    }

    /// Where the endpoint listens, when it does.
    pub fn endpoint(&self) -> Option<EndpointInfo> {
        self.endpoint_info()
    }

    /// See [`start_mcp_http`].
    pub async fn start(self: &Arc<Self>, opts: StartOptions) -> anyhow::Result<EndpointInfo> {
        if let Some(info) = self.endpoint_info() {
            return Ok(info);
        }
        let _one_at_a_time = self.starting.lock().await;
        if let Some(info) = self.endpoint_info() {
            return Ok(info);
        }
        let Some(app) = self.app.upgrade() else {
            anyhow::bail!("Tarsee is shutting down");
        };
        let state_dir = opts.state_dir.unwrap_or_else(|| app.config().state_dir.clone());
        if state_dir.as_os_str().is_empty() {
            anyhow::bail!("startMcpHttp needs a state folder for long tool results");
        }
        let listener = TcpListener::bind((HOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let shutdown = CancellationToken::new();
        let (closed_tx, closed_rx) = oneshot::channel();
        let listener = LoopbackListener {
            inner: listener,
            service: Arc::downgrade(self),
            reported_remote: self.reported_remote.clone(),
            _closed: closed_tx,
        };
        let router = Router::new().fallback(handle).with_state(self.app.clone());
        let stop = shutdown.clone();
        tokio::spawn(async move {
            let served = axum::serve(listener, router.into_make_service_with_connect_info::<Remote>())
                .with_graceful_shutdown(stop.cancelled_owned())
                .await;
            if let Err(err) = served {
                log::warn!("[mcp-http] server error: {err}");
            }
        });
        let prune_dir = state_dir.clone();
        let prune_timer = tokio::spawn(async move {
            // (The first tick is at once: what the Node version did with setImmediate.)
            let mut every = tokio::time::interval(PRUNE_EVERY);
            loop {
                every.tick().await;
                let dir = prune_dir.clone();
                let _ = tokio::task::spawn_blocking(move || safe_prune(&dir)).await;
            }
        });
        let info = EndpointInfo {
            host: HOST.to_string(),
            port,
            url: format!("http://{HOST}:{port}{MCP_PATH}"),
        };
        self.state.lock().running = Some(Running {
            port,
            url: info.url.clone(),
            state_dir,
            shutdown,
            prune_timer,
            closed: Some(closed_rx),
        });
        log::info!("[mcp-http] Tarsee's tools for Codex listening on {HOST}:{port}");
        Ok(info)
    }

    /// See [`stop_mcp_http`].
    pub async fn stop(&self) {
        let _one_at_a_time = self.starting.lock().await;
        let closed = {
            let mut state = self.state.lock();
            let current = state.running.take();
            state.grants.clear();
            let Some(mut current) = current else {
                return;
            };
            current.prune_timer.abort();
            current.shutdown.cancel();
            current.closed.take()
        };
        // The port is free once the listening socket is closed; requests in flight are left to end.
        if let Some(closed) = closed {
            let _ = closed.await;
        }
    }

    /// See [`grant_turn`].
    pub async fn grant(self: &Arc<Self>, ctx: ToolContext, opts: GrantOptions) -> anyhow::Result<Grant> {
        let ttl_ms = match opts.ttl {
            None => DEFAULT_GRANT_TTL_MS,
            Some(ttl) => i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX),
        };
        if ttl_ms <= 0 {
            anyhow::bail!("grantTurn: ttlMs must be a positive number of milliseconds");
        }
        let info = self.start(StartOptions::default()).await?;

        let mut id_bytes = [0u8; 8];
        rand::rng().fill_bytes(&mut id_bytes);
        let id = hex::encode(id_bytes);
        let mut token_bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut token_bytes);
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
        let named = opts.turn_id.as_deref().or(ctx.turn_id.as_deref());
        let turn_dir = named
            .map(safe_name)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("grant-{id}"));
        let expires_at = self.now().saturating_add(ttl_ms);
        let entry = Arc::new(GrantEntry {
            token_hash: hash_token(&token),
            ctx,
            turn_dir,
            expires_at,
            signal: opts.signal,
            seq: AtomicU64::new(0),
            leave_long_results: opts.leave_long_results,
            mcp: OnceLock::new(),
        });

        let grant = Grant {
            url: info.url,
            token,
            expires_at,
            id: id.clone(),
            service: Arc::downgrade(self),
        };
        // (A grant for a turn already stopped never works: the stop signal is looked at with every request, so the
        // grant is over the moment the signal fires.)
        // The endpoint may have been stopped while this was starting it: a grant made now would outlive the stop, so
        // it is only kept while the endpoint is the one it points at.
        let mut state = self.state.lock();
        if state.running.as_ref().is_some_and(|running| running.url == grant.url) {
            state.grants.insert(id, entry);
        }
        drop(state);
        Ok(grant)
    }

    /// See [`grant_count`].
    pub fn grant_count(&self) -> usize {
        let now = self.now();
        let mut state = self.state.lock();
        state.grants.retain(|_, grant| grant.live(now));
        state.grants.len()
    }

    /// The live grant whose token the Authorization header carries, or `None`. Expired grants, and those of turns
    /// that were stopped, are dropped on the way.
    fn grant_for(&self, authorization: Option<&str>) -> Option<Arc<GrantEntry>> {
        let matched = BEARER.captures(authorization.unwrap_or_default());
        let presented = hash_token(
            matched
                .as_ref()
                .map_or("", |found| found.get(1).map_or("", |m| m.as_str())),
        );
        let now = self.now();
        let mut found = None;
        let mut state = self.state.lock();
        state.grants.retain(|_, grant| grant.live(now));
        for grant in state.grants.values() {
            // Every live grant is compared, in constant time, so the timing says nothing about which or how close.
            if timing_safe_equal(&presented, &grant.token_hash) && matched.is_some() {
                found = Some(grant.clone());
            }
        }
        found
    }

    /// The port the endpoint listens on, when it does.
    fn port(&self) -> Option<u16> {
        self.state.lock().running.as_ref().map(|running| running.port)
    }

    fn state_dir(&self, app: &App) -> PathBuf {
        let running = self
            .state
            .lock()
            .running
            .as_ref()
            .map(|running| running.state_dir.clone());
        running.unwrap_or_else(|| app.config().state_dir.clone())
    }

    /// A refusal's log line, at most once a minute per kind.
    fn warn_once(&self, kind: &'static str, text: &str) {
        let now = self.now();
        {
            let mut state = self.state.lock();
            if now - state.last_warned.get(kind).copied().unwrap_or(0) < 60_000 {
                return;
            }
            state.last_warned.insert(kind, now);
        }
        log::warn!("[mcp-http] {text}");
    }
}

impl Drop for McpHttp {
    /// The app is gone: nothing may keep listening for it.
    fn drop(&mut self) {
        if let Some(running) = self.state.get_mut().running.take() {
            running.prune_timer.abort();
            running.shutdown.cancel();
        }
    }
}

/// Start the endpoint (once; later calls return the same one). Gives `{ host, port, url }`.
/// `opts.state_dir`: where tool-output/ goes (default: the app's state folder).
pub async fn start_mcp_http(app: &App, opts: StartOptions) -> anyhow::Result<EndpointInfo> {
    McpHttp::of(app).start(opts).await
}

/// Stop the endpoint and end every grant (shutdown, tests).
pub async fn stop_mcp_http(app: &App) {
    if let Some(service) = app.get::<McpHttp>() {
        service.stop().await;
    }
}

/// Grant one turn the use of Tarsee's tools: where the endpoint is, the token that opens it for this turn, and what
/// to hand the engine's program ([`Grant`]). The token goes to the program as TARSEE_MCP_TOKEN and the url as the
/// "tarsee" MCP server's url.
///
/// `ctx` is the turn's tool context (the conversation, the message it answers, ...), exactly what the tools get.
/// `opts`:
///   `turn_id`  names the folder long results go in (default `ctx.turn_id`, else the grant's own id)
///   `ttl`      how long the grant may live (default [`DEFAULT_GRANT_TTL_MS`]); pass the turn's timeout when it has
///              one
///   `signal`   the turn's stop signal: cancelling it revokes the grant
///
/// The grant ends when it is revoked or dropped, so hold it for as long as the turn runs. Before the endpoint is
/// listening (the first turn after boot, when nothing called [`start_mcp_http`]) this starts it.
pub async fn grant_turn(app: &App, ctx: ToolContext, opts: GrantOptions) -> anyhow::Result<Grant> {
    McpHttp::of(app).grant(ctx, opts).await
}

/// The design's name for [`grant_turn`] (section 4.9).
pub async fn grant_mcp(app: &App, ctx: ToolContext, opts: GrantOptions) -> anyhow::Result<Grant> {
    grant_turn(app, ctx, opts).await
}

/// How many grants are live (turns holding the tools right now).
pub fn grant_count(app: &App) -> usize {
    app.get::<McpHttp>().map_or(0, |service| service.grant_count())
}

/// The options of [`prune_tool_output`].
#[derive(Debug, Clone)]
pub struct PruneOptions {
    /// The tool-output folder (default: the one under the running endpoint's state folder, else the app's).
    pub dir: Option<PathBuf>,
    pub max_age_ms: i64,
    /// Now, in milliseconds since 1970 (default: now).
    pub now: Option<i64>,
}

impl Default for PruneOptions {
    fn default() -> Self {
        PruneOptions {
            dir: None,
            max_age_ms: TOOL_OUTPUT_KEEP_MS,
            now: None,
        }
    }
}

/// Remove turn folders (and stray files) under the tool-output folder untouched for `max_age_ms`. Returns how many
/// went. A folder's time moves on with every result saved in it, so a folder goes a week after its turn's last
/// long result.
pub fn prune_tool_output(app: &App, opts: PruneOptions) -> usize {
    let root = opts.dir.unwrap_or_else(|| {
        let state_dir = match app.get::<McpHttp>() {
            Some(service) => service.state_dir(app),
            None => app.config().state_dir.clone(),
        };
        node_path::join(&state_dir, "tool-output")
    });
    prune_folder(&root, opts.max_age_ms, opts.now.unwrap_or_else(now_ms))
}

fn prune_folder(root: &Path, max_age_ms: i64, now: i64) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        // (A name on disk is taken as it is written, as Node took it.)
        let full = node_path::to_namespaced(&entry.path());
        // gone already, or busy: next round
        let Ok(found) = std::fs::symlink_metadata(&full) else {
            continue;
        };
        let Ok(modified) = found.modified() else {
            continue;
        };
        let mtime_ms = match modified.duration_since(std::time::UNIX_EPOCH) {
            Ok(since) => since.as_secs_f64() * 1000.0,
            Err(before) => -(before.duration().as_secs_f64() * 1000.0),
        };
        if mtime_ms >= (now as f64) - (max_age_ms as f64) {
            continue;
        }
        let gone = if found.is_dir() {
            std::fs::remove_dir_all(&full)
        } else {
            std::fs::remove_file(&full).or_else(|_| std::fs::remove_dir(&full))
        };
        if gone.is_ok() || !full.exists() {
            removed += 1;
        }
    }
    removed
}

fn safe_prune(state_dir: &Path) {
    // housekeeping never breaks a turn
    prune_folder(
        &node_path::join(state_dir, "tool-output"),
        TOOL_OUTPUT_KEEP_MS,
        now_ms(),
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The listening socket

/// The address a request came from.
#[derive(Debug, Clone, Copy)]
struct Remote(SocketAddr);

/// The endpoint's listening socket. It tells [`McpHttp::stop`] when it is closed, and reports a caller's address.
struct LoopbackListener {
    inner: TcpListener,
    service: Weak<McpHttp>,
    reported_remote: Arc<Mutex<Option<SocketAddr>>>,
    /// Dropped with the socket: the receiving half then knows the port is free.
    _closed: oneshot::Sender<()>,
}

impl Listener for LoopbackListener {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        loop {
            match self.inner.accept().await {
                Ok((stream, remote)) => {
                    let _ = stream.set_nodelay(true);
                    let reported = *self.reported_remote.lock();
                    return (stream, reported.unwrap_or(remote));
                }
                Err(err) => {
                    // A connection that broke while it was being taken is nobody's problem; anything else (out of
                    // file handles) is said once a minute, and the socket is tried again shortly.
                    use std::io::ErrorKind::{ConnectionAborted, ConnectionRefused, ConnectionReset};
                    if matches!(err.kind(), ConnectionRefused | ConnectionAborted | ConnectionReset) {
                        continue;
                    }
                    if let Some(service) = self.service.upgrade() {
                        service.warn_once("server", &format!("server error: {err}"));
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

impl Connected<IncomingStream<'_, LoopbackListener>> for Remote {
    fn connect_info(stream: IncomingStream<'_, LoopbackListener>) -> Self {
        Remote(*stream.remote_addr())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Requests

async fn handle(State(app): State<WeakApp>, ConnectInfo(remote): ConnectInfo<Remote>, request: Request) -> Response {
    let service = app.upgrade().and_then(|app| Some((app.get::<McpHttp>()?, app)));
    let Some((service, app)) = service else {
        return reply(503, "Tarsee's tool endpoint is shutting down.", &[], -32000);
    };
    // Whatever goes wrong inside, the caller gets an answer and the server stays up.
    match std::panic::AssertUnwindSafe(serve_request(&service, &app, remote.0, request))
        .catch_unwind()
        .await
    {
        Ok(response) => response,
        Err(panic) => {
            service.warn_once("internal", &format!("a request failed: {}", panic_text(&panic)));
            reply(500, "Tarsee's tool endpoint failed on this request.", &[], -32000)
        }
    }
}

fn panic_text(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = panic.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = panic.downcast_ref::<String>() {
        text.clone()
    } else {
        "it stopped unexpectedly".to_string()
    }
}

async fn serve_request(service: &Arc<McpHttp>, app: &App, remote: SocketAddr, request: Request) -> Response {
    let Some(port) = service.port() else {
        return reply(503, "Tarsee's tool endpoint is shutting down.", &[], -32000);
    };
    let (parts, body) = request.into_parts();
    let headers = &parts.headers;

    // Only this machine. The server listens on 127.0.0.1 only; this is the second lock.
    if !is_loopback_address(&remote.ip().to_string()) {
        service.warn_once("remote", "refused a caller that is not on this machine");
        return reply(403, "Only this machine may use this endpoint.", &[], -32000);
    }
    // The Host must name this endpoint, so a web page that rebinds its own domain to 127.0.0.1 gets nowhere.
    let host = node_header(headers, &HOST_HEADER).unwrap_or_default().to_lowercase();
    if host != format!("{HOST}:{port}") && host != format!("localhost:{port}") {
        service.warn_once("host", "refused a request for another host (Host header)");
        return reply(403, "Wrong Host for this endpoint.", &[], -32000);
    }
    // An engine's program sends no Origin; a browser does. Nothing in a web page may call this endpoint.
    if let Some(origin) = node_header(headers, &ORIGIN)
        && origin != format!("http://{HOST}:{port}")
        && origin != format!("http://localhost:{port}")
    {
        service.warn_once("origin", "refused a request a web page sent (Origin header)");
        return reply(403, "Web pages may not use this endpoint.", &[], -32000);
    }
    if pathname(&parts.uri.to_string(), port) != MCP_PATH {
        return reply(404, "Not found.", &[], -32000);
    }

    let Some(grant) = service.grant_for(node_header(headers, &AUTHORIZATION).as_deref()) else {
        service.warn_once("token", "refused a request without a live grant's token");
        return reply(
            401,
            "This needs a live grant's token.",
            &[(WWW_AUTHENTICATE, "Bearer realm=\"tarsee\"")],
            -32000,
        );
    };
    if parts.method != Method::POST {
        return reply(405, "Only POST is served here.", &[(ALLOW, "POST")], -32000);
    }

    let text = match read_body(headers, body, MCP_BODY_LIMIT).await {
        BodyRead::Text(text) => text,
        BodyRead::TooLarge => {
            service.warn_once("size", "refused a request body over 4 MB");
            return reply(413, "The request is over 4 MB.", &[], -32000);
        }
        BodyRead::Failed(why) => {
            service.warn_once("internal", &format!("a request failed: {why}"));
            return reply(500, "Tarsee's tool endpoint failed on this request.", &[], -32000);
        }
    };
    // (Half of a surrogate pair written as an escape is left out, as everywhere in the port: lib/tool_steps.rs.)
    let Some(message) = parse_json_lossy(&text) else {
        return reply(400, "Parse error: the body is not JSON.", &[], -32700);
    };
    serve(service, app, headers, &grant, message).await
}

/// `new URL(target, "http://127.0.0.1:<port>").pathname`: the path a request names, as a browser would read it
/// ("" for one that can't be read).
fn pathname(target: &str, port: u16) -> String {
    let target = if target.is_empty() { "/" } else { target };
    url::Url::parse(&format!("http://{HOST}:{port}"))
        .and_then(|base| base.join(target))
        .map(|url| url.path().to_string())
        .unwrap_or_default()
}

/// Run one stateless MCP exchange for the grant's turn: Tarsee's tool server around that turn's context. A turn's
/// requests come one after another (initialize, tools/list, each call), and each is answered on its own.
async fn serve(
    service: &Arc<McpHttp>,
    app: &App,
    headers: &HeaderMap,
    grant: &Arc<GrantEntry>,
    message: Value,
) -> Response {
    // Notifications only (initialized, cancelled): nothing to answer, and in a stateless exchange nothing to act
    // on.
    if only_notifications(&message) {
        return accepted();
    }

    // From here on it is what the SDK's transport did with the request.
    // The client MUST include an Accept header, listing both application/json and text/event-stream as supported
    // content types. (A substring check, as the SDK's.)
    let accept = joined_header(headers, &ACCEPT);
    if !accept
        .as_deref()
        .is_some_and(|accept| accept.contains("application/json") && accept.contains("text/event-stream"))
    {
        return transport_error(
            406,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
    }
    if !is_json_content_type(joined_header(headers, &CONTENT_TYPE).as_deref()) {
        return transport_error(
            415,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
        );
    }
    let raw: Vec<&Value> = match &message {
        Value::Array(list) => list.iter().collect(),
        single => vec![single],
    };
    if message.is_array() && raw.len() > MAX_BATCH_SIZE {
        return transport_error(
            400,
            -32600,
            &format!("Invalid Request: Batch must not exceed {MAX_BATCH_SIZE} messages"),
        );
    }
    let Some(messages) = raw
        .iter()
        .map(|message| parse_message(message))
        .collect::<Option<Vec<Message>>>()
    else {
        return transport_error(400, -32700, "Parse error: Invalid JSON-RPC message");
    };
    if messages.iter().any(is_initialize_message) {
        if messages.len() > 1 {
            return transport_error(
                400,
                -32600,
                "Invalid Request: Only one initialization request is allowed",
            );
        }
    } else if let Some(version) = joined_header(headers, &MCP_PROTOCOL_VERSION)
        && !SUPPORTED_PROTOCOL_VERSIONS.contains(&version.as_str())
    {
        // The Mcp-Protocol-Version header, when a request after initialization carries one, must be a version the
        // server speaks. (Claude Code first asks with a version of the future, and takes this 400 as "an older
        // server": it then initializes the usual way.)
        return transport_error(
            400,
            -32000,
            &format!(
                "Bad Request: Unsupported protocol version: {version} (supported versions: {})",
                SUPPORTED_PROTOCOL_VERSIONS.join(", ")
            ),
        );
    }
    let requests: Vec<&protocol::Request> = messages
        .iter()
        .filter_map(|message| match message {
            Message::Request(request) => Some(request),
            _ => None,
        })
        .collect();
    // If it only contains notifications or responses, return 202.
    if requests.is_empty() {
        return accepted();
    }

    let mcp = grant
        .mcp
        .get_or_init(|| Arc::new(create_tarsee_mcp(app, grant.ctx.clone(), CreateOptions { quiet: true })))
        .clone();
    let calls = tool_calls_in(&raw);

    // Every request of the POST is answered, and the answers go back together once each id has one: a single
    // answer as it is, several as a list in the order their ids first came. (Two requests with one id get one
    // answer between them, whichever was there first, as with the SDK.)
    let mut ids: Vec<&Value> = Vec::new();
    // Answers that need no tool, in the order the SDK had them ready: a method the server does not have is
    // answered as the request is read, the others a moment later.
    let mut at_once = Vec::new();
    let mut soon = Vec::new();
    let (done, mut later) = mpsc::unbounded_channel::<Value>();
    for request in &requests {
        if !ids.contains(&&request.id) {
            ids.push(&request.id);
        }
        match mcp.begin(request) {
            Step::Answer(response) if !protocol::has_method(&request.method) => at_once.push(response),
            Step::Answer(response) => soon.push(response),
            Step::Call { name, arguments } => {
                // The call runs to its end whether or not the caller waits for it: a tool that has begun to send or
                // to write is not stopped half-way because a program hung up (the Node version never stopped one
                // either).
                let (app, mcp, done, id) = (app.clone(), mcp.clone(), done.clone(), request.id.clone());
                tokio::spawn(async move {
                    let call = mcp.call_tool(&app, &name, arguments.as_ref());
                    let result = match std::panic::AssertUnwindSafe(call).catch_unwind().await {
                        Ok(result) => result,
                        Err(panic) => json!({
                            "content": [{ "type": "text", "text": panic_text(&panic) }],
                            "isError": true,
                        }),
                    };
                    let _ = done.send(result_response(&id, result));
                });
            }
        }
    }
    drop(done);

    let mut answers: Vec<Option<Value>> = vec![None; ids.len()];
    let mut ready = at_once.into_iter().chain(soon);
    loop {
        let response = match ready.next() {
            Some(response) => response,
            None => match later.recv().await {
                Some(response) => response,
                None => break,
            },
        };
        let response = spill_if_long(service, app, response, &calls, grant).await;
        if let Some(at) = ids.iter().position(|id| Some(*id) == response.get("id")) {
            answers[at] = Some(response);
        }
        if answers.iter().all(Option::is_some) {
            break;
        }
    }
    let mut answers: Vec<Value> = answers.into_iter().flatten().collect();
    let body = if answers.len() == 1 {
        answers.remove(0).to_string()
    } else {
        Value::Array(answers).to_string()
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap_or_default()
}

static MCP_PROTOCOL_VERSION: HeaderName = HeaderName::from_static("mcp-protocol-version");

/// True when the body holds only JSON-RPC notifications (a method, no id).
fn only_notifications(message: &Value) -> bool {
    let is_notification = |m: &Value| {
        m.as_object().is_some_and(|m| {
            m.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
                && m.get("method").is_some_and(Value::is_string)
                && !m.contains_key("id")
        })
    };
    match message {
        Value::Array(list) => !list.is_empty() && list.iter().all(is_notification),
        single => is_notification(single),
    }
}

/// A header as the SDK's transport read it (a web `Headers` object): every value of that name, joined by ", ".
fn joined_header(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
    let mut values = headers
        .get_all(name)
        .iter()
        .map(|value| value.as_bytes().iter().map(|&byte| byte as char).collect::<String>());
    let first = values.next()?;
    Some(values.fold(first, |joined, value| joined + ", " + &value))
}

/// The parameters of a media type, as the `content-type` package reads them: `; name=value` or `; name="value"`,
/// again and again to the end.
static MEDIA_TYPE_PARAMETERS: LazyLock<regex::bytes::Regex> = LazyLock::new(|| {
    let token = r"[!#$%&'*+.^_`|~0-9A-Za-z-]+";
    let quoted = r#""(?:[\x0b\x20\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\x0b\x20-\xff])*""#;
    regex::bytes::Regex::new(&format!(r"(?-u)^(?:; *{token} *= *(?:{quoted}|{token}) *)*$"))
        .expect("the media type parameters pattern")
});

/// Whether a raw `Content-Type` header value denotes `application/json` (the SDK's `isJsonContentType`).
/// Parameters (for example `charset=utf-8`) are allowed and ignored; a malformed parameter section does not refuse
/// a header whose media type is plainly `application/json`, unless it holds a comma (two headers joined).
fn is_json_content_type(header: Option<&str>) -> bool {
    let Some(header) = header.filter(|header| !header.is_empty()) else {
        return false;
    };
    if header == "application/json" {
        return true;
    }
    let (first, parameters) = match header.find(';') {
        Some(at) => (&header[..at], Some(&header[at..])),
        None => (header, None),
    };
    // The type before the first ";", in any case. (Whatever spelling gives this is a well-formed media type, so
    // only the parameters can be malformed.)
    let essence = js_trim(first).to_lowercase();
    if essence != "application/json" {
        return false;
    }
    // (The header came off the wire as bytes, read as Latin-1: back to bytes for the parameters' pattern.)
    let well_formed = parameters.is_none_or(|parameters| {
        let bytes: Vec<u8> = parameters.chars().map(|c| c as u8).collect();
        MEDIA_TYPE_PARAMETERS.is_match(&bytes)
    });
    // A comma in the parameter tail of a value that can't be read indicates joined duplicate headers: ambiguous.
    well_formed || !header.chars().skip(utf16_len(&essence)).any(|c| c == ',')
}

/// `/^Bearer[ \t]+([^\s]+)[ \t]*$/i`.
static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^(?i-u:Bearer)[ \t]+([^{JS_SPACE_CLASS}]+)[ \t]*$")).expect("the bearer pattern")
});

fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

/// `crypto.timingSafeEqual` for two hashes.
fn timing_safe_equal(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut difference = 0u8;
    for (x, y) in a.iter().zip(b) {
        difference |= x ^ y;
    }
    std::hint::black_box(difference) == 0
}

/// What [`read_body`] read.
enum BodyRead {
    /// The whole body (bytes that are not UTF-8 read as U+FFFD).
    Text(String),
    /// More than the limit.
    TooLarge,
    /// The connection broke while the body was coming.
    Failed(String),
}

/// Read the body up to `limit` bytes. Past it, stop keeping data, let the rest drain (so the caller still gets its
/// answer), and say too large.
async fn read_body(headers: &HeaderMap, mut body: Body, limit: usize) -> BodyRead {
    let drain = |mut body: Body| {
        tokio::spawn(async move { while let Some(Ok(_)) = body.frame().await {} });
        BodyRead::TooLarge
    };
    let declared = node_header(headers, &CONTENT_LENGTH).map_or(f64::NAN, |length| js_number(&length));
    if declared.is_finite() && declared > limit as f64 {
        return drain(body);
    }
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        let next = body.frame().await;
        match next {
            None => break,
            Some(Ok(frame)) => {
                if let Some(chunk) = frame.data_ref() {
                    if bytes.len().saturating_add(chunk.len()) > limit {
                        return drain(body);
                    }
                    bytes.extend_from_slice(chunk);
                }
            }
            Some(Err(err)) => return BodyRead::Failed(err.to_string()),
        }
    }
    BodyRead::Text(String::from_utf8_lossy(&bytes).into_owned())
}

/// A JSON-RPC style error reply (the MCP client reads these), no session, no secrets.
fn reply(status: u16, message: &str, headers: &[(HeaderName, &str)], code: i64) -> Response {
    let body = json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null }).to_string();
    let mut response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header(CACHE_CONTROL, "no-store");
    for (name, value) in headers {
        response = response.header(name, *value);
    }
    response.body(Body::from(body)).unwrap_or_default()
}

/// The SDK transport's own error reply: the same body as [`reply`]'s, with the content type and nothing else.
fn transport_error(status: u16, code: i64, message: &str) -> Response {
    let body = json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null }).to_string();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap_or_default()
}

/// 202, with nothing in it.
fn accepted() -> Response {
    Response::builder()
        .status(StatusCode::ACCEPTED)
        .body(Body::empty())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------------------------
// Long results

/// The tools/call requests in one POST body (one message or a batch): request id -> tool name.
fn tool_calls_in(messages: &[&Value]) -> Vec<(Value, String)> {
    let mut calls: Vec<(Value, String)> = Vec::new();
    for m in messages {
        let Some(m) = m.as_object() else { continue };
        if m.get("method").and_then(Value::as_str) != Some("tools/call") {
            continue;
        }
        let Some(id) = m.get("id").and_then(protocol::normal_id) else {
            continue;
        };
        let name = m
            .get("params")
            .and_then(|params| params.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or("tool")
            .to_string();
        match calls.iter_mut().find(|(known, _)| *known == id) {
            Some(call) => call.1 = name,
            None => calls.push((id, name)),
        }
    }
    calls
}

/// `n.toLocaleString("en-US")` for a count: 12345 is "12,345".
fn with_commas(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// If `msg` answers one of this request's tool calls with more text than the model should take in, save the whole
/// text to a file and answer with its path and the start of it instead. Anything else passes through untouched.
async fn spill_if_long(
    service: &Arc<McpHttp>,
    app: &App,
    mut msg: Value,
    calls: &[(Value, String)],
    grant: &Arc<GrantEntry>,
) -> Value {
    if grant.leave_long_results {
        return msg;
    }
    let Some((_, tool_name)) = calls.iter().find(|(id, _)| Some(id) == msg.get("id")) else {
        return msg;
    };
    let Some(content) = msg
        .get("result")
        .and_then(|result| result.get("content"))
        .and_then(Value::as_array)
    else {
        return msg;
    };
    fn text_of(c: &Value) -> Option<&str> {
        if c.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        c.get("text").and_then(Value::as_str)
    }
    let text = content.iter().filter_map(text_of).collect::<Vec<_>>().join("\n");
    let limit = spill_threshold(app.env());
    let length = utf16_len(&text);
    if length <= limit {
        return msg;
    }

    let rest: Vec<Value> = content.iter().filter(|c| text_of(c).is_none()).cloned().collect();
    let preview_chars = PREVIEW_CHARS.min(limit / 2);
    let preview = utf16_truncate(&text, preview_chars);
    let note = match save_long_result(service, app, grant, tool_name, &text).await {
        Ok(file) => format!(
            "[This result is {} characters, too long to show here, so it was saved in full to {}\n\
             Read the parts you need from that file with the shell (sed -n, head, tail or grep), a part at a time. \
             It is not in the workspace and is deleted after 7 days. The first {} characters:]\n{preview}",
            with_commas(length),
            file.display(),
            with_commas(utf16_len(&preview)),
        ),
        Err(why) => {
            service.warn_once("spill", &format!("could not save a long tool result: {why}"));
            let kept = utf16_truncate(&text, limit.saturating_sub(300));
            format!(
                "{kept}\n[Cut at {} of {} characters; the rest could not be saved to a file ({why}).]",
                with_commas(utf16_len(&kept)),
                with_commas(length),
            )
        }
    };
    let mut content = vec![json!({ "type": "text", "text": note })];
    content.extend(rest);
    if let Some(slot) = msg.get_mut("result").and_then(|result| result.get_mut("content")) {
        *slot = Value::Array(content);
    }
    msg
}

/// Saves a long result under the turn's folder; gives the file's path, or why it could not be saved (in the words
/// Node's `fs` used).
async fn save_long_result(
    service: &Arc<McpHttp>,
    app: &App,
    grant: &Arc<GrantEntry>,
    tool_name: &str,
    text: &str,
) -> Result<PathBuf, String> {
    let state_dir = service.state_dir(app);
    let dir = node_path::join(&node_path::join(&state_dir, "tool-output"), &grant.turn_dir);
    let (grant, text) = (grant.clone(), text.to_string());
    let name = Some(safe_name(tool_name))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "tool".to_string());
    let saving = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        // (The turn's and the tool's names are written as they are, whatever Windows would make of them.)
        create_private_dir(&node_path::to_namespaced(&dir)).map_err(|err| fs_error_message(&err, "mkdir", &dir))?;
        let seq = grant.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut tail = [0u8; 3];
        rand::rng().fill_bytes(&mut tail);
        let file = dir.join(format!("{seq}-{name}-{}.txt", hex::encode(tail)));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let written = options
            .open(node_path::to_namespaced(&file))
            .and_then(|mut opened| std::io::Write::write_all(&mut opened, text.as_bytes()));
        written.map_err(|err| fs_error_message(&err, "open", &file))?;
        Ok(file)
    });
    saving.await.map_err(|err| err.to_string())?
}

/// A folder or file name made of safe characters only (no separators, no dots at the start), at most 80 long.
fn safe_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out.trim_matches('_').chars().take(80).collect()
}
