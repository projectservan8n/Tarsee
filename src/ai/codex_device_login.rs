//! Port of `src/ai/codex-device-login.js`: signing in to ChatGPT through Codex's own device-code login (design
//! amendment A1, 4.14).
//!
//! Settings > AI starts it: Tarsee runs `codex login --device-auth` with CODEX_HOME pointing at the ChatGPT home
//! (.codex-home, created owner-only), reads OpenAI's sign-in link and the one-time code off its output, and shows
//! them. The person opens the link on any device, signs in to ChatGPT and types the code. Codex then writes
//! $CODEX_HOME/auth.json and exits; the sign-in counts once that file is new and `codex login status` agrees.
//!
//! - [`start_device_login`] gives a [`DeviceLogin`]: `{url, code, expires_at}`, [`DeviceLogin::done`] (resolves
//!   `{ok:true, method:'chatgpt', email?, plan?}` or `{ok:false, code, error}`; never fails) and
//!   [`DeviceLogin::cancel`]; cancel and the 15-minute limit kill codex and its children. One login per home at a
//!   time: starting again while one waits returns it.
//! - [`get_device_login`]: where the current (or last) login is: waiting, signed-in, failed, cancelled, expired.
//! - [`cancel_device_login`]: stop the login in progress, if any.
//! - [`login_status`]: `{signedIn, method:'chatgpt'|'api'|null, email?, plan?, lastRefresh?}`, never a token.
//! - [`logout`]: `codex logout`, then makes sure auth.json is gone.
//!
//! Only OpenAI's own device page (https://auth.openai.com/codex/device) is ever passed on: output pointing anywhere
//! else stops the login. A file Codex would load that could redirect it (`codex_config_guard`, R5: the home's
//! config.toml, or any .env in it) refuses the login before codex starts, and keeps `codex login status` and
//! `codex logout` from running in that home (the status then comes from auth.json, checked:false). codex runs with
//! the server's environment minus every credential (`engine_env` `base_env`), so no API key or base URL on the server
//! can change what it signs in to. Errors are plain language for the person at the screen; when ChatGPT has
//! device-code sign-in switched off, the answer says where to switch it on.
//!
//! The login in progress is state of the app ([`DeviceLogins`]), where the JS kept a module-level map. The work the
//! JS did on timers and events after `startDeviceLogin` returned is a task here, so it goes on whether or not the
//! caller that started the login is still there.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Child;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::codex_cli::{
    CODEX_BASE_ARGS, CodexCliCode, CodexCliError, RunCodexOpts, SpawnOpts, auth_fingerprint, codex_child_env,
    kill_tree, require_codex_home, resolve_codex_bin, run_codex, spawn_codex, strip_ansi,
};
use super::context_limits::JS_SPACE_CLASS;
use super::engine_env::js_json::{Json, is_blank, parse_document};
use super::engine_env::{EnvMap, TypeError, codex_config_files_for, codex_config_guard, ensure_home, read_text};
use crate::app::App;
use crate::env::Env;
use crate::lib::model_picker::js_number_to_string;
use crate::lib::redact::redact_secrets;
use crate::lib::run_cmd::{node_error_code, spawn_error_code};
use crate::util::js;

/// OpenAI's device sign-in page, the only link Tarsee passes on.
pub const DEVICE_LOGIN_URL: &str = "https://auth.openai.com/codex/device";

/// What the person is told when ChatGPT has device-code sign-in switched off.
pub const DEVICE_CODE_DISABLED_MESSAGE: &str =
    "In ChatGPT, open Settings → Security and, under App security, turn on \"Enable device code sign-in for Codex\"";

/// How long a one-time code lasts (the CLI says so too, and gives up after it), in milliseconds.
pub const LOGIN_TTL_MS: u64 = 15 * 60_000;

/// How long a stopped codex gets to end by itself before it is killed (the JS `killTree` default).
const KILL_GRACE: Duration = Duration::from_millis(2000);

mod messages {
    pub const CANCELLED: &str = "Sign-in was cancelled.";
    pub const TIMEOUT: &str = "The sign-in code expired before it was used. Start again for a new code.";
    pub const NETWORK: &str =
        "Couldn't reach OpenAI to start the sign-in. Check this server's internet connection and try again.";
    pub const NO_CODE: &str =
        "Codex didn't show a sign-in code in time. Check this server's internet connection and try again.";
    pub const NOT_CONFIRMED: &str = "Codex finished without signing in. Start again for a new code.";
    pub const UNEXPECTED_OUTPUT: &str = "Codex didn't show OpenAI's sign-in page, so Tarsee stopped it. Try again, or sign in from the Terminal with: codex login --device-auth";
    pub const FAILED: &str = "Codex couldn't sign in";
}

/// Why a login couldn't start, or how one ended without a sign-in (the JS `code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoginCode {
    DeviceCodeDisabled,
    Network,
    NoCode,
    UnexpectedOutput,
    UnsafeConfig,
    HomeFailed,
    CodexMissing,
    SpawnFailed,
    Cancelled,
    Failed,
    Timeout,
    NotConfirmed,
}

impl LoginCode {
    /// The code as the JS spelled it ("device-code-disabled", ...): it reaches the UI.
    pub fn as_str(self) -> &'static str {
        match self {
            LoginCode::DeviceCodeDisabled => "device-code-disabled",
            LoginCode::Network => "network",
            LoginCode::NoCode => "no-code",
            LoginCode::UnexpectedOutput => "unexpected-output",
            LoginCode::UnsafeConfig => "unsafe-config",
            LoginCode::HomeFailed => "home-failed",
            LoginCode::CodexMissing => "codex-missing",
            LoginCode::SpawnFailed => "spawn-failed",
            LoginCode::Cancelled => "cancelled",
            LoginCode::Failed => "failed",
            LoginCode::Timeout => "timeout",
            LoginCode::NotConfirmed => "not-confirmed",
        }
    }
}

impl std::fmt::Display for LoginCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A login that couldn't start. code: device-code-disabled, network, no-code, unexpected-output, unsafe-config,
/// home-failed, codex-missing, spawn-failed, cancelled, failed (or timeout, when the CLI itself gave up).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct DeviceLoginError {
    pub code: LoginCode,
    pub message: String,
}

impl DeviceLoginError {
    fn new(code: LoginCode, message: impl Into<String>) -> Self {
        DeviceLoginError {
            code,
            message: message.into(),
        }
    }
}

