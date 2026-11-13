//! Port of `src/lib/plugin-loader.js`: finds the workspace's plugins.
//!
//! A workspace plugin was a JavaScript module, `workspace/plugins/<name>/index.js`, which a Rust program cannot load
//! (docs/rust-port/DESIGN.md, decision 5). Each one is logged and listed, and none is run; plugins written in Rust are
//! registered in code (`lib/plugin_sdk.rs`).

use crate::app::App;
use crate::lib::workspace_files::jstext::read_dir_sorted;

/// The JavaScript plugins in `workspace/plugins/` (folder names), each logged as not run.
pub fn load_plugins(app: &App) -> Vec<String> {
    let dir = app.config().workspace_dir.join("plugins");
    // No plugins folder, no plugins.
    let Ok(entries) = read_dir_sorted(&dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !crate::util::node_path::to_namespaced(&dir.join(&name).join("index.js")).exists() {
            continue;
        }
        log::warn!("[plugins] {name} is a JavaScript plugin, which this version of Tarsee cannot run");
        found.push(name);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{CapturedLogs, test_app};

    #[test]
    fn javascript_plugins_are_found_logged_and_not_run() {
        let t = test_app();
        assert!(load_plugins(&t).is_empty(), "no plugins folder");
        let dir = t.config().workspace_dir.join("plugins");
        for name in ["weather", "crm"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
            std::fs::write(dir.join(name).join("index.js"), "export default { name: 'x' }").unwrap();
        }
        std::fs::create_dir_all(dir.join("half-made")).unwrap();
        std::fs::write(dir.join("index.js"), "not in a folder").unwrap();
        let logs = CapturedLogs::start();
        assert_eq!(load_plugins(&t), ["crm", "weather"]);
        assert_eq!(
            logs.warnings(),
            [
                "[plugins] crm is a JavaScript plugin, which this version of Tarsee cannot run",
                "[plugins] weather is a JavaScript plugin, which this version of Tarsee cannot run",
            ]
        );
    }
}
