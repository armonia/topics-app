/**
 * The two levels of the cleanup of closed browsers' data, resolved from what is
 * stored. This is the one place that decides which mode the reaper runs in, so
 * the defaults are pinned here, value by value:
 *
 *   level 1 (cache only):   off only on an explicit `false`; NULL = on
 *   level 2 (whole store):  on only on an explicit `true`; NULL = off
 *   `all` needs both; `off` wins whatever level 2 holds
 *
 * @covers BROWSER-STORE-REAP-03, BROWSER-STORE-REAP-07, BROWSER-STORE-REAP-08
 */
import { describe, expect, test } from 'bun:test';
import { resolveBrowserStoreReap } from './browser-store-reap';

describe('resolveBrowserStoreReap: mode', () => {
  test('nothing stored: the cache level, 60 days', () => {
    expect(resolveBrowserStoreReap({})).toEqual({ mode: 'cache', cacheEnabled: true, wholeEnabled: false, afterDays: 60 });
    expect(resolveBrowserStoreReap({
      browserStoreCacheReapEnabled: null,
      browserStoreReapEnabled: null,
      browserStoreReapAfterDays: null,
    }).mode).toBe('cache');
  });

  test('level 2 is on only for an explicit true', () => {
    for (const v of [null, undefined, false, 0, 1, 'true', 'on', {}]) {
      expect({ v, mode: resolveBrowserStoreReap({ browserStoreReapEnabled: v }).mode }).toEqual({ v, mode: 'cache' });
    }
    expect(resolveBrowserStoreReap({ browserStoreReapEnabled: true }).mode).toBe('all');
  });

  test('level 1 is off only for an explicit false', () => {
    for (const v of [null, undefined, true, 0, 'false', 'off']) {
      expect({ v, mode: resolveBrowserStoreReap({ browserStoreCacheReapEnabled: v }).mode }).toEqual({ v, mode: 'cache' });
    }
    expect(resolveBrowserStoreReap({ browserStoreCacheReapEnabled: false }).mode).toBe('off');
  });

  test('level 1 off wins over level 2 on: nothing is removed', () => {
    const r = resolveBrowserStoreReap({ browserStoreCacheReapEnabled: false, browserStoreReapEnabled: true });
    expect(r.mode).toBe('off');
    // What was chosen is still reported, so the panel can show it disabled.
    expect(r.wholeEnabled).toBe(true);
    expect(r.cacheEnabled).toBe(false);
  });

  test('both on: the whole store', () => {
    expect(resolveBrowserStoreReap({ browserStoreCacheReapEnabled: true, browserStoreReapEnabled: true }).mode).toBe('all');
  });
});

describe('resolveBrowserStoreReap: days', () => {
  test('a number is brought into 7..365 and rounded; anything else is 60', () => {
    const cases: Array<[unknown, number]> = [[3, 7], [400, 365], [14.4, 14], [90, 90], [null, 60], ['30', 60], [Number.NaN, 60]];
    for (const [stored, kept] of cases) {
      expect({ stored, kept: resolveBrowserStoreReap({ browserStoreReapAfterDays: stored }).afterDays }).toEqual({ stored, kept });
    }
  });
});
