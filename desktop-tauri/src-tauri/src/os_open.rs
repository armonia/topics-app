//! I path che l'OS consegna al guscio: raccolta, coda, consegna.
//!
//! Il sistema operativo ha tre modi diversi di dire «apri questo», e Topics
//! deve sopravvivere a tutti e tre:
//!
//!  1. `argv` del PRIMO lancio. Windows e Linux passano il path come argomento
//!     quando l'app non era ancora viva; su macOS capita col `open -a`.
//!  2. `argv` della SECONDA istanza. È il caso che rende l'apertura istantanea:
//!     l'app è già viva, il plugin single-instance intercetta il lancio
//!     duplicato e ci consegna i suoi argomenti invece di far partire un
//!     secondo processo (che, tra l'altro, non riuscirebbe nemmeno a prendere
//!     la porta).
//!  3. `RunEvent::Opened { urls }`. È l'unico canale del Finder su macOS:
//!     «Apri con» e il trascinamento sull'icona NON passano da argv, arrivano
//!     come Apple Event e Tauri li rigira qui come `file://`.
//!
//! LA CODA È IL PUNTO. Nel caso 1 il path arriva PRIMA che la webview esista:
//! consegnarlo subito vorrebbe dire dispatchare un evento DOM dentro una pagina
//! che non c'è, cioè perderlo. Quindi il guscio non consegna mai direttamente:
//! accoda sempre, e sveglia il client. Il client, appena monta (e a ogni
//! sveglia), svuota la coda con `take_os_open_paths`. Una porta sola, e il caso
//! «lancio a freddo» smette di essere speciale.
//!
//! Qui dentro non si decide NIENTE su cosa aprire: la regola path → tab vive in
//! `shared/os-open-path.ts` ed è una sola per tutta l'app. Questo modulo è un
//! trasporto.

use std::sync::Mutex;

/// I path in attesa che la UI li venga a prendere.
static PENDING_OS_OPEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Tetto alla coda: qualcuno che seleziona mille file e preme Invio non deve
/// poter far crescere questo vettore senza fine mentre la UI non c'è ancora.
const MAX_PENDING: usize = 32;

/// Un argomento della riga di comando è un path da aprire?
///
/// Funzione pura, perché è la parte che sbaglia: `argv[0]` è l'eseguibile, i
/// flag del guscio non sono file, e su macOS il Launch Services aggiunge
/// `-psn_0_123456` (il "process serial number") a ogni app avviata dal Finder.
/// Scambiarlo per un path aprirebbe una cartella inesistente a ogni doppio
/// click sull'icona.
pub fn is_open_path_arg(arg: &str) -> bool {
    if arg.is_empty() {
        return false;
    }
    if arg.starts_with('-') {
        return false;
    }
    // I deep link `topics://…` hanno già il loro canale; qui passano solo i
    // path locali, con o senza schema `file:`.
    if arg.starts_with("file://") {
        return true;
    }
    if arg.contains("://") {
        return false;
    }
    // Solo path ASSOLUTI: un relativo dipende dalla cwd del processo che ha
    // lanciato, e indovinarla aprirebbe la cartella sbagliata.
    let bytes = arg.as_bytes();
    let windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    arg.starts_with('/') || arg.starts_with("\\\\") || windows_drive
}

/// I path da aprire dentro una riga di comando, `argv[0]` escluso.
pub fn open_paths_from_args<S: AsRef<str>>(args: &[S]) -> Vec<String> {
    args.iter()
        .skip(1)
        .map(|a| a.as_ref())
        .filter(|a| is_open_path_arg(a))
        .map(|a| a.to_string())
        .collect()
}

/// Mette i path in coda. Torna `true` se qualcosa è entrato davvero: chi chiama
/// usa la risposta per decidere se vale la pena svegliare la UI.
pub fn queue_os_open_paths(paths: Vec<String>) -> bool {
    if paths.is_empty() {
        return false;
    }
    let Ok(mut q) = PENDING_OS_OPEN.lock() else {
        // Mutex avvelenato da un panic altrove: perdere l'apertura è meglio che
        // portarsi dietro un unwrap che fa abortire il processo.
        return false;
    };
    let mut queued = false;
    for p in paths {
        if q.len() >= MAX_PENDING {
            break;
        }
        // Doppio invio dello stesso path (argv + Apple Event allo stesso
        // lancio): una tab sola, non due.
        if q.iter().any(|e| e == &p) {
            continue;
        }
        q.push(p);
        queued = true;
    }
    queued
}

/// La UI ritira la coda e la svuota. Ritirare È consumare: se il client
/// fallisce ad aprire, il path non torna indietro da solo.
#[tauri::command]
pub fn take_os_open_paths() -> Vec<String> {
    match PENDING_OS_OPEN.lock() {
        Ok(mut q) => std::mem::take(&mut *q),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_argv0_flags_and_launch_services_noise() {
        let args = vec![
            "/Applications/Topics.app/Contents/MacOS/Topics",
            "-psn_0_123456",
            "--some-flag",
            "/Users/x/progetto",
        ];
        assert_eq!(open_paths_from_args(&args), vec!["/Users/x/progetto"]);
    }

    #[test]
    fn keeps_file_urls_and_windows_paths_drops_relatives_and_deep_links() {
        assert!(is_open_path_arg("file:///Users/x/a.md"));
        assert!(is_open_path_arg("C:\\Users\\x\\a.md"));
        assert!(is_open_path_arg("\\\\server\\share\\a.md"));
        assert!(!is_open_path_arg("src/a.md"));
        assert!(!is_open_path_arg("topics://tab/chat/abc"));
        assert!(!is_open_path_arg(""));
    }

    /// Coda e tetto in UN test solo, di proposito: `PENDING_OS_OPEN` è statica e
    /// i test di Rust girano in parallelo sullo stesso processo. Due test che la
    /// toccano sarebbero verdi finché lo scheduler è gentile.
    #[test]
    fn queue_dedups_empties_and_caps() {
        let _ = take_os_open_paths();
        assert!(queue_os_open_paths(vec!["/tmp/a".into(), "/tmp/a".into()]));
        assert!(!queue_os_open_paths(vec!["/tmp/a".into()]));
        assert_eq!(take_os_open_paths(), vec!["/tmp/a".to_string()]);
        assert!(take_os_open_paths().is_empty());

        let many: Vec<String> = (0..(MAX_PENDING + 10)).map(|i| format!("/tmp/{i}")).collect();
        queue_os_open_paths(many);
        assert_eq!(take_os_open_paths().len(), MAX_PENDING);
    }
}
