//! Port of `src/lib/brand-icon.js`: Tarsee's own icon, replaceable from Settings → Appearance ("Tarsee's icon").
//!
//! The dashboard (src/public/js/brand-icon.js) lets the owner pick a picture, crop it square in the browser, and
//! send two things to POST /api/settings/brand-icon: a 1024x1024 PNG of the crop (the "master") and the file that
//! was picked (the "original", kept as it came, for reference). From the master this module makes every icon a
//! browser or an installed app asks for (favicon.ico, the 16 and 32 px tab icons, the iOS home-screen icon, the
//! PWA's 192 and 512 px icons, and a maskable 512 px icon that Android cuts into its own shape) and serves them at
//! the usual addresses in place of the default files in the public folder. The defaults are never touched, so a
//! reset only has to remove the upload.
//!
//! There is no image library in the app and this does not add one: a PNG is a zlib stream of filtered rows, small
//! enough to read and write by hand. So this file has its own PNG decoder (every colour type and bit depth, all
//! five row filters; interlaced files are refused), an area-average downscaler (each output pixel the exact
//! average of the source area it covers, partly covered pixels weighted by the part they cover), a PNG encoder and
//! an ICO writer that holds PNGs. The resizer keeps the JS's arithmetic, including where the JS stored a value in
//! a `Float32Array`, so it gives the same pixels.
//!
//! Everything lives in the data folder (on the persistent volume in a container deploy), never in git:
//! `<DATA_DIR>/brand` holds master.png, the generated icons, original.<ext> and brand.json
//! (`{ version, updatedAt, originalName, originalType, background }`). The version is the first 12 hex characters
//! of the master's sha256; the page and the manifest add it to every icon address (?v=) so a browser that kept the
//! old picture asks again. The default icon's version is "d" followed by 11 characters of icon-512.png's hash.

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::SystemTime;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use base64::Engine;
use bytes::Bytes;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::app::App;
use crate::config::env::create_private_dir;
use crate::util::js::{is_whitespace as js_space, now_iso, number_to_string, trim as js_trim, truthy, utf16_truncate};

pub const MASTER_MIN: u32 = 64;
pub const MASTER_MAX: u32 = 2048;
pub const MASTER_MAX_BYTES: usize = 15 * 1024 * 1024;
pub const ORIGINAL_MAX_BYTES: usize = 10 * 1024 * 1024;
/// The app's dark background (tokens.css --bg): behind an icon whose edge is see-through, where one must be opaque.
pub const DEFAULT_BACKGROUND: [u8; 3] = [0x1a, 0x1a, 0x1a];
/// How much of the maskable icon the picture fills: Android's mask may cut anything outside the middle 80%.
pub const MASKABLE_FILL: f64 = 0.8;

/// The addresses an uploaded icon is served at, and what each is.
pub const ICON_FILES: &[(&str, &str)] = &[
    ("/favicon.ico", "image/x-icon"),
    ("/icon-16.png", "image/png"),
    ("/icon-32.png", "image/png"),
    ("/apple-touch-icon.png", "image/png"),
    ("/icon-192.png", "image/png"),
    ("/icon-512.png", "image/png"),
    ("/icon-maskable-512.png", "image/png"),
];

/// The content type of an icon address, if it is one.
fn icon_type(path: &str) -> Option<&'static str> {
    ICON_FILES.iter().find(|(p, _)| *p == path).map(|(_, t)| *t)
}

/// A refusal of what was sent (the route answers 400 with its words).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct BrandIconError(pub String);

impl BrandIconError {
    /// Always 400: what was sent is the problem.
    pub fn status(&self) -> u16 {
        400
    }
}

fn refuse(message: impl Into<String>) -> BrandIconError {
    BrandIconError(message.into())
}

/// A chunk type as the messages show it: letters kept, anything else "?".
fn shown_type(t: &[u8]) -> String {
    t.iter()
        .map(|&b| if b.is_ascii_alphabetic() { char::from(b) } else { '?' })
        .collect()
}

// ---------------------------------------------------------------- CRC32 (PNG chunks)

static CRC_TABLE: LazyLock<[u32; 256]> = LazyLock::new(|| {
    let mut t = [0u32; 256];
    for (n, slot) in t.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 == 1 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    t
});

pub fn crc32(buf: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in buf {
        c = CRC_TABLE[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

// ---------------------------------------------------------------- PNG decoding

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// Channels per colour type.
fn channels(color_type: u8) -> Option<u32> {
    match color_type {
        0 => Some(1),
        2 => Some(3),
        3 => Some(1),
        4 => Some(2),
        6 => Some(4),
        _ => None,
    }
}

/// The bit depths each colour type allows.
fn depths(color_type: u8) -> &'static [u8] {
    match color_type {
        0 => &[1, 2, 4, 8, 16],
        2 => &[8, 16],
        3 => &[1, 2, 4, 8],
        4 => &[8, 16],
        6 => &[8, 16],
        _ => &[],
    }
}

pub fn is_png(buf: &[u8]) -> bool {
    buf.len() >= 8 && buf[..8] == PNG_SIGNATURE
}

fn u32_be(buf: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]])
}

/// A PNG's header (its first chunk, IHDR), read without unpacking the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PngHeader {
    pub width: u32,
    pub height: u32,
    pub bit_depth: u8,
    pub color_type: u8,
    pub compression: u8,
    pub filter: u8,
    pub interlace: u8,
}

pub fn read_png_header(buf: &[u8]) -> Result<PngHeader, BrandIconError> {
    if !is_png(buf) {
        return Err(refuse("That is not a PNG file."));
    }
    if buf.len() < 33 || &buf[12..16] != b"IHDR" || u32_be(buf, 8) != 13 {
        return Err(refuse("The PNG file has no proper header."));
    }
    Ok(PngHeader {
        width: u32_be(buf, 16),
        height: u32_be(buf, 20),
        bit_depth: buf[24],
        color_type: buf[25],
        compression: buf[26],
        filter: buf[27],
        interlace: buf[28],
    })
}

