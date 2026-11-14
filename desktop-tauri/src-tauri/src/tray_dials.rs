//! The two dials of the usage strip: the Mac half dial (disk, memory, CPU, GPU
//! and the load needle) and the pace gauge. Same geometry as the original
//! strip, so the quota columns collapse by the same rule: these cells take
//! room before any account does.

use crate::tray_quota::{status_color, width_pt, Canvas, Face, HEIGHT_PT, SCALE, WHITE};
use serde::Deserialize;

/// Dial size at the 22 pt button: `dialOuter` 12.25 pt over the 11.25 pt reference.
const OUTER: f32 = 12.25;
const K: f32 = OUTER / 11.25;
const CENTER_Y: f32 = 9.0;
const TAG_PT: f32 = 6.5;
const PACE_PT: f32 = 7.0;
const LINE: f32 = 2.5 * K;
const GAUGE_R: f32 = OUTER - LINE / 2.0;
/// Width of the Mac cell.
pub const MAC_W: f32 = OUTER * 2.0 + 4.5;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Part {
    pub pct: Option<u32>,
    pub level: u32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MacDial {
    pub disk: Part,
    pub mem: Part,
    pub cpu: Part,
    pub gpu: Part,
    /// Global load 0..100, the needle.
    pub load: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pace {
    pub value: f64,
    pub zone: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Extras {
    pub mac: Option<MacDial>,
    pub pace: Option<Pace>,
}

impl Extras {
    /// Room the two cells take at the head of the strip, gaps included.
    pub fn head_width(&self, gap: f32) -> f32 {
        self.mac.as_ref().map_or(0.0, |_| MAC_W + gap) + self.pace.as_ref().map_or(0.0, |p| pace_w(p) + gap)
    }
}

#[derive(Deserialize)]
struct RawMac {
    effort: Option<RawEffort>,
}
#[derive(Deserialize)]
struct RawEffort {
    #[serde(default, rename = "loadPct")]
    load_pct: Option<u32>,
    #[serde(default)]
    parts: Vec<RawPart>,
}
#[derive(Deserialize)]
struct RawPart {
    key: String,
    #[serde(default)]
    pct: Option<u32>,
    #[serde(default)]
    level: u32,
}
#[derive(Deserialize)]
struct RawBoard {
    overall: Option<RawOverall>,
}
#[derive(Deserialize)]
struct RawOverall {
    value: Option<f64>,
    #[serde(default)]
    zone: String,
}

/// `/api/mac`: no reading of cpu or memory means no dial, like the original.
pub fn parse_mac(body: &str) -> Option<MacDial> {
    let e = serde_json::from_str::<RawMac>(body).ok()?.effort?;
    if !e.parts.iter().any(|p| (p.key == "cpu" || p.key == "mem") && p.pct.is_some()) {
        return None;
    }
    let part = |k: &str| e.parts.iter().find(|p| p.key == k).map(|p| Part { pct: p.pct, level: p.level }).unwrap_or_default();
    Some(MacDial { disk: part("disk"), mem: part("mem"), cpu: part("cpu"), gpu: part("gpu"), load: e.load_pct })
}

/// `/api/board`: a week that cannot be measured yet draws no gauge.
pub fn parse_pace(body: &str) -> Option<Pace> {
    let o = serde_json::from_str::<RawBoard>(body).ok()?.overall?;
    Some(Pace { value: o.value?, zone: o.zone })
}

/// The service formats the number with a decimal comma and no trailing zeros.
pub fn pace_text(v: f64) -> String {
    let mut t = format!("{v:.2}");
    while t.ends_with('0') {
        t.pop();
    }
    if t.ends_with('.') {
        t.pop();
    }
    format!("{}×", t.replace('.', ","))
}

pub fn pace_w(p: &Pace) -> f32 {
    (GAUGE_R * 2.0 + 3.0).max(width_pt(Face::MonoBold, &pace_text(p.value), PACE_PT))
}

fn tone(level: u32) -> [u8; 3] {
    status_color(match level {
        0 => "ok",
        1 => "warning",
        _ => "critical",
    })
    .0
}

/// Coverage painter over pt coordinates with a bottom origin.
struct Paint<'a> {
    cv: &'a mut Canvas,
}

impl Paint<'_> {
    fn each(&mut self, x0: f32, x1: f32, y0: f32, y1: f32, cov: impl Fn(f32, f32) -> f32, c: [u8; 3], a: f32) {
        let s = SCALE;
        let (px0, px1) = (((x0 * s).floor() as i32).max(0), (x1 * s).ceil() as i32);
        let (py0, py1) = ((((HEIGHT_PT - y1) * s).floor() as i32).max(0), ((HEIGHT_PT - y0) * s).ceil() as i32);
        for py in py0..py1 {
            for px in px0..px1 {
                let (x, y) = ((px as f32 + 0.5) / s, HEIGHT_PT - (py as f32 + 0.5) / s);
                let k = cov(x, y);
                if k > 0.0 {
                    self.cv.blend(px, py, c, a * k);
                }
            }
        }
    }
    /// Arc of the upper half circle, `t0..t1` running left (0) to right (1).
    fn ring(&mut self, cx: f32, r: f32, w: f32, t0: f32, t1: f32, c: [u8; 3], a: f32) {
        let (lo, hi) = (t0.min(t1) - 0.002, t0.max(t1) + 0.002);
        let ext = r + w;
        self.each(cx - ext, cx + ext, CENTER_Y - 0.5, CENTER_Y + ext, |x, y| {
            let (dx, dy) = (x - cx, y - CENTER_Y);
            let t = 1.0 - dy.max(0.0).atan2(dx) / std::f32::consts::PI;
            if t < lo || t > hi {
                return 0.0;
            }
            (w * SCALE / 2.0 - ((dx * dx + dy * dy).sqrt() - r).abs() * SCALE + 0.5).clamp(0.0, 1.0)
        }, c, a);
    }
    fn wedge(&mut self, cx: f32, r: f32, t1: f32, c: [u8; 3], a: f32) {
        self.each(cx - r - 1.0, cx + r + 1.0, CENTER_Y - 0.5, CENTER_Y + r + 1.0, |x, y| {
            let (dx, dy) = (x - cx, y - CENTER_Y);
            let t = 1.0 - dy.max(0.0).atan2(dx) / std::f32::consts::PI;
            if t > t1 + 0.002 {
                return 0.0;
            }
            ((r - (dx * dx + dy * dy).sqrt()) * SCALE + 0.5).clamp(0.0, 1.0)
        }, c, a);
    }
    fn seg(&mut self, (x0, y0): (f32, f32), (x1, y1): (f32, f32), w: f32, c: [u8; 3], a: f32) {
        let m = w + 1.0;
        self.each(x0.min(x1) - m, x0.max(x1) + m, y0.min(y1) - m, y0.max(y1) + m, |x, y| {
            let (vx, vy) = (x1 - x0, y1 - y0);
            let l2 = (vx * vx + vy * vy).max(1e-6);
            let t = (((x - x0) * vx + (y - y0) * vy) / l2).clamp(0.0, 1.0);
            let d = ((x - x0 - vx * t).powi(2) + (y - y0 - vy * t).powi(2)).sqrt();
            (w * SCALE / 2.0 - d * SCALE + 0.5).clamp(0.0, 1.0)
        }, c, a);
    }
}

fn top(bottom: f32) -> f32 {
    (HEIGHT_PT - bottom) * SCALE
}

/// Draws the Mac cell with its left edge at `x` (pt).
pub fn draw_mac(cv: &mut Canvas, x: f32, m: &MacDial) {
    let cx = x + OUTER + 2.25;
    let (disc, band, gap) = (4.25 * K, 2.5 * K, 1.0 * K);
    let r1 = disc + gap + band / 2.0;
    let r2 = r1 + band + gap;
    let track = 0.22;
    let frac = |p: &Part| p.pct.map_or(0.0, |v| v.min(100) as f32 / 100.0);
    let col = |p: &Part| if p.pct.is_none() { None } else { Some(tone(p.level)) };
    let mut p = Paint { cv };
    // disk: the full disc
    p.wedge(cx, disc, 1.0, WHITE, track);
    if let Some(c) = col(&m.disk) {
        p.wedge(cx, disc, frac(&m.disk).max(0.02), c, 1.0);
    }
    p.seg((cx - 0.0 + disc * 0.45 * (std::f32::consts::PI * (1.0 - 0.85)).cos(), CENTER_Y + disc * 0.45 * (std::f32::consts::PI * (1.0 - 0.85)).sin()), (cx + disc * (std::f32::consts::PI * (1.0 - 0.85)).cos(), CENTER_Y + disc * (std::f32::consts::PI * (1.0 - 0.85)).sin()), (band / 6.0).max(1.0), [0, 0, 0], 0.55);
    // memory: one full band
    p.ring(cx, r1, band, 0.0, 1.0, WHITE, track);
    if let Some(c) = col(&m.mem) {
        p.ring(cx, r1, band, 0.0, frac(&m.mem).max(0.02), c, 1.0);
    }
    // CPU on the left half, GPU on the right half of the outer band
    let g = gap / 2.0 / (std::f32::consts::PI * r2);
    let half = 0.5 - g;
    for (k, part) in [&m.cpu, &m.gpu].into_iter().enumerate() {
        let (from, dir) = if k == 0 { (0.0, 1.0) } else { (1.0, -1.0) };
        p.ring(cx, r2, band, from, from + dir * half, WHITE, track);
        if let Some(c) = col(part) {
            p.ring(cx, r2, band, from, from + dir * half * frac(part).max(0.02), c, 1.0);
        }
    }
    if let Some(v) = m.load {
        let a = std::f32::consts::PI * (1.0 - v.min(100) as f32 / 100.0);
        p.seg((cx, CENTER_Y), (cx + r2 * a.cos(), CENTER_Y + r2 * a.sin()), (band * 0.6).min(2.5), WHITE, 1.0);
    }
    // the initials under the dial: D centred, M inside the left edge, C and G outside
    let edge1 = r1 - band / 2.0;
    let edge2 = r2 + band / 2.0 - 1.0;
    for (label, dx) in [("D", 0.0), ("M", -edge1), ("C", -edge2), ("G", edge2)] {
        let tw = width_pt(Face::Sans, label, TAG_PT);
        cv.text(Face::Sans, label, (cx + dx - tw / 2.0) * SCALE, top(1.0), TAG_PT * SCALE, WHITE, 1.0);
    }
}

/// Draws the pace gauge cell with its left edge at `x` (pt), `w` wide.
pub fn draw_pace(cv: &mut Canvas, x: f32, p: &Pace) {
    let w = pace_w(p);
    let cx = x + w / 2.0;
    let ratio = p.value as f32;
    let mut pt = Paint { cv };
    for (from, to, st) in [(0.0f32, 1.0f32, "ok"), (1.0, 1.3, "warning"), (1.3, 2.0, "critical")] {
        let on = from == 0.0 || ratio > from;
        pt.ring(cx, GAUGE_R, LINE, from / 2.0, to / 2.0, status_color(st).0, if on { 0.95 } else { 0.35 });
    }
    let a = std::f32::consts::PI * (1.0 - ratio.clamp(0.0, 2.0) / 2.0);
    pt.seg((cx, CENTER_Y), (cx + (GAUGE_R - 1.0) * a.cos(), CENTER_Y + (GAUGE_R - 1.0) * a.sin()), 1.5 * K, WHITE, 1.0);
    pt.seg((cx, CENTER_Y), (cx, CENTER_Y), 3.0 * K, WHITE, 1.0);
    // white when the pace is fine, the zone colour when it is not
    let color = match p.zone.as_str() {
        "frenato" => status_color("critical").0,
        "sopra" => status_color("warning").0,
        _ => WHITE,
    };
    let t = pace_text(p.value);
    let tw = width_pt(Face::MonoBold, &t, PACE_PT);
    cv.text(Face::MonoBold, &t, (x + (w - tw) / 2.0) * SCALE, top(1.0), PACE_PT * SCALE, color, 1.0);
}
