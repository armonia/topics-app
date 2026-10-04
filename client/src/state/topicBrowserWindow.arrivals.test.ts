/**
 * A page that another device puts back into a topic's window ARRIVES here as a
 * sheet, and the arrival is what tells this device's layout to let go of it.
 *
 * The project's tab record cannot say it: it is received additively, so a pane
 * missing from another device's record is never removed here. The window
 * record names the page by identity, and only the transitions that put a page
 * IN the window may count, never the ones that take it out (a promotion on
 * another device lands here as project tab first and window record second, and
 * reading that window as "the page went home" would undo the promotion).
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  EMPTY_TOPIC_BROWSER_WINDOW,
  sheetsArrived,
  open,
  promoteToTab,
  returnFromTab,
  applyRemoteTopicWindow,
  ensureTopicWindowLoaded,
  topicBrowserWindow,
  subscribeSheetArrivals,
  __resetTopicWindows,
  type TopicBrowserWindowState,
} from './topicBrowserWindow';

let seq = 0;
const uniqueId = (tag: string) => `topic-arrivals-${tag}-${seq++}`;

const sheet = (contextId: string) => ({ contextId, url: `https://example.test/${contextId}`, title: contextId });

/** A window with `a` as a sheet and `b` lent to the layout. */
const lentB: TopicBrowserWindowState = promoteToTab(open(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), sheet('b')), 'b');

describe('sheetsArrived (pure)', () => {
  test('a page taken back from the layout is an arrival', () => {
    expect(sheetsArrived(lentB, returnFromTab(lentB, sheet('b')))).toEqual(['b']);
  });

  test('a promotion is not: the page leaves the window', () => {
    const both = open(lentB, sheet('c'));
    expect(sheetsArrived(both, promoteToTab(both, 'c'))).toEqual([]);
  });

  test('a sheet that was already there is not an arrival', () => {
    expect(sheetsArrived(lentB, lentB)).toEqual([]);
  });

  test('a window this device has never seen: every sheet is an arrival', () => {
    expect(sheetsArrived(undefined, lentB)).toEqual(['a']);
  });
});

describe('the store announces the arrivals of values read from elsewhere', () => {
  let heard: string[][];
  let stop: () => void;

  beforeEach(() => {
    __resetTopicWindows();
    heard = [];
    stop = subscribeSheetArrivals((ids) => { heard.push(ids); });
  });
  afterEach(() => {
    stop();
    __resetTopicWindows();
  });

  test('another device took the page back: the arrival is announced', () => {
    const tid = uniqueId('return');
    applyRemoteTopicWindow(tid, lentB);
    heard = [];

    applyRemoteTopicWindow(tid, returnFromTab(lentB, sheet('b')));

    expect(heard).toEqual([['b']]);
  });

  test('another device promoted a page: nothing is announced', () => {
    const tid = uniqueId('promote');
    const both = open(lentB, sheet('c'));
    applyRemoteTopicWindow(tid, both);
    heard = [];

    applyRemoteTopicWindow(tid, promoteToTab(both, 'c'));

    expect(heard).toEqual([]);
  });

  test('a return made HERE is not announced: the local path already reclaimed the pane', () => {
    const tid = uniqueId('local');
    topicBrowserWindow.open(tid, sheet('b'));
    topicBrowserWindow.promoteToTab(tid, 'b');
    heard = [];

    topicBrowserWindow.returnFromTab(tid, sheet('b'));

    expect(heard).toEqual([]);
  });

  test('the first read of a window announces its sheets: a device that was away catches up', async () => {
    const REAL_FETCH = globalThis.fetch;
    const tid = uniqueId('cold');
    const served = returnFromTab(lentB, sheet('b'));
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ value: served, server_seq: 7 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    try {
      await ensureTopicWindowLoaded(tid);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
    }

    expect(heard).toEqual([['a', 'b']]);
  });
});
