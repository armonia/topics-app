/**
 * Tests for the topic-owned browser window: the pure reducer ops, the
 * "a sheet is in the window OR in the layout, never both" invariant, and the
 * ui-state round trip (own echo dropped, untrusted payload sanitized).
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  EMPTY_TOPIC_BROWSER_WINDOW,
  MIN_WINDOW_SIZE,
  EXP_WIDTH_BOUNDS,
  open,
  activate,
  close,
  setMode,
  move,
  setWidth,
  promoteToTab,
  returnFromTab,
  resolveMinRect,
  sanitizeTopicBrowserWindow,
  topicIdFromKey,
  applyRemoteTopicWindow,
  applyRemoteTopicWindowInit,
  applyTopicWindowFrame,
  resyncTopicWindowsFromServer,
  getTopicWindow,
  forgetTopicWindow,
  subscribeTopicWindows,
  topicBrowserWindow,
  __resetTopicWindows,
} from './topicBrowserWindow';
import { getTabId } from './pane/middleware/syncCrossTab';

const sheet = (contextId: string, url = `https://${contextId}.test`) => ({ contextId, url, title: contextId.toUpperCase() });

let seq = 0;
const uniq = (tag: string) => `topic-${tag}-${seq++}`;

describe('open', () => {
  test('appends sheets in order, activates the last, and wakes a hidden window', () => {
    const s1 = open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a'));
    expect(s1.mode).toBe('min');
    expect(s1.tabs.map((t) => t.contextId)).toEqual(['a']);
    expect(s1.activeContextId).toBe('a');
    const s2 = open(s1, sheet('b'));
    expect(s2.tabs.map((t) => t.contextId)).toEqual(['a', 'b']);
    expect(s2.activeContextId).toBe('b');
  });

  test('an expanded window stays expanded, and an explicit mode wins', () => {
    const expanded = setMode(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), 'exp');
    expect(open(expanded, sheet('b')).mode).toBe('exp');
    expect(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a'), 'exp').mode).toBe('exp');
  });

  test('a known contextId is refreshed and activated, never duplicated', () => {
    const s = open(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), sheet('b'));
    const again = open(s, { contextId: 'a', url: 'https://a2.test' });
    expect(again.tabs).toHaveLength(2);
    expect(again.tabs[0].url).toBe('https://a2.test');
    expect(again.activeContextId).toBe('a');
  });

  test('openedBy defaults to user and is kept', () => {
    const s = open(EMPTY_TOPIC_BROWSER_WINDOW, { contextId: 'a', openedBy: 'agent' });
    expect(s.tabs[0].openedBy).toBe('agent');
    expect(open(EMPTY_TOPIC_BROWSER_WINDOW, { contextId: 'b' }).tabs[0].openedBy).toBe('user');
  });
});

describe('activate / close', () => {
  const two = open(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), sheet('b'));

  test('activate only accepts a sheet of this window', () => {
    expect(activate(two, 'a').activeContextId).toBe('a');
    expect(activate(two, 'ghost')).toBe(two);
  });

  test('closing the active sheet focuses the neighbour that slides in', () => {
    const s = close(activate(two, 'a'), 'a');
    expect(s.tabs.map((t) => t.contextId)).toEqual(['b']);
    expect(s.activeContextId).toBe('b');
  });

  test('closing the last sheet hides the window', () => {
    const s = close(close(two, 'a'), 'b');
    expect(s.tabs).toHaveLength(0);
    expect(s.activeContextId).toBeNull();
    expect(s.mode).toBe('hidden');
  });
});

describe('setMode / move / setWidth', () => {
  test('mode cycles between the three states', () => {
    const s = open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a'));
    expect(setMode(s, 'exp').mode).toBe('exp');
    expect(setMode(setMode(s, 'exp'), 'hidden').mode).toBe('hidden');
    expect(setMode(s, 'min')).toBe(s);
  });

  test('move stores a bottom-right anchor, clamped to the area', () => {
    const s = move(EMPTY_TOPIC_BROWSER_WINDOW, { right: 40.4, bottom: -12 });
    expect(s.minPos).toEqual({ right: 40, bottom: 0 });
    expect(move(s, { right: 40, bottom: 0 })).toBe(s);
  });

  test('setWidth clamps, and null restores the default', () => {
    const s = setWidth(EMPTY_TOPIC_BROWSER_WINDOW, 10_000);
    expect(s.expWidth).toBe(EXP_WIDTH_BOUNDS.max);
    expect(setWidth(s, 10).expWidth).toBe(EXP_WIDTH_BOUNDS.min);
    expect(setWidth(s, null).expWidth).toBeNull();
  });
});

describe('resolveMinRect (the corner survives a resize of the app)', () => {
  test('the distance from the bottom-right corner is the same on a narrower area', () => {
    const s = move(EMPTY_TOPIC_BROWSER_WINDOW, { right: 32, bottom: 24 });
    const wide = resolveMinRect(s, { width: 1440, height: 900 });
    const narrow = resolveMinRect(s, { width: 1000, height: 700 });
    expect(wide.left + wide.width).toBe(1440 - 32);
    expect(narrow.left + narrow.width).toBe(1000 - 32);
    expect(wide.top + wide.height).toBe(900 - 24);
    expect(narrow.top + narrow.height).toBe(700 - 24);
    // …and it never walks off the left edge, which is what an anchor to the
    // LEFT would have done on the narrow area.
    expect(narrow.left).toBeGreaterThanOrEqual(0);
  });

  test('an area smaller than the window shrinks it instead of pushing it out', () => {
    const s = move(EMPTY_TOPIC_BROWSER_WINDOW, { right: 300, bottom: 300 });
    const tiny = resolveMinRect(s, { width: 320, height: 240 });
    expect(tiny.width).toBe(320);
    expect(tiny.height).toBe(240);
    expect(tiny.left).toBe(0);
    expect(tiny.top).toBe(0);
  });

  test('without a stored position the window sits in the default corner', () => {
    const r = resolveMinRect(EMPTY_TOPIC_BROWSER_WINDOW, { width: 1440, height: 900 });
    expect(r.left).toBe(1440 - 24 - MIN_WINDOW_SIZE.width);
    expect(r.top).toBe(900 - 24 - MIN_WINDOW_SIZE.height);
  });
});

describe('promoteToTab / returnFromTab (the invariant)', () => {
  const two = open(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), sheet('b'));

  test('a promoted sheet leaves the window and the other one stays', () => {
    const s = promoteToTab(activate(two, 'a'), 'a');
    expect(s.tabs.map((t) => t.contextId)).toEqual(['b']);
    expect(s.promoted).toEqual(['a']);
    expect(s.activeContextId).toBe('b');
  });

  test('THE INVARIANT: a promoted contextId cannot re-enter the window as a sheet', () => {
    const s = promoteToTab(two, 'a');
    // A link, or the agent, opening the SAME context again: the layout tab owns
    // it, so the window must not grow a second representation of that page.
    const again = open(s, { contextId: 'a', url: 'https://a-again.test', openedBy: 'link' });
    expect(again.tabs.map((t) => t.contextId)).toEqual(['b']);
    expect(again.promoted).toEqual(['a']);
    // Falsification: drop the `promoted` guard at the top of `open` and this
    // line reads ['b', 'a'] — the same page in the window and in the layout.
    expect(again.tabs.filter((t) => t.contextId === 'a')).toHaveLength(0);
  });

  test('returnFromTab brings it back as the active sheet and wakes the window', () => {
    const promotedThenClosed = close(promoteToTab(two, 'a'), 'b');
    expect(promotedThenClosed.mode).toBe('hidden');
    const back = returnFromTab(promotedThenClosed, sheet('a'));
    expect(back.promoted).toEqual([]);
    expect(back.tabs.map((t) => t.contextId)).toEqual(['a']);
    expect(back.activeContextId).toBe('a');
    expect(back.mode).toBe('min');
  });

  test('returnFromTab on something that was never promoted is a no-op', () => {
    expect(returnFromTab(two, sheet('a'))).toBe(two);
    expect(promoteToTab(two, 'ghost')).toBe(two);
  });

  test('promoting the last sheet hides the window without losing the context', () => {
    const one = open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a'));
    const s = promoteToTab(one, 'a');
    expect(s.mode).toBe('hidden');
    expect(s.tabs).toHaveLength(0);
    expect(s.promoted).toEqual(['a']);
  });
});

describe('sanitizeTopicBrowserWindow (round trip on an untrusted payload)', () => {
  test('a full state survives JSON round trip unchanged', () => {
    const built = setWidth(move(setMode(promoteToTab(open(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), sheet('b')), 'a'), 'exp'), { right: 12, bottom: 8 }), 640);
    expect(sanitizeTopicBrowserWindow(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  test('junk is dropped: bad sheets, duplicates, unknown mode, out-of-range width', () => {
    const s = sanitizeTopicBrowserWindow({
      mode: 'giant',
      minPos: { right: 'x', bottom: 3 },
      expWidth: 99_999,
      tabs: [
        { contextId: 'a', url: 'https://a.test', title: 'A', openedBy: 'link' },
        { contextId: 'a', url: 'dup' },
        { contextId: '' },
        null,
        { url: 'no ctx' },
      ],
      activeContextId: 'ghost',
      promoted: ['b', 'b', 'a', 42],
    });
    expect(s).not.toBeNull();
    expect(s!.tabs.map((t) => t.contextId)).toEqual(['a']);
    expect(s!.tabs[0].openedBy).toBe('link');
    expect(s!.mode).toBe('hidden');
    expect(s!.minPos).toBeNull();
    expect(s!.expWidth).toBe(EXP_WIDTH_BOUNDS.max);
    // 'a' is a sheet of the window, so it cannot ALSO be claimed as promoted.
    expect(s!.promoted).toEqual(['b']);
    // A dangling active ctx falls back to the first sheet.
    expect(s!.activeContextId).toBe('a');
  });

  test('a payload that is not a window record gives null', () => {
    expect(sanitizeTopicBrowserWindow(null)).toBeNull();
    expect(sanitizeTopicBrowserWindow({ panes: {} })).toBeNull();
    expect(sanitizeTopicBrowserWindow('nope')).toBeNull();
  });

  test('a mode without sheets rehydrates hidden', () => {
    expect(sanitizeTopicBrowserWindow({ mode: 'exp', tabs: [] })!.mode).toBe('hidden');
  });
});

describe('topicIdFromKey', () => {
  test('reads the topic id only out of a topic-browser key', () => {
    expect(topicIdFromKey('topic-browser:abc-123')).toBe('abc-123');
    expect(topicIdFromKey('task-browser-tabs:abc-123')).toBeNull();
    expect(topicIdFromKey('pane-store-v2')).toBeNull();
    expect(topicIdFromKey('')).toBeNull();
  });
});

describe('inbound ui-state (the store re-reads what it writes)', () => {
  afterEach(() => { __resetTopicWindows(); });

  const record = (ctx: string) => ({ mode: 'min', tabs: [{ contextId: ctx, url: 'u', title: 'T', openedBy: 'user' }], activeContextId: ctx, promoted: [], minPos: null, expWidth: null });

  test('ui-state:updated for another client is applied and notifies', () => {
    const tid = uniq('updated');
    let notified = 0;
    const unsub = subscribeTopicWindows(() => { notified++; });
    const handled = applyTopicWindowFrame({ key: `topic-browser:${tid}`, value: record('c-1'), sourceClientId: 'another-client' });
    expect(handled).toBe(true);
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['c-1']);
    expect(notified).toBeGreaterThan(0);
    unsub();
  });

  test('OUR OWN echo is dropped: the frame is ours, the cache does not move', () => {
    const tid = uniq('echo');
    applyTopicWindowFrame({ key: `topic-browser:${tid}`, value: record('c-1'), sourceClientId: 'another-client' });
    const handled = applyTopicWindowFrame({ key: `topic-browser:${tid}`, value: record('c-2'), sourceClientId: getTabId() });
    expect(handled).toBe(true); // the key IS ours: the bridge must stop routing it
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['c-1']);
  });

  test('a frame for another store is not ours', () => {
    expect(applyTopicWindowFrame({ key: 'pane-store-v2', value: {} })).toBe(false);
  });

  test('an identical value does not notify, and junk leaves the cache alone', () => {
    const tid = uniq('idem');
    applyRemoteTopicWindow(tid, record('c-1'));
    let notified = 0;
    const unsub = subscribeTopicWindows(() => { notified++; });
    applyRemoteTopicWindow(tid, record('c-1'));
    expect(notified).toBe(0);
    applyRemoteTopicWindow(tid, null);
    expect(getTopicWindow(tid).tabs).toHaveLength(1);
    unsub();
  });

  test('ui-state:init applies only the topic-browser keys of the snapshot', () => {
    const tid = uniq('init');
    const applied = applyRemoteTopicWindowInit({
      [`topic-browser:${tid}`]: record('c-9'),
      'pane-store-v2': { panes: {} },
    });
    expect([...applied]).toEqual([tid]);
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['c-9']);
  });
});

describe('persistence (ui-state PUT/GET)', () => {
  const REAL_FETCH = globalThis.fetch;
  let puts: { key: string; clientId: string | null; body: unknown }[];
  let served: Map<string, unknown>;
  let fetched: string[];

  beforeEach(() => {
    puts = [];
    fetched = [];
    served = new Map();
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const key = decodeURIComponent(String(url).replace('/api/ui-state/', ''));
      if (init?.method === 'PUT') {
        const headers = new Headers(init.headers as HeadersInit);
        puts.push({ key, clientId: headers.get('X-Client-Id'), body: JSON.parse(String(init.body)) });
        return new Response('{}', { status: 200 });
      }
      fetched.push(key);
      const value = served.get(key);
      return new Response(JSON.stringify(value === undefined ? null : { value }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
  });
  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
    __resetTopicWindows();
  });

  const settle = () => new Promise((r) => setTimeout(r, 1000));

  test('a mutation persists the whole record under topic-browser:<topicId>, stamped with the client id', async () => {
    const tid = uniq('put');
    topicBrowserWindow.open(tid, sheet('a'));
    topicBrowserWindow.setMode(tid, 'exp');
    await settle();
    expect(puts).toHaveLength(1); // debounced into one write
    expect(puts[0].key).toBe(`topic-browser:${tid}`);
    expect(puts[0].clientId).toBe(getTabId());
    expect(sanitizeTopicBrowserWindow(puts[0].body)).toEqual(getTopicWindow(tid));
    expect(getTopicWindow(tid).mode).toBe('exp');
  });

  test('the lazy GET hydrates a topic once, sanitized', async () => {
    const tid = uniq('get');
    served.set(`topic-browser:${tid}`, { mode: 'exp', tabs: [{ contextId: 'c-1', url: 'u', title: 'T' }], activeContextId: 'c-1', expWidth: 640 });
    await topicBrowserWindow.ensureLoaded(tid);
    await topicBrowserWindow.ensureLoaded(tid);
    expect(fetched.filter((k) => k === `topic-browser:${tid}`)).toHaveLength(1);
    expect(getTopicWindow(tid).mode).toBe('exp');
    expect(getTopicWindow(tid).expWidth).toBe(640);
  });

  test('a queued local write wins over an inbound frame (LWW: the un-flushed edit is newer)', async () => {
    const tid = uniq('pending');
    topicBrowserWindow.open(tid, sheet('local'));
    applyRemoteTopicWindow(tid, { mode: 'min', tabs: [{ contextId: 'remote', url: 'u', title: 'T' }], activeContextId: 'remote' });
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['local']);
    await settle();
  });

  test('resync re-GETs only the topics in cache and applies what it missed', async () => {
    const tid = uniq('resync');
    applyRemoteTopicWindow(tid, { mode: 'min', tabs: [{ contextId: 'c-1', url: 'u', title: 'T' }], activeContextId: 'c-1' });
    served.set(`topic-browser:${tid}`, { mode: 'hidden', tabs: [], activeContextId: null });
    await resyncTopicWindowsFromServer({});
    expect(fetched).toContain(`topic-browser:${tid}`);
    expect(getTopicWindow(tid).tabs).toHaveLength(0);
  });

  test('forget drops the cache AND the queued PUT, so the key cannot resurrect', async () => {
    const tid = uniq('forget');
    topicBrowserWindow.open(tid, sheet('a'));
    forgetTopicWindow(tid);
    await settle();
    expect(puts).toHaveLength(0);
    expect(getTopicWindow(tid)).toEqual(EMPTY_TOPIC_BROWSER_WINDOW);
  });
});
