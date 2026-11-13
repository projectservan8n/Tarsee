//! Timezone names.
//!
//! JavaScript's `Intl` takes an IANA zone name in any letter case (`asia/manila` is `Asia/Manila`), and the Node
//! version kept the name as the owner typed it. `chrono_tz` parses names exactly, so a name in another case would
//! silently become UTC: the owner's days, months and reminders would start at the wrong hour. Parse every zone name
//! that comes from a setting, the environment or a tool argument with [`parse`].

use chrono_tz::Tz;

/// The zone with this IANA name, in any letter case; `None` when there is no such zone. Surrounding spaces are not
/// forgiven, as `Intl` does not forgive them.
pub fn parse(name: &str) -> Option<Tz> {
    name.parse::<Tz>().ok().or_else(|| Tz::from_str_insensitive(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zone_name_is_found_in_any_letter_case() {
        assert_eq!(parse("Asia/Manila"), Some(Tz::Asia__Manila));
        assert_eq!(parse("asia/manila"), Some(Tz::Asia__Manila));
        assert_eq!(parse("EUROPE/BERLIN"), Some(Tz::Europe__Berlin));
        assert_eq!(parse("utc"), Some(Tz::UTC));
    }

    #[test]
    fn a_name_that_is_no_zone_is_none() {
        assert_eq!(parse("Mars/Olympus_Mons"), None);
        assert_eq!(parse(" Asia/Manila"), None);
        assert_eq!(parse(""), None);
    }
}
