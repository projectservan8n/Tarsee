//! Port of `src/ai/session-handle.js`: the grammar of the session handle a chat stores
//! (conversations.claude_session_id, and the subagent and ACP stores), design 4.10.
//!
//! ```text
//!   Claude plan          the bare raw id, as every existing row already holds (no rewrite, rollback-safe)
//!   every other provider <provider>/<homeKey>/<vendor>:<rawId>
//!     homeKey  cc (Claude Code, the provider's own home), cx (.codex-home-keys) or cxd (.codex-home, the ChatGPT sign-in)
//!     vendor   the model's maker on OpenRouter (the slug's prefix without ~), otherwise the provider id
//!   e.g. deepseek/cc/deepseek:3f2a…, openrouter/cc/anthropic:…, openrouter/cx/openai:…
//! ```
//!
//! A session resumes only on the same provider, in the same engine home, with the same maker; anything else starts
//! fresh (and the turn layer carries the conversation over with a handoff). Readers that look up transcripts or sizes
//! by id use [`untag`] first. Pure: no I/O.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use super::context_limits::JS_SPACE_CLASS;
use super::engine::Target;
use super::engine_env::home_key_for;
use super::provider_registry::Engine;
use crate::util::js;

/// The maker a session is tied to (OpenRouter's slug prefix without ~, otherwise the provider): the registry's rule.
pub use super::provider_registry::vendor_for;

/// `String(id ?? "").toLowerCase()` is "claude" or "claude-code".
fn is_plan(id: Option<&str>) -> bool {
    matches!(id.unwrap_or("").to_lowercase().as_str(), "claude" | "claude-code")
}

fn canonical_id(id: &str) -> String {
    if is_plan(Some(id)) {
        "claude".to_string()
    } else {
        id.to_lowercase()
    }
}

/// The engine a home key belongs to (the JS `ENGINE_OF_HOME`), with the key as the handle spells it.
fn engine_of_home(home_key: &str) -> Option<(&'static str, Engine)> {
    match home_key {
        "cc" => Some(("cc", Engine::ClaudeCode)),
        "cx" => Some(("cx", Engine::Codex)),
        "cxd" => Some(("cxd", Engine::Codex)),
        _ => None,
    }
}

/// `/^([a-z0-9][a-z0-9-]*)\/(cc|cx|cxd)\/([a-z0-9][a-z0-9._-]*):(\S+)$/`
static TAGGED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([a-z0-9][a-z0-9-]*)/(cc|cx|cxd)/([a-z0-9][a-z0-9._-]*):([^{JS_SPACE_CLASS}]+)$"
    ))
    .expect("the tagged-handle pattern")
});

/// `/^[^\s/]+$/`
static BARE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^[^{JS_SPACE_CLASS}/]+$")).expect("the bare-handle pattern"));

/// An explicit vendor on a target, cleaned to what a handle can carry.
fn clean_vendor(vendor: &str) -> String {
    let lower = js::trim(vendor).to_lowercase();
    lower
        .strip_prefix('~')
        .unwrap_or(&lower)
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        .collect()
}

/// What a session is formatted for or resumed on: the JS target `{provider, engine, model}`, or with `homeKey` and
/// `vendor` already worked out. Every field may be missing, as on the JS object; a target that is not there at all
/// (`null`) is `HandleTarget::default()`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HandleTarget<'a> {
    pub provider: Option<&'a str>,
    /// "claude-code" or "codex".
    pub engine: Option<&'a str>,
    pub model: Option<&'a str>,
    /// "cc", "cx" or "cxd": wins over the one `engine` gives.
    pub home_key: Option<&'a str>,
    /// Wins over the model's maker.
    pub vendor: Option<&'a str>,
}

impl<'a> HandleTarget<'a> {
    /// `{ provider, engine, model }`.
    pub fn new(provider: &'a str, engine: &'a str, model: Option<&'a str>) -> Self {
        HandleTarget {
            provider: Some(provider),
            engine: Some(engine),
            model,
            ..HandleTarget::default()
        }
    }
}

impl<'a> From<&'a Target> for HandleTarget<'a> {
    /// A turn's target (`ai/engine.rs`), which carries its home key and vendor once the turn layer worked them out.
    fn from(target: &'a Target) -> Self {
        HandleTarget {
            provider: Some(target.provider.as_str()),
            engine: target.engine.as_deref(),
            model: target.model.as_deref(),
            home_key: target.home_key.as_deref(),
            vendor: target.vendor.as_deref(),
        }
    }
}

