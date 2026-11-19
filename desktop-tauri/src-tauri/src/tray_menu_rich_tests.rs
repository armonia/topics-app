//! The rich menu from fake service answers: order of the sections, the table, the
//! unreachable provider line and the clickable rows. Card 1aba05b4.

use super::*;
use crate::tray_menu::{action_for, dump_text, Table};

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
    let t = dump_text(&project_table(&Some(LIVE.into()), &None, 1_800_000_000, 3600));
    assert!(t.starts_with("PROGETTI | Claude | Codex | Muse | ritmo/h | stato"));
    let (busy, idle) = (t.find("Busy one").unwrap(), t.find("Idle one").unwrap());
    assert!(busy < idle && !t.contains("Gone"));
    assert!(t.contains("Busy one | 0,4 | 11,5 | 26,3 | 12k | ▸ 1"), "{t}");
    assert!(t.contains("Idle one | – | – | – |  | –"));
}

#[test]
fn a_remote_machine_submenu_opens_with_its_state_lines_not_a_picture() {
    let machines = r#"[{"id":"pc","lines":["Si sta addormentando"],"metrics":[{"key":"cpu","pct":40,"history":[{"t":1,"v":10}]}],"timeline":{"window":100,"segments":[{"t0":0,"t1":100,"state":"lavora"}]}}]"#;
    let sn = Snapshot { machines: Some(machines.into()), ..snap() };
    let t = dump_text(&build_menu_rich(&sn, Prefs::default(), 1_800_000_000, &machines_for(&[], &sn), true));
    assert!(!t.contains("machine-detail") && t.contains("[card machine:pc]"), "{t}");
}

#[test]
fn the_project_submenu_has_week_today_last_job_and_budget_and_priority() {
    let live = r#"{"projects":[{"name":"p","title":"P","claude":44.9,"codex":0.4,"muse":0,"total":45.3,"state":"attivo","priority":"alta","budgetPct":10,
      "lastJob":{"task":"fix it","status":"done","endedAt":1799999400000},"agents":{"count":0,"list":[]}}]}"#;
    let heavy = r#"{"sessions":[{"project":"p","sessions":14,"tokens":451644590}]}"#;
    let t = dump_text(&project_table(&Some(live.into()), &Some(heavy.into()), 1_800_000_000, 3600));
    assert!(t.contains("Questa settimana | Claude 44,9% | Codex 0,4% | Muse –"), "{t}");
    assert!(t.contains("Oggi · 14 sessioni Claude · 451,6 M token"), "{t}");
    assert!(t.contains("Ultimo lavoro in coda · fix it · 10 min fa"), "{t}");
    assert!(t.contains("Budget e priorità · budget 10% Claude · priorità alta"), "{t}");
    assert!(t.contains("Apri in Topics") && t.contains("20%") && t.contains("alta ✓"), "the new rows stay");
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
    let nodes = machine_nodes(&machines, &sn, 1_800_000_000, Palette::new(false));
    let t = dump_text(&nodes);
    assert!(!t.contains("CPU intasata"), "the reason is under the name in the card, not again in the submenu: {t}");
    assert!(t.matches("Cerca in una finestra…").count() == 2, "{t}");
}

