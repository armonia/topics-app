import { describe, expect, test } from 'bun:test';
import { armJs, inputJs } from './nativeDomHost';

/**
 * The host's page side (INPUT_FN, LAYOUT_JS) run against a small page with
 * geometry: the strings the Mac evaluates, not a copy of their logic.
 *
 * @covers BROWSER-DOM-LAYOUT-02
 * @covers BROWSER-DOM-LAYOUT-03
 */

interface Box { top: number; left: number; width: number; height: number }

function world() {
  const log: string[] = [];
  const nodes = new Map<number, object>();
  const ids = new Map<object, number>();
  const root = {
    nodeType: 1, tagName: 'HTML', parentElement: null as unknown, isConnected: true, tabIndex: -1,
    scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 800, scrollWidth: 1000, clientWidth: 1000,
    getBoundingClientRect: () => ({ top: -root.scrollTop, left: 0, width: 1000, height: 4000 }),
    contains: (o: { parentElement?: unknown }) => { for (let m: unknown = o; m; m = (m as { parentElement?: unknown }).parentElement) if (m === root) return true; return false; },
    scrollTo: (o: { top: number; left: number }) => { root.scrollTop = Math.max(0, Math.min(3200, Math.round(o.top))); root.scrollLeft = 0; },
    dispatchEvent: (e: { type: string }) => { log.push(`html <- ${e.type}`); return true; },
  };
  const els: Array<{ name: string; box: Box; parentElement: unknown }> = [];
  const doc = {
    nodeType: 9, readyState: 'complete', scrollingElement: root, documentElement: root, body: undefined as unknown,
    activeElement: undefined as unknown,
    defaultView: undefined as unknown,
    elementFromPoint: (x: number, y: number) => hits(x, y)[0] ?? doc.body,
    elementsFromPoint: (x: number, y: number) => [...hits(x, y), doc.body, root],
    dispatchEvent: (e: { type: string }) => { log.push(`document <- ${e.type}`); return true; },
    addEventListener: () => {},
  };
  /** An element at `box` in the document, scrolled with it; `id` is what the recorder calls it. */
  const el = (name: string, box: Box, parent: unknown, id?: number, extra: Record<string, unknown> = {}) => {
    const e = {
      name, box, parentElement: parent, nodeType: 1, tagName: name.toUpperCase().replace(/-.*/, ''), isConnected: true, tabIndex: -1,
      ownerDocument: doc, scrollTop: 0, scrollLeft: 0, scrollHeight: box.height, clientHeight: box.height, scrollWidth: box.width, clientWidth: box.width,
      getBoundingClientRect: () => ({ top: box.top - root.scrollTop, left: box.left, width: box.width, height: box.height }),
      contains: (o: { parentElement?: unknown }) => { for (let m: unknown = o; m; m = (m as { parentElement?: unknown }).parentElement) if (m === e) return true; return false; },
      scrollTo: () => { log.push(`${name} cannot scroll`); },
      dispatchEvent: (ev: { type: string }) => { log.push(`${name} <- ${ev.type}`); return true; },
      ...extra,
    };
    els.push(e);
    if (id !== undefined) { nodes.set(id, e); ids.set(e, id); }
    return e;
  };
  function hits(x: number, y: number) {
    const depth = (e: unknown) => { let d = 0; for (let m = e; m; m = (m as { parentElement?: unknown }).parentElement) d++; return d; };
    return els.filter((e) => {
      const r = { top: e.box.top - root.scrollTop, left: e.box.left };
      return x >= r.left && x < r.left + e.box.width && y >= r.top && y < r.top + e.box.height;
    }).sort((a, b) => depth(b) - depth(a));
  }
  const body = el('body', { top: 0, left: 0, width: 1000, height: 4000 }, root, 3);
  doc.body = body;
  doc.activeElement = body;
  nodes.set(1, doc); ids.set(doc, 1);
  nodes.set(2, root); ids.set(root, 2);
  const mirror = { getNode: (id: number) => nodes.get(id) ?? null, getId: (n: object) => ids.get(n) ?? -1 };
  const hooks: { emit?: (e: unknown) => void } = {};
  const win: Record<string, unknown> = {
    innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({ position: 'static', overflowY: 'visible', overflowX: 'visible' }),
  };
  doc.defaultView = win;
  class Ev { constructor(public type: string, public init: Record<string, unknown> = {}) {} }
  const run = (js: string) => new Function(
    'document', 'window', 'MouseEvent', 'WheelEvent', 'Event', 'KeyboardEvent', 'getComputedStyle', '__mirror', '__hooks',
    `return ${js}`,
  )(doc, win, Ev, Ev, Ev, Ev, win.getComputedStyle, mirror, hooks);
  run(armJs('var rrweb={record:function(o){__hooks.emit=o.emit;return function(){}}};rrweb.record.mirror=__mirror;'));
  const host = win.__topicsDomHost as { q: Array<{ data: { anchor?: unknown } }> };
  return { log, root, body, el, run, hooks, host };
}

