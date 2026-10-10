import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { useLoadOnReach } from './useLoadOnReach';

/**
 * THE ROW LOOKS AGAIN AT WHAT SCROLLS IT, whenever the list moves to another scroller (#272).
 *
 * A board column turned list hands its "show more" row to another scroll container without a word from the
 * observers: the one on the old container may never speak again, or hold the row near forever. Four lists
 * watched the wrong container in the review of #272. There are two places that look again, and each one has
 * a case here that fails if it goes:
 *  - the switch itself (`layout` changes): going back from list to grid no observer sees anything;
 *  - an answer of the old observer, which checks that its root still is the row's scroller.
 *
 * No DOM in this project: the row, its scrollers, `getComputedStyle` and `IntersectionObserver` are the
 * smallest fakes the hook reads (`parentElement`, `overflowY`, root and callback), put back after each test.
 *
 * @covers LIST-PAGE-01
 */
interface FakeEl { name: string; overflowY: string; parentElement: FakeEl | null }
interface FakeIO { root: FakeEl | null | undefined; margin: string | undefined; fire: (isIntersecting: boolean) => void; disconnected: boolean }

const el = (name: string, overflowY: string, parentElement: FakeEl | null = null): FakeEl => ({ name, overflowY, parentElement });

const g = globalThis as unknown as Record<string, unknown>;
let saved: { io: unknown; cs: unknown };
let observers: FakeIO[];
let harness: Harness | null;

beforeEach(() => {
  saved = { io: g.IntersectionObserver, cs: g.getComputedStyle };
  observers = [];
  g.getComputedStyle = (e: FakeEl) => ({ overflowY: e.overflowY });
  g.IntersectionObserver = class {
    private readonly rec: FakeIO;
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void, opts?: { root?: FakeEl | null; rootMargin?: string }) {
      this.rec = { root: opts?.root, margin: opts?.rootMargin, disconnected: false, fire: (isIntersecting) => cb([{ isIntersecting }]) };
      observers.push(this.rec);
    }
    observe(): void {}
    disconnect(): void { this.rec.disconnected = true; }
  };
  harness = null;
});

afterEach(() => {
  harness?.unmount();
  // `= undefined` would leave the key behind, and a leftover DOM global is what the preload refuses.
  if (saved.io === undefined) delete g.IntersectionObserver; else g.IntersectionObserver = saved.io;
  if (saved.cs === undefined) delete g.getComputedStyle; else g.getComputedStyle = saved.cs;
});

/** Mounts the hook on a row inside `scroller`; `props.layout` is what the next `rerender` hands the hook. */
function scene() {
  const grid = el('column body', 'auto');
  const list = el('columns row', 'auto');
  const row = el('row', 'visible', grid);
  const props = { layout: 'grid', loads: 0 };
  let setRow: (e: unknown) => void = () => {};
  harness = mount(createElement(() => {
    setRow = useLoadOnReach(() => { props.loads++; }, { more: true, loading: false, count: 25 }, props.layout) as (e: unknown) => void;
    return null;
  }));
  setRow(row);
  /** The observers on the row's scroll root (the viewport one has no options). */
  const rootedAt = (root: FakeEl) => observers.filter((o) => o.root === root && !o.disconnected && o.margin !== undefined);
  return { grid, list, row, props, rootedAt, rerender: () => harness!.rerender() };
}

describe('useLoadOnReach looks again at the scroller', () => {
  test('a layout switch that moves the row to another scroller watches the new one', () => {
    const s = scene();
    expect(s.rootedAt(s.grid)).toHaveLength(1);

    s.row.parentElement = s.list; // the switch moved the scroll, not the row
    s.props.layout = 'list';
    s.rerender();

    expect(s.rootedAt(s.list), 'the observer is now on the scroller of the list').toHaveLength(1);
    expect(s.rootedAt(s.grid), 'and none is left on the old one').toHaveLength(0);
    expect(s.props.loads, 'looking again asks for nothing by itself').toBe(0);
  });

  test('an answer of the old observer after the row moved rebuilds the observers on the new scroller', () => {
    const s = scene();
    const old = s.rootedAt(s.grid)[0]!;

    s.row.parentElement = s.list; // no layout prop change: the old observer is the only one to notice
    old.fire(true);

    expect(s.rootedAt(s.list), 'the observer moved to the scroller that scrolls the row').toHaveLength(1);
    expect(old.disconnected, 'the old one is let go').toBe(true);
    expect(s.props.loads, 'an answer from the wrong container loads nothing').toBe(0);
  });
});
