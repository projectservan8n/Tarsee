//! Port of the cases of `test/codex-device-login.test.js` that start nothing: the parser on the real program's
//! stdout (captured from codex-cli 0.167.0 with network and no account; only the one-time code was swapped for a
//! same-shape fake), what the person is told, and what auth.json says. The cases that run a codex are in
//! `tests/it/codex_device_login.rs`. Every token is an obvious fake, put together from parts.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};

use super::*;
use crate::testkit::tmp_dir;

const REAL_STDOUT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/codex-login/device-auth.stdout.txt"
));

const MINUTES_15: u64 = 15 * 60_000;

fn prompt(code: &str, expires_in_ms: u64) -> DeviceAuthPrompt {
    DeviceAuthPrompt {
        url: DEVICE_LOGIN_URL.to_string(),
        code: code.to_string(),
        expires_in_ms,
    }
}

fn b64(value: &Value) -> String {
    URL_SAFE_NO_PAD.encode(value.to_string())
}

fn jwt(claims: &Value) -> String {
    format!("{}.{}.sig-test-canary", b64(&json!({ "alg": "none" })), b64(claims))
}

fn fake_key() -> String {
    format!("sk-{}", "test-canary-0000000000000000abcd")
}

// --- parseDeviceAuthOutput: the real binary's stdout ---

#[test]
fn reads_the_link_the_one_time_code_and_the_expiry_through_the_ansi_colours() {
    assert!(
        REAL_STDOUT.contains("\u{1b}[94m"),
        "the fixture still has the CLI's colour codes"
    );
    assert_eq!(
        parse_device_auth_output(REAL_STDOUT),
        Some(prompt("TEST-12345", MINUTES_15))
    );
    assert_eq!(DEVICE_LOGIN_URL, "https://auth.openai.com/codex/device");
    assert_eq!(
        serde_json::to_value(parse_device_auth_output(REAL_STDOUT).unwrap()).unwrap(),
        json!({ "url": DEVICE_LOGIN_URL, "code": "TEST-12345", "expiresInMs": 900_000 })
    );
}

#[test]
fn reads_the_same_with_windows_line_endings() {
    assert_eq!(
        parse_device_auth_output(&REAL_STDOUT.replace('\n', "\r\n")),
        Some(prompt("TEST-12345", MINUTES_15))
    );
    // And with the line ends an old Mac wrote, which the JS also turned into line feeds.
    assert_eq!(
        parse_device_auth_output(&REAL_STDOUT.replace('\n', "\r")),
        Some(prompt("TEST-12345", MINUTES_15))
    );
}

#[test]
fn waits_for_the_code_output_cut_before_it_gives_null() {
    let before_step_two = &REAL_STDOUT[..REAL_STDOUT.find("2. Enter").unwrap()];
    assert_eq!(parse_device_auth_output(before_step_two), None);
    let mid_code = &REAL_STDOUT[..REAL_STDOUT.find("TEST-12345").unwrap() + 4];
    assert_eq!(parse_device_auth_output(mid_code), None);
    assert_eq!(parse_device_auth_output(""), None);
    // The whole code but not yet its line end: it could still grow.
    let whole_code = &REAL_STDOUT[..REAL_STDOUT.find("TEST-12345").unwrap() + 10];
    assert_eq!(parse_device_auth_output(whole_code), None);
    assert_eq!(
        parse_device_auth_output(&format!("{whole_code}\n")),
        Some(prompt("TEST-12345", MINUTES_15))
    );
}

#[test]
fn only_ever_accepts_openais_own_device_page() {
    for other in [
        "https://auth.example.test/codex/device",
        "https://auth.openai.com.example.test/codex/device",
        "http://auth.openai.com/codex/device",
        "https://auth.openai.com/codex/device-elsewhere",
        "https://auth.openai.com/codex/devices",
    ] {
        assert_eq!(
            parse_device_auth_output(&REAL_STDOUT.replace(DEVICE_LOGIN_URL, other)),
            None,
            "{other}"
        );
    }
}

#[test]
fn uses_the_minutes_the_cli_states_and_15_when_it_states_none() {
    let ten = REAL_STDOUT.replace("expires in 15 minutes", "expires in 10 minutes");
    assert_eq!(parse_device_auth_output(&ten).unwrap().expires_in_ms, 10 * 60_000);
    let none = REAL_STDOUT.replace(" (expires in 15 minutes)", "");
    assert_eq!(parse_device_auth_output(&none).unwrap().expires_in_ms, MINUTES_15);
}

// --- classifyLoginError: what the person is told ---

