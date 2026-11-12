//! The cases of `test/brand-icon.test.js` about the server file: the PNG decoder on every colour type, bit depth and
//! row filter, the resizer, the ICO and the icon set, saving and resetting in a data folder of its own, the
//! middleware that serves an uploaded icon, and the manifest with the version on every icon. (The routes are the
//! settings routes' tests; the page's copy, js/brand-icon.js, is the browser tests'.)

use std::path::Path;

use axum::Router;
use axum::middleware::{from_fn_with_state, map_response};
use axum::response::IntoResponse;
use serde_json::json;
use tower_http::services::ServeDir;

use super::*;
use crate::testkit::http::{self, TestResponse};
use crate::testkit::{TestApp, test_app, tmp_dir};

const SIG: [u8; 8] = PNG_SIGNATURE;

// ---------------------------------------------------------------- PNGs made by hand (not by the module's encoder)

/// The CRC of another implementation (flate2's), so the module's own is not checked against itself.
fn crc(b: &[u8]) -> u32 {
    let mut c = flate2::Crc::new();
    c.update(b);
    c.sum()
}

fn mk_chunk(kind: &str, data: &[u8]) -> Vec<u8> {
    let mut body = kind.as_bytes().to_vec();
    body.extend_from_slice(data);
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc(&body).to_be_bytes());
    out
}

fn ihdr(width: u32, height: u32, bit_depth: u8, color_type: u8, interlace: u8) -> Vec<u8> {
    let mut b = vec![0u8; 13];
    b[0..4].copy_from_slice(&width.to_be_bytes());
    b[4..8].copy_from_slice(&height.to_be_bytes());
    b[8] = bit_depth;
    b[9] = color_type;
    b[12] = interlace;
    mk_chunk("IHDR", &b)
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

/// Rows of plain bytes with a filter on each (the list goes round).
fn filter_rows(rows: &[Vec<u8>], bpp: usize, filters: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut prev: Option<&Vec<u8>> = None;
    for (y, row) in rows.iter().enumerate() {
        let f = filters[y % filters.len()];
        out.push(f);
        for i in 0..row.len() {
            let a = if i >= bpp { i32::from(row[i - bpp]) } else { 0 };
            let b = prev.map_or(0, |p| i32::from(p[i]));
            let c = match prev {
                Some(p) if i >= bpp => i32::from(p[i - bpp]),
                _ => 0,
            };
            let p = a + b - c;
            let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
            let pred = [
                0,
                a,
                b,
                (a + b) >> 1,
                if pa <= pb && pa <= pc {
                    a
                } else if pb <= pc {
                    b
                } else {
                    c
                },
            ][usize::from(f)];
            out.push(((i32::from(row[i]) - pred) & 255) as u8);
        }
        prev = Some(row);
    }
    out
}

struct Png<'a> {
    width: u32,
    height: u32,
    color_type: u8,
    bit_depth: u8,
    rows: Vec<Vec<u8>>,
    palette: Option<&'a [u8]>,
    trns: Option<&'a [u8]>,
    filters: &'a [u8],
    interlace: u8,
    extra: Vec<Vec<u8>>,
}

impl Default for Png<'_> {
    fn default() -> Self {
        Png {
            width: 1,
            height: 1,
            color_type: 6,
            bit_depth: 8,
            rows: vec![],
            palette: None,
            trns: None,
            filters: &[0],
            interlace: 0,
            extra: vec![],
        }
    }
}

fn make_png(p: Png<'_>) -> Vec<u8> {
    let bpp = ((channels(p.color_type).unwrap_or(1) as usize * usize::from(p.bit_depth)) >> 3).max(1);
    let mut out = SIG.to_vec();
    out.extend(ihdr(p.width, p.height, p.bit_depth, p.color_type, p.interlace));
    for e in &p.extra {
        out.extend_from_slice(e);
    }
    if let Some(palette) = p.palette {
        out.extend(mk_chunk("PLTE", palette));
    }
    if let Some(trns) = p.trns {
        out.extend(mk_chunk("tRNS", trns));
    }
    out.extend(mk_chunk("IDAT", &deflate(&filter_rows(&p.rows, bpp, p.filters))));
    out.extend(mk_chunk("IEND", &[]));
    out
}

fn pack_bits(values: &[u32], depth: u32) -> Vec<u8> {
    let mut out = vec![0u8; (values.len() * depth as usize).div_ceil(8)];
    for (i, v) in values.iter().enumerate() {
        let bit = i * depth as usize;
        out[bit >> 3] |= (v << (8 - depth - (bit & 7) as u32)) as u8;
    }
    out
}

fn u16s(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|v| (*v as u16).to_be_bytes()).collect()
}

fn to8(v: u32, depth: u32) -> u8 {
    match depth {
        16 => (f64::from(v) / 257.0).round() as u8,
        8 => v as u8,
        _ => (f64::from(v) * 255.0 / f64::from((1u32 << depth) - 1)).round() as u8,
    }
}

fn pixel(img: &RgbaImage, x: usize, y: usize) -> [u8; 4] {
    let o = (y * img.width as usize + x) * 4;
    [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]
}

/// The JS test's random numbers: `seed = (seed * 1103515245 + 12345) & 0x7fffffff`, in doubles as the JS did.
struct Rnd(u32);

impl Rnd {
    fn new() -> Self {
        Rnd(7)
    }

    fn next(&mut self, n: u32) -> u32 {
        let x = f64::from(self.0) * 1_103_515_245.0 + 12345.0;
        let wrapped = x.rem_euclid(4_294_967_296.0) as u64 as u32;
        self.0 = wrapped & 0x7fff_ffff;
        self.0 % n
    }
}

/// An RGBA image, every pixel `fill(x, y)`.
fn rgba_image(width: u32, height: u32, mut fill: impl FnMut(u32, u32) -> [u8; 4]) -> RgbaImage {
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&fill(x, y));
        }
    }
    RgbaImage { width, height, data }
}

fn flat(n: u32, c: [u8; 4]) -> RgbaImage {
    rgba_image(n, n, |_, _| c)
}

fn every_pixel(img: &RgbaImage, test: impl Fn([u8; 4]) -> bool) -> bool {
    img.data.chunks_exact(4).all(|p| test([p[0], p[1], p[2], p[3]]))
}

fn refused(buf: &[u8], words: &[&str]) {
    let err = decode_png(buf).unwrap_err();
    assert_eq!(err.status(), 400);
    assert!(
        words.iter().any(|w| err.0.contains(w)),
        "{} (wanted one of {words:?})",
        err.0
    );
}

// ---------------------------------------------------------------- decoding

#[test]
fn crc32_is_the_standard_one() {
    assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    let mut rnd = Rnd::new();
    let b: Vec<u8> = (0..999).map(|_| rnd.next(256) as u8).collect();
    assert_eq!(crc32(&b), crc(&b));
}

