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

/// WHICH LOOPBACK ADDRESS answered, because on this machine they are not the
/// same machine. The daemon binds `[::]:3333`; a process that binds the more
/// specific `127.0.0.1:3333` COEXISTS with it (no `EADDRINUSE`, verified
/// 2026-09-14), and from then on IPv4 reaches the stranger while IPv6 reaches
/// the real daemon. A probe that only knows "port 3333" cannot tell those two
/// apart, and the shell that could not tell them apart started an empty sidecar
/// next to a live production server.
#[derive(Debug, PartialEq, Eq, Clone, Copy, Default)]
pub(crate) enum Loopback {
    #[default]
    V4,
    V6,
}

impl Loopback {
    /// The literal to connect to. `::1` without brackets: this is a host string
    /// for `TcpStream::connect((host, port))`, not a URL authority.
    pub(crate) fn host(self) -> &'static str {
        match self {
            Loopback::V4 => "127.0.0.1",
            Loopback::V6 => "::1",
        }
    }
}

/// Everything the probes found, named. It was eight positional booleans before,
/// and the call that read them wrong is exactly how a Mac with a live server
/// got an empty sidecar.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct BootFacts {
    /// A TOPICS daemon (by shape) answered on the canonical `:3333`, on
    /// `primary_host`, with `primary_tls` as the scheme that matched.
    pub primary_topics: bool,
    pub primary_host: Loopback,
    pub primary_tls: bool,
    /// The same, on the port the daemon recorded in `daemon-state.json`
    /// (`state_port`): the squatter-recovery case, where `:3333` is held by
    /// someone else and the daemon moved to an ephemeral port.
    pub state_topics: bool,
    pub state_host: Loopback,
    pub state_tls: bool,
    pub state_port: Option<u16>,
    /// The external-server marker: this machine has owned a real server here.
    pub seen_before: bool,
    /// A FOREIGN process ANSWERED a complete non-Topics HTTP response on
    /// `:3333`. Proof of a stranger, never of a silence: a Topics that is merely
    /// slow times out and is NOT foreign (see `probe_topics_shape`).
    pub primary_foreign: bool,
    /// The pid recorded in `daemon-state.json` is a LIVE process. This is the
    /// only fact that survives a squatter: the daemon may be unreachable on the
    /// address we probed and still be running, and a running daemon is a full
    /// universe that a sidecar would silently replace.
    pub state_pid_alive: bool,
}

/// Where the shell should point the proxy, decided from the probe outcomes + the
/// daemon-state port + the external-server marker.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum BootChoice {
    /// A Topics daemon is serving on `:port`. Defer to it; never spawn a sidecar.
    /// `tls` is whatever the probe that MATCHED used, on the canonical port and
    /// on the daemon-state port alike: a squatter-recovery daemon inherits the
    /// configuration of the machine it runs on, so on a TLS box it answers TLS on
    /// its ephemeral port too. Assuming plain HTTP there sent a TLS machine to
    /// SpawnSidecar: an empty universe with the real data next door.
    Defer { host: Loopback, port: u16, tls: bool },
    /// No Topics daemon answered, but the marker says this machine owns a real
    /// server. Keep pointing at :3333 and wait: forking an empty universe here is
    /// strictly worse (the 2026-08-13 incident).
    WaitForKnownServer { host: Loopback },
    /// No Topics daemon answered and nothing was ever here. Spawn the bundled
    /// sidecar.
    SpawnSidecar,
}

/// HOW LONG THE SHELL WAITS BEFORE IT BELIEVES THERE IS NO DAEMON, counted in
/// rounds of the boot loop (one round is a probe plus a 700ms pause, so this is
/// about seven seconds).
///
/// Not a comfort margin: a starting server is genuinely invisible for a while.
/// It opens its database before it takes its lock and binds its port after, so
/// between launch and the first trace of it on disk there is a window measured at
/// 0.36s to 1.36s on a warm Mac (2026-09-14). Concede the port to a stranger
/// inside that window and the app opens an empty universe beside a production
/// that was two seconds from being ready. Waiting seven seconds costs a person
/// seven seconds; not waiting costs them their topics.
pub(crate) const ROUNDS_ALONE_BEFORE_CONCEDING: u32 = 10;

/// May the shell stop waiting, having found a stranger on the port and no daemon
/// of ours for `rounds_alone` consecutive rounds?
pub(crate) fn may_concede_the_port(rounds_alone: u32) -> bool {
    rounds_alone >= ROUNDS_ALONE_BEFORE_CONCEDING
}

