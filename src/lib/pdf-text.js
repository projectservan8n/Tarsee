/**
 * pdf-text.js: the text of a PDF, for an AI that can't read PDF files itself (ai/media.js, design 4.12) and for
 * the pdf_read tool (tarsee_pdf_read, design 4.9).
 *
 * Two readers, tried in this order by pdfText():
 *  - pdftotext (poppler-utils; the Docker image installs it). It reads nearly anything.
 *  - a small built-in reader, for a machine without pdftotext (a developer's PC) or a PDF pdftotext gave up on. It
 *    reads ordinary PDFs: compressed content, object streams (PDF 1.5+), fonts with a ToUnicode map, text drawn
 *    from form XObjects. It can't open a PDF locked with a password, and like pdftotext it finds no text in
 *    scanned pages (pictures of text).
 *
 * The pdf_read tool (readPdfTool, run by lib/tools.js executeTool, so Tool Permissions and the audit log apply)
 * reads a PDF in the workspace (the uploads folder, where the channels and the dashboard save what people send, is
 * in it) or at a web address, a few whole pages at a time: by default its answer stays under what a tool result
 * shows inline (ai/context-limits.js, about 12,000 characters) and says which pages to ask for next. A web address
 * is only fetched when it resolves to a public address (no loopback, private network or cloud metadata host), on
 * every redirect too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import config from "../config/env.js";
import { isSensitivePath } from "./safe-path.js";

/** How much of a PDF's text goes inline into a message for an AI that can't read PDFs (design 4.12). */
export const PDF_INLINE_CHARS = 30_000;
/** pdf_read's answer by default: under what a tool result shows inline. The model may ask for up to the most. */
export const PDF_READ_DEFAULT_CHARS = 10_000;
export const PDF_READ_MAX_CHARS = 50_000;
/** The biggest PDF read, from disk or from the web. */
export const PDF_MAX_BYTES = 100 * 1024 * 1024;

const PDFTOTEXT_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

// --- Which reader ---

/** The pdftotext command: undefined until looked for, null when it isn't installed. */
let _pdftotext;

/** Tests only: use this pdftotext command (null: none installed); no argument looks for it again. */
export function __setPdftotextForTests(bin) {
  _pdftotext = bin;
  _cache.clear();
}

function pdftotextBin() {
  if (_pdftotext !== undefined) return Promise.resolve(_pdftotext);
  return new Promise((resolve) => {
    execFile("pdftotext", ["-v"], { timeout: 10_000, windowsHide: true }, (err) => {
      // -v exits non-zero on some builds; only "not found" (or a hang) means there is none.
      _pdftotext = err && (err.code === "ENOENT" || err.killed) ? null : "pdftotext";
      resolve(_pdftotext);
    });
  });
}

function runPdftotext(bin, file, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, ["-enc", "UTF-8", file, "-"], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const said = String(stderr || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Syntax (Warning|Error)/i.test(l))[0];
        reject(new Error(said || err.message));
        return;
      }
      resolve(stdout.toString("utf8"));
    });
  });
}

/** True when the bytes are a PDF ("%PDF-" in the first kilobyte, as readers allow). */
export function isPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 1024).includes("%PDF-");
}

/** The last few PDFs read, by their bytes' hash: the model reading a long PDF a few pages at a time. */
const _cache = new Map();
const CACHE_ENTRIES = 6;
const CACHE_MAX_CHARS = 5_000_000;

/**
 * A PDF's text, one string per page: { pages, reader: "pdftotext" | "builtin", error? }. pages is empty and error
 * says why when nothing could be read. `file`: the PDF's own path, when it is on disk (saves pdftotext a copy).
 */
export async function pdfText(buffer, { file = null, timeoutMs = PDFTOTEXT_TIMEOUT_MS } = {}) {
  if (!isPdf(buffer)) return { pages: [], reader: null, error: "this isn't a PDF" };
  const key = crypto.createHash("sha256").update(buffer).digest("hex");
  const hit = _cache.get(key);
  if (hit) { _cache.delete(key); _cache.set(key, hit); return hit; }

  let result = null;
  let pdftotextError = null;
  const bin = await pdftotextBin();
  if (bin) {
    let tmp = null;
    try {
      let src = file;
      if (!src) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-pdf-"));
        src = path.join(tmp, "in.pdf");
        fs.writeFileSync(src, buffer);
      }
      result = { pages: splitPdftotext(await runPdftotext(bin, src, timeoutMs)), reader: "pdftotext" };
    } catch (err) {
      pdftotextError = err.message;
    } finally {
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp copy */ } }
    }
  }
  if (!result) {
    const own = builtinPdfText(buffer);
    result = own.error && !own.pages.length
      ? { pages: [], reader: "builtin", error: own.error || pdftotextError }
      : { pages: own.pages, reader: "builtin" };
  }
  if (!result.error && result.pages.reduce((n, p) => n + p.length, 0) <= CACHE_MAX_CHARS) {
    _cache.set(key, result);
    while (_cache.size > CACHE_ENTRIES) _cache.delete(_cache.keys().next().value);
  }
  return result;
}