#[test]
fn rgba_8_bit_from_its_own_encoder_with_each_filter_and_the_automatic_choice_back_as_it_went_in() {
    let mut rnd = Rnd::new();
    let img = rgba_image(7, 5, |_, _| {
        [
            rnd.next(256) as u8,
            rnd.next(256) as u8,
            rnd.next(256) as u8,
            rnd.next(256) as u8,
        ]
    });
    for filter in [
        PngFilter::Fixed(0),
        PngFilter::Fixed(1),
        PngFilter::Fixed(2),
        PngFilter::Fixed(3),
        PngFilter::Fixed(4),
        PngFilter::Auto,
    ] {
        let back = decode_png(&encode_png_with(&img, filter, 6).unwrap()).unwrap();
        assert_eq!((back.width, back.height), (7, 5));
        assert_eq!(back.data, img.data, "filter {filter:?}");
    }
    assert!(
        encode_png(&RgbaImage {
            width: 2,
            height: 2,
            data: vec![0; 3]
        })
        .is_err()
    );
}

/// Every colour type at every bit depth it allows, through every filter (three rows, so Up, Average and Paeth
/// all look at the row above), against what each pixel must come out as.
fn colour_case(color_type: u8, depth: u32) {
    let mut rnd = Rnd::new();
    let (width, height) = (9usize, 3usize);
    let ch = channels(color_type).unwrap() as usize;
    let max = if color_type == 3 {
        255.min((1u32 << depth) - 1)
    } else {
        (1u32 << depth) - 1
    };
    let colours = if color_type == 3 { max + 1 } else { 0 };
    let palette: Option<Vec<u8>> = (color_type == 3).then(|| (0..colours * 3).map(|_| rnd.next(256) as u8).collect());
    // (fewer than the colours: the rest opaque)
    let trns: Option<Vec<u8>> =
        (color_type == 3).then(|| (0..(colours >> 1).max(1)).map(|_| rnd.next(256) as u8).collect());
    let mut px: Vec<Vec<Vec<u32>>> = Vec::new();
    for y in 0..height {
        let mut row = Vec::new();
        for x in 0..width {
            row.push(
                (0..ch as u32)
                    .map(|c| match (x, y) {
                        (0, 0) => max,
                        (1, 0) => 0,
                        _ => (rnd.next(max + 1) + c) % (max + 1),
                    })
                    .collect::<Vec<u32>>(),
            );
        }
        px.push(row);
    }
    let rows: Vec<Vec<u8>> = px
        .iter()
        .map(|row| {
            let flat_row: Vec<u32> = row.iter().flatten().copied().collect();
            match depth {
                16 => u16s(&flat_row),
                8 => flat_row.iter().map(|v| *v as u8).collect(),
                _ => pack_bits(&flat_row, depth),
            }
        })
        .collect();
    let want = |p: &[u32]| -> [u8; 4] {
        match color_type {
            0 => {
                let g = to8(p[0], depth);
                [g, g, g, 255]
            }
            2 => [to8(p[0], depth), to8(p[1], depth), to8(p[2], depth), 255],
            3 => {
                let pal = palette.as_ref().unwrap();
                let t = trns.as_ref().unwrap();
                let i = p[0] as usize;
                [
                    pal[i * 3],
                    pal[i * 3 + 1],
                    pal[i * 3 + 2],
                    if i < t.len() { t[i] } else { 255 },
                ]
            }
            4 => {
                let g = to8(p[0], depth);
                [g, g, g, to8(p[1], depth)]
            }
            _ => [to8(p[0], depth), to8(p[1], depth), to8(p[2], depth), to8(p[3], depth)],
        }
    };
    let filter_sets: [&[u8]; 6] = [&[0], &[1], &[2], &[3], &[4], &[4, 3, 1]];
    for filters in filter_sets {
        let img = decode_png(&make_png(Png {
            width: width as u32,
            height: height as u32,
            color_type,
            bit_depth: depth as u8,
            rows: rows.clone(),
            palette: palette.as_deref(),
            trns: trns.as_deref(),
            filters,
            ..Png::default()
        }))
        .unwrap();
        assert_eq!(
            (img.width as usize, img.height as usize, img.data.len()),
            (width, height, width * height * 4)
        );
        for y in 0..height {
            for x in 0..width {
                assert_eq!(pixel(&img, x, y), want(&px[y][x]), "filter {filters:?}, pixel {x},{y}");
            }
        }
    }
}

macro_rules! colour_cases {
    ($($name:ident: $ct:expr, $depth:expr;)*) => {
        $(
            #[test]
            fn $name() {
                colour_case($ct, $depth);
            }
        )*
    };
}

colour_cases! {
    colour_type_0_at_1_bits_all_five_filters: 0, 1;
    colour_type_0_at_2_bits_all_five_filters: 0, 2;
    colour_type_0_at_4_bits_all_five_filters: 0, 4;
    colour_type_0_at_8_bits_all_five_filters: 0, 8;
    colour_type_0_at_16_bits_all_five_filters: 0, 16;
    colour_type_2_at_8_bits_all_five_filters: 2, 8;
    colour_type_4_at_8_bits_all_five_filters: 4, 8;
    colour_type_6_at_8_bits_all_five_filters: 6, 8;
    colour_type_2_at_16_bits_all_five_filters: 2, 16;
    colour_type_4_at_16_bits_all_five_filters: 4, 16;
    colour_type_6_at_16_bits_all_five_filters: 6, 16;
    colour_type_3_at_1_bits_all_five_filters: 3, 1;
    colour_type_3_at_2_bits_all_five_filters: 3, 2;
    colour_type_3_at_4_bits_all_five_filters: 3, 4;
    colour_type_3_at_8_bits_all_five_filters: 3, 8;
}

#[test]
fn trns_one_gray_or_one_rgb_colour_is_see_through() {
    let gray = decode_png(&make_png(Png {
        width: 3,
        color_type: 0,
        rows: vec![vec![10, 128, 200]],
        trns: Some(&[0, 128]),
        ..Png::default()
    }))
    .unwrap();
    assert_eq!(
        [pixel(&gray, 0, 0)[3], pixel(&gray, 1, 0)[3], pixel(&gray, 2, 0)[3]],
        [255, 0, 255]
    );
    let gray16 = decode_png(&make_png(Png {
        width: 2,
        color_type: 0,
        bit_depth: 16,
        rows: vec![u16s(&[1000, 1001])],
        trns: Some(&[0x03, 0xe9]),
        ..Png::default()
    }))
    .unwrap();
    assert_eq!([pixel(&gray16, 0, 0)[3], pixel(&gray16, 1, 0)[3]], [255, 0]);
    let rgb = decode_png(&make_png(Png {
        width: 2,
        color_type: 2,
        rows: vec![vec![1, 2, 3, 4, 5, 6]],
        trns: Some(&[0, 4, 0, 5, 0, 6]),
        ..Png::default()
    }))
    .unwrap();
    assert_eq!([pixel(&rgb, 0, 0), pixel(&rgb, 1, 0)], [[1, 2, 3, 255], [4, 5, 6, 0]]);
}

