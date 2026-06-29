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

/// Update metadata handed to the renderer by `updater_check`.
#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

/// Check the configured endpoint for a newer signed release. Returns the update
/// metadata, or `None` when already current. Errors (no manifest / not yet
/// published / network) surface as a string for the client to show. Electron
/// parity: `updater:check-for-updates`. Inert until a signed tauri-v* release is
/// published (see `plugins.updater` in tauri.conf.json).
#[tauri::command]
async fn updater_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    Ok(found.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download + install the available update, then restart into it. Tauri's update
/// is atomic (download and install are one call), so the client maps its
/// "download" affordance to a no-op transition and drives the real work from here
/// (the "Restart to update" action). Never returns on success — the process is
/// replaced. Electron parity: `updater:quit-and-install`.
#[tauri::command]
async fn updater_install(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
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
            let mut cover = vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner());
            if *cover != 0 {
                let v = *cover as id;
                let _: () = msg_send![v, removeFromSuperview];
                *cover = 0;
            }
        }
        let bounds: NSRect = msg_send![content_view, bounds];
        let content_h = bounds.size.height;

        let mut map = vibrancy_views().lock().unwrap_or_else(|e| e.into_inner());
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
            let mut cover = vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner());
            if *cover != 0 {
                let v = *cover as id;
                let _: () = msg_send![v, removeFromSuperview];
                *cover = 0;
            }
        }
        let bounds: NSRect = msg_send![content_view, bounds];
        let content_h = bounds.size.height;
        let map = vibrancy_views().lock().unwrap_or_else(|e| e.into_inner());

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
        let cover = vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner());
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
    let mut cover = vibrancy_cover_slot().lock().unwrap_or_else(|e| e.into_inner());
    if *cover != 0 {
        return; // already covering
    }
    {
        let mut map = vibrancy_views().lock().unwrap_or_else(|e| e.into_inner());
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
///
/// INVARIANT: this app has exactly ONE persistent top-level window ('main', created at
/// startup, never torn down — browser panes are child webviews, not windows). The
/// NSNotificationCenter observer registered here is therefore intentionally NEVER
/// removed: it lives as long as the window, i.e. the whole process. If a SECOND
/// top-level NSWindow is ever introduced AND can close, add a matching `removeObserver`
/// on its close — otherwise its observer dangles at a freed NSWindow (use-after-free on
/// the next live-resize notification). Each window registers its own observer, so this
/// need not be idempotent per process.
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

// ── Downloads ────────────────────────────────────────────────────────────────
// wry exposes WKWebView's download delegate via WebviewBuilder::on_download, but
// gives only Requested + Finished (no progress, and on macOS the final path is
// empty). We choose the save path (~/Downloads/<name>) on Requested and queue
// start/done events the client drains (browser_take_download_events) to drive the
// DownloadStrip — a start spinner then a done check, no %.
#[derive(Clone, Serialize)]
struct DownloadEventMsg {
    kind: String, // "start" | "done"
    id: String,
    url: String,
    filename: String,
    success: bool,
    state: String, // done: "completed" | "interrupted"
    #[serde(rename = "savedPath")]
    saved_path: String,
}

static DOWNLOAD_EVENTS: std::sync::Mutex<Vec<DownloadEventMsg>> = std::sync::Mutex::new(Vec::new());
static DOWNLOAD_PENDING: std::sync::Mutex<Vec<(String, i64, String)>> = std::sync::Mutex::new(Vec::new()); // (url, id, savedPath)
static DOWNLOAD_ID: AtomicI64 = AtomicI64::new(1);

/// Drain queued download start/done events for the DownloadStrip to apply.
#[tauri::command]
fn browser_take_download_events() -> Vec<DownloadEventMsg> {
    match DOWNLOAD_EVENTS.lock() {
        Ok(mut v) => std::mem::take(&mut *v),
        Err(_) => Vec::new(),
    }
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

/// Disable the WKWebView layer's IMPLICIT Core Animation actions (position/bounds/
/// frame/…). A layer-backed NSView animates its frame over ~0.25s by default; for a
/// browser pane that the layout moves every frame — a divider drag, a PUSH-mode
/// sidebar slide, a window resize — those implicit animations STACK and the
/// WindowServer keeps recompositing for ~450ms after each push (the FPS drop).
/// Mapping the layer's actions to NSNull makes every set_position/set_size land
/// INSTANTLY: one discrete frame per push, no animation tail. Same intent as the
/// CATransaction(setDisableActions:YES) the vibrancy frost uses, but set ONCE at
/// open since the view persists. This is the structural fix — we do NOT hide the
/// pane during the move. macOS only.
#[cfg(target_os = "macos")]
fn disable_layer_implicit_animations(wv: &tauri::Webview) {
    let _ = wv.with_webview(move |platform| unsafe {
        use cocoa::base::{id, nil, YES};
        use cocoa::foundation::NSString;
        use objc::{class, msg_send, sel, sel_impl};
        let view = platform.inner() as id;
        if view == nil {
            return;
        }
        let _: () = msg_send![view, setWantsLayer: YES];
        let layer: id = msg_send![view, layer];
        if layer == nil {
            return;
        }
        let null: id = msg_send![class!(NSNull), null];
        let dict: id = msg_send![class!(NSMutableDictionary), dictionary];
        // Geometry/visibility keys whose default action is an implicit animation.
        for key in [
            "position", "bounds", "frame", "contents", "hidden", "onOrderIn", "onOrderOut", "sublayers",
        ] {
            let k: id = NSString::alloc(nil).init_str(key);
            let _: () = msg_send![dict, setObject: null forKey: k];
        }
        let _: () = msg_send![layer, setActions: dict];
    });
}

/// Round the browser pane's WKWebView layer at the corners that are FLUSH with the
/// window's own rounded corners — otherwise the opaque native child webview paints a
/// square corner over the window's ~10pt radius (the "border radius non corretto"
/// the user saw where a browser sits). Inner corners (where the pane abuts another
/// pane) stay square. We round the CHILD webview's layer, NOT the window content view
/// (that broke auto-resize + sidebar spacing). `win_w`/`win_h` are the window's
/// LOGICAL content size; the pane rect is window-relative logical. macOS only.
/// Per-pane cache of the last applied corner-flush state (flip-independent 4-bit
/// visual code: tl|tr<<1|bl<<2|br<<3). browser_set_bounds runs every frame during a
/// drag, but the pane stays flush to the SAME window corner(s) throughout — so this lets
/// us skip the objc/with_webview work on every frame except the one where it changes.
#[cfg(target_os = "macos")]
fn browser_corner_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, u8>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u8>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Per-pane cache of the LAST applied rect (x,y,w,h). `browser_set_bounds` is also
/// driven by the placeholder's bounds-tracking poll / ResizeObserver, which re-push
/// the SAME rect when nothing actually moved; setting identical bounds is a no-op, so
/// we skip the move FFI + the window-size FFI + the corner mask on those frames.
/// Every move goes through `browser_set_bounds`, so the cache stays in lockstep with
/// the real webview position. Cross-platform (the move calls aren't macOS-specific).
fn browser_bounds_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, (f64, f64, f64, f64)>> {
    static B: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (f64, f64, f64, f64)>>,
    > = std::sync::OnceLock::new();
    B.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg(target_os = "macos")]
fn apply_browser_corner_mask(wv: &tauri::Webview, id: &str, x: f64, y: f64, w: f64, h: f64, win_w: f64, win_h: f64) {
    const RADIUS: f64 = 10.0; // standard macOS window corner radius
    const EPS: f64 = 2.0;
    let flush_left = x <= EPS;
    let flush_top = y <= EPS;
    let flush_right = win_w > 0.0 && (x + w) >= (win_w - EPS);
    let flush_bottom = win_h > 0.0 && (y + h) >= (win_h - EPS);
    let tl = flush_left && flush_top;
    let tr = flush_right && flush_top;
    let bl = flush_left && flush_bottom;
    let br = flush_right && flush_bottom;
    // Skip the (main-thread) objc round-trip when the flush state is unchanged for this
    // pane — the common case on every drag frame after the first.
    let visual: u8 = (tl as u8) | ((tr as u8) << 1) | ((bl as u8) << 2) | ((br as u8) << 3);
    {
        let mut g = match browser_corner_cache().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.get(id) == Some(&visual) {
            return;
        }
        g.insert(id.to_string(), visual);
    }
    let _ = wv.with_webview(move |platform| unsafe {
        use cocoa::base::{id, nil, NO, YES};
        use objc::{msg_send, sel, sel_impl};
        let view = platform.inner() as id;
        if view == nil {
            return;
        }
        let _: () = msg_send![view, setWantsLayer: YES];
        let layer: id = msg_send![view, layer];
        if layer == nil {
            return;
        }
        if !(tl || tr || bl || br) {
            // No corner coincides with a window corner → keep it square.
            let _: () = msg_send![layer, setMasksToBounds: NO];
            let _: () = msg_send![layer, setCornerRadius: 0.0_f64];
            return;
        }
        // CACornerMask bits depend on whether the layer geometry is flipped (web
        // content usually is): flipped → MinY is the VISUAL top.
        const MINX_MINY: u64 = 1;
        const MAXX_MINY: u64 = 2;
        const MINX_MAXY: u64 = 4;
        const MAXX_MAXY: u64 = 8;
        let flipped: bool = {
            let b: cocoa::base::BOOL = msg_send![layer, isGeometryFlipped];
            b != NO
        };
        let (tl_bit, tr_bit, bl_bit, br_bit) = if flipped {
            (MINX_MINY, MAXX_MINY, MINX_MAXY, MAXX_MAXY)
        } else {
            (MINX_MAXY, MAXX_MAXY, MINX_MINY, MAXX_MINY)
        };
        let mut mask: u64 = 0;
        if tl {
            mask |= tl_bit;
        }
        if tr {
            mask |= tr_bit;
        }
        if bl {
            mask |= bl_bit;
        }
        if br {
            mask |= br_bit;
        }
        let _: () = msg_send![layer, setCornerRadius: RADIUS];
        let _: () = msg_send![layer, setMaskedCorners: mask];
        let _: () = msg_send![layer, setMasksToBounds: YES];
        if std::env::var("TOPICS_CORNER_DEMO").is_ok() {
            let rback: f64 = msg_send![layer, cornerRadius];
            let mback: u64 = msg_send![layer, maskedCorners];
            let clips: cocoa::base::BOOL = msg_send![layer, masksToBounds];
            eprintln!(
                "[corner-mask] flush(l{} t{} r{} b{}) tl{} tr{} bl{} br{} flipped={} mask={} -> radius={} maskedBack={} clips={}",
                flush_left as u8, flush_top as u8, flush_right as u8, flush_bottom as u8,
                tl as u8, tr as u8, bl as u8, br as u8, flipped as u8, mask, rback, mback, clips != NO
            );
        }
    });
}

/// Window LOGICAL content size (points), for corner-flush math. macOS only.
#[cfg(target_os = "macos")]
fn main_window_logical_size(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    use tauri::Manager;
    let win = app.get_window("main")?;
    let sf = win.scale_factor().ok()?;
    let is = win.inner_size().ok()?;
    Some((is.width as f64 / sf, is.height as f64 / sf))
}

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
                .initialization_script(CONSOLE_PROXY_JS)
                .on_download(|_webview, event| {
                    use tauri::webview::DownloadEvent;
                    match event {
                        DownloadEvent::Requested { url, destination } => {
                            let url_s = url.to_string();
                            let filename = url
                                .path_segments()
                                .and_then(|mut s| s.next_back().map(|x| x.to_string()))
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| "download".to_string());
                            let saved = if let Ok(home) = std::env::var("HOME") {
                                let dest = std::path::PathBuf::from(home).join("Downloads").join(&filename);
                                let s = dest.to_string_lossy().to_string();
                                *destination = dest;
                                s
                            } else {
                                String::new()
                            };
                            let id = DOWNLOAD_ID.fetch_add(1, Ordering::SeqCst);
                            if let Ok(mut p) = DOWNLOAD_PENDING.lock() {
                                // Bound the pending set: an orphaned Requested (cancelled /
                                // redirected URL / no matching Finished) would otherwise leak
                                // for the process lifetime. 64 is far more than ever in flight;
                                // evict oldest-first.
                                if p.len() >= 64 {
                                    let overflow = p.len() - 63;
                                    p.drain(0..overflow);
                                }
                                p.push((url_s.clone(), id, saved.clone()));
                            }
                            if let Ok(mut v) = DOWNLOAD_EVENTS.lock() {
                                v.push(DownloadEventMsg {
                                    kind: "start".into(),
                                    id: id.to_string(),
                                    url: url_s,
                                    filename,
                                    success: false,
                                    state: "progressing".into(),
                                    saved_path: saved,
                                });
                            }
                        }
                        DownloadEvent::Finished { url, path: _, success } => {
                            let url_s = url.to_string();
                            let (id, saved) = {
                                let mut p = DOWNLOAD_PENDING.lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(pos) = p.iter().position(|(u, _, _)| *u == url_s) {
                                    let (_, i, s) = p.remove(pos);
                                    (i, s)
                                } else {
                                    (DOWNLOAD_ID.fetch_add(1, Ordering::SeqCst), String::new())
                                }
                            };
                            if let Ok(mut v) = DOWNLOAD_EVENTS.lock() {
                                v.push(DownloadEventMsg {
                                    kind: "done".into(),
                                    id: id.to_string(),
                                    url: url_s,
                                    filename: String::new(),
                                    success,
                                    state: if success { "completed".into() } else { "interrupted".into() },
                                    saved_path: saved,
                                });
                            }
                        }
                        _ => {}
                    }
                    true
                }),
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    // Structural FPS fix: make the pane's frame changes instant (no implicit CA
    // animation to stack during a divider/sidebar/window-resize move).
    #[cfg(target_os = "macos")]
    if let Some(wv) = app.get_webview(&label) {
        disable_layer_implicit_animations(&wv);
        if let Some((win_w, win_h)) = main_window_logical_size(&app) {
            apply_browser_corner_mask(&wv, &id, x, y, width, height, win_w, win_h);
        }
    }
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
    // Skip redundant identical re-pushes (poll / ResizeObserver re-send the same rect
    // when nothing moved): setting identical bounds is a no-op, so we avoid the move FFI
    // + window-size FFI + corner mask on those frames.
    let rect = (x, y, width, height);
    {
        let mut g = match browser_bounds_cache().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if g.get(&id) == Some(&rect) {
            return Ok(());
        }
        g.insert(id.clone(), rect);
    }
    wv.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(tauri::LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())?;
    // Re-evaluate which corners are flush with the window edge (it changes as the
    // pane moves/resizes) and round only those — cached, so the objc work runs only
    // when the flush state actually changes (not every drag frame). See apply_browser_corner_mask.
    #[cfg(target_os = "macos")]
    if let Some((win_w, win_h)) = main_window_logical_size(&app) {
        apply_browser_corner_mask(&wv, &id, x, y, width, height, win_w, win_h);
    }
    Ok(())
}

