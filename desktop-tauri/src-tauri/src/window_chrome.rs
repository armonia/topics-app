//! Window chrome: traffic lights, theme, always-on-top, vibrancy regions, live
//! resize cover, saved size/position, pop-out windows and window commands.
//! Moved out of lib.rs verbatim.

use super::*;

/// Show/hide the macOS traffic-light buttons (close/miniaturise/zoom) on the
/// given window. WKWebView's frameless `Overlay` titlebar shows them by default;
/// the Electron shell hides them and reveals them only while the Topics menu is
/// open. Tauri exposes no JS API for this, so we toggle the NSWindow's three
/// standard buttons directly. No-op off macOS.
#[cfg(target_os = "macos")]
/// Abstracts "a thing that owns an NSWindow" so `apply_traffic_lights` accepts
/// BOTH `tauri::Window` and `tauri::WebviewWindow`. This matters because once
/// native browser PANES are mounted the main window is multi-webview and
/// `get_webview_window("main")` returns None — so `set_traffic_lights` must
/// resolve it via `get_window("main")` (a plain `Window`, which is retrievable
/// regardless of webview count). Both types expose identical `ns_window()` /
/// `is_fullscreen()` inherent methods; the trait just lets one fn take either.
#[cfg(target_os = "macos")]
pub(crate) trait TlWindow {
    fn tl_ns_window(&self) -> tauri::Result<*mut std::ffi::c_void>;
    fn tl_is_fullscreen(&self) -> tauri::Result<bool>;
}
#[cfg(target_os = "macos")]
impl TlWindow for tauri::Window {
    fn tl_ns_window(&self) -> tauri::Result<*mut std::ffi::c_void> { self.ns_window() }
    fn tl_is_fullscreen(&self) -> tauri::Result<bool> { self.is_fullscreen() }
}
#[cfg(target_os = "macos")]
impl TlWindow for tauri::WebviewWindow {
    fn tl_ns_window(&self) -> tauri::Result<*mut std::ffi::c_void> { self.ns_window() }
    fn tl_is_fullscreen(&self) -> tauri::Result<bool> { self.is_fullscreen() }
}

#[cfg(target_os = "macos")]
pub(crate) fn apply_traffic_lights<W: TlWindow>(window: &W, visible: bool) {
    use crate::mac::*;

    let ptr = match window.tl_ns_window() {
        Ok(p) => p as id,
        Err(e) => {
            eprintln!("[chrome] ns_window() failed: {e}");
            return;
        }
    };
    let mut hit = 0;
    unsafe {
        for button in [
            NS_WINDOW_CLOSE_BUTTON,
            NS_WINDOW_MINIATURIZE_BUTTON,
            NS_WINDOW_ZOOM_BUTTON,
        ] {
            let b: id = msg_send![ptr, standardWindowButton: button];
            if b != nil {
                let _: () = msg_send![b, setHidden: !visible];
                hit += 1;
            }
        }
        // HIDE repaint fix. A SHOW paints instantly (the reposition setFrame:
        // below — or, when it's skipped, unhiding the view — forces a redraw),
        // but a HIDE via `setHidden:true` alone does NOT invalidate the vacated
        // region on this frameless titleBarStyle:Overlay window: the buttons
        // stay PAINTED until the next titlebar relayout (a focus/resize). That
        // is the "semafori restano dopo aver chiuso il menu logo" bug — they
        // only vanished once the user next touched the window. Force the
        // titlebar container to redraw now so the hide lands immediately.
        // Guarded to the hide path so the show path keeps its existing redraw.
        if !visible {
            let close: id = msg_send![ptr, standardWindowButton: NS_WINDOW_CLOSE_BUTTON];
            if close != nil {
                let sv: id = msg_send![close, superview];
                if sv != nil {
                    let _: () = msg_send![sv, setNeedsDisplay: true];
                    let _: () = msg_send![sv, displayIfNeeded];
                }
            }
        }
        // Electron parity: trafficLightPosition { x: 12, y: 12 } (from the
        // window's top-left). AppKit resets the standard buttons' frames on
        // every titlebar relayout, which is why the Resized/Focused window
        // events re-run apply_traffic_lights (see on_window_event). Skipped in
        // fullscreen: there the buttons live in the auto-managed toolbar and
        // moving them fights AppKit.
        //
        // DEFENSIVE — this is a "make it prettier" nicety, NEVER a correctness
        // requirement, so it must fail SAFE: if anything about the container
        // looks off, we leave the buttons at AppKit's default frames (visible,
        // just not at x=12). The failure it guards against is the buttons
        // vanishing entirely (the reported "semafori GONE"):
        //   • On a titleBarStyle:Overlay + hidden-title transparent window the
        //     buttons' superview can be the full-height theme frame, not a ~28px
        //     titlebar strip. Its bounds.height is then the WHOLE window height,
        //     and the non-flipped y = height - 12 - h places the buttons hundreds
        //     of px down — off the visible titlebar band → invisible.
        //   • The y coordinate orientation (flipped vs not) is only meaningful
        //     relative to a titlebar-sized container; on a full-height frame the
        //     two branches disagree about which end "12 from the top" is.
        // So we only reposition when the superview reads like a titlebar
        // (bounds.height < 60) and clamp every final origin back inside those
        // bounds. Anything else: no-op, keep AppKit defaults.
        if visible && !window.tl_is_fullscreen().unwrap_or(false) {
            let close: id = msg_send![ptr, standardWindowButton: NS_WINDOW_CLOSE_BUTTON];
            if close != nil {
                let sv0: id = msg_send![close, superview];
                let svb: NSRect = if sv0 != nil { msg_send![sv0, bounds] } else { NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)) };
                // Container must look like a titlebar strip. A full-height theme
                // frame (Overlay + hidden title) fails this, so we bail and keep
                // AppKit's own (visible) positions rather than fling the buttons
                // off-screen.
                let looks_like_titlebar = sv0 != nil && svb.size.height > 0.0 && svb.size.height < 60.0;
                if looks_like_titlebar {
                    let flipped: bool = msg_send![sv0, isFlipped];
                    // Explicit, uniform x positions instead of preserving AppKit's
                    // natural spacing: on this custom-titlebar (hidden-title Overlay)
                    // window AppKit lays the standard buttons out with a wider-than-
                    // native pitch, so the cluster reads as "too far apart". Pin each
                    // button to LEFT_INSET + i*PITCH to reproduce the native group.
                    // The macOS standard is three 12px circles with 8px between
                    // them: a 20px origin pitch and a 52px cluster. LEFT_INSET=12
                    // keeps Electron's trafficLightPosition.x, so the cluster spans
                    // x=12..64 in the window. The client mirrors these numbers in
                    // `client/src/lib/shell/windowControlsGeometry.ts`.
                    const LEFT_INSET: f64 = 12.0;
                    const PITCH: f64 = 20.0;
                    for (i, button) in [
                        NS_WINDOW_CLOSE_BUTTON,
                        NS_WINDOW_MINIATURIZE_BUTTON,
                        NS_WINDOW_ZOOM_BUTTON,
                    ]
                    .into_iter()
                    .enumerate()
                    {
                        let b: id = msg_send![ptr, standardWindowButton: button];
                        if b == nil {
                            continue;
                        }
                        let sv: id = msg_send![b, superview];
                        if sv == nil {
                            continue;
                        }
                        let mut f: NSRect = msg_send![b, frame];
                        // Close at LEFT_INSET, each subsequent button one PITCH to the
                        // right — a fixed tight cluster regardless of AppKit's default.
                        f.origin.x = LEFT_INSET + (i as f64) * PITCH;
                        // Vertically center the cluster on the APP's own titlebar, not
                        // the shorter native strip the buttons live in. Measured: the
                        // AppKit titlebar container is 32px tall and top-flush with the
                        // window, but the app draws a 40px drag-region header
                        // (App.tsx `.app-drag-region` = h-10) under it (Overlay style),
                        // so centering in the 32px strip left the lights ~4px high in
                        // the visual band. Target the 40px header's center instead; the
                        // 14px buttons still fit inside the 32px strip (span 13..27px).
                        const APP_TITLEBAR_H: f64 = 40.0;
                        let center_from_top = APP_TITLEBAR_H / 2.0;
                        // Centre the DOT, not the button frame. AppKit draws the 12px
                        // disc at the top edge of a taller (14x16) frame, so a frame
                        // centred on the row lands the disc ~2px above it. Measured
                        // 2026-09-07 on the live window (v2.2.274, 40px row): discs
                        // at y 12-25 (centre 18.5) against the wordmark's capitals at
                        // 15-26 (centre 20.5) and the row's buttons at 20. The
                        // client's `TRAFFIC_LIGHT_DOT_PX` is this same 12.
                        const DOT: f64 = 12.0;
                        f.origin.y = if flipped {
                            center_from_top - DOT / 2.0
                        } else {
                            svb.size.height - (center_from_top - DOT / 2.0) - f.size.height
                        }
                        .max(0.0);
                        // Clamp inside the container so a surprising bounds/frame
                        // can never push a button out of view. Worst case the
                        // group crowds an edge — still on screen, still clickable.
                        let max_x = (svb.size.width - f.size.width).max(0.0);
                        let max_y = (svb.size.height - f.size.height).max(0.0);
                        if f.origin.x < 0.0 { f.origin.x = 0.0; }
                        if f.origin.x > max_x { f.origin.x = max_x; }
                        if f.origin.y < 0.0 { f.origin.y = 0.0; }
                        if f.origin.y > max_y { f.origin.y = max_y; }
                        let _: () = msg_send![b, setFrame: f];
                    }
                } else {
                    eprintln!(
                        "[chrome] traffic-light reposition skipped: superview not titlebar-like (h={}) — keeping AppKit defaults",
                        svb.size.height
                    );
                }
            }
        }
    }
    let _ = hit;
}

/// Off macOS there are no traffic-light buttons. `TlWindow` is a macOS-only
/// trait, so the stub takes an unbounded window type and does nothing — the
/// (ungated) call sites then compile everywhere.
#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_traffic_lights<W>(_window: &W, _visible: bool) {}

