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
//! THE TENTH REMEDY, which is what this file now does. Every one of the nine
//! spoke to the WINDOW or to the CONTROLLER of an existing webview: bounds,
//! visibility, parent, scale, background, hide and show. None of them REBUILT
//! THE WEBVIEW, and the one line in the evidence above that no attempt used is
//! "restarting the app cures it, every time". A restart rebuilds the
//! composition surface by rebuilding everything; `rebuild_main_webview` below
//! rebuilds only the part that is broken, on the restore edge: it closes the
//! "main" webview and builds another one in the same window.
//!
//! Why this is allowed to be the answer where a subclass on minimise is not:
//! minimise keeps minimising, the taskbar keeps behaving, no standard gesture
//! changes meaning. The price is that the page reloads, and this app reloads for
//! a living - it does one on every new bundle.
//!
//! THE SUBCLASS IS OUT, and it is out by decision, not because nobody thought of
//! it: intercepting `WM_SYSCOMMAND`/`SC_MINIMIZE` and hiding to the tray does
//! repair the symptom, but it takes minimise away from the person using the app,
//! and a gesture the whole system agrees on is not ours to redefine to dodge a
//! repaint bug. Do not bring it back without that decision being taken again.
//!
//! It can still fail: if the surface is owned at a level that recreating the
//! controller does not touch, this becomes a tenth `3/79` in the table. The
//! trace says which of the two happened, and that is the whole point of the
//! trace: "it never ran" and "it ran and did not help" have already cost one
//! release cycle to tell apart.
//!
//! HOW TO JUDGE IT, unchanged from the nine: `probe2.ps1` on the real machine,
//! which crops the window rect and compares the window with itself before and
//! after a minimise/restore. It passes when the rows carrying pixels go back to
//! 79/79, not 3/79. `repaint.log` next to the installed app must carry a
//! `rebuild: rebuilt ...` line for that restore; anything else there names what
//! stopped it.
//!
//! WHAT IS STILL OUT OF SCOPE: reporting it upstream (wry /
//! tauri-runtime-wry / the runtime). The evidence above is enough for a good bug
//! report, and a report is public, so it waits for an explicit word.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

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

/// One rebuild at a time. `Resized` and `Focused` both feed the edge detector
/// and only one of them can see a given transition, so this is not the thing
/// that de-duplicates them: it is the guard for a restore that arrives while the
/// previous rebuild is still creating its webview, which would try to take the
/// label "main" twice.
static REBUILDING: AtomicBool = AtomicBool::new(false);

/// Set this to anything to leave the webview alone on restore. The escape hatch
/// exists because a rebuild that goes wrong leaves the window with no webview at
/// all, and "start it once with the variable set" is a recovery that does not
/// need a downgrade.
/// The rebuild is OPT-IN since 30/08, and the measurement that turned it round
/// is in `note_window_event`. The old opt-OUT name still works, so anyone with
/// it set in an environment keeps the behaviour they asked for.
const REBUILD_ON_VAR: &str = "TOPICS_WEBVIEW_REBUILD";
const REBUILD_OFF_VAR: &str = "TOPICS_NO_WEBVIEW_REBUILD";

/// THE TENTH REMEDY. Close the "main" webview and build another one in the same
/// window, on the restore edge.
///
/// Runs on a thread of its own, and it has to: `Window::add_child` marshals the
/// build to the main thread and BLOCKS on the answer, so calling it from the
/// window-event handler (which is already on the main thread) would deadlock the
/// event loop. Everything the main thread has to do arrives as queued messages,
/// in order, on the same event-loop channel: close, then the z-order fix, then
/// the build.
///
/// Two things this is careful about, both paid for elsewhere in the tree:
/// - NO ORPHANS. The main webview of a window is already a CHILD webview here
///   (tauri's `unstable` feature is on, so a webview window is built through
///   `build_as_child`), and dropping a child wry webview both closes the
///   WebView2 controller and destroys its container HWND. So this is the same
///   creation path the window was born with, torn down the same way, and not the
///   asymmetric case that leaked WebContent processes on macOS.
/// - Z-ORDER. Browser panes are sibling child webviews of this same window, and
///   a freshly created child HWND goes on TOP of its siblings. The main webview
///   was the FIRST child when the app started, so it belongs at the bottom;
///   `sink_to_bottom` puts it back there, otherwise the rebuilt UI would cover
///   every open pane.
fn rebuild_main_webview(app: &tauri::AppHandle) {
    if std::env::var_os(REBUILD_OFF_VAR).is_some() {
        trace(app, "rebuild: off by TOPICS_NO_WEBVIEW_REBUILD");
        return;
    }
    if std::env::var_os(REBUILD_ON_VAR).is_none() {
        trace(app, "rebuild: not armed (set TOPICS_WEBVIEW_REBUILD=1)");
        return;
    }
    if REBUILDING.swap(true, Ordering::SeqCst) {
        trace(app, "rebuild: one already in flight");
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let line = rebuild_now(&app);
        trace(&app, &line);
        REBUILDING.store(false, Ordering::SeqCst);
    });
}

