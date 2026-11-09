// Small, valid PDFs built in the test itself, so the PDF tests need no binary fixtures. Each one has a real
// cross-reference table (or, with objStm, a cross-reference stream), so pdftotext reads them as well as Tarsee's
// built-in reader does.
//
//   makePdf({ pages: ["Line one\nLine two", "Page two"] })            plain Helvetica text, one string per page
//   makePdf({ pages, compress: true })                                 Flate-compressed content streams
//   makePdf({ pages, predictor: true })                                Flate with PNG predictors
//   makePdf({ pages, encode: "hex" or "a85" })                          ASCIIHex or ASCII85 over Flate
//   makePdf({ pages, objStm: true })                                   PDF 1.5: dictionaries packed in an object stream
//   makePdf({ pages, cidFont: true })                                  a Type0 font drawn with 2-byte codes and a ToUnicode map
//   makePdf({ pages, kerned: true })                                   words drawn with TJ and kerning gaps
//   makePdf({ pages, formXObject: "text" })                            extra text drawn from a form XObject
//   makePdf({ pages: [""] })                                           a page with no text (as a scanned page reads)
import zlib from "node:zlib";

/** A literal PDF string: ( ) and \ escaped. */
export const pdfString = (s) => `(${String(s).replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** PNG-predict rows of `cols` bytes (one byte per pixel), each row with the next of the five PNG filter types. */
function pngPredict(raw, cols) {
  const rows = Math.ceil(raw.length / cols);
  const src = Buffer.alloc(rows * cols);   // the last row padded with NULs (white space in a content stream)
  raw.copy(src);
  const out = Buffer.alloc(rows * (cols + 1));
  for (let r = 0; r < rows; r++) {
    const type = r % 5;
    out[r * (cols + 1)] = type;
    for (let x = 0; x < cols; x++) {
      const cur = src[r * cols + x];
      const a = x ? src[r * cols + x - 1] : 0;
      const b = r ? src[(r - 1) * cols + x] : 0;
      const c = r && x ? src[(r - 1) * cols + x - 1] : 0;
      let p = 0;
      if (type === 1) p = a;
      else if (type === 2) p = b;
      else if (type === 3) p = (a + b) >> 1;
      else if (type === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[r * (cols + 1) + 1 + x] = (cur - p) & 0xff;
    }
  }
  return out;
}

/** ASCII85, with a line break now and then (readers skip white space in it). */
function ascii85(buf) {
  let out = "";
  for (let i = 0; i < buf.length; i += 4) {
    const n = Math.min(4, buf.length - i);
    const chunk = Buffer.alloc(4);
    buf.copy(chunk, 0, i, i + n);
    let v = chunk.readUInt32BE(0);
    if (v === 0 && n === 4) { out += "z"; continue; }
    const digits = [];
    for (let k = 0; k < 5; k++) { digits.unshift(String.fromCharCode((v % 85) + 33)); v = Math.floor(v / 85); }
    out += digits.slice(0, n + 1).join("");
    if (out.length % 60 < 5) out += "\n";
  }
  return `${out}~>`;
}

/** A stream object. opts: compress (Flate), predictor (PNG predictors under Flate), encode ("hex" or "a85" over the rest). */
function stream(dict, data, opts = {}) {
  const o = typeof opts === "boolean" ? { compress: opts } : opts;
  let body = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
  const filters = [];
  const parms = [];
  if (o.compress || o.predictor) {
    if (o.predictor) body = pngPredict(body, 16);
    body = zlib.deflateSync(body);
    filters.unshift("/FlateDecode");
    parms.unshift(o.predictor ? "<< /Predictor 12 /Columns 16 >>" : "null");
  }
  if (o.encode === "hex") { body = Buffer.from(`${body.toString("hex")}>`, "latin1"); filters.unshift("/ASCIIHexDecode"); parms.unshift("null"); }
  if (o.encode === "a85") { body = Buffer.from(ascii85(body), "latin1"); filters.unshift("/ASCII85Decode"); parms.unshift("null"); }
  let d = dict;
  if (filters.length) d += ` /Filter [${filters.join(" ")}]`;
  if (parms.some((p) => p !== "null")) d += ` /DecodeParms [${parms.join(" ")}]`;
  return { dict: `<< ${d} /Length ${body.length} >>`, stream: body };
}

/**
 * Write objects (index = object number; [0] unused) as a PDF. inObjStm: object numbers to pack into one object
 * stream (PDF 1.5, with a cross-reference stream); streams can't be packed.
 */
export function writePdf(objects, { root, inObjStm = new Set(), compress = false, trailerExtra = "" } = {}) {
  const version = inObjStm.size ? "1.5" : "1.4";
  const parts = [Buffer.from(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`, "latin1")];
  let len = parts[0].length;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1"); parts.push(buf); len += buf.length; };
  const offsets = [];
  const writeObj = (n, o) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${o.dict}\n`);
    if (o.stream) { push("stream\n"); push(o.stream); push("\nendstream\n"); }
    push("endobj\n");
  };
  const count = objects.length - 1;
  for (let n = 1; n <= count; n++) if (!inObjStm.has(n)) writeObj(n, objects[n]);

  if (!inObjStm.size) {
    const xref = len;
    let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${count + 1} /Root ${root} 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(parts);
  }

  // The object stream: "num offset" pairs, then the objects.
  const packed = [...inObjStm].sort((a, b) => a - b);
  let header = "";
  let body = "";
  for (const n of packed) { header += `${n} ${body.length} `; body += `${objects[n].dict}\n`; }
  const stmNum = count + 1;
  const stm = stream(`/Type /ObjStm /N ${packed.length} /First ${header.length}`, header + body, compress);
  writeObj(stmNum, stm);

  // The cross-reference stream: W [1 4 2], one row per object 0..xrefNum.
  const xrefNum = count + 2;
  offsets[xrefNum] = len;
  const rows = Buffer.alloc((xrefNum + 1) * 7);
  const row = (i, type, a, b) => { rows.writeUInt8(type, i * 7); rows.writeUInt32BE(a, i * 7 + 1); rows.writeUInt16BE(b, i * 7 + 5); };
  row(0, 0, 0, 0xffff);
  for (let n = 1; n <= xrefNum; n++) {
    if (inObjStm.has(n)) row(n, 2, stmNum, packed.indexOf(n));
    else row(n, 1, offsets[n], 0);
  }
  push(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${xrefNum + 1} /Root ${root} 0 R /W [1 4 2] /Index [0 ${xrefNum + 1}] /Length ${rows.length}${trailerExtra} >>\nstream\n`);
  push(rows);
  push(`\nendstream\nendobj\nstartxref\n${offsets[xrefNum]}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** The ToUnicode CMap for the CID font: lower-case letters as one range from <0100>, every other character one by one. */
function cidMapping(text) {
  const codes = new Map();
  let next = 1;
  for (const ch of new Set([...text])) {
    if (ch >= "a" && ch <= "z") codes.set(ch, 0x100 + ch.charCodeAt(0) - 0x61);
    else codes.set(ch, next++);
  }
  const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  const singles = [...codes].filter(([ch]) => !(ch >= "a" && ch <= "z"));
  const cmap = [
    "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
    "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange",
    `${singles.length} beginbfchar`,
    ...singles.map(([ch, code]) => `<${hex4(code)}> <${hex4(ch.charCodeAt(0))}>`),
    "endbfchar",
    "1 beginbfrange", "<0100> <0119> <0061>", "endbfrange",
    "endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end",
  ].join("\n");
  const encode = (s) => `<${[...s].map((ch) => hex4(codes.get(ch))).join("")}>`;
  return { cmap, encode };
}

/** A whole PDF: one entry of `pages` per page, lines split on "\n". */
export function makePdf({ pages = ["Hello"], compress = false, predictor = false, encode = null, objStm = false, cidFont = false, kerned = false, formXObject = null, encrypted = false } = {}) {
  const filters = { compress: compress || !!encode, predictor, encode };
  const objects = [null];
  const add = (o) => { objects.push(o); return objects.length - 1; };
  const catalog = add(null);
  const pagesNode = add(null);
  const cid = cidFont ? cidMapping(pages.join("")) : null;

  let font;
  if (cid) {
    const toUnicode = add(stream("", cid.cmap, filters));
    const descriptor = add({ dict: "<< /Type /FontDescriptor /FontName /TestFont /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>" });
    const descendant = add({ dict: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 500 >>` });
    font = add({ dict: `<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>` });
  } else {
    font = add({ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" });
  }
  const show = (s) => {
    if (cid) return `${cid.encode(s)} Tj`;
    if (kerned) {
      // Each word as its own string; a big gap (-600) between words, a small one (-20) inside them.
      const words = s.split(" ");
      return `[${words.map((w) => (w.length > 2 ? `${pdfString(w.slice(0, 2))} -20 ${pdfString(w.slice(2))}` : pdfString(w))).join(" -600 ")}] TJ`;
    }
    return `${pdfString(s)} Tj`;
  };

  let xobj = null;
  if (formXObject) {
    xobj = add(stream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >>`,
      `BT /F1 12 Tf 72 400 Td ${show(formXObject)} ET`, filters));
  }

  const kids = [];
  for (const text of pages) {
    const lines = String(text).split("\n").filter((l) => l.length);
    const body = lines.length
      ? `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map(show).join(" T* ")} ET`
      : "0 0 1 rg 72 72 200 200 re f";   // a drawing and no text, as a scanned page reads
    const content = add(stream("", xobj ? `${body}\nq /X1 Do Q` : body, filters));
    const xres = xobj ? ` /XObject << /X1 ${xobj} 0 R >>` : "";
    kids.push(add({ dict: `<< /Type /Page /Parent ${pagesNode} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >>${xres} >> /Contents ${content} 0 R >>` }));
  }
  objects[catalog] = { dict: `<< /Type /Catalog /Pages ${pagesNode} 0 R >>` };
  objects[pagesNode] = { dict: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>` };

  const inObjStm = new Set();
  if (objStm) for (let n = 1; n < objects.length; n++) if (!objects[n].stream) inObjStm.add(n);
  const trailerExtra = encrypted ? " /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>" : "";
  return writePdf(objects, { root: catalog, inObjStm, compress: filters, trailerExtra });
}
