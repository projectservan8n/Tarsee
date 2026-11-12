//! Port of `src/middleware/security.js`: the security headers on every response, and CSRF protection.
//!
//! The Express middleware are axum middleware functions with the Node names, applied with
//! `axum::middleware::from_fn_with_state(app, csrf_protect)`: [`security_headers`], [`generate_csrf_cookie`],
//! [`csrf_protect`]. Also here, because both cookies of this package are written with it: [`cookie`] and
//! [`clear_cookie`], which give the `Set-Cookie` line Express's `res.cookie` and `res.clearCookie` wrote, byte for
//! byte.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Request, State};
use axum::http::header::{HeaderName, SET_COOKIE};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Datelike, Timelike, Utc};
use hmac::{Hmac, KeyInit, Mac};
use rand::Rng;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::auth::{Auth, Clock, env_number_or, js_number, node_header, safe_compare};
use crate::app::App;
use crate::error::ApiError;
use crate::util::js::number_to_string;

// --- CSRF: HMAC-signed tokens (stateless, survives restarts) ---

/// The app's CSRF signing: the secret, how long a token lasts, and the clock (the JS module-level
/// `CSRF_TOKEN_MAX_AGE_MS` and `CSRF_SECRET`).
pub struct Csrf {
    secret: Vec<u8>,
    /// 2 hours was too short: the cookie is only re-issued on an HTML page load, so a tab left open longer than
    /// that failed its next POST with "CSRF token invalid or expired". The token is HMAC-signed and stateless, so
    /// a longer bound is safe: it still expires, it just outlives a working day.
    /// Override with TARSEE_CSRF_MAX_AGE_HOURS.
    max_age_ms: f64,
    clock: Arc<Clock>,
}

impl Csrf {
    /// The app's CSRF signing, made on first use.
    ///
    /// Derive a stable CSRF secret from ENCRYPTION_KEY or generate one for this run.
    /// Using ENCRYPTION_KEY means tokens survive restarts as long as env is stable. It is read from the app's
    /// environment exactly as set (the Node code read `process.env.ENCRYPTION_KEY`, not the trimmed
    /// `config.ENCRYPTION_KEY`), so a token the Node version signed still verifies.
    pub fn of(app: &App) -> Arc<Csrf> {
        app.get_or_init(|| {
            let secret = match app.env().get("ENCRYPTION_KEY").filter(|key| !key.is_empty()) {
                Some(key) => Sha256::digest(format!("csrf:{key}").as_bytes()).to_vec(),
                None => {
                    let mut random = [0u8; 32];
                    rand::rng().fill_bytes(&mut random);
                    random.to_vec()
                }
            };
            Csrf {
                secret,
                max_age_ms: env_number_or(app, "TARSEE_CSRF_MAX_AGE_HOURS", 24.0) * 60.0 * 60.0 * 1000.0,
                clock: Clock::of(app),
            }
        })
    }

    /// How long a token lasts, in ms.
    pub fn max_age_ms(&self) -> f64 {
        self.max_age_ms
    }

    /// `signCsrfToken(timestamp)`: `<timestamp>.<hex HMAC-SHA256 of the timestamp's text>`.
    fn sign(&self, timestamp: f64) -> String {
        let timestamp = number_to_string(timestamp);
        // HMAC takes a key of any length, so this never fails.
        let mut hmac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.secret).expect("HMAC takes a key of any length");
        hmac.update(timestamp.as_bytes());
        format!("{timestamp}.{}", hex::encode(hmac.finalize().into_bytes()))
    }

    /// A token for now.
    pub fn issue(&self) -> String {
        self.sign(self.clock.now_ms() as f64)
    }

    /// `verifyCsrfToken(token)`: whether this server signed the token and it has not run out.
    ///
    /// A Node bug fixed here. The Node code compared the token with the one it expected through
    /// `crypto.timingSafeEqual`, which throws when the two differ in length, and nothing caught that: a token whose
    /// signature has the wrong length (a cut or stale one, or the header sent twice) was answered with a 500. A
    /// token of another length is simply not the token, so it is refused like every other bad token.
    pub fn verify(&self, token: &str) -> bool {
        let Some(dot) = token.find('.') else {
            return false;
        };
        let timestamp = js_number(&token[..dot]);
        if timestamp.is_nan() {
            return false;
        }
        // Check expiry
        if self.clock.now_ms() as f64 - timestamp > self.max_age_ms {
            return false;
        }
        // Verify HMAC
        safe_compare(token, &self.sign(timestamp))
    }
}