/// Destroy a browser pane's native webview.
#[tauri::command]
fn browser_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(&browser_label(&id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    // Drop the cache entries so a re-opened pane on the same id re-applies move + mask.
    if let Ok(mut g) = browser_bounds_cache().lock() {
        g.remove(&id);
    }
    #[cfg(target_os = "macos")]
    if let Ok(mut g) = browser_corner_cache().lock() {
        g.remove(&id);
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

/// The novel/risky part of screenshotting, isolated so it's unit-testable headless
/// (no webview/app/run-loop): an `NSImage*` → base64 PNG string via
/// `CGImageForProposedRect → NSBitmapImageRep → representationUsingType:4 (PNG) →
/// base64EncodedStringWithOptions`. SAFETY: `img` must be a valid NSImage id.
#[cfg(target_os = "macos")]
unsafe fn nsimage_to_png_base64(img: cocoa::base::id) -> Result<String, String> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;
    if img == nil {
        return Err("nil NSImage".to_string());
    }
    // NSImage → CGImage → NSBitmapImageRep → PNG NSData → base64 NSString.
    let null_rect: *const cocoa::foundation::NSRect = std::ptr::null();
    let cg: id = msg_send![img, CGImageForProposedRect: null_rect context: nil hints: nil];
    if cg == nil {
        return Err("no CGImage".to_string());
    }
    let rep: id = msg_send![class!(NSBitmapImageRep), alloc];
    let rep: id = msg_send![rep, initWithCGImage: cg];
    if rep == nil {
        return Err("no NSBitmapImageRep".to_string());
    }
    let props: id = msg_send![class!(NSDictionary), dictionary];
    // NSBitmapImageFileTypePNG = 4
    let png: id = msg_send![rep, representationUsingType: 4u64 properties: props];
    if png == nil {
        return Err("no PNG data".to_string());
    }
    let b64: id = msg_send![png, base64EncodedStringWithOptions: 0u64];
    let c: *const c_char = msg_send![b64, UTF8String];
    if c.is_null() {
        return Err("no base64".to_string());
    }
    Ok(CStr::from_ptr(c).to_string_lossy().into_owned())
}

/// Capture the pane as a base64 PNG via WKWebView `takeSnapshotWithConfiguration:`
/// (async completion handler → channel, same off-main pattern as eval). Feeds the
/// agent's `browser_screenshot` op on the native pane. macOS only.
#[cfg(target_os = "macos")]
fn screenshot_blocking(wv: &tauri::Webview) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        use cocoa::base::{id, nil};
        use objc::{class, msg_send, sel, sel_impl};
        unsafe {
            let wk = platform.inner() as id;
            let cfg: id = msg_send![class!(WKSnapshotConfiguration), new];
            let tx2 = tx.clone();
            let handler = block::ConcreteBlock::new(move |img: id, err: id| {
                let out: Result<String, String> = if err != nil {
                    Err("takeSnapshot failed".to_string())
                } else {
                    unsafe { nsimage_to_png_base64(img) }
                };
                let _ = tx2.send(out);
            });
            let handler = handler.copy();
            let _: () = msg_send![wk, takeSnapshotWithConfiguration: cfg completionHandler: &*handler];
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "screenshot timeout".to_string())?
}

/// Screenshot the pane → base64 PNG. Async (off-main) for the same reason as
/// browser_eval_js — the completion handler runs on the main thread.
#[tauri::command]
async fn browser_screenshot(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let label = browser_label(&id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "macos")]
        {
            return screenshot_blocking(&wv);
        }
        #[allow(unreachable_code)]
        {
            let _ = wv;
            Err("browser_screenshot: macOS only".to_string())
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

/// Toggle the pane's Web Inspector (DevTools). Uses Tauri's own
/// open/close_devtools (the `devtools` Cargo feature is enabled so it's live in
/// release too) — no private API. Opens Safari's Web Inspector for the pane.
#[tauri::command]
fn browser_toggle_devtools(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
    if wv.is_devtools_open() {
        wv.close_devtools();
    } else {
        wv.open_devtools();
    }
    Ok(())
}

/// Return AppKit first-responder to the MAIN webview (the React chrome). A native
/// browser pane is a sibling WKWebView that can hold keyboard first-responder, so
/// after interacting with a page a tab click can feel "stuck" in the pane. The tab
/// strip calls this on pointer-down. Principled AppKit hygiene (not a hide/kludge):
/// worst case it's a no-op. macOS only.
#[tauri::command]
fn browser_release_focus(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(main_wv) = app.get_webview("main") {
            let _ = main_wv.with_webview(move |platform| unsafe {
                use cocoa::base::{id, nil};
                use objc::{msg_send, sel, sel_impl};
                let view = platform.inner() as id;
                if view == nil {
                    return;
                }
                let ns_window: id = msg_send![view, window];
                if ns_window != nil {
                    let _: () = msg_send![ns_window, makeFirstResponder: view];
                }
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

/// Injected probe for the env-gated sidebar FPS self-test: samples rAF frame deltas
/// while driving 6 real sidebar collapse/expands (via the diagnostic global App.tsx
/// exposes), then posts a frame-timing summary to `fps_report`. A composited
/// translateX (overlay mode) should yield ~60fps with zero dropped frames.
const FPS_SELFTEST_JS: &str = r#"(async function(){
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function report(o){ try{window.__TAURI_INTERNALS__.invoke('fps_report',{result:JSON.stringify(o)})}catch(e){} }
  // The React app may mount after this injects — poll for the diagnostic toggle.
  var toggle=null;
  for(var k=0;k<40;k++){ toggle=window.__topicsToggleSidebar; if(typeof toggle==='function')break; await sleep(500); }
  if(typeof toggle!=='function'){ report({error:'no __topicsToggleSidebar after 20s'}); return; }
  var deltas=[],last=0,running=true;
  function loop(t){ if(last)deltas.push(t-last); last=t; if(running)requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  await sleep(400);
  for(var i=0;i<6;i++){ try{toggle()}catch(e){} await sleep(350); }
  running=false;
  var d=deltas.filter(function(x){return x>0&&x<2000});
  if(!d.length){ report({error:'no frames sampled'}); return; }
  var max=0,sum=0,dropped=0,bad=0;
  for(var j=0;j<d.length;j++){ var x=d[j]; sum+=x; if(x>max)max=x; if(x>20)dropped++; if(x>33)bad++; }
  report({frames:d.length,avgFps:Math.round(1000/(sum/d.length)),maxFrameMs:Math.round(max),droppedGt20ms:dropped,droppedGt33ms:bad,toggles:6,xterms:document.querySelectorAll('.xterm').length,visibleXterms:Array.prototype.filter.call(document.querySelectorAll('.xterm'),function(e){return e.offsetParent!==null}).length,panes:document.querySelectorAll('[data-pane-id]').length,canvasOk:(window.__canvasOk||0)});
})();"#;

/// Injected probe for the env-gated SPLIT-resize FPS self-test (`TOPICS_SPLIT_SELFTEST`).
/// Finds a layout divider and synthesizes a sustained oscillating drag (real mousedown
/// on the divider + window mousemoves with buttons=1 + mouseup), sampling rAF deltas
/// throughout. A divider drag moves browser panes (instant via NSNull) and resizes the
/// flex cells; terminals coalesce their fits to the drag end — so this should hold ~60fps
/// with zero dropped frames. Posts to `fps_report`.
const SPLIT_SELFTEST_JS: &str = r#"(async function(){
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function report(o){ try{window.__TAURI_INTERNALS__.invoke('fps_report',{result:JSON.stringify(o)})}catch(e){} }
  var SEL='[data-split-divider],[data-panel-divider-row],[data-panel-divider-col]';
  try{
    // Wait for app-ready (same gate the FPS probe uses) before any invoke/drag.
    for(var rk=0;rk<40;rk++){ if(typeof window.__topicsToggleSidebar==='function')break; await sleep(500); }
    report({mode:'split-drag',phase:'ready'});
    var div=null, prevEl=null, nextEl=null;
    for(var k=0;k<20;k++){
      var cands=document.querySelectorAll(SEL);
      for(var c=0;c<cands.length;c++){
        var dd=cands[c], p=dd.previousElementSibling, n=dd.nextElementSibling;
        if(p&&n){ var gp=parseFloat(getComputedStyle(p).flexGrow)||0, gn=parseFloat(getComputedStyle(n).flexGrow)||0; if(gp>0&&gn>0){ div=dd; prevEl=p; nextEl=n; break; } }
      }
      if(div)break; await sleep(300);
    }
    var count=document.querySelectorAll(SEL).length;
    report({mode:'split-drag',phase:'searched',found:!!div,dividerCount:count,panes:document.querySelectorAll('[data-pane-id]').length});
    if(!div){ return; }
    // rAF-DRIVEN measurement: mutate the divider's flanking flex-grow ONCE PER FRAME
    // inside the rAF callback (NOT a setTimeout loop — WKWebView throttles timers in an
    // injected script after ~1s, which stalled the old harness). This is exactly the
    // per-frame work a real divider drag does (DOM-direct flex; React doesn't re-render),
    // wrapped in a genuine pane-resize-start/-end pair so terminals coalesce their fits.
    var g0p=parseFloat(getComputedStyle(prevEl).flexGrow)||1, g0n=parseFloat(getComputedStyle(nextEl).flexGrow)||1, comb=g0p+g0n;
    prevEl.style.transition='none'; nextEl.style.transition='none';
    window.dispatchEvent(new Event('topics:pane-resize-start'));
    // WARMUP frames absorb the one-time drag-init transient (pane-resize-start's
    // synchronous listener work + first reflow); only the SUSTAINED-drag frames after
    // it are measured — that's what "no frame drop DURING the operation" means. We also
    // report the warmup's own worst frame separately for full honesty.
    var WARMUP=24, N=130;
    var deltas=[], last=0, frame=0, warmMax=0;
    function finish(){
      prevEl.style.flex=g0p+' 1 0%'; nextEl.style.flex=g0n+' 1 0%';
      window.dispatchEvent(new Event('topics:pane-resize-end'));
      var d=deltas.filter(function(x){return x>0&&x<2000});
      var max=0,sum=0,b20=0,b33=0;
      for(var j=0;j<d.length;j++){ var x=d[j]; sum+=x; if(x>max)max=x; if(x>20)b20++; if(x>33)b33++; }
      report({mode:'split-drag',dividerCount:count,frames:d.length,avgFps:d.length?Math.round(1000/(sum/d.length)):0,maxFrameMs:Math.round(max),droppedGt20ms:b20,droppedGt33ms:b33,warmupMaxMs:Math.round(warmMax),xterms:document.querySelectorAll('.xterm').length,panes:document.querySelectorAll('[data-pane-id]').length});
    }
    function step(t){
      frame++;
      if(last){ var dt=t-last; if(frame<=WARMUP){ if(dt>warmMax)warmMax=dt; } else { deltas.push(dt); } }
      last=t;
      var frac=0.5+0.40*Math.sin(frame/N*Math.PI*6); // oscillate the split ratio
      prevEl.style.flex=(comb*frac)+' 1 0%'; nextEl.style.flex=(comb*(1-frac))+' 1 0%';
      if(frame<WARMUP+N) requestAnimationFrame(step); else finish();
    }
    requestAnimationFrame(step);
  }catch(e){ report({mode:'split-drag',error:String(e&&e.stack||e)}); }
})();"#;

/// Env-gated polish-bug verifier (`TOPICS_BUGFIX_VERIFY`). DOM-observable checks for
/// two of the three reported Tauri bugs (the native-pane lag is OS-side, verified by
/// screen capture, not here): (1) the status/FPS dropdown must dismiss when the
/// overlay sidebar collapses — it's portaled to <body>, so it used to float on over
/// the content; (2) WebKit must render a VISIBLE scrollbar colour at rest (the global
/// `scrollbar-color: transparent transparent` hid them until hover on the Tauri build).
/// Posts a findings object to the same `fps_report` sink.
const BUGFIX_VERIFY_JS: &str = r#"(async function(){
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function report(o){ try{window.__TAURI_INTERNALS__.invoke('fps_report',{result:JSON.stringify(o)})}catch(e){} }
  var toggle=null;
  for(var k=0;k<40;k++){ toggle=window.__topicsToggleSidebar; if(typeof toggle==='function')break; await sleep(500); }
  if(typeof toggle!=='function'){ report({error:'no toggle after 20s'}); return; }
  await sleep(600);
  var out={};
  // ---- bug3: scrollbar visibility (WebKit honours scrollbar-color on *) ----
  out.htmlClass=document.documentElement.className;
  out.bodyScrollbarColor=getComputedStyle(document.body).scrollbarColor;
  var sc=null, all=document.querySelectorAll('*');
  for(var i=0;i<all.length;i++){ var e=all[i]; if(e.scrollHeight>e.clientHeight+4){ var ov=getComputedStyle(e).overflowY; if(ov==='auto'||ov==='scroll'){ sc=e; break; } } }
  out.scrollEl = sc ? String(sc.className||sc.tagName).slice(0,60) : null;
  out.scrollElColor = sc ? getComputedStyle(sc).scrollbarColor : null;
  // ---- ensure sidebar expanded ----
  function sb(){return document.querySelector('[aria-label="Topics sidebar"]');}
  function collapsed(){ var s=sb(); if(!s)return true; var r=s.getBoundingClientRect(); return r.width<10 || r.right<10; }
  if(collapsed()){ toggle(); await sleep(450); }
  out.sidebarExpanded=!collapsed();
  // ---- bug1: open the status dropdown, collapse the sidebar, expect it dismissed ----
  var btn=document.querySelector('button[title^="Performance"]');
  out.foundStatusBtn=!!btn;
  function dropdown(){ return Array.prototype.find.call(document.querySelectorAll('.glass-surface'), function(e){return e.style && e.style.zIndex==='9999';}); }
  if(btn){
    btn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    btn.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await sleep(400);
    out.dropdownOpened=!!dropdown();
    toggle(); // collapse
    await sleep(500);
    out.dropdownAfterCollapse=!!dropdown();
    out.dropdownClosedOnCollapse = !!(out.dropdownOpened && !out.dropdownAfterCollapse);
    if(collapsed()){ toggle(); await sleep(450); } // restore for visual capture
  }
  report(out);
})();"#;

/// Env-gated SLOW-MOTION sidebar slide (`TOPICS_SLIDE_DEMO`). Stretches the sidebar
/// translateX and the #main-content padding push to 1.4s and oscillates the toggle, so
/// a screenshot burst can confirm a native browser pane's left edge stays glued to the
/// sidebar's right edge throughout the slide (the per-frame rAF reposition in
/// NativeBrowserPlaceholder) instead of trailing it. Needs a browser pane in the layout.
const SLIDE_DEMO_JS: &str = r#"(async function(){
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function report(o){ try{window.__TAURI_INTERNALS__.invoke('fps_report',{result:JSON.stringify(o)})}catch(e){} }
  var toggle=null;
  for(var k=0;k<40;k++){ toggle=window.__topicsToggleSidebar; if(typeof toggle==='function')break; await sleep(500); }
  if(typeof toggle!=='function'){ report({slide:'no toggle'}); return; }
  // Reveal a native browser pane (its placeholder is on-screen) — click through the open
  // tabs until one mounts a visible native webview. That's the OS view we're confirming.
  function nativeVisible(){ var p=document.querySelector('[data-testid="browser-native-placeholder"]'); if(!p)return null; var r=p.getBoundingClientRect(); return (p.offsetParent!==null&&r.width>80&&r.height>80)?r:null; }
  if(!nativeVisible()){
    var tabs=document.querySelectorAll('[data-testid^="pane-tab-"]');
    for(var ti=0; ti<tabs.length; ti++){
      tabs[ti].dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));
      tabs[ti].dispatchEvent(new MouseEvent('click',{bubbles:true}));
      await sleep(800);
      if(nativeVisible()) break;
    }
  }
  var rr=nativeVisible();
  report({slide:'ready',browserVisible:!!rr,rect:rr?{x:Math.round(rr.x),y:Math.round(rr.y),w:Math.round(rr.width),h:Math.round(rr.height)}:null,tabs:document.querySelectorAll('[data-testid^="pane-tab-"]').length});
  var st=document.createElement('style');
  st.textContent='.sidebar-transition{transition:width 1400ms ease,transform 1400ms ease,opacity 300ms ease!important}'+
                 '#main-content{transition:padding-left 1400ms ease!important}';
  document.head.appendChild(st);
  await sleep(500);
  for(var i=0;i<6;i++){ try{toggle()}catch(e){} await sleep(2300); }
})();"#;

