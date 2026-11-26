/**
 * A lazy preview beside the soft edge asks to be loaded early.
 *
 * Chromium drops its lazy-load distance for a scroller under a mask, and the
 * row's fade is a mask, so `preloadBesideEdge` loads the image itself. The
 * browser part (that the image really loads) is proven by
 * tests/e2e/board-preview-cap.spec.ts; here only what the helper DECLARES: which
 * rows it acts in, how far it looks and in which direction, and that it lets go.
 *
 * @covers KANBAN-122
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { preloadBesideEdge } from './useScrollEdges';

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;

class FakeObserver {
  static made: FakeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;
  constructor(readonly callback: Callback, readonly options: { root: unknown; rootMargin: string }) { FakeObserver.made.push(this); }
  observe(target: unknown) { this.observed.push(target); }
  disconnect() { this.disconnected = true; }
}

const realObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  FakeObserver.made = [];
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => { globalThis.IntersectionObserver = realObserver; });

/** An image whose nearest soft-edge row is `row` (null = it sits outside any). */
const imageIn = (row: object | null) =>
  ({ loading: 'lazy', closest: (selector: string) => (selector === '.scroll-edge-fade' ? row : null) }) as unknown as HTMLImageElement;

describe('preloadBesideEdge', () => {
  test('outside a soft-edge row it does nothing: the browser keeps its own lazy loading', () => {
    expect(preloadBesideEdge(imageIn(null))).toBeUndefined();
    expect(FakeObserver.made).toHaveLength(0);
  });

  test('a detached ref (null) does nothing', () => {
    expect(preloadBesideEdge(null)).toBeUndefined();
    expect(FakeObserver.made).toHaveLength(0);
  });

  test('in a row it watches the image from the row, widened sideways and not vertically', () => {
    const row = {};
    const img = imageIn(row);
    preloadBesideEdge(img);
    const [observer] = FakeObserver.made;
    expect(observer.observed).toEqual([img]);
    expect(observer.options.root).toBe(row);
    // top/bottom 0: a card further down its column is the browser's to load.
    expect(observer.options.rootMargin).toBe('0px 1250px');
  });

  test('close enough starts the load (lazy to eager) once, then lets go', () => {
    const img = imageIn({});
    preloadBesideEdge(img);
    const [observer] = FakeObserver.made;
    observer.callback([{ isIntersecting: false }]);
    expect(img.loading).toBe('lazy');
    expect(observer.disconnected).toBe(false);
    observer.callback([{ isIntersecting: true }]);
    expect(img.loading).toBe('eager');
    expect(observer.disconnected).toBe(true);
  });

  test('its cleanup (the image unmounts first) disconnects the observer', () => {
    const cleanup = preloadBesideEdge(imageIn({}));
    expect(typeof cleanup).toBe('function');
    (cleanup as () => void)();
    expect(FakeObserver.made[0].disconnected).toBe(true);
  });
});
