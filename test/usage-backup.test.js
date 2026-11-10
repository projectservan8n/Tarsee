// Usage when the backup model answers (design 4.6 and 4.13): the turn begins on the chat's AI (turn_start names
// it), that AI can't answer, and ai.backupModel does. turn_end names who answered, and the turn's spend is that
// AI's: a plan-primary turn answered by a metered backup is priced, counted in the month's spend (so the monthly
// spending cap sees it) and shown on the Usage page as the backup's, never as "Included in plan". Both engines:
// a Claude Code backup's calls come from its home's transcript, a Codex backup's from recordDirect.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-usage-backup-"));
process.env.TARSEE_STATE_DIR = path.join(tmp, "state");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "state", "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "state", "data");
const savedHome = process.env.HOME;
process.env.HOME = path.join(tmp, "home");

const { UsageIndex, projectDirsByProvider } = await import("../src/lib/token-usage.js");
const { initDb } = await import("../src/db/sqlite.js");
const { default: config } = await import("../src/config/env.js");
const { priceFor } = await import("../src/ai/provider-registry.js");
const { monthlySpend } = await import("../src/ai/spend.js");

after(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const STATE = config.STATE_DIR;
const HOME_DIR = path.join(tmp, "home");
const CWD = "/srv/work";
const SLUG = "-srv-work";
const at = (hhmm) => Date.parse(`2026-11-09T${hhmm}:00Z`);
const NOW = at("23:00");
const close = (a, b, msg) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${msg || ""} expected ${b}, got ${a}`);
const price = (provider, model, moment, u) => {
  const r = priceFor(provider, model, moment);
  return ((u.in || 0) * r.in + (u.cr || 0) * r.cacheRead + (u.cw || 0) * r.cacheWrite + (u.out || 0) * r.out) / 1e6;
};
const asst = (msgId, moment, u, model) => JSON.stringify({
  message: { id: msgId, model, role: "assistant", content: [{ type: "text" }], usage: { input_tokens: u.in ?? 0, cache_read_input_tokens: u.cr ?? 0, cache_creation_input_tokens: u.cw ?? 0, output_tokens: u.out ?? 0 } },
  type: "assistant", uuid: `u-${msgId}`, timestamp: new Date(moment).toISOString(),
});
const writeTranscript = (session, lines) => {
  const dir = path.join(STATE, ".claude-home-deepseek", "projects", SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), lines.join("\n") + "\n");
};

describe("a turn the backup model answered", () => {
  let db, index, ev, turnRow;
  const U = { in: 20_000, cr: 100_000, out: 4_000 };

  before(() => {
    db = initDb(path.join(tmp, "usage.db"));
    ev = db.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
    turnRow = (id) => db.prepare("SELECT provider, engine, model, cost_usd FROM usage_turns WHERE turn_id = ?").get(id);
    fs.mkdirSync(path.join(STATE, ".claude-home-deepseek", "projects", SLUG), { recursive: true });   // (only folders that exist are read)
    const dirs =projectDirsByProvider(CWD, { stateDir: STATE, homeDir: HOME_DIR, env: { HOME: HOME_DIR } });
    index = new UsageIndex(db, { dirs, now: () => NOW, timeZone: "UTC", backfillDays: 3650 });
  });
  after(() => { try { db.close(); } catch { /* closed */ } });

  it("on Claude Code: the turn is the backup's, priced from its calls, and counted in the month's spend", async () => {
    db.prepare("INSERT INTO conversations (id, title, claude_session_id) VALUES (?, ?, ?)").run("convA", "Plan chat", null);
    ev.run("convA", "tA", "turn_start", JSON.stringify({ source: "web", prompt: "hello", provider: "claude", engine: "claude-code", model: "sonnet" }), at("10:00"));
    writeTranscript("ds-a", [asst("a1", at("10:01"), U, "deepseek-flash")]);
    ev.run("convA", "tA", "turn_end", JSON.stringify({ stopReason: "end_turn", provider: "deepseek", engine: "claude-code", sessionId: "ds-a", costUsd: 0.25 }), at("10:02"));
    await index.refresh();
    const want = price("deepseek", "deepseek-flash", at("10:01"), U);
    assert.ok(want > 0);
    const row = turnRow("tA");
    assert.equal(row.provider, "deepseek", "who answered");
    assert.equal(row.engine, "claude-code");
    close(row.cost_usd, want, "the calls' sum");
    const t = index.turn("tA");
    assert.equal(t.provider, "deepseek");
    assert.notEqual(t.costNote, "plan", "never \"Included in plan\"");
    close(t.costUsd, want);
    const month = monthlySpend(db, { now: NOW, timeZone: "UTC" });
    close(month.byProvider.deepseek, want, "the monthly cap sees it");
    assert.equal(month.byProvider.claude, undefined);
  });

  it("on Claude Code, with its calls read while the turn still ran: the cost still lands once turn_end names the backup", async () => {
    // The backup's session was saved on the chat as it ran (onSessionHandle), so a read mid-turn places its calls.
    db.prepare("INSERT INTO conversations (id, title, claude_session_id) VALUES (?, ?, ?)").run("convB", "Plan chat 2", "deepseek/cc/deepseek:ds-b");
    ev.run("convB", "tB", "turn_start", JSON.stringify({ source: "web", prompt: "again", provider: "claude", engine: "claude-code", model: "sonnet" }), at("12:00"));
    writeTranscript("ds-b", [asst("b1", at("12:01"), U, "deepseek-flash")]);
    await index.refresh();
    const placed = db.prepare("SELECT turn_id, cost_usd FROM usage_calls WHERE id = 'b1'").get();
    assert.equal(placed?.turn_id, "tB", "placed in the running turn");
    ev.run("convB", "tB", "turn_end", JSON.stringify({ stopReason: "end_turn", provider: "deepseek", engine: "claude-code", sessionId: "ds-b", costUsd: 0.25 }), at("12:02"));
    await index.refresh();
    const want = price("deepseek", "deepseek-flash", at("12:01"), U);
    const row = turnRow("tB");
    assert.equal(row.provider, "deepseek");
    close(row.cost_usd, want);
    assert.equal(index.turn("tB").provider, "deepseek");
  });

  it("on Codex: the call recordDirect made before turn_end goes on the backup's turn, priced", async () => {
    db.prepare("INSERT INTO conversations (id, title, claude_session_id) VALUES (?, ?, ?)").run("convC", "Plan chat 3", null);
    ev.run("convC", "tC", "turn_start", JSON.stringify({ source: "web", prompt: "codex", provider: "claude", engine: "claude-code", model: "sonnet" }), at("14:00"));
    // runAttempt records a Codex turn's usage before turn_end is published.
    const r = index.recordDirect({
      turnId: "tC", conversationId: "convC", threadId: "th-c", provider: "openai", engine: "codex", model: "gpt-6.1-sol",
      startedAt: at("14:00"), endedAt: at("14:01"), usage: { input_tokens: 50_000, cache_read_input_tokens: 10_000, output_tokens: 2_000 },
    });
    assert.equal(r.recorded, true);
    assert.ok(r.costUsd > 0);
    ev.run("convC", "tC", "turn_end", JSON.stringify({ stopReason: "end_turn", provider: "openai", engine: "codex", sessionId: "openai/cx/openai:th-c" }), at("14:02"));
    await index.refresh();
    const row = turnRow("tC");
    assert.equal(row.provider, "openai");
    assert.equal(row.engine, "codex");
    close(row.cost_usd, r.costUsd, "the recorded cost");
    close(monthlySpend(db, { now: NOW, timeZone: "UTC" }).byProvider.openai, r.costUsd);
  });

  it("a plan turn that the plan itself answered still costs nothing, whatever the engine reported", async () => {
    ev.run("convA", "tP", "turn_start", JSON.stringify({ source: "web", prompt: "plan", provider: "claude", engine: "claude-code", model: "sonnet" }), at("16:00"));
    ev.run("convA", "tP", "turn_end", JSON.stringify({ stopReason: "end_turn", provider: "claude", engine: "claude-code", costUsd: 1.5 }), at("16:01"));
    await index.refresh();
    const row = turnRow("tP");
    assert.equal(row.provider, "claude");
    assert.equal(row.cost_usd, null);
  });

  it("a turn_end that names no provider (an older event) keeps the turn_start's", async () => {
    ev.run("convA", "tO", "turn_start", JSON.stringify({ source: "web", prompt: "old", provider: "deepseek", engine: "claude-code", model: "deepseek-flash" }), at("17:00"));
    ev.run("convA", "tO", "turn_end", JSON.stringify({ stopReason: "end_turn", costUsd: 0.1 }), at("17:01"));
    await index.refresh();
    const row = turnRow("tO");
    assert.equal(row.provider, "deepseek");
    assert.equal(row.engine, "claude-code");
    close(row.cost_usd, 0.1, "the engine's figure, with no calls of its own");
  });
});