struct Place {
    provider: String,
    home_key: &'static str,
    vendor: String,
}

/// JavaScript's `||` on text: the value unless it is missing or empty.
fn truthy(text: Option<&str>) -> Option<&str> {
    text.filter(|t| !t.is_empty())
}

/// The target's home key and vendor: its own when given, else from its engine and model.
fn place_of(target: &HandleTarget<'_>) -> Option<Place> {
    let provider = canonical_id(truthy(target.provider)?);
    let home_key = match truthy(target.home_key) {
        Some(own) => own,
        None => home_key_for(&provider, target.engine.unwrap_or(""))?,
    };
    let (home_key, _) = engine_of_home(home_key)?;
    let vendor = match truthy(target.vendor) {
        Some(own) => clean_vendor(own),
        None => vendor_for(&provider, target.model)?,
    };
    if vendor.is_empty() {
        return None;
    }
    Some(Place {
        provider,
        home_key,
        vendor,
    })
}

/// Why [`format`] refused: the JS `Error`, whose message starts with "session-handle:".
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SessionHandleError(pub String);

/// `JSON.stringify(value)` inside a message: the text quoted, or "undefined" when there is none.
fn json_text(value: Option<&str>) -> String {
    match value {
        Some(text) => serde_json::Value::String(text.to_string()).to_string(),
        None => "undefined".to_string(),
    }
}

/// The handle to store for a raw session id on a target `{provider, engine, model}` (or with `home_key` and `vendor`
/// already worked out). `None` when there is no raw id. Fails when the target can't be placed, or when the handle
/// wouldn't parse back to the same raw id (a space in it, or a slash in a bare one), so a session is never stored
/// under a handle nothing would resume.
pub fn format<'a>(
    target: &HandleTarget<'_>,
    raw_id: impl Into<Option<&'a str>>,
) -> Result<Option<String>, SessionHandleError> {
    let raw = js::trim(raw_id.into().unwrap_or(""));
    if raw.is_empty() {
        return Ok(None);
    }
    let handle = if is_plan(target.provider) {
        raw.to_string()
    } else {
        let Some(place) = place_of(target) else {
            return Err(SessionHandleError(format!(
                "session-handle: can't place a session for {} on {}",
                json_text(target.provider),
                json_text(target.engine)
            )));
        };
        format!("{}/{}/{}:{raw}", place.provider, place.home_key, place.vendor)
    };
    if parse(handle.as_str()).map(|parsed| parsed.raw_id).as_deref() != Some(raw) {
        return Err(SessionHandleError(format!(
            "session-handle: a raw session id of that shape can't be stored ({})",
            json_text(Some(&js::utf16_truncate(raw, 40)))
        )));
    }
    Ok(Some(handle))
}

/// A stored handle, taken apart: `{provider, engine, homeKey, vendor, rawId, tagged}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedHandle {
    pub provider: String,
    pub engine: Engine,
    /// "cc", "cx" or "cxd".
    pub home_key: &'static str,
    pub vendor: String,
    pub raw_id: String,
    /// False for a bare id (the Claude plan's).
    pub tagged: bool,
}

/// `{provider, engine, homeKey, vendor, rawId, tagged}` for a stored handle, or `None` for nothing or a malformed
/// tag. A bare id is the Claude plan's.
pub fn parse<'a>(handle: impl Into<Option<&'a str>>) -> Option<ParsedHandle> {
    let h = js::trim(handle.into()?);
    if h.is_empty() {
        return None;
    }
    if let Some(m) = TAGGED.captures(h) {
        let (home_key, engine) = engine_of_home(&m[2])?;
        return Some(ParsedHandle {
            provider: m[1].to_string(),
            engine,
            home_key,
            vendor: m[3].to_string(),
            raw_id: m[4].to_string(),
            tagged: true,
        });
    }
    if !BARE.is_match(h) {
        return None;
    }
    Some(ParsedHandle {
        provider: "claude".to_string(),
        engine: Engine::ClaudeCode,
        home_key: "cc",
        vendor: "claude".to_string(),
        raw_id: h.to_string(),
        tagged: false,
    })
}

