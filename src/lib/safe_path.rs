//! Port of `src/lib/safe-path.js`: keeps a path a person or the model gave inside the folders it may touch, and
//! keeps credentials, keys and databases out of reach even inside them.
//!
//! The Node version leaned on `path.resolve`, `path.join` and `path.relative`, which work on the text of a path and
//! never look at the disk. [`resolve_path`], [`normalize_path`], [`join_path`] and [`relative_path`] are those, so a
//! path ends up exactly where the Node version put it (a `..` that climbs above the root stays at the root, a
//! drive-relative `C:foo` on Windows lands under the root when the root is on that drive). [`fs_error_message`]
//! writes a file error the way Node's `fs` wrote it, for the messages the routes send back.

use std::path::{Component, MAIN_SEPARATOR, Path, PathBuf};

/// Names that must never be readable or writable through a file API, even when they sit inside an allowed root.
///
/// Defence in depth behind the root check. The file routes used to allow STATE_DIR, which is the parent of the
/// workspace and holds the Claude OAuth credentials, the encryption key, the master API token, the live SQLite
/// database and the hooks directory that is imported at boot — so "browse my files" was also "read every
/// credential and write code that runs on restart". The roots are tightened now; this list means a future root
/// change, a symlink, or a nested copy cannot quietly re-open the same hole.
pub const DENIED_SEGMENTS: &[&str] = &[
    ".credentials.json",
    ".encryption-key",
    "api.token",
    ".claude-code-home",
    "vault.json",
    // The AI sign-ins and key homes (design 4.15): Codex's own folder and its ChatGPT sign-in file, and the tool
    // results the MCP endpoint spills outside the workspace.
    ".codex",
    "auth.json",
    "tool-output",
];

/// Whole path segments that are a credential home: .codex-home (the ChatGPT sign-in), .codex-home-keys (the key
/// providers on Codex) and .claude-home-<id> (the key providers on Claude Code). (`/^\.codex-home/`,
/// `/^\.claude-home-/`.)
const DENIED_SEGMENT_PREFIXES: &[&str] = &[".codex-home", ".claude-home-"];

/// Anything ending in these (whatever its case) is a database or its sidecars. (`/\.db$/i`, `/\.db-wal$/i`,
/// `/\.db-shm$/i`, `/\.credentials\.json$/i`.)
const DENIED_ENDINGS: &[&str] = &[".db", ".db-wal", ".db-shm", ".credentials.json"];

/// Why [`safe_path`] refused a path. The text is what the routes answer with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SafePathError {
    #[error("Invalid path")]
    InvalidPath,
    #[error("No allowed roots configured")]
    NoRoots,
    #[error("Path is not accessible")]
    NotAccessible,
    #[error("Path outside allowed directories")]
    Outside,
}

/// The JavaScript line terminators, which `.` in a regex does not cross.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// A path segment as the file system will treat it: lower case (Windows and macOS match names case-insensitively),
/// without an NTFS stream suffix ("auth.json::$DATA") or the trailing dots and spaces Windows drops ("auth.json.").
fn segment_name(s: &str) -> String {
    let lower = s.to_lowercase();
    // `.replace(/:.*$/, "")`: from the first colon that has no line break after it, to the end.
    let after_last_break = lower
        .char_indices()
        .filter(|(_, c)| is_line_terminator(*c))
        .map(|(i, c)| i + c.len_utf8())
        .last()
        .unwrap_or(0);
    let cut = match lower[after_last_break..].find(':') {
        Some(at) => &lower[..after_last_break + at],
        None => &lower[..],
    };
    // `.replace(/[. ]+$/, "")`
    cut.trim_end_matches(['.', ' ']).to_string()
}

