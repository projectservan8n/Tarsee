//! Port of `test/fixtures/make-pdf.js`: small, valid PDFs built in the test itself, so the PDF tests need no binary
//! fixtures. Each one has a real cross-reference table (or, with `obj_stm`, a cross-reference stream), so pdftotext
//! reads them as well as Tarsee's built-in reader does.
//!
//! ```ignore
//! make_pdf(&PdfSpec::pages(&["Line one\nLine two", "Page two"]))      // plain Helvetica text, one string per page
//! PdfSpec { compress: true, .. }                                      // Flate-compressed content streams
//! PdfSpec { predictor: true, .. }                                     // Flate with PNG predictors
//! PdfSpec { encode: Some(Encode::Hex | Encode::A85), .. }             // ASCIIHex or ASCII85 over Flate
//! PdfSpec { obj_stm: true, .. }                                       // PDF 1.5: dictionaries packed in an object stream
//! PdfSpec { cid_font: true, .. }                                      // a Type0 font drawn with 2-byte codes and a ToUnicode map
//! PdfSpec { kerned: true, .. }                                        // words drawn with TJ and kerning gaps
//! PdfSpec { form_xobject: Some("text"), .. }                          // extra text drawn from a form XObject
//! make_pdf(&PdfSpec::pages(&[""]))                                    // a page with no text (as a scanned page reads)
//! ```
//!
//! Text is written one byte per character (Latin-1), as the JS wrote its strings with `Buffer.from(s, "latin1")`.

use std::collections::BTreeSet;
use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;

/// The encoding put over the Flate stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encode {
    Hex,
    A85,
}

/// What [`make_pdf`] builds (the JS options object).
#[derive(Debug, Clone)]
pub struct PdfSpec {
    pub pages: Vec<String>,
    pub compress: bool,
    pub predictor: bool,
    pub encode: Option<Encode>,
    pub obj_stm: bool,
    pub cid_font: bool,
    pub kerned: bool,
    pub form_xobject: Option<String>,
    pub encrypted: bool,
}

impl Default for PdfSpec {
    fn default() -> Self {
        PdfSpec {
            pages: vec!["Hello".to_string()],
            compress: false,
            predictor: false,
            encode: None,
            obj_stm: false,
            cid_font: false,
            kerned: false,
            form_xobject: None,
            encrypted: false,
        }
    }
}

impl PdfSpec {
    /// These pages and every other option off.
    pub fn pages<S: AsRef<str>>(pages: &[S]) -> Self {
        PdfSpec {
            pages: pages.iter().map(|p| p.as_ref().to_string()).collect(),
            ..PdfSpec::default()
        }
    }
}

/// Text as the JS wrote it with `Buffer.from(s, "latin1")`: each character's low byte.
fn latin1(s: &str) -> Vec<u8> {
    s.encode_utf16().map(|u| u as u8).collect()
}

/// A literal PDF string: ( ) and \ escaped.
pub fn pdf_string(s: &str) -> String {
    let mut out = String::from("(");
    for c in s.chars() {
        if matches!(c, '\\' | '(' | ')') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push(')');
    out
}

/// PNG-predict rows of `cols` bytes (one byte per pixel), each row with the next of the five PNG filter types.
fn png_predict(raw: &[u8], cols: usize) -> Vec<u8> {
    let rows = raw.len().div_ceil(cols);
    // the last row padded with NULs (white space in a content stream)
    let mut src = vec![0u8; rows * cols];
    src[..raw.len()].copy_from_slice(raw);
    let mut out = vec![0u8; rows * (cols + 1)];
    for r in 0..rows {
        let kind = (r % 5) as u8;
        out[r * (cols + 1)] = kind;
        for x in 0..cols {
            let cur = i32::from(src[r * cols + x]);
            let a = if x > 0 { i32::from(src[r * cols + x - 1]) } else { 0 };
            let b = if r > 0 { i32::from(src[(r - 1) * cols + x]) } else { 0 };
            let c = if r > 0 && x > 0 { i32::from(src[(r - 1) * cols + x - 1]) } else { 0 };
            let p = match kind {
                1 => a,
                2 => b,
                3 => (a + b) >> 1,
                4 => {
                    let pp = a + b - c;
                    let (pa, pb, pc) = ((pp - a).abs(), (pp - b).abs(), (pp - c).abs());
                    if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    }
                }
                _ => 0,
            };
            out[r * (cols + 1) + 1 + x] = ((cur - p) & 0xff) as u8;
        }
    }
    out
}

