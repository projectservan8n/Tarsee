// Usage and cost on every provider (design 4.13, Phase 4): Claude Code transcripts read from each provider's own
// home and tagged with that provider, Codex turns recorded directly on their turn (recordDirect), costs priced per
// call at its own moment (DeepSeek's peak hours), plans never priced ("Included in plan"), no turn counted twice,
// stored session handles untagged before lookups, Token Health per provider home, the analytics model list across
// providers, and the tool registry the Security tab draws.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-usage-prov-"));
process.env.TARSEE_STATE_DIR = path.join(tmp, "state");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "state", "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "state", "data");
const savedHome = process.env.HOME;
process.env.HOME = path.join(tmp, "home");   // the Claude plan's home is <HOME>/.claude

const { UsageIndex, modelLabel, projectDirsByProvider, recordDirect, __setUsageIndex } = await import("../src/lib/token-usage.js");
const { providerHomes, projectsRoots, transcriptPath, transcriptSizeMB, claudeHomes } = await import("../src/lib/claude-transcript.js");
const { initDb } = await import("../src/db/sqlite.js");
const { buildToolRegistry } = await import("../src/lib/tool-registry.js");
const { default: config } = await import("../src/config/env.js");
const { default: express } = await import("express");
const { priceFor, contextTokensFor } = await import("../src/ai/provider-registry.js");

