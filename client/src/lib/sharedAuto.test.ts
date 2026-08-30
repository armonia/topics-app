/**
 * @covers SHARED-AUTO-01
 */
import { test, expect } from 'bun:test';
import { computeAutoShared } from './sharedAuto';

// While NATIVE the pane holds no streaming WS → count = other devices.
test('native pane: any other viewer makes it want the shared session', () => {
  expect(computeAutoShared(0, false)).toBe(false); // alone → stay native
  expect(computeAutoShared(1, false)).toBe(true);  // a phone opened the same tab → share
  expect(computeAutoShared(3, false)).toBe(true);
});

// While SHARED the pane's own streaming WS is in the count → subtract 1.
test('shared pane: returns to native only when it is the last viewer', () => {
  expect(computeAutoShared(2, true)).toBe(true);   // me + 1 other → stay shared
  expect(computeAutoShared(1, true)).toBe(false);  // only me left → back to native
  expect(computeAutoShared(0, true)).toBe(false);  // defensive: never negative
});

// The asymmetry is what prevents native↔shared oscillation across the switch.
test('no oscillation across the join/leave transition', () => {
  // phone joins: native sees count 1 → share; after the pane joins, count is 2 → stay
  expect(computeAutoShared(1, false)).toBe(true);
  expect(computeAutoShared(2, true)).toBe(true);
  // phone leaves: count drops to 1 (just this pane) → native
  expect(computeAutoShared(1, true)).toBe(false);
});

// THE FLAP. The "-1 because I'm shared" is only true while the server is
// actually counting this pane. It counts WATCHERS: a pane that left the screen
// says so (set_watching:false) and drops OUT of the count. Subtracting anyway
// turned "the phone is watching" (1) into "nobody is here" (0), so a
// backgrounded shared pane fell back to native, was counted again on the next
// poll, and bounced shared→native→shared every 1200ms while the phone looked.
test('a shared pane that is NOT watching does not subtract itself', () => {
  // Off-screen shared pane + a phone watching: the count is the phone alone.
  expect(computeAutoShared(1, true, false)).toBe(true);   // stay shared — no flap
  // Off-screen and alone: nobody is watching this context at all → native.
  expect(computeAutoShared(0, true, false)).toBe(false);
  // On screen it IS counted, so the subtraction stands (default stays true).
  expect(computeAutoShared(1, true, true)).toBe(false);
  expect(computeAutoShared(2, true, true)).toBe(true);
  // A native pane never holds a viewer socket: `selfWatching` can't change it.
  expect(computeAutoShared(1, false, false)).toBe(true);
  expect(computeAutoShared(0, false, true)).toBe(false);
});

/**
 * ONE READING MUST NOT MOVE THE PANE, and until 30/08 it did.
 *
 * The decision above is sampled by `useSharedViewerCount` every 2000ms, and the
 * caller "debounced" the flip with a 1200ms `setTimeout`. 1200 < 2000: a timer
 * shorter than the sampling period cannot filter anything - it only postpones.
 * A single poll that reads 1 commits the flip 800ms BEFORE the next poll can
 * say 0, so any blip of the viewer count moves the pane off its native webview
 * for a full cycle: the streaming start screen, an error if the server-side
 * Chromium is not there, and the `Nativo`/`DOM` chips appearing out of nowhere.
 * That is the report "the browsers change and go from the start screen to an
 * error, showing native/dom chips at random" (30/08).
 *
 * And the blips are ordinary. A native pane holds a `/ws/browser/:id` socket
 * and is excluded from the count by `_nativeDelegate` - but that flag is set
 * when its `register_native_executor` frame ARRIVES, so between the socket
 * opening and that frame the pane counts as a viewer OF ITSELF. That window
 * opens on every reconnection, and reconnections are routine: the server
 * restarts on every save under `server/`, the machine sleeps, and since
 * `nativeExecutorSocket.ts` the pane retries on a 1s..10s ladder for as long as
 * the server is down.
 *
 * So the confirmation is counted in SAMPLES, not in milliseconds: the same
 * answer twice in a row, whatever the cadence is.
 */
import { stepAutoShare, AUTO_SHARE_CONFIRMATIONS } from './sharedAuto';

test('un solo campione non sposta la pane: serve la conferma', () => {
  // Native, alone. One poll says "someone is here" and the next says nobody.
  let s = { shared: false, agreeing: 0 };
  s = stepAutoShare(s, computeAutoShared(1, s.shared));
  expect(s.shared).toBe(false); // it is a candidate, not a decision
  s = stepAutoShare(s, computeAutoShared(0, s.shared));
  expect(s.shared).toBe(false);
  expect(s.agreeing).toBe(0); // and the streak is back to nothing
});

test('due campioni d accordo la spostano', () => {
  let s = { shared: false, agreeing: 0 };
  s = stepAutoShare(s, computeAutoShared(1, s.shared));
  s = stepAutoShare(s, computeAutoShared(1, s.shared));
  expect(s.shared).toBe(true);
  expect(s.agreeing).toBe(0); // the streak resets once the flip is spent
});

test('e il ritorno a nativa chiede la stessa conferma', () => {
  let s = { shared: true, agreeing: 0 };
  // shared and alone: the count includes me, so 1 means "nobody else".
  s = stepAutoShare(s, computeAutoShared(1, s.shared));
  expect(s.shared).toBe(true);
  s = stepAutoShare(s, computeAutoShared(1, s.shared));
  expect(s.shared).toBe(false);
});

test('la soglia e in campioni, e vale almeno due', () => {
  expect(AUTO_SHARE_CONFIRMATIONS).toBeGreaterThanOrEqual(2);
});

/**
 * THE TRAP THE FOLD HAS TO SIT INSIDE THE HOOK FOR, written down as a sequence.
 *
 * A caller that keys an effect on the viewer count only ever sees it CHANGE:
 * `setState` with the same number bails out of the render, so two identical
 * readings in a row reach the caller as ONE. Counting agreements out there would
 * mean a phone that opens the tab and keeps it open moves the count 0 → 1 once
 * and never again: one confirmation, then silence, and a desktop pane that never
 * joins the session it exists to join.
 *
 * Fed poll by poll — which is what `useSharedViewerCount` now does — the same
 * steady reading confirms itself and the pane crosses over.
 */
test('un valore fermo, ma letto a ogni giro, arriva a confermarsi', () => {
  let s = { shared: false, agreeing: 0 };
  for (const count of [1, 1]) s = stepAutoShare(s, computeAutoShared(count, s.shared));
  expect(s.shared).toBe(true);
});

test('e un solo campione alto in mezzo a zeri non sposta mai niente', () => {
  let s = { shared: false, agreeing: 0 };
  for (const count of [0, 0, 1, 0, 0, 1, 0, 1, 0]) {
    s = stepAutoShare(s, computeAutoShared(count, s.shared));
    expect(s.shared).toBe(false);
  }
});