/// ASCII85, with a line break now and then (readers skip white space in it).
fn ascii85(buf: &[u8]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < buf.len() {
        let n = (buf.len() - i).min(4);
        let mut chunk = [0u8; 4];
        chunk[..n].copy_from_slice(&buf[i..i + n]);
        let mut v = u32::from_be_bytes(chunk);
        i += 4;
        if v == 0 && n == 4 {
            out.push('z');
            continue;
        }
        let mut digits = ['\0'; 5];
        for k in (0..5).rev() {
            digits[k] = char::from((v % 85) as u8 + 33);
            v /= 85;
        }
        out.extend(&digits[..n + 1]);
        if out.len() % 60 < 5 {
            out.push('\n');
        }
    }
    out.push_str("~>");
    out
}

/// The filters a stream gets.
#[derive(Debug, Clone, Copy, Default)]
struct Filters {
    compress: bool,
    predictor: bool,
    encode: Option<Encode>,
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).expect("writing to memory");
    encoder.finish().expect("writing to memory")
}

/// One object: its dictionary text and, for a stream, its bytes.
#[derive(Debug, Clone, Default)]
struct Obj {
    dict: String,
    stream: Option<Vec<u8>>,
}

/// A stream object with these filters over `data`.
fn stream(dict: &str, data: &[u8], f: Filters) -> Obj {
    let mut body = data.to_vec();
    let mut filters: Vec<&str> = Vec::new();
    let mut parms: Vec<&str> = Vec::new();
    if f.compress || f.predictor {
        if f.predictor {
            body = png_predict(&body, 16);
        }
        body = deflate(&body);
        filters.insert(0, "/FlateDecode");
        parms.insert(
            0,
            if f.predictor {
                "<< /Predictor 12 /Columns 16 >>"
            } else {
                "null"
            },
        );
    }
    match f.encode {
        Some(Encode::Hex) => {
            body = format!("{}>", hex::encode(&body)).into_bytes();
            filters.insert(0, "/ASCIIHexDecode");
            parms.insert(0, "null");
        }
        Some(Encode::A85) => {
            body = ascii85(&body).into_bytes();
            filters.insert(0, "/ASCII85Decode");
            parms.insert(0, "null");
        }
        None => {}
    }
    let mut d = dict.to_string();
    if !filters.is_empty() {
        d.push_str(&format!(" /Filter [{}]", filters.join(" ")));
    }
    if parms.iter().any(|p| *p != "null") {
        d.push_str(&format!(" /DecodeParms [{}]", parms.join(" ")));
    }
    Obj {
        dict: format!("<< {d} /Length {} >>", body.len()),
        stream: Some(body),
    }
}

