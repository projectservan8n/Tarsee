//! Port of `test/codex-events.test.js`, and the whole mapping checked against the Node code's output.
//!
//! The Codex engine's event mapping (design 4.8 "Event mapping"): what Codex streams becomes Tarsee's events, with
//! Claude Code's tool names so the live view, the tool status lines and the loop guard need nothing new. Most cases
//! replay JSONL captured from the real pinned codex binary (`test/fixtures/codex/`, made by capture.mjs against the
//! fake Responses server); the few item kinds a Tarsee turn can't make Codex 0.167 produce (a to-do list, a web
//! search) are written out from the SDK's own types.
//!
//! `node-cases.json` holds what the Node mapping yielded for every fixture, whole, with several turn options, for
//! made-up event sequences with every way a turn can finish, and for the exported helpers on many inputs (made by
//! `docs/rust-port/reports/A5-capture-events.mjs.txt`); the `node_*` tests replay each and compare.

use serde_json::json;

use super::*;
use crate::ai::engine_errors::auth_message;

const NODE_CASES: &str = include_str!("node-cases.json");

fn fixture_text(name: &str) -> &'static str {
    match name {
        "auth-401" => include_str!("../../../../test/fixtures/codex/auth-401.jsonl"),
        "quota" => include_str!("../../../../test/fixtures/codex/quota.jsonl"),
        "rate-limit" => include_str!("../../../../test/fixtures/codex/rate-limit.jsonl"),
        "resume-1" => include_str!("../../../../test/fixtures/codex/resume-1.jsonl"),
        "resume-2" => include_str!("../../../../test/fixtures/codex/resume-2.jsonl"),
        "text-reply" => include_str!("../../../../test/fixtures/codex/text-reply.jsonl"),
        "tools" => include_str!("../../../../test/fixtures/codex/tools.jsonl"),
        "unreachable" => include_str!("../../../../test/fixtures/codex/unreachable.jsonl"),
        other => panic!("no fixture {other}"),
    }
}

fn fixture(name: &str) -> Vec<Value> {
    js::trim(fixture_text(name))
        .split('\n')
        .map(|line| serde_json::from_str(line.strip_suffix('\r').unwrap_or(line)).expect("a JSON line"))
        .collect()
}

fn opts(provider_id: &str, model: Option<&str>) -> CodexEventOptions {
    CodexEventOptions {
        provider_id: provider_id.to_string(),
        model: model.map(str::to_string),
        ..CodexEventOptions::default()
    }
}

/// Runs a captured turn through the mapper: the SDK's own throw at the end ("x-sdk-threw") is what finish sees.
fn replay_with(name: &str, opts: CodexEventOptions) -> (Vec<TurnEvent>, CodexEventState) {
    let mut state = create_codex_event_state(opts);
    let mut out = Vec::new();
    let mut thrown = None;
    for ev in fixture(name) {
        if ev["type"] == "x-sdk-threw" {
            thrown = Some(ev["message"].as_str().unwrap().to_string());
            continue;
        }
        out.extend(map_codex_event(&ev, &mut state));
    }
    out.extend(finish_codex_events(
        &mut state,
        FinishOptions {
            error: thrown,
            ..FinishOptions::default()
        },
    ));
    (out, state)
}

fn replay(name: &str) -> (Vec<TurnEvent>, CodexEventState) {
    replay_with(name, opts("openrouter", Some("openai/gpt-6.1-sol")))
}

fn of<'a>(out: &'a [TurnEvent], ty: &str) -> Vec<&'a TurnEvent> {
    out.iter().filter(|e| e.event_type() == ty).collect()
}

fn steps(out: &[TurnEvent], kind: &str) -> Vec<Value> {
    out.iter()
        .filter_map(|e| match e {
            TurnEvent::Step(step) if step.kind == kind => Some(step.payload()),
            _ => None,
        })
        .collect()
}

fn texts(out: &[TurnEvent]) -> Vec<String> {
    out.iter()
        .filter_map(|e| match e {
            TurnEvent::Text(text) => Some(text.content.clone()),
            _ => None,
        })
        .collect()
}

fn errors(out: &[TurnEvent]) -> Vec<&crate::ai::turn_types::ErrorEvent> {
    out.iter()
        .filter_map(|e| match e {
            TurnEvent::Error(error) => Some(error),
            _ => None,
        })
        .collect()
}

fn dones(out: &[TurnEvent]) -> Vec<Value> {
    of(out, "done").into_iter().map(TurnEvent::to_value).collect()
}

fn thinking(out: &[TurnEvent]) -> Vec<&'static str> {
    out.iter()
        .filter_map(|e| match e {
            TurnEvent::Thinking(t) => Some(t.status.as_str()),
            _ => None,
        })
        .collect()
}

fn tool_uses(out: &[TurnEvent]) -> Vec<&crate::ai::turn_types::ToolUseEvent> {
    out.iter()
        .filter_map(|e| match e {
            TurnEvent::ToolUse(u) => Some(u),
            _ => None,
        })
        .collect()
}

