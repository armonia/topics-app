//! Backend WebKitGTK del pane browser nativo (Linux e i BSD).
//!
//! Stessa forma del backend WebView2: `with_webview` porta sul thread della UI
//! (qui il main loop GLib), li si lancia l'operazione asincrona, il risultato
//! torna su un canale. **Non chiamare dal thread principale**: si aspetta una
//! callback che gira proprio li.
//!
//! Attesa delle promise e forma del risultato stanno in [`crate::browser_eval`],
//! condivise con Windows.

use crate::browser_eval::{self, EvalStep};
use crate::CookieJson;
use std::sync::mpsc;
use std::time::{Duration, Instant};
// glib e gio arrivano ri-esportati da webkit2gtk, quindi sono per forza le
// stesse versioni che usa lei. `soup` e `javascriptcore` invece no: vanno
// dichiarati in Cargo.toml e le versioni tenute allineate a mano.
use javascriptcore::ValueExt;
use webkit2gtk::gio;
use webkit2gtk::glib;
use webkit2gtk::{CookieManagerExt, SnapshotOptions, SnapshotRegion, WebViewExt};

const OP_TIMEOUT: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Un giro secco di `evaluate_javascript`.
///
/// JavaScriptCore restituisce un `JSCValue`; `to_str()` e la sua conversione a
/// stringa. Il valore prodotto dal wrapper e sempre una stringa, per
/// costruzione, quindi il testo JSON esce tale e quale. E il motivo per cui, a
/// differenza di WebView2, qui non c'e nessun livello di codifica da scartare.
fn evaluate(wv: &tauri::Webview, script: String) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        let view = platform.inner();
        let tx_cb = tx.clone();
        view.evaluate_javascript(
            &script,
            None,
            None,
            None::<&gio::Cancellable>,
            move |res| {
                let out = match res {
                    Ok(v) => Ok(browser_eval::strip_json_string_layer(v.to_str().as_str())),
                    Err(e) => Err(format!("evaluate_javascript: {e}")),
                };
                let _ = tx_cb.send(out);
            },
        );
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| "eval timeout".to_string())?
}

/// Valuta un'espressione e restituisce il risultato con la forma di macOS.
///
/// `preserve_focus` non fa niente qui, come su Windows: il salvataggio del
/// first-responder serve a WKWebView, dove un `focus()` dentro la pane ruba il
/// fuoco alla finestra intera. GTK non si comporta cosi.
pub fn eval_js_blocking(
    wv: &tauri::Webview,
    js: String,
    _preserve_focus: bool,
) -> Result<String, String> {
    let token = browser_eval::next_token();
    let first = evaluate(wv, browser_eval::wrap_expression(&js, &token))?;
    match browser_eval::parse_payload(&first)? {
        Some(EvalStep::Done(v)) => Ok(v),
        Some(EvalStep::Failed(e)) => Err(e),
        Some(EvalStep::Pending(k)) => {
            let poll = browser_eval::wrap_poll(&k);
            let deadline = Instant::now() + OP_TIMEOUT;
            while Instant::now() < deadline {
                std::thread::sleep(POLL_INTERVAL);
                let raw = evaluate(wv, poll.clone())?;
                match browser_eval::parse_payload(&raw)? {
                    Some(EvalStep::Done(v)) => return Ok(v),
                    Some(EvalStep::Failed(e)) => return Err(e),
                    Some(EvalStep::Pending(_)) | None => continue,
                }
            }
            Err("eval timeout".to_string())
        }
        None => Err("eval timeout".to_string()),
    }
}

