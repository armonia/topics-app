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
//! TWO PIECES, and the second one moved here on 2026-09-14: `decide_boot`, which
//! turns findings into a choice, and `discover_upstream`, the loop that gathers
//! the findings. The loop lived inline in `decide_upstream_and_spawn`, where
//! nothing could reach it: cutting the link between its patience and its early
//! exit left every test green, which is how we learned the loop was untested. Its
//! sockets, its files and its pause are parameters now, so a test can hand it a
//! restarting server and watch what it decides.
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
use crate::DEFAULT_UPSTREAM_PORT;

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

/// WHAT ONE PROBE FOUND, and the whole point is that it has THREE answers, not
/// two. The shell used to ask "is Topics there?" with the shape probe and "is a
/// stranger there?" with a different, cheaper route (`/__daemon/healthz`, which
/// answers before authentication in 2 ms). A Topics under load then failed the
/// first question and PASSED the second: slow, therefore foreign, therefore
/// replaced by an empty sidecar. That was the 2026-08-13 incident, and one probe
/// answering both questions is what makes it unrepresentable.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum ShapeVerdict {
    /// A Topics daemon answered with its presence shape.
    Topics,
    /// Somebody else answered: a complete, successful HTTP response that is not
    /// ours. The only proof of a stranger this code accepts.
    Foreign,
    /// Nobody answered in time, or the answer said nothing about who is there.
    /// A slow Topics lands here, and silence is never a stranger.
    NoAnswer,
}

/// What a port answered, and over WHICH scheme it answered it. The scheme is
/// half the answer: deferring to a TLS daemon in plain HTTP reaches nobody.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) struct PortAnswer {
    pub verdict: ShapeVerdict,
    pub tls: bool,
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
    ///
    /// This is also where the liveness rule's blind spot lands. A pid the OS
    /// recycled inside the clock tolerance reads as a live daemon, and the shell
    /// then waits here for a server that died hours ago: not a few seconds, the
    /// rest of the session on "Connecting" (2026-09-13). Deliberate, and the
    /// reconnect page names the marker to delete, because the other way round
    /// costs a person their topics instead of their patience.
    WaitForKnownServer { host: Loopback },
    /// No Topics daemon answered and nothing was ever here. Spawn the bundled
    /// sidecar.
    SpawnSidecar,
}

/// HOW LONG THE SHELL WAITS BEFORE IT BELIEVES THERE IS NO DAEMON.
///
/// A DURATION, and it was a count of rounds until 2026-09-14. The rounds were
/// the same number everywhere and the seconds were not: a round is probes plus a
/// 700ms pause, which is ~0.7s on this Mac and 0.9s to 1.7s on the Windows box,
/// where a refused connection alone costs ~0.83s. Ten rounds therefore meant
/// seven seconds here and fifteen to twenty-three there, on exactly the machine
/// this card is about. What the shell is waiting for is a server to appear, and
/// that is measured in time, so the patience is measured in time too.
///
/// Not a comfort margin: a starting server is genuinely invisible for a while.
/// It opens its database before it takes its lock and binds its port after, so
/// between launch and the first trace of it on disk there is a window measured at
/// 0.36s to 1.36s on a warm Mac (2026-09-14). Seen from the shell the window is
/// longer still, because `start-prod.sh` sleeps a second before relaunching:
/// 1.4s to 2.4s from the old process exiting to the new one taking its lock.
/// Concede the port to a stranger inside that window and the app opens an empty
/// universe beside a production that was two seconds from being ready. Waiting
/// seven seconds costs a person seven seconds; not waiting costs them their
/// topics.
pub(crate) const ALONE_BEFORE_CONCEDING: std::time::Duration = std::time::Duration::from_secs(7);

/// May the shell stop waiting, having found a stranger on the port and no daemon
/// of ours for this long without interruption?
pub(crate) fn may_concede_the_port(
    alone: std::time::Duration,
    window: std::time::Duration,
) -> bool {
    alone >= window
}

