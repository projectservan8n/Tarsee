/**
 * The Usage page's rules, with no page (js/usage.js draws them;
 * test/usage-core.test.js checks them in Node).
 *
 *   tokens        a count as people read it: 850, 12.4k, 412k, 18.2M, 1.2B
 *   tps           a speed: "38 tk/s", "4.2 tk/s"
 *   dur           how long: 41s, 2m 05s, 1h 05m
 *   pct           a share: "96%"
 *   answerLine    the line under a reply: "12.4k tokens · 38 tk/s · 41s"
 *   liveLine      the working line's part: "84.2k tokens · 41 tk/s"
 *   breakdown     a turn's or a job's numbers, in rows
 *   when, span    a moment and a run of time
 *   dayLabel, hourLabel   a chart bar's label
 *   bars          a chart's bars: where each one goes and how tall
 *
 * Times are shown in the server's timezone (the one its days are counted in),
 * which the page passes to setTimeZone from the API's `timeZone`. Until then,
 * or when the browser does not know that zone, the browser's own zone is used.
 *
 * Loaded by index.html as a plain script (window.UsageCore) and by the tests as
 * a module (globalThis.UsageCore).
 */
(function () {
  "use strict";

  let TZ;   // undefined: the browser's own zone

  /** Count days and hours in this IANA zone ("Europe/Berlin"); a zone the browser does not know is ignored. */
  function setTimeZone(tz) {
    if (!tz) { TZ = undefined; return; }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
      TZ = tz;
    } catch { TZ = undefined; }
  }
  function timeZone() { return TZ; }

  function tokens(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v < 1000) return String(Math.round(v));
    if (v < 100_000) return `${trim(v / 1000)}k`;
    if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
    if (v < 1_000_000_000) return `${trim(v / 1_000_000)}M`;
    return `${trim(v / 1_000_000_000)}B`;
  }
  // One decimal under 100, none above, and never "12.0".
  function trim(x) {
    const r = x < 100 ? Math.round(x * 10) / 10 : Math.round(x);
    return String(r).replace(/\.0$/, "");
  }

  function tps(v) {
    if (v == null || !Number.isFinite(Number(v))) return "";
    const n = Number(v);
    return `${n < 10 ? Math.round(n * 10) / 10 : Math.round(n).toLocaleString("en-US")} tk/s`;
  }

  function dur(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function pct(share) {
    const v = Number(share) || 0;
    if (v > 0 && v < 0.01) return "under 1%";
    return `${Math.round(v * 100)}%`;
  }

  /** The line under a reply. t: { total, outTps, ms } (a turn from the API). */
  function answerLine(t) {
    if (!t || !(t.total > 0)) return "";
    return [`${tokens(t.total)} tokens`, t.outTps != null ? tps(t.outTps) : "", t.ms != null ? dur(t.ms) : ""].filter(Boolean).join(" · ");
  }

  /**
   * The working line's part while a turn runs. u: { total, nowTps, outTps } (a "usage" step): the speed of the
   * latest model calls when known, else of all of them so far.
   */
  function liveLine(u) {
    if (!u || !(u.total > 0)) return "";
    const speed = u.nowTps != null ? u.nowTps : u.outTps;
    return [`${tokens(u.total)} tokens`, speed != null ? tps(speed) : ""].filter(Boolean).join(" · ");
  }

  /** A turn's or a job's numbers, in rows: [{ label, value, note }]. */
  function breakdown(t) {
    if (!t) return [];
    const rows = [
      { label: "Input", value: num(t.input), note: "new tokens read" },
      { label: "Cache read", value: num(t.cacheRead), note: "the conversation read again from the cache" },
      { label: "Cache write", value: num(t.cacheWrite), note: "put in the cache" },
      { label: "Output", value: num(t.output), note: "written, thinking included" },
      { label: "Total", value: num(t.total), strong: true },
      { label: "Cache reads", value: pct(t.cacheShare), note: "of the total" },
      { label: "Output speed", value: t.outTps != null ? tps(t.outTps) : "not measured", note: "output over generation time" },
      { label: "Total speed", value: t.totalTps != null ? tps(t.totalTps) : "not measured", note: "every token over generation time" },
    ];
    if (t.genMs) rows.push({ label: "Generating", value: dur(t.genMs), note: `over ${num(t.calls)} model call${t.calls === 1 ? "" : "s"}` });
    else if (t.calls) rows.push({ label: "Model calls", value: num(t.calls) });
    return rows;
  }
  function num(n) { return Math.round(Number(n) || 0).toLocaleString("en-US"); }

  /** A moment: "8:19 AM" today, "Oct 25, 8:19 AM" otherwise. */
  function when(ms, now = Date.now()) {
    if (!ms) return "";
    const d = new Date(ms);
    const day = (x) => new Date(x).toLocaleDateString("en-US", { timeZone: TZ });
    const time = d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
    if (day(ms) === day(now)) return time;
    return `${d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" })}, ${time}`;
  }

  /** "Oct 25" for a moment in that day. */
  function dayLabel(ms) {
    return new Date(ms).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  }

  /** "9 AM" for a moment in that hour. */
  function hourLabel(ms) {
    return new Date(ms).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric" });
  }

  /** A run of time from its start to its end (still going: "running …"). */
  function span(start, end, now = Date.now()) {
    return end ? dur(end - start) : `running ${dur(now - start)}`;
  }

  /**
   * A bar chart's bars. values: [{ total, part }] (part: the share drawn strong, e.g. new tokens),
   * w, h: the plot's size. Returns { max, bars: [{ x, w, y, h, partY, partH }] } with a gap between bars.
   */
  function bars(values, w, h, { gap = 4 } = {}) {
    const list = Array.isArray(values) ? values : [];
    const max = Math.max(1, ...list.map((v) => Number(v.total) || 0));
    const step = list.length ? w / list.length : w;
    const bw = Math.max(1, step - gap);
    return {
      max,
      bars: list.map((v, i) => {
        const total = Math.max(0, Number(v.total) || 0);
        const bh = total ? Math.max(1, (total / max) * h) : 0;
        const ph = total ? Math.min(bh, ((Number(v.part) || 0) / max) * h) : 0;
        return { x: i * step + gap / 2, w: bw, y: h - bh, h: bh, partY: h - ph, partH: ph };
      }),
    };
  }

  /** Round a chart's top up to a number that reads well (1, 2, 2.5 or 5 times a power of ten). */
  function niceMax(v) {
    const n = Math.max(1, Number(v) || 0);
    const p = Math.pow(10, Math.floor(Math.log10(n)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
    return 10 * p;
  }

  const api = { setTimeZone, timeZone, tokens, tps, dur, pct, answerLine, liveLine, breakdown, when, dayLabel, hourLabel, span, bars, niceMax };
  globalThis.UsageCore = Object.freeze(api);
})();
