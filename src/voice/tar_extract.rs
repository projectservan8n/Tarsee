//! Port of `src/voice/tar-extract.js`: a small, strict .tar.gz extractor, for the standalone Python archive
//! (`python_runtime`). Running the system's tar on a download would hand it whatever the archive asks for; this one
//! only ever writes inside its folder:
//!   - no absolute paths, drive letters or ".." parts; nothing written through a symlink (links are made last);
//!   - a symlink must be relative and, once made, resolve inside the folder (a chain of links that leads out is
//!     caught); on Windows, where making one needs extra rights, a link to a file is copied instead;
//!   - hard links are copies of a file already extracted; devices, fifos and anything else are refused;
//!   - modes keep their execute bits but never setuid, setgid or write for others.
//!
//! Any refusal, or a damaged archive, removes the half-made folder. Nothing in the archive is ever run here.
//!
//! The numbers in a header are read the way the JavaScript read them (as doubles, `parseInt` with base 8), so a
//! damaged header fails the same way.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::install_common::InstallError;
use super::speech_text::is_js_space;
use crate::util::js::utf16_truncate;

const BLOCK: usize = 512;

/// What was extracted: `{ files, dirs, links }`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ExtractCounts {
    pub files: u64,
    pub dirs: u64,
    pub links: u64,
}

/// Why extraction stopped.
enum Fail {
    /// The archive asked for something it should not, or is damaged (code BAD_ARCHIVE).
    Refuse(String),
    /// The gzip stream could not be decoded.
    Zlib(String),
    Io(std::io::Error),
}

impl From<std::io::Error> for Fail {
    fn from(err: std::io::Error) -> Self {
        Fail::Io(err)
    }
}

fn refuse(why: impl Into<String>) -> Fail {
    Fail::Refuse(why.into())
}

/// A NUL-terminated text field.
fn cstr(buf: &[u8], start: usize, len: usize) -> String {
    let s = &buf[start..start + len];
    let end = s.iter().position(|&b| b == 0).unwrap_or(s.len());
    String::from_utf8_lossy(&s[..end]).into_owned()
}