#[test]
fn other_chunks_it_does_not_need_text_gamma_are_passed_over() {
    let text = mk_chunk("tEXt", b"Comment\0hello");
    let gama = mk_chunk("gAMA", &[0, 0, 0xb1, 0x8f]);
    let img = decode_png(&make_png(Png {
        color_type: 2,
        rows: vec![vec![9, 8, 7]],
        extra: vec![text, gama],
        ..Png::default()
    }))
    .unwrap();
    assert_eq!(pixel(&img, 0, 0), [9, 8, 7, 255]);
}

#[test]
fn refuses_what_is_not_a_png_an_interlaced_one_a_damaged_one_and_impossible_ones() {
    refused(&[0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0], &["not a PNG"]);
    refused(b"hello there, I am text", &["not a PNG"]);
    let good = make_png(Png {
        width: 2,
        height: 2,
        rows: vec![vec![0; 8], vec![0; 8]],
        ..Png::default()
    });
    refused(
        &make_png(Png {
            width: 2,
            height: 2,
            rows: vec![vec![0; 8], vec![0; 8]],
            interlace: 1,
            ..Png::default()
        }),
        &["Interlaced"],
    );
    let mut flipped = good.clone();
    flipped[40] ^= 0xff; // (inside IDAT)
    refused(&flipped, &["damaged", "checksum"]);
    refused(&good[..good.len() - 20], &["cut short", "no picture", "damaged"]);
    refused(
        &make_png(Png {
            width: 2,
            color_type: 2,
            bit_depth: 4,
            rows: vec![vec![0; 3]],
            ..Png::default()
        }),
        &["do not go together"],
    );
    refused(
        &make_png(Png {
            width: 2,
            color_type: 3,
            rows: vec![vec![0, 5]],
            palette: Some(&[1, 2, 3, 4, 5, 6]),
            ..Png::default()
        }),
        &["palette"],
    );
    refused(
        &make_png(Png {
            width: 2,
            color_type: 3,
            rows: vec![vec![0, 0]],
            ..Png::default()
        }),
        &["palette"],
    );
    let mut unknown = SIG.to_vec();
    unknown.extend(ihdr(1, 1, 8, 2, 0));
    unknown.extend(mk_chunk("ABcd", &[0, 0]));
    unknown.extend(mk_chunk("IDAT", &deflate(&[0, 1, 2, 3])));
    unknown.extend(mk_chunk("IEND", &[]));
    refused(&unknown, &["cannot read"]);
    let mut bad_filter = SIG.to_vec();
    bad_filter.extend(ihdr(1, 1, 8, 2, 0));
    bad_filter.extend(mk_chunk("IDAT", &deflate(&[7, 1, 2, 3])));
    bad_filter.extend(mk_chunk("IEND", &[]));
    refused(&bad_filter, &["filter"]);
    let err = decode_png_with_limit(&good, 3).unwrap_err();
    assert!(err.0.contains("too big"), "{err}");
}

#[test]
fn picture_data_that_unpacks_to_too_much_or_too_little_is_refused() {
    let mut long = SIG.to_vec();
    long.extend(ihdr(1, 1, 8, 2, 0));
    long.extend(mk_chunk("IDAT", &deflate(&[0, 1, 2, 3, 4, 5, 6])));
    long.extend(mk_chunk("IEND", &[]));
    refused(&long, &["will not unpack"]);
    let mut short = SIG.to_vec();
    short.extend(ihdr(1, 2, 8, 2, 0));
    short.extend(mk_chunk("IDAT", &deflate(&[0, 1, 2, 3])));
    short.extend(mk_chunk("IEND", &[]));
    refused(&short, &["ends early"]);
    let header = read_png_header(&long).unwrap();
    assert_eq!(
        (header.width, header.height, header.bit_depth, header.color_type),
        (1, 1, 8, 2)
    );
    assert_eq!(
        read_png_header(&SIG).unwrap_err().0,
        "The PNG file has no proper header."
    );
}

// ---------------------------------------------------------------- resizing, ICO, the set

#[test]
fn a_flat_colour_stays_exactly_that_colour_at_every_size_down_and_up() {
    let colour = [12, 200, 99, 255];
    let master = flat(1024, colour);
    for n in [16, 32, 48, 180, 192, 512] {
        let out = resize_rgba(&master, n, n);
        assert_eq!((out.width, out.height, out.data.len()), (n, n, (n * n * 4) as usize));
        assert!(every_pixel(&out, |p| p == colour), "at {n}");
    }
    let up = resize_rgba(&flat(64, colour), 180, 180);
    assert!(every_pixel(&up, |p| p == colour), "up from 64");
    let glass = resize_rgba(&flat(100, [40, 80, 120, 128]), 33, 33);
    assert!(every_pixel(&glass, |p| p == [40, 80, 120, 128]), "half see-through too");
}

#[test]
fn a_checkerboard_averages_to_the_middle_gray_a_part_covered_pixel_counts_by_the_part_covered() {
    let checker = |n| {
        rgba_image(n, n, |x, y| {
            if (x + y) % 2 == 1 {
                [255, 255, 255, 255]
            } else {
                [0, 0, 0, 255]
            }
        })
    };
    assert_eq!(pixel(&resize_rgba(&checker(2), 1, 1), 0, 0), [128, 128, 128, 255]);
    assert!(every_pixel(&resize_rgba(&checker(8), 4, 4), |p| p == [128, 128, 128, 255]));
    // 3 pixels to 2: each output covers one and a half: (0 + 90/2) / 1.5 = 30, (90/2 + 180) / 1.5 = 150.
    let ramp = rgba_image(3, 1, |x, _| {
        let v = (x * 90) as u8;
        [v, v, v, 255]
    });
    let two = resize_rgba(&ramp, 2, 1);
    assert_eq!([pixel(&two, 0, 0)[0], pixel(&two, 1, 0)[0]], [30, 150]);
}

#[test]
fn weighs_colours_by_their_alpha_a_see_through_neighbour_does_not_darken_an_opaque_pixel() {
    let half = rgba_image(2, 1, |x, _| if x == 1 { [0, 255, 0, 0] } else { [255, 0, 0, 255] });
    assert_eq!(pixel(&resize_rgba(&half, 1, 1), 0, 0), [255, 0, 0, 128]);
    assert_eq!(pixel(&resize_rgba(&flat(4, [9, 9, 9, 0]), 1, 1), 0, 0), [0, 0, 0, 0]);
}

