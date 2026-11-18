//! The agents of a node, as the service counts them (`agents` of a row of `/api/machines/overview`): one summary
//! row for the card («3 agenti · topics-app 2, quadra 1 · 1 aspetta te») and, in the node's submenu, the list by // allow-italian: quoted UI string
//! project with what each one does and since when. Pure functions from the counts to rows and nodes.

use crate::tray_menu::{note, with_icon, Node};
use crate::tray_node_health::{span, StatusRow};
use serde::Deserialize;

#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
pub struct ProjectCount {
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub count: u32,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
pub struct AgentItem {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub state: String,
    /// When it started, in seconds or milliseconds since the epoch.
    #[serde(default)]
    pub since: Option<f64>,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
pub struct NodeAgents {
    #[serde(default)]
    pub working: u32,
    /// Waiting for the person: the ones to look at.
    #[serde(default)]
    pub waiting: u32,
    #[serde(default)]
    pub review: u32,
    /// Stopped on a limit.
    #[serde(default)]
    pub stuck: u32,
    #[serde(default)]
    pub queued: u32,
    #[serde(default)]
    pub chats: u32,
    #[serde(default, rename = "byProject")]
    pub by_project: Vec<ProjectCount>,
    #[serde(default)]
    pub items: Vec<AgentItem>,
}

impl NodeAgents {
    /// How many agents the node has: the per project counts, else the states that are an agent at work or waiting.
    pub fn total(&self) -> u32 {
        let by: u32 = self.by_project.iter().map(|p| p.count).sum();
        if by > 0 { by } else { self.working + self.waiting + self.review + self.stuck }
    }
}

/// The word of a state, as the board says it.
fn state_word(state: &str) -> &str {
    match state {
        "working" => "lavora",
        "waiting" => "aspetta te",
        "review" => "in revisione",
        "stuck" => "fermo sul limite",
        "queued" => "in coda",
        "chat" => "chat aperta",
        other => other,
    }
}

/// The sign of a state in the submenu: green at work, orange when it waits for the person or is stopped.
fn state_tone(state: &str) -> &'static str {
    match state {
        "working" => "ok",
        "waiting" | "review" | "stuck" => "warn",
        _ => "ok",
    }
}

/// «1 aspetta te · 3 agenti · topics-app 2, quadra 1»; no row for a node with none.
pub fn summary_row(a: &NodeAgents) -> Option<StatusRow> {
    let total = a.total();
    if total == 0 {
        return None;
    }
    // what asks for the person comes first: the row's first words are the ones that take the colour
    let mut parts: Vec<String> = Vec::new();
    if a.waiting > 0 {
        parts.push(format!("{} aspett{} te", a.waiting, if a.waiting == 1 { "a" } else { "ano" }));
    }
    if a.stuck > 0 {
        parts.push(format!("{} ferm{} sul limite", a.stuck, if a.stuck == 1 { "o" } else { "i" }));
    }
    parts.push(format!("{total} {}", if total == 1 { "agente" } else { "agenti" }));
    if !a.by_project.is_empty() {
        let shown: Vec<String> = a.by_project.iter().take(3).map(|p| format!("{} {}", p.project, p.count)).collect();
        let more = a.by_project.len().saturating_sub(3);
        parts.push(if more > 0 { format!("{}, altri {more}", shown.join(", ")) } else { shown.join(", ") });
    }
    let level = u32::from(a.waiting > 0 || a.stuck > 0);
    Some(StatusRow { label: "Agenti".into(), text: parts.join(" · "), level })
}

/// The list for the node's submenu: by project, the work in words, its state and since when.
pub fn submenu_nodes(a: &NodeAgents, now_secs: i64) -> Vec<Node> {
    if a.total() == 0 && a.items.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<Node> = vec![note(summary_row(a).map_or("Nessun agente".to_string(), |r| r.text))];
    let order: Vec<&str> = a.by_project.iter().map(|p| p.project.as_str()).collect();
    let mut items: Vec<&AgentItem> = a.items.iter().collect();
    items.sort_by_key(|i| order.iter().position(|p| *p == i.project).unwrap_or(usize::MAX));
    for i in items {
        let secs = i.since.map(|t| if t > 1e11 { (t / 1000.0) as i64 } else { t as i64 });
        let since = secs.filter(|t| *t > 0).map(|t| format!(" · da {}", span((now_secs - t).max(0)))).unwrap_or_default();
        let title = if i.title.trim().is_empty() { "lavoro senza titolo" } else { i.title.trim() };
        let line = if i.project.is_empty() { format!("{title} · {}{since}", state_word(&i.state)) } else { format!("{} · {title} · {}{since}", i.project, state_word(&i.state)) };
        out.push(with_icon(format!("sf:circle.fill|{}", state_tone(&i.state)), note(line)));
    }
    out
}

#[cfg(test)]
#[path = "tray_node_agents_tests.rs"]
mod tests;
