//! Performance metrics for the status bar: per-process CPU and memory,
//! per-webview usage and the sampling caches. Moved out of lib.rs verbatim.

use super::*;

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
pub(crate) static WEBVIEW_CONTENT_PID: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, i32>>,
> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
pub(crate) fn webview_content_pid_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, i32>> {
    WEBVIEW_CONTENT_PID.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
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
pub(crate) fn refresh_webview_content_pids(app: &tauri::AppHandle) {
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
///
/// The CPU figure comes from `cpu_by_pid`, the ONE read of each pid that the
/// sample loop already took (`sample_cpu`). Reading the counter a second time
/// here measured the ~100 us since the first read: 0.0 in 32 of 40 samples and
/// 61-468% in the others on a pane burning a steady 18.6% (15/09). A WebContent
/// the sample did not cover gets `None`, never zero.
#[cfg(target_os = "macos")]
pub(crate) fn collect_webview_usage(
    live: &std::collections::HashSet<i32>,
    cpu_by_pid: &std::collections::HashMap<i32, f32>,
) -> Vec<WebviewUsage> {
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
            cpu_percent: cpu_by_pid.get(&pid).copied(),
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
pub(crate) unsafe fn web_process_identifier(view: *mut crate::mac::Object) -> i32 {
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
pub(crate) fn forget_webview_content_pid(label: &str) {
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
pub(crate) fn wkwebview_can_close() -> bool {
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
pub(crate) unsafe fn close_web_view(view: *mut crate::mac::Object) -> bool {
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
pub(crate) struct PerfMetrics {
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
    /// Physical RAM of the machine, in MB (`None` if the OS did not say). The
    /// denominator a person understands: «this tab takes 4% of the Mac's
    /// memory» reads without knowing what a core or a footprint is.
    system_mem_mb: Option<f64>,
}

/// Quanto consuma UNA webview, con il label che la lega alla sua pane.
#[derive(Serialize, Clone)]
pub(crate) struct WebviewUsage {
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
pub(crate) struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

#[cfg(target_os = "macos")]
pub(crate) static PERF_TIMEBASE: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();

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
pub(crate) fn mach_ticks_to_ns(ticks: u64) -> u64 {
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
pub(crate) const PERF_PID_SET_TTL: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "macos")]
pub(crate) static PERF_PIDS: std::sync::OnceLock<
    std::sync::Mutex<(Option<std::time::Instant>, Vec<i32>)>,
> = std::sync::OnceLock::new();

/// Every pid macOS holds THIS process responsible for — the shell plus its
/// reparented WKWebView XPC services — cached for `PERF_PID_SET_TTL`.
#[cfg(target_os = "macos")]
pub(crate) fn responsible_pids(own: i32) -> Vec<i32> {
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
pub(crate) fn scan_responsible_pids(own: i32) -> Vec<i32> {
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
pub(crate) fn proc_memory(pid: i32) -> Option<(u64, u64)> {
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
pub(crate) fn proc_cpu_ns(pid: i32) -> Option<u64> {
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
pub(crate) static PERF_CPU_PREV: std::sync::OnceLock<
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
pub(crate) fn proc_cpu_percent(pid: i32, live: &std::collections::HashSet<i32>) -> Option<f32> {
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
pub(crate) static PERF_SYS: std::sync::OnceLock<std::sync::Mutex<sysinfo::System>> = std::sync::OnceLock::new();

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
pub(crate) const PERF_SAMPLE_WINDOW: std::time::Duration = std::time::Duration::from_millis(2000);

/// L'ultima misura, con l'istante in cui e' stata presa. Serve a servire i
/// lettori che arrivano DENTRO la finestra senza far ripartire il cronometro.
pub(crate) static PERF_LAST: std::sync::OnceLock<std::sync::Mutex<Option<(std::time::Instant, PerfMetrics)>>> =
    std::sync::OnceLock::new();

/// Which bucket a process falls in. The same partition drives both the CPU and
/// the memory rows of the dropdown, so the two describe the same thing.
pub(crate) enum PerfBucket {
    Renderer,
    Gpu,
    Other,
}

pub(crate) fn perf_bucket(name: &str) -> PerfBucket {
    if name.contains("WebContent") {
        PerfBucket::Renderer
    } else if name.contains("GPU") {
        PerfBucket::Gpu
    } else {
        PerfBucket::Other
    }
}

/// One CPU sample of a pid set: the app totals, the renderer/GPU split, and the
/// per-pid figure every other consumer of the same sample must reuse.
pub(crate) struct CpuSample {
    total: f32,
    renderer: f32,
    gpu: f32,
    /// Pids that produced a delta, out of `pids` found alive.
    sampled: u32,
    pids: u32,
    buckets: std::collections::HashMap<i32, PerfBucket>,
    /// Only the pids that produced `Some`: absent means "not measured".
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    by_pid: std::collections::HashMap<i32, f32>,
}

/// Read each pid's CPU counter exactly once. A second read of the same pid in
/// the same `perf_metrics` call measures the microseconds since the first one,
/// which is how the per-webview figure used to be noise (see
/// `collect_webview_usage`).
pub(crate) fn sample_cpu(sys: &mut sysinfo::System, pids: &[i32]) -> CpuSample {
    let sysinfo_pids: Vec<sysinfo::Pid> = pids
        .iter()
        .map(|&p| sysinfo::Pid::from_u32(p as u32))
        .collect();
    let mut out = CpuSample {
        total: 0.0,
        renderer: 0.0,
        gpu: 0.0,
        sampled: 0,
        pids: 0,
        buckets: std::collections::HashMap::new(),
        by_pid: std::collections::HashMap::new(),
    };
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&sysinfo_pids), true);
    // L'insieme vivo, per potare i campioni dei pid morti.
    #[cfg(target_os = "macos")]
    let live: std::collections::HashSet<i32> = pids.iter().copied().collect();
    for (raw, spid) in pids.iter().zip(sysinfo_pids.iter()) {
        let Some(p) = sys.process(*spid) else { continue };
        out.pids += 1;
        // sysinfo resta per il NOME (che decide il bucket, e con esso lo split
        // renderer/gpu anche della memoria) e per il ramo non-macOS. Per la
        // CPU, su macOS, il delta ce lo calcoliamo noi: vedi `PERF_CPU_PREV`.
        #[cfg(target_os = "macos")]
        let sample = proc_cpu_percent(*raw, &live);
        #[cfg(not(target_os = "macos"))]
        let sample = Some(p.cpu_usage());
        // Il bucket si calcola SEMPRE: decide anche lo split della memoria,
        // che non dipende dall'avere una baseline di CPU.
        let b = perf_bucket(&p.name().to_string_lossy());
        // Un pid senza campione precedente NON contribuisce zero: non
        // contribuisce affatto, e `sampled` dice quanti hanno contato.
        if let Some(cpu) = sample {
            out.sampled += 1;
            out.total += cpu;
            match b {
                PerfBucket::Renderer => out.renderer += cpu,
                PerfBucket::Gpu => out.gpu += cpu,
                PerfBucket::Other => {}
            }
            out.by_pid.insert(*raw, cpu);
        }
        out.buckets.insert(*raw, b);
    }
    out
}

/// Physical RAM in MB, read once: it does not change while the app runs.
pub(crate) fn system_mem_mb() -> Option<f64> {
    static TOTAL: std::sync::OnceLock<Option<f64>> = std::sync::OnceLock::new();
    *TOTAL.get_or_init(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let bytes = sys.total_memory();
        if bytes == 0 { None } else { Some(bytes as f64 / 1_048_576.0) }
    })
}

#[tauri::command]
pub(crate) fn perf_metrics(app: tauri::AppHandle) -> PerfMetrics {
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
                system_mem_mb: system_mem_mb(),
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

    // CPU still comes from sysinfo's process table for the NAME (the bucket) and
    // off macOS; the per-pid delta on macOS is ours (`PERF_CPU_PREV`). Refreshing
    // only OUR pids keeps this off the full process table.
    let cpu = {
        let mut sys = sys_mutex.lock().unwrap_or_else(|e| e.into_inner());
        sample_cpu(&mut sys, &pids)
    };
    let buckets = &cpu.buckets;

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
            Some(PerfBucket::Renderer) => renderer += pf,
            Some(PerfBucket::Gpu) => gpu += pf,
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
        cpu_percent: if cpu.sampled == 0 { None } else { Some(cpu.total) },
        cpu_renderer: cpu.renderer,
        cpu_gpu: cpu.gpu,
        cpu_sampled: cpu.sampled,
        cpu_pids: cpu.pids,
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
                let out = collect_webview_usage(&alive, &cpu.by_pid);
                refresh_webview_content_pids(&app);
                out
            }
            // WebView2: every pane has its own environment, so its processes
            // are its own. Same one-read-per-pid rule, same "reads for the next
            // round" pid refresh.
            #[cfg(target_os = "windows")]
            {
                let out = pane_process_win::collect_webview_usage();
                pane_process_win::refresh_webview_process_ids(&app);
                out
            }
            #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
            {
                Vec::new()
            }
        },
        system_mem_mb: system_mem_mb(),
    };
    // Pubblica la misura: chi legge nei prossimi PERF_SAMPLE_WINDOW riceve
    // questa, invece di far ripartire il cronometro e misurare la CPU su pochi
    // millisecondi. E' il pezzo che rende la finestra deterministica.
    if let Ok(mut g) = PERF_LAST.get_or_init(|| std::sync::Mutex::new(None)).lock() {
        *g = Some((std::time::Instant::now(), out.clone()));
    }
    out
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
    use super::{collect_webview_usage, mach_ticks_to_ns, proc_cpu_ns, proc_cpu_percent, sample_cpu, webview_content_pid_map};

    /// Serialises the tests that write `PERF_CPU_PREV`. `proc_cpu_percent` prunes
    /// that map to the `live` set of its caller, so two of these tests running in
    /// parallel erase each other's baselines and read `None` where a number is due.
    static PERF_CPU_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A child that burns a core until the test ends, whatever way it ends.
    struct BusyChild(std::process::Child);
    impl Drop for BusyChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// The per-webview CPU is the SAME number the sample took for that pid.
    ///
    /// Red on the code before this change: `collect_webview_usage` read the
    /// counter a second time right after `perf_metrics` had read it, so the row
    /// described the ~100 us between two syscalls (0 or hundreds of percent),
    /// never the 500 ms window the sample covers.
    #[test]
    fn webview_cpu_comes_from_the_sample() {
        // Both maps this test writes are shared: the CPU baselines, and the pid
        // map that `webview_usage_tests` clears on every case.
        let _serial = PERF_CPU_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _map = super::webview_usage_tests::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let child = BusyChild(
            std::process::Command::new("sh")
                .args(["-c", "while :; do :; done"])
                .spawn()
                .expect("spawn a busy child"),
        );
        let pid = child.0.id() as i32;
        let label = "browserpane-cpu-sample-test".to_string();
        webview_content_pid_map()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(label.clone(), pid);

        let mut sys = sysinfo::System::new();
        let _baseline = sample_cpu(&mut sys, &[pid]);
        std::thread::sleep(std::time::Duration::from_millis(500));
        let sample = sample_cpu(&mut sys, &[pid]);
        let live: std::collections::HashSet<i32> = [pid].into_iter().collect();
        let rows = collect_webview_usage(&live, &sample.by_pid);
        webview_content_pid_map()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&label);

        let sampled = *sample.by_pid.get(&pid).expect("the second sample has a delta for the child");
        let row = rows.iter().find(|r| r.label == label).expect("a row for the mapped webview");
        assert_eq!(row.cpu_percent, Some(sampled), "the row must reuse the sample's one read");
        assert!(sampled >= 20.0, "a busy loop over 500 ms reads {sampled}% of a core");
        drop(child);
    }

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
        let _serial = PERF_CPU_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
    pub(super) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        let out = collect_webview_usage(&live, &Default::default());
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
        let a: Vec<String> = collect_webview_usage(&live, &Default::default()).into_iter().map(|w| w.label).collect();
        let b: Vec<String> = collect_webview_usage(&live, &Default::default()).into_iter().map(|w| w.label).collect();
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
        assert!(collect_webview_usage(&live, &Default::default()).is_empty());
    }

    #[test]
    fn un_puntatore_nullo_non_fa_crashare_la_spi() {
        // `_webProcessIdentifier` e' SPI: la difesa e' `respondsToSelector`, ma
        // prima ancora il puntatore va controllato — `with_webview` puo'
        // consegnare un inner nullo su una webview in via di distruzione.
        assert_eq!(unsafe { web_process_identifier(std::ptr::null_mut()) }, 0);
    }
}