/// The raw id to resume for this target, or `None` to start fresh: the Claude plan resumes only a bare id; every
/// other provider only a handle with its own provider, home key and vendor.
pub fn session_for<'a>(handle: impl Into<Option<&'a str>>, target: &HandleTarget<'_>) -> Option<String> {
    let parsed = parse(handle)?;
    truthy(target.provider)?;
    if is_plan(target.provider) {
        return (!parsed.tagged).then_some(parsed.raw_id);
    }
    if !parsed.tagged {
        return None;
    }
    let place = place_of(target)?;
    let same = parsed.provider == place.provider && parsed.home_key == place.home_key && parsed.vendor == place.vendor;
    same.then_some(parsed.raw_id)
}

/// The raw id inside any stored handle (a bare one as it is), or `None` for nothing or a malformed tag.
pub fn untag<'a>(handle: impl Into<Option<&'a str>>) -> Option<String> {
    parse(handle).map(|parsed| parsed.raw_id)
}

#[cfg(test)]
mod tests {
    //! Port of `test/session-handle.test.js`: the value stored in conversations.claude_session_id. The Claude plan
    //! keeps the bare raw id (every existing row stays valid); every other provider stores
    //! `<provider>/<homeKey>/<vendor>:<rawId>`, so a session is only ever resumed by the same provider, in the same
    //! engine home, on the same model maker. Anything else starts fresh (the turn layer then adds the handoff).
    use super::*;
    use crate::ai::provider_registry;

    const RAW: &str = "3f2a9c1e-0b7d-4f43-9a51-2c8e7d6b1a00";

    fn t(provider: &'static str, engine: &'static str, model: Option<&'static str>) -> HandleTarget<'static> {
        HandleTarget::new(provider, engine, model)
    }

    /// The JS table `T`, in its order.
    fn targets() -> Vec<(&'static str, HandleTarget<'static>)> {
        vec![
            ("claude", t("claude", "claude-code", None)),
            ("claudeStored", t("claude-code", "claude-code", None)),
            ("anthropic", t("anthropic", "claude-code", Some("claude-sonnet-4-5"))),
            ("deepseek", t("deepseek", "claude-code", Some("deepseek-flash[1m]"))),
            ("deepseekCodex", t("deepseek", "codex", Some("deepseek-flash[1m]"))),
            (
                "orAnthropic",
                t("openrouter", "claude-code", Some("~anthropic/claude-sonnet-latest")),
            ),
            (
                "orAnthropicOpus",
                t("openrouter", "claude-code", Some("anthropic/claude-opus-4")),
            ),
            ("orOpenai", t("openrouter", "codex", Some("openai/gpt-6.1-sol"))),
            ("orGoogle", t("openrouter", "codex", Some("google/gemini-3-pro"))),
            ("chatgpt", t("chatgpt", "codex", Some("gpt-6-luna"))),
            ("openai", t("openai", "codex", Some("gpt-6.1-sol"))),
            ("local", t("local", "codex", Some("qwen3:32b"))),
        ]
    }

    fn target(name: &str) -> HandleTarget<'static> {
        targets()
            .into_iter()
            .find(|(n, _)| *n == name)
            .map(|(_, target)| target)
            .unwrap()
    }

    fn stored(name: &str, raw: &str) -> String {
        format(&target(name), raw).unwrap().unwrap()
    }

    #[test]
    fn the_claude_plan_stores_the_bare_raw_id_legacy_rows_need_no_rewrite() {
        assert_eq!(stored("claude", RAW), RAW);
        assert_eq!(stored("claudeStored", RAW), RAW);
    }

    #[test]
    fn every_other_provider_stores_provider_home_key_vendor_raw_id() {
        assert_eq!(stored("anthropic", RAW), format!("anthropic/cc/anthropic:{RAW}"));
        assert_eq!(stored("deepseek", RAW), format!("deepseek/cc/deepseek:{RAW}"));
        assert_eq!(stored("deepseekCodex", RAW), format!("deepseek/cx/deepseek:{RAW}"));
        assert_eq!(stored("orAnthropic", RAW), format!("openrouter/cc/anthropic:{RAW}"));
        assert_eq!(stored("orOpenai", RAW), format!("openrouter/cx/openai:{RAW}"));
        assert_eq!(stored("chatgpt", RAW), format!("chatgpt/cxd/chatgpt:{RAW}"));
        assert_eq!(stored("openai", RAW), format!("openai/cx/openai:{RAW}"));
        assert_eq!(stored("local", RAW), format!("local/cx/local:{RAW}"));
    }

