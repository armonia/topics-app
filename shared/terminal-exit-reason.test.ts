/**
 * The exit code survives the trip on the close reason.
 *
 * @covers TERM-12
 */
import { describe, expect, it } from 'bun:test';
import { decodeExitReason, encodeExitReason } from './terminal-messages';

describe('the exit code on a close reason', () => {
  it('makes the round trip, zero and negative included', () => {
    for (const code of [0, 1, 137, -1]) {
      expect(decodeExitReason(encodeExitReason('ended', code))).toBe(code);
    }
  });

  it('leaves the bare word when there is no code', () => {
    expect(encodeExitReason('dormant', null)).toBe('dormant');
    expect(decodeExitReason('dormant')).toBeNull();
  });

  it('reads nothing out of a reason nobody encoded', () => {
    expect(decodeExitReason('Session ended')).toBeNull();
    expect(decodeExitReason(undefined)).toBeNull();
  });
});
