// Token usage (src/lib/token-usage.js, src/routes/analytics.js): model calls read from Claude Code's session
// transcripts, placed in the live timeline's turns, grouped into jobs and added up for the Usage page.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep the modules under test away from the real state directory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-usage-"));
process.env.TARSEE_STATE_DIR = tmp;
const {
  parseTranscriptLines, newReadState, figures, callSums, addSums, EMPTY, groupJobs, matchSession, pickTurn,
  promptTitle, modelLabel, channelOf, cronOfPrompt, UsageIndex, projectDirs, zoneOffsetMs, localMidnight, localDay, dayStarts,
} = await import("../src/lib/token-usage.js");
const { initDb } = await import("../src/db/sqlite.js");

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const T0 = Date.parse("2026-10-25T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const usage = (o) => ({ input_tokens: o.in ?? 2, cache_read_input_tokens: o.cr ?? 0, cache_creation_input_tokens: o.cw ?? 0, output_tokens: o.out ?? 0 });
const req = (id, at, effort = "high") => JSON.stringify({ type: "api-request", sessionId: "s", id, timestamp: iso(at), params: { model: "claude-test-1-2", output_config: { effort } } });
const asst = (msgId, at, u, { ref = null, model = "claude-test-1-2", block = "text" } = {}) => JSON.stringify({
  parentUuid: null, isSidechain: false, message: { id: msgId, model, role: "assistant", content: [{ type: block }], usage: usage(u) },
  requestRef: ref, type: "assistant", uuid: `u-${msgId}-${at}`, timestamp: iso(at),
});
const typed = (text, at, extra = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, timestamp: iso(at), ...extra });
const toolResult = (at) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(50) }] }, uuid: "r", timestamp: iso(at), toolUseResult: { stdout: "ok" } });

describe("reading a transcript", () => {
  it("a call written over several lines comes once: its usage, from its request to its last block, its effort", () => {
    const lines = [
      typed("[alice]: draft the release notes", T0),
      req("r1", T0 + 100, "max"),
      asst("m1", T0 + 3000, { cr: 50_000, cw: 1000, out: 200 }, { ref: "r1", block: "thinking" }),
      asst("m1", T0 + 4100, { cr: 50_000, cw: 1000, out: 400 }, { ref: "r1", block: "tool_use" }),
      toolResult(T0 + 9000),
      req("r2", T0 + 9010),
      asst("m2", T0 + 19_010, { cr: 51_000, out: 1000 }, { ref: "r2" }),
    ];
    const { calls, prompts } = parseTranscriptLines(lines);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { id: "m1", model: "claude-test-1-2", effort: "max", startedAt: T0 + 100, endedAt: T0 + 4100, input: 2, cacheRead: 50_000, cacheWrite: 1000, output: 400 });
    assert.equal(calls[1].startedAt, T0 + 9010);
    assert.equal(calls[1].endedAt, T0 + 19_010);
    assert.deepEqual(prompts, [{ at: T0, head: "[alice]: draft the release notes", tail: "" }]);
  });

  it("without request lines (the SDK's bundled CLI may not write them) the line before a call is when it went out; the state carries over between reads", () => {
    const st = newReadState();
    parseTranscriptLines([typed("hello", T0)], st);
    const { calls } = parseTranscriptLines([asst("m1", T0 + 5000, { out: 100 })], st);
    assert.equal(calls[0].startedAt, T0, "the prompt before it, read last time");
    const next = parseTranscriptLines([toolResult(T0 + 8000), asst("m2", T0 + 10_000, { out: 50 })], st);
    assert.equal(next.calls[0].startedAt, T0 + 8000, "the tool result it answers");
  });

  it("leaves out the harness's own lines: notes, task notifications, synthetic replies, empty usage", () => {
    const { calls, prompts } = parseTranscriptLines([
      typed("<task-notification>done</task-notification>", T0),
      typed("a note", T0 + 1, { isMeta: true }),
      typed("an agent's hand-back", T0 + 2, { origin: { kind: "peer" } }),
      asst("m0", T0 + 3, { in: 0, out: 0 }, { model: "<synthetic>" }),
      asst("m00", T0 + 4, { in: 0, out: 0 }),
      "not json at all {",
    ]);
    assert.equal(calls.length, 0);
    assert.equal(prompts.length, 0);
  });
});

