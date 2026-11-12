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
}

fn item(id: &str, label: impl Into<String>) -> Node {
    Node::Item { id: id.into(), label: label.into(), enabled: true }
}
fn note(label: impl Into<String>) -> Node {
    Node::Item { id: String::new(), label: label.into(), enabled: false }
}
fn sub(label: impl Into<String>, children: Vec<Node>) -> Node {
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
    /// Content of the backup state file, read from disk so it survives a dead service.
    pub backup: Option<String>,
    /// A backup state file is configured on this machine: only then the backup row exists.
    pub backup_set: bool,
}

impl Snapshot {
    pub fn fetch(base: &str, backup_path: Option<&std::path::Path>) -> Self {
        Snapshot {
            board: http_get(base, "/api/board"),
            overview: http_get(base, "/api/overview"),
            heavy: http_get(base, "/api/heavy"),
            procs: http_get(base, "/api/mac/procs"),
            automations: http_get(base, "/api/automations/summary"),
            live: http_get(base, "/api/live"),
            gates: http_get(base, "/api/gates"),
            backup: backup_path.and_then(|p| std::fs::read_to_string(p).ok()),
            backup_set: backup_path.is_some(),
        }
    }
    pub fn service_up(&self) -> bool {
        self.board.is_some() || self.overview.is_some() || self.gates.is_some() || self.procs.is_some()
    }
}

fn parse(body: &Option<String>) -> Value {
    body.as_deref().and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null)
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn n(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

// ------------------------------------------------------------------ backup

/// Where the backup state file lives: an environment override (tests) or the
/// `backupState` key of the tray preferences. Nothing is guessed from the home
/// directory: a machine with no such setting simply has no backup row.
pub fn backup_state_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("TOPICS_BACKUP_STATE") {
        return Some(p.into());
    }
    let text = std::fs::read_to_string(prefs_path()?).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("backupState").and_then(Value::as_str).filter(|p| !p.is_empty()).map(Into::into)
}

fn day_word(now: i64, at: i64) -> String {
    let d = ((now - at).max(0)) / 86_400;
    match d {
        0 => "oggi".into(),
        1 => "ieri".into(),
        _ => format!("{d} giorni fa"),
    }
}

fn gb(bytes: f64) -> String {
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

fn mem_text(mb: f64) -> String {
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
    let mut out = vec![note(format!("GIRA ADESSO · {} · {}", real.len(), mem_text(total))), item("open:processes", "Apri Processi (cerca, ordina)…"), Node::Sep];
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
fn five_hour_row(overview: &Value, label: &str) -> Option<Node> {
    let acc = overview.get("providers")?.as_array()?.iter()
        .flat_map(|p| p.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default())
        .find(|a| s(a, "label") == label)?;
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
            kids.extend(five_hour_row(&ov, s(a, "label")));
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
            note(format!("{} · {:.0}% in 24 h · ok {:.0}% · {:.1}×", s(r, "account"), n(r, "last24h"), n(r, "perDay"), x).replace('.', ","))
        })
        .collect();
    if kids.is_empty() { Vec::new() } else { vec![sub("Ritmo di oggi", kids)] }
}

/// Renewals (from the plans) and, per the preferences, API credit and cloud bonus / AI credit.
fn extras_nodes(overview: &Option<String>, prefs: Prefs) -> Vec<Node> {
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
fn project_work_nodes(p: &Value) -> Vec<Node> {
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
        out.push(note(format!("Chat Topics · {title}")));
    }
    if let Some(j) = p.get("lastJob").filter(|j| !j.is_null()) {
        out.push(note(format!("Ultimo lavoro · {} · {}", s(j, "task"), s(j, "status"))));
    }
    if !out.is_empty() {
        out.push(Node::Sep);
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
            let budget = p.get("budgetPct").and_then(Value::as_i64);
            let mut kids = vec![
                note(format!("{} · consumi {:.1}%", s(p, "state"), n(p, "total"))),
                note(match budget { Some(b) => format!("Budget {b}%"), None => "Budget: nessuno".into() }),
                Node::Sep,
            ];
            for b in [0, 10, 25, 50] {
                kids.push(item(&format!("proj-budget:{name}:{b}"), if b == 0 { "Togli il budget".to_string() } else { format!("Budget {b}%") }));
            }
            kids.push(Node::Sep);
            let cur = s(p, "priority");
            for pr in ["alta", "normale", "bassa"] {
                kids.push(item(&format!("proj-priority:{name}:{pr}"), format!("Priorità {pr}{}", if pr == cur { " ✓" } else { "" })));
            }
            kids.push(Node::Sep);
            kids.extend(project_work_nodes(p));
            kids.push(item(&format!("proj-open:{name}"), "Apri in Topics"));
            let shown = p.get("title").and_then(Value::as_str).filter(|d| !d.is_empty()).or(p.get("display").and_then(Value::as_str).filter(|d| !d.is_empty())).unwrap_or(name);
            sub(format!("{shown} · {:.1}%", n(p, "total")), kids)
        })
        .collect()
}