#[test]
fn device_code_sign_in_switched_off_the_chatgpt_setting_to_turn_on() {
    let real = "Error logging in: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.";
    assert_eq!(
        classify_login_error(real),
        LoginFailure {
            code: LoginCode::DeviceCodeDisabled,
            error: DEVICE_CODE_DISABLED_MESSAGE.to_string()
        }
    );
    assert_eq!(
        DEVICE_CODE_DISABLED_MESSAGE,
        "In ChatGPT, open Settings → Security and, under App security, turn on \"Enable device code sign-in for Codex\""
    );
    assert_eq!(
        classify_login_error("\u{1b}[31merror\u{1b}[0m: device_code_auth_disabled for this workspace").code,
        LoginCode::DeviceCodeDisabled
    );
}

#[test]
fn no_connection_the_clis_own_15_minute_limit_and_anything_else_with_secrets_taken_out() {
    assert_eq!(
        classify_login_error("Error logging in: failed to request device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)").code,
        LoginCode::Network
    );
    assert_eq!(
        classify_login_error("Error logging in: device auth timed out after 15 minutes").code,
        LoginCode::Timeout
    );
    let other = classify_login_error(&format!(
        "WARNING: proceeding\nError logging in: device code exchange failed: bad token {}x and {}",
        jwt(&json!({ "a": "aaaaaaaaaaaa" })),
        fake_key()
    ));
    assert_eq!(other.code, LoginCode::Failed);
    assert!(other.error.contains("device code exchange failed"), "{}", other.error);
    for leaked in ["sk-test-canary", "eyJ", "WARNING"] {
        assert!(!other.error.contains(leaked), "{leaked}: {}", other.error);
    }
    assert_eq!(
        other.error,
        "Codex couldn't sign in: device code exchange failed: bad token [REDACTED] and [REDACTED]"
    );
}

// --- What the JS suite left to the flow, or out ---

#[test]
fn the_messages_and_codes_are_the_node_ones() {
    assert_eq!(LOGIN_TTL_MS, 900_000);
    let codes = [
        (LoginCode::DeviceCodeDisabled, "device-code-disabled"),
        (LoginCode::Network, "network"),
        (LoginCode::NoCode, "no-code"),
        (LoginCode::UnexpectedOutput, "unexpected-output"),
        (LoginCode::UnsafeConfig, "unsafe-config"),
        (LoginCode::HomeFailed, "home-failed"),
        (LoginCode::CodexMissing, "codex-missing"),
        (LoginCode::SpawnFailed, "spawn-failed"),
        (LoginCode::Cancelled, "cancelled"),
        (LoginCode::Failed, "failed"),
        (LoginCode::Timeout, "timeout"),
        (LoginCode::NotConfirmed, "not-confirmed"),
    ];
    for (code, text) in codes {
        assert_eq!(code.as_str(), text);
        assert_eq!(serde_json::to_value(code).unwrap(), json!(text));
    }
    assert_eq!(messages::CANCELLED, "Sign-in was cancelled.");
    assert_eq!(
        messages::TIMEOUT,
        "The sign-in code expired before it was used. Start again for a new code."
    );
    assert_eq!(
        messages::NETWORK,
        "Couldn't reach OpenAI to start the sign-in. Check this server's internet connection and try again."
    );
    assert_eq!(
        messages::NO_CODE,
        "Codex didn't show a sign-in code in time. Check this server's internet connection and try again."
    );
    assert_eq!(
        messages::NOT_CONFIRMED,
        "Codex finished without signing in. Start again for a new code."
    );
    assert_eq!(
        messages::UNEXPECTED_OUTPUT,
        "Codex didn't show OpenAI's sign-in page, so Tarsee stopped it. Try again, or sign in from the Terminal with: codex login --device-auth"
    );
    for (state, text) in [
        (LoginState::Starting, "starting"),
        (LoginState::Waiting, "waiting"),
        (LoginState::SignedIn, "signed-in"),
        (LoginState::Failed, "failed"),
        (LoginState::Cancelled, "cancelled"),
        (LoginState::Expired, "expired"),
    ] {
        assert_eq!(state.as_str(), text);
        assert_eq!(serde_json::to_value(state).unwrap(), json!(text));
    }
}

#[test]
fn a_link_is_the_device_page_only_as_a_url_reads_it() {
    for yes in [
        "https://auth.openai.com/codex/device",
        "https://auth.openai.com/codex/device?user_code=X",
        "https://auth.openai.com/codex/device#frag",
        "https://auth.openai.com:443/codex/device",
        "HTTPS://AUTH.OPENAI.COM/codex/device",
        "https://auth.openai.com/codex/./device",
        "https://auth.openai.com/x/../codex/device",
    ] {
        assert!(is_device_page(yes), "{yes}");
    }
    for no in [
        "https://auth.openai.com:8443/codex/device",
        "https://user@auth.openai.com/codex/device",
        "https://user:pw@auth.openai.com/codex/device",
        "https://auth.openai.com/codex/device/",
        "https://auth.openai.com/codex//device",
        "https://auth.openai.com/Codex/device",
        "https://auth.openai.com./codex/device",
        "https://auth.openai.com@evil.example/codex/device",
        "https://evil.example/?https://auth.openai.com/codex/device",
        "ftp://auth.openai.com/codex/device",
        "auth.openai.com/codex/device",
        "",
    ] {
        assert!(!is_device_page(no), "{no}");
    }
}

