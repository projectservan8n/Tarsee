//! Port of `src/lib/discord-format.js`: turn GitHub-flavored markdown tables and block quotes into something Discord
//! actually renders, plus a fence-aware message splitter. Ported from TarseeMacOS.
//!
//! WHY this exists: Discord has never supported markdown tables (verified 2026-07-28 against Markdown Text 101 and
//! the full dev changelog). A raw `| a | b |` ships as literal pipes AND the `*`/`_`/`~` inside cells still get parsed
//! as emphasis, so the row is mangled on top of looking broken. Asking the model not to emit tables is a soft prompt
//! and it leaks; this is the code-level enforcement.
//!
//! Two output modes, chosen automatically:
//!   (a) NARROW  -> fenced code block, space-aligned columns.
//!   (b) WIDE    -> one line per row, label-value style.
//!
//! WHY a width cutoff instead of always using a code block: Discord desktop code blocks WRAP (white-space: pre-wrap)
//! — they do NOT get a horizontal scrollbar (feature request open since 2018, never shipped). So an over-wide grid
//! doesn't degrade to "swipe sideways", it degrades to soft-wrapped lines with the column alignment destroyed, which
//! is strictly worse than prose. The binding surface is a phone: ~300-330px of content column at ~13-14px monospace =
//! roughly 38-45 columns. 40 is the width that never wraps anywhere, so that's the threshold.
//!
//! Lengths the Node code took with `.length` (the 1900-character fence budget, the 2000-character message) are
//! counted in UTF-16 units here too.

use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::util::js::utf16_len;

pub mod js_text {
    //! JavaScript's regular-expression and string behaviour that the formatters of this package depend on.
    //!
    //! JavaScript's `\s` (and `String.prototype.trim`) is a fixed set of characters that differs from Rust's
    //! `char::is_whitespace` in two places: U+FEFF is whitespace in JavaScript and U+0085 is not. JavaScript's `.`
    //! (without the `s` flag) stops at four line terminators, not only `\n`. `\d`, `\w` and `\b` are ASCII-only
    //! without the `u` flag. [`translate`] turns a JavaScript pattern into a Rust one with exactly those meanings, so
    //! the patterns below can be written as the Node code wrote them.

    /// The characters of JavaScript's `\s`, as members of a character class.
    pub const WS_MEMBERS: &str =
        r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

    /// JavaScript's `\s` as a Rust class.
    pub fn ws() -> String {
        format!("[{WS_MEMBERS}]")
    }

