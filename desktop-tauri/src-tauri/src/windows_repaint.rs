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


/// Force the PAGE to re-raster, which is a different lever from everything the
/// controller offers.
///
/// Every host-side remedy has now been measured not to work (2.2.182 to 2.2.186:
/// window bounce, controller visibility cycle, re-parent, a real one-pixel bounce
/// of the controller's own bounds - each one ran, `repaint.log` proves it, and
/// the window came back at 3 or 4 rows of 79 every time). The WebView2 runtime is
/// current (151.0.4129.107) and the window is not layered, so neither is the
/// explanation.
///
/// What has NOT been tried is asking the renderer itself to throw its raster
/// away. Promoting the root to its own compositing layer and dropping it again
/// invalidates every tile: if the renderer is alive and only its surface is
/// stale, this is enough and costs nothing. If it is NOT enough, the renderer is
/// suspended rather than stale, and the only remaining remedy is a reload - which
/// costs the page's state and is therefore a decision, not a default.
const REPAINT_JS: &str = "(function(){try{\
var d=document.documentElement;\
d.style.transform='translateZ(0)';\
d.getBoundingClientRect();\
requestAnimationFrame(function(){d.style.transform='';});\
}catch(e){}})()";

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
        // BOUNCE THE CONTROLLER'S BOUNDS, and bounce them for real.
        //
        // Everything tried before re-asserted values that were ALREADY set:
        // `SetParentWindow` with the same parent, `SetBounds` with the same rect,
        // a visibility cycle. Measured across 2.2.183, 2.2.184 and 2.2.185 - the
        // repair ran every time, `repaint.log` proves it - and the window came
        // back at 3 or 4 rows of 79 each time. A setter handed the value it
        // already holds is free to do nothing, and that is the likeliest reason
        // none of them bit.
        //
        // So the rect is CHANGED (one pixel narrower) and then put back, which is
        // the same trick as the window bounce but applied one layer down, where
        // the loss actually is: every HWND stays healthy and nothing is drawn.
        // Signatures read from webview2-com-sys 0.38.2, not guessed.
        let mut r = windows::Win32::Foundation::RECT::default();
        if c.Bounds(&mut r).is_ok() {
            let mut shrunk = r;
            shrunk.right = (shrunk.right - 1).max(shrunk.left + 1);
            let _ = c.SetBounds(shrunk);
            let _ = c.SetBounds(r);
        }
        let _ = c.NotifyParentWindowPositionChanged();
        let _ = c.SetIsVisible(false);
        let _ = c.SetIsVisible(true);
        // THE RASTER, and this is the one aimed at what the evidence actually
        // says. `repaint js true` in repaint.log means ExecuteScript RAN, so the
        // renderer is alive and simply is not painting: everything above talks to
        // the host side of a webview that is already doing its job. Changing the
        // rasterization scale cannot be a no-op the way re-asserting a value can,
        // because the value is different, and it makes the renderer re-raster
        // every tile at the new scale. Then it goes back.
        if let Ok(c3) = windows::core::Interface::cast::<
            webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3,
        >(&c)
        {
            let mut scale = 0.0f64;
            if c3.RasterizationScale(&mut scale).is_ok() && scale > 0.0 {
                let _ = c3.SetRasterizationScale(scale * 1.02);
                let _ = c3.SetRasterizationScale(scale);
            }
        }
    });
    if queued.is_err() { "with_webview refused" } else { "bounds bounced + cycled + re-rastered" }
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
            let evalled = crate::eval_in_main_webview(&app2, REPAINT_JS);
            trace(&app2, &format!("repair: {what}, window bounced, repaint js {evalled}"));
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
