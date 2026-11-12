//! Port of `src/lib/checkpoint.js`: an explicit session handoff across container wipes.
//!
//! Complements the automatic `boot_context.rs`:
//!   boot context = lightweight, automatic, last 3 conversations * 300 chars
//!   checkpoint   = detailed, user-initiated via /checkpoint before a known restart or redeploy
//!
//! Flow:
//!   1. The user runs /checkpoint during an active session.
//!   2. The AI writes a detailed handoff to workspace/CHECKPOINT.md (with its file tools).
//!   3. The user restarts Tarsee (a Railway redeploy wipes the container).
//!   4. On the next session's first message, the system prompt carries CHECKPOINT.md as "Handoff from previous
//!      instance" and this module ARCHIVES the file to memory/checkpoints/<ts>.md so the same checkpoint isn't
//!      replayed forever.
//!
//! The archive ensures exactly-once delivery: the AI sees the handoff on the very first message after restart, then
//! the file moves out of the active path and into timestamped memory.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::config::Config;
use crate::lib::workspace_files::jstext::read_dir_sorted;

/// Where the user (and the AI) write checkpoint content (`CHECKPOINT_FILE_PATH`), so /checkpoint's playbook text can
/// name a stable path.
pub fn checkpoint_file_path(config: &Config) -> PathBuf {
    config.workspace_dir.join("CHECKPOINT.md")
}

fn archive_dir(config: &Config) -> PathBuf {
    config.workspace_dir.join("memory").join("checkpoints")
}

/// Whether a live checkpoint is waiting to be consumed.
pub fn has_checkpoint(config: &Config) -> bool {
    checkpoint_file_path(config).exists()
}

/// The checkpoint's text without consuming it (/checkpoint status, to preview without clearing).
pub fn peek_checkpoint(config: &Config) -> Option<String> {
    let path = checkpoint_file_path(config);
    if !path.exists() {
        return None;
    }
    fs::read(&path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Reads the checkpoint and moves it to memory/checkpoints/<timestamp>.md. Returns its text, or `None` when there
/// is no checkpoint.
///
/// Called while building the system prompt for the first message of a new session, so the handoff is surfaced
/// exactly once.
pub fn read_and_archive_checkpoint(config: &Config) -> Option<String> {
    let path = checkpoint_file_path(config);
    if !path.exists() {
        return None;
    }
    let body = match fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) => {
            log::warn!("[checkpoint] read error: {err}");
            return None;
        }
    };

    let dir = archive_dir(config);
    let stamp = crate::util::js::now_iso().replace([':', '.'], "-");
    let archive_path = dir.join(format!("{stamp}.md"));
    // A rename is atomic on the same filesystem, which covers the common case.
    let moved = fs::create_dir_all(&dir).and_then(|()| fs::rename(&path, &archive_path));
    match moved {
        Ok(()) => log::info!("[checkpoint] consumed and archived → {}", archive_path.display()),
        Err(err) => {
            // Fallback: delete the source so it isn't injected again on every new session. Lose the archive but
            // keep exactly-once semantics.
            log::warn!("[checkpoint] archive move failed, deleting: {err}");
            let _ = fs::remove_file(&path);
        }
    }
    Some(body)
}

/// One archived checkpoint.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckpointEntry {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch (`stat.mtimeMs`).
    pub mtime: f64,
}

/// The `limit` most recently archived checkpoints, newest first (for audit and the UI). Empty when the folder
/// cannot be read.
pub fn list_recent_checkpoints(config: &Config, limit: usize) -> Vec<CheckpointEntry> {
    let dir = archive_dir(config);
    let Ok(entries) = read_dir_sorted(&dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".md") {
            continue;
        }
        let full = dir.join(&name);
        // One that cannot be read spoils the list, as in the JS.
        let Ok(meta) = fs::metadata(&full) else {
            return Vec::new();
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        found.push(CheckpointEntry {
            name,
            path: full,
            size: meta.len(),
            mtime,
        });
    }
    // Newest first; a stable sort, so equal times keep the name order.
    found.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    found.truncate(limit);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::test_app;
    use std::time::{Duration, SystemTime};

    #[test]
    fn a_checkpoint_is_read_once_then_archived() {
        let t = test_app();
        let config = t.config();
        assert!(!has_checkpoint(config));
        assert_eq!(peek_checkpoint(config), None);
        assert_eq!(read_and_archive_checkpoint(config), None);

        fs::write(checkpoint_file_path(config), "## Handoff\nWas fixing the email channel.").unwrap();
        assert!(has_checkpoint(config));
        assert_eq!(
            peek_checkpoint(config).as_deref(),
            Some("## Handoff\nWas fixing the email channel.")
        );
        assert!(has_checkpoint(config), "a peek leaves it there");

        let logs = crate::testkit::CapturedLogs::start();
        assert_eq!(
            read_and_archive_checkpoint(config).as_deref(),
            Some("## Handoff\nWas fixing the email channel.")
        );
        assert!(!has_checkpoint(config));
        assert_eq!(read_and_archive_checkpoint(config), None, "exactly once");

        let archived = list_recent_checkpoints(config, 10);
        assert_eq!(archived.len(), 1);
        let name = &archived[0].name;
        let stamp = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.md$").unwrap();
        assert!(stamp.is_match(name), "{name}");
        assert_eq!(archived[0].size, 40);
        assert_eq!(
            fs::read_to_string(&archived[0].path).unwrap(),
            "## Handoff\nWas fixing the email channel."
        );
        assert_eq!(
            logs.infos(),
            [format!("[checkpoint] consumed and archived → {}", archived[0].path.display())]
        );
        assert_eq!(
            checkpoint_file_path(config),
            config.workspace_dir.join("CHECKPOINT.md")
        );
    }

    #[test]
    fn the_list_is_newest_first_markdown_only_and_limited() {
        let t = test_app();
        let dir = archive_dir(t.config());
        fs::create_dir_all(&dir).unwrap();
        let base = SystemTime::now() - Duration::from_secs(1000);
        for (i, name) in ["b.md", "a.md", "c.md", "notes.txt"].iter().enumerate() {
            let path = dir.join(name);
            fs::write(&path, "x".repeat(i + 1)).unwrap();
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(base + Duration::from_secs(i as u64 * 10)).unwrap();
        }
        let names = |list: Vec<CheckpointEntry>| list.into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names(list_recent_checkpoints(t.config(), 10)), ["c.md", "a.md", "b.md"]);
        assert_eq!(names(list_recent_checkpoints(t.config(), 2)), ["c.md", "a.md"]);
        let first = &list_recent_checkpoints(t.config(), 1)[0];
        assert_eq!(first.size, 3);
        let expected = (base + Duration::from_secs(20))
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as f64;
        assert!((first.mtime - expected).abs() < 1.0);
        assert_eq!(
            serde_json::to_value(first).unwrap().as_object().unwrap().keys().collect::<Vec<_>>(),
            ["name", "path", "size", "mtime"]
        );
    }
}
