//! The boot RULE, separated from the boot EFFECTS: what the shell concludes from
//! probing for a live Topics daemon, with none of the doing (writing the marker,
//! setting `UPSTREAM`, spawning a process). The effects stay in
//! `decide_upstream_and_spawn`.
//!
//! Its own file, like `reconnect_page.rs` next door, for two reasons: `lib.rs` has
//! no room left, and this rule is the one piece of the shell that must be provable
//! without a tauri app, a real server or 42 seconds of waiting. Pure and
//! platform-independent, so every OS compiles and tests it.
//!
//! THE 2026-09-12 CHANGE. A NON-Topics process (an "account-switcher" dashboard)
//! squats `127.0.0.1:3333` and answers `200 text/html` for *every* path, so the
//! old probe — any HTTP status line means "a server is here" — deferred to the
//! squatter and the app lost its real data (the window showed a connection error
//! against an HTML dashboard that was not Topics at all). The daemon now recovers
//! that situation itself (it binds an ephemeral port and records the real one in
//! `daemon-state.json`), and this rule finds it:
//!   * a Topics daemon on `:3333`, OR
//!   * a Topics daemon on the port its state file records,
//! is deferred to BY SHAPE (its unauthenticated `/api/system/presence` body has a
//! shape no squatter emits). A squatter on :3333 is NOT a Topics server, so the
//! shell spawns the sidecar (or waits for a known server) instead of deferring to
//! an HTML dashboard.

/// Where the shell should point the proxy, decided from the probe outcomes + the
/// daemon-state port + the external-server marker.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum BootChoice {
    /// A Topics daemon is serving on `:port`. Defer to it; never spawn a sidecar.
    /// `tls` is true only for a daemon that answered with TLS (the canonical
    /// :3333 external/launchd server); a squatter-recovery daemon on an ephemeral
    /// port is always plain HTTP.
    Defer { port: u16, tls: bool },
    /// No Topics daemon answered, but the marker says this machine owns a real
    /// server. Keep pointing at :3333 and wait: forking an empty universe here is
    /// strictly worse (the 2026-08-13 incident).
    WaitForKnownServer,
    /// No Topics daemon answered and nothing was ever here. Spawn the bundled
    /// sidecar.
    SpawnSidecar,
}

/// The boot rule itself, made PURE so it is provable without sockets or a tauri
/// app: given what the probes found and the daemon-state port, decide where the
/// proxy should point.
///
/// Arguments:
///   * `primary_topics` — a TOPICS daemon (by shape) answered on the canonical
///     `:3333`. `primary_tls` records WHICH probe matched it: the TLS probe
///     (`true`, the external launchd/dev server serves TLS) or the plain-HTTP
///     probe (`false`, a dev server without TLS). Only read when `primary_topics`.
///   * `state_topics` / `state_port` — a TOPICS daemon (by shape) answered on the
///     port the daemon's own `daemon-state.json` records (`state_port`). This is
///     the squatter-recovery case: :3333 is held by someone else, the daemon is on
///     an ephemeral port only the state file knows.
///   * `seen_before` — the external-server marker: this machine has owned a real
///     server here before, so a missing daemon means "wait", not "fork empty".
///   * `primary_foreign` — a FOREIGN (non-Topics) process is actively answering on
///     `:3333`. It is only meaningful when NO Topics daemon answered (otherwise we
///     would already have deferred), and it means the "wait for my known server"
///     marker is stale (a squatter — not our server — owns :3333), so the marker is
///     invalidated and the sidecar spawns instead of the app hanging on a foreign
///     dashboard (the 2026-09-12 account-switcher case).
///
/// Decision order, most-to-least trusted:
///   1. A Topics daemon on the daemon-state port → defer to THAT port (plain
///      HTTP: a squatter-recovery daemon is a loopback ephemeral).
///   2. A Topics daemon on :3333 → defer to :3333 (with the TLS the probe saw).
///   3. Marker present, no daemon → WaitForKnownServer.
///   4. Otherwise → SpawnSidecar.
pub(crate) fn decide_boot(
    primary_topics: bool,
    primary_tls: bool,
    state_topics: bool,
    state_port: Option<u16>,
    seen_before: bool,
    primary_foreign: bool,
) -> BootChoice {
    // A daemon recorded in daemon-state.json, confirmed by shape on that port, is
    // the one we want — even if :3333 is squatted (the 2026-09-12 case). A state
    // port of 0 (a corrupt/zero port) is not a usable target: fall through.
    if state_topics {
        if let Some(p) = state_port {
            if p != 0 {
                return BootChoice::Defer { port: p, tls: false };
            }
        }
    }
    // A daemon on the canonical port (the normal case). TLS only if the TLS probe
    // is what matched — a plain-HTTP dev server on :3333 defers without TLS.
    if primary_topics {
        return BootChoice::Defer { port: 3333, tls: primary_tls };
    }
    // No Topics daemon answered. The marker says this machine owns a real server,
    // so the 2026-08-13 invariant holds: WAIT for it, never fork an empty
    // universe. EXCEPT when a FOREIGN process is actively serving :3333 (the
    // 2026-09-12 account-switcher squatter, or a marker the old "any 200 = up"
    // probe wrote when it mistook that squatter for Topics): the real server is
    // NOT coming back on :3333, so waiting there hangs the app on a foreign
    // dashboard forever. A live foreign presence invalidates the marker → spawn.
    if seen_before && !primary_foreign {
        BootChoice::WaitForKnownServer
    } else {
        BootChoice::SpawnSidecar
    }
}

