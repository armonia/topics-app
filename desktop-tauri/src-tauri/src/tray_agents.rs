//! The agents-by-state group on the left of the menu-bar strip (card 066276b6).
//!
//! One glyph per state, each followed by its count, in the hues the app draws:
//! work in progress is the app's square loader, playing the shape of what the
//! agents are doing (think, write, search, tool, wait, error, as the action map of
//! `loaderState.ts` folds them); what waits for an answer is the loader's `wait`
//! shape, still and amber; review keeps the ring with three quarters of a pie and
//! what is stopped the dashed ring. Only the working glyph moves, so a strip with
//! an agent at work reads as alive without anybody counting.
//!
//! The loader's squares are NOT drawn here from a copy of its shapes: they come
//! from the engine itself, sampled by `scripts/gen-tray-loader-frames.ts` into
//! `tray_loader_frames.rs`. This file only rasterizes them.

use crate::tray_loader_frames::{LoaderShape, BOX_PX, CORNER, SHAPES, SHAPE_FOR_ACTION};
use crate::tray_loader_player;
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
/// How long each loader frame stays up (the generator samples the engine at this step).
pub const FRAME_MS: u64 = 120;
/// How long each image of a change of shape stays up: the slide needs more images
/// than the loop, for one second, then the loop is back at `FRAME_MS`.
pub const TRANSITION_FRAME_MS: u64 = 50;
/// The shape the working glyph plays when the client names no action.
const DEFAULT_SHAPE: &str = "think";
/// `frame` value meaning "leave the working glyph out": a native overlay layer
/// turns it from pre-rendered frames, so the strip is not redrawn per frame.
pub const STATIC_FRAME: u32 = u32::MAX;
/// Width in points of the box the overlay layer covers (the working glyph).
pub const OVERLAY_PT: f32 = GLYPH_PT;

/// One RGBA image of every frame of every loader loop, drawn once (tests).
#[cfg(test)]
pub struct GlyphFrames {
    pub width: u32,
    pub height: u32,
    /// The frames of all shapes, one after the other, in `SHAPES` order.
    pub frames: Vec<Vec<u8>>,
    /// Where each shape's frames start in `frames`, and how many it has.
    pub spans: Vec<(u32, u32)>,
}

/// Size in device pixels of one overlay image.
pub fn frame_size() -> (u32, u32) {
    ((OVERLAY_PT * SCALE) as u32, (HEIGHT_PT * SCALE) as u32)
}

/// The RGBA image of overlay frame `frame` (a loop frame or an image of a change, see
/// `tray_loader_player`): text-free, rasterized from the engine's squares.
pub fn frame_rgba(frame: u32) -> Vec<u8> {
    let (w, h) = frame_size();
    let mut cv = Canvas::new(w, h);
    loader(&mut cv, 0.0, tray_loader_player::squares(frame), SKY);
    cv.px
}

/// The loop frames, pre-rendered once: what the tests read.
#[cfg(test)]
pub fn glyph_frames() -> &'static GlyphFrames {
    static FRAMES: std::sync::OnceLock<GlyphFrames> = std::sync::OnceLock::new();
    FRAMES.get_or_init(|| {
        let (width, height) = frame_size();
        let mut frames = Vec::new();
        let mut spans = Vec::new();
        for (i, shape) in SHAPES.iter().enumerate() {
            spans.push((frames.len() as u32, shape.frames.len() as u32));
            for k in 0..shape.frames.len() {
                frames.push(frame_rgba(tray_loader_player::loop_frame(i, k)));
            }
        }
        GlyphFrames { width, height, frames, spans }
    })
}

fn shape_named(name: &str) -> Option<usize> {
    SHAPES.iter().position(|s: &LoaderShape| s.activity == name)
}

/// Index in `SHAPES` of the shape an action plays (by its wire word); no action, or
/// one this shell does not know, plays `think`, as the app's loader does.
pub fn shape_for_action(wire: Option<&str>) -> usize {
    wire.and_then(|w| SHAPE_FOR_ACTION.iter().find(|(a, _)| *a == w))
        .and_then(|(_, shape)| shape_named(shape))
        .or_else(|| shape_named(DEFAULT_SHAPE))
        .unwrap_or(0)
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

/// Rasterizes the loader's squares (`[x, y, side, alpha]` in device pixels of a
/// `BOX_PX` box) into the glyph box at `x_pt`, centred vertically, anti-aliased on
/// the rounded-rectangle edge as a canvas fill would be.
fn loader(cv: &mut Canvas, x_pt: f32, squares: &[[f32; 4]], color: [u8; 3]) {
    let x0 = (x_pt * SCALE).round();
    let y0 = ((HEIGHT_PT * SCALE - BOX_PX as f32) / 2.0).round();
    for &[x, y, side, alpha] in squares {
        let (half, r) = (side / 2.0, side * CORNER);
        let (cx, cy) = (x + half, y + half);
        for py in (y.floor() as i32)..=((y + side).ceil() as i32) {
            for px in (x.floor() as i32)..=((x + side).ceil() as i32) {
                // Signed distance from the pixel centre to the rounded square.
                let (qx, qy) = ((px as f32 + 0.5 - cx).abs() - (half - r), (py as f32 + 0.5 - cy).abs() - (half - r));
                let outside = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r;
                let cov = (0.5 - outside).clamp(0.0, 1.0) * alpha;
                if cov > 0.0 {
                    cv.blend(x0 as i32 + px, y0 as i32 + py, color, cov);
                }
            }
        }
    }
}

/// Draws one state's glyph. `frame` is an overlay frame index and only matters for
/// the working glyph, which the strip draws itself only when no overlay layer turns it.
fn glyph(cv: &mut Canvas, x_pt: f32, kind: Kind, frame: u32) {
    match kind {
        Kind::Working => {
            loader(cv, x_pt, tray_loader_player::squares(frame % tray_loader_player::frame_count() as u32), SKY);
            return;
        }
        Kind::Waiting => {
            let wait = shape_named("wait").map(|i| SHAPES[i].still).unwrap_or(&[]);
            loader(cv, x_pt, wait, AMBER);
            return;
        }
        Kind::Review | Kind::Stopped => {}
    }
    let s = SCALE;
    let (cx, cy) = ((x_pt + GLYPH_PT / 2.0) * s, HEIGHT_PT / 2.0 * s);
    let (r_ring, half, r_pie) = (4.6 * s, 0.8 * s, 3.1 * s);
    let color = if kind == Kind::Review { ROSE } else { MUTED };
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
            if kind == Kind::Review && t < 0.75 {
                cov = cov.max((r_pie + 0.5 - d).clamp(0.0, 1.0));
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