    /// Whether `c` is whitespace to JavaScript (`\s`, and what `trim` removes).
    pub fn is_ws(c: char) -> bool {
        matches!(
            c,
            '\t' | '\n'
                | '\x0B'
                | '\x0C'
                | '\r'
                | ' '
                | '\u{A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    }

    /// Whether `c` ends a line to JavaScript (what `.` does not match, and where `^`/`$` match with the `m` flag).
    pub fn is_line_terminator(c: char) -> bool {
        matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
    }

    /// `s.trim()`.
    pub fn trim(s: &str) -> &str {
        s.trim_matches(is_ws)
    }

    /// `s.trimStart()`.
    pub fn trim_start(s: &str) -> &str {
        s.trim_start_matches(is_ws)
    }

    /// `s.trimEnd()`.
    pub fn trim_end(s: &str) -> &str {
        s.trim_end_matches(is_ws)
    }

    /// A JavaScript pattern (the text between the slashes, no `u` or `s` flag) as a Rust pattern with the same
    /// meaning: `\s`, `\S`, `\d`, `\w`, `\b` and `.` as JavaScript reads them, `[\s\S]` as any character, `\uXXXX` as
    /// that character, `\/` as `/`, and `[`, `~` and `&` inside a class taken literally, as JavaScript takes them.
    /// Flags are written into the result by the caller. `\b` becomes `(?-u:\b)`, which only the `regex` crate reads.
    /// A pattern JavaScript would refuse comes out as one the `regex` crate refuses too (or reads literally).
    pub fn translate(js: &str) -> String {
        let chars: Vec<char> = js.chars().collect();
        let mut out = String::new();
        let mut in_class = false;
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '\\' {
                let Some(&next) = chars.get(i + 1) else {
                    out.push('\\');
                    break;
                };
                i += 2;
                match (next, in_class) {
                    ('s', false) => out.push_str(&ws()),
                    ('s', true) => out.push_str(WS_MEMBERS),
                    ('S', false) => out.push_str(&format!("[^{WS_MEMBERS}]")),
                    ('d', false) => out.push_str("[0-9]"),
                    ('d', true) => out.push_str("0-9"),
                    ('D', false) => out.push_str("[^0-9]"),
                    ('w', false) => out.push_str("[A-Za-z0-9_]"),
                    ('w', true) => out.push_str("A-Za-z0-9_"),
                    ('W', false) => out.push_str("[^A-Za-z0-9_]"),
                    ('b', false) => out.push_str(r"(?-u:\b)"),
                    ('B', false) => out.push_str(r"(?-u:\B)"),
                    ('S', true) => out.push_str(&format!("[^{WS_MEMBERS}]")),
                    ('D', true) => out.push_str("[^0-9]"),
                    ('W', true) => out.push_str("[^A-Za-z0-9_]"),
                    // Inside a class JavaScript reads \b as backspace and \B as a plain "B".
                    ('b', true) => out.push_str(r"\x08"),
                    ('B', true) => out.push('B'),
                    ('/', _) => out.push('/'),
                    ('u', _) => {
                        // `\uXXXX` is that character; without four hex digits it is a plain "u" (no `u` flag).
                        let hex: String = chars.iter().skip(i).take(4).collect();
                        if hex.len() == 4 && hex.chars().all(|h| h.is_ascii_hexdigit()) {
                            i += 4;
                            out.push_str(&format!("\\x{{{hex}}}"));
                        } else {
                            out.push('u');
                        }
                    }
                    (other, _) => {
                        out.push('\\');
                        out.push(other);
                    }
                }
                continue;
            }
            if !in_class && chars[i..].starts_with(&['[', '\\', 's', '\\', 'S', ']']) {
                out.push_str("(?s:.)");
                i += 6;
                continue;
            }
            match c {
                '[' if !in_class => {
                    in_class = true;
                    out.push('[');
                    if chars.get(i + 1) == Some(&'^') {
                        out.push('^');
                        i += 1;
                    }
                }
                '[' | '~' | '&' if in_class => {
                    out.push('\\');
                    out.push(c);
                }
                ']' if in_class => {
                    in_class = false;
                    out.push(']');
                }
                '.' if !in_class => out.push_str(r"[^\n\r\x{2028}\x{2029}]"),
                _ => out.push(c),
            }
            i += 1;
        }
        out
    }

    /// [`translate`], compiled with the `regex` crate. For patterns written in this crate: panics on a bad one.
    /// JavaScript's `i` flag (without `u`) folds only ASCII letters into each other; write it as `(?i-u:...)` around
    /// the letters it applies to.
    pub fn re(js: &str) -> regex::Regex {
        regex::Regex::new(&translate(js)).unwrap_or_else(|e| panic!("pattern {js}: {e}"))
    }
}

use js_text::{re, trim, trim_end};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// Max rendered grid width (display columns) that still fits a phone.
pub const MAX_GRID_WIDTH: usize = 40;

/// If a fenced grid would exceed this many characters we fall back to list mode. WHY: a fence longer than one Discord
/// message has to be split, and splitting a fence is exactly the thing that corrupts it (see
/// [`split_message_fence_safe`]). List mode has no fence, so it splits cleanly at any line boundary. Preferring an
/// ugly-but-intact list over a shredded grid is the right trade. 1900 leaves headroom under the 2000 hard cap for the
/// surrounding prose in the same message.
pub const MAX_FENCED_CHARS: usize = 1900;

/// Gap between columns in the grid. Two spaces reads as a column break.
const COL_GAP: &str = "  ";

// ---------------------------------------------------------------------------
// Display width — naive .length lies about emoji and CJK
// ---------------------------------------------------------------------------

/// Code points that occupy 2 monospace columns. Ranges are deliberately conservative: we'd rather under-pad a rare
/// glyph than over-pad every arrow and em dash (U+2192 and U+2014 are width 1 and are extremely common in model
/// output).
const WIDE_RANGES: &[(u32, u32)] = &[
    (0x1100, 0x115f),   // Hangul Jamo
    (0x2e80, 0x303e),   // CJK radicals, Kangxi, CJK symbols/punctuation
    (0x3041, 0x33ff),   // Hiragana, Katakana, Bopomofo, CJK compat
    (0x3400, 0x4dbf),   // CJK Ext A
    (0x4e00, 0x9fff),   // CJK Unified
    (0xa000, 0xa4cf),   // Yi
    (0xa960, 0xa97f),   // Hangul Jamo Ext A
    (0xac00, 0xd7a3),   // Hangul syllables
    (0xf900, 0xfaff),   // CJK compat ideographs
    (0xfe10, 0xfe19),   // vertical forms
    (0xfe30, 0xfe6f),   // CJK compat forms
    (0xff00, 0xff60),   // fullwidth forms
    (0xffe0, 0xffe6),   // fullwidth signs
    (0x1f300, 0x1f64f), // misc symbols & pictographs, emoticons
    (0x1f680, 0x1f6ff), // transport
    (0x1f900, 0x1f9ff), // supplemental symbols & pictographs
    (0x1fa70, 0x1faff), // symbols & pictographs extended-A
    (0x20000, 0x2fffd), // CJK Ext B+
    (0x30000, 0x3fffd),
];

/// Ambiguous-width block (dingbats, misc symbols: ✅ ⚠ ☀ ✈ …). These render narrow as plain text but WIDE when
/// followed by VS16 (U+FE0F), which is how models emit them as emoji. So width here depends on the next code point.
const AMBIGUOUS_EMOJI: &[(u32, u32)] = &[(0x2190, 0x21ff), (0x2300, 0x23ff), (0x25a0, 0x27bf), (0x2b00, 0x2bff), (0x2934, 0x2935)];

/// The subset of that block with Emoji_Presentation=Yes — always wide, VS16 or not. ✅ ❌ ⚡ ⭐ are extremely common in
/// model status columns, so getting these wrong misaligns the most-used table shape in Tarsee.
const DEFAULT_EMOJI: &[(u32, u32)] = &[
    (0x231a, 0x231b),
    (0x23e9, 0x23ec),
    (0x23f0, 0x23f0),
    (0x23f3, 0x23f3),
    (0x25fd, 0x25fe),
    (0x2614, 0x2615),
    (0x2648, 0x2653),
    (0x267f, 0x267f),
    (0x2693, 0x2693),
    (0x26a1, 0x26a1),
    (0x26aa, 0x26ab),
    (0x26bd, 0x26be),
    (0x26c4, 0x26c5),
    (0x26ce, 0x26ce),
    (0x26d4, 0x26d4),
    (0x26ea, 0x26ea),
    (0x26f2, 0x26f3),
    (0x26f5, 0x26f5),
    (0x26fa, 0x26fa),
    (0x26fd, 0x26fd),
    (0x2705, 0x2705),
    (0x270a, 0x270b),
    (0x2728, 0x2728),
    (0x274c, 0x274c),
    (0x274e, 0x274e),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2795, 0x2797),
    (0x27b0, 0x27b0),
    (0x27bf, 0x27bf),
    (0x2b1b, 0x2b1c),
    (0x2b50, 0x2b50),
    (0x2b55, 0x2b55),
];

