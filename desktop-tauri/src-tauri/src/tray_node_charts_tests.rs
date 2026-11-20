//! The node cards with their rows and charts, from fixture files: each chart with data and without,
//! the link between a card and its machine, and the menu that carries it all.

use super::*;
use crate::tray_menu::{dump_text, Prefs};
use crate::tray_node_health::tests::{health_body, NOW};

const OFF: i64 = 3600;
const POOL: &str = r#"{"slots":{"1":{"n":1,"machine_id":"m1","server_id":7,"name":"srv-fixed","fixed":true,"provider":"Hetzner","cards":1,"behind_since":1799990000}},
 "spend_daily":[{"day":"2027-01-01","eur":1.0},{"day":"2027-01-02","eur":3.5},{"day":"2027-01-03","eur":0.0}],"spend_cap_eur":62}"#;

/// `health_body` with the remote machine given real series, a warning and a count of cards.
fn health_with_server() -> String {
    health_body(NOW, "ok", r#"[{"key":"updates","status":"ok","detail":"ok"},{"key":"disk","status":"ok","detail":"cifrato"}]"#)
        .replace(r#""cards_today":[]}"#, r#""cards_today":[0,0,0,0,0,0,0,0,2,3,1,0,0,0,0,0,0,0,0,0,0,0,0,0]}"#)
        .replace(r#""from":0,"cpu":[],"mem":[]"#, r#""from":0,"cpu":[30,35,40,90],"mem":[20,21,22,23]"#)
        .replace(r#""checked_at":null,"status":"unknown","checks":[]"#, r#""checked_at":1799999000,"status":"warn","checks":[{"key":"updates","status":"warn","detail":"5 aggiornamenti"},{"key":"disk","status":"ok","detail":"cifrato"},{"key":"access","status":"ok","detail":"solo SSH"},{"key":"antivirus","status":"ok","detail":"pulito"}]"#)
}

fn sync_body() -> String {
    let hist: Vec<String> = (0..24).map(|i| format!(r#"{{"at":{},"lag_s":{}}}"#, NOW - 86_400 + i * 3600 + 60, i * 100)).collect();
    format!(r#"{{"source":{{"rev":"r2","at":{NOW}}},"targets":{{"m1":{{"name":"Server","rev":"r2","at":{},"error":null,"private":"closed","private_reason":null}}}},"history":{{"m1":[{}]}}}}"#, NOW - 600, hist.join(","))
}

fn data() -> NodeData {
    let snap = Snapshot { pool: Some(POOL.into()), health: Some(health_with_server()), harness_sync: Some(sync_body()), ..Default::default() };
    NodeData::from_snapshot(&snap, NOW, OFF)
}

fn mac() -> MachineCard {
    MachineCard { id: "local".into(), name: "Mac".into(), local: true, badge: "ok".into(), ..Default::default() }
}

fn server() -> MachineCard {
    MachineCard { id: "hetzner".into(), name: "Server fisso".into(), badge: "acceso".into(), ..Default::default() }
}

fn detail() -> Vec<MachineDetail> {
    vec![MachineDetail { id: "hetzner".into(), caption: "srv-fixed · 16 core".into(), ..Default::default() }]
}

#[test]
fn the_server_card_links_to_its_machine_through_the_pool_seat() {
    let e = data().extras(&server(), &detail(), NOW, OFF);
    let labels: Vec<&str> = e.rows.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(labels, ["Memorie e regole", "Codice", "Sicurezza"]);
    assert_eq!(e.rows[0].text, "salvate alle 08:50 · privato chiuso");
    assert_eq!(e.rows[1].text, "indietro da 2 ore");
    assert_eq!(e.rows[2].text, "da guardare · 5 aggiornamenti");
    assert_eq!(e.cards_total(), Some(6));
    assert_eq!(e.checks.len(), 4);
    assert_eq!(e.lag.len(), 24);
}

#[test]
fn the_mac_has_its_saved_memories_and_security_but_no_code_or_sync_row() {
    let snap = Snapshot { health: Some(health_with_server()), memory_sync: Some(format!(r#"{{"last_ok":{},"runs":[],"parts":[]}}"#, NOW - 3600)), memory_sync_set: true, pool: Some(POOL.into()), ..Default::default() };
    let e = NodeData::from_snapshot(&snap, NOW, OFF).extras(&mac(), &[], NOW, OFF);
    let rows: Vec<(String, String)> = e.rows.iter().map(|r| (r.label.clone(), r.text.clone())).collect();
    assert_eq!(rows, [("Memorie e regole".to_string(), "salvate alle 08:00".to_string()), ("Sicurezza".to_string(), "a posto".to_string())]);
    assert!(e.spend.is_none(), "the spend is the server's");
}

#[test]
fn no_files_no_rows_and_no_charts() {
    let e = NodeData::from_snapshot(&Snapshot::default(), NOW, OFF).extras(&server(), &[], NOW, OFF);
    assert_eq!(e, NodeExtras { now: NOW, offset: OFF, ..Default::default() });
    assert_eq!(e.block_h(), 0.0);
    let p = Palette::new(false);
    assert!(lag_card(&e, p).is_none() && spend_card(&e, p).is_none());
    assert!(submenu_nodes(&e, "x", p, OFF).is_empty());
}

#[test]
fn the_security_row_follows_the_age_of_the_file() {
    let old = NodeData::from_snapshot(&Snapshot { health: Some(health_body(NOW - 5 * 3600, "ok", "[]")), ..Default::default() }, NOW, OFF);
    let e = old.extras(&mac(), &[], NOW, OFF);
    assert_eq!(e.rows[0].text, "non controllata da 5 ore");
}

#[test]
fn a_card_with_a_twin_in_the_client_list_finds_its_machine_by_that_id() {
    let snap = Snapshot { health: Some(health_with_server()), ..Default::default() };
    let c = MachineCard { id: "pc".into(), name: "PC Windows".into(), machine_id: "m1".into(), ..Default::default() };
    let e = NodeData::from_snapshot(&snap, NOW, OFF).extras(&c, &[], NOW, OFF);
    assert_eq!(e.rows.len(), 1);
    assert_eq!(e.rows[0].label, "Sicurezza");
}

#[test]
fn a_pc_the_sync_file_names_is_found_by_its_name_when_no_id_matches() {
    // the real file: keyed by the PC's Topics machine id, which the service's card (id «pc») does not carry
    let body = format!(r#"{{"source":{{"rev":"r","at":{NOW}}},"targets":{{"fbe3f00f":{{"name":"PC Windows","rev":"r","at":{},"error":null,"private":"skipped","private_reason":"privato non copiato: disco non cifrato"}}}},"history":{{"fbe3f00f":[{{"at":{},"lag_s":0}},{{"at":{},"lag_s":300}}]}}}}"#, NOW - 300, NOW - 7200, NOW - 3600);
    let d = NodeData::from_snapshot(&Snapshot { harness_sync: Some(body), ..Default::default() }, NOW, OFF);
    let pc = MachineCard { id: "pc".into(), name: "PC Windows".into(), ..Default::default() };
    let e = d.extras(&pc, &[], NOW, OFF);
    assert_eq!(e.rows[0].text, "salvate alle 08:55 · privato non copiato: disco non cifrato");
    assert_eq!(e.lag.len(), 2);
    // this computer is never matched by name
    assert!(d.extras(&MachineCard { local: true, ..pc }, &[], NOW, OFF).rows.is_empty());
}

#[test]
fn cpu_and_memory_lines_need_two_readings_and_the_cards_row_needs_a_count() {
    let mut e = NodeExtras { cpu: vec![Some(1.0)], mem: vec![None, None, Some(5.0)], ..Default::default() };
    assert!(!drawable(&e.cpu) && !drawable(&e.mem), "one reading is no line");
    e.cpu = vec![Some(1.0), None, Some(9.0)];
    assert!(drawable(&e.cpu));
    e.cards_hours = vec![0; 24];
    assert_eq!(e.cards_total(), Some(0));
    assert_eq!(e.cards_panel(), None, "zero cards today takes no row: a «0 avviate» says nothing a badge does not");
    e.cards_hours[9] = 3;
    assert_eq!(e.cards_panel(), Some(3));
}

fn card_h(e: &NodeExtras, dark: bool) -> f32 {
    let m = MachineCard { id: "x".into(), name: "Server".into(), badge: "acceso".into(), ..Default::default() };
    crate::tray_menu_views::draw_machine_card_with(&m, e, Palette::new(dark)).h
}

#[test]
fn the_card_grows_by_its_status_rows_only_never_by_a_history() {
    let base = card_h(&NodeExtras::default(), false);
    let rows = NodeExtras { rows: vec![StatusRow { label: "Codice".into(), text: "allineato a main".into(), level: 0 }], ..Default::default() };
    assert_eq!(card_h(&rows, false), base + rows.block_h());
    assert!(rows.block_h() > 17.0);
    // the CPU and memory histories sit in their legend rows: the card does not grow by a hand
    let lined = NodeExtras { cpu: vec![Some(1.0), Some(2.0)], mem: vec![Some(1.0), Some(2.0)], ..rows.clone() };
    assert_eq!(card_h(&lined, true), card_h(&rows, true), "a history takes no height");
    // the day's cards are one status row, the height of the others
    let cards = NodeExtras { cards_hours: vec![0, 2, 1, 0], ..rows.clone() };
    assert_eq!(card_h(&cards, true), card_h(&rows, true) + ROW_H);
}

#[test]
fn the_cards_row_needs_cards_started_today() {
    let hours = |v: Vec<u32>| NodeExtras { cards_hours: v, ..Default::default() };
    assert!(hours(vec![0, 2, 1, 0]).block_h() > 0.0);
    assert_eq!(hours(vec![0; 24]).block_h(), 0.0);
    assert_eq!(NodeExtras::default().block_h(), 0.0);
}

#[test]
fn the_lag_chart_needs_two_points_in_the_last_24_hours() {
    let p = Palette::new(false);
    let e = |lag: Vec<(i64, i64)>| NodeExtras { lag, now: NOW, ..Default::default() };
    assert!(lag_card(&e(vec![(NOW - 7200, 100), (NOW - 3600, 7200)]), p).is_some());
    assert!(lag_card(&e(vec![(NOW - 7200, 100)]), p).is_none());
    assert!(lag_card(&e(vec![(NOW - 3 * 86_400, 1), (NOW - 2 * 86_400, 2)]), p).is_none(), "points older than a day do not count");
    assert!(lag_card(&e(vec![]), p).is_none());
}

#[test]
fn a_young_lag_history_fills_the_plot_and_the_title_says_how_far_it_reaches() {
    let p = Palette::new(false);
    let at = |from: i64| NodeExtras { lag: vec![(NOW - from, 0), (NOW - from / 2, 120), (NOW, 480)], now: NOW, ..Default::default() };
    let young = lag_card(&at(1800), p).unwrap();
    let old = lag_card(&at(20 * 3600), p).unwrap();
    assert_eq!(young.h, old.h, "same card, the plot only changes its time axis");
    // 30 minutes of history span the whole plot: the line reaches the left half, not only the right edge
    let ink = line_ink(p);
    let left_has_line = (0..young.cv.h).any(|y| (14..270).any(|x| young.cv.px[((y * young.cv.w + x * 2) * 4) as usize..][..3] == ink));
    assert!(left_has_line);
}

#[test]
fn the_spend_chart_needs_a_day_and_draws_with_or_without_a_ceiling() {
    let p = Palette::new(true);
    let spend = |cap: Option<f64>| NodeExtras { spend: Some(Spend { days: vec![("2027-02-01".into(), 1.0), ("2027-02-02".into(), 9.0)], cap }), ..Default::default() };
    assert!(spend_card(&spend(Some(60.0)), p).is_some());
    assert!(spend_card(&spend(None), p).is_some());
    assert!(spend_card(&NodeExtras::default(), p).is_none());
    assert_eq!(days_in_month(2028, 2), 29);
    assert_eq!(days_in_month(2100, 2), 28);
}

#[test]
fn the_spend_goes_to_the_fixed_server_only() {
    let e = data().extras(&server(), &detail(), NOW, OFF);
    assert_eq!(e.spend.as_ref().map(|s| s.days.len()), Some(3));
    let two = r#"{"slots":{"1":{"n":1,"machine_id":"m1","server_id":7,"fixed":true},"2":{"n":2,"machine_id":"m2","server_id":8}},"spend_daily":[{"day":"2027-01-01","eur":1}]}"#;
    let d = NodeData::from_snapshot(&Snapshot { pool: Some(two.into()), ..Default::default() }, NOW, OFF);
    let hourly = MachineCard { id: "m2".into(), name: "Nodo a ore 2".into(), ..Default::default() };
    assert!(d.extras(&hourly, &[], NOW, OFF).spend.is_none());
    let fixed = MachineCard { id: "m1".into(), ..hourly };
    assert!(d.extras(&fixed, &[], NOW, OFF).spend.is_some());
}

#[test]
fn the_submenu_opens_with_the_four_checks_then_the_charts() {
    let e = data().extras(&server(), &detail(), NOW, OFF);
    let t = dump_text(&submenu_nodes(&e, "hetzner", Palette::new(false), OFF));
    let at = |w: &str| t.find(w).unwrap_or_else(|| panic!("missing «{w}» in:\n{t}"));
    let order = ["Sicurezza · controllata 08:43", "Aggiornamenti · da guardare · 5 aggiornamenti", "Disco cifrato · a posto · cifrato", "Accesso e porte", "Antivirus e accessi falliti", "[card chart:hetzner:lag]", "[card chart:hetzner:spend]"];
    let pos: Vec<usize> = order.iter().map(|w| at(w)).collect();
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "{t}");
}

#[test]
fn the_menu_has_no_memory_sync_card_and_the_nodes_carry_it() {
    let board = r#"{"machines":[{"id":"local","name":"Mac","state":"ok","level":0,"lines":[],"metrics":[]},{"id":"hetzner","name":"Server Hetzner","state":"lavora","level":0,"lines":[],"metrics":[]}]}"#;
    let machines = r#"[{"id":"hetzner","caption":"srv-fixed · 16 core"}]"#;
    let snap = Snapshot { board: Some(board.into()), machines: Some(machines.into()), pool: Some(POOL.into()), health: Some(health_with_server()), harness_sync: Some(sync_body()),
        memory_sync: Some(format!(r#"{{"last_ok":{},"runs":[],"parts":[]}}"#, NOW - 3600)), memory_sync_set: true, ..Default::default() };
    let cards = crate::tray_menu_rich::machines_for(&[], &snap);
    let t = dump_text(&crate::tray_menu_rich::build_menu_rich(&snap, Prefs::default(), NOW, &cards, true));
    assert!(!t.contains("memory-sync"), "{t}");
    assert!(t.contains("[card machine:local]") && t.contains("[card machine:hetzner]"), "{t}");
    assert!(t.contains("[card chart:hetzner:spend]") && !t.contains("chart:hetzner:hours"), "the hours are a row of the card, not a second chart: {t}");
    // the Mac's own submenu has its checks, not the server's spend
    let mac_part = &t[t.find("[card machine:local]").unwrap()..t.find("[card machine:hetzner]").unwrap()];
    assert!(mac_part.contains("Sicurezza · controllata") && !mac_part.contains("spend"), "{mac_part}");
}

/// Off-screen renders for the eye: `TRAY_NODES_V2=<dir>` writes every card and chart, light and dark.
/// The fixture is what the three services will write; with `TRAY_NODES_V2_REAL=1` the real files, when they exist, win.
#[test]
fn tray_nodes_v2_fixture_images() {
    let Ok(dir) = std::env::var("TRAY_NODES_V2") else { return };
    std::fs::create_dir_all(&dir).unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let board = r#"{"machines":[
 {"id":"local","name":"MacBook Pro di Attilio","state":"sotto sforzo","level":1,"lines":["CPU intasata: troppi lavori aspettano il loro turno"],"metrics":[{"key":"cpu","pct":61,"level":2,"note":"lavori in coda"},{"key":"gpu","pct":87,"level":2,"note":"picco 24 h 87%"},{"key":"mem","pct":57,"level":1,"note":"swap 5,5/7 GB"},{"key":"disk","pct":94,"level":2,"note":"57,3 GB liberi"}]},
 {"id":"hetzner","name":"Server Hetzner","state":"lavora","level":0,"lines":["srv-fixed"],"metrics":[{"key":"cpu","pct":25,"level":0,"note":"4,0 di 16 core"},{"key":"mem","pct":23,"level":0,"note":"adesso"},{"key":"disk","pct":20,"level":0,"note":"230 GB liberi"},{"key":"spend","name":"Spesa","value":"8,44/60 €","level":0,"note":"server a consumo questo mese, tetto 60 €"}]},
 {"id":"pc","name":"PC Windows","state":"lavora","level":0,"lines":["Collegato al Mac (4 connessioni)"],"metrics":[{"key":"cpu","pct":6,"level":0,"note":"adesso"},{"key":"mem","pct":24,"level":0,"note":"adesso"},{"key":"disk","pct":98,"level":2,"note":"20,0 GB liberi"}]}]}"#;
    // year, month and day of month of `now`, to give the spend days of this month
    let c = crate::tray_menu_clock::civil(now * 1000, 0);
    let (mut year, mut left) = (1970, c.day);
    loop {
        let len = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) { 366 } else { 365 };
        if left < len {
            break;
        }
        left -= len;
        year += 1;
    }
    let spend: Vec<String> = (1..=c.dom).map(|d| format!(r#"{{"day":"{year:04}-{:02}-{d:02}","eur":{}}}"#, c.month + 1, [0.4, 0.6, 0.0, 1.2, 2.9, 3.4, 0.8, 0.5, 2.2][(d % 9) as usize])).collect();
    let pool = format!(r#"{{"slots":{{"1":{{"n":1,"machine_id":"m-srv","server_id":7,"name":"srv-fixed","fixed":true,"provider":"Hetzner","cards":1,"aligned":"abc","behind_since":{}}}}},"spend_daily":[{}],"spend_cap_eur":60}}"#, now - 5400, spend.join(","));
    let wave = |base: f64, amp: f64| -> String {
        (0..288).map(|i| if i % 97 == 40 { "null".to_string() } else { format!("{:.1}", (base + amp * (i as f64 / 30.0).sin() + 4.0 * (i as f64 / 5.3).sin()).clamp(1.0, 99.0)) }).collect::<Vec<_>>().join(",")
    };
    let hours = |k: i64| (0..24).map(|h| ((h * k) % 5).to_string()).collect::<Vec<_>>().join(",");
    let checks = |s: &str, d: &str| format!(r#"[{{"key":"updates","status":"{s}","detail":"{d}"}},{{"key":"disk","status":"ok","detail":"disco cifrato"}},{{"key":"access","status":"ok","detail":"solo accesso con chiave, 1 porta aperta"}},{{"key":"antivirus","status":"ok","detail":"nessun accesso fallito nelle ultime 24 ore"}}]"#);
    let machine = |id: &str, name: &str, kind: &str, st: &str, ck: String, base: f64, k: i64| {
        format!(r#"{{"id":"{id}","name":"{name}","kind":"{kind}","security":{{"checked_at":{},"status":"{st}","checks":{ck}}},"history":{{"step_s":300,"from":{},"cpu":[{}],"mem":[{}]}},"cards_today":[{}]}}"#, now - 900, now - 86_400, wave(base, 20.0), wave(base + 15.0, 6.0), hours(k))
    };
    let health = format!(r#"{{"at":{},"machines":[{},{},{}]}}"#, now - 60,
        machine("local", "Mac", "local", "warn", checks("warn", "2 aggiornamenti di macOS da installare"), 40.0, 2),
        machine("m-srv", "Server", "remote", "ok", checks("ok", "aggiornamenti automatici attivi"), 20.0, 1),
        machine("m-pc", "PC", "remote", "ok", checks("ok", "Windows aggiornato"), 10.0, 3));
    let hist: Vec<String> = (0..24).map(|i| format!(r#"{{"at":{},"lag_s":{}}}"#, now - 86_400 + i * 3600, if i < 14 { 0 } else { (i - 13) * 420 })).collect();
    let sync = format!(r#"{{"source":{{"rev":"r2","at":{now}}},"targets":{{"m-srv":{{"name":"Server","rev":"r2","at":{},"error":null,"private":"closed","private_reason":null}},"m-pc":{{"name":"PC","rev":"r1","at":{},"error":null,"private":"skipped","private_reason":"chiave non presente"}}}},"history":{{"m-srv":[{}],"m-pc":[{}]}}}}"#, now - 120, now - 4 * 3600, hist.join(","), hist.join(","));
    let mut snap = Snapshot { board: Some(board.into()), machines: Some(r#"[{"id":"hetzner","caption":"srv-fixed · 16 core"}]"#.into()), pool: Some(pool), health: Some(health), harness_sync: Some(sync),
        memory_sync: Some(format!(r#"{{"last_ok":{},"runs":[{{"at":{},"ok":true}}],"parts":[]}}"#, now - 5 * 3600, now - 5 * 3600)), memory_sync_set: true, ..Default::default() };
    if std::env::var("TRAY_NODES_V2_REAL").is_ok() {
        let read = |p: Option<std::path::PathBuf>| p.and_then(|p| std::fs::read_to_string(p).ok());
        snap.health = read(crate::tray_node_health::health_path()).or(snap.health);
        snap.harness_sync = read(crate::tray_node_health::sync_path()).or(snap.harness_sync);
    }
    // the same fixture as files, for the native menu render (`native_rows`) to read
    let fx = format!("{dir}/fixture");
    std::fs::create_dir_all(&fx).unwrap();
    for (name, body) in [("board", snap.board.clone()), ("machines", snap.machines.clone()), ("pool", snap.pool.clone()), ("health", snap.health.clone()), ("sync", snap.harness_sync.clone()), ("memory", snap.memory_sync.clone())] {
        std::fs::write(format!("{fx}/{name}.json"), body.unwrap()).unwrap();
    }
    std::fs::write(format!("{fx}/client.json"), r#"[{"id":"m-pc","title":"PC Windows","name":"PC Windows","badge":"lavora"}]"#).unwrap();
    let client = vec![MachineCard { id: "m-pc".into(), name: "PC Windows".into(), badge: "lavora".into(), ..Default::default() }];
    let machines = crate::tray_menu_rich::machines_for(&client, &snap);
    let data = NodeData::from_snapshot(&snap, now, OFF);
    let details = crate::tray_menu_detail::machine_details(snap.machines.as_deref().unwrap());
    for dark in [false, true] {
        let tag = if dark { "dark" } else { "light" };
        let p = Palette::new(dark);
        for m in &machines {
            let e = data.extras(m, &details, now, OFF);
            let key = if m.local { "local".to_string() } else { m.id.clone() };
            std::fs::write(format!("{dir}/card-{key}-{tag}.png"), crate::tray_menu_views::draw_machine_card_with(m, &e, p).to_png().unwrap()).unwrap();
            for n in submenu_nodes(&e, &key, p, OFF) {
                if let Node::Card { key: k, png, .. } = n {
                    std::fs::write(format!("{dir}/{}-{tag}.png", k.replace(':', "-")), png).unwrap();
                }
            }
        }
    }
}

// ---- layout rules (card tray-impaginazione-compatta)

#[test]
fn a_young_history_fills_the_axis_and_the_title_says_how_far_it_reaches() {
    let mut v = vec![None; 211];
    v.extend((0..77).map(|i| Some(40.0 + i as f64 % 7.0)));
    let (part, _first, secs) = covered(&v, 300);
    assert_eq!((part.len(), secs), (77, 77 * 300), "the empty start of the day is not part of the axis");
    assert!(part[0].is_some(), "the line starts on a reading");
}

#[test]
fn the_spend_of_the_chart_is_the_one_the_card_says() {
    let d = NodeData { pool: crate::tray_nodes::parse_pool(POOL), spend: crate::tray_node_health::parse_spend(POOL), ..Default::default() };
    let card = MachineCard { id: "hetzner".into(), name: "Server".into(), metrics: vec![crate::tray_menu_views::Metric { key: "spend".into(), name: "Spesa".into(), value: "8,44/60 €".into(), pct: Some(14), ..Default::default() }], ..Default::default() };
    assert_eq!(d.extras(&card, &[], NOW, OFF).spend_say.as_deref(), Some("8,44/60 €"));
    // with no spend on the card the chart keeps the log's own total
    assert_eq!(d.extras(&MachineCard { metrics: Vec::new(), ..card }, &[], NOW, OFF).spend_say, None);
}

#[test]
fn the_memory_row_is_called_and_worded_the_same_on_every_node() {
    let mac = crate::tray_menu_memory_sync::memory_sync_row(r#"{"runs":[{"at":1799990000,"ok":true}],"parts":[],"last_ok":1799990000}"#, 1_799_990_100, 0).unwrap();
    let remote = StatusRow { label: crate::tray_node_health::MEMORY_LABEL.into(), text: crate::tray_node_health::saved_text("03:01"), level: 0 };
    assert_eq!(mac.label, remote.label);
    assert!(mac.text.starts_with("salvate alle ") && remote.text == "salvate alle 03:01", "{} / {}", mac.text, remote.text);
    assert_eq!(crate::tray_node_health::saved_text("ieri 03:01"), "salvate ieri alle 03:01");
    assert_eq!(crate::tray_node_health::saved_text("3 giorni fa"), "salvate 3 giorni fa");
}

#[test]
fn every_status_row_of_a_card_fits_its_line_whole() {
    // the longest sentences the rows say, against the width from the text column to the right margin
    let room = RIGHT - (X0 + 14.0 + LABEL_W);
    for text in ["salvate alle 22:21 · privato non copiato: disco non cifrato", "da guardare · 1 aggiornamento in attesa da 7 giorni", "problema · Antivirus e accessi falliti", "salvate ieri alle 03:01 · oltre 26 ore fa"] {
        assert!(Pic::text_w(Face::SansRegular, text, 10.5) <= room, "«{text}» does not fit in {room} pt");
    }
}

// ---- holes in a chart: a hole is a hole, never a stroke or a comb

fn s(v: &[Option<f64>]) -> Vec<(usize, usize)> {
    stretches(v)
}

#[test]
fn a_hole_of_two_or_more_readings_breaks_the_line_and_one_skipped_reading_does_not() {
    let (a, n) = (Some(10.0), None);
    assert_eq!(s(&[a, a, a, a]), [(0, 3)]);
    assert_eq!(s(&[a, a, n, a, a]), [(0, 4)], "one skipped round is crossed");
    assert_eq!(s(&[a, a, n, n, a, a]), [(0, 1), (4, 5)], "two in a row are a hole");
    assert_eq!(holes(&[a, a, n, n, a, a]), [(2, 3)]);
    assert_eq!(holes(&[n, n, a, a]), [(0, 1)], "no readings yet at the start");
    assert_eq!(holes(&[a, a, n, n, n]), [(2, 4)], "nothing read lately");
    assert!(holes(&[a, n, a, a]).is_empty());
}

#[test]
fn a_reading_every_other_slot_is_dots_between_bands_not_a_comb_of_strokes() {
    // alternating readings: no segment may join two of them
    let v: Vec<Option<f64>> = (0..12).map(|i| if i % 3 == 0 { Some(5.0 + i as f64) } else { None }).collect();
    assert_eq!(s(&v), [(0, 0), (3, 3), (6, 6), (9, 9)]);
    let mut pic = Pic::new(300.0, 80.0);
    spark_line(&mut pic, (10.0, 10.0, 200.0, 12.0), &v, Palette::new(false), &|i, val| format!("{i}:{val:?}"));
    // every slot answers to the mouse, with its own words, readings or not
    assert_eq!(pic.hover.len(), 1);
    assert_eq!(pic.hover[0].points.len(), 12);
    assert_eq!(pic.hover[0].points[1].label, "1:None");
}

// ---- the mouse over a chart says the time and the value of the point under it

#[test]
fn a_cpu_point_says_its_clock_and_its_value_and_a_missing_one_says_nothing_was_read() {
    let mut e = data().extras(&server(), &detail(), NOW, OFF);
    e.from_s = 1_800_000_000 - 1_800_000_000 % 86_400 + 12 * 3600; // 12:00 UTC = 13:00 in the zone
    e.step_s = 300;
    assert_eq!(pct_say(&e, 0, 0, Some(61.6)), "13:00 · 62%");
    assert_eq!(pct_say(&e, 2, 1, Some(5.0)), "13:15 · 5%", "the slice starts two readings after the file's first");
    assert_eq!(pct_say(&e, 0, 12, None), "14:00 · nessuna lettura");
    e.from_s = 0;
    assert_eq!(pct_say(&e, 0, 0, Some(40.0)), "40%", "a file with no start time says only the value");
}

#[test]
fn the_cards_row_says_each_hour_under_the_mouse() {
    let e = data().extras(&server(), &detail(), NOW, OFF);
    let mut card = Pic::new(540.0, 200.0);
    draw_block(&mut card, &e, 0.0, Palette::new(false));
    assert_eq!(card.hover.len(), 1, "the cards of the day");
    let z = &card.hover[0];
    assert_eq!(z.points.len(), 24);
    assert_eq!(z.points[9].label, "09:00-10:00 · 3 card");
    assert_eq!(z.points[10].label, "10:00-11:00 · 1 card");
    assert_eq!(z.points[0].label, "00:00-01:00 · nessuna card");
    assert_eq!(z.points[23].label, "23:00-00:00 · nessuna card");
    // the cursor over the ninth bar finds that bar; a few points above the row's bars finds nothing
    assert_eq!(z.at(z.points[9].x, z.y + 5.0).unwrap().label, "09:00-10:00 · 3 card");
    assert!(z.at(z.points[9].x, z.y - 10.0).is_none());
}

// ---- the history of a reading is a line inside its own row

fn legend_card(with_history: bool) -> (MachineCard, NodeExtras) {
    let m = MachineCard { id: "x".into(), name: "Server".into(), badge: "acceso".into(), metrics: vec![
        crate::tray_menu_views::Metric { key: "cpu".into(), pct: Some(40), note: "di 16 core".into(), ..Default::default() },
        crate::tray_menu_views::Metric { key: "mem".into(), pct: Some(30), note: "di 32 GB".into(), ..Default::default() },
        crate::tray_menu_views::Metric { key: "disk".into(), pct: Some(20), note: "230 GB liberi".into(), ..Default::default() },
    ], ..Default::default() };
    let series = |base: f64| (0..288).map(|i| Some(base + (i % 17) as f64)).collect::<Vec<_>>();
    let e = if with_history { NodeExtras { cpu: series(20.0), mem: series(10.0), from_s: 1_800_000_000 - 86_400, step_s: 300, offset: OFF, ..Default::default() } } else { NodeExtras::default() };
    (m, e)
}

#[test]
fn a_reading_with_a_history_carries_its_line_in_its_row_and_no_separate_chart() {
    let (m, e) = legend_card(true);
    let with = crate::tray_menu_views::draw_machine_card_with(&m, &e, Palette::new(false));
    let (_, none) = legend_card(false);
    let without = crate::tray_menu_views::draw_machine_card_with(&m, &none, Palette::new(false));
    assert_eq!(with.hover.len(), 2, "one line for the CPU, one for the memory: {:?}", with.hover);
    assert!(without.hover.is_empty(), "no history, no line and no zone");
    assert_eq!(with.h, without.h, "the card is as tall as without the histories: they sit in the rows");
    // the zones are the height of a row, one per row (a machine with no GPU has them side by side): none is a block of its own
    assert!(with.hover.iter().all(|z| z.h <= 13.0), "{:?}", with.hover.iter().map(|z| z.h).collect::<Vec<_>>());
    assert!((with.hover[1].y - with.hover[0].y - 18.0).abs() < 0.5, "{:?}", with.hover.iter().map(|z| z.y).collect::<Vec<_>>());
}

#[test]
fn the_line_of_a_row_says_time_and_value_under_a_given_x_and_stays_out_of_the_next_row() {
    let (m, e) = legend_card(true);
    let pic = crate::tray_menu_views::draw_machine_card_with(&m, &e, Palette::new(false));
    let cpu = &pic.hover[0];
    // the first point of the day is 24 hours before the fixture's end; the 13th slot is an hour after it
    let hit = cpu.at(cpu.points[12].x, cpu.y + cpu.h / 2.0).unwrap();
    assert!(hit.label.ends_with(" · 32%"), "{}", hit.label);
    assert_eq!(hit.label.len(), "HH:MM · 32%".len(), "{}", hit.label);
    // 9 points under the line is the next row's text, which has nothing to say
    assert!(cpu.at(cpu.points[12].x, cpu.y + cpu.h + 9.0).is_none());
    assert!(cpu.at(cpu.points[12].x, cpu.y - 9.0).is_none());
}

#[test]
fn a_hole_in_a_row_line_is_drawn_as_a_hole() {
    let mut v: Vec<Option<f64>> = (0..60).map(|i| Some(30.0 + (i % 5) as f64)).collect();
    for x in v.iter_mut().take(40).skip(20) {
        *x = None;
    }
    let mut pic = Pic::new(200.0, 30.0);
    spark_line(&mut pic, (10.0, 8.0, 150.0, 12.0), &v, Palette::new(false), &|i, val| format!("{i}:{val:?}"));
    assert_eq!(stretches(&v), [(0, 19), (40, 59)]);
    // in the middle of the hole no pixel has the line's ink: nothing joins the two stretches
    let ink = line_ink(Palette::new(false));
    let mid_x = (10.0 + 150.0 * 30.0 / 59.0) as u32 * 2;
    let touched = (0..pic.cv.h).any(|y| pic.cv.px[((y * pic.cv.w + mid_x) * 4) as usize..][..3] == ink);
    assert!(!touched, "the hole is a band, not a stroke");
    assert_eq!(pic.hover[0].points[30].label, "30:None");
}

#[test]
fn the_lag_and_the_spend_charts_say_their_point() {
    let e = data().extras(&server(), &detail(), NOW, OFF);
    let lag = lag_card(&e, Palette::new(false)).unwrap();
    assert!(lag.hover[0].points.iter().any(|p| p.label.ends_with("in pari")), "{:?}", lag.hover[0].points);
    assert!(lag.hover[0].points.iter().any(|p| p.label.contains("indietro di")));
    let spend = spend_card(&e, Palette::new(false)).unwrap();
    let labels: Vec<&str> = spend.hover[0].points.iter().map(|p| p.label.as_str()).collect();
    // 2027-01-01 is a Friday
    assert_eq!(labels, ["ven 1 · 1,00 €", "sab 2 · 3,50 €", "dom 3 · 0,00 €"]);
}
