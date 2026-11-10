// adaptMedia (src/ai/media.js, design 4.12): what a message's pictures, PDFs and voice notes become for the AI that
// answers it, by what that model can take in (provider-registry capsFor). A model that can't see gets the picture
// saved and a note with its path; a model without native PDFs gets the PDF's text inline plus the saved path; a voice
// note becomes its transcript on every AI. The transcriber is a stub; the PDFs are built by the test.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-media-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { adaptMedia, writeLocalImages, PDF_INLINE_CHARS } = await import("../src/ai/media.js");
const { capsFor } = await import("../src/ai/provider-registry.js");
const { __setPdftotextForTests } = await import("../src/lib/pdf-text.js");
const { __setForTests: setStt } = await import("../src/voice/stt-handler.js");
const { makePdf } = await import("./fixtures/make-pdf.js");

__setPdftotextForTests(null);   // the built-in reader, so the test reads the same everywhere
after(() => {
  __setPdftotextForTests();
  setStt();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const AUDIO = Buffer.from("RIFF fake wav bytes for the test");

const image = (bytes = PNG, type = "image/png") => ({ type: "image", source: { type: "base64", media_type: type, data: bytes.toString("base64") } });
const pdfBlock = (bytes) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } });
const audio = (bytes = AUDIO) => ({ type: "audio", source: { type: "base64", media_type: "audio/wav", data: bytes.toString("base64") } });
const text = (t) => ({ type: "text", text: t });

