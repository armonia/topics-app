//! The macOS tray menu in the order and look of the original tray: machine cards,
//! the quota panel, one line per provider that does not answer, the projects
//! table, the options, automations, calendar and the backup card. Pure: service
//! answers in, `Node`s out (the cards already drawn). Card 1aba05b4.

use crate::tray_menu::{automation_nodes, brake_nodes, extras_nodes, item, n, note, parse, s, sub, tick, Node, Prefs, Snapshot};
use crate::tray_menu_pic::Palette;
use crate::tray_menu_views::{backup_card, draw_backup_card, draw_machine_card, draw_quota_panel, machine_cards_from_board, quota_cards, MachineCard};
use serde_json::Value;

fn card(key: &str, pic: crate::tray_menu_pic::Pic, children: Vec<Node>) -> Option<Node> {
    Some(Node::Card { key: key.into(), png: pic.to_png()?, w: pic.w, h: pic.h, children })
}

/// Every machine card, the same graphic for all of them. The submenu of a machine
/// holds its lines; the local one also the processes that weigh and the finder.
fn machine_nodes(machines: &[MachineCard], snap: &Snapshot, p: Palette) -> Vec<Node> {
    machines
        .iter()
        .filter_map(|m| {
            let mut kids: Vec<Node> = m.lines.iter().map(note).collect();
            if m.local {
                if !kids.is_empty() {
                    kids.push(Node::Sep);
                }
                kids.extend(crate::tray_menu::procs_nodes(&snap.procs));
            }
            if !kids.is_empty() {
                kids.push(Node::Sep);
            }
            kids.push(item(&format!("machine-open:{}", m.id), "Cerca in una finestra…"));
            card(&format!("machine:{}", m.id), draw_machine_card(m, p), kids)
        })
        .collect()
}

/// A line per provider whose quota could not be read.
fn unreachable_nodes(overview: &Option<String>) -> Vec<Node> {
    let v = parse(overview);
    v.get("providers").and_then(Value::as_array).into_iter().flatten()
        .filter(|p| p.get("error").map_or(false, |e| !e.is_null()))
        .map(|p| note(format!("{} non raggiungibile", s(p, "name"))))
        .collect()
}

fn comma(v: f64, digits: usize) -> String {
    format!("{v:.digits$}").replace('.', ",")
}

/// Tokens in the last hour of a project's live agents, short: 12k, 1,4M.
fn tokens_short(t: f64) -> String {
    if t >= 1e6 { format!("{}M", comma(t / 1e6, 1)) } else if t >= 1e3 { format!("{}k", (t / 1e3).round() as i64) } else { format!("{}", t as i64) }
}

fn working(p: &Value) -> bool {
    p.get("agents").and_then(|a| a.get("count")).and_then(Value::as_i64).unwrap_or(0) > 0
}

