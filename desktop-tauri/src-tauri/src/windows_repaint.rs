//! Windows: the window came back from minimised, and the webview stopped painting.
//!
//! MEASURED on 2.2.181, on the real machine, with the window rect cropped out of a
//! full-screen capture and the same two numbers taken before and after:
//!
//! ```text
//! before minimising      79 of 79 sampled rows carry pixels, 13.949 colours
//! after SW_RESTORE        3 of 79, and 95,9% of the window is (236,237,238)
//! ten seconds later       identical — it does NOT recover on its own
//! ```
//!
//! The window itself is fine (`vis=true min=false`): it is the webview inside that
//! has stopped drawing, so what shows through is the window's own background.
//!
//! The remedy already existed and nothing on this platform ever reached it.
//! [`crate::recompose_main_window`] bounces the bounds by one pixel and then runs
//! `RELOAD_IF_BLANK_JS` — precisely this repair — but its only trigger is
//! `wire_recompose_observers`, which is `#[cfg(target_os = "macos")]`: it hangs off
//! the NSNotification for screen-parameter changes and wake. A Windows user
//! restoring a window walked a path that had no repair on it.

use std::sync::atomic::{AtomicBool, Ordering};

/// What `is_minimized()` said the last time a resize came through. The un-minimize
/// edge is a TRANSITION, not a state, so it can only be seen by remembering.
static WAS_MINIMIZED: AtomicBool = AtomicBool::new(false);

/// Call on every `WindowEvent::Resized`. Windows delivers one on both edges of a
/// minimise, which is what makes the transition visible from here at all.
///
/// The delay before repairing is not superstition: `recompose_main_window` returns
/// early while the window still reports minimised, and the transition is not atomic,
/// so the bounce has to land after the restore has settled or it is a no-op.
pub(crate) fn note_minimize_transition(win: &tauri::Window) {
    use tauri::Manager;
    let now = win.is_minimized().unwrap_or(false);
    let before = WAS_MINIMIZED.swap(now, Ordering::Relaxed);
    if !(before && !now) {
        return; // not the un-minimize edge
    }
    let app = win.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::recompose_main_window(&app2, "restore");
        });
    });
}
