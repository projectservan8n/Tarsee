//! Port of `src/voice/install-common.js`: what Tarsee's installers share: Phonon (`phonon_install`), faster-whisper
//! and its models (`stt_install`, `whisper_models`) and the standalone Python they can run on (`python_runtime`).
//!
//!   - Downloads come only from fixed official hosts, over https. Redirects (the hosts send big files to their CDNs)
//!     are followed by hand and each one is checked before anything is sent there ([`GuardedFetch`]).
//!   - Every file is streamed to a temporary name, checked against the size and hash its source publishes, and only
//!     then renamed into place ([`download_file`]). A file never appears half written.
//!   - A lock file keeps two installs (the server and a terminal run) from racing ([`acquire_lock`]).
//!
//! Nothing here needs Tarsee's configuration: the Docker build runs the whisper model download (and so this file) on
//! its own, to put the default speech-to-text model in the image.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use parking_lot::Mutex;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::app::App;
use crate::net::fetch::{Fetch, FetchError, FetchRequest, FetchResponse};
use crate::util::js::{ms_from_iso, now_iso, now_ms, number_to_string};

// ── Errors ───────────────────────────────────────────────────────────────

/// Why an install step failed. The Node code threw an `Error` and sometimes tagged it: `code` ("HOST_REFUSED",
/// "HASH_MISMATCH", "LOCKED", "BAD_ARCHIVE", "UNKNOWN_MODEL", "NO_PYTHON") and `httpStatus`; callers tell failures
/// apart by these, and the voice routes pass `code` on to the UI.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct InstallError {
    pub message: String,
    pub code: Option<String>,
    /// The HTTP status a host answered with, when that was the failure.
    pub http_status: Option<u16>,
    /// The network failure underneath, when there was one (the JS `err.cause`).
    pub cause: Option<FetchError>,
}

impl InstallError {
    pub fn new(message: impl Into<String>) -> Self {
        InstallError {
            message: message.into(),
            code: None,
            http_status: None,
            cause: None,
        }
    }

    pub fn with_code(message: impl Into<String>, code: &str) -> Self {
        InstallError {
            code: Some(code.to_string()),
            ..Self::new(message)
        }
    }

    /// A request that got no answer, as the JS `fetch` threw it.
    pub fn from_fetch(err: FetchError) -> Self {
        InstallError {
            cause: Some(err.clone()),
            ..Self::new(err.to_string())
        }
    }

    pub fn has_code(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }
}

impl From<std::io::Error> for InstallError {
    fn from(err: std::io::Error) -> Self {
        InstallError::new(err.to_string())
    }
}

// ── Official hosts ───────────────────────────────────────────────────────

/// A kind of download and the hosts it may come from. `hosts` are exact names; `suffixes` cover a company's own CDN
/// names (Hugging Face sends its big files to <region>.cdn.hf.co and cdn-lfs*.huggingface.co).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfficialHost {
    pub name: &'static str,
    pub hosts: &'static [&'static str],
    pub suffixes: &'static [&'static str],
}

/// The hosts each kind of download may come from.
#[derive(Debug, Clone, Copy)]
pub struct OfficialHosts {
    pub huggingface: OfficialHost,
    pub github: OfficialHost,
}

pub const OFFICIAL_HOSTS: OfficialHosts = OfficialHosts {
    huggingface: OfficialHost {
        name: "Hugging Face",
        hosts: &["huggingface.co"],
        suffixes: &[".huggingface.co", ".hf.co"],
    },
    github: OfficialHost {
        name: "GitHub",
        hosts: &[
            "api.github.com",
            "github.com",
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
        ],
        suffixes: &[],
    },
};

const MAX_REDIRECTS: usize = 5;

/// `new URL(url).host` (the host and any port), or "an unknown host".
pub fn host_of(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return "an unknown host".into();
    };
    match (parsed.host_str(), parsed.port()) {
        (Some(host), Some(port)) if !host.is_empty() => format!("{host}:{port}"),
        (Some(host), None) if !host.is_empty() => host.to_string(),
        _ => "an unknown host".into(),
    }
}

/// Whether `url` is https on one of `sources`' hosts.
pub fn is_official_url(url: &str, sources: &[OfficialHost]) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    sources.iter().any(|s| {
        s.hosts.contains(&host.as_str())
            || s.suffixes
                .iter()
                .any(|suf| host.ends_with(suf) && host.len() > suf.len())
    })
}

/// What a download is fetched through: any [`Fetch`] (its failures become [`InstallError`]s carrying the network
/// error as their cause), or a [`GuardedFetch`], whose refusals carry the code "HOST_REFUSED".
#[async_trait]
pub trait Downloader: Send + Sync {
    async fn get(&self, request: FetchRequest) -> Result<FetchResponse, InstallError>;
}

#[async_trait]
impl<F: Fetch + ?Sized> Downloader for F {
    async fn get(&self, request: FetchRequest) -> Result<FetchResponse, InstallError> {
        self.fetch(request).await.map_err(InstallError::from_fetch)
    }
}

