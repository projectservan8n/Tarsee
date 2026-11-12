//! Port of `src/lib/redact.js`: removes known secret patterns from text.
//!
//! Used to clean debug output, logs, error messages, and the tool-call timeline that streams to the UI and is kept
//! in the database. The patterns run in the JS order; each sees the output of the one before.

use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use serde_json::Value;

const REDACTED: &str = "[REDACTED]";

/// (pattern, replacement), in order. `(?-u:\b)` is JavaScript's ASCII word boundary.
static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let rule = |pattern: &str, replacement: &'static str| (Regex::new(pattern).expect("a redact pattern"), replacement);
    vec![
        // OpenAI keys (sk-..., sk-proj-..., sk-svcacct-...) and DeepSeek keys (sk- and 32 hex)
        rule(r"sk-[A-Za-z0-9_-]{10,}", REDACTED),
        // Anthropic keys and Claude sign-in tokens (sk-ant-api..., sk-ant-oat..., sk-ant-ort...)
        rule(r"sk-ant-[A-Za-z0-9_-]{10,}", REDACTED),
        // OpenRouter keys (sk-or-v1-...)
        rule(r"sk-or-v1-[A-Za-z0-9_-]{10,}", REDACTED),
        // OAuth and key fields in JSON, whatever their values look like ("refresh_token": "...", "apiKey": "..."):
        // ChatGPT's and Claude's sign-in files and token answers carry them
        rule(
            r#"("(?:access_token|refresh_token|id_token|client_secret|code_verifier|api_key|apiKey|primaryApiKey|OPENAI_API_KEY)"\s*:\s*")[^"]+(")"#,
            "${1}[REDACTED]${2}",
        ),
        // The same fields in a query string or form body (refresh_token=...)
        rule(
            r#"(?-u:\b)((?:access_token|refresh_token|id_token|client_secret|code_verifier|api_key)=)[^&\s"']+"#,
            "${1}[REDACTED]",
        ),
        // An API key header, whatever the key looks like (x-api-key: ...)
        rule(r#"(?i)(x-api-key:\s*)[^\s"',;]+"#, "${1}[REDACTED]"),
        // Stripe keys (sk_live_, sk_test_, pk_live_, pk_test_, whsec_)
        rule(r"(?-u:\b)(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{16,}", REDACTED),
        rule(r"(?-u:\b)whsec_[A-Za-z0-9]{16,}", REDACTED),
        // GitHub tokens (gho_, ghp_, ghs_, ghr_, ghu_, github_pat_)
        rule(r"gh[opsruh]_[A-Za-z0-9_]{10,}", REDACTED),
        rule(r"(?-u:\b)github_pat_[A-Za-z0-9_]{20,}", REDACTED),
        // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xapp-)
        rule(r"xox[bpars]-[A-Za-z0-9-]{10,}", REDACTED),
        rule(r"xapp-[A-Za-z0-9-]{10,}", REDACTED),
        // Telegram bot tokens (123456:ABC...)
        rule(r"[0-9]{5,}:[A-Za-z0-9_-]{10,}", REDACTED),
        // Discord bot tokens (3-part dot-separated base64)
        rule(r"[A-Za-z0-9]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}", REDACTED),
        // Discord webhook URLs: the token after the webhook id (the id stays, so it is clear which webhook)
        rule(
            r"(discord(?:app)?\.com/api/(?:v[0-9]+/)?webhooks/[0-9]+/)[A-Za-z0-9_-]{20,}",
            "${1}[REDACTED]",
        ),
        // Google API keys (AIza...)
        rule(r"AIza[A-Za-z0-9_-]{30,}", REDACTED),
        // AWS access key IDs (20-char AKIA prefix)
        rule(r"(?-u:\b)AKIA[0-9A-Z]{16}(?-u:\b)", REDACTED),
        // Bearer tokens in Authorization headers
        rule(r"(?i)(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]{16,}", "${1}[REDACTED]"),
        // Postgres / MongoDB connection strings with embedded password
        rule(r"(?i)(postgres(?:ql)?://[^:\s]+):([^@\s]+)@", "${1}:[REDACTED]@"),
        rule(r"(?i)(mongodb(?:\+srv)?://[^:\s]+):([^@\s]+)@", "${1}:[REDACTED]@"),
        // JWTs (three base64url segments, 8+ chars each, with the standard "eyJ" header)
        rule(
            r"(?-u:\b)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?-u:\b)",
            REDACTED,
        ),
    ]
});

