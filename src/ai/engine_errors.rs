//! Port of `src/ai/engine-errors.js`: what an engine's failure means, per provider, in words the owner can act on
//! (design 4.7 "Errors").
//!
//! An engine reports a failure as an HTTP status, an error code (Claude Code's assistant `error`, a Codex error
//! code, or one of Tarsee's own refusal codes from `engine_env`) and/or the engine's own words. The same 401 means
//! "Claude's sign-in ran out" on the Claude plan and "your DeepSeek key was rejected" on DeepSeek, so the meaning
//! depends on the provider. [`classify_engine_error`] answers:
//!
//! ```text
//!   { kind, provider, engine, status, code, recoverable, state, message }
//!
//!   kind        one of ERROR_KINDS:
//!                 expired      a plan's sign-in ran out (Claude plan, ChatGPT plan)
//!                 auth         a key was turned down (401, or a 403 that isn't one of the two below)
//!                 wrong-key    a key pasted in another provider's slot
//!                 billing      out of credit or over a spending limit (402, or OpenRouter's 403 for a key over its limit)
//!                 rate         busy, or a plan's usage limit (429)
//!                 unavailable  the provider is down or overloaded (5xx, 529)
//!                 model        the model doesn't exist there, or the account can't use it (404, 400 about a model)
//!                 context      the chat no longer fits in the model's context (llama-server's exceed_context_size_error,
//!                              "request (N tokens) exceeds the available context size", LM Studio's and Codex's own
//!                              words): never read as a "model" failure, whatever else the words name
//!                 session      resuming the stored session failed (start fresh and carry the chat over)
//!                 moderated    the provider's moderation turned the message down (OpenRouter's 403 "requires
//!                              moderation ... flagged for ..."): the key is fine, no flag, no retry, no backup
//!                 credential-isolation, needs-key, needs-setup, bad-model, wrong-engine, needs-mcp-token
//!                              Tarsee's own refusals before a turn starts (engine_env's CredentialError codes)
//!                 unknown      anything else
//!   recoverable true only for a failed session resume: the turn layer retries once with a fresh session
//!   state       the provider's failure flag to write (ai.<id>.status, provider_status), or null for none
//!   message     the plain-language explanation for the chat
//! ```
//!
//! Pure: no I/O. The words come from the provider registry (labels, error hints, top-up links).

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use super::provider_registry::{Engine, Provider, get_provider, normalize_provider_id};
use crate::util::js;

/// What kind of failure it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    Expired,
    Auth,
    WrongKey,
    Billing,
    Rate,
    Unavailable,
    Model,
    Context,
    Session,
    Moderated,
    CredentialIsolation,
    NeedsKey,
    NeedsSetup,
    BadModel,
    WrongEngine,
    NeedsMcpToken,
    Unknown,
}

impl ErrorKind {
    /// The kind's name, as the JS had it ("wrong-key", "needs-mcp-token").
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Expired => "expired",
            ErrorKind::Auth => "auth",
            ErrorKind::WrongKey => "wrong-key",
            ErrorKind::Billing => "billing",
            ErrorKind::Rate => "rate",
            ErrorKind::Unavailable => "unavailable",
            ErrorKind::Model => "model",
            ErrorKind::Context => "context",
            ErrorKind::Session => "session",
            ErrorKind::Moderated => "moderated",
            ErrorKind::CredentialIsolation => "credential-isolation",
            ErrorKind::NeedsKey => "needs-key",
            ErrorKind::NeedsSetup => "needs-setup",
            ErrorKind::BadModel => "bad-model",
            ErrorKind::WrongEngine => "wrong-engine",
            ErrorKind::NeedsMcpToken => "needs-mcp-token",
            ErrorKind::Unknown => "unknown",
        }
    }

    /// The kind with this name, or `None`.
    pub fn from_name(name: &str) -> Option<ErrorKind> {
        ERROR_KINDS.iter().copied().find(|kind| kind.as_str() == name)
    }

    /// Tarsee's own refusal codes (`engine_env`'s CredentialError), passed through as their own kind.
    fn is_refusal(self) -> bool {
        matches!(
            self,
            ErrorKind::CredentialIsolation
                | ErrorKind::NeedsKey
                | ErrorKind::NeedsSetup
                | ErrorKind::BadModel
                | ErrorKind::WrongEngine
                | ErrorKind::NeedsMcpToken
        )
    }
}

impl std::fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub const ERROR_KINDS: &[ErrorKind] = &[
    ErrorKind::Expired,
    ErrorKind::Auth,
    ErrorKind::WrongKey,
    ErrorKind::Billing,
    ErrorKind::Rate,
    ErrorKind::Unavailable,
    ErrorKind::Model,
    ErrorKind::Context,
    ErrorKind::Session,
    ErrorKind::Moderated,
    ErrorKind::CredentialIsolation,
    ErrorKind::NeedsKey,
    ErrorKind::NeedsSetup,
    ErrorKind::BadModel,
    ErrorKind::WrongEngine,
    ErrorKind::NeedsMcpToken,
    ErrorKind::Unknown,
];

/// The Claude plan's sign-in ran out: what to do instead. (Also re-exported by `providers/claude_code.rs`.)
pub const AUTH_EXPIRED_MESSAGE: &str = concat!(
    "**Claude's sign-in has expired**, so I can't reach the model right now. This isn't a network problem, and retrying won't fix it.\n\n",
    "Open the Terminal in the Tarsee dashboard (the `>_` button at the top), run `claude auth login` and follow the link it prints. Then send your message again."
);

const CHATGPT_EXPIRED_MESSAGE: &str = concat!(
    "**The ChatGPT sign-in has expired**, so I can't reach the model right now. Retrying won't fix it.\n\n",
    "Sign in again in Settings > AI (it shows a link and a one-time code), or run `codex login --device-auth` in the Terminal. Then send your message again."
);

/// JavaScript's `\s`, as a character class.
const S: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
/// JavaScript's `.`: anything but a line end.
const ANY: &str = r"[^\n\r\u{2028}\u{2029}]";