#[test]
fn the_code_is_read_only_after_the_device_page_and_never_from_a_line_that_is_not_one() {
    let page = "Open https://auth.openai.com/codex/device.\n";
    // Punctuation after the link is not part of it.
    let p = read_prompt(&format!("{page}Enter this code\n  ABCD-1234\n"));
    assert_eq!(p.url.as_deref(), Some(DEVICE_LOGIN_URL));
    assert_eq!(p.code.as_deref(), Some("ABCD-1234"));
    assert!(!p.foreign_url);
    // No dash: the first line after the instruction that is only capitals and digits, with a digit in it.
    let p = read_prompt(&format!("{page}Enter the code below\nNOTACODE\nABC123XY\nZZZ999\ncut"));
    assert_eq!(p.code.as_deref(), Some("ABC123XY"));
    // Without the instruction a plain run of capitals is not a code; a dashed one still is.
    assert_eq!(read_prompt(&format!("{page}ABC123XY\n")).code, None);
    assert_eq!(
        read_prompt(&format!("{page}code: WXYZ-9876-ABCD \t\n")).code.as_deref(),
        Some("WXYZ-9876-ABCD")
    );
    // The instruction's own line is not searched, and a plain code's line must be complete.
    assert_eq!(read_prompt(&format!("{page}one-time code ABC123XY\n")).code, None);
    assert_eq!(read_prompt(&format!("{page}one-time code\nABC123XY")).code, None);
    // Too short, too long, lower case, or glued to other text: not a code.
    for not in ["AB-12", "ABCD-123456789", "abcd-1234", "xABCD-1234", "ABCD-1234x"] {
        assert_eq!(
            read_prompt(&format!("{page}Enter this code\n{not}\n")).code,
            None,
            "{not}"
        );
    }
    // A code printed before the page is not the page's code.
    let p = read_prompt("ABCD-1234\nhttps://auth.openai.com/codex/device\n");
    assert_eq!((p.url.as_deref(), p.code), (Some(DEVICE_LOGIN_URL), None));
    // A link elsewhere, and none to the page: foreign. One of each: the page wins and nothing is foreign.
    let p = read_prompt("see https://example.test/x\nEnter this code\nABCD-1234\n");
    assert!(p.foreign_url && p.url.is_none() && p.code.as_deref() == Some("ABCD-1234"));
    let p = read_prompt("see https://example.test/x then https://auth.openai.com/codex/device\n");
    assert!(!p.foreign_url && p.url.is_some());
    // The minutes are read after the page only; three digits at most.
    assert_eq!(
        read_prompt(&format!("{page}(Expires In 5 Minute)\n")).expires_in_ms,
        300_000
    );
    assert_eq!(
        read_prompt(&format!("{page}expires in 1234 minutes\n")).expires_in_ms,
        MINUTES_15
    );
    assert_eq!(
        read_prompt("expires in 5 minutes\nhttps://auth.openai.com/codex/device\n").expires_in_ms,
        MINUTES_15
    );
}

#[test]
fn the_reason_is_the_last_line_that_names_trouble_cut_to_300_and_never_a_warning() {
    assert_eq!(
        classify_login_error("").error,
        "Codex couldn't sign in.",
        "nothing said"
    );
    assert_eq!(
        classify_login_error("WARNING: only this\n").error,
        "Codex couldn't sign in."
    );
    assert_eq!(
        classify_login_error("first line\nError: it failed here\nlast line\n").error,
        "Codex couldn't sign in: it failed here"
    );
    assert_eq!(
        classify_login_error("nothing wrong\njust words\n").error,
        "Codex couldn't sign in: just words",
        "no line names trouble: the last one"
    );
    assert_eq!(
        classify_login_error("ERROR LOGGING IN:\u{a0}  access   denied\tby\u{feff}policy").error,
        "Codex couldn't sign in: access denied by policy"
    );
    // "Warningly" is not a warning (the word must end there); a warning in lower case is one.
    assert_eq!(
        classify_login_error("warning: x failed\nWARNINGLY error\n").error,
        "Codex couldn't sign in: WARNINGLY error"
    );
    let long = format!("Error: {}", "é".repeat(400));
    let error = classify_login_error(&long).error;
    assert_eq!(error, format!("Codex couldn't sign in: {}...", "é".repeat(297)));
    // The other kinds, each by any of its wordings.
    for (text, code) in [
        (
            "Device Code sign-in was\nturned off by your admin",
            LoginCode::DeviceCodeDisabled,
        ),
        ("device-auth is disabled", LoginCode::DeviceCodeDisabled),
        ("device auth timed out", LoginCode::Timeout),
        ("Timed out after 1 minute", LoginCode::Timeout),
        ("Connection Refused", LoginCode::Network),
        ("dns error: no such host", LoginCode::Network),
        ("failed to lookup address information", LoginCode::Network),
        ("network is unreachable", LoginCode::Network),
        ("timed out connecting", LoginCode::Network),
        ("connection reset by peer", LoginCode::Network),
    ] {
        assert_eq!(classify_login_error(text).code, code, "{text}");
    }
    // More than 80 characters between the two halves is not the switched-off message.
    let far = format!("device code {} disabled", "x".repeat(81));
    assert_eq!(classify_login_error(&far).code, LoginCode::Failed);
}

