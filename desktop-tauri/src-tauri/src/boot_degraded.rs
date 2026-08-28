//! What the shell can TELL THE CLIENT about its boot verdict.
//!
//! WHY THIS EXISTS, measured on Windows 2.2.199 on 2026-08-28 (board card
//! d1f702ab). With the `external-server-seen` marker present and no server on
//! :3333 the shell deliberately waits instead of forking an empty universe (the
//! 2026-08-13 incident, see `decide_upstream_and_spawn`). That rule stays. What
//! did not work is where the explanation was PUT: `reconnect_page.rs` names the
//! cause and the marker's path, but that page is served by the loopback proxy and
//! only for a DOCUMENT navigation. The window loads its bundle from the app's own
//! scheme (`frontendDist`), so the page is never on the user's path: the SPA paints
//! itself, its API calls find nobody, and all the person sees is a red dot.
//!
//! So the fact goes through the door the SPA can actually knock on: a command. The
//! answer is the same one the page prints, and the client shows it next to its own
//! offline state (`client/src/lib/shell/bootDegraded.ts`).
//!
//! Pure and platform-independent on purpose, like `boot_choice.rs` and
//! `reconnect_page.rs` next door: no body hidden behind a `#[cfg]`, so a
//! `cargo check` on a Mac still covers the one path only Windows reproduces.

use crate::reconnect_page::DEGRADED_MARKER_PATH;
use crate::DEFAULT_UPSTREAM_PORT;

/// The payload, built from the boot verdict passed in so it can be asserted without
/// a running shell.
///
/// `marker` is `Some(path)` ONLY in the degraded case. `None` is every ordinary
/// outage (a server restart, a cold start): there the client must keep saying just
/// "reconnecting", because that wait ends by itself and naming a file there would be
/// noise about nothing.
///
/// `port` travels with it instead of being hardcoded twice: the sentence the client
/// shows says WHICH server is being waited for, and that number has one owner.
pub(crate) fn degraded_payload(marker: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "degraded": marker.is_some(),
        "markerPath": marker,
        "port": DEFAULT_UPSTREAM_PORT,
    })
}

/// Read the boot verdict: `{ degraded, markerPath, port }`. Cheap and constant for
/// the life of the process (the verdict is written once at boot), so the client asks
/// it once.
#[tauri::command]
pub(crate) fn boot_degraded() -> serde_json::Value {
    degraded_payload(DEGRADED_MARKER_PATH.get().map(|s| s.as_str()))
}

#[cfg(test)]
mod tests {
    use super::degraded_payload;
    use crate::DEFAULT_UPSTREAM_PORT;

    /// The degraded answer must carry BOTH the cause and the way out: without the
    /// path there is no way out, and a file nobody names is not a way out.
    #[test]
    fn degraded_answer_names_the_marker_and_the_port() {
        let path = "C:\\Users\\x\\AppData\\Roaming\\io.armonia.topics.tauri\\external-server-seen";
        let v = degraded_payload(Some(path));
        assert_eq!(v["degraded"], true);
        assert_eq!(v["markerPath"], path);
        assert_eq!(v["port"], DEFAULT_UPSTREAM_PORT);
    }

    /// An ordinary outage says nothing: `degraded` false and no path at all, so the
    /// client cannot accidentally show the explanation during a plain restart.
    #[test]
    fn ordinary_outage_answer_carries_no_marker() {
        let v = degraded_payload(None);
        assert_eq!(v["degraded"], false);
        assert!(v["markerPath"].is_null());
    }
}