/// What [`start_device_login`] fails with: a login that couldn't start, or no home named (a caller's mistake, the JS
/// `TypeError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StartLoginError {
    #[error(transparent)]
    Login(#[from] DeviceLoginError),
    #[error(transparent)]
    Type(#[from] TypeError),
}

impl StartLoginError {
    /// The login's own failure, when it is one (`err instanceof DeviceLoginError`).
    pub fn login(&self) -> Option<&DeviceLoginError> {
        match self {
            StartLoginError::Login(err) => Some(err),
            StartLoginError::Type(_) => None,
        }
    }

    /// The failure's code, when it is a login's.
    pub fn code(&self) -> Option<LoginCode> {
        self.login().map(|err| err.code)
    }
}

// --- Reading the CLI's output ---------------------------------------------------------------------------------------

/// True only for https://auth.openai.com/codex/device, with or without a query.
fn is_device_page(raw: &str) -> bool {
    let Ok(u) = url::Url::parse(raw) else { return false };
    u.scheme() == "https"
        && u.host_str() == Some("auth.openai.com")
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none_or(str::is_empty)
        && u.path() == "/codex/device"
}

/// `/https?:\/\/[^\s"'<>]+/g`
static URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r#"https?://[^{JS_SPACE_CLASS}"'<>]+"#)).expect("the link pattern"));

/// A code like ABCD-12345: groups of capitals and digits joined by dashes, alone on its line.
/// `/(?:^|[\s:])([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+)[ \t]*\n/`
static DASHED_CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[{JS_SPACE_CLASS}:])([A-Z0-9]{{4,8}}(?:-[A-Z0-9]{{4,8}})+)[ \t]*\n"
    ))
    .expect("the dashed-code pattern")
});

/// `/^[ \t]*([A-Z0-9]{6,12})[ \t]*$/`
static PLAIN_CODE_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]*([A-Z0-9]{6,12})[ \t]*$").expect("the plain-code pattern"));

/// `/one-time code|enter (?:this|the) code/i`
static MARKER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:one-time code|enter (?:this|the) code)").expect("the instruction pattern"));

/// `/expires in (\d{1,3}) minutes?/i`
static EXPIRES_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:expires in ([0-9]{1,3}) minutes?)").expect("the expiry pattern"));

/// The CLI's words without their colours, every line end a line feed (`stripAnsi(text).replace(/\r\n?/g, "\n")`).
fn plain_text(text: &str) -> String {
    strip_ansi(text).replace("\r\n", "\n").replace('\r', "\n")
}

struct Prompt {
    url: Option<String>,
    code: Option<String>,
    expires_in_ms: u64,
    /// A link was printed that isn't OpenAI's device page (and none that is).
    foreign_url: bool,
}

/// The link, the code and how long it lasts, from the CLI's output so far; parts are `None` until they've arrived.
/// The code must be followed by a line break, so a code cut off mid-stream is never taken. `foreign_url` is true
/// when a link was printed that isn't OpenAI's device page.
fn read_prompt(text: &str) -> Prompt {
    let plain = plain_text(text);
    let mut url = None;
    let mut from = 0;
    let mut foreign_url = false;
    for m in URL_RE.find_iter(&plain) {
        let raw = m.as_str().trim_end_matches(['.', ',', ';', ':', ')', ']']);
        if is_device_page(raw) {
            url = Some(raw.to_string());
            from = m.end();
            break;
        }
        foreign_url = true;
    }
    let after = &plain[from..];
    let marker = MARKER_RE.find(after);
    let region = marker.map_or(after, |m| &after[m.end()..]);
    let mut code = DASHED_CODE_RE.captures(region).map(|c| c[1].to_string());
    if code.is_none() && marker.is_some() {
        // No dash: the first line after the instruction that is just capitals and digits, with a digit in it.
        let mut lines: Vec<&str> = region.split('\n').collect();
        lines.pop(); // the last piece may be cut off
        code = lines
            .iter()
            .skip(1)
            .filter_map(|line| PLAIN_CODE_LINE_RE.captures(line))
            .map(|c| c[1].to_string())
            .find(|candidate| candidate.bytes().any(|b| b.is_ascii_digit()));
    }
    let minutes = EXPIRES_RE
        .captures(after)
        .and_then(|c| c[1].parse::<u64>().ok())
        .unwrap_or(15);
    Prompt {
        foreign_url: foreign_url && url.is_none(),
        url,
        code,
        expires_in_ms: minutes * 60_000,
    }
}

/// What the CLI showed: OpenAI's device page, the one-time code, and how long the code lasts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthPrompt {
    pub url: String,
    pub code: String,
    pub expires_in_ms: u64,
}

/// `{url, code, expiresInMs}` once the CLI has shown OpenAI's device page and a complete one-time code, else `None`.
/// Works on raw output: ANSI colours, CRLF, and output cut anywhere.
pub fn parse_device_auth_output(text: &str) -> Option<DeviceAuthPrompt> {
    let p = read_prompt(text);
    Some(DeviceAuthPrompt {
        url: p.url?,
        code: p.code?,
        expires_in_ms: p.expires_in_ms,
    })
}

/// `/^WARNING\b/i`
static WARNING_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u:^WARNING\b)").expect("the warning pattern"));

/// `/error|fail|denied|invalid|unable|could not|can't/i`
static TROUBLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:error|fail|denied|invalid|unable|could not|can't)").expect("the trouble pattern")
});

/// `/^Error(?: [a-z ]+)?:\s*/i`
static ERROR_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i-u:^Error(?: [a-z ]+)?:)[{JS_SPACE_CLASS}]*")).expect("the error-prefix pattern")
});

/// `/\s+/g`
static SPACES_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{JS_SPACE_CLASS}]+")).expect("the whitespace pattern"));

/// The line that says what went wrong: the last error line, without the CLI's prefix, secrets taken out.
fn reason_line(plain: &str) -> String {
    let lines: Vec<&str> = plain
        .split('\n')
        .map(js::trim)
        .filter(|l| !l.is_empty() && !WARNING_RE.is_match(l))
        .collect();
    let line = lines
        .iter()
        .rev()
        .find(|l| TROUBLE_RE.is_match(l))
        .or(lines.last())
        .copied()
        .unwrap_or("");
    let bare = ERROR_PREFIX_RE.replace(line, "");
    let redacted = redact_secrets(&bare);
    let clean = js::trim(&SPACES_RE.replace_all(&redacted, " ")).to_string();
    if js::utf16_len(&clean) > 300 {
        format!("{}...", js::utf16_truncate(&clean, 297))
    } else {
        clean
    }
}

/// The two ends of `/device[ _-]?(?:code|auth)[\s\S]{0,80}?(?:not[ _-]?enabled|disabled|turned[ _-]?off)/i`.
static DEVICE_CODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:device[ _-]?(?:code|auth))").expect("the device-code pattern"));
static SWITCHED_OFF_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:not[ _-]?enabled|disabled|turned[ _-]?off)").expect("the switched-off pattern")
});

/// Whether the CLI said device-code sign-in is switched off: "device code" (or "device auth") with "not enabled",
/// "disabled" or "turned off" at most 80 characters after it, counted as JavaScript counts them (UTF-16 units).
fn says_device_code_is_off(plain: &str) -> bool {
    DEVICE_CODE_RE.find_iter(plain).any(|device| {
        let rest = &plain[device.end()..];
        SWITCHED_OFF_RE
            .find(rest)
            .is_some_and(|off| js::utf16_len(&rest[..off.start()]) <= 80)
    })
}