/// True when a resolved path points at something that must never be served.
pub fn is_sensitive_path(resolved_path: impl AsRef<Path>) -> bool {
    let text = resolved_path.as_ref().to_string_lossy();
    let segments: Vec<String> = text.split(['\\', '/']).map(segment_name).collect();
    if segments.iter().any(|s| DENIED_SEGMENTS.contains(&s.as_str())) {
        return true;
    }
    if segments
        .iter()
        .any(|s| DENIED_SEGMENT_PREFIXES.iter().any(|p| s.starts_with(p)))
    {
        return true;
    }
    let lower = text.to_lowercase();
    DENIED_ENDINGS.iter().any(|ending| lower.ends_with(ending))
}

/// Resolves a user-provided path and ensures it falls under one of the allowed root directories. Fails if the
/// resolved path escapes the allowed boundaries, or names something [`is_sensitive_path`] protects.
///
/// - `user_path`: the user-provided path (relative or absolute); relative ones are taken from the first root.
/// - `allowed_roots`: the directories that are allowed.
///
/// Returns the resolved, validated absolute path. The check is on the text of the path, as in the Node version:
/// a symlink inside a root that points out of it is not followed here.
pub fn safe_path<R: AsRef<Path>>(user_path: &str, allowed_roots: &[R]) -> Result<PathBuf, SafePathError> {
    if user_path.is_empty() {
        return Err(SafePathError::InvalidPath);
    }
    let Some(first) = allowed_roots.first() else {
        return Err(SafePathError::NoRoots);
    };

    // Resolve relative to the first allowed root
    let normalised = resolve_path(first.as_ref(), user_path);
    let normalised_text = normalised.to_string_lossy();

    for root in allowed_roots {
        let abs_root = resolve_path(root.as_ref(), "");
        let abs_root = abs_root.to_string_lossy();
        // Compared as text, as `normalised.startsWith(absRoot + path.sep)` did.
        if normalised_text == abs_root || normalised_text.starts_with(&format!("{abs_root}{MAIN_SEPARATOR}")) {
            if is_sensitive_path(&normalised) {
                return Err(SafePathError::NotAccessible);
            }
            return Ok(normalised);
        }
    }

    Err(SafePathError::Outside)
}

/// Sanitizes a filename for use in Content-Disposition headers. Strips characters that could cause header
/// injection: anything but printable ASCII becomes `_` (one per UTF-16 unit, as the JS did), runs of white space
/// become one `_`, and the result is at most 255 characters ("download" when nothing is left).
pub fn sanitize_filename(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        match c {
            '"' | '\\' | '\r' | '\n' => out.push('_'),
            ' '..='~' => out.push(c),
            // ASCII printable only
            other => out.extend(std::iter::repeat_n('_', other.len_utf16())),
        }
    }
    // `.replace(/\s+/g, "_")`: only the space is left that `\s` matches.
    let mut collapsed = String::with_capacity(out.len());
    let mut in_space = false;
    for c in out.chars() {
        if c == ' ' {
            if !in_space {
                collapsed.push('_');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    // Every character is ASCII now, so 255 characters are 255 bytes.
    collapsed.truncate(255);
    if collapsed.is_empty() {
        "download".to_string()
    } else {
        collapsed
    }
}

/// Checks if a tar entry path looks safe (no traversal, no absolute paths).
pub fn looks_safe_tar_path(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }
    if p.starts_with('/') || p.starts_with('\\') {
        return false;
    }
    // Windows drive letters
    let bytes = p.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/') {
        return false;
    }
    if p.split('/').any(|s| s == "..") {
        return false;
    }
    if p.split('\\').any(|s| s == "..") {
        return false;
    }
    true
}

// ---------------------------------------------------------------- Node's path functions

/// `path.resolve(base, path)`: `path` taken from `base` (made absolute from the current folder if it is relative),
/// then [`normalize_path`]. Works on the text only; the disk is never asked.
pub fn resolve_path(base: &Path, path: &str) -> PathBuf {
    let joined = join_like_node(base, Path::new(path));
    let absolute = if joined.is_absolute() {
        joined
    } else {
        std::path::absolute(&joined).unwrap_or(joined)
    };
    normalize_path(&absolute)
}

