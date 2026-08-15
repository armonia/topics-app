//! Native banner delivery via the modern `UserNotifications` framework.
//!
//! The plugin path (tauri-plugin-notification → notify-rust → mac-notification-sys)
//! posts through the DEPRECATED `NSUserNotificationCenter`. macOS 26's usernoted
//! refuses those legacy connections outright — "no notification allowed to be sent
//! to it" — so every banner was silently dropped, and since nothing ever requested
//! authorization (the desktop plugin hardcodes `PermissionState::Granted`) Topics
//! never even appeared in System Settings → Notifications. This module posts
//! `UNNotificationRequest`s directly and requests authorization once at setup.
//!
//! Un-bundled processes (`cargo run` dev) MUST NOT touch `UNUserNotificationCenter`:
//! `currentNotificationCenter()` raises an ObjC exception when there is no bundle
//! proxy. Every entry point guards on `NSBundle.bundleIdentifier`; the caller falls
//! back to the plugin path (at worst the old non-delivery, never a crash).

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

/// Un tasto del banner: l'id che torna indietro al click + l'etichetta.
/// L'id lo compone il client (`shared/notify-actions`) e CODIFICA l'azione
/// per intero — qui dentro non si sa (e non serve sapere) cosa significhi:
/// il guscio lo trasporta e lo restituisce, la decisione resta di là.
#[derive(Clone, serde::Deserialize)]
pub struct NotifyAction {
    pub id: String,
    pub title: String,
}

/// True when running from a real .app bundle (`bundleIdentifier` set).
pub fn is_bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// UN authorization state, resolved async by `install()`'s callbacks. False
/// until they land (instants after boot) — early posts take the helper path.
static UN_AUTHORIZED: AtomicBool = AtomicBool::new(false);

/// L'esito TESTUALE dell'autorizzazione, per poterlo RACCONTARE.
///
/// Tutta questa catena fallisce in silenzio: non bundled → esci; non
/// autorizzato → passa dall'helper; niente helper → esci. Da fuori è
/// indistinguibile da "nessuna notifica da mostrare", e l'utente resta
/// convinto che il pannello Impostazioni dica il vero. Qui si tiene l'ultimo
/// stato noto perché `notification_status` possa dirlo alla UI.
///
/// `NOT_DETERMINED` è distinto da `DENIED` e la differenza NON è accademica:
/// il pannello, su «negato», consiglia di riaccendere le notifiche in
/// Impostazioni di Sistema → Notifiche. Se lo stato vero è «non ancora
/// deciso», lì dentro Topics non compare proprio, e il consiglio manda
/// l'utente a cercare una voce che non esiste.
static AUTH_STATE: AtomicU8 = AtomicU8::new(AUTH_PENDING);
/// Nessuna lettura è ancora tornata (istanti dopo il boot).
const AUTH_PENDING: u8 = 0;
const AUTH_GRANTED: u8 = 1;
/// SOLO `UNAuthorizationStatus::Denied`. Un `requestAuthorization` fallito
/// non basta: vedi `install()`.
const AUTH_DENIED: u8 = 2;
/// macOS non ha ancora deciso: né concesso né negato. È lo stato di una
/// build a cui il prompt non è mai riuscito.
const AUTH_NOT_DETERMINED: u8 = 3;

