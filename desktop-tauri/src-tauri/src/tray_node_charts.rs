//! What the node cards and their submenus add to the dial: status rows (the day's cards among them, with
//! their hours as small bars) and, inside the CPU and memory rows of the legend, each one's 24 hour line; the
//! lag line and the cloud spend in the submenu, the two histories no row of the card carries. Pure functions from the files' data to images; a chart with no data is no
//! image at all, never an empty box. Drawn like the other cards of the menu, in the menu's ink, so
//! they read on the light and the dark surface.

use crate::tray_hover::{HoverPoint, HoverZone};
use crate::tray_menu::{note, with_icon, Node, Snapshot};
use crate::tray_menu_detail::MachineDetail;
use crate::tray_menu_pic::{tone, Palette, Pic, MENU_W};
use crate::tray_menu_views::MachineCard;
use crate::tray_node_health::{self as health, Health, HarnessSync, Spend, StatusRow};
use crate::tray_nodes::PoolNode;
use crate::tray_quota::Face;

/// Left edge of the status rows and the charts: the same column as the machine's name.
const X0: f32 = 38.0;
const RIGHT: f32 = MENU_W - 16.0;
const ROW_H: f32 = 17.0;
const LABEL_W: f32 = 100.0;

/// Everything one node says beyond its dial. Empty when no file knows the machine.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeExtras {
    pub rows: Vec<StatusRow>,
    pub cpu: Vec<Option<f64>>,
    pub mem: Vec<Option<f64>>,
    /// Seconds between two readings of `cpu` and `mem` (0 = not known: a day of 5 minute readings).
    pub step_s: i64,
    /// Epoch second of the first reading of `cpu` and `mem`, so a point can say its time (0 = not known).
    pub from_s: i64,
    /// The zone's distance from UTC in seconds, for the clock a hovered point says.
    pub offset: i64,
    /// The month's spend as the card says it («8,44/60 €»): the one figure, so the chart cannot say another.
    pub spend_say: Option<String>,
    /// Cards started today on this machine, hour by hour.
    pub cards_hours: Vec<u32>,
    /// The four security checks with the time they ran, for the submenu.
    pub checks: Vec<(String, u32, String)>,
    pub checked_at: Option<i64>,
    /// Seconds behind the source, per time, for the submenu.
    pub lag: Vec<(i64, i64)>,
    pub spend: Option<Spend>,
    pub now: i64,
}

/// A series is worth drawing from two real readings on.
fn drawable(v: &[Option<f64>]) -> bool {
    v.iter().flatten().count() >= 2
}

impl NodeExtras {
    pub fn cards_total(&self) -> Option<u32> {
        (!self.cards_hours.is_empty()).then(|| self.cards_hours.iter().sum())
    }

    /// The day's card count is a panel only when something was started: a zero says nothing a badge does not.
    fn cards_panel(&self) -> Option<u32> {
        self.cards_total().filter(|t| *t > 0)
    }

    /// Height the card grows by to hold the status rows (the day's cards are one of them). The CPU and memory
    /// histories live in their legend rows and take no height.
    pub fn block_h(&self) -> f32 {
        let rows = (self.rows.len() + usize::from(self.cards_panel().is_some())) as f32 * ROW_H;
        if rows == 0.0 { 0.0 } else { 8.0 + rows + 2.0 }
    }
}

/// What the menu knows from the files, read once per menu.
#[derive(Debug, Clone, Default)]
pub struct NodeData {
    pub health: Option<Health>,
    pub sync: Option<HarnessSync>,
    pub pool: Vec<PoolNode>,
    pub spend: Option<Spend>,
    /// «Memorie salvate» of this computer (the service's memory sync).
    pub memory_row: Option<StatusRow>,
}

