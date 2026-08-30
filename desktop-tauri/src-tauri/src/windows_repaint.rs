//! Windows: the window comes back from minimised and the webview stops painting.
//!
//! MEASURED on the real machine (`desktop-tauri/scripts/windows-paint-probe.ps1`,
//! which is the instrument, kept in the tree because this measurement had to be
//! redone twice), cropping the window rect and comparing the window with ITSELF
//! before and after, because an absolute threshold cannot tell "does not paint"
//! from "has nothing to show":
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
const REBUILD_OFF_VAR: &str = "TOPICS_NO_WEBVIEW_REBUILD";

/// DID THE WINDOW ACTUALLY COME BACK BLANK? Ask the pixels, because nothing else
/// can tell.
///
/// Every API-level check reports healthy in BOTH states - the header above lists
/// them: the renderer answers `ExecuteScript`, every HWND is present, visible and
/// correctly sized, the window is not layered. The only thing that differs is
/// what is on the glass, so that is what gets read.
///
/// WHAT IT COUNTS, and why not "is it neutral". A flat grey wash is as neutral as
/// the interface, and so is a blurred wallpaper behind an Acrylic backdrop - a
/// probe that asked for neutral pixels answered "79 of 79 rows painted" for a
/// window a screenshot shows as EMPTY, and a working remedy was turned off on the
/// strength of it. What a drawn interface has and a wash does not is EDGES: text,
/// borders, icons. A row counts when two neighbouring samples differ in luminance
/// by more than a wash ever does. Measured on the real machine, minimise +
/// restore, twice per arm: healthy 77/77 rows, blank 1/77. The threshold sits far
/// from both.
///
/// `PrintWindow` with `PW_RENDERFULLCONTENT` reads the window's OWN buffer, so
/// this works while the window is occluded and cannot accidentally measure
/// whatever is in front of it - which `CopyFromScreen` would.
///
/// Returns `None` when the question cannot be answered (window too small, GDI
/// refused, PrintWindow failed). The caller treats that as "do the remedy": a
/// probe that cannot see must not be the reason a broken window stays broken.
#[cfg(target_os = "windows")]
fn rows_with_drawing(hwnd: isize) -> Option<(usize, usize)> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    // `PrintWindow` lives under `Storage::Xps` in this crate's metadata, not next
    // to the other window calls - the flag constant does live in
    // `WindowsAndMessaging`, which is why the two imports look unrelated.
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, PW_RENDERFULLCONTENT};

    /// Only a step this big is ink. A wash - flat fill or blurred wallpaper -
    /// never gets here between neighbouring samples.
    const STEP: i32 = 24;
    /// Sampling grid, in device pixels. Coarse on purpose: this runs on the
    /// restore path and the answer is 77-vs-1, not a close call.
    const ROW_STRIDE: i32 = 12;
    const COL_STRIDE: usize = 3;

    unsafe {
        let hwnd = HWND(hwnd as *mut core::ffi::c_void);
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        // A minimised or absurd window has nothing to say.
        if w < 200 || h < 200 {
            return None;
        }

        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let dc = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        if dc.is_invalid() || bmp.is_invalid() {
            if !dc.is_invalid() {
                let _ = DeleteDC(dc);
            }
            if !bmp.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(bmp.0));
            }
            ReleaseDC(None, screen);
            return None;
        }
        let old = SelectObject(dc, HGDIOBJ(bmp.0));
        let drew = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();

        let mut answer = None;
        if drew {
            // Top-down 32bpp, so row 0 is the top and every pixel is 4 bytes.
            let mut info = BITMAPINFO::default();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: core::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut px = vec![0u8; (w as usize) * (h as usize) * 4];
            let got = GetDIBits(
                dc,
                bmp,
                0,
                h as u32,
                Some(px.as_mut_ptr() as *mut core::ffi::c_void),
                &mut info,
                DIB_RGB_COLORS,
            );
            if got != 0 {
                let stride = (w as usize) * 4;
                let mut rows = 0usize;
                let mut inked = 0usize;
                let mut y = 8;
                while y < h - 8 {
                    rows += 1;
                    let base = (y as usize) * stride;
                    let mut prev = -1i32;
                    let mut x = 12usize;
                    while x < (w as usize) - 12 {
                        let p = base + x * 4;
                        // BGRA in memory.
                        let lum = (299 * px[p + 2] as i32 + 587 * px[p + 1] as i32 + 114 * px[p] as i32) / 1000;
                        if prev >= 0 && (lum - prev).abs() > STEP {
                            inked += 1;
                            break;
                        }
                        prev = lum;
                        x += COL_STRIDE;
                    }
                    y += ROW_STRIDE;
                }
                answer = Some((inked, rows));
            }
        }

        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        answer
    }
}

