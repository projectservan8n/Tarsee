/**
 * discord-format.js — turn GitHub-flavored markdown tables and block quotes
 * into something Discord actually renders, plus a fence-aware message splitter.
 * Ported from TarseeMacOS.
 *
 * WHY this exists: Discord has never supported markdown tables (verified
 * 2026-07-28 against Markdown Text 101 and the full dev changelog). A raw
 * `| a | b |` ships as literal pipes AND the `*`/`_`/`~` inside cells still
 * get parsed as emphasis, so the row is mangled on top of looking broken.
 * Asking the model not to emit tables is a soft prompt and it leaks; this is
 * the code-level enforcement.
 *
 * Two output modes, chosen automatically:
 *   (a) NARROW  -> fenced code block, space-aligned columns.
 *   (b) WIDE    -> one line per row, label-value style.
 *
 * WHY a width cutoff instead of always using a code block: Discord desktop
 * code blocks WRAP (white-space: pre-wrap) — they do NOT get a horizontal
 * scrollbar (feature request open since 2018, never shipped). So an over-wide
 * grid doesn't degrade to "swipe sideways", it degrades to soft-wrapped lines
 * with the column alignment destroyed, which is strictly worse than prose.
 * The binding surface is a phone: ~300-330px of content column at ~13-14px
 * monospace = roughly 38-45 columns. 40 is the width that never wraps
 * anywhere, so that's the threshold.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max rendered grid width (display columns) that still fits a phone. */
export const MAX_GRID_WIDTH = 40;

/**
 * If a fenced grid would exceed this many characters we fall back to list
 * mode. WHY: a fence longer than one Discord message has to be split, and
 * splitting a fence is exactly the thing that corrupts it (see
 * splitMessageFenceSafe). List mode has no fence, so it splits cleanly at any
 * line boundary. Preferring an ugly-but-intact list over a shredded grid is
 * the right trade. 1900 leaves headroom under the 2000 hard cap for the
 * surrounding prose in the same message.
 */
export const MAX_FENCED_CHARS = 1900;

/** Gap between columns in the grid. Two spaces reads as a column break. */
const COL_GAP = "  ";

// ---------------------------------------------------------------------------
// Display width — naive .length lies about emoji and CJK
// ---------------------------------------------------------------------------

/**
 * Code points that occupy 2 monospace columns. Ranges are deliberately
 * conservative: we'd rather under-pad a rare glyph than over-pad every arrow
 * and em dash (U+2192 and U+2014 are width 1 and are extremely common in
 * model output).
 */
const WIDE_RANGES = [
  [0x1100, 0x115f],   // Hangul Jamo
  [0x2e80, 0x303e],   // CJK radicals, Kangxi, CJK symbols/punctuation
  [0x3041, 0x33ff],   // Hiragana, Katakana, Bopomofo, CJK compat
  [0x3400, 0x4dbf],   // CJK Ext A
  [0x4e00, 0x9fff],   // CJK Unified
  [0xa000, 0xa4cf],   // Yi
  [0xa960, 0xa97f],   // Hangul Jamo Ext A
  [0xac00, 0xd7a3],   // Hangul syllables
  [0xf900, 0xfaff],   // CJK compat ideographs
  [0xfe10, 0xfe19],   // vertical forms
  [0xfe30, 0xfe6f],   // CJK compat forms
  [0xff00, 0xff60],   // fullwidth forms
  [0xffe0, 0xffe6],   // fullwidth signs
  [0x1f300, 0x1f64f], // misc symbols & pictographs, emoticons
  [0x1f680, 0x1f6ff], // transport
  [0x1f900, 0x1f9ff], // supplemental symbols & pictographs
  [0x1fa70, 0x1faff], // symbols & pictographs extended-A
  [0x20000, 0x2fffd], // CJK Ext B+
  [0x30000, 0x3fffd],
];

/**
 * Ambiguous-width block (dingbats, misc symbols: ✅ ⚠ ☀ ✈ …). These render
 * narrow as plain text but WIDE when followed by VS16 (U+FE0F), which is how
 * models emit them as emoji. So width here depends on the next code point.
 */
const AMBIGUOUS_EMOJI = [
  [0x2190, 0x21ff], [0x2300, 0x23ff], [0x25a0, 0x27bf],
  [0x2b00, 0x2bff], [0x2934, 0x2935],
];

