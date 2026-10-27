// The files of a chat, in the dashboard's chat (ported from TarseeMacOS): every file the agent sends is kept with the
// chat (src/lib/chat-files.js, src/lib/sent-files.js) and the history and the live feed bring it, on the reply of the
// turn that sent it; files people send in are kept on their message; each opens from GET /api/chat/file, which only
// serves the uploads folder. The pure parts of the page (public/js/file-viewer-core.js) are tested here too.
// Nothing reaches Telegram, Discord or email: the channel manager and the email bot are stand-ins.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-chat-files-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const live = await import("../src/lib/live-bus.js");
const chatFiles = await import("../src/lib/chat-files.js");
const sentFiles = await import("../src/lib/sent-files.js");
const { executeTool } = await import("../src/lib/tools.js");
const { chatRouter } = await import("../src/routes/chat.js");
const core = await import("../src/public/js/file-viewer-core.js");
const { default: config } = await import("../src/config/env.js");

const db = initDb(path.join(tmp, "files.db"));
live.initLiveBus(db);
chatFiles.initChatFiles(db);
const settings = new SettingsStore(db);
const store = new ConversationStore(db);
const uploads = path.join(config.WORKSPACE_DIR, "uploads");
const outside = path.join(tmp, "deliverables");
fs.mkdirSync(outside, { recursive: true });
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const rowsOf = (conv) => db.prepare("SELECT * FROM chat_files WHERE conversation_id = ? ORDER BY id").all(conv);
const filesEvents = (conv) => live.recentEvents(conv, 300).filter((e) => e.type === "files");
const write = (name, body = "x") => { const p = path.join(outside, name); fs.writeFileSync(p, body); return p; };
const say = (conv, role, content) => store.addMessage(conv, { role, content }).id;

// A Telegram chat, a forum topic of another, the dashboard's own chat, and a quiet Discord channel.
const telegram = store.create({ title: "telegram:777" }).id;
const topic = store.create({ title: "telegram:-1009:topic:4" }).id;
const web = store.create({ title: "Web Chat" }).id;
const quiet = store.create({ title: "#quiet" }).id;
settings.set("channel_conv.telegram:777", telegram);
settings.set("channel_conv.telegram:-1009:topic:4", topic);
settings.set("channel_conv.web:default", web);
settings.set("channel_conv.discord:1430000000000000003", quiet);

const sent = [];
let refuse = false;
const emailed = [];
const channelManager = {
  async sendFile(type, chatId, filePath, caption, opts) { if (refuse) throw new Error("Telegram said no"); sent.push({ type, chatId, filePath, caption, opts }); },
  channels: new Map([["email", { bot: { sendNew: async (o) => { emailed.push(o); return { messageId: "<m1@x>", attachmentCount: (o.attachments || []).length }; } } }]]),
};
const ctxFor = (conversationId) => ({ db, settingsStore: settings, channelManager, conversationId });

