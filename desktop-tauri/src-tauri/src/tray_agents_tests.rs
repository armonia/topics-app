use super::*;
use crate::tray_loader_frames::SHAPES;
use crate::tray_quota::{render_strip_agents, Column, Quota};
use crate::tray_dials::Extras;

fn cols() -> Vec<Column> {
    vec![Column {
        provider: "claude".into(),
        label: "ACME".into(),
        active: true,
        current: true,
        reset_credits: 0,
        quotas: vec![Quota { key: "5h".into(), status: "ok".into(), used_pct: 40, reset_text: "2h".into() }],
    }]
}

fn states() -> AgentStates {
    AgentStates { working: 3, review: 2, waiting: 1, stopped: 4 }
}

/// Columns of the leftmost / rightmost inked pixel inside `[from, to)`.
fn ink_cols(s: &crate::tray_quota::Strip, from: u32, to: u32) -> Option<(u32, u32)> {
    let cols: Vec<u32> = (from..to.min(s.width))
        .filter(|x| (0..s.height).any(|y| s.rgba[((y * s.width + x) * 4 + 3) as usize] > 40))
        .collect();
    Some((*cols.first()?, *cols.last()?))
}

#[test]
fn only_states_with_agents_are_shown() {
    let s = AgentStates { working: 2, review: 0, waiting: 0, stopped: 1 };
    assert_eq!(s.shown(), vec![(Kind::Working, 2), (Kind::Stopped, 1)]);
    assert_eq!(AgentStates::default().width(), 0.0);
}

/// Goes red when the group is drawn after the quota columns instead of before them.
#[test]
fn agent_group_sits_left_of_the_strip() {
    let extras = Extras::default();
    let plain = render_strip_agents(Some(&cols()), &extras, 3440.0, &AgentStates::default(), 0);
    let with = render_strip_agents(Some(&cols()), &extras, 3440.0, &states(), 0);
    let lead_px = (states().width() * SCALE) as u32;
    // The strip grew by the group's width, on its left.
    assert!(with.width >= plain.width + lead_px - 2);
    // Ink of the group lives left of where the quota columns start.
    let (first, last) = ink_cols(&with, 0, lead_px).expect("group has ink");
    assert!(first < lead_px / 4, "group starts at the left edge");
    assert!(last < lead_px, "group stays inside its own room");
    // Everything right of the group is the plain strip, shifted by the group's width.
    let (plain_first, _) = ink_cols(&plain, 0, plain.width).unwrap();
    let (with_first_after, _) = ink_cols(&with, lead_px, with.width).unwrap();
    assert!(with_first_after >= plain_first + lead_px - 4);
}

#[test]
fn only_the_working_glyph_moves() {
    let extras = Extras::default();
    let a = render_strip_agents(Some(&cols()), &extras, 3440.0, &states(), 0);
    let b = render_strip_agents(Some(&cols()), &extras, 3440.0, &states(), 3);
    assert_ne!(a.rgba, b.rgba, "the working loader moves");
    let still = AgentStates { working: 0, ..states() };
    let c = render_strip_agents(Some(&cols()), &extras, 3440.0, &still, 0);
    let d = render_strip_agents(Some(&cols()), &extras, 3440.0, &still, 3);
    assert_eq!(c.rgba, d.rgba, "nothing moves without an agent at work");
    assert!(!still.is_animated());
}

/// Goes red when a turn of the working glyph redraws the strip (text, gauges, bars)
/// or pushes a new image to the tray instead of moving the overlay frame.
#[test]
fn animation_frames_never_render_the_strip() {
    use crate::tray_poller::Animation;
    use crate::tray_quota::STRIP_RENDERS;
    crate::tray_poller::seed_for_test(cols(), states());
    let mut anim = Animation::new();
    // The first tick sees new counts: one redraw is allowed.
    let (mut strips, mut frames) = (0, Vec::new());
    anim.step(|_| strips += 1, |f| frames.push(f));
    let after_first = STRIP_RENDERS.with(|c| c.get());
    for _ in 0..(TICKS * 2) {
        anim.step(|_| strips += 1, |f| frames.push(f));
    }
    assert_eq!(STRIP_RENDERS.with(|c| c.get()), after_first, "a frame re-rendered the strip");
    assert_eq!(strips, 1, "a frame pushed a new strip image");
    assert_eq!(frames.len() as u32, TICKS * 2 + 1);
    assert!(frames.iter().all(|f| f.is_some()));
}