fn in_ranges(cp: u32, ranges: &[(u32, u32)]) -> bool {
    ranges.iter().any(|&(lo, hi)| cp >= lo && cp <= hi)
}

/// Code points that add no width of their own (they compose onto a base).
fn is_zero_width(cp: u32) -> bool {
    cp == 0x200b || cp == 0x200d || cp == 0xfeff // ZWSP / ZWJ / BOM
        || (0xfe00..=0xfe0f).contains(&cp) // variation selectors
        || (0x0300..=0x036f).contains(&cp) // combining diacriticals
        || (0x1ab0..=0x1aff).contains(&cp)
        || (0x20d0..=0x20ff).contains(&cp) // combining for symbols
        || (0x1f3fb..=0x1f3ff).contains(&cp) // skin-tone modifiers
        || (0xe0100..=0xe01ef).contains(&cp) // VS supplement
}

/// Monospace display width of a string, in columns.
/// WHY not str.length: "🇦🇺" is length 4, "日" is length 1 but 2 columns wide, and a ZWJ family emoji is length 11.
/// padEnd() on .length misaligns every column to the right of any such cell.
pub fn display_width(s: &str) -> usize {
    let cps: Vec<u32> = s.chars().map(u32::from).collect();
    let mut w = 0;
    // A ZWJ fuses the NEXT glyph into the previous one (👨‍👩‍👧 is one 2-col glyph, not three). Without this a family
    // emoji measures 6 and every column to its right shifts.
    let mut join_pending = false;
    for (i, &cp) in cps.iter().enumerate() {
        if cp == 0x200d {
            join_pending = true;
            continue;
        }
        if is_zero_width(cp) {
            continue;
        }
        if join_pending {
            join_pending = false;
            continue;
        }
        if in_ranges(cp, WIDE_RANGES) || in_ranges(cp, DEFAULT_EMOJI) {
            w += 2;
            continue;
        }
        // Emoji presentation selector promotes an ambiguous glyph to 2 columns.
        if in_ranges(cp, AMBIGUOUS_EMOJI) {
            w += if cps.get(i + 1) == Some(&0xfe0f) { 2 } else { 1 };
            continue;
        }
        w += 1;
    }
    w
}

/// How a column is aligned: from the separator row (`:--`, `--:`, `:-:`), or chosen for the grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
    Center,
}

/// Pad `s` to `width` display columns.
fn pad_to(s: &str, width: usize, align: Align) -> String {
    let pad = width.saturating_sub(display_width(s));
    match align {
        Align::Right => format!("{}{s}", " ".repeat(pad)),
        Align::Center => {
            let l = pad / 2;
            format!("{}{s}{}", " ".repeat(l), " ".repeat(pad - l))
        }
        Align::Left => format!("{s}{}", " ".repeat(pad)),
    }
}

// ---------------------------------------------------------------------------
// Fence masking — rule 2: never touch a table already inside a code block
// ---------------------------------------------------------------------------

// U+0000 can't appear in model text and survives .split("\n"), so it makes a collision-proof placeholder sentinel.
const MASK_OPEN: &str = "\u{0}MDT";
const MASK_CLOSE: &str = "\u{0}";

static FENCE_OF: LazyLock<Regex> = LazyLock::new(|| re(r"^(\s*)(`{3,}|~{3,})(.*)$"));
static UNMASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x00MDT([0-9]+)\x00").expect("the unmask pattern"));

struct FenceLine<'a> {
    marker: &'a str,
    rest: &'a str,
}

fn fence_of(line: &str) -> Option<FenceLine<'_>> {
    let m = FENCE_OF.captures(line)?;
    Some(FenceLine {
        marker: m.get(2).map_or("", |g| g.as_str()),
        rest: m.get(3).map_or("", |g| g.as_str()),
    })
}

/// Replace every fenced code block with an opaque placeholder. Handles ``` and ~~~, any fence length >= 3, leading
/// indentation, and an UNCLOSED fence (masks to end of text — an unterminated fence means everything after it is code
/// as far as Discord is concerned).
///
/// This is also what makes the transform idempotent for narrow mode: our own output is a fenced block, so a second
/// pass masks it and walks past.
fn mask_fences(text: &str) -> (String, Vec<String>) {
    let mut blocks: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    let mut open: Option<FenceLine<'_>> = None;
    let mut buf: Vec<&str> = Vec::new();

    for line in text.split('\n') {
        let f = fence_of(line);
        let Some(opened) = &open else {
            if f.is_some() {
                open = f;
                buf = vec![line];
            } else {
                out.push(line.to_string());
            }
            continue;
        };
        buf.push(line);
        // A closing fence is the same char, at least as long, with nothing after.
        let is_close = f.as_ref().is_some_and(|f| {
            f.marker.chars().next() == opened.marker.chars().next()
                && f.marker.len() >= opened.marker.len()
                && trim(f.rest).is_empty()
        });
        if is_close {
            blocks.push(buf.join("\n"));
            out.push(format!("{MASK_OPEN}{}{MASK_CLOSE}", blocks.len() - 1));
            open = None;
            buf = Vec::new();
        }
    }
    if open.is_some() {
        // unterminated fence: mask the remainder
        blocks.push(buf.join("\n"));
        out.push(format!("{MASK_OPEN}{}{MASK_CLOSE}", blocks.len() - 1));
    }
    (out.join("\n"), blocks)
}

