//! Port of `src/cli/doctor.js`: Tarsee doctor, diagnostic checks (`tarsee doctor`).
//!
//! Two checks asked about the Node version itself and are replaced by their equivalents for this program:
//!   - "Node.js" (the runtime's version, 18 or newer) is "Tarsee": this program's version and the computer it was
//!     built for. There is no separate runtime to be too old.
//!   - "Playwright" (whether the npm package could be loaded) is "Browser": whether a Chromium, Chrome or Edge can be
//!     found for the browser tool, TARSEE_CHROMIUM_PATH first, then Playwright's download, then the system's.
//!
//! "SQLite" asked whether better-sqlite3 could be loaded; SQLite is built into this program, so it names its version.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::app::App;
use crate::env::Env;
use crate::voice::python_runtime::{node_arch, node_platform};
use crate::voice::stt_install::{ResolvedModel, get_stt_status, resolve_stt_model};
use crate::voice::tts_interface::find_program;
use crate::voice::whisper_models::ModelSource;

/// How a check came out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

/// One line of the report: `{ name, status, detail }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub detail: String,
}

fn check(name: &str, status: CheckStatus, detail: impl Into<String>) -> Check {
    Check {
        name: name.into(),
        status,
        detail: detail.into(),
    }
}

/// A program on the environment's `PATH` (`tts_interface::find_program`: on Windows, whatever the variable's case).
fn which(env: &Env, name: &str) -> Option<PathBuf> {
    find_program(env, name)
}

/// Whether `program -version` runs and succeeds (`execSync("ffmpeg -version")`).
async fn runs(env: &Env, name: &str) -> bool {
    let Some(program) = which(env, name) else {
        return false;
    };
    let mut cmd = tokio::process::Command::new(program);
    cmd.arg("-version")
        .env_clear()
        .envs(env.snapshot())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    match tokio::time::timeout(Duration::from_secs(30), cmd.status()).await {
        Ok(Ok(status)) => status.success(),
        _ => false,
    }
}

/// Where Playwright keeps the browsers it downloads.
fn playwright_dir(env: &Env) -> Option<PathBuf> {
    if let Some(dir) = env.trimmed("PLAYWRIGHT_BROWSERS_PATH").filter(|d| d != "0") {
        return Some(PathBuf::from(dir));
    }
    let home = crate::config::env::home_dir(env);
    if cfg!(windows) {
        let local = env
            .trimmed("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        Some(local.join("ms-playwright"))
    } else if cfg!(target_os = "macos") {
        Some(home.join("Library").join("Caches").join("ms-playwright"))
    } else {
        let cache = env
            .trimmed("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache"));
        Some(cache.join("ms-playwright"))
    }
}

/// The browser inside one of Playwright's `chromium-<build>` folders.
fn in_playwright_build(dir: &Path) -> Option<PathBuf> {
    let inside: &[&[&str]] = if cfg!(windows) {
        &[&["chrome-win64", "chrome.exe"], &["chrome-win", "chrome.exe"]]
    } else if cfg!(target_os = "macos") {
        &[
            &[
                "chrome-mac-arm64",
                "Google Chrome for Testing.app",
                "Contents",
                "MacOS",
                "Google Chrome for Testing",
            ],
            &[
                "chrome-mac-x64",
                "Google Chrome for Testing.app",
                "Contents",
                "MacOS",
                "Google Chrome for Testing",
            ],
            &["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
        ]
    } else {
        &[&["chrome-linux64", "chrome"], &["chrome-linux", "chrome"]]
    };
    inside
        .iter()
        .map(|parts| parts.iter().fold(dir.to_path_buf(), |p, part| p.join(part)))
        .find(|p| p.is_file())
}

/// The browser the browser tool would drive: TARSEE_CHROMIUM_PATH, else Playwright's download, else a system
/// Chromium, Chrome or Edge.
pub fn find_browser(env: &Env) -> Option<PathBuf> {
    if let Some(path) = env.trimmed("TARSEE_CHROMIUM_PATH").map(PathBuf::from)
        && path.is_file()
    {
        return Some(path);
    }
    if let Some(dir) = playwright_dir(env)
        && let Ok(entries) = std::fs::read_dir(&dir)
    {
        let mut builds: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("chromium-"))
            })
            .collect();
        // The newest build first.
        builds.sort();
        builds.reverse();
        if let Some(found) = builds.iter().find_map(|b| in_playwright_build(b)) {
            return Some(found);
        }
    }
    for name in [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "chrome",
        "microsoft-edge",
        "microsoft-edge-stable",
        "msedge",
    ] {
        if let Some(found) = which(env, name) {
            return Some(found);
        }
    }
    let mut known: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = env.trimmed(var) {
                let base = PathBuf::from(base);
                known.push(
                    base.join("Google")
                        .join("Chrome")
                        .join("Application")
                        .join("chrome.exe"),
                );
                known.push(
                    base.join("Microsoft")
                        .join("Edge")
                        .join("Application")
                        .join("msedge.exe"),
                );
                known.push(base.join("Chromium").join("Application").join("chrome.exe"));
            }
        }
    } else if cfg!(target_os = "macos") {
        for app in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ] {
            known.push(PathBuf::from(app));
        }
    }
    known.into_iter().find(|p| p.is_file())
}