/// A fetch that only ever talks to its sources' hosts over https. Redirects are followed by hand (at most 5): one to
/// any other host, or to plain http, is refused (code HOST_REFUSED) before anything is sent there.
pub struct GuardedFetch {
    sources: Vec<OfficialHost>,
    fetch: Arc<dyn Fetch>,
}

/// `guardedFetch(sources, fetchImpl)`.
pub fn guarded_fetch(sources: &[OfficialHost], fetch: Arc<dyn Fetch>) -> GuardedFetch {
    GuardedFetch {
        sources: sources.to_vec(),
        fetch,
    }
}

impl GuardedFetch {
    fn names(&self) -> String {
        let mut names: Vec<&str> = Vec::new();
        for s in &self.sources {
            if !names.contains(&s.name) {
                names.push(s.name);
            }
        }
        names.join(" or ")
    }
}

#[async_trait]
impl Downloader for GuardedFetch {
    async fn get(&self, request: FetchRequest) -> Result<FetchResponse, InstallError> {
        let first = request.url.clone();
        let mut current = request.url.clone();
        for _hop in 0..=MAX_REDIRECTS {
            if !is_official_url(&current, &self.sources) {
                return Err(InstallError::with_code(
                    format!(
                        "refused to download from {}: only {} over https is allowed",
                        host_of(&current),
                        self.names()
                    ),
                    "HOST_REFUSED",
                ));
            }
            let mut hop = request.clone();
            hop.url = current.clone();
            hop.follow_redirects = false;
            let res = self.fetch.fetch(hop).await.map_err(InstallError::from_fetch)?;
            let location = if (300..400).contains(&res.status) {
                res.header("location").map(str::to_string)
            } else {
                None
            };
            let Some(location) = location else {
                return Ok(res);
            };
            // Nothing to drain: dropping the answer lets its body go.
            drop(res);
            current = url::Url::parse(&current)
                .and_then(|base| base.join(&location))
                .map(|u| u.to_string())
                .map_err(|err| InstallError::new(format!("Invalid URL: {err}")))?;
        }
        Err(InstallError::new(format!(
            "too many redirects from {}",
            host_of(&first)
        )))
    }
}

// ── Hashes ───────────────────────────────────────────────────────────────

/// The hash git (and so Hugging Face, for files kept in git rather than LFS) gives a file: sha1("blob <size>\0" +
/// data).
pub fn git_blob_sha1(buf: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(format!("blob {}\0", buf.len()).as_bytes());
    h.update(buf);
    hex::encode(h.finalize())
}

/// sha256 and git blob sha1 of a file on disk.
struct FileHashes {
    sha256: String,
    git_sha1: String,
}

fn hash_file_blocking(file: &Path) -> std::io::Result<FileHashes> {
    let size = std::fs::metadata(file)?.len();
    let mut s256 = Sha256::new();
    let mut s1 = Sha1::new();
    s1.update(format!("blob {size}\0").as_bytes());
    let mut f = std::fs::File::open(file)?;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        s256.update(&buf[..n]);
        s1.update(&buf[..n]);
    }
    Ok(FileHashes {
        sha256: hex::encode(s256.finalize()),
        git_sha1: hex::encode(s1.finalize()),
    })
}

async fn hash_file(file: &Path) -> std::io::Result<FileHashes> {
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || hash_file_blocking(&file))
        .await
        .map_err(std::io::Error::other)?
}

/// The sha256 of a file, in hex.
pub async fn sha256_file(file: &Path) -> std::io::Result<String> {
    Ok(hash_file(file).await?.sha256)
}

/// `path` with `suffix` added to its file name.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Writes `data` to a temporary name beside `file`, then renames it into place: a reader never sees half of it.
pub fn write_file_atomic(file: &Path, data: impl AsRef<[u8]>) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = with_suffix(file, &format!(".tmp-{}", std::process::id()));
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, file)
}

// ── Downloads ────────────────────────────────────────────────────────────

const DOWNLOAD_ATTEMPTS: u32 = 3;
const STALL: Duration = Duration::from_secs(60);

/// What [`download_file`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Downloaded {
    /// The file already there passed every check and was kept ("kept").
    Kept,
    /// The file was downloaded; its sha256.
    Fetched(String),
}

/// One file to download: `downloadFile({ url, dest, sha256, gitSha1, size, progress, attempts, retryDelayMs })`.
pub struct DownloadFile<'a> {
    pub url: String,
    pub dest: PathBuf,
    pub sha256: Option<String>,
    /// git's blob hash (needs `size`).
    pub git_sha1: Option<String>,
    pub size: Option<u64>,
    /// Gets each chunk's size, and minus what a failed attempt had counted.
    pub progress: Option<&'a (dyn Fn(i64) + Send + Sync)>,
    pub attempts: u32,
    pub retry_delay: Duration,
    /// How long a transfer may go without data before it is aborted (60s; tests shorten it).
    pub stall: Duration,
}

impl<'a> DownloadFile<'a> {
    pub fn new(url: impl Into<String>, dest: impl Into<PathBuf>) -> Self {
        DownloadFile {
            url: url.into(),
            dest: dest.into(),
            sha256: None,
            git_sha1: None,
            size: None,
            progress: None,
            attempts: DOWNLOAD_ATTEMPTS,
            retry_delay: Duration::from_millis(1000),
            stall: STALL,
        }
    }