/// Reveal or hide the window's traffic lights. Driven by the client when the
/// Topics dropdown opens/closes (mirrors Electron's `window:showTrafficLights`).
#[tauri::command]
pub(crate) fn set_traffic_lights(app: tauri::AppHandle, visible: bool) {
    // Resolve the main window via the AppHandle (label "main") rather than taking a
    // `WebviewWindow` param. CRUCIAL: once native browser PANES (child webviews) are
    // mounted the main window is multi-webview, and `get_webview_window("main")` then
    // returns None (verified via stderr: "main window NOT found, no-op" on logo click
    // with a browser pane open) — which silently killed the traffic lights. `get_window`
    // looks up the *window* by label and returns a plain `tauri::Window` regardless of
    // webview count; `apply_traffic_lights` is generic over both handle types.
    TRAFFIC_LIGHTS_VISIBLE.store(visible, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // no_abort: apply_traffic_lights reaches the window dispatcher /
        // ns_window — same poisoned-mutex SIGABRT class (see no_abort doc).
        let _ = no_abort("set_traffic_lights", || {
            match app.get_window("main") {
                Some(win) => {
                    eprintln!("[chrome] set_traffic_lights(visible={visible}) — applying to main window");
                    apply_traffic_lights(&win, visible);
                }
                None => eprintln!("[chrome] set_traffic_lights(visible={visible}) — main window NOT found, no-op"),
            }
            Ok(())
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

/// Set the NSWindow's appearance to match the app's chosen light/dark theme.
/// The traffic lights and — crucially — the per-region NSVisualEffectViews read
/// the window's effective appearance, so a single setAppearance also re-tints the
/// vibrancy material (light frost in light mode, dark frost in dark mode) with no
/// per-view work. Electron does this via `nativeTheme.themeSource`; we set the
/// NSAppearance directly since Tauri exposes no JS API for it. No-op off macOS.
///
/// `dark: None` = «TOGLI l'override», cioè `setAppearance: nil`, che rimette la
/// finestra a EREDITARE da NSApp — ed è il caso che mancava.
///
/// Perché mancava è tutto il bug della modalità «Sistema». La WKWebView eredita
/// l'effectiveAppearance dalla sua finestra, quindi appena si pinna Aqua o
/// DarkAqua `prefers-color-scheme` dentro la pagina smette di riportare l'OS e
/// riporta NOI. Il giro si chiudeva su sé stesso: tema salvato 'light' → al
/// montaggio si pinna Aqua → l'utente sceglie «Sistema» → `matchMedia` legge
/// Aqua, che è il nostro valore → resta chiaro. «Funzionava» solo passando da
/// «Scuro», perché a quel punto il valore riletto era l'altro.
///
/// Rimesso a `nil`, il resto lo fa il listener che c'è già: quando
/// l'effectiveAppearance cambia, WKWebView emette il `change` sulla media query
/// e `useTheme` riallinea classe e meta. Il materiale della vibrancy segue
/// l'effectiveAppearance da sé, quindi il frost non regredisce.
#[cfg(target_os = "macos")]
pub(crate) fn apply_appearance(window: &tauri::Window, dark: Option<bool>) {
    use crate::mac::*;

    let ptr = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    unsafe {
        let Some(dark) = dark else {
            let _: () = msg_send![ptr, setAppearance: nil];
            return;
        };
        let name = if dark {
            "NSAppearanceNameDarkAqua"
        } else {
            "NSAppearanceNameAqua"
        };
        let ns_name = nsstring(name);
        let ns_name: id = objc2::rc::Retained::as_ptr(&ns_name) as id;
        let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: ns_name];
        if appearance != nil {
            let _: () = msg_send![ptr, setAppearance: appearance];
        }
    }
}

/// Client-driven: sync native chrome (window appearance + vibrancy tint) to the
/// theme MODE chosen by the user ("dark" | "light" | "system") — gli stessi tre
/// valori che accetta `nativeTheme.themeSource` di Electron.
///
/// Arriva la MODALITÀ, non il tema risolto, e la differenza è il bug: qualunque
/// stringa diversa da "dark" veniva mappata su `dark=false`, quindi "system"
/// pinnava Aqua. Il client risolveva `system` con `matchMedia` e ci passava il
/// risultato — ma quel `matchMedia` legge l'appearance della finestra, che
/// eravamo stati noi a fissare: si rileggeva addosso. Qui "system" è un caso a
/// sé e vale «togli l'override» (vedi `apply_appearance`).
///
/// Itera sulle app-shell (`main` più le `detach-*`) e non su "main" e basta:
/// con una sola finestra cablata, una pop-out non veniva mai pinnata, quindi con
/// un tema FORZATO aveva traffic lights e frost sull'appearance del SISTEMA
/// invece che sul tema scelto — la stessa regressione che questo codice era nato
/// per chiudere, riaperta dalle finestre multiple. Le `browserpane-*` restano
/// fuori: caricano il web aperto, non l'app.
#[tauri::command]
pub(crate) fn set_theme(app: tauri::AppHandle, theme: String) {
    // Same multi-webview safety as `set_traffic_lights`: resolve windows via the
    // AppHandle, not a `WebviewWindow` param (rejected once browser panes mount).
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let dark = match theme.as_str() {
            "dark" => Some(true),
            "light" => Some(false),
            // "system" — e qualunque valore che non riconosciamo: non inventare
            // un tema, lascia decidere l'OS.
            _ => None,
        };
        // no_abort: run_on_main_thread locks the window dispatcher — same
        // poisoned-mutex SIGABRT class (see no_abort doc).
        let _ = no_abort("set_theme", || {
            // `windows()`: l'appearance si pinna su una NSWindow, e la mappa
            // filtrata perde proprio le finestre che hanno una pane browser
            // aperta (vedi `reload_all_ui_windows`). Il risultato era che con
            // una pane aperta il tema non arrivava più al cromo nativo: semafori
            // e titlebar restavano sull'appearance vecchia sotto un contenuto
            // già cambiato, e in modo «Sistema» il `setAppearance: nil` che
            // toglie il pin non partiva mai — quindi la finestra restava
            // inchiodata all'ultimo tema forzato e, siccome la WKWebView eredita
            // l'effectiveAppearance dalla finestra, «Sistema» smetteva di
            // seguire il Mac. Nessun errore da nessuna parte: `set_theme`
            // tornava Ok.
            for (label, win) in app.windows() {
                if label != "main" && !label.starts_with("detach-") {
                    continue;
                }
                let win2 = win.clone();
                let _ = win.run_on_main_thread(move || apply_appearance(&win2, dark));
            }
            Ok(())
        });
    }
    // Windows: no NSWindow to re-tint, but the DWM backdrop follows the window
    // theme, so the same command has to reach it. The mode mapping and the window
    // set live next to the effect that uses them; this line is a no-op off
    // Windows, which is what keeps it unguarded and inside what a Mac
    // `cargo check` reads (see `mod windows_acrylic`).
    //
    // no_abort for the same reason as the macOS arm above, and it is not
    // decoration: `set_effects` and `set_theme` both reach the window
    // dispatcher, whose mutex stays poisoned once anything has panicked while
    // holding it. `set_theme` is a SYNC command, so a panic here unwinds into
    // the FFI boundary and aborts the whole app rather than failing one call.
    let _ = no_abort("set_theme_backdrop", || {
        windows_acrylic::apply_theme_mode(&app, &theme);
        Ok(())
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (app, theme);
}

/// Toggle the main window's always-on-top (floating) state and remember it, so
/// the global hotkey and the menu item stay in sync. Electron parity:
/// electron-app/main.ts `toggleAlwaysOnTop` (same Cmd/Ctrl+Alt+T global shortcut).
pub(crate) fn toggle_always_on_top(app: &tauri::AppHandle) {
    use tauri::Manager;
    let next = !ALWAYS_ON_TOP.fetch_xor(true, Ordering::Relaxed);
    if let Some(win) = app.get_window("main") {
        let _ = win.set_always_on_top(next);
    }
    // Persist so the floating state survives relaunch (Electron parity — it was an
    // in-memory AtomicBool that reset to off every launch).
    if let Some(path) = aot_file(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, if next { "true" } else { "false" });
    }
}

/// Path of the always-on-top store: `<app_config_dir>/topics-aot.json`.
pub(crate) fn aot_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("topics-aot.json"))
}

/// Read the persisted always-on-top flag (default false).
pub(crate) fn read_aot(app: &tauri::AppHandle) -> bool {
    aot_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

// ─────────────────────── Per-region vibrancy (macOS) ───────────────────────
//
// Tauri's `windowEffects` is whole-window — one NSVisualEffectView covers
// everything, so a transparent floating-splits gap shows FROSTED material, never
// the clear desktop. Electron gets "frosted cards + clear gaps" with a native
// addon that paints a SEPARATE NSVisualEffectView under each card. We do the
// same: the window is plain-transparent, the client measures each card/sidebar
// rect and calls `vibrancy_set_regions`, and we keep one NSVisualEffectView per
// region (inserted BELOW the webview, blending behind the window). Where the
// webview is translucent (chrome) the vibrancy shows; the gaps between regions
// have no view, so they fall through to the real desktop.

#[derive(Deserialize)]
pub(crate) struct VibRegion {
    pub(crate) id: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    #[serde(default)]
    pub(crate) radius: f64,
}

/// Per-window frost views, keyed by NSWindow pointer → (region id → NSView ptr).
/// MUST be keyed per window: a detached (pop-out) window mounts the same App and
/// pushes the SAME region ids (r0, r1, …), so a single global id→view map made the
/// detached window's push move/remove the MAIN window's frost views (the "pop-out
/// nukes the main frost" bug). The NSWindow pointer scopes each window's views to
/// its own contentView; `window_detach` purges a window's entry on Destroyed so a
/// reused pointer address can't inherit freed view pointers.
#[cfg(target_os = "macos")]
pub(crate) fn vibrancy_views() -> &'static std::sync::Mutex<std::collections::HashMap<usize, std::collections::HashMap<String, usize>>> {
    static V: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<usize, std::collections::HashMap<String, usize>>>> =
        std::sync::OnceLock::new();
    V.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Full-window frost shown DURING a window-edge resize, keyed per NSWindow pointer
/// (absent/0 = none). Per-window for the same reason as `vibrancy_views`: each
/// window's live-resize cover is independent. See `vibrancy_resize_cover`.
#[cfg(target_os = "macos")]
pub(crate) fn vibrancy_cover_slot() -> &'static std::sync::Mutex<std::collections::HashMap<usize, usize>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<usize, usize>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// `hitTest:` override for the frost views: always return nil so the
/// NSVisualEffectView is CLICK-THROUGH. Without this, once Tauri reorders the
/// browser-pane child webviews (or one is parked off-screen) the exposed frost
/// view swallows physical clicks over its rect — the "vibrancy hitTest eats
/// clicks" bug the Electron app already burned a trail on.
#[cfg(target_os = "macos")]
extern "C" fn region_hit_test(
    _this: &objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    _point: objc2_foundation::NSPoint,
) -> *mut objc2::runtime::AnyObject {
    std::ptr::null_mut()
}

/// Lazily register `TopicsRegionVibrancyView`: an NSVisualEffectView subclass
/// whose only change is the click-through `hitTest:` above. Registered once per
/// process (OnceLock); subsequent calls return the cached class.
#[cfg(target_os = "macos")]
pub(crate) fn region_vibrancy_class() -> &'static objc2::runtime::AnyClass {
    use crate::mac::*;
    use objc2::runtime::ClassBuilder;
    static PTR: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let p = *PTR.get_or_init(|| {
        let superclass = class!(NSVisualEffectView);
        let mut decl = ClassBuilder::new(c"TopicsRegionVibrancyView", superclass)
            .expect("register TopicsRegionVibrancyView");
        unsafe {
            decl.add_method(
                sel!(hitTest:),
                region_hit_test as extern "C" fn(_, _, _) -> _,
            );
        }
        decl.register() as *const Class as usize
    });
    unsafe { &*(p as *const Class) }
}

/// Reconcile the live NSVisualEffectViews to exactly the requested regions
/// (create new, move/resize existing, remove dropped). MUST run on the main
/// thread (AppKit view mutation).
#[cfg(target_os = "macos")]
pub(crate) fn apply_vibrancy_regions(window: &tauri::Window, regions: Vec<VibRegion>) {
    use crate::mac::*;

    let ns_window = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return;
        }
        let wkey = ns_window as usize;
        // A client push means a gesture SETTLED (during a live window resize the JS
        // is starved, so this never runs mid-drag) — tear down THIS window's full-
        // window resize cover so the per-region cards + clear gaps come back. Own
        // lock scope, before `vibrancy_views`, matching the cover handler's order.
        {
            let mut covers = vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ptr) = covers.remove(&wkey) {
                if ptr != 0 {
                    let v = ptr as id;
                    let _: () = msg_send![v, removeFromSuperview];
                }
            }
        }
        let bounds: NSRect = msg_send![content_view, bounds];
        let content_h = bounds.size.height;

        let mut all = vibrancy_views().lock().unwrap_or_else(|e| e.into_inner());
        let map = all.entry(wkey).or_default();
        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();

        // CRITICAL for perf: a layer-backed NSView's setFrame/setCornerRadius triggers
        // an IMPLICIT 0.25s Core Animation by default. During a sidebar/divider drag we
        // push several frames/sec, so those animations STACK and the WindowServer keeps
        // recompositing the (expensive) behind-window blur for ~450ms after each push —
        // the FPS drop on sidebar toggle. Disabling actions makes every frame change
        // INSTANT: one discrete recomposite per push, no animation tail.
        let _: () = msg_send![class!(CATransaction), begin];
        let _: () = msg_send![class!(CATransaction), setDisableActions: true];

        for r in &regions {
            keep.insert(r.id.clone());
            // Web rects are top-left origin; NSView is bottom-left → flip Y.
            let ns_y = content_h - r.y - r.height;
            let frame = NSRect::new(NSPoint::new(r.x, ns_y), NSSize::new(r.width, r.height));

            if let Some(&ptr) = map.get(&r.id) {
                let v = ptr as id;
                let _: () = msg_send![v, setFrame: frame];
                let layer: id = msg_send![v, layer];
                if layer != nil {
                    let _: () = msg_send![layer, setCornerRadius: r.radius];
                }
            } else {
                // Click-through subclass (hitTest:->nil) so the frost never
                // steals pointer events from panes above/around it.
                let v: id = msg_send![region_vibrancy_class(), alloc];
                let v: id = msg_send![v, initWithFrame: frame];
                // macOS native frosted-glass = NSVisualEffectView: material sidebar=7
                // (same as Electron), blendingMode behindWindow=0, state active=1.
                // NOTE: do NOT set a negative layer.zPosition on Tauri — verified to
                // render the material CLEAR here (the WindowServer drops the behind-
                // window blur pass for a sub-zero layer in this single-WKWebView model;
                // Electron can set it because its content is a separate Chromium view).
                // `addSubview:positioned:NSWindowBelow` already orders it behind the
                // transparent webview, which is all the blur needs.
                let _: () = msg_send![v, setMaterial: 7i64];
                let _: () = msg_send![v, setBlendingMode: 0i64];
                let _: () = msg_send![v, setState: 1i64];
                let _: () = msg_send![v, setWantsLayer: true];
                let layer: id = msg_send![v, layer];
                if layer != nil {
                    let _: () = msg_send![layer, setCornerRadius: r.radius];
                    let _: () = msg_send![layer, setMasksToBounds: true];
                }
                // Insert at the very bottom so it sits BEHIND the (transparent) webview.
                let _: () = msg_send![content_view, addSubview: v, positioned: -1i64, relativeTo: nil];
                map.insert(r.id.clone(), v as usize);
            }
        }

        // Drop views whose region disappeared.
        let stale: Vec<String> = map.keys().filter(|k| !keep.contains(*k)).cloned().collect();
        for k in stale {
            if let Some(ptr) = map.remove(&k) {
                let v = ptr as id;
                let _: () = msg_send![v, removeFromSuperview];
            }
        }
        let _: () = msg_send![class!(CATransaction), commit];
    }
}