/// The memory free now, as `os.freemem()` gives it (the kernel's estimate of what is available on Linux).
pub fn free_memory() -> Option<u64> {
    free_memory_impl()
}

#[cfg(target_os = "linux")]
fn free_memory_impl() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = info.lines().find(|l| l.starts_with("MemAvailable:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    kb.checked_mul(1024)
}

#[cfg(target_os = "macos")]
fn free_memory_impl() -> Option<u64> {
    let mut free: u32 = 0;
    let mut size = std::mem::size_of::<u32>();
    let name = c"vm.page_free_count";
    // SAFETY: the name is a NUL-terminated string, and the output buffer is a u32 whose size is passed alongside.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut free as *mut u32).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    // SAFETY: sysconf only reads a configuration value.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    u64::try_from(page).ok()?.checked_mul(u64::from(free))
}

#[cfg(windows)]
fn free_memory_impl() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: MEMORYSTATUSEX is plain data; dwLength is set to its size as the call requires.
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return None;
        }
        Some(status.ullAvailPhys)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn free_memory_impl() -> Option<u64> {
    None
}

/// Every check, in the order the report lists them.
pub async fn doctor_checks(app: &App) -> Vec<Check> {
    use CheckStatus::{Pass, Warn};
    let env = app.env();
    let mut checks = Vec::new();

    // This program (the Node version checked Node.js itself here)
    checks.push(check(
        "Tarsee",
        Pass,
        format!("v{} ({} {})", crate::VERSION, node_platform(), node_arch()),
    ));

    // SQLite
    checks.push(check(
        "SQLite",
        Pass,
        format!("SQLite {} (built in)", rusqlite::version()),
    ));

    // A browser for the browser tool (the Node version checked for the Playwright package here)
    checks.push(match find_browser(env) {
        Some(path) => check("Browser", Pass, path.display().to_string()),
        None => check(
            "Browser",
            Warn,
            "No Chromium, Chrome or Edge found (browser tool unavailable; set TARSEE_CHROMIUM_PATH)",
        ),
    });

    // ffmpeg (for audio processing)
    checks.push(if runs(env, "ffmpeg").await {
        check("ffmpeg", Pass, "Available")
    } else {
        check("ffmpeg", Warn, "Not installed (audio processing limited)")
    });

    // Speech-to-text: faster-whisper, the Python it runs on, and a model on disk
    let s = get_stt_status(app, false, None).await;
    checks.push(if !s.runtime.ready {
        check(
            "Speech-to-text",
            Warn,
            "faster-whisper is not installed (Settings > Voice > Speech-to-text installs it)",
        )
    } else {
        let fw = s.runtime.faster_whisper.clone().unwrap_or_default();
        match resolve_stt_model(app, &s.current) {
            ResolvedModel::Missing(_) => check(
                "Speech-to-text",
                Warn,
                format!("faster-whisper {fw}, but no model is downloaded (Settings > Voice > Speech-to-text)"),
            ),
            ResolvedModel::Found { model, .. } => {
                let version = s
                    .runtime
                    .python
                    .as_ref()
                    .and_then(|p| p.version.clone())
                    .unwrap_or_else(|| "undefined".into());
                let at = if model.source == ModelSource::Image {
                    "in the image".to_string()
                } else {
                    model.dir.display().to_string()
                };
                check(
                    "Speech-to-text",
                    Pass,
                    format!("faster-whisper {fw} on Python {version}, model {} ({at})", model.name),
                )
            }
        }
    });

    // Memory
    checks.push(match free_memory() {
        Some(free) => check(
            "Memory",
            if free > 256 * 1024 * 1024 { Pass } else { Warn },
            format!("{}MB free", (free as f64 / 1024.0 / 1024.0 + 0.5).floor()),
        ),
        None => check("Memory", Warn, "Could not check"),
    });

    // Environment
    let set = |name: &str, missing: &str| {
        if env.is_set(name) {
            check(name, Pass, "Set")
        } else {
            check(name, Warn, missing)
        }
    };
    checks.push(set("ENCRYPTION_KEY", "Not set (credentials unencrypted)"));
    checks.push(set("SETUP_PASSWORD", "Not set (open access)"));
    checks
}

/// The report as printed.
pub fn format_report(checks: &[Check]) -> String {
    let mut out = String::from("\n  Tarsee Doctor\n\n");
    for c in checks {
        let icon = match c.status {
            CheckStatus::Pass => "[OK]",
            CheckStatus::Warn => "[!!]",
            CheckStatus::Fail => "[XX]",
        };
        out.push_str(&format!("  {icon} {:<18} {}\n", c.name, c.detail));
    }
    let fails = checks.iter().filter(|c| c.status == CheckStatus::Fail).count();
    let warns = checks.iter().filter(|c| c.status == CheckStatus::Warn).count();
    out.push_str(&format!(
        "\n  {} checks: {} passed, {warns} warnings, {fails} failures\n\n",
        checks.len(),
        checks.len() - fails - warns
    ));
    out
}

