//! The two cases of test/codex-thread-dbs.test.js that stop a sweep dead in the middle of a database's rebuild (the
//! server killed mid-VACUUM): the sweep runs in the stand-in program (role `thread-dbs-sweep`), which exits on the
//! spot, running no clean-up, the moment the named database's rebuild starts. The next sweep must finish the job.

use std::path::Path;
use std::process::{Command, Output};

use tarsee::lib::codex_thread_dbs::{PruneThreadDbsOpts, prune_codex_thread_dbs};
use tarsee::testkit::codex_homes::*;
use tarsee::testkit::tmp_dir;

use crate::support::testbin;

fn killed_sweep(home: &Path, database: &str) -> Output {
    Command::new(testbin())
        .env_clear()
        .env("TARSEE_TESTBIN_ROLE", "thread-dbs-sweep")
        .arg(home)
        .arg(database)
        .arg(NOW.to_string())
        .output()
        .unwrap()
}

fn sweep(home: &Path) -> usize {
    prune_codex_thread_dbs(&PruneThreadDbsOpts {
        homes: vec![home.to_path_buf()],
        max_age_days: 30.0,
        now: NOW,
        ..PruneThreadDbsOpts::default()
    })
}

fn pending(home: &Path) -> Vec<String> {
    serde_json::from_slice(&std::fs::read(home.join(".tarsee-vacuum-pending")).unwrap()).unwrap()
}

#[test]
fn a_sweep_stopped_dead_in_the_middle_of_the_historys_rebuild_leaves_it_noted_and_the_next_sweep_does_it() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), "updated_at_ms INTEGER");
    grow(&home);
    let _codex = running_codex(&home);
    let r = killed_sweep(&home, "thread_history_1.sqlite");
    assert_eq!(
        r.status.code(),
        Some(137),
        "the sweep was stopped dead: {}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert!(
        thread_ids(&home).contains(&GONE.to_string()),
        "state_5 goes last, so its rows wait for the next sweep"
    );
    assert!(
        pending(&home).contains(&"thread_history_1.sqlite".to_string()),
        "the history's rebuild was noted before it started"
    );
    assert!(!left_in(&home, "GONE-WORDS").is_empty(), "the words are still on disk");

    assert_eq!(sweep(&home), 1);
    assert_eq!(
        left_in(&home, "GONE-WORDS"),
        Vec::<String>::new(),
        "the next sweep removes what is left and rebuilds the file"
    );
    assert!(!home.join(".tarsee-vacuum-pending").exists());
}

#[test]
fn stopped_dead_in_state_5s_rebuild_after_its_rows_went_the_next_sweep_with_no_chat_due_still_rebuilds_it() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), "updated_at_ms INTEGER");
    grow(&home);
    let codex = running_codex(&home);
    let r = killed_sweep(&home, "state_5.sqlite");
    assert_eq!(
        r.status.code(),
        Some(137),
        "the sweep was stopped dead: {}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert!(
        !thread_ids(&home).contains(&GONE.to_string()),
        "state_5's rows went before its rebuild started"
    );
    assert_eq!(
        pending(&home),
        ["state_5.sqlite"],
        "the history was rebuilt; state_5's rebuild is the one noted"
    );
    assert!(
        left_in(&home, "GONE-WORDS").contains(&"state_5.sqlite".to_string()),
        "the person's first words are still in state_5"
    );

    assert_eq!(sweep(&home), 0, "no chat is due any more");
    assert_eq!(
        left_in(&home, "GONE-WORDS"),
        Vec::<String>::new(),
        "yet state_5 is rebuilt, and the words are gone"
    );
    assert!(!home.join(".tarsee-vacuum-pending").exists());
    let kept: String = codex[0]
        .query_row("SELECT first_user_message FROM threads WHERE id = ?", [KEPT], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(kept, format!("the person's words in {KEPT}"));
}
