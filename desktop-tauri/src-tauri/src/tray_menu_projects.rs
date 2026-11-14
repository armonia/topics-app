//! The projects table of the tray menu and the submenus under each row: who works
//! and since when, the live agents, the project's own page (consumption, budget,
//! priority) and how long a quiet project has been quiet. Pure: service answers in,
//! `Node`s out. Every figure is the service's own; only the wording is composed here.

use crate::tray_menu::{budget_priority_nodes, civil, item, n, note, parse, s, sub, Node};
use serde_json::Value;

fn comma(v: f64, digits: usize) -> String {
    format!("{v:.digits$}").replace('.', ",")
}

/// A span in the service's short words: «meno di 1 min», «12 min», «1 h 22 min», «17 h». allow-italian: quoted menu wording
pub(crate) fn dur_text(ms: f64) -> String {
    let m = (ms / 60_000.0) as i64;
    if m < 1 {
        return "meno di 1 min".into();
    }
    if m < 60 {
        return format!("{m} min");
    }
    let (h, r) = (m / 60, m % 60);
    if r == 0 || h >= 10 { format!("{h} h") } else { format!("{h} h {r} min") }
}

/// How long ago, «ora» under a minute.
pub(crate) fn ago_text(now_ms: i64, at_ms: i64) -> String {
    let d = (now_ms - at_ms).max(0) as f64;
    if d < 60_000.0 { "ora".into() } else { format!("{} fa", dur_text(d)) }
}

/// How long a project has been still, in days from one day on: «2 h», «17 h», «3 g».
fn idle_text(ms: f64) -> String {
    if ms >= 86_400_000.0 { format!("{} g", (ms / 86_400_000.0) as i64) } else { dur_text(ms) }
}

/// Tokens as the original tray writes them: 36 k, 1,4 M.
fn tok_text(t: f64) -> String {
    if t >= 1e6 { format!("{} M", comma(t / 1e6, 1)) } else if t >= 1e3 { format!("{} k", (t / 1e3).round() as i64) } else { format!("{}", t as i64) }
}

/// Tokens in the last hour, short, for the table column: 12k, 1,4M.
fn tokens_short(t: f64) -> String {
    tok_text(t).replace(' ', "")
}

fn pct_short(v: f64) -> String {
    if v > 0.0 { format!("{}%", comma(v, 1)) } else { "–".into() }
}

/// Whole percent from ten up, one decimal below: the shape of the original's sentences.
fn pct_word(v: f64) -> String {
    if v == 0.0 { "–".into() } else { format!("{}%", comma(v, usize::from(v < 10.0))) }
}

