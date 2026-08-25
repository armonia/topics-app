/**
 * @covers PANE-05
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  recordAction,
  getRing,
  clearRing,
  subscribe,
} from '../middleware/mutationLog';

describe('MutationLogOverlay wiring (PANE-05)', () => {
  beforeEach(() => clearRing());

  test('subscribers fire when new actions are recorded', () => {
    let fires = 0;
    const unsub = subscribe(() => {
      fires++;
    });
    recordAction({ seq: 1, ts: 1, action: { type: 'OPEN_PANE' } });
    recordAction({ seq: 2, ts: 2, action: { type: 'CLOSE_PANE' } });
    expect(fires).toBe(2);
    unsub();
  });

  test('getRing reflects all recorded actions', () => {
    recordAction({ seq: 10, ts: 10, action: { type: 'OPEN_PANE' } });
    recordAction({ seq: 11, ts: 11, action: { type: 'CLOSE_PANE' } });
    const ring = getRing();
    expect(ring.map((r) => r.seq)).toEqual([10, 11]);
  });

  test('clearRing empties the buffer', () => {
    recordAction({ seq: 20, ts: 20, action: { type: 'OPEN_PANE' } });
    clearRing();
    expect(getRing()).toHaveLength(0);
  });
});
