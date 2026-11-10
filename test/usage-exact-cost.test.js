// A cost the provider itself reports is exact (design 4.13): an Anthropic key's total_cost_usd, and OpenRouter's own
// usage.cost when it streams one. The engine says so on its usage event (costExact), the turn layer carries it on
// turn_end, and the usage index (lib/token-usage.js) keeps it on the turn (usage_turns.cost_exact): that figure stands
// even when the turn's calls are priced from the catalog, and the Usage page labels it exact, not "est.". A total is
// exact only when every priced turn in it is.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-usage-exact-"));
process.env.TARSEE_STATE_DIR = path.join(tmp, "state");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "state", "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "state", "data");
const savedHome = process.env.HOME;
process.env.HOME = path.join(tmp, "home");

const { UsageIndex, projectDirsByProvider } = await import("../src/lib/token-usage.js");
const { initDb } = await import("../src/db/sqlite.js");
const { default: config } = await import("../src/config/env.js");
const { setCatalogModels } = await import("../src/ai/provider-registry.js");

const STATE = config.STATE_DIR;
const HOME_DIR = path.join(tmp, "home");
const CWD = "/srv/work";
const at = (hhmm) => Date.parse(`2026-11-09T${hhmm}:00Z`);
const NOW = at("12:00");
const MODEL = "anthropic/claude-sonnet-5.5";
const close = (a, b, msg) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${msg || ""} expected ${b}, got ${a}`);
const asst = (msgId, when, out, model) => JSON.stringify({
  message: { id: msgId, model, role: "assistant", content: [{ type: "text" }], usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out } },
  type: "assistant", uuid: `u-${msgId}`, timestamp: new Date(when).toISOString(),
});
/** A session's transcript in a key provider's Claude home (engine-env homeFor: <state>/.claude-home-<id>). */
const tpath = (home, s) => path.join(STATE, home, "projects", "-srv-work", `${s}.jsonl`);

let db;
let index;
before(() => {
  setCatalogModels("openrouter", [{ id: MODEL, label: "Anthropic: Claude Sonnet 5.5", vendor: "anthropic", context: 1_000_000, price: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 } }]);
  db = initDb(path.join(tmp, "usage.db"));
  const conv = db.prepare("INSERT INTO conversations (id, title, claude_session_id) VALUES (?, ?, ?)");
  conv.run("convO", "Exact chat", "openrouter/cc/anthropic:or-exact");
  conv.run("convE", "Estimated chat", "openrouter/cc/anthropic:or-est");
  conv.run("convD", "DeepSeek exact", "deepseek/cc/deepseek:ds-exact");
  const ev = db.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
  const turn = (c, t, start, end, endP, { provider = "openrouter", model = MODEL } = {}) => {
    ev.run(c, t, "turn_start", JSON.stringify({ source: "web", prompt: t, provider, engine: "claude-code", model }), start);
    ev.run(c, t, "turn_end", JSON.stringify({ stopReason: "end_turn", provider, engine: "claude-code", ...endP }), end);
  };
  // OpenRouter streamed its own cost for this turn: exact.
  turn("convO", "tO", at("03:00"), at("03:10"), { costUsd: 0.0123, costExact: true });
  // No streamed cost: the engine's figure is the price table's, an estimate.
  turn("convE", "tE", at("05:00"), at("05:10"), { costUsd: 0.99 });
  // A provider whose own cost source is the price table (DeepSeek), with an exact figure on its one turn: an "exact"
  // for DeepSeek or its model can only come from the rows themselves.
  turn("convD", "tD", at("07:00"), at("07:10"), { costUsd: 0.0042, costExact: true }, { provider: "deepseek", model: "deepseek-flash" });
  const dir = (s) => tpath(".claude-home-openrouter", s);
  fs.mkdirSync(path.dirname(dir("x")), { recursive: true });
  fs.writeFileSync(dir("or-exact"), [asst("o1", at("03:01"), 100, MODEL), asst("o2", at("03:05"), 100, MODEL)].join("\n") + "\n");
  fs.writeFileSync(dir("or-est"), [asst("e1", at("05:01"), 200, MODEL)].join("\n") + "\n");
  fs.mkdirSync(path.dirname(tpath(".claude-home-deepseek", "x")), { recursive: true });
  fs.writeFileSync(tpath(".claude-home-deepseek", "ds-exact"), asst("d1", at("07:01"), 100, "deepseek-flash") + "\n");
  const dirs = projectDirsByProvider(CWD, { stateDir: STATE, homeDir: HOME_DIR, env: { HOME: HOME_DIR } });
  index = new UsageIndex(db, { dirs, now: () => NOW, timeZone: "UTC", backfillDays: 3650 });
});
after(() => {
  setCatalogModels("openrouter", []);
  try { db.close(); } catch { /* closed */ }
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const callsSum = (out) => (1000 * 3 + out * 15) / 1e6;

describe("a cost the provider reported", () => {
  it("stands on its turn even though the turn's calls are priced from the catalog, and is labelled exact", async () => {
    await index.refresh();
    const priced = db.prepare("SELECT SUM(cost_usd) AS usd FROM usage_calls WHERE turn_id = 'tO'").get().usd;
    close(priced, 2 * callsSum(100), "the calls are priced (an estimate)");
    const tO = index.turn("tO");
    close(tO.costUsd, 0.0123, "OpenRouter's own figure");
    assert.equal(tO.costNote, "exact");
    // A later call in the same session: the next read places it in tO and sums tO again.
    fs.appendFileSync(tpath(".claude-home-openrouter", "or-exact"), asst("o3", at("03:07"), 100, MODEL) + "\n");
    await index.refresh();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_calls WHERE turn_id = 'tO'").get().n, 3, "the new call was read and placed in tO");
    close(index.turn("tO").costUsd, 0.0123, "a later read of the calls doesn't put the estimate back");
    assert.equal(index.turn("tO").costNote, "exact");
  });

  it("an estimate stays an estimate: the calls' sum, labelled est.", () => {
    const tE = index.turn("tE");
    close(tE.costUsd, callsSum(200));
    assert.equal(tE.costNote, "est");
  });

  it("a chat, a job and a stretch of time are exact only when every priced turn in them is", () => {
    assert.equal(index.chat("convO").total.costNote, "exact");
    assert.equal(index.chat("convE").total.costNote, "est");
    const jobs = index.jobs({ from: at("00:00"), now: NOW });
    assert.equal(jobs.find((j) => j.conversationId === "convO").costNote, "exact");
    assert.equal(jobs.find((j) => j.conversationId === "convE").costNote, "est");
    assert.equal(index.spendOf(at("02:00"), at("04:00")).costNote, "exact");
    assert.equal(index.spendOf(at("00:00"), at("12:00")).costNote, "est", "mixed: est.");
    const o = index.overview({ now: NOW });
    assert.equal(o.byProvider.find((p) => p.provider === "openrouter").costNote, "est");
    assert.equal(o.byProvider.find((p) => p.provider === "deepseek").costNote, "exact", "every priced row exact");
    assert.equal(o.byModel.find((m) => m.modelId === MODEL).costNote, "est", "mixed: est.");
    assert.equal(o.byModel.find((m) => m.modelId === "deepseek-flash").costNote, "exact", "every priced row exact");
  });
});
