//! The graphic rows of the tray menu: one card per machine, one panel with a card
//! per quota account, and the backup card. Each is a pure function from service
//! JSON (or the machine list the client ships) to an image, so it is tested without
//! a display. Words come from the services; nothing here composes a sentence about
//! a person or a machine. Card 1aba05b4.

use crate::tray_menu_pic::{tone, Palette, Pic, MENU_W};
use crate::tray_quota::Face;
use serde_json::Value;

const PAD: f32 = 14.0;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}
/// A field that is a string or a number, as text.
fn text_of(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}
fn level_of_tone(t: &str) -> u32 {
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
            }).collect()).unwrap_or_default(),
        })
        .collect()
}

const DIAL_ROWS: [(&str, &str); 4] = [("disk", "Disco"), ("mem", "Memoria"), ("cpu", "CPU"), ("gpu", "GPU")];
const CARD_X: f32 = PAD;
const CARD_W: f32 = MENU_W - 2.0 * PAD;

/// The same card for every machine: icon, name, state badge, the half-circle
/// dial (disk, memory, CPU and GPU) with its legend, and the reason line. A
/// machine with no readings gets the same card with the bands switched off.
pub fn draw_machine_card(m: &MachineCard, p: Palette) -> Pic {
    let (disc, band, gap) = (19.0_f32, 7.0_f32, 2.5_f32);
    let r1 = disc + gap + band / 2.0;
    let r2 = r1 + band + gap;
    let edge = r2 + band / 2.0;
    let cx = CARD_X + 16.0 + edge;
    let cy = 46.0 + edge;
    // the four legend rows reach lower than the dial: the card ends under whichever is lower,
    // and the reason line goes below both (it used to sit on the GPU row)
    let legend_bottom = cy - edge + 12.0 + (DIAL_ROWS.len() as f32 - 1.0) * 17.0 + 4.0;
    let body = (cy + 12.0).max(legend_bottom);
    let reason_y = body + 18.0;
    let h = body + if m.reason.is_empty() { 10.0 } else { 26.0 };
    let mut pic = Pic::new(MENU_W, h + 6.0);
    pic.frame(CARD_X, 3.0, CARD_W, h, p);
    let head = tone(m.level);
    // icon: a small display, in the tone of the state
    pic.stroke_rrect(CARD_X + 14.0, 15.0, 15.0, 11.0, 2.5, 1.4, head, 0.9);
    pic.hline(CARD_X + 18.0, 29.0, 7.0, head, 0.9);
    let badge_w = Pic::text_w(Face::Sans, &m.badge, 10.5) + 22.0;
    let name = Pic::fit(Face::Sans, &m.name, 13.0, CARD_W - 40.0 - badge_w - 40.0);
    pic.text(Face::Sans, &name, CARD_X + 38.0, 26.0, 13.0, p.fg, 1.0);
    if !m.badge.is_empty() {
        let off = ["dorme", "spento", "fermo", "offline", "non risponde", "stopped"].iter().any(|w| m.badge.eq_ignore_ascii_case(w));
        pic.pill(CARD_X + CARD_W - 14.0, 21.0, &m.badge, if off { p.fg } else { head });
    }
    let find = |k: &str| m.metrics.iter().find(|x| x.key == k);
    let track = 0.16;
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
    let g = gap / 2.0 / (std::f32::consts::PI * r2);
    let half = 0.5 - g;
    for (k, key) in ["cpu", "gpu"].into_iter().enumerate() {
        let (from, dir) = if k == 0 { (0.0, 1.0) } else { (1.0, -1.0) };
        pic.ring(cx, cy, r2, band, from, from + dir * half, p.fg, track);
        if let Some(c) = col(find(key)) {
            pic.ring(cx, cy, r2, band, from, from + dir * half * frac(find(key)).max(0.02), c, 1.0);
        }
    }
    for (label, dx) in [("D", 0.0), ("M", -(r1 - band / 2.0)), ("C", -edge + 2.0), ("G", edge - 2.0)] {
        let tw = Pic::text_w(Face::Sans, label, 7.0);
        pic.text(Face::Sans, label, cx + dx - tw / 2.0, cy + 10.0, 7.0, p.fg, p.dim);
    }
    // the legend: one row per band, a dot in the band's tone, the value, the service's note
    let lx = cx + edge + 34.0;
    for (i, (key, label)) in DIAL_ROWS.iter().enumerate() {
        let y = cy - edge + 12.0 + i as f32 * 17.0;
        let x = find(key);
        let c = col(x).unwrap_or(p.fg);
        pic.dot(lx, y - 3.5, 3.0, c, if x.and_then(|x| x.pct).is_some() { 1.0 } else { 0.3 });
        pic.text(Face::SansRegular, label, lx + 10.0, y, 11.0, p.fg, p.dim);
        let value = x.and_then(|x| x.pct).map_or("—".to_string(), |v| format!("{v}%"));
        pic.text(Face::MonoBold, &value, lx + 74.0, y, 12.0, p.fg, if x.and_then(|x| x.pct).is_some() { 1.0 } else { 0.4 });
        let note = Pic::fit(Face::SansRegular, x.map_or("", |x| x.note.as_str()), 10.5, CARD_X + CARD_W - 14.0 - (lx + 118.0));
        pic.text(Face::SansRegular, &note, lx + 118.0, y, 10.5, p.fg, p.dim * 0.9);
    }
    if !m.reason.is_empty() {
        let line = Pic::fit(Face::SansRegular, &m.reason, 11.0, CARD_W - 32.0);
        let (c, a) = if m.level >= 1 { (head, 1.0) } else { (p.fg, p.dim) };
        pic.text(Face::SansRegular, &line, CARD_X + 16.0, reason_y, 11.0, c, a);
    }
    pic
}