#[test]
fn codexs_own_words_say_how_the_home_is_signed_in() {
    let method = |text: &str| match status_method(text) {
        Said::Method(m) => Some(m.as_str()),
        Said::NotSignedIn => Some("none"),
        Said::Unreadable => None,
    };
    assert_eq!(method("Not logged in\n"), Some("none"));
    assert_eq!(method("not logged in"), Some("none"));
    assert_eq!(method("Logged in using ChatGPT\n"), Some("chatgpt"));
    assert_eq!(
        method("API key configured - sk-test-***0abcd\nAuthentication is checked when you send a request.\n"),
        Some("api")
    );
    assert_eq!(method("Logged in using an API key - sk-...\n"), Some("api"));
    assert_eq!(method("Logged in using an access token\n"), Some("other"));
    assert_eq!(method("Something else entirely"), None);
    assert_eq!(method(""), None);
    // "Not logged in" wins over anything else on the page; glued to a word it is not that.
    assert_eq!(method("Logged in using ChatGPT\nNot logged in"), Some("none"));
    assert_eq!(method("xNot logged inx Logged in using ChatGPT"), Some("chatgpt"));
}

fn write_auth(home: &Path, body: &str) {
    std::fs::create_dir_all(home).unwrap();
    std::fs::write(home.join("auth.json"), body).unwrap();
}

fn tokens(id_token: Value) -> Value {
    json!({
        "id_token": id_token,
        "access_token": format!("at-{}", "test-canary-0001"),
        "refresh_token": format!("rt-{}", "test-canary-0001"),
        "account_id": "acct-test",
    })
}

/// What `login_status` with `cli: false` says of an auth.json, as JSON.
fn file_status(body: &str) -> Value {
    let tmp = tmp_dir();
    let home = tmp.path().join("home");
    write_auth(&home, body);
    let status = status_shape(
        read_auth_summary(&home).as_ref().map(|f| f.method),
        read_auth_summary(&home).as_ref(),
    );
    serde_json::to_value(status).unwrap()
}

#[test]
fn auth_json_says_who_is_signed_in_and_never_a_token() {
    let claims = json!({
        "email": "someone@example.test",
        "https://api.openai.com/auth": { "chatgpt_plan_type": "free", "chatgpt_account_id": "acct-test" },
    });
    let body = json!({
        "auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": tokens(json!(jwt(&claims))),
        "last_refresh": "2026-11-02T03:04:05Z",
    });
    let status = file_status(&body.to_string());
    assert_eq!(
        status,
        json!({ "signedIn": true, "method": "chatgpt", "email": "someone@example.test", "plan": "free", "lastRefresh": "2026-11-02T03:04:05.000Z" })
    );
    assert_eq!(
        status.to_string(),
        r#"{"signedIn":true,"method":"chatgpt","email":"someone@example.test","plan":"free","lastRefresh":"2026-11-02T03:04:05.000Z"}"#,
        "in the JS order"
    );
    assert!(!status.to_string().contains("canary"));
    // The email can come from the profile claim; the token can be an object holding the JWT.
    let profile = json!({
        "https://api.openai.com/profile": { "email": "profile@example.test" },
        "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" },
    });
    let body = json!({ "auth_mode": "chatgpt", "tokens": tokens(json!({ "raw_jwt": jwt(&profile) })) });
    assert_eq!(
        file_status(&body.to_string()),
        json!({ "signedIn": true, "method": "chatgpt", "email": "profile@example.test", "plan": "plus" })
    );
    // An API key login: the method, and nothing of the key.
    let body = json!({ "auth_mode": "apikey", "OPENAI_API_KEY": fake_key() });
    assert_eq!(
        file_status(&body.to_string()),
        json!({ "signedIn": true, "method": "api" })
    );
    // No mode written: tokens are a ChatGPT sign-in, else a key is an API login.
    let body = json!({ "tokens": { "access_token": "a" }, "OPENAI_API_KEY": "k" });
    assert_eq!(file_status(&body.to_string())["method"], json!("chatgpt"));
    assert_eq!(
        file_status(&json!({ "OPENAI_API_KEY": "k" }).to_string())["method"],
        json!("api")
    );
    assert_eq!(
        file_status(&json!({ "auth_mode": "API_KEY", "OPENAI_API_KEY": " k " }).to_string())["method"],
        json!("api")
    );
    assert_eq!(
        file_status(&json!({ "auth_mode": "ChatGPT-Enterprise", "tokens": { "refresh_token": "r" } }).to_string())["method"],
        json!("chatgpt")
    );
}