/// Fotografia dello stato reale della catena delle notifiche native.
/// Sola lettura: nessun campo qui cambia il comportamento, servono a NON
/// far fallire in silenzio.
#[derive(serde::Serialize, Clone)]
pub struct NotificationStatus {
    /// Gira da un vero .app? Fuori dal bundle non si posta nulla.
    pub bundled: bool,
    /// macOS ci ha autorizzati a postare a NOSTRO nome. Su una build non
    /// firmata Apple è `false` per progetto — macOS 26 rifiuta senza
    /// nemmeno chiedere.
    pub authorized: bool,
    /// "pending" | "notDetermined" | "granted" | "denied". `authorized=false`
    /// con "pending" è ancora in volo; con "notDetermined" macOS non ha mai
    /// deciso (e in Impostazioni di Sistema l'app NON compare); con "denied"
    /// c'è un rifiuto esplicito, ed è l'unico caso in cui ha senso mandare
    /// l'utente in quel pannello.
    pub auth_state: &'static str,
    /// Il carrier di ripiego, se risolto. `None` = niente banner nativi,
    /// punto: né come noi né via helper.
    pub helper: Option<String>,
    /// Dove va il log della catena, così il campo può guardarlo.
    pub log_path: Option<String>,
}

/// Rilegge da macOS lo stato dell'autorizzazione e lo scrive negli atomici.
///
/// Il pannello Impostazioni consiglia di riaccendere le notifiche in
/// Impostazioni di Sistema. Finché questa lettura si faceva UNA volta sola
/// dentro `install()`, seguire quel consiglio non cambiava niente: la
/// diagnosi restava la fotografia scattata al boot e continuava a dire
/// «non arrivano» proprio nel momento in cui l'utente aveva appena fatto
/// quello che gli avevamo chiesto. Vale anche al contrario — notifiche
/// spente a mano e pannello che giura che va tutto bene.
///
/// `wait` è il tetto entro cui aspettare il callback (`ZERO` = spara e
/// vai, com'era all'install). Scaduto il tetto non si blocca niente:
/// restano gli ultimi valori noti e il callback aggiornerà comunque gli
/// atomici per la lettura dopo. Chi aspetta NON deve stare sul main
/// thread: `notification_status` è marcato `#[tauri::command(async)]`
/// apposta.
fn refresh_auth_state(wait: std::time::Duration) {
    if !is_bundled() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let landed = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let signal = landed.clone();
    let settings_done = RcBlock::new(
        move |settings: std::ptr::NonNull<objc2_user_notifications::UNNotificationSettings>| {
            use objc2_user_notifications::UNAuthorizationStatus;
            let s = unsafe { settings.as_ref() };
            let status = s.authorizationStatus();
            // Questa lettura è AUTORITATIVA: dice lo stato di adesso, non
            // l'esito di un prompt. Perciò un `Denied` sovrascrive anche un
            // `granted` precedente — è l'unico modo perché una revoca fatta
            // in Impostazioni di Sistema si veda. E `UN_AUTHORIZED=false`
            // non spegne i banner: manda `post` sull'helper firmato, che è
            // esattamente quello che serve quando a nostro nome verrebbero
            // buttati in silenzio.
            //
            // `NotDetermined` ora si REGISTRA (prima veniva ignorato, e il
            // pannello restava con il "denied" inventato da `install()` —
            // che mandava a cercare Topics in un pannello dove non c'è).
            // Non tocca `UN_AUTHORIZED`, però: quello è instradamento di
            // consegna, e mentre il prompt è ancora aperto l'altro callback
            // può arrivare con un `granted` — spegnerlo qui sarebbe una
            // corsa contro la sola via che consegna davvero.
            if status == UNAuthorizationStatus::Authorized
                || status == UNAuthorizationStatus::Provisional
            {
                UN_AUTHORIZED.store(true, Ordering::Relaxed);
                AUTH_STATE.store(AUTH_GRANTED, Ordering::Relaxed);
            } else if status == UNAuthorizationStatus::Denied {
                UN_AUTHORIZED.store(false, Ordering::Relaxed);
                AUTH_STATE.store(AUTH_DENIED, Ordering::Relaxed);
            } else if status == UNAuthorizationStatus::NotDetermined {
                AUTH_STATE.store(AUTH_NOT_DETERMINED, Ordering::Relaxed);
            }
            diag(&format!(
                "settings → authorizationStatus={:?} alertSetting={:?}",
                status,
                s.alertSetting()
            ));
            let (lock, cv) = &*signal;
            if let Ok(mut done) = lock.lock() {
                *done = true;
            }
            cv.notify_all();
        },
    );
    center.getNotificationSettingsWithCompletionHandler(&settings_done);
    if wait.is_zero() {
        return;
    }
    let (lock, cv) = &*landed;
    let Ok(mut done) = lock.lock() else { return };
    while !*done {
        let Ok((guard, timeout)) = cv.wait_timeout(done, wait) else { return };
        done = guard;
        if timeout.timed_out() {
            break;
        }
    }
}

