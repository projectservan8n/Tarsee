//! A tiny tar writer for tests: builds the .tar.gz archives the fake download host serves (a stand-in for
//! python-build-standalone's install_only archives), including the awkward cases a real one could have: a pax header
//! for a long name, symlinks, and the malicious entries an extractor must refuse. The Node tests'
//! `test/fakes/tar.js`.
//!
//! ```ignore
//! make_tar_gz(&[TarEntry::file("python/bin/python3", "...").mode(0o755), TarEntry::symlink("python/bin/python", "python3")])
//! ```

use std::io::Write;

/// What kind of entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TarKind {
    File,
    Dir,
    Symlink,
    Hardlink,
}

/// One entry: `{ name, type?, body?, mode?, linkname?, pax?, badChecksum? }`.
#[derive(Debug, Clone)]
pub struct TarEntry {
    pub name: String,
    pub kind: TarKind,
    pub body: Vec<u8>,
    pub mode: Option<u32>,
    pub linkname: String,
    /// Write the name in a pax header even when it would fit.
    pub pax: bool,
    /// Spoil the header's checksum.
    pub bad_checksum: bool,
}

impl TarEntry {
    fn new(name: &str, kind: TarKind) -> Self {
        TarEntry {
            name: name.to_string(),
            kind,
            body: Vec::new(),
            mode: None,
            linkname: String::new(),
            pax: false,
            bad_checksum: false,
        }
    }

    pub fn file(name: &str, body: impl AsRef<[u8]>) -> Self {
        TarEntry {
            body: body.as_ref().to_vec(),
            ..Self::new(name, TarKind::File)
        }
    }

    pub fn dir(name: &str) -> Self {
        Self::new(name, TarKind::Dir)
    }

    pub fn symlink(name: &str, linkname: &str) -> Self {
        TarEntry {
            linkname: linkname.to_string(),
            ..Self::new(name, TarKind::Symlink)
        }
    }

    pub fn hardlink(name: &str, linkname: &str) -> Self {
        TarEntry {
            linkname: linkname.to_string(),
            ..Self::new(name, TarKind::Hardlink)
        }
    }

    pub fn mode(mut self, mode: u32) -> Self {
        self.mode = Some(mode);
        self
    }

    pub fn pax(mut self) -> Self {
        self.pax = true;
        self
    }

    pub fn bad_checksum(mut self) -> Self {
        self.bad_checksum = true;
        self
    }
}

/// Writes `text` at `at`, at most `len` bytes of it.
fn put(h: &mut [u8], at: usize, len: usize, text: &[u8]) {
    let n = text.len().min(len);
    h[at..at + n].copy_from_slice(&text[..n]);
}

fn header(name: &str, size: usize, mode: u32, flag: u8, linkname: &str) -> Vec<u8> {
    let mut h = vec![0u8; 512];
    put(&mut h, 0, 100, name.as_bytes());
    put(&mut h, 100, 8, format!("{mode:07o}\0").as_bytes());
    put(&mut h, 108, 8, b"0000000\0");
    put(&mut h, 116, 8, b"0000000\0");
    put(&mut h, 124, 12, format!("{size:011o}\0").as_bytes());
    let mtime = chrono::Utc::now().timestamp().max(0) as u64;
    put(&mut h, 136, 12, format!("{mtime:011o}\0").as_bytes());
    put(&mut h, 148, 8, b"        ");
    h[156] = flag;
    put(&mut h, 157, 100, linkname.as_bytes());
    put(&mut h, 257, 6, b"ustar\0");
    put(&mut h, 263, 2, b"00");
    let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
    put(&mut h, 148, 8, format!("{sum:06o}\0 ").as_bytes());
    h
}

fn pad(n: usize) -> Vec<u8> {
    vec![0u8; (512 - (n % 512)) % 512]
}

fn pax_record(key: &str, value: &str) -> String {
    let body = format!(" {key}={value}\n");
    let mut len = body.len() + 1;
    while len.to_string().len() + body.len() != len {
        len = len.to_string().len() + body.len();
    }
    format!("{len}{body}")
}

/// The archive, uncompressed.
pub fn make_tar(entries: &[TarEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in entries {
        let body: &[u8] = if e.kind == TarKind::File { &e.body } else { &[] };
        let mut name = e.name.clone();
        if e.pax || name.len() > 99 {
            let rec = pax_record("path", &name);
            out.extend(header("PaxHeader/x", rec.len(), 0o644, b'x', ""));
            out.extend(rec.as_bytes());
            out.extend(pad(rec.len()));
            let chars: Vec<char> = name.chars().collect();
            name = chars[chars.len().saturating_sub(99)..].iter().collect();
        }
        let flag = match e.kind {
            TarKind::File => b'0',
            TarKind::Dir => b'5',
            TarKind::Symlink => b'2',
            TarKind::Hardlink => b'1',
        };
        let mode = e.mode.unwrap_or(if e.kind == TarKind::Dir { 0o755 } else { 0o644 });
        let mut h = header(&name, body.len(), mode, flag, &e.linkname);
        if e.bad_checksum {
            h[148] = b'9';
        }
        out.extend(h);
        out.extend(body);
        out.extend(pad(body.len()));
    }
    out.extend(vec![0u8; 1024]);
    out
}

/// The archive, gzip'd.
pub fn make_tar_gz(entries: &[TarEntry]) -> Vec<u8> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&make_tar(entries)).expect("writing to memory cannot fail");
    gz.finish().expect("writing to memory cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_are_ustar_with_a_valid_checksum_and_long_names_get_a_pax_record() {
        let tar = make_tar(&[TarEntry::file("a.txt", "hi").mode(0o755)]);
        assert_eq!(tar.len(), 512 + 512 + 1024);
        assert_eq!(&tar[0..5], b"a.txt");
        assert_eq!(&tar[100..108], b"0000755\0");
        assert_eq!(&tar[124..136], b"00000000002\0");
        assert_eq!(&tar[257..263], b"ustar\0");
        let mut sum: u32 = 0;
        for (i, b) in tar[..512].iter().enumerate() {
            sum += if (148..156).contains(&i) { 32 } else { u32::from(*b) };
        }
        assert_eq!(&tar[148..156], format!("{sum:06o}\0 ").as_bytes());

        assert_eq!(pax_record("path", "x"), "9 path=x\n");
        assert_eq!(pax_record("path", "abcd"), "13 path=abcd\n");
        let long = format!("{}end", "d/".repeat(60));
        let tar = make_tar(&[TarEntry::file(&long, "")]);
        assert_eq!(tar[156], b'x');
        assert!(make_tar_gz(&[TarEntry::dir("d/")]).starts_with(&[0x1f, 0x8b]));
    }
}
