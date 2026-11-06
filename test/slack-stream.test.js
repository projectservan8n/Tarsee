import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { SlackReplyStream, slackErrorCode } = await import("../src/lib/slack-stream.js");

/** A Slack error the way @slack/web-api v8 throws one (WebAPIPlatformError). */
const platformError = (error) => Object.assign(new Error(`An API error occurred: ${error}`), { code: "slack_webapi_platform_error", data: { ok: false, error } });

/** A Slack client that records each call. fail: { method: errorCode | (args, n) => errorCode|null } */
function fakeClient(fail = {}) {
  const calls = [];
  let n = 0;
  const call = (method) => async (args) => {
    const entry = [method, args, null];
    calls.push(entry);
    const f = fail[method];
    const code = typeof f === "function" ? f(args, calls.filter((c) => c[0] === method).length) : f;
    if (code) throw platformError(code);
    entry[2] = { ok: true, ts: `${method}-${++n}` };
    return entry[2];
  };
  return {
    calls,
    of: (method) => calls.filter((c) => c[0] === method).map((c) => c[1]),
    chat: {
      startStream: call("startStream"),
      appendStream: call("appendStream"),
      stopStream: call("stopStream"),
      postMessage: call("postMessage"),
      update: call("update"),
      delete: call("delete"),
    },
    agents: { sessions: { setStatus: call("sessionStatus") } },
  };
}

const textOf = (chunks = []) => chunks.filter((c) => c.type === "markdown_text").map((c) => c.text).join("");
/** All markdown that reached Slack over native streams, in order. */
const streamedText = (client) => client.calls
  .filter(([m]) => m === "startStream" || m === "appendStream" || m === "stopStream")
  .map(([, a]) => textOf(a.chunks))
  .join("");

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const opts = (client, c, over = {}) => ({
  client, channel: "C1", threadTs: "100.1", recipientUserId: "U1", recipientTeamId: "T1", now: c.now, ...over,
});

