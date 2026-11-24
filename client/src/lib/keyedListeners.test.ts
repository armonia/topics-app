/**
 * The keyed registry behind the viewer-count bus and the client stores: a
 * subscriber hears only its own key, and unsubscribing drops it.
 *
 * @covers VIEWCNT-02
 */
import { describe, expect, test } from 'bun:test';
import { createKeyedListeners } from './keyedListeners';

describe('createKeyedListeners', () => {
  test('emit reaches only the listeners of that key, with the arguments', () => {
    const l = createKeyedListeners<string, (n: number) => void>();
    const a: number[] = [];
    const b: number[] = [];
    l.subscribe('a', (n) => a.push(n));
    l.subscribe('b', (n) => b.push(n));
    l.emit('a', 7);
    expect(a).toEqual([7]);
    expect(b).toEqual([]);
  });

  test('unsubscribe stops delivery and drops the empty key', () => {
    const l = createKeyedListeners<string>();
    let calls = 0;
    const off = l.subscribe('k', () => calls++);
    expect(l.size('k')).toBe(1);
    off();
    off();
    l.emit('k');
    expect(calls).toBe(0);
    expect(l.size('k')).toBe(0);
  });

  test('a listener unsubscribing during emit does not skip the others', () => {
    const l = createKeyedListeners<string>();
    const seen: string[] = [];
    const offFirst = l.subscribe('k', () => {
      seen.push('first');
      offFirst();
    });
    l.subscribe('k', () => seen.push('second'));
    l.emit('k');
    l.emit('k');
    expect(seen).toEqual(['first', 'second', 'second']);
  });

  test('clear forgets every key', () => {
    const l = createKeyedListeners<string>();
    let calls = 0;
    l.subscribe('x', () => calls++);
    l.clear();
    l.emit('x');
    expect(calls).toBe(0);
  });
});
