/**
 * Tests for the cross-window presence store's PURE selectors — the logic that
 * projects the WS `presence:windows` snapshot into "open in another window"
 * affordances. The invariants worth pinning:
 *   - a topic open in THIS window is never "open elsewhere" (self excluded);
 *   - first-seen wins when the same topic is in several other windows;
 *   - only DETACHED windows drive the marker (not plain browser tabs);
 *   - setWindows replaces the whole set (full-snapshot semantics, self-healing).
  * @covers PRESENCE-10
 */
import { describe, test, it, expect } from 'bun:test';
import {
  computeDetachedTopicMap,
  computeDetachedWindows,
  computeSpaceWindows,
  useWindowPresenceStore,
  windowTabs,
  type PresenceWindow,
} from './windowPresence';

const win = (over: Partial<PresenceWindow> & { windowId: string }): PresenceWindow => ({
  clientId: `client-${over.windowId}`,
  topicIds: [],
  ...over,
});

const byId = (...ws: PresenceWindow[]): Record<string, PresenceWindow> =>
  Object.fromEntries(ws.map((w) => [w.windowId, w]));

describe('computeDetachedTopicMap', () => {
  test('excludes this window — a topic open HERE is not "elsewhere"', () => {
    const windows = byId(win({ windowId: 'self', topicIds: ['a', 'b'] }));
    const map = computeDetachedTopicMap(windows, 'self');
    expect(map.size).toBe(0);
  });

  test('maps a topic held by another window to its id + label', () => {
    const windows = byId(
      win({ windowId: 'self', topicIds: ['a'] }),
      win({ windowId: 'w2', windowLabel: 'detach-1', detached: true, topicIds: ['b', 'c'] }),
    );
    const map = computeDetachedTopicMap(windows, 'self');
    expect(map.get('b')).toEqual({ windowId: 'w2', windowLabel: 'detach-1' });
    expect(map.get('c')).toEqual({ windowId: 'w2', windowLabel: 'detach-1' });
    // 'a' is in self → not elsewhere.
    expect(map.has('a')).toBe(false);
  });

  test('first-seen wins when a topic is open in two other windows', () => {
    const windows = byId(
      win({ windowId: 'w2', windowLabel: 'detach-1', topicIds: ['x'] }),
      win({ windowId: 'w3', windowLabel: 'detach-2', topicIds: ['x'] }),
    );
    const map = computeDetachedTopicMap(windows, 'self');
    // Object.values order preserves insertion → w2 wins.
    expect(map.get('x')?.windowId).toBe('w2');
  });

  test('a web-tab holder (no label) still maps, with undefined label', () => {
    const windows = byId(win({ windowId: 'w2', topicIds: ['y'] }));
    const map = computeDetachedTopicMap(windows, 'self');
    expect(map.has('y')).toBe(true);
    expect(map.get('y')?.windowLabel).toBeUndefined();
  });
});

describe('computeDetachedWindows', () => {
  test('returns only detached windows, excluding self', () => {
    const windows = byId(
      win({ windowId: 'self', detached: true, topicIds: ['a'] }),
      win({ windowId: 'w2', detached: true, topicIds: ['b'] }),
      win({ windowId: 'w3', detached: false, topicIds: ['c'] }),
    );
    const list = computeDetachedWindows(windows, 'self');
    expect(list.map((w) => w.windowId)).toEqual(['w2']);
  });

  test('empty when no other detached window exists', () => {
    const windows = byId(win({ windowId: 'w2', detached: false, topicIds: ['b'] }));
    expect(computeDetachedWindows(windows, 'self')).toEqual([]);
  });
});

describe('computeSpaceWindows — quale gruppo vive in quale finestra', () => {
  test('mappa spaceId → windowLabel, e ignora chi non dichiara uno spazio', () => {
    const windows = byId(
      win({ windowId: 'main', detached: false, topicIds: ['a'] }),
      win({ windowId: 'w2', windowLabel: 'space-aa', detached: true, spaceId: 'space:1', topicIds: ['b'] }),
    );
    const map = computeSpaceWindows(windows, 'main');
    expect([...map]).toEqual([['space:1', 'space-aa']]);
  });

  test('esclude sé stessa per ID e per LABEL (lo stesso windowId può rinascere)', () => {
    const windows = byId(
      win({ windowId: 'self', windowLabel: 'space-aa', spaceId: 'space:1', topicIds: ['a'] }),
      win({ windowId: 'altro-id', windowLabel: 'space-aa', spaceId: 'space:1', topicIds: ['a'] }),
      win({ windowId: 'w3', windowLabel: 'space-bb', spaceId: 'space:2', topicIds: ['c'] }),
    );
    const map = computeSpaceWindows(windows, 'self', 'space-aa');
    expect([...map]).toEqual([['space:2', 'space-bb']]);
  });

  test('una finestra senza label non è raggiungibile: non entra in mappa', () => {
    const windows = byId(win({ windowId: 'w2', spaceId: 'space:1', topicIds: ['b'] }));
    expect(computeSpaceWindows(windows, 'self').size).toBe(0);
  });

  test('vuota quando nessuno ha staccato un gruppo', () => {
    const windows = byId(win({ windowId: 'main', detached: false, topicIds: ['a'] }));
    expect(computeSpaceWindows(windows, 'self').size).toBe(0);
  });
});

