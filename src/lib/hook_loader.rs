//! Port of `src/lib/hook-loader.js`: finds the hooks and registers them.
//!
//! The Node version imported every `.js` file of `src/hooks/` (the built-in hooks) and of `workspace/hooks/` (the
//! owner's). A Rust program cannot load JavaScript (docs/rust-port/DESIGN.md, decision 5), so:
//!
//! - the three built-in hooks are Rust (`src/hooks/`) and registered here;
//! - a workspace hook is a program: `workspace/hooks/<name>.hook.json` names it and its events, and on each event it
//!   is started with the event as JSON on stdin; what it prints on stdout, when that is JSON, is its result
//!   (docs/hooks.md);
//! - a `workspace/hooks/*.js` file is not run: it is logged, once per file, and listed in what [`load_hooks`]
//!   returns, so the UI or the doctor can show it.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use crate::app::{App, WeakApp};
use crate::lib::hooks::{HookOptions, HookRegistry};
use crate::lib::workspace_files::jstext::read_dir_sorted;

/// A workspace hook's manifest, `workspace/hooks/<name>.hook.json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct HookManifest {
    /// The hook's name in logs and in the hook list; the file's name when left out.
    #[serde(default)]
    pub name: Option<String>,
    /// The events it runs on ("message:received", ...).
    #[serde(default)]
    pub events: Vec<String>,
    /// The program: a file beside the manifest, an absolute path, a path inside the workspace, or a name on PATH.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// What [`load_hooks`] found.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct HookLoadReport {
    /// The workspace program hooks registered (their manifest files).
    pub programs: Vec<String>,
    /// The `workspace/hooks/*.js` files found and not run.
    pub javascript: Vec<String>,
    /// Manifests that could not be loaded, with the reason.
    pub failed: Vec<(String, String)>,
}

/// Registers the built-in hooks, then the workspace's program hooks, in the app's [`HookRegistry`]; reports the
/// JavaScript hooks it cannot run.
pub fn load_hooks(app: &App) -> HookLoadReport {
    let registry = HookRegistry::of(app);

    // The built-in hooks, in the order their files were loaded.
    crate::hooks::boot_announce::register(app, &registry);
    crate::hooks::command_logger::register(app, &registry);
    crate::hooks::session_memory::register(app, &registry);

    let mut report = HookLoadReport::default();
    let dir = app.config().workspace_dir.join("hooks");
    // No hooks folder, no workspace hooks.
    let Ok(entries) = read_dir_sorted(&dir) else {
        return report;
    };
    for entry in entries {
        let file = entry.file_name().to_string_lossy().into_owned();
        if file.ends_with(".hook.json") {
            match read_manifest(&dir.join(&file)) {
                Ok(manifest) => {
                    register_program(app, &registry, &dir, &file, manifest);
                    report.programs.push(file);
                }
                Err(message) => {
                    log::warn!("[hooks] failed to load {file}: {message}");
                    report.failed.push((file, message));
                }
            }
        } else if file.ends_with(".js") {
            log::warn!(
                "[hooks] {file} is a JavaScript hook, which this version of Tarsee cannot run: see docs/hooks.md"
            );
            report.javascript.push(file);
        }
    }
    report
}

fn read_manifest(path: &Path) -> Result<HookManifest, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let manifest: HookManifest = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if manifest.command.trim().is_empty() {
        return Err("the manifest names no command".into());
    }
    Ok(manifest)
}

fn register_program(app: &App, registry: &HookRegistry, dir: &Path, file: &str, manifest: HookManifest) {
    let name = manifest
        .name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| file.to_string());
    for event in &manifest.events {
        let hook = ProgramHook {
            app: app.downgrade(),
            hooks_dir: dir.to_path_buf(),
            manifest: manifest.clone(),
            event: event.clone(),
        };
        registry.register(
            event,
            move |data| {
                let hook = hook.clone();
                async move { hook.run(data).await }
            },
            HookOptions::named(name.clone()).source("workspace"),
        );
    }
}

#[derive(Clone)]
struct ProgramHook {
    app: WeakApp,
    hooks_dir: PathBuf,
    manifest: HookManifest,
    event: String,
}

impl ProgramHook {
    /// Starts the program in the workspace with the app's environment, writes `{"event", "data"}` to its stdin and
    /// waits for it to finish. Its stdout, when JSON, is the result; a failed start or a non-zero exit is an error.
    /// The registry stops waiting after 5 seconds, which drops this future and so stops the program.
    async fn run(&self, data: Value) -> anyhow::Result<Value> {
        let Some(app) = self.app.upgrade() else {
            return Ok(Value::Null);
        };
        let workspace = app.config().workspace_dir.clone();
        let env = app.env().snapshot();
        let program = resolve_command(&self.manifest.command, &self.hooks_dir, &workspace, env.get("PATH"));
        let mut child = tokio::process::Command::new(&program)
            .args(&self.manifest.args)
            .current_dir(&workspace)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| anyhow::anyhow!("could not start {}: {err}", self.manifest.command))?;

