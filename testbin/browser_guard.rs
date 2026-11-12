//! Role `browser-guard`: starts the browser the UI tests drive (`tests/ui/`) and makes sure it never outlives them.
//!
//!   tarsee-testbin <run-dir> <browser> [browser arguments...]      (with TARSEE_TESTBIN_ROLE=browser-guard)
//!
//! The test binary starts one browser for all its tests and keeps it in a static, which Rust never drops: nothing in
//! the test binary runs when its last test is done. So the test binary holds this program's stdin open and never
//! writes to it. When the test binary ends, however it ends (every test done, a panic, an abort, a kill), the system
//! closes that pipe, and this program stops the browser with every process it started, then removes `<run-dir>`.
//!
//! `<run-dir>` holds the browser's profile (`profile/`, where the browser writes `DevToolsActivePort`), the browser's
//! output (`browser.log`), `guard.lock` (held locked while this program runs, so a later run can tell a folder whose
//! guard is gone from one in use), and `browser-exited` once the browser has stopped by itself (with its exit
//! status), so the test binary can say why it never answered.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub fn main() -> i32 {
    let mut args = std::env::args_os().skip(1);
    let (Some(run_dir), Some(browser)) = (args.next(), args.next()) else {
        eprintln!("browser-guard: usage: <run-dir> <browser> [browser arguments...]");
        return 64;
    };
    let run_dir = PathBuf::from(run_dir);
    let browser_args: Vec<_> = args.collect();

    let lock = match File::create(run_dir.join("guard.lock")) {
        Ok(file) => file,
        Err(err) => {
            eprintln!("browser-guard: {}: {err}", run_dir.display());
            return 1;
        }
    };
    // (If it cannot be locked, nothing worse happens than a later run leaving this folder alone.)
    let _ = lock.try_lock();

    let log = File::create(run_dir.join("browser.log"));
    let mut command = Command::new(&browser);
    command
        .args(&browser_args)
        .env_remove("TARSEE_TESTBIN_ROLE")
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    command.stderr(match log {
        Ok(file) => Stdio::from(file),
        Err(_) => Stdio::null(),
    });
    let mut child = match command.spawn() {
        Ok(child) => Some(child),
        Err(err) => {
            let _ = fs::write(
                run_dir.join("browser-exited"),
                format!("could not start {}: {err}", Path::new(&browser).display()),
            );
            None
        }
    };

    // stdin reaches its end when the test binary is gone.
    let (gone_tx, gone_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 256];
        while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
        let _ = gone_tx.send(());
    });

    loop {
        if let Some(c) = child.as_mut()
            && let Ok(Some(status)) = c.try_wait()
        {
            let _ = fs::write(
                run_dir.join("browser-exited"),
                format!("the browser exited by itself ({status})"),
            );
            child = None;
        }
        match gone_rx.recv_timeout(Duration::from_millis(100)) {
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            _ => break,
        }
    }

    if let Some(c) = child.as_mut() {
        stop(c);
    }
    remove_dir(&run_dir, lock);
    0
}

/// Stops the browser and every process it started (renderers, the GPU process, ...).
fn stop(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(windows)]
    {
        // The whole tree, by parent process.
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // Asked first: the browser then closes its own helpers.
        let _ = Command::new("kill")
            .args(["-TERM", &pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Removes the run folder, `guard.lock` last: should this program be stopped half way, the folder still has its lock
/// file, unlocked, and the next run removes it. On Windows a file can stay in use for a moment while the browser's last
/// processes end, so each removal is tried again for a while.
fn remove_dir(dir: &Path, lock: File) {
    let deadline = Instant::now() + Duration::from_secs(15);
    let again = || {
        std::thread::sleep(Duration::from_millis(100));
        Instant::now() < deadline
    };
    loop {
        let mut left = false;
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if entry.file_name() == "guard.lock" {
                continue;
            }
            let removed = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            left |= removed.is_err();
        }
        if !left || !again() {
            break;
        }
    }
    drop(lock);
    while fs::remove_dir_all(dir).is_err() && dir.exists() && again() {}
}
