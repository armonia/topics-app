//! Backend WebView2 del pane browser nativo (Windows).
//!
//! Controparte di quello che su macOS fa parlando ObjC alla WKWebView. La
//! struttura e volutamente la stessa: `with_webview` porta sul thread della UI,
//! li si lancia l'operazione asincrona del motore, e il risultato torna indietro
//! su un canale che il worker chiamante aspetta. Vale la stessa regola di
//! macOS, per lo stesso motivo: **queste funzioni non vanno chiamate dal thread
//! principale**, perche bloccherebbero proprio il thread che deve far girare la
//! callback (deadlock fino al timeout).
//!
//! La semantica di `eval` sta in [`crate::browser_eval`], condivisa con il
//! backend WebKitGTK. Li vivono l'attesa delle promise e la forma del risultato.

use crate::browser_eval::{self, EvalStep};
use crate::CookieJson;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Cookie, ICoreWebView2_2, COREWEBVIEW2_COOKIE_SAME_SITE_KIND,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
};
use webview2_com::{
    CapturePreviewCompletedHandler, ExecuteScriptCompletedHandler, GetCookiesCompletedHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};

/// Quanto si aspetta una callback del motore prima di dichiarare il timeout.
/// Uguale a macOS, cosi il client vede lo stesso comportamento ovunque.
const OP_TIMEOUT: Duration = Duration::from_secs(8);

/// Ogni quanto si ripassa a ritirare una promise parcheggiata.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Prende l'`ICoreWebView2` dal controller che Tauri espone.
fn core(platform: &tauri::webview::PlatformWebview) -> Result<ICoreWebView2, String> {
    unsafe { platform.controller().CoreWebView2() }.map_err(|e| format!("CoreWebView2: {e}"))
}