#[test]
fn working_glyph_is_left_out_of_the_static_strip() {
    let extras = Extras::default();
    let on = render_strip_agents(Some(&cols()), &extras, 3440.0, &states(), STATIC_FRAME);
    let off = render_strip_agents(Some(&cols()), &extras, 3440.0, &states(), 0);
    assert_eq!(on.width, off.width, "same layout, glyph only missing");
    assert_ne!(on.rgba, off.rgba);
    let g = glyph_frames();
    let total: usize = SHAPES.iter().map(|s| s.frames.len()).sum();
    assert_eq!(g.frames.len(), total);
    assert_ne!(g.frames[0], g.frames[3]);
}

/// Ticks a test plays: longer than the longest loop of the loader.
const TICKS: u32 = 24;

/// Alpha of pixel (x, y) of an RGBA image `w` wide, and its colour.
fn px(rgba: &[u8], w: u32, x: u32, y: u32) -> ([u8; 3], u8) {
    let i = ((y * w + x) * 4) as usize;
    ([rgba[i], rgba[i + 1], rgba[i + 2]], rgba[i + 3])
}

/// Goes red when the rasterizer drops a square of the engine, paints outside it, or
/// changes the working colour: every square is inked sky at its centre, and a pixel
/// no square covers stays empty.
#[test]
fn every_frame_draws_the_engines_squares_in_sky() {
    let g = glyph_frames();
    let y0 = ((HEIGHT_PT * SCALE - crate::tray_loader_frames::BOX_PX as f32) / 2.0).round() as u32;
    let mut i = 0;
    for shape in SHAPES {
        for squares in shape.frames {
            let img = &g.frames[i];
            i += 1;
            for &[x, y, side, alpha] in *squares {
                // Under 3 px the rounded corners reach the centre pixel too: only the bigger squares are full there.
                if side < 3.0 || alpha < 0.5 {
                    continue;
                }
                let (cx, cy) = ((x + side / 2.0) as u32, y0 + (y + side / 2.0) as u32);
                let (c, a) = px(img, g.width, cx, cy);
                assert_eq!(c, SKY, "{} square at {x},{y}", shape.activity);
                assert!(a as f32 >= alpha * 255.0 - 2.0, "{} square at {x},{y} alpha {a}", shape.activity);
            }
            for y in 0..g.height {
                for x in 0..g.width {
                    let covered = squares.iter().any(|&[sx, sy, side, _]| {
                        (x as f32) >= sx.floor() - 1.0 && (x as f32) <= sx + side + 1.0 && (y as f32) >= y0 as f32 + sy.floor() - 1.0 && (y as f32) <= y0 as f32 + sy + side + 1.0
                    });
                    if !covered {
                        assert_eq!(px(img, g.width, x, y).1, 0, "{} ink outside every square at {x},{y}", shape.activity);
                    }
                }
            }
        }
    }
}

/// Goes red when the waiting glyph moves or loses its amber: it is the loader's
/// `wait` shape at its reduced-motion still, the same on every frame.
#[test]
fn the_waiting_glyph_is_the_still_wait_loader_in_amber() {
    let extras = Extras::default();
    let only_waiting = AgentStates { working: 0, review: 0, waiting: 2, stopped: 0 };
    let a = render_strip_agents(Some(&cols()), &extras, 3440.0, &only_waiting, 0);
    let b = render_strip_agents(Some(&cols()), &extras, 3440.0, &only_waiting, 5);
    assert_eq!(a.rgba, b.rgba);
    let wait = SHAPES.iter().find(|s| s.activity == "wait").unwrap();
    let [x, y, side, _] = wait.still[0];
    let y0 = ((HEIGHT_PT * SCALE - crate::tray_loader_frames::BOX_PX as f32) / 2.0).round();
    let x0 = (crate::tray_quota::PAD_X * SCALE).round();
    let (c, al) = px(&a.rgba, a.width, (x0 + x + side / 2.0) as u32, (y0 + y + side / 2.0) as u32);
    assert_eq!(c, AMBER);
    assert!(al > 200);
}