/// Diagnostic sink for the FPS self-test: the injected probe posts its frame-timing
/// summary here and we persist it to a fixed path the driver reads. Inert unless the
/// self-test runs.
#[tauri::command]
fn fps_report(result: String) -> Result<(), String> {
    let path = std::path::PathBuf::from("/tmp/topics-fps-selftest.json");
    std::fs::write(&path, &result).map_err(|e| e.to_string())?;
    eprintln!("[fps-selftest] {result}");
    Ok(())
}

/// Diagnostic: read the MAIN window's current AppKit first-responder by IDENTITY.
/// Both the React chrome and every browser pane are `WryWebView` instances, so the
/// CLASS NAME cannot tell them apart — we return raw pointers so a caller can compare
/// `responder` against `mainView` (and against a browser view's pointer from
/// `focus_grab_browser`). This is how the tab-focus fix is verified WITHOUT any OS
/// accessibility / synthetic-input permission. macOS only.
#[tauri::command]
fn focus_read(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Err("macos only".into());
    }
    #[cfg(target_os = "macos")]
    {
    use tauri::Manager;
    let main_wv = app.get_webview("main").ok_or("no main webview")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    main_wv
        .with_webview(move |platform| unsafe {
            use cocoa::base::{id, nil};
            use objc::{msg_send, sel, sel_impl};
            let view = platform.inner() as id;
            let mut out = String::from("{\"error\":\"nil view\"}");
            if view != nil {
                let ns_window: id = msg_send![view, window];
                let fr: id = if ns_window != nil {
                    msg_send![ns_window, firstResponder]
                } else {
                    nil
                };
                let cls = if fr != nil {
                    (*fr).class().name().to_string()
                } else {
                    String::from("nil")
                };
                out = format!(
                    "{{\"responder\":\"{:p}\",\"mainView\":\"{:p}\",\"class\":\"{}\"}}",
                    fr, view, cls
                );
            }
            let _ = tx.send(out);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())
    }
}

