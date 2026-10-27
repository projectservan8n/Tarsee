/**
 * The chat's files: what kind each one is, which files a message's words point at, and the pure parts of showing them
 * in the viewer (a CSV as a table, JSON laid out, a sound's waveform as bars). No DOM, no network: the page's viewer
 * (file-viewer.js) and its cards (chat-files.js) use these, and so do the node tests (test/chat-files.test.js).
 * Ported from TarseeMacOS.
 */

export const EXT_KIND = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "avif"],
  video: ["mp4", "m4v", "mov", "webm", "ogv", "mkv", "3gp"],
  audio: ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"],
  pdf: ["pdf"],
  // Word, PowerPoint, Excel and OpenDocument: a card with Download (the browser can't show them).
  doc: ["doc", "docx", "docm", "dot", "dotx", "odt", "ott", "rtf", "ppt", "pptx", "pps", "ppsx", "odp", "xls", "xlsx", "xlsm", "ods"],
  text: ["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "yml", "yaml", "xml", "html", "htm", "svg", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh", "zsh", "sql", "ini", "toml", "env", "conf", "srt", "vtt", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "php", "lua", "diff", "patch", "tex"],
};

export const extOf = (name) => (/\.([a-z0-9]{1,8})$/i.exec(String(name || ""))?.[1] || "").toLowerCase();

/** image | video | audio | pdf | doc | text | other: from the file's name, or the name it has on disk when that says more. */
export function kindOf(f) {
  for (const n of [f?.name, f?.path]) {
    const ext = extOf(n);
    const kind = Object.keys(EXT_KIND).find((k) => EXT_KIND[k].includes(ext));
    if (kind) return kind;
  }
  return "other";
}

/** How a text file reads best: a table (csv, tsv), laid out (json), prose (txt, md) or code (the rest). */
export function textShape(name) {
  const ext = extOf(name);
  if (ext === "csv" || ext === "tsv") return ext;
  if (ext === "json") return "json";
  if (["txt", "md", "markdown", "log", "srt", "vtt", ""].includes(ext)) return "prose";
  return "code";
}

/** A file's name as the bots and the chat keep it on disk, without the time and number they put in front (lib/sent-files.js shownName). */
export const shownName = (p) => String(p || "").split("/").pop().replace(/^(chat|sent|discord|telegram|whatsapp|email)-\d+-(\d+-)?/, "") || "file";

/** A file kept on the server (in the uploads folder), as the viewer wants it: opened at GET /api/chat/file. */
export const serverFile = (f) => ({ name: f.name || shownName(f.path), size: f.size || 0, path: f.path, url: `/api/chat/file?p=${encodeURIComponent(f.path)}` });

/**
 * The notes the channels add to a message when someone sends a file ("[Attached file saved: a.csv (text/csv, 2KB) →
 * /path]", "[PDF attached: ...]", "[Email attachment saved: ...]", WhatsApp's "[PDF saved: ...]" and "[Video saved:
 * ...]") → the files, and the message without the notes. Paths in the uploads folder that a message names (the
 * agent saying where it put something) are files too; their words stay. The server decides what may be opened.
 */
