/**
 * The bus between the sockets that receive `viewers` frames and the hook that
 * folds them. What must hold: a subscriber hears every push for its context
 * and no other; a late subscriber gets the last value while a socket is up
 * and nothing once the last socket is gone; the channel count survives a
 * socket being replaced.
 *
 * @covers VIEWCNT-02
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  attachViewerChannel,
  hasViewerChannel,
  pushViewerCount,
  resetViewerCountBusForTests,
  subscribeViewerCount,
} from './viewerCountBus';

beforeEach(() => resetViewerCountBusForTests());

describe('viewerCountBus', () => {
  test('a push reaches the subscribers of its context only', () => {
    const a: number[] = [];
    const b: number[] = [];
    subscribeViewerCount('a', (n) => a.push(n));
    subscribeViewerCount('b', (n) => b.push(n));
    pushViewerCount('a', 1);
    pushViewerCount('a', 0);
    expect(a).toEqual([1, 0]);
    expect(b).toEqual([]);
  });

  test('a late subscriber gets the last value while a socket is up, nothing after it left', () => {
    const detach = attachViewerChannel('a');
    pushViewerCount('a', 2);
    const late: number[] = [];
    subscribeViewerCount('a', (n) => late.push(n));
    expect(late, 'the server sends the count on open; the hook may subscribe after').toEqual([2]);
    detach();
    const later: number[] = [];
    subscribeViewerCount('a', (n) => later.push(n));
    expect(later, 'a count from a socket that is gone is not a fact about now').toEqual([]);
  });

  test('the channel is counted per socket, and detaching twice is harmless', () => {
    expect(hasViewerChannel('a')).toBe(false);
    const d1 = attachViewerChannel('a');
    const d2 = attachViewerChannel('a');
    d1();
    d1();
    expect(hasViewerChannel('a'), 'the replacement socket is still up').toBe(true);
    d2();
    expect(hasViewerChannel('a')).toBe(false);
  });

  test('unsubscribe stops the delivery', () => {
    const got: number[] = [];
    const off = subscribeViewerCount('a', (n) => got.push(n));
    pushViewerCount('a', 1);
    off();
    pushViewerCount('a', 2);
    expect(got).toEqual([1]);
  });
});
