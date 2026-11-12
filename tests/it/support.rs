//! Shared by the integration tests.

use std::path::{Path, PathBuf};

/// The stand-in program (`testbin/`), built by cargo for these tests.
pub fn testbin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_tarsee-testbin"))
}

/// A copy of the stand-in under another name inside `dir` (`codex`, `claude`, `python3`, ...), so it plays that
/// role when Tarsee finds and starts it by name. Returns the copy's path (with `.exe` on Windows).
#[allow(dead_code)]
pub fn testbin_as(dir: &Path, name: &str) -> PathBuf {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let target = dir.join(file);
    std::fs::copy(testbin(), &target).expect("the stand-in program could not be copied");
    target
}
