/**
 * The paused still is kept at the slot's CSS size, never at device size: a 2x
 * snapshot held for as long as a pane stays paused is four times the memory.
 *
 * @covers BROWSER-HEAVY-04
 */
import { describe, expect, test } from 'bun:test';
import { stillSize, toPausedStill } from './pausedStill';

describe('stillSize', () => {
  test('returns the CSS size of the slot, rounded, never the device size', () => {
    expect(stillSize(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(stillSize(399.6, 300.2)).toEqual({ width: 400, height: 300 });
  });

  test('a collapsed slot still gets a drawable size', () => {
    expect(stillSize(0, -3)).toEqual({ width: 1, height: 1 });
  });

  test('without a DOM there is no still, and the card falls back to the neutral surface', async () => {
    expect(await toPausedStill('data:image/png;base64,', 100, 100)).toBeNull();
  });
});
