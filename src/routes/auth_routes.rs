//! Port of `src/routes/auth-routes.js`: signing in and out, the API token for a signed-in page, a fresh CSRF
//! cookie, and who the request is. Mounted at `/api/auth`, after `session_auth`.

use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, SET_COOKIE, TRANSFER_ENCODING};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use serde_json::{Value, json};

use crate::app::App;
use crate::db::audit::{AuditEntry, AuditLog};
use crate::error::ApiError;
use crate::middleware::auth::{
    Auth, AuthAttempts, ClientIp, Clock, RequireAuth, clear_failed_attempts, create_session, destroy_session,
    js_number, live_session_id, node_header, record_failed_attempt, session_cookie_max_age_ms, validate_password,
};
use crate::middleware::security::{
    CookieError, CookieOptions, clear_cookie, cookie, csrf_cookie, prepend_set_cookie, uncaught_error,
};
use crate::util::js::{utf16_len, utf16_slice};

/// The routes of `/api/auth` (the JS `authRouter`).
pub fn router() -> Router<App> {
    Router::new()
        .route("/login", post(login))
        .route("/api-token", get(api_token))
        .route("/logout", post(logout))
        .route("/csrf", get(csrf))
        .route("/status", get(status))
}

/// The sign-in's cookie. The browser keeps it past the sign-in itself (`session_cookie_max_age_ms`), so a tab left
/// open after the sign-in ran out still sends it, and an owner-only action it asks for is told "your sign-in has
/// run out" (middleware/auth.rs `sign_in_ended`) rather than refused in the words meant for the API token the page
/// sends too.
fn session_cookie(app: &App, session_id: &str) -> Result<String, CookieError> {
    cookie(
        "tarsee_session",
        session_id,
        CookieOptions {
            http_only: true,
            secure: app.config().is_production(),
            max_age_ms: session_cookie_max_age_ms(app),
        },
        Clock::of(app).now_ms(),
    )
}

/// `res.cookie(...)` on a response that is already made. A cookie that cannot be written is the error Express
/// threw: the answer becomes its 500.
fn with_cookie(app: &App, mut response: Response, line: Result<String, CookieError>) -> Response {
    match line {
        Ok(line) => {
            prepend_set_cookie(&mut response, &line);
            response
        }
        Err(err) => uncaught_error(app, "TypeError", &err.to_string()),
    }
}

/// A `Content-Type` header as the `content-type` package (2.1, the one `express.json` used) read it: the media
/// type in lower case, and the first `charset` parameter as it is written. Space and tab are the only whitespace;
/// a parameter without `=` is passed over, and so is a quoted value that never closes.
fn parse_content_type(header: &str) -> (String, Option<String>) {
    let chars: Vec<char> = header.chars().collect();
    let len = chars.len();
    let is_ows = |c: char| c == ' ' || c == '\t';
    let skip_ows = |mut index: usize| {
        while index < len && is_ows(chars[index]) {
            index += 1;
        }
        index
    };
    let skip_value = |mut index: usize| {
        while index < len && chars[index] != ';' {
            index += 1;
        }
        index
    };
    let trailing_ows = |start: usize, mut end: usize| {
        while end > start && is_ows(chars[end - 1]) {
            end -= 1;
        }
        end
    };
    let text = |start: usize, end: usize| chars[start..end].iter().collect::<String>();

    let type_start = skip_ows(0);
    let mut index = skip_value(type_start);
    let media_type = text(type_start, trailing_ows(type_start, index)).to_lowercase();

    // Of a parameter given twice the first counts.
    let mut charset: Option<String> = None;
    'parameter: while index < len {
        index = skip_ows(index + 1); // Skip over ;
        let key_start = index;
        while index < len {
            match chars[index] {
                ';' => continue 'parameter,
                '=' => {
                    let is_charset = text(key_start, trailing_ows(key_start, index)).to_lowercase() == "charset";
                    index = skip_ows(index + 1);
                    if index < len && chars[index] == '"' {
                        index += 1;
                        let mut value = String::new();
                        while index < len {
                            let c = chars[index];
                            index += 1;
                            if c == '"' {
                                index = skip_value(index);
                                if is_charset && charset.is_none() {
                                    charset = Some(std::mem::take(&mut value));
                                }
                                break;
                            }
                            if c == '\\' && index < len {
                                value.push(chars[index]);
                                index += 1;
                                continue;
                            }
                            value.push(c);
                        }
                        continue 'parameter;
                    }
                    let value_start = index;
                    index = skip_value(index);
                    if is_charset && charset.is_none() {
                        charset = Some(text(value_start, trailing_ows(value_start, index)));
                    }
                    continue 'parameter;
                }
                _ => index += 1,
            }
        }
    }
    (media_type, charset)
}

/// What `express.json()` made of the request's body before the route ran: the parsed JSON (an object or an array;
/// `{}` for an empty body), `None` when the request has no body or its content type is not `application/json`, or
/// the 400 or 415 it answered with.
///
/// The Node server parsed every request's body this way before any route. Here the login route does it for itself,
/// and first of all, so that a body that is not JSON is answered without being counted as a sign-in attempt, as it
/// was.
fn json_body(headers: &HeaderMap, body: &Bytes) -> Result<Option<Value>, ApiError> {
    // A request that announces no body is passed by: neither a length nor a transfer encoding.
    let announced = headers.contains_key(TRANSFER_ENCODING)
        || node_header(headers, &CONTENT_LENGTH).is_some_and(|length| !js_number(&length).is_nan());
    if body.is_empty() && !announced {
        return Ok(None);
    }
    let (media_type, charset) = parse_content_type(&node_header(headers, &CONTENT_TYPE).unwrap_or_default());
    if media_type != "application/json" {
        return Ok(None);
    }
    // assert charset per RFC 7159 sec 8.1
    let charset = charset
        .map(|charset| charset.to_lowercase())
        .filter(|charset| !charset.is_empty())
        .unwrap_or_else(|| "utf-8".to_string());
    if charset != "utf-8" {
        // (The Node version also read the other charsets that start with "utf-": utf-16, utf-32, utf-7.)
        return Err(ApiError::new(
            415,
            format!("unsupported charset \"{}\"", charset.to_uppercase()),
        ));
    }
    if body.is_empty() {
        // special-case empty json body, as it's a common client-side mistake
        return Ok(Some(json!({})));
    }

    let text = String::from_utf8_lossy(body);
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    // Strict mode: only an object or an array is a body.
    let first = text.chars().find(|c| !matches!(c, ' ' | '\t' | '\n' | '\r'));
    match first {
        None => return Err(ApiError::new(400, "Unexpected end of JSON input")),
        Some('{') | Some('[') => {}
        Some(first) => return Err(ApiError::new(400, strict_violation(text, first))),
    }
    serde_json::from_str(text)
        .map(Some)
        .map_err(|err| ApiError::new(400, err.to_string()))
}

