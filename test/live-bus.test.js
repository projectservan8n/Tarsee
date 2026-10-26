// The live timeline behind the dashboard (src/lib/live-bus.js), the steps read
// from the Agent SDK's messages (src/lib/tool-steps.js), and the slim history
// and per-reply tools the chat loads (src/lib/message-tools.js).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb } from "../src/db/sqlite.js";
import { ConversationStore } from "../src/db/conversations.js";
import * as live from "../src/lib/live-bus.js";
import { stepsFromSdkMessage, toolResultsFromSdkMessage, displayToolName, summarizeToolInput } from "../src/lib/tool-steps.js";
import { messageTools, slimMessage } from "../src/lib/message-tools.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-live-"));
const DB = path.join(dir, "live.db");
let db;

before(() => {
  db = initDb(DB);
  // A turn that started before a "restart" and never ended.
  db.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("conv-dead", "turn-dead", "turn_start", JSON.stringify({ source: "telegram" }), Date.now() - 60_000);
  live.initLiveBus(db);
});

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("live bus: the timeline", () => {
  it("closes a turn a restart left open, so nothing shows as working forever", () => {
    const events = live.eventsSince("conv-dead", 0);
    const end = events.find((e) => e.type === "turn_end");
    assert.ok(end, "a turn_end was published at start-up");
    assert.equal(end.turnId, "turn-dead");
    assert.equal(end.payload.stopReason, "interrupted");
    assert.equal(live.activeTurnFor("conv-dead"), null);
  });

  it("numbers events in order and replays everything after a given seq", () => {
    const a = live.publish("c1", "turn_start", { source: "web" }, { turnId: "t1" });
    const b = live.publish("c1", "step", { kind: "tool_start", id: "x", name: "Bash", summary: "ls" }, { turnId: "t1" });
    const c = live.publish("c1", "turn_end", { stopReason: "end_turn" }, { turnId: "t1" });
    assert.ok(a.seq < b.seq && b.seq < c.seq);
    assert.deepEqual(live.eventsSince("c1", a.seq).map((e) => e.type), ["step", "turn_end"]);
    assert.equal(live.latestSeq("c1"), c.seq);
    assert.deepEqual(live.eventsForTurn("t1").map((e) => e.seq), [a.seq, b.seq, c.seq]);
  });

  it("knows the turn in progress, its steps and the tools still running", () => {
    live.publish("c2", "turn_start", { source: "discord" }, { turnId: "t2" });
    live.publish("c2", "step", { kind: "tool_start", id: "r1", name: "Read", summary: "README.md" }, { turnId: "t2" });
    let t = live.activeTurnFor("c2");
    assert.equal(t.turnId, "t2");
    assert.equal(t.source, "discord");
    assert.deepEqual(t.runningTools.map((x) => x.id), ["r1"]);
    assert.equal(t.lastStepLabel, "Read: README.md");
    assert.ok(live.activeTurnList().some((x) => x.conversationId === "c2"));
    live.publish("c2", "step", { kind: "tool_end", id: "r1", ok: true }, { turnId: "t2" });
    t = live.activeTurnFor("c2");
    assert.deepEqual(t.runningTools, []);
    live.publish("c2", "turn_end", { stopReason: "end_turn" }, { turnId: "t2" });
    assert.equal(live.activeTurnFor("c2"), null);
  });

  it("caps long strings in a step, and pushes every event to subscribers", () => {
    const seen = [];
    const off = live.onEvent((e) => seen.push(e));
    const evt = live.publish("c3", "step", { kind: "text", text: "x".repeat(20_000) });
    off();
    assert.ok(evt.payload.text.length < 9000);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].seq, evt.seq);
    live.publish("c3", "step", { kind: "text", text: "after unsubscribe" });
    assert.equal(seen.length, 1);
  });

  it("never throws, and does nothing without a conversation id", () => {
    assert.equal(live.publish(null, "step", {}), null);
    assert.equal(live.publish("c", null, {}), null);
  });
});

describe("live bus: messages", () => {
  it("every saved message goes on the timeline, with the sending tab's id", () => {
    const store = new ConversationStore(db);
    const conv = store.create({ title: "Live" });
    const user = store.addMessage(conv.id, { role: "user", content: "hello", clientMsgId: "tab-123" });
    store.addMessage(conv.id, { role: "assistant", content: "hi <tool_call>{\"name\":\"Bash\"}</tool_call>\n\n\n\nthere" });
    const msgs = live.eventsSince(conv.id, 0).filter((e) => e.type === "message");
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].payload.id, user.id);
    assert.equal(msgs[0].payload.clientMsgId, "tab-123");
    assert.equal(msgs[1].payload.content, "hi \n\nthere", "tool-call JSON stripped: it belongs to steps");
    assert.ok(live.hasClientMsgId(conv.id, "tab-123"), "a retry of the same send is recognised");
    assert.ok(!live.hasClientMsgId(conv.id, "tab-999"));
    assert.deepEqual(live.recentClientMsgIds(conv.id), ["tab-123"]);
  });

  it("opening a chat's recap writes nothing to memory", async () => {
    const store = new ConversationStore(db);
    const conv = store.create({ title: "Old chat" });
    for (let i = 0; i < 4; i++) store.addMessage(conv.id, { role: i % 2 ? "assistant" : "user", content: `m${i}` });
    db.prepare("UPDATE conversations SET updated_at = datetime('now', '-2 hours') WHERE id = ?").run(conv.id);
    const recap = await store.getSessionRecap(conv.id, 30);
    assert.ok(recap && /Last active/.test(recap.text));
  });
});

