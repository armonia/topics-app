/**
 * @covers USAGE-30
 * The pause store: a `project:quota` frame flips the entry for every reader at
 * once, a malformed frame changes nothing, and `reason` is dropped when the
 * project is not paused.
 */
import { beforeEach, expect, test } from 'bun:test';
import { applyProjectPause, getProjectPause, resetProjectPauses } from './useProjectPause';

beforeEach(() => resetProjectPauses());

test('a frame opens the pause and the next one closes it', () => {
  expect(getProjectPause('p1').paused).toBe(false);
  expect(applyProjectPause({ type: 'project:quota', projectId: 'p1', paused: true, reason: 'limit', limit: 10, points24h: 12 })).toBe(true);
  expect(getProjectPause('p1')).toEqual({ paused: true, reason: 'limit', limit: 10, points24h: 12 });
  expect(getProjectPause('p2').paused).toBe(false);
  applyProjectPause({ type: 'project:quota', projectId: 'p1', paused: false, reason: 'limit', limit: 10, points24h: 12 });
  expect(getProjectPause('p1')).toEqual({ paused: false, reason: null, limit: 10, points24h: 12 });
});

test('a malformed frame is refused and leaves the state alone', () => {
  applyProjectPause({ projectId: 'p1', paused: true, reason: 'hold-until-tomorrow', limit: null, points24h: null });
  expect(applyProjectPause({ projectId: 'p1' })).toBe(false);
  expect(applyProjectPause(null)).toBe(false);
  expect(getProjectPause('p1').reason).toBe('hold-until-tomorrow');
});
