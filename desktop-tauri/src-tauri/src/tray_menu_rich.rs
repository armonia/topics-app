//! The macOS tray menu in the order and look of the original tray: machine cards,
//! the quota panel, one line per provider that does not answer, the projects
//! table, the options, automations, calendar and the backup card. Pure: service
//! answers in, `Node`s out (the cards already drawn). Card 1aba05b4.

use crate::tray_menu::{automation_nodes, brake_nodes, extras_nodes, item, n, note, parse, s, sub, tick, Node, Prefs, Snapshot};
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
/// Its detail line says how many subscriptions are at their limit.
fn limits_node(snap: &Snapshot) -> Node {
    let at_limit = parse(&snap.board).get("accounts").and_then(Value::as_array).map(|a| a.iter().filter(|x| x.get("gauge").map_or(false, |g| s(g, "zone") == "frenato")).count()).unwrap_or(0);
    let held = parse(&snap.gates).get("overrides").and_then(Value::as_array).map_or(false, |o| o.iter().any(|x| x.get("hold").and_then(Value::as_bool) == Some(true)));
    let say = match (at_limit, held) {
        (0, true) => "lavori nuovi fermi".to_string(),
        (0, false) => "nessun limite raggiunto".to_string(),
        (1, _) => "1 abbonamento al limite".to_string(),
        (k, _) => format!("{k} abbonamenti al limite"),
    };
    sub(format!("Limiti degli abbonamenti · {say}"), brake_nodes(&snap.gates))
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
/// How long ago, in the service's own short words.
fn ago_text(now_ms: i64, at_ms: i64) -> String {
    let m = (now_ms - at_ms).max(0) / 60_000;
    match m {
        0 => "ora".into(),
        1..=59 => format!("{m} min fa"),
        60..=1439 => format!("{} h fa", m / 60),
        _ => format!("{} g fa", m / 1440),
    }
}

fn pct_short(v: f64) -> String {
    if v > 0.0 { format!("{}%", comma(v, 1)) } else { "–".into() }
}

/// The lines the original project submenu has and the first version of this one lacked:
/// the week per provider, today's sessions and tokens, the last queued job.
fn project_week_nodes(p: &Value, heavy: &Value, now: i64) -> Vec<Node> {
    let mut out = vec![
        Node::Row {
            id: String::new(),
            cells: vec!["Questa settimana".into(), format!("Claude {}", pct_short(n(p, "claude"))), format!("Codex {}", pct_short(n(p, "codex"))), format!("Muse {}", pct_short(n(p, "muse")))],
            header: false,
            children: Vec::new(),
        },
        note("% dell'abbonamento usato dai lavori di questo progetto"),
    ];
    let name = s(p, "name");
    if let Some(h) = heavy.get("sessions").and_then(Value::as_array).into_iter().flatten().find(|h| s(h, "project") == name) {
        out.push(note(format!("Oggi · {} sessioni Claude · {} M token", n(h, "sessions") as i64, comma(n(h, "tokens") / 1e6, 1))));
    }
    if let Some(j) = p.get("lastJob").filter(|j| !j.is_null()) {
        let when = j.get("endedAt").and_then(Value::as_i64).map(|t| format!(" · {}", ago_text(now * 1000, t))).unwrap_or_default();
        out.push(note(format!("Ultimo lavoro in coda · {}{}", s(j, "task"), when)));
    }
    out
}

fn project_table(live: &Option<String>, heavy: &Option<String>, now: i64) -> Vec<Node> {
    let v = parse(live);
    let heavy = parse(heavy);
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
        let mut kids = vec![note(format!("{} · consumi {}%", s(p, "state"), comma(n(p, "total"), 1)))];
        kids.extend(project_week_nodes(p, &heavy, now));
        kids.push(Node::Sep);
        let cur = s(p, "priority");
        let mut bp = vec![note(match p.get("budgetPct").and_then(Value::as_i64) { Some(b) => format!("Budget {b}%"), None => "Budget: nessuno".into() }), Node::Sep];
        for b in [0, 10, 25, 50] {
            bp.push(item(&format!("proj-budget:{name}:{b}"), if b == 0 { "Togli il budget".to_string() } else { format!("Budget {b}%") }));
        }
        bp.push(Node::Sep);
        for pr in ["alta", "normale", "bassa"] {
            bp.push(item(&format!("proj-priority:{name}:{pr}"), format!("Priorità {pr}{}", if pr == cur { " ✓" } else { "" })));
        }
        let say = format!("{} · priorità {cur}", p.get("budgetPct").and_then(Value::as_i64).map_or("nessun budget".to_string(), |b| format!("budget {b}% Claude")));
        kids.push(sub(format!("Budget e priorità · {say}"), bp));
        kids.push(Node::Sep);
        // the last job is already in the week block, with its age
        kids.extend(crate::tray_menu::project_work_nodes(p).into_iter().filter(|k| !matches!(k, Node::Item { label, .. } if label.starts_with("Ultimo lavoro ·"))));
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
    m.extend(project_table(&snap.live, &snap.heavy, now));
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
    m.extend(automation_nodes(&snap.automations));
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
