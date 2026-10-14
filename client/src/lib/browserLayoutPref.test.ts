import { describe, expect, test } from 'bun:test';
import { onBrowserLayoutStorage, readBrowserLayout, subscribeBrowserLayout } from './browserLayoutPref';

/** @covers BROWSER-DOM-LAYOUT-04 */
describe('the layout choice of this device', () => {
  test('another window of this device choosing reaches this one at once', () => {
    const g = globalThis as Record<string, unknown>;
    const had = 'localStorage' in g;
    const was = g.localStorage;
    g.localStorage = { getItem: (k: string) => (k === 'topics-browser-layout' ? 'page' : null), setItem: () => {} };
    let heard = 0;
    const stop = subscribeBrowserLayout(() => { heard++; });
    try {
      // What the browser tells this window when another one wrote the key.
      onBrowserLayoutStorage({ key: 'something-else' });
      expect(heard).toBe(0);
      onBrowserLayoutStorage({ key: 'topics-browser-layout' });
      expect(heard).toBe(1);
      expect(readBrowserLayout()).toBe('page');
    } finally {
      stop();
      if (had) g.localStorage = was;
      else delete g.localStorage;
      // Drops the cached choice, so the tests after this one read their own storage.
      onBrowserLayoutStorage({ key: 'topics-browser-layout' });
    }
  });
});
