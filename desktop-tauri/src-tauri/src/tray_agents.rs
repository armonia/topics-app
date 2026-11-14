//! The agents-by-state group on the left of the menu-bar strip (card 066276b6).
//!
//! One glyph per state, each followed by its count: the same shapes and hues the
//! app draws for its status glyphs (ring plus a pie: half for work in progress,
//! three quarters for review; a dashed ring for what is stopped; amber for what
//! waits for an answer). Only the working glyph moves: its pie turns, so a strip
//! with an agent at work reads as alive without anybody counting.

use crate::tray_quota::{width_pt, Canvas, Face, HEIGHT_PT, SCALE, WHITE};
use serde::Deserialize;
use std::f32::consts::TAU;

/// How many agents are in each state, as the client counts them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
pub struct AgentStates {
    #[serde(default)]
    pub working: u32,
    #[serde(default)]
    pub review: u32,
    #[serde(default)]
    pub waiting: u32,
    #[serde(default)]
    pub stopped: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Working,
    Review,
    Waiting,
    Stopped,
}

const GLYPH_PT: f32 = 11.0;
const NUM_PT: f32 = 9.5;
const GLYPH_GAP: f32 = 2.0;
const ITEM_GAP: f32 = 5.0;
const GROUP_GAP: f32 = 7.0;
/// Hues of the dark-theme tokens of the status glyphs: sky-400 in progress, rose-400 review, amber-400 a wait, --text-muted stopped.
/// Tailwind v4 palette (the client's), oklch converted to sRGB: the v3 hex values differ by up to 36 per channel.
const SKY: [u8; 3] = [0, 188, 255];
const ROSE: [u8; 3] = [255, 99, 126];
const AMBER: [u8; 3] = [255, 185, 0];
const MUTED: [u8; 3] = [141, 147, 155];
/// Frames of one full turn of the working pie, and how long each stays up.
pub const TURN_FRAMES: u32 = 12;
pub const FRAME_MS: u64 = 120;
/// `frame` value meaning "leave the working glyph out": a native overlay layer
/// turns it from pre-rendered frames, so the strip is not redrawn per frame.
pub const STATIC_FRAME: u32 = u32::MAX;
/// Width in points of the box the overlay layer covers (the working glyph).
pub const OVERLAY_PT: f32 = GLYPH_PT;

/// One RGBA image of every turn step of the working glyph, drawn once.
pub struct GlyphFrames {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<Vec<u8>>,
}

/// Pre-rendered working-glyph frames: text-free, built once per process.
pub fn glyph_frames() -> &'static GlyphFrames {
    static FRAMES: std::sync::OnceLock<GlyphFrames> = std::sync::OnceLock::new();
    FRAMES.get_or_init(|| {
        let (w, h) = ((OVERLAY_PT * SCALE) as u32, (HEIGHT_PT * SCALE) as u32);
        let frames = (0..TURN_FRAMES)
            .map(|f| {
                let mut cv = Canvas::new(w, h);
                glyph(&mut cv, 0.0, Kind::Working, f);
                cv.px
            })
            .collect();
        GlyphFrames { width: w, height: h, frames }
    })
}

impl AgentStates {
    /// The states that have somebody in them, in reading order.
    pub fn shown(&self) -> Vec<(Kind, u32)> {
        [
            (Kind::Working, self.working),
            (Kind::Review, self.review),
            (Kind::Waiting, self.waiting),
            (Kind::Stopped, self.stopped),
        ]
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .collect()
    }

    /// Width of the group in points, gap to the strip included; 0 when empty.
    pub fn width(&self) -> f32 {
        let items = self.shown();
        if items.is_empty() {
            return 0.0;
        }
        let w: f32 = items.iter().map(|(_, n)| GLYPH_PT + GLYPH_GAP + width_pt(Face::MonoBold, &n.to_string(), NUM_PT)).sum();
        w + ITEM_GAP * (items.len() as f32 - 1.0) + GROUP_GAP
    }

    pub fn is_animated(&self) -> bool {
        self.working > 0
    }
}

/// Coverage of one pixel of a ring, from its distance to the ring's centre line.
fn ring(d: f32, r: f32, half: f32) -> f32 {
    (half + 0.5 - (d - r).abs()).clamp(0.0, 1.0)
}

fn glyph(cv: &mut Canvas, x_pt: f32, kind: Kind, frame: u32) {
    let s = SCALE;
    let (cx, cy) = ((x_pt + GLYPH_PT / 2.0) * s, HEIGHT_PT / 2.0 * s);
    let (r_ring, half, r_pie) = (4.6 * s, 0.8 * s, 3.1 * s);
    let color = match kind {
        Kind::Working => SKY,
        Kind::Review => ROSE,
        Kind::Waiting => AMBER,
        Kind::Stopped => MUTED,
    };
    // Pie as a fraction of the turn, and where it starts (from twelve o'clock).
    let (pie, start) = match kind {
        Kind::Working => (0.5, frame as f32 / TURN_FRAMES as f32),
        Kind::Review => (0.75, 0.0),
        _ => (0.0, 0.0),
    };
    let r_box = (GLYPH_PT / 2.0 * s).ceil() as i32 + 1;
    for dy in -r_box..=r_box {
        for dx in -r_box..=r_box {
            let (px, py) = (dx as f32, dy as f32);
            let d = px.hypot(py);
            // Angle clockwise from twelve o'clock, as a fraction of a turn.
            let t = (px.atan2(-py) / TAU).rem_euclid(1.0);
            let mut cov = ring(d, r_ring, half);
            if kind == Kind::Stopped && (t * 10.0).fract() >= 0.5 {
                cov = 0.0;
            }
            if pie > 0.0 {
                let into = (t - start).rem_euclid(1.0);
                let edge = (r_pie + 0.5 - d).clamp(0.0, 1.0);
                if into < pie {
                    cov = cov.max(edge);
                }
            }
            if kind == Kind::Waiting {
                cov = cov.max((1.7 * s + 0.5 - d).clamp(0.0, 1.0));
            }
            if cov > 0.0 {
                cv.blend(cx.round() as i32 + dx, cy.round() as i32 + dy, color, cov);
            }
        }
    }
}

/// Draws the group at `x_pt`; returns nothing, the caller reserved `width()`.
pub fn draw(cv: &mut Canvas, x_pt: f32, states: &AgentStates, frame: u32) {
    let mut x = x_pt;
    for (kind, n) in states.shown() {
        if !(frame == STATIC_FRAME && kind == Kind::Working) {
            glyph(cv, x, kind, frame);
        }
        x += GLYPH_PT + GLYPH_GAP;
        let label = n.to_string();
        let baseline = (HEIGHT_PT - 7.5) * SCALE;
        cv.text(Face::MonoBold, &label, x * SCALE, baseline, NUM_PT * SCALE, WHITE, 1.0);
        x += width_pt(Face::MonoBold, &label, NUM_PT) + ITEM_GAP;
    }
}

#[cfg(test)]
#[path = "tray_agents_tests.rs"]
mod tests;