describe("sums and speed", () => {
  it("tk/s is output over generation time, and total tk/s is every token over the same time", () => {
    const a = callSums({ input: 10, cacheRead: 90_000, cacheWrite: 0, output: 1000, startedAt: T0, endedAt: T0 + 10_000 });
    const b = callSums({ input: 0, cacheRead: 0, cacheWrite: 9990, output: 1000, startedAt: T0, endedAt: T0 + 10_000 });
    const f = figures(addSums(a, b));
    assert.equal(f.total, 10 + 90_000 + 9990 + 2000);
    assert.equal(f.outTps, 100, "2000 tokens out in 20 s of generation");
    assert.equal(f.totalTps, Math.round(((10 + 90_000 + 9990 + 2000) / 20) * 10) / 10);
    assert.equal(f.cacheShare, Math.round((90_000 / f.total) * 1000) / 1000);
  });

  it("a call with no believable generation time still counts its tokens, not its speed", () => {
    const slow = callSums({ input: 1, cacheRead: 0, cacheWrite: 0, output: 500, startedAt: T0, endedAt: T0 + 3 * 3_600_000 });
    const none = callSums({ input: 1, cacheRead: 0, cacheWrite: 0, output: 500, startedAt: null, endedAt: T0 });
    const f = figures(addSums(slow, none));
    assert.equal(f.output, 1000);
    assert.equal(f.outTps, null);
    assert.deepEqual(figures(EMPTY).outTps, null);
  });

  it("names: models, channels, a message as a title", () => {
    assert.equal(modelLabel("claude-test-1-2"), "Test 1.2");
    assert.equal(modelLabel("claude-test-1-2-20261001"), "Test 1.2");
    assert.equal(modelLabel("claude-test-3"), "Test 3");
    assert.equal(modelLabel("something-else"), "something-else");
    assert.equal(channelOf("discord", "abc"), "Discord");
    assert.equal(channelOf("whatsapp", "abc"), "WhatsApp");
    assert.equal(channelOf("email", "abc"), "Email");
    assert.equal(channelOf(null, "cron:cron_daily"), "Crons");
    assert.equal(channelOf("heartbeat", "heartbeat"), "Heartbeat");
    assert.equal(channelOf("boot", "boot"), "Boot checklist");
    assert.equal(channelOf("api", "abc"), "API");
    assert.equal(channelOf("somewhere", "abc"), "Other");
    assert.equal(promptTitle('[alice]: [Replying to Tarsee: "**Draft 2 is ready:** "quoted" and more"]\n\ntighten the intro please'), "tighten the intro please");
    assert.equal(promptTitle("[alice]: summarise the meeting notes"), "summarise the meeting notes");
    assert.equal(promptTitle('[Replying to alice: "look for the invoice in the shared drive"]'), "look for the invoice in the shared drive", "a reply to one's own message: its quote is the ask");
    assert.equal(promptTitle("[Cron Job: cron_daily — 2026-10-26T00:30:00.021Z]\n\nSummarise the inbox"), "Summarise the inbox");
    assert.equal(cronOfPrompt("[Cron Job: cron_daily — 2026-10-26T00:30:00.021Z]\n\nSummarise the inbox"), "cron:cron_daily");
    assert.equal(cronOfPrompt("hello"), null);
  });
});

