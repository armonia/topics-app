/**
 * Which of the five drop regions a pointer is in, relative to the target cell.
 *
 * @covers LAYOUT-01
 */
import { describe, expect, test } from 'bun:test';
import { detectDropZone } from './dropZone';

// Geometry law under test (v2): center = middle box, outer ring = nearest
// edge; ring depth = clamp(25% of axis, EDGE_DROP_PX, 45% of axis).

const bounds = (width: number, height: number) => ({ left: 0, top: 0, width, height });
const at = (clientX: number, clientY: number) => ({ clientX, clientY });

describe('detectDropZone (relative 5-zone)', () => {
  const b = bounds(800, 600); // depthX = 200, depthY = 150

  test('middle box resolves to center', () => {
    expect(detectDropZone(at(400, 300), b)).toBe('center');
    // Just inside the box corners.
    expect(detectDropZone(at(201, 151), b)).toBe('center');
    expect(detectDropZone(at(599, 449), b)).toBe('center');
  });

  test('edge quarters resolve to their side — targets are large, not 30px slivers', () => {
    // 150px from the left edge: inside the 200px-deep left ring, far from top/bottom.
    expect(detectDropZone(at(150, 300), b)).toBe('left');
    expect(detectDropZone(at(650, 300), b)).toBe('right');
    expect(detectDropZone(at(400, 100), b)).toBe('top');
    expect(detectDropZone(at(400, 500), b)).toBe('bottom');
  });

  test('corners split along the ring diagonal (nearest normalized edge wins)', () => {
    // Deep in the top-left corner, proportionally closer to the left edge.
    expect(detectDropZone(at(20, 100), b)).toBe('left');
    // Same corner, proportionally closer to the top edge.
    expect(detectDropZone(at(150, 10), b)).toBe('top');
    // Bottom-right corner, closer to the bottom.
    expect(detectDropZone(at(650, 595), b)).toBe('bottom');
  });

  test("'edges' mode returns null in the middle box instead of center", () => {
    expect(detectDropZone(at(400, 300), b, 'edges')).toBeNull();
    expect(detectDropZone(at(150, 300), b, 'edges')).toBe('left');
  });

  test('tiny panes keep at least the edgePx band but never lose the center', () => {
    // 100×100 pane: 25% = 25px < 30px floor → depth = 30px, capped at 45px.
    const tiny = bounds(100, 100);
    expect(detectDropZone(at(15, 50), tiny)).toBe('left');
    expect(detectDropZone(at(50, 50), tiny)).toBe('center'); // 30 < 50 < 70
    // 40×40 pane: floor(30) > 45%·40(=18) → cap wins, center sliver survives.
    const micro = bounds(40, 40);
    expect(detectDropZone(at(20, 20), micro)).toBe('center');
  });

  test('bounds offset is respected (clientX/Y are viewport coordinates)', () => {
    const off = { left: 1000, top: 500, width: 800, height: 600 };
    expect(detectDropZone(at(1400, 800), off)).toBe('center');
    expect(detectDropZone(at(1050, 800), off)).toBe('left');
  });

  test('wide-short cell: an off-center drop near the bottom stays bottom (not sideways)', () => {
    // Regression for the per-axis tie-break skew: on a 1600×250 cell
    // (depthX≈400, depthY≈62) a drop 30px above the bottom but 50px from the
    // right is ABSOLUTELY closer to the bottom — it used to resolve to 'right'
    // because left/right were normalized by the (much larger) depthX.
    const wide = bounds(1600, 250);
    expect(detectDropZone(at(1550, 220), wide)).toBe('bottom');
    // Symmetric on the left side, and the center box still wins in the middle.
    expect(detectDropZone(at(50, 220), wide)).toBe('bottom');
    expect(detectDropZone(at(800, 125), wide)).toBe('center');
  });

  test('tall-narrow cell: an off-center drop near the right stays right (not vertical)', () => {
    // The dual of the wide-short case: a 250×1600 cell (depthX≈62,
    // depthY≈400) drop 30px from the right but 50px from the top must be right.
    const tall = bounds(250, 1600);
    expect(detectDropZone(at(220, 50), tall)).toBe('right');
    expect(detectDropZone(at(220, 1550), tall)).toBe('right');
  });

  test('E2E contract: a point 5px from the left edge at mid-height is left', () => {
    // tab-system-reliability.spec.ts dispatches dragover at x+5, h/2 and
    // asserts the overlay zone is 'left' — the v2 geometry must keep that.
    expect(detectDropZone(at(5, 300), b)).toBe('left');
  });
});
