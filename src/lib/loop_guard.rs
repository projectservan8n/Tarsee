//! Port of `src/lib/loop-guard.js`.
//!
//! Notices a dashboard turn stuck repeating itself, so it can be stopped before it burns through the turn budget.
//!
//! Only certain signals count:
//!   - a failure is the SDK's own error flag on a tool's result (is_error), never words like "error" or "not found"
//!     inside a file's text;
//!   - "the same call" is the same tool with the same full input: three Edits of one file are three different
//!     edits, three Reads of one file at different offsets are three different reads.
//!
//! A turn's length is bounded elsewhere (maxTurns), not here.

use serde_json::Value;

struct Call {
    id: String,
    name: String,
    /// The input as JSON text.
    input: String,
    /// `None` until its result is in.
    is_error: Option<bool>,
}

/// What `createLoopGuard()` returned: `onCall`, `onResult`, `check` and `count`.
#[derive(Default)]
pub struct LoopGuard {
    calls: Vec<Call>,
}

pub fn create_loop_guard() -> LoopGuard {
    LoopGuard::default()
}

impl LoopGuard {
    /// A tool call started.
    pub fn on_call(&mut self, id: &str, name: &str, input: &Value) {
        let key = serde_json::to_string(input).unwrap_or_else(|_| format!("unreadable:{id}"));
        self.calls.push(Call {
            id: id.to_string(),
            name: name.to_string(),
            input: key,
            is_error: None,
        });
    }

    /// A tool's result came back (`ok` false when the SDK flags it as an error). A result whose id matches no call
    /// counts for the last call.
    pub fn on_result(&mut self, id: &str, ok: bool) {
        let index = self
            .calls
            .iter()
            .position(|call| call.id == id)
            .or_else(|| self.calls.len().checked_sub(1));
        if let Some(index) = index {
            self.calls[index].is_error = Some(!ok);
        }
    }

    /// Why the turn looks stuck, or `None`.
    pub fn check(&self) -> Option<String> {
        let done: Vec<(&Call, bool)> = self
            .calls
            .iter()
            .filter_map(|call| call.is_error.map(|is_error| (call, is_error)))
            .collect();
        if done.len() < 3 {
            return None;
        }
        let last3 = &done[done.len() - 3..];
        let first = last3[0].0;
        if last3
            .iter()
            .all(|(call, is_error)| *is_error && call.name == first.name)
        {
            return Some(format!("{} failed 3 times in a row", first.name));
        }
        if last3
            .iter()
            .all(|(call, _)| call.input == first.input && call.name == first.name)
        {
            return Some(format!("{} called 3 times with the same input", first.name));
        }
        if done.len() >= 5 && done[done.len() - 5..].iter().all(|(_, is_error)| *is_error) {
            return Some("5 consecutive tool errors".to_string());
        }
        None
    }

    /// How many tool calls started.
    pub fn count(&self) -> usize {
        self.calls.len()
    }
}

#[cfg(test)]
mod tests {
    //! Port of `test/loop-guard.test.js`. The dashboard's loop guard: it stops a turn stuck repeating itself, and
    //! nothing else.
    use super::*;
    use serde_json::json;

    fn run(steps: &[(&str, Value, bool)]) -> Option<String> {
        let mut guard = create_loop_guard();
        for (i, (name, input, ok)) in steps.iter().enumerate() {
            let id = format!("t{i}");
            guard.on_call(&id, name, input);
            guard.on_result(&id, *ok);
        }
        guard.check()
    }

