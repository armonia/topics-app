//! Tray menu content and actions, fed by the usage service.
//!
//! Everything here is a pure function from service JSON to a small tree of
//! `Node`s (drawn by `lib.rs` with the native menu API) plus a text dump of the
//! same tree, which is what the bar scripts compare against the service wording.
//! No name or sentence is composed here: labels are the service's own words.
//! Actions are values (`Action`) that map to one HTTP call, so each one is
//! tested against a fake service. Card 23ec388a.

use crate::tray_quota::http_get;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Item { id: String, label: String, enabled: bool },
    Sep,
    Sub { label: String, children: Vec<Node> },
    /// A graphic row: a PNG drawn by `tray_menu_views`, `w` x `h` points. `children` open on hover.
    Card { key: String, png: Vec<u8>, w: f32, h: f32, hover: Vec<crate::tray_hover::HoverZone>, children: Vec<Node> },
    /// A table row: one cell per column, aligned by the tab stops of its `table`. `children` open on hover.
    Row { id: String, cells: Vec<String>, header: bool, table: Table, look: Look, children: Vec<Node> },
    /// Puts a system icon (`sf:<symbol name>`) or an app's own icon (`app:<bundle path>`) before any other row.
    Icon { icon: String, node: Box<Node> },
}

/// The tables of the menu. Each has its own right-aligned tab stops, in points from the text start,
/// the ones of the original tray (ClaudeUsage.swift): a column count that does not match the stops
/// makes a cell overrun its neighbour or the menu's edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Table {
    /// One cell, or a first cell with a second line under it: no stops.
    #[default]
    Plain,
    /// Projects: Claude, Codex, Muse, rate per hour, state.
    Projects,
    /// Processes: CPU, GPU, network, memory.
    Procs,
    /// Processes of a machine read from afar: CPU and memory only, in the last two columns of `Procs`.
    RemoteProcs,
    /// Live agents of one project, with CPU and memory: kind, since, last activity, CPU · memory.
    Agents,
    /// One live agent under a project row: rate per hour, model · since.
    AgentWork,
    /// The week of a project per provider.
    Week,
}

/// The widest a tab stop may go: `menuTextMax` of the original tray (540 - 104). AppKit puts about 103 pt of
/// image and margins around a row's text, and past this the menu grows wider than its cards; the original
/// itself notes that beyond ~460 the menu clips (ClaudeUsage.swift, agents table).
#[cfg(test)]
pub const TAB_MAX: f64 = 436.0;

impl Table {
    pub fn tabs(self) -> &'static [f64] {
        match self {
            Table::Plain => &[],
            Table::Projects => &[238.0, 280.0, 322.0, 366.0, 436.0],
            // The original's [275, 330, 405, 470] ended 34 pt past the margin, where the menu clips; the same
            // steps (55, 75, 65) are squeezed to 56, 62, 56 so the memory column ends on 436 like the projects'.
            Table::Procs => &[262.0, 318.0, 380.0, 436.0],
            Table::RemoteProcs => &[380.0, 436.0],
            Table::Agents => &[145.0, 235.0, 315.0, 436.0],
            Table::AgentWork => &[300.0, 436.0],
            Table::Week => &[225.0, 315.0, 405.0],
        }
    }
}

/// How a project's priority shows before its name: an arrow, as in the original tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Priority {
    #[default]
    Normal,
    High,
    Low,
}

/// Looks of a row that the cells alone do not say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Look {
    /// The first cell in semibold: a project with agents at work, a verdict line.
    pub bold: bool,
    pub priority: Priority,
    /// Leaves the place of the priority arrow empty before the name, so the names of a table whose other rows
    /// wear an arrow all start on the same x.
    pub arrow_slot: bool,
}

/// A data row of a table, without a look of its own.
pub(crate) fn row(table: Table, cells: Vec<String>, children: Vec<Node>) -> Node {
    Node::Row { id: String::new(), cells, header: false, table, look: Look::default(), children }
}

/// A data row whose first cell is in semibold: what the original tray sets apart (a unit that can be closed).
pub(crate) fn bold_row(table: Table, cells: Vec<String>, children: Vec<Node>) -> Node {
    Node::Row { id: String::new(), cells, header: false, table, look: Look { bold: true, ..Look::default() }, children }
}

/// The header row of a table.
pub(crate) fn head_row(table: Table, cells: Vec<String>) -> Node {
    Node::Row { id: String::new(), cells, header: true, table, look: Look::default(), children: Vec::new() }
}

/// A one-line row with its first cell in semibold and an optional small grey line under it.
pub(crate) fn verdict_row(text: impl Into<String>, under: Option<String>) -> Node {
    let mut cells = vec![text.into()];
    cells.extend(under.map(second_line));
    Node::Row { id: String::new(), cells, header: false, table: Table::Plain, look: Look { bold: true, ..Look::default() }, children: Vec::new() }
}