/// Map CSS cubic-bezier control points → the matching named CAMediaTimingFunction.
/// The sidebar transition is `ease` = (0.25,0.1,0.25,1) = kCAMediaTimingFunctionDefault
/// EXACTLY, so this gives perfect lockstep with the CSS curve for the real case; other
/// CSS keywords map to their CA equivalents, anything else falls back to Default. (We
/// match names rather than build from raw control points because the objc crate can't
/// cleanly express CAMediaTimingFunction's `initWithControlPoints::::` selector.)
#[cfg(target_os = "macos")]
pub(crate) unsafe fn ca_timing_for(timing: [f64; 4]) -> *mut objc2::runtime::AnyObject {
    use crate::mac::*;
    #[link(name = "QuartzCore", kind = "framework")]
    extern "C" {
        static kCAMediaTimingFunctionDefault: id;
        static kCAMediaTimingFunctionLinear: id;
        static kCAMediaTimingFunctionEaseIn: id;
        static kCAMediaTimingFunctionEaseOut: id;
        static kCAMediaTimingFunctionEaseInEaseOut: id;
    }
    let approx = |a: [f64; 4], b: [f64; 4]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.01);
    let name: id = if approx(timing, [0.0, 0.0, 1.0, 1.0]) {
        kCAMediaTimingFunctionLinear
    } else if approx(timing, [0.42, 0.0, 1.0, 1.0]) {
        kCAMediaTimingFunctionEaseIn
    } else if approx(timing, [0.0, 0.0, 0.58, 1.0]) {
        kCAMediaTimingFunctionEaseOut
    } else if approx(timing, [0.42, 0.0, 0.58, 1.0]) {
        kCAMediaTimingFunctionEaseInEaseOut
    } else {
        kCAMediaTimingFunctionDefault // (0.25,0.1,0.25,1) = CSS `ease`
    };
    msg_send![class!(CAMediaTimingFunction), functionWithName: name]
}

/// Hand a FIXED, known move (the sidebar width transition) to AppKit's animator: each
/// existing frost view's frame is set through its `animator` proxy inside an
/// NSAnimationContext grouping with the CSS duration + matched timing function. AppKit
/// then drives the frame change on the Core Animation / WindowServer clock — the SAME
/// clock compositing the WKWebView's CSS transition — so the frost rides the move
/// continuously (no per-frame IPC, no ~5 discrete steps). The transitionend settle push
/// (`apply_vibrancy_regions`) pins pixel-exact final rects.
#[cfg(target_os = "macos")]
pub(crate) fn apply_vibrancy_animation(window: &tauri::Window, regions: Vec<VibRegion>, duration_ms: f64, timing: [f64; 4]) {
    use crate::mac::*;

    let ns_window = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return;
        }
        let wkey = ns_window as usize;
        // Tear down THIS window's resize cover so the per-region cards animate
        // (parity with apply_vibrancy_regions' lock order).
        {
            let mut covers = vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ptr) = covers.remove(&wkey) {
                if ptr != 0 {
                    let v = ptr as id;
                    let _: () = msg_send![v, removeFromSuperview];
                }
            }
        }
        let bounds: NSRect = msg_send![content_view, bounds];
        let content_h = bounds.size.height;
        let all = vibrancy_views().lock().unwrap_or_else(|e| e.into_inner());
        let empty = std::collections::HashMap::new();
        let map = all.get(&wkey).unwrap_or(&empty);

        let tf = ca_timing_for(timing);
        let _: () = msg_send![class!(NSAnimationContext), beginGrouping];
        let ctx: id = msg_send![class!(NSAnimationContext), currentContext];
        let _: () = msg_send![ctx, setDuration: (duration_ms / 1000.0)];
        let _: () = msg_send![ctx, setTimingFunction: tf];
        for r in &regions {
            let ns_y = content_h - r.y - r.height; // web top-left → NSView bottom-left
            let frame = NSRect::new(NSPoint::new(r.x, ns_y), NSSize::new(r.width, r.height));
            if let Some(&ptr) = map.get(&r.id) {
                let v = ptr as id;
                let anim: id = msg_send![v, animator];
                let _: () = msg_send![anim, setFrame: frame]; // CA-driven, WindowServer clock
            }
        }
        let _: () = msg_send![class!(NSAnimationContext), endGrouping];
    }
}

/// Client-driven: hand the sidebar width toggle (a fixed CSS transition) to AppKit's
/// animator in ONE IPC. See `apply_vibrancy_animation`.
#[tauri::command]
pub(crate) fn vibrancy_animate_regions(window: tauri::Window, regions: Vec<VibRegion>, duration_ms: f64, timing: [f64; 4]) {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        // no_abort ×2: `run_on_main_thread` locks the window dispatcher on
        // THIS thread (poisoned-mutex → SIGABRT class, see no_abort doc) and
        // the closure runs inside the main runloop's FFI boundary where an
        // unwind also aborts. This fires on every sidebar toggle.
        let _ = no_abort("vibrancy_animate_regions", || {
            window
                .run_on_main_thread(move || {
                    let _ = no_abort("vibrancy_animate_regions.main", || {
                        apply_vibrancy_animation(&win, regions, duration_ms, timing);
                        Ok(())
                    });
                })
                .map_err(|e| e.to_string())
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, regions, duration_ms, timing);
}

/// Client-driven: set the full list of vibrancy regions (cards/sidebar) in
/// window coords. Empty list clears all (e.g. leaving floating mode → fall back
/// to no per-region vibrancy). No-op off macOS.
#[tauri::command]
pub(crate) fn vibrancy_set_regions(window: tauri::Window, regions: Vec<VibRegion>) {
    // Param is `Window`, NOT `WebviewWindow`: once the layout mounts native browser
    // PANES (child webviews of the main window), the window is multi-webview and the
    // `WebviewWindow` extractor rejects every invoke with "current webview is not a
    // WebviewWindow" — silently freezing the frost at its boot layout (the root cause
    // of "la vibrancy non segue" on every drag/resize/sidebar). `Window` resolves the
    // invoking webview's parent window regardless of how many webviews it hosts.
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        // no_abort ×2 — same rationale as vibrancy_animate_regions, but this
        // one fires per FRAME during drag/resize: the highest-frequency
        // dispatcher caller in the app.
        let _ = no_abort("vibrancy_set_regions", || {
            window
                .run_on_main_thread(move || {
                    let _ = no_abort("vibrancy_set_regions.main", || {
                        apply_vibrancy_regions(&win, regions);
                        Ok(())
                    });
                })
                .map_err(|e| e.to_string())
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, regions);
}

// ── Native resize cover: one full-window frost that AUTORESIZES with the window ──
//
// A live WINDOW-edge resize runs the main runloop in NSEventTrackingRunLoopMode.
// Two things are starved for the whole drag: (a) the JS→IPC path that repositions
// the per-region views (WKWebView JS doesn't run), and (b) — critically — tao's
// queued `WindowEvent::Resized` is only DRAINED by its run-loop observer when the
// loop goes idle, which during a continuous drag happens at gesture END, not per
// step. So we CANNOT drive tracking off `Resized` (it arrives once, on mouse-up →
// "draggo e non segue"). Instead:
//   • `NSWindowWillStartLiveResize` (a notification, posted SYNCHRONOUSLY when the
//     drag begins) → swap the per-region cards for ONE full-window frost cover.
//   • The cover carries an autoresizing mask (NSViewWidth|HeightSizable), so AppKit
//     itself resizes it on every `setFrameSize:` of the content view DURING the
//     drag — no event, no IPC, perfectly live.
//   • `apply_vibrancy_regions` (JS push on settle) tears the cover down and restores
//     the per-region cards + clear gaps. (We deliberately do NOT remove it on
//     `DidEndLiveResize` — that would flash transparent until JS re-pushes.)
// The clear gaps are briefly covered while you drag. Divider/sidebar are DOM drags
// (window size constant → no live resize) and keep their JS rAF loop unchanged.
// `vibrancy_resize_cover` (below) remains as the PROGRAMMATIC-resize path (set_size
// / zoom DO deliver `Resized` promptly, no live-resize notification fires for them).

/// Build + insert the full-window frost cover UNDER the (transparent) webview, with
/// an autoresizing mask so AppKit keeps it filling the content view through every
/// live-resize step with no event/IPC. Caller holds the cover slot + has drained the
/// per-region cards. Returns the new view ptr.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn vibrancy_insert_cover(content_view: *mut objc2::runtime::AnyObject, bounds: objc2_foundation::NSRect) -> *mut objc2::runtime::AnyObject {
    use crate::mac::*;
    let _: () = msg_send![content_view, setAutoresizesSubviews: true];
    let v: id = msg_send![region_vibrancy_class(), alloc];
    let v: id = msg_send![v, initWithFrame: bounds];
    // Match the per-region cards: material sidebar=7, behindWindow, active (no
    // zPosition — see apply_vibrancy_regions; it renders clear on Tauri).
    let _: () = msg_send![v, setMaterial: 7i64];
    let _: () = msg_send![v, setBlendingMode: 0i64];
    let _: () = msg_send![v, setState: 1i64];
    let _: () = msg_send![v, setWantsLayer: true];
    // NSViewWidthSizable(2) | NSViewHeightSizable(16) = 18 → fixed margins to all
    // edges (here 0) maintained as the superview grows/shrinks ⇒ always full-window.
    let _: () = msg_send![v, setAutoresizingMask: 18u64];
    let _: () = msg_send![content_view, addSubview: v, positioned: -1i64, relativeTo: nil];
    v
}

#[cfg(target_os = "macos")]
pub(crate) fn vibrancy_resize_cover(window: &tauri::WebviewWindow) {
    use crate::mac::*;

    let ns_window = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return;
        }
        let wkey = ns_window as usize;
        let covers = vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner());
        let cover_ptr = covers.get(&wkey).copied().unwrap_or(0);
        // A programmatic / spurious *same-size* `Resized` (tray re-show, Space or
        // display switch, scale/focus change all emit one at the SAME size) must NOT
        // raise a cover here: there is no continuous drag to hide, and the cover's
        // ONLY teardown is a JS settle push that the client dedupes away when the size
        // is unchanged — so a cover raised on this path strands as one flat
        // full-window frost over everything ("tutte grigie", recurring on every
        // tray/Space round-trip). Genuine live-edge drags are covered via
        // on_live_resize_start → vibrancy_begin_cover and self-heal on drag-end (the
        // size actually changed, so the settle push isn't deduped and removes it).
        // Here we ONLY keep an already-raised live-resize cover glued to the new size.
        if cover_ptr == 0 {
            return;
        }
        let bounds: NSRect = msg_send![content_view, bounds];
        let v = cover_ptr as id;
        let _: () = msg_send![v, setFrame: bounds];
    }
}