#[cfg(test)]
mod tests {
    use super::{decide_boot, BootChoice};

    /// THE 2026-09-12 REGRESSION GUARD. A squatter holds :3333 (the primary probe
    /// sees no Topics shape there), but the daemon recovered onto an ephemeral
    /// port (recorded in daemon-state.json) and answers by shape there. The shell
    /// must defer to the daemon's REAL port, not the squatter — this is the exact
    /// failure the user hit ("connection error" against an HTML dashboard on :3333).
    #[test]
    fn squatted_3333_defers_to_the_daemon_real_port() {
        let choice = decide_boot(false, true, true, Some(55655), true, false);
        assert_eq!(choice, BootChoice::Defer { port: 55655, tls: false });
    }

    /// The normal case: a Topics daemon on :3333 via TLS → defer to :3333 + TLS.
    #[test]
    fn a_topics_daemon_on_3333_defers_with_tls() {
        let choice = decide_boot(true, true, false, None, false, false);
        assert_eq!(choice, BootChoice::Defer { port: 3333, tls: true });
    }

    /// A plain-HTTP dev server on :3333 → defer to :3333 WITHOUT TLS (the old code
    /// probed TLS first, then plain, and deferred with the matching mode).
    #[test]
    fn a_plain_dev_server_on_3333_defers_without_tls() {
        let choice = decide_boot(true, false, false, None, false, false);
        assert_eq!(choice, BootChoice::Defer { port: 3333, tls: false });
    }

    /// A daemon on BOTH the state port and :3333: the state port wins (it is the
    /// port the daemon recorded as its real one).
    #[test]
    fn state_port_wins_over_primary() {
        let choice = decide_boot(true, true, true, Some(40000), false, false);
        assert_eq!(choice, BootChoice::Defer { port: 40000, tls: false });
    }

    /// A squatter on :3333 and NO daemon anywhere, virgin machine → spawn the
    /// sidecar (never defer to an HTML dashboard).
    #[test]
    fn squatter_on_3333_virgin_spawns_sidecar() {
        let choice = decide_boot(false, true, false, None, false, false);
        assert_eq!(choice, BootChoice::SpawnSidecar);
    }

    /// Companion to `contaminated_marker_does_not_wait_on_a_foreign_squatter`:
    /// NO foreign process on :3333 (a genuine server that is merely DOWN —
    /// connection refused), stale state, marker present → the 2026-08-13 invariant
    /// STILL holds: wait for the known server, never fork an empty universe. This
    /// is the case we must NOT break while fixing the contaminated-marker case.
    #[test]
    fn server_down_with_marker_still_waits() {
        let choice = decide_boot(false, true, false, Some(3333), true, false);
        assert_eq!(choice, BootChoice::WaitForKnownServer);
    }

    /// The marker is only consulted when NO daemon answered — a live daemon always
    /// beats a stale marker.
    #[test]
    fn a_live_daemon_beats_a_stale_marker() {
        let choice = decide_boot(true, true, false, None, true, false);
        assert_eq!(choice, BootChoice::Defer { port: 3333, tls: true });
    }

    /// A state port of 0 (a corrupt/zero port) is not a usable target: it must not
    /// produce a Defer to :0, and the rule falls through to the other outcomes.
    #[test]
    fn a_zero_state_port_is_not_deferred_to() {
        let choice = decide_boot(false, true, true, Some(0), false, false);
        assert_eq!(choice, BootChoice::SpawnSidecar);
    }

    /// THE 2026-09-12 CONTAMINATED-MARKER GUARD. The old "any 200 = up" probe
    /// mistook the foreign account-switcher dashboard on :3333 for Topics and
    /// wrote the external-server marker. Now: stale daemon-state (port 3333, dead
    /// pid) + that squatter still answering on :3333 + the marker present + NO
    /// Topics daemon anywhere. Waiting for the "known server" would hang the app
    /// on a foreign dashboard forever — so a live foreign presence INVALIDATES
    /// the marker and the sidecar spawns.
    #[test]
    fn contaminated_marker_does_not_wait_on_a_foreign_squatter() {
        let choice = decide_boot(false, true, false, Some(3333), true, true);
        assert_eq!(choice, BootChoice::SpawnSidecar);
    }
}