describe('store.setWindows', () => {
  test('replaces the whole set (full-snapshot, not merge)', () => {
    const store = useWindowPresenceStore.getState();
    store.setWindows([win({ windowId: 'a', topicIds: ['1'] }), win({ windowId: 'b', topicIds: ['2'] })]);
    expect(Object.keys(useWindowPresenceStore.getState().windows).sort()).toEqual(['a', 'b']);
    // A later snapshot dropping 'a' (its socket died) must not leave a stale row.
    store.setWindows([win({ windowId: 'b', topicIds: ['2'] })]);
    expect(Object.keys(useWindowPresenceStore.getState().windows)).toEqual(['b']);
  });
});
// L'esclusione di sé stessa vale anche per `computeSpaceWindows`, e per la
// stessa ragione: `windowId` vive in sessionStorage e ne nasce uno nuovo ogni
// volta che quello storage è vuoto — la stessa finestra Tauri può annunciarsi
// con id diversi. È così che la vecchia sezione "Finestre" mostrava 4
// "principali" con una finestra sola.
describe('computeSpaceWindows — self per label, non solo per id', () => {
  const w = (windowId: string, windowLabel?: string, spaceId?: string): PresenceWindow => ({
    windowId, clientId: `c-${windowId}`, windowLabel, spaceId, topicIds: [],
  });
  const byId = (list: PresenceWindow[]) =>
    Object.fromEntries(list.map((x) => [x.windowId, x]));

  it('una voce col MIO label non è un\'altra finestra, anche con id diverso', () => {
    const windows = byId([w('io', 'space-aa', 'space:1'), w('altro-contesto-mio', 'space-aa', 'space:1')]);
    expect(computeSpaceWindows(windows, 'io', 'space-aa').size).toBe(0);
  });

  it('senza label self si esclude solo per id (caso web)', () => {
    const windows = byId([w('io', 'space-aa', 'space:1'), w('altra', 'space-bb', 'space:2')]);
    expect([...computeSpaceWindows(windows, 'io')]).toEqual([['space:2', 'space-bb']]);
  });

  it('label self assente o vuoto non filtra niente (nessun collasso accidentale)', () => {
    const windows = byId([w('io', 'space-aa', 'space:1'), w('altra', 'space-aa', 'space:1')]);
    expect([...computeSpaceWindows(windows, 'io', null)]).toEqual([['space:1', 'space-aa']]);
    expect([...computeSpaceWindows(windows, 'io', '')]).toEqual([['space:1', 'space-aa']]);
  });
});

describe('windowTabs — a window is described by ALL its tabs', () => {
  const base = (over: Partial<PresenceWindow>): PresenceWindow => ({
    windowId: 'w', clientId: 'c', topicIds: [], ...over,
  });

  it('returns every announced tab, chat or not', () => {
    const w = base({
      topicIds: ['t-auth'],
      tabs: [
        { id: 't-auth', type: 'chat', title: 'auth flow' },
        { id: 'terminal:cc9', type: 'terminal', title: 'Claude Code' },
        { id: 'browser:c9', type: 'browser' },
      ],
    });
    expect(windowTabs(w).map((t) => t.type)).toEqual(['chat', 'terminal', 'browser']);
  });

  it('a window that announces no tabs falls back to its topics, not to nothing', () => {
    // An older client sends `topicIds` only. Rendering an empty list under its
    // heading would say "this window holds nothing", which is never true.
    const w = base({ topicIds: ['t-ship', 't-auth'] });
    expect(windowTabs(w)).toEqual([
      { id: 't-ship', type: 'chat' },
      { id: 't-auth', type: 'chat' },
    ]);
  });

  it('an empty tabs array is treated as "did not announce", not as "empty window"', () => {
    const w = base({ topicIds: ['t-ship'], tabs: [] });
    expect(windowTabs(w)).toEqual([{ id: 't-ship', type: 'chat' }]);
  });

  it('a window of only non-chat tabs is no longer invisible', () => {
    // The bug this whole field exists for: three terminals and a project used
    // to announce zero topics, so the row rendered as a heading over nothing.
    const w = base({
      topicIds: [],
      tabs: [
        { id: 'terminal:a', type: 'terminal' },
        { id: 'terminal:b', type: 'terminal' },
        { id: 'project:%2Fsrv', type: 'project', title: 'acme-api' },
      ],
    });
    expect(windowTabs(w)).toHaveLength(3);
  });
});
