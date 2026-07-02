/**
 * Tests for the pure cross-window presence snapshot builder. The contract:
 *   - sockets that haven't announced (no windowId) are skipped;
 *   - duplicate windowIds (reconnect race) collapse to the first;
 *   - each entry carries clientId + label + detached + topics + focus;
 *   - dropping a socket from the input drops it from the snapshot (self-heal).
 */
import { describe, test, expect } from 'bun:test';
import { buildPresenceSnapshot, type PresenceSource } from './presence';

const src = (over: Partial<PresenceSource> & { id: string }): PresenceSource => ({ ...over });

describe('buildPresenceSnapshot', () => {
  test('skips sockets that never announced a windowId', () => {
    const out = buildPresenceSnapshot([
      src({ id: 'sock-1' }),
      src({ id: 'sock-2', windowId: 'w2', presenceTopicIds: ['a'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].windowId).toBe('w2');
    expect(out[0].clientId).toBe('sock-2');
    expect(out[0].topicIds).toEqual(['a']);
  });

  test('carries label, detached flag, and focused topic', () => {
    const out = buildPresenceSnapshot([
      src({
        id: 'sock-1',
        windowId: 'w1',
        windowLabel: 'detach-abc',
        detached: true,
        presenceTopicIds: ['t1', 't2'],
        presenceFocusedTopicId: 't2',
      }),
    ]);
    expect(out[0]).toEqual({
      windowId: 'w1',
      clientId: 'sock-1',
      windowLabel: 'detach-abc',
      detached: true,
      topicIds: ['t1', 't2'],
      focusedTopicId: 't2',
    });
  });

  test('collapses duplicate windowIds to the first (reconnect race)', () => {
    const out = buildPresenceSnapshot([
      src({ id: 'old', windowId: 'w1', presenceTopicIds: ['stale'] }),
      src({ id: 'new', windowId: 'w1', presenceTopicIds: ['fresh'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].clientId).toBe('old');
  });

  test('empty topicIds default when none announced', () => {
    const out = buildPresenceSnapshot([src({ id: 's', windowId: 'w' })]);
    expect(out[0].topicIds).toEqual([]);
  });

  test('self-heals: a socket removed from input is absent from the snapshot', () => {
    const alive = [
      src({ id: 's1', windowId: 'w1' }),
      src({ id: 's2', windowId: 'w2' }),
    ];
    expect(buildPresenceSnapshot(alive).map((w) => w.windowId)).toEqual(['w1', 'w2']);
    // w2's socket died → next build omits it, no stale row.
    expect(buildPresenceSnapshot(alive.slice(0, 1)).map((w) => w.windowId)).toEqual(['w1']);
  });
});
