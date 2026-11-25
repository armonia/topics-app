//! The process submenu of this computer from fake census answers. Card ad8b474a.

use super::*;
use crate::tray_menu::dump_text;

const PROCS: &str = r#"{"at":1,"units":[
 {"id":"app:a","name":"App A","type":"app","owner":{"label":"la apri tu"},"ageS":7200,"use":{"text":"usata 5 h in 14 giorni"},"returns":"la riapri tu","verb":"Chiudi app","closable":true,"memMB":3000,"gpuPct":21.5,"netInBps":2000000,"netOutBps":1000,"n":4,"pids":[10,11]},
 {"id":"svc:b","name":"Service B","type":"servizio","owner":{"label":"launchd"},"use":{},"returns":"riparte da solo","verb":null,"closable":false,"memMB":500,"gpuPct":0,"netInBps":0,"netOutBps":0,"n":1,"pids":[20]},
 {"id":"resto:c","name":"Leftover C","type":"resto","owner":{"label":"nessuno"},"use":{},"returns":"non torna","verb":"Chiudi","closable":true,"memMB":100,"gpuPct":null,"netInBps":null,"netOutBps":null,"n":1,"pids":[30]},
 {"id":"macos","name":"macOS","type":"macos","owner":{"label":"macOS"},"use":{},"returns":"lo gestisce macOS","verb":null,"closable":false,"memMB":4000,"gpuPct":5,"netInBps":10,"netOutBps":10,"n":300,"pids":[1,2]}]}"#;
const TRUST: &str = r#"{"counts":{"grave":1,"attenzione":1,"ok":40},"items":[
 {"pid":20,"name":"b","level":"grave","reasons":["firma mancante"]},{"pid":99,"name":"orphan","level":"attenzione","reasons":["rete alta"]}]}"#;

fn snap() -> Snapshot {
    Snapshot {
        procs: Some(PROCS.into()),
        trust: Some(TRUST.into()),
        cpu: [(10, 150.0), (11, 20.0), (20, 3.0), (1, 5.0), (2, 5.0)].into_iter().collect(),
        ..Default::default()
    }
}

#[test]
fn rows_carry_cpu_gpu_network_and_memory_columns() {
    let t = dump_text(&procs_table(&snap()));
    assert!(t.starts_with("GIRA ADESSO · 3 · 3,6 GB | CPU | GPU | rete | memoria"), "{t}");
    assert!(t.contains("App A | 1,7 core | 22% | 1,9 MB/s | 3,0 GB"), "{t}");
    assert!(t.contains("Service B | 3% | – | – | 500 MB"), "{t}");
    assert!(t.contains("Leftover C | 0% | – | – | 100 MB"), "{t}");
}

#[test]
fn a_row_says_use_owner_and_age_and_how_it_closes() {
    let t = dump_text(&procs_table(&snap()));
    assert!(t.contains("app · usata 5 h in 14 giorni"), "{t}");
    assert!(t.contains("servizio · launchd"), "{t}");
    assert!(t.contains("da 2 h"), "age when the use text does not say it: {t}");
    assert!(t.contains("come torna: la riapri tu") && t.contains("rete ↓ 1,9 MB/s ↑ 1000 B/s"), "{t}");
    assert!(t.contains("Chiudi app…") && t.contains("Chiudi i resti (1 "), "{t}");
}

