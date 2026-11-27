//! The strip's quota part: one row item per provider, no words. A provider shows its logo,
//! one bar and ONE cumulated figure ("used/available %", summed over its accounts), and the
//! first reset behind a clock icon. A stale or missing reading dims the whole item.

use super::*;

/// What one provider contributes to the strip.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Summary {
    pub provider: String,
    /// Sum of the used percentages of the longest window of every account (each capped at 100).
    pub used: u32,
    /// 100 per account.
    pub total: u32,
    /// Reset of the first account that ran out; empty when none did or the reading is old.
    pub first_reset: String,
    /// A stale or missing reading: drawn faint, with no text beyond the figure.
    pub dim: bool,
}

/// Service order of first appearance, one summary per provider.
pub(super) fn summarize(cols: &[Column]) -> Vec<Summary> {
    let mut ids: Vec<&str> = Vec::new();
    for c in cols {
        if !ids.contains(&c.provider.as_str()) {
            ids.push(&c.provider);
        }
    }
    ids.into_iter()
        .map(|id| {
            let mine: Vec<&Column> = cols.iter().filter(|c| c.provider == id).collect();
            let stale = mine.iter().any(|c| c.quotas.iter().any(|q| q.status == "stale"));
            let long: Vec<&Quota> = mine.iter().filter_map(|c| c.quotas.last()).collect();
            let out = long.iter().find(|q| q.used_pct >= 100 || q.status == "depleted");
            Summary {
                provider: id.to_string(),
                used: long.iter().map(|q| q.used_pct.min(100)).sum(),
                total: long.len() as u32 * 100,
                first_reset: if stale { String::new() } else { out.map(|q| q.reset_text.clone()).unwrap_or_default() },
                dim: stale || long.is_empty(),
            }
        })
        .collect()
}

/// The figure: "423/500%", or a bare dash with nothing to count.
pub(super) fn figure(s: &Summary) -> String {
    if s.total == 0 { "-".to_string() } else { format!("{}/{}%", s.used, s.total) }
}

fn fill(s: &Summary) -> f32 {
    if s.total == 0 { 0.0 } else { (s.used as f32 / s.total as f32).min(1.0) }
}

fn status_of(s: &Summary) -> &'static str {
    let pct = if s.total == 0 { 0 } else { s.used * 100 / s.total };
    if s.dim {
        "stale"
    } else if pct >= 90 {
        "critical"
    } else if pct >= 70 {
        "warning"
    } else {
        "ok"
    }
}

const CLOCK_W: f32 = 9.0;
const ITEM_GAP: f32 = 12.0;
const DIM: f32 = 0.4;

fn item_width(s: &Summary) -> f32 {
    let mut w = ICON_SIZE + 4.0 + BAR_W + GAP + 1.0 + width_pt(Face::MonoBold, &figure(s), PCT_PT);
    if !s.first_reset.is_empty() {
        w += 5.0 + CLOCK_W + width_pt(Face::Mono, &s.first_reset, TIME_PT);
    }
    w
}

/// Items per row: the first provider alone on top when there are few, then half and half.
fn split(n: usize) -> usize {
    (n / 2).max(1)
}

/// Width of the quota part and, for each item, its x offset from the part's left edge.
pub(super) fn layout(sums: &[Summary]) -> (f32, Vec<(usize, f32)>) {
    let top = split(sums.len());
    let mut places = Vec::new();
    let mut ends = [0.0f32; 2];
    for (i, s) in sums.iter().enumerate() {
        let row = usize::from(i >= top);
        places.push((row, ends[row]));
        ends[row] += item_width(s) + ITEM_GAP;
    }
    let w = ends.iter().map(|e| if *e > 0.0 { e - ITEM_GAP } else { 0.0 }).fold(0.0, f32::max);
    (w, places)
}

/// A clock face: ring, minute hand up, hour hand right.
fn clock_icon(cv: &mut Canvas, cx: f32, cy: f32, a: f32) {
    let s = SCALE;
    for yy in ((cy - 4.0) * s) as i32..((cy + 4.0) * s) as i32 {
        for xx in ((cx - 4.0) * s) as i32..((cx + 4.0) * s) as i32 {
            let (px, py) = (xx as f32 + 0.5 - cx * s, yy as f32 + 0.5 - cy * s);
            let ring = (px.hypot(py) - 3.2 * s).abs() - 0.45 * s;
            let mut cov = (0.5 - ring).clamp(0.0, 1.0);
            let up = (px.abs() - 0.4 * s).max((py + 1.3 * s).abs() - 1.3 * s);
            let side = ((px - 0.9 * s).abs() - 0.9 * s).max(py.abs() - 0.4 * s);
            cov = cov.max((0.5 - up).clamp(0.0, 1.0)).max((0.5 - side).clamp(0.0, 1.0));
            cv.blend(xx, yy, WHITE, cov * a);
        }
    }
}

/// Draws the part with its left edge at `x0` (points).
pub(super) fn draw(cv: &mut Canvas, x0: f32, sums: &[Summary]) {
    let s = SCALE;
    let top = |b: f32| (HEIGHT_PT - b) * s;
    let (_, places) = layout(sums);
    for (sum, (row, off)) in sums.iter().zip(places) {
        let base = if row == 0 { ROW_TOP_BASELINE } else { ROW_BOTTOM_BASELINE };
        let dim = if sum.dim { DIM } else { 1.0 };
        let mid = HEIGHT_PT - base - PCT_PT * 0.36;
        let mut x = x0 + off;
        if let Some(ic) = provider_icon(&sum.provider) {
            cv.icon(ic, (x * s) as i32, top(base + PCT_PT * 0.36 + ICON_SIZE / 2.0).round() as i32, (ICON_SIZE * s) as i32, dim);
        }
        x += ICON_SIZE + 4.0;
        let (color, ca) = status_color(status_of(sum));
        cv.bar(x * s, top(base + BAR_H - 0.5), BAR_W * s, BAR_H * s, BAR_RADIUS * s, BAR_W * s * fill(sum), (WHITE, TRACK_ALPHA * dim), (color, ca * dim));
        x += BAR_W + GAP + 1.0;
        let f = figure(sum);
        cv.text(Face::MonoBold, &f, x * s, top(base), PCT_PT * s, WHITE, dim);
        x += width_pt(Face::MonoBold, &f, PCT_PT);
        if !sum.first_reset.is_empty() {
            x += 5.0;
            clock_icon(cv, x + 3.5, mid, 0.8);
            cv.text(Face::Mono, &sum.first_reset, (x + CLOCK_W) * s, top(base), TIME_PT * s, WHITE, 0.8);
        }
    }
}