fn tool_results(out: &[TurnEvent]) -> Vec<&crate::ai::turn_types::ToolResultEvent> {
    out.iter()
        .filter_map(|e| match e {
            TurnEvent::ToolResult(r) => Some(r),
            _ => None,
        })
        .collect()
}

fn usages(out: &[TurnEvent]) -> Vec<Value> {
    of(out, "usage")
        .into_iter()
        .map(|e| e.to_value()["usage"].clone())
        .collect()
}

fn done(reason: &str) -> Vec<Value> {
    vec![json!({"type": "done", "stopReason": reason})]
}

fn usage(input: f64, cached: f64, cache_write: f64, output: f64, reasoning: f64) -> CodexUsage {
    CodexUsage {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: cache_write,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
    }
}

// --- captured turns ----------------------------------------------------------------------------------------------

#[test]
fn a_plain_answer_the_thinking_summary_the_words_the_usage_one_done() {
    let (out, state) = replay("text-reply");
    assert_eq!(
        state.thread_id.as_deref(),
        fixture("text-reply")[0]["thread_id"].as_str()
    );
    assert_eq!(thinking(&out), ["start", "stop"]);
    assert_eq!(
        steps(&out, "thinking")
            .iter()
            .map(|s| s["text"].clone())
            .collect::<Vec<_>>(),
        [json!("Weighing a friendly greeting.")]
    );
    assert_eq!(texts(&out), ["Hello from the fake."]);
    assert_eq!(
        steps(&out, "text")
            .iter()
            .map(|s| s["text"].clone())
            .collect::<Vec<_>>(),
        [json!("Hello from the fake.")]
    );
    // input_tokens counts the cached part too: the uncached rest is input, the cached part cache reads.
    assert_eq!(
        usages(&out)[0],
        json!({"input_tokens": 1000, "cache_read_input_tokens": 200, "cache_creation_input_tokens": 0, "output_tokens": 30})
    );
    assert_eq!(dones(&out), done("end_turn"));
    assert!(out.last().unwrap().is_done());
    assert!(errors(&out).is_empty());
    // Codex's note that it has no metadata for an unlisted model is noise on every OpenRouter or Local AI turn.
    assert!(steps(&out, "status").is_empty());
}

