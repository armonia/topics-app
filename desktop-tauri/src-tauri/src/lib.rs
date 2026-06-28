// Topics — low-footprint desktop shell (Tauri).
//
// PORTING-PLAN.md Tier 1. This replaces the Electron main process. The React UI
// is loaded from the live server origin (http://localhost:3333) exactly like the
// Electron shell did; native capabilities the web app needs (perf metrics, and —
// later — pty terminals + the CEF browser pane) are exposed as Tauri commands and
// reached from the client via client/src/lib/shell. Window lifecycle, theme,
// open-external and relaunch are covered by the official plugins below, whose JS
// APIs the shell bridge calls directly.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

/// Desired traffic-light visibility (hidden by default; the client flips it when
/// the Topics menu opens). AppKit re-shows the buttons on focus/resize when the
/// titlebar is transparent (`Overlay`), so we re-assert this state on those
/// window events — mirroring the Electron shell's re-pin pattern.
static TRAFFIC_LIGHTS_VISIBLE: AtomicBool = AtomicBool::new(false);

/// True once a real quit is in progress (tray "Esci"). The window's CloseRequested
/// handler HIDES to the tray instead of closing while this is false, so the red
/// button / ⌘W parks the app in the tray; the tray quit (and ⌘Q via ExitRequested)
/// set this so the close is allowed through. Mirrors Electron's hide-to-tray.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Current webview zoom as a percent (100 = 1.0). Driven by View ▸ Zoom In/Out/
/// Reset; stepped ±10 and clamped to [50, 300].
static ZOOM_PERCENT: AtomicI64 = AtomicI64::new(100);

/// Always-on-top (floating) state of the main window. Toggled by the global
/// hotkey Cmd/Ctrl+Alt+T and the View ▸ Always on Top menu item — Electron parity
/// (electron-app/main.ts toggleAlwaysOnTop, same Cmd+Alt+T global shortcut).
static ALWAYS_ON_TOP: AtomicBool = AtomicBool::new(false);

/// Per-process footprint, mirroring (a subset of) the Electron `perf.getMetrics`
/// shape so the status-bar dropdown can show the real desktop RAM/CPU. NOTE: on
/// macOS the WKWebView content/GPU/network processes are XPC services reparented
/// to launchd, so attributing them to this app from sysinfo is unreliable; we
/// report the shell process here and refine attribution later.
#[derive(Serialize)]
struct PerfMetrics {
    version: String,
    /// Resident memory of the shell process, in MB.
    total_mb: f64,
    /// CPU usage percent of the shell process (single-sample; approximate).
    cpu_percent: f32,
    /// Whether the figure is the full app footprint or just the shell process.
    partial: bool,
}

#[tauri::command]
fn perf_metrics(app: tauri::AppHandle) -> PerfMetrics {
    use sysinfo::System;
    let version = app.package_info().version.to_string();
    let mut sys = System::new();
    let (total_mb, cpu_percent) = match sysinfo::get_current_pid() {
        Ok(pid) => {
            sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
            match sys.process(pid) {
                Some(p) => ((p.memory() as f64) / 1_048_576.0, p.cpu_usage()),
                None => (0.0, 0.0),
            }
        }
        Err(_) => (0.0, 0.0),
    };
    PerfMetrics { version, total_mb, cpu_percent, partial: true }
}

/// Loopback port the WKWebView reaches the data server through (plain HTTP/WS).
const PROXY_PORT: u16 = 13333;
/// The real (TLS) data server.
const UPSTREAM: &str = "127.0.0.1:3333";

/// TLS-origination proxy: accept plain TCP on 127.0.0.1:PROXY_PORT and pipe it,
/// byte-for-byte, over a TLS connection to the data server. WKWebView won't trust
/// the server's local-CA certificate, but it happily speaks plain HTTP/WS to
/// loopback — so the shell connects to http://127.0.0.1:PROXY_PORT and this task
/// adds the TLS the server requires. Transparent: HTTP, WebSocket upgrades and
/// SSE streams all pass through untouched (no L7 parsing), and the client's
/// `Origin: tauri://localhost` is preserved so the server's CORS still matches.
async fn run_tls_proxy() {
    use tokio::io::copy_bidirectional;
    use tokio::net::{TcpListener, TcpStream};

    let listener = match TcpListener::bind(("127.0.0.1", PROXY_PORT)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[proxy] bind 127.0.0.1:{PROXY_PORT} failed: {e}");
            return;
        }
    };
    let tls = match native_tls::TlsConnector::builder()
        // The server presents a local-CA cert for 127.0.0.1; we originate the TLS
        // ourselves to a hard-coded loopback address, so cert/hostname validation
        // adds nothing here — the trust boundary is "is it really 127.0.0.1:3333".
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
    {
        Ok(c) => tokio_native_tls::TlsConnector::from(c),
        Err(e) => {
            eprintln!("[proxy] TLS connector build failed: {e}");
            return;
        }
    };
    println!("[proxy] loopback TLS proxy 127.0.0.1:{PROXY_PORT} -> https://{UPSTREAM}");

    loop {
        let (mut inbound, _) = match listener.accept().await {
            Ok(p) => p,
            Err(_) => continue,
        };
        let tls = tls.clone();
        tauri::async_runtime::spawn(async move {
            let upstream = match TcpStream::connect(UPSTREAM).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[proxy] upstream connect failed: {e}");
                    return;
                }
            };
            let mut tls_stream = match tls.connect("127.0.0.1", upstream).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[proxy] upstream TLS handshake failed: {e}");
                    return;
                }
            };
            let _ = copy_bidirectional(&mut inbound, &mut tls_stream).await;
        });
    }
}

