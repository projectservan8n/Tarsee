//! Role `sleeper`: a program that has to be stopped, for tests of stopping one.
//!
//! - It writes its process id to the file `TARSEE_TESTBIN_PID_FILE` (written whole, then renamed into place, so a
//!   test never reads half of it).
//! - Then it waits `TARSEE_TESTBIN_SLEEP_MS` (default 30 s).
//! - Had it not been stopped by then, it writes "survived" to `<pid file>.done` and exits 0.

pub fn main() -> i32 {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let Some(pid_file) = var("TARSEE_TESTBIN_PID_FILE") else {
        eprintln!("sleeper: TARSEE_TESTBIN_PID_FILE is not set");
        return 2;
    };
    let partial = format!("{pid_file}.partial");
    if std::fs::write(&partial, std::process::id().to_string()).is_err()
        || std::fs::rename(&partial, &pid_file).is_err()
    {
        eprintln!("sleeper: could not write {pid_file}");
        return 2;
    }
    let ms = var("TARSEE_TESTBIN_SLEEP_MS")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30_000);
    std::thread::sleep(std::time::Duration::from_millis(ms));
    let _ = std::fs::write(format!("{pid_file}.done"), "survived");
    0
}