// --- Cookies, as Express wrote them ---

/// Why a cookie could not be written (the `cookie` package threw a TypeError with this text).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CookieError(&'static str);

/// The options Tarsee's two cookies differ in. `SameSite=Strict` and `Path=/` are always there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CookieOptions {
    pub http_only: bool,
    pub secure: bool,
    /// How long the browser keeps the cookie, in ms (`maxAge`).
    pub max_age_ms: f64,
}

/// `encodeURIComponent(text)`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `new Date(ms).toUTCString()`: "Fri, 13 Nov 2026 14:54:14 GMT". `None` for a moment a JavaScript Date cannot
/// hold (an invalid Date).
fn utc_string(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let date: DateTime<Utc> = DateTime::from_timestamp_millis(ms.trunc() as i64)?;
    const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let year = date.year();
    Some(format!(
        "{}, {:02} {} {}{:04} {:02}:{:02}:{:02} GMT",
        DAYS[date.weekday().num_days_from_monday() as usize],
        date.day(),
        MONTHS[date.month0() as usize],
        if year < 0 { "-" } else { "" },
        year.abs(),
        date.hour(),
        date.minute(),
        date.second()
    ))
}

/// The `Set-Cookie` line of `res.cookie(name, value, { httpOnly, sameSite: "Strict", secure, maxAge, path: "/" })`:
/// `name=value; Max-Age=<seconds>; Path=/; Expires=<date>; HttpOnly; Secure; SameSite=Strict`, with `HttpOnly` and
/// `Secure` only when asked for. `now_ms` is the time the expiry is counted from.
pub fn cookie(name: &str, value: &str, options: CookieOptions, now_ms: i64) -> Result<String, CookieError> {
    // Express: opts.expires = new Date(Date.now() + maxAge); opts.maxAge = Math.floor(maxAge / 1000)
    let expires = now_ms as f64 + options.max_age_ms;
    let max_age = (options.max_age_ms / 1000.0).floor();

    // The `cookie` package's serialize, in its order.
    let mut line = format!("{name}={}", encode_uri_component(value));
    if !max_age.is_finite() {
        return Err(CookieError("option maxAge is invalid"));
    }
    line.push_str(&format!("; Max-Age={}", number_to_string(max_age)));
    line.push_str("; Path=/");
    let expires = utc_string(expires).ok_or(CookieError("option expires is invalid"))?;
    line.push_str(&format!("; Expires={expires}"));
    if options.http_only {
        line.push_str("; HttpOnly");
    }
    if options.secure {
        line.push_str("; Secure");
    }
    line.push_str("; SameSite=Strict");
    Ok(line)
}

/// The `Set-Cookie` line of `res.clearCookie(name, { path: "/" })`: an empty value that expired in 1970.
pub fn clear_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
}

/// `process.env.NODE_ENV === "production"`.
fn is_production(app: &App) -> bool {
    app.env().get("NODE_ENV").as_deref() == Some("production")
}

/// The answer to an error the Node code let escape a handler: what its error handler
/// (`middleware/error-handler.js`) sent for a status of 500, `{ "error": "Internal server error" }` with the
/// error's own text as `detail` outside production, and the `[error]` log line.
pub(crate) fn uncaught_error(app: &App, name: &str, message: &str) -> Response {
    log::error!("[error] {name}: {message}");
    let body = if is_production(app) {
        json!({ "error": "Internal server error" })
    } else {
        json!({ "error": "Internal server error", "detail": message })
    };
    (StatusCode::INTERNAL_SERVER_ERROR, Json(body)).into_response()
}