/// A cell is never left empty: a figure that is not there reads `–`.
pub(crate) fn cell(text: impl Into<String>) -> String {
    let t: String = text.into();
    if t.trim().is_empty() { "–".into() } else { t }
}

/// `node` with the icon `spec` at the start of its row, as the original tray draws it.
pub(crate) fn with_icon(spec: impl Into<String>, node: Node) -> Node {
    Node::Icon { icon: spec.into(), node: Box::new(node) }
}

pub(crate) fn item(id: &str, label: impl Into<String>) -> Node {
    Node::Item { id: id.into(), label: label.into(), enabled: true }
}
/// A row's second line (kind, owner, since): the native menu draws it under the row,
/// small and grey, whatever column it would otherwise land in. A table with fewer
/// columns than the tab stops (the processes: 4 against 5) used to print it as one
/// more column, clipped against the memory («204 MBproc»).
pub(crate) fn second_line(text: impl Into<String>) -> String {
    format!("\n{}", text.into())
}
pub(crate) fn note(label: impl Into<String>) -> Node {
    Node::Item { id: String::new(), label: label.into(), enabled: false }
}
pub(crate) fn sub(label: impl Into<String>, children: Vec<Node>) -> Node {
    Node::Sub { label: label.into(), children }
}

/// Raw bodies of the service endpoints. `None` = that endpoint did not answer.
#[derive(Debug, Default, Clone)]
pub struct Snapshot {
    pub board: Option<String>,
    pub overview: Option<String>,
    pub heavy: Option<String>,
    pub procs: Option<String>,
    pub automations: Option<String>,
    pub live: Option<String>,
    pub gates: Option<String>,
    /// Backup state: asked of the service, and the last good answer kept on disk so the row survives a dead service.
    pub backup: Option<String>,
    /// The service has answered with a backup state at least once on this machine: only then the backup row exists.
    pub backup_set: bool,
    /// Memory sync state (`/api/memory-sync`): same scheme as the backup, the last good answer kept on disk.
    pub memory_sync: Option<String>,
    /// The service has answered a valid memory-sync state at least once on this machine: only then the card exists.
    pub memory_sync_set: bool,
    /// The node pool's own state file (`node-pool/state.json`): which servers really exist, which is draining.
    pub pool: Option<String>,
    /// `machines-health.json`: the security checks, 24 hour history and cards today of every machine.
    pub health: Option<String>,
    /// `harness-sync.json`: the memories and rules copied to each machine, and how late.
    pub harness_sync: Option<String>,
    /// `/api/machines`: the history, timeline and spend the machine submenus draw.
    pub machines: Option<String>,
    /// `/api/mac/trust`: which running things are suspect.
    pub trust: Option<String>,
    /// CPU percent per process id on this computer (100 = one core), for the process table.
    pub cpu: std::collections::HashMap<u32, f64>,
}

impl Snapshot {
    pub fn fetch(base: &str, backup_cache: Option<&std::path::Path>) -> Self {
        Self::fetch_with(base, backup_cache, None)
    }

    /// `fetch` plus the cache of the memory-sync state, so its card survives the service going down.
    pub fn fetch_with(base: &str, backup_cache: Option<&std::path::Path>, memory_cache: Option<&std::path::Path>) -> Self {
        let live_memory = http_get(base, "/api/memory-sync").filter(|b| crate::tray_menu_views::memory_sync_valid(b));
        if let (Some(b), Some(p)) = (&live_memory, memory_cache) {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(p, b);
        }
        let memory_sync = live_memory.or_else(|| memory_cache.and_then(|p| std::fs::read_to_string(p).ok()).filter(|b| crate::tray_menu_views::memory_sync_valid(b)));
        let live_backup = http_get(base, "/api/backup-mac").filter(|b| serde_json::from_str::<Value>(b).map_or(false, |v| v.is_object()));
        if let (Some(b), Some(p)) = (&live_backup, backup_cache) {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(p, b);
        }
        let backup = live_backup.or_else(|| backup_cache.and_then(|p| std::fs::read_to_string(p).ok()));
        let live = http_get(base, "/api/live");
        // The icons are read here, on the poller's thread: never when the menu opens.
        fetch_project_icons(base, &live);
        Snapshot {
            board: http_get(base, "/api/board"),
            overview: http_get(base, "/api/overview"),
            heavy: http_get(base, "/api/heavy"),
            procs: http_get(base, "/api/mac/procs"),
            automations: http_get(base, "/api/automations/summary"),
            live,
            gates: http_get(base, "/api/gates"),
            machines: http_get(base, "/api/machines"),
            trust: http_get(base, "/api/mac/trust"),
            cpu: cpu_by_pid(),
            backup_set: backup.is_some(),
            backup,
            memory_sync_set: memory_sync.is_some(),
            memory_sync,
            pool: crate::tray_nodes::pool_state_path().and_then(|p| std::fs::read_to_string(p).ok()),
            health: crate::tray_node_health::health_path().and_then(|p| std::fs::read_to_string(p).ok()),
            harness_sync: crate::tray_node_health::sync_path().and_then(|p| std::fs::read_to_string(p).ok()),
        }
    }
    pub fn service_up(&self) -> bool {
        self.board.is_some() || self.overview.is_some() || self.gates.is_some() || self.procs.is_some()
    }
}

