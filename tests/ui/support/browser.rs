//! The one browser of the test binary: found on the machine, started headless through the `browser-guard` stand-in
//! (`testbin/browser_guard.rs`), and shared by every test, each in a browser context of its own (see `page.rs`).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, OnceLock};
use std::time::{Duration, Instant};

use chromiumoxide::Browser;
use chromiumoxide::handler::HandlerConfig;
use futures::StreamExt;
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;

/// How long the browser may take to start and say where it listens. A first start on a cold machine (or one whose
/// virus scanner looks at every new file) can take a while.
const START_LIMIT: Duration = Duration::from_secs(60);

/// How long one command to the browser may take before it counts as lost.
const COMMAND_LIMIT: Duration = Duration::from_secs(60);

/// The runtime that runs what every test shares: the connection to the browser and the shared site. Each test runs
/// on a runtime of its own (`#[tokio::test]`), which ends with the test, so nothing shared may live there; tests
/// reach these through channels, which work from any runtime.
pub fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("ui-shared")
            .enable_all()
            .build()
            .expect("the UI tests' shared runtime could not be started")
    })
}

/// The running browser.
pub struct Shared {
    pub browser: Browser,
    /// The program that was started.
    pub executable: PathBuf,
    /// The guard, whose stdin this test binary holds open until it ends (never dropped: it is in a static).
    _guard: Child,
}

/// The browser, started on first use. If it cannot be started, every test that needs it fails with the reason.
pub async fn shared() -> &'static Shared {
    static SHARED: LazyLock<OnceCell<Result<Shared, String>>> = LazyLock::new(OnceCell::new);
    match SHARED.get_or_init(start).await {
        Ok(shared) => shared,
        Err(message) => panic!("{message}"),
    }
}

async fn start() -> Result<Shared, String> {
    let executable = find_browser()?;
    let run = tarsee::testkit::tmp_dir();
    let base = run.path().parent().map(Path::to_path_buf).unwrap_or_default();
    // The guard removes the folder once this test binary has ended.
    let run_dir = run.keep();
    remove_leftovers(&base, &run_dir);
    let profile = run_dir.join("profile");
    fs::create_dir_all(&profile).map_err(|e| format!("the browser's profile folder could not be made: {e}"))?;

    let mut guard = Command::new(env!("CARGO_BIN_EXE_tarsee-testbin"))
        .env("TARSEE_TESTBIN_ROLE", "browser-guard")
        .arg(&run_dir)
        .arg(&executable)
        .args(flags(&profile))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("the browser guard (tarsee-testbin) could not be started: {e}"))?;

    let ws = match devtools_address(&run_dir, &profile, &executable, &mut guard).await {
        Ok(ws) => ws,
        Err(message) => {
            // Closing its stdin is the guard's signal to stop the browser and clean up.
            drop(guard.stdin.take());
            return Err(message);
        }
    };

    let config = HandlerConfig {
        request_timeout: COMMAND_LIMIT,
        ..HandlerConfig::default()
    };
    let connected = runtime()
        .spawn(async move {
            let (browser, mut handler) = Browser::connect_with_config(ws, config).await?;
            // The connection: every command and event goes through here, for as long as the test binary runs.
            tokio::spawn(async move { while handler.next().await.is_some() {} });
            Ok::<_, chromiumoxide::error::CdpError>(browser)
        })
        .await;
    let browser = match connected {
        Ok(Ok(browser)) => browser,
        Ok(Err(err)) => {
            return Err(format!(
                "could not connect to the browser ({}): {err}",
                executable.display()
            ));
        }
        Err(err) => {
            return Err(format!(
                "could not connect to the browser ({}): {err}",
                executable.display()
            ));
        }
    };
    Ok(Shared {
        browser,
        executable,
        _guard: guard,
    })
}

