/**
 * A parked split has a deadline, so it can't fire hours after it was asked for.
 *
 * @covers LAYOUT-01
 */
import { describe, it, expect } from 'bun:test';
import { companionSplitIsFresh, COMPANION_SPLIT_TTL_MS } from './companionSplit';

describe('companionSplitIsFresh', () => {
  it('a companion arriving within the round-trip still splits', () => {
    expect(companionSplitIsFresh(1_000, 1_000)).toBe(true);
    expect(companionSplitIsFresh(1_000, 1_000 + COMPANION_SPLIT_TTL_MS - 1)).toBe(true);
  });

  it('drops the intent once the window has passed', () => {
    expect(companionSplitIsFresh(1_000, 1_000 + COMPANION_SPLIT_TTL_MS)).toBe(false);
    // The reported case: a tab added by hand much later must not replay it.
    expect(companionSplitIsFresh(1_000, 1_000 + 3_600_000)).toBe(false);
  });
});
