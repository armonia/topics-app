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
