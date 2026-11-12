//! Port of test/codex-thread-dbs.test.js (all but the two cases that kill a sweep mid-way, which start the stand-in
//! program and live in tests/it/codex_thread_dbs.rs). Codex keeps a second copy of every thread in sqlite databases
//! in its home and never removes them, so the daily sweep does: the rows of a thread whose rollout is gone and that
//! nothing has touched since the cutoff. A thread whose rollout is still there (where its row says, or anywhere else
//! in the home), and a thread touched since the cutoff, always stay. The databases are built in the shape the pinned
//! codex 0.167.0 writes (`testkit::codex_homes`).

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use super::*;
use crate::testkit::codex_homes::*;
use crate::testkit::tmp_dir;

const STANDARD_COLUMNS: &str = "updated_at_ms INTEGER";

fn sweep_with(home: &Path, max_age_days: f64, deps: ThreadDbsDeps) -> usize {
    prune_codex_thread_dbs(&PruneThreadDbsOpts {
        homes: vec![home.to_path_buf()],
        max_age_days,
        now: NOW,
        deps,
    })
}

fn sweep(home: &Path) -> usize {
    sweep_with(home, 30.0, ThreadDbsDeps::default())
}

/// `t.mock.method(console, "warn")`: the warnings, kept.
#[derive(Clone, Default)]
struct Warnings(Arc<Mutex<Vec<String>>>);

impl Warnings {
    fn deps(&self) -> ThreadDbsDeps {
        let seen = self.0.clone();
        ThreadDbsDeps {
            warn: Some(Arc::new(move |text: &str| seen.lock().push(text.to_string()))),
            ..ThreadDbsDeps::default()
        }
    }

    fn any(&self, test: impl Fn(&str) -> bool) -> bool {
        self.0.lock().iter().any(|w| test(w))
    }
}

fn count(home: &Path, file: &str, sql: &str, args: &[&str]) -> i64 {
    column(home, file, sql, args)[0].parse().unwrap()
}

fn pending_file(home: &Path) -> std::path::PathBuf {
    home.join(".tarsee-vacuum-pending")
}

fn pending_list(home: &Path) -> Vec<String> {
    serde_json::from_slice(&std::fs::read(pending_file(home)).unwrap()).unwrap()
}

#[test]
fn removes_every_row_of_a_thread_whose_rollout_is_gone_and_that_is_past_the_cutoff_in_every_database() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    assert_eq!(sweep(&home), 1);

    let mut left = vec![KEPT, MOVED, FRESH, ARCHIVED];
    left.sort();
    assert_eq!(thread_ids(&home), left);
    assert_eq!(item_threads(&home), left, "its messages and command output are gone");
    for (file, table) in [
        ("state_5.sqlite", "thread_dynamic_tools"),
        ("state_5.sqlite", "thread_read_receipts"),
        ("thread_history_1.sqlite", "thread_turns"),
        ("logs_2.sqlite", "logs"),
    ] {
        assert_eq!(
            column(
                &home,
                file,
                &format!("SELECT thread_id FROM {table} WHERE thread_id = ?"),
                &[GONE]
            ),
            Vec::<String>::new(),
            "{file} {table}"
        );
        assert_eq!(
            column(&home, file, &format!("SELECT thread_id FROM {table}"), &[]).len(),
            left.len(),
            "{file} {table}: the others stay"
        );
    }
    assert_eq!(
        column(
            &home,
            "state_5.sqlite",
            "SELECT child_thread_id FROM thread_spawn_edges",
            &[]
        ),
        [KEPT_CHILD],
        "an edge from the removed thread goes; a kept thread's stays"
    );
    assert_eq!(
        count(&home, "state_5.sqlite", "SELECT COUNT(*) FROM thread_sections", &[]),
        1,
        "a table with no thread column is untouched"
    );
    assert_eq!(
        count(&home, "state_5.sqlite", "SELECT COUNT(*) FROM _sqlx_migrations", &[]),
        0
    );

    assert_eq!(sweep(&home), 0, "nothing more the second time");
}

