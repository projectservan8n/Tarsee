// Reading PDFs (src/lib/pdf-text.js): the pdf_read tool through executeTool, the tarsee_pdf_read MCP tool that calls
// it (design 4.9), and the two readers behind both: pdftotext (poppler-utils, in the Docker image) and the built-in
// reader used when pdftotext is not installed. The PDFs are built by the test (fixtures/make-pdf.js). Nothing leaves
// the machine: the web-address cases run against a server on 127.0.0.1.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-pdf-read-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
delete process.env.CLAUDE_WORKSPACE_DIR;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { makePdf } = await import("./fixtures/make-pdf.js");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { getSecurityManager } = await import("../src/lib/security-manager.js");
const { executeTool, TOOLS } = await import("../src/lib/tools.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
const pdf = await import("../src/lib/pdf-text.js");

const workspace = process.env.TARSEE_WORKSPACE_DIR;
const uploads = path.join(workspace, "uploads");
fs.mkdirSync(uploads, { recursive: true });
const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
const ctx = { db, settingsStore: settings };

/** A page of about `n` characters of numbered sentences. */
const longPage = (p, n = 1000) => {
  let s = "";
  for (let k = 1; s.length < n; k++) s += `Page ${p} sentence ${k} says something worth reading. `;
  return s.trim();
};

/** Write a PDF into the workspace's uploads folder and return its absolute path. */
function put(name, bytes) {
  const file = path.join(uploads, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** pdftotext on this machine, if there is one: on PATH, or (Windows) the copy that comes with Git. */
function findPdftotext() {
  for (const bin of ["pdftotext", "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe"]) {
    try { execFileSync(bin, ["-v"], { stdio: "ignore", windowsHide: true }); return bin; } catch (err) { if (err.code !== "ENOENT" && err.status != null) return bin; }
  }
  return null;
}
const PDFTOTEXT = findPdftotext();

after(() => {
  pdf.__setPdftotextForTests();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the built-in PDF reader (no pdftotext)", () => {
  it("reads each page's lines in order", () => {
    const r = pdf.builtinPdfText(makePdf({ pages: ["Hello world\nSecond line (with parens)", "Page two text"] }));
    assert.equal(r.error, undefined);
    assert.deepEqual(r.pages, ["Hello world\nSecond line (with parens)", "Page two text"]);
  });

  it("reads Flate-compressed content", () => {
    const r = pdf.builtinPdfText(makePdf({ pages: ["Compressed page one", "Compressed page two"], compress: true }));
    assert.deepEqual(r.pages, ["Compressed page one", "Compressed page two"]);
  });

  it("reads a PDF 1.5 whose pages sit in a compressed object stream", () => {
    const r = pdf.builtinPdfText(makePdf({ pages: ["Packed one", "Packed two"], objStm: true, compress: true }));
    assert.deepEqual(r.pages, ["Packed one", "Packed two"]);
  });

  it("undoes ASCIIHex and ASCII85 over Flate", () => {
    assert.deepEqual(pdf.builtinPdfText(makePdf({ pages: ["Hex encoded words", "Second hex page"], encode: "hex" })).pages, ["Hex encoded words", "Second hex page"]);
    const a85 = ["Base eighty five words, quite a few of them to cross lines", "Page two"];
    assert.deepEqual(pdf.builtinPdfText(makePdf({ pages: a85, encode: "a85" })).pages, a85);
  });

  it("undoes PNG predictors, in content and in object streams", () => {
    const pages = ["Predicted rows of text that run past sixteen bytes", "More predicted text"];
    assert.deepEqual(pdf.builtinPdfText(makePdf({ pages, predictor: true })).pages, pages);
    assert.deepEqual(pdf.builtinPdfText(makePdf({ pages, predictor: true, objStm: true })).pages, pages);
    assert.deepEqual(pdf.builtinPdfText(makePdf({ pages: ["Héllo Ñandú"], cidFont: true, encode: "a85", predictor: true })).pages, ["Héllo Ñandú"]);
  });

  it("decodes a 2-byte font through its ToUnicode map, accents included", () => {
    const r = pdf.builtinPdfText(makePdf({ pages: ["Héllo Ñandú world"], cidFont: true, compress: true }));
    assert.deepEqual(r.pages, ["Héllo Ñandú world"]);
  });

  it("turns a wide TJ gap into a space and a narrow one into nothing", () => {
    const r = pdf.builtinPdfText(makePdf({ pages: ["Kerned words here"], kerned: true }));
    assert.deepEqual(r.pages, ["Kerned words here"]);
  });

  it("includes text drawn from a form XObject", () => {
    const r = pdf.builtinPdfText(makePdf({ pages: ["Page body"], formXObject: "Inside the form" }));
    assert.match(r.pages[0], /Page body/);
    assert.match(r.pages[0], /Inside the form/);
  });

  it("gives an empty page for a page with no text (as a scanned page reads)", () => {
    const r = pdf.builtinPdfText(makePdf({ pages: ["", "Words"] }));
    assert.deepEqual(r.pages, ["", "Words"]);
  });

  it("says a locked PDF is locked", () => {
    const r = pdf.builtinPdfText(makePdf({ pages: ["Secret"], encrypted: true }));
    assert.match(r.error, /locked|password/i);
  });

  it("refuses bytes that are not a PDF, and survives a cut-off one", () => {
    assert.match(pdf.builtinPdfText(Buffer.from("just some text, no pdf here")).error, /isn't a PDF/i);
    const whole = makePdf({ pages: ["One", "Two"], compress: true });
    assert.doesNotThrow(() => pdf.builtinPdfText(whole.subarray(0, Math.floor(whole.length / 2))));
  });
});

describe("pdfText picks the reader", () => {
  it("falls back to the built-in reader when pdftotext is not installed", async () => {
    pdf.__setPdftotextForTests(null);
    const r = await pdf.pdfText(makePdf({ pages: ["Fallback works"] }));
    assert.equal(r.reader, "builtin");
    assert.deepEqual(r.pages, ["Fallback works"]);
  });

  it("uses pdftotext when it is installed", { skip: !PDFTOTEXT && "pdftotext is not installed here" }, async () => {
    pdf.__setPdftotextForTests(PDFTOTEXT);
    try {
      const r = await pdf.pdfText(makePdf({ pages: ["Read by poppler", "Second page"], compress: true }));
      assert.equal(r.reader, "pdftotext");
      assert.equal(r.pages.length, 2);
      assert.match(r.pages[0], /Read by poppler/);
      assert.match(r.pages[1], /Second page/);
      assert.ok(!r.pages.join("").includes("\r"), "Windows line ends are kept out of the text");
    } finally {
      pdf.__setPdftotextForTests(null);
    }
  });

  it("falls back to the built-in reader when pdftotext can't run", async () => {
    pdf.__setPdftotextForTests(path.join(tmp, "no-such-pdftotext"));
    const r = await pdf.pdfText(makePdf({ pages: ["Still read"] }));
    assert.equal(r.reader, "builtin");
    assert.deepEqual(r.pages, ["Still read"]);
    pdf.__setPdftotextForTests(null);
  });
});

describe("page ranges", () => {
  it("reads N, N-M and N- against the page count", () => {
    assert.deepEqual(pdf.parsePageRange(undefined, 9), { first: 1, last: 9 });
    assert.deepEqual(pdf.parsePageRange("3", 9), { first: 3, last: 3 });
    assert.deepEqual(pdf.parsePageRange(4, 9), { first: 4, last: 4 });
    assert.deepEqual(pdf.parsePageRange("2-5", 9), { first: 2, last: 5 });
    assert.deepEqual(pdf.parsePageRange(" 6 - ", 9), { first: 6, last: 9 });
    assert.deepEqual(pdf.parsePageRange("7-40", 9), { first: 7, last: 9 });
  });

  it("refuses pages that are not there or not page numbers", () => {
    assert.match(pdf.parsePageRange("12", 9).error, /9 pages/);
    assert.match(pdf.parsePageRange("0", 9).error, /page/i);
    assert.match(pdf.parsePageRange("5-2", 9).error, /page/i);
    assert.match(pdf.parsePageRange("abc", 9).error, /page/i);
  });
});

describe("pdf_read through executeTool", () => {
  beforeEach(() => {
    pdf.__setPdftotextForTests(null);
    getSecurityManager(settings).setToolPermission("pdf_read", "always_allow");
  });

  it("is in the tool list with a path and optional pages", () => {
    const def = TOOLS.find((t) => t.name === "pdf_read");
    assert.ok(def, "pdf_read is not defined");
    assert.deepEqual(def.input_schema.required, ["path"]);
    assert.ok(def.input_schema.properties.pages);
  });

  it("reads a PDF in the uploads folder by a workspace-relative or absolute path", async () => {
    const file = put("report.pdf", makePdf({ pages: ["Hello world", "Page two text"] }));
    for (const p of ["uploads/report.pdf", file]) {
      const out = await executeTool("pdf_read", { path: p }, ctx);
      assert.match(out, /report\.pdf: pages 1-2 of 2/);
      assert.match(out, /--- Page 1 ---\nHello world/);
      assert.match(out, /--- Page 2 ---\nPage two text/);
    }
  });

  it("reads the file itself with pdftotext when it is installed", { skip: !PDFTOTEXT && "pdftotext is not installed here" }, async () => {
    pdf.__setPdftotextForTests(PDFTOTEXT);
    try {
      put("poppler's.pdf", makePdf({ pages: ["Read in place", "By poppler"], compress: true }));
      const out = await executeTool("pdf_read", { path: "uploads/poppler's.pdf", pages: "2" }, ctx);
      assert.match(out, /poppler's\.pdf: pages 2-2 of 2/);
      assert.match(out, /--- Page 2 ---\nBy poppler/);
    } finally {
      pdf.__setPdftotextForTests(null);
    }
  });

  it("reads only the pages asked for", async () => {
    put("three.pdf", makePdf({ pages: ["First page", "Second page", "Third page"] }));
    const two = await executeTool("pdf_read", { path: "uploads/three.pdf", pages: "2" }, ctx);
    assert.match(two, /pages 2-2 of 3|page 2 of 3/);
    assert.match(two, /Second page/);
    assert.doesNotMatch(two, /First page|Third page/);
    const rest = await executeTool("pdf_read", { path: "uploads/three.pdf", pages: "2-" }, ctx);
    assert.match(rest, /Second page[\s\S]*Third page/);
    const none = await executeTool("pdf_read", { path: "uploads/three.pdf", pages: "8" }, ctx);
    assert.match(none, /^pdf_read error: .*3 pages/);
  });

  it("stops a long PDF at a page edge and says which pages to ask for next", async () => {
    const pages = Array.from({ length: 30 }, (_, i) => longPage(i + 1));
    put("long.pdf", makePdf({ pages, compress: true }));
    const out = await executeTool("pdf_read", { path: "uploads/long.pdf" }, ctx);
    assert.ok(out.length < 12_000, `the default answer is ${out.length} characters, over what a tool result shows inline`);
    const shown = Number(/pages 1-(\d+) of 30/.exec(out)?.[1]);
    assert.ok(shown >= 5 && shown < 30, `showed up to page ${shown}`);
    assert.ok(out.includes(`--- Page ${shown} ---`));
    assert.ok(!out.includes(`--- Page ${shown + 1} ---`));
    assert.ok(out.includes(`pages "${shown + 1}-30"`), "it does not say which pages to ask for next");
    const more = await executeTool("pdf_read", { path: "uploads/long.pdf", pages: `${shown + 1}-`, max_chars: 50_000 }, ctx);
    assert.ok(more.includes(`--- Page ${shown + 1} ---`));
    assert.ok(more.length > out.length);
  });

  it("says when no text could be taken out (scanned pages)", async () => {
    put("scan.pdf", makePdf({ pages: ["", ""] }));
    const out = await executeTool("pdf_read", { path: "uploads/scan.pdf" }, ctx);
    assert.match(out, /no text/i);
    assert.match(out, /scanned/i);
  });

  it("refuses a file outside the workspace, a protected name, a non-PDF and a missing file", async () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "doc.pdf"), makePdf({ pages: ["Outside"] }));
    assert.match(await executeTool("pdf_read", { path: path.join(outside, "doc.pdf") }, ctx), /^pdf_read error: .*outside the workspace/);
    assert.match(await executeTool("pdf_read", { path: "../outside/doc.pdf" }, ctx), /^pdf_read error: .*outside the workspace/);

    fs.writeFileSync(path.join(workspace, ".credentials.json"), makePdf({ pages: ["Nope"] }));
    assert.match(await executeTool("pdf_read", { path: ".credentials.json" }, ctx), /^pdf_read error: .*can't be read/);

    put("notes.txt", "plain words");
    assert.match(await executeTool("pdf_read", { path: "uploads/notes.txt" }, ctx), /^pdf_read error: .*isn't a PDF/);
    assert.match(await executeTool("pdf_read", { path: "uploads/missing.pdf" }, ctx), /^pdf_read error: .*no file/);
    assert.match(await executeTool("pdf_read", {}, ctx), /^pdf_read error: .*path/);
  });

  it("is refused, and audited, when Tool Permissions deny pdf_read", async () => {
    put("deny.pdf", makePdf({ pages: ["Hidden"] }));
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.denied' AND target = 'pdf_read'").get().n;
    getSecurityManager(settings).setToolPermission("pdf_read", "always_deny");
    const out = await executeTool("pdf_read", { path: "uploads/deny.pdf" }, ctx);
    assert.match(out, /Refused by security policy/);
    assert.doesNotMatch(out, /Hidden/);
    const now = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.denied' AND target = 'pdf_read'").get().n;
    assert.equal(now, before + 1);
  });
});

describe("pdf_read from a web address", () => {
  let server;
  let base;
  const hits = [];
  const body = makePdf({ pages: ["From the web"] });
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url === "/doc.pdf") { res.writeHead(200, { "Content-Type": "application/pdf" }); res.end(body); return; }
      if (req.url === "/hop") { res.writeHead(302, { Location: "/doc.pdf" }); res.end(); return; }
      if (req.url === "/to-private") { res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/doc.pdf` }); res.end(); return; }
      if (req.url === "/huge") { res.writeHead(200); res.end(Buffer.alloc(4096, 0x41)); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  beforeEach(() => {
    hits.length = 0;
    pdf.__setPdftotextForTests(null);
    getSecurityManager(settings).setToolPermission("pdf_read", "always_allow");
  });

  /** A lookup that answers 127.0.0.1 for pdfs.test only, the guarded one for everything else. */
  const testLookup = (hostname, options, cb) => {
    if (hostname !== "pdfs.test") return pdf.guardedLookup(hostname, options, cb);
    return options?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  };

  it("refuses a loopback or private address, and sends it nothing", async () => {
    const out = await executeTool("pdf_read", { path: `${base}/doc.pdf` }, ctx);
    assert.match(out, /^pdf_read error: .*(private|local)/i);
    assert.equal(hits.length, 0, "a refused address was still asked");
  });

  it("knows the private, loopback and link-local ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::"]) {
      assert.equal(pdf.isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "172.32.0.1"]) {
      assert.equal(pdf.isPrivateAddress(ip), false, ip);
    }
  });

  it("downloads a PDF, following a redirect", async () => {
    const port = server.address().port;
    const buf = await pdf.fetchPdf(`http://pdfs.test:${port}/hop`, { lookup: testLookup });
    assert.deepEqual(buf, body);
    assert.deepEqual(hits, ["/hop", "/doc.pdf"]);
  });

  it("refuses a redirect to a private address", async () => {
    const port = server.address().port;
    await assert.rejects(pdf.fetchPdf(`http://pdfs.test:${port}/to-private`, { lookup: testLookup }), /private|local/i);
    assert.deepEqual(hits, ["/to-private"]);
  });

  it("refuses a download over the size cap", async () => {
    const port = server.address().port;
    await assert.rejects(pdf.fetchPdf(`http://pdfs.test:${port}/huge`, { lookup: testLookup, maxBytes: 1024 }), /too big|over/i);
  });
});

describe("tarsee_pdf_read (MCP)", () => {
  /** Connect an MCP client to the Tarsee server, call a tool and return its text; or list the tools. */
  async function withClient(fn) {
    const server = createTarseeMcp(ctx);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
    try { return await fn(client); } finally { await client.close(); }
  }
  const call = (args) => withClient(async (c) => (await c.callTool({ name: "tarsee_pdf_read", arguments: args })).content.map((x) => x.text).join("\n"));

  beforeEach(() => {
    pdf.__setPdftotextForTests(null);
    getSecurityManager(settings).setToolPermission("pdf_read", "always_allow");
  });

  it("is listed with path required and pages optional", async () => {
    const tools = await withClient((c) => c.listTools());
    const t = tools.tools.find((x) => x.name === "tarsee_pdf_read");
    assert.ok(t, "tarsee_pdf_read is not listed");
    assert.deepEqual(t.inputSchema.required, ["path"]);
    assert.ok(t.inputSchema.properties.pages);
  });

  it("reads a PDF through executeTool", async () => {
    put("mcp.pdf", makePdf({ pages: ["Through the MCP tool", "Page two"] }));
    const out = await call({ path: "uploads/mcp.pdf", pages: "1" });
    assert.match(out, /Through the MCP tool/);
    assert.doesNotMatch(out, /Page two/);
  });

  it("obeys Tool Permissions", async () => {
    put("mcp-deny.pdf", makePdf({ pages: ["Should not show"] }));
    getSecurityManager(settings).setToolPermission("pdf_read", "always_deny");
    const out = await call({ path: "uploads/mcp-deny.pdf" });
    assert.match(out, /Refused by security policy/);
    assert.doesNotMatch(out, /Should not show/);
  });
});