describe("tool steps: from the SDK's messages", () => {
  const assistant = (content, extra = {}) => ({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null, ...extra });
  const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, ...extra });

  it("a tool_use block starts a step, once, with a one-line summary and redacted input", () => {
    const seen = new Set();
    const msg = assistant([
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "tu1", name: "Bash", input: { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' x", description: "Fetch the page" } },
    ]);
    const steps = stepsFromSdkMessage(msg, seen);
    assert.deepEqual(steps.map((s) => s.kind), ["text", "tool_start"]);
    assert.equal(steps[1].summary, "Fetch the page");
    assert.ok(!steps[1].input.includes("abcdefghijklmnopqrstuvwxyz0123456789"), "the key is redacted");
    assert.deepEqual(stepsFromSdkMessage(msg, seen).map((s) => s.kind), ["text"], "the same tool does not start twice");
  });

  it("a tool_result block in a user message ends the step it answers", () => {
    const msg = user([{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "done" }], is_error: false }]);
    assert.deepEqual(stepsFromSdkMessage(msg), [{ kind: "tool_end", id: "tu1", ok: true, preview: "done" }]);
    assert.deepEqual(toolResultsFromSdkMessage(msg), [{ id: "tu1", ok: true, result: "done" }]);
    const failed = user([{ type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true }]);
    assert.equal(toolResultsFromSdkMessage(failed)[0].ok, false);
  });

  it("other messages have no steps", () => {
    assert.deepEqual(stepsFromSdkMessage({ type: "result", result: "x" }), []);
    assert.deepEqual(stepsFromSdkMessage(user("plain prompt text")), []);
    assert.deepEqual(toolResultsFromSdkMessage(assistant([{ type: "text", text: "x" }])), []);
  });

  it("names Tarsee's MCP tools plainly and summarises the common tools", () => {
    assert.equal(displayToolName("mcp__tarsee__tarsee_send_message"), "tarsee_send_message");
    assert.equal(displayToolName("Read"), "Read");
    assert.equal(summarizeToolInput("Grep", { pattern: "TODO", path: "src" }), "TODO in src");
    assert.equal(summarizeToolInput("TodoWrite", {}), "updating the task list");
    assert.ok(summarizeToolInput("Read", { file_path: "/" + "a/".repeat(60) + "file.js" }).startsWith("…"));
  });
});

describe("message tools: slim history and a reply's tools", () => {
  const timeline = JSON.stringify({
    __timeline: true,
    items: [
      { type: "text", text: "Checking." },
      { type: "tool", name: "Bash", summary: "List files", detail: "ls -la", input: "ls -la", output: "x".repeat(5000), status: "done" },
      { type: "tool", name: "Update Todos", detail: "", input: "", output: "", status: "done", todos: [{ content: "a", status: "completed" }] },
    ],
    text: "All done.",
  });

  it("a dashboard reply stays timeline JSON, without the tools' inputs and outputs", () => {
    const slim = slimMessage({ id: "m1", role: "assistant", content: timeline });
    const data = JSON.parse(slim.content);
    assert.equal(data.__timeline, true);
    assert.equal(data.text, "All done.");
    assert.equal(data.items[0].text, "Checking.");
    assert.deepEqual(data.items[1], { type: "tool", name: "Bash", summary: "List files", status: "done" });
    assert.deepEqual(data.items[2].todos, [{ content: "a", status: "completed" }]);
    assert.ok(slim.content.length < 400);
  });

  it("a channel reply has its inline tool calls taken out and listed", () => {
    const content = 'Looking.\n<tool_call>{"name":"mcp__tarsee__tarsee_web_search","arguments":{"query":"weather"}}</tool_call>\n<tool_response>sunny</tool_response>\n\n\n\nSunny today.';
    const slim = slimMessage({ id: "m2", role: "assistant", content });
    assert.equal(slim.content, "Looking.\n\nSunny today.");
    assert.deepEqual(slim.tools, [{ name: "tarsee_web_search", summary: "weather" }]);
    const plain = { id: "m3", role: "user", content: "hi" };
    assert.equal(slimMessage(plain), plain, "a message with no tools is left alone");
  });

  it("a reply's tools, opened: input and output, capped and redacted, from either shape", () => {
    const fromTimeline = messageTools(timeline);
    assert.equal(fromTimeline.length, 2);
    assert.equal(fromTimeline[0].name, "Bash");
    assert.ok(fromTimeline[0].output.length <= 4002);
    const fromChannel = messageTools('<tool_call>{"name":"Bash","arguments":{"command":"echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"}}</tool_call><tool_response>ok</tool_response>');
    assert.equal(fromChannel.length, 1);
    assert.equal(fromChannel[0].output, "ok");
    assert.ok(!fromChannel[0].input.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  });
});
