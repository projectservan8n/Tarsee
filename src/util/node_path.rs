//! Node's `path` module, where Rust's `std::path` behaves differently.
//!
//! Node's `path.join` and `path.normalize` tidy a path as text: `a/./b/../c` becomes `a/c`, doubled separators
//! collapse, a trailing separator goes. Rust's `Path::join` and `components()` drop `.` and doubled separators
//! but keep `..`, so two spellings of one folder stay different, and a check that compares paths can be fooled.

use std::path::{Component, Path, PathBuf};

/// `path.normalize(p)`: the same path with `.` removed and each `..` taken out together with the folder before it.
/// It works on the text only (it does not look at the disk or follow links), as Node's does. A `..` that would go
/// above the root is dropped; one that goes above the start of a relative path is kept. An empty path is `.`.
pub fn normalize(path: &Path) -> PathBuf {
    // The parts are kept apart and put together as text at the end. Building the result with `PathBuf::push` would
    // be wrong on Windows: a folder named like a drive in the middle of a path (`a\C:\b`) would replace everything
    // before it, because `push` treats any piece that starts with a drive as a new path.
    let mut prefix: Option<&std::ffi::OsStr> = None;
    let mut rooted = false;
    let mut names: Vec<&std::ffi::OsStr> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(found) => prefix = Some(found.as_os_str()),
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => match names.last() {
                Some(last) if *last != ".." => {
                    names.pop();
                }
                // Above the root there is nothing: the step is dropped. Above the start of a relative path it is kept.
                _ if rooted => {}
                _ => names.push(std::ffi::OsStr::new("..")),
            },
            Component::Normal(name) => names.push(name),
        }
    }
    let mut out = std::ffi::OsString::new();
    if let Some(prefix) = prefix {
        out.push(prefix);
    }
    if rooted {
        out.push(std::path::MAIN_SEPARATOR_STR);
    }
    for (i, name) in names.iter().enumerate() {
        if i > 0 {
            out.push(std::path::MAIN_SEPARATOR_STR);
        }
        out.push(name);
    }
    if out.is_empty() {
        out.push(".");
    }
    PathBuf::from(out)
}

/// `path.join(base, piece)` for a piece the program itself wrote (never for one that came from outside: see
/// "Joining paths" in the design). The result is normalised, as Node's is.
pub fn join(base: &Path, piece: impl AsRef<Path>) -> PathBuf {
    normalize(&base.join(piece))
}

