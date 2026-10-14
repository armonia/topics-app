import { describe, expect, test } from 'bun:test';
import { anchorOf, forOwnLayout, placeOf, sameAnchor, type NodeIds } from './mirrorLayout';

/**
 * A page scrolled by its document: 1000 px of content in a 200 px window, and
 * one element, the row the anchors name, `rowTop` px down the content.
 */
function page(scrollTop: number, rowTop = 500) {
  const root = {
    nodeType: 1, scrollTop, scrollLeft: 0, scrollHeight: 1000, clientHeight: 200, scrollWidth: 400, clientWidth: 400,
  };
  const doc = {
    nodeType: 9, scrollingElement: root, documentElement: root, body: {},
    defaultView: { innerWidth: 400, innerHeight: 200, getComputedStyle: () => ({ position: 'static' }) },
    elementsFromPoint: () => [row],
  };
  const row = {
    nodeType: 1, isConnected: true, ownerDocument: doc, parentElement: null,
    getBoundingClientRect: () => ({ top: rowTop - root.scrollTop, left: 0, width: 400, height: 40 }),
  };
  const ids: NodeIds = {
    getId: (n) => (n === (row as unknown as Node) ? 7 : n === (doc as unknown as Node) ? 1 : -1),
    getNode: (id) => (id === 7 ? (row as unknown as Node) : id === 1 ? (doc as unknown as Node) : null),
  };
  return { doc: doc as unknown as Document, root, ids };
}

/** @covers BROWSER-DOM-LAYOUT-03 */
describe('placeOf', () => {
  test('puts the named point of the element on the reading line, a quarter down', () => {
    const { doc, ids } = page(100);
    // A quarter into the row, on a line 50 px down the 200 px window: 500 + 10 - 50.
    expect(placeOf(doc, { id: 7, fx: 0.5, fy: 0.25, lx: 0.5, ly: 0.25, rx: 0, ry: 0.5 }, ids)).toEqual({ top: 460, left: 0 });
  });

  test('at an edge the edge wins over the element: the top is the top on both sides', () => {
    const { doc, ids } = page(100);
    expect(placeOf(doc, { id: 7, fx: 0.5, fy: 0.25, lx: 0.5, ly: 0.25, rx: 0, ry: 0 }, ids)!.top).toBe(0);
    expect(placeOf(doc, { id: 7, fx: 0.5, fy: 0.25, lx: 0.5, ly: 0.25, rx: 0, ry: 1 }, ids)!.top).toBe(800);
  });

  test('by its range when the element is not here', () => {
    const { doc, ids } = page(100);
    expect(placeOf(doc, { id: 99, fx: 0.5, fy: 0.25, lx: 0.5, ly: 0.25, rx: 0, ry: 0.25 }, ids)!.top).toBe(200);
  });
});

/** @covers BROWSER-DOM-LAYOUT-03 */
describe('anchorOf', () => {
  test('names the element at the reading line and the point of it there', () => {
    const { doc, ids } = page(470);
    // Line at 470 + 50 = 520 in the content: 20 px into the 40 px row.
    expect(anchorOf(doc, ids)).toEqual({ id: 7, fx: 0.5, fy: 0.5, lx: 0.5, ly: 0.25, rx: 0, ry: 470 / 800 });
  });

  test('an edge is exactly 0 or 1, within the pixel a fractional scroll stops short of the end', () => {
    expect(anchorOf(page(0).doc, page(0).ids)!.ry).toBe(0);
    expect(anchorOf(page(799.5).doc, page(799.5).ids)!.ry).toBe(1);
  });
});

/** @covers BROWSER-DOM-LAYOUT-03 */
describe('sameAnchor', () => {
  const a = { id: 7, fx: 0.5, fy: 0.25, lx: 0.5, ly: 0.25, rx: 0, ry: 0.5 };
  test('the Mac sends a viewer its own place back unchanged, and that alone confirms it', () => {
    expect(sameAnchor(a, { ...a })).toBe(true);
    expect(sameAnchor(a, { ...a, fy: 0.26 })).toBe(false);
    expect(sameAnchor(a, { ...a, id: 8 })).toBe(false);
    expect(sameAnchor(a, undefined)).toBe(false);
  });
});

/** @covers BROWSER-DOM-LAYOUT-03 */
describe('forOwnLayout', () => {
  const anchor = { id: 7, fx: 0.5, fy: 0.25, lx: 0.5, ly: 0.25, rx: 0, ry: 0.5 };
  test('keeps a scroll that names its place from the replayer, and remembers what scrolled', () => {
    const out = forOwnLayout({ type: 3, data: { source: 3, id: 1, anchor } });
    expect(out.data as Record<string, unknown>).toEqual({ source: 3, id: -1, anchored: 1, anchor });
  });

  test('a snapshot starts at the top, its place applied after it', () => {
    const out = forOwnLayout({ type: 2, data: { node: { id: 1 }, anchor, initialOffset: { top: 640, left: 0 } } as never });
    expect(out.data).toMatchObject({ anchored: 1, initialOffset: { top: 0, left: 0 } });
  });

  test('an event without a place is left alone', () => {
    const event = { type: 3, data: { source: 3, id: 1 } };
    expect(forOwnLayout(event)).toBe(event);
  });
});