/// Show/hide the macOS traffic-light buttons (close/miniaturise/zoom) on the
/// given window. WKWebView's frameless `Overlay` titlebar shows them by default;
/// the Electron shell hides them and reveals them only while the Topics menu is
/// open. Tauri exposes no JS API for this, so we toggle the NSWindow's three
/// standard buttons directly. No-op off macOS.
#[cfg(target_os = "macos")]
fn apply_traffic_lights(window: &tauri::WebviewWindow, visible: bool) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::base::{id, nil};
    use objc::{msg_send, sel, sel_impl};

    let ptr = match window.ns_window() {
        Ok(p) => p as id,
        Err(e) => {
            eprintln!("[chrome] ns_window() failed: {e}");
            return;
        }
    };
    let mut hit = 0;
    unsafe {
        for button in [
            NSWindowButton::NSWindowCloseButton,
            NSWindowButton::NSWindowMiniaturizeButton,
            NSWindowButton::NSWindowZoomButton,
        ] {
            let b: id = ptr.standardWindowButton_(button);
            if b != nil {
                let _: () = msg_send![b, setHidden: !visible];
                hit += 1;
            }
        }
    }
    let _ = hit;
}

/// Reveal or hide the window's traffic lights. Driven by the client when the
/// Topics dropdown opens/closes (mirrors Electron's `window:showTrafficLights`).
#[tauri::command]
fn set_traffic_lights(app: tauri::AppHandle, visible: bool) {
    // Resolve the main window via the AppHandle (label "main") rather than taking a
    // `WebviewWindow` param: once native browser PANES (child webviews) are mounted,
    // the main window is multi-webview and the `WebviewWindow` invoke-extractor rejects
    // with "current webview is not a WebviewWindow" — same root cause that froze the
    // vibrancy. `get_webview_window("main")` looks up by label and works regardless.
    TRAFFIC_LIGHTS_VISIBLE.store(visible, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(win) = app.get_webview_window("main") {
            apply_traffic_lights(&win, visible);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

/// Set the NSWindow's appearance to match the app's resolved light/dark theme.
/// The traffic lights and — crucially — the per-region NSVisualEffectViews read
/// the window's effective appearance, so a single setAppearance also re-tints the
/// vibrancy material (light frost in light mode, dark frost in dark mode) with no
/// per-view work. Electron does this via `nativeTheme.themeSource`; we set the
/// NSAppearance directly since Tauri exposes no JS API for it. No-op off macOS.
#[cfg(target_os = "macos")]
fn apply_appearance(window: &tauri::WebviewWindow, dark: bool) {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    let ptr = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    unsafe {
        let name = if dark {
            "NSAppearanceNameDarkAqua"
        } else {
            "NSAppearanceNameAqua"
        };
        let ns_name: id = NSString::alloc(nil).init_str(name);
        let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: ns_name];
        if appearance != nil {
            let _: () = msg_send![ptr, setAppearance: appearance];
        }
    }
}

/// Client-driven: sync native chrome (window appearance + vibrancy tint) to the
/// resolved theme ("dark" | "light"). Mirrors Electron's `theme.setResolved`.
#[tauri::command]
fn set_theme(app: tauri::AppHandle, theme: String) {
    // Same multi-webview safety as `set_traffic_lights`: resolve the main window via
    // the AppHandle, not a `WebviewWindow` param (rejected once browser panes mount).
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let dark = theme == "dark";
        if let Some(win) = app.get_webview_window("main") {
            let win2 = win.clone();
            let _ = win.run_on_main_thread(move || apply_appearance(&win2, dark));
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, theme);
}

/// Fire a native OS notification (completion / idle toasts). The renderer's web
/// `Notification` API is unreliable in a WKWebView shell, so the client routes
/// through here under Tauri. Permission is requested by the plugin on first use
/// (macOS shows the system prompt); a denied/failed show is a silent no-op — same
/// observable contract as the web API, never an error the caller has to handle.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Toggle the main window's always-on-top (floating) state and remember it, so
/// the global hotkey and the menu item stay in sync. Electron parity:
/// electron-app/main.ts `toggleAlwaysOnTop` (same Cmd/Ctrl+Alt+T global shortcut).
fn toggle_always_on_top(app: &tauri::AppHandle) {
    use tauri::Manager;
    let next = !ALWAYS_ON_TOP.fetch_xor(true, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(next);
    }
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
struct VibRegion {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    radius: f64,
}

#[cfg(target_os = "macos")]
fn vibrancy_views() -> &'static std::sync::Mutex<std::collections::HashMap<String, usize>> {
    static V: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    V.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Pointer to the full-window frost shown DURING a window-edge resize (0 = none).
/// See `vibrancy_resize_cover`.
#[cfg(target_os = "macos")]
fn vibrancy_cover_slot() -> &'static std::sync::Mutex<usize> {
    static C: std::sync::OnceLock<std::sync::Mutex<usize>> = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(0))
}

/// `hitTest:` override for the frost views: always return nil so the
/// NSVisualEffectView is CLICK-THROUGH. Without this, once Tauri reorders the
/// browser-pane child webviews (or one is parked off-screen) the exposed frost
/// view swallows physical clicks over its rect — the "vibrancy hitTest eats
/// clicks" bug the Electron app already burned a trail on.
#[cfg(target_os = "macos")]
extern "C" fn region_hit_test(
    _this: &objc::runtime::Object,
    _sel: objc::runtime::Sel,
    _point: cocoa::foundation::NSPoint,
) -> cocoa::base::id {
    cocoa::base::nil
}

/// Lazily register `TopicsRegionVibrancyView`: an NSVisualEffectView subclass
/// whose only change is the click-through `hitTest:` above. Registered once per
/// process (OnceLock); subsequent calls return the cached class.
#[cfg(target_os = "macos")]
fn region_vibrancy_class() -> &'static objc::runtime::Class {
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, sel, sel_impl};
    static PTR: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let p = *PTR.get_or_init(|| unsafe {
        let superclass = class!(NSVisualEffectView);
        let mut decl = ClassDecl::new("TopicsRegionVibrancyView", superclass)
            .expect("register TopicsRegionVibrancyView");
        decl.add_method(
            sel!(hitTest:),
            region_hit_test
                as extern "C" fn(&Object, Sel, cocoa::foundation::NSPoint) -> cocoa::base::id,
        );
        decl.register() as *const Class as usize
    });
    unsafe { &*(p as *const objc::runtime::Class) }
}