/// `/timed out after \d+ minutes?|device auth timed out/i`
static TIMED_OUT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:timed out after [0-9]+ minutes?|device auth timed out)").expect("the timed-out pattern")
});

static NETWORK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:failed to request device code|error sending request|connection (?:refused|reset)|dns error|failed to lookup address|network is unreachable|timed out connecting)")
        .expect("the network pattern")
});

/// What the CLI's error output means for the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginFailure {
    pub code: LoginCode,
    pub error: String,
}

/// What the CLI's error output means for the person: `{code, error}`.
pub fn classify_login_error(text: &str) -> LoginFailure {
    let plain = plain_text(text);
    let failure = |code: LoginCode, error: &str| LoginFailure {
        code,
        error: error.to_string(),
    };
    if says_device_code_is_off(&plain) {
        return failure(LoginCode::DeviceCodeDisabled, DEVICE_CODE_DISABLED_MESSAGE);
    }
    if TIMED_OUT_RE.is_match(&plain) {
        return failure(LoginCode::Timeout, messages::TIMEOUT);
    }
    if NETWORK_RE.is_match(&plain) {
        return failure(LoginCode::Network, messages::NETWORK);
    }
    let line = reason_line(&plain);
    LoginFailure {
        code: LoginCode::Failed,
        error: if line.is_empty() {
            format!("{}.", messages::FAILED)
        } else {
            format!("{}: {line}", messages::FAILED)
        },
    }
}

// --- auth.json, read for display only ------------------------------------------------------------------------------

/// `Buffer.from(text, "base64url")`: Node takes both alphabets, skips every other character, stops at the first
/// `=`, and drops a last incomplete group. Never fails.
fn node_base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut group = 0u32;
    let mut filled = 0u8;
    for byte in text.bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        group = (group << 6) | u32::from(sextet);
        filled += 1;
        if filled == 4 {
            out.extend_from_slice(&[(group >> 16) as u8, (group >> 8) as u8, group as u8]);
            group = 0;
            filled = 0;
        }
    }
    match filled {
        2 => out.push((group >> 4) as u8),
        3 => out.extend_from_slice(&[(group >> 10) as u8, (group >> 2) as u8]),
        _ => {}
    }
    out
}

/// The claims of a sign-in token (a JWT, or `{raw_jwt}`), when its middle part is a JSON object.
fn jwt_claims(token: Option<&Json>) -> Option<Json> {
    let raw = match token {
        Some(Json::Str(_)) => token.and_then(Json::as_text),
        Some(other) => other.get("raw_jwt").and_then(Json::as_text),
        None => None,
    }?;
    let part = raw.split('.').nth(1)?;
    if part.is_empty() || js::utf16_len(part) > 16_384 {
        return None;
    }
    let text = String::from_utf8_lossy(&node_base64_decode(part)).into_owned();
    parse_document(&text).filter(Json::is_object)
}

/// `/^[^\s@]+@[^\s@]+$/`
static EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^[^{JS_SPACE_CLASS}@]+@[^{JS_SPACE_CLASS}@]+$")).expect("the email pattern"));

/// An email address worth showing: text of at most 254 units that looks like one (the JS `cleanEmail`, which this
/// file and `codex_models.rs` each had).
pub(crate) fn clean_email_text(text: &str) -> Option<String> {
    (js::utf16_len(text) <= 254 && EMAIL_RE.is_match(text)).then(|| text.to_string())
}

/// A plan name worth showing: `/^[A-Za-z0-9_-]{1,40}$/` (the JS `cleanPlan`).
pub(crate) fn clean_plan_text(text: &str) -> Option<String> {
    let fits = (1..=40).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    fits.then(|| text.to_string())
}

fn clean_email(value: Option<&Json>) -> Option<String> {
    clean_email_text(&value?.as_text()?)
}

fn clean_plan(value: Option<&Json>) -> Option<String> {
    clean_plan_text(&value?.as_text()?)
}

