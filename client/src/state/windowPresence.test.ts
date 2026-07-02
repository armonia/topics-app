/**
 * Tests for the cross-window presence store's PURE selectors — the logic that
 * projects the WS `presence:windows` snapshot into "open in another window"
 * affordances. The invariants worth pinning:
 *   - a topic open in THIS window is never "open elsewhere" (self excluded);
 *   - first-seen wins when the same topic is in several other windows;
 *   - only DETACHED windows drive the marker (not plain browser tabs);
 *   - setWindows replaces the whole set (full-snapshot semantics, self-healing).
 */
import { describe, test, expect } from 'bun:test';
import {
  computeDetachedTopicMap,
  computeDetachedWindows,
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
