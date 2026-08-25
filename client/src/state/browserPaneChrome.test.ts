/**
 * @covers BROWSER-STATE-03
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  publishBrowserPaneChrome,
  retireBrowserPaneChrome,
  getBrowserPaneChrome,
  __resetBrowserPaneChrome,
  type BrowserPaneChrome,
} from './browserPaneChrome';

function chrome(url: string, over: Partial<BrowserPaneChrome> = {}): BrowserPaneChrome {
  return {
    url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    consoleErrors: 0,
    consoleWarnings: 0,
    downloads: 0,
    zoom: 100,
    deviceMode: 'desktop',
    shared: false,
    commands: {},
    ...over,
  };
}

describe('browserPaneChrome', () => {
  beforeEach(() => { __resetBrowserPaneChrome(); });

  it('a pane publishes, its tab reads', () => {
    publishBrowserPaneChrome('browser:a', chrome('https://example.com'));
    expect(getBrowserPaneChrome('browser:a')?.url).toBe('https://example.com');
  });

  it('a tab whose panel never mounted reads nothing, and that is not an error', () => {
    expect(getBrowserPaneChrome('browser:ghost')).toBeUndefined();
  });

  it('panes do not see each other', () => {
    publishBrowserPaneChrome('browser:a', chrome('https://a.test'));
    publishBrowserPaneChrome('browser:b', chrome('https://b.test'));
    expect(getBrowserPaneChrome('browser:a')?.url).toBe('https://a.test');
    expect(getBrowserPaneChrome('browser:b')?.url).toBe('https://b.test');
  });

  it('the entry dies with the panel', () => {
    publishBrowserPaneChrome('browser:a', chrome('https://example.com'));
    retireBrowserPaneChrome('browser:a');
    expect(getBrowserPaneChrome('browser:a')).toBeUndefined();
    // Idempotent: a second unmount of an already-gone pane is a no-op, not a throw.
    expect(() => retireBrowserPaneChrome('browser:a')).not.toThrow();
  });

  it('a pane changing does not touch its neighbour', () => {
    const b = chrome('https://b.test');
    publishBrowserPaneChrome('browser:a', chrome('https://a.test'));
    publishBrowserPaneChrome('browser:b', b);
    publishBrowserPaneChrome('browser:a', chrome('https://a.test/2'));
    // Same object, by reference: `useSyncExternalStore` compares snapshots that
    // way, so an untouched neighbour must not even be re-created.
    expect(getBrowserPaneChrome('browser:b')).toBe(b);
    expect(getBrowserPaneChrome('browser:a')?.url).toBe('https://a.test/2');
  });

  it('publishing the identical object again changes nothing', () => {
    const one = chrome('https://example.com');
    publishBrowserPaneChrome('browser:a', one);
    publishBrowserPaneChrome('browser:a', one);
    expect(getBrowserPaneChrome('browser:a')).toBe(one);
  });
});