/// The boot rule itself, made PURE so it is provable without sockets or a tauri
/// app: given what the probes found (`BootFacts`), decide where the proxy points.
///
/// Decision order, most-to-least trusted:
///   1. A Topics daemon on the daemon-state port: defer to THAT address and port,
///      with the scheme that actually answered there.
///   2. A Topics daemon on :3333: defer to the address that answered.
///   3. The daemon-state pid is ALIVE: wait for it. Never a sidecar.
///   4. Marker present and no foreign answer on :3333: wait.
///   5. Otherwise: spawn the sidecar.
pub(crate) fn decide_boot(f: BootFacts) -> BootChoice {
    // A daemon recorded in daemon-state.json, confirmed by shape on that port, is
    // the one we want, even if :3333 is squatted (the 2026-09-12 case). A state
    // port of 0 (a corrupt/zero port) is not a usable target: fall through.
    if f.state_topics {
        if let Some(p) = f.state_port {
            if p != 0 {
                return BootChoice::Defer { host: f.state_host, port: p, tls: f.state_tls };
            }
        }
    }
    // A daemon on the canonical port (the normal case). TLS only if the TLS probe
    // is what matched: a plain-HTTP dev server on :3333 defers without TLS.
    if f.primary_topics {
        return BootChoice::Defer { host: f.primary_host, port: 3333, tls: f.primary_tls };
    }
    // WHERE TO WAIT, when waiting is the answer. A stranger answering on IPv4
    // does not evict our daemon from `[::]:3333`: the two bindings coexist, so
    // the address still worth waiting on is the one the stranger cannot hold.
    let wait_host = if f.primary_foreign { Loopback::V6 } else { Loopback::V4 };
    // THE PROOF THAT OUTRANKS EVERY PROBE (the 2026-09-14 reproduction). The
    // daemon writes its pid next to its port, and that pid is alive: there IS a
    // full universe running on this machine right now. Whatever the probes could
    // not reach, a sidecar here would open a SECOND, empty one beside it and the
    // person would find their topics gone. A live pid means wait, always.
    if f.state_pid_alive {
        return BootChoice::WaitForKnownServer { host: wait_host };
    }
    // No Topics daemon answered and no daemon process is alive. The marker says
    // this machine owns a real server, so the 2026-08-13 invariant holds: WAIT
    // for it, never fork an empty universe. EXCEPT when a FOREIGN process is
    // actively serving :3333 AND no daemon of ours is running: the real server is
    // not coming back by itself, so waiting hangs the app on a foreign dashboard.
    if f.seen_before && !f.primary_foreign {
        BootChoice::WaitForKnownServer { host: wait_host }
    } else {
        BootChoice::SpawnSidecar
    }
}

#[cfg(test)]
mod tests {
    use super::{decide_boot, BootChoice, BootFacts, Loopback};

    /// THE 2026-09-12 REGRESSION GUARD. A squatter holds :3333 (no Topics shape
    /// there), but the daemon recovered onto an ephemeral port recorded in
    /// daemon-state.json and answers by shape there. Defer to the daemon's REAL
    /// port, not the squatter.
    #[test]
    fn squatted_3333_defers_to_the_daemon_real_port() {
        let choice = decide_boot(BootFacts {
            state_topics: true,
            state_port: Some(55655),
            seen_before: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V4, port: 55655, tls: false }
        );
    }

    /// The normal case: a Topics daemon on :3333 via TLS.
    #[test]
    fn a_topics_daemon_on_3333_defers_with_tls() {
        let choice = decide_boot(BootFacts {
            primary_topics: true,
            primary_tls: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V4, port: 3333, tls: true }
        );
    }

