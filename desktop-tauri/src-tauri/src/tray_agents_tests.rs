use super::*;
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
    assert_ne!(a.rgba, b.rgba, "the working pie turns");
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
    use crate::tray_quota::{Animation, STRIP_RENDERS};
    crate::tray_quota::seed_for_test(cols(), states());
    let mut anim = Animation::new();
    // The first tick sees new counts: one redraw is allowed.
    let (mut strips, mut frames) = (0, Vec::new());
    anim.step(|_| strips += 1, |f| frames.push(f));
    let after_first = STRIP_RENDERS.with(|c| c.get());
    for _ in 0..(TURN_FRAMES * 2) {
        anim.step(|_| strips += 1, |f| frames.push(f));
    }
    assert_eq!(STRIP_RENDERS.with(|c| c.get()), after_first, "a frame re-rendered the strip");
    assert_eq!(strips, 1, "a frame pushed a new strip image");
    assert_eq!(frames.len() as u32, TURN_FRAMES * 2 + 1);
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
    assert_eq!(g.frames.len() as u32, TURN_FRAMES);
    assert_ne!(g.frames[0], g.frames[3]);
}