#[test]
fn every_tool_kind_with_claude_codes_names_paired_ids_and_honest_ok_flags() {
    let (out, state) = replay("tools");
    let uses = tool_uses(&out);
    let results = tool_results(&out);
    assert_eq!(
        uses.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(),
        [
            "Bash",
            "Bash",
            "mcp__tarsee__tarsee_datetime",
            "mcp__tarsee__tarsee_fail",
            "Write",
            "Edit",
            "Edit"
        ]
    );
    assert_eq!(
        uses.iter().map(|u| &u.id).collect::<Vec<_>>(),
        results.iter().map(|r| &r.id).collect::<Vec<_>>(),
        "each use has its result, in order"
    );
    assert_eq!(
        uses.iter().map(|u| &u.id).collect::<HashSet<_>>().len(),
        uses.len(),
        "ids are unique"
    );
    assert_eq!(
        results.iter().map(|r| r.ok).collect::<Vec<_>>(),
        [true, false, true, false, true, true, true]
    );
    // The shell's own wrapper (PowerShell here, bash -lc on Linux) is taken off the command.
    assert_eq!(uses[0].input["command"], "node -e \"console.log('hi from the shell')\"");
    assert_eq!(results[0].result, "hi from the shell\n");
    assert_eq!(uses[2].input, json!({"timezone": "UTC"}));
    assert!(results[2].result.contains("09:00 UTC (stub)"));
    assert!(results[3].result.contains("always fails"));
    let names: Vec<String> = uses[4..]
        .iter()
        .map(|u| {
            u.input["file_path"]
                .as_str()
                .unwrap()
                .replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(names, ["notes.txt", "readme.txt", "stale.txt"]);
    assert_eq!(uses[6].input["change"], "delete");
    for r in &results {
        assert!(utf16_len(&r.result) <= 2000);
    }
    // The live view: a tool_start when each began, a tool_end when it finished, the same ids.
    let starts = steps(&out, "tool_start");
    let ends = steps(&out, "tool_end");
    assert_eq!(
        starts.iter().map(|s| s["id"].clone()).collect::<Vec<_>>(),
        uses.iter().map(|u| json!(u.id)).collect::<Vec<_>>()
    );
    assert_eq!(
        ends.iter().map(|s| s["id"].clone()).collect::<Vec<_>>(),
        results.iter().map(|r| json!(r.id)).collect::<Vec<_>>()
    );
    assert_eq!(starts[2]["name"], "tarsee_datetime");
    assert_eq!(starts[0]["rawName"], "Bash");
    // Tools started, for maxTurns: two commands, two MCP calls, one patch.
    assert_eq!(state.tool_count, 5);
    assert_eq!(texts(&out), ["All done."]);
    assert_eq!(dones(&out), done("end_turn"));
}

#[test]
fn a_resumed_thread_codex_reports_the_threads_running_total_so_the_turns_usage_is_the_difference() {
    let (_, first) = replay("resume-1");
    let t1 = first.totals.unwrap();
    assert_eq!(t1, usage(1000.0, 100.0, 0.0, 10.0, 0.0));
    // Settled against the real binary: the second turn's turn.completed carries both turns' tokens.
    let raw2 = fixture("resume-2")
        .into_iter()
        .find(|e| e["type"] == "turn.completed")
        .unwrap()["usage"]
        .clone();
    assert_eq!(raw2["input_tokens"], 2500, "cumulative across the resumed thread");
    let (out2, second) = replay_with(
        "resume-2",
        CodexEventOptions {
            baseline: Some(t1),
            ..opts("openrouter", Some("openai/gpt-6.1-sol"))
        },
    );
    assert_eq!(
        usages(&out2)[0],
        json!({"input_tokens": 600, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 0, "output_tokens": 20})
    );
    assert_eq!(
        second.totals.unwrap().input_tokens,
        2500.0,
        "the new running total, for the next turn"
    );
    // Without the baseline the whole total would be charged again.
    assert_eq!(usages(&replay("resume-2").0)[0]["input_tokens"], 1500);
    // So when the engine couldn't learn it (baseline_known false: a resumed thread whose rollout couldn't be read), no
    // usage is given at all rather than the earlier turns' again; the turn still ends as it did.
    let (unknown, unknown_state) = replay_with(
        "resume-2",
        CodexEventOptions {
            baseline_known: false,
            ..opts("openrouter", Some("openai/gpt-6.1-sol"))
        },
    );
    assert!(usages(&unknown).is_empty());
    assert!(steps(&unknown, "usage").is_empty());
    assert_eq!(dones(&unknown), done("end_turn"));
    assert_eq!(texts(&unknown), texts(&out2));
    assert_eq!(
        unknown_state.totals.unwrap().input_tokens,
        2500.0,
        "the running total is still kept"
    );
}

#[test]
fn a_refused_key_the_providers_own_fix_an_error_done_auth_expired_the_retries_are_status_lines() {
    let (out, _) = replay("auth-401");
    let status = steps(&out, "status");
    assert_eq!(status.len(), 5);
    assert!(status[0]["text"].as_str().unwrap().contains("401"));
    assert!(status[0]["text"].as_str().unwrap().contains("1 of 5"));
    let msg = auth_message("openrouter");
    assert_eq!(texts(&out), std::slice::from_ref(&msg));
    let err = errors(&out)[0];
    assert_eq!(err.message, msg);
    assert_eq!(err.code(), Some("auth"));
    assert_eq!(err.recoverable, Some(false));
    assert_eq!(dones(&out), done("auth-expired"));
    assert!(out.last().unwrap().is_done());
}

#[test]
fn the_same_refusal_on_the_chatgpt_plan_is_its_sign_in_running_out() {
    let (out, _) = replay_with("auth-401", opts("chatgpt", None));
    assert_eq!(errors(&out)[0].code(), Some("expired"));
    assert_eq!(texts(&out)[0], auth_message("chatgpt"));
    assert_eq!(dones(&out), done("auth-expired"));
}

#[test]
fn out_of_credit_and_busy_are_classified_with_an_error_before_the_one_done() {
    for (name, code) in [("quota", "billing"), ("rate-limit", "rate")] {
        let (out, _) = replay(name);
        let errs = errors(&out);
        assert_eq!(errs.len(), 1, "{name}");
        assert_eq!(errs[0].code(), Some(code), "{name}");
        assert_eq!(errs[0].recoverable, Some(false), "{name}");
        assert_eq!(dones(&out), done("error"), "{name}");
        assert!(texts(&out).is_empty(), "{name}");
        let error_at = out.iter().position(|e| e.event_type() == "error").unwrap();
        let done_at = out.iter().position(|e| e.event_type() == "done").unwrap();
        assert!(error_at < done_at, "{name}");
    }
}

#[test]
fn local_ai_that_isnt_running_where_it_was_looked_for() {
    let (out, _) = replay_with(
        "unreachable",
        CodexEventOptions {
            local_url: Some("http://127.0.0.1:9/v1".into()),
            ..opts("local", Some("llama3.1:8b"))
        },
    );
    let err = errors(&out)[0];
    assert_eq!(err.code(), Some("unavailable"));
    assert!(
        err.message
            .contains("Can't reach your Local AI at http://127.0.0.1:9/v1"),
        "{}",
        err.message
    );
    assert_eq!(dones(&out), done("error"));
}

// --- item kinds and edge cases -----------------------------------------------------------------------------------

fn run(events: Vec<Value>) -> (Vec<TurnEvent>, CodexEventState) {
    let mut state = create_codex_event_state(opts("openai", Some("gpt-6.1-sol")));
    let mut out = Vec::new();
    for ev in &events {
        out.extend(map_codex_event(ev, &mut state));
    }
    (out, state)
}

#[test]
fn a_to_do_list_is_todo_write_each_time_it_changes_a_web_search_is_web_search() {
    let items =
        |done: bool| json!([{"text": "Read the file", "completed": done}, {"text": "Answer", "completed": false}]);
    let (out, _) = run(vec![
        json!({"type": "item.started", "item": {"id": "t1", "type": "todo_list", "items": items(false)}}),
        json!({"type": "item.updated", "item": {"id": "t1", "type": "todo_list", "items": items(false)}}),
        json!({"type": "item.updated", "item": {"id": "t1", "type": "todo_list", "items": items(true)}}),
        json!({"type": "item.completed", "item": {"id": "t1", "type": "todo_list", "items": items(true)}}),
        json!({"type": "item.started", "item": {"id": "w1", "type": "web_search", "query": "tarsier facts"}}),
        json!({"type": "item.completed", "item": {"id": "w1", "type": "web_search", "query": "tarsier facts"}}),
    ]);
    let uses = tool_uses(&out);
    assert_eq!(
        uses.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(),
        ["TodoWrite", "TodoWrite", "WebSearch"]
    );
    assert_eq!(
        uses[1].input["todos"],
        json!([{"content": "Read the file", "status": "completed", "activeForm": "Read the file"}, {"content": "Answer", "status": "pending", "activeForm": "Answer"}])
    );
    assert_eq!(uses[2].input, json!({"query": "tarsier facts"}));
    assert_eq!(
        tool_results(&out).iter().map(|r| &r.id).collect::<Vec<_>>(),
        uses.iter().map(|u| &u.id).collect::<Vec<_>>()
    );
}

#[test]
fn several_messages_are_one_reply_with_a_blank_line_between_them_reasoning_that_started_is_stopped_once() {
    let (out, _) = run(vec![
        json!({"type": "item.started", "item": {"id": "r1", "type": "reasoning", "text": ""}}),
        json!({"type": "item.completed", "item": {"id": "r1", "type": "reasoning", "text": "Plan the answer."}}),
        json!({"type": "item.completed", "item": {"id": "m1", "type": "agent_message", "text": "First."}}),
        json!({"type": "item.completed", "item": {"id": "m2", "type": "agent_message", "text": "Second."}}),
    ]);
    assert_eq!(thinking(&out), ["start", "stop"]);
    assert_eq!(texts(&out), ["First.", "\n\nSecond."]);
}

#[test]
fn a_tool_that_only_reports_its_end_still_gets_its_start_and_a_secret_in_a_step_is_redacted() {
    let secret = format!("sk-ant-api03-{}", "A".repeat(36));
    let (out, _) = run(vec![json!({"type": "item.completed", "item": {
        "id": "c9", "type": "command_execution", "command": format!("/bin/bash -lc 'echo {secret}'"),
        "aggregated_output": format!("{secret}\n"), "exit_code": 0, "status": "completed",
    }})]);
    let kinds: Vec<&str> = out
        .iter()
        .map(TurnEvent::event_type)
        .filter(|t| *t == "tool_use" || *t == "tool_result")
        .collect();
    assert_eq!(kinds, ["tool_use", "tool_result"]);
    assert_eq!(tool_uses(&out)[0].input["command"], format!("echo {secret}"));
    for s in out.iter().filter(|e| e.event_type() == "step") {
        assert!(
            !s.to_value().to_string().contains("sk-ant-api03-AAAA"),
            "{}",
            s.to_value()
        );
    }
}

#[test]
fn an_error_event_that_isnt_followed_by_turn_failed_still_ends_the_turn_with_an_error_and_one_done() {
    let (out, mut state) = run(vec![
        json!({"type": "thread.started", "thread_id": "th-1"}),
        json!({"type": "turn.started"}),
        json!({"type": "error", "message": "stream disconnected before completion: connection reset"}),
    ]);
    assert!(dones(&out).is_empty());
    let end = finish_codex_events(&mut state, FinishOptions::default());
    assert_eq!(
        end.iter().map(TurnEvent::event_type).collect::<Vec<_>>(),
        ["error", "done"]
    );
    assert_eq!(errors(&end)[0].code(), Some("unavailable"));
    assert!(
        finish_codex_events(&mut state, FinishOptions::default()).is_empty(),
        "never a second done"
    );
}

#[test]
fn a_thread_that_cant_be_resumed_is_recoverable_the_turn_layer_starts_fresh_with_the_conversation_handed_over() {
    let mut state = create_codex_event_state(opts("openai", Some("gpt-6.1-sol")));
    let end = finish_codex_events(
        &mut state,
        FinishOptions {
            error: Some("Codex Exec exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id 01a1 (code -32600)".into()),
            ..FinishOptions::default()
        },
    );
    let TurnEvent::Error(err) = &end[0] else {
        panic!("{:?}", end[0])
    };
    assert_eq!(err.recoverable, Some(true));
    assert_eq!(err.code(), Some("session"));
    assert_eq!(end[1].to_value(), json!({"type": "done", "stopReason": "error"}));
}

#[test]
fn finish_stop_gives_done_aborted_and_no_error_the_turn_limit_gives_error_max_turns_open_tools_are_closed() {
    let opened = || {
        run(vec![json!({"type": "item.started", "item": {"id": "c1", "type": "command_execution", "command": "sleep 30", "aggregated_output": "", "status": "in_progress"}})]).1
    };
    let no_steps =
        |list: Vec<TurnEvent>| -> Vec<TurnEvent> { list.into_iter().filter(|e| e.event_type() != "step").collect() };
    let stopped = no_steps(finish_codex_events(
        &mut opened(),
        FinishOptions {
            aborted: true,
            ..FinishOptions::default()
        },
    ));
    assert_eq!(
        stopped.iter().map(TurnEvent::event_type).collect::<Vec<_>>(),
        ["tool_result", "done"]
    );
    assert!(!tool_results(&stopped)[0].ok);
    assert_eq!(stopped[1].to_value(), json!({"type": "done", "stopReason": "aborted"}));
    let limited = no_steps(finish_codex_events(
        &mut opened(),
        FinishOptions {
            max_turns: Some(3),
            ..FinishOptions::default()
        },
    ));
    assert_eq!(
        limited.iter().map(TurnEvent::event_type).collect::<Vec<_>>(),
        ["tool_result", "error", "done"]
    );
    let err = errors(&limited)[0];
    assert_eq!(err.subtype.as_deref(), Some("error_max_turns"));
    assert!(err.message.contains('3'));
    assert_eq!(
        limited[2].to_value(),
        json!({"type": "done", "stopReason": "max_turns"})
    );
    // A turn that finished needs nothing more; an engine that ended with nothing at all says so.
    let silent = finish_codex_events(
        &mut create_codex_event_state(opts("openai", None)),
        FinishOptions::default(),
    );
    assert_eq!(
        silent.iter().map(TurnEvent::event_type).collect::<Vec<_>>(),
        ["error", "done"]
    );
    assert_eq!(silent[1].to_value()["stopReason"], "error");
}

#[test]
fn the_binary_missing_or_exiting_on_its_own_reads_as_a_plain_explanation() {
    let finish = |error: &str| {
        finish_codex_events(
            &mut create_codex_event_state(opts("openai", None)),
            FinishOptions {
                error: Some(error.into()),
                ..FinishOptions::default()
            },
        )
    };
    let missing =
        finish("Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.");
    assert!(errors(&missing)[0].message.contains("Codex isn't installed"));
    let exited = finish(
        "Codex Exec exited with code 2: WARNING: proceeding, even though we could not create PATH aliases: x\nReading prompt from stdin...\nError: bad config value",
    );
    let words = &errors(&exited)[0].message;
    assert!(words.contains("bad config value"), "{words}");
    assert!(
        !words.contains("PATH aliases") && !words.contains("Reading prompt"),
        "{words}"
    );
}

// --- helpers -----------------------------------------------------------------------------------------------------

#[test]
fn unwrap_shell_command_takes_off_the_shells_codex_wraps_a_command_in_and_leaves_anything_else_alone() {
    assert_eq!(unwrap_shell_command("/bin/bash -lc 'ls -la'"), "ls -la");
    assert_eq!(
        unwrap_shell_command("/bin/bash -lc \"node -e \\\"x\\\"\""),
        "node -e \"x\""
    );
    assert_eq!(unwrap_shell_command("bash -c 'a && b'"), "a && b");
    assert_eq!(unwrap_shell_command("/usr/bin/zsh -lc 'pwd'"), "pwd");
    assert_eq!(
        unwrap_shell_command(
            "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"Get-Date\""
        ),
        "Get-Date"
    );
    assert_eq!(unwrap_shell_command("pwsh -NoProfile -Command \"dir\""), "dir");
    assert_eq!(unwrap_shell_command("git status"), "git status");
    assert_eq!(unwrap_shell_command(""), "");
}

#[test]
fn usage_delta_subtracts_a_baseline_never_below_zero_and_a_missing_baseline_is_none() {
    let now = usage(10.0, 4.0, 1.0, 5.0, 2.0);
    assert_eq!(usage_delta(&now, None), now);
    let base = CodexUsage::from_value(&json!({"input_tokens": 3, "cached_input_tokens": 1, "output_tokens": 2}));
    assert_eq!(usage_delta(&now, Some(&base)), usage(7.0, 3.0, 1.0, 3.0, 2.0));
    // A baseline bigger than now (a compacted or replaced thread) can't make usage negative.
    let bigger = CodexUsage::from_value(&json!({"input_tokens": 99}));
    assert_eq!(usage_delta(&now, Some(&bigger)).input_tokens, 10.0);
}

fn classify(provider: &str, message: &str) -> CodexFailure {
    classify_codex_failure(provider, message, FailureContext::default())
}

#[test]
fn classify_codex_failure_reads_the_status_out_of_codexs_words_and_uses_engine_errors_meaning() {
    assert_eq!(
        classify("openai", "unexpected status 402 Payment Required: x").kind,
        ErrorKind::Billing
    );
    assert_eq!(
        classify_codex_failure(
            "openai",
            "unexpected status 404 Not Found: The model `nope` does not exist",
            FailureContext {
                model: Some("nope"),
                ..FailureContext::default()
            }
        )
        .kind,
        ErrorKind::Model
    );
    assert_eq!(
        classify("deepseek", "exceeded retry limit, last status: 503 Service Unavailable").kind,
        ErrorKind::Unavailable
    );
    assert_eq!(
        classify(
            "chatgpt",
            "You've hit your usage limit. subscription_sharing_usage_limit_exceeded"
        )
        .kind,
        ErrorKind::Rate
    );
}

#[test]
fn openrouters_moderation_refusal_403_ends_the_turn_as_an_error_in_its_own_words_not_a_rejected_key() {
    let body = json!({"error": {"code": 403, "message": "openai/gpt-5.5 requires moderation on OpenAI. Your input was flagged for \"violence\". No credits were charged.", "metadata": {"reasons": ["violence"], "flagged_input": "words", "provider_name": "OpenAI", "model_slug": "openai/gpt-5.5"}}});
    let words = format!(
        "unexpected status 403 Forbidden: {}, url: https://openrouter.ai/api/v1/responses",
        js_stringify(&body)
    );
    let mut st = create_codex_event_state(opts("openrouter", Some("openai/gpt-5.5")));
    let failed: Vec<TurnEvent> = [
        json!({"type": "thread.started", "thread_id": "th-m"}),
        json!({"type": "turn.started"}),
        json!({"type": "turn.failed", "error": {"message": words}}),
    ]
    .iter()
    .flat_map(|ev| map_codex_event(ev, &mut st))
    .collect();
    let stopped = finish_codex_events(
        &mut create_codex_event_state(opts("openrouter", Some("openai/gpt-5.5"))),
        FinishOptions {
            error: Some(words.clone()),
            ..FinishOptions::default()
        },
    );
    for out in [failed, stopped] {
        assert!(texts(&out).is_empty(), "no auth text");
        let err = errors(&out)[0];
        assert_eq!(err.code(), Some("moderated"));
        assert_eq!(err.recoverable, Some(false));
        assert!(
            err.message
                .contains("moderation turned this message down** (flagged for violence)"),
            "{}",
            err.message
        );
        assert!(!err.message.contains("key was rejected"));
        assert_eq!(dones(&out), done("error"));
    }
}

#[test]
fn a_local_ai_server_with_no_responses_api_404_that_names_no_model_says_so_not_that_the_model_is_missing() {
    let url = "http://127.0.0.1:11434/v1";
    let local = |message: &str, model: &str| {
        classify_codex_failure(
            "local",
            message,
            FailureContext {
                model: Some(model),
                local_url: Some(url),
                ..FailureContext::default()
            },
        )
    };
    let no_route = local(
        &format!("unexpected status 404 Not Found: 404 page not found, url: {url}/responses"),
        "llama3.1:8b",
    );
    assert_eq!(no_route.kind, ErrorKind::Unavailable);
    assert!(!no_route.recoverable);
    assert!(no_route.message.contains("no Responses API"));
    assert!(no_route.message.contains("http://127.0.0.1:11434/v1/responses"));
    assert!(no_route.message.contains("Ollama to 0.13.3 or newer"));
    for not in [
        "can't run the model",
        "Pick another model",
        "Check that the server is running",
    ] {
        assert!(!no_route.message.contains(not), "{not}");
    }
    let fastapi = local(
        &format!("unexpected status 404 Not Found: {{\"detail\":\"Not Found\"}}, url: {url}/responses"),
        "qwen3:4b",
    );
    assert_eq!(fastapi.kind, ErrorKind::Unavailable);
    // A real unknown model on Ollama names the model: that one is still the model's.
    let unknown = local(
        &format!(
            "unexpected status 404 Not Found: model \"llama3.1:8b\" not found, try pulling it first, url: {url}/responses"
        ),
        "llama3.1:8b",
    );
    assert_eq!(unknown.kind, ErrorKind::Model);
    assert!(unknown.message.contains("can't run the model llama3.1:8b"));
    // Other providers' 404s are unchanged.
    assert_eq!(
        classify("openai", "unexpected status 404 Not Found: 404 page not found").kind,
        ErrorKind::Model
    );
}

#[test]
fn a_chat_that_no_longer_fits_in_a_local_ais_context_is_its_own_kind_never_a_missing_model_llama_servers_400s() {
    let url = "http://127.0.0.1:9931/v1";
    for words in [
        "{\"error\":{\"code\":400,\"message\":\"request (40123 tokens) exceeds the available context size (32768 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\":40123,\"n_ctx\":32768}}",
        "{\"error\":{\"code\":400,\"message\":\"the request is larger than the max context size of the model\",\"type\":\"invalid_request_error\"}}",
        // What Codex says itself once the bridge turns a mid-stream overflow into response.failed context_length_exceeded.
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    ] {
        let c = classify_codex_failure(
            "local",
            &format!(
                "unexpected status 400 Bad Request: {words}, url: http://127.0.0.1:50000/t/abcdefghijklmnopqrstuv/v1/responses"
            ),
            FailureContext {
                model: Some("qwen3.5-9b"),
                local_url: Some(url),
                ..FailureContext::default()
            },
        );
        assert_eq!(c.kind, ErrorKind::Context, "{words}");
        assert!(c.message.contains("This chat no longer fits in your Local AI's memory"));
        assert!(c.message.contains("larger -c"));
        assert!(!c.message.contains("can't run the model"));
        assert!(
            !c.message.contains("abcdefghijklmnopqrstuv"),
            "the bridge's turn id is never shown"
        );
    }
}

#[test]
fn the_bridges_address_its_turn_id_never_reaches_the_words_shown_and_an_unreachable_server_mentions_a_model_still_downloading()
 {
    let c = classify_codex_failure(
        "local",
        "unexpected status 502 Bad Gateway: {\"error\":{\"message\":\"Can't reach your Local AI at http://127.0.0.1:9931/v1 (connection refused).\"}}, url: http://127.0.0.1:50000/t/abcdefghijklmnopqrstuv/v1/responses",
        FailureContext {
            model: Some("m"),
            local_url: Some("http://127.0.0.1:9931/v1"),
            ..FailureContext::default()
        },
    );
    assert_eq!(c.kind, ErrorKind::Unavailable);
    assert!(
        c.message
            .contains("Can't reach your Local AI at http://127.0.0.1:9931/v1")
    );
    assert!(c.message.contains("still be downloading the model"));
    let odd = classify_codex_failure(
        "local",
        "something odd at http://127.0.0.1:50000/t/abcdefghijklmnopqrstuv/v1/responses",
        FailureContext {
            model: Some("m"),
            ..FailureContext::default()
        },
    );
    assert!(!odd.message.contains("abcdefghijklmnopqrstuv"));
}

#[test]
fn every_way_codex_0_167_says_the_chatgpt_sign_in_couldnt_be_renewed_is_the_sign_in_running_out() {
    // codex-rs/login/src/auth/manager.rs and cloud-config/src/chatgpt.rs: what the pinned codex writes when it can't
    // renew the ChatGPT sign-in. Each must give the plan's own "sign in again" words and turn the card
    // sign-in-expired, not "ChatGPT ran into a problem".
    for message in [
        "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
        "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
        "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
        "Your access token could not be refreshed. Please log out and sign in again.",
        "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
        "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    ] {
        let e = classify("chatgpt", message);
        assert_eq!(e.kind, ErrorKind::Expired, "{message}");
        assert_eq!(e.message, auth_message("chatgpt"), "{message}");
    }
}

// --- The Node code's output --------------------------------------------------------------------------------------

fn node_cases() -> Value {
    serde_json::from_str(NODE_CASES).expect("node-cases.json is JSON")
}

fn options_from(o: &Value) -> CodexEventOptions {
    CodexEventOptions {
        provider_id: o["providerId"].as_str().unwrap_or("").to_string(),
        model: o["model"].as_str().map(str::to_string),
        baseline: o.get("baseline").filter(|b| truthy(b)).map(CodexUsage::from_value),
        baseline_known: o.get("baselineKnown") != Some(&json!(false)),
        local_url: o["localUrl"].as_str().map(str::to_string),
    }
}

fn finish_from(f: &Value) -> FinishOptions {
    FinishOptions {
        aborted: f["aborted"] == true,
        max_turns: f["maxTurns"].as_u64(),
        error: f["error"]["message"]
            .as_str()
            .or_else(|| f["error"]["string"].as_str().filter(|s| !s.is_empty()))
            .map(str::to_string),
    }
}

fn as_json(events: &[TurnEvent]) -> Value {
    Value::Array(events.iter().map(TurnEvent::to_value).collect())
}

fn state_json(state: &CodexEventState) -> Value {
    json!({
        "threadId": state.thread_id,
        "totals": state.totals.map(|t| t.to_value()),
        "done": state.done,
        "toolCount": state.tool_count,
        "label": state.label,
        "providerId": state.provider_id,
    })
}

/// The events of a run, then what finishing it gives.
fn run_case(opts: CodexEventOptions, events: &[Value], finish: FinishOptions) -> (Value, Value, Value) {
    let mut state = create_codex_event_state(opts);
    let mut out = Vec::new();
    let mut finish = finish;
    for ev in events {
        if ev["type"] == "x-sdk-threw" {
            if finish.error.is_none() {
                finish.error = Some(ev["message"].as_str().unwrap().to_string());
            }
            continue;
        }
        out.extend(map_codex_event(ev, &mut state));
    }
    let end = finish_codex_events(&mut state, finish);
    (as_json(&out), as_json(&end), state_json(&state))
}

#[test]
fn node_every_captured_fixture_whole_with_several_turn_options() {
    let cases = node_cases();
    for case in cases["replays"].as_array().unwrap() {
        let events = fixture(case["fixture"].as_str().unwrap());
        let (out, end, state) = run_case(options_from(&case["opts"]), &events, finish_from(&case["finish"]));
        let what = format!("{} {} {}", case["fixture"], case["opts"], case["finish"]);
        assert_eq!(out, case["out"], "{what}");
        assert_eq!(end, case["end"], "{what}");
        assert_eq!(state, case["state"], "{what}");
    }
}

#[test]
fn node_made_up_sequences_with_every_way_a_turn_can_finish() {
    let cases = node_cases();
    for case in cases["synthetic"].as_array().unwrap() {
        let events = case["events"].as_array().unwrap();
        let opts = options_from(&case["opts"]);
        for end_case in case["ends"].as_array().unwrap() {
            let (out, end, state) = run_case(opts.clone(), events, finish_from(&end_case["finish"]));
            let what = format!("{} {} {}", case["name"], case["opts"], end_case["finish"]);
            assert_eq!(out, case["out"], "{what}");
            assert_eq!(end, end_case["end"], "{what}");
            assert_eq!(state, end_case["state"], "{what}");
        }
    }
}

#[test]
fn node_unwrap_shell_command() {
    let cases = node_cases();
    for case in cases["unwrap"].as_array().unwrap() {
        assert_eq!(
            unwrap_shell_command(case[0].as_str().unwrap()),
            case[1].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn node_classify_codex_failure() {
    let cases = node_cases();
    for case in cases["failures"].as_array().unwrap() {
        let ctx = &case["ctx"];
        let got = classify_codex_failure(
            case["provider"].as_str().unwrap(),
            case["message"].as_str().unwrap(),
            FailureContext {
                model: ctx["model"].as_str(),
                local_url: ctx["localUrl"].as_str(),
                status: ctx["status"].as_u64().map(|s| s as u16),
                code: ctx["code"].as_str(),
            },
        );
        let got = json!({"kind": got.kind.as_str(), "recoverable": got.recoverable, "message": got.message});
        assert_eq!(got, case["out"], "{} {} {}", case["provider"], case["message"], ctx);
    }
}

#[test]
fn node_usage_delta() {
    let cases = node_cases();
    for case in cases["usage"].as_array().unwrap() {
        let now = CodexUsage::from_value(&case["now"]);
        let base = Some(&case["base"]).filter(|b| truthy(b)).map(CodexUsage::from_value);
        assert_eq!(usage_delta(&now, base.as_ref()).to_value(), case["out"], "{case}");
    }
}

// --- More than the Node tests checked ----------------------------------------------------------------------------

#[test]
fn usage_events_give_this_turns_share_with_its_step() {
    let mut state = create_codex_event_state(CodexEventOptions {
        baseline: Some(usage(100.0, 10.0, 0.0, 5.0, 0.0)),
        ..opts("openai", None)
    });
    state.done = false;
    let events = usage_events(&state, &usage(300.0, 60.0, 20.0, 15.0, 1.0));
    assert_eq!(
        as_json(&events),
        json!([
            {"type": "usage", "usage": {"input_tokens": 130, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 20, "output_tokens": 10}},
            {"type": "step", "kind": "usage", "input": 130, "cacheRead": 50, "cacheWrite": 20, "output": 10, "total": 210, "calls": null, "outTps": null, "nowTps": null},
        ])
    );
    assert!(
        matches!(events[0], TurnEvent::Usage(_)),
        "a usage event the turn layer reads as one"
    );
}

#[test]
fn an_event_whose_json_a_typed_event_would_change_is_kept_as_it_is() {
    // An item with no id: its result has no id either, as the Node object had none.
    let (out, _) = run(vec![
        json!({"type": "item.completed", "item": {"type": "web_search", "query": "q"}}),
    ]);
    assert_eq!(
        as_json(&out),
        json!([
            {"type": "tool_result", "ok": true, "result": ""},
            {"type": "step", "kind": "tool_end", "ok": true, "preview": ""},
        ])
    );
    assert!(matches!(out[0], TurnEvent::Other(_)));
    // A numeric id stays a number.
    let (out, _) = run(vec![
        json!({"type": "item.completed", "item": {"id": 7, "type": "web_search", "query": "q"}}),
    ]);
    assert_eq!(out[0].to_value()["id"], 7);
}

#[test]
fn state_defaults_label_and_provider_for_an_unknown_or_empty_id() {
    assert_eq!(create_codex_event_state(opts("", None)).label, "The AI");
    let unknown = create_codex_event_state(opts("NoSuchAI", Some("")));
    assert_eq!(
        (
            unknown.provider_id.as_str(),
            unknown.label.as_str(),
            unknown.model.clone()
        ),
        ("NoSuchAI", "NoSuchAI", None)
    );
    let alias = create_codex_event_state(opts("OpenAI", None));
    assert_eq!(alias.provider_id, "openai");
    assert_eq!(alias.label, crate::ai::provider_registry::PROVIDERS.openai.label);
}