#[test]
fn the_rest_of_a_long_list_has_its_own_submenu() {
    let units: Vec<String> = (0..20).map(|i| format!(r#"{{"id":"a:{i}","name":"App {i}","type":"app","memMB":{},"pids":[]}}"#, 900 - i)).collect();
    let sn = Snapshot { procs: Some(format!(r#"{{"units":[{}]}}"#, units.join(","))), ..Default::default() };
    let t = dump_text(&procs_table(&sn));
    assert!(t.contains("Tutto il resto (5) · "), "{t}");
    assert!(t.contains("TUTTO IL RESTO | CPU | GPU | rete | memoria"));
}

#[test]
fn trust_summary_names_the_suspects_and_counts_the_ok() {
    let t = dump_text(&procs_table(&snap()));
    assert!(t.contains("1 sospetto · 1 da guardare · 40 ok"), "{t}");
    assert!(t.contains("orphan · rete alta"), "a flagged pid with no unit still shows: {t}");
    let calm = Snapshot { trust: Some(r#"{"counts":{"grave":0,"attenzione":0,"ok":842},"items":[]}"#.into()), ..snap() };
    assert!(dump_text(&procs_table(&calm)).contains("Processi attendibili · 842 ok"));
}

#[test]
fn macos_row_and_rankings_are_there() {
    let t = dump_text(&procs_table(&snap()));
    assert!(t.contains("macOS · 300 processi | 10% | 5,0% | 20 B/s") || t.contains("macOS · 300 processi | 10% | 5,0% | –"), "{t}");
    assert!(t.contains("Classifiche · CPU totale 1,8 core · 100% = un core intero"), "{t}");
    for h in ["PIÙ CPU ADESSO", "PIÙ MEMORIA", "PIÙ GPU ADESSO", "PIÙ RETE ADESSO"] {
        assert!(t.contains(&format!("{h} | CPU")), "{h}");
    }
}

#[test]
fn without_the_service_one_line_says_so() {
    assert!(dump_text(&procs_table(&Snapshot::default())).contains("Non riesco a leggere i processi adesso"));
}

#[test]
fn ps_output_becomes_a_cpu_map() {
    let m = crate::tray_menu::parse_ps("    1   0.0\n  345  12,5\nbad line\n");
    assert_eq!((m.get(&1), m.get(&345), m.len()), (Some(&0.0), Some(&12.5), 2));
}

#[test]
fn tray_every_closable_row_offers_both_close_and_force_close() {
    let t = dump_text(&procs_table(&snap()));
    let app = &t[t.find("App A |").unwrap()..];
    assert!(app.contains("Chiudi app…") && app.contains("Forza chiusura…"), "{t}");
    let nodes = procs_table(&snap());
    fn ids(n: &[Node], out: &mut Vec<String>) {
        for x in n {
            match x {
                Node::Item { id, .. } if !id.is_empty() => out.push(id.clone()),
                Node::Sub { children, .. } | Node::Row { children, .. } => ids(children, out),
                Node::Icon { node, .. } => ids(std::slice::from_ref(&**node), out),
                _ => {}
            }
        }
    }
    let mut found = Vec::new();
    ids(&nodes, &mut found);
    assert!(found.contains(&"proc-close:app:a".to_string()) && found.contains(&"proc-force:app:a".to_string()), "{found:?}");
    assert!(!found.contains(&"proc-force:svc:b".to_string()), "a service that is not closable has no force row");
}

#[test]
fn tray_rows_carry_the_icon_of_their_kind() {
    let app = serde_json::json!({"type": "app", "bundle": "/Applications/Example.app"});
    assert_eq!(unit_icon(&app, ""), "app:/Applications/Example.app");
    assert_eq!(unit_icon(&app, "grave"), "sf:exclamationmark.shield.fill");
    assert_eq!(unit_icon(&serde_json::json!({"type": "servizio"}), ""), "sf:gearshape");
    assert_eq!(unit_icon(&serde_json::json!({"type": "app"}), ""), "sf:app", "an app with no bundle falls back to the kind sign");
}

#[test]
fn a_remote_command_line_keeps_the_program_name_and_fits_under_the_row() {
    assert_eq!(short_cmd("/srv/x/_tool/node/24/bin/node --test"), "node --test");
    assert_eq!(short_cmd(r"C:\Windows\System32\svchost.exe -k netsvcs"), "svchost.exe -k netsvcs");
    assert_eq!(short_cmd(""), "");
    let long = short_cmd(&format!("/a/b/chrome {}", "--flag ".repeat(20)));
    assert!(long.starts_with("chrome --flag") && long.ends_with('…') && long.chars().count() <= 56, "{long}");
}

#[test]
fn a_unit_that_can_be_closed_is_set_in_semibold_and_one_that_cannot_is_not() {
    fn looks(nodes: &[Node], out: &mut Vec<(String, bool)>) {
        for n in nodes {
            match n {
                Node::Icon { node, .. } => looks(std::slice::from_ref(&**node), out),
                Node::Row { cells, header: false, look, .. } => out.push((cells[0].clone(), look.bold)),
                _ => {}
            }
        }
    }
    let mut found = Vec::new();
    looks(&procs_table(&snap()), &mut found);
    for (name, bold) in [("App A", true), ("Leftover C", true), ("Service B", false)] {
        assert_eq!(found.iter().find(|(n, _)| n == name).map(|(_, b)| *b), Some(bold), "{name}: {found:?}");
    }
}

#[test]
fn a_dev_server_row_names_its_port_and_project_not_its_kind_twice() {
    let u: Value = serde_json::from_str(r#"{"name":"Server di sviluppo · astro :4633 · armonia-agency","type":"devserver"}"#).unwrap();
    assert_eq!(row_name(&u), "astro :4633 · armonia-agency");
    let other: Value = serde_json::from_str(r#"{"name":"Server di sviluppo · x","type":"app"}"#).unwrap();
    assert_eq!(row_name(&other), "Server di sviluppo · x");
}