/// `path.toNamespacedPath(p)`: on Windows, an absolute path in the form the system takes literally
/// (`\\?\C:\dir\name`); the path itself everywhere else, and for a relative path.
///
/// Node's file functions pass every path this way, so a name means exactly what it says. Rust's `std::fs` passes
/// paths as they are, and Windows then rewrites the last name: it drops trailing dots and spaces (`data.db.` opens
/// `data.db`, `...` opens the folder itself) and turns `nul`, `con`, `com1` and friends into devices. A check made
/// on the name as written then passes for a file that is not the one opened. **Every file operation on a path that
/// contains a name from outside the program (a request, a tool argument, an archive, a chat platform) goes through
/// this function**, for the check and for the operation alike.
pub fn to_namespaced(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if text.starts_with(r"\\?\") || text.starts_with(r"\\.\") || !path.is_absolute() {
            return path.to_path_buf();
        }
        // The literal form takes no `.`, no `..` and no forward slashes: normalise first.
        let normal = normalize(path);
        let normal = normal.to_string_lossy();
        match normal.strip_prefix(r"\\") {
            // \\server\share\x becomes \\?\UNC\server\share\x
            Some(unc) => PathBuf::from(format!(r"\\?\UNC\{unc}")),
            None => PathBuf::from(format!(r"\\?\{normal}")),
        }
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(text: &str) -> String {
        normalize(Path::new(text)).to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn dots_doubled_and_trailing_separators_go() {
        assert_eq!(n("a/./b"), "a/b");
        assert_eq!(n("a//b/"), "a/b");
        assert_eq!(n("./a"), "a");
        assert_eq!(n(""), ".");
        assert_eq!(n("."), ".");
    }

    #[test]
    fn a_parent_step_takes_out_the_folder_before_it() {
        assert_eq!(n("a/b/../c"), "a/c");
        assert_eq!(n("a/b/../../c"), "c");
        assert_eq!(n("a/.."), ".");
        assert_eq!(n("../a"), "../a");
        assert_eq!(n("a/../../b"), "../b");
    }

    #[test]
    fn a_parent_step_cannot_go_above_the_root() {
        assert_eq!(n("/a/../../b"), "/b");
        assert_eq!(n("/.."), "/");
        #[cfg(windows)]
        assert_eq!(n("C:\\a\\..\\..\\b"), "C:/b");
    }

    #[test]
    fn a_relative_path_is_left_alone() {
        assert_eq!(to_namespaced(Path::new("a/b.")), PathBuf::from("a/b."));
    }

    #[cfg(not(windows))]
    #[test]
    fn elsewhere_a_path_is_already_literal() {
        assert_eq!(to_namespaced(Path::new("/data/name. ")), PathBuf::from("/data/name. "));
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_an_absolute_path_gets_the_literal_form() {
        assert_eq!(
            to_namespaced(Path::new(r"C:\data\a.txt.")),
            PathBuf::from(r"\\?\C:\data\a.txt.")
        );
        assert_eq!(
            to_namespaced(Path::new("C:/data/x/../nul")),
            PathBuf::from(r"\\?\C:\data\nul")
        );
        assert_eq!(
            to_namespaced(Path::new(r"\\server\share\f ")),
            PathBuf::from(r"\\?\UNC\server\share\f ")
        );
        assert_eq!(
            to_namespaced(Path::new(r"\\?\C:\already")),
            PathBuf::from(r"\\?\C:\already")
        );
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_literal_form_names_the_file_as_written() {
        let dir = crate::testkit::tmp_dir();
        std::fs::write(dir.path().join("data.db"), "secret").unwrap();
        // As written, the system drops the trailing dot and opens data.db.
        assert!(dir.path().join("data.db.").exists());
        // The literal form does not: there is no file named "data.db.".
        assert!(!to_namespaced(&dir.path().join("data.db.")).exists());
        assert!(to_namespaced(&dir.path().join("data.db")).exists());
        // "..." is the folder itself as written, and nothing at all in the literal form.
        assert!(dir.path().join("...").is_dir());
        assert!(!to_namespaced(&dir.path().join("...")).exists());
        // A device name is an ordinary name in the literal form.
        std::fs::write(to_namespaced(&dir.path().join("nul")), "kept").unwrap();
        assert_eq!(
            std::fs::read_to_string(to_namespaced(&dir.path().join("nul"))).unwrap(),
            "kept"
        );
        std::fs::remove_file(to_namespaced(&dir.path().join("nul"))).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_named_like_a_drive_in_the_middle_of_a_path_stays_a_folder() {
        assert_eq!(n("a\\C:\\b"), "a/C:/b");
        assert_eq!(n("C:\\data\\D:\\x\\..\\y"), "C:/data/D:/y");
        assert_eq!(normalize(Path::new("C:\\ws\\E:")), PathBuf::from("C:\\ws\\E:"));
    }

    #[test]
    fn a_relative_path_can_climb_and_a_rooted_one_cannot() {
        assert_eq!(n("../../a"), "../../a");
        assert_eq!(n("a/../../../b"), "../../b");
        assert_eq!(n("/a/../../../b"), "/b");
    }

    #[test]
    fn join_is_normalised() {
        let joined = join(Path::new("/data/tarsee/"), "workspace/../data");
        assert_eq!(joined.to_string_lossy().replace('\\', "/"), "/data/tarsee/data");
    }
}
