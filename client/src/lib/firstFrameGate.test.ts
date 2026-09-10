/**
 * The first render waits for the warm chunks, and stops waiting at the cap.
 *
 * @covers PERF-02
 */
import { describe, expect, test } from 'bun:test';
import { awaitWithCap, recordFirstFrameGate, FIRST_FRAME_GATE_KEY, FIRST_FRAME_WARM_CAP_MS } from './firstFrameGate';

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

/**
 * The row a probe reads back. Its FORMAT is the contract — a probe that reloads
 * the page parses it, so a change here is a change to a measurement tool.
 */
describe('recordFirstFrameGate', () => {
  /** Installs a fake sessionStorage, removes it afterwards: a DOM global left
   *  behind poisons every test file that runs after this one in the same
   *  process (see `scripts/check-test-globals.ts`). */
  function withSessionStorage(body: (read: () => string | null) => void): void {
    const store = new Map<string, string>();
    const g = globalThis as Record<string, unknown>;
    const had = 'sessionStorage' in g;
    const before = g.sessionStorage;
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    try {
      body(() => store.get(FIRST_FRAME_GATE_KEY) ?? null);
    } finally {
      if (had) g.sessionStorage = before;
      else delete g.sessionStorage;
    }
  }

  test('a settled gate writes how long the render waited, rounded to the ms', () => {
    withSessionStorage((read) => {
      recordFirstFrameGate('settled', 41.6);
      expect(read()).toBe('settled:42');
    });
  });

  test('a capped gate says so instead of writing the cap as if it were a measure', () => {
    withSessionStorage((read) => {
      recordFirstFrameGate('capped', 301.2);
      expect(read()).toBe('capped');
    });
  });

  test('storage denied (private mode) must not take the boot down with it', () => {
    const g = globalThis as Record<string, unknown>;
    const had = 'sessionStorage' in g;
    g.sessionStorage = { setItem: () => { throw new Error('QuotaExceededError'); } };
    try {
      expect(() => recordFirstFrameGate('settled', 10)).not.toThrow();
    } finally {
      if (!had) delete g.sessionStorage;
    }
  });
});