fn unmask_fences(text: &str, blocks: &[String]) -> String {
    UNMASK
        .replace_all(text, |c: &Captures| {
            c[1].parse::<usize>()
                .ok()
                .and_then(|i| blocks.get(i))
                .cloned()
                .unwrap_or_default()
        })
        .into_owned()
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Split a table row into cells, honoring backslash-escaped pipes (rule 3). The `\|` is left ESCAPED in the returned
/// cell — each render mode decides whether to unescape, because the answer differs (see renderers).
fn split_cells(line: &str) -> Vec<String> {
    let mut s = trim(line);
    if let Some(rest) = s.strip_prefix('|') {
        s = rest;
    }
    // Only strip a trailing pipe if it isn't itself escaped.
    if s.ends_with('|') && !s.ends_with("\\|") {
        s = &s[..s.len() - 1];
    }

    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek() == Some(&'|') {
            cur.push_str("\\|");
            chars.next();
            continue;
        }
        if c == '|' {
            cells.push(trim(&cur).to_string());
            cur.clear();
            continue;
        }
        cur.push(c);
    }
    cells.push(trim(&cur).to_string());
    cells
}

static ROW_PIPE: LazyLock<Regex> = LazyLock::new(|| re(r"(^|[^\\])\|"));
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
static ALIGN_CELL: LazyLock<Regex> = LazyLock::new(|| re(r"^(:?)-{1,}(:?)$"));
static INDENT: LazyLock<Regex> = LazyLock::new(|| re(r"^(\s*)"));

/// A plausible table row: has at least one unescaped pipe.
fn is_row_line(line: Option<&str>) -> bool {
    let Some(line) = line else { return false };
    let t = trim(line);
    if t.is_empty() {
        return false;
    }
    ROW_PIPE.is_match(t)
}

/// Alignment separator row: every cell is `---`, `:--`, `--:` or `:-:`.
fn parse_align_row(line: Option<&str>) -> Option<Vec<Option<Align>>> {
    if !is_row_line(line) {
        return None;
    }
    let cells = split_cells(line?);
    if cells.is_empty() {
        return None;
    }
    let mut aligns = Vec::new();
    for c in &cells {
        let squeezed = WS_RUN.replace_all(c, "");
        let m = ALIGN_CELL.captures(&squeezed)?;
        let left = !m[1].is_empty();
        let right = !m[2].is_empty();
        aligns.push(match (left, right) {
            (true, true) => Some(Align::Center),
            (_, true) => Some(Align::Right),
            (true, _) => Some(Align::Left),
            _ => None,
        });
    }
    Some(aligns)
}

/// One markdown table found by [`parse_md_tables`]: its first and last line (indexes into the text's lines), the
/// indentation of its header line, and its cells (escaped pipes still escaped).
#[derive(Debug, Clone, PartialEq)]
pub struct MdTable {
    pub start: usize,
    pub end: usize,
    pub indent: String,
    pub headers: Vec<String>,
    pub aligns: Vec<Option<Align>>,
    pub rows: Vec<Vec<String>>,
}

/// Find every GFM table in `text` (fences already masked out).
///
/// A table is: a row line, then an alignment row with a matching-ish cell count, then zero or more row lines.
/// Requiring the alignment row is what keeps us from eating prose that happens to contain a pipe — and it's what
/// makes list-mode output (which contains no alignment row) idempotent.
pub fn parse_md_tables(text: &str) -> Vec<MdTable> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut tables = Vec::new();
    let mut i = 0;
    while i + 1 < lines.len() {
        if !is_row_line(Some(lines[i])) {
            i += 1;
            continue;
        }
        let Some(aligns) = parse_align_row(lines.get(i + 1).copied()) else {
            i += 1;
            continue;
        };

        let headers = split_cells(lines[i]);
        // GFM requires the counts to match; be lenient (models miscount) but reject wild mismatches, which are
        // almost always coincidence.
        if headers.len().abs_diff(aligns.len()) > 1 {
            i += 1;
            continue;
        }

        let indent = INDENT
            .captures(lines[i])
            .and_then(|c| c.get(1))
            .map_or(String::new(), |g| g.as_str().to_string());
        // If the header used a leading pipe, body rows must too — stops a following paragraph containing "a | b"
        // from being swallowed.
        let lead_pipe = trim(lines[i]).starts_with('|');

        let mut rows = Vec::new();
        let mut j = i + 2;
        while j < lines.len() {
            let t = trim(lines[j]);
            if !is_row_line(Some(lines[j])) {
                break;
            }
            if lead_pipe && !t.starts_with('|') {
                break;
            }
            if parse_align_row(Some(lines[j])).is_some() {
                break; // a second table starting
            }
            rows.push(split_cells(lines[j]));
            j += 1;
        }

        tables.push(MdTable {
            start: i,
            end: j - 1,
            indent,
            headers,
            aligns,
            rows,
        });
        i = j;
    }
    tables
}

/// The table made rectangular.
struct Normalized {
    n: usize,
    headers: Vec<String>,
    aligns: Vec<Option<Align>>,
    rows: Vec<Vec<String>>,
}

/// Rule 4: ragged rows are padded / truncated to the header width. Never fails.
fn normalize(headers: &[String], aligns: &[Option<Align>], rows: &[Vec<String>]) -> Normalized {
    let n = rows
        .iter()
        .map(Vec::len)
        .chain([headers.len(), aligns.len(), 1])
        .max()
        .unwrap_or(1);
    let fit = |r: &[String]| (0..n).map(|k| r.get(k).cloned().unwrap_or_default()).collect::<Vec<_>>();
    Normalized {
        n,
        headers: fit(headers),
        aligns: (0..n).map(|k| aligns.get(k).copied().flatten()).collect(),
        rows: rows.iter().map(|r| fit(r)).collect(),
    }
}

// ---------------------------------------------------------------------------
// Inline markdown handling (rule 1)
// ---------------------------------------------------------------------------

