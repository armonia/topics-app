/**
 * Tests for the cross-window presence store's PURE selectors — the logic that
 * projects the WS `presence:windows` snapshot into "open in another window"
 * affordances. The invariants worth pinning:
 *   - a topic open in THIS window is never "open elsewhere" (self excluded);
 *   - first-seen wins when the same topic is in several other windows;
 *   - only DETACHED windows drive the marker (not plain browser tabs);
 *   - setWindows replaces the whole set (full-snapshot semantics, self-healing).
 */
import { describe, test, it, expect } from 'bun:test';
import {
  computeDetachedTopicMap,
  computeDetachedWindows,
  computeOtherWindows,
  useWindowPresenceStore,
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

describe('computeOtherWindows', () => {
  // The sidebar's "Finestre" section must list where things are open. Reusing
  // computeDetachedWindows there hid the MAIN window from a detached window's
  // own sidebar — it lists siblings but not the window it was torn off from.
  test('includes the NON-detached (main) window, unlike computeDetachedWindows', () => {
    const windows = byId(
      win({ windowId: 'self', detached: true, topicIds: ['a'] }),
      win({ windowId: 'main', detached: false, topicIds: ['b'] }),
      win({ windowId: 'w3', detached: true, topicIds: ['c'] }),
    );
    expect(computeDetachedWindows(windows, 'self').map((w) => w.windowId)).toEqual(['w3']);
    expect(computeOtherWindows(windows, 'self').map((w) => w.windowId)).toEqual(['main', 'w3']);
  });

  test('always excludes self', () => {
    const windows = byId(
      win({ windowId: 'self', detached: false, topicIds: ['a'] }),
      win({ windowId: 'w2', detached: true, topicIds: ['b'] }),
    );
    expect(computeOtherWindows(windows, 'self').map((w) => w.windowId)).toEqual(['w2']);
  });

  test('orders the main window(s) before the detached ones', () => {
    const windows = byId(
      win({ windowId: 'd1', detached: true, topicIds: ['a'] }),
      win({ windowId: 'main', detached: false, topicIds: ['b'] }),
      win({ windowId: 'd2', detached: true, topicIds: ['c'] }),
    );
    expect(computeOtherWindows(windows, 'self').map((w) => w.windowId)).toEqual(['main', 'd1', 'd2']);
  });

  test('empty when this is the only window', () => {
    const windows = byId(win({ windowId: 'self', detached: false, topicIds: ['a'] }));
    expect(computeOtherWindows(windows, 'self')).toEqual([]);
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

// ── Contesti della PROPRIA finestra, non altre finestre ────────────────────
//
// `windowId` vive in sessionStorage e ne nasce uno nuovo ogni volta che quello
// storage è vuoto: la stessa finestra Tauri può annunciarsi con id diversi. È
// così che la sezione "Finestre" mostrava 4 "principali" con una finestra sola.
describe('computeOtherWindows — self per label, non solo per id', () => {
  const w = (windowId: string, windowLabel?: string, detached?: boolean): PresenceWindow => ({
    windowId, clientId: `c-${windowId}`, windowLabel, detached, topicIds: [],
  });
  const byId = (list: PresenceWindow[]) =>
    Object.fromEntries(list.map((x) => [x.windowId, x]));

  it('una voce col MIO label non è un\'altra finestra, anche con id diverso', () => {
    const windows = byId([w('io', 'main'), w('altro-contesto-mio', 'main')]);
    expect(computeOtherWindows(windows, 'io', 'main')).toEqual([]);
  });

  it('senza label si esclude solo per id (caso web: le altre tab CI SONO)', () => {
    const windows = byId([w('io'), w('altra-tab')]);
    expect(computeOtherWindows(windows, 'io').map((x) => x.windowId)).toEqual(['altra-tab']);
  });

  it('una finestra STACCATA resta visibile: ha un label suo', () => {
    const windows = byId([w('io', 'main'), w('d1', 'detach-1', true)]);
    expect(computeOtherWindows(windows, 'io', 'main').map((x) => x.windowId)).toEqual(['d1']);
  });

  it('label self assente o vuoto non filtra niente (nessun collasso accidentale)', () => {
    const windows = byId([w('io', 'main'), w('altra', 'main')]);
    expect(computeOtherWindows(windows, 'io', null).map((x) => x.windowId)).toEqual(['altra']);
    expect(computeOtherWindows(windows, 'io', '').map((x) => x.windowId)).toEqual(['altra']);
  });
});