/** pdftotext's output: a form feed after each page. */
function splitPdftotext(out) {
  const pages = out.replace(/\r\n?/g, "\n").split("\f");
  if (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
  return pages.map(tidy);
}

/** A page's text with control characters out, runs of spaces as one, and no more than one blank line in a row. */
function tidy(t) {
  return String(t)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t\u00A0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Pages ---

/**
 * Which pages to read: "3", "2-5", "6-" (to the end), "all" or nothing (all of them), against the page count.
 * Returns { first, last } (1-based, last clamped to the count) or { error } in words the model can act on.
 */
export function parsePageRange(spec, count) {
  if (spec == null || (typeof spec === "string" && !spec.trim())) return { first: 1, last: count };
  const t = String(spec).trim().toLowerCase();
  if (t === "all") return { first: 1, last: count };
  const m = /^(\d+)\s*(?:(-)\s*(\d*))?$/.exec(t);
  if (!m) return { error: `"${spec}" isn't a page or a range of pages: use 3, 2-5, or 6- for page 6 to the end.` };
  const first = Number(m[1]);
  const last = m[2] ? (m[3] ? Number(m[3]) : count) : first;
  if (first < 1 || last < first) return { error: `"${spec}" isn't a range of pages: pages count from 1, e.g. 2-5.` };
  if (first > count) return { error: `this PDF has ${count} page${count === 1 ? "" : "s"}, so there is no page ${first}.` };
  return { first, last: Math.min(last, count) };
}

/**
 * Whole pages, each under a "--- Page N ---" line, as many as fit in maxChars. A first page longer than that is cut.
 * pages: the texts of pages first, first+1, ... Returns { text, last (the last page shown), partial (it was cut) }.
 */
export function fitPages(pages, { first = 1, maxChars }) {
  let text = "";
  let last = first - 1;
  let partial = false;
  for (let k = 0; k < pages.length; k++) {
    const n = first + k;
    const block = `--- Page ${n} ---\n${pages[k] || "(no text on this page)"}\n\n`;
    if (text.length + block.length <= maxChars) { text += block; last = n; continue; }
    if (k === 0) {
      text = `${block.slice(0, Math.max(0, maxChars - 2)).trimEnd()}\n…`;
      last = n;
      partial = true;
    }
    break;
  }
  return { text: text.trimEnd(), last, partial };
}

// --- The pdf_read tool ---

/**
 * pdf_read: { path (or source), pages?, max_chars? } -> the text, or "pdf_read error: ..." saying what to do.
 * A path is the workspace's (absolute, or relative to it); anything outside it, or a protected file (credentials,
 * keys, databases), is refused. An http(s) address is downloaded when it is public.
 */
export async function readPdfTool(input = {}, ctx = {}) {
  const where = [input?.path, input?.file_path, input?.source, input?.url].find((v) => typeof v === "string" && v.trim())?.trim();
  if (!where) return "pdf_read error: 'path' is required: a PDF in the workspace (e.g. uploads/report.pdf) or a web address.";
  const asked = Number(input?.max_chars);
  const maxChars = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : PDF_READ_DEFAULT_CHARS, 1_000), PDF_READ_MAX_CHARS);

  let buffer;
  let name;
  let file = null;
  if (/^https?:\/\//i.test(where)) {
    try {
      const { checkUrlSafety } = await import("./url-safety.js");
      const safety = await checkUrlSafety(where, ctx?.settingsStore);
      if (!safety.safe) return `pdf_read error: that address is blocked (${safety.reason}).`;
      buffer = await fetchPdf(where);
    } catch (err) {
      return `pdf_read error: ${err.message}`;
    }
    name = urlFileName(where);
  } else {
    const found = locate(where);
    if (found.error) return `pdf_read error: ${found.error}`;
    file = found.file;
    name = path.basename(file);
    try { buffer = fs.readFileSync(file); } catch (err) { return `pdf_read error: ${name} could not be opened (${err.message}).`; }
  }
  if (!isPdf(buffer)) return `pdf_read error: ${name} isn't a PDF.`;

  const r = await pdfText(buffer, { file });
  if (!r.pages.length) return `pdf_read error: ${name} could not be read: ${r.error || "no pages were found in it"}.`;
  const total = r.pages.length;
  const range = parsePageRange(input?.pages, total);
  if (range.error) return `pdf_read error: ${range.error}`;
  if (!r.pages.some((p) => p.trim())) {
    return `${name} has ${total} page${total === 1 ? "" : "s"}, but no text could be taken out of it: its pages are probably scanned (pictures of text), which this tool can't read.`;
  }

  const fit = fitPages(r.pages.slice(range.first - 1, range.last), { first: range.first, maxChars });
  const out = [`${name}: pages ${range.first}-${fit.last} of ${total}`, "", fit.text];
  const tail = [];
  if (fit.partial) tail.push(`Page ${fit.last} is longer than ${maxChars.toLocaleString("en-US")} characters and was cut off; ask again with a bigger max_chars (up to ${PDF_READ_MAX_CHARS.toLocaleString("en-US")}) to see more of it.`);
  if (fit.last < range.last) tail.push(`Pages ${fit.last + 1}-${range.last} are not shown yet. To read on, ask for pages "${fit.last + 1}-${range.last}".`);
  if (tail.length) out.push("", `[${tail.join(" ")}]`);
  return out.join("\n");
}