let server, base;
before(async () => {
  const app = express();
  app.set("db", db);
  app.use(express.json({ limit: "20mb" }));
  app.use((req, _res, next) => { req.auth = { authenticated: req.get("x-test-who") !== "nobody" }; next(); });
  app.use("/api/chat", (req, res, next) => (req.auth.authenticated ? next() : res.status(401).json({ error: "Authentication required" })), chatRouter);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
const history = async (conv, q = "") => (await fetch(`${base}/api/chat/conversations/${conv}${q}`)).json();
const fileUrl = (p, extra = "") => `${base}${core.serverFile({ path: p }).url}${extra}`;

describe("what the agent sends into a chat is kept with that chat", () => {
  let turnId;
  it("send_file during a turn: a copy in the uploads folder, on the chat it went to, with the turn's id, on the live feed", async () => {
    say(telegram, "user", "give me the october report");
    turnId = live.newTurnId();
    live.publish(telegram, "turn_start", { source: "telegram" }, { turnId });
    const report = write("October Report.html", "<h1>October</h1>");
    const out = await executeTool("send_file", { channel: "telegram", file_path: report, caption: "Here it is" }, ctxFor(telegram));
    assert.match(out, /^File sent to telegram \(chat 777\)/);
    assert.equal(sent.at(-1).filePath, report, "the bot uploads the file itself");
    const [row] = rowsOf(telegram);
    assert.equal(row.direction, "out");
    assert.equal(row.turn_id, turnId);
    assert.equal(row.via, "telegram");
    assert.equal(row.caption, "Here it is");
    assert.ok(row.path.startsWith(uploads + path.sep) && /^sent-\d{13}-October Report\.html$/.test(path.basename(row.path)), row.path);
    assert.equal(fs.readFileSync(row.path, "utf8"), "<h1>October</h1>");
    const evt = filesEvents(telegram).at(-1);
    assert.equal(evt.turnId, turnId);
    assert.deepEqual(evt.payload.files.map((f) => f.name), ["October Report.html"]);
    assert.equal(evt.payload.from, "agent");
  });

  it("the dashboard's history has it on the reply of that turn (attached above), and opens it", async () => {
    say(telegram, "assistant", "Here's the report");
    live.publish(telegram, "turn_end", { stopReason: "end_turn" }, { turnId });
    const h = await history(telegram);
    const reply = h.messages.at(-1);
    assert.equal(reply.role, "assistant");
    assert.deepEqual(reply.files.map((f) => [f.name, f.from, f.gone]), [["October Report.html", "agent", false]]);
    const res = await fetch(`${base}${reply.files[0].url}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", "a web page is shown as text, never run");
    assert.match(res.headers.get("content-security-policy"), /^sandbox/);
    assert.equal(await res.text(), "<h1>October</h1>");
    const dl = await fetch(`${base}${reply.files[0].url}&dl=1`);
    assert.match(dl.headers.get("content-disposition"), /^attachment; filename="October Report\.html"/);
  });

  it("from a forum topic: into that topic, kept with its conversation; to another chat: kept with that chat's", async () => {
    say(topic, "user", "anyone have the deck?");
    const deck = write("deck.pdf", "%PDF-1.4");
    await executeTool("send_file", { channel: "telegram", file_path: deck }, ctxFor(topic));
    assert.deepEqual([sent.at(-1).chatId, sent.at(-1).opts], ["-1009", { threadId: "4" }], "into the topic");
    assert.equal(rowsOf(topic).length, 1);
    const h = await history(topic);
    assert.deepEqual(h.messages.at(-1).filesAfter.map((f) => f.name), ["deck.pdf"], "no turn of its own there: a row after its latest message");
    // The group's own chat has no conversation here: the file is kept with the chat the agent was working in.
    const n = rowsOf(telegram).length;
    await executeTool("send_file", { channel: "telegram", channel_id: "-1009", file_path: deck }, ctxFor(telegram));
    assert.deepEqual(sent.at(-1).opts, { threadId: null }, "a bare group id is the group's own chat, not a topic of it");
    assert.equal(rowsOf(topic).length, 1);
    assert.equal(rowsOf(telegram).length, n + 1);
  });

  it("into a chat with nothing said yet: before every message (leadFiles), only on a page that starts at the beginning", async () => {
    await executeTool("send_file", { channel: "discord", channel_id: "1430000000000000003", file_path: write("hello.txt", "hi") }, ctxFor(telegram));
    say(quiet, "user", "thanks");
    assert.deepEqual((await history(quiet)).leadFiles.map((f) => f.name), ["hello.txt"]);
  });

  it("to the dashboard's own chat (web): kept there, no app is asked to upload anything", async () => {
    const before = sent.length;
    const out = await executeTool("send_file", { channel: "web", file_path: write("summary.csv", "a,b\n1,2\n") }, ctxFor(telegram));
    assert.match(out, /^File sent to the dashboard chat: summary\.csv/);
    assert.equal(sent.length, before);
    assert.deepEqual(rowsOf(web).map((r) => [r.name, r.via]), [["summary.csv", "web"]]);
  });

  it("from a dashboard turn in any chat (a Telegram chat opened in the dashboard): on that chat, the one on screen", async () => {
    const n = rowsOf(telegram).length;
    const out = await executeTool("send_file", { channel: "web", file_path: write("on-screen.txt", "here") }, { ...ctxFor(telegram), dashboard: true });
    assert.match(out, /^File sent to the dashboard chat: on-screen\.txt/);
    assert.equal(rowsOf(telegram).length, n + 1);
    assert.equal(rowsOf(telegram).at(-1).name, "on-screen.txt");
  });

  it("the files it emails: on the conversation it sent them from, said so", async () => {
    const pdf = write("invoice.pdf", "%PDF-1.4");
    const out = await executeTool("send_email_thread", { to: "sam@example.com", subject: "Invoice", body: "Attached.", attachments: [pdf] }, ctxFor(telegram));
    assert.match(out, /with 1 attachment/);
    assert.deepEqual(emailed.at(-1).attachments, [pdf]);
    const row = rowsOf(telegram).at(-1);
    assert.deepEqual([row.name, row.via, row.caption], ["invoice.pdf", "email", "Emailed to sam@example.com"]);
  });

  it("a send that failed keeps nothing", async () => {
    const n = rowsOf(telegram).length;
    refuse = true;
    try {
      assert.match(await executeTool("send_file", { channel: "telegram", file_path: write("nope.zip", "PK") }, ctxFor(telegram)), /send_file error: Telegram said no/);
    } finally { refuse = false; }
    assert.equal(rowsOf(telegram).length, n);
  });
});

describe("the history puts each file in its place (placeFiles)", () => {
  const msgs = () => [
    { id: "u1", role: "user", created_at: "2026-10-27 01:00:00" },
    { id: "a1", role: "assistant", created_at: "2026-10-27 01:02:00" },
    { id: "u2", role: "user", created_at: "2026-10-27 05:00:00" },
  ];
  const at = (s) => chatFiles.msOf(s);
  it("the agent's on the next reply when its turn sent it; otherwise a row after its message; a person's on their message", () => {
    const placed = chatFiles.placeFiles(msgs(), [
      { name: "turn.pdf", from: "agent", turnId: "t1", afterMessageId: "u1", at: at("2026-10-27 01:01:00") },
      { name: "loose.pdf", from: "agent", turnId: null, afterMessageId: "u1", at: at("2026-10-27 01:01:00") },
      { name: "photo.jpg", from: "in", messageId: "u2", at: at("2026-10-27 05:00:00") },
    ]);
    const [u1, a1, u2] = placed.messages;
    assert.deepEqual(a1.files.map((f) => f.name), ["turn.pdf"]);
    assert.deepEqual(u1.filesAfter.map((f) => f.name), ["loose.pdf"]);
    assert.deepEqual(u2.files.map((f) => f.name), ["photo.jpg"]);
  });

  it("not on a reply that came hours later; a file whose message is gone goes by its time; a later page leaves older files", () => {
    const late = chatFiles.placeFiles(msgs(), [{ name: "x.pdf", from: "agent", turnId: "t1", afterMessageId: "a1", at: at("2026-10-27 01:03:00") }]);
    assert.deepEqual(late.messages[1].filesAfter.map((f) => f.name), ["x.pdf"], "the next reply came 4 hours after it");
    const gone = chatFiles.placeFiles(msgs(), [{ name: "y.pdf", from: "agent", afterMessageId: "deleted", at: at("2026-10-27 01:30:00") }]);
    assert.deepEqual(gone.messages[1].filesAfter.map((f) => f.name), ["y.pdf"]);
    const page = chatFiles.placeFiles(msgs().slice(2), [{ name: "old.pdf", from: "in", messageId: "u1", at: at("2026-10-27 01:00:00") }], { complete: false });
    assert.deepEqual(page.leadFiles, []);
    assert.equal(page.messages[0].files, undefined);
  });

  it("a copy tidied away is marked gone; /clear and a deleted chat take their rows", async () => {
    const conv = store.create({ title: "tidy" }).id;
    say(conv, "user", "hi");
    const [row] = chatFiles.recordChatFiles(conv, [{ name: "old.txt", size: 2, path: path.join(uploads, "sent-1000000000000-old.txt") }], { direction: "out" });
    assert.equal(row.gone, true);
    assert.equal(chatFiles.forgetChatFiles(conv), 1);
    const doomed = store.create({ title: "doomed" }).id;
    say(doomed, "user", "hi");
    sentFiles.noteSentFile({ absPath: write("doomed.txt"), conversationId: doomed });
    assert.equal(rowsOf(doomed).length, 1);
    assert.equal((await fetch(`${base}/api/chat/conversations/${doomed}`, { method: "DELETE" })).status, 200);
    assert.equal(rowsOf(doomed).length, 0);
  });

  it("copies over 30 days old are cleared out as new ones come; other files in the folder are left alone", () => {
    const now = Date.now();
    const old = path.join(uploads, `sent-${now - 31 * 86_400_000}-old.pdf`);
    const fresh = path.join(uploads, `chat-${now - 86_400_000}-0-fresh.pdf`);
    const theirs = path.join(uploads, "telegram-1000000000000-theirs.pdf");
    for (const f of [old, fresh, theirs]) fs.writeFileSync(f, "x");
    sentFiles.tidyKeptFiles(uploads, now);
    assert.deepEqual([old, fresh, theirs].map((f) => fs.existsSync(f)), [false, true, true]);
  });
});

describe("files people send in show too", () => {
  it("an upload in the dashboard's chat: each file kept on its message, the page told", () => {
    const id = say(web, "user", "(sent 2 files)");
    const kept = sentFiles.keepUploadedFiles([{ name: "../../a b.png", buffer: Buffer.from("png") }, { name: "notes.md", buffer: Buffer.from("# hi") }]);
    assert.deepEqual(kept.map((k) => path.dirname(k.path)), [uploads, uploads], "never out of the folder, whatever the name");
    assert.deepEqual(kept.map((k) => k.name), ["a b.png", "notes.md"]);
    sentFiles.noteReceivedFiles({ conversationId: web, messageId: id, files: kept, via: "web" });
    assert.deepEqual(rowsOf(web).filter((r) => r.message_id === id).map((r) => r.direction), ["in", "in"]);
    const evt = filesEvents(web).at(-1);
    assert.equal(evt.payload.from, "in");
    assert.equal(evt.payload.messageId, id);
  });

  it("a picture a channel hands the agent as bytes: kept on the person's message; not twice; a PDF is left to its note", () => {
    const conv = store.create({ title: "telegram:888" }).id;
    const id = say(conv, "user", "what is this?");
    const png = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png-bytes").toString("base64") } };
    const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" } };
    const rows = sentFiles.noteMediaBlocks(conv, [png, pdf]);
    assert.deepEqual(rows.map((r) => [r.name, r.messageId, r.from]), [["image.png", id, "in"]]);
    assert.equal(fs.readFileSync(rows[0].path, "utf8"), "png-bytes");
    assert.deepEqual(sentFiles.noteMediaBlocks(conv, [png]), [], "that message has its files already");
    // A turn that waited behind another: its picture goes on the message it answers, not the one that came in since.
    const withPhoto = say(conv, "user", "[photo]");
    const later = say(conv, "user", "what's this?");
    const kept = sentFiles.noteMediaBlocks(conv, [png], { messageId: withPhoto });
    assert.deepEqual(kept.map((r) => r.messageId), [withPhoto]);
    assert.notEqual(withPhoto, later);
  });

  it("the channels' notes in a message are its files: Telegram's, Discord's, an email's, WhatsApp's", () => {
    const up = (n) => path.join(uploads, n);
    const msg = [
      "[tg_user]: see these",
      `[PDF attached: Q3 report.pdf (84KB) → ${up("telegram-1-Q3_report.pdf")}] — multimodal PDF block provided above; you can also Read this file directly at the path.`,
      `[Attached file saved: sheet.csv (text/csv, 2KB) → ${up("discord-2-sheet.csv")}]`,
      `You can read this file with the Read tool at: ${up("discord-2-sheet.csv")}`,
      `[Email attachment saved: deck.pptx (application/vnd.ms-powerpoint, 1KB) → ${up("email-3-deck.pptx")}]`,
      `[PDF saved: menu.pdf (12KB) → ${up("whatsapp-4-menu.pdf")}]`,
      `[Video saved: (900KB) → ${up("whatsapp-5-clip.mp4")}] You can read this file with the Read tool.`,
    ].join("\n");
    const { text, files } = core.splitNotes(msg);
    assert.equal(text, "[tg_user]: see these");
    assert.deepEqual(files.map((f) => [f.name, f.size]), [["Q3 report.pdf", 84 * 1024], ["sheet.csv", 2048], ["deck.pptx", 1024], ["menu.pdf", 12 * 1024], ["clip.mp4", 900 * 1024]]);
    assert.ok(files.every((f) => f.url.startsWith("/api/chat/file?p=")));
  });
});

describe("GET /api/chat/file: only the uploads folder", () => {
  it("nothing outside it, no way out of it, no link out of it, signed out nothing", async () => {
    const secret = write("secret.txt", "secret");
    assert.equal((await fetch(fileUrl(secret))).status, 404);
    assert.equal((await fetch(fileUrl(path.join(uploads, "..", "..", "deliverables", "secret.txt")))).status, 404);
    fs.symlinkSync(secret, path.join(uploads, "link.txt"));
    assert.equal((await fetch(fileUrl(path.join(uploads, "link.txt")))).status, 404);
    assert.equal((await fetch(fileUrl(uploads))).status, 404, "nor the folder itself");
    const inside = path.join(uploads, "telegram-6-photo.jpg");
    fs.writeFileSync(inside, "jpg");
    assert.equal((await fetch(fileUrl(inside), { headers: { "x-test-who": "nobody" } })).status, 401);
    const ok = await fetch(fileUrl(inside));
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
    assert.match(ok.headers.get("content-disposition"), /^inline; filename="photo\.jpg"/);
  });

  it("a kind the browser can't show goes as a download; a PDF without the sandbox (its viewer needs to run)", async () => {
    const zip = path.join(uploads, "chat-1-0-bundle.zip");
    fs.writeFileSync(zip, "PK");
    assert.match((await fetch(fileUrl(zip))).headers.get("content-disposition"), /^attachment; filename="bundle\.zip"/);
    const pdf = path.join(uploads, "chat-1-1-doc.pdf");
    fs.writeFileSync(pdf, "%PDF-1.4");
    const res = await fetch(fileUrl(pdf));
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("content-security-policy"), null);
  });
});

describe("the viewer's rules (public/js/file-viewer-core.js)", () => {
  it("knows each kind, names it for a person, and lays out CSV and JSON", () => {
    assert.deepEqual(["a.png", "b.MOV", "c.m4a", "d.pdf", "e.docx", "f.csv", "g.bin"].map((name) => core.kindOf({ name })), ["image", "video", "audio", "pdf", "doc", "text", "other"]);
    assert.deepEqual(["x.pdf", "x.docx", "x.jpg", "x.py"].map((name) => core.typeLabel({ name })), ["PDF", "Word", "Picture", "PY"]);
    assert.deepEqual(core.parseCsv('a,"b,c"\n1,"say ""hi"""\n'), [["a", "b,c"], ["1", 'say "hi"']]);
    assert.equal(core.prettyJson('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(core.shownName("/w/uploads/sent-1793000000000-Report.pdf"), "Report.pdf");
    assert.equal(core.shownName("/w/uploads/chat-1793000000000-2-notes.md"), "notes.md");
  });

  it("a link to one of the chat's files opens in the viewer; anything else stays a link", () => {
    const origin = "https://tarsee.example";
    assert.equal(core.fileLink("/api/chat/file?p=%2Fw%2Fuploads%2Fa.pdf", origin).path, "/w/uploads/a.pdf");
    assert.equal(core.fileLink("https://elsewhere.example/api/chat/file?p=x", origin), null);
    assert.equal(core.fileLink("/api/files/download?path=x", origin), null);
  });

  it("the waveform: loudest sample a slice, scaled to the loudest, never quite silent", () => {
    const peaks = core.peaksOf([Float32Array.from([0, 0.5, 0, 1, 0, 0.25])], 3);
    assert.deepEqual(peaks, [0.5, 1, 0.25]);
    assert.deepEqual(core.peaksOf([new Float32Array(0)], 2), [0.04, 0.04]);
    assert.equal(core.clock(3725), "1:02:05");
  });

  it("the dashboard loads the cards, the viewer and their styles; the offline cache has them", () => {
    const page = fs.readFileSync(new URL("../src/public/index.html", import.meta.url), "utf8");
    assert.match(page, /<script type="module" src="\/js\/chat-files\.js"><\/script>/);
    assert.match(page, /href="\/css\/chat-files\.css"/);
    assert.match(page, /href="\/css\/file-viewer\.css"/);
    assert.match(page, /id="viewer"[^>]*hidden/);
    const sw = fs.readFileSync(new URL("../src/public/sw.js", import.meta.url), "utf8");
    for (const f of ["/js/chat-files.js", "/js/file-viewer.js", "/js/file-viewer-core.js", "/css/chat-files.css", "/css/file-viewer.css"]) assert.ok(sw.includes(`"${f}"`), f);
  });
});