static MD_CODE: LazyLock<Regex> = LazyLock::new(|| re(r"`{1,3}([^`]+)`{1,3}"));
// `(\*\*\*|___)([\s\S]+?)\1`: the backreference written out as its two alternatives.
static MD_BOLD_ITALIC: LazyLock<Regex> = LazyLock::new(|| re(r"\*\*\*([\s\S]+?)\*\*\*|___([\s\S]+?)___"));
// `(\*\*|__)([\s\S]+?)\1`
static MD_BOLD: LazyLock<Regex> = LazyLock::new(|| re(r"\*\*([\s\S]+?)\*\*|__([\s\S]+?)__"));
static MD_STAR_ITALIC: LazyLock<Regex> = LazyLock::new(|| re(r"\*([^*\n]+?)\*"));
static MD_STRIKE: LazyLock<Regex> = LazyLock::new(|| re(r"~~([\s\S]+?)~~"));
static MD_LINK: LazyLock<Regex> = LazyLock::new(|| re(r"!?\[([^\]]*)\]\([^)]*\)"));
static MD_SPOILER: LazyLock<Regex> = LazyLock::new(|| re(r"\|\|([\s\S]+?)\|\|"));
static MD_ESCAPE: LazyLock<Regex> = LazyLock::new(|| re(r"\\([\\`*_{}[\]()#+\-.!|~>])"));

/// The text of whichever of the two alternatives matched.
fn either_group(c: &Captures) -> String {
    c.get(1).or_else(|| c.get(2)).map_or(String::new(), |g| g.as_str().to_string())
}

/// The JS `.replace(/(^|[^\w\\])_([^_\n]+?)_(?!\w)/g, "$1$2")`, matched by hand (the pattern needs a lookahead).
/// At each place, in the order the pattern tries them: the start of the text, or one character that is neither a
/// word character nor a backslash; then "_", text with no "_" or newline up to the next "_", and that "_" not
/// followed by a word character. The lazy `+?` can only ever stop at the first "_", so that is the one tried.
fn strip_underscore_italic(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    // The end of the match whose opening "_" is at `u`, and the text between the underscores.
    let close_after = |u: usize| -> Option<usize> {
        if chars.get(u) != Some(&'_') {
            return None;
        }
        let mut j = u + 1;
        while j < chars.len() && chars[j] != '_' && chars[j] != '\n' {
            j += 1;
        }
        let closes = j > u + 1 && chars.get(j) == Some(&'_') && chars.get(j + 1).is_none_or(|&c| !is_word(c));
        closes.then_some(j)
    };
    let mut out = String::new();
    let mut p = 0;
    while p < chars.len() {
        // (prefix kept, index of the opening "_", index of the closing "_")
        let found = if p == 0 {
            close_after(0).map(|j| (None, 0, j))
        } else {
            None
        }
        .or_else(|| {
            let c = chars[p];
            if is_word(c) || c == '\\' {
                return None;
            }
            close_after(p + 1).map(|j| (Some(c), p + 1, j))
        });
        match found {
            Some((prefix, u, j)) => {
                out.extend(prefix);
                out.extend(&chars[u + 1..j]);
                p = j + 1;
            }
            None => {
                out.push(chars[p]);
                p += 1;
            }
        }
    }
    out
}

/// Strip inline markdown for GRID mode.
/// WHY: inside a ``` fence Discord renders NOTHING — officially confirmed by the spoiler note in Markdown Text 101
/// ("negated by a code block"). So `**6.4h**` would print as literal asterisks AND, worse, the four extra characters
/// get counted when measuring the column, padding it 4 wide and misaligning everything after it. Strip first, then
/// measure.
pub fn strip_inline_md(s: &str) -> String {
    let s = MD_CODE.replace_all(s, "${1}"); // inline code
    let s = MD_BOLD_ITALIC.replace_all(&s, either_group); // bold-italic
    let s = MD_BOLD.replace_all(&s, either_group); // bold / underline
    let s = MD_STAR_ITALIC.replace_all(&s, "${1}"); // *italic*
    // _italic_ only when the underscores are NOT inside a word — otherwise this eats snake_case, and identifiers are
    // exactly what shows up in Tarsee's tables (column names, env vars, file paths).
    let s = strip_underscore_italic(&s);
    let s = MD_STRIKE.replace_all(&s, "${1}"); // strikethrough
    // links -> text only; the URL isn't clickable in a fence and blows the width
    let s = MD_LINK.replace_all(&s, "${1}");
    let s = MD_SPOILER.replace_all(&s, "${1}"); // spoilers
    // unescape: a fence is already literal, so a stray "\" would SHOW
    let s = MD_ESCAPE.replace_all(&s, "${1}");
    let s = WS_RUN.replace_all(&s, " ");
    trim(&s).to_string()
}

/// Normalize a cell for LIST mode, where markdown DOES render. We keep emphasis (a `**6.4h**` cell should stay bold)
/// and keep `\|` ESCAPED — WHY: unescaping could produce `||text||`, which Discord reads as a spoiler and hides the
/// cell. A backslash-escaped pipe displays as a plain "|" and is inert.
fn normalize_inline_md(s: &str) -> String {
    trim(&WS_RUN.replace_all(s, " ")).to_string()
}

/// Values that mean "no data" and should be dropped from list mode.
static EMPTY_CELL: LazyLock<Regex> = LazyLock::new(|| re(r"^(|-|–|—|n\/a|N\/A|null|none|TBD)$"));

// ---------------------------------------------------------------------------
// Renderer (a): space-aligned grid inside a fence
// ---------------------------------------------------------------------------

/// A column of pure numbers reads far better right-aligned.
static NUMERIC: LazyLock<Regex> =
    LazyLock::new(|| re(r"^[-+±~<>]?\s*[$€£¥]?\d[\d,._]*\s*(%|[a-zA-Z]{1,3})?$"));

/// The grid [`to_ascii_grid`] draws: its lines (no fence) and its widest line in display columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsciiGrid {
    pub lines: Vec<String>,
    pub width: usize,
}