    #[test]
    fn ordinary_work_is_never_stopped_edits_of_one_file_reads_at_different_offsets_files_that_mention_errors() {
        assert_eq!(
            run(&[
                (
                    "Edit",
                    json!({ "file_path": "/a.js", "old_string": "1", "new_string": "2" }),
                    true
                ),
                (
                    "Edit",
                    json!({ "file_path": "/a.js", "old_string": "3", "new_string": "4" }),
                    true
                ),
                (
                    "Edit",
                    json!({ "file_path": "/a.js", "old_string": "5", "new_string": "6" }),
                    true
                ),
            ]),
            None
        );
        assert_eq!(
            run(&[
                ("Read", json!({ "file_path": "/big.log", "offset": 0 }), true),
                ("Read", json!({ "file_path": "/big.log", "offset": 2000 }), true),
                ("Read", json!({ "file_path": "/big.log", "offset": 4000 }), true),
            ]),
            None
        );
        let many: Vec<(&str, Value, bool)> = (0..80)
            .map(|i| ("Grep", json!({ "pattern": format!("p{i}") }), true))
            .collect();
        assert_eq!(
            run(&many),
            None,
            "no cap on the number of tool calls (maxTurns bounds a turn)"
        );
    }

    #[test]
    fn the_very_same_call_three_times_in_a_row_is_a_loop() {
        let reason = run(&[
            ("Bash", json!({ "command": "npm test" }), true),
            ("Bash", json!({ "command": "npm test" }), true),
            ("Bash", json!({ "command": "npm test" }), true),
        ]);
        assert_eq!(reason.as_deref(), Some("Bash called 3 times with the same input"));
    }

    #[test]
    fn only_the_sdks_error_flag_counts_as_a_failure() {
        let reason = run(&[
            ("Bash", json!({ "command": "a" }), false),
            ("Bash", json!({ "command": "b" }), false),
            ("Bash", json!({ "command": "c" }), false),
        ]);
        assert_eq!(reason.as_deref(), Some("Bash failed 3 times in a row"));
        let reason = run(&[
            ("Bash", json!({ "command": "a" }), false),
            ("Read", json!({ "file_path": "/x" }), false),
            ("Grep", json!({ "pattern": "y" }), false),
            ("Glob", json!({ "pattern": "z" }), false),
            ("Bash", json!({ "command": "w" }), false),
        ]);
        assert_eq!(reason.as_deref(), Some("5 consecutive tool errors"));
    }

    #[test]
    fn results_are_matched_to_their_calls_by_id_when_tools_run_side_by_side() {
        let mut guard = create_loop_guard();
        guard.on_call("a", "Bash", &json!({ "command": "x" }));
        guard.on_call("b", "Bash", &json!({ "command": "y" }));
        guard.on_call("c", "Bash", &json!({ "command": "z" }));
        guard.on_result("c", true);
        guard.on_result("a", false);
        guard.on_result("b", false);
        assert_eq!(guard.check(), None, "two failures and a success are not three failures");
    }

    #[test]
    fn calls_are_counted_and_only_finished_ones_are_judged() {
        let mut guard = create_loop_guard();
        assert_eq!(guard.count(), 0);
        assert_eq!(guard.check(), None);
        for id in ["a", "b", "c"] {
            guard.on_call(id, "Bash", &json!({ "command": "same" }));
        }
        assert_eq!(guard.count(), 3);
        assert_eq!(guard.check(), None, "no result is in yet");
        guard.on_result("a", true);
        guard.on_result("b", true);
        assert_eq!(guard.check(), None);
        // A result with an id no call has counts for the last call.
        guard.on_result("unknown", true);
        assert_eq!(
            guard.check().as_deref(),
            Some("Bash called 3 times with the same input")
        );
        // The same input with another tool is another call; no input at all is the JSON null.
        let mut guard = create_loop_guard();
        for (id, name) in [("a", "Read"), ("b", "Grep"), ("c", "Read")] {
            guard.on_call(id, name, &Value::Null);
            guard.on_result(id, true);
        }
        assert_eq!(guard.check(), None);
        // A result before any call changes nothing.
        let mut guard = create_loop_guard();
        guard.on_result("x", false);
        assert_eq!((guard.count(), guard.check()), (0, None));
    }
}
