import { beforeEach, describe, expect, test } from 'bun:test';
import { __resetDraftWarnOnce, readDraft, saveDraft } from './chatDraft';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

let store: MemStorage;

beforeEach(() => {
  store = new MemStorage();
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = store;
  __resetDraftWarnOnce();
});

describe('chat draft persistence', () => {
  test('round-trips through localStorage', () => {
    saveDraft('draft:t1', 'hello');
    expect(readDraft('draft:t1')).toBe('hello');
  });

  test('an empty message clears the stored draft', () => {
    saveDraft('draft:t1', 'hello');
    saveDraft('draft:t1', '');
    expect(readDraft('draft:t1')).toBe('');
  });

  test('a storage failure is logged, not silent', () => {
    (globalThis as unknown as { localStorage: Partial<MemStorage> }).localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded'); },
    };
    const warn = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...a: unknown[]) => { calls.push(a); };
    saveDraft('draft:t1', 'typed while private');
    console.warn = warn;
    expect(calls.length).toBeGreaterThan(0);
  });

  test('a failed read returns empty rather than throwing', () => {
    (globalThis as unknown as { localStorage: Partial<MemStorage> }).localStorage = {
      getItem: () => { throw new Error('blocked'); },
    };
    expect(readDraft('draft:t1')).toBe('');
  });
});