describe("days and hours in the configured timezone", () => {
  it("knows each zone's offset, its local date and its midnight", () => {
    assert.equal(zoneOffsetMs(T0, "UTC"), 0);
    assert.equal(zoneOffsetMs(T0, "Asia/Kolkata"), 5.5 * 3_600_000);
    assert.equal(zoneOffsetMs(T0, "America/New_York"), -4 * 3_600_000, "summer time on Oct 25");
    assert.equal(zoneOffsetMs(T0, "Not/AZone"), 0, "an unknown zone counts as UTC");
    assert.equal(localDay(T0, "America/New_York"), "2026-10-24");
    assert.equal(localDay(T0, "Asia/Tokyo"), "2026-10-25");
    assert.equal(localMidnight(T0 + 3_600_000, "UTC"), T0);
    assert.equal(localMidnight(T0, "Asia/Tokyo"), Date.parse("2026-10-24T15:00:00Z"));
    assert.equal(localMidnight(T0, "America/New_York"), Date.parse("2026-10-24T04:00:00Z"));
  });
  it("a day with a clock change runs from midnight to midnight (25 hours), and the days before keep their own", () => {
    const now = Date.parse("2026-11-02T18:00:00Z");   // the day after New York's clocks went back
    const starts = dayStarts(now, 3, "America/New_York");
    assert.deepEqual(starts.map((s) => new Date(s).toISOString()), [
      "2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z",
    ]);
    assert.equal(starts[2] - starts[1], 25 * 3_600_000);
  });
});

describe("where the transcripts are", () => {
  it("the workspace's folder under every Claude home, each real folder once, under either slug spelling", () => {
    const home = path.join(tmp, "claude-a");
    const cwd = "/srv/my.workspace";
    // Tarsee's slug rule folds a run of separators and dots into one "-"; Claude Code's own may not.
    fs.mkdirSync(path.join(home, "projects", "-srv-my-workspace"), { recursive: true });
    fs.symlinkSync(home, path.join(tmp, ".claude-code-home"));   // the same folder through a symlink (TARSEE_STATE_DIR's)
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const dirs = projectDirs(cwd);
      assert.equal(dirs.length, 1, "the symlinked home is the same folder");
      assert.equal(fs.realpathSync(dirs[0]), fs.realpathSync(path.join(home, "projects", "-srv-my-workspace")));
      // "/srv/x_y": Tarsee's rule keeps the "_", a letters-and-digits-only rule does not.
      fs.mkdirSync(path.join(home, "projects", "-srv-x-y"), { recursive: true });
      assert.deepEqual(projectDirs("/srv/x_y").map((d) => path.basename(d)), ["-srv-x-y"]);
      assert.equal(projectDirs("/nowhere/at/all").length, 0);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });
});

describe("whose session, which turn", () => {
  const turns = [
    { conversationId: "notes", startedAt: T0, prompt: "[alice]: summarise the meeting notes and list the action items" },
    { conversationId: "ops", startedAt: T0 + 60_000, prompt: "[bob]: Go" },
  ];
  it("a session belongs to the chat whose turn its prompt was typed from, even under a context preamble", () => {
    assert.equal(matchSession([{ at: T0 + 2000, head: "[alice]: summarise the meeting notes and list the action items by owner", tail: "" }], turns), "notes");
    assert.equal(matchSession([{ at: T0 + 2000, head: "[Context recovery: your prior session was retired. Recent messages: ...", tail: "... [alice]: summarise the meeting notes and list the action items by owner" }], turns), "notes");
    assert.equal(matchSession([{ at: T0 + 4 * 3_600_000, head: "[alice]: summarise the meeting notes and list the action items", tail: "" }], turns), "notes", "queued behind a long turn");
    assert.equal(matchSession([{ at: T0 - 60_000, head: "[alice]: summarise the meeting notes and list the action items", tail: "" }], turns), null, "typed before the turn began: not it");
  });
  it("a short prompt only counts when it was typed right as its turn began; a cron's header says whose it is", () => {
    assert.equal(matchSession([{ at: T0 + 61_000, head: "[bob]: Go", tail: "" }], turns), "ops");
    assert.equal(matchSession([{ at: T0 + 30 * 60_000, head: "[bob]: Go", tail: "" }], turns), null);
    assert.equal(matchSession([{ at: T0, head: "[Cron Job: cron_daily — x]", tail: "" }], turns), "cron:cron_daily");
  });
  it("a call goes to the turn working then (the older of two queued ones), else to the last turn before it", () => {
    const list = [
      { turnId: "a", startedAt: T0, endedAt: T0 + 100_000 },
      { turnId: "b", startedAt: T0 + 10_000, endedAt: T0 + 120_000 },
      { turnId: "c", startedAt: T0 + 500_000, endedAt: null },
    ];
    assert.equal(pickTurn(list, T0 + 50_000).turnId, "a");
    assert.equal(pickTurn(list, T0 + 110_000).turnId, "b");
    assert.equal(pickTurn(list, T0 + 300_000).turnId, "b", "an agent reporting back after the turn ended");
    assert.equal(pickTurn(list, T0 + 900_000, T0 + 1_000_000).turnId, "c", "still running");
    assert.equal(pickTurn(list, T0 - 60_000), null);
    assert.equal(pickTurn([{ turnId: "a", startedAt: T0, endedAt: T0 + 1000 }], T0 + 13 * 3_600_000), null, "too long after to be its work");
  });
});

