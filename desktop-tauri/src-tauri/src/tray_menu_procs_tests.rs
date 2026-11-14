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
    assert!(t.contains("Leftover C | 0% | n/d | n/d | 100 MB"), "{t}");
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
    assert!(t.contains("Classifiche per CPU, GPU, rete e memoria · CPU totale 1,8 core · 100% = un core intero"), "{t}");
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