/// Show the full-window frost cover for a live window-edge resize, operating
/// directly on the `NSWindow` (the notification's `object`) — the per-region cards
/// are removed and a single autoresizing cover is inserted, which AppKit then keeps
/// glued to the window through the whole drag. No-op if a cover is already up or no
/// frost was ever placed (web gate / pre-mount).
#[cfg(target_os = "macos")]
pub(crate) unsafe fn vibrancy_begin_cover(ns_window: *mut objc2::runtime::AnyObject) {
    use crate::mac::*;
    if ns_window == nil {
        return;
    }
    let content_view: id = msg_send![ns_window, contentView];
    if content_view == nil {
        return;
    }
    let wkey = ns_window as usize;
    let mut covers = vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner());
    if covers.get(&wkey).copied().unwrap_or(0) != 0 {
        return; // already covering
    }
    {
        let mut all = vibrancy_views().lock().unwrap_or_else(|e| e.into_inner());
        match all.get_mut(&wkey) {
            Some(map) if !map.is_empty() => {
                for (_, ptr) in map.drain() {
                    let v = ptr as id;
                    let _: () = msg_send![v, removeFromSuperview];
                }
            }
            // nothing placed yet for THIS window — don't frost a bare window
            _ => return,
        }
    }
    let bounds: NSRect = msg_send![content_view, bounds];
    covers.insert(wkey, vibrancy_insert_cover(content_view, bounds) as usize);
}

/// `NSWindowWillStartLiveResize` observer callback → raise the cover for the drag.
#[cfg(target_os = "macos")]
extern "C" fn on_live_resize_start(
    _this: &objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    notif: *mut objc2::runtime::AnyObject,
) {
    use crate::mac::*;
    unsafe {
        let ns_window: id = msg_send![notif, object];
        vibrancy_begin_cover(ns_window);
    }
}

/// `NSWindowDidEndLiveResize` observer callback. Intentionally a near-no-op: we
/// LEAVE the cover up and let the JS settle push (`apply_vibrancy_regions`) swap it
/// back to per-region cards, so there's no transparent flash between drag-end and
/// the first reflowed push.
#[cfg(target_os = "macos")]
extern "C" fn on_live_resize_end(
    _this: &objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    _notif: *mut objc2::runtime::AnyObject,
) {
}

/// Lazily register `TopicsLiveResizeObserver` with the two notification callbacks,
/// returning a (leaked, process-lifetime) instance to register with the default
/// NSNotificationCenter.
#[cfg(target_os = "macos")]
pub(crate) fn live_resize_observer_instance() -> *mut objc2::runtime::AnyObject {
    use crate::mac::*;
    use objc2::runtime::ClassBuilder;
    static PTR: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let class_ptr = *PTR.get_or_init(|| {
        let superclass = class!(NSObject);
        let mut decl = ClassBuilder::new(c"TopicsLiveResizeObserver", superclass)
            .expect("register TopicsLiveResizeObserver");
        unsafe {
            decl.add_method(
                sel!(onLiveResizeStart:),
                on_live_resize_start as extern "C" fn(_, _, _),
            );
            decl.add_method(
                sel!(onLiveResizeEnd:),
                on_live_resize_end as extern "C" fn(_, _, _),
            );
        }
        decl.register() as *const Class as usize
    });
    unsafe {
        let cls = class_ptr as *const Class;
        let obj: id = msg_send![cls, new];
        obj
    }
}

/// Per-window live-resize observers, keyed by NSWindow pointer (`ns_window as usize`),
/// exactly like the vibrancy maps. Each `wire_live_resize_cover` call registers its own
/// observer instance and records it here so a closable window can unregister it on
/// `Destroyed` (see `unwire_live_resize_cover`). The `main` window never closes, so its
/// entry simply persists for the process lifetime.
#[cfg(target_os = "macos")]
pub(crate) fn live_resize_observers() -> &'static std::sync::Mutex<std::collections::HashMap<usize, usize>> {
    static O: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<usize, usize>>> =
        std::sync::OnceLock::new();
    O.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Wire the live-resize notifications for one window's NSWindow to the cover swap.
///
/// The registered NSNotificationCenter observer is filtered by `object: ns_window`, so
/// once that window is deallocated the registration dangles at a freed pointer (and the
/// address can be reused by a later window → spurious cross-window firing). `main` never
/// closes, but detach/pop-out windows do, so each window's observer is recorded in
/// `live_resize_observers()` and the detach path calls `unwire_live_resize_cover` on
/// `Destroyed` — same lifecycle as the vibrancy maps it purges there.
#[cfg(target_os = "macos")]
pub(crate) fn wire_live_resize_cover(window: &tauri::WebviewWindow) {
    use crate::mac::*;
    let ns_window = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    if ns_window == nil {
        return;
    }
    // AppKit notification-name globals (NSNotificationName = NSString*).
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSWindowWillStartLiveResizeNotification: id;
        static NSWindowDidEndLiveResizeNotification: id;
    }
    unsafe {
        let obs = live_resize_observer_instance();
        let nc: id = msg_send![class!(NSNotificationCenter), defaultCenter];
        let _: () = msg_send![nc, addObserver: obs,
                                   selector: sel!(onLiveResizeStart:),
                                   name: NSWindowWillStartLiveResizeNotification,
                                   object: ns_window];
        let _: () = msg_send![nc, addObserver: obs,
                                   selector: sel!(onLiveResizeEnd:),
                                   name: NSWindowDidEndLiveResizeNotification,
                                   object: ns_window];
        // Record so a detach window can unregister this observer when it closes.
        live_resize_observers()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ns_window as usize, obs as usize);
    }
}

/// Tear down the live-resize observer registered for `wkey` (an NSWindow pointer).
/// `removeObserver:` drops both notification registrations for that observer instance,
/// so NSNotificationCenter no longer holds the (soon-to-be-freed) window pointer. Called
/// from the detach window's `Destroyed` handler; a no-op if nothing was wired.
#[cfg(target_os = "macos")]
pub(crate) fn unwire_live_resize_cover(wkey: usize) {
    use crate::mac::*;
    let obs = match live_resize_observers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&wkey)
    {
        Some(p) => p as id,
        None => return,
    };
    unsafe {
        let nc: id = msg_send![class!(NSNotificationCenter), defaultCenter];
        let _: () = msg_send![nc, removeObserver: obs];
    }
}

// ─────────────── Recompose on display change / wake (Electron parity) ───────────────
//
// The Electron shell had `recomposeWindow`, hung off `display-metrics-changed` and
// `powerMonitor`: re-anchor the window onto a screen that still exists, then bounce
// its bounds by 1px to force AppKit/WebKit to recompose. Only the "re-anchor" half
// survived the Tauri port (PORTING-PLAN T1.3), so a display swap or a sleep/wake
// could leave a window that the system reports as perfectly healthy — right position,
// right size, not minimised — with nothing painted in it. On a `transparent: true`
// window with no titlebar that reads as GONE, not as blank.

/// The app handle, stashed at setup so AppKit notification callbacks (which get no
/// user data) can reach the window. `OnceLock` because setup runs once.
pub(crate) static SHELL_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();


/// `NSApplicationDidChangeScreenParameters` / `NSWorkspaceDidWake` callback.
#[cfg(target_os = "macos")]
extern "C" fn on_recompose_event(
    _this: &objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    _notif: *mut objc2::runtime::AnyObject,
) {
    if let Some(app) = SHELL_APP.get() {
        window_recompose::recompose_main_window(app, "display/wake");
    }
}

/// Register the display-change and wake observers. Called ONCE from setup — the
/// grep that found "zero listeners for display change, sleep or wake" was pointing
/// at the absence of exactly this function.
#[cfg(target_os = "macos")]
pub(crate) fn wire_recompose_observers() {
    use crate::mac::*;
    use objc2::runtime::ClassBuilder;
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSApplicationDidChangeScreenParametersNotification: id;
        static NSWorkspaceDidWakeNotification: id;
    }
    static PTR: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let class_ptr = *PTR.get_or_init(|| {
        let mut decl = ClassBuilder::new(c"TopicsRecomposeObserver", class!(NSObject))
            .expect("register TopicsRecomposeObserver");
        unsafe {
            decl.add_method(
                sel!(onRecompose:),
                on_recompose_event as extern "C" fn(_, _, _),
            );
        }
        decl.register() as *const Class as usize
    });
    unsafe {
        let cls = class_ptr as *const Class;
        let obs: id = msg_send![cls, new];
        // Screen parameters live on the DEFAULT centre; sleep/wake lives on
        // NSWorkspace's OWN centre — registering wake on the default one is the
        // classic silent no-op.
        let nc: id = msg_send![class!(NSNotificationCenter), defaultCenter];
        let _: () = msg_send![nc, addObserver: obs,
                                   selector: sel!(onRecompose:),
                                   name: NSApplicationDidChangeScreenParametersNotification,
                                   object: nil];
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let wnc: id = msg_send![ws, notificationCenter];
        let _: () = msg_send![wnc, addObserver: obs,
                                    selector: sel!(onRecompose:),
                                    name: NSWorkspaceDidWakeNotification,
                                    object: nil];
    }
    eprintln!("[recompose] observers wired (screen params + wake)");
}

// ---------------------------------------------------------------------------
// Self-managed window-SIZE persistence (LOGICAL units).
//
// tauri-plugin-window-state was dropped: on this mixed-DPI multi-monitor setup it
// mis-handled the scale factor — a 2x display made it persist PHYSICAL pixels as if
// they were logical (2800x1800 written, which on the next launch is a giant window),
// and it failed to restore the real 1656x896. It also restored POSITION, which on a
// now-narrower/disconnected monitor CLAMPS the width and (with save-on-resize) ratchets
// the window smaller every launch. We persist ONLY the size, in scale-independent
// logical units, and keep the window centered (`center: true`) so it always fits.
// ---------------------------------------------------------------------------

/// Path of our window-size store: `<app_config_dir>/topics-win-size.json`.
pub(crate) fn win_size_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("topics-win-size.json"))
}

