/**
 * @covers CHAT-HIST-01
 */
import { describe, expect, test } from 'bun:test';
import { countItemsAddedAbove } from './itemsAddedAbove';
import type { CoalescedMessage } from './coalesceToolRun';

const item = (id: string): CoalescedMessage => ({ id, role: 'user', content: id, timestamp: '2026-09-05T00:00:00.000Z' });
const none = new Map<string, string>();

describe('countItemsAddedAbove: what firstItemIndex has to decrease by', () => {
  test('two pages prepended above the first item count as their length', () => {
    const prev = [item('c'), item('d')];
    const next = [item('a'), item('b'), item('c'), item('d')];
    expect(countItemsAddedAbove(prev, next, none)).toBe(2);
  });

  test('an append is not a prepend', () => {
    const prev = [item('a'), item('b')];
    const next = [...prev, item('c')];
    expect(countItemsAddedAbove(prev, next, none)).toBe(0);
  });

  test('the old first item absorbed by a carrier that grew backwards is found through carrierById', () => {
    // `c` was the head of a tool run; the older page brought `a` and `b`, and
    // `b` is work-only too, so the run now starts at `b` and `c` is merged in.
    const prev = [item('c'), item('d')];
    const carrier: CoalescedMessage = { ...item('b'), mergedIds: ['b', 'c'] };
    const next = [item('a'), carrier, item('d')];
    expect(countItemsAddedAbove(prev, next, new Map([['c', 'b']]))).toBe(1);
  });

  test('a list replaced wholesale, or an empty side, is zero', () => {
    expect(countItemsAddedAbove([item('x')], [item('a'), item('b')], none)).toBe(0);
    expect(countItemsAddedAbove([], [item('a')], none)).toBe(0);
    expect(countItemsAddedAbove([item('a')], [], none)).toBe(0);
  });

  test('the same first object short-circuits without a lookup', () => {
    const a = item('a');
    const prev = [a];
    const next = [a, item('b')];
    // A carrier map that would lie if it were consulted.
    expect(countItemsAddedAbove(prev, next, new Map([['a', 'b']]))).toBe(0);
  });
});
