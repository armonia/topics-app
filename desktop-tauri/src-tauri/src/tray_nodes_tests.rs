//! The node cards: ghost seats gone, one card per server, named and worded from the pool, in dispatch order.

use super::*;

const NOW: i64 = 1_800_000_000;

/// The pool as `node-pool` wrote it: a fixed server draining after a failed realign, a seat with a machine row and no server.
const POOL: &str = r#"{"slots":{
 "1":{"n":1,"machine_id":"m-fixed","server_id":175571194,"name":"srv-fixed","fixed":true,"draining":true,"drain_since":1799990000,"align_failed":"abc","cards":2},
 "2":{"n":2,"machine_id":"m-ghost"},
 "3":{"n":3}}}"#;

fn card(id: &str, name: &str, badge: &str) -> MachineCard {
    MachineCard { id: id.into(), name: name.into(), badge: badge.into(), ..Default::default() }
}

fn detail(id: &str, caption: &str) -> MachineDetail {
    MachineDetail { id: id.into(), caption: caption.into(), ..Default::default() }
}

#[test]
fn the_pool_state_is_read_by_seat() {
    let p = parse_pool(POOL);
    assert_eq!(p.len(), 3);
    assert!(p[0].fixed && p[0].has_server && p[0].draining && p[0].align_failed && p[0].cards == Some(2));
    // no deadline written: the drain's default length from when it started
    assert_eq!(p[0].drain_until, Some(1_799_990_000 + 180 * 60));
    assert!(!p[1].has_server && p[1].machine_id == "m-ghost");
    assert!(parse_pool("not json").is_empty());
}