/// Write `{ "w": <logical>, "h": <logical>, "lx": <logical>, "ly": <logical> }`.
/// EVERYTHING is logical (AppKit points). Position used to be stored as tao
/// "physical" pixels — but on macOS tao's physical space is the LOGICAL global
/// space scaled by each entity's OWN backing scale (`outer_position()` uses the
/// window's current monitor, `Monitor::position()` uses that monitor's), so on a
/// mixed-DPI setup (retina laptop scale 2 + external scale 1) coordinates saved
/// while the window sat on a scale-1 display got re-interpreted at scale 2 on
/// the next launch (the window is born on the primary, `center: true`) and the
/// restore landed at HALF the coordinates — "la finestra perde la posizione"
/// on every relaunch/update. Logical points are the one coherent global space
/// on macOS (CGDisplayBounds units), so save + clamp + restore all use them.
/// Ignores bogus/minimized sizes. `lx`/`ly` may be absent (position unreadable)
/// — the JSON keys are simply omitted so `read` falls back to centering.
pub(crate) fn save_win_size_logical(path: &std::path::Path, w: f64, h: f64, pos: Option<(i32, i32)>) {
    if !(w >= 200.0 && h >= 200.0 && w.is_finite() && h.is_finite()) {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = match pos {
        Some((x, y)) => format!("{{\"w\":{:.0},\"h\":{:.0},\"lx\":{},\"ly\":{}}}", w, h, x, y),
        None => format!("{{\"w\":{:.0},\"h\":{:.0}}}", w, h),
    };
    let _ = std::fs::write(path, body);
}

/// Read back the saved logical size, validated.
pub(crate) fn read_win_size_logical(path: &std::path::Path) -> Option<(f64, f64)> {
    let s = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let w = v.get("w")?.as_f64()?;
    let h = v.get("h")?.as_f64()?;
    if w >= 200.0 && h >= 200.0 {
        Some((w, h))
    } else {
        None
    }
}

/// Read back the saved LOGICAL outer-position, if the store carries one.
/// Returns `None` for older stores — including the legacy `x`/`y` keys, which
/// held tao-"physical" (per-monitor-scaled) values that are ambiguous on
/// mixed-DPI setups: misreading them as logical would restore to the wrong
/// spot, so a legacy store centers ONCE and the next save writes `lx`/`ly`.
pub(crate) fn read_win_position_logical(path: &std::path::Path) -> Option<(i32, i32)> {
    let s = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let x = v.get("lx")?.as_i64()? as i32;
    let y = v.get("ly")?.as_i64()? as i32;
    Some((x, y))
}

/// The attached monitors as LOGICAL rects `(x, y, w, h)` — CGDisplayBounds
/// units, the one coherent global space on macOS. tao's `Monitor::position()/
/// size()` return "physical" values scaled by each monitor's OWN backing
/// factor, so they must be unscaled per-monitor before any cross-monitor math.
pub(crate) fn logical_monitors(win: &tauri::Window) -> Vec<(i32, i32, u32, u32)> {
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            let p = m.position().to_logical::<f64>(sf);
            let s = m.size().to_logical::<f64>(sf);
            (
                p.x.round() as i32,
                p.y.round() as i32,
                s.width.round().max(0.0) as u32,
                s.height.round().max(0.0) as u32,
            )
        })
        .collect()
}

/// The window's outer geometry in LOGICAL points: `((x, y), (w, h))`.
/// Unscales tao's per-current-monitor "physical" values back to AppKit points.
///
/// ── DIFETTO APERTO, MISURATO IL 2026-08-10 ──────────────────────────────────
/// Su questa macchina (retina scale 2 come primario + DUE ultrawide scale 1)
/// quello che finisce nel file NON è la geometria vera, e sbaglia in modo
/// ASIMMETRICO — che è l'indizio, perché un fattore di scala sbagliato
/// sbaglierebbe tutto allo stesso modo:
///
///   finestra vera (System Events / CGDisplayBounds, punti logici):
///       x = -797   y = -1410   w = 3440   h = 1410
///   topics-win-size.json:
///       lx = -797  ly =  -705  w = 1720   h =  705
///
/// `w`, `h` e `ly` sono ESATTAMENTE la metà; `lx` no. Cioè `to_logical(sf)` ha
/// diviso per 2 dei valori che erano già logici, mentre la x arrivava già
/// raddoppiata e la divisione la rimetteva a posto per caso. Ne segue che
/// `win.scale_factor()` qui vale 2 mentre la finestra sta su un display scale 1,
/// e che la "physical" che tao restituisce per la posizione non è coerente fra i
/// due assi (probabilmente perché il ribaltamento origine-in-basso di AppKit usa
/// l'altezza del PRIMARIO, con la sua scala, mentre la x resta nello spazio
/// della finestra).
///
/// EFFETTO: al prossimo cold-start la finestra si riapre a un quarto dell'area.
/// Non è il difetto off-screen già chiuso in 2.1.4 — la posizione salvata cade
/// dentro un display vivo, quindi `clamp_position_to_monitors` la accetta, ed è
/// giusto che la accetti.
///
/// NON L'HO CORRETTO, e la ragione è che non si può provare da qui: qualunque
/// cura (usare la scala di `current_monitor()`, oppure leggere `NSWindow.frame`
/// da objc2, che darebbe punti AppKit senza nessuna conversione) va verificata
/// facendo girare il guscio su QUESTA disposizione di monitor, cioè
/// ricostruendo e sostituendo la app in uso. Le due misure qui sopra sono il
/// punto di partenza: chi ci mette mano le rilegga dopo, non prima.
pub(crate) fn window_logical_geometry(win: &tauri::Window) -> Option<((i32, i32), (u32, u32))> {
    let sf = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?.to_logical::<f64>(sf);
    let size = win.outer_size().ok()?.to_logical::<f64>(sf);
    Some((
        (pos.x.round() as i32, pos.y.round() as i32),
        (size.width.round().max(0.0) as u32, size.height.round().max(0.0) as u32),
    ))
}

/// How long two throttled geometry writes stay apart.
pub(crate) const GEOMETRY_SAVE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// What a throttled geometry save should do about the event that just arrived.
///
/// A leading edge on its own drops the LAST event of a gesture: the user lets go
/// of the window, nothing further arrives, and the file on disk keeps whatever
/// position the window had 500ms into the drag. That is harmless only while a
/// final write is guaranteed on the way out, and it is not. `ExitRequested` fires
/// on a graceful quit, but a plain SIGTERM never reaches it, and
/// `scripts/local-shell-swap.sh` ends the app with `pkill` before swapping the
/// binary. The window then reopens where the user left it minutes earlier, often
/// on a display they are not looking at, which reads as the app having vanished.
///
/// The trailing write closes that hole: the final geometry reaches disk within
/// one interval of the last movement, so SIGTERM, SIGKILL and a crash all keep it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaveTiming {
    /// The interval has elapsed: write immediately.
    Now,
    /// Too soon, and nothing is queued: write once after this delay.
    After(std::time::Duration),
    /// Too soon, and a trailing write is already queued: that one carries this event.
    Queued,
}

pub(crate) fn save_timing(
    since_last: std::time::Duration,
    interval: std::time::Duration,
    trailing_queued: bool,
) -> SaveTiming {
    if since_last >= interval {
        SaveTiming::Now
    } else if trailing_queued {
        SaveTiming::Queued
    } else {
        SaveTiming::After(interval - since_last)
    }
}

/// Read the window geometry and persist it. Belongs on the main thread:
/// `window_logical_geometry` asks AppKit for the frame.
pub(crate) fn write_geometry_now(path: Option<&std::path::PathBuf>, win: &tauri::Window) {
    if let (Some(p), Some(((lx, ly), (lw, lh)))) = (path, window_logical_geometry(win)) {
        save_win_size_logical(p, lw as f64, lh as f64, Some((lx, ly)));
    }
}

/// Persist the main window's LOGICAL geometry right now (size + position).
/// Called on RunEvent::ExitRequested so the FINAL spot survives a quit, the
/// status-bar relaunch and the updater restart. This is the belt: the braces are
/// the trailing write in save_timing, which is what covers the paths that never
/// reach ExitRequested at all (SIGTERM from a shell swap, SIGKILL, a crash).
pub(crate) fn save_main_window_geometry(app: &tauri::AppHandle) {
    use tauri::Manager;
    // `get_window("main")` e la geometria letta in linea, per la stessa ragione
    // scritta in `recompose_main_window`: `window_logical_geometry` prende una
    // `WebviewWindow`, e quella ricerca torna `None` appena ci sono pane browser
    // aperte. Qui il ciclo su `webview_windows()` era la stessa trappola in
    // un'altra forma — con una pane aperta la mappa non conteneva più "main",
    // il ciclo non trovava niente e usciva muto. Effetto: l'ULTIMA posizione
    // della finestra non veniva più salvata all'uscita, e siccome i salvataggi
    // durante il movimento sono throttled in testa, l'ultimo spostamento di un
    // gesto si perdeva.
    let Some(win) = app.get_window("main") else { return };
    if win.is_minimized().unwrap_or(false) {
        return; // a minimized frame is not a real position
    }
    let (Ok(sf), Ok(pos), Ok(size)) = (win.scale_factor(), win.outer_position(), win.outer_size())
    else { return };
    let pos = pos.to_logical::<f64>(sf);
    let size = size.to_logical::<f64>(sf);
    if let Some(path) = win_size_file(app) {
        save_win_size_logical(
            &path,
            size.width.round().max(0.0),
            size.height.round().max(0.0),
            Some((pos.x.round() as i32, pos.y.round() as i32)),
        );
    }
}

/// Validate a saved window rect against the currently-attached monitors and
/// return a top-left that is guaranteed on-screen.
///
/// Why this exists: the old `tauri-plugin-window-state` restored position blindly,
/// so a window last seen on a now-disconnected/narrower display would be placed
/// off-screen (or get its width clamped, ratcheting smaller every launch — see the
/// module note). We keep position persistence but only honor it when the window's
/// top edge still lands on a live monitor; otherwise we re-anchor onto the nearest
/// monitor (by center distance), falling back to the first, keeping the window
/// fully inside that monitor's bounds.
///
/// The math is unit-agnostic but every CALLER must feed it LOGICAL points
/// (window geometry via `window_logical_geometry`, monitors via
/// `logical_monitors`): tao's "physical" values are scaled by each entity's own
/// backing factor, so on a mixed-DPI setup they don't share a coordinate space
/// and cross-monitor comparisons in physical units place windows wrong (the
/// actual field bug: saved from a scale-1 external, restored at half the
/// coordinates while the window sat on the scale-2 primary).
///
/// `monitors` is `(pos_x, pos_y, width, height)` per attached monitor, logical.
pub(crate) fn clamp_position_to_monitors(
    saved: (i32, i32),
    win: (u32, u32),
    monitors: &[(i32, i32, u32, u32)],
) -> Option<(i32, i32)> {
    if monitors.is_empty() {
        return None; // no displays enumerated — let the caller center
    }
    let (sx, sy) = saved;
    let (ww, wh) = (win.0 as i32, win.1 as i32);

    // As long as a grabbable slice of the title-bar (top edge) still falls on some
    // monitor, the window is reachable — honor the saved position verbatim. We
    // require ~80px of horizontal overlap of the top edge, with the top edge y
    // inside the monitor vertically.
    let visible_slice = 80.min(ww);
    let top_on_a_monitor = monitors.iter().any(|&(mx, my, mw, mh)| {
        let (mx2, my2) = (mx + mw as i32, my + mh as i32);
        let overlap_x = (sx + ww).min(mx2) - sx.max(mx);
        overlap_x >= visible_slice && sy >= my && sy < my2
    });
    if top_on_a_monitor {
        return Some(saved);
    }

    // Off-screen: pick the monitor whose center is nearest the saved window center,
    // then place the window fully inside it (clamped, top-left biased if it's larger
    // than the monitor).
    let (wcx, wcy) = (sx + ww / 2, sy + wh / 2);
    let target = monitors
        .iter()
        .min_by_key(|&&(mx, my, mw, mh)| {
            let (mcx, mcy) = (mx + mw as i32 / 2, my + mh as i32 / 2);
            let (dx, dy) = ((mcx - wcx) as i64, (mcy - wcy) as i64);
            dx * dx + dy * dy
        })
        .copied()
        .unwrap_or(monitors[0]);

    let (mx, my, mw, mh) = target;
    let (mw, mh) = (mw as i32, mh as i32);
    // Clamp so the whole window fits; if the window is bigger than the monitor,
    // pin to the monitor's top-left (a resize/center pass elsewhere handles size).
    let max_x = (mx + mw - ww).max(mx);
    let max_y = (my + mh - wh).max(my);
    let nx = sx.clamp(mx, max_x);
    let ny = sy.clamp(my, max_y);
    Some((nx, ny))
}

