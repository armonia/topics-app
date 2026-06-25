// Topics — low-footprint desktop shell (Tauri).
//
// PORTING-PLAN.md Tier 1. This replaces the Electron main process. The React UI
// is loaded from the live server origin (http://localhost:3333) exactly like the
// Electron shell did; native capabilities the web app needs (perf metrics, and —
// later — pty terminals + the CEF browser pane) are exposed as Tauri commands and
// reached from the client via client/src/lib/shell. Window lifecycle, theme,
// open-external and relaunch are covered by the official plugins below, whose JS
// APIs the shell bridge calls directly.

use serde::Serialize;
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
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
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
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
                            apply_traffic_lights(&w, TRAFFIC_LIGHTS_VISIBLE.load(Ordering::Relaxed));
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
            browser_open,
            browser_navigate,
            browser_set_bounds,
            browser_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