fn paeth(a: i32, b: i32, c: i32) -> i32 {
    let p = a + b - c;
    let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// Undo the row filters of `raw` (each row: a filter byte, then `stride` bytes) into one buffer of plain rows.
fn unfilter(raw: &[u8], height: usize, stride: usize, bpp: usize) -> Result<Vec<u8>, BrandIconError> {
    let mut out = vec![0u8; height * stride];
    let mut at = 0usize;
    for y in 0..height {
        let ft = raw[at];
        at += 1;
        let row = y * stride;
        let has_up = y > 0;
        let src = &raw[at..at + stride];
        match ft {
            0 => out[row..row + stride].copy_from_slice(src),
            1..=4 => {
                for i in 0..stride {
                    let a = if i >= bpp { i32::from(out[row + i - bpp]) } else { 0 };
                    let b = if has_up { i32::from(out[row - stride + i]) } else { 0 };
                    let c = if has_up && i >= bpp {
                        i32::from(out[row - stride + i - bpp])
                    } else {
                        0
                    };
                    let pred = match ft {
                        1 => a,
                        2 => b,
                        3 => (a + b) >> 1,
                        _ => paeth(a, b, c),
                    };
                    out[row + i] = ((i32::from(src[i]) + pred) & 255) as u8;
                }
            }
            _ => {
                return Err(refuse(format!(
                    "The PNG file is damaged (row {y} has an unknown filter, {ft})."
                )));
            }
        }
        at += stride;
    }
    Ok(out)
}

/// zlib's inflate as `inflateSync(data, { maxOutputLength })` ran it: the whole stream (what follows its end is
/// ignored), `None` when it is damaged, cut short or would unpack to more than `max`.
fn inflate_strict(data: &[u8], max: usize) -> Option<Vec<u8>> {
    use flate2::{Decompress, FlushDecompress, Status};
    let mut d = Decompress::new(true);
    let mut out: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let before_in = d.total_in();
        let before_out = d.total_out();
        let input = &data[(before_in as usize).min(data.len())..];
        let status = d.decompress(input, &mut chunk, FlushDecompress::None).ok()?;
        let produced = (d.total_out() - before_out) as usize;
        out.extend_from_slice(&chunk[..produced]);
        if out.len() > max {
            return None;
        }
        if status == Status::StreamEnd {
            return Some(out);
        }
        if d.total_in() == before_in && produced == 0 {
            return None;
        }
    }
}

/// An image as RGBA, 8 bits a channel: `data` is width x height x 4 bytes, rows top to bottom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// A PNG as RGBA (at most `MASTER_MAX` x `MASTER_MAX` pixels). See [`decode_png_with_limit`].
pub fn decode_png(buf: &[u8]) -> Result<RgbaImage, BrandIconError> {
    decode_png_with_limit(buf, u64::from(MASTER_MAX) * u64::from(MASTER_MAX))
}

/// A PNG as RGBA, 8 bits a channel. Colour types 0 (gray), 2 (RGB), 3 (palette, with PLTE and tRNS), 4 (gray and
/// alpha), 6 (RGBA), at every bit depth the format allows. 16-bit samples are rounded to 8; a gray of 1, 2 or 4
/// bits is spread over 0 to 255. Pictures of more than `max_pixels` pixels are refused.
pub fn decode_png_with_limit(buf: &[u8], max_pixels: u64) -> Result<RgbaImage, BrandIconError> {
    let head = read_png_header(buf)?;
    let PngHeader {
        width,
        height,
        bit_depth,
        color_type,
        ..
    } = head;
    if width == 0 || height == 0 {
        return Err(refuse("The PNG file is 0 pixels across."));
    }
    let Some(channels) = channels(color_type).filter(|_| depths(color_type).contains(&bit_depth)) else {
        return Err(refuse(format!(
            "The PNG file has a colour type ({color_type}) and bit depth ({bit_depth}) that do not go together."
        )));
    };
    if head.compression != 0 || head.filter != 0 {
        return Err(refuse(
            "The PNG file uses a compression or filter method that does not exist.",
        ));
    }
    if head.interlace == 1 {
        return Err(refuse(
            "Interlaced PNG files are not supported: save it again without interlacing.",
        ));
    }
    if head.interlace != 0 {
        return Err(refuse("The PNG file has an unknown interlace method."));
    }
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(refuse(format!("The PNG file is too big ({width} by {height} pixels).")));
    }

    let mut palette: Option<&[u8]> = None;
    let mut trns: Option<&[u8]> = None;
    let mut idat: Vec<u8> = Vec::new();
    let mut found_idat = false;
    let mut at = 8usize;
    while at + 12 <= buf.len() {
        let len = u32_be(buf, at) as usize;
        let kind = &buf[at + 4..at + 8];
        let start = at + 8;
        let end = start + len;
        if end + 4 > buf.len() {
            return Err(refuse("The PNG file is cut short."));
        }
        if crc32(&buf[at + 4..end]) != u32_be(buf, end) {
            return Err(refuse(format!(
                "The PNG file is damaged (its {} chunk fails its checksum).",
                shown_type(kind)
            )));
        }
        let data = &buf[start..end];
        match kind {
            b"IEND" => break,
            b"PLTE" => palette = Some(data),
            b"tRNS" => trns = Some(data),
            b"IDAT" => {
                idat.extend_from_slice(data);
                found_idat = true;
            }
            b"IHDR" => {}
            _ if kind[0] & 0x20 == 0 => {
                return Err(refuse(format!(
                    "The PNG file has a part this app cannot read ({}).",
                    shown_type(kind)
                )));
            }
            _ => {}
        }
        at = end + 4;
    }
    if !found_idat {
        return Err(refuse("The PNG file has no picture in it."));
    }
    if color_type == 3 && palette.is_none_or(|p| p.is_empty() || p.len() % 3 != 0) {
        return Err(refuse("The PNG file has no proper palette."));
    }

    let (width, height) = (width as usize, height as usize);
    let bits_per_pixel = channels as usize * usize::from(bit_depth);
    let stride = (width * bits_per_pixel).div_ceil(8);
    let bpp = (bits_per_pixel >> 3).max(1);
    let expected = height * (stride + 1);
    let Some(raw) = inflate_strict(&idat, expected) else {
        return Err(refuse("The PNG file is damaged (its picture data will not unpack)."));
    };
    if raw.len() < expected {
        return Err(refuse("The PNG file is cut short (its picture data ends early)."));
    }
    let px = unfilter(&raw, height, stride, bpp)?;

    let mut rgba = vec![0u8; width * height * 4];
    let depth = u32::from(bit_depth);
    let max = (1u32 << depth) - 1;
    let ch = channels as usize;
    // A sample as stored (before any scaling): what tRNS compares against.
    let sample_at = |row: usize, x: usize, c: usize| -> u32 {
        match bit_depth {
            8 => u32::from(px[row + x * ch + c]),
            16 => {
                let i = row + (x * ch + c) * 2;
                (u32::from(px[i]) << 8) | u32::from(px[i + 1])
            }
            // (1, 2 or 4 bits: one channel only, gray or palette)
            _ => {
                let bit = x * usize::from(bit_depth);
                (u32::from(px[row + (bit >> 3)]) >> (8 - depth - (bit & 7) as u32)) & max
            }
        }
    };
    let to8 = |v: u32| -> u8 {
        match bit_depth {
            16 => (f64::from(v) / 257.0).round() as u8,
            8 => v as u8,
            _ => (f64::from(v) * 255.0 / f64::from(max)).round() as u8,
        }
    };
    let u16_be = |d: &[u8], i: usize| (u32::from(d[i]) << 8) | u32::from(d[i + 1]);
    let trns_gray: Option<u32> = trns.filter(|t| color_type == 0 && t.len() >= 2).map(|t| u16_be(t, 0));
    let trns_rgb: Option<[u32; 3]> = trns
        .filter(|t| color_type == 2 && t.len() >= 6)
        .map(|t| [u16_be(t, 0), u16_be(t, 2), u16_be(t, 4)]);
    let colours = palette.map_or(0, |p| p.len() / 3);

    for y in 0..height {
        let row = y * stride;
        let mut o = y * width * 4;
        for x in 0..width {
            match color_type {
                0 => {
                    let g = sample_at(row, x, 0);
                    let v = to8(g);
                    rgba[o] = v;
                    rgba[o + 1] = v;
                    rgba[o + 2] = v;
                    rgba[o + 3] = if Some(g) == trns_gray { 0 } else { 255 };
                }
                2 => {
                    let (r, g, b) = (sample_at(row, x, 0), sample_at(row, x, 1), sample_at(row, x, 2));
                    rgba[o] = to8(r);
                    rgba[o + 1] = to8(g);
                    rgba[o + 2] = to8(b);
                    rgba[o + 3] = if trns_rgb == Some([r, g, b]) { 0 } else { 255 };
                }
                3 => {
                    let i = sample_at(row, x, 0) as usize;
                    if i >= colours {
                        return Err(refuse(
                            "The PNG file is damaged (a pixel names a colour its palette does not have).",
                        ));
                    }
                    let p = palette.unwrap_or(&[]);
                    rgba[o] = p[i * 3];
                    rgba[o + 1] = p[i * 3 + 1];
                    rgba[o + 2] = p[i * 3 + 2];
                    rgba[o + 3] = match trns {
                        Some(t) if i < t.len() => t[i],
                        _ => 255,
                    };
                }
                4 => {
                    let v = to8(sample_at(row, x, 0));
                    rgba[o] = v;
                    rgba[o + 1] = v;
                    rgba[o + 2] = v;
                    rgba[o + 3] = to8(sample_at(row, x, 1));
                }
                _ => {
                    rgba[o] = to8(sample_at(row, x, 0));
                    rgba[o + 1] = to8(sample_at(row, x, 1));
                    rgba[o + 2] = to8(sample_at(row, x, 2));
                    rgba[o + 3] = to8(sample_at(row, x, 3));
                }
            }
            o += 4;
        }
    }
    Ok(RgbaImage {
        width: width as u32,
        height: height as u32,
        data: rgba,
    })
}