fn cap_first(t: &str) -> String {
    let mut c = t.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn clip(t: &str, max: usize) -> String {
    if t.chars().count() > max { format!("{}…", t.chars().take(max - 1).collect::<String>()) } else { t.to_string() }
}

fn agents_of(p: &Value) -> Vec<&Value> {
    p.get("agents").and_then(|a| a.get("list")).and_then(Value::as_array).map(|l| l.iter().collect()).unwrap_or_default()
}

fn working(p: &Value) -> bool {
    !agents_of(p).is_empty() || p.get("agents").and_then(|a| a.get("count")).and_then(Value::as_i64).unwrap_or(0) > 0
}

fn agent_count(p: &Value) -> usize {
    agents_of(p).len().max(p.get("agents").and_then(|a| a.get("count")).and_then(Value::as_i64).unwrap_or(0) as usize)
}

/// The name a person knows the project by: the service's display name, never the folder slug when there is a better one.
fn shown_name(p: &Value) -> &str {
    ["display", "title", "name"].iter().map(|k| s(p, k)).find(|t| !t.is_empty()).unwrap_or("")
}

fn prov_name(id: &str) -> String {
    match id {
        "codex" => "Codex".into(),
        "muse" => "Muse".into(),
        "claude" => "Claude".into(),
        other => other.into(),
    }
}

fn last_seen_at(p: &Value) -> Option<i64> {
    p.get("lastSeen").and_then(|l| l.get("at")).and_then(Value::as_f64).map(|t| t as i64)
}

/// The state cell: how many agents work (with the icon), or how long the project has been still.
fn state_cell(p: &Value, now_ms: i64) -> String {
    if working(p) {
        return format!("▸ {}", agent_count(p));
    }
    if s(p, "state") == "frenato" {
        return "frenato".into();
    }
    match last_seen_at(p) {
        Some(at) => format!("☾ {}", idle_text((now_ms - at).max(0) as f64)),
        None => "–".into(),
    }
}

/// Why a project does not work, in one sentence: braked, or since when it is quiet and what it did last.
fn idle_reason(p: &Value, now_ms: i64, offset: i64) -> Option<String> {
    if working(p) {
        return None;
    }
    if s(p, "state") == "frenato" {
        let budget_done = p.get("budgetPct").and_then(Value::as_f64).filter(|b| n(p, "claude") >= *b);
        let why = if !s(p, "brake").is_empty() {
            s(p, "brake").to_string()
        } else if let Some(b) = budget_done {
            format!("il budget Claude ({}% della settimana) è finito", b as i64)
        } else {
            "i lavori rimandabili aspettano un abbonamento libero".into()
        };
        return Some(format!("frenato: {why}"));
    }
    let mut out = "fermo: nessun agente al lavoro".to_string();
    match p.get("lastSeen").filter(|l| !l.is_null()) {
        Some(l) => {
            let at = n(l, "at") as i64;
            let c = civil(at, offset);
            out += &format!(" da {}, ultima attività il {}/{} ({})", idle_text((now_ms - at).max(0) as f64), c.dom, c.month + 1, prov_name(s(l, "provider")));
        }
        None => out += " da oltre 7 giorni",
    }
    if p.get("dirMissing").and_then(Value::as_bool) == Some(true) {
        out += " · la cartella dove lavorava era temporanea e non esiste più";
    }
    Some(out)
}

fn state_words(p: &Value, now_ms: i64) -> String {
    let c = agent_count(p);
    if c > 0 {
        return format!("{c} {} al lavoro", if c == 1 { "agente" } else { "agenti" });
    }
    if s(p, "state") == "frenato" {
        return "frenato".into();
    }
    last_seen_at(p).map_or("fermo".into(), |at| format!("fermo da {}", idle_text((now_ms - at).max(0) as f64)))
}

/// The advice for a project that burns the Claude week with Opus sessions.
fn opus_warning(p: &Value) -> Option<String> {
    let a = p.get("agents")?;
    let opus = n(a, "opus") as i64;
    if opus == 0 || !(n(p, "claude") >= 10.0 || n(a, "opusMs") >= 2.0 * 3_600_000.0) {
        return None;
    }
    Some(format!(
        "{opus} {} da {} su un progetto che pesa il {} della settimana Claude: valuta Sonnet",
        if opus == 1 { "sessione Opus" } else { "sessioni Opus" },
        dur_text(n(a, "opusMs")),
        pct_word(n(p, "claude"))
    ))
}

/// «12 k token nel giro · 0,1% della settimana», and what the agent waits for, if anything. allow-italian: quoted menu wording
fn agent_detail(a: &Value, now_ms: i64) -> String {
    let u = a.get("use");
    let mut parts: Vec<String> = Vec::new();
    if let Some(c) = a.get("command").filter(|c| !c.is_null()) {
        let k = n(c, "n") as i64;
        parts.push(format!("aspetta {} da {}", if k == 1 { "un comando".to_string() } else { format!("{k} comandi") }, dur_text((now_ms - n(c, "since") as i64) as f64)));
    }
    if let Some(u) = u {
        let pct = u.get("pct").and_then(Value::as_f64).filter(|p| *p >= 0.05).map(|p| format!(" · {}% della settimana", comma(p, 1))).unwrap_or_default();
        parts.push(format!("{} token nel giro{pct}", tok_text(n(u, "tokens"))));
    }
    if s(a, "kind") != "sessione" {
        parts.push(s(a, "kind").to_string());
    }
    parts.join(" · ")
}

fn open_url(a: &Value) -> &str {
    a.get("open").map(|o| s(o, "url")).unwrap_or("")
}

/// Identical agents (same title, model and kind) in one line with a count.
fn grouped<'a>(list: &[&'a Value]) -> Vec<(&'a Value, usize)> {
    let mut out: Vec<(&Value, usize)> = Vec::new();
    for a in list {
        let key = |x: &Value| (s(x, "title").to_string(), s(x, "model").to_string(), s(x, "kind").to_string());
        match out.iter_mut().find(|(g, _)| key(g) == key(a)) {
            Some((_, k)) => *k += 1,
            None => out.push((a, 1)),
        }
    }
    out
}

