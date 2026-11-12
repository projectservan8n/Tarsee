//! Tests of `middleware/auth.rs`: ports of `test/auth.test.js` and `test/auth-timers.test.js`, the proof that a
//! sign-in the Node version stored is still accepted, and the cases the Node tests left out.

use axum::Router;
use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use serde_json::{Value, json};

use super::*;
use crate::testkit::{TestApp, http, test_app, test_app_with_env};

/// A moment for the manual clock: when the Node fixture's sign-in was made.
const T0: i64 = 1_794_495_620_876;

/// A sign-in the Node version made (`createSession("203.0.113.5")` after `initSessionStore(db)`): the id it put in
/// the cookie, and the row it wrote to the sessions table.
const NODE_SESSION_ID: &str = "1227bf8bec11601c3aa1b25687e1a3461bbd55e6e573ca0a1393da0829ab2d7b";
const NODE_SESSION_ROW: (&str, i64, &str) = (
    "sha256:9d968485aecac3bc0dd62927f1ef132dd628994d0a354bd33ff889ad39a2e4dc",
    1_794_495_620_876,
    "203.0.113.5",
);

fn app() -> TestApp {
    // Set env before using the auth module
    test_app_with_env([("SETUP_PASSWORD", "test-password-123")])
}

/// An app whose clock stands at `T0` until the test moves it.
fn app_at_t0() -> (TestApp, Arc<Clock>) {
    let t = app();
    let clock = t.app.set(Clock::manual(T0));
    (t, clock)
}

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_bytes(value.as_bytes()).unwrap(),
        );
    }
    map
}

fn cookie(session_id: &str) -> HeaderMap {
    headers(&[("cookie", &format!("tarsee_session={session_id}"))])
}

