/**
 * Dragging a divider: pixels converted into a weight delta, and the resize
 * that keeps the untouched siblings in proportion.
 *
 * @covers LAYOUT-01
 */
import { test, expect, describe } from 'bun:test';
import { pxToWeightDelta, resizeWeights } from './splitController';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const close = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

describe('pxToWeightDelta', () => {
  test('quarter-band drag → 0.25 weight', () => {
    expect(pxToWeightDelta(400, 100)).toBeCloseTo(0.25, 6);
  });
  test('negative drag is signed', () => {
    expect(pxToWeightDelta(200, -50)).toBeCloseTo(-0.25, 6);
  });
  test('degenerate band → 0', () => {
    expect(pxToWeightDelta(0, 50)).toBe(0);
    expect(pxToWeightDelta(-10, 50)).toBe(0);
    expect(pxToWeightDelta(NaN, 50)).toBe(0);
  });
});

describe('resizeWeights', () => {
  const FLOOR = 0.1;
  test('shifts weight from the right child to the left, others untouched', () => {
    const out = resizeWeights([0.5, 0.5], 0, 0.2, FLOOR);
    expect(close(out, [0.7, 0.3])).toBe(true);
  });
  test('negative delta shifts the other way', () => {
    const out = resizeWeights([0.5, 0.5], 0, -0.2, FLOOR);
    expect(close(out, [0.3, 0.7])).toBe(true);
  });
  test('only the two flanking children change in a 3-col band', () => {
    const out = resizeWeights([0.4, 0.4, 0.2], 0, 0.1, FLOOR);
    expect(out[2]).toBeCloseTo(0.2, 9);              // untouched
    expect(out[0] + out[1]).toBeCloseTo(0.8, 9);     // band conserved
    expect(close([out[0], out[1]], [0.5, 0.3])).toBe(true);
    expect(sum(out)).toBeCloseTo(1, 9);
  });
  test('clamps to the floor — cannot collapse a child below MIN', () => {
    const out = resizeWeights([0.5, 0.5], 0, +10, FLOOR); // drag way past the end
    expect(out[1]).toBeCloseTo(FLOOR, 9);                 // right child floored
    expect(out[0]).toBeCloseTo(1 - FLOOR, 9);
  });
  test('clamps the other way too', () => {
    const out = resizeWeights([0.5, 0.5], 0, -10, FLOOR);
    expect(out[0]).toBeCloseTo(FLOOR, 9);
  });
  test('renormalises an un-normalised input before applying delta', () => {
    // weights summing to 2 → treated as [0.5,0.5]; +0.2 → [0.7,0.3]
    const out = resizeWeights([1, 1], 0, 0.2, FLOOR);
    expect(close(out, [0.7, 0.3])).toBe(true);
  });
  test('relaxes the floor when the band is already smaller than 2*floor (no inversion)', () => {
    // the two children sum to 0.15 (band < 2*0.1); a huge drag lands at the midpoint
    const out = resizeWeights([0.05, 0.1, 0.85], 0, +10, FLOOR);
    expect(out[0]).toBeCloseTo(0.075, 9);
    expect(out[1]).toBeCloseTo(0.075, 9);
    expect(out[2]).toBeCloseTo(0.85, 9);
  });
  test('invalid divider index is a no-op', () => {
    const w = [0.5, 0.5];
    expect(resizeWeights(w, 1, 0.2, FLOOR)).toBe(w);   // idx+1 out of range
    expect(resizeWeights(w, -1, 0.2, FLOOR)).toBe(w);
  });
});