/// Reveal a window that may have been hidden/minimized while its display went
/// away, GUARANTEEING it lands on-screen. `show()` alone re-orders the window at
/// its LAST position — and the cold-start clamp (in setup) runs only once, so if
/// an external monitor was disconnected since the window was placed there, a plain
/// show() brings it back OFF-SCREEN. The user then sees the app "open and do
/// nothing" (dock bounce, no visible window) — the field report behind this fix.
///
/// Every bring-to-front path (single-instance re-launch, tray "Mostra", dock
/// Reopen, menu, nav) routes through here: show + unminimize, re-anchor onto a
/// LIVE monitor when the current rect is off every attached display (reusing the
/// exact clamp as the restore path — a valid position on any connected display,
/// including a second one, is honored verbatim), then focus.
/// Which window a reveal should raise, given the labels the app still has.
///
/// "main" wins. Otherwise any other window will do, chosen in sorted order so two
/// reveals in a row raise the same one: `windows()` hands back a HashMap, and
/// picking whatever iterates first would make the app come back somewhere
/// different each time.
pub(crate) fn window_to_reveal(labels: &[String]) -> Option<String> {
    if labels.iter().any(|l| l == "main") {
        return Some("main".to_string());
    }
    let mut rest: Vec<&String> = labels.iter().collect();
    rest.sort();
    rest.first().map(|s| (*s).clone())
}

/// Bring the app back on screen, whatever window it still has.
///
/// The three ways back in (a second launch forwarding to this instance, the tray's
/// "Mostra Topics", a dock click) were each `if let Some(w) = get_window("main")`
/// with no else. If "main" were ever gone, all three were silent no-ops and the
/// app had no way back at all. That exact shape has already cost this codebase
/// once: an `if let` with no else in macos_notifications.rs is why clicking a
/// notification did not open the task.
///
/// "main" is not supposed to disappear (CloseRequested hides to the tray instead
/// of closing, and window_close_self only runs for detached windows), so this is a
/// backstop and not a routine path. It deliberately does NOT rebuild a window from
/// tauri.conf: a fresh one would miss every handler setup() wires onto main, from
/// the traffic lights to the geometry saving to close-to-tray, and handing back a
/// half-wired window is worse than handing back nothing. When there is nothing
/// left to raise it says so out loud rather than returning quietly.
pub(crate) fn reveal_a_window(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let labels: Vec<String> = app.windows().keys().cloned().collect();
    let Some(label) = window_to_reveal(&labels) else {
        eprintln!("[reveal] no window left to show; the app is running with nothing on screen");
        return false;
    };
    // get_window, never get_webview_window: the latter drops any window hosting a
    // browser pane, which is exactly when the user needs this to work.
    let Some(w) = app.get_window(&label) else {
        eprintln!("[reveal] window {label} was listed but could not be resolved");
        return false;
    };
    ensure_window_visible(&w);
    true
}

pub(crate) fn ensure_window_visible(win: &tauri::Window) {
    let _ = win.show();
    let _ = win.unminimize();
    // LOGICAL points throughout (see clamp_position_to_monitors): tao physical
    // values are per-entity-scaled on macOS, unusable across mixed-DPI monitors.
    if let Some((pos, size)) = window_logical_geometry(win) {
        let monitors = logical_monitors(win);
        match clamp_position_to_monitors(pos, size, &monitors) {
            Some((nx, ny)) if (nx, ny) != pos => {
                let _ = win.set_position(tauri::LogicalPosition::new(nx as f64, ny as f64));
            }
            None => {
                let _ = win.center();
            }
            _ => {}
        }
    }
    let _ = win.set_focus();
}

// ───────────────────────── Pop-out to a real OS window ─────────────────────────
//
// A group of topics can be "moved to a new window": a real detached NSWindow that
// loads the same embedded bundle with `?topics=a,b,c`. The client boots it as a
// single-surface detached view (no pane-store sync), announces its presence over
// the WS presence channel, and the origin window swaps the group for a compact
// "in un'altra finestra" marker. Detachment is DEVICE-LOCAL and EPHEMERAL — there
// is no persisted state; the window closing IS the state change.

/// Monotonic suffix so two rapid detaches never collide on the same label.
pub(crate) static DETACH_SEQ: AtomicI64 = AtomicI64::new(0);

/// Short, collision-free label suffix (time-nanos ^ counter, hex). Avoids adding
/// a `uuid` crate for what only needs to be unique within one process lifetime.
pub(crate) fn detach_label() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = DETACH_SEQ.fetch_add(1, Ordering::Relaxed) as u64;
    format!("detach-{:08x}", ((n ^ (c.wrapping_mul(0x9e37_79b9))) as u32))
}

/// Open a detached window hosting `topics`. Returns the new window's label so the
/// client can address it later (focus/close). Chrome parity with the config
/// window (transparent + Overlay titlebar + traffic lights + no HTML5-DnD
/// suppression) is set programmatically here because tauri.conf.json grants those
/// to the "main" window only.
#[tauri::command]
pub(crate) async fn window_detach(
    app: tauri::AppHandle,
    topics: Vec<String>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    if topics.is_empty() {
        return Err("no topics to detach".into());
    }
    let label = detach_label();
    // `?topics=` (plural) is the detached-window boot contract read by App.tsx /
    // usePanelLifecycle; encode each id so commas/spaces survive the query.
    let encoded = topics
        .iter()
        .map(|t| urlencoding_encode(t))
        .collect::<Vec<_>>()
        .join(",");
    let url = format!("index.html?topics={encoded}");
    let w = width.unwrap_or(900.0);
    let h = height.unwrap_or(700.0);

    let label_for_build = label.clone();
    // Window construction touches AppKit; keep it on the main thread via the
    // async-command executor (Tauri runs #[command] async fns on its runtime,
    // and the builder marshals to the main thread internally).
    let build = tauri::WebviewWindowBuilder::new(
        &app,
        &label_for_build,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Topics")
    .inner_size(w, h)
    .min_inner_size(480.0, 400.0)
    .resizable(true)
    .transparent(true)
    // Same reason as the main window: on Windows the app draws its own bar, so a
    // native one on top of it is a second bar. See the note in `window_detach_space`.
    .decorations(cfg!(not(target_os = "windows")))
    .disable_drag_drop_handler(); // mandatory: HTML5 DnD dies without it under wry

    #[cfg(target_os = "macos")]
    let build = build
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    let win = build.build().map_err(|e| format!("build detach window: {e}"))?;

    // Le pane browser che questa finestra ospita vanno svuotate PRIMA che se ne
    // vada, e `CloseRequested` è l'ultimo momento in cui esistono ancora: su
    // `Destroyed` non sono più raggiungibili (vedi `evict_panes_of_window`).
    // Sta fuori dal `cfg(macos)` qui sotto perché non è chrome: è heap, e
    // l'heap lo tiene in ostaggio ogni piattaforma. `on_window_event` accoda
    // (non sostituisce), quindi il registratore macOS più sotto resta valido.
    // Verificato nel runtime che usiamo, non dedotto dalla documentazione: ogni
    // registrazione chiede un id nuovo e finisce in una MAPPA di ascoltatori
    // (`tauri-runtime-wry` 2.11.3, `WindowMessage::AddEventListener` →
    // `window_event_listeners.insert(id, listener)`), e all'arrivo dell'evento
    // il runtime li chiama tutti. Se un giorno diventasse un rimpiazzo, a
    // sparire sarebbero le luci del semaforo di questa finestra.
    {
        let app_for_evict = app.clone();
        let label_for_evict = label.clone();
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                evict_panes_of_window(&app_for_evict, &label_for_evict);
            }
        });
    }
    // The pages of this window learn when it gains or loses focus: its heavy
    // browser panes pause and its pane polls stop while it is not focused.
    window_focus::wire(&win.as_ref().window(), label.clone());

    // The menu accelerators live in the window they were typed in, so every
    // window we build arms its own hook (see `menu_chords_win`).
    #[cfg(target_os = "windows")]
    menu_chords_win::install(&app, &label);

    // Same DWM backdrop as the main window: a pop-out born after startup would
    // otherwise be the one flat window on screen. `None` means "follow the OS
    // for now"; the client's next `set_theme` re-tints this window with the
    // rest, because `detach-*` is inside the set that command walks.
    windows_acrylic::apply_backdrop(&win.as_ref().window(), None);

    #[cfg(target_os = "macos")]
    {
        // Traffic lights hidden by default (revealed with the Topics menu, same
        // as main), live-resize frost cover, and register this window's UI
        // webview so the shortcut forwarder scopes ⌘W to it (never to main).
        apply_traffic_lights(&win, false);
        wire_live_resize_cover(&win);
        register_ui_webview(&win, &label);
        // Purge THIS window's vibrancy view/cover bookkeeping when it closes. The
        // maps are keyed by NSWindow pointer; a detached window's address can be
        // reused by a later window, so a stale entry left behind would hand the new
        // window freed NSView pointers (setFrame on a dangling view → crash). The
        // views are freed with the contentView, so we only drop the map entries.
        if let Ok(p) = win.ns_window() {
            let wkey = p as usize;
            win.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    vibrancy_views().lock().unwrap_or_else(|e| e.into_inner()).remove(&wkey);
                    vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner()).remove(&wkey);
                    // Unregister this window's live-resize observer so NSNotificationCenter
                    // stops holding the freed NSWindow pointer (dangling / address-reuse).
                    unwire_live_resize_cover(wkey);
                }
            });
        }
    }
    Ok(label)
}

