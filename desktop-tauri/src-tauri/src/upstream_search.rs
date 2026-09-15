//! THE SEARCH: how long the shell looks for a daemon before it decides there is
//! none, and what it re-reads while it looks.
//!
//! Split from `boot_choice.rs` on 2026-09-14, when that file crossed the size
//! gate, and the seam was already there: `decide_boot` is a verdict on findings,
//! this is the gathering of them. The loop lived inline in
//! `decide_upstream_and_spawn` until the day before, where nothing could reach
//! it; its sockets, its files and its pause are parameters now, so a test can
//! hand it a restarting server and watch what it decides.

use crate::boot_choice::{BootFacts, Loopback, PortAnswer, ShapeVerdict};
use crate::DEFAULT_UPSTREAM_PORT;

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

/// The pause between two rounds. Named here because the budgets below are only
/// meaningful next to it.
pub(crate) const ROUND_PAUSE: std::time::Duration = std::time::Duration::from_millis(700);

/// HOW LONG THE WHOLE SEARCH LASTS, and this too was a count of rounds until
/// 2026-09-14: 60 of them with the marker, 8 without.
///
/// The eight were the bug. Eight rounds run out after ~4.9s on this Mac, which is
/// BEFORE `ALONE_BEFORE_CONCEDING`, so on a machine with no marker the patience
/// above never got to fire at all: the loop simply ran out of rounds and the
/// sidecar started. A production that took its lock at 5.5s lost the port to a
/// sidecar without the marker, while the same production kept it with one
/// (measured 2026-09-14). A budget that expires before the rule it exists to run
/// is not a budget, it is a second rule nobody wrote down.
///
/// So both are durations, and the short one is the window plus a full round, so
/// that the last round of the search is still one the patience can act on.
pub(crate) const SEARCH_WITH_MARKER: std::time::Duration = std::time::Duration::from_secs(42);
/// One round is probes plus `ROUND_PAUSE`: up to ~1.7s of probes on the Windows
/// box, so 2.4s buys the slowest round we have measured.
pub(crate) const SEARCH_WITHOUT_MARKER: std::time::Duration =
    ALONE_BEFORE_CONCEDING.saturating_add(std::time::Duration::from_millis(2_400));

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
    budget: std::time::Duration,
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
    let searching_since = std::time::Instant::now();
    'rounds: loop {
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

        // The budget is spent in time, so that a round costing 1.7s on Windows
        // and 0.2s here buy the same amount of waiting. Always at least one
        // round: a budget shorter than a round still asks the question once.
        if searching_since.elapsed() >= budget {
            break 'rounds;
        }
        pause().await;
    }

    facts
}

#[cfg(test)]
mod tests {
    use super::{
        discover_upstream, may_concede_the_port, ALONE_BEFORE_CONCEDING, ROUND_PAUSE,
        SEARCH_WITHOUT_MARKER, SEARCH_WITH_MARKER,
    };
    use crate::boot_choice::{decide_boot, BootChoice, Loopback, PortAnswer, ShapeVerdict};
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
    /// Long enough that the WINDOW is what ends these loops, never the budget.
    const TEST_BUDGET: Duration = Duration::from_secs(3);

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
            TEST_BUDGET,
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
    ///
    /// ASSERTED IN TIME, not in rounds, and the first version of this test was
    /// wrong about that: it counted rounds, and dropping the reset still left
    /// enough of them to pass (the original conceded on round 11, the mutant on
    /// round 9, both above the bar it checked). What the reset changes is not how
    /// many rounds run but WHEN the loop gives up relative to the last sighting,
    /// so that is what is measured. Red without `alone_since = None`, which
    /// concedes ~400ms after the daemon was last alive.
    #[test]
    fn one_round_that_finds_the_daemon_restarts_the_clock() {
        let round = AtomicU32::new(0);
        let last_alive = std::sync::Mutex::new(Instant::now());
        let _ = rt().block_on(discover_upstream(
            true,
            TEST_BUDGET,
            TEST_WINDOW,
            |_, _| async { foreign() },
            // Alive, absent, alive, then absent for good.
            || {
                let n = round.fetch_add(1, Ordering::Relaxed);
                let alive = n == 0 || n == 2;
                if alive {
                    *last_alive.lock().unwrap() = Instant::now();
                }
                (None, alive)
            },
            || tokio::time::sleep(TEST_ROUND),
        ));
        let since_last_alive = last_alive.lock().unwrap().elapsed();
        assert!(
            since_last_alive >= TEST_WINDOW,
            "conceded {since_last_alive:?} after the daemon was last seen, less than the window: \
             an interrupted absence was counted as one"
        );
        assert!(round.load(Ordering::Relaxed) < 25, "and it did concede once the absence held");
    }

