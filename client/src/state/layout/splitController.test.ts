import { test, expect, describe } from 'bun:test';
import { dropZone, pxToWeightDelta, resizeWeights } from './splitController';
import type { Rect } from './layoutTree';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const close = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

const R: Rect = { x: 0, y: 0, width: 100, height: 100 };

describe('dropZone (5-zone classification)', () => {
  test('center', () => {
    expect(dropZone(R, 50, 50)).toBe('center');
  });
  test('each edge band', () => {
    expect(dropZone(R, 5, 50)).toBe('left');
    expect(dropZone(R, 95, 50)).toBe('right');
    expect(dropZone(R, 50, 5)).toBe('top');
    expect(dropZone(R, 50, 95)).toBe('bottom');
  });
  test('corner resolves to the closest edge', () => {
    // near top-left but slightly closer to the top edge
    expect(dropZone(R, 10, 5)).toBe('top');
    // slightly closer to the left edge
    expect(dropZone(R, 5, 10)).toBe('left');
  });
  test('edgeFrac boundary is exclusive of center', () => {
    // exactly at the default 0.25 boundary → center (min >= edgeFrac)
    expect(dropZone(R, 25, 50)).toBe('center');
    // just inside → left
    expect(dropZone(R, 24, 50)).toBe('left');
  });
  test('out-of-bounds pointer clamps to nearest zone', () => {
    expect(dropZone(R, -20, 50)).toBe('left');
    expect(dropZone(R, 120, 50)).toBe('right');
  });
  test('custom edgeFrac widens the edge bands', () => {
    expect(dropZone(R, 40, 50, 0.45)).toBe('left'); // 0.40 < 0.45
    expect(dropZone(R, 40, 50, 0.25)).toBe('center'); // 0.40 >= 0.25
  });
  test('degenerate rect → center', () => {
    expect(dropZone({ x: 0, y: 0, width: 0, height: 0 }, 0, 0)).toBe('center');
  });
});

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