/// Open a window that hosts one GROUP (Spazio), addressed by id.
///
/// Not a pop-out. `window_detach` above loads `?topics=a,b` — a read-only view
/// of a few chats, whose pane-store bridges are deliberately dead. A GROUP is
/// alive: it has a name, tabs of every kind, its own grid, and it must keep
/// opening and closing tabs like any other window. So this loads the app whole
/// with `?space=<id>`, and the client pins its active Spazio to that id (see
/// `lib/windowRole.ts`). Two windows writing one pane-store is exactly the
/// "two devices" case the store already survives (LWW + server_seq).
///
/// Chrome parity with the main window is set here for the same reason as
/// `window_detach`: tauri.conf.json grants it to "main" only.
#[tauri::command]
pub(crate) async fn window_detach_space(
    app: tauri::AppHandle,
    space: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    if space.trim().is_empty() {
        return Err("no space to detach".into());
    }
    // Tracciato: senza questa riga, un detach che non apre niente è
    // indistinguibile da un clic che non è mai arrivato fin qui.
    eprintln!("[space] detach richiesto: {space}");
    // Already open? Raise it instead of minting a second window on the same
    // group — due finestre che disegnano lo stesso gruppo si contendono la sua
    // griglia. `ensure_window_visible` è una catena di chiamate al dispatcher
    // della finestra: va sul MAIN THREAD e dentro `no_abort`, come
    // `window_focus_label` (stessa classe di SIGABRT).
    // ⚠️ QUESTA MAPPA È ANCORA QUELLA FILTRATA, ed è l'ultimo posto in cui la
    // trappola morde (le altre sono state corrette: `reload_all_ui_windows`,
    // `set_theme`, `save_main_window_geometry`, il forward dei chord,
    // `purge_dead_space_labels`). Con una pane browser aperta nella
    // finestra-gruppo, `find` non la trova e questo ramo «alzala invece di
    // riaprirla» non scatta.
    //
    // Non è corretto qui perché non è uno swap: `ensure_window_visible` prende
    // una `&WebviewWindow`, e ritiparla a `&Window` tira dentro anche
    // `logical_monitors` e `window_logical_geometry` più una dozzina di
    // chiamanti. Va fatto, ma come giro suo — e insieme ai due gemelli che
    // hanno lo STESSO filtro: `get_webview_window` più sotto in questa funzione
    // e in `window_close_label`.
    //
    // Il sintomo resta in gran parte coperto: il gesto «Sposta in una finestra»
    // passa prima dalla presenza (SpaceGroups.tsx), che sa già dove vive il
    // gruppo e alza la finestra senza arrivare qui. Questo ramo è la rete di
    // sotto, e oggi è la rete che ha un buco.
    {
        use tauri::Manager;
        let existing = app
            .windows()
            .into_iter()
            .find(|(label, _)| label.starts_with("space-") && window_space_of(label) == Some(space.clone()));
        if let Some((label, win)) = existing {
            let _ = app.run_on_main_thread(move || {
                let _ = no_abort("window_detach_space/raise", || { ensure_window_visible(&win); Ok(()) });
            });
            return Ok(label);
        }
    }
    // Le etichette morte non devono bloccare i vivi: si spazza la mappa dalle
    // voci la cui finestra non esiste più, così un gruppo chiuso male non
    // resta "già aperto" per sempre.
    purge_dead_space_labels(&app);
    let label = space_window_label(&space);
    // label → gruppo: il label non contiene l'id alla lettera, quindi senza
    // questa mappa non si saprebbe più quale finestra ospita quale gruppo
    // (serve al ramo "già aperta?" qui sopra).
    if let Ok(mut m) = SPACE_WINDOWS.lock() {
        m.insert(label.clone(), space.clone());
    }
    let url = format!("index.html?space={}", urlencoding_encode(&space));
    let w = width.unwrap_or(1100.0);
    let h = height.unwrap_or(760.0);

    // ── Perché tutto questo gira sul MAIN THREAD, dentro `no_abort` ──────────
    //
    // La prima versione costruiva la finestra e le metteva addosso la chrome
    // macOS (semafori, cover del live-resize, registrazione del webview UI)
    // direttamente dal worker tokio su cui Tauri esegue i comandi async — come
    // fa `window_detach`. Il 05/08/2026 quel percorso ha ucciso l'app:
    // SIGABRT su un `tokio-rt-worker` al primo "Sposta in una finestra"
    // (crash report: abort() da tre frame dentro il binario, sopra lo stack di
    // tokio). Sono chiamate AppKit: fuori dal main thread non hanno garanzie, e
    // un panic che risale attraverso il confine ObjC non può srotolare — il
    // processo aborta invece di restituire un errore.
    //
    // Quindi: `run_on_main_thread` per costruire e vestire la finestra, e
    // `no_abort` attorno a tutto (stessa medicina di `window_focus_label` e dei
    // comandi `browser_*`). Il risultato torna qui su un canale: se qualcosa
    // esplode, il comando risponde Err e l'app resta viva.
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let label_for_main = label.clone();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let out = no_abort("window_detach_space", || {
            let label = label_for_main;
            let build = tauri::WebviewWindowBuilder::new(&app_for_main, &label, tauri::WebviewUrl::App(url.into()))
                .title("Topics")
                .inner_size(w, h)
                .min_inner_size(480.0, 400.0)
                .resizable(true)
                .transparent(true)
                // WINDOWS: no system title bar. The app draws its own (App.tsx,
                // `app-drag-region`), so leaving `decorations(true)` there stacks a
                // second, native bar on top of it — reported 2026-08-26, "the
                // Windows build has the system bar we had removed".
                //
                // macOS keeps decorations ON: there the bar is not chrome, it holds
                // the traffic lights, and `TitleBarStyle::Overlay` + `hidden_title`
                // already blend it into the app's own row.
                .decorations(cfg!(not(target_os = "windows")))
                .disable_drag_drop_handler(); // mandatory: HTML5 DnD dies without it under wry

            #[cfg(target_os = "macos")]
            let build = build
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);

            let win = build.build().map_err(|e| format!("build space window: {e}"))?;

            // Stessa ragione di `window_detach`: le pane browser di questa
            // finestra vanno svuotate mentre è ancora intera, e vale su ogni
            // piattaforma. Qui pesa di più: una finestra-gruppo apre e chiude
            // tab come la principale, quindi è quella che ne accumula di più.
            {
                let app_for_evict = app_for_main.clone();
                let label_for_evict = label.clone();
                win.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        evict_panes_of_window(&app_for_evict, &label_for_evict);
                    }
                });
            }
            // Same focus signal as `window_detach`: a group window hosts panes too.
            window_focus::wire(&win.as_ref().window(), label.clone());

            // Same reason as `window_detach`: a group window is a window, and
            // Ctrl+Q or the zoom chords must work while it holds focus.
            #[cfg(target_os = "windows")]
            menu_chords_win::install(&app_for_main, &label);

            // And it is a window that PAINTS THE APP, so on Windows it needs the
            // DWM backdrop like any other. Without this the group window is the
            // one hole in the screen: it is built transparent, the client paints
            // its page transparent too, and with nothing frosted behind it the
            // live desktop shows straight through. See `is_app_shell`.
            windows_acrylic::apply_backdrop(&win.as_ref().window(), None);

            #[cfg(target_os = "macos")]
            {
                apply_traffic_lights(&win, false);
                wire_live_resize_cover(&win);
                register_ui_webview(&win, &label);
                // Same bookkeeping purge as window_detach: the vibrancy maps are keyed
                // by NSWindow pointer, and a freed address gets reused.
                if let Ok(p) = win.ns_window() {
                    let wkey = p as usize;
                    let label_for_event = label.clone();
                    win.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            vibrancy_views().lock().unwrap_or_else(|e| e.into_inner()).remove(&wkey);
                            vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner()).remove(&wkey);
                            unwire_live_resize_cover(wkey);
                            if let Ok(mut m) = SPACE_WINDOWS.lock() {
                                m.remove(&label_for_event);
                            }
                        }
                    });
                }
            }
            Ok(label)
        });
        let _ = tx.send(out);
    })
    .map_err(|e| format!("main thread: {e}"))?;

    // Attesa con tetto: se il main thread è bloccato, meglio un errore che un
    // comando appeso per sempre (e la mappa ripulita, o il gruppo resterebbe
    // "già aperto" su una finestra che non esiste).
    match rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(res) => {
            match &res {
                Ok(l) => eprintln!("[space] finestra creata: {l}"),
                Err(e) => {
                    eprintln!("[space] detach fallito: {e}");
                    if let Ok(mut m) = SPACE_WINDOWS.lock() { m.remove(&label); }
                }
            }
            res
        }
        Err(e) => {
            if let Ok(mut m) = SPACE_WINDOWS.lock() { m.remove(&label); }
            Err(format!("space window timed out: {e}"))
        }
    }
}

/// `space-<hex>-<n>`: l'etichetta di UNA finestra-gruppo.
///
/// Era stabile per gruppo (il solo hash), e sembrava elegante: riaprire lo
/// stesso gruppo ritrovava la sua finestra invece di clonarla. In realtà legava
/// il gruppo a un NOME che Tauri non libera sempre quando la finestra se ne va:
/// il 06/08/2026 una finestra chiusa ha lasciato l'etichetta occupata e da lì
/// in poi OGNI detach di quel gruppo falliva con «a webview with label
/// `space-…` already exists» — un gruppo che non si poteva più staccare finché
/// l'app non ripartiva.
///
/// Ora l'etichetta è unica per finestra (contatore di processo) e la domanda
/// "quel gruppo ha già una finestra?" la risponde la MAPPA `SPACE_WINDOWS`, che
/// è ciò che sa la verità e si può spazzare (`purge_dead_space_labels`). Un
/// nome bruciato non blocca più niente.
pub(crate) fn space_window_label(space: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in space.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    let n = DETACH_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("space-{h:016x}-{n}")
}

/// Toglie dalla mappa le finestre-gruppo che non esistono più.
///
/// La mappa si pulisce da sé sull'evento `Destroyed`, ma quell'evento non è
/// garantito su ogni percorso di chiusura (ed è esattamente il caso che ha
/// prodotto l'etichetta zombie). Questa spazzata è la rete: costa un giro sulle
/// finestre aperte e rende il ramo "già aperta?" onesto.
pub(crate) fn purge_dead_space_labels(app: &tauri::AppHandle) {
    use tauri::Manager;
    // `windows()`, non `webview_windows()`: qui si chiede «quali finestre
    // esistono», e la seconda risponde a una domanda diversa — «quali finestre
    // hanno UNA sola webview» (vedi `reload_all_ui_windows` per il predicato).
    // Una finestra-gruppo con una pane browser aperta ne ha due, quindi cadeva
    // fuori da `alive` e questa spazzata la sfrattava da viva: il ramo «già
    // aperta?» tornava a mentire e si apriva una SECONDA finestra sullo stesso
    // gruppo. Cioè esattamente l'etichetta zombie che questa rete esiste per
    // togliere, al contrario.
    let alive: std::collections::HashSet<String> = app.windows().into_keys().collect();
    if let Ok(mut m) = SPACE_WINDOWS.lock() {
        m.retain(|label, _| alive.contains(label));
    }
}

/// L'id del gruppo dietro un label `space-…`, ricavato dalla URL della finestra
/// aperta. Ritorna `None` per ogni altra finestra.
pub(crate) fn window_space_of(label: &str) -> Option<String> {
    if !label.starts_with("space-") { return None; }
    SPACE_WINDOWS.lock().ok()?.get(label).cloned()
}

/// label della finestra → id del gruppo che ospita. Serve solo a riconoscere
/// una finestra già aperta sullo stesso gruppo (il label è un hash, non l'id).
pub(crate) static SPACE_WINDOWS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Focus (show + unminimize + raise) the window with `label`. Returns false when
/// no such window exists on THIS machine, so the client can fall back to a local
/// reopen (the topic may be detached on another device, or the window just died).
#[tauri::command]
pub(crate) fn window_focus_label(app: tauri::AppHandle, label: String) -> bool {
    use tauri::Manager;
    // no_abort: ensure_window_visible is a chain of window-dispatcher calls
    // (show/unminimize/outer_position/set_focus…) — same poisoned-mutex
    // SIGABRT class as the browser_* commands (see no_abort doc).
    no_abort("window_focus_label", || {
        // `get_window`, non `get_webview_window`: la seconda passa dallo stesso
        // filtro di `webview_windows()` e torna None appena la finestra ospita
        // una pane browser (lo dice gia' il commento su `set_traffic_lights`).
        if let Some(w) = app.get_window(&label) {
            ensure_window_visible(&w);
            Ok(true)
        } else {
            Ok(false)
        }
    })
    .unwrap_or(false)
}

/// JS che ricarica il documento UI LASCIANDO UN SEGNO che il client mostra al
/// boot successivo (`ReloadedFlash` → toast «Ricaricata»).
///
/// Un reload che rifà lo stesso contenuto è indistinguibile dal nulla: premi
/// ⌘R, lo schermo torna identico, e l'unica conclusione possibile è «non va».
/// È già successo. Il segno sta in `sessionStorage` perché è l'unico posto che
/// sopravvive a `location.reload()` senza sopravvivere alla finestra: la
/// prossima sessione non si porta dietro un toast fossile.
///
/// `try/catch` perché in un documento con storage negato `sessionStorage` LANCIA
/// al solo accesso: senza guardia l'eccezione ucciderebbe la riga e il reload —
/// cioè il feedback si mangerebbe la funzione che deve annunciare.
pub(crate) const RELOAD_WITH_FLASH_JS: &str =
    "try{sessionStorage.setItem('topics:reloaded','1')}catch(e){}window.location.reload()";

