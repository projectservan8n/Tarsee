//! Small pieces of JavaScript behaviour the port has to match, in one place.
//!
//! JavaScript strings are sequences of UTF-16 code units, so `text.length` and `text.slice(0, 2000)` count code
//! units: an emoji is 2. Rust strings are UTF-8 and count bytes. Wherever the Node version cut or measured text
//! that a person or another system sees (a Telegram message limit, a title cut to 200), use these so the cut lands
//! in the same place.

use chrono::{DateTime, SecondsFormat, Utc};

/// Whether JavaScript counts the character as whitespace (`String.prototype.trim`, and `\s` in a regular
/// expression). Rust's `char::is_whitespace` differs on two characters: it counts U+0085 (next line), which
/// JavaScript does not, and it does not count U+FEFF (the byte order mark), which JavaScript does.
pub fn is_whitespace(c: char) -> bool {
    c == '\u{FEFF}' || (c != '\u{0085}' && c.is_whitespace())
}

/// `text.trim()`. Use this, not `str::trim`, wherever the Node code trimmed text that comes from outside (a
/// message, a header, a file, a setting): the two differ on U+0085 and U+FEFF, and a file that starts with a byte
/// order mark is common.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `text.trimStart()`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_whitespace)
}

/// `text.trimEnd()`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_whitespace)
}

/// `text.length`: the number of UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(start, end)` for non-negative indexes, counted in UTF-16 code units. An index past the end means the
/// end. A cut that lands in the middle of a character outside the basic plane (an emoji) leaves that character out
/// rather than producing half of it.
pub fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    if end <= start {
        return String::new();
    }
    let mut out = String::new();
    let mut unit = 0usize;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if unit >= end {
            break;
        }
        if unit >= start && unit + width <= end {
            out.push(ch);
        }
        unit += width;
    }
    out
}

/// `text.slice(0, max)`: the first `max` UTF-16 code units.
pub fn utf16_truncate(text: &str, max: usize) -> String {
    utf16_slice(text, 0, max)
}

/// `text.slice(-count)`: the last `count` UTF-16 code units.
pub fn utf16_tail(text: &str, count: usize) -> String {
    let len = utf16_len(text);
    utf16_slice(text, len.saturating_sub(count), len)
}

/// `new Date(ms).toISOString()`: "2026-11-12T08:30:00.000Z". An unrepresentable moment gives the epoch.
pub fn iso_from_ms(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `Date.now()`: milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// `Date.parse(text)` for the ISO forms Tarsee writes ("2026-11-12T08:30:00.000Z", and SQLite's
/// "2026-11-12 08:30:00", which is UTC). `None` for anything else.
pub fn ms_from_iso(text: &str) -> Option<i64> {
    let text = text.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
        return Some(parsed.timestamp_millis());
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(text, format) {
            return Some(naive.and_utc().timestamp_millis());
        }
    }
    chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|n| n.and_utc().timestamp_millis())
}

/// `String(number)` for a JSON number: integers without a decimal point ("3", not "3.0"), others as the shortest
/// text that reads back the same.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n == n.trunc() && n.abs() < 1e21 {
        return format!("{}", n as i128);
    }
    format!("{n}")
}

/// JavaScript truthiness of a JSON value: false for null, false, 0, NaN and "", true for everything else
/// (including empty arrays and objects).
pub fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trim_removes_what_javascript_removes() {
        assert_eq!(trim("  \t\r\n x y \u{00A0}\u{3000}\u{2028}"), "x y");
        assert_eq!(trim("\u{FEFF}x\u{FEFF}"), "x");
        assert_eq!(trim("\u{0085}x\u{0085}"), "\u{0085}x\u{0085}");
        assert_eq!(trim_start(" \u{FEFF}x "), "x ");
        assert_eq!(trim_end(" x \u{FEFF}"), " x");
        assert_eq!(trim(""), "");
        assert!(is_whitespace('\u{FEFF}') && !is_whitespace('\u{0085}') && is_whitespace(' ') && !is_whitespace('x'));
    }

    #[test]
    fn length_counts_utf16_code_units() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("é"), 1);
        assert_eq!(utf16_len("🐒"), 2);
        assert_eq!(utf16_len("a🐒b"), 4);
    }

    #[test]
    fn slice_cuts_where_javascript_cuts() {
        assert_eq!(utf16_slice("hello world", 0, 5), "hello");
        assert_eq!(utf16_slice("hello world", 6, 99), "world");
        assert_eq!(utf16_slice("hello", 3, 2), "");
        assert_eq!(utf16_slice("a🐒b", 0, 3), "a🐒");
        assert_eq!(utf16_slice("a🐒b", 3, 4), "b");
    }

    #[test]
    fn a_cut_through_an_emoji_leaves_it_out() {
        assert_eq!(utf16_truncate("a🐒b", 2), "a");
        assert_eq!(utf16_slice("a🐒b", 2, 4), "b");
    }

    #[test]
    fn truncate_and_tail() {
        assert_eq!(utf16_truncate("abcdef", 4), "abcd");
        assert_eq!(utf16_truncate("abc", 10), "abc");
        assert_eq!(utf16_tail("abcdef", 2), "ef");
        assert_eq!(utf16_tail("abc", 10), "abc");
    }

    #[test]
    fn iso_text_matches_to_iso_string() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_794_472_200_123), "2026-11-12T08:30:00.123Z");
        assert!(now_iso().ends_with('Z'));
        assert_eq!(now_iso().len(), 24);
    }

    #[test]
    fn iso_and_sqlite_times_parse_as_utc() {
        assert_eq!(ms_from_iso("2026-11-12T08:30:00.123Z"), Some(1_794_472_200_123));
        assert_eq!(ms_from_iso("2026-11-12 08:30:00"), Some(1_794_472_200_000));
        assert_eq!(ms_from_iso("2026-11-12T10:30:00+02:00"), Some(1_794_472_200_000));
        assert_eq!(ms_from_iso("2026-11-12"), Some(1_794_441_600_000));
        assert_eq!(ms_from_iso("yesterday"), None);
    }

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        assert_eq!(number_to_string(3.0), "3");
        assert_eq!(number_to_string(-0.5), "-0.5");
        assert_eq!(number_to_string(1234567.0), "1234567");
        assert_eq!(number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_to_string(f64::NAN), "NaN");
    }

    #[test]
    fn truthiness_follows_javascript() {
        for falsy in [json!(null), json!(false), json!(0), json!("")] {
            assert!(!truthy(&falsy), "{falsy}");
        }
        for truthy_value in [json!(true), json!(1), json!("0"), json!([]), json!({})] {
            assert!(truthy(&truthy_value), "{truthy_value}");
        }
    }
}