pub fn status() -> NotificationStatus {
    // Prima di raccontarlo, si ricontrolla: vedi `refresh_auth_state`. Il
    // tetto è stretto perché è una query locale al demone delle notifiche —
    // se non risponde in 300ms si risponde con l'ultimo stato noto invece
    // di far aspettare il pannello.
    refresh_auth_state(std::time::Duration::from_millis(300));
    let auth_state = match AUTH_STATE.load(Ordering::Relaxed) {
        AUTH_GRANTED => "granted",
        AUTH_DENIED => "denied",
        AUTH_NOT_DETERMINED => "notDetermined",
        _ => "pending",
    };
    NotificationStatus {
        bundled: is_bundled(),
        authorized: UN_AUTHORIZED.load(Ordering::Relaxed),
        auth_state,
        helper: helper_path().map(|p| p.display().to_string()),
        log_path: std::env::var("HOME")
            .ok()
            .map(|h| format!("{h}/Library/Logs/topics-notifications.log")),
    }
}

/// Fallback banner carrier. macOS 26 denies UN authorization to any app
/// without an Apple-chain code signature (adhoc AND locally self-signed both
/// refused: no prompt, app never listed in Settings → Notifications), so an
/// unsigned Topics.app cannot post banners AS ITSELF. terminal-notifier is
/// Developer-ID-signed and already authorized on this machine (it's the same
/// carrier ~/.claude/notify.sh banners ride on — usernoted logs `Presenting`
/// for it), and `-activate` hands the banner click back to Topics. Resolved
/// once; absolute candidates because a login-item's PATH is minimal.
static HELPER: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();

// NON spediamo un carrier dentro il bundle, ed è una scelta.
//
// Il piano era: impacchettare `terminal-notifier.app` sotto
// `bundle.resources` e cercarlo in `resource_dir()`, così una build
// rilasciata non dipende da cosa ha installato l'utente. Il presupposto era
// che terminal-notifier fosse firmato Developer ID. Non lo è:
//
//   $ codesign -dvvv /opt/homebrew/Cellar/terminal-notifier/2.0.0/terminal-notifier.app
//   CodeDirectory flags=0x20002(adhoc,linker-signed)
//   Signature=adhoc
//   TeamIdentifier=not set
//
// Su QUESTA macchina funziona perché è stato autorizzato a suo tempo. Su
// una macchina pulita ha esattamente il problema di Topics — adhoc, che
// macOS 26 rifiuta — quindi spedirne una copia sposterebbe il fallimento,
// non lo toglierebbe: un ripiego che nasconde il sintomo invece di curarlo.
// La cura vera è firmare Topics con un Developer ID (vedi il task nel
// backlog); nel frattempo il fallimento almeno non è più muto, lo racconta
// `status()` qui sotto.
fn helper_path() -> Option<&'static std::path::Path> {
    HELPER
        .get_or_init(|| {
            const CANDIDATES: &[&str] = &[
                "/opt/homebrew/bin/terminal-notifier",
                "/usr/local/bin/terminal-notifier",
            ];
            CANDIDATES
                .iter()
                .map(std::path::Path::new)
                .find(|p| p.exists())
                .map(|p| p.to_path_buf())
        })
        .as_deref()
}

