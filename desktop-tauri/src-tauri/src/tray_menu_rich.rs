//! The macOS tray menu in the order and look of the original tray: machine cards,
//! the quota panel, one line per provider that does not answer, the projects
//! table, the options, automations, calendar and the backup card. Pure: service
//! answers in, `Node`s out (the cards already drawn). Card 1aba05b4.

use crate::tray_menu::{automation_nodes, brake_nodes, extras_nodes, item, local_offset_secs, note, parse, s, sub, tick, Node, Prefs, Snapshot};
use crate::tray_menu_projects::project_table;
use crate::tray_menu_detail::{draw_machine_detail, has_graphics, machine_details};
use crate::tray_menu_pic::Palette;
use crate::tray_menu_procs::procs_table;
use crate::tray_menu_views::{backup_card, draw_backup_card, draw_machine_card, draw_quota_panel, machine_cards_from_board, quota_cards, MachineCard};
use serde_json::Value;

fn card(key: &str, pic: crate::tray_menu_pic::Pic, children: Vec<Node>) -> Option<Node> {
    Some(Node::Card { key: key.into(), png: pic.to_png()?, w: pic.w, h: pic.h, children })
}

/// Every machine card, the same graphic for all of them. The submenu of a machine
/// holds its lines; the local one also the processes that weigh and the finder.
fn machine_nodes(machines: &[MachineCard], snap: &Snapshot, p: Palette) -> Vec<Node> {
    let details = snap.machines.as_deref().map(machine_details).unwrap_or_default();
    machines
        .iter()
        .filter_map(|m| {
            let mut kids: Vec<Node> = Vec::new();
            // the graphs of the service's own reading: bars, 24 h charts, the state band
            let detail = details.iter().find(|d| d.id == m.id && !m.id.is_empty()).filter(|d| has_graphics(d) && !m.local);
            if let Some(d) = detail {
                let pic = draw_machine_detail(d, p);
                kids.extend(card(&format!("machine-detail:{}", m.id), pic, Vec::new()));
            } else {
                kids.extend(m.lines.iter().map(note));
            }
            if m.local {
                if !kids.is_empty() {
                    kids.push(Node::Sep);
                }
                kids.extend(procs_table(snap));
            }
            if !kids.is_empty() {
                kids.push(Node::Sep);
            }
            kids.push(item(&format!("machine-open:{}", m.id), "Cerca in una finestra…"));
            card(&format!("machine:{}", m.id), draw_machine_card(m, p), kids)
        })
        .collect()
}

/// The subscription limits entry of the original tray, first of the options.
/// Its detail line says how many subscriptions are at their limit; inside, every
/// account with its state, the sentence that explains it and since when it is linked.
fn limits_node(snap: &Snapshot) -> Node {
    let board = parse(&snap.board);
    let accounts: Vec<&Value> = board.get("accounts").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let at_limit = accounts.iter().filter(|x| x.get("gauge").map_or(false, |g| s(g, "zone") == "frenato")).count();
    let held = parse(&snap.gates).get("overrides").and_then(Value::as_array).map_or(false, |o| o.iter().any(|x| x.get("hold").and_then(Value::as_bool) == Some(true)));
    let say = match (at_limit, held) {
        (0, true) => "lavori nuovi fermi".to_string(),
        (0, false) => "nessun limite raggiunto".to_string(),
        (1, _) => "1 abbonamento al limite".to_string(),
        (k, _) => format!("{k} abbonamenti al limite"),
    };
    let mut kids: Vec<Node> = Vec::new();
    for a in &accounts {
        let g = a.get("gauge").cloned().unwrap_or(Value::Null);
        kids.push(note(format!("{} · {}", s(a, "label"), s(&g, "short"))));
        let sentence = Some(s(&g, "cardSay")).filter(|t| !t.is_empty()).unwrap_or(s(&g, "say"));
        if !sentence.is_empty() {
            kids.push(note(sentence));
        }
        if let Some(t) = a.get("access").map(|x| s(x, "say")).filter(|t| !t.is_empty()) {
            kids.push(note(t));
        }
    }
    if !kids.is_empty() {
        kids.push(Node::Sep);
    }
    kids.extend(brake_nodes(&snap.gates, !accounts.is_empty()));
    sub(format!("Limiti degli abbonamenti · {say}"), kids)
}

/// A line per provider whose quota could not be read.
fn unreachable_nodes(overview: &Option<String>) -> Vec<Node> {
    let v = parse(overview);
    v.get("providers").and_then(Value::as_array).into_iter().flatten()
        .filter(|p| p.get("error").map_or(false, |e| !e.is_null()))
        .map(|p| note(format!("{} non raggiungibile", s(p, "name"))))
        .collect()
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
    m.extend(project_table(&snap.live, &snap.heavy, now, local_offset_secs()));
    m.push(Node::Sep);
    let mut more = vec![limits_node(snap)];
    more.push(Node::Sep);
    more.extend(extras_nodes(&snap.overview, prefs));
    more.push(item("pref:five-hour", tick("Fascia 5 ore", prefs.five_hour)));
    more.push(item("pref:api-credit", tick("Credito API", prefs.api_credit)));
    more.push(item("pref:cloud-bonus", tick("Bonus cloud", prefs.cloud_bonus)));
    more.push(Node::Sep);
    more.push(item("tray-new-chat", "Nuova chat"));
    more.push(item("tray-check-updates", "Controlla aggiornamenti"));
    m.push(sub("Altri abbonamenti e opzioni", more));
    m.extend(automation_nodes(&snap.automations, now, local_offset_secs()));
    if let Some(b) = snap.backup.as_deref().and_then(|b| backup_card(b, now)) {
        m.push(Node::Sep);
        m.extend(card("backup", draw_backup_card(&b, p), Vec::new()));
    }
    // this menu is only drawn while the service answers, so its dashboard is always one click away
    m.push(Node::Sep);
    m.push(item("dashboard-open", "Apri dashboard"));
    m
}

/// The machines to draw: the service's cards (it reads this computer and its own
/// machines in more depth), then every machine of the client's list the service
/// does not describe, so a cloud node gets the same card as the Mac. A client card
/// is the service's own when both are this computer or both carry the same name.
pub fn machines_for(client: &[MachineCard], snap: &Snapshot) -> Vec<MachineCard> {
    let service = snap.board.as_deref().map(machine_cards_from_board).unwrap_or_default();
    let known = |c: &MachineCard| service.iter().any(|s| (c.local && s.local) || s.name.trim().eq_ignore_ascii_case(c.name.trim()));
    let extra: Vec<MachineCard> = client.iter().filter(|c| !known(c)).cloned().collect();
    service.into_iter().chain(extra).collect()
}

#[cfg(test)]
#[path = "tray_menu_rich_tests.rs"]
mod tests;
