//! Port of `src/config/constants.js`: the Claude model registry, background-work budget, size limits and WebSocket
//! close codes.
//!
//! One thing lives elsewhere: the JS file re-exported `AI_PROVIDERS` from `ai/provider-registry.js`. Rust needs no
//! re-export to break that import cycle, so use `crate::ai::provider_registry::AI_PROVIDERS` directly.

/// One row of the Claude model registry.
///
/// TIER ORDER: fable > opus > sonnet > haiku, capability-descending. Anything that escalates or de-escalates a model
/// reads [`MODEL_TIERS`] rather than hardcoding names.
///
/// WHY ALIASES ARE FIRST: the registry once pinned a version as the default, newer models shipped and the pin never
/// moved, so every session silently ran releases behind. An alias default makes that impossible; pinned rows remain
/// for anyone who needs a frozen model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModel {
    /// Canonical API model ID used in every request.
    pub id: &'static str,
    /// What shows in the Settings dropdown.
    pub display_name: &'static str,
    /// fable | opus | sonnet | haiku.
    pub tier: &'static str,
    /// Human-readable context window size for the UI hint.
    pub context: &'static str,
    /// Exactly one entry is true: the default when nothing else is configured.
    pub recommended: bool,
    /// YYYY-MM; picks "latest" when a tier has several models. Alias rows have none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub released: Option<&'static str>,
    /// True for the bare tier names, which Claude Code resolves to the newest model in that tier.
    #[serde(skip_serializing_if = "is_false")]
    pub alias: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

const fn alias(
    id: &'static str,
    display_name: &'static str,
    tier: &'static str,
    context: &'static str,
    recommended: bool,
) -> ClaudeModel {
    ClaudeModel {
        id,
        display_name,
        tier,
        context,
        recommended,
        released: None,
        alias: true,
    }
}

const fn pinned(
    id: &'static str,
    display_name: &'static str,
    tier: &'static str,
    context: &'static str,
    released: &'static str,
) -> ClaudeModel {
    ClaudeModel {
        id,
        display_name,
        tier,
        context,
        recommended: false,
        released: Some(released),
        alias: false,
    }
}

/// Single source of truth for every Claude model Tarsee exposes. Adding a model is one row here.
pub const CLAUDE_MODELS: &[ClaudeModel] = &[
    // Aliases: always the latest model in that tier. The default lives here.
    alias("opus", "Opus · latest", "opus", "1M", false),
    alias("sonnet", "Sonnet · latest", "sonnet", "1M", true),
    alias("haiku", "Haiku · latest", "haiku", "200K", false),
    alias("fable", "Fable · latest", "fable", "1M", false),
    // Pinned versions: opt in for reproducibility.
    pinned("claude-fable-5-1", "Claude Fable 5.1", "fable", "1M", "2026-08"),
    pinned("claude-fable-5", "Claude Fable 5", "fable", "1M", "2026-05"),
    pinned("claude-opus-5", "Claude Opus 5", "opus", "1M", "2026-04"),
    pinned("claude-opus-4-8", "Claude Opus 4.8", "opus", "1M", "2026-02"),
    pinned("claude-opus-4-7", "Claude Opus 4.7", "opus", "1M", "2026-01"),
    pinned("claude-opus-4-6", "Claude Opus 4.6", "opus", "1M", "2025-10"),
    pinned("claude-sonnet-5", "Claude Sonnet 5", "sonnet", "1M", "2026-04"),
    pinned("claude-sonnet-4-6", "Claude Sonnet 4.6", "sonnet", "1M", "2025-10"),
    pinned("claude-haiku-4-5", "Claude Haiku 4.5", "haiku", "200K", "2025-10"),
];

/// The registry row with this exact id (`CLAUDE_MODELS_BY_ID[id]`).
pub fn claude_model_by_id(id: &str) -> Option<&'static ClaudeModel> {
    CLAUDE_MODELS.iter().find(|m| m.id == id)
}

/// Tiers in capability-descending order.
pub const MODEL_TIERS: &[&str] = &["fable", "opus", "sonnet", "haiku"];

/// The default model when nothing else is configured.
pub fn get_recommended_model() -> &'static str {
    CLAUDE_MODELS
        .iter()
        .find(|m| m.recommended)
        .unwrap_or(&CLAUDE_MODELS[0])
        .id
}

/// Resolves a tier shorthand (opus / sonnet / haiku) or a partial match to a model id.
///
/// An exact id or bare tier alias is honoured as typed. A tier name gives the tier's alias row, else its newest pin.
/// A partial match ("opus-4-6") gives the SHORTEST id containing it, so "fable-5" is claude-fable-5 and not
/// claude-fable-5-1: someone pinning a version wants the version they typed.
pub fn resolve_model_alias(alias: &str) -> Option<&'static str> {
    let a = crate::util::js::trim(alias).to_lowercase();
    if a.is_empty() {
        return None;
    }
    if let Some(exact) = claude_model_by_id(&a) {
        return Some(exact.id);
    }
    let tier: Vec<&ClaudeModel> = CLAUDE_MODELS.iter().filter(|m| m.tier == a).collect();
    if !tier.is_empty() {
        if let Some(row) = tier.iter().find(|m| m.alias) {
            return Some(row.id);
        }
        // Newest first; a stable sort, so equal dates keep registry order as in JS.
        let mut by_release = tier.clone();
        by_release.sort_by(|x, y| y.released.unwrap_or("").cmp(x.released.unwrap_or("")));
        return Some(by_release[0].id);
    }
    let mut subs: Vec<&ClaudeModel> = CLAUDE_MODELS.iter().filter(|m| m.id.contains(a.as_str())).collect();
    subs.sort_by_key(|m| m.id.len());
    subs.first().map(|m| m.id)
}