    pub fn sha256(mut self, hash: impl Into<String>) -> Self {
        self.sha256 = Some(hash.into());
        self
    }

    pub fn git_sha1(mut self, hash: impl Into<String>) -> Self {
        self.git_sha1 = Some(hash.into());
        self
    }

    pub fn size(mut self, size: u64) -> Self {
        self.size = Some(size);
        self
    }

    pub fn progress(mut self, progress: &'a (dyn Fn(i64) + Send + Sync)) -> Self {
        self.progress = Some(progress);
        self
    }

    pub fn attempts(mut self, attempts: u32) -> Self {
        self.attempts = attempts;
        self
    }

    pub fn retry_delay_ms(mut self, ms: u64) -> Self {
        self.retry_delay = Duration::from_millis(ms);
        self
    }

    fn report(&self, n: i64) {
        if let Some(progress) = self.progress {
            progress(n);
        }
    }
}

/// Whether a file already at dest is the one wanted: its size, and whichever hashes are given.
async fn matches(dest: &Path, spec: &DownloadFile<'_>) -> std::io::Result<bool> {
    let size = std::fs::metadata(dest)?.len();
    if size == 0 || spec.size.is_some_and(|want| want != size) {
        return Ok(false);
    }
    if spec.sha256.is_none() && spec.git_sha1.is_none() {
        return Ok(true);
    }
    let h = hash_file(dest).await?;
    Ok(spec.sha256.as_ref().is_none_or(|want| *want == h.sha256)
        && spec.git_sha1.as_ref().is_none_or(|want| *want == h.git_sha1))
}

