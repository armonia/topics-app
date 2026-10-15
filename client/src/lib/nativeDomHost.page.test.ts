import { describe, expect, test } from 'bun:test';
import { armJs, createNativeDomHost, DRAIN_JS, inputJs } from './nativeDomHost';

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
      getAttribute: (attribute: string) => ((extra.attributes as Record<string, string> | undefined)?.[attribute] ?? null),
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
  const hooks: { emit?: (e: unknown) => void; options?: Record<string, unknown> } = {};
  const win: Record<string, unknown> = {
    innerWidth: 1000, innerHeight: 800,
    getComputedStyle: (e: { __style?: Record<string, string> } | null) => ({ position: 'static', overflowY: 'visible', overflowX: 'visible', ...e?.__style }),
  };
  doc.defaultView = win;
  class Ev { constructor(public type: string, public init: Record<string, unknown> = {}) {} }
  const run = (js: string) => new Function(
    'document', 'window', 'MouseEvent', 'WheelEvent', 'Event', 'KeyboardEvent', 'getComputedStyle', '__mirror', '__hooks',
    `return ${js}`,
  )(doc, win, Ev, Ev, Ev, Ev, win.getComputedStyle, mirror, hooks);
  run(armJs('var rrweb={record:function(o){__hooks.emit=o.emit;__hooks.options=o;return function(){}}};rrweb.record.mirror=__mirror;'));
  const host = win.__topicsDomHost as { q: Array<{ data: { anchor?: unknown } }> };
  return { log, root, body, el, run, hooks, host, win };
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

/**
 * Values marked for private entry stay out of the device mirror, while ordinary text remains visible.
 *
 * @covers BROWSER-DOM-MASK-01
 */
describe('private entry fields in a device mirror', () => {
  for (const purpose of ['cc-number', 'one-time-code', 'cc-csc']) {
    test(`${purpose} is masked in the initial snapshot and after typing`, () => {
      const w = world();
      const input = w.el('input', { top: 0, left: 0, width: 100, height: 20 }, w.body, 50, {
        attributes: { autocomplete: purpose },
      });
      const value = 'private-value';
      const snapshot = {
        type: 2,
        data: {
          node: {
            type: 2,
            tagName: 'input',
            id: 50,
            attributes: { autocomplete: purpose, value },
            childNodes: [],
          },
        },
      };

      w.hooks.emit!(snapshot);
      const change = { type: 3, data: { source: 5, id: 50, text: value } };
      w.hooks.emit!(change);
      expect([
        (snapshot.data.node as { attributes: { value: string } }).attributes.value,
        change.data.text,
      ]).toEqual(['*'.repeat(value.length), '*'.repeat(value.length)]);
      expect(input.getAttribute('autocomplete')).toBe(purpose);
    });
  }

  test('a card field mounted after the snapshot, or given its value as an attribute, is masked', () => {
    const w = world();
    w.el('input', { top: 0, left: 0, width: 100, height: 20 }, w.body, 52, {
      attributes: { autocomplete: 'cc-number' },
    });
    const value = '4111111111111111';
    const added = {
      type: 3,
      data: {
        source: 0, texts: [], removes: [], attributes: [] as unknown[],
        adds: [{ parentId: 2, nextId: null, node: { type: 2, tagName: 'input', id: 53, attributes: { autocomplete: 'cc-number', value }, childNodes: [] } }],
      },
    };
    const changed = {
      type: 3,
      data: { source: 0, texts: [], removes: [], adds: [] as unknown[], attributes: [{ id: 52, attributes: { value } }] },
    };
    w.hooks.emit!(added);
    w.hooks.emit!(changed);
    expect([
      added.data.adds[0].node.attributes.value,
      changed.data.attributes[0].attributes.value,
    ]).toEqual(['*'.repeat(value.length), '*'.repeat(value.length)]);
  });

  test('ordinary text remains visible in the initial snapshot and after typing', () => {
    const w = world();
    w.el('input', { top: 0, left: 0, width: 100, height: 20 }, w.body, 51, {
      attributes: { autocomplete: 'name' },
    });
    const value = 'Ada Lovelace';
    const snapshot = {
      type: 2,
      data: {
        node: {
          type: 2,
          tagName: 'input',
          id: 51,
          attributes: { autocomplete: 'name', value },
          childNodes: [],
        },
      },
    };

    w.hooks.emit!(snapshot);
    const change = { type: 3, data: { source: 5, id: 51, text: value } };
    w.hooks.emit!(change);
    expect([
      (snapshot.data.node as { attributes: { value: string } }).attributes.value,
      change.data.text,
    ]).toEqual([value, value]);
  });
});