impl NodeData {
    pub fn from_snapshot(snap: &Snapshot, now: i64, offset: i64) -> Self {
        NodeData {
            health: snap.health.as_deref().and_then(health::parse_health),
            sync: snap.harness_sync.as_deref().and_then(health::parse_sync),
            pool: snap.pool.as_deref().map(crate::tray_nodes::parse_pool).unwrap_or_default(),
            spend: snap.pool.as_deref().and_then(health::parse_spend),
            memory_row: snap.memory_sync.as_deref().filter(|_| snap.memory_sync_set).and_then(|b| crate::tray_menu_memory_sync::memory_sync_row(b, now, offset)),
        }
    }

    /// The extras of one card. `details` find the pool seat of the service's own card, which has no machine id.
    pub fn extras(&self, card: &MachineCard, details: &[MachineDetail], now: i64, offset: i64) -> NodeExtras {
        let seat = crate::tray_nodes::pool_of(card, &self.pool, details);
        let ids = [card.machine_id.as_str(), seat.map_or("", |n| n.machine_id.as_str()), card.id.as_str()];
        let machine = self.health.as_ref().and_then(|h| health::health_of(h, card.local, &ids, &card.name).map(|m| (h, m)));
        // a machine the sync file names but no id of this card matches (a PC without a client twin): its name decides
        let sync_id = self.sync.as_ref().and_then(|s| {
            ids.iter().find(|i| !i.is_empty() && s.targets.contains_key(**i)).map(|i| i.to_string())
                .or_else(|| s.targets.iter().find(|(_, t)| !card.local && !t.name.is_empty() && t.name.trim().eq_ignore_ascii_case(card.name.trim())).map(|(id, _)| id.clone()))
        }).unwrap_or_default();
        let sync_id = sync_id.as_str();
        let mut rows: Vec<StatusRow> = Vec::new();
        rows.extend(card.agents.as_ref().and_then(crate::tray_node_agents::summary_row));
        if card.local {
            rows.extend(self.memory_row.clone());
        } else {
            rows.extend(self.sync.as_ref().and_then(|s| health::sync_row(s, sync_id, offset)));
            rows.extend(seat.map(|n| health::code_row(n, now, offset)));
        }
        rows.extend(machine.map(|(h, m)| health::security_row(h, m, now)));
        // the month's spend belongs to the fixed server, or to the first seat when none is fixed
        let spend_seat = self.pool.iter().find(|n| n.has_server && n.fixed).or_else(|| self.pool.iter().find(|n| n.has_server));
        let spend = self.spend.clone().filter(|_| seat.map_or(false, |n| spend_seat.map_or(false, |s| s.n == n.n)));
        NodeExtras {
            rows,
            cpu: machine.map(|(_, m)| m.cpu.clone()).unwrap_or_default(),
            mem: machine.map(|(_, m)| m.mem.clone()).unwrap_or_default(),
            step_s: machine.map_or(0, |(_, m)| m.step_s),
            from_s: machine.map_or(0, |(_, m)| m.from_s),
            offset,
            spend_say: card.metrics.iter().find(|x| x.key == "spend").map(|x| x.value.clone()).filter(|v| !v.is_empty()),
            cards_hours: machine.map(|(_, m)| m.cards_today.clone()).unwrap_or_default(),
            checks: machine.map(|(_, m)| health::check_lines(m)).unwrap_or_default(),
            checked_at: machine.and_then(|(_, m)| m.checked_at),
            lag: self.sync.as_ref().and_then(|s| s.history.get(sync_id)).cloned().unwrap_or_default(),
            spend,
            now,
        }
    }
}

// ------------------------------------------------------------------ in the card

/// The two small lines and the day's card count, as one row of panels under the status rows.
fn level_of_pct(v: f64) -> u32 {
    if v >= 90.0 { 2 } else if v >= 70.0 { 1 } else { 0 }
}

/// The part of a series that holds readings: from the first one on (a history that is hours old would otherwise
/// leave its line in a few pixels at the right edge of a day), how many readings it skips, and how long it reaches, in seconds.
fn covered(v: &[Option<f64>], step_s: i64) -> (&[Option<f64>], usize, i64) {
    let first = v.iter().position(Option::is_some).unwrap_or(0);
    let part = &v[first..];
    (part, first, part.len() as i64 * if step_s > 0 { step_s } else { 300 })
}