    #[test]
    fn an_explicit_home_key_and_vendor_on_the_target_win() {
        let explicit = HandleTarget {
            provider: Some("openrouter"),
            home_key: Some("cx"),
            vendor: Some("Meta-Llama"),
            ..HandleTarget::default()
        };
        assert_eq!(
            format(&explicit, RAW).unwrap().unwrap(),
            format!("openrouter/cx/meta-llama:{RAW}")
        );
    }

    #[test]
    fn no_raw_id_means_no_handle() {
        assert_eq!(format(&target("deepseek"), "").unwrap(), None);
        assert_eq!(format(&target("claude"), None).unwrap(), None);
        assert_eq!(format(&target("deepseek"), "  \u{FEFF} ").unwrap(), None);
    }

    #[test]
    fn never_stores_a_handle_it_couldnt_read_back_a_raw_id_with_a_space_or_bare_a_slash_is_refused() {
        for (name, raw) in [
            ("deepseek", "a b"),
            ("openai", "tab\there"),
            ("claude", "x/y"),
            ("claude", "a b"),
        ] {
            let err = format(&target(name), raw).unwrap_err();
            assert!(err.0.contains("session-handle"), "{name} {raw}: {err}");
        }
        // A slash is fine inside a tagged handle: everything after the vendor's colon is the raw id.
        assert_eq!(untag(stored("deepseek", "x/y").as_str()).as_deref(), Some("x/y"));
    }

    #[test]
    fn round_trips_every_handle_it_stores_parses_back_to_the_same_raw_id_and_place() {
        let raws = [
            RAW,
            "thread:with:colons",
            "x/y",
            "a.b-c_d",
            "UPPER-Case-9",
            "~tilde",
            "été",
        ];
        let mut stored_some = 0;
        for (name, target) in targets() {
            for raw in raws {
                // Refused: never stored.
                let Ok(Some(handle)) = format(&target, raw) else {
                    continue;
                };
                stored_some += 1;
                let parsed = parse(handle.as_str()).unwrap_or_else(|| panic!("{name} {raw}: {handle} doesn't parse"));
                assert_eq!(parsed.raw_id, raw, "{name} {raw}");
                assert_eq!(
                    session_for(handle.as_str(), &target).as_deref(),
                    Some(raw),
                    "{name} {raw}: doesn't resume on its own target"
                );
            }
        }
        // Only the plan's bare "x/y" is refused: two targets, one raw id.
        assert_eq!(stored_some, targets().len() * raws.len() - 2);
    }

    #[test]
    fn a_provider_the_registry_doesnt_know_cant_be_placed_even_with_a_home_key() {
        let nobody = HandleTarget {
            provider: Some("nobody"),
            home_key: Some("cx"),
            ..HandleTarget::default()
        };
        let err = format(&nobody, RAW).unwrap_err();
        assert_eq!(
            err.0,
            "session-handle: can't place a session for \"nobody\" on undefined"
        );
    }

    #[test]
    fn vendor_for_the_maker_on_openrouter_without_the_tilde_otherwise_the_provider() {
        let vendor = |id: &str, model: &str| vendor_for(id, Some(model));
        assert_eq!(
            vendor("openrouter", "~anthropic/claude-sonnet-latest").as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            vendor("openrouter", "deepseek/deepseek-chat:free").as_deref(),
            Some("deepseek")
        );
        assert_eq!(vendor("openrouter", "OpenAI/gpt-6").as_deref(), Some("openai"));
        assert_eq!(vendor("openrouter", "auto").as_deref(), Some("openrouter"));
        assert_eq!(vendor("deepseek", "deepseek-flash[1m]").as_deref(), Some("deepseek"));
        assert_eq!(vendor("claude-code", "sonnet").as_deref(), Some("claude"));
    }

    /// test/provider-registry.test.js, "is the very function session handles use (one maker rule, not two)": the
    /// case package A1 left for this one.
    #[test]
    fn is_the_very_function_session_handles_use_one_maker_rule_not_two() {
        type VendorFor = fn(&str, Option<&str>) -> Option<String>;
        assert!(std::ptr::fn_addr_eq(
            vendor_for as VendorFor,
            provider_registry::vendor_for as VendorFor
        ));
        // And it is what a handle is made with: a maker the rule cleans is stored as the rule gives it.
        for model in ["Open AI/gpt-6", "a+b/c", "auto", "+++/x", "~Meta-Llama/llama-4"] {
            let target = t("openrouter", "codex", Some(model));
            let vendor = provider_registry::vendor_for("openrouter", Some(model)).unwrap();
            assert_eq!(
                format(&target, RAW).unwrap().unwrap(),
                format!("openrouter/cx/{vendor}:{RAW}"),
                "{model}"
            );
        }
    }