fn post_via_helper(title: &str, body: &str) {
    let Some(bin) = helper_path() else {
        // L'ultimo anello della catena, e finora il più muto: niente
        // autorizzazione E niente carrier = nessun banner, mai, senza che
        // nessuno lo dica. Almeno finisce nel log.
        diag("post_via_helper: nessun carrier — banner NON consegnato");
        return;
    };
    // terminal-notifier parses argv via NSUserDefaults: a value starting
    // with "-" reads as a flag. A leading space defuses it.
    let pad = |s: &str| {
        if s.starts_with('-') {
            format!(" {s}")
        } else {
            s.to_string()
        }
    };
    // Unique -group per banner: terminal-notifier's default group is a
    // CONSTANT ident, so without this each post silently REPLACES the
    // previous notification instead of presenting a new banner.
    let group = format!(
        "topics-notif-{}-{}",
        std::process::id(),
        NOTIF_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    // Hand the child to the reaper: this fires on every session state
    // change, and a dropped-unwaited `Child` is a permanent zombie.
    if let Ok(child) = std::process::Command::new(bin)
        .arg("-title")
        .arg(pad(title))
        .arg("-message")
        .arg(pad(body))
        .arg("-group")
        .arg(group)
        .arg("-activate")
        .arg("io.armonia.topics.tauri")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        super::child_reaper::reap(child);
    }
}

struct DelegateIvars {
    app: tauri::AppHandle,
}

/// È un tasto NOSTRO? macOS riusa `actionIdentifier` anche per il click sul
/// corpo e per lo scarto della notifica (`com.apple.UNNotification…`), e
/// quei due devono restare quello che sono sempre stati.
///
/// Il riconoscimento è per PREFISSO e non per lista esatta: i verbi li
/// decide `shared/notify-actions.ts` e uno nuovo non deve richiedere una
/// modifica al guscio nativo — che è il pezzo che l'utente aggiorna meno
/// spesso (un guscio vecchio con un client nuovo è la forma classica del
/// bug qui). Il gate che conta sta comunque di là: il client esegue solo
/// gli id che sa decodificare.
fn is_our_action(id: &str) -> bool {
    id.starts_with("answer:") || id == "approve" || id == "requeue"
}