/// Every clickable id of the whole menu, machines with commands and processes included.
fn clickable_ids() -> Vec<String> {
    fn ids(nodes: &[Node], out: &mut Vec<String>) {
        for n in nodes {
            match n {
                Node::Item { id, enabled: true, .. } if !id.is_empty() => out.push(id.clone()),
                Node::Sub { children, .. } | Node::Card { children, .. } | Node::Row { children, .. } => ids(children, out),
                Node::Icon { node, .. } => ids(std::slice::from_ref(&**node), out),
                _ => {}
            }
        }
    }
    let machines = r#"[{"id":"local","procs":[]},
      {"id":"pc","procs":[{"name":"node.exe","cpu_pct":40,"mem_mb":800,"cmd":"node"}]},
      {"id":"hetzner","procs":[{"name":"bun","cpu_pct":2,"mem_mb":400}],"actions":[{"id":"spegni","label":"Spegni tutti","method":"POST","url":"/api/hetzner/spegni","confirm":"Spegne i server."}]}]"#;
    let board = UNIFORM_BOARD;
    let procs = r#"{"units":[{"id":"app:a","name":"App A","type":"app","closable":true,"memMB":900,"pids":[10]},{"id":"rest:1","name":"Resto","type":"resto","closable":true,"memMB":100,"pids":[20]}]}"#;
    let sn = Snapshot { board: Some(board.into()), machines: Some(machines.into()), procs: Some(procs.into()), live: Some(LIVE.into()), overview: Some(OVERVIEW.into()), gates: snap().gates, automations: snap().automations, ..Default::default() };
    let mut found = Vec::new();
    ids(&build_menu_rich(&sn, Prefs::default(), 1_800_000_000, &machines_for(&[], &sn), true), &mut found);
    found
}

#[test]
fn every_clickable_row_has_an_action_or_is_a_tray_row() {
    let found = clickable_ids();
    assert!(found.iter().any(|i| i.starts_with("proj-open:")) && found.iter().any(|i| i.starts_with("machine-act:")) && found.iter().any(|i| i.starts_with("machine-open:")), "{found:?}");
    // the two rows the tray's own click handler answers before the hub's (sidecar_boot.rs)
    let tray_rows = ["tray-new-chat", "tray-check-updates"];
    let dead: Vec<&String> = found.iter().filter(|i| !tray_rows.contains(&i.as_str()) && action_for(i, &Some(r#"{"units":[{"id":"app:a","name":"App A","pids":[10]},{"id":"rest:1","pids":[20]}]}"#.into())).is_none()).collect();
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
    // dispatch order: this computer, then the node that answers, then the one asleep (the service lists «pc» as «dorme»)
    let mut want = service.clone();
    want.insert(1, "n1".into());
    assert_eq!(ids, want);
    // with no service there is nothing to merge: the client list is the menu
    let none = Snapshot { board: None, ..snap() };
    assert_eq!(machines_for(&client, &none).len(), 3);
}

#[test]
fn tray_limits_list_every_account_with_state_sentence_and_link_date() {
    let board = r#"{"accounts":[
      {"label":"Claude · hi","gauge":{"zone":"frenato","short":"esaurito, torna domani 10:00","cardSay":"Finita, torna domani alle 10:00.","say":"x"},"access":{"say":"Collegato dal 23 ott 2026."}},
      {"label":"Muse · Muse","gauge":{"zone":"ok","short":"sotto ritmo","say":"Nella settimana 0,56 volte il sostenibile."},"access":{"say":"Collegato, data non nota."}}]}"#;
    let gates = r#"{"providers":{"claude":{"state":"frenato"},"muse":{"state":"libero"}},"overrides":[]}"#;
    let sn = Snapshot { board: Some(board.into()), gates: Some(gates.into()), ..Default::default() };
    let t = dump_text(&[limits_node(&sn)]);
    assert!(t.contains("Limiti degli abbonamenti · 1 abbonamento al limite"), "{t}");
    assert!(t.contains("Claude · hi · esaurito, torna domani 10:00\n  Finita, torna domani alle 10:00.\n  Collegato dal 23 ott 2026."), "{t}");
    assert!(t.contains("Muse · Muse · sotto ritmo\n  Nella settimana 0,56 volte il sostenibile.\n  Collegato, data non nota."), "{t}");
    // the accounts already say each state: no «libero» line that contradicts the title, unlock only where braked
    assert!(!t.contains("libero\n") && t.contains("Sblocca claude per 2 ore") && !t.contains("Sblocca muse"), "{t}");
    assert!(t.contains("Le sessioni aperte non si fermano mai: il freno vale per i lavori nuovi"), "{t}");
}

/// TRAY_MENU_DUMP=/tmp/menu.txt cargo test --lib tray_menu_dump -- --nocapture
/// writes the text of the whole menu from the live service (`TRAY_MENU_HUB`, default the hub on this machine).
#[test]
fn tray_menu_dump() {
    let Ok(out) = std::env::var("TRAY_MENU_DUMP") else { return };
    let base = std::env::var("TRAY_MENU_HUB").unwrap_or_else(|_| crate::tray_quota::hub_base());
    let sn = Snapshot::fetch(&base, None);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let machines = machines_for(&[], &sn);
    std::fs::write(out, dump_text(&build_menu_rich(&sn, Prefs::default(), now, &machines, true))).unwrap();
}

/// The three machines of the `/api/machines` contract (brief «tray-nodi-uniformi»):
/// every one with cpu, mem and disk, the server also its spend, every one with its procs.
const UNIFORM_BOARD: &str = r#"{"machines":[
 {"id":"local","name":"MacBook","state":"lavora","level":0,"lines":["Tutto tranquillo"],"metrics":[{"key":"cpu","pct":20},{"key":"mem","pct":50},{"key":"disk","pct":70}]},
 {"id":"pc","name":"PC Windows","state":"lavora","level":0,"lines":["Collegato dal Mac"],"metrics":[{"key":"cpu","pct":5},{"key":"mem","pct":32},{"key":"disk","pct":97}]},
 {"id":"hetzner","name":"Server Hetzner","state":"lavora","level":0,"lines":["Nodo fisso acceso"],"metrics":[{"key":"cpu","pct":3},{"key":"mem","pct":41},{"key":"disk","pct":22},{"key":"spend","name":"Spesa","pct":14,"level":2,"value":"8,44/60 €"}]}]}"#;