/**
 * The subset of that block with Emoji_Presentation=Yes — always wide, VS16 or
 * not. ✅ ❌ ⚡ ⭐ are extremely common in model status columns, so getting
 * these wrong misaligns the most-used table shape in Tarsee.
 */
const DEFAULT_EMOJI = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
];

const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Code points that add no width of their own (they compose onto a base). */
function isZeroWidth(cp) {
  return (
    cp === 0x200b || cp === 0x200d || cp === 0xfeff ||  // ZWSP / ZWJ / BOM
    (cp >= 0xfe00 && cp <= 0xfe0f) ||                   // variation selectors
    (cp >= 0x0300 && cp <= 0x036f) ||                   // combining diacriticals
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||                   // combining for symbols
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||                 // skin-tone modifiers
    (cp >= 0xe0100 && cp <= 0xe01ef)                    // VS supplement
  );
}

/**
 * Monospace display width of a string, in columns.
 * WHY not str.length: "🇦🇺" is length 4, "日" is length 1 but 2 columns wide,
 * and a ZWJ family emoji is length 11. padEnd() on .length misaligns every
 * column to the right of any such cell.
 */
export function displayWidth(str) {
  const cps = Array.from(String(str ?? ""));
  let w = 0;
  // A ZWJ fuses the NEXT glyph into the previous one (👨‍👩‍👧 is one 2-col
  // glyph, not three). Without this a family emoji measures 6 and every column
  // to its right shifts.
  let joinPending = false;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i].codePointAt(0);
    if (cp === 0x200d) { joinPending = true; continue; }
    if (isZeroWidth(cp)) continue;
    if (joinPending) { joinPending = false; continue; }
    if (inRanges(cp, WIDE_RANGES) || inRanges(cp, DEFAULT_EMOJI)) { w += 2; continue; }
    // Emoji presentation selector promotes an ambiguous glyph to 2 columns.
    if (inRanges(cp, AMBIGUOUS_EMOJI)) {
      w += cps[i + 1]?.codePointAt(0) === 0xfe0f ? 2 : 1;
      continue;
    }
    w += 1;
  }
  return w;
}

/** Pad `s` to `width` display columns. align: "left" | "right" | "center". */
function padTo(s, width, align = "left") {
  const pad = Math.max(0, width - displayWidth(s));
  if (align === "right") return " ".repeat(pad) + s;
  if (align === "center") {
    const l = Math.floor(pad / 2);
    return " ".repeat(l) + s + " ".repeat(pad - l);
  }
  return s + " ".repeat(pad);
}

// ---------------------------------------------------------------------------
// Fence masking — rule 2: never touch a table already inside a code block
// ---------------------------------------------------------------------------

// U+0000 can't appear in model text and survives .split("\n"), so it makes a
// collision-proof placeholder sentinel.
const MASK_OPEN = "\u0000MDT";
const MASK_CLOSE = "\u0000";

/**
 * Replace every fenced code block with an opaque placeholder.
 * Handles ``` and ~~~, any fence length >= 3, leading indentation, and an
 * UNCLOSED fence (masks to end of text — an unterminated fence means
 * everything after it is code as far as Discord is concerned).
 *
 * This is also what makes the transform idempotent for narrow mode: our own
 * output is a fenced block, so a second pass masks it and walks past.
 */
function maskFences(text) {
  const lines = text.split("\n");
  const blocks = [];
  const out = [];
  let open = null;      // { marker, indent }
  let buf = [];

  const fenceOf = (line) => {
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    return m ? { indent: m[1], marker: m[2], rest: m[3] } : null;
  };

  for (const line of lines) {
    const f = fenceOf(line);
    if (!open) {
      if (f) { open = f; buf = [line]; } else out.push(line);
      continue;
    }
    buf.push(line);
    // A closing fence is the same char, at least as long, with nothing after.
    const isClose =
      f && f.marker[0] === open.marker[0] &&
      f.marker.length >= open.marker.length && f.rest.trim() === "";
    if (isClose) {
      blocks.push(buf.join("\n"));
      out.push(`${MASK_OPEN}${blocks.length - 1}${MASK_CLOSE}`);
      open = null; buf = [];
    }
  }
  if (open) {                       // unterminated fence: mask the remainder
    blocks.push(buf.join("\n"));
    out.push(`${MASK_OPEN}${blocks.length - 1}${MASK_CLOSE}`);
  }
  return { masked: out.join("\n"), blocks };
}

