//! The tray strip's two worker threads: the poller that asks the usage service every
//! `POLL_SECS`, and the animation that plays the working glyph's loader. Both draw from the
//! same latest answer, so a frame never waits on the network.

use crate::tray_agents::{self, AgentStates};
use crate::tray_loader_player::LoaderPlayer;
use crate::tray_dials::Extras;
use crate::tray_quota::{fetch_columns, fetch_extras, hub_base, render_strip_agents, screen_width_pt, strip_due, Column, Strip, POLL_SECS};
use std::time::Duration;

/// What the strip is drawn from; the poller refreshes it, the animation and the
/// client's agent counts redraw from it without asking the service again.
struct Latest {
    cols: Option<Vec<Column>>,
    extras: Extras,
    ever_answered: bool,
}

static LATEST: std::sync::Mutex<Option<Latest>> = std::sync::Mutex::new(None);
static AGENTS: std::sync::Mutex<AgentStates> = std::sync::Mutex::new(AgentStates { working: 0, review: 0, waiting: 0, stopped: 0 });

/// The client's latest count of agents by state; the next frame draws it.
pub fn set_agents(states: AgentStates) {
    if let Ok(mut g) = AGENTS.lock() {
        *g = states;
    }
}

/// What the agents at work are doing, as the client names it (`shared/agent-action.ts`).
/// The working glyph plays the loader shape of the dominant one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentAction {
    Think,
    Write,
    Read,
    Edit,
    Run,
    Web,
    Browse,
    Delegate,
    Tool,
    Wait,
    Error,
}

/// The wire words, one per action: the same eleven as `AGENT_ACTIONS` in the client.
const WIRE: [(&str, AgentAction); 11] = [
    ("think", AgentAction::Think),
    ("write", AgentAction::Write),
    ("read", AgentAction::Read),
    ("edit", AgentAction::Edit),
    ("run", AgentAction::Run),
    ("web", AgentAction::Web),
    ("browse", AgentAction::Browse),
    ("delegate", AgentAction::Delegate),
    ("tool", AgentAction::Tool),
    ("wait", AgentAction::Wait),
    ("error", AgentAction::Error),
];

impl AgentAction {
    /// The wire word, or None for one this shell does not know (a newer client).
    pub fn from_wire(s: &str) -> Option<AgentAction> {
        WIRE.iter().find(|(w, _)| *w == s).map(|(_, a)| *a)
    }

    /// The wire word of this action, the key of the generated action map.
    pub fn wire(self) -> &'static str {
        WIRE.iter().find(|(_, a)| *a == self).map(|(w, _)| *w).unwrap_or("think")
    }
}

static ACTION: std::sync::Mutex<Option<AgentAction>> = std::sync::Mutex::new(None);

/// The client's latest dominant action; None when nothing works.
pub fn set_action(action: Option<AgentAction>) {
    if let Ok(mut g) = ACTION.lock() {
        *g = action;
    }
}

/// The dominant action the next frame draws.
pub fn current_action() -> Option<AgentAction> {
    ACTION.lock().map(|g| *g).unwrap_or(None)
}

/// Test door: seeds the shared state the animation thread reads.
#[cfg(test)]
pub(crate) fn seed_for_test(cols: Vec<Column>, states: AgentStates) {
    *LATEST.lock().unwrap() = Some(Latest { cols: Some(cols), extras: Extras::default(), ever_answered: true });
    set_agents(states);
}

fn render_latest(frame: u32) -> Option<Strip> {
    let agents = AGENTS.lock().map(|g| *g).unwrap_or_default();
    let guard = LATEST.lock().ok()?;
    let l = guard.as_ref()?;
    if !strip_due(l.ever_answered, l.cols.is_some()) {
        return None;
    }
    // While an agent works its glyph belongs to the native overlay layer.
    let frame = if agents.is_animated() { tray_agents::STATIC_FRAME } else { frame };
    Some(render_strip_agents(l.cols.as_deref(), &l.extras, screen_width_pt(), &agents, frame))
}

/// What the animation thread does on one tick.
pub struct Animation {
    player: LoaderPlayer,
    last: AgentStates,
}

impl Animation {
    pub fn new() -> Self {
        Animation { player: LoaderPlayer::new(), last: AgentStates::default() }
    }

    /// One tick: the strip is redrawn only when the counts changed; a plain step of the
    /// working loader only moves the overlay to its next pre-rendered image, in the
    /// shape of the action the client named last, sliding to it when that changed
    /// (`LoaderPlayer`). `overlay(Some(i))` shows image `i`, `overlay(None)` hides the
    /// layer. Returns how long to wait before the next tick: a change of shape steps
    /// faster than the loop.
    pub fn step(&mut self, mut strip: impl FnMut(Strip), mut overlay: impl FnMut(Option<u32>)) -> u64 {
        let now = AGENTS.lock().map(|g| *g).unwrap_or_default();
        let changed = now != self.last;
        if !now.is_animated() && !changed {
            return tray_agents::FRAME_MS;
        }
        self.last = now;
        if changed {
            if let Some(s) = render_latest(0) {
                strip(s);
            }
        }
        if !now.is_animated() {
            self.player.reset();
            overlay(None);
            return tray_agents::FRAME_MS;
        }
        let want = tray_agents::shape_for_action(current_action().map(AgentAction::wire));
        let tick = self.player.next(want);
        overlay(Some(tick.frame));
        tick.hold_ms
    }
}

