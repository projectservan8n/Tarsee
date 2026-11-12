//! Port of `src/lib/personality-learner.js`: a lightweight personality learner.
//!
//! Instead of making expensive background API calls:
//! 1. Track conversation message counts.
//! 2. Every 10 messages, append a subtle hint to the next system prompt asking the AI to save anything worth
//!    remembering.
//! 3. The AI saves it with `[REMEMBER: ...]` markers (`lib/memory_extractor.rs`).
//!
//! This costs no extra API calls and no memory beyond a counter. The counters lived in a module Map (reset on
//! restart, which is fine); here they are a service in the [`App`].

use std::collections::HashMap;

use parking_lot::Mutex;

use crate::app::App;

/// Every this many messages, nudge the AI.
const LEARN_INTERVAL: i64 = 10;

/// The message count last seen for each conversation.
#[derive(Default)]
struct LearningCounters(Mutex<HashMap<String, i64>>);

/// Notes a conversation's message count and returns the learning hint to append to the system prompt, or "" (the
/// hint comes once at each multiple of 10).
pub fn get_learning_hint(app: &App, conversation_id: &str, message_count: i64) -> &'static str {
    let counters = app.get_or_init(LearningCounters::default);
    let prev = counters
        .0
        .lock()
        .insert(conversation_id.to_string(), message_count)
        .unwrap_or(0);
    if message_count > 0 && message_count % LEARN_INTERVAL == 0 && message_count != prev {
        LEARNING_HINT
    } else {
        ""
    }
}

/// Forgets a deleted conversation's counter.
pub fn clear_counter(app: &App, conversation_id: &str) {
    if let Some(counters) = app.get::<LearningCounters>() {
        counters.0.lock().remove(conversation_id);
    }
}

const LEARNING_HINT: &str = "

[Internal note: This is your periodic memory check. Review this conversation so far and save anything important you've learned about the user. Use [REMEMBER: fact] markers to auto-save. Examples of things worth remembering:
- Their name, role, company, or projects
- Communication preferences (concise? detailed? technical?)
- Tools, languages, or frameworks they use
- Decisions made or preferences expressed
- Recurring topics or goals
Do NOT re-save things already in your memory context above. Only save genuinely new information.]";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::test_app;

    #[test]
    fn the_hint_comes_once_at_each_tenth_message() {
        let t = test_app();
        assert_eq!(get_learning_hint(&t, "c", 9), "");
        assert_eq!(get_learning_hint(&t, "c", 10), LEARNING_HINT);
        assert_eq!(get_learning_hint(&t, "c", 10), "", "not twice for the same count");
        assert_eq!(get_learning_hint(&t, "c", 11), "");
        assert_eq!(get_learning_hint(&t, "c", 20), LEARNING_HINT);
        assert_eq!(get_learning_hint(&t, "other", 0), "");
        assert_eq!(get_learning_hint(&t, "other", 30), LEARNING_HINT);
        clear_counter(&t, "c");
        assert_eq!(
            get_learning_hint(&t, "c", 20),
            LEARNING_HINT,
            "a cleared counter starts again"
        );
        assert!(LEARNING_HINT.starts_with("\n\n[Internal note: This is your periodic memory check."));
        assert!(LEARNING_HINT.ends_with("Only save genuinely new information.]"));
    }
}