/// The projects table: a header row, then one row per project, who works first.
fn project_table(live: &Option<String>) -> Vec<Node> {
    let v = parse(live);
    let Some(ps) = v.get("projects").and_then(Value::as_array) else { return vec![note("Progetti: il servizio non risponde")] };
    let mut rows: Vec<&Value> = ps.iter().filter(|p| !p.get("dead").and_then(Value::as_bool).unwrap_or(false)).collect();
    rows.sort_by_key(|p| !working(p));
    let busy = rows.iter().filter(|p| working(p)).count();
    let mut out = vec![Node::Row {
        id: String::new(),
        cells: ["PROGETTI", "Claude", "Codex", "Muse", "ritmo/h", "stato"].map(String::from).to_vec(),
        header: true,
        children: Vec::new(),
    }];
    out.push(note(if busy == 0 { "nessun lavoro in corso · consumo in % della settimana".to_string() } else { format!("{busy} progetti al lavoro su {} · consumo in % della settimana", rows.len()) }));
    for p in rows {
        let name = s(p, "name");
        let hour: f64 = p.get("agents").and_then(|a| a.get("list")).and_then(Value::as_array).into_iter().flatten()
            .map(|a| a.get("use").map_or(0.0, |u| n(u, "hourTokens"))).sum();
        let pct = |k: &str| if n(p, k) > 0.0 { comma(n(p, k), 1) } else { "–".into() };
        let shown = Some(s(p, "title")).filter(|d| !d.is_empty()).or(Some(s(p, "display")).filter(|d| !d.is_empty())).unwrap_or(name);
        let mut kids = vec![note(format!("{} · consumi {}%", s(p, "state"), comma(n(p, "total"), 1))), note(match p.get("budgetPct").and_then(Value::as_i64) { Some(b) => format!("Budget {b}%"), None => "Budget: nessuno".into() }), Node::Sep];
        for b in [0, 10, 25, 50] {
            kids.push(item(&format!("proj-budget:{name}:{b}"), if b == 0 { "Togli il budget".to_string() } else { format!("Budget {b}%") }));
        }
        kids.push(Node::Sep);
        let cur = s(p, "priority");
        for pr in ["alta", "normale", "bassa"] {
            kids.push(item(&format!("proj-priority:{name}:{pr}"), format!("Priorità {pr}{}", if pr == cur { " ✓" } else { "" })));
        }
        kids.push(Node::Sep);
        kids.extend(crate::tray_menu::project_work_nodes(p));
        kids.push(item(&format!("proj-open:{name}"), "Apri in Topics"));
        out.push(Node::Row {
            id: String::new(),
            cells: vec![shown.to_string(), pct("claude"), pct("codex"), pct("muse"), if hour > 0.0 { tokens_short(hour) } else { "–".into() }, s(p, "state").to_string()],
            header: false,
            children: kids,
        });
    }
    out
}

/// The rich menu. `machines` are the cards to draw (the Topics machine list, or
/// the service's own when there is none); `dark` picks the ink for the menu surface.
pub fn build_menu_rich(snap: &Snapshot, prefs: Prefs, now: i64, machines: &[MachineCard], dark: bool) -> Vec<Node> {
    let p = Palette::new(dark);
    let mut m = machine_nodes(machines, snap, p);
    if !m.is_empty() {
        m.push(Node::Sep);
    }
    if let Some(panel) = snap.board.as_deref().and_then(|b| draw_quota_panel(&quota_cards(b), p)) {
        m.extend(card("quota", panel, Vec::new()));
    }
    m.extend(unreachable_nodes(&snap.overview));
    m.push(Node::Sep);
    m.extend(project_table(&snap.live));
    m.push(Node::Sep);
    let mut more = brake_nodes(&snap.gates);
    more.push(Node::Sep);
    more.extend(extras_nodes(&snap.overview, prefs));
    more.push(item("pref:five-hour", tick("Fascia 5 ore", prefs.five_hour)));
    more.push(item("pref:api-credit", tick("Credito API", prefs.api_credit)));
    more.push(item("pref:cloud-bonus", tick("Bonus cloud", prefs.cloud_bonus)));
    more.push(Node::Sep);
    more.push(item("tray-new-chat", "Nuova chat"));
    more.push(item("tray-check-updates", "Controlla aggiornamenti"));
    m.push(sub("Altri abbonamenti e opzioni", more));
    m.extend(automation_nodes(&snap.automations));
    if let Some(b) = snap.backup.as_deref().and_then(|b| backup_card(b, now)) {
        m.push(Node::Sep);
        m.extend(card("backup", draw_backup_card(&b, p), Vec::new()));
    }
    m
}

/// The machines to draw: the client's list when it carries cards, else the service's.
pub fn machines_for(client: &[MachineCard], snap: &Snapshot) -> Vec<MachineCard> {
    if !client.is_empty() {
        return client.to_vec();
    }
    snap.board.as_deref().map(machine_cards_from_board).unwrap_or_default()
}

#[cfg(test)]
#[path = "tray_menu_rich_tests.rs"]
mod tests;