    #[test]
    fn parse_a_bare_id_is_the_claude_plans_a_tagged_one_splits_into_its_parts() {
        assert_eq!(
            serde_json::to_value(parse(RAW).unwrap()).unwrap(),
            serde_json::json!({ "provider": "claude", "engine": "claude-code", "homeKey": "cc", "vendor": "claude", "rawId": RAW, "tagged": false })
        );
        assert_eq!(
            serde_json::to_value(parse(format!("openrouter/cx/openai:{RAW}").as_str()).unwrap()).unwrap(),
            serde_json::json!({ "provider": "openrouter", "engine": "codex", "homeKey": "cx", "vendor": "openai", "rawId": RAW, "tagged": true })
        );
        assert_eq!(
            serde_json::to_value(parse(format!("chatgpt/cxd/chatgpt:{RAW}").as_str()).unwrap()).unwrap(),
            serde_json::json!({ "provider": "chatgpt", "engine": "codex", "homeKey": "cxd", "vendor": "chatgpt", "rawId": RAW, "tagged": true })
        );
        // The key order is the JS object's.
        assert_eq!(
            serde_json::to_string(&parse("abc").unwrap()).unwrap(),
            r#"{"provider":"claude","engine":"claude-code","homeKey":"cc","vendor":"claude","rawId":"abc","tagged":false}"#
        );
    }