    /// A MACHINE WITH NO MARKER GETS THE SAME PATIENCE AS ONE WITH IT, for the
    /// seconds that matter. The search used to stop after 8 rounds there, ~4.9s
    /// on this Mac, which expires BEFORE `ALONE_BEFORE_CONCEDING`: the patience
    /// never ran, and a production taking its lock at 5.5s lost the port to a
    /// sidecar it would have kept with a marker present (measured 2026-09-14).
    ///
    /// Red if the short budget drops back under the window.
    #[test]
    fn the_search_without_a_marker_outlives_the_patience_it_has_to_run() {
        assert!(
            SEARCH_WITHOUT_MARKER >= ALONE_BEFORE_CONCEDING + ROUND_PAUSE,
            "the search gives up before the waiting rule can fire, so the rule is dead code"
        );
        assert!(SEARCH_WITH_MARKER > SEARCH_WITHOUT_MARKER);
    }

    /// And the same restart, played out against the loop with no marker: a
    /// production that appears a third of the way into the window keeps its port.
    #[test]
    fn a_first_ever_launch_still_waits_out_a_restarting_production() {
        let started = Instant::now();
        let facts = rt().block_on(discover_upstream(
            false,
            TEST_WINDOW + TEST_ROUND * 4,
            TEST_WINDOW,
            |_, _| async { foreign() },
            move || (None, started.elapsed() >= TEST_LOCK_ARRIVES),
            || tokio::time::sleep(TEST_ROUND),
        ));
        assert!(facts.state_pid_alive, "the budget ran out before the production could appear");
        assert_ne!(decide_boot(facts), BootChoice::SpawnSidecar);
    }

    /// THE BUDGET IS SPENT IN TIME, NOT IN ROUNDS, and this is the test that
    /// notices if it goes back to counting them (board card c0faad1d). The pair
    /// above proves the patience outlives the budget as two constants; nothing
    /// proved it inside the loop, so `round_n >= if seen_before { 60 } else { 8 }`
    /// with the budget ignored left all seven tests green.
    ///
    /// The shape is the measurement, scaled down: rounds several times shorter
    /// than the window, and a production that takes its lock after eight of them.
    /// Counting rounds gives up at 400ms and reports no daemon; spending 1.1s of
    /// budget is still there at 550ms, when the lock appears.
    #[test]
    fn the_budget_is_a_length_of_time_and_not_a_number_of_rounds() {
        let started = Instant::now();
        let facts = rt().block_on(discover_upstream(
            false,
            TEST_WINDOW + TEST_ROUND * 4,
            TEST_WINDOW,
            |_, _| async { foreign() },
            move || (None, started.elapsed() >= Duration::from_millis(550)),
            || tokio::time::sleep(Duration::from_millis(50)),
        ));
        assert!(
            facts.state_pid_alive,
            "the search ended before the budget was spent: it is counting rounds again"
        );
    }

    /// A TOPICS ANSWER ENDS THE LOOP AT ONCE, on the address that answered. There
    /// is nothing left to wait for and nothing to decide.
    #[test]
    fn a_daemon_hiding_behind_a_stranger_on_ipv6_ends_the_loop() {
        let rounds = AtomicU32::new(0);
        let facts = rt().block_on(discover_upstream(
            true,
            TEST_BUDGET,
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
            TEST_BUDGET,
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
}
