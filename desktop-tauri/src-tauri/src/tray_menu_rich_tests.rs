//! The rich menu from fake service answers: order of the sections, the table, the
//! unreachable provider line and the clickable rows. Card 1aba05b4.

use super::*;
use crate::tray_menu::{action_for, dump_text};

const BOARD: &str = r#"{"machines":[
 {"id":"local","name":"Machine A","state":"impegnato","level":1,"lines":["CPU intasata"],"metrics":[{"key":"cpu","pct":55,"level":1,"note":"x"}]},
 {"id":"pc","name":"Machine B","state":"dorme","level":0,"lines":[],"metrics":[]}],
 "accounts":[{"provider":"claude","email":"a@example.org","used":40,"state":{"text":"in ritmo","tone":"ok"},"windows":[{"key":"week","label":"7 g","used":40,"reset":"dom 10:00","tone":"ok"}]}]}"#;
const OVERVIEW: &str = r#"{"providers":[{"id":"claude","name":"Claude","accounts":[]},{"id":"codex","name":"Codex","error":"timeout","accounts":[]}]}"#;
const LIVE: &str = r#"{"projects":[
 {"name":"idle","title":"Idle one","claude":0,"codex":0,"muse":0,"total":0,"state":"fermo","priority":"normale","agents":{"count":0,"list":[]}},
 {"name":"busy","title":"Busy one","claude":0.4,"codex":11.5,"muse":26.3,"total":38.2,"state":"attivo","priority":"alta","agents":{"count":1,"list":[{"kind":"x","title":"t","use":{"hourTokens":12000}}]}},
 {"name":"gone","dead":true,"title":"Gone","claude":0,"codex":0,"muse":0,"total":0,"state":"x","agents":{"count":0,"list":[]}}]}"#;
const BACKUP: &str = r#"{"last_ok":1799990000,"runs":[{"at":1799990000,"ok":true}]}"#;

fn snap() -> Snapshot {
    Snapshot {
        board: Some(BOARD.into()),
        overview: Some(OVERVIEW.into()),
        live: Some(LIVE.into()),
        automations: Some(r#"{"needsYou":5,"broken":2,"calendar":{"count":3}}"#.into()),
        backup: Some(BACKUP.into()),
        backup_set: true,
        ..Default::default()
    }
}

fn menu() -> Vec<Node> {
    let sn = snap();
    let machines = machines_for(&[], &sn);
    build_menu_rich(&sn, Prefs::default(), 1_800_000_000, &machines, true)
}

#[test]
fn sections_come_in_the_order_of_the_original_menu() {
    let t = dump_text(&menu());
    let at = |w: &str| t.find(w).unwrap_or_else(|| panic!("missing «{w}» in:\n{t}"));
    let order = ["[card machine:local]", "[card machine:pc]", "[card quota]", "Codex non raggiungibile", "PROGETTI", "Altri abbonamenti e opzioni", "Automazioni", "In calendario", "[card backup]"];
    let pos: Vec<usize> = order.iter().map(|w| at(w)).collect();
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "wrong order: {pos:?}");
}

#[test]
fn the_projects_table_puts_the_working_one_first_and_hides_dead_ones() {
    let t = dump_text(&project_table(&Some(LIVE.into()), &None, 1_800_000_000));
    assert!(t.starts_with("PROGETTI | Claude | Codex | Muse | ritmo/h | stato"));
    let (busy, idle) = (t.find("Busy one").unwrap(), t.find("Idle one").unwrap());
    assert!(busy < idle && !t.contains("Gone"));
    assert!(t.contains("Busy one | 0,4 | 11,5 | 26,3 | 12k | attivo"), "{t}");
    assert!(t.contains("Idle one | – | – | – | – | fermo"));
}

const MACHINES: &str = r#"[{"id":"pc","lines":["Si sta addormentando"],"metrics":[{"key":"cpu","name":"CPU","pct":40,"level":0,"note":"adesso","history":[{"t":1,"v":10}]}],"timeline":{"window":100,"segments":[{"t0":0,"t1":100,"state":"lavora"}]}}]"#;

#[test]
fn a_remote_machine_submenu_holds_the_graphic_detail_not_just_text() {
    let sn = Snapshot { machines: Some(MACHINES.into()), ..snap() };
    let t = dump_text(&build_menu_rich(&sn, Prefs::default(), 1_800_000_000, &machines_for(&[], &sn), true));
    assert!(t.contains("[card machine-detail:pc]"), "{t}");
    assert!(!t.contains("Si sta addormentando"), "the lines live in the card");
    let plain = dump_text(&menu());
    assert!(!plain.contains("machine-detail") && plain.contains("[card machine:pc]"));
}

