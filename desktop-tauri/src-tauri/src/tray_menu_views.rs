//! The graphic rows of the tray menu: one card per machine, one panel with a card
//! per quota account, and the backup card. Each is a pure function from service
//! JSON (or the machine list the client ships) to an image, so it is tested without
//! a display. Words come from the services; nothing here composes a sentence about
//! a person or a machine. Card 1aba05b4.

use crate::tray_menu_pic::{tone, Palette, Pic, MENU_W};
use crate::tray_quota::Face;
use serde_json::Value;
// The memory sync card lives in its own file: this one went over the check:bloat line ceiling.
pub use crate::tray_menu_memory_sync::memory_sync_valid;
// The quota panel too, for the same reason; the tests and the menu keep reaching it through this file.
pub(crate) use crate::tray_menu_quota_card::*;

pub(crate) const PAD: f32 = 14.0;

pub(crate) fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
pub(crate) fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}
/// A field that is a string or a number, as text.
pub(crate) fn text_of(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}
pub(crate) fn level_of_tone(t: &str) -> u32 {
    match t {
        "bad" | "critical" => 2,
        "warn" | "warning" => 1,
        _ => 0,
    }
}

// ------------------------------------------------------------------ machines

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Metric {
    pub key: String,
    pub pct: Option<u32>,
    pub level: u32,
    pub note: String,
    /// The reading's label and value in words («Spesa», «8,44/60 €»): drawn only for
    /// a reading the dial has no band for.
    pub name: String,
    pub value: String,
    /// The service's history of the reading: how many points and how long it reaches, and its highest one.
    pub hist_n: usize,
    pub hist_span_s: i64,
    pub hist_peak: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MachineCard {
    /// Identity for the click action; never drawn.
    pub id: String,
    /// This computer: its submenu lists the processes that weigh.
    pub local: bool,
    /// The service's lines about it, shown in the hover submenu.
    pub lines: Vec<String>,
    pub name: String,
    /// The state in words: working, asleep, off...
    pub badge: String,
    pub level: u32,
    /// Why, in one line.
    pub reason: String,
    pub metrics: Vec<Metric>,
    /// Where this machine stands in the order work is sent to machines (1 = first); 0 = not numbered.
    pub order: u32,
    /// The id this machine has in Topics' machine list, when the card is the service's own and its id is another one.
    pub machine_id: String,
    /// The node's agents, from the client's machine of the same node.
    pub agents: Option<crate::tray_node_agents::NodeAgents>,
}

impl MachineCard {
    /// The card's lines with the segments `is_id` flags taken out («srv-1 · 16 core» keeps «16 core»); a line left empty goes.
    pub fn card_lines_without_ids(&self, is_id: impl Fn(&str) -> bool) -> Vec<String> {
        self.lines.iter().filter_map(|l| {
            let rest: Vec<&str> = l.split(" · ").filter(|seg| !is_id(seg)).collect();
            (!rest.is_empty()).then(|| rest.join(" · "))
        }).collect()
    }

    /// The name as the card draws it: numbered when the machines are in dispatch order.
    pub fn display_name(&self) -> String {
        if self.order == 0 { self.name.clone() } else { format!("{} · {}", self.order, self.name) }
    }
}

/// How many points the service's history of a reading has, how many seconds it reaches and its highest value.
pub(crate) fn hist_of(x: &Value) -> (usize, i64, Option<u32>) {
    let pts: Vec<(f64, f64)> = x.get("history").and_then(Value::as_array).map(|h| h.iter().filter_map(|p| Some((p.get("t")?.as_f64()?, p.get("v")?.as_f64()?))).collect()).unwrap_or_default();
    let span = match (pts.first(), pts.last()) {
        (Some(a), Some(b)) => ((b.0 - a.0) / 1000.0) as i64,
        _ => 0,
    };
    (pts.len(), span, pts.iter().map(|p| p.1).fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v)))).map(|v| v.round() as u32))
}