describe('a tap from a mirror laid out on its own', () => {
  test('lands on the element it names, not on what this layout draws there inside it', () => {
    const w = world();
    const p = w.el('p', { top: 100, left: 0, width: 600, height: 60 }, w.body, 10);
    // Here the paragraph wraps differently: a link sits where the tap's point is.
    w.el('a-link', { top: 120, left: 150, width: 100, height: 20 }, p, 11);
    expect(w.run(inputJs('click', { x: 40, y: 400, node: 10, fx: 0.3, fy: 0.5 }))).toBe('ok');
    expect(w.log).toContain('p <- click');
    expect(w.log.some((l) => l.startsWith('a-link'))).toBe(false);
  });

  test('an element the page no longer has is not traded for what sits at the mirror\'s pixel', () => {
    const w = world();
    w.el('a-delete', { top: 380, left: 0, width: 200, height: 40 }, w.body, 12);
    expect(w.run(inputJs('click', { x: 40, y: 400, node: 99, fx: 0.5, fy: 0.5 }))).toBe('gone');
    expect(w.log).toEqual([]);
  });

  test('a tap that names nothing, from a mirror with the page\'s own layout, lands at its pixel', () => {
    const w = world();
    w.el('button', { top: 380, left: 0, width: 200, height: 40 }, w.body, 13);
    w.run(inputJs('click', { x: 40, y: 400 }));
    expect(w.log).toContain('button <- click');
  });
});

describe('a scroll from a mirror laid out on its own', () => {
  const place = { id: 21, fx: 0.5, fy: 0.5, lx: 0.5, ly: 0.25, rx: 0, ry: 0.4 };

  test('what scrolled there does not scroll here: the page scrolls its element to the reading line', () => {
    const w = world();
    const main = w.el('main', { top: 0, left: 0, width: 1000, height: 4000 }, w.body, 20);
    w.el('row', { top: 1500, left: 0, width: 1000, height: 40 }, main, 21);
    w.run(inputJs('scroll', { x: 500, y: 400, deltaY: 30, node: 20, anchor: place }));
    // 1500 + 20 into the row, on a line 200 down the 800 px window.
    expect(w.root.scrollTop).toBe(1320);
    expect(w.log).not.toContain('main cannot scroll');
    // The page's own scroll event says back the viewer's place.
    w.hooks.emit!({ type: 3, data: { source: 3, id: 1, x: 0, y: 1320 } });
    expect(w.host.q.at(-1)!.data.anchor).toEqual(place);
  });

  test('once the page moves away from that place it is forgotten, even back on the same pixel', () => {
    const w = world();
    w.el('row', { top: 1500, left: 0, width: 1000, height: 40 }, w.body, 21);
    w.run(inputJs('scroll', { x: 500, y: 400, deltaY: 30, node: 1, anchor: place }));
    w.root.scrollTop = 1400;
    w.hooks.emit!({ type: 3, data: { source: 3, id: 1, x: 0, y: 1400 } });
    w.root.scrollTop = 1320;
    w.hooks.emit!({ type: 3, data: { source: 3, id: 1, x: 0, y: 1320 } });
    expect(w.host.q.at(-1)!.data.anchor).not.toEqual(place);
  });
});
