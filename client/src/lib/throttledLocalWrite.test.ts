/**
 * @covers STORAGE-WAL-01
 */
import { describe, expect, test } from 'bun:test';
import { createThrottledLocalWriter, type WriterStorage } from './throttledLocalWrite';

/** A hand-driven clock: the test decides when the window expires. */
function fakeClock() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => { timers.set(++seq, fn); return seq; },
    cancel: (handle: unknown) => { timers.delete(handle as number); },
    /** Expires every timer armed right now. */
    tick: () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, fn] of due) fn();
    },
    get armed() { return timers.size; },
  };
}

/** A storage that counts what actually reached it, in calls and in bytes. */
function countingStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  let bytes = 0;
  const storage: WriterStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
      writes.push(value);
      bytes += value.length;
    },
  };
  return { storage, writes, get bytes() { return bytes; }, data };
}

describe('throttled local writer', () => {
  test('a burst of writes costs one setItem, and the last value wins', () => {
    const clock = fakeClock();
    const store = countingStorage();
    const writer = createThrottledLocalWriter({
      key: 'topics-cache',
      storage: store.storage,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    writer.write('a');
    writer.write('b');
    writer.write('c');
    expect(store.writes).toHaveLength(0); // nothing before the window closes

    clock.tick();
    expect(store.writes).toEqual(['c']);
  });

  test('an unchanged value never reaches the journal', () => {
    const clock = fakeClock();
    const store = countingStorage({ 'topics-cache': 'same' });
    const writer = createThrottledLocalWriter({
      key: 'topics-cache',
      storage: store.storage,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    writer.write('same');
    clock.tick();
    expect(store.writes).toHaveLength(0);
    expect(store.bytes).toBe(0);

    // A real change still goes through.
    writer.write('other');
    clock.tick();
    expect(store.writes).toEqual(['other']);
  });

  test('a value written by another window is seen: the skip reads storage, not memory', () => {
    const clock = fakeClock();
    const store = countingStorage();
    const writer = createThrottledLocalWriter({
      key: 'topics-cache',
      storage: store.storage,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    writer.write('v1');
    clock.tick();
    expect(store.writes).toEqual(['v1']);

    // Another window overwrites the key behind this writer's back.
    store.data.set('topics-cache', 'from-the-other-window');

    // The same value this writer already wrote is NOT the value in storage now,
    // so it must be written again. An in-memory "last written" would skip it
    // and leave the other window's value in place forever.
    writer.write('v1');
    clock.tick();
    expect(store.writes).toEqual(['v1', 'v1']);
  });

  test('flush writes the pending value now and disarms the window', () => {
    const clock = fakeClock();
    const store = countingStorage();
    const writer = createThrottledLocalWriter({
      key: 'topics-cache',
      storage: store.storage,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    writer.write('closing');
    writer.flush();
    expect(store.writes).toEqual(['closing']);
    expect(clock.armed).toBe(0);

    // The expired window must not write a second time.
    clock.tick();
    expect(store.writes).toEqual(['closing']);
  });

  test('flush with nothing pending is a no-op', () => {
    const clock = fakeClock();
    const store = countingStorage({ 'topics-cache': 'stored' });
    const writer = createThrottledLocalWriter({
      key: 'topics-cache',
      storage: store.storage,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    writer.flush();
    expect(store.writes).toHaveLength(0);
  });

  test('the window is fixed, not sliding: a continuous stream still lands', () => {
    const clock = fakeClock();
    const store = countingStorage();
    const writer = createThrottledLocalWriter({
      key: 'topics-cache',
      storage: store.storage,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    // Writes never stop arriving. With a sliding debounce the timer would be
    // pushed forward by each one and nothing would ever be persisted.
    for (let i = 0; i < 100; i++) writer.write(`v${i}`);
    clock.tick();
    expect(store.writes).toEqual(['v99']);
  });

  test('a thunk is called once per flush, not once per write', () => {
    const clock = fakeClock();
    const store = countingStorage();
    const writer = createThrottledLocalWriter({
      key: 'topics-cache',
      storage: store.storage,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    // Serialising the value is the expensive half of the write: inside a burst
    // it must be paid once, for the string that actually lands.
    let built = 0;
    for (let i = 0; i < 24; i++) {
      writer.write(() => { built += 1; return `serialised-${i}`; });
    }
    expect(built).toBe(0);

    clock.tick();
    expect(built).toBe(1);
    expect(store.writes).toEqual(['serialised-23']);
  });

  test('a storage that throws does not take the caller down', () => {
    const clock = fakeClock();
    const throwing: WriterStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    const writer = createThrottledLocalWriter({
      key: 'topics-cache',
      storage: throwing,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    writer.write('anything');
    expect(() => clock.tick()).not.toThrow();
  });
});
