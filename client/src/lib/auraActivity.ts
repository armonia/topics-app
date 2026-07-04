// Per-session "activity energy" + a shared animation ticker for the working
// aura (see components/AuraWave.tsx).
//
// Producers — chat streaming (useChat.appendToLastMessage) and PTY output
// (SingleTerminalPane) — call bumpAura(id) on each unit of work. The aura's
// render loop reads readAuraEnergy(id) every frame to drive how fast the wave
// travels: a fast stream keeps energy high (wave speeds up), a lull lets it
// decay (wave slows). Energy falls with a ~0.7s half-life, so the response is
// smooth and self-limiting without any explicit "stop" signal.
//
// A SINGLE shared requestAnimationFrame drives every mounted aura, matching the
// app's one-rAF perf ethos, and freezes in lockstep with the CSS animations
// when the window is backgrounded (useAnimationPause toggles `.anims-paused` on
// <html>). Nothing here touches React state — producers are on hot paths.

const HALF_LIFE = 0.7; // seconds

interface Cell {
  e: number; // current energy (undecayed at time t)
  t: number; // performance.now() timestamp of last update
}

const cells = new Map<string, Cell>();

function decay(c: Cell, now: number): number {
  const dt = (now - c.t) / 1000;
  if (dt > 0) {
    c.e *= Math.pow(0.5, dt / HALF_LIFE);
    c.t = now;
  }
  return c.e;
}

/** Add a unit of activity for `id`. Energy is capped so a burst (e.g. a PTY
 *  scrollback dump) can't pin the wave at max for longer than the half-life. */
export function bumpAura(id: string | undefined, weight = 0.28): void {
  if (!id) return;
  const now = performance.now();
  const c = cells.get(id);
  if (c) {
    decay(c, now);
    c.e = Math.min(1.5, c.e + weight);
  } else {
    cells.set(id, { e: Math.min(1.5, weight), t: now });
  }
}

/** Current decayed energy for `id`, clamped to 0..1. Prunes cold entries. */
export function readAuraEnergy(id: string | undefined): number {
  if (!id) return 0;
  const c = cells.get(id);
  if (!c) return 0;
  const e = decay(c, performance.now());
  if (e < 0.002) {
    cells.delete(id);
    return 0;
  }
  return e > 1 ? 1 : e;
}

// ── shared rAF ticker ───────────────────────────────────────────────────────

type Tick = (now: number) => void;
const subscribers = new Set<Tick>();
let rafId = 0;

function loop(now: number): void {
  rafId = requestAnimationFrame(loop);
  // Freeze only when the window is truly HIDDEN (minimized/occluded/tab hidden),
  // NOT on a mere focus-out — with native panes stealing focus, `.anims-paused`
  // fires while the window is still visible, which would freeze a wave the user
  // can plainly see. The loop stays scheduled so it resumes cleanly; each aura
  // clamps its own dt so no phase jump occurs on resume.
  if (document.hidden) return;
  for (const fn of subscribers) fn(now);
}

/** Register a per-frame callback. The rAF loop runs only while ≥1 aura is
 *  mounted. Returns an unsubscribe that stops the loop when the last one goes. */
export function subscribeAuraTick(fn: Tick): () => void {
  subscribers.add(fn);
  if (!rafId) rafId = requestAnimationFrame(loop);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}
