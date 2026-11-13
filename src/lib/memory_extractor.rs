//! Port of `src/lib/memory-extractor.js`: the `[REMEMBER: ...]` markers in an AI reply. Each one is saved as a memory
//! (the database and MEMORY.md) and taken out of the reply, so the user doesn't see it.

use std::sync::LazyLock;

use crate::app::App;
use crate::db::memory::MemoryStore;
use crate::lib::workspace_files::jstext::JS_SPACE_CLASS;
use crate::util::js::{trim, utf16_len, utf16_truncate};

/// `/\[REMEMBER:\s*(.+?)\]/gi`, with JavaScript's `\s` and `.` (which stops at a line end).
static REMEMBER: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(&format!(
        r"(?i)\[REMEMBER:[{JS_SPACE_CLASS}]*([^\n\r\u{{2028}}\u{{2029}}]+?)\]"
    ))
    .expect("the remember pattern")
});

static BLANK_LINES: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\n{3,}").expect("the blank lines pattern"));

/// Saves each `[REMEMBER: fact]` of `text` as a "learned" memory and returns the text without the markers.
pub fn extract_and_save_memories(app: &App, text: &str, conversation_id: Option<&str>) -> String {
    if text.is_empty() {
        return String::new();
    }
    let facts: Vec<String> = REMEMBER
        .captures_iter(text)
        .map(|caps| trim(&caps[1]).to_string())
        .collect();
    if facts.is_empty() {
        return text.to_string();
    }

    let store = MemoryStore::new(app);
    for fact in facts.iter().filter(|f| utf16_len(f) > 3) {
        if let Err(err) = store.add_and_sync(fact, "learned", conversation_id) {
            log::warn!("[memory] Failed to auto-save memories: {err}");
            break;
        }
        log::info!("[memory] Auto-saved: \"{}\"", utf16_truncate(fact, 80));
    }

    // Strip the markers so the user doesn't see them.
    let stripped = REMEMBER.replace_all(text, "");
    let collapsed = BLANK_LINES.replace_all(&stripped, "\n\n");
    trim(&collapsed).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{CapturedLogs, test_app};

    #[test]
    fn markers_are_saved_and_taken_out_of_the_reply() {
        let t = test_app();
        let logs = CapturedLogs::start();
        let reply =
            "Sure, noted.\n\n[remember:  The owner's dog is called Bantay ]\n\n\n\nAnything else? [REMEMBER: ok]";
        let cleaned = extract_and_save_memories(&t, reply, Some("conv-9"));
        assert_eq!(cleaned, "Sure, noted.\n\nAnything else?");
        let saved = MemoryStore::new(&t).list(50, None).unwrap();
        assert_eq!(saved.len(), 1, "a fact of 3 characters or fewer is dropped");
        assert_eq!(saved[0].content, "The owner's dog is called Bantay");
        assert_eq!(saved[0].category, "learned");
        assert_eq!(saved[0].source_conversation_id.as_deref(), Some("conv-9"));
        assert_eq!(
            logs.infos(),
            ["[memory] Auto-saved: \"The owner's dog is called Bantay\""]
        );
        assert!(
            std::fs::read_to_string(t.config().workspace_dir.join("MEMORY.md"))
                .unwrap()
                .ends_with("\n- [learned] The owner's dog is called Bantay")
        );
    }

    #[test]
    fn text_without_markers_is_left_as_it_is() {
        let t = test_app();
        assert_eq!(
            extract_and_save_memories(&t, "  plain\n\n\n\ntext  ", None),
            "  plain\n\n\n\ntext  "
        );
        assert_eq!(extract_and_save_memories(&t, "", None), "");
        // A marker does not run across lines.
        assert_eq!(
            extract_and_save_memories(&t, "[REMEMBER: a\nb]", None),
            "[REMEMBER: a\nb]"
        );
        assert_eq!(MemoryStore::new(&t).count().unwrap(), 0);
    }
}