/// A pattern of plain words with JavaScript's `i` flag: letters match in either case, and only ASCII ones
/// (`(?i-u:...)`; the regex crate's own `(?i)` would also take the long s, U+017F, for "s" and the Kelvin sign
/// for "k").
fn words(alternatives: &str) -> String {
    format!("(?i-u:{alternatives})")
}

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("an engine error pattern")
}

/// The Claude CLI's and API's words for a sign-in or key that failed.
static AUTH_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&words(
        r"Failed to authenticate|OAuth (?:access )?token (?:has )?expired|Re-authenticate to continue|Not logged in|Please run /login|invalid (?:x-)?api[- ]?key|authentication[_ ]error|unauthori[sz]ed|invalid bearer|no auth credentials",
    ))
});
// codex 0.167 says "Your access token could not be refreshed ..." or "Your authentication session could not be
// refreshed ..." for every ChatGPT sign-in it can't renew (expired, reused, revoked or replaced refresh token).
static EXPIRED_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&words(
        r"OAuth (?:access )?token (?:has )?expired|Re-authenticate to continue|refresh token (?:was )?(?:revoked|expired|invalid)|(?:access token|authentication session) could not be refreshed|sign-?in (?:has )?expired|token_expired",
    ))
});
static BILLING_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&words(
        r"insufficient (?:balance|credits?|funds|quota)|credit balance is too low|out of credits?|payment required|billing|spend(?:ing)? limit|key limit|budget limit|exceeded your current quota",
    ))
});
static RATE_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&words(
        r"rate[_ ]?limit|too many requests|request rejected \(429\)|usage limit|slow down",
    ))
});
static UNAVAILABLE_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&words(
        r"overloaded|service unavailable|bad gateway|gateway timeout|internal server error|server_error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|couldn't connect|could not reach",
    ))
});
static MODEL_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        "{}|{}{ANY}*{}",
        words(
            r"issue with the selected model|model[_ ]not[_ ]found|not a valid model|invalid model|unknown model|no such model|does not exist or you do not have access"
        ),
        words("model "),
        words("does not exist|not found|not available|unavailable"),
    ))
});
/// A chat that no longer fits in the model's context: llama-server's 400s (exceed_context_size_error, "request (N
/// tokens) exceeds the available context size", "is larger than the max context size"), LM Studio's, a Responses
/// server's context_length_exceeded, and Codex's own words for one ("ran out of room in the model's context
/// window").
static CONTEXT_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&words(
        r"exceed_context_size_error|exceeds the available context size|is larger than the max context size|context_length_exceeded|greater than the context length|ran out of room in the model's context window",
    ))
});
static SESSION_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        "{}|{}{ANY}*{}",
        words(r"previous_message_id|must be the id from a prior|No conversation found with session ID"),
        words("session"),
        words("expired|invalid|not found|corrupt"),
    ))
});
static WORKSPACE_WORDS_RE: LazyLock<Regex> = LazyLock::new(|| pattern(&words("workspace")));
/// OpenRouter's 403 for a prompt its moderation flagged ("<model> requires moderation on <maker>. Your input was
/// flagged for ...").
static MODERATION_WORDS_RE: LazyLock<Regex> =
    LazyLock::new(|| pattern(&words("requires moderation|input was flagged")));
/// OpenRouter's 403 for a key over the limit set on it ("Key limit exceeded (total limit)", "Budget limit exceeded
/// (weekly limit)").
static KEY_LIMIT_WORDS_RE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i-u:\b(?:key|budget|spend(?:ing)?) limit\b)"));
static MODEL_WORD_RE: LazyLock<Regex> = LazyLock::new(|| pattern(&words("model")));
static FLAGGED_FOR_RE: LazyLock<Regex> = LazyLock::new(|| pattern(&format!("{}([^.\\n]+)", words("flagged for "))));

static API_ERROR_STATUS_RE: LazyLock<Regex> =
    LazyLock::new(|| pattern(&format!(r"{}{S}*([0-9]{{3}})(?-u:\b)", words("API Error:?"))));
static PARENTHESES_STATUS_RE: LazyLock<Regex> = LazyLock::new(|| pattern(r"\(([0-9]{3})\)"));
static NAMED_STATUS_RE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        r"(?-u:\b){}{S}*:?{S}*([0-9]{{3}})(?-u:\b)",
        words("status|HTTP")
    ))
});

const ANTHROPIC_WORKSPACE_MESSAGE: &str = concat!(
    "**Your Anthropic key isn't in a workspace**, so Anthropic turns it down for Tarsee. ",
    "In the Claude Console, create a new key and choose a workspace for it (Default is fine), then paste it in Settings > AI (the Anthropic guide's step 3)."
);

/// The engine's assistant error codes (and Codex's), by what they mean.
fn kind_from_code(code: &str) -> Option<ErrorKind> {
    Some(match code {
        "authentication_failed"
        | "oauth_org_not_allowed"
        | "account_on_hold"
        | "verification_required"
        | "cloud_credential_error" => ErrorKind::Auth,
        "billing_error" | "insufficient_quota" => ErrorKind::Billing,
        "rate_limit" | "rate_limit_exceeded" | "usage_limit_reached" => ErrorKind::Rate,
        "overloaded" | "server_error" => ErrorKind::Unavailable,
        "model_not_found" => ErrorKind::Model,
        "bad-key" => ErrorKind::WrongKey,
        _ => return None,
    })
}

fn is_plan(id: &str) -> bool {
    id == "claude" || id == "chatgpt"
}

/// An HTTP status in the engine's words ("API Error: 402 ...", "Request rejected (429)"), or `None`.
pub fn status_from_message(message: &str) -> Option<u16> {
    let m = API_ERROR_STATUS_RE
        .captures(message)
        .or_else(|| PARENTHESES_STATUS_RE.captures(message))
        .or_else(|| NAMED_STATUS_RE.captures(message))?;
    let n: u16 = m[1].parse().ok()?;
    (400..=599).contains(&n).then_some(n)
}