/// THE DISCOVERY LOOP, with its probes and its disk handed in.
///
/// It was inline in `decide_upstream_and_spawn` until 2026-09-14, which meant the
/// only things a test could reach were the pure verdict at the end and the probe
/// at the start; the loop between them, where the shell decides how long to wait
/// and what to re-read, was covered by nothing. Deleting the link between the
/// patience window and the early exit left all 26 tests green, which is another
/// way of saying they were not testing this. So the sockets, the files and the
/// clock come in as arguments and what stays here is the rule:
///
///   * every round re-reads the daemon's record from disk, because the reason
///     this loop lasts a minute is that the server may be RESTARTING, and a
///     restart is exactly when the recorded port changes (four restarts on four
///     different ports in one night, 2026-09-13). Reading it once before the loop
///     meant probing a dead port for 42s and then spawning a sidecar beside a
///     server that had been up for forty of them;
///   * any TOPICS answer, on either address, on either port, ends the loop at
///     once: that is the whole thing we were looking for;
///   * a STRANGER on the canonical port with no daemon of ours anywhere ends the
///     loop only once it has held for `alone_before_conceding` WITHOUT
///     interruption. One round that finds our daemon resets the clock.
///
/// WHAT ONE ROUND COSTS, because it runs while somebody stares at a blank window.
/// On the Mac a refused connection comes back instantly; on Windows it costs
/// ~0.83s (measured 2026-08-28, the 141s boot of commit 3a2f8d7e1), so a probe
/// that cannot possibly find anything is a second of somebody's morning. Hence
/// two economies, and they are why a round costs the two connections it cost
/// before this code knew about IPv6: `probe` opens ONE connection to conclude
/// nobody is listening, and IPv6 is only probed where IPv4 found a STRANGER,
/// which is the only shape in which our daemon can hide (it binds `[::]`, which
/// answers 127.0.0.1 as well, unless somebody else holds the v4 address).
/// Worst case per round on Windows: 2 refused connections, ~1.7s.
pub(crate) async fn discover_upstream<P, PF, R, N, NF>(
    seen_before: bool,
    attempts: u32,
    alone_before_conceding: std::time::Duration,
    probe: P,
    read_daemon_record: R,
    pause: N,
) -> BootFacts
where
    P: Fn(Loopback, u16) -> PF,
    PF: std::future::Future<Output = PortAnswer>,
    R: Fn() -> (Option<u16>, bool),
    N: Fn() -> NF,
    NF: std::future::Future<Output = ()>,
{
    // WHAT ONE ROUND COSTS, because this loop runs on a machine where the
    // person is staring at a blank window. On the Mac a refused connection comes
    // back instantly; on Windows it costs ~0.83s (measured 2026-08-28, the 141s
    // boot of commit 3a2f8d7e1), so every probe that cannot possibly find
    // anything is a second of somebody's morning. Hence two economies, and they
    // are the reason the round stays at the two connections it had before IPv6
    // existed in this code:
    //   * `probe_port` opens ONE connection to decide there is no listener, and
    //     does not then repeat the whole thing in the other scheme;
    //   * IPv6 is only probed where IPv4 found a STRANGER. That is the only
    //     shape in which our daemon can hide from IPv4: it binds `[::]`, which
    //     answers 127.0.0.1 too, unless somebody else holds the v4 address.
    //     Where IPv4 found silence, IPv6 has nothing to add and would cost
    //     0.83s a round for it.
    // Worst case per round on Windows: 2 refused connections, ~1.7s, the same as
    // before this branch.
    let mut facts = BootFacts { seen_before, ..Default::default() };
    let mut alone_since: Option<std::time::Instant> = None;
    'rounds: for round in 0..attempts {
        // THE STATE PORT IS RE-READ EVERY ROUND, and it has to be: the whole
        // reason this loop lasts 42 seconds is that the server may be RESTARTING,
        // and a restart is exactly when the daemon writes a new port into
        // daemon-state.json (four restarts on four different ports in one night,
        // 2026-09-13). Reading it once before the loop meant probing a dead port
        // for the full 42s and then spawning a sidecar next to a server that had
        // been up for forty of them. Both re-reads are file reads: no socket, no
        // second of anybody's morning.
        let (state_port, pid_alive) = read_daemon_record();
        facts.state_port = state_port;
        facts.state_pid_alive = pid_alive;

        let answer = probe(Loopback::V4, DEFAULT_UPSTREAM_PORT).await;
        match answer.verdict {
            ShapeVerdict::Topics => {
                facts.primary_topics = true;
                facts.primary_host = Loopback::V4;
                facts.primary_tls = answer.tls;
                break 'rounds;
            }
            ShapeVerdict::Foreign => {
                facts.primary_foreign = true;
                // A stranger on IPv4 is the one case where our daemon may still
                // be answering on IPv6 behind it (reproduced 2026-09-14).
                let behind = probe(Loopback::V6, DEFAULT_UPSTREAM_PORT).await;
                if behind.verdict == ShapeVerdict::Topics {
                    facts.primary_topics = true;
                    facts.primary_host = Loopback::V6;
                    facts.primary_tls = behind.tls;
                    break 'rounds;
                }
            }
            ShapeVerdict::NoAnswer => {}
        }

        if let Some(sp) = facts.state_port {
            if sp != 0 && sp != DEFAULT_UPSTREAM_PORT {
                let on_state = probe(Loopback::V4, sp).await;
                match on_state.verdict {
                    ShapeVerdict::Topics => {
                        facts.state_topics = true;
                        facts.state_host = Loopback::V4;
                        facts.state_tls = on_state.tls;
                        break 'rounds;
                    }
                    ShapeVerdict::Foreign => {
                        let behind = probe(Loopback::V6, sp).await;
                        if behind.verdict == ShapeVerdict::Topics {
                            facts.state_topics = true;
                            facts.state_host = Loopback::V6;
                            facts.state_tls = behind.tls;
                            break 'rounds;
                        }
                    }
                    ShapeVerdict::NoAnswer => {}
                }
            }
        }

        // NOTHING LEFT TO WAIT FOR, once we are sure of it. A stranger serves the
        // canonical port, no daemon of ours answered anywhere, and no daemon
        // process is recorded on this machine: sixty more seconds of that change
        // nothing, and the person spends them looking at "Connecting"
        // (2026-09-13). But "no daemon process" is not trustworthy on the FIRST
        // round: a production that is restarting (and the watcher restarts it
        // often) has neither file for up to ~1.4s after launch, so an early exit
        // there hands the window to the stranger 5ms before the real server takes
        // its lock (measured 2026-09-14). The absence has to hold.
        if facts.primary_foreign && !facts.state_pid_alive {
            let since = *alone_since.get_or_insert_with(std::time::Instant::now);
            if may_concede_the_port(since.elapsed(), alone_before_conceding) {
                break 'rounds;
            }
        } else {
            alone_since = None;
        }

        if round + 1 < attempts {
            pause().await;
        }
    }

    facts
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
    use super::{
        decide_boot, discover_upstream, may_concede_the_port, BootChoice, BootFacts, Loopback,
        PortAnswer, ShapeVerdict, ALONE_BEFORE_CONCEDING,
    };
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};

    /// A current-thread runtime for the loop tests (the crate's tokio has no
    /// `macros` feature, so there is no `#[tokio::test]`).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    fn foreign() -> PortAnswer {
        PortAnswer { verdict: ShapeVerdict::Foreign, tls: false }
    }

    /// The patience is a length of time, so the test that proves it can choose a
    /// shorter one. These keep the shape of the measurement (a lock that lands
    /// about a third of the way into the window, rounds several times shorter than
    /// the window) without spending seven seconds of everybody's test run.
    const TEST_WINDOW: Duration = Duration::from_millis(700);
    const TEST_LOCK_ARRIVES: Duration = Duration::from_millis(250);
    const TEST_ROUND: Duration = Duration::from_millis(100);

    /// THE RESTART WINDOW, played out against the real loop. A production that is
    /// coming back up (and the watcher restarts it often) leaves no lock and no
    /// state file for the first second or so, while a stranger already holds the
    /// port. Deciding on the first round reads that as "a stranger and nobody of
    /// ours" and forks an empty universe 5ms before the real server takes its lock
    /// (measured 2026-09-14). The shell has to still be waiting when it appears.
    ///
    /// Red if the early exit goes back to conceding on round 0.
    #[test]
    fn a_production_still_starting_is_never_replaced_by_a_sidecar() {
        let started = Instant::now();
        let facts = rt().block_on(discover_upstream(
            true,
            60,
            TEST_WINDOW,
            |_, _| async { foreign() },
            // No lock, no state file, until the production takes its lock.
            move || (None, started.elapsed() >= TEST_LOCK_ARRIVES),
            || tokio::time::sleep(TEST_ROUND),
        ));
        assert!(facts.state_pid_alive, "the lock appeared and the loop must have re-read it");
        assert_ne!(
            decide_boot(facts),
            BootChoice::SpawnSidecar,
            "the shell forked a sidecar while the production was still starting"
        );
    }

    /// The window measures an UNINTERRUPTED absence. A daemon that is seen, then
    /// missed for a round (a lock rewritten, a file read that lost a race), then
    /// seen again, has never been absent for the length of the window: the clock
    /// restarts every time it answers.
    #[test]
    fn one_round_that_finds_the_daemon_restarts_the_clock() {
        let round = AtomicU32::new(0);
        let _ = rt().block_on(discover_upstream(
            true,
            12,
            TEST_WINDOW,
            |_, _| async { foreign() },
            // Alive, absent, alive, then absent for good.
            || {
                let n = round.fetch_add(1, Ordering::Relaxed);
                (None, n == 0 || n == 2)
            },
            || tokio::time::sleep(TEST_ROUND),
        ));
        let rounds = round.load(Ordering::Relaxed);
        assert!(
            rounds > TEST_WINDOW.div_duration_f64(TEST_ROUND) as u32,
            "the loop conceded after {rounds} rounds, so an interrupted absence was counted as one"
        );
        assert!(rounds < 12, "and it did concede once the absence finally held");
    }

    /// A TOPICS ANSWER ENDS THE LOOP AT ONCE, on the address that answered. There
    /// is nothing left to wait for and nothing to decide.
    #[test]
    fn a_daemon_hiding_behind_a_stranger_on_ipv6_ends_the_loop() {
        let rounds = AtomicU32::new(0);
        let facts = rt().block_on(discover_upstream(
            true,
            60,
            TEST_WINDOW,
            |host, _| async move {
                match host {
                    Loopback::V4 => foreign(),
                    Loopback::V6 => PortAnswer { verdict: ShapeVerdict::Topics, tls: true },
                }
            },
            || {
                rounds.fetch_add(1, Ordering::Relaxed);
                (None, false)
            },
            || tokio::time::sleep(TEST_ROUND),
        ));
        assert_eq!(rounds.load(Ordering::Relaxed), 1, "it kept probing after finding the daemon");
        assert_eq!(
            decide_boot(facts),
            BootChoice::Defer { host: Loopback::V6, port: super::DEFAULT_UPSTREAM_PORT, tls: true }
        );
    }

    /// THE PORT IS RE-READ EVERY ROUND. A restart is exactly when the daemon
    /// records a new one (four restarts on four different ports in one night,
    /// 2026-09-13), so a loop that read it once probed a dead port for 42s and
    /// then spawned a sidecar beside a server that had been up for forty of them.
    #[test]
    fn the_recorded_port_is_read_again_every_round() {
        let round = AtomicU32::new(0);
        let facts = rt().block_on(discover_upstream(
            true,
            60,
            TEST_WINDOW,
            |_, port| async move {
                if port == 55655 {
                    PortAnswer { verdict: ShapeVerdict::Topics, tls: true }
                } else {
                    PortAnswer { verdict: ShapeVerdict::NoAnswer, tls: false }
                }
            },
            // The old port first, the one the restart wrote from the third round on.
            || {
                let n = round.fetch_add(1, Ordering::Relaxed);
                (Some(if n < 2 { 44444 } else { 55655 }), true)
            },
            || tokio::time::sleep(TEST_ROUND),
        ));
        assert_eq!(
            decide_boot(facts),
            BootChoice::Defer { host: Loopback::V4, port: 55655, tls: true }
        );
    }

    /// The patience, as a number. Seven seconds is not a round figure: the shell
    /// sees a restarting production disappear for 1.4s to 2.4s (the measurement of
    /// 2026-09-14, which includes the `sleep 1` in `start-prod.sh`), and this has
    /// to cover that with room left over. Shrink it below three seconds and the
    /// empty universe of 2026-09-13 comes back.
    #[test]
    fn the_patience_covers_the_measured_restart_window() {
        assert!(ALONE_BEFORE_CONCEDING >= Duration::from_secs(3));
        assert!(!may_concede_the_port(Duration::from_millis(2_400), ALONE_BEFORE_CONCEDING));
        assert!(may_concede_the_port(ALONE_BEFORE_CONCEDING, ALONE_BEFORE_CONCEDING));
    }

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
