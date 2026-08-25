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