describe('a scroll from a mirror laid out on its own', () => {
  const place = { id: 21, fx: 0.5, fy: 0.5, lx: 0.5, ly: 0.25, rx: 0, ry: 0.4 };

  test('what scrolled there does not scroll here: the page scrolls its element to the reading line', () => {
    const w = world();
    const main = w.el('main', { top: 0, left: 0, width: 1000, height: 4000 }, w.body, 20);
    w.el('row', { top: 1500, left: 0, width: 1000, height: 40 }, main, 21);
    // The viewer's main column scrolled: here the page scrolls that content.
    w.run(inputJs('scroll', { x: 500, y: 400, deltaY: 30, node: 20, anchor: { ...place, main: true } }));
    // 1500 + 20 into the row, on a line 200 down the 800 px window.
    expect(w.root.scrollTop).toBe(1320);
    expect(w.log).not.toContain('main cannot scroll');
    // The page's own scroll event says back the viewer's place.
    w.hooks.emit!({ type: 3, data: { source: 3, id: 1, x: 0, y: 1320 } });
    expect(w.host.q.at(-1)!.data.anchor).toEqual({ ...place, main: true });
  });

  test('a side panel the viewer scrolled, which this layout does not scroll, leaves the page where it is', () => {
    const w = world();
    const panel = w.el('aside', { top: 0, left: 700, width: 300, height: 4000 }, w.body, 20);
    w.el('row', { top: 1500, left: 700, width: 300, height: 40 }, panel, 21);
    w.run(inputJs('scroll', { x: 800, y: 400, deltaY: 30, node: 20, anchor: place }));
    expect(w.root.scrollTop).toBe(0);
    expect(w.log).not.toContain('aside cannot scroll');
  });

  test('the reading axis leads: a page that scrolls only sideways here hands its vertical place to the column that scrolls it', () => {
    const w = world();
    // Here the page has no height to scroll, and a drawer it clips gives it width.
    Object.assign(w.root, { scrollHeight: 800, scrollWidth: 1300 });
    Object.assign(w.body, { __style: { overflowX: 'hidden' } });
    const column = w.el('main', { top: 0, left: 0, width: 1000, height: 800 }, w.body, 20, {
      scrollHeight: 4000, clientLeft: 0, clientTop: 0, __style: { overflowY: 'auto' },
      scrollTo(o: { top: number }) { column.scrollTop = Math.max(0, Math.min(3200, Math.round(o.top))); },
    }) as unknown as { scrollTop: number };
    w.el('row', { top: 1500, left: 0, width: 1000, height: 40 }, column, 21, {
      getBoundingClientRect: () => ({ top: 1500 - column.scrollTop, left: 0, width: 1000, height: 40 }),
    });
    w.run(inputJs('scroll', { x: 500, y: 400, deltaY: 30, node: 1, anchor: { ...place, lx: 0.25 } }));
    expect(column.scrollTop).toBe(1320);
    expect(w.root.scrollTop).toBe(0);
  });

  test('the place goes to the nearest box that scrolls along the reading axis, past a code block that only scrolls sideways', () => {
    const w = world();
    const main = w.el('main', { top: 0, left: 0, width: 1000, height: 4000 }, w.body, 20);
    const code = w.el('pre', { top: 1480, left: 0, width: 1000, height: 80 }, main, 30, { scrollWidth: 3000, __style: { overflowX: 'auto' } });
    w.el('row', { top: 1500, left: 0, width: 1000, height: 40 }, code, 21);
    w.run(inputJs('scroll', { x: 500, y: 400, deltaY: 30, node: 20, anchor: { ...place, lx: 0.25, main: true } }));
    expect(w.root.scrollTop).toBe(1320);
    expect(w.log).not.toContain('pre cannot scroll');
  });

  test('an element pinned in place does not move this page: scrolling it would bring that element nowhere', () => {
    const w = world();
    const main = w.el('main', { top: 0, left: 0, width: 1000, height: 4000 }, w.body, 20);
    const panel = w.el('aside', { top: 0, left: 700, width: 300, height: 800 }, main, 30, { __style: { position: 'fixed' } });
    w.el('row', { top: 400, left: 700, width: 300, height: 40 }, panel, 21);
    w.run(inputJs('scroll', { x: 500, y: 400, deltaY: 30, node: 20, anchor: { ...place, main: true } }));
    expect(w.root.scrollTop).toBe(0);
  });

  test('a page whose overflow is hidden is not scrolled for a viewer: only its own script scrolls it', () => {
    const w = world();
    Object.assign(w.root, { __style: { overflowY: 'hidden' } });
    const main = w.el('main', { top: 0, left: 0, width: 1000, height: 4000 }, w.body, 20);
    w.el('row', { top: 1500, left: 0, width: 1000, height: 40 }, main, 21);
    w.run(inputJs('scroll', { x: 500, y: 400, deltaY: 30, node: 20, anchor: { ...place, main: true } }));
    expect(w.root.scrollTop).toBe(0);
  });

  test('a narrow column between a navigation and an aside is still the main one: it holds the middle of the window', () => {
    const w = world();
    w.el('nav', { top: 0, left: 0, width: 300, height: 800 }, w.body, 40);
    const column = w.el('main', { top: 0, left: 300, width: 400, height: 800 }, w.body, 20, {
      scrollHeight: 4000, clientLeft: 0, clientTop: 0, __style: { overflowY: 'auto' },
    });
    w.el('row', { top: 380, left: 300, width: 400, height: 40 }, column, 21);
    w.el('aside', { top: 0, left: 700, width: 300, height: 800 }, w.body, 41);
    w.hooks.emit!({ type: 3, data: { source: 3, id: 20, x: 0, y: 0 } });
    expect(w.host.q.at(-1)!.data.anchor).toMatchObject({ main: true });
  });

  test('at the end of the viewer\'s range the element still wins: this page does not jump to its own end', () => {
    const w = world();
    w.el('row', { top: 1500, left: 0, width: 1000, height: 40 }, w.body, 21);
    w.run(inputJs('scroll', { x: 500, y: 400, deltaY: 30, node: 1, anchor: { ...place, ry: 1 } }));
    expect(w.root.scrollTop).toBe(1320);
  });

  test('a strip scrolled sideways goes sideways here, to the same thumbnail, and the page stays', () => {
    const w = world();
    const strip = w.el('strip', { top: 700, left: 0, width: 1000, height: 80 }, w.body, 30, {
      scrollWidth: 6000, clientWidth: 1000, __style: { overflowX: 'auto' }, clientLeft: 0, clientTop: 0,
      scrollTo(o: { top: number; left: number }) { strip.scrollLeft = Math.max(0, Math.min(5000, Math.round(o.left))); },
    }) as unknown as { scrollLeft: number };
    // A thumbnail 3000 px into the strip's content.
    w.el('thumb', { top: 700, left: 3000, width: 100, height: 80 }, strip, 31, {
      getBoundingClientRect: () => ({ top: 700 - w.root.scrollTop, left: 3000 - strip.scrollLeft, width: 100, height: 80 }),
    });
    w.run(inputJs('scroll', { x: 500, y: 740, deltaX: 30, node: 30, anchor: { id: 31, fx: 0.5, fy: 0.5, lx: 0.25, ly: 0.5, rx: 0.5, ry: 0 } }));
    // Its middle on a line a quarter across the 1000 px strip: 3000 + 50 - 250.
    expect(strip.scrollLeft).toBe(2800);
    expect(w.root.scrollTop).toBe(0);
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

describe('the delegate socket accepts only delegate frame types', () => {
  test('the drained queue is parsed and rebuilt, never forwarded as text', async () => {
    const validEvent = { type: 4, timestamp: 10, data: { href: 'https://example.test', width: 800, height: 600 } };
    let node: Record<string, unknown> = { type: 3, textContent: 'leaf', id: 100 };
    for (let depth = 0; depth < 66; depth++) {
      node = { type: 2, tagName: 'div', attributes: {}, childNodes: [node], id: depth + 101 };
    }
    const snapshot = {
      type: 2,
      timestamp: 11,
      data: { node: { type: 0, childNodes: [{ type: 1, name: 'html', id: 1 }, node], id: 0 }, initialOffset: { left: 0, top: 0 } },
    };
    const hostText = JSON.stringify([
      validEvent,
      snapshot,
      { type: 4, timestamp: 12, data: { href: 'https://example.test', width: 800, height: 600 }, extra: 'discard' },
    ]);
    const pageWindow = { __topicsDomHost: { q: [validEvent] as unknown[] } };
    const jsonGlobal = { stringify: () => hostText };
    let scheduled: (() => void) | undefined;
    const sent: string[] = [];
    const host = createNativeDomHost({
      evalInPage: async (js) => {
        if (js.includes('window.__topicsDomHost=undefined')) {
          pageWindow.__topicsDomHost = undefined as never;
          return 'ok';
        }
        if (js.includes('window.__topicsDomHost={q:[]')) {
          pageWindow.__topicsDomHost = { q: [validEvent] };
          return 'armed';
        }
        if (js === DRAIN_JS) return new Function('window', 'JSON', `return ${js}`)(pageWindow, jsonGlobal) as string;
        return 'ok';
      },
      loadRecorder: async () => 'var rrweb={record:function(){}};',
      sendText: (text) => sent.push(text),
      navigate: () => {},
      schedule: (fn) => { scheduled = fn; return () => { scheduled = undefined; }; },
    });

    host.handle({ type: 'host_dom_start' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frames = sent.map((text) => JSON.parse(text) as { type: string; events?: unknown[] });
    expect(frames).toHaveLength(1);
    const forwarded = frames.find((frame) => frame.type === 'host_dom_events')?.events;
    expect(forwarded).toHaveLength(2);
    expect(forwarded?.[1]).toEqual({ type: 2, timestamp: 11, data: snapshot.data });
  });

  test('arming replaces an existing host and leaves one recorder active', () => {
    const w = world();
    const counters = { activeRecorders: 1 };
    (w.hooks as unknown as { counters: typeof counters }).counters = counters;
    const existingHost = {
      q: [{ type: 4, timestamp: 1, data: { href: 'https://example.test', width: 1, height: 1 } }],
      stop: () => { counters.activeRecorders--; },
    };
    w.win.__topicsDomHost = existingHost;
    const bundle = 'var rrweb={record:function(o){__hooks.emit=o.emit;__hooks.counters.activeRecorders++;return function(){__hooks.counters.activeRecorders--;}}};rrweb.record.mirror=__mirror;';

    w.run(armJs(bundle));
    w.run(armJs(bundle));

    expect(w.win.__topicsDomHost).not.toBe(existingHost);
    expect((w.win.__topicsDomHost as { q: unknown[] }).q).toEqual([]);
    expect(counters.activeRecorders).toBe(1);
  });

  test('two arms while the document is still loading leave one recorder active', () => {
    const w = world();
    const doc = (w.body as unknown as {
      ownerDocument: { readyState: string; addEventListener: (type: string, fn: () => void) => void };
    }).ownerDocument;
    const ready: Array<() => void> = [];
    doc.readyState = 'loading';
    doc.addEventListener = (type, fn) => { if (type === 'DOMContentLoaded') ready.push(fn); };
    const counters = { activeRecorders: 0 };
    (w.hooks as unknown as { counters: typeof counters }).counters = counters;
    const bundle = 'var rrweb={record:function(o){__hooks.emit=o.emit;__hooks.counters.activeRecorders++;return function(){__hooks.counters.activeRecorders--;}}};rrweb.record.mirror=__mirror;';

    w.run(armJs(bundle));
    w.run(armJs(bundle));
    for (const start of ready) start();

    expect(counters.activeRecorders).toBe(1);
  });
});
