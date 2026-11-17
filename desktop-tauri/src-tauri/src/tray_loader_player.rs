//! Which loader image the tray's working glyph shows next, and for how long.
//!
//! The loop of a shape steps every `FRAME_MS`. When the agents change action the
//! glyph does not jump to the other loop: it plays the change the app plays, the
//! squares sliding from the old shape to the new one (`TRANSITIONS`, sampled from
//! the engine by `scripts/gen-tray-loader-frames.ts`), one image every
//! `TRANSITION_FRAME_MS`, and then goes on with the new loop from the frame the
//! change lands on.
//!
//! Two rules keep it seamless, as in the app: a change starts only from a loop
//! frame it was sampled from (it waits a few frames for the next one), and a
//! change never cuts a change short (an action that arrives during a slide waits
//! for it to land). The squares are all in the binary, but an image is built the
//! first time it is shown (`tray_overlay::image`) and kept for the life of the
//! process: a tick only says which one, and the memory grows only with the
//! changes really played (3,872 bytes an image, about 9 MB if every one were).

use crate::tray_agents::{FRAME_MS, TRANSITION_FRAME_MS};
use crate::tray_loader_frames::{SHAPES, TRANSITIONS};

/// One image to show: a flat index into the overlay's frames, and how long it stays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tick {
    pub frame: u32,
    pub hold_ms: u64,
}

/// Where the glyph is: on a frame of a loop, or on an image of a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum At {
    Loop { shape: usize, step: usize },
    Change { transition: usize, image: usize },
}

#[derive(Debug, Clone, Default)]
pub struct LoaderPlayer {
    at: Option<At>,
}

/// Flat index of frame `step` of the loop of `shape`: the loops first, in `SHAPES` order.
pub fn loop_frame(shape: usize, step: usize) -> u32 {
    let start: usize = SHAPES[..shape].iter().map(|s| s.frames.len()).sum();
    (start + step % SHAPES[shape].frames.len()) as u32
}

/// Flat index of image `image` of change `transition`: after every loop frame, in `TRANSITIONS` order.
pub fn change_frame(transition: usize, image: usize) -> u32 {
    let loops: usize = SHAPES.iter().map(|s| s.frames.len()).sum();
    let start: usize = TRANSITIONS[..transition].iter().map(|t| t.frames.len()).sum();
    (loops + start + image) as u32
}

/// How many images the overlay can show: every loop frame and every image of every change.
pub fn frame_count() -> usize {
    SHAPES.iter().map(|s| s.frames.len()).sum::<usize>() + TRANSITIONS.iter().map(|t| t.frames.len()).sum::<usize>()
}

/// The squares of a flat frame index.
pub fn squares(frame: u32) -> &'static [[f32; 4]] {
    let mut i = frame as usize;
    for s in SHAPES {
        if i < s.frames.len() {
            return s.frames[i];
        }
        i -= s.frames.len();
    }
    for t in TRANSITIONS {
        if i < t.frames.len() {
            return t.frames[i];
        }
        i -= t.frames.len();
    }
    &[]
}

fn change_from(shape: usize, step: usize, to: usize) -> Option<usize> {
    TRANSITIONS.iter().position(|t| t.from == shape && t.from_frame == step && t.to == to)
}