fn kind_from_status(status: u16, message: &str) -> Option<ErrorKind> {
    match status {
        401 | 403 => Some(ErrorKind::Auth),
        402 => Some(ErrorKind::Billing),
        429 => Some(ErrorKind::Rate),
        500..=599 => Some(ErrorKind::Unavailable),
        404 => Some(ErrorKind::Model),
        400 if MODEL_WORDS_RE.is_match(message) || MODEL_WORD_RE.is_match(message) => Some(ErrorKind::Model),
        _ => None,
    }
}

fn kind_from_words(message: &str) -> Option<ErrorKind> {
    if message.is_empty() {
        return None;
    }
    [
        (&SESSION_WORDS_RE, ErrorKind::Session),
        (&EXPIRED_WORDS_RE, ErrorKind::Expired),
        (&BILLING_WORDS_RE, ErrorKind::Billing),
        (&MODEL_WORDS_RE, ErrorKind::Model),
        (&AUTH_WORDS_RE, ErrorKind::Auth),
        (&RATE_WORDS_RE, ErrorKind::Rate),
        (&UNAVAILABLE_WORDS_RE, ErrorKind::Unavailable),
    ]
    .into_iter()
    .find(|(re, _)| re.is_match(message))
    .map(|(_, kind)| kind)
}

/// The failure flag a kind sets on the provider (`provider_status`'s PROVIDER_STATES), or `None` for none.
pub fn failure_state_for(kind: ErrorKind) -> Option<&'static str> {
    match kind {
        ErrorKind::Expired => Some("sign-in-expired"),
        ErrorKind::Auth | ErrorKind::WrongKey => Some("error"),
        ErrorKind::Billing => Some("out-of-credit"),
        ErrorKind::NeedsKey => Some("needs-key"),
        ErrorKind::NeedsSetup => Some("needs-setup"),
        _ => None,
    }
}

/// The service's own name, for sentences ("Anthropic isn't answering", not the card's "Anthropic API key").
fn label_of(p: Option<&Provider>, id: &str) -> String {
    let service = match id {
        "claude" => Some("Claude"),
        "anthropic" => Some("Anthropic"),
        "chatgpt" => Some("ChatGPT"),
        "openai" => Some("OpenAI"),
        _ => None,
    };
    service
        .or(p.map(|p| p.label))
        .or((!id.is_empty()).then_some(id))
        .unwrap_or("This AI")
        .to_string()
}

/// The provider's public id, or what was given when the registry does not know it.
fn id_of(provider_id: &str) -> String {
    normalize_provider_id(provider_id).map_or_else(|| provider_id.to_string(), String::from)
}

/// The provider's own fix for a sign-in or key that failed.
pub fn auth_message(provider_id: &str) -> String {
    let id = id_of(provider_id);
    if id == "claude" {
        return AUTH_EXPIRED_MESSAGE.to_string();
    }
    if id == "chatgpt" {
        return CHATGPT_EXPIRED_MESSAGE.to_string();
    }
    let p = get_provider(&id);
    if let Some(hint) = p.and_then(|p| p.error_hints.auth).filter(|h| !h.is_empty()) {
        // The hint's first sentence in bold: "**Your DeepSeek key was rejected.** Update it in ..."
        return match hint.find(". ") {
            Some(cut) if cut > 0 => format!("**{}** {}", &hint[..=cut], &hint[cut + 2..]),
            _ => format!("**{hint}**"),
        };
    }
    format!(
        "**{} turned down the key.** Check it in Settings > AI.",
        label_of(p, &id)
    )
}

/// A Local AI server with no Responses API, the one Tarsee talks to it through (Ollama before 0.13.3, LM Studio
/// before 0.3.29, llama.cpp's llama-server before b7793, a chat-completions-only server): what to do. It names
/// b11768 for llama.cpp, the first build whose tool calls Tarsee can rely on. `local_url` is the address the owner
/// set (…/v1).
pub fn local_no_responses_message(local_url: Option<&str>) -> String {
    let place = js::trim(local_url.unwrap_or("")).trim_end_matches('/');
    let (at, address) = if place.is_empty() {
        (String::new(), "its /responses address".to_string())
    } else {
        (format!(" at {place}"), format!("{place}/responses"))
    };
    format!(
        "**Your Local AI{at} has no Responses API**: {address} answered \"not found\". Tarsee talks to Local AI through that API. Update Ollama to 0.13.3 or newer, LM Studio to 0.3.29 or newer or llama.cpp to b11768 or newer, or use a server that has it."
    )
}

/// The provider's own words for being out of credit, with its top-up link.
fn billing_message(p: Option<&Provider>, id: &str) -> String {
    if id == "claude" {
        return "**The Claude plan's usage limit is reached** for now. It resets on its own; you can check it at claude.ai/settings/usage, or switch to another AI in Settings > AI meanwhile.".to_string();
    }
    if id == "chatgpt" {
        return "**The ChatGPT plan's usage limit is reached** for now. It resets on its own; you can check it at chatgpt.com/codex/settings/usage, or switch to another AI in Settings > AI meanwhile.".to_string();
    }
    let label = label_of(p, id);
    let hints = p.map(|p| p.error_hints).unwrap_or_default();
    let base = hints
        .billing
        .filter(|b| !b.is_empty())
        .map_or_else(|| format!("{label} says the account is out of credit."), String::from);
    let link = match hints.top_up_url.filter(|url| !url.is_empty()) {
        Some(url) if !base.contains(url) => format!(" ({url})"),
        _ => String::new(),
    };
    format!("**{label} is out of credit.** {base}{link}")
}