// ---------------------------------------------------------------- PNG and ICO encoding

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let sum = crc32(&out[4..]);
    out.extend_from_slice(&sum.to_be_bytes());
    out
}

/// Filter one row of RGBA (`cur`, the row above `prev` or none) with filter `ft` into `dst`.
fn filter_row(ft: u8, cur: &[u8], prev: Option<&[u8]>, dst: &mut [u8]) {
    for i in 0..cur.len() {
        let a = if i >= 4 { i32::from(cur[i - 4]) } else { 0 };
        let b = prev.map_or(0, |p| i32::from(p[i]));
        let c = match prev {
            Some(p) if i >= 4 => i32::from(p[i - 4]),
            _ => 0,
        };
        let pred = match ft {
            0 => 0,
            1 => a,
            2 => b,
            3 => (a + b) >> 1,
            _ => paeth(a, b, c),
        };
        dst[i] = ((i32::from(cur[i]) - pred) & 255) as u8;
    }
}

/// How rows are filtered when a PNG is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PngFilter {
    /// Each row the filter that leaves it the smallest numbers (the usual rule of thumb).
    Auto,
    /// This filter (0 to 4) for every row.
    Fixed(u8),
}

/// An RGBA image as a PNG (8-bit RGBA), rows filtered automatically, compressed at level 6.
pub fn encode_png(img: &RgbaImage) -> anyhow::Result<Vec<u8>> {
    encode_png_with(img, PngFilter::Auto, 6)
}

/// An RGBA image as a PNG (8-bit RGBA) with this row filter and zlib level.
pub fn encode_png_with(img: &RgbaImage, filter: PngFilter, level: u32) -> anyhow::Result<Vec<u8>> {
    let (width, height) = (img.width as usize, img.height as usize);
    if width == 0 || height == 0 || img.data.len() != width * height * 4 {
        anyhow::bail!("encodePng: data is not width x height x 4 bytes");
    }
    if let PngFilter::Fixed(ft) = filter
        && ft > 4
    {
        // (The JS failed here too: it had no row buffer for a sixth filter.)
        anyhow::bail!("encodePng: there is no PNG row filter {ft}");
    }
    let stride = width * 4;
    let mut raw = vec![0u8; height * (stride + 1)];
    let mut trial = vec![vec![0u8; stride]; 5];
    for y in 0..height {
        let cur = &img.data[y * stride..(y + 1) * stride];
        let prev = (y > 0).then(|| &img.data[(y - 1) * stride..y * stride]);
        let best = match filter {
            PngFilter::Fixed(ft) => {
                filter_row(ft, cur, prev, &mut trial[usize::from(ft)]);
                ft
            }
            PngFilter::Auto => {
                let mut best = 0u8;
                let mut score = u64::MAX;
                for ft in 0..5u8 {
                    filter_row(ft, cur, prev, &mut trial[usize::from(ft)]);
                    let s: u64 = trial[usize::from(ft)]
                        .iter()
                        .map(|&t| if t < 128 { u64::from(t) } else { 256 - u64::from(t) })
                        .sum();
                    if s < score {
                        score = s;
                        best = ft;
                    }
                }
                best
            }
        };
        let o = y * (stride + 1);
        raw[o] = best;
        raw[o + 1..o + 1 + stride].copy_from_slice(&trial[usize::from(best)]);
    }
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&img.width.to_be_bytes());
    ihdr.extend_from_slice(&img.height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(level.min(9)));
    encoder.write_all(&raw)?;
    let deflated = encoder.finish()?;
    let mut out = PNG_SIGNATURE.to_vec();
    out.extend(chunk(b"IHDR", &ihdr));
    out.extend(chunk(b"IDAT", &deflated));
    out.extend(chunk(b"IEND", &[]));
    Ok(out)
}

