//! The tray strip's two worker threads: the poller that asks the usage service every
//! `POLL_SECS`, and the animation that turns the working glyph. Both draw from the
//! same latest answer, so a frame never waits on the network.

use crate::tray_agents::{self, AgentStates};
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
    frame: u32,
    last: AgentStates,
}

impl Animation {
    pub fn new() -> Self {
        Animation { frame: 0, last: AgentStates::default() }
    }

    /// One tick: the strip is redrawn only when the counts changed; a plain turn of the
    /// working glyph only moves the overlay to its next pre-rendered frame.
    /// `overlay(Some(i))` shows frame `i`, `overlay(None)` hides the layer.
    pub fn step(&mut self, mut strip: impl FnMut(Strip), mut overlay: impl FnMut(Option<u32>)) {
        let now = AGENTS.lock().map(|g| *g).unwrap_or_default();
        let changed = now != self.last;
        if now.is_animated() {
            self.frame = (self.frame + 1) % tray_agents::TURN_FRAMES;
        } else if !changed {
            return;
        }
        self.last = now;
        if changed {
            if let Some(s) = render_latest(0) {
                strip(s);
            }
        }
        overlay(now.is_animated().then_some(self.frame));
    }
}

impl Default for Animation {
    fn default() -> Self {
        Self::new()
    }
}

/// Worker: polls every `POLL_SECS`, hands each rendered strip to `apply`; a second
/// thread turns the working glyph while an agent is at work (and redraws when the
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
        loop {
            std::thread::sleep(Duration::from_millis(tray_agents::FRAME_MS));
            anim.step(|s| apply(s), &overlay);
        }
    });
}