/// Inline KEY=value where KEY ends in TOKEN/SECRET/KEY/PASSWORD and the value is 8+ chars and not a URL (so
/// MY_PUBLIC_KEY=https://... stays). Needs a lookahead, so it is a `fancy_regex`.
static INLINE_KEY: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r#"\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD))=(?!https?://)([^\s"']{8,})"#)
        .expect("the inline key pattern")
});

/// Generic long hex strings (likely API keys, 40+ chars).
static LONG_HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)[0-9a-f]{40,}(?-u:\b)").expect("the long hex pattern"));

/// Generic long base64 strings that look like tokens (64+ chars, no spaces). Needs lookarounds.
static LONG_BASE64: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r"(?<![A-Za-z0-9])[A-Za-z0-9+/=_-]{64,}(?![A-Za-z0-9])").expect("the long base64 pattern")
});

/// Replaces every known secret pattern in `text` with `[REDACTED]`.
pub fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    for (pattern, replacement) in RULES.iter() {
        if let std::borrow::Cow::Owned(changed) = pattern.replace_all(&out, *replacement) {
            out = changed;
        }
    }
    out = INLINE_KEY.replace_all(&out, "${1}=[REDACTED]").into_owned();
    if let std::borrow::Cow::Owned(changed) = LONG_HEX.replace_all(&out, REDACTED) {
        out = changed;
    }
    LONG_BASE64.replace_all(&out, REDACTED).into_owned()
}

