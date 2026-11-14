//! One test per piece of the projects table the first Rust tray lacked: each goes red when
//! its piece disappears. The answers are fake, shaped like the service's `/api/live`.

use super::*;
use crate::tray_menu::dump_text;

const NOW: i64 = 1_800_000_000;
const NOW_MS: i64 = NOW * 1000;

fn agent(title: &str, model: &str, started_min_ago: i64, hour: i64, pct: f64) -> String {
    format!(
        r#"{{"kind":"sessione","model":"{model}","title":"{title}","startedAt":{},"lastActivity":{},"use":{{"tokens":{hour},"hourTokens":{hour},"pct":{pct}}},"res":{{"cpu":1.0,"memMB":553,"shared":2}},"open":{{"url":"claude://x","via":"Claude"}}}}"#,
        NOW_MS - started_min_ago * 60_000,
        NOW_MS - 5_000
    )
}

fn live() -> String {
    format!(
        r#"{{"projects":[
 {{"name":"quiet","display":"Quiet one","what":"A quiet place","claude":0.8,"codex":11,"muse":37,"total":49,"state":"attivo","priority":"alta","agents":{{"count":0,"list":[]}},
   "lastSeen":{{"at":{quiet},"provider":"muse"}},"budgetPct":null}},
 {{"name":"busy-slug","display":"Busy one","title":"busy-slug","what":"The busy app","claude":53.1,"codex":0.4,"muse":2.8,"total":56.3,"state":"attivo","priority":"normale",
   "agents":{{"count":2,"opus":2,"opusMs":600000,"list":[{a1},{a2}]}},"lastSeen":{{"at":{now},"provider":"claude"}}}},
 {{"name":"old","display":"Old one","claude":5,"codex":0,"muse":0,"total":5,"state":"attivo","priority":"normale","agents":{{"count":0,"list":[]}},"lastSeen":{{"at":{old},"provider":"claude"}}}},
 {{"name":"PrinceOfPersia","title":"Prince of Persia","dead":true,"claude":0,"codex":0,"muse":0,"total":0,"state":"fermo","priority":"normale","budgetPct":3,"agents":{{"count":null,"list":[]}}}},
 {{"name":"ghost","title":"Ghost","dead":true,"claude":0,"codex":0,"muse":0,"total":0,"state":"fermo","priority":"normale","agents":{{"count":0,"list":[]}}}}]}}"#,
        quiet = NOW_MS - 17 * 3_600_000,
        old = NOW_MS - 3 * 86_400_000,
        now = NOW_MS,
        a1 = agent("Check the calls", "Opus", 10, 36_000, 0.0604),
        a2 = agent("", "Opus", 1, 8_000, 0.01),
    )
}

fn table() -> String {
    dump_text(&project_table(&Some(live()), &None, NOW, 3600))
}

#[test]
fn state_cell_counts_working_agents_or_says_how_long_the_project_is_still() {
    let t = table();
    assert!(t.contains("Busy one | 53,1 | 0,4 | 2,8 | 44k | ▸ 2"), "{t}");
    assert!(t.contains("Quiet one | 0,8 | 11,0 | 37,0 | – | ☾ 17 h"), "{t}");
    assert!(t.contains("Old one | 5,0 | – | – | – | ☾ 3 g"), "{t}");
}

#[test]
fn live_agents_sit_under_the_project_row_with_a_header_and_their_numbers() {
    let t = table();
    let from = t.find("Busy one |").unwrap();
    let block = &t[from..t[from..].find("Quiet one |").map_or(t.len(), |i| from + i)];
    assert!(block.contains("  BUSY ONE\n"), "{block}");
    assert!(block.contains("  Check the calls | 36 k/h | Opus · 10 min"), "{block}");
    // an agent with no title is named by its kind, never left empty
    assert!(block.contains("  Sessione | 8 k/h | Opus · 1 min"), "{block}");
    assert!(block.contains("36 k token nel giro · 0,1% della settimana"), "{block}");
    assert!(block.contains("8 k token nel giro\n"), "below 0,05% the week is not said: {block}");
}

#[test]
fn project_page_has_description_advice_and_the_live_agents_table() {
    let t = table();
    assert!(t.contains("Il progetto: consumi, budget, priorità"), "{t}");
    assert!(t.contains("Busy one · The busy app · 2 agenti al lavoro"), "{t}");
    assert!(t.contains("2 sessioni Opus da 10 min su un progetto che pesa il 53% della settimana Claude: valuta Sonnet"), "{t}");
    assert!(t.contains("AGENTI VIVI ADESSO | tipo | da | ultima attività | CPU · memoria"), "{t}");
    assert!(t.contains("Opus | sessione | 10 min | ora | ~1,0 core · 553 MB"), "{t}");
}

#[test]
fn quiet_projects_say_since_when_and_what_they_did_last() {
    let t = table();
    // 1_800_000_000 - 17 h is 14 Nov 2027 in the pinned +1 h zone
    assert!(t.contains("Quiet one · A quiet place · fermo: nessun agente al lavoro da 17 h, ultima attività il "), "{t}");
    assert!(t.contains("(Muse)"), "{t}");
    assert!(t.contains("Nessun agente al lavoro adesso · ultima attività 17 h fa"), "{t}");
    assert!(t.contains("da 3 g, ultima attività"), "{t}");
    assert!(t.contains("Nessun agente al lavoro adesso · ultima attività 72 h fa"), "{t}");
}

#[test]
fn budget_and_priority_offer_the_original_values_under_their_explaining_headers() {
    let t = table();
    assert!(t.contains("Budget: % della settimana Claude, oltre si ferma il non interattivo"), "{t}");
    assert!(t.contains("Priorità: alta corre di più, bassa si ferma prima"), "{t}");
    let nodes = project_table(&Some(live()), &None, NOW, 3600);
    let mut ids = Vec::new();
    fn walk(n: &[Node], out: &mut Vec<String>) {
        for x in n {
            match x {
                Node::Item { id, .. } if id.starts_with("proj-budget:quiet:") => out.push(id.clone()),
                Node::Sub { children, .. } | Node::Row { children, .. } | Node::Card { children, .. } => walk(children, out),
                _ => {}
            }
        }
    }
    walk(&nodes, &mut ids);
    let values: Vec<&str> = ids.iter().map(|i| i.rsplit(':').next().unwrap()).collect();
    assert_eq!(values, ["0", "5", "10", "15", "20", "30"]);
    assert!(t.contains("    Nessuno ✓") && t.contains("    normale") && t.contains("alta ✓"), "current values are ticked: {t}");
}

#[test]
fn names_are_readable_and_a_dead_project_with_a_setting_is_still_listed() {
    let t = table();
    assert!(t.contains("Busy one |") && !t.contains("busy-slug |"), "the slug is not a name: {t}");
    assert!(t.contains("Prince of Persia |"), "a dead project with a budget stays: {t}");
    assert!(!t.contains("Ghost"), "a dead project with no setting goes: {t}");
    assert!(t.contains("1 lavori in corso in 1 su 4") || t.contains("2 lavori in corso in 1 su 4"), "{t}");
}

#[test]
fn durations_and_ages_use_the_service_words() {
    assert_eq!(dur_text(30_000.0), "meno di 1 min");
    assert_eq!(dur_text(82.0 * 60_000.0), "1 h 22 min");
    assert_eq!(dur_text(600.0 * 60_000.0), "10 h");
    assert_eq!(idle_text(3.0 * 86_400_000.0), "3 g");
    assert_eq!(ago_text(100_000, 10_000), "1 min fa");
    assert_eq!(ago_text(10_000, 10_000), "ora");
}