/// Machines of the usage service's board (`/api/board`, `machines`).
pub fn machine_cards_from_board(body: &str) -> Vec<MachineCard> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let rows = v.get("machines").and_then(Value::as_array).cloned().unwrap_or_default();
    rows.iter()
        .filter(|m| !s(m, "name").is_empty())
        .map(|m| MachineCard {
            id: s(m, "id").into(),
            local: s(m, "id") == "local",
            lines: m.get("lines").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default(),
            name: s(m, "name").into(),
            badge: s(m, "state").into(),
            level: num(m, "level").unwrap_or(0.0) as u32,
            reason: m.get("lines").and_then(Value::as_array).and_then(|l| l.first()).and_then(Value::as_str).map(|l| l.split(" · ").next().unwrap_or(l).to_string()).unwrap_or_default(),
            metrics: m.get("metrics").and_then(Value::as_array).map(|a| a.iter().map(|x| Metric {
                key: s(x, "key").into(),
                pct: num(x, "pct").map(|p| p.round().clamp(0.0, 100.0) as u32),
                level: num(x, "level").unwrap_or(0.0) as u32,
                note: s(x, "note").into(),
                name: s(x, "name").into(),
                value: s(x, "value").into(),
                hist_n: hist_of(x).0,
                hist_span_s: hist_of(x).1,
                hist_peak: hist_of(x).2,
            }).collect()).unwrap_or_default(),
            order: 0,
            machine_id: String::new(),
            agents: None,
        })
        .collect()
}

const DIAL_ROWS: [(&str, &str); 4] = [("disk", "Disco"), ("mem", "Memoria"), ("cpu", "CPU"), ("gpu", "GPU")];
const CARD_X: f32 = PAD;
const CARD_W: f32 = MENU_W - 2.0 * PAD;
/// The right margin of a card's legend: the same as the status rows' text under it.
const LEGEND_RIGHT: f32 = 16.0;

/// The line of why next to (or under) the name: the service's reason, nothing else.
/// The readings all live in the dial's legend, the ones it has no band for (a
/// server's spend) as rows of their own under the four of the dial.
pub fn card_line(m: &MachineCard) -> String {
    m.reason.clone()
}

/// The dial's rows the legend draws, in its order: a reading the machine does not have (no value and no note, the
/// GPU of a server) is not a row of dashes. The dial keeps its bands.
pub(crate) fn legend_dial_rows(m: &MachineCard) -> Vec<(&'static str, &'static str)> {
    [("cpu", "CPU"), ("gpu", "GPU"), ("mem", "Memoria"), ("disk", "Disco")].into_iter()
        .filter(|(k, _)| m.metrics.iter().find(|x| x.key == *k).map_or(false, |x| x.pct.is_some() || !x.note.is_empty()))
        .collect()
}

/// The columns every row of a card's legend shares.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LegendCols {
    /// Where the values end (they are right aligned there).
    pub val_right: f32,
    pub bar_x: f32,
    pub bar_end: f32,
    /// The width the notes may take, ending on the right margin.
    pub note_w: f32,
}

/// One set of columns for the whole legend: the value column is as wide as the widest label plus value needs
/// (a «8,44/60 €» widens it for every row, instead of overrunning it on its own), the bars share both ends.
pub(crate) fn legend_cols(lx: f32, right: f32, labels: &[&str], values: &[String], notes: &[&str]) -> LegendCols {
    let label_end = labels.iter().map(|l| lx + 20.0 + Pic::text_w(Face::Sans, l, 10.5)).fold(lx + 20.0, f32::max);
    let value_w = values.iter().map(|v| Pic::text_w(Face::MonoBold, v, 11.5)).fold(0.0, f32::max);
    let val_right = (lx + 100.0).max(label_end + 8.0 + value_w);
    let bar_x = val_right + 12.0;
    let note_w = notes.iter().map(|t| Pic::text_w(Face::SansRegular, t, 10.0)).fold(0.0, f32::max).min((right - bar_x - 40.0 - 12.0).max(0.0));
    let bar_end = if note_w > 0.0 { right - note_w - 12.0 } else { right };
    LegendCols { val_right, bar_x, bar_end, note_w }
}

/// The readings the dial has no band for, as extra legend rows: everything but the
/// dial's own and the swap (which is the note of the memory row).
fn extra_rows(m: &MachineCard) -> Vec<&Metric> {
    m.metrics.iter().filter(|x| x.key != "swap" && !DIAL_ROWS.iter().any(|(k, _)| *k == x.key)).collect()
}

/// What kind of machine a card is, for its logo: this computer, a cloud server or a Windows PC.
fn machine_glyph_of(m: &MachineCard) -> &'static str {
    let key = format!("{} {}", m.id, m.name).to_lowercase();
    if m.local {
        "apple.logo"
    } else if ["hetzner", "cloud", "server", "nodo", "node"].iter().any(|w| key.contains(w)) {
        "cloud"
    } else {
        "windows"
    }
}

/// The size of a machine's logo, in points: the original tray draws the Apple logo at 14, a cloud at 13
/// and the Windows logo at 12 (`machineSym`), each centred in the same slot.
pub(crate) fn machine_glyph_side(glyph: &str) -> f32 {
    match glyph {
        "apple.logo" => 14.0,
        "cloud" => 13.0,
        _ => 12.0,
    }
}