#[test]
fn the_removed_threads_words_leave_the_disk_even_while_codex_has_its_databases_open() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    // A running Codex keeps its databases open between turns. Then closing the sweep's own connection doesn't
    // checkpoint and remove the write-ahead log (only the last connection's close does), so the sweep has to empty it
    // itself; and a deleted row's bytes stay in the file's free space unless they are overwritten.
    let codex = running_codex(&home);
    assert_eq!(sweep(&home), 1);
    let words = [
        format!("the person's words in {GONE}"),
        format!("user in {GONE}"),
        format!("agent in {GONE}"),
        format!("command in {GONE}"),
    ];
    for file in ["state_5.sqlite", "thread_history_1.sqlite"] {
        let wal = home.join(format!("{file}-wal"));
        assert!(
            wal.exists(),
            "{file}: the log is still there while Codex has the database open"
        );
        assert_eq!(
            std::fs::metadata(&wal).unwrap().len(),
            0,
            "{file}: the write-ahead log is emptied"
        );
        let bytes = std::fs::read(home.join(file)).unwrap();
        for w in &words {
            assert!(
                !bytes.windows(w.len()).any(|b| b == w.as_bytes()),
                "{file}: \"{w}\" is still in the database file"
            );
        }
    }
    // What stays is still there, and Codex still reads it.
    let kept: String = codex[0]
        .query_row("SELECT first_user_message FROM threads WHERE id = ?", [KEPT], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(kept, format!("the person's words in {KEPT}"));
    let gone: i64 = codex[0]
        .query_row("SELECT COUNT(*) FROM threads WHERE id = ?", [GONE], |r| r.get(0))
        .unwrap();
    assert_eq!(gone, 0);
}

// Codex writes its databases without secure_delete. A row it rewrote at another size, or moved when a page split as a
// chat grew, leaves its old copy in a page's free space, where deleting the row now doesn't reach it. So after the
// delete the sweep rebuilds the file (VACUUM), which keeps no free space with old copies in it.

#[test]
fn words_codexs_own_rewrites_left_in_free_space_go_too_the_file_is_rebuilt_after_the_delete() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    grow(&home);
    assert!(
        !left_in(&home, "GONE-WORDS").is_empty(),
        "the fixture has the words on disk to begin with"
    );
    // A running Codex keeps them open between turns.
    let codex: Vec<Connection> = ["state_5.sqlite", "thread_history_1.sqlite"]
        .iter()
        .map(|f| Connection::open(home.join(f)).unwrap())
        .collect();
    assert_eq!(sweep(&home), 1);
    assert_eq!(
        left_in(&home, "GONE-WORDS"),
        Vec::<String>::new(),
        "no copy of the removed chat's words in any database or log"
    );
    let kept: i64 = codex[1]
        .query_row("SELECT COUNT(*) FROM thread_items WHERE thread_id = ?", [KEPT], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(kept, 153, "the kept chat's rows are all there");
    assert!(left_in(&home, "KEPT-WORDS").contains(&"thread_history_1.sqlite".to_string()));
    assert!(!pending_file(&home).exists());
}

#[test]
fn a_rebuild_that_cant_finish_while_codex_is_reading_is_done_on_the_next_sweep_even_with_nothing_new_to_remove() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    grow(&home);
    let warnings = Warnings::default();
    // The running Codex holds its history open the whole time (one read, so it really holds the log), so closing a
    // connection never writes the log into the file by itself: only a sweep's rebuild can clear the words.
    let codex = Connection::open(home.join("thread_history_1.sqlite")).unwrap();
    codex
        .query_row("SELECT COUNT(*) FROM thread_turns", [], |r| r.get::<_, i64>(0))
        .unwrap();
    {
        // Codex mid-read on its history: the delete goes through, the rebuild can't be written out yet.
        let reader = Connection::open(home.join("thread_history_1.sqlite")).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        reader
            .query_row("SELECT COUNT(*) FROM thread_items", [], |r| r.get::<_, i64>(0))
            .unwrap();
        assert_eq!(sweep_with(&home, 30.0, warnings.deps()), 1);
        reader.execute_batch("COMMIT").unwrap();
    }
    assert!(!thread_ids(&home).contains(&GONE.to_string()), "the rows went");
    assert_eq!(
        pending_list(&home),
        ["thread_history_1.sqlite"],
        "and the sweep remembers the file it couldn't rebuild"
    );
    assert!(
        warnings.any(|w| w.contains("thread_history_1.sqlite") && w.contains("next sweep")),
        "and says so"
    );
    assert!(
        !left_in(&home, "GONE-WORDS").is_empty(),
        "the words are still on disk until a sweep rebuilds the file"
    );

    // The next sweep: no chat is due, but the rebuild left over is done.
    assert_eq!(sweep(&home), 0);
    assert_eq!(left_in(&home, "GONE-WORDS"), Vec::<String>::new());
    assert!(!pending_file(&home).exists(), "nothing is left to do");
    let kept: i64 = codex
        .query_row("SELECT COUNT(*) FROM thread_items WHERE thread_id = ?", [KEPT], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(kept, 153, "Codex still reads what stays");
}