/// The ink of a chart line: a solid mid tone (a translucent one shows its joints where two segments overlap).
fn line_ink(p: Palette) -> [u8; 3] {
    if p.fg[0] > 127 { [205, 205, 205] } else { [75, 75, 75] }
}

/// The stretches of a series a line runs through, as inclusive index ranges. One missing reading between two
/// present ones (a round the collector skipped) is crossed by the line; two or more in a row are a hole, and
/// the line stops there: a series with a reading every other slot used to draw as a comb of vertical strokes.
fn stretches(v: &[Option<f64>]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < v.len() {
        if v[i].is_none() {
            i += 1;
            continue;
        }
        let (start, mut last, mut j) = (i, i, i + 1);
        while j < v.len() {
            if v[j].is_some() {
                last = j;
                j += 1;
            } else if j - last == 1 && v.get(j + 1).map_or(false, Option::is_some) {
                j += 1;
            } else {
                break;
            }
        }
        out.push((start, last));
        i = last + 1;
    }
    out
}

/// The holes of a series, as inclusive index ranges of the slots between two stretches (or after the last one).
fn holes(v: &[Option<f64>]) -> Vec<(usize, usize)> {
    let st = stretches(v);
    let mut out: Vec<(usize, usize)> = st.windows(2).map(|w| (w[0].1 + 1, w[1].0 - 1)).collect();
    if let Some(last) = st.last().filter(|l| l.1 + 1 < v.len()) {
        out.push((last.1 + 1, v.len() - 1));
    }
    if let Some(first) = st.first().filter(|f| f.0 > 0) {
        out.insert(0, (0, first.0 - 1));
    }
    out
}

/// A 24 hour line, 0 to 100 %, small enough to sit inside a row of the legend: faint guides at 0 and 100, the line in
/// the menu's ink, the last reading as a coloured dot. A hole is a faint band with a dashed middle (no reading
/// there), never a stroke to the next reading; a lone reading is a dot. `say` words the point at index `i` for the
/// hover, and the line answers to the mouse with one point per slot, only a little above and below itself.
pub(crate) fn spark_line(pic: &mut Pic, (x, y, w, h): (f32, f32, f32, f32), v: &[Option<f64>], p: Palette, say: &dyn Fn(usize, Option<f64>) -> String) {
    for g in [0.0, 1.0] {
        pic.hline(x, y + h * g, w, p.fg, 0.10);
    }
    let step = w / (v.len().max(2) - 1) as f32;
    let at_x = |i: usize| x + i as f32 * step;
    let pt = |i: usize, val: f64| (at_x(i), y + h - (val / 100.0).clamp(0.0, 1.0) as f32 * h);
    for (a, b) in holes(v) {
        // from the middle of the last reading before it to the next one (or to the line's edge)
        let (x0, x1) = (if a == 0 { x } else { at_x(a - 1) }, if b + 1 >= v.len() { x + w } else { at_x(b + 1) });
        pic.fill_rrect(x0, y, (x1 - x0).max(1.0), h, 0.0, p.fg, 0.07);
        let mut dx = x0 + 2.0;
        while dx < x1 - 2.0 {
            pic.hline(dx, y + h / 2.0, 3.0_f32.min(x1 - 2.0 - dx), p.fg, 0.35);
            dx += 6.0;
        }
    }
    let mut last = None;
    // a day of 5 minute readings in 90 points of width is a dense scribble: the line goes through the mean of every
    // few readings (about one per two points of width), the holes and the last reading stay as they are
    let chunk = ((v.len() as f32 / (w / 2.0).max(1.0)).floor() as usize).max(1);
    for (a, b) in stretches(v) {
        let mut pts: Vec<(f32, f32)> = Vec::new();
        let mut i = a;
        while i <= b {
            let end = (i + chunk).min(b + 1);
            let got: Vec<(usize, f64)> = (i..end).filter_map(|j| v[j].map(|val| (j, val))).collect();
            if !got.is_empty() {
                let mean = got.iter().map(|g| g.1).sum::<f64>() / got.len() as f64;
                let mid = got.iter().map(|g| g.0 as f32).sum::<f32>() / got.len() as f32;
                pts.push((x + mid * step, pt(0, mean).1));
            }
            i = end;
        }
        // the line reaches the stretch's last reading, where the dot sits
        if let (Some(val), Some(end)) = (v[b], pts.last()) {
            if at_x(b) - end.0 > 0.5 {
                pts.push(pt(b, val));
            }
        }
        if pts.len() == 1 {
            pic.dot(pts[0].0, pts[0].1, 1.2, line_ink(p), 1.0);
        }
        for pair in pts.windows(2) {
            pic.seg(pair[0], pair[1], 1.2, line_ink(p), 1.0);
        }
        last = (a..=b).rev().find_map(|j| v[j].map(|val| (pt(j, val), val)));
    }
    if let Some(((lx, ly), val)) = last.filter(|_| v.last().map_or(false, Option::is_some)) {
        pic.dot(lx, ly, 1.9, tone(level_of_pct(val)), 1.0);
    }
    pic.hover.push(HoverZone { x, y, w, h, points: v.iter().enumerate().map(|(i, val)| HoverPoint { x: at_x(i), label: say(i, *val) }).collect(), reach: Some(SPARK_REACH) });
}

