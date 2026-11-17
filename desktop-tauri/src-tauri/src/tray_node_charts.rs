//! What the node cards and their submenus add to the dial: status rows, the two small 24 hour
//! lines and the day's card count in the card; the hour by hour bars, the lag line and the cloud
//! spend in the submenu. Pure functions from the files' data to images; a chart with no data is no
//! image at all, never an empty box. Drawn like the other cards of the menu, in the menu's ink, so
//! they read on the light and the dark surface.

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
const PANEL_H: f32 = 56.0;
const PLOT_H: f32 = 34.0;

/// Everything one node says beyond its dial. Empty when no file knows the machine.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeExtras {
    pub rows: Vec<StatusRow>,
    pub cpu: Vec<Option<f64>>,
    pub mem: Vec<Option<f64>>,
    /// Seconds between two readings of `cpu` and `mem` (0 = not known: a day of 5 minute readings).
    pub step_s: i64,
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

    fn panels(&self) -> usize {
        [drawable(&self.cpu), drawable(&self.mem), self.cards_panel().is_some()].iter().filter(|x| **x).count()
    }

    /// Height the card grows by to hold the rows and the small charts.
    pub fn block_h(&self) -> f32 {
        let (rows, charts) = (self.rows.len() as f32 * ROW_H, if self.panels() > 0 { PANEL_H + 4.0 } else { 0.0 });
        if rows + charts == 0.0 { 0.0 } else { 8.0 + rows + charts + 2.0 }
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
/// leave its line in a few pixels at the right edge of a day), and how long that part reaches, in seconds.
fn covered(v: &[Option<f64>], step_s: i64) -> (&[Option<f64>], i64) {
    let first = v.iter().position(Option::is_some).unwrap_or(0);
    let part = &v[first..];
    (part, part.len() as i64 * if step_s > 0 { step_s } else { 300 })
}

/// «CPU · 24 h», or «CPU · 5 ore» while the history is younger than a day.
fn window_title(name: &str, secs: i64) -> String {
    if secs >= 23 * 3600 { format!("{name} · 24 h") } else { format!("{name} · {}", health::span(secs)) }
}

fn last_value(v: &[Option<f64>]) -> Option<f64> {
    v.iter().rev().flatten().next().copied()
}

/// The ink of a chart line: a solid mid tone (a translucent one shows its joints where two segments overlap).
fn line_ink(p: Palette) -> [u8; 3] {
    if p.fg[0] > 127 { [205, 205, 205] } else { [75, 75, 75] }
}

/// A 24 hour line, 0 to 100 %: faint guides at 0, 50 and 100, the line in the menu's ink, the last reading as a coloured dot.
fn pct_line(pic: &mut Pic, (x, y, w, h): (f32, f32, f32, f32), v: &[Option<f64>], p: Palette) {
    for g in [0.0, 0.5, 1.0] {
        pic.hline(x, y + h * g, w, p.fg, 0.10);
    }
    let step = w / (v.len().max(2) - 1) as f32;
    let pt = |i: usize, val: f64| (x + i as f32 * step, y + h - (val / 100.0).clamp(0.0, 1.0) as f32 * h);
    let mut prev: Option<(f32, f32)> = None;
    let mut last = None;
    for (i, val) in v.iter().enumerate() {
        match val {
            Some(val) => {
                let at = pt(i, *val);
                if let Some(pp) = prev {
                    pic.seg(pp, at, 1.4, line_ink(p), 1.0);
                }
                prev = Some(at);
                last = Some((at, *val));
            }
            None => prev = None,
        }
    }
    if let Some(((lx, ly), val)) = last {
        pic.dot(lx, ly, 2.4, tone(level_of_pct(val)), 1.0);
    }
}

fn panel_title(pic: &mut Pic, x: f32, w: f32, y: f32, title: &str, value: &str, color: [u8; 3], p: Palette) {
    pic.text(Face::SansRegular, title, x, y + 9.0, 10.0, p.fg, p.dim);
    let vw = Pic::text_w(Face::MonoBold, value, 10.5);
    pic.text(Face::MonoBold, value, x + w - vw, y + 9.5, 10.5, color, 1.0);
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
    let n = e.panels();
    if n == 0 {
        return;
    }
    let gap = 14.0;
    let w = (RIGHT - X0 - gap * (n as f32 - 1.0)) / n as f32;
    let mut x = X0;
    for (name, v) in [("CPU", &e.cpu), ("Memoria", &e.mem)] {
        if !drawable(v) {
            continue;
        }
        let (v, secs) = covered(v, e.step_s);
        let now = last_value(v).unwrap_or(0.0);
        panel_title(pic, x, w, y + 4.0, &window_title(name, secs), &format!("{}%", now.round() as i64), if level_of_pct(now) > 0 { tone(level_of_pct(now)) } else { p.fg }, p);
        pct_line(pic, (x, y + 4.0 + 18.0, w, PLOT_H - 4.0), v, p);
        x += w + gap;
    }
    if let Some(total) = e.cards_panel() {
        panel_title(pic, x, w, y + 4.0, "Card oggi", "", p.fg, p);
        let num = total.to_string();
        let nw = pic.text(Face::MonoBold, &num, x, y + 4.0 + 42.0, 22.0, p.fg, 1.0);
        let say = if total == 1 { "avviata oggi" } else { "avviate oggi" };
        pic.text(Face::SansRegular, say, x + nw + 8.0, y + 4.0 + 42.0, 10.5, p.fg, p.dim);
    }
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

/// Cards started today, hour by hour. None when there is no count or nothing was started (an empty plot says nothing).
pub fn hours_card(e: &NodeExtras, p: Palette) -> Option<Pic> {
    let total = e.cards_total().filter(|t| *t > 0)?;
    let mut pic = framed(96.0, "Card oggi, ora per ora", &format!("{total} in tutto"), p.fg, p);
    let (x, y, w, h) = (CARD_X + 14.0, 38.0, CARD_W - 28.0, 36.0);
    let n = e.cards_hours.len();
    let step = w / n as f32;
    let max = *e.cards_hours.iter().max().unwrap_or(&1) as f32;
    pic.hline(x, y + h, w, p.fg, 0.18);
    for (i, v) in e.cards_hours.iter().enumerate() {
        if *v > 0 {
            let bh = (h * *v as f32 / max).max(2.0);
            pic.fill_rrect(x + i as f32 * step + 1.0, y + h - bh, (step - 2.0).max(2.0), bh, 1.0, tone(0), 1.0);
        }
    }
    for hour in (0..n).step_by(6) {
        pic.text(Face::SansRegular, &format!("{hour}"), x + hour as f32 * step, y + h + 13.0, 9.5, p.fg, p.dim);
    }
    Some(pic)
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
    let charts: Vec<(&str, Option<Pic>)> = vec![("hours", hours_card(e, p)), ("lag", lag_card(e, p)), ("spend", spend_card(e, p))];
    let mut cards: Vec<Node> = charts.into_iter().filter_map(|(k, pic)| {
        let pic = pic?;
        Some(Node::Card { key: format!("chart:{key}:{k}"), png: pic.to_png()?, w: pic.w, h: pic.h, children: Vec::new() })
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
