//! Port of `src/lib/url-safety.js`: URL Safety — checks URLs before browser navigation. Blocks known phishing,
//! malware, and suspicious domains.
//!
//! Layers:
//!   1. Local blocklist (instant, no API)
//!   2. Suspicious pattern detection (typosquatting, data URIs, IP addresses)
//!   3. Google Safe Browsing API (if key configured, 10K free lookups/day)
//!
//! This is a reputation check, not a network guard: it lets loopback through (127.0.0.1 is allowed, names are
//! not resolved). The guard against private and local addresses for downloads is in `lib::pdf_text`
//! (`is_private_address`, `GuardedLookup`).

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};

use crate::db::settings::Settings;
use crate::net::fetch::{Fetch, FetchError, FetchRequest};
use crate::util::js::number_to_string;

/// Known malicious TLDs and patterns
const BLOCKED_TLDS: &[&str] = &[
    ".zip", ".mov", ".top", ".xyz", ".tk", ".ml", ".ga", ".cf", ".gq", ".buzz", ".click", ".link", ".surf", ".icu",
    ".monster",
];

/// Known legitimate domains (never block these)
const TRUSTED_DOMAINS: &[&str] = &[
    "google.com",
    "github.com",
    "gitlab.com",
    "stackoverflow.com",
    "claude.ai",
    "anthropic.com",
    "openai.com",
    "railway.app",
    "vercel.app",
    "netlify.app",
    "render.com",
    "npmjs.com",
    "pypi.org",
    "hub.docker.com",
    "youtube.com",
    "twitter.com",
    "x.com",
    "reddit.com",
    "linkedin.com",
    "facebook.com",
    "instagram.com",
    "discord.com",
    "discord.gg",
    "telegram.org",
    "t.me",
    "slack.com",
    "notion.so",
    "figma.com",
    "canva.com",
    "aws.amazon.com",
    "azure.microsoft.com",
    "cloud.google.com",
    "huggingface.co",
    "kaggle.com",
    "wikipedia.org",
    "medium.com",
    "dev.to",
    "stripe.com",
    "paypal.com",
    "zoom.us",
    "meet.google.com",
    "docs.google.com",
    "drive.google.com",
    "sheets.google.com",
    "outlook.com",
    "mail.google.com",
];

/// Suspicious domain patterns (typosquatting, lookalikes). Hostnames reach these in lower-case ASCII (the URL
/// parser lower-cases them and writes other scripts as punycode), so `(?i)` matches what the JS `/i` matched.
static SUSPICIOUS_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)g[o0]{2}gle",               // g00gle, gooogle
        r"(?i)faceb[o0]{2}k",             // faceb00k
        r"(?i)amaz[o0]n",                 // amaz0n
        r"(?i)paypa[l1]",                 // paypa1
        r"(?i)m[i1]cr[o0]s[o0]ft",        // micr0soft
        r"(?i)app[l1]e\.",                // app1e
        r"(?i)l[o0]gin|s[i1]gn[i1]n",     // login pages with letter swaps
        r"(?i)secure.*update.*account",   // phishing pattern
        r"(?i)verify.*identity.*confirm", // phishing pattern
    ]
    .iter()
    .map(|p| Regex::new(p).expect("a suspicious-domain pattern"))
    .collect()
});

/// `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`
static RAW_IPV4: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$").expect("the IPv4 pattern"));

/// Blocked URL schemes
const BLOCKED_SCHEMES: &[&str] = &["javascript:", "data:", "blob:", "vbscript:"];

/// How sure the check is that a URL is bad.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SafetyLevel {
    Blocked,
    Warning,
}

impl SafetyLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            SafetyLevel::Blocked => "blocked",
            SafetyLevel::Warning => "warning",
        }
    }
}

/// `{ safe, reason?, level? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UrlSafety {
    pub safe: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<SafetyLevel>,
}

impl UrlSafety {
    fn safe() -> Self {
        UrlSafety {
            safe: true,
            reason: None,
            level: None,
        }
    }

    fn refused(reason: String, level: SafetyLevel) -> Self {
        UrlSafety {
            safe: false,
            reason: Some(reason),
            level: Some(level),
        }
    }
}