/// Diagnostic counterpart to `focus_read`: FORCE AppKit first-responder onto a browser
/// pane's WKWebView (simulating the "stuck in the page" state the tab-click fix must
/// recover from) and return that view's pointer so the caller can assert it. macOS only.
#[tauri::command]
fn focus_grab_browser(app: tauri::AppHandle, id: String) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id);
        return Err("macos only".into());
    }
    #[cfg(target_os = "macos")]
    {
    use tauri::Manager;
    let wv = app
        .get_webview(&browser_label(&id))
        .ok_or("no such browser pane")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    wv.with_webview(move |platform| unsafe {
        use cocoa::base::{id, nil};
        use objc::{msg_send, sel, sel_impl};
        let view = platform.inner() as id;
        let mut out = String::from("nil");
        if view != nil {
            let ns_window: id = msg_send![view, window];
            if ns_window != nil {
                let _: () = msg_send![ns_window, makeFirstResponder: view];
            }
            out = format!("{:p}", view);
        }
        let _ = tx.send(out);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())
    }
}

/// Diagnostic: move AppKit first-responder OFF the main webview onto the NSWindow
/// itself (via `makeFirstResponder:nil`). A no-browser-pane fallback for the focus
/// self-test — `browser_release_focus` must reclaim first-responder to the main
/// webview regardless of WHAT held it, so a non-main holder is enough to prove the
/// reclaim. Returns the new first-responder pointer. macOS only.
#[tauri::command]
fn focus_grab_window(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Err("macos only".into());
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let main_wv = app.get_webview("main").ok_or("no main webview")?;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        main_wv
            .with_webview(move |platform| unsafe {
                use cocoa::base::{id, nil, BOOL};
                use objc::{msg_send, sel, sel_impl};
                let view = platform.inner() as id;
                let mut out = String::from("nil");
                if view != nil {
                    let ns_window: id = msg_send![view, window];
                    if ns_window != nil {
                        let _ok: BOOL = msg_send![ns_window, makeFirstResponder: nil];
                        let fr: id = msg_send![ns_window, firstResponder];
                        out = format!("{:p}", fr);
                    }
                }
                let _ = tx.send(out);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|e| e.to_string())
    }
}

