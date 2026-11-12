//! Port of `src/lib/safe-path.js`: keeps a path a person or the model gave inside the folders it may touch, and
//! keeps credentials, keys and databases out of reach even inside them.
//!
//! The Node version leaned on `path.resolve`, `path.join` and `path.relative`, which work on the text of a path and
//! never look at the disk. [`resolve_path`], [`normalize_path`], [`join_path`] and [`relative_path`] are those, so a
//! path ends up exactly where the Node version put it (a `..` that climbs above the root stays at the root, a
//! drive-relative `C:foo` on Windows lands under the root when the root is on that drive). [`fs_error_message`]
//! writes a file error the way Node's `fs` wrote it, for the messages the routes send back.

use std::path::{MAIN_SEPARATOR, Path, PathBuf};

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
        .next_back()
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
    if DENIED_ENDINGS.iter().any(|ending| lower.ends_with(ending)) {
        return true;
    }
    // Not in the Node version: a fix. On Windows a `:` after the drive names an NTFS stream, and
    // `data.db::$DATA` is the database itself, which the `.db` ending above does not see. Any such name is refused.
    cfg!(windows) && has_stream_colon(&text)
}

/// Whether a path has a `:` anywhere but in its drive (`C:`, also after a `\\?\` or `\\.\` prefix).
fn has_stream_colon(text: &str) -> bool {
    let mut rest = text;
    for prefix in [r"\\?\", r"\\.\", "//?/", "//./"] {
        if let Some(after) = rest.strip_prefix(prefix) {
            rest = after;
            break;
        }
    }
    let b = rest.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        rest = &rest[2..];
    }
    rest.contains(':')
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
//
// `safePath` checks the TEXT `path.resolve` gives, so the text must be Node's to the character. These are line by
// line ports of Node's own `path.win32` and `path.posix` code (`resolve`, `dirname`, `relative` and the
// `normalizeString` they share), on UTF-16 units as the JS worked. The platform's flavour is used, as Node's `path`
// did. Nothing here looks at the disk, and nothing goes through `GetFullPathNameW` (which would apply Windows' own
// rewriting of names).

const BACKSLASH: u16 = b'\\' as u16;
const SLASH: u16 = b'/' as u16;
const DOT: u16 = b'.' as u16;
const COLON: u16 = b':' as u16;

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn win32_separator(c: u16) -> bool {
    c == BACKSLASH || c == SLASH
}

fn posix_separator(c: u16) -> bool {
    c == SLASH
}

fn is_device_root(c: u16) -> bool {
    (u16::from(b'A')..=u16::from(b'Z')).contains(&c) || (u16::from(b'a')..=u16::from(b'z')).contains(&c)
}