/// The words for a kind of failure on a provider. `detail` is the engine's own words (shown for unknown failures and
/// Tarsee's refusals), `model` the model that failed.
pub fn friendly(provider_id: &str, kind: ErrorKind, detail: Option<&str>, model: Option<&str>) -> String {
    let id = id_of(provider_id);
    let p = get_provider(&id);
    let label = label_of(p, &id);
    let words = js::trim(detail.unwrap_or(""));
    let model = model.filter(|m| !m.is_empty());
    match kind {
        ErrorKind::Expired | ErrorKind::Auth => auth_message(&id),
        ErrorKind::WrongKey => {
            let what = if words.is_empty() {
                format!(
                    "It isn't {}.",
                    p.and_then(|p| p.key_noun).unwrap_or("a key for this AI")
                )
            } else {
                words.to_string()
            };
            format!("**That key belongs somewhere else.** {what} Paste the right key in Settings > AI.")
        }
        ErrorKind::Billing => billing_message(p, &id),
        ErrorKind::Rate if is_plan(&id) => billing_message(p, &id),
        ErrorKind::Rate => {
            format!("**{label} is busy right now** (too many requests). Wait a minute and send your message again.")
        }
        ErrorKind::Unavailable => format!(
            "**{label} isn't answering right now** (the service is down or overloaded). This usually clears up on its own: try again in a few minutes, or switch to another AI in Settings > AI."
        ),
        ErrorKind::Model => format!(
            "**{label} can't run {}**: it doesn't exist there, or this account can't use it. Pick another model in the chat's model menu or in Settings > AI.",
            model.map_or_else(|| "the chosen model".to_string(), |m| format!("the model {m}"))
        ),
        ErrorKind::Context if id == "local" => "**This chat no longer fits in your Local AI's memory** (its context is full). Start a new chat, or give the model more room: start llama-server with a larger -c, load the model in LM Studio with a longer context length, or raise Ollama's OLLAMA_CONTEXT_LENGTH.".to_string(),
        ErrorKind::Context => format!(
            "**This chat no longer fits in {}'s context window.** Start a new chat, or pick a model with a bigger one.",
            model.unwrap_or(&label)
        ),
        ErrorKind::Session => {
            "**The earlier conversation couldn't be picked up again**, so I'm starting a fresh one.".to_string()
        }
        ErrorKind::Moderated => {
            let reason = FLAGGED_FOR_RE
                .captures(words)
                .map(|why| js::utf16_truncate(js::trim(&why[1].replace(['\\', '"'], "")), 80))
                .unwrap_or_default();
            let flagged = if reason.is_empty() {
                String::new()
            } else {
                format!(" (flagged for {reason})")
            };
            format!(
                "**{label}'s moderation turned this message down**{flagged}. Nothing is wrong with the key. Rephrase the message, or pick a model {label} doesn't moderate (another maker's) in the chat's model menu."
            )
        }
        ErrorKind::CredentialIsolation
        | ErrorKind::NeedsKey
        | ErrorKind::NeedsSetup
        | ErrorKind::BadModel
        | ErrorKind::WrongEngine
        | ErrorKind::NeedsMcpToken => {
            if words.is_empty() {
                format!("**{label} can't start this turn.** Check it in Settings > AI.")
            } else {
                words.to_string()
            }
        }
        ErrorKind::Unknown => {
            if words.is_empty() {
                format!("**{label} ran into a problem** it didn't explain. Try again, or check the server logs.")
            } else {
                format!("**{label} ran into a problem:** {words}")
            }
        }
    }
}

/// What an engine reported: `{ status, code, message, model }`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EngineFailure<'a> {
    /// The HTTP status, when the engine gave one (below 400 counts as none).
    pub status: Option<u16>,
    /// The engine's error code, or one of Tarsee's own refusal codes.
    pub code: Option<&'a str>,
    /// The engine's own words.
    pub message: Option<&'a str>,
    /// The model that failed.
    pub model: Option<&'a str>,
}

/// What an engine failure means on a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineErrorInfo {
    pub kind: ErrorKind,
    /// The provider's public id, or the id as given when the registry does not know it.
    pub provider: String,
    pub engine: Option<Engine>,
    /// The HTTP status, given or read from the words.
    pub status: Option<u16>,
    pub code: Option<String>,
    /// True only for a failed session resume: the turn layer retries once with a fresh session.
    pub recoverable: bool,
    /// The provider's failure flag to write, or `None` for none.
    pub state: Option<&'static str>,
    /// The plain-language explanation for the chat.
    pub message: String,
}

/// What an engine failure means on a provider. input: `{status, code, message, model}`. The first clear signal
/// wins, in this order: Tarsee's refusal codes, a moderation refusal, a failed session resume, an expired plan
/// sign-in in the words, the HTTP status (given or read from the words), the engine's error code, the words.
pub fn classify_engine_error(provider_id: &str, engine: Option<Engine>, input: EngineFailure<'_>) -> EngineErrorInfo {
    let id = id_of(provider_id);
    let text = input.message.unwrap_or("");
    let st = input
        .status
        .filter(|status| *status >= 400)
        .or_else(|| status_from_message(text));
    let c = input.code.filter(|code| !code.is_empty());

    let refusal = c.and_then(ErrorKind::from_name).filter(|kind| kind.is_refusal());
    let mut kind = if refusal.is_some() {
        refusal
    } else if CONTEXT_WORDS_RE.is_match(text) {
        // Before the status: llama-server's 400 for a full context is no "model" failure, whatever else its words
        // name.
        Some(ErrorKind::Context)
    } else if st == Some(403) && MODERATION_WORDS_RE.is_match(text) {
        // A 403 is not always the key: OpenRouter answers 403 for a prompt its moderation flagged. Its body quotes
        // the person's own words (metadata.flagged_input), so this comes before anything else reads them.
        Some(ErrorKind::Moderated)
    } else if SESSION_WORDS_RE.is_match(text) {
        Some(ErrorKind::Session)
    } else if EXPIRED_WORDS_RE.is_match(text) {
        Some(ErrorKind::Expired)
    } else {
        None
    };
    if kind.is_none() {
        kind = c.and_then(kind_from_code);
    }
    if matches!(kind, None | Some(ErrorKind::Auth) | Some(ErrorKind::Rate)) {
        // A status is more exact than a broad code (the engine calls a 402 "unknown"), except for an auth code with
        // no status.
        if let Some(by_status) = st.and_then(|status| kind_from_status(status, text)) {
            kind = Some(by_status);
        }
    }
    let mut kind = kind.or_else(|| kind_from_words(text)).unwrap_or(ErrorKind::Unknown);
    // OpenRouter's 403 for a key over the limit set on it: raise the limit, the key itself is fine.
    if kind == ErrorKind::Auth && st == Some(403) && KEY_LIMIT_WORDS_RE.is_match(text) {
        kind = ErrorKind::Billing;
    }

    // On a plan, a turned-down sign-in is the sign-in running out; on a key provider an "expired" is its key
    // failing.
    if kind == ErrorKind::Auth && is_plan(&id) {
        kind = ErrorKind::Expired;
    }
    if kind == ErrorKind::Expired && !id.is_empty() && !is_plan(&id) && get_provider(&id).is_some() {
        kind = ErrorKind::Auth;
    }

    // An Anthropic key made outside a workspace needs a workspace header on every request, which Tarsee never
    // sends: the fix is a key made in a workspace (the guide's step 3), not a new copy of the same key.
    let no_workspace = id == "anthropic"
        && (matches!(st, Some(400 | 401 | 403)) || kind == ErrorKind::Auth)
        && WORKSPACE_WORDS_RE.is_match(text);
    if no_workspace {
        kind = ErrorKind::Auth;
    }

    let shows_detail =
        kind.is_refusal() || matches!(kind, ErrorKind::Unknown | ErrorKind::WrongKey | ErrorKind::Moderated);
    let message = if no_workspace {
        ANTHROPIC_WORKSPACE_MESSAGE.to_string()
    } else {
        friendly(&id, kind, shows_detail.then_some(text), input.model)
    };
    EngineErrorInfo {
        kind,
        engine,
        status: st,
        code: input.code.map(String::from),
        recoverable: kind == ErrorKind::Session,
        state: failure_state_for(kind),
        message,
        provider: id,
    }
}

