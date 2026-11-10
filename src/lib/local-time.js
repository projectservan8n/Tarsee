/**
 * Days, hours and months in the owner's timezone (config.TIMEZONE, from TARSEE_TIMEZONE or the host's zone), for
 * the Usage page (lib/token-usage.js) and the monthly spending cap (ai/spend.js). Every function takes the zone, so
 * tests can pin one; an unknown zone counts as UTC.
 */
import config from "../config/env.js";

const H = 3_600_000;
const DAY = 24 * H;
const zoneFormats = new Map();

/** How far a timezone is ahead of UTC at a moment, in ms (UTC+8 is 28_800_000; an unknown zone counts as UTC). */
export function zoneOffsetMs(ms, timeZone = config.TIMEZONE) {
  let f = zoneFormats.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      });
    } catch { return 0; }
    zoneFormats.set(timeZone, f);
  }
  const v = {};
  for (const p of f.formatToParts(new Date(ms))) v[p.type] = Number(p.value);
  const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The local date of a moment, "2026-10-26". */
export function localDay(ms, timeZone = config.TIMEZONE) {
  return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(0, 10);
}

/** The local midnight that began the day a moment falls in (right across daylight-saving changes). */
export function localMidnight(now = Date.now(), timeZone = config.TIMEZONE) {
  const local = now + zoneOffsetMs(now, timeZone);
  const midnight = local - (((local % DAY) + DAY) % DAY);
  // The offset at midnight can differ from the offset now (a clock change in between): ask again there.
  return midnight - zoneOffsetMs(midnight - zoneOffsetMs(now, timeZone), timeZone);
}

/** The local midnights that began each of the last `n` days, oldest first (today last). */
export function dayStarts(now = Date.now(), n = 14, timeZone = config.TIMEZONE) {
  const today = localMidnight(now, timeZone);
  const out = [];
  // Noon of each earlier day (so a 23- or 25-hour day does not slip into its neighbour), back to its midnight.
  for (let i = n - 1; i >= 0; i--) out.push(i ? localMidnight(today - i * DAY + 12 * H, timeZone) : today);
  return out;
}

/** The local midnight that began the calendar month a moment falls in. */
export function monthStart(now = Date.now(), timeZone = config.TIMEZONE) {
  const [y, m] = localDay(now, timeZone).split("-").map(Number);
  // Noon on the 1st, local time (well clear of any clock change), then back to that day's midnight.
  const noon = Date.UTC(y, m - 1, 1, 12);
  return localMidnight(noon - zoneOffsetMs(noon, timeZone), timeZone);
}
