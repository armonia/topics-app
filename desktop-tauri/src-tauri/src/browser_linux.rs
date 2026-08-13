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
use webkit2gtk::{
    CookieManagerExt, SnapshotOptions, SnapshotRegion, WebViewExt, WebsiteDataManagerExt,
    WebsiteDataManagerExtManual, WebsiteDataTypes,
};

const OP_TIMEOUT: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Dimenticare un sito e due giri di motore, non uno: prima `fetch` per sapere
/// quali record esistono, poi `remove` su quelli scelti. Stesso tetto del ramo
/// macOS e di quello WebView2, per la stessa ragione.
const FORGET_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Screenshot della pane come base64 NUDO, senza il prefisso `data:`, uguale
/// agli altri due backend. Il prefisso lo mette il chiamante: vedi la nota nel
/// backend WebView2, dove c'e il conto di cosa si rompe se lo si mette qui.
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
    Ok(crate::browser_eval::base64_png(&png))
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

/// Il `WebsiteDataManager` della pane, cioe' il suo store.
///
/// Fuori da macOS l'isolamento e' una CARTELLA (vedi `pane_store_dir` in
/// lib.rs): wry la passa a `WebsiteDataManager::builder()` come
/// `base_data_directory` e `base_cache_directory`, ci appoggia il barattolo dei
/// cookie, e attacca quel manager al `WebContext` della pane. Quindi «lo store
/// della pane» e questo oggetto, ed e' a lui che parlano i comandi che su macOS
/// parlano al `WKWebsiteDataStore`.
///
/// Ci si arriva dal CONTESTO e non dalla vista, e la differenza non e' di stile:
/// `webkit_web_view_get_website_data_manager` e' deprecata dal 2.40 e nelle API
/// piu' nuove risponde con il manager della sessione di rete, mentre il contesto
/// restituisce per costruzione il manager con cui e' stato costruito, cioe' il
/// nostro. Sbagliare oggetto qui vorrebbe dire cancellare i dati di tutte le
/// pane invece che di una.
fn data_manager(view: &webkit2gtk::WebView) -> Option<webkit2gtk::WebsiteDataManager> {
    use webkit2gtk::WebContextExt;
    view.context()?.website_data_manager()
}

/// I soli tipi che WebKitGTK considera CACHE: sono gli stessi quattro cassetti
/// del ramo macOS (vedi `browser_purge_cache` in lib.rs per la misura che li ha
/// scelti), con `DOM_CACHE` che e' il nome GTK della CacheStorage, cioe' il
/// `FetchCache` di WebKit.
///
/// Fuori restano `COOKIES`, `LOCAL_STORAGE`, `SESSION_STORAGE`,
/// `INDEXEDDB_DATABASES` e `WEBSQL_DATABASES`: sono l'identita' sul sito, e
/// questo comando gira a ogni chiusura di pane.
fn cache_types() -> WebsiteDataTypes {
    WebsiteDataTypes::DISK_CACHE
        | WebsiteDataTypes::MEMORY_CACHE
        | WebsiteDataTypes::DOM_CACHE
        | WebsiteDataTypes::SERVICE_WORKER_REGISTRATIONS
}

/// I tipi che l'elenco per-sito mostra e che «dimentica questo sito» rimuove:
/// la stessa scelta che su macOS si chiama `allWebsiteDataTypes`.
///
/// NON e' `WebsiteDataTypes::ALL`, e la differenza e' voluta. `ALL` aggiunge
/// ITP, la cache HSTS e i sali degli identificatori di dispositivo: roba che
/// macOS tiene fuori dall'elenco pubblico e che nel dialogo diventerebbe una
/// lista di host che l'utente non ha mai deciso di visitare. Il totale si
/// cancella lo stesso, ma da [`purge_all_blocking`], che e' un'altra domanda.
fn site_data_types() -> WebsiteDataTypes {
    WebsiteDataTypes::COOKIES
        | WebsiteDataTypes::LOCAL_STORAGE
        | WebsiteDataTypes::SESSION_STORAGE
        | WebsiteDataTypes::INDEXEDDB_DATABASES
        | WebsiteDataTypes::WEBSQL_DATABASES
        | WebsiteDataTypes::OFFLINE_APPLICATION_CACHE
        | cache_types()
}

