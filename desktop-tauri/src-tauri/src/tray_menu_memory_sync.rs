//! The memory sync of the Mac, one row of the Mac's node card (it used to be a card of its own,
//! after the backup): when the memories saved on git last went well, and the same judgement as before.

use crate::tray_node_health::{day_clock, StatusRow};
use serde_json::Value;

/// How long the nightly memory sync may go without a good run before the row says «da guardare».
const MEMORY_SYNC_FRESH_S: i64 = 26 * 3600;

/// The service's memory-sync answer has the shape of the contract: an object with `runs` and `parts` lists.
/// Anything else (an error body, an older service) is no answer, so no row.
pub fn memory_sync_valid(body: &str) -> bool {
    serde_json::from_str::<Value>(body).map_or(false, |v| v.get("runs").map_or(false, Value::is_array) && v.get("parts").map_or(false, Value::is_array))
}

/// «Memorie e regole · salvate alle 03:01» from the service's state (or its cached copy). Fine within 26 hours of a good allow-italian: quoted menu wording
/// run; «da guardare» past that or with no good run on record; a problem when the last run failed.
/// `None` until a valid answer exists.
pub fn memory_sync_row(body: &str, now: i64, offset: i64) -> Option<StatusRow> {
    if !memory_sync_valid(body) {
        return None;
    }
    let v: Value = serde_json::from_str(body).ok()?;
    let at = |k: &str| v.get(k).and_then(Value::as_i64);
    let last_ok = at("last_ok");
    // the last run failed: the service says so (error or exit code), or the newest run on record did
    let err = v.get("last_error").and_then(Value::as_str).filter(|e| !e.is_empty());
    let newest_failed = v.get("runs").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|r| Some((r.get("at").and_then(Value::as_i64)?, r.get("ok").and_then(Value::as_bool)?))).max_by_key(|r| r.0).map_or(false, |r| !r.1);
    let failed = err.is_some() || at("last_rc").map_or(false, |rc| rc != 0) || newest_failed;
    let stale = last_ok.map_or(true, |t| now - t > MEMORY_SYNC_FRESH_S);
    let last = last_ok.map(|t| day_clock(now, t, offset));
    let (text, level) = match (failed, last) {
        (true, last) => (format!("ultimo giro fallito{}{}", err.map(|e| format!(": {e}")).unwrap_or_default(), last.map(|l| format!(" · riuscito {l}")).unwrap_or_default()), 2),
        (false, None) => ("nessun giro riuscito".to_string(), 1),
        (false, Some(l)) if stale => (format!("{} · oltre 26 ore fa", crate::tray_node_health::saved_text(&l)), 1),
        (false, Some(l)) => (crate::tray_node_health::saved_text(&l), 0),
    };
    Some(StatusRow { label: crate::tray_node_health::MEMORY_LABEL.into(), text, level })
}