/// How far above and below a line in a row the mouse still reads it: the row is 18 points, the line 12.
const SPARK_REACH: f32 = 3.0;

/// The history of one reading, drawn inside its row of the legend: `rect` is the plot's box. None (nothing drawn,
/// no room kept) when the history has fewer than two readings, so the caller keeps its bar.
pub(crate) fn spark_for(pic: &mut Pic, rect: (f32, f32, f32, f32), series: &[Option<f64>], e: &NodeExtras, p: Palette) -> bool {
    if !drawable(series) {
        return false;
    }
    let (v, first, _) = covered(series, e.step_s);
    spark_line(pic, rect, v, p, &|i, val| pct_say(e, first, i, val));
    true
}

/// What a hovered reading of CPU or memory says: its time and value, or that nothing was read then.
fn pct_say(e: &NodeExtras, first: usize, i: usize, val: Option<f64>) -> String {
    let clock = if e.from_s > 0 { crate::tray_hover::clock_label(e.from_s + (first + i) as i64 * if e.step_s > 0 { e.step_s } else { 300 }, e.offset) } else { String::new() };
    let what = val.map_or("nessuna lettura".to_string(), |v| format!("{}%", v.round() as i64));
    if clock.is_empty() { what } else { format!("{clock} · {what}") }
}

/// Status rows and small charts, from `y0` down, under a faint line.
pub fn draw_block(pic: &mut Pic, e: &NodeExtras, y0: f32, p: Palette) {
    if e.block_h() == 0.0 {
        return;
    }
    pic.hline(X0, y0 + 2.0, RIGHT - X0, p.fg, 0.14);
    let mut y = y0 + 8.0;
    for r in &e.rows {
        let c = tone(r.level);
        pic.dot(X0 + 3.5, y + 8.5, 3.0, c, 1.0);
        pic.text(Face::SansRegular, &r.label, X0 + 14.0, y + 12.0, 10.5, p.fg, p.dim);
        let tx = X0 + 14.0 + LABEL_W;
        // the state before the first « · » takes the colour, the words after it stay in the ink of the row
        let (lead, rest) = match (r.level > 0, r.text.split_once(" · ")) {
            (true, Some((l, rest))) => (l.to_string(), format!(" · {rest}")),
            (true, None) => (r.text.clone(), String::new()),
            (false, _) => (String::new(), r.text.clone()),
        };
        let lw = if lead.is_empty() { 0.0 } else { pic.text(Face::SansRegular, &lead, tx, y + 12.0, 10.5, c, 1.0) };
        pic.text(Face::SansRegular, &Pic::fit(Face::SansRegular, &rest, 10.5, RIGHT - tx - lw), tx + lw, y + 12.0, 10.5, p.fg, 1.0);
        y += ROW_H;
    }
    // the cards of the day: a status row like the others, with the day's hours as small bars on its right
    if let Some(total) = e.cards_panel() {
        cards_row(pic, e, total, y, p);
    }
}