/// `Number(text)` for a header: surrounding whitespace ignored, empty is 0, anything else not a number is NaN.
fn js_number(text: Option<&str>) -> f64 {
    let Some(text) = text else { return 0.0 };
    let text = text.trim();
    if text.is_empty() {
        return 0.0;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// Streams `url` to `dest`, then renames it into place. Checked first: the exact size when `size` is given (else
/// the Content-Length), the `sha256`, and the `git_sha1` (git's blob hash, which needs `size`). A file already at
/// dest that passes the same checks is kept without a download ([`Downloaded::Kept`]). Retries a few times; a
/// transfer with no data for 60s is aborted.
pub async fn download_file<D: Downloader + ?Sized>(
    fetch: &D,
    spec: DownloadFile<'_>,
) -> Result<Downloaded, InstallError> {
    if spec.git_sha1.is_some() && spec.size.is_none() {
        return Err(InstallError::new("downloadFile: a git hash needs the file's size"));
    }
    if spec.dest.exists() {
        if matches(&spec.dest, &spec).await? {
            spec.report(std::fs::metadata(&spec.dest)?.len() as i64);
            return Ok(Downloaded::Kept);
        }
        let _ = std::fs::remove_file(&spec.dest);
    }
    if let Some(parent) = spec.dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = spec
        .dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let mut last_err = InstallError::new("downloadFile: no attempt was made");
    for attempt in 1..=spec.attempts {
        let tmp = with_suffix(&spec.dest, ".part");
        let mut counted: u64 = 0;
        match try_download(fetch, &spec, &name, &tmp, &mut counted).await {
            Ok(got) => return Ok(Downloaded::Fetched(got)),
            Err(err) => {
                last_err = describe_fetch_error(&err, &spec.url);
                spec.report(-(counted as i64));
                let _ = tokio::fs::remove_file(&tmp).await;
                // A refused host or a missing file won't change on a retry.
                if err.has_code("HOST_REFUSED") || err.http_status == Some(404) {
                    break;
                }
                if attempt < spec.attempts {
                    tokio::time::sleep(spec.retry_delay * attempt).await;
                }
            }
        }
    }
    Err(last_err)
}

fn stalled(stall: Duration) -> InstallError {
    InstallError::new(format!(
        "no data for {}s",
        number_to_string(stall.as_millis() as f64 / 1000.0)
    ))
}

async fn try_download<D: Downloader + ?Sized>(
    fetch: &D,
    spec: &DownloadFile<'_>,
    name: &str,
    tmp: &Path,
    counted: &mut u64,
) -> Result<String, InstallError> {
    let res = tokio::time::timeout(spec.stall, fetch.get(FetchRequest::get(spec.url.clone())))
        .await
        .map_err(|_| stalled(spec.stall))??;
    if !res.ok() {
        return Err(InstallError {
            http_status: Some(res.status),
            ..InstallError::new(format!(
                "{} answered HTTP {} for {name}",
                host_of(&spec.url),
                res.status
            ))
        });
    }
    let content_length = res.header("content-length").map(str::to_string);
    let content_encoding = res.header("content-encoding").map(str::to_string);
    let mut s256 = Sha256::new();
    let mut s1 = spec.git_sha1.as_ref().map(|_| {
        let mut h = Sha1::new();
        h.update(format!("blob {}\0", spec.size.unwrap_or(0)).as_bytes());
        h
    });
    {
        let mut file = tokio::fs::File::create(tmp).await?;
        let mut body = res.into_stream();
        loop {
            let chunk = match tokio::time::timeout(spec.stall, body.next()).await {
                Err(_) => return Err(stalled(spec.stall)),
                Ok(None) => break,
                Ok(Some(Err(err))) => return Err(InstallError::from_fetch(err)),
                Ok(Some(Ok(chunk))) => chunk,
            };
            s256.update(&chunk);
            if let Some(h) = s1.as_mut() {
                h.update(&chunk);
            }
            *counted += chunk.len() as u64;
            spec.report(chunk.len() as i64);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file.into_std().await);
    }
    if let Some(size) = spec.size
        && *counted != size
    {
        return Err(InstallError::new(format!(
            "{name} is the wrong size ({counted} bytes, not the {size} its source lists)"
        )));
    }
    // A compressed response's Content-Length is not the size of what we read.
    let expected = js_number(content_length.as_deref());
    if spec.size.is_none() && content_encoding.is_none() && expected > 0.0 && *counted as f64 != expected {
        return Err(InstallError::new(format!(
            "{name} was cut short ({counted} of {} bytes)",
            number_to_string(expected)
        )));
    }
    let got = hex::encode(s256.finalize());
    let bad = if spec.sha256.as_ref().is_some_and(|want| *want != got) {
        Some("sha256")
    } else if let (Some(h), Some(want)) = (s1, spec.git_sha1.as_ref()) {
        (hex::encode(h.finalize()) != *want).then_some("hash")
    } else {
        None
    };
    if let Some(bad) = bad {
        return Err(InstallError::with_code(
            format!("{name} does not match its published {bad}"),
            "HASH_MISMATCH",
        ));
    }
    tokio::fs::rename(tmp, &spec.dest).await?;
    Ok(got)
}

/// fetch's own errors say nothing ("fetch failed", or "terminated" when a connection drops mid-file): name the host
/// and the cause instead. An error that did not come from the network is returned as it is.
pub fn describe_fetch_error(err: &InstallError, url: &str) -> InstallError {
    let host = host_of(url);
    let cause_text = |c: &str| {
        if c.is_empty() {
            "network error".to_string()
        } else {
            c.to_string()
        }
    };
    let message = match &err.cause {
        Some(FetchError::Connect(cause)) => format!("could not reach {host} ({})", cause_text(cause)),
        Some(FetchError::Body(cause)) => format!("the download from {host} was cut off ({})", cause_text(cause)),
        Some(timeout @ FetchError::Timeout) => format!("the download from {host} stopped ({timeout})"),
        _ => return err.clone(),
    };
    InstallError {
        cause: err.cause.clone(),
        ..InstallError::new(message)
    }
}

// ── Lock ─────────────────────────────────────────────────────────────────

const LOCK_STALE_MS: i64 = 2 * 60 * 60_000;

/// The lock files this process holds right now (the Node module's `_heldLocks`), kept in the app.
#[derive(Default)]
pub struct HeldLocks {
    files: Mutex<HashSet<PathBuf>>,
}

impl HeldLocks {
    pub fn of(app: &App) -> Arc<HeldLocks> {
        app.get_or_init(HeldLocks::default)
    }

    fn holds(&self, file: &Path) -> bool {
        self.files.lock().contains(file)
    }
}

/// A held install lock. Released by [`release`](Self::release) or when dropped.
pub struct InstallLock {
    file: PathBuf,
    held: Arc<HeldLocks>,
    released: AtomicBool,
}

impl InstallLock {
    /// The lock file.
    pub fn path(&self) -> &Path {
        &self.file
    }

    /// Lets the lock go (the function `acquireLock` returned).
    pub fn release(self) {
        self.release_now();
    }

    fn release_now(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        self.held.files.lock().remove(&self.file);
        // Already gone is fine.
        let _ = std::fs::remove_file(&self.file);
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        self.release_now();
    }
}

impl std::fmt::Debug for InstallLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstallLock").field("file", &self.file).finish()
    }
}

/// What a lock is for when the caller does not say.
pub const DEFAULT_LOCK_WHAT: &str = "Phonon install";

