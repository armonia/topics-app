//! OS integration commands: Focus/Do-Not-Disturb state, notifications, open
//! external URLs, clipboard image, tray status and the dock badge.
//! Moved out of lib.rs verbatim.

use super::*;

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
pub(crate) fn focus_status() -> serde_json::Value {
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
pub(crate) fn spawn_focus_watcher(app: tauri::AppHandle) {
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
                        if let Some(w) = app.get_webview("main") {
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
///
/// `task_id` è il nome STORICO del campo, e resta tale apposta: quello che ci
/// passa è un token opaco che dice dove porta il click (un task, oppure un
/// topic di chat), composto e riletto dal client
/// (client/src/lib/notify/notifyTarget.ts). Ribattezzarlo spegnerebbe il click
/// su tutti i gusci già installati, che quel nome lo leggono così.
#[tauri::command]
pub(crate) fn notify(
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
pub(crate) fn notification_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        macos_status_json(&macos_notifications::status())
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

/// The wire shape of a macOS notification status, shared by
/// `notification_status` and `request_notification_permission` so the client
/// redraws the same panel from either answer.
#[cfg(target_os = "macos")]
pub(crate) fn macos_status_json(s: &macos_notifications::NotificationStatus) -> serde_json::Value {
    serde_json::json!({
        "platform": "macos",
        "bundled": s.bundled,
        "authorized": s.authorized,
        "authState": s.auth_state,
        "helper": s.helper,
        "logPath": s.log_path,
    })
}

/// Act on the notification permission from Settings, then report the fresh
/// state in the SAME shape as `notification_status`.
///
/// `notification_status` only tells the truth; this one lets the person do
/// something about it with one button. The decision (ask, open System
/// Settings, or nothing) lives in `macos_notifications::request_permission`
/// and is logged branch by branch. Off macOS the plugin path has no
/// permission to act on, so this is the plain status.
///
/// `(async)` for the same reason as `notification_status`: it waits for the
/// system prompt's answer, and that wait must never sit on the main thread.
#[tauri::command(async)]
pub(crate) fn request_notification_permission() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        macos_status_json(&macos_notifications::request_permission())
    }
    #[cfg(not(target_os = "macos"))]
    {
        notification_status()
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
pub(crate) fn validate_external_url(url: &str) -> Result<(), String> {
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

/// Launcher program and arguments that hand `url` to the OS default handler.
/// Pure so the construction is testable on every platform. On Windows this
/// must never go through `cmd /C start`: Rust only quotes an argument that
/// contains a space or tab, so `&`, `|`, `^` and `%VAR%` in a URL would reach
/// cmd.exe as metacharacters and run a second command. `rundll32` receives
/// the URL as data and has no shell grammar.
pub(crate) fn external_launcher(url: &str) -> (&'static str, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        (
            "rundll32",
            vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
        )
    }
    #[cfg(target_os = "macos")]
    {
        ("/usr/bin/open", vec![url.to_string()])
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        ("xdg-open", vec![url.to_string()])
    }
}

#[tauri::command]
pub(crate) fn open_external(url: String) -> Result<(), String> {
    validate_external_url(&url)?;

    let (program, args) = external_launcher(&url);
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);

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
pub(crate) fn set_clipboard_image(bytes: Vec<u8>) -> Result<(), String> {
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
#[derive(Deserialize, Clone)]
pub(crate) struct StatusItem {
    pub(crate) id: String,
    pub(crate) title: String,
    /// Board the row comes from. Empty for a chat row (topics have no board);
    /// on a task row it is what tells two same-named cards apart.
    #[serde(default, rename = "projectId")]
    pub(crate) project_id: String,
}

/// One board column in the tray menu: a status, how many tasks it holds and the
/// first rows, which become a submenu. WHAT goes in — which statuses, in what
/// order, how many rows, how a long title is cut — is decided and unit-tested in
/// `shared/tray-board.ts`; this side only draws it. `count` is the WHOLE column,
/// `rows` the ones that fit: the difference is what the submenu declares as
/// "altri N", instead of letting them vanish.
#[derive(Deserialize, Clone)]
pub(crate) struct StatusGroup {
    /// Kanban status id: picks the label and builds the row id that reopens the board.
    pub(crate) status: String,
    pub(crate) count: u32,
    pub(crate) rows: Vec<StatusItem>,
}

/// Come si chiama una colonna nel menu. Le stesse parole delle colonne della
/// kanban (`STATUS_LABEL`): la tray non introduce un secondo vocabolario per le
/// stesse cose. Uno stato che il guscio non conosce si scrive com'è arrivato,
/// che è meglio di una riga muta se un giorno ne nasce un altro.
#[cfg(target_os = "macos")]
pub(crate) fn tray_status_label(status: &str) -> &str {
    match status {
        "review" => "Review",
        // The lit cards by why they wait (`TRAY_LIT_REASONS`, shared/tray-board.ts).
        "parked" => "Parked",
        "question" => "Questions",
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
pub(crate) fn tray_dispatch(app: &tauri::AppHandle, event: &str, detail: Option<(&str, &str)>) {
    use tauri::Manager;
    // Due lookup e non uno: alzare la finestra e' un'operazione di FINESTRA,
    // valutare il JS e' della WEBVIEW, e `get_webview_window` — che le univa —
    // torna None appena la main ospita una pane browser. Con una pane aperta la
    // tray smetteva di consegnare i suoi eventi, in silenzio.
    let Some(w) = app.get_window("main") else { return };
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
    if let Some(wv) = app.get_webview("main") { let _ = wv.eval(&js); }
}

/// «Apri con Topics»: il path va in coda, poi si sveglia la UI.
///
/// L'evento NON porta il path. Lo porta la coda, e il client la svuota con
/// `take_os_open_paths`: così il path arrivato PRIMA che la webview esistesse e
/// quello arrivato a app viva prendono la stessa identica strada, e il caso
/// "lancio a freddo" non ha bisogno di un secondo pezzo di codice che poi
/// nessuno prova. Se la finestra non c'è ancora, la coda regge da sola: il
/// client la svuota al mount.
///
/// La sveglia passa da `tray_dispatch` perché è già la porta che porta la
/// finestra a galla prima di consegnare: aprire un file in una finestra
/// nascosta sarebbe aprire una cosa che nessuno vede.
pub(crate) fn deliver_os_open_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    if !os_open::queue_os_open_paths(paths) {
        return;
    }
    tray_dispatch(app, "topics:os-open-path", None);
}

/// Il nome leggibile dentro l'id di un progetto: gli id nascono `<nome>-<hash>`
/// e in un menu la coda esadecimale è rumore. Si toglie SOLO se ha la forma di
/// un suffisso generato (corto e alfanumerico), così un progetto che si chiama
/// davvero "topics-2" non perde un pezzo di nome.
#[cfg(target_os = "macos")]
pub(crate) fn project_slug(project_id: &str) -> &str {
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
pub(crate) fn tray_label(title: &str) -> String {
    if title.chars().count() > 48 {
        format!("{}…", title.chars().take(47).collect::<String>())
    } else if title.is_empty() {
        "(senza titolo)".to_string()
    } else {
        title.to_string()
    }
}

/// Does a `set_app_status` from the window with this label reach the Dock and
/// the tray? Only from the main window (ATTN-08): see `set_app_status`.
pub(crate) fn accepts_app_status_from(label: &str) -> bool {
    label == "main"
}

#[cfg(test)]
mod app_status_caller_tests {
    use super::accepts_app_status_from;

    #[test]
    fn only_the_main_window_writes_the_dock() {
        assert!(accepts_app_status_from("main"));
        assert!(!accepts_app_status_from("detach-1a2b"));
        assert!(!accepts_app_status_from("space-alpha"));
        assert!(!accepts_app_status_from(""));
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
///
/// ONE HAND WRITES IT: only the main window (notifications-redesign, ATTN-08).
/// Every window computes the same number from the same attention frames, but
/// two writers made the Dock and the tray take the value of whichever wrote
/// last (WIN-1). A call from any other window (a group window, a pop-out) is
/// dropped here, whatever its client does.
#[tauri::command]
pub(crate) fn set_app_status(
    window: tauri::Window,
    app: tauri::AppHandle,
    count: u32,
    items: Vec<StatusItem>,
    groups: Option<Vec<StatusGroup>>,
    machines: Option<Vec<tray_machines::StatusMachine>>,
) {
    if !accepts_app_status_from(window.label()) {
        return;
    }
    #[cfg(target_os = "macos")]
    // no_abort: run_on_main_thread + tray/menu mutations go through the
    // window dispatcher — same poisoned-mutex SIGABRT class (see no_abort
    // doc). Fires on every attention-status change.
    let _ = no_abort("set_app_status", || {
        use tauri::Manager;
        let groups = groups.unwrap_or_default();
        let machines = machines.unwrap_or_default();
        // The dock-tile badge is an AppKit UI mutation — must run on the main thread.
        if let Some(win) = app.get_window("main") {
            let _ = win.run_on_main_thread(move || set_dock_badge(count));
        }
        // Menu-bar tray: glyph + tooltip + the clickable attention rows.
        // Retrieved by the id assigned at build time (`TrayIconBuilder::with_id`).
        if let Some(tray) = app.tray_by_id("main") {
            // Keep what the Topics rows need, then draw the whole menu from one place:
            // the service poller redraws it too, and must not lose these rows.
            if let Ok(mut st) = TRAY_STATUS.lock() {
                *st = (items.clone(), groups.clone(), machines.clone());
            }
            rebuild_tray_menu(&app);

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
    let _ = (app, count, items, groups, machines);
}

/// Last attention rows and board columns, kept so the service poller can redraw the
/// menu without waiting for the next client status push.
#[cfg(target_os = "macos")]
static TRAY_STATUS: std::sync::Mutex<(Vec<StatusItem>, Vec<StatusGroup>, Vec<tray_machines::StatusMachine>)> = std::sync::Mutex::new((Vec::new(), Vec::new(), Vec::new()));
/// Latest hub sections (quotas, machines, processes, projects, brake, backup).
#[cfg(target_os = "macos")]
static HUB_MENU: std::sync::Mutex<Vec<tray_menu::Node>> = std::sync::Mutex::new(Vec::new());
/// The usage service answered at least once since launch.
#[cfg(target_os = "macos")]
static HUB_EVER_ANSWERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Latest census body, for the safe close of one unit.
#[cfg(target_os = "macos")]
static HUB_PROCS: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(target_os = "macos")]
fn hub_node_to_menu<'m>(
    app: &tauri::AppHandle,
    nodes: &[tray_menu::Node],
    mut mb: tauri::menu::MenuBuilder<'m, tauri::Wry, tauri::AppHandle>,
) -> tauri::menu::MenuBuilder<'m, tauri::Wry, tauri::AppHandle> {
    use tauri::menu::MenuItemBuilder;
    for n in nodes {
        match n {
            tray_menu::Node::Sep => mb = mb.separator(),
            tray_menu::Node::Item { id, label, enabled } => {
                // A disabled note has no id of its own: a unique one keeps the menu valid.
                let id = if id.is_empty() { format!("note:{label}") } else { id.clone() };
                if let Ok(it) = MenuItemBuilder::with_id(id, tray_label(label)).enabled(*enabled).build(app) {
                    mb = mb.item(&it);
                }
            }
            tray_menu::Node::Sub { label, children } => {
                if let Ok(sub) = hub_submenu(app, label, children) {
                    mb = mb.item(&sub);
                }
            }
        }
    }
    mb
}

#[cfg(target_os = "macos")]
fn hub_submenu(
    app: &tauri::AppHandle,
    label: &str,
    children: &[tray_menu::Node],
) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::{MenuItemBuilder, SubmenuBuilder};
    let mut sb = SubmenuBuilder::new(app, tray_label(label));
    for c in children {
        match c {
            tray_menu::Node::Sep => sb = sb.separator(),
            tray_menu::Node::Item { id, label, enabled } => {
                let id = if id.is_empty() { format!("note:{label}") } else { id.clone() };
                if let Ok(it) = MenuItemBuilder::with_id(id, tray_label(label)).enabled(*enabled).build(app) {
                    sb = sb.item(&it);
                }
            }
            tray_menu::Node::Sub { label, children } => {
                if let Ok(s2) = hub_submenu(app, label, children) {
                    sb = sb.item(&s2);
                }
            }
        }
    }
    sb.build()
}

/// The whole tray menu: attention rows, hub sections, board, then the fixed actions.
#[cfg(target_os = "macos")]
pub(crate) fn rebuild_tray_menu(app: &tauri::AppHandle) {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let (items, groups, machines) = TRAY_STATUS.lock().map(|g| g.clone()).unwrap_or_default();
    let hub = HUB_MENU.lock().map(|g| g.clone()).unwrap_or_default();
    let Some(tray) = app.tray_by_id("main") else { return };
            // Rebuild the menu: one `nav:<topicId>` row per attention chat, then a
            // separator, then the static Show/Quit. The tray's `on_menu_event`
            // (installed at build) routes `nav:` clicks — it fires for whatever
            // menu is currently set, so dynamically-swapped rows still navigate.
            let mut mb = MenuBuilder::new(app);
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
                        app,
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
                        .build(app)
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
            // Every machine Topics knows: a submenu with its gauges, the provider
            // extras as disabled rows and the history line as the icon of the
            // first one. The client wrote the words; this side only draws.
            if !machines.is_empty() {
                for m in &machines {
                    let mut sb = SubmenuBuilder::new(app, tray_label(&m.title));
                    if let Ok(head) = tauri::menu::IconMenuItemBuilder::new(tray_label(&m.title))
                        .id(format!("machine-head:{}", m.id))
                        .icon(tauri::image::Image::new_owned(
                            tray_machines::render_spark(&m.spark),
                            tray_machines::SPARK_W,
                            tray_machines::SPARK_H,
                        ))
                        .enabled(false)
                        .build(app)
                    {
                        sb = sb.item(&head);
                    }
                    for (i, line) in m.lines.iter().enumerate() {
                        if let Ok(row) = MenuItemBuilder::with_id(format!("machine-line:{}:{i}", m.id), tray_label(line))
                            .enabled(false)
                            .build(app)
                        {
                            sb = sb.item(&row);
                        }
                    }
                    sb = sb.separator().text(format!("machine-open:{}", m.id), "Apri Processi");
                    if let Ok(sub) = sb.build() {
                        mb = mb.item(&sub);
                    }
                }
                mb = mb.separator();
            }
            if !hub.is_empty() {
                mb = hub_node_to_menu(app, &hub, mb);
                mb = mb.separator();
            }
            // Le azioni che il menu si era perso per strada: la app è cresciuta
            // (chat, board, aggiornatore) e la tray era rimasta a Mostra/Esci,
            // cioè non sapeva far FARE niente. Sono le stesse porte del menu
            // nativo e della sidebar, non gesti nuovi.
            mb = mb
                .text("tray-new-chat", "Nuova chat")
                .text("tray-check-updates", "Controlla aggiornamenti")
                .text("tray-refresh", "Aggiorna")
                .separator()
                .text("tray-show", "Apri Topics")
                .text("tray-quit", "Esci");
            if let Ok(menu) = mb.build() {
                let _ = tray.set_menu(Some(menu));
            }
}

/// One hub poll: fetch every endpoint, rebuild the hub sections, redraw the menu.
#[cfg(target_os = "macos")]
pub(crate) fn refresh_hub_menu(app: &tauri::AppHandle) {
    let base = tray_quota::hub_base();
    let snap = tray_menu::Snapshot::fetch(&base, tray_menu::backup_cache_path().as_deref());
    let prefs = tray_menu::prefs_path().map(|p| tray_menu::load_prefs(&p)).unwrap_or_default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // No hub section (not even an «offline» row) until the service has answered once.
    let ever = HUB_EVER_ANSWERED.load(std::sync::atomic::Ordering::Relaxed) || snap.service_up();
    HUB_EVER_ANSWERED.store(ever, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut g) = HUB_PROCS.lock() {
        *g = snap.procs.clone();
    }
    if let Ok(mut g) = HUB_MENU.lock() {
        *g = tray_menu::build_menu(&snap, prefs, now, ever);
    }
    rebuild_tray_menu(app);
}

/// A click on a hub row: one action, run off the UI thread; the menu is redrawn after.
#[cfg(target_os = "macos")]
pub(crate) fn run_hub_action(app: &tauri::AppHandle, id: &str) {
    let procs = HUB_PROCS.lock().ok().and_then(|g| g.clone());
    let Some(action) = tray_menu::action_for(id, &procs) else { return };
    let app = app.clone();
    let _ = std::thread::Builder::new().name("tray-action".into()).spawn(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        match action {
            tray_menu::Action::Http { method, path, body } => {
                let _ = tray_menu::http_send(&tray_quota::hub_base(), method, &path, body.as_ref());
            }
            tray_menu::Action::ClosePids { name, unit, pids } => {
                let ok = app
                    .dialog()
                    .message(format!("Chiudere {name}? I processi ricevono una richiesta di chiusura e possono salvare."))
                    .title("Chiudi")
                    .buttons(MessageDialogButtons::OkCancelCustom("Chiudi".into(), "Annulla".into()))
                    .blocking_show();
                // The census shown in the menu may be a minute old and the dialog took longer:
                // the service is asked for a new one (`fresh=1`, otherwise it may answer from its
                // cache) and a census older than 90 s is refused before anything is signalled.
                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
                tray_menu::close_confirmed(
                    ok,
                    now_ms,
                    || tray_quota::http_get(&tray_quota::hub_base(), "/api/mac/procs?fresh=1"),
                    unit.as_deref(),
                    &pids,
                    tray_menu::terminate,
                );
            }
            tray_menu::Action::OpenUrl(url) => {
                let _ = std::process::Command::new("open").arg(&url).status();
                return;
            }
            tray_menu::Action::TogglePref(k) => {
                if let Some(p) = tray_menu::prefs_path() {
                    tray_menu::toggle_pref(&p, &k);
                }
            }
            tray_menu::Action::Open(place) => {
                tray_dispatch(&app, "topics:tray-open-hub", Some(("place", place.as_str())));
                return;
            }
        }
        refresh_hub_menu(&app);
    });
}

/// Set (or clear, when 0) the macOS dock-icon badge label via the shared
/// `NSApplication` dock tile. AppKit UI call — the caller runs it on the main
/// thread. Electron's `app.dock.setBadge` equivalent.
#[cfg(target_os = "macos")]
pub(crate) fn set_dock_badge(count: u32) {
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