/// The rebuild itself, off the main thread. Returns the line to trace, so every
/// exit of this function says what happened - including the ones that decided to
/// do nothing.
fn rebuild_now(app: &tauri::AppHandle) -> String {
    use tauri::Manager;
    // Let the restore land first. The edge is seen from `WM_SIZE`, which arrives
    // while the window is still being put back on screen.
    std::thread::sleep(Duration::from_millis(200));
    let Some(win) = app.get_window("main") else {
        return "rebuild: no main window".into();
    };
    if win.is_minimized().unwrap_or(false) {
        return "rebuild: minimized again, skipped".into();
    }
    if !win.is_visible().unwrap_or(true) {
        // Hidden to the tray is not the restore we are curing, and building a
        // webview for an invisible window would only pay the reload twice.
        return "rebuild: window not visible, skipped".into();
    }
    let Some(old) = app.get_webview("main") else {
        return "rebuild: no main webview".into();
    };
    // Rebuild on the page the app is ON, not on the one it booted with: when the
    // server is down the shell parks the window on its own explanation page, and
    // sending it back to index.html would hide that. Anything that is not http
    // falls back to the config default, because that is the only value a fresh
    // webview can resolve on its own.
    let url = old.url().ok().filter(|u| matches!(u.scheme(), "http" | "https"));
    let Ok(size) = win.inner_size() else {
        return "rebuild: no inner size".into();
    };
    if let Err(e) = old.close() {
        return format!("rebuild: close failed: {e}");
    }
    // Two goes. If the first build fails the window is left with no webview at
    // all, which is worse than the grey it was curing, so it is worth one retry
    // before giving up and saying so in the trace.
    for attempt in 1..=2 {
        let target = match &url {
            Some(u) => tauri::WebviewUrl::External(u.clone()),
            None => tauri::WebviewUrl::App("index.html".into()),
        };
        let builder = tauri::webview::WebviewBuilder::new("main", target)
            // Same webview attributes the config gives the main window, because
            // this webview IS the main window's content: a see-through
            // background so the DWM Acrylic backdrop shows through (this is the
            // same A:0 `make_transparent` asserts at startup, asked for at
            // creation instead of after it), and no wry drag-drop handler,
            // without which HTML5 drag and drop dies.
            .transparent(true)
            .disable_drag_drop_handler()
            // Mandatory here and not for a window-born webview: tauri only
            // tracks a child webview's size against the window when it was asked
            // to. Without this the rebuilt UI would keep the size the window had
            // at rebuild time forever.
            .auto_resize();
        match win.add_child(
            builder,
            tauri::PhysicalPosition::new(0, 0),
            size,
        ) {
            Ok(wv) => {
                sink_to_bottom(&wv);
                let shown = url
                    .as_ref()
                    .map(|u| u.as_str().to_string())
                    .unwrap_or_else(|| "index.html".into());
                return format!("rebuild: rebuilt {shown} (attempt {attempt})");
            }
            Err(e) if attempt == 2 => return format!("rebuild: build failed: {e}"),
            Err(e) => {
                trace(app, &format!("rebuild: attempt {attempt} failed: {e}, retrying"));
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    }
    "rebuild: unreachable".into()
}

/// Put a freshly built child webview back UNDER its siblings. See the z-order
/// note on `rebuild_main_webview` for why. `ParentWindow()` on the controller is
/// the container HWND wry created for this webview, which is the child window
/// whose order matters; the closure runs on the main thread, where window
/// messages belong.
fn sink_to_bottom(wv: &tauri::Webview) {
    let _ = wv.with_webview(|platform| unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        // `ParentWindow` answers through an out parameter, so the handle starts
        // null and stays null if the call fails.
        let mut hwnd = HWND::default();
        if platform.controller().ParentWindow(&mut hwnd).is_err() || hwnd.is_invalid() {
            return;
        }
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    });
}

/// Called on every window event this file subscribes to. Records the transition
/// and, when the transition is the way back UP from minimised, runs the tenth
/// remedy.
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
    let app = win.app_handle().clone();
    trace(&app, &format!("{kind}: minimized {before} -> {now}"));
    if before && !now {
        // THE CHEAP REMEDY FIRST, AND BY DEFAULT THE ONLY ONE.
        //
        // Measured on the PC on 30/08, same machine, same session, rebuild ON
        // against rebuild OFF, counting the rows of the window rect that carry
        // pixels plus the distinct colours, before minimising and at three
        // moments after the restore:
        //
        //   rebuild OFF   79/79 rows every time, colours 218 / 218 / 218
        //   rebuild ON    79/79 rows every time, colours 192 / 245 / 245
        //
        // Two readings. The grey does NOT come back without the rebuild - the
        // window never goes flat and the colour count does not move by one unit
        // across the three instants. And with the rebuild the count DOES move,
        // because the page is reloading: that is the flash a person sees, and
        // the state it comes back with is not the state it left.
        //
        // So the tenth remedy is opt-in now. It cured nothing here and it was
        // the only thing producing the disturbance - which is the positive
        // control that was missing when it shipped. The machinery stays, whole,
        // behind `TOPICS_WEBVIEW_REBUILD`: if the composition surface ever dies
        // again, the cure is one variable away and the probe above says how to
        // prove it.
        crate::window_recompose::recompose_main_window(&app, "windows/restore");
        rebuild_main_webview(&app);
    }
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