const UNIFORM_MACHINES: &str = r#"[
 {"id":"local","lines":["Tutto tranquillo"],"metrics":[{"key":"cpu","name":"CPU","pct":20,"history":[]}],"procs":[]},
 {"id":"pc","lines":["Collegato dal Mac"],"metrics":[{"key":"cpu","name":"CPU","pct":5,"history":[{"t":1,"v":5}]}],"procs":[{"name":"node.exe","cpu_pct":40.5,"mem_mb":812,"cmd":"node vitest"},{"name":"cargo.exe","cpu_pct":12,"mem_mb":300}]},
 {"id":"hetzner","lines":["Nodo fisso acceso"],"metrics":[{"key":"cpu","name":"CPU","pct":3,"history":[{"t":1,"v":3}]},{"key":"spend","name":"Spesa","pct":14,"value":"8,44/60 €","history":[]}],"procs":[{"name":"bun","cpu_pct":2.1,"mem_mb":420,"cmd":"bun server"}]}]"#;

fn uniform_cards() -> Vec<Node> {
    let sn = Snapshot { board: Some(UNIFORM_BOARD.into()), machines: Some(UNIFORM_MACHINES.into()), procs: Some(r#"{"units":[{"id":"u1","name":"Topics","type":"app","n":3,"memMB":900,"pids":[]}]}"#.into()), ..Default::default() };
    machine_nodes(&machines_for(&[], &sn), &sn, 1_800_000_000, Palette::new(true))
}

#[test]
fn every_machine_submenu_has_the_shape_of_the_macbook_one() {
    let cards = uniform_cards();
    assert_eq!(cards.len(), 3);
    for c in &cards {
        let Node::Card { key, children, .. } = c else { panic!("not a card: {c:?}") };
        fn bare(n: &Node) -> &Node {
            if let Node::Icon { node, .. } = n { bare(node) } else { n }
        }
        let children: Vec<Node> = children.iter().map(|n| bare(n).clone()).collect();
        let children = &children;
        let k = children.len();
        assert!(k >= 5, "{key}: {}", dump_text(children));
        // what the machine says first (state lines, the day), a separator, the process table, then the finder; never a
        // separator at the start or two in a row
        assert!(!matches!(children[0], Node::Sep), "{key}: starts on a row");
        assert!(!children.windows(2).any(|w| matches!((&w[0], &w[1]), (Node::Sep, Node::Sep))), "{key}: no separator twice in a row");
        let head = children.iter().position(|n| matches!(n, Node::Row { header: true, .. })).expect("a process table");
        assert!(head == 0 || matches!(children[head - 1], Node::Sep), "{key}: a separator before the process table");
        let Node::Row { cells, table, .. } = &children[head] else { unreachable!() };
        assert!(cells[0].starts_with("GIRA ADESSO"), "{key}: {cells:?}");
        // the MacBook measures GPU and network per process; a remote machine does not, so it has no such columns
        if key == "machine:local" {
            assert_eq!((cells[1..].to_vec(), *table), (["CPU", "GPU", "rete", "memoria"].map(String::from).to_vec(), Table::Procs));
        } else {
            assert_eq!((cells[1..].to_vec(), *table), (["CPU", "memoria"].map(String::from).to_vec(), Table::RemoteProcs), "{key}");
        }
        assert!(matches!(children[head + 1], Node::Row { header: false, .. }), "{key}: at least one process row");
        assert!(matches!(children[k - 2], Node::Sep), "{key}");
        assert!(matches!(&children[k - 1], Node::Item { label, .. } if label == "Cerca in una finestra…"), "{key}");
    }
    let t = dump_text(&cards);
    // no GPU or network column, no dash standing in for one; the memory with its unit
    assert!(t.contains("node.exe | 41% | 812 MB | processo · node vitest") && t.contains("bun | 2% | 420 MB"), "{t}");
    let rows = |n: &Node| if let Node::Card { children, .. } = n { children.clone() } else { vec![] };
    for c in &cards {
        fn cells(n: &Node) -> Option<Vec<String>> {
            match n {
                Node::Icon { node, .. } => cells(node),
                Node::Row { cells, header: false, .. } => Some(cells.clone()),
                _ => None,
            }
        }
        // the row's second line is marked as such, never one more column that the memory runs into
        for r in rows(c).iter().filter_map(cells).filter(|r| r.last().map_or(false, |l| l.starts_with('\n'))) {
            let last = r.len() - 1;
            assert!(r[last].starts_with('\n') && !r[last - 1].contains('\n'), "{r:?}");
        }
    }
}

// ---- point 7: a remote machine's submenu as the MacBook's

fn remote_sub(machines: &str) -> Vec<Node> {
    let sn = Snapshot { board: Some(UNIFORM_BOARD.into()), machines: Some(machines.into()), ..Default::default() };
    let cards = machine_nodes(&machines_for(&[], &sn), &sn, 1_800_000_000, Palette::new(true));
    let Node::Card { children, .. } = &cards[2] else { panic!("the server card") };
    children.clone()
}

fn many_procs(n: usize) -> String {
    (0..n).map(|i| format!(r#"{{"name":"p{i:02}","cpu_pct":{},"mem_mb":{},"cmd":"/bin/p{i}"}}"#, 30 - i, 100 - i)).collect::<Vec<_>>().join(",")
}

#[test]
fn a_remote_machine_counts_its_processes_from_the_total_and_folds_the_rest() {
    let m = format!(r#"[{{"id":"hetzner","os":"Linux","procsTotal":{{"n":70,"memMB":5921}},"procs":[{}]}}]"#, many_procs(30));
    let t = dump_text(&remote_sub(&m));
    assert!(t.contains("GIRA ADESSO · 70 · 5,9 GB | CPU | memoria"), "N and memory are the machine's total, not the 30 listed:\n{t}");
    // 15 rows shown, the other 15 listed plus the 40 the service did not list, in one submenu
    assert!(t.contains("Tutto il resto (55) · "), "{t}");
    assert!(t.contains("40 processi non elencati"), "{t}");
    assert!(t.contains("p00 | 30% | 100 MB") && t.contains("p14 | 16% | 86 MB"), "the first fifteen rows are shown: {t}");
}

#[test]
fn a_remote_machine_without_a_total_counts_what_it_lists_and_a_short_list_has_no_rest() {
    let m = r#"[{"id":"hetzner","procs":[{"name":"bun","cpu_pct":2,"mem_mb":420,"cmd":"bun x"},{"name":"sshd","cpu_pct":0,"mem_mb":10}]}]"#;
    let t = dump_text(&remote_sub(m));
    assert!(t.contains("GIRA ADESSO · 2 · 430 MB | CPU | memoria"), "{t}");
    assert!(!t.contains("Tutto il resto"), "nothing past the shown rows, nothing to fold: {t}");
}

#[test]
fn a_remote_machine_invents_nothing_it_cannot_measure() {
    let m = format!(r#"[{{"id":"hetzner","os":"Linux","procsTotal":{{"n":70,"memMB":5921}},"procs":[{}]}}]"#, many_procs(30));
    let t = dump_text(&remote_sub(&m));
    for invented in ["Processi attendibili", "Chiudi i resti", "Chiudi:", "PIÙ GPU", "PIÙ RETE", "GPU", "rete"] {
        assert!(!t.contains(invented), "«{invented}» does not exist on a remote machine:\n{t}");
    }
    assert!(t.contains("PIÙ CPU ADESSO | CPU | memoria") && t.contains("PIÙ MEMORIA | CPU | memoria"), "the rankings it can fill stay: {t}");
}

#[test]
fn a_remote_machine_shows_its_day_and_does_not_say_the_card_again() {
    let m = r#"[{"id":"hetzner","metrics":[{"key":"cpu","name":"CPU","pct":1,"level":0,"note":"0,2 di 16 core"},{"key":"spend","name":"Spesa","pct":14,"level":2,"value":"8,44/60 €","note":"oltre il tetto"}],
      "timeline":{"window":86400,"segments":[{"t0":0,"t1":79200,"state":"lavora"},{"t0":79200,"t1":86400,"state":"dorme"}]},"procs":[]}]"#;
    let t = dump_text(&remote_sub(m));
    assert!(!t.contains("CPU 1%") && !t.contains("Spesa 8,44"), "the readings are the card's: said twice they were two figures for one thing: {t}");
    assert!(t.contains("Nelle ultime 24 h · al lavoro 22 h · dorme 2 h"), "{t}");
}

#[test]
fn the_day_of_a_machine_never_reads_as_the_time_it_was_on() {
    // «acceso 7 h» next to «lavora 16 h» read as on for 7 hours while working for 16: the states split the day allow-italian: quoted menu wording
    let m = r#"[{"id":"hetzner","timeline":{"window":86400,"segments":[{"t0":0,"t1":60000,"state":"lavora"},{"t0":60000,"t1":86400,"state":"acceso"}]}}]"#;
    let t = dump_text(&remote_sub(m));
    assert!(t.contains("al lavoro 16 h 40 min · acceso senza lavoro 7 h 20 min"), "{t}");
    assert!(!t.contains("lavora "), "{t}");
}

#[test]
fn the_commands_of_a_machine_ask_first_and_call_the_service() {
    let m = r#"[{"id":"hetzner","actions":[{"id":"spegni","label":"Spegni tutti","method":"POST","url":"/api/hetzner/spegni","confirm":"Spegne i server di offload."}]}]"#;
    let children = remote_sub(m);
    let id = children.iter().find_map(|n| match n {
        Node::Icon { icon, node } if icon == "sf:power" => match &**node { Node::Item { id, label, .. } => Some((id.clone(), label.clone())), _ => None },
        _ => None,
    });
    let (id, label) = id.expect("a power row for the command");
    assert_eq!(label, "Spegni tutti…");
    assert_eq!(
        action_for(&id, &None),
        Some(crate::tray_menu::Action::ConfirmedHttp { label: "Spegni tutti".into(), machine: "Server Hetzner".into(), confirm: "Spegne i server di offload.".into(), method: "POST", path: "/api/hetzner/spegni".into() })
    );
}

#[test]
fn a_command_that_is_not_the_services_own_is_refused() {
    let id = |method: &str, path: &str| crate::tray_menu::machine_action_id("M", method, path, "x", "y");
    assert_eq!(action_for(&id("GET", "/api/hetzner/spegni"), &None), None, "only the verbs the service uses");
    assert_eq!(action_for(&id("POST", "http://evil.example/x"), &None), None, "only paths of the service");
    assert_eq!(action_for("machine-act:POST", &None), None, "a truncated id does nothing");
}

#[test]
fn a_command_without_a_sentence_still_asks_before_it_calls() {
    let id = crate::tray_menu::machine_action_id("M", "POST", "/api/x", "Spegni tutti", "");
    let Some(crate::tray_menu::Action::ConfirmedHttp { confirm, .. }) = action_for(&id, &None) else { panic!("not a confirmed call") };
    assert_eq!(confirm, "Spegni tutti?");
}

#[test]
fn the_finder_of_a_machine_opens_the_processes_view_of_the_client() {
    assert_eq!(action_for("machine-open:hetzner", &None), Some(crate::tray_menu::Action::OpenProcesses));
    assert_eq!(action_for("machine-open:local", &None), Some(crate::tray_menu::Action::OpenProcesses));
}

// ---- the whole menu from the real answers of the service, as text

/// Every node, one per line: its icon, its table and look, and the id of what can be clicked. Longer than
/// `dump_text`, which the other tests read, so the eye can check what the menu will draw.
fn dump_detailed(nodes: &[Node], depth: usize, out: &mut String) {
    for nd in nodes {
        let pad = "  ".repeat(depth);
        match nd {
            Node::Sep => out.push_str(&format!("{pad}────────\n")),
            Node::Item { id, label, enabled, .. } => {
                let tag = if *enabled && !id.is_empty() { format!("  ⟶ {id}") } else if *enabled { String::new() } else { "  (nota)".into() };
                out.push_str(&format!("{pad}{label}{tag}\n"));
            }
            Node::Sub { label, children } => {
                out.push_str(&format!("{pad}{label}  ▸\n"));
                dump_detailed(children, depth + 1, out);
            }
            Node::Card { key, children, .. } => {
                out.push_str(&format!("{pad}[card {key}]{}\n", if children.is_empty() { "" } else { "  ▸" }));
                dump_detailed(children, depth + 1, out);
            }
            Node::Row { cells, header, table, look, children, .. } => {
                let flat: Vec<String> = cells.iter().map(|c| c.replace('\n', "⏎ ")).collect();
                let how = format!("{table:?}{}{}{}", if *header { " intestazione" } else { "" }, if look.bold { " semibold" } else { "" }, match look.priority { crate::tray_menu::Priority::High => " priorità↑", crate::tray_menu::Priority::Low => " priorità↓", _ => "" });
                out.push_str(&format!("{pad}{}   ‹{how}; tab {:?}›{}\n", flat.join(" | "), table.tabs(), if children.is_empty() { "" } else { "  ▸" }));
                dump_detailed(children, depth + 1, out);
            }
            Node::Icon { icon, node } => {
                let mut inner = String::new();
                dump_detailed(std::slice::from_ref(&**node), depth, &mut inner);
                // the icon goes at the head of the first line of the wrapped node
                let (first, rest) = inner.split_once('\n').unwrap_or((&inner, ""));
                out.push_str(&format!("{pad}⟨{icon}⟩ {}\n{rest}", first.trim_start()));
            }
        }
    }
}

/// Run by hand with `-- --ignored tray_dump_of_the_real_menu`, with `TRAY_DUMP_DIR` on a folder that holds the
/// service's answers as files (`board`, `overview`, `heavy`, `procs`, `automations`, `live`, `gates`,
/// `machines`, `trust`, `backup`, and `ps` for the CPU of each process) and writes `nuovo-menu-v7.txt` there. allow-italian: quoted output file name
#[test]
#[ignore = "needs the service's answers on disk: set TRAY_DUMP_DIR"]
fn tray_dump_of_the_real_menu() {
    let dir = std::path::PathBuf::from(std::env::var("TRAY_DUMP_DIR").expect("TRAY_DUMP_DIR"));
    let read = |n: &str| std::fs::read_to_string(dir.join(n)).ok();
    let cpu = crate::tray_menu::parse_ps(&read("ps").unwrap_or_default());
    let sn = Snapshot {
        board: read("board"),
        overview: read("overview"),
        heavy: read("heavy"),
        procs: read("procs"),
        automations: read("automations"),
        live: read("live"),
        gates: read("gates"),
        machines: read("machines"),
        trust: read("trust"),
        backup: read("backup"),
        backup_set: read("backup").is_some(),
        memory_sync: read("memory-sync"),
        memory_sync_set: read("memory-sync").is_some(),
        pool: read("pool"),
        health: read("machines-health"),
        harness_sync: read("harness-sync"),
        cpu,
    };
    // the poller reads the pictures from the service; the dump only needs to know there is one
    for p in crate::tray_menu::parse(&sn.live).get("projects").and_then(|v| v.as_array()).into_iter().flatten() {
        let (name, icon) = (crate::tray_menu::s(p, "name"), crate::tray_menu::s(p, "icon"));
        if !icon.is_empty() {
            crate::tray_menu::store_project_icon(name, icon, vec![0]);
        }
    }
    let now = std::env::var("TRAY_DUMP_NOW").ok().and_then(|v| v.parse().ok()).unwrap_or(1_800_000_000);
    let machines = machines_for(&[], &sn);
    let menu = build_menu_rich(&sn, Prefs::default(), now, &machines, true);
    let mut out = String::from("# Tendina della tray Rust coi dati veri dell'hub\n# ⟨icona⟩ davanti alla riga · ‹tabella, aspetto; tab› di ogni riga a colonne · ⟶ id di ciò che si clicca · ▸ si apre un sottomenu\n\n");
    dump_detailed(&menu, 0, &mut out);
    std::fs::write(dir.join("nuovo-menu-v7.txt"), out).unwrap();
}

#[test]
fn separators_sit_between_two_rows_only() {
    let item = |t: &str| crate::tray_menu::note(t);
    let out = tidy_separators(vec![Node::Sep, item("a"), Node::Sep, Node::Sep, item("b"), Node::Sep]);
    let kinds: Vec<&str> = out.iter().map(|n| if matches!(n, Node::Sep) { "-" } else { "row" }).collect();
    assert_eq!(kinds, ["row", "-", "row"], "none at the start or the end, one where there were two");
}

#[test]
fn the_history_of_a_reading_comes_from_the_machines_answer_and_bounds_the_peak() {
    let board = machine_cards_from_board(r#"{"machines":[{"id":"local","name":"Mac","state":"x","metrics":[{"key":"gpu","pct":77,"note":"picco 24 h 77%"}]}]}"#);
    let mut cards = board;
    attach_histories(&mut cards, Some(r#"[{"id":"local","metrics":[{"key":"gpu","history":[{"t":1000000,"v":10},{"t":1600000,"v":77},{"t":2200000,"v":30}]}]}]"#));
    assert_eq!((cards[0].metrics[0].hist_n, cards[0].metrics[0].hist_span_s, cards[0].metrics[0].hist_peak), (3, 1200, Some(77)));
    crate::tray_numbers::say_what_each_is_of(&mut cards[0]);
    assert_eq!(cards[0].metrics[0].note, "picco 77% · ultime 20 minuti", "twenty minutes of history are not 24 hours");
}
