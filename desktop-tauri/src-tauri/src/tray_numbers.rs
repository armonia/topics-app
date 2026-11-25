//! One source for the numbers of a node card. A computer or a server is read by two services, and for the same
//! hour they do not say the same (memory: the kernel's pressure against the gigabytes in use; a server's CPU: two
//! samples taken at two moments). The card takes its figures from the Topics machine list (the Processes view of the
//! app reads it too, so the two cannot tell different stories) and keeps the usage service's judgement, the colour,
//! and what only it measures (GPU, swap, spend). Every figure then says what it is out of: «8,9 di 12 core»,
//! «27,8 di 34,4 GB», «pieno · 77 GB liberi». Pure functions on `MachineCard`. // allow-italian: quoted UI strings

use crate::tray_menu_views::{MachineCard, Metric};
use crate::tray_node_health::span;

/// The first number in a text, comma or point as the decimal sign.
fn first_number(t: &str) -> Option<f64> {
    let start = t.find(|c: char| c.is_ascii_digit())?;
    let num: String = t[start..].chars().take_while(|c| c.is_ascii_digit() || *c == ',' || *c == '.').collect();
    num.trim_end_matches(|c| c == ',' || c == '.').replace(',', ".").parse().ok()
}

/// A figure with the comma of the language: one decimal below a hundred, none from there on.
pub(crate) fn num(v: f64) -> String {
    if v >= 100.0 { format!("{v:.0}") } else { format!("{v:.1}").replace('.', ",") }
}

/// «27,8 GB / 34,4 GB» (or with points) into the two figures; a single «32,9 GB» is only the total.
fn gb_pair(note: &str) -> (Option<f64>, Option<f64>) {
    let mut it = note.split('/').map(first_number);
    match (it.next().flatten(), it.next().flatten()) {
        (Some(used), Some(total)) => (Some(used), Some(total)),
        (Some(total), None) => (None, Some(total)),
        _ => (None, None),
    }
}

fn metric_mut<'a>(c: &'a mut MachineCard, key: &str) -> Option<&'a mut Metric> {
    c.metrics.iter_mut().find(|m| m.key == key)
}

/// Takes the node's numbers from its twin in the Topics machine list and states each one's base.
pub fn one_source(c: &mut MachineCard, twin: Option<&MachineCard>) {
    if let Some(t) = twin {
        c.agents = t.agents.clone().or(c.agents.take());
        for key in ["cpu", "mem", "disk"] {
            let Some(cl) = t.metrics.iter().find(|m| m.key == key) else { continue };
            let existed = c.metrics.iter().any(|m| m.key == key);
            if !existed {
                if cl.pct.is_none() {
                    continue;
                }
                c.metrics.push(Metric { key: key.into(), level: cl.level, ..Default::default() });
            }
            let Some(m) = metric_mut(c, key) else { continue };
            // the memory of a server that does not report its use keeps the usage service's percentage and takes the total
            let (used_gb, total_gb) = if key == "mem" { gb_pair(&cl.note) } else { (None, None) };
            if cl.pct.is_some() {
                m.pct = cl.pct;
            }
            // the colour is a judgement: the usage service's where it made one (the memory is judged by pressure, not by use)
            if existed && key != "mem" {
                m.level = m.level.max(cl.level);
            }
            match key {
                "cpu" => {
                    if let (Some(p), Some(n)) = (m.pct, first_number(&cl.note)) {
                        m.note = format!("{} di {} core", num(f64::from(p) / 100.0 * n), n.round() as i64);
                    }
                }
                "mem" => match (used_gb, total_gb, m.pct) {
                    (Some(u), Some(tot), _) => m.note = format!("{} di {} GB", num(u), num(tot)),
                    (None, Some(tot), Some(p)) => m.note = format!("{} di {} GB", num(f64::from(p) / 100.0 * tot), num(tot)),
                    _ => {}
                },
                _ => {}
            }
        }
    }
    say_what_each_is_of(c);
}

/// What the notes of the hub say, worded for the card: «adesso» goes (the value is the reading now), a disk says it is // allow-italian: quoted UI word
/// full and what is left, and a peak says over how long it was measured.
pub fn say_what_each_is_of(c: &mut MachineCard) {
    for m in &mut c.metrics {
        let n = m.note.trim().trim_start_matches("adesso · ").to_string();
        m.note = if n == "adesso" { String::new() } else { n };
        if m.note.contains("picco 24 h") && m.hist_n > 0 && m.hist_span_s < 23 * 3600 {
            // the history of the service is younger than a day: «24 h» would say what was not measured
            m.note = match (m.hist_n >= 2 && m.hist_span_s >= 120, m.hist_peak) {
                (true, Some(p)) => format!("picco {p}% · ultime {}", span(m.hist_span_s)),
                _ => String::new(),
            };
        }
        if m.key == "disk" && !m.note.starts_with("pieno") {
            m.note = if m.note.is_empty() { "pieno".into() } else { format!("pieno · {}", m.note) };
        }
    }
}

#[cfg(test)]
#[path = "tray_numbers_tests.rs"]
mod tests;
