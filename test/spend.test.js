// Spend (src/ai/spend.js), design 4.13 and 4.6h: what a turn's tokens cost on each provider, the per-turn dollar
// ceiling that keeps today's $0.50 background limit on every metered provider, and the optional monthly cap
// (ai.spendCap.monthlyUsd, off when empty) that refuses metered turns only. Plans are never priced: "Included in plan".
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-spend-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const spend = await import("../src/ai/spend.js");
const { priceUsage, checkTurnBudget, monthlySpend, withinMonthlyCap, monthlyCapStatus, isMetered, costSource, monthStart, BACKGROUND_BUDGET_USD } = spend;
const { initDb } = await import("../src/db/sqlite.js");
const { BACKGROUND_DEFAULTS } = await import("../src/config/constants.js");
const { priceFor } = await import("../src/ai/provider-registry.js");

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A settings store as the turn layer has one: get(key) only. */
const storeOf = (o = {}) => ({ get: (k) => (Object.hasOwn(o, k) ? o[k] : null) });
const MILLION = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ""} expected ${b}, got ${a}`);

describe("pricing a turn's tokens", () => {
  it("DeepSeek: the listed rate in peak hours, half of it outside them, minute-exact at every boundary (UTC, Monday to Friday)", () => {
    // 2026-11-09 is a Monday. Peak hours are 01:00-04:00 and 06:00-10:00 UTC.
    const at = (hhmm, day = "2026-11-09") => `${day}T${hhmm}:00Z`;
    const rate = priceFor("deepseek", "deepseek-flash", at("02:00"));
    assert.equal(rate.peak, true);
    const peak = rate.in + rate.out;   // DeepSeek Flash, a million in and a million out, at the listed (peak) rate
    const cases = [
      ["00:59", peak / 2], ["01:00", peak], ["03:59", peak], ["04:00", peak / 2],
      ["05:59", peak / 2], ["06:00", peak], ["09:59", peak], ["10:00", peak / 2], ["23:30", peak / 2],
    ];
    for (const [hhmm, want] of cases) close(priceUsage("deepseek", "deepseek-flash", MILLION, at(hhmm)), want, hhmm);
    close(priceUsage("deepseek", "deepseek-flash", MILLION, at("02:00", "2026-11-14")), peak / 2, "a Saturday is never peak");
    close(priceUsage("deepseek", "deepseek-flash[1m]", MILLION, Date.parse(at("02:00"))), peak, "Claude Code's [1m] suffix and a ms timestamp");
  });

  it("every kind of token at its own rate: input, output, cache reads and cache writes", () => {
    const usage = { input_tokens: 200_000, output_tokens: 50_000, cache_read_input_tokens: 4_000_000, cache_creation_input_tokens: 100_000 };
    const r = priceFor("openai", "gpt-6-luna", "2026-11-09T12:00:00Z");   // the registry's rates, USD per million
    const want = (200_000 * r.in + 50_000 * r.out + 4_000_000 * r.cacheRead + 100_000 * r.cacheWrite) / 1e6;
    assert.ok(want > 0);
    close(priceUsage("openai", "gpt-6-luna", usage, "2026-11-09T12:00:00Z"), want);
    // The same counts under Tarsee's own names (lib/token-usage.js rows) price the same.
    close(priceUsage("openai", "gpt-6-luna", { input: 200_000, output: 50_000, cacheRead: 4_000_000, cacheWrite: 100_000 }, "2026-11-09T12:00:00Z"), want);
  });

  it("plans are never priced (Included in plan); an Anthropic key's exact cost comes from the engine, not a table", () => {
    for (const id of ["claude", "claude-code", "chatgpt"]) {
      assert.equal(priceUsage(id, "sonnet", MILLION, "2026-11-09T02:00:00Z"), null, id);
      assert.equal(costSource(id), "plan", id);
      assert.equal(isMetered(id), false, id);
    }
    assert.equal(priceUsage("anthropic", "claude-sonnet-4-5", MILLION), null);
    assert.equal(costSource("anthropic"), "exact");
    assert.equal(isMetered("anthropic"), true);
    assert.equal(priceUsage("nobody", "x", MILLION), null, "an unknown provider");
    assert.equal(priceUsage("deepseek", "deepseek-nonexistent", MILLION), null, "a model with no known price");
  });

  it("OpenRouter's own reported cost wins over the catalog price", () => {
    assert.equal(priceUsage("openrouter", "deepseek/deepseek-chat", { ...MILLION, cost: 0.0421 }), 0.0421);
    assert.equal(priceUsage("deepseek", "deepseek-flash", { ...MILLION, costUsd: 0.5 }), 0.5);
    assert.equal(priceUsage("chatgpt", "gpt-6-luna", { ...MILLION, cost: 3 }), null, "a plan stays unpriced even when a cost is reported");
  });

  it("Local AI is free unless its card sets a price", () => {
    assert.equal(priceUsage("local", "llama-local", MILLION), 0);
    assert.equal(costSource("local"), "free");
    assert.equal(isMetered("local"), false);
    const store = storeOf({ "ai.local.price": JSON.stringify({ in: 0.1, out: 0.2 }) });
    close(priceUsage("local", "llama-local", MILLION, null, store), 0.3);
    assert.equal(costSource("local", store), "estimate");
    assert.equal(isMetered("local", store), true);
    assert.equal(costSource("deepseek"), "estimate");
    assert.equal(costSource("openrouter"), "estimate");
  });
});

describe("the per-turn ceiling (design 4.6h)", () => {
  // DeepSeek Flash at peak, sized from the registry's rates: $0.45 and $0.60 of tokens.
  const flash = priceFor("deepseek", "deepseek-flash", "2026-11-09T02:00:00Z");
  const pair = (usd) => { const n = Math.round((usd * 1e6) / (flash.in + flash.out)); return { input_tokens: n, output_tokens: n }; };
  const heavy = pair(0.45);
  const heavier = pair(0.6);

  it("keeps today's $0.50 background ceiling on every metered provider", () => {
    assert.equal(BACKGROUND_BUDGET_USD, BACKGROUND_DEFAULTS.MAX_BUDGET_USD);
    const under = checkTurnBudget({ providerId: "deepseek", model: "deepseek-flash", usage: heavy, background: true, at: "2026-11-09T02:00:00Z" });
    assert.equal(under.tripped, false);
    assert.equal(under.limitUsd, 0.5);
    assert.ok(Math.abs(under.spentUsd - 0.45) < 1e-6, String(under.spentUsd));
    const over = checkTurnBudget({ providerId: "deepseek", model: "deepseek-flash", usage: heavier, background: true, at: "2026-11-09T02:00:00Z" });
    assert.equal(over.tripped, true);
    assert.equal(over.over, true, "the name the turn layer reads");
    assert.equal(under.over, false);
    assert.equal(over.subtype, "error_max_budget_usd");
    assert.equal(over.estimated, true);
    assert.match(over.message, /\$0\.50/);
    assert.match(over.message, /\$0\.60/);
  });

  it("an explicit ceiling wins; an interactive turn with none never trips", () => {
    assert.equal(checkTurnBudget({ providerId: "deepseek", model: "deepseek-flash", usage: heavy, maxBudgetUsd: 0.25, at: "2026-11-09T02:00:00Z" }).tripped, true);
    const free = checkTurnBudget({ providerId: "deepseek", model: "deepseek-flash", usage: heavier, at: "2026-11-09T02:00:00Z" });
    assert.equal(free.tripped, false);
    assert.equal(free.limitUsd, null);
  });

  it("a reported cost (OpenRouter's usage.cost, or the turn's own sum) counts as it is", () => {
    const r = checkTurnBudget({ providerId: "openrouter", model: "deepseek/deepseek-chat", costUsd: 0.61, background: true });
    assert.equal(r.tripped, true);
    assert.equal(r.estimated, false);
    assert.equal(checkTurnBudget({ providerId: "openai", model: "gpt-6-luna", spentUsd: 0.2, background: true }).tripped, false);
  });

  it("plans never trip it, and the Anthropic key's ceiling is enforced by the engine itself", () => {
    const plan = checkTurnBudget({ providerId: "claude", model: "sonnet", costUsd: 9, background: true });
    assert.equal(plan.metered, false);
    assert.equal(plan.tripped, false);
    assert.equal(checkTurnBudget({ providerId: "chatgpt", model: "x", usage: heavier, background: true }).tripped, false);
    const key = checkTurnBudget({ providerId: "anthropic", model: "sonnet", costUsd: 2, background: true });
    assert.equal(key.tripped, false);
    assert.equal(key.enforcedBy, "engine");
  });
});

describe("this month's spend and the optional monthly cap", () => {
  const db = initDb(path.join(tmp, "spend.db"));
  const NOW = Date.parse("2026-11-09T12:00:00Z");
  const TZ = "Asia/Manila";   // UTC+8: November begins at 2026-10-31T16:00Z
  const turn = db.prepare(`INSERT INTO usage_turns (turn_id, conversation_id, started_at, ended_at, provider, engine, cost_usd)
    VALUES (?, 'c1', ?, ?, ?, ?, ?)`);
  const call = db.prepare(`INSERT INTO usage_calls (id, session_id, model, started_at, ended_at, output, turn_id, placed, provider, engine, cost_usd)
    VALUES (?, 's', 'm', NULL, ?, 1, ?, 1, ?, 'claude-code', ?)`);
  const ms = (iso) => Date.parse(iso);
  turn.run("A", ms("2026-11-02T00:00:00Z"), ms("2026-11-02T00:05:00Z"), "deepseek", "claude-code", 0.4);
  call.run("A-call", ms("2026-11-02T00:04:00Z"), "A", "deepseek", 0.4);                               // in turn A: not counted again
  turn.run("B", ms("2026-10-31T16:55:00Z"), ms("2026-10-31T17:00:00Z"), "openai", "codex", 0.25);    // Nov 1, 01:00 in Manila
  turn.run("C", ms("2026-10-31T14:00:00Z"), ms("2026-10-31T15:00:00Z"), "deepseek", "claude-code", 5); // still October in Manila
  turn.run("D", ms("2026-11-03T00:00:00Z"), ms("2026-11-03T00:01:00Z"), null, null, null);           // the Claude plan (an old row)
  call.run("orphan", ms("2026-11-03T00:00:00Z"), null, "openrouter", 0.1);                            // in no turn: counted itself
  after(() => { try { db.close(); } catch { /* closed */ } });

  it("adds up the calendar month in the owner's timezone, each turn once and calls in no turn once", () => {
    assert.equal(monthStart(NOW, TZ), ms("2026-10-31T16:00:00Z"));
    const m = monthlySpend(db, { now: NOW, timeZone: TZ });
    close(m.totalUsd, 0.75);
    close(m.byProvider.deepseek, 0.4);
    close(m.byProvider.openai, 0.25);
    close(m.byProvider.openrouter, 0.1);
    assert.equal(m.byProvider.claude, undefined, "the plan costs nothing here");
    close(monthlySpend({ db, now: NOW, timeZone: "UTC" }).totalUsd, 0.75 - 0.25 + 0, "in UTC turn B was still October");
  });

  it("is off when empty, and once reached it refuses metered turns only", () => {
    assert.equal(withinMonthlyCap("deepseek", { db, store: storeOf({ "ai.spendCap.monthlyUsd": "" }), now: NOW, timeZone: TZ }), true, "off by default");
    assert.equal(withinMonthlyCap("deepseek", { db, store: storeOf({}), now: NOW, timeZone: TZ }), true);
    const capped = storeOf({ "ai.spendCap.monthlyUsd": "0.70" });
    for (const id of ["deepseek", "anthropic", "openai", "openrouter"]) {
      assert.equal(withinMonthlyCap(id, { db, store: capped, now: NOW, timeZone: TZ }), false, `${id} is metered`);
    }
    for (const id of ["claude", "claude-code", "chatgpt", "local"]) {
      assert.equal(withinMonthlyCap(id, { db, store: capped, now: NOW, timeZone: TZ }), true, `${id} is not billed per use`);
    }
    assert.equal(withinMonthlyCap("deepseek", { db, store: storeOf({ "ai.spendCap.monthlyUsd": "$5" }), now: NOW, timeZone: TZ }), true);
    const s = monthlyCapStatus("deepseek", { db, store: capped, now: NOW, timeZone: TZ });
    assert.equal(s.ok, false);
    assert.equal(s.subtype, "spend-cap");
    assert.equal(s.capUsd, 0.7);
    close(s.spentUsd, 0.75);
    assert.equal(s.remainingUsd, 0);
    assert.match(s.message, /\$0\.70/);
    assert.match(s.message, /Settings > AI/);
    assert.equal(monthlyCapStatus("claude", { db, store: capped, now: NOW, timeZone: TZ }).ok, true);
  });
});