/// Screenshot della pane come data-URL PNG, uguale agli altri due backend.
///
/// `SnapshotRegion::Visible` e non `FullDocument`: e la porzione a schermo che
/// cattura anche WKWebView, e quella che l'agent si aspetta di vedere quando
/// chiede «cosa c'e adesso nella pane».
pub fn screenshot_blocking(wv: &tauri::Webview) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    wv.with_webview(move |platform| {
        let view = platform.inner();
        let tx_cb = tx.clone();
        view.snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            None::<&gio::Cancellable>,
            move |res| {
                let out = (|| -> Result<Vec<u8>, String> {
                    let surface = res.map_err(|e| format!("snapshot: {e}"))?;
                    // `write_to_png` vive su ImageSurface, non su Surface: la
                    // snapshot di WebKitGTK e sempre una image surface, ma la
                    // firma restituisce il tipo base, quindi va ridiscesa.
                    let image = cairo::ImageSurface::try_from(surface)
                        .map_err(|_| "snapshot non e una ImageSurface".to_string())?;
                    let mut png: Vec<u8> = Vec::new();
                    image
                        .write_to_png(&mut png)
                        .map_err(|e| format!("write_to_png: {e}"))?;
                    Ok(png)
                })();
                let _ = tx_cb.send(out);
            },
        );
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

/// Legge i cookie della pane.
///
/// **Portata ridotta rispetto a macOS, e va detto:** `webkit_cookie_manager_get_cookies`
/// vuole un URI e restituisce solo i cookie che valgono per QUELLO. Non esiste
/// un equivalente di `getAllCookies`: WebKitGTK non espone l'enumerazione
/// completa del barattolo. Si usa quindi l'URL corrente della pane, che copre il
/// caso per cui il comando esiste, cioe esportare la sessione del sito su cui si
/// e appena fatto login. Non copre un export multi-dominio in un colpo solo.
pub fn cookies_get_blocking(wv: &tauri::Webview) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        let view = platform.inner();
        let uri = match view.uri() {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => {
                let _ = tx.send(Err("la pane non ha ancora un URL".to_string()));
                return;
            }
        };
        let Some(manager) = cookie_manager(&view) else {
            let _ = tx.send(Err("nessun CookieManager".to_string()));
            return;
        };
        let tx_cb = tx.clone();
        manager.cookies(&uri, None::<&gio::Cancellable>, move |res| {
            let out = (|| -> Result<String, String> {
                let cookies = res.map_err(|e| format!("get cookies: {e}"))?;
                let list: Vec<CookieJson> = cookies.into_iter().map(soup_to_json).collect();
                serde_json::to_string(&list).map_err(|e| e.to_string())
            })();
            let _ = tx_cb.send(out);
        });
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| "get cookies timeout".to_string())?
}

/// Inietta i cookie di una sessione salvata. Restituisce `{"set":n,"skipped":m}`
/// come gli altri due backend.
pub fn cookies_set_blocking(
    wv: &tauri::Webview,
    cookies: Vec<CookieJson>,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<(usize, usize), String>>();
    wv.with_webview(move |platform| {
        let view = platform.inner();
        let Some(manager) = cookie_manager(&view) else {
            let _ = tx.send(Err("nessun CookieManager".to_string()));
            return;
        };
        let (mut set, mut skipped) = (0usize, 0usize);
        for ck in &cookies {
            let Some(domain) = ck.domain.as_deref().filter(|d| !d.is_empty()) else {
                skipped += 1;
                continue;
            };
            let path = ck.path.as_deref().filter(|p| !p.is_empty()).unwrap_or("/");
            // max_age -1 = cookie di sessione; la scadenza vera, se c'e, si
            // rimette sotto con `set_expires`.
            let mut c = soup::Cookie::new(&ck.name, &ck.value, domain, path, -1);
            if let Some(exp) = ck.expires.filter(|e| *e > 0.0) {
                if let Ok(dt) = glib::DateTime::from_unix_utc(exp as i64) {
                    c.set_expires(&dt);
                }
            }
            if ck.secure == Some(true) {
                c.set_secure(true);
            }
            if ck.http_only == Some(true) {
                c.set_http_only(true);
            }
            c.set_same_site_policy(match ck.same_site.as_deref() {
                Some("Lax") => soup::SameSitePolicy::Lax,
                Some("Strict") => soup::SameSitePolicy::Strict,
                _ => soup::SameSitePolicy::None,
            });
            // `add_cookie` e asincrona ma il suo esito non cambia il conteggio
            // che restituiamo: come su macOS si contano i cookie ACCETTATI in
            // ingresso, non quelli confermati dal disco.
            manager.add_cookie(&mut c, None::<&gio::Cancellable>, |_| {});
            set += 1;
        }
        let _ = tx.send(Ok((set, skipped)));
    })
    .map_err(|e| e.to_string())?;
    let (set, skipped) = rx
        .recv_timeout(OP_TIMEOUT)
        .map_err(|_| "set cookies timeout".to_string())??;
    Ok(format!("{{\"set\":{set},\"skipped\":{skipped}}}"))
}

/// Il gestore dei cookie della sessione della pane. Passa dal
/// `WebsiteDataManager` del contesto, che e anche cio che rende il barattolo
/// separato quando la pane e isolata.
fn cookie_manager(view: &webkit2gtk::WebView) -> Option<webkit2gtk::CookieManager> {
    use webkit2gtk::WebContextExt;
    view.context()?.cookie_manager()
}