#[test]
fn an_auth_json_that_holds_no_sign_in_is_not_signed_in() {
    let none = json!({ "signedIn": false, "method": null });
    for body in [
        "{ torn".to_string(),
        "".to_string(),
        "null".to_string(),
        "[]".to_string(),
        "\"chatgpt\"".to_string(),
        "{}".to_string(),
        // The mode without what it needs.
        json!({ "auth_mode": "chatgpt" }).to_string(),
        json!({ "auth_mode": "chatgpt", "tokens": {} }).to_string(),
        json!({ "auth_mode": "chatgpt", "tokens": { "access_token": "", "refresh_token": null } }).to_string(),
        json!({ "auth_mode": "chatgpt", "tokens": ["a"] }).to_string(),
        json!({ "auth_mode": "chatgpt", "OPENAI_API_KEY": "k" }).to_string(),
        json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "   " }).to_string(),
        json!({ "auth_mode": "apikey", "OPENAI_API_KEY": 42 }).to_string(),
        json!({ "auth_mode": "apikey", "tokens": { "access_token": "a" } }).to_string(),
        // A mode Tarsee doesn't know is no sign-in, whatever else is there.
        json!({ "auth_mode": "sso", "tokens": { "access_token": "a" }, "OPENAI_API_KEY": "k" }).to_string(),
        json!({ "auth_mode": 7, "tokens": { "access_token": "a" } }).to_string(),
        json!({ "auth_mode": {}, "OPENAI_API_KEY": "k" }).to_string(),
    ] {
        assert_eq!(file_status(&body), none, "{body}");
    }
    // No file, or a folder where it should be.
    let tmp = tmp_dir();
    assert_eq!(read_auth_summary(tmp.path()), None);
    std::fs::create_dir(tmp.path().join("auth.json")).unwrap();
    assert_eq!(read_auth_summary(tmp.path()), None);
}

#[test]
fn auth_json_is_read_as_json_parse_read_it() {
    // A byte order mark; a mode given as a one-item list (String(["chatgpt"]) is "chatgpt"); half a surrogate pair,
    // a number past the largest double and deep nesting elsewhere in the file: Node read all of these as signed in.
    let deep = format!("{}{}", "[".repeat(300), "]".repeat(300));
    let body = format!(
        "\u{FEFF}{{\"auth_mode\":[\"ChatGPT\"],\"tokens\":{{\"access_token\":1e400}},\"x\":\"\\ud800\",\"deep\":{deep}}}"
    );
    assert_eq!(file_status(&body), json!({ "signedIn": true, "method": "chatgpt" }));
    // Truthiness is JavaScript's: 0, "", null and false are no token; anything else is one.
    for (token, signed_in) in [
        ("0", false),
        ("\"\"", false),
        ("false", false),
        ("null", false),
        ("-0", false),
        ("1", true),
        ("\"0\"", true),
        ("true", true),
        ("[]", true),
        ("{}", true),
    ] {
        let body = format!("{{\"tokens\":{{\"refresh_token\":{token}}}}}");
        assert_eq!(file_status(&body)["signedIn"], json!(signed_in), "{token}");
    }
    // A later duplicate member wins, as in JavaScript.
    let body = r#"{"auth_mode":"apikey","OPENAI_API_KEY":"k","auth_mode":"chatgpt","tokens":{"access_token":"a"}}"#;
    assert_eq!(file_status(body)["method"], json!("chatgpt"));
}