/// `base` joined with `path` the way `path.resolve` combines them: an absolute `path` replaces `base`, a rooted one
/// (`\x` on Windows) keeps `base`'s drive, and a drive-relative one (`C:x`) lands under `base` when `base` is on
/// that drive.
fn join_like_node(base: &Path, path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let mut parts = path.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            let rest = parts.as_path();
            if !rest.has_root() {
                let base_prefix = base.components().next();
                if let Some(Component::Prefix(base_prefix)) = base_prefix
                    && base_prefix
                        .as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&prefix.as_os_str().to_string_lossy())
                {
                    // The drive is written as `path` wrote it ("c:" stays lower case), as Node kept it.
                    let mut out = PathBuf::from(prefix.as_os_str());
                    out.push(base.components().skip(1).collect::<PathBuf>());
                    out.push(rest);
                    return out;
                }
            }
        }
    }
    base.join(path)
}

/// `path.normalize`: `.` dropped, `..` taking off the segment before it (never going above the root), repeated and
/// trailing separators gone, and on Windows `/` written as `\`.
pub fn normalize_path(path: &Path) -> PathBuf {
    // Built as text: pushing a segment such as "C:foo" onto a PathBuf would replace what is there.
    let mut head = String::new();
    let mut segments: Vec<String> = Vec::new();
    let mut ups = 0usize;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => head.push_str(&prefix.as_os_str().to_string_lossy()),
            Component::RootDir => head.push(MAIN_SEPARATOR),
            Component::CurDir => {}
            Component::ParentDir => {
                if segments.pop().is_none() && !path.has_root() {
                    ups += 1;
                }
            }
            Component::Normal(name) => segments.push(name.to_string_lossy().into_owned()),
        }
    }
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_string(), ups).collect();
    parts.extend(segments);
    let tail = parts.join(&MAIN_SEPARATOR.to_string());
    let text = format!("{head}{tail}");
    if text.is_empty() {
        PathBuf::from(".")
    } else {
        PathBuf::from(text)
    }
}

/// `path.join(a, b)`: the two put together as text and normalized. Unlike `Path::join`, an absolute or
/// drive-carrying `b` does not replace `a`; it is just more segments, as in Node.
pub fn join_path(a: &Path, b: &str) -> PathBuf {
    let joined = format!("{}{MAIN_SEPARATOR}{b}", a.to_string_lossy());
    normalize_path(Path::new(&joined))
}

/// `path.relative(from, to)`: the way from one folder to another, with `..` for each step up ("" when they are the
/// same). Both are resolved first; on Windows the names are compared without regard to case, as Node did.
pub fn relative_path(from: &Path, to: &Path) -> String {
    let from = resolve_path(from, "");
    let to = resolve_path(to, "");
    let names = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect()
    };
    let (a, b) = (names(&from), names(&to));
    let same = |x: &str, y: &str| {
        if cfg!(windows) {
            x.to_lowercase() == y.to_lowercase()
        } else {
            x == y
        }
    };
    let common = a.iter().zip(&b).take_while(|(x, y)| same(x, y)).count();
    if common == 0 && !a.is_empty() && !b.is_empty() {
        // Different drives (Windows): the target as it is.
        return to.to_string_lossy().into_owned();
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in common..a.len() {
        parts.push("..".to_string());
    }
    parts.extend(b[common..].iter().cloned());
    parts.join(&MAIN_SEPARATOR.to_string())
}