/// Injected probe for the env-gated tab-focus self-test (`TOPICS_FOCUS_SELFTEST=1`).
/// Discovers a live browser pane from the DOM, then drives the AppKit round-trip:
/// grab first-responder to the pane → read (expect responder == browser view) →
/// `browser_release_focus` → read (expect responder == main view). Posts a verdict to
/// `focus_report`. Proves the tab strip's focus-reclaim works at the AppKit level with
/// zero OS input synthesis.
const FOCUS_SELFTEST_JS: &str = r#"(async function(){
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function inv(c,a){return window.__TAURI_INTERNALS__.invoke(c,a||{})}
  function report(o){ try{inv('focus_report',{result:JSON.stringify(o)})}catch(e){} }
  // Prefer a real, NATIVELY-MOUNTED browser pane; else fall back to grabbing the
  // window itself. Either way `browser_release_focus` must win first-responder back.
  var grabbedTo=null, mode='window', paneId=null;
  for(var k=0;k<20;k++){
    var el=document.querySelector('[data-pane-id^="browser:"]');
    if(el){
      var pid=el.getAttribute('data-pane-id').slice('browser:'.length);
      try{ var bv=await inv('focus_grab_browser',{id:pid}); if(bv&&bv!=='nil'){ grabbedTo=bv; mode='browser'; paneId=pid; break; } }catch(e){}
    }
    await sleep(400);
  }
  try{
    if(!grabbedTo){ grabbedTo=await inv('focus_grab_window'); mode='window'; }
    await sleep(120);
    var afterGrab=JSON.parse(await inv('focus_read'));
    await inv('browser_release_focus');
    await sleep(120);
    var afterRelease=JSON.parse(await inv('focus_read'));
    var grabbedAway=(afterGrab.responder!==afterGrab.mainView);
    var grabIdentity=(mode!=='browser')||(afterGrab.responder===grabbedTo);
    var releasedToMain=(afterRelease.responder===afterRelease.mainView);
    report({mode:mode,pane:paneId,grabbedTo:grabbedTo,afterGrab:afterGrab,afterRelease:afterRelease,
            grabbedAway:grabbedAway,grabIdentity:grabIdentity,releasedToMain:releasedToMain,
            pass:(grabbedAway&&grabIdentity&&releasedToMain)});
  }catch(e){ report({error:String(e)}); }
})();"#;

