//! The boot RULE, separated from the boot EFFECTS: what the shell concludes from
//! probing :3333, with none of the doing (writing the marker, setting `UPSTREAM`,
//! spawning a process). The effects stay in `decide_upstream_and_spawn`.
//!
//! Its own file, like `reconnect_page.rs` next door, for two reasons: `lib.rs` has
//! no room left, and this rule is the one piece of the shell that must be provable
//! without a tauri app, a real server or 42 seconds of waiting. Pure and
//! platform-independent, so every OS compiles and tests it.

/// What the boot probe concluded.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum BootChoice {
    /// An external server answered on :3333. Defer to it, never spawn a sidecar.
    Defer { tls: bool },
    /// Nobody answered, but the marker says this machine owns a real server. Keep
    /// pointing at :3333 and wait: forking an empty universe here is worse.
    WaitForKnownServer,
    /// Nobody answered and nothing was ever here. Spawn the bundled sidecar.
    SpawnSidecar,
}

/// The boot rule itself. `probe(tls)` answers "is a Topics server listening", `gap`
/// is the pause between rounds (a parameter only so tests do not sleep).
///
/// A machine that has ALREADY had a real server here is never a virgin machine, so
/// it waits far longer (60 rounds, ~42s) and, past that, gets NO sidecar. A slow
/// server that answers on the fiftieth round is still deferred to, which is the
/// whole point of the long wait: see the 2026-08-13 note in the caller.
pub(crate) async fn decide_boot<P, F>(
    seen_before: bool,
    gap: std::time::Duration,
    mut probe: P,
) -> BootChoice
where
    P: FnMut(bool) -> F,
    F: std::future::Future<Output = bool>,
{
    let attempts: u32 = if seen_before { 60 } else { 8 };
    for attempt in 0..attempts {
        if probe(true).await {
            return BootChoice::Defer { tls: true };
        }
        if probe(false).await {
            return BootChoice::Defer { tls: false };
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(gap).await;
        }
    }
    if seen_before {
        BootChoice::WaitForKnownServer
    } else {
        BootChoice::SpawnSidecar
    }
}

#[cfg(test)]
mod tests {
    use super::{decide_boot, BootChoice};
    use std::time::Duration;

    /// A current-thread runtime (the crate's tokio has no `macros` feature, so
    /// there is no `#[tokio::test]`).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// THE 2026-08-13 REGRESSION GUARD. Marker present and the server SLOW but alive
    /// (it answers only on the fiftieth round): the shell must keep waiting and defer
    /// to it. Spawning a sidecar here is what once forked an empty universe and lost
    /// the user every task, tab and even the version number.
    #[test]
    fn a_slow_but_live_server_is_waited_for_never_replaced() {
        rt().block_on(async {
            let mut rounds = 0u32;
            let choice = decide_boot(true, Duration::ZERO, |tls| {
                rounds += 1;
                // TLS probe of round 50 onwards answers; nothing before that.
                std::future::ready(tls && rounds >= 99)
            })
            .await;
            assert_eq!(choice, BootChoice::Defer { tls: true });
        });
    }

    /// Marker present and NOBODY answers: still no sidecar (the rule stands), but the
    /// verdict is its own case, which is what lets the page explain itself.
    #[test]
    fn marker_without_any_server_waits_instead_of_forking() {
        rt().block_on(async {
            let choice = decide_boot(true, Duration::ZERO, |_| std::future::ready(false)).await;
            assert_eq!(choice, BootChoice::WaitForKnownServer);
        });
    }

    /// A virgin machine gets its sidecar, after a short wait and not a 42s one.
    #[test]
    fn virgin_machine_spawns_the_sidecar() {
        rt().block_on(async {
            let mut rounds = 0u32;
            let choice = decide_boot(false, Duration::ZERO, |_| {
                rounds += 1;
                std::future::ready(false)
            })
            .await;
            assert_eq!(choice, BootChoice::SpawnSidecar);
            assert_eq!(rounds, 16, "8 rounds, two probes each (TLS then plain)");
        });
    }
}
