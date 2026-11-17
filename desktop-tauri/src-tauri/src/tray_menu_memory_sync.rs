//! The memory sync card of the tray menu, split out of tray_menu_views.rs to keep that file
//! under the check:bloat line ceiling. Same shape as the backup card: days are the nightly runs,
//! proofs are the synced parts.

use crate::tray_menu_views::{s, when, BackupCard};
use serde_json::Value;

/// How long the nightly memory sync may go without a good run before the card says «da guardare».
const MEMORY_SYNC_FRESH_S: i64 = 26 * 3600;

/// The service's memory-sync answer has the shape of the contract: an object with `runs` and `parts` lists.
/// Anything else (an error body, an older service) is no answer, so no card.
pub fn memory_sync_valid(body: &str) -> bool {
    serde_json::from_str::<Value>(body).map_or(false, |v| v.get("runs").map_or(false, Value::is_array) && v.get("parts").map_or(false, Value::is_array))
}

/// The memory sync card from the service's state (or its cached copy): the same card as the backup,
/// its days the nightly runs, its proofs the parts that are synced. `None` until a valid answer exists.
pub fn memory_sync_card(body: &str, now: i64) -> Option<BackupCard> {
    if !memory_sync_valid(body) {
        return None;
    }
    let v: Value = serde_json::from_str(body).ok()?;
    let at = |k: &str| v.get(k).and_then(Value::as_i64);
    let last_ok = at("last_ok");
    let runs: Vec<(i64, bool)> = v.get("runs").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|r| Some((r.get("at").and_then(Value::as_i64)?, r.get("ok").and_then(Value::as_bool)?))).collect();
    // the last run failed: the service says so (error or exit code), or the newest run on record did
    let err = Some(s(&v, "last_error")).filter(|e| !e.is_empty());
    let newest_failed = runs.iter().max_by_key(|r| r.0).map_or(false, |r| !r.1);
    let failed = err.is_some() || at("last_rc").map_or(false, |rc| rc != 0) || newest_failed;
    let stale = last_ok.map_or(true, |t| now - t > MEMORY_SYNC_FRESH_S);
    let (badge, level, caption) = if failed {
        ("problema", 2, err.map_or("L'ultimo giro è fallito".to_string(), |e| format!("L'ultimo giro è fallito: {e}")))
    } else if stale {
        ("da guardare", 1, "Nessun giro riuscito nelle ultime 26 ore".to_string())
    } else {
        ("a posto", 0, format!("Ultimo giro riuscito {}", when(now, last_ok.unwrap_or(now))))
    };
    let mut by_day: std::collections::BTreeMap<i64, bool> = Default::default();
    for (t, ok) in &runs {
        // a day counts as good when any of its runs went well
        let e = by_day.entry(t / 86_400).or_insert(false);
        *e |= *ok;
    }
    let today = now / 86_400;
    let first = by_day.keys().next().copied();
    let days: Vec<Option<bool>> = (0..30).rev().map(|back| {
        let d = today - back;
        match by_day.get(&d) {
            Some(ok) => Some(*ok),
            None if back == 0 => None,
            None if first.map_or(false, |f| d > f) => Some(false),
            None => None,
        }
    }).collect();
    let judged = days.iter().flatten().count();
    let good = days.iter().flatten().filter(|ok| **ok).count();
    let days_say = if judged == 0 { String::new() } else { format!("{good} giorni su {judged} riusciti") };
    let proofs = v.get("parts").and_then(Value::as_array).into_iter().flatten().filter(|p| !s(p, "name").is_empty()).map(|p| {
        let ok = p.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let say = Some(s(p, "detail")).filter(|d| !d.is_empty()).map(String::from)
            .unwrap_or_else(|| p.get("last_ok").and_then(Value::as_i64).map_or("mai".into(), |t| when(now, t)));
        (s(p, "name").to_string(), say, ok)
    }).collect();
    let foot = at("last_run").map_or(String::new(), |t| format!("Ultimo giro: {}", when(now, t)));
    Some(BackupCard { title: "Sincronizzazione memorie".into(), badge: badge.into(), level, caption, days, days_say, proofs, foot })
}
