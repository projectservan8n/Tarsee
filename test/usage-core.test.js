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
  it("a zone the browser does not know falls back to the browser's own", () => {
    U.setTimeZone("Not/AZone");
    assert.equal(U.timeZone(), undefined);
    assert.ok(U.when(Date.now()));
    U.setTimeZone(null);
    assert.equal(U.timeZone(), undefined);
  });
});