/// Write objects (index = object number; `[0]` unused) as a PDF. `in_obj_stm`: object numbers to pack into one
/// object stream (PDF 1.5, with a cross-reference stream); streams can't be packed.
fn write_pdf(objects: &[Obj], root: usize, in_obj_stm: &BTreeSet<usize>, filters: Filters, trailer_extra: &str) -> Vec<u8> {
    let version = if in_obj_stm.is_empty() { "1.4" } else { "1.5" };
    let mut out: Vec<u8> = format!("%PDF-{version}\n").into_bytes();
    out.extend_from_slice(&[b'%', 0xE2, 0xE3, 0xCF, 0xD3, b'\n']);
    let count = objects.len() - 1;
    let mut offsets = vec![0usize; count + 3];
    let write_obj = |out: &mut Vec<u8>, offsets: &mut Vec<usize>, n: usize, o: &Obj| {
        offsets[n] = out.len();
        out.extend_from_slice(&latin1(&format!("{n} 0 obj\n{}\n", o.dict)));
        if let Some(bytes) = &o.stream {
            out.extend_from_slice(b"stream\n");
            out.extend_from_slice(bytes);
            out.extend_from_slice(b"\nendstream\n");
        }
        out.extend_from_slice(b"endobj\n");
    };
    for n in 1..=count {
        if !in_obj_stm.contains(&n) {
            write_obj(&mut out, &mut offsets, n, &objects[n]);
        }
    }

    if in_obj_stm.is_empty() {
        let xref = out.len();
        let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", count + 1);
        for offset in offsets.iter().take(count + 1).skip(1) {
            table.push_str(&format!("{offset:010} 00000 n \n"));
        }
        out.extend_from_slice(table.as_bytes());
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root {root} 0 R{trailer_extra} >>\nstartxref\n{xref}\n%%EOF\n",
                count + 1
            )
            .as_bytes(),
        );
        return out;
    }

    // The object stream: "num offset" pairs, then the objects.
    let packed: Vec<usize> = in_obj_stm.iter().copied().collect();
    let mut header = String::new();
    let mut body: Vec<u8> = Vec::new();
    for &n in &packed {
        header.push_str(&format!("{n} {} ", body.len()));
        body.extend_from_slice(&latin1(&format!("{}\n", objects[n].dict)));
    }
    let stm_num = count + 1;
    let mut data = header.clone().into_bytes();
    data.extend_from_slice(&body);
    let stm = stream(
        &format!("/Type /ObjStm /N {} /First {}", packed.len(), header.len()),
        &data,
        filters,
    );
    write_obj(&mut out, &mut offsets, stm_num, &stm);

    // The cross-reference stream: W [1 4 2], one row per object 0..xrefNum.
    let xref_num = count + 2;
    offsets[xref_num] = out.len();
    let mut rows = vec![0u8; (xref_num + 1) * 7];
    let mut row = |i: usize, kind: u8, a: u32, b: u16| {
        rows[i * 7] = kind;
        rows[i * 7 + 1..i * 7 + 5].copy_from_slice(&a.to_be_bytes());
        rows[i * 7 + 5..i * 7 + 7].copy_from_slice(&b.to_be_bytes());
    };
    row(0, 0, 0, 0xffff);
    for n in 1..=xref_num {
        if in_obj_stm.contains(&n) {
            let index = packed.iter().position(|&p| p == n).unwrap_or(0);
            row(n, 2, stm_num as u32, index as u16);
        } else {
            row(n, 1, offsets[n] as u32, 0);
        }
    }
    out.extend_from_slice(
        format!(
            "{xref_num} 0 obj\n<< /Type /XRef /Size {} /Root {root} 0 R /W [1 4 2] /Index [0 {}] /Length {}{trailer_extra} >>\nstream\n",
            xref_num + 1,
            xref_num + 1,
            rows.len()
        )
        .as_bytes(),
    );
    out.extend_from_slice(&rows);
    out.extend_from_slice(format!("\nendstream\nendobj\nstartxref\n{}\n%%EOF\n", offsets[xref_num]).as_bytes());
    out
}