describe("SlackReplyStream, native streaming", () => {
  it("starts a stream in the thread for the person, then appends, then stops", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c));
    await s.text("Hello");
    await s.text(" there");          // inside the flush interval: buffered
    c.advance(2000);
    await s.text(", friend");        // interval passed: appended
    await s.text("!");
    await s.finish();

    const [start] = client.of("startStream");
    assert.equal(start.channel, "C1");
    assert.equal(start.thread_ts, "100.1");
    assert.equal(start.recipient_user_id, "U1");
    assert.equal(start.recipient_team_id, "T1");
    assert.equal(start.task_display_mode, "timeline");
    assert.equal(textOf(start.chunks), "Hello");
    assert.equal(client.of("appendStream").length, 1);
    assert.equal(client.of("stopStream").length, 1);
    assert.equal(streamedText(client), "Hello there, friend!");
    assert.equal(s.mode, "native");
    assert.equal(s.sentText, true);
  });

  it("shows each tool as a task card that turns complete or error", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c));
    await s.text("Checking.");
    await s.toolStart("t1", "Running command…");
    await s.toolDone("t1", "Command done", true);
    await s.toolStart("t2", "Reading a.md…");
    await s.toolDone("t2", "Read a.md", false);
    await s.finish();

    const tasks = client.calls.flatMap(([, a]) => (a.chunks || []).filter((ch) => ch.type === "task_update"));
    assert.deepEqual(tasks.map((t) => [t.id, t.status]), [["t1", "in_progress"], ["t1", "complete"], ["t2", "in_progress"], ["t2", "error"]]);
    assert.equal(tasks[1].title, "Command done");
    // Text written before a tool reaches Slack before the tool's card.
    const firstTask = client.calls.findIndex(([, a]) => (a.chunks || []).some((ch) => ch.type === "task_update"));
    const textBefore = client.calls.slice(0, firstTask + 1).map(([, a]) => textOf(a.chunks)).join("");
    assert.equal(textBefore, "Checking.");
  });

  it("rolls over to a new message before Slack's markdown cap, losing nothing", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { maxStreamChars: 40 }));
    const words = Array.from({ length: 12 }, (_, i) => `word${i}\n`).join("");
    for (const ch of words) { c.advance(1500); await s.text(ch); }
    await s.finish();

    assert.ok(client.of("startStream").length >= 2, "more than one message");
    const stops = client.of("stopStream");
    assert.ok(stops.slice(0, -1).every((a) => a.session_status === "processing"), "the turn is still going at each rollover");
    assert.equal(stops.at(-1).session_status, undefined, "the last stop ends the turn");
    assert.equal(streamedText(client), words);
    // No one stream carried more than the cap.
    let perStream = 0;
    for (const [m, a] of client.calls) {
      if (m === "startStream") perStream = 0;
      perStream += textOf(a.chunks).length;
      assert.ok(perStream <= 40 + 4, `stream too long: ${perStream}`);
    }
  });

  it("closes a code fence at a rollover and opens it again in the next message", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { maxStreamChars: 60 }));
    const code = "```js\n" + Array.from({ length: 10 }, (_, i) => `x${i}();\n`).join("");
    for (const line of code.split(/(?<=\n)/)) { c.advance(1500); await s.text(line); }
    await s.text("```\n");
    await s.finish();

    // Each message on its own has balanced fences.
    const messages = [];
    for (const [m, a] of client.calls) {
      if (m === "startStream") messages.push("");
      if (["startStream", "appendStream", "stopStream"].includes(m)) messages[messages.length - 1] += textOf(a.chunks);
    }
    assert.ok(messages.length >= 2);
    for (const msg of messages) assert.equal((msg.match(/^```/gm) || []).length % 2, 0, `unbalanced: ${JSON.stringify(msg)}`);
    assert.ok(messages[1].startsWith("```js\n"), "the next message reopens the fence with its language");
  });

  it("hands over to a new message before the 10-minute stream limit, carrying running tools", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { maxStreamMs: 9 * 60_000 }));
    await s.text("Working on it.");
    await s.toolStart("t1", "Running command…");
    c.advance(9 * 60_000 + 1);
    await s.tick();
    await s.toolDone("t1", "Command done", true);
    await s.finish();

    const starts = client.of("startStream");
    assert.equal(starts.length, 2);
    const first = client.of("stopStream")[0];
    assert.equal(first.session_status, "processing");
    // The running tool shows in the new message and finishes there.
    const reopened = starts[1].chunks.find((ch) => ch.type === "task_update");
    assert.equal(reopened.id, "t1");
    assert.equal(reopened.status, "in_progress");
    const secondStart = client.calls.findIndex(([m, a]) => m === "startStream" && a === starts[1]);
    const done = client.calls.slice(secondStart)
      .flatMap(([, a]) => a.chunks || []).find((ch) => ch.type === "task_update" && ch.id === "t1" && ch.status === "complete");
    assert.ok(done, "completed in the new message");
  });

  it("starts a fresh message when Slack says the stream already ended", async () => {
    const client = fakeClient({ appendStream: (_a, n) => (n === 1 ? "message_not_in_streaming_state" : null) });
    const c = clock();
    const s = new SlackReplyStream(opts(client, c));
    await s.text("one ");
    c.advance(2000);
    await s.text("two");
    await s.finish();
    assert.equal(client.of("startStream").length, 2);
    assert.equal(textOf(client.of("startStream")[1].chunks), "two");
  });

  it("marks a tool still running when the reply ends as not finished, instead of leaving it spinning", async () => {
    const client = fakeClient();
    const s = new SlackReplyStream(opts(client, clock()));
    await s.toolStart("t1", "Running command…");
    await s.finish();
    const stop = client.of("stopStream").at(-1);
    const card = (stop.chunks || []).find((ch) => ch.type === "task_update" && ch.id === "t1");
    assert.ok(card, "the stop carries the card's last state");
    assert.equal(card.status, "error");
    assert.match(card.details, /did not finish/i);

    const edit = fakeClient();
    const e = new SlackReplyStream(opts(edit, clock(), { native: false }));
    await e.toolStart("t1", "Running command…");
    await e.finish();
    assert.match(edit.of("update").at(-1).markdown_text, /^❌ _Running command… — did not finish_$/);
  });

  it("stops when the person presses stop", async () => {
    const client = fakeClient({ appendStream: "stopped_by_user" });
    const c = clock();
    let stopped = 0;
    const s = new SlackReplyStream(opts(client, c, { onStoppedByUser: () => { stopped++; } }));
    await s.text("one ");
    c.advance(2000);
    await s.text("two");
    c.advance(2000);
    await s.text("three");
    await s.finish();
    assert.equal(stopped, 1);
    assert.equal(s.stoppedByUser, true);
    assert.equal(client.of("appendStream").length, 1, "nothing more is sent after stop");
  });
});

