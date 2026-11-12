//! Port of `src/lib/turn-leftovers.js`: what a turn leaves behind when the server stops in the middle of it.
//!
//! A Codex turn copies the person's pictures to <system temp>/tarsee-codex/tarsee-images-* (`ai/media.rs`
//! write_local_images), and a Verify works in <state>/verify/<provider>-* (`ai/verify_model.rs`). Each turn removes
//! its own when it ends, but a redeploy, Ctrl+C or a crash can end the server first, and then nothing would ever
//! remove them (the pictures sit outside Tarsee's data folder, where deleting the chat can't reach). The server
//! sweeps them once at boot. Only what is over an hour old goes, so a turn another Tarsee sharing these folders is
//! running right now is never touched (a Verify takes well under an hour).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::ai::codex_rollouts::mtime_ms;
use crate::ai::engine_env::js_trim_path;
use crate::env::Env;
use crate::lib::run_cmd::node_error_message;

/// The folder under the system's temp folder where the Codex engine writes a turn's pictures (each turn in a
/// tarsee-images-* folder of its own).
pub const CODEX_IMAGE_DIR_NAME: &str = "tarsee-codex";
const IMAGE_FOLDER_PREFIX: &str = "tarsee-images-";
const MAX_AGE_MS: i64 = 3_600_000;

/// An environment variable as the platform looks it up: any case on Windows, exactly elsewhere; empty is unset.
fn lookup(env: &Env, name: &str) -> Option<String> {
    let value = if cfg!(windows) {
        env.snapshot()
            .into_iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v)
    } else {
        env.get(name)
    };
    value.filter(|v| !v.is_empty())
}

/// `os.tmpdir()` from the given environment: TEMP, TMP, else <SystemRoot>\temp on Windows; TMPDIR, TMP, TEMP, else
/// /tmp elsewhere; without a trailing separator.
pub fn os_tmpdir(env: &Env) -> PathBuf {
    if cfg!(windows) {
        let mut path = lookup(env, "TEMP").or_else(|| lookup(env, "TMP")).unwrap_or_else(|| {
            let root = lookup(env, "SystemRoot")
                .or_else(|| lookup(env, "windir"))
                .unwrap_or_else(|| "undefined".to_string());
            format!("{root}\\temp")
        });
        if path.len() > 1 && path.ends_with('\\') && !path.ends_with(":\\") {
            path.pop();
        }
        return PathBuf::from(path);
    }
    let mut path = lookup(env, "TMPDIR")
        .or_else(|| lookup(env, "TMP"))
        .or_else(|| lookup(env, "TEMP"))
        .unwrap_or_else(|| "/tmp".to_string());
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    PathBuf::from(path)
}

/// `CODEX_IMAGE_DIR`: `<os.tmpdir()>/tarsee-codex`.
pub fn codex_image_dir(env: &Env) -> PathBuf {
    os_tmpdir(env).join(CODEX_IMAGE_DIR_NAME)
}

/// What [`sweep_turn_leftovers`] sweeps.
#[derive(Debug, Clone)]
pub struct SweepOpts {
    /// The system's temp folder (`os.tmpdir()`).
    pub tmp_dir: PathBuf,
    /// Tarsee's state folder; none means no Verify workspaces are swept.
    pub state_dir: Option<PathBuf>,
    /// Now, in ms since the epoch.
    pub now: i64,
    pub max_age_ms: i64,
}

impl SweepOpts {
    /// The defaults: the temp folder of `env`, now, an hour.
    pub fn new(env: &Env) -> Self {
        SweepOpts {
            tmp_dir: os_tmpdir(env),
            state_dir: None,
            now: crate::util::js::now_ms(),
            max_age_ms: MAX_AGE_MS,
        }
    }
}

/// How many of each went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Leftovers {
    pub pictures: usize,
    pub verify: usize,
}

/// Remove the leftover picture folders and Verify workspaces over `max_age_ms` old. Never fails.
pub fn sweep_turn_leftovers(opts: &SweepOpts) -> Leftovers {
    let cutoff = (opts.now - opts.max_age_ms) as f64;
    let pictures = sweep(
        &opts.tmp_dir.join(CODEX_IMAGE_DIR_NAME),
        |name| name.starts_with(IMAGE_FOLDER_PREFIX),
        cutoff,
    );
    let state = opts.state_dir.as_deref().map(js_trim_path).unwrap_or_default();
    let verify = if state.as_os_str().is_empty() {
        0
    } else {
        sweep(&state.join("verify"), |_| true, cutoff)
    };
    Leftovers { pictures, verify }
}

fn sweep(dir: &Path, wanted: impl Fn(&str) -> bool, cutoff: f64) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !wanted(&name) {
            continue;
        }
        let path = dir.join(&name);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(err) => {
                log::warn!(
                    "[boot] couldn't remove {}: {}",
                    path.display(),
                    node_error_message(&err, "lstat", &path)
                );
                continue;
            }
        };
        if mtime_ms(&meta).is_some_and(|ms| ms >= cutoff) {
            continue;
        }
        match remove_forced(&path, &meta) {
            Ok(()) => removed += 1,
            Err(err) => log::warn!(
                "[boot] couldn't remove {}: {}",
                path.display(),
                node_error_message(&err, "rm", &path)
            ),
        }
    }
    removed
}

