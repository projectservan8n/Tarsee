//! Port of `src/channels/turn-notes.js`.
//!
//! What a chat channel (Telegram, Discord, Slack, WhatsApp, email) tells the person when a turn ends without a whole
//! answer, and when a voice note can't be transcribed. One wording for every channel.
//!
//! The AI is named the way the turn layer's route event names it (`ai/turn.rs`: the model's label, "Claude Sonnet",
//! "DeepSeek Flash"), whichever AI the turn ran on, or "The AI" before that event came. The turn layer's errors are
//! already in plain words (what went wrong and, when there is one, what to do), so they are passed on as they are.

use serde_json::Value;

use crate::util::js::{number_to_string, utf16_len, utf16_truncate};

/// The two names a turn's route event carries, as these notes read them (`route.label`, `route.providerLabel`).
/// Implemented for the event as JSON; the turn layer's own route type implements it too.
pub trait RouteLabels {
    /// The model's label ("Claude Sonnet"), if the event has one.
    fn label(&self) -> Option<&str>;
    /// The provider's label ("Claude"), if the event has one.
    fn provider_label(&self) -> Option<&str>;
}

impl RouteLabels for Value {
    fn label(&self) -> Option<&str> {
        self.get("label").and_then(Value::as_str)
    }

    fn provider_label(&self) -> Option<&str> {
        self.get("providerLabel").and_then(Value::as_str)
    }
}

/// The AI's name for the person, from the turn's route event.
pub fn ai_name<R: RouteLabels + ?Sized>(route: Option<&R>) -> String {
    let named = |name: Option<&str>| name.filter(|n| !n.is_empty()).map(str::to_string);
    route
        .and_then(|r| named(r.label()).or_else(|| named(r.provider_label())))
        .unwrap_or_else(|| "The AI".into())
}

/// How [`turn_error_note`] words the note for one channel.
#[derive(Debug, Clone, Copy)]
pub struct TurnErrorOptions<'a> {
    /// How /clear is typed in this channel ("/clear"; in Slack, "reply `@tarsee /clear`").
    pub clear_hint: &'a str,
    /// No emoji (email).
    pub plain: bool,
}

impl Default for TurnErrorOptions<'_> {
    fn default() -> Self {
        TurnErrorOptions {
            clear_hint: "/clear",
            plain: false,
        }
    }
}

/// An error the turn reported, as the channel says it.
pub fn turn_error_note<R: RouteLabels + ?Sized>(
    route: Option<&R>,
    message: &str,
    opts: TurnErrorOptions<'_>,
) -> String {
    let message = if message.is_empty() {
        "something went wrong"
    } else {
        message
    };
    let said = clip(message.trim(), 600);
    format!(
        "{}{} ran into a problem: {said}\n\nTry again — if it keeps happening, {} and try fresh.",
        if opts.plain { "" } else { "⚠️ " },
        ai_name(route),
        opts.clear_hint,
    )
}

/// A turn that went quiet for too long and was given up (the channels' idle watchdog, `lib/turn_watchdog.rs` for the
/// external API and ACP). plain: no emoji (an API's answer).
pub fn idle_note<R: RouteLabels + ?Sized>(route: Option<&R>, idle_ms: f64, plain: bool) -> String {
    // Math.max(1, Math.round(idleMs / 60_000) || 1). `round` rounds a half away from zero where Math.round rounds it
    // up; the two differ only below zero, where the answer is 1 either way. NaN and 0 become 1.
    let rounded = (idle_ms / 60_000.0).round();
    let minutes = if rounded.is_nan() || rounded == 0.0 {
        1.0
    } else {
        rounded.max(1.0)
    };
    format!(
        "{}{} stopped responding ({} min idle). Try again — maybe with a smaller ask.",
        if plain { "" } else { "⚠️ " },
        ai_name(route),
        number_to_string(minutes),
    )
}

/// Whether an error still has to be said after the answer. Not when the answer already says it: the turn layer's
/// refusals ("Tarsee isn't connected to an AI yet...") are the reply and the error at once.
pub fn error_still_to_say(answer: &str, message: &str) -> bool {
    if message.is_empty() {
        return false;
    }
    !answer.contains(message.trim())
}

/// What a person can do about a voice note that wasn't transcribed: the transcriber's own words when it says what to
/// set up (`voice/stt_handler.rs`: "stt-unavailable", "stt-failed"), else `None` (the channel's own wording then).
/// Takes the error's code and message.
pub fn stt_problem(code: Option<&str>, message: &str) -> Option<String> {
    if !matches!(code, Some("stt-unavailable" | "stt-failed")) {
        return None;
    }
    let said = message.trim();
    if said.is_empty() { None } else { Some(said.to_string()) }
}