/// `Number.parseInt(text, radix)`: optional whitespace and sign, then the longest run of digits; NaN when there
/// are none.
fn parse_int(text: &str, radix: u32) -> f64 {
    let text = text.trim_start_matches(is_js_space);
    let (sign, rest) = match text.as_bytes().first() {
        Some(b'-') => (-1.0, &text[1..]),
        Some(b'+') => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    let mut n = f64::NAN;
    for c in rest.chars() {
        let Some(d) = c.to_digit(radix) else { break };
        n = if n.is_nan() { 0.0 } else { n } * f64::from(radix) + f64::from(d);
    }
    sign * n
}

fn octal(buf: &[u8], start: usize, len: usize) -> f64 {
    // GNU base-256 for big numbers: the high bit of the first byte is set.
    if buf[start] & 0x80 != 0 {
        let mut n = 0.0;
        for &b in &buf[start + 1..start + len] {
            n = n * 256.0 + f64::from(b);
        }
        return n;
    }
    let s = cstr(buf, start, len);
    let s = s.trim();
    if s.is_empty() { 0.0 } else { parse_int(s, 8) }
}

/// The header's checksum: the unsigned sum POSIX asks for, or the signed one some old writers made.
fn checksum_ok(h: &[u8]) -> bool {
    let mut sum: i64 = 0;
    let mut signed: i64 = 0;
    for (i, &byte) in h.iter().enumerate().take(BLOCK) {
        let b = if (148..156).contains(&i) { 32 } else { i64::from(byte) };
        sum += b;
        signed += if b > 127 { b - 256 } else { b };
    }
    let want = octal(h, 148, 8);
    want == sum as f64 || want == signed as f64
}

fn parse_pax(buf: &[u8]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut i = 0usize;
    while i < buf.len() {
        let Some(sp) = buf[i..].iter().position(|&b| b == 0x20).map(|p| p + i) else {
            break;
        };
        let len = parse_int(&String::from_utf8_lossy(&buf[i..sp]), 10);
        if len.is_nan() || len <= 0.0 {
            break;
        }
        let len = len as usize;
        let end = (i + len).saturating_sub(1).min(buf.len());
        let rec = if sp + 1 < end {
            String::from_utf8_lossy(&buf[sp + 1..end]).into_owned()
        } else {
            String::new()
        };
        if let Some(eq) = rec.find('=')
            && eq > 0
        {
            out.insert(rec[..eq].to_string(), rec[eq + 1..].to_string());
        }
        i += len;
    }
    out
}

fn starts_with_drive(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

fn json_text(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// The parts of an entry's name once `strip` leading folders are gone; refuses anything that could leave dest.
fn parts_of(name: &str, strip: usize) -> Result<Vec<String>, Fail> {
    let shown = utf16_truncate(name, 120);
    if name.contains('\0') || name.contains('\\') {
        return Err(refuse(format!("has a name it should not: {}", json_text(&shown))));
    }
    if name.starts_with('/') || starts_with_drive(name) {
        return Err(refuse(format!("has an absolute path: {shown}")));
    }
    let parts: Vec<&str> = name.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.contains(&"..") {
        return Err(refuse(format!("has a path outside its folder: {shown}")));
    }
    if parts.iter().any(|p| p.contains(':')) {
        return Err(refuse(format!("has a name Windows can't hold: {shown}")));
    }
    Ok(parts.into_iter().skip(strip).map(str::to_string).collect())
}

fn is_inside(root: &Path, p: &Path) -> bool {
    p.starts_with(root)
}

fn join_parts(root: &Path, parts: &[String]) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in parts {
        p.push(part);
    }
    p
}

/// `path.resolve(base, rel)` for a relative `rel` with forward slashes: worked out on the text, links not followed.
fn lexical_resolve(base: &Path, rel: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The real path of something on disk (`fs.realpathSync.native`), in the plain form Node gives on Windows
/// (`C:\x`, not `\\?\C:\x`), so it compares with the folder's own.
fn real_path(p: &Path) -> std::io::Result<PathBuf> {
    Ok(plain_path(std::fs::canonicalize(p)?))
}

#[cfg(windows)]
fn plain_path(p: PathBuf) -> PathBuf {
    let text = p.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\")
        && starts_with_drive(rest)
    {
        return PathBuf::from(rest);
    }
    p
}

#[cfg(not(windows))]
fn plain_path(p: PathBuf) -> PathBuf {
    p
}

fn file_exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// rwx for the owner, rx for others where the archive had x; never setuid/setgid/sticky or group/other write.
fn safe_mode(mode: f64) -> u32 {
    let m = if mode.is_nan() || mode == 0.0 {
        0o644
    } else {
        // JavaScript's bitwise operators work on the number cut to 32 bits.
        (mode.trunc() as i64) as i32 as u32
    } & 0o777;
    (m & 0o755) | 0o600
}

/// An entry's header, as `readEntries` handed it on.
struct Entry {
    name: String,
    kind: String,
    size: f64,
    mode: f64,
    linkname: String,
}

/// Where an entry's data goes.
type Sink<'a> = &'a mut dyn FnMut(&[u8]) -> std::io::Result<()>;

/// The decompressed archive, read as it is needed.
struct Stream<R: Read> {
    src: R,
    buf: Vec<u8>,
    pos: usize,
    done: bool,
}

impl<R: Read> Stream<R> {
    fn available(&self) -> usize {
        self.buf.len() - self.pos
    }

    /// Reads until at least `n` bytes are buffered or the stream ends; whether there are `n`.
    fn fill(&mut self, n: f64) -> Result<bool, Fail> {
        let mut piece = vec![0u8; 64 * 1024];
        while (self.available() as f64) < n && !self.done {
            let got = match self.src.read(&mut piece) {
                Ok(got) => got,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => return Err(Fail::Zlib(err.to_string())),
            };
            if got == 0 {
                self.done = true;
                break;
            }
            if self.pos > 0 && self.pos == self.buf.len() {
                self.buf.clear();
                self.pos = 0;
            }
            self.buf.extend_from_slice(&piece[..got]);
        }
        Ok(self.available() as f64 >= n)
    }

    fn take(&mut self, n: usize) -> Vec<u8> {
        let n = n.min(self.available());
        let out = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        if self.pos > 1 << 20 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        out
    }

    /// The entry's data, to `sink` (None skips it), then its padding.
    fn read_body(&mut self, size: f64, padded: f64, mut sink: Option<Sink<'_>>) -> Result<(), Fail> {
        let mut left = size;
        while left > 0.0 {
            if !self.fill(1.0)? {
                return Err(refuse("ends in the middle of a file"));
            }
            let n = (left.min(self.available() as f64)) as usize;
            let piece = self.take(n.max(1));
            left -= piece.len() as f64;
            if let Some(sink) = sink.as_mut() {
                sink(&piece)?;
            }
        }
        let rest = padded - size;
        if rest > 0.0 {
            if !self.fill(rest)? {
                return Err(refuse("ends in the middle of a file"));
            }
            self.take(rest as usize);
        }
        Ok(())
    }
}

/// Reads the archive entry by entry; `on_entry` must read each entry's body exactly once through the stream.
fn read_entries<R: Read>(
    src: R,
    mut on_entry: impl FnMut(&Entry, &mut Stream<R>) -> Result<(), Fail>,
) -> Result<(), Fail> {
    let mut s = Stream {
        src,
        buf: Vec::new(),
        pos: 0,
        done: false,
    };
    let mut pax: HashMap<String, String> = HashMap::new();
    let mut long_name: Option<String> = None;
    let mut long_link: Option<String> = None;
    let mut zero_blocks = 0;
    let mut saw_entry = false;
    loop {
        if !s.fill(BLOCK as f64)? {
            if !saw_entry {
                return Err(refuse("is empty or not a tar archive"));
            }
            break; // some writers stop without the two zero blocks
        }
        let h = s.take(BLOCK);
        if h.iter().all(|&b| b == 0) {
            zero_blocks += 1;
            if zero_blocks >= 2 {
                break;
            }
            continue;
        }
        zero_blocks = 0;
        if !checksum_ok(&h) {
            return Err(refuse("is damaged (a header's checksum is wrong)"));
        }
        saw_entry = true;
        let flag = if h[156] == 0 { b'0' } else { h[156] };
        let size = octal(&h, 124, 12);
        let padded = (size / BLOCK as f64).ceil() * BLOCK as f64;

        let read_all = |s: &mut Stream<R>| -> Result<Vec<u8>, Fail> {
            if !s.fill(padded)? {
                return Err(refuse("ends in the middle of a file"));
            }
            let mut data = s.take(padded as usize);
            data.truncate(size as usize);
            Ok(data)
        };
        if flag == b'x' || flag == b'g' {
            let data = read_all(&mut s)?;
            if flag == b'x' {
                pax = parse_pax(&data);
            }
            continue;
        }
        if flag == b'L' || flag == b'K' {
            let v = String::from_utf8_lossy(&read_all(&mut s)?)
                .trim_end_matches('\0')
                .to_string();
            if flag == b'L' {
                long_name = Some(v);
            } else {
                long_link = Some(v);
            }
            continue;
        }

        let prefix = cstr(&h, 345, 155);
        let base = cstr(&h, 0, 100);
        let name = pax
            .get("path")
            .filter(|v| !v.is_empty())
            .cloned()
            .or_else(|| long_name.clone().filter(|v| !v.is_empty()))
            .unwrap_or_else(|| {
                if prefix.is_empty() {
                    base
                } else {
                    format!("{prefix}/{base}")
                }
            });
        let linkname = pax
            .get("linkpath")
            .filter(|v| !v.is_empty())
            .cloned()
            .or_else(|| long_link.clone().filter(|v| !v.is_empty()))
            .unwrap_or_else(|| cstr(&h, 157, 100));
        pax = HashMap::new();
        long_name = None;
        long_link = None;
        let kind = match flag {
            b'0' | b'7' => "file".to_string(),
            b'5' => "dir".to_string(),
            b'2' => "symlink".to_string(),
            b'1' => "hardlink".to_string(),
            other => format!("type {}", char::from(other)),
        };
        let entry = Entry {
            name: if kind == "dir" {
                name.trim_end_matches('/').to_string()
            } else {
                name
            },
            kind,
            size,
            mode: octal(&h, 100, 8),
            linkname,
        };
        on_entry(&entry, &mut s)?;
    }
    Ok(())
}

struct Link {
    target: PathBuf,
    link: String,
    name: String,
}

struct Hardlink {
    target: PathBuf,
    from: PathBuf,
    name: String,
}

/// Whether making a symlink failed for want of the right to make one (Windows: EPERM or EACCES).
fn no_right_to_link(err: &std::io::Error) -> bool {
    cfg!(windows) && (err.kind() == std::io::ErrorKind::PermissionDenied || err.raw_os_error() == Some(1314))
}

#[cfg(unix)]
fn make_symlink(link: &str, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(link, target)
}

#[cfg(windows)]
fn make_symlink(link: &str, target: &Path) -> std::io::Result<()> {
    // As Node does without a type: a link to a folder is made as a folder link, anything else as a file link.
    let to = lexical_resolve(target.parent().unwrap_or(target), link);
    let native = link.replace('/', "\\");
    if std::fs::metadata(&to).is_ok_and(|m| m.is_dir()) {
        std::os::windows::fs::symlink_dir(native, target)
    } else {
        std::os::windows::fs::symlink_file(native, target)
    }
}

#[cfg(not(any(unix, windows)))]
fn make_symlink(_link: &str, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("symlinks are not supported here"))
}

#[cfg(unix)]
fn create_file(target: &Path, mode: u32) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(target)
}

#[cfg(not(unix))]
fn create_file(target: &Path, _mode: u32) -> std::io::Result<std::fs::File> {
    std::fs::File::create(target)
}

#[cfg(unix)]
fn set_mode(target: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(target, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_target: &Path, _mode: u32) {}

/// Extracts the gzip'd tar `file` into `dest` (which must not exist yet), dropping `strip` leading folders from
/// every name. Refusals have the code BAD_ARCHIVE.
pub async fn extract_tar_gz(file: &Path, dest: &Path, strip: usize) -> Result<ExtractCounts, InstallError> {
    let file = file.to_path_buf();
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || extract_tar_gz_blocking(&file, &dest, strip))
        .await
        .map_err(|err| InstallError::new(err.to_string()))?
}

/// [`extract_tar_gz`], on the calling thread.
pub fn extract_tar_gz_blocking(file: &Path, dest: &Path, strip: usize) -> Result<ExtractCounts, InstallError> {
    if dest.exists() {
        return Err(InstallError::new(format!(
            "extractTarGz: {} already exists",
            dest.display()
        )));
    }
    std::fs::create_dir_all(dest)?;
    let result = real_path(dest)
        .map_err(Fail::Io)
        .and_then(|root| extract_into(file, &root, strip));
    match result {
        Ok(counts) => Ok(counts),
        Err(fail) => {
            let _ = std::fs::remove_dir_all(dest);
            Err(match fail {
                Fail::Refuse(why) => InstallError::with_code(format!("the archive {why}"), "BAD_ARCHIVE"),
                Fail::Zlib(msg) => {
                    InstallError::with_code(format!("the archive could not be read ({msg})"), "BAD_ARCHIVE")
                }
                Fail::Io(err) => err.into(),
            })
        }
    }
}

fn extract_into(file: &Path, root: &Path, strip: usize) -> Result<ExtractCounts, Fail> {
    let mut counts = ExtractCounts::default();
    let mut links: Vec<Link> = Vec::new();
    let mut hardlinks: Vec<Hardlink> = Vec::new();
    let src = std::fs::File::open(file)?;
    let gunzip = flate2::read::MultiGzDecoder::new(BufReader::new(src));

    read_entries(gunzip, |entry, s| {
        let size = entry.size;
        let padded = (size / BLOCK as f64).ceil() * BLOCK as f64;
        let parts = parts_of(&entry.name, strip)?;
        if parts.is_empty() {
            return s.read_body(size, padded, None);
        }
        let shown = utf16_truncate(&entry.name, 120);
        let target = join_parts(root, &parts);
        if !is_inside(root, &target) {
            return Err(refuse(format!("has a path outside its folder: {shown}")));
        }
        let joined = parts.join("/");
        match entry.kind.as_str() {
            "dir" => {
                std::fs::create_dir_all(&target)?;
                counts.dirs += 1;
                s.read_body(size, padded, None)
            }
            "file" => {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                if target.exists() && std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
                    return Err(refuse(format!("names {joined} as both a file and a folder")));
                }
                match std::fs::remove_file(&target) {
                    Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
                    _ => {}
                }
                let mode = safe_mode(entry.mode);
                let mut out = create_file(&target, mode)?;
                let mut write = |piece: &[u8]| out.write_all(piece);
                s.read_body(size, padded, Some(&mut write))?;
                drop(out);
                set_mode(&target, mode);
                counts.files += 1;
                Ok(())
            }
            "symlink" => {
                let link = &entry.linkname;
                let outside = || refuse(format!("has a link that points outside its folder: {joined} -> {link}"));
                if link.is_empty()
                    || link.starts_with('/')
                    || starts_with_drive(link)
                    || link.contains('\\')
                    || link.contains('\0')
                {
                    return Err(outside());
                }
                if !is_inside(root, &lexical_resolve(target.parent().unwrap_or(root), link)) {
                    return Err(outside());
                }
                links.push(Link {
                    target,
                    link: link.clone(),
                    name: joined,
                });
                s.read_body(size, padded, None)
            }
            "hardlink" => {
                let from = join_parts(root, &parts_of(&entry.linkname, strip)?);
                if !is_inside(root, &from) {
                    return Err(refuse(format!("has a hard link outside its folder: {joined}")));
                }
                hardlinks.push(Hardlink {
                    target,
                    from,
                    name: joined,
                });
                s.read_body(size, padded, None)
            }
            other => Err(refuse(format!(
                "has an entry of a kind it should not ({other}): {joined}"
            ))),
        }
    })?;

    for h in &hardlinks {
        if !h.from.exists() || !std::fs::symlink_metadata(&h.from).is_ok_and(|m| m.is_file()) {
            return Err(refuse(format!("has a hard link to nothing: {}", h.name)));
        }
        if let Some(parent) = h.target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&h.from, &h.target)?;
        counts.files += 1;
    }

    // Links last, so no file was ever written through one.
    for l in &links {
        if file_exists(&l.target) {
            return Err(refuse(format!("names {} twice", l.name)));
        }
        if let Some(parent) = l.target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Err(err) = make_symlink(&l.link, &l.target) {
            if !no_right_to_link(&err) {
                return Err(err.into());
            }
            // Windows without the right to make links: a link to a file is copied.
            let to = lexical_resolve(l.target.parent().unwrap_or(root), &l.link);
            if !std::fs::metadata(&to).is_ok_and(|m| m.is_file()) {
                return Err(refuse(format!("has a link this computer can't make: {}", l.name)));
            }
            std::fs::copy(&to, &l.target)?;
            counts.files += 1;
            continue;
        }
        counts.links += 1;
    }
    for l in &links {
        if !std::fs::symlink_metadata(&l.target)?.file_type().is_symlink() {
            continue;
        }
        // The operating system's own answer: worked out on the text, "x/../.." past a link x -> ".." reads as if x
        // were a folder and stays inside, when the system, following x first, goes out of the folder.
        let Ok(real) = real_path(&l.target) else {
            continue; // dangling: harmless
        };
        if !is_inside(root, &real) {
            return Err(refuse(format!("has links that lead outside its folder: {}", l.name)));
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::tar::{TarEntry, make_tar, make_tar_gz};
    use crate::testkit::tmp_dir;

    // test/installer-downloads.test.js, "extractTarGz".

    fn write(dir: &Path, name: &str, entries: &[TarEntry]) -> PathBuf {
        let f = dir.join(name);
        std::fs::write(&f, make_tar_gz(entries)).unwrap();
        f
    }

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    #[tokio::test]
    async fn extracts_files_folders_a_long_pax_name_and_same_folder_symlinks_stripping_the_top_folder() {
        let archives = tmp_dir();
        let long = "long-folder-name/".repeat(8);
        let file = write(
            archives.path(),
            "ok.tar.gz",
            &[
                TarEntry::dir("python/"),
                TarEntry::file("python/bin/python3.12", "interpreter").mode(0o755),
                TarEntry::symlink("python/bin/python3", "python3.12"),
                TarEntry::file(&format!("python/lib/{long}module.py"), "print(1)"),
                TarEntry::symlink("python/lib/python3.12/config/libpython.a", "../../libpython.a"),
                TarEntry::file("python/lib/libpython.a", "lib"),
            ],
        );
        let out = tmp_dir();
        let dest = out.path().join("out");
        let r = extract_tar_gz(&file, &dest, 1).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("bin").join("python3.12")).unwrap(),
            "interpreter"
        );
        let mut module = dest.join("lib");
        for part in long.split('/').filter(|p| !p.is_empty()) {
            module.push(part);
        }
        assert_eq!(std::fs::read_to_string(module.join("module.py")).unwrap(), "print(1)");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::read_link(dest.join("bin").join("python3")).unwrap(),
                PathBuf::from("python3.12")
            );
            let mode = std::fs::metadata(dest.join("bin").join("python3.12"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "executables stay executable");
        }
        // Either a link or (Windows without the right to make one) a copy: the content reads through.
        assert_eq!(
            std::fs::read_to_string(dest.join("bin").join("python3")).unwrap(),
            "interpreter"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("lib").join("python3.12").join("config").join("libpython.a")).unwrap(),
            "lib"
        );
        assert!(r.files >= 3);
        assert_eq!(r.dirs, 0, "the stripped top folder is not counted");
    }

    fn refused_cases() -> Vec<(&'static str, Vec<TarEntry>)> {
        vec![
            (
                "a path out of the folder",
                vec![TarEntry::file("python/../../escape.txt", "x")],
            ),
            ("an absolute path", vec![TarEntry::file("/etc/escape.txt", "x")]),
            ("a Windows drive path", vec![TarEntry::file("C:/escape.txt", "x")]),
            (
                "a symlink pointing out",
                vec![TarEntry::symlink("python/link", "../../../outside")],
            ),
            (
                "an absolute symlink",
                vec![TarEntry::symlink("python/link", "/etc/passwd")],
            ),
            (
                "a file written through a symlink",
                vec![
                    TarEntry::dir("python/sub/"),
                    TarEntry::symlink("python/up", "sub"),
                    TarEntry::file("python/up/x.txt", "x"),
                ],
            ),
            (
                "two symlinks that together lead out",
                vec![
                    TarEntry::dir("python/a/"),
                    TarEntry::symlink("python/a/x", ".."),
                    TarEntry::symlink("python/a/l", "x/../.."),
                ],
            ),
            (
                "a damaged header",
                vec![TarEntry::file("python/x.txt", "x").bad_checksum()],
            ),
        ]
    }

    #[tokio::test]
    async fn refuses_each_bad_archive_and_leaves_nothing_behind() {
        let archives = tmp_dir();
        for (i, (what, entries)) in refused_cases().into_iter().enumerate() {
            let file = write(archives.path(), &format!("bad-{i}.tar.gz"), &entries);
            let parent = tmp_dir();
            let dest = parent.path().join("out");
            let err = extract_tar_gz(&file, &dest, 1).await.unwrap_err();
            assert!(err.message.to_lowercase().contains("archive"), "{what}: {err}");
            assert!(err.has_code("BAD_ARCHIVE"), "{what}: {err}");
            assert!(!dest.exists(), "{what}: the half-made folder is removed");
            assert_eq!(
                std::fs::read_dir(parent.path()).unwrap().count(),
                0,
                "{what}: nothing next to it either"
            );
            assert!(!parent.path().join("escape.txt").exists(), "{what}");
            assert!(!archives.path().join("escape.txt").exists(), "{what}");
        }
    }

    #[tokio::test]
    async fn a_file_that_is_not_a_gzip_archive_is_refused() {
        let archives = tmp_dir();
        let f = archives.path().join("not.tar.gz");
        std::fs::write(&f, "<html>not found</html>").unwrap();
        let out = tmp_dir();
        let err = extract_tar_gz(&f, &out.path().join("out"), 0).await.unwrap_err();
        assert!(err.message.to_lowercase().contains("archive"), "{err}");
        assert!(err.message.starts_with("the archive could not be read ("), "{err}");
    }

    // Added: the messages, and the other refusals the Node tests did not reach.

    #[tokio::test]
    async fn each_refusal_says_what_was_wrong() {
        let archives = tmp_dir();
        let cases: Vec<(Vec<TarEntry>, &str)> = vec![
            (
                vec![TarEntry::file("python/../../escape.txt", "x")],
                "the archive has a path outside its folder: python/../../escape.txt",
            ),
            (
                vec![TarEntry::file("/etc/x", "x")],
                "the archive has an absolute path: /etc/x",
            ),
            (
                vec![TarEntry::file("python/a\\b", "x")],
                "the archive has a name it should not: \"python/a\\\\b\"",
            ),
            (
                vec![TarEntry::file("python/con:x", "x")],
                "the archive has a name Windows can't hold: python/con:x",
            ),
            (
                vec![TarEntry::symlink("python/l", "/etc/passwd")],
                "the archive has a link that points outside its folder: l -> /etc/passwd",
            ),
            (
                vec![TarEntry::symlink("python/l", "")],
                "the archive has a link that points outside its folder: l -> ",
            ),
            (
                vec![TarEntry::hardlink("python/h", "python/missing")],
                "the archive has a hard link to nothing: h",
            ),
            (
                vec![TarEntry::file("python/d/f", "x"), TarEntry::file("python/d", "y")],
                "the archive names d as both a file and a folder",
            ),
            (
                vec![TarEntry::file("python/f", "x"), TarEntry::symlink("python/f", "g")],
                "the archive names f twice",
            ),
            (
                vec![TarEntry::file("python/x", "x").bad_checksum()],
                "the archive is damaged (a header's checksum is wrong)",
            ),
        ];
        for (i, (entries, want)) in cases.into_iter().enumerate() {
            let file = write(archives.path(), &format!("m{i}.tar.gz"), &entries);
            let out = tmp_dir();
            let err = extract_tar_gz(&file, &out.path().join("out"), 1).await.unwrap_err();
            assert_eq!(err.message, want);
        }

        // A device, a fifo or anything else is refused; an empty archive and a cut-off one too.
        let mut fifo = make_tar(&[TarEntry::file("python/p", "")]);
        fifo[156] = b'6';
        let sum: u32 = fifo[..512]
            .iter()
            .enumerate()
            .map(|(i, b)| if (148..156).contains(&i) { 32 } else { u32::from(*b) })
            .sum();
        fifo[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        let f = archives.path().join("fifo.tar.gz");
        std::fs::write(&f, gz(&fifo)).unwrap();
        let out = tmp_dir();
        assert_eq!(
            extract_tar_gz(&f, &out.path().join("out"), 1)
                .await
                .unwrap_err()
                .message,
            "the archive has an entry of a kind it should not (type 6): p"
        );
        let f = archives.path().join("empty.tar.gz");
        std::fs::write(&f, gz(&[])).unwrap();
        assert_eq!(
            extract_tar_gz(&f, &out.path().join("out2"), 1)
                .await
                .unwrap_err()
                .message,
            "the archive is empty or not a tar archive"
        );
        let whole = make_tar(&[TarEntry::file("python/big", vec![7u8; 5000])]);
        let f = archives.path().join("cut.tar.gz");
        std::fs::write(&f, gz(&whole[..512 + 1000])).unwrap();
        assert_eq!(
            extract_tar_gz(&f, &out.path().join("out3"), 1)
                .await
                .unwrap_err()
                .message,
            "the archive ends in the middle of a file"
        );
        let existing = out.path().join("there");
        std::fs::create_dir_all(&existing).unwrap();
        let err = extract_tar_gz(&f, &existing, 1).await.unwrap_err();
        assert!(err.message.ends_with("already exists") && err.code.is_none(), "{err}");
        assert!(existing.exists(), "a folder that was there is left alone");
    }

    #[tokio::test]
    async fn hard_links_are_copies_and_modes_lose_setuid_and_write_for_others() {
        let archives = tmp_dir();
        let file = write(
            archives.path(),
            "h.tar.gz",
            &[
                TarEntry::file("python/a", "data").mode(0o6777),
                TarEntry::hardlink("python/b", "python/a"),
                TarEntry::file("python/./c", "c"),
            ],
        );
        let out = tmp_dir();
        let dest = out.path().join("out");
        let r = extract_tar_gz(&file, &dest, 1).await.unwrap();
        assert_eq!(
            r,
            ExtractCounts {
                files: 3,
                dirs: 0,
                links: 0
            }
        );
        assert_eq!(std::fs::read_to_string(dest.join("b")).unwrap(), "data");
        assert_eq!(std::fs::read_to_string(dest.join("c")).unwrap(), "c");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dest.join("a")).unwrap().permissions().mode() & 0o7777,
                0o755
            );
        }
        assert_eq!(safe_mode(0o6777.into()), 0o755);
        assert_eq!(safe_mode(0o640.into()), 0o640);
        assert_eq!(safe_mode(0o400.into()), 0o600);
        assert_eq!(safe_mode(f64::NAN), 0o644);
        assert_eq!(safe_mode(0.0), 0o644);
    }

    #[test]
    fn numbers_and_pax_records_read_as_the_javascript_read_them() {
        assert_eq!(parse_int("0000644", 8), 420.0);
        assert_eq!(parse_int("17x", 8), 15.0);
        assert!(parse_int("9", 8).is_nan());
        assert_eq!(parse_int("  -10", 10), -10.0);
        let mut h = vec![0u8; 512];
        h[124] = 0x80;
        h[134] = 1;
        h[135] = 2;
        assert_eq!(octal(&h, 124, 12), 258.0, "GNU base-256");
        let pax = parse_pax(b"20 path=a/b/c.txt\n\n12 bad\n");
        assert_eq!(pax.get("path").map(String::as_str), Some("a/b/c.txt\n\n"));
        let pax = parse_pax(b"18 path=a/b/c.txt\n");
        assert_eq!(pax.get("path").map(String::as_str), Some("a/b/c.txt"));
        assert!(parse_pax(b"x path=a\n").is_empty());
        let pax = parse_pax(b"5 a=b\n9 linkpath=z\n");
        assert_eq!(
            pax.into_iter().collect::<Vec<_>>(),
            vec![("a".to_string(), String::new())]
        );
    }
}