/// The icon of each project as the service serves it (PNG), by project name, with the path it came from.
static PROJECT_ICONS: std::sync::Mutex<Option<std::collections::HashMap<String, (String, Vec<u8>)>>> = std::sync::Mutex::new(None);

/// The icon read for a project, if any: the menu draws it 15×15 before the name.
pub(crate) fn project_icon_png(name: &str) -> Option<Vec<u8>> {
    PROJECT_ICONS.lock().ok()?.as_ref()?.get(name).map(|(_, png)| png.clone())
}

pub(crate) fn store_project_icon(name: &str, path: &str, png: Vec<u8>) {
    if let Ok(mut g) = PROJECT_ICONS.lock() {
        g.get_or_insert_with(Default::default).insert(name.into(), (path.into(), png));
    }
}

/// Reads the icon of every listed project that has one and is not cached under the same path yet.
/// A project whose icon cannot be read keeps the folder symbol and is asked again on the next poll.
fn fetch_project_icons(base: &str, live: &Option<String>) {
    let v = parse(live);
    for p in v.get("projects").and_then(Value::as_array).into_iter().flatten().filter(|p| p.get("dead").and_then(Value::as_bool) != Some(true)) {
        let (name, path) = (s(p, "name"), s(p, "icon"));
        if name.is_empty() || !path.starts_with('/') {
            continue;
        }
        let cached = PROJECT_ICONS.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(name).map(|(at, _)| at == path))).unwrap_or(false);
        if cached {
            continue;
        }
        if let Some(png) = crate::tray_quota::http_get_bytes(base, path).filter(|b| !b.is_empty()) {
            store_project_icon(name, path, png);
        }
    }
}

/// CPU of every process on this computer, as the system's `ps` reports it.
fn cpu_by_pid() -> std::collections::HashMap<u32, f64> {
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-o", "pid=,pcpu="]).output() else { return Default::default() };
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

pub(crate) fn parse_ps(text: &str) -> std::collections::HashMap<u32, f64> {
    text.lines().filter_map(|l| {
        let mut f = l.split_whitespace();
        Some((f.next()?.parse().ok()?, f.next()?.replace(',', ".").parse().ok()?))
    }).collect()
}

pub(crate) fn parse(body: &Option<String>) -> Value {
    body.as_deref().and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null)
}
pub(crate) fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
pub(crate) fn n(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

// ------------------------------------------------------------------ backup

/// Where the last backup state the service gave is kept; overridable for tests.
pub fn backup_cache_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("TOPICS_BACKUP_CACHE") {
        return Some(p.into());
    }
    Some(std::path::Path::new(&std::env::var_os("HOME")?).join(".topics/tray-backup-cache.json"))
}

/// Where the last memory-sync state the service gave is kept; overridable for tests.
pub fn memory_sync_cache_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("TOPICS_MEMORY_SYNC_CACHE") {
        return Some(p.into());
    }
    Some(std::path::Path::new(&std::env::var_os("HOME")?).join(".topics/tray-memory-sync-cache.json"))
}

fn day_word(now: i64, at: i64) -> String {
    let d = ((now - at).max(0)) / 86_400;
    match d {
        0 => "oggi".into(),
        1 => "ieri".into(),
        _ => format!("{d} giorni fa"),
    }
}

pub(crate) fn gb(bytes: f64) -> String {
    format!("{:.1} GB", bytes / 1_073_741_824.0).replace('.', ",")
}

