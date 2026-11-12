//! Port of `src/daemon/pid.js`: the PID file of a running Tarsee (`<state>/tarsee.pid`), for `tarsee stop` and
//! `tarsee status`.

use std::path::PathBuf;

use crate::config::Config;
use crate::lib::workspace_files::jstext::js_parse_int;

/// `<state>/tarsee.pid`.
pub fn pid_file(config: &Config) -> PathBuf {
    config.state_dir.join("tarsee.pid")
}

/// Writes this process's id. A failure is logged, never raised.
pub fn write_pid(config: &Config) {
    let path = pid_file(config);
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, std::process::id().to_string()));
    if let Err(err) = written {
        log::warn!("[daemon] failed to write PID file: {err}");
    }
}

/// The id in the PID file (read as `parseInt` read it), or `None`.
pub fn read_pid(config: &Config) -> Option<i64> {
    let text = std::fs::read_to_string(pid_file(config)).ok()?;
    js_parse_int(text.trim())
}

/// Whether a process with this id is running (`process.kill(pid, 0)`).
pub fn is_running(pid: Option<i64>) -> bool {
    let Some(pid) = pid.filter(|p| *p > 0) else {
        return false;
    };
    process_exists(pid)
}

/// `kill -0`, through the shell's own `kill` (a slim container may have no `kill` program).
#[cfg(unix)]
fn process_exists(pid: i64) -> bool {
    std::process::Command::new("/bin/sh")
        .args(["-c", &format!("kill -0 {pid}")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(windows)]
fn process_exists(pid: i64) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
}

/// Removes the PID file; already gone is fine.
pub fn remove_pid(config: &Config) {
    let _ = std::fs::remove_file(pid_file(config));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::test_app;

    #[test]
    fn the_pid_file_is_written_read_and_removed() {
        let t = test_app();
        assert_eq!(read_pid(t.config()), None);
        write_pid(t.config());
        assert_eq!(
            std::fs::read_to_string(t.path().join("tarsee.pid")).unwrap(),
            std::process::id().to_string()
        );
        assert_eq!(read_pid(t.config()), Some(i64::from(std::process::id())));
        std::fs::write(pid_file(t.config()), " 42abc\n").unwrap();
        assert_eq!(read_pid(t.config()), Some(42));
        std::fs::write(pid_file(t.config()), "none").unwrap();
        assert_eq!(read_pid(t.config()), None);
        remove_pid(t.config());
        assert!(!pid_file(t.config()).exists());
        remove_pid(t.config());
    }

    #[test]
    fn this_process_is_running_and_nonsense_ids_are_not() {
        assert!(is_running(Some(i64::from(std::process::id()))));
        assert!(!is_running(None));
        assert!(!is_running(Some(0)));
        assert!(!is_running(Some(-3)));
        assert!(!is_running(Some(2_147_000_000)));
    }
}