/// A master: a disc of `colour` on see-through, or (full) a square of `colour` to its edges with a disc of white.
fn disc(n: u32, colour: [u8; 4], full: bool) -> RgbaImage {
    rgba_image(n, n, |x, y| {
        let (fx, fy, fn_) = (f64::from(x), f64::from(y), f64::from(n));
        let inside = (fx - fn_ / 2.0 + 0.5).powi(2) + (fy - fn_ / 2.0 + 0.5).powi(2) < (fn_ * 0.3).powi(2);
        match (full, inside) {
            (true, true) => [255, 255, 255, 255],
            (true, false) => colour,
            (false, true) => colour,
            (false, false) => [0, 0, 0, 0],
        }
    })
}

fn sets() -> (IconSet, IconSet) {
    (
        make_icon_set(&disc(256, [200, 30, 60, 255], false)).unwrap(),
        make_icon_set(&disc(256, [20, 40, 200, 255], true)).unwrap(),
    )
}

#[test]
fn makes_every_file_at_exactly_its_size() {
    let (transparent, _) = sets();
    for (name, n) in [
        ("icon-16.png", 16),
        ("icon-32.png", 32),
        ("apple-touch-icon.png", 180),
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("icon-maskable-512.png", 512),
    ] {
        let img = decode_png(transparent.file(name).unwrap()).unwrap();
        assert_eq!((img.width, img.height), (n, n), "{name}");
    }
    let mut names: Vec<&str> = transparent.files.iter().map(|(n, _)| n.as_str()).collect();
    names.sort();
    let mut want: Vec<&str> = ICON_FILES.iter().map(|(p, _)| &p[1..]).collect();
    want.sort();
    assert_eq!(names, want);
}

#[test]
fn favicon_ico_an_icon_header_three_entries_16_32_48_of_32_bits_each_pointing_at_a_whole_png() {
    let (transparent, _) = sets();
    let ico = transparent.file("favicon.ico").unwrap();
    let u16le = |at: usize| u16::from_le_bytes([ico[at], ico[at + 1]]);
    let u32le = |at: usize| u32::from_le_bytes([ico[at], ico[at + 1], ico[at + 2], ico[at + 3]]) as usize;
    assert_eq!([u16le(0), u16le(2), u16le(4)], [0, 1, 3]);
    let mut end = 6 + 16 * 3;
    for (i, n) in [16u32, 32, 48].into_iter().enumerate() {
        let e = 6 + 16 * i;
        assert_eq!(
            [
                u16::from(ico[e]),
                u16::from(ico[e + 1]),
                u16::from(ico[e + 2]),
                u16::from(ico[e + 3]),
                u16le(e + 4),
                u16le(e + 6)
            ],
            [n as u16, n as u16, 0, 0, 1, 32]
        );
        let (size, offset) = (u32le(e + 8), u32le(e + 12));
        assert_eq!(offset, end, "one after the other, no gaps");
        let png = &ico[offset..offset + size];
        assert_eq!(png[..8], SIG, "entry {n} is a PNG");
        let img = decode_png(png).unwrap();
        assert_eq!((img.width, img.height), (n, n));
        end = offset + size;
    }
    assert_eq!(end, ico.len());
    let big = encode_ico(&[(256, transparent.file("icon-16.png").unwrap())]);
    assert_eq!([big[6], big[7]], [0, 0], "256 is written as 0");
}

#[test]
fn the_home_screen_and_maskable_icons_are_fully_opaque_the_plain_ones_keep_their_see_through_corners() {
    let (transparent, full_bleed) = sets();
    for set in [&transparent, &full_bleed] {
        for name in ["apple-touch-icon.png", "icon-maskable-512.png"] {
            assert!(
                every_pixel(&decode_png(set.file(name).unwrap()).unwrap(), |p| p[3] == 255),
                "{name}"
            );
        }
    }
    for name in ["icon-16.png", "icon-32.png", "icon-192.png", "icon-512.png"] {
        assert_eq!(
            pixel(&decode_png(transparent.file(name).unwrap()).unwrap(), 0, 0)[3],
            0,
            "{name}"
        );
    }
}

#[test]
fn behind_it_the_apps_dark_background_for_a_see_through_edge_the_edges_own_colour_for_a_full_bleed_icon() {
    let (transparent, full_bleed) = sets();
    assert_eq!(transparent.background, [0x1a, 0x1a, 0x1a]);
    assert_eq!(full_bleed.background, [20, 40, 200]);
    let m = decode_png(transparent.file("icon-maskable-512.png").unwrap()).unwrap();
    assert_eq!(pixel(&m, 0, 0), [0x1a, 0x1a, 0x1a, 255]);
    assert_eq!(pixel(&m, 256, 256), [200, 30, 60, 255], "the picture in the middle");
    let fm = decode_png(full_bleed.file("icon-maskable-512.png").unwrap()).unwrap();
    assert_eq!(pixel(&fm, 3, 3), [20, 40, 200, 255]);
    let apple = decode_png(transparent.file("apple-touch-icon.png").unwrap()).unwrap();
    assert_eq!(pixel(&apple, 0, 0), [0x1a, 0x1a, 0x1a, 255]);
    assert_eq!(edge_background_or(&flat(10, [0, 0, 0, 0]), [1, 2, 3]), [1, 2, 3]);
}

#[test]
fn the_maskable_picture_is_about_80_percent_across_in_the_middle() {
    let m = decode_png(&encode_png(&maskable_rgba(&flat(100, [250, 250, 250, 255]), 512, [0, 0, 0])).unwrap()).unwrap();
    let row: Vec<u8> = (0..512).map(|x| pixel(&m, x, 256)[0]).collect();
    let from = row.iter().position(|&v| v == 250).unwrap();
    let to = row.iter().rposition(|&v| v == 250).unwrap();
    assert_eq!(to - from + 1, (512.0f64 * 0.8).round() as usize);
    assert!((from as i64 - (511 - to as i64)).abs() <= 1, "centred");
}

#[test]
fn the_default_set_in_the_public_folder_has_the_16_and_maskable_icons_made_from_icon_512_png_by_this_module() {
    let t = test_app();
    let public = t.config().public_dir();
    let made = make_icon_set(&decode_png(&std::fs::read(public.join("icon-512.png")).unwrap()).unwrap()).unwrap();
    for name in ["icon-16.png", "icon-maskable-512.png"] {
        let committed = decode_png(&std::fs::read(public.join(name)).unwrap()).unwrap();
        let fresh = decode_png(made.file(name).unwrap()).unwrap();
        assert_eq!(
            (committed.width, committed.height),
            (fresh.width, fresh.height),
            "{name}"
        );
        assert!(committed.data == fresh.data, "{name}: the same pixels");
    }
    let maskable = decode_png(&std::fs::read(public.join("icon-maskable-512.png")).unwrap()).unwrap();
    assert!(every_pixel(&maskable, |p| p[3] == 255));
}