#[cfg(test)]
mod tests {
    //! Port of `test/engine-errors.test.js`.
    //!
    //! engine-errors (design 4.7 "Errors"): what an engine's failure means, per provider, in words the owner can
    //! act on. The messages below are the ones the Claude Code CLI actually produced against a fake Messages API:
    //! a 401 is "Not logged in · Please run /login" with error "authentication_failed", a 402 is "API Error: 402
    //! Insufficient Balance", a 429 "API Error: Request rejected (429) · ...", an unknown model "There's an issue
    //! with the selected model (...)".
    use serde_json::json;

    use super::*;

    const CC: Option<Engine> = Some(Engine::ClaudeCode);
    const CX: Option<Engine> = Some(Engine::Codex);

    fn status(status: u16) -> EngineFailure<'static> {
        EngineFailure {
            status: Some(status),
            ..EngineFailure::default()
        }
    }

    fn code(code: &'static str) -> EngineFailure<'static> {
        EngineFailure {
            code: Some(code),
            ..EngineFailure::default()
        }
    }

    fn message(message: &str) -> EngineFailure<'_> {
        EngineFailure {
            message: Some(message),
            ..EngineFailure::default()
        }
    }

    fn status_message(status: u16, message: &str) -> EngineFailure<'_> {
        EngineFailure {
            status: Some(status),
            message: Some(message),
            ..EngineFailure::default()
        }
    }

    fn code_message<'a>(code: &'a str, message: &'a str) -> EngineFailure<'a> {
        EngineFailure {
            code: Some(code),
            message: Some(message),
            ..EngineFailure::default()
        }
    }

    // --- classifyEngineError: HTTP statuses ---

    #[test]
    fn a_401_on_a_key_provider_is_a_rejected_key_naming_that_provider_and_where_to_fix_it() {
        let e = classify_engine_error("deepseek", CC, status(401));
        assert_eq!(e.kind, ErrorKind::Auth);
        assert_eq!(e.state, Some("error"));
        assert!(!e.recoverable);
        assert!(e.message.contains("DeepSeek key was rejected"));
        assert!(e.message.contains("Settings > AI"));
        let lower = e.message.to_lowercase();
        assert!(
            !lower.contains("claude auth login") && !lower.contains("claude login"),
            "a gateway's 401 is not Claude's sign-in"
        );
    }

    #[test]
    fn a_401_on_the_claude_plan_is_the_sign_in_running_out() {
        let e = classify_engine_error("claude", CC, status(401));
        assert_eq!(e.kind, ErrorKind::Expired);
        assert_eq!(e.state, Some("sign-in-expired"));
        assert!(e.message.contains("claude auth login"));
    }

    #[test]
    fn the_clis_not_logged_in_authentication_failed_is_the_providers_own_auth_failure() {
        let words = "Not logged in · Please run /login";
        let gw = classify_engine_error("openrouter", CC, code_message("authentication_failed", words));
        assert_eq!(gw.kind, ErrorKind::Auth);
        assert!(gw.message.contains("OpenRouter key was rejected"));
        let plan = classify_engine_error("claude-code", CC, code_message("authentication_failed", words));
        assert_eq!(plan.kind, ErrorKind::Expired);
        assert_eq!(plan.provider, "claude");
    }

    #[test]
    fn a_403_is_an_auth_failure_too() {
        assert_eq!(
            classify_engine_error("anthropic", CC, status(403)).kind,
            ErrorKind::Auth
        );
    }

    /// OpenRouter's documented 403 for a prompt its moderation flagged: the body carries metadata.flagged_input,
    /// the person's own words, which must not be read as Tarsee's other signals (a "session expired" in them
    /// included).
    fn moderated(flagged: &str) -> String {
        json!({"error": {
            "code": 403,
            "message": "openai/gpt-5.5 requires moderation on OpenAI. Your input was flagged for \"violence\". No credits were charged.",
            "metadata": {"reasons": ["violence"], "flagged_input": flagged, "provider_name": "OpenAI", "model_slug": "openai/gpt-5.5"},
        }})
        .to_string()
    }

    #[test]
    fn openrouters_moderation_refusal_403_is_not_a_rejected_key_no_flag_no_retry_its_own_words() {
        let plain = moderated("a flagged sentence");
        let codex_words =
            format!("unexpected status 403 Forbidden: {plain}, url: https://openrouter.ai/api/v1/responses");
        let api_words = format!("API Error: 403 {plain}");
        let quoting = moderated("my session expired so now I will hurt them");
        let cases = [
            (CX, message(&codex_words)),
            (CC, message(&api_words)),
            (CC, code_message("authentication_failed", &api_words)),
            (CC, status_message(403, &quoting)),
        ];
        for (engine, input) in cases {
            let e = classify_engine_error("openrouter", engine, input);
            assert_eq!(e.kind, ErrorKind::Moderated, "{input:?}");
            assert_eq!(e.state, None, "the card isn't flagged: the key works");
            assert!(!e.recoverable, "the same prompt would be flagged again");
            assert!(!e.message.contains("key was rejected"));
            assert!(e.message.contains("OpenRouter's moderation turned this message down"));
            assert!(e.message.contains("flagged for violence"));
            assert!(e.message.contains("Nothing is wrong with the key"));
        }
        let permission = "API Error: 403 {\"type\":\"error\",\"error\":{\"type\":\"permission_error\",\"message\":\"Your API key does not have permission\"}}";
        assert_eq!(
            classify_engine_error("anthropic", CC, status_message(403, permission)).kind,
            ErrorKind::Auth,
            "any other 403 is still the key"
        );
        let invalid = "unexpected status 403 Forbidden: {\"error\":{\"message\":\"Invalid key\"}}";
        assert_eq!(
            classify_engine_error("openrouter", CX, message(invalid)).kind,
            ErrorKind::Auth
        );
    }

    #[test]
    fn openrouters_403_for_a_key_over_its_spending_limit_is_out_of_credit_not_a_rejected_key() {
        for words in [
            "Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys",
            "Budget limit exceeded (weekly limit).",
        ] {
            let text =
                format!("unexpected status 403 Forbidden: {{\"error\":{{\"code\":403,\"message\":\"{words}\"}}}}");
            let e = classify_engine_error("openrouter", CX, message(&text));
            assert_eq!(e.kind, ErrorKind::Billing, "{words}");
            assert_eq!(e.state, Some("out-of-credit"));
            assert!(e.message.contains("spending limit"));
        }
    }

    #[test]
    fn a_402_is_out_of_credit_with_the_providers_top_up_link() {
        let ds = classify_engine_error("deepseek", CC, message("API Error: 402 Insufficient Balance"));
        assert_eq!(ds.kind, ErrorKind::Billing);
        assert_eq!(ds.status, Some(402));
        assert_eq!(ds.state, Some("out-of-credit"));
        assert!(ds.message.contains("DeepSeek balance is empty"));
        assert!(ds.message.contains("platform.deepseek.com/top_up"));
        let or = classify_engine_error("openrouter", CC, status(402));
        assert!(or.message.contains("spending limit"));
        assert!(or.message.contains("openrouter.ai/settings/keys"));
        let an = classify_engine_error("anthropic", CC, code("billing_error"));
        assert_eq!(an.kind, ErrorKind::Billing);
        assert!(
            an.message.contains("platform.claude.com/settings/billing"),
            "the Claude Console's own address now"
        );
    }

    #[test]
    fn an_anthropic_key_made_outside_a_workspace_says_to_make_one_in_a_workspace_tarsee_sends_no_workspace_header() {
        let header = "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"anthropic-workspace-id header is required for this API key\"}}";
        for input in [
            status_message(400, header),
            status_message(401, "This key isn't scoped to a workspace"),
        ] {
            let r = classify_engine_error("anthropic", CC, input);
            assert_eq!(r.kind, ErrorKind::Auth, "{input:?}");
            assert_eq!(r.state, Some("error"));
            assert!(r.message.contains("workspace"));
            assert!(r.message.contains("Settings > AI"));
        }
        assert!(
            !classify_engine_error("anthropic", CC, status(401))
                .message
                .contains("workspace"),
            "a plain 401 is a rejected key"
        );
        assert!(
            !classify_engine_error("deepseek", CC, status_message(400, "workspace"))
                .message
                .contains("Anthropic")
        );
    }

    #[test]
    fn a_429_is_busy_on_a_plan_it_is_the_plans_usage_limit() {
        let gw = classify_engine_error(
            "deepseek",
            CC,
            code_message("rate_limit", "API Error: Request rejected (429) · slow down"),
        );
        assert_eq!(gw.kind, ErrorKind::Rate);
        assert_eq!(gw.status, Some(429));
        assert_eq!(gw.state, None, "busy is not a broken provider");
        assert!(gw.message.to_lowercase().contains("busy"));
        let plan = classify_engine_error("chatgpt", CX, status(429));
        assert_eq!(plan.kind, ErrorKind::Rate);
        assert!(plan.message.to_lowercase().contains("usage limit"));
    }

    #[test]
    fn a_5xx_and_overloaded_are_the_provider_being_unavailable() {
        for input in [
            status(500),
            status(503),
            status(529),
            code("overloaded"),
            code("server_error"),
        ] {
            let e = classify_engine_error("openrouter", CC, input);
            assert_eq!(e.kind, ErrorKind::Unavailable, "{input:?}");
            assert!(e.message.contains("OpenRouter"));
        }
    }

    #[test]
    fn an_unknown_model_says_to_pick_another_one() {
        let e = classify_engine_error(
            "deepseek",
            CC,
            code_message(
                "model_not_found",
                "There's an issue with the selected model (deepseek-flash[1m]). It may not exist or you may not have access to it.",
            ),
        );
        assert_eq!(e.kind, ErrorKind::Model);
        assert!(e.message.to_lowercase().contains("pick another model"));
        assert_eq!(
            classify_engine_error("openrouter", CC, status_message(404, "model not found")).kind,
            ErrorKind::Model
        );
        assert_eq!(
            classify_engine_error("openrouter", CC, status_message(400, "invalid model id foo/bar")).kind,
            ErrorKind::Model
        );
    }

    #[test]
    fn a_full_context_is_its_own_kind_llama_servers_400s_even_when_the_words_name_the_model_no_flag_no_retry() {
        for words in [
            "request (40123 tokens) exceeds the available context size (32768 tokens), try increasing it",
            "{\"error\":{\"type\":\"exceed_context_size_error\",\"message\":\"model qwen3.5-9b: request too big\"}}",
            "the request is larger than the max context size of the model",
            "context_length_exceeded",
        ] {
            let e = classify_engine_error("local", CX, status_message(400, words));
            assert_eq!(e.kind, ErrorKind::Context, "{words}");
            assert_eq!(e.state, None);
            assert!(!e.recoverable);
            assert!(e.message.contains("no longer fits in your Local AI's memory"));
            assert!(e.message.contains("llama-server with a larger -c"));
        }
        let named = classify_engine_error(
            "openrouter",
            CX,
            EngineFailure {
                status: Some(400),
                message: Some("context_length_exceeded"),
                model: Some("x/y"),
                ..EngineFailure::default()
            },
        );
        assert!(named.message.contains("no longer fits in x/y's context window"));
    }

    #[test]
    fn only_a_failed_session_resume_is_recoverable() {
        let e = classify_engine_error(
            "claude",
            CC,
            message("API Error: 400 diagnostics.previous_message_id: must be the id from a prior message"),
        );
        assert_eq!(e.kind, ErrorKind::Session);
        assert!(e.recoverable);
        assert!(
            classify_engine_error("deepseek", CC, message("No conversation found with session ID: abc")).recoverable
        );
        for k in [status(401), status(402), status(429), status(500)] {
            assert!(!classify_engine_error("deepseek", CC, k).recoverable);
        }
    }

    #[test]
    fn an_expired_claude_oauth_token_in_the_words_is_the_plans_sign_in_whatever_the_status() {
        let e = classify_engine_error(
            "claude",
            CC,
            message(
                "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
            ),
        );
        assert_eq!(e.kind, ErrorKind::Expired);
        assert_eq!(e.status, Some(401));
    }

    #[test]
    fn a_claude_sign_in_token_pasted_as_an_api_key_is_the_wrong_key_slot() {
        let e = classify_engine_error(
            "anthropic",
            CC,
            code_message("bad-key", "This is a Claude sign-in token, not an API key."),
        );
        assert_eq!(e.kind, ErrorKind::WrongKey);
        assert_eq!(e.state, Some("error"));
        assert!(e.message.contains("sign-in token"));
    }

    #[test]
    fn tarsees_own_refusals_keep_their_code_and_words() {
        let iso = classify_engine_error(
            "deepseek",
            CC,
            code_message(
                "credential-isolation",
                "X is a sign-in file in a folder meant only for an API key.",
            ),
        );
        assert_eq!(iso.kind, ErrorKind::CredentialIsolation);
        assert!(iso.message.contains("sign-in file"));
        let nk = classify_engine_error("deepseek", CC, code_message("needs-key", "DeepSeek needs its API key."));
        assert_eq!(nk.kind, ErrorKind::NeedsKey);
        assert_eq!(nk.state, Some("needs-key"));
        assert_eq!(nk.code.as_deref(), Some("needs-key"));
        assert_eq!(nk.message, "DeepSeek needs its API key.");
    }

    #[test]
    fn anything_else_is_unknown_keeps_the_engines_words_and_is_not_recoverable() {
        let e = classify_engine_error("openrouter", CC, message("something odd happened"));
        assert_eq!(e.kind, ErrorKind::Unknown);
        assert!(!e.recoverable);
        assert!(e.message.contains("something odd happened"));
    }

    #[test]
    fn an_unknown_provider_still_gets_a_sensible_answer() {
        let e = classify_engine_error("nope", CC, status(401));
        assert_eq!(e.kind, ErrorKind::Auth);
        assert_eq!(e.message, "**nope turned down the key.** Check it in Settings > AI.");
        assert_eq!(e.provider, "nope");
    }

    // --- friendly, authMessage, failureStateFor, statusFromMessage ---

    #[test]
    fn every_kind_has_words_for_every_provider() {
        for id in [
            "claude",
            "anthropic",
            "chatgpt",
            "openai",
            "openrouter",
            "deepseek",
            "local",
        ] {
            for kind in ERROR_KINDS {
                let text = friendly(id, *kind, Some("detail words"), None);
                assert!(text.len() > 10, "{id}/{kind}");
                assert!(
                    !text.contains("undefined") && !text.contains("null"),
                    "{id}/{kind}: {text}"
                );
            }
        }
    }

    #[test]
    fn auth_message_is_the_providers_own_fix() {
        assert!(auth_message("claude").contains("`claude auth login`"));
        assert!(auth_message("claude-code").contains("`claude auth login`"));
        assert!(auth_message("chatgpt").contains("Sign in again in Settings > AI"));
        assert!(auth_message("deepseek").contains("DEEPSEEK_API_KEY"));
        assert_eq!(
            auth_message("deepseek"),
            "**Your DeepSeek key was rejected.** Update it in Settings > AI or the Railway variable DEEPSEEK_API_KEY."
        );
    }

    #[test]
    fn failure_flags_expired_rejected_key_out_of_credit_missing_key_nothing_for_busy_or_a_model() {
        assert_eq!(failure_state_for(ErrorKind::Expired), Some("sign-in-expired"));
        assert_eq!(failure_state_for(ErrorKind::Auth), Some("error"));
        assert_eq!(failure_state_for(ErrorKind::WrongKey), Some("error"));
        assert_eq!(failure_state_for(ErrorKind::Billing), Some("out-of-credit"));
        assert_eq!(failure_state_for(ErrorKind::NeedsKey), Some("needs-key"));
        for k in [
            ErrorKind::Rate,
            ErrorKind::Unavailable,
            ErrorKind::Model,
            ErrorKind::Session,
            ErrorKind::Unknown,
        ] {
            assert_eq!(failure_state_for(k), None, "{k}");
        }
    }

    #[test]
    fn reads_a_status_out_of_the_clis_words() {
        assert_eq!(status_from_message("API Error: 402 Insufficient Balance"), Some(402));
        assert_eq!(
            status_from_message("API Error: Request rejected (429) · slow down"),
            Some(429)
        );
        assert_eq!(
            status_from_message("Failed to authenticate. API Error: 401 bad"),
            Some(401)
        );
        assert_eq!(status_from_message("all good, 200 apples"), None);
    }

    // --- What the JS suite did not test ---

    #[test]
    fn a_local_ai_with_no_responses_api_is_told_what_to_update() {
        assert_eq!(
            local_no_responses_message(Some(" http://127.0.0.1:11434/v1// ")),
            "**Your Local AI at http://127.0.0.1:11434/v1 has no Responses API**: http://127.0.0.1:11434/v1/responses answered \"not found\". Tarsee talks to Local AI through that API. Update Ollama to 0.13.3 or newer, LM Studio to 0.3.29 or newer or llama.cpp to b11768 or newer, or use a server that has it."
        );
        assert!(
            local_no_responses_message(None)
                .starts_with("**Your Local AI has no Responses API**: its /responses address answered \"not found\".")
        );
    }

    #[test]
    fn the_kinds_are_the_seventeen_names_and_an_answer_serialises_as_the_javascript_object() {
        assert_eq!(ERROR_KINDS.len(), 17);
        assert_eq!(
            ERROR_KINDS.iter().map(|k| k.as_str()).collect::<Vec<_>>(),
            [
                "expired",
                "auth",
                "wrong-key",
                "billing",
                "rate",
                "unavailable",
                "model",
                "context",
                "session",
                "moderated",
                "credential-isolation",
                "needs-key",
                "needs-setup",
                "bad-model",
                "wrong-engine",
                "needs-mcp-token",
                "unknown"
            ]
        );
        for kind in ERROR_KINDS {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
            assert_eq!(ErrorKind::from_name(kind.as_str()), Some(*kind));
        }
        let e = classify_engine_error("claude-code", CC, message("API Error: 500 boom"));
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            "{\"kind\":\"unavailable\",\"provider\":\"claude\",\"engine\":\"claude-code\",\"status\":500,\"code\":null,\"recoverable\":false,\"state\":null,\"message\":\"**Claude isn't answering right now** (the service is down or overloaded). This usually clears up on its own: try again in a few minutes, or switch to another AI in Settings > AI.\"}"
        );
    }

    #[test]
    fn a_broad_code_gives_way_to_the_status_and_an_expired_key_is_a_rejected_one() {
        let kind = |provider: &str, input: EngineFailure<'_>| {
            let e = classify_engine_error(provider, CC, input);
            (e.kind, e.status, e.state)
        };
        // "authentication_failed" and "rate_limit" are what the engine says of many failures: a status says more.
        assert_eq!(
            kind(
                "deepseek",
                EngineFailure {
                    status: Some(402),
                    code: Some("authentication_failed"),
                    ..EngineFailure::default()
                }
            ),
            (ErrorKind::Billing, Some(402), Some("out-of-credit"))
        );
        assert_eq!(
            kind(
                "deepseek",
                code_message("rate_limit", "API Error: 402 Insufficient Balance")
            ),
            (ErrorKind::Billing, Some(402), Some("out-of-credit"))
        );
        assert_eq!(
            kind(
                "openai",
                EngineFailure {
                    status: Some(400),
                    code: Some("authentication_failed"),
                    message: Some("It does not exist or you do not have access to it."),
                    ..EngineFailure::default()
                }
            ),
            (ErrorKind::Model, Some(400), None)
        );
        // With no status the code stands; a code that is exact already is not second-guessed by the status.
        assert_eq!(
            kind("deepseek", code("authentication_failed")),
            (ErrorKind::Auth, None, Some("error"))
        );
        assert_eq!(
            kind(
                "deepseek",
                EngineFailure {
                    status: Some(401),
                    code: Some("billing_error"),
                    ..EngineFailure::default()
                }
            ),
            (ErrorKind::Billing, Some(401), Some("out-of-credit"))
        );
        // "Expired" belongs to the plans: on a key provider it is the key that failed; an AI Tarsee doesn't know
        // keeps the engine's word.
        assert_eq!(
            kind("deepseek", message("token_expired")),
            (ErrorKind::Auth, None, Some("error"))
        );
        assert_eq!(
            kind("nope", message("token_expired")),
            (ErrorKind::Expired, None, Some("sign-in-expired"))
        );
        assert_eq!(
            kind(
                "chatgpt",
                message("Your access token could not be refreshed because your refresh token was revoked.")
            ),
            (ErrorKind::Expired, None, Some("sign-in-expired"))
        );
        // Moderation is OpenRouter's 403 only: the same words under another status, or none, are not it.
        assert_eq!(
            kind("openrouter", status_message(500, "Your input was flagged")),
            (ErrorKind::Unavailable, Some(500), None)
        );
        assert_eq!(
            kind("openrouter", message("requires moderation")),
            (ErrorKind::Unknown, None, None)
        );
    }

    #[test]
    fn a_status_below_400_given_by_the_engine_is_read_from_the_words_instead() {
        let e = classify_engine_error("deepseek", None, status_message(200, "HTTP 503 from upstream"));
        assert_eq!((e.kind, e.status, e.engine), (ErrorKind::Unavailable, Some(503), None));
        assert_eq!(status_from_message("status: 404"), Some(404));
        assert_eq!(status_from_message("API Error: 4021"), None);
        assert_eq!(
            status_from_message("API Error: 302 Found (404)"),
            None,
            "the first pattern that matches decides"
        );
        // A 400 that names no model in the usual words, only that something "does not exist".
        assert_eq!(
            classify_engine_error(
                "openai",
                CX,
                status_message(400, "The thing does not exist or you do not have access to it.")
            )
            .kind,
            ErrorKind::Model
        );
    }
}