/// Check if a URL is safe to visit. `settings` holds the Safe Browsing key (`google.safe_browsing_key`), when one is
/// configured; `fetch` makes the Safe Browsing request.
pub async fn check_url_safety(url_str: &str, settings: Option<&dyn Settings>, fetch: &dyn Fetch) -> UrlSafety {
    // Parse URL
    let Ok(parsed) = url::Url::parse(url_str) else {
        return UrlSafety::refused("Invalid URL".into(), SafetyLevel::Blocked);
    };
    let protocol = format!("{}:", parsed.scheme());

    // Block dangerous schemes
    if BLOCKED_SCHEMES.contains(&protocol.as_str()) {
        return UrlSafety::refused(format!("Blocked scheme: {protocol}"), SafetyLevel::Blocked);
    }

    // Only allow http/https
    if protocol != "http:" && protocol != "https:" {
        return UrlSafety::refused(format!("Non-HTTP scheme: {protocol}"), SafetyLevel::Blocked);
    }

    let hostname = parsed.host_str().unwrap_or("").to_lowercase();
    let labels: Vec<&str> = hostname.split('.').collect();
    let domain = labels[labels.len().saturating_sub(2)..].join(".");

    // Trusted domains — always safe
    if TRUSTED_DOMAINS.contains(&domain.as_str()) || TRUSTED_DOMAINS.contains(&hostname.as_str()) {
        return UrlSafety::safe();
    }

    // Block raw IP addresses (except localhost)
    if RAW_IPV4.is_match(&hostname) && hostname != "127.0.0.1" {
        return UrlSafety::refused(
            format!("Raw IP address: {hostname} — likely phishing or C2"),
            SafetyLevel::Warning,
        );
    }

    // Block suspicious TLDs
    let tld = format!(".{}", labels.last().copied().unwrap_or(""));
    if BLOCKED_TLDS.contains(&tld.as_str()) {
        return UrlSafety::refused(format!("Suspicious TLD: {tld}"), SafetyLevel::Warning);
    }

    // Check for typosquatting patterns
    if SUSPICIOUS_PATTERNS.iter().any(|p| p.is_match(&hostname)) {
        return UrlSafety::refused(
            format!("Suspicious domain (possible typosquatting): {hostname}"),
            SafetyLevel::Warning,
        );
    }

    // Very long subdomains are suspicious (phishing)
    if labels.iter().any(|part| part.encode_utf16().count() > 30) {
        return UrlSafety::refused(format!("Unusually long subdomain in {hostname}"), SafetyLevel::Warning);
    }

    // Google Safe Browsing API check (if key configured)
    let key = settings.and_then(|s| s.get("google.safe_browsing_key"));
    if let Some(key) = key.filter(crate::util::js::truthy) {
        let key = match key {
            Value::String(text) => text,
            Value::Number(n) => number_to_string(n.as_f64().unwrap_or(0.0)),
            other => other.to_string(),
        };
        match check_google_safe_browsing(url_str, &key, fetch).await {
            Ok(result) if !result.safe => return result,
            Ok(_) => {}
            Err(message) => {
                log::warn!("[url-safety] Safe Browsing API error: {message}");
                // Don't block on API failure — just warn
            }
        }
    }

    UrlSafety::safe()
}