/// Reconcile the live NSVisualEffectViews to exactly the requested regions
/// (create new, move/resize existing, remove dropped). MUST run on the main
/// thread (AppKit view mutation).
#[cfg(target_os = "macos")]
fn apply_vibrancy_regions(window: &tauri::Window, regions: Vec<VibRegion>) {
    use cocoa::base::{id, nil, YES};
    use cocoa::foundation::{NSPoint, NSRect, NSSize};
    use objc::{class, msg_send, sel, sel_impl};

    let ns_window = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return;
        }
        // A client push means a gesture SETTLED (during a live window resize the JS
        // is starved, so this never runs mid-drag) — tear down the full-window
        // resize cover so the per-region cards + clear gaps come back. Own lock
        // scope, before `vibrancy_views`, matching the cover handler's lock order.
        {
            let mut cover = vibrancy_cover_slot().lock().unwrap();
            if *cover != 0 {
                let v = *cover as id;
                let _: () = msg_send![v, removeFromSuperview];
                *cover = 0;
            }
        }
        let bounds: NSRect = msg_send![content_view, bounds];
        let content_h = bounds.size.height;

        let mut map = vibrancy_views().lock().unwrap();
        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();

        // CRITICAL for perf: a layer-backed NSView's setFrame/setCornerRadius triggers
        // an IMPLICIT 0.25s Core Animation by default. During a sidebar/divider drag we
        // push several frames/sec, so those animations STACK and the WindowServer keeps
        // recompositing the (expensive) behind-window blur for ~450ms after each push —
        // the FPS drop on sidebar toggle. Disabling actions makes every frame change
        // INSTANT: one discrete recomposite per push, no animation tail.
        let _: () = msg_send![class!(CATransaction), begin];
        let _: () = msg_send![class!(CATransaction), setDisableActions: YES];

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
                // material: sidebar=7, blendingMode: behindWindow=0, state: active=1
                let _: () = msg_send![v, setMaterial: 7i64];
                let _: () = msg_send![v, setBlendingMode: 0i64];
                let _: () = msg_send![v, setState: 1i64];
                let _: () = msg_send![v, setWantsLayer: YES];
                let layer: id = msg_send![v, layer];
                if layer != nil {
                    let _: () = msg_send![layer, setCornerRadius: r.radius];
                    let _: () = msg_send![layer, setMasksToBounds: YES];
                    // NOTE: do NOT set a negative layer.zPosition. The behind-window
                    // blur is registered by the WindowServer from the view's NORMAL
                    // position in the hierarchy; a negative zPosition excludes it
                    // from that compositing pass → the material renders as nothing
                    // (clear), which is exactly the "transparent, not blurred" bug.
                    // `addSubview:positioned:NSWindowBelow` already orders it behind
                    // the webview, which is all we need.
                }
                // Insert at the very bottom so it sits BEHIND the (transparent) webview.
                let _: () = msg_send![content_view, addSubview: v positioned: -1i64 relativeTo: nil];
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
unsafe fn ca_timing_for(timing: [f64; 4]) -> cocoa::base::id {
    use cocoa::base::id;
    use objc::{class, msg_send, sel, sel_impl};
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
fn apply_vibrancy_animation(window: &tauri::Window, regions: Vec<VibRegion>, duration_ms: f64, timing: [f64; 4]) {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSPoint, NSRect, NSSize};
    use objc::{class, msg_send, sel, sel_impl};

    let ns_window = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return;
        }
        // Tear down any window-resize cover so the per-region cards animate (parity
        // with apply_vibrancy_regions' lock order).
        {
            let mut cover = vibrancy_cover_slot().lock().unwrap();
            if *cover != 0 {
                let v = *cover as id;
                let _: () = msg_send![v, removeFromSuperview];
                *cover = 0;
            }
        }
        let bounds: NSRect = msg_send![content_view, bounds];
        let content_h = bounds.size.height;
        let map = vibrancy_views().lock().unwrap();

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
fn vibrancy_animate_regions(window: tauri::Window, regions: Vec<VibRegion>, duration_ms: f64, timing: [f64; 4]) {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || apply_vibrancy_animation(&win, regions, duration_ms, timing));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, regions, duration_ms, timing);
}