function unmaskFences(text, blocks) {
  return text.replace(
    // eslint-disable-next-line no-control-regex -- U+0000 is this module's own fence placeholder (MASK_OPEN)
    /\u0000MDT(\d+)\u0000/g,
    (_, i) => blocks[Number(i)] ?? ""
  );
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Split a table row into cells, honoring backslash-escaped pipes (rule 3).
 * The `\|` is left ESCAPED in the returned cell — each render mode decides
 * whether to unescape, because the answer differs (see renderers).
 */
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  // Only strip a trailing pipe if it isn't itself escaped.
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);

  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** A plausible table row: has at least one unescaped pipe. */
function isRowLine(line) {
  if (line == null) return false;
  const t = line.trim();
  if (!t) return false;
  return /(^|[^\\])\|/.test(t);
}

/** Alignment separator row: every cell is `---`, `:--`, `--:` or `:-:`. */
function parseAlignRow(line) {
  if (!isRowLine(line)) return null;
  const cells = splitCells(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const c of cells) {
    const m = /^(:?)-{1,}(:?)$/.exec(c.replace(/\s+/g, ""));
    if (!m) return null;
    aligns.push(m[1] && m[2] ? "center" : m[2] ? "right" : m[1] ? "left" : null);
  }
  return aligns;
}

/**
 * Find every GFM table in `text` (fences already masked out).
 * Returns [{ start, end, indent, headers, aligns, rows }] with line indices.
 *
 * A table is: a row line, then an alignment row with a matching-ish cell
 * count, then zero or more row lines. Requiring the alignment row is what
 * keeps us from eating prose that happens to contain a pipe — and it's what
 * makes list-mode output (which contains no alignment row) idempotent.
 */
export function parseMdTables(text) {
  const lines = text.split("\n");
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!isRowLine(lines[i])) continue;
    const aligns = parseAlignRow(lines[i + 1]);
    if (!aligns) continue;

    const headers = splitCells(lines[i]);
    // GFM requires the counts to match; be lenient (models miscount) but
    // reject wild mismatches, which are almost always coincidence.
    if (Math.abs(headers.length - aligns.length) > 1) continue;

    const indent = /^(\s*)/.exec(lines[i])[1];
    // If the header used a leading pipe, body rows must too — stops a
    // following paragraph containing "a | b" from being swallowed.
    const leadPipe = lines[i].trim().startsWith("|");

    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!isRowLine(lines[j])) break;
      if (leadPipe && !t.startsWith("|")) break;
      if (parseAlignRow(lines[j])) break;   // a second table starting
      rows.push(splitCells(lines[j]));
    }

    tables.push({ start: i, end: j - 1, indent, headers, aligns, rows });
    i = j - 1;
  }
  return tables;
}

/** Rule 4: ragged rows are padded / truncated to the header width. Never throws. */
function normalize(headers, aligns, rows) {
  const n = Math.max(
    headers.length,
    aligns.length,
    ...rows.map(r => r.length),
    1
  );
  const fit = (r) => Array.from({ length: n }, (_, k) => r[k] ?? "");
  return { n, headers: fit(headers), aligns: fit(aligns), rows: rows.map(fit) };
}

// ---------------------------------------------------------------------------
// Inline markdown handling (rule 1)
// ---------------------------------------------------------------------------

/**
 * Strip inline markdown for GRID mode.
 * WHY: inside a ``` fence Discord renders NOTHING — officially confirmed by
 * the spoiler note in Markdown Text 101 ("negated by a code block"). So
 * `**6.4h**` would print as literal asterisks AND, worse, the four extra
 * characters get counted when measuring the column, padding it 4 wide and
 * misaligning everything after it. Strip first, then measure.
 */