/// `String(value)` for a JSON value, as far down as `depth` allows (an array is its members joined by commas).
fn js_string(value: &Json, depth: usize) -> String {
    match value {
        Json::Null => "null".to_string(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => js_number_to_string(*n),
        Json::Str(_) => value.as_text().unwrap_or_default(),
        Json::Object(_) => "[object Object]".to_string(),
        Json::Array(_) if depth == 0 => String::new(),
        Json::Array(items) => items
            .iter()
            .map(|item| match item {
                Json::Null => String::new(),
                other => js_string(other, depth - 1),
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// The furthest a JavaScript Date reaches either side of 1970, in milliseconds.
const DATE_RANGE_MS: i64 = 8_640_000_000_000_000;
const DAY_MS: i64 = 86_400_000;

/// The days from 1970-01-01 to a date of the Gregorian calendar (a day past the month's end runs into the next
/// month, as JavaScript's own date arithmetic lets it).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let (era, year_of_era) = (y.div_euclid(400), y.rem_euclid(400));
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468
}

/// The date (year, month, day) that many days from 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let (era, day_of_era) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let m = (5 * day_of_year + 2) / 153;
    let month = if m < 10 { m + 3 } else { m - 9 };
    (
        year_of_era + era * 400 + i64::from(month <= 2),
        month,
        day_of_year - (153 * m + 2) / 5 + 1,
    )
}

/// `new Date(ms).toISOString()`, for any moment a JavaScript Date can hold: a year outside 0 to 9999 is written with
/// a sign and six digits.
fn iso_string(ms: i64) -> String {
    let (days, in_day) = (ms.div_euclid(DAY_MS), ms.rem_euclid(DAY_MS));
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

/// `Date.parse(text)` for the date-time form JavaScript defines and Codex writes: `YYYY-MM-DDTHH:mm:ss.sssZ`, with
/// the leniencies V8 has for it (a year alone or with its month, no seconds, any number of fraction digits, a zone as
/// `Z`, `+HH:mm` or `+HHmm`, lower-case `t` and `z` or a space between date and time, a 24th hour that is midnight,
/// a day up to 31 in any month). A date alone is UTC. `None` for anything else, and for a time with no zone, which
/// JavaScript reads in the server's own timezone (and for the other, older forms V8 also reads, such as
/// "Nov 1 2026").
fn iso_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let mut i = 0;
    fn digits(b: &[u8], i: &mut usize, count: usize) -> Option<i64> {
        let run = b.get(*i..*i + count)?;
        if !run.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *i += count;
        std::str::from_utf8(run).ok()?.parse().ok()
    }
    fn eat(b: &[u8], i: &mut usize, byte: u8) -> Option<()> {
        (b.get(*i) == Some(&byte)).then(|| *i += 1)
    }

    let year = match b.first() {
        Some(sign @ (b'+' | b'-')) => {
            i = 1;
            let year = digits(b, &mut i, 6)?;
            match (*sign, year) {
                (b'-', 0) => return None,
                (b'-', year) => -year,
                (_, year) => year,
            }
        }
        _ => digits(b, &mut i, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if eat(b, &mut i, b'-').is_some() {
        month = digits(b, &mut i, 2)?;
        if eat(b, &mut i, b'-').is_some() {
            day = digits(b, &mut i, 2)?;
        }
    }
    let (mut hour, mut minute, mut second, mut milli, mut offset_minutes) = (0, 0, 0, 0, 0);
    if matches!(b.get(i), Some(b'T' | b't' | b' ')) {
        i += 1;
        hour = digits(b, &mut i, 2)?;
        eat(b, &mut i, b':')?;
        minute = digits(b, &mut i, 2)?;
        if eat(b, &mut i, b':').is_some() {
            second = digits(b, &mut i, 2)?;
            if eat(b, &mut i, b'.').is_some() {
                // The first three digits count; the rest are read and dropped.
                let start = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                let fraction = b.get(start..i).filter(|f| !f.is_empty())?;
                for place in 0..3 {
                    milli = milli * 10 + fraction.get(place).map_or(0, |d| i64::from(d - b'0'));
                }
            }
        }
        match b.get(i) {
            Some(b'Z' | b'z') => i += 1,
            Some(sign @ (b'+' | b'-')) => {
                i += 1;
                let hours = digits(b, &mut i, 2)?;
                let _ = eat(b, &mut i, b':');
                let minutes = digits(b, &mut i, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                offset_minutes = (hours * 60 + minutes) * if *sign == b'-' { -1 } else { 1 };
            }
            // No zone: the server's own timezone, which is not read here.
            _ => return None,
        }
    }
    if i != b.len() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let midnight_as_24 = hour == 24 && minute == 0 && second == 0 && milli == 0;
    if !(midnight_as_24 || (hour <= 23 && minute <= 59 && second <= 59)) {
        return None;
    }
    let ms = days_from_civil(year, month, day)
        .checked_mul(DAY_MS)?
        .checked_add(hour * 3_600_000 + minute * 60_000 + second * 1000 + milli - offset_minutes * 60_000)?;
    (ms.abs() <= DATE_RANGE_MS).then_some(ms)
}

/// `new Date(value).toISOString()` for a truthy JSON value, when it is a moment: a number of milliseconds, or text
/// that [`iso_ms`] reads. `None` for anything else, as for a date that is not valid in JavaScript.
fn js_date_iso(value: &Json) -> Option<String> {
    let ms = match value {
        Json::Number(n) if n.is_finite() && n.abs() <= DATE_RANGE_MS as f64 => n.trunc() as i64,
        Json::Bool(true) => 1,
        Json::Str(_) => iso_ms(&value.as_text()?)?,
        _ => return None,
    };
    Some(iso_string(ms))
}

/// How a Codex home is signed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginMethod {
    /// A ChatGPT account (the device sign-in).
    Chatgpt,
    /// An API key login.
    Api,
    /// A sign-in Tarsee doesn't use (an access token, a cloud account).
    Other,
}

impl LoginMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            LoginMethod::Chatgpt => "chatgpt",
            LoginMethod::Api => "api",
            LoginMethod::Other => "other",
        }
    }
}

/// What auth.json says, without a single token.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthSummary {
    method: LoginMethod,
    email: Option<String>,
    plan: Option<String>,
    last_refresh: Option<String>,
}

/// What auth.json says, without a single token: `{method, email?, plan?, lastRefresh?}`, or `None` when there's
/// none. Read as `JSON.parse` read it, so a file the Node version called signed in is called signed in here.
fn read_auth_summary(home: &Path) -> Option<AuthSummary> {
    let text = read_text(&home.join("auth.json")).ok()?;
    let json = parse_document(text.strip_prefix('\u{FEFF}').unwrap_or(&text))?;
    if !json.is_object() {
        return None;
    }
    // (An array is an object to JavaScript too, but one with neither token: no sign-in.)
    let tokens = json.get("tokens").filter(|t| t.is_object());
    let has_tokens = tokens.is_some_and(|t| {
        t.get("refresh_token").is_some_and(Json::truthy) || t.get("access_token").is_some_and(Json::truthy)
    });
    let mode = match json.get("auth_mode") {
        None | Some(Json::Null) => String::new(),
        Some(value) => js_string(value, 64).to_lowercase(),
    };
    let has_key = json
        .get("OPENAI_API_KEY")
        .and_then(Json::as_units)
        .is_some_and(|key| !is_blank(key));
    let method = if mode.starts_with("chatgpt") || (mode.is_empty() && has_tokens) {
        has_tokens.then_some(LoginMethod::Chatgpt)
    } else if mode == "apikey" || mode == "api_key" || (mode.is_empty() && has_key) {
        has_key.then_some(LoginMethod::Api)
    } else {
        None
    }?;
    let mut out = AuthSummary {
        method,
        email: None,
        plan: None,
        last_refresh: None,
    };
    if method == LoginMethod::Chatgpt {
        let claims = jwt_claims(tokens.and_then(|t| t.get("id_token")));
        let claim = |name: &str| claims.as_ref().and_then(|c| c.get(name));
        out.email = clean_email(claim("email"))
            .or_else(|| clean_email(claim("https://api.openai.com/profile").and_then(|p| p.get("email"))));
        out.plan = clean_plan(claim("https://api.openai.com/auth").and_then(|a| a.get("chatgpt_plan_type")));
        out.last_refresh = json.get("last_refresh").filter(|at| at.truthy()).and_then(js_date_iso);
    }
    Some(out)
}

/// Who a Codex home is signed in as: `{signedIn, method, email?, plan?, lastRefresh?, checked?}`. Never a token.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub signed_in: bool,
    /// "chatgpt", "api", "other" (a sign-in Tarsee doesn't use), or null when nobody is signed in.
    pub method: Option<LoginMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// When the sign-in was last refreshed, as an ISO moment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refresh: Option<String>,
    /// `Some(false)` when codex couldn't be asked and the answer is the file's alone; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
}

/// The public status shape; details only for a ChatGPT sign-in the file agrees on.
fn status_shape(method: Option<LoginMethod>, file: Option<&AuthSummary>) -> LoginStatus {
    let Some(method) = method else {
        return LoginStatus::default();
    };
    let mut out = LoginStatus {
        signed_in: true,
        method: Some(method),
        ..LoginStatus::default()
    };
    if method == LoginMethod::Chatgpt
        && let Some(file) = file.filter(|f| f.method == LoginMethod::Chatgpt)
    {
        let shown = |text: &Option<String>| text.clone().filter(|t| !t.is_empty());
        out.email = shown(&file.email);
        out.plan = shown(&file.plan);
        out.last_refresh = shown(&file.last_refresh);
    }
    out
}

/// What `codex login status` said.
enum Said {
    Method(LoginMethod),
    NotSignedIn,
    /// Words that say neither.
    Unreadable,
}

static NOT_LOGGED_IN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:\bNot logged in\b)").expect("the not-signed-in pattern"));
static USING_CHATGPT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:Logged in using ChatGPT)").expect("the ChatGPT pattern"));
static USING_KEY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:API key configured|Logged in using an API key)").expect("the API-key pattern"));
static USING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:Logged in using)").expect("the signed-in pattern"));

