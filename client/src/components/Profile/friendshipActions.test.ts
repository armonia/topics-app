import { describe, it, expect } from 'bun:test';
import { friendshipButtons, friendshipNoteKey } from './friendshipActions';
import type { FriendshipState } from '../../../../shared/friendship';

const ALL: FriendshipState[] = ['none', 'pending_out', 'pending_in', 'friends', 'declined_out'];

describe('friendshipButtons', () => {
  it('gives every state at least one thing to press', () => {
    for (const s of ALL) expect(friendshipButtons(s).length).toBeGreaterThan(0);
  });

  it('does NOT tell the person they were refused', () => {
    // The rule of `shared/friendship.ts`: a refusal closes the door for whoever
    // knocked, and the screen keeps saying what it said while waiting. If this
    // ever fails, the refusal has become visible to the person refused.
    expect(friendshipButtons('declined_out')).toEqual(friendshipButtons('pending_out'));
    expect(friendshipNoteKey('declined_out')).toBe(friendshipNoteKey('pending_out'));
  });

  it('offers the answer only to the side that was asked', () => {
    const asked = friendshipButtons('pending_in').map((b) => b.action);
    expect(asked).toEqual(['accept', 'decline']);
    // The person who sent it must never see an Accept button for their own
    // request: that was the concrete defect the relative state exists to stop.
    for (const s of ['none', 'pending_out', 'declined_out', 'friends'] as FriendshipState[]) {
      expect(friendshipButtons(s).some((b) => b.action === 'accept')).toBe(false);
    }
  });

  it('asks only from `none`', () => {
    const canAsk = ALL.filter((s) => friendshipButtons(s).some((b) => b.action === 'request'));
    expect(canAsk).toEqual(['none']);
  });

  it('gives exactly one primary action, never two', () => {
    for (const s of ALL) {
      const primaries = friendshipButtons(s).filter((b) => b.tone === 'primary');
      expect(primaries.length).toBeLessThanOrEqual(1);
    }
  });

  it('uses distinct test ids per state so an e2e cannot match the wrong one', () => {
    for (const s of ALL) {
      const ids = friendshipButtons(s).map((b) => b.testId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