#[test]
fn a_sweep_that_removes_rows_only_rebuilds_the_databases_that_lost_some() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    let goals = Connection::open(home.join("goals_1.sqlite")).unwrap();
    goals
        .execute_batch(
            "CREATE TABLE goals (id TEXT PRIMARY KEY, thread_id TEXT, text TEXT); INSERT INTO goals VALUES ('g1', 'someone-else', 'kept')",
        )
        .unwrap();
    drop(goals);
    let vacuumed = Arc::new(Mutex::new(Vec::new()));
    let seen = vacuumed.clone();
    let deps = ThreadDbsDeps {
        before_rebuild: Some(Arc::new(move |name: &str| seen.lock().push(name.to_string()))),
        ..ThreadDbsDeps::default()
    };
    assert_eq!(sweep_with(&home, 30.0, deps), 1);
    let mut vacuumed = vacuumed.lock().clone();
    vacuumed.sort();
    assert_eq!(
        vacuumed,
        ["logs_2.sqlite", "state_5.sqlite", "thread_history_1.sqlite"],
        "goals_1 had none of the thread's rows"
    );
    assert!(!pending_file(&home).exists());
}

#[test]
fn removes_nothing_at_a_cutoff_the_threads_havent_reached() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    assert_eq!(sweep_with(&home, 60.0, ThreadDbsDeps::default()), 0);
    assert_eq!(thread_ids(&home).len(), standard().len());
}

#[test]
fn a_thread_just_registered_with_no_rollout_yet_stays() {
    let tmp = tmp_dir();
    let home = make_home(
        tmp.path(),
        "home",
        &[Thread {
            id: FRESH,
            age_days: 0,
            rollout: Rollout::None,
        }],
        STANDARD_COLUMNS,
    );
    assert_eq!(sweep(&home), 0);
    assert_eq!(thread_ids(&home), [FRESH]);
}

#[test]
fn a_thread_id_that_isnt_a_uuid_is_matched_to_its_rollout_by_name_too() {
    let tmp = tmp_dir();
    let home = make_home(
        tmp.path(),
        "home",
        &[
            Thread {
                id: "thread-with-rollout",
                age_days: 40,
                rollout: Rollout::Here,
            },
            Thread {
                id: "thread-without",
                age_days: 40,
                rollout: Rollout::None,
            },
        ],
        STANDARD_COLUMNS,
    );
    assert_eq!(sweep(&home), 1);
    assert_eq!(thread_ids(&home), ["thread-with-rollout"]);
}

#[test]
fn a_database_that_fails_keeps_the_threads_rows_so_the_next_sweep_tries_again() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    let warnings = Warnings::default();
    let history = home.join("thread_history_1.sqlite");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", history.display()));
    }
    std::fs::write(
        &history,
        "this is not a database, but it is far longer than a sqlite header would be ".repeat(4),
    )
    .unwrap();

    assert_eq!(sweep_with(&home, 30.0, warnings.deps()), 0);
    assert!(thread_ids(&home).contains(&GONE.to_string()), "the threads row stays");
    assert!(warnings.any(|w| w.contains("[retention]")), "the failure is logged");
    assert!(
        warnings.any(|w| w == "[retention] Codex thread rows in home not pruned: file is not a database"),
        "{:?}",
        warnings.0.lock()
    );

    std::fs::remove_file(&history).unwrap();
    assert_eq!(sweep(&home), 1, "the next sweep removes it");
    assert!(!thread_ids(&home).contains(&GONE.to_string()));
}

