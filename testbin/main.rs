//! `tarsee-testbin`: stand-ins for the programs Tarsee starts (claude, codex, python, piper, ...), for tests only.
//!
//! One binary plays every part. The part is named by `TARSEE_TESTBIN_ROLE`, or else by the file name the binary
//! was copied to (a copy called `codex` or `codex.exe` plays codex), so a test can hand Tarsee a folder holding a
//! program with the real name. Each role is a module here with a `main()` that returns the exit code.
//!
//! This is the only place besides `src/main.rs` and `src/env.rs` that reads the real environment: a stand-in is a
//! separate process, and the environment it was started with is exactly what a test wants to look at.

mod echo;
mod thread_dbs_sweep;

fn main() {
    let role = std::env::var("TARSEE_TESTBIN_ROLE")
        .ok()
        .filter(|r| !r.is_empty())
        .or_else(|| {
            let exe = std::env::current_exe().ok()?;
            Some(exe.file_stem()?.to_string_lossy().to_lowercase())
        });
    let code = match role.as_deref() {
        Some("echo") => echo::main(),
        Some("thread-dbs-sweep") => thread_dbs_sweep::main(),
        other => {
            eprintln!("tarsee-testbin: no such role: {}", other.unwrap_or("(none)"));
            64
        }
    };
    std::process::exit(code);
}