/// `process.cwd()`.
fn cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Node's `normalizeString(path, allowAboveRoot, separator, isPathSeparator)`: `.` and `..` worked out, doubled
/// separators collapsed, no leading or trailing separator.
fn normalize_string(path: &[u16], allow_above_root: bool, separator: u16, is_sep: fn(u16) -> bool) -> Vec<u16> {
    let mut res: Vec<u16> = Vec::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u16 = 0;
    let len = path.len() as isize;
    let mut i: isize = 0;
    while i <= len {
        if i < len {
            code = path[i as usize];
        } else if is_sep(code) {
            break;
        } else {
            code = SLASH;
        }
        if is_sep(code) {
            if last_slash == i - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let n = res.len();
                if n < 2 || last_segment_length != 2 || res[n - 1] != DOT || res[n - 2] != DOT {
                    if n > 2 {
                        match res.iter().rposition(|&c| c == separator) {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(at) => {
                                res.truncate(at);
                                let last = res.iter().rposition(|&c| c == separator).map_or(-1, |p| p as isize);
                                last_segment_length = res.len() as isize - 1 - last;
                            }
                        }
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if n != 0 {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(separator);
                    }
                    res.extend_from_slice(&[DOT, DOT]);
                    last_segment_length = 2;
                }
            } else {
                if !res.is_empty() {
                    res.push(separator);
                }
                res.extend_from_slice(&path[(last_slash + 1) as usize..i as usize]);
                last_segment_length = i - last_slash - 1;
            }
            last_slash = i;
            dots = 0;
        } else if code == DOT && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

/// Node's `path.win32.resolve(...args)`.
pub fn win32_resolve(args: &[&str]) -> String {
    let mut resolved_device: Vec<u16> = Vec::new();
    let mut resolved_tail: Vec<u16> = Vec::new();
    let mut resolved_absolute = false;
    let mut i = args.len() as isize - 1;
    while i >= -1 {
        let path: Vec<u16> = if i >= 0 {
            let path = units(args[i as usize]);
            // Skip empty entries
            if path.is_empty() {
                i -= 1;
                continue;
            }
            path
        } else if resolved_device.is_empty() {
            let path = units(&cwd());
            // Fast path for current directory
            let only_here = args.is_empty() || (args.len() == 1 && (args[0].is_empty() || args[0] == "."));
            if only_here && path.first().is_some_and(|&c| win32_separator(c)) {
                return text(&path);
            }
            path
        } else {
            // Windows has the concept of drive-specific current working directories. If we've resolved a drive
            // letter but not yet an absolute path, get cwd for that drive, or the process cwd if the drive cwd is
            // not available. (Node read the hidden `=C:` variable; `GetFullPathNameW` on the bare drive reads the
            // same thing, and falls back the same way.)
            let device = text(&resolved_device);
            let drive_cwd = std::path::absolute(Path::new(&device))
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| cwd());
            let mut path = units(&drive_cwd);
            // Verify that a cwd was found and that it actually points to our drive. If not, default to the drive's
            // root.
            let head = text(&path[..path.len().min(2)]).to_lowercase();
            if head != device.to_lowercase() && path.get(2) == Some(&BACKSLASH) {
                path = units(&format!("{device}\\"));
            }
            path
        };

        let len = path.len();
        let mut root_end = 0usize;
        let mut device: Vec<u16> = Vec::new();
        let mut is_absolute = false;
        let code = path.first().copied().unwrap_or(0);

        // Try to match a root
        if len == 1 {
            if win32_separator(code) {
                // `path` contains just a path separator
                root_end = 1;
                is_absolute = true;
            }
        } else if win32_separator(code) {
            // Possible UNC root: we at least have an absolute path of some kind
            is_absolute = true;
            if win32_separator(path[1]) {
                // Matched double path separator at beginning
                let mut j = 2;
                let mut last = j;
                // Match 1 or more non-path separators
                while j < len && !win32_separator(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part = path[last..j].to_vec();
                    last = j;
                    // Match 1 or more path separators
                    while j < len && win32_separator(path[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        // Match 1 or more non-path separators
                        while j < len && !win32_separator(path[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            // We matched a UNC root
                            device = units("\\\\");
                            device.extend_from_slice(&first_part);
                            device.push(BACKSLASH);
                            device.extend_from_slice(&path[last..j]);
                            root_end = j;
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if is_device_root(code) && path[1] == COLON {
            // Possible device root
            device = path[0..2].to_vec();
            root_end = 2;
            if len > 2 && win32_separator(path[2]) {
                // Treat separator following drive name as an absolute path indicator
                is_absolute = true;
                root_end = 3;
            }
        }

        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if text(&device).to_lowercase() != text(&resolved_device).to_lowercase() {
                    // This path points to another device so it is not applicable
                    i -= 1;
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }

        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            let mut tail = path[root_end..].to_vec();
            tail.push(BACKSLASH);
            tail.extend_from_slice(&resolved_tail);
            resolved_tail = tail;
            resolved_absolute = is_absolute;
            if is_absolute && !resolved_device.is_empty() {
                break;
            }
        }
        i -= 1;
    }

    // Normalize the tail path
    let tail = normalize_string(&resolved_tail, !resolved_absolute, BACKSLASH, win32_separator);
    let device = text(&resolved_device);
    if resolved_absolute {
        format!("{device}\\{}", text(&tail))
    } else {
        let out = format!("{device}{}", text(&tail));
        if out.is_empty() { ".".into() } else { out }
    }
}

/// Node's `path.posix.resolve(...args)`.
pub fn posix_resolve(args: &[&str]) -> String {
    if args.is_empty() || (args.len() == 1 && (args[0].is_empty() || args[0] == ".")) {
        let cwd = cwd();
        if cwd.starts_with('/') {
            return cwd;
        }
    }
    let mut resolved = String::new();
    let mut resolved_absolute = false;
    for path in args.iter().rev() {
        if resolved_absolute {
            break;
        }
        // Skip empty entries
        if path.is_empty() {
            continue;
        }
        resolved = format!("{path}/{resolved}");
        resolved_absolute = path.starts_with('/');
    }
    if !resolved_absolute {
        let cwd = cwd();
        resolved = format!("{cwd}/{resolved}");
        resolved_absolute = cwd.starts_with('/');
    }
    let normal = text(&normalize_string(
        &units(&resolved),
        !resolved_absolute,
        SLASH,
        posix_separator,
    ));
    if resolved_absolute {
        format!("/{normal}")
    } else if normal.is_empty() {
        ".".into()
    } else {
        normal
    }
}

/// `path.resolve(...args)` for this platform.
pub fn node_resolve(args: &[&str]) -> String {
    if cfg!(windows) {
        win32_resolve(args)
    } else {
        posix_resolve(args)
    }
}

/// `path.resolve(base, path)`: `path` taken from `base` (made absolute from the current folder if it is relative),
/// worked out as text, exactly as Node did. The disk is never asked.
pub fn resolve_path(base: &Path, path: &str) -> PathBuf {
    PathBuf::from(node_resolve(&[&base.to_string_lossy(), path]))
}

/// Node's `path.win32.dirname(path)`.
pub fn win32_dirname(path: &str) -> String {
    let path = units(path);
    let len = path.len();
    if len == 0 {
        return ".".into();
    }
    let mut root_end: isize = -1;
    let mut offset = 0usize;
    let code = path[0];
    if len == 1 {
        // `path` contains just a path separator, exit early to avoid unnecessary work or a dot.
        return if win32_separator(code) { text(&path) } else { ".".into() };
    }
    // Try to match a root
    if win32_separator(code) {
        // Possible UNC root
        root_end = 1;
        offset = 1;
        if win32_separator(path[1]) {
            // Matched double path separator at beginning
            let mut j = 2;
            let mut last = j;
            // Match 1 or more non-path separators
            while j < len && !win32_separator(path[j]) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                // Match 1 or more path separators
                while j < len && win32_separator(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    // Match 1 or more non-path separators
                    while j < len && !win32_separator(path[j]) {
                        j += 1;
                    }
                    if j == len {
                        // We matched a UNC root only
                        return text(&path);
                    }
                    if j != last {
                        // We matched a UNC root with leftovers
                        root_end = (j + 1) as isize;
                        offset = j + 1;
                    }
                }
            }
        }
    } else if is_device_root(code) && path[1] == COLON {
        // Possible device root
        let end = if len > 2 && win32_separator(path[2]) { 3 } else { 2 };
        root_end = end as isize;
        offset = end;
    }
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = len as isize - 1;
    while i >= offset as isize {
        if win32_separator(path[i as usize]) {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            // We saw the first non-path separator
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        if root_end == -1 {
            return ".".into();
        }
        end = root_end;
    }
    text(&path[..(end as usize).min(len)])
}

/// Node's `path.posix.dirname(path)`.
pub fn posix_dirname(path: &str) -> String {
    let path = units(path);
    if path.is_empty() {
        return ".".into();
    }
    let has_root = path[0] == SLASH;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = path.len() as isize - 1;
    while i >= 1 {
        if path[i as usize] == SLASH {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            // We saw the first non-path separator
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { "/".into() } else { ".".into() };
    }
    if has_root && end == 1 {
        return "//".into();
    }
    text(&path[..end as usize])
}

/// `path.dirname(path)` for this platform.
pub fn node_dirname(path: &str) -> String {
    if cfg!(windows) {
        win32_dirname(path)
    } else {
        posix_dirname(path)
    }
}

/// The device names Node 22's `path.win32.normalize` sets apart.
const WINDOWS_RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
    "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Node's `isWindowsReservedName(path, colonIndex)`: the text before the colon is a device name. As in the JS, a
/// `colonIndex` of -1 takes the text without its last character (`slice(0, -1)`).
fn is_windows_reserved_name(path: &[u16], colon_index: isize) -> bool {
    let end = if colon_index < 0 {
        (path.len() as isize + colon_index).max(0) as usize
    } else {
        (colon_index as usize).min(path.len())
    };
    WINDOWS_RESERVED_NAMES.contains(&text(&path[..end]).to_uppercase().as_str())
}

/// Node's `path.win32.normalize(path)` (Node 22, with the CVE-2024-36139 guard).
pub fn win32_normalize(path_text: &str) -> String {
    let path = units(path_text);
    let len = path.len();
    if len == 0 {
        return ".".into();
    }
    let mut root_end = 0usize;
    let mut device: Option<Vec<u16>> = None;
    let mut is_absolute = false;
    let code = path[0];

    // Try to match a root
    if len == 1 {
        // `path` contains just a single char, exit early to avoid unnecessary work
        return if posix_separator(code) {
            "\\".into()
        } else {
            path_text.to_string()
        };
    }
    if win32_separator(code) {
        // Possible UNC root: we at least have an absolute path of some kind
        is_absolute = true;
        if win32_separator(path[1]) {
            // Matched double path separator at beginning
            let mut j = 2;
            let mut last = j;
            while j < len && !win32_separator(path[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first_part = path[last..j].to_vec();
                last = j;
                while j < len && win32_separator(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !win32_separator(path[j]) {
                        j += 1;
                    }
                    if j == len {
                        // We matched a UNC root only: the normalized root, since there is nothing left to process
                        return format!("\\\\{}\\{}\\", text(&first_part), text(&path[last..]));
                    }
                    if j != last {
                        // We matched a UNC root with leftovers
                        let mut d = units("\\\\");
                        d.extend_from_slice(&first_part);
                        d.push(BACKSLASH);
                        d.extend_from_slice(&path[last..j]);
                        device = Some(d);
                        root_end = j;
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if let Some(colon_index) = path.iter().position(|&c| c == COLON)
        && colon_index > 0
    {
        if is_device_root(code) && colon_index == 1 {
            device = Some(path[0..2].to_vec());
            root_end = 2;
            if len > 2 && win32_separator(path[2]) {
                is_absolute = true;
                root_end = 3;
            }
        } else if is_windows_reserved_name(&path, colon_index as isize) {
            device = Some(path[..=colon_index].to_vec());
            root_end = colon_index + 1;
        }
    }

    let mut tail = if root_end < len {
        normalize_string(&path[root_end..], !is_absolute, BACKSLASH, win32_separator)
    } else {
        Vec::new()
    };
    if tail.is_empty() && !is_absolute {
        tail = vec![DOT];
    }
    if !tail.is_empty() && win32_separator(path[len - 1]) {
        tail.push(BACKSLASH);
    }
    if !is_absolute && device.is_none() && path.contains(&COLON) {
        // If the original path was not absolute and if we have not been able to resolve it relative to a particular
        // device, we need to ensure that the `tail` has not become something that Windows might interpret as an
        // absolute path. See CVE-2024-36139.
        if tail.len() >= 2 && is_device_root(tail[0]) && tail[1] == COLON {
            return format!(".\\{}", text(&tail));
        }
        for (index, &c) in path.iter().enumerate() {
            if c == COLON && (index == len - 1 || win32_separator(path[index + 1])) {
                return format!(".\\{}", text(&tail));
            }
        }
    }
    let colon_index = path.iter().position(|&c| c == COLON).map_or(-1, |i| i as isize);
    let device = device.map(|d| text(&d));
    if is_windows_reserved_name(&path, colon_index) {
        return format!(".\\{}{}", device.unwrap_or_default(), text(&tail));
    }
    match device {
        None if is_absolute => format!("\\{}", text(&tail)),
        None => text(&tail),
        Some(device) if is_absolute => format!("{device}\\{}", text(&tail)),
        Some(device) => format!("{device}{}", text(&tail)),
    }
}

/// Node's `path.win32.join(...args)`.
pub fn win32_join(args: &[&str]) -> String {
    let mut joined: Option<Vec<u16>> = None;
    let mut first_part: Vec<u16> = Vec::new();
    for arg in args {
        let arg = units(arg);
        if arg.is_empty() {
            continue;
        }
        match &mut joined {
            None => {
                first_part = arg.clone();
                joined = Some(arg);
            }
            Some(joined) => {
                joined.push(BACKSLASH);
                joined.extend_from_slice(&arg);
            }
        }
    }
    let Some(mut joined) = joined else {
        return ".".into();
    };
    // Make sure that the joined path doesn't start with two slashes, because normalize() will mistake it for a UNC
    // path then, unless the first part clearly is one (exactly two slashes and a name).
    let mut needs_replace = true;
    let mut slash_count = 0usize;
    if win32_separator(first_part[0]) {
        slash_count += 1;
        let first_len = first_part.len();
        if first_len > 1 && win32_separator(first_part[1]) {
            slash_count += 1;
            if first_len > 2 {
                if win32_separator(first_part[2]) {
                    slash_count += 1;
                } else {
                    // We matched a UNC path in the first part
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        // Find any more consecutive slashes we need to replace
        while slash_count < joined.len() && win32_separator(joined[slash_count]) {
            slash_count += 1;
        }
        // Replace the slashes if needed
        if slash_count >= 2 {
            let mut replaced = vec![BACKSLASH];
            replaced.extend_from_slice(&joined[slash_count..]);
            joined = replaced;
        }
    }
    win32_normalize(&text(&joined))
}

/// Node's `path.posix.normalize(path)`.
pub fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let is_absolute = path.starts_with('/');
    let trailing_separator = path.ends_with('/');
    let normal = text(&normalize_string(&units(path), !is_absolute, SLASH, posix_separator));
    if normal.is_empty() {
        if is_absolute {
            return "/".into();
        }
        return if trailing_separator { "./".into() } else { ".".into() };
    }
    let normal = if trailing_separator {
        format!("{normal}/")
    } else {
        normal
    };
    if is_absolute { format!("/{normal}") } else { normal }
}

/// Node's `path.posix.join(...args)`.
pub fn posix_join(args: &[&str]) -> String {
    let parts: Vec<&str> = args.iter().copied().filter(|a| !a.is_empty()).collect();
    if parts.is_empty() {
        return ".".into();
    }
    posix_normalize(&parts.join("/"))
}

/// `path.join(...args)` for this platform: the pieces put together and normalised. Unlike `Path::join`, an
/// absolute or drive-carrying piece does not replace what is before it.
pub fn node_join(args: &[&str]) -> String {
    if cfg!(windows) {
        win32_join(args)
    } else {
        posix_join(args)
    }
}

/// Node's `path.win32.relative(from, to)`.
pub fn win32_relative(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from_orig = win32_resolve(&[from]);
    let to_orig = win32_resolve(&[to]);
    if from_orig == to_orig {
        return String::new();
    }
    let from_l = from_orig.to_lowercase();
    let to_l = to_orig.to_lowercase();
    if from_l == to_l {
        return String::new();
    }
    let (fo, to_u) = (units(&from_orig), units(&to_orig));
    let (fl, tl) = (units(&from_l), units(&to_l));
    if fo.len() != fl.len() || to_u.len() != tl.len() {
        // Lower case changed a length: compare the names one by one.
        let mut from_split: Vec<&str> = from_orig.split('\\').collect();
        let mut to_split: Vec<&str> = to_orig.split('\\').collect();
        if from_split.last() == Some(&"") {
            from_split.pop();
        }
        if to_split.last() == Some(&"") {
            to_split.pop();
        }
        let (from_len, to_len) = (from_split.len(), to_split.len());
        let length = from_len.min(to_len);
        let mut i = 0;
        while i < length {
            if from_split[i].to_lowercase() != to_split[i].to_lowercase() {
                break;
            }
            i += 1;
        }
        if i == 0 {
            return to_orig;
        } else if i == length {
            if to_len > length {
                return to_split[i..].join("\\");
            }
            if from_len > length {
                return format!("{}..", "..\\".repeat(from_len - 1 - i));
            }
            return String::new();
        }
        return format!("{}{}", "..\\".repeat(from_len - i), to_split[i..].join("\\"));
    }

    // Trim any leading backslashes
    let mut from_start = 0usize;
    while from_start < fl.len() && fl[from_start] == BACKSLASH {
        from_start += 1;
    }
    // Trim trailing backslashes (applicable to UNC paths only)
    let mut from_end = fl.len();
    while from_end > from_start + 1 && fl[from_end - 1] == BACKSLASH {
        from_end -= 1;
    }
    let from_len = from_end - from_start;
    let mut to_start = 0usize;
    while to_start < tl.len() && tl[to_start] == BACKSLASH {
        to_start += 1;
    }
    let mut to_end = tl.len();
    while to_end > to_start + 1 && tl[to_end - 1] == BACKSLASH {
        to_end -= 1;
    }
    let to_len = to_end - to_start;

    // Compare paths to find the longest common path from root
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let from_code = fl[from_start + i];
        if from_code != tl[to_start + i] {
            break;
        } else if from_code == BACKSLASH {
            last_common_sep = i as isize;
        }
        i += 1;
    }

    // We found a mismatch before the first common path separator was seen, so return the original `to`.
    if i != length {
        if last_common_sep == -1 {
            return to_orig;
        }
    } else {
        if to_len > length {
            if tl[to_start + i] == BACKSLASH {
                // `from` is the exact base path for `to`: from='C:\foo\bar'; to='C:\foo\bar\baz'
                return text(&to_u[to_start + i + 1..]);
            }
            if i == 2 {
                // `from` is the device root: from='C:\'; to='C:\foo'
                return text(&to_u[to_start + i..]);
            }
        }
        if from_len > length {
            if fl[from_start + i] == BACKSLASH {
                // `to` is the exact base path for `from`: from='C:\foo\bar'; to='C:\foo'
                last_common_sep = i as isize;
            } else if i == 2 {
                // `to` is the device root: from='C:\foo\bar'; to='C:\'
                last_common_sep = 3;
            }
        }
        if last_common_sep == -1 {
            last_common_sep = 0;
        }
    }

    let mut out = String::new();
    // Generate the relative path based on the path difference between `to` and `from`
    let mut k = (from_start as isize + last_common_sep + 1) as usize;
    while k <= from_end {
        if k == from_end || fl[k] == BACKSLASH {
            out.push_str(if out.is_empty() { ".." } else { "\\.." });
        }
        k += 1;
    }
    let mut to_start = (to_start as isize + last_common_sep) as usize;

    // Lastly, append the rest of the destination (`to`) path that comes after the common path parts
    if !out.is_empty() {
        return format!("{out}{}", text(&to_u[to_start.min(to_end)..to_end]));
    }
    if to_u.get(to_start) == Some(&BACKSLASH) {
        to_start += 1;
    }
    text(&to_u[to_start.min(to_end)..to_end])
}

/// Node's `path.posix.relative(from, to)`.
pub fn posix_relative(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from = units(&posix_resolve(&[from]));
    let to = units(&posix_resolve(&[to]));
    if from == to {
        return String::new();
    }
    let from_start = 1usize;
    let from_end = from.len();
    let from_len = from_end - from_start;
    let to_start = 1usize;
    let to_len = to.len() - to_start;

    // Compare paths to find the longest common path from root
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let from_code = from[from_start + i];
        if from_code != to[to_start + i] {
            break;
        } else if from_code == SLASH {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i == length {
        if to_len > length {
            if to[to_start + i] == SLASH {
                // `from` is the exact base path for `to`: from='/foo/bar'; to='/foo/bar/baz'
                return text(&to[to_start + i + 1..]);
            }
            if i == 0 {
                // `from` is the root: from='/'; to='/foo'
                return text(&to[to_start + i..]);
            }
        } else if from_len > length {
            if from[from_start + i] == SLASH {
                // `to` is the exact base path for `from`: from='/foo/bar/baz'; to='/foo/bar'
                last_common_sep = i as isize;
            } else if i == 0 {
                // `to` is the root: from='/foo/bar'; to='/'
                last_common_sep = 0;
            }
        }
    }
    let mut out = String::new();
    // Generate the relative path based on the path difference between `to` and `from`.
    let mut k = (from_start as isize + last_common_sep + 1) as usize;
    while k <= from_end {
        if k == from_end || from[k] == SLASH {
            out.push_str(if out.is_empty() { ".." } else { "/.." });
        }
        k += 1;
    }
    let rest = (to_start as isize + last_common_sep) as usize;
    format!("{out}{}", text(&to[rest.min(to.len())..]))
}

/// `path.relative(from, to)` for this platform: the way from one folder to another, with `..` for each step up
/// ("" when they are the same).
pub fn relative_path(from: &Path, to: &Path) -> String {
    let (from, to) = (from.to_string_lossy(), to.to_string_lossy());
    if cfg!(windows) {
        win32_relative(&from, &to)
    } else {
        posix_relative(&from, &to)
    }
}

/// Whether two paths name the same place once each is normalised: compared as paths, never as text (and on
/// Windows without regard to case, as the file system compares names).
pub fn same_path(a: &Path, b: &Path) -> bool {
    path_key(a) == path_key(b)
}

/// Whether `path` is strictly inside `root` (below it, not the root itself), compared as paths after normalising.
pub fn is_inside(root: &Path, path: &Path) -> bool {
    let (root, path) = (path_key(root), path_key(path));
    path.len() > root.len() && path[..root.len()] == root[..]
}

/// A path as the list of its names, after Node's `normalize` (`PathBuf` would let a name such as `b:s` replace the
/// whole path), without a trailing separator; lower case on Windows.
fn path_key(p: &Path) -> Vec<String> {
    let text = p.to_string_lossy();
    let (normal, separator) = if cfg!(windows) {
        (win32_normalize(&text).to_lowercase(), '\\')
    } else {
        (posix_normalize(&text), '/')
    };
    normal
        .trim_end_matches(separator)
        .split(separator)
        .map(String::from)
        .collect()
}

/// A file system error written the way Node's `fs` wrote it: `ENOENT: no such file or directory, open '<path>'`.
/// Errors Node had no code for keep Rust's own text.
pub fn fs_error_message(err: &std::io::Error, syscall: &str, path: &Path) -> String {
    node_fs_error(err, syscall, &format!("'{}'", path.display()))
}

/// [`fs_error_message`] for a call with two paths: `ENOENT: no such file or directory, rename '<a>' -> '<b>'`.
pub fn fs_error_message_two(err: &std::io::Error, syscall: &str, from: &Path, to: &Path) -> String {
    node_fs_error(err, syscall, &format!("'{}' -> '{}'", from.display(), to.display()))
}

fn node_fs_error(err: &std::io::Error, syscall: &str, paths: &str) -> String {
    match uv_error(err) {
        Some((code, text)) => format!("{code}: {text}, {syscall} {paths}"),
        None => err.to_string(),
    }
}

/// libuv's code and text for an I/O error, as Node's `fs` reported it.
pub fn uv_error(err: &std::io::Error) -> Option<(&'static str, &'static str)> {
    #[cfg(windows)]
    if let Some(code) = err.raw_os_error() {
        return Some(uv_from_windows(code));
    }
    #[cfg(unix)]
    match err.raw_os_error() {
        // The two errno values std files under one kind; the same numbers on Linux and macOS.
        Some(1) => return Some(EPERM),
        Some(13) => return Some(EACCES),
        Some(40) if cfg!(target_os = "linux") => return Some(ELOOP),
        Some(62) if cfg!(target_os = "macos") => return Some(ELOOP),
        _ => {}
    }
    use std::io::ErrorKind as K;
    Some(match err.kind() {
        K::NotFound => ENOENT,
        K::PermissionDenied => EACCES,
        K::AlreadyExists => EEXIST,
        K::IsADirectory => EISDIR,
        K::NotADirectory => ENOTDIR,
        K::DirectoryNotEmpty => ENOTEMPTY,
        K::ResourceBusy => EBUSY,
        K::CrossesDevices => EXDEV,
        K::ReadOnlyFilesystem => EROFS,
        K::StorageFull => ENOSPC,
        K::InvalidFilename => ENAMETOOLONG,
        K::FileTooLarge => ("EFBIG", "file too large"),
        K::ExecutableFileBusy => ("ETXTBSY", "text file is busy"),
        K::TooManyLinks => ("EMLINK", "too many links"),
        _ => return None,
    })
}

const ENOENT: (&str, &str) = ("ENOENT", "no such file or directory");
const EACCES: (&str, &str) = ("EACCES", "permission denied");
const EPERM: (&str, &str) = ("EPERM", "operation not permitted");
const EEXIST: (&str, &str) = ("EEXIST", "file already exists");
const EISDIR: (&str, &str) = ("EISDIR", "illegal operation on a directory");
const ENOTDIR: (&str, &str) = ("ENOTDIR", "not a directory");
const ENOTEMPTY: (&str, &str) = ("ENOTEMPTY", "directory not empty");
const EBUSY: (&str, &str) = ("EBUSY", "resource busy or locked");
const EXDEV: (&str, &str) = ("EXDEV", "cross-device link not permitted");
const EROFS: (&str, &str) = ("EROFS", "read-only file system");
const ENOSPC: (&str, &str) = ("ENOSPC", "no space left on device");
const ENAMETOOLONG: (&str, &str) = ("ENAMETOOLONG", "name too long");
const ELOOP: (&str, &str) = ("ELOOP", "too many symbolic links encountered");

/// libuv's `uv_translate_sys_error` for the Windows errors a file call can give (texts from Node's
/// `util.getSystemErrorMap()`).
#[cfg(windows)]
fn uv_from_windows(code: i32) -> (&'static str, &'static str) {
    match code {
        // ERROR_NOACCESS, ERROR_ELEVATION_REQUIRED, ERROR_CANT_ACCESS_FILE
        998 | 740 | 1920 => EACCES,
        // ERROR_NO_DATA
        232 => ("EAGAIN", "resource temporarily unavailable"),
        // ERROR_INVALID_FLAGS, ERROR_INVALID_HANDLE
        1004 | 6 => ("EBADF", "bad file descriptor"),
        // ERROR_LOCK_VIOLATION, ERROR_PIPE_BUSY, ERROR_SHARING_VIOLATION
        33 | 231 | 32 => EBUSY,
        // ERROR_OPERATION_ABORTED
        995 => ("ECANCELED", "operation canceled"),
        // ERROR_NO_UNICODE_TRANSLATION
        1113 => ("ECHARSET", "invalid Unicode character"),
        // ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS
        183 | 80 => EEXIST,
        // ERROR_BUFFER_OVERFLOW
        111 => ("EFAULT", "bad address in system call argument"),
        // ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_DATA, ERROR_INVALID_PARAMETER, ERROR_SYMLINK_NOT_SUPPORTED
        122 | 13 | 87 | 1464 => ("EINVAL", "invalid argument"),
        // device and media errors
        1102 | 1111 | 23 | 1107 | 1165 | 1393 | 1129 | 1101 | 31 | 1106 | 1117 | 1104 | 205 | 110 | 1103 | 156 => {
            ("EIO", "i/o error")
        }
        // ERROR_CANT_RESOLVE_FILENAME
        1921 => ELOOP,
        // ERROR_TOO_MANY_OPEN_FILES
        4 => ("EMFILE", "too many open files"),
        // ERROR_FILENAME_EXCED_RANGE
        206 => ENAMETOOLONG,
        // ERROR_BAD_PATHNAME, ERROR_DIRECTORY, ERROR_ENVVAR_NOT_FOUND, ERROR_FILE_NOT_FOUND, ERROR_INVALID_NAME,
        // ERROR_INVALID_DRIVE, ERROR_INVALID_REPARSE_DATA, ERROR_MOD_NOT_FOUND, ERROR_PATH_NOT_FOUND
        161 | 267 | 203 | 2 | 123 | 15 | 4392 | 126 | 3 => ENOENT,
        // ERROR_NOT_ENOUGH_MEMORY, ERROR_OUTOFMEMORY
        8 | 14 => ("ENOMEM", "not enough memory"),
        // ERROR_CANNOT_MAKE, ERROR_DISK_FULL, ERROR_EA_TABLE_FULL, ERROR_END_OF_MEDIA, ERROR_HANDLE_DISK_FULL
        82 | 112 | 277 | 1100 | 39 => ENOSPC,
        // ERROR_DIR_NOT_EMPTY
        145 => ENOTEMPTY,
        // ERROR_NOT_SUPPORTED
        50 => ("ENOTSUP", "operation not supported on socket"),
        // ERROR_BROKEN_PIPE
        109 => ("EOF", "end of file"),
        // ERROR_ACCESS_DENIED, ERROR_PRIVILEGE_NOT_HELD
        5 | 1314 => EPERM,
        // ERROR_BAD_PIPE, ERROR_PIPE_NOT_CONNECTED
        230 | 233 => ("EPIPE", "broken pipe"),
        // ERROR_WRITE_PROTECT
        19 => EROFS,
        // ERROR_SEM_TIMEOUT
        121 => ("ETIMEDOUT", "connection timed out"),
        // ERROR_NOT_SAME_DEVICE
        17 => EXDEV,
        // ERROR_INVALID_FUNCTION
        1 => EISDIR,
        // ERROR_META_EXPANSION_TOO_LONG
        208 => ("E2BIG", "argument list too long"),
        // ERROR_BAD_EXE_FORMAT
        193 => ("EFTYPE", "inappropriate file type or format"),
        _ => ("UNKNOWN", "unknown error"),
    }
}

/// Node's refusal of a path holding a NUL character, made before any system call:
/// `The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '...'`. `None` when the
/// path has no NUL. `argument` is the parameter's name (`path`, `oldPath`, `newPath`).
pub fn nul_in_path(argument: &str, path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    text.contains('\0').then(|| {
        format!(
            "The argument '{argument}' must be a string, Uint8Array, or URL without null bytes. Received {}",
            inspect_string(&text)
        )
    })
}

/// `util.inspect(text)` for a string: quoted with `'` (or `"` when the text has a `'` and no `"`, or a backtick
/// when it has both), backslashes and control characters escaped.
fn inspect_string(text: &str) -> String {
    let quote = if !text.contains('\'') {
        '\''
    } else if !text.contains('"') {
        '"'
    } else if !text.contains('`') && !text.contains("${") {
        '`'
    } else {
        '\''
    };
    let mut out = String::new();
    out.push(quote);
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '\'' if quote == '\'' => out.push_str("\\'"),
            c if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) => {
                out.push_str(&format!("\\x{:02X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
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

    /// Node's own answers (`path.win32`, `path.posix` and `safePath`, run by the Node version on many roots and
    /// inputs: drives, UNC shares, `\\?\`, relative roots, trailing dots and spaces, device names, NUL, `..` in every
    /// place). `<CWD>` and `<DRIVE>` stand for the current folder and its drive.
    #[derive(serde::Deserialize)]
    struct NodeCases {
        win32_resolve: Vec<(String, String, String)>,
        win32_relative: Vec<(String, String, String)>,
        win32_dirname: Vec<(String, String)>,
        posix_resolve: Vec<(String, String, String)>,
        posix_relative: Vec<(String, String, String)>,
        posix_dirname: Vec<(String, String)>,
        safe_path: Vec<(String, String, String, String)>,
        win32_normalize: Vec<(String, String)>,
        posix_normalize: Vec<(String, String)>,
        win32_join: Vec<(String, String, String)>,
        posix_join: Vec<(String, String, String)>,
    }

    fn node_cases() -> NodeCases {
        serde_json::from_str(include_str!("safe_path/node_cases.json")).unwrap()
    }

    #[test]
    fn posix_resolve_relative_and_dirname_give_nodes_answers() {
        let cases = node_cases();
        for (root, input, want) in &cases.posix_resolve {
            assert_eq!(&posix_resolve(&[root, input]), want, "resolve({root:?}, {input:?})");
        }
        for (from, to, want) in &cases.posix_relative {
            assert_eq!(&posix_relative(from, to), want, "relative({from:?}, {to:?})");
        }
        for (path, want) in &cases.posix_dirname {
            assert_eq!(&posix_dirname(path), want, "dirname({path:?})");
        }
        for (path, want) in &cases.win32_dirname {
            assert_eq!(&win32_dirname(path), want, "win32 dirname({path:?})");
        }
        // normalize and join do not look at the current folder: both flavours everywhere.
        for (path, want) in &cases.win32_normalize {
            assert_eq!(&win32_normalize(path), want, "win32 normalize({path:?})");
        }
        for (path, want) in &cases.posix_normalize {
            assert_eq!(&posix_normalize(path), want, "posix normalize({path:?})");
        }
        for (a, b, want) in &cases.win32_join {
            assert_eq!(&win32_join(&[a, b]), want, "win32 join({a:?}, {b:?})");
        }
        for (a, b, want) in &cases.posix_join {
            assert_eq!(&posix_join(&[a, b]), want, "posix join({a:?}, {b:?})");
        }
    }

    /// The Windows cases need a Windows current folder (a drive), as Node's answers had.
    #[cfg(windows)]
    #[test]
    fn win32_resolve_relative_and_safe_path_give_nodes_answers() {
        let cwd = cwd();
        let drive = &cwd[..2];
        let fill = |s: &str| s.replace("<CWD>", &cwd).replace("<DRIVE>", drive);
        let cases = node_cases();
        for (root, input, want) in &cases.win32_resolve {
            assert_eq!(
                win32_resolve(&[root, input]),
                fill(want),
                "resolve({root:?}, {input:?})"
            );
        }
        for (from, to, want) in &cases.win32_relative {
            assert_eq!(win32_relative(from, to), fill(want), "relative({from:?}, {to:?})");
        }
        let mut checked = 0;
        for (root, input, kind, want) in &cases.safe_path {
            // The Rust version refuses a `:` after the drive (an NTFS stream): a fix, tested below.
            let mut after_drive = input.as_str();
            if after_drive.as_bytes().get(1) == Some(&b':') {
                after_drive = &after_drive[2..];
            }
            if after_drive.contains(':') || want.contains("::") {
                continue;
            }
            let got = match safe_path(input, &[root]) {
                Ok(path) => ("ok".to_string(), path.to_string_lossy().into_owned()),
                Err(err) => ("err".to_string(), err.to_string()),
            };
            let want = (kind.clone(), if kind == "ok" { fill(want) } else { want.clone() });
            if want.0 == "ok" && has_stream_colon(&want.1) {
                continue;
            }
            assert_eq!(got, want, "safePath({input:?}, [{root:?}])");
            checked += 1;
        }
        assert!(checked > 400, "{checked}");
    }

    #[test]
    fn a_name_that_windows_would_rewrite_stays_a_name_of_its_own() {
        let (_dir, roots) = roots();
        // `...`, `a.txt.`, `nul`, `con`, `a. `: each is a name inside the root as written, never the root itself or
        // another file (Windows would make `...` the folder and `a.txt.` the file a.txt; Node did not, nor do we).
        for name in ["...", "a.txt.", "nul", "con", "a. ", ". ", ".. "] {
            let got = safe_path(name, &roots).unwrap();
            assert_eq!(
                got,
                PathBuf::from(format!("{}{MAIN_SEPARATOR}{name}", roots[0].display())),
                "{name:?}"
            );
            assert!(!same_path(&got, &roots[0]), "{name:?}");
        }
        // A database stays protected however its end is written.
        assert_eq!(safe_path("data.db", &roots), Err(SafePathError::NotAccessible));
    }

    /// Fixed in the Rust version: on Windows a `:` after the drive is an NTFS stream, and `data.db::$DATA` is the
    /// database itself, which the `.db` ending does not see. Every such name is refused.
    #[cfg(windows)]
    #[test]
    fn a_stream_name_is_refused_on_windows() {
        let (_dir, roots) = roots();
        for name in ["data.db::$DATA", "x.db:secret", "a.txt::$DATA", "a:b"] {
            let got = safe_path(name, &roots);
            assert!(
                matches!(got, Err(SafePathError::NotAccessible) | Err(SafePathError::Outside)),
                "{name:?}: {got:?}"
            );
        }
        assert_eq!(safe_path("data.db::$DATA", &roots), Err(SafePathError::NotAccessible));
        assert!(is_sensitive_path(r"C:\ws\notes.txt:hidden"));
        assert!(is_sensitive_path(r"\\?\C:\ws\a:b"));
        assert!(!is_sensitive_path(r"C:\ws\notes.txt"));
        assert!(!is_sensitive_path(r"\\?\C:\ws\notes.txt"));
    }

    #[cfg(not(windows))]
    #[test]
    fn a_colon_is_an_ordinary_character_elsewhere() {
        let (_dir, roots) = roots();
        assert!(safe_path("a:b.txt", &roots).is_ok());
        assert_eq!(safe_path("data.db::x", &roots).map(|_| ()), Ok(()));
    }

    #[test]
    fn paths_compare_as_paths() {
        let base = PathBuf::from(cwd());
        let ws = base.join("ws");
        assert!(same_path(
            &ws,
            &PathBuf::from(format!("{}{MAIN_SEPARATOR}", ws.display()))
        ));
        assert!(same_path(&ws, &ws.join("a").join("..")));
        assert!(same_path(&ws, &ws.join(".")));
        assert!(!same_path(&ws, &base.join("ws-old")));
        assert!(is_inside(&ws, &ws.join("a")));
        assert!(!is_inside(&ws, &ws));
        assert!(!is_inside(&ws, &base.join("ws-old").join("a")));
        assert!(!is_inside(&ws, &base));
        assert!(is_inside(&ws, &ws.join("...")));
        assert_eq!(cfg!(windows), same_path(&ws, &base.join("WS")));
        assert_eq!(
            relative_path(&ws, &ws.join("a").join("b")),
            format!("a{MAIN_SEPARATOR}b")
        );
        assert_eq!(relative_path(&ws, &ws), "");
        assert_eq!(
            relative_path(&ws.join("a"), &ws.join("b")),
            format!("..{MAIN_SEPARATOR}b")
        );
    }

    #[test]
    fn a_nul_in_a_path_is_refused_with_nodes_words() {
        assert_eq!(nul_in_path("path", Path::new("ok.txt")), None);
        assert_eq!(
            nul_in_path("path", Path::new("a\0b")).unwrap(),
            r"The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received 'a\x00b'"
        );
        assert_eq!(
            nul_in_path("oldPath", Path::new("it's\0")).unwrap(),
            r#"The argument 'oldPath' must be a string, Uint8Array, or URL without null bytes. Received "it's\x00""#
        );
        assert_eq!(inspect_string("a\\b\n"), r"'a\\b\n'");
        assert_eq!(inspect_string("'\"`"), r#"'\'"`'"#);
        assert_eq!(inspect_string("'\""), "`'\"`");
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
        let code = |raw: i32| uv_error(&std::io::Error::from_raw_os_error(raw)).map(|(c, _)| c);
        if cfg!(windows) {
            // libuv's translation, as Node reported each (confirmed by running Node on Windows).
            assert_eq!(code(123), Some("ENOENT"), "ERROR_INVALID_NAME (a name Windows refuses)");
            assert_eq!(code(267), Some("ENOENT"), "ERROR_DIRECTORY");
            assert_eq!(code(5), Some("EPERM"), "ERROR_ACCESS_DENIED");
            assert_eq!(code(145), Some("ENOTEMPTY"));
            assert_eq!(code(1), Some("EISDIR"), "ERROR_INVALID_FUNCTION");
            assert_eq!(code(206), Some("ENAMETOOLONG"));
            assert_eq!(code(32), Some("EBUSY"));
            assert_eq!(code(99_999), Some("UNKNOWN"));
            assert_eq!(
                fs_error_message_two(
                    &std::io::Error::from_raw_os_error(3),
                    "rename",
                    Path::new("a"),
                    Path::new("x:s")
                ),
                "ENOENT: no such file or directory, rename 'a' -> 'x:s'"
            );
        } else {
            assert_eq!(code(1), Some("EPERM"));
            assert_eq!(code(13), Some("EACCES"));
            assert_eq!(code(2), Some("ENOENT"));
            assert_eq!(code(21), Some("EISDIR"));
        }
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
