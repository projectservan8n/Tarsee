//! Port of `src/middleware/auth.js`: who a request comes from (the API token, or a sign-in's cookie), the sign-ins
//! themselves, and the limits on sign-in attempts.
//!
//! The Express middleware are axum middleware functions with the Node names, applied with
//! `axum::middleware::from_fn_with_state(app, session_auth)`: [`session_auth`], [`require_auth`],
//! [`rate_limit_auth`]. What `sessionAuth` put on the request as `req.auth` is the [`Auth`] extension, which a
//! handler takes as an extractor. A route file, which builds its router before there is an `App` to hand to
//! `from_fn_with_state`, uses the extractors instead: [`RequireAuth`] and [`ClientIp`].
//!
//! The module-level state of the Node file lives in the `App`: the sign-ins in a [`SessionStore`], the attempts
//! per address in [`AuthAttempts`]. Both read the time from the app's [`Clock`], and both sweep themselves on a
//! tokio timer, so tests move the time instead of waiting.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::Json;
use axum::extract::{ConnectInfo, FromRef, FromRequestParts, Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, HeaderName, RETRY_AFTER};
use axum::http::request::Parts;
use axum::http::{Extensions, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use parking_lot::{Mutex, RwLock};
use rand::Rng;
use regex::Regex;
use rusqlite::params;
use rusqlite::types::ValueRef;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use crate::app::App;
use crate::db::Db;
use crate::error::ApiError;

// --- The time ---

/// The time as this package reads it (`Date.now()`): the system's, unless a test stored a clock it can move.
///
/// ```ignore
/// let clock = t.app.set(Clock::manual(1_794_472_200_000));   // before anything reads the time
/// clock.advance(60_000);
/// ```
pub struct Clock {
    manual: Option<AtomicI64>,
}

impl Clock {
    /// The system's clock.
    pub fn system() -> Self {
        Clock { manual: None }
    }

    /// A clock that stands at `start_ms` until it is moved.
    pub fn manual(start_ms: i64) -> Self {
        Clock {
            manual: Some(AtomicI64::new(start_ms)),
        }
    }

    /// The app's clock: the one stored in it, else the system's.
    pub fn of(app: &App) -> Arc<Clock> {
        app.get_or_init(Clock::system)
    }

    /// `Date.now()`: milliseconds since the Unix epoch.
    pub fn now_ms(&self) -> i64 {
        match &self.manual {
            Some(now) => now.load(Ordering::SeqCst),
            None => crate::util::js::now_ms(),
        }
    }

    /// Moves a manual clock forward. Panics on the system clock: only a test moves the time.
    pub fn advance(&self, ms: i64) {
        self.manual
            .as_ref()
            .expect("only a manual clock can be moved")
            .fetch_add(ms, Ordering::SeqCst);
    }

    /// Sets a manual clock. Panics on the system clock.
    pub fn set(&self, now_ms: i64) {
        self.manual
            .as_ref()
            .expect("only a manual clock can be set")
            .store(now_ms, Ordering::SeqCst);
    }
}

// --- JavaScript's reading of text ---

/// What JavaScript counts as whitespace (`\s`, and what `trim()` removes), as a regex class.
pub(crate) const JS_WHITESPACE: &str =
    r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `text.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `Number(text)`: 0 for blank text, NaN for text that is not a number, and JavaScript's number forms otherwise
/// ("7", " 7 ", "0.5", "1e2", "0x10", "Infinity").
pub(crate) fn js_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes.iter().find_map(|prefix| text.strip_prefix(prefix)) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut value = 0.0;
            for c in digits.chars() {
                match c.to_digit(radix) {
                    Some(digit) => value = value * f64::from(radix) + f64::from(digit),
                    None => return f64::NAN,
                }
            }
            return value;
        }
    }
    let (sign, body) = match text.as_bytes()[0] {
        b'+' => (1.0, &text[1..]),
        b'-' => (-1.0, &text[1..]),
        _ => (1.0, text),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").expect("the decimal number pattern")
    });
    if !DECIMAL.is_match(body) {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |value| sign * value)
}

/// `(Number(process.env.NAME) || fallback)`: the variable as a number, or the fallback when it is unset, blank,
/// zero or not a number.
pub(crate) fn env_number_or(app: &App, name: &str, fallback: f64) -> f64 {
    let value = app.env().get(name).map_or(f64::NAN, |text| js_number(&text));
    if value.is_nan() || value == 0.0 {
        fallback
    } else {
        value
    }
}

/// The request headers of which Node keeps only the first when one is sent more than once.
const FIRST_ONE_ONLY: [&str; 18] = [
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

/// A request header as Node gave it in `req.headers`: the bytes read as Latin-1, and several headers of one name
/// joined (", " for most, "; " for `cookie`), except those of which Node keeps only the first (`authorization` and
/// `content-type` among them).
pub(crate) fn node_header(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
    let latin1 = |value: &HeaderValue| value.as_bytes().iter().map(|&byte| byte as char).collect::<String>();
    let mut values = headers.get_all(name).iter();
    let first = latin1(values.next()?);
    if FIRST_ONE_ONLY.contains(&name.as_str()) {
        return Some(first);
    }
    let separator = if *name == COOKIE { "; " } else { ", " };
    Some(values.fold(first, |joined, value| joined + separator + &latin1(value)))
}

// --- The client's address ---

static X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");

/// The client's address, as Express's `req.ip` gave it under `app.set("trust proxy", 1)`: the last address in
/// `X-Forwarded-For` (the one the proxy in front of Tarsee wrote; anything before it is the client's own claim),
/// else the address of the connection (`ConnectInfo<SocketAddr>`, there when the server is started with
/// `into_make_service_with_connect_info`), else `None`.
///
/// Behind Railway (and any other reverse proxy) every request arrives from the proxy's address, so the address of
/// the connection was the SAME value for every visitor on earth. The auth rate limiter and the progressive lockout
/// are both keyed on this, which meant one attacker's failed logins locked out the legitimate operator, and five
/// requests a minute was the budget for all users combined. Trusting one proxy hop gives the real client address.
/// Deliberately one hop rather than the whole chain: trusting the whole chain lets a client forge the header and
/// defeat the limiter it is meant to feed.
///
/// Every place the Node code read `req.ip` uses this (or the [`ClientIp`] extractor).
pub fn client_ip(headers: &HeaderMap, extensions: &Extensions) -> Option<String> {
    let forwarded = node_header(headers, &X_FORWARDED_FOR).unwrap_or_default();
    // Split at commas, spaces around each address dropped, empty ones skipped: the `forwarded` package's parse.
    let last_hop = forwarded
        .split(',')
        .rev()
        .map(|address| address.trim_matches(' '))
        .find(|address| !address.is_empty());
    if let Some(address) = last_hop {
        return Some(address.to_string());
    }
    extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| address.ip().to_string())
}

/// `req.ip` as an extractor. See [`client_ip`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientIp(pub Option<String>);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(ClientIp(client_ip(&parts.headers, &parts.extensions)))
    }
}

// --- Who the request comes from ---

/// How a request proved who it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    /// The API token, in `Authorization: Bearer`.
    Bearer,
    /// A sign-in's cookie.
    Session,
}

impl AuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMethod::Bearer => "bearer",
            AuthMethod::Session => "session",
        }
    }
}

/// `req.auth`: what [`session_auth`] found. As JSON it is the JS object: `{ authenticated, method }`, with
/// `sessionId` when the method is "session".
///
/// As an extractor it gives what the middleware stored, or "nobody" when the middleware did not run (the JS
/// `req.auth?.authenticated`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    pub authenticated: bool,
    pub method: Option<AuthMethod>,
    /// The id in the sign-in's cookie, when the method is `Session`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl Auth {
    /// What [`session_auth`] stored in the request's extensions, or "nobody".
    pub fn of(extensions: &Extensions) -> Auth {
        extensions.get::<Auth>().cloned().unwrap_or_default()
    }

    pub fn is_bearer(&self) -> bool {
        self.method == Some(AuthMethod::Bearer)
    }

    pub fn is_session(&self) -> bool {
        self.method == Some(AuthMethod::Session)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Auth {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Auth::of(&parts.extensions))
    }
}

/// Timing-safe comparison of two byte strings of one length.
fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool {
    let mut difference = 0u8;
    for (x, y) in a.iter().zip(b) {
        difference |= x ^ y;
    }
    std::hint::black_box(difference) == 0
}

/// Timing-safe string comparison.
pub(crate) fn safe_compare(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        // Still do a comparison to maintain constant time
        let _ = timing_safe_equal(a, a);
        return false;
    }
    timing_safe_equal(a, b)
}

/// Extracts Bearer token from Authorization header.
fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    let header = node_header(headers, &AUTHORIZATION).unwrap_or_default();
    header.strip_prefix("Bearer ").map(|token| js_trim(token).to_string())
}

/// Extracts session token from cookie.
fn extract_session_token(headers: &HeaderMap) -> Option<String> {
    static SESSION_COOKIE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r"(?:^|;{JS_WHITESPACE}*)tarsee_session=([^;]+)")).expect("the session cookie pattern")
    });
    let cookies = node_header(headers, &COOKIE).unwrap_or_default();
    let found = SESSION_COOKIE.captures(&cookies)?;
    Some(js_trim(&found[1]).to_string())
}

// --- Active sessions ---
// A sign-in's id is the tarsee_session cookie, and only the browser keeps it. Tarsee keeps a hash of it
// (session_key), in the store's map and in the sessions table, and looks a cookie up by its hash. The AI's shell
// runs as the same user and can read tarsee.db, so with the id itself stored there it could act as the signed-in
// owner (a free CSRF token from GET /api/auth/csrf does the rest). A hash read from the database signs nobody in:
// no cookie hashes to it.

/// How a stored sign-in is marked as a hash: an older Tarsee stored the id itself (64 hex characters, no mark).
const HASHED: &str = "sha256:";

/// The sessions table, in the words the Node version created it with (SQLite keeps them in the schema).
const CREATE_SESSIONS_TABLE: &str = "CREATE TABLE IF NOT EXISTS sessions (\n    id TEXT PRIMARY KEY,\n    created_at INTEGER NOT NULL,\n    ip TEXT\n  )";

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// Expired sessions are cleaned up every 30 minutes (memory + disk).
pub const SESSION_SWEEP_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Stale rate-limit entries are cleaned up every 5 minutes.
pub const AUTH_ATTEMPTS_SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// What Tarsee keeps of a sign-in's id: "sha256:" and its SHA-256. The id is 32 random bytes, so a plain hash is
/// enough: there is nothing to guess.
fn session_key(session_id: &str) -> String {
    format!("{HASHED}{}", hex::encode(Sha256::digest(session_id.as_bytes())))
}

/// Runs `sweep` on the service every `period`, first after one `period`, for as long as the service lives
/// (the JS `setInterval(...).unref()`). Housekeeping timers run outside any request.
fn spawn_sweeper<T: Send + Sync + 'static>(
    runtime: &tokio::runtime::Handle,
    service: &Arc<T>,
    period: Duration,
    sweep: fn(&T),
) -> JoinHandle<()> {
    let service = Arc::downgrade(service);
    runtime.spawn(async move {
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            match service.upgrade() {
                Some(service) => sweep(&service),
                None => break,
            }
        }
    })
}

/// Starts the service's sweeper if it is not running and there is a tokio runtime to run it on. Called on every
/// use of the service, so it starts with the first request however early the service itself was made.
fn ensure_sweeper<T: Send + Sync + 'static>(
    slot: &Mutex<Option<JoinHandle<()>>>,
    service: &Arc<T>,
    period: Duration,
    sweep: fn(&T),
) {
    let mut slot = slot.lock();
    if slot.as_ref().is_some_and(|task| !task.is_finished()) {
        return;
    }
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        *slot = Some(spawn_sweeper(&runtime, service, period, sweep));
    }
}

/// The sign-ins that are on: a write-through cache of the `sessions` table.
///
/// Persisted to SQLite (see [`SessionStore::init`]): the in-memory map is hydrated from disk on boot, so a restart
/// or a Railway deploy no longer logs the whole team out. Railway REPLACES the container on every deploy, so
/// without this every deploy signed everyone out.
pub struct SessionStore {
    /// `session_key(id)` to when the sign-in was made, in ms. (The JS kept the address beside it and never read it
    /// back; it is in the table.)
    sessions: Mutex<HashMap<String, i64>>,
    /// `None` until [`SessionStore::init`]: sign-ins are then kept in memory only.
    db: RwLock<Option<Db>>,
    /// Session lifetime in ms. Override with TARSEE_SESSION_MAX_AGE_DAYS.
    max_age_ms: f64,
    clock: Arc<Clock>,
    sweeper: Mutex<Option<JoinHandle<()>>>,
}

impl SessionStore {
    fn new(app: &App) -> SessionStore {
        SessionStore {
            sessions: Mutex::new(HashMap::new()),
            db: RwLock::new(None),
            max_age_ms: env_number_or(app, "TARSEE_SESSION_MAX_AGE_DAYS", 30.0) * DAY_MS,
            clock: Clock::of(app),
            sweeper: Mutex::new(None),
        }
    }

    /// The app's session store, made on first use. Until [`SessionStore::init`] it keeps sign-ins in memory only.
    pub fn of(app: &App) -> Arc<SessionStore> {
        let store = app.get_or_init(|| SessionStore::new(app));
        ensure_sweeper(&store.sweeper, &store, SESSION_SWEEP_INTERVAL, SessionStore::sweep);
        store
    }

    /// Wire the sessions cache to SQLite (the JS `initSessionStore(db)`). Creates the table, drops expired rows,
    /// hashes any id an older Tarsee stored as it was (its owner stays signed in: their cookie hashes to the new
    /// row), and hydrates surviving sessions so logins persist across restarts. Called once at boot, right after
    /// the database is opened and before any route that requires a sign-in.
    pub fn init(app: &App) -> anyhow::Result<Arc<SessionStore>> {
        let store = SessionStore::of(app);
        let db = app.db().clone();
        *store.db.write() = Some(db.clone());
        db.with(|conn| conn.execute_batch(CREATE_SESSIONS_TABLE))?;

        let cutoff = store.clock.now_ms() as f64 - store.max_age_ms;
        let _ = db.with(|conn| conn.execute("DELETE FROM sessions WHERE created_at < ?", [cutoff]));
        match hash_stored_ids(&db) {
            Ok(0) => {}
            Ok(hashed) => log::info!(
                "[auth] {hashed} sign-in(s) were stored as their ids; now only a hash of each is kept, and they stay signed in"
            ),
            Err(err) => log::error!("[auth] could not hash the stored sign-ins: {err}"),
        }

        let rows = db
            .with(|conn| -> rusqlite::Result<Vec<(String, i64)>> {
                let mut stmt = conn.prepare(&format!(
                    "SELECT id, created_at FROM sessions WHERE id LIKE '{HASHED}%'"
                ))?;
                let mut rows = stmt.query([])?;
                let mut found = Vec::new();
                while let Some(row) = rows.next()? {
                    let created_at = match row.get_ref(1)? {
                        ValueRef::Integer(ms) => ms,
                        ValueRef::Real(ms) => ms as i64,
                        _ => continue,
                    };
                    found.push((row.get(0)?, created_at));
                }
                Ok(found)
            })
            .unwrap_or_default();
        let restored = rows.len();
        {
            let mut sessions = store.sessions.lock();
            sessions.clear();
            sessions.extend(rows);
        }
        log::info!("[auth] session store ready — {restored} session(s) restored from disk (survive restarts)");
        Ok(store)
    }

    /// The database, while there is one and it is open.
    fn db(&self) -> Option<Db> {
        self.db.read().clone().filter(Db::is_open)
    }

    /// Session lifetime in ms.
    pub fn max_age_ms(&self) -> f64 {
        self.max_age_ms
    }

    /// Creates a new session and returns the session ID (for the cookie; only its hash is kept).
    pub fn create(&self, ip: Option<&str>) -> String {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let session_id = hex::encode(bytes);
        let key = session_key(&session_id);
        let created_at = self.clock.now_ms();
        self.sessions.lock().insert(key.clone(), created_at);
        if let Some(db) = self.db() {
            let _ = db.with(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO sessions (id, created_at, ip) VALUES (?, ?, ?)",
                    params![key, created_at, ip],
                )
            });
        }
        session_id
    }

    /// Destroys a session, by the id its cookie holds.
    pub fn destroy(&self, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        let key = session_key(session_id);
        self.sessions.lock().remove(&key);
        if let Some(db) = self.db() {
            let _ = db.with(|conn| conn.execute("DELETE FROM sessions WHERE id = ?", [key]));
        }
    }

    /// Whether a cookie's id is a sign-in that is still on (not run out, not signed out).
    pub fn is_live(&self, session_id: &str) -> bool {
        if session_id.is_empty() {
            return false;
        }
        let key = session_key(session_id);
        let mut sessions = self.sessions.lock();
        let Some(&created_at) = sessions.get(&key) else {
            return false;
        };
        if (self.clock.now_ms() - created_at) as f64 >= self.max_age_ms {
            sessions.remove(&key);
            return false;
        }
        true
    }

    /// Drops the sign-ins that have run out, from memory and from disk. Runs every 30 minutes.
    pub fn sweep(&self) {
        let cutoff = self.clock.now_ms() as f64 - self.max_age_ms;
        self.sessions
            .lock()
            .retain(|_, created_at| *created_at as f64 >= cutoff);
        if let Some(db) = self.db() {
            let _ = db.with(|conn| conn.execute("DELETE FROM sessions WHERE created_at < ?", [cutoff]));
        }
    }

    /// How many sign-ins are held in memory.
    pub fn len(&self) -> usize {
        self.sessions.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether the 30-minute sweep is running.
    pub fn is_sweeping(&self) -> bool {
        self.sweeper.lock().as_ref().is_some_and(|task| !task.is_finished())
    }
}

impl Drop for SessionStore {
    fn drop(&mut self) {
        if let Some(task) = self.sweeper.get_mut().take() {
            task.abort();
        }
    }
}

/// Replace each sign-in stored as its id (an older Tarsee) with its hash. The old text is wiped from the file as it
/// is replaced (secure_delete), and the write-ahead log is written back and emptied, so the ids are gone from disk
/// too. Returns how many were hashed.
fn hash_stored_ids(db: &Db) -> rusqlite::Result<usize> {
    db.with(|conn| {
        let plain: Vec<String> = {
            let mut stmt = conn.prepare(&format!("SELECT id FROM sessions WHERE id NOT LIKE '{HASHED}%'"))?;
            stmt.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        if plain.is_empty() {
            return Ok(0);
        }
        // Back to what it was, by name: SQLite reads it as 0, 1 or 2, but takes "2" back as ON, not FAST.
        let before = match conn.query_row("PRAGMA secure_delete", [], |row| row.get::<_, i64>(0))? {
            1 => "ON",
            2 => "FAST",
            _ => "OFF",
        };
        conn.execute_batch("PRAGMA secure_delete = ON")?;
        let renamed = db.transaction(|conn| -> rusqlite::Result<()> {
            let mut rename = conn.prepare("UPDATE OR REPLACE sessions SET id = ? WHERE id = ?")?;
            for id in &plain {
                rename.execute(params![session_key(id), id])?;
            }
            Ok(())
        });
        let restored = conn.execute_batch(&format!("PRAGMA secure_delete = {before}"));
        renamed?;
        restored?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        Ok(plain.len())
    })
}

/// Session lifetime in ms.
pub fn session_max_age_ms(app: &App) -> f64 {
    SessionStore::of(app).max_age_ms()
}

/// How long the browser keeps the sign-in's cookie: past the sign-in itself (400 days, the most browsers keep one),
/// so a tab left open after its sign-in ran out still sends it, and the server can say "your sign-in has run out"
/// rather than speak of the API token the page sends too ([`sign_in_ended`]). The id is no use once the sign-in has
/// ended.
pub fn session_cookie_max_age_ms(app: &App) -> f64 {
    (session_max_age_ms(app) + DAY_MS).max(400.0 * DAY_MS)
}

/// Creates a new session and returns the session ID (for the cookie; only its hash is kept).
pub fn create_session(app: &App, ip: Option<&str>) -> String {
    SessionStore::of(app).create(ip)
}

/// Destroys a session, by the id its cookie holds.
pub fn destroy_session(app: &App, session_id: &str) {
    SessionStore::of(app).destroy(session_id);
}

/// Whether a cookie's id is a sign-in that is still on (not run out, not signed out).
pub fn is_live_session(app: &App, session_id: &str) -> bool {
    SessionStore::of(app).is_live(session_id)
}

/// The id of the request's sign-in (its tarsee_session cookie) while it is on, else `None`.
pub fn live_session_id(app: &App, headers: &HeaderMap) -> Option<String> {
    extract_session_token(headers).filter(|session_id| is_live_session(app, session_id))
}

/// Whether the request carries a sign-in's cookie that is no longer on: the sign-in ran out (or was signed out
/// elsewhere, or the server no longer knows it). The browser keeps the cookie past the sign-in
/// ([`session_cookie_max_age_ms`]), so this is a dashboard tab left open, told apart from an API caller, which
/// sends no such cookie.
pub fn sign_in_ended(app: &App, headers: &HeaderMap) -> bool {
    extract_session_token(headers)
        .is_some_and(|session_id| !session_id.is_empty() && !is_live_session(app, &session_id))
}

/// The answer to an owner-only request refused because its sign-in has run out. Sign in again, then `what`
/// ("try once more" when `None`).
pub fn sign_in_ran_out(what: Option<&str>) -> String {
    format!(
        "Your sign-in has run out. Sign in again, then {}.",
        what.unwrap_or("try once more")
    )
}

/// Validates password against SETUP_PASSWORD.
pub fn validate_password(app: &App, password: &str) -> bool {
    match app.config().setup_password.as_deref() {
        Some(setup_password) => safe_compare(password, setup_password),
        None => false,
    }
}

/// Validates an API token.
pub fn validate_api_token(app: &App, token: &str) -> bool {
    safe_compare(token, &app.config().api_token)
}

/// Validates a session from an HTTP request (for WebSocket upgrades).
/// Returns true if the request has a valid session cookie.
pub fn validate_session_from_request(app: &App, headers: &HeaderMap) -> bool {
    // No blanket bypass when SETUP_PASSWORD is unset.
    //
    // This used to return true in that case, and the WebSocket channel uses this
    // function to gate the /terminal upgrade. So a deploy that forgot
    // SETUP_PASSWORD (or typo'd the variable name) published an unauthenticated
    // root-capable shell: anyone could open wss://<host>/terminal and read the
    // Claude OAuth credentials, the encryption key and every channel token off
    // the volume. A missing password must mean "no session can be valid", not
    // "every request is valid": callers already fall back to the API token,
    // which is always generated.
    live_session_id(app, headers).is_some()
}

/// Who the request comes from: the body of `sessionAuth`.
/// The method is `Bearer` when the API token is sent, even with a sign-in's cookie (the dashboard sends both): what
/// only the owner may do checks the sign-in itself ([`live_session_id`]).
pub fn authenticate(app: &App, headers: &HeaderMap) -> Auth {
    // Check Bearer token (for API clients)
    if let Some(bearer_token) = extract_bearer_token(headers)
        && !bearer_token.is_empty()
        && validate_api_token(app, &bearer_token)
    {
        return Auth {
            authenticated: true,
            method: Some(AuthMethod::Bearer),
            session_id: None,
        };
    }

    // Check session cookie (for WebUI)
    match live_session_id(app, headers) {
        Some(session_id) => Auth {
            authenticated: true,
            method: Some(AuthMethod::Session),
            session_id: Some(session_id),
        },
        None => Auth::default(),
    }
}

/// Middleware: Extracts auth info and attaches it to the request as the [`Auth`] extension (`req.auth`).
/// Does NOT enforce auth: use [`require_auth`] for that.
pub async fn session_auth(State(app): State<App>, mut request: Request, next: Next) -> Response {
    let auth = authenticate(&app, request.headers());
    request.extensions_mut().insert(auth);
    next.run(request).await
}

/// What [`require_auth`] decides: nothing for a request that is signed in, else the 401 to answer with.
fn check_auth(app: &App, auth: &Auth, headers: &HeaderMap) -> Result<(), ApiError> {
    if auth.authenticated {
        return Ok(());
    }
    if sign_in_ended(app, headers) {
        return Err(ApiError::with_body(
            401,
            json!({ "error": sign_in_ran_out(None), "needsSignIn": true }),
        ));
    }
    Err(ApiError::new(401, "Authentication required"))
}

/// Middleware: Requires authentication. Returns 401 if not authenticated. A sign-in that has run out is told so,
/// with needsSignIn (the dashboard then shows its sign-in screen): the owner's OK for HEARTBEAT.md and BOOT.md goes
/// with the sign-in alone (js/settings.js _ownerPost), so this is where it is refused.
pub async fn require_auth(State(app): State<App>, request: Request, next: Next) -> Response {
    match check_auth(&app, &Auth::of(request.extensions()), request.headers()) {
        Ok(()) => next.run(request).await,
        Err(refused) => refused.into_response(),
    }
}

/// [`require_auth`] as an extractor, for a handler in a route file (which cannot use `from_fn_with_state`: it has
/// no `App` yet when it builds its router). Gives the request's [`Auth`], or answers 401 as the middleware does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequireAuth(pub Auth);

impl<S> FromRequestParts<S> for RequireAuth
where
    App: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app = App::from_ref(state);
        let auth = Auth::of(&parts.extensions);
        check_auth(&app, &auth, &parts.headers)?;
        Ok(RequireAuth(auth))
    }
}

// --- Rate limiting + lockout state ---

/// One address's sign-in attempts.
struct Attempts {
    /// Attempts in the current 60-second window.
    count: u32,
    /// When the window ends.
    reset_at: i64,
    /// Wrong passwords since the last right one.
    failures: u32,
    /// Locked out until then; 0 when not locked.
    locked_until: i64,
}

impl Attempts {
    fn starting_at(now: i64) -> Attempts {
        Attempts {
            count: 0,
            reset_at: now + 60_000,
            failures: 0,
            locked_until: 0,
        }
    }
}

/// The refusal of a sign-in attempt: `429`, a `Retry-After` header and `{ "error": ... }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TooManyAttempts {
    /// Seconds until the next attempt is allowed.
    pub retry_after: i64,
    pub error: String,
}

impl IntoResponse for TooManyAttempts {
    fn into_response(self) -> Response {
        (
            StatusCode::TOO_MANY_REQUESTS,
            [(RETRY_AFTER, HeaderValue::from(self.retry_after))],
            Json(json!({ "error": self.error })),
        )
            .into_response()
    }
}

/// `Math.ceil(ms / 1000)`.
fn ceil_seconds(ms: i64) -> i64 {
    ms.div_euclid(1000) + i64::from(ms.rem_euclid(1000) != 0)
}

/// The sign-in attempts of each address (the JS `authAttempts` map): ip → { count, resetAt, failures, lockedUntil }.
///
/// The key is the address as the JS had it. [`AuthAttempts::rate_limit`] files a request without an address under
/// "unknown", while a failure for a request without an address is filed under no address at all (`None`, the JS
/// `undefined`), exactly as the Node code keyed them.
pub struct AuthAttempts {
    entries: Mutex<HashMap<Option<String>, Attempts>>,
    clock: Arc<Clock>,
    sweeper: Mutex<Option<JoinHandle<()>>>,
}

impl AuthAttempts {
    /// The app's attempts, made on first use.
    pub fn of(app: &App) -> Arc<AuthAttempts> {
        let attempts = app.get_or_init(|| AuthAttempts {
            entries: Mutex::new(HashMap::new()),
            clock: Clock::of(app),
            sweeper: Mutex::new(None),
        });
        ensure_sweeper(
            &attempts.sweeper,
            &attempts,
            AUTH_ATTEMPTS_SWEEP_INTERVAL,
            AuthAttempts::sweep,
        );
        attempts
    }

    /// Rate limits authentication attempts per IP: the body of `rateLimitAuth`. `Ok` counts the attempt and lets it
    /// through.
    ///
    /// Progressive lockout for brute-force protection.
    /// 4-digit PIN = 10K combinations, so we need aggressive lockout:
    ///
    /// - Failures 1-3:  no delay (typos happen)
    /// - Failures 4-5:  30 second lockout
    /// - Failures 6-7:  2 minute lockout
    /// - Failures 8-9:  10 minute lockout
    /// - Failures 10+:  1 hour lockout (IP is blocked)
    ///
    /// Plus: max 5 attempts per 60-second window (rate limit).
    /// Combined: brute-forcing 10K PINs takes ~2,000 hours.
    pub fn rate_limit(&self, ip: Option<&str>) -> Result<(), TooManyAttempts> {
        let ip = ip.filter(|ip| !ip.is_empty()).unwrap_or("unknown");
        let now = self.clock.now_ms();

        let mut entries = self.entries.lock();
        let entry = entries
            .entry(Some(ip.to_string()))
            .or_insert_with(|| Attempts::starting_at(now));

        // Check lockout first
        if entry.locked_until != 0 && now < entry.locked_until {
            let retry_after = ceil_seconds(entry.locked_until - now);
            return Err(TooManyAttempts {
                retry_after,
                error: format!("Locked out. Try again in {retry_after}s."),
            });
        }

        // Rate limit: max 5 per 60s window
        if now >= entry.reset_at {
            entry.count = 0;
            entry.reset_at = now + 60_000;
        }

        if entry.count >= 5 {
            return Err(TooManyAttempts {
                retry_after: ceil_seconds(entry.reset_at - now),
                error: "Too many attempts. Try again later.".to_string(),
            });
        }

        entry.count += 1;
        Ok(())
    }

    /// Record a failed login attempt and apply progressive lockout.
    pub fn record_failed(&self, ip: Option<&str>) {
        let now = self.clock.now_ms();
        let mut entries = self.entries.lock();
        let entry = entries
            .entry(ip.map(String::from))
            .or_insert_with(|| Attempts::starting_at(now));
        entry.failures += 1;

        // Progressive lockout
        if entry.failures >= 10 {
            entry.locked_until = now + 60 * 60_000; // 1 hour
        } else if entry.failures >= 8 {
            entry.locked_until = now + 10 * 60_000; // 10 min
        } else if entry.failures >= 6 {
            entry.locked_until = now + 2 * 60_000; // 2 min
        } else if entry.failures >= 4 {
            entry.locked_until = now + 30_000; // 30s
        }
    }

    /// Clear failed attempts for an IP (call on successful login).
    pub fn clear_failed(&self, ip: Option<&str>) {
        if let Some(entry) = self.entries.lock().get_mut(&ip.map(String::from)) {
            entry.failures = 0;
            entry.locked_until = 0;
        }
    }

    /// Drops the addresses whose window and lockout are both over. Runs every 5 minutes.
    pub fn sweep(&self) {
        let now = self.clock.now_ms();
        self.entries
            .lock()
            .retain(|_, entry| !(now >= entry.reset_at && (entry.locked_until == 0 || now >= entry.locked_until)));
    }

    /// How many addresses are being counted.
    pub fn len(&self) -> usize {
        self.entries.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether the 5-minute sweep is running.
    pub fn is_sweeping(&self) -> bool {
        self.sweeper.lock().as_ref().is_some_and(|task| !task.is_finished())
    }
}

impl Drop for AuthAttempts {
    fn drop(&mut self) {
        if let Some(task) = self.sweeper.get_mut().take() {
            task.abort();
        }
    }
}

/// Middleware: Rate limits authentication attempts per IP. See [`AuthAttempts::rate_limit`].
pub async fn rate_limit_auth(State(app): State<App>, request: Request, next: Next) -> Response {
    let ip = client_ip(request.headers(), request.extensions());
    match AuthAttempts::of(&app).rate_limit(ip.as_deref()) {
        Ok(()) => next.run(request).await,
        Err(refused) => refused.into_response(),
    }
}

/// Record a failed login attempt and apply progressive lockout.
pub fn record_failed_attempt(app: &App, ip: Option<&str>) {
    AuthAttempts::of(app).record_failed(ip);
}

/// Clear failed attempts for an IP (call on successful login).
pub fn clear_failed_attempts(app: &App, ip: Option<&str>) {
    AuthAttempts::of(app).clear_failed(ip);
}

#[cfg(test)]
mod tests;