/// Redacts secrets in every string inside a JSON value (tool-call inputs are nested JSON: Bash has `command`,
/// WebFetch has `url`, and so on). Keys and non-string values pass through unchanged.
pub fn redact_deep(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact_secrets(s)),
        Value::Array(items) => Value::Array(items.iter().map(redact_deep).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), redact_deep(v))).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    //! Port of `test/redact.test.js`.
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_openai_api_keys() {
        assert_eq!(
            redact_secrets("key is sk-1234567890abcdef1234567890"),
            "key is [REDACTED]"
        );
    }

    #[test]
    fn redacts_anthropic_api_keys() {
        assert_eq!(redact_secrets("sk-ant-api03-1234567890abcdefghijk"), "[REDACTED]");
    }

    #[test]
    fn redacts_openrouter_keys() {
        assert_eq!(
            redact_secrets("sk-or-v1-1234567890abcdef1234567890abcdef1234567890ab"),
            "[REDACTED]"
        );
    }

    #[test]
    fn redacts_the_token_of_a_discord_webhook_url_keeping_its_id() {
        assert_eq!(
            redact_secrets(
                "hook: https://discord.com/api/webhooks/1431234567890123456/AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcdefgh and https://discordapp.com/api/v10/webhooks/12345678901234567/abcdefghijklmnopqrstuvwxyz"
            ),
            "hook: https://discord.com/api/webhooks/1431234567890123456/[REDACTED] and https://discordapp.com/api/v10/webhooks/12345678901234567/[REDACTED]"
        );
    }

    #[test]
    fn redacts_github_tokens() {
        assert_eq!(redact_secrets("token: ghp_1234567890abcdefghijk"), "token: [REDACTED]");
    }

    #[test]
    fn redacts_slack_tokens() {
        assert_eq!(
            redact_secrets("xoxb-1234567890-1234567890-abcdefghijklmnop"),
            "[REDACTED]"
        );
    }

    #[test]
    fn redacts_telegram_bot_tokens() {
        assert_eq!(redact_secrets("12345678:ABCDefgh_ijklmn123456"), "[REDACTED]");
    }

    #[test]
    fn redacts_google_api_keys() {
        assert_eq!(redact_secrets("AIzaSyAbcdefghijklmnopqrstuvwxyz1234567"), "[REDACTED]");
    }

    #[test]
    fn does_not_redact_normal_text() {
        let text = "Hello, this is a normal message with no secrets.";
        assert_eq!(redact_secrets(text), text);
    }

    #[test]
    fn redacts_multiple_secrets_in_one_string() {
        let result = redact_secrets("openai: sk-abc123456789xyz key, slack: xoxb-123456789012-something");
        assert!(!result.contains("sk-abc123456789xyz"));
        assert!(!result.contains("xoxb-123456789012"));
    }

    #[test]
    fn redacts_stripe_live_and_test_secret_keys() {
        assert!(!redact_secrets("sk_live_abcdefghijklmnopqrstuv").contains("sk_live_abc"));
        assert!(!redact_secrets("sk_test_abcdefghijklmnopqrstuv").contains("sk_test_abc"));
        assert!(!redact_secrets("whsec_1234567890abcdefghij").contains("whsec_1234"));
    }

    #[test]
    fn redacts_aws_access_key_ids() {
        assert_eq!(redact_secrets("creds: AKIAIOSFODNN7EXAMPLE"), "creds: [REDACTED]");
    }

    #[test]
    fn redacts_bearer_tokens_in_authorization_headers() {
        let out = redact_secrets("Authorization: Bearer abcdef1234567890tokenvalue");
        assert!(out.contains("Authorization: Bearer "));
        assert!(!out.contains("abcdef1234567890tokenvalue"));
    }

    #[test]
    fn redacts_db_connection_string_passwords() {
        let out = redact_secrets("postgres://user:supersecret123@db.example.com/mydb");
        assert!(out.contains("postgres://user:[REDACTED]@db.example.com/mydb"));
    }

    #[test]
    fn redacts_jwt_shaped_tokens() {
        let jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIiw.SflKxwRJSMeKKF2QT4f";
        let out = redact_secrets(&format!("token {jwt} end"));
        assert!(out.contains("token "));
        assert!(out.contains("[REDACTED]"));
        assert!(!out.contains("eyJhbGc"));
    }

    #[test]
    fn redacts_inline_key_value_secrets_but_leaves_urls_alone() {
        assert_eq!(redact_secrets("MY_API_KEY=hunter2_password"), "MY_API_KEY=[REDACTED]");
        // KEY=URL is not a secret (false-positive guard).
        assert_eq!(
            redact_secrets("PUBLIC_KEY=https://example.com/key.pem"),
            "PUBLIC_KEY=https://example.com/key.pem"
        );
    }

    #[test]
    fn redacts_json_fields_query_fields_and_key_headers() {
        assert_eq!(
            redact_secrets(r#"{"refresh_token": "abc", "n": 1}"#),
            r#"{"refresh_token": "[REDACTED]", "n": 1}"#
        );
        assert_eq!(
            redact_secrets("a=1&refresh_token=xyz&b=2"),
            "a=1&refresh_token=[REDACTED]&b=2"
        );
        assert_eq!(redact_secrets("X-Api-Key: abc123, next"), "X-Api-Key: [REDACTED], next");
    }

    #[test]
    fn redacts_long_hex_and_long_base64_strings() {
        let hex = "a".repeat(40);
        assert_eq!(redact_secrets(&format!("id {hex} end")), "id [REDACTED] end");
        let token = "Ab+/".repeat(16);
        assert_eq!(redact_secrets(&format!("t {token} end")), "t [REDACTED] end");
        let short = "Ab+/".repeat(15);
        assert_eq!(redact_secrets(&format!("t {short} end")), format!("t {short} end"));
    }

    #[test]
    fn redact_deep_redacts_secrets_inside_nested_objects() {
        let input = json!({
            "command": "curl -H \"Authorization: Bearer sk-ant-FAKEkey1234567890abcd\"",
            "cwd": "/tmp",
            "env": { "OPENAI_API_KEY": "sk-fakefakefakefakefakefakefakefake" },
        });
        let out = redact_deep(&input);
        let text = out.to_string();
        assert!(!text.contains("sk-ant-FAKEkey"));
        assert!(!text.contains("sk-fakefake"));
        assert_eq!(out["cwd"], "/tmp");
    }

    #[test]
    fn redact_deep_preserves_arrays_and_non_string_values() {
        let out = redact_deep(&json!({ "items": ["safe", "ghp_secrettoken1234567890abc"], "n": 42, "b": true }));
        assert_eq!(out["n"], 42);
        assert_eq!(out["b"], true);
        assert_eq!(out["items"][0], "safe");
        assert!(!out["items"][1].as_str().unwrap().contains("ghp_secret"));
    }
}