/// Una stringa Rust come LETTERALE JavaScript, virgolette comprese.
///
/// Gli id dei tasti portano dentro il testo dell'opzione scritta
/// dall'agente: apici, virgolette, a capo, qualunque cosa. Interpolarli
/// dentro `w.eval` tra apici a mano — com'è per il task id, che però è un
/// UUID passato al setaccio dei caratteri — vorrebbe dire far scrivere JS a
/// un LLM. `serde_json` produce un letterale valido per definizione.
fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "TopicsNotificationDelegate"]
    #[ivars = DelegateIvars]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        /// Without a delegate the framework SUPPRESSES banners while the app is
        /// frontmost. Whether to notify at all is the CLIENT's call
        /// (`decideTerminalBanner` / `notifyEvenWhenFocused`) — by the time the
        /// shell is invoked the answer was already "yes", so always present.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions(
                UNNotificationPresentationOptions::Banner.0
                    | UNNotificationPresentationOptions::List.0,
            ),));
        }

        /// Click on a banner → surface the main window (parity with the old
        /// terminal-notifier `-activate`). Delegate callbacks arrive on a
        /// private queue; window work must hop to the main thread.
        ///
        /// Con un TASTO premuto il giro è un altro: non si apre niente, si
        /// ESEGUE. Chi esegue è il client (`window.__topicsNotificationAction`),
        /// non questo modulo — la chiamata vuole la sessione, i cookie e gli
        /// endpoint della board, cioè tre cose che vivono nel webview e che
        /// riportare qui dentro significherebbe tenerne una seconda copia.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            // A task-bound banner encodes its task id in the request identifier
            // (`topics-task-<id>`, see post()). Read it here (on the delegate
            // queue), then hop to the main thread to surface the window AND open
            // the task in the webview. Charset-gated to UUID-safe chars so the
            // id can be inlined into the eval'd JS with no injection surface.
            let task_id: Option<String> = {
                let ident = response.notification().request().identifier().to_string();
                ident
                    .strip_prefix("topics-task-")
                    .filter(|t| t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                    .map(|t| t.to_string())
            };
            // Il tasto premuto, se è uno dei NOSTRI. macOS usa lo stesso
            // campo anche per il click sul corpo e per lo scarto
            // (`com.apple.UNNotification*ActionIdentifier`): si tiene solo
            // ciò che abbiamo registrato noi, così quei due restano il
            // comportamento di sempre invece di diventare azioni a caso.
            let action_id: Option<String> = {
                let id = response.actionIdentifier().to_string();
                if is_our_action(&id) { Some(id) } else { None }
            };
            let app = self.ivars().app.clone();
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                use tauri::Manager;
                // DUE lookup, e non e' pignoleria: `get_webview_window("main")`
                // passa dal filtro di `webview_windows()` e torna None appena la
                // finestra principale ospita una pane browser (vedi
                // `reload_all_ui_windows` in lib.rs). Con una pane aperta questo
                // intero blocco veniva saltato, quindi CLICCARE UNA NOTIFICA non
                // apriva niente e il tasto di un banner non eseguiva niente — in
                // silenzio, perche' qui non c'e' nessun ramo `else`. Il JS va
                // alla WEBVIEW, l'alzata di finestra alla FINESTRA, e nessuna
                // delle due ricerche e' filtrata.
                let wv = app2.get_webview("main");
                match (&task_id, &action_id) {
                    // Tasto premuto su un banner legato a un task: si
                    // esegue e basta. Niente `ensure_window_visible`:
                    // portare in faccia la finestra vanificherebbe il
                    // senso del tasto, che è NON dover aprire l'app.
                    (Some(tid), Some(aid)) => {
                        if let Some(wv) = &wv {
                            let _ = wv.eval(&format!(
                                "window.__topicsNotificationAction && window.__topicsNotificationAction({}, {});",
                                js_string(tid),
                                js_string(aid),
                            ));
                        }
                    }
                    _ => {
                        if let Some(w) = app2.get_window("main") {
                            super::ensure_window_visible(&w);
                        }
                        if let (Some(wv), Some(tid)) = (&wv, &task_id) {
                            let _ = wv.eval(&format!(
                                "window.__topicsOpenTask && window.__topicsOpenTask('{tid}');"
                            ));
                        }
                    }
                }
            });
            completion.call(());
        }
    }
);

