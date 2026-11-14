//! The submenu of this computer in the table form of the original tray: one row per
//! thing running (CPU, GPU, network and memory in columns), what is left of the
//! list, the trust check, the macOS row and the rankings. Pure: service answers in,
//! `Node`s out. Every word about a process is the service's own. Card ad8b474a.

use crate::tray_menu::{item, mem_text, n, note, parse, s, sub, Node, Snapshot};
use serde_json::Value;
use std::collections::HashMap;

/// Rows listed before the rest goes into its own submenu.
const SHOWN: usize = 15;

fn cpu_text(c: f64) -> String {
    if c >= 100.0 { format!("{:.1} core", c / 100.0).replace('.', ",") } else { format!("{}%", c.round() as i64) }
}

/// `–` = measured and still, `n/d` = not measured in this round.
fn gpu_text(u: &Value) -> String {
    match u.get("gpuPct").and_then(Value::as_f64) {
        None => "n/d".into(),
        Some(g) if g < 0.5 => "–".into(),
        Some(g) if g < 10.0 => format!("{g:.1}%").replace('.', ","),
        Some(g) => format!("{}%", g.round() as i64),
    }
}

fn rate_text(bps: f64) -> String {
    if bps < 1024.0 {
        if bps < 1.0 { "0".into() } else { format!("{} B/s", bps as i64) }
    } else if bps < 1_048_576.0 {
        format!("{} KB/s", (bps / 1024.0).round() as i64)
    } else {
        format!("{:.1} MB/s", bps / 1_048_576.0).replace('.', ",")
    }
}

fn net_of(u: &Value) -> Option<(f64, f64)> {
    Some((u.get("netInBps")?.as_f64()?, u.get("netOutBps")?.as_f64()?))
}

fn net_text(u: &Value) -> String {
    match net_of(u) {
        None => "n/d".into(),
        Some((i, o)) if i + o < 1024.0 => "–".into(),
        Some((i, o)) => rate_text(i + o),
    }
}

fn age_text(sec: f64) -> String {
    if sec < 3600.0 { format!("da {} min", ((sec / 60.0) as i64).max(1)) } else if sec < 86_400.0 { format!("da {} h", (sec / 3600.0) as i64) } else { format!("da {} g", (sec / 86_400.0) as i64) }
}

/// Owner, use and how long: the line under a row's name in the original.
pub fn unit_detail(u: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    let ty = s(u, "type");
    if !["app", "sessione", "macos"].contains(&ty) {
        if let Some(o) = u.get("owner").map(|o| s(o, "label")).filter(|o| !o.is_empty()) {
            parts.push(o.into());
        }
    }
    let use_text = u.get("use").map(|x| s(x, "text")).unwrap_or("");
    if !use_text.is_empty() {
        parts.push(use_text.into());
    }
    if let Some(a) = u.get("ageS").and_then(Value::as_f64) {
        if !use_text.contains(" da ") {
            parts.push(age_text(a));
        }
    }
    parts.join(" · ")
}

fn type_words(t: &str) -> &'static str {
    match t {
        "sessione" => "sessione",
        "lavoro" => "lavoro",
        "devserver" => "server di sviluppo",
        "app" => "app",
        "servizio" => "servizio",
        "mcp" => "MCP",
        "resto" => "resto senza padrone",
        "cloud" => "cloud",
        _ => "senza padrone",
    }
}

fn pids_of(u: &Value) -> Vec<u64> {
    u.get("pids").and_then(Value::as_array).map(|p| p.iter().filter_map(Value::as_u64).collect()).unwrap_or_default()
}

fn cpu_of(u: &Value, cpu: &HashMap<u32, f64>) -> f64 {
    pids_of(u).iter().map(|p| cpu.get(&(*p as u32)).copied().unwrap_or(0.0)).sum()
}

fn closable(u: &Value) -> bool {
    u.get("closable").and_then(Value::as_bool).unwrap_or(false)
}

fn head(label: &str) -> Node {
    Node::Row { id: String::new(), cells: [label, "CPU", "GPU", "rete", "memoria"].map(String::from).to_vec(), header: true, children: Vec::new() }
}