/// `res.append("Set-Cookie", line)`, when it is done before the handler runs: the cookie goes ahead of the ones the
/// handler set.
pub(crate) fn prepend_set_cookie(response: &mut Response, line: &str) {
    let Ok(first) = HeaderValue::from_str(line) else {
        return;
    };
    let headers = response.headers_mut();
    let later: Vec<HeaderValue> = headers.get_all(SET_COOKIE).iter().cloned().collect();
    headers.remove(SET_COOKIE);
    headers.append(SET_COOKIE, first);
    for value in later {
        headers.append(SET_COOKIE, value);
    }
}

/// The headers [`security_headers`] sets, in the order the Node code set them.
pub const SECURITY_HEADERS: [(&str, &str); 6] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "SAMEORIGIN"), // Allow canvas iframes from same origin
    ("x-xss-protection", "0"),
    ("referrer-policy", "same-origin"),
    ("permissions-policy", "camera=(), microphone=(self), geolocation=()"),
    (
        "content-security-policy",
        "default-src 'self'; \
         script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com; \
         style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com; \
         img-src 'self' data: blob:; \
         media-src 'self' blob:; \
         connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://fonts.googleapis.com https://fonts.gstatic.com; \
         font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; \
         frame-src 'self'; \
         object-src 'none'; \
         base-uri 'self'; \
         form-action 'self'",
    ),
];

/// Middleware: Sets security headers on all responses.
///
/// The Node code set them before the handler ran, so a handler that set one of them itself (the canvas pages and
/// the files a chat sent set their own Content-Security-Policy) replaced it. Here they are added after the handler,
/// to the response it made, and only where it set none: the same result.
pub async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in SECURITY_HEADERS {
        let name = HeaderName::from_static(name);
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    response
}

/// The `Set-Cookie` line of a fresh CSRF cookie: `tarsee_csrf=<token>`, readable by the page's JavaScript.
pub fn csrf_cookie(app: &App) -> Result<String, CookieError> {
    let csrf = Csrf::of(app);
    cookie(
        "tarsee_csrf",
        &csrf.issue(),
        CookieOptions {
            http_only: false, // JS needs to read it for the double-submit pattern
            secure: is_production(app),
            max_age_ms: csrf.max_age_ms,
        },
        csrf.clock.now_ms(),
    )
}

/// Middleware: Generates a CSRF cookie on page loads.
/// Use this on GET routes that serve HTML pages.
pub async fn generate_csrf_cookie(State(app): State<App>, request: Request, next: Next) -> Response {
    let line = match csrf_cookie(&app) {
        Ok(line) => line,
        Err(err) => return uncaught_error(&app, "TypeError", &err.to_string()),
    };
    let mut response = next.run(request).await;
    prepend_set_cookie(&mut response, &line);
    response
}

static X_CSRF_TOKEN: HeaderName = HeaderName::from_static("x-csrf-token");

