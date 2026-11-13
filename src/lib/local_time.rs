//! Port of `src/lib/local-time.js`: days, hours and months in the owner's timezone (`config.timezone`), for the
//! Usage page (`lib/token_usage.rs`) and the monthly spending cap (`ai/spend.rs`).
//!
//! Every function takes the zone, so a test can pin one; an unknown zone counts as UTC. Moments are milliseconds
//! since the Unix epoch, as in the JS (`Date.now()`).

use chrono::{DateTime, Offset, TimeZone, Utc};

const H: i64 = 3_600_000;
const DAY: i64 = 24 * H;

/// How far a timezone is ahead of UTC at a moment, in ms (UTC+8 is 28_800_000; an unknown zone counts as UTC).
pub fn zone_offset_ms(ms: i64, time_zone: &str) -> i64 {
    let Some(tz) = crate::util::tz::parse(time_zone) else {
        return 0;
    };
    let Some(utc) = DateTime::<Utc>::from_timestamp_millis(ms) else {
        return 0;
    };
    i64::from(tz.offset_from_utc_datetime(&utc.naive_utc()).fix().local_minus_utc()) * 1000
}

/// The local date of a moment, "2026-10-26".
pub fn local_day(ms: i64, time_zone: &str) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms + zone_offset_ms(ms, time_zone))
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// The local midnight that began the day a moment falls in (right across daylight-saving changes).
pub fn local_midnight(now: i64, time_zone: &str) -> i64 {
    let local = now + zone_offset_ms(now, time_zone);
    let midnight = local - local.rem_euclid(DAY);
    // The offset at midnight can differ from the offset now (a clock change in between): ask again there.
    midnight - zone_offset_ms(midnight - zone_offset_ms(now, time_zone), time_zone)
}

/// The local midnights that began each of the last `n` days, oldest first (today last).
pub fn day_starts(now: i64, n: usize, time_zone: &str) -> Vec<i64> {
    let today = local_midnight(now, time_zone);
    // Noon of each earlier day (so a 23- or 25-hour day does not slip into its neighbour), back to its midnight.
    (0..n)
        .rev()
        .map(|i| {
            if i == 0 {
                today
            } else {
                local_midnight(today - (i as i64) * DAY + 12 * H, time_zone)
            }
        })
        .collect()
}

/// The local midnight that began the calendar month a moment falls in.
pub fn month_start(now: i64, time_zone: &str) -> i64 {
    let day = local_day(now, time_zone);
    let mut parts = day.split('-').map(|p| p.parse::<i64>().unwrap_or(1));
    let (y, m) = (parts.next().unwrap_or(1970), parts.next().unwrap_or(1));
    // Noon on the 1st, local time (well clear of any clock change), then back to that day's midnight.
    let noon = Utc
        .with_ymd_and_hms(y as i32, m as u32, 1, 12, 0, 0)
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or(now);
    local_midnight(noon - zone_offset_ms(noon, time_zone), time_zone)
}

/// The current moment in ms since the Unix epoch (`Date.now()`).
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn the_offset_is_the_zones_at_that_moment_and_zero_for_an_unknown_zone() {
        let winter = utc(2026, 1, 15, 12, 0);
        let summer = utc(2026, 7, 15, 12, 0);
        assert_eq!(zone_offset_ms(winter, "Asia/Manila"), 8 * H);
        assert_eq!(zone_offset_ms(winter, "Europe/Berlin"), H);
        assert_eq!(zone_offset_ms(summer, "Europe/Berlin"), 2 * H);
        assert_eq!(zone_offset_ms(winter, "America/New_York"), -5 * H);
        assert_eq!(zone_offset_ms(winter, "UTC"), 0);
        assert_eq!(zone_offset_ms(winter, "Mars/Olympus_Mons"), 0);
        // A name in another letter case is the same zone, as it was for JavaScript.
        assert_eq!(zone_offset_ms(winter, "asia/manila"), 8 * H);
    }

    #[test]
    fn the_local_day_is_the_date_on_the_owners_calendar() {
        // 20:00 UTC on the 26th is already the 27th in Manila and still the 26th in New York.
        let ms = utc(2026, 10, 26, 20, 0);
        assert_eq!(local_day(ms, "Asia/Manila"), "2026-10-27");
        assert_eq!(local_day(ms, "America/New_York"), "2026-10-26");
        assert_eq!(local_day(ms, "UTC"), "2026-10-26");
    }

    #[test]
    fn local_midnight_is_the_start_of_the_local_day() {
        let ms = utc(2026, 10, 26, 20, 0);
        assert_eq!(local_midnight(ms, "Asia/Manila"), utc(2026, 10, 26, 16, 0));
        assert_eq!(local_midnight(ms, "UTC"), utc(2026, 10, 26, 0, 0));
    }

    #[test]
    fn local_midnight_is_right_on_the_day_the_clocks_change() {
        // Berlin went from UTC+2 to UTC+1 at 01:00 UTC on 2026-10-25: that day began at 22:00 UTC the day before.
        let after_change = utc(2026, 10, 25, 12, 0);
        assert_eq!(local_midnight(after_change, "Europe/Berlin"), utc(2026, 10, 24, 22, 0));
        // And the day after began at 23:00 UTC.
        assert_eq!(
            local_midnight(utc(2026, 10, 26, 12, 0), "Europe/Berlin"),
            utc(2026, 10, 25, 23, 0)
        );
    }

    #[test]
    fn day_starts_are_the_last_n_midnights_oldest_first() {
        let now = utc(2026, 10, 27, 9, 0);
        let starts = day_starts(now, 4, "Europe/Berlin");
        assert_eq!(
            starts,
            vec![
                utc(2026, 10, 23, 22, 0),
                utc(2026, 10, 24, 22, 0),
                utc(2026, 10, 25, 23, 0),
                utc(2026, 10, 26, 23, 0)
            ]
        );
        assert_eq!(day_starts(now, 1, "UTC"), vec![utc(2026, 10, 27, 0, 0)]);
        assert!(day_starts(now, 0, "UTC").is_empty());
    }

    #[test]
    fn month_start_is_the_local_midnight_of_the_first() {
        assert_eq!(
            month_start(utc(2026, 10, 27, 9, 0), "Europe/Berlin"),
            utc(2026, 9, 30, 22, 0)
        );
        // 20:00 UTC on Oct 31 is already November in Manila.
        assert_eq!(
            month_start(utc(2026, 10, 31, 20, 0), "Asia/Manila"),
            utc(2026, 10, 31, 16, 0)
        );
        assert_eq!(month_start(utc(2026, 1, 1, 0, 0), "UTC"), utc(2026, 1, 1, 0, 0));
    }
}