        let input = serde_json::to_vec(&json!({ "event": self.event, "data": data }))?;
        let stdin = child.stdin.take();
        let write = async move {
            if let Some(mut stdin) = stdin {
                // A program that does not read its input is fine.
                let _ = stdin.write_all(&input).await;
            }
        };
        let (_, output) = tokio::join!(write, child.wait_with_output());
        let output = output?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = crate::util::js::utf16_truncate(stderr.trim(), 300);
            let code = output
                .status
                .code()
                .map_or_else(|| "a signal".to_string(), |c| c.to_string());
            anyhow::bail!(
                "exited with code {code}{}",
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {stderr}")
                }
            );
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(serde_json::from_str(stdout.trim()).unwrap_or(Value::Null))
    }
}

/// The program a manifest's `command` names: an absolute path as it is; a file beside the manifest; a path with a
/// folder in it, inside the workspace; else a name found on the app's PATH.
fn resolve_command(command: &str, hooks_dir: &Path, workspace: &Path, path_var: Option<&String>) -> PathBuf {
    let given = Path::new(command);
    if given.is_absolute() {
        return given.to_path_buf();
    }
    let beside = hooks_dir.join(command);
    if beside.is_file() {
        return beside;
    }
    if command.contains('/') || command.contains(std::path::MAIN_SEPARATOR) {
        return workspace.join(command);
    }
    which::which_in(command, path_var, workspace).unwrap_or_else(|_| given.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{CapturedLogs, test_app};

    #[test]
    fn the_built_in_hooks_are_registered_and_javascript_hooks_reported() {
        let t = test_app();
        let dir = t.config().workspace_dir.join("hooks");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notify.js"), "export default {}").unwrap();
        std::fs::write(dir.join("audit.js"), "export default {}").unwrap();
        std::fs::write(dir.join("README.md"), "notes").unwrap();
        std::fs::write(dir.join("broken.hook.json"), "{ not json").unwrap();
        std::fs::write(
            dir.join("empty.hook.json"),
            r#"{"events": ["boot:ready"], "command": " "}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("ping.hook.json"),
            r#"{"name": "ping", "events": ["message:received", "session:end"], "command": "ping-program"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("unnamed.hook.json"),
            r#"{"events": ["boot:ready"], "command": "x"}"#,
        )
        .unwrap();

        let logs = CapturedLogs::start();
        let report = load_hooks(&t);
        assert_eq!(report.javascript, ["audit.js", "notify.js"]);
        assert_eq!(report.programs, ["ping.hook.json", "unnamed.hook.json"]);
        assert_eq!(
            report.failed.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>(),
            ["broken.hook.json", "empty.hook.json"]
        );
        assert_eq!(report.failed[1].1, "the manifest names no command");
        let warnings = logs.warnings();
        assert!(
            warnings.contains(
                &"[hooks] notify.js is a JavaScript hook, which this version of Tarsee cannot run: see docs/hooks.md"
                    .to_string()
            )
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.starts_with("[hooks] failed to load broken.hook.json: "))
        );

        let listed: Vec<(String, String, String)> = HookRegistry::of(&t)
            .list()
            .into_iter()
            .map(|h| (h.event, h.name, h.source))
            .collect();
        let row = |e: &str, n: &str, s: &str| (e.to_string(), n.to_string(), s.to_string());
        assert_eq!(
            listed,
            [
                row("boot:ready", "boot-announce", "builtin"),
                row("boot:ready", "unnamed.hook.json", "workspace"),
                row("tool:after_execute", "command-logger", "builtin"),
                row("session:end", "session-memory", "builtin"),
                row("session:end", "ping", "workspace"),
                row("message:received", "ping", "workspace"),
            ]
        );
    }

    #[test]
    fn without_a_hooks_folder_only_the_built_in_hooks_load() {
        let t = test_app();
        assert_eq!(load_hooks(&t), HookLoadReport::default());
        assert_eq!(HookRegistry::of(&t).list().len(), 3);
    }

    #[test]
    fn a_command_is_found_beside_the_manifest_in_the_workspace_or_on_the_path() {
        let t = test_app();
        let ws = t.config().workspace_dir.clone();
        let hooks = ws.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(hooks.join("notify.sh"), "#!/bin/sh\n").unwrap();
        assert_eq!(resolve_command("notify.sh", &hooks, &ws, None), hooks.join("notify.sh"));
        assert_eq!(
            resolve_command("scripts/run.sh", &hooks, &ws, None),
            ws.join("scripts/run.sh")
        );
        let absolute = ws.join("abs");
        assert_eq!(
            resolve_command(&absolute.to_string_lossy(), &hooks, &ws, None),
            absolute
        );
        assert_eq!(
            resolve_command("no-such-program-anywhere", &hooks, &ws, None),
            PathBuf::from("no-such-program-anywhere")
        );
    }
}
