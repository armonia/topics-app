/**
 * @covers TABPOS-04
 */
import { describe, expect, test } from 'bun:test';
import { moveInOrder, orderByHand } from './listOrder';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((r) => r.id);

describe('orderByHand: the order the person gave, new rows on top', () => {
  test('no order yet: the rows keep the order they came in', () => {
    expect(ids(orderByHand(rows('a', 'b', 'c'), []))).toEqual(['a', 'b', 'c']);
  });

  test('known rows follow the order, unknown ones go on top', () => {
    expect(ids(orderByHand(rows('new', 'a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['new', 'c', 'a', 'b']);
  });

  test('a row that wants attention does not jump: the order decides', () => {
    // The incoming list puts the lit row first (activity sort); the hand order wins.
    expect(ids(orderByHand(rows('lit', 'x'), ['x', 'lit']))).toEqual(['x', 'lit']);
  });
});

describe('moveInOrder: a drag writes the whole visible order', () => {
  test('moves a row before another', () => {
    expect(moveInOrder(['a', 'b', 'c'], [], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  test('drops at the end', () => {
    expect(moveInOrder(['a', 'b', 'c'], [], 'a', null)).toEqual(['b', 'c', 'a']);
  });

  test('rows hidden from the screen keep their place after the visible ones', () => {
    expect(moveInOrder(['a', 'b'], ['a', 'hidden', 'b'], 'b', 'a')).toEqual(['b', 'a', 'hidden']);
  });
});
