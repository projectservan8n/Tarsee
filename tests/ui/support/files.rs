//! The files the UI tests read: the browser files (where the server finds them) and other files of the repository.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// The browser UI's folder, as the server finds it (`Config::public_dir`).
pub fn public_dir() -> &'static Path {
    static DIR: LazyLock<PathBuf> = LazyLock::new(|| tarsee::testkit::test_app().config().public_dir());
    &DIR
}

/// A browser file as text: `read_public("index.html")`, `read_public("js/setup.js")`.
pub fn read_public(path: &str) -> String {
    let file = public_dir().join(path);
    std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{} could not be read: {e}", file.display()))
}

/// A file of the repository as text, by its path from the repository's root: `read_repo("docs/providers.md")`.
pub fn read_repo(path: &str) -> String {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{} could not be read: {e}", file.display()))
}
