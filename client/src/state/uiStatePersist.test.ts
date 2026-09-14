/**
 * The ui-state writer's arbitration, guard by guard. The store-level tests prove
 * the two divergences are closed; these pin the single decisions that make it
 * work, because each one could be dropped and the store tests stayed green:
 * the line under which a frame is our own past, the flight COUNTER, the queued
 * edit that outranks a held frame, keeping the NEWEST of two held frames, the
 * read owed to a resync that skipped the key, and the flight cap (with its
 * fallback for an engine without `AbortSignal.timeout`).
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

  // First use of AbortSignal.timeout in this client. On an engine without it
  // (WebKit before 16) the call threw AFTER the flight had been counted, so the
  // key stayed "in the air" for good and every frame for it was held forever.
  test('an engine without AbortSignal.timeout still caps the flight', async () => {
    const carrier = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
    const real = carrier.timeout;
    delete carrier.timeout;
    try {
      const applied: unknown[] = [];
      const writes = createUiStatePersister({
        putTimeoutMs: 20,
        onDeferredFrame: (_key, value) => { applied.push(value); },
      });
      writes.put('topic-browser:no-timeout-api', { mine: true }, 0);
      await new Promise((r) => setTimeout(r, 5));
      expect(writes.admitFrame('topic-browser:no-timeout-api', { theirs: true }, 7)).toBe('deferred');

      await new Promise((r) => setTimeout(r, 60));
      expect(applied).toEqual([{ theirs: true }]);
      expect(writes.isPending('topic-browser:no-timeout-api')).toBe(false);
    } finally {
      if (real) carrier.timeout = real;
    }
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

describe('uiStatePersist (the guards, one by one)', () => {
  const REAL_FETCH = globalThis.fetch;
  const KEY = 'topic-browser:guards';
  let answers: ((seq: number | null) => void)[];

  beforeEach(() => {
    answers = [];
    // Every PUT parks its answer; the test hands it over with a server_seq, or
    // with null for a rejected write.
    (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> =>
      new Promise<Response>((resolve) => {
        answers.push((seq) => resolve(seq === null
          ? new Response('no', { status: 500 })
          : new Response(JSON.stringify({ server_seq: seq }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
      });
  });
  afterEach(() => { (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH; });

  const tick = () => new Promise((r) => setTimeout(r, 5));
  const adopting = () => {
    const adopted: unknown[] = [];
    const reads: string[] = [];
    const writes = createUiStatePersister({
      onDeferredFrame: (_key, value) => { adopted.push(value); },
      onReadNeeded: (key) => { reads.push(key); },
    });
    return { writes, adopted, reads };
  };

  test('after the answer, a frame at or below our confirmed seq is our own past', async () => {
    const { writes } = adopting();
    writes.put(KEY, { v: 1 }, 0);
    await tick();
    answers[0]!(105);
    await tick();

    expect(writes.admitFrame(KEY, { v: 0 }, 104)).toBe('drop');
    expect(writes.admitFrame(KEY, { v: 0 }, 105)).toBe('drop');
    expect(writes.admitFrame(KEY, { v: 2 }, 106)).toBe('apply');
  });

  test('the first of two flights on one key does not release the frame', async () => {
    const { writes, adopted } = adopting();
    writes.put(KEY, { v: 1 }, 0);
    await tick();
    writes.put(KEY, { v: 2 }, 0);
    await tick();
    expect(answers.length).toBe(2);

    expect(writes.admitFrame(KEY, { theirs: true }, 120)).toBe('deferred');
    answers[0]!(105);
    await tick();
    expect(adopted).toEqual([]);            // the second write is still unresolved
    expect(writes.isPending(KEY)).toBe(true);

    answers[1]!(106);
    await tick();
    expect(adopted).toEqual([{ theirs: true }]);
  });

  test('an edit queued during the flight outranks the frame held behind it', async () => {
    const { writes, adopted } = adopting();
    writes.put(KEY, { v: 1 }, 0);
    await tick();
    expect(writes.admitFrame(KEY, { theirs: true }, 120)).toBe('deferred');

    writes.put(KEY, { v: 2 }, 20);          // local edit made while the PUT travels
    answers[0]!(105);
    await tick();
    expect(adopted).toEqual([]);            // our un-sent edit is newer than the frame

    await tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(answers.length).toBe(2);         // and it does leave, after the first one
    answers[1]!(106);
    await tick();
  });

  test('of two frames held during one flight, the newer one is adopted', async () => {
    const { writes, adopted } = adopting();
    writes.put(KEY, { v: 1 }, 0);
    await tick();
    writes.admitFrame(KEY, { theirs: 'older' }, 118);
    writes.admitFrame(KEY, { theirs: 'newer' }, 120);
    writes.admitFrame(KEY, { theirs: 'older again' }, 119);

    answers[0]!(105);
    await tick();
    expect(adopted).toEqual([{ theirs: 'newer' }]);
  });

  test('a read owed to a resync is asked for when the write settles', async () => {
    const { writes, reads } = adopting();
    writes.put(KEY, { v: 1 }, 0);
    await tick();
    writes.deferRead(KEY);                  // the resync skipped this key
    expect(reads).toEqual([]);

    answers[0]!(105);
    await tick();
    expect(reads).toEqual([KEY]);
  });

  test('a forgotten record owes no read', async () => {
    const { writes, reads } = adopting();
    writes.put(KEY, { v: 1 }, 0);
    await tick();
    writes.deferRead(KEY);
    writes.cancel(KEY);                     // the task/topic was archived

    answers[0]!(105);
    await tick();
    expect(reads).toEqual([]);
  });
});