/// Build the aligned grid (no fence). Exported so other plain-text channels can share it.
pub fn to_ascii_grid(headers: &[String], aligns: &[Option<Align>], rows: &[Vec<String>]) -> AsciiGrid {
    let g = normalize(headers, aligns, rows);
    let h: Vec<String> = g.headers.iter().map(|c| strip_inline_md(c)).collect();
    let r: Vec<Vec<String>> = g
        .rows
        .iter()
        .map(|row| row.iter().map(|c| strip_inline_md(c)).collect())
        .collect();

    let widths: Vec<usize> = (0..g.n)
        .map(|c| {
            r.iter()
                .map(|row| display_width(&row[c]))
                .chain([display_width(&h[c]), 0])
                .max()
                .unwrap_or(0)
        })
        .collect();

    // Explicit alignment from the separator row wins; otherwise auto-right-align all-numeric columns (research:
    // "numbers right-aligned").
    let align: Vec<Align> = (0..g.n)
        .map(|c| {
            if let Some(a) = g.aligns[c] {
                return a;
            }
            let vals: Vec<&String> = r.iter().map(|row| &row[c]).filter(|v| !v.is_empty()).collect();
            if !vals.is_empty() && vals.iter().all(|v| NUMERIC.is_match(v)) {
                Align::Right
            } else {
                Align::Left
            }
        })
        .collect();

    // Drop columns that are entirely empty — a trailing `| |` header (a common model habit) otherwise burns width on
    // nothing.
    let keep: Vec<usize> = (0..g.n).filter(|&c| widths[c] > 0).collect();

    // trimEnd(): trailing pad on the last column is invisible but costs bytes against the 2000-char cap, and makes a
    // stray copy-paste look ragged.
    let line = |cells: &[String]| {
        let joined: String = keep
            .iter()
            .enumerate()
            .map(|(k, &c)| {
                let gap = if k < keep.len() - 1 { COL_GAP } else { "" };
                format!("{}{gap}", pad_to(&cells[c], widths[c], align[c]))
            })
            .collect();
        trim_end(&joined).to_string()
    };

    let mut out = vec![line(&h)];
    // A dash rule beats ANSI color for the header cue: ```ansi is desktop-only (stripped on mobile) and each escape
    // costs 7-12 chars of budget.
    let rule: String = keep
        .iter()
        .enumerate()
        .map(|(k, &c)| format!("{}{}", "-".repeat(widths[c]), if k < keep.len() - 1 { COL_GAP } else { "" }))
        .collect();
    out.push(trim_end(&rule).to_string());
    for row in &r {
        out.push(line(row));
    }

    let width = out.iter().map(|l| display_width(l)).max().unwrap_or(0);
    AsciiGrid { lines: out, width }
}

static BACKTICK_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new("`+").expect("the backtick pattern"));

/// Wrap grid lines in a fence, choosing a fence longer than any backtick run in the content. WHY: a cell containing
/// ``` would otherwise close our fence early and dump the rest of the table as raw pipes.
fn fence(lines: &[String]) -> String {
    let body = lines.join("\n");
    let longest = BACKTICK_RUN.find_iter(&body).map(|m| m.len()).max().unwrap_or(0);
    let f = "`".repeat(3.max(longest + 1));
    format!("{f}\n{body}\n{f}")
}

// ---------------------------------------------------------------------------
// Renderer (b): one line per row
// ---------------------------------------------------------------------------

/// Before/after column pairs get a "→" instead of the "·" separator.
/// WHY a special case at all: a before/after delta is THE most common shape in Tarsee's own reports (workload
/// rebalances, budget diffs) and "Before 37.2h → After 6.4h" reads as a transition where "Before 37.2h · After 6.4h"
/// reads as two unrelated facts. Narrow, header-name-driven, and easy to delete.
static TRANSITION_FROM: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?i-u:before|from|was|old|prev(?:ious)?|start)$"));
static TRANSITION_TO: LazyLock<Regex> = LazyLock::new(|| re(r"^(?i-u:after|to|now|new|current|end)$"));
static PRE_BOLDED: LazyLock<Regex> = LazyLock::new(|| re(r"^\*\*([\s\S]*)\*\*$"));

