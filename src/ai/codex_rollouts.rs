//! Port of `src/ai/codex-rollouts.js`: Codex's own record of each thread (a rollout,
//! $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl), kept tidy. `lib/retention.rs` prunes old ones from
//! both Codex homes (design 4.8 "Rollouts"); the engine (`providers/codex.rs`) re-exports it.
//!
//! The JS took an `fsImpl` to stand in for `fs`; no test used it, and this reads the real file system.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use super::context_limits::JS_DOT_CLASS;

static ROLLOUT_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^rollout-{JS_DOT_CLASS}*\.jsonl$")).expect("a rollout-name pattern"));

/// Whether a file name is a rollout's (`/^rollout-.*\.jsonl$/`).
pub(crate) fn is_rollout_name(name: &str) -> bool {
    ROLLOUT_NAME.is_match(name)
}

/// What [`prune_codex_rollouts`] sweeps.
#[derive(Debug, Clone)]
pub struct PruneRolloutsOpts {
    /// The Codex homes; an empty path is skipped.
    pub homes: Vec<PathBuf>,
    /// Default 30.
    pub max_age_days: f64,
    /// Now, in ms since the epoch (`Date.now()`).
    pub now: i64,
}

impl Default for PruneRolloutsOpts {
    fn default() -> Self {
        PruneRolloutsOpts {
            homes: Vec::new(),
            max_age_days: 30.0,
            now: crate::util::js::now_ms(),
        }
    }
}

/// A file's modification time in ms since the epoch (`stat.mtimeMs`), following links.
pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> Option<f64> {
    let modified = meta.modified().ok()?;
    Some(match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1e3,
        Err(before) => -(before.duration().as_secs_f64() * 1e3),
    })
}

/// Remove rollouts (and the day folders they leave empty) untouched for `max_age_days`, under each Codex home's
/// sessions/. Returns how many files went.
pub fn prune_codex_rollouts(opts: &PruneRolloutsOpts) -> usize {
    let cutoff = opts.now as f64 - opts.max_age_days * 86_400_000.0;
    let mut removed = 0;
    for home in &opts.homes {
        if !home.as_os_str().is_empty() {
            sweep(&home.join("sessions"), 3, cutoff, &mut removed);
        }
    }
    removed
}

fn sweep(dir: &Path, depth: u32, cutoff: f64, removed: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        // The name as Node read it (not UTF-8 decoded with U+FFFD): such a name then names no file, so it is
        // neither swept into nor removed, as in the JS.
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = dir.join(&name);
        if kind.is_dir() && depth > 0 {
            sweep(&path, depth - 1, cutoff, removed);
            // Not empty, or gone: either way it stays as it is.
            let empty = std::fs::read_dir(&path).is_ok_and(|mut rest| rest.next().is_none());
            if empty {
                let _ = std::fs::remove_dir(&path);
            }
        } else if kind.is_file() && is_rollout_name(&name) {
            let old = std::fs::metadata(&path)
                .ok()
                .and_then(|meta| mtime_ms(&meta))
                .is_some_and(|ms| ms < cutoff);
            if old && remove_file_forced(&path) {
                *removed += 1;
            }
        }
    }
}

/// `fs.rmSync(path, { force: true })` on a file: true when it is gone (a file already gone counts).
fn remove_file_forced(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(err) => err.kind() == std::io::ErrorKind::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::tmp_dir;
    use std::time::{Duration, SystemTime};

    const DAY: i64 = 86_400_000;

    fn rollout(dir: &Path, name: &str, age_days: i64, now: i64) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, "{}\n").unwrap();
        let at = SystemTime::UNIX_EPOCH + Duration::from_millis((now - age_days * DAY) as u64);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(at)
            .unwrap();
        file
    }

    #[test]
    fn old_rollouts_go_with_the_day_folders_they_leave_empty_and_everything_else_stays() {
        let tmp = tmp_dir();
        let now = crate::util::js::now_ms();
        let home = tmp.path().join(".codex-home-keys");
        let old_day = home.join("sessions").join("2026").join("10").join("01");
        let new_day = home.join("sessions").join("2026").join("11").join("09");
        let old = rollout(&old_day, "rollout-2026-10-01T00-00-00-aaa.jsonl", 40, now);
        let fresh = rollout(&new_day, "rollout-2026-11-09T00-00-00-bbb.jsonl", 2, now);
        let other = rollout(&new_day, "notes-2026.jsonl", 90, now);
        // Too deep to be a day folder: left alone.
        let deep = rollout(&new_day.join("extra"), "rollout-2026-11-09T00-00-00-ccc.jsonl", 90, now);
        let second_home = tmp.path().join(".codex-home");
        let old_too = rollout(
            &second_home.join("sessions").join("2026").join("09").join("30"),
            "rollout-2026-09-30T00-00-00-ddd.jsonl",
            45,
            now,
        );

        let opts = PruneRolloutsOpts {
            homes: vec![
                home.clone(),
                PathBuf::new(),
                second_home.clone(),
                tmp.path().join("none"),
            ],
            max_age_days: 30.0,
            now,
        };
        assert_eq!(prune_codex_rollouts(&opts), 2);
        assert!(!old.exists() && !old_too.exists());
        assert!(!old_day.exists(), "the emptied day folder goes");
        assert!(
            !home.join("sessions").join("2026").join("10").exists(),
            "and the month it emptied"
        );
        assert!(fresh.exists() && other.exists() && deep.exists());
        assert!(home.join("sessions").exists(), "sessions/ itself stays");
        assert_eq!(prune_codex_rollouts(&opts), 0, "nothing more the second time");
        let later = PruneRolloutsOpts {
            now: now + 29 * DAY,
            ..opts
        };
        assert_eq!(prune_codex_rollouts(&later), 1, "the fresh one once it is old");
    }

    #[cfg(unix)]
    #[test]
    fn a_rollout_whose_name_isnt_utf8_stays_as_in_the_js() {
        // Node read the name with U+FFFD in it, and that name is no file: the stat failed and the rollout stayed.
        use std::os::unix::ffi::OsStrExt;
        let tmp = tmp_dir();
        let now = crate::util::js::now_ms();
        let day = tmp
            .path()
            .join("home")
            .join("sessions")
            .join("2026")
            .join("10")
            .join("01");
        std::fs::create_dir_all(&day).unwrap();
        let odd = day.join(std::ffi::OsStr::from_bytes(b"rollout-\xff-x.jsonl"));
        std::fs::write(&odd, "{}\n").unwrap();
        let at = SystemTime::UNIX_EPOCH + Duration::from_millis((now - 40 * DAY) as u64);
        std::fs::File::options()
            .write(true)
            .open(&odd)
            .unwrap()
            .set_modified(at)
            .unwrap();
        let plain = rollout(&day, "rollout-2026-10-01T00-00-00-aaa.jsonl", 40, now);
        let opts = PruneRolloutsOpts {
            homes: vec![tmp.path().join("home")],
            max_age_days: 30.0,
            now,
        };
        assert_eq!(prune_codex_rollouts(&opts), 1);
        assert!(odd.exists(), "the one Node couldn't name stays");
        assert!(!plain.exists());
    }

    #[test]
    fn rollout_names_are_matched_as_the_js_matched_them() {
        assert!(is_rollout_name("rollout-2026-10-01T00-00-00-x.jsonl"));
        assert!(is_rollout_name("rollout-.jsonl"));
        assert!(!is_rollout_name("rollout-x.jsonl.bak"));
        assert!(!is_rollout_name("xrollout-x.jsonl"));
        assert!(!is_rollout_name("rollout-a\nb.jsonl"));
    }
}
