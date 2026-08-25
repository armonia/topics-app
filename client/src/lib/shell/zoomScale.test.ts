/**
 * @covers ZOOM-01
 */
import { describe, it, expect } from 'bun:test';
import {
  ZOOM_STEPS, DEFAULT_ZOOM, stepZoom, zoomApplyJs, parseZoomStyle, zoomDrifted,
} from './zoomScale';

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

describe('zoom survives a navigation', () => {
  // The bug this guards: zoom is written as an inline style on the DOCUMENT, so
  // every navigation (including the reload the device switcher fires on purpose)
  // hands the pane a fresh document at 100% while the toolbar keeps showing the
  // percentage the user picked. Drift detection is what lets the poll notice and
  // put it back.

  it('a fresh document reports no inline zoom, and that means 100%', () => {
    // NOT "unknown": every navigated page reports '' here.
    expect(parseZoomStyle('')).toBe(DEFAULT_ZOOM);
    expect(parseZoomStyle(undefined)).toBe(DEFAULT_ZOOM);
    expect(parseZoomStyle(null)).toBe(DEFAULT_ZOOM);
  });

  it('reads back both CSS zoom spellings', () => {
    expect(parseZoomStyle('1.5')).toBe(150);
    expect(parseZoomStyle('150%')).toBe(150);
    expect(parseZoomStyle('0.5')).toBe(50);
    expect(parseZoomStyle(' 1.25 ')).toBe(125);
  });

  it('treats an unparseable value as neutral rather than as a number', () => {
    expect(parseZoomStyle('normal')).toBe(DEFAULT_ZOOM);
    expect(parseZoomStyle('reset')).toBe(DEFAULT_ZOOM);
  });

  it('a page that lost the zoom has DRIFTED — this is the whole bug', () => {
    expect(zoomDrifted(150, '')).toBe(true);
    expect(zoomDrifted(50, '')).toBe(true);
  });

  it('a page that still carries it has not', () => {
    expect(zoomDrifted(150, '1.5')).toBe(false);
    expect(zoomDrifted(150, '150%')).toBe(false);
  });

  it('costs nothing on the common path: 100% over a fresh document is not drift', () => {
    // Every navigation of every pane hits this. If it counted as drift, each one
    // would spend an IPC re-applying a zoom that is already correct.
    expect(zoomDrifted(DEFAULT_ZOOM, '')).toBe(false);
  });

  it('ignores float noise from the round-trip through a CSS string', () => {
    expect(zoomDrifted(110, '1.1000000000000001')).toBe(false);
    expect(zoomDrifted(110, '1.2')).toBe(true);
  });

  it('the applied JS round-trips through the parser for every step', () => {
    // The writer and the reader must agree, or the poll would re-apply forever.
    for (const step of ZOOM_STEPS) {
      const js = zoomApplyJs(step);
      const written = js.match(/zoom='([^']+)'/)?.[1];
      expect(written).toBeDefined();
      expect(zoomDrifted(step, written)).toBe(false);
    }
  });

  it('the applied JS cannot throw into the caller', () => {
    // It runs via browser_exec_js on an arbitrary page; a document that refuses
    // the assignment must not reject the invoke.
    expect(zoomApplyJs(150)).toContain('try{');
    expect(zoomApplyJs(150)).toContain('catch(e){}');
  });
});
