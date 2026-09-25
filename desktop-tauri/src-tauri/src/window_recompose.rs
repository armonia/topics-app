//! Putting the window back together after the system moved the ground under it:
//! a display was unplugged, the machine woke, or (on Windows) the window came
//! back from being minimised.
//!
//! It lives in its own file for the reason `lib.rs` keeps growing: this is a
//! self-contained repair with two callers on two platforms, not a piece of the
//! shell's setup.

use crate::{eval_in_main_webview, RELOAD_IF_BLANK_JS};

/// One line into `~/Library/Logs/topics-window.log`, next to its stderr twin.
///
/// The shell's stderr goes to /dev/null in the installed app (checked on
/// 23/09 with lsof on the running Topics), so every `[recompose]` line was
/// lost: when the window "grew and shrank several times" nobody could say
/// whether this bounce was the cause. The file is tiny (a line per display
/// change or wake) and it is what makes that question answerable.
fn trace(line: &str) {
    eprintln!("{line}");
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        let Ok(home) = std::env::var("HOME") else { return };
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(format!("{home}/Library/Logs/topics-window.log"))
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ts}] {line}");
        }
    }
}

/// Does `rect` (logical points, top-left origin) overlap ANY currently-attached
/// monitor? Pure geometry so it can be unit-tested without a screen: `monitors` is
/// the list of monitor rects in the same space. A window that overlaps nothing is
/// stranded on a display that no longer exists — the classic "the app is running but
/// I can't see it" after unplugging the ultrawide.
pub(crate) fn rect_intersects_any(rect: (f64, f64, f64, f64), monitors: &[(f64, f64, f64, f64)]) -> bool {
    let (x, y, w, h) = rect;
    monitors.iter().any(|&(mx, my, mw, mh)| {
        x < mx + mw && mx < x + w && y < my + mh && my < y + h
    })
}

/// Re-anchor + bounce the main window so the compositor is forced to produce a frame.
///
/// Re-anchor: if the saved geometry now sits entirely off every attached screen, pull
/// the window back onto the primary one. We do NOT touch a window that is still on a
/// screen — `-797,-1410` is a real, deliberate position on an ultrawide with a
/// display to the left, and "fixing" a place the user chose is the bug, not the
/// cure.
///
/// Bounce: grow the outer size by 1px and put it back a beat later. That is the half
/// that was missing, and it's the half that actually repaints.
pub(crate) fn recompose_main_window(app: &tauri::AppHandle, why: &str) {
    // ONE bounce per burst. `NSApplicationDidChangeScreenParameters` does not
    // fire once per plug: with an external display it arrives in bursts while
    // macOS re-lays the screens out (and on arrangement or resolution changes),
    // and each one bounced the window +1px and back. Several in a row is the
    // window visibly "growing and shrinking several times".
    //
    // TRAILING, not leading: the bounce exists to repaint the FINAL layout, so
    // it runs once the burst has been quiet for `SETTLE`. Each notification
    // takes a ticket; only the newest ticket, still newest after the wait,
    // recomposes.
    let ticket = BOUNCE_TICKET.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    trace(&format!("[recompose] {why}: notification #{ticket}"));
    let app2 = app.clone();
    let why = why.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        if !is_latest_ticket(ticket, BOUNCE_TICKET.load(std::sync::atomic::Ordering::SeqCst)) {
            return;
        }
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || recompose_now(&app3, &why));
    });
}

/// How long the screen notifications must be quiet before the one bounce.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(600);
static BOUNCE_TICKET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Pure, so the debounce rule is testable without a window: a ticket acts only
/// if no newer notification arrived while it waited.
pub(crate) fn is_latest_ticket(mine: u64, newest: u64) -> bool {
    mine == newest
}

fn recompose_now(app: &tauri::AppHandle, why: &str) {
    use tauri::Manager;
    let Some(win) = app.get_window("main") else { return };
    if !win.is_visible().unwrap_or(true) || win.is_minimized().unwrap_or(false) {
        return; // hidden to tray / minimised: nothing to recompose, and a bounce
                // would be a visible glitch when it comes back.
    }
    // Read the geometry off the plain `Window` (not `window_logical_geometry`, which
    // takes a WebviewWindow — a lookup that returns None once browser panes are up).
    let Ok(sf) = win.scale_factor() else { return };
    let Ok(pos) = win.outer_position() else { return };
    let Ok(size) = win.outer_size() else { return };
    let pos = pos.to_logical::<f64>(sf);
    let size = size.to_logical::<f64>(sf);
    let (x, y, w, h) = (pos.x, pos.y, size.width, size.height);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let monitors: Vec<(f64, f64, f64, f64)> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            let p = m.position().to_logical::<f64>(sf);
            let s = m.size().to_logical::<f64>(sf);
            (p.x, p.y, s.width, s.height)
        })
        .collect();
    if !monitors.is_empty() && !rect_intersects_any((x, y, w, h), &monitors) {
        let (mx, my, _, _) = monitors[0];
        trace(&format!("[recompose] {why}: window off every screen, re-anchoring to {mx},{my}"));
        let _ = win.set_position(tauri::LogicalPosition::new(mx + 30.0, my + 80.0));
    }
    // BOUNCE THE INNER SIZE, and read the inner size to do it. `set_size` sets
    // the INNER size, so feeding it the OUTER one grows the window by the
    // decoration delta EVERY time this runs. On macOS that delta is zero for a
    // borderless window and nobody noticed; on Windows the invisible resize
    // borders and the DWM frame make it 16x29, and this fires on every restore -
    // measured on 2.2.184, where one repair took the window from 1416x939 to
    // 1432x968.
    let Ok(inner) = win.inner_size() else { return };
    let inner = inner.to_logical::<f64>(sf);
    let (bw, bh) = (inner.width, inner.height);
    if bw <= 0.0 || bh <= 0.0 {
        return;
    }
    trace(&format!("[recompose] {why}: bouncing bounds {bw}x{bh} -> +1px -> back, to force a redraw"));
    let _ = win.set_size(tauri::LogicalSize::new(bw + 1.0, bh));
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            use tauri::Manager;
            if let Some(w2) = app3.get_window("main") {
                let _ = w2.set_size(tauri::LogicalSize::new(bw, bh));
            }
            // A window that came back from a dead display can also have lost its
            // document; same conservative nudge the watchdog uses.
            eval_in_main_webview(&app3, RELOAD_IF_BLANK_JS);
        });
    });
}

#[cfg(test)]
mod tests {
    use super::is_latest_ticket;

    /// A burst of five screen notifications (tickets 1..=5): only the last one,
    /// once nothing newer arrived during its wait, bounces the window. Before,
    /// all five did, which is the window growing and shrinking five times.
    #[test]
    fn a_burst_bounces_once() {
        let newest = 5;
        let acting: Vec<u64> = (1..=5).filter(|t| is_latest_ticket(*t, newest)).collect();
        assert_eq!(acting, vec![5]);
    }

    /// A single, isolated notification still bounces: the repaint after a real
    /// display change or wake is the reason this code exists.
    #[test]
    fn a_lone_notification_still_bounces() {
        assert!(is_latest_ticket(1, 1));
    }
}