fn brake_nodes(gates: &Option<String>) -> Vec<Node> {
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
            out.push(note(format!("{id}: {}", s(p, "state"))));
            if unlocked {
                out.push(item(&format!("brake-unlock-off:{id}"), format!("Togli lo sblocco di {id}")));
            } else {
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
    out
}

/// Preferences that stay on this machine: nothing here is a service setting.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Prefs {
    pub five_hour: bool,
    pub api_credit: bool,
    pub cloud_bonus: bool,
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
    Prefs { five_hour: b("fiveHour", true), api_credit: b("apiCredit", false), cloud_bonus: b("cloudBonus", false) }
}
pub fn toggle_pref(path: &std::path::Path, key: &str) -> Prefs {
    let mut p = load_prefs(path);
    match key {
        "five-hour" => p.five_hour = !p.five_hour,
        "api-credit" => p.api_credit = !p.api_credit,
        "cloud-bonus" => p.cloud_bonus = !p.cloud_bonus,
        _ => {}
    }
    let body = json!({"fiveHour": p.five_hour, "apiCredit": p.api_credit, "cloudBonus": p.cloud_bonus});
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, body.to_string());
    p
}

fn tick(label: &str, on: bool) -> String {
    format!("{label}{}", if on { " ✓" } else { "" })
}