const CARDS_BARS_W: f32 = 96.0;

/// «Card oggi · 17 avviate» and, at the right margin, a bar per hour of the day (one point each for the hover).
fn cards_row(pic: &mut Pic, e: &NodeExtras, total: u32, y: f32, p: Palette) {
    pic.dot(X0 + 3.5, y + 8.5, 3.0, tone(0), 1.0);
    pic.text(Face::SansRegular, "Card oggi", X0 + 14.0, y + 12.0, 10.5, p.fg, p.dim);
    let tx = X0 + 14.0 + LABEL_W;
    pic.text(Face::SansRegular, &format!("{total} {}", if total == 1 { "avviata" } else { "avviate" }), tx, y + 12.0, 10.5, p.fg, 1.0);
    let n = e.cards_hours.len().max(1);
    let (x, top, h) = (RIGHT - CARDS_BARS_W, y + 3.0, 11.0);
    let step = CARDS_BARS_W / n as f32;
    let max = *e.cards_hours.iter().max().unwrap_or(&1) as f32;
    pic.hline(x, top + h, CARDS_BARS_W, p.fg, 0.18);
    for (i, v) in e.cards_hours.iter().enumerate().filter(|(_, v)| **v > 0) {
        let bh = (h * *v as f32 / max).max(2.0);
        pic.fill_rrect(x + i as f32 * step + 0.5, top + h - bh, (step - 1.0).max(1.0), bh, 0.5, tone(0), 1.0);
    }
    pic.hover.push(HoverZone { x, y: top, w: CARDS_BARS_W, h, points: e.cards_hours.iter().enumerate().map(|(i, v)| HoverPoint {
        x: x + (i as f32 + 0.5) * step,
        label: format!("{:02}:00-{:02}:00 · {}", i, (i + 1) % 24, match v { 0 => "nessuna card".to_string(), 1 => "1 card".to_string(), n => format!("{n} card") }),
    }).collect(), reach: Some(SPARK_REACH) });
}

// ------------------------------------------------------------------ in the submenu

const CARD_X: f32 = 14.0;
const CARD_W: f32 = MENU_W - 28.0;

fn framed(h: f32, title: &str, value: &str, color: [u8; 3], p: Palette) -> Pic {
    let mut pic = Pic::new(MENU_W, h + 6.0);
    pic.frame(CARD_X, 3.0, CARD_W, h, p);
    pic.text(Face::Sans, title, CARD_X + 14.0, 24.0, 11.5, p.fg, 1.0);
    let vw = Pic::text_w(Face::MonoBold, value, 11.5);
    pic.text(Face::MonoBold, value, CARD_X + CARD_W - 14.0 - vw, 24.0, 11.5, color, 1.0);
    pic
}