describe("jobs", () => {
  const M = 60_000;
  const turn = (id, conv, start, end, out, extra = {}) => ({
    turnId: id, conversationId: conv, source: "discord", startedAt: T0 + start * M, endedAt: end == null ? null : T0 + end * M, lastCallAt: null, prompt: `[alice]: ${id}`,
    model: "Test 1.2", effort: "high", sums: { ...EMPTY, calls: 1, cacheRead: out * 10, output: out, genMs: out * 10, genOut: out, genTokens: out * 11 }, ...extra,
  });
  const turns = [
    turn("e1", "notes", 0, 3, 100),
    turn("e2", "notes", 15, 240, 1000),
    turn("e3", "notes", 250, 275, 50),                        // 10 minutes after: the same job
    turn("e4", "notes", 360, 445, 170, { lastCallAt: null }), // 85 minutes idle: a new job
    turn("x1", "cron:cron_daily", 0, 2, 10, { source: "cron" }),
    turn("x2", "cron:cron_daily", 30, 32, 10, { source: "cron" }),
    turn("h1", "heartbeat", 0, 1, 5, { source: "heartbeat" }),
    turn("h2", "heartbeat", 5, 6, 5, { source: "heartbeat" }),
  ];
  it("a chat's turns are one job until it sits idle past the gap; a background run is a job of its own; sums add up", () => {
    const jobs = groupJobs(turns, {}, { gapMs: 45 * M });
    const notes = jobs.filter((j) => j.conversationId === "notes");
    assert.deepEqual(notes.map((j) => j.turnIds), [["e1", "e2", "e3"], ["e4"]]);
    assert.equal(notes[0].output, 1150);
    assert.equal(notes[0].total, 1150 * 11);
    assert.equal(notes[0].outTps, 100, "1150 out over 11.5 s");
    assert.equal(notes[0].title, "e1");
    assert.equal(notes[0].channel, "Discord");
    assert.equal(jobs.filter((j) => j.conversationId === "cron:cron_daily").length, 2);
    assert.equal(jobs.filter((j) => j.conversationId === "heartbeat").length, 2, "the heartbeat's runs stay apart too");
  });
  it("work an agent did after the turn ended keeps the job going", () => {
    const withAgent = turns.map((t) => (t.turnId === "e3" ? { ...t, lastCallAt: T0 + 330 * M } : t));
    const notes = groupJobs(withAgent, {}, { gapMs: 45 * M }).filter((j) => j.conversationId === "notes");
    assert.equal(notes.length, 1, "e4 began 30 minutes after the agent's last call");
  });
  it("names and merges: a job joins the one before it, under the name it was given", () => {
    const jobs = groupJobs(turns, { names: { e1: "Release notes" }, merges: { e4: "e1" } }, { gapMs: 45 * M });
    const notes = jobs.filter((j) => j.conversationId === "notes");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, "Release notes");
    assert.equal(notes[0].turns, 4);
    assert.equal(notes[0].output, 1320);
    assert.deepEqual(notes[0].mergedKeys, ["e4"]);
    assert.equal(groupJobs(turns, { merges: { e4: "nope" } }, { gapMs: 45 * M }).filter((j) => j.conversationId === "notes").length, 2, "a merge into a job that is not there does nothing");
  });
  it("a job with a turn still running is running", () => {
    const [j] = groupJobs([turn("r1", "web1", 0, null, 10)], {}, { now: T0 + 5 * M });
    assert.equal(j.running, true);
    assert.equal(j.endedAt, null);
  });
});

