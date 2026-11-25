//! The macOS tray menu in the order and look of the original tray: machine cards,
//! the quota panel, one line per provider that does not answer, the projects
//! table, the options, automations, calendar and the backup card. Pure: service
//! answers in, `Node`s out (the cards already drawn). Card 1aba05b4.

use crate::tray_menu::{automation_nodes, brake_nodes, extras_nodes, item, local_offset_secs, machine_action_id, note, parse, s, sub, tick, with_icon, Node, Prefs, Snapshot};
use crate::tray_menu_projects::project_table;
use crate::tray_menu_detail::{machine_details, MachineDetail, Segment};
use crate::tray_menu_pic::Palette;
use crate::tray_menu_procs::{procs_table, remote_procs_table};
use crate::tray_node_charts::{submenu_nodes, NodeData};
use crate::tray_menu_views::{backup_card, draw_backup_card, draw_machine_card_with, draw_quota_panel, machine_cards_from_board, quota_cards, MachineCard};
use serde_json::Value;

fn card(key: &str, pic: crate::tray_menu_pic::Pic, children: Vec<Node>) -> Option<Node> {
    Some(Node::Card { key: key.into(), png: pic.to_png()?, w: pic.w, h: pic.h, hover: pic.hover.clone(), children })
}

/// How long a state lasted, in words: «21 h 40 min», «5 min».
fn span_text(secs: f64) -> String {
    let mins = (secs / 60.0).round() as u64;
    match (mins / 60, mins % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// The words for a state of the machine in the day's account: «acceso» alone reads as the time it was on, which allow-italian: quoted menu wording
/// «al lavoro» is part of, so it says what it is: on, with nothing to do. allow-italian: quoted menu wording
fn state_say(state: &str) -> &str {
    match state {
        "lavora" => "al lavoro",
        "acceso" => "acceso senza lavoro",
        other => other,
    }
}

/// Where the machine's state spent the window the service logged, longest first: «al lavoro 21 h · dorme 2 h». allow-italian: quoted menu wording
/// The states split the window between them, so the line says «nelle ultime 24 h» and no state is a total. allow-italian: quoted menu wording
/// `None` when it logged nothing. Times in milliseconds are read as such.
fn timeline_say(segments: &[Segment]) -> Option<String> {
    let secs = |t: f64| if t > 1e11 { t / 1000.0 } else { t };
    let mut spent: Vec<(String, f64)> = Vec::new();
    for g in segments {
        let len = (secs(g.t1) - secs(g.t0)).max(0.0);
        match spent.iter_mut().find(|(s, _)| *s == g.state) {
            Some(e) => e.1 += len,
            None => spent.push((g.state.clone(), len)),
        }
    }
    spent.retain(|(_, l)| *l >= 30.0);
    spent.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    (!spent.is_empty()).then(|| format!("Nelle ultime 24 h · {}", spent.iter().take(3).map(|(s, l)| format!("{} {}", state_say(s), span_text(*l))).collect::<Vec<_>>().join(" · ")))
}

/// How a machine read from afar went through the day, as the original tray's remote submenu opens. The readings
/// themselves (CPU, memory, disk, spend) are the card's: said again here they were two figures for one thing.
pub(crate) fn remote_reading_nodes(detail: Option<&MachineDetail>) -> Vec<Node> {
    let Some(d) = detail else { return Vec::new() };
    timeline_say(&d.timeline).map(|l| with_icon("sf:clock", note(l))).into_iter().collect()
}

/// The commands the service offers on a machine (Hetzner: «Spegni tutti»): one row each, with the power allow-italian: quoted menu wording
/// symbol, that asks before it calls. The id carries everything the dialog and the call need.
pub(crate) fn machine_action_nodes(machine: &MachineCard, detail: Option<&MachineDetail>) -> Vec<Node> {
    detail.map_or(&[][..], |d| &d.actions[..]).iter().map(|a| {
        let id = machine_action_id(&machine.name, &a.method, &a.url, &a.label, &a.confirm);
        with_icon("sf:power", item(&id, format!("{}…", a.label)))
    }).collect()
}

/// Every machine card, the same graphic for all of them, and the same submenu as the
/// MacBook's: its state lines, the processes that weigh in the same table, the
/// commands of the machine, the finder. This computer takes its own census (`/api/mac/procs`);
/// the others the service's `procs`.
fn machine_nodes(machines: &[MachineCard], snap: &Snapshot, now: i64, p: Palette) -> Vec<Node> {
    let details = snap.machines.as_deref().map(machine_details).unwrap_or_default();
    let (offset, data) = (local_offset_secs(), NodeData::from_snapshot(snap, now, local_offset_secs()));
    machines
        .iter()
        .filter_map(|m| {
            let found = details.iter().find(|d| d.id == m.id && !m.id.is_empty());
            let extras = data.extras(m, &details, now, offset);
            // what the node files say first (security, charts), then the readings and the processes
            let mut kids: Vec<Node> = m.agents.as_ref().map(|a| crate::tray_node_agents::submenu_nodes(a, now)).unwrap_or_default();
            kids.push(Node::Sep);
            kids.extend(submenu_nodes(&extras, &m.id, p, offset));
            kids.push(Node::Sep);
            if !m.local {
                kids.extend(remote_reading_nodes(found));
            }
            // the service's lines, minus the one the card already says under the name
            kids.extend(m.lines.iter().filter(|l| **l != m.reason).map(note));
            // a separator between groups, never two in a row and none at the ends
            kids.push(Node::Sep);
            let procs = if m.local { procs_table(snap) } else { remote_procs_table(found) };
            if !procs.is_empty() {
                kids.extend(procs);
                kids.push(Node::Sep);
            }
            if !m.local {
                kids.extend(machine_action_nodes(m, found));
            }
            kids.push(with_icon("sf:magnifyingglass", item(&format!("machine-open:{}", m.id), "Cerca in una finestra…")));
            let kids = tidy_separators(kids);
            card(&format!("machine:{}", m.id), draw_machine_card_with(m, &extras, p), kids)
        })
        .collect()
}

/// Separators only between two rows: none at the start or the end, one where a run of them was.
fn tidy_separators(nodes: Vec<Node>) -> Vec<Node> {
    let mut out: Vec<Node> = Vec::new();
    for n in nodes {
        if matches!(n, Node::Sep) && matches!(out.last(), None | Some(Node::Sep)) {
            continue;
        }
        out.push(n);
    }
    if matches!(out.last(), Some(Node::Sep)) {
        out.pop();
    }
    out
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
        let line = note(format!("{} · {}", s(a, "label"), s(&g, "short")));
        kids.push(match s(a, "provider") {
            p @ ("claude" | "codex" | "muse") => crate::tray_menu::with_icon(&format!("provider:{p}"), line),
            _ => line,
        });
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
    let mut m = machine_nodes(machines, snap, now, p);
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
    more.push(item("pref:cloud-bonus", tick("Quote per modello", prefs.cloud_bonus)));
    more.push(Node::Sep);
    more.push(item("tray-new-chat", "Nuova chat"));
    more.push(item("tray-check-updates", "Controlla aggiornamenti"));
    m.push(crate::tray_menu::with_icon("sf:slider.horizontal.3", sub("Altri abbonamenti e opzioni", more)));
    m.extend(automation_nodes(&snap.automations, now, local_offset_secs()));
    if let Some(b) = snap.backup.as_deref().and_then(|b| backup_card(b, now)) {
        m.push(Node::Sep);
        m.extend(card("backup", draw_backup_card(&b, p), Vec::new()));
    }
    // this menu is only drawn while the service answers, so its dashboard is always one click away
    m.push(Node::Sep);
    m.push(crate::tray_menu::with_icon("sf:macwindow", item("dashboard-open", "Apri dashboard")));
    m
}

/// The board has no history of its readings; `/api/machines` has, and it says how far back it really goes, which a
/// «peak of 24 h» must not claim beyond.
pub(crate) fn attach_histories(cards: &mut [MachineCard], machines: Option<&str>) {
    let rows: Value = machines.and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null);
    let Some(rows) = rows.as_array() else { return };
    for c in cards.iter_mut() {
        let Some(row) = rows.iter().find(|r| s(r, "id") == c.id) else { continue };
        for m in &mut c.metrics {
            if let Some(x) = row.get("metrics").and_then(Value::as_array).and_then(|a| a.iter().find(|x| s(x, "key") == m.key)) {
                (m.hist_n, m.hist_span_s, m.hist_peak) = crate::tray_menu_views::hist_of(x);
            }
        }
    }
}

/// The machines to draw: the service's cards (it reads this computer and its own
/// machines in more depth), then every machine of the client's list the service
/// does not describe, so a cloud node gets the same card as the Mac. A client card
/// is the service's own when both are this computer or both carry the same name.
pub fn machines_for(client: &[MachineCard], snap: &Snapshot) -> Vec<MachineCard> {
    let mut service = snap.board.as_deref().map(machine_cards_from_board).unwrap_or_default();
    attach_histories(&mut service, snap.machines.as_deref());
    let known = |c: &MachineCard| service.iter().any(|s| (c.local && s.local) || s.name.trim().eq_ignore_ascii_case(c.name.trim()));
    // a node of the client's list that answers nothing and has no reading to show is not a node worth a card
    let extra: Vec<MachineCard> = client.iter().filter(|c| !known(c) && !(c.level >= 2 && c.metrics.iter().all(|m| m.pct.is_none()))).cloned().collect();
    // the service's own card may carry another id than the Topics machine of the same name: remember it for the node files
    let all: Vec<MachineCard> = service.into_iter().map(|mut c| {
        c.machine_id = client.iter().find(|x| !c.local && x.name.trim().eq_ignore_ascii_case(c.name.trim())).map(|x| x.id.clone()).unwrap_or_default();
        c
    }).chain(extra).collect();
    let pool = snap.pool.as_deref().map(crate::tray_nodes::parse_pool).unwrap_or_default();
    let details = snap.machines.as_deref().map(machine_details).unwrap_or_default();
    crate::tray_nodes::arrange(all, client, &pool, &details, local_offset_secs())
}

#[cfg(test)]
#[path = "tray_menu_rich_tests.rs"]
mod tests;
