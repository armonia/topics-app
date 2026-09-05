/**
 * The first render waits for the warm chunks, and stops waiting at the cap.
 *
 * @covers PERF-02
 */
import { describe, expect, test } from 'bun:test';
import { awaitWithCap, FIRST_FRAME_WARM_CAP_MS } from './firstFrameGate';

describe('awaitWithCap', () => {
  test('a promise that settles before the cap lets the render go at once', async () => {
    const started = performance.now();
    expect(await awaitWithCap(Promise.resolve(), 1000)).toBe('settled');
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('a promise that never settles is cut at the cap', async () => {
    const started = performance.now();
    expect(await awaitWithCap(new Promise(() => {}), 20)).toBe('capped');
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
  });

  test('a rejected promise counts as settled: the boundary reports the failure, not the gate', async () => {
    expect(await awaitWithCap(Promise.reject(new Error('chunk 404')), 1000)).toBe('settled');
  });

  test('the cap is short enough to be invisible on a cold boot', () => {
    expect(FIRST_FRAME_WARM_CAP_MS).toBeLessThanOrEqual(300);
  });
});