after(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const STATE = config.STATE_DIR;
const HOME_DIR = path.join(tmp, "home");
const PLAN_HOME = path.join(HOME_DIR, ".claude");
const CWD = "/srv/work";
const SLUG = "-srv-work";
const iso = (ms) => new Date(ms).toISOString();
const close = (a, b, msg) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${msg || ""} expected ${b}, got ${a}`);

/** A transcript's assistant line: one model call. */
const asst = (msgId, at, u, model) => JSON.stringify({
  message: { id: msgId, model, role: "assistant", content: [{ type: "text" }], usage: { input_tokens: u.in ?? 0, cache_read_input_tokens: u.cr ?? 0, cache_creation_input_tokens: u.cw ?? 0, output_tokens: u.out ?? 0 } },
  type: "assistant", uuid: `u-${msgId}`, timestamp: iso(at),
});
const writeTranscript = (home, session, lines, slug = SLUG) => {
  const dir = path.join(home, "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), lines.join("\n") + "\n");
};

describe("each provider's Claude Code home", () => {
  it("lists the plan's home and a home for every key provider that runs on Claude Code, from the state folder", () => {
    const homes = providerHomes({ stateDir: STATE, homeDir: HOME_DIR, env: { HOME: HOME_DIR } });
    const of = (id) => homes.filter((h) => h.provider === id).map((h) => h.home);
    assert.ok(of("claude").includes(PLAN_HOME), "the plan's ~/.claude");
    assert.ok(of("claude").includes(path.join(STATE, ".claude-code-home")), "and its folder on the volume");
    for (const id of ["anthropic", "deepseek", "openrouter"]) assert.deepEqual(of(id), [path.join(STATE, `.claude-home-${id}`)], id);
    for (const id of ["chatgpt", "openai", "local"]) assert.deepEqual(of(id), [], `${id} never runs on Claude Code`);
  });

  it("no longer follows CLAUDE_CONFIG_DIR, which every turn now strips: the plan's roots are its own homes only", () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "somewhere-else");
    try {
      const roots = projectsRoots();
      assert.ok(!roots.some((r) => r.startsWith(path.join(tmp, "somewhere-else"))), roots.join(", "));
      assert.ok(roots.includes(path.join(PLAN_HOME, "projects")));
      assert.ok(!claudeHomes().some((h) => h.includes(".claude-home-")), "a key home never counts as the plan's (its credentials, its model catalog)");
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it("finds a session's transcript in its own provider's home, from a stored handle or a raw id", () => {
    // (Another workspace's folder: the index below reads only /srv/work's.)
    writeTranscript(path.join(STATE, ".claude-home-deepseek"), "ds-find", [asst("x1", Date.now(), { out: 5 }, "deepseek-flash")], "-srv-other");
    writeTranscript(PLAN_HOME, "plan-find", [asst("x2", Date.now(), { out: 5 }, "claude-test-1-2")], "-srv-other");
    const want = path.join(STATE, ".claude-home-deepseek", "projects", "-srv-other", "ds-find.jsonl");
    assert.equal(transcriptPath("deepseek/cc/deepseek:ds-find"), want, "a tagged handle is untagged and looked up in its home");
    assert.equal(transcriptPath("ds-find", { provider: "deepseek" }), want);
    assert.equal(transcriptPath("ds-find", { provider: "claude" }), null, "not in another provider's home");
    assert.equal(transcriptPath("anthropic/cc/anthropic:ds-find"), null);
    assert.equal(transcriptPath("openai/cx/openai:ds-find"), null, "a Codex session has no Claude transcript");
    assert.ok(transcriptPath("plan-find").endsWith("plan-find.jsonl"), "a bare id is the plan's");
    assert.ok(transcriptSizeMB("deepseek/cc/deepseek:ds-find") >= 0);
  });
});

describe("model names from the registry", () => {
  it("names every provider's models as their cards do, Claude's as before", () => {
    assert.equal(modelLabel("claude-test-1-2"), "Test 1.2");
    assert.equal(modelLabel("deepseek-flash", "deepseek"), "DeepSeek Flash");
    assert.equal(modelLabel("deepseek-v4-pro[1m]"), "DeepSeek Pro", "Claude Code's [1m] suffix");
    assert.equal(modelLabel("gpt-6-luna", "openai"), "GPT-6 Luna");
    assert.equal(modelLabel("anthropic/claude-sonnet-4.5", "openrouter"), "Sonnet 4.5", "an OpenRouter slug of a Claude model");
    assert.equal(modelLabel("~anthropic/claude-haiku-latest", "openrouter"), "Haiku (latest)");
    assert.equal(modelLabel("some-local-model", "local"), "some-local-model");
    assert.equal(modelLabel(null), "Unknown");
  });
});

describe("the index across providers", () => {
  // Monday 2026-11-09. DeepSeek's peak hours are 01:00-04:00 and 06:00-10:00 UTC.
  const at = (hhmm) => Date.parse(`2026-11-09T${hhmm}:00Z`);
  const NOW = at("12:00");
  // Expected costs from the registry's own rates (USD per million), so a price update can't break the arithmetic.
  const price = (provider, model, moment, u) => {
    const r = priceFor(provider, model, moment);
    return ((u.in || 0) * r.in + (u.cr || 0) * r.cacheRead + (u.cw || 0) * r.cacheWrite + (u.out || 0) * r.out) / 1e6;
  };
  const DS = { in: 100_000, cr: 1_000_000, out: 20_000 };
  const D1 = price("deepseek", "deepseek-flash", at("02:00"), DS);   // peak
  const D2 = price("deepseek", "deepseek-flash", at("04:30"), DS);   // off-peak
  const CX = price("openai", "gpt-6-luna", at("07:05"), { in: 100_000, cr: 400_000, out: 10_000 });
  const ANTHROPIC = 0.37;
  let db, index;

  before(() => {
    db = initDb(path.join(tmp, "usage.db"));
    const conv = db.prepare("INSERT INTO conversations (id, title, claude_session_id) VALUES (?, ?, ?)");
    conv.run("convP", "Plan chat", "plan-sess");
    conv.run("convD", "DeepSeek chat", "deepseek/cc/deepseek:ds-sess");   // a tagged handle (design 4.10)
    conv.run("convA", "Key chat", null);
    conv.run("convX", "Codex chat", "openai/cx/openai:th1");
    conv.run("convG", "ChatGPT chat", "chatgpt/cxd/chatgpt:th2");
    const ev = db.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
    const turn = (c, t, start, end, startP, endP) => {
      ev.run(c, t, "turn_start", JSON.stringify({ source: "web", prompt: `turn ${t}`, ...startP }), start);
      ev.run(c, t, "turn_end", JSON.stringify({ stopReason: "end_turn", ...endP }), end);
    };
    turn("convD", "tD", at("01:59"), at("04:40"), { provider: "deepseek", engine: "claude-code", model: "deepseek-flash" }, { provider: "deepseek", engine: "claude-code", costUsd: 0.5 });
    turn("convP", "tP", at("04:50"), at("05:10"), { provider: "claude-code", engine: "claude-code", model: "sonnet" }, { costUsd: 1.23 });   // the plan's notional figure
    turn("convA", "tA", at("05:55"), at("06:10"), { provider: "anthropic", engine: "claude-code" }, { costUsd: 0.37, sessionId: "anthropic/cc/anthropic:an-sess" });
    turn("convX", "tX", at("07:00"), at("07:05"), { provider: "openai", engine: "codex", model: "gpt-6-luna" }, { costUsd: null });
    turn("convG", "tG", at("08:00"), at("08:02"), { provider: "chatgpt", engine: "codex" }, {});
    turn("convP", "tP2", at("09:00"), at("09:01"), { provider: "claude" }, { costUsd: 2 });   // a plan turn whose calls were never read

    // DeepSeek on Claude Code: two calls, one in peak hours and one out of them.
    writeTranscript(path.join(STATE, ".claude-home-deepseek"), "ds-sess", [asst("d1", at("02:00"), DS, "deepseek-flash"), asst("d2", at("04:30"), DS, "deepseek-flash")]);
    writeTranscript(PLAN_HOME, "plan-sess", [asst("p1", at("05:00"), { in: 10, cr: 50_000, out: 300 }, "claude-test-1-2")]);
    writeTranscript(path.join(STATE, ".claude-home-anthropic"), "an-sess", [asst("a1", at("06:00"), { in: 50, cr: 9000, out: 700 }, "claude-test-1-2")]);
    const dirs = projectDirsByProvider(CWD, { stateDir: STATE, homeDir: HOME_DIR, env: { HOME: HOME_DIR } });
    index = new UsageIndex(db, { dirs, now: () => NOW, timeZone: "UTC", backfillDays: 3650 });
    __setUsageIndex(index);
  });
  after(() => { try { db.close(); } catch { /* closed */ } });

  it("a Codex turn's usage goes on its own turn at once, priced from the table, even before the next read", () => {
    const r = recordDirect({
      turnId: "tX", conversationId: "convX", threadId: "th1", provider: "openai", engine: "codex", model: "gpt-6-luna", effort: "medium",
      startedAt: at("07:00"), endedAt: at("07:05"), usage: { input_tokens: 100_000, cache_read_input_tokens: 400_000, output_tokens: 10_000 },
    }, db);
    assert.equal(r.recorded, true);
    assert.equal(r.id, "codex:th1:tX");
    assert.ok(CX > 0);
    close(r.costUsd, CX);
    const t = index.turn("tX");
    assert.equal(t.calls, 1);
    assert.equal(t.output, 10_000);
    assert.equal(t.cacheRead, 400_000);
    assert.equal(t.provider, "openai");
    assert.equal(t.engine, "codex");
    assert.equal(t.model, "GPT-6 Luna");
    assert.equal(t.costNote, "est");
    close(t.costUsd, CX);
    assert.equal(t.outTps, null, "a Codex turn's time includes its tools: no made-up speed");
  });

  it("recording the same Codex turn again replaces it rather than adding it twice", () => {
    recordDirect({ turnId: "tX", conversationId: "convX", threadId: "th1", provider: "openai", engine: "codex", model: "gpt-6-luna", endedAt: at("07:05"),
      input: 100_000, cacheRead: 400_000, output: 10_000 }, db);
    assert.equal(index.turn("tX").calls, 1);
    assert.equal(index.turn("tX").output, 10_000);
  });

  it("a plan's turn records its tokens and never a cost, whatever the engine reported", () => {
    const r = recordDirect({ turnId: "tG", conversationId: "convG", threadId: "th2", provider: "chatgpt", engine: "codex", endedAt: at("08:02"),
      usage: { input_tokens: 5000, output_tokens: 600 }, costUsd: 0.2 }, db);
    assert.equal(r.recorded, true);
    assert.equal(r.costUsd, null);
    const t = index.turn("tG");
    assert.equal(t.output, 600);
    assert.equal(t.costUsd, null);
    assert.equal(t.costNote, "plan");
  });

  it("a background job's Codex turn stays in its own live conversation, whatever chat its tools were working for", () => {
    const ev = db.prepare("INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
    const OCT = (hhmm) => Date.parse(`2026-10-01T${hhmm}:00Z`);   // (last month: outside this week's totals below)
    ev.run("cron:daily", "tC", "turn_start", JSON.stringify({ source: "cron", provider: "openai", engine: "codex", model: "gpt-6-luna" }), OCT("10:30"));
    const r = recordDirect({ turnId: "tC", conversationId: "convX", provider: "openai", engine: "codex", model: "gpt-6-luna", sessionId: "th9", endedAt: OCT("10:31"), output: 50, input: 10 }, db);
    assert.equal(r.recorded, true);
    assert.equal(db.prepare("SELECT conversation_id AS c FROM usage_calls WHERE turn_id = 'tC'").get().c, "cron:daily");
    assert.equal(index.turn("tC").output, 50);
    const missing = recordDirect({ turnId: "tC", provider: "openai", engine: "codex", model: "gpt-6-luna", sessionId: "th9", endedAt: OCT("10:31"), output: 60 }, db);
    assert.equal(missing.recorded, true, "a known turn needs no conversation id");
    assert.equal(index.turn("tC").output, 60);
    assert.equal(recordDirect({ turnId: "nope", provider: "openai", engine: "codex", output: 5 }, db).reason, "turn", "an unknown turn without a conversation is refused");
  });

  it("a Claude Code turn is never recorded directly: its transcript is the record, so nothing counts twice", () => {
    for (const engine of ["claude-code", undefined]) {
      const r = recordDirect({ turnId: "tD", conversationId: "convD", provider: "deepseek", engine, model: "deepseek-flash", endedAt: at("04:40"), usage: { input_tokens: 9, output_tokens: 9 } }, db);
      assert.equal(r.recorded, false, String(engine));
      assert.equal(r.reason, "transcript");
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_calls WHERE turn_id = 'tD'").get().n, 0);
  });

  it("reads each home's transcripts as that provider's, prices each call at its own moment, and untags stored handles", async () => {
    await index.refresh();
    const calls = Object.fromEntries(db.prepare("SELECT id, provider, engine, cost_usd, turn_id FROM usage_calls").all().map((c) => [c.id, c]));
    assert.equal(calls.d1.provider, "deepseek");
    assert.equal(calls.d1.engine, "claude-code");
    close(calls.d1.cost_usd, D1, "02:00 is peak");
    close(calls.d2.cost_usd, D2, "04:30 is off-peak");
    close(D2, D1 / 2, "off-peak is half the peak rate");
    assert.equal(calls.d1.turn_id, "tD", "found through the conversation's tagged handle");
    assert.equal(calls.p1.provider, "claude");
    assert.equal(calls.p1.cost_usd, null);
    assert.equal(calls.a1.provider, "anthropic");
    assert.equal(calls.a1.cost_usd, null, "an Anthropic key's cost is the engine's exact figure, on the turn");
    assert.equal(calls.a1.turn_id, "tA", "found through the session its turn_end named, untagged");
    assert.equal(calls["codex:th1:tX"].turn_id, "tX", "the Codex row stays on its turn");
  });

  it("turns: a gateway's cost is its calls' sum, an Anthropic key's is the engine's exact figure, a plan's is none", () => {
    const tD = index.turn("tD");
    assert.equal(tD.provider, "deepseek");
    assert.equal(tD.model, "DeepSeek Flash");
    assert.equal(tD.calls, 2);
    close(tD.costUsd, D1 + D2);
    assert.equal(tD.costNote, "est");
    const tA = index.turn("tA");
    close(tA.costUsd, ANTHROPIC);
    assert.equal(tA.costNote, "exact");
    const tP = index.turn("tP");
    assert.equal(tP.provider, "claude", "claude-code is the plan's alias");
    assert.equal(tP.costUsd, null);
    assert.equal(tP.costNote, "plan");
    assert.equal(tP.calls, 1);
    assert.equal(db.prepare("SELECT cost_usd FROM usage_turns WHERE turn_id = 'tP2'").get().cost_usd, null, "not even stored for a plan");
  });

  it("the overview adds cost by provider and by day, labels each provider, and a provider filter narrows everything", () => {
    const o = index.overview({ now: NOW });
    const byP = Object.fromEntries(o.byProvider.map((p) => [p.provider, p]));
    assert.equal(byP.deepseek.label, "DeepSeek");
    close(byP.deepseek.costUsd, D1 + D2);
    assert.equal(byP.deepseek.costNote, "est");
    close(byP.openai.costUsd, CX);
    close(byP.anthropic.costUsd, ANTHROPIC);
    assert.equal(byP.anthropic.costNote, "exact");
    assert.equal(byP.claude.label, "Claude plan");
    assert.equal(byP.claude.costUsd, null);
    assert.equal(byP.claude.costNote, "plan");
    assert.equal(byP.chatgpt.costNote, "plan");
    const ALL = D1 + D2 + CX + ANTHROPIC;
    close(o.today.costUsd, ALL);
    assert.equal(o.today.costNote, "est");
    close(o.week.costUsd, ALL);
    close(o.days.reduce((a, d) => a + (d.costUsd || 0), 0), ALL, "each day's spend adds up to the week");
    const flash = o.byModel.find((m) => m.model === "DeepSeek Flash");
    assert.equal(flash.provider, "deepseek");
    assert.equal(flash.providerLabel, "DeepSeek");
    close(flash.costUsd, D1 + D2);
    const chatgpt = o.byModel.find((m) => m.provider === "chatgpt");
    assert.equal(chatgpt.model, "Default model", "the plan's turn named no model: Codex ran its own default");
    assert.equal(chatgpt.costNote, "plan");
    assert.deepEqual(o.providers.map((p) => p.id).sort(), ["anthropic", "chatgpt", "claude", "deepseek", "openai"]);

    const only = index.overview({ now: NOW, provider: "deepseek" });
    assert.equal(only.provider, "deepseek");
    assert.equal(only.week.output, 40_000);
    assert.deepEqual(only.byProvider.map((p) => p.provider), ["deepseek"]);
    close(only.week.costUsd, D1 + D2);
    assert.deepEqual(only.providers.map((p) => p.id).sort(), ["anthropic", "chatgpt", "claude", "deepseek", "openai"], "the filter's choices stay");
    const plan = index.overview({ now: NOW, provider: "claude-code" });
    assert.equal(plan.provider, "claude");
    assert.equal(plan.week.costUsd, null);
    assert.equal(plan.week.costNote, "plan");
  });

  it("jobs carry their providers and cost; a provider filter keeps that provider's turns", () => {
    const jobs = index.jobs({ from: at("00:00"), now: NOW });
    const d = jobs.find((j) => j.conversationId === "convD");
    assert.deepEqual(d.providers, ["deepseek"]);
    close(d.costUsd, D1 + D2);
    assert.equal(d.costNote, "est");
    const p = jobs.find((j) => j.conversationId === "convP");
    assert.equal(p.costUsd, null);
    assert.equal(p.costNote, "plan");
    assert.deepEqual(index.jobs({ from: at("00:00"), now: NOW, provider: "openai" }).map((j) => j.conversationId), ["convX"]);
  });

  it("the usage API passes the provider filter through", async () => {
    const { analyticsRouter } = await import("../src/routes/analytics.js");
    const app = express();
    app.set("db", db);
    app.use("/api/analytics", analyticsRouter);
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/analytics`;
      const o = await (await fetch(`${base}/usage?provider=deepseek`)).json();
      assert.equal(o.provider, "deepseek");
      assert.deepEqual(o.byProvider.map((p) => p.provider), ["deepseek"]);
      const j = await (await fetch(`${base}/usage/jobs?days=60&provider=openai`)).json();
      assert.ok(j.jobs.length >= 1);
      assert.ok(j.jobs.every((x) => x.providers.includes("openai")));
      // The dashboard's model list is every provider's now, not only names starting with "claude".
      const m = db.prepare("INSERT INTO messages (id, conversation_id, role, content, provider, model, tokens_in, tokens_out) VALUES (?, ?, 'assistant', 'x', ?, ?, 10, 5)");
      m.run("m1", "convD", "deepseek", "deepseek-flash");
      m.run("m2", "convP", "claude-code", "claude-test-1-2");
      const a = await (await fetch(base)).json();
      const ds = a.models.find((r) => r.model === "deepseek-flash");
      assert.ok(ds, JSON.stringify(a.models));
      assert.equal(ds.provider, "deepseek");
      assert.equal(ds.label, "DeepSeek Flash");
      assert.equal(a.models.find((r) => r.model === "claude-test-1-2").provider, "claude");
    } finally { server.close(); }
  });
});