/** A workspace path, checked: { file } (its real path) or { error }. */
function locate(where) {
  const roots = [...new Set([config.WORKSPACE_DIR, config.CLAUDE_WORKSPACE_DIR].filter(Boolean).map((r) => path.resolve(r)))];
  const candidates = path.isAbsolute(where) ? [path.resolve(where)] : roots.map((r) => path.resolve(r, where));
  if (candidates.some(isSensitivePath)) return { error: `${path.basename(candidates[0])} can't be read with this tool.` };
  let real = null;
  for (const c of candidates) {
    try { real = fs.realpathSync(c); break; } catch { /* the next root */ }
  }
  if (!real) return { error: `there is no file at ${candidates[0]}.` };
  const realRoots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  if (!realRoots.some((r) => real === r || real.startsWith(r + path.sep))) {
    return { error: `${real} is outside the workspace. Copy the file into the workspace (its uploads folder is a good place) and read it from there.` };
  }
  if (isSensitivePath(real)) return { error: `${path.basename(real)} can't be read with this tool.` };
  let st;
  try { st = fs.statSync(real); } catch (err) { return { error: `${real} could not be opened (${err.message}).` }; }
  if (!st.isFile()) return { error: `${real} is a folder, not a PDF.` };
  if (st.size > PDF_MAX_BYTES) return { error: `${path.basename(real)} is ${(st.size / 1024 / 1024).toFixed(0)} MB; the most this tool reads is ${PDF_MAX_BYTES / 1024 / 1024} MB.` };
  return { file: real };
}

function urlFileName(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return last.replace(/[^\w.\- ()]+/g, "_").slice(-120) || "document.pdf";
  } catch {
    return "document.pdf";
  }
}

// --- Downloading ---

/**
 * Whether an IP address is one a tool must never be pointed at: loopback, private networks (RFC 1918, ULA),
 * link-local (169.254.0.0/16 holds the cloud metadata service), carrier-grade NAT, multicast, reserved and
 * unspecified addresses, IPv4 inside IPv6 (mapped, NAT64, 6to4) by the IPv4 rules. Anything not an IP address is
 * refused too.
 */