fn soup_to_json(mut c: soup::Cookie) -> CookieJson {
    let expires = c
        .expires()
        .map(|d| d.to_unix() as f64)
        .filter(|e| *e > 0.0)
        .unwrap_or(-1.0);
    let same_site = match c.same_site_policy() {
        soup::SameSitePolicy::Lax => "Lax",
        soup::SameSitePolicy::Strict => "Strict",
        _ => "None",
    };
    CookieJson {
        name: c.name().map(|s| s.to_string()).unwrap_or_default(),
        value: c.value().map(|s| s.to_string()).unwrap_or_default(),
        domain: Some(c.domain().map(|s| s.to_string()).unwrap_or_default()),
        path: Some(c.path().map(|s| s.to_string()).unwrap_or_default()),
        expires: Some(expires),
        http_only: Some(c.is_http_only()),
        secure: Some(c.is_secure()),
        same_site: Some(same_site.to_string()),
    }
}

pub fn go_back(wv: &tauri::Webview) -> Result<(), String> {
    on_view(wv, |v| v.go_back())
}

pub fn go_forward(wv: &tauri::Webview) -> Result<(), String> {
    on_view(wv, |v| v.go_forward())
}

pub fn reload(wv: &tauri::Webview) -> Result<(), String> {
    on_view(wv, |v| v.reload())
}

/// A differenza di WebView2, WebKitGTK **la lista della history ce l'ha**
/// (`WebKitBackForwardList`), quindi qui la parita con macOS e piena.
pub fn nav_entries(wv: &tauri::Webview) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        use webkit2gtk::{BackForwardListExt, BackForwardListItemExt};
        let view = platform.inner();
        let out = (|| -> Result<String, String> {
            let list = view
                .back_forward_list()
                .ok_or_else(|| "nessuna back-forward list".to_string())?;
            let entry = |item: &webkit2gtk::BackForwardListItem| {
                serde_json::json!({
                    "url": item.uri().map(|s| s.to_string()).unwrap_or_default(),
                    "title": item.title().map(|s| s.to_string()).unwrap_or_default(),
                })
            };
            // `back_list()` arriva dal piu recente al piu vecchio: si rovescia,
            // perche l'indice che il client usa conta dall'inizio della storia.
            let mut entries: Vec<serde_json::Value> =
                list.back_list().iter().rev().map(&entry).collect();
            // L'indice della voce corrente e quante ne ha davanti a se: si legge
            // PRIMA di aggiungerla.
            let index = entries.len() as i64;
            if let Some(cur) = list.current_item() {
                entries.push(entry(&cur));
            }
            entries.extend(list.forward_list().iter().map(&entry));
            serde_json::to_string(&serde_json::json!({ "entries": entries, "index": index }))
                .map_err(|e| e.to_string())
        })();
        let _ = tx.send(out);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| "nav entries timeout".to_string())?
}

/// Salta a una voce della cronologia per indice. L'indice e quello prodotto da
/// [`nav_entries`], cioe conta dall'inizio della storia. Fire-and-forget come le
/// altre navigazioni: il comando che la chiama e sincrono.
pub fn go_to_index(wv: &tauri::Webview, index: i64) -> Result<(), String> {
    on_view(wv, move |view| {
        use webkit2gtk::BackForwardListExt;
        let Some(list) = view.back_forward_list() else {
            return;
        };
        let mut all: Vec<webkit2gtk::BackForwardListItem> =
            list.back_list().into_iter().rev().collect();
        if let Some(cur) = list.current_item() {
            all.push(cur);
        }
        all.extend(list.forward_list());
        if let Some(item) = usize::try_from(index).ok().and_then(|i| all.get(i)) {
            view.go_to_back_forward_list_item(item);
        }
    })
}

/// Cambia lo user-agent della pane. Ha effetto dal caricamento successivo, come
/// su macOS: il client ricarica dopo averlo impostato.
pub fn set_user_agent(wv: &tauri::Webview, ua: String) -> Result<(), String> {
    on_view(wv, move |v| {
        use webkit2gtk::SettingsExt;
        if let Some(s) = WebViewExt::settings(v) {
            s.set_user_agent(Some(&ua));
        }
    })
}

/// Helper per le op di navigazione: manda il lavoro sul thread della UI e NON
/// aspetta.
///
/// Come su Windows: `browser_back` e compagni sono comandi Tauri sincroni, quindi
/// girano gia sul main thread. Aspettare qui vorrebbe dire aspettare il thread
/// su cui si sta gia. La app si pianterebbe a ogni click su Indietro.
fn on_view<F>(wv: &tauri::Webview, f: F) -> Result<(), String>
where
    F: FnOnce(&webkit2gtk::WebView) + Send + 'static,
{
    wv.with_webview(move |platform| f(&platform.inner()))
        .map_err(|e| e.to_string())
}