/// How late the memories and rules were on this machine, over the last 24 hours or as far back as the history goes
/// (a young history fills the plot instead of hugging its right edge, and the caption says how far it reaches).
pub fn lag_card(e: &NodeExtras, p: Palette) -> Option<Pic> {
    let pts: Vec<(i64, i64)> = e.lag.iter().filter(|(at, _)| e.now - at <= 86_400 && *at <= e.now).cloned().collect();
    if pts.len() < 2 {
        return None;
    }
    let window = (e.now - pts[0].0).clamp(900, 86_400);
    let start = e.now - window;
    let last = pts.last().map_or(0, |p| p.1);
    let level = if last > 24 * 3600 { 2 } else if last > 3600 { 1 } else { 0 };
    let now_say = if last < 60 { "ora: in pari".to_string() } else { format!("ora: indietro di {}", health::span(last)) };
    let mut pic = framed(96.0, &format!("Ritardo della sincronizzazione · {}", health::span(window)), &now_say, if level > 0 { tone(level) } else { p.fg }, p);
    let (x, y, w, h) = (CARD_X + 14.0, 38.0, CARD_W - 28.0, 36.0);
    let max = (pts.iter().map(|p| p.1).max().unwrap_or(0).max(900)) as f32;
    pic.hline(x, y, w, p.fg, 0.10);
    pic.hline(x, y + h, w, p.fg, 0.18);
    let at = |t: i64, lag: i64| (x + w * (t - start) as f32 / window as f32, y + h - (lag as f32 / max).clamp(0.0, 1.0) * h);
    for pair in pts.windows(2) {
        pic.seg(at(pair[0].0, pair[0].1), at(pair[1].0, pair[1].1), 1.4, line_ink(p), 1.0);
    }
    let (lx, ly) = at(pts[pts.len() - 1].0, last);
    pic.dot(lx, ly, 2.6, tone(level), 1.0);
    pic.hover.push(HoverZone { x, y, w, h, points: pts.iter().map(|(t, lag)| HoverPoint {
        x: at(*t, *lag).0,
        label: format!("{} · {}", crate::tray_hover::clock_label(*t, e.offset), if *lag < 60 { "in pari".to_string() } else { format!("indietro di {}", health::span(*lag)) }),
    }).collect(), reach: None });
    // the scale sits on the top guide, the time axis under the line
    pic.text(Face::SansRegular, &format!("{} fa", health::span(window)), x, y + h + 13.0, 9.5, p.fg, p.dim);
    // the scale rides on the axis row, between its two ends: the top guide is where the line peaks
    let scale = format!("in alto: {} di ritardo", health::span(max as i64));
    pic.text(Face::SansRegular, &scale, x + (w - Pic::text_w(Face::SansRegular, &scale, 9.5)) / 2.0, y + h + 13.0, 9.5, p.fg, p.dim);
    pic.text(Face::SansRegular, "ora", x + w - Pic::text_w(Face::SansRegular, "ora", 9.5), y + h + 13.0, 9.5, p.fg, p.dim);
    Some(pic)
}