/// Takes `<root>/.install.lock` or fails (code LOCKED, "another <what> is already running"). `what` defaults to
/// "Phonon install".
pub fn acquire_lock(app: &App, root: &Path, what: Option<&str>) -> Result<InstallLock, InstallError> {
    let what = what.unwrap_or(DEFAULT_LOCK_WHAT);
    let held = HeldLocks::of(app);
    let file = root.join(".install.lock");
    std::fs::create_dir_all(root)?;
    for _ in 0..2 {
        let contents = serde_json::json!({ "pid": std::process::id(), "startedAt": now_iso() }).to_string();
        let created = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .and_then(|mut f| std::io::Write::write_all(&mut f, contents.as_bytes()));
        match created {
            Ok(()) => {
                held.files.lock().insert(file.clone());
                return Ok(InstallLock {
                    file,
                    held,
                    released: AtomicBool::new(false),
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                if !lock_is_stale(&file, &held) {
                    return Err(InstallError::with_code(
                        format!("another {what} is already running"),
                        "LOCKED",
                    ));
                }
                let _ = std::fs::remove_file(&file);
            }
            Err(err) => return Err(err.into()),
        }
    }
    Err(InstallError::with_code(
        format!("could not take the {what} lock"),
        "LOCKED",
    ))
}

fn lock_is_stale(file: &Path, held: &HeldLocks) -> bool {
    let info = std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let Some(info) = info else {
        // Unreadable: stale unless it was created a moment ago (being written).
        return match std::fs::metadata(file).and_then(|m| m.modified()) {
            Ok(modified) => {
                let mtime_ms = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                now_ms() - mtime_ms > 10_000
            }
            Err(_) => true,
        };
    };
    let pid = info.get("pid").and_then(serde_json::Value::as_f64);
    if pid == Some(f64::from(std::process::id())) {
        // Ours and held: a live lock. Ours but not held: left over from an earlier container that ran with the same
        // pid (common for PID 1-ish processes).
        return !held.holds(file);
    }
    let started = info
        .get("startedAt")
        .and_then(serde_json::Value::as_str)
        .and_then(ms_from_iso);
    let fresh = started.is_some_and(|started| now_ms() - started < LOCK_STALE_MS);
    if !fresh {
        return true;
    }
    // `process.kill(pid, 0)`: a pid that is not a whole number is refused there, which counted as stale.
    match pid {
        Some(pid) if pid.fract() == 0.0 && pid.abs() < 2_147_483_648.0 => !process_exists(pid as i64),
        _ => true,
    }
}

/// Whether a process with this id is running (or exists but is not ours to signal).
#[cfg(unix)]
fn process_exists(pid: i64) -> bool {
    // SAFETY: kill with signal 0 sends nothing; it only checks that the process exists and may be signalled.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether a process with this id is running (or exists but is not ours to open).
#[cfg(windows)]
fn process_exists(pid: i64) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    // SAFETY: plain Win32 calls on a handle this function opens and closes itself.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn process_exists(_pid: i64) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::fake_download_host::{FakeDownloadHost, Route};
    use crate::testkit::{test_app, tmp_dir};
    use rand::Rng;
    use std::sync::atomic::AtomicI64;

    // test/installer-downloads.test.js, the parts about downloads, hashes and the lock. The archive extractor's
    // cases are in tar_extract.rs.

    const HF: &[OfficialHost] = &[OFFICIAL_HOSTS.huggingface];
    const GH: &[OfficialHost] = &[OFFICIAL_HOSTS.github];

    fn sha(buf: &[u8]) -> String {
        hex::encode(Sha256::digest(buf))
    }

    fn random_bytes(n: usize) -> Vec<u8> {
        let mut buf = vec![0u8; n];
        rand::rng().fill_bytes(&mut buf);
        buf
    }

    fn sum(seen: &Mutex<Vec<i64>>) -> i64 {
        seen.lock().iter().sum()
    }

    #[test]
    fn knows_hugging_faces_and_githubs_hosts_https_only() {
        assert!(is_official_url(
            "https://huggingface.co/Systran/x/resolve/r/model.bin",
            HF
        ));
        assert!(
            is_official_url("https://us.aws.cdn.hf.co/xet-bridge-us/abc", HF),
            "Hugging Face's CDN"
        );
        assert!(is_official_url("https://cdn-lfs.huggingface.co/repos/x", HF));
        assert!(!is_official_url("http://huggingface.co/x", HF), "never plain http");
        assert!(!is_official_url("https://huggingface.co.evil.example/x", HF));
        assert!(!is_official_url("https://evilhf.co/x", HF));
        assert!(
            !is_official_url(
                "https://github.com/astral-sh/python-build-standalone/releases/download/x",
                HF
            ),
            "each installer names its hosts"
        );
        assert!(is_official_url(
            "https://release-assets.githubusercontent.com/github-production-release-asset/1",
            GH
        ));
        assert!(
            !is_official_url("https://raw.githubusercontent.com/someone/thing/main/x", GH),
            "not anyone's files on GitHub"
        );
        assert!(!is_official_url("not a url", GH));
        // Added: a name and password in the address, the host's case, and a bare suffix.
        assert!(!is_official_url("https://user:pw@huggingface.co/x", HF));
        assert!(is_official_url("https://HuggingFace.CO/x", HF));
        assert!(!is_official_url("https://hf.co/x", HF));
    }

    #[tokio::test]
    async fn follows_a_redirect_to_the_cdn_and_refuses_one_anywhere_else_before_sending_anything_there() {
        let host = FakeDownloadHost::new([
            (
                "https://huggingface.co/a",
                Route::redirect("https://us.aws.cdn.hf.co/xet/a"),
            ),
            ("https://us.aws.cdn.hf.co/xet/a", Route::body("ok")),
            ("https://huggingface.co/b", Route::redirect("https://evil.example/b")),
            (
                "https://huggingface.co/c",
                Route::redirect("http://cdn-lfs.huggingface.co/c"),
            ),
            ("https://huggingface.co/d", Route::redirect("/api/resolve-cache/d")),
            ("https://huggingface.co/api/resolve-cache/d", Route::body("relative")),
            (
                "https://huggingface.co/loop",
                Route::redirect("https://huggingface.co/loop"),
            ),
        ]);
        let get = guarded_fetch(HF, host.clone());
        let res = get.get(FetchRequest::get("https://huggingface.co/a")).await.unwrap();
        assert_eq!(res.text().await.unwrap(), "ok");
        assert!(
            !host.requests()[0].follow_redirects,
            "redirects are never followed blindly"
        );

        let err = get
            .get(FetchRequest::get("https://huggingface.co/b"))
            .await
            .unwrap_err();
        assert!(
            err.has_code("HOST_REFUSED") && err.message.contains("evil.example"),
            "{err}"
        );
        assert_eq!(
            host.hits("https://evil.example/b"),
            0,
            "nothing was sent to the other host"
        );
        let err = get
            .get(FetchRequest::get("https://huggingface.co/c"))
            .await
            .unwrap_err();
        assert!(err.has_code("HOST_REFUSED"));
        let res = get.get(FetchRequest::get("https://huggingface.co/d")).await.unwrap();
        assert_eq!(
            res.text().await.unwrap(),
            "relative",
            "a relative Location stays on the host"
        );
        let err = get
            .get(FetchRequest::get("https://huggingface.co/loop"))
            .await
            .unwrap_err();
        assert!(err.message.contains("redirect"), "{err}");
        let err = get.get(FetchRequest::get("https://example.com/x")).await.unwrap_err();
        assert!(err.has_code("HOST_REFUSED"));
        assert_eq!(
            err.message,
            "refused to download from example.com: only Hugging Face over https is allowed"
        );
    }

    #[tokio::test]
    async fn streams_with_progress_and_renames_into_place_only_when_size_and_sha256_match() {
        let dir = tmp_dir();
        let body = random_bytes(200_000);
        let host = FakeDownloadHost::new([("https://huggingface.co/f", Route::body(body.clone()).chunk(10_000))]);
        let seen = Mutex::new(Vec::new());
        let progress = |d: i64| seen.lock().push(d);
        let dest = dir.path().join("model.bin");
        let got = download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/f", &dest)
                .sha256(sha(&body))
                .size(body.len() as u64)
                .progress(&progress),
        )
        .await
        .unwrap();
        assert_eq!(got, Downloaded::Fetched(sha(&body)));
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(seen.lock().len() >= 20, "progress for each chunk");
        assert_eq!(sum(&seen), body.len() as i64);
    }

    #[tokio::test]
    async fn a_file_that_stops_halfway_is_retried_one_that_always_stops_fails_in_plain_words_and_leaves_nothing() {
        let dir = tmp_dir();
        let body = random_bytes(200_000);
        let b = body.clone();
        let flaky = FakeDownloadHost::new([(
            "https://huggingface.co/f",
            Route::dynamic(move |_, hit| {
                if hit == 1 {
                    Route::body(b.clone()).fail_at(50_000)
                } else {
                    Route::body(b.clone())
                }
            }),
        )]);
        let dest = dir.path().join("a.bin");
        let seen = Mutex::new(Vec::new());
        let progress = |d: i64| seen.lock().push(d);
        download_file(
            &*flaky,
            DownloadFile::new("https://huggingface.co/f", &dest)
                .sha256(sha(&body))
                .size(body.len() as u64)
                .retry_delay_ms(1)
                .progress(&progress),
        )
        .await
        .unwrap();
        assert_eq!(flaky.hits("https://huggingface.co/f"), 2);
        assert_eq!(
            sum(&seen),
            body.len() as i64,
            "the dropped attempt's bytes are taken back off the progress"
        );

        let dead = FakeDownloadHost::new([("https://huggingface.co/f", Route::body(body.clone()).fail_at(50_000))]);
        let dest2 = dir.path().join("b.bin");
        let err = download_file(
            &*dead,
            DownloadFile::new("https://huggingface.co/f", &dest2)
                .sha256(sha(&body))
                .size(body.len() as u64)
                .retry_delay_ms(1),
        )
        .await
        .unwrap_err();
        assert!(
            err.message.contains("cut off") && err.message.contains("huggingface.co"),
            "{err}"
        );
        assert_eq!(
            err.message,
            "the download from huggingface.co was cut off (other side closed)"
        );
        assert_eq!(dead.hits("https://huggingface.co/f"), 3, "three attempts");
        assert!(!dest2.exists());
        assert!(!with_suffix(&dest2, ".part").exists());
    }

    #[tokio::test]
    async fn a_bad_hash_or_a_wrong_size_is_refused() {
        let dir = tmp_dir();
        let body = random_bytes(200_000);
        let host = FakeDownloadHost::new([("https://huggingface.co/f", Route::body(body.clone()))]);
        let err = download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/f", dir.path().join("x"))
                .sha256(sha(b"other"))
                .size(body.len() as u64)
                .retry_delay_ms(1),
        )
        .await
        .unwrap_err();
        assert!(err.has_code("HASH_MISMATCH"), "{err}");
        assert_eq!(err.message, "x does not match its published sha256");
        let err = download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/f", dir.path().join("y"))
                .size(body.len() as u64 + 1)
                .retry_delay_ms(1),
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("size") || err.message.contains("bytes"), "{err}");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "nothing is left behind"
        );
    }

    #[tokio::test]
    async fn checks_hugging_faces_git_hash_the_one_it_publishes_for_small_files() {
        let dir = tmp_dir();
        let small = b"{\"alignment_heads\": [[1, 0]]}\n".to_vec();
        let host = FakeDownloadHost::new([
            ("https://huggingface.co/c", Route::body(small.clone())),
            (
                "https://huggingface.co/bad",
                Route::body(b"{\"alignment_heads\": [[9, 9]]}\n".to_vec()),
            ),
        ]);
        assert_eq!(
            git_blob_sha1(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a",
            "the same hash as git hash-object"
        );
        download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/c", dir.path().join("config.json"))
                .git_sha1(git_blob_sha1(&small))
                .size(small.len() as u64),
        )
        .await
        .unwrap();
        let err = download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/bad", dir.path().join("bad.json"))
                .git_sha1(git_blob_sha1(&small))
                .size(small.len() as u64)
                .retry_delay_ms(1),
        )
        .await
        .unwrap_err();
        assert!(err.has_code("HASH_MISMATCH"));
        assert_eq!(err.message, "bad.json does not match its published hash");
    }

    #[tokio::test]
    async fn a_file_already_in_place_that_matches_is_kept_without_a_download_one_that_doesnt_is_fetched_again() {
        let dir = tmp_dir();
        let body = random_bytes(200_000);
        let host = FakeDownloadHost::new([("https://huggingface.co/f", Route::body(body.clone()))]);
        let dest = dir.path().join("m.bin");
        std::fs::write(&dest, &body).unwrap();
        let spec = || {
            DownloadFile::new("https://huggingface.co/f", &dest)
                .sha256(sha(&body))
                .size(body.len() as u64)
        };
        let seen = AtomicI64::new(0);
        let progress = |d: i64| {
            seen.fetch_add(d, Ordering::SeqCst);
        };
        assert_eq!(
            download_file(&*host, spec().progress(&progress)).await.unwrap(),
            Downloaded::Kept
        );
        assert_eq!(host.hits("https://huggingface.co/f"), 0);
        assert_eq!(
            seen.load(Ordering::SeqCst),
            body.len() as i64,
            "a kept file counts as done"
        );
        std::fs::write(&dest, &body[..10]).unwrap();
        download_file(&*host, spec()).await.unwrap();
        assert_eq!(host.hits("https://huggingface.co/f"), 1);
    }

    // Added: what the Node tests left unchecked.

    #[tokio::test]
    async fn a_missing_file_is_not_retried_and_an_unreachable_host_is_named() {
        let dir = tmp_dir();
        let host = FakeDownloadHost::new([(
            "https://huggingface.co/down",
            Route::Error(FetchError::Connect("getaddrinfo ENOTFOUND huggingface.co".into())),
        )]);
        let err = download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/missing", dir.path().join("m")).retry_delay_ms(1),
        )
        .await
        .unwrap_err();
        assert_eq!(err.message, "huggingface.co answered HTTP 404 for m");
        assert_eq!(err.http_status, Some(404));
        assert_eq!(host.hits("https://huggingface.co/missing"), 1, "a 404 is not retried");

        let err = download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/down", dir.path().join("d")).retry_delay_ms(1),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.message,
            "could not reach huggingface.co (getaddrinfo ENOTFOUND huggingface.co)"
        );
        assert_eq!(host.hits("https://huggingface.co/down"), 3);

        let guarded = guarded_fetch(HF, host.clone());
        let err = download_file(
            &guarded,
            DownloadFile::new("https://evil.example/x", dir.path().join("e")).retry_delay_ms(1),
        )
        .await
        .unwrap_err();
        assert!(err.has_code("HOST_REFUSED"), "a refusal keeps its code");
        assert_eq!(host.hits("https://evil.example/x"), 0);
        assert!(
            download_file(
                &*host,
                DownloadFile::new("https://huggingface.co/x", dir.path().join("g")).git_sha1("ab")
            )
            .await
            .unwrap_err()
            .message
            .contains("needs the file's size")
        );
    }

    #[tokio::test]
    async fn without_a_listed_size_the_content_length_is_checked() {
        let dir = tmp_dir();
        let host = FakeDownloadHost::new([
            ("https://huggingface.co/short", Route::body("abc").content_length("10")),
            (
                "https://huggingface.co/gz",
                Route::body("abc")
                    .content_length("10")
                    .header("content-encoding", "gzip"),
            ),
        ]);
        let err = download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/short", dir.path().join("s")).retry_delay_ms(1),
        )
        .await
        .unwrap_err();
        assert_eq!(err.message, "s was cut short (3 of 10 bytes)");
        let got = download_file(
            &*host,
            DownloadFile::new("https://huggingface.co/gz", dir.path().join("g")),
        )
        .await
        .unwrap();
        assert_eq!(
            got,
            Downloaded::Fetched(sha(b"abc")),
            "a compressed answer's length is not the file's"
        );
    }

    #[tokio::test]
    async fn a_transfer_with_no_data_for_a_while_is_stopped() {
        let dir = tmp_dir();
        let host = FakeDownloadHost::new([(
            "https://huggingface.co/slow",
            Route::body(vec![0u8; 100]).chunk(10).delay_ms(400),
        )]);
        assert_eq!(
            DownloadFile::new("u", "d").stall,
            Duration::from_secs(60),
            "a minute, as in Node"
        );
        assert_eq!(stalled(STALL).message, "no data for 60s");
        let err = download_file(
            &*host,
            DownloadFile {
                stall: Duration::from_millis(100),
                ..DownloadFile::new("https://huggingface.co/slow", dir.path().join("s")).attempts(1)
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.message, "no data for 0.1s");
    }

    #[test]
    fn says_what_is_running() {
        let t = test_app();
        let dir = tmp_dir();
        let release = acquire_lock(&t, dir.path(), Some("speech-to-text install")).unwrap();
        let err = acquire_lock(&t, dir.path(), Some("speech-to-text install")).unwrap_err();
        assert!(
            err.has_code("LOCKED") && err.message.contains("speech-to-text install"),
            "{err}"
        );
        release.release();
        acquire_lock(&t, dir.path(), None).unwrap().release();
    }

    // Added: the lock's file, its staleness rules, and release on drop.
    #[test]
    fn a_lock_left_by_this_process_or_a_dead_one_is_taken_over() {
        let t = test_app();
        let dir = tmp_dir();
        let file = dir.path().join(".install.lock");
        {
            let lock = acquire_lock(&t, dir.path(), None).unwrap();
            let info: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(lock.path()).unwrap()).unwrap();
            assert_eq!(info["pid"], serde_json::json!(std::process::id()));
            let err = acquire_lock(&t, dir.path(), None).unwrap_err();
            assert_eq!(err.message, "another Phonon install is already running");
        }
        assert!(!file.exists(), "dropping the lock releases it");

        // Our pid, but not held by us: left over from an earlier run with the same pid.
        std::fs::write(
            &file,
            serde_json::json!({"pid": std::process::id(), "startedAt": now_iso()}).to_string(),
        )
        .unwrap();
        acquire_lock(&t, dir.path(), None).unwrap().release();
        // Older than two hours.
        std::fs::write(&file, r#"{"pid": 1, "startedAt": "2020-01-01T00:00:00.000Z"}"#).unwrap();
        acquire_lock(&t, dir.path(), None).unwrap().release();
        // Unreadable, and not new.
        std::fs::write(&file, "{not json").unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(old)
            .unwrap();
        acquire_lock(&t, dir.path(), None).unwrap().release();
        // Unreadable but just written: someone is writing it.
        std::fs::write(&file, "").unwrap();
        assert!(acquire_lock(&t, dir.path(), None).unwrap_err().has_code("LOCKED"));
        std::fs::remove_file(&file).unwrap();

        // A live process that is not this one.
        let mut child = std::process::Command::new(if cfg!(windows) { "ping" } else { "sleep" })
            .args(if cfg!(windows) {
                vec!["-n", "30", "127.0.0.1"]
            } else {
                vec!["30"]
            })
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::fs::write(
            &file,
            serde_json::json!({"pid": child.id(), "startedAt": now_iso()}).to_string(),
        )
        .unwrap();
        assert!(
            acquire_lock(&t, dir.path(), None).unwrap_err().has_code("LOCKED"),
            "a live owner keeps it"
        );
        child.kill().unwrap();
        child.wait().unwrap();
        acquire_lock(&t, dir.path(), None).unwrap().release();
    }

    #[test]
    fn write_file_atomic_leaves_only_the_file() {
        let dir = tmp_dir();
        let file = dir.path().join("sub").join("marker.json");
        write_file_atomic(&file, "{}\n").unwrap();
        write_file_atomic(&file, "{\"a\":1}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"a\":1}\n");
        assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn sha256_file_is_the_files_sha256() {
        let dir = tmp_dir();
        let file = dir.path().join("f");
        std::fs::write(&file, "hello\n").unwrap();
        assert_eq!(sha256_file(&file).await.unwrap(), sha(b"hello\n"));
        assert_eq!(host_of("https://huggingface.co:8443/x"), "huggingface.co:8443");
        assert_eq!(host_of("nope"), "an unknown host");
    }

    #[test]
    fn describe_fetch_error_names_the_host_and_passes_other_errors_through() {
        let url = "https://github.com/x";
        let e = |err: FetchError| describe_fetch_error(&InstallError::from_fetch(err), url).message;
        assert_eq!(
            e(FetchError::Connect(String::new())),
            "could not reach github.com (network error)"
        );
        assert_eq!(
            e(FetchError::Body("reset".into())),
            "the download from github.com was cut off (reset)"
        );
        assert_eq!(
            e(FetchError::Timeout),
            "the download from github.com stopped (the request timed out)"
        );
        assert_eq!(e(FetchError::Other("odd".into())), "odd");
        let plain = InstallError::with_code("refused", "HOST_REFUSED");
        assert!(describe_fetch_error(&plain, url).has_code("HOST_REFUSED"));
    }
}
