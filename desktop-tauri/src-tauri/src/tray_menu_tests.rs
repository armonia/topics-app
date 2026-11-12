//! Tests of the tray menu: pure functions plus a fake local service. Card 23ec388a.

use super::*;
use std::net::TcpListener;
use std::sync::mpsc;

const PROCS: &str = r#"{"units":[
  {"id":"macos","name":"macOS","type":"macos","closable":false,"memMB":5300,"use":{},"returns":"lo gestisce macOS","pids":[1,2]},
  {"id":"agent:1","name":"Claude · alpha","type":"sessione","owner":{"label":"Claude (app)"},"use":{"text":"aperta da 24 h"},"returns":"non torna da sola","verb":"Chiudi sessione","closable":true,"memMB":1010,"pids":[91001,91002]},
  {"id":"rest:1","name":"Vecchio server","type":"resto","use":{"text":"nessun client"},"returns":"non torna","verb":"Chiudi","closable":true,"memMB":300,"pids":[91050]},
  {"id":"rest:2","name":"Altro resto","type":"resto","use":{"text":"nessun client"},"returns":"non torna","verb":"Chiudi","closable":true,"memMB":200,"pids":[91051]}]}"#;

fn fake(status: &str) -> (String, mpsc::Receiver<String>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    let status = status.to_string();
    std::thread::spawn(move || {
        if let Ok((mut c, _)) = l.accept() {
            let mut buf = [0u8; 4096];
            let k = c.read(&mut buf).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..k]).to_string());
            let _ = c.write_all(format!("HTTP/1.0 {status}\r\n\r\n{{}}").as_bytes());
        }
    });
    (base, rx)
}

fn run(id: &str) -> (bool, String) {
    let Some(Action::Http { method, path, body }) = action_for(id, &Some(PROCS.into())) else { panic!("not http: {id}") };
    let (base, rx) = fake("200 OK");
    let ok = http_send(&base, method, &path, body.as_ref());
    (ok, rx.recv_timeout(Duration::from_secs(3)).unwrap())
}