/// Client-driven: set the full list of vibrancy regions (cards/sidebar) in
/// window coords. Empty list clears all (e.g. leaving floating mode → fall back
/// to no per-region vibrancy). No-op off macOS.
#[tauri::command]
fn vibrancy_set_regions(window: tauri::Window, regions: Vec<VibRegion>) {
    // Param is `Window`, NOT `WebviewWindow`: once the layout mounts native browser
    // PANES (child webviews of the main window), the window is multi-webview and the
    // `WebviewWindow` extractor rejects every invoke with "current webview is not a
    // WebviewWindow" — silently freezing the frost at its boot layout (the root cause
    // of "la vibrancy non segue" on every drag/resize/sidebar). `Window` resolves the
    // invoking webview's parent window regardless of how many webviews it hosts.
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || apply_vibrancy_regions(&win, regions));
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
unsafe fn vibrancy_insert_cover(content_view: cocoa::base::id, bounds: cocoa::foundation::NSRect) -> cocoa::base::id {
    use cocoa::base::{id, nil, YES};
    use objc::{msg_send, sel, sel_impl};
    let _: () = msg_send![content_view, setAutoresizesSubviews: YES];
    let v: id = msg_send![region_vibrancy_class(), alloc];
    let v: id = msg_send![v, initWithFrame: bounds];
    let _: () = msg_send![v, setMaterial: 7i64];
    let _: () = msg_send![v, setBlendingMode: 0i64];
    let _: () = msg_send![v, setState: 1i64];
    let _: () = msg_send![v, setWantsLayer: YES];
    // NSViewWidthSizable(2) | NSViewHeightSizable(16) = 18 → fixed margins to all
    // edges (here 0) maintained as the superview grows/shrinks ⇒ always full-window.
    let _: () = msg_send![v, setAutoresizingMask: 18u64];
    let _: () = msg_send![content_view, addSubview: v positioned: -1i64 relativeTo: nil];
    v
}

#[cfg(target_os = "macos")]
fn vibrancy_resize_cover(window: &tauri::WebviewWindow) {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSRect;
    use objc::{msg_send, sel, sel_impl};

    let ns_window = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };
    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return;
        }
        let cover = vibrancy_cover_slot().lock().unwrap();
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
        if *cover == 0 {
            return;
        }
        let bounds: NSRect = msg_send![content_view, bounds];
        let v = *cover as id;
        let _: () = msg_send![v, setFrame: bounds];
    }
}

/// Show the full-window frost cover for a live window-edge resize, operating
/// directly on the `NSWindow` (the notification's `object`) — the per-region cards
/// are removed and a single autoresizing cover is inserted, which AppKit then keeps
/// glued to the window through the whole drag. No-op if a cover is already up or no
/// frost was ever placed (web gate / pre-mount).
#[cfg(target_os = "macos")]
unsafe fn vibrancy_begin_cover(ns_window: cocoa::base::id) {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSRect;
    use objc::{msg_send, sel, sel_impl};
    if ns_window == nil {
        return;
    }
    let content_view: id = msg_send![ns_window, contentView];
    if content_view == nil {
        return;
    }
    let mut cover = vibrancy_cover_slot().lock().unwrap();
    if *cover != 0 {
        return; // already covering
    }
    {
        let mut map = vibrancy_views().lock().unwrap();
        if map.is_empty() {
            return; // nothing placed yet — don't frost a bare window
        }
        for (_, ptr) in map.drain() {
            let v = ptr as id;
            let _: () = msg_send![v, removeFromSuperview];
        }
    }
    let bounds: NSRect = msg_send![content_view, bounds];
    *cover = vibrancy_insert_cover(content_view, bounds) as usize;
}

/// `NSWindowWillStartLiveResize` observer callback → raise the cover for the drag.
#[cfg(target_os = "macos")]
extern "C" fn on_live_resize_start(
    _this: &objc::runtime::Object,
    _sel: objc::runtime::Sel,
    notif: cocoa::base::id,
) {
    use objc::{msg_send, sel, sel_impl};
    unsafe {
        let ns_window: cocoa::base::id = msg_send![notif, object];
        vibrancy_begin_cover(ns_window);
    }
}

/// `NSWindowDidEndLiveResize` observer callback. Intentionally a near-no-op: we
/// LEAVE the cover up and let the JS settle push (`apply_vibrancy_regions`) swap it
/// back to per-region cards, so there's no transparent flash between drag-end and
/// the first reflowed push.
#[cfg(target_os = "macos")]
extern "C" fn on_live_resize_end(
    _this: &objc::runtime::Object,
    _sel: objc::runtime::Sel,
    _notif: cocoa::base::id,
) {
}

