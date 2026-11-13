//! Workspace program hooks (`lib/hook_loader.rs`, docs/hooks.md): a `workspace/hooks/<name>.hook.json` manifest names
//! a program that is started on each of its events, with the event on stdin.

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tarsee::Env;
use tarsee::daemon::pid::is_running;
use tarsee::lib::hook_loader::load_hooks;
use tarsee::lib::hooks::HookRegistry;
use tarsee::testkit::{TestApp, test_app_with_env};

use crate::support::testbin;

fn app_with_hook(extra_env: &[(&str, &str)], args: &[&str]) -> TestApp {
    let mut env: Vec<(String, String)> = vec![
        ("TARSEE_TESTBIN_ROLE".into(), "echo".into()),
        ("TARSEE_TESTBIN_READ_STDIN".into(), "1".into()),
        ("TARSEE_TESTBIN_ECHO_ENV".into(), "HOOK_SECRET,CARGO_PKG_NAME".into()),
        ("HOOK_SECRET".into(), "from-the-app".into()),
    ];
    env.extend(extra_env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let t = test_app_with_env(env);
    let dir = t.config().workspace_dir.join("hooks");
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = json!({
        "name": "echoer",
        "events": ["message:received", "tool:after_execute"],
        "command": testbin().to_string_lossy(),
        "args": args,
    });
    std::fs::write(dir.join("echoer.hook.json"), manifest.to_string()).unwrap();
    t
}

#[tokio::test]
async fn a_program_hook_gets_the_event_on_stdin_in_the_workspace_with_the_apps_environment() {
    let t = app_with_hook(&[], &["one", "two words"]);
    let report = load_hooks(&t);
    assert_eq!(report.programs, ["echoer.hook.json"]);

    let results = HookRegistry::of(&t)
        .emit("message:received", json!({"text": "hello", "channel": "telegram"}))
        .await;
    let ours = results
        .iter()
        .find(|r| r.name == "echoer")
        .expect("the program hook ran");
    assert_eq!(ours.error, None);
    let said: &Value = ours.result.as_ref().unwrap();
    assert_eq!(said["args"], json!(["one", "two words"]));
    let raw_stdin = said["stdin"].as_str().unwrap();
    assert!(
        raw_stdin.ends_with("}\n") && raw_stdin.matches('\n').count() == 1,
        "one line: {raw_stdin:?}"
    );
    let stdin: Value = serde_json::from_str(raw_stdin).unwrap();
    assert_eq!(
        stdin,
        json!({"event": "message:received", "data": {"text": "hello", "channel": "telegram"}})
    );
    assert_eq!(
        std::fs::canonicalize(said["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(&t.config().workspace_dir).unwrap()
    );
    // The app's environment, and nothing of the real one (cargo sets CARGO_PKG_NAME for the test run).
    assert_eq!(
        said["env"],
        json!({"HOOK_SECRET": "from-the-app", "CARGO_PKG_NAME": null})
    );
}

#[tokio::test]
async fn a_program_that_fails_is_an_error_result() {
    let t = app_with_hook(
        &[("TARSEE_TESTBIN_EXIT", "3"), ("TARSEE_TESTBIN_STDERR", "no luck\n")],
        &[],
    );
    load_hooks(&t);
    let results = HookRegistry::of(&t)
        .emit("tool:after_execute", json!({"toolName": "x"}))
        .await;
    let ours = results.iter().find(|r| r.name == "echoer").unwrap();
    assert_eq!(ours.error.as_deref(), Some("exited with code 3: no luck"));
    assert_eq!(ours.result, None);
}

#[tokio::test]
async fn a_program_that_runs_too_long_is_stopped() {
    let t = test_app_with_env(std::iter::empty::<(&str, &str)>());
    let pid_file = t.path().join("sleeper.pid");
    t.env().set("TARSEE_TESTBIN_ROLE", "sleeper");
    t.env()
        .set("TARSEE_TESTBIN_PID_FILE", pid_file.to_string_lossy().to_string());
    t.env().set("TARSEE_TESTBIN_SLEEP_MS", "4000");
    let dir = t.config().workspace_dir.join("hooks");
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = json!({"name": "sleeper", "events": ["message:received"], "command": testbin().to_string_lossy()});
    std::fs::write(dir.join("sleeper.hook.json"), manifest.to_string()).unwrap();
    t.app.set(HookRegistry::with_timeout(Duration::from_millis(1500)));
    load_hooks(&t);

    let results = HookRegistry::of(&t).emit("message:received", json!({})).await;
    let ours = results.iter().find(|r| r.name == "sleeper").unwrap();
    assert_eq!(ours.error.as_deref(), Some("Hook timeout"));

    // The program itself is gone: waited on (not slept on) until it is, well before it would have finished.
    let pid: i64 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    let check_env = Env::from_pairs([("SystemRoot", r"C:\Windows")]);
    assert!(
        is_running(&check_env, Some(i64::from(std::process::id()))),
        "the check works here"
    );
    // The program would finish after 4 seconds; it is stopped long before. The bound is only against a hang.
    let deadline = Instant::now() + Duration::from_secs(30);
    while is_running(&check_env, Some(pid)) {
        assert!(Instant::now() < deadline, "the hook's program is still running");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let survived = pid_file.with_extension("pid.done");
    assert!(
        !survived.exists(),
        "the program ran to its end instead of being stopped"
    );
}

#[tokio::test]
async fn a_program_that_cannot_start_is_an_error_result() {
    let t = test_app_with_env(std::iter::empty::<(&str, &str)>());
    let dir = t.config().workspace_dir.join("hooks");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("gone.hook.json"),
        json!({"events": ["boot:ready"], "command": "./not-there"}).to_string(),
    )
    .unwrap();
    load_hooks(&t);
    let results = HookRegistry::of(&t).emit("boot:ready", json!({})).await;
    let ours = results.iter().find(|r| r.name == "gone.hook.json").unwrap();
    assert!(
        ours.error
            .as_deref()
            .unwrap()
            .starts_with("could not start ./not-there: "),
        "{ours:?}"
    );
}
