//! The pieces every other test stands on: the stand-in program and the test app.

use std::process::Command;

use serde_json::Value;
use tarsee::testkit::{test_app, tmp_dir};

use crate::support::{testbin, testbin_as};

#[test]
fn the_stand_in_reports_what_it_was_started_with() {
    let out = Command::new(testbin())
        .args(["one", "two words"])
        .env("TARSEE_TESTBIN_ROLE", "echo")
        .env("TARSEE_TESTBIN_ECHO_ENV", "SHOWN, MISSING")
        .env("SHOWN", "yes")
        .env_remove("MISSING")
        .env("TARSEE_TESTBIN_STDERR", "careful")
        .env("TARSEE_TESTBIN_EXIT", "3")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "careful");
    let said: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(said["args"], serde_json::json!(["one", "two words"]));
    assert_eq!(said["env"], serde_json::json!({"SHOWN": "yes", "MISSING": null}));
    assert!(said.get("stdin").is_none());
}

#[test]
fn a_copy_plays_the_role_of_its_file_name() {
    let dir = tmp_dir();
    let echo = testbin_as(dir.path(), "echo");
    let out = Command::new(&echo)
        .env_remove("TARSEE_TESTBIN_ROLE")
        .arg("hi")
        .output()
        .unwrap();
    assert!(out.status.success());
    let said: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(said["args"], serde_json::json!(["hi"]));

    let stranger = testbin_as(dir.path(), "nobody");
    let out = Command::new(&stranger)
        .env_remove("TARSEE_TESTBIN_ROLE")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(64));
    assert!(String::from_utf8_lossy(&out.stderr).contains("no such role: nobody"));
}

#[test]
fn the_test_app_is_usable_from_an_integration_test() {
    let t = test_app();
    assert!(t.config().workspace_dir.join("SOUL.md").exists());
    let tables: i64 = t
        .db()
        .with(|c| c.query_row("SELECT count(*) FROM migrations", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(tables, 12);
}