fn automation_nodes(body: &Option<String>) -> Vec<Node> {
    let v = parse(body);
    if v.is_null() {
        return vec![note("Automazioni: il servizio non risponde")];
    }
    let mut out = vec![
        item("open:automations", format!("Automazioni · {} ti aspettano · {} rotte", n(&v, "needsYou") as i64, n(&v, "broken") as i64)),
    ];
    if let Some(c) = v.get("calendar") {
        let next = c.get("next").map(|x| s(x, "title")).filter(|t| !t.is_empty());
        out.push(item("open:calendar", format!("In calendario · {}{}", n(c, "count") as i64, next.map(|t| format!(" · prossimo: {t}")).unwrap_or_default())));
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
        let mut more = brake_nodes(&snap.gates);
        more.push(Node::Sep);
        more.extend(extras_nodes(&snap.overview, prefs));
        more.push(item("pref:five-hour", tick("Fascia 5 ore", prefs.five_hour)));
        more.push(item("pref:api-credit", tick("Credito API", prefs.api_credit)));
        more.push(item("pref:cloud-bonus", tick("Bonus cloud", prefs.cloud_bonus)));
        m.push(sub("Altri abbonamenti e opzioni", more));
        m.extend(automation_nodes(&snap.automations));
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
    ClosePids { name: String, unit: Option<String>, pids: Vec<u32> },
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
            return Some(Action::ClosePids { name: "i resti senza padrone".into(), unit: None, pids: leftover_pids(procs) });
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
        return Some(Action::ClosePids { name, unit: Some(u.to_string()), pids });
    }
    if let Some(name) = id.strip_prefix("proj-open:") {
        return Some(Action::Open(format!("project:{name}")));
    }
    if let Some(url) = id.strip_prefix("session-open:") {
        // Only addresses of the places a session lives in; nothing else is handed to the system.
        let ok = ["claude://", "https://", "http://127.0.0.1", "http://localhost"].iter().any(|p| url.starts_with(p));
        return ok.then(|| Action::OpenUrl(url.to_string()));
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

/// The close, after the dialog: nothing without a yes; with it, a fresh census decides the pids.
pub fn close_confirmed(
    confirmed: bool,
    fresh_census: impl FnOnce() -> Option<String>,
    unit: Option<&str>,
    shown: &[u32],
    kill: impl FnOnce(&[u32]) -> usize,
) -> usize {
    if !confirmed {
        return 0;
    }
    let pids = still_closable(&fresh_census(), unit, shown);
    if pids.is_empty() { 0 } else { kill(&pids) }
}

/// SIGTERM, never SIGKILL: the process gets to save. Only pids the census listed as closable.
pub fn terminate(pids: &[u32]) -> usize {
    pids.iter()
        .filter(|p| **p > 1)
        .filter(|p| std::process::Command::new("kill").args(["-TERM", &p.to_string()]).status().map_or(false, |s| s.success()))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;

    const PROCS: &str = r#"{"units":[
      {"id":"macos","name":"macOS","type":"macos","closable":false,"memMB":5300,"use":{},"returns":"lo gestisce macOS","pids":[1,2]},
      {"id":"agent:1","name":"Claude · alpha","type":"sessione","owner":{"label":"Claude (app)"},"use":{"text":"aperta da 24 h"},"returns":"non torna da sola","verb":"Chiudi sessione","closable":true,"memMB":1010,"pids":[91001,91002]},
      {"id":"rest:1","name":"Vecchio server","type":"resto","use":{"text":"nessun client"},"returns":"non torna","verb":"Chiudi","closable":true,"memMB":300,"pids":[91050]},
      {"id":"rest:2","name":"Altro resto","type":"resto","use":{"text":"nessun client"},"returns":"non torna","verb":"Chiudi","closable":true,"memMB":200,"pids":[91051]}]}"#;

    fn fake(status: &str) -> (String, mpsc::Receiver<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let status = status.to_string();
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = l.accept() {
                let mut buf = [0u8; 4096];
                let k = c.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..k]).to_string());
                let _ = c.write_all(format!("HTTP/1.0 {status}\r\n\r\n{{}}").as_bytes());
            }
        });
        (base, rx)
    }

    fn run(id: &str) -> (bool, String) {
        let Some(Action::Http { method, path, body }) = action_for(id, &Some(PROCS.into())) else { panic!("not http: {id}") };
        let (base, rx) = fake("200 OK");
        let ok = http_send(&base, method, &path, body.as_ref());
        (ok, rx.recv_timeout(Duration::from_secs(3)).unwrap())
    }

    #[test]
    fn brake_two_hours_and_release() {
        let (ok, req) = run("brake-unlock:claude");
        assert!(ok && req.starts_with("POST /api/override ") && req.contains(r#""hours":2"#) && req.contains(r#""provider":"claude""#));
        let (ok, req) = run("brake-unlock-off:claude");
        assert!(ok && req.starts_with("DELETE /api/override?provider=claude "));
    }

    #[test]
    fn hold_one_hour_and_resume() {
        let (_, req) = run("brake-hold");
        assert!(req.starts_with("POST /api/hold ") && req.contains(r#""hours":1"#));
        let (_, req) = run("brake-hold-off");
        assert!(req.starts_with("DELETE /api/hold "));
    }

    #[test]
    fn budget_and_priority_are_saved() {
        let (_, req) = run("proj-budget:topics-app:25");
        assert!(req.starts_with("POST /api/project-settings ") && req.contains(r#""budgetPct":25"#) && req.contains("topics-app"));
        let (_, req) = run("proj-budget:topics-app:0");
        assert!(req.contains(r#""budgetPct":null"#));
        let (_, req) = run("proj-priority:topics-app:alta");
        assert!(req.contains(r#""priority":"alta""#));
    }

    #[test]
    fn a_refusing_service_is_not_success() {
        let (base, _rx) = fake("500 Internal Server Error");
        assert!(!http_send(&base, "POST", "/api/hold", None));
        assert!(!http_send("http://127.0.0.1:1", "POST", "/api/hold", None));
    }

    #[test]
    fn close_needs_a_closable_unit_and_lists_its_pids() {
        let p = Some(PROCS.to_string());
        assert_eq!(action_for("proc-close:agent:1", &p), Some(Action::ClosePids { name: "Claude · alpha".into(), unit: Some("agent:1".into()), pids: vec![91001, 91002] }));
        assert_eq!(action_for("proc-close:macos", &p), None);
        assert_eq!(action_for("proc-close:gone", &p), None);
        assert_eq!(leftover_pids(&p), vec![91050, 91051]);
    }

    #[test]
    fn terminate_never_touches_pid_one_and_reports_failures() {
        assert_eq!(terminate(&[0, 1]), 0);
        // a pid nobody owns: kill fails, nothing is counted
        assert_eq!(terminate(&[4_000_000]), 0);
    }

    #[test]
    fn procs_menu_uses_service_names_and_one_macos_row() {
        let t = dump_text(&procs_nodes(&Some(PROCS.into())));
        assert!(t.starts_with("GIRA ADESSO · 3 ·"));
        assert!(t.contains("Claude · alpha | 1,0 GB // sessione"));
        assert!(t.contains("Chiudi i resti (2 "));
        assert_eq!(t.lines().filter(|l| l.starts_with("macOS ·")).count(), 1);
        let down = dump_text(&procs_nodes(&None));
        assert!(down.contains("Non riesco a leggere i processi adesso") && !down.contains("GB"));
    }

    #[test]
    fn long_census_is_capped_and_the_rest_counted() {
        let units: Vec<String> = (0..40).map(|i| format!(r#"{{"id":"a:{i}","name":"App {i}","type":"app","use":{{"text":"x"}},"returns":"y","memMB":{},"closable":false,"pids":[]}}"#, 500 - i)).collect();
        let body = format!(r#"{{"units":[{}]}}"#, units.join(","));
        let t = dump_text(&procs_nodes(&Some(body)));
        assert!(t.starts_with("GIRA ADESSO · 40 ·"));
        assert!(t.contains("App 14 |") && !t.contains("App 15 |"));
        assert!(t.contains("altri 25 più leggeri"));
    }

    #[test]
    fn backup_words_per_state() {
        let now = 1_800_000_000;
        let ok = format!(r#"{{"last_ok":{now},"last_error":null,"last_read_check":{now},"icloud":{{"bytes":1073741824}},"runs":[{{"at":{},"ok":true}},{{"at":{now},"ok":true}}]}}"#, now - 172_800);
        let l = backup_lines(Some(&ok), now);
        assert_eq!(l[0], "Backup · tutto a posto, ultima copia oggi");
        assert!(l.contains(&"Giorni: 2 giorni su 3 riusciti".to_string()));
        assert!(l.contains(&"Su iCloud: 1,0 GB caricati".to_string()));
        let bad = format!(r#"{{"last_ok":{},"last_error":"restic check non passa"}}"#, now - 3600);
        let l = backup_lines(Some(&bad), now);
        assert!(l[0].starts_with("Backup · PROBLEMA, ultimo giro fallito") && l.contains(&"Ultimo errore: restic check non passa".to_string()));
        let old = format!(r#"{{"last_ok":{},"last_error":null}}"#, now - 40 * 3600);
        assert!(backup_lines(Some(&old), now)[0].starts_with("Backup · PROBLEMA, nessuna copia"));
        assert!(backup_lines(Some(r#"{"last_ok":null}"#), now)[0].starts_with("Backup · PROBLEMA, nessuna copia"));
        let unread = format!(r#"{{"last_ok":{now},"last_error":null,"last_read_check":{}}}"#, now - 777_600);
        assert!(backup_lines(Some(&unread), now)[0].starts_with("Backup · da guardare"));
        assert_eq!(backup_lines(None, now)[0], "Backup · nessun dato");
    }

    const BOARD: &str = r#"{"accounts":[{"label":"Claude · a","used":39,"gauge":{"short":"frenato fino a lun","say":"Oggi consuma troppo."},"access":{"state":"ok","say":"Collegato dal 13 set."}},{"label":"Codex · b","used":5,"gauge":{"short":"libero","say":"Ok."},"access":{"state":"scaduto","say":"Accesso scaduto."}}]}"#;
    const OVERVIEW: &str = r#"{"providers":[{"id":"claude","accounts":[{"label":"Claude · a","quotas":[{"key":"5h","usedPct":61,"resetText":"2h10"},{"key":"7d","usedPct":39}]}]}],
      "plans":{"Claude · a":{"plan":"Ultra","price":"180 euro","period":{"from":"2026-10-23","to":"2026-11-23"}}},
      "apiSpend":{"line":"API Claude: 0 oggi"},
      "credits":{"Claude · a":{"remaining":40,"limit":250,"renewsAt":"2026-11-05","models":[{"name":"Fable","pct":12}]},"Codex · b":{"nobonus":true}}}"#;
    const LIVE: &str = r#"{"projects":[{"name":"topics-app","title":"Topics","total":11.4,"state":"attivo","priority":"normale","budgetPct":null,
      "agents":{"list":[{"kind":"sessione","title":"Stato chiamate","open":{"url":"claude://claude.ai/epitaxy/local_1"}},{"kind":"sessione","title":"Senza finestra"}]},
      "topics":[{"title":"Chat di prova"}],"lastJob":{"task":"Revisione card","status":"done"}}]}"#;

    fn full_snap() -> Snapshot {
        Snapshot {
            board: Some(BOARD.into()),
            overview: Some(OVERVIEW.into()),
            heavy: Some(r#"{"today":[{"account":"Claude · a","last24h":57,"perDay":3.7},{"account":"Muse","last24h":2,"perDay":0}]}"#.into()),
            procs: Some(PROCS.into()),
            automations: Some(r#"{"needsYou":5,"broken":3,"calendar":{"count":39,"next":{"title":"Rinnovo"}}}"#.into()),
            live: Some(LIVE.into()),
            gates: Some(r#"{"providers":{"claude":{"state":"libero"}},"overrides":[{"provider":"claude","until":1}]}"#.into()),
            backup: None,
            backup_set: true,
        }
    }

    #[test]
    fn plain_install_has_no_hub_section_until_the_service_answers() {
        let none = Snapshot::default();
        assert!(build_menu(&none, Prefs::default(), 0, false).is_empty());
        let t = dump_text(&build_menu(&none, Prefs::default(), 0, true));
        assert!(t.contains("Servizio quote: offline"));
    }

    #[test]
    fn service_down_keeps_backup_when_configured() {
        let snap = Snapshot { backup: Some(r#"{"last_ok":1800000000,"last_error":null}"#.into()), backup_set: true, ..Default::default() };
        let t = dump_text(&build_menu(&snap, Prefs::default(), 1_800_000_000, true));
        assert!(t.contains("Servizio quote: offline") && t.contains("Backup · tutto a posto"));
        assert!(!t.contains("Processi"));
        let t = dump_text(&build_menu(&snap, Prefs::default(), 1_800_000_000, false));
        assert!(t.contains("Backup · tutto a posto") && !t.contains("offline"));
        let unset = Snapshot { backup_set: false, ..Default::default() };
        assert!(build_menu(&unset, Prefs::default(), 0, true).iter().all(|n| !dump_text(std::slice::from_ref(n)).contains("Backup")));
    }

    #[test]
    fn full_menu_has_every_section() {
        let t = dump_text(&build_menu(&full_snap(), Prefs { five_hour: true, ..Default::default() }, 0, true));
        for want in ["Claude · a · 39% · frenato fino a lun", "Codex · b · 5% · libero · non risponde", "Ritmo di oggi", "Claude · a · 57% in 24 h", "Processi", "Apri Processi",
            "Topics · 11.4%", "sessione · Stato chiamate", "Chat Topics · Chat di prova", "Ultimo lavoro · Revisione card · done", "Priorità normale ✓", "Rinnovi",
            "rinnovo 2026-11-23", "Togli lo sblocco di claude", "Ferma i lavori nuovi", "Fascia 5 ore ✓", "Automazioni · 5 ti aspettano · 3 rotte", "In calendario · 39 · prossimo: Rinnovo", "Backup · nessun dato"] {
            assert!(t.contains(want), "manca «{want}» in:\n{t}");
        }
        assert!(!t.contains("Mac e PC"), "the machine rows are drawn by the Topics tray, not here");
    }

    #[test]
    fn each_switch_changes_what_the_menu_shows() {
        let show = |p: Prefs| dump_text(&build_menu(&full_snap(), p, 0, true));
        let off = Prefs { five_hour: false, api_credit: false, cloud_bonus: false };
        assert!(!show(off).contains("5 ore 61%") && show(Prefs { five_hour: true, ..off }).contains("5 ore 61% · libera tra 2h10"));
        assert!(!show(off).contains("API Claude") && show(Prefs { api_credit: true, ..off }).contains("API Claude: 0 oggi"));
        let on = show(Prefs { cloud_bonus: true, ..off });
        assert!(!show(off).contains("Credito AI") && on.contains("Bonus Claude · a · 40 su 250 rimasti · scade 2026-11-05") && on.contains("Fable 12%"));
    }

    fn clickable_ids(nodes: &[Node], out: &mut Vec<String>) {
        for n in nodes {
            match n {
                Node::Item { id, enabled: true, .. } if !id.is_empty() => out.push(id.clone()),
                Node::Sub { children, .. } => clickable_ids(children, out),
                _ => {}
            }
        }
    }

    #[test]
    fn every_clickable_row_does_something() {
        let snap = full_snap();
        let mut ids = Vec::new();
        clickable_ids(&build_menu(&snap, Prefs::default(), 0, true), &mut ids);
        assert!(ids.iter().any(|i| i.starts_with("proj-open:")) && ids.iter().any(|i| i.starts_with("session-open:")) && ids.contains(&"open:processes".to_string()));
        let dead: Vec<&String> = ids.iter().filter(|i| action_for(i, &snap.procs).is_none()).collect();
        assert!(dead.is_empty(), "rows that do nothing on click: {dead:?}");
        assert_eq!(action_for("proj-open:topics-app", &None), Some(Action::Open("project:topics-app".into())));
        assert_eq!(action_for("session-open:file:///etc/passwd", &None), None);
    }

    #[test]
    fn an_exhausted_unlock_is_not_offered_for_revoking() {
        let g = Some(r#"{"providers":{"claude":{"state":"frenato"}},"overrides":[{"provider":"claude","exhausted":true}]}"#.to_string());
        let t = dump_text(&brake_nodes(&g));
        assert!(t.contains("Sblocca claude per 2 ore") && !t.contains("Togli lo sblocco"));
    }

    #[test]
    fn close_waits_for_the_yes_and_rereads_the_census() {
        let p = Some(PROCS.to_string());
        let mut killed: Vec<u32> = Vec::new();
        // no yes: the census is not even read, nothing is signalled
        let n = close_confirmed(false, || panic!("no read without a yes"), Some("agent:1"), &[91001, 91002], |p| { killed.extend_from_slice(p); p.len() });
        assert_eq!((n, killed.len()), (0, 0));
        // yes, same census: both pids
        let n = close_confirmed(true, || p.clone(), Some("agent:1"), &[91001, 91002], |p| { killed.extend_from_slice(p); p.len() });
        assert_eq!((n, killed.clone()), (2, vec![91001, 91002]));
        // yes, but the unit lost one pid and another unit now owns nothing: only the survivor
        let fresh = Some(PROCS.replace("[91001,91002]", "[91002]"));
        assert_eq!(still_closable(&fresh, Some("agent:1"), &[91001, 91002]), vec![91002]);
        // the unit is gone or no longer closable: nothing
        assert!(still_closable(&Some(r#"{"units":[]}"#.into()), Some("agent:1"), &[91001]).is_empty());
        assert!(still_closable(&None, None, &[91050]).is_empty());
        assert_eq!(still_closable(&p, None, &[91050, 5]), vec![91050]);
    }

    #[test]
    fn prefs_round_trip() {
        let dir = std::env::temp_dir().join(format!("tray-prefs-{}", std::process::id()));
        let f = dir.join("p.json");
        assert!(load_prefs(&f).five_hour);
        let p = toggle_pref(&f, "api-credit");
        assert!(p.api_credit && load_prefs(&f).api_credit);
        assert!(!toggle_pref(&f, "five-hour").five_hour);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Dumps the menu as text for the bar scripts, from the live service or, with
    /// TRAY_MENU_FIXTURES=<dir>, from board.json, procs.json, backup.json in that dir
    /// (a missing file = that endpoint is down):
    /// TRAY_MENU_DUMP=1 [TRAY_MENU_FIXTURES=dir] cargo test dump_live -- --nocapture
    #[test]
    fn dump_live() {
        if std::env::var("TRAY_MENU_DUMP").is_err() {
            return;
        }
        let snap = match std::env::var("TRAY_MENU_FIXTURES") {
            Ok(dir) => {
                let f = |n: &str| std::fs::read_to_string(std::path::Path::new(&dir).join(n)).ok();
                Snapshot { board: f("board.json"), procs: f("procs.json"), backup: f("backup.json"), backup_set: true, ..Default::default() }
            }
            Err(_) => Snapshot::fetch(&crate::tray_quota::hub_base(), backup_state_path().as_deref()),
        };
        let now = std::env::var("TRAY_MENU_NOW").ok().and_then(|n| n.parse().ok()).unwrap_or_else(|| {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
        });
        println!("---MENU---\n{}---END---", dump_text(&build_menu(&snap, Prefs::default(), now, true)));
    }
}
