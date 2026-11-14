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
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Item { id: String, label: String, enabled: bool },
    Sep,
    Sub { label: String, children: Vec<Node> },
    /// A graphic row: a PNG drawn by `tray_menu_views`, `w` x `h` points. `children` open on hover.
    Card { key: String, png: Vec<u8>, w: f32, h: f32, children: Vec<Node> },
    /// A table row: one cell per column, aligned by tab stops. `children` open on hover.
    Row { id: String, cells: Vec<String>, header: bool, children: Vec<Node> },
}

pub(crate) fn item(id: &str, label: impl Into<String>) -> Node {
    Node::Item { id: id.into(), label: label.into(), enabled: true }
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
    /// `/api/machines`: the history, timeline and spend the machine submenus draw.
    pub machines: Option<String>,
    /// `/api/mac/trust`: which running things are suspect.
    pub trust: Option<String>,
    /// CPU percent per process id on this computer (100 = one core), for the process table.
    pub cpu: std::collections::HashMap<u32, f64>,
}

impl Snapshot {
    pub fn fetch(base: &str, backup_cache: Option<&std::path::Path>) -> Self {
        let live_backup = http_get(base, "/api/backup-mac").filter(|b| serde_json::from_str::<Value>(b).map_or(false, |v| v.is_object()));
        if let (Some(b), Some(p)) = (&live_backup, backup_cache) {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(p, b);
        }
        let backup = live_backup.or_else(|| backup_cache.and_then(|p| std::fs::read_to_string(p).ok()));
        Snapshot {
            board: http_get(base, "/api/board"),
            overview: http_get(base, "/api/overview"),
            heavy: http_get(base, "/api/heavy"),
            procs: http_get(base, "/api/mac/procs"),
            automations: http_get(base, "/api/automations/summary"),
            live: http_get(base, "/api/live"),
            gates: http_get(base, "/api/gates"),
            machines: http_get(base, "/api/machines"),
            trust: http_get(base, "/api/mac/trust"),
            cpu: cpu_by_pid(),
            backup_set: backup.is_some(),
            backup,
        }
    }
    pub fn service_up(&self) -> bool {
        self.board.is_some() || self.overview.is_some() || self.gates.is_some() || self.procs.is_some()
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
            for (who, c) in credits {
                if c.get("nobonus").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                if let (Some(left), Some(lim)) = (c.get("remaining").and_then(Value::as_f64), c.get("limit").and_then(Value::as_f64)) {
                    if lim > 0.0 {
                        let renews = Some(s(c, "renewsAt")).filter(|t| !t.is_empty()).map(|t| format!(" · scade {t}")).unwrap_or_default();
                        kids.push(note(format!("Bonus {who} · {:.0} su {:.0} rimasti{renews}", left, lim)));
                    }
                }
                for m in c.get("models").and_then(Value::as_array).into_iter().flatten() {
                    kids.push(note(format!("{who} · {} {}%", s(m, "name"), n(m, "pct") as i64)));
                }
            }
            if !kids.is_empty() {
                out.push(sub("Credito AI e bonus cloud", kids));
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
        item("open:automations", format!("Automazioni · {} ti aspettano · {} rotte", n(&v, "needsYou") as i64, n(&v, "broken") as i64)),
    ];
    if let Some(c) = v.get("calendar") {
        let next = c.get("next").filter(|x| !s(x, "title").is_empty()).map(|x| {
            let title = s(x, "title");
            let title = if title.chars().count() > 36 { format!("{}…", title.chars().take(35).collect::<String>()) } else { title.to_string() };
            match x.get("at").and_then(Value::as_i64) {
                Some(at) => format!("{} {title}", when_text(at, now_secs, offset)),
                None => title,
            }
        });
        out.push(item("open:calendar", format!("In calendario · {}{}", n(c, "count") as i64, next.map(|t| format!(" · {t}")).unwrap_or_default())));
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
                    out.push_str(&format!("{pad}{}\n", cells.join(" | ")));
                    go(children, depth + 1, out);
                }
            }
        }
    }
    let mut o = String::new();
    go(nodes, 0, &mut o);
    o
}

// ------------------------------------------------------------------ actions

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Http { method: &'static str, path: String, body: Option<Value> },
    /// `unit`: the census id to re-read before closing; `None` = the leftovers group.
    /// `force`: SIGKILL instead of SIGTERM, behind its own confirmation.
    ClosePids { name: String, unit: Option<String>, pids: Vec<u32>, force: bool },
    OpenUrl(String),
    TogglePref(String),
    Open(String),
}

