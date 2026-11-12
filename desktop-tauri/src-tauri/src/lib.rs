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

/// The app-chord forwarding allowlist, GENERATED from the shared shortcut
/// registry (`shared/shortcuts.ts`) by `scripts/gen-shortcuts.ts`. Both native
/// forwarders consult it (`app_chord_dispatch_js` here, `chords::decide` for
/// WebView2), so no native list can silently drift from the window the user
/// sees. Regenerate with `bun run gen:shortcuts`.
mod shortcuts_generated;

/// Which app chord a focused browser pane must not keep, and what to do with it:
/// the Windows counterpart of the NSEvent monitor further down. The decision is
/// a table compiled on EVERY platform, so `cargo test --lib` proves it on a Mac;
/// `chords_win` is the WebView2 plumbing that feeds it, and is the only caller
/// outside the tests.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod chords;
mod tray_machines;
mod tray_quota;
#[cfg(target_os = "windows")]
mod chords_win;

/// I tre backend del pane browser nativo. `browser_eval` e la parte che NON
/// dipende dal motore (attesa delle promise, forma del risultato) e si compila
/// ovunque perche e l'unica testabile qui; gli altri due sono le chiamate vere a
/// WebView2 e WebKitGTK, che il Mac non guarda mai. Il ramo macOS e ancora
/// inline piu sotto, insieme al resto dell'FFI AppKit.
mod browser_eval;
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
mod browser_linux;
#[cfg(target_os = "windows")]
mod browser_win;
mod window_recompose;
mod window_focus;
// Per-pane process usage and suspend on WebView2. Compiled everywhere so its
// pure delta rules are tested on the three CI runners; the WebView2 half is
// `cfg(windows)` inside.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod pane_process_win;
#[cfg(target_os = "windows")]
mod windows_repaint;

/// The boot rule and the page that explains its degraded verdict. Both are pure
/// and compiled on EVERY platform (no `#[cfg]` body), so a `cargo check` on any
/// OS still catches a break in the one code path only Windows can reproduce.
mod boot_choice;
mod upstream_search;
mod daemon_record;
mod boot_degraded;
mod reconnect_page;
mod browser_panes;
mod shortcuts_menu;
mod sidecar_boot;
mod window_chrome;
mod os_integration;
mod perf_metrics;
use os_integration::*;
use perf_metrics::*;
use browser_panes::*;
use shortcuts_menu::*;
use sidecar_boot::*;
use window_chrome::*;
use upstream_search::{
    discover_upstream, ALONE_BEFORE_CONCEDING, ROUND_PAUSE, SEARCH_WITHOUT_MARKER,
    SEARCH_WITH_MARKER,
};
use boot_choice::{
    decide_boot, BootChoice, Loopback, PortAnswer, ShapeVerdict,
};
use daemon_record::{daemon_pid_is_alive, daemon_state_port};
use reconnect_page::{reconnect_page_response, set_degraded_marker};

/// The DWM backdrop behind the app window on Windows 11. Compiled on EVERY
/// platform and called only from Windows, on purpose: the file next door carries
/// the scar of a Windows-only line inside a macOS-only block, which "compiled
/// nowhere, and no `cargo check` could say so". Every entry point in there is a
/// no-op off Windows, so the call sites below stay unguarded and type-checked on
/// a Mac. `allow(dead_code)` for the same reason as `mod chords`: off Windows the
/// bodies are unreachable, and being unreachable is what makes them checkable.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod windows_acrylic;

/// The menu accelerators on Windows, where nothing translates the accelerator
/// table `muda` builds. `menu_chords` is the table (chord in, menu id out) and
/// compiles everywhere so it can be TESTED here; `menu_chords_win` is the
/// WebView2 plumbing that feeds it, and only Windows ever sees it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod menu_chords;
#[cfg(target_os = "windows")]
mod menu_chords_win;

/// I path che l'OS consegna quando qualcuno fa «Apri con Topics»: raccolta da
/// argv / seconda istanza / Finder, coda per chi arriva prima della webview,
/// e il comando con cui la UI li ritira. Il trasporto sta lì, la decisione su
/// cosa aprire sta in `shared/os-open-path.ts`.
mod os_open;

/// Is the app beside the binaries it was built with? An installer that cannot
/// overwrite a RUNNING sidecar skips it and still reports success, so "app.exe
/// says 2.2.176" is not the same as "this install is 2.2.176". The build records
/// what it shipped, the shell checks what landed.
mod sidecar_fingerprint;
mod sidecar_integrity;