describe("a turn that waited in the queue", () => {
  it("is named by the message it was queued for, not one sent while it waited; it starts when it began", async () => {
    const at = (s) => T0 + s * 1000;
    const qdir = fs.mkdtempSync(path.join(tmp, "projects-q-"));
    const qdb = initDb(path.join(tmp, `usage-q-${Date.now()}.db`));
    const ev = qdb.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
    ev.run("convQ", null, "message", JSON.stringify({ id: "u1", role: "user", content: "[sam]: add a weekly report to the scraper" }), at(0));
    ev.run("convQ", "A", "turn_start", JSON.stringify({ source: "discord", prompt: "[sam]: add a weekly report to the scraper" }), at(1));
    ev.run("convQ", null, "message", JSON.stringify({ id: "u2", role: "user", content: "[sam]: and send it on Mondays" }), at(5));
    ev.run("convQ", "B", "turn_queued", JSON.stringify({ source: "discord", prompt: "[sam]: and send it on Mondays" }), at(6));
    ev.run("convQ", null, "message", JSON.stringify({ id: "u3", role: "user", content: "[sam]: one for the blog too" }), at(200));
    ev.run("convQ", "C", "turn_queued", JSON.stringify({ source: "discord", prompt: "[sam]: one for the blog too" }), at(201));
    ev.run("convQ", "A", "turn_end", JSON.stringify({ stopReason: "end_turn" }), at(250));
    ev.run("convQ", "B", "turn_start", JSON.stringify({ source: "discord", prompt: "[sam]: and send it on Mondays" }), at(251));
    ev.run("convQ", "C", "turn_end", JSON.stringify({ stopReason: "removed" }), at(252));
    const qindex = new UsageIndex(qdb, { dirs: [qdir], now: () => at(500) });
    await qindex.refresh();
    const b = qdb.prepare("SELECT title, started_at FROM usage_turns WHERE turn_id = 'B'").get();
    assert.equal(b.title, "and send it on Mondays");
    assert.equal(b.started_at, at(251), "from when it began");
    assert.equal(qdb.prepare("SELECT COUNT(*) AS n FROM usage_turns WHERE turn_id = 'C'").get().n, 0, "taken out of the queue: never a turn");
    qdb.close();
  });
});

