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
use std::sync::atomic::{AtomicBool, Ordering};

/// Desired traffic-light visibility (hidden by default; the client flips it when
/// the Topics menu opens). AppKit re-shows the buttons on focus/resize when the
/// titlebar is transparent (`Overlay`), so we re-assert this state on those
/// window events — mirroring the Electron shell's re-pin pattern.
static TRAFFIC_LIGHTS_VISIBLE: AtomicBool = AtomicBool::new(false);

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
fn set_traffic_lights(window: tauri::WebviewWindow, visible: bool) {
    TRAFFIC_LIGHTS_VISIBLE.store(visible, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    apply_traffic_lights(&window, visible);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
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
fn set_theme(window: tauri::WebviewWindow, theme: String) {
    #[cfg(target_os = "macos")]
    {
        let dark = theme == "dark";
        let win = window.clone();
        let _ = window.run_on_main_thread(move || apply_appearance(&win, dark));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, theme);
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
fn apply_vibrancy_regions(window: &tauri::WebviewWindow, regions: Vec<VibRegion>) {
    use cocoa::base::{id, nil, YES};
    use cocoa::foundation::{NSPoint, NSRect, NSSize};
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
        let bounds: NSRect = msg_send![content_view, bounds];
        let content_h = bounds.size.height;

        let mut map = vibrancy_views().lock().unwrap();
        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();

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
    }
}

/// Client-driven: set the full list of vibrancy regions (cards/sidebar) in
/// window coords. Empty list clears all (e.g. leaving floating mode → fall back
/// to no per-region vibrancy). No-op off macOS.
#[tauri::command]
fn vibrancy_set_regions(window: tauri::WebviewWindow, regions: Vec<VibRegion>) {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || apply_vibrancy_regions(&win, regions));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, regions);
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
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed)),
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
        // Native menu — a WKWebView shell with NO app menu also has no working
        // Cmd+C/V/X/A/Z and no Reload. Build the standard macOS menus plus an
        // explicit View ▸ Reload (Cmd+R / Cmd+Shift+R), matching the Electron app.
        .menu(|handle| {
            use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
            let reload = MenuItem::with_id(handle, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let force_reload =
                MenuItem::with_id(handle, "force-reload", "Force Reload", true, Some("CmdOrCtrl+Shift+R"))?;
            let app_menu = SubmenuBuilder::new(handle, "Topics")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
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
            MenuBuilder::new(handle)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                .build()
        })
        .on_menu_event(|app, event| {
            use tauri::Manager;
            if matches!(event.id().0.as_str(), "reload" | "force-reload") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.eval("window.location.reload()");
                }
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
                    // Re-assert the desired visibility whenever AppKit might have
                    // reset it (focus gained/lost, resize) — otherwise the buttons
                    // reappear on the first focus of a transparent-titlebar window.
                    let w = win.clone();
                    win.on_window_event(move |event| match event {
                        tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_) => {
                            // In fullscreen the titlebar is gone, so FORCE the
                            // traffic lights visible — otherwise (hidden-by-default
                            // + hidden green button) the only way out is the View ▸
                            // Full Screen accelerator, which is a trap for anyone
                            // who doesn't know it. Otherwise honor the menu state.
                            let visible = TRAFFIC_LIGHTS_VISIBLE.load(Ordering::Relaxed)
                                || w.is_fullscreen().unwrap_or(false);
                            apply_traffic_lights(&w, visible);
                        }
                        _ => {}
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            perf_metrics,
            set_traffic_lights,
            set_theme,
            vibrancy_set_regions,
            browser_open,
            browser_navigate,
            browser_set_bounds,
            browser_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