    /// A plain-HTTP dev server on :3333 defers WITHOUT TLS.
    #[test]
    fn a_plain_dev_server_on_3333_defers_without_tls() {
        let choice = decide_boot(BootFacts { primary_topics: true, ..Default::default() });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V4, port: 3333, tls: false }
        );
    }

    /// THE MAC CASE, reproduced on 2026-09-14 and red before this rule existed.
    /// An IPv4 squatter holds 127.0.0.1:3333; production is alive on `[::]:3333`
    /// and answers the shape probe over IPv6. The shell must talk to IPv6, and
    /// the port it defers to is still the canonical one.
    #[test]
    fn production_answering_on_ipv6_is_deferred_to_there() {
        let choice = decide_boot(BootFacts {
            primary_topics: true,
            primary_host: Loopback::V6,
            primary_tls: true,
            seen_before: true,
            primary_foreign: true,
            state_pid_alive: true,
            state_port: Some(3333),
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V6, port: 3333, tls: true }
        );
    }

    /// THE DEFECT THE 2026-09-14 REVIEW REPRODUCED, and the reason this rule
    /// gained `state_pid_alive`. Mac, marker present, state port 3333, an IPv4
    /// squatter answering HTML there, and NO probe of ours got through (slow
    /// server, wrong address, TLS mismatch: it does not matter which). The
    /// daemon's own pid is alive, so a full universe is running: spawning a
    /// sidecar here opens an empty second one beside it. Wait, on IPv6, where
    /// the squatter cannot be. With the previous rule this input returned
    /// SpawnSidecar.
    #[test]
    fn a_live_daemon_pid_forbids_the_sidecar_even_behind_a_squatter() {
        let choice = decide_boot(BootFacts {
            state_port: Some(3333),
            seen_before: true,
            primary_foreign: true,
            state_pid_alive: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::WaitForKnownServer { host: Loopback::V6 }
        );
    }

    /// A daemon on BOTH the state port and :3333: the state port wins.
    #[test]
    fn state_port_wins_over_primary() {
        let choice = decide_boot(BootFacts {
            primary_topics: true,
            primary_tls: true,
            state_topics: true,
            state_port: Some(40000),
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V4, port: 40000, tls: false }
        );
    }

    /// A squatter on :3333, no daemon anywhere, no daemon process alive, virgin
    /// machine: spawn the sidecar (never defer to an HTML dashboard).
    #[test]
    fn squatter_on_3333_virgin_spawns_sidecar() {
        let choice = decide_boot(BootFacts { primary_foreign: true, ..Default::default() });
        assert_eq!(choice, BootChoice::SpawnSidecar);
    }

    /// THE 2026-08-13 INVARIANT, restored after this test was deleted on the
    /// first pass of this branch. A server that is alive but too SLOW to answer
    /// inside the probe window looks like silence, not like a stranger: nothing
    /// foreign answered, the marker is present, so the shell WAITS. Replacing a
    /// slow server with an empty sidecar is the incident this whole file exists
    /// for, and it cost a person every topic they had.
    #[test]
    fn a_slow_but_live_server_is_waited_for_never_replaced() {
        let choice = decide_boot(BootFacts {
            state_port: Some(3333),
            seen_before: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::WaitForKnownServer { host: Loopback::V4 }
        );
    }

    /// A genuine server that is merely DOWN (connection refused, nothing
    /// foreign answering) with the marker present: wait, never fork.
    #[test]
    fn server_down_with_marker_still_waits() {
        let choice = decide_boot(BootFacts {
            state_port: Some(3333),
            seen_before: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::WaitForKnownServer { host: Loopback::V4 }
        );
    }

    /// The marker is only consulted when no daemon answered: a live daemon
    /// always beats a stale marker.
    #[test]
    fn a_live_daemon_beats_a_stale_marker() {
        let choice = decide_boot(BootFacts {
            primary_topics: true,
            primary_tls: true,
            seen_before: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V4, port: 3333, tls: true }
        );
    }

    /// A state port of 0 is not a usable target: no Defer to :0.
    #[test]
    fn a_zero_state_port_is_not_deferred_to() {
        let choice = decide_boot(BootFacts {
            state_topics: true,
            state_port: Some(0),
            primary_foreign: true,
            ..Default::default()
        });
        assert_eq!(choice, BootChoice::SpawnSidecar);
    }

    /// THE WINDOWS CASE OF 2026-09-13, and the one the pid rule must not break:
    /// the dev server that wrote the marker is GONE (its recorded pid is dead)
    /// and the account-switcher dashboard answers on :3333. There is no universe
    /// to protect, so the sidecar starts instead of the app hanging forever on a
    /// foreign dashboard.
    #[test]
    fn contaminated_marker_does_not_wait_on_a_foreign_squatter() {
        let choice = decide_boot(BootFacts {
            state_port: Some(3333),
            seen_before: true,
            primary_foreign: true,
            ..Default::default()
        });
        assert_eq!(choice, BootChoice::SpawnSidecar);
    }

    /// A TLS machine: the daemon recovered onto an ephemeral port and serves TLS
    /// there like everywhere else. Defer to that port WITH TLS. With the old
    /// fixed `tls: false` the probe never matched and the person got an empty
    /// universe one port away.
    #[test]
    fn a_tls_daemon_on_the_state_port_is_deferred_to_over_tls() {
        let choice = decide_boot(BootFacts {
            state_topics: true,
            state_tls: true,
            state_port: Some(55655),
            seen_before: true,
            primary_foreign: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V4, port: 55655, tls: true }
        );
    }

    /// The same machine, plain HTTP: the scheme deferred to is the one that
    /// ANSWERED, never a constant. Both directions are asserted so that pinning
    /// either value again breaks a test.
    #[test]
    fn a_plain_daemon_on_the_state_port_is_deferred_to_without_tls() {
        let choice = decide_boot(BootFacts {
            state_topics: true,
            state_port: Some(55655),
            seen_before: true,
            primary_foreign: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V4, port: 55655, tls: false }
        );
    }

    /// A TLS daemon on the state port beats a foreign squatter on :3333 even
    /// without the marker: finding the real daemon is never conditional on it.
    #[test]
    fn a_tls_state_daemon_beats_a_squatter_without_a_marker() {
        let choice = decide_boot(BootFacts {
            state_topics: true,
            state_tls: true,
            state_port: Some(49152),
            primary_foreign: true,
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V4, port: 49152, tls: true }
        );
    }

    /// The daemon answers by shape on its ephemeral port over IPv6: the address
    /// that answered is the address deferred to, on the state port as well.
    #[test]
    fn the_state_port_defers_to_the_address_that_answered() {
        let choice = decide_boot(BootFacts {
            state_topics: true,
            state_host: Loopback::V6,
            state_tls: true,
            state_port: Some(49152),
            ..Default::default()
        });
        assert_eq!(
            choice,
            BootChoice::Defer { host: Loopback::V6, port: 49152, tls: true }
        );
    }
}