/// An ICO file holding PNGs (`(size, png)`, each square): what Windows and every browser read for /favicon.ico.
pub fn encode_ico(images: &[(u32, &[u8])]) -> Vec<u8> {
    let mut head = vec![0u8; 6 + 16 * images.len()];
    head[0..2].copy_from_slice(&0u16.to_le_bytes()); // reserved
    head[2..4].copy_from_slice(&1u16.to_le_bytes()); // 1: an icon (2 would be a cursor)
    head[4..6].copy_from_slice(&(images.len() as u16).to_le_bytes());
    let mut offset = head.len() as u32;
    for (i, (size, png)) in images.iter().enumerate() {
        let e = 6 + 16 * i;
        let side = if *size >= 256 { 0 } else { *size as u8 };
        head[e] = side; // width (0 means 256)
        head[e + 1] = side; // height
        head[e + 2] = 0; // colours in a palette: none
        head[e + 3] = 0; // reserved
        head[e + 4..e + 6].copy_from_slice(&1u16.to_le_bytes()); // colour planes
        head[e + 6..e + 8].copy_from_slice(&32u16.to_le_bytes()); // bits a pixel
        head[e + 8..e + 12].copy_from_slice(&(png.len() as u32).to_le_bytes());
        head[e + 12..e + 16].copy_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
    }
    let mut out = head;
    for (_, png) in images {
        out.extend_from_slice(png);
    }
    out
}

// ---------------------------------------------------------------- resizing and backgrounds

/// For one axis, from n source pixels to m: which source pixels make each output pixel, and how much of it each.
/// Smaller (m < n): the area average, every output pixel covering n/m source pixels, the two at its ends by the
/// part of them it covers. Bigger (m > n): bilinear, between the two nearest source pixels. The weights are
/// worked out in f64 and kept as f32, as the JS kept them in a `Float32Array`.
struct AxisWeights {
    start: Vec<usize>,
    idx: Vec<usize>,
    w: Vec<f32>,
}

fn axis_weights(n: usize, m: usize) -> AxisWeights {
    let mut start = vec![0usize; m + 1];
    let mut idx: Vec<usize> = Vec::new();
    let mut w: Vec<f64> = Vec::new();
    let scale = n as f64 / m as f64;
    for (i, slot) in start.iter_mut().enumerate().take(m) {
        *slot = idx.len();
        let fi = i as f64;
        if m < n {
            let a = fi * scale;
            let b = (fi + 1.0) * scale;
            let mut sum = 0.0;
            let from = idx.len();
            let mut j = a.floor();
            let end = (n as f64).min(b.ceil());
            while j < end {
                let cover = (j + 1.0).min(b) - j.max(a);
                if cover > 1e-9 {
                    idx.push(j as usize);
                    w.push(cover);
                    sum += cover;
                }
                j += 1.0;
            }
            for weight in &mut w[from..] {
                *weight /= sum;
            }
        } else if m > n {
            let centre = (n as f64 - 1.0).min(0f64.max((fi + 0.5) * scale - 0.5));
            let j = centre.floor();
            let f = centre - j;
            idx.push(j as usize);
            w.push(1.0 - f);
            if f > 1e-9 && (j as usize) + 1 < n {
                idx.push(j as usize + 1);
                w.push(f);
            } else if let Some(last) = w.last_mut() {
                *last = 1.0;
            }
        } else {
            idx.push(i);
            w.push(1.0);
        }
    }
    start[m] = idx.len();
    AxisWeights {
        start,
        idx,
        w: w.into_iter().map(|x| x as f32).collect(),
    }
}

fn clamp8(v: f64) -> u8 {
    if v <= 0.0 {
        0
    } else if v >= 255.0 {
        255
    } else {
        v.round() as u8
    }
}

/// An RGBA image at another size. The colours are weighed by their alpha (premultiplied) while they are averaged,
/// so a see-through pixel's colour never bleeds a dark fringe into its opaque neighbours.
pub fn resize_rgba(img: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    let (sw, sh) = (img.width as usize, img.height as usize);
    if img.width == width && img.height == height {
        return img.clone();
    }
    let (width, height) = (width as usize, height as usize);
    let data = &img.data;
    let h = axis_weights(sw, width);
    let v = axis_weights(sh, height);
    // Across first: every source row to `width` pixels, premultiplied.
    let mut across = vec![0f32; width * sh * 4];
    for y in 0..sh {
        let src = y * sw * 4;
        let dst = y * width * 4;
        for x in 0..width {
            let (mut r, mut g, mut b, mut a) = (0f64, 0f64, 0f64, 0f64);
            for k in h.start[x]..h.start[x + 1] {
                let s = src + h.idx[k] * 4;
                let wa = f64::from(h.w[k]) * f64::from(data[s + 3]);
                r += f64::from(data[s]) * wa;
                g += f64::from(data[s + 1]) * wa;
                b += f64::from(data[s + 2]) * wa;
                a += wa;
            }
            let o = dst + x * 4;
            across[o] = r as f32;
            across[o + 1] = g as f32;
            across[o + 2] = b as f32;
            across[o + 3] = a as f32;
        }
    }
    // Then down, and back from premultiplied.
    let mut out = vec![0u8; width * height * 4];
    let mut acc = vec![0f64; width * 4];
    for y in 0..height {
        acc.fill(0.0);
        for k in v.start[y]..v.start[y + 1] {
            let wy = f64::from(v.w[k]);
            let row = v.idx[k] * width * 4;
            for (i, slot) in acc.iter_mut().enumerate() {
                *slot += f64::from(across[row + i]) * wy;
            }
        }
        let o = y * width * 4;
        for x in 0..width {
            let i = x * 4;
            let a = acc[i + 3];
            if a <= 1e-6 {
                continue; // (fully see-through: 0, 0, 0, 0)
            }
            out[o + i] = clamp8(acc[i] / a);
            out[o + i + 1] = clamp8(acc[i + 1] / a);
            out[o + i + 2] = clamp8(acc[i + 2] / a);
            out[o + i + 3] = clamp8(a);
        }
    }
    RgbaImage {
        width: width as u32,
        height: height as u32,
        data: out,
    }
}

/// [`edge_background_or`] with the app's dark background as the fallback.
pub fn edge_background(img: &RgbaImage) -> [u8; 3] {
    edge_background_or(img, DEFAULT_BACKGROUND)
}

/// The colour to put behind the icon where it must be opaque: the average of its edge's opaque pixels when the
/// edge is mostly opaque (a full-bleed icon, a rounded square: the background carries on from it), else
/// `fallback`. The edge is a ring about 1/64 of the icon thick, so one soft outer pixel does not decide it.
pub fn edge_background_or(img: &RgbaImage, fallback: [u8; 3]) -> [u8; 3] {
    let (w, h) = (img.width as usize, img.height as usize);
    let t = ((w.min(h) as f64 / 64.0).round() as usize).max(1);
    let (mut total, mut opaque) = (0u64, 0u64);
    let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
    let mut take = |x: usize, y: usize| {
        let o = (y * w + x) * 4;
        total += 1;
        if img.data[o + 3] >= 250 {
            opaque += 1;
            r += u64::from(img.data[o]);
            g += u64::from(img.data[o + 1]);
            b += u64::from(img.data[o + 2]);
        }
    };
    for y in 0..h {
        if y < t || y + t >= h {
            for x in 0..w {
                take(x, y);
            }
            continue;
        }
        for x in 0..t.min(w) {
            take(x, y);
        }
        for x in t.max(w.saturating_sub(t))..w {
            take(x, y);
        }
    }
    if total == 0 || opaque as f64 / total as f64 <= 0.5 {
        return fallback;
    }
    let avg = |sum: u64| (sum as f64 / opaque as f64).round() as u8;
    [avg(r), avg(g), avg(b)]
}

