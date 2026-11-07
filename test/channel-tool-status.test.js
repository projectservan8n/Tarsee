// A channel's "⚙️ Running command…" line turns into "✓ Command done" when the tool finishes. Claude Code runs the
// tools itself and reports each result as a tool_result event, then ends the turn with "end_turn"; the channels used
// to mark a tool done only in their own tool loop, which that never reaches, so every status line stayed "Running"
// for good. Telegram's bot runs here against a Bot API server on 127.0.0.1 with a scripted model.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-tool-status-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { createTelegramBot } = await import("../src/channels/telegram.js");

const db = initDb(path.join(tmp, "tarsee.db"));
new SettingsStore(db).set("ai.activeProvider", "claude-code");

async function* scripted() {
  yield { type: "text", content: "Checking. " };
  yield { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } };
  yield { type: "tool_result", id: "toolu_1", ok: true, result: "a\nb" };
  yield { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x/missing.md" } };
  yield { type: "tool_result", id: "toolu_2", ok: false, result: "File does not exist." };
  yield { type: "text", content: "Done." };
  yield { type: "done", stopReason: "end_turn" };
}

describe("tool status lines on Telegram", () => {
  const calls = [];
  let server;
  let bot;
  let delivered = false;

  before(async () => {
    server = http.createServer(async (req, res) => {
      const method = req.url.split("/").pop();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString("utf8");
      const fields = body && /json/.test(req.headers["content-type"] || "") ? JSON.parse(body) : {};
      calls.push({ method, fields });
      let result = true;
      if (method === "getMe") result = { id: 1, is_bot: true, first_name: "Test", username: "test_bot" };
      else if (method === "getUpdates") {
        await new Promise((r) => setTimeout(r, 100));
        result = delivered ? [] : [{ update_id: 1, message: { message_id: 10, date: 0, chat: { id: 777, type: "private" }, from: { id: 42, is_bot: false, first_name: "Sam" }, text: "list my files" } }];
        delivered = true;
      } else if (method === "sendMessage") result = { message_id: 100 + calls.length, date: 0, chat: { id: 777, type: "private" }, text: fields.text };
      else if (method === "editMessageText") result = { message_id: Number(fields.message_id), date: 0, chat: { id: 777, type: "private" }, text: fields.text };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    bot = await createTelegramBot({ token: "123:test" }, db, { apiRoot: `http://127.0.0.1:${server.address().port}`, chatStream: scripted });
  });

  after(async () => {
    await bot?.stop();
    server?.closeAllConnections?.();
    server?.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("turns each tool's line into ✓ or ❌ when Claude Code reports its result", async () => {
    const end = Date.now() + 10_000;
    const edits = () => calls.filter((c) => c.method === "editMessageText").map((c) => c.fields.text);
    while (Date.now() < end && !(edits().some((t) => /✓ Command done/.test(t)) && edits().some((t) => /❌ Read missing\.md/.test(t)))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const posted = calls.filter((c) => c.method === "sendMessage").map((c) => c.fields.text);
    assert.ok(posted.some((t) => /⚙️ Running command…/.test(t)), `the running line was posted: ${posted.join(" | ")}`);
    assert.ok(edits().some((t) => /✓ Command done/.test(t)), `the Bash line turned ✓: ${edits().join(" | ")}`);
    assert.ok(edits().some((t) => /❌ Read missing\.md/.test(t)), `the failed Read turned ❌: ${edits().join(" | ")}`);
  });
});