/// The backup rows: a verdict line first, then details. Works from the file alone.
pub fn backup_lines(body: Option<&str>, now: i64) -> Vec<String> {
    let Some(v) = body.and_then(|b| serde_json::from_str::<Value>(b).ok()) else {
        return vec!["Backup · nessun dato".into()];
    };
    let last_ok = v.get("last_ok").and_then(Value::as_i64);
    let err = v.get("last_error").and_then(Value::as_str).filter(|e| !e.is_empty());
    let stale = last_ok.map_or(true, |t| now - t > 30 * 3600);
    let head = if err.is_some() {
        "Backup · PROBLEMA, ultimo giro fallito".to_string()
    } else if stale {
        "Backup · PROBLEMA, nessuna copia nelle ultime 30 ore".to_string()
    } else if v.get("last_read_check").and_then(Value::as_i64).map_or(false, |t| now - t > 7 * 86_400) {
        "Backup · da guardare, dati riletti da più di 7 giorni".to_string()
    } else {
        format!("Backup · tutto a posto, ultima copia {}", day_word(now, last_ok.unwrap_or(now)))
    };
    let mut out = vec![head];
    if let Some(e) = err {
        out.push(format!("Ultimo errore: {e}"));
    }
    let running = v.get("pending_since").map_or(false, |p| !p.is_null());
    out.push(if running { "Sul Mac: copia in corso".into() } else { "Sul Mac: Adesso niente in corso".into() });
    if let Some(runs) = v.get("runs").and_then(Value::as_array) {
        // A day with no run between two runs counts as a failed day, not a good one.
        let mut days: std::collections::BTreeMap<i64, bool> = Default::default();
        for r in runs {
            if let Some(at) = r.get("at").and_then(Value::as_i64) {
                let e = days.entry(at / 86_400).or_insert(false);
                *e |= r.get("ok").and_then(Value::as_bool).unwrap_or(false);
            }
        }
        if let (Some(a), Some(b)) = (days.keys().next().copied(), days.keys().next_back().copied()) {
            let total = b - a + 1;
            let good = days.values().filter(|ok| **ok).count() as i64;
            out.push(format!("Giorni: {good} giorni su {total} riusciti"));
        }
    }
    if let Some(ic) = v.get("icloud") {
        if let Some(b) = ic.get("bytes").and_then(Value::as_f64) {
            out.push(format!("Su iCloud: {} caricati", gb(b)));
        }
    }
    out
}

// ------------------------------------------------------------------ processes

pub(crate) fn mem_text(mb: f64) -> String {
    if mb >= 1000.0 { format!("{:.1} GB", mb / 1000.0).replace('.', ",") } else { format!("{} MB", mb.round() as i64) }
}

fn type_word(t: &str) -> &'static str {
    match t {
        "sessione" => "sessione",
        "lavoro" => "lavoro",
        "devserver" => "server di sviluppo",
        "app" => "app",
        "servizio" => "servizio",
        "mcp" => "MCP",
        "resto" => "resto senza padrone",
        _ => "senza padrone",
    }
}

/// The second close gesture of a process: SIGKILL after the same confirmation as the polite one.
pub(crate) const FORCE_LABEL: &str = "Forza chiusura…";

/// Rows of the process list a menu can hold; the rest is counted, not listed.
const PROCS_SHOWN: usize = 15;