describe("the index: transcripts and events into turns, read a piece at a time", () => {
  let db, dir, index, file;
  const at = (s) => T0 + s * 1000;
  before(() => {
    dir = fs.mkdtempSync(path.join(tmp, "projects-"));
    db = initDb(path.join(tmp, `usage-${Date.now()}.db`));
    // conv1's stored session is sess1. conv2's was reset since (its claude_session_id is gone), so only
    // its turn_end says sess2 was its session.
    db.prepare("INSERT INTO conversations (id, title, claude_session_id) VALUES (?, ?, ?)").run("conv1", "#notes", "sess1");
    db.prepare("INSERT INTO conversations (id, title, claude_session_id) VALUES (?, ?, ?)").run("conv2", "Chat with bob", null);
    const ev = db.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
    ev.run("conv1", null, "message", JSON.stringify({ id: "u1", role: "user", content: '[alice]: [Replying to Tarsee: "v3"]\n\nwrite the changelog' }), at(0));
    ev.run("conv1", "t1", "turn_start", JSON.stringify({ source: "discord", model: "test", prompt: '[alice]: [Replying to Tarsee: "v3"]' }), at(1));
    ev.run("conv1", "t1", "turn_end", JSON.stringify({ stopReason: "end_turn" }), at(100));
    ev.run("conv1", null, "message", JSON.stringify({ id: "a1", role: "assistant", content: "done" }), at(100.05));
    ev.run("conv2", "t2", "turn_start", JSON.stringify({ source: "whatsapp", prompt: "ok" }), at(200));
    ev.run("conv2", "t2", "turn_end", JSON.stringify({ stopReason: "end_turn", sessionId: "sess2" }), at(260));
    file = path.join(dir, "sess1.jsonl");
    fs.writeFileSync(file, [
      typed('[alice]: [Replying to Tarsee: "v3"]', at(2)),
      req("r1", at(2)), asst("m1", at(12), { cr: 100_000, cw: 2000, out: 1000 }, { ref: "r1" }),
      req("r2", at(20)), asst("m2", at(30), { cr: 102_000, out: 500 }, { ref: "r2" }),
    ].join("\n") + "\n" + req("r3", at(40)).slice(0, 30));   // a line still being written
    fs.mkdirSync(path.join(dir, "sess1", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sess1", "subagents", "agent-abc.jsonl"), [
      req("q1", at(50)), asst("g1", at(60), { cr: 20_000, out: 300 }, { ref: "q1" }),
      req("q2", at(400)), asst("g2", at(410), { cr: 21_000, out: 200 }, { ref: "q2" }),   // after the turn ended: still its agent's
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "sess2.jsonl"), [typed("ok", at(201)), asst("w1", at(230), { cr: 5000, out: 100 })].join("\n") + "\n");
    index = new UsageIndex(db, { dirs: [dir], now: () => at(500), timeZone: "America/New_York" });
  });
  after(() => { try { db.close(); } catch { /* closed */ } });

  it("sums each turn from its session's calls and its agents' calls, and links it to the reply it ended in", async () => {
    await index.refresh();
    const t = index.turn("t1");
    assert.equal(t.calls, 4);
    assert.equal(t.output, 2000);
    assert.equal(t.cacheRead, 243_000);
    assert.equal(t.cacheWrite, 2000);
    assert.equal(t.outTps, 50, "2000 out over 40 s");
    assert.equal(t.messageId, "a1");
    assert.equal(t.title, "write the changelog", "named by the whole message, not its quote");
    assert.equal(t.model, "Test 1.2");
    const chat = index.chat("conv1");
    assert.equal(chat.total.output, 2000);
    assert.equal(chat.byMessage.a1.turnId, "t1");
  });

  it("a session whose chat was reset is still found by the session id its turn_end names", () => {
    const t = index.turn("t2");
    assert.equal(t.calls, 1);
    assert.equal(t.output, 100);
    assert.equal(db.prepare("SELECT how FROM usage_sessions WHERE session_id = 'sess2'").get().how, "turn");
  });

  it("reads only what a transcript gained, and counts nothing twice", async () => {
    const before = fs.statSync(file).size;
    fs.appendFileSync(file, req("r3", at(40)).slice(30) + "\n" + asst("m3", at(45), { cr: 103_000, out: 250 }, { ref: "r3" }) + "\n" + asst("m2", at(30), { cr: 102_000, out: 500 }, { ref: "r2" }) + "\n");
    await index.refresh();
    const row = db.prepare("SELECT offset, size FROM usage_files WHERE path = ?").get(file);
    assert.ok(row.offset > before && row.offset === row.size, "read to the end, from where it stopped");
    const t = index.turn("t1");
    assert.equal(t.calls, 5);
    assert.equal(t.output, 2250, "the repeated m2 line is the same call");
    assert.equal(db.prepare("SELECT started_at FROM usage_calls WHERE id = 'm3'").get().started_at, at(40), "its request line was split across the two reads");
  });

  it("a new index on the same database (a restart) reads nothing again", async () => {
    const again = new UsageIndex(db, { dirs: [dir], now: () => at(500), timeZone: "America/New_York" });
    await again.refresh();
    assert.equal(again.progress.files, 0, "every file was already read to its end");
    assert.equal(again.turn("t1").output, 2250);
  });

  it("the overview adds up the same calls by model, channel, chat and job, and counts days in the configured zone", () => {
    const o = index.overview();
    assert.equal(o.timeZone, "America/New_York");
    assert.equal(o.week.output, 2350);
    assert.equal(o.byModel[0].model, "Test 1.2");
    assert.deepEqual(o.byChannel.map((c) => c.channel), ["Discord", "WhatsApp"]);
    assert.equal(o.byChat[0].title, "#notes");
    assert.equal(o.heaviest[0].key, "t1");
    assert.equal(o.heaviest[0].chatTitle, "#notes");
    assert.equal(o.windows.fiveHour.output, 2350, "no plan reading: the last 5 hours");
    assert.equal(o.windows.fiveHour.usedPct, null);
    assert.ok(o.speed.peak.outTps >= 50);
    assert.equal(o.days.length, 14);
    assert.equal(o.days.reduce((a, d) => a + d.output, 0), 2350, "each day's bar adds up to the week");
    assert.equal(o.days.at(-1).output, 2350, "all of it today");
    assert.equal(o.days.at(-1).day, "2026-10-24", "Oct 25 00:00 UTC is still Oct 24 in New York");
    assert.equal(o.today.output, 2350);
    assert.equal(o.hours.reduce((a, h) => a + h.output, 0), 2350);
  });
});