/// The ToUnicode CMap for the CID font: lower-case letters as one range from <0100>, every other character one by
/// one. Returns the CMap and the codes for each character.
fn cid_mapping(text: &str) -> (String, Vec<(char, u32)>) {
    let mut codes: Vec<(char, u32)> = Vec::new();
    let mut next = 1u32;
    for ch in text.chars() {
        if codes.iter().any(|(c, _)| *c == ch) {
            continue;
        }
        if ch.is_ascii_lowercase() {
            codes.push((ch, 0x100 + u32::from(ch) - 0x61));
        } else {
            codes.push((ch, next));
            next += 1;
        }
    }
    let hex4 = |n: u32| format!("{n:04X}");
    let singles: Vec<&(char, u32)> = codes.iter().filter(|(ch, _)| !ch.is_ascii_lowercase()).collect();
    let mut cmap = vec![
        "/CIDInit /ProcSet findresource begin".to_string(),
        "12 dict begin".into(),
        "begincmap".into(),
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def".into(),
        "/CMapName /Adobe-Identity-UCS def".into(),
        "/CMapType 2 def".into(),
        "1 begincodespacerange".into(),
        "<0000> <FFFF>".into(),
        "endcodespacerange".into(),
        format!("{} beginbfchar", singles.len()),
    ];
    for (ch, code) in &singles {
        // `ch.charCodeAt(0)`: the character's first UTF-16 unit.
        let unit = ch.encode_utf16(&mut [0u16; 2])[0];
        cmap.push(format!("<{}> <{}>", hex4(*code), hex4(u32::from(unit))));
    }
    cmap.extend(
        [
            "endbfchar",
            "1 beginbfrange",
            "<0100> <0119> <0061>",
            "endbfrange",
            "endcmap",
            "CMapName currentdict /CMap defineresource pop",
            "end",
            "end",
        ]
        .map(String::from),
    );
    (cmap.join("\n"), codes)
}

