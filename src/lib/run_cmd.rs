//! Port of `src/lib/run-cmd.js`: runs a command with bounded output collection and a timeout.
//!
//! The program gets exactly the environment it is given (the JS `opts.env ?? process.env`): pass
//! `app.env().snapshot()` for the server's own.

use std::ffi::OsStr;
use std::io;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::ai::context_limits::{EnvMap, js_round};
use crate::config::constants::limits;
use crate::util::js::number_to_string;

/// How [`run_cmd`] runs a command.
#[derive(Debug, Clone, Default)]
pub struct RunCmdOpts {
    /// Timeout in ms (default 120000).
    pub timeout_ms: Option<u64>,
    /// Max output size (default `limits::CMD_OUTPUT_MAX_BYTES`).
    pub max_output_bytes: Option<usize>,
    /// The program's whole environment.
    pub env: EnvMap,
}

/// What a command did: its exit code (124 after the timeout, 127 when it couldn't start) and its output, stdout and
/// stderr together as they arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdResult {
    pub code: i32,
    pub output: String,
}

struct Collected {
    text: String,
    bytes: usize,
    truncated: bool,
}

/// Runs a command with bounded output collection and timeout.
pub async fn run_cmd<S: AsRef<OsStr>>(cmd: &str, args: &[S], opts: &RunCmdOpts) -> CmdResult {
    let timeout_ms = opts.timeout_ms.unwrap_or(120_000);
    let max_bytes = opts.max_output_bytes.unwrap_or(limits::CMD_OUTPUT_MAX_BYTES);

    let mut command = Command::new(cmd);
    command
        .args(args)
        .env_clear()
        .envs(&opts.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return CmdResult {
                code: 127,
                output: format!("\n[spawn error] {}\n", spawn_error_text(cmd, &err)),
            };
        }
    };

    let out = Arc::new(Mutex::new(Collected {
        text: String::new(),
        bytes: 0,
        truncated: false,
    }));
    let readers = [
        child
            .stdout
            .take()
            .map(|s| tokio::spawn(collect(s, out.clone(), max_bytes))),
        child
            .stderr
            .take()
            .map(|s| tokio::spawn(collect(s, out.clone(), max_bytes))),
    ];

    let timer = tokio::time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(timer);
    let closed = async {
        for reader in readers.into_iter().flatten() {
            let _ = reader.await;
        }
        child.wait().await
    };
    let status = tokio::select! {
        status = closed => Some(status),
        _ = &mut timer => None,
    };
    match status {
        Some(status) => CmdResult {
            code: status.ok().and_then(|s| s.code()).unwrap_or(0),
            output: out.lock().text.clone(),
        },
        None => {
            terminate(&mut child);
            // Two seconds later, SIGKILL if it is still there.
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(2_000)).await;
                if matches!(child.try_wait(), Ok(None)) {
                    let _ = child.start_kill();
                }
                let _ = child.wait().await;
            });
            let seconds = number_to_string(js_round(timeout_ms as f64 / 1000.0));
            CmdResult {
                code: 124,
                output: format!("{}\n[timeout after {seconds}s]\n", out.lock().text),
            }
        }
    }
}

async fn collect<R: AsyncRead + Unpin>(mut stream: R, out: Arc<Mutex<Collected>>, max_bytes: usize) {
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let mut out = out.lock();
        out.bytes += n;
        if out.bytes <= max_bytes {
            let text = String::from_utf8_lossy(&chunk[..n]);
            out.text.push_str(&text);
        } else if !out.truncated {
            out.truncated = true;
            let kb = number_to_string(js_round(max_bytes as f64 / 1024.0));
            out.text.push_str(&format!("\n... (output truncated at {kb}KB)\n"));
        }
    }
}

/// `proc.kill("SIGTERM")`.
fn terminate(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
        // SAFETY: kill(2) only sends a signal; a pid that is gone makes it fail with ESRCH, nothing more.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        return;
    }
    let _ = child.start_kill();
}

