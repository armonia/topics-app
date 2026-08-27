//! Wait on fire-and-forget child processes so they do not become zombies.
//!
//! In its own file because it is self-contained and owes nothing to the shell
//! around it: one channel, one polling thread, one `reap()`. Moving it out is
//! what keeps `lib.rs` under its ceiling without raising the ceiling.

//! Reaps detached children so they never linger as zombies.
//!
//! `std::process::Child`'s `Drop` deliberately does NOT wait, so every
//! `.spawn()` whose handle is dropped leaves a `<defunct>` entry owned by this
//! process until it exits. That is a slow leak with a steady driver behind it:
//! the notification helper (`macos_notifications::post_via_helper`) fires on
//! every session state change, which measured ~50 zombies/hour on a normal day
//! and had accumulated 285 of them in one 6-hour run. Zombies hold a PID slot
//! each, so the process table fills up machine-wide, not just for Topics.
//!
//! A single background thread owns every handed-off child. It blocks on the
//! channel while it has nothing to watch (zero cost at rest) and polls with
//! `try_wait` while it does — never blocking on one long-lived child (a
//! `terminal-notifier` banner lives as long as it is on screen) in a way that
//! would stall the reaping of the others. Deliberately not `SIGCHLD → SIG_IGN`:
//! that is process-global and would break `tauri-plugin-shell`'s sidecar
//! reaper, which waits on its own children.

use std::process::Child;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// How often pending children are polled for exit. Coarse on purpose: these
/// are fire-and-forget helpers, latency to notice their exit is irrelevant.
const POLL: Duration = Duration::from_millis(500);

static REAPER: OnceLock<Mutex<Sender<Child>>> = OnceLock::new();

/// Hand a spawned child over to be waited on. Non-blocking.
pub fn reap(child: Child) {
    let tx = REAPER.get_or_init(|| {
        let (tx, rx) = channel::<Child>();
        std::thread::Builder::new()
            .name("child-reaper".into())
            .spawn(move || {
                let mut pending: Vec<Child> = Vec::new();
                loop {
                    if pending.is_empty() {
                        // Nothing to watch: sleep on the channel.
                        match rx.recv() {
                            Ok(c) => pending.push(c),
                            // Sender lives in a `static`, so this is
                            // unreachable in practice; exit rather than spin.
                            Err(_) => return,
                        }
                    } else {
                        while let Ok(c) = rx.try_recv() {
                            pending.push(c);
                        }
                        // `Err` means the child was already reaped or is
                        // unwaitable — either way stop tracking it.
                        pending.retain_mut(|c| matches!(c.try_wait(), Ok(None)));
                        if !pending.is_empty() {
                            std::thread::sleep(POLL);
                        }
                    }
                }
            })
            .expect("spawn child-reaper thread");
        Mutex::new(tx)
    });
    if let Ok(tx) = tx.lock() {
        // Send failure would mean the reaper thread died; dropping the child
        // here is the pre-existing behaviour, not a regression.
        let _ = tx.send(child);
    }
}