/// Lazily register `TopicsLiveResizeObserver` with the two notification callbacks,
/// returning a (leaked, process-lifetime) instance to register with the default
/// NSNotificationCenter.
#[cfg(target_os = "macos")]
fn live_resize_observer_instance() -> cocoa::base::id {
    use cocoa::base::id;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    static PTR: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let class_ptr = *PTR.get_or_init(|| unsafe {
        let superclass = class!(NSObject);
        let mut decl = ClassDecl::new("TopicsLiveResizeObserver", superclass)
            .expect("register TopicsLiveResizeObserver");
        decl.add_method(
            sel!(onLiveResizeStart:),
            on_live_resize_start as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(onLiveResizeEnd:),
            on_live_resize_end as extern "C" fn(&Object, Sel, id),
        );
        decl.register() as *const Class as usize
    });
    unsafe {
        let cls = class_ptr as *const Class;
        let obj: id = msg_send![cls, new];
        obj
    }
}

/// Wire the live-resize notifications for one window's NSWindow to the cover swap.
/// Idempotent per process is NOT required (each window registers its own observer).
#[cfg(target_os = "macos")]
fn wire_live_resize_cover(window: &tauri::WebviewWindow) {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
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
        let _: () = msg_send![nc, addObserver: obs
                                   selector: sel!(onLiveResizeStart:)
                                   name: NSWindowWillStartLiveResizeNotification
                                   object: ns_window];
        let _: () = msg_send![nc, addObserver: obs
                                   selector: sel!(onLiveResizeEnd:)
                                   name: NSWindowDidEndLiveResizeNotification
                                   object: ns_window];
    }
}

// ───────────────────────── Native browser pane ─────────────────────────
//
// Electron parity: each browser pane is a real native child webview (own
// WebContent process), positioned over the React layout's pane slot — exactly
// like Electron's WebContentsView, and far lighter than streaming screenshots
// over WS. The client (useTauriNativeBrowser) owns the geometry: it measures the
// slot's rect every layout/resize/scroll and drives `browser_set_bounds`, and to
// keep HTML overlays (dropdowns/menus/modals) on top — native views always
// composite above web content — it parks the webview OFF-SCREEN via the same
// command when a popover overlaps it (the Electron shell hides the view the same
// way during resize / when chrome covers it).

/// Per-pane webview label. Keep the prefix distinctive so it never collides with
/// the main UI webview ("main") or any future window label.
fn browser_label(id: &str) -> String {
    format!("browserpane-{id}")
}

/// Injected before any page script, on every navigation: a tiny console proxy so
/// the toolbar's console badge can show page log/warn/error counts (WKWebView has
/// no console-message delegate bridged). Buffers into `window.__topicsConsole`,
/// drained by useTauriBrowser's state poll. Idempotent + preserves native console.
const CONSOLE_PROXY_JS: &str = r#"(function(){
  if(window.__topicsConsoleInstalled)return;window.__topicsConsoleInstalled=true;
  window.__topicsConsole=[];var L=['log','info','warn','error','debug'],o={};
  function push(lvl,txt){try{window.__topicsConsole.push({level:lvl,text:String(txt).slice(0,2000)});
    if(window.__topicsConsole.length>500)window.__topicsConsole.shift();}catch(e){}}
  L.forEach(function(lvl){o[lvl]=console[lvl];console[lvl]=function(){
    try{push(lvl,Array.prototype.map.call(arguments,function(a){
      try{return typeof a==='string'?a:JSON.stringify(a)}catch(e){return String(a)}}).join(' '))}catch(e){}
    return o[lvl].apply(console,arguments);};});
  window.addEventListener('error',function(e){push('error',(e&&e.message||'error')+' @'+(e&&e.filename||'')+':'+(e&&e.lineno||0))});
  window.addEventListener('unhandledrejection',function(e){push('error','Unhandled promise rejection: '+((e&&e.reason)||''))});
})();"#;