/// Manda `webkit_website_data_manager_clear` sulle sole cache e NON aspetta: la
/// callback lascia una riga nel log se il motore si lamenta, e nient'altro.
///
/// E' la forma che serve alla chiusura di una pane, ed e' la stessa politica del
/// ramo macOS («fire-and-forget: non aspettiamo la completion asincrona»).
/// Aspettare qui sarebbe peggio che inutile: chi chiama e' il thread del main
/// loop GLib, cioe' proprio quello che deve far girare la callback.
pub fn purge_cache_detached(wv: &tauri::Webview) -> Result<(), String> {
    wv.with_webview(|platform| {
        let view = platform.inner();
        let Some(manager) = data_manager(&view) else {
            eprintln!("[browser_purge_cache] nessun WebsiteDataManager");
            return;
        };
        manager.clear(
            cache_types(),
            glib::TimeSpan(0),
            None::<&gio::Cancellable>,
            |res| {
                if let Err(e) = res {
                    eprintln!("[browser_purge_cache] clear(cache): {e}");
                }
            },
        );
    })
    .map_err(|e| e.to_string())
}

/// Manda `webkit_website_data_manager_clear` e aspetta la sua callback.
///
/// Qui si aspetta, al contrario di [`purge_cache_detached`], e la differenza non
/// e' di gusto: chi chiama e' gia' su un worker, e soprattutto dopo questa
/// cancellazione c'e' una `remove_dir_all` che non puo' partire prima che il
/// motore abbia finito di scrivere.
fn clear_data(
    wv: &tauri::Webview,
    types: WebsiteDataTypes,
    what: &'static str,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    wv.with_webview(move |platform| {
        let view = platform.inner();
        let Some(manager) = data_manager(&view) else {
            let _ = tx.send(Err("nessun WebsiteDataManager".to_string()));
            return;
        };
        let tx_cb = tx.clone();
        // `TimeSpan(0)` = da sempre, non «solo il recente»: e' il `distantPast`
        // che passa il ramo macOS.
        manager.clear(
            types,
            glib::TimeSpan(0),
            None::<&gio::Cancellable>,
            move |res| {
                let _ = tx_cb.send(res.map_err(|e| format!("{what}: {e}")));
            },
        );
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| format!("{what} timeout"))?
}

/// Svuota TUTTO lo store della pane: cookie, storage, cache, ITP, HSTS.
///
/// Va chiamata con la vista ancora viva, per lo stesso motivo di Windows
/// (commento in `browser_purge_data_store`): la cartella e' aperta dal
/// `WebContext` finche' quello vive, e cancellarla da fuori lascerebbe indietro
/// tutto cio' che WebKit tiene ancora in mano. L'unico che puo' svuotarla per
/// davvero e' il motore.
pub fn purge_all_blocking(wv: &tauri::Webview) -> Result<(), String> {
    clear_data(wv, WebsiteDataTypes::ALL, "clear(store)")
}

/// Le chiavi di contratto dei tipi di un record, le stesse che macOS ricava dai
/// simboli del framework (`site_data_type_key` in lib.rs) e che
/// `browserForgetSite.ts` raggruppa in sessione / dati / cache.
///
/// Un tipo che il client non conosce finisce comunque nel mucchio «dati del
/// sito», quindi la mappa qui elenca solo i dieci che hanno un nome proprio: i
/// bit che restano fuori (ITP, HSTS, sali) non arrivano nemmeno, perche'
/// [`site_data_types`] non li chiede.
fn type_keys(types: WebsiteDataTypes) -> Vec<String> {
    let known: [(WebsiteDataTypes, &str); 10] = [
        (WebsiteDataTypes::COOKIES, "cookies"),
        (WebsiteDataTypes::LOCAL_STORAGE, "localStorage"),
        (WebsiteDataTypes::SESSION_STORAGE, "sessionStorage"),
        (WebsiteDataTypes::INDEXEDDB_DATABASES, "indexedDB"),
        (WebsiteDataTypes::WEBSQL_DATABASES, "webSql"),
        (WebsiteDataTypes::DISK_CACHE, "diskCache"),
        (WebsiteDataTypes::MEMORY_CACHE, "memoryCache"),
        (WebsiteDataTypes::DOM_CACHE, "fetchCache"),
        (
            WebsiteDataTypes::OFFLINE_APPLICATION_CACHE,
            "offlineAppCache",
        ),
        (
            WebsiteDataTypes::SERVICE_WORKER_REGISTRATIONS,
            "serviceWorkers",
        ),
    ];
    known
        .iter()
        .filter(|(flag, _)| types.contains(*flag))
        .map(|(_, key)| (*key).to_string())
        .collect()
}

