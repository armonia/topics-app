//! The detail card of a machine submenu: a bar and a 24 hour chart for each reading
//! (CPU, memory, GPU, disk, or the month's spend of a cloud server), then the
//! state band with its legend and the service's own lines. Pure: the service's
//! `/api/machines` answer in, a picture out. Card ad8b474a.

use crate::tray_menu_pic::{tone, Palette, Pic, MENU_W};
use crate::tray_quota::Face;
use serde_json::Value;

const PAD: f32 = 14.0;
const CARD_W: f32 = MENU_W - 2.0 * PAD;
const ROW_H: f32 = 36.0;
const CHART_X: f32 = PAD + 190.0;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct DetailMetric {
    pub label: String,
    pub pct: Option<f32>,
    pub level: u32,
    /// Text for the value when it is not a percentage (the spend: `8,44/60 €`).
    pub value: String,
    pub note: String,
    /// (time in seconds, 0..100), oldest first.
    pub history: Vec<(i64, f32)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MachineDetail {
    pub id: String,
    pub metrics: Vec<DetailMetric>,
    /// (start, end, state) of the last 24 hours.
    pub segments: Vec<(i64, i64, String)>,
    pub window: i64,
    pub lines: Vec<String>,
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// The machines of `/api/machines`, one detail each.
pub fn machine_details(body: &str) -> Vec<MachineDetail> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    v.as_array().cloned().unwrap_or_default().iter().map(|m| {
        let tl = m.get("timeline");
        MachineDetail {
            id: text(m, "id"),
            metrics: m.get("metrics").and_then(Value::as_array).map(|a| a.iter().map(|x| DetailMetric {
                label: text(x, "name"),
                pct: x.get("pct").and_then(Value::as_f64).map(|p| p.clamp(0.0, 100.0) as f32),
                level: x.get("level").and_then(Value::as_u64).unwrap_or(0) as u32,
                value: text(x, "value"),
                note: text(x, "note"),
                history: x.get("history").and_then(Value::as_array).map(|h| h.iter().filter_map(|p| Some((p.get("t")?.as_i64()?, p.get("v")?.as_f64()? as f32))).collect()).unwrap_or_default(),
            }).collect()).unwrap_or_default(),
            segments: tl.and_then(|t| t.get("segments")).and_then(Value::as_array).map(|a| a.iter().filter_map(|s| Some((s.get("t0")?.as_i64()?, s.get("t1")?.as_i64()?, text(s, "state")))).collect()).unwrap_or_default(),
            window: tl.and_then(|t| t.get("window")).and_then(Value::as_i64).unwrap_or(86_400),
            lines: m.get("lines").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default(),
        }
    }).collect()
}

/// A detail is worth a card only when it has something to draw.
pub fn has_graphics(d: &MachineDetail) -> bool {
    !d.metrics.is_empty() || !d.segments.is_empty()
}

/// The states of the band: key as the service names it, the word shown, the ink.
fn band_state(key: &str, p: Palette) -> Option<(&'static str, [u8; 3], f32)> {
    match key {
        "lavora" => Some(("lavora", tone(0), 1.0)),
        "acceso" => Some(("acceso", p.fg, 0.45)),
        "chiuso" => Some(("ssh chiuso", tone(1), 1.0)),
        "dorme" => Some(("dorme", p.fg, 0.22)),
        "spento" => Some(("spento", p.fg, 0.22)),
        _ => None,
    }
}

const BAND_LEGEND: [&str; 5] = ["lavora", "acceso", "chiuso", "dorme", "spento"];

/// The chart of one reading: a step line on the full 0..100 scale, broken where
/// the service did not read for a long time instead of inventing a stretch.
fn draw_chart(pic: &mut Pic, h: &[(i64, f32)], x: f32, y: f32, w: f32, ht: f32, c: [u8; 3], span: (i64, i64), p: Palette) {
    pic.fill_rrect(x, y, w, ht, 3.0, p.fg, 0.05);
    let (t0, t1) = span;
    if t1 <= t0 {
        return;
    }
    let at = |t: i64, v: f32| (x + w * (t - t0) as f32 / (t1 - t0) as f32, y + ht - ht * v.clamp(0.0, 100.0) / 100.0);
    let gap = ((t1 - t0) / 6).max(1800);
    let mut prev: Option<(i64, f32)> = None;
    for &(t, v) in h.iter().filter(|(t, _)| *t >= t0 && *t <= t1) {
        let (px, py) = at(t, v);
        match prev {
            Some((pt, pv)) if t - pt <= gap => {
                let (ax, ay) = at(pt, pv);
                pic.seg((ax, ay), (px, ay), 1.3, c, 1.0);
                pic.seg((px, ay), (px, py), 1.3, c, 1.0);
            }
            _ => pic.fill_rrect(px - 0.75, py, 1.5, (y + ht - py).max(1.0), 0.5, c, 1.0),
        }
        prev = Some((t, v));
    }
}


/// Height of the card: one row per reading, the state band, the lines.
pub fn detail_height(d: &MachineDetail) -> f32 {
    let band = if d.segments.is_empty() { 0.0 } else { 44.0 };
    8.0 + d.metrics.len() as f32 * ROW_H + band + d.lines.len() as f32 * 15.0 + 8.0
}

pub fn draw_machine_detail(d: &MachineDetail, p: Palette) -> Pic {
    let h = detail_height(d);
    let mut pic = Pic::new(MENU_W, h + 6.0);
    pic.frame(PAD, 3.0, CARD_W, h, p);
    let end = d.segments.iter().map(|s| s.1).max().or_else(|| d.metrics.iter().flat_map(|m| m.history.iter().map(|x| x.0)).max()).unwrap_or(0);
    let span = (end - d.window, end);
    let chart_w = PAD + CARD_W - 14.0 - CHART_X;
    let mut y = 12.0;
    for m in &d.metrics {
        pic.text(Face::Sans, &m.label, PAD + 14.0, y + 12.0, 11.5, p.fg, 1.0);
        let value = if !m.value.is_empty() { m.value.clone() } else { m.pct.map_or("—".to_string(), |v| format!("{}%", v.round() as i64)) };
        pic.text(Face::MonoBold, &value, PAD + 74.0, y + 12.0, 12.0, p.fg, if m.pct.is_some() || !m.value.is_empty() { 1.0 } else { 0.4 });
        let c = tone(m.level);
        pic.bar(PAD + 14.0, y + 23.0, 160.0, m.pct.unwrap_or(0.0), None, c, p);
        let room = if m.history.is_empty() { CARD_W - 28.0 } else { CHART_X - PAD - 14.0 - 40.0 };
        pic.text(Face::SansRegular, &Pic::fit(Face::SansRegular, &m.note, 10.0, room), PAD + 14.0, y + 34.0, 10.0, p.fg, p.dim);
        if !m.history.is_empty() {
            draw_chart(&mut pic, &m.history, CHART_X, y + 2.0, chart_w, ROW_H - 8.0, c, span, p);
        }
        y += ROW_H;
    }
    if !d.segments.is_empty() {
        pic.hline(PAD + 14.0, y + 2.0, CARD_W - 28.0, p.fg, 0.14);
        pic.text(Face::SansRegular, "Stato", PAD + 14.0, y + 20.0, 10.5, p.fg, p.dim);
        // the legend of the states this machine went through, two per line
        let seen: Vec<&str> = BAND_LEGEND.iter().copied().filter(|k| d.segments.iter().any(|s| s.2 == *k)).collect();
        for (i, k) in seen.iter().enumerate() {
            if let Some((word, ink, a)) = band_state(k, p) {
                let (lx, ly) = (PAD + 56.0 + (i % 2) as f32 * 78.0, y + 14.0 + (i / 2) as f32 * 12.0);
                pic.fill_rrect(lx, ly - 7.0, 8.0, 8.0, 2.0, ink, a);
                pic.text(Face::SansRegular, word, lx + 12.0, ly, 9.5, p.fg, p.dim);
            }
        }
        let by = y + 14.0;
        pic.hline(CHART_X, by + 4.0, chart_w, p.fg, 0.14);
        for (a, z, st) in &d.segments {
            let (a, z) = ((*a).max(span.0), (*z).min(span.1));
            if let (Some((_, ink, al)), true) = (band_state(st, p), z > a) {
                let x0 = CHART_X + chart_w * (a - span.0) as f32 / (span.1 - span.0).max(1) as f32;
                let x1 = CHART_X + chart_w * (z - span.0) as f32 / (span.1 - span.0).max(1) as f32;
                pic.fill_rrect(x0, by, (x1 - x0).max(1.0), 9.0, 0.0, ink, al);
            }
        }
        for (label, x, right) in [(crate::tray_menu_views::clock_text(span.0), CHART_X, false), (crate::tray_menu_views::clock_text(span.0 + (span.1 - span.0) / 2), CHART_X + chart_w / 2.0, false), ("ora".to_string(), CHART_X + chart_w, true)] {
            let w = Pic::text_w(Face::SansRegular, &label, 9.0);
            pic.text(Face::SansRegular, &label, if right { x - w } else { x - if x > CHART_X { w / 2.0 } else { 0.0 } }, by + 22.0, 9.0, p.fg, p.dim * 0.8);
        }
        y += 44.0;
    }
    for l in &d.lines {
        pic.text(Face::SansRegular, &Pic::fit(Face::SansRegular, l, 10.5, CARD_W - 28.0), PAD + 14.0, y + 11.0, 10.5, p.fg, p.dim);
        y += 15.0;
    }
    pic
}

#[cfg(test)]
#[path = "tray_menu_detail_tests.rs"]
mod tests;
