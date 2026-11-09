// The Usage page's rules (src/public/js/usage-core.js): counts, speeds, times and a chart's bars as people read them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

await import("../src/public/js/usage-core.js");
const U = globalThis.UsageCore;

describe("usage page: counts and speeds as people read them", () => {
  it("token counts: plain under a thousand, then k, M and B with at most one decimal", () => {
    assert.deepEqual([0, 850, 1000, 12_400, 12_049, 99_960, 412_300, 1_000_000, 18_240_000, 137_000_000, 2_241_806_691].map(U.tokens),
      ["0", "850", "1k", "12.4k", "12k", "100k", "412k", "1M", "18.2M", "137M", "2.2B"]);
  });
  it("speeds, times and shares", () => {
    assert.equal(U.tps(38.4), "38 tk/s");
    assert.equal(U.tps(4.25), "4.3 tk/s");
    assert.equal(U.tps(13410.8), "13,411 tk/s");
    assert.equal(U.tps(null), "");
    assert.deepEqual([41_000, 125_000, 3_900_000, 60 * 3_600_000].map(U.dur), ["41s", "2m 05s", "1h 05m", "2d 12h"]);
    assert.equal(U.pct(0.964), "96%");
    assert.equal(U.pct(0.004), "under 1%");
  });
  it("the line under a reply", () => {
    assert.equal(U.answerLine({ total: 12_400, outTps: 38.2, ms: 41_000 }), "12.4k tokens · 38 tk/s · 41s");
    assert.equal(U.answerLine({ total: 12_400, outTps: null, ms: 41_000 }), "12.4k tokens · 41s");
    assert.equal(U.answerLine({ total: 0 }), "", "a turn with no model calls has no line");
    assert.equal(U.liveLine({ total: 84_200, nowTps: 41, outTps: 39 }), "84.2k tokens · 41 tk/s", "the latest calls' speed while it works");
    assert.equal(U.liveLine({ total: 84_200, nowTps: null, outTps: 39 }), "84.2k tokens · 39 tk/s");
    assert.equal(U.liveLine({ total: 45_300, nowTps: null, outTps: null }), "45.3k tokens", "the first call still going: no speed yet");
    assert.equal(U.liveLine(null), "");
  });
  it("a breakdown: every kind of token, the total, the cache's share and both speeds", () => {
    const rows = U.breakdown({ input: 10, cacheRead: 9000, cacheWrite: 500, output: 490, total: 10_000, cacheShare: 0.9, outTps: 98, totalTps: 2000, genMs: 5000, calls: 3 });
    assert.deepEqual(rows.map((r) => [r.label, r.value]), [
      ["Input", "10"], ["Cache read", "9,000"], ["Cache write", "500"], ["Output", "490"], ["Total", "10,000"],
      ["Cache reads", "90%"], ["Output speed", "98 tk/s"], ["Total speed", "2,000 tk/s"], ["Generating", "5s"],
    ]);
    assert.equal(U.breakdown({ total: 5, outTps: null }).find((r) => r.label === "Output speed").value, "not measured");
  });
  it("a chart's bars: scaled to the tallest, the strong part inside its bar, a gap between them", () => {
    const { max, bars } = U.bars([{ total: 100, part: 10 }, { total: 50, part: 50 }, { total: 0, part: 0 }], 300, 100, { gap: 6 });
    assert.equal(max, 100);
    assert.deepEqual(bars[0], { x: 3, w: 94, y: 0, h: 100, partY: 90, partH: 10 });
    assert.equal(bars[1].h, 50);
    assert.equal(bars[1].partH, 50);
    assert.equal(bars[2].h, 0);
    assert.deepEqual([1, 7, 13, 240, 2_241_806_691].map(U.niceMax), [1, 10, 20, 250, 2_500_000_000]);
  });
  it("times in the server's timezone: the hour today, the day and hour before", () => {
    U.setTimeZone("Asia/Tokyo");
    assert.equal(U.timeZone(), "Asia/Tokyo");
    const now = Date.parse("2026-10-26T01:00:00Z");   // 10 AM in Tokyo
    assert.equal(U.when(Date.parse("2026-10-26T00:19:00Z"), now), "9:19 AM");
    assert.equal(U.when(Date.parse("2026-10-25T00:19:00Z"), now), "Oct 25, 9:19 AM");
    assert.equal(U.dayLabel(now), "Oct 26");
    assert.equal(U.hourLabel(now), "10 AM");
    U.setTimeZone("America/New_York");
    assert.equal(U.dayLabel(now), "Oct 25", "still the evening before in New York");
    assert.equal(U.span(now - 90_000, null, now), "running 1m 30s");
  });
  it("money: cents, thousands, and under a cent said so", () => {
    assert.deepEqual([0, 0.004, 0.0631, 0.5, 12.5, 1234.5].map(U.money), ["$0.00", "under $0.01", "$0.06", "$0.50", "$12.50", "$1,234.50"]);
    assert.equal(U.money(null), "");
  });
  it("what a cost is: exact, estimated, included in a plan, free, or not known", () => {
    assert.equal(U.costText({ costUsd: 0.37, costNote: "exact" }), "$0.37");
    assert.equal(U.costText({ costUsd: 0.0631, costNote: "est" }), "$0.06 est.");
    assert.equal(U.costText({ costUsd: null, costNote: "plan" }), "Included in plan");
    assert.equal(U.costText({ costUsd: 0, costNote: "free" }), "Free");
    assert.equal(U.costText({ costUsd: null, costNote: "unknown" }), "Cost not known");
    assert.equal(U.costText({ costUsd: null, costNote: null }), "", "nothing ran: nothing to say");
    assert.equal(U.costText(null), "");
  });
  it("a reply's line and breakdown carry what it cost; a plan's reply line stays as it was", () => {
    assert.equal(U.answerLine({ total: 12_400, outTps: 38.2, ms: 41_000, costUsd: 0.0123, costNote: "est" }), "12.4k tokens · 38 tk/s · 41s · $0.01 est.");
    assert.equal(U.answerLine({ total: 12_400, outTps: 38.2, ms: 41_000, costUsd: null, costNote: "plan" }), "12.4k tokens · 38 tk/s · 41s");
    const rows = U.breakdown({ total: 10, outTps: null, costUsd: null, costNote: "plan", providerLabel: "Claude plan" });
    const cost = rows.find((r) => r.label === "Cost");
    assert.equal(cost.value, "Included in plan");
    assert.equal(rows.at(-1).label, "Cost", "after the tokens");
    assert.equal(U.breakdown({ total: 10, costUsd: 0.37, costNote: "exact" }).find((r) => r.label === "Cost").value, "$0.37");
    assert.equal(U.breakdown({ total: 10 }).find((r) => r.label === "Cost"), undefined, "no cost known: no row");
  });
  it("the chart's spend line: the days' total and the daily average, est. when any of it is", () => {
    const days = [{ costUsd: null, costNote: "plan" }, { costUsd: 0.5, costNote: "exact" }, { costUsd: 0.9, costNote: "est" }, { costUsd: null, costNote: null }];
    assert.equal(U.spendLine(days), "Spent $1.40 est. over 4 days, about $0.35 a day");
    assert.equal(U.spendLine([{ costUsd: 0.5, costNote: "exact" }, { costUsd: 0.25, costNote: "exact" }]), "Spent $0.75 over 2 days, about $0.38 a day");
    assert.equal(U.spendLine([{ costUsd: null, costNote: "plan" }, { costUsd: null, costNote: "plan" }]), "Included in plan", "only a plan's work");
    assert.equal(U.spendLine([{ costUsd: null, costNote: null }]), "", "nothing ran");
    assert.equal(U.spendLine(undefined), "");
  });
  it("the provider filter shows once more than one AI did work, and stays while it is in use", () => {
    const list = [{ id: "claude", label: "Claude plan" }, { id: "deepseek", label: "DeepSeek" }];
    const c = U.providerChoices(list, null);
    assert.equal(c.show, true);
    assert.deepEqual(c.items.map((i) => [i.id, i.label, i.pressed]), [[null, "All", true], ["claude", "Claude plan", false], ["deepseek", "DeepSeek", false]]);
    assert.equal(U.providerChoices([list[0]], null).show, false, "one AI: nothing to choose");
    const kept = U.providerChoices([list[1]], "deepseek");
    assert.equal(kept.show, true);
    assert.deepEqual(kept.items.filter((i) => i.pressed).map((i) => i.id), ["deepseek"]);
    assert.equal(U.providerChoices(undefined, null).show, false);
  });
  it("a zone the browser does not know falls back to the browser's own", () => {
    U.setTimeZone("Not/AZone");
    assert.equal(U.timeZone(), undefined);
    assert.ok(U.when(Date.now()));
    U.setTimeZone(null);
    assert.equal(U.timeZone(), undefined);
  });
});