/// `String(err)` for a failed start: "Error: spawn sh ENOENT".
fn spawn_error_text(cmd: &str, err: &io::Error) -> String {
    match node_error_code(err) {
        Some(code) => format!("Error: spawn {cmd} {code}"),
        None => format!("Error: spawn {cmd} {err}"),
    }
}

/// Node's name for an operating-system error ("ENOENT", "EACCES", ...), which its messages and `err.code` carry.
pub(crate) fn node_error_code(err: &io::Error) -> Option<&'static str> {
    #[cfg(unix)]
    if let Some(errno) = err.raw_os_error() {
        let code = match errno {
            libc::ENOENT => "ENOENT",
            libc::EACCES => "EACCES",
            libc::EPERM => "EPERM",
            libc::ENOTDIR => "ENOTDIR",
            libc::EISDIR => "EISDIR",
            libc::EEXIST => "EEXIST",
            libc::ENOTEMPTY => "ENOTEMPTY",
            libc::EBUSY => "EBUSY",
            libc::EMFILE => "EMFILE",
            libc::ENOSPC => "ENOSPC",
            libc::EROFS => "EROFS",
            libc::ELOOP => "ELOOP",
            libc::ENAMETOOLONG => "ENAMETOOLONG",
            libc::EIO => "EIO",
            libc::EINVAL => "EINVAL",
            libc::EAGAIN => "EAGAIN",
            libc::ENOEXEC => "ENOEXEC",
            _ => return None,
        };
        return Some(code);
    }
    Some(match err.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        // libuv's name for Windows' ERROR_ACCESS_DENIED.
        io::ErrorKind::PermissionDenied => "EPERM",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        io::ErrorKind::ResourceBusy => "EBUSY",
        io::ErrorKind::InvalidInput => "EINVAL",
        _ => return None,
    })
}

/// Node's message for a failed file call: "EACCES: permission denied, scandir '/x/sessions'".
pub(crate) fn node_error_message(err: &io::Error, syscall: &str, path: &std::path::Path) -> String {
    let Some(code) = node_error_code(err) else {
        return format!("{err}, {syscall} '{}'", path.display());
    };
    let description = match code {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "EPERM" => "operation not permitted",
        "ENOTDIR" => "not a directory",
        "EISDIR" => "illegal operation on a directory",
        "EEXIST" => "file already exists",
        "ENOTEMPTY" => "directory not empty",
        "EBUSY" => "resource busy or locked",
        "EMFILE" => "too many open files",
        "ENOSPC" => "no space left on device",
        "EROFS" => "read-only file system",
        "ELOOP" => "too many symbolic links encountered",
        "ENAMETOOLONG" => "name too long",
        "EIO" => "i/o error",
        "EINVAL" => "invalid argument",
        "EAGAIN" => "resource temporarily unavailable",
        "ENOEXEC" => "exec format error",
        _ => "unknown error",
    };
    format!("{code}: {description}, {syscall} '{}'", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_errors_get_nodes_names_and_messages() {
        let missing = io::Error::from(io::ErrorKind::NotFound);
        assert_eq!(node_error_code(&missing), Some("ENOENT"));
        assert_eq!(spawn_error_text("sh", &missing), "Error: spawn sh ENOENT");
        assert_eq!(
            node_error_message(&missing, "scandir", std::path::Path::new("x")),
            "ENOENT: no such file or directory, scandir 'x'"
        );
        #[cfg(unix)]
        {
            let denied = io::Error::from_raw_os_error(libc::EACCES);
            assert_eq!(
                node_error_message(&denied, "scandir", std::path::Path::new("/s")),
                "EACCES: permission denied, scandir '/s'"
            );
        }
        let other = io::Error::other("strange");
        assert_eq!(node_error_code(&other), None);
        assert_eq!(spawn_error_text("sh", &other), "Error: spawn sh strange");
    }

    #[tokio::test]
    async fn a_program_that_cant_start_is_code_127_with_nodes_words() {
        let r = run_cmd("tarsee-no-such-program-anywhere", &["x"], &RunCmdOpts::default()).await;
        assert_eq!(r.code, 127);
        assert_eq!(
            r.output,
            "\n[spawn error] Error: spawn tarsee-no-such-program-anywhere ENOENT\n"
        );
    }
}
