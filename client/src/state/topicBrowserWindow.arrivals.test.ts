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
 *
 * What is measured is the RELEASE, not an announcement: the pane leaving a
 * project window that holds it, in both orders in which the two reads can
 * meet (window read after the project mounted, project mounted after the
 * window was read).
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
  __resetTopicWindows,
  type TopicBrowserWindowState,
} from './topicBrowserWindow';
import { publishProjectBrowserPanes } from './pane/adapters/projectBrowserPanes';

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

describe('a value read from elsewhere releases the pane that holds an arrived sheet', () => {
  const PROJECT = '/tmp/topic-arrivals-project';
  let reclaimed: string[];
  let stopPublishing: () => void;

  /** A project window here holding `ids` as browser panes. */
  const holdInProject = (ids: string[], restored = false) => {
    stopPublishing();
    stopPublishing = publishProjectBrowserPanes(
      PROJECT,
      ids.map((id) => ({ contextId: id, url: `https://example.test/${id}`, title: id })),
      (id) => { reclaimed.push(id); },
      restored,
    );
  };

  beforeEach(() => {
    __resetTopicWindows();
    reclaimed = [];
    stopPublishing = () => {};
  });
  afterEach(() => {
    stopPublishing();
    __resetTopicWindows();
  });

  test('another device took the page back: the pane here is released', () => {
    const tid = uniqueId('return');
    applyRemoteTopicWindow(tid, lentB);
    holdInProject(['b']);

    applyRemoteTopicWindow(tid, returnFromTab(lentB, sheet('b')));

    expect(reclaimed).toEqual(['b']);
  });

  test('another device promoted a page: the pane it just added here stays', () => {
    const tid = uniqueId('promote');
    const both = open(lentB, sheet('c'));
    applyRemoteTopicWindow(tid, both);
    // The project frame of the promotion lands first: a LIVE list, not a restored one.
    holdInProject(['b', 'c']);

    applyRemoteTopicWindow(tid, promoteToTab(both, 'c'));

    expect(reclaimed).toEqual([]);
  });

  test('a return made HERE is left to the local path, which already reclaimed the pane', () => {
    const tid = uniqueId('local');
    topicBrowserWindow.open(tid, sheet('b'));
    topicBrowserWindow.promoteToTab(tid, 'b');
    holdInProject(['b']);

    topicBrowserWindow.returnFromTab(tid, sheet('b'));

    expect(reclaimed).toEqual([]);
  });

  test('a device that was away, project mounted first: the first read of the window releases the pane', async () => {
    const REAL_FETCH = globalThis.fetch;
    const tid = uniqueId('cold-read');
    const served = returnFromTab(lentB, sheet('b'));
    holdInProject(['b'], true);
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ value: served, server_seq: 7 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    try {
      await ensureTopicWindowLoaded(tid);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
    }

    expect(reclaimed).toEqual(['b']);
  });

  test('a device that was away, window read first: the project mounting with the page releases it', () => {
    const tid = uniqueId('cold-mount');
    applyRemoteTopicWindow(tid, returnFromTab(lentB, sheet('b')));

    holdInProject(['b'], true);

    expect(reclaimed).toEqual(['b']);
  });

  test('a page the window holds as LENT is not released when the project mounts with it', () => {
    const tid = uniqueId('lent-mount');
    applyRemoteTopicWindow(tid, lentB);

    holdInProject(['b'], true);

    expect(reclaimed).toEqual([]);
  });
});

describe('a page taken from the layout is written before the layout writes its own record', () => {
  const REAL_FETCH = globalThis.fetch;
  let puts: string[];

  beforeEach(() => {
    __resetTopicWindows();
    puts = [];
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'PUT') puts.push(String(url));
      return new Response(JSON.stringify({ ok: true, server_seq: puts.length }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
  });
  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
    __resetTopicWindows();
  });

  // The project record follows 500 ms after the reclaim; the window record has
  // to be on the wire well before it, or the other device merges the project
  // record while still holding the pane and saves it back.
  test('a lent page taken back is PUT at once, not after the 800 ms debounce', async () => {
    const tid = uniqueId('put-return');
    applyRemoteTopicWindow(tid, lentB);

    topicBrowserWindow.takeFromLayout(tid, sheet('b'));
    await new Promise((r) => setTimeout(r, 50));

    expect(puts.filter((u) => u.includes(`topic-browser`))).toHaveLength(1);
  });

  test('a page that was never lent is opened as a sheet and PUT at once too', async () => {
    const tid = uniqueId('put-open');
    applyRemoteTopicWindow(tid, lentB);

    topicBrowserWindow.takeFromLayout(tid, sheet('z'));
    await new Promise((r) => setTimeout(r, 50));

    expect(puts.filter((u) => u.includes(`topic-browser`))).toHaveLength(1);
  });
});
