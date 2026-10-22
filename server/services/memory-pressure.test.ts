import { describe, expect, test } from 'bun:test';
import { createMemoryPressureSignal } from './memory-pressure';

/** @covers LEAK-01 */
describe('memory pressure frame', () => {
  test('sends only verdict transitions and exposes the current state for reconnects', () => {
    const sent: unknown[] = [];
    const signal = createMemoryPressureSignal((frame) => sent.push(frame));

    expect(signal.frame()).toEqual({ type: 'memory:pressure', pressure: false });
    expect(signal.update(false)).toBe(false);
    expect(signal.update(true)).toBe(true);
    expect(signal.update(true)).toBe(false);
    expect(signal.update(false)).toBe(true);
    expect(sent).toEqual([
      { type: 'memory:pressure', pressure: true },
      { type: 'memory:pressure', pressure: false },
    ]);
  });

  test('a reconnect snapshot starts from the restored verdict', () => {
    const signal = createMemoryPressureSignal(() => {}, true);
    expect(signal.frame()).toEqual({ type: 'memory:pressure', pressure: true });
  });
});