/// The image drawn over a background colour: fully opaque (an iPhone turns see-through parts of its icon black).
pub fn flatten_rgba(img: &RgbaImage, bg: [u8; 3]) -> RgbaImage {
    let mut out = vec![0u8; img.data.len()];
    for i in (0..img.data.len()).step_by(4) {
        let a = f64::from(img.data[i + 3]) / 255.0;
        for c in 0..3 {
            out[i + c] = (f64::from(img.data[i + c]) * a + f64::from(bg[c]) * (1.0 - a)).round() as u8;
        }
        out[i + 3] = 255;
    }
    RgbaImage {
        width: img.width,
        height: img.height,
        data: out,
    }
}

/// The maskable icon: the picture at `MASKABLE_FILL` of `size`, in the middle of an opaque square of the
/// background.
pub fn maskable_rgba(master: &RgbaImage, size: u32, bg: [u8; 3]) -> RgbaImage {
    let inner = (f64::from(size) * MASKABLE_FILL).round() as u32;
    let small = flatten_rgba(&resize_rgba(master, inner, inner), bg);
    let size_u = size as usize;
    let inner_u = inner as usize;
    let mut out = vec![0u8; size_u * size_u * 4];
    for px in out.chunks_exact_mut(4) {
        px.copy_from_slice(&[bg[0], bg[1], bg[2], 255]);
    }
    let off = (size_u - inner_u) / 2;
    for y in 0..inner_u {
        let to = ((y + off) * size_u + off) * 4;
        out[to..to + inner_u * 4].copy_from_slice(&small.data[y * inner_u * 4..(y + 1) * inner_u * 4]);
    }
    RgbaImage {
        width: size,
        height: size,
        data: out,
    }
}

/// Every icon made from a master, and the colour put behind the ones that must be opaque.
#[derive(Debug, Clone)]
pub struct IconSet {
    /// File name and bytes, in the order the JS made them.
    pub files: Vec<(String, Vec<u8>)>,
    pub background: [u8; 3],
}

impl IconSet {
    pub fn file(&self, name: &str) -> Option<&[u8]> {
        self.files.iter().find(|(n, _)| n == name).map(|(_, b)| b.as_slice())
    }
}

/// Every icon from a square RGBA master. It takes a moment for a big master: run it off the async threads (the
/// JS paused between icons for the same reason).
pub fn make_icon_set(master: &RgbaImage) -> anyhow::Result<IconSet> {
    let bg = edge_background(master);
    let at = |n: u32| resize_rgba(master, n, n);
    let icon16 = encode_png(&at(16))?;
    let icon32 = encode_png(&at(32))?;
    let icon48 = encode_png(&at(48))?;
    let favicon = encode_ico(&[(16, &icon16), (32, &icon32), (48, &icon48)]);
    let apple = encode_png(&flatten_rgba(&at(180), bg))?;
    let icon192 = encode_png(&at(192))?;
    let icon512 = encode_png(&at(512))?;
    let maskable = encode_png(&maskable_rgba(master, 512, bg))?;
    Ok(IconSet {
        files: vec![
            ("icon-16.png".into(), icon16),
            ("icon-32.png".into(), icon32),
            ("favicon.ico".into(), favicon),
            ("apple-touch-icon.png".into(), apple),
            ("icon-192.png".into(), icon192),
            ("icon-512.png".into(), icon512),
            ("icon-maskable-512.png".into(), maskable),
        ],
        background: bg,
    })
}

// ---------------------------------------------------------------- what was uploaded

/// A picture's kind: its file extension and content type (the JS `{ ext, type }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageKind {
    pub ext: &'static str,
    pub mime: &'static str,
}

/// A file's real type by its first bytes (a PNG, JPEG or WebP), or an SVG by a light look (text with an <svg
/// element).
pub fn sniff_image_type(buf: &[u8]) -> Option<ImageKind> {
    if buf.is_empty() {
        return None;
    }
    if is_png(buf) {
        return Some(ImageKind {
            ext: "png",
            mime: "image/png",
        });
    }
    if buf.len() >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff {
        return Some(ImageKind {
            ext: "jpg",
            mime: "image/jpeg",
        });
    }
    if buf.len() >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        return Some(ImageKind {
            ext: "webp",
            mime: "image/webp",
        });
    }
    if !buf.contains(&0) {
        // `/<svg[\s>/]/i` on the text
        let text = String::from_utf8_lossy(buf);
        let chars: Vec<char> = text.chars().collect();
        let found = chars.windows(5).any(|w| {
            w[0] == '<'
                && w[1].eq_ignore_ascii_case(&'s')
                && w[2].eq_ignore_ascii_case(&'v')
                && w[3].eq_ignore_ascii_case(&'g')
                && (js_space(w[4]) || w[4] == '>' || w[4] == '/')
        });
        if found {
            return Some(ImageKind {
                ext: "svg",
                mime: "image/svg+xml",
            });
        }
    }
    None
}

/// Base64 (a data: address's too) as bytes, or `None` when it is not base64 at all (or decodes to nothing).
/// Decoded as Node's `Buffer.from(text, "base64")` decodes: padding optional, a lone last character ignored.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut body = text;
    if body.len() >= 5
        && body.is_char_boundary(5)
        && body[..5].eq_ignore_ascii_case("data:")
        && let Some(comma) = body.find(',')
    {
        let head = &body[..comma];
        if head.len() >= 7
            && head.is_char_boundary(head.len() - 7)
            && head[head.len() - 7..].eq_ignore_ascii_case(";base64")
        {
            body = &body[comma + 1..];
        }
    }
    let body: String = body.chars().filter(|c| !js_space(*c)).collect();
    let digits = body.trim_end_matches('=');
    let padding = body.len() - digits.len();
    let valid = !digits.is_empty()
        && padding <= 2
        && digits
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/');
    if !valid {
        return None;
    }
    let usable = if digits.len() % 4 == 1 {
        &digits[..digits.len() - 1]
    } else {
        digits
    };
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone),
    );
    let bytes = engine.decode(usable).ok()?;
    if bytes.is_empty() { None } else { Some(bytes) }
}

/// [`decode_base64`] for a JSON value: anything but a string is `None`.
pub fn decode_base64_value(value: &Value) -> Option<Vec<u8>> {
    value.as_str().and_then(decode_base64)
}