/// The text cut to `max` UTF-16 units, the last one an ellipsis. A cut through an emoji leaves the emoji out (the
/// Node code left half of it).
fn clip(text: &str, max: usize) -> String {
    if utf16_len(text) > max {
        format!("{}…", utf16_truncate(text, max - 1))
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    //! No Node test file covers this module; the expected text below was printed by the Node code
    //! (`src/channels/turn-notes.js`) for the same calls.
    use super::*;
    use serde_json::json;

    const NONE: Option<&Value> = None;

    #[test]
    fn the_ai_is_named_by_its_label_then_its_providers_label_then_the_ai() {
        assert_eq!(ai_name(NONE), "The AI");
        assert_eq!(
            ai_name(Some(&json!({ "label": "", "providerLabel": "Claude" }))),
            "Claude"
        );
        assert_eq!(
            ai_name(Some(&json!({ "label": "Claude Sonnet", "providerLabel": "Claude" }))),
            "Claude Sonnet"
        );
        assert_eq!(ai_name(Some(&json!({}))), "The AI");
    }

    #[test]
    fn a_turn_error_is_said_in_the_channels_words() {
        assert_eq!(
            turn_error_note(NONE, "", TurnErrorOptions::default()),
            "⚠️ The AI ran into a problem: something went wrong\n\nTry again — if it keeps happening, /clear and try fresh."
        );
        assert_eq!(
            turn_error_note(
                Some(&json!({ "label": "DeepSeek Flash" })),
                "  The key was turned down.  ",
                TurnErrorOptions {
                    clear_hint: "reply `@tarsee /clear`",
                    ..Default::default()
                }
            ),
            "⚠️ DeepSeek Flash ran into a problem: The key was turned down.\n\nTry again — if it keeps happening, reply `@tarsee /clear` and try fresh."
        );
        let long = turn_error_note(
            NONE,
            &"x".repeat(700),
            TurnErrorOptions {
                plain: true,
                ..Default::default()
            },
        );
        assert_eq!(
            long,
            format!(
                "The AI ran into a problem: {}…\n\nTry again — if it keeps happening, /clear and try fresh.",
                "x".repeat(599)
            )
        );
    }

    #[test]
    fn a_long_error_cut_through_an_emoji_leaves_the_emoji_out() {
        // Node cuts at 599 units, which leaves half of the first 😀 ("\ud83d") before the "…".
        let note = turn_error_note(NONE, &format!("{}😀😀", "a".repeat(598)), TurnErrorOptions::default());
        assert_eq!(
            note,
            format!(
                "⚠️ The AI ran into a problem: {}…\n\nTry again — if it keeps happening, /clear and try fresh.",
                "a".repeat(598)
            )
        );
    }

    #[test]
    fn the_idle_note_says_whole_minutes_at_least_one() {
        let note = |route: Option<&Value>, ms: f64, plain: bool| idle_note(route, ms, plain);
        assert_eq!(
            note(None, 20.0 * 60_000.0, false),
            "⚠️ The AI stopped responding (20 min idle). Try again — maybe with a smaller ask."
        );
        assert_eq!(
            note(Some(&json!({ "providerLabel": "Codex" })), 0.0, true),
            "Codex stopped responding (1 min idle). Try again — maybe with a smaller ask."
        );
        for (ms, minutes) in [
            (90_000.0, 2),
            (150_000.0, 3),
            (29_999.0, 1),
            (f64::NAN, 1),
            (-500_000.0, 1),
        ] {
            assert_eq!(
                note(None, ms, false),
                format!("⚠️ The AI stopped responding ({minutes} min idle). Try again — maybe with a smaller ask."),
                "{ms}"
            );
        }
    }

    #[test]
    fn an_error_the_answer_already_says_is_not_said_again() {
        assert!(!error_still_to_say("", ""));
        assert!(!error_still_to_say("abc", " b "));
        assert!(error_still_to_say("abc", "z"));
        assert!(error_still_to_say("", "z"));
    }

    #[test]
    fn a_transcription_problem_is_passed_on_only_when_the_transcriber_said_what_to_do() {
        assert_eq!(stt_problem(None, ""), None);
        assert_eq!(
            stt_problem(Some("stt-failed"), "  Whisper is not installed.  ").as_deref(),
            Some("Whisper is not installed.")
        );
        assert_eq!(stt_problem(Some("stt-unavailable"), "  "), None);
        assert_eq!(stt_problem(Some("other"), "x"), None);
    }
}