/// Check URL against Google Safe Browsing API. The error is the message the JS threw.
async fn check_google_safe_browsing(url: &str, api_key: &str, fetch: &dyn Fetch) -> Result<UrlSafety, String> {
    let body = json!({
        "client": { "clientId": "tarsee", "clientVersion": "1.0" },
        "threatInfo": {
            "threatTypes": ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
            "platformTypes": ["ANY_PLATFORM"],
            "threatEntryTypes": ["URL"],
            "threatEntries": [{ "url": url }],
        },
    });
    let request = FetchRequest::post(format!(
        "https://safebrowsing.googleapis.com/v4/threatMatches:find?key={api_key}"
    ))
    .header("Content-Type", "application/json")
    .json(&body)
    .timeout(Duration::from_millis(5000));
    let res = fetch.fetch(request).await.map_err(|err| match err {
        FetchError::Timeout => "The operation was aborted due to timeout".to_string(),
        FetchError::Connect(_) => "fetch failed".to_string(),
        other => other.to_string(),
    })?;

    if !res.ok() {
        return Err(format!("API {}", res.status));
    }
    let data = res.json().await.map_err(|err| err.to_string())?;

    if let Some(first) = data.get("matches").and_then(Value::as_array).and_then(|m| m.first()) {
        let threat = match first.get("threatType") {
            Some(Value::String(t)) => t.clone(),
            None | Some(Value::Null) => "undefined".to_string(),
            Some(other) => other.to_string(),
        };
        return Ok(UrlSafety::refused(
            format!("Google Safe Browsing: {threat}"),
            SafetyLevel::Blocked,
        ));
    }

    Ok(UrlSafety::safe())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{Answer, MemorySettings, test_app};

    async fn check(url: &str) -> UrlSafety {
        let t = test_app();
        check_url_safety(url, None, &*t.fetch()).await
    }

    fn refused(reason: &str, level: SafetyLevel) -> UrlSafety {
        UrlSafety::refused(reason.to_string(), level)
    }

    #[tokio::test]
    async fn bad_urls_and_schemes_are_blocked() {
        assert_eq!(check("not a url").await, refused("Invalid URL", SafetyLevel::Blocked));
        assert_eq!(
            check("javascript:alert(1)").await,
            refused("Blocked scheme: javascript:", SafetyLevel::Blocked)
        );
        assert_eq!(
            check("data:text/html,hi").await,
            refused("Blocked scheme: data:", SafetyLevel::Blocked)
        );
        assert_eq!(
            check("ftp://files.example.org/x").await,
            refused("Non-HTTP scheme: ftp:", SafetyLevel::Blocked)
        );
    }

    #[tokio::test]
    async fn trusted_domains_and_their_subdomains_are_safe() {
        assert_eq!(check("https://docs.github.com/en").await, UrlSafety::safe());
        assert_eq!(check("https://GOOGLE.com/").await, UrlSafety::safe());
        // Trusted wins over the patterns below: "signin" would otherwise be suspicious.
        assert_eq!(check("https://signin.google.com/").await, UrlSafety::safe());
    }

    #[tokio::test]
    async fn raw_ip_addresses_warn_except_loopback() {
        assert_eq!(
            check("http://93.184.216.34/x").await,
            refused(
                "Raw IP address: 93.184.216.34 — likely phishing or C2",
                SafetyLevel::Warning
            )
        );
        // The URL parser writes other IPv4 forms in dotted decimal first, as `new URL` did.
        assert_eq!(
            check("http://0x5d.0xb8.0xd8.0x22/").await,
            refused(
                "Raw IP address: 93.184.216.34 — likely phishing or C2",
                SafetyLevel::Warning
            )
        );
        assert_eq!(check("http://127.0.0.1:3000/").await, UrlSafety::safe());
        assert_eq!(check("http://2130706433/").await, UrlSafety::safe());
        // A name in another script reaches the patterns as punycode, as with `new URL`.
        assert_eq!(check("https://\u{430}pple.com/").await, UrlSafety::safe());
        // IPv6 is not a raw IPv4 address.
        assert_eq!(check("http://[::1]/").await, UrlSafety::safe());
    }

    #[tokio::test]
    async fn suspicious_tlds_patterns_and_long_labels_warn() {
        assert_eq!(
            check("https://free-stuff.xyz/").await,
            refused("Suspicious TLD: .xyz", SafetyLevel::Warning)
        );
        assert_eq!(
            check("https://g00gle-help.example/").await,
            refused(
                "Suspicious domain (possible typosquatting): g00gle-help.example",
                SafetyLevel::Warning
            )
        );
        assert_eq!(
            check("https://secure-update-your-account.example/").await,
            refused(
                "Suspicious domain (possible typosquatting): secure-update-your-account.example",
                SafetyLevel::Warning
            )
        );
        let long = format!("https://{}.example.org/", "a".repeat(31));
        assert_eq!(
            check(&long).await,
            refused(
                &format!("Unusually long subdomain in {}.example.org", "a".repeat(31)),
                SafetyLevel::Warning
            )
        );
        assert_eq!(
            check(&format!("https://{}.example.org/", "a".repeat(30))).await,
            UrlSafety::safe()
        );
        assert_eq!(check("https://example.org/").await, UrlSafety::safe());
    }

    #[tokio::test]
    async fn safe_browsing_is_asked_only_with_a_key_and_its_threat_blocks() {
        let t = test_app();
        let base = "https://safebrowsing.googleapis.com/v4/threatMatches:find";
        t.fetch
            .respond(base, Answer::json(200, json!({"matches": [{"threatType": "MALWARE"}]})));
        // No key: never asked.
        assert_eq!(
            check_url_safety("https://example.org/", None, &*t.fetch()).await,
            UrlSafety::safe()
        );
        assert!(t.fetch.calls().is_empty());

        let settings = MemorySettings::from_pairs([("google.safe_browsing_key", json!("test-key"))]);
        let got = check_url_safety("https://example.org/a", Some(&settings), &*t.fetch()).await;
        assert_eq!(got, refused("Google Safe Browsing: MALWARE", SafetyLevel::Blocked));
        let calls = t.fetch.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].url, format!("{base}?key=test-key"));
        assert_eq!(calls[0].method, "POST");
        assert_eq!(
            calls[0].json()["threatInfo"]["threatEntries"],
            json!([{"url": "https://example.org/a"}])
        );
        assert_eq!(
            calls[0].json()["client"],
            json!({"clientId": "tarsee", "clientVersion": "1.0"})
        );

        // No matches: safe. A failing API: safe (it only warns). A trusted domain: not asked at all.
        t.fetch.respond(base, Answer::json(200, json!({})));
        assert_eq!(
            check_url_safety("https://example.org/b", Some(&settings), &*t.fetch()).await,
            UrlSafety::safe()
        );
        t.fetch.respond(base, Answer::json(500, json!({})));
        assert_eq!(
            check_url_safety("https://example.org/c", Some(&settings), &*t.fetch()).await,
            UrlSafety::safe()
        );
        t.fetch.clear_calls();
        assert_eq!(
            check_url_safety("https://github.com/", Some(&settings), &*t.fetch()).await,
            UrlSafety::safe()
        );
        assert!(t.fetch.calls().is_empty());
    }

    #[test]
    fn the_result_serializes_as_the_js_object_did() {
        assert_eq!(serde_json::to_value(UrlSafety::safe()).unwrap(), json!({"safe": true}));
        assert_eq!(
            serde_json::to_value(refused("x", SafetyLevel::Warning)).unwrap(),
            json!({"safe": false, "reason": "x", "level": "warning"})
        );
    }
}