/// One list: the service's name, a type word, owner, use and memory. Nothing composed from the kernel.
pub fn procs_nodes(body: &Option<String>) -> Vec<Node> {
    let v = parse(body);
    let Some(units) = v.get("units").and_then(Value::as_array) else {
        return vec![note("Non riesco a leggere i processi adesso")];
    };
    let (sys, mut real): (Vec<&Value>, Vec<&Value>) = units.iter().partition(|u| s(u, "type") == "macos");
    real.sort_by(|a, b| n(b, "memMB").partial_cmp(&n(a, "memMB")).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = real.iter().map(|u| n(u, "memMB")).sum();
    let mut out = vec![note(format!("GIRA ADESSO · {} · {}", real.len(), mem_text(total))), item("open:processes", "Apri Processi…"), Node::Sep];
    for u in real.iter().take(PROCS_SHOWN) {
        let mut children = vec![note(format!(
            "{} // {}",
            u.get("use").map(|x| s(x, "text")).filter(|t| !t.is_empty()).unwrap_or("uso non noto"),
            s(u, "returns")
        ))];
        if let Some(o) = u.get("owner").map(|o| s(o, "label")).filter(|l| !l.is_empty()) {
            children.push(note(format!("Padrone: {o}")));
        }
        if u.get("closable").and_then(Value::as_bool).unwrap_or(false) {
            let verb = u.get("verb").and_then(Value::as_str).unwrap_or("Chiudi");
            children.push(Node::Sep);
            children.push(item(&format!("proc-close:{}", s(u, "id")), format!("{verb}…")));
            children.push(item(&format!("proc-force:{}", s(u, "id")), FORCE_LABEL));
        }
        out.push(sub(
            format!("{} | {} // {}", s(u, "name"), mem_text(n(u, "memMB")), type_word(s(u, "type"))),
            children,
        ));
    }
    if real.len() > PROCS_SHOWN {
        let rest: f64 = real[PROCS_SHOWN..].iter().map(|u| n(u, "memMB")).sum();
        out.push(note(format!("altri {} più leggeri · {}", real.len() - PROCS_SHOWN, mem_text(rest))));
    }
    let leftovers: Vec<&&Value> = real.iter().filter(|u| s(u, "type") == "resto").collect();
    if !leftovers.is_empty() {
        let mem: f64 = leftovers.iter().map(|u| n(u, "memMB")).sum();
        out.push(Node::Sep);
        out.push(item("proc-close-leftovers", format!("Chiudi i resti ({} · {})…", leftovers.len(), mem_text(mem))));
    }
    if let Some(m) = sys.first() {
        out.push(note(format!("macOS · {} · gestito da macOS", mem_text(n(m, "memMB")))));
    }
    out
}

/// Pids of one census unit, for the safe close. `None` if the unit is gone or not closable.
pub fn unit_pids(body: &Option<String>, unit_id: &str) -> Option<(String, Vec<u32>)> {
    let v = parse(body);
    let u = v.get("units")?.as_array()?.iter().find(|u| s(u, "id") == unit_id)?;
    if !u.get("closable").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let pids = u.get("pids")?.as_array()?.iter().filter_map(|p| p.as_u64().map(|p| p as u32)).collect();
    Some((s(u, "name").to_string(), pids))
}

pub fn leftover_pids(body: &Option<String>) -> Vec<u32> {
    let v = parse(body);
    v.get("units").and_then(Value::as_array).map(|us| {
        us.iter()
            .filter(|u| s(u, "type") == "resto" && u.get("closable").and_then(Value::as_bool).unwrap_or(false))
            .flat_map(|u| u.get("pids").and_then(Value::as_array).cloned().unwrap_or_default())
            .filter_map(|p| p.as_u64().map(|p| p as u32))
            .collect()
    }).unwrap_or_default()
}

// ------------------------------------------------------------------ the menu

/// The 5-hour window of one account, from the overview, when the preference asks for it.
fn five_hour_row(overview: &Value, email: &str, board_id: &str) -> Option<Node> {
    let acc = overview.get("providers")?.as_array()?.iter()
        .flat_map(|p| p.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default())
        .find(|a| {
            let id = s(a, "id");
            !id.is_empty() && (id == email || board_id.ends_with(&format!(":{id}")))
        })?;
    let q = acc.get("quotas")?.as_array()?.iter().find(|q| s(q, "key").eq_ignore_ascii_case("5h"))?;
    let reset = Some(s(q, "resetText")).filter(|t| !t.is_empty()).map(|t| format!(" · libera tra {t}")).unwrap_or_default();
    Some(note(format!("5 ore {}%{reset}", n(q, "usedPct") as i64)))
}

fn quota_nodes(board: &Option<String>, overview: &Option<String>, prefs: Prefs) -> Vec<Node> {
    let v = parse(board);
    let ov = parse(overview);
    let Some(accs) = v.get("accounts").and_then(Value::as_array) else { return vec![note("Quote: il servizio non risponde")] };
    let mut out = Vec::new();
    for a in accs {
        let g = a.get("gauge").cloned().unwrap_or(Value::Null);
        let mut kids = vec![note(s(&g, "say"))];
        if let Some(t) = a.get("access").map(|x| s(x, "say")).filter(|t| !t.is_empty()) {
            kids.push(note(t));
        }
        if prefs.five_hour {
            kids.extend(five_hour_row(&ov, s(a, "email"), s(a, "id")));
        }
        let offline = a.get("access").map_or(false, |x| s(x, "state") != "ok");
        let label = format!("{} · {}% · {}{}", s(a, "label"), n(a, "used") as i64, s(&g, "short"), if offline { " · non risponde" } else { "" });
        out.push(sub(label, kids));
    }
    out
}

/// «Ritmo di oggi»: the last 24 hours of each account against what it can spend per day.
fn pace_nodes(heavy: &Option<String>) -> Vec<Node> {
    let v = parse(heavy);
    let Some(rows) = v.get("today").and_then(Value::as_array) else { return Vec::new() };
    let kids: Vec<Node> = rows
        .iter()
        .filter(|r| n(r, "perDay") > 0.0)
        .map(|r| {
            let x = n(r, "last24h") / n(r, "perDay");
            let num = |v: f64| format!("{v:.1}").replace('.', ",");
            note(format!("{} · {}% in 24 h · ok {}% · {}×", s(r, "account"), num(n(r, "last24h")), num(n(r, "perDay")), num(x)))
        })
        .collect();
    if kids.is_empty() { Vec::new() } else { vec![sub("Ritmo di oggi", kids)] }
}

/// Renewals (from the plans) and, per the preferences, API credit and cloud bonus / AI credit.
pub(crate) fn extras_nodes(overview: &Option<String>, prefs: Prefs) -> Vec<Node> {
    let v = parse(overview);
    let mut out = Vec::new();
    if let Some(plans) = v.get("plans").and_then(Value::as_object) {
        let mut kids: Vec<Node> = plans
            .iter()
            .filter_map(|(who, p)| {
                let to = p.get("period").map(|x| s(x, "to")).filter(|t| !t.is_empty())?;
                Some(note(format!("{who} · {} · {} · rinnovo {to}", s(p, "plan"), s(p, "price"))))
            })
            .collect();
        if !kids.is_empty() {
            kids.sort_by_key(|k| if let Node::Item { label, .. } = k { label.clone() } else { String::new() });
            out.push(sub("Rinnovi", kids));
        }
    }
    if prefs.api_credit {
        if let Some(line) = v.get("apiSpend").map(|x| s(x, "line")).filter(|l| !l.is_empty()) {
            out.push(note(line));
        }
    }
    if prefs.cloud_bonus {
        if let Some(credits) = v.get("credits").and_then(Value::as_object) {
            let mut kids = Vec::new();
            // a reading the service marks as old is not a figure to show
            for (who, c) in credits.iter().filter(|(_, c)| c.get("stale").and_then(Value::as_bool) != Some(true)) {
                if let (Some(left), Some(lim), false) = (c.get("remaining").and_then(Value::as_f64), c.get("limit").and_then(Value::as_f64), c.get("nobonus").and_then(Value::as_bool) == Some(true)) {
                    if lim > 0.0 {
                        let renews = Some(s(c, "renewsAt")).filter(|t| !t.is_empty()).map(|t| format!(" · scade {t}")).unwrap_or_default();
                        kids.push(note(format!("Bonus {who} · {:.0} su {:.0} rimasti{renews}", left, lim)));
                    }
                }
                for m in c.get("models").and_then(Value::as_array).into_iter().flatten() {
                    kids.push(note(format!("{who} · {} {}% della sua quota", s(m, "name"), n(m, "pct") as i64)));
                }
            }
            if !kids.is_empty() {
                out.push(sub("Quote per modello", kids));
            }
        }
    }
    out
}

/// Jobs, sessions and Topics chats of one project; a session that is open somewhere opens there.
pub(crate) fn project_work_nodes(p: &Value) -> Vec<Node> {
    let mut out = Vec::new();
    let list = p.get("agents").and_then(|a| a.get("list")).and_then(Value::as_array).cloned().unwrap_or_default();
    for a in list.iter().take(6) {
        let title = Some(s(a, "title")).filter(|t| !t.is_empty()).unwrap_or("sessione");
        let url = a.get("open").map(|o| s(o, "url")).unwrap_or("");
        if url.is_empty() {
            out.push(note(format!("{} · {}", s(a, "kind"), title)));
        } else {
            out.push(item(&format!("session-open:{url}"), format!("{} · {}", s(a, "kind"), title)));
        }
    }
    for t in p.get("topics").and_then(Value::as_array).into_iter().flatten().take(6) {
        let title = Some(s(t, "title")).filter(|x| !x.is_empty()).or(Some(s(t, "name")).filter(|x| !x.is_empty())).unwrap_or("chat");
        let url = s(t, "url");
        if url.is_empty() {
            out.push(note(format!("Chat Topics · {title}")));
        } else {
            out.push(item(&format!("session-open:{url}"), format!("Chat Topics · {title}")));
        }
    }
    if let Some(j) = p.get("lastJob").filter(|j| !j.is_null()) {
        out.push(note(format!("Ultimo lavoro · {} · {}", s(j, "task"), s(j, "status"))));
    }
    if !out.is_empty() {
        out.push(Node::Sep);
    }
    out
}

/// Budget values the original tray offers (0 = none), a share of the week of Claude.
pub(crate) const BUDGET_STEPS: [i64; 6] = [0, 5, 10, 15, 20, 30];

/// The two pick lists of a project, each under its own explaining header, the current value ticked.
pub(crate) fn budget_priority_nodes(p: &Value) -> Vec<Node> {
    let name = s(p, "name");
    let cur_budget = p.get("budgetPct").and_then(Value::as_f64).map(|b| b as i64).unwrap_or(0);
    let mut out = vec![note("Budget: % della settimana Claude, oltre si ferma il non interattivo")];
    for b in BUDGET_STEPS {
        let label = if b == 0 { "Nessuno".to_string() } else { format!("{b}%") };
        out.push(item(&format!("proj-budget:{name}:{b}"), if b == cur_budget { format!("{label} ✓") } else { label }));
    }
    out.push(Node::Sep);
    out.push(note("Priorità: alta corre di più, bassa si ferma prima"));
    let cur = s(p, "priority");
    for pr in ["alta", "normale", "bassa"] {
        out.push(item(&format!("proj-priority:{name}:{pr}"), if pr == cur { format!("{pr} ✓") } else { pr.to_string() }));
    }
    out
}

fn project_nodes(live: &Option<String>) -> Vec<Node> {
    let v = parse(live);
    let Some(ps) = v.get("projects").and_then(Value::as_array) else { return vec![note("Progetti: il servizio non risponde")] };
    ps.iter()
        .filter(|p| !p.get("dead").and_then(Value::as_bool).unwrap_or(false))
        .take(12)
        .map(|p| {
            let name = s(p, "name");
            let mut kids = vec![
                note(format!("{} · consumi {:.1}%", s(p, "state"), n(p, "total"))),
                Node::Sep,
            ];
            kids.extend(budget_priority_nodes(p));
            kids.push(Node::Sep);
            kids.extend(project_work_nodes(p));
            kids.push(item(&format!("proj-open:{name}"), "Apri in Topics"));
            let shown = p.get("title").and_then(Value::as_str).filter(|d| !d.is_empty()).or(p.get("display").and_then(Value::as_str).filter(|d| !d.is_empty())).unwrap_or(name);
            sub(format!("{shown} · {:.1}%", n(p, "total")), kids)
        })
        .collect()
}

/// `with_board`: the per account lines above already say each state, so a provider is
/// listed only when there is something to do (unlock it, or take its unlock away).
pub(crate) fn brake_nodes(gates: &Option<String>, with_board: bool) -> Vec<Node> {
    let v = parse(gates);
    if v.is_null() {
        return vec![note("Freno: il servizio non risponde")];
    }
    let ov: Vec<&Value> = v.get("overrides").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let mut out = Vec::new();
    let hold = ov.iter().any(|o| o.get("hold").and_then(Value::as_bool) == Some(true));
    if let Some(provs) = v.get("providers").and_then(Value::as_object) {
        for (id, p) in provs {
            // An exhausted entry is spent: the service does not remove it on DELETE, so it is no revocable unlock.
            let unlocked = ov.iter().any(|o| s(o, "provider") == id && o.get("hold").and_then(Value::as_bool) != Some(true) && o.get("exhausted").and_then(Value::as_bool) != Some(true));
            let braked = s(p, "state") == "frenato";
            if !with_board {
                out.push(note(format!("{id}: {}", s(p, "state"))));
            }
            if unlocked {
                out.push(item(&format!("brake-unlock-off:{id}"), format!("Togli lo sblocco di {id}")));
            } else if braked || !with_board {
                out.push(item(&format!("brake-unlock:{id}"), format!("Sblocca {id} per 2 ore")));
            }
        }
    }
    out.push(Node::Sep);
    out.push(if hold {
        item("brake-hold-off", "Riprendi i lavori in background")
    } else {
        item("brake-hold", "Ferma i lavori nuovi in background per 1 ora")
    });
    out.push(note("Le sessioni aperte non si fermano mai: il freno vale per i lavori nuovi"));
    out
}

/// Preferences that stay on this machine: nothing here is a service setting.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Prefs {
    pub five_hour: bool,
    pub api_credit: bool,
    pub cloud_bonus: bool,
}

