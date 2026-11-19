//! What a chart of the tray says under the mouse: a vertical line on the point under the cursor and a
//! label with its time and value («14:05 · 62%», «mar 17 · 0,31 €», «18:00-19:00 · 3 card»).
//!
//! The charts are images, so each one carries its own map: a zone (its plot box, in the card's points, top
//! origin) and one point per reading with the words it says. Everything here is pure: the native view
//! (`tray_menu_native`) asks `mark_at` where to draw the line and the label, and draws them over the image.

/// One reading of a chart: where it sits across the card, and what it says.
#[derive(Debug, Clone, PartialEq)]
pub struct HoverPoint {
    pub x: f32,
    pub label: String,
}

/// A chart that answers to the mouse: its plot box and its readings, left to right.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HoverZone {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub points: Vec<HoverPoint>,
    /// A line inside a row of text answers only a little above and below itself (the rows around it have their
    /// own words and their own lines); a chart of its own reaches its title row and its axis.
    pub reach: Option<f32>,
}

/// The hover reaches this far above the plot (its title row) and below it (its time axis).
const REACH_UP: f32 = 20.0;
const REACH_DOWN: f32 = 14.0;
/// Height of the label and its distance above the plot.
const LABEL_H: f32 = 18.0;
const LABEL_PAD: f32 = 8.0;
/// Margin that keeps the label inside the card.
const EDGE: f32 = 4.0;

impl HoverZone {
    /// The reading under the point `(px, py)` of the card: the nearest one across, when the point is over the plot
    /// (or its title row and axis) and not further than a reading's slot from either end.
    pub fn at(&self, px: f32, py: f32) -> Option<&HoverPoint> {
        let (up, down) = self.reach.map_or((REACH_UP, REACH_DOWN), |r| (r, r));
        if self.points.is_empty() || py < self.y - up || py > self.y + self.h + down {
            return None;
        }
        let slot = if self.points.len() > 1 { self.w / (self.points.len() - 1) as f32 } else { self.w };
        if px < self.x - slot / 2.0 || px > self.x + self.w + slot / 2.0 {
            return None;
        }
        self.points.iter().min_by(|a, b| (a.x - px).abs().total_cmp(&(b.x - px).abs()))
    }
}

/// Where the native view draws: the line over `[top, bottom]` at `line_x`, the label's box and its words.
#[derive(Debug, Clone, PartialEq)]
pub struct HoverMark {
    pub line_x: f32,
    pub top: f32,
    pub bottom: f32,
    pub label: String,
    pub box_x: f32,
    pub box_y: f32,
    pub box_w: f32,
    pub box_h: f32,
}

/// The mark for the cursor at `(px, py)`, over the first zone that answers. `text_w` measures the label's words
/// (the caller's font), `card_w` keeps the box inside the card.
pub fn mark_at(zones: &[HoverZone], px: f32, py: f32, text_w: &dyn Fn(&str) -> f32, card_w: f32) -> Option<HoverMark> {
    zones.iter().find_map(|z| z.at(px, py).map(|p| (z, p))).map(|(z, p)| {
        let box_w = text_w(&p.label) + 14.0;
        let box_x = (p.x - box_w / 2.0).clamp(EDGE, (card_w - box_w - EDGE).max(EDGE));
        // above the plot; a zone at the very top of its image puts the label inside the plot instead
        let above = z.y - LABEL_H - LABEL_PAD;
        let box_y = if above >= 0.0 { above } else { z.y + 2.0 };
        HoverMark { line_x: p.x, top: z.y, bottom: z.y + z.h, label: p.label.clone(), box_x, box_y, box_w, box_h: LABEL_H }
    })
}

/// `HH:MM` of a reading on the zone's clock.
pub fn clock_label(epoch_s: i64, offset: i64) -> String {
    let c = crate::tray_menu_clock::civil(epoch_s * 1000, offset);
    format!("{:02}:{:02}", c.hour, c.minute)
}

/// «mar 17» for a day given as days since 1970-01-01 in the zone.
pub fn day_label(day: i64) -> String {
    const WEEKDAYS: [&str; 7] = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
    let c = crate::tray_menu_clock::civil(day * 86_400 * 1000, 0);
    format!("{} {}", WEEKDAYS[c.weekday], c.dom)
}

/// Days since 1970-01-01 of a calendar date (proleptic Gregorian).
pub fn civil_day(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
#[path = "tray_hover_tests.rs"]
mod tests;
