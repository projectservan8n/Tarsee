//! Port of `src/ai/context-limits.js`: how big the agent's Claude Code context may get before the CLI summarizes it
//! (auto-compact).
//!
//! Every model call re-reads the whole context from cache, and cache reads count toward the Claude subscription's
//! usage limit. On a long agentic job measured on TarseeMacOS (824 calls), a 300k window compacted at about 268k and
//! the context averaged 174k a call. At 180k the CLI compacts at about 148k: the average falls to about 117k, the extra
//! compactions add back about 11k a call, so cache reads drop by roughly a quarter. Recent turns stay verbatim through
//! a compaction, so the session carries on.
//!
//! TARSEE_COMPACT_WINDOW overrides it: a token count ("250000" or "150k"), or "off" for the CLI's own choice (the
//! model's full window). The CLI accepts 100k to 1M, and never more than the model's own window. With it unset, a
//! CLAUDE_CODE_AUTO_COMPACT_WINDOW the operator set is kept.
//!
//! The JS functions defaulted their argument to `process.env`; here the caller passes the [`Env`] (`app.env()`).
//!
//! This file also holds the few JavaScript string and number rules the A2 files need (`String.prototype.trim`, `\s`,
//! `Number(text)`, `Math.round`, `Math.min`), so a value read from the environment or a file is judged exactly as the
//! Node version judged it.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::env::Env;
use crate::util::js::number_to_string;

/// A set of environment variables to add to a program's environment.
pub type EnvMap = BTreeMap<String, String>;

pub const DEFAULT_COMPACT_WINDOW: u64 = 180_000;
pub const MIN_COMPACT_WINDOW: u64 = 100_000;
pub const MAX_COMPACT_WINDOW: u64 = 1_000_000;

/// The auto-compact window in tokens (`None`: "off", the CLI's own choice). `raw` is TARSEE_COMPACT_WINDOW's value.
pub fn compact_window_tokens(raw: Option<&str>) -> Option<u64> {
    let v = js_trim(raw.unwrap_or("")).to_lowercase();
    if v == "off" {
        return None;
    }
    let digits = v.strip_suffix('k').unwrap_or(&v);
    let mut n = js_number(digits) * if v.ends_with('k') { 1000.0 } else { 1.0 };
    if v.is_empty() || !n.is_finite() || n <= 0.0 {
        n = DEFAULT_COMPACT_WINDOW as f64;
    }
    let clamped = (MAX_COMPACT_WINDOW as f64).min((MIN_COMPACT_WINDOW as f64).max(n));
    Some(js_round(clamped) as u64)
}