/// Un giro secco di `ExecuteScript`: manda lo script, aspetta il testo che
/// torna. Il livello di codifica JSON in piu che WebView2 mette intorno al
/// risultato viene scartato qui. E l'unico punto del backend che lo sa.
fn execute_script(wv: &tauri::Webview, script: String) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        let core = match core(&platform) {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        let tx_cb = tx.clone();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |hr, result| {
            let out = match hr {
                Ok(()) => Ok(browser_eval::strip_json_string_layer(&result)),
                Err(e) => Err(format!("ExecuteScript: {e}")),
            };
            let _ = tx_cb.send(out);
            Ok(())
        }));
        if let Err(e) = unsafe { core.ExecuteScript(&HSTRING::from(script.as_str()), &handler) } {
            let _ = tx.send(Err(format!("ExecuteScript: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| "eval timeout".to_string())?
}

/// Valuta un'espressione e restituisce il risultato con la stessa forma che
/// avrebbe su macOS.
///
/// `preserve_focus` e accettato per tenere la firma identica ai tre backend, ma
/// su WebView2 non fa niente e non e una dimenticanza: su macOS serve perche
/// `el.focus()` dentro la pane strappa il first-responder alla finestra e chi
/// stava scrivendo altrove se lo vede sparire sotto le dita. Windows non ha quel
/// comportamento: il focus della UI resta all'HWND che ce l'ha. Non c'e niente
/// da salvare e da rimettere a posto.
pub fn eval_js_blocking(
    wv: &tauri::Webview,
    js: String,
    _preserve_focus: bool,
) -> Result<String, String> {
    let token = browser_eval::next_token();
    let first = execute_script(wv, browser_eval::wrap_expression(&js, &token))?;
    match browser_eval::parse_payload(&first)? {
        Some(EvalStep::Done(v)) => return Ok(v),
        Some(EvalStep::Failed(e)) => return Err(e),
        Some(EvalStep::Pending(k)) => {
            // Il valore era una promise: si ripassa a ritirarla finche non e
            // risolta o finche non scade lo stesso timeout delle altre op.
            let poll = browser_eval::wrap_poll(&k);
            let deadline = Instant::now() + OP_TIMEOUT;
            while Instant::now() < deadline {
                std::thread::sleep(POLL_INTERVAL);
                let raw = execute_script(wv, poll.clone())?;
                match browser_eval::parse_payload(&raw)? {
                    Some(EvalStep::Done(v)) => return Ok(v),
                    Some(EvalStep::Failed(e)) => return Err(e),
                    // Un secondo Pending non ha senso qui, ma se arrivasse
                    // significherebbe solo «non ancora»: si continua.
                    Some(EvalStep::Pending(_)) | None => continue,
                }
            }
            return Err("eval timeout".to_string());
        }
        None => return Err("eval timeout".to_string()),
    }
}

/// Screenshot della pane come data-URL PNG. E la stessa stringa che restituisce
/// il ramo macOS, cosi `browser_screenshot` non deve distinguere.
///
/// `CapturePreview` scrive su un `IStream`; lo creiamo su HGLOBAL (memoria, non
/// file), poi si riavvolge e si legge tutto.
pub fn screenshot_blocking(wv: &tauri::Webview) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    wv.with_webview(move |platform| {
        let core = match core(&platform) {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        // HGLOBAL nullo con `fdeleteonrelease` a true: lo stream si alloca da
        // solo e libera la memoria quando l'ultimo riferimento se ne va.
        let stream: IStream = match unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) } {
            Ok(s) => s,
            Err(e) => {
                let _ = tx.send(Err(format!("CreateStreamOnHGlobal: {e}")));
                return;
            }
        };
        let tx_cb = tx.clone();
        let stream_cb = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |hr| {
            if let Err(e) = hr {
                let _ = tx_cb.send(Err(format!("CapturePreview: {e}")));
                return Ok(());
            }
            let _ = tx_cb.send(unsafe { read_stream(&stream_cb) });
            Ok(())
        }));
        if let Err(e) = unsafe {
            core.CapturePreview(
                webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
        } {
            let _ = tx.send(Err(format!("CapturePreview: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;
    let png = rx
        .recv_timeout(OP_TIMEOUT)
        .map_err(|_| "screenshot timeout".to_string())??;
    Ok(format!(
        "data:image/png;base64,{}",
        crate::browser_eval::base64_png(&png)
    ))
}

/// Svuota un `IStream` in un vettore di byte. Si riavvolge prima di leggere:
/// `CapturePreview` lascia il cursore in fondo, e senza il seek si tornerebbe a
/// mani vuote (un PNG di zero byte, che a valle sembra uno screenshot nero).
unsafe fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
    let mut stat = STATSTG::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }.map_err(|e| format!("Stat: {e}"))?;
    let size = stat.cbSize as usize;
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }.map_err(|e| format!("Seek: {e}"))?;
    let mut buf = vec![0u8; size];
    let mut read: u32 = 0;
    unsafe { stream.Read(buf.as_mut_ptr() as *mut _, size as u32, Some(&mut read)) }
        .ok()
        .map_err(|e| format!("Read: {e}"))?;
    buf.truncate(read as usize);
    Ok(buf)
}

/// Legge i cookie della pane, httpOnly compresi.
///
/// `GetCookies(None, ...)` chiede TUTTI i cookie del profilo, non solo quelli
/// del sito corrente: e la stessa portata di `getAllCookies` su macOS, ed e cio
/// che l'export di sessione si aspetta.
pub fn cookies_get_blocking(wv: &tauri::Webview) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        let core = match core(&platform) {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        let manager = match core
            .cast::<ICoreWebView2_2>()
            .and_then(|c2| unsafe { c2.CookieManager() })
        {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(Err(format!("CookieManager: {e}")));
                return;
            }
        };
        let tx_cb = tx.clone();
        let handler = GetCookiesCompletedHandler::create(Box::new(move |hr, list| {
            let out = (|| -> Result<String, String> {
                hr.map_err(|e| format!("GetCookies: {e}"))?;
                let list = list.ok_or_else(|| "GetCookies: lista assente".to_string())?;
                let mut count = 0u32;
                unsafe { list.Count(&mut count) }.map_err(|e| format!("Count: {e}"))?;
                let mut out: Vec<CookieJson> = Vec::with_capacity(count as usize);
                for i in 0..count {
                    let c = unsafe { list.GetValueAtIndex(i) }
                        .map_err(|e| format!("GetValueAtIndex: {e}"))?;
                    out.push(unsafe { cookie_to_json(&c) }?);
                }
                serde_json::to_string(&out).map_err(|e| e.to_string())
            })();
            let _ = tx_cb.send(out);
            Ok(())
        }));
        if let Err(e) = unsafe { manager.GetCookies(None, &handler) } {
            let _ = tx.send(Err(format!("GetCookies: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| "get cookies timeout".to_string())?
}

/// Converte un cookie WebView2 nella forma storageState che parla il client.
///
/// Tutti i getter di `ICoreWebView2Cookie` scrivono in un parametro di uscita e
/// restituiscono solo l'esito, quindi ogni campo passa da una variabile
/// d'appoggio. Le stringhe arrivano allocate da COM: vanno liberate con
/// `CoTaskMemFree`, altrimenti ogni export di sessione perde un po' di memoria.
unsafe fn cookie_to_json(c: &ICoreWebView2Cookie) -> Result<CookieJson, String> {
    unsafe fn text(
        f: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
        what: &str,
    ) -> Result<String, String> {
        let mut p = PWSTR::null();
        f(&mut p).map_err(|e| format!("{what}: {e}"))?;
        if p.is_null() {
            return Ok(String::new());
        }
        let s = unsafe { p.to_string() }.unwrap_or_default();
        unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _)) };
        Ok(s)
    }
    unsafe fn flag(f: impl FnOnce(*mut BOOL) -> windows::core::Result<()>) -> bool {
        let mut b = BOOL(0);
        f(&mut b).is_ok() && b.as_bool()
    }
    let name = unsafe { text(|p| c.Name(p), "Name") }?;
    let value = unsafe { text(|p| c.Value(p), "Value") }?;
    let domain = unsafe { text(|p| c.Domain(p), "Domain") }?;
    let path = unsafe { text(|p| c.Path(p), "Path") }?;
    // WebView2 marca i cookie di sessione con `IsSession`, e per quelli
    // l'`Expires` non vuol dire niente. Il client usa -1 per «di sessione», la
    // stessa convenzione di Playwright.
    let expires = if unsafe { flag(|b| c.IsSession(b)) } {
        -1.0
    } else {
        let mut e = 0.0f64;
        if unsafe { c.Expires(&mut e) }.is_ok() {
            e
        } else {
            -1.0
        }
    };
    let mut ss = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE;
    let _ = unsafe { c.SameSite(&mut ss) };
    let same_site = match ss {
        COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX => "Lax",
        COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT => "Strict",
        _ => "None",
    };
    Ok(CookieJson {
        name,
        value,
        domain: Some(domain),
        path: Some(path),
        expires: Some(expires),
        http_only: Some(unsafe { flag(|b| c.IsHttpOnly(b)) }),
        secure: Some(unsafe { flag(|b| c.IsSecure(b)) }),
        same_site: Some(same_site.to_string()),
    })
}

/// Inietta i cookie di una sessione salvata. Restituisce `{"set":n,"skipped":m}`
/// come il ramo macOS. Senza dominio il cookie non si puo costruire, quindi si
/// conta fra gli scartati invece di far fallire tutto il ripristino.
pub fn cookies_set_blocking(
    wv: &tauri::Webview,
    cookies: Vec<CookieJson>,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<(usize, usize), String>>();
    wv.with_webview(move |platform| {
        let out = (|| -> Result<(usize, usize), String> {
            let core = core(&platform)?;
            let manager = core
                .cast::<ICoreWebView2_2>()
                .and_then(|c2| unsafe { c2.CookieManager() })
                .map_err(|e| format!("CookieManager: {e}"))?;
            let (mut set, mut skipped) = (0usize, 0usize);
            for ck in &cookies {
                let Some(domain) = ck.domain.as_deref().filter(|d| !d.is_empty()) else {
                    skipped += 1;
                    continue;
                };
                let path = ck.path.as_deref().filter(|p| !p.is_empty()).unwrap_or("/");
                let created = unsafe {
                    manager.CreateCookie(
                        &HSTRING::from(ck.name.as_str()),
                        &HSTRING::from(ck.value.as_str()),
                        &HSTRING::from(domain),
                        &HSTRING::from(path),
                    )
                };
                let Ok(cookie) = created else {
                    skipped += 1;
                    continue;
                };
                // expires <= 0 (il -1 di Playwright) = cookie di sessione: si
                // lascia stare la scadenza invece di metterne una nel passato,
                // che lo cancellerebbe all'istante.
                if let Some(exp) = ck.expires.filter(|e| *e > 0.0) {
                    let _ = unsafe { cookie.SetExpires(exp) };
                }
                if ck.secure == Some(true) {
                    let _ = unsafe { cookie.SetIsSecure(true) };
                }
                if ck.http_only == Some(true) {
                    let _ = unsafe { cookie.SetIsHttpOnly(true) };
                }
                let ss: COREWEBVIEW2_COOKIE_SAME_SITE_KIND = match ck.same_site.as_deref() {
                    Some("Lax") => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
                    Some("Strict") => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
                    _ => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
                };
                let _ = unsafe { cookie.SetSameSite(ss) };
                match unsafe { manager.AddOrUpdateCookie(&cookie) } {
                    Ok(()) => set += 1,
                    Err(_) => skipped += 1,
                }
            }
            Ok((set, skipped))
        })();
        let _ = tx.send(out);
    })
    .map_err(|e| e.to_string())?;
    let (set, skipped) = rx
        .recv_timeout(OP_TIMEOUT)
        .map_err(|_| "set cookies timeout".to_string())??;
    Ok(format!("{{\"set\":{set},\"skipped\":{skipped}}}"))
}

/// Le navigazioni semplici, che WebView2 espone direttamente sull'interfaccia
/// base. `go_to_index` non c'e sopra: vedi [`nav_entries`].
pub fn go_back(wv: &tauri::Webview) -> Result<(), String> {
    with_core(wv, |c| unsafe { c.GoBack() }.map_err(|e| e.to_string()))
}

pub fn go_forward(wv: &tauri::Webview) -> Result<(), String> {
    with_core(wv, |c| unsafe { c.GoForward() }.map_err(|e| e.to_string()))
}

pub fn reload(wv: &tauri::Webview) -> Result<(), String> {
    with_core(wv, |c| unsafe { c.Reload() }.map_err(|e| e.to_string()))
}

/// WebView2 **non espone la lista** della history: ha `CanGoBack`/`CanGoForward`
/// e basta, nessun equivalente di `WKBackForwardList`. Quindi qui non c'e niente
/// da restituire, e inventare voci finte sarebbe peggio del vuoto: il menu di
/// navigazione le mostrerebbe e cliccarle non porterebbe da nessuna parte.
///
/// Si restituisce una lista vuota con l'indice a -1, che e la forma che il
/// client legge gia come «nessuna cronologia disponibile». Back e forward
/// continuano a funzionare: e solo il salto diretto a una voce che non c'e.
pub fn nav_entries(_wv: &tauri::Webview) -> Result<String, String> {
    Ok("{\"entries\":[],\"index\":-1}".to_string())
}

/// Helper per le op di navigazione: manda il lavoro sul thread della UI e NON
/// aspetta.
///
/// Il «non aspetta» e la parte che conta. `browser_back` e compagni sono comandi
/// Tauri **sincroni**, quindi girano gia sul thread principale; se qui si
/// bloccasse su un canale, si aspetterebbe una callback che deve girare proprio
/// sul thread che si e appena fermato. La app si pianta fino al timeout, a ogni
/// click su Indietro. Il ramo macOS (`wk_nav`) fa lo stesso e per lo stesso
/// motivo: spara e torna.
fn with_core<F>(wv: &tauri::Webview, f: F) -> Result<(), String>
where
    F: FnOnce(&ICoreWebView2) -> Result<(), String> + Send + 'static,
{
    wv.with_webview(move |platform| {
        if let Ok(c) = core(&platform) {
            let _ = f(&c);
        }
    })
    .map_err(|e| e.to_string())
}
