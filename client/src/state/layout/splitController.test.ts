import { test, expect, describe } from 'bun:test';
import { dropZone, pxToWeightDelta } from './splitController';
import type { Rect } from './layoutTree';

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
