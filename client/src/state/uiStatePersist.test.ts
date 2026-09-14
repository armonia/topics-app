/**
 * The flight cap of the ui-state writer: a PUT that never answers must not hold
 * a key's inbound frames hostage for the whole session. The abort releases the
 * write exactly like a network failure, so the frame waiting behind it lands.
 * @covers BROWSER-STATE-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createUiStatePersister } from './uiStatePersist';

describe('uiStatePersist (flight cap)', () => {
  const REAL_FETCH = globalThis.fetch;
  beforeEach(() => {
    // A server that never answers, but honours the abort signal like fetch does.
    (globalThis as unknown as { fetch: unknown }).fetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
      });
  });
  afterEach(() => { (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH; });

  test('a PUT that never answers releases the frame it was holding', async () => {
    const applied: unknown[] = [];
    const writes = createUiStatePersister({
      putTimeoutMs: 20,
      onDeferredFrame: (_key, value) => { applied.push(value); },
    });
    writes.put('topic-browser:cap', { mine: true }, 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(writes.admitFrame('topic-browser:cap', { theirs: true }, 7)).toBe('deferred');
    expect(applied).toEqual([]);

    await new Promise((r) => setTimeout(r, 60));
    expect(applied).toEqual([{ theirs: true }]);
    expect(writes.isPending('topic-browser:cap')).toBe(false);
  });

  test('a read overtaken by a write is reported stale', () => {
    const writes = createUiStatePersister();
    const token = writes.writeToken('topic-browser:token');
    expect(writes.wroteSince('topic-browser:token', token)).toBe(false);
    writes.put('topic-browser:token', { v: 1 }, 800);
    expect(writes.wroteSince('topic-browser:token', token)).toBe(true);
    writes.cancelAll();
  });
});
