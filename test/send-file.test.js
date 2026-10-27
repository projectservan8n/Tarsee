// Sending files back to a chat (send_file / tarsee_send_file): which chat it goes to (lib/chat-target.js), what the
// tool checks before sending, that a Telegram turn can reach Telegram at all (its tool context has no channel
// manager), and the Telegram bot's upload itself, against a Bot API server on 127.0.0.1 that reads the multipart
// body as Telegram would. Nothing here touches the network beyond 127.0.0.1.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-send-file-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(path.join(tmp, "workspace", "reports"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { chatTargetOf, resolveChatTarget } = await import("../src/lib/chat-target.js");
const { executeTool, setToolsChannelManager, getToolDefinitions } = await import("../src/lib/tools.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
const { mimeOfFile } = await import("../src/channels/whatsapp.js");
const { sendFileHint } = await import("../src/lib/build-system-prompt.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

after(() => { setToolsChannelManager(null); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** A conversation for a chat key, with messages at the given times (oldest first). */
function chat(key, ...times) {
  const conv = convs.create({ title: key });
  settings.set(`channel_conv.${key}`, conv.id);
  for (const t of times) db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', 'hi', ?)").run(`${conv.id}-${t}`, conv.id, t);
  return conv.id;
}

/** A channel manager that keeps what it was asked to send. */
function fakeManager() {
  const sent = [];
  return {
    sent,
    sendMessage: async (type, chatId, message, opts) => { sent.push({ kind: "message", type, chatId, message, opts }); },
    sendFile: async (type, chatId, filePath, caption, opts) => { sent.push({ kind: "file", type, chatId, filePath, caption, opts }); },
  };
}

describe("which chat a message or file goes to", () => {
  it("reads the chat out of each channel's key: a Telegram topic, a Discord thread, a WhatsApp chat", () => {
    assert.deepEqual(chatTargetOf("telegram", "channel_conv.telegram:-1001:topic:7"), { chatId: "-1001", threadId: "7" });
    assert.deepEqual(chatTargetOf("telegram", "telegram:42"), { chatId: "42", threadId: null });
    assert.deepEqual(chatTargetOf("discord", "discord:100:thread:200"), { chatId: "200", threadId: null });
    assert.deepEqual(chatTargetOf("discord", "discord:100"), { chatId: "100", threadId: null });
    assert.deepEqual(chatTargetOf("whatsapp", "whatsapp:447700900000@s.whatsapp.net"), { chatId: "447700900000@s.whatsapp.net", threadId: null });
    assert.equal(chatTargetOf("telegram", "discord:100"), null);
  });

  it("goes to the chat the turn is in, then to the channel's latest chat, never the lowest id that sorts first", () => {
    const old = chat("telegram:-100111", "2026-01-01 10:00:00");          // sorts first: the old rule's pick
    const busy = chat("telegram:555", "2026-10-26 09:00:00", "2026-10-27 09:00:00");
    const forum = chat("telegram:-100999:topic:12", "2026-10-20 09:00:00");
    settings.set("channel_conv.telegram:-100000", null);                  // a chat whose conversation was cleared

    const here = resolveChatTarget({ channel: "telegram", conversationId: forum, settingsStore: settings, db });
    assert.deepEqual(here, { chatId: "-100999", threadId: "12", how: "this chat" });
    const latest = resolveChatTarget({ channel: "telegram", conversationId: "web-conv", settingsStore: settings, db });
    assert.deepEqual(latest, { chatId: "555", threadId: null, how: "latest" });
    assert.ok(old && busy);
    const given = resolveChatTarget({ channel: "telegram", channelId: "-100999", conversationId: forum, settingsStore: settings, db });
    assert.deepEqual(given, { chatId: "-100999", threadId: "12", how: "given" }, "the current chat's own id keeps its topic");
    assert.equal(resolveChatTarget({ channel: "discord", settingsStore: settings, db }), null);
  });
});

describe("send_file", () => {
  const mgr = fakeManager();
  const ws = process.env.TARSEE_WORKSPACE_DIR;
  let telegramConv;
  before(() => {
    setToolsChannelManager(mgr);
    telegramConv = chat("telegram:777", "2026-10-27 11:00:00");
    fs.writeFileSync(path.join(ws, "reports", "October Report.html"), "<h1>October</h1>");
    fs.writeFileSync(path.join(ws, "empty.txt"), "");
  });

  const run = (input, ctx = {}) => executeTool("send_file", input, { db, settingsStore: settings, conversationId: telegramConv, ...ctx });

  it("is offered to the agent, in the MCP server and the tool list", async () => {
    assert.ok(getToolDefinitions().some((t) => t.name === "send_file"));
    const mcp = createTarseeMcp({ db, settingsStore: settings });
    const names = Object.keys(mcp.instance._registeredTools || {});
    assert.ok(names.includes("tarsee_send_file"), names.join(", "));
    assert.match(sendFileHint("telegram"), /tarsee_send_file with channel="telegram"/);
  });

  it("sends a workspace file to the Telegram chat the turn is in, with its caption", async () => {
    const out = await run({ channel: "telegram", file_path: "reports/October Report.html", caption: "Here it is" });
    assert.match(out, /^File sent to telegram \(chat 777\): October Report\.html/);
    const last = mgr.sent.at(-1);
    assert.deepEqual(last, { kind: "file", type: "telegram", chatId: "777", filePath: path.join(ws, "reports", "October Report.html"), caption: "Here it is", opts: { threadId: null } });
  });

  it("refuses what it can't send, before sending anything", async () => {
    const before = mgr.sent.length;
    assert.match(await run({ channel: "telegram", file_path: "nope.pdf" }), /file not found at .*nope\.pdf/);
    assert.match(await run({ channel: "telegram", file_path: "empty.txt" }), /is empty/);
    assert.match(await run({ channel: "telegram", file_path: "reports" }), /is a folder/);
    assert.match(await run({ channel: "email", file_path: "reports/October Report.html" }), /send_email_thread/);
    const big = path.join(ws, "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 26 * 1024 * 1024);   // sparse: no 26 MB written
    assert.match(await run({ channel: "discord", file_path: big }), /26\.0 MB; discord takes up to 25 MB/);
    assert.match(await run({ channel: "discord", file_path: "reports/October Report.html" }, { conversationId: null }), /No chat ID found for discord/);
    assert.equal(mgr.sent.length, before);
  });

  it("send_message from a Telegram turn reaches Telegram, and email (its tool context has no channel manager)", async () => {
    const out = await executeTool("send_message", { channel: "telegram", message: "Done" }, { db, settingsStore: settings, conversationId: telegramConv });
    assert.match(out, /^Message sent to telegram \(chat 777\)/);
    assert.deepEqual(mgr.sent.at(-1), { kind: "message", type: "telegram", chatId: "777", message: "Done", opts: { threadId: null } });
    const mail = await executeTool("send_message", { channel: "email", channel_id: "sam@example.com", message: "Hi" }, { db, settingsStore: settings, conversationId: telegramConv });
    assert.match(mail, /^Email sent to sam@example\.com/);
    assert.equal(mgr.sent.at(-1).type, "email");
  });

  it("send_email_thread attaches files (a relative path is the workspace's) instead of dropping them", async () => {
    const mails = [];
    const withEmail = { ...mgr, channels: new Map([["email", { bot: { sendNew: async (opts) => { mails.push(opts); return { messageId: "<m1@x>", attachmentCount: opts.attachments.length }; } } }]]) };
    const out = await executeTool("send_email_thread", { to: "sam@example.com", subject: "Report", body: "Attached.", attachments: ["reports/October Report.html"] },
      { db, settingsStore: settings, conversationId: telegramConv, channelManager: withEmail });
    assert.match(out, /^Email thread sent to sam@example\.com with 1 attachment\./);
    assert.deepEqual(mails[0].attachments, [path.join(ws, "reports", "October Report.html")]);
  });

  it("WhatsApp documents go with their own kind", () => {
    assert.equal(mimeOfFile("/x/October Report.HTML"), "text/html");
    assert.equal(mimeOfFile("deck.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.equal(mimeOfFile("blob"), "application/octet-stream");
  });
});

describe("the Telegram bot uploads the file (a Bot API server on 127.0.0.1)", () => {
  const calls = [];
  let server;
  let bot;
  const TOKEN = "123:test";

  before(async () => {
    server = http.createServer(async (req, res) => {
      const method = req.url.split("/").pop();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      let fields = {};
      let file = null;
      if (/multipart\/form-data/.test(req.headers["content-type"] || "")) {
        const form = await new Request("http://x/", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body }).formData();
        for (const [k, v] of form) {
          if (typeof v === "string") fields[k] = v;
          else file = { field: k, name: v.name, bytes: Buffer.from(await v.arrayBuffer()).toString("utf8") };
        }
      } else if (body.length) fields = JSON.parse(body.toString("utf8"));
      calls.push({ method, fields, file });
      const result = {
        getMe: { id: 1, is_bot: true, first_name: "Test", username: "test_bot" },
        getUpdates: [],
        sendDocument: { message_id: calls.length, date: 0, chat: { id: Number(fields.chat_id), type: "private" } },
        sendMessage: { message_id: calls.length, date: 0, chat: { id: Number(fields.chat_id), type: "private" } },
      }[method] ?? true;
      if (method === "getUpdates") await new Promise((r) => setTimeout(r, 150));
      if (method === "sendDocument" && fields.parse_mode === "HTML" && /BROKEN/.test(fields.caption || "")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    bot = await createTelegramBot({ token: TOKEN }, db, { apiRoot: `http://127.0.0.1:${server.address().port}` });
  });

  after(async () => {
    await bot?.stop();
    server?.closeAllConnections?.();
    server?.close();
  });

  it("as a document with its real name and bytes, into the forum topic, with an HTML caption", async () => {
    const file = path.join(process.env.TARSEE_WORKSPACE_DIR, "reports", "October Report.html");
    await bot.sendFile("777", file, "**Ready**", { threadId: "12" });
    const call = calls.findLast((c) => c.method === "sendDocument");
    assert.equal(call.fields.chat_id, "777");
    assert.equal(call.fields.message_thread_id, "12");
    assert.equal(call.fields.parse_mode, "HTML");
    assert.equal(call.fields.caption, "<b>Ready</b>");
    assert.deepEqual(call.file, { field: "document", name: "October Report.html", bytes: "<h1>October</h1>" });
  });

  it("sends the caption as plain text when Telegram can't parse it, and a file with no caption as it is", async () => {
    const file = path.join(process.env.TARSEE_WORKSPACE_DIR, "reports", "October Report.html");
    await bot.sendFile("777", file, "BROKEN <b");
    const docs = calls.filter((c) => c.method === "sendDocument");
    assert.equal(docs.at(-1).fields.caption, "BROKEN <b");
    assert.equal(docs.at(-1).fields.parse_mode, undefined);
    await bot.sendFile("777", file);
    assert.equal(calls.findLast((c) => c.method === "sendDocument").fields.caption, undefined);
    await assert.rejects(bot.sendFile("777", "/no/such/file.pdf"), /file not found/);
  });
});
