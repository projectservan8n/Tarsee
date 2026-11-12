//! `lib/run_cmd.rs` (the agent's run_command tool's runner) against the stand-in program: exit codes, the output of
//! both streams, the cap, the timeout, and an environment that is exactly the one given. (The Node version had no
//! test file of its own for it.)

use serde_json::Value;
use tarsee::ai::engine_env::EnvMap;
use tarsee::lib::run_cmd::{RunCmdOpts, run_cmd};

use crate::support::testbin;

fn echo_env(extra: &[(&str, &str)]) -> EnvMap {
    let mut env = EnvMap::from([("TARSEE_TESTBIN_ROLE".to_string(), "echo".to_string())]);
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    env
}

fn program() -> String {
    testbin().to_string_lossy().into_owned()
}

#[tokio::test]
async fn a_command_runs_to_the_end_with_its_code_and_both_streams() {
    let r = run_cmd(
        &program(),
        &["-c", "echo hi"],
        &RunCmdOpts {
            env: echo_env(&[
                ("TARSEE_TESTBIN_STDERR", "on stderr\n"),
                ("TARSEE_TESTBIN_EXIT", "3"),
                ("TARSEE_TESTBIN_ECHO_ENV", "TARSEE_TESTBIN_EXIT,HOME,ENCRYPTION_KEY"),
            ]),
            ..RunCmdOpts::default()
        },
    )
    .await;
    assert_eq!(r.code, 3);
    assert!(r.output.contains("on stderr\n"), "{}", r.output);
    let line = r.output.lines().find(|l| l.starts_with('{')).unwrap();
    let said: Value = serde_json::from_str(line).unwrap();
    assert_eq!(said["args"], serde_json::json!(["-c", "echo hi"]));
    // Exactly the environment given: nothing of the server's own leaks in.
    assert_eq!(
        said["env"],
        serde_json::json!({ "TARSEE_TESTBIN_EXIT": "3", "HOME": null, "ENCRYPTION_KEY": null })
    );
}

#[tokio::test]
async fn output_past_the_cap_is_cut_once_with_a_note() {
    let big = "y".repeat(200_000);
    let r = run_cmd(
        &program(),
        &["big"],
        &RunCmdOpts {
            env: echo_env(&[("TARSEE_TESTBIN_STDERR", &big)]),
            max_output_bytes: Some(2048),
            ..RunCmdOpts::default()
        },
    )
    .await;
    assert_eq!(r.code, 0);
    assert_eq!(r.output.matches("\n... (output truncated at 2KB)\n").count(), 1);
    assert!(r.output.len() < 2048 + 64, "{}", r.output.len());
}

#[tokio::test]
async fn a_command_past_its_timeout_is_code_124_with_a_note() {
    let r = run_cmd(
        &program(),
        &["slow"],
        &RunCmdOpts {
            env: echo_env(&[("TARSEE_TESTBIN_SLEEP_MS", "60000")]),
            timeout_ms: Some(600),
            ..RunCmdOpts::default()
        },
    )
    .await;
    assert_eq!(r.code, 124);
    assert!(r.output.ends_with("\n[timeout after 1s]\n"), "{}", r.output);
    assert!(
        r.output.contains("\"slow\""),
        "what came before the timeout is kept: {}",
        r.output
    );
}