#[test]
fn the_email_plan_and_last_refresh_are_shown_only_when_they_look_like_what_they_are() {
    let status = |claims: Value, last_refresh: Value| {
        let body =
            json!({ "auth_mode": "chatgpt", "tokens": tokens(json!(jwt(&claims))), "last_refresh": last_refresh });
        file_status(&body.to_string())
    };
    let bare = json!({ "signedIn": true, "method": "chatgpt" });
    // Not an address, too long, or not text: left out. The same for a plan.
    for email in [
        json!("no-at-sign"),
        json!("two words@example.test"),
        json!("a@b@c"),
        json!(format!("{}@example.test", "a".repeat(250))),
        json!(42),
        json!(null),
        json!(["a@example.test"]),
    ] {
        assert_eq!(status(json!({ "email": email }), json!(null)), bare, "{email}");
    }
    for plan in [
        json!("two words"),
        json!(""),
        json!("p".repeat(41)),
        json!("plüs"),
        json!(7),
    ] {
        let claims = json!({ "https://api.openai.com/auth": { "chatgpt_plan_type": plan } });
        assert_eq!(status(claims, json!(null)), bare, "{plan}");
    }
    let claims = json!({ "email": "a@b", "https://api.openai.com/auth": { "chatgpt_plan_type": "Team_2-x" } });
    assert_eq!(
        status(claims, json!(null)),
        json!({ "signedIn": true, "method": "chatgpt", "email": "a@b", "plan": "Team_2-x" })
    );
    // A bad address in the first place falls through to the profile's.
    let claims = json!({ "email": "nope", "https://api.openai.com/profile": { "email": "p@example.test" } });
    assert_eq!(status(claims, json!(null))["email"], json!("p@example.test"));
    // The last refresh: the form Codex writes (any zone, any fraction), a date, or a number of milliseconds.
    for (written, shown) in [
        (json!("2026-11-01T10:00:00Z"), Some("2026-11-01T10:00:00.000Z")),
        (
            json!("2026-11-01T10:00:00.123456789Z"),
            Some("2026-11-01T10:00:00.123Z"),
        ),
        (json!("2026-11-01T18:00:00+08:00"), Some("2026-11-01T10:00:00.000Z")),
        (json!("2026-11-01"), Some("2026-11-01T00:00:00.000Z")),
        (json!(1_794_472_200_123_i64), Some("2026-11-12T08:30:00.123Z")),
        (json!(1.9), Some("1970-01-01T00:00:00.001Z")),
        (json!(true), Some("1970-01-01T00:00:00.001Z")),
        (json!("yesterday"), None),
        (json!(""), None),
        (json!(0), None),
        (json!(false), None),
        (json!(1e300), None),
        (json!({}), None),
    ] {
        let got = status(json!({}), written.clone());
        assert_eq!(got.get("lastRefresh").and_then(Value::as_str), shown, "{written}");
    }
    // A token that is not a JWT, or whose middle is not a JSON object, gives no details and is still a sign-in.
    for id_token in [
        json!("not-a-jwt"),
        json!("a..c"),
        json!(format!("a.{}.c", URL_SAFE_NO_PAD.encode("[1]"))),
        json!(format!("a.{}.c", URL_SAFE_NO_PAD.encode("{ torn"))),
        json!(format!("a.{}.c", "A".repeat(16_385))),
        json!(null),
        json!(7),
        json!({ "raw_jwt": 7 }),
    ] {
        let body = json!({ "auth_mode": "chatgpt", "tokens": tokens(id_token.clone()) });
        assert_eq!(file_status(&body.to_string()), bare, "{id_token}");
    }
}