/// Diagnostic sink for the tab-focus self-test (mirror of `fps_report`).
#[tauri::command]
fn focus_report(result: String) -> Result<(), String> {
    let path = std::path::PathBuf::from("/tmp/topics-focus-selftest.json");
    std::fs::write(&path, &result).map_err(|e| e.to_string())?;
    eprintln!("[focus-selftest] {result}");
    Ok(())
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
fn win_size_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("topics-win-size.json"))
}

/// Write `{ "w": <logical>, "h": <logical> }`. Ignores bogus/minimized sizes.
fn save_win_size_logical(path: &std::path::Path, w: f64, h: f64) {
    if !(w >= 200.0 && h >= 200.0 && w.is_finite() && h.is_finite()) {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, format!("{{\"w\":{:.0},\"h\":{:.0}}}", w, h));
}

/// Read back the saved logical size, validated.
fn read_win_size_logical(path: &std::path::Path) -> Option<(f64, f64)> {
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

/// Override the pane's User-Agent (device emulation). WKWebView
/// `setCustomUserAgent:` — empty string resets to the default. Takes effect on
/// the next load, so the client reloads after setting it. macOS only.
#[tauri::command]
fn browser_set_user_agent(app: tauri::AppHandle, id: String, ua: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
    #[cfg(target_os = "macos")]
    {
        let _ = wv.with_webview(move |platform| unsafe {
            use cocoa::base::{id as objid, nil};
            use cocoa::foundation::NSString;
            use objc::{msg_send, sel, sel_impl};
            let wk = platform.inner() as objid;
            if ua.is_empty() {
                let _: () = msg_send![wk, setCustomUserAgent: nil];
            } else {
                let s: objid = NSString::alloc(nil).init_str(&ua);
                let _: () = msg_send![wk, setCustomUserAgent: s];
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (wv, ua);
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
        // NOTE: tauri-plugin-window-state was REMOVED — it mis-handled scale on this
        // mixed-DPI multi-monitor setup (persisted physical pixels as logical, failed to
        // restore, and ratcheted the window smaller via clamped-position saves). Window
        // SIZE is now persisted ourselves in logical units (see win_size_file + the setup
        // restore/save wiring); position stays centered (`center: true` in tauri.conf.json).
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

            // Env-gated sidebar FPS self-test: drive real collapse/expands and sample
            // rAF frame timing, writing the summary to /tmp/topics-fps-selftest.json.
            // OFF unless TOPICS_FPS_SELFTEST is set; works in release (not cfg(debug)).
            if std::env::var("TOPICS_FPS_SELFTEST").is_ok() {
                eprintln!("[fps-selftest] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(7));
                    let h = handle.clone();
                    // The window registry is only reliably reachable on the main thread,
                    // and this multi-webview app exposes the UI as get_webview("main")
                    // (not a unified WebviewWindow — see browser_release_focus).
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(wv) = h.get_webview("main") {
                            eprintln!("[fps-selftest] injecting via get_webview(main)");
                            match wv.eval(FPS_SELFTEST_JS) {
                                Ok(()) => eprintln!("[fps-selftest] eval ok"),
                                Err(e) => eprintln!("[fps-selftest] eval err: {e}"),
                            }
                        } else if let Some(win) = h.get_webview_window("main") {
                            eprintln!("[fps-selftest] injecting via get_webview_window(main)");
                            let _ = win.eval(FPS_SELFTEST_JS);
                        } else {
                            eprintln!("[fps-selftest] no main webview/window");
                        }
                    });
                });
            }

            // Env-gated polish-bug verifier: drives the dropdown/sidebar and dumps
            // DOM findings to /tmp/topics-fps-selftest.json. OFF unless set.
            if std::env::var("TOPICS_BUGFIX_VERIFY").is_ok() {
                eprintln!("[bugfix-verify] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(wv) = h.get_webview("main") {
                            eprintln!("[bugfix-verify] injecting via get_webview(main)");
                            match wv.eval(BUGFIX_VERIFY_JS) {
                                Ok(()) => eprintln!("[bugfix-verify] eval ok"),
                                Err(e) => eprintln!("[bugfix-verify] eval err: {e}"),
                            }
                        } else if let Some(win) = h.get_webview_window("main") {
                            let _ = win.eval(BUGFIX_VERIFY_JS);
                        } else {
                            eprintln!("[bugfix-verify] no main webview/window");
                        }
                    });
                });
            }

            // Env-gated SLOW-MOTION sidebar slide: stretch the slide so a capture burst
            // can confirm the native browser pane tracks the sidebar edge. OFF unless set.
            if std::env::var("TOPICS_SLIDE_DEMO").is_ok() {
                eprintln!("[slide-demo] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(wv) = h.get_webview("main") {
                            eprintln!("[slide-demo] injecting via get_webview(main)");
                            let _ = wv.eval(SLIDE_DEMO_JS);
                        }
                    });
                });
            }

            // Env-gated SPLIT-resize FPS self-test: drive a divider drag and sample rAF.
            if std::env::var("TOPICS_SPLIT_SELFTEST").is_ok() {
                eprintln!("[split-selftest] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(wv) = h.get_webview("main") {
                            eprintln!("[split-selftest] injecting via get_webview(main)");
                            match wv.eval(SPLIT_SELFTEST_JS) {
                                Ok(()) => eprintln!("[split-selftest] eval ok"),
                                Err(e) => eprintln!("[split-selftest] eval err: {e}"),
                            }
                        } else {
                            eprintln!("[split-selftest] no main webview");
                        }
                    });
                });
            }

            // Delayed window-size probe: the window-state plugin may apply the RESTORED
            // geometry slightly AFTER this setup closure runs, so the immediate read above
            // can report the config default. Re-read on the main thread after 5s for the
            // TRUE post-restore size. Diagnostic-only (stderr).
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        // get_webview_window("main") can be None in this multi-webview app;
                        // iterate webview_windows() (proven reliable) and match the label.
                        for (label, win) in h.webview_windows() {
                            if label != "main" { continue; }
                            if let (Ok(os), Ok(pos), Ok(sf)) =
                                (win.outer_size(), win.outer_position(), win.scale_factor())
                            {
                                eprintln!(
                                    "[window-restore+5s] outer={}x{} pos={},{} scale={} logical={}x{}",
                                    os.width, os.height, pos.x, pos.y, sf,
                                    (os.width as f64 / sf).round(),
                                    (os.height as f64 / sf).round()
                                );
                            }
                        }
                    });
                });
            }

            // Env-gated tab-focus self-test: drive the AppKit first-responder round-trip
            // (grab to a browser pane → release → assert it returned to the main webview),
            // writing the verdict to /tmp/topics-focus-selftest.json. OFF unless
            // TOPICS_FOCUS_SELFTEST is set. Needs a browser pane in the restored layout.
            if std::env::var("TOPICS_FOCUS_SELFTEST").is_ok() {
                eprintln!("[focus-selftest] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(wv) = h.get_webview("main") {
                            eprintln!("[focus-selftest] injecting via get_webview(main)");
                            match wv.eval(FOCUS_SELFTEST_JS) {
                                Ok(()) => eprintln!("[focus-selftest] eval ok"),
                                Err(e) => eprintln!("[focus-selftest] eval err: {e}"),
                            }
                        } else {
                            eprintln!("[focus-selftest] no main webview");
                        }
                    });
                });
            }

            // Env-gated browser-corner visual demo: open a native browser pane in the
            // BOTTOM-RIGHT quadrant (flush right+bottom, NOT left/top) so a screenshot can
            // confirm only the bottom-right corner is rounded to the window radius while the
            // pane's inner (top-left) corner stays square. OFF unless TOPICS_CORNER_DEMO set.
            #[cfg(target_os = "macos")]
            if std::env::var("TOPICS_CORNER_DEMO").is_ok() {
                eprintln!("[corner-demo] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        // Park the window on the PRIMARY display (global 30,80 — fits a
                        // 1656-wide window inside the 1728pt-wide main display, so the
                        // bottom-right corner is on-screen) for a reliable screenshot.
                        {
                            use tauri::Manager;
                            if let Some(win) = h.get_window("main") {
                                let _ = win.set_position(tauri::LogicalPosition::new(30.0, 80.0));
                            }
                        }
                        if let Some((ww, wh)) = main_window_logical_size(&h) {
                            let x = (ww / 2.0).round();
                            let y = (wh / 2.0).round();
                            let w = (ww - x).round();
                            let ht = (wh - y).round();
                            eprintln!("[corner-demo] open at {x},{y} {w}x{ht} (win {ww}x{wh})");
                            match browser_open(
                                h.clone(),
                                "cornerdemo".into(),
                                "https://example.com".into(),
                                x,
                                y,
                                w,
                                ht,
                            ) {
                                Ok(()) => eprintln!("[corner-demo] opened ok"),
                                Err(e) => eprintln!("[corner-demo] open err: {e}"),
                            }
                        } else {
                            eprintln!("[corner-demo] no window size");
                        }
                    });
                });
            }

            // Env-gated sidebar-reclaim visual demo: park on the primary display, then
            // toggle the sidebar so a screenshot pair (before/after) shows the content
            // reclaiming the freed strip. OFF unless TOPICS_SIDEBAR_DEMO set.
            #[cfg(target_os = "macos")]
            if std::env::var("TOPICS_SIDEBAR_DEMO").is_ok() {
                eprintln!("[sidebar-demo] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(win) = h.get_window("main") {
                            let _ = win.set_position(tauri::LogicalPosition::new(30.0, 80.0));
                        }
                    });
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let h2 = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(wv) = h2.get_webview("main") {
                            let _ = wv.eval("window.__topicsToggleSidebar&&window.__topicsToggleSidebar()");
                            eprintln!("[sidebar-demo] toggled");
                        }
                    });
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
                    // NOTE: masking the content view (round_window_content_corners) to
                    // round browser-pane corners BROKE main-window auto-resize + sidebar
                    // spacing (masksToBounds/wantsLayer on the content view disturbs the
                    // transparent-titlebar layout + the vibrancy resize cover). Reverted;
                    // round the child browser webview's own layer instead if needed.
                    // Live window-edge resize: AppKit posts WillStart/DidEnd live-resize
                    // notifications SYNCHRONOUSLY (unlike tao's WindowEvent::Resized, which
                    // is only drained at gesture end), so we swap to an autoresizing frost
                    // cover for the duration of the drag.
                    wire_live_resize_cover(&win);
                    // RESTORE the saved LOGICAL size ourselves (see win_size_file): the
                    // tauri-plugin-window-state plugin mis-handled scale on this mixed-DPI
                    // multi-monitor setup — it saved PHYSICAL pixels as logical (a 2x display
                    // wrote 2800x1800) and failed to restore 1656x896. We store size only, in
                    // logical units, and re-apply it here. Position stays centered.
                    if _label == "main" {
                        if let Some((lw, lh)) = win_size_file(app.handle()).and_then(|p| read_win_size_logical(&p)) {
                            let _ = win.set_size(tauri::LogicalSize::new(lw, lh));
                            // set_size grows from the top-left, so re-center to keep the
                            // restored-size window centered on its display.
                            let _ = win.center();
                            eprintln!("[window-restore] applied logical {lw}x{lh}");
                        }
                        if let (Ok(os), Ok(sf)) = (win.outer_size(), win.scale_factor()) {
                            eprintln!(
                                "[window-restore] main now outer={}x{} scale={} logical={}x{}",
                                os.width, os.height, sf,
                                (os.width as f64 / sf).round(),
                                (os.height as f64 / sf).round()
                            );
                        }
                    }
                    // Re-assert the desired visibility whenever AppKit might have
                    // reset it (focus gained/lost, resize) — otherwise the buttons
                    // reappear on the first focus of a transparent-titlebar window.
                    let w = win.clone();
                    // Persist window SIZE on resize (throttled) so a SIGTERM, crash, or the
                    // dev relaunch loop NEVER loses it (the plugin only saved on graceful quit,
                    // and CloseRequested hides to tray, so a plain kill saved nothing). Self-
                    // managed in LOGICAL units — see win_size_file for why we don't use the plugin.
                    let save_gate = std::sync::Arc::new(std::sync::Mutex::new(
                        std::time::Instant::now() - std::time::Duration::from_secs(2),
                    ));
                    let size_file = win_size_file(app.handle());
                    let save_state_throttled = move |w: &tauri::WebviewWindow| {
                        let mut g = match save_gate.lock() { Ok(g) => g, Err(_) => return };
                        if g.elapsed() >= std::time::Duration::from_millis(500) {
                            *g = std::time::Instant::now();
                            if let (Some(p), Ok(os), Ok(sf)) =
                                (size_file.as_ref(), w.outer_size(), w.scale_factor())
                            {
                                save_win_size_logical(p, os.width as f64 / sf, os.height as f64 / sf);
                            }
                        }
                    };
                    win.on_window_event(move |event| match event {
                        tauri::WindowEvent::Resized(_) => {
                            // PROGRAMMATIC resize path (set_size / zoom): these deliver
                            // Resized promptly and post NO live-resize notification, so the
                            // cover is sized here. (Interactive drags are handled by the
                            // notification + autoresizing mask above.)
                            vibrancy_resize_cover(&w);
                            save_state_throttled(&w);
                            // Same titlebar re-pin as a focus change.
                            let visible = TRAFFIC_LIGHTS_VISIBLE.load(Ordering::Relaxed)
                                || w.is_fullscreen().unwrap_or(false);
                            apply_traffic_lights(&w, visible);
                        }
                        tauri::WindowEvent::Moved(_) => {
                            save_state_throttled(&w);
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
            browser_screenshot,
            browser_exec_js,
            browser_back,
            browser_forward,
            browser_reload,
            browser_set_user_agent,
            browser_toggle_devtools,
            browser_release_focus,
            fps_report,
            focus_read,
            focus_grab_browser,
            focus_grab_window,
            focus_report,
            browser_take_download_events,
            updater_check,
            updater_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(all(test, target_os = "macos"))]
mod screenshot_tests {
    use super::nsimage_to_png_base64;
    use cocoa::base::{id, nil, NO, YES};
    use cocoa::foundation::{NSSize, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    // Headless proof of the novel conversion chain (no webview / app / run-loop):
    // a synthetic 4x4 RGBA NSImage → nsimage_to_png_base64 → a string whose bytes
    // are a real PNG. PNG magic (\x89PNG\r\n\x1a\n) base64-encodes to a fixed
    // "iVBORw0KGgo" prefix, so a prefix check needs no base64 decoder.
    #[test]
    fn nsimage_converts_to_valid_png_base64() {
        unsafe {
            let cs = NSString::alloc(nil).init_str("NSDeviceRGBColorSpace");
            let rep: id = msg_send![class!(NSBitmapImageRep), alloc];
            let rep: id = msg_send![rep,
                initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>()
                pixelsWide: 4i64
                pixelsHigh: 4i64
                bitsPerSample: 8i64
                samplesPerPixel: 4i64
                hasAlpha: YES
                isPlanar: NO
                colorSpaceName: cs
                bytesPerRow: 0i64
                bitsPerPixel: 0i64];
            assert!(rep != nil, "failed to create NSBitmapImageRep");

            let img: id = msg_send![class!(NSImage), alloc];
            let img: id = msg_send![img, initWithSize: NSSize::new(4.0, 4.0)];
            let _: () = msg_send![img, addRepresentation: rep];

            let out = nsimage_to_png_base64(img).expect("conversion failed");
            assert!(
                out.starts_with("iVBORw0KGgo"),
                "not a PNG; got prefix {:?}",
                &out[..out.len().min(16)]
            );
            assert!(out.len() > 32, "PNG base64 implausibly short: {}", out.len());
        }
    }
}
