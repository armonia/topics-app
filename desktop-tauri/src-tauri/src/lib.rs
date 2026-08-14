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

/// The ⌘-chord forwarding allowlist, GENERATED from the shared shortcut registry
/// (`shared/shortcuts.ts`) by `scripts/gen-shortcuts.ts`. `app_chord_dispatch_js`
/// consults it so the native list can never silently drift from the window the
/// user sees. Regenerate with `bun run gen:shortcuts`.
#[cfg(target_os = "macos")]
mod shortcuts_generated;

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

/// Pid del processo WebContent che rende ciascuna webview, per label.
///
/// PERCHE' SERVE: `responsible_pids` sa quali processi appartengono all'app, ma
/// non QUALE webview stia dietro a quale — e senza quel legame la status bar puo'
/// dire quanto consuma l'app in tutto, mai quale scheda se lo stia mangiando.
/// Le pane browser di Topics sono webview NATIVE con un label esplicito
/// (`WebviewBuilder::new(&label, ...)`), quindi il nome c'era gia': mancava il pid.
///
/// `-[WKWebView _webProcessIdentifier]` e' SPI, non API pubblica. Verificato sul
/// runtime prima di scriverci sopra: il selettore esiste, ritorna un `int`, e su
/// due webview distinte da' due pid distinti, entrambi `com.apple.WebKit.WebContent`.
/// Prima che il contenuto sia caricato ritorna **0** — non un errore: il processo
/// non c'e' ancora. Uno 0 non entra mai nella mappa, cosi' quella scheda risulta
/// "non ancora misurata" invece che ferma a zero.
///
/// Essendo SPI puo' sparire con un aggiornamento di WebKit: `responds_to_selector`
/// e' controllato a ogni giro e l'assenza degrada a mappa vuota — si perde
/// l'attribuzione per scheda, non la misura complessiva.
#[cfg(target_os = "macos")]
static WEBVIEW_CONTENT_PID: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, i32>>,
> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn webview_content_pid_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, i32>> {
    WEBVIEW_CONTENT_PID.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// L'ULTIMA URL che abbiamo chiesto noi a ogni pane browser (label → url).
///
/// Esiste per non chiedere MAI a WKWebView dov'è. `webview.url()` scende in
/// `wry::url_from_webview`, che fa `unwrap()` sull'URL della WKWebView: per una
/// pane appena montata quell'URL è `nil`, e l'unwrap PANICA sul main thread —
/// dentro un callback Objective-C, con un lock di wry in mano. Il `catch_unwind`
/// che c'era prende l'unwind ma non disfa il danno: il mutex resta AVVELENATO, e
/// da lì ogni `lock().unwrap()` di tauri-runtime-wry panica a sua volta
/// (522.313 panic in un log, tutti figli di uno). Il finale è un `abort()` —
/// l'app che si chiude da sola.
///
/// L'URL di una pane la decidiamo noi (`browser_open`/`browser_navigate`): è
/// uno stato nostro, e leggerlo da qui non può fallire.
static BROWSER_PANE_URL: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::OnceLock::new();
fn browser_pane_url_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    BROWSER_PANE_URL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
/// Annota dove abbiamo mandato una pane. Il lock avvelenato non ci ferma: si
/// recupera il contenuto e si prosegue (`PoisonError::into_inner`), perché una
/// mappa di appunti non ha invarianti da proteggere.
fn remember_pane_url(label: &str, url: &str) {
    let mut m = browser_pane_url_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    m.insert(label.to_string(), url.to_string());
}
fn forget_pane_url(label: &str) {
    let mut m = browser_pane_url_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    m.remove(label);
}
fn last_pane_url(label: &str) -> Option<String> {
    let m = browser_pane_url_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    m.get(label).cloned()
}

/// Chiede a ogni webview il pid del suo WebContent e aggiorna la mappa.
///
/// ASINCRONA PER FORZA: `with_webview` esegue la closure sul MAIN THREAD, e
/// `perf_metrics` non gira di la'. Quindi questa scrive per il giro SUCCESSIVO e
/// il chiamante legge quanto raccolto finora — al primo campionamento la mappa e'
/// vuota e le schede risultano "non ancora misurate", che e' esattamente lo stato
/// che la specifica prevede per una pane appena aperta. E' anche il motivo per
/// cui non si puo' restituire un valore da qui: stesso vincolo che ha portato
/// `register_ui_webview` a passare per una mappa statica.
#[cfg(target_os = "macos")]
fn refresh_webview_content_pids(app: &tauri::AppHandle) {
    use tauri::Manager;
    let map: &'static _ = webview_content_pid_map();
    for (label, wv) in app.webviews() {
        let label = label.clone();
        let _ = wv.with_webview(move |platform| {
            let pid = unsafe { web_process_identifier(platform.inner() as *mut crate::mac::Object) };
            if let Ok(mut m) = map.lock() {
                match pid {
                    // >0 = processo vivo. 0 = contenuto non ancora caricato, e va
                    // TOLTO invece di lasciare il pid vecchio: dopo un reload il
                    // WebContent cambia, e un pid stantio attribuirebbe a questa
                    // scheda la memoria di un processo morto (o peggio, di uno
                    // nuovo che il kernel ha riassegnato allo stesso numero).
                    p if p > 0 => { m.insert(label, p); }
                    _ => { m.remove(&label); }
                }
            }
        });
    }
}

/// Footprint e CPU di ogni webview associata, saltando quelle il cui WebContent
/// e' morto nel frattempo.
///
/// `live` e' l'insieme dei pid dell'app in questo giro: un WebContent che non c'e'
/// piu' (scheda chiusa, reload) sparisce dal risultato invece di comparire con la
/// sua ultima misura, che sarebbe un numero vero riferito a un processo che non
/// esiste. Non si sfoltisce la mappa qui: e' `refresh_webview_content_pids` a
/// riscriverla, e questa funzione resta di sola lettura.
#[cfg(target_os = "macos")]
fn collect_webview_usage(live: &std::collections::HashSet<i32>) -> Vec<WebviewUsage> {
    const MB: f64 = 1_048_576.0;
    let map = match webview_content_pid_map().lock() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<WebviewUsage> = map
        .iter()
        .filter(|(_, pid)| live.contains(pid))
        .map(|(label, &pid)| WebviewUsage {
            label: label.clone(),
            pid,
            memory_mb: proc_memory(pid).map(|(fp, _)| fp as f64 / MB).unwrap_or(0.0),
            cpu_percent: proc_cpu_percent(pid, live),
        })
        .collect();
    // Ordine stabile: una `HashMap` itera a caso, e una lista che si rimescola a
    // ogni campionamento farebbe ballare qualunque UI la mostri in colonna.
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

/// `-[WKWebView _webProcessIdentifier]`, o 0 se il selettore non c'e' piu'.
///
/// # Safety
/// `view` deve essere il `WKWebView` restituito da `PlatformWebview::inner()`.
#[cfg(target_os = "macos")]
unsafe fn web_process_identifier(view: *mut crate::mac::Object) -> i32 {
    use crate::mac::{msg_send, sel};
    if view.is_null() {
        return 0;
    }
    let sel = sel!(_webProcessIdentifier);
    // SPI: se un aggiornamento di WebKit la togliesse, chiamarla a scatola chiusa
    // sarebbe un crash. Il controllo costa una `respondsToSelector:` per giro.
    let responds: bool = msg_send![view, respondsToSelector: sel];
    if !responds {
        return 0;
    }
    msg_send![view, _webProcessIdentifier]
}

/// Dimentica il pid del WebContent di una webview che non c'e' piu'.
///
/// PERCHE' NON BASTA IL FILTRO A VALLE. La mappa non veniva ripulita da
/// nessuno: gli unici scrittori sono `on_page_load` e
/// `refresh_webview_content_pids`, e il secondo itera `app.webviews()`, cioe'
/// solo le vive. Un'etichetta chiusa non veniva quindi piu' visitata e restava
/// nella mappa per sempre. `collect_webview_usage` scarta le voci morte
/// guardando se il pid e' ancora vivo, ma col `retain` di wry quel pid resta
/// vivo per sempre: il filtro non scartava niente e la lista mescolava pane
/// aperte e pane chiuse. Qualunque misura ne uscisse era falsa.
#[cfg(target_os = "macos")]
fn forget_webview_content_pid(label: &str) {
    if let Ok(mut m) = webview_content_pid_map().lock() {
        m.remove(label);
    }
}

/// `-[WKWebView _close]` esiste su questo sistema? Domanda di CLASSE, non di
/// istanza.
///
/// Si chiede alla classe perche' la risposta serve PRIMA di decidere come
/// chiudere, e l'istanza si raggiunge solo dentro `with_webview`, che esegue
/// sul main thread e risponde troppo tardi per scegliere il ripiego. La tabella
/// dei metodi di `WKWebView` non cambia a processo avviato, quindi la risposta
/// si calcola una volta sola. Classe assente (impossibile: l'app intera gira su
/// WKWebView) o selettore assente valgono entrambi "no", e il ripiego resta la
/// navigazione ad `about:blank`.
#[cfg(target_os = "macos")]
fn wkwebview_can_close() -> bool {
    static CAN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CAN.get_or_init(|| unsafe {
        use crate::mac::{msg_send, sel, Class};
        match Class::get(c"WKWebView") {
            Some(cls) => {
                let responds: bool = msg_send![cls, instancesRespondToSelector: sel!(_close)];
                responds
            }
            None => false,
        }
    })
}

/// `-[WKWebView _close]`: il teardown definitivo di una WKWebView. `false` se il
/// selettore non c'e' e non e' stato chiamato niente.
///
/// PERCHE' SERVE. wry non dealloca mai le sue webview: `impl Drop for
/// InnerWebView` chiama `self.webview.retain()` per aggirare un use-after-free.
/// Il processo WebContent di una pane chiusa resta quindi vivo per sempre, e
/// sono 15 WebView per 9,7 GB di footprint misurati.
///
/// Falsificata su un banco Swift separato prima di scriverla qui: il processo
/// WebContent muore in ~1,25 s dalla chiamata, `_isClosed` diventa 1, chiamarla
/// due volte non crasha, e non crasha nemmeno il `removeFromSuperview()` +
/// `retain()` che wry fa subito dopo nel suo `Drop`. Anche letture (`url`,
/// `title`), `setFrameSize`, `isHidden`, `reload` ed `evaluateJavaScript` su una
/// vista chiusa restano innocui: il JS torna solo errore.
///
/// NON si usano `_killWebContentProcess` e `_killWebContentProcessAndResetState`:
/// quelli simulano un crash del renderer, e WebKit RILANCIA il processo al primo
/// load. E' l'opposto di quello che serve qui.
///
/// SPI come `_webProcessIdentifier`, quindi stesso cancello: la
/// `respondsToSelector:` sull'istanza e' la seconda rete dopo quella di classe,
/// e costa una chiamata a chiusura.
///
/// # Safety
/// `view` deve essere il `WKWebView` restituito da `PlatformWebview::inner()`.
#[cfg(target_os = "macos")]
unsafe fn close_web_view(view: *mut crate::mac::Object) -> bool {
    use crate::mac::{msg_send, sel};
    if view.is_null() {
        return false;
    }
    let sel = sel!(_close);
    let responds: bool = msg_send![view, respondsToSelector: sel];
    if !responds {
        return false;
    }
    let _: () = msg_send![view, _close];
    true
}

/// Whole-app footprint, mirroring (a subset of) the Electron `perf.getMetrics`
/// shape so the status-bar dropdown can show the real desktop RAM/CPU.
///
/// This used to be the SHELL PROCESS ONLY (`partial: true`), on the belief that
/// the WKWebView content/GPU/networking XPC services — reparented to launchd, so
/// invisible to any ppid walk — "can't be attributed without private APIs". That
/// was wrong, and expensively so: measured on Attilio's box the shell alone reads
/// 59 MB while the app really owns 24 processes and 6.9 GB of footprint. The
/// status bar was understating usage by ~100x. See `responsible_pids`.
#[derive(Serialize, Clone)]
struct PerfMetrics {
    version: String,
    /// Whole-app memory footprint in MB — this is Activity Monitor's "Memory"
    /// column (`phys_footprint`), so the user can cross-check it there and get
    /// the same number. Includes memory the OS has compressed or swapped out,
    /// which is the point: that memory is still the app's, and paging it back in
    /// is exactly what makes the UI stutter.
    total_mb: f64,
    /// The slice of `total_mb` currently resident in physical RAM. The gap
    /// between the two IS the compression/swap pressure the app is generating.
    resident_mb: f64,
    /// Footprint of the WKWebView CONTENT processes — one per pane, and where
    /// essentially all of the app's memory actually lives.
    renderer_mb: f64,
    /// Footprint of the shared WKWebView GPU process.
    gpu_mb: f64,
    /// Everything else in the set: the shell itself, WKWebView Networking, and
    /// the platform-support helpers.
    other_mb: f64,
    /// CPU usage percent summed over the process set (delta-based), oppure `null`
    /// quando NESSUN processo aveva ancora un campione precedente su cui fare il
    /// delta.
    ///
    /// Perche' `Option` e non uno `0.0`. `proc_cpu_percent` restituisce `None` di
    /// proposito senza baseline — il suo commento dice che inventare uno zero e'
    /// il modo in cui un contatore comincia a mentire — e questo call site lo
    /// convertiva in `0.0` una riga dopo, buttando via la distinzione. Il costo
    /// erano DUE bugie in una: un totale piu' basso del vero ogni volta che si
    /// apre una pane (il pid nuovo contribuisce zero a una somma presentata come
    /// l'intera app), e un client che, nascondendo il chip su `> 0`, faceva
    /// sparire il contatore sia quando la misura mancava sia quando era davvero
    /// bassa. Ora `null` vuol dire "non misurato" e `0.0` vuol dire "misurato,
    /// quasi zero": sono due cose diverse e si vedono diverse.
    cpu_percent: Option<f32>,
    /// The `cpu_percent` share burnt by the WKWebView content processes...
    cpu_renderer: f32,
    /// ...and by the GPU/compositor process. Same buckets as the memory split,
    /// so the dropdown's CPU and memory rows describe the same partition.
    cpu_gpu: f32,
    /// Quanti processi dell'insieme hanno davvero contribuito a `cpu_percent`, e
    /// quanti erano in tutto. `cpu_sampled < cpu_pids` significa copertura
    /// PARZIALE: la somma e' vera ma incompleta, perche' i pid appena comparsi
    /// (una pane aperta, un WebContent rinato) non hanno ancora un delta. Il
    /// client lo dice invece di far passare la somma per completa.
    cpu_sampled: u32,
    cpu_pids: u32,
    /// How many processes the figures cover (1 = shell only).
    process_count: u32,
    /// True when the figure covers only the shell process. Now false on macOS;
    /// still true elsewhere, where we have no equivalent attribution API.
    partial: bool,
    /// Consumo attribuito alla singola webview, per label — il pezzo che i totali
    /// qui sopra non possono dare: quale SCHEDA sta consumando.
    ///
    /// Vuoto finche' nessun WebContent e' associato (primo campionamento, o
    /// WebKit che ritira la SPI): le schede risultano allora "non ancora
    /// misurate", che e' diverso da "ferme a zero" e il client lo dice.
    webviews: Vec<WebviewUsage>,
}

/// Quanto consuma UNA webview, con il label che la lega alla sua pane.
#[derive(Serialize, Clone)]
struct WebviewUsage {
    /// Lo stesso label con cui la webview e' stata creata, cioe' l'aggancio alla
    /// pane lato client.
    label: String,
    /// Pid del processo WebContent che la rende.
    pid: i32,
    /// `phys_footprint` in MB: la stessa metrica dei totali e di Monitoraggio
    /// Attivita', non `rss` — cosi' la parte e il tutto si possono confrontare.
    memory_mb: f64,
    /// `None` = NON MISURATA. Un WebContent appena nato non ha ancora un delta
    /// da cui ricavare una percentuale, e uno 0 lo farebbe passare per fermo.
    /// Per-core come il resto di questo payload: il client normalizza sui core.
    cpu_percent: Option<f32>,
}

// macOS process-responsibility + libproc entry points, declared by hand: they
// live in `/usr/lib/libSystem.B.dylib` and are what Activity Monitor itself
// groups by, but they have no crate binding here.
//
// `responsibility_get_pid_responsible_for_pid` is the one that matters. WebKit's
// XPC services are reparented to launchd, so ppid is useless — but the kernel
// keeps a SEPARATE "responsible process" link that survives reparenting, and it
// resolves each WebContent/GPU/Networking helper back to the app that opened it.
// It needs no entitlement and no root (verified on macOS 26: Mail→6 procs,
// Topics→24). It is not in a public header, hence the manual extern.
#[cfg(target_os = "macos")]
extern "C" {
    fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
    fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut u64) -> i32;
    fn proc_listpids(idtype: u32, typeinfo: u32, buffer: *mut i32, buffersize: i32) -> i32;
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
}

/// Il rapporto fra un tick di `mach_absolute_time` e un nanosecondo.
#[cfg(target_os = "macos")]
#[repr(C)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

#[cfg(target_os = "macos")]
static PERF_TIMEBASE: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();

/// Da tick di mach absolute time a nanosecondi.
///
/// IL BUG CHE CHIUDE, misurato il 2026-07-29: la status bar diceva **2%** con la
/// CPU vera del gruppo al **46,6%** (delta di tempo CPU su finestra fissa di 15 s,
/// dall'esterno, sugli stessi 25 pid). Fattore 41,67 — cioe' esattamente
/// `numer/denom` di questo timebase su Apple Silicon (125/3).
///
/// La causa e' un'unita' di misura, non un calcolo: `ri_user_time` e
/// `ri_system_time` di `rusage_info` NON sono nanosecondi. Il kernel li riempie da
/// `task->total_user_time`, che e' in tick di mach absolute time. Su Intel il
/// timebase e' 1/1 e i due numeri coincidono, quindi l'errore e' invisibile fino a
/// che non si gira su Apple Silicon — dove un tick vale 41,67 ns e il contatore
/// sottostima di quel fattore.
///
/// Verificato contro `ps -o time` (che e' tempo CPU reale) su 5 processi di eta'
/// diversa: la lettura grezza stava a 1/41,67 del vero, la lettura convertita
/// combacia alla seconda cifra decimale.
#[cfg(target_os = "macos")]
fn mach_ticks_to_ns(ticks: u64) -> u64 {
    let (numer, denom) = *PERF_TIMEBASE.get_or_init(|| {
        let mut tb = MachTimebaseInfo { numer: 0, denom: 0 };
        // Se la chiamata fallisse, 1/1 e' la degradazione onesta: e' il timebase
        // di Intel, quindi il numero torna a essere quello di prima invece di
        // diventare un valore inventato.
        if unsafe { mach_timebase_info(&mut tb) } == 0 && tb.numer > 0 && tb.denom > 0 {
            (u64::from(tb.numer), u64::from(tb.denom))
        } else {
            (1, 1)
        }
    });
    // Intermedio a 128 bit: `ticks * 125` sfora u64 solo oltre ~4,7 anni di CPU
    // per processo, ma una moltiplicazione larga non costa niente e non puo'
    // sbagliare.
    ((u128::from(ticks) * u128::from(numer)) / u128::from(denom)) as u64
}

/// How long a discovered pid set is reused. Enumerating every process on the box
/// and asking the kernel who is responsible for each is a full-table scan (~600
/// processes); the set only changes when a pane opens or closes, so the polls in
/// between just re-read rusage for the pids we already know. Keeps the status-bar
/// poll off the very CPU budget this readout exists to protect.
#[cfg(target_os = "macos")]
const PERF_PID_SET_TTL: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "macos")]
static PERF_PIDS: std::sync::OnceLock<
    std::sync::Mutex<(Option<std::time::Instant>, Vec<i32>)>,
> = std::sync::OnceLock::new();

/// Every pid macOS holds THIS process responsible for — the shell plus its
/// reparented WKWebView XPC services — cached for `PERF_PID_SET_TTL`.
#[cfg(target_os = "macos")]
fn responsible_pids(own: i32) -> Vec<i32> {
    let cell = PERF_PIDS.get_or_init(|| std::sync::Mutex::new((None, Vec::new())));
    // Recover a poisoned lock rather than panic: a prior panicked holder must not
    // permanently break the diagnostics readout.
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = guard
        .0
        .is_some_and(|at| at.elapsed() < PERF_PID_SET_TTL);
    if fresh && !guard.1.is_empty() {
        return guard.1.clone();
    }
    let scanned = scan_responsible_pids(own);
    *guard = (Some(std::time::Instant::now()), scanned.clone());
    scanned
}

#[cfg(target_os = "macos")]
fn scan_responsible_pids(own: i32) -> Vec<i32> {
    const PROC_ALL_PIDS: u32 = 1;
    // Sizing call (null buffer) returns the byte count currently needed.
    let needed = unsafe { proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return vec![own];
    }
    // Headroom: processes can be spawned between the sizing call and the fill.
    let cap = needed as usize / std::mem::size_of::<i32>() + 64;
    let mut buf = vec![0i32; cap];
    let written = unsafe {
        proc_listpids(
            PROC_ALL_PIDS,
            0,
            buf.as_mut_ptr(),
            (cap * std::mem::size_of::<i32>()) as i32,
        )
    };
    if written <= 0 {
        return vec![own];
    }
    let mut out = vec![own];
    for &pid in buf.iter().take(written as usize / std::mem::size_of::<i32>()) {
        // 0 padding from the tail of the buffer, and our own pid (already in).
        if pid <= 0 || pid == own {
            continue;
        }
        // Dead or protected pids answer 0 or -1 — neither of which is `own`.
        if unsafe { responsibility_get_pid_responsible_for_pid(pid) } == own {
            out.push(pid);
        }
    }
    out
}

/// `(phys_footprint, resident_size)` for a pid, in bytes.
///
/// `proc_pid_rusage` fills a `rusage_info_v2`, whose `rusage_info_v0` prefix is a
/// fixed run of u64 slots: [0..=1] `ri_uuid`, 2 `ri_user_time`, 3 `ri_system_time`,
/// 4 `ri_pkg_idle_wkups`, 5 `ri_interrupt_wkups`, 6 `ri_pageins`, 7 `ri_wired_size`,
/// 8 `ri_resident_size`, 9 `ri_phys_footprint`. Indices verified by measurement,
/// not by eyeballing the header: slot 8 matched `ps -o rss` exactly (605 MB).
#[cfg(target_os = "macos")]
fn proc_memory(pid: i32) -> Option<(u64, u64)> {
    const RUSAGE_INFO_V2: i32 = 2;
    // rusage_info_v2 is far smaller than this; oversizing means a future flavour
    // that returns more can't scribble past the buffer.
    let mut buf = [0u64; 64];
    if unsafe { proc_pid_rusage(pid, RUSAGE_INFO_V2, buf.as_mut_ptr()) } != 0 {
        return None;
    }
    Some((buf[9], buf[8]))
}

/// Tempo di CPU consumato da un pid dalla sua nascita, in nanosecondi.
///
/// Stessi slot di `proc_memory`, che li leggeva gia' e li buttava via: 2 e'
/// `ri_user_time`, 3 e' `ri_system_time`. Sono in tick di mach absolute time, non
/// in nanosecondi — la conversione e' obbligatoria e il perche' sta su
/// `mach_ticks_to_ns`. Convertiti, sono la stessa grandezza che `ps -o time`
/// riporta e su cui si misura la CPU dall'esterno: il numero della status bar e
/// quello di una sonda esterna parlano finalmente della stessa cosa.
#[cfg(target_os = "macos")]
fn proc_cpu_ns(pid: i32) -> Option<u64> {
    const RUSAGE_INFO_V2: i32 = 2;
    let mut buf = [0u64; 64];
    if unsafe { proc_pid_rusage(pid, RUSAGE_INFO_V2, buf.as_mut_ptr()) } != 0 {
        return None;
    }
    Some(mach_ticks_to_ns(buf[2].saturating_add(buf[3])))
}

/// Il campione precedente di CPU per pid: (nanosecondi cumulati, quando).
///
/// PERCHE' NON `sysinfo::cpu_usage()`. Il suo valore e' il delta contro l'ultimo
/// refresh di CHIUNQUE, e i lettori sono piu' d'uno (status bar a 5 s, pannello
/// del dropdown a 1,5 s, ogni finestra staccata). Ho provato a curarlo mettendo
/// una finestra minima di 2 s davanti al comando; misurato dopo quella cura, la
/// status bar diceva ancora 224% mentre la CPU vera del gruppo — delta di tempo
/// CPU su finestra fissa di 15 s, dall'esterno — era 46,3%. Fattore cinque
/// rimasto: mettere una cache davanti a un numero sbagliato non lo raddrizza.
///
/// Qui il delta e' NOSTRO: due letture dello stesso contatore cumulativo e il
/// tempo esatto trascorso fra le due. Non dipende da chi altro chiama, da quante
/// finestre sono aperte, o da cosa fa sysinfo dentro.
#[cfg(target_os = "macos")]
static PERF_CPU_PREV: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<i32, (u64, std::time::Instant)>>,
> = std::sync::OnceLock::new();

/// Percentuale di CPU per pid dall'ultima chiamata, e aggiorna il campione.
///
/// `None` per un pid senza campione precedente: la prima lettura non ha una
/// finestra su cui dividere, e inventare uno zero o un valore parziale e'
/// esattamente il modo in cui un contatore comincia a mentire. Anche un delta
/// negativo torna `None` — vuol dire che il pid e' stato riusato da un processo
/// nuovo, e la differenza fra due processi diversi non significa niente.
#[cfg(target_os = "macos")]
fn proc_cpu_percent(pid: i32, live: &std::collections::HashSet<i32>) -> Option<f32> {
    let now_ns = proc_cpu_ns(pid)?;
    let now = std::time::Instant::now();
    let cell = PERF_CPU_PREV.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut g = cell.lock().ok()?;
    // Pota i pid morti a ogni giro: senza, questa mappa cresce quanto il numero
    // di webview mai aperte.
    g.retain(|k, _| live.contains(k));
    let out = match g.get(&pid) {
        Some(&(prev_ns, prev_at)) => {
            let dt = now.duration_since(prev_at).as_secs_f64();
            if dt <= 0.0 || now_ns < prev_ns {
                None
            } else {
                Some(((now_ns - prev_ns) as f64 / 1e9 / dt * 100.0) as f32)
            }
        }
        None => None,
    };
    g.insert(pid, (now_ns, now));
    out
}

/// Persisted System so `cpu_usage()` is a REAL delta. sysinfo derives per-process
/// CPU from the change in CPU time between two refreshes; a fresh `System::new()`
/// per call has no prior sample, so `cpu_usage()` was always 0.0 (the status bar's
/// "CPU 0%" was fabricated, not measured). Keeping one System across calls makes
/// each poll diff against the previous one — the JS polls every 1.5–5s, so that's
/// a valid CPU average over the poll window, with zero added command latency.
static PERF_SYS: std::sync::OnceLock<std::sync::Mutex<sysinfo::System>> = std::sync::OnceLock::new();

/// Finestra minima fra due campionamenti della CPU, e durata di validita' del
/// risultato.
///
/// IL BUG CHE CHIUDE, misurato il 2026-07-29: la status bar dichiarava 85%
/// mentre la CPU vera del gruppo, misurata dall'esterno come delta di tempo CPU
/// su una finestra fissa di 15 s, era 14,4%. Fattore sei.
///
/// La causa non e' il calcolo ma la FINESTRA. `PERF_SYS` e' uno solo, e
/// `cpu_usage()` di sysinfo e' il delta contro l'ultimo refresh di CHIUNQUE. Il
/// commento qui sopra assumeva un solo lettore — "the JS polls every 1.5-5s, so
/// that's a valid CPU average over the poll window" — ma i lettori sono almeno
/// due: la status bar (5 s, sempre montata) e il pannello perf del dropdown
/// (1,5 s), piu' uno per ogni finestra staccata visibile. Quando due poll si
/// incrociano, il secondo misura la CPU sui pochi millisecondi trascorsi dal
/// primo, e su una finestra cosi' corta un singolo burst diventa l'intera
/// media: il numero non misura piu' il carico, misura la sfortuna.
/// Riproduzione: bastava APRIRE il dropdown perche' il numero salisse — cioe'
/// l'atto di guardarlo lo cambiava.
///
/// La cura non e' un calcolo diverso, e' una finestra DETERMINISTICA: si
/// campiona al massimo una volta ogni intervallo e, dentro quell'intervallo,
/// ogni lettore riceve lo STESSO valore gia' calcolato. Cosi' N poller a
/// cadenze qualsiasi, in N finestre, descrivono tutti la stessa finestra.
const PERF_SAMPLE_WINDOW: std::time::Duration = std::time::Duration::from_millis(2000);

/// L'ultima misura, con l'istante in cui e' stata presa. Serve a servire i
/// lettori che arrivano DENTRO la finestra senza far ripartire il cronometro.
static PERF_LAST: std::sync::OnceLock<std::sync::Mutex<Option<(std::time::Instant, PerfMetrics)>>> =
    std::sync::OnceLock::new();

#[tauri::command]
fn perf_metrics(app: tauri::AppHandle) -> PerfMetrics {
    let version = app.package_info().version.to_string();
    // Dentro la finestra si restituisce la misura gia' presa. Non e' una cache
    // per risparmiare lavoro: e' cio' che rende la finestra deterministica.
    {
        let cell = PERF_LAST.get_or_init(|| std::sync::Mutex::new(None));
        if let Ok(g) = cell.lock() {
            if let Some((taken, ref m)) = *g {
                if taken.elapsed() < PERF_SAMPLE_WINDOW {
                    return m.clone();
                }
            }
        }
    }
    let sys_mutex = PERF_SYS.get_or_init(|| std::sync::Mutex::new(sysinfo::System::new()));
    let own = match sysinfo::get_current_pid() {
        Ok(pid) => pid,
        Err(_) => {
            return PerfMetrics {
                version,
                total_mb: 0.0,
                resident_mb: 0.0,
                renderer_mb: 0.0,
                gpu_mb: 0.0,
                other_mb: 0.0,
                // Non conosciamo nemmeno il nostro pid: non c'e' nessuna misura,
                // e `null` lo dice. Uno `0.0` qui sarebbe un contatore che
                // annuncia "zero CPU" mentre non ha misurato niente.
                cpu_percent: None,
                cpu_renderer: 0.0,
                cpu_gpu: 0.0,
                cpu_sampled: 0,
                cpu_pids: 0,
                process_count: 0,
                partial: true,
                // Non sappiamo nemmeno il nostro pid: niente da attribuire.
                webviews: Vec::new(),
            }
        }
    };

    // The process set the figures cover. On macOS that's the whole app (shell +
    // every WKWebView XPC service the kernel attributes to us); elsewhere we have
    // no equivalent API, so it stays the shell alone and `partial` says so.
    #[cfg(target_os = "macos")]
    let (pids, partial) = (responsible_pids(own.as_u32() as i32), false);
    #[cfg(not(target_os = "macos"))]
    let (pids, partial) = (vec![own.as_u32() as i32], true);

    // CPU still comes from sysinfo: it derives per-process CPU from the change in
    // CPU time between refreshes, and PERF_SYS persists so each poll diffs against
    // the previous one. Refreshing only OUR pids keeps this off the full process
    // table. Reads 0.0 until the second poll establishes a baseline.
    let sysinfo_pids: Vec<sysinfo::Pid> = pids
        .iter()
        .map(|&p| sysinfo::Pid::from_u32(p as u32))
        .collect();
    // Which bucket a process falls in. The same partition drives both the CPU and
    // the memory rows of the dropdown, so the two describe the same thing.
    enum Bucket {
        Renderer,
        Gpu,
        Other,
    }
    fn bucket(name: &str) -> Bucket {
        if name.contains("WebContent") {
            Bucket::Renderer
        } else if name.contains("GPU") {
            Bucket::Gpu
        } else {
            Bucket::Other
        }
    }

    let mut cpu_percent = 0.0f32;
    let mut cpu_renderer = 0.0f32;
    let mut cpu_gpu = 0.0f32;
    // Copertura della misura di CPU: quanti pid hanno prodotto un delta, su
    // quanti ne abbiamo interrogati. Serve a non far passare una somma parziale
    // per il totale dell'app.
    let mut cpu_sampled = 0u32;
    let mut cpu_pids = 0u32;
    let mut buckets: std::collections::HashMap<i32, Bucket> = std::collections::HashMap::new();
    {
        let mut sys = sys_mutex.lock().unwrap_or_else(|e| e.into_inner());
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&sysinfo_pids), true);
        // L'insieme vivo, per potare i campioni dei pid morti.
        #[cfg(target_os = "macos")]
        let live: std::collections::HashSet<i32> = pids.iter().copied().collect();
        for (raw, spid) in pids.iter().zip(sysinfo_pids.iter()) {
            let Some(p) = sys.process(*spid) else { continue };
            cpu_pids += 1;
            // sysinfo resta per il NOME (che decide il bucket, e con esso lo split
            // renderer/gpu anche della memoria) e per il ramo non-macOS. Per la
            // CPU, su macOS, il delta ce lo calcoliamo noi: vedi `PERF_CPU_PREV`.
            #[cfg(target_os = "macos")]
            let sample = proc_cpu_percent(*raw, &live);
            #[cfg(not(target_os = "macos"))]
            let sample = Some(p.cpu_usage());
            // Il bucket si calcola SEMPRE: decide anche lo split della memoria,
            // che non dipende dall'avere una baseline di CPU. Prima il `continue`
            // non c'era perche' non c'era niente da saltare — lo zero inventato
            // teneva insieme i due percorsi per caso.
            let b = bucket(&p.name().to_string_lossy());
            // Un pid senza campione precedente NON contribuisce zero: non
            // contribuisce affatto, e `cpu_sampled` dice quanti hanno contato.
            if let Some(cpu) = sample {
                cpu_sampled += 1;
                cpu_percent += cpu;
                match b {
                    Bucket::Renderer => cpu_renderer += cpu,
                    Bucket::Gpu => cpu_gpu += cpu,
                    Bucket::Other => {}
                }
            }
            buckets.insert(*raw, b);
        }
    }

    // Memory does NOT come from sysinfo: its `memory()` is resident size, which
    // for these panes is wildly misleading — measured, 20 WebContent processes
    // reported 6374 MB of footprint against ~130 MB resident, because the OS had
    // compressed the rest. Resident alone would have told the user everything was
    // fine while the machine paged itself to death. So we read both from rusage
    // and report footprint as the headline, resident as the honest qualifier.
    let mut footprint = 0u64;
    let mut resident = 0u64;
    let mut renderer = 0u64;
    let mut gpu = 0u64;
    for &pid in &pids {
        #[cfg(target_os = "macos")]
        let sample = proc_memory(pid);
        // No responsibility/rusage equivalent off macOS: fall back to sysinfo's
        // resident size for both figures, which is all `partial: true` promises.
        #[cfg(not(target_os = "macos"))]
        let sample = {
            let sys = sys_mutex.lock().unwrap_or_else(|e| e.into_inner());
            sys.process(sysinfo::Pid::from_u32(pid as u32))
                .map(|p| (p.memory(), p.memory()))
        };
        let Some((pf, rs)) = sample else { continue };
        footprint += pf;
        resident += rs;
        match buckets.get(&pid) {
            Some(Bucket::Renderer) => renderer += pf,
            Some(Bucket::Gpu) => gpu += pf,
            _ => {}
        }
    }
    const MB: f64 = 1_048_576.0;

    let out = PerfMetrics {
        version,
        total_mb: footprint as f64 / MB,
        resident_mb: resident as f64 / MB,
        renderer_mb: renderer as f64 / MB,
        gpu_mb: gpu as f64 / MB,
        // Derived, so the four buckets always add up to the headline exactly —
        // no rounding drift between "other" and the parts we did classify.
        other_mb: footprint.saturating_sub(renderer + gpu) as f64 / MB,
        // Nessun pid con baseline ⇒ nessuna misura, e si dice `null`. Con almeno
        // un pid campionato la somma e' vera; se e' parziale lo dicono
        // `cpu_sampled`/`cpu_pids`, non un totale silenziosamente basso.
        cpu_percent: if cpu_sampled == 0 { None } else { Some(cpu_percent) },
        cpu_renderer,
        cpu_gpu,
        cpu_sampled,
        cpu_pids,
        process_count: pids.len() as u32,
        partial,
        // Legge quanto raccolto FINORA e chiede il giro successivo: la lettura
        // del pid deve passare dal main thread (vedi `refresh_webview_content_pids`),
        // quindi al primo campionamento questa e' vuota di proposito.
        webviews: {
            #[cfg(target_os = "macos")]
            {
                // `live` era locale al blocco di campionamento, chiuso sopra;
                // `pids` no, ed e' la stessa lista.
                let alive: std::collections::HashSet<i32> = pids.iter().copied().collect();
                let out = collect_webview_usage(&alive);
                refresh_webview_content_pids(&app);
                out
            }
            #[cfg(not(target_os = "macos"))]
            {
                Vec::new()
            }
        },
    };
    // Pubblica la misura: chi legge nei prossimi PERF_SAMPLE_WINDOW riceve
    // questa, invece di far ripartire il cronometro e misurare la CPU su pochi
    // millisecondi. E' il pezzo che rende la finestra deterministica.
    if let Ok(mut g) = PERF_LAST.get_or_init(|| std::sync::Mutex::new(None)).lock() {
        *g = Some((std::time::Instant::now(), out.clone()));
    }
    out
}

/// Loopback port the WKWebView reaches the data server through (plain HTTP/WS).
/// FIXED — the client hardcodes this (client/src/lib/shell/net.ts DESKTOP_SERVER_HOST),
/// so a SINGLE webview target works whether the upstream is the external launchd
/// server (TLS :3333) or our own bundled sidecar (plain HTTP on an ephemeral port).
const PROXY_PORT: u16 = 13333;
/// The external (launchd / dev) data server. When one is already listening here
/// the shell defers to it and never spawns the sidecar (Attilio's box).
const DEFAULT_UPSTREAM_PORT: u16 = 3333;

/// Where the loopback proxy pipes to, decided ONCE at boot by `decide_upstream`:
/// either the external server on :3333 (TLS) or the sidecar we spawned (plain HTTP
/// on `port`). The proxy reads this after it's set; `tls=false` skips the TLS
/// origination and pipes raw TCP straight through.
#[derive(Clone, Copy)]
struct Upstream {
    port: u16,
    tls: bool,
}
static UPSTREAM: std::sync::OnceLock<Upstream> = std::sync::OnceLock::new();

/// Probe 127.0.0.1:port for a live Topics server. Sends a minimal HTTP/1.0 GET to
/// the unauthenticated-shape `/__daemon/healthz` route; ANY HTTP status line back
/// (even 401 — the server is up, just rejecting our tokenless probe) proves a
/// server is listening and speaking HTTP, which is all we need to defer to it.
/// `tls` picks plain vs TLS-originated origination (the external server serves TLS).
/// Returns true on a readable HTTP response within a short timeout.
async fn probe_topics_server(port: u16, tls: bool) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let connect = TcpStream::connect(("127.0.0.1", port));
    let stream = match tokio::time::timeout(std::time::Duration::from_millis(800), connect).await {
        Ok(Ok(s)) => s,
        _ => return false,
    };
    let req = b"GET /__daemon/healthz HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    // Read just enough to see a status line.
    async fn round_trip<S>(mut s: S, req: &[u8]) -> bool
    where
        S: AsyncReadExt + AsyncWriteExt + Unpin,
    {
        if s.write_all(req).await.is_err() {
            return false;
        }
        let mut buf = [0u8; 64];
        match s.read(&mut buf).await {
            Ok(n) if n > 0 => buf.get(..5) == Some(b"HTTP/"),
            _ => false,
        }
    }
    let fut = async {
        if tls {
            let connector = match native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .build()
            {
                Ok(c) => tokio_native_tls::TlsConnector::from(c),
                Err(_) => return false,
            };
            match connector.connect("127.0.0.1", stream).await {
                Ok(tls_stream) => round_trip(tls_stream, req).await,
                Err(_) => false,
            }
        } else {
            round_trip(stream, req).await
        }
    };
    tokio::time::timeout(std::time::Duration::from_millis(1500), fut)
        .await
        .unwrap_or(false)
}

/// How long a NON-document connection (XHR, SSE, WebSocket) waits for the upstream
/// to come back before we give up on it. A `launchctl kickstart -k` of the external
/// server is down for ~2s; holding the connection open across that gap means the
/// running app never sees the outage at all.
const UPSTREAM_GRACE: std::time::Duration = std::time::Duration::from_secs(15);
/// Same, for a DOCUMENT navigation. Much shorter: we have something better than
/// waiting — the reconnect page, which paints immediately and reloads itself.
const UPSTREAM_GRACE_DOC: std::time::Duration = std::time::Duration::from_secs(3);

/// Read an HTTP request head (everything up to the blank line) off `s`, with a cap
/// and a timeout. Returns the bytes actually read — they MUST be replayed to the
/// upstream once we connect, since they're already out of the socket. An empty
/// return means the peer opened a connection and said nothing yet (speculative
/// preconnect): we then pipe blind, exactly like before.
async fn read_request_head(s: &mut tokio::net::TcpStream) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    let deadline = std::time::Duration::from_millis(2000);
    let fut = async {
        loop {
            match s.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    head.extend_from_slice(&buf[..n]);
                    if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() >= 16 * 1024 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };
    let _ = tokio::time::timeout(deadline, fut).await;
    head
}

/// Is this request head a WebSocket upgrade? Those must never be answered with an
/// HTML body — the client would just log a handshake error. We let them fail.
fn is_websocket_head(head: &[u8]) -> bool {
    let s = String::from_utf8_lossy(head).to_ascii_lowercase();
    s.contains("upgrade: websocket")
}

/// Is this request head a top-level DOCUMENT navigation? That's the one case where
/// a dead upstream turns into "the window is empty": a transparent, titlebar-less
/// window whose webview has nothing to paint is INVISIBLE, not white. Detected from
/// `Sec-Fetch-Dest: document` (WebKit always sends it) with an `Accept: text/html`
/// fallback for anything that doesn't.
fn is_document_head(head: &[u8]) -> bool {
    let s = String::from_utf8_lossy(head).to_ascii_lowercase();
    if is_websocket_head(head) {
        return false;
    }
    if s.contains("sec-fetch-dest: document") {
        return true;
    }
    s.lines()
        .find(|l| l.starts_with("accept:"))
        .is_some_and(|l| l.contains("text/html"))
}

/// The page the shell serves INSTEAD of a dead navigation. Two jobs, both of which
/// the "nothing" we served before could not do: it PAINTS (opaque background, so
/// the transparent window stops being invisible and the user sees a state instead
/// of a ghost), and it RELOADS ITSELF every second — so the moment the server is
/// back the real app returns with no human in the loop. `no-store` keeps WebKit
/// from ever caching this in place of the app.
fn reconnect_page_response() -> Vec<u8> {
    let body = "<!doctype html><html><head><meta charset=\"utf-8\">\
<title>Topics</title>\
<style>html,body{height:100%;margin:0;background:#1c1c1e;color:#98989d;\
font:13px/1.5 -apple-system,system-ui,sans-serif;\
display:flex;align-items:center;justify-content:center;-webkit-user-select:none}\
.d{width:6px;height:6px;border-radius:50%;background:#98989d;margin-right:8px;\
animation:p 1.2s ease-in-out infinite}\
@keyframes p{0%,100%{opacity:.25}50%{opacity:1}}</style></head>\
<body><div class=\"d\"></div>In attesa del server\u{2026}\
<script>setTimeout(function(){location.reload()},1000)</script></body></html>";
    format!(
        "HTTP/1.1 503 Service Unavailable\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\n\
Cache-Control: no-store\r\n\
Connection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

/// Connect to the upstream, RETRYING until `grace` runs out. The old code gave up on
/// the first `ECONNREFUSED`, which is exactly what a server restart looks like for
/// the second or two it takes to rebind — one unlucky reload in that window left the
/// window permanently empty.
async fn connect_upstream_retrying(
    port: u16,
    grace: std::time::Duration,
) -> Option<tokio::net::TcpStream> {
    let deadline = std::time::Instant::now() + grace;
    loop {
        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(s) => return Some(s),
            Err(_) if std::time::Instant::now() < deadline => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            Err(_) => return None,
        }
    }
}

/// Loopback origination proxy: accept plain TCP on 127.0.0.1:PROXY_PORT and pipe it,
/// byte-for-byte, to the chosen upstream. When the upstream is the external server
/// (`tls=true`) we ADD TLS — WKWebView won't trust the server's local-CA cert but
/// happily speaks plain HTTP/WS to loopback, so the shell connects to
/// http://127.0.0.1:PROXY_PORT and this task adds the TLS. When the upstream is our
/// own sidecar (`tls=false`, plain HTTP via NO_TLS) we pipe raw TCP through. Either
/// way it's transparent: HTTP, WebSocket upgrades and SSE streams pass untouched (no
/// L7 parsing), and the client's `Origin: tauri://localhost` is preserved so the
/// server's CORS still matches. Reads the boot-decided `UPSTREAM` (defaults to the
/// external TLS server if `decide_upstream` never ran, e.g. probe race).
async fn run_tls_proxy() {
    use tokio::net::TcpListener;

    let listener = match TcpListener::bind(("127.0.0.1", PROXY_PORT)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[proxy] bind 127.0.0.1:{PROXY_PORT} failed: {e}");
            return;
        }
    };
    let up = *UPSTREAM.get().unwrap_or(&Upstream { port: DEFAULT_UPSTREAM_PORT, tls: true });
    proxy_loop(listener, up).await
}

/// The accept loop, split out from `run_tls_proxy` so the outage behaviour (hold →
/// reconnect page → self-recovery) can be driven end-to-end in a test against a real
/// browser, on an ephemeral port, without touching :13333 or a live server.
async fn proxy_loop(listener: tokio::net::TcpListener, up: Upstream) {
    use tokio::io::copy_bidirectional;

    let tls = match native_tls::TlsConnector::builder()
        // The server presents a local-CA cert for 127.0.0.1; we originate the TLS
        // ourselves to a hard-coded loopback address, so cert/hostname validation
        // adds nothing here — the trust boundary is "is it really loopback".
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
    println!(
        "[proxy] loopback proxy {} -> {}127.0.0.1:{}",
        listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_default(),
        if up.tls { "https://" } else { "http://" },
        up.port
    );

    loop {
        let (mut inbound, _) = match listener.accept().await {
            Ok(p) => p,
            Err(_) => continue,
        };
        let tls = tls.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncWriteExt;
            // Read the request head FIRST so we can tell a document navigation from
            // an XHR/WebSocket. Whatever we read is replayed to the upstream below —
            // it's already out of the socket, `copy_bidirectional` can't see it.
            let head = read_request_head(&mut inbound).await;
            let doc = is_document_head(&head);
            let grace = if doc { UPSTREAM_GRACE_DOC } else { UPSTREAM_GRACE };
            let upstream = match connect_upstream_retrying(up.port, grace).await {
                Some(s) => s,
                None => {
                    eprintln!("[proxy] upstream :{} unreachable for {:?}", up.port, grace);
                    if doc {
                        // Paint SOMETHING and keep retrying by itself. Without this the
                        // transparent window has no pixels at all — "sparita" and "vuota"
                        // are the same state, with no way back short of a relaunch.
                        let _ = inbound.write_all(&reconnect_page_response()).await;
                        let _ = inbound.flush().await;
                    }
                    return;
                }
            };
            if up.tls {
                let mut tls_stream = match tls.connect("127.0.0.1", upstream).await {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[proxy] upstream TLS handshake failed: {e}");
                        return;
                    }
                };
                if !head.is_empty() && tls_stream.write_all(&head).await.is_err() {
                    return;
                }
                let _ = copy_bidirectional(&mut inbound, &mut tls_stream).await;
            } else {
                let mut plain = upstream;
                if !head.is_empty() && plain.write_all(&head).await.is_err() {
                    return;
                }
                let _ = copy_bidirectional(&mut inbound, &mut plain).await;
            }
        });
    }
}

// ─────────────────────── Bundled server sidecar ───────────────────────
//
// SELF-CONTAINED release path. On Attilio's box an external launchd server owns
// :3333 (TLS) and the shell defers to it — nothing here runs. On a VIRGIN machine
// (the download the "ragazzi" try) nothing is on :3333, so the app would show a
// blank "connecting" screen. To be truly standalone, the shell instead spawns a
// bundled server sidecar (`topics-server`, a `bun build --compile` binary declared
// in tauri.conf bundle.externalBin) on a free loopback port with plain HTTP
// (NO_TLS) and an isolated per-user data dir, then points the loopback proxy at it.
// The sidecar is killed when the app exits (RunEvent::Exit), and survives webview
// reloads (it's a separate process, not tied to the webview).

/// The spawned sidecar's process handle, kept for a clean kill on app exit. `None`
/// when we deferred to an external server (no sidecar spawned).
static SIDECAR_CHILD: std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>> =
    std::sync::Mutex::new(None);

/// Ask the OS for a free loopback TCP port by binding :0 and reading it back, then
/// dropping the listener so the sidecar can bind it. A tiny TOCTOU window exists
/// (another process could grab it between drop and the sidecar's bind) but on a
/// quiet loopback that's negligible, and the health-wait below surfaces a failure
/// rather than hanging. Falls back to a fixed high port if the probe fails.
fn pick_free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(13337)
}

/// Resolve the sidecar's writable data dir: Tauri's per-user app-data dir with a
/// `data-standalone` subdir (kept SEPARATE from any dev/launchd `~/.topics` state so
/// a self-contained run never collides with a full install on the same machine).
fn sidecar_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("io.armonia.topics.tauri"));
    let dir = base.join("data-standalone");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Marker recording that THIS machine has a real external server on :3333.
///
/// Written the first time we successfully defer to it, and never removed. It is
/// what tells a later boot "you have a real universe here" so a slow start can
/// never be mistaken for a virgin machine.
fn external_server_marker(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("io.armonia.topics.tauri"));
    let _ = std::fs::create_dir_all(&base);
    base.join("external-server-seen")
}

/// Resolve the bundled **Rust PTY bridge** sidecar (`binaries/pty-bridge-<triple>` →
/// bundled beside the app binary in `Contents/MacOS/pty-bridge`). It's a ~0.5 MB
/// self-contained, wire-compatible port of pty-bridge.mjs that the compiled Bun
/// sidecar spawns for terminals on a virgin install — Bun itself can't run node-pty.
///
/// Returns `Some` only when the binary exists (macOS + Linux; on Windows the sidecar
/// is a no-op stub and this returns None → standalone keeps its 503 kill-switch). On
/// unix the packaged binary can lose its exec bit, so we re-assert it — a
/// non-executable bridge would fail to spawn and silently drop back to "no terminals".
fn bundled_pty_bridge_bin() -> Option<std::path::PathBuf> {
    // Windows ships only a no-op stub; don't advertise a bridge there.
    if cfg!(windows) {
        return None;
    }
    // Tauri places externalBin sidecars beside the app executable.
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bin = dir.join("pty-bridge");
    if !bin.exists() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perm = meta.permissions();
            if perm.mode() & 0o111 == 0 {
                perm.set_mode(perm.mode() | 0o755);
                let _ = std::fs::set_permissions(&bin, perm);
            }
        }
    }
    Some(bin)
}

/// Resolve the bundled **Rust WebRTC bridge** sidecar (`binaries/webrtc-bridge-<triple>`
/// → bundled beside the app binary in `Contents/MacOS/webrtc-bridge`). It streams a
/// server-side headless-Chromium pane as one shared H.264 WebRTC track to N viewers —
/// the transport the browser pane's `<video>` renders (see server/webrtc-bridge.ts +
/// client/src/hooks/useRemoteBrowser.ts). The compiled Bun server can't hold an
/// openh264 encoder / webrtc-rs stack in-process, so it spawns this binary.
///
/// Same shape as `bundled_pty_bridge_bin`: `Some` only when the binary exists (Windows
/// ships a no-op stub, so we don't advertise one there → the server keeps
/// `available() == false` and the pane falls back to DOM rendering instead of hanging
/// on a negotiation nobody answers). On unix the packaged binary can lose its exec bit,
/// so we re-assert it.
fn bundled_webrtc_bridge_bin() -> Option<std::path::PathBuf> {
    // Windows ships only a no-op stub (the wire protocol is a Unix socket).
    if cfg!(windows) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bin = dir.join("webrtc-bridge");
    if !bin.exists() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perm = meta.permissions();
            if perm.mode() & 0o111 == 0 {
                perm.set_mode(perm.mode() | 0o755);
                let _ = std::fs::set_permissions(&bin, perm);
            }
        }
    }
    Some(bin)
}

/// Boot decision: if a Topics server already answers on :3333 (external launchd /
/// dev — try TLS first, then plain), defer to it. Otherwise spawn the bundled
/// sidecar on a free plain-HTTP port with an isolated data dir, wait until it's
/// healthy, and record the child for kill-on-exit. Sets `UPSTREAM` either way so the
/// loopback proxy pipes to the right place. Never blocks the UI beyond the short
/// probe + (cold-start only) health wait; on total failure it leaves UPSTREAM at the
/// default external target so the app degrades to today's "connecting" rather than
/// panicking.
async fn decide_upstream_and_spawn(app: tauri::AppHandle) {
    // 1) Prefer an external server on :3333 (Attilio's launchd, or a dev server).
    // RETRY for a few seconds before falling back: a single instant probe raced a
    // `launchctl kickstart -k` restart once — the external server was down for the
    // ~2s the app booted in, so the shell silently forked an EMPTY standalone
    // sidecar universe and every real topic/terminal "disappeared". A machine that
    // has an external server usually gets it back within seconds; a truly virgin
    // machine only pays this wait ONCE on first launch (then the sidecar spawns).
    // A machine that has ALREADY had a real server here is never a virgin
    // machine, so it gets a much longer wait and, past it, no sidecar at all.
    //
    // The 2026-08-13 incident: a fork bomb in the ai-bridge daemon took the box
    // to load 644 and 36 GB of swap. The launchd server was alive but far too
    // slow to answer inside the 5.6s window, so the shell concluded "virgin
    // machine", forked its own EMPTY universe, and the user lost every task,
    // every pinned tab and even the version number. It then survived a reboot,
    // because at login the real server needs longer than 5.6s to open an 893
    // topic database while the app is already probing. Time alone cannot tell
    // "no server here" from "server busy": only this marker can.
    let marker = external_server_marker(&app);
    let seen_before = marker.exists();
    let attempts: u32 = if seen_before { 60 } else { 8 };
    for attempt in 0..attempts {
        if probe_topics_server(DEFAULT_UPSTREAM_PORT, true).await {
            eprintln!("[sidecar] external TLS server on :{DEFAULT_UPSTREAM_PORT} — deferring, no sidecar");
            let _ = std::fs::write(&marker, "1");
            let _ = UPSTREAM.set(Upstream { port: DEFAULT_UPSTREAM_PORT, tls: true });
            return;
        }
        if probe_topics_server(DEFAULT_UPSTREAM_PORT, false).await {
            eprintln!("[sidecar] external plain-HTTP server on :{DEFAULT_UPSTREAM_PORT} — deferring, no sidecar");
            let _ = std::fs::write(&marker, "1");
            let _ = UPSTREAM.set(Upstream { port: DEFAULT_UPSTREAM_PORT, tls: false });
            return;
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        }
    }

    // Still nothing, but this machine is KNOWN to own a real server: point at it
    // and let the client show "connecting" until it comes back. Forking an empty
    // standalone universe here would silently hide every real topic, which is
    // strictly worse than waiting.
    if seen_before {
        eprintln!(
            "[sidecar] no answer on :{DEFAULT_UPSTREAM_PORT} after {}s, but this machine has a real server \
             (marker {}) — NOT spawning a sidecar; degrading to \"connecting\"",
            (attempts as u64 * 700) / 1000,
            marker.display(),
        );
        let _ = UPSTREAM.set(Upstream { port: DEFAULT_UPSTREAM_PORT, tls: true });
        return;
    }

    // 2) Nothing external — spawn the bundled sidecar (plain HTTP, isolated data).
    use tauri_plugin_shell::ShellExt;
    let port = pick_free_port();
    let data_dir = sidecar_data_dir(&app);
    eprintln!(
        "[sidecar] no external server; spawning bundled sidecar on :{port} (data: {})",
        data_dir.display()
    );
    // The bundled Rust PTY-bridge sidecar (binaries/pty-bridge → Contents/MacOS/
    // pty-bridge). Present → this "standalone" sidecar can run a REAL PTY bridge, so
    // shell/claude-code tabs work on a virgin install. Absent (Windows stub / older
    // bundle / dev build without the sidecar) → None, keeping today's kill-switch.
    let bridge_bin = bundled_pty_bridge_bin();
    // Same story for the WebRTC bridge: present → the browser pane's shared-session
    // <video> transport works on a virgin install; absent → server/webrtc-bridge.ts
    // reports available()==false and the pane uses the DOM fallback.
    let webrtc_bin = bundled_webrtc_bridge_bin();
    let cmd = match app.shell().sidecar("topics-server") {
        Ok(c) => {
            let mut c = c
                .env("NO_TLS", "1")
                .env("BUN_PORT", port.to_string())
                // Bind IPv4 loopback explicitly: the proxy connects to 127.0.0.1 and a
                // bare "::" bind is IPv6-only on some Bun/macOS combos (see server.ts).
                .env("SERVER_HOST", "127.0.0.1")
                // ── ISOLATION (all partition keys, not just one) ─────────────────
                // The server partitions its mutable state across SEPARATE env vars,
                // and setting only TOPICS_DATA_DIR is NOT enough — this is the
                // 2026-07-02 incident: the PTY-bridge socket path is md5(cwd) when
                // `DATA_DIR` is unset (server/routes/terminal.ts getSocketPath). A
                // sidecar sharing a checkout's cwd hashed to the SAME socket as the
                // live launchd server and, with its own empty DB, reconciled the live
                // PTYs as "orphans" and KILLED them. So isolate EVERY state root:
                //   • DATA_DIR / TOPICS_DATA_DIR / TOPICS_HOME — db + browser state;
                //     daemon lock, ui-state backups, events. DATA_DIR being set ALSO
                //     makes getSocketPath derive a DISTINCT, short `/tmp/topics-pty-
                //     bridge-<hash>.sock` (hash of cwd\0DATA_DIR) that a real server
                //     (DATA_DIR unset) can never collide with — so the sidecar's
                //     bridge is structurally isolated WITHOUT pinning a long,
                //     bind-unfriendly socket path under Application Support (a unix
                //     socket path >104 bytes fails to bind with EINVAL).
                //   • TOPICS_EMBEDDED=1 — self-contained-bundle flag: keeps the
                //     gateway/journal integrations off. It ALSO disables the PTY
                //     bridge UNLESS a bundled bridge re-enables it (see below).
                .env("TOPICS_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("DATA_DIR", data_dir.join("data").to_string_lossy().to_string())
                .env("TOPICS_HOME", data_dir.join("home").to_string_lossy().to_string())
                .env("TOPICS_EMBEDDED", "1");
            match &bridge_bin {
                // Bundled Rust bridge present: hand the server the binary to spawn.
                // This flips isPtyBridgeDisabled() to false (terminal.ts) so terminals
                // work, while the DATA_DIR-derived socket above keeps them isolated
                // from any real server.
                Some(bin) => {
                    c = c.env("TOPICS_PTY_BRIDGE_BIN", bin.to_string_lossy().to_string());
                }
                // No bundled bridge (Windows stub / older bundle): keep the hard
                // kill-switch — a virgin machine has no external bridge and Bun can't
                // run one itself, so terminals answer 503.
                None => {
                    c = c.env("TOPICS_DISABLE_PTY_BRIDGE", "1");
                }
            }
            match &webrtc_bin {
                // Bundled WebRTC bridge present: hand the server the binary to spawn
                // lazily on the first SDP offer (resolveBin() in webrtc-bridge.ts).
                Some(bin) => {
                    c = c.env("TOPICS_WEBRTC_BRIDGE_BIN", bin.to_string_lossy().to_string());
                }
                // No bundled bridge (Windows stub / older bundle): say so explicitly
                // rather than letting the server probe a dev-checkout path that only
                // exists on a developer's machine.
                None => {
                    c = c.env("TOPICS_DISABLE_WEBRTC_BRIDGE", "1");
                }
            }
            c
        }
        Err(e) => {
            eprintln!("[sidecar] sidecar() resolve failed: {e} — falling back to external target");
            let _ = UPSTREAM.set(Upstream { port: DEFAULT_UPSTREAM_PORT, tls: true });
            return;
        }
    };
    match cmd.spawn() {
        Ok((mut rx, child)) => {
            if let Ok(mut slot) = SIDECAR_CHILD.lock() {
                *slot = Some(child);
            }
            // Point the proxy at the sidecar NOW (before the health wait) so it can
            // start piping the moment the server binds; a connection before then just
            // fails and the client retries.
            let _ = UPSTREAM.set(Upstream { port, tls: false });
            // Drain the sidecar's stdout/stderr so its pipe never fills (which would
            // block the child); log lines to our stderr for field diagnosis.
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(ev) = rx.recv().await {
                    match ev {
                        CommandEvent::Stdout(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar!] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[sidecar] terminated: code={:?} signal={:?}", payload.code, payload.signal);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("[sidecar] spawn failed: {e} — falling back to external target");
            let _ = UPSTREAM.set(Upstream { port: DEFAULT_UPSTREAM_PORT, tls: true });
            return;
        }
    }

    // 3) Wait for the sidecar to become healthy (cold DB init + migrations take a
    // moment), up to ~20s — but FIRE-AND-FORGET so it does NOT delay the caller,
    // which starts run_tls_proxy the instant we return. UPSTREAM is already set
    // (above), so the proxy can bind and start piping immediately; a connection
    // that lands before the server itself binds just fails and the client retries.
    // Previously this wait ran inline before the caller reached run_tls_proxy, so
    // a virgin machine sat on "connecting" for the full cold-start (up to 20s)
    // because the proxy hadn't bound yet. The wait's only jobs are logging health
    // and nudging a reload for a client that connected mid-cold-start — both fine
    // to do off the boot path.
    let app_health = app.clone();
    let health_port = port;
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut healthy = false;
        while std::time::Instant::now() < deadline {
            if probe_topics_server(health_port, false).await {
                healthy = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        eprintln!("[sidecar] health after wait: {healthy} (:{health_port})");
        // Nudge the webview to reload now that the upstream is live, so a client
        // that connected during the cold start (and cached a failed fetch) re-fetches.
        if healthy {
            let h = app_health.clone();
            let _ = app_health.run_on_main_thread(move || {
                eval_in_main_webview(&h, COLD_START_RELOAD_JS);
            });
        }
    });
}

/// L'UNICO reload SILENZIOSO e INCONDIZIONATO della app: parte senza che nessuno
/// abbia premuto niente, non lascia segno, e ricarica quello che c'è sullo schermo
/// qualunque cosa sia. Ha una sola licenza, ed è la finestra in cui viene sparato:
/// il cold start. L'upstream è appena salito, il client si è collegato mentre il
/// server ancora non rispondeva e ha in cache una fetch fallita — non c'è nessuna
/// sessione viva da buttare via e nessun «hai premuto» da confermare.
///
/// Fuori da quella finestra un reload muto è un difetto, non una feature: lo
/// schermo sbatte, il lavoro sparisce e l'utente conclude «è crashato». Gli altri
/// tre reload del guscio sono di categorie diverse e restano legittimi:
/// `RELOAD_WITH_FLASH_JS` è ANNUNCIATO (⌘R lascia il toast), `RELOAD_IF_BLANK_JS` e
/// la pagina di `reconnect_page_response` sono AUTO-LIMITATI (ricaricano solo un
/// documento che non ha niente da perdere). Un secondo membro di QUESTA categoria
/// non si aggiunge: `reloadFlash.test.ts` conta i siti di reload uno per uno e
/// diventa rosso — se ti serve davvero, cambia la guardia spiegando perché, non il
/// numero.
const COLD_START_RELOAD_JS: &str = "window.location.reload()";

/// JS that reloads the main document ONLY IF it has nothing on screen. Sent by the
/// upstream watchdog after the server comes back: a live app (mounted `#root`) is
/// left alone — it reconnects its own WebSocket and a forced reload would throw away
/// a working session — while an empty document (WebKit error page, our reconnect
/// page, a webview that lost its content) is put back on its feet. Wrapped in
/// try/catch that reloads on failure: if we can't even inspect the DOM, the document
/// is not in a state worth preserving.
const RELOAD_IF_BLANK_JS: &str = "(function(){try{\
var r=document.getElementById('root');\
if(r&&r.childElementCount>0)return;\
location.reload()}catch(e){location.reload()}})()";

/// Run `js` in the MAIN webview. Not `get_webview_window` — once native browser panes
/// are mounted the main window is multi-webview and that lookup returns None (see the
/// `TlWindow` note), which is precisely the state a recovery path must survive.
/// Falls back to the webview-window lookup for the single-webview case.
fn eval_in_main_webview(app: &tauri::AppHandle, js: &str) -> bool {
    use tauri::Manager;
    if let Some(wv) = app.get_webview("main") {
        return wv.eval(js).is_ok();
    }
    if let Some(w) = app.get_webview_window("main") {
        return w.eval(js).is_ok();
    }
    false
}

/// Watch the upstream forever and put the window back when the server returns.
///
/// This is THE recovery path, and it runs in BOTH boot branches — the old
/// `window.location.reload()` lived inside the sidecar branch only, so on a machine
/// with an external launchd server on :3333 (the reported case) production had no
/// recovery at all: the shell `return`ed before ever reaching it.
///
/// Edge-triggered on down→up: we only nudge after having actually SEEN the server
/// down, so a healthy machine never gets a spurious reload. The nudge itself is
/// conservative (see `RELOAD_IF_BLANK_JS`).
async fn watch_upstream(app: tauri::AppHandle) {
    let up = *UPSTREAM
        .get()
        .unwrap_or(&Upstream { port: DEFAULT_UPSTREAM_PORT, tls: true });
    let mut was_down = false;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let alive = probe_topics_server(up.port, up.tls).await;
        if !alive {
            if !was_down {
                eprintln!("[watchdog] upstream :{} is DOWN", up.port);
            }
            was_down = true;
            continue;
        }
        if was_down {
            eprintln!("[watchdog] upstream :{} is back — nudging the webview", up.port);
            was_down = false;
            // Give the server a beat to finish binding its routes before the reload
            // fires, so the nudged navigation doesn't race the very restart it's
            // recovering from.
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !eval_in_main_webview(&app2, RELOAD_IF_BLANK_JS) {
                    eprintln!("[watchdog] no main webview to nudge");
                }
            });
        }
    }
}

/// Kill the sidecar if we spawned one. Called on app exit so no orphan server
/// process survives the shell. Idempotent (the slot is taken).
fn kill_sidecar() {
    if let Ok(mut slot) = SIDECAR_CHILD.lock() {
        if let Some(child) = slot.take() {
            eprintln!("[sidecar] killing on exit");
            let _ = child.kill();
        }
    }
}

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
trait TlWindow {
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
fn apply_traffic_lights<W: TlWindow>(window: &W, visible: bool) {
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
                    // button to LEFT_INSET + i*PITCH to reproduce the native tight
                    // group. LEFT_INSET=12 keeps Electron's trafficLightPosition.x;
                    // PITCH=20 is the standard macOS traffic-light origin spacing
                    // (~14px buttons, ~6px gap).
                    const LEFT_INSET: f64 = 12.0;
                    const PITCH: f64 = 18.0;
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
                        f.origin.y = if flipped {
                            center_from_top - f.size.height / 2.0
                        } else {
                            svb.size.height - center_from_top - f.size.height / 2.0
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
fn apply_traffic_lights<W>(_window: &W, _visible: bool) {}

/// Reveal or hide the window's traffic lights. Driven by the client when the
/// Topics dropdown opens/closes (mirrors Electron's `window:showTrafficLights`).
#[tauri::command]
fn set_traffic_lights(app: tauri::AppHandle, visible: bool) {
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
fn apply_appearance(window: &tauri::WebviewWindow, dark: Option<bool>) {
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
fn set_theme(app: tauri::AppHandle, theme: String) {
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
            for (label, win) in app.webview_windows() {
                if label != "main" && !label.starts_with("detach-") {
                    continue;
                }
                let win2 = win.clone();
                let _ = win.run_on_main_thread(move || apply_appearance(&win2, dark));
            }
            Ok(())
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, theme);
}

/// Reaps detached children so they never linger as zombies.
///
/// `std::process::Child`'s `Drop` deliberately does NOT wait, so every
/// `.spawn()` whose handle is dropped leaves a `<defunct>` entry owned by this
/// process until it exits. That is a slow leak with a steady driver behind it:
/// the notification helper (`macos_notifications::post_via_helper`) fires on
/// every session state change, which measured ~50 zombies/hour on a normal day
/// and had accumulated 285 of them in one 6-hour run. Zombies hold a PID slot
/// each, so the process table fills up machine-wide, not just for Topics.
///
/// A single background thread owns every handed-off child. It blocks on the
/// channel while it has nothing to watch (zero cost at rest) and polls with
/// `try_wait` while it does — never blocking on one long-lived child (a
/// `terminal-notifier` banner lives as long as it is on screen) in a way that
/// would stall the reaping of the others. Deliberately not `SIGCHLD → SIG_IGN`:
/// that is process-global and would break `tauri-plugin-shell`'s sidecar
/// reaper, which waits on its own children.
mod child_reaper {
    use std::process::Child;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    /// How often pending children are polled for exit. Coarse on purpose: these
    /// are fire-and-forget helpers, latency to notice their exit is irrelevant.
    const POLL: Duration = Duration::from_millis(500);

    static REAPER: OnceLock<Mutex<Sender<Child>>> = OnceLock::new();

    /// Hand a spawned child over to be waited on. Non-blocking.
    pub fn reap(child: Child) {
        let tx = REAPER.get_or_init(|| {
            let (tx, rx) = channel::<Child>();
            std::thread::Builder::new()
                .name("child-reaper".into())
                .spawn(move || {
                    let mut pending: Vec<Child> = Vec::new();
                    loop {
                        if pending.is_empty() {
                            // Nothing to watch: sleep on the channel.
                            match rx.recv() {
                                Ok(c) => pending.push(c),
                                // Sender lives in a `static`, so this is
                                // unreachable in practice; exit rather than spin.
                                Err(_) => return,
                            }
                        } else {
                            while let Ok(c) = rx.try_recv() {
                                pending.push(c);
                            }
                            // `Err` means the child was already reaped or is
                            // unwaitable — either way stop tracking it.
                            pending.retain_mut(|c| matches!(c.try_wait(), Ok(None)));
                            if !pending.is_empty() {
                                std::thread::sleep(POLL);
                            }
                        }
                    }
                })
                .expect("spawn child-reaper thread");
            Mutex::new(tx)
        });
        if let Ok(tx) = tx.lock() {
            // Send failure would mean the reaper thread died; dropping the child
            // here is the pre-existing behaviour, not a regression.
            let _ = tx.send(child);
        }
    }
}

#[cfg(target_os = "macos")]
#[path = "macos_notifications.rs"]
mod macos_notifications;

/// Focus / Do-Not-Disturb state, read from the OS so the client can silence its
/// completion banners while the user has a Focus on.
///
/// The web side has NO API for "is the user in DND" — the datum lives only in the
/// native shell. On macOS the active Focus assertion is written to
/// `~/Library/DoNotDisturb/DB/Assertions.json`: a non-empty `storeAssertionRecords`
/// means a Focus/DND is currently asserted. There is no supported public API for
/// this (the private `DoNotDisturb.framework` XPC service refuses non-platform
/// callers on macOS 26, and the file itself is TCC-protected), so this is
/// best-effort: when the file can't be read (no Full Disk Access, missing, parse
/// error) we return `None` = "unknown", and the caller MUST treat unknown as
/// "notify normally" — never silence on a guess.
#[cfg(target_os = "macos")]
mod macos_focus {
    use std::path::PathBuf;

    fn assertions_path() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/DoNotDisturb/DB/Assertions.json"))
    }

    /// Esito della lettura del Focus. I tre casi vanno TENUTI SEPARATI, perché
    /// chiedono all'utente cose diverse — e prima erano un solo `None`.
    ///
    /// `read_to_string(...).ok()?` collassava in «non lo so» sia il permesso TCC
    /// negato sia il file semplicemente inesistente. Il pannello dava sempre la
    /// colpa al permesso e proponeva l'Accesso completo al disco: su un Mac dove
    /// nessuno ha mai impostato un Focus il file NON c'è, e l'app chiedeva il
    /// permesso più invasivo di macOS per una funzione che non aveva niente da
    /// fare.
    pub enum FocusRead {
        /// Letto: `true` = c'è un Focus attivo, `false` = nessuno.
        State(bool),
        /// Non possiamo leggerlo: TCC. È l'unico caso in cui chiedere
        /// l'Accesso completo al disco ha senso.
        Denied,
        /// Nessun file: macOS non l'ha mai scritto perché nessun Focus è mai
        /// stato impostato. Il gate funziona, non c'è niente da silenziare.
        Absent,
    }

    pub fn read_focus() -> FocusRead {
        // HOME assente: non c'è un file da leggere né un permesso da chiedere.
        let Some(path) = assertions_path() else {
            return FocusRead::Absent;
        };
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FocusRead::Absent,
            // Su macOS 26 il diniego TCC su questa cartella arriva come EPERM
            // («Operation not permitted») ⇒ `PermissionDenied`. Gli altri errori
            // di I/O finiscono qui con lui: non sappiamo leggerlo, e l'unica
            // leva che l'utente ha in mano resta il permesso.
            Err(_) => return FocusRead::Denied,
        };
        // Empty file is a legitimate "no focus" state macOS leaves behind.
        if raw.trim().is_empty() {
            return FocusRead::State(false);
        }
        // JSON illeggibile: il file c'è e lo leggiamo, siamo noi a non capirne
        // la forma. Non è un problema di permessi e mandare l'utente nel
        // pannello TCC sarebbe una diagnosi sbagliata; `false` mantiene il
        // default sicuro (non si silenzia mai su un'ipotesi).
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return FocusRead::State(false);
        };
        // Shape: { "data": [ { "storeAssertionRecords": [ {...}, ... ] } ] }
        let records = json
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .and_then(|e| e.get("storeAssertionRecords"));
        match records {
            Some(serde_json::Value::Array(a)) => FocusRead::State(!a.is_empty()),
            // Parsed fine, no records key ⇒ definitely no active assertion.
            _ => FocusRead::State(false),
        }
    }

    /// `(supported, active, reason)` — la forma che va sul filo verso il client.
    /// `supported` risponde a «del gate ci si può fidare?»: vero anche quando il
    /// file non c'è, perché «nessun Focus impostato» è una risposta, non un buco.
    pub fn snapshot() -> (bool, bool, &'static str) {
        match read_focus() {
            FocusRead::State(active) => (true, active, "ok"),
            FocusRead::Absent => (true, false, "absent"),
            FocusRead::Denied => (false, false, "denied"),
        }
    }
}

/// Read the current Focus / Do-Not-Disturb state. Shape is
/// `{ supported: bool, active: bool, reason: "ok" | "denied" | "absent" }`:
/// `supported=false` means the host can't tell and the client falls back to its
/// safe default (notify normally).
///
/// `reason` esiste perché `supported=false` da solo non basta a dire cosa fare.
/// Solo `"denied"` (TCC) è un problema che l'utente può risolvere; `"absent"`
/// (nessun Focus mai impostato) è il gate che funziona e non ha nulla da fare, e
/// merita silenzio, non un avviso. Fuori da macOS `"absent"`: non c'è nessun
/// permesso da concedere, quindi non c'è niente da segnalare. See `macos_focus`.
#[tauri::command]
fn focus_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    let (supported, active, reason) = macos_focus::snapshot();
    #[cfg(not(target_os = "macos"))]
    let (supported, active, reason) = (false, false, "absent");
    serde_json::json!({ "supported": supported, "active": active, "reason": reason })
}

/// Background poller that PUSHES Focus changes to the webview so the completion
/// notifier reacts within a couple of seconds of the user toggling a Focus,
/// instead of only on its next on-demand query. Follows the shell's eval-hook
/// convention (no `@tauri-apps/event` dependency on the client): it calls
/// `window.__topicsFocusChanged(active, supported, reason)`; the client installs
/// that hook and updates its cache. Emits only on a real change, and only while a
/// `main` webview exists. No-op off macOS.
///
/// `reason` viaggia con la spinta, non solo con la query iniziale: il permesso
/// TCC si può concedere a app aperta, e senza il motivo l'interfaccia resterebbe
/// con la diagnosi del boot.
#[cfg(target_os = "macos")]
fn spawn_focus_watcher(app: tauri::AppHandle) {
    use tauri::Manager;
    std::thread::Builder::new()
        .name("focus-watcher".into())
        .spawn(move || {
            // `None` = "not yet sampled": the first read always pushes so the
            // client's optimistic default gets corrected even if Focus is off.
            let mut last: Option<(bool, bool, &'static str)> = None;
            loop {
                let current = macos_focus::snapshot();
                if last != Some(current) {
                    last = Some(current);
                    let (supported, active, reason) = current;
                    let app = app.clone();
                    let _ = app.clone().run_on_main_thread(move || {
                        if let Some(w) = app.get_webview_window("main") {
                            // `reason` è una costante nostra (`ok`/`denied`/
                            // `absent`), mai un dato di fuori: inlinarla fra
                            // apici non apre nessuna superficie d'iniezione.
                            let _ = w.eval(&format!(
                                "window.__topicsFocusChanged && window.__topicsFocusChanged({active}, {supported}, '{reason}');"
                            ));
                        }
                    });
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        })
        .ok();
}

/// Fire a native OS notification (completion / idle toasts). The renderer's web
/// `Notification` API is unreliable in a WKWebView shell, so the client routes
/// through here under Tauri. Fire-and-forget: a denied/failed show is a silent
/// no-op — same observable contract as the web API, never an error to the caller.
/// macOS posts via `macos_notifications` (UserNotifications framework); the
/// plugin/notify-rust path remains for Windows/Linux and un-bundled dev runs.
/// I tasti di un banner, come arrivano dal client. Dichiarato anche fuori da
/// macOS perché è nella firma del comando: gli altri host lo ricevono e lo
/// ignorano, invece di avere una firma diversa per piattaforma (che è come si
/// ottiene un client che invoca un comando inesistente).
#[derive(serde::Deserialize)]
pub struct NotifyActionArg {
    pub id: String,
    pub title: String,
}

/// Fire a native OS notification (completion / idle toasts). The renderer's web
/// `Notification` API is unreliable in a WKWebView shell, so the client routes
/// through here under Tauri. Fire-and-forget: a denied/failed show is a silent
/// no-op — same observable contract as the web API, never an error to the caller.
/// macOS posts via `macos_notifications` (UserNotifications framework); the
/// plugin/notify-rust path remains for Windows/Linux and un-bundled dev runs.
///
/// `actions` sono i TASTI (rispondi alla domanda dell'agente, approva, rimetti
/// in coda). Solo macOS li disegna: il percorso plugin di Windows/Linux non
/// espone azioni, e là un banner resta il link di sempre.
#[tauri::command]
fn notify(
    app: tauri::AppHandle,
    title: String,
    body: String,
    task_id: Option<String>,
    actions: Option<Vec<NotifyActionArg>>,
) {
    #[cfg(target_os = "macos")]
    if macos_notifications::is_bundled() {
        let acts: Vec<macos_notifications::NotifyAction> = actions
            .as_deref()
            .unwrap_or_default()
            .iter()
            // Un tasto senza etichetta o senza id non si disegna: comparirebbe
            // come un bottone vuoto, che è peggio di un tasto in meno.
            .filter(|a| !a.id.trim().is_empty() && !a.title.trim().is_empty())
            .map(|a| macos_notifications::NotifyAction { id: a.id.clone(), title: a.title.clone() })
            .collect();
        macos_notifications::post(&title, &body, task_id.as_deref(), &acts);
        return;
    }
    // Windows/Linux plugin path: no click→task routing yet (the web Notification
    // API covers those hosts); just show the banner.
    let _ = (&task_id, &actions);
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Stato REALE della catena dei banner nativi — sola lettura.
///
/// `notify` è fire-and-forget per contratto: un banner rifiutato è un no-op
/// silenzioso, uguale alla web API. È giusto per il chiamante, ma su macOS la
/// catena ha tre punti di caduta muti in fila (fuori dal bundle / non
/// autorizzati / nessun carrier di ripiego) e il risultato è un pannello
/// Impostazioni che promette "native macOS notification" mentre non ne arriva
/// nessuna. Questo comando NON cambia il comportamento: lo racconta, così la UI
/// può dire la verità invece di una promessa.
///
/// `serde_json::Value` perché la forma è per-piattaforma: su Windows/Linux la
/// catena macOS non esiste e il campo `platform` lo dichiara.
/// `(async)` non è cosmetico: un comando sincrono Tauri lo esegue sul MAIN
/// thread, e `status()` aspetta lì dentro la risposta del demone delle
/// notifiche. Su un thread del pool quell'attesa è innocua; sul main sarebbe
/// un blocco della UI, e se il callback volesse a sua volta la main queue
/// sarebbe uno stallo.
#[tauri::command(async)]
fn notification_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        let s = macos_notifications::status();
        serde_json::json!({
            "platform": "macos",
            "bundled": s.bundled,
            "authorized": s.authorized,
            "authState": s.auth_state,
            "helper": s.helper,
            "logPath": s.log_path,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Il percorso plugin (notify-rust / WinRT toast) non espone uno stato
        // interrogabile: dichiararlo "sconosciuto" è più onesto di inventarlo.
        serde_json::json!({
            "platform": if cfg!(windows) { "windows" } else { "linux" },
            "bundled": true,
            "authorized": true,
            "authState": "unknown",
            "helper": serde_json::Value::Null,
            "logPath": serde_json::Value::Null,
        })
    }
}

/// Hand a URL to the OS default browser, without leaking a zombie.
///
/// Replaces `tauri-plugin-opener`'s `open_url` for the shell's external-link
/// path. That plugin routes to `open::that_detached`, which double-forks in
/// `pre_exec` and then DROPS the `Child` (`open-5.3.5/src/lib.rs:380`): the
/// intermediate child `_exit(0)`s immediately and stays `<defunct>` forever,
/// one zombie per link opened. Same launcher command, but the handle goes to
/// `child_reaper` instead of the floor. The plugin stays registered — the
/// Download menu's `reveal_item_in_dir` / `open_path` still use it.
///
/// Only `http`/`https`/`mailto` are accepted. Without that check this command
/// would be a "run anything" primitive reachable from the webview, since the
/// launchers below hand their argument to the OS to interpret.
fn validate_external_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if ["http://", "https://", "mailto:"]
        .iter()
        .any(|p| lower.starts_with(p))
    {
        Ok(())
    } else {
        Err(format!("unsupported URL scheme: {url}"))
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    validate_external_url(&url)?;

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("/usr/bin/open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // `start` is a cmd builtin, not an executable. The empty "" is the
        // window title it would otherwise eat the URL as.
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };

    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child_reaper::reap(child);
    Ok(())
}

/// Write a PNG image to the system clipboard natively via `NSPasteboard`.
///
/// Replaces the server-side `osascript 'set the clipboard to (read … as
/// «class PNGf»)'` path used by terminal image-paste, which was firing a macOS
/// "control iTunes/Music" Automation prompt. This sends no Apple Events — it
/// talks to AppKit's pasteboard directly — so the prompt is gone. The client
/// calls this under Tauri; the plain web build uses `navigator.clipboard`.
#[tauri::command]
fn set_clipboard_image(bytes: Vec<u8>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::{class, msg_send, runtime::AnyObject};
        use objc2_foundation::{NSData, NSString};
        if bytes.is_empty() {
            return Err("empty image".into());
        }
        unsafe {
            let data = NSData::with_bytes(&bytes);
            let ty = NSString::from_str("public.png");
            let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
            if pb.is_null() {
                return Err("no general pasteboard".into());
            }
            let _: () = msg_send![pb, clearContents];
            let ok: bool = msg_send![pb, setData: &*data, forType: &*ty];
            if !ok {
                return Err("NSPasteboard setData failed".into());
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bytes;
        Err("clipboard image write is macOS-only".into())
    }
}

/// One attention row for the dynamic tray menu: a chat topic needing the user,
/// clickable to jump straight to it (Electron parity: the tray listed unread
/// topics that navigate on click).
#[derive(Deserialize)]
struct StatusItem {
    id: String,
    title: String,
    /// Board the row comes from. Empty for a chat row (topics have no board);
    /// on a task row it is what tells two same-named cards apart.
    #[serde(default, rename = "projectId")]
    project_id: String,
}

/// One board column in the tray menu: a status, how many tasks it holds and the
/// first rows, which become a submenu. WHAT goes in — which statuses, in what
/// order, how many rows, how a long title is cut — is decided and unit-tested in
/// `shared/tray-board.ts`; this side only draws it. `count` is the WHOLE column,
/// `rows` the ones that fit: the difference is what the submenu declares as
/// "altri N", instead of letting them vanish.
#[derive(Deserialize)]
struct StatusGroup {
    /// Kanban status id: picks the label and builds the row id that reopens the board.
    status: String,
    count: u32,
    rows: Vec<StatusItem>,
}

/// Come si chiama una colonna nel menu. Le stesse parole delle colonne della
/// kanban (`STATUS_LABEL`): la tray non introduce un secondo vocabolario per le
/// stesse cose. Uno stato che il guscio non conosce si scrive com'è arrivato,
/// che è meglio di una riga muta se un giorno ne nasce un altro.
#[cfg(target_os = "macos")]
fn tray_status_label(status: &str) -> &str {
    match status {
        "review" => "Review",
        "in_progress" => "In Progress",
        "todo" => "Todo",
        "backlog" => "Backlog",
        "done" => "Done",
        other => other,
    }
}

/// UNA riga di tray, UNA porta: mostra la finestra e consegna l'intenzione al
/// client come DOM CustomEvent. Una tray che facesse le cose da sola (aprire una
/// pane, cambiare stato) avrebbe una seconda copia delle regole della app in
/// Rust; qui la tray dice solo COSA, il client sa COME — ed è la stessa via che
/// il menu nativo e il forwarder delle scorciatoie usano già.
///
/// Ogni riga porta prima la finestra a galla: la tray si usa proprio quando la
/// app è nascosta, e un evento consegnato a una finestra invisibile aprirebbe
/// una cosa che nessuno vede.
fn tray_dispatch(app: &tauri::AppHandle, event: &str, detail: Option<(&str, &str)>) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else { return };
    ensure_window_visible(&w);
    // Il valore passa da `serde_json` e non da un `format!`: un titolo o un id
    // con un apice romperebbe (o peggio: allargherebbe) il JS che valutiamo.
    let body = match detail {
        Some((key, value)) => format!(
            "{{detail:{{{key}:{}}}}}",
            serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
        ),
        None => String::new(),
    };
    let js = format!("window.dispatchEvent(new CustomEvent('{event}'{}))",
        if body.is_empty() { String::new() } else { format!(",{body}") });
    let _ = w.eval(&js);
}

/// Il nome leggibile dentro l'id di un progetto: gli id nascono `<nome>-<hash>`
/// e in un menu la coda esadecimale è rumore. Si toglie SOLO se ha la forma di
/// un suffisso generato (corto e alfanumerico), così un progetto che si chiama
/// davvero "topics-2" non perde un pezzo di nome.
#[cfg(target_os = "macos")]
fn project_slug(project_id: &str) -> &str {
    match project_id.rsplit_once('-') {
        Some((name, tail))
            if !name.is_empty()
                && (4..=8).contains(&tail.len())
                && tail.chars().all(|c| c.is_ascii_alphanumeric())
                && tail.chars().any(|c| c.is_ascii_digit()) =>
        {
            name
        }
        _ => project_id,
    }
}

/// Trim a menu label so the tray stays a menu and not an inventory. An empty
/// title still gets a row: a task with no text is a task, and a blank line in a
/// menu is unclickable-looking. Solo macOS: è il menu dinamico che la usa, e
/// altrove sarebbe una funzione senza chiamanti (cioè un warning).
#[cfg(target_os = "macos")]
fn tray_label(title: &str) -> String {
    if title.chars().count() > 48 {
        format!("{}…", title.chars().take(47).collect::<String>())
    } else if title.is_empty() {
        "(senza titolo)".to_string()
    } else {
        title.to_string()
    }
}

/// Reflect the app-wide attention total on the dock-icon badge, the macOS
/// menu-bar tray glyph, AND the tray menu (Electron parity: its tray is dynamic —
/// dock `setBadgeCount` + `set_title` + a click-to-navigate unread list).
/// `count` = the number of things needing the user right now (unread chats +
/// Claude-awaiting + finished agent turns + agent escalations); `items` = the top
/// attention chats (id + title) rendered as clickable menu rows. Both are computed
/// centrally by the client from the SAME signals the in-app tab badges read (see
/// `useTabNotifications`), so the OS chrome can never drift from what's on screen.
/// `groups` = the board's open work per status (`shared/tray-board.ts`), rendered as
/// one submenu per column. 0/empty clears the badge/glyph and leaves the static rows.
/// No-op off macOS (no dock; a Win/Linux taskbar badge can follow later).
#[tauri::command]
fn set_app_status(
    app: tauri::AppHandle,
    count: u32,
    items: Vec<StatusItem>,
    groups: Option<Vec<StatusGroup>>,
) {
    #[cfg(target_os = "macos")]
    // no_abort: run_on_main_thread + tray/menu mutations go through the
    // window dispatcher — same poisoned-mutex SIGABRT class (see no_abort
    // doc). Fires on every attention-status change.
    let _ = no_abort("set_app_status", || {
        use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
        use tauri::Manager;
        let groups = groups.unwrap_or_default();
        // The dock-tile badge is an AppKit UI mutation — must run on the main thread.
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.run_on_main_thread(move || set_dock_badge(count));
        }
        // Menu-bar tray: glyph + tooltip + the clickable attention rows.
        // Retrieved by the id assigned at build time (`TrayIconBuilder::with_id`).
        if let Some(tray) = app.tray_by_id("main") {
            // Rebuild the menu: one `nav:<topicId>` row per attention chat, then a
            // separator, then the static Show/Quit. The tray's `on_menu_event`
            // (installed at build) routes `nav:` clicks — it fires for whatever
            // menu is currently set, so dynamically-swapped rows still navigate.
            let mut mb = MenuBuilder::new(&app);
            for it in &items {
                mb = mb.text(format!("nav:{}", it.id), tray_label(&it.title));
            }
            if !items.is_empty() {
                mb = mb.separator();
            }
            // IL LAVORO, non solo le chat. Un sottomenu per stato («Review (3)»)
            // con le prime righe di quella colonna: da app nascosta la tray è
            // l'unica superficie che resta, e finora sapeva dire soltanto chi
            // aspetta una risposta in chat — della board, niente. Le righe
            // aprono il task (`task:`), la testa della sezione apre la board.
            if !groups.is_empty() {
                let open: u32 = groups.iter().map(|g| g.count).sum();
                mb = mb.text("board:open", format!("Board ({open} aperti)"));
                for g in &groups {
                    let mut sb = SubmenuBuilder::new(
                        &app,
                        format!("{} ({})", tray_status_label(&g.status), g.count),
                    );
                    for it in &g.rows {
                        // DUE CARD OMONIME su board diverse capitano ("Fix build"
                        // esiste ovunque), ed è la ragione per cui la riga porta
                        // anche il progetto. In un menu due righe identiche non
                        // sono due righe: sono una che sembra disegnata due volte.
                        // Il progetto compare quindi SOLO quando serve a
                        // distinguere, non su ogni riga: un menu in cui ogni voce
                        // ripete la stessa parentesi si legge peggio.
                        let ambigua = g.rows.iter().filter(|o| o.title == it.title).count() > 1;
                        let label = if ambigua && !it.project_id.is_empty() {
                            format!("{} ({})", tray_label(&it.title), project_slug(&it.project_id))
                        } else {
                            tray_label(&it.title)
                        };
                        sb = sb.text(format!("task:{}", it.id), label);
                    }
                    // Il resto si DICHIARA invece di sparire: una riga spenta,
                    // che non promette un click che non c'è. `count` è la colonna
                    // intera, `rows` quelle che ci stanno: la differenza è ciò che
                    // il menu non sta elencando.
                    let more = g.count.saturating_sub(g.rows.len() as u32);
                    if more > 0 {
                        if let Ok(rest) = MenuItemBuilder::with_id(
                            format!("board-more:{}", g.status),
                            format!("altri {more}…"),
                        )
                        .enabled(false)
                        .build(&app)
                        {
                            sb = sb.item(&rest);
                        }
                    }
                    sb = sb
                        .separator()
                        .text(format!("board:{}", g.status), "Apri la board");
                    if let Ok(sub) = sb.build() {
                        mb = mb.item(&sub);
                    }
                }
                mb = mb.separator();
            }
            // Le azioni che il menu si era perso per strada: la app è cresciuta
            // (chat, board, aggiornatore) e la tray era rimasta a Mostra/Esci,
            // cioè non sapeva far FARE niente. Sono le stesse porte del menu
            // nativo e della sidebar, non gesti nuovi.
            mb = mb
                .text("tray-new-chat", "Nuova chat")
                .text("tray-check-updates", "Controlla aggiornamenti")
                .separator()
                .text("tray-show", "Mostra Topics")
                .text("tray-quit", "Esci");
            if let Ok(menu) = mb.build() {
                let _ = tray.set_menu(Some(menu));
            }

            let title = if count > 0 { Some(count.to_string()) } else { None };
            let tip = if count > 0 {
                format!("Topics — {count} in attesa")
            } else {
                "Topics".to_string()
            };
            let _ = tray.set_title(title);
            let _ = tray.set_tooltip(Some(tip));
        }
        Ok(())
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (app, count, items, groups);
}

/// Set (or clear, when 0) the macOS dock-icon badge label via the shared
/// `NSApplication` dock tile. AppKit UI call — the caller runs it on the main
/// thread. Electron's `app.dock.setBadge` equivalent.
#[cfg(target_os = "macos")]
fn set_dock_badge(count: u32) {
    use crate::mac::*;
    unsafe {
        let ns_app: id = msg_send![class!(NSApplication), sharedApplication];
        let tile: id = msg_send![ns_app, dockTile];
        if count == 0 {
            let _: () = msg_send![tile, setBadgeLabel: nil];
        } else {
            let label_ns = nsstring(&count.to_string());
            let label: id = objc2::rc::Retained::as_ptr(&label_ns) as id;
            let _: () = msg_send![tile, setBadgeLabel: label];
        }
    }
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
fn aot_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("topics-aot.json"))
}

/// Read the persisted always-on-top flag (default false).
fn read_aot(app: &tauri::AppHandle) -> bool {
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
struct VibRegion {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    radius: f64,
}

/// Per-window frost views, keyed by NSWindow pointer → (region id → NSView ptr).
/// MUST be keyed per window: a detached (pop-out) window mounts the same App and
/// pushes the SAME region ids (r0, r1, …), so a single global id→view map made the
/// detached window's push move/remove the MAIN window's frost views (the "pop-out
/// nukes the main frost" bug). The NSWindow pointer scopes each window's views to
/// its own contentView; `window_detach` purges a window's entry on Destroyed so a
/// reused pointer address can't inherit freed view pointers.
#[cfg(target_os = "macos")]
fn vibrancy_views() -> &'static std::sync::Mutex<std::collections::HashMap<usize, std::collections::HashMap<String, usize>>> {
    static V: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<usize, std::collections::HashMap<String, usize>>>> =
        std::sync::OnceLock::new();
    V.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Full-window frost shown DURING a window-edge resize, keyed per NSWindow pointer
/// (absent/0 = none). Per-window for the same reason as `vibrancy_views`: each
/// window's live-resize cover is independent. See `vibrancy_resize_cover`.
#[cfg(target_os = "macos")]
fn vibrancy_cover_slot() -> &'static std::sync::Mutex<std::collections::HashMap<usize, usize>> {
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
fn region_vibrancy_class() -> &'static objc2::runtime::AnyClass {
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
fn apply_vibrancy_regions(window: &tauri::Window, regions: Vec<VibRegion>) {
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
unsafe fn ca_timing_for(timing: [f64; 4]) -> *mut objc2::runtime::AnyObject {
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
fn apply_vibrancy_animation(window: &tauri::Window, regions: Vec<VibRegion>, duration_ms: f64, timing: [f64; 4]) {
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
fn vibrancy_animate_regions(window: tauri::Window, regions: Vec<VibRegion>, duration_ms: f64, timing: [f64; 4]) {
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
unsafe fn vibrancy_insert_cover(content_view: *mut objc2::runtime::AnyObject, bounds: objc2_foundation::NSRect) -> *mut objc2::runtime::AnyObject {
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
fn vibrancy_resize_cover(window: &tauri::WebviewWindow) {
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
unsafe fn vibrancy_begin_cover(ns_window: *mut objc2::runtime::AnyObject) {
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
fn live_resize_observer_instance() -> *mut objc2::runtime::AnyObject {
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
fn live_resize_observers() -> &'static std::sync::Mutex<std::collections::HashMap<usize, usize>> {
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
fn wire_live_resize_cover(window: &tauri::WebviewWindow) {
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
fn unwire_live_resize_cover(wkey: usize) {
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
static SHELL_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Does `rect` (logical points, top-left origin) overlap ANY currently-attached
/// monitor? Pure geometry so it can be unit-tested without a screen: `monitors` is
/// the list of monitor rects in the same space. A window that overlaps nothing is
/// stranded on a display that no longer exists — the classic "the app is running but
/// I can't see it" after unplugging the ultrawide.
fn rect_intersects_any(rect: (f64, f64, f64, f64), monitors: &[(f64, f64, f64, f64)]) -> bool {
    let (x, y, w, h) = rect;
    monitors.iter().any(|&(mx, my, mw, mh)| {
        x < mx + mw && mx < x + w && y < my + mh && my < y + h
    })
}

/// Re-anchor + bounce the main window so the compositor is forced to produce a frame.
///
/// Re-anchor: if the saved geometry now sits entirely off every attached screen, pull
/// the window back onto the primary one. We do NOT touch a window that is still on a
/// screen — `-797,-1410` is where Attilio KEEPS this window on his ultrawide, and
/// "fixing" a position the user chose is the bug, not the cure.
///
/// Bounce: grow the outer size by 1px and put it back a beat later. That is the half
/// that was missing, and it's the half that actually repaints.
fn recompose_main_window(app: &tauri::AppHandle, why: &str) {
    use tauri::Manager;
    let Some(win) = app.get_window("main") else { return };
    if !win.is_visible().unwrap_or(true) || win.is_minimized().unwrap_or(false) {
        return; // hidden to tray / minimised: nothing to recompose, and a bounce
                // would be a visible glitch when it comes back.
    }
    // Read the geometry off the plain `Window` (not `window_logical_geometry`, which
    // takes a WebviewWindow — a lookup that returns None once browser panes are up).
    let Ok(sf) = win.scale_factor() else { return };
    let Ok(pos) = win.outer_position() else { return };
    let Ok(size) = win.outer_size() else { return };
    let pos = pos.to_logical::<f64>(sf);
    let size = size.to_logical::<f64>(sf);
    let (x, y, w, h) = (pos.x, pos.y, size.width, size.height);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let monitors: Vec<(f64, f64, f64, f64)> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            let p = m.position().to_logical::<f64>(sf);
            let s = m.size().to_logical::<f64>(sf);
            (p.x, p.y, s.width, s.height)
        })
        .collect();
    if !monitors.is_empty() && !rect_intersects_any((x, y, w, h), &monitors) {
        let (mx, my, _, _) = monitors[0];
        eprintln!("[recompose] {why}: window off every screen — re-anchoring to {mx},{my}");
        let _ = win.set_position(tauri::LogicalPosition::new(mx + 30.0, my + 80.0));
    }
    eprintln!("[recompose] {why}: bouncing bounds to force a redraw");
    let _ = win.set_size(tauri::LogicalSize::new(w + 1.0, h));
    let app2 = app.clone();
    let (bw, bh) = (w, h);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            use tauri::Manager;
            if let Some(w2) = app3.get_window("main") {
                let _ = w2.set_size(tauri::LogicalSize::new(bw, bh));
            }
            // A window that came back from a dead display can also have lost its
            // document; same conservative nudge the watchdog uses.
            eval_in_main_webview(&app3, RELOAD_IF_BLANK_JS);
        });
    });
}

/// `NSApplicationDidChangeScreenParameters` / `NSWorkspaceDidWake` callback.
#[cfg(target_os = "macos")]
extern "C" fn on_recompose_event(
    _this: &objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    _notif: *mut objc2::runtime::AnyObject,
) {
    if let Some(app) = SHELL_APP.get() {
        recompose_main_window(app, "display/wake");
    }
}

/// Register the display-change and wake observers. Called ONCE from setup — the
/// grep that found "zero listeners for display change, sleep or wake" was pointing
/// at the absence of exactly this function.
#[cfg(target_os = "macos")]
fn wire_recompose_observers() {
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

/// Prefisso di ogni etichetta di pane browser. Distintivo apposta: non deve
/// collidere con la webview della UI ("main") né con nessuna etichetta di
/// finestra presente o futura.
const BROWSER_LABEL_PREFIX: &str = "browserpane-";

/// Pane la cui etichetta è BRUCIATA: id → generazione (assente = 0).
///
/// Una WKWebView il cui dispatcher ha il mutex avvelenato non si può più
/// chiudere — `Webview::close()` passa dallo stesso `window_id.lock().unwrap()`
/// di tutto il resto e panica. La vista resta quindi REGISTRATA nel manager di
/// tauri, e `browser_open` sullo stesso id ci ricadeva sopra col suo ramo di
/// riuso: «Ricrea la scheda» riconsegnava la stessa vista morta, cioè non
/// ricreava niente proprio nel caso per cui il pulsante esiste.
///
/// L'etichetta è l'unica cosa che si può cambiare: bruciata quella, la pane
/// conserva il suo id (che è come la chiamano il client, gli agenti e ogni
/// cache) e la prossima apertura nasce sotto un'etichetta nuova, quindi come
/// webview NUOVA. La vecchia resta appesa al manager finché la finestra non
/// muore: è già irrecuperabile, e non poterla nemmeno spostare è la ragione per
/// cui non la si può salvare, non un effetto di questa scelta.
static BURNED_PANE_LABELS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, u32>>,
> = std::sync::OnceLock::new();
fn burned_pane_labels() -> &'static std::sync::Mutex<std::collections::HashMap<String, u32>> {
    BURNED_PANE_LABELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Generazione corrente dell'etichetta di una pane. 0 = mai bruciata.
fn pane_label_generation(id: &str) -> u32 {
    let m = burned_pane_labels().lock().unwrap_or_else(|e| e.into_inner());
    m.get(id).copied().unwrap_or(0)
}

/// Brucia l'etichetta corrente di una pane e restituisce la generazione nuova.
/// Da qui in poi `browser_label(id)` indica un'etichetta LIBERA, quindi
/// `browser_open` crea invece di riusare.
fn burn_pane_label(id: &str) -> u32 {
    let mut m = burned_pane_labels().lock().unwrap_or_else(|e| e.into_inner());
    let next = m.get(id).copied().unwrap_or(0).saturating_add(1);
    m.insert(id.to_string(), next);
    next
}

/// Per-pane webview label. Keep the prefix distinctive so it never collides with
/// the main UI webview ("main") or any future window label.
///
/// La generazione va in TESTA all'id e dentro il prefisso (`browserpane-~2~<id>`)
/// per due motivi: `browser_list` filtra per prefisso, che così continua a
/// vedere anche le pane rigenerate; e `~` non compare negli id (uuid/contextId),
/// quindi l'inverso `pane_id_from_label` resta senza ambiguità.
fn browser_label(id: &str) -> String {
    match pane_label_generation(id) {
        0 => format!("{BROWSER_LABEL_PREFIX}{id}"),
        gen => format!("{BROWSER_LABEL_PREFIX}~{gen}~{id}"),
    }
}

/// Inverso di `browser_label`: dall'etichetta all'id della pane. `None` se
/// l'etichetta non è di una pane browser.
fn pane_id_from_label(label: &str) -> Option<&str> {
    let rest = label.strip_prefix(BROWSER_LABEL_PREFIX)?;
    let Some(after) = rest.strip_prefix('~') else {
        return Some(rest);
    };
    // `~<gen>~<id>` — se il secondo `~` manca, l'etichetta non è nostra da
    // interpretare: meglio restituire il resto così com'è che inventare un id.
    match after.split_once('~') {
        Some((gen, id)) if !gen.is_empty() && gen.chars().all(|c| c.is_ascii_digit()) => Some(id),
        _ => Some(rest),
    }
}

// ── Downloads ────────────────────────────────────────────────────────────────
// wry exposes WKWebView's download delegate via WebviewBuilder::on_download, but
// gives only Requested + Finished (no progress, and on macOS the final path is
// empty). The save path is the one wry proposes (system Downloads folder +
// suggested filename + `(n)` on collision) — see the comment on Requested for why
// rewriting it broke downloads outright. We queue start/done events the client
// drains (browser_take_download_events) to drive the toolbar's Download menu —
// a start spinner then a done check, no %.
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
    // Pane this download belongs to. The queue is a single GLOBAL Vec shared by
    // every open browser webview, so draining it whole (the old behaviour) let
    // whichever pane's Download menu happened to poll first steal every other pane's
    // events. Internal bookkeeping only — not serialized to the client, which
    // already scoped its poll by passing its own contextId.
    #[serde(skip)]
    pane_id: String,
}

static DOWNLOAD_EVENTS: std::sync::Mutex<Vec<DownloadEventMsg>> = std::sync::Mutex::new(Vec::new());
static DOWNLOAD_PENDING: std::sync::Mutex<Vec<(String, i64, String, String, String)>> = std::sync::Mutex::new(Vec::new()); // (url, id, savedPath, paneId, filename)
static DOWNLOAD_ID: AtomicI64 = AtomicI64::new(1);

/// Drain queued download start/done events for `id`'s Download menu to apply.
/// Scoped to that pane — other panes' events stay queued for their own poll.
#[tauri::command]
fn browser_take_download_events(id: String) -> Vec<DownloadEventMsg> {
    match DOWNLOAD_EVENTS.lock() {
        Ok(mut v) => {
            let (mine, rest): (Vec<_>, Vec<_>) = v.drain(..).partition(|e| e.pane_id == id);
            *v = rest;
            mine
        }
        Err(_) => Vec::new(),
    }
}

/// Live byte counts for this pane's in-flight downloads, so the Download menu can
/// show progress instead of an indeterminate spinner until the file lands.
///
/// wry surfaces Requested and Finished and NOTHING in between: no progress
/// callback, no total. What Requested does give us is the destination path, and
/// WKDownload writes to that path progressively, so the file's own size on disk
/// is the received byte count. No second request to the server, which is what
/// rules out the obvious alternative of a HEAD to read Content-Length: a download
/// URL is often single-use or non-idempotent, and asking twice can spend it.
///
/// The total is the hard half, and this is the honest state of it. WebKit knows
/// `expectedContentLength` but never hands it to wry's callback, so we try to
/// read it back off the FILE: macOS tags a file being downloaded with the
/// `com.apple.progress.fractionCompleted` extended attribute (the one Finder's
/// progress pie is drawn from), and received / fraction recovers the total.
/// That attribute is OPPORTUNISTIC — it is not part of any WKDownload contract.
/// When it is missing (chunked response, non-macOS, a WebKit that stops writing
/// it) `total` stays -1 and the client shows transferred bytes. A made-up
/// percentage would be worse than no percentage.
#[derive(Clone, Serialize)]
struct DownloadProgressMsg {
    id: String,
    received: i64,
    total: i64,
}

#[tauri::command]
fn browser_download_progress(id: String) -> Vec<DownloadProgressMsg> {
    // Copy out under the lock, then stat: a filesystem call per pending download
    // must not be made while holding a mutex the download callbacks also take.
    let pending: Vec<(i64, String)> = match DOWNLOAD_PENDING.lock() {
        Ok(p) => p
            .iter()
            .filter(|(_, _, _, pane, _)| *pane == id)
            .map(|(_, did, saved, _, _)| (*did, saved.clone()))
            .collect(),
        Err(_) => return Vec::new(),
    };
    pending
        .into_iter()
        .map(|(did, saved)| {
            let received = std::fs::metadata(&saved).map(|m| m.len() as i64).unwrap_or(-1);
            DownloadProgressMsg {
                id: did.to_string(),
                received,
                total: download_total_bytes(&saved, received),
            }
        })
        .collect()
}

/// Total size of the download at `path`, or -1 when it cannot be known without
/// asking the server again. See browser_download_progress for why we do not ask.
fn download_total_bytes(path: &str, received: i64) -> i64 {
    #[cfg(target_os = "macos")]
    if received > 0 {
        if let Some(f) = progress_fraction_xattr(path) {
            // 1.0 or beyond means the write finished, so what is on disk IS the
            // total; at or below 0 the attribute carries no information at all
            // and dividing by it would invent a number.
            if f >= 1.0 {
                return received;
            }
            if f > 0.0 {
                return (received as f64 / f).round() as i64;
            }
        }
    }
    let _ = (path, received);
    -1
}

/// Read `com.apple.progress.fractionCompleted` off `path` as a raw double.
/// None when the attribute is absent or is not the 8 bytes we expect, which is
/// the case this must fail cleanly in: the attribute is a Finder convention, not
/// a guarantee, so an unexpected payload means "unknown", never a guess.
#[cfg(target_os = "macos")]
fn progress_fraction_xattr(path: &str) -> Option<f64> {
    use std::ffi::CString;
    extern "C" {
        fn getxattr(
            path: *const std::os::raw::c_char,
            name: *const std::os::raw::c_char,
            value: *mut std::ffi::c_void,
            size: usize,
            position: u32,
            options: std::os::raw::c_int,
        ) -> isize;
    }
    let p = CString::new(path).ok()?;
    let name = CString::new("com.apple.progress.fractionCompleted").ok()?;
    let mut buf = [0u8; 8];
    let got = unsafe {
        getxattr(
            p.as_ptr(),
            name.as_ptr(),
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            buf.len(),
            0,
            0,
        )
    };
    if got != 8 {
        return None;
    }
    let f = f64::from_le_bytes(buf);
    if f.is_finite() {
        Some(f)
    } else {
        None
    }
}

// ── Navigation failures ──────────────────────────────────────────────────────
// wry 0.55 bridges no WKNavigationDelegate failure callback (its delegate class
// implements decidePolicy/didCommit/didFinish only), so a failed load left the
// pane silently on the previous page: nav "success" was a blind 700ms spinner
// client-side. We add `webView:didFailProvisionalNavigation:withError:` and
// `webView:didFailNavigation:withError:` to wry's delegate CLASS at runtime —
// class_addMethod, no swizzle needed since the selectors are verified absent —
// and queue the failures per pane, drained by the client's state poll exactly
// like the download queue above.
#[derive(Clone, Serialize)]
struct NavErrorMsg {
    url: String,
    description: String,
    code: i64,
    // Pane this failure belongs to — internal scoping only, like DownloadEventMsg.
    #[serde(skip)]
    pane_id: String,
}

static NAV_ERROR_EVENTS: std::sync::Mutex<Vec<NavErrorMsg>> = std::sync::Mutex::new(Vec::new());

/// Codice nostro per «la navigazione l'abbiamo rifiutata noi», che non esiste
/// fra quelli di Cocoa: NSURLErrorDomain vive fra -998 e -1200, WebKitErrorDomain
/// fra 100 e 204, quindi questo non collide con nessuno dei due e il client può
/// riconoscerlo senza leggere stringhe. Il gemello lato client sta in
/// `client/src/components/Browser/navErrorMessage.ts`.
const NAV_ERR_SCHEME_REFUSED: i64 = -7001;

/// WKWebView pointer → pane id. The navigation delegate CLASS is shared by every
/// wry webview (main UI included), so the failure IMP must scope events to the
/// browser panes it knows; unmapped pointers are silently ignored.
#[cfg(target_os = "macos")]
fn nav_pane_by_webview() -> &'static std::sync::Mutex<std::collections::HashMap<usize, String>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<usize, String>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg(target_os = "macos")]
extern "C" fn nav_did_fail_imp(
    _this: &objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    webview: *mut objc2::runtime::AnyObject,
    _navigation: *mut objc2::runtime::AnyObject,
    error: *mut objc2::runtime::AnyObject,
) {
    nav_record_failure(webview, error);
}

/// Shared body for both did-fail selectors: filter the benign codes every real
/// browser suppresses, then queue the failure for the owning pane's poll.
#[cfg(target_os = "macos")]
fn nav_record_failure(webview: *mut objc2::runtime::AnyObject, error: *mut objc2::runtime::AnyObject) {
    use crate::mac::*;
    let pane_id = match nav_pane_by_webview().lock() {
        Ok(g) => match g.get(&(webview as usize)) {
            Some(p) => p.clone(),
            None => return, // main UI webview / unknown — not ours
        },
        Err(_) => return,
    };
    unsafe {
        if error == nil {
            return;
        }
        let domain = ns_string_to_rust(msg_send![error, domain]);
        let code: i64 = msg_send![error, code];
        // NSURLErrorDomain -999 = cancelled (a newer navigation superseded this
        // one — fired on every rapid re-navigate); WebKitErrorDomain 102 = frame
        // load interrupted (a download took the navigation over); 204 = plugin
        // will handle load. None of these is a user-facing failure.
        if domain == "NSURLErrorDomain" && code == -999 {
            return;
        }
        if domain == "WebKitErrorDomain" && (code == 102 || code == 204) {
            return;
        }
        let description = ns_string_to_rust(msg_send![error, localizedDescription]);
        let user_info: id = msg_send![error, userInfo];
        let mut url = String::new();
        if user_info != nil {
            let key_ns = nsstring("NSErrorFailingURLStringKey");
            let key: id = objc2::rc::Retained::as_ptr(&key_ns) as id;
            let val: id = msg_send![user_info, objectForKey: key];
            if val != nil {
                url = ns_string_to_rust(val);
            }
        }
        if let Ok(mut v) = NAV_ERROR_EVENTS.lock() {
            // Bounded like DOWNLOAD_EVENTS: an unobserved pane must not leak.
            if v.len() >= 64 {
                let overflow = v.len() - 63;
                v.drain(0..overflow);
            }
            v.push(NavErrorMsg { url, description, code, pane_id });
        }
    }
}

/// Register this pane's WKWebView in the pointer→pane map and, once per process,
/// add the two did-fail methods to wry's shared navigation-delegate class.
#[cfg(target_os = "macos")]
fn install_nav_failure_hook(wv: &tauri::Webview, pane_id: &str) {
    let pane = pane_id.to_string();
    let _ = wv.with_webview(move |platform| unsafe {
        use crate::mac::*;
        // Raw Objective-C runtime call to graft two methods onto wry's existing
        // navigation-delegate class. objc2 only exposes method-adding on its
        // `ClassBuilder` (for NEW classes); for an EXISTING class we bind the
        // libobjc symbol directly — it is always linked by the objc2 stack.
        extern "C" {
            fn class_addMethod(
                cls: *mut objc2::runtime::AnyClass,
                name: objc2::runtime::Sel,
                imp: *const std::ffi::c_void,
                types: *const std::os::raw::c_char,
            ) -> objc2::runtime::Bool;
        }
        let wk = platform.inner() as id;
        if wk == nil {
            return;
        }
        if let Ok(mut g) = nav_pane_by_webview().lock() {
            g.insert(wk as usize, pane.clone());
        }
        let delegate: id = msg_send![wk, navigationDelegate];
        if delegate == nil {
            return;
        }
        static INSTALL: std::sync::Once = std::sync::Once::new();
        INSTALL.call_once(|| {
            // If a future wry ever implements these selectors itself, adding
            // would need a swizzle instead — skip and keep wry's behaviour
            // rather than fight it (the client then simply sees no nav errors,
            // the pre-existing state).
            let responds: BOOL = msg_send![
                delegate,
                respondsToSelector: sel!(webView:didFailProvisionalNavigation:withError:)
            ];
            if responds != NO {
                return;
            }
            let cls: &Class = msg_send![delegate, class];
            let imp: extern "C" fn(&Object, Sel, id, id, id) = nav_did_fail_imp;
            let types = std::ffi::CString::new("v@:@@@").expect("static types str");
            let cls_ptr = cls as *const Class as *mut Class;
            class_addMethod(
                cls_ptr,
                sel!(webView:didFailProvisionalNavigation:withError:),
                std::mem::transmute(imp),
                types.as_ptr(),
            );
            class_addMethod(
                cls_ptr,
                sel!(webView:didFailNavigation:withError:),
                std::mem::transmute(imp),
                types.as_ptr(),
            );
        });
    });
}

/// Drain queued navigation failures for `id`'s pane — same scoped-drain contract
/// as browser_take_download_events. Non-macOS builds have no hook installed, so
/// the queue is simply always empty there.
#[tauri::command]
fn browser_take_nav_errors(id: String) -> Vec<NavErrorMsg> {
    match NAV_ERROR_EVENTS.lock() {
        Ok(mut v) => {
            let (mine, rest): (Vec<_>, Vec<_>) = v.drain(..).partition(|e| e.pane_id == id);
            *v = rest;
            mine
        }
        Err(_) => Vec::new(),
    }
}

// ── Navigation state, straight from WebKit ───────────────────────────────────
// url/title/loading used to come from a JS eval every 800ms. That reads the
// PAGE, so it only ever worked on a page willing to answer: a hung host, a
// document mid-swap or a load that never committed left the toolbar showing the
// previous URL with a spinner that kept turning. It also lied about timing,
// because the poll saw a navigation up to 800ms after it happened.
//
// WKWebView already publishes all three as KVO-observable properties, so we
// observe `URL`, `title` and `loading` and let WebKit tell us. Same queue and
// scoped-drain contract as NAV_ERROR_EVENTS above, with one difference: this is
// STATE, not a log of events, so the queue keeps at most ONE entry per pane (the
// latest). A page that fires twenty KVO notifications during a load must not
// hand the client twenty stale drains to replay.
#[derive(Clone, Serialize)]
struct NavStateMsg {
    url: String,
    title: String,
    loading: bool,
    // Pane this state belongs to — internal scoping only, like NavErrorMsg.
    #[serde(skip)]
    pane_id: String,
}

static NAV_STATE_EVENTS: std::sync::Mutex<Vec<NavStateMsg>> = std::sync::Mutex::new(Vec::new());

/// The shared observer instance, as a raw pointer. Teardown needs to reach the
/// exact object that registered, and it is the same one for every pane.
#[cfg(target_os = "macos")]
static NAV_STATE_OBSERVER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// KVO callback for all three key paths. WebKit tells us WHICH key changed, but
/// we ignore it and re-read the whole triple off the webview: the three change
/// together during a load, and one read of the live object is cheaper and more
/// coherent than reassembling a consistent state from three notifications that
/// arrive separately.
#[cfg(target_os = "macos")]
extern "C" fn nav_state_observe_imp(
    _this: &objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    _key_path: *mut objc2::runtime::AnyObject,
    object: *mut objc2::runtime::AnyObject,
    _change: *mut objc2::runtime::AnyObject,
    _context: *mut std::ffi::c_void,
) {
    nav_record_state(object);
}

/// Read the current URL/title/loading off `webview` and park it as the owning
/// pane's latest state. Unmapped pointers are ignored, exactly like the failure
/// path: the observer is only ever attached to browser panes, but the map stays
/// the single source of truth for "is this one of ours".
#[cfg(target_os = "macos")]
fn nav_record_state(webview: *mut objc2::runtime::AnyObject) {
    use crate::mac::*;
    if webview == nil {
        return;
    }
    let pane_id = match nav_pane_by_webview().lock() {
        Ok(g) => match g.get(&(webview as usize)) {
            Some(p) => p.clone(),
            None => return, // main UI webview / unknown — not ours
        },
        Err(_) => return,
    };
    unsafe {
        // `URL` is an NSURL, not an NSString, and absoluteString is the round-trip
        // the client's address bar expects. It is nil during teardown.
        let url_obj: id = msg_send![webview, URL];
        let url = if url_obj == nil {
            String::new()
        } else {
            ns_string_to_rust(msg_send![url_obj, absoluteString])
        };
        let title = ns_string_to_rust(msg_send![webview, title]);
        // The KVO key is `loading`; the getter is `isLoading`.
        let loading: BOOL = msg_send![webview, isLoading];
        if let Ok(mut v) = NAV_STATE_EVENTS.lock() {
            let next = NavStateMsg { url, title, loading, pane_id: pane_id.clone() };
            // Coalesce: replace this pane's pending state instead of appending.
            // The queue is therefore bounded by the number of live panes, which is
            // why it needs none of the 64-entry eviction the event queues carry.
            match v.iter_mut().find(|e| e.pane_id == pane_id) {
                Some(slot) => *slot = next,
                None => v.push(next),
            }
        }
    }
}

/// WKWebView pointers we hold a KVO registration on.
///
/// The classic way to die here is an observed object that deallocates while
/// still observed («… was deallocated while key value observers were still
/// registered»), which raises inside AppKit where we cannot catch it. That
/// cannot happen to us, and it is worth writing down why rather than leaving the
/// next reader to worry about it: wry's `impl Drop for InnerWebView` calls
/// `self.webview.retain()`, incrementing the refcount while it tears down (a
/// deliberate use-after-free workaround, tauri-apps/wry#1733, still present on
/// 0.56 and on `dev`). The WKWebView is therefore never deallocated, by anyone,
/// including on window close.
///
/// So removal is hygiene, not a crash guard: it stops the callbacks for a pane
/// that is gone. The set is what makes both halves idempotent, which DOES matter
/// here, because browser_open reuses live webviews: without it a reused pane
/// would register a second time and need two removals.
#[cfg(target_os = "macos")]
fn nav_state_observed() -> &'static std::sync::Mutex<std::collections::HashSet<usize>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<usize>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Attach the KVO observer for `URL`/`title`/`loading` to this pane's WKWebView.
///
/// The observer is ONE shared process-wide instance of a class we declare
/// ourselves. A brand-new class, so ClassBuilder works here, unlike the failure
/// hook which had to graft methods onto a class wry already owns. It is never
/// released: it outlives every pane by construction, which is the cheapest way to
/// guarantee it is still alive whenever WebKit calls back.
#[cfg(target_os = "macos")]
fn install_nav_state_observer(wv: &tauri::Webview, pane_id: &str) {
    let pane = pane_id.to_string();
    let _ = wv.with_webview(move |platform| unsafe {
        use crate::mac::*;
        use objc2::runtime::ClassBuilder;
        let wk = platform.inner() as id;
        if wk == nil {
            return;
        }
        // Belt and braces: install_nav_failure_hook maps the pointer already, but
        // this hook must not depend on which of the two is called first.
        if let Ok(mut g) = nav_pane_by_webview().lock() {
            g.insert(wk as usize, pane.clone());
        }
        static PTR: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
        let class_ptr = *PTR.get_or_init(|| {
            let mut decl = ClassBuilder::new(c"TopicsNavStateObserver", class!(NSObject))
                .expect("register TopicsNavStateObserver");
            decl.add_method(
                sel!(observeValueForKeyPath:ofObject:change:context:),
                nav_state_observe_imp as extern "C" fn(_, _, _, _, _, _),
            );
            decl.register() as *const Class as usize
        });
        let observer = {
            let existing = NAV_STATE_OBSERVER.load(Ordering::SeqCst);
            if existing != 0 {
                existing as id
            } else {
                let cls = class_ptr as *const Class;
                let obs: id = msg_send![cls, new];
                NAV_STATE_OBSERVER.store(obs as usize, Ordering::SeqCst);
                obs
            }
        };
        // Registering the same observer twice for the same key path would need
        // two removals, and a pane that re-runs this (a reused webview) would
        // then leak one. The set is the guard.
        if let Ok(mut g) = nav_state_observed().lock() {
            if !g.insert(wk as usize) {
                return;
            }
        } else {
            return;
        }
        // NSKeyValueObservingOptionNew (0x01) | Initial (0x04). `Initial` fires the
        // callback once at registration, so a pane that never navigates again (a
        // restored tab, an agent-opened page that already finished loading) still
        // hands the client a first state instead of waiting for a change that
        // never comes.
        let options: usize = 0x01 | 0x04;
        for key in ["URL", "title", "loading"] {
            let key_ns = nsstring(key);
            let key_ptr: id = objc2::rc::Retained::as_ptr(&key_ns) as id;
            let _: () = msg_send![wk, addObserver: observer,
                                      forKeyPath: key_ptr,
                                      options: options,
                                      context: std::ptr::null_mut::<std::ffi::c_void>()];
        }
    });
}

/// Drop the KVO registration for every WKWebView mapped to `pane_id`. Must run
/// BEFORE the webview is closed — see nav_state_observed for what happens if it
/// does not.
#[cfg(target_os = "macos")]
fn remove_nav_state_observer(pane_id: &str) {
    use crate::mac::*;
    let observer = NAV_STATE_OBSERVER.load(Ordering::SeqCst) as id;
    if observer == nil {
        return; // no pane ever registered, so nothing can be observed
    }
    let ptrs: Vec<usize> = match nav_pane_by_webview().lock() {
        Ok(g) => g.iter().filter(|(_, v)| v.as_str() == pane_id).map(|(k, _)| *k).collect(),
        Err(_) => return,
    };
    // Only remove from pointers we actually registered on, and forget them in the
    // same pass so a second close is a no-op rather than an over-removal (which
    // raises just as loudly as a missing one).
    let live: Vec<usize> = match nav_state_observed().lock() {
        Ok(mut g) => ptrs.into_iter().filter(|p| g.remove(p)).collect(),
        Err(_) => return,
    };
    unsafe {
        for wk_ptr in live {
            let wk = wk_ptr as id;
            if wk == nil {
                continue;
            }
            for key in ["URL", "title", "loading"] {
                let key_ns = nsstring(key);
                let key_ptr: id = objc2::rc::Retained::as_ptr(&key_ns) as id;
                let _: () = msg_send![wk, removeObserver: observer, forKeyPath: key_ptr];
            }
        }
    }
}

/// Drain this pane's latest navigation state. Empty when nothing changed since
/// the last drain, and ALWAYS empty off macOS (no observer is installed there),
/// which is what keeps the client's eval poll load-bearing on other platforms.
#[tauri::command]
fn browser_take_nav_state(id: String) -> Vec<NavStateMsg> {
    match NAV_STATE_EVENTS.lock() {
        Ok(mut v) => {
            let (mine, rest): (Vec<_>, Vec<_>) = v.drain(..).partition(|e| e.pane_id == id);
            *v = rest;
            mine
        }
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
        use crate::mac::*;
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
            let k_ns = nsstring(key);
            let k: id = objc2::rc::Retained::as_ptr(&k_ns) as id;
            let _: () = msg_send![dict, setObject: null, forKey: k];
        }
        let _: () = msg_send![layer, setActions: dict];
    });
}

// NOTE — item 3 (mixed-content localhost) deferred: the WKPreferences KVC key
// `allowRunningOfInsecureContent` is NOT key-value-coding-compliant on current
// WebKit — `setValue:forKey:` throws NSUnknownKeyException and crashes the app the
// instant a browser pane opens. Enabling http-subresource loading from an https
// page needs a genuinely-supported private API (a `_set…` selector guarded by
// `respondsToSelector:`, or a WKNavigationDelegate policy), verified against the
// shipping WebKit — not the KVC guess. Left unimplemented rather than crash-prone.

/// Round the browser pane's WKWebView layer at the corners that are FLUSH with the
/// window's own rounded corners — otherwise the opaque native child webview paints a
/// square corner over the window's ~10pt radius (the "border radius non corretto"
/// the user saw where a browser sits). Inner corners (where the pane abuts another
/// pane) stay square. We round the CHILD webview's layer, NOT the window content view
/// (that broke auto-resize + sidebar spacing). `win_w`/`win_h` are the window's
/// LOGICAL content size; the pane rect is window-relative logical. macOS only.
/// Per-pane cache of the last applied corner state (flip-independent 4-bit
/// visual code: tl|tr<<1|bl<<2|br<<3, plus the card radius in quarter-points).
/// browser_set_bounds runs every frame during a drag, but the pane stays flush
/// to the SAME window corner(s) — and in the same floating-card radius —
/// throughout, so this lets us skip the objc/with_webview work on every frame
/// except the one where it changes.
#[cfg(target_os = "macos")]
fn browser_corner_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, (u8, u16)>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (u8, u16)>>> =
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

/// The window's own corner radius (points) — the WKWebView pane must round its
/// window-flush corners to EXACTLY this, or the opaque webview corner pokes past
/// the window's rounded frame and reads as "no border radius". This is NOT a
/// constant: macOS 26 (Tahoe) enlarged the default window corner radius to ~16pt
/// (Liquid Glass), up from 10pt on Sequoia and earlier — a 10pt webview arc sits
/// INSIDE Tahoe's rounder window corner, leaving a visible square notch (the
/// regression Attilio saw after the OS upgrade — nothing in our code changed).
/// Read the live OS major version so a machine-independent binary matches its host.
#[cfg(target_os = "macos")]
fn window_corner_radius() -> f64 {
    use crate::mac::*;
    // NSProcessInfo.operatingSystemVersion → NSOperatingSystemVersion { major, minor, patch }.
    #[repr(C)]
    struct NSOperatingSystemVersion {
        major: i64,
        minor: i64,
        patch: i64,
    }
    // objc2's msg_send! type-checks the return encoding, so a struct returned
    // by value must declare its Objective-C encoding (three NSInteger = i64).
    unsafe impl objc2::Encode for NSOperatingSystemVersion {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
            "_NSOperatingSystemVersion",
            &[
                <i64 as objc2::Encode>::ENCODING,
                <i64 as objc2::Encode>::ENCODING,
                <i64 as objc2::Encode>::ENCODING,
            ],
        );
    }
    let major = unsafe {
        let pi: *mut objc2::runtime::AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let v: NSOperatingSystemVersion = msg_send![pi, operatingSystemVersion];
        v.major
    };
    // Tahoe (macOS 26) and later use the larger Liquid-Glass window radius; earlier
    // macOS keeps the classic 10pt. (Windows-with-toolbars can be rounder still, but
    // 16pt matches the titlebar-only default our overlay-titlebar window presents.)
    if major >= 26 { 16.0 } else { 10.0 }
}

#[cfg(target_os = "macos")]
fn apply_browser_corner_mask(wv: &tauri::Webview, id: &str, x: f64, y: f64, w: f64, h: f64, win_w: f64, win_h: f64, card_radius: f64) {
    // Attilio's final ruling (2026-07-03): the webview rounds ONLY where it
    // meets a WINDOW corner — never its own card corners mid-screen. "Meets"
    // must be tolerant: dividers/insets leave panes a few px short of the
    // edge, floating cards keep a ~12px margin, and ANY pane closer to the
    // corner than the window radius still pokes past the window's arc (the
    // native view is NOT clipped by the window shape). 2px missed real
    // corners in the tiled layout (square overhang at the window corner).
    let _ = card_radius; // kept in the invoke contract; eps no longer keys on it
    let eps: f64 = window_corner_radius() + 2.0;
    let flush_left = x <= eps;
    let flush_top = y <= eps;
    let flush_right = win_w > 0.0 && (x + w) >= (win_w - eps);
    let flush_bottom = win_h > 0.0 && (y + h) >= (win_h - eps);
    let tl = flush_left && flush_top;
    let tr = flush_right && flush_top;
    let bl = flush_left && flush_bottom;
    let br = flush_right && flush_bottom;
    let radius = window_corner_radius();
    // Skip the (main-thread) objc round-trip when the corner state is unchanged
    // for this pane — the common case on every drag frame after the first.
    let visual: u8 = (tl as u8) | ((tr as u8) << 1) | ((bl as u8) << 2) | ((br as u8) << 3);
    let radius_key: u16 = 0;
    {
        let mut g = match browser_corner_cache().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.get(id) == Some(&(visual, radius_key)) {
            return;
        }
        g.insert(id.to_string(), (visual, radius_key));
    }
    let _ = wv.with_webview(move |platform| unsafe {
        use crate::mac::*;
        let view = platform.inner() as id;
        if view == nil {
            return;
        }
        let _: () = msg_send![view, setWantsLayer: YES];
        let layer: id = msg_send![view, layer];
        if layer == nil {
            return;
        }
        // The webview's content is hosted in a REMOTE layer context under the
        // first subview (WKFlippedView) — on macOS 26 it escapes an ANCESTOR's
        // masksToBounds, so masking only the WKWebView layer reads back fine
        // but never visually clips (TOPICS_CORNER_DEMO hierarchy dump). Apply
        // the same rounding to every direct subview's layer as well: clipping
        // at the layer that OWNS the remote content does bite.
        let mut targets: Vec<id> = vec![layer];
        let sv: id = msg_send![view, subviews];
        if sv != nil {
            let n: usize = msg_send![sv, count];
            for i in 0..n {
                let child: id = msg_send![sv, objectAtIndex: i];
                let _: () = msg_send![child, setWantsLayer: YES];
                let cl: id = msg_send![child, layer];
                if cl != nil {
                    targets.push(cl);
                }
            }
        }
        if !(tl || tr || bl || br) {
            // No corner coincides with a window corner → keep it square.
            for l in &targets {
                let _: () = msg_send![*l, setMasksToBounds: NO];
                let _: () = msg_send![*l, setCornerRadius: 0.0_f64];
            }
            return;
        }
        // CACornerMask bits depend on whether the layer geometry is flipped (web
        // content usually is): flipped → MinY is the VISUAL top.
        const MINX_MINY: u64 = 1;
        const MAXX_MINY: u64 = 2;
        const MINX_MAXY: u64 = 4;
        const MAXX_MAXY: u64 = 8;
        let flipped: bool = {
            let b: bool = msg_send![layer, isGeometryFlipped];
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
        for l in &targets {
            let _: () = msg_send![*l, setCornerRadius: radius];
            let _: () = msg_send![*l, setMaskedCorners: mask];
            let _: () = msg_send![*l, setMasksToBounds: YES];
        }
        if std::env::var("TOPICS_CORNER_DEMO").is_ok() {
            let rback: f64 = msg_send![layer, cornerRadius];
            let mback: u64 = msg_send![layer, maskedCorners];
            let clips: bool = msg_send![layer, masksToBounds];
            eprintln!(
                "[corner-mask] flush(l{} t{} r{} b{}) tl{} tr{} bl{} br{} flipped={} mask={} -> radius={} maskedBack={} clips={}",
                flush_left as u8, flush_top as u8, flush_right as u8, flush_bottom as u8,
                tl as u8, tr as u8, bl as u8, br as u8, flipped as u8, mask, rback, mback, clips != NO
            );
            // Hierarchy dump: WHERE does WKWebView's content actually render?
            // (macOS 26 UI-side compositing hosts it in a remote layer that can
            // escape an ancestor's masksToBounds — find the real clip target.)
            unsafe fn dump_view(v: id, depth: usize) {
                if v == nil || depth > 4 {
                    return;
                }
                let cls: id = msg_send![v, className];
                let cstr: *const std::os::raw::c_char = msg_send![cls, UTF8String];
                let name = std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned();
                let lay: id = msg_send![v, layer];
                let lname = if lay != nil {
                    let lc: id = msg_send![lay, className];
                    let lp: *const std::os::raw::c_char = msg_send![lc, UTF8String];
                    std::ffi::CStr::from_ptr(lp).to_string_lossy().into_owned()
                } else {
                    "nil".to_string()
                };
                let nsub: usize = if lay != nil {
                    let subs: id = msg_send![lay, sublayers];
                    if subs != nil { msg_send![subs, count] } else { 0 }
                } else {
                    0
                };
                eprintln!("[corner-dump] {}view={} layer={} sublayers={}", "  ".repeat(depth), name, lname, nsub);
                if lay != nil && nsub > 0 {
                    let subs: id = msg_send![lay, sublayers];
                    for i in 0..nsub.min(6) {
                        let sl: id = msg_send![subs, objectAtIndex: i];
                        let sc: id = msg_send![sl, className];
                        let sp: *const std::os::raw::c_char = msg_send![sc, UTF8String];
                        eprintln!(
                            "[corner-dump] {}  L{} {}",
                            "  ".repeat(depth),
                            i,
                            std::ffi::CStr::from_ptr(sp).to_string_lossy()
                        );
                    }
                }
                let sv: id = msg_send![v, subviews];
                if sv != nil {
                    let n: usize = msg_send![sv, count];
                    for i in 0..n.min(6) {
                        let child: id = msg_send![sv, objectAtIndex: i];
                        dump_view(child, depth + 1);
                    }
                }
            }
            dump_view(view, 0);
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

/// Logical size of the window that actually HOSTS this webview — a pane in a
/// detached/pop-out window must do its corner-flush math against ITS window,
/// not "main" (against main, a full-bleed pop-out pane never looks flush and
/// stays square over the pop-out window's rounded corners). macOS only.
#[cfg(target_os = "macos")]
fn webview_window_logical_size(wv: &tauri::Webview) -> Option<(f64, f64)> {
    let win = wv.window();
    let sf = win.scale_factor().ok()?;
    let is = win.inner_size().ok()?;
    Some((is.width as f64 / sf, is.height as f64 / sf))
}

/// Deterministic 16-byte data-store identifier for a pane's contextId — feeds
/// `WKWebsiteDataStore dataStoreForIdentifier:` (via tauri's
/// `data_store_identifier`, plumbed to wry) so each isolated pane gets its OWN
/// cookie/localStorage silo that PERSISTS across app restarts (the contextId is
/// stable in the pane store, e.g. `browser:<uuid>` or the project path).
///
/// Two seeded FNV-1a 64-bit hashes → 16 bytes, then RFC 4122 version/variant
/// bits are forced (also guarantees the UUID is never all-zero, which
/// dataStoreForIdentifier rejects). ⚠️ This derivation is CONTRACT: changing
/// seeds/algorithm orphans every existing pane's cookie store on disk.
fn data_store_uuid_for(context_id: &str) -> [u8; 16] {
    fn fnv1a64(seed: u64, bytes: &[u8]) -> u64 {
        let mut h = seed;
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }
    // Seed A = FNV-1a offset basis; seed B = golden-ratio constant (distinct
    // streams over the same input → 128 independent-ish bits).
    let a = fnv1a64(0xcbf2_9ce4_8422_2325, context_id.as_bytes());
    let b = fnv1a64(0x9e37_79b9_7f4a_7c15, context_id.as_bytes());
    let mut out = [0u8; 16];
    out[..8].copy_from_slice(&a.to_be_bytes());
    out[8..].copy_from_slice(&b.to_be_bytes());
    out[6] = (out[6] & 0x0F) | 0x40; // version nibble (v4 layout) — never zero
    out[8] = (out[8] & 0x3F) | 0x80; // RFC 4122 variant
    out
}

/// Il nome con cui lo store di un contextId si chiama SU DISCO, uguale su tutte
/// e tre le piattaforme.
///
/// Su macOS e' il nome che WebKit da' da solo alla cartella dello store per
/// identifier; su Windows e Linux e' il nome che gli diamo noi (vedi
/// [`pane_store_dir`]). Averne uno solo e' cio' che permette al reaper di
/// riconoscere le sue cartelle ovunque con lo stesso codice.
fn pane_store_dir_name(context_id: &str) -> String {
    uuid_str_from_bytes(&data_store_uuid_for(context_id))
}

/// La cartella `browser-stores/` sotto i dati locali dell'app: la radice di
/// tutti gli store delle pane isolate fuori da macOS.
///
/// La radice la chiede all'app e non a un `env::var` indovinato, perche' e'
/// l'app a sapere se sta girando impacchettata o da `cargo run`: indovinandola
/// il reaper spazzerebbe la cartella dell'altra.
#[cfg(not(target_os = "macos"))]
fn pane_store_root(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    Some(app.path().app_local_data_dir().ok()?.join("browser-stores"))
}

/// La cartella dello store di UNA pane isolata, fuori da macOS. Unico punto in
/// cui quel path si calcola: creazione, purge e reaper passano tutti da qui,
/// perche' due derivazioni un giorno divergono e il purge cancella la cartella
/// di un'altra pane.
///
/// Windows e Linux non hanno niente che assomigli a `dataStoreForIdentifier:`:
/// wry implementa `data_store_identifier` solo su WKWebView. L'unica leva che i
/// due motori condividono e' la CARTELLA, cioe' `WebviewBuilder::data_directory`:
/// tauri-runtime-wry la usa come chiave dello store dei `WebContext`, e da li'
/// nasce la user-data folder di WebView2 su Windows e il `WebsiteDataManager`
/// (dati, cache e barattolo dei cookie) su WebKitGTK.
///
/// IL PREZZO, che va detto e non nascosto: una user-data folder per pane
/// significa un environment WebView2 per pane, cioe' un processo browser a
/// testa; e su WebKitGTK un `WebContext` per pane, cioe' una rete di processi a
/// testa. Non e' una scelta nostra, e' come i due motori separano i profili.
/// L'isolamento per-topic che su macOS costa zero (un solo processo di rete,
/// tanti data store) qui si paga in processi.
#[cfg(not(target_os = "macos"))]
fn pane_store_dir(app: &tauri::AppHandle, context_id: &str) -> Option<std::path::PathBuf> {
    Some(pane_store_root(app)?.join(pane_store_dir_name(context_id)))
}

/// Panic firewall for webview-dispatcher-touching SYNC commands.
///
/// tauri-runtime-wry's `WryWebviewDispatcher` methods all do
/// `window_id.lock().unwrap()`; once ANY thread panics while holding that
/// lock the mutex is poisoned and every later dispatcher call panics too.
/// For a sync command the panic unwinds into wry's objc url_scheme_handler /
/// `on_message` FFI boundary, where unwinding is forbidden → `abort()` kills
/// the whole app (six identical SIGABRT reports 2026-07-10/11, stack:
/// browser_open → browser_navigate → WryWebviewDispatcher::navigate →
/// unwrap_failed; trigger = pane churn after a server kickstart). Catching
/// HERE keeps the panic below that boundary: the command returns Err, the
/// client surfaces/retries, and the pane self-heal path can recreate the
/// webview — one broken pane instead of every tab dying at once. The global
/// panic hook installed in `run()` still logs the payload first.
fn no_abort<T>(label: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic payload".to_string());
            eprintln!("[no-abort] {label}: {msg}");
            Err(format!("{label} panicked: {msg}"))
        }
    }
}

/// Create (or, if it already exists, reuse) the native webview for a browser
/// pane and place it at the given window-relative rect.
///
/// `isolate: Some(true)` gives the NEW pane its own persistent
/// `WKWebsiteDataStore` keyed on `id` (per-topic cookie/localStorage isolation).
/// Optional + default-off on purpose: every existing pane lives in the SHARED
/// default store, so flipping isolation unconditionally would silently drop all
/// current logins. macOS 14+ only — on 13 wry silently falls back to the shared
/// default store (no error), so isolation degrades gracefully. Applies at
/// creation only: an already-open pane keeps whatever store it was built with
/// (the WKWebViewConfiguration is consumed inside wry) until closed + reopened.
#[tauri::command]
fn browser_open(
    app: tauri::AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    isolate: Option<bool>,
    // Etichetta della finestra che DEVE ospitare la webview. Il client passa
    // `currentWindowLabel()`: così una pane aperta in un pop-out nasce figlia del
    // pop-out, non di `main`. Optional per compatibilità coi bundle vecchi (None
    // = `main`, il vecchio comportamento).
    window_label: Option<String>,
) -> Result<(), String> {
    no_abort("browser_open", move || {
        browser_open_inner(app, id, url, x, y, width, height, isolate, window_label)
    })
}

#[allow(clippy::too_many_arguments)]
fn browser_open_inner(
    app: tauri::AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    isolate: Option<bool>,
    window_label: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let label = browser_label(&id);
    // `is_some`, non il binding: la webview qui non serve più a nessuno da
    // quando l'URL non gliela si chiede (vedi sotto). Ci interessa solo se la
    // pane esiste già.
    if app.get_webview(&label).is_some() {
        // Already open — reposition, and navigate ONLY if the URL actually
        // differs. browser_open is the idempotent-mount path: a transient
        // auto-split remount re-invokes it with the pane's persisted (≈live)
        // URL, and a blind browser_navigate there RELOADS the live WKWebView,
        // discarding the user's in-progress page/scroll/form state. Skip the
        // navigate when we're already there; explicit browser_navigate (user
        // re-entering a URL) still reloads as before.
        // «Dove sei?» NON si chiede alla WKWebView.
        //
        // `wv.url()` scende in `wry::url_from_webview`, che fa `unwrap()`
        // sull'URL nativa: per una pane appena montata quell'URL è `nil` e
        // l'unwrap PANICA sul main thread, dentro un callback Objective-C, con
        // un lock di wry in mano. Il `catch_unwind` che stava qui prendeva
        // l'unwind ma non disfaceva il danno — il mutex restava avvelenato e da
        // lì ogni lock di tauri-runtime-wry panicava a sua volta, fino
        // all'`abort()`: l'app che si chiude da sola qualche secondo dopo
        // (crash del 5 agosto, 522.313 panic in cascata da uno solo).
        //
        // La risposta ce l'abbiamo già in casa: l'URL di una pane la decidiamo
        // noi. Assente = «non lo so» = si naviga, che per una pane non ancora
        // caricata è la cosa giusta comunque.
        let already_here = match (last_pane_url(&label), url.parse::<tauri::Url>()) {
            (Some(cur), Ok(want)) => cur.parse::<tauri::Url>().map(|c| c == want).unwrap_or(false),
            _ => false,
        };
        if !already_here {
            let _ = browser_navigate(app.clone(), id.clone(), url);
        }
        return browser_set_bounds(app, id, x, y, width, height, None);
    }
    // Parenta la webview alla finestra che OSPITA la pane, non a `main` per
    // default. Cablare `main` faceva nascere OGNI pane browser figlia della
    // finestra principale ovunque vivesse: in un pop-out compariva sopra main
    // (coordinate del pop-out proiettate su main) e sopravviveva alla chiusura
    // del pop-out come webview orfana — nessuno la distruggeva (incidente delle
    // 9 pane del 2026-07-20). Come figlia della finestra giusta, viene distrutta
    // insieme ad essa. Fallback a `main` per etichetta mancante/sconosciuta
    // (bundle vecchio, o finestra chiusa nel frattempo).
    let host_label = window_label.as_deref().unwrap_or("main");
    let window = app
        .get_window(host_label)
        .or_else(|| app.get_window("main"))
        .ok_or("no host window")?;
    let parsed: tauri::Url = url.parse().map_err(|_| format!("bad url: {url}"))?;
    // window.open / target=_blank: wry's WKUIDelegate asks this handler what to
    // do (with NO handler set the popup was silently dropped). Electron-parity
    // semantics (setWindowOpenHandler): never spawn a detached native window —
    // navigate the SAME pane in place for web URLs and deny the popup; deny
    // silently for non-web schemes. The handler runs inside the UI delegate on
    // the main thread, so the navigation is deferred to the async runtime
    // (Webview::navigate marshals back to main itself) rather than re-entering
    // WebKit mid-delegate. NOTE: the popup sees a nil return (window.open() →
    // null), so opener/postMessage popup flows won't link up — accepted.
    let nw_app = app.clone();
    let nw_label = label.clone();
    // Nasce già con la sua URL: annotarla qui evita che il primo remount della
    // pane la creda «sconosciuta» e ri-navighi su una pagina che sta già
    // caricando.
    remember_pane_url(&label, &url);
    let mut builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
        .initialization_script(CONSOLE_PROXY_JS)
        // Il pid del WebContent si registra QUI, a pagina caricata, non solo al
        // campionamento di `perf_metrics`.
        //
        // Il motivo è l'ordine dei tempi: `_webProcessIdentifier` ritorna 0
        // finché il contenuto non è caricato, e la lettura deve passare dal main
        // thread — quindi `refresh_webview_content_pids` scrive per il giro DOPO.
        // Chi apriva una scheda e ci passava sopra il mouse subito leggeva
        // «non ancora misurato», e non è un dettaglio: è la prima impressione
        // della funzione, e invita a non riprovare.
        //
        // `on_page_load` scatta esattamente quando il processo esiste, quindi al
        // primo passaggio del mouse il numero c'è già. Il campionamento resta
        // come rete: copre i reload (WebContent nuovo) e le webview aperte prima
        // che questo hook esistesse.
        //
        // Il corpo e macOS-only per forza: legge `_webProcessIdentifier`, che e
        // una SPI di WebKit. Il gate pero mancava, e non su una riga qualsiasi:
        // `platform.inner()` su Windows non esiste proprio (li si chiama
        // `controller()`), quindi questo blocco NON COMPILAVA ne su Linux ne su
        // Windows. Non se n'era accorto nessuno perche il Mac guarda solo il
        // proprio ramo e la CI cross-platform parte sui tag `tauri-v*`: la prima
        // release a toccarla sarebbe morta in build. Lo becca ora
        // `scripts/check-cross-shell.sh`.
        .on_page_load(|_webview, _payload| {
            #[cfg(target_os = "macos")]
            {
                let label = _webview.label().to_string();
                let _ = _webview.with_webview(move |platform| {
                    let pid =
                        unsafe { web_process_identifier(platform.inner() as *mut crate::mac::Object) };
                    if pid > 0 {
                        if let Ok(mut m) = webview_content_pid_map().lock() {
                            m.insert(label, pid);
                        }
                    }
                });
            }
        })
        .on_new_window(move |url, _features| {
            let scheme = url.scheme();
            if scheme == "http" || scheme == "https" {
                let app = nw_app.clone();
                let label = nw_label.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(wv) = app.get_webview(&label) {
                        let _ = wv.navigate(url);
                    }
                });
            }
            tauri::webview::NewWindowResponse::Deny
        });
    // L'isolamento si chiede con due leve diverse, e non e' una ridondanza:
    // `data_store_identifier` e' documentato da tauri come «macOS/iOS», e wry lo
    // implementa solo su WKWebView. Fuori da li' quella riga scriveva un attributo
    // che non leggeva nessuno, quindi ogni pane di Windows e Linux nasceva nel
    // profilo condiviso: `isolate: true` diceva il falso. La leva che i due motori
    // hanno davvero e' la cartella. Vedi `pane_store_dir` per il prezzo in processi.
    #[cfg(target_os = "macos")]
    if isolate.unwrap_or(false) {
        builder = builder.data_store_identifier(data_store_uuid_for(&id));
    }
    #[cfg(not(target_os = "macos"))]
    if isolate.unwrap_or(false) {
        // Nessuna cartella risolvibile = nessun isolamento, e la pane nasce nel
        // profilo condiviso. E' lo stesso degrado silenzioso che macOS ha sui
        // sistemi vecchi di 14: si perde la separazione, non la pane.
        match pane_store_dir(&app, &id) {
            Some(dir) => {
                // La cartella si crea qui e non la si lascia al motore. WebView2
                // la sua user-data folder se la fa da solo, ma su WebKitGTK il
                // barattolo dei cookie e' un file che wry indica per path
                // (`<dir>/cookies`) prima che qualcuno abbia creato `<dir>`: la
                // sessione non si salverebbe, e nessuno lo direbbe. Se la
                // creazione fallisce si prosegue lo stesso, con una riga di log:
                // il motore ha ancora la sua occasione di crearla, e rinunciare
                // all'isolamento in silenzio sarebbe il guasto peggiore.
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    eprintln!("[browser_open] {id}: {} non creata: {e}", dir.display());
                }
                builder = builder.data_directory(dir);
            }
            None => eprintln!("[browser_open] {id}: nessuna cartella dati, la pane non sara' isolata"),
        }
    }
    // Cloned for the (move) download closure below — `id` itself is still needed
    // after add_child() returns (see apply_browser_corner_mask below).
    let dl_pane_id = id.clone();
    window
        .add_child(
            builder
                .on_download(move |_webview, event| {
                    use tauri::webview::DownloadEvent;
                    match event {
                        DownloadEvent::Requested { url, destination } => {
                            let url_s = url.to_string();
                            // LA DESTINAZIONE ARRIVA GIÀ DECISA, E RISCRIVERLA ERA IL
                            // MOTIVO PER CUI «I DOWNLOAD NON VANNO».
                            //
                            // wry la calcola in `download_policy` (wkwebview/download.rs):
                            // cartella Download di sistema + il nome SUGGERITO dalla
                            // risposta (cioè Content-Disposition, quando c'è) + un
                            // contatore `(1)`, `(2)`… finché il path è libero.
                            //
                            // Qui sopra la si buttava via per ricomporla dall'ultimo
                            // pezzo dell'URL, e si perdevano entrambe le cose. Misurato
                            // con una probe wry isolata, stessa versione:
                            //   · `…/files?id=42` con Content-Disposition report-2026.zip
                            //     → salvato come «files», senza estensione;
                            //   · stesso file due volte → WKDownload NON sovrascrive:
                            //     fallisce con «cancelled», nessun file su disco. Cioè
                            //     il secondo download di qualunque cosa non arriva.
                            // Rispettando il path di wry: nome giusto e «report-2026 (1).zip».
                            //
                            // Se il path proposto fosse relativo (nessuna cartella
                            // Download rilevata: wry ripiega sulla cwd) lo si àncora a
                            // ~/Downloads, che è dove l'utente lo va a cercare.
                            if destination.is_relative() {
                                if let Ok(home) = std::env::var("HOME") {
                                    let name = destination
                                        .file_name()
                                        .map(std::ffi::OsStr::to_os_string)
                                        .unwrap_or_else(|| std::ffi::OsString::from("download"));
                                    *destination = std::path::PathBuf::from(home).join("Downloads").join(name);
                                }
                            }
                            let saved = destination.to_string_lossy().to_string();
                            let filename = destination
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| "download".to_string());
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
                                p.push((url_s.clone(), id, saved.clone(), dl_pane_id.clone(), filename.clone()));
                            }
                            if let Ok(mut v) = DOWNLOAD_EVENTS.lock() {
                                // Bounded like DOWNLOAD_PENDING: a pane that downloads
                                // and closes before anyone polls its id must not leak.
                                if v.len() >= 64 {
                                    let overflow = v.len() - 63;
                                    v.drain(0..overflow);
                                }
                                v.push(DownloadEventMsg {
                                    kind: "start".into(),
                                    id: id.to_string(),
                                    url: url_s,
                                    filename,
                                    success: false,
                                    state: "progressing".into(),
                                    saved_path: saved,
                                    pane_id: dl_pane_id.clone(),
                                });
                            }
                        }
                        DownloadEvent::Finished { url, path: _, success } => {
                            let url_s = url.to_string();
                            let (id, saved, pane_id, name) = {
                                let mut p = DOWNLOAD_PENDING.lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(pos) = p.iter().position(|(u, _, _, _, _)| *u == url_s) {
                                    let (_, i, s, pid, n) = p.remove(pos);
                                    (i, s, pid, n)
                                } else {
                                    (DOWNLOAD_ID.fetch_add(1, Ordering::SeqCst), String::new(), dl_pane_id.clone(), String::new())
                                }
                            };
                            if let Ok(mut v) = DOWNLOAD_EVENTS.lock() {
                                if v.len() >= 64 {
                                    let overflow = v.len() - 63;
                                    v.drain(0..overflow);
                                }
                                v.push(DownloadEventMsg {
                                    kind: "done".into(),
                                    // Il nome viaggia anche nel «done»: se la pane è
                                    // stata ricreata fra i due eventi il client non ha
                                    // più lo «start» da cui prenderlo, e una voce senza
                                    // nome è una voce che non dice niente.
                                    id: id.to_string(),
                                    url: url_s,
                                    filename: name,
                                    success,
                                    state: if success { "completed".into() } else { "interrupted".into() },
                                    saved_path: saved,
                                    pane_id,
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
        install_nav_failure_hook(&wv, &id);
        // After the failure hook: that one populates the pointer→pane map both
        // read, and the KVO callback drops anything it cannot resolve to a pane.
        install_nav_state_observer(&wv, &id);
        if let Some((win_w, win_h)) = webview_window_logical_size(&wv) {
            // Card radius unknown at create; the client's first bounds push carries it.
            apply_browser_corner_mask(&wv, &id, x, y, width, height, win_w, win_h, 0.0);
        }
    }
    Ok(())
}

/// Navigate an existing browser pane to a new URL.
#[tauri::command]
fn browser_navigate(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    no_abort("browser_navigate", move || browser_navigate_inner(app, id, url))
}

fn browser_navigate_inner(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app
        .get_webview(&browser_label(&id))
        .ok_or("no such browser pane")?;
    let parsed: tauri::Url = url.parse().map_err(|_| format!("bad url: {url}"))?;
    // Annotato PRIMA: se la navigate fallisce il peggio è un appunto in più, se
    // riesce l'appunto c'è di sicuro (nessuna finestra in cui la mappa mente
    // dicendo che siamo ancora dov'eravamo).
    remember_pane_url(&browser_label(&id), &url);
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
    // Rounded-card radius of the HOST pane (floating-splits cards) — 0/absent =
    // square unless window-flush. Optional so older bundles keep working.
    radius: Option<f64>,
) -> Result<(), String> {
    no_abort("browser_set_bounds", move || {
        browser_set_bounds_inner(app, id, x, y, width, height, radius)
    })
}

fn browser_set_bounds_inner(
    app: tauri::AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radius: Option<f64>,
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
    if let Some((win_w, win_h)) = webview_window_logical_size(&wv) {
        apply_browser_corner_mask(&wv, &id, x, y, width, height, win_w, win_h, radius.unwrap_or(0.0));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = radius;
    Ok(())
}

/// Really show/hide a browser pane's native webview.
///
/// The inherited way to "hide" a pane is `browser_set_bounds({0,0,0,0})` — an
/// ELECTRON workaround (WebContentsView exposes no setVisible) that we carried
/// over unexamined. It does not hide anything as far as WebKit is concerned:
/// visibility is derived from `isHiddenOrHasHiddenAncestor` + window occlusion,
/// never from the rect. A zero-sized pane is therefore a fully VISIBLE page —
/// rAF keeps firing, timers stay unthrottled, and WebKit never runs the
/// background-page memory reclaim.
///
/// What that cost, measured on Attilio's box: 20 live WebContent processes
/// holding 6374 MB of footprint against ~130 MB actually resident. The OS had
/// compressed the difference and the machine sat at 23.7/24 GB of swap — the
/// paging, not the GPU, is what made the UI stutter with many panes open.
///
/// `hide()` maps to `setHidden:` (wry `set_visible`), which flips WebKit's
/// ActivityState::IsVisible: the page goes to visibilityState "hidden", rAF
/// stops, timers throttle, and the content process becomes reclaimable. This is
/// what Safari does to background tabs. Bounds are deliberately left untouched
/// while hidden, so re-showing is instant and needs no geometry round-trip.
#[tauri::command]
fn browser_set_visible(app: tauri::AppHandle, id: String, visible: bool) -> Result<(), String> {
    no_abort("browser_set_visible", move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&browser_label(&id))
            .ok_or("no such browser pane")?;
        if visible {
            wv.show().map_err(|e| e.to_string())
        } else {
            wv.hide().map_err(|e| e.to_string())
        }
    })
}

/// Sidebar-slide handoff: land a browser pane's FIXED-duration move on the Core
/// Animation clock in ONE IPC, instead of the ~12 rAF-driven `browser_set_bounds`
/// hops whose IPC jitter made the native view visibly stutter against the
/// composited DOM slide (same fix, same rationale as `vibrancy_animate_regions`).
///
/// Native FLIP: the FINAL frame is committed instantly (model value — the exact
/// same path as a plain set_bounds, cache + corner mask included), then ONE
/// EXPLICIT CABasicAnimation slides `transform.translation.x` from `from_dx`
/// (the pane's current visual offset from its final slot, in logical px) to 0.
/// Explicit animations bypass the layer's nulled actions dict
/// (`disable_layer_implicit_animations` only blocks IMPLICIT action lookup), so
/// this animates even though plain frame changes stay deliberately instant.
/// The client suppresses its per-frame pushes for the slide's lifetime and its
/// transitionend settle re-pushes pixel-exact bounds afterwards.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn browser_animate_bounds(
    app: tauri::AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    from_dx: f64,
    duration_ms: f64,
    timing: [f64; 4],
    radius: Option<f64>,
) -> Result<(), String> {
    no_abort("browser_animate_bounds", move || {
        #[cfg(target_os = "macos")]
        let anim_app = app.clone();
        // Commit the final frame first (model value, cache, corner mask).
        browser_set_bounds_inner(app, id.clone(), x, y, width, height, radius)?;
        #[cfg(target_os = "macos")]
        if from_dx.abs() >= 1.0 && duration_ms > 0.0 {
            use tauri::Manager;
            if let Some(wv) = anim_app.get_webview(&browser_label(&id)) {
                let _ = wv.with_webview(move |platform| unsafe {
                    use crate::mac::*;
                    let view = platform.inner() as id;
                    if view == nil {
                        return;
                    }
                    let layer: id = msg_send![view, layer];
                    if layer == nil {
                        return;
                    }
                    let key_path_ns = nsstring("transform.translation.x");
                    let key_path: id = objc2::rc::Retained::as_ptr(&key_path_ns) as id;
                    let anim: id = msg_send![class!(CABasicAnimation), animationWithKeyPath: key_path];
                    let from_num: id = msg_send![class!(NSNumber), numberWithDouble: from_dx];
                    let to_num: id = msg_send![class!(NSNumber), numberWithDouble: 0.0f64];
                    let _: () = msg_send![anim, setFromValue: from_num];
                    let _: () = msg_send![anim, setToValue: to_num];
                    let _: () = msg_send![anim, setDuration: (duration_ms / 1000.0)];
                    let tf = ca_timing_for(timing);
                    let _: () = msg_send![anim, setTimingFunction: tf];
                    // Default removedOnCompletion=YES → the layer settles at the
                    // model value (translation 0 = the committed final frame).
                    let key_ns = nsstring("topics-sidebar-slide");
                    let key: id = objc2::rc::Retained::as_ptr(&key_ns) as id;
                    let _: () = msg_send![layer, addAnimation: anim, forKey: key];
                });
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (from_dx, duration_ms, timing);
        Ok(())
    })
}

/// Elenca le WKWebView di pane browser vive ADESSO, per contextId.
///
/// La verità è `Manager::webviews()`, non un registro nostro: un registro può
/// divergere, la lista del runtime no. Sola lettura.
///
/// Serve a due cose. La prima è diagnostica e mancava del tutto: fino al
/// 2026-07-29 non c'era modo di sapere quante webview fossero vive senza
/// `footprint` sui processi da un terminale — e la risposta, quel giorno, era 65
/// contro le 4 attive. La seconda è la riconciliazione: il client tiene un
/// roster in `localStorage` (`lib/shell/nativeBrowserRoster.ts`) che copre tutto
/// ciò che ha aperto lui, ma non sopravvive a una pulizia dei dati del sito né
/// a un crash a metà apertura. Questa lista sì, perché non è una nostra copia.
#[tauri::command]
fn browser_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    no_abort("browser_list", move || {
        use tauri::Manager;
        // Deduplicato: una pane la cui etichetta è stata BRUCIATA (vedi
        // `burn_pane_label`) lascia dietro di sé una webview morta registrata
        // sotto la generazione vecchia, e quella e la nuova risalgono allo
        // stesso id. Elencarlo due volte direbbe «due pane» dove ce n'è una.
        let mut ids: Vec<String> = app
            .webviews()
            .keys()
            .filter_map(|label| pane_id_from_label(label).map(str::to_string))
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    })
}

/// Destroy a browser pane's native webview.
#[tauri::command]
fn browser_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_close", move || browser_close_inner(app, id))
}

/// Chiede alla WKWebView di una pane di smontarsi per davvero. `false` = qui non
/// si puo', tocca al ripiego.
///
/// IL PID SI LEGGE PRIMA. Dopo `_close` il WebContent muore, e con lui la
/// possibilita' di sapere quale processo era: il numero nel log e' quello da
/// guardare per vedere sparire il processo (~1,25 s), altrimenti la riga direbbe
/// soltanto che ci abbiamo provato.
///
/// IL THREAD. `with_webview` esegue la closure sul MAIN THREAD. Un comando
/// `#[tauri::command]` sincrono e' gia' sul main thread, quindi la closure gira
/// inline; da qualunque altro thread il messaggio va in coda, e la coda conserva
/// l'ordine. In tutti e due i casi il `close()` che segue arriva dopo, che e'
/// l'ordine che vogliamo.
///
/// Il giro passa dal dispatcher di wry come ogni altro passo della chiusura,
/// quindi ha il suo `no_abort`: col mutex avvelenato panica qui e non dentro
/// l'FFI. Se il dispatch non atterra si risponde `false` e il chiamante prova il
/// ripiego (che passa dallo stesso dispatcher, quindi probabilmente fallira'
/// anche lui: nessuno dei due passi si porta via l'altro).
#[cfg(target_os = "macos")]
fn free_native_webview(wv: &tauri::Webview, label: &str) -> bool {
    if !wkwebview_can_close() {
        return false;
    }
    let label = label.to_string();
    no_abort("browser_close/_close", || {
        wv.with_webview(move |platform| {
            let view = platform.inner() as *mut crate::mac::Object;
            let pid = unsafe { web_process_identifier(view) };
            if unsafe { close_web_view(view) } {
                eprintln!("[browser_close] {label}: _close chiamata, WebContent pid {pid}");
            } else {
                eprintln!("[browser_close] {label}: _close assente sull'istanza, resta il ripiego");
            }
        })
        .map_err(|e| e.to_string())
    })
    .is_ok()
}

/// Su Windows e Linux la webview non e' una WKWebView e il `retain` di wry non
/// c'e': la chiusura resta quella di prima, ripiego compreso.
#[cfg(not(target_os = "macos"))]
fn free_native_webview(_wv: &tauri::Webview, _label: &str) -> bool {
    false
}

/// Svuota una pane browser e dimentica tutto quello che la riguardava.
///
/// È il corpo comune di tre percorsi che vogliono la stessa cosa e per ragioni
/// diverse: la chiusura esplicita (`browser_close_inner`), la finestra che se ne
/// va portandosi via le figlie (`evict_panes_of_window`) e il reclamo che non
/// trova più nessuno a rivendicare la pane (`browser_claim`). Averlo scritto in
/// un posto solo è ciò che impedisce a uno dei tre di dimenticare un pezzo:
/// finché era copiato, «svuotare» voleva dire cose diverse a seconda di chi
/// chiedeva.
///
/// Ogni passo che tocca il dispatcher di wry ha il suo `no_abort`, non uno solo
/// attorno a tutto: col mutex avvelenato panicava già `navigate()`, la prima
/// riga, e il `?` che seguiva portava fuori dalla funzione prima della chiusura
/// E prima della pulizia delle cache. Isolati, un passo morto non si porta via i
/// successivi.
///
/// I due interruttori dicono quanto lontano spingersi, e nessuno dei due è
/// gratis:
///
/// * `close` = distruggere anche il guscio. Lo vuole chi chiude una pane per
///   davvero. NON lo vuole chi sta reagendo alla chiusura della finestra ospite:
///   lì la view la smonta comunque la finestra, e chiedere la `close()` mentre
///   il runtime sta già smontando aggiunge un messaggio al dispatcher senza
///   liberare un byte in più.
/// * `purge_cache` = restituire al disco la NetworkCache dello store. Di norma
///   lo chiede il client alla morte della pane
///   (`client/src/components/Layout/hooks/usePaneLifecycle.ts`), quindi la
///   chiusura esplicita lo lascia a lui e non lo rifà. Lo accendono i percorsi
///   dove il client non arriva: una finestra chiusa non ha più una UI che possa
///   chiamare niente, e una pane orfana per definizione non ha più nessuno.
fn browser_evict_pane(app: &tauri::AppHandle, id: &str, close: bool, purge_cache: bool) {
    use tauri::Manager;
    let label = browser_label(id);
    // LA CACHE SI SVUOTA PRIMA DELLA CHIUSURA, non dopo. Su macOS l'ordine e'
    // indifferente, perche' li' lo store si riapre per identifier anche a pane
    // morta; fuori da macOS l'unica strada per lo store passa dalla vista (vedi
    // `browser_purge_cache`), quindi dopo la `close()` non c'e' piu' nessuno a
    // cui chiederlo e il comando e' un no-op muto.
    //
    // Non e' un'ipotesi: il reclamo di `browser_claim` chiude le pane orfane
    // proprio con `close` e `purge_cache` insieme, ed e' la strada che recupera
    // lo spazio delle pane che nessuna interfaccia disegna piu'.
    if purge_cache {
        let _ = browser_purge_cache(app.clone(), id.to_string());
    }
    if let Some(wv) = app.get_webview(&label) {
        // BEFORE any teardown, never after: a WKWebView that deallocates while a
        // KVO registration is still on it raises, and the raise happens inside
        // AppKit where we cannot catch it. It goes ahead of `free_native_webview`
        // because that is the call that tears the view down (`_close`), and the
        // pointer→pane map this reads is only cleared further down, so the order
        // here is load-bearing on both ends.
        #[cfg(target_os = "macos")]
        remove_nav_state_observer(id);
        // SMONTA PRIMA DI CHIUDERE. `close()` da solo non libera il processo
        // WebContent: wry non dealloca mai la WKWebView. `impl Drop for
        // InnerWebView` (wry 0.55.1, `src/wkwebview/mod.rs:1413`) chiama
        // `self.webview.retain()` per aggirare un use-after-free, quindi
        // l'oggetto ObjC sopravvive alla chiusura per sempre e con lui il suo
        // processo. Il `retain` c'e' ancora in 0.56.0 e su dev: alzare wry non
        // serve, e infatti non lo alziamo.
        //
        // Qui c'era scritto che il guscio non si puo' liberare e che non c'e'
        // fix a monte da prendere. La seconda meta' resta vera, la prima no:
        // `-[WKWebView _close]` libera anche il guscio senza toccare wry. Il
        // processo WebContent muore in ~1,25 s dalla chiamata, chiamarla due
        // volte non crasha, e non crasha nemmeno il `removeFromSuperview()` +
        // `retain()` che wry fa subito dopo nel suo `Drop`. Falsificata su un
        // banco Swift separato prima di metterla qui (vedi `close_web_view`).
        // La misura da cui si parte: 15 WebView vive per 9,7 GB di footprint.
        //
        // IL RIPIEGO E' IL COMPORTAMENTO DI PRIMA, non un'aggiunta. `_close` e'
        // SPI: se un aggiornamento di WebKit la togliesse, si torna alla
        // navigazione ad `about:blank`, che smonta documento, DOM e heap JS ma
        // lascia in piedi il processo. Misurato il 2026-07-29 sull'app viva:
        // 4 pane chiuse tenevano 2,1 GB di footprint, di cui 1,6 in un solo
        // processo, con una pane sola davvero aperta e lo swap al 95%.
        //
        // In un caso o nell'altro il messaggio parte prima della chiusura,
        // perche' vanno in coda sul main thread nell'ordine in cui li mandiamo,
        // e WebKit porta a termine il lavoro anche su una view staccata dalla
        // sua superview (e' la stessa proprieta' su cui contavano le pane
        // nascoste).
        if !free_native_webview(&wv, &label) {
            if let Ok(blank) = "about:blank".parse::<tauri::Url>() {
                let _ = no_abort("browser_evict_pane/navigate", || {
                    wv.navigate(blank).map_err(|e| e.to_string())
                });
            }
        }
        // La pane non esiste più: l'appunto sulla sua URL nemmeno, o una pane
        // nuova con lo stesso id erediterebbe la posizione della vecchia.
        forget_pane_url(&label);
        // Stessa ragione, sull'altro registro: il pid del suo WebContent non
        // descrive piu' niente di aperto. Lasciarlo dentro faceva comparire la
        // pane chiusa accanto alle vive nella lista per-scheda, perche' il
        // filtro a valle guarda solo se il pid e' vivo e col `retain` lo e'
        // sempre. La voce si toglie qui e non nella closure di `with_webview`:
        // quella e' best effort e puo' non atterrare, questa riga atterra
        // sempre. Riscriverla non puo': `refresh_webview_content_pids` visita
        // solo `app.webviews()`, dove questa etichetta sta per non esserci piu'.
        #[cfg(target_os = "macos")]
        forget_webview_content_pid(&label);
        if close {
            let _ = no_abort("browser_evict_pane/close", || {
                wv.close().map_err(|e| e.to_string())
            });
        }
    }
    // Drop the cache entries so a re-opened pane on the same id re-applies move + mask.
    if let Ok(mut g) = browser_bounds_cache().lock() {
        g.remove(id);
    }
    #[cfg(target_os = "macos")]
    if let Ok(mut g) = browser_corner_cache().lock() {
        g.remove(id);
    }
    // Unmap the dead WKWebView pointer (by pane value — the pointer itself is
    // gone with the close) and drop any queued failures nobody will drain.
    #[cfg(target_os = "macos")]
    if let Ok(mut g) = nav_pane_by_webview().lock() {
        g.retain(|_, v| v != id);
    }
    if let Ok(mut v) = NAV_ERROR_EVENTS.lock() {
        v.retain(|e| e.pane_id != id);
    }
    if let Ok(mut v) = NAV_STATE_EVENTS.lock() {
        v.retain(|e| e.pane_id != id);
    }
    // Symmetric with NAV_ERROR_EVENTS: drop queued download events nobody
    // will drain (browser_take_download_events only ever polls live ids).
    if let Ok(mut v) = DOWNLOAD_EVENTS.lock() {
        v.retain(|e| e.pane_id != id);
    }
}

/// Svuota le pane browser ospitate da `window_label`, PRIMA che la finestra se
/// ne vada.
///
/// Il momento è tutto. Su `Destroyed` le figlie non sono più raggiungibili:
/// l'evento arriva quando lo smontaggio è già finito, `app.webviews()` non le
/// elenca più e non c'è più nessuno a cui chiedere niente. Su `CloseRequested`
/// la finestra è ancora intera, quindi la webview c'è ancora ed è ancora
/// nominabile.
///
/// Qui c'era scritto che dopo resta comunque un guscio ObjC vuoto, perché wry
/// non lo dealloca mai. Non è più così: `browser_evict_pane` passa da
/// `-[WKWebView _close]`, quindi anche questa strada congeda il processo
/// WebContent invece di lasciarne uno vivo per finestra chiusa.
///
/// Non chiediamo la `close()`: la view la distrugge la finestra un istante
/// dopo, e quel messaggio in più al dispatcher non libererebbe un byte.
fn evict_panes_of_window(app: &tauri::AppHandle, window_label: &str) {
    use tauri::Manager;
    let _ = no_abort("evict_panes_of_window", || {
        let ids: Vec<String> = app
            .webviews()
            .into_iter()
            .filter(|(_, wv)| wv.window().label() == window_label)
            .filter_map(|(label, _)| pane_id_from_label(&label).map(str::to_string))
            .collect();
        for id in ids {
            eprintln!("[browser] finestra {window_label} in chiusura: svuoto la pane {id}");
            browser_evict_pane(app, &id, false, true);
        }
        Ok(())
    });
}

/// Chiude la vista di una pane e dice la VERITÀ su com'è andata.
///
/// L'esito è `Err` quando l'etichetta è ancora registrata alla fine, cioè
/// quando la vista NON è morta: `Webview::close()` toglie l'etichetta dal
/// manager in modo sincrono (è la distruzione dell'NSView a essere asincrona),
/// quindi trovarla ancora lì significa che la chiusura non è mai atterrata. In
/// quel caso l'etichetta si brucia, così la prossima `browser_open` sullo stesso
/// id crea una vista nuova invece di riusare quella morta.
fn browser_close_inner(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    // `purge_cache: false` di proposito: qui la cache la svuota il client, che
    // chiama `browser_purge_cache` per conto suo alla morte della pane.
    browser_evict_pane(&app, &id, true, false);
    // La vista è ancora registrata? Allora non è morta.
    let label = browser_label(&id);
    let survivor = app.get_webview(&label);
    if let Some(dead) = &survivor {
        // ULTIMA CHIAMATA PRIMA DI PERDERE L'INDIRIZZO. `close_verdict` sta per
        // bruciare l'etichetta, e da quel momento `browser_label(id)` ne indica
        // un'altra: questa vista resta appesa al manager senza che nessuno possa
        // piu' nominarla. Era una perdita permanente per costruzione, non un
        // caso sfortunato. Il suo WebContent lo si puo' ancora congedare, ed e'
        // adesso o mai piu'.
        //
        // Che sia il secondo `_close` sulla stessa vista non e' un problema: la
        // chiamata e' idempotente, provata due volte di fila sul banco. Nel caso
        // tipico (mutex avvelenato) fallira' come il primo, perche' passa dallo
        // stesso dispatcher; se invece a fallire era stato solo `close()`, qui
        // si recupera un processo intero.
        let _ = free_native_webview(dead, &label);
    }
    close_verdict(&id, survivor.is_some())
}

/// Il verdetto della chiusura, separato dal guscio per poterlo provare.
///
/// `still_registered` è `app.get_webview(&browser_label(id)).is_some()` dopo il
/// tentativo. Vero = la vista è sopravvissuta: si brucia la sua etichetta (così
/// il ramo di riuso di `browser_open` non la ritrova più) e si dichiara il
/// fallimento, invece di mentire con un `Ok` che manda il client a riaprire
/// sopra un morto.
fn close_verdict(id: &str, still_registered: bool) -> Result<(), String> {
    if !still_registered {
        return Ok(());
    }
    let gen = burn_pane_label(id);
    eprintln!("[browser_close] {id}: la vista ha rifiutato di chiudersi, etichetta bruciata (gen {gen})");
    Err(format!("browser_close: pane {id} refused to close"))
}

// ── Reclamo delle pane browser ───────────────────────────────────────────────
//
// Chiudere le pane quando la finestra se ne va copre il caso pulito. Non copre
// quello sporco, che è il solo che conta per il footprint: una UI ricaricata,
// una griglia rifatta, un crash del documento a metà smontaggio lasciano
// webview che nessuna interfaccia disegna più. Sono invisibili per definizione,
// quindi nessun bottone potrà mai chiuderle.
//
// L'inversione è questa: invece di chiedere a noi chi è morto, chiediamo ai vivi
// chi è loro. Ogni UI viva manda periodicamente l'elenco dei contextId che sta
// disegnando; una vista che nessun elenco fresco nomina, e che nessuno ha
// nominato per tutta la grazia, non ha più un padrone.
//
// L'orologio è il battito del client, non un timer in Rust. Un timer nostro
// girerebbe anche a UI morta o congelata, cioè proprio quando ogni pane sembra
// non reclamata: batterebbe più forte esattamente nel momento in cui sbaglia di
// più. Il battito, invece, non arriva quando non c'è nessuno a battere, e allora
// non si chiude niente.

/// Quello che una finestra ha detto di suo, e quando.
#[derive(Clone)]
struct WindowClaim {
    seen_ms: u64,
    ids: std::collections::HashSet<String>,
}

/// Una vista browser viva ADESSO, come la vede il verdetto.
///
/// `host` è la finestra che la ospita e `host_alive` dice se quella finestra
/// esiste ancora: sono due cose diverse, e la seconda è il caso in cui un
/// pop-out se n'è andato lasciandosi dietro la figlia.
struct LiveView {
    id: String,
    host: String,
    host_alive: bool,
}

/// label della finestra → il suo ultimo reclamo. Le finestre morte si tolgono a
/// ogni battito: un reclamo fossile terrebbe in vita per sempre le pane che
/// nominava.
static BROWSER_CLAIMS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, WindowClaim>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// id della pane → l'ultimo istante in cui qualcuno l'ha rivendicata, o il primo
/// avvistamento se non è mai successo.
///
/// Serve a dare una grazia a chi nasce, e nasce sempre non reclamato: fra la
/// `browser_open` e il battito che la nomina passa un giro, e senza questa
/// mappa il primo battito utile chiuderebbe la pane appena aperta.
static BROWSER_UNCLAIMED_SINCE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, u64>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Quanto vale un reclamo prima di diventare carta straccia. Il client batte
/// molto più spesso: un reclamo stantio non è «una UI in ritardo», è una UI che
/// non c'è più.
const CLAIM_FRESH_MS: u64 = 45_000;

/// Quanto tempo una pane può restare non reclamata prima di essere considerata
/// orfana. Copre il giro fra l'apertura e il primo battito che la nomina, e i
/// rimontaggi in cui la griglia si rifà da capo.
const CLAIM_GRACE_MS: u64 = 60_000;

/// Quali viste non ha più nessuno. Separata dal guscio Tauri per poterla
/// provare: la DECISIONE è il pezzo che può fare danno, la chiamata a WebKit no.
///
/// Le regole, in quest'ordine, e ognuna esiste per un caso che è già successo:
///
/// 1. Nominata da un reclamo FRESCO di una finestra QUALSIASI: intoccabile. Non
///    si guarda quale, perché `browser_open` ricade su `main` quando l'etichetta
///    della finestra è sconosciuta: una pane disegnata da un pop-out può essere
///    ospitata da `main`, e chiedere che a rivendicarla sia proprio l'ospite la
///    condannerebbe.
/// 2. Ospite sparito: orfana. Nessuna UI potrà mai più nominarla, e non c'è
///    finestra da cui chiuderla.
/// 3. Ospite vivo ma SENZA un reclamo fresco: intoccabile. È il caso del boot,
///    ed è la regressione da non fare: una finestra che si sta ancora aprendo ha
///    già le sue pane e non ha ancora una UI che possa battere. Silenzio non
///    vuol dire abbandono, vuol dire «non lo so ancora».
/// 4. Ospite con un reclamo fresco che NON la nomina: è il solo caso in cui il
///    silenzio è una risposta, perché quella UI ha parlato e non l'ha detta sua.
///    Anche qui però si aspetta la grazia, e un id mai visto prima resta
///    intoccabile: senza un istante da cui contare non c'è niente da scadere.
///
/// Corollario che vale la pena dire: se NESSUN reclamo è fresco, le uniche viste
/// che escono sono quelle senza ospite (regola 2), perché la 3 ferma tutte le
/// altre. E nel comando quel caso non si dà comunque, visto che chi chiama
/// registra il proprio reclamo prima di far girare le regole.
fn orphan_views(
    live: &[LiveView],
    claims: &std::collections::HashMap<String, WindowClaim>,
    unclaimed_since: &std::collections::HashMap<String, u64>,
    now_ms: u64,
    fresh_ms: u64,
    grace_ms: u64,
) -> Vec<String> {
    let is_fresh = |c: &WindowClaim| now_ms.saturating_sub(c.seen_ms) <= fresh_ms;
    let mut out: Vec<String> = Vec::new();
    // Due etichette possono risalire allo stesso id (una generazione bruciata
    // più la viva): `browser_evict_pane` ne indirizza una sola, quindi contarlo
    // due volte gonfierebbe soltanto il risultato.
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for v in live {
        if claims.values().any(|c| is_fresh(c) && c.ids.contains(&v.id)) {
            continue;
        }
        let orphan = if !v.host_alive {
            true
        } else {
            match claims.get(&v.host) {
                Some(c) if is_fresh(c) => match unclaimed_since.get(&v.id) {
                    Some(&since) => now_ms.saturating_sub(since) > grace_ms,
                    None => false,
                },
                _ => false,
            }
        };
        if orphan && seen.insert(v.id.as_str()) {
            out.push(v.id.clone());
        }
    }
    out
}

/// Il battito di una UI viva: «queste pane browser sono mie».
///
/// Registra il reclamo di `window`, poi passa in rassegna le viste vive e chiude
/// quelle che non ha più nessuno (vedi `orphan_views` per le regole). Ritorna
/// quante ne ha chiuse, che è anche il solo modo che il client ha di accorgersi
/// che sta perdendo pane senza volerlo.
///
/// La chiusura qui è quella piena: guscio incluso e cache restituita al disco.
/// A differenza della chiusura esplicita, non c'è un client a valle che possa
/// fare il resto per conto suo. Se ci fosse, la pane non sarebbe orfana.
#[tauri::command]
fn browser_claim(app: tauri::AppHandle, window: String, ids: Vec<String>) -> Result<usize, String> {
    no_abort("browser_claim", move || {
        use tauri::Manager;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let windows: std::collections::HashSet<String> = app.windows().into_keys().collect();

        let claims = {
            let mut g = BROWSER_CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
            g.insert(
                window.clone(),
                WindowClaim { seen_ms: now_ms, ids: ids.into_iter().collect() },
            );
            // Le finestre morte non rivendicano più niente. L'eccezione è chi ha
            // appena chiamato: un'etichetta che non risulta fra le finestre è
            // strana, ma buttarne via il reclamo significherebbe orfanare le pane
            // di chi sta parlando proprio ADESSO, ed è il danno peggiore fra i
            // due.
            g.retain(|label, _| windows.contains(label) || label == &window);
            g.clone()
        };

        // La verità su chi è vivo è `Manager::webviews()`, non un registro
        // nostro: stessa ragione di `browser_list`, un registro può divergere e
        // il runtime no.
        let live: Vec<LiveView> = app
            .webviews()
            .into_iter()
            .filter_map(|(label, wv)| {
                let id = pane_id_from_label(&label)?.to_string();
                let host = wv.window().label().to_string();
                let host_alive = windows.contains(&host);
                Some(LiveView { id, host, host_alive })
            })
            .collect();

        let unclaimed_since = {
            let mut g = BROWSER_UNCLAIMED_SINCE.lock().unwrap_or_else(|e| e.into_inner());
            let live_ids: std::collections::HashSet<&str> =
                live.iter().map(|v| v.id.as_str()).collect();
            // Le pane che non ci sono più non hanno una scadenza da tenere: se
            // un id tornasse, tornerebbe con la sua grazia intera invece che con
            // quella consumata da una vita precedente.
            g.retain(|id, _| live_ids.contains(id.as_str()));
            for v in &live {
                let claimed = claims
                    .values()
                    .any(|c| now_ms.saturating_sub(c.seen_ms) <= CLAIM_FRESH_MS && c.ids.contains(&v.id));
                if claimed {
                    g.insert(v.id.clone(), now_ms);
                } else {
                    g.entry(v.id.clone()).or_insert(now_ms);
                }
            }
            g.clone()
        };

        let orphans = orphan_views(
            &live,
            &claims,
            &unclaimed_since,
            now_ms,
            CLAIM_FRESH_MS,
            CLAIM_GRACE_MS,
        );
        for id in &orphans {
            let host = live
                .iter()
                .find(|v| &v.id == id)
                .map(|v| v.host.as_str())
                .unwrap_or("?");
            eprintln!("[browser_claim] pane {id} (ospite {host}) non la rivendica nessuno: chiusa");
            browser_evict_pane(&app, id, true, true);
            BROWSER_UNCLAIMED_SINCE
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id);
        }
        Ok(orphans.len())
    })
}

/// Purge a browser pane's PERSISTENT on-disk `WKWebsiteDataStore` — the cookie/
/// localStorage/IndexedDB silo keyed by `data_store_uuid_for(id)`. `browser_close`
/// frees the CONTENT (about:blank) but the persistent store lives on disk forever;
/// an audit on 2026-08-02 found ~1.1 GB accumulated across contexts that no pane
/// will ever reopen. This reclaims it.
///
/// ⚠️ DESTRUCTIVE + IRREVERSIBLE: this deletes the login/session for `id`.
///
/// NON è più il comando della chiusura. Lo era, ed era il baratto sbagliato: la
/// misura del 2026-08-12 sui 45 store veri (2,32 GB) dice che i cookie sono
/// **44 KB IN TUTTO** — un chilobyte a store — mentre il 70% dello spazio è
/// NetworkCache. Cancellare la sessione «per fare posto» buttava via un
/// chilobyte per liberarne cinquantamila, e il conto lo pagava chi riapriva la
/// tab e si ritrovava sloggato. La chiusura ora chiama `browser_purge_cache`,
/// che prende gli stessi byte lasciando l'identità.
///
/// Restano due chiamanti legittimi, ed entrambi hanno un permesso che la
/// chiusura non aveva: il reaper a scadenza (`browser_reap_data_stores`, uno
/// store che NESSUNA pane rivendica più) e — quando ci sarà — il comando
/// esplicito «Dimentica questo sito», dove a chiedere di dimenticare è l'utente.
///
/// macOS 14+ (`removeDataStoreForIdentifier:completionHandler:`); older systems
/// no-op via `respondsToSelector:`. Caveat: wry never deallocates the WKWebView
/// (`browser_close`'s retain-leak note), so if the just-closed view still pins the
/// store WebKit may answer the completion handler with an error — we log and move
/// on (no regression; the on-disk bytes are reclaimed on the next relaunch's close
/// when nothing pins them). Fire-and-forget: we don't block the caller on the
/// async completion.
#[tauri::command]
fn browser_purge_data_store(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_purge_data_store", move || {
        #[cfg(target_os = "macos")]
        {
            // Close first (idempotent) so the store has the best chance of being free.
            let _ = browser_close_inner(app.clone(), id.clone());
            use crate::mac::*;
            let bytes = data_store_uuid_for(&id);
            let id_for_log = id.clone();
            // WebKit class methods want the main thread + an autorelease pool;
            // hop onto it. Fire-and-forget — we don't join the async completion.
            let _ = app.run_on_main_thread(move || unsafe {
                let cls = class!(WKWebsiteDataStore);
                let sel = sel!(removeDataStoreForIdentifier:completionHandler:);
                let responds: BOOL = msg_send![cls, respondsToSelector: sel];
                if responds != YES {
                    return; // pre-macOS-14: no per-identifier removal API.
                }
                // NSUUID initWithUUIDBytes: wants a `const uuid_t` = `const u8[16]`.
                let uuid_alloc: id = msg_send![class!(NSUUID), alloc];
                let uuid: id = msg_send![uuid_alloc, initWithUUIDBytes: bytes.as_ptr()];
                if uuid == nil {
                    return;
                }
                let handler = block2::RcBlock::new(move |err: id| {
                    if err != nil {
                        let desc: id = msg_send![err, localizedDescription];
                        eprintln!(
                            "[browser_purge_data_store] {}: {}",
                            id_for_log,
                            nsobject_to_string(desc)
                        );
                    }
                });
                let _: () = msg_send![cls, removeDataStoreForIdentifier: uuid, completionHandler: &*handler];
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let label = browser_label(&id);
            let dir = pane_store_dir(&app, &id);
            // Il motore non si tocca dal thread principale, e questo comando e'
            // sincrono: il lavoro va su un worker. Fire-and-forget come il ramo
            // macOS, che nemmeno lui aspetta la completion di WebKit.
            tauri::async_runtime::spawn_blocking(move || {
                use tauri::Manager;
                // L'ORDINE CONTA, ED E' L'OPPOSTO DI MACOS. Prima si cancella
                // dal motore MENTRE la vista e' viva, poi si chiude, e la
                // cartella e' solo l'ultimo giro. Fidarsi della sola
                // `remove_dir_all` non cancellerebbe NIENTE su Windows: la
                // user-data folder resta aperta dall'environment WebView2
                // finche' quello vive, e su file in uso la rimozione fallisce
                // e basta. Su macOS il problema non si pone, perche' li' a
                // cancellare e' WebKit e non il filesystem.
                if let Some(wv) = app.get_webview(&label) {
                    #[cfg(target_os = "windows")]
                    let done = crate::browser_win::purge_all_blocking(&wv);
                    #[cfg(not(target_os = "windows"))]
                    let done = crate::browser_linux::purge_all_blocking(&wv);
                    if let Err(e) = done {
                        eprintln!("[browser_purge_data_store] {id}: {e}");
                    }
                }
                let _ = browser_close_inner(app.clone(), id.clone());
                // Quel che resta sono i file che l'environment teneva aperti:
                // se ne va al prossimo avvio, per mano del reaper, che quello
                // store lo trovera' orfano e fermo.
                if let Some(dir) = dir {
                    match std::fs::remove_dir_all(&dir) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => eprintln!(
                            "[browser_purge_data_store] {id}: {} non rimossa: {e}",
                            dir.display()
                        ),
                    }
                }
            });
        }
        Ok(())
    })
}

/// Svuota la CACHE dello store di una pane e lascia stare l'identità.
///
/// È il comando della chiusura, e sostituisce `browser_purge_data_store` in quel
/// ruolo. Misurato il 2026-08-12 su 45 store veri (2,32 GB su disco):
///
///   NetworkCache   1,65 GB   70%   ← rigenerabile, va via
///   Origins          685 MB   29%   ← localStorage/IndexedDB, RESTA
///   Cookies           44 KB    0%   ← il login, RESTA
///
/// Il 70% torna a ogni chiusura senza toccare il chilobyte che ti tiene dentro
/// il sito: il baratto «o il login o lo spazio» non esisteva, erano due
/// cassetti diversi dello stesso mobile.
///
/// I tipi rimossi sono le sole cache: disco, fetch, memoria e le registrazioni
/// dei service worker (una registrazione senza la sua CacheStorage è zavorra, e
/// si riscrive alla prima visita). NON tocca `Cookies`, `LocalStorage`,
/// `SessionStorage`, `IndexedDB` — sono l'identità sul sito.
///
/// macOS 14+ (`dataStoreForIdentifier:`, lo STESSO cancello di
/// `removeDataStoreForIdentifier:` che il purge totale già usa); più vecchio =
/// no-op via `respondsToSelector:`. Fire-and-forget come il fratello: non
/// aspettiamo la completion asincrona.
#[tauri::command]
fn browser_purge_cache(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_purge_cache", move || {
        #[cfg(target_os = "macos")]
        {
            use crate::mac::*;
            let bytes = data_store_uuid_for(&id);
            let id_for_log = id.clone();
            let _ = app.run_on_main_thread(move || unsafe {
                let cls = class!(WKWebsiteDataStore);
                let sel = sel!(dataStoreForIdentifier:);
                let responds: BOOL = msg_send![cls, respondsToSelector: sel];
                if responds != YES {
                    return; // pre-macOS-14: nessuno store per identifier.
                }
                let uuid_alloc: id = msg_send![class!(NSUUID), alloc];
                let uuid: id = msg_send![uuid_alloc, initWithUUIDBytes: bytes.as_ptr()];
                if uuid == nil {
                    return;
                }
                let store: id = msg_send![cls, dataStoreForIdentifier: uuid];
                if store == nil {
                    return;
                }
                let types = cache_only_data_types();
                if types == nil {
                    return;
                }
                // `distantPast` = tutta la cache, non solo la recente.
                let since: id = msg_send![class!(NSDate), distantPast];
                let handler = block2::RcBlock::new(move || {
                    let _ = &id_for_log; // il blocco possiede l'id solo per il log
                });
                let _: () = msg_send![store, removeDataOfTypes: types, modifiedSince: since, completionHandler: &*handler];
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            // FUORI DA MACOS LO STORE NON HA UN NOME: CE L'HA LA VISTA. E quello
            // decide sia da dove passa il comando sia QUANDO si puo' chiamare.
            //
            // Su macOS lo store si riapre per identifier, quindi la cache si
            // svuota anche a pane gia' morta, ed e' per questo che il client
            // chiamava questo comando DOPO `browser_close`. Qui l'unica strada
            // per il profilo WebView2 e per il `WebsiteDataManager` passa dalla
            // webview: a vista chiusa `get_webview` non trova piu' niente e
            // questo comando sarebbe un no-op muto, cioe' esattamente il guasto
            // che la card e' venuta a chiudere. Per questo `usePaneLifecycle`
            // ora svuota PRIMA di chiudere.
            //
            // E per lo stesso motivo non si passa da un worker: il comando e'
            // sincrono, cioe' gira gia' sul thread della UI, dove `with_webview`
            // esegue subito e in linea (tauri-runtime-wry, `send_user_message`).
            // Cosi' l'ordine fra questo comando e il `browser_close` che segue
            // resta quello in cui il client li ha mandati. Uno `spawn_blocking`
            // lo perderebbe: il worker si sveglierebbe a vista gia' chiusa. Non
            // si aspetta la fine della cancellazione, come su macOS.
            use tauri::Manager;
            let Some(wv) = app.get_webview(&browser_label(&id)) else {
                return Ok(());
            };
            #[cfg(target_os = "windows")]
            let done = crate::browser_win::purge_cache_detached(&wv);
            #[cfg(not(target_os = "windows"))]
            let done = crate::browser_linux::purge_cache_detached(&wv);
            if let Err(e) = done {
                eprintln!("[browser_purge_cache] {id}: {e}");
            }
        }
        Ok(())
    })
}

/// L'insieme `NSSet` dei soli tipi-cache di WebKit.
///
/// Le costanti sono simboli esterni del framework WebKit (già linkato da wry),
/// non stringhe che ci scriviamo noi: se un giorno cambiassero valore, un
/// letterale sbagliato non cancellerebbe NULLA e nessuno se ne accorgerebbe —
/// il link, invece, o regge o non compila.
#[cfg(target_os = "macos")]
unsafe fn cache_only_data_types() -> crate::mac::id {
    use crate::mac::*;
    extern "C" {
        static WKWebsiteDataTypeDiskCache: id;
        static WKWebsiteDataTypeFetchCache: id;
        static WKWebsiteDataTypeMemoryCache: id;
        static WKWebsiteDataTypeServiceWorkerRegistrations: id;
    }
    let items: [id; 4] = [
        WKWebsiteDataTypeDiskCache,
        WKWebsiteDataTypeFetchCache,
        WKWebsiteDataTypeMemoryCache,
        WKWebsiteDataTypeServiceWorkerRegistrations,
    ];
    msg_send![class!(NSSet), setWithObjects: items.as_ptr(), count: items.len()]
}

/// Un record dello store: il nome del silo WebKit e i tipi di dato che tiene.
///
/// `displayName` NON è l'host della pagina: WebKit raggruppa per dominio
/// registrabile (su `mail.google.com` il record si chiama `google.com` e copre
/// tutti i sottodomini). È il nome vero della cosa che si cancella, quindi è
/// quello che il dialogo mostra e quello che la rimozione riceve indietro.
///
/// La forma è la stessa su tutte e tre le piattaforme, perché è il contratto che
/// legge `browserForgetSite.ts`. Cambia solo da dove i record arrivano: su
/// macOS e Linux dal motore, su Windows dai cookie (vedi
/// [`cookie_domain_records`], che spiega perché non c'è di meglio).
#[derive(Serialize)]
struct SiteDataRecordJson {
    #[serde(rename = "displayName")]
    display_name: String,
    types: Vec<String>,
}

/// Il nome di record che si dà a un dominio di cookie: minuscolo e senza il
/// punto iniziale.
///
/// Il punto davanti (`.github.com`) è la notazione del barattolo per «e i suoi
/// sottodomini», non un nome di sito: lasciandolo, il dialogo elencherebbe
/// `github.com` e `.github.com` come due cose diverse, e la rimozione ne
/// troverebbe una sola.
//
// Serve solo al ramo WebView2, ma NON è cfg-gated: è una decisione pura, e le
// decisioni pure si provano con `cargo test`, che su questa macchina compila il
// ramo macOS. Il gate qui la renderebbe non collaudabile proprio dove la si
// scrive.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn cookie_record_name(domain: &str) -> String {
    domain.trim().trim_start_matches('.').to_ascii_lowercase()
}

/// I record «per sito» ricavabili da una lista di domini di cookie: uno per
/// dominio, con `cookies` come unico tipo.
///
/// È la forma che WebView2 permette, e non è una scorciatoia: l'SDK non ha
/// NESSUNA API per-origine. `ClearBrowsingData` prende dei kind e li applica al
/// profilo intero, e l'unica cosa enumerabile per sito è il barattolo dei
/// cookie. Quindi su Windows «dimentica questo sito» toglie la SESSIONE e non
/// il localStorage, e il record lo dice: elenca `cookies` e nient'altro, perché
/// la regola è che si cancella esattamente ciò che si è detto.
///
/// Niente eTLD+1: il dominio grezzo del cookie basta, perché `matchSiteRecords`
/// nel client confronta host e nome del record in tutte e due le direzioni della
/// parentela. Ricavare il dominio registrabile vorrebbe dire portarsi dentro la
/// Public Suffix List per un guadagno che il client fa già.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn cookie_domain_records(domains: &[String]) -> Vec<SiteDataRecordJson> {
    let mut names: Vec<String> = domains
        .iter()
        .map(|d| cookie_record_name(d))
        .filter(|d| !d.is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|display_name| SiteDataRecordJson {
            display_name,
            types: vec!["cookies".to_string()],
        })
        .collect()
}

/// La chiave stabile di un `WKWebsiteDataType`, per il client.
///
/// Il confronto è con i simboli del framework, non con letterali nostri: stessa
/// ragione di `cache_only_data_types` — un letterale sbagliato non
/// corrisponderebbe a niente e nessuno se ne accorgerebbe, mentre il link o
/// regge o non compila. Un tipo che non conosciamo torna col suo nome grezzo:
/// il client lo mette nel mucchio «dati del sito» invece di perderlo.
#[cfg(target_os = "macos")]
unsafe fn site_data_type_key(t: crate::mac::id) -> String {
    use crate::mac::*;
    extern "C" {
        static WKWebsiteDataTypeCookies: id;
        static WKWebsiteDataTypeLocalStorage: id;
        static WKWebsiteDataTypeSessionStorage: id;
        static WKWebsiteDataTypeIndexedDBDatabases: id;
        static WKWebsiteDataTypeWebSQLDatabases: id;
        static WKWebsiteDataTypeDiskCache: id;
        static WKWebsiteDataTypeMemoryCache: id;
        static WKWebsiteDataTypeFetchCache: id;
        static WKWebsiteDataTypeOfflineWebApplicationCache: id;
        static WKWebsiteDataTypeServiceWorkerRegistrations: id;
    }
    let known: [(id, &str); 10] = [
        (WKWebsiteDataTypeCookies, "cookies"),
        (WKWebsiteDataTypeLocalStorage, "localStorage"),
        (WKWebsiteDataTypeSessionStorage, "sessionStorage"),
        (WKWebsiteDataTypeIndexedDBDatabases, "indexedDB"),
        (WKWebsiteDataTypeWebSQLDatabases, "webSql"),
        (WKWebsiteDataTypeDiskCache, "diskCache"),
        (WKWebsiteDataTypeMemoryCache, "memoryCache"),
        (WKWebsiteDataTypeFetchCache, "fetchCache"),
        (WKWebsiteDataTypeOfflineWebApplicationCache, "offlineAppCache"),
        (WKWebsiteDataTypeServiceWorkerRegistrations, "serviceWorkers"),
    ];
    for (constant, key) in known {
        let same: BOOL = msg_send![t, isEqual: constant];
        if same == YES {
            return key.to_string();
        }
    }
    nsobject_to_string(t)
}

/// Elenca i record dello store della pane: `[{displayName, types:[…]}, …]`.
///
/// Ponte async-objc identico a `cookies_get_blocking` (il completion handler di
/// `fetchDataRecordsOfTypes:` gira SUL MAIN, il risultato torna su un canale),
/// quindi va chiamata fuori dal main thread.
///
/// Store e insieme dei tipi si ri-derivano DENTRO il handler invece di
/// catturarli: sono oggetti autoreleased del giro corrente, e il handler
/// arriva dopo che quel pool si è svuotato. La WKWebView, che è viva quanto la
/// pane, si cattura e basta.
#[cfg(target_os = "macos")]
fn site_data_records_blocking(wv: &tauri::Webview) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        use crate::mac::*;
        unsafe {
            let wk = platform.inner() as id; // WKWebView
            let config: id = msg_send![wk, configuration];
            let store: id = msg_send![config, websiteDataStore];
            let all: id = msg_send![class!(WKWebsiteDataStore), allWebsiteDataTypes];
            let handler = block2::RcBlock::new(move |records: id| {
                let mut out: Vec<SiteDataRecordJson> = Vec::new();
                if records != nil {
                    let count: usize = msg_send![records, count];
                    for i in 0..count {
                        let rec: id = msg_send![records, objectAtIndex: i];
                        if rec == nil {
                            continue;
                        }
                        let name: id = msg_send![rec, displayName];
                        let types: id = msg_send![rec, dataTypes];
                        let mut keys: Vec<String> = Vec::new();
                        if types != nil {
                            let list: id = msg_send![types, allObjects];
                            let n: usize = msg_send![list, count];
                            for j in 0..n {
                                let t: id = msg_send![list, objectAtIndex: j];
                                if t != nil {
                                    keys.push(site_data_type_key(t));
                                }
                            }
                        }
                        keys.sort();
                        out.push(SiteDataRecordJson {
                            display_name: nsobject_to_string(name),
                            types: keys,
                        });
                    }
                }
                let _ = tx.send(serde_json::to_string(&out).map_err(|e| e.to_string()));
            });
            let _: () = msg_send![store, fetchDataRecordsOfTypes: all, completionHandler: &*handler];
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|_| "site data records timeout".to_string())?
}

/// Rimuove dallo store della pane SOLO i record che si chiamano come uno dei
/// `names`, con tutti i loro tipi di dato. Ritorna quanti record ha tolto.
///
/// Il filtro sta qui e non in `removeDataOfTypes:modifiedSince:` perché quello
/// è per-store, e lo store è per-pane: userebbe il martello di
/// `browser_purge_data_store` per un chiodo per-sito.
///
/// I nomi arrivano da un `browser_site_data_records` che il client ha già
/// mostrato all'utente: si cancella l'elenco che è stato letto, non «tutto ciò
/// che assomiglia a quell'host». Un record comparso nel frattempo non è nella
/// lista, quindi non muore per sbaglio.
#[cfg(target_os = "macos")]
fn forget_site_blocking(wv: &tauri::Webview, names: Vec<String>) -> Result<usize, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel::<Result<usize, String>>();
    wv.with_webview(move |platform| {
        use crate::mac::*;
        unsafe {
            let wk = platform.inner() as id; // WKWebView
            let config: id = msg_send![wk, configuration];
            let store: id = msg_send![config, websiteDataStore];
            let all: id = msg_send![class!(WKWebsiteDataStore), allWebsiteDataTypes];
            let handler = block2::RcBlock::new(move |records: id| {
                let victims: id = msg_send![class!(NSMutableArray), array];
                let mut hit = 0usize;
                if records != nil {
                    let count: usize = msg_send![records, count];
                    for i in 0..count {
                        let rec: id = msg_send![records, objectAtIndex: i];
                        if rec == nil {
                            continue;
                        }
                        let name: id = msg_send![rec, displayName];
                        if names.contains(&nsobject_to_string(name)) {
                            let _: () = msg_send![victims, addObject: rec];
                            hit += 1;
                        }
                    }
                }
                if hit == 0 {
                    let _ = tx.send(Ok(0));
                    return;
                }
                // Il pool corrente non è ancora sceso: store e tipi si
                // ri-derivano qui e restano validi per la chiamata.
                let config: id = msg_send![wk, configuration];
                let store: id = msg_send![config, websiteDataStore];
                let all: id = msg_send![class!(WKWebsiteDataStore), allWebsiteDataTypes];
                let tx_done = tx.clone();
                let done = block2::RcBlock::new(move || {
                    let _ = tx_done.send(Ok(hit));
                });
                let _: () = msg_send![store, removeDataOfTypes: all, forDataRecords: victims, completionHandler: &*done];
            });
            let _: () = msg_send![store, fetchDataRecordsOfTypes: all, completionHandler: &*handler];
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(15))
        .map_err(|_| "forget site timeout".to_string())?
}

/// Elenca cosa c'è nello store di questa pane, per sito. JSON:
/// `[{"displayName":"github.com","types":["cookies","localStorage",…]}, …]`.
///
/// È la metà «dire prima» del comando «Dimentica questo sito»: senza questa
/// lista il dialogo direbbe soltanto «cancello i dati», che è la frase per cui
/// un comando distruttivo si preme una volta e non si preme mai più.
///
/// Parità piena su Linux (`WebsiteDataManager::fetch`). Su Windows l'elenco è
/// più corto e non per svista: WebView2 non ha nessuna API per-origine, quindi
/// i record si ricavano dai cookie e portano solo `cookies`. Vedi
/// `cookie_domain_records`.
///
/// Async + spawn_blocking per lo stesso motivo di `browser_pane_get_cookies`
/// (completion handler sul main; un comando sincrono bloccherebbe il main).
#[tauri::command]
async fn browser_site_data_records(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let label = browser_label(&id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "macos")]
        {
            return site_data_records_blocking(&wv);
        }
        #[cfg(target_os = "windows")]
        {
            return crate::browser_win::site_data_records_blocking(&wv);
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            return crate::browser_linux::site_data_records_blocking(&wv);
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Dimentica i siti nominati in `display_names`: sessione, cookie, dati e cache
/// dei loro record, e nient'altro. Ritorna quanti record ha rimosso.
///
/// ⚠️ DISTRUTTIVO E IRREVERSIBILE, ma per-SITO: lo store della pane resta, con
/// dentro tutti gli altri siti. Il fratello che butta lo store intero è
/// `browser_purge_data_store`, e ha un solo chiamante rimasto (il reaper).
///
/// SU WINDOWS DIMENTICA MENO, e il dialogo lo dice perché l'elenco che gli
/// arriva porta solo `cookies`: WebView2 non ha nessuna API per-origine, quindi
/// si cancella la sessione e NON il localStorage. macOS e Linux tolgono tutto
/// (`WKWebsiteDataStore` / `WebsiteDataManager` sanno lavorare per record).
#[tauri::command]
async fn browser_forget_site(
    app: tauri::AppHandle,
    id: String,
    display_names: Vec<String>,
) -> Result<usize, String> {
    if display_names.is_empty() {
        return Ok(0);
    }
    let label = browser_label(&id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "macos")]
        {
            return forget_site_blocking(&wv, display_names);
        }
        #[cfg(target_os = "windows")]
        {
            return crate::browser_win::forget_site_blocking(&wv, display_names);
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            return crate::browser_linux::forget_site_blocking(&wv, display_names);
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Il reaper della coda lunga: rimuove per INTERO gli store che nessuna pane
/// rivendica più e che nessuno tocca da `max_age_days` giorni.
///
/// È la seconda metà della politica: da quando la chiusura conserva il login,
/// gli store non se ne vanno più da soli, e senza uno spazzino il disco
/// crescerebbe per sempre. Ma «vecchio» da solo non basta come permesso —
/// il sito che apri due volte l'anno è proprio quello di cui NON vuoi rifare il
/// login. Servono due condizioni insieme:
///
///   1. ORFANO — `keep_ids` è la lista dei contextId che hanno ancora una pane,
///      e la manda il client, che è l'unico ad averla per intero (il suo pane
///      store è sincronizzato tra i device, quindi copre anche le pane aperte
///      sul telefono). Uno store nella lista è intoccabile a QUALSIASI età.
///   2. FERMO — nessun file suo modificato da `max_age_days` giorni.
///
/// `max_age_days` ha un pavimento di 7 giorni (`MIN_REAP_AGE_DAYS`): se un
/// giorno un chiamante sbagliasse a passare 0, il peggio che può fare è
/// rimuovere store fermi da una settimana e orfani — non svuotare il browser.
///
/// Ritorna quanti store ha rimosso.
#[tauri::command]
fn browser_reap_data_stores(
    app: tauri::AppHandle,
    keep_ids: Vec<String>,
    max_age_days: u64,
) -> Result<usize, String> {
    no_abort("browser_reap_data_stores", move || {
        #[cfg(target_os = "macos")]
        {
            let dir = match website_data_store_dir() {
                Some(d) => d,
                None => return Ok(0),
            };
            let victims = stale_store_uuids(&dir, &keep_ids, max_age_days, std::time::SystemTime::now());
            let n = victims.len();
            for uuid_str in victims {
                let bytes = match uuid_bytes_from_str(&uuid_str) {
                    Some(b) => b,
                    None => continue,
                };
                let name = uuid_str.clone();
                let _ = app.run_on_main_thread(move || unsafe {
                    use crate::mac::*;
                    let cls = class!(WKWebsiteDataStore);
                    let sel = sel!(removeDataStoreForIdentifier:completionHandler:);
                    let responds: BOOL = msg_send![cls, respondsToSelector: sel];
                    if responds != YES {
                        return;
                    }
                    let uuid_alloc: id = msg_send![class!(NSUUID), alloc];
                    let uuid: id = msg_send![uuid_alloc, initWithUUIDBytes: bytes.as_ptr()];
                    if uuid == nil {
                        return;
                    }
                    let handler = block2::RcBlock::new(move |err: id| {
                        if err != nil {
                            let desc: id = msg_send![err, localizedDescription];
                            eprintln!(
                                "[browser_reap_data_stores] {}: {}",
                                name,
                                nsobject_to_string(desc)
                            );
                        }
                    });
                    let _: () = msg_send![cls, removeDataStoreForIdentifier: uuid, completionHandler: &*handler];
                });
            }
            Ok(n)
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Fuori da macOS lo store È una cartella (vedi `pane_store_dir`),
            // quindi qui il reaper è filesystem puro: stessa decisione, stessi
            // due permessi, e al posto della chiamata a WebKit una
            // `remove_dir_all`.
            let dir = match pane_store_root(&app) {
                Some(d) => d,
                None => return Ok(0),
            };
            let victims =
                stale_store_uuids(&dir, &keep_ids, max_age_days, std::time::SystemTime::now());
            let n = victims.len();
            // La rimozione va su un worker perché questo comando è sincrono,
            // cioè gira sul thread principale, e una `remove_dir_all` su store
            // da centinaia di megabyte lì sopra si vede. Il numero restituito è
            // quanti store sono stati CONDANNATI, esattamente come sul ramo
            // macOS: anche lì a cancellare è qualcun altro, e nessuno aspetta.
            tauri::async_runtime::spawn_blocking(move || {
                for uuid_str in victims {
                    let path = dir.join(&uuid_str);
                    if let Err(e) = std::fs::remove_dir_all(&path) {
                        eprintln!("[browser_reap_data_stores] {uuid_str}: {e}");
                    }
                }
            });
            Ok(n)
        }
    })
}

/// Pavimento sull'età del reaper — vedi `browser_reap_data_stores`.
const MIN_REAP_AGE_DAYS: u64 = 7;

/// La cartella dove WebKit tiene gli store per identifier.
///
/// Il nome della sottocartella è l'identificatore del bundle quando l'app è
/// impacchettata e il nome del processo quando gira da `cargo run`: lo chiede a
/// NSBundle invece di indovinarlo, o in sviluppo il reaper spazzerebbe la
/// cartella dell'app installata (o viceversa).
#[cfg(target_os = "macos")]
fn website_data_store_dir() -> Option<std::path::PathBuf> {
    use crate::mac::*;
    let name = unsafe {
        let bundle: id = msg_send![class!(NSBundle), mainBundle];
        let ident: id = if bundle == nil { nil } else { msg_send![bundle, bundleIdentifier] };
        if ident != nil {
            nsobject_to_string(ident)
        } else {
            let pi: id = msg_send![class!(NSProcessInfo), processInfo];
            let pn: id = if pi == nil { nil } else { msg_send![pi, processName] };
            if pn == nil {
                return None;
            }
            nsobject_to_string(pn)
        }
    };
    if name.is_empty() {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    Some(
        std::path::PathBuf::from(home)
            .join("Library/WebKit")
            .join(name)
            .join("WebsiteDataStore"),
    )
}

/// Quali store sono da rimuovere: orfani E fermi. Separata dal guscio che
/// cancella per poterla provare su una cartella finta — la decisione È il pezzo
/// rischioso, la chiamata al motore no.
///
/// Vale su tutte le piattaforme: qui dentro non c'è una riga di ObjC, e le
/// cartelle si chiamano allo stesso modo ovunque (`pane_store_dir_name`).
/// Cambia solo la radice, e la passa il chiamante.
fn stale_store_uuids(
    dir: &std::path::Path,
    keep_ids: &[String],
    max_age_days: u64,
    now: std::time::SystemTime,
) -> Vec<String> {
    let age = std::time::Duration::from_secs(max_age_days.max(MIN_REAP_AGE_DAYS) * 86_400);
    let keep: std::collections::HashSet<String> =
        keep_ids.iter().map(|id| pane_store_dir_name(id)).collect();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if uuid_bytes_from_str(&name).is_none() {
            continue; // non è uno store per identifier: non è roba nostra.
        }
        if keep.contains(&name) {
            continue; // una pane lo rivendica: intoccabile a qualsiasi età.
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // L'mtime della cartella radice non si muove quando cambia un file in
        // fondo a `Origins/`: si prende il PIÙ RECENTE tra la radice e i suoi
        // figli diretti (Cookies/, NetworkCache/, Origins/…). Un livello basta a
        // non dichiarare fermo uno store vivo, e costa una readdir.
        let touched = newest_mtime_shallow(&path);
        match now.duration_since(touched) {
            Ok(elapsed) if elapsed >= age => out.push(name),
            _ => {}
        }
    }
    out.sort();
    out
}

/// L'mtime più recente tra una cartella e i suoi figli diretti.
fn newest_mtime_shallow(path: &std::path::Path) -> std::time::SystemTime {
    let mut newest = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH);
    if let Ok(children) = std::fs::read_dir(path) {
        for child in children.flatten() {
            if let Ok(m) = child.metadata().and_then(|m| m.modified()) {
                if m > newest {
                    newest = m;
                }
            }
        }
    }
    newest
}

/// I 16 byte di un UUID scritto `8-4-4-4-12`, o `None` se non lo è.
fn uuid_bytes_from_str(s: &str) -> Option<[u8; 16]> {
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 || s.len() != 36 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// L'inverso: i 16 byte nella forma minuscola `8-4-4-4-12` con cui WebKit
/// nomina la cartella dello store.
fn uuid_str_from_bytes(b: &[u8; 16]) -> String {
    let h: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        h[0..4].concat(),
        h[4..6].concat(),
        h[6..8].concat(),
        h[8..10].concat(),
        h[10..16].concat()
    )
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
fn eval_js_blocking(wv: &tauri::Webview, js: String, preserve_focus: bool) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        use crate::mac::*;
        unsafe fn id_to_string(obj: *mut objc2::runtime::AnyObject) -> String {
            use crate::mac::*;
            use std::ffi::CStr;
            use std::os::raw::c_char;
            if obj == nil {
                return String::new();
            }
            // `description` is defined on every NSObject and returns an NSString; for an
            // NSString it IS the string, so this stringifies ANY JS result type safely.
            let desc: *mut objc2::runtime::AnyObject = msg_send![obj, description];
            let c: *const c_char = msg_send![desc, UTF8String];
            if c.is_null() { String::new() } else { CStr::from_ptr(c).to_string_lossy().into_owned() }
        }
        unsafe {
            let wk = platform.inner() as id; // WKWebView
            // Focus-neutral eval. Agent actions (ACT_FN fill/type/press) call
            // `el.focus()` on a page field, which makes THIS pane's WKWebView the
            // window first-responder — yanking OS key focus off wherever the user was
            // typing (e.g. a chat input in the main webview). When the caller asks to
            // preserve focus, snapshot the window's first-responder BEFORE the JS runs
            // and restore it in the completion handler if the eval grabbed it. Read
            // polls don't set the flag, so the constant title/url poll pays nothing.
            // Pointers captured as usize (Copy/Send) for the completion block.
            let (win_u, saved_fr_u): (usize, usize) = if preserve_focus {
                let w: id = msg_send![wk, window];
                let fr: id = if w != nil { msg_send![w, firstResponder] } else { nil };
                (w as usize, fr as usize)
            } else {
                (0, 0)
            };
            // callAsyncJavaScript: (macOS 11+) treats the string as an async function
            // BODY and AWAITS a returned Promise — the fix for async IIFEs / top-level
            // await that the old evaluateJavaScript: returned as an "unsupported type"
            // Promise. We wrap the caller's expression as `return await (...)`: `await`
            // on a plain value is a no-op, so every existing synchronous caller (all the
            // JSON.stringify(...) shared fns) round-trips the identical string, while an
            // async expression now resolves before marshalling. pageWorld matches the
            // old default so CONSOLE_PROXY_JS's window.__topicsConsole stays readable
            // (defaultClientWorld would hide it). NOTE: a multi-STATEMENT free-form
            // browser_eval (e.g. `let x=1; x`) must carry its own `return`; agents send
            // a single expression or an async IIFE, both of which wrap cleanly.
            let body = format!("return await ({});", js);
            let nsjs_ns = nsstring(&body);
            let nsjs: id = objc2::rc::Retained::as_ptr(&nsjs_ns) as id;
            // Empty arguments dict (nil asserts on some SDKs); page-world content world.
            let args: id = msg_send![class!(NSDictionary), dictionary];
            let world: id = msg_send![class!(WKContentWorld), pageWorld];
            let tx2 = tx.clone();
            let handler = block2::RcBlock::new(move |result: id, error: id| {
                // Restore the pre-eval first-responder if the JS grabbed it onto this
                // pane (an agent action focused a field). No-op when focus didn't move
                // or when the user was already in this pane (saved == current).
                if win_u != 0 && saved_fr_u != 0 {
                    let w = win_u as id;
                    let now_fr: id = msg_send![w, firstResponder];
                    if now_fr as usize != saved_fr_u {
                        let _: () = msg_send![w, makeFirstResponder: saved_fr_u as id];
                    }
                }
                let out = if error != nil { Err(id_to_string(error)) } else { Ok(id_to_string(result)) };
                let _ = tx2.send(out);
            });
            let _: () = msg_send![wk,
                callAsyncJavaScript: nsjs,
                arguments: args,
                inFrame: nil,
                inContentWorld: world,
                completionHandler: &*handler];
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
async fn browser_eval_js(app: tauri::AppHandle, id: String, js: String, preserve_focus: Option<bool>) -> Result<String, String> {
    let label = browser_label(&id);
    let preserve_focus = preserve_focus.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "macos")]
        {
            return eval_js_blocking(&wv, js, preserve_focus);
        }
        #[cfg(target_os = "windows")]
        {
            return crate::browser_win::eval_js_blocking(&wv, js, preserve_focus);
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            return crate::browser_linux::eval_js_blocking(&wv, js, preserve_focus);
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
unsafe fn nsimage_to_png_base64(img: *mut objc2::runtime::AnyObject) -> Result<String, String> {
    use crate::mac::*;
    use std::ffi::CStr;
    use std::os::raw::c_char;
    if img == nil {
        return Err("nil NSImage".to_string());
    }
    // NSImage → CGImage → NSBitmapImageRep → PNG NSData → base64 NSString.
    let null_rect: *const objc2_foundation::NSRect = std::ptr::null();
    let cg: id = msg_send![img, CGImageForProposedRect: null_rect, context: nil, hints: nil];
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
    let png: id = msg_send![rep, representationUsingType: 4u64, properties: props];
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
        use crate::mac::*;
        unsafe {
            let wk = platform.inner() as id;
            let cfg: id = msg_send![class!(WKSnapshotConfiguration), new];
            let tx2 = tx.clone();
            let handler = block2::RcBlock::new(move |img: id, err: id| {
                let out: Result<String, String> = if err != nil {
                    Err("takeSnapshot failed".to_string())
                } else {
                    nsimage_to_png_base64(img)
                };
                let _ = tx2.send(out);
            });
            let _: () = msg_send![wk, takeSnapshotWithConfiguration: cfg, completionHandler: &*handler];
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
        #[cfg(target_os = "windows")]
        {
            return crate::browser_win::screenshot_blocking(&wv);
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            return crate::browser_linux::screenshot_blocking(&wv);
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Cookies (WKHTTPCookieStore) ──────────────────────────────────────────────
// Read/write the pane's cookie jar so the server's save_state / load_state /
// import_chrome tools work on the NATIVE pane (they speak Playwright
// storageState JSON — server/browser-login-state.ts StorageCookie). WKWebView
// has no CDP; the jar is `webview.configuration.websiteDataStore.httpCookieStore`
// (the pane's OWN isolated store when opened with `isolate`, the shared default
// store otherwise — so on non-isolated panes a set_cookies leaks into every
// other non-isolated pane; documented semantics, not a bug). Unlike
// document.cookie this reaches httpOnly cookies too.

/// Playwright storageState cookie — the wire shape both new cookie commands
/// speak (matches server/browser-login-state.ts `StorageCookie`).
/// `expires`: epoch seconds, -1 (or absent) = session cookie.
#[derive(Clone, Serialize, Deserialize)]
struct CookieJson {
    name: String,
    value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires: Option<f64>,
    #[serde(rename = "httpOnly", skip_serializing_if = "Option::is_none")]
    http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secure: Option<bool>,
    #[serde(rename = "sameSite", skip_serializing_if = "Option::is_none")]
    same_site: Option<String>,
}

/// NSString (or any NSObject via `description`) → Rust String. nil → "".
/// SAFETY: `obj` must be nil or a valid ObjC object.
#[cfg(target_os = "macos")]
unsafe fn nsobject_to_string(obj: *mut objc2::runtime::AnyObject) -> String {
    use crate::mac::*;
    use std::ffi::CStr;
    use std::os::raw::c_char;
    if obj == nil {
        return String::new();
    }
    let desc: *mut objc2::runtime::AnyObject = msg_send![obj, description];
    let c: *const c_char = msg_send![desc, UTF8String];
    if c.is_null() { String::new() } else { CStr::from_ptr(c).to_string_lossy().into_owned() }
}

/// `[dict setObject:<NSString val> forKey:<NSString key>]` — property-dict helper
/// for `NSHTTPCookie cookieWithProperties:`. SAFETY: `dict` must be a valid
/// NSMutableDictionary.
#[cfg(target_os = "macos")]
unsafe fn ns_dict_set_str(dict: *mut objc2::runtime::AnyObject, key: &str, val: &str) {
    use crate::mac::*;
    let k_ns = nsstring(key);
    let k: id = objc2::rc::Retained::as_ptr(&k_ns) as id;
    let v_ns = nsstring(val);
    let v: id = objc2::rc::Retained::as_ptr(&v_ns) as id;
    let _: () = msg_send![dict, setObject: v, forKey: k];
}

/// Dump the pane's WKHTTPCookieStore as storageState-cookie JSON (a serialized
/// `Vec<CookieJson>`). Same async-objc bridge as `eval_js_blocking`: the
/// `getAllCookies:` completion handler runs ON MAIN, its result crosses back on
/// a channel — so this MUST be called off-main (see browser_eval_js's rationale).
#[cfg(target_os = "macos")]
fn cookies_get_blocking(wv: &tauri::Webview) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        use crate::mac::*;
        unsafe {
            let wk = platform.inner() as id; // WKWebView
            let config: id = msg_send![wk, configuration];
            let store: id = msg_send![config, websiteDataStore];
            let jar: id = msg_send![store, httpCookieStore];
            let tx2 = tx.clone();
            let handler = block2::RcBlock::new(move |cookies: id| {
                let mut list: Vec<CookieJson> = Vec::new();
                if cookies != nil {
                    let count: usize = msg_send![cookies, count];
                    for i in 0..count {
                        let c: id = msg_send![cookies, objectAtIndex: i];
                        if c == nil {
                            continue;
                        }
                        let name: id = msg_send![c, name];
                        let value: id = msg_send![c, value];
                        let domain: id = msg_send![c, domain];
                        let path: id = msg_send![c, path];
                        // nil expiresDate = session cookie → Playwright's -1.
                        let exp: id = msg_send![c, expiresDate];
                        let expires: f64 = if exp == nil {
                            -1.0
                        } else {
                            msg_send![exp, timeIntervalSince1970]
                        };
                        let secure: BOOL = msg_send![c, isSecure];
                        let http_only: BOOL = msg_send![c, isHTTPOnly];
                        // sameSitePolicy: NSString @"lax"/@"strict", nil = no
                        // restriction → storageState's "None".
                        let ss: id = msg_send![c, sameSitePolicy];
                        let same_site = if ss == nil {
                            "None".to_string()
                        } else {
                            match nsobject_to_string(ss).to_ascii_lowercase().as_str() {
                                "lax" => "Lax".to_string(),
                                "strict" => "Strict".to_string(),
                                _ => "None".to_string(),
                            }
                        };
                        list.push(CookieJson {
                            name: nsobject_to_string(name),
                            value: nsobject_to_string(value),
                            domain: Some(nsobject_to_string(domain)),
                            path: Some(nsobject_to_string(path)),
                            expires: Some(expires),
                            http_only: Some(http_only == YES),
                            secure: Some(secure == YES),
                            same_site: Some(same_site),
                        });
                    }
                }
                let _ = tx2.send(serde_json::to_string(&list).map_err(|e| e.to_string()));
            });
            let _: () = msg_send![jar, getAllCookies: &*handler];
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|_| "get cookies timeout".to_string())?
}

/// Message channel for cookies_set_blocking: the with_webview closure first
/// reports how many cookies were valid vs skipped, then one Done per
/// `setCookie:completionHandler:` completion. All sends happen on the main
/// thread in program order, so Counts always arrives first.
#[cfg(target_os = "macos")]
enum CookieSetMsg {
    Counts { set: usize, skipped: usize },
    Done,
}

/// Inject storageState cookies into the pane's WKHTTPCookieStore. Builds each
/// `NSHTTPCookie cookieWithProperties:` from the documented literal keys
/// ("Name"/"Value"/"Domain"/"Path"/"Expires"/"Secure"); httpOnly rides the
/// UNDOCUMENTED "HttpOnly" key (works in practice — Cordova/Capacitor rely on
/// it — worst case the cookie lands non-httpOnly, which still authenticates).
/// Cookies with no domain, or that NSHTTPCookie rejects (nil), are counted as
/// skipped. Returns `{"set":n,"skipped":m}`. Off-main only (main-thread
/// completion handlers, same as cookies_get_blocking).
#[cfg(target_os = "macos")]
fn cookies_set_blocking(wv: &tauri::Webview, cookies: Vec<CookieJson>) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel::<CookieSetMsg>();
    wv.with_webview(move |platform| {
        use crate::mac::*;
        unsafe {
            let wk = platform.inner() as id; // WKWebView
            let config: id = msg_send![wk, configuration];
            let store: id = msg_send![config, websiteDataStore];
            let jar: id = msg_send![store, httpCookieStore];
            let mut natives: Vec<id> = Vec::new();
            let mut skipped = 0usize;
            for ck in &cookies {
                // NSHTTPCookie needs Domain (we never pass OriginURL).
                let Some(domain) = ck.domain.as_deref().filter(|d| !d.is_empty()) else {
                    skipped += 1;
                    continue;
                };
                let props: id = msg_send![class!(NSMutableDictionary), dictionary];
                ns_dict_set_str(props, "Name", &ck.name);
                ns_dict_set_str(props, "Value", &ck.value);
                ns_dict_set_str(props, "Domain", domain);
                ns_dict_set_str(props, "Path", ck.path.as_deref().filter(|p| !p.is_empty()).unwrap_or("/"));
                // expires <= 0 (Playwright -1) = session cookie → omit Expires.
                if let Some(exp) = ck.expires.filter(|e| *e > 0.0) {
                    let date: id = msg_send![class!(NSDate), dateWithTimeIntervalSince1970: exp];
                    let k_ns = nsstring("Expires");
                    let k: id = objc2::rc::Retained::as_ptr(&k_ns) as id;
                    let _: () = msg_send![props, setObject: date, forKey: k];
                }
                // NSHTTPCookieSecure: PRESENCE of any value marks the cookie secure.
                if ck.secure == Some(true) {
                    ns_dict_set_str(props, "Secure", "TRUE");
                }
                if ck.http_only == Some(true) {
                    ns_dict_set_str(props, "HttpOnly", "TRUE");
                }
                // NSHTTPCookieSameSitePolicy (@"SameSite"): lowercase "lax"/"strict";
                // "None"/absent = unrestricted → omit the key.
                match ck.same_site.as_deref() {
                    Some("Lax") => ns_dict_set_str(props, "SameSite", "lax"),
                    Some("Strict") => ns_dict_set_str(props, "SameSite", "strict"),
                    _ => {}
                }
                let cookie: id = msg_send![class!(NSHTTPCookie), cookieWithProperties: props];
                if cookie == nil {
                    skipped += 1;
                } else {
                    natives.push(cookie);
                }
            }
            let _ = tx.send(CookieSetMsg::Counts { set: natives.len(), skipped });
            for c in natives {
                let tx2 = tx.clone();
                let done = block2::RcBlock::new(move || {
                    let _ = tx2.send(CookieSetMsg::Done);
                });
                let _: () = msg_send![jar, setCookie: c, completionHandler: &*done];
            }
        }
    })
    .map_err(|e| e.to_string())?;
    let (set, skipped) = match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(CookieSetMsg::Counts { set, skipped }) => (set, skipped),
        Ok(CookieSetMsg::Done) | Err(_) => return Err("set cookies timeout".to_string()),
    };
    for _ in 0..set {
        if rx.recv_timeout(Duration::from_secs(8)).is_err() {
            return Err("set cookies timeout".to_string());
        }
    }
    Ok(format!("{{\"set\":{set},\"skipped\":{skipped}}}"))
}

/// Dump the pane's cookie jar as storageState-cookie JSON (stringified
/// `[{name,value,domain,path,expires,httpOnly,secure,sameSite}, …]`) — feeds
/// save_state / import_chrome dry-run diffs for the native pane. Async +
/// spawn_blocking for the SAME reason as browser_eval_js (main-thread
/// completion handler; a sync command would deadlock main → frozen app).
#[tauri::command]
async fn browser_pane_get_cookies(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let label = browser_label(&id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "macos")]
        {
            return cookies_get_blocking(&wv);
        }
        #[cfg(target_os = "windows")]
        {
            return crate::browser_win::cookies_get_blocking(&wv);
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            return crate::browser_linux::cookies_get_blocking(&wv);
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Inject storageState cookies into the pane's jar (load_state / import_chrome
/// for the native pane). Returns `{"set":n,"skipped":m}`. Async + spawn_blocking
/// — see browser_pane_get_cookies.
#[tauri::command]
async fn browser_pane_set_cookies(
    app: tauri::AppHandle,
    id: String,
    cookies: Vec<CookieJson>,
) -> Result<String, String> {
    let label = browser_label(&id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "macos")]
        {
            return cookies_set_blocking(&wv, cookies);
        }
        #[cfg(target_os = "windows")]
        {
            return crate::browser_win::cookies_set_blocking(&wv, cookies);
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            return crate::browser_linux::cookies_set_blocking(&wv, cookies);
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
    no_abort("browser_exec_js", move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&browser_label(&id))
            .ok_or("no such browser pane")?;
        wv.eval(&js).map_err(|e| e.to_string())
    })
}

/// Native WKWebView history nav — REAL `goBack`/`goForward`/`reload` (vs the old
/// JS-history hack that just re-navigated to the current URL). `which`: 0=back,
/// 1=forward, 2=reload. UI methods, so they run on the main thread via
/// `with_webview`. macOS only (Win/Linux WebView2/WebKitGTK have own nav APIs).
#[cfg(target_os = "macos")]
fn wk_nav(wv: &tauri::Webview, which: u8) {
    let _ = wv.with_webview(move |platform| unsafe {
        use crate::mac::*;
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
    no_abort("browser_back", move || {
        use tauri::Manager;
        let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
        #[cfg(target_os = "macos")]
        {
            wk_nav(&wv, 0);
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            crate::browser_win::go_back(&wv)
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            crate::browser_linux::go_back(&wv)
        }
    })
}

/// Real "Forward" — WKWebView document history.
#[tauri::command]
fn browser_forward(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_forward", move || {
        use tauri::Manager;
        let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
        #[cfg(target_os = "macos")]
        {
            wk_nav(&wv, 1);
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            crate::browser_win::go_forward(&wv)
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            crate::browser_linux::go_forward(&wv)
        }
    })
}

/// Real "Reload" — WKWebView reload (preserves history position, vs re-navigate).
#[tauri::command]
fn browser_reload(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_reload", move || {
        use tauri::Manager;
        let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
        #[cfg(target_os = "macos")]
        {
            wk_nav(&wv, 2);
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            crate::browser_win::reload(&wv)
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            crate::browser_linux::reload(&wv)
        }
    })
}

/// Toggle the pane's Web Inspector (DevTools). Uses Tauri's own
/// open/close_devtools (the `devtools` Cargo feature is enabled so it's live in
/// release too) — no private API. Opens Safari's Web Inspector for the pane.
#[tauri::command]
fn browser_toggle_devtools(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_toggle_devtools", move || {
        use tauri::Manager;
        let wv = app.get_webview(&browser_label(&id)).ok_or("no such browser pane")?;
        if wv.is_devtools_open() {
            wv.close_devtools();
        } else {
            wv.open_devtools();
        }
        Ok(())
    })
}

/// Return AppKit first-responder to the MAIN webview (the React chrome). A native
/// browser pane is a sibling WKWebView that can hold keyboard first-responder, so
/// after interacting with a page a tab click can feel "stuck" in the pane. The tab
/// strip calls this on pointer-down. Principled AppKit hygiene (not a hide/kludge):
/// worst case it's a no-op. macOS only.
#[tauri::command]
fn browser_release_focus(app: tauri::AppHandle, window_label: Option<String>) -> Result<(), String> {
    no_abort("browser_release_focus", move || {
        browser_release_focus_inner(app, window_label)
    })
}

fn browser_release_focus_inner(app: tauri::AppHandle, window_label: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // Riporta il first-responder alla chrome React della finestra CHE HA
        // CHIESTO il rilascio, non sempre a `main`: in un pop-out il click su una
        // tab deve restituire il focus alla webview del pop-out, altrimenti la
        // pane browser del pop-out resterebbe "incollata" al first-responder. La
        // UI webview di una finestra ha la sua stessa etichetta (register_ui_webview).
        let host_label = window_label.as_deref().unwrap_or("main");
        if let Some(main_wv) = app.get_webview(host_label).or_else(|| app.get_webview("main")) {
            let _ = main_wv.with_webview(move |platform| unsafe {
                use crate::mac::*;
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
    let _ = (app, window_label);
    Ok(())
}

/// Injected probe for the env-gated sidebar FPS self-test: samples rAF frame deltas
/// while driving 6 real sidebar collapse/expands (via the diagnostic global App.tsx
/// exposes), then posts a frame-timing summary to `fps_report`. A composited
/// translateX (overlay mode) should yield ~60fps with zero dropped frames.
#[cfg(debug_assertions)]
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
  var max=0,min=1e9,sum=0,dropped=0,bad=0;
  for(var j=0;j<d.length;j++){ var x=d[j]; sum+=x; if(x>max)max=x; if(x<min)min=x; if(x>20)dropped++; if(x>33)bad++; }
  // minFrameMs ≈ the display's refresh PERIOD (fastest inter-frame gap when the
  // compositor isn't waiting): ~8.3 ⇒ 120Hz/ProMotion, ~16.7 ⇒ 60Hz. So this run
  // also answers the "60 vs 120" question — provided the window is FRONTMOST, else
  // WKWebView throttles rAF and no frames are sampled at all.
  report({frames:d.length,avgFps:Math.round(1000/(sum/d.length)),minFrameMs:Math.round(min*10)/10,maxFrameMs:Math.round(max),droppedGt20ms:dropped,droppedGt33ms:bad,toggles:6,xterms:document.querySelectorAll('.xterm').length,visibleXterms:Array.prototype.filter.call(document.querySelectorAll('.xterm'),function(e){return e.offsetParent!==null}).length,panes:document.querySelectorAll('[data-pane-id]').length,canvasOk:(window.__canvasOk||0)});
})();"#;

/// Injected probe for the env-gated SPLIT-resize FPS self-test (`TOPICS_SPLIT_SELFTEST`).
/// Finds a layout divider and synthesizes a sustained oscillating drag (real mousedown
/// on the divider + window mousemoves with buttons=1 + mouseup), sampling rAF deltas
/// throughout. A divider drag moves browser panes (instant via NSNull) and resizes the
/// flex cells; terminals coalesce their fits to the drag end — so this should hold ~60fps
/// with zero dropped frames. Posts to `fps_report`.
#[cfg(debug_assertions)]
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
      var max=0,min=1e9,sum=0,b20=0,b33=0;
      for(var j=0;j<d.length;j++){ var x=d[j]; sum+=x; if(x>max)max=x; if(x<min)min=x; if(x>20)b20++; if(x>33)b33++; }
      report({mode:'split-drag',dividerCount:count,frames:d.length,avgFps:d.length?Math.round(1000/(sum/d.length)):0,minFrameMs:d.length?Math.round(min*10)/10:0,maxFrameMs:Math.round(max),droppedGt20ms:b20,droppedGt33ms:b33,warmupMaxMs:Math.round(warmMax),xterms:document.querySelectorAll('.xterm').length,panes:document.querySelectorAll('[data-pane-id]').length});
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

/// Injected probe for the env-gated BROWSER self-test (`TOPICS_BROWSER_SELFTEST`).
/// Drives the native-pane lifecycle END-TO-END through the real Tauri IPC, bypassing
/// the React UI: invoke `browser_open` (an `about:blank` child webview), then prove
/// the view is LIVE and scriptable by `browser_eval_js`-ing a computed expression
/// (`6*7` ⇒ "42") into it, then `browser_close`. A pass means the open→load→eval
/// path the "browser won't open" report was about actually works (the occlusion
/// freeze is covered separately by browserOcclusion unit tests). Headless-safe:
/// IPC invokes don't need the window visible, and about:blank needs no network/cert.
#[cfg(debug_assertions)]
const BROWSER_SELFTEST_JS: &str = r#"(async function(){
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function report(o){ try{window.__TAURI_INTERNALS__.invoke('fps_report',{result:JSON.stringify(o)})}catch(e){} }
  var INT=window.__TAURI_INTERNALS__;
  if(!INT||!INT.invoke){ report({mode:'browser',error:'no __TAURI_INTERNALS__.invoke'}); return; }
  var inv=function(c,a){ return INT.invoke(c,a); };
  // Wait for app-ready so the data layer/proxy are up (same gate as the other probes).
  for(var rk=0;rk<40;rk++){ if(typeof window.__topicsToggleSidebar==='function')break; await sleep(500); }
  var id='__selftest_browser';
  var openErr=null;
  try{ await inv('browser_open',{id:id,url:'about:blank',x:160,y:160,width:520,height:380}); }
  catch(e){ openErr=String(e&&e.message||e); }
  if(openErr){ report({mode:'browser',opened:false,openError:openErr}); return; }
  var ready=null, math=null, evalErr=null;
  for(var k=0;k<25;k++){
    await sleep(400);
    try{
      var raw=await inv('browser_eval_js',{id:id,js:'(document.readyState||"")+"|"+(6*7)'});
      var parts=String(raw||'').split('|'); ready=parts[0]; math=parts[1];
      if(math==='42'){ break; }
    }catch(e){ evalErr=String(e&&e.message||e); }
  }
  try{ await inv('browser_close',{id:id}); }catch(e){}
  report({mode:'browser',opened:true,readyState:ready,evalRoundtrip:(math==='42'),evalError:evalErr});
})();"#;

/// Injected probe for the env-gated COST self-test (`TOPICS_COST_SELFTEST`) — the
/// EMPIRICAL frame-budget measurement that works HEADLESS. Frame drops are caused by
/// per-frame WORK exceeding the budget, not by rAF cadence; and `performance.now()`
/// around a flex mutation + a forced synchronous reflow (`getBoundingClientRect`)
/// measures the real style+layout cost of one split-drag frame — that runs whether
/// or not the window is on-screen (only paint/composite are skipped when occluded,
/// and those are cheap+GPU-parallel for flex panes). So this samples the actual
/// per-frame budget consumer: if it's well under 8.3ms (120Hz) the split can't drop
/// frames. Also times the sidebar toggle's synchronous reflow (its animation is
/// compositor-only). Posts to `fps_report`.
#[cfg(debug_assertions)]
const COST_SELFTEST_JS: &str = r#"(async function(){
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function report(o){ try{window.__TAURI_INTERNALS__.invoke('fps_report',{result:JSON.stringify(o)})}catch(e){} }
  function rnd(x){ return Math.round(x*100)/100; }
  function stats(a){ if(!a.length)return null; var s=a.slice().sort(function(x,y){return x-y}); var sum=0; for(var i=0;i<s.length;i++)sum+=s[i]; return {n:s.length,min:rnd(s[0]),median:rnd(s[s.length>>1]),p95:rnd(s[Math.floor(s.length*0.95)]),max:rnd(s[s.length-1]),avg:rnd(sum/s.length)}; }
  var SEL='[data-split-divider],[data-panel-divider-row],[data-panel-divider-col]';
  try{
    for(var rk=0;rk<40;rk++){ if(typeof window.__topicsToggleSidebar==='function')break; await sleep(500); }
    // baseline: timer + trivial reflow overhead, to know the noise floor.
    var base=[]; for(var b=0;b<60;b++){ var tb=performance.now(); void document.body.getBoundingClientRect(); base.push(performance.now()-tb); }
    var div=null,prevEl=null,nextEl=null;
    for(var k=0;k<20;k++){
      var cands=document.querySelectorAll(SEL);
      for(var c=0;c<cands.length;c++){ var dd=cands[c],p=dd.previousElementSibling,n=dd.nextElementSibling; if(p&&n){ var gp=parseFloat(getComputedStyle(p).flexGrow)||0,gn=parseFloat(getComputedStyle(n).flexGrow)||0; if(gp>0&&gn>0){div=dd;prevEl=p;nextEl=n;break;} } }
      if(div)break; await sleep(300);
    }
    if(!div){ report({mode:'cost',error:'no divider',harnessBaselineMs:stats(base),dividers:document.querySelectorAll(SEL).length}); return; }
    var g0p=parseFloat(getComputedStyle(prevEl).flexGrow)||1,g0n=parseFloat(getComputedStyle(nextEl).flexGrow)||1,comb=g0p+g0n;
    prevEl.style.transition='none'; nextEl.style.transition='none';
    window.dispatchEvent(new Event('topics:pane-resize-start'));
    // SPLIT: per-frame cost = mutate flanking flex + FORCE a synchronous layout, timed.
    var split=[],WARM=20,N=140;
    for(var i=0;i<WARM+N;i++){
      var frac=0.5+0.40*Math.sin(i/N*Math.PI*6);
      var t1=performance.now();
      prevEl.style.flex=(comb*frac)+' 1 0%'; nextEl.style.flex=(comb*(1-frac))+' 1 0%';
      void prevEl.getBoundingClientRect(); void nextEl.getBoundingClientRect();
      var dt=performance.now()-t1;
      if(i>=WARM) split.push(dt);
    }
    prevEl.style.flex=g0p+' 1 0%'; nextEl.style.flex=g0n+' 1 0%';
    window.dispatchEvent(new Event('topics:pane-resize-end'));
    // SIDEBAR: synchronous reflow cost of a toggle (FLIP push; the slide itself is compositor).
    var side=[]; for(var s2=0;s2<8;s2++){ var t2=performance.now(); try{window.__topicsToggleSidebar();}catch(e){} void document.body.getBoundingClientRect(); side.push(performance.now()-t2); await sleep(260); }
    var sp=split.filter(function(x){return x>=0});
    report({mode:'cost',splitPerFrameMs:stats(sp),sidebarToggleSyncMs:stats(side),harnessBaselineMs:stats(base),budget120HzMs:8.3,budget60HzMs:16.7,splitFramesOver120:sp.filter(function(x){return x>8.3}).length,splitFramesOver60:sp.filter(function(x){return x>16.7}).length,dividers:document.querySelectorAll(SEL).length,panes:document.querySelectorAll('[data-pane-id]').length,xterms:document.querySelectorAll('.xterm').length,note:'style+layout cost per frame (paint/composite excluded as occluded) — the budget consumer'});
  }catch(e){ report({mode:'cost',error:String(e&&e.stack||e)}); }
})();"#;

/// Env-gated polish-bug verifier (`TOPICS_BUGFIX_VERIFY`). DOM-observable checks for
/// two of the three reported Tauri bugs (the native-pane lag is OS-side, verified by
/// screen capture, not here): (1) the status/FPS dropdown must dismiss when the
/// overlay sidebar collapses — it's portaled to <body>, so it used to float on over
/// the content; (2) WebKit must render a VISIBLE scrollbar colour at rest (the global
/// `scrollbar-color: transparent transparent` hid them until hover on the Tauri build).
/// Posts a findings object to the same `fps_report` sink.
#[cfg(debug_assertions)]
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
#[cfg(debug_assertions)]
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
/// self-test runs. Debug-only: writes an arbitrary caller-supplied string to a fixed
/// /tmp path with no validation, so the command itself must not exist in release.
#[cfg(debug_assertions)]
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
    no_abort("focus_read", move || focus_read_inner(app))
}

fn focus_read_inner(app: tauri::AppHandle) -> Result<String, String> {
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
            use crate::mac::*;
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
                    (*fr).class().name().to_string_lossy().into_owned()
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
/// Debug-only: steals AppKit first-responder on demand, so the command must not exist
/// in release.
#[cfg(debug_assertions)]
#[tauri::command]
fn focus_grab_browser(app: tauri::AppHandle, id: String) -> Result<String, String> {
    no_abort("focus_grab_browser", move || focus_grab_browser_inner(app, id))
}

// Il `cfg` va anche QUI, non solo sul comando: senza, in release spariva il
// wrapper ma restava compilato il corpo che chiama `makeFirstResponder:` — cioe'
// proprio il codice che il commento sopra dice non deve esistere in release,
// vivo nel binario e senza chiamanti (rustc lo segnalava come `never used`).
#[cfg(debug_assertions)]
fn focus_grab_browser_inner(app: tauri::AppHandle, id: String) -> Result<String, String> {
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
        use crate::mac::*;
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
/// Debug-only: steals AppKit first-responder on demand, so the command must not exist
/// in release.
#[cfg(debug_assertions)]
#[tauri::command]
fn focus_grab_window(app: tauri::AppHandle) -> Result<String, String> {
    no_abort("focus_grab_window", move || focus_grab_window_inner(app))
}

#[cfg(debug_assertions)] // idem: il corpo segue il comando, o resta in release
fn focus_grab_window_inner(app: tauri::AppHandle) -> Result<String, String> {
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
                use crate::mac::*;
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
#[cfg(debug_assertions)]
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

/// Diagnostic sink for the tab-focus self-test (mirror of `fps_report`). Debug-only:
/// writes an arbitrary caller-supplied string to a fixed /tmp path with no validation.
#[cfg(debug_assertions)]
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
fn save_win_size_logical(path: &std::path::Path, w: f64, h: f64, pos: Option<(i32, i32)>) {
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

/// Read back the saved LOGICAL outer-position, if the store carries one.
/// Returns `None` for older stores — including the legacy `x`/`y` keys, which
/// held tao-"physical" (per-monitor-scaled) values that are ambiguous on
/// mixed-DPI setups: misreading them as logical would restore to the wrong
/// spot, so a legacy store centers ONCE and the next save writes `lx`/`ly`.
fn read_win_position_logical(path: &std::path::Path) -> Option<(i32, i32)> {
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
fn logical_monitors(win: &tauri::WebviewWindow) -> Vec<(i32, i32, u32, u32)> {
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
fn window_logical_geometry(win: &tauri::WebviewWindow) -> Option<((i32, i32), (u32, u32))> {
    let sf = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?.to_logical::<f64>(sf);
    let size = win.outer_size().ok()?.to_logical::<f64>(sf);
    Some((
        (pos.x.round() as i32, pos.y.round() as i32),
        (size.width.round().max(0.0) as u32, size.height.round().max(0.0) as u32),
    ))
}

/// Persist the main window's LOGICAL geometry right now (size + position).
/// Called on RunEvent::ExitRequested so the FINAL spot always survives a quit,
/// the status-bar relaunch and the updater restart — the throttled Moved/Resized
/// saves alone could drop the last move of a gesture (leading-edge throttle) and
/// nothing else runs on the way out (CloseRequested hides to tray instead).
fn save_main_window_geometry(app: &tauri::AppHandle) {
    use tauri::Manager;
    for (label, win) in app.webview_windows() {
        if label != "main" {
            continue;
        }
        if win.is_minimized().unwrap_or(false) {
            return; // a minimized frame is not a real position
        }
        if let (Some(path), Some(((lx, ly), (lw, lh)))) =
            (win_size_file(app), window_logical_geometry(&win))
        {
            save_win_size_logical(&path, lw as f64, lh as f64, Some((lx, ly)));
        }
        return;
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
fn clamp_position_to_monitors(
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
fn ensure_window_visible(win: &tauri::WebviewWindow) {
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

/// Override the pane's User-Agent (device emulation). Empty string resets to the
/// default. Takes effect on the next load, so the client reloads after setting
/// it. Tutti e tre i motori: `setCustomUserAgent:` su WKWebView,
/// `ICoreWebView2Settings2::UserAgent` su WebView2, `WebKitSettings:user-agent`
/// su WebKitGTK.
#[tauri::command]
fn browser_set_user_agent(app: tauri::AppHandle, id: String, ua: String) -> Result<(), String> {
    no_abort("browser_set_user_agent", move || browser_set_user_agent_inner(app, id, ua))
}

fn browser_set_user_agent_inner(app: tauri::AppHandle, id: String, ua: String) -> Result<(), String> {
    use tauri::Manager;
    let label = browser_label(&id);
    let wv = app.get_webview(&label).ok_or("no such browser pane")?;
    #[cfg(target_os = "macos")]
    {
        let _ = wv.with_webview(move |platform| unsafe {
            use crate::mac::*;
            let wk = platform.inner() as id;
            if ua.is_empty() {
                let _: () = msg_send![wk, setCustomUserAgent: nil];
            } else {
                let s_ns = nsstring(&ua);
                let s: id = objc2::rc::Retained::as_ptr(&s_ns) as id;
                let _: () = msg_send![wk, setCustomUserAgent: s];
            }
        });
    }
    // Su Windows serve anche l'etichetta, e il motivo e che WebView2 non sa
    // tornare indietro: la stringa vuota che qui sopra resetta WKWebView, li
    // viene rifiutata dal setter. Il default va quindi ricordato per pane, e
    // l'etichetta e la sua chiave.
    #[cfg(target_os = "windows")]
    {
        let _ = crate::browser_win::set_user_agent(&wv, label, ua);
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = crate::browser_linux::set_user_agent(&wv, ua);
    }
    Ok(())
}

/// Stringify an NSString* (nil → ""). macOS objc helper.
#[cfg(target_os = "macos")]
unsafe fn ns_string_to_rust(obj: *mut objc2::runtime::AnyObject) -> String {
    use crate::mac::*;
    use std::ffi::CStr;
    use std::os::raw::c_char;
    if obj == nil {
        return String::new();
    }
    let c: *const c_char = msg_send![obj, UTF8String];
    if c.is_null() {
        String::new()
    } else {
        CStr::from_ptr(c).to_string_lossy().into_owned()
    }
}

/// (absoluteURL, title) for a WKBackForwardListItem* (nil-safe).
#[cfg(target_os = "macos")]
unsafe fn wk_bf_item_pair(item: *mut objc2::runtime::AnyObject) -> (String, String) {
    use crate::mac::*;
    if item == nil {
        return (String::new(), String::new());
    }
    let url: *mut objc2::runtime::AnyObject = msg_send![item, URL];
    let abs: *mut objc2::runtime::AnyObject = msg_send![url, absoluteString];
    let title: *mut objc2::runtime::AnyObject = msg_send![item, title];
    (ns_string_to_rust(abs), ns_string_to_rust(title))
}

/// Read the pane's WKBackForwardList → JSON {"entries":[{"url","title"}],"activeIndex":N}.
/// Powers the toolbar back/forward history dropdown (the client adds the 0-based
/// `index`). Channel + main-thread read (backForwardList is synchronous — no
/// completion handler). macOS only.
#[cfg(target_os = "macos")]
fn nav_entries_blocking(wv: &tauri::Webview) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel::<String>();
    wv.with_webview(move |platform| {
        use crate::mac::*;
        unsafe {
            let wk = platform.inner() as id;
            let bfl: id = msg_send![wk, backForwardList];
            let mut entries: Vec<serde_json::Value> = Vec::new();
            let back: id = if bfl != nil { msg_send![bfl, backList] } else { nil };
            let back_count: usize = if back != nil { msg_send![back, count] } else { 0 };
            for i in 0..back_count {
                let item: id = msg_send![back, objectAtIndex: i];
                let (u, t) = wk_bf_item_pair(item);
                entries.push(serde_json::json!({ "url": u, "title": t }));
            }
            let active_index = entries.len();
            let cur: id = if bfl != nil { msg_send![bfl, currentItem] } else { nil };
            if cur != nil {
                let (u, t) = wk_bf_item_pair(cur);
                entries.push(serde_json::json!({ "url": u, "title": t }));
            }
            let fwd: id = if bfl != nil { msg_send![bfl, forwardList] } else { nil };
            let fwd_count: usize = if fwd != nil { msg_send![fwd, count] } else { 0 };
            for i in 0..fwd_count {
                let item: id = msg_send![fwd, objectAtIndex: i];
                let (u, t) = wk_bf_item_pair(item);
                entries.push(serde_json::json!({ "url": u, "title": t }));
            }
            let out = serde_json::json!({ "entries": entries, "activeIndex": active_index });
            let _ = tx.send(out.to_string());
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "nav_entries timeout".to_string())
}

/// Navigate to an ABSOLUTE history index (as returned by nav_entries) via
/// `goToBackForwardListItem:`. Relative offset = index − backList.count (0 = current).
#[cfg(target_os = "macos")]
fn go_to_index_blocking(wv: &tauri::Webview, index: i64) {
    let _ = wv.with_webview(move |platform| unsafe {
        use crate::mac::*;
        let wk = platform.inner() as id;
        let bfl: id = msg_send![wk, backForwardList];
        if bfl == nil {
            return;
        }
        let back: id = msg_send![bfl, backList];
        let back_count: i64 = if back != nil {
            let c: usize = msg_send![back, count];
            c as i64
        } else {
            0
        };
        let rel: i64 = index - back_count;
        if rel == 0 {
            return;
        }
        let item: id = msg_send![bfl, itemAtIndex: rel];
        if item != nil {
            let _: id = msg_send![wk, goToBackForwardListItem: item];
        }
    });
}

/// Browser pane back/forward history entries (JSON). Async (off-main) like
/// browser_eval_js — `with_webview` hops to the main thread.
#[tauri::command]
async fn browser_nav_entries(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let label = browser_label(&id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "macos")]
        {
            return nav_entries_blocking(&wv);
        }
        #[cfg(target_os = "windows")]
        {
            return crate::browser_win::nav_entries(&wv);
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            return crate::browser_linux::nav_entries(&wv);
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Jump to an absolute back/forward history index.
#[tauri::command]
fn browser_go_to_index(app: tauri::AppHandle, id: String, index: i64) -> Result<(), String> {
    no_abort("browser_go_to_index", move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&browser_label(&id))
            .ok_or("no such browser pane")?;
        #[cfg(target_os = "macos")]
        {
            go_to_index_blocking(&wv, index);
            Ok(())
        }
        // WebView2 non ha la lista della cronologia, quindi non c'e un indice a
        // cui saltare: `browser_win::nav_entries` restituisce una lista vuota e
        // la UI non offre nemmeno la voce. Resta un no-op dichiarato.
        #[cfg(target_os = "windows")]
        {
            let _ = (wv, index);
            Ok(())
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            crate::browser_linux::go_to_index(&wv, index)
        }
    })
}

/// Map a keyDown chord to the JS that re-dispatches it as a synthetic keydown on
/// the main webview's window (so the single `useKeyboardShortcuts` handler runs),
/// or None if the chord is NOT an app shortcut (let the focused page keep it).
///
/// The ⌘-chord allowlist is GENERATED from the shared registry
/// (`shared/shortcuts.ts` → `shortcuts_generated::is_forwarded_cmd_chord`), so it
/// can't silently drift from the "Keyboard Shortcuts" window. It deliberately
/// EXCLUDES page-critical chords (⌘C/⌘V/⌘X/⌘A/⌘Z, ⌘F find-in-page, ⌘R reload) —
/// those registry rows carry no `native` flag, so a focused web page keeps them.
/// The fail-safe default stays "not a chord → pass through". Tab-cycle (keyCode
/// 48) and bare Escape (keyCode 53) key off `key_code`, not chars, so they stay
/// hand-written here.
#[cfg(target_os = "macos")]
fn app_chord_dispatch_js(cmd: bool, ctrl: bool, shift: bool, chars: &str, key_code: u16) -> Option<String> {
    // Tab == keyCode 48. Standard cycle: ⌃Tab, ⌃⇧Tab, ⌘⇧Tab (⌘Tab is macOS).
    let is_tab = key_code == 48;
    // Escape == keyCode 53. Bare key, no modifier — mirrors claude-code's Esc:
    // interrupts the focused panel's running turn. Handled here too because a
    // focused child WKWebView (embedded browser pane) swallows it just like
    // every other chord below; without this, Esc only stops streaming when
    // the main renderer itself holds focus.
    let is_escape = key_code == 53;
    let key: &str = if is_escape && !cmd && !ctrl && !shift {
        "Escape"
    } else if is_tab && (ctrl || (cmd && shift)) {
        "Tab"
    } else if cmd && !ctrl && shortcuts_generated::is_forwarded_cmd_chord(shift, chars) {
        // Forwarded ⌘-chord (from the registry): re-dispatch it as-is. The set —
        // ⌘W/K/B/P/N, ⌘1‥9, ⌘⇧T/⌘⇧U, ⌘//⌘? — is generated; ⌘C/V/X/A/Z/F/R and
        // everything else carry no `native` flag, so the page keeps them.
        chars
    } else {
        return None;
    };
    // `key` for a letter is lowercase; the renderer checks both cases and reads
    // shiftKey, so lowercase + the shift flag is enough. Only quote-safe chars
    // reach here ('/', '?', letters, digits, 'Tab').
    Some(format!(
        "window.dispatchEvent(new KeyboardEvent('keydown',{{key:'{key}',metaKey:{cmd},ctrlKey:{ctrl},shiftKey:{shift},altKey:false,bubbles:true,cancelable:true}}))"
    ))
}

/// macOS: forward app keyboard shortcuts to the renderer WHEN a child browser
/// pane (WKWebView) holds keyboard focus.
///
/// A focused child WKWebView swallows keydown events before they reach the main
/// webview, so ⌘W / ⌘⇧Tab / ⌘1-9 never reach `useKeyboardShortcuts` — the tab
/// won't close, the "devo cliccare sulla tab per fare ⌘W" bug. Menu accelerators
/// don't help (the focused WKWebView eats their key-equivalents too — same reason
/// ⌘R is intercepted in the renderer). A LOCAL NSEvent monitor sees the event
/// first: for the allowlisted app chords, and ONLY when the first responder is
/// NOT inside the main webview, re-dispatch the chord as a synthetic keydown into
/// the main webview (so the one renderer handler runs) and swallow the original
/// (so the page doesn't also act on it). Everything else — all page typing, and
/// ⌘C/⌘V/⌘Z/⌘F which the page needs — passes through untouched.
#[cfg(target_os = "macos")]
fn install_shortcut_forwarder(app: &tauri::AppHandle) {
    use crate::mac::*;
    use tauri::Manager;

    // Seed the UI-webview registry with the main window before the monitor arms
    // (detach windows register themselves as they're built). The monitor
    // resolves the target window PER EVENT from this map — never a cached single
    // pointer, which mis-forwarded ⌘W from a detached window into main.
    if let Some(win) = app.get_webview_window("main") {
        register_ui_webview(&win, "main");
    }

    let app = app.clone();
    let mask: u64 = 1 << 10; // NSEventMaskKeyDown
    let block = block2::RcBlock::new(move |event: id| -> id {
        unsafe {
            // Resolve which of OUR windows fired this event and what its UI
            // webview is. The event's NSWindow keys the registry; if it isn't
            // one of ours (or the window died), pass the event untouched.
            let ev_window: id = msg_send![event, window];
            if ev_window == nil { return event; }
            let ev_window_ptr = ev_window as usize;
            let ui_view_ptr: usize = match UI_WEBVIEW_BY_NSWINDOW
                .get()
                .and_then(|m| m.lock().ok().and_then(|g| g.get(&ev_window_ptr).copied()))
            {
                Some(p) if p != 0 => p,
                _ => return event, // not an app window we manage
            };

            // ⌘R / ⌘⇧R = reload the app — the ONE chord that must win over EVERY
            // focus context. A focused child WKWebView (browser pane) or an xterm
            // terminal eats the menu accelerator's key-equivalent, so ⌘R never
            // reloaded unless the main chrome itself held focus ("premo reload e
            // non succede nulla"). The NSEvent monitor sees the key first — so we
            // handle it HERE, BEFORE the inside-UI gate below, riparte TUTTA la
            // app (`reload_all_ui_windows`, la stessa logica di `app_reload_all`),
            // poi ingoia l'originale così né la pane né il terminale agiscono
            // anche loro. `location.reload()` re-fetches index.html + bundle = the
            // app reload the user expects. (Only ⌘R without Ctrl — leaves ⌃R and
            // page shortcuts alone.)
            //
            // TUTTE le finestre, non solo quella dell'evento: siccome qui si
            // ingoia il keydown, `useKeyboardShortcuts` — che chiamava
            // `reloadAllWindows` — non vede mai ⌘R, quindi questo ramo È il ⌘R
            // del desktop. Ricaricarne una sola lasciava i gruppi staccati sul
            // bundle vecchio, due versioni dello stesso client sullo stesso
            // pane-store.
            //
            // E senza Shift: ⌘⇧R è "Record voice" (lo dicono il tooltip del
            // microfono e il pannello delle scorciatoie). Togliere l'acceleratore
            // dal menu — dove stava per sbaglio su "Force Reload" — non bastava:
            // questo monitor vede il tasto PRIMA del menu e prima della webview,
            // quindi continuava a ricaricare l'app al posto di far partire il
            // dettato, e a ingoiare l'evento perché la UI non lo vedesse mai.
            {
                let flags_r: u64 = msg_send![event, modifierFlags];
                let cmd_r = flags_r & (1 << 20) != 0;
                let ctrl_r = flags_r & (1 << 18) != 0;
                let shift_r = flags_r & (1 << 17) != 0;
                let chars_r_id: id = msg_send![event, charactersIgnoringModifiers];
                let chars_r = ns_string_to_rust(chars_r_id).to_lowercase();
                if cmd_r && !ctrl_r && !shift_r && chars_r == "r" {
                    // no_abort: si sta girando dentro un blocco NSEvent, dove un
                    // panic non ha nessuno che lo raccolga — sarebbe un abort
                    // dell'intera app su una pressione di ⌘R.
                    let _ = no_abort("cmd_r_reload_all", || Ok(reload_all_ui_windows(&app)));
                    return nil; // swallow — the pane/terminal must not also see ⌘R
                }
            }

            // If the first responder is inside THIS window's own UI webview, the
            // renderer's keydown path handles the chord — never double-fire.
            // Only a child browser PANE reaches the forward path. Da quando
            // browser_open parenta la webview alla finestra ospite, anche un
            // pop-out PUÒ avere una pane browser: NON dare più per scontato che
            // «una finestra staccata non ha pane browser». Non serve comunque,
            // perché il forward qui sotto risolve la UI webview dalla finestra
            // dell'evento (ev_window_ptr) — il chord agisce dove è stato digitato,
            // pop-out incluso, con fallback a main.
            let fr: id = msg_send![ev_window, firstResponder];
            if fr == nil { return event; }
            let ui_view = ui_view_ptr as id;
            let is_view: BOOL = msg_send![fr, isKindOfClass: class!(NSView)];
            if is_view == YES {
                let inside_ui: BOOL = msg_send![fr, isDescendantOf: ui_view];
                if inside_ui == YES { return event; } // UI webview → normal path
            }

            // A browser pane holds focus. Is this an app chord we should forward?
            let flags: u64 = msg_send![event, modifierFlags];
            const CMD: u64 = 1 << 20;
            const CTRL: u64 = 1 << 18;
            const SHIFT: u64 = 1 << 17;
            let cmd = flags & CMD != 0;
            let ctrl = flags & CTRL != 0;
            let shift = flags & SHIFT != 0;
            let key_code: u16 = msg_send![event, keyCode];
            let chars_id: id = msg_send![event, charactersIgnoringModifiers];
            let chars = ns_string_to_rust(chars_id).to_lowercase();

            if let Some(js) = app_chord_dispatch_js(cmd, ctrl, shift, &chars, key_code) {
                // Forward into the SAME window's UI webview (resolve its label by
                // matching the event NSWindow), so the chord acts where it was
                // typed. Le pane browser ora possono vivere anche in un pop-out
                // (browser_open le parenta alla finestra ospite): keying off the
                // event window è ciò che tiene corretto questo forward.
                let mut dispatched = false;
                for (label, w) in app.webview_windows() {
                    if w.ns_window().map(|p| p as usize).ok() == Some(ev_window_ptr) {
                        if let Some(wv) = app.get_webview(&label) {
                            let _ = wv.eval(&js);
                            dispatched = true;
                        }
                        break;
                    }
                }
                if !dispatched {
                    if let Some(mw) = app.get_webview("main") {
                        let _ = mw.eval(&js);
                    }
                }
                // Bare Esc is forwarded best-effort (interrupt a streaming turn)
                // but must ALSO reach the focused page: unlike the ⌘-chords the
                // page has first-class uses for Esc (close dialogs, cancel).
                // The renderer side no-ops unless a session is streaming.
                if key_code == 53 && !cmd && !ctrl && !shift {
                    return event;
                }
                return nil; // swallow — the page must not also act on the chord
            }
            event // not an app chord → let the focused page have it
        }
    });
    unsafe {
        let _monitor: id = msg_send![class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: mask,
            handler: &*block];
    }
    // AppKit Block_copy'd the handler; keep OUR heap block alive for the app
    // lifetime too (the monitor is never removed).
    std::mem::forget(block);
}

// ─────────────────── Global right-⌘ tap → focus the task composer ──────────────
//
// Renderer-parity for the "tap right-⌘ to jump to the board composer" gesture,
// but working from ANY app (when Topics is in the background). The in-app path
// (useKeyboardShortcuts, MetaRight keyup within 400 ms) only sees keys while the
// webview has focus; a GLOBAL NSEvent monitor sees them system-wide. The two
// don't collide: a global monitor is only delivered while OUR app is inactive —
// once Topics is frontmost the renderer path owns the gesture.
//
// Detection mirrors the renderer: a bare right-⌘ PRESS arms a timestamp; the
// matching RELEASE fires only if it came quickly (< 400 ms) with nothing in
// between — any other key, modifier, mouse, or scroll disarms it, so right-⌘
// held as a modifier (⌘C, ⌘-click) never triggers. On a real tap we activate
// Topics and re-dispatch the existing `task-composer:focus` renderer event.
//
// Keyboard events reach a global monitor ONLY when the process is trusted for
// Accessibility — `install_accessibility_prompt` requests that; until it's
// granted (may need a relaunch) the monitor is installed but simply receives
// nothing, so this degrades to "in-app only" rather than breaking.
#[cfg(target_os = "macos")]
fn install_global_cmd_tap(app: &tauri::AppHandle) {
    use crate::mac::*;
    use std::cell::Cell;
    use std::rc::Rc;

    // NSEventMask bits. Two SEPARATE monitors, one per role, so neither block
    // ever calls `-[NSEvent type]` — the objc `sel!` macro mangles the raw
    // identifier `r#type` into the bogus selector "r#type", which NSEvent does
    // not recognize → doesNotRecognizeSelector → uncaught NSException →
    // objc_terminate → SIGABRT on EVERY event once the monitor is live. Splitting
    // by mask lets each block know its event kind statically and only send
    // selectors NSEvent actually responds to.
    const MASK_FLAGS_CHANGED: u64 = 1 << 12; // ⌘ press/release
    const MASK_DISARM: u64 = (1 << 10)       // key down
        | (1 << 1) | (1 << 3)                // left/right mouse down
        | (1 << 22);                         // scroll wheel

    // kVK_RightCommand. Left ⌘ is 55; we intentionally only bind the right one.
    const RIGHT_CMD_KEYCODE: u16 = 54;
    // Device-independent modifier bits (mask off the low device-dependent byte).
    const DEVICE_INDEPENDENT: u64 = 0xffff_0000;
    const FLAG_COMMAND: u64 = 1 << 20;
    // Every OTHER modifier that must be absent for a *bare* right-⌘ tap.
    const OTHER_MODS: u64 =
        (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 23); // caps/shift/ctrl/opt/fn

    // Global monitors are delivered on the main run loop, so a plain non-atomic
    // Cell shared via Rc between the two blocks is safe (never touched off-main).
    // Armed timestamp (NSEvent.timestamp, seconds since boot); 0.0 = disarmed.
    let armed_at = Rc::new(Cell::new(0.0_f64));

    // ── Monitor 1: flagsChanged — arm on bare right-⌘ press, fire on quick release ──
    let app_flags = app.clone();
    let armed_flags = armed_at.clone();
    let flags_block = block2::RcBlock::new(move |event: id| {
        unsafe {
            // Every event here is a flagsChanged, so keyCode/modifierFlags/timestamp
            // are all valid selectors on it.
            let key_code: u16 = msg_send![event, keyCode];
            let flags: u64 = msg_send![event, modifierFlags];
            let ts: f64 = msg_send![event, timestamp];
            let dev = flags & DEVICE_INDEPENDENT;
            let cmd_now = dev & FLAG_COMMAND != 0;
            let others = dev & OTHER_MODS != 0;

            if key_code != RIGHT_CMD_KEYCODE {
                armed_flags.set(0.0); // a different modifier changed → disarm
                return;
            }
            if cmd_now && !others {
                armed_flags.set(ts); // bare right-⌘ pressed → arm
            } else if !cmd_now {
                // Right-⌘ released — fire only for a quick, uninterrupted tap.
                let start = armed_flags.get();
                armed_flags.set(0.0);
                if start > 0.0 && ts - start < 0.4 {
                    focus_task_composer_from_background(&app_flags);
                }
            } else {
                armed_flags.set(0.0); // right-⌘ + another modifier → chord, not a tap
            }
        }
    });

    // ── Monitor 2: any other key / mouse / scroll → disarm (never a tap) ──
    let armed_disarm = armed_at.clone();
    let disarm_block = block2::RcBlock::new(move |_event: id| {
        armed_disarm.set(0.0);
    });

    unsafe {
        let _m1: id = msg_send![class!(NSEvent),
            addGlobalMonitorForEventsMatchingMask: MASK_FLAGS_CHANGED,
            handler: &*flags_block];
        let _m2: id = msg_send![class!(NSEvent),
            addGlobalMonitorForEventsMatchingMask: MASK_DISARM,
            handler: &*disarm_block];
    }
    // Keep the heap blocks alive for the app lifetime (monitors are never removed).
    std::mem::forget(flags_block);
    std::mem::forget(disarm_block);
}

/// Activate Topics (it was in the background) and focus the board's task composer.
/// Called from the global right-⌘ tap monitor. The AppKit activation + Tauri window
/// ops are pushed onto the main-thread event loop via `run_on_main_thread` (even
/// though the monitor already runs on main) so the work never re-enters the window
/// dispatcher inline from inside an event-handler frame.
#[cfg(target_os = "macos")]
fn focus_task_composer_from_background(app: &tauri::AppHandle) {
    use tauri::Manager;
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        use crate::mac::*;
        if let Some(win) = app.get_webview_window("main") {
            unsafe {
                let nsapp: id = msg_send![class!(NSApplication), sharedApplication];
                let _: () = msg_send![nsapp, activateIgnoringOtherApps: YES];
            }
            ensure_window_visible(&win);
            if let Some(wv) = app.get_webview("main") {
                let _ = wv.eval("window.dispatchEvent(new CustomEvent('task-composer:focus'))");
            }
        }
    });
}

// Request Accessibility trust so the global monitor above receives key events — but
// AT MOST ONCE per install. `AXIsProcessTrustedWithOptions` with the prompt option
// shows the scary system dialog ("Topics wants to control this computer using
// accessibility features") and drops the app into System Settings ▸ Privacy ▸
// Accessibility. macOS re-shows it on EVERY launch while the app stays untrusted, so
// a fresh user who ignores it — Accessibility is a heavy ask for what is only a
// convenience here (the global right-⌘ tap → focus the board composer) — gets
// re-nagged forever. That's the "chiede troppi permessi" a new install hits. So we
// prompt once and never again: already trusted → silent no-op; already asked → stay
// quiet. A user who wants the global tap grants it on the single ask (or later, from
// System Settings — the first prompt already listed the app there); everyone else is
// asked exactly once. Either way the in-app gesture and the rest of the app are
// unaffected: without trust the global monitor is simply inert.
#[cfg(target_os = "macos")]
fn install_accessibility_prompt(app: &tauri::AppHandle) {
    use crate::mac::*;
    use tauri::Manager;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        // Takes a CFDictionaryRef; NSDictionary is toll-free bridged, so we pass an id.
        fn AXIsProcessTrustedWithOptions(options: id) -> bool;
    }

    unsafe {
        if AXIsProcessTrusted() {
            return; // already granted — silent no-op
        }
    }

    // At-most-once gate. The marker lives beside the app's per-user config so it
    // survives relaunches (a genuine uninstall/reinstall may legitimately ask again).
    // If the dir can't be resolved we key a temp path off the bundle id, so a broken
    // path degrades to "ask again next launch" rather than a nag loop or a crash.
    let marker = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("io.armonia.topics.tauri"))
        .join(".accessibility-prompted");
    if marker.exists() {
        log::info!(
            "[topics] Accessibility not granted but already prompted once — not re-asking. \
             Enable it in System Settings ▸ Privacy & Security ▸ Accessibility to use the \
             global right-⌘ tap."
        );
        return;
    }

    unsafe {
        // options = @{ @"AXTrustedCheckOptionPrompt": @YES } — the constant's value
        // IS this string, so a literal key avoids linking the CFString global.
        let key_ns = nsstring("AXTrustedCheckOptionPrompt");
        let key: id = objc2::rc::Retained::as_ptr(&key_ns) as id;
        let yes: id = msg_send![class!(NSNumber), numberWithBool: YES];
        let opts: id = msg_send![class!(NSDictionary), dictionaryWithObject: yes, forKey: key];
        let trusted = AXIsProcessTrustedWithOptions(opts);
        if !trusted {
            log::warn!(
                "[topics] Accessibility not yet granted — global right-⌘ tap stays inert \
                 until it's enabled in System Settings ▸ Privacy & Security ▸ Accessibility \
                 (a relaunch may be needed). This prompt won't be shown again."
            );
        }
    }

    // Record the single ask so no future launch re-prompts (whether or not the user
    // granted it this time). Best-effort: a write failure just means we might ask once
    // more next launch — strictly better than a persistent nag.
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, b"1\n");
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
static DETACH_SEQ: AtomicI64 = AtomicI64::new(0);

/// Short, collision-free label suffix (time-nanos ^ counter, hex). Avoids adding
/// a `uuid` crate for what only needs to be unique within one process lifetime.
fn detach_label() -> String {
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
async fn window_detach(
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
    .decorations(true)
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
async fn window_detach_space(
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
    {
        use tauri::Manager;
        let existing = app
            .webview_windows()
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
                .decorations(true)
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
fn space_window_label(space: &str) -> String {
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
fn purge_dead_space_labels(app: &tauri::AppHandle) {
    use tauri::Manager;
    let alive: std::collections::HashSet<String> = app.webview_windows().into_keys().collect();
    if let Ok(mut m) = SPACE_WINDOWS.lock() {
        m.retain(|label, _| alive.contains(label));
    }
}

/// L'id del gruppo dietro un label `space-…`, ricavato dalla URL della finestra
/// aperta. Ritorna `None` per ogni altra finestra.
fn window_space_of(label: &str) -> Option<String> {
    if !label.starts_with("space-") { return None; }
    SPACE_WINDOWS.lock().ok()?.get(label).cloned()
}

/// label della finestra → id del gruppo che ospita. Serve solo a riconoscere
/// una finestra già aperta sullo stesso gruppo (il label è un hash, non l'id).
static SPACE_WINDOWS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Focus (show + unminimize + raise) the window with `label`. Returns false when
/// no such window exists on THIS machine, so the client can fall back to a local
/// reopen (the topic may be detached on another device, or the window just died).
#[tauri::command]
fn window_focus_label(app: tauri::AppHandle, label: String) -> bool {
    use tauri::Manager;
    // no_abort: ensure_window_visible is a chain of window-dispatcher calls
    // (show/unminimize/outer_position/set_focus…) — same poisoned-mutex
    // SIGABRT class as the browser_* commands (see no_abort doc).
    no_abort("window_focus_label", || {
        if let Some(w) = app.get_webview_window(&label) {
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
const RELOAD_WITH_FLASH_JS: &str =
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
fn reload_all_ui_windows(app: &tauri::AppHandle) -> usize {
    use tauri::Manager;
    let mut n = 0usize;
    for (label, win) in app.webview_windows() {
        // Le pane native del browser sono webview a sé: si saltano, o si
        // ricaricherebbe la pagina che l'utente sta guardando.
        if label.starts_with("browserpane-") { continue; }
        if win.eval(RELOAD_WITH_FLASH_JS).is_ok() { n += 1; }
    }
    n
}

/// Il gesto «riparti» esposto al renderer. Vedi `reload_all_ui_windows`.
#[tauri::command]
fn app_reload_all(app: tauri::AppHandle) -> usize {
    no_abort("app_reload_all", || Ok(reload_all_ui_windows(&app))).unwrap_or(0)
}

/// Chiude la finestra `label` (una finestra-gruppo, di solito): è il "riporta
/// qui" del menu di un gruppo staccato. `false` = quella finestra non esiste su
/// questa macchina, e chi chiama si limita a riaprire il gruppo dov'è.
#[tauri::command]
fn window_close_label(app: tauri::AppHandle, label: String) -> bool {
    use tauri::Manager;
    // no_abort: `close()` passa dal dispatcher della finestra — stessa classe di
    // SIGABRT dei comandi `browser_*` (vedi la doc di no_abort).
    no_abort("window_close_label", || {
        match app.get_webview_window(&label) {
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
fn window_close_self(window: tauri::Window) {
    // no_abort: window.close() goes through the window dispatcher — a
    // poisoned dispatcher mutex would otherwise abort the whole app on the
    // next detached-window close (see no_abort doc).
    let _ = no_abort("window_close_self", || {
        window.close().map_err(|e| e.to_string())
    });
}

// ───────────────────────── Dev hot-reload (disk-serve) ─────────────────────────
//
// Electron-prod parity: the packaged Electron shell "auto-reloads all windows when
// /public assets change (500ms debounce)". Tauri EMBEDS /public via include_bytes!
// at cargo-build (frontendDist), served from tauri://localhost — so a `vite build`
// that rewrites /public does nothing for an already-running binary (only a fresh
// `cargo run`/`tauri build` re-embeds). That killed the client dogfood loop.
//
// This opt-in dev mode restores it WITHOUT touching the release default:
//   • A dev marker (env TOPICS_PUBLIC_DIR, or <app_config_dir>/topics-dev.json →
//     {"publicDir":"/abs/path"}) is read ONCE at startup. ABSENT ⇒ byte-identical
//     embedded behavior, no per-request disk probes.
//   • When present, the custom `tauri` URI-scheme handler serves matching files
//     from disk (canonicalized, traversal-guarded) and FALLS BACK to the embedded
//     asset for anything not on disk — so a partial /public still boots.
//   • A polling watcher (dep-free: recursive max-mtime scan, no `notify` crate)
//     reloads every app-shell webview 500ms after the writes go quiet — one reload
//     per `vite build` burst.

/// Resolved dev-mode state, read once at startup. `None` ⇒ pure embedded serving.
#[derive(Clone)]
struct DevServe {
    /// Canonicalized absolute path of the on-disk /public to serve + watch.
    public_dir: std::path::PathBuf,
}

/// App bundle identifier — MUST match tauri.conf.json `identifier`. Used to locate
/// the per-machine dev marker WITHOUT an AppHandle, so resolution can run BEFORE the
/// Tauri Builder. Why that matters: the config-defined main window builds — and fires
/// its first `tauri://` asset request — BEFORE the `setup` closure runs. Resolving the
/// marker lazily inside the protocol handler therefore raced that first request; under
/// a LaunchServices/login-item launch the path plugin wasn't always ready at that
/// instant, so `app_config_dir()` failed, the `OnceLock` latched `None`, and the shell
/// was silently pinned to embedded serving (the "login-item won't hot-reload" bug — a
/// direct `cargo run` / shell exec happened to win the race and worked, masking it).
const BUNDLE_IDENTIFIER: &str = "io.armonia.topics.tauri";

/// Per-OS user config dir (dep-free; mirrors `dirs::config_dir()` for the three
/// desktop targets) — the parent of `<identifier>/topics-dev.json`. AppHandle-free so
/// it can be called before the Builder exists.
fn user_config_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    }
}

/// Append a one-line decision record to `<config>/<id>/hot-reload.log`. stderr from a
/// LaunchServices launch goes nowhere reachable, so this file is the ONLY way to see
/// what the login-item launch decided. Best-effort; never fails the caller.
fn log_hot_reload_decision(line: &str) {
    if let Some(dir) = user_config_dir().map(|d| d.join(BUNDLE_IDENTIFIER)) {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("hot-reload.log"))
        {
            use std::io::Write;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ts}] {line}");
        }
    }
}

/// Resolve the dev marker ONCE, AppHandle-free (call before the Builder). Priority:
/// env `TOPICS_PUBLIC_DIR`, then `<config>/<identifier>/topics-dev.json`
/// (`{"publicDir":"/abs"}`). The directory must exist and canonicalize, else dev mode
/// stays OFF (embedded serving unchanged).
fn resolve_dev_serve() -> Option<DevServe> {
    let raw = std::env::var("TOPICS_PUBLIC_DIR").ok().filter(|s| !s.trim().is_empty());
    let raw = raw.or_else(|| {
        let marker = user_config_dir()?.join(BUNDLE_IDENTIFIER).join("topics-dev.json");
        let text = std::fs::read_to_string(&marker).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        v.get("publicDir")?.as_str().map(|s| s.to_string())
    });
    let raw = match raw {
        Some(r) => r,
        None => {
            log_hot_reload_decision("embedded (no marker/env)");
            return None;
        }
    };
    // Canonicalize so the traversal guard (below) compares real, symlink-resolved
    // prefixes — the scheme-guard LFI lesson: never trust a joined path's shape.
    let public_dir = match std::fs::canonicalize(&raw) {
        Ok(p) => p,
        Err(e) => {
            log_hot_reload_decision(&format!("embedded (canonicalize {raw:?} failed: {e})"));
            return None;
        }
    };
    if !public_dir.is_dir() {
        eprintln!("[hot-reload] TOPICS publicDir {public_dir:?} is not a directory; embedded serving");
        log_hot_reload_decision(&format!("embedded ({public_dir:?} not a dir)"));
        return None;
    }
    eprintln!("[hot-reload] disk-serving /public from {public_dir:?}");
    log_hot_reload_decision(&format!("disk-serving {public_dir:?}"));
    Some(DevServe { public_dir })
}

/// Local-dev auto-update opt-in, resolved once and AppHandle-free (same per-machine
/// dev marker as `resolve_dev_serve`, so "in locale in sviluppo" is a single source of
/// truth). ON when env `TOPICS_AUTO_UPDATE` is truthy, or `<config>/<identifier>/
/// topics-dev.json` carries `"autoUpdate": true`. A released install with no marker ⇒
/// OFF, so the client's opt-in toast flow (`autoDownload:false`, "no surprise
/// downloads") is byte-for-byte unchanged and this NEVER fires for prod users. It
/// exists so a dev's local shell silently pulls each signed release "da sotto" and
/// relaunches, instead of nagging with a manual toast. An explicit falsy env value
/// force-disables it even when the marker opts in.
fn dev_auto_update_enabled() -> bool {
    if let Ok(v) = std::env::var("TOPICS_AUTO_UPDATE") {
        match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => return true,
            "0" | "false" | "no" | "off" => return false,
            _ => {} // unrecognized ⇒ fall through to the marker
        }
    }
    // A debug build is the dev's OWN source compile (`cargo run`) — never silently swap
    // it for a signed release binary: that would nuke an in-progress native-dev session
    // and replace your local build with CI's. The passive marker opt-in only ever arms
    // an INSTALLED release shell; an explicit `TOPICS_AUTO_UPDATE=1` above still wins.
    if cfg!(debug_assertions) {
        return false;
    }
    let Some(marker) =
        user_config_dir().map(|d| d.join(BUNDLE_IDENTIFIER).join("topics-dev.json"))
    else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&marker) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    v.get("autoUpdate").and_then(|x| x.as_bool()).unwrap_or(false)
}

/// Minimal, dep-free percent-encode for a query-value component: keep the
/// RFC-3986 unreserved set verbatim, escape everything else (notably ',' — the
/// `?topics=` list separator — and non-ASCII bytes) as `%XX`. Enough to carry
/// topic ids through the detached-window URL without a `percent_encoding` dep.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Minimal, dep-free percent-decode (`%XX` → byte), UTF-8 lossy. Enough for asset
/// URLs (mirrors what Tauri does with the `percent_encoding` crate) without adding
/// a direct dependency; unknown/short escapes are passed through verbatim.
fn percent_decode_lossy(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse a `tauri://localhost/...` request URI into the normalized relative asset
/// path Tauri's own resolver uses: strip query/fragment + the origin prefix,
/// percent-decode, drop a trailing '/', empty ⇒ "index.html", else strip a leading
/// '/'. Mirrors AppManager::get_asset's front half so disk + embedded agree on keys.
fn asset_request_path(uri: &str) -> String {
    let no_qf = uri.split(['?', '#']).next().unwrap_or(uri);
    let mut p = no_qf
        .strip_prefix("tauri://localhost")
        .unwrap_or(no_qf)
        .to_string();
    if p.ends_with('/') {
        p.pop();
    }
    let p = percent_decode_lossy(&p);
    if p.is_empty() {
        "index.html".to_string()
    } else {
        p.strip_prefix('/').unwrap_or(&p).to_string()
    }
}

/// Read `rel` from the on-disk publicDir with a traversal guard: the candidate must
/// canonicalize to a path INSIDE `public_dir` (rejects `../`, symlink escapes — the
/// LFI lesson). Returns the bytes on a real hit; `None` for miss/escape/dir → the
/// caller then falls back to the embedded asset.
fn read_disk_asset(public_dir: &std::path::Path, rel: &str) -> Option<Vec<u8>> {
    let candidate = public_dir.join(rel);
    let real = std::fs::canonicalize(&candidate).ok()?;
    if !real.starts_with(public_dir) {
        eprintln!("[hot-reload] blocked traversal outside publicDir: {rel:?}");
        return None;
    }
    if !real.is_file() {
        return None;
    }
    std::fs::read(&real).ok()
}

/// Try to satisfy a request from disk using the SAME fallback chain the embedded
/// resolver uses: `path`, then `path.html`, then `path/index.html`, then the SPA
/// `index.html`. Returns `(bytes, mime)` on a disk hit; `None` ⇒ fall back to
/// embedded. MIME comes from `tauri::utils::mime_type::MimeType::parse` — the exact
/// function the embedded resolver calls — so `.js`/`.mjs` get `text/javascript`
/// (module MIME) identically, no divergence.
fn disk_asset_response(public_dir: &std::path::Path, path: &str) -> Option<(Vec<u8>, String)> {
    let candidates = [
        path.to_string(),
        format!("{path}.html"),
        format!("{path}/index.html"),
        "index.html".to_string(),
    ];
    for (i, cand) in candidates.iter().enumerate() {
        if let Some(bytes) = read_disk_asset(public_dir, cand) {
            // Name the served file (not the request) so MIME keys off the real
            // extension — matches how the embedded resolver names its asset_path.
            let mime = tauri::utils::mime_type::MimeType::parse(&bytes, cand);
            if i > 0 {
                eprintln!("[hot-reload] disk fallback {path:?} -> {cand:?}");
            }
            // L'HTML servito da disco va TIMBRATO col suo rev, come fa il server
            // (stampBundleRev): senza il meta il client disattiva del tutto il
            // controllo di freschezza e la "Nuova versione disponibile" non può
            // uscire, mai. Vedi bundle_rev_from_html.
            if cand.ends_with(".html") {
                if let Ok(html) = String::from_utf8(bytes.clone()) {
                    let rev = bundle_rev_from_html(&html);
                    return Some((stamp_bundle_rev(&html, &rev).into_bytes(), mime));
                }
            }
            return Some((bytes, mime));
        }
    }
    None
}

/// Rev del bundle di un index.html: i nomi `/assets/index-*` che referenzia,
/// deduplicati e ordinati (`/assets/index-A.css,/assets/index-B.js`).
///
/// DEVE restare byte-compatibile con `readBundleRev` in
/// `server/lib/dev-bundle-reload.ts` — stessa stringa, stesso ordine. Il client
/// confronta il valore timbrato qui con quello che il SERVER gli annuncia via
/// WS (`ui:bundle-rev` / `ui:bundle-updated`): qualunque divergenza si
/// vedrebbe come una "nuova versione disponibile" perenne, che è esattamente il
/// loop fantasma già pagato una volta (2026-07-26). Solo `index-*` di proposito:
/// l'hash dell'entry copre transitivamente ogni chunk.
///
/// A mano invece che con `regex`: questa crate non ha quella dipendenza e la
/// classe di caratteri è quella del regex JS, `[A-Za-z0-9._-]`.
fn bundle_rev_from_html(html: &str) -> String {
    const PREFIX: &str = "/assets/index-";
    let bytes = html.as_bytes();
    let mut names: Vec<&str> = Vec::new();
    let mut i = 0usize;
    while let Some(off) = html[i..].find(PREFIX) {
        let start = i + off;
        let mut end = start + PREFIX.len();
        while end < bytes.len() {
            let c = bytes[end];
            if c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-' {
                end += 1;
            } else {
                break;
            }
        }
        names.push(&html[start..end]);
        i = end;
    }
    names.sort_unstable();
    names.dedup();
    names.join(",")
}

/// Inserisce `<meta name="topics-bundle-rev" content="…">` in testa allo `<head>`
/// (fuori se non c'è): stesso tag, stesso nome e stessa posizione di
/// `stampBundleRev` lato server, così il client legge UN solo numero comunque sia
/// arrivato il documento. Rev vuoto ⇒ HTML invariato.
fn stamp_bundle_rev(html: &str, rev: &str) -> String {
    if rev.is_empty() {
        return html.to_string();
    }
    let tag = format!("<meta name=\"topics-bundle-rev\" content=\"{rev}\">");
    if html.contains("<head>") {
        html.replacen("<head>", &format!("<head>{tag}"), 1)
    } else {
        format!("{tag}{html}")
    }
}

/// Recursively compute the newest mtime under `dir` (as nanos since epoch) and a
/// crude entry count. A tuple change between polls = a write burst landed. Dir
/// disappearance / permission errors collapse to `(0, 0)` — the watcher treats
/// that as "no change" and keeps polling (resilient, never panics).
fn public_dir_signature(dir: &std::path::Path) -> (u128, u64) {
    fn walk(dir: &std::path::Path, newest: &mut u128, count: &mut u64) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                walk(&path, newest, count);
            } else {
                *count += 1;
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                        let n = dur.as_nanos();
                        if n > *newest {
                            *newest = n;
                        }
                    }
                }
            }
        }
    }
    let (mut newest, mut count) = (0u128, 0u64);
    walk(dir, &mut newest, &mut count);
    (newest, count)
}

/// Segnala a ogni webview APP-SHELL (`main` + eventuali `detach-*`) che su disco
/// c'è un bundle più nuovo, saltando le figlie `browserpane-*` (caricano il web
/// aperto, non l'app).
///
/// AVVISA, non strattona. Prima qui c'era `window.location.reload()`: la finestra
/// veniva ricaricata sotto le mani dell'utente a ogni build — pane vive azzerate,
/// messaggio a metà perso — che è ESATTAMENTE la cosa rimossa dalla metà web il
/// 2026-07-20 ("gestiamo meglio l'hot-reload"). Questo watcher era rimasto
/// indietro. Ora fa quello che fa il server: emette `topics:bundle-stale`, la
/// DevBundleToast mostra "Ricarica" e il momento lo sceglie l'utente. Stesso
/// evento del mismatch di rev via WS e della guardia sui chunk 404 → una sola
/// superficie UI, nessun doppione (il toast è un booleano).
///
/// Gira sul main thread (il registro delle webview è raggiungibile solo lì).
fn notify_app_shell_bundle_stale(app: &tauri::AppHandle) {
    use tauri::Manager;
    for (label, wv) in app.webviews() {
        if label.starts_with("browserpane-") {
            continue;
        }
        let _ = wv.eval("window.dispatchEvent(new CustomEvent('topics:bundle-stale'))");
    }
}

/// Dep-free polling watcher (the `notify` crate was dropped when assets went
/// embed-only; a 1s recursive mtime scan is plenty for a manual dogfood loop and
/// adds no dependency). Blocks off-thread; on a signature change it waits for the
/// writes to go quiet (500ms), then AVVISA le webview app-shell una volta per
/// burst (`topics:bundle-stale` → toast "Ricarica"), senza ricaricarle d'ufficio.
fn spawn_public_watcher(app: tauri::AppHandle, public_dir: std::path::PathBuf) {
    std::thread::spawn(move || {
        let mut last = public_dir_signature(&public_dir);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let now = public_dir_signature(&public_dir);
            if now == last || now == (0, 0) {
                // No change, or the dir momentarily vanished mid-build — keep polling.
                if now != (0, 0) {
                    last = now;
                }
                continue;
            }
            // A burst started. Debounce: keep sampling until the tree stops moving
            // for 500ms, so a vite build (many files) triggers exactly ONE reload.
            let mut settled = now;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let again = public_dir_signature(&public_dir);
                if again == settled {
                    break;
                }
                settled = again;
            }
            last = settled;
            eprintln!("[hot-reload] /public changed — prompting app-shell webviews");
            let app_for_notify = app.clone();
            let _ = app.run_on_main_thread(move || notify_app_shell_bundle_stale(&app_for_notify));
        }
    });
}

/// Serve a `tauri://localhost/...` request. In dev (disk) mode, try the on-disk
/// /public first (traversal-guarded, same fallback chain as embedded) and fall
/// back to the embedded asset for anything not on disk; otherwise serve embedded —
/// byte-identical to Tauri's own handler. Replicates the non-mobile production path
/// of `crate::protocol::tauri::get_response`: strip origin/query, resolve, set
/// Content-Type (+ CSP when present) and the app-origin CORS header.
fn serve_tauri_asset(
    ctx: &tauri::UriSchemeContext<'_, tauri::Wry>,
    request: &tauri::http::Request<Vec<u8>>,
    dev: Option<&DevServe>,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    use tauri::http::{header::CONTENT_TYPE, StatusCode};
    // The app origin for CORS. This non-isolation macOS shell serves from
    // tauri://localhost (window_origin in the built-in handler), matching what the
    // embedded protocol emits.
    const WINDOW_ORIGIN: &str = "tauri://localhost";

    // Panic-free fallback. This handler runs on WKURLSchemeHandler's SYNC callback —
    // the same non-unwind FFI boundary `no_abort` guards (a panic here abort()s the
    // WHOLE app, and this is the highest-traffic path in the file: every page/JS/CSS/
    // image load hits it). The response-builder `.unwrap()`s below must degrade to a
    // 500, never unwind. Built via `Response::new` + `status_mut` so there is no
    // builder `Result` to unwrap — this cannot itself panic.
    fn asset_fallback() -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
        let mut resp =
            tauri::http::Response::new(std::borrow::Cow::Borrowed(&b"asset error"[..]));
        *resp.status_mut() = tauri::http::StatusCode::INTERNAL_SERVER_ERROR;
        resp
    }

    let uri = request.uri().to_string();
    let path = asset_request_path(&uri);

    // Dev disk hit (opt-in): serve from /public, MIME via the same parser the
    // embedded resolver uses. Misses fall through to embedded so a partial dist boots.
    if let Some(dev) = dev {
        if let Some((bytes, mime)) = disk_asset_response(&dev.public_dir, &path) {
            return tauri::http::Response::builder()
                .header(CONTENT_TYPE, mime)
                .header("Access-Control-Allow-Origin", WINDOW_ORIGIN)
                // Hot-reload mode: NEVER let WKWebView cache the disk-served shell.
                // Without this it heuristically caches index.html/boot.js (no
                // Cache-Control ⇒ freshness heuristic) and then re-serves the STALE
                // document on the next launch/reload, bypassing this handler — the
                // "still on the old version after a build" bug. Hashed assets change
                // filename per build, so no-store on all disk hits is harmless.
                .header("Cache-Control", "no-store, must-revalidate")
                .body(std::borrow::Cow::Owned(bytes))
                .unwrap_or_else(|_| asset_fallback());
        }
    }

    // Embedded fallback (and the default when dev mode is off). `asset_resolver`
    // runs the full path→.html→/index.html→index.html chain + CSP injection, so this
    // is exactly the built-in behavior.
    match ctx.app_handle().asset_resolver().get(path) {
        Some(asset) => {
            let mut builder = tauri::http::Response::builder()
                .header(CONTENT_TYPE, &asset.mime_type)
                .header("Access-Control-Allow-Origin", WINDOW_ORIGIN);
            if let Some(csp) = &asset.csp_header {
                builder = builder.header("Content-Security-Policy", csp);
            }
            builder
                .body(std::borrow::Cow::Owned(asset.bytes))
                .unwrap_or_else(|_| asset_fallback())
        }
        None => tauri::http::Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(CONTENT_TYPE, "text/plain")
            .header("Access-Control-Allow-Origin", WINDOW_ORIGIN)
            .body(std::borrow::Cow::Borrowed(&b"asset not found"[..]))
            .unwrap_or_else(|_| asset_fallback()),
    }
}

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

    tauri::Builder::default()
        // Custom `tauri` asset protocol (overrides Tauri's built-in: when a user
        // registers "tauri", the internal one is skipped — see manager/webview.rs).
        // In dev mode it disk-serves /public with embedded fallback; otherwise it's
        // byte-identical to the built-in. Registered before the window builds.
        .register_uri_scheme_protocol("tauri", move |ctx, request| {
            serve_tauri_asset(&ctx, &request, dev_serve_for_proto.as_ref())
        })
        // Single-instance FIRST (plugin requirement): a duplicate launch focuses
        // the running window instead of spawning a process that can't bind :13333.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                // A second launch forwards here and exits; if this window can't be
                // shown ON-SCREEN the user just sees "opens then closes, no window".
                ensure_window_visible(&w);
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
                                            pane_id: pane.to_string(),
                                        });
                                    }
                                }
                            }
                            return allowed;
                        }
                        return true;
                    }
                    let allowed = matches!(url.scheme(), "tauri" | "ipc" | "about" | "blob" | "data")
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Native menu — a WKWebView shell with NO app menu also has no working
        // Cmd+C/V/X/A/Z and no Reload. Build the standard macOS menus plus an
        // explicit View ▸ Reload (Cmd+R), matching the Electron app.
        .menu(|handle| {
            use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
            let reload = MenuItem::with_id(handle, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            // Nessun acceleratore: Cmd+Shift+R e' "Record voice" nell'app (lo dice
            // il pannello delle scorciatoie e il tooltip del microfono). Il menu
            // teneva la scorciatoia buona per un doppione del Reload qui sopra —
            // e quando il fuoco stava in una webview figlia partiva davvero,
            // ricaricando l'app al posto di far partire il dettato. La voce resta,
            // cliccabile; la scorciatoia torna a chi la documenta.
            //
            // Da SOLO questo non basta e non bastava: il monitor NSEvent (cerca
            // `!shift_r`) intercetta il tasto prima del menu e prima della
            // webview. Sono due porte sulla stessa scorciatoia — se ne riapri una
            // la riapri per tutti.
            let force_reload =
                MenuItem::with_id(handle, "force-reload", "Force Reload", true, None::<&str>)?;
            let zoom_in = MenuItem::with_id(handle, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
            let zoom_out = MenuItem::with_id(handle, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
            let zoom_reset =
                MenuItem::with_id(handle, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
            // No accelerator: the Cmd/Ctrl+Alt+T chord is owned by the global
            // shortcut (works unfocused too); a menu accelerator on the same chord
            // would double-fire and cancel the toggle when the window is focused.
            let always_on_top =
                MenuItem::with_id(handle, "always-on-top", "Always on Top", true, None::<&str>)?;
            // Reset the focused window's split layout — flattens the panel tree
            // back to a single pane. The client already listens on the per-window
            // `topics:reset-split-layout` CustomEvent bus (GroupLayout / PanelGrid),
            // gated on which surface is App-focused, so we just dispatch it on the
            // focused window's webview (see the "reset-split-layout" menu handler).
            // No accelerator: the Command Palette already exposes this action, and a
            // menu chord risks colliding with a future pane shortcut.
            let reset_panels =
                MenuItem::with_id(handle, "reset-split-layout", "Reimposta pannelli", true, None::<&str>)?;
            // "Open at Login" (Electron parity). Toggling registers/removes the
            // LaunchAgent immediately. NOTE: we cannot read the current enabled state
            // here — the .menu() closure runs BEFORE the autostart plugin's setup
            // manages its AutoLaunchManager, so is_enabled() would panic. Plain label.
            let open_at_login =
                MenuItem::with_id(handle, "open-at-login", "Apri al login", true, None::<&str>)?;
            // Custom Quit (not the predefined .quit()) so ⌘Q sets QUITTING before
            // exiting — otherwise the hide-to-tray CloseRequested handler would
            // swallow the quit and trap the app in the tray.
            let app_quit =
                MenuItem::with_id(handle, "app-quit", "Quit Topics", true, Some("CmdOrCtrl+Q"))?;
            // "Check for Updates…" — drives the same client-side updater flow as the
            // sidebar Version popover (dispatches a DOM event the client listens for,
            // which calls updater_check → UpdaterToast). Without a manual entry point
            // the only trigger was the version popover; this makes it discoverable.
            let check_updates = MenuItem::with_id(
                handle,
                "check-updates",
                "Controlla aggiornamenti…",
                true,
                None::<&str>,
            )?;
            let app_menu = SubmenuBuilder::new(handle, "Topics")
                .about(None)
                .separator()
                .item(&check_updates)
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
                .item(&reset_panels)
                .separator()
                .item(&always_on_top)
                .item(&open_at_login)
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
                    // Il menu e la scorciatoia sono lo stesso gesto, quindi
                    // chiamano la stessa funzione: riparte TUTTA la app, non la
                    // sola finestra focussata. Il bundle è uno; ricaricarne una
                    // lasciava le altre (gruppi staccati, finestre progetto) su
                    // quello vecchio, a parlarsi sullo stesso pane-store.
                    // Non serve più risolvere la finestra focussata: le prende
                    // tutte, quella inclusa.
                    let _ = no_abort("menu_reload_all", || Ok(reload_all_ui_windows(app)));
                }
                "app-quit" => {
                    QUITTING.store(true, Ordering::Relaxed);
                    app.exit(0);
                }
                "reset-split-layout" => {
                    // Dispatch the per-window reset bus on the FOCUSED window's webview
                    // (not always "main" — detached project windows may exist). The
                    // client's GroupLayout / PanelGrid listen for this and flatten the
                    // App-focused surface. Resolve the focused window by label, map it
                    // to its webview_window (eval lives on the webview), fall back to
                    // "main" if none reports focus (e.g. menu click stole key status).
                    let label = app
                        .get_focused_window()
                        .map(|w| w.label().to_string())
                        .unwrap_or_else(|| "main".to_string());
                    let win = app
                        .get_webview_window(&label)
                        .or_else(|| app.get_webview_window("main"));
                    if let Some(win) = win {
                        let _ = win
                            .eval("window.dispatchEvent(new CustomEvent('topics:reset-split-layout'))");
                    }
                }
                "always-on-top" => toggle_always_on_top(app),
                "open-at-login" => {
                    use tauri_plugin_autostart::ManagerExt;
                    let mgr = app.autolaunch();
                    let _ = if mgr.is_enabled().unwrap_or(false) {
                        mgr.disable()
                    } else {
                        mgr.enable()
                    };
                }
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
                    // Same reaped path the client's openExternal takes — the
                    // plugin's opener leaks a zombie per call (see open_external).
                    let _ = open_external("https://github.com/armonia/topics-app".to_string());
                }
                "check-updates" => {
                    // Hand off to the client's updater flow (reuses updater_check +
                    // UpdaterToast). A DOM CustomEvent keeps the shell free of the
                    // @tauri-apps/event dependency — same bridge the tray uses.
                    if let Some(w) = app.get_webview_window("main") {
                        ensure_window_visible(&w);
                        let _ = w.eval(
                            "window.dispatchEvent(new CustomEvent('topics:check-for-updates'))",
                        );
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Local-dev auto-update (opt-in, per-machine): when this shell runs on a
            // dev machine that opted in (see `dev_auto_update_enabled`), silently pull
            // + install the newest signed release "da sotto" and relaunch — instead of
            // the client's manual opt-in toast. Gated on the dev marker so it NEVER
            // fires for prod installs. Runs once per launch, off-thread; the network
            // check itself defers the swap a beat past first paint, so the relaunch (if
            // any) lands right after a fresh start rather than mid-session.
            if dev_auto_update_enabled() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    let updater = match handle.updater() {
                        Ok(u) => u,
                        Err(e) => {
                            log_hot_reload_decision(&format!("auto-update: no updater ({e})"));
                            return;
                        }
                    };
                    match updater.check().await {
                        Ok(Some(update)) => {
                            let v = update.version.clone();
                            log_hot_reload_decision(&format!("auto-update: installing {v}"));
                            if let Err(e) =
                                update.download_and_install(|_, _| {}, || {}).await
                            {
                                log_hot_reload_decision(&format!(
                                    "auto-update: install {v} failed ({e})"
                                ));
                                return;
                            }
                            log_hot_reload_decision(&format!(
                                "auto-update: installed {v}, relaunching"
                            ));
                            handle.restart();
                        }
                        Ok(None) => log_hot_reload_decision("auto-update: up to date"),
                        Err(e) => {
                            log_hot_reload_decision(&format!("auto-update: check failed ({e})"))
                        }
                    }
                });
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

            // Forward app keyboard shortcuts (⌘W, ⌘⇧Tab, ⌘1-9…) to the renderer
            // when a child browser pane holds focus and would otherwise swallow
            // the keydown. macOS-only (NSEvent local monitor); see the fn doc.
            #[cfg(target_os = "macos")]
            install_shortcut_forwarder(app.handle());

            // Global right-⌘ TAP → focus the board task composer, even when Topics
            // is in the background (from any other app). Needs Accessibility trust
            // for the global key monitor — request it ONCE (see the fn), then arm the
            // monitor. The monitor is harmless without trust: it simply receives no
            // events, so arming it unconditionally costs nothing.
            #[cfg(target_os = "macos")]
            {
                install_accessibility_prompt(app.handle());
                install_global_cmd_tap(app.handle());
            }

            // UserNotifications delegate + one-time authorization request (first
            // launch shows the system prompt). Bundled-only; see the module doc.
            #[cfg(target_os = "macos")]
            macos_notifications::install(app.handle());

            // Push Focus/DND changes to the webview so the completion notifier can
            // fall silent while a Focus is on (best-effort; see `macos_focus`).
            #[cfg(target_os = "macos")]
            spawn_focus_watcher(app.handle().clone());

            // Dev hot-reload (Electron-prod parity). By default the frontend is
            // EMBEDDED (include_bytes! over frontendDist) and served from
            // tauri://localhost — a `vite build` does nothing for a running binary.
            // The custom `tauri` protocol (see run() head) opts INTO disk-serving
            // /public when a dev marker is set; here we start the watcher that
            // PROMPTS the app-shell webviews when that on-disk /public changes, one
            // prompt per build burst. OFF (no watcher) when the marker is absent, so
            // release behavior is unchanged. Uses the SAME value the protocol handler
            // captured (resolved eagerly before the Builder — no race, no re-read).
            {
                if let Some(dev) = dev_serve.clone() {
                    spawn_public_watcher(app.handle().clone(), dev.public_dir);
                }
            }

            // Env-gated sidebar FPS self-test: drive real collapse/expands and sample
            // rAF frame timing, writing the summary to /tmp/topics-fps-selftest.json.
            // OFF unless TOPICS_FPS_SELFTEST is set. The `fps_report` sink command is
            // debug-only (see its #[cfg(debug_assertions)]), so this probe only works
            // in debug builds even when the env var is set in release.
            #[cfg(debug_assertions)]
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
                        // Un-occlude the window first: WKWebView throttles requestAnimationFrame
                        // when the window's pixels aren't on screen (occluded behind others) —
                        // the headless "no frames sampled" failure. rAF pauses on OCCLUSION, not
                        // on key-status, so `always_on_top` (float above everything → visible)
                        // resumes it even when macOS denies foreground focus to a shell-launched
                        // app. This is a disposable debug instance (env-gated, never on in
                        // normal use), so always-on-top is left on — toggle it off from the
                        // tray, or just quit, when done.
                        // Use get_window (the "main" WINDOW exists even in this multi-webview
                        // app — browser_open relies on it; get_webview_window may be None).
                        if let Some(win) = h.get_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_always_on_top(true);
                            let _ = win.set_focus();
                            let vis = win.is_visible().unwrap_or(false);
                            let minz = win.is_minimized().unwrap_or(false);
                            eprintln!("[fps-selftest] window main: visible={vis} minimized={minz} (always_on_top+focus applied)");
                        } else {
                            eprintln!("[fps-selftest] get_window(main) = None");
                        }
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
            #[cfg(debug_assertions)]
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
            #[cfg(debug_assertions)]
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
            #[cfg(debug_assertions)]
            if std::env::var("TOPICS_SPLIT_SELFTEST").is_ok() {
                eprintln!("[split-selftest] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        // Un-occlude (always_on_top) so rAF runs — see the FPS probe note above.
                        if let Some(win) = h.get_webview_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_always_on_top(true);
                            let _ = win.set_focus();
                        }
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

            // Env-gated COST self-test: measure per-frame style+layout cost of a split-drag
            // (+ sidebar toggle reflow) — empirical, works headless (no rAF/visibility needed).
            #[cfg(debug_assertions)]
            if std::env::var("TOPICS_COST_SELFTEST").is_ok() {
                eprintln!("[cost-selftest] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(wv) = h.get_webview("main") {
                            eprintln!("[cost-selftest] injecting via get_webview(main)");
                            match wv.eval(COST_SELFTEST_JS) {
                                Ok(()) => eprintln!("[cost-selftest] eval ok"),
                                Err(e) => eprintln!("[cost-selftest] eval err: {e}"),
                            }
                        } else {
                            eprintln!("[cost-selftest] no main webview");
                        }
                    });
                });
            }

            // Env-gated BROWSER self-test: open a native pane, eval into it, close it —
            // confirms the browser open→eval path end-to-end (no window visibility needed).
            #[cfg(debug_assertions)]
            if std::env::var("TOPICS_BROWSER_SELFTEST").is_ok() {
                eprintln!("[browser-selftest] armed");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::Manager;
                        if let Some(wv) = h.get_webview("main") {
                            eprintln!("[browser-selftest] injecting via get_webview(main)");
                            match wv.eval(BROWSER_SELFTEST_JS) {
                                Ok(()) => eprintln!("[browser-selftest] eval ok"),
                                Err(e) => eprintln!("[browser-selftest] eval err: {e}"),
                            }
                        } else {
                            eprintln!("[browser-selftest] no main webview");
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
            #[cfg(debug_assertions)]
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
                                None,
                                None, // window_label: demo runs against main
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

            // Decide the data-server upstream, THEN start the loopback proxy. On a
            // machine with an external server on :3333 we defer to it (TLS proxy, as
            // before); on a virgin machine we spawn the bundled sidecar (plain HTTP,
            // isolated data dir) and point the proxy there. `decide_upstream_and_spawn`
            // sets `UPSTREAM` then RETURNS (its up-to-20s sidecar health wait is now
            // fire-and-forget), so run_tls_proxy binds :13333 immediately — the virgin
            // machine no longer sits on "connecting" for the whole cold start.
            // Reachable from AppKit notification callbacks, which carry no user data.
            let _ = SHELL_APP.set(app.handle().clone());
            // Display change / wake → re-anchor + bounce (PORTING-PLAN T1.3).
            #[cfg(target_os = "macos")]
            wire_recompose_observers();

            {
                let app_for_boot = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    decide_upstream_and_spawn(app_for_boot.clone()).await;
                    // The recovery path, started for BOTH upstreams (external server
                    // and bundled sidecar) — see `watch_upstream`. Spawned before the
                    // proxy because `run_tls_proxy` never returns.
                    tauri::async_runtime::spawn(watch_upstream(app_for_boot));
                    run_tls_proxy().await;
                });
            }

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
                    // RESTORE the saved geometry ourselves (see win_size_file) — ALL in
                    // LOGICAL points, the one coherent global space on macOS. History of
                    // this block: the tauri-plugin-window-state plugin mis-handled scale
                    // (saved physical-as-logical, restored blindly off-screen); then our
                    // own store kept position in tao-"physical" pixels, which are scaled
                    // by the CURRENT monitor's backing factor — on a mixed-DPI setup the
                    // window is born on the scale-2 primary (`center: true`) while the
                    // position was saved from a scale-1 external, so the restore landed
                    // at HALF the coordinates and the next throttled save ratcheted the
                    // wrong spot into the store ("la finestra perde la posizione" on
                    // every relaunch/update). Now: saved logical position → validated
                    // against LOGICAL monitor rects → applied as LogicalPosition FIRST
                    // (so the size below lands on the destination display), then the
                    // logical size; center only when no usable position is stored.
                    if _label == "main" {
                        let store = win_size_file(app.handle());
                        let saved_size = store.as_ref().and_then(|p| read_win_size_logical(p));
                        let saved_pos = store.as_ref().and_then(|p| read_win_position_logical(p));
                        let placed = if let Some(saved) = saved_pos {
                            // Clamp with the SAVED footprint (what the window is about to
                            // become), not the pre-restore config-default frame.
                            let win_size = saved_size
                                .map(|(w, h)| (w.round() as u32, h.round() as u32))
                                .unwrap_or((1200, 800));
                            let monitors = logical_monitors(&win);
                            if let Some((nx, ny)) =
                                clamp_position_to_monitors(saved, win_size, &monitors)
                            {
                                let _ = win
                                    .set_position(tauri::LogicalPosition::new(nx as f64, ny as f64));
                                eprintln!(
                                    "[window-restore] applied logical position {nx},{ny} (saved {},{})",
                                    saved.0, saved.1
                                );
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        };
                        if let Some((lw, lh)) = saved_size {
                            let _ = win.set_size(tauri::LogicalSize::new(lw, lh));
                            eprintln!("[window-restore] applied logical {lw}x{lh}");
                        }
                        if !placed {
                            // No usable saved position (fresh install, or a legacy store
                            // whose physical x/y are ambiguous on mixed-DPI — dropped on
                            // purpose, see read_win_position_logical) — set_size grows
                            // from the top-left, so center to keep the window on its
                            // display. The next save writes lx/ly and this never re-runs.
                            let _ = win.center();
                            eprintln!("[window-restore] no saved position — centered");
                        }
                        if let (Ok(os), Ok(op), Ok(sf)) =
                            (win.outer_size(), win.outer_position(), win.scale_factor())
                        {
                            eprintln!(
                                "[window-restore] main now outer={}x{} @ {},{} scale={} logical={}x{}",
                                os.width, os.height, op.x, op.y, sf,
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
                            if let (Some(p), Some(((lx, ly), (lw, lh)))) =
                                (size_file.as_ref(), window_logical_geometry(w))
                            {
                                // Persist SIZE + POSITION in LOGICAL points (see the
                                // win_size_file note: tao-physical is per-monitor-scaled,
                                // wrong across mixed-DPI displays). This throttle is
                                // leading-edge (the last move of a gesture can be
                                // dropped) — the ExitRequested save is the guaranteed
                                // final write on quit/relaunch/update.
                                save_win_size_logical(p, lw as f64, lh as f64, Some((lx, ly)));
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
                let mut builder = TrayIconBuilder::with_id("main")
                    .tooltip("Topics")
                    .menu(&tray_menu)
                    .on_menu_event(|app, event| {
                        let id = event.id().0.as_str();
                        if id == "tray-show" {
                            if let Some(w) = app.get_webview_window("main") {
                                ensure_window_visible(&w);
                            }
                        } else if id == "tray-quit" {
                            QUITTING.store(true, Ordering::Relaxed);
                            app.exit(0);
                        } else if id == "tray-new-chat" {
                            // Stesso bus del composer: la riga della tray non è un
                            // gesto nuovo, è la stessa porta vista da fuori.
                            tray_dispatch(app, "topics:new-chat", None);
                        } else if id == "tray-check-updates" {
                            // Identico alla voce del menu nativo (updater_check +
                            // UpdaterToast lato client).
                            tray_dispatch(app, "topics:check-for-updates", None);
                        } else if id.starts_with("board:") {
                            // La testa della sezione e il piede di ogni sottomenu:
                            // portano alla board, che è dove il lavoro si guarda per
                            // intero. Lo stato dopo i due punti non seleziona niente
                            // (la board mostra tutte le colonne), serve solo a dare
                            // un id distinto a ogni riga.
                            tray_dispatch(app, "topics:tray-open-board", None);
                        } else if let Some(task_id) = id.strip_prefix("task:") {
                            // Una riga di un sottomenu di stato: apre QUEL task, cioè
                            // il deep-link `/task/<id>` che già apre il cassetto dalla
                            // cronologia delle notifiche.
                            tray_dispatch(app, "topics:tray-open-task", Some(("taskId", task_id)));
                        } else if let Some(topic_id) = id.strip_prefix("nav:") {
                            // A dynamic attention row (set by `set_app_status`): surface
                            // the window and hand the topic id to the renderer, which
                            // opens/focuses it exactly like a sidebar click. A DOM
                            // CustomEvent (not a Tauri event) keeps the client free of
                            // the @tauri-apps/event dependency — same bridge the native
                            // shortcut forwarder uses.
                            tray_dispatch(app, "topics:tray-navigate", Some(("topicId", topic_id)));
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    builder = builder.icon(icon.clone());
                }
                let _ = builder.build(app.handle())?;
            }

            // Restore the persisted always-on-top state (Electron parity — it was
            // an in-memory flag that reset to off every launch).
            {
                use tauri::Manager;
                let on = read_aot(app.handle());
                ALWAYS_ON_TOP.store(on, Ordering::Relaxed);
                if on {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.set_always_on_top(true);
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            perf_metrics,
            set_traffic_lights,
            set_theme,
            notify,
            notification_status,
            focus_status,
            open_external,
            set_clipboard_image,
            set_app_status,
            vibrancy_set_regions,
            vibrancy_animate_regions,
            browser_open,
            browser_navigate,
            browser_set_bounds,
            browser_set_visible,
            browser_animate_bounds,
            browser_close,
            browser_purge_data_store,
            browser_purge_cache,
            browser_site_data_records,
            browser_forget_site,
            browser_reap_data_stores,
            browser_claim,
            browser_list,
            browser_eval_js,
            browser_screenshot,
            browser_pane_get_cookies,
            browser_pane_set_cookies,
            browser_exec_js,
            browser_back,
            browser_forward,
            browser_reload,
            browser_set_user_agent,
            browser_toggle_devtools,
            browser_release_focus,
            browser_nav_entries,
            browser_go_to_index,
            #[cfg(debug_assertions)]
            fps_report,
            focus_read,
            #[cfg(debug_assertions)]
            focus_grab_browser,
            #[cfg(debug_assertions)]
            focus_grab_window,
            #[cfg(debug_assertions)]
            focus_report,
            browser_take_download_events,
            browser_take_nav_errors,
            browser_take_nav_state,
            browser_download_progress,
            updater_check,
            updater_install,
            window_detach,
            window_detach_space,
            window_focus_label,
            window_close_label,
            app_reload_all,
            window_close_self
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS dock-icon click while the app is hidden-to-tray: bring the
            // window back (Electron parity: app.on('activate')). Without this the
            // dock icon is DEAD once the red button / ⌘W parks the app in the tray
            // — the only way back was the tray menu. RunEvent::Reopen fires on the
            // dock click (and on `open` with no windows). The variant only EXISTS
            // on macOS — an unguarded match arm breaks the Windows/Linux compile
            // (first cross-platform CI build caught it).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                use tauri::Manager;
                if let Some(w) = app_handle.get_webview_window("main") {
                    ensure_window_visible(&w);
                }
            }
            // Final geometry save on the way out — fires on ⌘Q, tray "Esci", the
            // status-bar relaunch AND the updater restart (AppHandle::restart()
            // triggers ExitRequested before Exit). The throttled Moved/Resized
            // saves are leading-edge and CloseRequested only hides to tray, so
            // without this the last position before an "Aggiorna" could be lost.
            // The windows are still alive at ExitRequested (not yet at Exit).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let _ = no_abort("exit-save-geometry", || {
                    save_main_window_geometry(app_handle);
                    Ok(())
                });
            }
            // Kill the bundled server sidecar (if we spawned one) as the app exits,
            // so no orphan server process outlives the shell. Exit fires on the real
            // quit paths (tray "Esci", ⌘Q → app.exit(0)); no-op when we deferred to
            // an external server (SIDECAR_CHILD is None). `_app_handle` unused here.
            if let tauri::RunEvent::Exit = event {
                kill_sidecar();
            }
        });
}

/// La CPU della status bar ha già mentito tre volte, ogni volta con un numero
/// plausibile: 224% e 85% quando il vero era 46% e 14% (finestra non
/// deterministica di `sysinfo`), poi 2% quando il vero era 46,6% (slot di rusage
/// letti come nanosecondi invece che come tick di mach absolute time).
///
/// Il primo test è quello che avrebbe preso l'ultimo, e il modo in cui lo fa è il
/// punto: confronta `proc_pid_rusage` con `getrusage(RUSAGE_SELF)`, che misura la
/// STESSA grandezza — il tempo di CPU di questo processo — in un'unità
/// indipendente (secondi e microsecondi reali, non tick). Due letture della stessa
/// cosa in due unità diverse: se l'unità è sbagliata, il rapporto lo dice.
///
/// Il primo tentativo confrontava invece col tempo di PARETE, e ho dovuto
/// buttarlo: su questa macchina a load 47 un thread solo prendeva il 30% di un
/// core, quindi il test falliva per il carico e non per il bug. Un test che
/// dipende da quanto è occupata la macchina non è una guardia.
#[cfg(all(test, target_os = "macos"))]
mod perf_cpu_tests {
    use super::{mach_ticks_to_ns, proc_cpu_ns, proc_cpu_percent};

    /// `struct timeval`: secondi e microsecondi VERI, nessun tick di mezzo.
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct TimeVal {
        tv_sec: i64,
        tv_usec: i32,
    }

    /// `struct rusage` di BSD. Servono solo i primi due campi; la coda esiste
    /// perché il kernel scrive tutta la struttura.
    #[repr(C)]
    #[derive(Default)]
    struct RUsage {
        ru_utime: TimeVal,
        ru_stime: TimeVal,
        ru_rest: [i64; 14],
    }

    extern "C" {
        fn getrusage(who: i32, usage: *mut RUsage) -> i32;
    }

    /// Tempo di CPU di questo processo in ns, dalla via completamente indipendente.
    fn getrusage_self_ns() -> u64 {
        const RUSAGE_SELF: i32 = 0;
        let mut ru = RUsage::default();
        assert_eq!(unsafe { getrusage(RUSAGE_SELF, &mut ru) }, 0, "getrusage");
        let ns = |t: TimeVal| t.tv_sec as u64 * 1_000_000_000 + t.tv_usec as u64 * 1_000;
        ns(ru.ru_utime) + ns(ru.ru_stime)
    }

    #[test]
    fn il_tempo_di_cpu_e_in_nanosecondi_veri() {
        // Brucia un po' di CPU: quanta non conta, conta che il contatore non sia
        // ~0 — un confronto fra due zeri passerebbe qualunque cosa.
        let start = std::time::Instant::now();
        let mut x: u64 = 0;
        while start.elapsed() < std::time::Duration::from_millis(300) {
            x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        }
        std::hint::black_box(x);

        // Le tre letture sono di fila, e le due esterne fanno da forchetta: gli
        // altri test del binario girano in parallelo e continuano a consumare CPU
        // fra una syscall e l'altra.
        let prima = getrusage_self_ns();
        let nostro = proc_cpu_ns(std::process::id() as i32).expect("rusage sul nostro pid");
        let dopo = getrusage_self_ns();

        assert!(prima > 50_000_000, "CPU consumata troppo poca per confrontare: {prima} ns");
        let rapporto = nostro as f64 / prima as f64;
        assert!(
            nostro >= prima / 20 * 19 && nostro <= dopo / 20 * 21,
            "proc_pid_rusage dice {nostro} ns, getrusage dice {prima}..{dopo} ns \
             (rapporto {rapporto:.3}): se è ~0,024 gli slot di rusage non sono \
             stati convertiti da tick di mach absolute time a nanosecondi"
        );
    }

    /// Senza campione precedente la risposta è `None`, e la SECONDA lettura è un
    /// numero. Sembra ovvio e non lo era: `perf_metrics` faceva
    /// `.unwrap_or(0.0)` su questo `None`, quindi ogni pid appena comparso —
    /// una pane aperta, un WebContent rinato dopo un reload — contribuiva ZERO a
    /// una somma presentata come la CPU dell'intera app. Il totale era più basso
    /// del vero e nessuno poteva accorgersene, perché uno zero misurato e uno
    /// zero inventato si scrivono uguale.
    ///
    /// NOTA: questo test è l'unico chiamante di `proc_cpu_percent` nel binario di
    /// test. La mappa dei campioni è globale, quindi se un altro test la toccasse
    /// sullo stesso pid la prima asserzione diventerebbe fragile.
    #[test]
    fn senza_baseline_la_cpu_e_non_misurata_non_zero() {
        let own = std::process::id() as i32;
        let live: std::collections::HashSet<i32> = [own].into_iter().collect();

        assert_eq!(
            proc_cpu_percent(own, &live),
            None,
            "la prima lettura non ha una finestra su cui dividere: deve essere None, \
             non uno zero — uno zero qui è ciò che abbassava silenziosamente il totale"
        );

        // Un po' di CPU e un po' di tempo, così il secondo delta è positivo e la
        // finestra non è zero.
        let start = std::time::Instant::now();
        let mut x: u64 = 0;
        while start.elapsed() < std::time::Duration::from_millis(50) {
            x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        }
        std::hint::black_box(x);

        let secondo = proc_cpu_percent(own, &live);
        assert!(
            secondo.is_some(),
            "con un campione precedente la CPU è misurabile, e deve essere Some"
        );
        let v = secondo.unwrap();
        assert!(v >= 0.0 && v.is_finite(), "percentuale non sensata: {v}");
    }

    #[test]
    fn la_conversione_del_timebase_e_monotona_e_non_azzera() {
        // Le sole proprietà asseribili senza cablare il rapporto di UNA
        // architettura: su Intel il timebase è 1/1 e la conversione è l'identità,
        // su Apple Silicon è 125/3.
        assert_eq!(mach_ticks_to_ns(0), 0);
        assert!(mach_ticks_to_ns(1_000_000) >= 1_000_000);
        assert!(mach_ticks_to_ns(2_000_000) > mach_ticks_to_ns(1_000_000));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod webview_usage_tests {
    use super::{collect_webview_usage, web_process_identifier, webview_content_pid_map};
    use std::collections::HashSet;

    /// La mappa dei pid e' UNA per processo e `cargo test` esegue i test in
    /// parallelo: senza serializzare, un test azzera la mappa mentre un altro la
    /// legge (visto: due rossi intermittenti alla prima stesura). Il lock rende
    /// questi quattro sequenziali fra loro senza rallentare il resto della suite.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sostituisce il contenuto della mappa: ogni test riscrive da zero invece
    /// di aggiungere a quello che ha lasciato il precedente.
    fn set_map(entries: &[(&str, i32)]) {
        let mut m = webview_content_pid_map().lock().unwrap_or_else(|e| e.into_inner());
        m.clear();
        for (l, p) in entries {
            m.insert((*l).to_string(), *p);
        }
    }

    #[test]
    fn una_webview_il_cui_processo_e_morto_non_compare() {
        let _g = guard();
        // Il difetto che chiude: una scheda chiusa (o ricaricata, che cambia
        // WebContent) resterebbe in lista con la sua ultima misura — un numero
        // vero riferito a un processo che non esiste piu'. Peggio ancora se il
        // kernel ha nel frattempo riassegnato quel pid a qualcun altro.
        set_map(&[("viva", 1), ("morta", 999_999)]);
        let live: HashSet<i32> = [1].into_iter().collect();
        let out = collect_webview_usage(&live);
        assert_eq!(out.len(), 1, "solo la webview viva");
        assert_eq!(out[0].label, "viva");
        assert_eq!(out[0].pid, 1);
    }

    #[test]
    fn l_ordine_e_stabile_fra_due_letture() {
        let _g = guard();
        // Una `HashMap` itera in ordine casuale: senza il sort, una lista
        // mostrata in colonna si rimescolerebbe a ogni campionamento.
        set_map(&[("zeta", 1), ("alfa", 1), ("mezzo", 1)]);
        let live: HashSet<i32> = [1].into_iter().collect();
        let a: Vec<String> = collect_webview_usage(&live).into_iter().map(|w| w.label).collect();
        let b: Vec<String> = collect_webview_usage(&live).into_iter().map(|w| w.label).collect();
        assert_eq!(a, b, "due letture, stesso ordine");
        assert_eq!(a, vec!["alfa", "mezzo", "zeta"], "ordinate per label");
    }

    #[test]
    fn nessuna_webview_associata_da_lista_vuota_non_zeri() {
        let _g = guard();
        // Vuoto = "non ancora misurato" e il client lo dice; una lista di zeri
        // direbbe "tutte ferme", che e' un'altra affermazione.
        set_map(&[]);
        let live: HashSet<i32> = [1, 2, 3].into_iter().collect();
        assert!(collect_webview_usage(&live).is_empty());
    }

    #[test]
    fn un_puntatore_nullo_non_fa_crashare_la_spi() {
        // `_webProcessIdentifier` e' SPI: la difesa e' `respondsToSelector`, ma
        // prima ancora il puntatore va controllato — `with_webview` puo'
        // consegnare un inner nullo su una webview in via di distruzione.
        assert_eq!(unsafe { web_process_identifier(std::ptr::null_mut()) }, 0);
    }
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

#[cfg(all(test, target_os = "macos"))]
mod screenshot_tests {
    use super::{clamp_position_to_monitors, nsimage_to_png_base64};
    use crate::mac::*;

    // Headless proof of the novel conversion chain (no webview / app / run-loop):
    // a synthetic 4x4 RGBA NSImage → nsimage_to_png_base64 → a string whose bytes
    // are a real PNG. PNG magic (\x89PNG\r\n\x1a\n) base64-encodes to a fixed
    // "iVBORw0KGgo" prefix, so a prefix check needs no base64 decoder.
    #[test]
    fn nsimage_converts_to_valid_png_base64() {
        unsafe {
            let cs_ns = nsstring("NSDeviceRGBColorSpace");
            let cs: id = objc2::rc::Retained::as_ptr(&cs_ns) as id;
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

    // The on-screen guarantee behind ensure_window_visible: a window whose last
    // position lived on a since-disconnected display must be re-anchored fully
    // inside a live monitor, while a still-valid position is left untouched.
    #[test]
    fn clamp_reanchors_off_screen_and_honors_valid() {
        // Single built-in display at the origin, 1440x900 logical-as-physical.
        let builtin = (0i32, 0i32, 1440u32, 900u32);

        // The real field case: window last seen at (-784,-1410) on an external
        // ultrawide ABOVE the laptop; that display is now unplugged → must land
        // fully inside the built-in (top-left non-negative, fits the monitor).
        let (nx, ny) =
            clamp_position_to_monitors((-784, -1410), (1400, 900), &[builtin]).expect("some pos");
        assert!(nx >= 0 && ny >= 0, "re-anchored off-screen: {nx},{ny}");
        assert!(nx + 1400 <= 1440 && ny + 900 <= 900, "window not inside monitor: {nx},{ny}");

        // A position with its top edge on the built-in is honored verbatim.
        assert_eq!(
            clamp_position_to_monitors((100, 50), (600, 400), &[builtin]),
            Some((100, 50))
        );

        // No monitors enumerated → None, so the caller centers instead of trusting
        // a stale rect.
        assert_eq!(clamp_position_to_monitors((10, 10), (600, 400), &[]), None);

        // Multi-monitor: the external-above position is still valid while that
        // monitor is attached (negative Y honored), then re-anchored once it's gone.
        let external_above = (-784i32, -1410i32, 3440u32, 1410u32);
        assert_eq!(
            clamp_position_to_monitors((-784, -1410), (1400, 900), &[builtin, external_above]),
            Some((-784, -1410)),
            "valid position on the attached external display must be honored"
        );
    }
}

#[cfg(test)]
mod bundle_rev_tests {
    use super::{bundle_rev_from_html, stamp_bundle_rev};

    /// Il rev DEVE essere identico a quello di `readBundleRev`
    /// (server/lib/dev-bundle-reload.ts): stessi nomi, deduplicati, ordinati,
    /// uniti da virgola. Se le due metà divergono il client vede un mismatch
    /// eterno e mostra per sempre "Nuova versione disponibile".
    #[test]
    fn rev_matches_the_server_shape() {
        let html = r#"<!doctype html><html><head>
            <link rel="stylesheet" href="/assets/index-CbOOmmZR.css">
            <script type="module" src="/assets/index-DR6ye0r0.js"></script>
        </head><body></body></html>"#;
        assert_eq!(
            bundle_rev_from_html(html),
            "/assets/index-CbOOmmZR.css,/assets/index-DR6ye0r0.js"
        );
    }

    /// Ordine di apparizione irrilevante + duplicati collassati: il JS fa
    /// `[...new Set(names)].sort()`, qui `sort` + `dedup`. Stesso risultato.
    #[test]
    fn rev_is_sorted_and_deduped() {
        let html = r#"<head><script src="/assets/index-Zz.js"></script>
            <script src="/assets/index-Aa.css"></script>
            <script src="/assets/index-Zz.js"></script></head>"#;
        assert_eq!(bundle_rev_from_html(html), "/assets/index-Aa.css,/assets/index-Zz.js");
    }

    /// Solo `index-*`: i chunk lazy (hast-util, micromark, CodeMirror…) non
    /// entrano nel rev, altrimenti tornerebbe il loop fantasma del 2026-07-26.
    #[test]
    fn rev_ignores_non_entry_chunks() {
        let html = r#"<head><script src="/assets/index-Aa.js"></script>
            <link rel="modulepreload" href="/assets/mermaid.core-B2tWQShl.js"></head>"#;
        assert_eq!(bundle_rev_from_html(html), "/assets/index-Aa.js");
    }

    /// Nessun asset (index.html non ancora costruito / mid-rsync) ⇒ nessun rev,
    /// nessun timbro: meglio "controllo non applicabile" di un rev sbagliato.
    #[test]
    fn no_assets_means_no_stamp() {
        let html = "<html><head></head><body>ciao</body></html>";
        assert_eq!(bundle_rev_from_html(html), "");
        assert_eq!(stamp_bundle_rev(html, ""), html);
    }

    /// Il meta va SUBITO dopo `<head>`, come `stampBundleRev` lato server.
    #[test]
    fn stamp_goes_first_in_head() {
        let out = stamp_bundle_rev("<html><head><title>x</title></head>", "/assets/index-Aa.js");
        assert_eq!(
            out,
            "<html><head><meta name=\"topics-bundle-rev\" content=\"/assets/index-Aa.js\"><title>x</title></head>"
        );
    }

    /// Documento senza `<head>`: il tag va in testa, non si perde.
    #[test]
    fn stamp_without_head_prepends() {
        let out = stamp_bundle_rev("<body>x</body>", "/assets/index-Aa.js");
        assert!(out.starts_with("<meta name=\"topics-bundle-rev\""));
        assert!(out.ends_with("<body>x</body>"));
    }
}

#[cfg(test)]
mod window_recovery_tests {
    use super::{
        connect_upstream_retrying, is_document_head, is_websocket_head, rect_intersects_any,
        reconnect_page_response, RELOAD_IF_BLANK_JS,
    };
    use std::time::Duration;

    /// A current-thread runtime for the two socket tests (the crate's tokio has no
    /// `macros` feature, so there is no `#[tokio::test]`).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    const DOC: &[u8] = b"GET / HTTP/1.1\r\nHost: 127.0.0.1:13333\r\n\
Accept: text/html,application/xhtml+xml\r\nSec-Fetch-Dest: document\r\n\r\n";
    const XHR: &[u8] = b"GET /api/topics HTTP/1.1\r\nHost: 127.0.0.1:13333\r\n\
Accept: application/json\r\nSec-Fetch-Dest: empty\r\n\r\n";
    const WS: &[u8] = b"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:13333\r\n\
Upgrade: websocket\r\nConnection: Upgrade\r\nAccept: */*\r\n\r\n";

    /// Only a top-level navigation may be answered with the reconnect page: an XHR
    /// gets HTML where it wanted JSON, and a WebSocket gets a broken handshake.
    #[test]
    fn only_documents_get_the_reconnect_page() {
        assert!(is_document_head(DOC));
        assert!(!is_document_head(XHR));
        assert!(!is_document_head(WS));
        assert!(is_websocket_head(WS));
        assert!(!is_websocket_head(DOC));
    }

    /// A browser that sends no `Sec-Fetch-Dest` must still be recognised by Accept.
    #[test]
    fn accept_html_is_enough_without_sec_fetch_dest() {
        let head = b"GET / HTTP/1.1\r\nHost: x\r\nAccept: text/html\r\n\r\n";
        assert!(is_document_head(head));
    }

    /// The whole point of the page is that it PAINTS (opaque background — the window
    /// is transparent, so "nothing" is invisible, not white) and comes back BY ITSELF.
    #[test]
    fn reconnect_page_paints_and_self_reloads() {
        let r = String::from_utf8(reconnect_page_response()).unwrap();
        assert!(r.starts_with("HTTP/1.1 503 "));
        assert!(r.contains("Content-Type: text/html"));
        assert!(r.contains("Cache-Control: no-store"), "must never be cached over the app");
        assert!(r.contains("location.reload()"), "must recover with no human in the loop");
        assert!(r.contains("background:#1c1c1e"), "must paint opaque pixels");
        let len: usize = r
            .split("Content-Length: ")
            .nth(1)
            .and_then(|s| s.split("\r\n").next())
            .unwrap()
            .parse()
            .unwrap();
        let body = r.split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(len, body.len(), "Content-Length must match the body");
    }

    /// The nudge must be a no-op on a LIVE app (a forced reload would throw away a
    /// working session) and must fire on an empty document.
    #[test]
    fn blank_guard_spares_a_mounted_app() {
        assert!(RELOAD_IF_BLANK_JS.contains("childElementCount>0)return"));
        assert!(RELOAD_IF_BLANK_JS.contains("catch(e){location.reload()}"));
    }

    /// A server restart is ~2s of ECONNREFUSED. The old code gave up on the first
    /// one; this must hold on and succeed when the port comes back.
    #[test]
    fn connect_retries_across_a_restart() {
        rt().block_on(async {
        let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe); // port now closed — exactly like a server mid-restart
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            let _l = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            tokio::time::sleep(Duration::from_secs(3)).await;
        });
        let got = connect_upstream_retrying(port, Duration::from_secs(5)).await;
        assert!(got.is_some(), "must survive a port that comes back after 600ms");
        });
    }

    /// ...but it must still give up, so a document request falls through to the
    /// reconnect page instead of hanging forever on a server that is truly gone.
    #[test]
    fn connect_gives_up_after_the_grace() {
        rt().block_on(async {
        let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let t0 = std::time::Instant::now();
        let got = connect_upstream_retrying(port, Duration::from_millis(500)).await;
        assert!(got.is_none());
        assert!(t0.elapsed() < Duration::from_secs(3), "must not hang past the grace");
        });
    }

    /// Re-anchor only when the window is on NO screen. Attilio keeps this window at
    /// -797,-1410 on an ultrawide: negative is not "wrong", it's his choice.
    #[test]
    fn negative_position_on_a_real_monitor_is_left_alone() {
        let ultrawide = (-1720.0, -1440.0, 3440.0, 1440.0);
        let builtin = (0.0, 0.0, 1512.0, 982.0);
        let mons = [builtin, ultrawide];
        assert!(rect_intersects_any((-797.0, -1410.0, 1200.0, 800.0), &mons));
        // Same window after the ultrawide is unplugged: stranded, must be re-anchored.
        assert!(!rect_intersects_any((-797.0, -1410.0, 1200.0, 800.0), &[builtin]));
    }

    /// Touching edges only (x + w == mx) is NOT overlap — a window flush against a
    /// monitor's left edge from outside shows zero pixels.
    #[test]
    fn touching_edges_does_not_count_as_on_screen() {
        let mon = (0.0, 0.0, 1000.0, 800.0);
        assert!(!rect_intersects_any((-500.0, 0.0, 500.0, 400.0), &[mon]));
        assert!(rect_intersects_any((-499.0, 0.0, 500.0, 400.0), &[mon]));
    }
}

/// The end-to-end PROOF for the empty-window bug, kept out of the normal run
/// (`#[ignore]`) because it drives a real browser and takes ~15s:
///
///   cargo test --lib demo_window_recovers -- --ignored --nocapture
///
/// It serves a fake app through the SHIPPED `proxy_loop`, kills the upstream
/// mid-clip, and lets Playwright record what a user would see. The reload that
/// happens while the server is down is exactly the move that used to leave a
/// transparent, titlebar-less window with nothing to paint — i.e. invisible.
#[cfg(test)]
mod window_recovery_demo {
    use super::{proxy_loop, Upstream};

    /// Minimal HTTP server standing in for the Topics server: one fixed page whose
    /// marker (`TOPICS`) the browser checks for. Killed by aborting its task, which
    /// drops the listener — the same abrupt disappearance as a server restart.
    async fn fake_app_server(port: u16) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => panic!("fake upstream bind :{port}: {e}"),
        };
        loop {
            let Ok((mut s, _)) = listener.accept().await else { continue };
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf).await;
                let body = "<!doctype html><html><body style=\"background:#0b3d2e;color:#eafff5;\
font:24px/1.4 -apple-system,system-ui,sans-serif;display:flex;align-items:center;\
justify-content:center;height:100vh;margin:0\"><div id=\"root\">TOPICS \u{2014} app viva</div></body></html>";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
                    body.len(), body);
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.flush().await;
            });
        }
    }

    #[test]
    #[ignore]
    fn demo_window_recovers_after_server_restart() {
        let out_dir = std::env::var("DEMO_OUT")
            .unwrap_or_else(|_| "/tmp/topics-window-recovery".to_string());
        let _ = std::fs::create_dir_all(&out_dir);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let up_port = {
                let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
                l.local_addr().unwrap().port()
            };
            let proxy_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let proxy_port = proxy_listener.local_addr().unwrap().port();

            let server = tokio::spawn(fake_app_server(up_port));
            tokio::spawn(proxy_loop(proxy_listener, Upstream { port: up_port, tls: false }));
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;

            // The camera + browser, on its own clock (see window-recovery-demo.mjs).
            let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/window-recovery-demo.mjs");
            let repo_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
            let mut child = std::process::Command::new("node")
                .arg(script)
                .arg(proxy_port.to_string())
                .arg(&out_dir)
                .current_dir(repo_root)
                .spawn()
                .expect("spawn node (playwright-core must be installed)");

            // t=3s: the server goes down (a `launchctl kickstart -k`, a crash, an update).
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            server.abort();
            eprintln!("[demo] upstream :{up_port} DOWN");
            // t=9s: it comes back. Nothing else happens — no human, no click.
            tokio::time::sleep(std::time::Duration::from_secs(6)).await;
            tokio::spawn(fake_app_server(up_port));
            eprintln!("[demo] upstream :{up_port} BACK");

            let status = tokio::task::spawn_blocking(move || child.wait())
                .await
                .unwrap()
                .expect("node exited");
            assert!(status.success(), "the window did not come back by itself");
            eprintln!("[demo] clip in {out_dir}");
        });
    }
}

/// L'etichetta di una pane browser, e cosa succede quando la sua vista rifiuta
/// di morire.
///
/// La catena che questi test chiudono: col mutex del dispatcher avvelenato
/// `Webview::close()` panica, quindi `on_webview_close` non gira mai e
/// l'etichetta resta REGISTRATA nel manager di tauri; `browser_open` sullo
/// stesso id trovava quella webview e prendeva il ramo di RIUSO, riconsegnando
/// la stessa vista morta. «Ricrea la scheda» non ricreava niente.
#[cfg(test)]
mod browser_label_tests {
    use super::{browser_label, burn_pane_label, close_verdict, pane_id_from_label, pane_label_generation};
    use std::collections::HashSet;

    // Il registro delle bruciature è un globale di processo: ogni test usa un id
    // suo, così l'ordine di esecuzione non conta.

    #[test]
    fn una_pane_sana_ha_l_etichetta_semplice() {
        assert_eq!(pane_label_generation("sana"), 0);
        assert_eq!(browser_label("sana"), "browserpane-sana");
    }

    /// Il cuore della cura: dopo la bruciatura l'etichetta è DIVERSA, quindi
    /// `app.get_webview(&browser_label(id))` non trova più la vista morta e
    /// `browser_open` cade nel ramo di CREAZIONE invece che in quello di riuso.
    #[test]
    fn bruciare_cambia_l_etichetta_cosi_open_non_puo_riusare() {
        let id = "bruciata";
        let prima = browser_label(id);
        assert_eq!(burn_pane_label(id), 1);
        let dopo = browser_label(id);
        assert_ne!(prima, dopo, "l'etichetta bruciata non va riusata");
        assert_eq!(dopo, "browserpane-~1~bruciata");
    }

    /// Una vista può morire due volte: la generazione sale, e ogni giro dà
    /// un'etichetta ancora libera.
    #[test]
    fn bruciature_ripetute_salgono_di_generazione() {
        let id = "due-volte";
        assert_eq!(burn_pane_label(id), 1);
        let g1 = browser_label(id);
        assert_eq!(burn_pane_label(id), 2);
        assert_eq!(pane_label_generation(id), 2);
        assert_ne!(g1, browser_label(id));
    }

    /// L'id resta l'id: è come chiamano la pane il client, gli agenti e le cache
    /// (bounds, corner, nav-error). Bruciare l'etichetta non deve rinominarla.
    #[test]
    fn l_id_sopravvive_alla_bruciatura() {
        let id = "id-stabile";
        assert_eq!(pane_id_from_label(&browser_label(id)), Some(id));
        burn_pane_label(id);
        assert_eq!(pane_id_from_label(&browser_label(id)), Some(id));
    }

    /// `browser_list` filtra per prefisso: una pane rigenerata deve restare
    /// visibile, e la sua etichetta vecchia (webview morta ancora registrata)
    /// deve risalire allo STESSO id — è così che la lista le collassa in una.
    #[test]
    fn vecchia_e_nuova_etichetta_danno_lo_stesso_id() {
        assert!(browser_label("prefisso").starts_with("browserpane-"));
        assert_eq!(pane_id_from_label("browserpane-x"), Some("x"));
        assert_eq!(pane_id_from_label("browserpane-~3~x"), Some("x"));
    }

    /// Etichette che non sono di una pane browser non vanno interpretate.
    #[test]
    fn le_etichette_altrui_non_sono_pane() {
        assert_eq!(pane_id_from_label("main"), None);
        assert_eq!(pane_id_from_label("popout-1"), None);
    }

    /// Un id che comincia per `~` senza generazione valida non viene mutilato:
    /// meglio restituire il resto così com'è che inventare un id.
    #[test]
    fn una_tilde_che_non_e_una_generazione_resta_nell_id() {
        assert_eq!(pane_id_from_label("browserpane-~strano"), Some("~strano"));
        assert_eq!(pane_id_from_label("browserpane-~~x"), Some("~~x"));
    }

    /// Una chiusura riuscita non brucia niente: l'etichetta è libera e la pane
    /// riapre esattamente dov'era, che è il caso di gran lunga più comune.
    #[test]
    fn una_chiusura_riuscita_non_brucia_niente() {
        let id = "chiusa-bene";
        assert!(close_verdict(id, false).is_ok());
        assert_eq!(pane_label_generation(id), 0);
    }

    /// LA CATENA, in miniatura. `manager` è il registro di tauri: `browser_open`
    /// prende il ramo di riuso esattamente quando contiene `browser_label(id)`.
    ///
    /// Col mutex avvelenato `Webview::close()` panica prima di
    /// `on_webview_close`, quindi l'etichetta resta dentro. Prima: la
    /// riapertura la ritrovava e riconsegnava la vista morta — «Ricrea la
    /// scheda» non ricreava niente. Adesso l'etichetta è bruciata e quel
    /// `contains` è falso: `browser_open` CREA.
    #[test]
    fn una_vista_che_non_muore_brucia_l_etichetta_e_open_deve_creare() {
        let id = "avvelenata";
        let mut manager: HashSet<String> = HashSet::new();
        manager.insert(browser_label(id)); // la vista viva, prima della chiusura

        let verdict = close_verdict(id, manager.contains(&browser_label(id)));
        assert!(verdict.is_err(), "una vista sopravvissuta non è una chiusura riuscita");

        assert!(
            !manager.contains(&browser_label(id)),
            "browser_open deve CREARE una vista nuova, non riusare quella morta"
        );
        // La morta è ancora appesa al manager sotto l'etichetta vecchia — e
        // risale allo stesso id, così `browser_list` non conta due pane per una.
        let ids: Vec<&str> = manager.iter().filter_map(|l| pane_id_from_label(l)).collect();
        assert_eq!(ids, vec![id]);
    }
}

/// Il reaper decide con due permessi, non uno: ORFANO e FERMO. Ogni test qui
/// toglie UNO dei due e pretende che lo store sopravviva — è l'unico modo di
/// provare che nessuno dei due è decorativo.
///
/// Il tempo si inietta (`now`) invece di riscrivere gli mtime: una cartella
/// creata ora, guardata da un `now` spostato avanti di un mese, è vecchia di un
/// mese, e il test non dipende da quali syscall per i timestamp esistono.
#[cfg(all(test, target_os = "macos"))]
mod reaper_degli_store {
    use super::{data_store_uuid_for, stale_store_uuids, uuid_bytes_from_str, uuid_str_from_bytes};
    use std::time::{Duration, SystemTime};

    /// Una cartella temporanea con dentro uno store per ciascun contextId.
    fn store_dir(ids: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "topics-reap-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        for id in ids {
            let uuid = uuid_str_from_bytes(&data_store_uuid_for(id));
            std::fs::create_dir_all(dir.join(&uuid).join("Cookies")).expect("mkdir store");
        }
        dir
    }

    fn fra(giorni: u64) -> SystemTime {
        SystemTime::now() + Duration::from_secs(giorni * 86_400)
    }

    #[test]
    fn orfano_e_fermo_se_ne_va() {
        let dir = store_dir(&["browser:abbandonato"]);
        let victims = stale_store_uuids(&dir, &[], 30, fra(60));
        assert_eq!(victims.len(), 1, "orfano da 60 giorni: è la coda lunga");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn una_pane_lo_rivendica_e_non_si_tocca_a_nessuna_eta() {
        let dir = store_dir(&["browser:vivo"]);
        // Fermo da DIECI ANNI, ma una pane esiste ancora: il sito che apri due
        // volte l'anno è proprio quello di cui non vuoi rifare il login.
        let victims = stale_store_uuids(&dir, &["browser:vivo".to_string()], 30, fra(3650));
        assert!(victims.is_empty(), "keep_ids vince sull'età, sempre");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn orfano_ma_ancora_caldo_resta() {
        let dir = store_dir(&["browser:di-ieri"]);
        // Orfano nella lista, ma toccato adesso: chiudere una tab e riaprirla
        // fra un minuto non deve passare dallo spazzino.
        let victims = stale_store_uuids(&dir, &[], 30, SystemTime::now());
        assert!(victims.is_empty(), "l'età manca: nessun permesso");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_max_age_a_zero_non_fa_piazza_pulita() {
        let dir = store_dir(&["browser:qualunque"]);
        // Il pavimento di 7 giorni è la rete sotto un chiamante sbagliato:
        // con 0 il peggio che può fare è rimuovere roba ferma da una settimana.
        let victims = stale_store_uuids(&dir, &[], 0, fra(3));
        assert!(victims.is_empty(), "0 giorni deve valere MIN_REAP_AGE_DAYS");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quello_che_non_e_un_uuid_non_e_roba_nostra() {
        let dir = store_dir(&[]);
        std::fs::create_dir_all(dir.join("Default")).expect("mkdir");
        std::fs::write(dir.join("salt"), b"x").expect("write");
        let victims = stale_store_uuids(&dir, &[], 30, fra(999));
        assert!(victims.is_empty(), "solo le cartelle-UUID sono store");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn i_byte_dell_uuid_fanno_andata_e_ritorno() {
        // Se scrittura e lettura del nome cartella divergessero, il reaper
        // guarderebbe uno store e ne cancellerebbe un altro.
        let bytes = data_store_uuid_for("browser:andata-e-ritorno");
        let s = uuid_str_from_bytes(&bytes);
        assert_eq!(s.len(), 36);
        assert_eq!(uuid_bytes_from_str(&s), Some(bytes));
        assert_eq!(uuid_bytes_from_str("non-un-uuid"), None);
    }
}

/// Chi tiene in vita una pane browser, e chi la lascia andare.
///
/// La catena che questi test chiudono: una UI ricaricata o rimontata lascia
/// dietro di sé webview che nessuno disegna più, invisibili per definizione e
/// quindi impossibili da chiudere a mano. Il reclamo le trova. Ma il verdetto ha
/// una regola in più delle altre, ed è quella che protegge il caso opposto: una
/// finestra che si sta ancora aprendo ha già le sue pane e non ha ancora una UI
/// che possa battere, e chiuderle lì sarebbe peggio del problema.
#[cfg(test)]
mod browser_claim_tests {
    use super::{orphan_views, LiveView, WindowClaim, CLAIM_FRESH_MS, CLAIM_GRACE_MS};
    use std::collections::{HashMap, HashSet};

    /// Un istante «adesso» lontano da zero, così `now - x` non satura per caso e
    /// una regola rotta si vede invece di sembrare giusta.
    const NOW: u64 = 10_000_000;

    fn claim(seen_ms: u64, ids: &[&str]) -> WindowClaim {
        WindowClaim {
            seen_ms,
            ids: ids.iter().map(|s| (*s).to_string()).collect::<HashSet<String>>(),
        }
    }

    fn view(id: &str, host: &str, host_alive: bool) -> LiveView {
        LiveView { id: id.to_string(), host: host.to_string(), host_alive }
    }

    fn claims(entries: &[(&str, WindowClaim)]) -> HashMap<String, WindowClaim> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_string(), claim(v.seen_ms, &v.ids.iter().map(String::as_str).collect::<Vec<_>>())))
            .collect()
    }

    fn since(entries: &[(&str, u64)]) -> HashMap<String, u64> {
        entries.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
    }

    fn run(
        live: &[LiveView],
        c: &HashMap<String, WindowClaim>,
        s: &HashMap<String, u64>,
    ) -> Vec<String> {
        orphan_views(live, c, s, NOW, CLAIM_FRESH_MS, CLAIM_GRACE_MS)
    }

    /// Il caso normale: la UI dice che la pane è sua, e la pane resta. Se questo
    /// cedesse, il battito chiuderebbe le schede che l'utente sta guardando.
    #[test]
    fn una_pane_reclamata_non_si_tocca() {
        let live = [view("pane-a", "main", true)];
        let c = claims(&[("main", claim(NOW, &["pane-a"]))]);
        let s = since(&[("pane-a", NOW - CLAIM_GRACE_MS * 10)]);
        assert!(run(&live, &c, &s).is_empty(), "chi è reclamato non è orfano");
    }

    /// Il boot, ed è la regressione da non fare: la finestra c'è, le sue pane
    /// pure, ma la sua UI non ha ancora battuto. Silenzio vecchio non è
    /// abbandono, è «non lo so ancora».
    #[test]
    fn un_reclamo_stantio_dell_ospite_non_autorizza_niente() {
        let live = [view("pane-a", "space-1", true)];
        let c = claims(&[("space-1", claim(NOW - CLAIM_FRESH_MS - 1, &[]))]);
        let s = since(&[("pane-a", NOW - CLAIM_GRACE_MS - 1)]);
        assert!(
            run(&live, &c, &s).is_empty(),
            "un ospite che non parla da troppo non può condannare le sue pane"
        );
    }

    /// Il caso per cui esiste tutto il meccanismo: l'ospite è vivo, ha appena
    /// parlato, e nel suo elenco quella pane non c'è. Passata la grazia, non ha
    /// più nessuno.
    #[test]
    fn non_reclamata_da_un_ospite_fresco_e_fuori_grazia_e_orfana() {
        let live = [view("pane-a", "space-1", true)];
        let c = claims(&[("space-1", claim(NOW, &["pane-b"]))]);
        let s = since(&[("pane-a", NOW - CLAIM_GRACE_MS - 1)]);
        assert_eq!(run(&live, &c, &s), vec!["pane-a".to_string()]);
    }

    /// Stessa scena, un millisecondo prima: la grazia serve a coprire il giro
    /// fra l'apertura di una pane e il primo battito che la nomina. Senza,
    /// ogni pane nuova morirebbe appena nata.
    #[test]
    fn dentro_la_grazia_non_si_chiude_ancora() {
        let live = [view("pane-a", "space-1", true)];
        let c = claims(&[("space-1", claim(NOW, &["pane-b"]))]);
        let s = since(&[("pane-a", NOW - CLAIM_GRACE_MS)]);
        assert!(run(&live, &c, &s).is_empty(), "la grazia non è ancora scaduta");
        // E una pane mai vista prima non ha nemmeno un istante da cui contare.
        assert!(run(&live, &c, &since(&[])).is_empty(), "senza scadenza non si scade");
    }

    /// L'orfana vera: la finestra che la ospitava non c'è più. Nessuna UI potrà
    /// mai più nominarla e non c'è una finestra da cui chiuderla, quindi la
    /// grazia qui non serve a niente.
    #[test]
    fn una_vista_senza_finestra_ospite_e_orfana_subito() {
        let live = [view("pane-a", "detach-morto", false)];
        let c = claims(&[("main", claim(NOW, &["pane-b"]))]);
        let s = since(&[("pane-a", NOW)]);
        assert_eq!(run(&live, &c, &s), vec!["pane-a".to_string()]);
    }

    /// Succede davvero: `browser_open` ricade su `main` quando l'etichetta della
    /// finestra è sconosciuta, quindi una pane disegnata da un pop-out può
    /// essere ospitata da `main`. Chiedere che a rivendicarla sia proprio
    /// l'ospite la condannerebbe. Basta che UNA finestra fresca la nomini.
    #[test]
    fn reclamata_da_un_altra_finestra_resta_viva_anche_ospitata_da_main() {
        let live = [view("pane-a", "main", true)];
        let c = claims(&[
            // main ha parlato e non l'ha detta sua...
            ("main", claim(NOW, &["pane-b"])),
            // ...ma il pop-out che la disegna sì.
            ("detach-99", claim(NOW, &["pane-a"])),
        ]);
        let s = since(&[("pane-a", NOW - CLAIM_GRACE_MS * 10)]);
        assert!(
            run(&live, &c, &s).is_empty(),
            "il reclamo vale da qualsiasi finestra, non solo dall'ospite"
        );
    }
}