/// Create (or, if it already exists, reuse) the native webview for a browser
/// pane and place it at the given window-relative rect.
#[tauri::command]
fn browser_open(
    app: tauri::AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::Manager;
    let label = browser_label(&id);
    if app.get_webview(&label).is_some() {
        // Already open — treat as navigate + reposition (idempotent mount).
        let _ = browser_navigate(app.clone(), id.clone(), url);
        return browser_set_bounds(app, id, x, y, width, height);
    }
    let window = app.get_window("main").ok_or("no 'main' window")?;
    let parsed: tauri::Url = url.parse().map_err(|_| format!("bad url: {url}"))?;
    window
        .add_child(
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
                .initialization_script(CONSOLE_PROXY_JS),
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Navigate an existing browser pane to a new URL.
#[tauri::command]
fn browser_navigate(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app
        .get_webview(&browser_label(&id))
        .ok_or("no such browser pane")?;
    let parsed: tauri::Url = url.parse().map_err(|_| format!("bad url: {url}"))?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

/// Reposition/resize a browser pane. To HIDE it (e.g. a dropdown overlaps it, the
/// tab is inactive, or a pane-resize is in flight) the client passes an
/// off-screen origin — keeping the native view alive (no reload) but out of the
/// way so HTML overlays show through.
#[tauri::command]
fn browser_set_bounds(
    app: tauri::AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::Manager;
    let wv = app
        .get_webview(&browser_label(&id))
        .ok_or("no such browser pane")?;
    wv.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(tauri::LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Destroy a browser pane's native webview.
#[tauri::command]
fn browser_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(&browser_label(&id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Run `js` in a webview and return its result stringified — the read-side agent
/// primitive (extract / read DOM / get url+title) for the native browser pane,
/// the part `webview.eval()` can't do (it's fire-and-forget; good for click/fill/
/// scroll, but discards return values, and the external pane origin has no Tauri
/// IPC to call back through). So we drop to the WKWebView and call
/// `evaluateJavaScript:completionHandler:` directly, bridging the async handler
/// back to this synchronous command over a one-shot channel. MUST be invoked off
/// the main thread (Tauri commands are — the handler runs ON main, we block a
/// worker on `rx`). macOS only; Win/Linux need WebView2/WebKitGTK equivalents.
#[cfg(target_os = "macos")]
fn eval_js_blocking(wv: &tauri::Webview, js: String) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::{msg_send, sel, sel_impl};
        use std::ffi::CStr;
        use std::os::raw::c_char;
        unsafe fn id_to_string(obj: cocoa::base::id) -> String {
            use cocoa::base::nil;
            use objc::{msg_send, sel, sel_impl};
            use std::ffi::CStr;
            use std::os::raw::c_char;
            if obj == nil {
                return String::new();
            }
            // `description` is defined on every NSObject and returns an NSString; for an
            // NSString it IS the string, so this stringifies ANY JS result type safely.
            let desc: cocoa::base::id = msg_send![obj, description];
            let c: *const c_char = msg_send![desc, UTF8String];
            if c.is_null() { String::new() } else { CStr::from_ptr(c).to_string_lossy().into_owned() }
        }
        unsafe {
            let wk = platform.inner() as id; // WKWebView
            let nsjs: id = NSString::alloc(nil).init_str(&js);
            let tx2 = tx.clone();
            let handler = block::ConcreteBlock::new(move |result: id, error: id| {
                let out = if error != nil { Err(id_to_string(error)) } else { Ok(id_to_string(result)) };
                let _ = tx2.send(out);
            });
            let handler = handler.copy();
            let _: () = msg_send![wk, evaluateJavaScript: nsjs completionHandler: &*handler];
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|_| "eval timeout".to_string())?
}

/// Evaluate JS in a browser pane and return the stringified result. Read-side
/// agent primitive for the native pane (extract DOM text, current url/title, any
/// `JSON.stringify(...)` payload). The action ops (click/fill/scroll) go through
/// `webview.eval()` which doesn't need a return value.
///
/// MUST be `async`: `eval_js_blocking` blocks the calling thread until the
/// WKWebView completion handler runs ON THE MAIN THREAD. A sync command runs ON
/// main, so it would block main waiting for main → deadlock (8s timeout every
/// poll tick = a frozen app). As `async` Tauri drives it off-main; we further
/// hop to the blocking pool via `spawn_blocking` so we never stall an async
/// runtime worker, leaving main free to service the completion handler.
#[tauri::command]
async fn browser_eval_js(app: tauri::AppHandle, id: String, js: String) -> Result<String, String> {
    let label = browser_label(&id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "macos")]
        {
            return eval_js_blocking(&wv, js);
        }
        #[allow(unreachable_code)]
        {
            let _ = (wv, js);
            Err("browser_eval_js: macOS only".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fire-and-forget JS in a pane (no return value) — the ACTION side: zoom via
/// `document.body.style.zoom`, `window.find(...)`, click/fill/scroll. Uses the
/// cross-platform `webview.eval()` (no native bridge needed).
#[tauri::command]
fn browser_exec_js(app: tauri::AppHandle, id: String, js: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app
        .get_webview(&browser_label(&id))
        .ok_or("no such browser pane")?;
    wv.eval(&js).map_err(|e| e.to_string())
}

/// Native WKWebView history nav — REAL `goBack`/`goForward`/`reload` (vs the old
/// JS-history hack that just re-navigated to the current URL). `which`: 0=back,
/// 1=forward, 2=reload. UI methods, so they run on the main thread via
/// `with_webview`. macOS only (Win/Linux WebView2/WebKitGTK have own nav APIs).
#[cfg(target_os = "macos")]
fn wk_nav(wv: &tauri::Webview, which: u8) {
    let _ = wv.with_webview(move |platform| unsafe {
        use cocoa::base::id;
        use objc::{msg_send, sel, sel_impl};
        let wk = platform.inner() as id;
        match which {
            0 => {
                let _: id = msg_send![wk, goBack];
            }
            1 => {
                let _: id = msg_send![wk, goForward];
            }
            _ => {
                let _: id = msg_send![wk, reload];
            }
        }
    });
}

/// Real "Back" — WKWebView document history (not a JS re-nav).
#[tauri::command]
fn browser_back(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
    #[cfg(target_os = "macos")]
    wk_nav(&wv, 0);
    #[cfg(not(target_os = "macos"))]
    let _ = wv;
    Ok(())
}

/// Real "Forward" — WKWebView document history.
#[tauri::command]
fn browser_forward(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
    #[cfg(target_os = "macos")]
    wk_nav(&wv, 1);
    #[cfg(not(target_os = "macos"))]
    let _ = wv;
    Ok(())
}

/// Real "Reload" — WKWebView reload (preserves history position, vs re-navigate).
#[tauri::command]
fn browser_reload(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
    #[cfg(target_os = "macos")]
    wk_nav(&wv, 2);
    #[cfg(not(target_os = "macos"))]
    let _ = wv;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance FIRST (plugin requirement): a duplicate launch focuses
        // the running window instead of spawning a process that can't bind :13333.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // Navigation guard: a stray external nav in the MAIN webview would escape
        // tauri://localhost and white-screen the whole app (no recovery but
        // restart). Allow only the app origin + the loopback proxy; route anything
        // else to the OS browser. Browser PANES (label "browserpane-*") navigate
        // freely — they're meant to load the open web.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("nav-guard")
                .on_navigation(|webview, url| {
                    if webview.label() != "main" {
                        return true;
                    }
                    let allowed = matches!(url.scheme(), "tauri" | "ipc" | "about" | "blob" | "data")
                        || (url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(PROXY_PORT));
                    if !allowed {
                        use tauri::Manager;
                        use tauri_plugin_opener::OpenerExt;
                        let _ = webview
                            .app_handle()
                            .opener()
                            .open_url(url.to_string(), None::<&str>);
                    }
                    allowed
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Persist + restore the window's size / position / maximized state across
        // launches (Electron remembered its bounds; a bare Tauri window didn't).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Auto-update — reads plugins.updater (endpoint + pubkey) from tauri.conf.json.
        // Inert until a signed release is published; the client drives check/install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Native menu — a WKWebView shell with NO app menu also has no working
        // Cmd+C/V/X/A/Z and no Reload. Build the standard macOS menus plus an
        // explicit View ▸ Reload (Cmd+R / Cmd+Shift+R), matching the Electron app.
        .menu(|handle| {
            use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
            let reload = MenuItem::with_id(handle, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let force_reload =
                MenuItem::with_id(handle, "force-reload", "Force Reload", true, Some("CmdOrCtrl+Shift+R"))?;
            let zoom_in = MenuItem::with_id(handle, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
            let zoom_out = MenuItem::with_id(handle, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
            let zoom_reset =
                MenuItem::with_id(handle, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
            // No accelerator: the Cmd/Ctrl+Alt+T chord is owned by the global
            // shortcut (works unfocused too); a menu accelerator on the same chord
            // would double-fire and cancel the toggle when the window is focused.
            let always_on_top =
                MenuItem::with_id(handle, "always-on-top", "Always on Top", true, None::<&str>)?;
            // Custom Quit (not the predefined .quit()) so ⌘Q sets QUITTING before
            // exiting — otherwise the hide-to-tray CloseRequested handler would
            // swallow the quit and trap the app in the tray.
            let app_quit =
                MenuItem::with_id(handle, "app-quit", "Quit Topics", true, Some("CmdOrCtrl+Q"))?;
            let app_menu = SubmenuBuilder::new(handle, "Topics")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(&app_quit)
                .build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&reload)
                .item(&force_reload)
                .separator()
                .item(&zoom_in)
                .item(&zoom_out)
                .item(&zoom_reset)
                .separator()
                .item(&always_on_top)
                .separator()
                .fullscreen()
                .build()?;
            // NOTE: no `.close_window()` — its default ⌘W accelerator would close
            // the whole window, but in Topics ⌘W closes the focused PANE (handled
            // in the renderer, useKeyboardShortcuts). The window is closed via the
            // traffic-light button. (A pane-close menu accelerator that also works
            // when a child browser webview holds focus lands in the browser phase.)
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .maximize()
                .build()?;
            let help_github =
                MenuItem::with_id(handle, "help-github", "Topics on GitHub", true, None::<&str>)?;
            let help_menu = SubmenuBuilder::new(handle, "Help").item(&help_github).build()?;
            MenuBuilder::new(handle)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                .build()
        })
        .on_menu_event(|app, event| {
            use tauri::Manager;
            match event.id().0.as_str() {
                "reload" | "force-reload" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.eval("window.location.reload()");
                    }
                }
                "app-quit" => {
                    QUITTING.store(true, Ordering::Relaxed);
                    app.exit(0);
                }
                "always-on-top" => toggle_always_on_top(app),
                id @ ("zoom-in" | "zoom-out" | "zoom-reset") => {
                    let cur = ZOOM_PERCENT.load(Ordering::Relaxed);
                    let next = match id {
                        "zoom-in" => (cur + 10).min(300),
                        "zoom-out" => (cur - 10).max(50),
                        _ => 100,
                    };
                    ZOOM_PERCENT.store(next, Ordering::Relaxed);
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.set_zoom(next as f64 / 100.0);
                    }
                }
                "help-github" => {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app
                        .opener()
                        .open_url("https://github.com/armonia/topics-app", None::<&str>);
                }
                _ => {}
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Global hotkey (Electron parity): Cmd/Ctrl+Alt+T toggles always-on-top.
            // Only this one shortcut is registered, so the handler needn't match it.
            // The chord registration is NON-fatal: if it's already taken system-wide
            // we log and carry on (Electron does the same) — never block startup on it.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, GlobalShortcutExt, ShortcutState};
                app.handle().plugin(
                    GlobalShortcutBuilder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                toggle_always_on_top(app);
                            }
                        })
                        .build(),
                )?;
                if let Err(e) = app.handle().global_shortcut().register("CommandOrControl+Alt+T") {
                    log::warn!("[topics] Cmd+Alt+T global shortcut not registered: {e}");
                }
            }

            // Dev hot-reload (Electron-parity). In `tauri dev` the frontendDist is
            // served from DISK, so watch /public and reload the webview when a
            // `vite build` lands new assets — the same loop Electron's prod
            // asset-watcher gives. Compiled out of release (assets are embedded).
            // NB: Vite HMR via a remote devUrl is NOT an option here — Tauri injects
            // native IPC ONLY on the tauri:// origin, so an http dev origin would
            // kill vibrancy/perf/data; a full reload on tauri:// keeps them working.
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    use notify::{RecursiveMode, Watcher};
                    let public = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../public"));
                    let (tx, rx) = std::sync::mpsc::channel();
                    let mut watcher = match notify::recommended_watcher(move |res| { let _ = tx.send(res); }) {
                        Ok(w) => w,
                        Err(e) => { eprintln!("[hot-reload] init failed: {e}"); return; }
                    };
                    if let Err(e) = watcher.watch(&public, RecursiveMode::Recursive) {
                        eprintln!("[hot-reload] watch {public:?} failed: {e}");
                        return;
                    }
                    eprintln!("[hot-reload] watching {public:?}");
                    loop {
                        // Block for the first event of a burst, then drain follow-ups
                        // until the writes go quiet (a vite build touches many files)
                        // — reload exactly once per build.
                        if rx.recv().is_err() { break; }
                        while rx.recv_timeout(std::time::Duration::from_millis(250)).is_ok() {}
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.eval("window.location.reload()");
                        }
                    }
                });
            }

            // Start the loopback TLS-origination proxy so the shell can reach the
            // data server (whose cert WKWebView rejects) over plain HTTP/WS.
            tauri::async_runtime::spawn(run_tls_proxy());

            // Traffic lights hidden by default — revealed on demand when the
            // Topics menu opens (parity with the Electron shell).
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                for (_label, win) in app.webview_windows() {
                    apply_traffic_lights(&win, false);
                    // Live window-edge resize: AppKit posts WillStart/DidEnd live-resize
                    // notifications SYNCHRONOUSLY (unlike tao's WindowEvent::Resized, which
                    // is only drained at gesture end), so we swap to an autoresizing frost
                    // cover for the duration of the drag.
                    wire_live_resize_cover(&win);
                    // Re-assert the desired visibility whenever AppKit might have
                    // reset it (focus gained/lost, resize) — otherwise the buttons
                    // reappear on the first focus of a transparent-titlebar window.
                    let w = win.clone();
                    win.on_window_event(move |event| match event {
                        tauri::WindowEvent::Resized(_) => {
                            // PROGRAMMATIC resize path (set_size / zoom): these deliver
                            // Resized promptly and post NO live-resize notification, so the
                            // cover is sized here. (Interactive drags are handled by the
                            // notification + autoresizing mask above.)
                            vibrancy_resize_cover(&w);
                            // Same titlebar re-pin as a focus change.
                            let visible = TRAFFIC_LIGHTS_VISIBLE.load(Ordering::Relaxed)
                                || w.is_fullscreen().unwrap_or(false);
                            apply_traffic_lights(&w, visible);
                        }
                        tauri::WindowEvent::Focused(_) => {
                            // In fullscreen the titlebar is gone, so FORCE the
                            // traffic lights visible — otherwise (hidden-by-default
                            // + hidden green button) the only way out is the View ▸
                            // Full Screen accelerator, which is a trap for anyone
                            // who doesn't know it. Otherwise honor the menu state.
                            let visible = TRAFFIC_LIGHTS_VISIBLE.load(Ordering::Relaxed)
                                || w.is_fullscreen().unwrap_or(false);
                            apply_traffic_lights(&w, visible);
                        }
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            // Hide to the tray instead of closing (the tray's "Esci"
                            // and ⌘Q set QUITTING so a real quit still passes through).
                            if !QUITTING.load(Ordering::Relaxed) {
                                api.prevent_close();
                                let _ = w.hide();
                            }
                        }
                        _ => {}
                    });
                }
            }

            // System tray: keep the app reachable (Show / Quit) when its window is
            // hidden. Electron ships a tray; without one a hidden Tauri window leaves
            // the user no way back in or out. Unread / Claude-phase status wiring
            // stays in the client WS layer (a later step) — this is the baseline.
            {
                use tauri::menu::{MenuBuilder, MenuItem};
                use tauri::tray::TrayIconBuilder;
                use tauri::Manager;
                let handle = app.handle();
                let show = MenuItem::with_id(handle, "tray-show", "Mostra Topics", true, None::<&str>)?;
                let quit = MenuItem::with_id(handle, "tray-quit", "Esci", true, None::<&str>)?;
                let tray_menu = MenuBuilder::new(handle).items(&[&show, &quit]).build()?;
                let mut builder = TrayIconBuilder::new()
                    .tooltip("Topics")
                    .menu(&tray_menu)
                    .on_menu_event(|app, event| match event.id().0.as_str() {
                        "tray-show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "tray-quit" => {
                            QUITTING.store(true, Ordering::Relaxed);
                            app.exit(0);
                        }
                        _ => {}
                    });
                if let Some(icon) = app.default_window_icon() {
                    builder = builder.icon(icon.clone());
                }
                let _ = builder.build(app.handle())?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            perf_metrics,
            set_traffic_lights,
            set_theme,
            notify,
            vibrancy_set_regions,
            vibrancy_animate_regions,
            browser_open,
            browser_navigate,
            browser_set_bounds,
            browser_close,
            browser_eval_js,
            browser_exec_js,
            browser_back,
            browser_forward,
            browser_reload
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