/// Whether the id is in the registry, for allowlist checks.
pub fn is_known_model(id: &str) -> bool {
    claude_model_by_id(id).is_some()
}

/// The tier a model id belongs to. Falls back to reading the id, so a brand-new `claude-fable-6` still gets a Fable
/// badge the day it ships.
pub fn tier_of(model_id: &str) -> Option<&'static str> {
    let id = crate::util::js::trim(model_id).to_lowercase();
    if id.is_empty() {
        return None;
    }
    if let Some(known) = claude_model_by_id(&id) {
        return Some(known.tier);
    }
    MODEL_TIERS.iter().copied().find(|t| id.contains(t))
}

/// Background work budget. Cron jobs, the heartbeat and the boot checklist run with nobody watching, so each gets a
/// cheap default model, a hard timeout, a turn cap and a dollar ceiling. These are the floor; every value can be
/// overridden per call.
pub mod background_defaults {
    /// Bare tier alias, so the floor tracks the newest Haiku without edits.
    pub const MODEL: &str = "haiku";
    /// A background turn that has produced nothing in this long is wedged.
    pub const TIMEOUT_MS: u64 = 120_000;
    /// Scheduled work should be a handful of tool calls, not a 50-turn agent loop.
    pub const MAX_TURNS: u32 = 12;
    /// Spend ceiling; bounds a runaway loop and is the only ceiling when an API key is set.
    pub const MAX_BUDGET_USD: f64 = 0.5;
    /// The boot checklist gets a little more room: it runs once per deploy.
    pub const BOOT_TIMEOUT_MS: u64 = 180_000;
}

/// Size limits.
pub mod limits {
    /// "50mb" in the JS (`express.json({ limit })`).
    pub const JSON_BODY_MAX_BYTES: usize = 50 * 1024 * 1024;
    pub const CMD_OUTPUT_MAX_BYTES: usize = 512 * 1024;
    pub const FILE_READ_MAX_BYTES: usize = 2 * 1024 * 1024;
    /// Per file.
    pub const UPLOAD_MAX_BYTES: usize = 50 * 1024 * 1024;
    pub const VOICE_SAMPLE_MAX_BYTES: usize = 25 * 1024 * 1024;
    pub const MAX_CONVERSATION_TITLE: usize = 200;
    /// In characters.
    pub const MAX_MESSAGE_LENGTH: usize = 100_000;
    /// Attempts per window.
    pub const RATE_LIMIT_AUTH_MAX: u32 = 10;
    pub const RATE_LIMIT_AUTH_WINDOW_MS: u64 = 60_000;
}

/// WebSocket close codes.
pub mod ws_codes {
    pub const NORMAL: u16 = 1000;
    pub const GOING_AWAY: u16 = 1001;
    pub const AUTH_FAILED: u16 = 4001;
    pub const RATE_LIMITED: u16 = 4029;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_one_model_is_recommended_and_it_is_the_sonnet_alias() {
        assert_eq!(CLAUDE_MODELS.iter().filter(|m| m.recommended).count(), 1);
        assert_eq!(get_recommended_model(), "sonnet");
    }

    #[test]
    fn an_exact_id_or_a_tier_name_resolves_to_itself() {
        assert_eq!(resolve_model_alias("opus"), Some("opus"));
        assert_eq!(resolve_model_alias("  Sonnet "), Some("sonnet"));
        assert_eq!(resolve_model_alias("claude-opus-4-7"), Some("claude-opus-4-7"));
    }

    #[test]
    fn a_partial_match_prefers_the_shortest_id() {
        assert_eq!(resolve_model_alias("fable-5"), Some("claude-fable-5"));
        assert_eq!(resolve_model_alias("opus-4-6"), Some("claude-opus-4-6"));
        assert_eq!(resolve_model_alias("haiku-4"), Some("claude-haiku-4-5"));
    }

    #[test]
    fn names_are_trimmed_the_way_javascript_trims() {
        // U+FEFF is whitespace to JavaScript and is trimmed; U+0085 is not, so the name no longer matches exactly
        // and falls through to the partial match, as in the Node code.
        assert_eq!(resolve_model_alias("\u{FEFF}opus\u{FEFF}"), Some("opus"));
        assert_eq!(resolve_model_alias("opus\u{0085}"), None);
        assert_eq!(tier_of("\u{FEFF}claude-opus-5 "), Some("opus"));
    }

    #[test]
    fn nothing_resolves_from_blank_or_unknown_input() {
        assert_eq!(resolve_model_alias(""), None);
        assert_eq!(resolve_model_alias("   "), None);
        assert_eq!(resolve_model_alias("gpt-9"), None);
    }

    #[test]
    fn tier_of_reads_the_registry_then_the_id() {
        assert_eq!(tier_of("claude-sonnet-5"), Some("sonnet"));
        assert_eq!(tier_of("claude-fable-6"), Some("fable"));
        assert_eq!(tier_of("CLAUDE-OPUS-9"), Some("opus"));
        assert_eq!(tier_of("gpt-6"), None);
        assert_eq!(tier_of(""), None);
    }

    #[test]
    fn known_models_are_the_registry_ids() {
        assert!(is_known_model("haiku"));
        assert!(is_known_model("claude-fable-5-1"));
        assert!(!is_known_model("claude-fable-6"));
    }

    #[test]
    fn a_model_row_serialises_with_the_javascript_field_names() {
        let json = serde_json::to_value(CLAUDE_MODELS[1]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"id": "sonnet", "displayName": "Sonnet · latest", "tier": "sonnet", "context": "1M", "recommended": true, "alias": true})
        );
        let pinned = serde_json::to_value(CLAUDE_MODELS[4]).unwrap();
        assert_eq!(pinned["released"], "2026-08");
        assert!(pinned.get("alias").is_none());
    }
}
