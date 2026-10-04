/**
 * Back/forward flags of the streaming pane, server side: the reduction of
 * CDP Page.getNavigationHistory, and the publisher that turns navigations into
 * `nav` messages without flooding the socket.
 * @covers BROWSER-STREAM-HISTORY-01
 */
import { describe, it, expect } from 'bun:test';
import type { CDPSession } from 'playwright-core';
import { navigationHistoryFlags, readNavigationHistoryFlags, type NavigationHistoryFlags } from './browser-cdp-surface';
import { createNavHistoryPublisher, type NavHistoryUpdate } from './browser-nav-history';

const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://a.test/${i}` }));

describe('navigationHistoryFlags', () => {
  it('a single entry has nowhere to go', () => {
    expect(navigationHistoryFlags({ currentIndex: 0, entries: entries(1) })).toEqual({ canGoBack: false, canGoForward: false });
  });

  it('the last of three can only go back', () => {
    expect(navigationHistoryFlags({ currentIndex: 2, entries: entries(3) })).toEqual({ canGoBack: true, canGoForward: false });
  });

  it('the first of three can only go forward', () => {
    expect(navigationHistoryFlags({ currentIndex: 0, entries: entries(3) })).toEqual({ canGoBack: false, canGoForward: true });
  });

  it('the middle one goes both ways', () => {
    expect(navigationHistoryFlags({ currentIndex: 1, entries: entries(3) })).toEqual({ canGoBack: true, canGoForward: true });
  });

  it('an index outside the list lights neither arrow', () => {
    expect(navigationHistoryFlags({ currentIndex: 5, entries: entries(2) })).toEqual({ canGoBack: false, canGoForward: false });
    expect(navigationHistoryFlags({ currentIndex: -1, entries: entries(2) })).toEqual({ canGoBack: false, canGoForward: false });
    expect(navigationHistoryFlags({ currentIndex: 0, entries: [] })).toEqual({ canGoBack: false, canGoForward: false });
  });
});

describe('readNavigationHistoryFlags', () => {
  it('asks CDP for the navigation history and reduces the answer', async () => {
    const calls: string[] = [];
    const cdp = {
      send: async (method: string) => {
        calls.push(method);
        return { currentIndex: 1, entries: entries(2) };
      },
    } as unknown as CDPSession;
    expect(await readNavigationHistoryFlags(cdp)).toEqual({ canGoBack: true, canGoForward: false });
    expect(calls).toEqual(['Page.getNavigationHistory']);
  });
});

/** A browser whose answers the test sets, and the messages the pane would get. */
function harness(initial: { url: string; flags: NavigationHistoryFlags | null }) {
  const world = { ...initial, reads: 0 };
  const sent: NavHistoryUpdate[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const publisher = createNavHistoryPublisher({
    read: async () => {
      world.reads++;
      if (hold) await new Promise<void>((r) => { release = r; });
      return world.flags;
    },
    currentUrl: () => world.url,
    publish: (u) => sent.push(u),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    world, sent, publisher, settle,
    holdReads: () => { hold = true; },
    releaseRead: () => { hold = false; release?.(); release = null; },
  };
}

describe('createNavHistoryPublisher', () => {
  it('a same-document navigation publishes the new url and flags', async () => {
    const h = harness({ url: 'https://a.test/#one', flags: { canGoBack: true, canGoForward: false } });
    h.publisher.navigated();
    await h.settle();
    expect(h.sent).toEqual([{ url: 'https://a.test/#one', canGoBack: true, canGoForward: false }]);
  });

  it('the same url with the same flags is not published twice', async () => {
    const h = harness({ url: 'https://a.test/', flags: { canGoBack: false, canGoForward: false } });
    h.publisher.navigated();
    await h.settle();
    h.publisher.navigated();
    await h.settle();
    expect(h.sent.length).toBe(1);
  });

  it('a change of flags alone is published', async () => {
    const h = harness({ url: 'https://a.test/', flags: { canGoBack: true, canGoForward: false } });
    h.publisher.navigated();
    await h.settle();
    h.world.flags = { canGoBack: false, canGoForward: true };
    h.publisher.navigated();
    await h.settle();
    expect(h.sent.map((u) => [u.canGoBack, u.canGoForward])).toEqual([[true, false], [false, true]]);
  });

  it('what the load response already carried is not repeated', async () => {
    const h = harness({ url: 'https://a.test/', flags: { canGoBack: true, canGoForward: false } });
    expect(await h.publisher.flagsForLoad('https://a.test/')).toEqual({ canGoBack: true, canGoForward: false });
    h.publisher.navigated();
    await h.settle();
    expect(h.sent).toEqual([]);
  });

  it('about:blank and error pages never reach the pane', async () => {
    const h = harness({ url: 'about:blank', flags: { canGoBack: false, canGoForward: false } });
    h.publisher.navigated();
    await h.settle();
    h.world.url = 'chrome-error://chromewebdata/';
    h.publisher.navigated();
    await h.settle();
    expect(h.sent).toEqual([]);
  });

  it('a read that fails publishes nothing and reports nothing for the load', async () => {
    const h = harness({ url: 'https://a.test/', flags: null });
    h.publisher.navigated();
    await h.settle();
    expect(h.sent).toEqual([]);
    expect(await h.publisher.flagsForLoad('https://a.test/')).toBeNull();
    expect(h.publisher.current()).toBeNull();
  });

  it('a burst of navigations during a read costs ONE more read, with the latest state', async () => {
    const h = harness({ url: 'https://a.test/#1', flags: { canGoBack: true, canGoForward: false } });
    h.holdReads();
    h.publisher.navigated();
    await h.settle();
    for (let i = 2; i <= 20; i++) { h.world.url = `https://a.test/#${i}`; h.publisher.navigated(); }
    h.releaseRead();
    await h.settle();
    await h.settle();
    expect(h.world.reads).toBe(2);
    expect(h.sent.map((u) => u.url)).toEqual(['https://a.test/#20']);
  });

  it('current() returns the last flags read, for a pane that reconnects', async () => {
    const h = harness({ url: 'https://a.test/', flags: { canGoBack: true, canGoForward: true } });
    expect(h.publisher.current()).toBeNull();
    await h.publisher.flagsForLoad('https://a.test/');
    expect(h.publisher.current()).toEqual({ canGoBack: true, canGoForward: true });
  });
});