/// What the trust check says about the pids of one unit, as (level, reasons, signer).
fn flags_of<'a>(u: &Value, trust: &'a Value) -> Vec<&'a Value> {
    let pids = pids_of(u);
    trust.get("items").and_then(Value::as_array).into_iter().flatten().filter(|f| f.get("pid").and_then(Value::as_u64).map_or(false, |p| pids.contains(&p))).collect()
}

fn level_word(l: &str) -> &'static str {
    match l {
        "grave" => "Sospetto",
        "attenzione" => "Da guardare",
        _ => "Da sapere",
    }
}

/// One row of the table: name, CPU, GPU, network, memory; the submenu has the
/// «use · owner · since» line, how it comes back, the trust flags and the close gesture.
fn unit_row(u: &Value, cpu: &HashMap<u32, f64>, trust: &Value) -> Node {
    let mut kids: Vec<Node> = Vec::new();
    let detail = unit_detail(u);
    kids.push(note(format!("{} · {}", type_words(s(u, "type")), if detail.is_empty() { "uso non noto".to_string() } else { detail })));
    if let Some(r) = Some(s(u, "returns")).filter(|r| !r.is_empty()) {
        kids.push(note(format!("come torna: {r}")));
    }
    if let Some((i, o)) = net_of(u).filter(|(i, o)| i + o >= 1024.0) {
        kids.push(note(format!("rete ↓ {} ↑ {}", rate_text(i), rate_text(o))));
    }
    let procs = n(u, "n") as i64;
    kids.push(note(if procs == 1 { "1 processo".to_string() } else { format!("{procs} processi") }));
    for f in flags_of(u, trust).into_iter().filter(|f| s(f, "level") != "ok") {
        let reasons: Vec<&str> = f.get("reasons").and_then(Value::as_array).map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        kids.push(note(format!("{}: {}", level_word(s(f, "level")), reasons.join(" · "))));
    }
    if u.get("verb").map_or(false, |v| !v.is_null()) {
        kids.push(Node::Sep);
        let verb = s(u, "verb");
        if closable(u) {
            kids.push(item(&format!("proc-close:{}", s(u, "id")), format!("{verb}…")));
        } else {
            kids.push(note(format!("{verb}: non da qui, {}", s(u, "returns"))));
        }
    }
    let c = cpu_of(u, cpu);
    Node::Row {
        id: String::new(),
        cells: vec![s(u, "name").to_string(), cpu_text(c), gpu_text(u), net_text(u), mem_text(n(u, "memMB"))],
        header: false,
        children: kids,
    }
}

fn sorted_by<'a>(units: &[&'a Value], key: impl Fn(&Value) -> f64) -> Vec<&'a Value> {
    let mut v = units.to_vec();
    v.sort_by(|a, b| key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| s(a, "id").cmp(s(b, "id"))));
    v
}

/// The whole process submenu of this computer. `None` census = the service does not answer.
pub fn procs_table(snap: &Snapshot) -> Vec<Node> {
    let census = parse(&snap.procs);
    let trust = parse(&snap.trust);
    let cpu = &snap.cpu;
    let Some(units) = census.get("units").and_then(Value::as_array) else {
        return vec![note("Non riesco a leggere i processi adesso")];
    };
    let real: Vec<&Value> = units.iter().filter(|u| s(u, "type") != "macos").collect();
    let mem = |u: &Value| n(u, "memMB");
    let ranked = sorted_by(&real, |u| cpu_of(u, cpu) / 100.0 + mem(u) / 2048.0);
    let total: f64 = real.iter().map(|u| mem(u)).sum();
    let mut out = vec![head(&format!("GIRA ADESSO · {} · {}", real.len(), mem_text(total)))];
    out.extend(ranked.iter().take(SHOWN).map(|u| unit_row(u, cpu, &trust)));
    if ranked.len() > SHOWN {
        let rest = &ranked[SHOWN..];
        let mut kids = vec![head("TUTTO IL RESTO")];
        kids.extend(rest.iter().map(|u| unit_row(u, cpu, &trust)));
        out.push(sub(format!("Tutto il resto ({}) · {} in tutto", rest.len(), mem_text(rest.iter().map(|u| mem(u)).sum())), kids));
    }
    let leftovers: Vec<&&Value> = real.iter().filter(|u| s(u, "type") == "resto").collect();
    if !leftovers.is_empty() {
        out.push(item("proc-close-leftovers", format!("Chiudi i resti ({} · {})…", leftovers.len(), mem_text(leftovers.iter().map(|u| mem(u)).sum()))));
    }
    out.push(Node::Sep);
    out.extend(trust_node(&trust, units, cpu));
    if let Some(os) = units.iter().find(|u| s(u, "type") == "macos") {
        out.push(Node::Row {
            id: String::new(),
            cells: vec![format!("{} · {} processi", s(os, "name"), n(os, "n") as i64), cpu_text(cpu_of(os, cpu)), gpu_text(os), net_text(os), mem_text(mem(os))],
            header: false,
            children: Vec::new(),
        });
    }
    out.push(rankings(&real, cpu, &trust));
    out
}