fn session_rows(t: &TestApp) -> Vec<(String, i64, Option<String>)> {
    t.db()
        .with(|c| {
            c.prepare("SELECT id, created_at, ip FROM sessions ORDER BY created_at, id")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

// --- validatePassword (test/auth.test.js) ---

#[test]
fn accepts_correct_password() {
    assert!(validate_password(&app(), "test-password-123"));
}

#[test]
fn rejects_wrong_password() {
    assert!(!validate_password(&app(), "wrong-password"));
}

#[test]
fn rejects_empty_password() {
    assert!(!validate_password(&app(), ""));
}

#[test]
fn rejects_non_string() {
    // The JS was given null, undefined and 123. Only text can be passed here; a password that is not a string
    // in the request is refused by the route before it gets this far (routes/auth_routes.rs tests it). What is
    // left to check is that the texts of those values are just wrong passwords.
    let t = app();
    for not_a_password in ["null", "undefined", "123"] {
        assert!(!validate_password(&t, not_a_password));
    }
}

#[test]
fn nothing_is_the_password_when_none_is_set_and_the_comparison_is_exact() {
    let none_set = test_app();
    assert!(!validate_password(&none_set, ""));
    assert!(!validate_password(&none_set, "test-password-123"));
    // As Node answered: a padded PIN is not the PIN, a longer one neither.
    let t = test_app_with_env([("SETUP_PASSWORD", "1234")]);
    assert!(validate_password(&t, "1234"));
    assert!(!validate_password(&t, "12345"));
    assert!(!validate_password(&t, " 1234"));
    assert!(!validate_password(&t, "123"));
    // The password is compared as UTF-8 bytes.
    let t = test_app_with_env([("SETUP_PASSWORD", "pässwörd ✓")]);
    assert!(validate_password(&t, "pässwörd ✓"));
    assert!(!validate_password(&t, "passwörd ✓"));
}

// --- validateApiToken ---

#[test]
fn accepts_the_generated_api_token() {
    let t = app();
    let token = t.config().api_token.clone();
    assert_eq!(token.len(), 64);
    assert!(validate_api_token(&t, &token));
}

#[test]
fn rejects_wrong_token() {
    let t = app();
    assert!(!validate_api_token(&t, "not-the-right-token"));
    assert!(!validate_api_token(&t, ""));
    assert!(!validate_api_token(&t, &format!("{} ", t.config().api_token)));
}

// --- sessions ---

#[test]
fn creates_and_validates_sessions() {
    let t = app();
    let session_id = create_session(&t, Some("127.0.0.1"));
    assert!(session_id.len() >= 32);
    // 32 random bytes as hex, as the Node version made them.
    assert_eq!(session_id.len(), 64);
    assert!(
        session_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert!(is_live_session(&t, &session_id));
    assert_ne!(create_session(&t, Some("127.0.0.1")), session_id);
}

#[test]
fn destroys_sessions() {
    let t = app();
    let session_id = create_session(&t, Some("127.0.0.1"));
    destroy_session(&t, &session_id);
    // Session should be gone
    assert!(!is_live_session(&t, &session_id));
    // Destroying nothing, or twice, is no error.
    destroy_session(&t, "");
    destroy_session(&t, &session_id);
    assert!(!is_live_session(&t, ""));
}

// --- What the Node version stored ---

#[test]
fn a_sign_in_the_node_version_stored_is_still_on() {
    let (t, _clock) = app_at_t0();
    t.db().with(|c| c.execute_batch(CREATE_SESSIONS_TABLE)).unwrap();
    t.db()
        .with(|c| {
            c.execute(
                "INSERT INTO sessions (id, created_at, ip) VALUES (?, ?, ?)",
                params![NODE_SESSION_ROW.0, NODE_SESSION_ROW.1, NODE_SESSION_ROW.2],
            )
        })
        .unwrap();

    let store = SessionStore::init(&t).unwrap();
    assert_eq!(store.len(), 1);
    assert!(is_live_session(&t, NODE_SESSION_ID));
    assert_eq!(
        authenticate(&t, &cookie(NODE_SESSION_ID)),
        Auth {
            authenticated: true,
            method: Some(AuthMethod::Session),
            session_id: Some(NODE_SESSION_ID.to_string()),
        }
    );
    // The row is as Node wrote it: nothing was rewritten.
    assert_eq!(
        session_rows(&t),
        [(
            NODE_SESSION_ROW.0.to_string(),
            NODE_SESSION_ROW.1,
            Some(NODE_SESSION_ROW.2.to_string())
        )]
    );
    // One character off is nobody's sign-in.
    assert!(!is_live_session(&t, &NODE_SESSION_ID.replace("1227", "1228")));
    // The stored hash itself signs nobody in.
    assert!(!is_live_session(&t, NODE_SESSION_ROW.0));
}

#[test]
fn a_new_sign_in_is_stored_the_way_the_node_version_stored_one() {
    let (t, _clock) = app_at_t0();
    SessionStore::init(&t).unwrap();
    let session_id = create_session(&t, Some("203.0.113.5"));
    let no_address = create_session(&t, None);
    assert_eq!(session_key(NODE_SESSION_ID), NODE_SESSION_ROW.0);
    let rows = session_rows(&t);
    assert_eq!(rows.len(), 2);
    assert!(rows.contains(&(session_key(&session_id), T0, Some("203.0.113.5".to_string()))));
    assert!(rows.contains(&(session_key(&no_address), T0, None)));
    let kinds: Vec<String> = t
        .db()
        .with(|c| {
            c.prepare("SELECT typeof(created_at) FROM sessions")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        })
        .unwrap();
    assert_eq!(kinds, ["integer", "integer"]);
    // The id itself is nowhere in the table.
    assert!(
        rows.iter()
            .all(|(id, _, _)| id.starts_with("sha256:") && id.len() == 71)
    );

    // The table is the one the Node version made, word for word.
    let schema: String = t
        .db()
        .with(|c| {
            c.query_row("SELECT sql FROM sqlite_master WHERE name = 'sessions'", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(
        schema,
        "CREATE TABLE sessions (\n    id TEXT PRIMARY KEY,\n    created_at INTEGER NOT NULL,\n    ip TEXT\n  )"
    );
}

#[test]
fn sign_ins_survive_a_restart_and_a_signed_out_one_does_not_come_back() {
    let (t, _clock) = app_at_t0();
    SessionStore::init(&t).unwrap();
    let kept = create_session(&t, Some("203.0.113.5"));
    let signed_out = create_session(&t, Some("203.0.113.6"));
    destroy_session(&t, &signed_out);
    assert_eq!(session_rows(&t).len(), 1);

    // A restart: the store is made again from the database.
    t.app.remove::<SessionStore>();
    assert!(
        !is_live_session(&t, &kept),
        "a store that was never wired to the database knows nobody"
    );
    let store = SessionStore::init(&t).unwrap();
    assert_eq!(store.len(), 1);
    assert!(is_live_session(&t, &kept));
    assert!(!is_live_session(&t, &signed_out));
}

#[test]
fn an_id_an_older_tarsee_stored_as_it_was_is_hashed_and_its_owner_stays_signed_in() {
    let (t, _clock) = app_at_t0();
    let old_id = "0f".repeat(32);
    t.db().with(|c| c.execute_batch(CREATE_SESSIONS_TABLE)).unwrap();
    let insert = |id: &str, created_at: i64, ip: &str| {
        t.db()
            .with(|c| {
                c.execute(
                    "INSERT INTO sessions (id, created_at, ip) VALUES (?, ?, ?)",
                    params![id, created_at, ip],
                )
            })
            .unwrap();
    };
    insert(&old_id, T0 - 1000, "198.51.100.9");
    insert("expired-plain", T0 - 31 * 86_400_000, "198.51.100.10");
    insert(NODE_SESSION_ROW.0, NODE_SESSION_ROW.1, NODE_SESSION_ROW.2);
    let secure_delete = |t: &TestApp| -> i64 {
        t.db()
            .with(|c| c.query_row("PRAGMA secure_delete", [], |r| r.get(0)))
            .unwrap()
    };
    let before = secure_delete(&t);

    let store = SessionStore::init(&t).unwrap();
    assert_eq!(store.len(), 2);
    assert!(is_live_session(&t, &old_id));
    assert!(is_live_session(&t, NODE_SESSION_ID));
    assert!(!is_live_session(&t, "expired-plain"));
    assert_eq!(
        session_rows(&t),
        [
            (session_key(&old_id), T0 - 1000, Some("198.51.100.9".to_string())),
            (
                NODE_SESSION_ROW.0.to_string(),
                NODE_SESSION_ROW.1,
                Some(NODE_SESSION_ROW.2.to_string())
            ),
        ]
    );
    assert_eq!(secure_delete(&t), before, "secure_delete is back to what it was");

    // A second boot finds nothing left to hash and keeps both.
    t.app.remove::<SessionStore>();
    assert_eq!(SessionStore::init(&t).unwrap().len(), 2);
    assert!(is_live_session(&t, &old_id));
}

#[test]
fn an_old_id_stored_both_ways_becomes_one_row() {
    let (t, _clock) = app_at_t0();
    let old_id = "ab".repeat(32);
    t.db().with(|c| c.execute_batch(CREATE_SESSIONS_TABLE)).unwrap();
    for id in [old_id.clone(), session_key(&old_id)] {
        t.db()
            .with(|c| {
                c.execute(
                    "INSERT INTO sessions (id, created_at, ip) VALUES (?, ?, NULL)",
                    params![id, T0],
                )
            })
            .unwrap();
    }
    assert_eq!(SessionStore::init(&t).unwrap().len(), 1);
    assert_eq!(session_rows(&t), [(session_key(&old_id), T0, None)]);
    assert!(is_live_session(&t, &old_id));
}

// --- Sign-ins run out ---

#[test]
fn a_sign_in_runs_out_after_thirty_days() {
    let (t, clock) = app_at_t0();
    SessionStore::init(&t).unwrap();
    assert_eq!(session_max_age_ms(&t), 2_592_000_000.0);
    let session_id = create_session(&t, Some("203.0.113.5"));
    let with_cookie = cookie(&session_id);

    clock.advance(2_592_000_000 - 1);
    assert!(is_live_session(&t, &session_id));
    assert_eq!(live_session_id(&t, &with_cookie), Some(session_id.clone()));
    assert!(!sign_in_ended(&t, &with_cookie));
    assert!(validate_session_from_request(&t, &with_cookie));

    clock.advance(1);
    assert!(!is_live_session(&t, &session_id));
    assert_eq!(live_session_id(&t, &with_cookie), None);
    assert!(sign_in_ended(&t, &with_cookie));
    assert!(!validate_session_from_request(&t, &with_cookie));
    assert_eq!(authenticate(&t, &with_cookie), Auth::default());
    // It is dropped from memory when it is found to have run out, and stays gone if the clock goes back.
    assert_eq!(SessionStore::of(&t).len(), 0);
    clock.advance(-10);
    assert!(!is_live_session(&t, &session_id));
}

#[test]
fn a_sign_in_that_ran_out_while_tarsee_was_down_is_not_restored() {
    let (t, clock) = app_at_t0();
    SessionStore::init(&t).unwrap();
    let old = create_session(&t, None);
    clock.advance(29 * 86_400_000);
    let recent = create_session(&t, None);
    clock.advance(2 * 86_400_000);

    t.app.remove::<SessionStore>();
    assert_eq!(SessionStore::init(&t).unwrap().len(), 1);
    assert!(!is_live_session(&t, &old));
    assert!(is_live_session(&t, &recent));
    assert_eq!(session_rows(&t).len(), 1);
}

#[test]
fn the_lifetime_comes_from_the_environment_as_javascript_read_it() {
    let lifetime = |days: &str| {
        let t = test_app_with_env([("TARSEE_SESSION_MAX_AGE_DAYS", days)]);
        (session_max_age_ms(&t), session_cookie_max_age_ms(&t))
    };
    let day = 86_400_000.0;
    // Node: sessionMaxAgeMs() 2592000000, sessionCookieMaxAgeMs() 34560000000.
    assert_eq!(
        (session_max_age_ms(&test_app()), session_cookie_max_age_ms(&test_app())),
        (2_592_000_000.0, 34_560_000_000.0)
    );
    assert_eq!(lifetime("7"), (7.0 * day, 400.0 * day));
    assert_eq!(lifetime(" 7 "), (7.0 * day, 400.0 * day));
    assert_eq!(lifetime("0.5"), (0.5 * day, 400.0 * day));
    // Past 399 days the cookie outlives the sign-in by a day.
    assert_eq!(lifetime("500"), (500.0 * day, 501.0 * day));
    // Not a number, zero or blank: the default.
    for unusable in ["abc", "7 days", "0", "", "  "] {
        assert_eq!(lifetime(unusable), (30.0 * day, 400.0 * day), "{unusable:?}");
    }
    // A negative lifetime is taken as given: every sign-in has run out at once.
    let t = test_app_with_env([("TARSEE_SESSION_MAX_AGE_DAYS", "-1")]);
    let session_id = create_session(&t, None);
    assert!(!is_live_session(&t, &session_id));
}

#[test]
fn text_is_read_as_a_number_the_way_javascript_reads_it() {
    // String(Number(text)) in Node.
    for (text, expected) in [
        ("", "0"),
        (" ", "0"),
        ("7", "7"),
        (" 7 ", "7"),
        ("0.5", "0.5"),
        ("-1", "-1"),
        ("1e2", "100"),
        ("0x10", "16"),
        ("0b11", "3"),
        ("0o17", "15"),
        ("Infinity", "Infinity"),
        ("-Infinity", "-Infinity"),
        ("+5", "5"),
        (".5", "0.5"),
        ("5.", "5"),
        ("abc", "NaN"),
        ("7 days", "NaN"),
        ("1_000", "NaN"),
        ("00012", "12"),
        ("١٢", "NaN"),
        ("\u{FEFF}3\n", "3"),
        ("1e", "NaN"),
        ("+", "NaN"),
        ("-", "NaN"),
        (".", "NaN"),
        ("0x", "NaN"),
        ("-0x10", "NaN"),
        ("+.5e-2", "0.005"),
        ("INFINITY", "NaN"),
        ("NaN", "NaN"),
        ("inf", "NaN"),
        ("nan", "NaN"),
    ] {
        assert_eq!(crate::util::js::number_to_string(js_number(text)), expected, "{text:?}");
    }
}

// --- The cookie and the token in a request ---

#[test]
fn the_sign_in_cookie_is_found_as_node_found_it() {
    let t = app();
    let id = create_session(&t, None);
    // What liveSessionId, signInEnded and validateSessionFromRequest answered in Node for these headers.
    assert_eq!(live_session_id(&t, &cookie(&id)), Some(id.clone()));
    assert!(sign_in_ended(&t, &headers(&[("cookie", "tarsee_session=nope")])));
    assert!(!sign_in_ended(&t, &HeaderMap::new()));
    assert!(validate_session_from_request(
        &t,
        &headers(&[("cookie", &format!("x=1; tarsee_session= {id} ; y=2"))])
    ));
    assert_eq!(
        live_session_id(&t, &headers(&[("cookie", "tarsee_session=; other=1")])),
        None
    );
    assert!(!sign_in_ended(&t, &headers(&[("cookie", "tarsee_session=; other=1")])));
    assert_eq!(
        live_session_id(&t, &headers(&[("cookie", &format!("a=tarsee_session={id}"))])),
        None
    );
    // The first cookie of the name is the one that counts.
    let first_wins = headers(&[("cookie", &format!("tarsee_session=bad; tarsee_session={id}"))]);
    assert_eq!(live_session_id(&t, &first_wins), None);
    assert!(sign_in_ended(&t, &first_wins));

    assert_eq!(
        live_session_id(&t, &headers(&[("cookie", &format!("a=b;tarsee_session={id}"))])),
        Some(id.clone())
    );
    assert_eq!(
        live_session_id(&t, &headers(&[("cookie", &format!("xtarsee_session={id}"))])),
        None
    );
    // Two Cookie headers are one list, as Node joined them.
    let two = headers(&[("cookie", "a=b"), ("cookie", &format!("tarsee_session={id}"))]);
    assert_eq!(live_session_id(&t, &two), Some(id.clone()));
    // Only a blank after the name: a cookie is there, but it names no sign-in.
    let blank = headers(&[("cookie", "tarsee_session= ; y=2")]);
    assert_eq!(live_session_id(&t, &blank), None);
    assert!(!sign_in_ended(&t, &blank));
}

#[test]
fn the_api_token_is_taken_from_the_authorization_header_as_node_took_it() {
    let t = app();
    let token = t.config().api_token.clone();
    let bearer = Auth {
        authenticated: true,
        method: Some(AuthMethod::Bearer),
        session_id: None,
    };
    let with = |value: &str| authenticate(&t, &headers(&[("authorization", value)]));
    assert_eq!(with(&format!("Bearer {token}")), bearer);
    assert_eq!(with(&format!("Bearer   {token}  ")), bearer);
    assert_eq!(with("Bearer nope"), Auth::default());
    assert_eq!(with(&format!("bearer {token}")), Auth::default());
    assert_eq!(with(&format!("Bearer{token}")), Auth::default());
    assert_eq!(with(&token), Auth::default());
    assert_eq!(with("Bearer "), Auth::default());
    // Of two Authorization headers Node kept the first.
    let two =
        |first: &str, second: &str| authenticate(&t, &headers(&[("authorization", first), ("authorization", second)]));
    assert_eq!(two(&format!("Bearer {token}"), "Bearer nope"), bearer);
    assert_eq!(two("Bearer nope", &format!("Bearer {token}")), Auth::default());

    // The token wins over a sign-in's cookie; a wrong token leaves the cookie to decide.
    let id = create_session(&t, None);
    let both = |authorization: &str| {
        authenticate(
            &t,
            &headers(&[
                ("authorization", authorization),
                ("cookie", &format!("tarsee_session={id}")),
            ]),
        )
    };
    assert_eq!(both(&format!("Bearer {token}")), bearer);
    assert_eq!(
        both("Bearer nope"),
        Auth {
            authenticated: true,
            method: Some(AuthMethod::Session),
            session_id: Some(id.clone()),
        }
    );
}

#[test]
fn auth_is_the_js_object_as_json() {
    assert_eq!(
        serde_json::to_string(&Auth::default()).unwrap(),
        r#"{"authenticated":false,"method":null}"#
    );
    assert_eq!(
        serde_json::to_string(&Auth {
            authenticated: true,
            method: Some(AuthMethod::Bearer),
            session_id: None
        })
        .unwrap(),
        r#"{"authenticated":true,"method":"bearer"}"#
    );
    assert_eq!(
        serde_json::to_string(&Auth {
            authenticated: true,
            method: Some(AuthMethod::Session),
            session_id: Some("abc".into())
        })
        .unwrap(),
        r#"{"authenticated":true,"method":"session","sessionId":"abc"}"#
    );
    assert_eq!(AuthMethod::Session.as_str(), "session");
    assert_eq!(AuthMethod::Bearer.as_str(), "bearer");
}

#[test]
fn sign_in_ran_out_says_what_to_do_next() {
    assert_eq!(
        sign_in_ran_out(None),
        "Your sign-in has run out. Sign in again, then try once more."
    );
    assert_eq!(
        sign_in_ran_out(Some("switch the task on")),
        "Your sign-in has run out. Sign in again, then switch the task on."
    );
}

// --- req.ip ---

#[test]
fn the_client_address_is_what_express_gave_with_one_trusted_proxy() {
    let socket: SocketAddr = "127.0.0.1:54321".parse().unwrap();
    let mut with_socket = Extensions::new();
    with_socket.insert(ConnectInfo(socket));
    let ip = |forwarded: &[&str]| {
        let pairs: Vec<(&str, &str)> = forwarded.iter().map(|value| ("x-forwarded-for", *value)).collect();
        client_ip(&headers(&pairs), &with_socket)
    };
    // What `req.ip` was in Node (trust proxy = 1) for a request from 127.0.0.1 with these X-Forwarded-For headers.
    assert_eq!(ip(&[]).as_deref(), Some("127.0.0.1"));
    assert_eq!(ip(&["203.0.113.7"]).as_deref(), Some("203.0.113.7"));
    assert_eq!(ip(&["198.51.100.1, 203.0.113.7"]).as_deref(), Some("203.0.113.7"));
    assert_eq!(ip(&[" 198.51.100.1 ,  203.0.113.7  "]).as_deref(), Some("203.0.113.7"));
    assert_eq!(ip(&["198.51.100.1, 203.0.113.7, "]).as_deref(), Some("203.0.113.7"));
    assert_eq!(ip(&[""]).as_deref(), Some("127.0.0.1"));
    assert_eq!(ip(&[" , ,"]).as_deref(), Some("127.0.0.1"));
    assert_eq!(ip(&["198.51.100.1", "203.0.113.9"]).as_deref(), Some("203.0.113.9"));
    assert_eq!(ip(&["not an ip, also\tnot"]).as_deref(), Some("also\tnot"));
    assert_eq!(ip(&["2001:db8::1"]).as_deref(), Some("2001:db8::1"));

    // Without a connection to ask (a router called directly), only the header can say.
    let no_socket = Extensions::new();
    assert_eq!(client_ip(&HeaderMap::new(), &no_socket), None);
    assert_eq!(
        client_ip(&headers(&[("x-forwarded-for", "203.0.113.7")]), &no_socket).as_deref(),
        Some("203.0.113.7")
    );
    // An IPv6 connection, and an IPv4 one on a dual-stack socket, read as Node printed them.
    let mut v6 = Extensions::new();
    v6.insert(ConnectInfo("[::1]:1".parse::<SocketAddr>().unwrap()));
    assert_eq!(client_ip(&HeaderMap::new(), &v6).as_deref(), Some("::1"));
    let mut mapped = Extensions::new();
    mapped.insert(ConnectInfo("[::ffff:192.0.2.4]:1".parse::<SocketAddr>().unwrap()));
    assert_eq!(
        client_ip(&HeaderMap::new(), &mapped).as_deref(),
        Some("::ffff:192.0.2.4")
    );
}

// --- Rate limit and lockout ---

fn refused(retry_after: i64, error: &str) -> Result<(), TooManyAttempts> {
    Err(TooManyAttempts {
        retry_after,
        error: error.to_string(),
    })
}

#[test]
fn five_attempts_a_minute_from_one_address() {
    let (t, clock) = app_at_t0();
    let attempts = AuthAttempts::of(&t);
    let ip = Some("198.51.100.3");
    for _ in 0..5 {
        assert_eq!(attempts.rate_limit(ip), Ok(()));
    }
    // What Node answered to the sixth: 429, Retry-After: 60, "Too many attempts. Try again later."
    assert_eq!(
        attempts.rate_limit(ip),
        refused(60, "Too many attempts. Try again later.")
    );
    // Another address has its own count.
    assert_eq!(attempts.rate_limit(Some("198.51.100.4")), Ok(()));

    clock.advance(59_001);
    assert_eq!(
        attempts.rate_limit(ip),
        refused(1, "Too many attempts. Try again later.")
    );
    clock.advance(998);
    assert_eq!(
        attempts.rate_limit(ip),
        refused(1, "Too many attempts. Try again later.")
    );
    // The window is over: a new one starts with this attempt.
    clock.advance(1);
    assert_eq!(attempts.rate_limit(ip), Ok(()));
    for _ in 0..4 {
        assert_eq!(attempts.rate_limit(ip), Ok(()));
    }
    assert_eq!(
        attempts.rate_limit(ip),
        refused(60, "Too many attempts. Try again later.")
    );
}

#[test]
fn wrong_passwords_lock_an_address_out_for_longer_and_longer() {
    let (t, clock) = app_at_t0();
    let attempts = AuthAttempts::of(&t);
    let ip = Some("203.0.113.50");
    let locked = |seconds: i64| refused(seconds, &format!("Locked out. Try again in {seconds}s."));
    // A failed attempt, with a minute before it so the 5-a-minute limit stays out of the way.
    let fail = |attempts: &AuthAttempts| {
        clock.advance(61_000);
        assert_eq!(attempts.rate_limit(ip), Ok(()));
        record_failed_attempt(&t, ip);
    };

    // Failures 1-3: no delay (typos happen)
    for _ in 0..3 {
        fail(&attempts);
    }
    assert_eq!(attempts.rate_limit(ip), Ok(()));
    // Failures 4-5: 30 second lockout. What Node answered after the fourth: "Locked out. Try again in 30s."
    record_failed_attempt(&t, ip);
    assert_eq!(attempts.rate_limit(ip), locked(30));
    clock.advance(29_001);
    assert_eq!(attempts.rate_limit(ip), locked(1));
    clock.advance(999);
    assert_eq!(attempts.rate_limit(ip), Ok(()));
    record_failed_attempt(&t, ip);
    assert_eq!(attempts.rate_limit(ip), locked(30));
    // Failures 6-7: 2 minute lockout
    fail(&attempts);
    assert_eq!(attempts.rate_limit(ip), locked(120));
    fail_after_lock(&clock, &attempts, &t, ip, 120_000);
    assert_eq!(attempts.rate_limit(ip), locked(120));
    // Failures 8-9: 10 minute lockout
    fail_after_lock(&clock, &attempts, &t, ip, 120_000);
    assert_eq!(attempts.rate_limit(ip), locked(600));
    fail_after_lock(&clock, &attempts, &t, ip, 600_000);
    assert_eq!(attempts.rate_limit(ip), locked(600));
    // Failures 10+: 1 hour lockout (IP is blocked)
    fail_after_lock(&clock, &attempts, &t, ip, 600_000);
    assert_eq!(attempts.rate_limit(ip), locked(3600));
    fail_after_lock(&clock, &attempts, &t, ip, 3_600_000);
    assert_eq!(attempts.rate_limit(ip), locked(3600));

    // The right password clears it: no lock, and the count of failures starts again.
    clear_failed_attempts(&t, ip);
    clock.advance(61_000);
    assert_eq!(attempts.rate_limit(ip), Ok(()));
    for _ in 0..3 {
        record_failed_attempt(&t, ip);
    }
    assert_eq!(attempts.rate_limit(ip), Ok(()));
    // Clearing an address that was never seen is no error.
    clear_failed_attempts(&t, Some("192.0.2.200"));
}

/// Waits out a lock of `lock_ms`, makes one more attempt and fails it.
fn fail_after_lock(clock: &Clock, attempts: &AuthAttempts, t: &TestApp, ip: Option<&str>, lock_ms: i64) {
    clock.advance(lock_ms);
    assert_eq!(attempts.rate_limit(ip), Ok(()));
    record_failed_attempt(t, ip);
}

#[test]
fn a_lock_is_checked_before_the_window_and_does_not_use_up_attempts() {
    let (t, clock) = app_at_t0();
    let attempts = AuthAttempts::of(&t);
    let ip = Some("203.0.113.60");
    // Four wrong passwords in one window, as Node counted them: four attempts, then locked for 30 s.
    for _ in 0..4 {
        assert_eq!(attempts.rate_limit(ip), Ok(()));
        record_failed_attempt(&t, ip);
    }
    for _ in 0..3 {
        assert_eq!(attempts.rate_limit(ip), refused(30, "Locked out. Try again in 30s."));
    }
    // After the lock one attempt is left in the window (the fifth), then the window's limit answers.
    clock.advance(30_000);
    assert_eq!(attempts.rate_limit(ip), Ok(()));
    assert_eq!(
        attempts.rate_limit(ip),
        refused(30, "Too many attempts. Try again later.")
    );
}

#[test]
fn a_request_without_an_address_is_counted_as_unknown_but_its_failures_are_filed_apart() {
    // The Node code keyed the limiter on `req.ip || ... || "unknown"` and the failures on `req.ip` itself, which
    // is undefined when there is no address: two different keys. Ported as it is.
    let (t, _clock) = app_at_t0();
    let attempts = AuthAttempts::of(&t);
    for _ in 0..4 {
        assert_eq!(attempts.rate_limit(None), Ok(()));
        record_failed_attempt(&t, None);
    }
    assert_eq!(attempts.len(), 2);
    assert_eq!(
        attempts.rate_limit(None),
        Ok(()),
        "the failures did not lock \"unknown\""
    );
    assert_eq!(
        attempts.rate_limit(None),
        refused(60, "Too many attempts. Try again later.")
    );
    assert_eq!(
        attempts.rate_limit(Some("unknown")),
        refused(60, "Too many attempts. Try again later.")
    );
    // Failures filed under the name "unknown" do lock it.
    for _ in 0..4 {
        record_failed_attempt(&t, Some("unknown"));
    }
    assert_eq!(attempts.rate_limit(None), refused(30, "Locked out. Try again in 30s."));
    clear_failed_attempts(&t, None);
    assert_eq!(attempts.rate_limit(None), refused(30, "Locked out. Try again in 30s."));
}

#[test]
fn seconds_are_rounded_up_as_math_ceil_did() {
    assert_eq!(ceil_seconds(1), 1);
    assert_eq!(ceil_seconds(1000), 1);
    assert_eq!(ceil_seconds(1001), 2);
    assert_eq!(ceil_seconds(30_000), 30);
    assert_eq!(ceil_seconds(0), 0);
}

// --- auth housekeeping timers (test/auth-timers.test.js) ---
//
// Regression guard for the crash loop shipped in 7f46330: the two housekeeping setIntervals in auth.js had their
// `const` lines transposed, so the 30-minute session sweep referenced an out-of-scope `cutoff` and the 5-minute
// rate-limit sweep referenced a `now` that no longer existed. Both throw from a timer callback, which is uncaught,
// which kills the process.
//
// The bodies only iterate when their maps are non-empty, so these tests populate both before the sweeps run.

#[tokio::test(start_paused = true)]
async fn registers_the_rate_limit_and_session_sweeps() {
    assert_eq!(AUTH_ATTEMPTS_SWEEP_INTERVAL, Duration::from_millis(5 * 60_000));
    assert_eq!(SESSION_SWEEP_INTERVAL, Duration::from_millis(30 * 60_000));

    let (t, clock) = app_at_t0();
    let sessions = SessionStore::init(&t).unwrap();
    let attempts = AuthAttempts::of(&t);
    assert!(sessions.is_sweeping());
    assert!(attempts.is_sweeping());

    // Something for each sweep to drop: a sign-in that has run out, an address whose window is over.
    create_session(&t, Some("10.0.0.1"));
    record_failed_attempt(&t, Some("10.0.0.3"));
    clock.advance(31 * 86_400_000);
    assert_eq!((sessions.len(), attempts.len()), (1, 1));
    assert_eq!(session_rows(&t).len(), 1);

    // Nothing is swept before its time.
    tokio::time::sleep(Duration::from_secs(5 * 60 - 1)).await;
    assert_eq!((sessions.len(), attempts.len()), (1, 1));
    // The rate-limit sweep runs at 5 minutes, the session sweep not yet.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!((sessions.len(), attempts.len()), (1, 0));
    // The session sweep runs at 30 minutes, in memory and on disk.
    tokio::time::sleep(Duration::from_secs(25 * 60)).await;
    assert_eq!(sessions.len(), 0);
    assert_eq!(session_rows(&t).len(), 0);

    // And they keep running: the next round drops what has gone stale since.
    record_failed_attempt(&t, Some("10.0.0.4"));
    create_session(&t, Some("10.0.0.5"));
    clock.advance(31 * 86_400_000);
    tokio::time::sleep(Duration::from_secs(30 * 60)).await;
    assert_eq!((sessions.len(), attempts.len()), (0, 0));
    assert!(sessions.is_sweeping() && attempts.is_sweeping());
}

#[tokio::test(start_paused = true)]
async fn runs_both_sweeps_without_throwing_when_their_maps_are_populated() {
    let (t, _clock) = app_at_t0();
    let sessions = SessionStore::init(&t).unwrap();
    let attempts = AuthAttempts::of(&t);
    create_session(&t, Some("10.0.0.1"));
    create_session(&t, Some("10.0.0.2"));
    record_failed_attempt(&t, Some("10.0.0.3"));

    // The sweeps themselves, as the Node test called the timers' callbacks.
    attempts.sweep();
    sessions.sweep();
    // And through their timers.
    tokio::time::sleep(Duration::from_secs(30 * 60 + 1)).await;
    assert!(sessions.is_sweeping() && attempts.is_sweeping(), "neither sweep died");
    // Nothing was stale but the address's window (it ended a minute after its only failure).
    assert_eq!(sessions.len(), 2);
    assert_eq!(session_rows(&t).len(), 2);
}

#[test]
fn keeps_fresh_sessions_and_drops_expired_ones() {
    let (t, clock) = app_at_t0();
    let sessions = SessionStore::init(&t).unwrap();
    let expired = create_session(&t, Some("10.0.0.3"));
    clock.advance(30 * 86_400_000 + 1);
    let fresh = create_session(&t, Some("10.0.0.4"));
    assert_eq!((sessions.len(), session_rows(&t).len()), (2, 2));
    sessions.sweep();
    // A session created moments ago is inside the max age, so it survives.
    assert!(!fresh.is_empty(), "createSession returned an id");
    assert!(is_live_session(&t, &fresh));
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        session_rows(&t),
        [(
            session_key(&fresh),
            T0 + 30 * 86_400_000 + 1,
            Some("10.0.0.4".to_string())
        )]
    );
    assert!(!is_live_session(&t, &expired));

    // One millisecond short of its age a sign-in stays; at its age it goes.
    clock.advance(30 * 86_400_000 - 1);
    sessions.sweep();
    assert_eq!(sessions.len(), 1);
    clock.advance(1);
    sessions.sweep();
    assert_eq!(
        sessions.len(),
        1,
        "the sweep drops what is older than the age, not what is exactly it"
    );
    assert!(
        !is_live_session(&t, &fresh),
        "but exactly its age is run out for a request"
    );
    clock.advance(1);
    sessions.sweep();
    assert_eq!(session_rows(&t).len(), 0);
}

#[test]
fn the_rate_limit_sweep_keeps_what_is_still_counted_or_locked() {
    let (t, clock) = app_at_t0();
    let attempts = AuthAttempts::of(&t);
    attempts.rate_limit(Some("window-open")).unwrap();
    for _ in 0..4 {
        record_failed_attempt(&t, Some("locked"));
    }
    clock.advance(20_000);
    attempts.rate_limit(Some("window-newer")).unwrap();

    attempts.sweep();
    assert_eq!(attempts.len(), 3, "nothing is over yet");
    // 60 s after the first two were made: their windows are over; "locked" was locked for only 30 s.
    clock.advance(40_000);
    attempts.sweep();
    assert_eq!(attempts.len(), 1);
    assert_eq!(
        attempts.rate_limit(Some("window-newer")),
        Ok(()),
        "still inside its own window"
    );

    // A lock that outlasts the window keeps the address until the lock is over.
    for _ in 0..6 {
        record_failed_attempt(&t, Some("locked-longer"));
    }
    clock.advance(61_000);
    attempts.sweep();
    assert_eq!(attempts.len(), 1);
    assert_eq!(
        attempts.rate_limit(Some("locked-longer")),
        refused(59, "Locked out. Try again in 59s.")
    );
    clock.advance(59_000);
    attempts.sweep();
    assert_eq!(attempts.len(), 0);
}

#[test]
fn outside_a_runtime_the_services_work_and_only_the_timers_wait() {
    let (t, _clock) = app_at_t0();
    let sessions = SessionStore::init(&t).unwrap();
    assert!(!sessions.is_sweeping());
    assert!(!AuthAttempts::of(&t).is_sweeping());
    let id = create_session(&t, None);
    assert!(is_live_session(&t, &id));
}

#[tokio::test]
async fn the_timers_start_with_the_first_use_inside_a_runtime_and_end_with_the_app() {
    let t = app();
    // Made before there was a runtime to run a timer on.
    let made_early = std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let store = SessionStore::init(&t).unwrap();
                assert!(!store.is_sweeping());
                store
            })
            .join()
            .unwrap()
    });
    assert!(SessionStore::of(&t).is_sweeping());
    assert!(made_early.is_sweeping());
    let weak = Arc::downgrade(&made_early);
    drop(made_early);
    drop(t);
    assert!(weak.upgrade().is_none(), "the timer does not keep the store alive");
}

#[test]
fn a_closed_database_does_not_break_a_sign_in_or_a_sweep() {
    let (t, _clock) = app_at_t0();
    let sessions = SessionStore::init(&t).unwrap();
    let before = create_session(&t, None);
    t.db().close();
    let after = create_session(&t, None);
    assert!(is_live_session(&t, &before) && is_live_session(&t, &after));
    destroy_session(&t, &before);
    sessions.sweep();
    assert_eq!(sessions.len(), 1);
}

// --- The middleware ---

/// A router as the server builds one: `session_auth` on everything, `require_auth` on `/need`.
fn router(t: &TestApp) -> Router {
    let app = t.app.clone();
    let protected = Router::new()
        .route("/need", get(|auth: Auth| async move { Json(auth) }))
        .layer(from_fn_with_state(app.clone(), require_auth));
    Router::new()
        .route("/who", get(|auth: Auth| async move { Json(auth) }))
        .route(
            "/ip",
            get(|ClientIp(ip): ClientIp| async move { Json(json!({ "ip": ip })) }),
        )
        .route(
            "/extract",
            get(|RequireAuth(auth): RequireAuth| async move { Json(auth) }),
        )
        .route(
            "/limited",
            post(|| async { "in" }).layer(from_fn_with_state(app.clone(), rate_limit_auth)),
        )
        .merge(protected)
        .layer(from_fn_with_state(app.clone(), session_auth))
        .with_state(app)
}

#[tokio::test]
async fn session_auth_names_the_request_and_require_auth_refuses_the_rest() {
    let t = app();
    let router = router(&t);
    let token = t.config().api_token.clone();
    let id = create_session(&t, Some("203.0.113.24"));
    let get_with = |path: &'static str, name: &'static str, value: String| {
        let router = router.clone();
        async move { http::send(&router, http::request("GET", path).header(name, value)).await }
    };

    // The bodies are the JSON of `req.auth` as the Node version built it.
    let nobody = http::get(&router, "/who").await;
    assert_eq!(
        (nobody.status, nobody.text()),
        (200, r#"{"authenticated":false,"method":null}"#.to_string())
    );
    let by_cookie = get_with("/who", "cookie", format!("tarsee_session={id}")).await;
    assert_eq!(
        by_cookie.text(),
        format!(r#"{{"authenticated":true,"method":"session","sessionId":"{id}"}}"#)
    );
    let by_token = get_with("/who", "authorization", format!("Bearer {token}")).await;
    assert_eq!(by_token.text(), r#"{"authenticated":true,"method":"bearer"}"#);

    for path in ["/need", "/extract"] {
        // What Node answered: 401 {"error":"Authentication required"}
        let refused = http::get(&router, path).await;
        assert_eq!(
            (refused.status, refused.json()),
            (401, json!({ "error": "Authentication required" })),
            "{path}"
        );
        assert_eq!(refused.header("content-type"), Some("application/json"));
        let wrong_token = get_with(path, "authorization", "Bearer nope".to_string()).await;
        assert_eq!(wrong_token.json(), json!({ "error": "Authentication required" }));

        let let_in = get_with(path, "cookie", format!("tarsee_session={id}")).await;
        assert_eq!(
            (let_in.status, let_in.json()["method"].clone()),
            (200, json!("session")),
            "{path}"
        );
        let let_in = get_with(path, "authorization", format!("Bearer {token}")).await;
        assert_eq!(
            (let_in.status, let_in.json()["method"].clone()),
            (200, json!("bearer")),
            "{path}"
        );

        // A cookie that names no live sign-in: the sign-in ran out, and the dashboard is told so.
        let ended = get_with(path, "cookie", format!("tarsee_session={}", "0".repeat(64))).await;
        assert_eq!(ended.status, 401, "{path}");
        assert_eq!(
            ended.text(),
            r#"{"error":"Your sign-in has run out. Sign in again, then try once more.","needsSignIn":true}"#
        );
    }

    destroy_session(&t, &id);
    let signed_out = get_with("/need", "cookie", format!("tarsee_session={id}")).await;
    assert_eq!(signed_out.json()["needsSignIn"], Value::Bool(true));
}

#[tokio::test]
async fn without_session_auth_nobody_is_signed_in() {
    let t = app();
    let token = t.config().api_token.clone();
    let router: Router = Router::new()
        .route("/who", get(|auth: Auth| async move { Json(auth) }))
        .route("/need", get(|RequireAuth(auth): RequireAuth| async move { Json(auth) }))
        .with_state(t.app.clone());
    let who = http::send(
        &router,
        http::request("GET", "/who").header("authorization", format!("Bearer {token}")),
    )
    .await;
    assert_eq!(who.json(), json!({ "authenticated": false, "method": null }));
    let need = http::send(
        &router,
        http::request("GET", "/need").header("authorization", format!("Bearer {token}")),
    )
    .await;
    assert_eq!(
        (need.status, need.json()),
        (401, json!({ "error": "Authentication required" }))
    );
}

#[tokio::test]
async fn the_client_address_reaches_a_handler_and_the_rate_limit_middleware() {
    let (t, _clock) = app_at_t0();
    let router = router(&t);
    let ip = http::send(
        &router,
        http::request("GET", "/ip").header("x-forwarded-for", "198.51.100.1, 203.0.113.7"),
    )
    .await;
    assert_eq!(ip.json(), json!({ "ip": "203.0.113.7" }));
    assert_eq!(http::get(&router, "/ip").await.json(), json!({ "ip": null }));

    let attempt = |address: &'static str| {
        let router = router.clone();
        async move {
            http::send(
                &router,
                http::request("POST", "/limited").header("x-forwarded-for", address),
            )
            .await
        }
    };
    for _ in 0..5 {
        assert_eq!(attempt("198.51.100.2").await.text(), "in");
    }
    // What Node sent for the sixth: 429, Retry-After: 60, {"error":"Too many attempts. Try again later."}
    let sixth = attempt("198.51.100.2").await;
    assert_eq!(sixth.status, 429);
    assert_eq!(sixth.header("retry-after"), Some("60"));
    assert_eq!(sixth.text(), r#"{"error":"Too many attempts. Try again later."}"#);
    assert_eq!(
        attempt("198.51.100.3").await.status,
        200,
        "another address is not held back"
    );

    for _ in 0..4 {
        record_failed_attempt(&t, Some("198.51.100.3"));
    }
    let locked = attempt("198.51.100.3").await;
    assert_eq!((locked.status, locked.header("retry-after")), (429, Some("30")));
    assert_eq!(locked.text(), r#"{"error":"Locked out. Try again in 30s."}"#);
}

#[test]
fn the_clock_is_the_systems_unless_a_test_stores_one() {
    let t = test_app();
    let system = Clock::of(&t);
    let before = crate::util::js::now_ms();
    let read = system.now_ms();
    assert!(read >= before && read <= crate::util::js::now_ms());

    let t = test_app();
    let manual = t.app.set(Clock::manual(1000));
    assert_eq!(Clock::of(&t).now_ms(), 1000);
    manual.advance(500);
    assert_eq!(Clock::of(&t).now_ms(), 1500);
    manual.set(7);
    assert_eq!(Clock::of(&t).now_ms(), 7);
}

#[test]
fn text_is_trimmed_as_javascript_trims_it() {
    assert_eq!(
        js_trim(" \t\n\u{B}\u{C}\r\u{A0}\u{FEFF}x y\u{2028}\u{2029}\u{3000} "),
        "x y"
    );
    // U+0085 is whitespace to Rust's trim, not to JavaScript's.
    assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
    assert_eq!(js_trim(""), "");
}

#[test]
fn strings_are_compared_whole() {
    assert!(safe_compare("", ""));
    assert!(safe_compare("abc", "abc"));
    assert!(!safe_compare("abc", "abd"));
    assert!(!safe_compare("abc", "abcd"));
    assert!(!safe_compare("abcd", "abc"));
    assert!(!safe_compare("", "a"));
}