// ---------------------------------------------------------------- small helpers

#[test]
fn knows_a_png_jpeg_webp_and_svg_by_their_bytes_and_nothing_else() {
    let kind = |b: &[u8]| sniff_image_type(b);
    assert_eq!(
        kind(&encode_png(&flat(2, [1, 2, 3, 4])).unwrap()).map(|k| k.ext),
        Some("png")
    );
    assert_eq!(
        kind(&[0xff, 0xd8, 0xff, 0xdb, 1, 2]).map(|k| k.mime),
        Some("image/jpeg")
    );
    assert_eq!(kind(b"RIFF\x10\0\0\0WEBPVP8 ").map(|k| k.ext), Some("webp"));
    assert_eq!(
        kind(b"<?xml version=\"1.0\"?>\n<!-- hi -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>").map(|k| k.ext),
        Some("svg")
    );
    assert_eq!(kind(b"<html><body>svg</body></html>"), None);
    assert_eq!(kind(b"GIF89a"), None);
    assert_eq!(
        kind(&[0x3c, 0x73, 0x76, 0x67, 0x20, 0]),
        None,
        "text with a NUL in it is not an SVG"
    );
    assert_eq!(kind(b"<SVG>").map(|k| k.ext), Some("svg"));
    assert_eq!(kind(b""), None);
}

#[test]
fn base64_with_or_without_a_data_start_anything_else_is_none() {
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    assert_eq!(decode_base64(&b64(b"hi there")), Some(b"hi there".to_vec()));
    assert_eq!(
        decode_base64(&format!("data:image/png;base64,{}", b64(b"abc"))),
        Some(b"abc".to_vec())
    );
    for bad in [
        json!(null),
        json!(42),
        json!(""),
        json!("not base64 at all!"),
        json!("%%%%"),
    ] {
        assert_eq!(decode_base64_value(&bad), None, "{bad}");
    }
    // As Buffer.from decodes: no padding needed, white space ignored, a lone last character dropped.
    assert_eq!(decode_base64("aGk"), Some(b"hi".to_vec()));
    assert_eq!(decode_base64(" aG\nk= "), Some(b"hi".to_vec()));
    assert_eq!(decode_base64("aGkh5"), Some(b"hi!".to_vec()));
    assert_eq!(decode_base64("a"), None);
    assert_eq!(decode_base64("DATA:x;BASE64,aGk="), Some(b"hi".to_vec()));
    assert_eq!(decode_base64("data:x,aGk="), None, "a data: address that is not base64");
}

#[test]
fn the_version_goes_on_this_sites_addresses_only_in_place_of_any_query() {
    assert_eq!(with_version("/icon-32.png", "abc"), "/icon-32.png?v=abc");
    assert_eq!(with_version("/icon-32.png?v=old#x", "abc"), "/icon-32.png?v=abc");
    assert_eq!(
        with_version("https://cdn.example/icon.png", "abc"),
        "https://cdn.example/icon.png"
    );
    assert_eq!(with_version("//cdn.example/icon.png", "abc"), "//cdn.example/icon.png");
    assert_eq!(with_version("/x", "a b/é"), "/x?v=a%20b%2F%C3%A9");
}

#[test]
fn the_originals_name_loses_its_folders_and_control_characters() {
    assert_eq!(clean_name("../../Logo\u{7} final.jpg\n"), "Logo final.jpg");
    assert_eq!(clean_name("dir/"), "dir");
    assert_eq!(clean_name(&"n".repeat(300)).len(), 200);
    assert_eq!(clean_name(""), "");
}

// ---------------------------------------------------------------- saving and resetting

fn master_png(n: u32, colour: [u8; 4]) -> Vec<u8> {
    encode_png(&disc(n, colour, true)).unwrap()
}

fn version_of(buf: &[u8]) -> String {
    hex::encode(Sha256::digest(buf))[..12].to_string()
}

fn default_version(t: &TestApp) -> String {
    let bytes = std::fs::read(t.config().public_dir().join("icon-512.png")).unwrap();
    format!("d{}", &hex::encode(Sha256::digest(&bytes))[..11])
}

const SVG: &[u8] =
    b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg>";
const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];

fn upload(master: Vec<u8>) -> BrandUpload {
    BrandUpload {
        master: Some(master),
        original: None,
    }
}