export function splitNotes(body) {
  const files = [];
  const seen = new Set();
  const add = (name, p, size = 0) => { if (!seen.has(p)) { seen.add(p); files.push(serverFile({ name, path: p, size })); } };
  // The size the note gives ("text/csv, 2KB", "84KB"), near enough for a card.
  const sizeOf = (facts) => {
    const m = /(\d+(?:\.\d+)?)\s*(KB|MB|B)\b/i.exec(String(facts || ""));
    return m ? Math.round(Number(m[1]) * { b: 1, kb: 1024, mb: 1048576 }[m[2].toLowerCase()]) : 0;
  };
  let text = String(body || "")
    .replace(/\[(?:PDF attached|PDF saved|Attached file saved|Email attachment saved|Video attached|Video saved): ?([^\]\n]*?) → (\/[^\]\n]+)\]( — multimodal PDF block provided above; you can also Read this file directly at the path\.| You can read this file with the Read tool\.)?/g, (_m, label, p) => {
      const m = /^(.*?) ?(?:\(([^)]*)\))?$/.exec(label);
      add(m[1] || shownName(p), p, sizeOf(m[2]));
      return "";
    })
    .replace(/^You can read this file with the Read tool at: \/.*$/gm, "")
    .replace(/(?:\s*\[\+\d+ (?:media|files?|image\(s\))\])+\s*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  for (const m of text.matchAll(/(?:^|[\s(`'"])(\/[^\s`'"<>()]*\/uploads\/[^\s`'"<>()]+\.[A-Za-z0-9]{1,8})(?=$|[\s)`'".,;:!?])/g)) add(shownName(m[1]), m[1]);
  return { text, files };
}

/** A link in a message to one of the chat's files (/api/chat/file?p=) → the file to open in the viewer, or null. Anything else stays a link. */
export function fileLink(href, origin) {
  let u;
  try { u = new URL(href, origin); } catch { return null; }
  if (u.origin !== origin) return null;
  if (u.pathname === "/api/chat/file" && u.searchParams.get("p")) return serverFile({ path: u.searchParams.get("p") });
  return null;
}

/** Where the Download button points: the same file, sent to be saved. */
export const saveUrl = (f) => (f.file ? f.url : f.save || `${f.url}${f.url.includes("?") ? "&" : "?"}dl=1`);


/** What kind of file it is, in a word or two for a person ("PDF", "Word document", "Picture"). */
export function typeLabel(f) {
  const ext = extOf(f?.name) || extOf(f?.path);
  const named = { doc: "Word", docx: "Word", docm: "Word", dot: "Word", dotx: "Word", odt: "Document", ott: "Document", rtf: "Document",
    ppt: "PowerPoint", pptx: "PowerPoint", pps: "PowerPoint", ppsx: "PowerPoint", odp: "Slides", xls: "Excel", xlsx: "Excel", xlsm: "Excel", ods: "Spreadsheet",
    pdf: "PDF", csv: "CSV", md: "Markdown", txt: "Text", json: "JSON", zip: "ZIP" }[ext];
  if (named) return named;
  const kind = kindOf(f);
  if (kind === "image") return "Picture";
  if (kind === "video") return "Video";
  if (kind === "audio") return "Sound";
  if (kind === "text") return ext ? ext.toUpperCase() : "Text";
  return ext ? ext.toUpperCase() : "File";
}

/** Rows of a CSV (or with sep "\t", a TSV): quotes, doubled quotes and new lines inside quotes as a spreadsheet reads them. */
export function parseCsv(text, sep = ",", maxRows = 1000) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const s = String(text || "").replace(/^\uFEFF/, "")   // (a byte-order mark);
  for (let i = 0; i < s.length && rows.length < maxRows; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if ((cell || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
  return rows;
}

/** JSON laid out two spaces deep, or the text as it came when it is not JSON (JSON Lines, a file cut short). */
export function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text || ""); }
}

/**
 * A sound's waveform: the loudest sample in each of n equal slices of its first channel (mixed with the second when
 * there is one), scaled so the loudest bar is 1. Bars never quite vanish (0.04), so silence still reads as a line.
 */
export function peaksOf(channels, n = 200) {
  const a = channels[0], b = channels[1];
  const len = a?.length || 0;
  const out = new Array(n).fill(0.04);
  if (!len) return out;
  const step = len / n;
  let top = 0;
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * step), to = Math.max(from + 1, Math.floor((i + 1) * step));
    let peak = 0;
    // Big files: look at up to 2000 samples a slice, evenly, which draws the same picture for far less work.
    const hop = Math.max(1, Math.floor((to - from) / 2000));
    for (let j = from; j < to && j < len; j += hop) {
      const v = Math.abs(b ? (a[j] + b[j]) / 2 : a[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > top) top = peak;
  }
  return out.map((v) => (top ? Math.max(0.04, v / top) : 0.04));
}

/** m:ss (or h:mm:ss) for a time in seconds. */
export function clock(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** The speeds the player steps through, and the one after a speed. */
export const SPEEDS = [1, 1.5, 2];
export const nextSpeed = (now) => SPEEDS[(SPEEDS.indexOf(now) + 1) % SPEEDS.length] || 1;

/** Where in a sound (0 to 1) a point x across a waveform of width w is. */
export const seekAt = (x, w) => (w > 0 ? Math.min(1, Math.max(0, x / w)) : 0);