/// «Processi attendibili · N ok», or how many are suspect or worth a look, the flagged ones inside.
fn trust_node(trust: &Value, units: &[Value], cpu: &HashMap<u32, f64>) -> Option<Node> {
    let counts = trust.get("counts")?;
    let (grave, warn, ok) = (n(counts, "grave") as i64, n(counts, "attenzione") as i64, n(counts, "ok") as i64);
    let bad: Vec<&Value> = trust.get("items").and_then(Value::as_array).into_iter().flatten().filter(|f| s(f, "level") != "ok").collect();
    let title = if bad.is_empty() && grave + warn == 0 {
        "Processi attendibili".to_string()
    } else if grave > 0 {
        format!("{grave} sospett{}{}", if grave == 1 { "o" } else { "i" }, if warn > 0 { format!(" · {warn} da guardare") } else { String::new() })
    } else {
        format!("{warn} da guardare")
    };
    let label = format!("{title} · {ok} ok");
    if bad.is_empty() {
        return Some(note(label));
    }
    let kids = bad.iter().map(|f| {
        let pid = f.get("pid").and_then(Value::as_u64).unwrap_or(0);
        match units.iter().find(|u| pids_of(u).contains(&pid)) {
            Some(u) => unit_row(u, cpu, &Value::Null),
            None => {
                let reasons: Vec<&str> = f.get("reasons").and_then(Value::as_array).map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                note(format!("{} · {}", s(f, "name"), reasons.join(" · ")))
            }
        }
    }).collect();
    Some(sub(label, kids))
}

/// The four rankings, each as a block of the same table.
fn rankings(real: &[&Value], cpu: &HashMap<u32, f64>, trust: &Value) -> Node {
    let mut kids = Vec::new();
    let mut block = |title: &str, rows: Vec<&Value>| {
        if !kids.is_empty() {
            kids.push(Node::Sep);
        }
        kids.push(head(title));
        kids.extend(rows.into_iter().map(|u| unit_row(u, cpu, trust)));
    };
    block("PIÙ CPU ADESSO", sorted_by(real, |u| cpu_of(u, cpu)).into_iter().take(7).collect());
    block("PIÙ MEMORIA", sorted_by(real, |u| n(u, "memMB")).into_iter().take(5).collect());
    let gpu: Vec<&Value> = real.iter().copied().filter(|u| n(u, "gpuPct") >= 0.5).collect();
    block("PIÙ GPU ADESSO", sorted_by(&gpu, |u| n(u, "gpuPct")).into_iter().take(5).collect());
    let netsum = |u: &Value| net_of(u).map_or(0.0, |(i, o)| i + o);
    let net: Vec<&Value> = real.iter().copied().filter(|u| netsum(u) >= 1024.0).collect();
    block("PIÙ RETE ADESSO", sorted_by(&net, netsum).into_iter().take(5).collect());
    let total: f64 = cpu.values().sum();
    sub(format!("Classifiche per CPU, GPU, rete e memoria · CPU totale {} · 100% = un core intero", cpu_text(total)), kids)
}

#[cfg(test)]
#[path = "tray_menu_procs_tests.rs"]
mod tests;
