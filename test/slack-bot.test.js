// The Slack bot end to end, against a fake Slack on 127.0.0.1: its Web API, the Socket Mode WebSocket that delivers
// events and slash commands, the upload URL files go to and the response_url /tarsee answers on. Real @slack/bolt
// does the talking; the model is a scripted stream. Nothing here leaves 127.0.0.1.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-slack-bot-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-key-for-unit-tests-only-32chars!";
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { createSlackBot } = await import("../src/channels/slack.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

// ── the fake Slack ──────────────────────────────────────────────────────────

const calls = [];          // [method, args]
const uploads = [];        // bytes posted to the upload URL
const responses = [];      // what /tarsee answered on its response_url
const acks = [];           // Socket Mode acknowledgements
let socket = null;
let port = 0;
let tsCounter = 1000;
let failStart = null;      // an error chat.startStream answers with
const nextTs = () => `${++tsCounter}.000100`;
const of = (method) => calls.filter(([m]) => m === method).map(([, a]) => a);

const handlers = {
  "auth.test": () => ({ ok: true, user_id: "UBOT", team_id: "T1", bot_id: "BBOT", user: "tarsee", team: "Test Team" }),
  "apps.connections.open": () => ({ ok: true, url: `ws://127.0.0.1:${port}/link` }),
  "users.info": ({ user }) => ({ ok: true, user: { id: user, name: user.toLowerCase(), profile: { display_name: user === "U1" ? "Alice" : "", real_name: `Real ${user}` } } }),
  "conversations.info": ({ channel }) => ({ ok: true, channel: { id: channel, name: "ops" } }),
  "conversations.open": () => ({ ok: true, channel: { id: "DNEW" } }),
  "conversations.replies": () => ({ ok: true, messages: [
    { ts: "500.000100", user: "U2", text: "the deploy failed on <#C9|builds>" },
    { ts: "500.000200", user: "U1", text: "<@UBOT> can you look?" },
  ] }),
  "chat.postMessage": ({ channel }) => ({ ok: true, ts: nextTs(), channel }),
  "chat.startStream": () => (failStart ? { ok: false, error: failStart } : { ok: true, ts: nextTs() }),
  "files.getUploadURLExternal": () => ({ ok: true, upload_url: `http://127.0.0.1:${port}/upload/F1`, file_id: "F1" }),
  "files.completeUploadExternal": () => ({ ok: true, files: [{ id: "F1", title: "report" }] }),
};

/** Web API arguments, form-encoded or JSON, with the JSON-valued fields (chunks, files...) read back. */
function parseArgs(type, body) {
  if (/json/.test(type || "")) return JSON.parse(body || "{}");
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    out[k] = /^[[{]/.test(v) ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.url.startsWith("/api/")) {
      const method = req.url.slice("/api/".length).split("?")[0];
      const args = parseArgs(req.headers["content-type"], body.toString("utf8"));
      calls.push([method, args]);
      const out = handlers[method] ? handlers[method](args) : { ok: true };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    } else if (req.url.startsWith("/upload/")) {
      uploads.push(body);
      res.end("OK - 200");
    } else if (req.url === "/respond") {
      responses.push(JSON.parse(body.toString("utf8")));
      res.setHeader("content-type", "application/json");
      res.end("{\"ok\":true}");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
});
const wss = new WebSocketServer({ server, path: "/link" });
wss.on("connection", (ws) => {
  socket = ws;
  ws.on("message", (m) => acks.push(JSON.parse(String(m))));
  ws.send(JSON.stringify({ type: "hello", num_connections: 1, debug_info: { host: "test" }, connection_info: { app_id: "A1" } }));
});

let envelopes = 0;
function sendEvent(event) {
  const id = `env-${++envelopes}`;
  socket.send(JSON.stringify({
    envelope_id: id, type: "events_api", accepts_response_payload: false, retry_attempt: 0, retry_reason: "",
    payload: {
      token: "x", team_id: "T1", api_app_id: "A1", type: "event_callback", event_id: `Ev${envelopes}`, event_time: 1,
      event, authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
    },
  }));
  return id;
}
function sendCommand(text, channel = "C1") {
  const id = `env-${++envelopes}`;
  socket.send(JSON.stringify({
    envelope_id: id, type: "slash_commands", accepts_response_payload: true,
    payload: {
      token: "x", team_id: "T1", team_domain: "test", channel_id: channel, channel_name: "ops", user_id: "U1", user_name: "alice",
      command: "/tarsee", text, api_app_id: "A1", response_url: `http://127.0.0.1:${port}/respond`, trigger_id: "t1",
    },
  }));
  return id;
}

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── the model ───────────────────────────────────────────────────────────────

const streamCalls = [];
let script = null;
async function* scripted(opts) {
  streamCalls.push(opts);
  for (const ev of script()) yield ev;
}
const toolTurn = () => [
  { type: "text", content: "Let me check. " },
  { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
  { type: "tool_result", id: "toolu_1", ok: true, result: "a\nb" },
  { type: "text", content: "Found **2** files [react: ✅]" },
  { type: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "done", stopReason: "end_turn" },
];

let bot;
const streamText = (sinceIndex = 0) => calls.slice(sinceIndex)
  .filter(([m]) => m === "chat.startStream" || m === "chat.appendStream" || m === "chat.stopStream")
  .flatMap(([, a]) => a.chunks || [])
  .filter((c) => c.type === "markdown_text").map((c) => c.text).join("");

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  bot = await createSlackBot(
    { enabled: true, token: "xoxb-test", appToken: "xapp-test" },
    db,
    { slackApiUrl: `http://127.0.0.1:${port}/api/`, chatStream: scripted },
  );
  await until(() => socket, "the Socket Mode connection");
});

after(async () => {
  await bot?.stop().catch(() => {});
  wss.close();
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── the tests ───────────────────────────────────────────────────────────────

describe("the Slack bot against a fake Slack", () => {
  it("connects over Socket Mode with the app token, after checking the bot token", () => {
    assert.ok(of("auth.test").length >= 1);
    assert.equal(of("apps.connections.open").length >= 1, true);
  });

  it("acknowledges events and says so when no AI provider is set up", async () => {
    const id = sendEvent({ type: "message", channel: "D1", channel_type: "im", user: "U1", user_team: "T1", text: "hello", ts: "100.000100" });
    await until(() => acks.some((a) => a.envelope_id === id), "the ack");
    const post = await until(() => of("chat.postMessage").find((p) => /No AI provider/.test(p.markdown_text || "")), "the no-provider reply");
    assert.equal(post.channel, "D1");
    assert.equal(post.thread_ts, "100.000100", "the reply goes in the message's thread");
    const convId = settings.get("channel_conv.slack:D1:thread:100.000100");
    assert.ok(convId, "the thread got a conversation");
    assert.equal(convs.get(convId).title, "DM with Alice > hello");
  });

  it("streams a full turn natively: the person's thread, a task card per tool, markers kept out, reactions added", async () => {
    settings.set("ai.activeProvider", "claude-code");
    script = toolTurn;
    const from = calls.length;
    sendEvent({ type: "message", channel: "D1", channel_type: "im", user: "U1", user_team: "T1", text: "list my files", ts: "200.000100" });
    await until(() => calls.slice(from).some(([m]) => m === "chat.stopStream"), "the stream to stop");
    await until(() => calls.slice(from).some(([m, a]) => m === "reactions.add" && a.name === "white_check_mark"), "the model's reaction");

    const start = calls.slice(from).find(([m]) => m === "chat.startStream")[1];
    assert.equal(start.channel, "D1");
    assert.equal(start.thread_ts, "200.000100");
    assert.equal(start.recipient_user_id, "U1");
    assert.equal(start.recipient_team_id, "T1");
    const tasks = calls.slice(from).flatMap(([, a]) => a.chunks || []).filter((c) => c.type === "task_update");
    assert.deepEqual(tasks.map((t) => [t.id, t.status, t.title]), [["toolu_1", "in_progress", "Running command…"], ["toolu_1", "complete", "Command done"]]);
    const text = streamText(from);
    assert.equal(text, "Let me check. Found **2** files ");
    assert.ok(!text.includes("[react"), "the reaction marker never reaches Slack");

    const sends = calls.slice(from).map(([m, a]) => `${m}${a.name ? `:${a.name}` : ""}`);
    assert.ok(sends.includes("reactions.add:eyes"), "👀 while it works");
    assert.ok(sends.includes("reactions.remove:eyes"), "and off again after");
    assert.ok(sends.includes("assistant.threads.setStatus"), "the 'is thinking' line");

    const opts = streamCalls.at(-1);
    assert.equal(opts.liveSource, "slack");
    const convId = settings.get("channel_conv.slack:D1:thread:200.000100");
    assert.equal(opts.toolCtx.conversationId, convId);
    const saved = convs.getRecentMessages(convId, 10);
    assert.match(saved[0].content, /^\[Alice\]: list my files/);
    assert.match(saved.at(-1).content, /Found \*\*2\*\* files/);
    assert.ok(!saved.at(-1).content.includes("[react"));
  });

  it("answers a redelivered event once", async () => {
    script = () => [{ type: "text", content: "once" }, { type: "done", stopReason: "end_turn" }];
    const ev = { type: "message", channel: "D1", channel_type: "im", user: "U1", user_team: "T1", text: "again?", ts: "300.000100" };
    const from = calls.length;
    sendEvent(ev);
    await until(() => calls.slice(from).some(([m]) => m === "chat.stopStream"), "the first answer");
    const mid = calls.length;
    sendEvent(ev);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls.slice(mid).filter(([m]) => m === "chat.startStream").length, 0);
  });

  it("in a channel: ignores chatter, answers a mention, then follows its thread without one", async () => {
    script = () => [{ type: "text", content: "On it." }, { type: "done", stopReason: "end_turn" }];
    let from = calls.length;
    sendEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", user_team: "T1", text: "lunch?", ts: "400.000100" });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls.slice(from).filter(([m]) => m === "chat.startStream").length, 0, "no mention, no reply");

    from = calls.length;
    sendEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", user_team: "T1", text: "<@UBOT> check the build", ts: "410.000100" });
    await until(() => calls.slice(from).some(([m]) => m === "chat.stopStream"), "the mention's answer");
    const start = calls.slice(from).find(([m]) => m === "chat.startStream")[1];
    assert.equal(start.thread_ts, "410.000100");
    assert.equal(start.recipient_user_id, "U1", "a channel stream names its recipient");
    assert.equal(convs.get(settings.get("channel_conv.slack:C1:thread:410.000100")).title, "#ops > check the build");

    from = calls.length;
    sendEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", user_team: "T1", text: "and the tests?", ts: "411.000100", thread_ts: "410.000100" });
    await until(() => calls.slice(from).some(([m]) => m === "chat.stopStream"), "the follow-up's answer");
    assert.equal(calls.slice(from).find(([m]) => m === "chat.startStream")[1].thread_ts, "410.000100");
  });

  it("reads the thread first when mentioned in one it was not part of", async () => {
    script = () => [{ type: "text", content: "Looking." }, { type: "done", stopReason: "end_turn" }];
    const from = calls.length;
    sendEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", user_team: "T1", text: "<@UBOT> can you look?", ts: "500.000200", thread_ts: "500.000100" });
    await until(() => calls.slice(from).some(([m]) => m === "chat.stopStream"), "the answer");
    assert.ok(of("conversations.replies").some((a) => a.ts === "500.000100"));
    const convId = settings.get("channel_conv.slack:C1:thread:500.000100");
    const first = convs.getRecentMessages(convId, 5)[0].content;
    assert.match(first, /\[Earlier in this Slack thread\]/);
    assert.match(first, /the deploy failed on #builds/);
  });

  it("ignores its own messages, other bots and edits", async () => {
    const from = calls.length;
    sendEvent({ type: "message", channel: "D1", channel_type: "im", user: "UBOT", text: "my own", ts: "600.000100" });
    sendEvent({ type: "message", channel: "D1", channel_type: "im", bot_id: "B9", user: "U9", text: "a bot", ts: "601.000100" });
    sendEvent({ type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", ts: "602.000100", message: { text: "edited" } });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(calls.slice(from).filter(([m]) => m === "chat.startStream" || m === "chat.postMessage").length, 0);
  });

  it("runs a text command in its thread", async () => {
    const from = calls.length;
    sendEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", user_team: "T1", text: "<@UBOT> /mention", ts: "700.000100" });
    const post = await until(() => calls.slice(from).find(([m, a]) => m === "chat.postMessage" && /Mention mode/.test(a.markdown_text || "")), "the command's answer");
    assert.equal(post[1].thread_ts, "700.000100");
    assert.match(post[1].markdown_text, /slack/);
  });

  it("/tarsee: global commands answer privately, thread commands say where they work, a question gets a thread", async () => {
    sendCommand("mention");
    let r = await until(() => responses.find((x) => /Mention mode/.test(x.text || "")), "the /tarsee mention answer");
    assert.equal(r.response_type, "ephemeral");
    assert.equal(r.blocks[0].type, "markdown");

    sendCommand("clear");
    r = await until(() => responses.find((x) => /every thread is its own conversation/.test(x.text || "")), "the /tarsee clear answer");
    assert.match(r.text, /@tarsee \/clear/);

    script = () => [{ type: "text", content: "Here's the plan." }, { type: "done", stopReason: "end_turn" }];
    const from = calls.length;
    sendCommand("plan my week");
    await until(() => calls.slice(from).some(([m]) => m === "chat.stopStream"), "the question's answer");
    const root = calls.slice(from).find(([m]) => m === "chat.postMessage")[1];
    assert.equal(root.channel, "C1");
    assert.equal(root.markdown_text, "**Alice** asked: plan my week");
    const start = calls.slice(from).find(([m]) => m === "chat.startStream")[1];
    assert.ok(start.thread_ts, "answered in a thread under that message");
  });

  it("falls back to posting and editing when the workspace cannot stream natively, and remembers", async () => {
    failStart = "feature_disabled";
    script = () => [{ type: "text", content: "Fallback works." }, { type: "done", stopReason: "end_turn" }];
    let from = calls.length;
    sendEvent({ type: "message", channel: "D1", channel_type: "im", user: "U1", user_team: "T1", text: "hi", ts: "800.000100" });
    const post = await until(() => calls.slice(from).find(([m, a]) => m === "chat.postMessage" && a.markdown_text === "Fallback works."), "the posted reply");
    assert.equal(post[1].thread_ts, "800.000100");

    from = calls.length;
    sendEvent({ type: "message", channel: "D1", channel_type: "im", user: "U1", user_team: "T1", text: "again", ts: "801.000100" });
    await until(() => calls.slice(from).find(([m, a]) => m === "chat.postMessage" && a.markdown_text === "Fallback works."), "the second reply");
    assert.equal(calls.slice(from).filter(([m]) => m === "chat.startStream").length, 0, "it does not try native streaming again");
    failStart = null;
  });

  it("sends messages and files out: into a thread, and to a person by their user id", async () => {
    await bot.sendMessage("C1", "**Done** [react: ✅]", { threadId: "410.000100" });
    const msg = of("chat.postMessage").at(-1);
    assert.deepEqual([msg.channel, msg.thread_ts, msg.markdown_text], ["C1", "410.000100", "**Done**"]);

    await bot.sendMessage("U1", "psst");
    assert.equal(of("conversations.open").at(-1).users, "U1");
    assert.equal(of("chat.postMessage").at(-1).channel, "DNEW");

    const file = path.join(tmp, "workspace", "report.csv");
    fs.writeFileSync(file, "a,b\n1,2\n");
    await bot.sendFile("C1", file, "Here it is", { threadId: "410.000100" });
    assert.equal(of("files.getUploadURLExternal").at(-1).filename, "report.csv");
    assert.ok(uploads.at(-1).toString("utf8").includes("\r\n\r\na,b\n1,2\n\r\n"), "the file's bytes went to the upload URL (as a form part)");
    const done = of("files.completeUploadExternal").at(-1);
    assert.equal(done.channel_id, "C1");
    assert.equal(done.thread_ts, "410.000100");
    assert.equal(done.initial_comment, "Here it is");
    await assert.rejects(() => bot.sendFile("C1", path.join(tmp, "nope.pdf")), /file not found/);
  });
});