/// The message for a body that starts with something other than `{` or `[`, in the words of V8's JSON parser,
/// which is what the Node version answered: the first character, and the text around it (ten characters each way
/// when the body is longer than twenty).
fn strict_violation(text: &str, first: char) -> String {
    const CONTEXT: usize = 10;
    let length = utf16_len(text);
    let position = text
        .char_indices()
        .find(|(_, c)| *c == first)
        .map_or(0, |(index, _)| utf16_len(&text[..index]));
    if length < CONTEXT * 2 + 1 {
        return format!("Unexpected token '{first}', \"{text}\" is not valid JSON");
    }
    if position < CONTEXT {
        let shown = utf16_slice(text, 0, position + CONTEXT);
        format!("Unexpected token '{first}', \"{shown}\"... is not valid JSON")
    } else if position < length - CONTEXT {
        let shown = utf16_slice(text, position - CONTEXT, position + CONTEXT);
        format!("Unexpected token '{first}', ...\"{shown}\"... is not valid JSON")
    } else {
        let shown = utf16_slice(text, position - CONTEXT, length);
        format!("Unexpected token '{first}', ...\"{shown}\" is not valid JSON")
    }
}

fn audit(app: &App, action: &str, ip: &Option<String>) {
    if let Some(audit_log) = app.get::<AuditLog>() {
        audit_log.log(AuditEntry::new(action).actor("user").ip(ip.clone()));
    }
}

/// POST /api/auth/login
/// Body: { password: string }
/// Returns session cookie on success.
async fn login(State(app): State<App>, ClientIp(ip): ClientIp, headers: HeaderMap, body: Bytes) -> Response {
    let body = match json_body(&headers, &body) {
        Ok(body) => body,
        Err(refused) => return refused.into_response(),
    };

    // rateLimitAuth sits on THIS route only. Mounted on the whole router it also
    // throttled GET /status, which the web UI polls, so normal use burned the
    // 5-per-minute budget and locked people out of their own login.
    if let Err(refused) = AuthAttempts::of(&app).rate_limit(ip.as_deref()) {
        return refused.into_response();
    }

    let password = body
        .as_ref()
        .and_then(|body| body.get("password"))
        .and_then(Value::as_str)
        .filter(|password| !password.is_empty());
    let Some(password) = password else {
        return ApiError::new(400, "Password is required").into_response();
    };

    if app.config().setup_password.is_none() {
        return ApiError::new(500, "SETUP_PASSWORD not configured. Set it in environment variables.").into_response();
    }

    if !validate_password(&app, password) {
        audit(&app, "auth.login_failed", &ip);
        record_failed_attempt(&app, ip.as_deref());
        return ApiError::new(401, "Invalid password").into_response();
    }

    // Successful login: clear lockout
    clear_failed_attempts(&app, ip.as_deref());
    let session_id = create_session(&app, ip.as_deref());
    audit(&app, "auth.login", &ip);

    // Do NOT return the API token here: fetch it separately via /api/auth/api-token
    // (session-authenticated) so it doesn't end up in access logs or browser history.
    let response = Json(json!({ "ok": true })).into_response();
    with_cookie(&app, response, session_cookie(&app, &session_id))
}

/// GET /api/auth/api-token
/// Returns the API token for the authenticated session (used by WebSocket + external clients).
/// Requires an active session: the token is never returned in the login response body.
async fn api_token(State(app): State<App>, RequireAuth(_auth): RequireAuth) -> Response {
    (
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(json!({ "apiToken": app.config().api_token })),
    )
        .into_response()
}