let n = 0;
/** A fresh uploads folder for one test. */
const freshUploads = () => { const d = path.join(tmp, `uploads-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const inside = (dir, p) => path.resolve(p).startsWith(path.resolve(dir) + path.sep);

describe("adaptMedia: PDFs", () => {
  it("a PDF on deepseek becomes inline text plus a path", async () => {
    const caps = capsFor("deepseek", "deepseek-flash");
    assert.equal(caps.pdf, false);
    const uploadsDir = freshUploads();
    const bytes = makePdf({ pages: ["Quarterly revenue grew nine percent", "Costs held flat"], compress: true });
    const r = await adaptMedia([pdfBlock(bytes), text("What does it say?")], caps, { label: "DeepSeek Flash", uploadsDir });

    assert.deepEqual(r.media, [], "a PDF block went to a model that can't take one");
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].kind, "pdf");
    assert.ok(inside(uploadsDir, r.saved[0].path), `saved outside the uploads folder: ${r.saved[0].path}`);
    assert.deepEqual(fs.readFileSync(r.saved[0].path), bytes);
    assert.ok(r.text.includes(r.saved[0].path), "the note does not give the saved path");
    assert.match(r.text, /DeepSeek Flash can't read PDF/);
    assert.match(r.text, /Quarterly revenue grew nine percent/);
    assert.match(r.text, /Costs held flat/);
    assert.match(r.text, /What does it say\?$/, "the person's own words come after the note");
    assert.equal(typeof r.content, "string", "with nothing kept, the message is plain text");
  });

  it("a long PDF is cut at about 30,000 characters and points at tarsee_pdf_read for the rest", async () => {
    const pages = Array.from({ length: 40 }, (_, i) => `Page ${i + 1}. ${"Long words keep going on this page. ".repeat(40)}`);
    const r = await adaptMedia([pdfBlock(makePdf({ pages, compress: true }))], capsFor("deepseek", "deepseek-flash"), { label: "DeepSeek Flash", uploadsDir: freshUploads() });
    assert.ok(r.text.length < PDF_INLINE_CHARS + 2_000, `inlined ${r.text.length} characters`);
    assert.ok(r.text.length > PDF_INLINE_CHARS * 0.8, `inlined only ${r.text.length} characters`);
    assert.match(r.text, /tarsee_pdf_read/);
    const last = Number(/pages 1-(\d+) of 40/.exec(r.text)?.[1]);
    assert.ok(last > 1 && last < 40, "it does not say how far the text goes");
    assert.ok(r.text.includes(`pages "${last + 1}-40"`), "it does not say which pages are left");
  });

  it("a PDF with no text in it (scanned pages) says so and gives the path", async () => {
    const r = await adaptMedia([pdfBlock(makePdf({ pages: [""] }))], capsFor("deepseek", "deepseek-flash"), { label: "DeepSeek Flash", uploadsDir: freshUploads() });
    assert.match(r.text, /no text could be taken out/i);
    assert.ok(r.text.includes(r.saved[0].path));
  });

  it("a PDF on the Claude plan stays a native PDF", async () => {
    const uploadsDir = freshUploads();
    const bytes = makePdf({ pages: ["Native"] });
    const r = await adaptMedia([pdfBlock(bytes), text("Read this")], capsFor("claude", "opus"), { label: "Claude", uploadsDir });
    assert.equal(r.media.length, 1);
    assert.equal(r.media[0].type, "document");
    assert.equal(r.media[0].source.data, bytes.toString("base64"));
    assert.equal(r.text, "Read this");
    assert.deepEqual(r.saved, []);
    assert.deepEqual(fs.readdirSync(uploadsDir), []);
    assert.deepEqual(r.content, [r.media[0], { type: "text", text: "Read this" }]);
  });
});

describe("adaptMedia: pictures", () => {
  it("an image on deepseek-v4-pro becomes the saved-path note", async () => {
    const caps = capsFor("deepseek", "deepseek-v4-pro");
    assert.equal(caps.vision, false);
    const uploadsDir = freshUploads();
    const r = await adaptMedia([image(), text("What is this?")], caps, { label: "DeepSeek Pro", uploadsDir });
    assert.deepEqual(r.media, []);
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].kind, "image");
    assert.match(r.saved[0].path, /\.png$/);
    assert.ok(inside(uploadsDir, r.saved[0].path));
    assert.deepEqual(fs.readFileSync(r.saved[0].path), PNG);
    assert.match(r.text, /DeepSeek Pro can't see images/);
    assert.ok(r.text.includes(r.saved[0].path));
    assert.match(r.text, /What is this\?$/);
  });

  it("an image on a model that sees stays a picture", async () => {
    const uploadsDir = freshUploads();
    const r = await adaptMedia([image(), text("Look")], capsFor("deepseek", "deepseek-flash"), { label: "DeepSeek Flash", uploadsDir });
    assert.equal(r.media.length, 1);
    assert.deepEqual(r.media[0], image());
    assert.deepEqual(r.saved, []);
    assert.equal(r.text, "Look");
  });

  it("a kind of picture the model can't open is saved with a note", async () => {
    const r = await adaptMedia([image(PNG, "image/heic")], capsFor("claude", "opus"), { label: "Claude", uploadsDir: freshUploads() });
    assert.deepEqual(r.media, []);
    assert.match(r.saved[0].path, /\.heic$/);
    assert.match(r.text, /can't open/);
  });

  it("Codex gets the pictures it sees as image files, removed afterwards", async () => {
    const caps = capsFor("openai", "gpt-6.1-sol");
    assert.equal(caps.vision, true);
    const r = await adaptMedia([image(), image(PNG, "image/jpeg"), text("Compare")], caps, { label: "GPT-6.1 Sol", uploadsDir: freshUploads() });
    assert.equal(r.media.length, 2);
    const files = writeLocalImages(r.media);
    try {
      assert.equal(files.inputs.length, 2);
      assert.deepEqual(files.inputs.map((x) => x.type), ["local_image", "local_image"]);
      assert.match(files.inputs[0].path, /\.png$/);
      assert.match(files.inputs[1].path, /\.jpg$/);
      for (const x of files.inputs) assert.deepEqual(fs.readFileSync(x.path), PNG);
    } finally {
      files.cleanup();
    }
    for (const x of files.inputs) assert.equal(fs.existsSync(x.path), false, "a temp image was left behind");
  });

  it("keeps the chat's pictures with the conversation (noteMediaBlocks) and points at that copy", async () => {
    const uploadsDir = freshUploads();
    const kept = path.join(uploadsDir, "chat-1-0-image.png");
    fs.writeFileSync(kept, PNG);
    const calls = [];
    const noteMediaBlocks = (conv, blocks, opts) => { calls.push({ conv, blocks, opts }); return [{ path: kept, name: "image.png", size: PNG.length }]; };
    const r = await adaptMedia([image()], capsFor("deepseek", "deepseek-v4-pro"), { label: "DeepSeek Pro", uploadsDir, conversationId: "conv-1", messageId: "msg-9", noteMediaBlocks });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].conv, "conv-1");
    assert.equal(calls[0].opts.messageId, "msg-9");
    assert.equal(calls[0].blocks.length, 1);
    assert.ok(r.text.includes(kept), "the note does not point at the copy kept with the chat");
    assert.deepEqual(fs.readdirSync(uploadsDir), ["chat-1-0-image.png"], "a second copy was written");
  });

  it("points at the copy already kept with the person's message instead of saving another", async () => {
    // The dashboard kept the upload with the message, or the turn layer already called noteMediaBlocks.
    const uploadsDir = freshUploads();
    const keptPdf = path.join(uploadsDir, "chat-1-0-report.pdf");
    const keptPic = path.join(uploadsDir, "chat-1-1-image.png");
    const bytes = makePdf({ pages: ["Kept already"] });
    fs.writeFileSync(keptPdf, bytes);
    fs.writeFileSync(keptPic, PNG);
    const rows = [
      { from: "in", messageId: "msg-1", name: "report.pdf", size: bytes.length, path: keptPdf },
      { from: "in", messageId: "msg-1", name: "image.png", size: PNG.length, path: keptPic },
      { from: "in", messageId: "msg-0", name: "other.png", size: PNG.length, path: path.join(uploadsDir, "nope.png") },
    ];
    const r = await adaptMedia([pdfBlock(bytes), image(), text("Both")], capsFor("deepseek", "deepseek-v4-pro"), {
      label: "DeepSeek Pro", uploadsDir, conversationId: "conv-3", messageId: "msg-1",
      noteMediaBlocks: () => [], chatFilesFor: (conv) => (conv === "conv-3" ? rows : []),
    });
    assert.ok(r.text.includes(keptPdf), "the PDF note does not point at the kept copy");
    assert.ok(r.text.includes(keptPic), "the picture note does not point at the kept copy");
    assert.match(r.text, /Kept already/);
    assert.deepEqual(fs.readdirSync(uploadsDir).sort(), ["chat-1-0-report.pdf", "chat-1-1-image.png"], "a second copy was written");
  });

  it("finds the dashboard's kept upload in the real chat-files table", async () => {
    const { initDb } = await import("../src/db/sqlite.js");
    const { ConversationStore } = await import("../src/db/conversations.js");
    const { initChatFiles, __resetChatFiles, chatFilesFor } = await import("../src/lib/chat-files.js");
    const { keepUploadedFiles, noteReceivedFiles, uploadsDir } = await import("../src/lib/sent-files.js");
    const db = initDb(path.join(tmp, "media.db"));
    try {
      initChatFiles(db);
      const convs = new ConversationStore(db);
      const conv = convs.create({ title: "media" });
      const msg = convs.addMessage(conv.id, { role: "user", content: "see attached" });
      const bytes = makePdf({ pages: ["Uploaded on the dashboard"] });
      const kept = keepUploadedFiles([{ name: "plan.pdf", buffer: bytes }]);
      noteReceivedFiles({ conversationId: conv.id, messageId: msg.id, files: kept, via: "web" });
      const before = fs.readdirSync(uploadsDir()).length;

      const r = await adaptMedia([pdfBlock(bytes), text("see attached")], capsFor("deepseek", "deepseek-flash"), { label: "DeepSeek Flash", conversationId: conv.id, messageId: msg.id });
      assert.ok(r.text.includes(kept[0].path), "the note does not point at the dashboard's copy");
      assert.match(r.text, /Uploaded on the dashboard/);
      assert.equal(fs.readdirSync(uploadsDir()).length, before, "a second copy was written");
      assert.equal(chatFilesFor(conv.id).length, 1);
    } finally {
      __resetChatFiles();
      db.close();
    }
  });

  it("adapting the same message again (a retry) reuses what it saved the first time", async () => {
    const uploadsDir = freshUploads();
    const content = [pdfBlock(makePdf({ pages: ["Once only"] })), image(), audio()];
    const ctx = { label: "DeepSeek Pro", uploadsDir, transcribe: async () => { throw new Error("no speech-to-text"); } };
    const first = await adaptMedia(content, capsFor("deepseek", "deepseek-v4-pro"), ctx);
    const second = await adaptMedia(content, capsFor("deepseek", "deepseek-v4-pro"), ctx);
    assert.equal(first.saved.length, 3);
    assert.deepEqual(second.saved.map((s) => s.path), first.saved.map((s) => s.path));
    assert.equal(fs.readdirSync(uploadsDir).length, 3);
  });

  it("still shows a seeing model's pictures in the chat", async () => {
    const calls = [];
    const noteMediaBlocks = (conv, blocks) => { calls.push(blocks.length); return []; };
    const r = await adaptMedia([image()], capsFor("claude", "opus"), { label: "Claude", uploadsDir: freshUploads(), conversationId: "conv-2", noteMediaBlocks });
    assert.deepEqual(calls, [1]);
    assert.equal(r.media.length, 1);
  });
});

describe("adaptMedia: voice notes", () => {
  it("audio becomes a transcript (transcriber stubbed)", async () => {
    const calls = [];
    const settingsStore = { get: () => null };
    const transcribe = async (buf, lang, opts) => { calls.push({ buf, lang, opts }); return { transcript: " remind me at five " }; };
    const uploadsDir = freshUploads();
    const r = await adaptMedia([audio(), text("(voice)")], capsFor("deepseek", "deepseek-flash"), { label: "DeepSeek Flash", uploadsDir, transcribe, settingsStore });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].buf, AUDIO);
    assert.equal(calls[0].opts.settingsStore, settingsStore);
    assert.match(r.text, /^\[Voice note transcript\] remind me at five\n\n\(voice\)$/);
    assert.deepEqual(r.media, []);
    assert.deepEqual(r.saved, []);
  });

  it("is transcribed on the Claude plan too (no AI takes audio as it is)", async () => {
    const r = await adaptMedia([audio()], capsFor("claude", "opus"), { label: "Claude", uploadsDir: freshUploads(), transcribe: async () => ({ transcript: "hello" }) });
    assert.equal(r.text, "[Voice note transcript] hello");
    assert.deepEqual(r.media, []);
  });

  it("uses the local speech-to-text by default", async () => {
    setStt({ local: { available: () => true, transcribe: async (buf) => ({ transcript: `heard ${buf.length} bytes` }) } });
    try {
      const r = await adaptMedia([audio()], capsFor("deepseek", "deepseek-flash"), { label: "DeepSeek Flash", uploadsDir: freshUploads(), settingsStore: { get: () => null } });
      assert.equal(r.text, `[Voice note transcript] heard ${AUDIO.length} bytes`);
    } finally {
      setStt();
    }
  });

  it("hands speech-to-text the turn's settings store under either name (settingsStore, or the turn layer's store)", async () => {
    const store = { get: () => null };
    const seen = [];
    const transcribe = async (buf, lang, opts) => { seen.push(opts.settingsStore); return { transcript: "ok" }; };
    await adaptMedia([audio()], capsFor("deepseek", "deepseek-flash"), { uploadsDir: freshUploads(), transcribe, store });
    await adaptMedia([audio()], capsFor("deepseek", "deepseek-flash"), { uploadsDir: freshUploads(), transcribe, settingsStore: store });
    assert.deepEqual(seen, [store, store]);
  });

  it("audio that can't be transcribed is saved, with a note saying why", async () => {
    const transcribe = async () => { throw new Error("Speech-to-text is unavailable: local transcription is not installed"); };
    const uploadsDir = freshUploads();
    const r = await adaptMedia([audio()], capsFor("deepseek", "deepseek-flash"), { label: "DeepSeek Flash", uploadsDir, transcribe });
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].kind, "audio");
    assert.deepEqual(fs.readFileSync(r.saved[0].path), AUDIO);
    assert.match(r.text, /couldn't be transcribed/);
    assert.match(r.text, /not installed/);
    assert.ok(r.text.includes(r.saved[0].path));
  });

  it("an empty transcript says nothing could be made out", async () => {
    const r = await adaptMedia([audio()], capsFor("deepseek", "deepseek-flash"), { label: "DeepSeek Flash", uploadsDir: freshUploads(), transcribe: async () => ({ transcript: "  " }) });
    assert.match(r.text, /nothing could be made out/i);
  });
});

describe("adaptMedia: plain messages", () => {
  it("passes plain text through", async () => {
    const r = await adaptMedia("just words", capsFor("deepseek", "deepseek-flash"), {});
    assert.equal(r.text, "just words");
    assert.equal(r.content, "just words");
    assert.deepEqual(r.media, []);
  });

  it("treats a model it knows nothing about as seeing no pictures and reading no PDFs", async () => {
    const r = await adaptMedia([image(), pdfBlock(makePdf({ pages: ["Unknown caps"] }))], null, { uploadsDir: freshUploads() });
    assert.deepEqual(r.media, []);
    assert.equal(r.saved.length, 2);
    assert.match(r.text, /This AI can't see images/);
    assert.match(r.text, /Unknown caps/);
  });

  it("saves into the workspace's uploads folder by default", async () => {
    const r = await adaptMedia([image()], capsFor("deepseek", "deepseek-v4-pro"), { label: "DeepSeek Pro" });
    assert.ok(inside(path.join(process.env.TARSEE_WORKSPACE_DIR, "uploads"), r.saved[0].path), r.saved[0].path);
  });
});