/// Ricarica TUTTE le finestre della app (chrome inclusa), non solo quella che
/// chiede. Il bundle è uno solo: dopo un build, una finestra ricaricata e le
/// altre ferme sono due versioni dello stesso client che si parlano — e chi
/// preme ⌘R non sta chiedendo "ricarica questa", sta chiedendo "riparti".
/// Le pane native dei browser non si toccano: si ricarica il documento UI.
///
/// QUESTA è l'unica implementazione del gesto «riparti», e ci passano tutte e
/// tre le porte: il monitor NSEvent che intercetta ⌘R su macOS, la voce Reload /
/// Force Reload del menu, e il comando `app_reload_all` chiamato dal renderer.
/// Prima erano tre: il monitor ingoia l'evento (`return nil`), quindi
/// `useKeyboardShortcuts` non vedeva mai ⌘R e il ramo "ricarica tutto" era di
/// fatto morto sul desktop — il nativo ricaricava la sola finestra dell'evento e
/// i gruppi staccati restavano sul bundle vecchio. Una semantica sola, in un
/// posto solo: se cambia, cambia per tutti e tre i gesti.
pub(crate) fn reload_all_ui_windows(app: &tauri::AppHandle) -> usize {
    use tauri::Manager;
    let mut n = 0usize;
    // `webviews()`, NON `webview_windows()`, ed è la differenza fra ricaricare e
    // non fare niente.
    //
    // In tauri 2.11.3 la mappa delle finestre-webview tiene solo quelle per cui
    // `is_webview_window()` è vero, e quel predicato è
    // `self.webviews().iter().all(|w| w.label() == self.label())`
    // (tauri/src/lib.rs:588-602, tauri/src/window/mod.rs:1160). Una pane del
    // browser è una webview FIGLIA della finestra ospite — `window.add_child(…)`
    // in `browser_open` — quindi appena ne apri una quella finestra ha due
    // webview, il predicato diventa falso e **la finestra sparisce dalla mappa**,
    // `main` compresa. Il ciclo girava a vuoto, tornava 0 e non falliva: ⌘R, la
    // voce Reload del menu e `app_reload_all` tacevano tutti e tre insieme, e
    // SOLO con una pane aperta. È il «premo ⌘R e non succede nulla» che questa
    // funzione era già stata scritta per risolvere una volta.
    //
    // La prova che è un errore e non una scelta sta 400 righe più sotto, in
    // questo stesso file: `notify_app_shell_bundle_stale` fa lo stesso ciclo, con
    // lo stesso salto sulle `browserpane-`, ma sulle webview — ed è il motivo per
    // cui il toast «Build più recente pronta» continuava a comparire mentre il
    // reload non partiva. Stesso intento, due collezioni, un esito solo giusto.
    //
    // E qui il salto sulle `browserpane-` diventa finalmente portante: prima era
    // codice morto, perché in una mappa già filtrata una pane non compariva mai.
    for (label, wv) in app.webviews() {
        // Le pane native del browser sono webview a sé: si saltano, o si
        // ricaricherebbe la pagina che l'utente sta guardando.
        if label.starts_with("browserpane-") { continue; }
        if wv.eval(RELOAD_WITH_FLASH_JS).is_ok() { n += 1; }
    }
    n
}

/// Il gesto «riparti» esposto al renderer. Vedi `reload_all_ui_windows`.
#[tauri::command]
pub(crate) fn app_reload_all(app: tauri::AppHandle) -> usize {
    no_abort("app_reload_all", || Ok(reload_all_ui_windows(&app))).unwrap_or(0)
}

/// Chiude la finestra `label` (una finestra-gruppo, di solito): è il "riporta
/// qui" del menu di un gruppo staccato. `false` = quella finestra non esiste su
/// questa macchina, e chi chiama si limita a riaprire il gruppo dov'è.
#[tauri::command]
pub(crate) fn window_close_label(app: tauri::AppHandle, label: String) -> bool {
    use tauri::Manager;
    // no_abort: `close()` passa dal dispatcher della finestra — stessa classe di
    // SIGABRT dei comandi `browser_*` (vedi la doc di no_abort).
    no_abort("window_close_label", || {
        // `get_window`: `window_close_self` qui sotto porta gia' scritto il perche'
        // — l'estrattore rifiuta in silenzio una `WebviewWindow` appena la finestra
        // ha piu' di una webview. Chiudere una finestra-gruppo con una pane aperta
        // tornava `false` senza chiudere niente.
        match app.get_window(&label) {
            Some(w) => { w.close().map_err(|e| e.to_string())?; Ok(true) }
            None => Ok(false),
        }
    })
    .unwrap_or(false)
}

/// Close the window that invoked this command. WKWebView's `window.close()` is a
/// no-op on Tauri, so a detached window whose last tab closes calls this to
/// actually dismiss its NSWindow. MUST take `tauri::Window` (not `WebviewWindow`,
/// which the extractor silently rejects once a window is multi-webview).
#[tauri::command]
pub(crate) fn window_close_self(window: tauri::Window) {
    // no_abort: window.close() goes through the window dispatcher — a
    // poisoned dispatcher mutex would otherwise abort the whole app on the
    // next detached-window close (see no_abort doc).
    let _ = no_abort("window_close_self", || {
        window.close().map_err(|e| e.to_string())
    });
}

/// Minimise / maximise-restore / close, for a window that has NO system title bar.
///
/// On Windows the app draws its own bar and the native one is switched off (see
/// the note in `setup`), which also takes away the three buttons the user reaches
/// for. Without these commands a window would be unminimisable, unmaximisable and
/// unclosable except through the taskbar — which is not "we removed the chrome",
/// it is "we removed the controls".
///
/// One command with an action instead of three: the three cases share the whole
/// preamble (find the window, `no_abort`, report the outcome), and three copies of
/// it would be three places to keep in step.
///
/// `no_abort` for the same reason as the other window commands: these calls go
/// through the window dispatcher, whose poisoned mutex aborts the process rather
/// than returning an error.
#[tauri::command]
pub(crate) fn window_control(window: tauri::Window, action: String) -> bool {
    no_abort("window_control", || {
        match action.as_str() {
            "minimize" => window.minimize().map_err(|e| e.to_string())?,
            "maximize" => {
                // A single "maximize" that cannot restore is a button that works
                // once. The state is asked of the window, never remembered here:
                // the user can also maximise by double-clicking the bar or with a
                // keyboard chord, and a remembered flag would drift from reality.
                if window.is_maximized().map_err(|e| e.to_string())? {
                    window.unmaximize().map_err(|e| e.to_string())?
                } else {
                    window.maximize().map_err(|e| e.to_string())?
                }
            }
            "close" => window.close().map_err(|e| e.to_string())?,
            other => return Err(format!("unknown window action: {other}")),
        }
        Ok(true)
    })
    .unwrap_or(false)
}

/// Is this window maximised right now? The client needs it to draw the correct
/// glyph (maximise vs restore) on its own title bar.
#[tauri::command]
pub(crate) fn window_is_maximized(window: tauri::Window) -> bool {
    no_abort("window_is_maximized", || {
        window.is_maximized().map_err(|e| e.to_string())
    })
    .unwrap_or(false)
}

/// The client says whether the floating-splits layout is on, so the shell can
/// decide what the window's ground is.
///
/// Windows only in effect (see `windows_acrylic::set_floating`): there the DWM
/// backdrop is whole-window, so it also fills the gaps the floating layout opens
/// between the cards, and the gaps come out frosted instead of showing what is
/// behind the window. macOS has per-region vibrancy and needs nothing here: the
/// regions it pushes already stop at the cards' edges.
///
/// Unguarded and cheap off Windows: it stores a flag and returns.
#[tauri::command]
pub(crate) fn window_set_floating(app: tauri::AppHandle, floating: bool) {
    // no_abort for the same reason as `set_theme`: this reaches the window
    // dispatcher, whose poisoned mutex aborts the process instead of returning.
    let _ = no_abort("window_set_floating", || {
        windows_acrylic::set_floating(&app, floating);
        Ok(())
    });
}

#[cfg(test)]
mod win_store_tests {
    use super::{read_win_position_logical, read_win_size_logical, save_win_size_logical};

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "topics-win-store-test-{}-{}.json",
            name,
            std::process::id()
        ))
    }

    #[test]
    fn round_trips_logical_size_and_position() {
        let p = tmp("roundtrip");
        save_win_size_logical(&p, 3440.0, 1084.0, Some((-784, -1410)));
        assert_eq!(read_win_size_logical(&p), Some((3440.0, 1084.0)));
        assert_eq!(read_win_position_logical(&p), Some((-784, -1410)));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn legacy_physical_keys_are_ignored_for_position() {
        // Pre-logical stores wrote tao-"physical" x/y — per-monitor-scaled, so
        // ambiguous on mixed-DPI. The reader must NOT interpret them: the size
        // still restores, the position centers ONCE, the next save writes lx/ly.
        let p = tmp("legacy");
        std::fs::write(&p, "{\"w\":3440,\"h\":1084,\"x\":535,\"y\":-1410}").unwrap();
        assert_eq!(read_win_size_logical(&p), Some((3440.0, 1084.0)));
        assert_eq!(read_win_position_logical(&p), None);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn bogus_sizes_are_not_written() {
        let p = tmp("bogus");
        let _ = std::fs::remove_file(&p);
        save_win_size_logical(&p, 10.0, 10.0, Some((0, 0)));
        assert!(!p.exists());
    }
}

#[cfg(test)]
mod geometry_throttle_tests {
    use super::{save_timing, SaveTiming};
    use std::time::Duration;

    const IV: Duration = Duration::from_millis(500);

    #[test]
    fn past_the_interval_writes_immediately() {
        assert_eq!(save_timing(Duration::from_secs(2), IV, false), SaveTiming::Now);
        // Exactly on the boundary counts as elapsed, so a steady stream of events
        // keeps writing at one per interval instead of stalling.
        assert_eq!(save_timing(IV, IV, false), SaveTiming::Now);
    }

    #[test]
    fn inside_the_interval_queues_only_the_remainder() {
        assert_eq!(
            save_timing(Duration::from_millis(120), IV, false),
            SaveTiming::After(Duration::from_millis(380))
        );
    }

    #[test]
    fn a_queued_write_is_not_queued_twice() {
        assert_eq!(save_timing(Duration::from_millis(120), IV, true), SaveTiming::Queued);
        assert_eq!(save_timing(Duration::from_millis(499), IV, true), SaveTiming::Queued);
    }

    /// The regression this whole thing exists for. A drag that ends between two
    /// ticks: events at 0, 120, 240, 360ms and then the user lets go. With a
    /// leading edge alone the write at t=0 is the last one, so the file keeps the
    /// position the window had at the START of the drag, and the next launch puts
    /// the window back there. That is what "the app disappeared" looked like: a
    /// SIGTERM from scripts/local-shell-swap.sh skips ExitRequested, so the stale
    /// value was the only one on disk.
    #[test]
    fn a_gesture_that_stops_between_ticks_still_reaches_disk() {
        let mut writes = 0;
        let mut queued = false;

        // t=0, nothing written for two seconds: the leading write fires.
        match save_timing(Duration::from_secs(2), IV, queued) {
            SaveTiming::Now => writes += 1,
            other => panic!("expected an immediate write, got {other:?}"),
        }
        // t=120, 240, 360: inside the interval. The first queues a trailing write,
        // the rest ride on it.
        for since in [120u64, 240, 360] {
            match save_timing(Duration::from_millis(since), IV, queued) {
                SaveTiming::After(_) => queued = true,
                SaveTiming::Queued => {}
                SaveTiming::Now => panic!("{since}ms is inside the interval"),
            }
        }
        assert!(queued, "the gesture must leave a trailing write queued");

        // The queued write fires and carries the geometry as of t=360, which is
        // where the user actually left the window.
        writes += 1;
        assert_eq!(writes, 2, "one leading write and one trailing write");
    }
}

#[cfg(test)]
mod reveal_window_tests {
    use super::window_to_reveal;

    fn labels(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn main_wins_whenever_it_is_there() {
        assert_eq!(window_to_reveal(&labels(&["space-a", "main"])), Some("main".into()));
        assert_eq!(window_to_reveal(&labels(&["main"])), Some("main".into()));
    }

    /// The hole this closes. Without a fallback the dock icon, the tray entry and
    /// a second launch were all silent no-ops the moment "main" was gone, and an
    /// app that is running with no way to show itself is indistinguishable from
    /// one that vanished.
    #[test]
    fn without_main_any_other_window_is_better_than_none() {
        assert_eq!(window_to_reveal(&labels(&["space-b", "detach-1"])), Some("detach-1".into()));
    }

    /// windows() is a HashMap, so an unsorted pick would raise a different window
    /// on each try and the app would seem to come back somewhere new every time.
    #[test]
    fn the_choice_is_stable_across_calls() {
        let a = labels(&["space-b", "detach-1", "space-a"]);
        let b = labels(&["space-a", "space-b", "detach-1"]);
        assert_eq!(window_to_reveal(&a), window_to_reveal(&b));
    }

    #[test]
    fn nothing_to_raise_is_reported_not_guessed() {
        assert_eq!(window_to_reveal(&[]), None);
    }
}
