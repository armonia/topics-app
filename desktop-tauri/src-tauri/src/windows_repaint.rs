//! Windows: the window comes back from minimised and the webview stops painting.
//!
//! MEASURED on the real machine (`topics-grey/probe2.ps1`), cropping the window
//! rect and comparing the window with ITSELF before and after, because an
//! absolute threshold cannot tell "does not paint" from "has nothing to show":
//!
//! ```text
//! before minimising  79 of 79 sampled rows carry pixels
//! after SW_RESTORE    3 of 79, and the desktop shows through the rest
//! ten seconds later   identical - it does NOT recover on its own
//! ```
//!
//! NINE remedies were tried, one release each, and every one of them RAN - the
//! trace below proves it each time. They are gone from the code and written down
//! here so nobody pays for them twice, and so a tenth attempt starts where the
//! ninth stopped instead of at the beginning:
//!
//! ```text
//! 2.2.182  window bounds bounced by one pixel               3/79
//! 2.2.184  controller visibility cycle                      3/79
//! 2.2.185  controller re-parented to the same parent        3/79
//! 2.2.186  controller's OWN bounds bounced for real         3/79
//! 2.2.187  compositor invalidated from inside the page      3/79
//! 2.2.188  rasterization scale changed and put back         3/79
//! 2.2.189  webview default background made opaque           3/79
//! 2.2.190  window hidden and shown again                    3/79
//! ```
//!
//! WHAT IS KNOWN, each of it measured rather than assumed:
//! - the hook fires and sees both edges of the transition;
//! - the renderer is ALIVE: `ExecuteScript` returns true after the restore, so
//!   this is not a suspended process, it is one that runs and does not paint;
//! - every HWND is healthy - `WRY_WEBVIEW`, `Chrome_WidgetWin_0/1`,
//!   `Chrome_RenderWidgetHostHWND` and the D3D window are all present, visible
//!   and correctly sized afterwards;
//! - the window is not layered (exstyle 0x40110) and the WebView2 runtime is
//!   current (151.0.4129.107);
//! - what survives on screen is ONE stale tile, cut through a glyph;
//! - restarting the app cures it, every time.
//!
//! Together that says the composition surface is gone and nothing the WebView2
//! API exposes rebuilds it, which puts the defect BELOW this file: in wry, in
//! tauri-runtime-wry, or in the runtime.
//!
//! WHAT IS LEFT TO TRY, cheapest first:
//! 1. Never enter the state: subclass the window, intercept
//!    `WM_SYSCOMMAND`/`SC_MINIMIZE` and hide to the tray instead of iconifying.
//!    Needs care not to break the taskbar.
//! 2. Report upstream. The evidence above is enough for a good bug report.
//!
//! The hook and the trace stay. They cost nothing, and without them a future
//! attempt cannot tell "it never ran" from "it ran and did not work" - a
//! distinction that already cost one release cycle to learn.

use std::sync::atomic::{AtomicBool, Ordering};

/// What `is_minimized()` said the last time an event came through. The
/// un-minimize edge is a TRANSITION, not a state, so it can only be seen by
/// remembering the previous answer.
static WAS_MINIMIZED: AtomicBool = AtomicBool::new(false);

/// A line per transition, next to the installed app.
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

/// Make the main webview background TRANSPARENT, so the DWM backdrop underneath
/// it can be seen.
///
/// This function used to do the opposite. It set A:255 on the argument that
/// Windows had no vibrancy, so a see-through webview was paying for a feature
/// the platform did not have. That is no longer true: `windows_acrylic` now asks
/// DWM for an Acrylic backdrop behind the whole window, and an opaque webview
/// background covers it completely. No backdrop can ever show through A:255.
///
/// Nothing that worked is lost by the change. Making the webview opaque was one
/// of the nine remedies tried against the repaint bug (2.2.189 in the table at
/// the top of this file) and it is among the ones that did NOT cure it: 3 of 79
/// rows, the same as every other attempt. So its opacity was buying nothing, and
/// it is what the backdrop costs.
///
/// What this call actually changed is the REMOVAL, not the A:0. wry already sets
/// the controller background to (0,0,0,0) at creation for any window built
/// `transparent: true`, which ours is; the old A:255 here ran afterwards and
/// overrode it. Setting A:0 now re-states what wry had already decided, so the
/// line is a belt-and-braces assertion of intent rather than the thing that
/// makes the backdrop visible. It is worth keeping only while the window is
/// transparent: flip that config and this would be forcing the wrong value.
fn make_transparent(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(wv) = app.get_webview("main") else { return };
    let _ = wv.with_webview(|platform| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
        };
        let c = platform.controller();
        if let Ok(c2) = windows::core::Interface::cast::<ICoreWebView2Controller2>(&c) {
            // A:0 is the whole point. The RGB is ignored at zero alpha, so it is
            // left at zero too rather than carrying a colour that means nothing.
            let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 0,
                R: 0,
                G: 0,
                B: 0,
            });
        }
    });
}

/// Called on every window event this file subscribes to. Records the transition
/// and nothing else: see the header for why there is no repair here any more.
///
/// Both `Resized` and `Focused` are watched. tao emits `Resized` from `WM_SIZE`,
/// and `WM_SIZE(SIZE_MINIMIZED)` arrives 0x0 — a runtime that skips it would
/// never let us see the window go DOWN, so the way back up would not read as a
/// transition. Losing focus always happens on minimise, and at that moment
/// `is_minimized()` is already true.
pub(crate) fn note_window_event(win: &tauri::Window, kind: &'static str) {
    use tauri::Manager;
    let now = win.is_minimized().unwrap_or(false);
    let before = WAS_MINIMIZED.swap(now, Ordering::Relaxed);
    if before == now {
        return;
    }
    trace(&win.app_handle().clone(), &format!("{kind}: minimized {before} -> {now}"));
}

/// Subscribe the main window. Registered from `run()` OUTSIDE any macOS block,
/// which is where the first attempt went wrong: the handler carrying this hook
/// lived inside `#[cfg(target_os = "macos")]`, so a line guarded for Windows
/// inside it compiled nowhere, and no `cargo check` could say so.
///
/// `get_window`, not `webview_windows()`: the latter loses windows that have a
/// native browser pane, and this app has them.
pub(crate) fn wire(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(win) = app.get_window("main") else { return };
    // `on_window_event` APPENDS a listener, it does not replace one (verified in
    // tauri-runtime-wry 2.11.3: every registration takes a fresh id into a map
    // and the runtime calls them all), so this disturbs nothing already
    // listening on this window.
    let w = win.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) => note_window_event(&w, "resized"),
        tauri::WindowEvent::Focused(_) => note_window_event(&w, "focused"),
        _ => {}
    });
    make_transparent(app);
    trace(app, "wired");
}
