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
        // A LADDER, in the order Microsoft documents for "the webview came back
        // blank": the visibility cycle alone was MEASURED not to be enough
        // (2.2.184: the repair ran - `repair: controller cycled, window bounced`
        // is in repaint.log - and the window still came back at 3 rows of 79).
        //
        // Re-parenting the controller to the SAME parent is the strong one: it
        // makes WebView2 rebuild its whole visual tree, which is precisely what
        // is lost here (every HWND stays healthy, nothing is drawn).
        // `NotifyParentWindowPositionChanged` is the cheap one that tells it the
        // host moved, and re-asserting the bounds gives the new visual a size.
        // Signatures read from webview2-com-sys 0.38.2, not guessed.
        let mut parent = windows::Win32::Foundation::HWND::default();
        if c.ParentWindow(&mut parent).is_ok() {
            let _ = c.SetParentWindow(parent);
        }
        let _ = c.NotifyParentWindowPositionChanged();
        let _ = c.SetIsVisible(false);
        let _ = c.SetIsVisible(true);
        let mut r = windows::Win32::Foundation::RECT::default();
        if c.Bounds(&mut r).is_ok() {
            let _ = c.SetBounds(r);
        }
    });
    if queued.is_err() { "with_webview refused" } else { "reparented + cycled" }
}

/// Called on EVERY window event this file subscribes to (`Resized`, `Focused`),
/// because which one carries the un-minimize edge is not a given.
///
/// tao emits `Resized` from `WM_SIZE`, and `WM_SIZE(SIZE_MINIMIZED)` arrives with
/// a size of 0x0 - a runtime that skips that one never lets us see the window go
/// DOWN, so the way back up would not read as a transition at all. `Focused` is
/// the belt to that pair of braces: minimising always takes focus away, and at
/// that moment `is_minimized()` is already true, so the state gets recorded even
/// if no `Resized` ever came.
///
/// The delay before repairing is not superstition: the transition is not atomic,
/// and `recompose_main_window` returns early while the window still reports
/// minimised, so the repair has to land after the restore has settled.
pub(crate) fn note_window_event(win: &tauri::Window, kind: &'static str) {
    use tauri::Manager;
    let now = win.is_minimized().unwrap_or(false);
    let before = WAS_MINIMIZED.swap(now, Ordering::Relaxed);
    if before == now {
        return; // no transition
    }
    let app = win.app_handle().clone();
    trace(&app, &format!("{kind}: minimized {before} -> {now}"));
    if now {
        return; // going DOWN: nothing to repair yet
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        // NOT inside `run_on_main_thread`: `with_webview` dispatches to the UI
        // thread by itself, and nesting the two is how the browser backends
        // deadlock (see the warning at the top of `browser_win.rs`).
        let what = rebuild_webview_visual(&app);
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::window_recompose::recompose_main_window(&app2, "restore");
            trace(&app2, &format!("repair: {what}, window bounced"));
        });
    });
}

/// Subscribe the main window. Registered from `run()` OUTSIDE any macOS block,
/// which is the whole reason the first attempt did nothing: the handler that
/// carried this hook lived inside `#[cfg(target_os = "macos")]`, so the line was
/// guarded for Windows inside a block that on Windows does not exist. It
/// compiled nowhere, and `cargo check` could not say so on either platform.
///
/// `get_window`, not `webview_windows()`: the latter loses windows that have a
/// native browser pane, and this app has them.
pub(crate) fn wire(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(win) = app.get_window("main") else {
        return;
    };
    // `on_window_event` APPENDS a listener, it does not replace one (verified in
    // tauri-runtime-wry 2.11.3: every registration takes a fresh id into a map,
    // and the runtime calls them all), so this does not disturb anything already
    // listening on this window.
    let w = win.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) => note_window_event(&w, "resized"),
        tauri::WindowEvent::Focused(_) => note_window_event(&w, "focused"),
        _ => {}
    });
    trace(app, "wired");
}
