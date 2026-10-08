/**
 * @covers DRAGFR-01
 */
import { describe, expect, test } from 'bun:test';
import { reflowTransform } from './sortableReflow';

const identity = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

describe('reflowTransform', () => {
  test('a neighbour the gap does not reach draws no transform, like a card outside the drag', () => {
    expect(reflowTransform(identity, false)).toBeUndefined();
    expect(reflowTransform(null, false)).toBeUndefined();
  });

  test('a neighbour the gap moves draws the move', () => {
    expect(reflowTransform({ ...identity, y: -64 }, false)).toBe('translate3d(0px, -64px, 0) scaleX(1) scaleY(1)');
    expect(reflowTransform({ ...identity, x: 12 }, false)).toBe('translate3d(12px, 0px, 0) scaleX(1) scaleY(1)');
  });

  test('the card in hand never moves: the overlay is the one that follows the pointer', () => {
    expect(reflowTransform({ ...identity, y: 40 }, true)).toBeUndefined();
  });

  test('the same transform is the same string, so a memoized body sees no change', () => {
    expect(reflowTransform({ ...identity, y: 8 }, false)).toBe(reflowTransform({ ...identity, y: 8 }, false)!);
  });
});