/// The machine's logo in the menu's own ink, as the original tray draws it: the system's Apple logo,
/// the Windows logo as it is, a cloud for a server.
fn draw_machine_glyph(pic: &mut Pic, m: &MachineCard, x: f32, y: f32, p: Palette) {
    let slot = 17.0;
    let glyph = machine_glyph_of(m);
    let side = machine_glyph_side(glyph);
    let (gx, gy) = (x + (slot - side) / 2.0, y + (slot - side) / 2.0);
    match glyph {
        "windows" => pic.windows_logo(gx, gy, side, p.fg, 1.0),
        name => match system_symbol(name) {
            Some(mask) => pic.mask(gx, gy, side, &mask, p.fg, 1.0),
            // no system symbol to draw (not a Mac): a small display
            None => {
                pic.stroke_rrect(x + 1.0, y + 3.0, 15.0, 11.0, 2.5, 1.4, p.fg, 0.9);
                pic.hline(x + 5.0, y + 17.0, 7.0, p.fg, 0.9);
            }
        },
    }
}

/// A free sentence that ends in the figure that matters («…, da 7 minuti»): a parenthesis goes first, then the head allow-italian: quoted menu wording
/// is shortened so that the part after the last comma is never the one cut.
pub(crate) fn fit_keeping_tail(face: Face, text: &str, size: f32, width: f32) -> String {
    if Pic::text_w(face, text, size) <= width {
        return text.to_string();
    }
    let mut t = text.to_string();
    while let (Some(a), Some(b)) = (t.find(" ("), t.find(')')) {
        if b < a {
            break;
        }
        t.replace_range(a..=b, "");
    }
    if Pic::text_w(face, &t, size) <= width {
        return t;
    }
    match t.rfind(", ") {
        Some(i) => {
            let tail = t[i..].to_string();
            let room = (width - Pic::text_w(face, &tail, size)).max(0.0);
            format!("{}{tail}", Pic::fit(face, &t[..i], size, room))
        }
        None => Pic::fit(face, &t, size, width),
    }
}