impl LoaderPlayer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Back to nothing shown: the next tick starts straight on the wanted loop.
    pub fn reset(&mut self) {
        self.at = None;
    }

    /// The image after the one shown, for agents doing shape `want` (an index in `SHAPES`).
    pub fn next(&mut self, want: usize) -> Tick {
        let at = match self.at {
            // Nothing shown yet: the glyph appears on the wanted shape, there is nothing to slide from.
            None => At::Loop { shape: want, step: 0 },
            Some(At::Change { transition, image }) => {
                let t = &TRANSITIONS[transition];
                if image + 1 < t.frames.len() {
                    At::Change { transition, image: image + 1 }
                } else {
                    At::Loop { shape: t.to, step: t.land }
                }
            }
            Some(At::Loop { shape, step }) => match (shape != want).then(|| change_from(shape, step, want)).flatten() {
                Some(transition) => At::Change { transition, image: 0 },
                // Same shape, or a change that waits for the next frame it can start from.
                None => At::Loop { shape, step: (step + 1) % SHAPES[shape].frames.len() },
            },
        };
        self.at = Some(at);
        match at {
            At::Loop { shape, step } => Tick { frame: loop_frame(shape, step), hold_ms: FRAME_MS },
            At::Change { transition, image } => Tick { frame: change_frame(transition, image), hold_ms: TRANSITION_FRAME_MS },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray_loader_frames::LoaderTransition;

    fn shape(name: &str) -> usize {
        SHAPES.iter().position(|s| s.activity == name).unwrap()
    }

    /// Plays `ticks` ticks wanting `want`, returns them.
    fn play(p: &mut LoaderPlayer, want: usize, ticks: usize) -> Vec<Tick> {
        (0..ticks).map(|_| p.next(want)).collect()
    }

    /// Goes red when a change of action jumps from one loop to the other: the frames
    /// after the change must be the sampled change, image by image at its cadence,
    /// and then the new loop from the frame the change lands on.
    #[test]
    fn a_change_of_action_plays_the_change_then_the_new_loop() {
        let (think, search) = (shape("think"), shape("search"));
        let mut p = LoaderPlayer::new();
        let first = play(&mut p, think, 1)[0];
        assert_eq!(first, Tick { frame: loop_frame(think, 0), hold_ms: FRAME_MS });
        // Frame 0 of the loop is a frame a change starts from: the change begins on the next tick.
        let t = change_from(think, 0, search).expect("think -> search sampled from frame 0");
        let tr: &LoaderTransition = &TRANSITIONS[t];
        let ticks = play(&mut p, search, tr.frames.len() + 3);
        for (i, tick) in ticks[..tr.frames.len()].iter().enumerate() {
            assert_eq!(*tick, Tick { frame: change_frame(t, i), hold_ms: TRANSITION_FRAME_MS }, "image {i}");
        }
        let n = SHAPES[search].frames.len();
        let after: Vec<Tick> = ticks[tr.frames.len()..].to_vec();
        assert_eq!(
            after,
            (0..3).map(|k| Tick { frame: loop_frame(search, tr.land + k), hold_ms: FRAME_MS }).collect::<Vec<_>>(),
            "then the loop of search, from frame {} of {n}",
            tr.land
        );
        // The change lasts as long as the app's (one second at least), in images faster than the loop.
        assert!(tr.frames.len() as u64 * TRANSITION_FRAME_MS >= 900);
        assert!(TRANSITION_FRAME_MS < FRAME_MS);
    }

    /// Goes red when a change starts from a loop frame it was not sampled from: that
    /// first image would jump. The change waits for the next frame it can start from.
    #[test]
    fn a_change_waits_for_a_frame_it_can_start_from() {
        let (search, tool) = (shape("search"), shape("tool"));
        let mut p = LoaderPlayer::new();
        play(&mut p, search, 2); // on frame 1 of the loop, not a start frame
        let ticks = play(&mut p, tool, 24);
        let started = ticks.iter().position(|t| t.hold_ms == TRANSITION_FRAME_MS).expect("the change starts");
        // Frames 2.. of the loop before it: it starts after the last of them.
        let start_step = 2 + started - 1;
        for (k, tick) in ticks[..started].iter().enumerate() {
            assert_eq!(tick.frame, loop_frame(search, 2 + k));
        }
        let t = change_from(search, start_step, tool).expect("starts from a sampled frame");
        assert_eq!(ticks[started].frame, change_frame(t, 0));
        assert!(started <= 5, "a change waits a few frames at most, waited {started}");
    }

    /// Goes red when a new action cuts a change short (the app never does): the slide
    /// in progress lands first, then the next change starts.
    #[test]
    fn an_action_during_a_change_waits_for_it_to_land() {
        let (think, search, write) = (shape("think"), shape("search"), shape("write"));
        let mut p = LoaderPlayer::new();
        play(&mut p, think, 1);
        let t = change_from(think, 0, search).unwrap();
        let mut ticks = play(&mut p, search, 3);
        ticks.extend(play(&mut p, write, TRANSITIONS[t].frames.len() - 3 + 1));
        for (i, tick) in ticks[..TRANSITIONS[t].frames.len()].iter().enumerate() {
            assert_eq!(tick.frame, change_frame(t, i), "image {i} of think -> search");
        }
        assert_eq!(ticks.last().unwrap().frame, loop_frame(search, TRANSITIONS[t].land), "landed on search first");
        // Then on to write, through its own change.
        let more = play(&mut p, write, 40);
        assert!(more.iter().any(|t| t.hold_ms == TRANSITION_FRAME_MS));
        assert!((0..SHAPES[write].frames.len()).any(|k| more.last().unwrap().frame == loop_frame(write, k)));
    }

    /// Not a check: writes the images a turn plays (think, search, tool, write, wait,
    /// 2.4 s each) as raw RGBA with how long each stays up, to look at the change.
    /// `TRAY_FILM_DIR=/tmp/film cargo test --lib tray_loader_player -- --ignored`
    #[test]
    #[ignore]
    fn film_of_a_turn() {
        let Ok(dir) = std::env::var("TRAY_FILM_DIR") else { return };
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h) = crate::tray_agents::frame_size();
        let mut p = LoaderPlayer::new();
        let mut log = format!("{w} {h}\n");
        let (mut ms, mut n) = (0u64, 0u32);
        for name in ["think", "search", "tool", "write", "wait"] {
            let until = ms + 2400;
            while ms < until {
                let tick = p.next(shape(name));
                std::fs::write(format!("{dir}/{n:05}.rgba"), crate::tray_agents::frame_rgba(tick.frame)).unwrap();
                log += &format!("{n:05} {ms} {} {name}\n", tick.hold_ms);
                ms += tick.hold_ms;
                n += 1;
            }
        }
        std::fs::write(format!("{dir}/film.txt"), log).unwrap();
    }

    /// Every pair of shapes has a change from the first frame of the loop, and every
    /// change lands inside the loop it goes to.
    #[test]
    fn every_pair_of_shapes_has_its_change() {
        for from in 0..SHAPES.len() {
            for to in 0..SHAPES.len() {
                if from != to {
                    assert!(change_from(from, 0, to).is_some(), "{} -> {}", SHAPES[from].activity, SHAPES[to].activity);
                }
            }
        }
        for t in TRANSITIONS {
            assert!(t.land < SHAPES[t.to].frames.len());
            assert!(t.from_frame < SHAPES[t.from].frames.len());
            assert!(!t.frames.is_empty());
        }
        assert_eq!(squares(change_frame(0, 0)), TRANSITIONS[0].frames[0]);
        assert_eq!(squares(loop_frame(1, 2)), SHAPES[1].frames[2]);
        assert_eq!(frame_count() as u32, change_frame(TRANSITIONS.len() - 1, TRANSITIONS.last().unwrap().frames.len() - 1) + 1);
    }
}
