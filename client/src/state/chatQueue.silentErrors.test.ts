/**
 * @covers CLIENT-SILENT-ERR-01
 * Two silent swallows in the turn queue, closed by card
 * `4c8d4432-5742-4f9f-aad8-995221c6b7eb`:
 *
 *   - `setItem` throwing (quota, denied access) used to vanish with no
 *     signal: the undelivered queue was lost on reload with nobody told.
 *     Now it warns and `hasQueuePersistError` exposes it to the caller.
 *   - a queue listener that throws used to vanish with no log.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { __setQueueStorage, claimBatch, enqueueTurn, hasQueuePersistError, holdQueue, releaseHold, subscribeQueue } from './chatQueue';
import type { QueueStorage } from '../hooks/outboundQueue';

function quotaExceededStorage(): QueueStorage {
  return {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
}

function fakeStorage(): QueueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const SK = 'topic:quota';

beforeEach(() => {
  __setQueueStorage(fakeStorage());
});

describe('a quota error on persist is warned about and exposed to the caller', () => {
  test('setItem throwing warns, and hasQueuePersistError reports it for the session', () => {
    const warnCalls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    try {
      __setQueueStorage(quotaExceededStorage());
      expect(() => enqueueTurn(SK, 'ciao')).not.toThrow();
      expect(warnCalls.some((args) => String(args[0]).includes('[chat-queue]'))).toBe(true);
      expect(hasQueuePersistError(SK)).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });

  test('a later successful persist clears the flag', () => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      __setQueueStorage(quotaExceededStorage());
      enqueueTurn(SK, 'ciao');
      expect(hasQueuePersistError(SK)).toBe(true);

      __setQueueStorage(fakeStorage());
      enqueueTurn(SK, 'di nuovo');
      expect(hasQueuePersistError(SK)).toBe(false);
    } finally {
      console.warn = realWarn;
    }
  });
});

describe('the real browser storage path (chatQueue.ts browserStorage.setItem)', () => {
  test('a localStorage.setItem quota error reaches the caller through browserStorage, not swallowed at the wrapper', () => {
    const g = globalThis as unknown as { localStorage?: unknown };
    const savedLocalStorage = g.localStorage;
    g.localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    const warnCalls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    try {
      // `null` falls back to `browserStorage` now that `localStorage` exists.
      __setQueueStorage(null);
      expect(() => enqueueTurn(SK, 'ciao')).not.toThrow();
      expect(warnCalls.some((args) => String(args[0]).includes('[chat-queue]'))).toBe(true);
      expect(hasQueuePersistError(SK)).toBe(true);
    } finally {
      console.warn = realWarn;
      if (savedLocalStorage === undefined) delete g.localStorage; else g.localStorage = savedLocalStorage;
    }
  });
});

describe('a queue listener that throws is logged, not swallowed', () => {
  test('console.error fires and a second listener still runs', () => {
    const errorCalls: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    let secondRan = false;
    const offFirst = subscribeQueue(SK, () => { throw new Error('boom'); });
    const offSecond = subscribeQueue(SK, () => { secondRan = true; });
    try {
      expect(() => enqueueTurn(SK, 'ciao')).not.toThrow();
      expect(errorCalls.some((args) => String(args[0]).includes('[chat-queue]'))).toBe(true);
      expect(secondRan).toBe(true);
    } finally {
      console.error = realError;
      offFirst();
      offSecond();
    }
  });
});

describe('bookkeeping writes at full quota never throw (Stop and drain must keep working)', () => {
  function withWarnCaptured(fn: () => void): unknown[][] {
    const calls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { calls.push(args); };
    try { fn(); } finally { console.warn = realWarn; }
    return calls;
  }

  test('holdQueue warns instead of throwing', () => {
    __setQueueStorage(quotaExceededStorage());
    const calls = withWarnCaptured(() => { expect(() => holdQueue(SK)).not.toThrow(); });
    expect(calls.some((args) => String(args[0]).includes('[chat-queue]'))).toBe(true);
  });

  test('claimBatch warns instead of throwing', () => {
    __setQueueStorage(quotaExceededStorage());
    const calls = withWarnCaptured(() => { expect(() => claimBatch(SK, 'client-a')).not.toThrow(); });
    expect(calls.some((args) => String(args[0]).includes('[chat-queue]'))).toBe(true);
  });

  test('releaseHold warns instead of throwing', () => {
    const inner = fakeStorage();
    let full = false;
    __setQueueStorage({
      ...inner,
      setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); inner.setItem(k, v); },
    });
    holdQueue(SK, { boot: 'b1', turnId: 1 });
    full = true;
    const calls = withWarnCaptured(() => { expect(() => releaseHold(SK)).not.toThrow(); });
    expect(calls.some((args) => String(args[0]).includes('[chat-queue]'))).toBe(true);
  });
});
