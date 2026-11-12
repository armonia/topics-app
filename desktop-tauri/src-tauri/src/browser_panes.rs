//! Native browser panes: creation, bounds, visibility, navigation, cookies,
//! site data, devtools, screenshots and the focus/selftest plumbing around them.
//! Moved out of lib.rs verbatim; the pane engine arms keep their cfg gates.

use super::*;

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
///
/// Since `browser_open` stopped navigating a live view, this map is also what
/// the reuse branch reports back as "where the page is", so on macOS the KVO
/// observer of `URL` (`nav_record_state`) keeps it current: a click, a redirect
/// or a pushState inside the page overwrites the url we last asked for. It is
/// the same value WebKit hands the toolbar, read without touching the view.
pub(crate) static BROWSER_PANE_URL: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::OnceLock::new();
pub(crate) fn browser_pane_url_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    BROWSER_PANE_URL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
/// Annota dove abbiamo mandato una pane. Il lock avvelenato non ci ferma: si
/// recupera il contenuto e si prosegue (`PoisonError::into_inner`), perché una
/// mappa di appunti non ha invarianti da proteggere.
pub(crate) fn remember_pane_url(label: &str, url: &str) {
    let mut m = browser_pane_url_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    m.insert(label.to_string(), url.to_string());
}
pub(crate) fn forget_pane_url(label: &str) {
    let mut m = browser_pane_url_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    m.remove(label);
}
pub(crate) fn last_pane_url(label: &str) -> Option<String> {
    let m = browser_pane_url_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    m.get(label).cloned()
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
pub(crate) const BROWSER_LABEL_PREFIX: &str = "browserpane-";

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
pub(crate) static BURNED_PANE_LABELS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, u32>>,
> = std::sync::OnceLock::new();
pub(crate) fn burned_pane_labels() -> &'static std::sync::Mutex<std::collections::HashMap<String, u32>> {
    BURNED_PANE_LABELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Generazione corrente dell'etichetta di una pane. 0 = mai bruciata.
pub(crate) fn pane_label_generation(id: &str) -> u32 {
    let m = burned_pane_labels().lock().unwrap_or_else(|e| e.into_inner());
    m.get(id).copied().unwrap_or(0)
}

/// Brucia l'etichetta corrente di una pane e restituisce la generazione nuova.
/// Da qui in poi `browser_label(id)` indica un'etichetta LIBERA, quindi
/// `browser_open` crea invece di riusare.
pub(crate) fn burn_pane_label(id: &str) -> u32 {
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
pub(crate) fn browser_label(id: &str) -> String {
    match pane_label_generation(id) {
        0 => format!("{BROWSER_LABEL_PREFIX}{id}"),
        gen => format!("{BROWSER_LABEL_PREFIX}~{gen}~{id}"),
    }
}

/// Inverso di `browser_label`: dall'etichetta all'id della pane. `None` se
/// l'etichetta non è di una pane browser.
pub(crate) fn pane_id_from_label(label: &str) -> Option<&str> {
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
pub(crate) struct DownloadEventMsg {
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

pub(crate) static DOWNLOAD_EVENTS: std::sync::Mutex<Vec<DownloadEventMsg>> = std::sync::Mutex::new(Vec::new());
pub(crate) static DOWNLOAD_PENDING: std::sync::Mutex<Vec<(String, i64, String, String, String)>> = std::sync::Mutex::new(Vec::new()); // (url, id, savedPath, paneId, filename)
pub(crate) static DOWNLOAD_ID: AtomicI64 = AtomicI64::new(1);

/// Drain queued download start/done events for `id`'s Download menu to apply.
/// Scoped to that pane — other panes' events stay queued for their own poll.
// ENGINES: wkwebview, webview2, webkitgtk - portable: the wry download handler feeds this queue on the three engines.
#[tauri::command]
pub(crate) fn browser_take_download_events(id: String) -> Vec<DownloadEventMsg> {
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
pub(crate) struct DownloadProgressMsg {
    id: String,
    received: i64,
    total: i64,
}

// ENGINES: wkwebview, webview2, webkitgtk - portable: stats the files the wry download handler recorded.
#[tauri::command]
pub(crate) fn browser_download_progress(id: String) -> Vec<DownloadProgressMsg> {
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
pub(crate) fn download_total_bytes(path: &str, received: i64) -> i64 {
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
pub(crate) fn progress_fraction_xattr(path: &str) -> Option<f64> {
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
pub(crate) struct NavErrorMsg {
    pub(crate) url: String,
    pub(crate) description: String,
    pub(crate) code: i64,
    // When the failure was queued, epoch ms. The catch-up read after a hidden
    // period drops an entry older than the last navigation the client asked for
    // (`pickNavError`): a matching URL alone let "X fails, X reloads fine" light
    // the strip over a working page.
    pub(crate) at: u64,
    // Pane this failure belongs to — internal scoping only, like DownloadEventMsg.
    #[serde(skip)]
    pub(crate) pane_id: String,
}

pub(crate) static NAV_ERROR_EVENTS: std::sync::Mutex<Vec<NavErrorMsg>> = std::sync::Mutex::new(Vec::new());

/// Epoch ms for `NavErrorMsg::at`: the same clock the client's `Date.now()` reads.
pub(crate) fn nav_error_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Codice nostro per «la navigazione l'abbiamo rifiutata noi», che non esiste
/// fra quelli di Cocoa: NSURLErrorDomain vive fra -998 e -1200, WebKitErrorDomain
/// fra 100 e 204, quindi questo non collide con nessuno dei due e il client può
/// riconoscerlo senza leggere stringhe. Il gemello lato client sta in
/// `client/src/components/Browser/navErrorMessage.ts`.
pub(crate) const NAV_ERR_SCHEME_REFUSED: i64 = -7001;

/// WKWebView pointer → pane id. The navigation delegate CLASS is shared by every
/// wry webview (main UI included), so the failure IMP must scope events to the
/// browser panes it knows; unmapped pointers are silently ignored.
#[cfg(target_os = "macos")]
pub(crate) fn nav_pane_by_webview() -> &'static std::sync::Mutex<std::collections::HashMap<usize, String>> {
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
pub(crate) fn nav_record_failure(webview: *mut objc2::runtime::AnyObject, error: *mut objc2::runtime::AnyObject) {
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
            v.push(NavErrorMsg { url, description, code, at: nav_error_now_ms(), pane_id });
        }
    }
}

/// Register this pane's WKWebView in the pointer→pane map and, once per process,
/// add the two did-fail methods to wry's shared navigation-delegate class.
#[cfg(target_os = "macos")]
pub(crate) fn install_nav_failure_hook(wv: &tauri::Webview, pane_id: &str) {
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

/// A `window.open` / `target=_blank` a page asked for, waiting for the client to
/// turn it into a TAB.
///
/// It is a REQUEST, not a navigation: the pane that asked keeps its page, and
/// the client decides where the tab lands (the same strip, beside the pane that
/// asked). Same per-pane scoped-drain contract as NAV_ERROR_EVENTS.
#[derive(Clone, Serialize)]
pub(crate) struct NewTabMsg {
    url: String,
    // Pane that asked for it: internal scoping only, like NavErrorMsg.
    #[serde(skip)]
    pane_id: String,
}

pub(crate) static NEW_TAB_REQUESTS: std::sync::Mutex<Vec<NewTabMsg>> = std::sync::Mutex::new(Vec::new());

/// Above any believable burst of user-opened tabs, low enough that a page stuck
/// in a `window.open` loop cannot use it as unbounded memory.
pub(crate) const NEW_TAB_QUEUE_MAX: usize = 64;

/// Dove va un popup quando la sua pagina chiama `window.close()`.
///
/// wry non implementa `webViewDidClose`: senza questa deviazione il popup di un
/// login (Google GIS, OAuth) consegnava la credenziale alla pagina madre e poi
/// restava aperto, vuoto, per sempre. Lo script d'avvio del popup ridirige
/// `close()` qui, e `on_navigation` chiude la finestra.
pub(crate) const POPUP_CLOSE_URL: &str = "about:blank#topics-popup-close";

pub(crate) const POPUP_CLOSE_JS: &str =
    "try{window.close=function(){location.replace('about:blank#topics-popup-close');};}catch(e){}";

/// macOS, wry >= 0.57: a popup built on its opener's configuration shares the
/// opener's `WKUserContentController` and no longer adds its own initialization
/// scripts (wry#1876). `POPUP_CLOSE_JS` on the popup therefore does not run, and
/// `window.close()` closes nothing. The popup inherits the PANE's scripts, so the
/// same redirect is installed there, guarded by `window.opener`: a pane page that
/// calls `close()` must not land on `about:blank`. On Windows and Linux the popup
/// has its own webview and script and is unchanged. A popup opened with `noopener`
/// has no opener and is not covered; such a page cannot hand anything to its parent,
/// so it is not the login case.
#[cfg(target_os = "macos")]
pub(crate) const POPUP_CLOSE_FROM_PANE_JS: &str =
    "try{if(window.opener){window.close=function(){location.replace('about:blank#topics-popup-close');};}}catch(e){}";

pub(crate) static POPUP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Un `window.open` CON dimensioni e' un popup, non una scheda: si apre come
/// finestra vera, con la configurazione WebKit di chi l'ha chiesto, cosi'
/// `window.open()` non torna `null` e `opener.postMessage` arriva.
///
/// Prima diventava una scheda come un `target=_blank`: il login Google di un
/// sito nella pane (03/10, jevweb) si completava nella scheda, la pagina madre
/// non riceveva niente, e GIS riprovava aprendo altre schede (7 in 35 s).
/// I `_blank` senza dimensioni restano schede: e' quello che fa Chrome.
pub(crate) fn open_page_popup(
    app: &tauri::AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> Option<tauri::WebviewWindow> {
    let label = format!(
        "page-popup-{}",
        POPUP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let title = url.host_str().unwrap_or("Topics").to_string();
    let closer = app.clone();
    let closing = label.clone();
    tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
        .title(title)
        .window_features(features)
        .initialization_script(POPUP_CLOSE_JS)
        .on_navigation(move |u| {
            if u.as_str() != POPUP_CLOSE_URL {
                return true;
            }
            // Mai chiudere dentro il delegate di navigazione: si rientrerebbe
            // in WebKit a meta' chiamata. Si accoda al giro successivo.
            let app = closer.clone();
            let label = closing.clone();
            let _ = closer.run_on_main_thread(move || {
                if let Some(w) = tauri::Manager::get_webview_window(&app, &label) {
                    let _ = w.close();
                }
            });
            false
        })
        .build()
        .map_err(|e| eprintln!("[browser_open] popup {label}: {e}"))
        .ok()
}

/// Drain the tabs `id`'s page asked to open. Empty is the normal answer.
// ENGINES: wkwebview, webview2, webkitgtk - a plain mutex drain, and the queue behind it is filled by the builder's `on_new_window`, which wry implements on all three engines (WryWebViewUIDelegate, NewWindowRequested, the webkitgtk create signal).
#[tauri::command]
pub(crate) fn browser_take_new_tabs(id: String) -> Vec<NewTabMsg> {
    match NEW_TAB_REQUESTS.lock() {
        Ok(mut v) => {
            let (mine, rest): (Vec<_>, Vec<_>) = v.drain(..).partition(|e| e.pane_id == id);
            *v = rest;
            mine
        }
        Err(_) => Vec::new(),
    }
}

/// Drain queued navigation failures for `id`'s pane — same scoped-drain contract
/// as browser_take_download_events. Non-macOS builds have no hook installed, so
/// the queue is simply always empty there.
// ENGINES: wkwebview - the did-fail delegate hook is objc, so only WKWebView ever fills this queue.
// ENGINES-GAP: webview2 - no navigation-failure hook is wired there, so a failed load is silent and an empty drain reads as no errors.
// ENGINES-GAP: webkitgtk - no load-failed hook is wired there, so a failed load is silent and an empty drain reads as no errors.
#[tauri::command]
pub(crate) fn browser_take_nav_errors(id: String) -> Vec<NavErrorMsg> {
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
pub(crate) struct NavStateMsg {
    url: String,
    title: String,
    loading: bool,
    // Pane this state belongs to — internal scoping only, like NavErrorMsg.
    #[serde(skip)]
    pane_id: String,
}

pub(crate) static NAV_STATE_EVENTS: std::sync::Mutex<Vec<NavStateMsg>> = std::sync::Mutex::new(Vec::new());

/// The shared observer instance, as a raw pointer. Teardown needs to reach the
/// exact object that registered, and it is the same one for every pane.
#[cfg(target_os = "macos")]
pub(crate) static NAV_STATE_OBSERVER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

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
pub(crate) fn nav_record_state(webview: *mut objc2::runtime::AnyObject) {
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
        // The live url, kept for the reuse branch of `browser_open` (see
        // BROWSER_PANE_URL). Empty means teardown, which is not a place.
        if !url.is_empty() {
            remember_pane_url(&browser_label(&pane_id), &url);
        }
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
pub(crate) fn nav_state_observed() -> &'static std::sync::Mutex<std::collections::HashSet<usize>> {
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
pub(crate) fn install_nav_state_observer(wv: &tauri::Webview, pane_id: &str) {
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
pub(crate) fn remove_nav_state_observer(pane_id: &str) {
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
// ENGINES: wkwebview - url, title and loading arrive by KVO, an objc observer only WKWebView has.
// ENGINES-GAP: webview2 - no KVO equivalent is wired, the client falls back to its page poll for url, title and loading.
// ENGINES-GAP: webkitgtk - no KVO equivalent is wired, the client falls back to its page poll for url, title and loading.
#[tauri::command]
pub(crate) fn browser_take_nav_state(id: String) -> Vec<NavStateMsg> {
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
pub(crate) const CONSOLE_PROXY_JS: &str = r#"(function(){
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

/// `outerWidth`/`outerHeight` di una pane non sono mai 0: vedi il file. Senza,
/// Heray (anti-bot di Hetzner) respinge la prova di lavoro in ciclo.
pub(crate) const PANE_WINDOW_METRICS_JS: &str = include_str!("pane_window_metrics.js");

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
pub(crate) fn disable_layer_implicit_animations(wv: &tauri::Webview) {
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
pub(crate) fn browser_corner_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, (u8, u16)>> {
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
pub(crate) fn browser_bounds_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, (f64, f64, f64, f64)>> {
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
pub(crate) fn window_corner_radius() -> f64 {
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
pub(crate) fn apply_browser_corner_mask(wv: &tauri::Webview, id: &str, x: f64, y: f64, w: f64, h: f64, win_w: f64, win_h: f64, card_radius: f64) {
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
pub(crate) fn main_window_logical_size(app: &tauri::AppHandle) -> Option<(f64, f64)> {
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
pub(crate) fn webview_window_logical_size(wv: &tauri::Webview) -> Option<(f64, f64)> {
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
pub(crate) fn data_store_uuid_for(context_id: &str) -> [u8; 16] {
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
pub(crate) fn pane_store_dir_name(context_id: &str) -> String {
    uuid_str_from_bytes(&data_store_uuid_for(context_id))
}

/// La cartella `browser-stores/` sotto i dati locali dell'app: la radice di
/// tutti gli store delle pane isolate fuori da macOS.
///
/// La radice la chiede all'app e non a un `env::var` indovinato, perche' e'
/// l'app a sapere se sta girando impacchettata o da `cargo run`: indovinandola
/// il reaper spazzerebbe la cartella dell'altra.
#[cfg(not(target_os = "macos"))]
pub(crate) fn pane_store_root(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
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
pub(crate) fn pane_store_dir(app: &tauri::AppHandle, context_id: &str) -> Option<std::path::PathBuf> {
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
pub(crate) fn no_abort<T>(label: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: data store identifier on WKWebView, per-pane data directory on the other two.
///
/// ── WHY THIS COMMAND IS `async` AND HOPS TO THE MAIN THREAD ────────────────
///
/// A SYNC `#[tauri::command]` runs INSIDE the IPC callback of the webview that
/// called it, which on Windows is a WebView2 COM callback. Building a webview
/// from there is the documented deadlock: tauri's own `WebviewBuilder::new`
/// says "on Windows, this function deadlocks when used in a synchronous command
/// or event handlers, you should use `async` commands and separate threads".
/// wry waits for `CreateCoreWebView2Environment/Controller` with
/// `webview2_com::wait_with_pump`, a NESTED message loop: it keeps pumping, so
/// the window stays alive and shortcuts keep working, but the completion
/// callback cannot be delivered while the outer COM call is on the stack and
/// the wait never ends. That is exactly the shape measured on 2.2.281: the pane
/// opens, the URL bar accepts the address, `browser_open` never answers, and
/// the client sits on `browser.native.initializing` forever because nothing
/// rejects either (`attemptNativeOpen` only sees resolve/reject).
///
/// `(async)` on a sync fn puts the body on the blocking pool, and
/// `run_on_main_thread` hands the real work back to the event loop, where a
/// nested pump is ordinary. Same medicine as `window_detach_space`, opposite
/// reason: there the hop was to REACH the main thread from a tokio worker, here
/// it is to reach it OUTSIDE the IPC callback. The body still runs on the main
/// thread, in the same order as before, so macOS behaviour is unchanged.
#[tauri::command(async)]
pub(crate) fn browser_open(
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
) -> Result<BrowserOpenAnswer, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<BrowserOpenAnswer, String>>();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let out = no_abort("browser_open", move || {
            browser_open_inner(app_for_main, id, url, x, y, width, height, isolate, window_label)
        });
        // The receiver is gone only if this command was cancelled; nobody to tell.
        let _ = tx.send(out);
    })
    .map_err(|e| format!("browser_open: {e}"))?;
    // Blocking is allowed here and nowhere else in this file: `(async)` on a sync
    // fn means the blocking pool, not a tokio worker. The answer is the real
    // outcome of the creation, so the client's promise still settles on the
    // truth - which is what keeps the spinner honest.
    rx.recv()
        .map_err(|_| "browser_open: the main thread dropped the task".to_string())?
}

/// What `browser_open` answers: whether it found the pane's view alive, and
/// where that view is. The client puts `url` in the address bar: for a reused
/// view it is the page the view is showing, not the (possibly stale) url the
/// pane asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct BrowserOpenAnswer {
    reused: bool,
    url: String,
}

/// What `browser_open` does with a pane id. Decided apart from tauri so the
/// rule can be tested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserOpenPlan {
    /// No live view under the pane's label (never opened, closed, or its label
    /// burned because it died): build one at the requested url.
    Create,
    /// A live view: keep its page as it is. `reparent` when the window asking
    /// for it is not the one hosting it (a pop-out taking a page from `main`).
    Reuse { reparent: bool },
}

/// THE RULE: an `open` of a live view never navigates it.
///
/// It used to navigate whenever the requested url differed from the last url
/// WE had asked for, which after any click, redirect or pushState inside the
/// page is every time. Every path that re-sends `browser_open` for a live id
/// then reloaded the page and lost what was in it (scroll, forms, SPA state,
/// sometimes the login): a ⌘R of the app, a remount that missed the client's
/// handoff, a pop-out. Changing the page of a live view is `browser_navigate`'s
/// job, and only its.
///
/// `requested_host` is the window that asked, when it exists. An unknown one
/// leaves the view where it is: moving it to a fallback window would take it
/// away from a window that still shows it.
pub(crate) fn plan_browser_open(
    view_alive: bool,
    current_host: Option<&str>,
    requested_host: Option<&str>,
) -> BrowserOpenPlan {
    if !view_alive {
        return BrowserOpenPlan::Create;
    }
    let reparent = matches!((current_host, requested_host), (Some(cur), Some(want)) if cur != want);
    BrowserOpenPlan::Reuse { reparent }
}

/// Drop what `browser_set_bounds` remembers about a pane's frame and corners.
///
/// After a reparent the numbers are relative to ANOTHER window: the cache would
/// skip the very first push in the new window when it repeats the last rect of
/// the old one (both park off-screen at the same rect), leaving the view framed
/// for a parent it no longer has, and the corner mask computed on the old
/// window's size.
pub(crate) fn forget_pane_geometry(id: &str) {
    if let Ok(mut g) = browser_bounds_cache().lock() {
        g.remove(id);
    }
    #[cfg(target_os = "macos")]
    if let Ok(mut g) = browser_corner_cache().lock() {
        g.remove(id);
    }
}

/// Where a reused view is: what the shell knows (WebKit's own url, or the last
/// one we asked for), or, failing that, what the pane asked for.
pub(crate) fn reused_view_url(known: Option<String>, requested: &str) -> String {
    known.filter(|u| !u.is_empty()).unwrap_or_else(|| requested.to_string())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn browser_open_inner(
    app: tauri::AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    isolate: Option<bool>,
    window_label: Option<String>,
) -> Result<BrowserOpenAnswer, String> {
    use tauri::Manager;
    let label = browser_label(&id);
    let live = app.get_webview(&label);
    let requested_window = window_label.as_deref().and_then(|l| app.get_window(l));
    let plan = plan_browser_open(
        live.is_some(),
        live.as_ref().map(|wv| wv.window().label().to_string()).as_deref(),
        requested_window.as_ref().map(|w| w.label()),
    );
    if let (BrowserOpenPlan::Reuse { reparent }, Some(wv)) = (plan, live) {
        if reparent {
            if let Some(target) = &requested_window {
                // The same view, moved: its WebContent, history, scroll and
                // session go with it. Supported by tauri 2.11 + wry 0.55 on all
                // three engines (`unstable` feature, see Cargo.toml): an NSView
                // added to the new window's content view, `SetParent` of the
                // WebView2 host window, the GTK widget moved to the new vbox.
                // A failure is NOT harmless: tauri-runtime-wry detaches the view
                // from its old window before it knows the move will succeed.
                match wv.reparent(target) {
                    Ok(()) => forget_pane_geometry(&id),
                    Err(e) => eprintln!("[browser_open] {id}: reparent to {} failed: {e}", target.label()),
                }
            }
        }
        // "Where are you?" is NOT asked of the WKWebView: `wv.url()` goes down
        // to `wry::url_from_webview`, which `unwrap()`s a URL that is `nil` for
        // a freshly mounted pane and PANICS on the main thread with a wry lock
        // held (crash of 5 August, 522,313 panics cascading from one). On macOS
        // the answer is the map the KVO observer keeps current.
        // Only WebView2 is asked: it reads `Source`, which is always a URL.
        // WebKitGTK answers "" when the page has no `uri` yet (a first load
        // cancelled or turned into a download), and tauri-runtime-wry then
        // `expect`s a parse of it with the dispatcher lock held: a panic that
        // poisons the pane. Linux falls back to the map, or to the URL asked.
        #[cfg(not(target_os = "windows"))]
        let known = last_pane_url(&label);
        #[cfg(target_os = "windows")]
        let known = wv.url().ok().map(|u| u.to_string()).or_else(|| last_pane_url(&label));
        let current = reused_view_url(known, &url);
        browser_set_bounds(app, id, x, y, width, height, None)?;
        return Ok(BrowserOpenAnswer { reused: true, url: current });
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
    // do (with NO handler set the popup was silently dropped). We still never
    // spawn a detached native window, but we no longer navigate the pane IN
    // PLACE either: that made the page you were reading disappear, which is not
    // what `_blank` means anywhere else. The request is queued per pane and the
    // client's poll drains it and opens a SECOND TAB in the same strip, exactly
    // like Chrome. Non-web schemes are denied silently.
    //
    // Queueing rather than emitting: the handler runs inside the UI delegate on
    // the main thread, and a Mutex push is the cheapest thing that cannot
    // re-enter WebKit mid-delegate. A window.open WITH a size is a popup, not
    // a tab, and gets a real window that keeps its opener: `open_page_popup`.
    let nw_label = label.clone();
    let nw_app = app.clone();
    // Nasce già con la sua URL: annotarla qui evita che il primo remount della
    // pane la creda «sconosciuta» e ri-navighi su una pagina che sta già
    // caricando.
    remember_pane_url(&label, &url);
    let mut builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
        .initialization_script(CONSOLE_PROXY_JS)
        .initialization_script(PANE_WINDOW_METRICS_JS)
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
        .on_new_window(move |url, features| {
            let scheme = url.scheme();
            if (scheme == "http" || scheme == "https") && features.size().is_some() {
                if let Some(window) = open_page_popup(&nw_app, url, features) {
                    return tauri::webview::NewWindowResponse::Create { window };
                }
                return tauri::webview::NewWindowResponse::Deny;
            }
            if scheme == "http" || scheme == "https" {
                if let Some(pane) = pane_id_from_label(&nw_label) {
                    if let Ok(mut v) = NEW_TAB_REQUESTS.lock() {
                        // Bounded like every other per-pane queue here: a page
                        // in a popup loop must not grow this without limit.
                        if v.len() >= NEW_TAB_QUEUE_MAX {
                            let overflow = v.len() + 1 - NEW_TAB_QUEUE_MAX;
                            v.drain(0..overflow);
                        }
                        v.push(NewTabMsg { url: url.to_string(), pane_id: pane.to_string() });
                    }
                }
            }
            tauri::webview::NewWindowResponse::Deny
        });
    // See POPUP_CLOSE_FROM_PANE_JS: the pane carries the popup's `close()`.
    #[cfg(target_os = "macos")]
    {
        builder = builder.initialization_script(POPUP_CLOSE_FROM_PANE_JS);
    }
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
    // Windows: the app's own chords (Ctrl+W, Ctrl+1-9, Ctrl+Shift+Tab, Esc,
    // Ctrl+R) would end in this pane and stop there. The accelerator hook gives
    // them back to the renderer of the window that hosts the pane. `window`, not
    // `host_label`: the label may have fallen back to "main" above, and the
    // forward has to land where the pane actually lives.
    #[cfg(target_os = "windows")]
    if let Some(wv) = app.get_webview(&label) {
        chords_win::install(&app, &wv, window.label());
    }
    // AND THE KEYBOARD GOES BACK TO THE CLIENT, WHICH IS WHAT A NEW PANE IS FOR.
    //
    // A WebView2 created as a child takes the keyboard the moment it exists. The
    // client had just focused the address bar of the new tab (`focusUrlBar`,
    // 50ms after mount) and that focus becomes void: the UI webview lost the
    // window's focus, its `document.activeElement` falls back to BODY, and every
    // key from there on is delivered to a page nobody can see, because a brand
    // new pane is parked off-screen until it has a url.
    //
    // That is the whole "the pane opens and stays empty" report on Windows: you
    // open a browser pane, you type an address, and nothing appears. Measured on
    // 2026-09-07 on the real machine (card 99a9a8bd): the same build navigates
    // and paints - 73.6% of the window - when the address is delivered through a
    // channel that does not depend on the window focus, and the typed one never
    // reaches the client at all.
    //
    // `window`, not `host_label`, for the same reason as the hook above: a
    // pop-out must get its own keyboard back, not main's.
    //
    // `Webview::set_focus` and not a hand-written per-engine call: wry maps it to
    // exactly `MoveFocus(PROGRAMMATIC)` on WebView2 and to `grab_focus` on
    // WebKitGTK, which is the whole content this would have had. macOS is left
    // out on purpose: nothing there was ever reported, and the pane creation is
    // not the place to start moving the first responder around.
    #[cfg(not(target_os = "macos"))]
    if let Some(ui) = app.get_webview(window.label()) {
        if let Err(e) = ui.set_focus() {
            eprintln!("[browser_open] {id}: keyboard not returned to the client: {e}");
        }
    }
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
    Ok(BrowserOpenAnswer { reused: false, url })
}

/// Navigate an existing browser pane to a new URL.
// ENGINES: wkwebview, webview2, webkitgtk - portable: one tauri webview call, no per-engine branch.
#[tauri::command]
pub(crate) fn browser_navigate(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    no_abort("browser_navigate", move || browser_navigate_inner(app, id, url))
}

pub(crate) fn browser_navigate_inner(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: layer geometry on WKWebView, plain bounds elsewhere.
#[tauri::command]
pub(crate) fn browser_set_bounds(
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

pub(crate) fn browser_set_bounds_inner(
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
// ENGINES: wkwebview, webview2, webkitgtk - portable: tauri show/hide on the webview.
#[tauri::command]
pub(crate) fn browser_set_visible(app: tauri::AppHandle, id: String, visible: bool) -> Result<(), String> {
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

/// Page zoom of a browser pane: the page lays out at its frame divided by this.
///
/// It is how the Mac shows a page at the size of another device that is using
/// it (TOPIC-BROWSER-05): an iPad pane of 1180x820 does not fit a 900px slot,
/// so the frame is scaled to fit and the zoom makes the page lay out at
/// 1180x820 inside it. `innerWidth` and the media queries see the iPad, and the
/// iPad's mirror of the page needs no scaling at all.
///
/// Not CSS `zoom` on the document: that one changes neither `innerWidth` nor
/// the media queries, and the recorder would copy it into every mirror.
///
/// Floor 0.05, the client's MIN_PAGE_ZOOM (paneViewport.ts): a pane can be a
/// tenth of the window, and WKWebView still lays a 1180x820 page out exactly in
/// a 59x41 frame at 0.05 (measured).
// ENGINES: wkwebview, webview2, webkitgtk - portable: tauri webview zoom (pageZoom on WKWebView).
#[tauri::command]
pub(crate) fn browser_set_page_zoom(app: tauri::AppHandle, id: String, zoom: f64) -> Result<(), String> {
    no_abort("browser_set_page_zoom", move || {
        use tauri::Manager;
        if !zoom.is_finite() || zoom <= 0.0 {
            return Err(format!("invalid page zoom {zoom}"));
        }
        let wv = app
            .get_webview(&browser_label(&id))
            .ok_or("no such browser pane")?;
        wv.set_zoom(zoom.clamp(0.05, 1.0)).map_err(|e| e.to_string())
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: CoreAnimation on WKWebView, immediate bounds elsewhere.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn browser_animate_bounds(
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

/// Put a browser pane's native view ON TOP of the other native views in its
/// window, without touching its geometry or its page.
///
/// Z order between two child webviews of one window is CREATION ORDER and
/// nothing else: wry adds every child with `addSubview:` (`wkwebview/mod.rs`),
/// which appends, and `set_bounds` only calls `setFrame:`, which never
/// reorders. So a pane opened after a floating browser window covers it, and no
/// amount of repositioning brings the window back up.
///
/// Measured with `tools/wkzprobe z` (card e0821533): created-last wins, a
/// `set_bounds` on the lower view does not reorder, this call does, and the
/// raised page keeps its state (no reload, the random token the page minted at
/// birth is still there afterwards).
///
/// `addSubview:positioned:relativeTo:` ALONE, on a view that already sits in
/// `parent`: AppKit reorders it in place, with no `willMoveToSuperview:`
/// callback, and the view stays its window's first responder. A
/// `removeFromSuperview` before it reorders just the same but hands the first
/// responder to the NSWindow, so whoever is typing in the raised page loses the
/// keyboard at every raise, while the DOM (`document.activeElement`, the page
/// token) notices nothing. Measured with AppKit on NSTextView and WKWebView
/// (review of card e0821533); `wkzprobe z` checks it as
/// `first-responder-survives-the-raise`.
// ENGINES: wkwebview, webview2 - both measured with tools/wkzprobe, one backend each, same six verdicts. AppKit (card e0821533): subview order, raised in place with addSubview:positioned:above:. Win32 (card 2e7e769c): z order of the WRY_WEBVIEW container HWNDs, raised in place with SetWindowPos HWND_TOP plus SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE, and falsified, since commenting out that one call flips raise-wins to false.
// ENGINES-GAP: webkitgtk - panes are pack_start-ed into one GtkBox and never overlap, so there is no z order to raise; browser_linux::raise is a no-op on purpose, since the GdkWindow::raise it used to make changed no verdict of the GTK probe (sonda-gtk.yml run 37168587456: raise-wins=false with and without it).
#[tauri::command]
pub(crate) fn browser_raise(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_raise", move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&browser_label(&id))
            .ok_or("no such browser pane")?;
        #[cfg(target_os = "macos")]
        let _ = wv.with_webview(move |platform| unsafe {
            use crate::mac::*;
            let view = platform.inner() as id;
            if view == nil {
                return;
            }
            let parent: id = msg_send![view, superview];
            if parent == nil {
                return;
            }
            // NSWindowAbove = 1, relativeTo nil = above every sibling. No
            // removeFromSuperview first: it would take the keyboard away.
            let _: () = msg_send![parent, addSubview: view, positioned: 1isize, relativeTo: nil];
        });
        #[cfg(target_os = "windows")]
        crate::browser_win::raise(&wv)?;
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        crate::browser_linux::raise(&wv)?;
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
// ENGINES: wkwebview, webview2, webkitgtk - portable: reads the tauri webview map.
#[tauri::command]
pub(crate) fn browser_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
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
///
/// `host_window`: "close it only if it is still in this window". A surface that
/// lets go of a view sends it (the client's deferred close after an unmount),
/// because by the time that close runs another window may have taken the view
/// over (`browser_open` reparents a live view into the window that asks for
/// it: a pop-out taking a page from `main`). Closing it then would kill the
/// page the other window is showing. Absent = close unconditionally, which is
/// what a real close of a tab, an agent, or an older client asks for.
// ENGINES: wkwebview, webview2, webkitgtk - portable: tauri close plus label bookkeeping, no per-engine branch.
#[tauri::command]
pub(crate) fn browser_close(app: tauri::AppHandle, id: String, host_window: Option<String>) -> Result<(), String> {
    no_abort("browser_close", move || {
        use tauri::Manager;
        let host = app
            .get_webview(&browser_label(&id))
            .map(|wv| wv.window().label().to_string());
        if !close_is_for_this_host(host.as_deref(), host_window.as_deref()) {
            eprintln!(
                "[browser_close] {id}: kept, it moved to {} (close asked by {})",
                host.as_deref().unwrap_or("?"),
                host_window.as_deref().unwrap_or("?"),
            );
            return Ok(());
        }
        browser_close_inner(app, id)
    })
}

/// Whether a close may destroy the view. Only a conditional close (`asked_by`
/// set) can be refused, and only when the view lives in a different window.
/// No view at all: let the close run, it is a no-op that still does the
/// bookkeeping.
pub(crate) fn close_is_for_this_host(view_host: Option<&str>, asked_by: Option<&str>) -> bool {
    match (view_host, asked_by) {
        (Some(host), Some(asker)) => host == asker,
        _ => true,
    }
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
pub(crate) fn free_native_webview(wv: &tauri::Webview, label: &str) -> bool {
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
pub(crate) fn free_native_webview(_wv: &tauri::Webview, _label: &str) -> bool {
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
pub(crate) fn browser_evict_pane(app: &tauri::AppHandle, id: &str, close: bool, purge_cache: bool) {
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
    // A tab nobody will ever open now that the pane asking for it is gone.
    if let Ok(mut v) = NEW_TAB_REQUESTS.lock() {
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
pub(crate) fn evict_panes_of_window(app: &tauri::AppHandle, window_label: &str) {
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
pub(crate) fn browser_close_inner(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    // WHO HOSTED IT, ASKED WHILE THERE IS STILL SOMEBODY TO ASK. After the
    // eviction the pane's label is gone from the manager, so the window it
    // belonged to is no longer nameable from the id: the keyboard handover
    // below would have nowhere to send the focus.
    #[cfg(not(target_os = "macos"))]
    let host_of_pane = app
        .get_webview(&browser_label(&id))
        .map(|wv| wv.window().label().to_string());
    // `purge_cache: false` di proposito: qui la cache la svuota il client, che
    // chiama `browser_purge_cache` per conto suo alla morte della pane.
    browser_evict_pane(&app, &id, true, false);
    // AND THE KEYBOARD COMES BACK, which nothing did when the pane died.
    //
    // The twin of the handover in `browser_open_inner`, on the other end of the
    // pane's life. On Windows the pane is a native WebView2 child that holds the
    // window's focus while it lives; destroying it leaves the focus on NO window
    // at all - `GetGUIThreadInfo().hwndFocus` reads 0x0 - and nothing in the
    // system moves it back, so the client's `window` keydown listeners never
    // fire again and every shortcut is inert until the user clicks the window.
    //
    // Measured on the real machine on 2026-09-08 (card cd040754) against the
    // installed 2.2.287: Ctrl+K changed 55.3% of the window in the arm where no
    // restored pane had to be closed, and 0% in the arm where the run had just
    // closed one. Same build, same window, minutes apart.
    //
    // Only the explicit close, which is the one a person asks for. The window
    // teardown path (`evict_panes_of_window`) is deliberately not here: there
    // the host window is on its way out and there is no interface left to hand
    // anything to.
    #[cfg(not(target_os = "macos"))]
    if let Some(ui) = host_of_pane.as_deref().and_then(|l| app.get_webview(l)) {
        if let Err(e) = ui.set_focus() {
            eprintln!("[browser_close] {id}: keyboard not returned to the client: {e}");
        }
    }
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
pub(crate) fn close_verdict(id: &str, still_registered: bool) -> Result<(), String> {
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
pub(crate) struct WindowClaim {
    pub(crate) seen_ms: u64,
    pub(crate) ids: std::collections::HashSet<String>,
}

/// Una vista browser viva ADESSO, come la vede il verdetto.
///
/// `host` è la finestra che la ospita e `host_alive` dice se quella finestra
/// esiste ancora: sono due cose diverse, e la seconda è il caso in cui un
/// pop-out se n'è andato lasciandosi dietro la figlia.
pub(crate) struct LiveView {
    pub(crate) id: String,
    pub(crate) host: String,
    pub(crate) host_alive: bool,
}

/// label della finestra → il suo ultimo reclamo. Le finestre morte si tolgono a
/// ogni battito: un reclamo fossile terrebbe in vita per sempre le pane che
/// nominava.
pub(crate) static BROWSER_CLAIMS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, WindowClaim>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// id della pane → l'ultimo istante in cui qualcuno l'ha rivendicata, o il primo
/// avvistamento se non è mai successo.
///
/// Serve a dare una grazia a chi nasce, e nasce sempre non reclamato: fra la
/// `browser_open` e il battito che la nomina passa un giro, e senza questa
/// mappa il primo battito utile chiuderebbe la pane appena aperta.
pub(crate) static BROWSER_UNCLAIMED_SINCE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, u64>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Quanto vale un reclamo prima di diventare carta straccia. Il client batte
/// molto più spesso: un reclamo stantio non è «una UI in ritardo», è una UI che
/// non c'è più.
pub(crate) const CLAIM_FRESH_MS: u64 = 45_000;

/// Quanto tempo una pane può restare non reclamata prima di essere considerata
/// orfana. Copre il giro fra l'apertura e il primo battito che la nomina, e i
/// rimontaggi in cui la griglia si rifà da capo.
pub(crate) const CLAIM_GRACE_MS: u64 = 60_000;

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
pub(crate) fn orphan_views(
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
// ENGINES: wkwebview, webview2, webkitgtk - portable: Rust side bookkeeping only, it calls no engine.
#[tauri::command]
pub(crate) fn browser_claim(app: tauri::AppHandle, window: String, ids: Vec<String>) -> Result<usize, String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebsiteDataStore, then browser_win and browser_linux.
#[tauri::command]
pub(crate) fn browser_purge_data_store(app: tauri::AppHandle, id: String) -> Result<(), String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebsiteDataStore, then browser_win and browser_linux.
#[tauri::command]
pub(crate) fn browser_purge_cache(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_purge_cache", move || {
        #[cfg(target_os = "macos")]
        {
            let bytes = data_store_uuid_for(&id);
            let id_for_log = id.clone();
            let _ = app.run_on_main_thread(move || unsafe {
                empty_store_cache(bytes, id_for_log);
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

/// The stable keys (the ones the client sees in `browser_site_data_records`) of
/// the data types that are CACHE: what `browser_purge_cache` and
/// `browser_reap_store_caches` remove, and the only things they remove.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) const CACHE_DATA_TYPE_KEYS: [&str; 4] = ["diskCache", "fetchCache", "memoryCache", "serviceWorkers"];

/// The keys of the data types that are IDENTITY: cookies and the storage a
/// login lives in. No cache cleanup may ever name one of them.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const IDENTITY_DATA_TYPE_KEYS: [&str; 5] = ["cookies", "localStorage", "sessionStorage", "indexedDB", "webSql"];

/// Every key `known_data_types` maps to a WebKit constant: the identity ones,
/// the cache ones and `offlineAppCache`, which no cleanup removes.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const KNOWN_DATA_TYPE_KEYS: [&str; 10] = [
    "cookies",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "webSql",
    "diskCache",
    "memoryCache",
    "fetchCache",
    "offlineAppCache",
    "serviceWorkers",
];

/// Each WebKit data type constant with its stable key.
///
/// The constants are external symbols of the WebKit framework (already linked
/// by wry), not strings written here: a wrong literal would remove NOTHING and
/// nobody would notice, while a symbol either links or does not compile.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn known_data_types() -> [(crate::mac::id, &'static str); 10] {
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
    [
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
    ]
}

/// The `NSSet` of the WebKit cache types alone, built from `CACHE_DATA_TYPE_KEYS`
/// so that the list a unit test checks is the list that is removed.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn cache_only_data_types() -> crate::mac::id {
    use crate::mac::*;
    let known = known_data_types();
    let items: Vec<id> = CACHE_DATA_TYPE_KEYS
        .iter()
        .filter_map(|key| known.iter().find(|(_, k)| k == key).map(|(c, _)| *c))
        .collect();
    msg_send![class!(NSSet), setWithObjects: items.as_ptr(), count: items.len()]
}

/// Empties the cache of the store named by `bytes` (its UUID), keeping cookies,
/// local storage, session storage and IndexedDB. Runs on the main thread; the
/// completion is not awaited. Shared by the close of a pane and by the cache
/// reaper of idle orphan stores, so both remove exactly the same types.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn empty_store_cache(bytes: [u8; 16], label: String) {
    use crate::mac::*;
    let cls = class!(WKWebsiteDataStore);
    let sel = sel!(dataStoreForIdentifier:);
    let responds: BOOL = msg_send![cls, respondsToSelector: sel];
    if responds != YES {
        return; // pre-macOS-14: no store by identifier.
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
    // `distantPast` = the whole cache, not only the recent one.
    let since: id = msg_send![class!(NSDate), distantPast];
    let handler = block2::RcBlock::new(move || {
        let _ = &label; // the block owns the label for the log only
    });
    let _: () = msg_send![store, removeDataOfTypes: types, modifiedSince: since, completionHandler: &*handler];
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
pub(crate) struct SiteDataRecordJson {
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
pub(crate) fn cookie_record_name(domain: &str) -> String {
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
pub(crate) fn cookie_domain_records(domains: &[String]) -> Vec<SiteDataRecordJson> {
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
pub(crate) unsafe fn site_data_type_key(t: crate::mac::id) -> String {
    use crate::mac::*;
    let known = known_data_types();
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
pub(crate) fn site_data_records_blocking(wv: &tauri::Webview) -> Result<String, String> {
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
pub(crate) fn forget_site_blocking(wv: &tauri::Webview, names: Vec<String>) -> Result<usize, String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebsiteDataStore, then browser_win and browser_linux.
#[tauri::command]
pub(crate) async fn browser_site_data_records(app: tauri::AppHandle, id: String) -> Result<String, String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebsiteDataStore, then browser_win and browser_linux.
#[tauri::command]
pub(crate) async fn browser_forget_site(
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: store identifiers on WKWebView, pane directories elsewhere.
#[tauri::command]
pub(crate) fn browser_reap_data_stores(
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

/// LEVEL 1 of the cleanup of closed browsers' data: empties only the CACHE of
/// the stores that no pane claims any more and that nobody has touched for
/// `max_age_days` days, and keeps their logins (cookies, local storage, session
/// storage, IndexedDB).
///
/// It picks the stores exactly like `browser_reap_data_stores` (same
/// `stale_store_uuids`, same two permissions: orphan AND idle, same floor of
/// `MIN_REAP_AGE_DAYS`) and removes exactly what `browser_purge_cache` removes
/// when a pane closes (`CACHE_DATA_TYPE_KEYS`).
///
/// A NEW COMMAND, NOT A MODE ARGUMENT OF THE OLD ONE, ON PURPOSE: an older shell
/// ignores an argument it does not know and would remove whole stores, while a
/// command it does not know fails, and the client then removes nothing.
///
/// Returns how many stores it asked WebKit to empty.
///
/// Outside macOS this is a no-op for now (level 1 does nothing there): a store
/// is a directory per pane (`pane_store_dir`), but its cache can only be emptied
/// through a live webview (WebView2 `ClearBrowsingData`, WebKitGTK
/// `WebsiteDataManager`), and the stores this command is for have no webview.
// ENGINES: wkwebview - a store without a webview is reachable by identifier only, through WKWebsiteDataStore.
// ENGINES-GAP: webview2 - the cache of a profile can be cleared only through a live webview (ClearBrowsingData), and a store this command is for has none, so it returns 0 and level 1 does nothing there.
// ENGINES-GAP: webkitgtk - the cache of a store can be cleared only through a live webview (WebsiteDataManager), and a store this command is for has none, so it returns 0 and level 1 does nothing there.
#[tauri::command]
pub(crate) fn browser_reap_store_caches(
    app: tauri::AppHandle,
    keep_ids: Vec<String>,
    max_age_days: u64,
) -> Result<usize, String> {
    no_abort("browser_reap_store_caches", move || {
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
                let _ = app.run_on_main_thread(move || unsafe {
                    empty_store_cache(bytes, uuid_str);
                });
            }
            Ok(n)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (&app, &keep_ids, max_age_days);
            Ok(0)
        }
    })
}

/// Pavimento sull'età del reaper — vedi `browser_reap_data_stores`.
pub(crate) const MIN_REAP_AGE_DAYS: u64 = 7;

/// La cartella dove WebKit tiene gli store per identifier.
///
/// Il nome della sottocartella è l'identificatore del bundle quando l'app è
/// impacchettata e il nome del processo quando gira da `cargo run`: lo chiede a
/// NSBundle invece di indovinarlo, o in sviluppo il reaper spazzerebbe la
/// cartella dell'app installata (o viceversa).
#[cfg(target_os = "macos")]
pub(crate) fn website_data_store_dir() -> Option<std::path::PathBuf> {
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
pub(crate) fn stale_store_uuids(
    dir: &std::path::Path,
    keep_ids: &[String],
    max_age_days: u64,
    now: std::time::SystemTime,
) -> Vec<String> {
    // An empty keep list makes every store an orphan. No caller sends one on
    // purpose (the client stops before the call), so here it reads as a list
    // that went wrong: both commands pass through this, and nothing is picked.
    if keep_ids.is_empty() {
        return Vec::new();
    }
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
        let Some(touched) = newest_mtime_shallow(&path) else {
            continue; // an age that cannot be read is not an old age.
        };
        match now.duration_since(touched) {
            Ok(elapsed) if elapsed >= age => out.push(name),
            _ => {}
        }
    }
    out.sort();
    out
}

/// L'mtime più recente tra una cartella e i suoi figli diretti.
///
/// `None` when any of those mtimes cannot be read: the folder's, the listing
/// of its children, or one child's. It used to fall back to UNIX_EPOCH for the
/// folder and to skip the child, which reads an unknown age as an old one and
/// errs toward deleting. An unknown age now keeps the store.
pub(crate) fn newest_mtime_shallow(path: &std::path::Path) -> Option<std::time::SystemTime> {
    let mut newest = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    for child in std::fs::read_dir(path).ok()? {
        let m = child.and_then(|c| c.metadata()).and_then(|m| m.modified()).ok()?;
        if m > newest {
            newest = m;
        }
    }
    Some(newest)
}

/// I 16 byte di un UUID scritto `8-4-4-4-12`, o `None` se non lo è.
pub(crate) fn uuid_bytes_from_str(s: &str) -> Option<[u8; 16]> {
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
pub(crate) fn uuid_str_from_bytes(b: &[u8; 16]) -> String {
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
pub(crate) fn eval_js_blocking(wv: &tauri::Webview, js: String, preserve_focus: bool) -> Result<String, String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) async fn browser_eval_js(app: tauri::AppHandle, id: String, js: String, preserve_focus: Option<bool>) -> Result<String, String> {
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
pub(crate) unsafe fn nsimage_to_png_base64(img: *mut objc2::runtime::AnyObject) -> Result<String, String> {
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
pub(crate) fn screenshot_blocking(wv: &tauri::Webview) -> Result<String, String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) async fn browser_screenshot(app: tauri::AppHandle, id: String) -> Result<String, String> {
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
pub(crate) struct CookieJson {
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
pub(crate) unsafe fn nsobject_to_string(obj: *mut objc2::runtime::AnyObject) -> String {
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
pub(crate) unsafe fn ns_dict_set_str(dict: *mut objc2::runtime::AnyObject, key: &str, val: &str) {
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
pub(crate) fn cookies_get_blocking(wv: &tauri::Webview) -> Result<String, String> {
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
pub(crate) enum CookieSetMsg {
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
pub(crate) fn cookies_set_blocking(wv: &tauri::Webview, cookies: Vec<CookieJson>) -> Result<String, String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) async fn browser_pane_get_cookies(app: tauri::AppHandle, id: String) -> Result<String, String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) async fn browser_pane_set_cookies(
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
// ENGINES: wkwebview, webview2, webkitgtk - portable: one webview eval, same call on the three engines.
#[tauri::command]
pub(crate) fn browser_exec_js(app: tauri::AppHandle, id: String, js: String) -> Result<(), String> {
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
pub(crate) fn wk_nav(wv: &tauri::Webview, which: u8) {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) fn browser_back(app: tauri::AppHandle, id: String) -> Result<(), String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) fn browser_forward(app: tauri::AppHandle, id: String) -> Result<(), String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) fn browser_reload(app: tauri::AppHandle, id: String) -> Result<(), String> {
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
// ENGINES: wkwebview, webview2, webkitgtk - portable: the tauri devtools API answers on the three engines.
#[tauri::command]
pub(crate) fn browser_toggle_devtools(app: tauri::AppHandle, id: String) -> Result<(), String> {
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

/// Whether the pane's inspector is open. Read once when a heavy pane is about to
/// pause: a detached Web Inspector or the DevTools window takes the key/foreground
/// state from the Topics window, so without this exemption debugging a heavy page
/// would freeze the page being debugged.
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: the tauri devtools API on WKWebView and WebKitGTK; on WebView2 wry answers a constant false, so the top-level windows of the pane's own processes are searched for its DevTools window.
#[tauri::command]
pub(crate) fn browser_devtools_open(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    no_abort("browser_devtools_open", move || {
        use tauri::Manager;
        let label = browser_label(&id);
        let wv = app.get_webview(&label).ok_or("no such browser pane")?;
        #[cfg(target_os = "windows")]
        {
            let _ = wv;
            return Ok(crate::pane_process_win::inspector_open(&label));
        }
        #[cfg(not(target_os = "windows"))]
        Ok(wv.is_devtools_open())
    })
}

/// Ask the engine to suspend a pane that is already hidden, after a heavy pane
/// paused. `true` only when WebView2 confirmed the suspend.
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: TrySuspend on WebView2; WKWebView and WebKitGTK answer false because hiding the view is their whole pause.
#[tauri::command]
pub(crate) async fn browser_try_suspend(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let label = browser_label(&id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let wv = app
            .get_webview(&label)
            .ok_or_else(|| "no such browser pane".to_string())?;
        #[cfg(target_os = "windows")]
        {
            return crate::pane_process_win::try_suspend_blocking(&wv);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = wv;
            Ok(false)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return AppKit first-responder to the MAIN webview (the React chrome). A native
/// browser pane is a sibling WKWebView that can hold keyboard first-responder, so
/// after interacting with a page a tab click can feel "stuck" in the pane. The tab
/// strip calls this on pointer-down. Principled AppKit hygiene (not a hide/kludge):
/// worst case it's a no-op. macOS only.
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: first responder on macOS, window focus elsewhere.
#[tauri::command]
pub(crate) fn browser_release_focus(app: tauri::AppHandle, window_label: Option<String>) -> Result<(), String> {
    no_abort("browser_release_focus", move || {
        browser_release_focus_inner(app, window_label)
    })
}

pub(crate) fn browser_release_focus_inner(app: tauri::AppHandle, window_label: Option<String>) -> Result<(), String> {
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
    // Windows had the same problem and worse: there is no ambient rule that hands
    // the keyboard back, so once the pane's WebView2 holds it only the app can
    // move it, and until this arm existed nothing did. The tab strip called this
    // command on pointer-down and it did exactly nothing, because everything
    // that was not macOS fell into a single discard.
    //
    // A `SetFocus` on the client's child HWND is NOT the same thing and does not
    // work: tried from outside on the real machine on 2026-09-07, the focus
    // moved and the client still received nothing, because a WebView2 keeps its
    // own focus state inside the controller. `set_focus` is wry's word for
    // `MoveFocus(PROGRAMMATIC)` there and for `grab_focus` on WebKitGTK.
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::Manager;
        let host_label = window_label.as_deref().unwrap_or("main");
        if let Some(ui) = app
            .get_webview(host_label)
            .or_else(|| app.get_webview("main"))
        {
            ui.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Give the keyboard BACK to a browser pane's page: the inverse of
/// `browser_release_focus`, and the release-build twin of the debug-only
/// `focus_grab_browser`.
///
/// Find-in-pane (FIND-03): ⌘F typed inside a page opens the app's find bar,
/// which takes the system keyboard (`browser_release_focus`) so the letters
/// land in the bar and not in the page. Esc closes the bar and must put the
/// keyboard back where it was, inside the page; until this command existed
/// only a debug build could do that.
///
/// macOS: `makeFirstResponder:` on the pane's WKWebView, the body of
/// `focus_grab_browser_inner`. Elsewhere: `set_focus` on the pane's webview,
/// which is wry's `MoveFocus(PROGRAMMATIC)` on WebView2 and `grab_focus` on
/// WebKitGTK. Whether that really hands a child WebView2 the keyboard is NOT
/// measured from a Mac; the manual pass on the PC is the proof (task 4.3).
// ENGINES: wkwebview, webview2, webkitgtk - first responder on macOS, wry's set_focus (MoveFocus / grab_focus) elsewhere.
#[tauri::command]
pub(crate) fn browser_focus_pane(app: tauri::AppHandle, id: String) -> Result<(), String> {
    no_abort("browser_focus_pane", move || browser_focus_pane_inner(app, id))
}

pub(crate) fn browser_focus_pane_inner(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app
        .get_webview(&browser_label(&id))
        .ok_or("no such browser pane")?;
    #[cfg(target_os = "macos")]
    {
        wv.with_webview(move |platform| unsafe {
            use crate::mac::*;
            let view = platform.inner() as id;
            if view == nil {
                return;
            }
            let ns_window: id = msg_send![view, window];
            if ns_window != nil {
                let _: () = msg_send![ns_window, makeFirstResponder: view];
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        wv.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Injected probe for the env-gated sidebar FPS self-test: samples rAF frame deltas
/// while driving 6 real sidebar collapse/expands (via the diagnostic global App.tsx
/// exposes), then posts a frame-timing summary to `fps_report`. A composited
/// translateX (overlay mode) should yield ~60fps with zero dropped frames.
#[cfg(debug_assertions)]
pub(crate) const FPS_SELFTEST_JS: &str = r#"(async function(){
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
pub(crate) const SPLIT_SELFTEST_JS: &str = r#"(async function(){
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
pub(crate) const BROWSER_SELFTEST_JS: &str = r#"(async function(){
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
pub(crate) const COST_SELFTEST_JS: &str = r#"(async function(){
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
pub(crate) const BUGFIX_VERIFY_JS: &str = r#"(async function(){
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
pub(crate) const SLIDE_DEMO_JS: &str = r#"(async function(){
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
pub(crate) fn fps_report(result: String) -> Result<(), String> {
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
pub(crate) fn focus_read(app: tauri::AppHandle) -> Result<String, String> {
    no_abort("focus_read", move || focus_read_inner(app))
}

pub(crate) fn focus_read_inner(app: tauri::AppHandle) -> Result<String, String> {
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
pub(crate) fn focus_grab_browser(app: tauri::AppHandle, id: String) -> Result<String, String> {
    no_abort("focus_grab_browser", move || focus_grab_browser_inner(app, id))
}

// Il `cfg` va anche QUI, non solo sul comando: senza, in release spariva il
// wrapper ma restava compilato il corpo che chiama `makeFirstResponder:` — cioe'
// proprio il codice che il commento sopra dice non deve esistere in release,
// vivo nel binario e senza chiamanti (rustc lo segnalava come `never used`).
#[cfg(debug_assertions)]
pub(crate) fn focus_grab_browser_inner(app: tauri::AppHandle, id: String) -> Result<String, String> {
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
pub(crate) fn focus_grab_window(app: tauri::AppHandle) -> Result<String, String> {
    no_abort("focus_grab_window", move || focus_grab_window_inner(app))
}

#[cfg(debug_assertions)] // idem: il corpo segue il comando, o resta in release
pub(crate) fn focus_grab_window_inner(app: tauri::AppHandle) -> Result<String, String> {
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
pub(crate) const FOCUS_SELFTEST_JS: &str = r#"(async function(){
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
pub(crate) fn focus_report(result: String) -> Result<(), String> {
    let path = std::path::PathBuf::from("/tmp/topics-focus-selftest.json");
    std::fs::write(&path, &result).map_err(|e| e.to_string())?;
    eprintln!("[focus-selftest] {result}");
    Ok(())
}

/// Override the pane's User-Agent (device emulation). Empty string resets to the
/// default. Takes effect on the next load, so the client reloads after setting
/// it. Tutti e tre i motori: `setCustomUserAgent:` su WKWebView,
/// `ICoreWebView2Settings2::UserAgent` su WebView2, `WebKitSettings:user-agent`
/// su WebKitGTK.
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) fn browser_set_user_agent(app: tauri::AppHandle, id: String, ua: String) -> Result<(), String> {
    no_abort("browser_set_user_agent", move || browser_set_user_agent_inner(app, id, ua))
}

pub(crate) fn browser_set_user_agent_inner(app: tauri::AppHandle, id: String, ua: String) -> Result<(), String> {
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
pub(crate) unsafe fn ns_string_to_rust(obj: *mut objc2::runtime::AnyObject) -> String {
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
pub(crate) unsafe fn wk_bf_item_pair(item: *mut objc2::runtime::AnyObject) -> (String, String) {
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
pub(crate) fn nav_entries_blocking(wv: &tauri::Webview) -> Result<String, String> {
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
pub(crate) fn go_to_index_blocking(wv: &tauri::Webview, index: i64) {
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
// ENGINES: wkwebview, webview2, webkitgtk - per-engine arms below: WKWebView inline, then browser_win and browser_linux.
#[tauri::command]
pub(crate) async fn browser_nav_entries(app: tauri::AppHandle, id: String) -> Result<String, String> {
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
// ENGINES: wkwebview, webkitgtk - per-engine arms below: WKWebView inline, then browser_linux.
// ENGINES-GAP: webview2 - WebView2 exposes no history list, so there is no index for this jump to land on (PARITY-GAP in browser_win.rs).
#[tauri::command]
pub(crate) fn browser_go_to_index(app: tauri::AppHandle, id: String, index: i64) -> Result<(), String> {
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

/// The cache cleanup may name cache types only. These are pure checks on the
/// key lists that `cache_only_data_types` builds the WebKit set from: a cache
/// list that grew a cookie key would remove logins from every closed browser.
#[cfg(test)]
mod cache_data_types {
    use super::{CACHE_DATA_TYPE_KEYS, IDENTITY_DATA_TYPE_KEYS, KNOWN_DATA_TYPE_KEYS};

    #[test]
    fn the_cache_list_shares_no_key_with_the_identity_list() {
        for key in CACHE_DATA_TYPE_KEYS {
            assert!(
                !IDENTITY_DATA_TYPE_KEYS.contains(&key),
                "{key} is identity (login) data and must not be emptied with the cache"
            );
        }
    }

    #[test]
    fn the_cache_list_names_only_known_keys_and_is_not_empty() {
        assert!(!CACHE_DATA_TYPE_KEYS.is_empty(), "an empty list would remove nothing, silently");
        for key in CACHE_DATA_TYPE_KEYS {
            assert!(KNOWN_DATA_TYPE_KEYS.contains(&key), "{key} is not a known data type key");
        }
        for key in IDENTITY_DATA_TYPE_KEYS {
            assert!(KNOWN_DATA_TYPE_KEYS.contains(&key), "{key} is not a known data type key");
        }
    }

    #[test]
    fn the_cache_list_is_the_four_cache_types_the_pane_close_always_removed() {
        let mut got: Vec<&str> = CACHE_DATA_TYPE_KEYS.to_vec();
        got.sort();
        assert_eq!(got, vec!["diskCache", "fetchCache", "memoryCache", "serviceWorkers"]);
    }

    /// On macOS the keys of the WebKit table are the known keys, no more, no less:
    /// a key in one list and not in the other would be removed by name only.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_webkit_table_has_exactly_the_known_keys() {
        let mut table: Vec<&str> = unsafe { super::known_data_types() }.iter().map(|(_, k)| *k).collect();
        table.sort();
        let mut known: Vec<&str> = KNOWN_DATA_TYPE_KEYS.to_vec();
        known.sort();
        assert_eq!(table, known);
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

    /// A keep list as the server sends it: never empty, here with an id that
    /// has no store in the folder.
    fn others() -> Vec<String> {
        vec!["browser:another-one".to_string()]
    }

    #[test]
    fn orfano_e_fermo_se_ne_va() {
        let dir = store_dir(&["browser:abbandonato"]);
        let victims = stale_store_uuids(&dir, &others(), 30, fra(60));
        assert_eq!(victims.len(), 1, "orfano da 60 giorni: è la coda lunga");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_keep_list_reaps_nothing() {
        let dir = store_dir(&["browser:abbandonato"]);
        // The store the test above reaps, at the same age. With no id kept every
        // store is an orphan, which only a list that went wrong says.
        let victims = stale_store_uuids(&dir, &[], 30, fra(60));
        assert!(victims.is_empty(), "an empty keep list is not a permission");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_store_whose_age_cannot_be_read_is_not_old() {
        use std::os::unix::fs::PermissionsExt;
        let dir = store_dir(&["browser:unreadable"]);
        let store = std::fs::read_dir(&dir).expect("dir").flatten().next().expect("store").path();
        // Its children cannot be listed, so its newest mtime is unknown: an age
        // that cannot be measured must not read as sixty days.
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        let listable = std::fs::read_dir(&store).is_ok();
        let victims = stale_store_uuids(&dir, &others(), 30, fra(60));
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o755)).expect("chmod back");
        let _ = std::fs::remove_dir_all(&dir);
        if listable {
            return; // root lists it anyway: there is no unreadable store to test.
        }
        assert!(victims.is_empty(), "an unreadable store is kept");
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
        let victims = stale_store_uuids(&dir, &others(), 30, SystemTime::now());
        assert!(victims.is_empty(), "l'età manca: nessun permesso");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_max_age_a_zero_non_fa_piazza_pulita() {
        let dir = store_dir(&["browser:qualunque"]);
        // Il pavimento di 7 giorni è la rete sotto un chiamante sbagliato:
        // con 0 il peggio che può fare è rimuovere roba ferma da una settimana.
        let victims = stale_store_uuids(&dir, &others(), 0, fra(3));
        assert!(victims.is_empty(), "0 giorni deve valere MIN_REAP_AGE_DAYS");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quello_che_non_e_un_uuid_non_e_roba_nostra() {
        let dir = store_dir(&[]);
        std::fs::create_dir_all(dir.join("Default")).expect("mkdir");
        std::fs::write(dir.join("salt"), b"x").expect("write");
        let victims = stale_store_uuids(&dir, &others(), 30, fra(999));
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
#[cfg(test)]
mod browser_open_reuse_tests {
    use super::{close_is_for_this_host, plan_browser_open, reused_view_url, BrowserOpenPlan};

    /// A live view is reused whatever url the pane asks for: the url is not
    /// even an input of the decision, so no request can turn a reuse into a
    /// navigation.
    #[test]
    fn a_live_view_in_the_asking_window_is_reused_where_it_is() {
        assert_eq!(
            plan_browser_open(true, Some("main"), Some("main")),
            BrowserOpenPlan::Reuse { reparent: false },
        );
    }

    /// The pop-out case: the page lives in `main`, the pop-out asks for it.
    #[test]
    fn a_live_view_asked_by_another_window_moves_there() {
        assert_eq!(
            plan_browser_open(true, Some("main"), Some("detach-1a2b3c4d")),
            BrowserOpenPlan::Reuse { reparent: true },
        );
    }

    /// An asking window that does not exist (closed meanwhile) must not drag
    /// the view to a fallback: it stays in the window still showing it.
    #[test]
    fn an_unknown_asking_window_leaves_the_view_where_it_is() {
        assert_eq!(
            plan_browser_open(true, Some("detach-1a2b3c4d"), None),
            BrowserOpenPlan::Reuse { reparent: false },
        );
    }

    /// No live view (never opened, closed, or label burned because it died):
    /// built fresh, which is the only branch that loads the requested url.
    #[test]
    fn a_missing_or_dead_view_is_created() {
        assert_eq!(plan_browser_open(false, None, Some("main")), BrowserOpenPlan::Create);
        assert_eq!(plan_browser_open(false, None, None), BrowserOpenPlan::Create);
    }

    /// The answer of a reuse is where the page IS, not what the pane asked.
    #[test]
    fn a_reused_view_reports_its_own_url() {
        assert_eq!(
            reused_view_url(Some("https://example.com/deep#s2".into()), "https://example.com/start"),
            "https://example.com/deep#s2",
        );
    }

    /// Nothing known (the KVO has not spoken yet): the requested url is the
    /// best answer, and an empty one (teardown) is not a place.
    #[test]
    fn an_unknown_url_falls_back_to_the_requested_one() {
        assert_eq!(reused_view_url(None, "https://example.com/start"), "https://example.com/start");
        assert_eq!(reused_view_url(Some(String::new()), "https://example.com/start"), "https://example.com/start");
    }

    /// The deferred close of a surface that let go of a view must not kill it
    /// after another window took it over.
    #[test]
    fn a_conditional_close_spares_a_view_that_moved() {
        assert!(!close_is_for_this_host(Some("detach-1a2b3c4d"), Some("main")));
        assert!(close_is_for_this_host(Some("main"), Some("main")));
    }

    /// An unconditional close (a real close of a tab, an agent, an older
    /// client) and a close of a view that is already gone always run.
    #[test]
    fn an_unconditional_or_viewless_close_runs() {
        assert!(close_is_for_this_host(Some("detach-1a2b3c4d"), None));
        assert!(close_is_for_this_host(None, Some("main")));
        assert!(close_is_for_this_host(None, None));
    }
}
