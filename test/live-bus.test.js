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
import { stepsFromSdkMessage, toolResultsFromSdkMessage, displayToolName, summarizeToolInput, createStreamWatcher } from "../src/lib/tool-steps.js";
import { withConversationTurn, claimQueuedTurn, removeQueuedTurn, currentQueuedTurn, QUEUE_REMOVED } from "../src/lib/conversation-lock.js";
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

  it("two turns overlapping in one conversation: the first one's end leaves the other running", () => {
    live.publish("c4", "turn_start", { source: "web" }, { turnId: "a" });
    live.publish("c4", "turn_start", { source: "api" }, { turnId: "b" });
    live.publish("c4", "turn_end", { stopReason: "end_turn" }, { turnId: "a" });
    assert.equal(live.activeTurnFor("c4")?.turnId, "b");
    live.publish("c4", "step", { kind: "tool_start", id: "s1", name: "Read" }, { turnId: "a" });
    assert.equal(live.activeTurnFor("c4").steps, 0, "a step of the turn that ended is not this one's");
    live.publish("c4", "turn_end", { stopReason: "end_turn" }, { turnId: "b" });
    assert.equal(live.activeTurnFor("c4"), null);
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

  it("a deleted message, a deleted chat and a cleared chat leave nothing on the timeline", () => {
    const store = new ConversationStore(db);
    const conv = store.create({ title: "Forget me" });
    const m1 = store.addMessage(conv.id, { role: "user", content: "secret one" });
    store.addMessage(conv.id, { role: "user", content: "secret two" });
    store.deleteMessage(conv.id, m1.id);
    assert.deepEqual(live.eventsSince(conv.id, 0).map((e) => e.payload.content), ["secret two"]);
    store.delete(conv.id);
    assert.deepEqual(live.eventsSince(conv.id, 0), []);
    const other = store.create({ title: "Clear me" });
    store.addMessage(other.id, { role: "user", content: "x" });
    assert.equal(live.forgetConversation(other.id), 1);
    assert.deepEqual(live.eventsSince(other.id, 0), []);
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

describe("the Queued line: a message waiting behind the running turn", () => {
  const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
  const of = (conv, turnId) => live.eventsForTurn(turnId).filter((e) => e.conversationId === conv).map((e) => [e.type, e.payload?.stopReason || null]);

  it("goes on the timeline as queued, and the provider that begins it keeps its id: the same line starts", async () => {
    const g = gate();
    const a = withConversationTurn("q-1", () => g.p, { live: { source: "web", prompt: "first" } });
    let claimed = null;
    let second = "unset";
    const b = withConversationTurn("q-1", async () => { claimed = claimQueuedTurn("q-1"); second = claimQueuedTurn("q-1"); }, { live: { source: "web", prompt: "second" } });
    const waiting = live.queuedTurnList("q-1");
    assert.equal(waiting.length, 1, "only the one that waits: the first turn never queued");
    assert.equal(waiting[0].source, "web");
    g.open();
    await Promise.all([a, b]);
    assert.equal(claimed, waiting[0].turnId);
    assert.equal(second, null, "a second turn in the same slot gets an id of its own");
    assert.deepEqual(of("q-1", claimed), [["turn_queued", null]], "the provider publishes its start and end, not the lock");
  });

  it("a slot no provider claims (a command answered, a failure first) ends its line", async () => {
    const g = gate();
    const a = withConversationTurn("q-2", () => g.p);
    let id = null;
    const b = withConversationTurn("q-2", async () => { id = currentQueuedTurn().turnId; }, { live: { source: "telegram", prompt: "/help" } });
    g.open();
    await Promise.all([a, b]);
    assert.deepEqual(of("q-2", id), [["turn_queued", null], ["turn_end", "ended"]]);
    assert.equal(live.queuedTurnList("q-2").length, 0);
  });

  it("a slot that fails before anything begins ends its line as failed, and the caller still gets the error", async () => {
    const g = gate();
    const a = withConversationTurn("q-5", () => g.p);
    let id = null;
    const b = withConversationTurn("q-5", () => { id = currentQueuedTurn().turnId; throw new Error("no provider"); }, { live: { source: "web", prompt: "x" } });
    g.open();
    await a;
    await assert.rejects(b, /no provider/);
    const end = live.eventsForTurn(id).find((e) => e.type === "turn_end");
    assert.equal(end.payload.stopReason, "error");
    assert.ok(end.payload.error);
  });

  it("its Stop takes it out alone: it never runs, its line ends at once, the turn ahead goes on", async () => {
    const g = gate();
    let aDone = false;
    const a = withConversationTurn("q-3", async () => { await g.p; aDone = true; });
    let ran = false;
    let removedCalled = false;
    const b = withConversationTurn("q-3", async () => { ran = true; }, { live: { source: "web", prompt: "never mind", onRemoved: () => { removedCalled = true; } } });
    const id = live.queuedTurnList("q-3")[0].turnId;
    assert.equal(removeQueuedTurn(id, "another-chat"), false, "only from its own chat");
    assert.equal(removeQueuedTurn(id, "q-3"), true);
    assert.equal(removedCalled, true);
    assert.deepEqual(of("q-3", id), [["turn_queued", null], ["turn_end", "removed"]], "ended at once, before the turn ahead");
    assert.equal(removeQueuedTurn(id, "q-3"), false, "once");
    g.open();
    assert.equal(await b, QUEUE_REMOVED);
    await a;
    assert.equal(ran, false);
    assert.equal(aDone, true);
  });

  it("a turn whose slot has come is no longer in the queue: Stop it as the running turn", async () => {
    const g = gate();
    const a = withConversationTurn("q-4", () => Promise.resolve());
    let id = null;
    let removable = null;
    const b = withConversationTurn("q-4", async () => { id = currentQueuedTurn().turnId; removable = removeQueuedTurn(id, "q-4"); await g.p; }, { live: { source: "web", prompt: "x" } });
    await a;
    await new Promise((r) => setTimeout(r, 5));
    g.open();
    await b;
    assert.equal(removable, false);
  });

  it("a restart closes a line left queued", () => {
    const d2 = initDb(path.join(dir, "restart.db"));
    d2.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("conv-q", "turn-q", "turn_queued", JSON.stringify({ source: "web" }), Date.now() - 1000);
    live.initLiveBus(d2);
    const ends = d2.prepare("SELECT payload FROM conversation_events WHERE turn_id = 'turn-q' AND type = 'turn_end'").all();
    assert.equal(ends.length, 1);
    assert.equal(JSON.parse(ends[0].payload).stopReason, "interrupted");
    live.initLiveBus(db);
    d2.close();
  });
});

describe("the stream watcher: what a turn is doing while it only says Thinking", () => {
  const se = (event, parent = null) => ({ type: "stream_event", event, parent_tool_use_id: parent });

  it("tokens so far at each call's start and end, and the speed of its output", () => {
    let t = 1_000_000;
    const w = createStreamWatcher({ now: () => t });
    const [start] = w.onMessage(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 4, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 300, output_tokens: 1 } } }));
    assert.equal(start.kind, "usage");
    assert.equal(start.total, 40_305);
    assert.equal(start.outTps, null, "nothing generated yet");
    t += 4000;
    const [end] = w.onMessage(se({ type: "message_delta", usage: { input_tokens: 4, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 300, output_tokens: 200 } }));
    assert.equal(end.total, 40_504);
    assert.equal(end.outTps, 50);
    assert.equal(end.nowTps, 50);
    // A subagent's call counts too.
    w.onMessage(se({ type: "message_start", message: { id: "m2", usage: { input_tokens: 10, output_tokens: 0 } } }, "toolu_1"));
    t += 1000;
    const [sub] = w.onMessage(se({ type: "message_delta", usage: { output_tokens: 100 } }, "toolu_1"));
    assert.equal(sub.calls, 2);
    assert.equal(sub.output, 300);
  });

  it("a thinking summary when its block ends; nothing for thinking left out, nor for a subagent's", () => {
    const w = createStreamWatcher();
    w.onMessage(se({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
    assert.deepEqual(w.onMessage(se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Working out the dates, " } })), []);
    w.onMessage(se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "then checking with cal." } }));
    assert.deepEqual(w.onMessage(se({ type: "content_block_stop", index: 0 })), [{ kind: "thinking", text: "Working out the dates, then checking with cal." }]);
    // Omitted thinking (no summary asked for): one empty delta.
    w.onMessage(se({ type: "content_block_start", index: 1, content_block: { type: "thinking" } }));
    w.onMessage(se({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "" } }));
    assert.deepEqual(w.onMessage(se({ type: "content_block_stop", index: 1 })), []);
    w.onMessage(se({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }, "toolu_9"));
    w.onMessage(se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "inside a helper" } }, "toolu_9"));
    assert.deepEqual(w.onMessage(se({ type: "content_block_stop", index: 0 }, "toolu_9")), []);
    // A text block's end is not a thought.
    assert.deepEqual(w.onMessage(se({ type: "content_block_stop", index: 2 })), []);
  });

  it("why it is waiting: an API error it retries, compacting", () => {
    const w = createStreamWatcher();
    assert.deepEqual(w.onMessage({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4200, error_status: 529, error: "server_error" }),
      [{ kind: "status", text: "Claude's API answered 529 (server error). Trying again in 4s (attempt 2 of 10)." }]);
    assert.deepEqual(w.onMessage({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: "unknown" }),
      [{ kind: "status", text: "Could not reach Claude's API. Trying again in 1s (attempt 1 of 10)." }]);
    assert.deepEqual(w.onMessage({ type: "system", subtype: "status", status: "compacting" }), [{ kind: "status", text: "Compacting the conversation to make room." }]);
    assert.deepEqual(w.onMessage({ type: "system", subtype: "status", status: "requesting" }), []);
    assert.deepEqual(w.onMessage({ type: "system", subtype: "init" }), []);
    assert.deepEqual(w.onMessage({ type: "assistant", message: { content: [] } }), []);
  });
});