export function isPrivateAddress(ip) {
  let a = String(ip ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const v = net.isIP(a);
  if (v === 4) return private4(a.split(".").map(Number));
  if (v !== 6) return true;
  const g = expand6(a);
  if (!g) return true;
  const v4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), :: and ::1
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true;
    return private4(v4(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return private4(v4(g[6], g[7]));   // NAT64
  if (g[0] === 0x2002) return private4(v4(g[1], g[2]));                                                          // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;   // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;   // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;   // site-local (old)
  if ((g[0] & 0xff00) === 0xff00) return true;   // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;   // documentation
  return false;
}

function private4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/** An IPv6 address as its 8 groups, or null. */
function expand6(a) {
  let tail = [];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const p = dotted.slice(1).map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    a = a.slice(0, -dotted[0].length);
    if (a.endsWith(":") && !a.endsWith("::")) a = a.slice(0, -1);
  }
  const groups = (s) => (s ? s.split(":").filter(Boolean).map((h) => parseInt(h, 16)) : []);
  let out;
  if (a.includes("::")) {
    const [head, rest] = a.split("::");
    const hs = groups(head);
    const rs = groups(rest);
    const fill = 8 - hs.length - rs.length - tail.length;
    if (fill < 0) return null;
    out = [...hs, ...new Array(fill).fill(0), ...rs, ...tail];
  } else out = [...groups(a), ...tail];
  return out.length === 8 && out.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? out : null;
}

/** dns.lookup that refuses a host resolving to any private or local address (so a connection never starts). */
export function guardedLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  if (typeof options === "number") options = { family: options };
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) { cb(err); return; }
    if (!addrs?.length || addrs.some((x) => isPrivateAddress(x.address))) {
      cb(Object.assign(new Error(`that address is on a private or local network (${hostname}), which this tool doesn't read from`), { code: "EPRIVATE" }));
      return;
    }
    if (options?.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

/**
 * Download a PDF from a public http(s) address: at most maxBytes, following up to maxRedirects redirects, every
 * host checked (an IP address directly, a name through `lookup`, which refuses private addresses). Throws an Error
 * whose message says what went wrong.
 */
export async function fetchPdf(url, { lookup = guardedLookup, maxBytes = PDF_MAX_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxRedirects = 3 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new Error("that isn't a web address"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https addresses can be read");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`that address is on a private or local network (${host}), which this tool doesn't read from`);
    const res = await download(u, { lookup, maxBytes, timeoutMs });
    if (res.redirect) { current = new URL(res.redirect, u).toString(); continue; }
    return res.body;
  }
  throw new Error("the address redirected too many times");
}

function download(u, { lookup, maxBytes, timeoutMs }) {
  const tooBig = () => new Error(`the download is too big (over ${maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${maxBytes} bytes`})`);
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(u, { lookup, agent: false, timeout: timeoutMs, headers: { "User-Agent": "Tarsee", Accept: "application/pdf,*/*" } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); resolve({ redirect: res.headers.location }); return; }
      if (status !== 200) { res.resume(); reject(new Error(`the address answered HTTP ${status}`)); return; }
      if (Number(res.headers["content-length"]) > maxBytes) { res.destroy(); reject(tooBig()); return; }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); reject(tooBig()); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("the download took too long")));
    req.on("error", reject);
  });
}

// --- The built-in reader ---

const MAX_PAGES = 5000;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
/** A TJ gap wider than this (thousandths of the font size) is a space between words. */
const TJ_SPACE = -200;

class Ref { constructor(n) { this.n = n; } }
class Str { constructor(b) { this.b = b; } }   // a PDF string's bytes, one character per byte
class Kw { constructor(w) { this.w = w; } }     // a bare keyword: an operator in a content stream

const WS_DELIM = new Set(["\0", "\t", "\n", "\f", "\r", " ", "(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
const REF_RE = /\s+\d+\s+R(?=[\s()<>[\]{}/%]|$)/y;
const ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

/**
 * The text of a PDF without pdftotext: { pages } (one string per page, "" for a page without text) or
 * { pages: [], error }. Never throws.
 */
export function builtinPdfText(buffer) {
  if (!isPdf(buffer)) return { pages: [], error: "this isn't a PDF" };
  try {
    const doc = new PdfDoc(buffer);
    if (doc.encrypted) return { pages: [], error: "it is locked with a password (encrypted); pdftotext (poppler-utils) can open many of these" };
    const pages = doc.pageList();
    if (!pages.length) return { pages: [], error: "no pages were found in it" };
    return {
      pages: pages.map((p) => {
        try { return tidy(doc.pageText(p)); } catch { return ""; }
      }),
    };
  } catch (err) {
    return { pages: [], error: `it could not be read (${err.message})` };
  }
}

function skipWs(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === "%") { while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++; }
    else if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0") i++;
    else break;
  }
  return i;
}

function parseName(s, i) {
  let j = i + 1;
  while (j < s.length && !WS_DELIM.has(s[j])) j++;
  const raw = s.slice(i + 1, j);
  return [`/${raw.includes("#") ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : raw}`, j];
}

function parseLiteral(s, i) {
  let depth = 1;
  let out = "";
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const d = s[i + 1];
      i += 2;
      if (d === undefined) break;
      if (ESCAPES[d] !== undefined) { out += ESCAPES[d]; continue; }
      if (d >= "0" && d <= "7") {
        let o = d;
        while (o.length < 3 && s[i] >= "0" && s[i] <= "7") o += s[i++];
        out += String.fromCharCode(parseInt(o, 8) & 0xff);
        continue;
      }
      if (d === "\r") { if (s[i] === "\n") i++; continue; }
      if (d === "\n") continue;
      out += d;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [new Str(out), i + 1];
    out += c;
    i++;
  }
  return [new Str(out), i];
}

/**
 * One PDF value at s[i]: [value, next index]. Names are "/Name" strings, strings Str, references Ref (only when
 * refs is true: not in content streams), dictionaries plain objects keyed without the "/", keywords Kw.
 */
function parseValue(s, i, refs, depth = 0) {
  if (depth > 64) throw new Error("nested too deep");
  i = skipWs(s, i);
  const c = s[i];
  if (c === undefined) throw new Error("unexpected end");
  if (c === "<") {
    if (s[i + 1] === "<") {
      const d = Object.create(null);
      i += 2;
      for (;;) {
        i = skipWs(s, i);
        if (i >= s.length) throw new Error("unclosed dictionary");
        if (s[i] === ">" && s[i + 1] === ">") return [d, i + 2];
        if (s[i] !== "/") { i = parseValue(s, i, refs, depth + 1)[1]; continue; }
        const [key, j] = parseName(s, i);
        const [val, k] = parseValue(s, j, refs, depth + 1);
        d[key.slice(1)] = val;
        i = k;
      }
    }
    const end = s.indexOf(">", i + 1);
    const stop = end < 0 ? s.length : end;
    const h = s.slice(i + 1, stop).replace(/[^0-9a-fA-F]/g, "");
    return [new Str(Buffer.from(h.length % 2 ? `${h}0` : h, "hex").toString("latin1")), stop + 1];
  }
  if (c === "(") return parseLiteral(s, i);
  if (c === "[") {
    const a = [];
    i++;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) throw new Error("unclosed array");
      if (s[i] === "]") return [a, i + 1];
      const [v, j] = parseValue(s, i, refs, depth + 1);
      a.push(v);
      i = j;
    }
  }
  if (c === "/") return parseName(s, i);
  if (c === "+" || c === "-" || c === "." || (c >= "0" && c <= "9")) {
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(s);
    if (m) {
      const v = Number(m[0]);
      i += m[0].length;
      if (refs && /^\d+$/.test(m[0])) {
        REF_RE.lastIndex = i;
        const r = REF_RE.exec(s);
        if (r) return [new Ref(v), i + r[0].length];
      }
      return [Number.isFinite(v) ? v : 0, i];
    }
  }
  let j = i;
  while (j < s.length && !WS_DELIM.has(s[j])) j++;
  if (j === i) throw new Error(`unexpected ${c}`);
  const w = s.slice(i, j);
  return [w === "true" ? true : w === "false" ? false : w === "null" ? null : new Kw(w), j];
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

class PdfDoc {
  constructor(buf) {
    this.buf = buf;
    this.s = buf.toString("latin1");
    this.objects = new Map();   // number -> { value, start?, end? } (start/end: a stream's bytes)
    this.trailers = [];         // [{ pos, dict }]: the classic trailers and cross-reference streams
    this.decoded = 0;
    this.fonts = new Map();
    this.forms = new Set();
    this.scan();
    const latest = [...this.trailers].sort((a, b) => a.pos - b.pos);
    this.root = null;
    this.encrypted = false;
    for (const t of latest) {
      if (t.dict?.Root) this.root = t.dict.Root;
      if (t.dict?.Encrypt) this.encrypted = true;
    }
  }

  /** Every "n g obj ... endobj" in the file, in order (a later one replaces an earlier one), then object streams. */
  scan() {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      let value;
      let i;
      try { [value, i] = parseValue(s, m.index + m[0].length, true); } catch { continue; }
      i = skipWs(s, i);
      const entry = { value };
      if (s.startsWith("stream", i)) {
        let start = i + 6;
        if (s[start] === "\r") start++;
        if (s[start] === "\n") start++;
        let end;
        const len = typeof value?.Length === "number" ? value.Length : -1;
        if (len >= 0 && start + len <= s.length && /^\s*endstream/.test(s.slice(start + len, start + len + 24))) end = start + len;
        else {
          const k = s.indexOf("endstream", start);
          if (k < 0) end = s.length;
          else {
            end = k;
            if (s[end - 1] === "\n") end--;
            if (s[end - 1] === "\r") end--;
          }
        }
        entry.start = start;
        entry.end = Math.max(start, end);
        re.lastIndex = Math.max(re.lastIndex, entry.end);
      } else re.lastIndex = Math.max(re.lastIndex, i);
      this.objects.set(num, entry);
      if (value?.Type === "/XRef") this.trailers.push({ pos: m.index, dict: value });
    }
    const tre = /trailer\s*<</g;
    while ((m = tre.exec(s))) {
      try { this.trailers.push({ pos: m.index, dict: parseValue(s, m.index + 7, true)[0] }); } catch { /* a broken trailer */ }
    }
    for (const entry of [...this.objects.values()]) {
      if (entry.value?.Type === "/ObjStm" && entry.start != null) this.unpack(entry);
    }
  }

  /** The objects packed in an object stream (PDF 1.5+). A direct object of the same number wins. */
  unpack(entry) {
    const data = this.streamBytes(entry);
    if (!data) return;
    const t = data.toString("latin1");
    const count = Math.min(Number(entry.value.N) || 0, 1_000_000);
    const first = Number(entry.value.First) || 0;
    const nums = /\d+/g;
    const header = t.slice(0, first);
    const pairs = [];
    for (let k = 0; k < count; k++) {
      const a = nums.exec(header);
      const b = a && nums.exec(header);
      if (!b) break;
      pairs.push([Number(a[0]), Number(b[0])]);
    }
    for (const [num, off] of pairs) {
      if (this.objects.has(num)) continue;
      try { this.objects.set(num, { value: parseValue(t, first + off, true)[0] }); } catch { /* one broken object */ }
    }
  }

  /** A value with references followed. */
  get(v) {
    for (let d = 0; v instanceof Ref && d < 32; d++) v = this.objects.get(v.n)?.value;
    return v instanceof Ref ? null : v ?? null;
  }

  /** The object a reference points at ({ value, start?, end? }), or null. */
  entry(v) {
    let e = null;
    for (let d = 0; v instanceof Ref && d < 32; d++) { e = this.objects.get(v.n) || null; v = e?.value; }
    return e;
  }

  /** A stream's bytes with its filters undone, or null when a filter is one with no text behind it (pictures). */
  streamBytes(entry) {
    if (!entry || entry.start == null) return null;
    let data = this.buf.subarray(entry.start, entry.end);
    const filters = asArray(this.get(entry.value?.Filter));
    const parms = asArray(this.get(entry.value?.DecodeParms ?? entry.value?.DP));
    for (let k = 0; k < filters.length && data; k++) data = decodeFilter(filters[k], data, this.get(parms[k]));
    if (!data) return null;
    this.decoded += data.length;
    if (this.decoded > MAX_DECODED_BYTES) throw new Error("it holds too much to decode");
    return data;
  }

  /** The pages, in page-tree order, each with the resources it has or inherits. */
  pageList() {
    const out = [];
    const seen = new Set();
    const walk = (ref, inherited, depth) => {
      if (out.length >= MAX_PAGES || depth > 64) return;
      if (ref instanceof Ref) {
        if (seen.has(ref.n)) return;
        seen.add(ref.n);
      }
      const node = this.get(ref);
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const resources = node.Resources ?? inherited;
      const kids = this.get(node.Kids);
      if (node.Type === "/Page" || (node.Type !== "/Pages" && !Array.isArray(kids))) { out.push({ node, resources }); return; }
      for (const kid of asArray(kids)) walk(kid, resources, depth + 1);
    };
    const catalog = this.get(this.root);
    if (catalog?.Pages) walk(catalog.Pages, null, 0);
    if (!out.length) {
      // No page tree to follow (a damaged file): every page object, by number.
      for (const num of [...this.objects.keys()].sort((a, b) => a - b)) {
        const v = this.objects.get(num).value;
        if (v?.Type === "/Page" && out.length < MAX_PAGES) out.push({ node: v, resources: v.Resources ?? null });
      }
    }
    return out;
  }

  pageText({ node, resources }) {
    const first = this.entry(node.Contents);
    const refs = first?.start != null ? [node.Contents] : asArray(this.get(node.Contents));
    const data = refs.map((r) => this.streamBytes(this.entry(r))?.toString("latin1") ?? "").join("\n");
    return this.run(data, this.get(resources), 0);
  }

  /** The text a content stream draws, in drawing order, with line breaks where the text moves to another line. */
  run(s, resources, depth) {
    const out = new TextOut();
    const stack = [];
    let font = DEFAULT_FONT;
    let size = 12;
    let tm = [1, 0, 0, 1, 0, 0];
    let leading = 0;
    const moveTo = (e, f) => {
      tm[4] = e;
      tm[5] = f;
      out.at(f, Math.max(1, Math.abs(size * (tm[3] || 1)) * 0.5));
    };
    const move = (tx, ty) => moveTo(tm[4] + tx * tm[0] + ty * tm[2], tm[5] + tx * tm[1] + ty * tm[3]);
    const show = (v) => { if (v instanceof Str) out.put(decodeText(font, v.b)); };
    const num = (v) => (typeof v === "number" ? v : 0);
    let i = 0;
    while (i < s.length) {
      i = skipWs(s, i);
      if (i >= s.length) break;
      let v;
      try { [v, i] = parseValue(s, i, false); } catch { i++; continue; }
      if (!(v instanceof Kw)) {
        stack.push(v);
        if (stack.length > 32) stack.shift();
        continue;
      }
      switch (v.w) {
        case "BT": tm = [1, 0, 0, 1, 0, 0]; break;
        case "Tf": font = this.font(resources, stack[0]); size = num(stack[1]) || size; break;
        case "TL": leading = num(stack[0]); break;
        case "Td": move(num(stack[0]), num(stack[1])); break;
        case "TD": leading = -num(stack[1]); move(num(stack[0]), num(stack[1])); break;
        case "Tm":
          if (stack.length >= 6) { tm = stack.slice(-6).map(num); moveTo(tm[4], tm[5]); }
          break;
        case "T*": move(0, -leading); break;
        case "Tj": show(stack[0]); break;
        case "'": move(0, -leading); show(stack[0]); break;
        case "\"": move(0, -leading); show(stack[2]); break;
        case "TJ":
          for (const el of asArray(stack[0])) {
            if (el instanceof Str) out.put(decodeText(font, el.b));
            else if (typeof el === "number" && el < TJ_SPACE) out.space();
          }
          break;
        case "Do": out.block(this.form(resources, stack[0], depth)); break;
        case "ID": {
          // An inline picture's bytes, up to "EI": nothing to read in them.
          const re = /\sEI(?=\s|$)/g;
          re.lastIndex = i;
          const m = re.exec(s);
          i = m ? m.index + 3 : s.length;
          break;
        }
        default: break;
      }
      stack.length = 0;
    }
    return out.text();
  }

  /** The text a form XObject draws (a page can draw the same form more than once; one can't draw itself). */
  form(resources, nameVal, depth) {
    if (depth >= 6 || typeof nameVal !== "string") return "";
    const xobjects = this.get(resources?.XObject);
    const ref = xobjects ? xobjects[nameVal.slice(1)] : null;
    const e = this.entry(ref);
    if (!e || e.value?.Subtype !== "/Form" || this.forms.has(e)) return "";
    const data = this.streamBytes(e);
    if (!data) return "";
    this.forms.add(e);
    try {
      return this.run(data.toString("latin1"), this.get(e.value.Resources) ?? resources, depth + 1);
    } finally {
      this.forms.delete(e);
    }
  }

  /** How a font's bytes become text: its ToUnicode map, else its encoding (WinAnsi with any Differences). */
  font(resources, nameVal) {
    const fonts = this.get(resources?.Font);
    const ref = fonts && typeof nameVal === "string" ? fonts[nameVal.slice(1)] : null;
    const key = ref instanceof Ref ? ref.n : null;
    if (key != null && this.fonts.has(key)) return this.fonts.get(key);
    const dict = this.get(ref);
    const f = { bytes: 1, map: null, enc: WIN_ANSI };
    if (dict && typeof dict === "object") {
      if (dict.Subtype === "/Type0") f.bytes = 2;
      const tu = this.entry(dict.ToUnicode);
      const data = tu ? this.streamBytes(tu) : null;
      if (data) f.map = parseCMap(data.toString("latin1"));
      const encoding = this.get(dict.Encoding);
      const differences = encoding && typeof encoding === "object" ? this.get(encoding.Differences) : null;
      if (f.bytes === 1 && Array.isArray(differences)) {
        f.enc = WIN_ANSI.slice();
        let code = 0;
        for (const d of differences) {
          if (typeof d === "number") code = d;
          else if (typeof d === "string") {
            const u = glyphText(d.slice(1));
            if (u != null && code >= 0 && code < 256) f.enc[code] = u;
            code++;
          }
        }
      }
    }
    if (key != null) this.fonts.set(key, f);
    return f;
  }
}

/** The page's text as it is drawn: a line break when the text moves to another line, a space when it moves along. */
class TextOut {
  constructor() { this.s = ""; this.pending = null; this.lastY = null; }
  at(y, tolerance) {
    if (this.lastY != null) {
      if (Math.abs(y - this.lastY) > tolerance) this.pending = "\n";
      else if (this.pending !== "\n") this.pending = " ";
    }
    this.lastY = y;
  }
  space() { if (this.pending !== "\n") this.pending = " "; }
  put(t) {
    if (!t) return;
    if (this.pending && this.s) {
      if (this.pending === "\n") this.s += "\n";
      else if (!/\s$/.test(this.s) && !/^\s/.test(t)) this.s += " ";
    }
    this.pending = null;
    this.s += t;
  }
  block(t) {
    if (!t || !t.trim()) return;
    this.pending = "\n";
    this.put(t);
    this.pending = "\n";
  }
  text() { return this.s; }
}

function decodeText(font, b) {
  let out = "";
  if (font.bytes === 2) {
    for (let k = 0; k + 1 < b.length; k += 2) {
      const u = font.map ? cmapLookup(font.map, (b.charCodeAt(k) << 8) | b.charCodeAt(k + 1)) : null;
      if (u != null) out += u;
    }
    return out;
  }
  for (let k = 0; k < b.length; k++) {
    const code = b.charCodeAt(k);
    const u = font.map ? cmapLookup(font.map, code) : null;
    out += u ?? font.enc[code] ?? "";
  }
  return out;
}

/** A ToUnicode CMap: its bfchar and bfrange entries. */
function parseCMap(t) {
  const map = { chars: new Map(), ranges: [] };
  const hexes = (str) => [...str.matchAll(/<([0-9a-fA-F\s]*)>/g)].map((m) => m[1].replace(/\s+/g, ""));
  for (const block of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const h = hexes(block[1]);
    for (let k = 0; k + 1 < h.length; k += 2) map.chars.set(parseInt(h[k], 16), utf16(h[k + 1]));
  }
  for (const block of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F\s]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (!(hi >= lo)) continue;
      if (m[3] != null) map.ranges.push({ lo, hi, units: units16(m[3].replace(/\s+/g, "")) });
      else {
        const list = hexes(m[4]);
        for (let k = 0; k < list.length && lo + k <= hi; k++) map.chars.set(lo + k, utf16(list[k]));
      }
    }
  }
  return map;
}

function cmapLookup(map, code) {
  const c = map.chars.get(code);
  if (c != null) return c;
  for (const r of map.ranges) {
    if (code >= r.lo && code <= r.hi && r.units.length) {
      const u = r.units.slice();
      u[u.length - 1] += code - r.lo;
      return String.fromCharCode(...u);
    }
  }
  return null;
}

function units16(hex) {
  if (hex.length <= 2) return hex ? [parseInt(hex, 16)] : [];
  const out = [];
  for (let k = 0; k + 4 <= hex.length; k += 4) out.push(parseInt(hex.slice(k, k + 4), 16));
  return out;
}

const utf16 = (hex) => String.fromCharCode(...units16(hex));

function decodeFilter(name, data, parms) {
  switch (name) {
    case "/FlateDecode": case "/Fl": return predict(inflate(data), parms);
    case "/ASCIIHexDecode": case "/AHx": return asciiHex(data);
    case "/ASCII85Decode": case "/A85": return ascii85(data);
    default: return null;   // pictures (DCT, JPX, CCITT, JBIG2), LZW, encryption: no text read from these
  }
}

function inflate(data) {
  const opts = { maxOutputLength: MAX_STREAM_BYTES };
  try { return zlib.inflateSync(data, opts); } catch { /* damaged or cut off: what can be read of it */ }
  try { return zlib.inflateSync(data, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { /* raw deflate */ }
  try { return zlib.inflateRawSync(data, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
}

/** PNG predictors (Predictor 10-15) under Flate, as object streams sometimes use them. */
function predict(data, parms) {
  const p = Number(parms?.Predictor) || 1;
  if (!data || p < 10) return data;
  const colors = Number(parms.Colors) || 1;
  const bpc = Number(parms.BitsPerComponent) || 8;
  const cols = Number(parms.Columns) || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * cols) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = Buffer.from(data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)));
    for (let x = 0; x < rowLen; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let add = 0;
      if (type === 1) add = a;
      else if (type === 2) add = b;
      else if (type === 3) add = (a + b) >> 1;
      else if (type === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = (row[x] + add) & 0xff;
    }
    row.copy(out, r * rowLen);
    prev = row;
  }
  return out;
}

function asciiHex(data) {
  const t = data.toString("latin1");
  const end = t.indexOf(">");
  const h = (end < 0 ? t : t.slice(0, end)).replace(/[^0-9a-fA-F]/g, "");
  return Buffer.from(h.length % 2 ? `${h}0` : h, "hex");
}

function ascii85(data) {
  let t = data.toString("latin1").replace(/\s+/g, "");
  if (t.startsWith("<~")) t = t.slice(2);
  const end = t.indexOf("~>");
  if (end >= 0) t = t.slice(0, end);
  const out = Buffer.alloc(Math.ceil((t.length * 4) / 5) + 4 * (t.split("z").length - 1));
  let o = 0;
  let group = [];
  const flush = (n) => {
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < n; k++) out[o++] = bytes[k];
  };
  for (const ch of t) {
    if (ch === "z" && !group.length) { o += 4; continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) { flush(4); group = []; }
  }
  if (group.length > 1) {
    const n = group.length - 1;
    while (group.length < 5) group.push(84);
    flush(n);
  }
  return out.subarray(0, o);
}

/** WinAnsiEncoding: Latin-1 with Windows' characters in 0x80-0x9F. Most simple fonts read right with it. */
const WIN_ANSI_80 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";
const WIN_ANSI = Object.freeze(Array.from({ length: 256 }, (_, c) => (c >= 0x80 && c < 0xa0 ? WIN_ANSI_80[c - 0x80] : String.fromCharCode(c))));
const DEFAULT_FONT = Object.freeze({ bytes: 1, map: null, enc: WIN_ANSI });

/** Glyph names a font's Differences use, as text. */
const GLYPHS = {
  space: " ", exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
  quoteright: "’", quoteleft: "‘", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-",
  minus: "−", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?",
  at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", endash: "–", emdash: "—", bullet: "•", ellipsis: "…",
  quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚", quotedblbase: "„", dagger: "†", daggerdbl: "‡",
  degree: "°", copyright: "©", registered: "®", trademark: "™", section: "§", paragraph: "¶", periodcentered: "·",
  fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", germandbls: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ",
  oslash: "ø", Oslash: "Ø", euro: "€", sterling: "£", yen: "¥", cent: "¢", nbspace: " ", sfthyphen: "",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
const ACCENTS = { acute: "\u0301", grave: "\u0300", circumflex: "\u0302", tilde: "\u0303", dieresis: "\u0308", ring: "\u030A", cedilla: "\u0327", caron: "\u030C" };

function glyphText(name) {
  if (Object.hasOwn(GLYPHS, name)) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})+$/.exec(name);
  if (m) return String.fromCharCode(...name.slice(3).match(/.{4}/g).map((h) => parseInt(h, 16)));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) { const cp = parseInt(m[1], 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : null; }
  m = /^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|ring|cedilla|caron)$/.exec(name);
  if (m) return (m[1] + ACCENTS[m[2]]).normalize("NFC");
  return null;
}