/// One row per live agent under the project row: what it does, tokens per hour, model and since when.
fn agent_rows(p: &Value, now_ms: i64) -> Vec<Node> {
    let mut out = vec![Node::Row { id: String::new(), cells: vec![shown_name(p).to_uppercase()], header: true, children: Vec::new() }];
    for (a, k) in grouped(&agents_of(p)) {
        let title = Some(s(a, "title")).filter(|t| !t.trim().is_empty()).map(String::from).unwrap_or_else(|| cap_first(s(a, "kind")));
        let hour = a.get("use").map_or(0.0, |u| n(u, "hourTokens"));
        let model = format!("{}{} · {}", s(a, "model"), if k > 1 { format!(" ×{k}") } else { String::new() }, dur_text((now_ms - n(a, "startedAt") as i64) as f64));
        let mut kids = Vec::new();
        let detail = agent_detail(a, now_ms);
        if !detail.is_empty() {
            kids.push(note(detail));
        }
        if !open_url(a).is_empty() {
            kids.push(item(&format!("session-open:{}", open_url(a)), "Apri la sessione"));
        }
        out.push(Node::Row {
            id: String::new(),
            cells: vec![clip(&title, 40), if hour > 0.0 { format!("{}/h", tok_text(hour)) } else { String::new() }, model],
            header: false,
            children: kids,
        });
    }
    out
}

/// CPU and memory of one agent; `~` when the figure is the sum of agents sharing a project.
fn res_text(a: &Value) -> String {
    let Some(r) = a.get("res") else { return "–".into() };
    let mem = n(r, "memMB");
    let mem = if mem >= 1000.0 { format!("{} GB", comma(mem / 1000.0, 1)) } else { format!("{} MB", mem.round() as i64) };
    format!("{}{} core · {mem}", if r.get("shared").is_some() { "~" } else { "" }, comma(n(r, "cpu"), 1))
}

/// «AGENTI VIVI ADESSO»: type, since when, last activity, CPU and memory, a sub-agent indented under its launcher.
fn agent_table(p: &Value, now_ms: i64) -> Vec<Node> {
    let mut out = vec![Node::Row {
        id: String::new(),
        cells: ["AGENTI VIVI ADESSO", "tipo", "da", "ultima attività", "CPU · memoria"].map(String::from).to_vec(),
        header: true,
        children: Vec::new(),
    }];
    for a in agents_of(p) {
        let depth = a.get("depth").and_then(Value::as_i64).unwrap_or(0).max(0) as usize;
        let model = if depth > 0 { format!("{}↳ {}", "   ".repeat(depth - 1), s(a, "model")) } else { s(a, "model").to_string() };
        let ago = a.get("lastActivity").and_then(Value::as_f64).map_or("–".into(), |t| ago_text(now_ms, t as i64));
        let kids = Some(s(a, "title")).filter(|t| !t.is_empty()).map(|t| vec![note(t)]).unwrap_or_default();
        out.push(Node::Row {
            id: String::new(),
            cells: vec![model, s(a, "kind").into(), dur_text((now_ms - n(a, "startedAt") as i64) as f64), ago, res_text(a)],
            header: false,
            children: kids,
        });
    }
    out
}

/// The week per provider, today's sessions and tokens, the last queued job.
fn week_nodes(p: &Value, heavy: &Value, now_ms: i64) -> Vec<Node> {
    let mut out = vec![
        Node::Row {
            id: String::new(),
            cells: vec!["Questa settimana".into(), format!("Claude {}", pct_short(n(p, "claude"))), format!("Codex {}", pct_short(n(p, "codex"))), format!("Muse {}", pct_short(n(p, "muse")))],
            header: false,
            children: Vec::new(),
        },
        note("% dell'abbonamento usato dai lavori di questo progetto"),
    ];
    let name = s(p, "name");
    if let Some(h) = heavy.get("sessions").and_then(Value::as_array).into_iter().flatten().find(|h| s(h, "project") == name) {
        out.push(note(format!("Oggi · {} sessioni Claude · {} M token", n(h, "sessions") as i64, comma(n(h, "tokens") / 1e6, 1))));
    }
    if let Some(j) = p.get("lastJob").filter(|j| !j.is_null()) {
        let when = j.get("endedAt").and_then(Value::as_i64).map(|t| format!(" · {}", ago_text(now_ms, t))).unwrap_or_default();
        out.push(note(format!("Ultimo lavoro in coda · {}{}", s(j, "task"), when)));
    }
    out
}

