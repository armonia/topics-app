import { describe, it, expect } from 'bun:test';
import { ZOOM_STEPS, DEFAULT_ZOOM, stepZoom } from './zoomScale';

describe('zoomScale', () => {
  it('every step is a clean integer percentage', () => {
    for (const s of ZOOM_STEPS) expect(Number.isInteger(s)).toBe(true);
  });

  it('the default is on the ladder', () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
  });

  it('the ladder is strictly ascending', () => {
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      expect(ZOOM_STEPS[i]).toBeGreaterThan(ZOOM_STEPS[i - 1]);
    }
  });

  it('steps up and down by one notch from 100%', () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
  });

  it('only the sign of delta matters (keyboard ±0.5 == buttons ±1)', () => {
    expect(stepZoom(100, 0.5)).toBe(stepZoom(100, 1));
    expect(stepZoom(100, -0.5)).toBe(stepZoom(100, -1));
    expect(stepZoom(100, 20)).toBe(110);
  });

  it('clamps at both ends of the ladder', () => {
    expect(stepZoom(300, 1)).toBe(300);
    expect(stepZoom(30, -1)).toBe(30);
  });

  it('never leaves the ladder, whatever the input', () => {
    for (const start of [30, 90, 100, 125, 300]) {
      for (const d of [-1, 0, 1]) {
        expect(ZOOM_STEPS as readonly number[]).toContain(stepZoom(start, d));
      }
    }
  });

  it('snaps an off-ladder (legacy/persisted) value to the nearest, then moves', () => {
    // 105 snaps to 100 (tie → lower), then +1 → 110
    expect(stepZoom(105, 1)).toBe(110);
    // 33 snaps to 30, then +1 → 50
    expect(stepZoom(33, 1)).toBe(50);
    // delta 0 just snaps
    expect(stepZoom(112, 0)).toBe(110);
  });
});
