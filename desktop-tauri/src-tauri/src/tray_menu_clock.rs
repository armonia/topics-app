//! Local wall-clock helpers for the tray menu wording (dates, zone offset).

/// A calendar date in the local zone, the pieces the menu words need.
pub(crate) struct Civil {
    pub day: i64,
    pub month: usize,
    pub dom: i64,
    pub weekday: usize,
    pub hour: i64,
    pub minute: i64,
}

/// Local wall clock of an epoch time in ms; `offset` is the zone's distance from UTC in seconds.
pub(crate) fn civil(ms: i64, offset: i64) -> Civil {
    let secs = ms.div_euclid(1000) + offset;
    let day = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // days since 1970-01-01 to a calendar date (proleptic Gregorian)
    let z = day + 719_468;
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dom = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    // 1970-01-01 was a Thursday; 0 = Monday
    Civil { day, month: (month - 1) as usize, dom, weekday: (day + 3).rem_euclid(7) as usize, hour: rem / 3600, minute: rem % 3600 / 60 }
}

/// The zone's distance from UTC in seconds, as the system's `date` says it. Tests pin it to +1 h.
#[cfg(not(test))]
pub(crate) fn local_offset_secs() -> i64 {
    let Ok(out) = std::process::Command::new("date").arg("+%z").output() else { return 0 };
    let z = String::from_utf8_lossy(&out.stdout);
    let z = z.trim();
    if z.len() != 5 {
        return 0;
    }
    let (sign, h, m) = (if z.starts_with('-') { -1 } else { 1 }, z[1..3].parse::<i64>().unwrap_or(0), z[3..5].parse::<i64>().unwrap_or(0));
    sign * (h * 3600 + m * 60)
}
#[cfg(test)]
pub(crate) fn local_offset_secs() -> i64 {
    3600
}

const WEEKDAYS: [&str; 7] = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
const MONTHS: [&str; 12] = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];

/// «oggi 17:00», «domani 09:00», or «mar 10 nov 09:00» for a later day.
pub(crate) fn when_text(at_ms: i64, now_secs: i64, offset: i64) -> String {
    let (c, today) = (civil(at_ms, offset), civil(now_secs * 1000, offset).day);
    let clock = format!("{:02}:{:02}", c.hour, c.minute);
    match c.day - today {
        0 => format!("oggi {clock}"),
        1 => format!("domani {clock}"),
        _ => format!("{} {} {} {clock}", WEEKDAYS[c.weekday], c.dom, MONTHS[c.month]),
    }
}