/// objc2 compatibility shims for the AppKit FFI throughout this file.
///
/// Migrated off the deprecated `objc` + `cocoa` crates (759 of the shell's 761
/// build warnings had that single root — both the `use of deprecated …` notes
/// and the `unexpected cfg condition value: cargo-clippy` ones the old
/// `msg_send!`/`sel!` macros expanded into our source). The selectors and the
/// message sends are unchanged; only the crate providing the untyped-pointer
/// types and the runtime macros moved to `objc2`. Each AppKit block below does
/// `use crate::mac::*;` — a glob so unused items in a given block don't warn.
#[cfg(target_os = "macos")]
mod mac {
    pub use objc2::runtime::{AnyClass as Class, AnyObject as Object, Sel};
    pub use objc2::{class, msg_send, sel};
    pub use objc2_foundation::{NSPoint, NSRect, NSSize};

    /// The old `cocoa::base::id`: an untyped Objective-C object pointer. Kept
    /// lower-case to match the hundreds of `let x: id = …` sites verbatim.
    #[allow(non_camel_case_types)]
    pub type id = *mut objc2::runtime::AnyObject;

    /// The old `cocoa::base::nil`. Kept lower-case to match the thousands of
    /// `!= nil` / `== nil` sites verbatim; the naming lint is opted out here
    /// only, not project-wide.
    #[allow(non_upper_case_globals)]
    pub const nil: id = std::ptr::null_mut();

    /// The old `cocoa::base::{BOOL, YES, NO}`. objc2's `msg_send!` bridges the
    /// Objective-C `BOOL` to/from Rust `bool` automatically, so aliasing these
    /// to `bool`/`true`/`false` lets every legacy `let x: BOOL = …`, `!= NO` and
    /// `setFoo: YES` site keep compiling untouched.
    pub type BOOL = bool;
    #[allow(non_upper_case_globals)]
    pub const YES: bool = true;
    #[allow(non_upper_case_globals)]
    pub const NO: bool = false;

    /// NSWindowButton raw values (NSWindow.h). Hard-coded rather than pulling in
    /// objc2-app-kit for three constants — they are ABI-stable.
    pub const NS_WINDOW_CLOSE_BUTTON: isize = 0;
    pub const NS_WINDOW_MINIATURIZE_BUTTON: isize = 1;
    pub const NS_WINDOW_ZOOM_BUTTON: isize = 2;

    /// Build an autoreleased-free NSString*. Keep the returned `Retained` alive
    /// for as long as the raw pointer is in use, then read `.as_ptr()`. Replaces
    /// the old `NSString::alloc(nil).init_str(s)`.
    #[inline]
    pub fn nsstring(s: &str) -> objc2::rc::Retained<objc2_foundation::NSString> {
        objc2_foundation::NSString::from_str(s)
    }
}

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

/// macOS: maps each app window's NSWindow pointer → its top-level UI WKWebView
/// (NSView) pointer, so the shortcut forwarder can resolve, per event, WHICH
/// window fired a chord and whether the first responder is that window's own UI
/// webview (renderer handles it) or a child browser pane (forward the chord).
/// A single cached `main_view` was the day-one pop-out bug: a ⌘W typed in a
/// detached window (whose UI webview is not `main_view`) got forwarded to MAIN,
/// closing a tab in the wrong window. Populated as each window (main + detach-*)
/// is created; entries are never removed (pointers are only compared, never
/// dereferenced after the window dies, and the count is tiny).
#[cfg(target_os = "macos")]
static UI_WEBVIEW_BY_NSWINDOW: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<usize, usize>>,
> = std::sync::OnceLock::new();

/// Register (or refresh) a window's UI-webview NSView pointer keyed by its
/// NSWindow pointer. Called after main + every detach window is built. The
/// registry is a `&'static Mutex` (from the OnceLock), which is `Send + Copy`,
/// so the `with_webview` closure (needs `Send + 'static`) can capture it directly.
#[cfg(target_os = "macos")]
fn register_ui_webview(window: &tauri::WebviewWindow, label: &str) {
    use tauri::Manager;
    let ns_window = match window.ns_window() {
        Ok(p) => p as usize,
        Err(_) => return,
    };
    let app = window.app_handle();
    if let Some(wv) = app.get_webview(label) {
        let map: &'static _ = UI_WEBVIEW_BY_NSWINDOW
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let _ = wv.with_webview(move |platform| {
            if let Ok(mut m) = map.lock() {
                m.insert(ns_window, platform.inner() as usize);
            }
        });
    }
}