#[test]
fn a_threads_table_codex_changed_is_left_alone_with_a_plain_log_line() {
    let tmp = tmp_dir();
    let home = make_home(
        tmp.path(),
        "home",
        &[Thread {
            id: GONE,
            age_days: 40,
            rollout: Rollout::None,
        }],
        "last_seen INTEGER",
    );
    let warnings = Warnings::default();
    assert_eq!(sweep_with(&home, 30.0, warnings.deps()), 0);
    assert_eq!(thread_ids(&home), [GONE]);
    assert!(warnings.any(|w| w.contains("[retention] Codex state_5 schema changed; thread rows not pruned")));
}

// A sessions folder that can't be read would make every old thread look as if its rollout were gone (and an
// unreadable parent folder makes a check for a rollout that is there say false), so the sweep removes nothing.

#[test]
fn a_sessions_folder_that_cant_be_read_nothing_is_taken_for_gone_and_it_says_why() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    let warnings = Warnings::default();
    let sessions = home.join("sessions");
    let mut deps = warnings.deps();
    deps.read_dir = Some(Arc::new(move |dir: &Path| {
        if dir.starts_with(&sessions) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("EACCES: permission denied, scandir '{}'", dir.display()),
            ));
        }
        real_read_dir(dir)
    }));
    assert_eq!(sweep_with(&home, 30.0, deps), 0);
    assert_eq!(thread_ids(&home), standard_ids(), "every thread stays");
    assert_eq!(item_threads(&home), standard_ids(), "and every message");
    assert!(
        warnings.any(|w| w.starts_with("[retention]") && w.contains("EACCES")),
        "the reason is logged"
    );
}

#[cfg(unix)]
#[test]
fn the_same_with_the_folders_permissions_really_taken_away() {
    use std::os::unix::fs::PermissionsExt;
    // SAFETY: geteuid only reads the process's user id.
    if unsafe { libc::geteuid() } == 0 {
        return; // root reads any folder: there is nothing to take away
    }
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    let warnings = Warnings::default();
    let sessions = home.join("sessions");
    std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o000)).unwrap();
    let swept = sweep_with(&home, 30.0, warnings.deps());
    std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(swept, 0);
    assert_eq!(
        thread_ids(&home),
        standard_ids(),
        "every thread stays, the one whose rollout is there too"
    );
    assert!(
        warnings.any(|w| w.starts_with("[retention]") && w.contains("EACCES")),
        "the reason is logged"
    );
}

#[test]
fn a_home_with_no_databases_or_none_at_all_is_fine() {
    let tmp = tmp_dir();
    let empty = tmp.path().join("empty-home");
    std::fs::create_dir_all(&empty).unwrap();
    let opts = PruneThreadDbsOpts {
        homes: vec![empty, tmp.path().join("no-such-home"), std::path::PathBuf::new()],
        now: NOW,
        ..PruneThreadDbsOpts::default()
    };
    assert_eq!(prune_codex_thread_dbs(&opts), 0);
}

#[test]
fn a_home_given_twice_is_swept_once_and_a_pending_file_keeps_only_known_names_in_order() {
    let tmp = tmp_dir();
    let home = make_home(tmp.path(), "home", &standard(), STANDARD_COLUMNS);
    let opts = PruneThreadDbsOpts {
        homes: vec![home.clone(), home.clone()],
        now: NOW,
        ..PruneThreadDbsOpts::default()
    };
    assert_eq!(prune_codex_thread_dbs(&opts), 1);
    std::fs::write(
        pending_file(&home),
        r#"["logs_2.sqlite", "evil.sqlite", 3, "state_5.sqlite", "logs_2.sqlite"]"#,
    )
    .unwrap();
    assert_eq!(read_pending(&home).0, ["logs_2.sqlite", "state_5.sqlite"]);
    std::fs::write(pending_file(&home), "not json").unwrap();
    assert!(read_pending(&home).0.is_empty());
}