    #[test]
    fn parse_nothing_or_a_malformed_tag_gives_null() {
        // (The JS list also had undefined and 42: not text, which a `&str` never is.)
        assert_eq!(parse(None), None);
        for bad in [
            "",
            "   ",
            "deepseek/zz/deepseek:abc",
            "deepseek/cc/deepseek:",
            "deepseek/cc:abc",
            "a/b",
            "has space",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn session_for_the_claude_plan_resumes_a_bare_id_and_never_a_tagged_one() {
        assert_eq!(session_for(RAW, &target("claude")).as_deref(), Some(RAW));
        assert_eq!(session_for(RAW, &target("claudeStored")).as_deref(), Some(RAW));
        assert_eq!(
            session_for(format!("deepseek/cc/deepseek:{RAW}").as_str(), &target("claude")),
            None
        );
        assert_eq!(
            session_for(format!("claude/cc/claude:{RAW}").as_str(), &target("claude")),
            None
        );
    }

    #[test]
    fn session_for_a_bare_id_is_foreign_to_every_other_provider() {
        for key in ["anthropic", "deepseek", "orAnthropic", "chatgpt", "openai", "local"] {
            assert_eq!(session_for(RAW, &target(key)), None, "{key}");
        }
    }

    #[test]
    fn session_for_the_same_provider_home_and_vendor_resume_a_foreign_provider_home_or_vendor_gives_null() {
        let resume = |handle: &str, name: &str| session_for(handle, &target(name));
        assert_eq!(resume(&stored("deepseek", RAW), "deepseek").as_deref(), Some(RAW));
        assert_eq!(
            resume(&stored("orAnthropic", RAW), "orAnthropicOpus").as_deref(),
            Some(RAW),
            "same maker, other model: resume"
        );
        assert_eq!(resume(&stored("deepseek", RAW), "anthropic"), None, "foreign provider");
        assert_eq!(
            resume(&stored("deepseek", RAW), "deepseekCodex"),
            None,
            "foreign home (engine switch)"
        );
        assert_eq!(
            resume(&stored("orAnthropic", RAW), "orOpenai"),
            None,
            "foreign home and vendor"
        );
        assert_eq!(
            resume(&format!("openrouter/cx/openai:{RAW}"), "orGoogle"),
            None,
            "foreign vendor, same home"
        );
        assert_eq!(
            resume(&format!("openai/cx/openai:{RAW}"), "chatgpt"),
            None,
            "foreign provider on Codex"
        );
        assert_eq!(
            resume(&format!("chatgpt/cx/chatgpt:{RAW}"), "chatgpt"),
            None,
            "the key home is foreign to the sign-in home"
        );
    }

    #[test]
    fn session_for_no_handle_or_a_target_it_cant_place_gives_null() {
        let handle = format!("deepseek/cc/deepseek:{RAW}");
        assert_eq!(session_for(None, &target("deepseek")), None);
        assert_eq!(session_for("", &target("claude")), None);
        assert_eq!(session_for(handle.as_str(), &HandleTarget::default()), None);
        let no_engine = HandleTarget {
            provider: Some("deepseek"),
            ..HandleTarget::default()
        };
        assert_eq!(session_for(handle.as_str(), &no_engine), None, "no engine or homeKey");
    }

    #[test]
    fn untag_round_trips_for_every_provider_and_leaves_a_bare_id_as_it_is() {
        for (name, target) in targets() {
            let handle = format(&target, RAW).unwrap().unwrap();
            assert_eq!(untag(handle.as_str()).as_deref(), Some(RAW), "{name}");
        }
        assert_eq!(untag(RAW).as_deref(), Some(RAW));
        let colons = "thread:with:colons";
        assert_eq!(untag(stored("openai", colons).as_str()).as_deref(), Some(colons));
        assert_eq!(
            session_for(stored("openai", colons).as_str(), &target("openai")).as_deref(),
            Some(colons)
        );
    }

    #[test]
    fn untag_nothing_or_a_malformed_tag_gives_null() {
        assert_eq!(untag(None), None);
        assert_eq!(untag(""), None);
        assert_eq!(untag("deepseek/zz/deepseek:abc"), None);
    }

    // --- What the JS suite left out ---

    #[test]
    fn a_turns_target_carries_its_own_home_key_and_vendor_into_the_handle() {
        let target = Target {
            provider: "openrouter".into(),
            engine: Some("codex".into()),
            model: Some("google/gemini-3-pro".into()),
            vendor: Some("google".into()),
            home_key: Some("cx".into()),
            ..Target::default()
        };
        let handle = format(&HandleTarget::from(&target), RAW).unwrap().unwrap();
        assert_eq!(handle, format!("openrouter/cx/google:{RAW}"));
        assert_eq!(
            session_for(handle.as_str(), &HandleTarget::from(&target)).as_deref(),
            Some(RAW)
        );
    }

    #[test]
    fn javascripts_whitespace_decides_what_a_raw_id_may_hold() {
        // A byte order mark is space to JavaScript (trimmed off the ends, refused inside); U+0085 is not.
        assert_eq!(parse("\u{FEFF}abc\u{FEFF}").unwrap().raw_id, "abc");
        assert_eq!(parse("a\u{FEFF}b"), None);
        assert_eq!(parse("a\u{0085}b").unwrap().raw_id, "a\u{0085}b");
        assert_eq!(parse("deepseek/cc/deepseek:a\u{0085}b").unwrap().raw_id, "a\u{0085}b");
        assert_eq!(parse("deepseek/cc/deepseek:a\u{A0}b"), None);
    }

    #[test]
    fn the_refusals_say_what_they_were_given_as_javascript_wrote_it() {
        let none = HandleTarget::default();
        assert_eq!(
            format(&none, RAW).unwrap_err().0,
            "session-handle: can't place a session for undefined on undefined"
        );
        assert_eq!(
            format(&t("deepseek", "nope", None), RAW).unwrap_err().0,
            "session-handle: can't place a session for \"deepseek\" on \"nope\""
        );
        let long = format!("{} {}", "a".repeat(50), "b");
        assert_eq!(
            format(&target("claude"), long.as_str()).unwrap_err().0,
            format!(
                "session-handle: a raw session id of that shape can't be stored (\"{}\")",
                "a".repeat(40)
            )
        );
        // An explicit vendor that cleans to nothing can't be placed; a provider in capitals is the same provider.
        let blank_vendor = HandleTarget {
            provider: Some("openrouter"),
            home_key: Some("cx"),
            vendor: Some("~+++"),
            ..HandleTarget::default()
        };
        assert!(format(&blank_vendor, RAW).is_err());
        assert_eq!(
            format(&t("DeepSeek", "claude-code", None), RAW).unwrap().unwrap(),
            format!("deepseek/cc/deepseek:{RAW}")
        );
        assert_eq!(format(&t("Claude-Code", "codex", None), RAW).unwrap().unwrap(), RAW);
    }
}