/// Install the delegate + request authorization. Call once from `setup()`.
///
/// The delegate is intentionally leaked: `UNUserNotificationCenter.delegate`
/// is a weak property, so somebody must hold a strong ref for the app's
/// lifetime. Authorization asks for `.alert` only — the completion tone is
/// played client-side (WebAudio), an OS sound would double it. Fire-and-forget:
/// una richiesta fallita vuol dire solo niente banner a nostro nome — si passa
/// dal carrier di ripiego (`post_via_helper`).
///
/// L'esito di questa richiesta NON è lo stato del sistema, e non va scritto
/// come tale: qui si registra solo il `granted`. Chi vuole sapere come stiamo
/// davvero chiede a `refresh_auth_state`. La riga che prometteva «l'app ora
/// compare in Impostazioni di Sistema → Notifiche» è stata tolta perché non è
/// vera: con la richiesta che fallisce (`UNErrorDomain error 1`, lo stato
/// resta `NotDetermined`) Topics in quel pannello non compare affatto —
/// `defaults read com.apple.ncprefs apps` non ne ha traccia.
pub fn install(app: &tauri::AppHandle) {
    if !is_bundled() {
        return;
    }
    let delegate =
        NotificationDelegate::alloc().set_ivars(DelegateIvars { app: app.clone() });
    let delegate: Retained<NotificationDelegate> = unsafe { msg_send![super(delegate), init] };
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
    let done = RcBlock::new(|granted: Bool, error: *mut NSError| {
        let err = if error.is_null() {
            String::from("none")
        } else {
            unsafe { &*error }.localizedDescription().to_string()
        };
        if granted.as_bool() {
            UN_AUTHORIZED.store(true, Ordering::Relaxed);
            AUTH_STATE.store(AUTH_GRANTED, Ordering::Relaxed);
        }
        // Un `granted=false` NON diventa "negato", e prima invece lo
        // diventava. L'esito di `requestAuthorization` è l'esito di UNA
        // richiesta — qui è quasi sempre `UNErrorDomain error 1`, cioè la
        // richiesta stessa non è andata a buon fine — non lo stato del
        // sistema. La sola fonte autorevole è `getNotificationSettings`
        // (`refresh_auth_state`), che su questa macchina risponde
        // `NotDetermined`: mai `Denied`. Scriverlo qui produceva un
        // "denied" inventato che nessuna lettura successiva correggeva più
        // (`refresh_auth_state` non toccava `NotDetermined`), e il pannello
        // finiva per consigliare Impostazioni di Sistema → Notifiche, dove
        // Topics non è mai comparso.
        diag(&format!(
            "requestAuthorization → granted={} error={}",
            granted.as_bool(),
            err
        ));
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert,
        &done,
    );
    // Spara e vai: qui il prompt può essere ancora aperto, non c'è niente
    // da aspettare. La stessa lettura la rifà `status()` quando il pannello
    // la chiede, ed è lì che conta che sia fresca.
    refresh_auth_state(std::time::Duration::ZERO);
    diag(&format!(
        "helper fallback: {}",
        helper_path().map(|p| p.display().to_string()).unwrap_or_else(|| "none".into())
    ));
}

/// Release builds have no logger installed (tauri_plugin_log is debug-only),
/// and the whole failure class here is SILENT drops — so the authorization
/// outcome goes to a plain file the field can always read.
fn diag(line: &str) {
    use std::io::Write;
    let Ok(home) = std::env::var("HOME") else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(format!("{home}/Library/Logs/topics-notifications.log"))
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {line}");
    }
}

static NOTIF_SEQ: AtomicU64 = AtomicU64::new(0);

/// Le categorie ancora registrate, come DATO Rust e non come oggetti ObjC.
///
/// I tasti di un banner vivono in una `UNNotificationCategory`, e le loro
/// etichette sono il testo delle opzioni dell'agente: cioè cambiano a ogni
/// notifica, quindi la categoria non può essere una sola registrata al boot.
/// `setNotificationCategories` però SOSTITUISCE l'intero insieme: registrare
/// solo l'ultima farebbe scadere i tasti delle notifiche ancora appese in
/// Centro Notifiche. Qui si tiene una coda corta e si ri-registra tutta.
///
/// Perché `(String, Vec<(String, String)>)` e non i `Retained<…>` già
/// costruiti: `Retained` non è `Send`, quindi non può stare in uno static
/// condiviso. Ricostruire gli oggetti a ogni post costa qualche allocazione
/// per una cosa che succede quando finisce un task, non in un ciclo.
static CATEGORIES: OnceLock<std::sync::Mutex<std::collections::VecDeque<(String, Vec<(String, String)>)>>> =
    OnceLock::new();

/// Quante categorie si tengono vive. Copre abbondantemente le notifiche
/// ancora appese in Centro Notifiche senza far crescere senza fine un
/// insieme che va ri-registrato per intero a ogni post.
const MAX_LIVE_CATEGORIES: usize = 16;