/// A menu id to the thing it does. `None` = not a hub id.
pub fn action_for(id: &str, procs: &Option<String>) -> Option<Action> {
    let http = |method, path: &str, body| Some(Action::Http { method, path: path.into(), body });
    if let Some(p) = id.strip_prefix("brake-unlock-off:") {
        return http("DELETE", &format!("/api/override?provider={p}"), None);
    }
    if let Some(p) = id.strip_prefix("brake-unlock:") {
        return http("POST", "/api/override", Some(json!({"provider": p, "hours": 2, "by": "tray"})));
    }
    match id {
        "brake-hold" => return http("POST", "/api/hold", Some(json!({"hours": 1, "by": "tray"}))),
        "brake-hold-off" => return http("DELETE", "/api/hold", None),
        "proc-close-leftovers" => {
            return Some(Action::ClosePids { name: "i resti senza padrone".into(), unit: None, pids: leftover_pids(procs), force: false });
        }
        _ => {}
    }
    if let Some(rest) = id.strip_prefix("proj-budget:") {
        let (name, b) = rest.rsplit_once(':')?;
        let b: i64 = b.parse().ok()?;
        let val = if b == 0 { Value::Null } else { json!(b) };
        return http("POST", "/api/project-settings", Some(json!({"name": name, "budgetPct": val})));
    }
    if let Some(rest) = id.strip_prefix("proj-priority:") {
        let (name, p) = rest.rsplit_once(':')?;
        return http("POST", "/api/project-settings", Some(json!({"name": name, "priority": p})));
    }
    if let Some(u) = id.strip_prefix("proc-close:") {
        let (name, pids) = unit_pids(procs, u)?;
        return Some(Action::ClosePids { name, unit: Some(u.to_string()), pids, force: false });
    }
    if let Some(u) = id.strip_prefix("proc-force:") {
        let (name, pids) = unit_pids(procs, u)?;
        return Some(Action::ClosePids { name, unit: Some(u.to_string()), pids, force: true });
    }
    if let Some(name) = id.strip_prefix("proj-open:") {
        return Some(Action::Open(format!("project:{name}")));
    }
    if let Some(url) = id.strip_prefix("session-open:") {
        // Only addresses of the places a session lives in; nothing else is handed to the system.
        let ok = ["claude://", "https://", "http://127.0.0.1", "http://localhost"].iter().any(|p| url.starts_with(p));
        return ok.then(|| Action::OpenUrl(url.to_string()));
    }
    if id == "dashboard-open" {
        return Some(Action::OpenUrl(crate::tray_quota::hub_base()));
    }
    if let Some(k) = id.strip_prefix("pref:") {
        return Some(Action::TogglePref(k.into()));
    }
    id.strip_prefix("open:").map(|w| Action::Open(w.into()))
}

/// Sends one request to the service; true on a 2xx answer.
pub fn http_send(base: &str, method: &str, path: &str, body: Option<&Value>) -> bool {
    let Some(rest) = base.strip_prefix("http://") else { return false };
    let hostport = rest.split('/').next().unwrap_or("");
    let Some(addr) = hostport.to_socket_addrs().ok().and_then(|mut a| a.next()) else { return false };
    let Ok(mut st) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else { return false };
    let _ = st.set_read_timeout(Some(Duration::from_secs(10)));
    let payload = body.map(Value::to_string).unwrap_or_default();
    // One write: head and body leave together.
    let req = format!(
        "{method} {path} HTTP/1.0\r\nHost: {hostport}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    if st.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = st.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    text.split_whitespace().nth(1).map_or(false, |c| c.starts_with('2'))
}

/// The pids that may still be closed once the person said yes: the ones the menu showed AND
/// that a census read just now still lists for the same unit (a pid that left or was reused
/// by another process is not in it).
pub fn still_closable(fresh: &Option<String>, unit: Option<&str>, shown: &[u32]) -> Vec<u32> {
    let now: Vec<u32> = match unit {
        Some(u) => unit_pids(fresh, u).map(|(_, p)| p).unwrap_or_default(),
        None => leftover_pids(fresh),
    };
    shown.iter().copied().filter(|p| now.contains(p)).collect()
}

/// A census older than this is not a basis for signalling anything.
pub const CENSUS_MAX_AGE_MS: i64 = 90_000;

/// The census carries the time it was taken (`at`, ms); one without it, or too old, is refused.
pub fn census_is_fresh(body: &str, now_ms: i64) -> bool {
    serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("at").and_then(Value::as_i64)).map_or(false, |at| now_ms - at <= CENSUS_MAX_AGE_MS)
}

/// The close, after the dialog: nothing without a yes; with it, a fresh census decides the pids.
pub fn close_confirmed(
    confirmed: bool,
    now_ms: i64,
    fresh_census: impl FnOnce() -> Option<String>,
    unit: Option<&str>,
    shown: &[u32],
    kill: impl FnOnce(&[u32]) -> usize,
) -> usize {
    if !confirmed {
        return 0;
    }
    let census = fresh_census().filter(|c| census_is_fresh(c, now_ms));
    let pids = still_closable(&census, unit, shown);
    if pids.is_empty() { 0 } else { kill(&pids) }
}

/// SIGTERM so the process gets to save, or SIGKILL when the person chose the forced close.
/// Only pids the census listed as closable.
pub fn terminate(pids: &[u32], force: bool) -> usize {
    let signal = if force { "-KILL" } else { "-TERM" };
    pids.iter()
        .filter(|p| **p > 1)
        .filter(|p| std::process::Command::new("kill").args([signal, &p.to_string()]).status().map_or(false, |s| s.success()))
        .count()
}

#[cfg(test)]
#[path = "tray_menu_tests.rs"]
mod tests;