/// A file system error written the way Node's `fs` wrote it: `ENOENT: no such file or directory, open '<path>'`.
/// Errors Node had no code for keep Rust's own text.
pub fn fs_error_message(err: &std::io::Error, syscall: &str, path: &Path) -> String {
    use std::io::ErrorKind as K;
    let known = match err.kind() {
        K::NotFound => Some(("ENOENT", "no such file or directory")),
        K::PermissionDenied => Some(if cfg!(windows) {
            ("EPERM", "operation not permitted")
        } else {
            ("EACCES", "permission denied")
        }),
        K::AlreadyExists => Some(("EEXIST", "file already exists")),
        K::IsADirectory => Some(("EISDIR", "illegal operation on a directory")),
        K::NotADirectory => Some(("ENOTDIR", "not a directory")),
        K::DirectoryNotEmpty => Some(("ENOTEMPTY", "directory not empty")),
        K::ResourceBusy => Some(("EBUSY", "resource busy or locked")),
        K::CrossesDevices => Some(("EXDEV", "cross-device link not permitted")),
        K::ReadOnlyFilesystem => Some(("EROFS", "read-only file system")),
        K::StorageFull => Some(("ENOSPC", "no space left on device")),
        K::InvalidFilename => Some(("ENAMETOOLONG", "name too long")),
        _ => None,
    };
    match known {
        Some((code, text)) => format!("{code}: {text}, {syscall} '{}'", path.display()),
        None => err.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::tmp_dir;

    /// Platform-appropriate roots inside a temporary folder, as the Node test used `os.tmpdir()`.
    fn roots() -> (tempfile::TempDir, Vec<PathBuf>) {
        let dir = tmp_dir();
        let test_root = dir.path().join("opusclaw-test-roots");
        let roots = vec![test_root.join("workspace"), test_root.join("state")];
        (dir, roots)
    }

    // ------------------------------------------------------------ safePath

    #[test]
    fn allows_paths_within_allowed_roots() {
        let (_dir, roots) = roots();
        let result = safe_path("myproject", &roots).unwrap();
        assert_eq!(result, roots[0].join("myproject"));
        let result2 = safe_path("myproject/src/file.js", &roots).unwrap();
        assert_eq!(result2, roots[0].join("myproject").join("src").join("file.js"));
    }

    #[test]
    fn rejects_path_traversal_attempts() {
        let (_dir, roots) = roots();
        assert_eq!(safe_path("../../../etc/passwd", &roots), Err(SafePathError::Outside));
        assert_eq!(safe_path("../../root/.ssh/id_rsa", &roots), Err(SafePathError::Outside));
        assert!(SafePathError::Outside.to_string().contains("outside allowed"));
    }

    #[test]
    fn rejects_absolute_paths_outside_roots() {
        let (_dir, roots) = roots();
        let outside_path = if cfg!(windows) {
            "C:\\Windows\\System32"
        } else {
            "/etc/passwd"
        };
        assert_eq!(safe_path(outside_path, &roots), Err(SafePathError::Outside));
    }

    #[test]
    fn rejects_null_empty_paths() {
        let (_dir, roots) = roots();
        // A null path cannot reach this function in Rust; the empty path takes the same branch.
        assert_eq!(safe_path("", &roots), Err(SafePathError::InvalidPath));
        assert_eq!(SafePathError::InvalidPath.to_string(), "Invalid path");
    }

    #[test]
    fn rejects_when_no_roots_configured() {
        let none: [&Path; 0] = [];
        assert_eq!(safe_path("test", &none), Err(SafePathError::NoRoots));
        assert!(SafePathError::NoRoots.to_string().contains("No allowed roots"));
    }

    #[test]
    fn a_root_itself_and_a_sibling_that_only_shares_its_name() {
        let (_dir, roots) = roots();
        assert_eq!(safe_path(".", &roots).unwrap(), roots[0]);
        assert_eq!(safe_path("a/../..", &roots), Err(SafePathError::Outside));
        let sibling = format!("{}-evil", roots[0].display());
        assert_eq!(safe_path(&sibling, &roots), Err(SafePathError::Outside));
        // The second root is reached by an absolute path.
        let in_state = roots[1].join("x.txt");
        assert_eq!(safe_path(&in_state.to_string_lossy(), &roots).unwrap(), in_state);
        // `..` that climbs back in is fine.
        assert_eq!(safe_path("a/../b", &roots).unwrap(), roots[0].join("b"));
    }

    #[test]
    fn protected_names_inside_a_root_are_not_accessible() {
        let (_dir, roots) = roots();
        for name in [
            ".credentials.json",
            "sub/.Encryption-Key",
            "api.token",
            ".codex/config",
            ".codex-home-keys/x",
            ".claude-home-abc/settings.json",
            "data/tarsee.db",
            "data/tarsee.DB-wal",
            "auth.json.",
            "auth.json::$DATA",
            "vault.json ",
            "tool-output/1.txt",
        ] {
            assert_eq!(safe_path(name, &roots), Err(SafePathError::NotAccessible), "{name}");
        }
        assert!(safe_path("notes/auth.json.md", &roots).is_ok());
        assert!(safe_path("my.dbx", &roots).is_ok());
    }

    #[test]
    fn sensitive_paths_by_segment_stream_suffix_and_ending() {
        assert!(is_sensitive_path("/state/.credentials.json"));
        assert!(is_sensitive_path("C:\\state\\AUTH.JSON"));
        assert!(is_sensitive_path("/x/backup.credentials.json"));
        assert!(is_sensitive_path("/x/.codex-homework"));
        assert!(!is_sensitive_path("/x/codex"));
        assert!(!is_sensitive_path("/x/my.codex.txt"));
        // A colon after a line break does not cut the segment (the JS `.` does not cross a line break).
        assert_eq!(segment_name("Auth.JSON:stream"), "auth.json");
        assert_eq!(segment_name("a:b\nauth.json"), "a:b\nauth.json");
        assert_eq!(segment_name("a\nauth.json:x"), "a\nauth.json");
        assert_eq!(segment_name("name. . "), "name");
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_forms_resolve_as_node_resolves_them() {
        let root = Path::new("C:\\data\\ws");
        // Rooted on the same drive, forward slashes, and a drive-relative path on the root's drive.
        assert_eq!(resolve_path(root, "\\x"), PathBuf::from("C:\\x"));
        assert_eq!(resolve_path(root, "a/b//c/"), PathBuf::from("C:\\data\\ws\\a\\b\\c"));
        assert_eq!(resolve_path(root, "C:sub"), PathBuf::from("C:\\data\\ws\\sub"));
        assert_eq!(resolve_path(root, "C:"), PathBuf::from("C:\\data\\ws"));
        assert_eq!(resolve_path(root, "..\\..\\..\\.."), PathBuf::from("C:\\"));
        assert_eq!(safe_path("C:sub", &[root]).unwrap(), PathBuf::from("C:\\data\\ws\\sub"));
        // Node kept the drive as the path wrote it, and compared the text: "c:" is not under "C:".
        assert_eq!(resolve_path(root, "c:sub").to_string_lossy(), "c:\\data\\ws\\sub");
        assert_eq!(safe_path("c:sub", &[root]), Err(SafePathError::Outside));
        assert_eq!(join_path(Path::new("C:\\ws\\sub"), "C:foo"), PathBuf::from("C:\\ws\\sub\\C:foo"));
        assert_eq!(relative_path(Path::new("C:\\ws"), Path::new("c:\\WS\\a\\b")), "a\\b");
        assert_eq!(relative_path(Path::new("C:\\ws"), Path::new("D:\\x")), "D:\\x");
        assert_eq!(safe_path("D:\\data\\ws\\x", &[root]), Err(SafePathError::Outside));
        assert_eq!(safe_path("\\\\?\\C:\\data\\ws\\x", &[root]), Err(SafePathError::Outside));
    }

    #[cfg(unix)]
    #[test]
    fn posix_forms_resolve_as_node_resolves_them() {
        let root = Path::new("/data/ws");
        assert_eq!(resolve_path(root, "/x"), PathBuf::from("/x"));
        assert_eq!(resolve_path(root, "a/b//c/"), PathBuf::from("/data/ws/a/b/c"));
        assert_eq!(resolve_path(root, "../../../.."), PathBuf::from("/"));
        assert_eq!(resolve_path(root, "a\\..\\b"), PathBuf::from("/data/ws/a\\..\\b"));
        assert_eq!(join_path(Path::new("/ws/sub"), "/x/../y"), PathBuf::from("/ws/sub/y"));
        // A root of "/" only matches itself, as `startsWith("/" + "/")` did.
        assert_eq!(safe_path("x", &["/"]), Err(SafePathError::Outside));
        assert_eq!(safe_path("/", &["/"]).unwrap(), PathBuf::from("/"));
    }

    #[test]
    fn join_and_relative_follow_node() {
        let base = resolve_path(Path::new("."), "");
        let ws = base.join("ws");
        assert_eq!(join_path(&ws.join("a"), ".."), ws);
        assert_eq!(join_path(&ws, "x/../y"), ws.join("y"));
        assert_eq!(relative_path(&ws, &ws.join("a").join("b")), format!("a{MAIN_SEPARATOR}b"));
        assert_eq!(relative_path(&ws, &ws), "");
        assert_eq!(relative_path(&ws.join("a"), &ws.join("b")), format!("..{MAIN_SEPARATOR}b"));
        assert_eq!(normalize_path(Path::new("a/../../b")), PathBuf::from(format!("..{MAIN_SEPARATOR}b")));
        assert_eq!(normalize_path(Path::new("./")), PathBuf::from("."));
    }

    #[test]
    fn file_errors_read_like_node() {
        let err = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(
            fs_error_message(&err, "stat", Path::new("x.txt")),
            "ENOENT: no such file or directory, stat 'x.txt'"
        );
        let other = std::io::Error::other("odd");
        assert_eq!(fs_error_message(&other, "open", Path::new("x")), "odd");
    }

    // ------------------------------------------------------------ sanitizeFilename

    #[test]
    fn strips_quotes() {
        assert_eq!(sanitize_filename("file\"name.txt"), "file_name.txt");
    }

    #[test]
    fn strips_newlines() {
        assert_eq!(sanitize_filename("file\nname.txt"), "file_name.txt");
    }

    #[test]
    fn strips_non_ascii() {
        assert_eq!(sanitize_filename("file\u{0000}name.txt"), "file_name.txt");
        // One underscore per UTF-16 unit, as the JS replaced them: an emoji is two.
        assert_eq!(sanitize_filename("a\u{1F412}b é"), "a__b__");
        // The tab is not printable, so it is a "_" before the spaces are collapsed.
        assert_eq!(sanitize_filename("a  \t b"), "a___b");
    }

    #[test]
    fn limits_length() {
        let long = "a".repeat(300);
        assert!(sanitize_filename(&long).len() <= 255);
        assert_eq!(sanitize_filename(&long).len(), 255);
    }

    #[test]
    fn returns_download_for_empty_input() {
        assert_eq!(sanitize_filename(""), "download");
    }

    // ------------------------------------------------------------ looksSafeTarPath

    #[test]
    fn allows_relative_paths() {
        assert!(looks_safe_tar_path("workspace/file.txt"));
        assert!(looks_safe_tar_path(".opusclaw/config.json"));
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(!looks_safe_tar_path("/etc/passwd"));
        assert!(!looks_safe_tar_path("\\windows\\system32"));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(!looks_safe_tar_path("../../../etc/passwd"));
        assert!(!looks_safe_tar_path("foo/../../bar"));
        assert!(!looks_safe_tar_path("foo\\..\\bar"));
        assert!(looks_safe_tar_path("foo/..bar/x"));
    }

    #[test]
    fn rejects_windows_drive_paths() {
        assert!(!looks_safe_tar_path("C:\\Windows\\System32"));
        assert!(!looks_safe_tar_path("c:/x"));
        assert!(looks_safe_tar_path("c:x"));
    }

    #[test]
    fn rejects_empty_null() {
        // A null path cannot reach this function in Rust; the empty path takes the same branch.
        assert!(!looks_safe_tar_path(""));
    }
}
