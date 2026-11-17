/**
 * The tray's loader frames are the engine's, not a copy: regenerating them from
 * `squareLoader.ts` must give the committed Rust file byte for byte, every loop
 * must close on itself, and the action map in the file must be loaderState's.
 *
 * @covers STATUS-VISUAL-01l
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AGENT_ACTIONS } from '../shared/agent-action';
import { loaderActivityForAction } from '../client/src/components/Layout/loaderState';
import { OUT_PATH, renderTrayLoaderFrames, sampleTrayLoader, trayActivities, trayGeometry, transitionAnchors } from './gen-tray-loader-frames';

describe('tray loader frames', () => {
  test('the committed Rust file is what the engine generates today', () => {
    expect(readFileSync(OUT_PATH, 'utf8')).toBe(renderTrayLoaderFrames());
  });

  test('the sizes are read from the Rust glyph, not assumed', () => {
    const g = trayGeometry();
    expect(g.glyphPt).toBeGreaterThan(0);
    expect(g.scale).toBeGreaterThan(0);
    expect(g.frameMs).toBe(120);
    expect(g.transitionMs).toBeGreaterThanOrEqual(40);
    expect(g.transitionMs).toBeLessThanOrEqual(60);
  });

  test('every shape the action map reaches has a loop of at most 24 frames inside the box', () => {
    const { geometry, shapes } = sampleTrayLoader();
    const box = Math.round(geometry.glyphPt * geometry.scale);
    expect(shapes.map((s) => s.activity)).toEqual(trayActivities());
    for (const s of shapes) {
      expect(s.frames.length).toBeGreaterThanOrEqual(1);
      expect(s.frames.length).toBeLessThanOrEqual(24);
      for (const f of [...s.frames, s.still]) {
        expect(f.length).toBeGreaterThan(0);
        for (const [x, y, side, alpha] of f) {
          expect(x).toBeGreaterThanOrEqual(-0.5);
          expect(y).toBeGreaterThanOrEqual(-0.5);
          expect(x + side).toBeLessThanOrEqual(box + 0.5);
          expect(y + side).toBeLessThanOrEqual(box + 0.5);
          expect(alpha).toBeGreaterThan(0);
          expect(alpha).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test('a moving shape moves: think, search, write, tool and wait change frame to frame', () => {
    const { shapes } = sampleTrayLoader();
    for (const name of ['think', 'search', 'write', 'tool', 'wait']) {
      const s = shapes.find((x) => x.activity === name)!;
      expect(new Set(s.frames.map((f) => JSON.stringify(f))).size).toBeGreaterThan(1);
    }
  });

  test('the action map written for Rust is the one of loaderState', () => {
    const src = readFileSync(OUT_PATH, 'utf8');
    for (const a of AGENT_ACTIONS) {
      expect(src).toContain(`("${a}", "${loaderActivityForAction(a)}"),`);
    }
  });

  // The tray used to jump from one loop to the other: every change is now the engine's own slide.
  test('every pair of shapes has its change from every start frame, and each lands on the new loop', () => {
    const { shapes, transitions } = sampleTrayLoader();
    const key = (t: { from: string; fromFrame: number; to: string }) => `${t.from}@${t.fromFrame}>${t.to}`;
    const have = new Set(transitions.map(key));
    for (const from of shapes) {
      for (const fromFrame of transitionAnchors(from.frames.length)) {
        for (const to of shapes) if (to !== from) expect(have.has(key({ from: from.activity, fromFrame, to: to.activity }))).toBe(true);
      }
    }
    const geo = trayGeometry();
    for (const t of transitions) {
      const to = shapes.find((s) => s.activity === t.to)!;
      expect(t.land).toBeGreaterThanOrEqual(0);
      expect(t.land).toBeLessThan(to.frames.length);
      // At least the app's settle (one second, the image that lands included), never a cut.
      expect((t.frames.length + 1) * geo.transitionMs).toBeGreaterThanOrEqual(1000);
      // It moves: not a run of copies of one image.
      expect(new Set(t.frames.map((f) => JSON.stringify(f))).size).toBeGreaterThan(3);
    }
  });
});