/// The browser's command line. Headless, its own profile, nothing it would fetch or show on its own, no throttling of
/// tabs that are not in front (tests run in parallel, each in its own tab), and a fake microphone and camera that are
/// allowed without asking (for tests of a voice call).
fn flags(profile: &Path) -> Vec<String> {
    let mut flags: Vec<String> = [
        "--headless",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        // Playwright's default too: the sandbox cannot start from every folder on Windows, nor as root in a container.
        // The pages are this repository's own files, and the network is closed (below).
        "--no-sandbox",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-sync",
        "--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,AutofillServerCommunication,DialMediaRouteProvider",
        "--metrics-recording-only",
        "--password-store=basic",
        "--use-mock-keychain",
        "--force-color-profile=srgb",
        "--mute-audio",
        "--lang=en-US",
        "--window-size=1280,800",
        // Nothing resolves but the loopback address: a test never reaches the network, even through a page's link or
        // picture. (The rule is applied to addresses written as numbers too.)
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    flags.push(format!("--user-data-dir={}", profile.display()));
    flags.push("about:blank".to_string());
    flags
}

/// Waits for the browser to write where it listens (`DevToolsActivePort` in its profile: the port, then the path).
async fn devtools_address(
    run_dir: &Path,
    profile: &Path,
    executable: &Path,
    guard: &mut Child,
) -> Result<String, String> {
    let deadline = Instant::now() + START_LIMIT;
    loop {
        if let Ok(text) = fs::read_to_string(profile.join("DevToolsActivePort")) {
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next())
                && port.trim().parse::<u16>().is_ok()
                && path.starts_with('/')
            {
                return Ok(format!("ws://127.0.0.1:{}{}", port.trim(), path.trim()));
            }
        }
        let exited = fs::read_to_string(run_dir.join("browser-exited")).ok();
        let guard_gone = matches!(guard.try_wait(), Ok(Some(_)));
        if exited.is_some() || guard_gone || Instant::now() >= deadline {
            let why = exited.unwrap_or_else(|| {
                if guard_gone {
                    "the browser guard stopped".to_string()
                } else {
                    format!("it did not say where it listens within {}s", START_LIMIT.as_secs())
                }
            });
            let log = fs::read_to_string(run_dir.join("browser.log")).unwrap_or_default();
            let tail: Vec<&str> = log.lines().rev().take(15).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            return Err(format!(
                "The browser for the UI tests did not start: {why}.\n  browser: {}\n  its last words:\n    {}\n{}",
                executable.display(),
                tail.join("\n    "),
                HOW_TO_FIX
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

const HOW_TO_FIX: &str = "To give the UI tests a browser, do one of these:\n  \
    - install Playwright's Chromium: npx playwright install chromium\n  \
    - install Google Chrome, Chromium or Microsoft Edge\n  \
    - set TARSEE_CHROMIUM_PATH to the program file of a Chromium-based browser";

/// The browser to drive: `TARSEE_CHROMIUM_PATH` when set; else Playwright's Chromium, when it is installed (the
/// newest); else the system's Chrome, Chromium or Edge.
pub fn find_browser() -> Result<PathBuf, String> {
    // The one variable this test binary reads from the real environment: which browser to drive is the machine's
    // business, like where the browser is installed.
    if let Some(path) = std::env::var_os("TARSEE_CHROMIUM_PATH").filter(|v| !v.is_empty()) {
        let path = PathBuf::from(path);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!(
                "TARSEE_CHROMIUM_PATH is {}, which is not a file.\n{HOW_TO_FIX}",
                path.display()
            ))
        };
    }
    let candidates: Vec<PathBuf> = playwright_candidates().into_iter().chain(system_candidates()).collect();
    if let Some(found) = candidates.iter().find(|p| p.is_file()) {
        return Ok(found.clone());
    }
    let looked: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    Err(format!(
        "No browser for the UI tests: they drive a real Chromium-based browser, and none was found.\n{HOW_TO_FIX}\n\
         Looked for:\n  {}",
        looked.join("\n  ")
    ))
}

/// Playwright's own download folders.
fn playwright_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::home_dir() {
        if cfg!(windows) {
            dirs.push(home.join("AppData").join("Local").join("ms-playwright"));
        } else if cfg!(target_os = "macos") {
            dirs.push(home.join("Library").join("Caches").join("ms-playwright"));
        } else {
            dirs.push(home.join(".cache").join("ms-playwright"));
        }
    }
    if cfg!(target_os = "linux") {
        // Where Playwright's Docker image keeps them.
        dirs.push(PathBuf::from("/ms-playwright"));
    }
    dirs
}

/// The program inside a Playwright `chromium-<revision>` folder, then inside a `chromium_headless_shell-<revision>`.
#[cfg(windows)]
const PLAYWRIGHT_PROGRAMS: [(&str, &[&str]); 2] = [
    ("chromium-", &["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]),
    (
        "chromium_headless_shell-",
        &["chrome-headless-shell-win64/chrome-headless-shell.exe"],
    ),
];
#[cfg(target_os = "macos")]
const PLAYWRIGHT_PROGRAMS: [(&str, &[&str]); 2] = [
    (
        "chromium-",
        &[
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        ],
    ),
    (
        "chromium_headless_shell-",
        &[
            "chrome-headless-shell-mac-arm64/chrome-headless-shell",
            "chrome-headless-shell-mac-x64/chrome-headless-shell",
        ],
    ),
];
#[cfg(not(any(windows, target_os = "macos")))]
const PLAYWRIGHT_PROGRAMS: [(&str, &[&str]); 2] = [
    ("chromium-", &["chrome-linux64/chrome", "chrome-linux/chrome"]),
    (
        "chromium_headless_shell-",
        &[
            "chrome-headless-shell-linux64/chrome-headless-shell",
            "chrome-headless-shell-linux/headless_shell",
        ],
    ),
];

fn playwright_candidates() -> Vec<PathBuf> {
    let mut found = Vec::new();
    for dir in playwright_dirs() {
        for (prefix, programs) in PLAYWRIGHT_PROGRAMS {
            let mut revisions: Vec<(u64, PathBuf)> = fs::read_dir(&dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let revision = name.strip_prefix(prefix)?.parse::<u64>().ok()?;
                    Some((revision, entry.path()))
                })
                .collect();
            revisions.sort_by(|a, b| b.0.cmp(&a.0));
            for (_, folder) in revisions {
                found.extend(programs.iter().map(|p| folder.join(p)));
            }
        }
    }
    found
}

fn system_candidates() -> Vec<PathBuf> {
    let home = std::env::home_dir();
    let mut found: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for root in [r"C:\Program Files", r"C:\Program Files (x86)"] {
            found.push(Path::new(root).join(r"Google\Chrome\Application\chrome.exe"));
        }
        if let Some(home) = &home {
            found.push(home.join(r"AppData\Local\Google\Chrome\Application\chrome.exe"));
            found.push(home.join(r"AppData\Local\Chromium\Application\chrome.exe"));
        }
        for root in [r"C:\Program Files (x86)", r"C:\Program Files"] {
            found.push(Path::new(root).join(r"Microsoft\Edge\Application\msedge.exe"));
        }
    } else if cfg!(target_os = "macos") {
        let apps = [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Chromium.app/Contents/MacOS/Chromium",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
        for app in apps {
            found.push(Path::new("/Applications").join(app));
            if let Some(home) = &home {
                found.push(home.join("Applications").join(app));
            }
        }
    } else {
        for path in [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/opt/microsoft/msedge/msedge",
        ] {
            found.push(PathBuf::from(path));
        }
    }
    found
}

/// Removes what an earlier run left behind when its guard was stopped before it could clean up: a folder with a
/// `guard.lock` that no guard holds any more.
fn remove_leftovers(base: &Path, ours: &Path) {
    for entry in fs::read_dir(base).into_iter().flatten().flatten() {
        let dir = entry.path();
        if dir == ours {
            continue;
        }
        let Ok(lock) = fs::OpenOptions::new().write(true).open(dir.join("guard.lock")) else {
            continue;
        };
        if lock.try_lock().is_ok() {
            drop(lock);
            let _ = fs::remove_dir_all(&dir);
        }
    }
}
