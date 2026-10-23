/**
 * @covers STORAGE-WAL-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { pruneBrowserHistory } from './browserHistoryPrune';

/** A minimal Storage: the three calls the prune makes, in insertion order. */
function fakeStorage(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => { data.delete(k); },
  };
}

describe('pruneBrowserHistory', () => {
  const hadStorage = 'localStorage' in globalThis;
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  let store: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    store = fakeStorage({
      'browser-history-live': '["https://a"]',
      'browser-history-archived': '["https://b"]',
      'browser-history-deleted': '["https://c"]',
      'topics-cache': '{}',
    });
    (globalThis as { localStorage?: unknown }).localStorage = store;
  });

  afterEach(() => {
    // Put back exactly what the file found: the preload flags a leftover global.
    if (hadStorage) (globalThis as { localStorage?: unknown }).localStorage = original;
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test('removes the history of topics that are not in the set, and only that', () => {
    const removed = pruneBrowserHistory(new Set(['live', 'archived']));
    expect(removed).toBe(1);
    expect([...store.data.keys()].sort()).toEqual(['browser-history-archived', 'browser-history-live', 'topics-cache']);
  });

  test('keeps everything when every topic is still there', () => {
    expect(pruneBrowserHistory(new Set(['live', 'archived', 'deleted']))).toBe(0);
    expect(store.data.size).toBe(4);
  });

  test('a storage that refuses the walk costs nothing', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      get length() { throw new Error('denied'); },
    };
    expect(pruneBrowserHistory(new Set())).toBe(0);
  });
});