export function stripInlineMd(s) {
  return String(s ?? "")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")          // inline code
    .replace(/(\*\*\*|___)([\s\S]+?)\1/g, "$2")     // bold-italic
    .replace(/(\*\*|__)([\s\S]+?)\1/g, "$2")        // bold / underline
    .replace(/\*([^*\n]+?)\*/g, "$1")               // *italic*
    // _italic_ only when the underscores are NOT inside a word — otherwise
    // this eats snake_case, and identifiers are exactly what shows up in
    // Tarsee's tables (column names, env vars, file paths).
    .replace(/(^|[^\w\\])_([^_\n]+?)_(?!\w)/g, "$1$2")
    .replace(/~~([\s\S]+?)~~/g, "$1")               // strikethrough
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")      // links -> text only; the
                                                    // URL isn't clickable in a
                                                    // fence and blows the width
    .replace(/\|\|([\s\S]+?)\|\|/g, "$1")           // spoilers
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")  // unescape: a fence is
                                                    // already literal, so a
                                                    // stray "\" would SHOW
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a cell for LIST mode, where markdown DOES render.
 * We keep emphasis (a `**6.4h**` cell should stay bold) and keep `\|`
 * ESCAPED — WHY: unescaping could produce `||text||`, which Discord reads as
 * a spoiler and hides the cell. A backslash-escaped pipe displays as a plain
 * "|" and is inert.
 */
function normalizeInlineMd(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** Values that mean "no data" and should be dropped from list mode. */
const EMPTY_CELL = /^(|-|–|—|n\/a|N\/A|null|none|TBD)$/;

// ---------------------------------------------------------------------------
// Renderer (a): space-aligned grid inside a fence
// ---------------------------------------------------------------------------

/** A column of pure numbers reads far better right-aligned. */
const NUMERIC = /^[-+±~<>]?\s*[$€£¥]?\d[\d,._]*\s*(%|[a-zA-Z]{1,3})?$/;

/**
 * Build the aligned grid (no fence). Exported so other plain-text channels can
 * share it.
 */
export function toAsciiGrid(headers, aligns, rows) {
  const g = normalize(headers, aligns, rows);
  const H = g.headers.map(stripInlineMd);
  const R = g.rows.map(r => r.map(stripInlineMd));

  const widths = Array.from({ length: g.n }, (_, c) =>
    Math.max(displayWidth(H[c]), ...R.map(r => displayWidth(r[c])), 0)
  );

  // Explicit alignment from the separator row wins; otherwise auto-right-align
  // all-numeric columns (research: "numbers right-aligned").
  const align = Array.from({ length: g.n }, (_, c) => {
    if (g.aligns[c]) return g.aligns[c];
    const vals = R.map(r => r[c]).filter(v => v !== "");
    return vals.length && vals.every(v => NUMERIC.test(v)) ? "right" : "left";
  });

  // Drop columns that are entirely empty — a trailing `| |` header (a common
  // model habit) otherwise burns width on nothing.
  const keep = [];
  for (let c = 0; c < g.n; c++) if (widths[c] > 0) keep.push(c);

  // trimEnd(): trailing pad on the last column is invisible but costs bytes
  // against the 2000-char cap, and makes a stray copy-paste look ragged.
  const line = (cells) =>
    keep.map((c, k) => padTo(cells[c], widths[c], align[c]) + (k < keep.length - 1 ? COL_GAP : ""))
      .join("").trimEnd();

  const out = [line(H)];
  // A dash rule beats ANSI color for the header cue: ```ansi is desktop-only
  // (stripped on mobile) and each escape costs 7-12 chars of budget.
  out.push(keep.map((c, k) => "-".repeat(widths[c]) + (k < keep.length - 1 ? COL_GAP : "")).join("").trimEnd());
  for (const r of R) out.push(line(r));

  const width = Math.max(...out.map(displayWidth));
  return { lines: out, width };
}

/**
 * Wrap grid lines in a fence, choosing a fence longer than any backtick run
 * in the content. WHY: a cell containing ``` would otherwise close our fence
 * early and dump the rest of the table as raw pipes.
 */
function fence(lines) {
  const body = lines.join("\n");
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(s => s.length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}\n${body}\n${f}`;
}

// ---------------------------------------------------------------------------
// Renderer (b): one line per row
// ---------------------------------------------------------------------------

/**
 * Before/after column pairs get a "→" instead of the "·" separator.
 * WHY a special case at all: a before/after delta is THE most common shape in
 * Tarsee's own reports (workload rebalances, budget diffs) and "Before 37.2h →
 * After 6.4h" reads as a transition where "Before 37.2h · After 6.4h" reads as
 * two unrelated facts. Narrow, header-name-driven, and easy to delete.
 */
const TRANSITION_FROM = /^(before|from|was|old|prev(ious)?|start)$/i;
const TRANSITION_TO = /^(after|to|now|new|current|end)$/i;

/**
 * Render rows as readable lines. Exported for reuse by channels that draw in
 * a proportional font with no monospace option, where padded ASCII is a
 * REGRESSION (a grid there looks worse than raw pipes).
 */
export function toLabeledLines(headers, aligns, rows, { bullet = "" } = {}) {
  const g = normalize(headers, aligns, rows);
  // Headers are labels, not data — strip emphasis so we don't emit "**Before**
  // **6.4h**" and end up with a wall of bold.
  const H = g.headers.map(stripInlineMd);

  return g.rows.map((raw) => {
    const cells = raw.map(normalizeInlineMd);
    const parts = [];

    // Column 0 is the row's identity -> bold it. Strip any existing bold
    // first so a pre-bolded cell doesn't become ****x****.
    const label = cells[0].replace(/^\*\*([\s\S]*)\*\*$/, "$1");
    let head = label ? `**${label}**` : "";

    // The arrow must chain off the previously EMITTED header, not H[c-1]:
    // if "Before" was dropped as no-data there is no transition to draw, and
    // "**Sat 1 Aug** → After 7.0h" would read as a lie.
    let lastHeader = "";
    for (let c = 1; c < g.n; c++) {
      const v = cells[c];
      // Drop no-data cells: they add noise and "—" collides visually with the
      // " — " tail separator.
      if (EMPTY_CELL.test(stripInlineMd(v))) continue;
      const h = H[c];
      if (!h) { parts.push({ sep: " — ", text: v }); lastHeader = ""; continue; }  // headerless
      const sep = TRANSITION_TO.test(h) && TRANSITION_FROM.test(lastHeader) ? " → " : " · ";
      parts.push({ sep, text: `${h} ${v}` });
      lastHeader = h;
    }

    let s = head;
    for (const p of parts) s = s ? s + p.sep + p.text : p.text;
    // Degenerate single-column table: emit a bullet, not a lone bold word.
    if (!parts.length && g.n === 1) s = `- ${label}`;
    return bullet && parts.length ? `${bullet}${s}` : s;
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Rewrite every markdown table in `text` for Discord. Everything else is
 * returned byte-identical.
 *
 * Idempotent (rule 8): grid output is a fenced block, which pass 2 masks and
 * skips; list output has no alignment separator row, so pass 2 doesn't
 * recognize it as a table at all.
 */
export function formatTablesForDiscord(text) {
  if (typeof text !== "string" || !text.includes("|")) return text;

  const { masked, blocks } = maskFences(text);
  const tables = parseMdTables(masked);
  if (!tables.length) return text;

  const lines = masked.split("\n");
  const out = [];
  let cursor = 0;

  for (const t of tables) {
    out.push(...lines.slice(cursor, t.start));

    const grid = toAsciiGrid(t.headers, t.aligns, t.rows);
    const fenced = fence(grid.lines);

    // Mode choice: grid only if it fits a phone AND survives as one message.
    const useGrid =
      grid.width <= MAX_GRID_WIDTH &&
      fenced.length + t.indent.length * grid.lines.length <= MAX_FENCED_CHARS;

    const rendered = useGrid
      ? fenced.split("\n")
      : toLabeledLines(t.headers, t.aligns, t.rows);

    out.push(...rendered.map(l => (l ? t.indent + l : l)));
    cursor = t.end + 1;
  }
  out.push(...lines.slice(cursor));

  return unmaskFences(out.join("\n"), blocks);
}

// ---------------------------------------------------------------------------
// Block quotes
// ---------------------------------------------------------------------------

/** An empty quoted line Discord will draw: "> " plus a zero-width space (a bare ">" shows as a literal ">"). */
export const DISCORD_EMPTY_QUOTE_LINE = "> \u200b";

/**
 * Markdown quotes as Discord draws them (the owner, 27 Oct 2026: "on discord
 * fix this '>' thing"). Discord only quotes a line that starts with "> " and
 * has something after it, so:
 *  - a bare ">" between two quoted lines (a paragraph break inside a quote)
 *    becomes an empty quoted line, so the paragraphs stay apart;
 *  - a bare ">" at the start or end of a quote is dropped;
 *  - ">text" gets its missing space.
 * A ">" on a line of its own away from any quote is left alone, as are
 * ">>>" quotes and everything inside code fences. Idempotent.
 */
export function formatQuotesForDiscord(text) {
  if (typeof text !== "string" || !text.includes(">")) return text;
  const { masked, blocks } = maskFences(text);
  const lines = masked.split("\n");
  const bare = (l) => /^\s*>\s*$/.test(l);
  const quoted = (l) => /^\s*>(?!>>)/.test(l) && !bare(l) && !l.includes(MASK_OPEN);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (bare(line)) {
      let p = i - 1; while (p >= 0 && bare(lines[p])) p--;
      let n = i + 1; while (n < lines.length && bare(lines[n])) n++;
      const before = p >= 0 && quoted(lines[p]);
      const after = n < lines.length && quoted(lines[n]);
      if (before && after) {
        if (!bare(lines[i - 1])) out.push(line.replace(/>\s*$/, DISCORD_EMPTY_QUOTE_LINE));   // one per run
      } else if (!before && !after) out.push(line);
      continue;
    }
    out.push(quoted(line) ? line.replace(/^(\s*)>(?=[^\s>])/, "$1> ") : line);
  }
  return unmaskFences(out.join("\n"), blocks);
}

/** Everything Discord-specific a reply needs before it is split and sent: tables, then quotes. */
export function formatForDiscord(text) {
  return formatQuotesForDiscord(formatTablesForDiscord(text));
}

// ---------------------------------------------------------------------------
// Fence-safe splitting
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for splitMessage() that never emits an unbalanced fence.
 *
 * WHY this is required, not optional: the old splitMessage in
 * src/channels/discord.js was completely fence-blind. Measured on a
 * 7020-char message containing one fenced table it produced 4 chunks with
 * fence counts [1, 0, 0, 1] — chunk 0 opens a fence and never closes it,
 * chunks 1-2 are bare pipes with no fence, chunk 3's stray ``` opens a NEW
 * one. It can also cleave the ``` marker itself mid-token. Since this module
 * makes fenced output *more* common, shipping the formatter without this fix
 * would make table rendering worse, not better.
 *
 * Also fixes two adjacent bugs in the original:
 *  - continuation chunks no longer start with a stray leading "\n"
 *  - hard cuts happen on code-point boundaries, so an astral char (😀) can't
 *    be split into lone surrogates
 */
export function splitMessageFenceSafe(text, maxLen = 2000) {
  const s = String(text ?? "");
  if (s.length <= maxLen) return [s];

  const chunks = [];
  let buf = [];            // lines accumulated for the current chunk
  let openFence = null;    // { marker, info } while inside a fence

  const joined = () => buf.join("\n");
  const reopenLine = () => (openFence ? openFence.marker + openFence.info : "");
  // Chars a chunk must keep free so its closing fence always fits.
  const reserve = () => (openFence ? openFence.marker.length + 1 : 0);

  const flush = () => {
    if (!buf.length) return;
    // Close the fence at the chunk boundary…
    if (openFence) buf.push(openFence.marker);
    chunks.push(joined());
    buf = [];
    // …and re-open it (same marker AND same language tag) in the next chunk,
    // so highlighting and monospace carry over instead of the remainder
    // rendering as bare pipes.
    if (openFence) buf.push(reopenLine());
  };

  for (const rawLine of s.split("\n")) {
    // Read the fence marker BEFORE deciding where to cut: the state at the
    // moment of the cut is what determines whether we owe a closing fence.
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(rawLine);

    // Hard-split a single over-long line. Array.from() iterates CODE POINTS,
    // so an astral char can never be cleaved into lone surrogates — the
    // original splitMessage's `slice(0, maxLen)` does exactly that and Discord
    // renders U+FFFD or rejects the message.
    const budget = maxLen - reserve() - (openFence ? reopenLine().length + 1 : 0);
    let pieces = [rawLine];
    if (rawLine.length > budget) {
      pieces = [];
      let cps = Array.from(rawLine);
      while (cps.length) { pieces.push(cps.slice(0, budget).join("")); cps = cps.slice(budget); }
    }

    for (const piece of pieces) {
      // +1 for the "\n" that joining will add. Note we never carry the
      // newline INTO the next chunk, which is why continuation chunks don't
      // start with a blank line the way splitMessage's do.
      if (buf.length && joined().length + 1 + piece.length > maxLen - reserve()) flush();
      buf.push(piece);
    }

    if (m) {
      if (!openFence) openFence = { marker: m[1], info: m[2] };
      else if (m[1][0] === openFence.marker[0] &&
               m[1].length >= openFence.marker.length &&
               m[2].trim() === "") openFence = null;
    }
  }
  if (buf.length) {
    if (openFence) buf.push(openFence.marker);   // input had a dangling fence
    chunks.push(joined());
  }

  // A chunk that is nothing but a re-opened + closed fence carries no content;
  // dropping it avoids posting an empty black box.
  return chunks.filter(c => c.replace(/^\s*(`{3,}|~{3,}).*$/gm, "").trim().length > 0);
}
