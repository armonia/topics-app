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

use crate::reconnect_page::{degraded_marker, set_degraded_marker};
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
    degraded_payload(degraded_marker().as_deref())
}

/// What `clear_marker` decided, so the command stays a three-line wrapper and the
/// decision can be asserted without a shell.
#[derive(Debug, PartialEq)]
pub(crate) enum ClearVerdict {
    /// This boot is not the degraded one: do nothing at all.
    NotDegraded,
    /// The marker is gone (removed now, or already absent) — relaunch.
    Restart,
    /// It is still there and the app would come back to the same wait.
    Failed(String),
}

/// Remove the marker that caused the wait.
///
/// UNTIL NOW THE WAY OUT WAS A SENTENCE. The notice printed the file's absolute
/// path and asked the person to quit the app, find that path in a file manager and
/// delete it by hand — on Windows, inside AppData, on the machine where the thing
/// that stopped working IS the app. Naming the way out was the first half; this is
/// the second.
///
/// It is gated on the VERDICT, not on an argument the caller picks: `marker` is
/// `Some` only when this boot already concluded degraded, which happens once, in
/// `decide_upstream_and_spawn`. On a healthy boot the answer is `NotDegraded` and
/// nothing is touched, so no webview can delete a marker that is doing its job.
///
/// Reversible by construction: the shell writes the marker again the moment it
/// finds a real server on the port, so the worst case of a wrong click is one
/// relaunch that starts a local server.
pub(crate) fn clear_marker(marker: Option<&str>) -> ClearVerdict {
    let Some(path) = marker else { return ClearVerdict::NotDegraded };
    match std::fs::remove_file(path) {
        Ok(()) => ClearVerdict::Restart,
        // Already gone: the wait has no cause left, so the relaunch is still right.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ClearVerdict::Restart,
        Err(e) => ClearVerdict::Failed(e.to_string()),
    }
}

/// Delete the marker and relaunch. Returns only when nothing was done — on success
/// the process is replaced, so the caller's promise never settles.
///
/// `app.restart()` does not raise `RunEvent::Exit`, so `kill_sidecar` never runs
/// here. That orphans nothing: this command only acts on the degraded verdict, and
/// reaching that verdict means `decide_upstream_and_spawn` returned BEFORE spawning
/// anything — the slot it would kill is empty by construction.
#[tauri::command]
pub(crate) fn boot_degraded_clear(app: tauri::AppHandle) -> serde_json::Value {
    match clear_marker(degraded_marker().as_deref()) {
        ClearVerdict::NotDegraded => serde_json::json!({ "cleared": false, "reason": "not degraded" }),
        ClearVerdict::Failed(e) => serde_json::json!({ "cleared": false, "reason": e }),
        ClearVerdict::Restart => {
            // Nothing left to explain if the relaunch somehow does not happen.
            set_degraded_marker(None);
            app.restart()
        }
    }
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

    /// The command is gated on the boot verdict: with no marker there is nothing
    /// to undo, and a webview that asks anyway must not restart the app.
    #[test]
    fn a_healthy_boot_clears_nothing() {
        assert_eq!(super::clear_marker(None), super::ClearVerdict::NotDegraded);
    }

    /// The file is really removed, and the answer says "relaunch".
    #[test]
    fn the_marker_is_removed_and_the_app_relaunches() {
        let p = std::env::temp_dir().join("topics-clear-marker-test");
        std::fs::write(&p, "1").unwrap();
        let v = super::clear_marker(Some(p.to_str().unwrap()));
        assert_eq!(v, super::ClearVerdict::Restart);
        assert!(!p.exists(), "the marker had to be gone");
    }

    /// Already gone is not a failure: the wait has no cause left either way, so
    /// the relaunch is still the right answer and the user sees no error for
    /// having clicked twice.
    #[test]
    fn an_absent_marker_still_relaunches() {
        let p = std::env::temp_dir().join("topics-clear-marker-absent");
        let _ = std::fs::remove_file(&p);
        assert_eq!(super::clear_marker(Some(p.to_str().unwrap())), super::ClearVerdict::Restart);
    }
}
