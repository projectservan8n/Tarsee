//! Port of `src/lib/reaction-parser.js`: the agent's reaction markers.
//!
//! Detects [react: emoji] markers in AI responses, strips them, and returns the emojis for the channel to apply as
//! reactions.
//!
//! Also detects [buttons: ...] markers for inline button support.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::lib::discord_format::js_text::{re, trim};
use crate::util::js::truthy;

static REACT_PATTERN: LazyLock<Regex> = LazyLock::new(|| re(r"\[react:\s*([^\]]+)\]"));
static BUTTONS_PATTERN: LazyLock<Regex> = LazyLock::new(|| re(r"\[buttons:\s*(\[[\s\S]*?\])\]"));
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));

/// One inline button the model asked for. The values are what the model wrote (`b.text || b.label || "?"`), so a
/// number stays a number, as it did in the Node version; a button given as a plain string has string values.
#[derive(Debug, Clone, PartialEq)]
pub struct Button {
    pub text: Value,
    pub data: Value,
}

/// What [`parse_reactions`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedReactions {
    /// The text without the markers, trimmed.
    pub clean_text: String,
    /// The emoji of each [react: ...] marker, in order.
    pub reactions: Vec<String>,
    /// The buttons of the [buttons: [...]] marker, or `None` when there was none or it was not a JSON array.
    pub buttons: Option<Vec<Button>>,
}

/// The first of `keys` with a truthy value (`b.text || b.label || "?"`), else `fallback`.
fn first_truthy(button: &Map<String, Value>, keys: &[&str], fallback: &str) -> Value {
    keys.iter()
        .filter_map(|k| button.get(*k))
        .find(|v| truthy(v))
        .cloned()
        .unwrap_or_else(|| Value::String(fallback.into()))
}

/// Parse and strip reaction markers from AI response text.
pub fn parse_reactions(text: &str) -> ParsedReactions {
    if text.is_empty() {
        return ParsedReactions {
            clean_text: String::new(),
            reactions: Vec::new(),
            buttons: None,
        };
    }

    // Extract [react: emoji] markers
    let reactions: Vec<String> = REACT_PATTERN
        .captures_iter(text)
        .map(|c| trim(&c[1]).to_string())
        .filter(|emoji| !emoji.is_empty())
        .collect();

    // Strip reaction markers from text
    let mut clean_text = trim(&REACT_PATTERN.replace_all(text, "")).to_string();

    // Extract [buttons: [...]] marker
    let mut buttons = None;
    if let Some(m) = BUTTONS_PATTERN.captures(&clean_text) {
        // Invalid JSON, or an entry that is null (the JS `b.text` on null threw): no buttons.
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&m[1]) {
            buttons = items
                .iter()
                .map(|b| match b {
                    Value::String(label) => Some(Button {
                        text: Value::String(label.clone()),
                        data: Value::String(WS_RUN.replace_all(&label.to_lowercase(), "_").into_owned()),
                    }),
                    Value::Null => None,
                    Value::Object(fields) => Some(Button {
                        text: first_truthy(fields, &["text", "label"], "?"),
                        data: first_truthy(fields, &["data", "value", "text"], "?"),
                    }),
                    _ => Some(Button {
                        text: Value::String("?".into()),
                        data: Value::String("?".into()),
                    }),
                })
                .collect::<Option<Vec<_>>>();
        }
        clean_text = trim(&BUTTONS_PATTERN.replace(&clean_text, "")).to_string();
    }

    ParsedReactions {
        clean_text,
        reactions,
        buttons,
    }
}

#[cfg(test)]
mod tests {
    //! No Node test file covers this module; the expected values were printed by the Node code
    //! (`src/lib/reaction-parser.js`) for the same input.
    use super::*;
    use serde_json::json;

    fn button(text: Value, data: Value) -> Button {
        Button { text, data }
    }

    #[test]
    fn reaction_markers_are_taken_out_and_listed() {
        let p = parse_reactions("Done! [react: ✅] All good [react:🎉]\n");
        assert_eq!(p.clean_text, "Done!  All good");
        assert_eq!(p.reactions, vec!["✅", "🎉"]);
        assert_eq!(p.buttons, None);
    }

    #[test]
    fn empty_text_has_nothing() {
        let p = parse_reactions("");
        assert_eq!(p.clean_text, "");
        assert!(p.reactions.is_empty());
        assert_eq!(p.buttons, None);
    }

    #[test]
    fn an_empty_or_blank_marker_is_dropped_but_still_taken_out() {
        let p = parse_reactions("a [react:   ] b [react: \n👍\n] c");
        assert_eq!(p.clean_text, "a  b  c");
        assert_eq!(p.reactions, vec!["👍"]);
    }

    #[test]
    fn buttons_from_strings_and_objects() {
        let p = parse_reactions(
            r#"Pick one [buttons: ["Option A", "Yes  Please", {"label": "L", "value": "v"}, {"text": "T"}, {}, 5]]"#,
        );
        assert_eq!(p.clean_text, "Pick one");
        assert_eq!(
            p.buttons,
            Some(vec![
                button(json!("Option A"), json!("option_a")),
                button(json!("Yes  Please"), json!("yes_please")),
                button(json!("L"), json!("v")),
                button(json!("T"), json!("T")),
                button(json!("?"), json!("?")),
                button(json!("?"), json!("?")),
            ])
        );
    }

    #[test]
    fn a_button_value_that_is_not_text_is_kept_as_written() {
        let p = parse_reactions(r#"x [buttons: [{"text": 7, "data": true}]]"#);
        assert_eq!(p.buttons, Some(vec![button(json!(7), json!(true))]));
    }

    #[test]
    fn bad_buttons_are_ignored_but_the_marker_still_goes() {
        let p = parse_reactions("x [buttons: [not json]] y");
        assert_eq!(p.clean_text, "x  y");
        assert_eq!(p.buttons, None);
        let p = parse_reactions(r#"x [buttons: ["a", null]]"#);
        assert_eq!(p.clean_text, "x");
        assert_eq!(p.buttons, None);
    }

    #[test]
    fn only_the_first_buttons_marker_is_read() {
        let p = parse_reactions(r#"[buttons: ["a"]] mid [buttons: ["b"]]"#);
        assert_eq!(p.clean_text, r#"mid [buttons: ["b"]]"#);
        assert_eq!(p.buttons, Some(vec![button(json!("a"), json!("a"))]));
    }
}
