// The turn layer's money rules (src/ai/turn.js, design 4.6 h and 4.13), on scripted engines (test/fakes/fake-engine.js):
//  - the per-turn spend ceiling stops only work still in progress: a cost that arrives with a finished reply (Codex's
//    usage at turn.completed, a Claude Code result's cost) never turns that reply into a failure; the turn is marked
//    over budget and says so instead;
//  - an Anthropic key's exact cost is recorded for a turn with no live conversation (a subagent, ACP, a Verify probe),
//    so the monthly cap sees it.
// Every key here is an obvious fake.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-turn-spend-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const live = await import("../src/lib/live-bus.js");
const { runTurn, registerEngine, configureTurns } = await import("../src/ai/turn.js");
const { runBackgroundTurn } = await import("../src/lib/background-turn.js");
const { spendBetween } = await import("../src/ai/spend.js");
const { usageIndex } = await import("../src/lib/token-usage.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
const settings = new SettingsStore(db);
usageIndex(db);

const OPENAI_KEY = "sk-proj-testcanaryopenai00000000000";
const DEEPSEEK_KEY = "sk-testcanarydeepseek0000000000";
const ANTHROPIC_KEY = "sk-ant-api03-test-canary-spend-0000000000";
const OPENROUTER_KEY = "sk-or-v1-testcanaryopenrouter0000";

async function collect(gen) {
  const out = [];
  for await (const evt of gen) out.push(evt);
  return out;
}
const user = (content) => ({ role: "user", content });
const bg = () => ({ db, settingsStore: settings, conversationId: null });
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
const SMALL = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

let restore = null;
const engines = {};
function useEngines({ claude = [[{ type: "text", content: "Done." }, { type: "done", stopReason: "end_turn" }]], codex = claude } = {}) {
  engines.claude = createFakeEngine(claude);
  engines.codex = createFakeEngine(codex);
  registerEngine("claude-code", engines.claude);
  registerEngine("codex", engines.codex);
}

beforeEach(() => {
  for (const prefix of ["ai.", "session."]) for (const { key } of settings.getByPrefix(prefix)) settings.delete(key);
  db.prepare("DELETE FROM usage_turns").run();
  restore?.();
  restore = configureTurns({
    grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "test-mcp-token", revoke() {} }),
    recordUsage: () => {},
  });
  useEngines();
});

after(() => {
  restore?.();
  registerEngine("claude-code", null);
  registerEngine("codex", null);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the spend ceiling never fails a turn that had already finished", () => {
  // Codex reports usage once, at turn.completed: a usage event, its usage step, then done.
  const finishedCodexTurn = (signals) => (opts) => {
    signals.push(opts.signal);
    return [
      { type: "text", content: "Report sent." },
      { type: "usage", usage: { input_tokens: 6_000_000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { type: "step", kind: "usage", input: 6_000_000, cacheRead: 0, cacheWrite: 0, output: 1000, total: 6_001_000 },
      { type: "done", stopReason: "end_turn" },
    ];
  };

  it("a Codex turn whose cost (known only at its end) is over the ceiling ends end_turn, unstopped, marked over budget", async () => {
    settings.set("ai.openai.apiKey", OPENAI_KEY);
    const signals = [];
    useEngines({ codex: [finishedCodexTurn(signals)] });
    const liveId = "cron:spend-codex";
    const events = await collect(runTurn({ provider: "openai", model: "gpt-6-luna", background: true, messages: [user("send the report")], toolCtx: bg(), liveConversationId: liveId }));
    assert.equal(events.filter((e) => e.type === "error").length, 0, JSON.stringify(events.filter((e) => e.type === "error")));
    assert.deepEqual(events.filter((e) => e.type === "done"), [{ type: "done", stopReason: "end_turn" }]);
    assert.equal(signals[0].aborted, false, "codex was left to finish writing its thread");
    const timeline = live.eventsSince(liveId, 0);
    const end = timeline.find((e) => e.type === "turn_end");
    assert.equal(end.payload.stopReason, "end_turn");
    assert.equal(end.payload.overBudget, true);
    const warning = timeline.find((e) => e.type === "step" && e.payload.kind === "status");
    assert.match(warning?.payload.text || "", /went over its spending limit of \$0\.50/);
    assert.match(warning.payload.text, /had already finished/);
  });

  it("a cron's finished Codex job keeps its reply: no error, so it isn't run again", async () => {
    settings.set("ai.openai.apiKey", OPENAI_KEY);
    settings.set("ai.activeProvider", "openai");
    const signals = [];
    useEngines({ codex: [finishedCodexTurn(signals)] });
    const r = await runBackgroundTurn({ label: "cron:report", model: "openai:gpt-6-luna", messages: [user("send the report")], systemPrompt: "", toolCtx: bg() });
    assert.equal(r.error, null);
    assert.equal(r.text, "Report sent.");
    assert.equal(r.stopReason, "end_turn");
    assert.equal(engines.codex.calls.length, 1);
  });

  it("a Claude Code gateway turn whose final cost is the first figure over the ceiling ends end_turn too", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [[{ type: "text", content: "All done." }, { type: "usage", usage: SMALL, costUsd: 1 }, { type: "done", stopReason: "end_turn" }]] });
    const events = await collect(runTurn({ provider: "deepseek", messages: [user("go")], toolCtx: bg(), maxBudgetUsd: 0.5 }));
    assert.equal(events.filter((e) => e.type === "error").length, 0);
    assert.equal(events.at(-1).stopReason, "end_turn");
    assert.equal(engines.claude.calls[0].signal.aborted, false);
  });

  it("work still in progress is still stopped: a Claude Code gateway's running total over the ceiling", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [[{ type: "text", content: "Working" }, { type: "step", kind: "usage", input: 0, cacheRead: 0, cacheWrite: 0, output: 9_000_000, total: 9_000_000 }, { type: "wait" }]] });
    const events = await collect(runTurn({ provider: "deepseek", messages: [user("go")], toolCtx: bg(), maxBudgetUsd: 0.5 }));
    assert.equal(events.at(-1).stopReason, "error_max_budget_usd");
    assert.equal(engines.claude.calls[0].signal.aborted, true);
  });
});

