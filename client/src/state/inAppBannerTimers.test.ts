/**
 * THREE BANNERS, THREE CLOCKS.
 *
 * The defect this locks down: the expiry effect depended on the whole array, so
 * every new signal cancelled the timers already running and re-armed them with
 * the full TTL. Three banners arriving at t=0/3/6 all died at t=14 instead of
 * 8/11/14, and an eight-second banner could stay on screen forever as long as
 * others kept arriving.
 *
 * @covers PRESENCE-14
 */
import { describe, expect, test } from 'bun:test';
import { syncBannerTimers, clearBannerTimers, type BannerTimerApi, type TimedBanner } from './inAppBannerTimers';
import { MAX_IN_APP_BANNERS, useInAppBannerStore } from './inAppBanner';

/** A clock we drive by hand: no DOM, no waiting, and the arming is observable. */
function fakeTimers() {
  const pending = new Map<number, { fire: () => void; at: number }>();
  const armed: number[] = [];
  const cleared: number[] = [];
  let now = 0;
  let nextHandle = 1;
  const api: BannerTimerApi = {
    set(fn, ms) {
      const handle = nextHandle++;
      pending.set(handle, { fire: fn, at: now + ms });
      armed.push(handle);
      return handle;
    },
    clear(handle) {
      pending.delete(handle);
      cleared.push(handle);
    },
  };
  return {
    api,
    armed,
    cleared,
    advance(ms: number) {
      now += ms;
      for (const [handle, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(handle);
          entry.fire();
        }
      }
    },
  };
}

const banner = (id: string, shownAt: number): TimedBanner => ({ id, shownAt });

describe('syncBannerTimers', () => {
  test('un banner che arriva dopo NON rimette in vita quelli già in corsa', () => {
    const clock = fakeTimers();
    const handles = new Map<string, number>();
    const expired: string[] = [];
    const ttlMs = 8000;
    const opts = { ttlMs, onExpire: (id: string) => expired.push(id), timers: clock.api };

    let banners = [banner('a', 1)];
    syncBannerTimers(banners, handles, opts);
    clock.advance(3000);
    banners = [...banners, banner('b', 2)];
    syncBannerTimers(banners, handles, opts);
    clock.advance(3000);
    banners = [...banners, banner('c', 3)];
    syncBannerTimers(banners, handles, opts);

    // Nothing was cancelled to make room for the newcomers.
    expect(clock.cleared).toEqual([]);
    expect(clock.armed).toHaveLength(3);

    clock.advance(2000); // t = 8s
    expect(expired).toEqual(['a']);
    clock.advance(3000); // t = 11s
    expect(expired).toEqual(['a', 'b']);
    clock.advance(3000); // t = 14s
    expect(expired).toEqual(['a', 'b', 'c']);
  });

  test('lo stesso tag mostrato di nuovo riparte da capo, e il vecchio timer muore', () => {
    const clock = fakeTimers();
    const handles = new Map<string, number>();
    const expired: string[] = [];
    const opts = { ttlMs: 8000, onExpire: (id: string) => expired.push(id), timers: clock.api };

    syncBannerTimers([banner('a', 1)], handles, opts);
    clock.advance(7000);
    syncBannerTimers([banner('a', 2)], handles, opts);
    expect(clock.cleared).toHaveLength(1);

    clock.advance(2000); // 9s from the first show, 2s from the second
    expect(expired).toEqual([]);
    clock.advance(6000);
    expect(expired).toEqual(['a']);
  });

  test('un banner chiuso a mano non lascia un timer che scatta a vuoto', () => {
    const clock = fakeTimers();
    const handles = new Map<string, number>();
    const expired: string[] = [];
    const opts = { ttlMs: 8000, onExpire: (id: string) => expired.push(id), timers: clock.api };

    syncBannerTimers([banner('a', 1), banner('b', 2)], handles, opts);
    syncBannerTimers([banner('b', 2)], handles, opts);
    clock.advance(9000);
    expect(expired).toEqual(['b']);
    expect(handles.size).toBe(0);
  });

  test('smontando la pagina non resta niente a ticchettare', () => {
    const clock = fakeTimers();
    const handles = new Map<string, number>();
    const expired: string[] = [];
    syncBannerTimers([banner('a', 1), banner('b', 2)], handles, {
      ttlMs: 8000,
      onExpire: (id: string) => expired.push(id),
      timers: clock.api,
    });
    clearBannerTimers(handles, clock.api);
    clock.advance(20000);
    expect(expired).toEqual([]);
    expect(handles.size).toBe(0);
  });
});

describe('la lista ha un tetto', () => {
  test(`oltre ${MAX_IN_APP_BANNERS} restano i più recenti`, () => {
    useInAppBannerStore.setState({ banners: [] });
    const { showInAppBanner } = useInAppBannerStore.getState();
    for (let i = 0; i < MAX_IN_APP_BANNERS + 3; i++) showInAppBanner({ id: `t-${i}`, title: `${i}`, body: '' });
    const ids = useInAppBannerStore.getState().banners.map((b) => b.id);
    expect(ids).toHaveLength(MAX_IN_APP_BANNERS);
    expect(ids[ids.length - 1]).toBe(`t-${MAX_IN_APP_BANNERS + 2}`);
  });

  test('ogni show ha il suo istante, anche due nello stesso millisecondo', () => {
    useInAppBannerStore.setState({ banners: [] });
    const { showInAppBanner } = useInAppBannerStore.getState();
    showInAppBanner({ id: 'a', title: 'A', body: '' });
    showInAppBanner({ id: 'b', title: 'B', body: '' });
    const [first, second] = useInAppBannerStore.getState().banners;
    expect(second.shownAt).toBeGreaterThan(first.shownAt);
  });
});