/// «Il progetto: consumi, budget, priorità»: what it is, who works, what it costs, its two settings. allow-italian: quoted menu wording
fn project_page(p: &Value, heavy: &Value, now_ms: i64, offset: i64) -> Vec<Node> {
    let name = s(p, "name");
    let detail: Vec<String> = [Some(s(p, "what").to_string()).filter(|w| !w.is_empty()), Some(idle_reason(p, now_ms, offset).unwrap_or_else(|| state_words(p, now_ms)))].into_iter().flatten().collect();
    let mut out = vec![note(format!("{} · {}", shown_name(p), detail.join(" · ")))];
    out.extend(opus_warning(p).map(note));
    out.push(Node::Sep);
    if working(p) {
        out.extend(agent_table(p, now_ms));
    } else {
        let seen = last_seen_at(p).map(|at| format!(" · ultima attività {}", ago_text(now_ms, at))).unwrap_or_default();
        out.push(note(format!("Nessun agente al lavoro adesso{seen}")));
    }
    out.push(Node::Sep);
    for t in p.get("topics").and_then(Value::as_array).into_iter().flatten().take(6) {
        let title = [s(t, "title"), s(t, "name")].into_iter().find(|x| !x.is_empty()).unwrap_or("chat");
        out.push(if s(t, "url").is_empty() { note(format!("Chat Topics · {title}")) } else { item(&format!("session-open:{}", s(t, "url")), format!("Chat Topics · {title}")) });
    }
    out.extend(week_nodes(p, heavy, now_ms));
    out.push(Node::Sep);
    let say = format!("{} · priorità {}", p.get("budgetPct").and_then(Value::as_i64).map_or("nessun budget".to_string(), |b| format!("budget {b}% Claude")), s(p, "priority"));
    out.push(sub(format!("Budget e priorità · {say}"), budget_priority_nodes(p)));
    out.push(Node::Sep);
    out.push(item(&format!("proj-open:{name}"), "Apri in Topics"));
    out
}

fn latest_activity(p: &Value) -> f64 {
    agents_of(p).iter().map(|a| a.get("lastActivity").and_then(Value::as_f64).unwrap_or(0.0)).fold(0.0, f64::max)
}

/// A dead project is listed only while it still carries a budget or a priority of its own.
fn listed(p: &Value) -> bool {
    !p.get("dead").and_then(Value::as_bool).unwrap_or(false) || p.get("budgetPct").map_or(false, |b| !b.is_null()) || matches!(s(p, "priority"), "alta" | "bassa")
}

/// The projects table: a header row, then one row per project, who works first (the latest activity on top),
/// braked and quiet ones after, the dead ones with a setting last.
pub(crate) fn project_table(live: &Option<String>, heavy: &Option<String>, now: i64, offset: i64) -> Vec<Node> {
    let v = parse(live);
    let heavy = parse(heavy);
    let now_ms = now * 1000;
    let Some(ps) = v.get("projects").and_then(Value::as_array) else { return vec![note("Progetti: il servizio non risponde")] };
    let mut rows: Vec<&Value> = ps.iter().filter(|p| listed(p)).collect();
    let dead = |p: &Value| p.get("dead").and_then(Value::as_bool).unwrap_or(false);
    let rank = |p: &Value| if working(p) { 0 } else if dead(p) { 4 } else if s(p, "state") == "frenato" { 1 } else if s(p, "state") == "in coda" { 2 } else { 3 };
    rows.sort_by(|a, b| rank(a).cmp(&rank(b)).then(latest_activity(b).partial_cmp(&latest_activity(a)).unwrap_or(std::cmp::Ordering::Equal)));
    let busy = rows.iter().filter(|p| working(p)).count();
    let agents: usize = rows.iter().map(|p| agent_count(p)).sum();
    let mut out = vec![Node::Row {
        id: String::new(),
        cells: ["PROGETTI", "Claude", "Codex", "Muse", "ritmo/h", "stato"].map(String::from).to_vec(),
        header: true,
        children: Vec::new(),
    }];
    out.push(note(if agents == 0 { "nessun lavoro in corso · consumo in % della settimana".to_string() } else { format!("{agents} lavori in corso in {busy} su {} · consumo in % della settimana", rows.len()) }));
    for p in rows {
        let hour: f64 = agents_of(p).iter().map(|a| a.get("use").map_or(0.0, |u| n(u, "hourTokens"))).sum();
        let pct = |k: &str| if n(p, k) > 0.0 { comma(n(p, k), 1) } else { "–".into() };
        let page = project_page(p, &heavy, now_ms, offset);
        let kids = if working(p) {
            let mut k = agent_rows(p, now_ms);
            k.push(Node::Sep);
            k.push(sub("Il progetto: consumi, budget, priorità", page));
            k
        } else {
            page
        };
        out.push(Node::Row {
            id: String::new(),
            cells: vec![shown_name(p).to_string(), pct("claude"), pct("codex"), pct("muse"), if hour > 0.0 { tokens_short(hour) } else { "–".into() }, state_cell(p, now_ms)],
            header: false,
            children: kids,
        });
    }
    out
}

#[cfg(test)]
#[path = "tray_menu_projects_tests.rs"]
mod tests;