/// The sign-in `codex login status` reports: chatgpt, api, other, not signed in, or unreadable.
fn status_method(text: &str) -> Said {
    if NOT_LOGGED_IN_RE.is_match(text) {
        Said::NotSignedIn
    } else if USING_CHATGPT_RE.is_match(text) {
        Said::Method(LoginMethod::Chatgpt)
    } else if USING_KEY_RE.is_match(text) {
        Said::Method(LoginMethod::Api)
    } else if USING_RE.is_match(text) {
        Said::Method(LoginMethod::Other)
    } else {
        Said::Unreadable
    }
}

/// How [`login_status`] looks.
#[derive(Debug, Clone)]
pub struct LoginStatusOpts {
    /// The Codex home to look in (required: the ChatGPT home is `provider_status::codex_home_for`).
    pub codex_home: PathBuf,
    /// The codex to ask (else TARSEE_CODEX_PATH, else `codex` on the PATH).
    pub codex_bin: Option<PathBuf>,
    /// The server's environment; default the app's. Credentials are stripped from it.
    pub env: Option<Env>,
    /// False reads auth.json alone, starting nothing.
    pub cli: bool,
    pub timeout: Duration,
}

impl Default for LoginStatusOpts {
    fn default() -> Self {
        LoginStatusOpts {
            codex_home: PathBuf::new(),
            codex_bin: None,
            env: None,
            cli: true,
            timeout: Duration::from_millis(15_000),
        }
    }
}

/// Who this Codex home is signed in as. By default `codex login status` decides (it only reads auth.json; it never
/// goes online) and auth.json supplies the email, plan and last refresh for display. `cli: false` reads the file
/// alone. When codex can't be run or its answer can't be read, the file's answer comes back with `checked: false`.
/// method is chatgpt, api, none, or other for a sign-in Tarsee doesn't use (an access token, a cloud account).
pub async fn login_status(app: &App, opts: &LoginStatusOpts) -> Result<LoginStatus, TypeError> {
    let env = opts.env.clone().unwrap_or_else(|| app.env().clone());
    login_status_in(&env, opts).await
}

/// [`login_status`] with the server's environment given.
async fn login_status_in(env: &Env, opts: &LoginStatusOpts) -> Result<LoginStatus, TypeError> {
    let home = require_codex_home(&opts.codex_home)?;
    let file = read_auth_summary(&home);
    let from_file = || status_shape(file.as_ref().map(|f| f.method), file.as_ref());
    if !opts.cli {
        return Ok(from_file());
    }
    if !home.exists() {
        return Ok(status_shape(None, None));
    }
    let unchecked = || LoginStatus {
        checked: Some(false),
        ..from_file()
    };
    // A home whose files would steer codex (a proxy in its .env, a host in its config.toml): codex isn't run there.
    if !codex_config_guard(&codex_config_files_for(&home, Some(&home)), None).ok {
        return Ok(unchecked());
    }
    let Ok(bin) = resolve_codex_bin(opts.codex_bin.as_deref(), env) else {
        return Ok(unchecked());
    };
    let mut args: Vec<&str> = CODEX_BASE_ARGS.to_vec();
    args.extend(["login", "status"]);
    let run = run_codex(
        &bin,
        &args,
        &RunCodexOpts {
            env: codex_child_env(env, &home, &EnvMap::new()),
            cwd: Some(home.clone()),
            timeout: opts.timeout,
            ..RunCodexOpts::default()
        },
    )
    .await;
    let Ok(run) = run else { return Ok(unchecked()) };
    if run.timed_out {
        return Ok(unchecked());
    }
    Ok(
        match status_method(&strip_ansi(&format!("{}\n{}", run.stderr, run.stdout))) {
            Said::Unreadable => unchecked(),
            Said::NotSignedIn => status_shape(None, file.as_ref()),
            Said::Method(method) => status_shape(Some(method), file.as_ref()),
        },
    )
}

// --- The login ------------------------------------------------------------------------------------------------------

/// Where a login is (the JS `status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoginState {
    Starting,
    Waiting,
    SignedIn,
    Failed,
    Cancelled,
    Expired,
}

impl LoginState {
    pub fn as_str(self) -> &'static str {
        match self {
            LoginState::Starting => "starting",
            LoginState::Waiting => "waiting",
            LoginState::SignedIn => "signed-in",
            LoginState::Failed => "failed",
            LoginState::Cancelled => "cancelled",
            LoginState::Expired => "expired",
        }
    }
}

/// How a login ended: `{ok:true, method:'chatgpt', email?, plan?}` or `{ok:false, code, error}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<LoginMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<LoginCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LoginResult {
    fn signed_in(email: Option<String>, plan: Option<String>) -> Self {
        LoginResult {
            ok: true,
            method: Some(LoginMethod::Chatgpt),
            email: email.filter(|e| !e.is_empty()),
            plan: plan.filter(|p| !p.is_empty()),
            code: None,
            error: None,
        }
    }

    fn failed(code: LoginCode, error: impl Into<String>) -> Self {
        LoginResult {
            ok: false,
            method: None,
            email: None,
            plan: None,
            code: Some(code),
            error: Some(error.into()),
        }
    }
}

/// A login that has shown its link and code and waits for the person: `{url, code, expiresAt, done, cancel}`.
#[derive(Debug, Clone)]
pub struct DeviceLogin {
    pub url: String,
    pub code: String,
    /// When the code stops working, in milliseconds since 1970.
    pub expires_at: i64,
    stop: CancellationToken,
    done: watch::Receiver<Option<LoginResult>>,
    /// The same for every handle to one login.
    identity: Arc<()>,
}

impl DeviceLogin {
    /// How the login ends. Waits for it; never fails. Every caller gets the same answer.
    pub async fn done(&self) -> LoginResult {
        let mut done = self.done.clone();
        match done.wait_for(Option::is_some).await {
            Ok(result) => result
                .clone()
                .unwrap_or_else(|| LoginResult::failed(LoginCode::Failed, format!("{}.", messages::FAILED))),
            // The task that watched the login is gone without an answer (the server is shutting down).
            Err(_) => LoginResult::failed(LoginCode::Failed, format!("{}.", messages::FAILED)),
        }
    }

    /// Stops the login (codex and everything it started is killed) and returns once it has stopped. Harmless on a
    /// login that has ended.
    pub async fn cancel(&self) {
        self.stop.cancel();
        self.done().await;
    }

    /// Whether this is the very same login as `other` (the JS compared the `done` promises).
    pub fn is_same_login(&self, other: &DeviceLogin) -> bool {
        Arc::ptr_eq(&self.identity, &other.identity)
    }
}

/// Where a home's login is, for a page that polls: `{status, url, code, expiresAt, startedAt, finishedAt?,
/// errorCode?, error?, email?, plan?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginSnapshot {
    pub status: LoginState,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<LoginCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