// ------------------------------------------------------------------ quota panel

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Meter {
    pub label: String,
    pub used: f32,
    pub reset: String,
    pub mark: Option<f32>,
    pub level: u32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Minor {
    pub label: String,
    pub value: String,
    pub right: String,
    pub level: u32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct QuotaCard {
    pub provider: String,
    pub who: String,
    pub used: f32,
    pub state: String,
    pub state_level: u32,
    /// Needle of the pace dial (0..2), when the pace is measured.
    pub needle: Option<f32>,
    pub five_hour: Option<Meter>,
    pub week: Option<Meter>,
    pub minors: Vec<Minor>,
}

fn meter_of(w: &Value, label: &str) -> Meter {
    Meter {
        label: label.into(),
        used: num(w, "used").unwrap_or(0.0) as f32,
        reset: s(w, "reset").into(),
        mark: num(w, "mark").map(|m| m as f32),
        level: level_of_tone(s(w, "tone")),
    }
}

fn minor_of(label: &str, v: &Value) -> Option<Minor> {
    if v.is_null() {
        return None;
    }
    Some(Minor { label: label.into(), value: text_of(v, "value"), right: text_of(v, "right"), level: level_of_tone(s(v, "tone")) })
}

/// One card per account of `/api/board`: usable first, spent ones last.
pub fn quota_cards(body: &str) -> Vec<QuotaCard> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut out: Vec<QuotaCard> = v.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default().iter().filter(|a| !s(a, "email").is_empty() || !s(a, "name").is_empty()).map(|a| {
        let wins = a.get("windows").and_then(Value::as_array).cloned().unwrap_or_default();
        let win = |k: &str| wins.iter().find(|w| s(w, "key") == k);
        let st = a.get("state").cloned().unwrap_or(Value::Null);
        let mut minors: Vec<Minor> = Vec::new();
        minors.extend(a.get("plan").and_then(|x| minor_of(s(x, "label").trim().is_empty().then_some("Piano").unwrap_or(s(x, "label")), x)));
        if let Some(e) = a.get("end").filter(|e| !e.is_null()) {
            minors.push(Minor { label: "Fine".into(), value: s(e, "text").into(), right: String::new(), level: level_of_tone(s(e, "tone")) });
        }
        if let Some(t) = a.get("tokens").filter(|t| !t.is_null()) {
            minors.push(Minor { label: "Token".into(), value: text_of(t, "left"), right: text_of(t, "perDay"), level: 0 });
        }
        for w in wins.iter().filter(|w| s(w, "key") != "5h" && s(w, "key") != "week") {
            let reset = s(w, "reset");
            minors.push(Minor {
                label: s(w, "label").into(),
                value: format!("{}%", num(w, "used").unwrap_or(0.0).round() as i64),
                right: if reset.is_empty() { s(w, "note").into() } else { reset.into() },
                level: level_of_tone(s(w, "tone")),
            });
        }
        if let Some(b) = a.get("bonus").filter(|b| !b.is_null()) {
            minors.push(Minor { label: "Bonus".into(), value: format!("${}", num(b, "left").unwrap_or(0.0).round() as i64), right: s(b, "renews").into(), level: 0 });
        }
        minors.extend(a.get("api").and_then(|x| minor_of(s(x, "label"), x)));
        let dial = st.get("dial").and_then(Value::as_bool).unwrap_or(false);
        QuotaCard {
            provider: s(a, "provider").into(),
            who: Some(s(a, "email")).filter(|e| !e.is_empty()).unwrap_or(s(a, "name")).into(),
            used: num(a, "used").unwrap_or(0.0) as f32,
            state: s(&st, "text").into(),
            state_level: level_of_tone(s(&st, "tone")),
            needle: if dial { a.get("gauge").and_then(|g| num(g, "needle")).map(|n| n as f32) } else { None },
            five_hour: win("5h").map(|w| meter_of(w, "5 h")),
            week: win("week").map(|w| meter_of(w, "7 g")),
            minors,
        }
    }).collect();
    out.sort_by_key(|c| c.used >= 100.0);
    out
}

const Q_COLS: usize = 3;
const Q_GAP: f32 = 8.0;
const Q_INSET: f32 = 9.0;
const METER_H: f32 = 27.0;
const MINOR_H: f32 = 16.0;

fn quota_card_h(c: &QuotaCard) -> f32 {
    let n = c.minors.len() as f32;
    Q_INSET + 16.0 + 4.0 + 20.0 + 6.0 + 2.0 * METER_H + 5.0 + if n > 0.0 { 8.0 + n * MINOR_H } else { 0.0 } + Q_INSET - 2.0
}

fn draw_meter(pic: &mut Pic, m: &Option<Meter>, label: &str, x: f32, y: f32, w: f32, p: Palette) {
    let a = if m.is_some() { 1.0 } else { 0.45 };
    let used = m.as_ref().map_or(0.0, |m| m.used);
    let l1 = y + 11.0;
    pic.text(Face::SansRegular, label, x, l1, 11.0, p.fg, p.dim * a);
    let pct = m.as_ref().map_or("—".to_string(), |m| format!("{}%", m.used.round() as i64));
    let pw = pic.text(Face::MonoBold, &pct, x + 28.0, l1 + 1.0, 14.0, p.fg, a);
    if let Some(m) = m.as_ref().filter(|m| !m.reset.is_empty()) {
        let room = w - 28.0 - pw - 8.0;
        let r = Pic::fit(Face::Mono, &m.reset, 10.5, room.max(0.0));
        let rw = Pic::text_w(Face::Mono, &r, 10.5);
        pic.text(Face::Mono, &r, x + w - rw, l1, 10.5, p.fg, p.dim);
    }
    let c = m.as_ref().map_or(p.fg, |m| tone(m.level));
    pic.bar(x, y + 22.0, w, used, m.as_ref().and_then(|m| m.mark), c, p);
}

fn draw_quota_card(pic: &mut Pic, c: &QuotaCard, x: f32, y: f32, w: f32, h: f32, p: Palette) {
    pic.frame(x, y, w, h, p);
    let (ix, iw) = (x + Q_INSET, w - 2.0 * Q_INSET);
    // provider mark: its initial in a capsule, then the account
    let ty = y + Q_INSET + 11.0;
    pic.fill_rrect(ix, ty - 10.0, 13.0, 13.0, 4.0, p.fg, 0.14);
    let init: String = c.provider.chars().next().map(|ch| ch.to_uppercase().to_string()).unwrap_or_default();
    pic.text(Face::Sans, &init, ix + 6.5 - Pic::text_w(Face::Sans, &init, 9.0) / 2.0, ty - 0.5, 9.0, p.fg, 1.0);
    let who = Pic::fit(Face::Sans, &c.who, 11.5, iw - 18.0);
    pic.text(Face::Sans, &who, ix + 18.0, ty, 11.5, p.fg, 1.0);
    let sy = y + Q_INSET + 16.0 + 4.0;
    let st = tone(c.state_level);
    let tx;
    if let Some(n) = c.needle {
        let (gcx, gcy, r) = (ix + 13.0, sy + 17.0, 12.5);
        pic.ring(gcx, gcy, r - 1.5, 2.5, 0.0, 0.5, tone(0), 0.55);
        pic.ring(gcx, gcy, r - 1.5, 2.5, 0.5, 1.0, tone(2), 0.55);
        let a = std::f32::consts::PI * (1.0 - (n / 2.0).clamp(0.0, 1.0));
        pic.seg((gcx, gcy), (gcx + (r - 2.5) * a.cos(), gcy - (r - 2.5) * a.sin()), 1.8, st, 1.0);
        pic.dot(gcx, gcy, 2.0, st, 1.0);
        tx = ix + 33.0;
    } else {
        pic.dot(ix + 6.0, sy + 11.0, 3.5, st, 1.0);
        tx = ix + 19.0;
    }
    let state = Pic::fit(Face::Sans, &c.state, 11.5, ix + iw - tx);
    pic.text(Face::Sans, &state, tx, sy + 15.0, 11.5, st, 1.0);
    let my = sy + 20.0 + 6.0;
    draw_meter(pic, &c.five_hour, "5 h", ix, my, iw, p);
    draw_meter(pic, &c.week, "7 g", ix, my + METER_H + 5.0, iw, p);
    if c.minors.is_empty() {
        return;
    }
    let mut yy = my + 2.0 * METER_H + 5.0 + 8.0;
    pic.hline(ix, yy - 4.0, iw, p.fg, 0.14);
    for m in &c.minors {
        let base = yy + 11.0;
        pic.text(Face::SansRegular, &m.label, ix, base, 11.0, p.fg, p.dim);
        let vx = ix + 40.0;
        let vw = pic.text(Face::Sans, &Pic::fit(Face::Sans, &m.value, 11.0, iw - 40.0), vx, base, 11.0, if m.level > 0 { tone(m.level) } else { p.fg }, 1.0);
        let room = ix + iw - (vx + vw + 8.0);
        if !m.right.is_empty() && room > 16.0 {
            let r = Pic::fit(Face::Mono, &m.right, 10.0, room);
            let rw = Pic::text_w(Face::Mono, &r, 10.0);
            pic.text(Face::Mono, &r, ix + iw - rw, base, 10.0, p.fg, p.dim);
        }
        yy += MINOR_H;
    }
}

/// Three cards per row, one per account. None when there is no account to show.
pub fn draw_quota_panel(cards: &[QuotaCard], p: Palette) -> Option<Pic> {
    if cards.is_empty() {
        return None;
    }
    let cw = (MENU_W - 2.0 * PAD - Q_GAP * (Q_COLS as f32 - 1.0)) / Q_COLS as f32;
    let rows: Vec<&[QuotaCard]> = cards.chunks(Q_COLS).collect();
    let heights: Vec<f32> = rows.iter().map(|r| r.iter().map(quota_card_h).fold(0.0, f32::max)).collect();
    let total: f32 = 4.0 + heights.iter().map(|h| h + Q_GAP).sum::<f32>();
    let mut pic = Pic::new(MENU_W, total);
    let mut y = 4.0;
    for (r, row) in rows.iter().enumerate() {
        for (i, c) in row.iter().enumerate() {
            draw_quota_card(&mut pic, c, PAD + i as f32 * (cw + Q_GAP), y, cw, heights[r], p);
        }
        y += heights[r] + Q_GAP;
    }
    Some(pic)
}

// ------------------------------------------------------------------ backup

#[derive(Debug, Clone, PartialEq, Default)]
pub struct BackupCard {
    pub badge: String,
    pub level: u32,
    pub caption: String,
    /// 30 days, oldest first: Some(true) copy made, Some(false) failed, None nothing to judge yet.
    pub days: Vec<Option<bool>>,
    pub days_say: String,
    pub proofs: Vec<(String, String, bool)>,
}

fn when(now: i64, at: i64) -> String {
    let d = (now - at).max(0) / 86_400;
    let clock = |t: i64| format!("{:02}:{:02}", (t % 86_400) / 3600, (t % 3600) / 60);
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
    let (badge, level, caption) = if err.is_some() {
        ("problema", 2, "Ultimo giro fallito".to_string())
    } else if stale {
        ("problema", 2, "Nessuna copia nelle ultime 30 ore".to_string())
    } else if running {
        ("in corso", 0, "Copia in corso".to_string())
    } else {
        ("a posto", 0, format!("Ultima copia {}", when(now, last_ok.unwrap_or(now))))
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
    proofs.push(("Ultima copia".into(), last_ok.map_or("mai".into(), |t| when(now, t)), !stale));
    Some(BackupCard { badge: badge.into(), level, caption, days, days_say, proofs })
}

pub fn draw_backup_card(b: &BackupCard, p: Palette) -> Pic {
    let rows = ((b.proofs.len() + 1) / 2) as f32;
    let h = 118.0 + rows * 17.0;
    let mut pic = Pic::new(MENU_W, h + 6.0);
    pic.frame(CARD_X, 3.0, CARD_W, h, p);
    let m = CARD_X + 14.0;
    let c = tone(b.level);
    pic.dot(m + 7.0, 21.0, 6.0, c, 0.2);
    pic.dot(m + 7.0, 21.0, 2.5, c, 1.0);
    pic.text(Face::Sans, "Backup del Mac", m + 24.0, 26.0, 13.0, p.fg, 1.0);
    pic.pill(CARD_X + CARD_W - 14.0, 21.0, &b.badge, c);
    pic.text(Face::SansRegular, &Pic::fit(Face::SansRegular, &b.caption, 10.5, CARD_W - 52.0), m + 24.0, 43.0, 10.5, if b.level == 2 { c } else { p.fg }, if b.level == 2 { 1.0 } else { p.dim });
    let inner = CARD_W - 28.0;
    let step = inner / b.days.len().max(1) as f32;
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
    pic
}

#[cfg(test)]
#[path = "tray_menu_views_tests.rs"]
mod tests;