describe("SlackReplyStream, editing fallback", () => {
  it("falls back to posting and editing when Slack refuses native streaming, and says why", async () => {
    const client = fakeClient({ startStream: "feature_disabled" });
    const c = clock();
    let reason = null;
    const s = new SlackReplyStream(opts(client, c, { onNativeUnavailable: (code) => { reason = code; } }));
    await s.text("Hello");
    c.advance(2000);
    await s.text(" world");
    await s.finish();

    assert.equal(reason, "feature_disabled");
    assert.equal(s.mode, "edit");
    const [post] = client.of("postMessage");
    assert.equal(post.channel, "C1");
    assert.equal(post.thread_ts, "100.1");
    assert.equal(post.markdown_text, "Hello");
    assert.equal(client.of("update").at(-1).markdown_text, "Hello world");
  });

  it("does not give up on native streaming for a passing error", async () => {
    let reason = null;
    const client = fakeClient({ startStream: "internal_error" });
    const s = new SlackReplyStream(opts(client, clock(), { onNativeUnavailable: (code) => { reason = code; } }));
    await s.text("Hi");
    await s.finish();
    assert.equal(s.mode, "edit", "this reply still gets through");
    assert.equal(reason, null, "but the bot is not told to stop trying");
    assert.equal(client.of("postMessage")[0].markdown_text, "Hi");
  });

  it("edits straight away when told native streaming is off", async () => {
    const client = fakeClient();
    const s = new SlackReplyStream(opts(client, clock(), { native: false }));
    await s.text("Hi");
    await s.finish();
    assert.equal(client.of("startStream").length, 0);
    assert.equal(client.of("postMessage")[0].markdown_text, "Hi");
  });

  it("posts a status line for each tool and edits it when the tool finishes", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { native: false }));
    await s.text("Let me look.");
    await s.toolStart("t1", "Running command…");
    await s.toolDone("t1", "Command done", true);
    await s.text("Found it.");
    await s.finish();

    const posts = client.of("postMessage").map((p) => p.markdown_text);
    assert.deepEqual(posts, ["Let me look.", "⚙️ _Running command…_", "Found it."]);
    assert.ok(client.of("update").some((u) => u.markdown_text === "✓ _Command done_"));
  });

  it("starts a new message when one gets too long for Slack", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { native: false, maxMessageChars: 50 }));
    const long = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("");
    for (const line of long.split(/(?<=\n)/)) { c.advance(2000); await s.text(line); }
    await s.finish();
    assert.ok(client.of("postMessage").length >= 2, "more than one message");
    for (const u of [...client.of("postMessage"), ...client.of("update")]) assert.ok(u.markdown_text.length <= 50, `too long: ${u.markdown_text.length}`);
    // Each message's last version, in order, is the whole answer.
    const last = new Map();
    for (const [m, a, result] of client.calls) {
      if (m === "postMessage") last.set(result.ts, a.markdown_text);
      if (m === "update") last.set(a.ts, a.markdown_text);
    }
    assert.equal([...last.values()].join("").replace(/\s+/g, ""), long.replace(/\s+/g, ""));
  });
});

