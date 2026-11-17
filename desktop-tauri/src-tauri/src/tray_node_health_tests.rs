//! The rows of a node card: memories and rules, code, security, and the Mac's saved memories.
//! NOW is 09:00 in the +1 h zone the tests pin.

use super::*;
use crate::tray_menu_memory_sync::{memory_sync_row, memory_sync_valid};

pub(crate) const NOW: i64 = 1_800_000_000;
const OFF: i64 = 3600;

fn sync(target: &str) -> HarnessSync {
    parse_sync(&format!(r#"{{"source":{{"rev":"r2","at":{NOW}}},"targets":{{"m1":{target}}},"history":{{"m1":[{{"at":{},"lag_s":120}},{{"at":{NOW},"lag_s":0}}]}}}}"#, NOW - 600)).unwrap()
}

fn target(rev: &str, at: i64, error: &str, private: &str, reason: &str) -> String {
    format!(r#"{{"name":"n","rev":"{rev}","at":{at},"error":{error},"private":"{private}","private_reason":{reason}}}"#)
}

#[test]
fn memories_and_rules_aligned_say_the_hour_of_the_copy() {
    let s = sync(&target("r2", NOW - 3600, "null", "open", "null"));
    let r = sync_row(&s, "m1", OFF).unwrap();
    assert_eq!((r.label.as_str(), r.text.as_str(), r.level), ("Memorie e regole", "salvate alle 08:00", 0));
}

#[test]
fn memories_and_rules_behind_say_how_late_and_judge_by_the_lag() {
    let min = sync_row(&sync(&target("r1", NOW - 20 * 60, "null", "open", "null")), "m1", OFF).unwrap();
    assert_eq!((min.text.as_str(), min.level), ("indietro di 20 minuti", 0));
    let hours = sync_row(&sync(&target("r1", NOW - 5 * 3600, "null", "open", "null")), "m1", OFF).unwrap();
    assert_eq!((hours.text.as_str(), hours.level), ("indietro di 5 ore", 1));
    let one = sync_row(&sync(&target("r1", NOW - 3601, "null", "open", "null")), "m1", OFF).unwrap();
    assert_eq!(one.text, "indietro di 1 ora");
    let old = sync_row(&sync(&target("r1", NOW - 30 * 3600, "null", "open", "null")), "m1", OFF).unwrap();
    assert_eq!((old.text.as_str(), old.level), ("indietro di 30 ore", 2));
    let days = sync_row(&sync(&target("r1", NOW - 3 * 86_400, "null", "open", "null")), "m1", OFF).unwrap();
    assert_eq!(days.text, "indietro di 3 giorni");
}

#[test]
fn a_closed_private_store_is_worth_a_look_and_a_skipped_one_says_why() {
    let closed = sync_row(&sync(&target("r2", NOW, "null", "closed", "null")), "m1", OFF).unwrap();
    assert_eq!((closed.text.as_str(), closed.level), ("salvate alle 09:00 · privato chiuso", 1));
    let skipped = sync_row(&sync(&target("r2", NOW, "null", "skipped", r#""chiave assente""#)), "m1", OFF).unwrap();
    assert_eq!((skipped.text.as_str(), skipped.level), ("salvate alle 09:00 · privato non copiato: chiave assente", 0));
    let off = sync_row(&sync(&target("r2", NOW, "null", "off", "null")), "m1", OFF).unwrap();
    assert_eq!(off.text, "salvate alle 09:00");
}

#[test]
fn a_sync_error_is_a_problem_and_a_machine_the_file_does_not_know_has_no_row() {
    let r = sync_row(&sync(&target("r2", NOW, r#""rsync: connessione rifiutata""#, "open", "null")), "m1", OFF).unwrap();
    assert_eq!((r.text.as_str(), r.level), ("rsync: connessione rifiutata", 2));
    // an unreachable node says so in a few words: the transport's message and the closed private part are not repeated
    let down = sync_row(&sync(&target("r2", NOW, r#""nodo non raggiungibile: Connection timed out during banner exchange""#, "closed", r#""nodo non raggiungibile""#)), "m1", OFF).unwrap();
    assert_eq!((down.text.as_str(), down.level), ("nodo non raggiungibile", 2));
    assert!(sync_row(&sync(&target("r2", NOW, "null", "open", "null")), "other", OFF).is_none());
    assert!(parse_sync("not json").is_none() && parse_sync("{}").is_none());
}

fn seat(extra: &str) -> PoolNode {
    crate::tray_nodes::parse_pool(&format!(r#"{{"slots":{{"1":{{"n":1,"server_id":1,"machine_id":"m1"{extra}}}}}}}"#)).remove(0)
}

#[test]
fn code_aligned_or_behind_since() {
    assert_eq!(code_row(&seat(""), NOW, OFF), row("Codice", "allineato a main", 0));
    let a = code_row(&seat(&format!(r#","behind_since":{}"#, NOW - 600)), NOW, OFF);
    assert_eq!((a.text.as_str(), a.level), ("indietro da 10 minuti", 0));
    let b = code_row(&seat(&format!(r#","behind_since":{}"#, NOW - 3 * 3600)), NOW, OFF);
    assert_eq!((b.text.as_str(), b.level), ("indietro da 3 ore", 1));
    let c = code_row(&seat(&format!(r#","behind_since":{}"#, NOW - 2 * 86_400)), NOW, OFF);
    assert_eq!((c.text.as_str(), c.level), ("indietro da 2 giorni", 2));
}

#[test]
fn code_draining_and_failed_add_the_duration_the_badge_does_not_say() {
    let d = code_row(&seat(&format!(r#","behind_since":{},"draining":true,"drain_until":{}"#, NOW - 7200, NOW + 3600)), NOW, OFF);
    assert_eq!((d.text.as_str(), d.level), ("indietro da 2 ore, si riallinea fino alle 10:00", 1));
    let f = code_row(&seat(&format!(r#","behind_since":{},"align_failed":"abc""#, NOW - 7200)), NOW, OFF);
    assert_eq!((f.text.as_str(), f.level), ("indietro da 2 ore, riallineamento fallito", 2));
    assert_eq!(code_row(&seat(r#","align_failed":"abc""#), NOW, OFF).text, "riallineamento fallito");
}

pub(crate) fn health_body(at: i64, status: &str, checks: &str) -> String {
    format!(r#"{{"at":{at},"machines":[
 {{"id":"loc","name":"Mac","kind":"local","security":{{"checked_at":{at},"status":"{status}","checks":{checks}}},
   "history":{{"step_s":300,"from":{},"cpu":[10,20,null,40],"mem":[50,55,60,null]}},"cards_today":[0,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3]}},
 {{"id":"m1","name":"Server","kind":"remote","security":{{"checked_at":null,"status":"unknown","checks":[]}},"history":{{"step_s":300,"from":0,"cpu":[],"mem":[]}},"cards_today":[]}}]}}"#, NOW - 86_400)
}

const CHECKS_OK: &str = r#"[{"key":"updates","status":"ok","detail":"nessun aggiornamento in sospeso"},{"key":"disk","status":"ok","detail":"cifrato"},{"key":"access","status":"info","detail":"2 porte aperte"},{"key":"antivirus","status":"ok","detail":"0 accessi falliti"}]"#;

fn security(status: &str, checks: &str, at: i64, now: i64) -> StatusRow {
    let h = parse_health(&health_body(at, status, checks)).unwrap();
    security_row(&h, &h.machines[0], now)
}

#[test]
fn security_fine_says_a_posto() {
    assert_eq!(security("ok", CHECKS_OK, NOW, NOW), row("Sicurezza", "a posto", 0));
}

#[test]
fn security_warn_and_problem_carry_the_detail_of_the_worst_check() {
    let warn = r#"[{"key":"updates","status":"warn","detail":"3 aggiornamenti da installare"},{"key":"disk","status":"ok","detail":"cifrato"}]"#;
    assert_eq!(security("warn", warn, NOW, NOW), row("Sicurezza", "da guardare · 3 aggiornamenti da installare", 1));
    let bad = r#"[{"key":"updates","status":"warn","detail":"3 aggiornamenti"},{"key":"disk","status":"problem","detail":"disco non cifrato"},{"key":"access","status":"problem","detail":"secondo problema"}]"#;
    assert_eq!(security("problem", bad, NOW, NOW), row("Sicurezza", "problema · disco non cifrato", 2));
    // a status that disagrees with its checks never hides the worse one
    assert_eq!(security("ok", bad, NOW, NOW).level, 2);
}

#[test]
fn security_from_an_old_file_says_how_old_and_never_a_posto() {
    let r = security("ok", CHECKS_OK, NOW - 3 * 3600, NOW);
    assert_eq!((r.text.as_str(), r.level), ("non controllata da 3 ore", 1));
    // within the hour the file still counts
    assert_eq!(security("ok", CHECKS_OK, NOW - 3000, NOW).text, "a posto");
}

#[test]
fn security_never_checked_says_so() {
    let h = parse_health(&health_body(NOW, "ok", CHECKS_OK)).unwrap();
    let r = security_row(&h, &h.machines[1], NOW);
    assert_eq!((r.text.as_str(), r.level), ("non ancora controllata", 1));
}

#[test]
fn the_four_checks_come_in_order_with_their_words() {
    let h = parse_health(&health_body(NOW, "ok", CHECKS_OK)).unwrap();
    let lines = check_lines(&h.machines[0]);
    let labels: Vec<&str> = lines.iter().map(|l| l.0.as_str()).collect();
    assert_eq!(labels, ["Aggiornamenti", "Disco cifrato", "Accesso e porte", "Antivirus e accessi falliti"]);
    assert_eq!(lines[0].2, "a posto · nessun aggiornamento in sospeso");
    assert_eq!(lines[2].2, "2 porte aperte", "an info check has no state word");
}

#[test]
fn health_machines_are_found_by_kind_id_or_name() {
    let h = parse_health(&health_body(NOW, "ok", CHECKS_OK)).unwrap();
    assert_eq!(health_of(&h, true, &[], "whatever").unwrap().id, "loc");
    assert_eq!(health_of(&h, false, &["", "m1"], "x").unwrap().id, "m1");
    assert_eq!(health_of(&h, false, &["zzz"], "  server ").unwrap().id, "m1");
    // a remote card never takes this computer's row
    assert!(health_of(&h, false, &["loc"], "Mac").is_none());
    assert!(parse_health("not json").is_none() && parse_health(r#"{"at":1}"#).is_none());
}

#[test]
fn the_series_of_a_machine_are_read_with_their_gaps() {
    let h = parse_health(&health_body(NOW, "ok", CHECKS_OK)).unwrap();
    assert_eq!(h.machines[0].cpu, vec![Some(10.0), Some(20.0), None, Some(40.0)]);
    assert_eq!(h.machines[0].cards_today.iter().sum::<u32>(), 6);
}

#[test]
fn the_spend_of_the_month_is_read_in_day_order_and_none_without_a_day() {
    let s = parse_spend(r#"{"spend_daily":[{"day":"2026-11-02","eur":1.5},{"day":"2026-11-01","eur":0.5}],"spend_cap_eur":60}"#).unwrap();
    assert_eq!(s.days[0].0, "2026-11-01");
    assert_eq!(s.cap, Some(60.0));
    assert!(parse_spend(r#"{"spend_daily":[]}"#).is_none() && parse_spend(r#"{"slots":{}}"#).is_none());
    assert_eq!(parse_spend(r#"{"spend_daily":[{"day":"2026-11-01","eur":1}]}"#).unwrap().cap, None);
}

#[test]
fn saved_memories_of_the_mac_are_a_row_with_the_hour() {
    let body = |last_ok: &str, err: &str, rc: &str| format!(r#"{{"last_ok":{last_ok},"last_rc":{rc},"last_error":{err},"runs":[{{"at":{NOW},"ok":true}}],"parts":[]}}"#);
    let ok = memory_sync_row(&body(&(NOW - 3600).to_string(), "null", "0"), NOW, OFF).unwrap();
    assert_eq!((ok.label.as_str(), ok.text.as_str(), ok.level), ("Memorie e regole", "salvate alle 08:00", 0));
    let yesterday = memory_sync_row(&body(&(NOW - 20 * 3600).to_string(), "null", "0"), NOW, OFF).unwrap();
    assert_eq!((yesterday.text.as_str(), yesterday.level), ("salvate ieri alle 13:00", 0));
    let stale = memory_sync_row(&body(&(NOW - 27 * 3600).to_string(), "null", "0"), NOW, OFF).unwrap();
    assert_eq!((stale.text.as_str(), stale.level), ("salvate ieri alle 06:00 · oltre 26 ore fa", 1));
    assert_eq!(memory_sync_row(&body("null", "null", "null"), NOW, OFF).unwrap().level, 1);
    let failed = memory_sync_row(&body(&(NOW - 3600).to_string(), "\"git push rifiutato\"", "1"), NOW, OFF).unwrap();
    assert_eq!(failed.level, 2);
    assert!(failed.text.contains("git push rifiutato") && failed.text.contains("riuscito 08:00"), "{}", failed.text);
    // a bare exit code is enough, and so is a newest run on record that failed
    assert_eq!(memory_sync_row(&body(&NOW.to_string(), "null", "2"), NOW, OFF).unwrap().level, 2);
    let last_bad = format!(r#"{{"last_ok":{NOW},"runs":[{{"at":{},"ok":true}},{{"at":{NOW},"ok":false}}],"parts":[]}}"#, NOW - 1000);
    assert_eq!(memory_sync_row(&last_bad, NOW, OFF).unwrap().level, 2);
}

#[test]
fn saved_memories_are_no_row_without_a_valid_answer() {
    for body in ["", "not json", "{}", r#"{"error":"not found"}"#, r#"{"runs":[]}"#, "[]"] {
        assert!(memory_sync_row(body, NOW, OFF).is_none(), "{body}");
        assert!(!memory_sync_valid(body), "{body}");
    }
    assert!(memory_sync_valid(r#"{"runs":[],"parts":[]}"#));
}

#[test]
fn a_private_reason_that_already_says_privato_is_not_said_twice() {
    let r = sync_row(&sync(&target("r2", NOW, "null", "skipped", r#""privato non copiato: disco non cifrato""#)), "m1", OFF).unwrap();
    assert_eq!(r.text, "salvate alle 09:00 · privato non copiato: disco non cifrato");
    // the writer's technical aside in brackets is left out: the line has to fit the card
    let long = sync_row(&sync(&target("r2", NOW, "null", "skipped", r#""privato non copiato: disco non cifrato (BitLocker spento su C:)""#)), "m1", OFF).unwrap();
    assert_eq!(long.text, "salvate alle 09:00 · privato non copiato: disco non cifrato");
}

#[test]
fn the_security_row_is_a_short_state_then_the_first_clause_of_the_worst_check() {
    let long = r#"[{"key":"updates","status":"warn","detail":"1 aggiornamento in attesa da 7 giorni, riavvio necessario per installarlo e altro ancora che non serve"}]"#;
    let r = security("warn", long, NOW, NOW);
    assert_eq!(r.text, "da guardare · 1 aggiornamento in attesa da 7 giorni");
    assert!(r.text.chars().count() <= 14 + 56 + 1, "one line: {}", r.text);
}

#[test]
fn a_check_line_does_not_say_its_name_twice() {
    let h = parse_health(&health_body(NOW, "ok", r#"[{"key":"disk","status":"ok","detail":"Disco cifrato (FileVault acceso)"}]"#)).unwrap();
    let lines = check_lines(&h.machines[0]);
    assert_eq!(lines[0].2, "a posto · FileVault acceso");
}
