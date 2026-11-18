//! The agents of a node: the summary row of the card and the list of its submenu, from the shape the service sends.

use super::*;
use crate::tray_menu::dump_text;

#[test]
fn every_state_the_service_names_has_its_words() {
    for (state, words) in [("working", "lavora"), ("waiting", "aspetta te"), ("review", "in revisione"), ("stuck", "fermo sul limite"), ("queued", "in coda"), ("chat", "chat aperta")] {
        assert_eq!(state_word(state), words);
    }
}

const SHAPE: &str = r#"{"working":2,"waiting":1,"review":0,"stuck":0,"queued":1,"chats":3,
  "byProject":[{"project":"topics-app","count":2},{"project":"quadra","count":1}],
  "items":[{"title":"Tray: impaginazione","project":"topics-app","state":"working","since":1800000000000},
           {"title":"Matrice admin","project":"quadra","state":"waiting","since":1799990000},
           {"title":"Revisione","project":"topics-app","state":"working","since":1799999000}]}"#;

#[test]
fn the_card_says_how_many_where_and_how_many_wait_for_the_person() {
    let a: NodeAgents = serde_json::from_str(SHAPE).unwrap();
    let r = summary_row(&a).unwrap();
    assert_eq!((r.label.as_str(), r.text.as_str(), r.level), ("Agenti", "1 aspetta te · 3 agenti · topics-app 2, quadra 1", 1));
}

#[test]
fn a_node_with_no_agent_has_no_row_and_no_list() {
    let none = NodeAgents::default();
    assert!(summary_row(&none).is_none() && submenu_nodes(&none, 1_800_000_000).is_empty());
    // at work only: calm, and the plural agrees
    let one: NodeAgents = serde_json::from_str(r#"{"working":1,"byProject":[{"project":"quadra","count":1}]}"#).unwrap();
    let r = summary_row(&one).unwrap();
    assert_eq!((r.text.as_str(), r.level), ("1 agente · quadra 1", 0));
}

#[test]
fn many_projects_show_three_and_count_the_rest() {
    let a: NodeAgents = serde_json::from_str(r#"{"working":5,"byProject":[{"project":"a","count":2},{"project":"b","count":1},{"project":"c","count":1},{"project":"d","count":1}]}"#).unwrap();
    assert_eq!(summary_row(&a).unwrap().text, "5 agenti · a 2, b 1, c 1, altri 1");
}

#[test]
fn the_submenu_lists_the_work_by_project_with_its_state_and_since_when() {
    let a: NodeAgents = serde_json::from_str(SHAPE).unwrap();
    let t = dump_text(&submenu_nodes(&a, 1_800_000_600));
    assert!(t.contains("1 aspetta te · 3 agenti · topics-app 2, quadra 1"), "{t}");
    // seconds and milliseconds are both read; the projects come in the order of the counts
    assert!(t.contains("topics-app · Tray: impaginazione · lavora · da 10 minuti"), "{t}");
    assert!(t.contains("quadra · Matrice admin · aspetta te · da 2 ore"), "{t}");
    assert!(t.find("topics-app · Revisione").unwrap() < t.find("quadra · Matrice").unwrap(), "{t}");
}