/// `tarsee doctor`: runs the checks and prints the report to `out`.
pub async fn run_doctor(app: &App, out: &mut dyn Write) -> std::io::Result<()> {
    let checks = doctor_checks(app).await;
    out.write_all(format_report(&checks).as_bytes())?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{test_app_with_env, tmp_dir};

    #[test]
    fn the_report_is_laid_out_as_the_node_version_printed_it() {
        let checks = vec![
            check("Tarsee", CheckStatus::Pass, "v1"),
            check("ffmpeg", CheckStatus::Warn, "Not installed (audio processing limited)"),
            check("Thing", CheckStatus::Fail, "broken"),
        ];
        assert_eq!(
            format_report(&checks),
            "\n  Tarsee Doctor\n\n  [OK] Tarsee             v1\n  [!!] ffmpeg             Not installed (audio processing limited)\n  [XX] Thing              broken\n\n  3 checks: 1 passed, 1 warnings, 1 failures\n\n"
        );
    }

    #[tokio::test]
    async fn nothing_set_up_warns_and_says_what_is_missing() {
        let t = test_app_with_env([("PATH", ""), ("PLAYWRIGHT_BROWSERS_PATH", "/nowhere/at/all")]);
        crate::voice::python_runtime::set_for_tests(
            &t,
            crate::voice::python_runtime::PythonOverrides {
                spawn: None,
                candidates: Some(vec![]),
            },
        );
        let checks = doctor_checks(&t).await;
        let names: Vec<&str> = checks.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Tarsee",
                "SQLite",
                "Browser",
                "ffmpeg",
                "Speech-to-text",
                "Memory",
                "ENCRYPTION_KEY",
                "SETUP_PASSWORD"
            ]
        );
        let by = |name: &str| checks.iter().find(|c| c.name == name).unwrap().clone();
        assert_eq!(
            by("Tarsee").detail,
            format!("v{} ({} {})", crate::VERSION, node_platform(), node_arch())
        );
        assert!(by("SQLite").detail.starts_with("SQLite 3."), "{:?}", by("SQLite"));
        assert_eq!(
            by("ffmpeg"),
            check("ffmpeg", CheckStatus::Warn, "Not installed (audio processing limited)")
        );
        assert_eq!(
            by("Speech-to-text").detail,
            "faster-whisper is not installed (Settings > Voice > Speech-to-text installs it)"
        );
        assert_eq!(
            by("ENCRYPTION_KEY"),
            check("ENCRYPTION_KEY", CheckStatus::Warn, "Not set (credentials unencrypted)")
        );
        assert_eq!(
            by("SETUP_PASSWORD"),
            check("SETUP_PASSWORD", CheckStatus::Warn, "Not set (open access)")
        );
        assert!(by("Memory").detail.ends_with("MB free"), "{:?}", by("Memory"));
        let mut out = Vec::new();
        run_doctor(&t, &mut out).await.unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("  8 checks: "), "{text}");
    }

    #[tokio::test]
    async fn the_secrets_count_as_set_and_the_browser_named_by_the_environment_is_found() {
        let dir = tmp_dir();
        let chrome = dir.path().join(if cfg!(windows) { "chrome.exe" } else { "chrome" });
        std::fs::write(&chrome, "").unwrap();
        let t = test_app_with_env([
            ("ENCRYPTION_KEY", "k"),
            ("SETUP_PASSWORD", "1234"),
            ("TARSEE_CHROMIUM_PATH", chrome.to_string_lossy().as_ref()),
        ]);
        assert_eq!(find_browser(t.env()), Some(chrome.clone()));
        let checks = doctor_checks(&t).await;
        let by = |name: &str| checks.iter().find(|c| c.name == name).unwrap().clone();
        assert_eq!(
            by("Browser"),
            check("Browser", CheckStatus::Pass, chrome.display().to_string())
        );
        assert_eq!(by("ENCRYPTION_KEY"), check("ENCRYPTION_KEY", CheckStatus::Pass, "Set"));
        assert_eq!(by("SETUP_PASSWORD"), check("SETUP_PASSWORD", CheckStatus::Pass, "Set"));
    }

    #[test]
    fn playwright_s_download_is_found_newest_build_first() {
        let dir = tmp_dir();
        let exe: &[&str] = if cfg!(windows) {
            &["chrome-win", "chrome.exe"]
        } else if cfg!(target_os = "macos") {
            &["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]
        } else {
            &["chrome-linux", "chrome"]
        };
        let put = |build: &str| {
            let path = exe.iter().fold(dir.path().join(build), |p, part| p.join(part));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "").unwrap();
            path
        };
        put("chromium-1100");
        let newest = put("chromium-1200");
        let env = Env::from_pairs([
            ("PLAYWRIGHT_BROWSERS_PATH", dir.path().to_string_lossy().to_string()),
            ("PATH", String::new()),
            (
                "TARSEE_CHROMIUM_PATH",
                dir.path().join("missing").to_string_lossy().to_string(),
            ),
        ]);
        assert_eq!(find_browser(&env), Some(newest));
    }
}