/// `path.basename` as Node wrote it on this system: the last segment, trailing separators ignored (and on Windows
/// `\` a separator too, and a drive taken off).
fn node_basename(p: &str) -> &str {
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let mut s = p;
    if cfg!(windows) {
        let b = s.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            s = &s[2..];
        }
    }
    let trimmed = s.trim_end_matches(is_sep);
    match trimmed.rfind(is_sep) {
        Some(i) => &trimmed[i + 1..],
        None => trimmed,
    }
}

/// The original's file name as it is kept in brand.json: no folders, no control characters, 200 characters at
/// most.
fn clean_name(name: &str) -> String {
    let base: String = node_basename(name).chars().filter(|c| !c.is_control()).collect();
    utf16_truncate(base.trim_matches(js_space), 200)
}

// ---------------------------------------------------------------- the files on disk

/// What is in use now.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BrandState {
    custom: bool,
    version: String,
    updated_at: Option<String>,
}

/// `{ custom, version, updatedAt }`: whether an uploaded icon is in use, its version, and when it was saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrandStatus {
    pub custom: bool,
    pub version: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

/// The original file that was picked, kept as it came.
#[derive(Debug, Clone, Default)]
pub struct Original {
    pub name: String,
    /// The type the browser said it was (not used: the real type comes from the bytes).
    pub mime: String,
    pub data: Vec<u8>,
}

/// What a save is given: the master PNG of the crop and, optionally, the original file.
#[derive(Debug, Clone, Default)]
pub struct BrandUpload {
    pub master: Option<Vec<u8>>,
    pub original: Option<Original>,
}

/// The brand icon's state and the uploaded files kept in memory: the JS module's `state`, `served`,
/// `defaultVersion` and `queue`, kept in the `App` (`BrandIcon::of(app)`).
pub struct BrandIcon {
    data_dir: PathBuf,
    public_dir: PathBuf,
    default_version: OnceLock<String>,
    state: Mutex<Option<BrandState>>,
    /// File name -> its bytes, for the version in `state`.
    served: Mutex<HashMap<String, Bytes>>,
    /// One save or reset at a time: two at once would leave a mix of both.
    queue: tokio::sync::Mutex<()>,
}

/// `<DATA_DIR>/brand`.
pub fn brand_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("brand")
}

fn write_atomic(file: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut suffix = [0u8; 4];
    rand::Rng::fill_bytes(&mut rand::rng(), &mut suffix);
    let tmp = PathBuf::from(format!(
        "{}.tmp-{}-{}",
        file.to_string_lossy(),
        std::process::id(),
        hex::encode(suffix)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&tmp)?.write_all(data)?;
    if let Err(err) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp); // already gone
        return Err(err);
    }
    Ok(())
}