/// Is the window blank enough to be worth a rebuild?
///
/// A healthy window measured 77 of 77 rows with ink and a blank one 1 of 77, so
/// a tenth of the rows is a floor no real interface can fall under and no blank
/// window can reach. `None` from the probe means "could not look", and that
/// answers YES: the remedy must not be skipped because the probe went blind.
#[cfg(target_os = "windows")]
fn looks_blank(hwnd: isize) -> (bool, String) {
    match rows_with_drawing(hwnd) {
        Some((inked, rows)) if rows > 0 => {
            let blank = inked * 10 < rows;
            (blank, format!("{inked}/{rows} righe con disegno"))
        }
        _ => (true, "sonda cieca".to_string()),
    }
}

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
    // Let the restore land first. The edge is seen from `WM_SIZE`, which arrives
    // while the window is still being put back on screen.
    std::thread::sleep(Duration::from_millis(200));
    rebuild_core(app)
}

/// The rebuild, once the restore has landed.
fn rebuild_core(app: &tauri::AppHandle) -> String {
    use tauri::Manager;
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
    // AND ONLY IF IT REALLY CAME BACK BLANK.
    //
    // The remedy costs a page reload, and this fired on EVERY restore - so a
    // window that came back perfectly still paid it, every time. Two reports,
    // and they are the same one seen from two sides, quoted in their own words:
    // "se nascondi la finestra e la riapri per un attimo non si vede nulla" and "quando riapri la finestra esce vuota per un po'". allow-italian: the reports are quoted verbatim
    // That "for a while" IS the reload, and it lands on top of whatever the app
    // was doing - a chat pane included.
    //
    // A short second sleep before looking: the first 200ms let the restore land,
    // these let the compositor put the first frame up, so a window that is
    // merely SLOW is not read as broken.
    //
    // IT USED TO BE 400ms AND THAT WAS PAID BY EVERYBODY. Measured on the PC,
    // time from restore to the window drawing again: 1540 / 1806 / 1745 ms, of
    // which this wait was a fifth. On a machine where the window really does come
    // back blank every time - and that one does, 1/77 rows three times out of
    // three - the gate never skips, so every millisecond here is added to the
    // blank a person is watching. 60ms is enough for a first frame and cheap
    // enough to spend on a check that might save a whole reload.
    std::thread::sleep(Duration::from_millis(60));
    if let Ok(handle) = win.hwnd() {
        let (blank, misura) = looks_blank(handle.0 as isize);
        if !blank {
            return format!("rebuild: window painted ({misura}), skipped");
        }
        trace(app, &format!("rebuild: window looks blank ({misura})"));
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
    // REBUILDING WHILE THE WINDOW IS HIDDEN DOES NOT WORK, and it was worth
    // asking: the remedy's whole cost is visible, so doing it on the way DOWN
    // would have cost nothing anybody could see. Measured on the PC, time from
    // restore to the window drawing again, three cycles per arm:
    //
    //   rebuild on restore        962 / 814 / 853 ms
    //   rebuild on minimise      1145 / 1149 / 1119 ms
    //
    // And the trace says why it is WORSE rather than merely useless: the webview
    // built while minimised comes back blank too - zero rows with drawing -
    // so the restore rebuilds a SECOND time, and that one falls back to
    // `index.html` because the fresh webview had not navigated yet. Two rebuilds
    // and a lost URL. The surface dies on the way back, not on the way down.
    if before && !now {
        // THE REMEDY STAYS ON, AND HERE IS THE MEASUREMENT THAT SETTLES IT.
        //
        // It was turned opt-in on 30/08 on a reading that could not tell the
        // difference it was reporting. That probe counted, per row of the window
        // rect, whether any sampled pixel was near-neutral, and it answered
        // "79 of 79 rows painted" for BOTH arms - because a flat grey wash is as
        // neutral as the interface, and so is a blurred wallpaper seen through
        // the Acrylic backdrop. It was measuring nothing and it read like a
        // verdict.
        //
        // What a drawn interface has and a wash does not is EDGES. Counting rows
        // that hold a luminance step above 24 between neighbouring samples, on
        // the same machine, same build, minimise then restore, twice per arm:
        //
        //           before    right after   +3s     +11s
        //   OFF      77/77       1/77       1/77    1/77
        //   ON       77/77      77/77      77/77   77/77
        //
        // So the tenth remedy is the only thing standing between a restore and a
        // window that is empty and STAYS empty - the installed 2.2.240 measured
        // 1/77 as well, which is what "the app comes back grey" has always been.
        // The price is the reload it costs, and that reload IS the report "hide
        // the window and reopen it and for a moment you see nothing": a flash on
        // the way back, against a window that never comes back at all.
        //
        // `TOPICS_NO_WEBVIEW_REBUILD` still turns it off, for whoever needs to
        // measure the defect again.
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