describe("SlackReplyStream, editing fallback with code", () => {
  /** Each message's last version, in the order they were posted. */
  const finalMessages = (client) => {
    const last = new Map();
    for (const [m, a, result] of client.calls) {
      if (m === "postMessage") last.set(result.ts, a.markdown_text);
      if (m === "update") last.set(a.ts, a.markdown_text);
    }
    return [...last.values()];
  };

  it("splits a long code block across messages without losing, gluing or unfencing a line", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { native: false, maxMessageChars: 120 }));
    const lines = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};\n`);
    const text = "Here:\n```js\n" + lines.join("") + "```\nAfter.";
    for (const piece of text.split(/(?<=\n)/)) { c.advance(2000); await s.text(piece); }
    await s.finish();

    const msgs = finalMessages(client);
    assert.ok(msgs.length >= 3, `split into several messages: ${msgs.length}`);
    for (const m of msgs) {
      assert.ok(m.length <= 120, `too long: ${m.length}`);
      assert.equal((m.match(/^```/gm) || []).length % 2, 0, `unbalanced fences: ${JSON.stringify(m)}`);
      assert.ok(!/```[^\s`]/.test(m.replace(/```js\n/g, "")), `a fence glued to code: ${JSON.stringify(m)}`);
    }
    for (const m of msgs.slice(1, -1)) assert.ok(m.startsWith("```js\n"), `a continuation reopens the block: ${JSON.stringify(m)}`);
    const code = msgs.join("\n").match(/^const v\d+ = \d+;$/gm);
    assert.deepEqual(code, lines.map((l) => l.trim()), "every line once, in order");
    assert.ok(msgs[0].startsWith("Here:\n```js\n"));
    assert.ok(msgs.at(-1).endsWith("```\nAfter."));
  });

  it("shows a block still being written as closed, so the rest of the message is not swallowed", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { native: false }));
    await s.text("```py\nx = 1\n");
    assert.equal(client.of("postMessage")[0].markdown_text, "```py\nx = 1\n```");
    c.advance(2000);
    await s.text("```\nDone.");
    await s.finish();
    assert.equal(client.of("update").at(-1).markdown_text, "```py\nx = 1\n```\nDone.");
  });
});

describe("SlackReplyStream, when things go wrong part-way", () => {
  it("falling back after a rollover keeps the code block open and ends the agent session", async () => {
    const client = fakeClient({ startStream: (_a, n) => (n === 2 ? "internal_error" : null) });
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { maxStreamChars: 40 }));
    for (const line of ["```js\n", "const a = 1;\n", "const b = 2;\n", "const c = 3;\n", "const d = 4;\n", "```\n"]) {
      c.advance(1500);
      await s.text(line);
    }
    await s.finish();
    assert.equal(s.mode, "edit");
    const posted = client.of("postMessage").map((p) => p.markdown_text);
    const updated = client.of("update").map((u) => u.markdown_text);
    const last = updated.at(-1) || posted.at(-1);
    assert.ok(last.startsWith("```js\n"), `the rest of the block is still code: ${JSON.stringify(last)}`);
    assert.equal(client.of("sessionStatus").at(-1)?.status, "active", "the session is not left spinning");
  });

  it("posts the last words when Slack refuses the final stop, instead of dropping them", async () => {
    const client = fakeClient({ stopStream: "internal_error" });
    const c = clock();
    const s = new SlackReplyStream(opts(client, c));
    await s.text("First part.");
    await s.text(" Last part.");
    await s.finish();
    assert.ok(client.of("postMessage").some((p) => /Last part\./.test(p.markdown_text)), "the tail reaches the thread");
  });

  it("sends held text on its own once the interval passes, without waiting for more", async () => {
    const client = fakeClient();
    const s = new SlackReplyStream(opts(client, { now: Date.now }, { flushIntervalMs: 40 }));
    await s.text("one ");
    await s.text("two");
    assert.equal(streamedText(client), "one ");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(streamedText(client), "one two");
    await s.finish();
  });

  it("takes back every message of the reply when the turn starts over, rolled-over ones included", async () => {
    const client = fakeClient();
    const c = clock();
    const s = new SlackReplyStream(opts(client, c, { maxStreamChars: 10 }));
    for (const w of ["aaaa\n", "bbbb\n", "cccc\n", "dddd\n", "eeee\n"]) { c.advance(1500); await s.text(w); }
    const started = client.calls.filter(([m]) => m === "startStream").map(([, , r]) => r.ts);
    assert.ok(started.length >= 2);
    await s.discard();
    const deleted = client.of("delete").map((d) => d.ts);
    for (const ts of started) assert.ok(deleted.includes(ts), `${ts} deleted`);
    assert.equal(s.sentText, false);
  });
});

describe("slackErrorCode", () => {
  it("reads Slack's error code off a thrown error", () => {
    assert.equal(slackErrorCode(platformError("ratelimited")), "ratelimited");
    assert.equal(slackErrorCode(new Error("boom")), null);
    assert.equal(slackErrorCode(null), null);
  });
});