describe("the usage API: naming and merging jobs", () => {
  let server, base, db;
  const M = 60_000;
  before(async () => {
    const { default: express } = await import("express");
    const { analyticsRouter } = await import("../src/routes/analytics.js");
    const { __setUsageIndex } = await import("../src/lib/token-usage.js");
    db = initDb(path.join(tmp, `api-${Date.now()}.db`));
    const ev = db.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
    const now = Date.now();
    for (const [id, start, end] of [["j1", 0, 30], ["j2", 120, 150], ["j3", 300, 310]]) {
      ev.run("chatA", id, "turn_start", JSON.stringify({ source: "web", prompt: `turn ${id}` }), now - 400 * M + start * M);
      ev.run("chatA", id, "turn_end", JSON.stringify({ stopReason: "end_turn" }), now - 400 * M + end * M);
    }
    const index = new UsageIndex(db, { dirs: [path.join(tmp, "none")] });
    __setUsageIndex(index);
    await index.refresh();
    const app = express();
    app.use(express.json());
    app.set("db", db);
    app.use("/api/analytics", analyticsRouter);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api/analytics/usage`;
  });
  after(() => {
    server?.close();
    try { db.close(); } catch { /* closed */ }
  });
  const post = (key, body) => fetch(`${base}/jobs/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  it("lists each idle-separated run of turns as a job, then merges one into the job before it and names it", async () => {
    let { jobs } = await (await fetch(`${base}/jobs?days=1`)).json();
    assert.deepEqual(jobs.map((j) => j.key), ["j3", "j2", "j1"]);
    const merged = await post("j2", { merge: "previous" });
    assert.equal(merged.job.key, "j1");
    assert.deepEqual(merged.job.turnIds, ["j1", "j2"]);
    await post("j1", { name: "  Release   notes " });
    ({ jobs } = await (await fetch(`${base}/jobs?days=1`)).json());
    assert.deepEqual(jobs.map((j) => j.title), ["turn j3", "Release notes"]);
    assert.equal(jobs[1].turnList.length, 2);
    await post("j1", { split: true });
    ({ jobs } = await (await fetch(`${base}/jobs?days=1`)).json());
    assert.equal(jobs.length, 3, "split apart again, the name kept on the first");
    assert.equal(jobs[2].title, "Release notes");
    assert.equal((await post("j1", { merge: "previous" })).error, "There is no earlier job in this chat to merge it with.");
  });

  it("the overview names its timezone", async () => {
    const o = await (await fetch(base)).json();
    assert.equal(typeof o.timeZone, "string");
    assert.equal(o.days.length, 14);
    assert.equal(o.jobsThisWeek, 3);
  });
});
