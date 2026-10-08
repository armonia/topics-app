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
  const ctl = loadOnReach(() => { asks++; }, () => { looks++; });
  return { ctl, get asks() { return asks; }, get looks() { return looks; } };
}

describe('loadOnReach', () => {
  test('a row that enters the view asks for the next page once', () => {
    const s = scene();
    s.ctl.settle({ more: true, loading: false, count: 25 });
    expect(s.asks).toBe(0);
    s.ctl.seen(true);
    s.ctl.seen(true); // the observer repeats itself
    expect(s.asks).toBe(1);
  });

  test('a page that lands asks for a fresh look, and only a row still in view asks again', () => {
    const s = scene();
    s.ctl.settle({ more: true, loading: false, count: 20 });
    s.ctl.seen(true);
    s.ctl.settle({ more: true, loading: true, count: 20 });
    s.ctl.seen(true);
    expect(s.asks).toBe(1);
    // The page lands: the old "in view" is stale, so nothing is asked until the observer looks again.
    s.ctl.settle({ more: true, loading: false, count: 40 });
    expect(s.asks).toBe(1);
    expect(s.looks).toBe(1);
    s.ctl.seen(true); // a short page: the row is still there
    expect(s.asks).toBe(2);
  });

  test('a page that pushes the row out of view asks for nothing more', () => {
    const s = scene();
    s.ctl.settle({ more: true, loading: false, count: 25 });
    s.ctl.seen(true);
    s.ctl.settle({ more: true, loading: false, count: 50 });
    s.ctl.settle({ more: true, loading: false, count: 50 }); // another render before the observer answers
    s.ctl.seen(false);
    expect(s.asks).toBe(1);
    s.ctl.seen(true); // the reader scrolls down to it again
    expect(s.asks).toBe(2);
  });

  test('a page that added nothing (a failed load) waits for the reader to come back', () => {
    const s = scene();
    s.ctl.settle({ more: true, loading: false, count: 20 });
    s.ctl.seen(true);
    s.ctl.settle({ more: true, loading: true, count: 20 });
    s.ctl.settle({ more: true, loading: false, count: 20 });
    s.ctl.settle({ more: true, loading: false, count: 20 });
    expect(s.asks).toBe(1);
    expect(s.looks).toBe(0);
    s.ctl.seen(false);
    s.ctl.seen(true);
    expect(s.asks).toBe(2);
  });

  test('an exhausted list, a row out of view, or a drag in progress ask for nothing', () => {
    const s = scene();
    s.ctl.settle({ more: false, loading: false, count: 7 });
    s.ctl.seen(true);
    expect(s.asks).toBe(0);
    s.ctl.seen(false);
    s.ctl.settle({ more: true, loading: false, count: 7 });
    expect(s.asks).toBe(0);
    s.ctl.settle({ more: true, loading: false, count: 7, enabled: false });
    s.ctl.seen(true);
    expect(s.asks).toBe(0);
    s.ctl.settle({ more: true, loading: false, count: 7, enabled: true });
    expect(s.asks).toBe(1);
  });
});