type Started = Option<Result<DeviceLogin, DeviceLoginError>>;

/// One login of one home.
struct Session {
    state: Mutex<DeviceLoginSnapshot>,
    /// The handle, once the login waits for the person.
    handle: Mutex<Option<DeviceLogin>>,
    /// Stops the login, while it starts and while it waits.
    stop: CancellationToken,
    /// How the start ended, once it has.
    started: watch::Receiver<Started>,
}

/// The app's logins by home: the one in progress, or the last one (for [`get_device_login`]). The JS kept this in a
/// module-level map.
#[derive(Default)]
pub struct DeviceLogins {
    by_home: Mutex<HashMap<PathBuf, Arc<Session>>>,
}

impl DeviceLogins {
    /// The app's logins, made on first use.
    pub fn of(app: &App) -> Arc<DeviceLogins> {
        app.get_or_init(DeviceLogins::default)
    }

    fn session(&self, home: &Path) -> Option<Arc<Session>> {
        self.by_home.lock().get(home).cloned()
    }
}

/// How [`start_device_login`] runs the login.
#[derive(Debug, Clone)]
pub struct DeviceLoginOpts {
    /// The Codex home to sign in to (required).
    pub codex_home: PathBuf,
    /// The codex to run (else TARSEE_CODEX_PATH, else `codex` on the PATH).
    pub codex_bin: Option<PathBuf>,
    /// The server's environment; default the app's. Credentials are stripped from it.
    pub env: Option<Env>,
    /// How long the person has; default and maximum: what the CLI says, 15 minutes.
    pub timeout: Duration,
    /// How long codex may take to show the code.
    pub start_timeout: Duration,
    /// How often auth.json is checked.
    pub poll: Duration,
}

impl Default for DeviceLoginOpts {
    fn default() -> Self {
        DeviceLoginOpts {
            codex_home: PathBuf::new(),
            codex_bin: None,
            env: None,
            timeout: Duration::from_millis(LOGIN_TTL_MS),
            start_timeout: Duration::from_millis(30_000),
            poll: Duration::from_millis(1000),
        }
    }
}

/// What the start and the watcher work with.
struct Run {
    home: PathBuf,
    codex_bin: Option<PathBuf>,
    env: Env,
    timeout: Duration,
    start_timeout: Duration,
    poll: Duration,
}

fn to_login_error(err: CodexCliError) -> DeviceLoginError {
    let code = match err.code {
        CodexCliCode::CodexMissing => LoginCode::CodexMissing,
        CodexCliCode::SpawnFailed => LoginCode::SpawnFailed,
    };
    DeviceLoginError::new(code, err.message)
}

/// How a start that nobody could wait for any more is reported (the server is shutting down).
fn start_lost() -> DeviceLoginError {
    DeviceLoginError::new(LoginCode::Failed, format!("{}.", messages::FAILED))
}

async fn wait_started(mut started: watch::Receiver<Started>) -> Result<DeviceLogin, DeviceLoginError> {
    match started.wait_for(Option::is_some).await {
        Ok(result) => result.clone().unwrap_or_else(|| Err(start_lost())),
        Err(_) => Err(start_lost()),
    }
}

/// Start a ChatGPT sign-in for this Codex home. Returns once codex has shown the link and code:
/// `{url, code, expires_at (ms since 1970), done, cancel}`. Fails with a [`DeviceLoginError`] when it can't get that
/// far (device-code sign-in switched off, no connection, an unsafe config.toml, codex missing...).
///
/// opts: `codex_home` (required), `env` (the server's environment; credentials are stripped from it), `codex_bin`
/// (else TARSEE_CODEX_PATH, else `codex` on the PATH), `timeout` (default and maximum: what the CLI says, 15
/// minutes), `start_timeout` (how long codex may take to show the code; 30 s), `poll` (how often auth.json is
/// checked; 1 s).
pub async fn start_device_login(app: &App, opts: &DeviceLoginOpts) -> Result<DeviceLogin, StartLoginError> {
    let home = require_codex_home(&opts.codex_home)?;
    let logins = DeviceLogins::of(app);
    let started = {
        let mut by_home = logins.by_home.lock();
        let current = by_home.get(&home).map(|session| {
            let status = session.state.lock().status;
            (status, session.handle.lock().clone(), session.started.clone())
        });
        match current {
            Some((LoginState::Waiting, Some(handle), _)) => return Ok(handle),
            Some((LoginState::Starting, _, started)) => started,
            _ => {
                let (tx, started) = watch::channel(None);
                let session = Arc::new(Session {
                    state: Mutex::new(DeviceLoginSnapshot {
                        status: LoginState::Starting,
                        started_at: js::now_ms(),
                        url: None,
                        code: None,
                        expires_at: None,
                        finished_at: None,
                        error_code: None,
                        error: None,
                        email: None,
                        plan: None,
                    }),
                    handle: Mutex::new(None),
                    stop: CancellationToken::new(),
                    started: started.clone(),
                });
                by_home.insert(home.clone(), session.clone());
                let run = Run {
                    home,
                    codex_bin: opts.codex_bin.clone(),
                    env: opts.env.clone().unwrap_or_else(|| app.env().clone()),
                    timeout: opts.timeout,
                    start_timeout: opts.start_timeout,
                    poll: opts.poll,
                };
                // A task of its own, as the JS call went on by itself: the login starts (and a failed start is
                // written down) whether or not the caller is still waiting.
                tokio::spawn(async move {
                    let result = begin(&session, run).await;
                    if let Err(err) = &result {
                        let mut state = session.state.lock();
                        state.status = if err.code == LoginCode::Cancelled {
                            LoginState::Cancelled
                        } else {
                            LoginState::Failed
                        };
                        state.error_code = Some(err.code);
                        state.error = Some(err.message.clone());
                        state.finished_at = Some(js::now_ms());
                    }
                    let _ = tx.send(Some(result));
                });
                started
            }
        }
    };
    Ok(wait_started(started).await?)
}

/// What codex has printed, gathered as it arrives.
struct Output {
    chunks: mpsc::UnboundedReceiver<(bool, Vec<u8>)>,
    out: Vec<u8>,
    err: Vec<u8>,
    /// Both streams have ended.
    ended: bool,
}

/// The most of each stream that is kept.
const MAX_OUTPUT: usize = 64 * 1024;