describe("an Anthropic key's exact cost off the live timeline", () => {
  const exactTurn = (usd) => [[{ type: "text", content: "Done." }, { type: "usage", usage: SMALL, costUsd: usd, costExact: true }, { type: "done", stopReason: "end_turn" }]];

  it("a turn with no live conversation (a subagent, ACP) records it, so this month's spend and the cap count it", async () => {
    settings.set("ai.anthropic.apiKey", ANTHROPIC_KEY);
    useEngines({ claude: exactTurn(1.5) });
    const events = await collect(runTurn({ provider: "anthropic", messages: [user("research this")], toolCtx: bg(), liveDisabled: true, liveSource: "agent" }));
    assert.equal(events.at(-1).stopReason, "end_turn");
    assert.ok(await until(() => spendBetween(db, 0).byProvider.anthropic === 1.5), JSON.stringify(spendBetween(db, 0)));
    const row = db.prepare("SELECT conversation_id AS conv, provider, engine, cost_exact AS exact FROM usage_turns WHERE provider = 'anthropic'").get();
    assert.match(row.conv, /^agent:/);
    assert.equal(row.engine, "claude-code");
    assert.equal(row.exact, 1);
    // With a $1 cap the next metered turn is refused.
    settings.set("ai.spendCap.monthlyUsd", "1");
    const refused = await collect(runTurn({ provider: "anthropic", messages: [user("more")], toolCtx: bg(), liveDisabled: true }));
    assert.equal(refused.at(-1).stopReason, "spend-cap");
  });

  it("a Verify probe's is filed under verify:, and an ACP session's (no conversation at all) under turn:", async () => {
    settings.set("ai.anthropic.apiKey", ANTHROPIC_KEY);
    useEngines({ claude: exactTurn(0.25) });
    await collect(runTurn({ provider: "anthropic", messages: [user("say ok")], toolCtx: bg(), liveDisabled: true, verify: true, engine: "claude-code" }));
    await collect(runTurn({ provider: "anthropic", messages: [user("hello")], toolCtx: { db, settingsStore: settings } }));
    assert.ok(await until(() => db.prepare("SELECT COUNT(*) AS n FROM usage_turns").get().n === 2));
    const convs = db.prepare("SELECT conversation_id AS conv FROM usage_turns ORDER BY conversation_id").all().map((r) => r.conv.split(":")[0]);
    assert.deepEqual(convs, ["turn", "verify"]);
    assert.equal(spendBetween(db, 0).byProvider.anthropic, 0.5);
  });

  it("only there: a turn on the live timeline is counted from its turn_end, an estimate or OpenRouter's figure never here", async () => {
    const rows = [];
    restore();
    restore = configureTurns({
      grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "t", revoke() {} }),
      recordUsage: () => {},
      recordReported: (row) => { rows.push(row); },
    });
    settings.set("ai.anthropic.apiKey", ANTHROPIC_KEY);
    settings.set("ai.openrouter.apiKey", OPENROUTER_KEY);
    useEngines({ claude: exactTurn(0.4) });
    const liveId = "agent:on-the-timeline";
    await collect(runTurn({ provider: "anthropic", messages: [user("hi")], toolCtx: bg(), liveConversationId: liveId }));
    const end = live.eventsSince(liveId, 0).find((e) => e.type === "turn_end");
    assert.equal(end.payload.costUsd, 0.4);
    assert.equal(end.payload.costExact, true);
    await collect(runTurn({ provider: "openrouter", messages: [user("hi")], toolCtx: bg(), liveDisabled: true }));
    assert.equal(rows.length, 0, "OpenRouter's calls are priced in its transcript already; the timeline's turn has its turn_end");
    useEngines({ claude: [[{ type: "text", content: "Done." }, { type: "usage", usage: SMALL, costUsd: 0.2 }, { type: "done", stopReason: "end_turn" }]] });
    await collect(runTurn({ provider: "anthropic", messages: [user("hi")], toolCtx: bg(), liveDisabled: true }));
    assert.equal(rows.length, 0, "a figure the engine didn't call exact is never recorded as exact");
    useEngines({ claude: exactTurn(0.3) });
    await collect(runTurn({ provider: "anthropic", messages: [user("hi")], toolCtx: bg(), liveDisabled: true, liveSource: "acp" }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].costUsd, 0.3);
    assert.equal(rows[0].provider, "anthropic");
    assert.equal(rows[0].engine, "claude-code");
    assert.match(rows[0].conversationId, /^acp:/);
    assert.ok(rows[0].turnId && rows[0].startedAt <= rows[0].endedAt);
  });
});
