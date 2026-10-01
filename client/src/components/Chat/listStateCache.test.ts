/**
 * A chat list remounted by a group switch or an eviction starts from the sizes
 * it had measured, only when they still describe it.
 *
 * @covers TABSWITCH-02
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { MAX_ENTRIES, clearListStates, listStateFor, saveListState } from './listStateCache';

const snap = (scrollTop: number) => ({ ranges: [{ startIndex: 0, endIndex: 9, size: 40 }], scrollTop });

describe('listStateCache', () => {
  beforeEach(() => clearListStates());

  test('a list that rested at the bottom mounts again from its snapshot', () => {
    saveListState('t1', snap(900), 10, true);
    expect(listStateFor('t1', 10)?.scrollTop).toBe(900);
  });

  test('a list with a different number of items does not use it: the snapshot is by position', () => {
    saveListState('t1', snap(900), 10, true);
    expect(listStateFor('t1', 11)).toBeUndefined();
  });

  test('a list left scrolled up is not snapshotted, and forgets the older snapshot', () => {
    saveListState('t1', snap(900), 10, true);
    saveListState('t1', snap(300), 10, false);
    expect(listStateFor('t1', 10)).toBeUndefined();
  });

  test('an empty list is not snapshotted', () => {
    saveListState('t1', snap(0), 0, true);
    expect(listStateFor('t1', 0)).toBeUndefined();
  });

  test(`at most ${MAX_ENTRIES} lists are kept, the oldest write goes first`, () => {
    for (let i = 0; i <= MAX_ENTRIES; i++) saveListState(`t${i}`, snap(i), 10, true);
    expect(listStateFor('t0', 10)).toBeUndefined();
    expect(listStateFor(`t${MAX_ENTRIES}`, 10)?.scrollTop).toBe(MAX_ENTRIES);
    // A second write of an old key makes it the newest.
    saveListState('t1', snap(1), 10, true);
    saveListState('t-new', snap(0), 10, true);
    expect(listStateFor('t1', 10)).toBeDefined();
    expect(listStateFor('t2', 10)).toBeUndefined();
  });
});