impl Output {
    fn of(child: &mut Child) -> Output {
        let (tx, chunks) = mpsc::unbounded_channel();
        fn forward<R>(stream: Option<R>, is_stderr: bool, tx: mpsc::UnboundedSender<(bool, Vec<u8>)>)
        where
            R: AsyncRead + Unpin + Send + 'static,
        {
            let Some(mut stream) = stream else { return };
            tokio::spawn(async move {
                let mut chunk = vec![0u8; 16 * 1024];
                loop {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send((is_stderr, chunk[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
        forward(child.stdout.take(), false, tx.clone());
        forward(child.stderr.take(), true, tx);
        Output {
            chunks,
            out: Vec::new(),
            err: Vec::new(),
            ended: false,
        }
    }

    /// Waits for more output and keeps it. False once both streams have ended.
    async fn read(&mut self) -> bool {
        match self.chunks.recv().await {
            Some((is_stderr, bytes)) => {
                let kept = if is_stderr { &mut self.err } else { &mut self.out };
                if kept.len() < MAX_OUTPUT {
                    kept.extend_from_slice(&bytes);
                }
                true
            }
            None => {
                self.ended = true;
                false
            }
        }
    }

    fn out_text(&self) -> String {
        String::from_utf8_lossy(&self.out).into_owned()
    }

    fn err_text(&self) -> String {
        String::from_utf8_lossy(&self.err).into_owned()
    }
}

fn unexpected_output() -> DeviceLoginError {
    DeviceLoginError::new(LoginCode::UnexpectedOutput, messages::UNEXPECTED_OUTPUT)
}

/// Starts codex and waits for the link and the code; then hands the login to [`watch_login`].
async fn begin(session: &Arc<Session>, run: Run) -> Result<DeviceLogin, DeviceLoginError> {
    let bin = resolve_codex_bin(run.codex_bin.as_deref(), &run.env).map_err(to_login_error)?;
    ensure_home(&run.home).map_err(|err| {
        let why = node_error_code(&err).map_or_else(|| err.to_string(), str::to_string);
        DeviceLoginError::new(
            LoginCode::HomeFailed,
            format!("Tarsee couldn't create the folder that keeps the ChatGPT sign-in ({why})."),
        )
    })?;
    let guard = codex_config_guard(&codex_config_files_for(&run.home, Some(&run.home)), None);
    if !guard.ok {
        return Err(DeviceLoginError::new(
            LoginCode::UnsafeConfig,
            guard.message.unwrap_or_default(),
        ));
    }
    let before = auth_fingerprint(&run.home);

    let mut args: Vec<&str> = CODEX_BASE_ARGS.to_vec();
    args.extend(["login", "--device-auth"]);
    let spawned = spawn_codex(
        &bin,
        &args,
        &SpawnOpts {
            env: codex_child_env(&run.env, &run.home, &EnvMap::new()),
            cwd: Some(run.home.clone()),
        },
    );
    let mut child = spawned.map_err(|err| {
        let why = spawn_error_code(&bin, &err).map_or_else(|| err.to_string(), str::to_string);
        DeviceLoginError::new(LoginCode::SpawnFailed, format!("Codex couldn't start ({why})."))
    })?;
    drop(child.stdin.take());
    let mut output = Output::of(&mut child);

    // 1. Wait for the link and the code.
    let start_timer = tokio::time::sleep(run.start_timeout);
    tokio::pin!(start_timer);
    let failure = loop {
        tokio::select! {
            biased;
            _ = session.stop.cancelled() => {
                break DeviceLoginError::new(LoginCode::Cancelled, messages::CANCELLED);
            }
            _ = &mut start_timer => {
                let (out, err) = (output.out_text(), output.err_text());
                if read_prompt(&format!("{out}\n{err}")).foreign_url {
                    break unexpected_output();
                }
                let said = strip_ansi(&err)
                    .split('\n')
                    .map(js::trim)
                    .any(|line| !line.is_empty() && !WARNING_RE.is_match(line));
                if said {
                    let c = classify_login_error(&err);
                    break DeviceLoginError::new(c.code, c.error);
                }
                break DeviceLoginError::new(LoginCode::NoCode, messages::NO_CODE);
            }
            more = output.read(), if !output.ended => {
                if !more {
                    continue;
                }
                let (out, err) = (output.out_text(), output.err_text());
                let mut p = read_prompt(&out);
                if p.url.is_none() || p.code.is_none() {
                    p = read_prompt(&format!("{out}\n{err}"));
                }
                if let (Some(url), Some(code)) = (p.url, p.code.clone()) {
                    return Ok(waiting(session, child, output, before, bin, run, url, code, p.expires_in_ms));
                }
                if p.foreign_url && p.code.is_some() {
                    break unexpected_output();
                }
            }
            // Closed: the program has gone and both of its streams have ended.
            _ = child.wait(), if output.ended => {
                let (out, err) = (output.out_text(), output.err_text());
                let p = read_prompt(&format!("{out}\n\n{err}\n"));
                if p.foreign_url && p.code.is_some() {
                    return Err(unexpected_output());
                }
                let c = classify_login_error(&format!("{err}\n{out}"));
                return Err(DeviceLoginError::new(c.code, c.error));
            }
        }
    };
    kill_tree(&mut child, KILL_GRACE).await;
    Err(failure)
}

/// 2. The link and the code are in: the login waits for the person to sign in, watched by a task of its own.
#[allow(clippy::too_many_arguments)]
fn waiting(
    session: &Arc<Session>,
    child: Child,
    output: Output,
    before: Option<String>,
    bin: PathBuf,
    run: Run,
    url: String,
    code: String,
    expires_in_ms: u64,
) -> DeviceLogin {
    let limit = u64::try_from(run.timeout.as_millis())
        .unwrap_or(u64::MAX)
        .min(expires_in_ms);
    let (done_tx, done) = watch::channel(None);
    let handle = {
        let mut state = session.state.lock();
        let expires_at = state
            .started_at
            .saturating_add(i64::try_from(limit).unwrap_or(i64::MAX));
        state.status = LoginState::Waiting;
        state.url = Some(url.clone());
        state.code = Some(code.clone());
        state.expires_at = Some(expires_at);
        DeviceLogin {
            url,
            code,
            expires_at,
            stop: session.stop.clone(),
            done,
            identity: Arc::new(()),
        }
    };
    *session.handle.lock() = Some(handle.clone());
    tokio::spawn(watch_login(
        session.clone(),
        child,
        output,
        before,
        bin,
        run,
        handle.expires_at,
        done_tx,
    ));
    handle
}

/// The check that is running: `codex login status` in the home, and whether it is the last one (codex has exited).
type Verify = Option<(JoinHandle<Option<LoginStatus>>, bool)>;

/// Waits for the running check, or for ever when there is none.
async fn verified(verify: &mut Verify) -> Option<LoginStatus> {
    match verify {
        Some((check, _)) => check.await.ok().flatten(),
        None => std::future::pending().await,
    }
}

/// Watches a login until it ends: the sign-in file appearing, codex exiting, the time running out, a cancel.
#[allow(clippy::too_many_arguments)]
async fn watch_login(
    session: Arc<Session>,
    mut child: Child,
    mut output: Output,
    before: Option<String>,
    bin: PathBuf,
    run: Run,
    expires_at: i64,
    done: watch::Sender<Option<LoginResult>>,
) {
    let left = u64::try_from(expires_at.saturating_sub(js::now_ms())).unwrap_or(0);
    let deadline = tokio::time::sleep(Duration::from_millis(left));
    tokio::pin!(deadline);
    let period = run.poll.max(Duration::from_millis(1));
    let mut poll = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // auth.json counts only once it is new (not the sign-in that was there before) and codex confirms it.
    let check = || -> JoinHandle<Option<LoginStatus>> {
        let opts = LoginStatusOpts {
            codex_home: run.home.clone(),
            codex_bin: Some(bin.clone()),
            ..LoginStatusOpts::default()
        };
        let env = run.env.clone();
        // A task of its own: a check that is no longer wanted still runs to its end (or its own time limit), so the
        // codex it started is never left behind.
        tokio::spawn(async move { login_status_in(&env, &opts).await.ok() })
    };
    let mut verify: Verify = None;
    let mut tried = before.clone();
    // How codex exited, once it has; and whether its exit has been looked at.
    let mut exit: Option<Option<i32>> = None;
    let mut closed = false;
    let mut last_check_due = false;

    let (result, status) = loop {
        // Closed: the program has gone and both of its streams have ended.
        if !closed
            && output.ended
            && let Some(code) = exit
        {
            closed = true;
            if code == Some(0) {
                last_check_due = true;
            } else {
                let c = classify_login_error(&format!("{}\n{}", output.err_text(), output.out_text()));
                let status = if c.code == LoginCode::Timeout {
                    LoginState::Expired
                } else {
                    LoginState::Failed
                };
                break (LoginResult::failed(c.code, c.error), status);
            }
        }
        if last_check_due && verify.is_none() {
            last_check_due = false;
            verify = Some((check(), true));
        }
        tokio::select! {
            biased;
            _ = session.stop.cancelled() => {
                break (LoginResult::failed(LoginCode::Cancelled, messages::CANCELLED), LoginState::Cancelled);
            }
            _ = &mut deadline => {
                break (LoginResult::failed(LoginCode::Timeout, messages::TIMEOUT), LoginState::Expired);
            }
            _ = output.read(), if !output.ended => {}
            status = child.wait(), if exit.is_none() => {
                exit = Some(status.ok().and_then(|s| s.code()));
            }
            st = verified(&mut verify) => {
                let last = verify.take().is_some_and(|(_, last)| last);
                if let Some(st) = st
                    && st.signed_in
                    && st.method == Some(LoginMethod::Chatgpt)
                    && auth_fingerprint(&run.home) != before
                {
                    break (LoginResult::signed_in(st.email, st.plan), LoginState::SignedIn);
                }
                if last {
                    break (
                        LoginResult::failed(LoginCode::NotConfirmed, messages::NOT_CONFIRMED),
                        LoginState::Failed,
                    );
                }
            }
            _ = poll.tick(), if verify.is_none() && !closed => {
                if let Some(now) = auth_fingerprint(&run.home)
                    && tried.as_ref() != Some(&now)
                {
                    tried = Some(now);
                    verify = Some((check(), false));
                }
            }
        }
    };

    {
        let mut state = session.state.lock();
        state.status = status;
        state.finished_at = Some(js::now_ms());
        if result.ok {
            if result.email.is_some() {
                state.email = result.email.clone();
            }
            if result.plan.is_some() {
                state.plan = result.plan.clone();
            }
        } else {
            state.error_code = result.code;
            state.error = result.error.clone();
        }
    }
    if result.ok {
        // codex exits on its own once it has saved the sign-in
        let _ = tokio::time::timeout(Duration::from_millis(1000), child.wait()).await;
    }
    kill_tree(&mut child, KILL_GRACE).await;
    let _ = done.send(Some(result));
}

/// Where this home's login is, for a page that polls: `{status, url, code, expiresAt, startedAt, finishedAt?,
/// errorCode?, error?, email?, plan?}`, or `None` when none has run since the server started. status is starting,
/// waiting, signed-in, failed, cancelled or expired.
pub fn get_device_login(app: &App, codex_home: &Path) -> Result<Option<DeviceLoginSnapshot>, TypeError> {
    let home = require_codex_home(codex_home)?;
    Ok(DeviceLogins::of(app)
        .session(&home)
        .map(|session| session.state.lock().clone()))
}

/// Stop this home's login if one is starting or waiting (codex is killed). True when there was one.
pub async fn cancel_device_login(app: &App, codex_home: &Path) -> Result<bool, TypeError> {
    let home = require_codex_home(codex_home)?;
    let Some(session) = DeviceLogins::of(app).session(&home) else {
        return Ok(false);
    };
    let status = session.state.lock().status;
    match status {
        LoginState::Waiting => {
            let handle = session.handle.lock().clone();
            if let Some(handle) = handle {
                handle.cancel().await;
            }
            Ok(true)
        }
        LoginState::Starting => {
            session.stop.cancel();
            // (A start that had its code in hand the moment it was stopped is stopped as a waiting one.)
            if let Ok(handle) = wait_started(session.started.clone()).await {
                handle.done().await;
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Which home to sign out, and with which codex.
#[derive(Debug, Clone, Default)]
pub struct LogoutOpts {
    /// The Codex home to sign out (required).
    pub codex_home: PathBuf,
    pub codex_bin: Option<PathBuf>,
    /// The server's environment; default the app's.
    pub env: Option<Env>,
}

/// How a sign-out went: `{ok}` or `{ok:false, error}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogoutResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Sign this Codex home out: stops a login in progress, runs `codex logout` (skipped when the home's config.toml
/// fails the guard, since logging out may contact the sign-in server), then makes sure auth.json is gone. Gives
/// `{ok}` or `{ok:false, error}`.
pub async fn logout(app: &App, opts: &LogoutOpts) -> Result<LogoutResult, TypeError> {
    let home = require_codex_home(&opts.codex_home)?;
    cancel_device_login(app, &home).await?;
    let done = LogoutResult { ok: true, error: None };
    if !home.exists() {
        return Ok(done);
    }
    let env = opts.env.clone().unwrap_or_else(|| app.env().clone());
    let guard = codex_config_guard(&codex_config_files_for(&home, Some(&home)), None);
    if let Ok(bin) = resolve_codex_bin(opts.codex_bin.as_deref(), &env)
        && guard.ok
    {
        let mut args: Vec<&str> = CODEX_BASE_ARGS.to_vec();
        args.push("logout");
        let _ = run_codex(
            &bin,
            &args,
            &RunCodexOpts {
                env: codex_child_env(&env, &home, &EnvMap::new()),
                cwd: Some(home.clone()),
                timeout: Duration::from_millis(20_000),
                ..RunCodexOpts::default()
            },
        )
        .await;
    }
    let auth = home.join("auth.json");
    let removed = if auth.is_dir() {
        // (Node's rm refuses a folder without `recursive`, by this name.)
        Err("ERR_FS_EISDIR".to_string())
    } else {
        match std::fs::remove_file(&auth) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(node_error_code(&err).map_or_else(|| err.to_string(), str::to_string)),
        }
    };
    Ok(match removed {
        Ok(()) => done,
        Err(why) => LogoutResult {
            ok: false,
            error: Some(format!("Couldn't remove the saved ChatGPT sign-in ({why}).")),
        },
    })
}

#[cfg(test)]
mod tests;