#[test]
fn the_project_submenu_has_week_today_last_job_and_budget_and_priority() {
    let live = r#"{"projects":[{"name":"p","title":"P","claude":44.9,"codex":0.4,"muse":0,"total":45.3,"state":"attivo","priority":"alta","budgetPct":10,
      "lastJob":{"task":"fix it","status":"done","endedAt":1799999400000},"agents":{"count":0,"list":[]}}]}"#;
    let heavy = r#"{"sessions":[{"project":"p","sessions":14,"tokens":451644590}]}"#;
    let t = dump_text(&project_table(&Some(live.into()), &Some(heavy.into()), 1_800_000_000));
    assert!(t.contains("Questa settimana | Claude 44,9% | Codex 0,4% | Muse –"), "{t}");
    assert!(t.contains("Oggi · 14 sessioni Claude · 451,6 M token"), "{t}");
    assert!(t.contains("Ultimo lavoro in coda · fix it · 10 min fa"), "{t}");
    assert!(t.contains("Budget e priorità · budget 10% Claude · priorità alta"), "{t}");
    assert!(t.contains("Apri in Topics") && t.contains("Budget 25%") && t.contains("Priorità alta ✓"), "the new rows stay");
    assert_eq!(t.matches("Ultimo lavoro").count(), 1, "no second copy: {t}");
}

#[test]
fn the_options_open_with_the_subscription_limits_and_the_menu_ends_with_the_dashboard() {
    let t = dump_text(&menu());
    let (opts, limits) = (t.find("Altri abbonamenti e opzioni").unwrap(), t.find("Limiti degli abbonamenti · nessun limite raggiunto").unwrap());
    assert!(limits > opts && limits < t.find("Nuova chat").unwrap(), "{t}");
    assert!(t.trim_end().ends_with("Apri dashboard"), "{t}");
    assert!(matches!(action_for("dashboard-open", &None), Some(crate::tray_menu::Action::OpenUrl(u)) if u.starts_with("http")));
}

#[test]
fn a_section_without_data_is_not_drawn() {
    let bare = Snapshot { live: Some(LIVE.into()), ..Default::default() };
    let t = dump_text(&build_menu_rich(&bare, Prefs::default(), 0, &[], true));
    assert!(!t.contains("[card"), "no cards without machines, quotas or backup:\n{t}");
    assert!(!t.contains("non raggiungibile"));
}

#[test]
fn local_machine_lists_its_processes_and_every_card_can_open_the_finder() {
    let sn = Snapshot { procs: Some(r#"{"units":[]}"#.into()), ..snap() };
    let machines = machines_for(&[], &sn);
    let nodes = machine_nodes(&machines, &sn, Palette::new(false));
    let t = dump_text(&nodes);
    assert!(t.contains("CPU intasata") && t.matches("Cerca in una finestra…").count() == 2, "{t}");
}

#[test]
fn every_clickable_row_has_an_action_or_is_a_tray_row() {
    fn ids(nodes: &[Node], out: &mut Vec<String>) {
        for n in nodes {
            match n {
                Node::Item { id, enabled: true, .. } if !id.is_empty() => out.push(id.clone()),
                Node::Sub { children, .. } | Node::Card { children, .. } | Node::Row { children, .. } => ids(children, out),
                _ => {}
            }
        }
    }
    let mut found = Vec::new();
    ids(&menu(), &mut found);
    assert!(found.iter().any(|i| i.starts_with("proj-open:")));
    let tray_rows = ["tray-new-chat", "tray-check-updates"];
    let dead: Vec<&String> = found.iter().filter(|i| !tray_rows.contains(&i.as_str()) && !i.starts_with("machine-open:") && action_for(i, &None).is_none()).collect();
    assert!(dead.is_empty(), "rows that do nothing: {dead:?}");
}

#[test]
fn the_client_machines_join_the_service_ones_without_doubles() {
    let card = |id: &str, name: &str, local: bool| MachineCard { id: id.into(), name: name.into(), local, badge: "Acceso".into(), ..Default::default() };
    let service: Vec<String> = machines_for(&[], &snap()).iter().map(|m| m.id.clone()).collect();
    assert_eq!(service[0], "local");
    // this computer and a machine the service already names stay the service's; a node it does not know is added after
    let names: Vec<String> = machines_for(&[], &snap()).iter().map(|m| m.name.clone()).collect();
    let client = vec![card("me", "anything", true), card("twin", &names[names.len() - 1].to_uppercase(), false), card("n1", "Node", false)];
    let ids: Vec<String> = machines_for(&client, &snap()).iter().map(|m| m.id.clone()).collect();
    let mut want = service.clone();
    want.push("n1".into());
    assert_eq!(ids, want);
    // with no service there is nothing to merge: the client list is the menu
    let none = Snapshot { board: None, ..snap() };
    assert_eq!(machines_for(&client, &none).len(), 3);
}
