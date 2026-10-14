import { describe, expect, test } from 'bun:test';
import { loadOnReach } from './loadOnReach';

/**
 * The decisions of the "show more" row that loads by itself.
 *
 * @covers LIST-PAGE-01
 */
function scene() {
  let asks = 0;
  let looks = 0;
  const controller = loadOnReach(() => { asks++; }, () => { looks++; });
  return { controller, get asks() { return asks; }, get looks() { return looks; } };
}

describe('loadOnReach', () => {
  test('a row that enters the view asks for the next page once', () => {
    const s = scene();
    s.controller.settle({ more: true, loading: false, count: 25 });
    expect(s.asks).toBe(0);
    s.controller.seen(true);
    s.controller.seen(true); // the observer repeats itself
    expect(s.asks).toBe(1);
  });

  test('a page that lands asks for a fresh look, and only a row still in view asks again', () => {
    const s = scene();
    s.controller.settle({ more: true, loading: false, count: 20 });
    s.controller.seen(true);
    s.controller.settle({ more: true, loading: true, count: 20 });
    s.controller.seen(true);
    expect(s.asks).toBe(1);
    // The page lands: the old "in view" is stale, so nothing is asked until the observer looks again.
    s.controller.settle({ more: true, loading: false, count: 40 });
    expect(s.asks).toBe(1);
    expect(s.looks).toBe(1);
    s.controller.seen(true); // a short page: the row is still there
    expect(s.asks).toBe(2);
  });

  test('a page that pushes the row out of view asks for nothing more', () => {
    const s = scene();
    s.controller.settle({ more: true, loading: false, count: 25 });
    s.controller.seen(true);
    s.controller.settle({ more: true, loading: false, count: 50 });
    s.controller.settle({ more: true, loading: false, count: 50 }); // another render before the observer answers
    s.controller.seen(false);
    expect(s.asks).toBe(1);
    s.controller.seen(true); // the reader scrolls down to it again
    expect(s.asks).toBe(2);
  });

  test('an item that arrives while a page is on its way does not make the landing page ask on a stale answer', () => {
    const s = scene();
    s.controller.settle({ more: true, loading: false, count: 25 });
    s.controller.seen(true);
    s.controller.settle({ more: true, loading: true, count: 25 });
    s.controller.settle({ more: true, loading: true, count: 26 }); // a notification arrives on top meanwhile
    s.controller.seen(true); // the fresh look it asked for: still in view, but the page is in flight
    expect(s.asks).toBe(1);
    s.controller.settle({ more: true, loading: false, count: 51 }); // the page lands and pushes the row away
    expect(s.asks).toBe(1);
    expect(s.looks).toBe(2);
    s.controller.seen(false);
    expect(s.asks).toBe(1);
  });

  test('a page that added nothing (a failed load) waits for the reader to come back', () => {
    const s = scene();
    s.controller.settle({ more: true, loading: false, count: 20 });
    s.controller.seen(true);
    s.controller.settle({ more: true, loading: true, count: 20 });
    s.controller.settle({ more: true, loading: false, count: 20 });
    s.controller.settle({ more: true, loading: false, count: 20 });
    expect(s.asks).toBe(1);
    expect(s.looks).toBe(0);
    s.controller.seen(false);
    s.controller.seen(true);
    expect(s.asks).toBe(2);
  });

  test('an exhausted list, a row out of view, or a drag in progress ask for nothing', () => {
    const s = scene();
    s.controller.settle({ more: false, loading: false, count: 7 });
    s.controller.seen(true);
    expect(s.asks).toBe(0);
    s.controller.seen(false);
    s.controller.settle({ more: true, loading: false, count: 7 });
    expect(s.asks).toBe(0);
    s.controller.settle({ more: true, loading: false, count: 7, enabled: false });
    s.controller.seen(true);
    expect(s.asks).toBe(0);
    s.controller.settle({ more: true, loading: false, count: 7, enabled: true });
    expect(s.asks).toBe(1);
  });
});
