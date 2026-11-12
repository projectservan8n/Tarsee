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
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// `path.join(base, piece)` for a piece the program itself wrote (never for one that came from outside: see
/// "Joining paths" in the design). The result is normalised, as Node's is.
pub fn join(base: &Path, piece: impl AsRef<Path>) -> PathBuf {
    normalize(&base.join(piece))
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
    fn join_is_normalised() {
        let joined = join(Path::new("/data/tarsee/"), "workspace/../data");
        assert_eq!(joined.to_string_lossy().replace('\\', "/"), "/data/tarsee/data");
    }
}