/// Middleware: Validates CSRF token on state-changing requests.
/// Expects the X-CSRF-Token header to carry a token this server signed (the tarsee_csrf cookie's value).
/// Skips validation for Bearer token auth (API clients don't need CSRF).
pub async fn csrf_protect(State(app): State<App>, request: Request, next: Next) -> Response {
    // Skip CSRF for API token auth (Bearer): CSRF is a browser-specific attack
    if Auth::of(request.extensions()).is_bearer() {
        return next.run(request).await;
    }

    // Only enforce on state-changing methods
    if [Method::GET, Method::HEAD, Method::OPTIONS].contains(request.method()) {
        return next.run(request).await;
    }

    let header_token = node_header(request.headers(), &X_CSRF_TOKEN).filter(|token| !token.is_empty());
    let Some(header_token) = header_token else {
        return ApiError::new(403, "CSRF token missing").into_response();
    };

    // Validate HMAC signature and expiry (stateless: no server-side storage needed)
    if !Csrf::of(&app).verify(&header_token) {
        return ApiError::new(403, "CSRF token invalid or expired").into_response();
    }

    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::middleware::auth::{create_session, session_auth};
    use crate::testkit::captured_logs::CapturedLogs;
    use crate::testkit::{TestApp, http, test_app, test_app_with_env};
    use axum::Router;
    use axum::middleware::{from_fn, from_fn_with_state};
    use axum::routing::{get, post};

    /// The key the Node fixture below was signed with.
    const FIXTURE_KEY: &str = "tarsee-port-fixture-key-not-a-secret";
    /// The cookie `generateCsrfCookie` of the Node version made with that key, and when it made it.
    const NODE_TOKEN: &str = "1794495903789.9cc65646644823cc2cc1eab2860e702d00d254fdf919f52211c854e355a60644";
    const NODE_TOKEN_AT: i64 = 1_794_495_903_789;

    /// An app with the fixture key whose clock stands a minute after the Node token was made.
    fn fixture_app() -> (TestApp, Arc<Clock>) {
        let t = test_app_with_env([("ENCRYPTION_KEY", FIXTURE_KEY)]);
        let clock = t.app.set(Clock::manual(NODE_TOKEN_AT + 60_000));
        (t, clock)
    }

    /// As the server builds it: the headers on everything, sign-in checked, CSRF on `/api`.
    fn router(t: &TestApp) -> Router {
        let app = t.app.clone();
        let api = Router::new()
            .route("/api/thing", post(|| async { "done" }).get(|| async { "read" }))
            .layer(from_fn_with_state(app.clone(), csrf_protect));
        Router::new()
            .route(
                "/page",
                get(|| async { "page" }).layer(from_fn_with_state(app.clone(), generate_csrf_cookie)),
            )
            .merge(api)
            .layer(from_fn_with_state(app.clone(), session_auth))
            .layer(from_fn(security_headers))
            .with_state(app)
    }

    async fn post_with(router: &Router, token: Option<&str>) -> http::TestResponse {
        let mut request = http::request("POST", "/api/thing");
        if let Some(token) = token {
            request = request.header("x-csrf-token", token);
        }
        http::send(router, request).await
    }

    // --- Tokens ---

    #[test]
    fn a_token_the_node_version_signed_still_verifies() {
        let (t, _clock) = fixture_app();
        let csrf = Csrf::of(&t);
        assert!(csrf.verify(NODE_TOKEN));
        assert_eq!(
            csrf.sign(NODE_TOKEN_AT as f64),
            NODE_TOKEN,
            "and this version signs the same"
        );
        assert_eq!(csrf.max_age_ms(), 86_400_000.0);
    }

    #[test]
    fn the_secret_comes_from_the_encryption_key_as_it_is_set() {
        // Node hashed process.env.ENCRYPTION_KEY untrimmed: spaces around the key make another secret.
        let padded = test_app_with_env([("ENCRYPTION_KEY", format!(" {FIXTURE_KEY} "))]);
        padded.app.set(Clock::manual(NODE_TOKEN_AT));
        assert!(!Csrf::of(&padded).verify(NODE_TOKEN));

        // Without a key the secret is random: a token is good for the app that issued it and no other.
        let (a, b) = (test_app(), test_app());
        let token = Csrf::of(&a).issue();
        assert!(Csrf::of(&a).verify(&token));
        assert!(!Csrf::of(&b).verify(&token));
    }

    #[test]
    fn a_token_lasts_a_day_and_not_a_millisecond_more() {
        let (t, clock) = fixture_app();
        let csrf = Csrf::of(&t);
        let token = csrf.issue();
        assert_eq!(token.len(), "1794495963789.".len() + 64);
        clock.advance(86_400_000);
        assert!(csrf.verify(&token));
        clock.advance(1);
        assert!(!csrf.verify(&token));

        let week = test_app_with_env([("TARSEE_CSRF_MAX_AGE_HOURS", "168")]);
        assert_eq!(Csrf::of(&week).max_age_ms(), 604_800_000.0);
        let unusable = test_app_with_env([("TARSEE_CSRF_MAX_AGE_HOURS", "soon")]);
        assert_eq!(Csrf::of(&unusable).max_age_ms(), 86_400_000.0);
    }

    #[test]
    fn a_token_is_good_only_as_it_was_issued() {
        let (t, _clock) = fixture_app();
        let csrf = Csrf::of(&t);
        let zeros = "0".repeat(64);
        let flipped = format!("{}{}", &NODE_TOKEN[..NODE_TOKEN.len() - 1], "5");
        // What the Node version refused with its 403.
        assert!(!csrf.verify(&flipped), "a wrong signature of the right length");
        assert!(!csrf.verify("abcdef"), "no dot");
        assert!(!csrf.verify("abc.def"), "not a number");
        assert!(!csrf.verify(&format!("1000.{zeros}")), "long expired");
        assert!(!csrf.verify(&format!(".{zeros}")), "an empty timestamp is 0");
        assert!(!csrf.verify(&format!("1e25.{zeros}0")));
        assert!(!csrf.verify(&format!("Infinity.{zeros}")));
        // What the Node version answered with a 500, because the token it expected had another length: these are
        // refused the same way now.
        for wrong_length in [
            "1794495903789.deadbeef".to_string(),
            "1794495903789.".to_string(),
            format!("{NODE_TOKEN}00"),
            NODE_TOKEN[..NODE_TOKEN.len() - 1].to_string(),
            format!("1e25.{zeros}"),
            NODE_TOKEN.replace('.', " ."),
            format!("{NODE_TOKEN}, {NODE_TOKEN}"),
        ] {
            assert!(!csrf.verify(&wrong_length), "{wrong_length}");
        }
        // The same moment written another way (it reads as the same number) is not the token that was issued.
        assert!(!csrf.verify(&NODE_TOKEN.replace("1794495903789.", "1794495903789e0.")));
        assert!(!csrf.verify(&NODE_TOKEN.replace("1794495903789.", "+1794495903789.")));
        // A timestamp from the future is not expired; only its signature decides.
        let future = csrf.sign((NODE_TOKEN_AT + 10 * 86_400_000) as f64);
        assert!(csrf.verify(&future));
    }

    #[test]
    fn the_numbers_in_a_token_and_a_cookie_print_as_javascript_prints_them() {
        // String(number) in Node, for `util::js::number_to_string`, which writes the timestamp a token is signed
        // over and a cookie's Max-Age.
        for (number, expected) in [
            (1e21, "1e+21"),
            (1e25, "1e+25"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1794495254663.0, "1794495254663"),
            (0.1, "0.1"),
            (-0.0, "0"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (100.0, "100"),
            (1234.5678, "1234.5678"),
            (123e-20, "1.23e-18"),
            (0.5, "0.5"),
            (-3600.0, "-3600"),
            (-1.5e-7, "-1.5e-7"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
        ] {
            assert_eq!(number_to_string(number), expected);
        }
    }

    // --- Cookies ---

    #[test]
    fn cookies_are_written_as_express_wrote_them() {
        // The Set-Cookie lines the Node version sent, with the moment it sent them.
        let at = DateTime::parse_from_rfc3339("2026-11-12T14:54:14.663Z")
            .unwrap()
            .timestamp_millis();
        let csrf = CookieOptions {
            http_only: false,
            secure: false,
            max_age_ms: 86_400_000.0,
        };
        assert_eq!(
            cookie("tarsee_csrf", "1794495254663.1aed2540", csrf, at).unwrap(),
            "tarsee_csrf=1794495254663.1aed2540; Max-Age=86400; Path=/; Expires=Fri, 13 Nov 2026 14:54:14 GMT; SameSite=Strict"
        );
        let session = CookieOptions {
            http_only: true,
            secure: false,
            max_age_ms: 34_560_000_000.0,
        };
        assert_eq!(
            cookie("tarsee_session", "6bc057ec", session, at).unwrap(),
            "tarsee_session=6bc057ec; Max-Age=34560000; Path=/; Expires=Fri, 17 Dec 2027 14:54:14 GMT; HttpOnly; SameSite=Strict"
        );
        // In production both carry Secure, between HttpOnly and SameSite.
        let secure = CookieOptions {
            secure: true,
            ..session
        };
        assert!(
            cookie("tarsee_session", "6bc057ec", secure, at)
                .unwrap()
                .ends_with("GMT; HttpOnly; Secure; SameSite=Strict")
        );
        assert_eq!(
            clear_cookie("tarsee_session"),
            "tarsee_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        );
    }

    #[test]
    fn odd_values_and_lifetimes_are_treated_as_express_treated_them() {
        let options = |max_age_ms: f64| CookieOptions {
            http_only: false,
            secure: false,
            max_age_ms,
        };
        // encodeURIComponent on the value.
        assert_eq!(
            cookie("n", "a b;c=é/~!*'()", options(1000.0), 0).unwrap(),
            "n=a%20b%3Bc%3D%C3%A9%2F~!*'(); Max-Age=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Strict"
        );
        // Math.floor(maxAge / 1000), and a lifetime in the past.
        assert!(cookie("n", "v", options(1999.0), 0).unwrap().contains("; Max-Age=1; "));
        assert_eq!(
            cookie("n", "v", options(-3_600_000.0), 86_400_000).unwrap(),
            "n=v; Max-Age=-3600; Path=/; Expires=Thu, 01 Jan 1970 23:00:00 GMT; SameSite=Strict"
        );
        // What the `cookie` package refused.
        assert_eq!(
            cookie("n", "v", options(f64::INFINITY), 0).unwrap_err().to_string(),
            "option maxAge is invalid"
        );
        assert_eq!(
            cookie("n", "v", options(9e15), 0).unwrap_err().to_string(),
            "option expires is invalid"
        );
        assert_eq!(utc_string(0.0).as_deref(), Some("Thu, 01 Jan 1970 00:00:00 GMT"));
        assert_eq!(utc_string(1.9).as_deref(), Some("Thu, 01 Jan 1970 00:00:00 GMT"));
        assert_eq!(
            utc_string(-62_198_755_200_000.0).as_deref(),
            Some("Fri, 01 Jan -0001 00:00:00 GMT")
        );
        assert_eq!(utc_string(-1.9).as_deref(), Some("Wed, 31 Dec 1969 23:59:59 GMT"));
        assert_eq!(
            utc_string(253_402_300_800_000.0).as_deref(),
            Some("Sat, 01 Jan 10000 00:00:00 GMT")
        );
        assert_eq!(utc_string(f64::NAN), None);
    }

    // --- The middleware ---

    #[tokio::test]
    async fn every_response_carries_the_security_headers_byte_for_byte() {
        let t = test_app();
        let router = router(&t);
        // The header values the Node version sent.
        let expected = [
            ("x-content-type-options", "nosniff"),
            ("x-frame-options", "SAMEORIGIN"),
            ("x-xss-protection", "0"),
            ("referrer-policy", "same-origin"),
            ("permissions-policy", "camera=(), microphone=(self), geolocation=()"),
            (
                "content-security-policy",
                "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://fonts.googleapis.com https://fonts.gstatic.com; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
            ),
        ];
        for response in [
            http::get(&router, "/page").await,
            post_with(&router, None).await,
            http::get(&router, "/nowhere").await,
        ] {
            for (name, value) in expected {
                assert_eq!(response.header(name), Some(value), "{name} on a {}", response.status);
                assert_eq!(response.headers.get_all(name).iter().count(), 1);
            }
        }
    }

    #[tokio::test]
    async fn a_handler_that_sets_one_of_the_headers_itself_keeps_its_own() {
        let router: Router = Router::new()
            .route(
                "/canvas",
                get(|| async {
                    (
                        [
                            ("content-security-policy", "sandbox; default-src 'none'"),
                            ("x-content-type-options", "nosniff"),
                        ],
                        "canvas",
                    )
                }),
            )
            .layer(from_fn(security_headers));
        let response = http::get(&router, "/canvas").await;
        assert_eq!(
            response.header("content-security-policy"),
            Some("sandbox; default-src 'none'")
        );
        assert_eq!(response.headers.get_all("content-security-policy").iter().count(), 1);
        assert_eq!(response.headers.get_all("x-content-type-options").iter().count(), 1);
        assert_eq!(response.header("x-frame-options"), Some("SAMEORIGIN"));
    }

    #[tokio::test]
    async fn a_page_load_gets_a_csrf_cookie_the_page_can_read() {
        let (t, _clock) = fixture_app();
        let router = router(&t);
        let page = http::get(&router, "/page").await;
        assert_eq!(page.text(), "page");
        let token = Csrf::of(&t).sign((NODE_TOKEN_AT + 60_000) as f64);
        // The line the Node version sent: no HttpOnly, a day's Max-Age and the matching Expires.
        assert_eq!(
            page.set_cookies(),
            [format!(
                "tarsee_csrf={token}; Max-Age=86400; Path=/; Expires=Fri, 13 Nov 2026 15:06:03 GMT; SameSite=Strict"
            )]
        );
        assert_eq!(post_with(&router, Some(&token)).await.status, 200);

        let production = test_app_with_env([("NODE_ENV", "production")]);
        let line = csrf_cookie(&production).unwrap();
        assert!(line.ends_with("GMT; Secure; SameSite=Strict"), "{line}");
    }

    #[tokio::test]
    async fn the_csrf_cookie_goes_ahead_of_the_cookies_the_handler_sets() {
        let t = test_app();
        let router: Router = Router::new()
            .route(
                "/page",
                get(|| async { ([(SET_COOKIE, "theirs=1")], "page") })
                    .layer(from_fn_with_state(t.app.clone(), generate_csrf_cookie)),
            )
            .with_state(t.app.clone());
        let cookies = http::get(&router, "/page").await.set_cookies();
        assert_eq!(cookies.len(), 2);
        assert!(cookies[0].starts_with("tarsee_csrf="));
        assert_eq!(cookies[1], "theirs=1");
    }

    #[tokio::test]
    async fn state_changing_requests_need_the_token_and_reading_ones_do_not() {
        let (t, _clock) = fixture_app();
        let router = router(&t);
        let zeros = "0".repeat(64);

        // The answers of the Node version, bodies and all.
        let missing = post_with(&router, None).await;
        assert_eq!(
            (missing.status, missing.text()),
            (403, r#"{"error":"CSRF token missing"}"#.to_string())
        );
        let empty = post_with(&router, Some("")).await;
        assert_eq!(empty.json(), json!({ "error": "CSRF token missing" }));
        let wrong = post_with(&router, Some(&format!("1794495903789.{zeros}"))).await;
        assert_eq!(
            (wrong.status, wrong.text()),
            (403, r#"{"error":"CSRF token invalid or expired"}"#.to_string())
        );
        for refused in ["abcdef", "abc.def", &format!("1000.{zeros}")] {
            assert_eq!(post_with(&router, Some(refused)).await.status, 403, "{refused}");
        }
        let good = post_with(&router, Some(NODE_TOKEN)).await;
        assert_eq!((good.status, good.text()), (200, "done".to_string()));

        // GET, HEAD and OPTIONS pass without a token.
        assert_eq!(http::get(&router, "/api/thing").await.text(), "read");
        assert_eq!(
            http::send(&router, http::request("HEAD", "/api/thing")).await.status,
            200
        );
        // Every other method is checked.
        for method in ["PUT", "PATCH", "DELETE"] {
            let response = http::send(&router, http::request(method, "/api/thing")).await;
            assert_eq!(response.json(), json!({ "error": "CSRF token missing" }), "{method}");
        }
    }

    #[tokio::test]
    async fn the_api_token_needs_no_csrf_token_but_a_sign_in_does() {
        let (t, _clock) = fixture_app();
        let router = router(&t);
        let token = t.config().api_token.clone();
        let session = create_session(&t, None);

        let by_token = http::send(
            &router,
            http::request("POST", "/api/thing").header("authorization", format!("Bearer {token}")),
        )
        .await;
        assert_eq!(by_token.text(), "done");
        // The dashboard sends the token and the cookie: named by the token, so no CSRF token is asked for.
        let by_both = http::send(
            &router,
            http::request("POST", "/api/thing")
                .header("authorization", format!("Bearer {token}"))
                .header("cookie", format!("tarsee_session={session}")),
        )
        .await;
        assert_eq!(by_both.status, 200);

        let by_cookie = http::send(
            &router,
            http::request("POST", "/api/thing").header("cookie", format!("tarsee_session={session}")),
        )
        .await;
        assert_eq!(by_cookie.json(), json!({ "error": "CSRF token missing" }));
        let wrong_token = http::send(
            &router,
            http::request("POST", "/api/thing").header("authorization", "Bearer nope"),
        )
        .await;
        assert_eq!(wrong_token.status, 403);
    }

    /// A Node bug fixed in this version. The Node version answered each of these with a 500 and an `[error]` line
    /// (`crypto.timingSafeEqual` threw on two lengths, uncaught). They are bad tokens: 403, like any other.
    #[tokio::test]
    async fn a_signature_of_the_wrong_length_is_refused_like_any_other_bad_token() {
        let (t, _clock) = fixture_app();
        let router = router(&t);
        let logs = CapturedLogs::start();
        let refused = (403, r#"{"error":"CSRF token invalid or expired"}"#.to_string());
        let zeros = "0".repeat(64);
        for token in [
            "1794495903789.deadbeef".to_string(),
            "1794495903789.".to_string(),
            format!("{NODE_TOKEN}00"),
            NODE_TOKEN[..NODE_TOKEN.len() - 1].to_string(),
            format!("1e25.{zeros}"),
            NODE_TOKEN.replace('.', " ."),
        ] {
            let response = post_with(&router, Some(&token)).await;
            assert_eq!((response.status, response.text()), refused, "{token}");
        }
        // The header sent twice reaches the check as "token, token".
        let twice = http::send(
            &router,
            http::request("POST", "/api/thing")
                .header("x-csrf-token", NODE_TOKEN)
                .header("x-csrf-token", NODE_TOKEN),
        )
        .await;
        assert_eq!((twice.status, twice.text()), refused);
        assert_eq!(logs.errors(), Vec::<String>::new(), "a bad token is not a server error");

        // The token itself still passes, and so in production.
        assert_eq!(post_with(&router, Some(NODE_TOKEN)).await.status, 200);
        let production = test_app_with_env([("NODE_ENV", "production")]);
        let response = post_with(&self::router(&production), Some("1794495903789.deadbeef")).await;
        assert_eq!((response.status, response.text()), refused);
    }

    #[tokio::test]
    async fn a_lifetime_no_cookie_can_carry_is_the_error_express_threw() {
        let t = test_app_with_env([("TARSEE_CSRF_MAX_AGE_HOURS", "Infinity")]);
        assert_eq!(csrf_cookie(&t).unwrap_err().to_string(), "option maxAge is invalid");
        let page = http::get(&router(&t), "/page").await;
        assert_eq!(page.status, 500);
        assert_eq!(
            page.json(),
            json!({ "error": "Internal server error", "detail": "option maxAge is invalid" })
        );
        assert_eq!(page.set_cookies(), Vec::<String>::new());

        // In production the detail is left out.
        let production = test_app_with_env([("TARSEE_CSRF_MAX_AGE_HOURS", "Infinity"), ("NODE_ENV", "production")]);
        let page = http::get(&router(&production), "/page").await;
        assert_eq!(
            (page.status, page.json()),
            (500, json!({ "error": "Internal server error" }))
        );
    }
}