#[test]
fn brake_two_hours_and_release() {
    let (ok, req) = run("brake-unlock:claude");
    assert!(ok && req.starts_with("POST /api/override ") && req.contains(r#""hours":2"#) && req.contains(r#""provider":"claude""#));
    let (ok, req) = run("brake-unlock-off:claude");
    assert!(ok && req.starts_with("DELETE /api/override?provider=claude "));
}

#[test]
fn hold_one_hour_and_resume() {
    let (_, req) = run("brake-hold");
    assert!(req.starts_with("POST /api/hold ") && req.contains(r#""hours":1"#));
    let (_, req) = run("brake-hold-off");
    assert!(req.starts_with("DELETE /api/hold "));
}

#[test]
fn budget_and_priority_are_saved() {
    let (_, req) = run("proj-budget:topics-app:25");
    assert!(req.starts_with("POST /api/project-settings ") && req.contains(r#""budgetPct":25"#) && req.contains("topics-app"));
    let (_, req) = run("proj-budget:topics-app:0");
    assert!(req.contains(r#""budgetPct":null"#));
    let (_, req) = run("proj-priority:topics-app:alta");
    assert!(req.contains(r#""priority":"alta""#));
}

#[test]
fn a_refusing_service_is_not_success() {
    let (base, _rx) = fake("500 Internal Server Error");
    assert!(!http_send(&base, "POST", "/api/hold", None));
    assert!(!http_send("http://127.0.0.1:1", "POST", "/api/hold", None));
}

#[test]
fn close_needs_a_closable_unit_and_lists_its_pids() {
    let p = Some(PROCS.to_string());
    assert_eq!(action_for("proc-close:agent:1", &p), Some(Action::ClosePids { name: "Claude · alpha".into(), unit: Some("agent:1".into()), pids: vec![91001, 91002] }));
    assert_eq!(action_for("proc-close:macos", &p), None);
    assert_eq!(action_for("proc-close:gone", &p), None);
    assert_eq!(leftover_pids(&p), vec![91050, 91051]);
}

#[test]
fn terminate_never_touches_pid_one_and_reports_failures() {
    assert_eq!(terminate(&[0, 1]), 0);
    // a pid nobody owns: kill fails, nothing is counted
    assert_eq!(terminate(&[4_000_000]), 0);
}

#[test]
fn procs_menu_uses_service_names_and_one_macos_row() {
    let t = dump_text(&procs_nodes(&Some(PROCS.into())));
    assert!(t.starts_with("GIRA ADESSO · 3 ·"));
    assert!(t.contains("Claude · alpha | 1,0 GB // sessione"));
    assert!(t.contains("Chiudi i resti (2 "));
    assert_eq!(t.lines().filter(|l| l.starts_with("macOS ·")).count(), 1);
    let down = dump_text(&procs_nodes(&None));
    assert!(down.contains("Non riesco a leggere i processi adesso") && !down.contains("GB"));
}

#[test]
fn long_census_is_capped_and_the_rest_counted() {
    let units: Vec<String> = (0..40).map(|i| format!(r#"{{"id":"a:{i}","name":"App {i}","type":"app","use":{{"text":"x"}},"returns":"y","memMB":{},"closable":false,"pids":[]}}"#, 500 - i)).collect();
    let body = format!(r#"{{"units":[{}]}}"#, units.join(","));
    let t = dump_text(&procs_nodes(&Some(body)));
    assert!(t.starts_with("GIRA ADESSO · 40 ·"));
    assert!(t.contains("App 14 |") && !t.contains("App 15 |"));
    assert!(t.contains("altri 25 più leggeri"));
}

#[test]
fn backup_words_per_state() {
    let now = 1_800_000_000;
    let ok = format!(r#"{{"last_ok":{now},"last_error":null,"last_read_check":{now},"icloud":{{"bytes":1073741824}},"runs":[{{"at":{},"ok":true}},{{"at":{now},"ok":true}}]}}"#, now - 172_800);
    let l = backup_lines(Some(&ok), now);
    assert_eq!(l[0], "Backup · tutto a posto, ultima copia oggi");
    assert!(l.contains(&"Giorni: 2 giorni su 3 riusciti".to_string()));
    assert!(l.contains(&"Su iCloud: 1,0 GB caricati".to_string()));
    let bad = format!(r#"{{"last_ok":{},"last_error":"restic check non passa"}}"#, now - 3600);
    let l = backup_lines(Some(&bad), now);
    assert!(l[0].starts_with("Backup · PROBLEMA, ultimo giro fallito") && l.contains(&"Ultimo errore: restic check non passa".to_string()));
    let old = format!(r#"{{"last_ok":{},"last_error":null}}"#, now - 40 * 3600);
    assert!(backup_lines(Some(&old), now)[0].starts_with("Backup · PROBLEMA, nessuna copia"));
    assert!(backup_lines(Some(r#"{"last_ok":null}"#), now)[0].starts_with("Backup · PROBLEMA, nessuna copia"));
    let unread = format!(r#"{{"last_ok":{now},"last_error":null,"last_read_check":{}}}"#, now - 777_600);
    assert!(backup_lines(Some(&unread), now)[0].starts_with("Backup · da guardare"));
    assert_eq!(backup_lines(None, now)[0], "Backup · nessun dato");
}

const BOARD: &str = r#"{"accounts":[{"label":"Claude · a","used":39,"gauge":{"short":"frenato fino a lun","say":"Oggi consuma troppo."},"access":{"state":"ok","say":"Collegato dal 13 set."}},{"label":"Codex · b","used":5,"gauge":{"short":"libero","say":"Ok."},"access":{"state":"scaduto","say":"Accesso scaduto."}}]}"#;
const OVERVIEW: &str = r#"{"providers":[{"id":"claude","accounts":[{"label":"Claude · a","quotas":[{"key":"5h","usedPct":61,"resetText":"2h10"},{"key":"7d","usedPct":39}]}]}],
  "plans":{"Claude · a":{"plan":"Ultra","price":"180 euro","period":{"from":"2026-10-23","to":"2026-11-23"}}},
  "apiSpend":{"line":"API Claude: 0 oggi"},
  "credits":{"Claude · a":{"remaining":40,"limit":250,"renewsAt":"2026-11-05","models":[{"name":"Fable","pct":12}]},"Codex · b":{"nobonus":true}}}"#;
const LIVE: &str = r#"{"projects":[{"name":"topics-app","title":"Topics","total":11.4,"state":"attivo","priority":"normale","budgetPct":null,
  "agents":{"list":[{"kind":"sessione","title":"Stato chiamate","open":{"url":"claude://claude.ai/epitaxy/local_1"}},{"kind":"sessione","title":"Senza finestra"}]},
  "topics":[{"title":"Chat di prova"}],"lastJob":{"task":"Revisione card","status":"done"}}]}"#;

fn full_snap() -> Snapshot {
    Snapshot {
        board: Some(BOARD.into()),
        overview: Some(OVERVIEW.into()),
        heavy: Some(r#"{"today":[{"account":"Claude · a","last24h":57,"perDay":3.7},{"account":"Muse","last24h":2,"perDay":0}]}"#.into()),
        procs: Some(PROCS.into()),
        automations: Some(r#"{"needsYou":5,"broken":3,"calendar":{"count":39,"next":{"title":"Rinnovo"}}}"#.into()),
        live: Some(LIVE.into()),
        gates: Some(r#"{"providers":{"claude":{"state":"libero"}},"overrides":[{"provider":"claude","until":1}]}"#.into()),
        backup: None,
        backup_set: true,
    }
}

#[test]
fn plain_install_has_no_hub_section_until_the_service_answers() {
    let none = Snapshot::default();
    assert!(build_menu(&none, Prefs::default(), 0, false).is_empty());
    let t = dump_text(&build_menu(&none, Prefs::default(), 0, true));
    assert!(t.contains("Servizio quote: offline"));
}

#[test]
fn service_down_keeps_backup_when_configured() {
    let snap = Snapshot { backup: Some(r#"{"last_ok":1800000000,"last_error":null}"#.into()), backup_set: true, ..Default::default() };
    let t = dump_text(&build_menu(&snap, Prefs::default(), 1_800_000_000, true));
    assert!(t.contains("Servizio quote: offline") && t.contains("Backup · tutto a posto"));
    assert!(!t.contains("Processi"));
    let t = dump_text(&build_menu(&snap, Prefs::default(), 1_800_000_000, false));
    assert!(t.contains("Backup · tutto a posto") && !t.contains("offline"));
    let unset = Snapshot { backup_set: false, ..Default::default() };
    assert!(build_menu(&unset, Prefs::default(), 0, true).iter().all(|n| !dump_text(std::slice::from_ref(n)).contains("Backup")));
}

#[test]
fn full_menu_has_every_section() {
    let t = dump_text(&build_menu(&full_snap(), Prefs { five_hour: true, ..Default::default() }, 0, true));
    for want in ["Claude · a · 39% · frenato fino a lun", "Codex · b · 5% · libero · non risponde", "Ritmo di oggi", "Claude · a · 57% in 24 h", "Processi", "Apri Processi",
        "Topics · 11.4%", "sessione · Stato chiamate", "Chat Topics · Chat di prova", "Ultimo lavoro · Revisione card · done", "Priorità normale ✓", "Rinnovi",
        "rinnovo 2026-11-23", "Togli lo sblocco di claude", "Ferma i lavori nuovi", "Fascia 5 ore ✓", "Automazioni · 5 ti aspettano · 3 rotte", "In calendario · 39 · prossimo: Rinnovo", "Backup · nessun dato"] {
        assert!(t.contains(want), "manca «{want}» in:\n{t}");
    }
    assert!(!t.contains("Mac e PC"), "the machine rows are drawn by the Topics tray, not here");
}

#[test]
fn each_switch_changes_what_the_menu_shows() {
    let show = |p: Prefs| dump_text(&build_menu(&full_snap(), p, 0, true));
    let off = Prefs { five_hour: false, api_credit: false, cloud_bonus: false };
    assert!(!show(off).contains("5 ore 61%") && show(Prefs { five_hour: true, ..off }).contains("5 ore 61% · libera tra 2h10"));
    assert!(!show(off).contains("API Claude") && show(Prefs { api_credit: true, ..off }).contains("API Claude: 0 oggi"));
    let on = show(Prefs { cloud_bonus: true, ..off });
    assert!(!show(off).contains("Credito AI") && on.contains("Bonus Claude · a · 40 su 250 rimasti · scade 2026-11-05") && on.contains("Fable 12%"));
}

fn clickable_ids(nodes: &[Node], out: &mut Vec<String>) {
    for n in nodes {
        match n {
            Node::Item { id, enabled: true, .. } if !id.is_empty() => out.push(id.clone()),
            Node::Sub { children, .. } => clickable_ids(children, out),
            _ => {}
        }
    }
}

#[test]
fn every_clickable_row_does_something() {
    let snap = full_snap();
    let mut ids = Vec::new();
    clickable_ids(&build_menu(&snap, Prefs::default(), 0, true), &mut ids);
    assert!(ids.iter().any(|i| i.starts_with("proj-open:")) && ids.iter().any(|i| i.starts_with("session-open:")) && ids.contains(&"open:processes".to_string()));
    let dead: Vec<&String> = ids.iter().filter(|i| action_for(i, &snap.procs).is_none()).collect();
    assert!(dead.is_empty(), "rows that do nothing on click: {dead:?}");
    assert_eq!(action_for("proj-open:topics-app", &None), Some(Action::Open("project:topics-app".into())));
    assert_eq!(action_for("session-open:file:///etc/passwd", &None), None);
}

#[test]
fn an_exhausted_unlock_is_not_offered_for_revoking() {
    let g = Some(r#"{"providers":{"claude":{"state":"frenato"}},"overrides":[{"provider":"claude","exhausted":true}]}"#.to_string());
    let t = dump_text(&brake_nodes(&g));
    assert!(t.contains("Sblocca claude per 2 ore") && !t.contains("Togli lo sblocco"));
}

#[test]
fn close_waits_for_the_yes_and_rereads_the_census() {
    let p = Some(PROCS.to_string());
    let mut killed: Vec<u32> = Vec::new();
    // no yes: the census is not even read, nothing is signalled
    let n = close_confirmed(false, || panic!("no read without a yes"), Some("agent:1"), &[91001, 91002], |p| { killed.extend_from_slice(p); p.len() });
    assert_eq!((n, killed.len()), (0, 0));
    // yes, same census: both pids
    let n = close_confirmed(true, || p.clone(), Some("agent:1"), &[91001, 91002], |p| { killed.extend_from_slice(p); p.len() });
    assert_eq!((n, killed.clone()), (2, vec![91001, 91002]));
    // yes, but the unit lost one pid and another unit now owns nothing: only the survivor
    let fresh = Some(PROCS.replace("[91001,91002]", "[91002]"));
    assert_eq!(still_closable(&fresh, Some("agent:1"), &[91001, 91002]), vec![91002]);
    // the unit is gone or no longer closable: nothing
    assert!(still_closable(&Some(r#"{"units":[]}"#.into()), Some("agent:1"), &[91001]).is_empty());
    assert!(still_closable(&None, None, &[91050]).is_empty());
    assert_eq!(still_closable(&p, None, &[91050, 5]), vec![91050]);
}

#[test]
fn prefs_round_trip() {
    let dir = std::env::temp_dir().join(format!("tray-prefs-{}", std::process::id()));
    let f = dir.join("p.json");
    assert!(load_prefs(&f).five_hour);
    let p = toggle_pref(&f, "api-credit");
    assert!(p.api_credit && load_prefs(&f).api_credit);
    assert!(!toggle_pref(&f, "five-hour").five_hour);
    let _ = std::fs::remove_dir_all(dir);
}

/// Dumps the menu as text for the bar scripts, from the live service or, with
/// TRAY_MENU_FIXTURES=<dir>, from board.json, procs.json, backup.json in that dir
/// (a missing file = that endpoint is down):
/// TRAY_MENU_DUMP=1 [TRAY_MENU_FIXTURES=dir] cargo test dump_live -- --nocapture
#[test]
fn dump_live() {
    if std::env::var("TRAY_MENU_DUMP").is_err() {
        return;
    }
    let snap = match std::env::var("TRAY_MENU_FIXTURES") {
        Ok(dir) => {
            let f = |n: &str| std::fs::read_to_string(std::path::Path::new(&dir).join(n)).ok();
            Snapshot { board: f("board.json"), procs: f("procs.json"), backup: f("backup.json"), backup_set: true, ..Default::default() }
        }
        Err(_) => Snapshot::fetch(&crate::tray_quota::hub_base(), backup_state_path().as_deref()),
    };
    let now = std::env::var("TRAY_MENU_NOW").ok().and_then(|n| n.parse().ok()).unwrap_or_else(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
    });
    println!("---MENU---\n{}---END---", dump_text(&build_menu(&snap, Prefs::default(), now, true)));
}
