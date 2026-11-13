//! The service installer's shell (`daemon/service.rs`): a command reaches the program as `execSync` passed it.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tarsee::Env;
use tarsee::daemon::service::{RealSystem, ServiceSystem};

use crate::support::testbin;

fn env() -> Env {
    // The shell on Windows needs SystemRoot, which every real environment has.
    Env::from_pairs([
        ("TARSEE_TESTBIN_ROLE", "echo"),
        ("TARSEE_TESTBIN_ECHO_ENV", "ONLY_HERE"),
        ("ONLY_HERE", "yes"),
        ("SystemRoot", r"C:\Windows"),
    ])
}

#[test]
fn the_scheduled_task_command_reaches_the_program_with_its_quotes_intact() {
    let mut shell = RealSystem::new(&env());
    // The arguments of `schtasks /Create ... /TR "\"<program>\" start" ...`, given to the stand-in instead.
    let command = format!(
        "\"{}\" /TN tarsee /TR \"\\\"C:\\Tools\\tarsee.exe\\\" start\" /RL HIGHEST /F",
        testbin().display()
    );
    let out = shell.run(&command, false).unwrap();
    let said: Value = serde_json::from_str(out.trim()).unwrap();
    // What Node's execSync gave the program (the review ran Node's with a stand-in that printed its arguments).
    assert_eq!(
        said["args"],
        json!([
            "/TN",
            "tarsee",
            "/TR",
            "\"C:\\Tools\\tarsee.exe\" start",
            "/RL",
            "HIGHEST",
            "/F"
        ])
    );
    // The app's environment, nothing else.
    assert_eq!(said["env"], json!({"ONLY_HERE": "yes"}));
}

#[test]
fn a_failing_command_names_itself_and_shows_its_stderr_only_when_asked() {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let env = env();
    env.set("TARSEE_TESTBIN_EXIT", "2");
    env.set("TARSEE_TESTBIN_STDERR", "it broke");
    let mut shell = RealSystem::with_stderr_sink(&env, sink.clone());
    let command = format!("\"{}\"", testbin().display());
    let err = shell.run(&command, false).unwrap_err().to_string();
    assert_eq!(err, format!("Command failed: {command}\nit broke"));
    assert!(sink.lock().is_empty());
    shell.run(&command, true).unwrap_err();
    assert_eq!(String::from_utf8_lossy(&sink.lock()), "it broke");
}