/// A whole PDF: one entry of `pages` per page, lines split on "\n".
pub fn make_pdf(spec: &PdfSpec) -> Vec<u8> {
    let filters = Filters {
        compress: spec.compress || spec.encode.is_some(),
        predictor: spec.predictor,
        encode: spec.encode,
    };
    let mut objects: Vec<Obj> = vec![Obj::default()];
    let add = |objects: &mut Vec<Obj>, o: Obj| {
        objects.push(o);
        objects.len() - 1
    };
    let catalog = add(&mut objects, Obj::default());
    let pages_node = add(&mut objects, Obj::default());
    let cid = spec.cid_font.then(|| cid_mapping(&spec.pages.concat()));

    let font = if let Some((cmap, _)) = &cid {
        let to_unicode = add(&mut objects, stream("", &latin1(cmap), filters));
        let descriptor = add(
            &mut objects,
            Obj {
                dict: "<< /Type /FontDescriptor /FontName /TestFont /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>".into(),
                stream: None,
            },
        );
        let descendant = add(
            &mut objects,
            Obj {
                dict: format!("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {descriptor} 0 R /DW 500 >>"),
                stream: None,
            },
        );
        add(
            &mut objects,
            Obj {
                dict: format!("<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /DescendantFonts [{descendant} 0 R] /ToUnicode {to_unicode} 0 R >>"),
                stream: None,
            },
        )
    } else {
        add(
            &mut objects,
            Obj {
                dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
                stream: None,
            },
        )
    };
    let show = |s: &str| -> String {
        if let Some((_, codes)) = &cid {
            let hex: String = s
                .chars()
                .map(|ch| {
                    let code = codes.iter().find(|(c, _)| *c == ch).map(|(_, n)| *n).unwrap_or(0);
                    format!("{code:04X}")
                })
                .collect();
            return format!("<{hex}> Tj");
        }
        if spec.kerned {
            // Each word as its own string; a big gap (-600) between words, a small one (-20) inside them.
            let words: Vec<String> = s
                .split(' ')
                .map(|w| {
                    let chars: Vec<char> = w.chars().collect();
                    if chars.len() > 2 {
                        let head: String = chars[..2].iter().collect();
                        let tail: String = chars[2..].iter().collect();
                        format!("{} -20 {}", pdf_string(&head), pdf_string(&tail))
                    } else {
                        pdf_string(w)
                    }
                })
                .collect();
            return format!("[{}] TJ", words.join(" -600 "));
        }
        format!("{} Tj", pdf_string(s))
    };

    let xobj = spec.form_xobject.as_ref().map(|text| {
        let body = format!("BT /F1 12 Tf 72 400 Td {} ET", show(text));
        add(
            &mut objects,
            stream(
                &format!("/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >>"),
                &latin1(&body),
                filters,
            ),
        )
    });

    let mut kids = Vec::new();
    for text in &spec.pages {
        let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
        let body = if lines.is_empty() {
            // a drawing and no text, as a scanned page reads
            "0 0 1 rg 72 72 200 200 re f".to_string()
        } else {
            let shown: Vec<String> = lines.iter().map(|l| show(l)).collect();
            format!("BT /F1 12 Tf 14 TL 72 720 Td {} ET", shown.join(" T* "))
        };
        let body = match xobj {
            Some(_) => format!("{body}\nq /X1 Do Q"),
            None => body,
        };
        let content = add(&mut objects, stream("", &latin1(&body), filters));
        let xres = xobj
            .map(|x| format!(" /XObject << /X1 {x} 0 R >>"))
            .unwrap_or_default();
        kids.push(add(
            &mut objects,
            Obj {
                dict: format!("<< /Type /Page /Parent {pages_node} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >>{xres} >> /Contents {content} 0 R >>"),
                stream: None,
            },
        ));
    }
    objects[catalog] = Obj {
        dict: format!("<< /Type /Catalog /Pages {pages_node} 0 R >>"),
        stream: None,
    };
    let kid_refs: Vec<String> = kids.iter().map(|k| format!("{k} 0 R")).collect();
    objects[pages_node] = Obj {
        dict: format!("<< /Type /Pages /Kids [{}] /Count {} >>", kid_refs.join(" "), kids.len()),
        stream: None,
    };

    let mut in_obj_stm = BTreeSet::new();
    if spec.obj_stm {
        for (n, o) in objects.iter().enumerate().skip(1) {
            if o.stream.is_none() {
                in_obj_stm.insert(n);
            }
        }
    }
    let trailer_extra = if spec.encrypted {
        " /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>"
    } else {
        ""
    };
    write_pdf(&objects, catalog, &in_obj_stm, filters, trailer_extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_pdf_has_a_header_a_cross_reference_table_and_the_text() {
        let pdf = make_pdf(&PdfSpec::pages(&["Hello (world)"]));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.starts_with("%PDF-1.4\n"));
        assert!(text.contains("(Hello \\(world\\)) Tj"));
        assert!(text.contains("xref\n0 6\n0000000000 65535 f \n"));
        assert!(text.ends_with("%%EOF\n"));
        // Every offset in the table points at its object.
        let table = text.split("xref\n").nth(1).unwrap();
        for (n, line) in table.lines().skip(2).take(5).enumerate() {
            let offset: usize = line[..10].parse().unwrap();
            assert!(pdf[offset..].starts_with(format!("{} 0 obj", n + 1).as_bytes()), "object {}", n + 1);
        }
    }

    #[test]
    fn an_object_stream_pdf_is_version_1_5_with_a_cross_reference_stream() {
        let pdf = make_pdf(&PdfSpec {
            obj_stm: true,
            ..PdfSpec::pages(&["x"])
        });
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.starts_with("%PDF-1.5\n"));
        assert!(text.contains("/Type /ObjStm /N "));
        assert!(text.contains("/Type /XRef"));
        assert!(!text.contains("trailer"));
    }

    #[test]
    fn ascii85_and_predictors_match_the_js_helpers() {
        // "Man " -> "9jqo^", the classic example; four zero bytes -> "z".
        assert_eq!(ascii85(b"Man "), "9jqo^~>");
        // (A line break once the text is under 5 characters past a multiple of 60, as the JS did.)
        assert_eq!(ascii85(&[0, 0, 0, 0, b'M']), "z9`\n~>");
        let predicted = png_predict(b"abc", 2);
        assert_eq!(predicted, vec![0, b'a', b'b', 1, b'c', (0u8).wrapping_sub(b'c')]);
    }
}