/// Registra la categoria di QUESTO banner (e ri-registra le precedenti).
/// Torna l'identificatore da mettere sul contenuto.
fn register_category(actions: &[NotifyAction]) -> String {
    let ident = format!(
        "topics-actions-{}-{}",
        std::process::id(),
        NOTIF_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let store = CATEGORIES.get_or_init(|| std::sync::Mutex::new(std::collections::VecDeque::new()));
    let snapshot = {
        let Ok(mut q) = store.lock() else { return ident };
        q.push_back((
            ident.clone(),
            actions.iter().map(|a| (a.id.clone(), a.title.clone())).collect(),
        ));
        while q.len() > MAX_LIVE_CATEGORIES {
            q.pop_front();
        }
        q.iter().cloned().collect::<Vec<_>>()
    };

    let mut categories: Vec<Retained<UNNotificationCategory>> = Vec::with_capacity(snapshot.len());
    for (cat_id, acts) in &snapshot {
        let built: Vec<Retained<UNNotificationAction>> = acts
            .iter()
            .map(|(id, title)| {
                UNNotificationAction::actionWithIdentifier_title_options(
                    &NSString::from_str(id),
                    &NSString::from_str(title),
                    // Nessuna opzione: il tasto NON porta in primo piano
                    // l'app e non richiede lo sblocco. È il punto — premere
                    // "Landa su main" dal banner deve costare un gesto, non
                    // un gesto più una finestra che si apre in faccia.
                    UNNotificationActionOptions::empty(),
                )
            })
            .collect();
        let refs: Vec<&UNNotificationAction> = built.iter().map(|a| &**a).collect();
        categories.push(UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &NSString::from_str(cat_id),
            &NSArray::from_slice(&refs),
            &NSArray::from_slice(&[]),
            UNNotificationCategoryOptions::empty(),
        ));
    }
    let cat_refs: Vec<&UNNotificationCategory> = categories.iter().map(|c| &**c).collect();
    UNUserNotificationCenter::currentNotificationCenter()
        .setNotificationCategories(&NSSet::from_slice(&cat_refs));
    ident
}

/// Post one banner. Unique identifier per request — completion banners must
/// stack in the Notification Center, never coalesce/replace each other.
/// When macOS never authorized the app (unsigned build, see UN_AUTHORIZED),
/// posting as ourselves is a guaranteed silent drop — ride the signed
/// helper instead.
///
/// `actions` sono i tasti. Il ripiego `terminal-notifier` li IGNORA e non è
/// una svista: la 2.0.0 di Homebrew non ha `-actions` (`-execute`/`-open`
/// sono tutto ciò che offre), quindi là un banner resta un link. Meglio un
/// banner senza tasti che un tasto che non esiste.
pub fn post(title: &str, body: &str, task_id: Option<&str>, actions: &[NotifyAction]) {
    if !is_bundled() {
        return;
    }
    if !UN_AUTHORIZED.load(Ordering::Relaxed) {
        post_via_helper(title, body);
        return;
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    if !actions.is_empty() {
        let cat = register_category(actions);
        // Nel log per lo stesso motivo di tutto il resto in questo modulo:
        // un tasto che non compare non ha nessun altro modo di dirlo. Le
        // cause sono almeno tre e nessuna produce un errore — il client non
        // le ha mandate, la categoria non si è registrata, macOS non
        // disegna i bottoni con lo stile "banner". Qui si legge la prima.
        diag(&format!(
            "post: category={cat} actions=[{}]",
            actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>().join(", ")
        ));
        content.setCategoryIdentifier(&NSString::from_str(&cat));
    }
    // The task id (when the banner is task-bound) rides in the request
    // IDENTIFIER — a plain string we read back verbatim from the click
    // response in the delegate (no NSDictionary/userInfo plumbing). A stable
    // `topics-task-<id>` also means a task's newer banner replaces its older.
    let id = match task_id {
        Some(t) => format!("topics-task-{t}"),
        None => format!(
            "topics-notif-{}-{}",
            std::process::id(),
            NOTIF_SEQ.fetch_add(1, Ordering::Relaxed)
        ),
    };
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&id),
        &content,
        None,
    );
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, None);
}