/// `fs.rmSync(path, { force: true })`: a missing file is fine.
fn remove_forced(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

impl BrandIcon {
    pub fn new(data_dir: PathBuf, public_dir: PathBuf) -> Self {
        BrandIcon {
            data_dir,
            public_dir,
            default_version: OnceLock::new(),
            state: Mutex::new(None),
            served: Mutex::new(HashMap::new()),
            queue: tokio::sync::Mutex::new(()),
        }
    }

    /// The app's brand icon, made on first use (its data folder and public folder from the configuration).
    pub fn of(app: &App) -> Arc<BrandIcon> {
        app.get_or_init(|| BrandIcon::new(app.config().data_dir.clone(), app.config().public_dir()))
    }

    pub fn brand_dir(&self) -> PathBuf {
        brand_dir(&self.data_dir)
    }

    /// The default icon's version: "d" and the start of icon-512.png's sha256 (worked out once).
    fn default_icon_version(&self) -> String {
        self.default_version
            .get_or_init(|| match std::fs::read(self.public_dir.join("icon-512.png")) {
                Ok(bytes) => format!("d{}", &hex::encode(Sha256::digest(&bytes))[..11]),
                Err(_) => "d0".to_string(),
            })
            .clone()
    }

    fn default_state(&self) -> BrandState {
        BrandState {
            custom: false,
            version: self.default_icon_version(),
            updated_at: None,
        }
    }

    /// What is in use now, from brand.json the first time (and after a save or reset, from memory).
    fn current(&self) -> BrandState {
        if let Some(state) = &*self.state.lock() {
            return state.clone();
        }
        let mut state = self.default_state();
        let dir = self.brand_dir();
        match std::fs::read_to_string(dir.join("brand.json")) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(meta) => {
                    let whole = ICON_FILES.iter().all(|(p, _)| dir.join(&p[1..]).exists());
                    let version = match meta.get("version") {
                        Some(Value::String(v)) => v.clone(),
                        _ => String::new(),
                    };
                    let well_formed =
                        version.len() == 12 && version.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
                    if well_formed && whole {
                        let updated_at = match meta.get("updatedAt") {
                            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                            _ => None,
                        };
                        state = BrandState {
                            custom: true,
                            version,
                            updated_at,
                        };
                    } else if truthy(&meta) {
                        log::warn!(
                            "[brand-icon] brand.json is there but the icons are not all there: using the default icon"
                        );
                    }
                }
                Err(err) => log::warn!("[brand-icon] could not read brand.json: {err}"),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => log::warn!("[brand-icon] could not read brand.json: {err}"),
        }
        let mut slot = self.state.lock();
        if let Some(existing) = &*slot {
            return existing.clone();
        }
        *slot = Some(state.clone());
        state
    }

    /// The icon's version now: the uploaded one's, or the default's. Cheap (kept in memory).
    pub fn icon_version(&self) -> String {
        self.current().version
    }

    pub fn brand_status(&self) -> BrandStatus {
        let s = self.current();
        BrandStatus {
            custom: s.custom,
            version: s.version,
            updated_at: s.updated_at,
        }
    }

    /// Save an uploaded icon. `master`: the PNG of the crop (square, 64 to 2048 pixels); `original` (optional):
    /// the file that was picked, kept as it came (a PNG, JPEG, WebP or SVG, 10 MB at most). Refusals are a
    /// [`BrandIconError`] (status 400) inside the error. Gives the new status.
    pub async fn save_brand_icon(&self, upload: BrandUpload) -> anyhow::Result<BrandStatus> {
        let _turn = self.queue.lock().await;
        let master = match upload.master {
            Some(master) if !master.is_empty() => master,
            _ => return Err(refuse("No icon came with it.").into()),
        };
        if master.len() > MASTER_MAX_BYTES {
            return Err(refuse("The icon is too big: 15 MB at most.").into());
        }
        if !is_png(&master) {
            return Err(refuse("The icon must be a PNG file.").into());
        }
        let head = read_png_header(&master)?;
        if head.width != head.height {
            return Err(refuse(format!(
                "The icon must be square (this one is {} by {}).",
                head.width, head.height
            ))
            .into());
        }
        if head.width < MASTER_MIN {
            return Err(refuse(format!(
                "The icon is too small: {MASTER_MIN} pixels across at least (this one is {}).",
                head.width
            ))
            .into());
        }
        if head.width > MASTER_MAX {
            return Err(refuse(format!(
                "The icon is too big: {MASTER_MAX} pixels across at most (this one is {}).",
                head.width
            ))
            .into());
        }

        let mut orig: Option<(ImageKind, Vec<u8>, String)> = None;
        if let Some(original) = upload.original {
            if original.data.is_empty() {
                return Err(refuse("The original file came through empty.").into());
            }
            if original.data.len() > ORIGINAL_MAX_BYTES {
                return Err(refuse("The original file is too big: 10 MB at most.").into());
            }
            let Some(kind) = sniff_image_type(&original.data) else {
                return Err(refuse("The original file is not a PNG, JPEG, WebP or SVG image.").into());
            };
            let name = clean_name(&original.name);
            let name = if name.is_empty() {
                format!("original.{}", kind.ext)
            } else {
                name
            };
            orig = Some((kind, original.data, name));
        }

        let dir = self.brand_dir();
        let (version, updated_at) = tokio::task::spawn_blocking(move || -> anyhow::Result<(String, String)> {
            let img = decode_png(&master)?;
            let set = make_icon_set(&img)?;
            let version = hex::encode(Sha256::digest(&master))[..12].to_string();

            create_private_dir(&dir)?;
            for entry in std::fs::read_dir(&dir)?.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.contains(".tmp-") {
                    let _ = std::fs::remove_file(entry.path()); // gone
                }
            }
            write_atomic(&dir.join("master.png"), &master)?;
            for (name, data) in &set.files {
                write_atomic(&dir.join(name), data)?;
            }
            if let Some((kind, data, _)) = &orig {
                let keep = format!("original.{}", kind.ext);
                write_atomic(&dir.join(&keep), data)?;
                for entry in std::fs::read_dir(&dir)?.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with("original.") && name != keep {
                        remove_forced(&entry.path())?;
                    }
                }
            }
            let updated_at = now_iso();
            let prev: Value = std::fs::read_to_string(dir.join("brand.json"))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_else(|| json!({}));
            let kept = |key: &str| match prev.get(key) {
                Some(v) if truthy(v) => v.clone(),
                _ => Value::Null,
            };
            let background = format!(
                "#{}",
                set.background.iter().map(|c| format!("{c:02x}")).collect::<String>()
            );
            // brand.json last: until it is written the icons in use are the ones before.
            let meta = json!({
                "version": version,
                "updatedAt": updated_at,
                "originalName": match &orig { Some((_, _, name)) => json!(name), None => kept("originalName") },
                "originalType": match &orig { Some((kind, _, _)) => json!(kind.mime), None => kept("originalType") },
                "background": background,
            });
            write_atomic(
                &dir.join("brand.json"),
                format!("{}\n", serde_json::to_string_pretty(&meta)?).as_bytes(),
            )?;
            Ok((version, updated_at))
        })
        .await??;

        *self.state.lock() = Some(BrandState {
            custom: true,
            version: version.clone(),
            updated_at: Some(updated_at),
        });
        self.served.lock().clear();
        log::info!("[brand-icon] new icon saved (version {version})");
        Ok(self.brand_status())
    }

    /// Back to the default icon: the uploaded files are removed. Gives the new status.
    pub async fn reset_brand_icon(&self) -> anyhow::Result<BrandStatus> {
        let _turn = self.queue.lock().await;
        let dir = self.brand_dir();
        // brand.json first: from then on the default icons are served, whatever is left.
        remove_forced(&dir.join("brand.json"))?;
        *self.state.lock() = Some(self.default_state());
        self.served.lock().clear();
        let names: Vec<String> = match std::fs::read_dir(&dir) {
            Ok(entries) => entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(_) => Vec::new(), // no folder: nothing to remove
        };
        for name in names {
            if name == "master.png"
                || name.starts_with("original.")
                || name.contains(".tmp-")
                || icon_type(&format!("/{name}")).is_some()
            {
                remove_forced(&dir.join(&name))?;
            }
        }
        log::info!("[brand-icon] back to the default icon");
        Ok(self.brand_status())
    }

    /// An uploaded icon's bytes (kept in memory once read), or `None`.
    fn custom_file(&self, name: &str) -> Option<Bytes> {
        if let Some(found) = self.served.lock().get(name) {
            return Some(found.clone());
        }
        let bytes = Bytes::from(std::fs::read(self.brand_dir().join(name)).ok()?);
        self.served.lock().insert(name.to_string(), bytes.clone());
        Some(bytes)
    }

    /// For tests: forget what is in memory (the next call reads brand.json again).
    pub fn forget_state(&self) {
        *self.state.lock() = None;
        self.served.lock().clear();
    }
}

/// The app's icon version (`iconVersion()`).
pub fn icon_version(app: &App) -> String {
    BrandIcon::of(app).icon_version()
}

/// The app's brand status (`brandStatus()`).
pub fn brand_status(app: &App) -> BrandStatus {
    BrandIcon::of(app).brand_status()
}

/// Save an uploaded icon in the app's data folder (`saveBrandIcon`).
pub async fn save_brand_icon(app: &App, upload: BrandUpload) -> anyhow::Result<BrandStatus> {
    BrandIcon::of(app).save_brand_icon(upload).await
}

/// Back to the default icon (`resetBrandIcon`).
pub async fn reset_brand_icon(app: &App) -> anyhow::Result<BrandStatus> {
    BrandIcon::of(app).reset_brand_icon().await
}

// ---------------------------------------------------------------- serving

/// Does an If-None-Match header name this ETag (or *)?
fn etag_matches(header: Option<&str>, etag: &str) -> bool {
    let Some(header) = header.filter(|h| !h.is_empty()) else {
        return false;
    };
    let bare = etag.strip_prefix("W/").unwrap_or(etag);
    header.split(',').any(|t| {
        let v = js_trim(t);
        v == "*" || v.strip_prefix("W/").unwrap_or(v) == bare
    })
}

/// Every If-None-Match line of the request, joined as Node joined them.
fn if_none_match(headers: &HeaderMap) -> Option<String> {
    let lines: Vec<&str> = headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    (!lines.is_empty()).then(|| lines.join(", "))
}

fn is_get_or_head(method: &Method) -> bool {
    method == Method::GET || method == Method::HEAD
}