/// All three on, like the old tray and like a file that does not exist yet.
impl Default for Prefs {
    fn default() -> Self {
        Prefs { five_hour: true, api_credit: true, cloud_bonus: true }
    }
}

pub fn prefs_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("TOPICS_TRAY_PREFS") {
        return Some(p.into());
    }
    Some(std::path::Path::new(&std::env::var_os("HOME")?).join(".topics/tray-prefs.json"))
}
pub fn load_prefs(path: &std::path::Path) -> Prefs {
    let v: Value = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let b = |k: &str, d: bool| v.get(k).and_then(Value::as_bool).unwrap_or(d);
    Prefs { five_hour: b("fiveHour", true), api_credit: b("apiCredit", true), cloud_bonus: b("cloudBonus", true) }
}
pub fn toggle_pref(path: &std::path::Path, key: &str) -> Prefs {
    let mut p = load_prefs(path);
    match key {
        "five-hour" => p.five_hour = !p.five_hour,
        "api-credit" => p.api_credit = !p.api_credit,
        "cloud-bonus" => p.cloud_bonus = !p.cloud_bonus,
        _ => {}
    }
    // Keep every other key of the file: only the three switches are ours to write.
    let mut body: Value = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    body["fiveHour"] = json!(p.five_hour);
    body["apiCredit"] = json!(p.api_credit);
    body["cloudBonus"] = json!(p.cloud_bonus);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, body.to_string());
    p
}

