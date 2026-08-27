//! Windows: the window came back from minimised, and the webview stopped painting.
//!
//! MEASURED on the real machine, cropping the window rect out of the capture and
//! taking the same two numbers before and after (`topics-grey/probe2.ps1`):
//!
//! ```text
//! 2.2.181  before minimising  79 of 79 sampled rows carry pixels
//!          after SW_RESTORE    3 of 79, 95,9% of the window is (236,237,238)
//!          ten seconds later   identical - it does NOT recover on its own
//! 2.2.182  before minimising  79 of 79, 556 colours
//!          after SW_RESTORE    4 of 79, 430 colours
//!          ten seconds later   4 of 79 - the first remedy did NOT work
//! ```
//!
//! WHAT IT IS NOT, because both were checked and both were wrong.
//!
//! It is not the window: `vis=true min=false` right after the restore. It is not
//! the child windows either, which was the obvious next guess and is refuted by
//! `topics-grey/probe3.ps1` - after the restore `WRY_WEBVIEW`,
//! `Chrome_WidgetWin_0/1`, `Chrome_RenderWidgetHostHWND` and the D3D window are
//! all present, all `vis=True`, all 1400x930 at the right origin. Every HWND is
//! healthy and nothing is drawn, so the loss is in the composition, below the
//! window layer.
//!
//! That is also why the first remedy failed. [`crate::recompose_main_window`]
//! bounces the OUTER window by one pixel, which is the right medicine on macOS
//! (it makes the NSView redraw) and touches nothing that is actually broken here.
//!
//! So this asks WebView2 itself to rebuild its visual: a visibility cycle on the
//! `ICoreWebView2Controller` plus a re-assert of its bounds. The window bounce is
//! kept as well, because it costs nothing and it is what fixes the OTHER half
//! (the window frame) if it is ever the one that is stale.

use std::sync::atomic::{AtomicBool, Ordering};

/// What `is_minimized()` said the last time a resize came through. The
/// un-minimize edge is a TRANSITION, not a state, so it can only be seen by
/// remembering the previous answer.
static WAS_MINIMIZED: AtomicBool = AtomicBool::new(false);

/// A line per repair, next to the installed app. There is no other way to tell
/// "the hook never fired" from "the hook fired and the remedy did not work", and
/// guessing between those two costs a full release cycle each time.
fn trace(app: &tauri::AppHandle, line: &str) {
    use std::io::Write;
    use tauri::Manager;
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("repaint.log"))
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Ask WebView2 to rebuild the visual it lost while the window was minimised.
///
/// `get_webview`, NOT `get_webview_window`: once a native browser pane is up the
/// main window is multi-webview and the second lookup returns `None`, which is a
/// trap this file is not the first to fall into.
fn rebuild_webview_visual(app: &tauri::AppHandle) -> &'static str {
    use tauri::Manager;
    let Some(wv) = app.get_webview("main") else { return "no main webview" };
    let queued = wv.with_webview(move |platform| unsafe {
        let c = platform.controller();
        // The cycle is the point: WebView2 drops its composition surface on
        // minimise and does not always rebuild it on the way back. Turning the
        // controller off and on again forces the rebuild; re-asserting the
        // bounds gives the new visual a size. Signatures read from
        // webview2-com-sys 0.38.2, not guessed: `SetIsVisible` takes a plain
        // `bool`, `Bounds` an out-pointer, `SetBounds` a value.
        let _ = c.SetIsVisible(false);
        let _ = c.SetIsVisible(true);
        let mut r = windows::Win32::Foundation::RECT::default();
        if c.Bounds(&mut r).is_ok() {
            let _ = c.SetBounds(r);
        }
    });
    if queued.is_err() { "with_webview refused" } else { "controller cycled" }
}

/// Call on every `WindowEvent::Resized`. Windows delivers one on both edges of a
/// minimise, which is what makes the transition visible from here at all.
///
/// The delay is not superstition: `recompose_main_window` returns early while the
/// window still reports minimised, and the transition is not atomic, so the
/// repair has to land after the restore has settled or it is a no-op.
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
        // NOT inside `run_on_main_thread`: `with_webview` dispatches to the UI
        // thread by itself, and nesting the two is how the browser backends
        // deadlock (see the warning at the top of `browser_win.rs`).
        let what = rebuild_webview_visual(&app);
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::recompose_main_window(&app2, "restore");
            trace(&app2, &format!("restore: {what}, window bounced"));
        });
    });
}