/// A system symbol as a mask, drawn once per name.
#[cfg(target_os = "macos")]
pub(crate) fn system_symbol(name: &str) -> Option<crate::tray_menu_pic::Mask> {
    static CACHE: std::sync::Mutex<Option<std::collections::HashMap<String, Option<crate::tray_menu_pic::Mask>>>> = std::sync::Mutex::new(None);
    CACHE.lock().ok()?.get_or_insert_with(Default::default).entry(name.to_string()).or_insert_with(|| crate::tray_menu_native::symbol_mask(name)).clone()
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn system_symbol(_name: &str) -> Option<crate::tray_menu_pic::Mask> {
    None
}

/// The brand glyph of a provider (tinted as in the original tray), or the sign of a free provider.
pub(crate) fn provider_mark(provider: &str, p: Palette) -> Option<(crate::tray_menu_pic::Mask, [u8; 3])> {
    static ANTHROPIC: &[u8] = include_bytes!("../assets/tray-providers/anthropic.png");
    static OPENAI: &[u8] = include_bytes!("../assets/tray-providers/openai.png");
    static META: &[u8] = include_bytes!("../assets/tray-providers/meta.png");
    let dark = p.fg[0] > 127;
    let (bytes, ink) = match provider {
        "claude" => (ANTHROPIC, [0xD9, 0x77, 0x57]),
        "codex" => (OPENAI, p.fg),
        "muse" => (META, if dark { [0x4D, 0xA3, 0xFF] } else { [0x00, 0x82, 0xFB] }),
        "free" => return system_symbol("leaf").map(|m| (m, p.fg)),
        _ => return system_symbol("circle").map(|m| (m, p.fg)),
    };
    crate::tray_menu_pic::Mask::from_png(bytes).map(|m| (m, ink))
}

/// A tiny dial with one band lit: the sign of a legend row, as the original tray draws it.
fn mini_dial(pic: &mut Pic, cx: f32, cy: f32, lit: &str, color: [u8; 3], p: Palette) {
    let (disc, band, gap) = (3.0_f32, 1.6_f32, 1.0_f32);
    let r1 = disc + gap + band / 2.0;
    let r2 = r1 + band + gap;
    let on = |k: &str| if k == lit { 1.0 } else { 0.0 };
    pic.wedge(cx, cy, disc, 1.0, p.fg, 0.16);
    pic.ring(cx, cy, r1, band, 0.0, 1.0, p.fg, 0.16);
    pic.ring(cx, cy, r2, band, 0.0, 0.5, p.fg, 0.16);
    pic.ring(cx, cy, r2, band, 1.0, 0.5, p.fg, 0.16);
    if on("disk") > 0.0 {
        pic.wedge(cx, cy, disc, 1.0, color, 1.0);
    }
    if on("mem") > 0.0 {
        pic.ring(cx, cy, r1, band, 0.0, 1.0, color, 1.0);
    }
    if on("cpu") > 0.0 {
        pic.ring(cx, cy, r2, band, 0.0, 0.5, color, 1.0);
    }
    if on("gpu") > 0.0 {
        pic.ring(cx, cy, r2, band, 1.0, 0.5, color, 1.0);
    }
}

/// The same card for every machine (this computer, a PC, a cloud server), laid out as
/// the original tray lays it out: no frame, the machine's logo and name with its state
/// in a pill, the one line of why, then the half-circle dial (disk, memory, CPU and
/// GPU) with its legend of one tiny dial per row. A reading the dial has no band for
/// (the spend of a server) is one more legend row, with its own sign, under the four.
#[cfg(test)]
pub fn draw_machine_card(m: &MachineCard, p: Palette) -> Pic {
    draw_machine_card_with(m, &Default::default(), p)
}

/// The card with what the node files say about it: status rows and small charts under the dial.
pub fn draw_machine_card_with(m: &MachineCard, node: &crate::tray_node_charts::NodeExtras, p: Palette) -> Pic {
    let (disc, band, gap) = (20.0_f32, 10.0_f32, 5.0_f32);
    let r1 = disc + gap + band / 2.0;
    let r2 = r1 + band + gap;
    let edge = r2 + band / 2.0;
    let line = card_line(m);
    let extras = extra_rows(m);
    let lvl = extras.iter().map(|x| x.level).fold(m.level, u32::max);
    // the reason is its own line under the name when it is long (always for this computer); a short one
    // sits after the name of a remote machine
    let badge_w = Pic::text_w(Face::Sans, &m.badge, 10.5) + 14.0;
    let name_w = MENU_W - 38.0 - 16.0 - badge_w - 12.0;
    let name = Pic::fit(Face::Sans, &m.display_name(), 12.5, name_w);
    let inline_x = 38.0 + Pic::text_w(Face::Sans, &name, 12.5) + 8.0;
    let inline_room = (MENU_W - 16.0 - badge_w - 12.0 - inline_x).max(0.0);
    let inline = !m.local && !line.is_empty() && Pic::text_w(Face::SansRegular, &line, 10.0) <= inline_room;
    let brake = !line.is_empty() && !inline;
    let top = if brake { 44.0 } else { 27.0 };
    let dial_rows = legend_dial_rows(m);
    let rows = dial_rows.len() + extras.len();
    let body_h = (edge + 6.0 + 6.0).max(rows as f32 * 18.0 + 2.0);
    let mut pic = Pic::new(MENU_W, top + body_h + 8.0 + node.block_h());
    let head = tone(m.level);
    draw_machine_glyph(&mut pic, m, 13.0, 4.0, p);
    pic.text(Face::Sans, &name, 38.0, 17.0, 12.5, p.fg, 1.0);
    if inline {
        pic.text(Face::SansRegular, &line, inline_x, 16.5, 10.0, p.fg, p.dim * 0.8);
    }
    if !m.badge.is_empty() {
        // a machine that is off or silent wears a grey pill: its tone is in the icon and the reason line
        let off = ["dorme", "spento", "fermo", "offline", "non risponde", "stopped", "asleep", "off", "not answering"].iter().any(|w| m.badge.eq_ignore_ascii_case(w));
        pic.pill_plain(MENU_W - 16.0, 12.5, &m.badge, if off { p.fg } else { head });
    }
    if brake {
        // only this computer's line is about its own trouble; what a remote machine is doing is a description
        let (c, a) = if lvl >= 1 && m.local { (tone(lvl), 1.0) } else { (p.fg, p.dim) };
        // this computer's line is about its brake (a sign), a remote machine's is what it is doing (no sign)
        let tx = if m.local { 53.0 } else { 38.0 };
        if let Some(mask) = system_symbol(if lvl >= 1 { "pause.circle.fill" } else { "clock.fill" }).filter(|_| m.local) {
            pic.mask(38.0, 26.5, 11.0, &mask, c, a);
        }
        let text = fit_keeping_tail(Face::Sans, &line, 10.5, MENU_W - tx - 16.0);
        pic.text(Face::Sans, &text, tx, 36.0, 10.5, c, a);
    }
    let cx = 38.0 + edge + 6.0;
    // the dial sits in the middle of the legend's rows
    let cy = top + edge + ((body_h - edge) / 2.0).max(4.0);
    let find = |k: &str| m.metrics.iter().find(|x| x.key == k);
    let track = 0.11;
    let col = |x: Option<&Metric>| x.and_then(|x| x.pct.map(|_| tone(x.level)));
    let frac = |x: Option<&Metric>| x.and_then(|x| x.pct).map_or(0.0, |v| v as f32 / 100.0);
    pic.wedge(cx, cy, disc, 1.0, p.fg, track);
    if let Some(c) = col(find("disk")) {
        pic.wedge(cx, cy, disc, frac(find("disk")).max(0.02), c, 1.0);
    }
    pic.ring(cx, cy, r1, band, 0.0, 1.0, p.fg, track);
    if let Some(c) = col(find("mem")) {
        pic.ring(cx, cy, r1, band, 0.0, frac(find("mem")).max(0.02), c, 1.0);
    }
    let half = 0.5 - 0.5 * gap / (std::f32::consts::PI * r2);
    for (k, key) in ["cpu", "gpu"].into_iter().enumerate() {
        let (from, dir) = if k == 0 { (0.0, 1.0) } else { (1.0, -1.0) };
        pic.ring(cx, cy, r2, band, from, from + dir * half, p.fg, track);
        if let Some(c) = col(find(key)) {
            pic.ring(cx, cy, r2, band, from, from + dir * half * frac(find(key)).max(0.02), c, 1.0);
        }
    }
    let outer = r2 + band / 2.0;
    // the legend, outside in: CPU, GPU, memory, disk; a tiny dial lit on the band, the label, the value, a
    // bar to the reading and the note, which ends on the right margin like the status rows' text
    let lx = cx + outer + 26.0;
    let swap = find("swap").filter(|x| !x.value.is_empty());
    let notes: Vec<(String, [u8; 3], f32)> = dial_rows.iter().map(|(key, _)| {
        match (*key, swap) {
            // the memory in use out of its total, then the swap behind it: the swap's colour is the note's when it is at risk
            ("mem", Some(s)) => {
                let base = find("mem").map_or(String::new(), |x| x.note.clone());
                let swap_say = format!("swap {}", s.value);
                (if base.is_empty() { swap_say } else { format!("{base} · {swap_say}") }, if s.level > 0 { tone(s.level) } else { p.fg }, if s.level > 0 { 1.0 } else { p.dim })
            }
            _ => (find(key).map_or(String::new(), |x| x.note.clone()), p.fg, p.dim),
        }
    }).chain(extras.iter().map(|x| {
        // «…, tetto 60 €» says again the «/60 €» of the value beside it
        let note = x.note.split(", tetto").next().unwrap_or("").to_string();
        (note, p.fg, p.dim)
    })).collect();
    let right = MENU_W - LEGEND_RIGHT;
    // one set of columns for every row of the legend: the values end on the same x, the bars start and end on the
    // same x, and the notes end on the right margin
    let labels: Vec<&str> = dial_rows.iter().map(|(_, l)| *l).chain(extras.iter().map(|x| if x.name.is_empty() { x.key.as_str() } else { x.name.as_str() })).collect();
    let values: Vec<String> = dial_rows.iter().map(|(k, _)| find(k).and_then(|x| x.pct).map_or("—".to_string(), |v| format!("{v}%")))
        .chain(extras.iter().map(|x| if !x.value.is_empty() { x.value.clone() } else { x.pct.map_or("—".to_string(), |v| format!("{v}%")) })).collect();
    let note_texts: Vec<&str> = notes.iter().map(|n| n.0.as_str()).collect();
    let cols = legend_cols(lx, right, &labels, &values, &note_texts);
    let bar = |pic: &mut Pic, y: f32, pct: Option<u32>, c: [u8; 3]| {
        let w = cols.bar_end - cols.bar_x;
        if let (Some(v), true) = (pct, w >= 40.0) {
            pic.fill_rrect(cols.bar_x, y + 8.0, w, 4.0, 2.0, p.fg, 0.12);
            pic.fill_rrect(cols.bar_x, y + 8.0, (w * v as f32 / 100.0).max(3.0), 4.0, 2.0, c, 1.0);
        }
    };
    let put_note = |pic: &mut Pic, y: f32, text: &str, c: [u8; 3], a: f32| {
        let t = Pic::fit(Face::SansRegular, text, 10.0, cols.note_w);
        pic.text(Face::SansRegular, &t, right - Pic::text_w(Face::SansRegular, &t, 10.0), y + 12.0, 10.0, c, a);
    };
    let put_value = |pic: &mut Pic, y: f32, value: &str, c: [u8; 3], a: f32| {
        pic.text(Face::MonoBold, value, cols.val_right - Pic::text_w(Face::MonoBold, value, 11.5), y + 12.0, 11.5, c, a);
    };
    for (i, (key, label)) in dial_rows.iter().enumerate() {
        let y = top + i as f32 * 18.0;
        let x = find(key);
        let c = col(x).unwrap_or(p.fg);
        mini_dial(&mut pic, lx + 7.0, y + 12.0, key, c, p);
        pic.text(Face::Sans, label, lx + 20.0, y + 12.5, 10.5, p.fg, p.dim);
        let has = x.and_then(|x| x.pct).is_some();
        put_value(&mut pic, y, &values[i], c, if has { 1.0 } else { 0.4 });
        // a reading with a history draws it where its bar would be: the line says the same «now» (its last point,
        // in the tone of the value) and the day behind it; a reading without one keeps the bar
        let history = match *key { "cpu" => Some(&node.cpu), "mem" => Some(&node.mem), _ => None };
        let w = cols.bar_end - cols.bar_x;
        let lined = history.map_or(false, |h| w >= 40.0 && crate::tray_node_charts::spark_for(&mut pic, (cols.bar_x, y + 3.0, w, 12.0), h, node, p));
        if !lined {
            bar(&mut pic, y, x.and_then(|x| x.pct), c);
        }
        let (note, ncol, na) = &notes[i];
        put_note(&mut pic, y, note, *ncol, *na);
    }
    // the readings with no band: one row each, the sign of the reading in place of the tiny dial
    for (i, x) in extras.iter().enumerate() {
        let y = top + (dial_rows.len() + i) as f32 * 18.0;
        let c = if x.level > 0 { tone(x.level) } else { p.fg };
        let symbol = if x.key == "spend" { "eurosign.circle" } else { "circle" };
        if let Some(mask) = system_symbol(symbol) {
            pic.mask(lx + 1.5, y + 6.5, 11.0, &mask, c, 1.0);
        } else {
            pic.stroke_rrect(lx + 2.0, y + 6.0, 10.0, 10.0, 5.0, 1.3, c, 1.0);
        }
        pic.text(Face::Sans, labels[dial_rows.len() + i], lx + 20.0, y + 12.5, 10.5, p.fg, p.dim);
        put_value(&mut pic, y, &values[dial_rows.len() + i], c, 1.0);
        bar(&mut pic, y, x.pct, c);
        let (note, ncol, na) = &notes[dial_rows.len() + i];
        put_note(&mut pic, y, note, *ncol, *na);
    }
    crate::tray_node_charts::draw_block(&mut pic, node, top + body_h - 4.0, p);
    pic
}

// ------------------------------------------------------------------ backup

#[derive(Debug, Clone, PartialEq, Default)]
pub struct BackupCard {
    /// The card's heading: the backup and the memory sync share the drawing.
    pub title: String,
    pub badge: String,
    pub level: u32,
    pub caption: String,
    /// 30 days, oldest first: Some(true) copy made, Some(false) failed, None nothing to judge yet.
    pub days: Vec<Option<bool>>,
    /// The day number (days since 1970-01-01) of the last entry of `days`, so a day can say its date.
    pub today: i64,
    pub days_say: String,
    pub proofs: Vec<(String, String, bool)>,
    /// The footer line: what the backup costs this computer right now.
    pub foot: String,
}

/// Seconds this computer's clock is ahead of UTC, read once from the system.
pub fn local_offset() -> i64 {
    static OFFSET: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *OFFSET.get_or_init(|| {
        let out = std::process::Command::new("date").arg("+%z").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let (sign, digits) = out.split_at(out.len().min(1));
        match (digits.len() == 4, digits.parse::<i64>()) {
            (true, Ok(d)) => (if sign == "-" { -1 } else { 1 }) * ((d / 100) * 3600 + (d % 100) * 60),
            _ => 0,
        }
    })
}

/// `HH:MM` on this computer's clock.
pub fn clock_text(t: i64) -> String {
    let l = t + local_offset();
    format!("{:02}:{:02}", l.rem_euclid(86_400) / 3600, l.rem_euclid(3600) / 60)
}

pub(crate) fn when(now: i64, at: i64) -> String {
    let d = (now - at).max(0) / 86_400;
    let clock = clock_text;
    match d {
        0 => format!("oggi {}", clock(at)),
        1 => format!("ieri {}", clock(at)),
        n => format!("{n} giorni fa"),
    }
}

/// The backup card from the service's backup state (or its cached copy).
pub fn backup_card(body: &str, now: i64) -> Option<BackupCard> {
    let v: Value = serde_json::from_str(body).ok().filter(Value::is_object)?;
    let last_ok = v.get("last_ok").and_then(Value::as_i64);
    let err = Some(s(&v, "last_error")).filter(|e| !e.is_empty());
    let stale = last_ok.map_or(true, |t| now - t > 30 * 3600);
    let running = v.get("pending_since").map_or(false, |p| !p.is_null());
    let private_at = v.get("private_at").and_then(Value::as_i64);
    // the private archive counts only when the service reports it: an older service has no such field
    let private_stale = v.get("private_at").is_some() && private_at.map_or(true, |t| now - t > 36 * 3600);
    let (badge, level, caption) = if err.is_some() {
        ("problema", 2, "Ultimo giro fallito".to_string())
    } else if stale {
        ("problema", 2, "Nessuna copia nelle ultime 30 ore".to_string())
    } else if private_stale {
        ("problema", 2, format!("Archivio privato fermo, ultimo salvataggio: {}", private_at.map_or("mai".into(), |t| when(now, t))))
    } else if running {
        ("in corso", 0, "Copia in corso".to_string())
    } else {
        ("a posto", 0, format!("Ultima copia {} · prossima alle 5:00", when(now, last_ok.unwrap_or(now))))
    };
    let mut by_day: std::collections::BTreeMap<i64, bool> = Default::default();
    for r in v.get("runs").and_then(Value::as_array).into_iter().flatten() {
        if let (Some(at), Some(ok)) = (r.get("at").and_then(Value::as_i64), r.get("ok").and_then(Value::as_bool)) {
            by_day.insert(at / 86_400, ok);
        }
    }
    let today = now / 86_400;
    let first = by_day.keys().next().copied();
    let days: Vec<Option<bool>> = (0..30).rev().map(|back| {
        let d = today - back;
        match by_day.get(&d) {
            Some(ok) => Some(*ok),
            None if back == 0 => None,
            None if first.map_or(false, |f| d > f) => Some(false),
            None => None,
        }
    }).collect();
    let judged = days.iter().flatten().count();
    let good = days.iter().flatten().filter(|ok| **ok).count();
    let days_say = if judged == 0 { String::new() } else { format!("{good} giorni su {judged} riusciti") };
    let fresh = |t: Option<i64>, d: i64| t.map_or(false, |t| now - t <= d * 86_400);
    let mut proofs = Vec::new();
    if let Some(ic) = v.get("icloud") {
        let (files, up) = (ic.get("files").and_then(Value::as_i64), ic.get("uploaded").and_then(Value::as_i64));
        if let (Some(f), Some(u)) = (files, up) {
            let gb = format!("{:.1}", ic.get("bytes").and_then(Value::as_f64).unwrap_or(0.0) / 1_073_741_824.0).replace('.', ",");
            proofs.push(("Su iCloud".to_string(), if u >= f { format!("{gb} GB caricati") } else { format!("{u} di {f} file") }, u >= f));
        }
    }
    let read = v.get("last_read_check").and_then(Value::as_i64);
    proofs.push(("Dati riletti".into(), read.map_or("mai".into(), |t| when(now, t)), fresh(read, 8)));
    let restore = v.get("last_restore_ok").and_then(Value::as_i64);
    proofs.push(("Ripristino provato".into(), restore.map_or("mai".into(), |t| when(now, t)), fresh(restore, 8)));
    if v.get("private_at").is_some() {
        proofs.push(("Archivio privato".into(), private_at.map_or("mai".into(), |t| when(now, t)), !private_stale));
    }
    proofs.push(("Ultima copia".into(), last_ok.map_or("mai".into(), |t| when(now, t)), !stale));
    let mut foot_parts: Vec<String> = Vec::new();
    if running {
        foot_parts.push(s(&v, "run_phase").to_string());
    } else {
        foot_parts.push("Adesso niente".into());
        if let Some(sec) = v.get("last_seconds").and_then(Value::as_f64) {
            let mins = ((sec / 60.0).round() as i64).max(1);
            foot_parts.push(if mins >= 120 { format!("ultimo giro {} h {} min", mins / 60, mins % 60) } else { format!("ultimo giro {mins} min") });
        }
    }
    if let Some(local) = v.get("icloud").and_then(|i| i.get("local_bytes")).and_then(Value::as_f64) {
        foot_parts.push(format!("{} GB sul disco", format!("{:.1}", local / 1_073_741_824.0).replace('.', ",")));
    }
    foot_parts.retain(|p| !p.is_empty());
    let foot = if foot_parts.is_empty() { String::new() } else { format!("Sul Mac: {}", foot_parts.join(" · ")) };
    Some(BackupCard { title: "Backup del Mac".into(), badge: badge.into(), level, caption, days, today, days_say, proofs, foot })
}

pub fn draw_backup_card(b: &BackupCard, p: Palette) -> Pic {
    let rows = ((b.proofs.len() + 1) / 2) as f32;
    // an odd proof leaves the right half of the last row empty: the footer line takes it, and its own row goes
    // the last proof alone on its row: its right is free, and the footer goes there when it fits after the proof
    let last_end = b.proofs.last().map_or(0.0, |(l, v, _)| 12.0 + Pic::text_w(Face::SansRegular, l, 10.5) + 6.0 + Pic::text_w(Face::SansRegular, v, 10.5));
    let foot_beside = b.proofs.len() % 2 == 1 && !b.foot.is_empty() && last_end + 24.0 + Pic::text_w(Face::SansRegular, &b.foot, 10.5) <= CARD_W - 28.0;
    let foot_h = if b.foot.is_empty() || foot_beside { 0.0 } else { 18.0 };
    let h = 118.0 + rows * 17.0 + foot_h;
    let mut pic = Pic::new(MENU_W, h + 6.0);
    pic.frame(CARD_X, 3.0, CARD_W, h, p);
    let m = CARD_X + 14.0;
    let c = tone(b.level);
    pic.dot(m + 7.0, 21.0, 6.0, c, 0.2);
    pic.dot(m + 7.0, 21.0, 2.5, c, 1.0);
    pic.text(Face::Sans, &b.title, m + 24.0, 26.0, 13.0, p.fg, 1.0);
    pic.pill(CARD_X + CARD_W - 14.0, 21.0, &b.badge, c);
    pic.text(Face::SansRegular, &Pic::fit(Face::SansRegular, &b.caption, 10.5, CARD_W - 52.0), m + 24.0, 43.0, 10.5, if b.level == 2 { c } else { p.fg }, if b.level == 2 { 1.0 } else { p.dim });
    let inner = CARD_W - 28.0;
    let step = inner / b.days.len().max(1) as f32;
    pic.hover.push(crate::tray_hover::HoverZone { x: m, y: 55.0, w: inner, h: 18.0, points: b.days.iter().enumerate().map(|(i, d)| crate::tray_hover::HoverPoint {
        x: m + i as f32 * step + step / 2.0,
        label: format!("{} · {}", crate::tray_hover::day_label(b.today - (b.days.len() - 1 - i) as i64), match d { Some(true) => "copia fatta", Some(false) => "copia non riuscita", None => "niente da giudicare" }),
    }).collect(), reach: None });
    for (i, d) in b.days.iter().enumerate() {
        let (col, a) = match d {
            Some(true) => (tone(0), 1.0),
            Some(false) => (tone(2), 1.0),
            None => (p.fg, 0.12),
        };
        pic.fill_rrect(m + i as f32 * step + (step - 4.0) / 2.0, 55.0, 4.0, 18.0, 1.5, col, a);
    }
    pic.text(Face::SansRegular, "Ultimi 30 giorni", m, 90.0, 10.5, p.fg, p.dim);
    let sw = Pic::text_w(Face::SansRegular, &b.days_say, 10.5);
    pic.text(Face::SansRegular, &b.days_say, CARD_X + CARD_W - 14.0 - sw, 90.0, 10.5, p.fg, 1.0);
    pic.hline(m, 99.0, inner, p.fg, 0.14);
    let col = inner / 2.0;
    for (i, (label, value, ok)) in b.proofs.iter().enumerate() {
        let (x, y) = (m + (i % 2) as f32 * col, 108.0 + (i / 2) as f32 * 17.0);
        pic.dot(x + 3.0, y + 4.0, 3.0, tone(if *ok { 0 } else { 1 }), 1.0);
        let lw = pic.text(Face::SansRegular, label, x + 12.0, y + 8.0, 10.5, p.fg, p.dim);
        let v = Pic::fit(Face::SansRegular, value, 10.5, (col - 20.0 - lw - 8.0).max(30.0));
        pic.text(Face::SansRegular, &v, x + 12.0 + lw + 6.0, y + 8.0, 10.5, if *ok { p.fg } else { tone(1) }, 1.0);
    }
    if foot_beside {
        let y = 108.0 + (rows - 1.0) * 17.0;
        pic.text(Face::SansRegular, &b.foot, m + inner - Pic::text_w(Face::SansRegular, &b.foot, 10.5), y + 8.0, 10.5, p.fg, p.dim);
    } else if !b.foot.is_empty() {
        let fy = 108.0 + rows * 17.0 + 8.0;
        pic.hline(m, fy - 8.0, inner, p.fg, 0.14);
        pic.text(Face::SansRegular, &Pic::fit(Face::SansRegular, &b.foot, 10.5, inner), m, fy + 6.0, 10.5, p.fg, p.dim);
    }
    pic
}

#[cfg(test)]
#[path = "tray_menu_views_tests.rs"]
mod tests;
