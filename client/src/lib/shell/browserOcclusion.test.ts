import { test, expect } from 'bun:test';
import { slotIntersectsRects, type OverlayRect } from './browserOcclusion';

const slot = { x: 100, y: 100, width: 200, height: 200 }; // covers 100..300 × 100..300

test('an overlay overlapping the slot intersects', () => {
  const o: OverlayRect = { left: 250, top: 250, right: 350, bottom: 350 }; // overlaps the corner
  expect(slotIntersectsRects(slot, [o])).toBe(true);
});

test('an overlay fully inside the slot intersects', () => {
  const o: OverlayRect = { left: 150, top: 150, right: 180, bottom: 180 };
  expect(slotIntersectsRects(slot, [o])).toBe(true);
});

test('an overlay nowhere near the slot does NOT intersect (the key non-kludge case)', () => {
  const toolbarMenu: OverlayRect = { left: 0, top: 0, right: 80, bottom: 60 }; // top-left, far from the pane
  expect(slotIntersectsRects(slot, [toolbarMenu])).toBe(false);
});

test('edge-touching (shared border, zero overlap area) does NOT count as intersecting', () => {
  const flush: OverlayRect = { left: 300, top: 100, right: 400, bottom: 300 }; // left edge == slot right edge
  expect(slotIntersectsRects(slot, [flush])).toBe(false);
});

test('any one of several overlays intersecting is enough', () => {
  const far: OverlayRect = { left: 0, top: 0, right: 10, bottom: 10 };
  const over: OverlayRect = { left: 120, top: 120, right: 140, bottom: 140 };
  expect(slotIntersectsRects(slot, [far, over])).toBe(true);
});

test('a zero-area slot is never occluded', () => {
  const o: OverlayRect = { left: 0, top: 0, right: 9999, bottom: 9999 };
  expect(slotIntersectsRects({ x: 100, y: 100, width: 0, height: 0 }, [o])).toBe(false);
});

test('no overlays → not occluded', () => {
  expect(slotIntersectsRects(slot, [])).toBe(false);
});