#[test]
fn a_moment_is_read_and_written_as_v8_reads_and_writes_it() {
    // Node 22: new Date(text).toISOString(), or null for an invalid date.
    let read = [
        ("2026-11-01T10:00:00Z", Some("2026-11-01T10:00:00.000Z")),
        ("2026-11-01T10:00:00.123456789Z", Some("2026-11-01T10:00:00.123Z")),
        ("2026-11-01T18:00:00+08:00", Some("2026-11-01T10:00:00.000Z")),
        ("2026-11-01", Some("2026-11-01T00:00:00.000Z")),
        ("2026-11", Some("2026-11-01T00:00:00.000Z")),
        ("2026", Some("2026-01-01T00:00:00.000Z")),
        ("2026-11-01T10:00Z", Some("2026-11-01T10:00:00.000Z")),
        ("2026-11-01T10:00:00.5Z", Some("2026-11-01T10:00:00.500Z")),
        ("2026-11-01T10:00:00.12Z", Some("2026-11-01T10:00:00.120Z")),
        ("2026-11-01T10:00:00.1239Z", Some("2026-11-01T10:00:00.123Z")),
        ("2026-11-01T10:00:00.Z", None),
        ("2026-11-01T10:00:00-00:00", Some("2026-11-01T10:00:00.000Z")),
        ("2026-11-01T10:00:00-05:30", Some("2026-11-01T15:30:00.000Z")),
        ("2026-11-01T10:00:00+0800", Some("2026-11-01T02:00:00.000Z")),
        ("2026-11-01T10:00:00+08", None),
        ("2026-11-01T10:00:00+99:99", None),
        ("2026-11-01T10:00:00+24:00", None),
        ("2026-11-01T10:00:00Z ", None),
        (" 2026-11-01T10:00:00Z", None),
        ("2026-11-01T10:00:00z", Some("2026-11-01T10:00:00.000Z")),
        ("2026-11-01t10:00:00Z", Some("2026-11-01T10:00:00.000Z")),
        ("2026-11-01 10:00:00Z", Some("2026-11-01T10:00:00.000Z")),
        ("2026-11-01T10", None),
        ("2026-11-01T", None),
        ("2026-13-01T10:00:00Z", None),
        ("2026-00-01T10:00:00Z", None),
        ("2026-02-30T00:00:00Z", Some("2026-03-02T00:00:00.000Z")),
        ("2026-02-31", Some("2026-03-03T00:00:00.000Z")),
        ("2026-04-31T00:00:00Z", Some("2026-05-01T00:00:00.000Z")),
        ("2026-01-32", None),
        ("2026-01-00", None),
        ("2026-11-01T24:00:00Z", Some("2026-11-02T00:00:00.000Z")),
        ("2026-11-01T24:00:00.000Z", Some("2026-11-02T00:00:00.000Z")),
        ("2026-11-01T24:00:01Z", None),
        ("2026-11-01T24:01:00Z", None),
        ("2026-11-01T25:00:00Z", None),
        ("2026-11-01T23:60:00Z", None),
        ("2026-11-01T23:59:60Z", None),
        ("2026-11-01T23:59:59.9999Z", Some("2026-11-01T23:59:59.999Z")),
        ("0001-01-01T00:00:00Z", Some("0001-01-01T00:00:00.000Z")),
        ("0000-01-01T00:00:00Z", Some("0000-01-01T00:00:00.000Z")),
        ("9999-12-31T23:59:59.999Z", Some("9999-12-31T23:59:59.999Z")),
        ("+010000-01-01T00:00:00Z", Some("+010000-01-01T00:00:00.000Z")),
        ("-000001-01-01T00:00:00Z", Some("-000001-01-01T00:00:00.000Z")),
        ("-000000-01-01T00:00:00Z", None),
        ("+275760-09-13T00:00:00.000Z", Some("+275760-09-13T00:00:00.000Z")),
        ("+275760-09-13T00:00:00.001Z", None),
        ("-271821-04-20T00:00:00.000Z", Some("-271821-04-20T00:00:00.000Z")),
        ("-271821-04-19T23:59:59.999Z", None),
        ("026-11-01", None),
        ("2026-11-01T1:00:00Z", None),
        ("2026-11-01T10:0:00Z", None),
        ("20261101", None),
        ("2026-11-01T10:00:00.123+01:00", Some("2026-11-01T09:00:00.123Z")),
        ("2026-11-01T10:00:00,123Z", None),
        ("2026-11-01T10:00:00.123 Z", None),
        ("2026-11-01T10:00:00Zjunk", None),
        ("2026-11-01T10:00:00+08:00x", None),
        ("2026-11-01T10:00:00.１２３Z", None),
        ("yesterday", None),
        ("", None),
        (" ", None),
        ("2026-W10", None),
        ("2026-305", None),
        ("1969-12-31T23:59:59.999Z", Some("1969-12-31T23:59:59.999Z")),
        ("1600-02-29T12:00:00Z", Some("1600-02-29T12:00:00.000Z")),
        ("2000-02-29T00:00:00Z", Some("2000-02-29T00:00:00.000Z")),
        ("1900-02-29T00:00:00Z", Some("1900-03-01T00:00:00.000Z")),
        ("2024-02-29T00:00:00Z", Some("2024-02-29T00:00:00.000Z")),
    ];
    for (text, want) in read {
        assert_eq!(iso_ms(text).map(iso_string).as_deref(), want, "{text:?}");
    }
    // A time with no zone is the server's own time to JavaScript, and V8 also reads older forms; neither is read
    // here (Codex writes its moments with their zone).
    for local in [
        "2026-11-01T10:00:00",
        "2026-11-01T10:00",
        "+2026-11-01",
        "12026-11-01",
        "2026-1-01",
        "2026-11-1",
        "2026/11/01",
        "Nov 1 2026",
        "0",
        "1",
    ] {
        assert_eq!(iso_ms(local), None, "{local:?}");
    }
    // Node: new Date(ms).toISOString().
    for (ms, want) in [
        (0, "1970-01-01T00:00:00.000Z"),
        (-1, "1969-12-31T23:59:59.999Z"),
        (8_640_000_000_000_000, "+275760-09-13T00:00:00.000Z"),
        (-8_640_000_000_000_000, "-271821-04-20T00:00:00.000Z"),
        (253_402_300_799_999, "9999-12-31T23:59:59.999Z"),
        (253_402_300_800_000, "+010000-01-01T00:00:00.000Z"),
        (-62_167_219_200_000, "0000-01-01T00:00:00.000Z"),
        (-62_167_219_200_001, "-000001-12-31T23:59:59.999Z"),
        (-62_198_755_200_000, "-000001-01-01T00:00:00.000Z"),
        (1_794_472_200_123, "2026-11-12T08:30:00.123Z"),
    ] {
        assert_eq!(iso_string(ms), want, "{ms}");
    }
    // A number is a moment when a Date can hold it; a fraction of a millisecond is dropped.
    let of = |text: &str| js_date_iso(&parse_document(text).unwrap());
    assert_eq!(of("1.9").as_deref(), Some("1970-01-01T00:00:00.001Z"));
    assert_eq!(of("-1.9").as_deref(), Some("1969-12-31T23:59:59.999Z"));
    assert_eq!(of("8640000000000000").as_deref(), Some("+275760-09-13T00:00:00.000Z"));
    assert_eq!(of("8640000000000001"), None);
    assert_eq!(of("1e400"), None);
    assert_eq!(of("true").as_deref(), Some("1970-01-01T00:00:00.001Z"));
    assert_eq!(of("[]"), None);
}