/// Render rows as readable lines. Exported for reuse by channels that draw in a proportional font with no monospace
/// option, where padded ASCII is a REGRESSION (a grid there looks worse than raw pipes). `bullet` goes in front of
/// every line that has more than its label ("" for none).
pub fn to_labeled_lines(headers: &[String], aligns: &[Option<Align>], rows: &[Vec<String>], bullet: &str) -> Vec<String> {
    let g = normalize(headers, aligns, rows);
    // Headers are labels, not data — strip emphasis so we don't emit "**Before** **6.4h**" and end up with a wall of
    // bold.
    let h: Vec<String> = g.headers.iter().map(|c| strip_inline_md(c)).collect();

    g.rows
        .iter()
        .map(|raw| {
            let cells: Vec<String> = raw.iter().map(|c| normalize_inline_md(c)).collect();
            let mut parts: Vec<(&str, String)> = Vec::new();

            // Column 0 is the row's identity -> bold it. Strip any existing bold first so a pre-bolded cell doesn't
            // become ****x****.
            let label = PRE_BOLDED.replace(&cells[0], "${1}").into_owned();
            let head = if label.is_empty() { String::new() } else { format!("**{label}**") };

            // The arrow must chain off the previously EMITTED header, not H[c-1]: if "Before" was dropped as no-data
            // there is no transition to draw, and "**Sat 1 Aug** → After 7.0h" would read as a lie.
            let mut last_header = "";
            for c in 1..g.n {
                let v = &cells[c];
                // Drop no-data cells: they add noise and "—" collides visually with the " — " tail separator.
                if EMPTY_CELL.is_match(&strip_inline_md(v)) {
                    continue;
                }
                let header = h[c].as_str();
                if header.is_empty() {
                    // headerless
                    parts.push((" — ", v.clone()));
                    last_header = "";
                    continue;
                }
                let sep = if TRANSITION_TO.is_match(header) && TRANSITION_FROM.is_match(last_header) {
                    " → "
                } else {
                    " · "
                };
                parts.push((sep, format!("{header} {v}")));
                last_header = header;
            }

            let mut s = head;
            for (sep, text) in &parts {
                s = if s.is_empty() { text.clone() } else { format!("{s}{sep}{text}") };
            }
            // Degenerate single-column table: emit a bullet, not a lone bold word.
            if parts.is_empty() && g.n == 1 {
                s = format!("- {label}");
            }
            if !bullet.is_empty() && !parts.is_empty() { format!("{bullet}{s}") } else { s }
        })
        .filter(|line| !line.is_empty())
        .collect()
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Rewrite every markdown table in `text` for Discord. Everything else is returned byte-identical.
///
/// Idempotent (rule 8): grid output is a fenced block, which pass 2 masks and skips; list output has no alignment
/// separator row, so pass 2 doesn't recognize it as a table at all.
pub fn format_tables_for_discord(text: &str) -> String {
    if !text.contains('|') {
        return text.to_string();
    }

    let (masked, blocks) = mask_fences(text);
    let tables = parse_md_tables(&masked);
    if tables.is_empty() {
        return text.to_string();
    }

    let lines: Vec<&str> = masked.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut cursor = 0;

    for t in &tables {
        out.extend(lines[cursor..t.start].iter().map(|l| l.to_string()));

        let grid = to_ascii_grid(&t.headers, &t.aligns, &t.rows);
        let fenced = fence(&grid.lines);

        // Mode choice: grid only if it fits a phone AND survives as one message.
        let use_grid = grid.width <= MAX_GRID_WIDTH
            && utf16_len(&fenced) + utf16_len(&t.indent) * grid.lines.len() <= MAX_FENCED_CHARS;

        let rendered: Vec<String> = if use_grid {
            fenced.split('\n').map(str::to_string).collect()
        } else {
            to_labeled_lines(&t.headers, &t.aligns, &t.rows, "")
        };

        out.extend(
            rendered
                .into_iter()
                .map(|l| if l.is_empty() { l } else { format!("{}{l}", t.indent) }),
        );
        cursor = t.end + 1;
    }
    out.extend(lines[cursor..].iter().map(|l| l.to_string()));

    unmask_fences(&out.join("\n"), &blocks)
}

// ---------------------------------------------------------------------------
// Block quotes
// ---------------------------------------------------------------------------

/// An empty quoted line Discord will draw: "> " plus a zero-width space (a bare ">" shows as a literal ">").
pub const DISCORD_EMPTY_QUOTE_LINE: &str = "> \u{200b}";

static BARE_QUOTE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*>\s*$"));
static BARE_QUOTE_TAIL: LazyLock<Regex> = LazyLock::new(|| re(r">\s*$"));

fn bare(line: &str) -> bool {
    BARE_QUOTE.is_match(line)
}

/// `/^\s*>(?!>>)/.test(line)`: a ">" after the leading whitespace, not the first of ">>>".
fn starts_quote(line: &str) -> bool {
    js_text::trim_start(line)
        .strip_prefix('>')
        .is_some_and(|rest| !rest.starts_with(">>"))
}

fn quoted(line: &str) -> bool {
    starts_quote(line) && !bare(line) && !line.contains(MASK_OPEN)
}

/// `line.replace(/^(\s*)>(?=[^\s>])/, "$1> ")`: the missing space after a leading ">".
fn space_after_quote_mark(line: &str) -> String {
    let rest = js_text::trim_start(line);
    let indent = &line[..line.len() - rest.len()];
    match rest.strip_prefix('>') {
        Some(after) if after.chars().next().is_some_and(|c| !js_text::is_ws(c) && c != '>') => {
            format!("{indent}> {after}")
        }
        _ => line.to_string(),
    }
}

/// Markdown quotes as Discord draws them (the owner, 27 Oct 2026: "on discord fix this '>' thing"). Discord only
/// quotes a line that starts with "> " and has something after it, so:
///  - a bare ">" between two quoted lines (a paragraph break inside a quote) becomes an empty quoted line, so the
///    paragraphs stay apart;
///  - a bare ">" at the start or end of a quote is dropped;
///  - ">text" gets its missing space.
///
/// A ">" on a line of its own away from any quote is left alone, as are ">>>" quotes and everything inside code
/// fences. Idempotent.
pub fn format_quotes_for_discord(text: &str) -> String {
    if !text.contains('>') {
        return text.to_string();
    }
    let (masked, blocks) = mask_fences(text);
    let lines: Vec<&str> = masked.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    for (i, &line) in lines.iter().enumerate() {
        if bare(line) {
            let before = lines[..i].iter().rev().find(|l| !bare(l)).is_some_and(|l| quoted(l));
            let after = lines[i + 1..].iter().find(|l| !bare(l)).is_some_and(|l| quoted(l));
            if before && after {
                // one per run
                if !(i > 0 && bare(lines[i - 1])) {
                    out.push(BARE_QUOTE_TAIL.replace(line, DISCORD_EMPTY_QUOTE_LINE).into_owned());
                }
            } else if !before && !after {
                out.push(line.to_string());
            }
            continue;
        }
        out.push(if quoted(line) { space_after_quote_mark(line) } else { line.to_string() });
    }
    unmask_fences(&out.join("\n"), &blocks)
}

/// Everything Discord-specific a reply needs before it is split and sent: tables, then quotes.
pub fn format_for_discord(text: &str) -> String {
    format_quotes_for_discord(&format_tables_for_discord(text))
}

// ---------------------------------------------------------------------------
// Fence-safe splitting
// ---------------------------------------------------------------------------

/// The fence a chunk is inside: its marker and the info string after it (the language tag).
struct OpenFence {
    marker: String,
    info: String,
}

/// Whether a chunk has anything but fence lines and whitespace in it (the JS
/// `c.replace(/^\s*(`{3,}|~{3,}).*$/gm, "").trim().length > 0`): a line, as JavaScript's `m` flag splits lines, with
/// text on it that is not a fence.
fn has_content(chunk: &str) -> bool {
    chunk.split(js_text::is_line_terminator).any(|line| {
        let t = js_text::trim_start(line);
        !t.is_empty() && !t.starts_with("```") && !t.starts_with("~~~")
    })
}

/// Drop-in replacement for splitMessage() that never emits an unbalanced fence. `max_len` counts UTF-16 units, as
/// Discord's 2000 does.
///
/// WHY this is required, not optional: the old splitMessage in src/channels/discord.js was completely fence-blind.
/// Measured on a 7020-char message containing one fenced table it produced 4 chunks with fence counts [1, 0, 0, 1] —
/// chunk 0 opens a fence and never closes it, chunks 1-2 are bare pipes with no fence, chunk 3's stray ``` opens a
/// NEW one. It can also cleave the ``` marker itself mid-token. Since this module makes fenced output *more* common,
/// shipping the formatter without this fix would make table rendering worse, not better.
///
/// Also fixes two adjacent bugs in the original:
///  - continuation chunks no longer start with a stray leading "\n"
///  - hard cuts happen on code-point boundaries, so an astral char (😀) can't be split into lone surrogates
pub fn split_message_fence_safe(text: &str, max_len: usize) -> Vec<String> {
    if utf16_len(text) <= max_len {
        return vec![text.to_string()];
    }
    let max = max_len as i64;

    let mut chunks: Vec<String> = Vec::new();
    // lines accumulated for the current chunk, and the sum of their UTF-16 lengths
    let mut buf: Vec<String> = Vec::new();
    let mut buf_units: i64 = 0;
    // while inside a fence
    let mut open_fence: Option<OpenFence> = None;

    // `buf.join("\n").length`
    let joined_len = |buf: &Vec<String>, units: i64| if buf.is_empty() { 0 } else { units + buf.len() as i64 - 1 };
    let reopen_line = |f: &Option<OpenFence>| f.as_ref().map_or(String::new(), |f| format!("{}{}", f.marker, f.info));
    // Chars a chunk must keep free so its closing fence always fits.
    let reserve = |f: &Option<OpenFence>| f.as_ref().map_or(0, |f| f.marker.len() as i64 + 1);

    let flush = |buf: &mut Vec<String>, units: &mut i64, chunks: &mut Vec<String>, open: &Option<OpenFence>| {
        if buf.is_empty() {
            return;
        }
        // Close the fence at the chunk boundary…
        if let Some(f) = open {
            buf.push(f.marker.clone());
        }
        chunks.push(buf.join("\n"));
        buf.clear();
        *units = 0;
        // …and re-open it (same marker AND same language tag) in the next chunk, so highlighting and monospace carry
        // over instead of the remainder rendering as bare pipes.
        if open.is_some() {
            let line = reopen_line(open);
            *units = utf16_len(&line) as i64;
            buf.push(line);
        }
    };

    for raw_line in text.split('\n') {
        // Read the fence marker BEFORE deciding where to cut: the state at the moment of the cut is what determines
        // whether we owe a closing fence.
        let m = fence_of(raw_line);

        // Hard-split a single over-long line, on CODE POINTS, so an astral char can never be cleaved into lone
        // surrogates — the original splitMessage's `slice(0, maxLen)` does exactly that and Discord renders U+FFFD
        // or rejects the message. (A piece is `budget` code points, as in the Node code, which can be more than
        // `budget` UTF-16 units.)
        let budget = max
            - reserve(&open_fence)
            - if open_fence.is_some() { utf16_len(&reopen_line(&open_fence)) as i64 + 1 } else { 0 };
        let pieces: Vec<String> = if (utf16_len(raw_line) as i64) > budget {
            // A budget of zero or less made the Node code loop for ever; one code point at a time ends.
            let per = budget.max(1) as usize;
            let cps: Vec<char> = raw_line.chars().collect();
            cps.chunks(per).map(|c| c.iter().collect()).collect()
        } else {
            vec![raw_line.to_string()]
        };

        for piece in pieces {
            // +1 for the "\n" that joining will add. Note we never carry the newline INTO the next chunk, which is why
            // continuation chunks don't start with a blank line the way splitMessage's do.
            // A line that opens a fence owes its closing fence too, should the next line not fit.
            let need = if open_fence.is_some() {
                reserve(&open_fence)
            } else {
                m.as_ref().map_or(0, |m| m.marker.len() as i64 + 1)
            };
            let piece_units = utf16_len(&piece) as i64;
            if !buf.is_empty() && joined_len(&buf, buf_units) + 1 + piece_units > max - need {
                flush(&mut buf, &mut buf_units, &mut chunks, &open_fence);
            }
            buf_units += piece_units;
            buf.push(piece);
        }

        if let Some(m) = &m {
            match &open_fence {
                None => {
                    open_fence = Some(OpenFence {
                        marker: m.marker.to_string(),
                        info: m.rest.to_string(),
                    })
                }
                Some(f) => {
                    if m.marker.chars().next() == f.marker.chars().next()
                        && m.marker.len() >= f.marker.len()
                        && trim(m.rest).is_empty()
                    {
                        open_fence = None;
                    }
                }
            }
        }
    }
    if !buf.is_empty() {
        if let Some(f) = &open_fence {
            buf.push(f.marker.clone()); // input had a dangling fence
        }
        chunks.push(buf.join("\n"));
    }

    // A chunk that is nothing but a re-opened + closed fence carries no content; dropping it avoids posting an empty
    // black box.
    chunks.into_iter().filter(|c| has_content(c)).collect()
}

#[cfg(test)]
mod tests;