describe("Token Health per provider", () => {
  let server, base, db;
  before(async () => {
    db = initDb(path.join(tmp, "health.db"));
    const conv = db.prepare("INSERT INTO conversations (id, title, model, claude_session_id) VALUES (?, ?, ?, ?)");
    conv.run("h-ds", "DeepSeek chat", "deepseek-flash", "deepseek/cc/deepseek:health-ds");
    conv.run("h-plan", "Plan chat", null, "health-plan");
    conv.run("h-codex", "Codex chat", "gpt-6-luna", "openai/cx/openai:thread-9");
    writeTranscript(path.join(STATE, ".claude-home-deepseek"), "health-ds", ["x".repeat(300_000)], "-srv-other");
    writeTranscript(PLAN_HOME, "health-plan", ["y".repeat(100_000)], "-srv-other");
    const { adminRouter } = await import("../src/routes/admin.js");
    const app = express();
    app.set("db", db);
    app.use("/api/admin", adminRouter);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api/admin`;
  });
  after(() => { server?.close(); try { db.close(); } catch { /* closed */ } });

  it("finds each chat's transcript in its own provider's home from its tagged handle, and says which provider it is", async () => {
    const { conversations } = await (await fetch(`${base}/context-health`)).json();
    const by = Object.fromEntries(conversations.map((c) => [c.id, c]));
    assert.equal(by["h-ds"].provider, "deepseek");
    assert.equal(by["h-ds"].providerLabel, "DeepSeek");
    assert.equal(by["h-ds"].engine, "claude-code");
    assert.equal(by["h-ds"].transcriptMB, 0.3);
    assert.equal(by["h-plan"].provider, "claude");
    assert.equal(by["h-plan"].transcriptMB, 0.1);
    assert.equal(by["h-codex"].provider, "openai");
    assert.equal(by["h-codex"].engine, "codex");
    assert.equal(by["h-codex"].transcriptMB, null, "Codex keeps no Claude transcript");
    assert.equal(by["h-codex"].willResetNextTurn, false);
    assert.equal(by["h-codex"].contextWindow, contextTokensFor("openai", "gpt-6-luna"), "the model's own window from the registry");
  });

  it("filters by provider", async () => {
    const { conversations } = await (await fetch(`${base}/context-health?provider=deepseek`)).json();
    assert.deepEqual(conversations.map((c) => c.id), ["h-ds"]);
  });
});

describe("the tool registry (Settings > Security)", () => {
  it("lists every Tarsee tool once by its Tool Permissions name, with the name the agent calls it by", () => {
    const toolDefs = [
      { name: "pdf_read", description: "Extract text from a PDF file. Returns the text." },
      { name: "exec", description: "Run a shell command." },
      { name: "send_message", description: "Send a message." },
    ];
    const mcpTools = [
      { name: "tarsee_send_message", description: "Send a message to a channel. Use this to notify the user." },
      { name: "tarsee_push_notification", description: "Send a Web Push notification to all the user's registered devices." },
      { name: "tarsee_pdf_read", description: "Read a PDF's text, a page range at a time." },
      { name: "tarsee_brand_new", description: "Something added later." },
    ];
    const list = buildToolRegistry({ toolDefs, mcpTools });
    const by = Object.fromEntries(list.map((t) => [t.name, t]));
    assert.equal(list.filter((t) => t.name === "send_message").length, 1, "once, though both lists have it");
    assert.equal(by.send_message.mcpName, "tarsee_send_message");
    assert.equal(by.push_notification.mcpName, "tarsee_push_notification");
    assert.equal(by.push_notification.policyCovered, true);
    assert.equal(by.pdf_read.mcpName, "tarsee_pdf_read");
    assert.equal(by.pdf_read.description, "Read a PDF's text, a page range at a time.", "the agent's own description wins");
    assert.equal(by.exec.mcpName, null);
    assert.equal(by.brand_new.group, "Other");
    assert.equal(by.brand_new.label, "Brand new");
    for (const t of list) {
      for (const k of ["name", "label", "description", "group"]) assert.equal(typeof t[k], "string", `${t.name}.${k}`);
      assert.equal(typeof t.policyCovered, "boolean");
    }
    // The engines' own tools are listed honestly: Tool Permissions can't limit them.
    for (const name of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"]) {
      assert.equal(by[name]?.policyCovered, false, name);
      assert.equal(by[name].group, "Built into the AI");
    }
  });

  it("GET /api/admin/tool-registry: the owner's signed-in session only; the live list has push_notification and the vault tools", async () => {
    const { adminRouter } = await import("../src/routes/admin.js");
    const app = express();
    app.use((req, _res, next) => {
      const how = req.headers["x-test-auth"];
      req.auth = how === "session" ? { authenticated: true, method: "session" } : how === "bearer" ? { authenticated: true, method: "bearer" } : { authenticated: false };
      next();
    });
    app.use("/api/admin", adminRouter);
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/admin/tool-registry`;
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { "x-test-auth": "bearer" } })).status, 403, "an API token is not the owner's session");
      const res = await fetch(url, { headers: { "x-test-auth": "session" } });
      assert.equal(res.status, 200);
      const list = await res.json();
      assert.ok(Array.isArray(list));
      const by = Object.fromEntries(list.map((t) => [t.name, t]));
      assert.equal(by.push_notification?.mcpName, "tarsee_push_notification");
      assert.equal(by.push_notification.policyCovered, true);
      assert.ok(by.pdf_read, "pdf_read (tarsee_pdf_read to the agent)");
      for (const name of ["get_key", "set_key", "list_keys", "delete_key", "send_file", "railway", "discord_admin"]) assert.ok(by[name], name);
      assert.equal(by.Bash.policyCovered, false);
      assert.equal(typeof by.exec.mode, "string", "the current Tool Permissions setting rides along");
    } finally { server.close(); }
  });
});