/// The env each Claude Code process gets for its auto-compact window (empty for the CLI's default).
pub fn compact_window_env(raw: Option<&str>) -> EnvMap {
    match compact_window_tokens(raw) {
        None => EnvMap::new(),
        Some(n) => EnvMap::from([("CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(), n.to_string())]),
    }
}

/// The window a chat's context meter and Token Health measure against: the model's own, or the auto-compact window
/// when that is smaller (it is where the CLI summarizes the older part, so "full" means "about to be summarized").
pub fn effective_context_window(model_window: f64, env: &Env) -> f64 {
    let own = env_number(env, "CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    let tarsee = env.get("TARSEE_COMPACT_WINDOW");
    let compact = if tarsee.as_deref().is_some_and(|v| !js_trim(v).is_empty()) {
        compact_window_tokens(tarsee.as_deref()).map(|n| n as f64)
    } else if own.is_finite() && own > 0.0 {
        Some(own)
    } else {
        compact_window_tokens(Some("")).map(|n| n as f64)
    };
    match compact {
        Some(c) if c != 0.0 && !c.is_nan() => js_min(model_window, c),
        _ => model_window,
    }
}

/// Most characters of a Bash command's output the agent's context keeps (BASH_MAX_OUTPUT_LENGTH, which the CLI
/// reads): past it the CLI saves the whole output to a file and the agent gets a short preview plus the path. The
/// CLI's own default is 30000. Every output stays in the context, re-read on each later call until a compaction; on
/// that same measured job, 23 outputs over 8000 characters added about 88KB. TARSEE_BASH_OUTPUT_MAX_CHARS overrides
/// it; a BASH_MAX_OUTPUT_LENGTH already set is kept when it is unset.
pub const DEFAULT_BASH_OUTPUT_MAX_CHARS: u64 = 8000;

pub fn bash_output_env(env: &Env) -> EnvMap {
    let own = env_number(env, "TARSEE_BASH_OUTPUT_MAX_CHARS");
    if own.is_finite() && own > 0.0 {
        return EnvMap::from([("BASH_MAX_OUTPUT_LENGTH".to_string(), number_to_string(js_round(own)))]);
    }
    if env.is_set("BASH_MAX_OUTPUT_LENGTH") {
        return EnvMap::new();
    }
    EnvMap::from([(
        "BASH_MAX_OUTPUT_LENGTH".to_string(),
        DEFAULT_BASH_OUTPUT_MAX_CHARS.to_string(),
    )])
}

/// Most characters of one MCP tool's result (Tarsee's own tarsee_* tools and any other) the agent's context keeps.
/// Past it, Claude Code saves the whole result to a file in the session's folder and gives the agent the path and how
/// to read it, so nothing is lost and nothing partial can be written back by mistake. One list call on TarseeMacOS put
/// about 12k tokens in a session, re-read on dozens of later calls. Claude Code counts tokens (MAX_MCP_OUTPUT_TOKENS,
/// default 25000): a token is about 4 characters. TARSEE_TOOL_RESULT_MAX_CHARS overrides it; a MAX_MCP_OUTPUT_TOKENS
/// already set is kept when it is unset.
pub const DEFAULT_TOOL_RESULT_MAX_CHARS: u64 = 12_000;

pub fn mcp_output_env(env: &Env) -> EnvMap {
    let own = env_number(env, "TARSEE_TOOL_RESULT_MAX_CHARS");
    if own.is_finite() && own >= 1000.0 {
        return EnvMap::from([(
            "MAX_MCP_OUTPUT_TOKENS".to_string(),
            number_to_string((own / 4.0).ceil()),
        )]);
    }
    if env.is_set("MAX_MCP_OUTPUT_TOKENS") {
        return EnvMap::new();
    }
    EnvMap::from([(
        "MAX_MCP_OUTPUT_TOKENS".to_string(),
        DEFAULT_TOOL_RESULT_MAX_CHARS.div_ceil(4).to_string(),
    )])
}

/// What every Claude Code process the provider starts gets on top of the server's own environment.
pub fn cost_saver_env(env: &Env) -> EnvMap {
    // (An operator's own CLAUDE_CODE_AUTO_COMPACT_WINDOW stands when TARSEE_COMPACT_WINDOW is unset.)
    let tarsee = env.get("TARSEE_COMPACT_WINDOW");
    let tarsee_window = tarsee.as_deref().is_some_and(|v| !js_trim(v).is_empty());
    let mut out = if !tarsee_window && env.is_set("CLAUDE_CODE_AUTO_COMPACT_WINDOW") {
        EnvMap::new()
    } else {
        compact_window_env(tarsee.as_deref())
    };
    out.extend(bash_output_env(env));
    out.extend(mcp_output_env(env));
    out
}

/// `Number(env.NAME)`: NaN when the variable is unset.
fn env_number(env: &Env, name: &str) -> f64 {
    env.get(name).map_or(f64::NAN, |v| js_number(&v))
}

// --- JavaScript's rules for strings and numbers ------------------------------------------------------------------

/// JavaScript's whitespace (`\s`, and what `String.prototype.trim` removes): unlike Rust's, it includes the
/// byte-order mark U+FEFF and leaves out U+0085.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// The same set as a regex character class body, for patterns ported from JS that use `\s`.
pub(crate) const JS_SPACE_CLASS: &str =
    r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// What JavaScript's `.` matches without the `s` flag: anything but a line terminator.
pub(crate) const JS_DOT_CLASS: &str = r"[^\n\r\x{2028}\x{2029}]";

/// `text.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `text.trimStart()`.
pub(crate) fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

static DECIMAL_LITERAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").expect("a decimal pattern"));

/// `Number(text)`: surrounding whitespace ignored, empty is 0, `0x`/`0o`/`0b` integers, decimals with an optional sign
/// and exponent, `Infinity`; anything else (`"12abc"`, `"1_000"`, `"inf"`) is NaN.
pub(crate) fn js_number(text: &str) -> f64 {
    let s = js_trim(text);
    if s.is_empty() {
        return 0.0;
    }
    let bytes = s.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let mut value = 0.0f64;
            for c in s[2..].chars() {
                match c.to_digit(radix) {
                    Some(d) => value = value * f64::from(radix) + f64::from(d),
                    None => return f64::NAN,
                }
            }
            return value;
        }
    }
    let (sign, rest) = match bytes[0] {
        b'+' => (1.0, &s[1..]),
        b'-' => (-1.0, &s[1..]),
        _ => (1.0, s),
    };
    if rest == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !DECIMAL_LITERAL.is_match(rest) {
        return f64::NAN;
    }
    rest.parse::<f64>().map_or(f64::NAN, |v| sign * v)
}

/// `Math.round(x)`: to the nearest integer, a tie going up (so -2.5 is -2).
pub(crate) fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Math.min(a, b)`: NaN when either is NaN (Rust's `min` would return the other).
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        Env::from_pairs(pairs.iter().copied())
    }

    fn map(pairs: &[(&str, &str)]) -> EnvMap {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    // The context-limits cases of test/token-diet.test.js (its other cases belong to other files).

    #[test]
    fn compact_window_env_defaults_to_180k() {
        assert_eq!(DEFAULT_COMPACT_WINDOW, 180_000);
        let want = map(&[("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "180000")]);
        assert_eq!(compact_window_env(None), want);
        assert_eq!(compact_window_env(Some("")), want);
        assert_eq!(compact_window_env(Some("nonsense")), want);
    }

    #[test]
    fn compact_window_env_takes_a_count_or_thousands_clamped_to_what_the_cli_accepts() {
        let w = |raw| compact_window_env(Some(raw))["CLAUDE_CODE_AUTO_COMPACT_WINDOW"].clone();
        assert_eq!(w("250000"), "250000");
        assert_eq!(w("150k"), "150000");
        assert_eq!(w("20000"), "100000");
        assert_eq!(w("5000000"), "1000000");
    }

    #[test]
    fn compact_window_env_off_leaves_the_cli_its_own_choice() {
        assert_eq!(compact_window_env(Some("off")), EnvMap::new());
        assert_eq!(compact_window_env(Some(" OFF ")), EnvMap::new());
        assert_eq!(compact_window_tokens(Some("off")), None);
    }

    #[test]
    fn compact_window_tokens_reads_numbers_as_javascript_does() {
        // Number() rules: hex, exponents, a sign, surrounding whitespace; a negative or a non-number is the default.
        assert_eq!(compact_window_tokens(Some("0x30d40")), Some(200_000));
        assert_eq!(compact_window_tokens(Some("2.5e5")), Some(250_000));
        assert_eq!(compact_window_tokens(Some("+300000")), Some(300_000));
        assert_eq!(compact_window_tokens(Some("\u{FEFF} 120k\t")), Some(120_000));
        assert_eq!(compact_window_tokens(Some("12 k")), Some(100_000));
        assert_eq!(compact_window_tokens(Some("150000.5")), Some(150_001));
        for odd in ["-5", "0", "inf", "Infinity", "1_000", "12abc", "k", "NaN"] {
            assert_eq!(compact_window_tokens(Some(odd)), Some(180_000), "{odd}");
        }
    }

    #[test]
    fn bash_output_env_8000_by_default_overridable_and_an_operator_value_kept() {
        assert_eq!(bash_output_env(&env(&[])), map(&[("BASH_MAX_OUTPUT_LENGTH", "8000")]));
        assert_eq!(
            bash_output_env(&env(&[("TARSEE_BASH_OUTPUT_MAX_CHARS", "20000")])),
            map(&[("BASH_MAX_OUTPUT_LENGTH", "20000")])
        );
        assert_eq!(
            bash_output_env(&env(&[("BASH_MAX_OUTPUT_LENGTH", "15000")])),
            EnvMap::new()
        );
        assert_eq!(
            bash_output_env(&env(&[
                ("BASH_MAX_OUTPUT_LENGTH", "15000"),
                ("TARSEE_BASH_OUTPUT_MAX_CHARS", "9000")
            ])),
            map(&[("BASH_MAX_OUTPUT_LENGTH", "9000")])
        );
        assert_eq!(
            bash_output_env(&env(&[("TARSEE_BASH_OUTPUT_MAX_CHARS", "9000.5")])),
            map(&[("BASH_MAX_OUTPUT_LENGTH", "9001")])
        );
    }

    #[test]
    fn mcp_output_env_3000_tokens_by_default_from_characters() {
        assert_eq!(mcp_output_env(&env(&[])), map(&[("MAX_MCP_OUTPUT_TOKENS", "3000")]));
        assert_eq!(
            mcp_output_env(&env(&[("TARSEE_TOOL_RESULT_MAX_CHARS", "30000")])),
            map(&[("MAX_MCP_OUTPUT_TOKENS", "7500")])
        );
        assert_eq!(
            mcp_output_env(&env(&[("TARSEE_TOOL_RESULT_MAX_CHARS", "12")])),
            map(&[("MAX_MCP_OUTPUT_TOKENS", "3000")]),
            "too small to be meant"
        );
        assert_eq!(
            mcp_output_env(&env(&[("MAX_MCP_OUTPUT_TOKENS", "10000")])),
            EnvMap::new()
        );
        assert_eq!(
            mcp_output_env(&env(&[("TARSEE_TOOL_RESULT_MAX_CHARS", "1001")])),
            map(&[("MAX_MCP_OUTPUT_TOKENS", "251")])
        );
    }

    #[test]
    fn cost_saver_env_all_three_and_an_operator_window_stands() {
        assert_eq!(
            cost_saver_env(&env(&[])),
            map(&[
                ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "180000"),
                ("BASH_MAX_OUTPUT_LENGTH", "8000"),
                ("MAX_MCP_OUTPUT_TOKENS", "3000")
            ])
        );
        assert_eq!(
            cost_saver_env(&env(&[("TARSEE_COMPACT_WINDOW", "off")])),
            map(&[("BASH_MAX_OUTPUT_LENGTH", "8000"), ("MAX_MCP_OUTPUT_TOKENS", "3000")])
        );
        assert_eq!(
            cost_saver_env(&env(&[("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "400000")]))
                .get("CLAUDE_CODE_AUTO_COMPACT_WINDOW"),
            None,
            "not overridden: the server's environment carries it"
        );
        assert_eq!(
            cost_saver_env(&env(&[
                ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "400000"),
                ("TARSEE_COMPACT_WINDOW", "200k")
            ]))["CLAUDE_CODE_AUTO_COMPACT_WINDOW"],
            "200000"
        );
        assert_eq!(
            cost_saver_env(&env(&[("TARSEE_COMPACT_WINDOW", "  ")]))["CLAUDE_CODE_AUTO_COMPACT_WINDOW"],
            "180000",
            "a blank TARSEE_COMPACT_WINDOW is unset"
        );
    }

    #[test]
    fn effective_context_window_is_the_smaller_of_the_model_and_the_compact_window() {
        assert_eq!(effective_context_window(1_000_000.0, &env(&[])), 180_000.0);
        assert_eq!(effective_context_window(200_000.0, &env(&[])), 180_000.0);
        assert_eq!(
            effective_context_window(1_000_000.0, &env(&[("TARSEE_COMPACT_WINDOW", "off")])),
            1_000_000.0
        );
        assert_eq!(
            effective_context_window(1_000_000.0, &env(&[("TARSEE_COMPACT_WINDOW", "300k")])),
            300_000.0
        );
        assert_eq!(
            effective_context_window(200_000.0, &env(&[("TARSEE_COMPACT_WINDOW", "300k")])),
            200_000.0
        );
        assert_eq!(
            effective_context_window(1_000_000.0, &env(&[("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "400000")])),
            400_000.0,
            "the operator's own"
        );
        assert_eq!(
            effective_context_window(1_000_000.0, &env(&[("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "-3")])),
            180_000.0
        );
        assert!(
            effective_context_window(f64::NAN, &env(&[])).is_nan(),
            "Math.min passes NaN on"
        );
    }

    #[test]
    fn javascript_number_trim_and_round_rules() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("  12  "), 12.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("0b101"), 5.0);
        assert_eq!(js_number("0o17"), 15.0);
        assert_eq!(js_number(".5"), 0.5);
        assert_eq!(js_number("5."), 5.0);
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        for nan in ["0x", "-0x10", "1e", "e5", ".", "inf", "nan", "infinity", "1,000", "--1"] {
            assert!(js_number(nan).is_nan(), "{nan}");
        }
        assert_eq!(js_trim("\u{FEFF}\u{A0} x \u{3000}"), "x");
        assert_eq!(js_trim("\u{85}x"), "\u{85}x", "NEL is not JavaScript whitespace");
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert!(js_min(1.0, f64::NAN).is_nan());
    }
}