/// POST /api/auth/logout
/// Ends this device's sign-in: the one its cookie names, also when the API token comes with it (the dashboard sends
/// both, and session_auth then names the request by the token, without the sign-in's id).
async fn logout(State(app): State<App>, auth: Auth, headers: HeaderMap) -> Response {
    let session_id = auth
        .session_id
        .filter(|session_id| !session_id.is_empty())
        .or_else(|| live_session_id(&app, &headers));
    if let Some(session_id) = session_id {
        destroy_session(&app, &session_id);
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    if let Ok(cleared) = HeaderValue::from_str(&clear_cookie("tarsee_session")) {
        response.headers_mut().append(SET_COOKIE, cleared);
    }
    response
}

/// GET /api/auth/csrf: a fresh CSRF cookie. The cookie is otherwise only set on
/// page loads, so a tab left open past the token's lifetime asks for a new one
/// (js/api.js refreshCsrf) instead of failing every send with "CSRF token
/// missing". Safe to hand out: the cookie is SameSite=Strict, and only this
/// site's pages can read it to send it back.
async fn csrf(State(app): State<App>) -> Response {
    let response = (
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(json!({ "ok": true })),
    )
        .into_response();
    with_cookie(&app, response, csrf_cookie(&app))
}

/// GET /api/auth/status
/// Returns current auth status (no password needed).
async fn status(State(app): State<App>, auth: Auth) -> Response {
    let response = Json(json!({
        "authenticated": auth.authenticated,
        "method": auth.method,
        "needsPassword": app.config().setup_password.is_some(),
    }))
    .into_response();
    // The dashboard asks this first as it opens. A live sign-in's cookie is set again with the lifetime it has now,
    // so a cookie from before the browser kept it past the sign-in gets that too.
    match auth.session_id.as_deref().filter(|session_id| !session_id.is_empty()) {
        Some(session_id) if auth.is_session() => with_cookie(&app, response, session_cookie(&app, session_id)),
        _ => response,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::middleware::from_fn_with_state;
    use rusqlite::params;

    use super::*;
    use crate::middleware::auth::{SessionStore, is_live_session, session_auth};
    use crate::middleware::security::Csrf;
    use crate::testkit::http::{self, TestResponse};
    use crate::testkit::{TestApp, test_app, test_app_with_env};

    /// 2026-11-12T14:54:14.663Z: when the Node version sent the Set-Cookie lines these tests expect.
    const T0: i64 = 1_794_495_254_663;
    const SESSION_COOKIE_TAIL: &str =
        "; Max-Age=34560000; Path=/; Expires=Fri, 17 Dec 2027 14:54:14 GMT; HttpOnly; SameSite=Strict";

    struct Fixture {
        t: TestApp,
        clock: Arc<Clock>,
        router: Router,
    }

    /// The routes as the server mounts them: under `/api/auth`, behind `session_auth`, with the sessions in the
    /// database and an audit log. The PIN is 1234.
    fn fixture_with_env(extra: &[(&str, &str)]) -> Fixture {
        let mut env = vec![
            ("SETUP_PASSWORD", "1234"),
            ("TARSEE_API_TOKEN", "fixture-api-token-not-a-secret"),
        ];
        env.extend_from_slice(extra);
        let t = test_app_with_env(env);
        let clock = t.app.set(Clock::manual(T0));
        SessionStore::init(&t).unwrap();
        AuditLog::init(&t);
        let router = mounted(&t);
        Fixture { t, clock, router }
    }

    fn fixture() -> Fixture {
        fixture_with_env(&[])
    }

    fn mounted(t: &TestApp) -> Router {
        Router::new()
            .nest("/api/auth", router())
            .layer(from_fn_with_state(t.app.clone(), session_auth))
            .with_state(t.app.clone())
    }

    impl Fixture {
        async fn get(&self, path: &str, headers: &[(&str, &str)]) -> TestResponse {
            let mut request = http::request("GET", path);
            for (name, value) in headers {
                request = request.header(name, value);
            }
            http::send(&self.router, request).await
        }

        /// A sign-in attempt with this JSON body from this address.
        async fn login(&self, body: Value, ip: &str) -> TestResponse {
            http::send(
                &self.router,
                http::request("POST", "/api/auth/login")
                    .header("x-forwarded-for", ip)
                    .json(&body),
            )
            .await
        }

        /// A sign-in attempt with this body as it is, and this content type (none for `None`).
        async fn login_raw(&self, content_type: Option<&str>, body: &str, ip: &str) -> TestResponse {
            let mut request = http::request("POST", "/api/auth/login").header("x-forwarded-for", ip);
            if let Some(content_type) = content_type {
                request = request.header("content-type", content_type);
            }
            http::send(&self.router, request.body(body.to_string())).await
        }

        /// Signs in from this address and gives the sign-in's id.
        async fn sign_in(&self, ip: &str) -> String {
            let response = self.login(json!({ "password": "1234" }), ip).await;
            assert_eq!(response.status, 200, "{}", response.text());
            response.cookie("tarsee_session").unwrap()
        }

        fn audit_rows(&self) -> Value {
            let rows = self
                .t
                .db()
                .with(|c| {
                    crate::db::all(
                        c,
                        "SELECT action, target, actor, ip, detail FROM audit_log ORDER BY id",
                        [],
                    )
                })
                .unwrap();
            Value::Array(rows.into_iter().map(Value::Object).collect())
        }

        fn session_count(&self) -> i64 {
            self.t
                .db()
                .with(|c| c.query_row("SELECT count(*) FROM sessions", [], |r| r.get(0)))
                .unwrap()
        }
    }

    fn body_of(response: &TestResponse) -> (u16, String) {
        (response.status, response.text())
    }

    // --- GET /status ---

    #[tokio::test]
    async fn status_says_who_the_request_is() {
        let f = fixture();
        // The bodies the Node version sent.
        let nobody = f.get("/api/auth/status", &[]).await;
        assert_eq!(
            body_of(&nobody),
            (
                200,
                r#"{"authenticated":false,"method":null,"needsPassword":true}"#.to_string()
            )
        );
        assert_eq!(nobody.set_cookies(), Vec::<String>::new());
        assert_eq!(nobody.header("content-type"), Some("application/json"));

        let id = f.sign_in("203.0.113.24").await;
        let by_cookie = f
            .get("/api/auth/status", &[("cookie", &format!("tarsee_session={id}"))])
            .await;
        assert_eq!(
            by_cookie.text(),
            r#"{"authenticated":true,"method":"session","needsPassword":true}"#
        );
        // A live sign-in's cookie is set again, with the lifetime it has now.
        assert_eq!(
            by_cookie.set_cookies(),
            [format!("tarsee_session={id}{SESSION_COOKIE_TAIL}")]
        );

        let bearer = [("authorization", "Bearer fixture-api-token-not-a-secret")];
        let by_token = f.get("/api/auth/status", &bearer).await;
        assert_eq!(
            by_token.text(),
            r#"{"authenticated":true,"method":"bearer","needsPassword":true}"#
        );
        assert_eq!(by_token.set_cookies(), Vec::<String>::new());
        // The dashboard sends both: named by the token, and the cookie is not set again.
        let both = f
            .get(
                "/api/auth/status",
                &[bearer[0], ("cookie", &format!("tarsee_session={id}"))],
            )
            .await;
        assert_eq!(
            both.text(),
            r#"{"authenticated":true,"method":"bearer","needsPassword":true}"#
        );
        assert_eq!(both.set_cookies(), Vec::<String>::new());

        for nobody in [
            [("authorization", "Bearer nope")],
            [("authorization", "bearer fixture-api-token-not-a-secret")],
            [("cookie", &*format!("xtarsee_session={id}"))],
            [("cookie", &*format!("tarsee_session={}", "0".repeat(64)))],
        ] {
            let response = f.get("/api/auth/status", &nobody).await;
            assert_eq!(
                response.text(),
                r#"{"authenticated":false,"method":null,"needsPassword":true}"#,
                "{nobody:?}"
            );
        }
        for found in [
            format!("a=b; tarsee_session={id} ; c=d"),
            format!("a=b;tarsee_session={id}"),
        ] {
            let response = f.get("/api/auth/status", &[("cookie", &found)]).await;
            assert_eq!(response.json()["method"], "session", "{found}");
        }
    }

    #[tokio::test]
    async fn status_says_when_no_password_is_set() {
        let t = test_app();
        let response = http::get(&mounted(&t), "/api/auth/status").await;
        assert_eq!(
            response.text(),
            r#"{"authenticated":false,"method":null,"needsPassword":false}"#
        );
    }

    // --- POST /login ---

    #[tokio::test]
    async fn the_right_password_signs_in_and_sets_the_cookie() {
        let f = fixture();
        let response = f.login(json!({ "password": "1234" }), "203.0.113.24").await;
        // Node: 200 {"ok":true} and
        // Set-Cookie: tarsee_session=<64 hex>; Max-Age=34560000; Path=/; Expires=Fri, 17 Dec 2027 14:54:14 GMT; HttpOnly; SameSite=Strict
        assert_eq!(body_of(&response), (200, r#"{"ok":true}"#.to_string()));
        let id = response.cookie("tarsee_session").unwrap();
        assert_eq!(id.len(), 64);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(
            response.set_cookies(),
            [format!("tarsee_session={id}{SESSION_COOKIE_TAIL}")]
        );
        // The API token is not in the answer.
        assert!(!response.text().contains("fixture-api-token"));

        assert!(is_live_session(&f.t, &id));
        // The sign-in is on disk under its hash, with the address it came from.
        let (stored_id, stored_ip): (String, String) =
            f.t.db()
                .with(|c| c.query_row("SELECT id, ip FROM sessions", [], |r| Ok((r.get(0)?, r.get(1)?))))
                .unwrap();
        assert!(stored_id.starts_with("sha256:") && !stored_id.contains(&id));
        assert_eq!(stored_ip, "203.0.113.24");
        assert_eq!(
            f.audit_rows(),
            json!([{ "action": "auth.login", "target": null, "actor": "user", "ip": "203.0.113.24", "detail": null }])
        );
    }

    #[tokio::test]
    async fn a_wrong_password_is_refused_and_written_to_the_audit_log() {
        let f = fixture();
        let response = f.login(json!({ "password": "0000" }), "203.0.113.23").await;
        assert_eq!(body_of(&response), (401, r#"{"error":"Invalid password"}"#.to_string()));
        assert_eq!(response.set_cookies(), Vec::<String>::new());
        // A padded PIN is a wrong PIN.
        let padded = f.login(json!({ "password": " 1234 " }), "203.0.113.25").await;
        assert_eq!(padded.status, 401);
        assert_eq!(f.session_count(), 0);
        assert_eq!(
            f.audit_rows(),
            json!([
                { "action": "auth.login_failed", "target": null, "actor": "user", "ip": "203.0.113.23", "detail": null },
                { "action": "auth.login_failed", "target": null, "actor": "user", "ip": "203.0.113.25", "detail": null },
            ])
        );
    }

    /// The port of "rejects non-string" of `test/auth.test.js` (`validatePassword(null)`, `(undefined)`, `(123)`):
    /// a password that is not text never reaches the comparison.
    #[tokio::test]
    async fn rejects_non_string() {
        let f = fixture();
        let required = (400, r#"{"error":"Password is required"}"#.to_string());
        for (n, body) in [
            json!({ "password": null }),
            json!({}),
            json!({ "password": 1234 }),
            json!({ "password": "" }),
            json!({ "password": { "a": 1 } }),
            json!({ "password": ["1234"] }),
            json!({ "password": true }),
            json!(["1234"]),
            json!({ "__proto__": { "password": "1234" } }),
        ]
        .into_iter()
        .enumerate()
        {
            let response = f.login(body.clone(), &format!("203.0.113.{n}")).await;
            assert_eq!(body_of(&response), required, "{body}");
        }
        assert_eq!(f.audit_rows(), json!([]), "none of them was a failed sign-in");
        assert_eq!(f.session_count(), 0);
    }

    #[tokio::test]
    async fn the_body_is_read_as_express_json_read_it() {
        let f = fixture();
        let json = Some("application/json");
        let required = (400, r#"{"error":"Password is required"}"#.to_string());
        let ok = (200, r#"{"ok":true}"#.to_string());
        let good = r#"{"password":"1234"}"#;
        let mut n = 0;
        let mut ip = || {
            n += 1;
            format!("203.0.113.{n}")
        };

        // What the Node version answered to each.
        assert_eq!(body_of(&f.login_raw(json, good, &ip()).await), ok);
        assert_eq!(
            body_of(&f.login_raw(Some("application/json; charset=utf-8"), good, &ip()).await),
            ok
        );
        assert_eq!(body_of(&f.login_raw(Some("APPLICATION/JSON"), good, &ip()).await), ok);
        assert_eq!(
            body_of(&f.login_raw(json, "  \n {\"password\":\"1234\"}", &ip()).await),
            ok
        );
        assert_eq!(
            body_of(&f.login_raw(json, "\u{FEFF}{\"password\":\"1234\"}", &ip()).await),
            ok
        );
        assert_eq!(
            body_of(&f.login_raw(json, r#"{"password":"1234","x":1}"#, &ip()).await),
            ok
        );
        assert_eq!(
            body_of(
                &f.login_raw(json, r#"{"password":"0000","password":"1234"}"#, &ip())
                    .await
            ),
            ok,
            "of a key given twice the last one counts"
        );
        // A body that is not JSON by its content type is no body.
        for not_json in [
            Some("text/plain"),
            None,
            Some("application/vnd.api+json"),
            Some("application/x-www-form-urlencoded"),
        ] {
            assert_eq!(
                body_of(&f.login_raw(not_json, good, &ip()).await),
                required,
                "{not_json:?}"
            );
        }
        assert_eq!(body_of(&f.login_raw(json, "", &ip()).await), required);
        assert_eq!(body_of(&f.login_raw(None, "", &ip()).await), required);

        // JSON that is not an object or an array, in V8's words.
        for (body, message) in [
            ("hello", r#"Unexpected token 'h', "hello" is not valid JSON"#),
            (r#""1234""#, r#"Unexpected token '"', ""1234"" is not valid JSON"#),
            ("1234", r#"Unexpected token '1', "1234" is not valid JSON"#),
            ("null", r#"Unexpected token 'n', "null" is not valid JSON"#),
            ("  hello", r#"Unexpected token 'h', "  hello" is not valid JSON"#),
            (
                "xxxxxxxxxxxxxxxxxxxxx",
                r#"Unexpected token 'x', "xxxxxxxxxx"... is not valid JSON"#,
            ),
            (
                "               yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
                r#"Unexpected token 'y', ..."          yyyyyyyyyy"... is not valid JSON"#,
            ),
            (
                "                              true",
                r#"Unexpected token 't', ..."          true" is not valid JSON"#,
            ),
            (
                "            12345",
                r#"Unexpected token '1', "            12345" is not valid JSON"#,
            ),
            ("   ", "Unexpected end of JSON input"),
            ("\t\n true", "Unexpected token 't', \"\t\n true\" is not valid JSON"),
            (
                "éééééééééééééééééééééééééééééé",
                r#"Unexpected token 'é', "éééééééééé"... is not valid JSON"#,
            ),
        ] {
            let response = f.login_raw(json, body, &ip()).await;
            assert_eq!(
                (response.status, response.json()),
                (400, json!({ "error": message })),
                "{body:?}"
            );
        }
        // An object that does not parse: a 400 with the parser's message (not V8's words).
        let malformed = f.login_raw(json, r#"{"password":"#, &ip()).await;
        assert_eq!(malformed.status, 400);
        assert!(malformed.json()["error"].is_string());

        let latin1 = f.login_raw(Some("application/json; charset=latin1"), good, &ip()).await;
        assert_eq!(
            body_of(&latin1),
            (415, r#"{"error":"unsupported charset \"LATIN1\""}"#.to_string())
        );
    }

    /// `express.json` (body-parser 2.4, the `content-type` package 2.1) was sent the same body `{"a":1}` with each
    /// of these Content-Type headers: whether it parsed the body, passed it by, or refused the charset. A route
    /// that needs a password shows the three as 200, 400 "Password is required" and 415.
    #[tokio::test]
    async fn the_content_type_decides_as_it_did_for_express_json() {
        let f = fixture();
        let good = r#"{"password":"1234"}"#;
        let mut n = 0;
        let mut ip = || {
            n += 1;
            format!("203.0.113.{n}")
        };
        let parsed = (200, r#"{"ok":true}"#.to_string());
        let passed_by = (400, r#"{"error":"Password is required"}"#.to_string());
        let refused = |charset: &str| (415, format!(r#"{{"error":"unsupported charset \"{charset}\""}}"#));

        for (content_type, expected) in [
            ("application/json", parsed.clone()),
            ("application/json ; charset=utf-8", parsed.clone()),
            ("application/json;charset=utf-8", parsed.clone()),
            ("APPLICATION/JSON\t; charset=utf-8", parsed.clone()),
            ("application/json; CHARSET=UTF-8", parsed.clone()),
            ("application/json; charset = \"utf-8\"", parsed.clone()),
            ("application/json;\tcharset=utf-8", parsed.clone()),
            ("application/json; a=b; charset=UTF-8", parsed.clone()),
            // A parameter that is no parameter is passed over, and an empty charset is no charset.
            ("application/json; charset", parsed.clone()),
            ("application/json; charset=", parsed.clone()),
            ("application/json; charset=\"\"", parsed.clone()),
            ("application/json; charset=\"utf-8", parsed.clone()),
            ("application/json;", parsed.clone()),
            ("application/json; x", parsed.clone()),
            ("application/json; x=\";charset=latin1\"", parsed.clone()),
            // Of two charsets the first counts.
            ("application/json; charset=utf-8; charset=latin1", parsed.clone()),
            ("application/json; charset=latin1; charset=utf-8", refused("LATIN1")),
            ("application/json; charset=latin1", refused("LATIN1")),
            ("application/json; charset=\"latin1\"", refused("LATIN1")),
            ("application/json; x=\"a;b\"; charset=latin1", refused("LATIN1")),
            ("application/json;charset=latin1;", refused("LATIN1")),
            ("application/json;;charset=latin1", refused("LATIN1")),
            ("application/json; charset=utf8", refused("UTF8")),
            ("application/json; charset=utf-foo", refused("UTF-FOO")),
            // Another type, however close.
            ("application/jsonx", passed_by.clone()),
            ("application/json/x", passed_by.clone()),
            ("application/json , text/plain", passed_by.clone()),
            ("application/vnd.api+json", passed_by.clone()),
            ("text/plain", passed_by.clone()),
        ] {
            let response = f.login_raw(Some(content_type), good, &ip()).await;
            assert_eq!(body_of(&response), expected, "{content_type:?}");
        }

        // Bytes outside ASCII after the type are part of it (only space and tab are trimmed).
        for byte in [0xA0u8, 0x85] {
            let mut value = b"application/json".to_vec();
            value.push(byte);
            let request = axum::http::Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header("x-forwarded-for", ip())
                .header("content-type", HeaderValue::from_bytes(&value).unwrap())
                .body(axum::body::Body::from(good))
                .unwrap();
            assert_eq!(
                body_of(&http::send(&f.router, request).await),
                passed_by,
                "0x{byte:02X}"
            );
        }

        // An empty body that is announced is `{}`, and its charset is still looked at; one that is not announced
        // is no body at all.
        let empty = |content_type: &'static str, length: Option<&'static str>, address: String| {
            let mut request = http::request("POST", "/api/auth/login")
                .header("x-forwarded-for", address)
                .header("content-type", content_type);
            if let Some(length) = length {
                request = request.header("content-length", length);
            }
            http::send(&f.router, request)
        };
        assert_eq!(
            body_of(&empty("application/json; charset=latin1", Some("0"), ip()).await),
            refused("LATIN1")
        );
        assert_eq!(body_of(&empty("application/json", Some("0"), ip()).await), passed_by);
        assert_eq!(
            body_of(&empty("application/json; charset=latin1", None, ip()).await),
            passed_by
        );
    }

    #[test]
    fn a_content_type_header_is_taken_apart_as_the_content_type_package_did() {
        let parse = |header: &str| {
            let (media_type, charset) = parse_content_type(header);
            (media_type, charset.unwrap_or_else(|| "(none)".to_string()))
        };
        let of = |media_type: &str, charset: &str| (media_type.to_string(), charset.to_string());
        assert_eq!(parse(""), of("", "(none)"));
        assert_eq!(parse("  Application/JSON \t"), of("application/json", "(none)"));
        assert_eq!(parse("text/html; charset=UTF-8"), of("text/html", "UTF-8"));
        assert_eq!(
            parse("text/html ;\t Charset \t=  utf-8  ; x=y"),
            of("text/html", "utf-8")
        );
        assert_eq!(
            parse("text/html; charset=\"a\\\"b;c\" ignored; x=y"),
            of("text/html", "a\"b;c")
        );
        assert_eq!(parse("text/html; charset=\"open"), of("text/html", "(none)"));
        assert_eq!(parse("text/html; charset; charset=b"), of("text/html", "b"));
        assert_eq!(parse("text/html; charset=a; charset=b"), of("text/html", "a"));
        assert_eq!(parse("text/html; xcharset=a"), of("text/html", "(none)"));
        assert_eq!(parse("text/html;charset="), of("text/html", ""));
        assert_eq!(parse("; charset=a"), of("", "a"));
    }

    #[tokio::test]
    async fn without_a_password_set_nobody_can_sign_in() {
        let t = test_app();
        let response = http::post_json(&mounted(&t), "/api/auth/login", &json!({ "password": "1234" })).await;
        assert_eq!(
            body_of(&response),
            (
                500,
                r#"{"error":"SETUP_PASSWORD not configured. Set it in environment variables."}"#.to_string()
            )
        );
    }

    /// What the Node server answered to each of these sign-ins. JavaScript's `trim()`, which the configuration
    /// applies to SETUP_PASSWORD, removes a byte order mark and keeps a next-line character; Rust's own does the
    /// opposite.
    #[tokio::test]
    async fn a_pin_set_with_a_byte_order_mark_or_a_next_line_character_signs_in_as_under_node() {
        // SETUP_PASSWORD = "1234" + U+FEFF: the mark is trimmed away and the PIN is 1234.
        let bom = fixture_with_env(&[("SETUP_PASSWORD", "1234\u{FEFF}")]);
        assert_eq!(
            bom.login(json!({ "password": "1234" }), "203.0.113.1").await.status,
            200
        );
        assert_eq!(
            bom.login(json!({ "password": "1234\u{FEFF}" }), "203.0.113.2")
                .await
                .status,
            401
        );
        assert_eq!(
            bom.login(json!({ "password": "\u{85}1234" }), "203.0.113.3")
                .await
                .status,
            401
        );

        // SETUP_PASSWORD = U+0085 + "1234": the character is part of the PIN.
        let nel = fixture_with_env(&[("SETUP_PASSWORD", "\u{85}1234")]);
        assert_eq!(
            nel.login(json!({ "password": "1234" }), "203.0.113.1").await.status,
            401
        );
        assert_eq!(
            nel.login(json!({ "password": "1234\u{FEFF}" }), "203.0.113.2")
                .await
                .status,
            401
        );
        assert_eq!(
            nel.login(json!({ "password": "\u{85}1234" }), "203.0.113.3")
                .await
                .status,
            200
        );
    }

    #[tokio::test]
    async fn in_production_the_cookie_is_secure() {
        let f = fixture_with_env(&[("NODE_ENV", "production")]);
        let response = f.login(json!({ "password": "1234" }), "203.0.113.24").await;
        let id = response.cookie("tarsee_session").unwrap();
        assert_eq!(
            response.set_cookies(),
            [format!(
                "tarsee_session={id}; Max-Age=34560000; Path=/; Expires=Fri, 17 Dec 2027 14:54:14 GMT; HttpOnly; Secure; SameSite=Strict"
            )]
        );
    }

    #[tokio::test]
    async fn signing_in_works_without_an_audit_log_or_a_known_address() {
        let t = test_app_with_env([("SETUP_PASSWORD", "1234")]);
        let router = mounted(&t);
        let wrong = http::post_json(&router, "/api/auth/login", &json!({ "password": "0000" })).await;
        assert_eq!(wrong.status, 401);
        let right = http::post_json(&router, "/api/auth/login", &json!({ "password": "1234" })).await;
        assert_eq!(right.status, 200);
        assert!(is_live_session(&t, &right.cookie("tarsee_session").unwrap()));
    }

    // --- The limits on sign-in attempts ---

    #[tokio::test]
    async fn four_wrong_passwords_lock_the_address_out() {
        let f = fixture();
        let wrong = json!({ "password": "0000" });
        // Node: 401 four times, then 429 "Locked out. Try again in 30s." with Retry-After: 30.
        for _ in 0..4 {
            let response = f.login(wrong.clone(), "203.0.113.50").await;
            assert_eq!(body_of(&response), (401, r#"{"error":"Invalid password"}"#.to_string()));
        }
        for _ in 0..3 {
            let response = f.login(wrong.clone(), "203.0.113.50").await;
            assert_eq!(
                body_of(&response),
                (429, r#"{"error":"Locked out. Try again in 30s."}"#.to_string())
            );
            assert_eq!(response.header("retry-after"), Some("30"));
        }
        // The right password is locked out too, and another address is not.
        let right = f.login(json!({ "password": "1234" }), "203.0.113.50").await;
        assert_eq!(right.status, 429);
        assert_eq!(f.login(json!({ "password": "1234" }), "203.0.113.51").await.status, 200);
        // Only the four attempts that were let through were failed sign-ins.
        assert_eq!(f.audit_rows().as_array().unwrap().len(), 5);

        f.clock.advance(30_000);
        assert_eq!(f.login(json!({ "password": "1234" }), "203.0.113.50").await.status, 200);
    }

    #[tokio::test]
    async fn every_attempt_counts_against_five_a_minute_except_a_body_that_is_not_json() {
        let f = fixture();
        let too_many = (429, r#"{"error":"Too many attempts. Try again later."}"#.to_string());
        // Node: six bodies that do not parse are six 400s and leave the count alone.
        for _ in 0..6 {
            let response = f.login_raw(Some("application/json"), "{", "198.51.100.1").await;
            assert_eq!(response.status, 400);
        }
        let after = f.login(json!({ "password": "0000" }), "198.51.100.1").await;
        assert_eq!(after.status, 401);

        // An attempt without a password counts: five 400s, then the limit.
        for _ in 0..5 {
            let response = f.login(json!({}), "198.51.100.2").await;
            assert_eq!(response.status, 400);
        }
        let sixth = f.login(json!({}), "198.51.100.2").await;
        assert_eq!(body_of(&sixth), too_many);
        assert_eq!(sixth.header("retry-after"), Some("60"));

        // So does the right password: five sign-ins, then the limit.
        for _ in 0..5 {
            assert_eq!(f.login(json!({ "password": "1234" }), "198.51.100.3").await.status, 200);
        }
        let sixth = f.login(json!({ "password": "1234" }), "198.51.100.3").await;
        assert_eq!(body_of(&sixth), too_many);

        // A minute later the address may try again.
        f.clock.advance(60_000);
        assert_eq!(f.login(json!({ "password": "1234" }), "198.51.100.3").await.status, 200);
    }

    #[tokio::test]
    async fn the_right_password_clears_the_failures() {
        let f = fixture();
        let wrong = json!({ "password": "0000" });
        let ip = "198.51.100.4";
        for _ in 0..3 {
            assert_eq!(f.login(wrong.clone(), ip).await.status, 401);
        }
        assert_eq!(f.login(json!({ "password": "1234" }), ip).await.status, 200);
        // The fourth failure in a row would have locked the address; after a sign-in it is the first again.
        assert_eq!(f.login(wrong.clone(), ip).await.status, 401);
        // What Node answered to the sixth attempt in the window: the window's limit, not a lock.
        let sixth = f.login(wrong.clone(), ip).await;
        assert_eq!(
            body_of(&sixth),
            (429, r#"{"error":"Too many attempts. Try again later."}"#.to_string())
        );
        f.clock.advance(60_000);
        assert_eq!(
            f.login(wrong, ip).await.status,
            401,
            "not locked: two failures since the sign-in"
        );
    }

    #[tokio::test]
    async fn the_address_is_the_last_hop_of_x_forwarded_for() {
        let f = fixture();
        // One client behind the proxy uses up its five attempts; the address it claims to be does not matter.
        for claimed in ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"] {
            let response = f
                .login(json!({ "password": "0000" }), &format!("{claimed}, 203.0.113.9"))
                .await;
            assert_ne!(response.status, 200);
        }
        let sixth = f.login(json!({ "password": "0000" }), "10.0.0.6, 203.0.113.9").await;
        assert_eq!(sixth.status, 429);
        // Someone else behind the same proxy is not held back.
        let other = f.login(json!({ "password": "1234" }), "10.0.0.1, 203.0.113.10").await;
        assert_eq!(other.status, 200);
        assert_eq!(
            f.audit_rows()[0]["ip"],
            "203.0.113.9",
            "the audit log has the address the proxy saw"
        );
    }

    // --- GET /api-token ---

    #[tokio::test]
    async fn the_api_token_is_given_to_a_signed_in_request_only() {
        let f = fixture();
        // Node's answers.
        let nobody = f.get("/api/auth/api-token", &[]).await;
        assert_eq!(
            body_of(&nobody),
            (401, r#"{"error":"Authentication required"}"#.to_string())
        );
        let id = f.sign_in("203.0.113.24").await;
        let signed_in = f
            .get("/api/auth/api-token", &[("cookie", &format!("tarsee_session={id}"))])
            .await;
        assert_eq!(
            body_of(&signed_in),
            (200, r#"{"apiToken":"fixture-api-token-not-a-secret"}"#.to_string())
        );
        assert_eq!(signed_in.header("cache-control"), Some("no-store"));
        let by_token = f
            .get(
                "/api/auth/api-token",
                &[("authorization", "Bearer fixture-api-token-not-a-secret")],
            )
            .await;
        assert_eq!(by_token.status, 200);

        let ended = f
            .get(
                "/api/auth/api-token",
                &[("cookie", &format!("tarsee_session={}", "0".repeat(64)))],
            )
            .await;
        assert_eq!(
            body_of(&ended),
            (
                401,
                r#"{"error":"Your sign-in has run out. Sign in again, then try once more.","needsSignIn":true}"#
                    .to_string()
            )
        );
        assert_eq!(ended.header("cache-control"), None);
    }

    // --- POST /logout ---

    #[tokio::test]
    async fn logout_ends_the_sign_in_and_clears_the_cookie() {
        let f = fixture();
        let id = f.sign_in("203.0.113.24").await;
        let session = format!("tarsee_session={id}");
        let response = http::send(
            &f.router,
            http::request("POST", "/api/auth/logout").header("cookie", &session),
        )
        .await;
        // Node: 200 {"ok":true} and Set-Cookie: tarsee_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT
        assert_eq!(body_of(&response), (200, r#"{"ok":true}"#.to_string()));
        assert_eq!(
            response.set_cookies(),
            ["tarsee_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]
        );
        assert!(!is_live_session(&f.t, &id));
        assert_eq!(f.session_count(), 0);

        let after = f.get("/api/auth/status", &[("cookie", &session)]).await;
        assert_eq!(
            after.text(),
            r#"{"authenticated":false,"method":null,"needsPassword":true}"#
        );
        // The page's next request with the old cookie is told the sign-in is over.
        let token = f.get("/api/auth/api-token", &[("cookie", &session)]).await;
        assert_eq!(token.json()["needsSignIn"], true);
    }

    #[tokio::test]
    async fn logout_ends_the_cookies_sign_in_also_when_the_api_token_comes_with_it() {
        let f = fixture();
        let id = f.sign_in("203.0.113.24").await;
        let other = f.sign_in("203.0.113.25").await;
        let response = http::send(
            &f.router,
            http::request("POST", "/api/auth/logout")
                .header("authorization", "Bearer fixture-api-token-not-a-secret")
                .header("cookie", format!("tarsee_session={id}")),
        )
        .await;
        assert_eq!(response.status, 200);
        assert!(!is_live_session(&f.t, &id));
        assert!(is_live_session(&f.t, &other), "only this device's sign-in ends");

        // With nothing to end it still answers and clears the cookie.
        let nothing = http::send(&f.router, http::request("POST", "/api/auth/logout")).await;
        assert_eq!(body_of(&nothing), (200, r#"{"ok":true}"#.to_string()));
        assert_eq!(nothing.set_cookies().len(), 1);
        assert_eq!(f.session_count(), 1);
    }

    // --- GET /csrf ---

    #[tokio::test]
    async fn csrf_hands_out_a_fresh_cookie() {
        let f = fixture();
        let response = f.get("/api/auth/csrf", &[]).await;
        assert_eq!(body_of(&response), (200, r#"{"ok":true}"#.to_string()));
        assert_eq!(response.header("cache-control"), Some("no-store"));
        let token = response.cookie("tarsee_csrf").unwrap();
        // Node: Set-Cookie: tarsee_csrf=<ms>.<64 hex>; Max-Age=86400; Path=/; Expires=Fri, 13 Nov 2026 14:54:14 GMT; SameSite=Strict
        assert_eq!(
            response.set_cookies(),
            [format!(
                "tarsee_csrf={token}; Max-Age=86400; Path=/; Expires=Fri, 13 Nov 2026 14:54:14 GMT; SameSite=Strict"
            )]
        );
        assert!(token.starts_with("1794495254663.") && token.len() == 14 + 64);
        assert!(Csrf::of(&f.t).verify(&token));
    }

    // --- An install the Node version ran ---

    #[tokio::test]
    async fn a_browser_signed_in_under_the_node_version_stays_signed_in() {
        // The cookie a browser holds and the row the Node version wrote for it.
        let node_cookie = "1227bf8bec11601c3aa1b25687e1a3461bbd55e6e573ca0a1393da0829ab2d7b";
        let t = test_app_with_env([("SETUP_PASSWORD", "1234")]);
        t.app.set(Clock::manual(1_794_495_620_876 + 86_400_000));
        t.db()
            .with(|c| {
                c.execute_batch(
                    "CREATE TABLE sessions (\n    id TEXT PRIMARY KEY,\n    created_at INTEGER NOT NULL,\n    ip TEXT\n  )",
                )?;
                c.execute(
                    "INSERT INTO sessions (id, created_at, ip) VALUES (?, ?, ?)",
                    params![
                        "sha256:9d968485aecac3bc0dd62927f1ef132dd628994d0a354bd33ff889ad39a2e4dc",
                        1_794_495_620_876_i64,
                        "203.0.113.5"
                    ],
                )
            })
            .unwrap();
        SessionStore::init(&t).unwrap();
        let router = mounted(&t);
        let session = format!("tarsee_session={node_cookie}");

        let status = http::send(
            &router,
            http::request("GET", "/api/auth/status").header("cookie", &session),
        )
        .await;
        assert_eq!(
            status.text(),
            r#"{"authenticated":true,"method":"session","needsPassword":true}"#
        );
        assert_eq!(status.cookie("tarsee_session").as_deref(), Some(node_cookie));
        let token = http::send(
            &router,
            http::request("GET", "/api/auth/api-token").header("cookie", &session),
        )
        .await;
        assert_eq!(token.json(), json!({ "apiToken": t.config().api_token }));
    }

    #[tokio::test]
    async fn a_cookie_lifetime_no_cookie_can_carry_is_the_error_express_threw() {
        let f = fixture_with_env(&[("TARSEE_SESSION_MAX_AGE_DAYS", "Infinity")]);
        let response = f.login(json!({ "password": "1234" }), "203.0.113.24").await;
        assert_eq!(
            (response.status, response.json()),
            (
                500,
                json!({ "error": "Internal server error", "detail": "option maxAge is invalid" })
            )
        );
        assert_eq!(response.set_cookies(), Vec::<String>::new());
    }
}
