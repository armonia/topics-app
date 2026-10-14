import { describe, expect, test } from 'bun:test';
import { anchorOf, forOwnLayout, placeOf, sameAnchor, type NodeIds } from './mirrorLayout';

/**
 * A page scrolled by its document: 1000 px of content in a 200 px window, and
 * one element, the row the anchors name, `rowTop` px down the content.
 * `styles` gives an element its overflow; `inner` makes a box of the page.
 */
function page(scrollTop: number, rowTop = 500) {
  const root = {
    nodeType: 1, scrollTop, scrollLeft: 0, scrollHeight: 1000, clientHeight: 200, scrollWidth: 400, clientWidth: 400,
  };
  const styles = new Map<unknown, Record<string, string>>();
  const doc = {
    nodeType: 9, scrollingElement: root, documentElement: root, body: {},
    defaultView: {
      innerWidth: 400, innerHeight: 200,
      getComputedStyle: (el: unknown) => ({ position: 'static', overflowX: 'visible', overflowY: 'visible', ...styles.get(el) }),
    },
    elementsFromPoint: () => [row],
  };
  const row = {
    nodeType: 1, isConnected: true, ownerDocument: doc, parentElement: null as unknown,
    getBoundingClientRect: () => ({ top: rowTop - root.scrollTop, left: 0, width: 400, height: 40 }),
  };
  const known = new Map<number, unknown>([[1, doc], [7, row]]);
  const ids: NodeIds = {
    getId: (n) => { for (const [id, k] of known) if (k === n) return id; return -1; },
    getNode: (id) => (known.get(id) as Node | undefined) ?? null,
  };
  /** A box of the page, `rect` where it shows, scrolled `scroll` of its `content`, around `children`. */
  const inner = (id: number, rect: { top: number; left: number; width: number; height: number }, content: { width: number; height: number }, children: unknown[] = []) => {
    const el = {
      nodeType: 1, isConnected: true, ownerDocument: doc, parentElement: null as unknown, scrollTop: 0, scrollLeft: 0, clientTop: 0, clientLeft: 0,
      scrollWidth: content.width, scrollHeight: content.height, clientWidth: rect.width, clientHeight: rect.height,
      getBoundingClientRect: () => ({ ...rect, top: rect.top - root.scrollTop }),
      contains: (o: unknown) => o === el || children.includes(o),
    };
    for (const c of children) (c as { parentElement: unknown }).parentElement = el;
    known.set(id, el);
    return el;
  };
  return { doc: doc as unknown as Document, root, row, ids, styles, inner, known };
}

/** @covers BROWSER-DOM-LAYOUT-03 */
describe('placeOf', () => {
  const at = { id: 7, fx: 0.5, fy: 0.25, lx: 0.5, ly: 0.25, rx: 0, ry: 0.5 };

  test('puts the named point of the element on the reading line, a quarter down, and leaves the other axis alone', () => {
    const { doc, ids } = page(100);
    // A quarter into the row, on a line 50 px down the 200 px window: 500 + 10 - 50.
    const place = placeOf(doc, at, ids)!;
    expect(place.top).toBe(460);
    expect(place.left).toBeUndefined();
  });

  test('the main column that scrolled there and cannot scroll here hands the place to what scrolls its content here', () => {
    const { doc, root, row, ids, inner } = page(100);
    // On the other side it scrolled; here it is as tall as its content.
    const column = inner(20, { top: 0, left: 0, width: 400, height: 1000 }, { width: 400, height: 1000 }, [row]);
    const place = placeOf(column as unknown as Node, { ...at, main: true }, ids)!;
    expect(place.el).toBe(root as unknown as Element);
    expect(place.top).toBe(460);
    void doc;
  });

  test('a strip or a side panel that scrolled there and cannot scroll here moves nothing here', () => {
    const { row, ids, inner } = page(100);
    const panel = inner(20, { top: 0, left: 300, width: 100, height: 1000 }, { width: 100, height: 1000 }, [row]);
    expect(placeOf(panel as unknown as Node, at, ids)).toBeNull();
  });

  test('a box the page clips is never handed a place: only its own script scrolls it', () => {
    const { root, row, ids, inner, styles } = page(100);
    const clip = inner(30, { top: 0, left: 0, width: 400, height: 200 }, { width: 400, height: 1000 }, [row]);
    styles.set(clip, { overflowY: 'hidden' });
    const column = inner(20, { top: 0, left: 0, width: 400, height: 1000 }, { width: 400, height: 1000 });
    const place = placeOf(column as unknown as Node, { ...at, main: true }, ids)!;
    expect(place.el).toBe(root as unknown as Element);
  });

  test('at the start the start wins over the element: the top is the top on both sides', () => {
    const { doc, ids } = page(100);
    expect(placeOf(doc, { ...at, ry: 0 }, ids)!.top).toBe(0);
  });

  test('at the end the element wins: a longer page here does not jump to its own end', () => {
    const { doc, ids } = page(100);
    expect(placeOf(doc, { ...at, ry: 1 }, ids)!.top).toBe(460);
  });

  test('by its range when the element is not here', () => {
    const { doc, ids } = page(100);
    expect(placeOf(doc, { ...at, id: 99, ry: 0.25 }, ids)!.top).toBe(200);
  });

  test('a strip scrolled sideways there scrolls sideways here, to the same element, and the page stays', () => {
    const { ids, inner, styles, known } = page(100);
    // A thumbnail 1000 px into a strip that shows 400 px of its 2000.
    const thumb = { nodeType: 1, isConnected: true, parentElement: null as unknown, ownerDocument: undefined as unknown,
      getBoundingClientRect: () => ({ top: 100, left: 1000 - strip.scrollLeft, width: 100, height: 80 }) };
    const strip = inner(8, { top: 200, left: 0, width: 400, height: 80 }, { width: 2000, height: 80 }, [thumb]);
    thumb.ownerDocument = strip.ownerDocument;
    known.set(9, thumb);
    styles.set(strip, { overflowX: 'auto' });
    // Its reading line a quarter across, the middle down: it scrolls sideways only.
    const place = placeOf(strip as unknown as Node, { id: 9, fx: 0.5, fy: 0.5, lx: 0.25, ly: 0.5, rx: 0.5, ry: 0 }, ids)!;
    expect(place.el).toBe(strip as unknown as Element);
    expect(place.left).toBe(1000 + 50 - 100);
    expect(place.top).toBeUndefined();
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

  test('says when what scrolled is the main column, never for a strip or the page itself', () => {
    const { doc, ids, inner } = page(0);
    expect(anchorOf(doc, ids)!.main).toBeUndefined();
    const column = inner(20, { top: 0, left: 0, width: 400, height: 200 }, { width: 400, height: 1000 });
    expect(anchorOf(column as unknown as Node, ids)!.main).toBe(true);
    const strip = inner(8, { top: 120, left: 0, width: 400, height: 80 }, { width: 2000, height: 80 });
    expect(anchorOf(strip as unknown as Node, ids)!.main).toBeUndefined();
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