/// Elenca cosa c'e' nello store della pane, per sito: `[{displayName, types}]`.
///
/// Parita' piena con macOS, e non e' una coincidenza: `WebsiteDataManager` e
/// `WKWebsiteDataStore` sono due facce dello stesso motore, quindi
/// `webkit_website_data_manager_fetch` risponde con gli stessi record che
/// `fetchDataRecordsOfTypes:` restituisce di la'. Anche il nome ha la stessa
/// semantica: e' il sito, non l'host della pagina, e i documenti locali stanno
/// tutti insieme sotto un solo record. Windows e l'unico dei tre a dire di
/// meno, e il suo commento spiega perche'.
pub fn site_data_records_blocking(wv: &tauri::Webview) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    wv.with_webview(move |platform| {
        let view = platform.inner();
        let Some(manager) = data_manager(&view) else {
            let _ = tx.send(Err("nessun WebsiteDataManager".to_string()));
            return;
        };
        let tx_cb = tx.clone();
        manager.fetch(site_data_types(), None::<&gio::Cancellable>, move |res| {
            let out = (|| -> Result<String, String> {
                let data = res.map_err(|e| format!("fetch: {e}"))?;
                let records: Vec<crate::SiteDataRecordJson> = data
                    .into_iter()
                    .filter_map(|d| {
                        let name = d.name()?.to_string();
                        if name.is_empty() {
                            return None;
                        }
                        Some(crate::SiteDataRecordJson {
                            display_name: name,
                            types: type_keys(d.types()),
                        })
                    })
                    .collect();
                serde_json::to_string(&records).map_err(|e| e.to_string())
            })();
            let _ = tx_cb.send(out);
        });
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(OP_TIMEOUT)
        .map_err(|_| "site data records timeout".to_string())?
}

/// Rimuove dallo store i soli record che si chiamano come uno dei `names`, con
/// tutti i loro tipi. Ritorna quanti record ha tolto.
///
/// I record si RI-CHIEDONO qui invece di ricostruirli dai nomi, perche'
/// `webkit_website_data_manager_remove` vuole gli oggetti `WebsiteData` veri e
/// non delle stringhe: si cancella esattamente l'elenco che e' stato letto, e un
/// record comparso nel frattempo non e' nella lista dell'utente, quindi non
/// muore per sbaglio. E' lo stesso patto delle due chiamate su macOS.
pub fn forget_site_blocking(wv: &tauri::Webview, names: Vec<String>) -> Result<usize, String> {
    let (tx, rx) = mpsc::channel::<Result<usize, String>>();
    wv.with_webview(move |platform| {
        let view = platform.inner();
        let Some(manager) = data_manager(&view) else {
            let _ = tx.send(Err("nessun WebsiteDataManager".to_string()));
            return;
        };
        let tx_cb = tx.clone();
        let manager_cb = manager.clone();
        manager.fetch(site_data_types(), None::<&gio::Cancellable>, move |res| {
            let data = match res {
                Ok(d) => d,
                Err(e) => {
                    let _ = tx_cb.send(Err(format!("fetch: {e}")));
                    return;
                }
            };
            let victims: Vec<webkit2gtk::WebsiteData> = data
                .into_iter()
                .filter(|d| {
                    d.name()
                        .map(|n| names.contains(&n.to_string()))
                        .unwrap_or(false)
                })
                .collect();
            if victims.is_empty() {
                let _ = tx_cb.send(Ok(0));
                return;
            }
            let hit = victims.len();
            let refs: Vec<&webkit2gtk::WebsiteData> = victims.iter().collect();
            manager_cb.remove(
                site_data_types(),
                &refs,
                None::<&gio::Cancellable>,
                move |res| {
                    let _ = tx_cb.send(res.map(|()| hit).map_err(|e| format!("remove: {e}")));
                },
            );
        });
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(FORGET_TIMEOUT)
        .map_err(|_| "forget site timeout".to_string())?
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
            let active_index = entries.len() as i64;
            if let Some(cur) = list.current_item() {
                entries.push(entry(&cur));
            }
            entries.extend(list.forward_list().iter().map(&entry));
            // La chiave e `activeIndex`, non `index`, e non e un dettaglio di
            // stile: e il nome che legge `useTauriBrowser.getNavEntries`, ed e
            // quello che restituisce il ramo macOS. Con `index` il client non
            // trova niente e ripiega su 0, cioe considera TUTTA la cronologia
            // come «avanti»: il menu Indietro resta vuoto e quello Avanti mostra
            // il passato. Nessun errore da nessuna parte, solo due menu sbagliati.
            serde_json::to_string(
                &serde_json::json!({ "entries": entries, "activeIndex": active_index }),
            )
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
