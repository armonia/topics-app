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
  EXPANDED_WIDTH_BOUNDS,
  open,
  activate,
  close,
  setMode,
  move,
  setWidth,
  promoteToTab,
  returnFromTab,
  releasePromoted,
  reconcilePromoted,
  resolveMinRect,
  sanitizeTopicBrowserWindow,
  applyRemoteTopicWindow,
  applyRemoteTopicWindowInit,
  applyTopicWindowFrame,
  reloadTopicWindowsFromServer,
  getTopicWindow,
  findTopicOwningPromoted,
  flushTopicWindowWrites,
  updateSheet,
  forgetTopicWindow,
  subscribeTopicWindows,
  topicBrowserWindow,
  __resetTopicWindows,
  type TopicBrowserWindowState,
} from './topicBrowserWindow';
import { topicIdFromKey } from './topicBrowserKey';
import { getTabId } from './pane/middleware/syncCrossTab';

const sheet = (contextId: string, url = `https://${contextId}.test`) => ({ contextId, url, title: contextId.toUpperCase() });

let seq = 0;
const uniqueId = (tag: string) => `topic-${tag}-${seq++}`;

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

  test('closing the active sheet focuses the neighbor that slides in', () => {
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
    expect(s.expandedWidth).toBe(EXPANDED_WIDTH_BOUNDS.max);
    expect(setWidth(s, 10).expandedWidth).toBe(EXPANDED_WIDTH_BOUNDS.min);
    expect(setWidth(s, null).expandedWidth).toBeNull();
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

  test('the default corner sits ABOVE the composer, never on top of it', () => {
    const floor = 140;
    const r = resolveMinRect(EMPTY_TOPIC_BROWSER_WINDOW, { width: 1440, height: 900, floor });
    // Its bottom edge stops where the composer band starts, plus the margin.
    expect(r.top + r.height).toBe(900 - floor - 24);
  });

  test('a position dragged over the composer is pulled back above it', () => {
    const floor = 140;
    const parked = { ...EMPTY_TOPIC_BROWSER_WINDOW, minPos: { right: 24, bottom: 0 } };
    const r = resolveMinRect(parked, { width: 1440, height: 900, floor });
    expect(r.top + r.height).toBe(900 - floor - 24);
  });

  test('with no composer to measure nothing moves', () => {
    const bare = resolveMinRect(EMPTY_TOPIC_BROWSER_WINDOW, { width: 1440, height: 900 });
    const zero = resolveMinRect(EMPTY_TOPIC_BROWSER_WINDOW, { width: 1440, height: 900, floor: 0 });
    expect(zero.top).toBe(bare.top);
  });

  test('an area too short to honour the floor keeps the window inside it', () => {
    const r = resolveMinRect(EMPTY_TOPIC_BROWSER_WINDOW, { width: 600, height: 360, floor: 300 });
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.top + r.height).toBeLessThanOrEqual(360);
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

describe('releasePromoted / reconcilePromoted (a promoted tab that is CLOSED, not returned)', () => {
  const two = open(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), sheet('b'));

  test('closing the promoted tab frees the contextId, and the page can be opened again', () => {
    const promoted = promoteToTab(two, 'a');
    // The X on the layout tab: the pane goes, and nothing returns to the window.
    const released = releasePromoted(promoted, 'a');
    expect(released.promoted).toEqual([]);
    expect(released.tabs.map((t) => t.contextId)).toEqual(['b']);
    // Which is the whole point: `open` accepts that contextId again.
    const again = open(released, sheet('a'));
    expect(again.tabs.map((t) => t.contextId)).toEqual(['b', 'a']);
    expect(again.activeContextId).toBe('a');
    // Falsification: without the release, this reads ['b'] and the page is
    // unreachable for good - which is exactly what happened before.
  });

  test('releasing something that is not promoted changes nothing', () => {
    expect(releasePromoted(two, 'a')).toBe(two);
    expect(releasePromoted(two, '')).toBe(two);
  });

  test('reconcile drops the promoted ids the layout no longer holds, keeps the live ones', () => {
    const both = promoteToTab(promoteToTab(two, 'a'), 'b');
    expect(both.promoted).toEqual(['a', 'b']);
    const reconciled = reconcilePromoted(both, (id) => id === 'b');
    expect(reconciled.promoted).toEqual(['b']);
    // Identity is preserved when the layout agrees: no write, no broadcast.
    expect(reconcilePromoted(reconciled, () => true)).toBe(reconciled);
    expect(reconcilePromoted(two, () => false)).toBe(two);
  });
});

describe('sanitizeTopicBrowserWindow (round trip on an untrusted payload)', () => {
  test('a full state survives JSON round trip unchanged', () => {
    const built = setWidth(move(setMode(promoteToTab(open(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), sheet('b')), 'a'), 'exp'), { right: 12, bottom: 8 }), 640);
    expect(sanitizeTopicBrowserWindow(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  /**
   * THE PROPERTY, and it is the one that was broken: every state the reducer
   * can PRODUCE must be a fixpoint of `sanitize(serialize(s))`. It is not a
   * refinement of the test above, it is the store's contract with the wire:
   * `applyRemote` compares the serialized values, so a state that sanitizes to
   * something else is silently replaced by that something else on the first
   * frame that comes back from the server.
   *
   * The sequences are generated (deterministic LCG, so a red run repeats), and
   * the empty window is IN them: `setMode(empty, 'min')` used to give
   * `{mode:'min', tabs:[]}`, which sanitizes to 'hidden'.
   */
  test('every state the reducer can produce is a fixpoint of sanitize', () => {
    let seed = 1;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const states: TopicBrowserWindowState[] = [EMPTY_TOPIC_BROWSER_WINDOW, setMode(EMPTY_TOPIC_BROWSER_WINDOW, 'min')];
    for (let run = 0; run < 200; run++) {
      let s = EMPTY_TOPIC_BROWSER_WINDOW;
      for (let step = 0; step < 8; step++) {
        const id = `c-${rand(4)}`;
        switch (rand(8)) {
          case 0: s = open(s, sheet(id)); break;
          case 1: s = activate(s, id); break;
          case 2: s = close(s, id); break;
          case 3: s = setMode(s, (['min', 'exp', 'hidden'] as const)[rand(3)]); break;
          case 4: s = move(s, { right: rand(2000) - 500, bottom: rand(2000) - 500 }); break;
          case 5: s = setWidth(s, rand(3) === 0 ? null : rand(2000)); break;
          case 6: s = promoteToTab(s, id); break;
          default: s = returnFromTab(s, sheet(id)); break;
        }
        states.push(s);
      }
    }
    for (const s of states) {
      expect(sanitizeTopicBrowserWindow(JSON.parse(JSON.stringify(s)))).toEqual(s);
    }
  });

  /** The symptom the property protects, end to end: what the server gives back
   *  must not close a window this client has open. */
  test('a window does not close itself on the round trip through the server', () => {
    const persisted = setMode(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), 'exp');
    const fromServer = sanitizeTopicBrowserWindow(JSON.parse(JSON.stringify(persisted)));
    expect(fromServer?.mode).toBe('exp');
    // And an empty window is never asked to be visible in the first place.
    expect(setMode(EMPTY_TOPIC_BROWSER_WINDOW, 'min').mode).toBe('hidden');
  });

  test('junk is dropped: bad sheets, duplicates, unknown mode, out-of-range width', () => {
    const s = sanitizeTopicBrowserWindow({
      mode: 'giant',
      minPos: { right: 'x', bottom: 3 },
      expandedWidth: 99_999,
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
    expect(s!.expandedWidth).toBe(EXPANDED_WIDTH_BOUNDS.max);
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

  const record = (ctx: string) => ({ mode: 'min', tabs: [{ contextId: ctx, url: 'u', title: 'T', openedBy: 'user' }], activeContextId: ctx, promoted: [], minPos: null, expandedWidth: null });

  test('ui-state:updated for another client is applied and notifies', () => {
    const tid = uniqueId('updated');
    let notified = 0;
    const unsub = subscribeTopicWindows(() => { notified++; });
    const handled = applyTopicWindowFrame({ key: `topic-browser:${tid}`, value: record('c-1'), sourceClientId: 'another-client' });
    expect(handled).toBe(true);
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['c-1']);
    expect(notified).toBeGreaterThan(0);
    unsub();
  });

  test('OUR OWN echo is dropped: the frame is ours, the cache does not move', () => {
    const tid = uniqueId('echo');
    applyTopicWindowFrame({ key: `topic-browser:${tid}`, value: record('c-1'), sourceClientId: 'another-client' });
    const handled = applyTopicWindowFrame({ key: `topic-browser:${tid}`, value: record('c-2'), sourceClientId: getTabId() });
    expect(handled).toBe(true); // the key IS ours: the bridge must stop routing it
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['c-1']);
  });

  test('a frame for another store is not ours', () => {
    expect(applyTopicWindowFrame({ key: 'pane-store-v2', value: {} })).toBe(false);
  });

  test('an identical value does not notify, and junk leaves the cache alone', () => {
    const tid = uniqueId('idem');
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
    const tid = uniqueId('init');
    const applied = applyRemoteTopicWindowInit({
      [`topic-browser:${tid}`]: record('c-9'),
      'pane-store-v2': { panes: {} },
    });
    expect([...applied]).toEqual([tid]);
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['c-9']);
  });
});

describe('updateSheet (a page that navigates on its own)', () => {
  const two = open(open(EMPTY_TOPIC_BROWSER_WINDOW, sheet('a')), sheet('b'));

  test('records url and title of a sheet that is NOT the active one, without stealing focus', () => {
    const after = updateSheet(two, 'a', { url: 'https://moved.test', title: 'Moved' });

    expect(after.tabs.find((t) => t.contextId === 'a')).toMatchObject({ url: 'https://moved.test', title: 'Moved' });
    expect(after.activeContextId).toBe(two.activeContextId);
  });

  test('a patch with neither field, and a patch for an unknown sheet, change nothing', () => {
    expect(updateSheet(two, 'a', {})).toBe(two);
    expect(updateSheet(two, 'ghost', { url: 'https://x.test' })).toBe(two);
  });

  test('leaves the other sheets alone', () => {
    const after = updateSheet(two, 'a', { title: 'Moved' });
    expect(after.tabs.find((t) => t.contextId === 'b')).toEqual(two.tabs.find((t) => t.contextId === 'b')!);
  });
});

describe('persistence (ui-state PUT/GET)', () => {
  const REAL_FETCH = globalThis.fetch;
  let puts: { key: string; clientId: string | null; body: unknown }[];
  let served: Map<string, unknown>;
  let fetched: string[];
  /** Runs inside a GET, before it answers: lets a test land a local write
   *  while a read is in flight, or make the read fail. */
  let onGet: (() => Response | undefined) | null;

  beforeEach(() => {
    puts = [];
    fetched = [];
    served = new Map();
    onGet = null;
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const key = decodeURIComponent(String(url).replace('/api/ui-state/', ''));
      if (init?.method === 'PUT') {
        const headers = new Headers(init.headers as HeadersInit);
        puts.push({ key, clientId: headers.get('X-Client-Id'), body: JSON.parse(String(init.body)) });
        return new Response('{}', { status: 200 });
      }
      fetched.push(key);
      const answer = onGet?.();
      if (answer) return answer;
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

  test('flush sends the pending write NOW: a reload within the debounce keeps the position', async () => {
    const tid = uniqueId('flush');
    topicBrowserWindow.open(tid, sheet('a'));
    topicBrowserWindow.move(tid, { right: 40, bottom: 90 });
    // No settle(): this is the reload landing inside the 800 ms window.
    expect(puts.filter((p) => p.key === `topic-browser:${tid}`)).toHaveLength(0);

    flushTopicWindowWrites();

    const sent = puts.filter((p) => p.key === `topic-browser:${tid}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ minPos: { right: 40, bottom: 90 } });
  });

  test('flush does not send the same state twice when the debounce would have fired anyway', async () => {
    const tid = uniqueId('flush-once');
    topicBrowserWindow.open(tid, sheet('a'));
    flushTopicWindowWrites();
    await settle();

    expect(puts.filter((p) => p.key === `topic-browser:${tid}`)).toHaveLength(1);
  });

  test('with nothing pending, flush is a no-op', () => {
    flushTopicWindowWrites();
    expect(puts).toHaveLength(0);
  });

  test('findTopicOwningPromoted names the topic that lent a page, and only while it is on loan', async () => {
    const tid = uniqueId('owner');
    topicBrowserWindow.open(tid, sheet('a'));
    expect(findTopicOwningPromoted('a')).toBeNull();

    topicBrowserWindow.promoteToTab(tid, 'a');
    expect(findTopicOwningPromoted('a')).toBe(tid);

    topicBrowserWindow.returnFromTab(tid, sheet('a'));
    expect(findTopicOwningPromoted('a')).toBeNull();
  });

  test('a mutation persists the whole record under topic-browser:<topicId>, stamped with the client id', async () => {
    const tid = uniqueId('put');
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
    const tid = uniqueId('get');
    served.set(`topic-browser:${tid}`, { mode: 'exp', tabs: [{ contextId: 'c-1', url: 'u', title: 'T' }], activeContextId: 'c-1', expandedWidth: 640 });
    await topicBrowserWindow.ensureLoaded(tid);
    await topicBrowserWindow.ensureLoaded(tid);
    expect(fetched.filter((k) => k === `topic-browser:${tid}`)).toHaveLength(1);
    expect(getTopicWindow(tid).mode).toBe('exp');
    expect(getTopicWindow(tid).expandedWidth).toBe(640);
  });

  test('a queued local write wins over an inbound frame (LWW: the un-flushed edit is newer)', async () => {
    const tid = uniqueId('pending');
    topicBrowserWindow.open(tid, sheet('local'));
    applyRemoteTopicWindow(tid, { mode: 'min', tabs: [{ contextId: 'remote', url: 'u', title: 'T' }], activeContextId: 'remote' });
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['local']);
    await settle();
  });

  test('resync re-GETs only the topics in cache and applies what it missed', async () => {
    const tid = uniqueId('resync');
    applyRemoteTopicWindow(tid, { mode: 'min', tabs: [{ contextId: 'c-1', url: 'u', title: 'T' }], activeContextId: 'c-1' });
    served.set(`topic-browser:${tid}`, { mode: 'hidden', tabs: [], activeContextId: null });
    await reloadTopicWindowsFromServer({});
    expect(fetched).toContain(`topic-browser:${tid}`);
    expect(getTopicWindow(tid).tabs).toHaveLength(0);
  });

  /**
   * A client offline while its topic got archived never sees `topic:archived`:
   * the resync reading the row as GONE is the only thing left that drops that
   * window.
   */
  test('resync drops a window whose row the server no longer has', async () => {
    const tid = uniqueId('gone');
    applyRemoteTopicWindow(tid, { mode: 'min', tabs: [{ contextId: 'c-1', url: 'u', title: 'T' }], activeContextId: 'c-1' });
    let notified = 0;
    const unsub = subscribeTopicWindows(() => { notified++; });
    await reloadTopicWindowsFromServer({}); // nothing served: the server answers `null`
    unsub();
    expect(fetched).toContain(`topic-browser:${tid}`);
    expect(getTopicWindow(tid)).toEqual(EMPTY_TOPIC_BROWSER_WINDOW);
    expect(notified).toBe(1);
  });

  test('a resync read that FAILS drops nothing', async () => {
    const tid = uniqueId('failed-read');
    applyRemoteTopicWindow(tid, { mode: 'min', tabs: [{ contextId: 'c-1', url: 'u', title: 'T' }], activeContextId: 'c-1' });
    onGet = () => new Response('boom', { status: 503 });
    await reloadTopicWindowsFromServer({});
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['c-1']);
  });

  test('a local write queued while the resync read was in flight beats the vanished row', async () => {
    const tid = uniqueId('gone-but-written');
    applyRemoteTopicWindow(tid, { mode: 'min', tabs: [{ contextId: 'c-1', url: 'u', title: 'T' }], activeContextId: 'c-1' });
    onGet = () => { topicBrowserWindow.open(tid, sheet('c-2')); return undefined; };
    await reloadTopicWindowsFromServer({});
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['c-1', 'c-2']);
    await settle();
  });

  test('forget drops the cache AND the queued PUT, so the key cannot resurrect', async () => {
    const tid = uniqueId('forget');
    topicBrowserWindow.open(tid, sheet('a'));
    forgetTopicWindow(tid);
    await settle();
    expect(puts).toHaveLength(0);
    expect(getTopicWindow(tid)).toEqual(EMPTY_TOPIC_BROWSER_WINDOW);
  });
});

// ── a write stays protected until the server answers (card 0470f6df) ─────────
// Closing the LAST sheet writes with no debounce, so the PUT leaves at once, and
// the protection used to end THERE instead of at the answer. In that round trip
// a frame from another device landed in the cache, our own echo was then dropped
// as an echo, and the two copies stayed apart until the next reconnection.
// The fix opened the opposite window, which is what the seq arbitration closes:
// the server broadcasts BEFORE it answers, so a frame carrying a write that
// happened AFTER ours must be adopted, not thrown away. And a resync GET issued
// before a close must lose to that close even when its answer lands later.