pub(crate) fn tick(label: &str, on: bool) -> String {
    format!("{label}{}", if on { " ✓" } else { "" })
}

pub(crate) use crate::tray_menu_clock::{civil, local_offset_secs, when_text, Civil};

pub(crate) fn automation_nodes(body: &Option<String>, now_secs: i64, offset: i64) -> Vec<Node> {
    let v = parse(body);
    if v.is_null() {
        return vec![note("Automazioni: il servizio non risponde")];
    }
    let mut out = vec![
        with_icon("sf:clock.arrow.circlepath", item("open:automations", format!("Automazioni · {} ti aspettano · {} rotte", n(&v, "needsYou") as i64, n(&v, "broken") as i64))),
    ];
    if let Some(c) = v.get("calendar") {
        let next = c.get("next").filter(|x| !s(x, "title").is_empty());
        let when = next.and_then(|x| x.get("at").and_then(Value::as_i64)).map(|at| format!(" · {}", when_text(at, now_secs, offset)));
        // the count and the time on the row, the next event's title whole on the small line under it: a title is
        // free text, and on the row it ran past the menu or was cut
        let mut cells = vec![format!("In calendario · {}{}", n(c, "count") as i64, when.unwrap_or_default())];
        cells.extend(next.map(|x| second_line(s(x, "title"))));
        out.push(with_icon("sf:calendar", Node::Row { id: "open:calendar".into(), cells, header: false, table: Table::Plain, look: Look::default(), children: Vec::new() }));
    }
    out
}