#[path = "child_reaper.rs"]
mod child_reaper;

#[cfg(target_os = "macos")]
#[path = "macos_notifications.rs"]
mod macos_notifications;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Field diagnostics for the poisoned-mutex aborts (see `no_abort`): every
    // Rust panic on ANY thread — including tokio task panics that are
    // otherwise swallowed silently, the likely lock POISONERS — is appended to
    // ~/Library/Logs/Topics-rust-panics.log before the default hook runs. The
    // crash report only ever shows the LAST panic (the abort); this log is the
    // only way to see the FIRST one, i.e. who actually poisoned the lock.
    {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(home) = std::env::var_os("HOME") {
                let path = std::path::PathBuf::from(home).join("Library/Logs/Topics-rust-panics.log");
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let thread = std::thread::current();
                let line = format!(
                    "[epoch {ts}] v{} thread '{}': {info}\n",
                    env!("CARGO_PKG_VERSION"),
                    thread.name().unwrap_or("<unnamed>"),
                );
                use std::io::Write;
                // Tetto alla dimensione: un panic che avvelena un mutex ne
                // genera altri a raffica (522.313 righe identiche, 126 MB, in
                // una sola giornata) e quel file poi non lo apre più nessuno —
                // proprio quando serve. Superata la soglia si riparte da capo
                // tenendo il giro precedente in `.1`: la PRIMA riga, quella che
                // dice chi ha avvelenato, sta sempre all'inizio di un file.
                const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
                if std::fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
                    let _ = std::fs::rename(&path, path.with_extension("log.1"));
                }
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                    let _ = f.write_all(line.as_bytes());
                }
            }
            default_hook(info);
        }));
    }

    // Dev-serve state resolved ONCE, EAGERLY, before the Builder — AppHandle-free
    // (`resolve_dev_serve` reads env + `<config>/<id>/topics-dev.json` directly). This
    // must NOT be lazy-in-the-protocol-handler: the config-defined window fires its
    // first `tauri://` asset request before `setup` runs, and under a login-item launch
    // that race latched `None` (embedded) even with a valid marker present. Resolving up
    // front makes every launch method deterministic. Absent marker ⇒ None ⇒ embedded.
    let dev_serve: Option<DevServe> = resolve_dev_serve();
    let dev_serve_for_proto = dev_serve.clone();

    // THE CHAIN IS BROKEN IN TWO right before `.menu()`, and that is the whole
    // reason this is a `let` and not one expression: the native menu is built on
    // macOS and Linux and NOT on Windows, and a `#[cfg]` cannot be hung on a
    // method call in the middle of a builder chain. It can be hung on a `let`.
    let builder = tauri::Builder::default()
        // Custom `tauri` asset protocol (overrides Tauri's built-in: when a user
        // registers "tauri", the internal one is skipped — see manager/webview.rs).
        // In dev mode it disk-serves /public with embedded fallback; otherwise it's
        // byte-identical to the built-in. Registered before the window builds.
        .register_uri_scheme_protocol("tauri", move |ctx, request| {
            // FIREWALL SUI PANICI, e qui non e' facoltativo.
            //
            // Questa chiusura gira sul callback SINCRONO di WKURLSchemeHandler,
            // lo stesso confine FFI non-unwind che `no_abort` protegge dodici
            // volte altrove: un panic qui non risale, chiama `abort()` e porta
            // via l'intera app. `serve_tauri_asset` lo sa e lo scrive nel suo
            // commento («a panic here abort()s the WHOLE app, and this is the
            // highest-traffic path in the file»), e degrada a mano i propri
            // `.unwrap()` con `unwrap_or_else(asset_fallback)`. Ma quella e' una
            // garanzia per ISPEZIONE, non per costruzione: copre le righe che
            // qualcuno ha guardato, non `asset_request_path`, non
            // `disk_asset_response`, non il risolutore incorporato, non un
            // indice fuori range, e soprattutto non un mutex gia' avvelenato da
            // un panic avvenuto altrove — che e' esattamente il meccanismo
            // descritto sopra `no_abort`.
            //
            // Il 2026-08-15 alle 19:30 la 2.2.138 e' morta di SIGABRT proprio
            // qui: `WebURLSchemeHandlerCocoa::platformStartTask` -> tredici
            // frame dell'app -> `abort() called`. Il binario di quel crash e'
            // stato sostituito da un aggiornamento prima che potessi
            // simbolicarlo, quindi la riga esatta NON la so. Ma la difesa non
            // dipende dal saperla, e la sua assenza si paga sempre allo stesso
            // modo: un asset che non si carica deve restare un asset che non si
            // carica, non la finestra che sparisce.
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                serve_tauri_asset(&ctx, &request, dev_serve_for_proto.as_ref())
            })) {
                Ok(resp) => resp,
                Err(payload) => {
                    let msg = payload
                        .downcast_ref::<&str>()
                        .map(|s| (*s).to_string())
                        .or_else(|| payload.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "non-string panic payload".to_string());
                    eprintln!("[no-abort] uri-scheme tauri://{}: {msg}", request.uri());
                    let mut resp = tauri::http::Response::new(std::borrow::Cow::Borrowed(
                        &b"asset handler panicked"[..],
                    ));
                    *resp.status_mut() = tauri::http::StatusCode::INTERNAL_SERVER_ERROR;
                    resp
                }
            }
        })
        // Single-instance FIRST (plugin requirement): a duplicate launch focuses
        // the running window instead of spawning a process that can't bind :13333.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch forwards here and exits; if no window can be shown
            // ON-SCREEN the user just sees "opens then closes, no window".
            reveal_a_window(app);
            // QUESTA è l'apertura istantanea. Un doppio click su un file mentre
            // Topics è già vivo lancia un secondo processo, che muore qui
            // consegnandoci i suoi argomenti: nessun avvio a freddo, nessun
            // server da riattaccare, il path arriva a una app che ha già tutto
            // in memoria.
            let paths = os_open::open_paths_from_args(&args);
            deliver_os_open_paths(app, paths);
        }))
        // Navigation guard: a stray external nav in the MAIN webview would escape
        // tauri://localhost and white-screen the whole app (no recovery but
        // restart). Allow only the app origin + the loopback proxy; route anything
        // else to the OS browser. Browser PANES (label "browserpane-*") navigate
        // freely — they're meant to load the open web.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("nav-guard")
                .on_navigation(|webview, url| {
                    let label = webview.label();
                    // Detached windows host the SAME app UI as main (loaded from
                    // tauri://localhost with ?topics=…) — they must fall through to
                    // the app-origin lock below, NOT the free-nav branch, or an
                    // external link would hijack the detached UI in place.
                    if label != "main" && !label.starts_with("detach-") {
                        // Browser PANES navigate the open web freely, BUT block
                        // non-web schemes (file://, chrome://, view-source:) for
                        // page- or agent-driven navigation (e.g. browser_eval
                        // setting window.location='file:///etc/passwd'). Mirrors
                        // Electron's guardNav / AGENT_NAV_SCHEMES — closes the LFI.
                        if label.starts_with("browserpane-") {
                            let allowed = matches!(
                                url.scheme(),
                                "http" | "https" | "about" | "blob" | "data"
                            );
                            if !allowed {
                                // Negare in SILENZIO è il difetto che ha
                                // prodotto «è tutto bianco»: la navigazione non
                                // parte, WKWebView non fallisce (non è mai
                                // cominciata), nessun did-fail, quindi la strip
                                // non ha niente da dire e la pane resta com'era
                                // — vuota, se era appena nata. L'evento va messo
                                // nella STESSA coda dei fallimenti veri
                                // (NAV_ERROR_EVENTS → browser_take_nav_errors →
                                // navErrorMessage): un canale solo, e il rifiuto
                                // si legge come si legge un host irraggiungibile.
                                if let Some(pane) = pane_id_from_label(label) {
                                    if let Ok(mut v) = NAV_ERROR_EVENTS.lock() {
                                        v.push(NavErrorMsg {
                                            url: url.to_string(),
                                            description: format!(
                                                "scheme \"{}\" is not allowed in a browser pane",
                                                url.scheme()
                                            ),
                                            code: NAV_ERR_SCHEME_REFUSED,
                                            at: nav_error_now_ms(),
                                            pane_id: pane.to_string(),
                                        });
                                    }
                                }
                            }
                            return allowed;
                        }
                        return true;
                    }
                    let allowed = is_app_origin(url)
                        || matches!(url.scheme(), "ipc" | "about" | "blob" | "data")
                        || (url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(PROXY_PORT));
                    // Do NOT route disallowed navigations to the OS browser. This
                    // handler ALSO fires for the DOM co-browse mirror iframe's link
                    // clicks — a sub-frame navigation wry can't distinguish from a
                    // top-frame one — and opening those in the system browser (Dia)
                    // was the "clicco un link nel browser di Topics e mi si apre
                    // fuori" bug. WKWebView doesn't reliably let the in-page bridge
                    // preventDefault the sandboxed-iframe navigation, so this shell
                    // guard is the reliable stop. Safe: every LEGIT external link in
                    // the app UI goes through openExternalOnce → the opener plugin
                    // directly (never this handler), and no app code navigates the
                    // main/detached frame to an external URL. So denying here just
                    // keeps the app on its origin (no white-screen) and lets the
                    // mirror's link clicks stay in the shared session (they relay as
                    // coordinate input; the headless navigates and the mirror follows).
                    allowed
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // Sidecar (bundled server) management on machines with no external server.
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        // "Open at Login" (Electron parity: app.setLoginItemSettings). A LaunchAgent
        // is registered/removed by the View ▸ "Apri al login" toggle. NOT auto-enabled
        // on first run (unlike Electron) — the user opts in, avoiding a surprise
        // login item.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        // NOTE: tauri-plugin-window-state was REMOVED — it mis-handled scale on this
        // mixed-DPI multi-monitor setup (persisted physical pixels as logical, failed to
        // restore, and ratcheted the window smaller via clamped-position saves). Window
        // SIZE is now persisted ourselves in logical units (see win_size_file + the setup
        // restore/save wiring); position stays centered (`center: true` in tauri.conf.json).
        // Auto-update — reads plugins.updater (endpoint + pubkey) from tauri.conf.json.
        // Inert until a signed release is published; the client drives check/install.
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(not(target_os = "windows"))]
    let builder = builder.menu(shortcuts_menu::build_app_menu);

    builder
        // Kept on every platform: on Windows there is no menu to click any more,
        // but `run_menu_action` is also the body the keyboard chords run
        // (`menu_chords_win`), and this handler is inert without a menu.
        .on_menu_event(|app, event| run_menu_action(app, event.id().0.as_str()))
        .setup(move |app| sidecar_boot::app_setup(app, dev_serve))
        .invoke_handler(tauri::generate_handler![
            perf_metrics::perf_metrics,
            window_focus::window_focus_state,
            window_chrome::set_traffic_lights,
            window_chrome::set_theme,
            os_integration::notify,
            os_integration::notification_status,
            os_integration::request_notification_permission,
            os_integration::focus_status,
            os_integration::open_external,
            os_integration::set_clipboard_image,
            os_integration::set_app_status,
            window_chrome::vibrancy_set_regions,
            window_chrome::vibrancy_animate_regions,
            browser_panes::browser_open,
            browser_panes::browser_navigate,
            browser_panes::browser_set_bounds,
            browser_panes::browser_set_visible,
            browser_panes::browser_set_page_zoom,
            browser_panes::browser_animate_bounds,
            browser_panes::browser_raise,
            browser_panes::browser_close,
            browser_panes::browser_purge_data_store,
            browser_panes::browser_purge_cache,
            browser_panes::browser_site_data_records,
            browser_panes::browser_forget_site,
            browser_panes::browser_reap_data_stores,
            browser_panes::browser_reap_store_caches,
            browser_panes::browser_claim,
            browser_panes::browser_list,
            browser_panes::browser_eval_js,
            browser_panes::browser_screenshot,
            browser_panes::browser_pane_get_cookies,
            browser_panes::browser_pane_set_cookies,
            browser_panes::browser_exec_js,
            browser_panes::browser_back,
            browser_panes::browser_forward,
            browser_panes::browser_reload,
            browser_panes::browser_set_user_agent,
            browser_panes::browser_toggle_devtools,
            browser_panes::browser_devtools_open,
            browser_panes::browser_try_suspend,
            browser_panes::browser_release_focus,
            browser_panes::browser_focus_pane,
            browser_panes::browser_nav_entries,
            browser_panes::browser_go_to_index,
            #[cfg(debug_assertions)]
            browser_panes::fps_report,
            browser_panes::focus_read,
            #[cfg(debug_assertions)]
            browser_panes::focus_grab_browser,
            #[cfg(debug_assertions)]
            browser_panes::focus_grab_window,
            #[cfg(debug_assertions)]
            browser_panes::focus_report,
            browser_panes::browser_take_download_events,
            browser_panes::browser_take_nav_errors,
            browser_panes::browser_take_new_tabs,
            browser_panes::browser_take_nav_state,
            browser_panes::browser_download_progress,
            sidecar_boot::updater_check,
            sidecar_boot::updater_install,
            sidecar_boot::sidecar_integrity,
            window_chrome::window_detach,
            window_chrome::window_detach_space,
            window_chrome::window_focus_label,
            window_chrome::window_close_label,
            window_chrome::app_reload_all,
            window_chrome::window_close_self,
            window_chrome::window_control,
            window_chrome::window_is_maximized,
            window_chrome::window_set_floating,
            os_open::take_os_open_paths,
            // The boot verdict, for the single-page app's own offline state: the reconnect page
            // says it too, but only a document navigation ever reaches that page.
            boot_degraded::boot_degraded,
            boot_degraded::boot_degraded_clear
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(sidecar_boot::on_run_event);
}

#[cfg(test)]
mod child_reaper_tests {
    use super::{child_reaper, validate_external_url};
    use std::time::{Duration, Instant};

    /// Is `pid` a zombie? `ps -o state=` reports `Z` for a defunct child. Only
    /// meaningful while the child is still OUR child (i.e. unreaped).
    #[cfg(unix)]
    fn is_zombie(pid: u32) -> bool {
        std::process::Command::new("ps")
            .args(["-o", "state=", "-p", &pid.to_string()])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().starts_with('Z'))
            .unwrap_or(false)
    }

    /// The whole point of the reaper: a short-lived child that nobody waits on
    /// must NOT be left `<defunct>`. Without `reap()` this pid stays a zombie
    /// for the lifetime of the process and the assertion below never clears.
    #[cfg(unix)]
    #[test]
    fn reaps_a_finished_child_instead_of_leaving_a_zombie() {
        let child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn /usr/bin/true");
        let pid = child.id();
        child_reaper::reap(child);

        // The reaper polls on a 500ms cadence; allow a few cycles on a loaded box.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if !is_zombie(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("pid {pid} is still a zombie: the reaper never waited on it");
    }

    /// A long-lived child must not stall the reaping of others queued behind it
    /// — that regression would reintroduce the leak under any real banner load.
    #[cfg(unix)]
    #[test]
    fn a_slow_child_does_not_block_reaping_the_others() {
        let slow = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let slow_pid = slow.id();
        child_reaper::reap(slow);

        let quick = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn /usr/bin/true");
        let quick_pid = quick.id();
        child_reaper::reap(quick);

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut reaped = false;
        while Instant::now() < deadline {
            if !is_zombie(quick_pid) {
                reaped = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // Don't leave a 30s sleep behind whichever way the assertion goes.
        let _ = std::process::Command::new("kill")
            .args(["-9", &slow_pid.to_string()])
            .status();
        assert!(reaped, "the quick child was starved behind the slow one");
    }

    /// `open_external` hands its argument to an OS launcher, so anything that is
    /// not a web/mail URL must be refused before it gets there. Tested on the
    /// pure check rather than the command: calling the command with a URL that
    /// PASSES would really open a browser window.
    #[test]
    fn rejects_non_web_schemes() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "/Applications/Calculator.app",
            "ftp://example.com",
            " https://example.com", // leading space defeats a naive prefix check
            "",
        ] {
            assert!(
                validate_external_url(bad).is_err(),
                "{bad} should have been rejected"
            );
        }
    }

    /// The launcher must pass the URL whole and never be a shell: `&calc.exe`
    /// in a link used to run a second command through `cmd /C start`.
    #[test]
    fn launcher_passes_url_intact_and_is_not_a_shell() {
        let url = "https://x/?a=1&calc.exe";
        let (program, args) = crate::external_launcher(url);
        assert_ne!(program.to_ascii_lowercase(), "cmd");
        assert_eq!(args.last().map(String::as_str), Some(url));
    }

    /// Scheme matching is case-insensitive: `HTTPS://` is a valid URL.
    #[test]
    fn accepts_web_schemes_case_insensitively() {
        for good in ["http://", "https://", "HTTPS://", "MailTo:"] {
            let url = format!("{good}example.com");
            assert!(
                validate_external_url(&url).is_ok(),
                "{url} should have passed the scheme check"
            );
        }
    }
}