fn euro(v: f64) -> String {
    format!("{v:.2} €").replace('.', ",")
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The month's cloud spend, a bar per day, against the day's share of the monthly ceiling.
pub fn spend_card(e: &NodeExtras, p: Palette) -> Option<Pic> {
    let spend = e.spend.as_ref()?;
    let month = spend.days.last()?.0.get(..7)?.to_string();
    let (year, mon): (i64, i64) = (month.get(..4)?.parse().ok()?, month.get(5..7)?.parse().ok()?);
    let dim = days_in_month(year, mon);
    let days: Vec<(i64, f64)> = spend.days.iter().filter(|(d, _)| d.starts_with(&month)).filter_map(|(d, v)| Some((d.get(8..10)?.parse().ok()?, *v))).collect();
    let total: f64 = days.iter().map(|d| d.1).sum();
    let share = spend.cap.map(|c| c / dim as f64);
    // the card's own figure when it has one (the service's, the one the ceiling is judged on); the bars are the log's days
    let value = e.spend_say.clone().unwrap_or_else(|| spend.cap.map_or(euro(total), |c| format!("{} su {}", euro(total), euro(c).replace(",00", ""))));
    let over = spend.cap.map_or(false, |c| total > c);
    let mut pic = framed(112.0, "Spesa cloud del mese", &value, if over { tone(2) } else { p.fg }, p);
    let (x, y, w, h) = (CARD_X + 14.0, 38.0, CARD_W - 28.0, 36.0);
    let max = days.iter().map(|d| d.1).fold(share.unwrap_or(0.0) * 1.2, f64::max).max(0.01) as f32;
    let step = w / dim as f32;
    pic.hline(x, y + h, w, p.fg, 0.18);
    // one reading per day up to the last one the log has; a day with no row says so instead of «0,00 €»
    let upto = days.iter().map(|d| d.0).max().unwrap_or(0);
    let first_day = crate::tray_hover::civil_day(year, mon, 1);
    pic.hover.push(HoverZone { x, y, w, h, points: (1..=upto).map(|d| HoverPoint {
        x: x + (d - 1) as f32 * step + step / 2.0,
        label: format!("{} · {}", crate::tray_hover::day_label(first_day + d - 1), days.iter().find(|r| r.0 == d).map_or("nessuna spesa registrata".to_string(), |r| euro(r.1))),
    }).collect(), reach: None });
    for (d, v) in &days {
        let bh = (h * *v as f32 / max).max(if *v > 0.0 { 2.0 } else { 0.0 });
        let hot = share.map_or(false, |s| *v > s);
        pic.fill_rrect(x + (*d - 1) as f32 * step + 1.0, y + h - bh, (step - 2.0).max(2.0), bh, 1.0, tone(if hot { 1 } else { 0 }), 1.0);
    }
    if let Some(s) = share {
        let ly = y + h - h * s as f32 / max;
        let mut dx = x;
        while dx < x + w {
            pic.hline(dx, ly, 4.0_f32.min(x + w - dx), p.fg, 0.55);
            dx += 7.0;
        }
    }
    for d in [1, 15, dim] {
        let label = d.to_string();
        let lx = x + (d - 1) as f32 * step;
        let lx = if d == dim { x + w - Pic::text_w(Face::SansRegular, &label, 9.5) } else { lx };
        pic.text(Face::SansRegular, &label, lx, y + h + 13.0, 9.5, p.fg, p.dim);
    }
    if let Some(s) = share {
        pic.text(Face::SansRegular, &Pic::fit(Face::SansRegular, &format!("linea: il tetto del mese diviso per i giorni, {} al giorno", euro(s)), 10.0, w), x, y + h + 30.0, 10.0, p.fg, p.dim);
    }
    Some(pic)
}

/// The security checks in the submenu: a line per check with its state and words, and when they ran.
pub fn checks_header(e: &NodeExtras, offset: i64) -> Option<String> {
    (!e.checks.is_empty()).then(|| match e.checked_at {
        Some(t) => format!("Sicurezza · controllata {}", health::day_clock(e.now, t, offset)),
        None => "Sicurezza · ora del controllo non nota".to_string(),
    })
}

/// The head of a node's submenu: the four checks, then the charts that have data. Empty when the files know nothing of the node.
pub fn submenu_nodes(e: &NodeExtras, key: &str, p: Palette, offset: i64) -> Vec<Node> {
    let mut out: Vec<Node> = Vec::new();
    if let Some(head) = checks_header(e, offset) {
        out.push(note(head));
        out.extend(e.checks.iter().map(|(label, level, say)| {
            let tone = match level { 0 => "ok", 1 => "warn", _ => "bad" };
            with_icon(format!("sf:circle.fill|{tone}"), note(format!("{label} · {say}")))
        }));
    }
    let charts: Vec<(&str, Option<Pic>)> = vec![("lag", lag_card(e, p)), ("spend", spend_card(e, p))];
    let mut cards: Vec<Node> = charts.into_iter().filter_map(|(k, pic)| {
        let pic = pic?;
        Some(Node::Card { key: format!("chart:{key}:{k}"), png: pic.to_png()?, w: pic.w, h: pic.h, hover: pic.hover.clone(), children: Vec::new() })
    }).collect();
    if !out.is_empty() && !cards.is_empty() {
        out.push(Node::Sep);
    }
    out.append(&mut cards);
    out
}

#[cfg(test)]
#[path = "tray_node_charts_tests.rs"]
mod tests;
