import { test, expect } from 'bun:test';
import { computeMenuPosition } from './popoverPosition';

// Fixed viewport so the math is deterministic without a DOM.
const vp = { viewportWidth: 1000, viewportHeight: 800 };

test('opens below-left, gapped, when it fits', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 200, right: 260 }, { width: 150, height: 200 }, vp);
  expect(r.placement).toBe('below');
  expect(r.top).toBe(124); // anchor.bottom + gap(4)
  expect(r.left).toBe(200); // anchor.left
});

test('flips above when there is no room below', () => {
  const r = computeMenuPosition({ top: 700, bottom: 760, left: 200, right: 260 }, { width: 150, height: 200 }, vp);
  expect(r.placement).toBe('above');
  expect(r.top).toBe(496); // anchor.top - height - gap = 700 - 200 - 4
});

test('clamps against the right viewport edge', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 950, right: 990 }, { width: 150, height: 100 }, vp);
  expect(r.left).toBe(842); // vw - width - margin = 1000 - 150 - 8
});

test('align=right pins the menu right edge to the trigger', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 500, right: 600 }, { width: 150, height: 100 }, { ...vp, align: 'right' });
  expect(r.left).toBe(450); // anchor.right - width = 600 - 150
});

test('align=right near the left edge clamps to the left margin', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 4, right: 40 }, { width: 150, height: 100 }, { ...vp, align: 'right' });
  expect(r.left).toBe(8); // right-aligned would be -110 → clamp to margin
});

test('a menu wider than the viewport pins to the left margin', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 50, right: 90 }, { width: 2000, height: 100 }, vp);
  expect(r.left).toBe(8);
});