#[test]
fn switched_off_is_said_within_80_characters_as_javascript_counts_them() {
    // The tarsier is two UTF-16 units: 39 of them and two spaces are 80, 40 are 82.
    let with = |monkeys: usize| format!("device code {} disabled", "🐒".repeat(monkeys));
    assert_eq!(classify_login_error(&with(39)).code, LoginCode::DeviceCodeDisabled);
    assert_eq!(classify_login_error(&with(40)).code, LoginCode::Failed);
    assert_eq!(
        classify_login_error(&format!("device code {} disabled", "é".repeat(78))).code,
        LoginCode::DeviceCodeDisabled
    );
    // Too far from the first mention, near enough to a later one.
    let twice = format!("device code {} then device auth was disabled", "x".repeat(200));
    assert_eq!(classify_login_error(&twice).code, LoginCode::DeviceCodeDisabled);
}

#[test]
fn base64_is_read_as_node_reads_it() {
    assert_eq!(node_base64_decode("aGVsbG8"), b"hello");
    assert_eq!(node_base64_decode("aGVsbG8="), b"hello");
    assert_eq!(
        node_base64_decode("aGV sbG\n8"),
        b"hello",
        "what is not in the alphabet is skipped"
    );
    assert_eq!(
        node_base64_decode("aGVsbG8=aGVsbG8"),
        b"hello",
        "it stops at the first ="
    );
    assert_eq!(node_base64_decode("-_-_"), [0xfb, 0xff, 0xbf], "the URL alphabet");
    assert_eq!(node_base64_decode("+/+/"), [0xfb, 0xff, 0xbf], "and the plain one");
    assert_eq!(node_base64_decode("a"), b"", "a last group of one is dropped");
    assert_eq!(node_base64_decode(""), b"");
}

#[test]
fn the_shapes_sent_to_the_page_are_the_node_ones() {
    assert_eq!(
        serde_json::to_string(&LoginResult::signed_in(Some("a@b".into()), Some("free".into()))).unwrap(),
        r#"{"ok":true,"method":"chatgpt","email":"a@b","plan":"free"}"#
    );
    assert_eq!(
        serde_json::to_string(&LoginResult::signed_in(None, Some(String::new()))).unwrap(),
        r#"{"ok":true,"method":"chatgpt"}"#
    );
    assert_eq!(
        serde_json::to_string(&LoginResult::failed(LoginCode::Cancelled, messages::CANCELLED)).unwrap(),
        r#"{"ok":false,"code":"cancelled","error":"Sign-in was cancelled."}"#
    );
    let unchecked = LoginStatus {
        checked: Some(false),
        ..status_shape(Some(LoginMethod::Other), None)
    };
    assert_eq!(
        serde_json::to_string(&unchecked).unwrap(),
        r#"{"signedIn":true,"method":"other","checked":false}"#
    );
    let snapshot = DeviceLoginSnapshot {
        status: LoginState::SignedIn,
        started_at: 5,
        url: Some(DEVICE_LOGIN_URL.into()),
        code: Some("TEST-12345".into()),
        expires_at: Some(9),
        finished_at: Some(7),
        error_code: None,
        error: None,
        email: Some("a@b".into()),
        plan: None,
    };
    assert_eq!(
        serde_json::to_string(&snapshot).unwrap(),
        r#"{"status":"signed-in","startedAt":5,"url":"https://auth.openai.com/codex/device","code":"TEST-12345","expiresAt":9,"finishedAt":7,"email":"a@b"}"#
    );
    assert_eq!(
        serde_json::to_string(&LogoutResult {
            ok: false,
            error: Some("x".into())
        })
        .unwrap(),
        r#"{"ok":false,"error":"x"}"#
    );
    assert_eq!(
        serde_json::to_string(&LogoutResult { ok: true, error: None }).unwrap(),
        r#"{"ok":true}"#
    );
}