impl Default for Animation {
    fn default() -> Self {
        Self::new()
    }
}

/// Worker: polls every `POLL_SECS`, hands each rendered strip to `apply`; a second
/// thread plays the working loader while an agent is at work (and redraws when the
/// counts change). Both run on their own threads, so a hidden window or a restarted
/// client changes nothing.
pub fn spawn_poller<F, G>(apply: F, overlay: G)
where
    F: Fn(Strip) + Send + Sync + 'static,
    G: Fn(Option<u32>) + Send + 'static,
{
    let apply = std::sync::Arc::new(apply);
    let poll_apply = apply.clone();
    let _ = std::thread::Builder::new().name("tray-quota".into()).spawn(move || {
        let mut ever_answered = false;
        loop {
            let base = hub_base();
            let cols = fetch_columns(&base);
            ever_answered |= cols.is_some();
            let extras = fetch_extras(&base);
            crate::tray_quota::set_light_ink(crate::tray_quota::system_is_light());
            if let Ok(mut g) = LATEST.lock() {
                *g = Some(Latest { cols, extras, ever_answered });
            }
            if let Some(strip) = render_latest(0) {
                poll_apply(strip);
            }
            std::thread::sleep(Duration::from_secs(POLL_SECS));
        }
    });
    let _ = std::thread::Builder::new().name("tray-agents".into()).spawn(move || {
        let mut anim = Animation::new();
        let mut hold = tray_agents::FRAME_MS;
        loop {
            std::thread::sleep(Duration::from_millis(hold));
            hold = anim.step(|s| apply(s), &overlay);
        }
    });
}

#[cfg(test)]
mod action_tests {
    use super::*;

    #[test]
    fn every_wire_word_parses_and_an_unknown_one_does_not() {
        for (w, a) in [
            ("think", AgentAction::Think), ("write", AgentAction::Write), ("read", AgentAction::Read),
            ("edit", AgentAction::Edit), ("run", AgentAction::Run), ("web", AgentAction::Web),
            ("browse", AgentAction::Browse), ("delegate", AgentAction::Delegate), ("tool", AgentAction::Tool),
            ("wait", AgentAction::Wait), ("error", AgentAction::Error),
        ] {
            assert_eq!(AgentAction::from_wire(w), Some(a));
        }
        assert_eq!(AgentAction::from_wire("dance"), None);
        assert_eq!(AgentAction::from_wire(""), None);
        for (w, a) in WIRE {
            assert_eq!(a.wire(), w);
        }
    }

    /// Goes red when the Rust actions and the generated action map stop naming the same
    /// eleven words, or an action lands on a shape the frames do not have.
    #[test]
    fn every_action_plays_its_shape_from_the_generated_map() {
        use crate::tray_loader_frames::{SHAPES, SHAPE_FOR_ACTION};
        let words: Vec<&str> = WIRE.iter().map(|(w, _)| *w).collect();
        let mapped: Vec<&str> = SHAPE_FOR_ACTION.iter().map(|(w, _)| *w).collect();
        assert_eq!(words, mapped);
        for (w, shape) in SHAPE_FOR_ACTION {
            let i = tray_agents::shape_for_action(Some(w));
            assert_eq!(SHAPES[i].activity, *shape, "{w}");
        }
        // No action, or an unknown one, plays think, as the app's loader does.
        let think = SHAPES.iter().position(|s| s.activity == "think").unwrap();
        assert_eq!(tray_agents::shape_for_action(None), think);
        assert_eq!(tray_agents::shape_for_action(Some("dance")), think);
    }

    /// The frames an action plays from the start: `len` ticks of the player.
    fn frames_for(action: Option<AgentAction>, len: u32) -> Vec<u32> {
        let mut p = LoaderPlayer::new();
        let want = tray_agents::shape_for_action(action.map(AgentAction::wire));
        (0..len).map(|_| p.next(want).frame).collect()
    }

    /// Goes red when the overlay ignores the action: an edit must step through the
    /// frames of `write`, a read through those of `search`, and loop.
    #[test]
    fn the_overlay_steps_through_the_frames_of_the_action_shape() {
        let g = tray_agents::glyph_frames();
        let span = |name: &str| {
            let i = crate::tray_loader_frames::SHAPES.iter().position(|s| s.activity == name).unwrap();
            g.spans[i]
        };
        let (start, len) = span("write");
        let edit = frames_for(Some(AgentAction::Edit), len * 2);
        assert!(edit.iter().all(|f| (start..start + len).contains(f)));
        assert_eq!(edit[0], edit[len as usize], "one cycle later the loop starts again");
        assert_ne!(edit[0], edit[1], "write moves frame to frame");
        let (s2, l2) = span("search");
        assert!(frames_for(Some(AgentAction::Read), l2).iter().all(|f| (s2..s2 + l2).contains(f)));
        let (s3, l3) = span("think");
        assert!(frames_for(None, l3).iter().all(|f| (s3..s3 + l3).contains(f)));
    }

    #[test]
    fn the_latest_action_is_kept_and_cleared() {
        set_action(Some(AgentAction::Edit));
        assert_eq!(current_action(), Some(AgentAction::Edit));
        set_action(None);
        assert_eq!(current_action(), None);
    }
}
