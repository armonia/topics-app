//! Machines in the tray menu: one submenu per machine, the same facts the
//! Processes view shows (state, CPU/memory/disk, provider extras) and a small
//! history line as the icon of its first row. The client decides WHAT each
//! row says (it owns the wording and the numbers); this side only draws.
//! Pure drawing lives here so it is unit tested without a display. Card 672744e2.

use serde::Deserialize;

/// One machine as the client ships it to `set_app_status`.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct StatusMachine {
    pub id: String,
    /// Submenu title: state dot, name and the headline gauges.
    pub title: String,
    /// Detail rows, shown disabled (cost, location, restart pending...).
    #[serde(default)]
    pub lines: Vec<String>,
    /// 0..=100 samples, oldest first: the history line.
    #[serde(default)]
    pub spark: Vec<f32>,
    /// The card of the machine (graphic menu): bare name, state in words, readings.
    /// Empty `badge` = the client did not ship one and the machine keeps its submenu.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub badge: String,
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    pub metrics: Vec<StatusMetric>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct StatusMetric {
    pub key: String,
    /// Null when the machine did not measure it: the band stays off, never 0.
    #[serde(default)]
    pub pct: Option<u32>,
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub note: String,
}

impl StatusMachine {
    /// The card to draw, when the client shipped one.
    pub fn card(&self) -> Option<crate::tray_menu_views::MachineCard> {
        if self.badge.is_empty() {
            return None;
        }
        Some(crate::tray_menu_views::MachineCard {
            id: self.id.clone(),
            local: self.local,
            lines: self.lines.clone(),
            name: self.name.clone(),
            badge: self.badge.clone(),
            level: self.level,
            reason: self.reason.clone(),
            metrics: self.metrics.iter().map(|m| crate::tray_menu_views::Metric { key: m.key.clone(), pct: m.pct, level: m.level, note: m.note.clone() }).collect(),
        })
    }
}

pub const SPARK_W: u32 = 96;
pub const SPARK_H: u32 = 28;

/// An RGBA image of the history line, a soft area under a 2 px stroke, in a
/// mid grey that reads on both the light and the dark menu. Fewer than two
/// samples draw nothing but a flat baseline: a line from no data would lie.
pub fn render_spark(values: &[f32]) -> Vec<u8> {
    let (w, h) = (SPARK_W as usize, SPARK_H as usize);
    let mut px = vec![0u8; w * h * 4];
    let mut put = |x: usize, y: usize, a: u8| {
        if x < w && y < h {
            let i = (y * w + x) * 4;
            if a > px[i + 3] {
                px[i] = 140;
                px[i + 1] = 140;
                px[i + 2] = 146;
                px[i + 3] = a;
            }
        }
    };
    if values.len() < 2 {
        for x in 0..w {
            put(x, h - 2, 120);
        }
        return px;
    }
    let y_of = |v: f32| -> f32 { (h as f32 - 3.0) - v.clamp(0.0, 100.0) / 100.0 * (h as f32 - 6.0) };
    let n = values.len();
    let mut prev_y = y_of(values[0]);
    for x in 0..w {
        let pos = x as f32 / (w - 1) as f32 * (n - 1) as f32;
        let i = pos.floor() as usize;
        let j = (i + 1).min(n - 1);
        let frac = pos - i as f32;
        let y = y_of(values[i] * (1.0 - frac) + values[j] * frac);
        let (lo, hi) = if y < prev_y { (y, prev_y) } else { (prev_y, y) };
        for yy in (lo.floor() as usize)..=(hi.ceil() as usize + 1) {
            put(x, yy, 230);
        }
        for yy in (y.ceil() as usize + 2)..h {
            put(x, yy, 45);
        }
        prev_y = y;
    }
    px
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque(px: &[u8]) -> usize {
        px.chunks(4).filter(|p| p[3] > 0).count()
    }

    #[test]
    fn draws_a_line_for_a_series() {
        let px = render_spark(&[10.0, 80.0, 40.0, 95.0]);
        assert_eq!(px.len(), (SPARK_W * SPARK_H * 4) as usize);
        assert!(opaque(&px) > SPARK_W as usize);
    }

    #[test]
    fn no_data_is_a_flat_baseline_not_a_line() {
        let px = render_spark(&[]);
        assert_eq!(opaque(&px), SPARK_W as usize);
    }

    #[test]
    fn a_higher_series_puts_ink_higher() {
        let top_ink = |v: f32| {
            let px = render_spark(&[v, v, v]);
            px.chunks(4).position(|p| p[3] > 200).unwrap() / 4 / SPARK_W as usize
        };
        assert!(top_ink(90.0) < top_ink(10.0));
    }

    #[test]
    fn parses_the_client_payload() {
        let m: StatusMachine = serde_json::from_str(r#"{"id":"a","title":"t"}"#).unwrap();
        assert!(m.lines.is_empty() && m.spark.is_empty());
    }
}