fn value(text: &str) -> HeaderValue {
    HeaderValue::from_str(text).unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// The response for a body the client may already have: 304 when the ETag matches, else 200 with the body (none
/// for HEAD) and its length.
fn send_cached(
    method: &Method,
    request_etag: Option<&str>,
    mut headers: HeaderMap,
    etag: &str,
    body: Bytes,
) -> Response {
    headers.insert(header::ETAG, value(etag));
    let (status, body) = if etag_matches(request_etag, etag) {
        (StatusCode::NOT_MODIFIED, Body::empty())
    } else {
        headers.insert(header::CONTENT_LENGTH, value(&body.len().to_string()));
        if *method == Method::HEAD {
            (StatusCode::OK, Body::empty())
        } else {
            (StatusCode::OK, Body::from(body))
        }
    };
    let mut res = Response::new(body);
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

/// Middleware for the icon addresses (`ICON_FILES`), GET and HEAD, whatever the query (?v=): an uploaded icon is
/// sent from the data folder; with none, what comes after (the static files) sends the default file. Either way the
/// browser is told to ask again each time (no-cache: it gets a 304 while nothing changed), so the new icon shows at
/// once. No sign-in: browsers fetch icons without cookies, and the sign-in page shows the icon too.
///
/// `router.layer(axum::middleware::from_fn_with_state(app.clone(), brand_icon_middleware))`, ahead of the static
/// files.
pub async fn brand_icon_middleware(State(app): State<App>, req: Request, next: Next) -> Response {
    if !is_get_or_head(req.method()) {
        return next.run(req).await;
    }
    let path = req.uri().path().to_string();
    let Some(mime) = icon_type(&path) else {
        return next.run(req).await;
    };
    let icons = BrandIcon::of(&app);
    let s = icons.current();
    let name = &path[1..];
    let custom = if s.custom { icons.custom_file(name) } else { None };
    let Some(buf) = custom else {
        // The default file, from whatever comes next; this header wins over the one it would set.
        let mut res = next.run(req).await;
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        return res;
    };
    let etag = format!("\"{}-{name}\"", s.version);
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    let request_etag = if_none_match(req.headers());
    send_cached(req.method(), request_etag.as_deref(), headers, &etag, buf)
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// An address on this site with the icon's version on it (?v=); anything else as it was.
pub fn with_version(src: &str, version: &str) -> String {
    if !src.starts_with('/') || src.starts_with("//") {
        return src.to_string();
    }
    let bare = src.split(['?', '#']).next().unwrap_or("");
    format!("{bare}?v={}", encode_uri_component(version))
}

/// `{ ...icon, src: v(icon.src) }`: the icon with its address versioned (no `src` stays no `src`; a `src` that is
/// not text stays as it was).
fn versioned_icon(icon: &Value, version: &str) -> Map<String, Value> {
    let mut out = icon.as_object().cloned().unwrap_or_default();
    if let Some(Value::String(src)) = out.get("src") {
        let versioned = with_version(src, version);
        out.insert("src".into(), Value::String(versioned));
    }
    out
}

/// A web app manifest with the icon's version on every icon, and its maskable icon the one made for it
/// (/icon-maskable-512.png, the picture inside Android's safe zone) in place of the plain 192 and 512.
pub fn versioned_manifest(base: &Value, version: &str) -> Value {
    let mut out = if truthy(base) { base.clone() } else { json!({}) };
    if let Some(Value::Array(icons_in)) = out.get("icons") {
        let mut icons: Vec<Value> = Vec::new();
        let mut maskable = false;
        for icon in icons_in {
            let purpose = match icon.get("purpose") {
                Some(p) if truthy(p) => match p {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => number_to_string(n.as_f64().unwrap_or(0.0)),
                    other => other.to_string(),
                },
                _ => "any".to_string(),
            };
            let purposes: Vec<&str> = purpose.split(js_space).filter(|p| !p.is_empty()).collect();
            if !purposes.contains(&"maskable") {
                icons.push(Value::Object(versioned_icon(icon, version)));
                continue;
            }
            if !maskable {
                icons.push(json!({
                    "src": with_version("/icon-maskable-512.png", version),
                    "sizes": "512x512",
                    "type": "image/png",
                    "purpose": "maskable",
                }));
                maskable = true;
            }
            let rest: Vec<&str> = purposes.into_iter().filter(|p| *p != "maskable").collect();
            if !rest.is_empty() {
                let mut kept = versioned_icon(icon, version);
                kept.insert("purpose".into(), Value::String(rest.join(" ")));
                icons.push(Value::Object(kept));
            }
        }
        out["icons"] = Value::Array(icons);
    }
    if let Some(Value::Array(shortcuts)) = out.get_mut("shortcuts") {
        for sc in shortcuts.iter_mut() {
            if let Some(Value::Array(icons)) = sc.get("icons") {
                let icons: Vec<Value> = icons
                    .iter()
                    .map(|icon| Value::Object(versioned_icon(icon, version)))
                    .collect();
                sc["icons"] = Value::Array(icons);
            }
        }
    }
    out
}

/// The handler for /manifest.json: `public_dir`'s manifest.json with [`versioned_manifest`] applied, never kept by
/// the browser without asking (no-cache). If the file cannot be read, the request goes on to the static files.
///
/// `router.layer(axum::middleware::from_fn_with_state(manifest_handler(&app, public_dir), manifest_middleware))`
#[derive(Clone)]
pub struct ManifestHandler {
    app: App,
    file: PathBuf,
    /// Parsed once, again only when the file changes.
    read: Arc<Mutex<Option<(SystemTime, Value)>>>,
}

pub fn manifest_handler(app: &App, public_dir: &Path) -> ManifestHandler {
    ManifestHandler {
        app: app.clone(),
        file: public_dir.join("manifest.json"),
        read: Arc::new(Mutex::new(None)),
    }
}

impl ManifestHandler {
    fn base(&self) -> Result<Value, String> {
        let modified = std::fs::metadata(&self.file)
            .and_then(|m| m.modified())
            .map_err(|e| e.to_string())?;
        let mut read = self.read.lock();
        if let Some((at, json)) = &*read
            && *at == modified
        {
            return Ok(json.clone());
        }
        let text = std::fs::read_to_string(&self.file).map_err(|e| e.to_string())?;
        let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        *read = Some((modified, json.clone()));
        Ok(json)
    }
}

/// The middleware that answers /manifest.json (see [`ManifestHandler`]).
pub async fn manifest_middleware(State(handler): State<ManifestHandler>, req: Request, next: Next) -> Response {
    if !is_get_or_head(req.method()) || req.uri().path() != "/manifest.json" {
        return next.run(req).await;
    }
    let base = match handler.base() {
        Ok(base) => base,
        Err(err) => {
            log::warn!("[brand-icon] could not read manifest.json: {err}");
            return next.run(req).await;
        }
    };
    let manifest = versioned_manifest(&base, &icon_version(&handler.app));
    let body = serde_json::to_string_pretty(&manifest).unwrap_or_default();
    let etag = format!("\"m{}\"", &hex::encode(Sha1::digest(body.as_bytes()))[..16]);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/manifest+json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    let request_etag = if_none_match(req.headers());
    send_cached(req.method(), request_etag.as_deref(), headers, &etag, Bytes::from(body))
}