/// `fs.rmSync(path, { recursive: true, force: true })`: a folder with everything in it, a file, or a link itself
/// (never what it points to). Already gone is fine.
fn remove_forced(path: &Path, meta: &std::fs::Metadata) -> std::io::Result<()> {
    let result = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path).or_else(|err| {
            // A link to a folder on Windows is removed as a folder.
            if meta.file_type().is_symlink() {
                std::fs::remove_dir(path)
            } else {
                Err(err)
            }
        })
    };
    match result {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::tmp_dir;
    use std::time::{Duration, SystemTime};

    const HOUR: i64 = 3_600_000;

    fn set_mtime(path: &Path, at: SystemTime) {
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_WRITE_ATTRIBUTES, and FILE_FLAG_BACKUP_SEMANTICS so a folder can be opened.
            std::fs::File::options()
                .access_mode(0x0100)
                .custom_flags(0x0200_0000)
                .open(path)
                .unwrap()
        };
        #[cfg(not(windows))]
        let file = std::fs::File::open(path).unwrap();
        file.set_modified(at).unwrap();
    }

    fn folder(dir: &Path, name: &str, age_ms: i64, now: i64, file: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join(file), "x").unwrap();
        let at = SystemTime::UNIX_EPOCH + Duration::from_millis((now - age_ms) as u64);
        set_mtime(&p.join(file), at);
        set_mtime(&p, at);
        p
    }

    #[test]
    fn removes_pictures_and_verify_workspaces_over_an_hour_old_keeps_newer_ones_and_anything_else() {
        let tmp = tmp_dir();
        let now = crate::util::js::now_ms();
        let tmp_dir = tmp.path().join("system-temp");
        let state_dir = tmp.path().join("state");
        let images = tmp_dir.join("tarsee-codex");
        let verify = state_dir.join("verify");
        let old_pics = folder(&images, "tarsee-images-aaaaaa", 2 * HOUR, now, "image-1.png");
        let new_pics = folder(&images, "tarsee-images-bbbbbb", 10 * 60_000, now, "image-1.png");
        let other_old = folder(&images, "someone-elses", 5 * HOUR, now, "image-1.png");
        let old_check = folder(&verify, "deepseek-cccccc", 3 * HOUR, now, "notes.txt");
        let new_check = folder(&verify, "openrouter-dddddd", 5 * 60_000, now, "notes.txt");

        let opts = SweepOpts {
            tmp_dir,
            state_dir: Some(state_dir),
            now,
            max_age_ms: MAX_AGE_MS,
        };
        assert_eq!(sweep_turn_leftovers(&opts), Leftovers { pictures: 1, verify: 1 });
        assert!(!old_pics.exists() && !old_check.exists());
        assert!(new_pics.exists(), "a picture turn running now stays");
        assert!(new_check.exists(), "a Verify running now stays");
        assert!(other_old.exists(), "only tarsee-images-* in the pictures folder");

        let later = SweepOpts {
            now: now + 2 * HOUR,
            ..opts
        };
        assert_eq!(
            sweep_turn_leftovers(&later),
            Leftovers { pictures: 1, verify: 1 },
            "the rest once they're old"
        );
    }

    #[test]
    fn nothing_there_or_no_state_folder_is_fine() {
        let tmp = tmp_dir();
        let now = crate::util::js::now_ms();
        let nothing = Leftovers { pictures: 0, verify: 0 };
        let opts = SweepOpts {
            tmp_dir: tmp.path().join("none"),
            state_dir: Some(tmp.path().join("none-either")),
            now,
            max_age_ms: MAX_AGE_MS,
        };
        assert_eq!(sweep_turn_leftovers(&opts), nothing);
        let blank = SweepOpts {
            state_dir: Some(PathBuf::from("  ")),
            ..opts.clone()
        };
        assert_eq!(sweep_turn_leftovers(&blank), nothing);
        let none = SweepOpts {
            state_dir: None,
            ..opts
        };
        assert_eq!(sweep_turn_leftovers(&none), nothing);
    }

    #[test]
    fn the_pictures_folder_is_tarsee_codex_in_the_system_temp_folder() {
        // (The JS also read providers/codex.js to see the engine write there: that is package G2's to check.)
        let env = Env::from_pairs([("TMPDIR", "/var/tmp/"), ("TEMP", "C:\\Temp\\")]);
        assert_eq!(codex_image_dir(&env), os_tmpdir(&env).join("tarsee-codex"));
        if cfg!(windows) {
            assert_eq!(os_tmpdir(&env), PathBuf::from("C:\\Temp"));
            assert_eq!(
                os_tmpdir(&Env::from_pairs([("Tmp", "D:\\")])),
                PathBuf::from("D:\\"),
                "a drive's root keeps its separator"
            );
            assert_eq!(
                os_tmpdir(&Env::from_pairs([("SYSTEMROOT", "C:\\Windows")])),
                PathBuf::from("C:\\Windows\\temp")
            );
        } else {
            assert_eq!(os_tmpdir(&env), PathBuf::from("/var/tmp"));
            assert_eq!(os_tmpdir(&Env::from_pairs([("TMP", "/t")])), PathBuf::from("/t"));
            assert_eq!(os_tmpdir(&Env::new()), PathBuf::from("/tmp"));
            assert_eq!(os_tmpdir(&Env::from_pairs([("TMPDIR", "/")])), PathBuf::from("/"));
        }
    }
}