/// The whole hub part of the menu. The caller adds the Topics rows (attention, board, show, quit).
/// `ever_answered`: the service has answered at least once since launch. Until then a machine
/// with no usage service gets no hub section at all (no «offline» row on a plain Topics install).
pub fn build_menu(snap: &Snapshot, prefs: Prefs, now: i64, ever_answered: bool) -> Vec<Node> {
    let mut m = Vec::new();
    if snap.service_up() {
        m.extend(quota_nodes(&snap.board, &snap.overview, prefs));
        m.extend(pace_nodes(&snap.heavy));
        m.push(Node::Sep);
        m.push(sub("Processi", procs_nodes(&snap.procs)));
        m.push(sub("Progetti", project_nodes(&snap.live)));
        m.push(Node::Sep);
        let mut more = brake_nodes(&snap.gates, false);
        more.push(Node::Sep);
        more.extend(extras_nodes(&snap.overview, prefs));
        more.push(item("pref:five-hour", tick("Fascia 5 ore", prefs.five_hour)));
        more.push(item("pref:api-credit", tick("Credito API", prefs.api_credit)));
        more.push(item("pref:cloud-bonus", tick("Bonus cloud", prefs.cloud_bonus)));
        m.push(sub("Altri abbonamenti e opzioni", more));
        m.extend(automation_nodes(&snap.automations, now, local_offset_secs()));
    } else if ever_answered {
        m.push(note("Servizio quote: offline"));
    }
    // The backup row reads a file, so it stays when the service is down; no file configured, no row.
    if snap.backup_set {
        let lines = backup_lines(snap.backup.as_deref(), now);
        let mut it = lines.into_iter();
        let head = it.next().unwrap_or_default();
        m.push(sub(head, it.map(note).collect()));
    }
    m
}

/// One line per node, children indented; the bar scripts read this (through the dump test).
#[cfg(test)]
pub fn dump_text(nodes: &[Node]) -> String {
    fn go(nodes: &[Node], depth: usize, out: &mut String) {
        for nd in nodes {
            let pad = "  ".repeat(depth);
            match nd {
                Node::Sep => {}
                Node::Item { label, .. } => out.push_str(&format!("{pad}{label}\n")),
                Node::Sub { label, children } => {
                    out.push_str(&format!("{pad}{label}\n"));
                    go(children, depth + 1, out);
                }
                Node::Card { key, children, .. } => {
                    out.push_str(&format!("{pad}[card {key}]\n"));
                    go(children, depth + 1, out);
                }
                Node::Row { cells, children, .. } => {
                    let flat: Vec<&str> = cells.iter().map(|c| c.trim_start_matches('\n')).collect();
                    out.push_str(&format!("{pad}{}\n", flat.join(" | ")));
                    go(children, depth + 1, out);
                }
                Node::Icon { node, .. } => go(std::slice::from_ref(&**node), depth, out),
            }
        }
    }
    let mut o = String::new();
    go(nodes, 0, &mut o);
    o
}

// The actions of the rows live in tray_menu_actions.rs; re-exported so callers keep one path.
pub use crate::tray_menu_actions::*;

#[cfg(test)]
#[path = "tray_menu_tests.rs"]
mod tests;