#[test]
fn a_written_deadline_wins_over_the_default() {
    let p = parse_pool(r#"{"slots":{"1":{"n":1,"server_id":1,"draining":true,"drain_since":100,"drain_until":5000}}}"#);
    assert_eq!(p[0].drain_until, Some(5000));
}

#[test]
fn a_seat_without_a_server_is_a_ghost_and_does_not_show() {
    let pool = parse_pool(POOL);
    let client = vec![card("m-fixed", "Nodo cloud 1", "acceso"), card("m-ghost", "Nodo cloud 2", "spento")];
    let out = arrange(client.clone(), &client, &pool, &[], 0);
    assert!(out.iter().all(|c| c.id != "m-ghost"), "{out:?}");
    assert_eq!(out.len(), 1);
}

#[test]
fn a_fixed_server_shows_once_named_by_what_it_is_and_worded_by_the_pool() {
    let pool = parse_pool(POOL);
    let client = vec![card("m-fixed", "Nodo cloud 1", "acceso")];
    let hub = card("hetzner", "Server Hetzner", "lavora");
    let out = arrange(vec![hub, client[0].clone()], &client, &pool, &[detail("hetzner", "srv-fixed · 16 core · sempre acceso")], 3600);
    assert_eq!(out.len(), 1, "two cards for one server: {out:?}");
    assert_eq!(out[0].id, "hetzner", "the service's card, which has the spend and the commands, wins");
    assert_eq!(out[0].name, "Server fisso");
    assert_eq!(out[0].badge, "in svuotamento");
    // 1_799_990_000 + 10_800 s = 1_800_000_800 = 08:13 UTC, 09:13 in a +1 h zone
    assert_eq!(out[0].reason, "si riallinea a main, card ferme fino alle 09:13");
    assert_eq!(out[0].level, 1);
    assert_eq!(out[0].lines[0], out[0].reason, "the full sentence is also in the submenu");
}

#[test]
fn the_provider_comes_from_the_pool_or_else_from_the_clients_own_line() {
    let mut pool = parse_pool(r#"{"slots":{"1":{"n":1,"machine_id":"m1","server_id":1,"name":"s","fixed":true}}}"#);
    let mut c = card("m1", "x", "acceso");
    c.reason = "Hetzner · cx53 · 25 €/mese".into();
    let client = vec![c.clone()];
    assert_eq!(arrange(vec![c.clone()], &client, &pool, &[], 0)[0].name, "Server fisso (Hetzner)");
    pool[0].provider = "Altro".into();
    assert_eq!(arrange(vec![c], &client, &pool, &[], 0)[0].name, "Server fisso (Altro)");
}

#[test]
fn an_hourly_node_is_named_by_its_seat_and_says_how_many_cards() {
    let pool = parse_pool(r#"{"slots":{"3":{"n":3,"machine_id":"m3","server_id":9,"name":"h","cards":2},"4":{"n":4,"machine_id":"m4","server_id":10,"name":"h2","cards":1}}}"#);
    let client = vec![card("m3", "x", "acceso"), card("m4", "y", "acceso")];
    let out = arrange(client.clone(), &client, &pool, &[], 0);
    assert_eq!((out[0].name.as_str(), out[0].badge.as_str()), ("Nodo a ore 3", "acceso, 2 card"));
    assert_eq!(out[1].badge, "acceso, 1 card");
}

#[test]
fn a_failed_realign_is_said_and_a_silent_node_keeps_its_own_word() {
    let pool = parse_pool(r#"{"slots":{"1":{"n":1,"machine_id":"a","server_id":1,"name":"a","align_failed":"abc"},"2":{"n":2,"machine_id":"b","server_id":2,"name":"b"}}}"#);
    let mut silent = card("b", "y", "spento");
    silent.level = 2;
    let client = vec![card("a", "x", "acceso"), silent];
    let out = arrange(client.clone(), &client, &pool, &[], 0);
    assert_eq!(out[0].badge, "riallineamento fallito");
    assert_eq!(out[1].badge, "spento", "no «acceso» over a node that does not answer");
}

#[test]
fn the_order_is_this_computer_then_nodes_with_seats_then_sleepers_then_drained() {
    let pool = parse_pool(r#"{"slots":{"1":{"n":1,"machine_id":"fix","server_id":1,"name":"f","fixed":true,"draining":true,"drain_since":1}}}"#);
    let mut mac = card("local", "Mac", "lavora");
    mac.local = true;
    // the client lists the nodes freshest heartbeat first: the PC, then the fixed server
    let client = vec![card("pcid", "PC Windows", "lavora"), card("fix", "Nodo cloud 1", "acceso")];
    let mut sleeper = card("slp", "Altro PC", "dorme");
    sleeper.level = 0;
    let cards = vec![card("fix", "Nodo cloud 1", "acceso"), sleeper, card("pcid", "PC Windows", "lavora"), mac];
    let out = arrange(cards, &client, &pool, &[], 0);
    let names: Vec<_> = out.iter().map(|c| c.display_name()).collect();
    assert_eq!(names, ["1 · Mac", "2 · PC Windows", "3 · Altro PC", "4 · Server fisso"], "{names:?}");
}

#[test]
fn a_provider_server_name_or_an_id_never_reaches_the_card() {
    let pool = parse_pool(POOL);
    let mut hub = card("hetzner", "Server Hetzner", "lavora");
    // the service's first line is only the server's own name, then comes a line the card may keep
    hub.lines = vec!["srv-fixed".into(), "srv-fixed · 16 core".into(), "104bba89-24e4-4e75-8167-806230b2f3fd".into(), "sempre acceso".into()];
    hub.reason = "srv-fixed".into();
    let client = vec![card("m-fixed", "Nodo cloud 1", "acceso")];
    let out = arrange(vec![hub], &client, &pool, &[detail("hetzner", "srv-fixed · 16 core · sempre acceso")], 3600);
    let said: Vec<&String> = out[0].lines.iter().chain(std::iter::once(&out[0].reason)).collect();
    assert!(said.iter().all(|t| !t.to_lowercase().contains("srv-fixed") && !t.contains("104bba89")), "{said:?}");
    assert!(out[0].lines.contains(&"16 core".to_string()) && out[0].lines.contains(&"sempre acceso".to_string()), "{:?}", out[0].lines);
}

#[test]
fn a_reason_that_is_only_an_id_gives_way_to_the_next_line() {
    let pool = parse_pool(POOL);
    let mut pc = card("pc", "PC Windows", "lavora");
    pc.lines = vec!["pc".into(), "Collegato dal Mac".into()];
    pc.reason = "pc".into();
    let out = arrange(vec![pc], &[], &pool, &[], 0);
    assert_eq!((out[0].reason.as_str(), out[0].lines.len()), ("Collegato dal Mac", 1));
}
