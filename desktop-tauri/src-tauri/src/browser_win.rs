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
    ICoreWebView2, ICoreWebView2Cookie, ICoreWebView2CookieManager, ICoreWebView2Profile2,
    ICoreWebView2Settings2, ICoreWebView2_13, ICoreWebView2_2, COREWEBVIEW2_BROWSING_DATA_KINDS,
    COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE, COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
};
use webview2_com::{
    CapturePreviewCompletedHandler, ClearBrowsingDataCompletedHandler,
    ExecuteScriptCompletedHandler, GetCookiesCompletedHandler,
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

/// «Dimentica questo sito» ha piu tempo delle altre op, come su macOS: enumera
/// il barattolo intero e poi cancella, e con qualche migliaio di cookie otto
/// secondi sono stretti.
const FORGET_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Screenshot della pane come base64 NUDO, senza il prefisso `data:`.
///
/// Il prefisso lo mette il chiamante, ed e per questo che qui non ci va: la
/// freeze-still, il ritaglio dell'elemento e l'op dell'agent scrivono tutte e
/// tre `data:image/png;base64,${shot}` di loro. Con un data-URL di ritorno la
/// stringa diventerebbe `data:image/png;base64,data:image/png;base64,...`, cioe
/// un'immagine rotta nei primi due casi e un payload indecodificabile nel terzo,
/// mentre `encoding: 'base64'` continuerebbe a dichiarare il contrario. Il ramo
/// macOS restituisce il nudo: questo e il contratto.
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
    Ok(crate::browser_eval::base64_png(&png))
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

/// Legge una stringa da un getter COM, cioe da una funzione che invece di
/// restituirla la scrive in un parametro di uscita.
///
/// La memoria arriva allocata da COM e va restituita con `CoTaskMemFree`. Non e
/// pignoleria: chi legge i cookie lo fa a ogni export di sessione, e chi legge
/// lo user-agent a ogni cambio di emulazione.
unsafe fn com_text(
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

/// Converte un cookie WebView2 nella forma storageState che parla il client.
///
/// Tutti i getter di `ICoreWebView2Cookie` scrivono in un parametro di uscita e
/// restituiscono solo l'esito, quindi ogni campo passa da una variabile
/// d'appoggio.
unsafe fn cookie_to_json(c: &ICoreWebView2Cookie) -> Result<CookieJson, String> {
    unsafe fn flag(f: impl FnOnce(*mut BOOL) -> windows::core::Result<()>) -> bool {
        let mut b = BOOL(0);
        f(&mut b).is_ok() && b.as_bool()
    }
    let name = unsafe { com_text(|p| c.Name(p), "Name") }?;
    let value = unsafe { com_text(|p| c.Value(p), "Value") }?;
    let domain = unsafe { com_text(|p| c.Domain(p), "Domain") }?;
    let path = unsafe { com_text(|p| c.Path(p), "Path") }?;
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

/// Il profilo della pane: e l'oggetto da cui si cancellano i dati, e non
/// coincide con la webview.
///
/// Due cast in fila, ed entrambi possono mancare su un runtime WebView2
/// vecchio: `ICoreWebView2_13` porta il profilo (runtime 1.0.1108+),
/// `ICoreWebView2Profile2` porta `ClearBrowsingData` (1.0.1245+). Quando il
/// cast fallisce lo si dice, invece di restituire un successo che non ha
/// cancellato niente: e' la stessa scelta del ramo macOS, che sui sistemi senza
/// `dataStoreForIdentifier:` esce senza fingere.
fn profile2(core: &ICoreWebView2) -> Result<ICoreWebView2Profile2, String> {
    let v13: ICoreWebView2_13 = core
        .cast()
        .map_err(|e| format!("ICoreWebView2_13 (runtime WebView2 troppo vecchio): {e}"))?;
    let profile = unsafe { v13.Profile() }.map_err(|e| format!("Profile: {e}"))?;
    profile
        .cast::<ICoreWebView2Profile2>()
        .map_err(|e| format!("ICoreWebView2Profile2 (runtime WebView2 troppo vecchio): {e}"))
}

/// I soli kind che WebView2 considera CACHE: quella su disco, la CacheStorage
/// delle API dei service worker e le registrazioni dei worker stessi.
///
/// Sono gli stessi quattro cassetti del ramo macOS meno la memory cache, che
/// WebView2 non espone come kind separato perche' se ne va da sola. NON c'e'
/// dentro nulla di identita': niente `COOKIES`, niente `LOCAL_STORAGE`, niente
/// `INDEXED_DB`. Costruito a mano dai bit perche' `BitOr` qui non e' const.
fn cache_kinds() -> COREWEBVIEW2_BROWSING_DATA_KINDS {
    COREWEBVIEW2_BROWSING_DATA_KINDS(
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0
            | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE.0
            | COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS.0,
    )
}

/// Manda `ClearBrowsingData` sul profilo e NON aspetta: la callback lascia una
/// riga nel log se il motore si lamenta, e nient'altro.
///
/// E' la forma che serve alla chiusura di una pane, ed e' la stessa politica del
/// ramo macOS («fire-and-forget: non aspettiamo la completion asincrona»).
/// Aspettare qui sarebbe peggio che inutile: chi chiama e' il thread della UI,
/// cioe' proprio quello che deve far girare la callback, e il blocco durerebbe
/// fino al timeout.
pub fn purge_cache_detached(wv: &tauri::Webview) -> Result<(), String> {
    wv.with_webview(|platform| {
        let profile = match core(&platform).and_then(|c| profile2(&c)) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[browser_purge_cache] {e}");
                return;
            }
        };
        let handler = ClearBrowsingDataCompletedHandler::create(Box::new(|hr| {
            if let Err(e) = hr {
                eprintln!("[browser_purge_cache] ClearBrowsingData(cache): {e}");
            }
            Ok(())
        }));
        if let Err(e) = unsafe { profile.ClearBrowsingData(cache_kinds(), &handler) } {
            eprintln!("[browser_purge_cache] ClearBrowsingData(cache): {e}");
        }
    })
    .map_err(|e| e.to_string())
}

/// Manda `ClearBrowsingData` sul profilo e aspetta la sua callback.
///
/// Qui si aspetta, al contrario di [`purge_cache_detached`], e la differenza non
/// e' di gusto: chi chiama e' gia' su un worker, e soprattutto dopo questa
/// cancellazione c'e' una `remove_dir_all` che non puo' partire prima che il
/// motore abbia finito di scrivere.
fn clear_browsing_data(
    wv: &tauri::Webview,
    kinds: COREWEBVIEW2_BROWSING_DATA_KINDS,
    what: &'static str,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    wv.with_webview(move |platform| {
        let profile = match core(&platform).and_then(|c| profile2(&c)) {
            Ok(p) => p,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        let tx_cb = tx.clone();
        let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |hr| {
            let _ = tx_cb.send(hr.map_err(|e| format!("{what}: {e}")));
            Ok(())
        }));
        if let Err(e) = unsafe { profile.ClearBrowsingData(kinds, &handler) } {
            let _ = tx.send(Err(format!("{what}: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| format!("{what} timeout"))?
}

/// Svuota TUTTO il profilo della pane: cookie, storage, cache, autofill.
///
/// Va chiamata con la vista ancora viva, e il motivo sta nel commento di
/// `browser_purge_data_store`: la user-data folder resta aperta
/// dall'environment WebView2, quindi cancellarla da fuori non funzionerebbe.
/// L'unico che può svuotarla è il motore, finché è lì.
pub fn purge_all_blocking(wv: &tauri::Webview) -> Result<(), String> {
    clear_browsing_data(
        wv,
        COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE,
        "ClearBrowsingData(profilo)",
    )
}

/// Il gestore dei cookie della pane.
fn cookie_manager(core: &ICoreWebView2) -> Result<ICoreWebView2CookieManager, String> {
    core.cast::<ICoreWebView2_2>()
        .and_then(|c2| unsafe { c2.CookieManager() })
        .map_err(|e| format!("CookieManager: {e}"))
}

/// I record «per sito» dello store, ricavati dai COOKIE.
///
/// **Portata ridotta rispetto a macOS e Linux, e non e' una svista.** WebView2
/// non ha nessuna API per-origine: `ClearBrowsingData` prende dei kind e li
/// applica al profilo intero, e non esiste un equivalente di
/// `fetchDataRecordsOfTypes:` o di `webkit_website_data_manager_fetch`. L'unica
/// cosa enumerabile per sito e' il barattolo dei cookie, quindi i record dicono
/// `cookies` e nient'altro. Il dialogo «dimentica questo sito» legge quella
/// lista, e cosi promette esattamente cio' che [`forget_site_blocking`]
/// mantiene: sloggarti, non svuotarti il localStorage.
///
/// La normalizzazione dei domini sta in lib.rs (`cookie_domain_records`) e non
/// qui: e' una decisione, e le decisioni si provano con `cargo test`, che gira
/// su Mac e questo file non lo compila nemmeno.
pub fn site_data_records_blocking(wv: &tauri::Webview) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        let manager = match core(&platform).and_then(|c| cookie_manager(&c)) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        let tx_cb = tx.clone();
        let handler = GetCookiesCompletedHandler::create(Box::new(move |hr, list| {
            let out = (|| -> Result<String, String> {
                let domains = unsafe { cookie_domains(hr, list) }?;
                serde_json::to_string(&crate::cookie_domain_records(&domains))
                    .map_err(|e| e.to_string())
            })();
            let _ = tx_cb.send(out);
            Ok(())
        }));
        // `GetCookies(None, ...)` = tutti i cookie del profilo, come l'export di
        // sessione. Con un URI si vedrebbe solo il sito corrente, cioe l'unico
        // che il dialogo non ha bisogno di scoprire.
        if let Err(e) = unsafe { manager.GetCookies(None, &handler) } {
            let _ = tx.send(Err(format!("GetCookies: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| "site data records timeout".to_string())?
}

/// I domini di tutti i cookie di una `ICoreWebView2CookieList`.
unsafe fn cookie_domains(
    hr: windows::core::Result<()>,
    list: Option<
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList,
    >,
) -> Result<Vec<String>, String> {
    hr.map_err(|e| format!("GetCookies: {e}"))?;
    let list = list.ok_or_else(|| "GetCookies: lista assente".to_string())?;
    let mut count = 0u32;
    unsafe { list.Count(&mut count) }.map_err(|e| format!("Count: {e}"))?;
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let c = unsafe { list.GetValueAtIndex(i) }.map_err(|e| format!("GetValueAtIndex: {e}"))?;
        out.push(unsafe { com_text(|p| c.Domain(p), "Domain") }?);
    }
    Ok(out)
}

/// Cancella i cookie dei domini nominati in `names`. Ritorna quanti dei nomi
/// ricevuti hanno prodotto almeno una cancellazione.
///
/// Si cancella cookie per cookie, sugli oggetti appena enumerati, e non con
/// `DeleteCookiesWithDomainAndPath`: quello vorrebbe un path, che il dialogo non
/// ha e che dovremmo indovinare. Cosi invece si tocca ESATTAMENTE cio che si e
/// letto, che e il patto delle due chiamate.
///
/// Il confronto usa lo stesso nome normalizzato che [`site_data_records_blocking`]
/// ha mostrato, quindi «ha detto» e «ha fatto» non possono divergere.
pub fn forget_site_blocking(wv: &tauri::Webview, names: Vec<String>) -> Result<usize, String> {
    let (tx, rx) = mpsc::channel::<Result<usize, String>>();
    wv.with_webview(move |platform| {
        let manager = match core(&platform).and_then(|c| cookie_manager(&c)) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        let tx_cb = tx.clone();
        let manager_cb = manager.clone();
        let handler = GetCookiesCompletedHandler::create(Box::new(move |hr, list| {
            let out = (|| -> Result<usize, String> {
                hr.map_err(|e| format!("GetCookies: {e}"))?;
                let list = list.ok_or_else(|| "GetCookies: lista assente".to_string())?;
                let mut count = 0u32;
                unsafe { list.Count(&mut count) }.map_err(|e| format!("Count: {e}"))?;
                let mut hit: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
                for i in 0..count {
                    let c = unsafe { list.GetValueAtIndex(i) }
                        .map_err(|e| format!("GetValueAtIndex: {e}"))?;
                    let domain = unsafe { com_text(|p| c.Domain(p), "Domain") }?;
                    let name = crate::cookie_record_name(&domain);
                    if !names.contains(&name) {
                        continue;
                    }
                    if unsafe { manager_cb.DeleteCookie(&c) }.is_ok() {
                        hit.insert(name);
                    }
                }
                Ok(hit.len())
            })();
            let _ = tx_cb.send(out);
            Ok(())
        }));
        if let Err(e) = unsafe { manager.GetCookies(None, &handler) } {
            let _ = tx.send(Err(format!("GetCookies: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(FORGET_TIMEOUT)
        .map_err(|_| "forget site timeout".to_string())?
}

/// Le navigazioni semplici, che WebView2 espone direttamente sull'interfaccia
/// base. `go_to_index` non c'e sopra: vedi [`nav_entries`].
///
/// PARITY-GAP: go_to_index - WebView2 exposes no history LIST, only
/// CanGoBack/CanGoForward, so there is no index to jump to. `nav_entries`
/// returns an empty list and the shell declares the no-op instead of going
/// quiet; see NATIVEOPS-02 and `tests/unit/browser-engine-parity.test.ts`.
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
/// Si restituisce una lista vuota, che e la forma che il client legge gia come
/// «nessuna cronologia disponibile». Back e forward continuano a funzionare: e
/// solo il salto diretto a una voce che non c'e.
///
/// La chiave e `activeIndex` come sul ramo macOS, anche se qui la lista e vuota
/// e il valore non lo guarda nessuno. Vale la pena scriverla giusta lo stesso:
/// il giorno che WebView2 esponesse la cronologia, un `index` rimasto li si
/// leggerebbe come 0 invece che come l'indice vero.
pub fn nav_entries(_wv: &tauri::Webview) -> Result<String, String> {
    Ok("{\"entries\":[],\"activeIndex\":0}".to_string())
}

/// Lo user-agent di serie di ogni pane, memorizzato la prima volta che lo si
/// sovrascrive, indicizzato per etichetta della webview.
///
/// Serve perche WebView2 non ha un «rimetti come stava»: la stringa vuota, che
/// su WKWebView e proprio il modo di resettare, qui viene rifiutata dal setter.
/// L'unico default recuperabile e quello che si legge PRIMA di toccare niente,
/// quindi lo si prende al primo passaggio e si tiene da parte.
fn default_user_agents() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Cambia lo user-agent della pane (emulazione dispositivo). Stringa vuota =
/// torna al default, la stessa convenzione del ramo macOS.
///
/// Ha effetto dal caricamento successivo, sempre come su macOS: il client
/// ricarica dopo aver chiamato. Fire-and-forget, perche il comando che la invoca
/// e sincrono e gira gia sul thread della UI.
pub fn set_user_agent(wv: &tauri::Webview, label: String, ua: String) -> Result<(), String> {
    with_core(wv, move |c| {
        // `UserAgent` sta su Settings2, non sull'interfaccia base delle
        // impostazioni: su un runtime WebView2 troppo vecchio il cast fallisce e
        // l'emulazione semplicemente non c'e.
        let settings: ICoreWebView2Settings2 = unsafe { c.Settings() }
            .map_err(|e| format!("Settings: {e}"))?
            .cast()
            .map_err(|e| format!("Settings2: {e}"))?;
        let current = unsafe { com_text(|p| settings.UserAgent(p), "UserAgent") }?;
        if let Ok(mut m) = default_user_agents().lock() {
            m.entry(label.clone()).or_insert(current);
        }
        let target = if ua.is_empty() {
            default_user_agents()
                .lock()
                .ok()
                .and_then(|m| m.get(&label).cloned())
                .unwrap_or_default()
        } else {
            ua
        };
        // Un default che non si e mai riusciti a leggere lascia la pane com'e.
        // Mandare la stringa vuota al setter non resetterebbe niente: verrebbe
        // rifiutata, e sarebbe solo un errore in piu nel log.
        if target.is_empty() {
            return Ok(());
        }
        unsafe { settings.SetUserAgent(&HSTRING::from(target.as_str())) }
            .map_err(|e| format!("SetUserAgent: {e}"))
    })
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