fn read_meta(icons: &BrandIcon) -> Value {
    serde_json::from_str(&std::fs::read_to_string(icons.brand_dir().join("brand.json")).unwrap()).unwrap()
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn keeps_its_files_in_the_data_folder_and_starts_with_the_default_icon() {
    let t = test_app();
    let icons = BrandIcon::of(&t.app);
    icons.reset_brand_icon().await.unwrap();
    assert!(
        icons.brand_dir().starts_with(t.path()),
        "{}",
        icons.brand_dir().display()
    );
    assert_eq!(icons.brand_dir(), t.config().data_dir.join("brand"));
    // the default icon at first: its version from icon-512.png
    assert_eq!(
        brand_status(&t.app),
        BrandStatus {
            custom: false,
            version: default_version(&t),
            updated_at: None
        }
    );
    assert_eq!(icon_version(&t.app), default_version(&t));
    assert_eq!(
        serde_json::to_value(brand_status(&t.app)).unwrap(),
        json!({"custom": false, "version": default_version(&t), "updatedAt": null})
    );
}

#[tokio::test]
async fn a_save_makes_every_icon_keeps_the_master_and_the_original_and_writes_brand_json() {
    let t = test_app();
    let icons = BrandIcon::of(&t.app);
    let master = master_png(128, [30, 160, 90, 255]);
    let s = icons
        .save_brand_icon(BrandUpload {
            master: Some(master.clone()),
            original: Some(Original {
                name: "../../Logo\u{7} final.jpg\n".into(),
                mime: "image/png".into(),
                data: JPEG.to_vec(),
            }),
        })
        .await
        .unwrap();
    assert_eq!((s.custom, s.version.clone()), (true, version_of(&master)));
    assert!(crate::util::js::ms_from_iso(s.updated_at.as_deref().unwrap()).is_some());
    assert_eq!(icons.icon_version(), s.version);
    let dir = icons.brand_dir();
    for (p, _) in ICON_FILES {
        assert!(dir.join(&p[1..]).exists(), "{p}");
    }
    assert_eq!(std::fs::read(dir.join("master.png")).unwrap(), master);
    assert_eq!(std::fs::read(dir.join("original.jpg")).unwrap(), JPEG);
    let meta = read_meta(&icons);
    // its real type, by its bytes; the name without its folders or control characters
    assert_eq!(
        [
            &meta["version"],
            &meta["updatedAt"],
            &meta["originalName"],
            &meta["originalType"]
        ],
        [
            &json!(s.version),
            &json!(s.updated_at),
            &json!("Logo final.jpg"),
            &json!("image/jpeg")
        ]
    );
    assert_eq!(meta["background"], "#1ea05a");
    let text = std::fs::read_to_string(dir.join("brand.json")).unwrap();
    assert!(
        text.starts_with("{\n  \"version\": ") && text.ends_with("}\n"),
        "{text}"
    );
    assert!(
        listing(&dir).iter().all(|f| !f.contains(".tmp-")),
        "no half-written files left"
    );
}

#[tokio::test]
async fn a_new_save_with_an_svg_original_replaces_the_jpeg_one() {
    let t = test_app();
    let icons = BrandIcon::of(&t.app);
    icons
        .save_brand_icon(BrandUpload {
            master: Some(master_png(128, [30, 160, 90, 255])),
            original: Some(Original {
                name: "a.jpg".into(),
                mime: String::new(),
                data: JPEG.to_vec(),
            }),
        })
        .await
        .unwrap();
    let s = icons
        .save_brand_icon(BrandUpload {
            master: Some(master_png(96, [200, 100, 0, 255])),
            original: Some(Original {
                name: "mark.svg".into(),
                mime: "image/svg+xml".into(),
                data: SVG.to_vec(),
            }),
        })
        .await
        .unwrap();
    let dir = icons.brand_dir();
    assert!(dir.join("original.svg").exists());
    assert!(!dir.join("original.jpg").exists());
    assert_eq!(read_meta(&icons)["originalType"], "image/svg+xml");
    assert_eq!(icons.icon_version(), s.version);
    // A save without an original keeps the one before in brand.json.
    icons
        .save_brand_icon(upload(master_png(80, [1, 1, 1, 255])))
        .await
        .unwrap();
    assert_eq!(read_meta(&icons)["originalName"], "mark.svg");
    assert!(dir.join("original.svg").exists());
}

#[tokio::test]
async fn refuses_a_master_that_is_not_a_png_not_square_too_small_too_big_interlaced_or_an_original_that_is_not_a_picture()
 {
    let t = test_app();
    let icons = BrandIcon::of(&t.app);
    let before = icons.brand_status();
    async fn refused(icons: &BrandIcon, up: BrandUpload, words: &str) {
        let err = icons.save_brand_icon(up).await.unwrap_err();
        let err = err.downcast_ref::<BrandIconError>().expect("a refusal");
        assert_eq!(err.status(), 400);
        assert!(err.0.contains(words), "{} (wanted {words})", err.0);
    }
    refused(&icons, upload(JPEG.to_vec()), "must be a PNG").await;
    refused(&icons, BrandUpload::default(), "No icon").await;
    refused(
        &icons,
        upload(encode_png(&rgba_image(64, 65, |_, _| [0, 0, 0, 255])).unwrap()),
        "square",
    )
    .await;
    refused(
        &icons,
        upload(encode_png(&flat(63, [0, 0, 0, 255])).unwrap()),
        "too small",
    )
    .await;
    let mut huge = SIG.to_vec();
    huge.extend(ihdr(2049, 2049, 8, 6, 0));
    huge.extend(mk_chunk("IEND", &[]));
    refused(&icons, upload(huge), "too big").await;
    let mut heavy = SIG.to_vec();
    heavy.extend(vec![0u8; MASTER_MAX_BYTES]);
    refused(&icons, upload(heavy), "too big").await;
    let rows: Vec<Vec<u8>> = (0..64).map(|_| vec![200u8; 64 * 4]).collect();
    let interlaced = make_png(Png {
        width: 64,
        height: 64,
        rows,
        interlace: 1,
        ..Png::default()
    });
    refused(&icons, upload(interlaced), "Interlaced").await;
    let with_original = |data: Vec<u8>, name: &str| BrandUpload {
        master: Some(master_png(128, [30, 160, 90, 255])),
        original: Some(Original {
            name: name.into(),
            mime: String::new(),
            data,
        }),
    };
    refused(
        &icons,
        with_original(b"just words".to_vec(), "x.txt"),
        "not a PNG, JPEG, WebP or SVG",
    )
    .await;
    let mut big = JPEG.to_vec();
    big.extend(vec![0u8; ORIGINAL_MAX_BYTES]);
    refused(&icons, with_original(big, "big.jpg"), "too big").await;
    refused(&icons, with_original(vec![], "empty.png"), "came through empty").await;
    assert_eq!(icons.brand_status(), before, "nothing changed");
}

#[tokio::test]
async fn survives_a_restart_read_again_from_brand_json_and_falls_back_to_the_default_if_its_icons_went_missing() {
    let t = test_app();
    let icons = BrandIcon::of(&t.app);
    icons
        .save_brand_icon(upload(master_png(128, [30, 160, 90, 255])))
        .await
        .unwrap();
    let s = icons.brand_status();
    icons.forget_state();
    assert_eq!(icons.brand_status(), s);
    let dir = icons.brand_dir();
    std::fs::rename(dir.join("icon-192.png"), dir.join("icon-192.png.away")).unwrap();
    icons.forget_state();
    assert!(!icons.brand_status().custom);
    std::fs::rename(dir.join("icon-192.png.away"), dir.join("icon-192.png")).unwrap();
    icons.forget_state();
    assert_eq!(icons.brand_status(), s);
    // A brand.json that is not JSON: the default.
    std::fs::write(dir.join("brand.json"), "{ not json").unwrap();
    icons.forget_state();
    assert!(!icons.brand_status().custom);
}

#[tokio::test]
async fn a_reset_removes_the_upload_and_brings_the_default_back() {
    let t = test_app();
    let icons = BrandIcon::of(&t.app);
    icons
        .save_brand_icon(BrandUpload {
            master: Some(master_png(96, [200, 100, 0, 255])),
            original: Some(Original {
                name: "mark.svg".into(),
                mime: String::new(),
                data: SVG.to_vec(),
            }),
        })
        .await
        .unwrap();
    let s = icons.reset_brand_icon().await.unwrap();
    assert_eq!(
        s,
        BrandStatus {
            custom: false,
            version: default_version(&t),
            updated_at: None
        }
    );
    let left = listing(&icons.brand_dir());
    assert!(left.is_empty(), "nothing left: {left:?}");
    icons.forget_state();
    assert!(!icons.brand_status().custom);
}

#[tokio::test]
async fn two_saves_at_once_one_after_the_other_and_the_last_one_wins() {
    let t = test_app();
    let icons = BrandIcon::of(&t.app);
    let (a, b) = (master_png(80, [1, 2, 3, 255]), master_png(80, [4, 5, 6, 255]));
    let (sa, sb) = tokio::join!(
        icons.save_brand_icon(upload(a.clone())),
        icons.save_brand_icon(upload(b.clone()))
    );
    assert_eq!(
        (sa.unwrap().version, sb.unwrap().version),
        (version_of(&a), version_of(&b))
    );
    assert_eq!(icons.icon_version(), version_of(&b));
    assert_eq!(std::fs::read(icons.brand_dir().join("master.png")).unwrap(), b);
    icons.reset_brand_icon().await.unwrap();
}

// ---------------------------------------------------------------- serving

/// A public folder of its own (the default files say DEFAULT so a fall-through is plain to see), served as
/// server.rs mounts it: the icon middleware, then the manifest, then the static files, which have a max-age of
/// their own (as `express.static` had in production) and pass anything else on to a 404.
fn site(t: &TestApp) -> (Router, tempfile::TempDir) {
    let public = tmp_dir();
    for (p, _) in ICON_FILES {
        std::fs::write(public.path().join(&p[1..]), format!("DEFAULT {p}")).unwrap();
    }
    std::fs::write(public.path().join("other.png"), "OTHER").unwrap();
    std::fs::copy(
        t.config().public_dir().join("manifest.json"),
        public.path().join("manifest.json"),
    )
    .unwrap();
    let not_found = tower::service_fn(|_req: Request| async {
        Ok::<_, std::convert::Infallible>((StatusCode::NOT_FOUND, "Not Found").into_response())
    });
    let statics = ServeDir::new(public.path())
        .call_fallback_on_method_not_allowed(true)
        .fallback(not_found);
    let router = Router::new()
        .fallback_service(statics)
        .layer(map_response(|mut res: Response| async move {
            res.headers_mut()
                .entry(header::CACHE_CONTROL)
                .or_insert(HeaderValue::from_static("public, max-age=300"));
            res
        }))
        .layer(from_fn_with_state(
            manifest_handler(&t.app, public.path()),
            manifest_middleware,
        ))
        .layer(from_fn_with_state(t.app.clone(), brand_icon_middleware));
    (router, public)
}

async fn get_with(router: &Router, path: &str, headers: &[(&str, &str)]) -> TestResponse {
    let mut req = http::request("GET", path);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    http::send(router, req).await
}

#[tokio::test]
async fn no_upload_the_default_files_still_asked_for_again_each_time_no_cache() {
    let t = test_app();
    let (router, _public) = site(&t);
    let res = http::get(&router, "/icon-32.png?v=whatever").await;
    assert_eq!(res.status, 200);
    assert_eq!(res.text(), "DEFAULT /icon-32.png");
    assert_eq!(res.header("cache-control"), Some("no-cache"));
    let other = http::get(&router, "/other.png").await;
    assert_eq!(other.text(), "OTHER");
    assert_eq!(
        other.header("cache-control"),
        Some("public, max-age=300"),
        "other files are not its business"
    );
}

#[tokio::test]
async fn an_upload_served_in_place_of_the_defaults_at_every_address_whatever_the_query_with_its_type_and_etag() {
    let t = test_app();
    let (router, _public) = site(&t);
    let s = save_brand_icon(&t.app, upload(master_png(128, [30, 160, 90, 255])))
        .await
        .unwrap();
    let dir = BrandIcon::of(&t.app).brand_dir();
    for (p, mime) in ICON_FILES {
        let res = http::get(&router, &format!("{p}?v={}", s.version)).await;
        assert_eq!(res.status, 200, "{p}");
        assert_eq!(res.header("content-type"), Some(*mime), "{p}");
        assert_eq!(res.header("cache-control"), Some("no-cache"), "{p}");
        let etag = format!("\"{}-{}\"", s.version, &p[1..]);
        assert_eq!(res.header("etag"), Some(etag.as_str()), "{p}");
        assert_eq!(
            res.body.as_ref(),
            std::fs::read(dir.join(&p[1..])).unwrap().as_slice(),
            "{p}"
        );
    }
    assert_eq!(icon_type("/favicon.ico"), Some("image/x-icon"));
    let plain = http::get(&router, "/icon-192.png").await;
    assert_eq!(plain.body[..8], SIG, "no query: the upload too");
    assert_eq!(
        http::get(&router, "/other.png").await.text(),
        "OTHER",
        "other files are not its business"
    );
}

#[tokio::test]
async fn a_matching_if_none_match_is_304_weak_in_a_list_or_star_an_old_one_200_head_has_no_body() {
    let t = test_app();
    let (router, _public) = site(&t);
    save_brand_icon(&t.app, upload(master_png(128, [30, 160, 90, 255])))
        .await
        .unwrap();
    let etag = http::get(&router, "/icon-32.png")
        .await
        .header("etag")
        .unwrap()
        .to_string();
    for inm in [
        etag.clone(),
        format!("W/{etag}"),
        format!("\"old\", {etag}"),
        "*".to_string(),
    ] {
        let res = get_with(&router, "/icon-32.png?v=x", &[("if-none-match", &inm)]).await;
        assert_eq!(res.status, 304, "{inm}");
        assert_eq!(res.header("etag"), Some(etag.as_str()));
        assert!(res.body.is_empty());
    }
    let old = get_with(&router, "/icon-32.png", &[("if-none-match", "\"d000-icon-32.png\"")]).await;
    assert_eq!(old.status, 200);
    let head = http::send(&router, http::request("HEAD", "/apple-touch-icon.png")).await;
    assert_eq!(head.status, 200);
    assert_eq!(head.header("content-type"), Some("image/png"));
    let size = std::fs::metadata(BrandIcon::of(&t.app).brand_dir().join("apple-touch-icon.png"))
        .unwrap()
        .len();
    assert_eq!(head.header("content-length"), Some(size.to_string().as_str()));
    assert!(head.body.is_empty());
}

#[tokio::test]
async fn only_get_and_head_a_post_to_an_icon_address_goes_on_to_whatever_is_after_it() {
    let t = test_app();
    let (router, _public) = site(&t);
    save_brand_icon(&t.app, upload(master_png(128, [30, 160, 90, 255])))
        .await
        .unwrap();
    let res = http::send(&router, http::request("POST", "/icon-32.png")).await;
    assert_eq!(res.status, 404);
    assert_ne!(res.header("cache-control"), Some("no-cache"));
}

#[tokio::test]
async fn the_manifest_the_version_on_every_icon_one_maskable_icon_the_one_made_for_it_192_and_512_for_any_purpose() {
    let t = test_app();
    let (router, _public) = site(&t);
    save_brand_icon(&t.app, upload(master_png(128, [30, 160, 90, 255])))
        .await
        .unwrap();
    for p in ["/manifest.json", "/manifest.json?v=old"] {
        let res = http::get(&router, p).await;
        assert_eq!(res.status, 200, "{p}");
        assert!(
            res.header("content-type")
                .unwrap()
                .starts_with("application/manifest+json")
        );
        assert_eq!(res.header("cache-control"), Some("no-cache"));
        let m = res.json();
        let v = icon_version(&t.app);
        let icons = m["icons"].as_array().unwrap();
        for icon in icons {
            assert!(
                icon["src"].as_str().unwrap().ends_with(&format!("?v={v}")),
                "{p}: {icon}"
            );
        }
        let maskable: Vec<&Value> = icons
            .iter()
            .filter(|i| i["purpose"].as_str().unwrap_or("").contains("maskable"))
            .collect();
        assert_eq!(
            maskable,
            [
                &json!({"src": format!("/icon-maskable-512.png?v={v}"), "sizes": "512x512", "type": "image/png", "purpose": "maskable"})
            ],
            "{p}"
        );
        for size in ["192x192", "512x512"] {
            assert!(
                icons.iter().any(|i| i["sizes"] == size
                    && i["purpose"] == "any"
                    && !i["src"].as_str().unwrap().contains("maskable")),
                "{p}: {size} any"
            );
        }
        for sc in m["shortcuts"].as_array().cloned().unwrap_or_default() {
            for icon in sc["icons"].as_array().cloned().unwrap_or_default() {
                assert!(icon["src"].as_str().unwrap().ends_with(&format!("?v={v}")));
            }
        }
        let again = get_with(&router, p, &[("if-none-match", res.header("etag").unwrap())]).await;
        assert_eq!(again.status, 304);
    }
    let head = http::send(&router, http::request("HEAD", "/manifest.json")).await;
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
}

#[tokio::test]
async fn a_manifest_follows_the_icon_after_a_reset_its_icons_carry_the_defaults_version() {
    let t = test_app();
    let (router, _public) = site(&t);
    save_brand_icon(&t.app, upload(master_png(128, [30, 160, 90, 255])))
        .await
        .unwrap();
    reset_brand_icon(&t.app).await.unwrap();
    let m = http::get(&router, "/manifest.json").await.json();
    let v = default_version(&t);
    assert!(
        m["icons"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["src"].as_str().unwrap().ends_with(&format!("?v={v}")))
    );
    assert_eq!(
        http::get(&router, "/icon-32.png").await.text(),
        "DEFAULT /icon-32.png",
        "and the default files are back"
    );
}

#[test]
fn versioned_manifest_keeps_an_any_maskable_icons_other_purpose() {
    let m = versioned_manifest(
        &json!({ "icons": [
            { "src": "/icon-192.png", "sizes": "192x192", "purpose": "any maskable" },
            { "src": "/icon-512.png", "sizes": "512x512", "purpose": "maskable" },
        ]}),
        "v1",
    );
    assert_eq!(
        m["icons"],
        json!([
            { "src": "/icon-maskable-512.png?v=v1", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
            { "src": "/icon-192.png?v=v1", "sizes": "192x192", "purpose": "any" },
        ])
    );
}

#[tokio::test]
async fn a_manifest_that_cannot_be_read_goes_on_to_the_static_files() {
    let t = test_app();
    let (router, public) = site(&t);
    std::fs::write(public.path().join("manifest.json"), "{ broken").unwrap();
    let res = http::get(&router, "/manifest.json").await;
    assert_eq!(res.status, 200);
    assert_eq!(res.text(), "{ broken");
    assert_ne!(
        res.header("content-type"),
        Some("application/manifest+json; charset=utf-8")
    );
}

#[test]
fn etags_match_as_node_matched_them() {
    assert!(etag_matches(Some("\"a\""), "\"a\""));
    assert!(etag_matches(Some("W/\"a\""), "\"a\""));
    assert!(etag_matches(Some("\"b\" , W/\"a\""), "\"a\""));
    assert!(etag_matches(Some("*"), "\"a\""));
    assert!(!etag_matches(Some("\"b\""), "\"a\""));
    assert!(!etag_matches(None, "\"a\""));
    assert!(!etag_matches(Some(""), "\"a\""));
}

/// The manifest's body is byte for byte what `JSON.stringify(..., null, 2)` wrote, so its ETag is the Node one: a
/// browser that cached the manifest under the Node version still gets a 304. (Body and ETag from the Node code.)
#[tokio::test]
async fn the_manifest_body_and_etag_are_the_ones_node_made() {
    let t = test_app();
    let public = tmp_dir();
    let base = json!({
        "name": "Tarsee — test",
        "icons": [
            { "src": "/icon-192.png", "sizes": "192x192", "purpose": "any maskable" },
            { "src": "https://x.example/a.png", "purpose": 5 },
        ],
        "shortcuts": [{ "name": "x", "icons": [{ "src": "/icon-32.png?v=1" }] }],
        "n": [1, 2.5, {}],
        "e": [],
        "o": {},
    });
    let node_body = "{\n  \"name\": \"Tarsee — test\",\n  \"icons\": [\n    {\n      \"src\": \"/icon-maskable-512.png?v=v%201\",\n      \"sizes\": \"512x512\",\n      \"type\": \"image/png\",\n      \"purpose\": \"maskable\"\n    },\n    {\n      \"src\": \"/icon-192.png?v=v%201\",\n      \"sizes\": \"192x192\",\n      \"purpose\": \"any\"\n    },\n    {\n      \"src\": \"https://x.example/a.png\",\n      \"purpose\": 5\n    }\n  ],\n  \"shortcuts\": [\n    {\n      \"name\": \"x\",\n      \"icons\": [\n        {\n          \"src\": \"/icon-32.png?v=v%201\"\n        }\n      ]\n    }\n  ],\n  \"n\": [\n    1,\n    2.5,\n    {}\n  ],\n  \"e\": [],\n  \"o\": {}\n}";
    assert_eq!(
        serde_json::to_string_pretty(&versioned_manifest(&base, "v 1")).unwrap(),
        node_body
    );

    // Through the middleware, with the icon's version set to the one above.
    std::fs::write(public.path().join("manifest.json"), base.to_string()).unwrap();
    let icons = BrandIcon::of(&t.app);
    *icons.state.lock() = Some(BrandState {
        custom: false,
        version: "v 1".into(),
        updated_at: None,
    });
    let router = Router::new()
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(from_fn_with_state(
            manifest_handler(&t.app, public.path()),
            manifest_middleware,
        ));
    let res = http::get(&router, "/manifest.json").await;
    assert_eq!(res.text(), node_body);
    assert_eq!(res.header("etag"), Some("\"m036893de0ae0220d\""));
    assert_eq!(res.header("content-length"), Some(node_body.len().to_string().as_str()));
}
