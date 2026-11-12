//! Port of test/codex-cli.test.js: the shared codex runner (`ai/codex_cli.rs`) used by the ChatGPT sign-in and the
//! account's model list: which program runs, that it starts through a Windows shim, that a failed start is an error
//! value and never a crash, and that stopping one stops everything it started. The stand-in codex is `tarsee-testbin`
//! playing `echo`. Every key here is an obvious fake.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;
use tarsee::Env;
use tarsee::ai::codex_cli::{
    CODEX_BASE_ARGS, CodexCliCode, RunCodexOpts, SpawnOpts, codex_child_env, collect_text, kill_tree, pinned_codex_bin,
    resolve_codex_bin, run_codex, spawn_codex, strip_ansi,
};
use tarsee::ai::engine_env::EnvMap;
use tarsee::testkit::tmp_dir;

use crate::support::{testbin, testbin_as};

/// The stand-in's environment: it plays `echo`, with these settings on top.
fn echo_env(extra: &[(&str, &str)]) -> EnvMap {
    let mut env = EnvMap::from([("TARSEE_TESTBIN_ROLE".to_string(), "echo".to_string())]);
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    env
}

/// A fake codex in `dir`, started the way a real install would start it: on Windows the `codex.cmd` shim npm makes
/// (run through cmd.exe), elsewhere a shell script that starts the program as its child.
fn fake_codex(dir: &Path) -> PathBuf {
    let program = testbin();
    if cfg!(windows) {
        let shim = dir.join("codex.cmd");
        std::fs::write(
            &shim,
            format!("@echo off\r\n\"{}\" %*\r\nexit /b %ERRORLEVEL%\r\n", program.display()),
        )
        .unwrap();
        shim
    } else {
        let shim = dir.join("codex");
        std::fs::write(&shim, format!("#!/bin/sh\n\"{}\" \"$@\"\n", program.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        shim
    }
}

/// A shell needs a PATH to find its own helpers; nothing else of the machine's environment goes in.
fn with_system(mut env: EnvMap) -> EnvMap {
    if !cfg!(windows) {
        env.insert("PATH".into(), "/usr/bin:/bin".into());
    }
    env
}

#[tokio::test]
async fn a_codex_that_cant_start_is_an_error_value_never_a_crash() {
    // The JS made sure a child's "error" event always had a listener (one with none takes Node down). Here a failed
    // start is the returned error, whatever the cause.
    let tmp = tmp_dir();
    let missing = tmp.path().join("no-such-codex");
    let args: [&str; 1] = ["logout"];
    assert!(spawn_codex(&missing, &args, &SpawnOpts::default()).is_err());
    let err = run_codex(&missing, &args, &RunCodexOpts::default()).await.unwrap_err();
    assert_eq!(err.code, CodexCliCode::CodexMissing);
    // And a child that did start is stopped cleanly.
    let mut child = spawn_codex(
        &testbin(),
        &["logout"],
        &SpawnOpts {
            env: echo_env(&[("TARSEE_TESTBIN_SLEEP_MS", "60000")]),
            cwd: Some(tmp.path().to_path_buf()),
        },
    )
    .unwrap();
    kill_tree(&mut child, Duration::from_millis(2000)).await;
    assert!(child.try_wait().unwrap().is_some(), "the child is gone");
}

#[tokio::test]
async fn run_codex_runs_one_command_to_the_end_through_the_platform_shim() {
    let tmp = tmp_dir();
    let home = tmp.path().join("status-home");
    std::fs::create_dir(&home).unwrap();
    let codex = fake_codex(tmp.path());
    let mut args: Vec<String> = CODEX_BASE_ARGS.iter().map(|a| a.to_string()).collect();
    args.extend(["login".into(), "status".into(), "two words".into()]);
    let r = run_codex(
        &codex,
        &args,
        &RunCodexOpts {
            env: with_system(echo_env(&[
                ("CODEX_HOME", &home.to_string_lossy()),
                ("TARSEE_TESTBIN_STDERR", "Not logged in\n"),
                ("TARSEE_TESTBIN_EXIT", "1"),
                ("TARSEE_TESTBIN_ECHO_ENV", "CODEX_HOME"),
            ])),
            cwd: Some(home.clone()),
            ..RunCodexOpts::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(r.code, Some(1));
    assert_eq!(r.signal, None);
    assert!(r.stderr.contains("Not logged in"), "{}", r.stderr);
    assert!(!r.timed_out);
    // Every argument arrives as it was given, quotes and spaces included, and the program runs in the home.
    let said: Value = serde_json::from_str(r.stdout.trim()).unwrap();
    assert_eq!(said["args"], serde_json::json!(args));
    assert_eq!(said["env"]["CODEX_HOME"], home.to_string_lossy().as_ref());
    let cwd = PathBuf::from(said["cwd"].as_str().unwrap());
    assert_eq!(cwd.canonicalize().unwrap(), home.canonicalize().unwrap());
}

#[tokio::test]
async fn kill_tree_on_a_child_that_already_exited_returns_at_once() {
    let tmp = tmp_dir();
    let mut child = spawn_codex(
        &testbin(),
        &["nothing"],
        &SpawnOpts {
            env: echo_env(&[]),
            cwd: Some(tmp.path().to_path_buf()),
        },
    )
    .unwrap();
    child.wait().await.unwrap();
    let started = Instant::now();
    kill_tree(&mut child, Duration::from_millis(2000)).await;
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn kill_tree_stops_the_shim_and_the_program_it_started() {
    let tmp = tmp_dir();
    let codex = fake_codex(tmp.path());
    let mut child = spawn_codex(
        &codex,
        &["login", "--device-auth"],
        &SpawnOpts {
            env: with_system(echo_env(&[("TARSEE_TESTBIN_SLEEP_MS", "120000")])),
            cwd: Some(tmp.path().to_path_buf()),
        },
    )
    .unwrap();
    let stdout = collect_text(child.stdout.take(), 64 * 1024);
    // Wait until the program itself is running (it says so first), so the kill reaches a whole tree.
    let started = Instant::now();
    while !stdout.text().contains("--device-auth") {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the stand-in never started"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let started = Instant::now();
    kill_tree(&mut child, Duration::from_millis(2000)).await;
    assert!(child.try_wait().unwrap().is_some(), "the shim is gone");
    // The program under the shim holds the same stdout: it ends only when that program is gone too.
    tokio::time::timeout(Duration::from_secs(10), stdout.finish())
        .await
        .expect("the program the shim started is still running");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn a_command_past_its_time_limit_is_killed_and_says_so() {
    let tmp = tmp_dir();
    let started = Instant::now();
    let r = run_codex(
        &fake_codex(tmp.path()),
        &["app-server"],
        &RunCodexOpts {
            env: with_system(echo_env(&[("TARSEE_TESTBIN_SLEEP_MS", "120000")])),
            cwd: Some(tmp.path().to_path_buf()),
            timeout: Duration::from_millis(500),
            ..RunCodexOpts::default()
        },
    )
    .await
    .unwrap();
    assert!(r.timed_out);
    assert!(started.elapsed() < Duration::from_secs(10));
    if cfg!(unix) {
        assert_eq!((r.code, r.signal.as_deref()), (None, Some("SIGTERM")));
    } else {
        assert!(r.code.is_some());
    }
}

#[tokio::test]
async fn output_past_the_cap_is_cut_and_the_program_still_runs_to_the_end() {
    let tmp = tmp_dir();
    // 300,000 bytes, made by the stand-in itself: no single environment value is large.
    let r = run_codex(
        &testbin(),
        &["models"],
        &RunCodexOpts {
            env: echo_env(&[
                ("TARSEE_TESTBIN_STDERR", "xxxxxxxxxx"),
                ("TARSEE_TESTBIN_STDERR_REPEAT", "30000"),
            ]),
            cwd: Some(tmp.path().to_path_buf()),
            max_bytes: 1000,
            ..RunCodexOpts::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(r.code, Some(0));
    assert_eq!(r.stderr, "x".repeat(1000));
}

#[test]
fn which_codex_is_found_on_the_path_of_the_environment_given() {
    let tmp = tmp_dir();
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir(&bin_dir).unwrap();
    let program = testbin_as(&bin_dir, "codex");
    let path = std::env::join_paths([tmp.path().join("elsewhere"), bin_dir.clone()]).unwrap();
    let env = Env::from_pairs([
        (
            if cfg!(windows) { "Path" } else { "PATH" },
            path.to_string_lossy().to_string(),
        ),
        ("PATHEXT", ".COM;.EXE;.BAT;.CMD".to_string()),
    ]);
    let found = pinned_codex_bin(&env).unwrap();
    assert_eq!(found.canonicalize().unwrap(), program.canonicalize().unwrap());
    assert_eq!(
        resolve_codex_bin(None, &env).unwrap().canonicalize().unwrap(),
        program.canonicalize().unwrap()
    );
    // An override wins over the PATH.
    let other = testbin_as(tmp.path(), "my-codex");
    env.set("TARSEE_CODEX_PATH", other.to_string_lossy().to_string());
    assert_eq!(resolve_codex_bin(None, &env).unwrap(), other);
    // The PATH of the environment given, not the server's: with none, no codex.
    assert_eq!(
        pinned_codex_bin(&Env::new()).unwrap_err().code,
        CodexCliCode::CodexMissing
    );
}

/// The real codex (the JS ran the pinned `@openai/codex` binary whenever it was installed). The Rust build uses the
/// codex on the machine, so this runs only when asked for, with the program's path given when the tests are built
/// (read at compile time, as `support::testbin()` is, never from the environment of the running test):
///
/// ```text
/// TARSEE_TEST_CODEX=/path/to/codex cargo test --test it -- --ignored the_real_codex
/// ```
#[tokio::test]
#[ignore = "needs a real codex: build the tests with TARSEE_TEST_CODEX=<path> and run with --ignored"]
async fn the_real_codex_takes_the_base_args_and_answers_login_status_in_its_own_words() {
    let Some(path) = option_env!("TARSEE_TEST_CODEX") else {
        panic!("TARSEE_TEST_CODEX was not set when the tests were built: set it to the codex program and build again");
    };
    let real = PathBuf::from(path);
    let tmp = tmp_dir();
    let home = tmp.path().join("pinned-status-home");
    std::fs::create_dir(&home).unwrap();
    let mut args: Vec<&str> = CODEX_BASE_ARGS.to_vec();
    args.extend(["login", "status"]);
    let env = codex_child_env(&Env::new(), &home, &with_system(EnvMap::new()));
    let r = run_codex(
        &real,
        &args,
        &RunCodexOpts {
            env,
            cwd: Some(home),
            timeout: Duration::from_secs(20),
            ..RunCodexOpts::default()
        },
    )
    .await
    .unwrap();
    assert!(!r.timed_out);
    assert!(strip_ansi(&format!("{}\n{}", r.stderr, r.stdout)).contains("Not logged in"));
}
